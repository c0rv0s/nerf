export function waterSpeedMultiplier(character, water, eyeHeight = character.eyeHeight ?? 1.55) {
  if (!water) return 1;

  const waterDepth = water.surfaceY - character.pos.y;
  const fullyUnderwater = character.pos.y + eyeHeight < water.surfaceY - 0.1;
  if (fullyUnderwater) return 0.82;
  if (waterDepth < character.height * 0.5) return 0.9;
  return 0.68;
}
