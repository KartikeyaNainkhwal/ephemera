/**
 * Executing migrations against a real database.
 *
 * Static analysis says a statement *will* take ACCESS EXCLUSIVE. Only running
 * it says for how long, and against how many rows - and that is the number
 * that decides whether a deploy is a non-event or an outage.
 *
 * This is the part no other preview platform can do, and it is not cleverness:
 * it falls out of every pull request having its own real, isolated, disposable
 * PostgreSQL. Running an untested migration is safe here precisely because the
 * database is about to be thrown away.
 *
 * The control plane reaches the environment's database over the project's
 * private network. Zerops generates each database's password and exposes it on
 * the service, so it is fetched at the moment of use and never stored.
 */

import pg from 'pg';

import { config } from '../config.js';
import { normaliseStatement, splitStatements } from './analyse.js';

const { Client } = pg;

export interface StatementRun {
  statement: number;
  sql: string;
  /** Wall-clock milliseconds the statement took. */
  durationMs: number;
  ok: boolean;
  error?: string;
  /** The heaviest lock the statement held, as observed. */
  lock?: string;
  /** Table the lock was taken on, when identifiable. */
  relation?: string;
  /** Rows in that table when the statement ran. */
  rows?: number;
}

export interface RunResult {
  ran: boolean;
  /** Why the run did not happen, when it did not. */
  skipped?: string;
  statements: StatementRun[];
  totalMs: number;
  /** Every statement applied cleanly. */
  ok: boolean;
  /** Rolled back afterwards, so the environment is untouched. */
  rolledBack: boolean;
}

interface DatabaseCredentials {
  host: string;
  password: string;
}

/**
 * Read a database service's generated password from Zerops.
 *
 * Fetched per run and held only in memory - the control plane stores no
 * database credentials of its own.
 */
async function credentialsFor(hostname: string): Promise<DatabaseCredentials | null> {
  const response = await fetch(
    `${config.zerops.apiBase}/project/${config.zerops.projectId}/service-stack`,
    {
      headers: {
        Authorization: `Bearer ${config.zerops.token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) return null;

  const data = (await response.json()) as {
    list: Array<{ id: string; name: string }>;
  };
  const service = data.list.find((entry) => entry.name === hostname);
  if (!service) return null;

  const detail = await fetch(`${config.zerops.apiBase}/service-stack/${service.id}`, {
    headers: {
      Authorization: `Bearer ${config.zerops.token}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!detail.ok) return null;

  const payload = (await detail.json()) as {
    userData?: Array<{ key?: string; content?: string }>;
  };
  const password = payload.userData?.find((entry) => entry.key === 'password')?.content;
  if (!password) return null;

  return { host: hostname, password };
}

/** Best-effort guess at which relation a DDL statement touches. */
function relationOf(sql: string): string | null {
  const patterns = [
    /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+|ONLY\s+)?["']?([\w.]+)/i,
    /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?[\w."]+\s+ON\s+["']?([\w.]+)/i,
    /^(?:TRUNCATE|DROP\s+TABLE)\s+(?:IF\s+EXISTS\s+)?["']?([\w.]+)/i,
    /^(?:UPDATE|DELETE\s+FROM)\s+["']?([\w.]+)/i,
    /^VACUUM\s+FULL\s+["']?([\w.]+)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(sql);
    if (match?.[1]) return match[1].replace(/"/g, '');
  }
  return null;
}

/**
 * Apply a migration to an environment's database and measure it.
 *
 * The whole run happens inside a transaction that is **always rolled back**:
 * the aim is to learn what the migration costs, not to leave the preview in a
 * migrated state. (A statement that cannot run in a transaction, such as
 * CREATE INDEX CONCURRENTLY, is reported as skipped rather than forced.)
 */
export async function runMigration(
  dbHostname: string,
  sql: string,
  options: { statementTimeoutMs?: number; lockTimeoutMs?: number } = {},
): Promise<RunResult> {
  const empty: RunResult = {
    ran: false,
    statements: [],
    totalMs: 0,
    ok: false,
    rolledBack: false,
  };

  const credentials = await credentialsFor(dbHostname);
  if (!credentials) {
    return { ...empty, skipped: `Could not read credentials for ${dbHostname}.` };
  }

  const client = new Client({
    host: credentials.host,
    port: 5432,
    user: 'db',
    database: 'db',
    password: credentials.password,
    connectionTimeoutMillis: 15_000,
    // Never let a runaway migration hold the connection open forever.
    statement_timeout: options.statementTimeoutMs ?? 120_000,
  });

  const statements = splitStatements(sql);
  const runs: StatementRun[] = [];
  const started = Date.now();
  let rolledBack = false;

  try {
    await client.connect();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...empty, skipped: `Could not connect to ${dbHostname}: ${message}` };
  }

  try {
    await client.query('BEGIN');
    // A migration must never sit waiting on someone else's lock: fail fast and
    // report it rather than hang the analysis.
    await client.query(`SET LOCAL lock_timeout = '${options.lockTimeoutMs ?? 5_000}ms'`);

    for (const [index, raw] of statements.entries()) {
      // Match on the comment-free form; execute the original, which PostgreSQL
      // is perfectly happy to run comments and all.
      const statement = normaliseStatement(raw);
      const relation = relationOf(statement);
      let rows: number | undefined;

      if (relation) {
        try {
          const count = await client.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM ${quoteIdentifier(relation)}`,
          );
          rows = Number(count.rows[0]?.n ?? 0);
        } catch {
          // The table may not exist yet - that is normal for a create.
        }
      }

      if (/CONCURRENTLY/i.test(statement)) {
        runs.push({
          statement: index + 1,
          sql: statement.slice(0, 240),
          durationMs: 0,
          ok: true,
          ...(relation ? { relation } : {}),
          ...(rows !== undefined ? { rows } : {}),
          error: 'Skipped: CONCURRENTLY cannot run inside a transaction.',
        });
        continue;
      }

      const begin = Date.now();
      try {
        await client.query(raw);
        const durationMs = Date.now() - begin;

        // Read back the heaviest lock this transaction now holds on the relation.
        let lock: string | undefined;
        if (relation) {
          try {
            const locks = await client.query<{ mode: string }>(
              `SELECT mode FROM pg_locks l
                 JOIN pg_class c ON c.oid = l.relation
                WHERE l.pid = pg_backend_pid() AND c.relname = $1
                ORDER BY CASE mode
                  WHEN 'AccessExclusiveLock' THEN 1
                  WHEN 'ExclusiveLock' THEN 2
                  WHEN 'ShareRowExclusiveLock' THEN 3
                  WHEN 'ShareLock' THEN 4
                  ELSE 5 END
                LIMIT 1`,
              [relation.split('.').pop()],
            );
            lock = locks.rows[0]?.mode;
          } catch {
            /* lock inspection is a nicety, never a failure */
          }
        }

        runs.push({
          statement: index + 1,
          sql: statement.slice(0, 240),
          durationMs,
          ok: true,
          ...(lock ? { lock } : {}),
          ...(relation ? { relation } : {}),
          ...(rows !== undefined ? { rows } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        runs.push({
          statement: index + 1,
          sql: statement.slice(0, 240),
          durationMs: Date.now() - begin,
          ok: false,
          error: message,
          ...(relation ? { relation } : {}),
          ...(rows !== undefined ? { rows } : {}),
        });
        break; // a failed statement aborts the transaction; nothing after it can run
      }
    }
  } finally {
    try {
      await client.query('ROLLBACK');
      rolledBack = true;
    } catch {
      /* the transaction may already be aborted */
    }
    await client.end().catch(() => undefined);
  }

  return {
    ran: true,
    statements: runs,
    totalMs: Date.now() - started,
    ok: runs.length > 0 && runs.every((run) => run.ok),
    rolledBack,
  };
}

/** Quote a possibly schema-qualified identifier for interpolation. */
function quoteIdentifier(name: string): string {
  return name
    .split('.')
    .map((part) => `"${part.replace(/"/g, '""')}"`)
    .join('.');
}
