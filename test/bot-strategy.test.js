import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chooseCombatIntent,
  combatTargetScore,
  pickupUtility,
} from '../src/bot-strategy.js';
import { weaponShotCooldown } from '../src/weapon-cadence.js';

const bot = (extra = {}) => ({
  hp: 100, shield: 0, score: 1000, weapons: { blaster: true, pulsar: true },
  ammo: { blaster: Infinity, pulsar: 0 }, speedMult: 1, ...extra,
});

test('bots prefer a nearby leader over an equally healthy low scorer', () => {
  const self = bot();
  const leader = { hp: 100, shield: 0, score: 5000 };
  const trailer = { hp: 100, shield: 0, score: 300 };
  assert.ok(
    combatTargetScore(self, leader, 24, { isLeader: true }) >
    combatTargetScore(self, trailer, 15),
  );
});

test('low health makes reachable sustain more valuable than ordinary loot', () => {
  const self = bot({ hp: 28 });
  const context = { leaderScore: 3000, weaponPickupAmmo: { pulsar: 60 } };
  const health = pickupUtility(self, { kind: 'health' }, 22, context);
  const ammo = pickupUtility(self, { kind: 'ammo', weapon: 'pulsar' }, 10, context);
  assert.ok(health > ammo);
});

test('bots seek ammo for owned dry weapons but ignore ammo for unowned weapons', () => {
  const self = bot();
  const context = { leaderScore: 1000, weaponPickupAmmo: { pulsar: 60, hyper: 5 } };
  assert.ok(pickupUtility(self, { kind: 'ammo', weapon: 'pulsar' }, 12, context) > 0);
  assert.equal(pickupUtility(self, { kind: 'ammo', weapon: 'hyper' }, 2, context), -Infinity);
});

test('bots value the second Secret Shot only until dual wield is equipped', () => {
  const pickup = { kind: 'dual-blaster' };
  const context = { leaderScore: 1000 };
  assert.ok(pickupUtility(bot({ dualBlaster: false }), pickup, 12, context) > 0);
  assert.equal(pickupUtility(bot({ dualBlaster: true }), pickup, 12, context), -Infinity);
});

test('a healthy trailing bot attacks while a hurt leader preserves its life', () => {
  const enemy = { hp: 100, shield: 0 };
  assert.equal(chooseCombatIntent(bot({ score: 500 }), enemy, null, { leaderScore: 4000 }), 'engage');
  assert.equal(chooseCombatIntent(bot({ hp: 45, score: 4000 }), enemy, null, { leaderScore: 4000 }), 'evade');
});

test('bot weapon cooldown preserves each weapon fire rate', () => {
  const secretShot = weaponShotCooldown(3.2, 1, 0.1);
  const pulsator = weaponShotCooldown(9, 1, 0.1);
  assert.ok(pulsator < secretShot / 2);
  assert.equal(weaponShotCooldown(3.2, 2, 0), 1 / 6.4);
});
