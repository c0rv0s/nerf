export function damageMultiplierForPowerup(powerup) {
  if (powerup?.kind === 'gold') return 3;
  if (powerup?.kind === 'silver') return 2;
  return 1;
}

export function longShotAwardForDistance(distance) {
  const metres = Number(distance);
  if (!Number.isFinite(metres)) return null;
  if (metres >= 500) {
    return { key: 'deadEye500', title: '500M DEAD EYE', color: '#b57cff' };
  }
  if (metres >= 250) {
    return { key: 'longShot250', title: '250M LONG SHOT', color: '#54d9ff' };
  }
  return null;
}

export function resolveShieldedDamage(hp, shield, rawDamage, options = {}) {
  const damage = Math.max(0, Number(rawDamage) || 0);
  const currentHp = Math.max(0, Number(hp) || 0);
  const currentShield = Math.max(0, Number(shield) || 0);
  const absorbed = options.bypassShield ? 0 : Math.min(currentShield, damage);
  return {
    rawDamage: damage,
    absorbed,
    shield: currentShield - absorbed,
    hp: currentHp - (damage - absorbed),
  };
}
