import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TOAD_EFFECT_LOCKOUT,
  shuffledToadPersonalities,
  queueToadEffect,
  updateToadEffects,
} from '../src/toad-effects.js';

test('toad personalities form a balanced deterministic shuffle', () => {
  const first = shuffledToadPersonalities(18, 12345);
  const repeat = shuffledToadPersonalities(18, 12345);
  const nextMatch = shuffledToadPersonalities(18, 67890);
  assert.deepEqual(first, repeat);
  assert.notDeepEqual(first, nextMatch);
  assert.deepEqual(
    Object.fromEntries(['normal', 'poison', 'hallucinogenic'].map(type => [
      type,
      first.filter(personality => personality === type).length,
    ])),
    { normal: 6, poison: 6, hallucinogenic: 6 },
  );
});

test('normal toads do nothing and matching effects cannot stack', () => {
  assert.equal(TOAD_EFFECT_LOCKOUT, 20);
  const effects = [];
  assert.equal(queueToadEffect(effects, 'normal'), false);
  assert.equal(queueToadEffect(effects, 'poison'), true);
  assert.equal(queueToadEffect(effects, 'poison'), false);
  assert.equal(effects.length, 1);
});

test('poison waits three seconds then deals four five-damage ticks', () => {
  const effects = [];
  const starts = [];
  const damage = [];
  queueToadEffect(effects, 'poison');
  updateToadEffects(effects, 2.99, {
    onStart: type => starts.push(type),
    onPoisonTick: amount => damage.push(amount),
  });
  assert.deepEqual(starts, []);
  assert.deepEqual(damage, []);

  updateToadEffects(effects, 0.01, {
    onStart: type => starts.push(type),
    onPoisonTick: amount => damage.push(amount),
  });
  assert.deepEqual(starts, ['poison']);
  assert.deepEqual(damage, [5]);

  updateToadEffects(effects, 3, { onPoisonTick: amount => damage.push(amount) });
  assert.deepEqual(damage, [5, 5, 5, 5]);
  updateToadEffects(effects, 1);
  assert.equal(effects.length, 0);
});

test('hallucination starts after three seconds and lasts ten seconds', () => {
  const effects = [];
  queueToadEffect(effects, 'hallucinogenic');
  assert.equal(updateToadEffects(effects, 2.9).hallucinating, false);
  const start = updateToadEffects(effects, 0.1);
  assert.equal(start.hallucinating, true);
  assert.ok(start.hallucinationStrength < 1e-9);
  assert.ok(Math.abs(updateToadEffects(effects, 0.5).hallucinationStrength - 0.5) < 1e-9);
  assert.equal(updateToadEffects(effects, 0.5).hallucinationStrength, 1);
  assert.equal(updateToadEffects(effects, 8).hallucinationStrength, 1);
  assert.ok(Math.abs(updateToadEffects(effects, 0.5).hallucinationStrength - 0.5) < 1e-9);
  assert.equal(updateToadEffects(effects, 0.5).hallucinating, false);
  assert.equal(effects.length, 0);
});
