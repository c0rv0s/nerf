// Shared math + physics helpers. Colliders are AABB boxes, spheres, oriented
// ellipsoids, exact closed triangle meshes, finite hollow-cylinder shells, and
// walkable ramps (heightfield strips).
import * as THREE from 'three';
import { rayTriangleCandidates } from './triangle-ray-grid.js';

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
    } else if (collider.type === 'triangleMesh') {
      add(collider, collider.min.x, collider.max.x, collider.min.z, collider.max.z);
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
const _meshClosest = new THREE.Vector3();
const _meshDelta = new THREE.Vector3();
const _meshRayPoint = new THREE.Vector3();
const _meshRay = new THREE.Ray();
const _meshInsidePoint = new THREE.Vector3();
const _meshInsideDirection = new THREE.Vector3(0.917, 0.281, 0.284).normalize();
const _meshInsideRay = new THREE.Ray();
const _meshInsideHits = [];
let collisionQueryStamp = 0;
let triangleQueryStamp = 0;

function nearbyTriangleEntries(collider, x, z, radius = 0) {
  if (!collider.triangleCells || !collider.triangleCellSize) return collider.triangles;
  const out = collider._triangleQuery ||= [];
  out.length = 0;
  const stamp = ++triangleQueryStamp;
  const size = collider.triangleCellSize;
  const minX = Math.floor((x - radius) / size), maxX = Math.floor((x + radius) / size);
  const minZ = Math.floor((z - radius) / size), maxZ = Math.floor((z + radius) / size);
  for (let ix = minX; ix <= maxX; ix++) for (let iz = minZ; iz <= maxZ; iz++) {
    const cell = collider.triangleCells.get(`${ix},${iz}`);
    if (!cell) continue;
    for (const entry of cell) {
      if (entry._triangleQueryStamp === stamp) continue;
      entry._triangleQueryStamp = stamp;
      out.push(entry);
    }
  }
  return out;
}

function closestTriangleMeshPoint(pos, collider, target = _meshClosest, radius = 0) {
  let bestDistanceSq = Infinity;
  let bestTriangle = null;
  for (const entry of nearbyTriangleEntries(collider, pos.x, pos.z, radius)) {
    const box = entry.box;
    const dx = pos.x < box.min.x ? box.min.x - pos.x : pos.x > box.max.x ? pos.x - box.max.x : 0;
    const dy = pos.y < box.min.y ? box.min.y - pos.y : pos.y > box.max.y ? pos.y - box.max.y : 0;
    const dz = pos.z < box.min.z ? box.min.z - pos.z : pos.z > box.max.z ? pos.z - box.max.z : 0;
    if (dx * dx + dy * dy + dz * dz >= bestDistanceSq) continue;
    entry.triangle.closestPointToPoint(pos, _cl);
    const distanceSq = pos.distanceToSquared(_cl);
    if (distanceSq >= bestDistanceSq) continue;
    bestDistanceSq = distanceSq;
    target.copy(_cl);
    bestTriangle = entry;
  }
  return { distanceSq: bestDistanceSq, triangle: bestTriangle };
}

// A nearest-face normal is not a valid inside/outside test for a closed mesh.
// Near a broad sloped roof, for example, a player several meters below the
// surface can still sit behind that face's plane and be misclassified as
// inside, causing the solver to eject them all the way onto the roof. Count
// unique intersections along an oblique ray instead; odd parity means the
// point is genuinely enclosed by the volume.
function pointInsideTriangleMesh(pos, collider) {
  _meshInsideRay.set(pos, _meshInsideDirection);
  _meshInsideHits.length = 0;
  for (const entry of collider.triangles) {
    const hit = _meshInsideRay.intersectTriangle(
      entry.triangle.a, entry.triangle.b, entry.triangle.c, false, _meshInsidePoint,
    );
    if (!hit) continue;
    const distance = _meshDelta.copy(hit).sub(pos).dot(_meshInsideDirection);
    if (distance > 1e-5) _meshInsideHits.push(distance);
  }
  _meshInsideHits.sort((a, b) => a - b);
  let uniqueHits = 0;
  let previous = -Infinity;
  for (const distance of _meshInsideHits) {
    if (distance - previous <= 1e-5) continue;
    uniqueHits++;
    previous = distance;
  }
  return uniqueHits % 2 === 1;
}

export function sphereHitsTriangleMesh(pos, radius, collider) {
  if (pos.x < collider.min.x - radius || pos.x > collider.max.x + radius ||
      pos.y < collider.min.y - radius || pos.y > collider.max.y + radius ||
      pos.z < collider.min.z - radius || pos.z > collider.max.z + radius) return false;
  const closest = closestTriangleMeshPoint(pos, collider, _meshClosest, radius);
  if (!closest.triangle) return false;
  if (closest.distanceSq < radius * radius) return true;
  const behindClosestFace = _meshDelta.copy(pos).sub(_meshClosest)
    .dot(closest.triangle.normal) < 0;
  return behindClosestFace && pointInsideTriangleMesh(pos, collider);
}

export function rayHitsTriangleMesh(origin, direction, collider, maxDist = Infinity) {
  _meshRay.set(origin, direction);
  let bestT = maxDist;
  let bestNormal = null;
  for (const entry of rayTriangleCandidates(collider, origin, direction, maxDist)) {
    const hit = _meshRay.intersectTriangle(
      entry.triangle.a, entry.triangle.b, entry.triangle.c, false, _meshRayPoint,
    );
    if (!hit) continue;
    const t = _meshDelta.copy(hit).sub(origin).dot(direction);
    if (t <= 0.03 || t >= bestT) continue;
    bestT = t;
    bestNormal = entry.normal;
  }
  return bestNormal ? { t: bestT, normal: bestNormal.clone() } : null;
}

function resolveSphereTriangleMesh(pos, radius, collider, out) {
  if (pos.x < collider.min.x - radius || pos.x > collider.max.x + radius ||
      pos.y < collider.min.y - radius || pos.y > collider.max.y + radius ||
      pos.z < collider.min.z - radius || pos.z > collider.max.z + radius) return;
  const closest = closestTriangleMeshPoint(pos, collider, _meshClosest, radius);
  if (!closest.triangle) return;
  const behindClosestFace = _meshDelta.copy(pos).sub(_meshClosest)
    .dot(closest.triangle.normal) < 0;
  const inside = behindClosestFace && pointInsideTriangleMesh(pos, collider);
  if (!inside && closest.distanceSq >= radius * radius) return;
  const distance = Math.sqrt(Math.max(closest.distanceSq, 0));
  if (inside) _meshDelta.copy(_meshClosest).sub(pos);
  else _meshDelta.copy(pos).sub(_meshClosest);
  if (_meshDelta.lengthSq() < 1e-12) _meshDelta.copy(closest.triangle.normal);
  else _meshDelta.multiplyScalar(1 / Math.max(distance, 1e-8));
  const push = inside ? distance + radius : radius - distance;
  pos.addScaledVector(_meshDelta, push);
  out.hit = true;
  if (_meshDelta.y > out.ny) out.ny = _meshDelta.y;
  out.nx += _meshDelta.x;
  out.nz += _meshDelta.z;
}

// Highest exact polygon intersection at an X/Z coordinate. Decorative actors,
// navigation, and gameplay can therefore sample the same triangles used by
// character collision instead of reconstructing a smooth proxy sphere.
export function triangleMeshSurfaceY(collider, x, z, outNormal = null) {
  if (x < collider.min.x || x > collider.max.x || z < collider.min.z || z > collider.max.z) return null;
  let best = null;
  for (const entry of nearbyTriangleEntries(collider, x, z)) {
    const { a, b, c } = entry.triangle;
    const denominator = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
    if (Math.abs(denominator) < 1e-9) continue;
    const u = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / denominator;
    const v = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / denominator;
    const w = 1 - u - v;
    if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
    const y = u * a.y + v * b.y + w * c.y;
    if (best != null && y <= best) continue;
    best = y;
    if (outNormal) outNormal.copy(entry.normal);
  }
  return best;
}

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
    if (r.oriented) {
      const len = r.length;
      const width = r.width;
      const dh = r.h1 - r.h0;
      const slopeLen = Math.hypot(len, dh);
      const ang = Math.atan2(dh, len);
      const halfThickness = 0.22;
      const yaw = r.yaw || 0;
      const rot = new THREE.Matrix4().makeRotationY(-yaw)
        .multiply(new THREE.Matrix4().makeRotationZ(ang));
      r._obb = {
        c: new THREE.Vector3(
          r.centerX + Math.cos(yaw) * halfThickness * Math.sin(ang),
          (r.h0 + r.h1) / 2 - halfThickness * Math.cos(ang),
          r.centerZ + Math.sin(yaw) * halfThickness * Math.sin(ang),
        ),
        rot, inv: rot.clone().invert(),
        he: new THREE.Vector3(slopeLen / 2, halfThickness, width / 2),
      };
      return r._obb;
    }
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
  if (r.oriented) {
    const dx = x - r.centerX;
    const dz = z - r.centerZ;
    const along = dx * Math.cos(r.yaw || 0) + dz * Math.sin(r.yaw || 0);
    const t = along / r.length + 0.5;
    return r.h0 + (r.h1 - r.h0) * clamp(t, 0, 1);
  }
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

export function inRampFootprint(r, x, z, pad = 0) {
  if (r.oriented) {
    const dx = x - r.centerX;
    const dz = z - r.centerZ;
    const yaw = r.yaw || 0;
    const along = dx * Math.cos(yaw) + dz * Math.sin(yaw);
    const cross = -dx * Math.sin(yaw) + dz * Math.cos(yaw);
    return Math.abs(along) <= r.length / 2 + pad && Math.abs(cross) <= r.width / 2 + pad;
  }
  return x >= r.minX - pad && x <= r.maxX + pad && z >= r.minZ - pad && z <= r.maxZ + pad;
}

// Support can continue a short distance invisibly beneath a destination deck.
// This is collision-only: the rendered ramp still ends at the exact seam.
function rampSupportY(r, x, z, pad = 0) {
  if (r.oriented) {
    const dx = x - r.centerX;
    const dz = z - r.centerZ;
    const yaw = r.yaw || 0;
    const along = dx * Math.cos(yaw) + dz * Math.sin(yaw);
    const cross = -dx * Math.sin(yaw) + dz * Math.cos(yaw);
    if (Math.abs(cross) > r.width / 2 + pad) return null;
    const min = -r.length / 2;
    const max = r.length / 2;
    if (along < min - pad - (r.supportPad0 || 0) || along > max + pad + (r.supportPad1 || 0)) return null;
    if (along <= min) return r.h0;
    if (along >= max) return r.h1;
    return rampSurfaceY(r, x, z);
  }
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
  const surface = rampSurfaceY(r, x, z);
  // A flush deck face begins blocking the capsule before its feet reach the
  // exact ramp endpoint. Maps can raise collision support through the final
  // approach so the capsule clears that face without changing visible geometry.
  if (r.crestBlend0 > 0 && r.h0 > r.h1 && along < min + r.crestBlend0) {
    const t = clamp((along - min) / r.crestBlend0, 0, 1);
    const eased = t * t * (3 - 2 * t);
    return r.h0 + (surface - r.h0) * eased;
  }
  if (r.crestBlend1 > 0 && r.h1 > r.h0 && along > max - r.crestBlend1) {
    const t = clamp((max - along) / r.crestBlend1, 0, 1);
    const eased = t * t * (3 - 2 * t);
    return r.h1 + (surface - r.h1) * eased;
  }
  return surface;
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
    } else if (c.type === 'triangleMesh') {
      resolveSphereTriangleMesh(pos, radius, c, out);
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
  // Collision response must not squeeze a supported capsule down through its
  // floor. Tight rock arches can overlap the lower, middle, and upper capsule
  // samples at once; resolving each sample independently may otherwise add
  // several downward "nearest exit" corrections in one frame. Preserve the
  // previous frame's support (or support found earlier in this solve) while
  // still accepting horizontal push-out. A genuinely airborne character can
  // still be pushed down by a ceiling.
  const supportedAtStepStart = char.grounded === true && char.vel.y <= 0.01;
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
      const delta = sp.sub(before);
      if ((supportedAtStepStart || out.ny > 0.55) && delta.y < 0) delta.y = 0;
      char.pos.add(delta);
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
    // Ordinary ramps are thin constructed slabs. Natural cliff ramps can opt
    // into a solid mass extending from their rideable top down to the ground.
    // If a capsule is beneath that top, eject it through the nearest footprint
    // edge instead of letting it travel inside the wedge or teleporting it up
    // onto a very high cliff.
    if (ramp.solidToGround && char.pos.y + char.height > (ramp.solidBottom ?? -0.5) &&
        char.pos.y < surf - 1.1) {
      const yaw = ramp.yaw || 0;
      const cos = Math.cos(yaw), sin = Math.sin(yaw);
      const dx = char.pos.x - ramp.centerX;
      const dz = char.pos.z - ramp.centerZ;
      const along = dx * cos + dz * sin;
      const cross = -dx * sin + dz * cos;
      const halfLength = ramp.length / 2;
      const halfWidth = ramp.width / 2;
      if (Math.abs(along) <= halfLength + char.radius &&
          Math.abs(cross) <= halfWidth + char.radius) {
        const exits = [
          [-halfLength - char.radius - along, 0],
          [halfLength + char.radius - along, 0],
          [0, -halfWidth - char.radius - cross],
          [0, halfWidth + char.radius - cross],
        ].sort((a, b) => Math.hypot(...a) - Math.hypot(...b));
        const [alongPush, crossPush] = exits[0];
        const pushX = alongPush * cos - crossPush * sin;
        const pushZ = alongPush * sin + crossPush * cos;
        char.pos.x += pushX;
        char.pos.z += pushZ;
        const pushLength = Math.hypot(pushX, pushZ);
        if (pushLength > 1e-6) {
          const nx = pushX / pushLength;
          const nz = pushZ / pushLength;
          const into = char.vel.x * nx + char.vel.z * nz;
          if (into < 0) {
            char.vel.x -= nx * into;
            char.vel.z -= nz * into;
          }
        }
        // Re-evaluate the ramp after moving outside its solid footprint.
        continue;
      }
    }
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

  // Some natural maps render a thin terrain skin over a much deeper solid
  // mass. A hard-floor zone is the final invariant for tight overlapping rock
  // formations: collision may move the capsule sideways or upward, but it may
  // never finish a movement step underneath the visible walking surface.
  for (const floor of world.hardFloorZones || []) {
    if (char.pos.x < floor.minX || char.pos.x > floor.maxX ||
        char.pos.z < floor.minZ || char.pos.z > floor.maxZ ||
        char.pos.y >= floor.y) continue;
    char.pos.y = floor.y;
    if (char.vel.y < 0) char.vel.y = 0;
    grounded = true;
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
      // Side contact begins below the cap's landing plane, so directional
      // mushrooms may provide a slightly stronger contact launch to preserve
      // the same usable arc as a clean feet-first landing.
      char.vel.y = pad.contactVy ?? pad.vy;
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
    } else if (c.type === 'triangleMesh') {
      if (sphereHitsTriangleMesh(p, radius, c)) return true;
    } else if (c.type === 'cylinderShell') {
      if (sphereHitsCylinderShell(p, radius, c)) return true;
    }
  }
  // Unlike a normal thin ramp slab, a cliff marked solidToGround blocks shots,
  // line of sight, and navigation throughout the rock beneath its top surface.
  for (const ramp of world.ramps) {
    if (!ramp.solidToGround || !inRampFootprint(ramp, p.x, p.z, radius)) continue;
    const surf = rampSurfaceY(ramp, p.x, p.z);
    if (p.y < surf + radius && p.y > (ramp.solidBottom ?? -0.5) - radius) return true;
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
      // Some authored traversal networks (such as annular tree balconies and
      // their narrow outgoing branches) must use their explicit links. A
      // clear straight chord can still cross unsupported air or a solid trunk.
      if (wps[i].manualLinksOnly || wps[j].manualLinksOnly) continue;
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
