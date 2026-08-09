/**
 * Data access for environment records.
 *
 * The control plane is the source of truth for *intent* (what should exist,
 * who asked for it, when it expires). Zerops remains the source of truth for
 * *reality*, which is reconciled by the readiness watcher and the reaper.
 */

import { pool } from '../db.js';

export type EnvironmentStatus =
  | 'creating'
  | 'building'
  | 'ready'
  | 'failed'
  | 'destroying'
  | 'destroyed';

export type EnvironmentSource = 'api' | 'github' | 'agent';

/** A preview dies with its pull request; production is permanent. */
export type EnvironmentKind = 'preview' | 'production';

export interface EnvironmentRecord {
  id: string;
  slug: string;
  appHostname: string;
  dbHostname: string | null;
  url: string;
  repo: string;
  branch: string | null;
  source: EnvironmentSource;
  kind: EnvironmentKind;
  prNumber: number | null;
  prRepo: string | null;
  title: string | null;
  status: EnvironmentStatus;
  error: string | null;
  createdAt: Date;
  readyAt: Date | null;
  destroyedAt: Date | null;
  expiresAt: Date;
}

interface Row {
  id: string;
  slug: string;
  app_hostname: string;
  db_hostname: string | null;
  url: string;
  repo: string;
  branch: string | null;
  source: EnvironmentSource;
  kind: EnvironmentKind;
  pr_number: number | null;
  pr_repo: string | null;
  title: string | null;
  status: EnvironmentStatus;
  error: string | null;
  created_at: Date;
  ready_at: Date | null;
  destroyed_at: Date | null;
  expires_at: Date;
}

function toRecord(row: Row): EnvironmentRecord {
  return {
    id: row.id,
    slug: row.slug,
    appHostname: row.app_hostname,
    dbHostname: row.db_hostname,
    url: row.url,
    repo: row.repo,
    branch: row.branch,
    source: row.source,
    kind: row.kind ?? 'preview',
    prNumber: row.pr_number,
    prRepo: row.pr_repo,
    title: row.title,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    readyAt: row.ready_at,
    destroyedAt: row.destroyed_at,
    expiresAt: row.expires_at,
  };
}

export interface InsertEnvironment {
  id: string;
  slug: string;
  appHostname: string;
  dbHostname: string | null;
  url: string;
  repo: string;
  branch: string | null;
  source: EnvironmentSource;
  kind?: EnvironmentKind;
  prNumber: number | null;
  prRepo: string | null;
  title: string | null;
  expiresAt: Date;
}

export async function insert(input: InsertEnvironment): Promise<EnvironmentRecord> {
  const { rows } = await pool.query<Row>(
    `INSERT INTO environments
       (id, slug, app_hostname, db_hostname, url, repo, branch, source,
        pr_number, pr_repo, title, status, expires_at, kind)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'creating',$12,$13)
     RETURNING *`,
    [
      input.id,
      input.slug,
      input.appHostname,
      input.dbHostname,
      input.url,
      input.repo,
      input.branch,
      input.source,
      input.prNumber,
      input.prRepo,
      input.title,
      input.expiresAt,
      input.kind ?? 'preview',
    ],
  );
  return toRecord(rows[0]!);
}

export async function setStatus(
  id: string,
  status: EnvironmentStatus,
  error?: string | null,
): Promise<EnvironmentRecord | null> {
  const { rows } = await pool.query<Row>(
    `UPDATE environments
        SET status = $2,
            error = $3,
            ready_at = CASE WHEN $2 = 'ready' AND ready_at IS NULL
                            THEN now() ELSE ready_at END,
            destroyed_at = CASE WHEN $2 = 'destroyed' AND destroyed_at IS NULL
                                THEN now() ELSE destroyed_at END
      WHERE id = $1
      RETURNING *`,
    [id, status, error ?? null],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function getById(id: string): Promise<EnvironmentRecord | null> {
  const { rows } = await pool.query<Row>(
    `SELECT * FROM environments WHERE id = $1`,
    [id],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

export async function getBySlug(slug: string): Promise<EnvironmentRecord | null> {
  const { rows } = await pool.query<Row>(
    `SELECT * FROM environments WHERE slug = $1`,
    [slug],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

/** Find the live environment attached to a pull request, if any. */
export async function getByPullRequest(
  prRepo: string,
  prNumber: number,
): Promise<EnvironmentRecord | null> {
  const { rows } = await pool.query<Row>(
    `SELECT * FROM environments
      WHERE pr_repo = $1 AND pr_number = $2 AND status <> 'destroyed'
      ORDER BY created_at DESC
      LIMIT 1`,
    [prRepo, prNumber],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

/** Everything that has not been torn down, newest first. */
export async function listActive(): Promise<EnvironmentRecord[]> {
  const { rows } = await pool.query<Row>(
    `SELECT * FROM environments
      WHERE status <> 'destroyed'
      ORDER BY created_at DESC`,
  );
  return rows.map(toRecord);
}

export async function listAll(limit = 100): Promise<EnvironmentRecord[]> {
  const { rows } = await pool.query<Row>(
    `SELECT * FROM environments ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map(toRecord);
}

/** Environments past their TTL that are still standing. */
export async function listExpired(): Promise<EnvironmentRecord[]> {
  const { rows } = await pool.query<Row>(
    `SELECT * FROM environments
      WHERE expires_at < now()
        AND kind <> 'production'
        AND status NOT IN ('destroyed', 'destroying')`,
  );
  return rows.map(toRecord);
}

/**
 * How many environments currently occupy capacity. Anything not destroyed
 * counts - a failed environment may still have real services standing.
 */
export async function countActive(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM environments WHERE status <> 'destroyed'`,
  );
  return Number(rows[0]?.n ?? 0);
}

/** Environments whose lifecycle was interrupted by a control-plane restart. */
export async function listInFlight(): Promise<EnvironmentRecord[]> {
  const { rows } = await pool.query<Row>(
    `SELECT * FROM environments
      WHERE status IN ('creating', 'building', 'destroying')`,
  );
  return rows.map(toRecord);
}

/** Move an environment's expiry, returning the updated record. */
export async function setExpiry(
  id: string,
  expiresAt: Date,
): Promise<EnvironmentRecord | null> {
  const { rows } = await pool.query<Row>(
    `UPDATE environments SET expires_at = $2 WHERE id = $1 RETURNING *`,
    [id, expiresAt],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}

/** The production environment for a repository, if one exists. */
export async function getProduction(repo: string): Promise<EnvironmentRecord | null> {
  const { rows } = await pool.query<Row>(
    `SELECT * FROM environments
      WHERE kind = 'production' AND repo = $1 AND status <> 'destroyed'
      ORDER BY created_at DESC LIMIT 1`,
    [repo],
  );
  return rows[0] ? toRecord(rows[0]) : null;
}
