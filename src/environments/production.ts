/**
 * Production environments.
 *
 * A repository's default branch gets a permanent environment alongside its
 * pull-request previews, so Ephemera is the place a project is *shipped from*
 * rather than only previewed in. Production differs from a preview in three
 * ways: it is exempt from the TTL reaper, exempt from the capacity cap, and
 * receives `production`-scoped secrets rather than `preview`-scoped ones.
 *
 * Redeploying replaces it in place, keeping the same stable URL.
 */

import { config } from '../config.js';
import type { BuildPlan } from '../detect/detect.js';
import { getRepoPlan } from '../github/repos.js';
import { inspectRepo } from '../github/inspect.js';
import { createEnvironment, destroyEnvironment } from './service.js';
import * as store from './store.js';
import type { EnvironmentRecord } from './store.js';
import { sanitiseSlug } from '../zerops/manifest.js';

/** A stable, legal slug for a repository's production environment. */
export function productionSlug(fullName: string): string {
  const repoPart = fullName.split('/').pop() ?? 'repo';
  return sanitiseSlug(`${sanitiseSlug(repoPart).slice(0, 14)}prod`);
}

function planToSpec(plan: BuildPlan) {
  return {
    runtime: plan.runtime,
    port: plan.port,
    withDatabase: plan.withDatabase,
    prepareCommands: plan.prepareCommands,
    buildCommands: plan.buildCommands,
    deployFiles: plan.deployFiles,
    startCommand: plan.startCommand,
  };
}

/**
 * Create or replace the production environment for a repository.
 *
 * `commitSha` pins the deploy; without it the branch tip is used.
 */
export async function deployProduction(
  fullName: string,
  options: { branch?: string; commitSha?: string } = {},
): Promise<EnvironmentRecord> {
  // One inspection covers both the plan fallback and the default branch.
  const stored = await getRepoPlan(fullName);
  const needsInspection = stored === null || options.branch === undefined;
  const inspection = needsInspection ? await inspectRepo(fullName) : null;

  const plan: BuildPlan = stored ?? inspection!.plan;
  const branch = options.branch ?? inspection!.defaultBranch;

  // Replace in place: the URL is derived from the slug, so tearing the old one
  // down and recreating keeps the same address.
  const existing = await store.getProduction(`https://github.com/${fullName}`);
  if (existing) await destroyEnvironment(existing.id);

  return createEnvironment({
    slug: productionSlug(fullName),
    repo: `https://github.com/${fullName}`,
    branch,
    commitSha: options.commitSha,
    kind: 'production',
    source: 'github',
    trusted: true,
    title: `${fullName} — production (${branch})`,
    // Production never expires; the reaper skips `kind = 'production'` anyway,
    // and this keeps the countdown from reading as imminent in the UI.
    ttlMinutes: 60 * 24 * 365,
    ...planToSpec(plan),
  });
}

/** The production environment for a repository, if any. */
export async function getProductionFor(fullName: string): Promise<EnvironmentRecord | null> {
  return store.getProduction(`https://github.com/${fullName}`);
}

export const PRODUCTION_TTL_NOTE =
  'Production environments are permanent: they are exempt from the TTL reaper ' +
  `and from the ${config.limits.maxLiveEnvironments}-environment cap.`;
