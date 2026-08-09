/**
 * Review actions taken from the dashboard.
 *
 * The point of a preview is to make a decision. Approving or rejecting from
 * the dashboard means a reviewer never has to reconstruct context in a second
 * tab: look at the running app, then act on it in the same place.
 */

import { config } from '../config.js';

const GITHUB_API = 'https://api.github.com';

async function github<T>(path: string, init?: RequestInit): Promise<T> {
  if (!config.github.token) {
    throw new Error('GITHUB_TOKEN is not configured, so pull requests cannot be actioned.');
  }
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.github.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(20_000),
  });

  const body = await response.text();
  if (!response.ok) {
    // GitHub's merge endpoint is unusually specific about *why* it refused,
    // and that reason is the useful part for a reviewer.
    let detail = body.slice(0, 300);
    try {
      const parsed = JSON.parse(body) as { message?: string };
      if (parsed.message) detail = parsed.message;
    } catch {
      /* keep the raw body */
    }
    if (response.status === 405) {
      throw new Error(`GitHub refused the merge: ${detail}`);
    }
    if (response.status === 409) {
      throw new Error(
        'This pull request has a merge conflict and cannot be merged automatically.',
      );
    }
    throw new Error(`GitHub responded ${response.status}: ${detail}`);
  }
  return body ? (JSON.parse(body) as T) : (undefined as T);
}

export interface MergeResult {
  merged: boolean;
  sha?: string;
}

/** Merge a pull request. Teardown follows from GitHub's `closed` webhook. */
export async function mergePullRequest(
  fullName: string,
  number: number,
  method: 'merge' | 'squash' | 'rebase' = 'squash',
): Promise<MergeResult> {
  const result = await github<{ merged?: boolean; sha?: string }>(
    `/repos/${fullName}/pulls/${number}/merge`,
    { method: 'PUT', body: JSON.stringify({ merge_method: method }) },
  );
  return { merged: result.merged === true, sha: result.sha };
}

/** Close a pull request without merging. */
export async function closePullRequest(fullName: string, number: number): Promise<void> {
  await github(`/repos/${fullName}/pulls/${number}`, {
    method: 'PATCH',
    body: JSON.stringify({ state: 'closed' }),
  });
}

/** Leave a note on the pull request explaining what was done and why. */
export async function commentOnPullRequest(
  fullName: string,
  number: number,
  body: string,
): Promise<void> {
  try {
    await github(`/repos/${fullName}/issues/${number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
  } catch (error) {
    // A missing comment must never fail the action the user actually asked for.
    console.error('[ephemera] review comment failed:', error);
  }
}
