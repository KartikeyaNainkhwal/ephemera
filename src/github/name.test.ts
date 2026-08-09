import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normaliseRepoName } from './name.js';

test('accepts owner/name', () => {
  assert.equal(normaliseRepoName('Kartikeya/Portfolio'), 'Kartikeya/Portfolio');
});

test('accepts a pasted browser URL', () => {
  assert.equal(
    normaliseRepoName('https://github.com/KartikeyaNainkhwal/Portfolio'),
    'KartikeyaNainkhwal/Portfolio',
  );
});

test('accepts a clone URL and trailing slash', () => {
  assert.equal(normaliseRepoName('https://github.com/a/b.git'), 'a/b');
  assert.equal(normaliseRepoName('https://github.com/a/b/'), 'a/b');
});

test('rejects nonsense', () => {
  assert.throws(() => normaliseRepoName('not a repo'));
});
