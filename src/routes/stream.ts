/**
 * Server-sent events feed.
 *
 * Environments change state on a timescale of minutes but the transitions
 * matter (creating -> building -> ready), so the dashboard subscribes rather
 * than polls. SSE is enough here: the flow is strictly server to client.
 */

import type { FastifyInstance } from 'fastify';

import { events } from '../environments/service.js';
import * as store from '../environments/store.js';
import type { EnvironmentRecord } from '../environments/store.js';
import { serialise } from './api.js';

export async function registerStreamRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/stream', (request, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disable proxy buffering so events are delivered as they happen.
      'X-Accel-Buffering': 'no',
    });

    const send = (event: string, payload: unknown): void => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    // Prime the client with current state so it can render immediately.
    void store
      .listActive()
      .then((records) =>
        send('snapshot', { environments: records.map(serialise) }),
      )
      .catch((error) => {
        request.log.error({ error }, 'failed to send initial snapshot');
      });

    const onChange = (record: EnvironmentRecord): void => {
      send('environment', serialise(record));
    };
    events.on('changed', onChange);

    // Comment frames keep intermediaries from closing an idle connection.
    const heartbeat = setInterval(() => reply.raw.write(': keepalive\n\n'), 25_000);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      events.off('changed', onChange);
    };
    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
  });
}
