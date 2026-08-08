/**
 * Runtime configuration, resolved once at boot.
 *
 * Everything secret arrives through the environment. Nothing here is ever
 * written to disk or logged, because this repository is public.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `See README.md for the full list.`,
    );
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : fallback;
}

export const config = {
  /** Port the control plane listens on. Zerops sets PORT for us. */
  port: Number(optional('PORT', '3000')),

  zerops: {
    /**
     * Personal access token. Used both to authenticate zcli (for mutations)
     * and as a bearer token against the public REST API (for reads).
     */
    token: required('EPHEMERA_ZEROPS_TOKEN'),

    /**
     * The single long-lived project that hosts every ephemeral environment.
     *
     * Environments are *services inside this project*, never separate
     * projects: project creation carries a fixed ~2 minute core-activation
     * cost that service creation does not.
     */
    projectId: required('EPHEMERA_PROJECT_ID'),

    /**
     * The 4-character code Zerops embeds in public subdomains, e.g. the
     * `2c46` in `api-2c46-3000.prg1.zerops.app`. It is fixed per project,
     * which lets us compute an environment's URL *before* it exists.
     */
    projectCode: required('EPHEMERA_PROJECT_CODE'),

    /** Region host used to build public URLs. */
    region: optional('EPHEMERA_REGION', 'prg1'),

    apiBase: optional(
      'EPHEMERA_API_BASE',
      'https://api.app-prg1.zerops.io/api/rest/public',
    ),
  },

  github: {
    /** Optional: enables PR comments. Without it, webhooks still work. */
    token: process.env.GITHUB_TOKEN?.trim() ?? '',
    /** Optional: if set, webhook signatures are verified. */
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET?.trim() ?? '',
  },

  /** Environments older than this are reaped automatically. */
  defaultTtlMinutes: Number(optional('DEFAULT_TTL_MINUTES', '120')),

  /** How often the reaper wakes up. */
  reaperIntervalMs: Number(optional('REAPER_INTERVAL_MS', '60000')),

  /**
   * Safety rail. The reaper will never destroy a service whose hostname
   * appears here, which protects the demo environment and the control
   * plane's own services from being cleaned up mid-presentation.
   */
  protectedHostnames: optional('PROTECTED_HOSTNAMES', 'api,db,ephemera,ephemeradb')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
} as const;

export type Config = typeof config;
