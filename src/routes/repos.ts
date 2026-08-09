/**
 * Repository-connection API.
 *
 * The onboarding contract is: **inspect, propose, confirm**. `POST /api/repos/inspect`
 * proposes a build plan without changing anything; `POST /api/repos` connects the
 * repository and stores the plan the user confirmed. Nothing is ever written to
 * the user's repository.
 */

import type { FastifyInstance } from 'fastify';

import type { BuildPlan } from '../detect/detect.js';
import { inspectRepo } from '../github/inspect.js';
import { normaliseRepoName } from '../github/name.js';
import { connectRepo, disconnectRepo, listRepos } from '../github/repos.js';
import { allowMutation, requireKey, requireRead } from '../security.js';

/** Accept a user-edited plan, keeping only fields we recognise. */
function sanitisePlan(input: unknown): BuildPlan | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const p = input as Record<string, unknown>;
  const strings = (value: unknown): string[] | undefined =>
    Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length < 1000)
      ? (value as string[])
      : undefined;

  if (typeof p.runtime !== 'string' || typeof p.startCommand !== 'string') return undefined;

  return {
    framework: typeof p.framework === 'string' ? p.framework.slice(0, 60) : 'Custom',
    runtime: p.runtime,
    port: Number.isInteger(p.port) ? (p.port as number) : 3000,
    prepareCommands: strings(p.prepareCommands),
    buildCommands: strings(p.buildCommands) ?? [],
    startCommand: p.startCommand,
    deployFiles: strings(p.deployFiles) ?? ['./'],
    withDatabase: p.withDatabase !== false,
    confidence: 'high',
    reason: typeof p.reason === 'string' ? p.reason.slice(0, 300) : 'Confirmed by the user.',
  };
}

export async function registerRepoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/repos', async (request, reply) => {
    if (!requireRead(request, reply)) return;
    return { repos: await listRepos() };
  });

  /**
   * Propose a build plan for a repository. Read-only: it inspects the repo and
   * returns what Ephemera *would* do, for the user to confirm or edit.
   */
  app.post('/api/repos/inspect', async (request, reply) => {
    if (!requireKey(request, reply)) return;
    const raw = String((request.body as { repo?: unknown } | null)?.repo ?? '');
    try {
      const fullName = normaliseRepoName(raw);
      const inspection = await inspectRepo(fullName);
      return { repo: fullName, ...inspection };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(400).send({ error: message });
    }
  });

  app.post('/api/repos', async (request, reply) => {
    if (!allowMutation(request.ip)) {
      return reply.code(429).send({ error: 'Too many requests. Try again in a few minutes.' });
    }
    if (!requireKey(request, reply)) return;

    const body = (request.body ?? {}) as { repo?: unknown; buildPlan?: unknown };
    const fullName = String(body.repo ?? '').trim();

    try {
      const repo = await connectRepo(fullName, sanitisePlan(body.buildPlan));
      return reply.code(201).send(repo);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(400).send({ error: message });
    }
  });

  app.delete('/api/repos/:owner/:name', async (request, reply) => {
    if (!requireKey(request, reply)) return;
    const { owner, name } = request.params as { owner: string; name: string };
    const removed = await disconnectRepo(`${owner}/${name}`);
    if (!removed) return reply.code(404).send({ error: 'Repository is not connected.' });
    return { ok: true };
  });
}
