// Shared math + physics helpers. Colliders are AABB boxes, spheres, oriented
// ellipsoids, finite hollow-cylinder shells, and walkable ramps (heightfield strips).
import * as THREE from 'three';

export const rand = (a, b) => a + Math.random() * (b - a);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Most gameplay collision queries only need the handful of solids around a
// character or projectile.  Maps can contain hundreds of colliders, though,
// and both projectiles and bot line-of-sight ask this question many times per
// frame.  Index static colliders by X/Z cell once at map load; moving solids
// (doors and trains) stay in a tiny always-checked list so they cannot go stale
// as they move between cells.
export function buildCollisionIndex(world, cellSize = 16) {
  const columns = new Map();
  const dynamic = [];
  const add = (collider, minX, maxX, minZ, maxZ) => {
    const fromX = Math.floor(minX / cellSize), toX = Math.floor(maxX / cellSize);
    const fromZ = Math.floor(minZ / cellSize), toZ = Math.floor(maxZ / cellSize);
    for (let x = fromX; x <= toX; x++) {
      let column = columns.get(x);
      if (!column) columns.set(x, column = new Map());
      for (let z = fromZ; z <= toZ; z++) {
        let cell = column.get(z);
        if (!cell) column.set(z, cell = []);
        cell.push(collider);
      }
    }
  };

  for (const collider of world.colliders || []) {
    if (collider.dynamic) {
      dynamic.push(collider);
    } else if (collider.type === 'box') {
      add(collider, collider.min.x, collider.max.x, collider.min.z, collider.max.z);
    } else if (collider.type === 'sphere') {
      const r = collider.radius;
      add(collider, collider.center.x - r, collider.center.x + r,
        collider.center.z - r, collider.center.z + r);
    } else if (collider.type === 'ellipsoid') {
      // A rotated ellipsoid fits inside the sphere made from its longest axis.
      // The broad-phase can be conservative; the narrow-phase below follows
      // the actual orientation and all three radii.
      const r = Math.max(collider.radii.x, collider.radii.y, collider.radii.z);
      add(collider, collider.center.x - r, collider.center.x + r,
        collider.center.z - r, collider.center.z + r);
    } else if (collider.type === 'cylinderShell') {
      const axis = collider.axis || 'y';
      const extentX = axis === 'x' ? collider.halfLength : collider.outerRadius;
      const extentZ = axis === 'z' ? collider.halfLength : collider.outerRadius;
      add(collider, collider.center.x - extentX, collider.center.x + extentX,
        collider.center.z - extentZ, collider.center.z + extentZ);
    }
  }
  world.collisionIndex = {
    cellSize,
    columns,
    dynamic,
    colliderCount: world.colliders?.length || 0,
    query: [],
  };
}

function nearbyColliders(world, p, radius = 0) {
  let index = world.collisionIndex;
  // Doors arm after the waypoint graph is built. Rebuild once when a map adds
  // a collider outside the usual construction phase.
  if (!index || index.colliderCount !== (world.colliders?.length || 0)) {
    buildCollisionIndex(world);
    index = world.collisionIndex;
  }
  const out = index.query;
  out.length = 0;
  const stamp = ++collisionQueryStamp;
  const cellSize = index.cellSize;
  const fromX = Math.floor((p.x - radius) / cellSize);
  const toX = Math.floor((p.x + radius) / cellSize);
  const fromZ = Math.floor((p.z - radius) / cellSize);
  const toZ = Math.floor((p.z + radius) / cellSize);
  const addOnce = (collider) => {
    if (collider._collisionQueryStamp === stamp) return;
    collider._collisionQueryStamp = stamp;
    out.push(collider);
  };
  for (let x = fromX; x <= toX; x++) {
    const column = index.columns.get(x);
    if (!column) continue;
    for (let z = fromZ; z <= toZ; z++) {
      const cell = column.get(z);
      if (cell) for (const collider of cell) addOnce(collider);
    }
  }
  for (const collider of index.dynamic) addOnce(collider);
  return out;
}

const _v = new THREE.Vector3();
const _l = new THREE.Vector3();
const _cl = new THREE.Vector3();
const _ellipsoidLocal = new THREE.Vector3();
const _ellipsoidSurface = new THREE.Vector3();
const _ellipsoidDelta = new THREE.Vector3();
const _ellipsoidDirection = new THREE.Vector3();
const _ellipsoidHeightBase = new THREE.Vector3();
const _ellipsoidHeightAxis = new THREE.Vector3();
const _cylinderRadial = new THREE.Vector3();
const _cylinderPush = new THREE.Vector3();
let collisionQueryStamp = 0;

function ellipsoidInverseRotation(collider) {
  if (!collider.inverseRotation) {
    collider.inverseRotation = (collider.rotation || new THREE.Quaternion()).clone().invert();
  }
  return collider.inverseRotation;
}

// Find the closest point on an axis-aligned ellipsoid in collider-local space.
// Outside points use the exact Lagrange-multiplier solution. Inside points use
// the positive intersection along the local surface gradient, which is stable
// for the rare case where a fast movement substep begins inside the solid.
function closestPointOnEllipsoid(local, radii, target) {
  const ax = Math.max(1e-4, radii.x);
  const ay = Math.max(1e-4, radii.y);
  const az = Math.max(1e-4, radii.z);
  const ax2 = ax * ax, ay2 = ay * ay, az2 = az * az;
  const normalizedSq = local.x * local.x / ax2
    + local.y * local.y / ay2 + local.z * local.z / az2;
  if (normalizedSq <= 1) {
    _ellipsoidDirection.set(local.x / ax2, local.y / ay2, local.z / az2);
    if (_ellipsoidDirection.lengthSq() < 1e-12) {
      if (ax <= ay && ax <= az) _ellipsoidDirection.set(1, 0, 0);
      else if (ay <= az) _ellipsoidDirection.set(0, 1, 0);
      else _ellipsoidDirection.set(0, 0, 1);
    } else _ellipsoidDirection.normalize();
    const dx = _ellipsoidDirection.x, dy = _ellipsoidDirection.y, dz = _ellipsoidDirection.z;
    const qa = dx * dx / ax2 + dy * dy / ay2 + dz * dz / az2;
    const qb = 2 * (local.x * dx / ax2 + local.y * dy / ay2 + local.z * dz / az2);
    const qc = normalizedSq - 1;
    const t = (-qb + Math.sqrt(Math.max(0, qb * qb - 4 * qa * qc))) / (2 * qa);
    target.copy(local).addScaledVector(_ellipsoidDirection, t);
    return true;
  }

  const evaluate = lambda => {
    const x = ax * local.x / (lambda + ax2);
    const y = ay * local.y / (lambda + ay2);
    const z = az * local.z / (lambda + az2);
    return x * x + y * y + z * z;
  };
  let low = 0;
  let high = Math.max(ax2, ay2, az2);
  while (evaluate(high) > 1) high *= 2;
  for (let i = 0; i < 48; i++) {
    const mid = (low + high) / 2;
    if (evaluate(mid) > 1) low = mid;
    else high = mid;
  }
  const lambda = (low + high) / 2;
  target.set(
    ax2 * local.x / (lambda + ax2),
    ay2 * local.y / (lambda + ay2),
    az2 * local.z / (lambda + az2),
  );
  return false;
}

export function sphereHitsEllipsoid(pos, radius, collider) {
  const broadRadius = Math.max(collider.radii.x, collider.radii.y, collider.radii.z) + radius;
  if (pos.distanceToSquared(collider.center) > broadRadius * broadRadius) return false;
  _ellipsoidLocal.copy(pos).sub(collider.center).applyQuaternion(ellipsoidInverseRotation(collider));
  const inside = closestPointOnEllipsoid(_ellipsoidLocal, collider.radii, _ellipsoidSurface);
  if (inside) return true;
  return _ellipsoidLocal.distanceToSquared(_ellipsoidSurface) < radius * radius;
}

function resolveSphereEllipsoid(pos, radius, collider, out) {
  const broadRadius = Math.max(collider.radii.x, collider.radii.y, collider.radii.z) + radius;
  if (pos.distanceToSquared(collider.center) > broadRadius * broadRadius) return;
  _ellipsoidLocal.copy(pos).sub(collider.center).applyQuaternion(ellipsoidInverseRotation(collider));
  const inside = closestPointOnEllipsoid(_ellipsoidLocal, collider.radii, _ellipsoidSurface);
  if (inside) {
    _ellipsoidDelta.copy(_ellipsoidSurface).sub(_ellipsoidLocal);
    const distance = _ellipsoidDelta.length();
    if (distance < 1e-8) return;
    _ellipsoidDelta.multiplyScalar((distance + radius) / distance);
  } else {
    _ellipsoidDelta.copy(_ellipsoidLocal).sub(_ellipsoidSurface);
    const distance = _ellipsoidDelta.length();
    if (distance >= radius || distance < 1e-8) return;
    _ellipsoidDelta.multiplyScalar((radius - distance) / distance);
  }
  _ellipsoidDelta.applyQuaternion(collider.rotation || new THREE.Quaternion());
  pos.add(_ellipsoidDelta);
  out.hit = true;
  const length = _ellipsoidDelta.length();
  const nx = length > 1e-8 ? _ellipsoidDelta.x / length : 0;
  const ny = length > 1e-8 ? _ellipsoidDelta.y / length : 0;
  const nz = length > 1e-8 ? _ellipsoidDelta.z / length : 0;
  if (ny > out.ny) out.ny = ny;
  out.nx += nx;
  out.nz += nz;
}

// Highest world-space Y intersection at an X/Z sample. This lets navigation
// reason about footing on the same rotated shape used by movement collision.
export function ellipsoidSurfaceY(collider, x, z) {
  const inverse = ellipsoidInverseRotation(collider);
  _ellipsoidHeightBase.set(x - collider.center.x, 0, z - collider.center.z)
    .applyQuaternion(inverse);
  _ellipsoidHeightAxis.set(0, 1, 0).applyQuaternion(inverse);
  const rx2 = collider.radii.x * collider.radii.x;
  const ry2 = collider.radii.y * collider.radii.y;
  const rz2 = collider.radii.z * collider.radii.z;
  const qa = _ellipsoidHeightAxis.x ** 2 / rx2
    + _ellipsoidHeightAxis.y ** 2 / ry2 + _ellipsoidHeightAxis.z ** 2 / rz2;
  const qb = 2 * (
    _ellipsoidHeightBase.x * _ellipsoidHeightAxis.x / rx2
    + _ellipsoidHeightBase.y * _ellipsoidHeightAxis.y / ry2
    + _ellipsoidHeightBase.z * _ellipsoidHeightAxis.z / rz2
  );
  const qc = _ellipsoidHeightBase.x ** 2 / rx2
    + _ellipsoidHeightBase.y ** 2 / ry2 + _ellipsoidHeightBase.z ** 2 / rz2 - 1;
  const discriminant = qb * qb - 4 * qa * qc;
  if (discriminant < 0 || qa < 1e-12) return null;
  return collider.center.y + (-qb + Math.sqrt(discriminant)) / (2 * qa);
}

export function rayHitsEllipsoid(origin, direction, collider, maxDist = Infinity) {
  const inverse = ellipsoidInverseRotation(collider);
  const localOrigin = origin.clone().sub(collider.center).applyQuaternion(inverse);
  const localDirection = direction.clone().applyQuaternion(inverse);
  const scaledOrigin = localOrigin.clone().divide(collider.radii);
  const scaledDirection = localDirection.clone().divide(collider.radii);
  const qa = scaledDirection.lengthSq();
  const qb = 2 * scaledOrigin.dot(scaledDirection);
  const qc = scaledOrigin.lengthSq() - 1;
  const discriminant = qb * qb - 4 * qa * qc;
  if (discriminant < 0 || qa < 1e-12) return null;
  const root = Math.sqrt(discriminant);
  const near = (-qb - root) / (2 * qa);
  const far = (-qb + root) / (2 * qa);
  const t = near > 0.03 ? near : far;
  if (t <= 0.03 || t > maxDist) return null;
  const localPoint = localOrigin.addScaledVector(localDirection, t);
  const normal = new THREE.Vector3(
    localPoint.x / (collider.radii.x * collider.radii.x),
    localPoint.y / (collider.radii.y * collider.radii.y),
    localPoint.z / (collider.radii.z * collider.radii.z),
  ).applyQuaternion(collider.rotation || new THREE.Quaternion()).normalize();
  return { t, normal };
}

// Finite hollow cylinders are represented analytically instead of as a stack
// of boxes. The solid is the annular band between innerRadius and outerRadius,
// extruded along `axis`; both circular ends remain open through the bore.
export function sphereHitsCylinderShell(pos, radius, collider) {
  const axis = collider.axis || 'y';
  const along = pos[axis] - collider.center[axis];
  _cylinderRadial.copy(pos).sub(collider.center);
  _cylinderRadial[axis] = 0;
  const radial = _cylinderRadial.length();
  const alongGap = Math.max(Math.abs(along) - collider.halfLength, 0);
  let radialGap = 0;
  if (radial < collider.innerRadius) radialGap = collider.innerRadius - radial;
  else if (radial > collider.outerRadius) radialGap = radial - collider.outerRadius;
  if (alongGap === 0 && radialGap === 0) return true;
  return alongGap * alongGap + radialGap * radialGap < radius * radius;
}

function resolveSphereCylinderShell(pos, radius, collider, out) {
  const axis = collider.axis || 'y';
  const along = pos[axis] - collider.center[axis];
  _cylinderRadial.copy(pos).sub(collider.center);
  _cylinderRadial[axis] = 0;
  const radial = _cylinderRadial.length();
  const halfLength = collider.halfLength;
  const innerRadius = collider.innerRadius;
  const outerRadius = collider.outerRadius;
  const insideSolid = Math.abs(along) <= halfLength
    && radial >= innerRadius && radial <= outerRadius;

  _cylinderPush.set(0, 0, 0);
  if (insideSolid) {
    const exits = [
      [radial - innerRadius, 'inner'],
      [outerRadius - radial, 'outer'],
      [halfLength - along, 'positiveEnd'],
      [along + halfLength, 'negativeEnd'],
    ].sort((a, b) => a[0] - b[0]);
    const [distance, face] = exits[0];
    const push = distance + radius;
    if (face === 'positiveEnd') _cylinderPush[axis] = push;
    else if (face === 'negativeEnd') _cylinderPush[axis] = -push;
    else {
      if (radial > 1e-8) _cylinderPush.copy(_cylinderRadial).multiplyScalar(1 / radial);
      else {
        const radialAxis = axis === 'x' ? 'y' : 'x';
        _cylinderPush[radialAxis] = 1;
      }
      _cylinderPush.multiplyScalar(face === 'inner' ? -push : push);
    }
  } else {
    const closestAlong = clamp(along, -halfLength, halfLength);
    const closestRadial = clamp(radial, innerRadius, outerRadius);
    const alongDelta = along - closestAlong;
    const radialDelta = radial - closestRadial;
    const distance = Math.hypot(alongDelta, radialDelta);
    if (distance >= radius) return;
    if (radial > 1e-8) {
      _cylinderPush.copy(_cylinderRadial).multiplyScalar(radialDelta / radial);
    } else {
      const radialAxis = axis === 'x' ? 'y' : 'x';
      _cylinderPush[radialAxis] = radialDelta;
    }
    _cylinderPush[axis] = alongDelta;
    if (distance > 1e-8) _cylinderPush.multiplyScalar((radius - distance) / distance);
    else return;
  }

  pos.add(_cylinderPush);
  out.hit = true;
  const length = _cylinderPush.length();
  if (length < 1e-8) return;
  const nx = _cylinderPush.x / length;
  const ny = _cylinderPush.y / length;
  const nz = _cylinderPush.z / length;
  if (ny > out.ny) out.ny = ny;
  out.nx += nx;
  out.nz += nz;
}

export function rayHitsCylinderShell(origin, direction, collider, maxDist = Infinity) {
  const axis = collider.axis || 'y';
  const radialA = axis === 'x' ? 'y' : 'x';
  const radialB = axis === 'z' ? 'y' : 'z';
  const originAlong = origin[axis] - collider.center[axis];
  const originA = origin[radialA] - collider.center[radialA];
  const originB = origin[radialB] - collider.center[radialB];
  const directionAlong = direction[axis];
  const directionA = direction[radialA];
  const directionB = direction[radialB];
  const candidates = [];
  const addCandidate = (t, normal) => {
    if (t > 0.03 && t <= maxDist) candidates.push({ t, normal });
  };

  const qa = directionA * directionA + directionB * directionB;
  if (qa > 1e-12) {
    const qb = 2 * (originA * directionA + originB * directionB);
    for (const [shellRadius, normalSign] of [
      [collider.outerRadius, 1], [collider.innerRadius, -1],
    ]) {
      const qc = originA * originA + originB * originB - shellRadius * shellRadius;
      const discriminant = qb * qb - 4 * qa * qc;
      if (discriminant < 0) continue;
      const root = Math.sqrt(discriminant);
      for (const t of [(-qb - root) / (2 * qa), (-qb + root) / (2 * qa)]) {
        const along = originAlong + directionAlong * t;
        if (Math.abs(along) > collider.halfLength + 1e-6) continue;
        const normal = new THREE.Vector3();
        normal[radialA] = (originA + directionA * t) / shellRadius * normalSign;
        normal[radialB] = (originB + directionB * t) / shellRadius * normalSign;
        addCandidate(t, normal.normalize());
      }
    }
  }

  if (Math.abs(directionAlong) > 1e-12) {
    for (const sign of [-1, 1]) {
      const t = (sign * collider.halfLength - originAlong) / directionAlong;
      const radialAtA = originA + directionA * t;
      const radialAtB = originB + directionB * t;
      const radialAt = Math.hypot(radialAtA, radialAtB);
      if (radialAt < collider.innerRadius - 1e-6 ||
          radialAt > collider.outerRadius + 1e-6) continue;
      const normal = new THREE.Vector3();
      normal[axis] = sign;
      addCandidate(t, normal);
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.t - b.t);
  return candidates[0];
}

export function cylinderShellSurfaceY(collider, x, z) {
  const axis = collider.axis || 'y';
  if (axis === 'x') {
    if (Math.abs(x - collider.center.x) > collider.halfLength) return null;
    const cross = z - collider.center.z;
    if (Math.abs(cross) > collider.outerRadius) return null;
    return collider.center.y
      + Math.sqrt(collider.outerRadius * collider.outerRadius - cross * cross);
  }
  if (axis === 'z') {
    if (Math.abs(z - collider.center.z) > collider.halfLength) return null;
    const cross = x - collider.center.x;
    if (Math.abs(cross) > collider.outerRadius) return null;
    return collider.center.y
      + Math.sqrt(collider.outerRadius * collider.outerRadius - cross * cross);
  }
  const radial = Math.hypot(x - collider.center.x, z - collider.center.z);
  if (radial < collider.innerRadius || radial > collider.outerRadius) return null;
  return collider.center.y + collider.halfLength;
}

// Lazily build a ramp's oriented-box collider matching its visual slab.
function rampOBB(r) {
  if (!r._obb) {
    const len = r.axis === 'x' ? r.maxX - r.minX : r.maxZ - r.minZ;
    const width = r.axis === 'x' ? r.maxZ - r.minZ : r.maxX - r.minX;
    const dh = r.h1 - r.h0;
    const slopeLen = Math.hypot(len, dh);
    const ang = Math.atan2(dh, len);
    const halfThickness = 0.22;
    const rot = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(
      r.axis === 'z' ? -ang : 0, 0, r.axis === 'x' ? ang : 0));
    r._obb = {
      // Match the rendered slab's compensated center: the OBB top face is the
      // analytic ramp surface, including at a flush destination deck.
      c: new THREE.Vector3(
        (r.minX + r.maxX) / 2 + (r.axis === 'x' ? halfThickness * Math.sin(ang) : 0),
        (r.h0 + r.h1) / 2 - halfThickness * Math.cos(ang),
        (r.minZ + r.maxZ) / 2 + (r.axis === 'z' ? halfThickness * Math.sin(ang) : 0),
      ),
      rot, inv: rot.clone().invert(),
      // top face flush with the walk surface, bottom at the visual underside
      he: new THREE.Vector3(r.axis === 'x' ? slopeLen / 2 : width / 2, halfThickness,
                            r.axis === 'x' ? width / 2 : slopeLen / 2),
    };
  }
  return r._obb;
}

// Push a sphere out of a ramp's slab. Returns the world-space push normal y (or null).
function resolveSphereOBB(pos, radius, obb) {
  _l.copy(pos).sub(obb.c).applyMatrix4(obb.inv);
  _cl.set(
    clamp(_l.x, -obb.he.x, obb.he.x),
    clamp(_l.y, -obb.he.y, obb.he.y),
    clamp(_l.z, -obb.he.z, obb.he.z));
  _v.copy(_l).sub(_cl);
  const d2 = _v.lengthSq();
  if (d2 > radius * radius) return null;
  if (d2 > 1e-9) {
    const d = Math.sqrt(d2);
    _v.multiplyScalar((radius - d) / d).applyMatrix4(obb.rot);
  } else {
    // center inside the slab: exit through the nearest local face
    const exits = [
      [obb.he.x - _l.x, 1, 0, 0], [_l.x + obb.he.x, -1, 0, 0],
      [obb.he.y - _l.y, 0, 1, 0], [_l.y + obb.he.y, 0, -1, 0],
      [obb.he.z - _l.z, 0, 0, 1], [_l.z + obb.he.z, 0, 0, -1],
    ].sort((a, b) => a[0] - b[0]);
    const [dist, ex, ey, ez] = exits[0];
    _v.set(ex, ey, ez).multiplyScalar(dist + radius).applyMatrix4(obb.rot);
  }
  pos.add(_v);
  return _v.y / _v.length();
}

export function rampSurfaceY(r, x, z) {
  const t = r.axis === 'x'
    ? (x - r.minX) / (r.maxX - r.minX)
    : (z - r.minZ) / (r.maxZ - r.minZ);
  return r.h0 + (r.h1 - r.h0) * clamp(t, 0, 1);
}

// Shared 2D hazard containment. Most zones are inexpensive rectangles; maps
// that need a natural silhouette can provide an ordered `points: [[x,z], ...]`
// polygon and gameplay will follow the visible outline exactly.
export function pointInZoneXZ(zone, x, z) {
  if (!zone.points?.length) {
    return x >= zone.minX && x <= zone.maxX && z >= zone.minZ && z <= zone.maxZ;
  }
  const inPolygon = (points) => {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, zi] = points[i];
      const [xj, zj] = points[j];
      const crosses = (zi > z) !== (zj > z) &&
        x < ((xj - xi) * (z - zi)) / (zj - zi) + xi;
      if (crosses) inside = !inside;
    }
    return inside;
  };
  if (!inPolygon(zone.points)) return false;
  for (const hole of zone.holes || []) if (inPolygon(hole)) return false;
  return true;
}

function inRampFootprint(r, x, z, pad = 0) {
  return x >= r.minX - pad && x <= r.maxX + pad && z >= r.minZ - pad && z <= r.maxZ + pad;
}

// Support can continue a short distance invisibly beneath a destination deck.
// This is collision-only: the rendered ramp still ends at the exact seam.
function rampSupportY(r, x, z, pad = 0) {
  const along = r.axis === 'x' ? x : z;
  const min = r.axis === 'x' ? r.minX : r.minZ;
  const max = r.axis === 'x' ? r.maxX : r.maxZ;
  const cross = r.axis === 'x' ? z : x;
  const crossMin = r.axis === 'x' ? r.minZ : r.minX;
  const crossMax = r.axis === 'x' ? r.maxZ : r.maxX;
  if (cross < crossMin - pad || cross > crossMax + pad) return null;
  if (along < min - pad - (r.supportPad0 || 0) || along > max + pad + (r.supportPad1 || 0)) return null;
  if (along <= min) return r.h0;
  if (along >= max) return r.h1;
  return rampSurfaceY(r, x, z);
}

// Push a sphere out of colliders. Mutates pos; returns ground normal y (0 if airborne).
function resolveSphere(pos, radius, colliders, out) {
  for (const c of colliders) {
    if (c.type === 'box') {
      const cx = clamp(pos.x, c.min.x, c.max.x);
      const cy = clamp(pos.y, c.min.y, c.max.y);
      const cz = clamp(pos.z, c.min.z, c.max.z);
      let dx = pos.x - cx, dy = pos.y - cy, dz = pos.z - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > radius * radius) continue;
      if (d2 > 1e-9) {
        const d = Math.sqrt(d2), push = radius - d;
        dx /= d; dy /= d; dz /= d;
        pos.x += dx * push; pos.y += dy * push; pos.z += dz * push;
        out.hit = true; if (dy > out.ny) out.ny = dy;
        out.nx += dx; out.nz += dz;
      } else {
        // Center inside the box: exit through the nearest face.
        const exits = [
          [c.max.x - pos.x + radius, 1, 0, 0], [pos.x - c.min.x + radius, -1, 0, 0],
          [c.max.y - pos.y + radius, 0, 1, 0], [pos.y - c.min.y + radius, 0, -1, 0],
          [c.max.z - pos.z + radius, 0, 0, 1], [pos.z - c.min.z + radius, 0, 0, -1],
        ];
        exits.sort((a, b) => a[0] - b[0]);
        const [dist, ex, ey, ez] = exits[0];
        pos.x += ex * dist; pos.y += ey * dist; pos.z += ez * dist;
        out.hit = true; if (ey > out.ny) out.ny = ey;
      }
    } else if (c.type === 'sphere') {
      _v.set(pos.x - c.center.x, pos.y - c.center.y, pos.z - c.center.z);
      const d = _v.length(), min = c.radius + radius;
      if (d < min && d > 1e-6) {
        _v.multiplyScalar((min - d) / d);
        pos.add(_v);
        out.hit = true;
        const ny = _v.y / (min - d) || 0;
        if (ny > out.ny) out.ny = ny;
      }
    } else if (c.type === 'ellipsoid') {
      resolveSphereEllipsoid(pos, radius, c, out);
    } else if (c.type === 'cylinderShell') {
      resolveSphereCylinderShell(pos, radius, c, out);
    }
  }
}

const _moveSp = new THREE.Vector3();
const _moveBefore = new THREE.Vector3();
const _moveWallNormal = new THREE.Vector3();
const _moveHit = { hit: false, ny: 0, nx: 0, nz: 0 };

// Move a character (feet-position capsule) with gravity + collision. Normal
// walking remains one pass; fast falls or long frames are split just enough
// that a capsule cannot jump completely through a thin floor between checks.
// char: {pos, vel, radius, height}; world: {colliders, ramps, gravity}
export function moveCharacter(char, world, dt) {
  const gravity = world.gravityAt?.(char.pos, char) ?? world.gravity;
  const estimatedTravel = char.vel.length() * dt + gravity * dt * dt * 0.5;
  const steps = Math.min(4, Math.max(1, Math.ceil(estimatedTravel / 0.5)));
  const stepDt = dt / steps;
  let grounded = false;
  for (let i = 0; i < steps; i++) grounded = moveCharacterStep(char, world, stepDt);
  return grounded;
}

function moveCharacterStep(char, world, dt) {
  const gravity = world.gravityAt?.(char.pos, char) ?? world.gravity;
  const previousY = char.pos.y;
  char._contactPadCooldown = Math.max(0, (char._contactPadCooldown || 0) - dt);
  char.vel.y -= gravity * dt;
  char.pos.addScaledVector(char.vel, dt);

  const r = char.radius;
  // Snap to an approaching ramp before resolving adjacent box faces. Without
  // this pre-pass, a flush deck can push the capsule sideways at the ramp's
  // crest before the normal post-collision ramp snap gets a chance to hold it
  // up, creating a tiny but flow-breaking "jump lip" at an otherwise perfect
  // seam. Rising players are excluded so ramps still block jumps from below.
  let rampSupported = false;
  if (char.vel.y <= 0.01) {
    for (const ramp of world.ramps) {
      const surf = rampSupportY(ramp, char.pos.x, char.pos.z, r + 0.2);
      if (surf == null) continue;
      if (char.pos.y <= surf + 0.12 && char.pos.y > surf - 1.1) {
        char.pos.y = Math.max(char.pos.y, surf);
        if (char.vel.y < 0) char.vel.y = 0;
        rampSupported = true;
      }
    }
  }
  const out = _moveHit;
  out.hit = false; out.ny = 0; out.nx = 0; out.nz = 0;
  const sp = _moveSp;
  const before = _moveBefore;
  for (let iter = 0; iter < 2; iter++) {
    for (let sphere = 0; sphere < 3; sphere++) {
      const sy = sphere === 0 ? r : sphere === 1 ? char.height * 0.5 : char.height - r;
      sp.set(char.pos.x, char.pos.y + sy, char.pos.z);
      before.copy(sp);
      resolveSphere(sp, r, nearbyColliders(world, sp, r), out);
      char.pos.add(sp.sub(before));
    }
  }

  let grounded = rampSupported;
  if (out.hit) {
    if (out.ny > 0.55) { grounded = true; if (char.vel.y < 0) char.vel.y = 0; }
    else if (out.ny < -0.55 && char.vel.y > 0) char.vel.y = 0; // bonked head
    else {
      // wall — damp velocity into the wall a bit
      const n = _moveWallNormal.set(out.nx, 0, out.nz);
      if (n.lengthSq() > 0.01) {
        n.normalize();
        const into = char.vel.dot(n);
        if (into < 0) char.vel.addScaledVector(n, -into);
      }
    }
  }

  // Walkable ramps: when approaching from above, snap onto the surface (smooth
  // walking). In every other case the slab is a solid oriented box — sides and
  // underside block like any wall.
  for (const ramp of world.ramps) {
    const surf = rampSupportY(ramp, char.pos.x, char.pos.z, char.radius + 0.2);
    if (surf == null) continue;
    // Snap onto the surface only when walking/falling — never while rising,
    // or a jump from below would teleport the character through the slab.
    if (char.vel.y <= 0.01 && char.pos.y <= surf + 0.02 && char.pos.y > surf - 1.1) {
      char.pos.y = surf;
      if (char.vel.y < 0) char.vel.y = 0;
      grounded = true;
    } else if (inRampFootprint(ramp, char.pos.x, char.pos.z, char.radius + 0.2)) {
      const obb = rampOBB(ramp);
      for (let sphere = 0; sphere < 3; sphere++) {
        const sy = sphere === 0 ? r : sphere === 1 ? char.height * 0.5 : char.height - r;
        sp.set(char.pos.x, char.pos.y + sy, char.pos.z);
        before.copy(sp);
        const ny = resolveSphereOBB(sp, char.radius, obb);
        if (ny === null) continue;
        const delta = sp.sub(before);
        // standing on a floor: the slab may push sideways but never downward,
        // or the two collisions fight and squeeze the character through the floor
        if (grounded && delta.y < 0) delta.y = 0;
        char.pos.add(delta);
        if (ny > 0.55) { grounded = true; if (char.vel.y < 0) char.vel.y = 0; }
        else if (ny < -0.55 && char.vel.y > 0) char.vel.y = 0;
      }
    }
  }

  // Living mushrooms react to the whole player capsule, not only to feet
  // landing on their top. A short per-character cooldown prevents the four
  // movement substeps from retriggering the same cap while still making a
  // sideways sprint into its rim launch immediately.
  if (world.jumpPads && char._contactPadCooldown <= 0) {
    for (const pad of world.jumpPads) {
      if (!pad.contactBounce || pad.disabled) continue;
      if (pad.playersOnly && !char.isPlayer) continue;
      const dx = char.pos.x - pad.x;
      const dz = char.pos.z - pad.z;
      const contactRadius = (pad.contactRadius ?? pad.r) + r * 0.65;
      const capsuleTop = char.pos.y + char.height;
      if (dx * dx + dz * dz > contactRadius * contactRadius ||
          capsuleTop < pad.contactMinY || char.pos.y > pad.contactMaxY) continue;

      const horizontalLength = Math.hypot(dx, dz);
      const velocityLength = Math.hypot(char.vel.x, char.vel.z);
      const nx = horizontalLength > 0.001 ? dx / horizontalLength
        : velocityLength > 0.001 ? -char.vel.x / velocityLength : 1;
      const nz = horizontalLength > 0.001 ? dz / horizontalLength
        : velocityLength > 0.001 ? -char.vel.z / velocityLength : 0;
      char.vel.y = pad.vy;
      if (pad.vx) char.vel.x = pad.vx;
      else char.vel.x += nx * (pad.sideImpulse || 3.5);
      if (pad.vz) char.vel.z = pad.vz;
      else char.vel.z += nz * (pad.sideImpulse || 3.5);
      char._contactPadCooldown = pad.cooldown || 0.34;
      pad.onTrigger?.(char);
      world.onPad?.(char, pad);
      return false;
    }
  }

  // One-way cap tops can still be jumped through from below, then catch the
  // character's feet on the way down. Contact bounce above handles their rim.
  if (char.vel.y <= 0 && world.jumpPads) {
    for (const pad of world.jumpPads) {
      if (!pad.oneWay || pad.disabled) continue;
      if (pad.playersOnly && !char.isPlayer) continue;
      const dx = char.pos.x - pad.x;
      const dz = char.pos.z - pad.z;
      if (dx * dx + dz * dz > pad.r * pad.r || previousY < pad.y || char.pos.y > pad.y) continue;
      char.pos.y = pad.y;
      char.vel.y = pad.vy;
      if (pad.vx) char.vel.x = pad.vx;
      if (pad.vz) char.vel.z = pad.vz;
      pad.onTrigger?.(char);
      world.onPad?.(char, pad);
      return false;
    }
  }

  // Ground jump pads: {x, y, z, r, vy, vx?, vz?}
  if (grounded && world.jumpPads) {
    for (const pad of world.jumpPads) {
      if (pad.oneWay || pad.disabled) continue;
      if (pad.playersOnly && !char.isPlayer) continue;
      if (Math.abs(char.pos.x - pad.x) < pad.r && Math.abs(char.pos.z - pad.z) < pad.r &&
          Math.abs(char.pos.y - pad.y) < 1.2) {
        char.vel.y = pad.vy;
        if (pad.vx) char.vel.x = pad.vx;
        if (pad.vz) char.vel.z = pad.vz;
        grounded = false;
        pad.onTrigger?.(char);
        world.onPad?.(char, pad);
        break;
      }
    }
  }
  return grounded;
}

/* ============ Arbitrary-gravity mover (PRISM RUN wall-walking) ============
   Same capsule-vs-box resolution, but "down" is -char.up (any cardinal), so
   the character can stand on floors, walls and ceilings alike. Returns the
   world-space contact-normal sum in `nOut` (for grounded / climb decisions). */
function resolveSphereVec(pos, radius, colliders, nsum) {
  for (const c of colliders) {
    if (c.type !== 'box') continue;
    const cx = clamp(pos.x, c.min.x, c.max.x);
    const cy = clamp(pos.y, c.min.y, c.max.y);
    const cz = clamp(pos.z, c.min.z, c.max.z);
    let dx = pos.x - cx, dy = pos.y - cy, dz = pos.z - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 > radius * radius) continue;
    if (d2 > 1e-9) {
      const d = Math.sqrt(d2), push = radius - d;
      dx /= d; dy /= d; dz /= d;
      pos.x += dx * push; pos.y += dy * push; pos.z += dz * push;
      nsum.x += dx; nsum.y += dy; nsum.z += dz;
    } else {
      const exits = [
        [c.max.x - pos.x + radius, 1, 0, 0], [pos.x - c.min.x + radius, -1, 0, 0],
        [c.max.y - pos.y + radius, 0, 1, 0], [pos.y - c.min.y + radius, 0, -1, 0],
        [c.max.z - pos.z + radius, 0, 0, 1], [pos.z - c.min.z + radius, 0, 0, -1],
      ];
      exits.sort((a, b) => a[0] - b[0]);
      const [dist, ex, ey, ez] = exits[0];
      pos.x += ex * dist; pos.y += ey * dist; pos.z += ez * dist;
      nsum.x += ex; nsum.y += ey; nsum.z += ez;
    }
  }
}

export function moveCharacterUp(char, world, dt, nOut) {
  const up = char.up;
  char.vel.addScaledVector(up, -world.gravity * dt);
  char.pos.addScaledVector(char.vel, dt);

  const r = char.radius;
  const offs = [r, char.height * 0.5, char.height - r];
  const sp = new THREE.Vector3();
  const before = new THREE.Vector3();
  nOut.set(0, 0, 0);
  for (let iter = 0; iter < 2; iter++) {
    for (const o of offs) {
      sp.copy(char.pos).addScaledVector(up, o);
      before.copy(sp);
      resolveSphereVec(sp, r, nearbyColliders(world, sp, r), nOut);
      char.pos.add(sp.sub(before));
    }
  }

  let grounded = false;
  if (nOut.lengthSq() > 1e-6) {
    const n = _v.copy(nOut).normalize();
    const along = n.dot(up);              // +1 = surface under your feet
    const vUp = char.vel.dot(up);
    if (along > 0.55) { grounded = true; if (vUp < 0) char.vel.addScaledVector(up, -vUp); }
    else if (along < -0.55) { if (vUp > 0) char.vel.addScaledVector(up, -vUp); } // head bonk
    else {                                // wall: kill velocity into it
      const into = char.vel.dot(n);
      if (into < 0) char.vel.addScaledVector(n, -into);
    }
  }

  // Jump pads still fire when you're stood on a +Y surface (the arena floor)
  if (grounded && up.y > 0.9 && world.jumpPads) {
    for (const pad of world.jumpPads) {
      if (pad.oneWay || pad.disabled) continue;
      if (Math.abs(char.pos.x - pad.x) < pad.r && Math.abs(char.pos.z - pad.z) < pad.r &&
          Math.abs(char.pos.y - pad.y) < 1.2) {
        char.vel.y = pad.vy;
        if (pad.vx) char.vel.x = pad.vx;
        if (pad.vz) char.vel.z = pad.vz;
        grounded = false;
        pad.onTrigger?.(char);
        world.onPad?.(char, pad);
        break;
      }
    }
  }
  return grounded;
}

// Nearest cardinal axis to a vector.
export function cardinal(v) {
  const ax = Math.abs(v.x), ay = Math.abs(v.y), az = Math.abs(v.z);
  if (ax >= ay && ax >= az) return new THREE.Vector3(Math.sign(v.x), 0, 0);
  if (ay >= az) return new THREE.Vector3(0, Math.sign(v.y), 0);
  return new THREE.Vector3(0, 0, Math.sign(v.z));
}

export function shellInnerNormal(box, world, target = new THREE.Vector3()) {
  if (!box?.shell || box.type !== 'box' || !world?.cube) return null;
  target.set(
    world.cube.cx - (box.min.x + box.max.x) * 0.5,
    world.cube.cy - (box.min.y + box.max.y) * 0.5,
    world.cube.cz - (box.min.z + box.max.z) * 0.5);
  const ax = Math.abs(target.x), ay = Math.abs(target.y), az = Math.abs(target.z);
  if (ax < 1e-6 && ay < 1e-6 && az < 1e-6) return null;
  if (ax >= ay && ax >= az) return target.set(Math.sign(target.x), 0, 0);
  if (ay >= az) return target.set(0, Math.sign(target.y), 0);
  return target.set(0, 0, Math.sign(target.z));
}

function pointHitsBox(p, radius, box, world) {
  if (!box.shell) {
    return p.x > box.min.x - radius && p.x < box.max.x + radius &&
      p.y > box.min.y - radius && p.y < box.max.y + radius &&
      p.z > box.min.z - radius && p.z < box.max.z + radius;
  }

  const n = shellInnerNormal(box, world, _v);
  if (!n) return false;
  const axis = Math.abs(n.x) > 0.5 ? 'x' : Math.abs(n.y) > 0.5 ? 'y' : 'z';
  const sign = n[axis];
  const plane = sign > 0 ? box.max[axis] : box.min[axis];
  const signedDist = (p[axis] - plane) * sign;
  const shellDepth = box.max[axis] - box.min[axis];
  if (signedDist >= radius || signedDist <= -shellDepth - radius) return false;
  for (const other of ['x', 'y', 'z']) {
    if (other === axis) continue;
    if (p[other] < box.min[other] - radius || p[other] > box.max[other] + radius) return false;
  }
  return true;
}

// Point-with-radius vs world, for projectiles.
// skipRamps: LOS checks ignore ramp slabs (they're thin; treating them as
// 2.5m-thick blockers falsely severs waypoint links along slopes).
export function pointHitsWorld(p, radius, world, skipRamps = false) {
  for (const c of nearbyColliders(world, p, radius)) {
    if (c.type === 'box') {
      if (pointHitsBox(p, radius, c, world)) return true;
    } else if (c.type === 'sphere') {
      if (p.distanceToSquared(c.center) < (c.radius + radius) ** 2) return true;
    } else if (c.type === 'ellipsoid') {
      if (sphereHitsEllipsoid(p, radius, c)) return true;
    } else if (c.type === 'cylinderShell') {
      if (sphereHitsCylinderShell(p, radius, c)) return true;
    }
  }
  if (!skipRamps) {
    for (const ramp of world.ramps) {
      if (inRampFootprint(ramp, p.x, p.z)) {
        const surf = rampSurfaceY(ramp, p.x, p.z);
        if (p.y < surf + 0.02 && p.y > surf - 0.5) return true;
      }
    }
  }
  return false;
}

const _los = new THREE.Vector3();
export function hasLOS(a, b, world, sampleDistance = 1.2) {
  const dist = a.distanceTo(b);
  const steps = Math.ceil(dist / Math.max(0.1, sampleDistance));
  for (let i = 1; i < steps; i++) {
    _los.lerpVectors(a, b, i / steps);
    if (pointHitsWorld(_los, 0.05, world, true)) return false;
  }
  return true;
}

const _routeSample = new THREE.Vector3();
// A head-height LOS ray is enough for aiming, but not for navigation: it can
// pass over a low wall or skim a doorway corner that a character capsule will
// run straight into. Sample three slightly inset capsule spheres along a route
// so maps with dense geometry can opt into bot-sized waypoint clearance.
export function hasRouteClearance(a, b, world, radius = 0.35) {
  const dist = a.distanceTo(b);
  const steps = Math.ceil(dist / 0.75);
  for (let i = 1; i < steps; i++) {
    _routeSample.lerpVectors(a, b, i / steps);
    for (const y of [0.55, 0.95, 1.35]) {
      _routeSample.y += y;
      const blocked = pointHitsWorld(_routeSample, radius, world, true);
      _routeSample.y -= y;
      if (blocked) return false;
    }
  }
  return true;
}

// Auto-link waypoints into a graph, then provide BFS paths.
export function buildWaypointGraph(world) {
  const wps = world.waypoints;
  const maxDist = world.waypointLinkDist ?? 15;
  const maxDy = world.waypointLinkDy ?? 3.5;
  const eye = new THREE.Vector3(), eye2 = new THREE.Vector3();
  for (let i = 0; i < wps.length; i++) wps[i].links = [];
  for (let i = 0; i < wps.length; i++) {
    for (let j = i + 1; j < wps.length; j++) {
      const a = wps[i].pos, b = wps[j].pos;
      if (a.distanceTo(b) > maxDist) continue;
      if (Math.abs(a.y - b.y) > maxDy) continue;
      eye.copy(a).y += 1.2; eye2.copy(b).y += 1.2;
      if (!hasLOS(eye, eye2, world)) continue;
      if (world.waypointLinkClearance &&
          !hasRouteClearance(a, b, world, world.waypointLinkClearance)) continue;
      wps[i].links.push(j); wps[j].links.push(i);
    }
  }
  // Manual links (e.g. jump-pad routes): [[x,y,z, x2,y2,z2, oneWay?], ...]
  if (world.manualLinks) {
    const near = (x, y, z) => nearestWaypoint(world, _los.set(x, y, z));
    for (const [x1, y1, z1, x2, y2, z2, oneWay] of world.manualLinks) {
      const a = near(x1, y1, z1), b = near(x2, y2, z2);
      if (a === b) continue;
      if (!wps[a].links.includes(b)) wps[a].links.push(b);
      if (!oneWay && !wps[b].links.includes(a)) wps[b].links.push(a);
    }
  }
}

export function findPath(world, fromIdx, toIdx) {
  const wps = world.waypoints;
  if (fromIdx === toIdx) return [toIdx];
  const prev = new Array(wps.length).fill(-1);
  const q = [fromIdx];
  prev[fromIdx] = fromIdx;
  while (q.length) {
    const cur = q.shift();
    for (const nb of wps[cur].links) {
      if (prev[nb] !== -1) continue;
      prev[nb] = cur;
      if (nb === toIdx) {
        const path = [toIdx];
        let c = toIdx;
        while (c !== fromIdx) { c = prev[c]; path.unshift(c); }
        return path;
      }
      q.push(nb);
    }
  }
  return null;
}

export function nearestWaypoint(world, pos) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < world.waypoints.length; i++) {
    const d = world.waypoints[i].pos.distanceToSquared(pos);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
