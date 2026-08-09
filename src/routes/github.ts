/**
 * GitHub integration.
 *
 * Opening a pull request provisions an environment; closing or merging it
 * tears the environment down. The pull request itself is the interface - a
 * reviewer never visits this dashboard unless they want to.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';

import { config } from '../config.js';
import { accruedCost, formatCost } from '../environments/cost.js';
import {
  CapacityError,
  createEnvironment,
  destroyEnvironment,
} from '../environments/service.js';
import * as store from '../environments/store.js';
import type { EnvironmentRecord } from '../environments/store.js';
import { getDeployPolicy, getRepoPlan } from '../github/repos.js';
import { events } from '../environments/service.js';
import { reportForPullRequest } from '../migrations/index.js';
import { deployProduction } from '../environments/production.js';
import { inspectRepo } from '../github/inspect.js';
import { sanitiseSlug } from '../zerops/manifest.js';

interface PullRequestEvent {
  action?: string;
  number?: number;
  pull_request?: {
    number: number;
    title?: string;
    merged?: boolean;
    head?: {
      ref?: string;
      sha?: string;
      repo?: { full_name?: string; fork?: boolean };
    };
    base?: { ref?: string };
  };
  repository?: {
    full_name?: string;
    clone_url?: string;
  };
}

/**
 * Optional per-repository build configuration, read from `ephemera.json` in
 * the branch being previewed. Absent that file, sensible Node defaults apply.
 */
interface RepoConfig {
  runtime?: string;
  port?: number;
  withDatabase?: boolean;
  prepareCommands?: string[];
  buildCommands?: string[];
  deployFiles?: string[];
  startCommand?: string;
  env?: Record<string, string>;
  ttlMinutes?: number;
}

async function fetchRepoConfig(
  fullName: string,
  ref: string,
): Promise<RepoConfig> {
  const url = `https://raw.githubusercontent.com/${fullName}/${ref}/ephemera.json`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return {};
    return (await response.json()) as RepoConfig;
  } catch {
    // A missing or malformed config is not an error; defaults apply.
    return {};
  }
}

function verifySignature(request: FastifyRequest, raw: string): boolean {
  if (!config.github.webhookSecret) return true; // verification disabled

  const provided = request.headers['x-hub-signature-256'];
  if (typeof provided !== 'string') return false;

  const expected =
    'sha256=' +
    createHmac('sha256', config.github.webhookSecret).update(raw).digest('hex');

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function comment(fullName: string, issueNumber: number, body: string): Promise<void> {
  if (!config.github.token) return;
  try {
    const response = await fetch(
      `https://api.github.com/repos/${fullName}/issues/${issueNumber}/comments`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.github.token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      console.error(
        `[ephemera] GitHub comment failed: ${response.status} ${await response.text()}`,
      );
    }
  } catch (error) {
    console.error('[ephemera] GitHub comment error:', error);
  }
}

/**
 * Webhook idempotency. GitHub retries deliveries, and a retried `opened`
 * event must not provision a second environment. In-memory is the right scope
 * for a single-instance control plane; entries expire after an hour.
 */
const seenDeliveries = new Map<string, number>();

function isDuplicateDelivery(id: string | string[] | undefined): boolean {
  if (typeof id !== 'string' || id === '') return false;
  const now = Date.now();
  for (const [key, at] of seenDeliveries) {
    if (now - at > 3_600_000) seenDeliveries.delete(key);
  }
  if (seenDeliveries.has(id)) return true;
  seenDeliveries.set(id, now);
  return false;
}

/** Build a stable, legal slug from a repository and pull request number. */
function slugForPullRequest(fullName: string, number: number): string {
  const repoPart = fullName.split('/').pop() ?? 'repo';
  // Leave room for the `pr<n>` suffix and the `api`/`db` suffixes appended later.
  const prefix = sanitiseSlug(repoPart).slice(0, 10);
  return sanitiseSlug(`${prefix}pr${number}`);
}

/**
 * Build the create-input for a pull request: stored plan first, live detection
 * as a fallback, an `ephemera.json` on the branch as the final override.
 */
async function specForPullRequest(
  fullName: string,
  branch: string,
  ref: string,
): Promise<{ spec: Record<string, unknown>; framework: string | null }> {
  const overrides = await fetchRepoConfig(fullName, ref);
  const stored = await getRepoPlan(fullName);
  const plan =
    stored ?? (await inspectRepo(fullName, ref).then((i) => i.plan).catch(() => null));

  return {
    framework: plan?.framework ?? null,
    spec: {
      ...(plan
        ? {
            runtime: plan.runtime,
            port: plan.port,
            withDatabase: plan.withDatabase,
            prepareCommands: plan.prepareCommands,
            buildCommands: plan.buildCommands,
            deployFiles: plan.deployFiles,
            startCommand: plan.startCommand,
          }
        : {}),
      ...overrides,
    },
  };
}

/**
 * Deploy a preview because someone asked for it with `/preview`.
 *
 * An explicit request is authorisation, so this bypasses the policy gate - but
 * **not** the secret rules: a fork is still untrusted and still receives none.
 */
async function deployOnRequest(fullName: string, number: number): Promise<void> {
  const detail = await fetch(
    `https://api.github.com/repos/${fullName}/pulls/${number}`,
    {
      headers: {
        ...(config.github.token ? { Authorization: `Bearer ${config.github.token}` } : {}),
        Accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!detail.ok) throw new Error(`GitHub responded ${detail.status} for PR #${number}`);

  const pr = (await detail.json()) as {
    title?: string;
    head?: { ref?: string; sha?: string; repo?: { full_name?: string; fork?: boolean } };
  };
  const branch = pr.head?.ref ?? 'main';
  const commitSha = pr.head?.sha;
  const isFork =
    pr.head?.repo?.fork === true ||
    (pr.head?.repo?.full_name != null && pr.head.repo.full_name !== fullName);

  const existing = await store.getByPullRequest(fullName, number);
  if (existing) await destroyEnvironment(existing.id);

  const { spec, framework } = await specForPullRequest(
    fullName,
    branch,
    commitSha ?? branch,
  );

  const environment = await createEnvironment({
    slug: slugForPullRequest(fullName, number),
    repo: `https://github.com/${fullName}`,
    branch,
    commitSha,
    trusted: !isFork,
    source: 'github',
    prNumber: number,
    prRepo: fullName,
    title: pr.title,
    ...spec,
  });

  await comment(
    fullName,
    number,
    `**Ephemera** — preview requested.\n\n**${environment.url}**\n\n` +
      (framework ? `Detected as **${framework}**. ` : '') +
      `It will answer as soon as the app is up.` +
      (isFork
        ? `\n\n> From a fork, so **no secrets were injected** — anything needing ` +
          `an API key will not work here.`
        : ''),
  );
}

/**
 * When a preview becomes ready, analyse any migrations the pull request
 * changed - and measure them against that environment's own database.
 *
 * This is deliberately tied to `ready` rather than to the webhook: before the
 * database exists there is nothing to measure, and a measured duration is the
 * entire point.
 */
function watchForMigrations(): void {
  events.on('ready', (record: EnvironmentRecord) => {
    if (!record.prRepo || !record.prNumber) return;
    void (async () => {
      try {
        const result = await reportForPullRequest(
          record.prRepo!,
          record.prNumber!,
          record.branch ?? 'HEAD',
          { dbHostname: record.dbHostname },
        );
        if (!result) return; // no migrations in this pull request
        await comment(record.prRepo!, record.prNumber!, result.body);
        console.log(
          `[ephemera] migration analysis posted on ${record.prRepo}#${record.prNumber} ` +
            `(worst: ${result.severity})`,
        );
      } catch (error) {
        console.error('[ephemera] migration analysis failed:', error);
      }
    })();
  });
}

export async function registerGithubRoutes(app: FastifyInstance): Promise<void> {
  watchForMigrations();
  // Capture the raw body so webhook signatures can be verified byte-for-byte.
  //
  // This parser is **global** - registering it replaces Fastify's built-in JSON
  // parser for every request, not just webhooks. So it has to tolerate the
  // shapes real clients send: browsers routinely set `content-type:
  // application/json` on bodyless DELETE and POST requests, and `JSON.parse('')`
  // throws. That threw a 500 on every dashboard disconnect.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (request, body, done) => {
      const raw = typeof body === 'string' ? body : '';
      (request as FastifyRequest & { rawBody?: string }).rawBody = raw;

      if (raw.trim() === '') {
        // No body is not an error; the route decides whether it needed one.
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(raw));
      } catch {
        // Malformed JSON is the client's mistake: 400, not 500.
        const error = Object.assign(
          new Error('Request body is not valid JSON.'),
          { statusCode: 400 },
        );
        done(error, undefined);
      }
    },
  );

  app.post('/webhooks/github', async (request, reply) => {
    const raw = (request as FastifyRequest & { rawBody?: string }).rawBody ?? '';
    if (!verifySignature(request, raw)) {
      return reply.code(401).send({ error: 'Invalid webhook signature.' });
    }

    const event = request.headers['x-github-event'];
    if (event === 'ping') return { ok: true, pong: true };
    if (event !== 'pull_request' && event !== 'issue_comment') {
      return { ok: true, ignored: event };
    }

    if (isDuplicateDelivery(request.headers['x-github-delivery'])) {
      return { ok: true, duplicate: true };
    }

    // `/preview` on a pull request is the manual trigger. It keeps the reviewer
    // inside the pull request rather than sending them to a dashboard, and it
    // is how a fork gets deployed under the default policy.
    if (event === 'issue_comment') {
      const payload = request.body as {
        action?: string;
        comment?: { body?: string };
        issue?: { number?: number; pull_request?: unknown };
        repository?: { full_name?: string };
      };
      if (payload.action !== 'created') return { ok: true, ignored: payload.action };
      if (!payload.issue?.pull_request) return { ok: true, ignored: 'not a pull request' };
      if (!/^\s*\/preview\b/i.test(payload.comment?.body ?? '')) {
        return { ok: true, ignored: 'no command' };
      }
      const repoName = payload.repository?.full_name;
      const prNumber = payload.issue?.number;
      if (!repoName || !prNumber) return { ok: true, ignored: 'incomplete payload' };

      void deployOnRequest(repoName, prNumber).catch((error) =>
        console.error('[ephemera] /preview failed:', error),
      );
      return reply.code(202).send({ ok: true, command: 'preview' });
    }

    const payload = request.body as PullRequestEvent;
    const action = payload.action ?? '';
    const pr = payload.pull_request;
    const repo = payload.repository;

    if (!pr || !repo?.full_name || !repo.clone_url) {
      return reply.code(400).send({ error: 'Malformed pull_request payload.' });
    }

    const fullName = repo.full_name;
    const number = pr.number;

    if (action === 'closed') {
      const existing = await store.getByPullRequest(fullName, number);
      if (existing) {
        const destroyed = await destroyEnvironment(existing.id);
        const spent = destroyed
          ? formatCost(
              accruedCost(
                destroyed.createdAt,
                destroyed.destroyedAt,
                destroyed.dbHostname !== null,
              ),
            )
          : null;
        await comment(
          fullName,
          number,
          `**Ephemera** — environment torn down.\n\n` +
            (destroyed?.dbHostname
              ? 'The application and its dedicated PostgreSQL database have been '
              : 'The application container has been ') +
            `destroyed and is no longer billing.` +
            (spent ? `\n\nTotal cost of this preview: **${spent}**.` : ''),
        );
      }
      // A merged pull request means the default branch moved: ship it.
      if (pr.merged) {
        void deployProduction(fullName).catch((error) =>
          console.error('[ephemera] production redeploy failed:', error),
        );
        await comment(
          fullName,
          number,
          `**Ephemera** — merged. Redeploying production from ` +
            `\`${pr.base?.ref ?? 'the default branch'}\`.`,
        );
      }

      return { ok: true, action: 'destroyed', merged: Boolean(pr.merged) };
    }

    if (!['opened', 'reopened', 'synchronize'].includes(action)) {
      return { ok: true, ignored: action };
    }

    // Decide whether this pull request should deploy at all.
    const policy = await getDeployPolicy(fullName);
    const isFork =
      pr.head?.repo?.fork === true ||
      (pr.head?.repo?.full_name != null && pr.head.repo.full_name !== fullName);

    const shouldDeploy =
      policy === 'auto' || (policy === 'trusted' && !isFork);

    if (!shouldDeploy) {
      // Only explain once, when the pull request opens - not on every push.
      if (action === 'opened') {
        await comment(
          fullName,
          number,
          `**Ephemera** — preview not created automatically.\n\n` +
            (policy === 'manual'
              ? `This repository is set to **manual** previews.`
              : `This pull request comes from a fork, and forks are not deployed ` +
                `automatically — their build runs code that has not been reviewed.`) +
            `\n\nComment \`/preview\` to create one.`,
        );
      }
      return { ok: true, skipped: policy, fork: isFork };
    }

    // A push to an open pull request replaces the existing environment so the
    // preview always reflects the latest commit.
    const existing = await store.getByPullRequest(fullName, number);
    if (existing) {
      await destroyEnvironment(existing.id);
    }

    const branch = pr.head?.ref ?? 'main';
    const commitSha = pr.head?.sha;

    // A pull request from a fork runs code nobody has reviewed. Injecting real
    // secrets there is the "preview deployment secret leakage" attack - the PR
    // simply prints them. Forks get an environment, but no secrets at all.
    const headRepo = pr.head?.repo?.full_name;
    const trusted = pr.head?.repo?.fork !== true && (!headRepo || headRepo === fullName);

    // Configuration comes from the plan confirmed when the repository was
    // connected - the repository itself needs no Ephemera files. An explicit
    // `ephemera.json` on the branch still wins, so a project can override per
    // branch; otherwise fall back to detecting the branch live.
    const overrides = await fetchRepoConfig(fullName, commitSha ?? branch);
    const stored = await getRepoPlan(fullName);
    const plan =
      stored ?? (await inspectRepo(fullName, commitSha ?? branch).then((i) => i.plan).catch(() => null));

    const repoConfig = {
      ...(plan
        ? {
            runtime: plan.runtime,
            port: plan.port,
            withDatabase: plan.withDatabase,
            prepareCommands: plan.prepareCommands,
            buildCommands: plan.buildCommands,
            deployFiles: plan.deployFiles,
            startCommand: plan.startCommand,
          }
        : {}),
      ...overrides,
    };

    try {
      const environment = await createEnvironment({
        slug: slugForPullRequest(fullName, number),
        repo: repo.clone_url,
        branch,
        source: 'github',
        prNumber: number,
        prRepo: fullName,
        title: pr.title,
        // Pin to the exact commit: a branch ref can move (and GitHub's raw
        // CDN can serve a stale copy) between the webhook and the download.
        commitSha,
        trusted,
        ...repoConfig,
      });

      // The URL is known before the environment exists, so the reviewer gets a
      // clickable link immediately rather than after a poll completes.
      const stack = plan ? `Detected as **${plan.framework}**. ` : '';
      const forkNote = trusted
        ? ''
        : `\n\n> This pull request comes from a fork, so **no secrets were ` +
          `injected**. Anything requiring an API key will not work here — that ` +
          `is deliberate: fork code is untrusted.`;
      const infra = environment.dbHostname
        ? 'A dedicated application container and its own PostgreSQL database are'
        : 'A dedicated application container is';
      await comment(
        fullName,
        number,
        `**Ephemera** — preview environment provisioning.\n\n` +
          `**${environment.url}**\n\n` +
          `${stack}${infra} being created for this pull request. The link works ` +
          `as soon as the app answers — typically under two minutes.\n\n` +
          `It is destroyed automatically when this pull request closes.` + forkNote,
      );

      return reply.code(202).send({ ok: true, environment: environment.slug });
    } catch (error) {
      if (error instanceof CapacityError) {
        await comment(
          fullName,
          number,
          `**Ephemera** — at capacity.\n\n${error.message}\n\n` +
            `Push to this pull request again once capacity is free and a preview ` +
            `will be provisioned.`,
        );
        return reply.code(200).send({ ok: false, reason: 'capacity' });
      }
      const message = error instanceof Error ? error.message : String(error);
      app.log.error({ error: message }, 'failed to create environment for PR');
      return reply.code(500).send({ error: message });
    }
  });
}
