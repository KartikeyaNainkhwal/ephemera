/**
 * Source deployment.
 *
 * Zerops' `buildFromGit` reads build instructions from a `zerops.yaml`
 * committed in the repository root - the import YAML cannot supply them. A
 * repository without that file produces a service that is created but never
 * built, with no error surfaced.
 *
 * Requiring every user to commit a config file is the wrong product, so
 * Ephemera does the build itself: download the repository archive at an exact
 * commit, write a generated `zerops.yml` *outside* the working tree, and hand
 * both to `zcli push --zerops-yaml-path`.
 *
 * Three things fall out of this that `buildFromGit` could not do:
 *   - repositories need no Ephemera-specific files at all;
 *   - private repositories work, because the archive is fetched with a token;
 *   - the archive is pinned to a commit SHA, so there is no cache race with a
 *     branch reference that has just moved.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { promisify } from 'node:util';

import yaml from 'js-yaml';

import { config } from '../config.js';
import { ensureLogin, zcli } from './cli.js';

const execFileAsync = promisify(execFile);

export interface DeploySpec {
  /** Zerops service hostname to deploy into. */
  hostname: string;
  /** Repository as `owner/name`. */
  repo: string;
  /** Commit SHA or ref to deploy. A SHA is strongly preferred. */
  ref: string;
  /** The generated zerops.yml, as an object. */
  zeropsYaml: Record<string, unknown>;
}

/**
 * Fetch, unpack, and push a repository. Everything happens inside a temporary
 * directory that is always removed, including on failure.
 */
export async function deployFromRepo(spec: DeploySpec): Promise<void> {
  await ensureLogin();

  const workspace = await mkdtemp(join(tmpdir(), 'ephemera-src-'));
  const archive = join(workspace, 'source.tar.gz');
  const sourceDir = join(workspace, 'src');
  const configPath = join(workspace, 'zerops.generated.yml');

  try {
    await download(spec.repo, spec.ref, archive);

    await execFileAsync('mkdir', ['-p', sourceDir]);
    // GitHub archives nest everything under a single generated directory.
    await execFileAsync('tar', ['-xzf', archive, '-C', sourceDir, '--strip-components=1'], {
      maxBuffer: 8 * 1024 * 1024,
    });

    await writeFile(
      configPath,
      yaml.dump(spec.zeropsYaml, { lineWidth: -1, noRefs: true }),
      'utf8',
    );

    await execFileAsync(
      zcli().command,
      [
        ...zcli().prefix,
        'service',
        'push',
        spec.hostname,
        '--project-id',
        config.zerops.projectId,
        '--setup',
        'app',
        // The archive has no .git directory, so the whole working directory is
        // uploaded as-is rather than resolved against a git workspace state.
        '--no-git',
        '--working-dir',
        sourceDir,
        '--zerops-yaml-path',
        configPath,
        '--disable-logs',
      ],
      { timeout: 20 * 60_000, maxBuffer: 16 * 1024 * 1024 },
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function download(repo: string, ref: string, destination: string): Promise<void> {
  const url = `https://api.github.com/repos/${repo}/tarball/${ref}`;
  const response = await fetch(url, {
    headers: {
      ...(config.github.token ? { Authorization: `Bearer ${config.github.token}` } : {}),
      Accept: 'application/vnd.github+json',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok || !response.body) {
    throw new Error(
      `Could not download ${repo}@${ref} from GitHub (HTTP ${response.status}). ` +
        'Check that the repository is reachable with the configured token.',
    );
  }

  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destination));
}
