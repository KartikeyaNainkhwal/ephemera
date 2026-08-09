import assert from 'node:assert/strict';
import { test } from 'node:test';

import yaml from 'js-yaml';

import { buildEnvironment, gitSource, publicUrlFor, sanitiseSlug } from './manifest.js';

test('sanitiseSlug strips everything a Zerops hostname rejects', () => {
  assert.equal(sanitiseSlug('Feature/Green-Theme'), 'featuregreentheme');
  assert.equal(sanitiseSlug('my_branch.name'), 'mybranchname');
});

test('sanitiseSlug prefixes a leading digit', () => {
  assert.ok(sanitiseSlug('42fix').startsWith('e42'));
});

test('sanitiseSlug rejects input with no legal characters', () => {
  assert.throws(() => sanitiseSlug('___...!!!'));
});

test('sanitiseSlug leaves room for the api/db suffixes', () => {
  const slug = sanitiseSlug('a'.repeat(60));
  assert.ok(slug.length + 'api'.length <= 25);
  assert.ok(slug.length + 'db'.length <= 25);
});

test('gitSource strips a trailing .git before appending the branch', () => {
  // A trailing .git is accepted by the import but the build silently never
  // starts - this exact bug shipped once. Never again.
  assert.equal(
    gitSource('https://github.com/a/b.git', 'feature/x'),
    'https://github.com/a/b@feature/x',
  );
  assert.equal(gitSource('https://github.com/a/b'), 'https://github.com/a/b');
  assert.equal(gitSource('https://github.com/a/b.git'), 'https://github.com/a/b');
});

test('publicUrlFor matches the Zerops subdomain format', () => {
  assert.equal(
    publicUrlFor('pr42api', 3000, '2c46', 'prg1'),
    'https://pr42api-2c46-3000.prg1.zerops.app',
  );
});

test('buildEnvironment produces the import shape Zerops actually accepts', () => {
  const resolved = buildEnvironment(
    { slug: 'pr42', repo: 'https://github.com/x/y.git', branch: 'main' },
    '2c46',
    'prg1',
  );

  assert.equal(resolved.appHostname, 'pr42api');
  assert.equal(resolved.dbHostname, 'pr42db');
  assert.equal(resolved.url, 'https://pr42api-2c46-3000.prg1.zerops.app');

  const doc = yaml.load(resolved.importYaml) as {
    services: Array<Record<string, unknown>>;
  };
  assert.equal(doc.services.length, 2);

  const [db, app] = doc.services as [Record<string, unknown>, Record<string, unknown>];
  // Postgres carries the explicit single/ha discriminator - `postgresql@16` is invalid.
  assert.equal(db.type, 'postgresql:single@16');
  // The database must be created before the app tries its first connection.
  assert.ok((db.priority as number) > (app.priority as number));

  assert.equal(app.buildFromGit, 'https://github.com/x/y@main');
  assert.equal(app.enableSubdomainAccess, true);
  // zeropsYaml must be a nested object; a string fails the import parser.
  assert.equal(typeof app.zeropsYaml, 'object');

  const run = (app.zeropsYaml as { zerops: Array<{ run: { envVariables: Record<string, string> } }> })
    .zerops[0]!.run.envVariables;
  // A Zerops Postgres always exposes dbName/user as the literal "db".
  assert.equal(run.DB_NAME, 'db');
  assert.equal(run.DB_USER, 'db');
  assert.equal(run.DB_HOST, 'pr42db');
  assert.equal(run.DB_PASS, '${pr42db_password}');
});

test('buildEnvironment without a database produces one service and no DB wiring', () => {
  const resolved = buildEnvironment(
    { slug: 'solo', repo: 'https://github.com/x/y', withDatabase: false },
    '2c46',
    'prg1',
  );
  assert.equal(resolved.dbHostname, null);

  const doc = yaml.load(resolved.importYaml) as {
    services: Array<Record<string, unknown>>;
  };
  assert.equal(doc.services.length, 1);

  const run = (doc.services[0]!.zeropsYaml as {
    zerops: Array<{ run: { envVariables: Record<string, string> } }>;
  }).zerops[0]!.run.envVariables;
  assert.equal(run.DB_HOST, undefined);
});
