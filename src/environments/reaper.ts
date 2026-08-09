/**
 * Background reaper.
 *
 * Creating infrastructure is easy; the hard part of an ephemeral-environment
 * system is reliably *removing* it. Without this loop, a forgotten environment
 * bills indefinitely - so the reaper is the component that makes the whole
 * idea safe to use.
 */

import { config } from '../config.js';
import { reconcileOrphans } from './reconcile.js';
import { destroyEnvironment } from './service.js';
import * as store from './store.js';

let timer: NodeJS.Timeout | null = null;

export async function reapExpired(): Promise<number> {
  const expired = await store.listExpired();
  if (expired.length === 0) return 0;

  let reaped = 0;
  for (const environment of expired) {
    // Protected hostnames belong to the control plane itself or to a pinned
    // demo environment. Skipping them here means a misconfigured TTL can never
    // take down the presentation mid-demo.
    if (config.protectedHostnames.includes(environment.appHostname)) {
      continue;
    }
    try {
      console.log(
        `[ephemera] reaping ${environment.slug} (expired ${environment.expiresAt.toISOString()})`,
      );
      await destroyEnvironment(environment.id);
      reaped += 1;
    } catch (error) {
      console.error(`[ephemera] failed to reap ${environment.slug}:`, error);
    }
  }
  return reaped;
}

export function startReaper(): void {
  if (timer) return;
  timer = setInterval(() => {
    void reapExpired().catch((error) =>
      console.error('[ephemera] reaper cycle failed:', error),
    );
    // Guarantee teardown: remove anything a failed delete left behind.
    void reconcileOrphans().catch((error) =>
      console.error('[ephemera] reconcile cycle failed:', error),
    );
  }, config.reaperIntervalMs);

  // Do not hold the process open purely for the reaper.
  timer.unref();
  console.log(
    `[ephemera] reaper started, checking every ${Math.round(config.reaperIntervalMs / 1000)}s`,
  );
}

export function stopReaper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
