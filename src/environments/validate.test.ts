import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateCreate } from './validate.js';

test('a minimal valid request passes', () => {
  const result = validateCreate({ slug: 'demo', repo: 'https://github.com/x/y' });
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.value.slug, 'demo');
    assert.equal(result.value.repo, 'https://github.com/x/y');
  }
});

test('a missing repo is reported', () => {
  const result = validateCreate({ slug: 'demo' });
  assert.ok(!result.ok);
  if (!result.ok) assert.ok(result.errors.some((e) => e.includes('"repo"')));
});

test('SSH remotes are rejected with an explanation', () => {
  const result = validateCreate({ slug: 'demo', repo: 'git@github.com:x/y.git' });
  assert.ok(!result.ok);
  if (!result.ok) assert.ok(result.errors.some((e) => e.includes('https')));
});

test('ZEROPS_-prefixed env vars are rejected before the platform rejects the deploy', () => {
  const result = validateCreate({
    slug: 'demo',
    repo: 'https://github.com/x/y',
    env: { ZEROPS_THING: 'x' },
  });
  assert.ok(!result.ok);
  if (!result.ok) assert.ok(result.errors.some((e) => e.includes('ZEROPS_')));
});

test('env vars Ephemera wires itself cannot be overridden', () => {
  const result = validateCreate({
    slug: 'demo',
    repo: 'https://github.com/x/y',
    env: { DB_HOST: 'elsewhere' },
  });
  assert.ok(!result.ok);
  if (!result.ok) assert.ok(result.errors.some((e) => e.includes('reserved')));
});

test('out-of-range ports and TTLs are rejected', () => {
  const result = validateCreate({
    slug: 'demo',
    repo: 'https://github.com/x/y',
    port: 70_000,
    ttlMinutes: 9_999_999,
  });
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.ok(result.errors.some((e) => e.includes('"port"')));
    assert.ok(result.errors.some((e) => e.includes('"ttlMinutes"')));
  }
});

test('branch names with spaces are rejected', () => {
  const result = validateCreate({
    slug: 'demo',
    repo: 'https://github.com/x/y',
    branch: 'feat x',
  });
  assert.ok(!result.ok);
});

test('every problem is reported at once, not one per attempt', () => {
  const result = validateCreate({ port: -1 });
  assert.ok(!result.ok);
  if (!result.ok) assert.ok(result.errors.length >= 3);
});
