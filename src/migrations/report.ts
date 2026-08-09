/**
 * Turning analysis into something a reviewer acts on.
 *
 * A wall of findings is ignored. The verdict leads, the worst thing is named
 * first in plain language, and every item carries the fix. Measured numbers
 * are marked as measured - the difference between "this takes ACCESS
 * EXCLUSIVE" and "this held ACCESS EXCLUSIVE for 4.1s over 812,441 rows" is
 * the difference between a lint warning and a decision.
 */

import type { AnalysisResult, Finding, Severity } from './analyse.js';
import type { RunResult } from './runner.js';

export interface MigrationReport {
  files: Array<{ path: string; analysis: AnalysisResult; run?: RunResult }>;
}

const ICON: Record<Severity, string> = {
  critical: '🛑',
  warning: '⚠️',
  info: '✓',
};

const RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m${Math.round((ms % 60_000) / 1000)}s`;
}

function formatRows(rows: number): string {
  return rows.toLocaleString('en-US');
}

/**
 * Extrapolate a measured duration to production scale.
 *
 * A preview database holds far fewer rows than production, so a measured
 * duration understates the real cost. For statements that scan or rewrite,
 * cost grows roughly linearly with row count, which is enough to turn "8ms
 * here" into "and it will not be 8ms there".
 */
export function projectToProduction(
  measuredMs: number,
  measuredRows: number,
  productionRows: number,
): string | null {
  if (measuredRows <= 0 || productionRows <= measuredRows) return null;
  const projected = measuredMs * (productionRows / measuredRows);
  if (projected < 1000) return null;
  return formatDuration(Math.round(projected));
}

function renderFinding(finding: Finding, run?: RunResult): string {
  const measured = run?.statements.find((s) => s.statement === finding.statement);
  const lines: string[] = [];

  lines.push(`${ICON[finding.severity]} **${finding.summary}**`);
  lines.push('');
  lines.push('```sql');
  lines.push(finding.sql);
  lines.push('```');

  const facts: string[] = [];
  if (measured?.lock) {
    facts.push(
      `held **${measured.lock}**` +
        (measured.durationMs > 0 ? ` for ${formatDuration(measured.durationMs)}` : ''),
    );
  } else if (finding.lock) {
    facts.push(`takes **${finding.lock}**`);
  }
  if (measured?.rows !== undefined) {
    facts.push(`${formatRows(measured.rows)} rows in this environment`);
  }
  if (facts.length > 0) lines.push(`> ${facts.join(' · ')}`);

  lines.push('');
  lines.push(finding.detail);
  if (finding.remedy) {
    lines.push('');
    lines.push(`**Instead:** ${finding.remedy}`);
  }
  if (measured && !measured.ok && measured.error) {
    lines.push('');
    lines.push(`**It failed when run:** \`${measured.error}\``);
  }
  return lines.join('\n');
}

/** Render the whole report as a pull-request comment. */
export function renderComment(report: MigrationReport): string {
  const all: Array<{ path: string; finding: Finding; run?: RunResult }> = [];
  for (const file of report.files) {
    for (const finding of file.analysis.findings) {
      all.push({ path: file.path, finding, run: file.run });
    }
  }

  const critical = all.filter((x) => x.finding.severity === 'critical');
  const warnings = all.filter((x) => x.finding.severity === 'warning');
  const statementCount = report.files.reduce(
    (sum, file) => sum + file.analysis.statementCount,
    0,
  );
  const executed = report.files.some((file) => file.run?.ran);

  const lines: string[] = ['## Ephemera — migration analysis', ''];

  /* ── the verdict, first ─────────────────────────────────────────────── */
  if (critical.length > 0) {
    lines.push(
      `🛑 **${critical.length} change${critical.length === 1 ? '' : 's'} here can take ` +
        `production down.** Read these before merging.`,
    );
  } else if (warnings.length > 0) {
    lines.push(
      `⚠️ **${warnings.length} change${warnings.length === 1 ? '' : 's'} need care at scale.** ` +
        `Nothing here is fatal, but nothing here is free either.`,
    );
  } else {
    lines.push(
      `✓ **Safe to merge.** ${statementCount} statement${statementCount === 1 ? '' : 's'} ` +
        `reviewed, nothing that locks a table or breaks the running release.`,
    );
  }

  if (executed) {
    const ran = report.files.filter((file) => file.run?.ran);
    const failed = ran.filter((file) => file.run && !file.run.ok);
    lines.push('');
    lines.push(
      failed.length > 0
        ? `Applied against this pull request's own PostgreSQL — **${failed.length} file failed**. ` +
          `Rolled back afterwards; the preview database is untouched.`
        : `Applied cleanly against this pull request's own PostgreSQL, then rolled back. ` +
          `Durations below are measured, not estimated.`,
    );
  }

  /* ── findings, worst first ──────────────────────────────────────────── */
  const ordered = [...all].sort(
    (a, b) => RANK[a.finding.severity] - RANK[b.finding.severity],
  );
  const shown = ordered.filter((x) => x.finding.severity !== 'info');

  let currentPath = '';
  for (const item of shown) {
    if (item.path !== currentPath) {
      currentPath = item.path;
      lines.push('', `### \`${item.path}\``);
    }
    lines.push('', renderFinding(item.finding, item.run));
  }

  const infos = ordered.filter((x) => x.finding.severity === 'info');
  if (infos.length > 0) {
    lines.push('', '<details><summary>Safe changes</summary>', '');
    for (const item of infos) {
      lines.push(`- \`${item.path}\` — ${item.finding.summary} ${item.finding.detail}`);
    }
    lines.push('', '</details>');
  }

  lines.push(
    '',
    '---',
    '',
    '<sub>Run against this pull request\'s own isolated database, which is destroyed with it. ' +
      'Static rules cover locks and compatibility; measured durations come from actually ' +
      'applying the statements.</sub>',
  );

  return lines.join('\n');
}

/** Worst severity present, for badges and API responses. */
export function worstSeverity(report: MigrationReport): Severity | null {
  let worst: Severity | null = null;
  for (const file of report.files) {
    for (const finding of file.analysis.findings) {
      if (worst === null || RANK[finding.severity] < RANK[worst]) worst = finding.severity;
    }
  }
  return worst;
}
