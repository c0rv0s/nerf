// NPC bots: waypoint patrol + combat (strafe, aim with error, fire).
// On low-gravity maps they make ballistic jumps between waypoints.
import * as THREE from 'three';
import { moveCharacter, moveCharacterUp, cardinal, hasLOS, findPath, nearestWaypoint, rand, pick, clamp } from './engine.js';
import { WEAPONS, WEAPON_ORDER, buildBlaster } from './weapons.js';
import { aiTex } from './maps.js';

export function buildBotMesh(color) {
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
    this.shield = 0;
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
    this.shopping = null;               // pickup we're heading for (refreshed each think)
    this.lootLock = 0;                  // seconds of shopping focus after a kill drop
    this.stuckT = 0;                    // seconds of no progress while wanting to move
    this._stuckCheck = 1.5;
    this._lastPos = new THREE.Vector3();
    this.avoid = null;                  // pickup we gave up on (proved unreachable)
    this.avoidT = 0;

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
    this.shield = 0;
    this.alive = true;
    this.damageMult = 1;
    this.speedMult = 1;
    this.speedTime = 0;
    this.powerup = null;
    this.weapons = { blaster: true };
    this.ammo = { blaster: Infinity };
    this.weapon = 'blaster';
    this.path = null;
    this.target = null;
    this.shopping = null;
    this.lootLock = 0;
    this.stuckT = 0;
    this._lastPos.copy(pos);
    this.avoid = null;
    this.avoidT = 0;
    this._roam = null;
    // PRISM RUN: orient to whatever surface we spawned on
    if (this.world.escher) {
      this.up = this.up || new THREE.Vector3(0, 1, 0);
      this.up.set(0, 1, 0);
      const nf = this._nearSurf();
      if (nf) this.up.copy(nf);
    }
    this.mesh.visible = true;
  }

  // Nearest waypoint the bot can actually reach: same floor and clear line of
  // sight. The plain nearest one is often through a wall or directly above —
  // pathing from it left bots grinding into walls until the match ended.
  reachableNearest() {
    const wps = this.world.waypoints;
    const ranked = wps.map((w, i) =>
      [w.pos.distanceTo(this.pos) + (Math.abs(w.pos.y - this.pos.y) > 2.6 ? 60 : 0), i])
      .sort((a, b) => a[0] - b[0]);
    const eye = this.eye();
    for (let k = 0; k < Math.min(8, ranked.length); k++) {
      const w = wps[ranked[k][1]].pos;
      if (hasLOS(eye, new THREE.Vector3(w.x, w.y + 1.5, w.z), this.world)) return ranked[k][1];
    }
    return ranked[0][1];
  }

  // A kill just dropped point orbs — beeline for them before someone steals them.
  noticeDrop(pos) {
    if (this.pos.distanceTo(pos) > 45) return;
    const from = this.reachableNearest();
    const to = nearestWaypoint(this.world, pos);
    this.path = findPath(this.world, from, to) || [from];
    this.pathIdx = 0;
    this.lootLock = 4;
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
    this.shopping = this.bestLoot();
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
      if (!it.active || it === this.avoid) continue;
      const k = it.def.kind;
      const want = k === 'points' || k === 'gold' || k === 'silver' || k === 'drop' ||
        (k === 'weapon' && !(this.weapons[it.def.weapon] && this.ammo[it.def.weapon] > 0)) ||
        (k === 'health' && this.hp < 60) ||
        (k === 'shield' && !(this.shield > 0)) ||
        (k === 'speed' && !(this.speedMult > 1));
      if (!want) continue;
      const d = it.def.pos.distanceTo(this.pos);
      if (d > 80) continue;
      const priority = k === 'points' ? d * 0.3 : (k === 'gold' || k === 'silver') ? d * 0.6 : d;
      if (priority < bs) { bs = priority; best = it; }
    }
    return best;
  }

  // Repath occasionally, or when the path is exhausted
  repath(force) {
    // committed to a fresh kill drop — don't let combat rolls redirect us
    if (!force && this.lootLock > 0 && this.path && this.pathIdx < this.path.length) return;
    if (!force && this.path && this.pathIdx < this.path.length && Math.random() >= 0.06) return;
    const from = this.reachableNearest();
    const aggression = this.world.gravity < 12 ? 0.35 : 0.7;
    let to;
    const loot = this.bestLoot();
    if (this.target && Math.random() < aggression) {
      to = nearestWaypoint(this.world, this.target.pos); // push toward the fight
    } else if (loot && Math.random() < 0.8) {
      to = nearestWaypoint(this.world, loot.def.pos);    // go shopping
      // already standing at the item's waypoint but can't actually grab it
      // (wrong floor, ledge above, …) — stop staring at the wall and move on
      if (to === from && this.pos.distanceTo(loot.def.pos) > 3) {
        to = Math.floor(Math.random() * this.world.waypoints.length);
      }
    } else {
      to = Math.floor(Math.random() * this.world.waypoints.length);
    }
    this.path = findPath(this.world, from, to) || [from];
    this.pathIdx = 0;
  }

  // Outward cardinal normal of the nearest surface (which way is "up" here),
  // biased toward the current up so it doesn't flip-flop between two surfaces.
  _nearSurf() {
    const mid = this.pos.clone().addScaledVector(this.up, this.height * 0.5);
    let best = null, bd = Infinity;
    for (const c of this.world.colliders) {
      if (c.type !== 'box') continue;
      const cx = clamp(mid.x, c.min.x, c.max.x), cy = clamp(mid.y, c.min.y, c.max.y), cz = clamp(mid.z, c.min.z, c.max.z);
      const dx = mid.x - cx, dy = mid.y - cy, dz = mid.z - cz;
      let d2 = dx * dx + dy * dy + dz * dz;
      if (d2 <= 1e-4) continue;
      const n = cardinal(new THREE.Vector3(dx, dy, dz));
      if (n.dot(this.up) > 0.9) d2 -= 9;
      if (d2 < bd) { bd = d2; best = n; }
    }
    return best;
  }

  /* PRISM RUN: bots wall-walk too. They head for a goal (an enemy, else a
     random surface waypoint), run up walls they hit, hop across to other
     faces, and shoot at anything they can see — feet on any surface. */
  updateEscher(dt, characters, fire) {
    if (!this.up) this.up = new THREE.Vector3(0, 1, 0);
    if (!this._nrm) this._nrm = new THREE.Vector3();
    const UPY = new THREE.Vector3(0, 1, 0);
    const up = this.up;

    this.thinkTimer -= dt;
    if (this.thinkTimer <= 0) {
      this.thinkTimer = 0.4;
      // nearest enemy in line of sight becomes the target
      const eye = this.pos.clone().addScaledVector(up, 1.4);
      let best = null, bd = 1e9;
      for (const ch of characters) {
        if (ch === this || !ch.alive || ch.team === this.team) continue;
        const d = ch.pos.distanceTo(this.pos);
        if (d > 60 || d >= bd) continue;
        const te = ch.pos.clone().addScaledVector(ch.up || UPY, 1.2);
        if (hasLOS(eye, te, this.world)) { best = ch; bd = d; }
      }
      if (best && best !== this.target) this.reactionTimer = rand(0.3, 0.7);
      this.target = best;
      this.weapon = this.bestWeapon();
      if (this.weapon !== 'blaster' && !(this.ammo[this.weapon] > 0)) this.weapon = 'blaster';
    }
    this.reactionTimer -= dt; this.alertTimer -= dt;
    if (this.speedTime > 0) { this.speedTime -= dt; if (this.speedTime <= 0) this.speedMult = 1; }

    // pick / refresh a roam goal on some face
    const wps = this.world.faceWps || [];
    if (!this._roam || this.pos.distanceTo(this._roam) < 4 || Math.random() < 0.02 * (dt * 60)) {
      if (wps.length) this._roam = wps[Math.floor(Math.random() * wps.length)];
    }
    // Wanderlust: every so often commit to a DIFFERENT face for a few seconds,
    // ignoring the fight, so bots spread across the walls and ceiling instead
    // of all piling onto the floor. Bias the pick toward far-off surfaces.
    this._faceCommitT = (this._faceCommitT || 0) - dt;
    if (this._faceCommitT < -rand(3, 7)) {
      this._faceCommitT = rand(2.5, 4.5);
      let pickWp = null, tries = 0;
      while (tries++ < 6) {
        const w = wps[Math.floor(Math.random() * wps.length)];
        if (w && (!this.up || Math.abs((new THREE.Vector3().subVectors(w, this.pos)).normalize().dot(this.up)) < 0.6)) { pickWp = w; break; }
      }
      this._faceGoal = pickWp || wps[Math.floor(Math.random() * wps.length)];
    }
    const committing = this._faceCommitT > 0 && this._faceGoal;
    const goal = committing ? this._faceGoal
      : (this.target && this.target.alive) ? this.target.pos : (this._roam || this.pos);

    // move toward the goal, flattened onto the surface we're standing on
    const speed = this.world.playerSpeed * 0.8 * (this.speedMult || 1);
    const toGoal = new THREE.Vector3().subVectors(goal, this.pos);
    const goalUp = toGoal.dot(up);                         // how far the goal is "above" us
    const mv = toGoal.clone().addScaledVector(up, -goalUp);
    const md = mv.length();
    if (md > 0.5) mv.multiplyScalar(1 / md); else mv.set(0, 0, 0);

    const vUp = this.vel.dot(up);
    const planar = this.vel.clone().addScaledVector(up, -vUp);
    const accel = this.grounded ? 8 : 2;
    planar.addScaledVector(mv.clone().multiplyScalar(speed).sub(planar), Math.min(1, accel * dt));
    this.vel.copy(planar).addScaledVector(up, vUp);

    // jump: to reach a goal on another face (goal is "above" us) or the odd hop
    this._jumpT = (this._jumpT || 0) - dt;
    if (this.grounded && this._jumpT <= 0 && (goalUp > 3.5 || (md > 2 && Math.random() < 0.03))) {
      this.vel.addScaledVector(up, this.world.jumpVel);
      this.vel.addScaledVector(mv, speed * 0.6);           // leap toward the goal
      this._jumpT = 1.0;
    }

    // airborne → gravity toward nearest surface; grounded → climb walls ahead
    if (!this.grounded) { const nf = this._nearSurf(); if (nf && nf.dot(up) < 0.99) this.up.copy(nf); }
    this.grounded = moveCharacterUp(this, this.world, dt, this._nrm);
    if (this.grounded) this._climbEscher(mv);

    // aim + fire at the target from any orientation
    this.cooldown -= dt;
    if (this.target && this.target.alive && this.cooldown <= 0 && this.reactionTimer <= 0) {
      const w = WEAPONS[this.weapon];
      const origin = this.pos.clone().addScaledVector(up, 1.4);
      const aim = this.target.pos.clone().addScaledVector(this.target.up || UPY, 0.9);
      const e = this.aimError * 9;
      aim.x += rand(-1, 1) * e; aim.y += rand(-1, 1) * e; aim.z += rand(-1, 1) * e;
      const dir = aim.sub(origin).normalize();
      this._face = dir.clone();
      fire(this, origin.addScaledVector(dir, 0.9), dir, this.weapon);
      if (this.weapon !== 'blaster') this.ammo[this.weapon]--;
      this.cooldown = 1 / w.rof + rand(0.3, 0.7);
    }

    // orient the mesh upright on its surface, facing its heading/target
    let face = (this.target ? new THREE.Vector3().subVectors(this.target.pos, this.pos) : mv.clone());
    face.addScaledVector(up, -face.dot(up));
    if (face.lengthSq() < 0.01) { face.set(1, 0, 0).addScaledVector(up, -up.x); }
    face.normalize();
    this.mesh.position.copy(this.pos).addScaledVector(up, 0);
    this.mesh.quaternion.setFromRotationMatrix(
      new THREE.Matrix4().lookAt(new THREE.Vector3(), face.clone().negate(), up));
    this.syncGunModel();
    if (this.powerup) { this.powerup.timeLeft -= dt; if (this.powerup.timeLeft <= 0) { this.powerup = null; this.damageMult = 1; } }
  }

  _climbEscher(mv) {
    if (mv.lengthSq() < 0.25) return;
    const probe = this.pos.clone().addScaledVector(mv, this.radius + 0.5).addScaledVector(this.up, 0.7);
    let solid = false;
    for (const c of this.world.colliders) {
      if (c.type !== 'box') continue;
      if (probe.x > c.min.x && probe.x < c.max.x && probe.y > c.min.y && probe.y < c.max.y &&
          probe.z > c.min.z && probe.z < c.max.z) { solid = true; break; }
    }
    if (!solid) return;
    const oldUp = this.up.clone();
    this.up.copy(cardinal(mv.clone().negate()));
    this.pos.addScaledVector(this.up, 0.06);
    this.vel.copy(oldUp).multiplyScalar(Math.max(this.vel.length(), 6));
  }

  update(dt, characters, fire) {
    if (!this.alive) return;
    if (this.world.escher) return this.updateEscher(dt, characters, fire);

    this.thinkTimer -= dt;
    if (this.thinkTimer <= 0) {
      this.thinkTimer = 0.4;
      this.think(characters);
    }
    this.reactionTimer -= dt;
    this.alertTimer -= dt;
    this.lootLock -= dt;
    this.avoidT -= dt;
    if (this.avoidT <= 0) this.avoid = null;

    // Stuck detection: no progress while wanting to move → hop (clears ledge
    // lips), and if that doesn't free us, abandon the plan entirely. Without
    // this, bots collect in dead-end grind states as the match goes on.
    this._stuckCheck -= dt;
    if (this._stuckCheck <= 0) {
      this._stuckCheck = 1.5;
      const wantsMove = this.target || (this.path && this.pathIdx < this.path.length);
      if (wantsMove && this.pos.distanceTo(this._lastPos) < 0.6) this.stuckT += 1.5;
      else this.stuckT = 0;
      this._lastPos.copy(this.pos);
      if (this.stuckT >= 4.5) {
        if (this.shopping) { this.avoid = this.shopping; this.avoidT = 12; }
        this.shopping = null;
        this.lootLock = 0;
        this.path = findPath(this.world, this.reachableNearest(),
          Math.floor(Math.random() * this.world.waypoints.length)) || null;
        this.pathIdx = 0;
        this.stuckT = 0;
      } else if (this.stuckT >= 1.5 && this.grounded) {
        this.vel.y = this.world.jumpVel;
      }
    }

    if (this.speedTime > 0) {
      this.speedTime -= dt;
      if (this.speedTime <= 0) this.speedMult = 1;
    }
    const water = this._waterZone();
    const speed = this.world.playerSpeed * 0.82 * (this.speedMult || 1) * (water ? 0.68 : 1);
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

    // Final approach: waypoints only get you *near* an item — walk the last
    // stretch straight onto it, or the orb just spins there forever.
    const shop = this.shopping;
    if (shop && shop.active && (!this.target || this.lootLock > 0)) {
      const lp = shop.def.pos;
      const fd = Math.hypot(lp.x - this.pos.x, lp.z - this.pos.z);
      // low grav: only beeline on the same flat — a straight walk can cross a void gap
      const [maxD, maxDy] = lowGrav ? [5, 1] : [12, 2.5];
      if (fd < maxD && Math.abs(lp.y - this.pos.y) < maxDy) wpTarget = lp;
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
      // snatch a nearby point orb mid-fight: steer the maneuver through it
      // while still facing (and shooting at) the target
      if (shop && shop.active && shop.def.kind === 'points') {
        const fd = Math.hypot(shop.def.pos.x - this.pos.x, shop.def.pos.z - this.pos.z);
        if (fd > 0.3 && fd < 9 && Math.abs(shop.def.pos.y - this.pos.y) < 2) {
          moveX = (shop.def.pos.x - this.pos.x) / fd;
          moveZ = (shop.def.pos.z - this.pos.z) / fd;
        }
      }
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
      const lavaNow = this._inLava(this.pos.x, this.pos.y, this.pos.z);
      const probeX = this.pos.x + moveX * 2.1;
      const probeZ = this.pos.z + moveZ * 2.1;
      if (this._inLava(probeX, this.pos.y, probeZ)) {
        const away = this._lavaAvoidVector(probeX, probeZ);
        moveX = away.x;
        moveZ = away.z;
        if (this.grounded && !lavaNow) this.vel.y = Math.max(this.vel.y, this.world.jumpVel * 0.55);
      } else if (lavaNow) {
        const away = this._lavaAvoidVector(this.pos.x, this.pos.z);
        moveX = away.x;
        moveZ = away.z;
        if (this.grounded) this.vel.y = Math.max(this.vel.y, this.world.jumpVel * 0.75);
      }
      const accel = this.grounded ? 8 : 1.5;
      this.vel.x += (moveX * speed - this.vel.x) * Math.min(1, accel * dt);
      this.vel.z += (moveZ * speed - this.vel.z) * Math.min(1, accel * dt);
    }
    if (water) this._applyWaterMotion(water, dt);
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

  _waterZone() {
    const falls = this.world.waterfallZones;
    const midY = this.pos.y + this.height * 0.5;
    for (const z of falls || []) {
      if (
        this.pos.x >= z.minX && this.pos.x <= z.maxX &&
        this.pos.z >= z.minZ && this.pos.z <= z.maxZ &&
        midY >= z.minY && midY <= z.maxY
      ) return { ...z, waterfall: true, surfaceY: z.maxY };
    }

    const zones = this.world.waterZones;
    if (!zones?.length) return null;
    for (const z of zones) {
      if (
        this.pos.x >= z.minX && this.pos.x <= z.maxX &&
        this.pos.z >= z.minZ && this.pos.z <= z.maxZ &&
        midY >= (z.bottomY ?? z.surfaceY - 4) - 0.4 &&
        this.pos.y < z.surfaceY + 0.35
      ) return z;
    }
    return null;
  }

  _inLava(x, y, z) {
    for (const l of this.world.lavaZones || []) {
      if (x >= l.minX && x <= l.maxX && z >= l.minZ && z <= l.maxZ && y < l.maxY + 0.4) return true;
    }
    return false;
  }

  _lavaAvoidVector(x, z) {
    let ax = 0, az = 0;
    for (const l of this.world.lavaZones || []) {
      if (x < l.minX || x > l.maxX || z < l.minZ || z > l.maxZ) continue;
      const dl = Math.abs(x - l.minX), dr = Math.abs(l.maxX - x);
      const db = Math.abs(z - l.minZ), dt = Math.abs(l.maxZ - z);
      const m = Math.min(dl, dr, db, dt);
      if (m === dl) ax -= 1;
      else if (m === dr) ax += 1;
      else if (m === db) az -= 1;
      else az += 1;
    }
    const len = Math.hypot(ax, az) || 1;
    return { x: ax / len, z: az / len };
  }

  _applyWaterMotion(zone, dt) {
    if (zone.waterfall) {
      this.vel.y = THREE.MathUtils.damp(this.vel.y, -7 + this.world.gravity * dt, 12, dt);
      const fallDrag = Math.exp(-4.2 * dt);
      this.vel.x *= fallDrag;
      this.vel.z *= fallDrag;
      this.grounded = false;
      return;
    }

    const eyeY = this.pos.y + 1.55;
    let targetVy = eyeY < zone.surfaceY - 0.25 ? 1.05 : -0.25;
    const nearSurface = eyeY > zone.surfaceY - 0.35;
    if (nearSurface && (this.grounded || (this._waterHopT || 0) <= 0)) {
      targetVy = this.world.jumpVel * 0.72;
      this._waterHopT = 0.8;
    }
    this._waterHopT = Math.max(0, (this._waterHopT || 0) - dt);
    this.vel.y = THREE.MathUtils.damp(this.vel.y, targetVy + this.world.gravity * dt, 8, dt);
    const drag = Math.exp(-2.8 * dt);
    this.vel.x *= drag;
    this.vel.z *= drag;
    this.grounded = false;
  }
}

export const BOT_NAMES = ['Whiplash', 'Tornado', 'Cyclone', 'Vortex', 'Blitz', 'Comet', 'Turbo', 'Zapper'];

function angDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
