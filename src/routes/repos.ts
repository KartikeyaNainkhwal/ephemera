/**
 * Repository-connection API.
 */

import type { FastifyInstance } from 'fastify';

import { connectRepo, disconnectRepo, listRepos } from '../github/repos.js';
import { allowMutation, requireKey, requireRead } from '../security.js';

export async function registerRepoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/repos', async (request, reply) => {
    if (!requireRead(request, reply)) return;
    return { repos: await listRepos() };
  });

  app.post('/api/repos', async (request, reply) => {
    if (!allowMutation(request.ip)) {
      return reply.code(429).send({ error: 'Too many requests. Try again in a few minutes.' });
    }
    if (!requireKey(request, reply)) return;

    const fullName = String(
      (request.body as { repo?: unknown } | null)?.repo ?? '',
    ).trim();

    try {
      const repo = await connectRepo(fullName);
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
