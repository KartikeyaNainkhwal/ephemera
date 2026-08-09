import assert from 'node:assert/strict';
import { test } from 'node:test';

import { accruedCost, formatCost, hourlyCost } from './cost.js';

test('hourlyCost matches published Zerops rates', () => {
  // Per service: 1 shared core ($0.60/30d) + 0.25GB RAM ($0.75/30d) +
  // 1GB disk ($0.10/30d) = $1.45 / 720h.
  const perService = 1.45 / 720;
  assert.ok(Math.abs(hourlyCost(false) - perService) < 1e-9);
  assert.ok(Math.abs(hourlyCost(true) - 2 * perService) < 1e-9);
});

test('accruedCost integrates over the environment lifetime', () => {
  const created = new Date('2026-08-09T00:00:00Z');
  const destroyed = new Date('2026-08-09T01:00:00Z');
  assert.ok(Math.abs(accruedCost(created, destroyed, true) - hourlyCost(true)) < 1e-9);
});

test('accruedCost never goes negative on clock skew', () => {
  const created = new Date('2026-08-09T02:00:00Z');
  const destroyed = new Date('2026-08-09T01:00:00Z');
  assert.equal(accruedCost(created, destroyed, true), 0);
});

test('formatCost keeps sub-cent amounts visible', () => {
  assert.equal(formatCost(2), '$2.00');
  assert.equal(formatCost(0.5), '$0.500');
  assert.equal(formatCost(0.001), '$0.00100');
});
