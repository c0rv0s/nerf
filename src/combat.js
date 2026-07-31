export function damageMultiplierForPowerup(powerup) {
  if (powerup?.kind === 'gold') return 3;
  if (powerup?.kind === 'silver') return 2;
  return 1;
}

export function resolveShieldedDamage(hp, shield, rawDamage) {
  const damage = Math.max(0, Number(rawDamage) || 0);
  const currentHp = Math.max(0, Number(hp) || 0);
  const currentShield = Math.max(0, Number(shield) || 0);
  const absorbed = Math.min(currentShield, damage);
  return {
    rawDamage: damage,
    absorbed,
    shield: currentShield - absorbed,
    hp: currentHp - (damage - absorbed),
  };
}
