import * as THREE from "three";
import { Player } from "../src/player.js";
import { pointHitsWorld, moveCharacter } from "../src/engine.js";
import { orreryPose } from "../src/orrery-motion.js";
const V = (...p) => new THREE.Vector3(...p);
export function auditOrreryGallerySlab(scene) {
  scene.updateMatrixWorld(true);
  const probes = [
    // Opening walls, including both notches beside the ramp landings.
    [[0, 9.4, 0], [1, 0, 0], 12],
    [[0, 9.4, 0], [-1, 0, 0], 12],
    [[0, 9.4, 0], [0, 0, -1], 10],
    [[0, 9.4, 0], [0, 0, 1], 10],
    [[10, 9.4, 8], [0, 0, 1], 1],
    [[-10, 9.4, 8], [0, 0, 1], 1],
    [[7, 9.4, 9.5], [1, 0, 0], 1],
    [[-7, 9.4, 9.5], [-1, 0, 0], 1],
    // Upper and lower faces, and the outside edge of the 1.2-unit slab.
    [[13, 10.5, 0], [0, -1, 0], 0.5],
    [[13, 8.3, 0], [0, 1, 0], 0.5],
    [[17, 9.4, 5], [-1, 0, 0], 1],
  ];
  const failures = [];
  for (const [origin, direction, distance] of probes) {
    const ray = new THREE.Raycaster(V(...origin), V(...direction), 0, distance + 0.05);
    const hit = ray.intersectObjects(scene.children, true)
      .find(h => h.object.material.color?.getHex() === 0x687f7a);
    if (!hit || Math.abs(hit.distance - distance) > 0.01)
      failures.push({ origin, direction, expected: distance, actual: hit?.distance });
  }
  return { checks: probes.length, failures, passed: failures.length === 0 };
}
// Collision is double-sided, so traversal alone cannot catch inside-out slabs.
// Probe the rendered stone from above and below with normal backface culling.
export function auditOrreryStairFaces(scene) {
  scene.updateMatrixWorld(true);
  const failures = [];
  let checks = 0;
  for (let k = 0; k < 4; k++) {
    for (const t of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const angle = k * Math.PI / 2 + 0.94 - t * 0.64;
      for (const radius of [48, 50.5, 53]) {
        for (const underside of [false, true]) {
          const y = t * 10 - (underside ? 0.5 : 0);
          const direction = underside ? 1 : -1;
          const ray = new THREE.Raycaster(
            V(radius * Math.cos(angle), y - direction * 0.2, radius * Math.sin(angle)),
            V(0, direction, 0), 0, 0.4,
          );
          const hits = ray.intersectObjects(scene.children, true);
          const stone = hits.find(h => h.object.material.color?.getHex() === 0xc5cabe);
          checks++;
          if (!stone || Math.abs(stone.point.y - y) > 0.025)
            failures.push({ stair: k, t, radius, underside });
        }
      }
    }
  }
  return { checks, failures, passed: failures.length === 0 };
}
function actor(world) {
  const p = Object.create(Player.prototype);
  Object.assign(p, {
    world,
    camera: new THREE.PerspectiveCamera(),
    pos: V(0, 0, 0),
    vel: V(0, 0, 0),
    up: V(0, 1, 0),
    radius: 0.45,
    height: 1.8,
    eyeHeight: 1.6,
    isPlayer: true,
    alive: true,
    grounded: true,
    keys: {},
    moveInput: { forward: 0, strafe: 0 },
    yaw: 0,
    pitch: 0,
    paralyzeT: 0,
    coyote: 0,
    jumpBuffer: 0,
    djumpTime: 0,
  });
  return p;
}
export function auditOrreryRoute(world, index, reverse = false) {
  const route = world.orreryRoutes[index],
    points = reverse ? [...route].reverse() : route,
    p = actor(world);
  p.pos.fromArray(points[0]);
  p.pos.y += 0.03;
  world.orrery.update(0, 2, []);
  const result = {
    index,
    reverse,
    passed: true,
    failedTarget: null,
    lowest: p.pos.y,
  };
  for (const target of points.slice(1)) {
    p.moveInput.forward = 1;
    let arrived = false;
    for (let step = 0; step < 1800; step++) {
      const dx = target[0] - p.pos.x,
        dz = target[2] - p.pos.z;
      if (Math.hypot(dx, dz) < 0.24) {
        arrived = true;
        p.vel.x = p.vel.z = 0;
        break;
      }
      p.yaw = Math.atan2(-dx, -dz);
      p._moveNormal(1 / 120);
      result.lowest = Math.min(result.lowest, p.pos.y);
      if (p.pos.y < -4) break;
    }
    if (!arrived) {
      result.passed = false;
      result.failedTarget = target;
      break;
    }
  }
  p.moveInput.forward = 0;
  for (let i = 0; i < 180; i++) p._moveNormal(1 / 120);
  result.end = p.pos.toArray();
  result.landingError = Math.abs(p.pos.y - points.at(-1)[1]);
  result.passed &&= result.landingError < 0.2;
  return result;
}
export function auditOrreryBoarding(world) {
  const results = [];
  for (let station = 0; station < 4; station++)
    for (const reverse of [false, true]) {
      const a = (station * Math.PI) / 2,
        time = station * 18 + 2,
        p = actor(world);
      const radii = reverse ? [44.5, 35, 27, 22, 18] : [18, 22, 27, 35, 44.5];
      p.pos.set(Math.cos(a) * radii[0], 10.04, Math.sin(a) * radii[0]);
      world.orrery.update(0, time, []);
      let passed = true,
        failedTarget = null;
      for (const radius of radii.slice(1)) {
        const target = V(Math.cos(a) * radius, 10, Math.sin(a) * radius);
        p.moveInput.forward = 1;
        let arrived = false;
        for (let i = 0; i < 1000; i++) {
          const dx = target.x - p.pos.x,
            dz = target.z - p.pos.z;
          if (Math.hypot(dx, dz) < 0.2) {
            arrived = true;
            p.vel.x = p.vel.z = 0;
            break;
          }
          p.yaw = Math.atan2(-dx, -dz);
          p._moveNormal(1 / 120);
          if (p.pos.y < 8) break;
        }
        if (!arrived) {
          passed = false;
          failedTarget = radius;
          break;
        }
      }
      results.push({
        station,
        reverse,
        passed,
        end: p.pos.toArray(),
        failedTarget,
      });
    }
  for (const radius of [22, 27, 38])
    for (const hz of [30, 120]) {
      const p = actor(world);
      p.pos.set(radius, radius === 27 ? 10 : 9.96, 0);
      p.grounded = true;
      world.orrery.update(0, 2, []);
      let minY = p.pos.y;
      for (let i = 1; i <= 16 * hz; i++) {
        world.orrery.update(1 / hz, 2 + i / hz, [p]);
        p.grounded = moveCharacter(p, world, 1 / hz);
        minY = Math.min(minY, p.pos.y);
      }
      results.push({
        rideRadius: radius,
        hz,
        passed:
          Math.abs(p.pos.x) < 0.06 &&
          Math.abs(p.pos.z - radius) < 0.06 &&
          minY > 9.7,
        end: p.pos.toArray(),
        minY,
      });
    }
  return results;
}
export function auditOrreryClearance(world) {
  const blocked = [];
  for (const p of [
    ...world.spawns.blue,
    ...world.spawns.red,
    ...world.spawns.ffa,
  ])
    if (
      [0.5, 1, 1.5].some((h) =>
        pointHitsWorld(p.clone().add(V(0, h, 0)), 0.4, world),
      )
    )
      blocked.push(p.toArray());
  const pickups = world.pickups
    .filter((p) => pointHitsWorld(p.pos.clone().add(V(0, 0.6, 0)), 0.25, world))
    .map((p) => ({ kind: p.kind, pos: p.pos.toArray() }));
  return { blockedSpawns: blocked, blockedPickups: pickups };
}
