/**
 * Validation for environment-creation requests.
 *
 * Pure and dependency-free so it is trivially unit-testable. Returns every
 * problem at once rather than failing on the first - an API that reports one
 * error per attempt is miserable to script against.
 */

export interface CreateRequest {
  slug: string;
  repo: string;
  branch?: string;
  runtime?: string;
  port?: number;
  withDatabase?: boolean;
  prepareCommands?: string[];
  buildCommands?: string[];
  deployFiles?: string[];
  startCommand?: string;
  env?: Record<string, string>;
  ttlMinutes?: number;
  title?: string;
}

export const TTL_MIN_MINUTES = 5;
export const TTL_MAX_MINUTES = 20_160; // 14 days

const REPO_URL = /^https:\/\/[a-z0-9.-]+\/[\w.~%/-]+$/i;
const BRANCH = /^[\w][\w./+-]{0,200}$/;
const RUNTIME = /^[a-z][a-z-]*@[a-z0-9.-]+$/i;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Variables Ephemera wires itself. Letting a caller override these produces
 * an environment that builds, boots, and cannot reach its own database -
 * the most confusing failure mode there is, so it is rejected up front.
 */
const RESERVED_ENV = new Set([
  'DB_HOST',
  'DB_NAME',
  'DB_USER',
  'DB_PASS',
  'DB_PORT',
  'DATABASE_URL',
  'PORT',
  'NODE_ENV',
  'EPHEMERA_SLUG',
]);

export type ValidationResult =
  | { ok: true; value: CreateRequest }
  | { ok: false; errors: string[] };

function stringArray(
  value: unknown,
  name: string,
  errors: string[],
): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > 30 ||
    value.some(
      (item) => typeof item !== 'string' || item.length === 0 || item.length > 1_000,
    )
  ) {
    errors.push(`"${name}" must be an array of up to 30 non-empty strings.`);
    return undefined;
  }
  return value as string[];
}

export function validateCreate(body: unknown): ValidationResult {
  const errors: string[] = [];
  const input = (typeof body === 'object' && body !== null ? body : {}) as Record<
    string,
    unknown
  >;

  const slug = typeof input.slug === 'string' ? input.slug.trim() : '';
  if (!slug || slug.length > 100) {
    errors.push('"slug" is required: a short name using lowercase letters and digits.');
  }

  const repo = typeof input.repo === 'string' ? input.repo.trim() : '';
  if (!repo) {
    errors.push('"repo" is required: a public https git URL.');
  } else if (repo.length > 300 || !REPO_URL.test(repo)) {
    errors.push(
      '"repo" must be a public https URL such as https://github.com/owner/name. ' +
        'SSH URLs are not supported.',
    );
  }

  let branch: string | undefined;
  if (input.branch !== undefined) {
    if (typeof input.branch !== 'string' || !BRANCH.test(input.branch)) {
      errors.push('"branch" contains characters that are not allowed in a git ref.');
    } else {
      branch = input.branch;
    }
  }

  let runtime: string | undefined;
  if (input.runtime !== undefined) {
    if (typeof input.runtime !== 'string' || !RUNTIME.test(input.runtime)) {
      errors.push('"runtime" must look like nodejs@22, python@3.12 or go@1.22.');
    } else {
      runtime = input.runtime;
    }
  }

  let port: number | undefined;
  if (input.port !== undefined) {
    if (
      typeof input.port !== 'number' ||
      !Number.isInteger(input.port) ||
      input.port < 1 ||
      input.port > 65_535
    ) {
      errors.push('"port" must be an integer between 1 and 65535.');
    } else {
      port = input.port;
    }
  }

  let withDatabase: boolean | undefined;
  if (input.withDatabase !== undefined) {
    if (typeof input.withDatabase !== 'boolean') {
      errors.push('"withDatabase" must be true or false.');
    } else {
      withDatabase = input.withDatabase;
    }
  }

  let ttlMinutes: number | undefined;
  if (input.ttlMinutes !== undefined) {
    if (
      typeof input.ttlMinutes !== 'number' ||
      !Number.isInteger(input.ttlMinutes) ||
      input.ttlMinutes < TTL_MIN_MINUTES ||
      input.ttlMinutes > TTL_MAX_MINUTES
    ) {
      errors.push(
        `"ttlMinutes" must be an integer between ${TTL_MIN_MINUTES} and ${TTL_MAX_MINUTES}.`,
      );
    } else {
      ttlMinutes = input.ttlMinutes;
    }
  }

  let title: string | undefined;
  if (input.title !== undefined) {
    if (typeof input.title !== 'string' || input.title.length > 200) {
      errors.push('"title" must be a string of at most 200 characters.');
    } else {
      title = input.title.trim() || undefined;
    }
  }

  let startCommand: string | undefined;
  if (input.startCommand !== undefined) {
    if (
      typeof input.startCommand !== 'string' ||
      input.startCommand.length === 0 ||
      input.startCommand.length > 500
    ) {
      errors.push('"startCommand" must be a non-empty string of at most 500 characters.');
    } else {
      startCommand = input.startCommand;
    }
  }

  const prepareCommands = stringArray(input.prepareCommands, 'prepareCommands', errors);
  const buildCommands = stringArray(input.buildCommands, 'buildCommands', errors);
  const deployFiles = stringArray(input.deployFiles, 'deployFiles', errors);

  let env: Record<string, string> | undefined;
  if (input.env !== undefined) {
    if (typeof input.env !== 'object' || input.env === null || Array.isArray(input.env)) {
      errors.push('"env" must be an object mapping variable names to string values.');
    } else {
      const entries = Object.entries(input.env as Record<string, unknown>);
      const before = errors.length;
      if (entries.length > 40) errors.push('"env" supports at most 40 variables.');
      for (const [key, value] of entries) {
        if (!ENV_KEY.test(key) || key.length > 64) {
          errors.push(`env key "${key}" is not a valid variable name.`);
        } else if (/^ZEROPS_/i.test(key)) {
          errors.push(
            `env key "${key}" is not allowed: Zerops reserves the ZEROPS_ prefix ` +
              'and rejects the deployment.',
          );
        } else if (RESERVED_ENV.has(key)) {
          errors.push(
            `env key "${key}" is reserved: Ephemera wires it automatically to the ` +
              "environment's own database and runtime.",
          );
        } else if (typeof value !== 'string' || value.length > 2_000) {
          errors.push(`env value for "${key}" must be a string of at most 2000 characters.`);
        }
      }
      if (errors.length === before) env = input.env as Record<string, string>;
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      slug,
      repo,
      branch,
      runtime,
      port,
      withDatabase,
      prepareCommands,
      buildCommands,
      deployFiles,
      startCommand,
      env,
      ttlMinutes,
      title,
    },
  };
}
