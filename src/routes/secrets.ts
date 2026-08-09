/**
 * Secrets and review actions.
 *
 * Secrets are write-only: they can be set and deleted, never read back. The
 * listing returns masks and metadata so a human can tell which value is which
 * without the API ever becoming a way to exfiltrate them.
 */

import type { FastifyInstance } from 'fastify';

import { deployProduction, getProductionFor } from '../environments/production.js';
import { destroyEnvironment } from '../environments/service.js';
import * as store from '../environments/store.js';
import { normaliseRepoName } from '../github/name.js';
import {
  closePullRequest,
  commentOnPullRequest,
  mergePullRequest,
} from '../github/review.js';
import {
  deleteSecret,
  listSecrets,
  setSecret,
  type SecretPhase,
  type SecretScope,
} from '../secrets/store.js';
import { allowMutation, requireKey } from '../security.js';
import { serialise } from './api.js';

const SCOPES: SecretScope[] = ['all', 'production', 'preview'];
const PHASES: SecretPhase[] = ['runtime', 'build', 'both'];

export async function registerSecretRoutes(app: FastifyInstance): Promise<void> {
  /** Masked listing. Values never leave the server. */
  app.get('/api/repos/:owner/:name/secrets', async (request, reply) => {
    if (!requireKey(request, reply)) return;
    const { owner, name } = request.params as { owner: string; name: string };
    return { secrets: await listSecrets(`${owner}/${name}`) };
  });

  app.put('/api/repos/:owner/:name/secrets', async (request, reply) => {
    if (!allowMutation(request.ip)) {
      return reply.code(429).send({ error: 'Too many requests.' });
    }
    if (!requireKey(request, reply)) return;

    const { owner, name } = request.params as { owner: string; name: string };
    const body = (request.body ?? {}) as {
      key?: unknown;
      value?: unknown;
      scope?: unknown;
      phase?: unknown;
    };

    if (typeof body.key !== 'string' || typeof body.value !== 'string') {
      return reply.code(400).send({ error: '"key" and "value" are required.' });
    }
    const scope = SCOPES.includes(body.scope as SecretScope)
      ? (body.scope as SecretScope)
      : 'all';
    const phase = PHASES.includes(body.phase as SecretPhase)
      ? (body.phase as SecretPhase)
      : 'runtime';

    try {
      const secret = await setSecret(
        `${owner}/${name}`,
        body.key,
        body.value,
        scope,
        phase,
      );
      return reply.code(201).send(secret);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(400).send({ error: message });
    }
  });

  app.delete('/api/repos/:owner/:name/secrets/:key', async (request, reply) => {
    if (!requireKey(request, reply)) return;
    const { owner, name, key } = request.params as {
      owner: string;
      name: string;
      key: string;
    };
    const removed = await deleteSecret(`${owner}/${name}`, key);
    if (!removed) return reply.code(404).send({ error: 'No such secret.' });
    return { ok: true };
  });

  /** Deploy (or redeploy) the repository's production environment. */
  app.post('/api/repos/:owner/:name/production', async (request, reply) => {
    if (!allowMutation(request.ip)) {
      return reply.code(429).send({ error: 'Too many requests.' });
    }
    if (!requireKey(request, reply)) return;
    const { owner, name } = request.params as { owner: string; name: string };
    try {
      const record = await deployProduction(normaliseRepoName(`${owner}/${name}`));
      return reply.code(202).send(serialise(record));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(400).send({ error: message });
    }
  });

  app.get('/api/repos/:owner/:name/production', async (request, reply) => {
    if (!requireKey(request, reply)) return;
    const { owner, name } = request.params as { owner: string; name: string };
    const record = await getProductionFor(`${owner}/${name}`);
    return record ? serialise(record) : reply.code(404).send({ error: 'Not deployed.' });
  });

  /**
   * Approve or reject a pull request from the dashboard.
   *
   * Teardown and production redeploy both follow from GitHub's resulting
   * `closed` webhook, so there is exactly one code path for those - whether
   * the action came from here or from GitHub's own UI.
   */
  app.post('/api/environments/:id/review', async (request, reply) => {
    if (!allowMutation(request.ip)) {
      return reply.code(429).send({ error: 'Too many requests.' });
    }
    if (!requireKey(request, reply)) return;

    const { id } = request.params as { id: string };
    const decision = (request.body as { decision?: unknown } | null)?.decision;
    if (decision !== 'approve' && decision !== 'reject') {
      return reply.code(400).send({ error: '"decision" must be "approve" or "reject".' });
    }

    const record = await store.getById(id);
    if (!record) return reply.code(404).send({ error: 'Environment not found.' });
    if (!record.prRepo || !record.prNumber) {
      return reply
        .code(400)
        .send({ error: 'This environment is not attached to a pull request.' });
    }

    try {
      if (decision === 'approve') {
        const result = await mergePullRequest(record.prRepo, record.prNumber);
        if (!result.merged) {
          return reply.code(409).send({ error: 'GitHub did not merge the pull request.' });
        }
        await commentOnPullRequest(
          record.prRepo,
          record.prNumber,
          '**Ephemera** — approved and merged after reviewing the live preview.',
        );
        return { ok: true, decision, merged: true };
      }

      await commentOnPullRequest(
        record.prRepo,
        record.prNumber,
        '**Ephemera** — rejected after reviewing the live preview. The preview environment has been destroyed.',
      );
      await closePullRequest(record.prRepo, record.prNumber);
      // Close the loop locally too: GitHub's webhook will also fire, and
      // destroying an already-destroyed environment is a no-op.
      await destroyEnvironment(record.id);
      return { ok: true, decision, merged: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(409).send({ error: message });
    }
  });
}
