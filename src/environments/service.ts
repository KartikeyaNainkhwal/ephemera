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
import { probe } from '../zerops/client.js';
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
    await serviceImport(importYaml);
    announce(await store.setStatus(record.id, 'building'));
    await waitUntilServing(record);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ephemera] provisioning failed for ${record.slug}:`, message);
    announce(await store.setStatus(record.id, 'failed', message));
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

  const failures: string[] = [];
  for (const hostname of [record.appHostname, record.dbHostname].filter(
    Boolean,
  ) as string[]) {
    try {
      await serviceDelete(hostname);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A service that is already gone is a success from our perspective.
      if (!/not found|does not exist/i.test(message)) {
        failures.push(`${hostname}: ${message}`);
      }
    }
  }

  const finalRecord = failures.length
    ? await store.setStatus(record.id, 'failed', failures.join('; '))
    : await store.setStatus(record.id, 'destroyed');

  announce(finalRecord);
  return finalRecord;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
