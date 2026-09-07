import test from 'node:test';
import assert from 'node:assert/strict';
import { vrStick, readVRButtons, snapTurn, boundedVRMuzzle } from '../src/vr-input.js';

test('Touch uses thumbstick axes 2/3, with deadzone and safe disconnect', () => {
  assert.deepEqual(vrStick({ axes: [1, 1, -0.8, 0.6] }), {x:-0.8,y:0.6});
  assert.deepEqual(vrStick({ axes: [0, 0, 0.12, -0.17] }), {x:0,y:0});
  assert.deepEqual(vrStick(), {x:0,y:0});
  assert.deepEqual(vrStick({ axes: [NaN, Infinity] }), {x:0,y:0});
});

test('snap turn fires once per deflection and rearms only near center', () => {
  const first = snapTurn(0.9, false);
  assert.equal(first.radians, -Math.PI/6);
  assert.equal(snapTurn(0.9, first.latched).radians, 0);
  assert.equal(snapTurn(-0.9, first.latched).radians, 0);
  assert.equal(snapTurn(0.4, first.latched).latched, true);
  const released = snapTurn(0, first.latched);
  assert.equal(released.latched, false);
  assert.equal(snapTurn(-0.9, released.latched).radians, Math.PI/6);
});

test('Touch trigger, squeeze, and face buttons remain separate', () => {
  const buttons = Array.from({length:6}, (_,i) => ({pressed: i===0 || i===5}));
  assert.deepEqual(readVRButtons({buttons}), {fire:true,grip:false,jump:false,secondary:true});
  assert.deepEqual(readVRButtons(), {fire:false,grip:false,jump:false,secondary:false});
});

test('multiplayer VR muzzle rejects malformed input and bounds physical reach', () => {
  for (const bad of [null, {}, {x:NaN,y:0,z:0}, {x:0,y:Infinity,z:0}, {x:'1',y:0,z:0}]) {
    assert.equal(boundedVRMuzzle(bad), null);
  }
  assert.deepEqual(boundedVRMuzzle({x:0.2,y:-0.5,z:-0.4}), {x:0.2,y:-0.5,z:-0.4});
  const clamped = boundedVRMuzzle({x:30,y:40,z:0});
  assert.ok(Math.abs(Math.hypot(clamped.x,clamped.y,clamped.z)-1.5)<1e-10);
});
