// Browser integration checks using the same movement and projectile code as play.
import * as THREE from "three";
import { Player } from "../src/player.js";
import { ProjectileSystem, WEAPONS } from "../src/weapons.js";
import { pointHitsWorld, triangleMeshSurfaceY } from "../src/engine.js";
const V = (...a) => new THREE.Vector3(...a);
export function auditSpace(scene, world, map) {
  const failures = [],
    details = {};
  let checks = 0;
  const check = (ok, label) => {
    checks++;
    if (!ok) failures.push(label);
  };
  const camera = new THREE.PerspectiveCamera(75, 1, 0.03, 3000);
  // Movement does not need weapon models or audio.
  const player = Object.create(Player.prototype);
  Object.assign(player, {
    camera,
    world,
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
  const step = () => {
    const previous = player.pos.clone();
    world._t = (world._t || 0) + 1 / 120;
    player._moveNormal(1 / 120);
    world.postCharacterMove?.(player, previous);
  };
  if (map === "bloom") {
    const crossings = [];
    for (const axis of ["x", "z"])
      for (const sign of [-1, 1])
        for (const inward of [false, true]) {
          player.pos.set(0, 0, 0);
          player.pos[axis] = sign * (inward ? 7.02 : 35.98);
          player.vel.set(0, 0, 0);
          player.grounded = true;
          player._bloomRecursionLevel = 0;
          const direction = sign * (inward ? -1 : 1);
          player.yaw =
            axis === "x"
              ? (-direction * Math.PI) / 2
              : direction > 0
                ? Math.PI
                : 0;
          player.moveInput.forward = 1;
          player.vel[axis] =
            direction * world.playerSpeed * world.characterMoveScale(player);
          let crossed = false;
          for (let i = 0; i < 20; i++) {
            const previous = player.pos.clone(),
              velocity = player.vel.clone(),
              scale = world.characterMoveScale(player);
            step();
            if (player._bloomRecursionLevel) {
              const factor = inward ? 36 / 7 : 7 / 36;
              const pace = Math.abs(
                player.vel[axis] / world.characterMoveScale(player),
              );
              check(
                Math.abs(pace - world.playerSpeed) < 0.1,
                `${axis}/${sign}/${inward}: seam walking pace`,
              );
              check(
                Math.abs(player.pos.y) < 0.01,
                `${axis}/${sign}/${inward}: floor continuity`,
              );
              check(
                Math.abs(
                  camera.position.y - 1.6 * world.characterVisualScale(player),
                ) < 0.00001,
                `${axis}/${sign}/${inward}: eye height`,
              );
              crossings.push({
                axis,
                sign,
                inward,
                pace,
                position: player.pos.toArray(),
                velocityRatio: player.vel[axis] / velocity[axis],
                factor,
              });
              crossed = true;
              break;
            }
          }
          check(crossed, `${axis}/${sign}/${inward}: crossed seam`);
        }
    details.crossings = crossings;
    player.pos.set(20, -2, 0);
    player.vel.set(0, -20, 0);
    player.moveInput.forward = 0;
    player.grounded = false;
    let maxSpeed = 0;
    for (let i = 0; i < 7200; i++) {
      step();
      maxSpeed = Math.max(maxSpeed, player.vel.length());
    }
    check(
      Number.isFinite(player.pos.y) && Math.abs(player.pos.y) <= 36.1,
      "Recursive fall remains canonical",
    );
    check(maxSpeed < 80, "Recursive fall stays bounded");
    details.twoMinuteFall = { maxSpeed, position: player.pos.toArray() };
    const shots = new ProjectileSystem(scene, world, {});
    const beams = [];
    const recursiveWeapon = {
      ...WEAPONS.refractor,
      recursiveBeam: true,
      recursionDamageGain: 6,
      recursionSizeGain: 0.2,
    };
    for (const [x, dx] of [
      [7, -1],
      [7.0005, -1],
      [36, 1],
      [35.9995, 1],
    ]) {
      const segments = shots.traceRecursiveBeam(
        V(x, 0.8, 0),
        V(dx, 0, 0),
        recursiveWeapon,
      );
      check(segments.length > 0, `Beam survives seam at ${x}`);
      check(
        segments.every((s) =>
          s.start.toArray().concat(s.end.toArray()).every(Number.isFinite),
        ),
        `Finite beam at ${x}`,
      );
      check(
        segments.every(
          (s) =>
            s.damage ===
            recursiveWeapon.dmg + s.stage * recursiveWeapon.recursionDamageGain,
        ),
        `Beam damage progression ${x}`,
      );
      beams.push({
        x,
        segments: segments.length,
        stages: segments.map((s) => s.stage),
      });
    }
    details.beams = beams;
    const shot = {
      pos: V(6.9, 0.1, 0),
      vel: V(-420, 0, 0),
      life: 10,
      weapon: WEAPONS.hyper,
      pierced: new Set(["target"]),
    };
    const factor = world.postProjectileMove(shot, V(7.1, 0.1, 0));
    check(
      factor > 1 && shot.pierced.size === 0,
      "Hyperstrike can pierce the same target in the next layer",
    );
    shots.geoBall.dispose();
  } else {
    const routes =
      map === "asteroids"
        ? world.asteroidStationRoutes
        : [
            [
              [0, 0.05, 0],
              [8, 0.05, 8],
              [8, 0.05, 25],
              [22, 0.05, 25],
              [28, 0.05, 20],
              [34, 0.05, 20],
            ],
            [
              [10, 7.4, 0],
              [22, 7.4, 0],
              [42, 7.4, 0],
              [34, 7.4, 0],
              [34, 7.4, 8],
              [42, 7.4, 8],
              [42, 7.4, 22],
              [37.5, 7.4, 22],
              [37.5, 7.4, 25],
              [35, 7.4, 25],
            ],
          ];
    details.walks = [];
    for (const route of routes)
      for (const reverse of [false, true]) {
        const points = reverse ? [...route].reverse() : route;
        player.pos.fromArray(points[0]);
        player.pos.y += 0.03;
        player.vel.set(0, 0, 0);
        player.grounded = true;
        player.moveInput.forward = 1;
        let reached = true,
          failedTarget = null;
        for (const target of points.slice(1)) {
          let arrived = false;
          for (let i = 0; i < 1000; i++) {
            const dx = target[0] - player.pos.x,
              dz = target[2] - player.pos.z;
            if (Math.hypot(dx, dz) < 0.24) {
              player.vel.x = player.vel.z = 0;
              arrived = true;
              break;
            }
            player.yaw = Math.atan2(-dx, -dz);
            step();
            if (player.pos.y < Math.min(...points.map((p) => p[1])) - 3) break;
          }
          if (!arrived) {
            reached = false;
            failedTarget = target;
            break;
          }
        }
        player.moveInput.forward=0;
        for(let i=0;i<180;i++)step();
        const landingError=Math.abs(player.pos.y-points.at(-1)[1]);
        check(!reached||landingError<.2, `${map} route ${routes.indexOf(route)} landing`);
        check(
          reached,
          `${map} route ${routes.indexOf(route)} ${reverse ? "reverse" : "forward"}`,
        );
        details.walks.push({
          route: routes.indexOf(route),
          reverse,
          reached,
          failedTarget,
          end: player.pos.toArray(),
        });
      }
    if (map === "asteroids")
      for (const rock of world.asteroidLandings) {
        const y = triangleMeshSurfaceY(rock.collider, rock.x, rock.z);
        check(Math.abs(y - rock.y) < 0.001, "Rock landing height");
      }
    if (map === "solar") {
      for (const [p, expected] of [
        [[0, 2, 0], 25],
        [[34, 2, 20], 25],
        [[42, 10, 0], 25],
        [[70, 10, 0], 4.8],
      ])
        check(world.gravityAt(V(...p)) === expected, `Gravity ${p}`);
    }
    details.spawnFailures = [];
    for (const p of [
      ...world.spawns.blue,
      ...world.spawns.red,
      ...world.spawns.ffa,
    ]) {
      const blocked = [0.5, 1, 1.5].some((h) =>
        pointHitsWorld(p.clone().add(V(0, h, 0)), 0.4, world),
      );
      check(!blocked, `Spawn body clearance ${p.toArray()}`);
      if (blocked) details.spawnFailures.push(p.toArray());
    }
  }
  return { map, checks, failures, details };
}
