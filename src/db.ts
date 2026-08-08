/**
 * PostgreSQL access for the control plane's own state.
 *
 * Connection details come from whichever variables Zerops injected when the
 * database service was linked. `DATABASE_URL` is preferred; the discrete
 * DB_* variables are the fallback, since a Zerops PostgreSQL service always
 * exposes database name and user as the literal string `db`.
 */

import pg from 'pg';

const { Pool } = pg;

function connectionString(): string {
  const explicit = process.env.DATABASE_URL?.trim();
  if (explicit) return explicit;

  const host = process.env.DB_HOST?.trim();
  const password = process.env.DB_PASS?.trim();
  if (!host || !password) {
    throw new Error(
      'No database configuration found. Set DATABASE_URL, or DB_HOST and DB_PASS.',
    );
  }
  const name = process.env.DB_NAME?.trim() || 'db';
  const user = process.env.DB_USER?.trim() || 'db';
  const port = process.env.DB_PORT?.trim() || '5432';
  return `postgresql://${user}:${encodeURIComponent(password)}@${host}:${port}/${name}`;
}

export const pool = new Pool({
  connectionString: connectionString(),
  max: 8,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

/**
 * Create the schema if it is absent.
 *
 * Kept as plain idempotent DDL rather than a migration framework: there is a
 * single table, and a self-healing schema means a fresh deployment of the
 * control plane works with no manual step.
 */
export async function initialiseSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS environments (
      id            TEXT PRIMARY KEY,
      slug          TEXT NOT NULL UNIQUE,
      app_hostname  TEXT NOT NULL,
      db_hostname   TEXT,
      url           TEXT NOT NULL,
      repo          TEXT NOT NULL,
      branch        TEXT,
      source        TEXT NOT NULL DEFAULT 'api',
      pr_number     INTEGER,
      pr_repo       TEXT,
      title         TEXT,
      status        TEXT NOT NULL,
      error         TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      ready_at      TIMESTAMPTZ,
      destroyed_at  TIMESTAMPTZ,
      expires_at    TIMESTAMPTZ NOT NULL
    );
  `);

  await pool.query(
    `CREATE INDEX IF NOT EXISTS environments_status_idx ON environments (status);`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS environments_pr_idx ON environments (pr_repo, pr_number);`,
  );
}

export async function closePool(): Promise<void> {
  await pool.end();
}
