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

  /** Version reported by /api/health - used to confirm which build is live. */
  version: '2.1.1',

  security: {
    /**
     * Admin key protecting every mutating endpoint. When unset the API runs
     * open - acceptable for local development only, and warned about at boot.
     */
    apiKey: process.env.EPHEMERA_API_KEY?.trim() ?? '',

    /** Read endpoints are public by default; set EPHEMERA_PUBLIC_READS=false to lock them. */
    publicReads: optional('EPHEMERA_PUBLIC_READS', 'true') !== 'false',
  },

  /**
   * This deployment's own public URL, used when creating repository webhooks.
   * Zerops injects `zeropsSubdomain` into the container, so this usually needs
   * no configuration at all.
   */
  publicUrl: (
    process.env.EPHEMERA_PUBLIC_URL?.trim() ||
    process.env.zeropsSubdomain?.trim() ||
    ''
  ).replace(/\/+$/, ''),

  limits: {
    /**
     * Hard cap on concurrently existing environments. Each environment is two
     * billed services, so an unbounded create API is an unbounded bill.
     */
    maxLiveEnvironments: Number(optional('MAX_LIVE_ENVIRONMENTS', '10')),

    /** Mutations allowed per IP per window. */
    mutationsPerWindow: Number(optional('RATE_LIMIT_MUTATIONS', '60')),
    rateWindowMs: 10 * 60_000,
  },
} as const;

export type Config = typeof config;
