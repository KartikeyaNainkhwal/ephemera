/**
 * Per-repository secrets.
 *
 * The security model is taken from how preview platforms learned to do this
 * the hard way:
 *
 *  - **Write-only.** A stored value can be set and deleted but never read
 *    back through the API. The dashboard shows a mask, never the value.
 *  - **Encrypted at rest**, so a database dump is not a breach.
 *  - **Scoped.** A secret can apply to production only, previews only, or
 *    both. Production credentials should not reach a preview by default -
 *    preview deployments run code that has not been reviewed yet.
 *  - **Never given to forks.** A pull request from a fork runs untrusted
 *    code; injecting real secrets there is the "preview deployment secret
 *    leakage" attack, where a malicious PR simply prints them.
 *  - **Phased.** Some values are needed while building (NEXT_PUBLIC_*), some
 *    only at runtime, some both.
 */

import { pool } from '../db.js';
import { decrypt, encrypt, mask } from './crypto.js';

export type SecretScope = 'all' | 'production' | 'preview';
export type SecretPhase = 'runtime' | 'build' | 'both';

export interface SecretSummary {
  key: string;
  scope: SecretScope;
  phase: SecretPhase;
  /** A hint, never the value. */
  preview: string;
  updatedAt: string;
}

interface SecretRow {
  repo: string;
  key: string;
  value_enc: string;
  scope: SecretScope;
  phase: SecretPhase;
  updated_at: Date;
}

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateSecretKey(key: string): string {
  const trimmed = key.trim();
  if (!KEY_PATTERN.test(trimmed) || trimmed.length > 64) {
    throw new Error(
      `"${key}" is not a valid environment variable name. Use letters, digits ` +
        'and underscores, starting with a letter or underscore.',
    );
  }
  if (/^ZEROPS_/i.test(trimmed)) {
    throw new Error('The ZEROPS_ prefix is reserved by the platform.');
  }
  // Ephemera wires these itself; overriding them produces an app that builds,
  // boots, and cannot reach its own database.
  if (
    ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASS', 'DB_PORT', 'DATABASE_URL'].includes(
      trimmed.toUpperCase(),
    )
  ) {
    throw new Error(
      `${trimmed} is managed by Ephemera and points at this environment's own database.`,
    );
  }
  return trimmed;
}

export async function setSecret(
  repo: string,
  key: string,
  value: string,
  scope: SecretScope = 'all',
  phase: SecretPhase = 'runtime',
): Promise<SecretSummary> {
  const name = validateSecretKey(key);
  if (value.length > 8_000) throw new Error('Secret values are limited to 8000 characters.');

  const { rows } = await pool.query<SecretRow>(
    `INSERT INTO repo_secrets (repo, key, value_enc, scope, phase)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (repo, key) DO UPDATE
       SET value_enc = EXCLUDED.value_enc,
           scope = EXCLUDED.scope,
           phase = EXCLUDED.phase,
           updated_at = now()
     RETURNING *`,
    [repo, name, encrypt(value), scope, phase],
  );
  return summarise(rows[0]!);
}

export async function deleteSecret(repo: string, key: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM repo_secrets WHERE repo = $1 AND key = $2`,
    [repo, key],
  );
  return (rowCount ?? 0) > 0;
}

/** List secrets as masked summaries. Values never leave the server. */
export async function listSecrets(repo: string): Promise<SecretSummary[]> {
  const { rows } = await pool.query<SecretRow>(
    `SELECT * FROM repo_secrets WHERE repo = $1 ORDER BY key`,
    [repo],
  );
  return rows.map(summarise);
}

function summarise(row: SecretRow): SecretSummary {
  let preview = '••••••••';
  try {
    preview = mask(decrypt(row.value_enc));
  } catch {
    // A value encrypted under a previous key cannot be shown or used. Say so
    // rather than pretending it is fine.
    preview = '(unreadable — re-enter)';
  }
  return {
    key: row.key,
    scope: row.scope,
    phase: row.phase,
    preview,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export interface ResolvedSecrets {
  build: Record<string, string>;
  run: Record<string, string>;
}

/**
 * Decrypt the secrets that apply to one deployment.
 *
 * `trusted` is false for a pull request opened from a fork. Untrusted code
 * gets **no** secrets at all - not a reduced set, none - because the whole
 * point of the attack is that the code decides what to do with them.
 */
export async function resolveSecrets(
  repo: string,
  target: 'production' | 'preview',
  trusted: boolean,
): Promise<ResolvedSecrets> {
  const empty: ResolvedSecrets = { build: {}, run: {} };
  if (!trusted) return empty;

  const { rows } = await pool.query<SecretRow>(
    `SELECT * FROM repo_secrets WHERE repo = $1 AND scope IN ('all', $2)`,
    [repo, target],
  );

  const resolved: ResolvedSecrets = { build: {}, run: {} };
  for (const row of rows) {
    let value: string;
    try {
      value = decrypt(row.value_enc);
    } catch {
      // Skip rather than inject a corrupt value into somebody's build.
      console.error(`[ephemera] secret ${repo}/${row.key} could not be decrypted; skipping`);
      continue;
    }
    if (row.phase === 'build' || row.phase === 'both') resolved.build[row.key] = value;
    if (row.phase === 'runtime' || row.phase === 'both') resolved.run[row.key] = value;
  }
  return resolved;
}

export async function countSecrets(repo: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM repo_secrets WHERE repo = $1`,
    [repo],
  );
  return Number(rows[0]?.n ?? 0);
}
