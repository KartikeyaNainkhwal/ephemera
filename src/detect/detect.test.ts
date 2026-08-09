import assert from 'node:assert/strict';
import { test } from 'node:test';

import { detect, usesDocker } from './detect.js';

test('Next.js is detected from its dependency', () => {
  const plan = detect({
    files: ['package.json', 'next.config.js'],
    packageJson: { dependencies: { next: '14' }, scripts: { build: 'next build', start: 'next start' } },
  });
  assert.equal(plan.framework, 'Next.js');
  assert.equal(plan.startCommand, 'npm start');
  assert.equal(plan.withDatabase, true);
  assert.equal(plan.confidence, 'high');
});

test('Vite builds to dist and is served statically', () => {
  const plan = detect({
    files: ['package.json', 'vite.config.ts', 'index.html'],
    packageJson: { devDependencies: { vite: '5' }, scripts: { build: 'vite build' } },
  });
  assert.equal(plan.framework, 'Vite');
  assert.ok(plan.startCommand.includes('dist'));
  // A static bundle has nothing to talk to a database with.
  assert.equal(plan.withDatabase, false);
});

test('Create React App builds to build/', () => {
  const plan = detect({
    files: ['package.json'],
    packageJson: { dependencies: { 'react-scripts': '5' }, scripts: { build: 'react-scripts build' } },
  });
  assert.equal(plan.framework, 'Create React App');
  assert.ok(plan.startCommand.includes('build'));
});

test('a plain HTML site with no tooling is served as-is', () => {
  const plan = detect({ files: ['index.html', 'styles.css', 'script.js'], packageJson: null });
  assert.equal(plan.framework, 'Static site');
  assert.equal(plan.withDatabase, false);
  assert.equal(plan.confidence, 'high');
  assert.ok(plan.buildCommands.some((c) => c.includes('serve')));
});

test('a Node server is detected from its start script', () => {
  const plan = detect({
    files: ['package.json', 'server.js'],
    packageJson: { scripts: { start: 'node server.js' } },
  });
  assert.equal(plan.framework, 'Node.js');
  assert.equal(plan.startCommand, 'npm start');
});

test('the lockfile selects the package manager', () => {
  const withPnpm = detect({
    files: ['package.json', 'pnpm-lock.yaml'],
    packageJson: { scripts: { start: 'node .' } },
  });
  assert.ok(withPnpm.buildCommands[0]!.includes('pnpm'));

  const withNpmLock = detect({
    files: ['package.json', 'package-lock.json'],
    packageJson: { scripts: { start: 'node .' } },
  });
  assert.equal(withNpmLock.buildCommands[0], 'npm ci');

  const withYarn = detect({
    files: ['package.json', 'yarn.lock'],
    packageJson: { scripts: { start: 'node .' } },
  });
  assert.equal(withYarn.buildCommands[0], 'yarn install');
});

test('Django is detected from manage.py alongside requirements', () => {
  const plan = detect({ files: ['requirements.txt', 'manage.py'], packageJson: null });
  assert.equal(plan.framework, 'Django');
  assert.equal(plan.runtime, 'python@3.12');
  assert.equal(plan.port, 8000);
});

test('Go is detected from go.mod', () => {
  const plan = detect({ files: ['go.mod', 'main.go'], packageJson: null });
  assert.equal(plan.framework, 'Go');
  assert.equal(plan.runtime, 'go@1.22');
});

test('an unrecognised repository yields an editable plan, never an error', () => {
  const plan = detect({ files: ['README.md'], packageJson: null });
  assert.equal(plan.framework, 'Unknown');
  assert.equal(plan.confidence, 'low');
  // The reason must tell the user what to do next.
  assert.ok(plan.reason.toLowerCase().includes('edit'));
});

test('every plan is directly usable - no empty commands', () => {
  const cases = [
    { files: ['index.html'], packageJson: null },
    { files: ['go.mod'], packageJson: null },
    { files: ['README.md'], packageJson: null },
    { files: ['package.json'], packageJson: { dependencies: { next: '14' } } },
  ];
  for (const signals of cases) {
    const plan = detect(signals);
    assert.ok(plan.startCommand.length > 0, 'start command must be present');
    assert.ok(plan.buildCommands.every((c) => c.length > 0));
    assert.ok(plan.port > 0 && plan.port < 65_536);
    assert.ok(plan.reason.length > 0);
  }
});

test('Docker repositories are recognised so they can be flagged', () => {
  assert.equal(usesDocker(['Dockerfile', 'src']), true);
  assert.equal(usesDocker(['docker-compose.yml']), true);
  assert.equal(usesDocker(['package.json']), false);
});
