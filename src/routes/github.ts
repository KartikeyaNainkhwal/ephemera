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
import { getRepoPlan } from '../github/repos.js';
import { inspectRepo } from '../github/inspect.js';
import { sanitiseSlug } from '../zerops/manifest.js';

interface PullRequestEvent {
  action?: string;
  number?: number;
  pull_request?: {
    number: number;
    title?: string;
    head?: { ref?: string; sha?: string };
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

export async function registerGithubRoutes(app: FastifyInstance): Promise<void> {
  // Capture the raw body so webhook signatures can be verified byte-for-byte.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (request, body, done) => {
      (request as FastifyRequest & { rawBody?: string }).rawBody = body as string;
      try {
        done(null, JSON.parse(body as string));
      } catch (error) {
        done(error as Error, undefined);
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
    if (event !== 'pull_request') return { ok: true, ignored: event };

    if (isDuplicateDelivery(request.headers['x-github-delivery'])) {
      return { ok: true, duplicate: true };
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
            `The application and its dedicated PostgreSQL database have been ` +
            `destroyed and are no longer billing.` +
            (spent ? `\n\nTotal cost of this preview: **${spent}**.` : ''),
        );
      }
      return { ok: true, action: 'destroyed' };
    }

    if (!['opened', 'reopened', 'synchronize'].includes(action)) {
      return { ok: true, ignored: action };
    }

    // A push to an open pull request replaces the existing environment so the
    // preview always reflects the latest commit.
    const existing = await store.getByPullRequest(fullName, number);
    if (existing) {
      await destroyEnvironment(existing.id);
    }

    const branch = pr.head?.ref ?? 'main';
    const commitSha = pr.head?.sha;

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
        ...repoConfig,
      });

      // The URL is known before the environment exists, so the reviewer gets a
      // clickable link immediately rather than after a poll completes.
      await comment(
        fullName,
        number,
        `**Ephemera** — preview environment provisioning.\n\n` +
          `**${environment.url}**\n\n` +
          `A dedicated application container and its own PostgreSQL database ` +
          `are being created for this pull request. The link works as soon as ` +
          `the app answers — typically under three minutes.\n\n` +
          `It is destroyed automatically when this pull request closes.`,
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
