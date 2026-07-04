// NPC bots: waypoint patrol + combat (strafe, aim with error, fire).
// On low-gravity maps they make ballistic jumps between waypoints.
import * as THREE from 'three';
import { moveCharacter, hasLOS, findPath, nearestWaypoint, rand, pick, clamp } from './engine.js';
import { WEAPONS, WEAPON_ORDER, buildBlaster } from './weapons.js';
import { aiTex } from './maps.js';

function buildBotMesh(color) {
  const g = new THREE.Group();
  const skin = (c, extra = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.7, ...extra });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.8, 4, 10),
    skin(color, aiTex('suit', 2, 1)));
  body.position.y = 0.85;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 10), skin(0xf0c090));
  head.position.y = 1.62;
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.14, 0.2),
    skin(0x203040, { emissive: color, emissiveIntensity: 0.6 }));
  visor.position.set(0, 1.66, 0.22);
  for (const m of [body, head, visor]) m.castShadow = true;
  g.add(body, head, visor);
  return { group: g };
}

export class Bot {
  constructor(scene, world, team, name, color = 0x2e7fd8) {
    this.world = world;
    this.team = team;
    this.name = name;
    this.isPlayer = false;

    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.radius = 0.45;
    this.height = 1.8;

    this.hp = 100;
    this.alive = true;
    this.kills = 0; this.deaths = 0;
    this.damageMult = 1;
    this.powerup = null;
    this.weapons = { blaster: true };
    this.ammo = { blaster: Infinity };
    this.weapon = 'blaster';
    this.cooldown = 0;

    this.grounded = false;
    this.path = null;
    this.pathIdx = 0;
    this.target = null;
    this.strafeDir = 1;
    this.strafeTimer = 0;
    this.moveAngle = 0;
    this.thinkTimer = rand(0, 0.4);
    this.aimError = rand(0.13, 0.24);   // generous spray — these are toy darts
    this.reactionTimer = 0;             // pause before opening fire on a new target
    this.facing = 0;                    // desired facing
    this.aimYaw = rand(-Math.PI, Math.PI); // actual facing — turns at a finite rate
    this.lastAttacker = null;
    this.alertTimer = 0;                // "just got shot" — may turn on the attacker

    const { group } = buildBotMesh(color);
    this.mesh = group;
    this._gunId = null;
    this._gun = null;
    scene.add(this.mesh);
  }

  // Show the weapon the bot is actually holding
  syncGunModel() {
    if (this.weapon === this._gunId) return;
    this._gunId = this.weapon;
    if (this._gun) this.mesh.remove(this._gun);
    this._gun = buildBlaster(this.weapon);
    this._gun.scale.setScalar(0.55);
    this._gun.position.set(0.32, 1.05, 0.25);
    this._gun.rotation.y = Math.PI; // muzzle forward (+z, the bot's facing)
    this.mesh.add(this._gun);
  }

  spawn(pos) {
    this.pos.copy(pos);
    this.vel.set(0, 0, 0);
    this.hp = 100;
    this.alive = true;
    this.damageMult = 1;
    this.powerup = null;
    this.weapons = { blaster: true };
    this.ammo = { blaster: Infinity };
    this.weapon = 'blaster';
    this.path = null;
    this.target = null;
    this.mesh.visible = true;
  }

  die() {
    this.alive = false;
    this.mesh.visible = false;
  }

  bestWeapon() {
    for (const id of [...WEAPON_ORDER].reverse()) {
      if (id === 'blaster' || (this.weapons[id] && this.ammo[id] > 0)) return id;
    }
    return 'blaster';
  }

  eye() { return new THREE.Vector3(this.pos.x, this.pos.y + 1.55, this.pos.z); }

  // Target acquisition with human-ish senses:
  //  - vision limited to a ~140° cone around current facing
  //  - "hearing": very close enemies are noticed regardless of facing
  //  - getting shot reveals the attacker for a few seconds
  //  - stickiness: keep fighting the current target instead of hopping to whoever's nearest
  think(characters) {
    const myEye = this.eye();
    const eyeOf = (ch) => ch.eye ? ch.eye() : new THREE.Vector3(ch.pos.x, ch.pos.y + 1.5, ch.pos.z);

    // Just got shot by someone new? Turn on the attacker — even mid-fight.
    const atk = this.lastAttacker;
    if (this.alertTimer > 0 && atk && atk.alive && atk !== this.target && atk !== this &&
        atk.team !== this.team && atk.pos.distanceTo(this.pos) < 60 &&
        hasLOS(myEye, eyeOf(atk), this.world)) {
      this.target = atk;
      this.reactionTimer = rand(0.3, 0.6);
      this.weapon = this.bestWeapon();
      this.repath(false);
      return;
    }

    // stay on the current target while it's alive and visible
    if (this.target && this.target.alive &&
        this.target.pos.distanceTo(this.pos) < 60 &&
        hasLOS(myEye, eyeOf(this.target), this.world)) {
      this.weapon = this.bestWeapon();
      this.repath(false);
      return;
    }

    let best = null, bd = Infinity;
    for (const ch of characters) {
      if (ch === this || !ch.alive || ch.team === this.team) continue;
      const d = ch.pos.distanceTo(this.pos);
      if (d > 55 || d >= bd) continue;
      const dirTo = Math.atan2(ch.pos.x - this.pos.x, ch.pos.z - this.pos.z);
      const inFov = Math.abs(angDiff(dirTo, this.aimYaw)) < 1.22; // ~140° cone
      const heard = d < 8;
      const alerted = this.alertTimer > 0 && ch === this.lastAttacker;
      if (!inFov && !heard && !alerted) continue;
      if (hasLOS(myEye, eyeOf(ch), this.world)) { best = ch; bd = d; }
    }
    if (best && best !== this.target) this.reactionTimer = rand(0.4, 0.9);
    this.target = best;
    this.weapon = this.bestWeapon();
    if (this.weapon !== 'blaster' && !(this.ammo[this.weapon] > 0)) this.weapon = 'blaster';
    this.repath(false);
  }

  // The nearest pickup worth a detour: point orbs and medals above all, then
  // guns we don't own, dropped weapons, and health when hurting.
  bestLoot() {
    const items = this.world.getPickups ? this.world.getPickups() : [];
    let best = null, bs = Infinity;
    for (const it of items) {
      if (!it.active) continue;
      const k = it.def.kind;
      const want = k === 'points' || k === 'gold' || k === 'silver' || k === 'drop' ||
        (k === 'weapon' && !(this.weapons[it.def.weapon] && this.ammo[it.def.weapon] > 0)) ||
        (k === 'health' && this.hp < 60);
      if (!want) continue;
      const d = it.def.pos.distanceTo(this.pos);
      if (d > 80) continue;
      const priority = k === 'points' ? d * 0.4 : (k === 'gold' || k === 'silver') ? d * 0.6 : d;
      if (priority < bs) { bs = priority; best = it; }
    }
    return best;
  }

  // Repath occasionally, or when the path is exhausted
  repath(force) {
    if (!force && this.path && this.pathIdx < this.path.length && Math.random() >= 0.06) return;
    const from = nearestWaypoint(this.world, this.pos);
    const aggression = this.world.gravity < 12 ? 0.35 : 0.7;
    let to;
    const loot = this.bestLoot();
    if (this.target && Math.random() < aggression) {
      to = nearestWaypoint(this.world, this.target.pos); // push toward the fight
    } else if (loot && Math.random() < 0.8) {
      to = nearestWaypoint(this.world, loot.def.pos);    // go shopping
    } else {
      to = Math.floor(Math.random() * this.world.waypoints.length);
    }
    this.path = findPath(this.world, from, to) || [from];
    this.pathIdx = 0;
  }

  update(dt, characters, fire) {
    if (!this.alive) return;

    this.thinkTimer -= dt;
    if (this.thinkTimer <= 0) {
      this.thinkTimer = 0.4;
      this.think(characters);
    }
    this.reactionTimer -= dt;
    this.alertTimer -= dt;

    const speed = this.world.playerSpeed * 0.82;
    const lowGrav = this.world.gravity < 12;
    let moveX = 0, moveZ = 0;

    // --- navigation ---
    let wpTarget = null;
    if (this.path && this.pathIdx < this.path.length) {
      wpTarget = this.world.waypoints[this.path[this.pathIdx]].pos;
      const flatD = Math.hypot(wpTarget.x - this.pos.x, wpTarget.z - this.pos.z);
      // flat platform tops now — no sphere shoulders to avoid, keep it tight
      if (flatD < 2.2 && Math.abs(wpTarget.y - this.pos.y) < 3) this.pathIdx++;
    }

    if (this.target && !lowGrav) {
      // combat: run around — pick a fresh maneuver (an angle relative to the
      // target direction) every second or so, with the odd dodge-hop
      const to = new THREE.Vector3().subVectors(this.target.pos, this.pos);
      to.y = 0;
      const dist = to.length();
      to.normalize();
      this.strafeTimer -= dt;
      if (this.strafeTimer <= 0) {
        this.strafeTimer = rand(0.5, 1.3);
        const angles = dist > 24
          ? [-50, -25, 0, 0, 25, 50, -90, 90]        // far: weave closer
          : dist < 8
            ? [140, 180, -140, -100, 100]            // too close: back off
            : [-110, -70, -45, 45, 70, 110, 150, -150]; // mid: orbit & juke
        this.moveAngle = pick(angles) * Math.PI / 180;
        if (this.grounded && Math.random() < 0.22) this.vel.y = this.world.jumpVel; // dodge hop
      }
      const ca = Math.cos(this.moveAngle), sa = Math.sin(this.moveAngle);
      moveX = to.x * ca - to.z * sa;
      moveZ = to.z * ca + to.x * sa;
      this.facing = Math.atan2(to.x, to.z);
    } else if (wpTarget) {
      // On low-grav maps bots keep waypoint-hopping even in combat —
      // strafing on curved asteroid surfaces slides them into the void.
      const to = new THREE.Vector3().subVectors(wpTarget, this.pos);
      const dy = to.y; to.y = 0;
      const d = to.length();
      if (d > 0.1) { to.normalize(); moveX = to.x; moveZ = to.z; }
      this.facing = this.target
        ? Math.atan2(this.target.pos.x - this.pos.x, this.target.pos.z - this.pos.z)
        : Math.atan2(moveX, moveZ);

      if (this.grounded) {
        if (lowGrav && (d > 10 || dy > 2.5)) {
          // Exact ballistic hop: touch down on the waypoint at time T (the
          // apex of the solved arc is always at or above the target, and the
          // integrator lands a hair low — straight into the platform top).
          const T = clamp(d / 11, 1.4, 3.6);
          this.vel.x = (wpTarget.x - this.pos.x) / T;
          this.vel.z = (wpTarget.z - this.pos.z) / T;
          this.vel.y = dy / T + 0.5 * this.world.gravity * T;
          this.pos.y += 0.4; // clear the launch surface
          this.grounded = false;
        } else if (!lowGrav && dy > 1 && d < 4) {
          this.vel.y = this.world.jumpVel; // small hop up ledges
        }
      }
    }

    // --- movement physics ---
    // Mid-flight on low grav: commit fully to the ballistic hop — steering
    // would drag the horizontal speed toward walk speed and land them short.
    const inFlight = lowGrav && !this.grounded;
    if (!inFlight) {
      const ml = Math.hypot(moveX, moveZ);
      if (ml > 1) { moveX /= ml; moveZ /= ml; }
      const accel = this.grounded ? 8 : 1.5;
      this.vel.x += (moveX * speed - this.vel.x) * Math.min(1, accel * dt);
      this.vel.z += (moveZ * speed - this.vel.z) * Math.min(1, accel * dt);
    }
    const wasAirborne = !this.grounded;
    this.grounded = moveCharacter(this, this.world, dt);
    if (lowGrav && wasAirborne && this.grounded) {
      // kill landing momentum so we don't skid off the asteroid's curve
      this.vel.x *= 0.15; this.vel.z *= 0.15;
    }

    // --- turn toward the desired facing at a finite rate (no instant snaps) ---
    const maxTurn = 4 * dt;
    this.aimYaw += clamp(angDiff(this.facing, this.aimYaw), -maxTurn, maxTurn);

    // --- shooting (only once actually facing the target) ---
    this.cooldown -= dt;
    const aligned = this.target && Math.abs(angDiff(
      Math.atan2(this.target.pos.x - this.pos.x, this.target.pos.z - this.pos.z),
      this.aimYaw)) < 0.3;
    if (this.target && aligned && this.cooldown <= 0 && this.reactionTimer <= 0) {
      const w = WEAPONS[this.weapon];
      const origin = this.eye();
      const aimAt = new THREE.Vector3(
        this.target.pos.x + rand(-1, 1) * this.aimError * 10,
        this.target.pos.y + 1.2 + rand(-1, 1) * this.aimError * 8,
        this.target.pos.z + rand(-1, 1) * this.aimError * 10);
      // lead the target a little (sloppily — beatable on the move)
      if (this.target.vel) aimAt.addScaledVector(this.target.vel, origin.distanceTo(aimAt) / w.speed * 0.35);
      const dir = aimAt.sub(origin).normalize();
      fire(this, origin.addScaledVector(dir, 0.8), dir, this.weapon);
      if (this.weapon !== 'blaster') this.ammo[this.weapon]--;
      this.cooldown = 1 / w.rof + rand(0.25, 0.6);
    }

    // --- visuals ---
    this.syncGunModel();
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.y = this.aimYaw;

    if (this.powerup) {
      this.powerup.timeLeft -= dt;
      if (this.powerup.timeLeft <= 0) { this.powerup = null; this.damageMult = 1; }
    }
  }
}

export const BOT_NAMES = ['Whiplash', 'Tornado', 'Cyclone', 'Vortex', 'Blitz', 'Comet', 'Turbo', 'Zapper'];

function angDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
