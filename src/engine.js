// Shared math + physics helpers. Colliders are AABB boxes, spheres, and
// walkable ramps (heightfield strips) — enough for all three maps.
import * as THREE from 'three';

export const rand = (a, b) => a + Math.random() * (b - a);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const _v = new THREE.Vector3();
const _l = new THREE.Vector3();
const _cl = new THREE.Vector3();

// Lazily build a ramp's oriented-box collider matching its visual slab.
function rampOBB(r) {
  if (!r._obb) {
    const len = r.axis === 'x' ? r.maxX - r.minX : r.maxZ - r.minZ;
    const width = r.axis === 'x' ? r.maxZ - r.minZ : r.maxX - r.minX;
    const dh = r.h1 - r.h0;
    const slopeLen = Math.hypot(len, dh);
    const ang = Math.atan2(dh, len);
    const rot = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(
      r.axis === 'z' ? -ang : 0, 0, r.axis === 'x' ? ang : 0));
    r._obb = {
      c: new THREE.Vector3((r.minX + r.maxX) / 2, (r.h0 + r.h1) / 2 - 0.2, (r.minZ + r.maxZ) / 2),
      rot, inv: rot.clone().invert(),
      // top face flush with the walk surface, bottom at the visual underside
      he: new THREE.Vector3(r.axis === 'x' ? slopeLen / 2 : width / 2, 0.22,
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

function inRampFootprint(r, x, z, pad = 0) {
  return x >= r.minX - pad && x <= r.maxX + pad && z >= r.minZ - pad && z <= r.maxZ + pad;
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
    }
  }
}

// Move a character (feet-position capsule) with gravity + collision.
// char: {pos, vel, radius, height}; world: {colliders, ramps, gravity}
export function moveCharacter(char, world, dt) {
  char.vel.y -= world.gravity * dt;
  char.pos.addScaledVector(char.vel, dt);

  const r = char.radius;
  const out = { hit: false, ny: 0, nx: 0, nz: 0 };
  const sphereYs = [r, char.height * 0.5, char.height - r];
  const sp = new THREE.Vector3();
  for (let iter = 0; iter < 2; iter++) {
    for (const sy of sphereYs) {
      sp.set(char.pos.x, char.pos.y + sy, char.pos.z);
      const before = sp.clone();
      resolveSphere(sp, r, world.colliders, out);
      char.pos.add(sp.sub(before));
    }
  }

  let grounded = false;
  if (out.hit) {
    if (out.ny > 0.55) { grounded = true; if (char.vel.y < 0) char.vel.y = 0; }
    else if (out.ny < -0.55 && char.vel.y > 0) char.vel.y = 0; // bonked head
    else {
      // wall — damp velocity into the wall a bit
      const n = new THREE.Vector3(out.nx, 0, out.nz);
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
    if (!inRampFootprint(ramp, char.pos.x, char.pos.z, char.radius + 0.2)) continue;
    const surf = rampSurfaceY(ramp, char.pos.x, char.pos.z);
    // Snap onto the surface only when walking/falling — never while rising,
    // or a jump from below would teleport the character through the slab.
    if (char.vel.y <= 0.01 && char.pos.y <= surf + 0.02 && char.pos.y > surf - 1.1) {
      char.pos.y = surf;
      if (char.vel.y < 0) char.vel.y = 0;
      grounded = true;
    } else {
      const obb = rampOBB(ramp);
      for (const sy of sphereYs) {
        sp.set(char.pos.x, char.pos.y + sy, char.pos.z);
        const before = sp.clone();
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

  // Jump pads: {x, y, z, r, vy, vx?, vz?}
  if (grounded && world.jumpPads) {
    for (const pad of world.jumpPads) {
      if (pad.playersOnly && !char.isPlayer) continue;
      if (Math.abs(char.pos.x - pad.x) < pad.r && Math.abs(char.pos.z - pad.z) < pad.r &&
          Math.abs(char.pos.y - pad.y) < 1.2) {
        char.vel.y = pad.vy;
        if (pad.vx) char.vel.x = pad.vx;
        if (pad.vz) char.vel.z = pad.vz;
        grounded = false;
        world.onPad?.(char);
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
      resolveSphereVec(sp, r, world.colliders, nOut);
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
      if (Math.abs(char.pos.x - pad.x) < pad.r && Math.abs(char.pos.z - pad.z) < pad.r &&
          Math.abs(char.pos.y - pad.y) < 1.2) {
        char.vel.y = pad.vy;
        if (pad.vx) char.vel.x = pad.vx;
        if (pad.vz) char.vel.z = pad.vz;
        grounded = false;
        world.onPad?.(char);
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
  for (const c of world.colliders) {
    if (c.type === 'box') {
      if (pointHitsBox(p, radius, c, world)) return true;
    } else if (c.type === 'sphere') {
      if (p.distanceToSquared(c.center) < (c.radius + radius) ** 2) return true;
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
export function hasLOS(a, b, world) {
  const dist = a.distanceTo(b);
  const steps = Math.ceil(dist / 1.2);
  for (let i = 1; i < steps; i++) {
    _los.lerpVectors(a, b, i / steps);
    if (pointHitsWorld(_los, 0.05, world, true)) return false;
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
