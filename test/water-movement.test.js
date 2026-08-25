import test from 'node:test';
import assert from 'node:assert/strict';
import { waterSpeedMultiplier, waterVerticalInput } from '../src/water-movement.js';

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

test('Space swims up and Shift dives in ordinary underwater movement', () => {
  assert.equal(waterVerticalInput({ Space: true }, {}, false), 'up');
  assert.equal(waterVerticalInput({ ShiftLeft: true }, {}, false), 'down');
  assert.equal(waterVerticalInput({ ShiftRight: true }, {}, false), 'down');
  assert.equal(waterVerticalInput({}, {}, false), 'neutral');
});

test('Space wins when swim-up and dive are pressed together', () => {
  assert.equal(waterVerticalInput({ Space: true, ShiftLeft: true }, {}, false), 'up');
});

test('Red Rock gallop reserves Shift instead of diving', () => {
  assert.equal(waterVerticalInput({ ShiftLeft: true }, { mounted: true }, false), 'neutral');
});

test('an equipped Canopy grapple reserves Shift, but an unequipped one does not', () => {
  const canopy = { grappleEnabled: true };
  assert.equal(waterVerticalInput({ ShiftLeft: true }, canopy, true), 'neutral');
  assert.equal(waterVerticalInput({ ShiftLeft: true }, canopy, false), 'down');
});
