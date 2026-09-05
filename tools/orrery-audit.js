import * as THREE from "three";
import { Player } from "../src/player.js";
import { pointHitsWorld, moveCharacter } from "../src/engine.js";
import { orreryPose } from "../src/orrery-motion.js";
const V = (...p) => new THREE.Vector3(...p);
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
