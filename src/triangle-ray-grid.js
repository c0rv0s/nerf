// Traverse the existing X/Z triangle index for hitscan and grapple rays.
// Collision triangles are stored in every cell their bounds touch. Visiting
// both side cells at corner crossings also preserves exact tangent hits.
let queryStamp = 0;
const EMPTY = Object.freeze([]);

export function rayBoundsInterval(
  origin,
  direction,
  bounds,
  maxDistance = Infinity,
) {
  let near = 0;
  let far = maxDistance;
  for (const axis of ["x", "y", "z"]) {
    const velocity = direction[axis];
    if (velocity === 0) {
      if (origin[axis] < bounds.min[axis] || origin[axis] > bounds.max[axis])
        return null;
      continue;
    }
    const a = (bounds.min[axis] - origin[axis]) / velocity;
    const b = (bounds.max[axis] - origin[axis]) / velocity;
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
    if (near > far) return null;
  }
  return far >= 0 ? { near, far } : null;
}

export function rayTriangleCandidates(
  collider,
  origin,
  direction,
  maxDistance = Infinity,
) {
  const interval = rayBoundsInterval(origin, direction, collider, maxDistance);
  if (!interval) return EMPTY;
  const size = collider.triangleCellSize;
  if (!collider.triangleCells || !size) return collider.triangles;
  const result = (collider._triangleRayQuery ||= []);
  result.length = 0;
  const stamp = ++queryStamp;
  const addCell = (x, z) => {
    for (const entry of collider.triangleCells.get(`${x},${z}`) || EMPTY) {
      if (entry._triangleRayStamp === stamp) continue;
      entry._triangleRayStamp = stamp;
      result.push(entry);
    }
  };
  let x = Math.floor((origin.x + direction.x * interval.near) / size);
  let z = Math.floor((origin.z + direction.z * interval.near) / size);
  const sx = Math.sign(direction.x),
    sz = Math.sign(direction.z);
  const dx = sx ? size / Math.abs(direction.x) : Infinity;
  const dz = sz ? size / Math.abs(direction.z) : Infinity;
  let nextX = sx
    ? ((x + (sx > 0 ? 1 : 0)) * size - origin.x) / direction.x
    : Infinity;
  let nextZ = sz
    ? ((z + (sz > 0 ? 1 : 0)) * size - origin.z) / direction.z
    : Infinity;
  for (;;) {
    addCell(x, z);
    const next = Math.min(nextX, nextZ);
    if (!Number.isFinite(next) || next > interval.far) break;
    if (Math.abs(nextX - nextZ) < 1e-9) {
      addCell(x + sx, z);
      addCell(x, z + sz);
      x += sx;
      z += sz;
      nextX += dx;
      nextZ += dz;
    } else if (nextX < nextZ) {
      x += sx;
      nextX += dx;
    } else {
      z += sz;
      nextZ += dz;
    }
  }
  return result;
}
