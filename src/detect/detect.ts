/**
 * Framework detection.
 *
 * Given a repository's root file listing and its package.json, infer how to
 * build and run it. Pure and dependency-free, so the whole matrix is unit
 * testable without touching the network.
 *
 * The design follows what every zero-config platform converged on: **detect,
 * propose, let the human correct**. Detection is never treated as authority -
 * every plan is returned with a confidence and a human-readable reason, shown
 * in the UI for confirmation before it is saved. A repository we cannot place
 * yields a `generic` plan rather than a failure, because an editable wrong
 * guess is far more useful than an error.
 */

export type Confidence = 'high' | 'medium' | 'low';

export interface BuildPlan {
  /** Human-facing name, e.g. "Next.js" or "Static site". */
  framework: string;
  /** Zerops runtime service type. */
  runtime: string;
  /** Port the application will listen on. */
  port: number;
  prepareCommands?: string[];
  buildCommands: string[];
  startCommand: string;
  deployFiles: string[];
  /** Whether a PostgreSQL service should accompany it. */
  withDatabase: boolean;
  confidence: Confidence;
  /** Why this was chosen - shown to the user verbatim. */
  reason: string;
}

export interface RepoSignals {
  /** File and directory names in the repository root. */
  files: string[];
  /** Parsed package.json, when present. */
  packageJson?: {
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    main?: string;
  } | null;
}

const NODE = 'nodejs@22';

/** A static file server, installed at build time so no repo change is needed. */
const SERVE_INSTALL = 'npm install --no-save serve@14';
const serveDir = (dir: string, port: number) =>
  `./node_modules/.bin/serve --no-clipboard --single --listen ${port} ${dir}`;

function has(files: string[], ...names: string[]): boolean {
  const lower = new Set(files.map((f) => f.toLowerCase()));
  return names.some((n) => lower.has(n.toLowerCase()));
}

function dep(signals: RepoSignals, name: string): boolean {
  const pkg = signals.packageJson;
  if (!pkg) return false;
  return Boolean(pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]);
}

function script(signals: RepoSignals, name: string): string | undefined {
  return signals.packageJson?.scripts?.[name];
}

/**
 * Node projects that build to a static directory are served by `serve` rather
 * than by their own dev server - a preview must run the production output.
 */
function staticBuildPlan(
  framework: string,
  outDir: string,
  signals: RepoSignals,
  reason: string,
): BuildPlan {
  const port = 3000;
  return {
    framework,
    runtime: NODE,
    port,
    buildCommands: [
      installCommand(signals),
      script(signals, 'build') ? 'npm run build' : `echo "no build script"`,
      SERVE_INSTALL,
    ],
    startCommand: serveDir(outDir, port),
    deployFiles: ['./'],
    withDatabase: false,
    confidence: 'high',
    reason,
  };
}

function installCommand(signals: RepoSignals): string {
  const files = signals.files;
  if (has(files, 'pnpm-lock.yaml')) return 'npm install -g pnpm && pnpm install';
  if (has(files, 'yarn.lock')) return 'yarn install';
  if (has(files, 'bun.lockb')) return 'npm install -g bun && bun install';
  if (has(files, 'package-lock.json')) return 'npm ci';
  return 'npm install';
}

export function detect(signals: RepoSignals): BuildPlan {
  const { files } = signals;

  // ── Node ecosystem ──────────────────────────────────────────────────────
  if (signals.packageJson) {
    const install = installCommand(signals);

    if (dep(signals, 'next')) {
      return {
        framework: 'Next.js',
        runtime: NODE,
        port: 3000,
        buildCommands: [install, 'npm run build'],
        startCommand: 'npm start',
        deployFiles: ['./'],
        withDatabase: true,
        confidence: 'high',
        reason: 'Found "next" in package.json dependencies.',
      };
    }

    if (dep(signals, 'nuxt') || dep(signals, 'nuxt3')) {
      return {
        framework: 'Nuxt',
        runtime: NODE,
        port: 3000,
        buildCommands: [install, 'npm run build'],
        startCommand: 'node .output/server/index.mjs',
        deployFiles: ['./'],
        withDatabase: true,
        confidence: 'high',
        reason: 'Found "nuxt" in package.json dependencies.',
      };
    }

    if (dep(signals, '@sveltejs/kit')) {
      return {
        framework: 'SvelteKit',
        runtime: NODE,
        port: 3000,
        buildCommands: [install, 'npm run build'],
        startCommand: 'node build',
        deployFiles: ['./'],
        withDatabase: true,
        confidence: 'medium',
        reason:
          'Found "@sveltejs/kit". Assumes adapter-node; adjust the start command for a different adapter.',
      };
    }

    if (dep(signals, 'astro')) {
      return staticBuildPlan(
        'Astro',
        'dist',
        signals,
        'Found "astro". Serving the static build output from dist/.',
      );
    }

    if (dep(signals, 'vite')) {
      return staticBuildPlan(
        'Vite',
        'dist',
        signals,
        'Found "vite". Serving the production build from dist/.',
      );
    }

    if (dep(signals, 'react-scripts')) {
      return staticBuildPlan(
        'Create React App',
        'build',
        signals,
        'Found "react-scripts". Serving the production build from build/.',
      );
    }

    // A server-shaped Node app: it has something to start.
    const start = script(signals, 'start');
    if (start) {
      return {
        framework: 'Node.js',
        runtime: NODE,
        port: 3000,
        buildCommands: script(signals, 'build') ? [install, 'npm run build'] : [install],
        startCommand: 'npm start',
        deployFiles: ['./'],
        withDatabase: true,
        confidence: 'medium',
        reason: 'package.json defines a "start" script.',
      };
    }

    const entry = signals.packageJson.main;
    if (entry) {
      return {
        framework: 'Node.js',
        runtime: NODE,
        port: 3000,
        buildCommands: [install],
        startCommand: `node ${entry}`,
        deployFiles: ['./'],
        withDatabase: true,
        confidence: 'low',
        reason: `No "start" script; falling back to the "main" entry point (${entry}).`,
      };
    }
  }

  // ── Python ──────────────────────────────────────────────────────────────
  if (has(files, 'requirements.txt', 'pyproject.toml', 'Pipfile')) {
    const install = has(files, 'requirements.txt')
      ? 'pip install -r requirements.txt'
      : 'pip install .';
    const django = has(files, 'manage.py');
    return {
      framework: django ? 'Django' : 'Python',
      runtime: 'python@3.12',
      port: 8000,
      buildCommands: [install, 'pip install gunicorn'],
      startCommand: django
        ? 'gunicorn --bind 0.0.0.0:8000 $(ls */wsgi.py | head -1 | cut -d/ -f1).wsgi:application'
        : 'gunicorn --bind 0.0.0.0:8000 app:app',
      deployFiles: ['./'],
      withDatabase: true,
      confidence: django ? 'medium' : 'low',
      reason: django
        ? 'Found manage.py and Python dependencies - assuming a Django project served by gunicorn.'
        : 'Found Python dependencies. Assumes a WSGI app exposed as app:app; edit the start command if not.',
    };
  }

  // ── Go ──────────────────────────────────────────────────────────────────
  if (has(files, 'go.mod')) {
    return {
      framework: 'Go',
      runtime: 'go@1.22',
      port: 8080,
      buildCommands: ['go build -o app .'],
      startCommand: './app',
      deployFiles: ['./app'],
      withDatabase: true,
      confidence: 'medium',
      reason: 'Found go.mod. Builds the module root into ./app.',
    };
  }

  // ── Plain static site ───────────────────────────────────────────────────
  if (has(files, 'index.html')) {
    const port = 3000;
    return {
      framework: 'Static site',
      runtime: NODE,
      port,
      buildCommands: [SERVE_INSTALL],
      startCommand: serveDir('.', port),
      deployFiles: ['./'],
      withDatabase: false,
      confidence: 'high',
      reason: 'Found index.html with no build tooling - serving the files as they are.',
    };
  }

  // ── Unknown ─────────────────────────────────────────────────────────────
  return {
    framework: 'Unknown',
    runtime: NODE,
    port: 3000,
    buildCommands: ['npm install'],
    startCommand: 'npm start',
    deployFiles: ['./'],
    withDatabase: true,
    confidence: 'low',
    reason:
      'Could not identify the stack. Edit the build and start commands below before connecting.',
  };
}

/** Docker-based repositories are worth flagging explicitly rather than guessing around. */
export function usesDocker(files: string[]): boolean {
  return has(files, 'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yaml');
}
