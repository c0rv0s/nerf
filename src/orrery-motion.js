// Shared, deterministic clock for the moving observatory. Network clients
// sample world time rather than accumulating their own rotation.
export const ORRERY_DWELL = 6;
export const ORRERY_TRAVEL = 12;
export const ORRERY_QUARTER = ORRERY_DWELL + ORRERY_TRAVEL;
export const ORRERY_PERIOD = ORRERY_QUARTER * 4;
export function orreryPose(time) {
  const t = ((time % ORRERY_PERIOD) + ORRERY_PERIOD) % ORRERY_PERIOD;
  const quarter = Math.floor(t / ORRERY_QUARTER);
  const local = t - quarter * ORRERY_QUARTER;
  const u = Math.max(0, (local - ORRERY_DWELL) / ORRERY_TRAVEL);
  const blend = u * u * u * (10 + u * (-15 + u * 6));
  return {
    angle: ((quarter + blend) * Math.PI) / 2,
    moving: local > ORRERY_DWELL,
    eastWest: quarter % 2 === 0,
    seconds:
      local <= ORRERY_DWELL ? ORRERY_DWELL - local : ORRERY_QUARTER - local,
    angularSpeed:
      local <= ORRERY_DWELL
        ? 0
        : (30 * u * u * (u - 1) ** 2 * Math.PI) / (2 * ORRERY_TRAVEL),
  };
}
export function orreryRideDelta(previousAngle, nextAngle) {
  const d = nextAngle - previousAngle;
  return Math.atan2(Math.sin(d), Math.cos(d));
}
export function onOrreryDeck(position, angle, grounded, verticalVelocity = 0) {
  if (!grounded || verticalVelocity > 0.1 || Math.abs(position.y - 10) > 0.18)
    return false;
  const radius = Math.hypot(position.x, position.z);
  if (radius >= 24.1 && radius <= 30.9) return true;
  const c = Math.cos(angle),
    s = Math.sin(angle);
  const x = position.x * c + position.z * s;
  const z = -position.x * s + position.z * c;
  return (
    Math.abs(z) < 2.9 &&
    ((Math.abs(x) > 20.1 && Math.abs(x) < 24.2) ||
      (Math.abs(x) > 30.8 && Math.abs(x) < 42.9))
  );
}
