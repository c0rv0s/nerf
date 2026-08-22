import test from 'node:test';
import assert from 'node:assert/strict';
import { waterSpeedMultiplier } from '../src/water-movement.js';

const characterAt = (y) => ({
  pos: { y },
  height: 1.8,
  eyeHeight: 1.6,
});
const water = { surfaceY: 1 };

test('water below knee height only slows movement by 10%', () => {
  assert.equal(waterSpeedMultiplier(characterAt(0.11), water), 0.9);
});

test('knee-deep and deeper wading slows movement by 32%', () => {
  assert.equal(waterSpeedMultiplier(characterAt(0.1), water), 0.68);
  assert.equal(waterSpeedMultiplier(characterAt(-0.5), water), 0.68);
});

test('fully underwater swimming only slows movement by 18%', () => {
  assert.equal(waterSpeedMultiplier(characterAt(-0.71), water), 0.82);
});

test('movement outside water is unchanged', () => {
  assert.equal(waterSpeedMultiplier(characterAt(0), null), 1);
});
