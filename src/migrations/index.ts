/**
 * Migration analysis for a pull request.
 *
 * Finds the migration files a pull request changes, analyses them statically,
 * and - once the environment's database exists - applies them to it to measure
 * what they actually cost. The result is posted on the pull request.
 */

import { config } from '../config.js';
import { analyseSql, isMigrationPath, type AnalysisResult } from './analyse.js';
import { renderComment, worstSeverity, type MigrationReport } from './report.js';
import { runMigration, type RunResult } from './runner.js';

export { analyseSql, isMigrationPath } from './analyse.js';
export { renderComment, worstSeverity } from './report.js';
export type { MigrationReport } from './report.js';

interface ChangedFile {
  filename: string;
  status: string;
}

async function github<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: {
        ...(config.github.token ? { Authorization: `Bearer ${config.github.token}` } : {}),
        Accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/** Migration files added or modified by a pull request. */
export async function changedMigrations(
  fullName: string,
  prNumber: number,
): Promise<string[]> {
  const files = await github<ChangedFile[]>(
    `/repos/${fullName}/pulls/${prNumber}/files?per_page=100`,
  );
  if (!files) return [];
  return files
    .filter((file) => file.status !== 'removed' && isMigrationPath(file.filename))
    .map((file) => file.filename);
}

async function fileContents(
  fullName: string,
  path: string,
  ref: string,
): Promise<string | null> {
  const payload = await github<{ content?: string; encoding?: string }>(
    `/repos/${fullName}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`,
  );
  if (!payload?.content || payload.encoding !== 'base64') return null;
  return Buffer.from(payload.content, 'base64').toString('utf8');
}

export interface AnalyseOptions {
  /** Apply the migrations to this database and measure them. */
  dbHostname?: string | null;
}

/**
 * Analyse every migration a pull request touches.
 *
 * Static analysis always runs. Execution only happens when the environment has
 * a database - and even then it is rolled back, so the preview is unchanged.
 */
export async function analysePullRequest(
  fullName: string,
  prNumber: number,
  ref: string,
  options: AnalyseOptions = {},
): Promise<MigrationReport | null> {
  const paths = await changedMigrations(fullName, prNumber);
  if (paths.length === 0) return null;

  const files: MigrationReport['files'] = [];

  for (const path of paths) {
    const sql = await fileContents(fullName, path, ref);
    if (sql === null) continue;

    const analysis: AnalysisResult = analyseSql(sql);
    let run: RunResult | undefined;

    if (options.dbHostname) {
      try {
        run = await runMigration(options.dbHostname, sql);
      } catch (error) {
        // Measurement is a bonus; never let it suppress the static findings.
        console.error(`[ephemera] migration run failed for ${path}:`, error);
      }
    }

    files.push({ path, analysis, ...(run ? { run } : {}) });
  }

  return files.length > 0 ? { files } : null;
}

/** Convenience: analyse and render in one step. */
export async function reportForPullRequest(
  fullName: string,
  prNumber: number,
  ref: string,
  options: AnalyseOptions = {},
): Promise<{ body: string; severity: ReturnType<typeof worstSeverity> } | null> {
  const report = await analysePullRequest(fullName, prNumber, ref, options);
  if (!report) return null;
  return { body: renderComment(report), severity: worstSeverity(report) };
}
