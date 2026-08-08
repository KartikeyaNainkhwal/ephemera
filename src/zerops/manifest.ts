/**
 * Turns a high-level environment request into Zerops Import YAML.
 *
 * This module encodes several platform details that are easy to get wrong and
 * were each confirmed empirically against a live project:
 *
 *  1. Hostnames are limited to 25 characters, lowercase `a-z` and `0-9` only.
 *     No hyphens, no underscores, no uppercase.
 *
 *  2. A repository's own `zerops.yml` wins over the `envSecrets` field. To
 *     point an app at a *per-environment* database we must supply a complete
 *     `zeropsYaml` block instead, which overrides the repo's config entirely.
 *     Supplying it as a YAML string fails; it must be a nested object.
 *
 *  3. A Zerops PostgreSQL service always exposes `dbName = db` and
 *     `user = db`. Only the hostname varies. Setting DB_NAME/DB_USER to the
 *     service hostname yields an app that builds and boots but 502s, because
 *     it cannot authenticate.
 *
 *  4. Passwords are referenced as `${<hostname>_password}` and resolved by
 *     Zerops at deploy time, so no credential ever passes through this process.
 */

import yaml from 'js-yaml';

/** Maximum length Zerops allows for a service hostname. */
export const MAX_HOSTNAME_LENGTH = 25;

/**
 * Build the `buildFromGit` value.
 *
 * A trailing `.git` must be stripped before appending `@<branch>`. GitHub's
 * `clone_url` ends in `.git`, which produces `…/repo.git@feature/x` - Zerops
 * accepts that string at import time but the build silently never starts and
 * the service sits in READY_TO_DEPLOY with no app version. Removing the
 * suffix makes it work, including for branch names containing slashes.
 */
export function gitSource(repo: string, branch?: string): string {
  const normalised = repo.replace(/\.git$/, '');
  return branch ? `${normalised}@${branch}` : normalised;
}

/** Reserved for the suffixes we append (`api`, `db`). */
const LONGEST_SUFFIX = 'api'.length;

export interface EnvironmentSpec {
  /** Short identifier for the environment, e.g. `pr42`. Sanitised on use. */
  slug: string;
  /** Public git repository the app is built from. */
  repo: string;
  /** Optional branch or ref. Defaults to the repository default. */
  branch?: string;
  /** Zerops runtime service type, e.g. `nodejs@20`. */
  runtime?: string;
  /** Port the application listens on. */
  port?: number;
  /** Whether to provision a dedicated PostgreSQL service. */
  withDatabase?: boolean;
  /** Commands run before the build (tooling installs). */
  prepareCommands?: string[];
  /** Build commands. */
  buildCommands?: string[];
  /** Paths included in the deployed artifact. */
  deployFiles?: string[];
  /** Process started at runtime. */
  startCommand?: string;
  /** Additional environment variables injected into the running app. */
  env?: Record<string, string>;
}

export interface ResolvedEnvironment {
  slug: string;
  appHostname: string;
  dbHostname: string | null;
  port: number;
  /** Public URL, computable before the environment exists. */
  url: string;
  /** The Import YAML handed to `zcli project service-import`. */
  importYaml: string;
}

/**
 * Reduce arbitrary text (a branch name, a PR title) to a legal hostname
 * fragment. Zerops permits only lowercase letters and digits.
 */
export function sanitiseSlug(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, MAX_HOSTNAME_LENGTH - LONGEST_SUFFIX);

  if (cleaned.length === 0) {
    throw new Error(
      `Slug "${raw}" contains no characters legal in a Zerops hostname ` +
        `(a-z, 0-9 only).`,
    );
  }
  // A hostname must not start with a digit in most DNS contexts; Zerops
  // tolerates it, but a leading letter keeps generated URLs predictable.
  return /^[0-9]/.test(cleaned) ? `e${cleaned}`.slice(0, MAX_HOSTNAME_LENGTH - LONGEST_SUFFIX) : cleaned;
}

/**
 * Compute the public URL Zerops will assign. The project code is stable per
 * project, so this is known before the service exists — which lets us post a
 * pull-request comment immediately rather than after polling.
 */
export function publicUrlFor(
  appHostname: string,
  port: number,
  projectCode: string,
  region: string,
): string {
  return `https://${appHostname}-${projectCode}-${port}.${region}.zerops.app`;
}

export function buildEnvironment(
  spec: EnvironmentSpec,
  projectCode: string,
  region: string,
): ResolvedEnvironment {
  const slug = sanitiseSlug(spec.slug);
  const appHostname = `${slug}api`;
  const withDatabase = spec.withDatabase ?? true;
  const dbHostname = withDatabase ? `${slug}db` : null;
  const port = spec.port ?? 3000;
  const runtime = spec.runtime ?? 'nodejs@20';
  const setupName = 'app';

  for (const hostname of [appHostname, dbHostname].filter(Boolean) as string[]) {
    if (hostname.length > MAX_HOSTNAME_LENGTH) {
      throw new Error(
        `Generated hostname "${hostname}" exceeds the ${MAX_HOSTNAME_LENGTH} ` +
          `character limit. Use a shorter slug.`,
      );
    }
  }

  // Database wiring. `db`/`db` are literal - see note 3 above.
  const dbEnv: Record<string, string> = dbHostname
    ? {
        DB_HOST: dbHostname,
        DB_NAME: 'db',
        DB_USER: 'db',
        DB_PASS: `\${${dbHostname}_password}`,
        DATABASE_URL: `postgresql://db:\${${dbHostname}_password}@${dbHostname}:5432/db`,
      }
    : {};

  const services: Record<string, unknown>[] = [];

  if (dbHostname) {
    services.push({
      hostname: dbHostname,
      type: 'postgresql:single@16',
      mode: 'NON_HA',
      // Higher priority is created first, so the database exists before the
      // application attempts its first connection.
      priority: 10,
    });
  }

  services.push({
    hostname: appHostname,
    type: runtime,
    priority: 1,
    enableSubdomainAccess: true,
    buildFromGit: gitSource(spec.repo, spec.branch),
    zeropsSetup: setupName,
    zeropsYaml: {
      zerops: [
        {
          setup: setupName,
          build: {
            base: runtime,
            ...(spec.prepareCommands?.length
              ? { prepareCommands: spec.prepareCommands }
              : {}),
            buildCommands: spec.buildCommands ?? ['npm install'],
            deployFiles: spec.deployFiles ?? ['./'],
          },
          run: {
            base: runtime,
            ports: [{ port, httpSupport: true }],
            envVariables: {
              NODE_ENV: 'production',
              PORT: String(port),
              EPHEMERA_SLUG: slug,
              ...dbEnv,
              ...(spec.env ?? {}),
            },
            start: spec.startCommand ?? 'npm start',
          },
        },
      ],
    },
  });

  const importYaml = yaml.dump(
    { services },
    { lineWidth: -1, noRefs: true, quotingType: '"' },
  );

  return {
    slug,
    appHostname,
    dbHostname,
    port,
    url: publicUrlFor(appHostname, port, projectCode, region),
    importYaml,
  };
}
