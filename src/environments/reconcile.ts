/**
 * Orphan reconciliation.
 *
 * Teardown must be *guaranteed*, not attempted. A single delete can fail for
 * reasons entirely outside our control - Zerops has taken over 100 seconds
 * merely to accept one - and a fire-and-forget delete that quietly fails
 * leaves infrastructure running and billing indefinitely. That is the worst
 * failure mode this product has.
 *
 * So the reconciler converges on the desired state instead: on every reaper
 * tick it compares the services that actually exist against the environments
 * we believe are gone, and removes anything left behind. It retries forever,
 * which means a transient failure costs a minute rather than a bill.
 *
 * It only ever deletes hostnames Ephemera itself recorded creating, for
 * environments already marked destroyed or failed. Anything it did not create
 * - and anything in PROTECTED_HOSTNAMES - is untouchable.
 */

import { config } from '../config.js';
import { listServices } from '../zerops/client.js';
import { serviceDelete } from '../zerops/cli.js';
import * as store from './store.js';

export interface ReconcileResult {
  removed: string[];
  stillPresent: string[];
  /** Records marked destroyed because their services are confirmed gone. */
  healed: string[];
}

export async function reconcileOrphans(): Promise<ReconcileResult> {
  const result: ReconcileResult = { removed: [], stillPresent: [], healed: [] };

  const [records, services] = await Promise.all([
    store.listAll(500),
    listServices(),
  ]);
  const present = new Set(services.map((service) => service.name));

  // Hostnames belonging to environments that should no longer exist.
  const shouldBeGone = new Set<string>();
  // Hostnames belonging to environments that should still exist - a slug can
  // be reused after destruction, so a live environment always wins.
  const mustKeep = new Set<string>();

  for (const record of records) {
    const hostnames = [record.appHostname, record.dbHostname].filter(
      Boolean,
    ) as string[];
    const target =
      record.status === 'destroyed' || record.status === 'failed'
        ? shouldBeGone
        : mustKeep;
    for (const hostname of hostnames) target.add(hostname);
  }

  // A `failed` teardown whose services are actually gone is finished - it just
  // never got the news. Left alone it occupies a capacity slot forever.
  for (const record of records) {
    if (record.status !== 'failed') continue;
    const hostnames = [record.appHostname, record.dbHostname].filter(
      Boolean,
    ) as string[];
    if (hostnames.length === 0) continue;
    if (hostnames.some((hostname) => present.has(hostname))) continue;
    // Only heal teardowns, never a failed *build* - that record is evidence.
    if (record.destroyedAt === null && !/teardown|still present/i.test(record.error ?? '')) {
      continue;
    }
    await store.setStatus(record.id, 'destroyed');
    result.healed.push(record.slug);
  }

  for (const hostname of shouldBeGone) {
    if (mustKeep.has(hostname)) continue;
    if (config.protectedHostnames.includes(hostname)) continue;
    if (!present.has(hostname)) continue;

    try {
      console.warn(`[ephemera] reconciler removing orphaned service ${hostname}`);
      await serviceDelete(hostname);
      result.removed.push(hostname);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ephemera] reconciler could not remove ${hostname}: ${message}`);
      result.stillPresent.push(hostname);
    }
  }

  return result;
}
