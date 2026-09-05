// Similarity coordinates for Infinite Bloom. The view and locomotion must
// shrink by the same ratio, otherwise the seam changes apparent walking speed.
export const BLOOM_INNER_HALF = 7;
export const BLOOM_OUTER_HALF = 36;
export const BLOOM_RATIO = BLOOM_OUTER_HALF / BLOOM_INNER_HALF;
export const bloomNorm = (p) =>
  Math.max(Math.abs(p.x), Math.abs(p.y), Math.abs(p.z));
export function bloomScale(p) {
  const t = Math.max(0, Math.min(1, (bloomNorm(p) - BLOOM_INNER_HALF) / 8));
  return 1 / BLOOM_RATIO + (1 - 1 / BLOOM_RATIO) * t * t * (3 - 2 * t);
}
export function bloomCrossing(previous, current) {
  const a = bloomNorm(previous),
    b = bloomNorm(current);
  if (a >= BLOOM_INNER_HALF && b < BLOOM_INNER_HALF) return BLOOM_RATIO;
  if (a <= BLOOM_OUTER_HALF && b > BLOOM_OUTER_HALF) return 1 / BLOOM_RATIO;
  return 1;
}
function cubeInterval(origin, direction, half) {
  let enter = -Infinity,
    exit = Infinity;
  for (const axis of ["x", "y", "z"]) {
    if (Math.abs(direction[axis]) < 1e-10) {
      if (Math.abs(origin[axis]) > half) return null;
      continue;
    }
    let a = (-half - origin[axis]) / direction[axis],
      b = (half - origin[axis]) / direction[axis];
    if (a > b) [a, b] = [b, a];
    enter = Math.max(enter, a);
    exit = Math.min(exit, b);
    if (enter > exit) return null;
  }
  return { enter, exit };
}
export function bloomRayBoundary(origin, direction, maxDistance = Infinity) {
  const norm = bloomNorm(origin),
    epsilon = 1e-8;
  if (norm < BLOOM_INNER_HALF - epsilon)
    return { distance: 0, factor: BLOOM_RATIO };
  if (norm > BLOOM_OUTER_HALF + epsilon)
    return { distance: 0, factor: 1 / BLOOM_RATIO };
  const candidates = [],
    inner = cubeInterval(origin, direction, BLOOM_INNER_HALF),
    outer = cubeInterval(origin, direction, BLOOM_OUTER_HALF);
  if (inner && inner.enter >= -epsilon && inner.enter <= maxDistance)
    candidates.push({
      distance: Math.max(0, inner.enter),
      factor: BLOOM_RATIO,
    });
  if (outer && outer.exit >= -epsilon && outer.exit <= maxDistance)
    candidates.push({
      distance: Math.max(0, outer.exit),
      factor: 1 / BLOOM_RATIO,
    });
  return candidates.sort((a, b) => a.distance - b.distance)[0] || null;
}
