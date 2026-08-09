/**
 * Repository connections.
 *
 * "Connect a repository" is the product's onboarding moment: Ephemera creates
 * (or adopts) the pull_request webhook on the repository itself, so pull
 * requests start receiving preview environments with no manual webhook
 * configuration.
 *
 * Connecting is idempotent - if a hook already points at this control plane,
 * it is adopted and normalised (events, secret) rather than duplicated.
 */

import { config } from '../config.js';
import { pool } from '../db.js';
import { normaliseRepoName } from './name.js';

const GITHUB_API = 'https://api.github.com';

export interface ConnectedRepo {
  fullName: string;
  webhookId: number;
  connectedAt: string;
}

interface RepoRow {
  full_name: string;
  webhook_id: string | number;
  connected_at: Date;
}

function toRepo(row: RepoRow): ConnectedRepo {
  return {
    fullName: row.full_name,
    webhookId: Number(row.webhook_id),
    connectedAt: new Date(row.connected_at).toISOString(),
  };
}

async function github<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.github.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (response.status === 204) return undefined as T;
  const body = await response.text();

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        'GitHub responded 404 - check the repository name and that the configured ' +
          'token is allowed to administer its webhooks.',
      );
    }
    if (response.status === 401) {
      throw new Error('GitHub rejected the configured GITHUB_TOKEN - it may have been revoked.');
    }
    throw new Error(`GitHub responded ${response.status}: ${body.slice(0, 200)}`);
  }
  return body ? (JSON.parse(body) as T) : (undefined as T);
}

function hookUrl(): string {
  return `${config.publicUrl}/webhooks/github`;
}

function assertConfigured(): void {
  if (!config.github.token) {
    throw new Error(
      'GITHUB_TOKEN is not configured on the control plane, so repositories cannot ' +
        'be connected. Set it as a secret variable and restart.',
    );
  }
  if (!config.github.webhookSecret) {
    throw new Error(
      'GITHUB_WEBHOOK_SECRET is not configured. Set it so webhook deliveries can be verified.',
    );
  }
  if (!config.publicUrl) {
    throw new Error(
      'The control plane does not know its own public URL. Set EPHEMERA_PUBLIC_URL.',
    );
  }
}

export async function listRepos(): Promise<ConnectedRepo[]> {
  const { rows } = await pool.query<RepoRow>(
    `SELECT * FROM repos ORDER BY connected_at DESC`,
  );
  return rows.map(toRepo);
}

export async function connectRepo(input: string): Promise<ConnectedRepo> {
  const fullName = normaliseRepoName(input);
  assertConfigured();

  const desired = {
    url: hookUrl(),
    content_type: 'json',
    secret: config.github.webhookSecret,
    insecure_ssl: '0',
  };

  interface Hook {
    id: number;
    config?: { url?: string };
  }

  const hooks = await github<Hook[]>(`/repos/${fullName}/hooks?per_page=100`);
  const existing = hooks.find((hook) => hook.config?.url === desired.url);

  let webhookId: number;
  if (existing) {
    // Adopt the hook and normalise it so its secret and events match ours.
    await github(`/repos/${fullName}/hooks/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ active: true, events: ['pull_request'], config: desired }),
    });
    webhookId = existing.id;
  } else {
    const created = await github<Hook>(`/repos/${fullName}/hooks`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'web',
        active: true,
        events: ['pull_request'],
        config: desired,
      }),
    });
    webhookId = created.id;
  }

  const { rows } = await pool.query<RepoRow>(
    `INSERT INTO repos (full_name, webhook_id) VALUES ($1, $2)
     ON CONFLICT (full_name) DO UPDATE SET webhook_id = EXCLUDED.webhook_id
     RETURNING *`,
    [fullName, webhookId],
  );
  return toRepo(rows[0]!);
}

export async function disconnectRepo(fullName: string): Promise<boolean> {
  const { rows } = await pool.query<RepoRow>(`SELECT * FROM repos WHERE full_name = $1`, [
    fullName,
  ]);
  const row = rows[0];
  if (!row) return false;

  if (config.github.token) {
    try {
      await github(`/repos/${fullName}/hooks/${row.webhook_id}`, { method: 'DELETE' });
    } catch {
      // The hook may already be gone, or access may have been revoked.
      // Removing our record is what matters; the webhook without a matching
      // secret would be rejected by signature verification anyway.
    }
  }

  await pool.query(`DELETE FROM repos WHERE full_name = $1`, [fullName]);
  return true;
}
