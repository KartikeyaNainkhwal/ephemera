/**
 * Public HTTP API for environments.
 *
 * This is the surface the dashboard, the GitHub integration and the MCP server
 * all speak to, so the lifecycle has exactly one implementation.
 */

import type { FastifyInstance } from 'fastify';

import { accruedCost, hourlyCost } from '../environments/cost.js';
import {
  createEnvironment,
  destroyEnvironment,
  SlugInUseError,
} from '../environments/service.js';
import * as store from '../environments/store.js';
import type { EnvironmentRecord } from '../environments/store.js';

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

interface CreateBody {
  slug?: string;
  repo?: string;
  branch?: string;
  runtime?: string;
  port?: number;
  withDatabase?: boolean;
  prepareCommands?: string[];
  buildCommands?: string[];
  deployFiles?: string[];
  startCommand?: string;
  env?: Record<string, string>;
  ttlMinutes?: number;
  title?: string;
  source?: 'api' | 'agent';
}

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/environments', async (request) => {
    const includeDestroyed =
      (request.query as { all?: string } | undefined)?.all === 'true';
    const records = includeDestroyed
      ? await store.listAll()
      : await store.listActive();
    return { environments: records.map(serialise) };
  });

  app.get('/api/environments/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = await store.getById(id);
    if (!record) return reply.code(404).send({ error: 'Environment not found.' });
    return serialise(record);
  });

  app.post('/api/environments', async (request, reply) => {
    const body = (request.body ?? {}) as CreateBody;

    if (!body.repo) {
      return reply
        .code(400)
        .send({ error: 'A "repo" (public git URL) is required.' });
    }
    if (!body.slug) {
      return reply.code(400).send({ error: 'A "slug" is required.' });
    }

    try {
      const record = await createEnvironment({
        slug: body.slug,
        repo: body.repo,
        branch: body.branch,
        runtime: body.runtime,
        port: body.port,
        withDatabase: body.withDatabase,
        prepareCommands: body.prepareCommands,
        buildCommands: body.buildCommands,
        deployFiles: body.deployFiles,
        startCommand: body.startCommand,
        env: body.env,
        ttlMinutes: body.ttlMinutes,
        title: body.title,
        source: body.source ?? 'api',
      });
      return reply.code(202).send(serialise(record));
    } catch (error) {
      if (error instanceof SlugInUseError) {
        return reply.code(409).send({ error: error.message });
      }
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(400).send({ error: message });
    }
  });

  app.delete('/api/environments/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = await destroyEnvironment(id);
    if (!record) return reply.code(404).send({ error: 'Environment not found.' });
    return serialise(record);
  });

  app.get('/api/health', async () => ({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
  }));
}
