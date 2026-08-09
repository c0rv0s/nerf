import test from 'node:test';
import assert from 'node:assert/strict';
import { stickVector } from '../src/mobile-controls.js';

test('stickVector maps the four screen directions to movement axes', () => {
  assert.deepEqual(stickVector(100, 100, 100, 42), {
    strafe: 0,
    forward: 1,
    knobX: 0,
    knobY: -58,
  });
  assert.deepEqual(stickVector(100, 100, 158, 100), {
    strafe: 1,
    forward: 0,
    knobX: 58,
    knobY: 0,
  });
});

test('stickVector preserves analog strength and applies a center dead zone', () => {
  const centered = stickVector(50, 50, 53, 53);
  assert.equal(centered.strafe, 0);
  assert.equal(centered.forward, 0);

  const partial = stickVector(0, 0, 29, 0);
  assert.ok(partial.strafe > 0.4 && partial.strafe < 0.5);
  assert.equal(partial.forward, 0);
  assert.equal(partial.knobX, 29);
});

test('stickVector clamps movement strength while keeping a bounded knob', () => {
  const vector = stickVector(0, 0, 300, 400);
  assert.equal(Math.hypot(vector.strafe, vector.forward), 1);
  assert.ok(Math.abs(Math.hypot(vector.knobX, vector.knobY) - 58) < 1e-9);
});
