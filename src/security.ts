/**
 * API authentication and rate limiting.
 *
 * Ephemera v1 is deliberately single-tenant: one deployment, one Zerops
 * project, one admin key. The key protects every mutating endpoint. Reads
 * default to public - the dashboard doubles as a status page - and can be
 * locked down with EPHEMERA_PUBLIC_READS=false.
 *
 * Multi-user GitHub OAuth is a roadmap item, deliberately not a half-shipped
 * one: a partially built login flow is strictly worse than an honest key.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import { config } from './config.js';

/** Constant-time comparison that tolerates different input lengths. */
function equal(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function isAuthorised(request: FastifyRequest): boolean {
  const key = config.security.apiKey;
  if (!key) return true; // open mode - warned about loudly at boot
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  return equal(header.slice('Bearer '.length).trim(), key);
}

/** Guard for mutating endpoints. Sends the 401 itself; returns false to abort. */
export function requireKey(request: FastifyRequest, reply: FastifyReply): boolean {
  if (isAuthorised(request)) return true;
  reply.code(401).send({
    error:
      'Authentication required. Send "Authorization: Bearer <EPHEMERA_API_KEY>". ' +
      'The key is configured on the control plane service.',
  });
  return false;
}

/** Guard for read endpoints - public unless EPHEMERA_PUBLIC_READS=false. */
export function requireRead(request: FastifyRequest, reply: FastifyReply): boolean {
  if (config.security.publicReads) return true;
  return requireKey(request, reply);
}

/**
 * Fixed-window rate limiter for mutating endpoints, keyed by client IP.
 *
 * In-memory is the correct scope here: the control plane is a single
 * instance, and the limiter exists to stop accidental loops and casual
 * abuse from burning infrastructure credits - not to survive a distributed
 * attack, which the capacity cap already bounds.
 */
const buckets = new Map<string, { count: number; reset: number }>();

export function allowMutation(ip: string): boolean {
  const now = Date.now();
  if (buckets.size > 5_000) {
    for (const [key, bucket] of buckets) {
      if (now > bucket.reset) buckets.delete(key);
    }
  }
  const bucket = buckets.get(ip);
  if (!bucket || now > bucket.reset) {
    buckets.set(ip, { count: 1, reset: now + config.limits.rateWindowMs });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= config.limits.mutationsPerWindow;
}
