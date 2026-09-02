import assert from 'node:assert/strict';
import test from 'node:test';

import {
  damageMultiplierForPowerup, longShotAwardForDistance, resolveShieldedDamage,
} from '../src/combat.js';

test('Hyperstrike headshot damage kills through a full shield', () => {
  assert.deepEqual(resolveShieldedDamage(100, 75, 175), {
    rawDamage: 175,
    absorbed: 75,
    shield: 0,
    hp: 0,
  });
});

test('shield absorbs damage first without changing the displayed raw damage', () => {
  assert.deepEqual(resolveShieldedDamage(100, 75, 68), {
    rawDamage: 68,
    absorbed: 68,
    shield: 7,
    hp: 100,
  });
});

test('drowning damage bypasses shield and goes straight to health', () => {
  assert.deepEqual(resolveShieldedDamage(100, 75, 5, { bypassShield: true }), {
    rawDamage: 5,
    absorbed: 0,
    shield: 75,
    hp: 95,
  });
});

test('Silver and Gold produce their authoritative damage multipliers', () => {
  assert.equal(damageMultiplierForPowerup({ kind: 'silver' }), 2);
  assert.equal(damageMultiplierForPowerup({ kind: 'gold' }), 3);
  assert.equal(damageMultiplierForPowerup(null), 1);
});

test('long-shot awards use inclusive 100m, 250m, and 500m tiers', () => {
  assert.equal(longShotAwardForDistance(99.99), null);
  assert.deepEqual(longShotAwardForDistance(100), {
    key: 'longShot100', title: '100M LONG SHOT', color: '#8ef7a8',
  });
  assert.deepEqual(longShotAwardForDistance(249.99), {
    key: 'longShot100', title: '100M LONG SHOT', color: '#8ef7a8',
  });
  assert.deepEqual(longShotAwardForDistance(250), {
    key: 'longShot250', title: '250M LONG SHOT', color: '#54d9ff',
  });
  assert.deepEqual(longShotAwardForDistance(499.99), {
    key: 'longShot250', title: '250M LONG SHOT', color: '#54d9ff',
  });
  assert.deepEqual(longShotAwardForDistance(500), {
    key: 'deadEye500', title: '500M DEAD EYE', color: '#b57cff',
  });
});
