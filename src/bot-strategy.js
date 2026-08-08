// Pure decision helpers for bots. Keeping these free of rendering/physics
// dependencies makes the strategic layer deterministic and easy to test.

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function effectiveHealth(character) {
  return Math.max(0, Number(character?.hp) || 0) + Math.max(0, Number(character?.shield) || 0);
}

export function combatTargetScore(bot, enemy, distance, options = {}) {
  const myScore = Math.max(0, Number(bot?.score) || 0);
  const enemyScore = Math.max(0, Number(enemy?.score) || 0);
  const scoreLead = enemyScore - myScore;
  const health = effectiveHealth(enemy);

  // Leaders are worth pursuing because their death drops the richest point
  // orb. Hurt opponents are sensible finishes; distance still matters enough
  // that bots do not cross the whole arena for every scoreboard change.
  let score = 72 - Math.max(0, distance) * 1.25;
  score += clamp(scoreLead / 22, -18, 62);
  score += clamp((100 - health) * 0.42, -24, 38);
  if (options.isLeader) score += 30;
  if (options.isCurrent) score += 16;
  if (options.isAttacker) score += 34;
  if (enemy?.powerup?.kind === 'gold') score -= 16;
  else if (enemy?.powerup?.kind === 'silver') score -= 8;
  return score;
}

export function pickupUtility(bot, def, distance, context = {}) {
  const kind = def?.kind;
  const d = Math.max(2, Number(distance) || 0);
  const hp = Math.max(0, Number(bot?.hp) || 0);
  const shield = Math.max(0, Number(bot?.shield) || 0);
  const scoreGap = Math.max(0, Number(context.leaderScore) - (Number(bot?.score) || 0));
  let value = 0;

  if (kind === 'points') value = 115 + (Number(def.amount) || 250) * 0.16 + Math.min(45, scoreGap / 45);
  else if (kind === 'gold') value = bot?.powerup?.kind === 'gold' ? 0 : 190;
  else if (kind === 'silver') value = bot?.powerup ? 0 : 135;
  else if (kind === 'health') value = hp >= 100 ? 0 : 45 + (100 - hp) * 2.25;
  else if (kind === 'shield') value = shield >= 75 ? 0 : 70 + (75 - shield) * 1.45;
  else if (kind === 'speed') value = bot?.speedMult > 1 ? 0 : 92;
  else if (kind === 'jetpack') value = bot?.jetpack ? 0 : 78;
  else if (kind === 'weapon' || kind === 'drop') {
    const weapon = def.weapon;
    const ammo = Math.max(0, Number(bot?.ammo?.[weapon]) || 0);
    value = ammo > 0 ? (kind === 'drop' ? 58 : 24) : 112;
  } else if (kind === 'ammo') {
    const weapon = def.weapon;
    if (!bot?.weapons?.[weapon]) return -Infinity;
    const ammo = Math.max(0, Number(bot?.ammo?.[weapon]) || 0);
    const pickupAmmo = Math.max(1, Number(context.weaponPickupAmmo?.[weapon]) || 1);
    const cap = pickupAmmo * 3;
    value = ammo >= cap ? 0 : 44 + (1 - ammo / cap) * 68;
  }

  if (value <= 0) return -Infinity;
  return value - d * 1.7;
}

export function chooseCombatIntent(bot, target, loot, context = {}) {
  const health = effectiveHealth(bot);
  const targetHealth = effectiveHealth(target);
  const leaderScore = Math.max(0, Number(context.leaderScore) || 0);
  const score = Math.max(0, Number(bot?.score) || 0);
  const gap = leaderScore - score;
  const lootKind = loot?.def?.kind;
  const sustain = lootKind === 'health' || lootKind === 'shield';
  const points = lootKind === 'points';

  if (sustain && (health < 90 || bot?.hp < 58)) return 'recover';
  if (points && (context.lootUtility || 0) >= 85 && (health >= 58 || !target)) return 'loot';
  if (!target) return loot ? 'loot' : 'roam';
  if (health < 48 && targetHealth > 55) return sustain ? 'recover' : 'evade';
  if (score >= leaderScore && leaderScore > 0 && health < 82 && targetHealth > 45) return 'evade';
  if (gap >= 1200 || targetHealth < 45) return 'engage';
  if (loot && (context.lootUtility || 0) >= 125) return 'loot';
  return 'engage';
}
