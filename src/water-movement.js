export function waterSpeedMultiplier(character, water, eyeHeight = character.eyeHeight ?? 1.55) {
  if (!water) return 1;

  const waterDepth = water.surfaceY - character.pos.y;
  const fullyUnderwater = character.pos.y + eyeHeight < water.surfaceY - 0.1;
  if (fullyUnderwater) return 0.82;
  if (waterDepth < character.height * 0.5) return 0.9;
  return 0.68;
}

export function waterVerticalInput(keys, world, hasGrapple = false) {
  if (keys?.Space) return 'up';
  const shiftHeld = !!(keys?.ShiftLeft || keys?.ShiftRight);
  if (!shiftHeld) return 'neutral';

  // Shift belongs to these map-specific abilities before it belongs to
  // swimming: mounted Red Rock gallop, and an equipped Canopy grapple.
  if (world?.mounted) return 'neutral';
  if (world?.grappleEnabled && hasGrapple) return 'neutral';
  return 'down';
}
