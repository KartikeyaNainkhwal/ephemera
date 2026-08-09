/**
 * Repository inspection.
 *
 * Reads just enough of a repository through the GitHub API to infer how to
 * build it: the root file listing and package.json. Two cheap requests - no
 * clone, no checkout - so connecting a repository stays interactive.
 */

import { config } from '../config.js';
import { detect, usesDocker, type BuildPlan, type RepoSignals } from '../detect/detect.js';

const GITHUB_API = 'https://api.github.com';

async function api(path: string): Promise<Response> {
  return fetch(`${GITHUB_API}${path}`, {
    headers: {
      ...(config.github.token ? { Authorization: `Bearer ${config.github.token}` } : {}),
      Accept: 'application/vnd.github+json',
    },
    signal: AbortSignal.timeout(15_000),
  });
}

export interface Inspection {
  plan: BuildPlan;
  /** True when the repository looks Docker-based, which Zerops builds differently. */
  docker: boolean;
  defaultBranch: string;
}

/**
 * Inspect a repository at a ref and propose a build plan.
 *
 * Never throws on an unrecognised stack - detection always returns something
 * editable. It throws only when the repository itself cannot be read.
 */
export async function inspectRepo(fullName: string, ref?: string): Promise<Inspection> {
  const repoResponse = await api(`/repos/${fullName}`);
  if (!repoResponse.ok) {
    if (repoResponse.status === 404) {
      throw new Error(
        `Cannot see ${fullName}. Check the name, and that the configured GitHub ` +
          'token has access to it.',
      );
    }
    throw new Error(`GitHub responded ${repoResponse.status} for ${fullName}.`);
  }
  const repo = (await repoResponse.json()) as { default_branch?: string };
  const branch = ref ?? repo.default_branch ?? 'main';

  const contentsResponse = await api(
    `/repos/${fullName}/contents/?ref=${encodeURIComponent(branch)}`,
  );
  const entries = contentsResponse.ok
    ? ((await contentsResponse.json()) as Array<{ name: string }>)
    : [];
  const files = entries.map((entry) => entry.name);

  let packageJson: RepoSignals['packageJson'] = null;
  if (files.some((f) => f.toLowerCase() === 'package.json')) {
    const pkgResponse = await api(
      `/repos/${fullName}/contents/package.json?ref=${encodeURIComponent(branch)}`,
    );
    if (pkgResponse.ok) {
      const payload = (await pkgResponse.json()) as { content?: string; encoding?: string };
      if (payload.content && payload.encoding === 'base64') {
        try {
          packageJson = JSON.parse(Buffer.from(payload.content, 'base64').toString('utf8'));
        } catch {
          // A malformed package.json still tells us this is a Node project;
          // detection falls through to the generic Node plan.
          packageJson = {};
        }
      }
    }
  }

  return {
    plan: detect({ files, packageJson }),
    docker: usesDocker(files),
    defaultBranch: branch,
  };
}
