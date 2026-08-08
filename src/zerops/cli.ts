/**
 * Thin wrapper around `zcli`, which owns every *mutating* operation.
 *
 * Zerops does not document a REST endpoint for Import YAML, so service
 * creation and deletion go through the CLI. Reads (status, URLs, build state)
 * use the REST API instead - see `client.ts`.
 *
 * Every invocation is non-interactive: `zcli` refuses some commands without an
 * explicit `--project-id`, and deletion requires `--confirm`.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { config } from '../config.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

/**
 * Resolve how to invoke zcli.
 *
 * The npm package's `bin` entry is `bin/zcli.js`, a small Node launcher that
 * selects the correct platform binary at runtime - not an executable itself.
 * Invoking it through the current Node binary avoids depending on the shebang,
 * on file permissions surviving the deploy, or on anything being on PATH.
 */
function zcliInvocation(): { command: string; prefix: string[] } {
  try {
    const launcher = require.resolve('@zerops/zcli/bin/zcli.js');
    return { command: process.execPath, prefix: [launcher] };
  } catch {
    // Fall back to a globally installed zcli (useful in local development).
    return { command: 'zcli', prefix: [] };
  }
}

let loginPromise: Promise<void> | null = null;

/**
 * Authenticate once per process. `zcli login` writes a credentials file, so
 * repeating it on every call would be wasteful and racy.
 */
export function ensureLogin(): Promise<void> {
  loginPromise ??= (async () => {
    await run(['login', config.zerops.token], { redactArgs: true });
  })();
  return loginPromise;
}

interface RunOptions {
  /** Suppress argument echoing when a secret is present. */
  redactArgs?: boolean;
  timeoutMs?: number;
}

export interface CliResult {
  stdout: string;
  stderr: string;
  durationMs: number;
}

async function run(args: string[], options: RunOptions = {}): Promise<CliResult> {
  const started = Date.now();
  const { command, prefix } = zcliInvocation();
  try {
    const { stdout, stderr } = await execFileAsync(command, [...prefix, ...args], {
      timeout: options.timeoutMs ?? 15 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env },
    });
    return { stdout, stderr, durationMs: Date.now() - started };
  } catch (error) {
    const shown = options.redactArgs ? args[0] : args.join(' ');
    const detail =
      error instanceof Error && 'stderr' in error
        ? String((error as { stderr?: string }).stderr ?? error.message)
        : String(error);
    throw new Error(`zcli ${shown} failed: ${detail.trim()}`);
  }
}

/**
 * Create services from an Import YAML document inside the host project.
 *
 * Returns once Zerops has accepted and queued the work. The services are not
 * yet serving traffic at this point - poll readiness separately.
 */
export async function serviceImport(importYaml: string): Promise<CliResult> {
  await ensureLogin();

  const dir = await mkdtemp(join(tmpdir(), 'ephemera-'));
  const file = join(dir, 'import.yml');
  try {
    await writeFile(file, importYaml, 'utf8');
    return await run([
      'project',
      'service-import',
      file,
      '--project-id',
      config.zerops.projectId,
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Destroy a single service by hostname. Idempotent from our perspective. */
export async function serviceDelete(hostname: string): Promise<CliResult> {
  if (config.protectedHostnames.includes(hostname)) {
    throw new Error(
      `Refusing to delete protected service "${hostname}". ` +
        `Protected hostnames are configured via PROTECTED_HOSTNAMES.`,
    );
  }
  await ensureLogin();
  return run([
    'service',
    'delete',
    hostname,
    '--project-id',
    config.zerops.projectId,
    '--confirm',
  ]);
}
