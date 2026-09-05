import * as THREE from "three";
import { moveCharacter, pointHitsWorld } from "../src/engine.js";
const V = (...p) => new THREE.Vector3(...p);
const character = (position) => ({
  pos: V(...position),
  vel: V(),
  radius: 0.35,
  height: 1.8,
  alive: true,
  grounded: true,
});

// Exercises the actual game solver, with a stationary player or a walking
// direction, without weapon/HUD timing affecting deterministic geometry checks.
export function auditNeonTransit(world) {
  const failures = [],
    boarding = [],
    walking = [];
  let checks = 0,
    maxRiderDrift = 0;
  const check = (condition, message) => {
    checks++;
    if (!condition) failures.push(message);
  };
  const transit = world.transit,
    schedule = transit.schedule;
  const staticWorld = {
    ...world,
    collisionIndex: null,
    colliders: world.colliders.filter(
      (c) => !c.dynamic && c.debugName !== "neon-figure-eight-rail",
    ),
  };
  for (let t = 0; t < schedule.cycle; t += 0.1) {
    transit.update(0, t, []);
    for (const x of [-7.8, -4, 0, 4, 7.8])
      for (const y of [0.15, 1.5, 3.2])
        for (const z of [-2.42, 0, 2.42]) {
          const p = V(x, y, z).applyMatrix4(transit.group.matrixWorld);
          check(
            Math.abs(p.x) < 84.9 && Math.abs(p.z) < 63.9,
            "Train leaves city boundary",
          );
          check(
            !pointHitsWorld(p, 0.08, staticWorld),
            "Train intersects static city geometry",
          );
        }
  }
  for (let i = 0; i < 3; i++) {
    const t = schedule.stops[i] / schedule.speed + i * schedule.dwell + 2;
    transit.update(0, t, []);
    const ch = character([transit.pose.position[0], 10, 5.3]);
    for (let n = 0; n < 160; n++) {
      transit.update(0, t, [ch]);
      ch.vel.set(0, ch.vel.y, -4);
      ch.grounded = moveCharacter(ch, world, 1 / 60);
    }
    const passed = ch.pos.z < -4.5 && Math.abs(ch.pos.y - 10) < 0.1;
    boarding.push({ station: i, end: ch.pos.toArray(), passed });
    check(passed, "Station boarding passage blocked");
  }
  transit.update(0, 0, []);
  const rider = character([0, 10, 0]),
    inverse = new THREE.Matrix4();
  for (let t = 1 / 60; t <= schedule.cycle * 2; t += 1 / 60) {
    transit.update(1 / 60, t, [rider]);
    rider.vel.x = rider.vel.z = 0;
    rider.grounded = moveCharacter(rider, world, 1 / 60);
    const p = rider.pos
      .clone()
      .applyMatrix4(inverse.copy(transit.group.matrixWorld).invert());
    maxRiderDrift = Math.max(maxRiderDrift, Math.abs(p.x), Math.abs(p.z));
    check(
      Math.abs(p.x) < 8 && Math.abs(p.z) < 2.8 && p.y > -0.6,
      "Rider lost during a turn or incline",
    );
  }
  const routes = [...world.cityTransferRoutes, ...world.cityStationStairs];
  for (let ri = 0; ri < routes.length; ri++)
    for (const reverse of [false, true]) {
      const route = reverse ? [...routes[ri]].reverse() : routes[ri],
        ch = character(route[0]);
      let failure = null;
      for (let j = 1; j < route.length; j++) {
        const target = V(...route[j]);
        let elapsed = 0;
        while (
          Math.hypot(ch.pos.x - target.x, ch.pos.z - target.z) > 0.12 &&
          elapsed < 12
        ) {
          const direction = target.clone().sub(ch.pos);
          direction.y = 0;
          direction.normalize().multiplyScalar(4);
          ch.vel.x = direction.x;
          ch.vel.z = direction.z;
          ch.grounded = moveCharacter(ch, world, 1 / 60);
          elapsed += 1 / 60;
        }
        if (elapsed >= 12 || Math.abs(ch.pos.y - target.y) > 0.7) {
          failure = { leg: j, end: ch.pos.toArray(), target: target.toArray() };
          break;
        }
      }
      walking.push({ route: ri, reverse, failure });
      check(!failure, "New transfer requires jumping or has a gap");
    }
  transit.update(0, world._t || 0, []);
  return {
    checks,
    failures,
    boarding,
    walking,
    maxRiderDrift,
    cycleSeconds: schedule.cycle,
    routeLength: schedule.total,
  };
}
