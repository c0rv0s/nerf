export function weaponShotCooldown(rof, cadence = 1, jitter = 0) {
  const shotsPerSecond = Math.max(0.01, Number(rof) * Math.max(0.01, Number(cadence)));
  return (1 / shotsPerSecond) * (1 + Math.max(0, Number(jitter) || 0));
}
