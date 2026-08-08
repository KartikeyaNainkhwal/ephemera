/**
 * Ephemera control plane.
 *
 * Disposable, fully isolated environments on Zerops - one per pull request,
 * one per AI agent task.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Fastify from 'fastify';

import { config } from './config.js';
import { closePool, initialiseSchema } from './db.js';
import { startReaper, stopReaper } from './environments/reaper.js';
import { registerApiRoutes } from './routes/api.js';
import { registerGithubRoutes } from './routes/github.js';
import { registerStreamRoutes } from './routes/stream.js';

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport: undefined,
    },
    // GitHub signature verification needs the exact bytes that were signed.
    bodyLimit: 5 * 1024 * 1024,
  });

  await initialiseSchema();
  app.log.info('schema ready');

  await registerApiRoutes(app);
  await registerStreamRoutes(app);
  await registerGithubRoutes(app);

  // The dashboard is a single self-contained document, read once at boot.
  const dashboard = await readFile(join(here, 'web', 'dashboard.html'), 'utf8');
  app.get('/', async (_request, reply) => {
    reply.type('text/html; charset=utf-8');
    return dashboard;
  });

  startReaper();

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received, shutting down`);
    stopReaper();
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(`ephemera listening on ${config.port}`);
}

main().catch((error) => {
  console.error('[ephemera] failed to start:', error);
  process.exit(1);
});
