/**
 * Static analysis of PostgreSQL migrations.
 *
 * The dangerous thing about a migration is almost never the SQL being wrong -
 * it is the *lock* the SQL takes, and for how long. A statement that runs in
 * 8ms against forty rows can hold ACCESS EXCLUSIVE for minutes against forty
 * million, and every write to that table queues behind it. The site is down,
 * and nothing in the migration failed.
 *
 * These rules encode which statements take which locks, which rewrite a table,
 * and which break an application that is still running the previous release.
 * They are deliberately conservative: a false warning costs a developer thirty
 * seconds, a missed one costs an outage.
 *
 * This module is pure and has no database dependency, so the whole rule set is
 * unit-testable. Measured lock durations come later, from runner.ts, against a
 * real database - the two together are the product.
 *
 * Parsing is heuristic rather than a full PostgreSQL grammar: statements are
 * split on semicolons outside quotes and matched with anchored patterns. That
 * is enough for migration files, which are overwhelmingly single DDL
 * statements, and it fails toward reporting rather than silence.
 */

export type Severity = 'critical' | 'warning' | 'info';

export interface Finding {
  severity: Severity;
  /** Short rule identifier, e.g. `add-column-not-null`. */
  rule: string;
  /** One line: what this statement does that matters. */
  summary: string;
  /** Why it is dangerous, in terms of locks and blast radius. */
  detail: string;
  /** The safe alternative, concretely. */
  remedy?: string;
  /** The PostgreSQL lock this acquires, when it is the point. */
  lock?: string;
  /** 1-based index of the statement within the file. */
  statement: number;
  /** The statement itself, trimmed for display. */
  sql: string;
}

export interface AnalysisResult {
  findings: Finding[];
  statementCount: number;
  /** True when nothing worse than `info` was found. */
  safe: boolean;
}

/**
 * Split a script into statements.
 *
 * Semicolons inside string literals, dollar-quoted bodies and line comments
 * must not split - a function body full of semicolons would otherwise shatter
 * into nonsense and produce a page of false findings.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let index = 0;

  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag: string | null = null;

  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1];

    if (inLineComment) {
      if (char === '\n') inLineComment = false;
      current += char;
      index += 1;
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        current += '*/';
        index += 2;
        continue;
      }
      current += char;
      index += 1;
      continue;
    }
    if (dollarTag !== null) {
      if (sql.startsWith(dollarTag, index)) {
        current += dollarTag;
        index += dollarTag.length;
        dollarTag = null;
        continue;
      }
      current += char;
      index += 1;
      continue;
    }
    if (inSingle) {
      current += char;
      index += 1;
      // '' is an escaped quote inside a literal.
      if (char === "'" && next === "'") {
        current += "'";
        index += 1;
      } else if (char === "'") {
        inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      current += char;
      index += 1;
      if (char === '"') inDouble = false;
      continue;
    }

    if (char === '-' && next === '-') {
      inLineComment = true;
      current += '--';
      index += 2;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      current += '/*';
      index += 2;
      continue;
    }
    if (char === "'") {
      inSingle = true;
      current += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      current += char;
      index += 1;
      continue;
    }
    if (char === '$') {
      const match = /^\$[A-Za-z_]*\$/.exec(sql.slice(index));
      if (match) {
        dollarTag = match[0];
        current += dollarTag;
        index += dollarTag.length;
        continue;
      }
    }
    if (char === ';') {
      statements.push(current.trim());
      current = '';
      index += 1;
      continue;
    }

    current += char;
    index += 1;
  }

  if (current.trim() !== '') statements.push(current.trim());
  return statements.filter((statement) => stripComments(statement) !== '');
}

function stripComments(statement: string): string {
  return statement
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalised form used for matching: comments removed, whitespace collapsed. */
function normalise(statement: string): string {
  return stripComments(statement);
}

interface Rule {
  rule: string;
  severity: Severity;
  lock?: string;
  /** Return null when the rule does not apply to this statement. */
  test: (sql: string) => { summary: string; detail: string; remedy?: string } | null;
}

/**
 * Does this ALTER TABLE actually add a *column*?
 *
 * `COLUMN` is optional in PostgreSQL's grammar, so a naive `ADD\s+(COLUMN\s+)?`
 * also matches `ADD CONSTRAINT`, `ADD PRIMARY KEY` and friends - which produced
 * a foreign key being reported as "adds a nullable column". Anything that
 * introduces a table constraint is explicitly excluded.
 */
function addsColumn(sql: string): boolean {
  const match = /\bADD\s+(?:COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?)?(["\w]+)/i.exec(sql);
  if (!match) return false;
  if (/\bADD\s+COLUMN\b/i.test(sql)) return true;
  return !/^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|EXCLUDE)$/i.test(match[1]!);
}

const RULES: Rule[] = [
  /* ── Table rewrites and long exclusive locks ───────────────────────── */
  {
    rule: 'add-column-not-null-no-default',
    severity: 'critical',
    lock: 'ACCESS EXCLUSIVE',
    test: (sql) => {
      if (!/^ALTER\s+TABLE\s/i.test(sql)) return null;
      if (!addsColumn(sql)) return null;
      if (!/NOT\s+NULL/i.test(sql)) return null;
      if (/DEFAULT/i.test(sql)) return null;
      return {
        summary: 'Adds a NOT NULL column with no default.',
        detail:
          'PostgreSQL cannot satisfy NOT NULL for existing rows without a value, so this ' +
          'fails outright on a non-empty table. On an empty table it succeeds, which is ' +
          'exactly why it passes locally and fails in production.',
        remedy:
          'Add the column nullable, backfill in batches, then SET NOT NULL — or supply a DEFAULT.',
      };
    },
  },
  {
    rule: 'set-not-null',
    severity: 'warning',
    lock: 'ACCESS EXCLUSIVE',
    test: (sql) =>
      /^ALTER\s+TABLE\s/i.test(sql) && /ALTER\s+(?:COLUMN\s+)?[\w".]+\s+SET\s+NOT\s+NULL/i.test(sql)
        ? {
            summary: 'Sets an existing column NOT NULL.',
            detail:
              'This scans every row to prove no NULLs exist, holding ACCESS EXCLUSIVE for the ' +
              'whole scan. Every read and write to the table blocks until it finishes.',
            remedy:
              'Add a NOT VALID CHECK (col IS NOT NULL), VALIDATE it (takes only a weak lock), ' +
              'then SET NOT NULL — PostgreSQL 12+ uses the validated constraint and skips the scan.',
          }
        : null,
  },
  {
    rule: 'alter-column-type',
    severity: 'critical',
    lock: 'ACCESS EXCLUSIVE',
    test: (sql) => {
      if (!/^ALTER\s+TABLE\s/i.test(sql)) return null;
      const match = /ALTER\s+(?:COLUMN\s+)?["\w.]+\s+(?:SET\s+DATA\s+)?TYPE\s+([\w ()]+)/i.exec(sql);
      if (!match) return null;
      const target = match[1]!.trim().toLowerCase();
      // Whether a type change rewrites depends on the *old* type, which the
      // statement does not state. Rather than guess, say so and name the
      // exceptions - the measured run in runner.ts settles it either way.
      const exceptions = /^(text|varchar(\s*\(\d+\))?)$/.test(target)
        ? ' (varchar → text, and widening a varchar, are the exceptions: those are metadata-only)'
        : '';
      return {
        summary: `Changes a column type to ${target}.`,
        detail:
          'Most type changes rewrite the entire table and every index on it, holding ACCESS ' +
          'EXCLUSIVE throughout — minutes on a large table, during which it is completely ' +
          `unavailable${exceptions}. Whether this particular change rewrites depends on the ` +
          'current type, which the statement does not state.',
        remedy:
          'Add a new column, backfill and dual-write, swap reads over, then drop the old column.',
      };
    },
  },
  {
    rule: 'create-index-blocking',
    severity: 'critical',
    lock: 'SHARE',
    test: (sql) => {
      if (!/^CREATE\s+(?:UNIQUE\s+)?INDEX\s/i.test(sql)) return null;
      if (/CONCURRENTLY/i.test(sql)) return null;
      return {
        summary: 'Builds an index without CONCURRENTLY.',
        detail:
          'A plain CREATE INDEX takes a SHARE lock, which blocks every INSERT, UPDATE and ' +
          'DELETE on the table until the index is fully built. Reads continue; writes stop.',
        remedy:
          'Use CREATE INDEX CONCURRENTLY. It cannot run inside a transaction block, so it must ' +
          'be its own migration.',
      };
    },
  },
  {
    rule: 'concurrently-in-transaction',
    severity: 'warning',
    test: (sql) =>
      /CONCURRENTLY/i.test(sql)
        ? {
            summary: 'Uses CONCURRENTLY.',
            detail:
              'CONCURRENTLY cannot run inside a transaction block. Most migration tools wrap each ' +
              'file in a transaction by default, which makes this fail at runtime.',
            remedy:
              'Disable the transaction for this migration (for example `-- migrate:no-transaction`, ' +
              '`disable_ddl_transaction!`, or your tool\'s equivalent).',
          }
        : null,
  },
  {
    rule: 'add-foreign-key-validating',
    severity: 'warning',
    lock: 'SHARE ROW EXCLUSIVE',
    test: (sql) => {
      if (!/^ALTER\s+TABLE\s/i.test(sql)) return null;
      if (!/ADD\s+(?:CONSTRAINT\s+["\w.]+\s+)?FOREIGN\s+KEY/i.test(sql)) return null;
      if (/NOT\s+VALID/i.test(sql)) return null;
      return {
        summary: 'Adds a foreign key that is validated immediately.',
        detail:
          'This scans the referencing table to validate every existing row, and takes locks on ' +
          'both tables for the duration. Writes to either table block.',
        remedy: 'Add it NOT VALID first, then run VALIDATE CONSTRAINT, which takes a far weaker lock.',
      };
    },
  },
  {
    rule: 'add-check-validating',
    severity: 'warning',
    lock: 'ACCESS EXCLUSIVE',
    test: (sql) => {
      if (!/^ALTER\s+TABLE\s/i.test(sql)) return null;
      if (!/ADD\s+(?:CONSTRAINT\s+["\w.]+\s+)?CHECK/i.test(sql)) return null;
      if (/NOT\s+VALID/i.test(sql)) return null;
      return {
        summary: 'Adds a CHECK constraint that is validated immediately.',
        detail:
          'Every existing row is checked while ACCESS EXCLUSIVE is held, so the table is ' +
          'unavailable for the length of a full scan.',
        remedy: 'Add it NOT VALID, then VALIDATE CONSTRAINT separately.',
      };
    },
  },
  {
    rule: 'add-column-volatile-default',
    severity: 'warning',
    lock: 'ACCESS EXCLUSIVE',
    test: (sql) => {
      if (!/^ALTER\s+TABLE\s/i.test(sql)) return null;
      if (!addsColumn(sql)) return null;
      if (!/DEFAULT\s+(?:now\(\)|current_timestamp|random\(|gen_random_uuid\(|uuid_generate)/i.test(sql)) {
        return null;
      }
      return {
        summary: 'Adds a column with a volatile default.',
        detail:
          'Constant defaults are stored as metadata and are instant. A volatile default such as ' +
          'now() or gen_random_uuid() must be evaluated per row, so the whole table is rewritten ' +
          'under ACCESS EXCLUSIVE.',
        remedy:
          'Add the column with no default, backfill in batches, then set the default for new rows.',
      };
    },
  },

  /* ── Statements that break a running application ───────────────────── */
  {
    rule: 'drop-column',
    severity: 'critical',
    lock: 'ACCESS EXCLUSIVE',
    test: (sql) =>
      /^ALTER\s+TABLE\s/i.test(sql) && /DROP\s+(?:COLUMN\s+)?/i.test(sql)
        ? {
            summary: 'Drops a column.',
            detail:
              'The lock is brief, but the previous release is still running and still selecting ' +
              'that column. Every one of those queries starts failing the moment this commits — ' +
              'before the new code is even deployed.',
            remedy:
              'Expand and contract: stop referencing the column, deploy, then drop it in a later release.',
          }
        : null,
  },
  {
    rule: 'rename',
    severity: 'critical',
    lock: 'ACCESS EXCLUSIVE',
    test: (sql) =>
      /^ALTER\s+TABLE\s/i.test(sql) && /RENAME\s+(?:COLUMN\s+|TO\s+|["\w.]+\s+TO)/i.test(sql)
        ? {
            summary: 'Renames a table or column.',
            detail:
              'A rename is not backwards compatible. The currently deployed release refers to the ' +
              'old name and breaks instantly, and any rollback then breaks on the new name.',
            remedy:
              'Add the new name, dual-write to both, migrate readers, then remove the old one.',
          }
        : null,
  },

  /* ── Data loss ─────────────────────────────────────────────────────── */
  {
    rule: 'drop-table',
    severity: 'critical',
    lock: 'ACCESS EXCLUSIVE',
    test: (sql) =>
      new RegExp(String.raw`^DROP\s+TABLE\s`, 'i').test(sql)
        ? {
            summary: 'Drops a table.',
            detail: 'Irreversible data loss. A rollback of the deployment does not bring the rows back.',
            remedy: 'Rename it out of the way, confirm nothing reads it, then drop it in a later release.',
          }
        : null,
  },
  {
    rule: 'truncate',
    severity: 'critical',
    lock: 'ACCESS EXCLUSIVE',
    test: (sql) =>
      /^TRUNCATE\s/i.test(sql)
        ? {
            summary: 'Truncates a table.',
            detail: 'Deletes every row irreversibly, and cannot be undone by rolling back the release.',
            remedy: 'If this is meant for test data only, guard it so it can never run against production.',
          }
        : null,
  },
  {
    rule: 'unbounded-dml',
    severity: 'warning',
    test: (sql) => {
      if (!/^(?:UPDATE|DELETE)\s/i.test(sql)) return null;
      if (/\sWHERE\s/i.test(sql)) return null;
      return {
        summary: 'Updates or deletes every row with no WHERE clause.',
        detail:
          'This touches the entire table in a single transaction, holding row locks throughout and ' +
          'generating a large amount of WAL. On a big table it blocks writers and can exhaust disk.',
        remedy: 'Batch it — a few thousand rows per transaction, in a loop.',
      };
    },
  },

  /* ── Whole-table maintenance ───────────────────────────────────────── */
  {
    rule: 'vacuum-full',
    severity: 'critical',
    lock: 'ACCESS EXCLUSIVE',
    test: (sql) =>
      /^VACUUM\s+FULL/i.test(sql)
        ? {
            summary: 'Runs VACUUM FULL.',
            detail:
              'Rewrites the entire table while holding ACCESS EXCLUSIVE. The table is completely ' +
              'unavailable for the duration and it needs disk space for a second copy.',
            remedy: 'Use pg_repack, which achieves the same result without the long lock.',
          }
        : null,
  },
  {
    rule: 'reindex-blocking',
    severity: 'warning',
    lock: 'ACCESS EXCLUSIVE',
    test: (sql) =>
      /^REINDEX\s/i.test(sql) && !/CONCURRENTLY/i.test(sql)
        ? {
            summary: 'Rebuilds an index without CONCURRENTLY.',
            detail: 'Blocks reads and writes on the table until the rebuild completes.',
            remedy: 'Use REINDEX CONCURRENTLY (PostgreSQL 12+).',
          }
        : null,
  },

  /* ── Good practice ─────────────────────────────────────────────────── */
  {
    rule: 'add-column-safe',
    severity: 'info',
    test: (sql) => {
      if (!/^ALTER\s+TABLE\s/i.test(sql)) return null;
      if (!addsColumn(sql)) return null;
      if (/NOT\s+NULL/i.test(sql)) return null;
      if (/DEFAULT\s+(?:now\(\)|current_timestamp|random\(|gen_random_uuid\(|uuid_generate)/i.test(sql)) {
        return null;
      }
      return {
        summary: 'Adds a nullable column.',
        detail:
          'Metadata-only on PostgreSQL 11 and later, including with a constant default. Safe on ' +
          'a table of any size.',
      };
    },
  },
];

export function analyseSql(sql: string): AnalysisResult {
  const statements = splitStatements(sql);
  const findings: Finding[] = [];

  statements.forEach((raw, position) => {
    const normalised = normalise(raw);
    for (const rule of RULES) {
      const hit = rule.test(normalised);
      if (!hit) continue;
      findings.push({
        severity: rule.severity,
        rule: rule.rule,
        summary: hit.summary,
        detail: hit.detail,
        ...(hit.remedy ? { remedy: hit.remedy } : {}),
        ...(rule.lock ? { lock: rule.lock } : {}),
        statement: position + 1,
        sql: normalised.length > 240 ? `${normalised.slice(0, 240)}…` : normalised,
      });
    }
  });

  return {
    findings,
    statementCount: statements.length,
    safe: !findings.some((finding) => finding.severity !== 'info'),
  };
}

/** Does this path look like a database migration? */
export function isMigrationPath(path: string): boolean {
  const lower = path.toLowerCase();
  if (!/\.(sql)$/.test(lower)) return false;
  return /(^|\/)(migrations?|migrate|db\/migrate|schema|alembic\/versions|prisma\/migrations)(\/|$)/.test(
    lower,
  );
}
