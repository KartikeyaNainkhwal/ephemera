/**
 * Environment lifecycle orchestration.
 *
 * Creation is deliberately asynchronous. `zcli project service-import` takes
 * roughly 90 seconds to return and the application needs another ~30 before it
 * serves traffic, so callers get a record immediately - including the final
 * URL, which is computable in advance - and readiness is reconciled in the
 * background.
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { config } from '../config.js';
import { listServices, probe } from '../zerops/client.js';
import { serviceDelete, serviceImport } from '../zerops/cli.js';
import { buildEnvironment, sanitiseSlug, type EnvironmentSpec } from '../zerops/manifest.js';
import * as store from './store.js';
import type { EnvironmentRecord, EnvironmentSource } from './store.js';

/** Emits `changed` whenever any environment's state moves. Drives the SSE feed. */
export const events = new EventEmitter();

function announce(record: EnvironmentRecord | null): void {
  if (record) events.emit('changed', record);
}

export interface CreateInput extends EnvironmentSpec {
  source?: EnvironmentSource;
  prNumber?: number;
  prRepo?: string;
  title?: string;
  ttlMinutes?: number;
}

export class SlugInUseError extends Error {
  constructor(slug: string) {
    super(`An environment with slug "${slug}" already exists.`);
    this.name = 'SlugInUseError';
  }
}

/**
 * Provision a new isolated environment.
 *
 * Resolves as soon as the record exists and the import has been dispatched.
 * The returned record will be in `creating`; watch the event stream, or poll
 * `GET /api/environments/:id`, for the transition to `ready`.
 */
export async function createEnvironment(
  input: CreateInput,
): Promise<EnvironmentRecord> {
  const slug = sanitiseSlug(input.slug);

  const existing = await store.getBySlug(slug);
  if (existing && existing.status !== 'destroyed') {
    throw new SlugInUseError(slug);
  }

  const resolved = buildEnvironment(
    { ...input, slug },
    config.zerops.projectCode,
    config.zerops.region,
  );

  const ttlMinutes = input.ttlMinutes ?? config.defaultTtlMinutes;
  const record = await store.insert({
    id: randomUUID(),
    slug: resolved.slug,
    appHostname: resolved.appHostname,
    dbHostname: resolved.dbHostname,
    url: resolved.url,
    repo: input.repo,
    branch: input.branch ?? null,
    source: input.source ?? 'api',
    prNumber: input.prNumber ?? null,
    prRepo: input.prRepo ?? null,
    title: input.title ?? null,
    expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
  });

  announce(record);

  // Dispatch provisioning without blocking the caller.
  void provision(record, resolved.importYaml);

  return record;
}

async function provision(
  record: EnvironmentRecord,
  importYaml: string,
): Promise<void> {
  try {
    try {
      await serviceImport(importYaml);
    } catch (error) {
      // `zcli` sometimes exits non-zero *after* the import has been accepted
      // and the services created ("last command has finished with error").
      // An exit code is not evidence; the project is. If the application
      // service now exists, carry on and let the readiness probe decide.
      const message = error instanceof Error ? error.message : String(error);
      const created = await serviceExists(record.appHostname);
      if (!created) throw error;
      console.warn(
        `[ephemera] ${record.slug}: zcli reported an error but ` +
          `${record.appHostname} exists; continuing. (${message.split('\n')[0]})`,
      );
    }

    announce(await store.setStatus(record.id, 'building'));
    await waitUntilServing(record);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ephemera] provisioning failed for ${record.slug}:`, message);
    announce(await store.setStatus(record.id, 'failed', message));
  }
}

/** Ask Zerops whether a service with this hostname is present. */
async function serviceExists(hostname: string): Promise<boolean> {
  try {
    const services = await listServices();
    return services.some((service) => service.name === hostname);
  } catch {
    return false;
  }
}

/**
 * Poll the application until it answers.
 *
 * Readiness is defined by observed HTTP behaviour rather than by the platform
 * reporting ACTIVE - a container can be running while the process inside it is
 * still starting, or crash-looping against a database it cannot reach.
 */
async function waitUntilServing(
  record: EnvironmentRecord,
  timeoutMs = 10 * 60_000,
  intervalMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // Stop if the environment was destroyed while we were waiting.
    const current = await store.getById(record.id);
    if (!current || current.status === 'destroying' || current.status === 'destroyed') {
      return;
    }

    const result = await probe(record.url);
    if (result.reachable) {
      announce(await store.setStatus(record.id, 'ready'));
      console.log(
        `[ephemera] ${record.slug} is serving at ${record.url} ` +
          `(${Math.round((Date.now() - record.createdAt.getTime()) / 1000)}s)`,
      );
      return;
    }
    await sleep(intervalMs);
  }

  announce(
    await store.setStatus(
      record.id,
      'failed',
      'Timed out waiting for the application to serve traffic.',
    ),
  );
}

/**
 * Tear an environment down.
 *
 * Services are deleted sequentially - application first, then database - so a
 * failure to remove the app does not orphan it against a missing dependency.
 */
export async function destroyEnvironment(id: string): Promise<EnvironmentRecord | null> {
  const record = await store.getById(id);
  if (!record) return null;
  if (record.status === 'destroyed') return record;

  announce(await store.setStatus(record.id, 'destroying'));

  const hostnames = [record.appHostname, record.dbHostname].filter(
    Boolean,
  ) as string[];

  for (const hostname of hostnames) {
    try {
      await serviceDelete(hostname);
    } catch (error) {
      // Deliberately swallowed. As with import, zcli's exit code is not
      // evidence of what happened - the surviving-services check below is.
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ephemera] delete ${hostname} reported: ${message.split('\n')[0]}`);
    }
  }

  // Deletion is asynchronous. Confirm the services are actually gone rather
  // than reporting success from an exit code, so the dashboard never claims
  // an environment was torn down while it is still billing.
  const surviving = await waitForRemoval(hostnames);

  const finalRecord = surviving.length
    ? await store.setStatus(
        record.id,
        'failed',
        `Services still present after teardown: ${surviving.join(', ')}. ` +
          `They may still be billing and need manual removal.`,
      )
    : await store.setStatus(record.id, 'destroyed');

  announce(finalRecord);
  return finalRecord;
}

/**
 * Poll until the named services disappear from the project.
 * Returns whatever is still standing when the deadline passes.
 */
async function waitForRemoval(
  hostnames: string[],
  timeoutMs = 90_000,
  intervalMs = 5_000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let remaining = [...hostnames];

  while (Date.now() < deadline && remaining.length > 0) {
    try {
      const present = new Set((await listServices()).map((service) => service.name));
      remaining = remaining.filter((hostname) => present.has(hostname));
    } catch {
      // Transient API failure; try again until the deadline.
    }
    if (remaining.length === 0) break;
    await sleep(intervalMs);
  }
  return remaining;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
