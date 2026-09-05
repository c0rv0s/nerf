// Browser audit against real Three.js geometry, collision and navigation.
import * as THREE from "three";
import {
  triangleMeshSurfaceY,
  sphereHitsTriangleMesh,
  rayHitsTriangleMesh,
  buildWaypointGraph,
  pointHitsWorld,
} from "../src/engine.js";
import { canopyRiverOffset } from "../src/environment-design.js";
import { auditNeonTransit } from "./neon-audit.js";
import { rayTriangleCandidates } from "../src/triangle-ray-grid.js";
const V = (x, y, z) => new THREE.Vector3(x, y, z);

export function auditEnvironment(scene, world, mapId) {
  const failures = [];
  let checks = 0;
  const check = (condition, message) => {
    checks++;
    if (!condition) failures.push(message);
  };
  check(world.visualSurfaceIssues.length === 0, "Coplanar box surfaces");
  check(world.wallFeatureIssues.length === 0, "Overlapping wall features");
  const meshes = world.colliders.filter((c) => c.type === "triangleMesh");
  scene.traverse((o) => {
    if (o.geometry) {
      const a = o.geometry.attributes.position;
      check(a.array.every(Number.isFinite), `Nonfinite vertices: ${o.name}`);
    }
  });
  // Compare the indexed ray path with the original exhaustive triangle scan.
  let seed = 0x51de,
    candidates = 0,
    exhaustive = 0,
    rayChecks = 0;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const ray = new THREE.Ray(),
    point = V(),
    delta = V();
  for (const collider of meshes)
    for (let i = 0; i < 18; i++) {
      const center = collider.min.clone().add(collider.max).multiplyScalar(0.5);
      const span = collider.max.clone().sub(collider.min);
      const origin = center
        .clone()
        .add(
          V(
            (rnd() - 0.5) * (span.x + 20) * 2,
            (rnd() - 0.5) * (span.y + 20) * 2,
            (rnd() - 0.5) * (span.z + 20) * 2,
          ),
        );
      const target = center
        .clone()
        .add(
          V(
            (rnd() - 0.5) * span.x,
            (rnd() - 0.5) * span.y,
            (rnd() - 0.5) * span.z,
          ),
        );
      const direction = target.sub(origin).normalize();
      if (i % 6 === 0) direction.set(0, -1, 0);
      const max = i % 3 === 0 ? 15 : 500;
      let best = max,
        normal = null;
      ray.set(origin, direction);
      for (const entry of collider.triangles) {
        if (
          !ray.intersectTriangle(
            entry.triangle.a,
            entry.triangle.b,
            entry.triangle.c,
            false,
            point,
          )
        )
          continue;
        const t = delta.copy(point).sub(origin).dot(direction);
        if (t > 0.03 && t < best) {
          best = t;
          normal = entry.normal;
        }
      }
      const actual = rayHitsTriangleMesh(origin, direction, collider, max);
      check(
        normal ? actual && Math.abs(actual.t - best) < 1e-6 : actual === null,
        `Ray mismatch: ${collider.debugName} / ${i}`,
      );
      candidates += rayTriangleCandidates(
        collider,
        origin,
        direction,
        max,
      ).length;
      exhaustive += collider.triangles.length;
      rayChecks++;
    }
  if (mapId === "canopy" && world.environmentRoutes) {
    const bridges = meshes.filter((c) => c.debugName === "canopy-timber-span");
    for (const route of world.environmentRoutes) {
      const start = V(...route.start),
        end = V(...route.end),
        direction = end.clone().sub(start);
      const length = Math.hypot(direction.x, direction.z);
      const normal = V(direction.z / length, 0, -direction.x / length);
      for (let i = 1; i < 20; i++) {
        const t = i / 20,
          p = start.clone().lerp(end, t);
        p.y -= Math.sin(Math.PI * t) * route.sag;
        for (const side of [-0.4, 0, 0.4]) {
          const sample = p.clone().addScaledVector(normal, route.width * side);
          check(
            bridges.some((c) => {
              const y = triangleMeshSurfaceY(c, sample.x, sample.z);
              return y !== null && Math.abs(y - p.y) < 0.015;
            }),
            "Bridge has unsupported width",
          );
        }
        check(
          bridges.some((c) =>
            sphereHitsTriangleMesh(p.clone().add(V(0, 0.2, 0)), 0.35, c),
          ),
          "Bridge does not catch a landing sphere",
        );
        check(
          !bridges.some((c) =>
            sphereHitsTriangleMesh(p.clone().add(V(0, 1, 0)), 0.35, c),
          ),
          "Bridge blocks the walking capsule",
        );
      }
    }
    for (const center of [-54, 54])
      for (let z = -74; z < 77; z += 3) {
        const p = V(center + canopyRiverOffset(z, center), -2.5, z);
        check(
          !pointHitsWorld(p, 0.35, world),
          "River swim lane obstructed at " + p.toArray(),
        );
      }
    const log = meshes.find((c) => c.debugName === "canopy-hollow-fallen-log");
    check(
      log && !sphereHitsTriangleMesh(V(-27, 1.2, -24), 0.4, log),
      "Hollow log tunnel blocked",
    );
    check(
      log && sphereHitsTriangleMesh(V(-27, 3.45, -24), 0.3, log),
      "Hollow log roof not solid",
    );
  }
  if (mapId === "olympus") {
    const blocks = (x, y, z) =>
      world.colliders.some(
        (c) =>
          c.type === "box" &&
          x > c.min.x &&
          x < c.max.x &&
          z > c.min.z &&
          z < c.max.z &&
          y > c.min.y &&
          y < c.max.y,
      );
    check(!blocks(0, 90, 14), "Aether light court is filled");
    check(
      blocks(17, 90, 10) && blocks(-17, 90, 10),
      "Aether ramp landing removed",
    );
    check(blocks(0, 90, 24), "Aether dais floor removed");
    for (const link of world.manualLinks) {
      if (Math.abs(link[1] - 90.5) > 0.01 || Math.abs(link[4] - 90.5) > 0.01)
        continue;
      for (let i = 0; i <= 24; i++) {
        const t = i / 24,
          x = link[0] + (link[3] - link[0]) * t,
          z = link[2] + (link[5] - link[2]) * t;
        check(
          !(Math.abs(x) < 8.9 && z > 8 && z < 19.9),
          "Upper manual route crosses the light court",
        );
      }
    }
  }
  if (world.environmentBasinRoute) {
    const points = world.environmentBasinRoute;
    for (let i = 0; i < points.length; i++)
      for (let j = 0; j <= 20; j++) {
        const p = V(...points[i])
          .lerp(V(...points[(i + 1) % points.length]), j / 20)
          .add(V(0, 1, 0));
        check(
          !pointHitsWorld(p, 0.35, world),
          `Basin flank obstruction: ${i}/${j}`,
        );
      }
    for (const pad of world.jumpPads)
      if (pad.pos?.y < 1) {
        check(
          !world.olympusTalus.some((c) =>
            sphereHitsTriangleMesh(pad.pos.clone().add(V(0, 1, 0)), 0.35, c),
          ),
          "Foothill blocks recovery pad",
        );
      }
  }
  for (const vault of world.creekVaults || []) {
    for (let i = 0; i <= 12; i++) {
      const along = (i / 12 - 0.5) * vault.length;
      const p =
        vault.axis === "z"
          ? V(
              vault.x + canopyRiverOffset(vault.z + along, vault.x),
              -2.4,
              vault.z + along,
            )
          : V(vault.x + along, -2.4, vault.z);
      check(
        !pointHitsWorld(p, 0.35, world),
        "Creek vault blocks the swim passage",
      );
    }
  }
  for (const route of world.livingLimbRoutes || [])
    for (let i = 2; i <= 18; i++) {
      const p = V(...route.start).lerp(V(...route.end), i / 20);
      const y = triangleMeshSurfaceY(route.collider, p.x, p.z);
      check(
        y != null && Math.abs(y - p.y) < 0.15,
        "Living limb loses its walking crown",
      );
    }
  for (const m of world.fungalPlatforms || []) {
    const c = meshes.find(
      (c) =>
        c.debugName === "mycelium-organic-platform-cap" &&
        Math.abs((c.min.x + c.max.x) / 2 - m.x) < 0.1 &&
        Math.abs((c.min.z + c.max.z) / 2 - m.z) < 0.1,
    );
    check(
      c && Math.abs(triangleMeshSurfaceY(c, m.x, m.z) - m.y) < 0.02,
      "Mushroom landing height mismatch",
    );
    check(
      c && sphereHitsTriangleMesh(V(m.x, m.y - 0.1, m.z), 0.2, c),
      "Mushroom cap winding is inverted",
    );
  }
  if (world.lavaMoat) {
    check(
      world.lavaMoat.outerR - world.lavaMoat.innerR >= 260,
      "Lava moat is too narrow",
    );
    check(
      pointHitsWorld(V(200, -1.3, 0), 0.2, world),
      "Missing recessed lava bed",
    );
    check(
      !pointHitsWorld(V(200, 0.2, 0), 0.3, world),
      "Old ground slab fills the lava trench",
    );
    check(
      world.lavaMoat.floorY <= -1.3 && world.lavaMoat.surfaceY < 0,
      "Lava trench has no depth",
    );
  }
  const transit =
    mapId === "city" && world.transit ? auditNeonTransit(world) : null;
  if (transit) {
    checks += transit.checks;
    failures.push(...transit.failures);
  }
  if (["city", "fortress"].includes(mapId)) {
    const pickups = world.pickups.filter((p) => !p.moving);
    const overlap = (a, b) =>
      Math.hypot(a.x - b.x, a.z - b.z) ** 2 < 2.6 && Math.abs(a.y - b.y) < 2.2;
    for (const pool of Object.values(world.spawns))
      for (const spawn of pool) {
        check(
          !pointHitsWorld(spawn.clone().add(V(0, 1, 0)), 0.35, world),
          "Team spawn clearance",
        );
        check(
          !pickups.some((p) => overlap(p.pos, spawn)),
          "Spawn overlaps a pickup",
        );
      }
    for (let i = 0; i < pickups.length; i++)
      for (let j = i + 1; j < pickups.length; j++)
        check(!overlap(pickups[i].pos, pickups[j].pos), "Pickups overlap");
  }
  buildWaypointGraph(world);
  const visited = new Set(),
    components = [];
  for (let i = 0; i < world.waypoints.length; i++) {
    if (visited.has(i)) continue;
    const queue = [i];
    visited.add(i);
    for (let j = 0; j < queue.length; j++)
      for (const n of world.waypoints[queue[j]].links)
        if (!visited.has(n)) {
          visited.add(n);
          queue.push(n);
        }
    components.push(queue.length);
  }
  if (
    world.environmentRoutes ||
    world.environmentBasinRoute ||
    ["mycelium", "arena", "fortress", "city"].includes(mapId)
  )
    check(components.length === 1, "Disconnected environment navigation");
  const blockedSpawns = world.spawns.ffa
    .filter((p) => pointHitsWorld(p.clone().add(V(0, 1, 0)), 0.35, world))
    .map((p) => p.toArray());
  if (mapId !== "reef") check(blockedSpawns.length === 0, "Spawn clearance");
  return {
    map: mapId,
    transit,
    checks,
    failures,
    rayChecks,
    candidates,
    exhaustive,
    candidateReductionPercent: Math.round((1 - candidates / exhaustive) * 100),
    navigationComponents: components.sort((a, b) => b - a),
    blockedSpawns,
  };
}
