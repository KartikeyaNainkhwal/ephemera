/**
 * Public HTTP API for environments.
 *
 * This is the surface the dashboard, the GitHub integration and the MCP server
 * all speak to, so the lifecycle has exactly one implementation.
 *
 * Auth model: mutations require the admin key; reads are public by default
 * (EPHEMERA_PUBLIC_READS=false locks them down). The GitHub webhook has its
 * own HMAC-based authentication in routes/github.ts.
 */

import type { FastifyInstance } from 'fastify';

import { config } from '../config.js';
import { accruedCost, hourlyCost } from '../environments/cost.js';
import {
  CapacityError,
  createEnvironment,
  destroyEnvironment,
  extendEnvironment,
  SlugInUseError,
} from '../environments/service.js';
import { reconcileOrphans } from '../environments/reconcile.js';
import { analyseSql } from '../migrations/analyse.js';
import { analysePullRequest, renderComment, worstSeverity } from '../migrations/index.js';
import * as store from '../environments/store.js';
import type { EnvironmentRecord } from '../environments/store.js';
import {
  TTL_MAX_MINUTES,
  TTL_MIN_MINUTES,
  validateCreate,
} from '../environments/validate.js';
import { allowMutation, requireKey, requireRead } from '../security.js';

export function serialise(record: EnvironmentRecord) {
  const withDatabase = record.dbHostname !== null;
  return {
    id: record.id,
    slug: record.slug,
    url: record.url,
    status: record.status,
    repo: record.repo,
    branch: record.branch,
    source: record.source,
    kind: record.kind,
    title: record.title,
    pullRequest:
      record.prRepo && record.prNumber
        ? { repo: record.prRepo, number: record.prNumber }
        : null,
    services: {
      app: record.appHostname,
      database: record.dbHostname,
    },
    error: record.error,
    createdAt: record.createdAt.toISOString(),
    readyAt: record.readyAt?.toISOString() ?? null,
    destroyedAt: record.destroyedAt?.toISOString() ?? null,
    expiresAt: record.expiresAt.toISOString(),
    provisioningSeconds:
      record.readyAt !== null
        ? Math.round((record.readyAt.getTime() - record.createdAt.getTime()) / 1000)
        : null,
    cost: {
      hourly: hourlyCost(withDatabase),
      accrued: accruedCost(record.createdAt, record.destroyedAt, withDatabase),
    },
  };
}

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/environments', async (request, reply) => {
    if (!requireRead(request, reply)) return;
    const includeDestroyed =
      (request.query as { all?: string } | undefined)?.all === 'true';
    const records = includeDestroyed
      ? await store.listAll()
      : await store.listActive();
    return { environments: records.map(serialise) };
  });

  app.get('/api/environments/:id', async (request, reply) => {
    if (!requireRead(request, reply)) return;
    const { id } = request.params as { id: string };
    const record = await store.getById(id);
    if (!record) return reply.code(404).send({ error: 'Environment not found.' });
    return serialise(record);
  });

  app.post('/api/environments', async (request, reply) => {
    if (!allowMutation(request.ip)) {
      return reply.code(429).send({
        error: `Too many requests - at most ${config.limits.mutationsPerWindow} mutations per 10 minutes.`,
      });
    }
    if (!requireKey(request, reply)) return;

    const parsed = validateCreate(request.body);
    if (!parsed.ok) {
      return reply.code(400).send({ error: 'Invalid request.', details: parsed.errors });
    }

    // `source` is metadata, not user configuration - whitelist it.
    const source =
      (request.body as { source?: unknown } | null)?.source === 'agent' ? 'agent' : 'api';

    try {
      const record = await createEnvironment({ ...parsed.value, source });
      return reply.code(202).send(serialise(record));
    } catch (error) {
      if (error instanceof SlugInUseError || error instanceof CapacityError) {
        return reply.code(409).send({ error: error.message });
      }
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(400).send({ error: message });
    }
  });

  app.patch('/api/environments/:id', async (request, reply) => {
    if (!requireKey(request, reply)) return;
    const { id } = request.params as { id: string };
    const ttl = Number((request.body as { ttlMinutes?: unknown } | null)?.ttlMinutes);
    if (!Number.isInteger(ttl) || ttl < TTL_MIN_MINUTES || ttl > TTL_MAX_MINUTES) {
      return reply.code(400).send({
        error: `"ttlMinutes" must be an integer between ${TTL_MIN_MINUTES} and ${TTL_MAX_MINUTES}.`,
      });
    }
    try {
      const record = await extendEnvironment(id, ttl);
      if (!record) return reply.code(404).send({ error: 'Environment not found.' });
      return serialise(record);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(409).send({ error: message });
    }
  });

  app.delete('/api/environments/:id', async (request, reply) => {
    if (!requireKey(request, reply)) return;
    const { id } = request.params as { id: string };
    const record = await destroyEnvironment(id);
    if (!record) return reply.code(404).send({ error: 'Environment not found.' });
    return serialise(record);
  });

  /**
   * Force an orphan sweep. Runs automatically on the reaper interval; exposed
   * so a leak can be resolved immediately rather than waited out.
   */
  app.post('/api/reconcile', async (request, reply) => {
    if (!requireKey(request, reply)) return;
    return reconcileOrphans();
  });

  /**
   * Analyse SQL directly. Useful for trying a statement without opening a
   * pull request, and it is how the rules can be exercised from a terminal.
   */
  app.post('/api/migrations/analyse', async (request, reply) => {
    if (!requireKey(request, reply)) return;
    const sql = (request.body as { sql?: unknown } | null)?.sql;
    if (typeof sql !== 'string' || sql.trim() === '') {
      return reply.code(400).send({ error: '"sql" is required.' });
    }
    if (sql.length > 500_000) {
      return reply.code(400).send({ error: 'SQL is limited to 500KB.' });
    }
    return analyseSql(sql);
  });

  /**
   * Analyse the migrations in a pull request, optionally measuring them
   * against a live environment's database.
   */
  app.post('/api/environments/:id/migrations', async (request, reply) => {
    if (!requireKey(request, reply)) return;
    const { id } = request.params as { id: string };
    const record = await store.getById(id);
    if (!record) return reply.code(404).send({ error: 'Environment not found.' });
    if (!record.prRepo || !record.prNumber) {
      return reply
        .code(400)
        .send({ error: 'This environment is not attached to a pull request.' });
    }

    const measure =
      (request.body as { measure?: unknown } | null)?.measure !== false &&
      record.status === 'ready';

    const report = await analysePullRequest(
      record.prRepo,
      record.prNumber,
      record.branch ?? 'HEAD',
      { dbHostname: measure ? record.dbHostname : null },
    );
    if (!report) return { migrations: 0, message: 'No migration files changed in this pull request.' };

    return {
      migrations: report.files.length,
      severity: worstSeverity(report),
      measured: measure,
      files: report.files,
      comment: renderComment(report),
    };
  });

  app.get('/api/health', async () => ({
    status: 'ok',
    version: config.version,
    uptimeSeconds: Math.round(process.uptime()),
  }));
}
