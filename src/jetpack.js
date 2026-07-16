// Shared death-bound jetpack state so players and bots obey identical fuel,
// cooldown, and thrust rules.
export const JETPACK_FUEL_SECONDS = 8;
export const JETPACK_COOLDOWN_SECONDS = 4;
export const JETPACK_MAX_RISE_SPEED = 12;
export const JETPACK_THRUST = 40;

export function createJetpack() {
  return { fuel: JETPACK_FUEL_SECONDS, cooldown: 0, active: false };
}

export function stepJetpack(pack, velocity, dt, wantsThrust) {
  if (!pack) return false;

  if (pack.cooldown > 0) {
    pack.cooldown = Math.max(0, pack.cooldown - dt);
    pack.active = false;
    if (pack.cooldown <= 1e-6) {
      pack.cooldown = 0;
      pack.fuel = JETPACK_FUEL_SECONDS;
    }
    return false;
  }

  if (!wantsThrust || pack.fuel <= 0) {
    pack.active = false;
    return false;
  }

  pack.active = true;
  velocity.y = Math.min(JETPACK_MAX_RISE_SPEED, velocity.y + JETPACK_THRUST * dt);
  pack.fuel = Math.max(0, pack.fuel - dt);
  if (pack.fuel <= 1e-6) {
    pack.fuel = 0;
    pack.active = false;
    pack.cooldown = JETPACK_COOLDOWN_SECONDS;
  }
  return pack.active;
}
