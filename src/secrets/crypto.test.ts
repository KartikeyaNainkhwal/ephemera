process.env.EPHEMERA_SECRET_KEY = 'test-key-for-unit-tests-only';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decrypt, encrypt, mask } from './crypto.js';

test('a value survives a round trip', () => {
  const value = 'sk_live_abc123_a_real_looking_key';
  assert.equal(decrypt(encrypt(value)), value);
});

test('encryption is non-deterministic', () => {
  // A fresh IV each time: identical secrets must not produce identical
  // ciphertext, or the store leaks which repositories share a key.
  assert.notEqual(encrypt('same'), encrypt('same'));
});

test('unicode and empty values are handled', () => {
  for (const value of ['', 'héllo → wörld ✅', 'x'.repeat(5000)]) {
    assert.equal(decrypt(encrypt(value)), value);
  }
});

test('tampered ciphertext is rejected, not silently accepted', () => {
  const payload = encrypt('secret');
  const parts = payload.split(':');
  const data = Buffer.from(parts[3]!, 'base64');
  data[0] = data[0]! ^ 0xff;
  parts[3] = data.toString('base64');
  assert.throws(() => decrypt(parts.join(':')));
});

test('a malformed payload is rejected', () => {
  assert.throws(() => decrypt('not-a-secret'));
  assert.throws(() => decrypt('v9:a:b:c'));
});

test('masking never reveals a short secret', () => {
  assert.equal(mask('short'), '••••••••');
  assert.equal(mask('12345678'), '••••••••');
  const masked = mask('sk_live_1234567890');
  assert.ok(masked.startsWith('sk'));
  assert.ok(masked.endsWith('90'));
  assert.ok(!masked.includes('live_12345'));
});
