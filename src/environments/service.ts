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
import { enableSubdomain, serviceDelete, serviceImport } from '../zerops/cli.js';
import { deployFromRepo } from '../zerops/deploy.js';
import { buildEnvironment, sanitiseSlug, type EnvironmentSpec } from '../zerops/manifest.js';
import * as store from './store.js';
import type { EnvironmentKind, EnvironmentRecord, EnvironmentSource } from './store.js';
import { resolveSecrets } from '../secrets/store.js';

/** Emits `changed` whenever any environment's state moves. Drives the SSE feed. */
export const events = new EventEmitter();

function announce(record: EnvironmentRecord | null): void {
  if (record) events.emit('changed', record);
}

export interface CreateInput extends EnvironmentSpec {
  /** Exact commit to deploy. Preferred over a branch name, which can move. */
  commitSha?: string;
  source?: EnvironmentSource;
  /** `production` environments are permanent and never reaped. */
  kind?: EnvironmentKind;
  /**
   * False for a pull request opened from a fork. Untrusted code receives no
   * secrets at all - see secrets/store.ts.
   */
  trusted?: boolean;
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

export class CapacityError extends Error {
  constructor(active: number, max: number) {
    super(
      `Environment limit reached (${active}/${max} live). Destroy an environment, ` +
        `wait for one to expire, or raise MAX_LIVE_ENVIRONMENTS on the control plane.`,
    );
    this.name = 'CapacityError';
  }
}

/**
 * Map known failure signatures to something a user can act on. The raw detail
 * is preserved after a separator so nothing is hidden - the friendly line
 * leads, the evidence follows.
 */
const FRIENDLY_ERRORS: Array<[RegExp, string]> = [
  [
    /Timed out waiting/i,
    'The application never answered at its public URL. Check the start command, ' +
      'the listening port, and the build log in the Zerops dashboard.',
  ],
  [
    /ZEROPS_' prefix|userDataZeropsPrefixForbidden/i,
    'Environment variable names starting with ZEROPS_ are reserved by the platform. ' +
      'Rename the variable and retry.',
  ],
  [
    /not valid yaml|projectImportInvalidYaml/i,
    'Zerops rejected the generated service definition. This is likely an Ephemera ' +
      'bug - please open an issue including the request you sent.',
  ],
  [
    /serviceStackNameUnavailable|already exists/i,
    'A service with this name already exists in the project. Choose a different slug.',
  ],
];

function withFriendlyHint(message: string): string {
  const hint = FRIENDLY_ERRORS.find(([pattern]) => pattern.test(message))?.[1];
  return hint ? `${hint}\n---\n${message}` : message;
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

  // Production is exempt from the cap: it is the thing the cap exists to protect.
  if (input.kind !== 'production') {
    const active = await store.countActive();
    if (active >= config.limits.maxLiveEnvironments) {
      throw new CapacityError(active, config.limits.maxLiveEnvironments);
    }
  }

  const existing = await store.getBySlug(slug);
  if (existing && existing.status !== 'destroyed') {
    throw new SlugInUseError(slug);
  }

  // Secrets are resolved per deployment: production and preview can hold
  // different values, and a fork gets none.
  const repoFull = repoFullName(input.repo);
  const secrets = await resolveSecrets(
    repoFull,
    input.kind === 'production' ? 'production' : 'preview',
    input.trusted !== false,
  );

  const resolved = buildEnvironment(
    {
      ...input,
      slug,
      env: { ...secrets.run, ...(input.env ?? {}) },
      buildEnv: { ...secrets.build, ...(input.buildEnv ?? {}) },
    },
    config.zerops.projectCode,
    config.zerops.region,
  );

  // A slug free in our records can still collide with a service created
  // outside Ephemera. Check the live project before importing; a transient
  // read failure must not block creation - the import fails loudly anyway.
  try {
    const names = new Set((await listServices()).map((service) => service.name));
    if (
      names.has(resolved.appHostname) ||
      (resolved.dbHostname !== null && names.has(resolved.dbHostname))
    ) {
      throw new SlugInUseError(slug);
    }
  } catch (error) {
    if (error instanceof SlugInUseError) throw error;
  }

  const ttlMinutes = input.ttlMinutes ?? config.defaultTtlMinutes;
  let record: EnvironmentRecord;
  try {
    record = await insertRecord(input, resolved, slug, ttlMinutes);
  } catch (error) {
    // The partial unique index on live slugs is the concurrency backstop for
    // two simultaneous creates racing past the pre-check above.
    if ((error as { code?: string }).code === '23505') throw new SlugInUseError(slug);
    throw error;
  }

  announce(record);

  // Dispatch provisioning without blocking the caller.
  void provision(record, resolved, {
    repo: repoFull,
    ref: input.commitSha ?? input.branch ?? 'HEAD',
  });

  return record;
}

/** `https://github.com/owner/name(.git)` → `owner/name`. */
function repoFullName(repo: string): string {
  const match = repo.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/i);
  if (!match) {
    throw new Error(
      `Only GitHub repositories are supported today. Could not read "${repo}".`,
    );
  }
  return match[1]!;
}

async function insertRecord(
  input: CreateInput,
  resolved: ReturnType<typeof buildEnvironment>,
  slug: string,
  ttlMinutes: number,
): Promise<EnvironmentRecord> {
  return store.insert({
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
    kind: input.kind ?? 'preview',
    expiresAt: new Date(Date.now() + ttlMinutes * 60_000),
  });
}

async function provision(
  record: EnvironmentRecord,
  resolved: ReturnType<typeof buildEnvironment>,
  source: { repo: string; ref: string },
): Promise<void> {
  try {
    // 1. Create the (empty) services.
    try {
      await serviceImport(resolved.importYaml);
    } catch (error) {
      // `zcli` sometimes exits non-zero *after* the import has been accepted
      // and the services created ("last command has finished with error").
      // An exit code is not evidence; the project is. If the application
      // service now exists, carry on.
      const message = error instanceof Error ? error.message : String(error);
      const created = await serviceExists(record.appHostname);
      if (!created) throw error;
      console.warn(
        `[ephemera] ${record.slug}: zcli reported an error but ` +
          `${record.appHostname} exists; continuing. (${message.split('\n')[0]})`,
      );
    }

    announce(await store.setStatus(record.id, 'building'));

    // 2. Ship the source with a generated config, so the repository needs no
    //    Ephemera-specific files of its own.
    await deployFromRepo({
      hostname: record.appHostname,
      repo: source.repo,
      ref: source.ref,
      zeropsYaml: resolved.zeropsYaml,
    });

    // 3. Expose it. Only meaningful once the service has been built at least
    //    once - before that, no ports are known and this silently does nothing.
    try {
      await enableSubdomain(record.appHostname);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Already-enabled reports as an error; the readiness probe is the judge.
      console.warn(`[ephemera] ${record.slug}: enable-subdomain: ${message.split('\n')[0]}`);
    }

    await waitUntilServing(record);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[ephemera] provisioning failed for ${record.slug}:`, message);
    announce(await store.setStatus(record.id, 'failed', withFriendlyHint(message)));
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
      'The application never answered at its public URL within the provisioning ' +
        'window. Check the start command, the listening port, and the build log ' +
        'in the Zerops dashboard.',
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
        `Teardown has not finished yet: ${surviving.join(', ')} are still present. ` +
          `The reconciler will keep retrying until they are gone — no action needed.`,
      )
    : await store.setStatus(record.id, 'destroyed');

  announce(finalRecord);
  return finalRecord;
}

/**
 * Push an environment's expiry into the future ("keep alive").
 */
export async function extendEnvironment(
  id: string,
  ttlMinutes: number,
): Promise<EnvironmentRecord | null> {
  const record = await store.getById(id);
  if (!record) return null;
  if (record.status === 'destroyed' || record.status === 'destroying') {
    throw new Error('This environment is already being destroyed and cannot be extended.');
  }
  const updated = await store.setExpiry(id, new Date(Date.now() + ttlMinutes * 60_000));
  announce(updated);
  return updated;
}

/**
 * Re-attach lifecycle watchers after a control-plane restart.
 *
 * Provisioning dispatches work to Zerops and then watches from the outside,
 * so a restart loses only the watcher - not the work. Without this, an
 * environment interrupted mid-provision would sit in `creating` forever and
 * one interrupted mid-teardown would keep billing.
 */
export async function resumeInFlight(): Promise<number> {
  const inFlight = await store.listInFlight();
  for (const record of inFlight) {
    if (record.status === 'destroying') {
      console.log(`[ephemera] resuming teardown of ${record.slug} after restart`);
      void destroyEnvironment(record.id);
    } else {
      console.log(`[ephemera] resuming readiness watch for ${record.slug} after restart`);
      void store.setStatus(record.id, 'building').then((updated) => announce(updated));
      void waitUntilServing(record);
    }
  }
  return inFlight.length;
}

/**
 * Poll until the named services disappear from the project.
 * Returns whatever is still standing when the deadline passes.
 */
async function waitForRemoval(
  hostnames: string[],
  timeoutMs = 5 * 60_000,
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
