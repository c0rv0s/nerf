// Shared mounted proportions. Longer legs raise the whole horse/rider stack by
// the added length while preserving the original hoof contact with the ground.
export const HORSE_LEG_BASE_HEIGHT = 1.18;
export const HORSE_LEG_HEIGHT_SCALE = 1.3;
export const HORSE_LEG_HEIGHT = HORSE_LEG_BASE_HEIGHT * HORSE_LEG_HEIGHT_SCALE;
export const HORSE_HEIGHT_DELTA = HORSE_LEG_HEIGHT - HORSE_LEG_BASE_HEIGHT;
