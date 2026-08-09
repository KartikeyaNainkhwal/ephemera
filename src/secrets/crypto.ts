/**
 * Secret encryption at rest.
 *
 * Secrets are stored encrypted in Ephemera's own database with AES-256-GCM,
 * so a database dump alone does not disclose them. The key is derived with
 * scrypt from `EPHEMERA_SECRET_KEY` (falling back to the admin key, so an
 * existing deployment keeps working), never stored, and never logged.
 *
 * GCM is authenticated: a tampered ciphertext fails to decrypt rather than
 * silently yielding garbage that would be injected into someone's build.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
/** Fixed salt: the derived key must be stable across restarts. */
const SALT = 'ephemera-secrets-v1';

let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (cachedKey) return cachedKey;
  const material =
    process.env.EPHEMERA_SECRET_KEY?.trim() || process.env.EPHEMERA_API_KEY?.trim();
  if (!material) {
    throw new Error(
      'Cannot encrypt secrets: set EPHEMERA_SECRET_KEY (or EPHEMERA_API_KEY) on the control plane.',
    );
  }
  cachedKey = scryptSync(material, SALT, 32);
  return cachedKey;
}

/** Encrypt a value into a self-describing, versioned string. */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/** Decrypt a value produced by `encrypt`. Throws if it has been tampered with. */
export function decrypt(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Stored secret is not in a recognised format.');
  }
  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * A hint that lets a human recognise which value is stored without revealing
 * it. Short values are shown entirely as dots - a four-character secret must
 * not leak half of itself to the UI.
 */
export function mask(plaintext: string): string {
  if (plaintext.length <= 8) return '••••••••';
  return `${plaintext.slice(0, 2)}••••••${plaintext.slice(-2)}`;
}

/** Constant-time equality, for comparing a supplied value against a stored one. */
export function sameSecret(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
