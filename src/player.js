// First-person player: pointer-lock look, WASD movement, firing, weapon switching,
// and a simple viewmodel blaster with recoil.
import * as THREE from 'three';
import { moveCharacter, moveCharacterUp, cardinal, clamp, pointInZoneXZ } from './engine.js';
import { WEAPONS, WEAPON_FEEL, WEAPON_ORDER, buildBlaster, blasterSkin, updateBlasterSkin, nextLoadedWeaponAfter } from './weapons.js';
import { sfx } from './audio.js';
import { stepJetpack } from './jetpack.js';

export class Player {
  constructor(camera, world) {
    this.camera = camera;
    this.world = world;
    this.team = 'blue';
    this.name = 'YOU';
    this.isPlayer = true;

    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.radius = 0.45;
    this.height = 1.8;
    this.eyeHeight = 1.6;

    this.hp = 100;
    this.shield = 0;
    this.alive = true;
    this.kills = 0; this.deaths = 0;
    this.damageMult = 1;
    this.powerup = null;       // {kind, timeLeft}
    this.paralyzeT = 0;
    this.weapons = { blaster: true };  // owned guns — ammo alone isn't enough
    this.ammo = { blaster: Infinity };
    this.weapon = 'blaster';
    this.cooldown = 0;
    this.coyote = 0;           // grace after leaving ground (curved asteroids!)
    this.jumpBuffer = 0;       // grace after pressing jump

    this.yaw = 0; this.pitch = 0;
    // Escher worlds (PRISM RUN): a full body frame that can tilt onto any wall.
    // up = which way is "down" (negated); fwd = look/run direction in that plane.
    this.up = new THREE.Vector3(0, 1, 0);        // physics up (snaps at a transition)
    this.frameUp = new THREE.Vector3(0, 1, 0);   // camera up — eases toward `up` (smooth roll)
    this.frameFwd = new THREE.Vector3(0, 0, -1); // camera heading in that frame (mouse yaw turns it)
    this._camSnap = true;
    this._nrm = new THREE.Vector3();
    this.djumpTime = 0;        // double-jump powerup timer
    this.jetpack = null;       // {fuel, cooldown, active}; cleared on death
    this._airJumped = false;
    this.keys = {};
    this.firing = false;
    this.grounded = false;
    this.recoil = 0;
    this.cameraKick = 0;
    this.muzzleT = 0;
    this.equipT = 0;
    this.lookSwayX = 0;
    this.lookSwayY = 0;
    this.stepDistance = 0;
    this.wasGrounded = false;
    this.wantJump = false;

    this.buildViewmodel();
  }

  buildViewmodel() {
    // One model per weapon; the active one is shown
    const g = new THREE.Group();
    this.vmWeapons = {};
    for (const id of WEAPON_ORDER) {
      const m = buildBlaster(id);
      m.visible = id === 'blaster';
      g.add(m);
      this.vmWeapons[id] = m;
    }
    // invisible probes so the powerup skins are compiled at match start,
    // not on first pickup (shader compiles cause a visible hitch)
    for (const kind of ['gold', 'silver']) {
      const probe = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), blasterSkin(kind));
      probe.visible = false;
      g.add(probe);
    }
    g.scale.setScalar(0.55);
    g.position.set(0.32, -0.3, -0.55);
    g.rotation.y = 0.06;
    this.viewmodel = g;
    this.camera.add(g);

    const flashMat = new THREE.SpriteMaterial({
      color: 0xffe2a0, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false,
    });
    this.muzzleFlash = new THREE.Sprite(flashMat);
    this.muzzleFlash.position.set(0.27, -0.16, -0.96);
    this.muzzleFlash.scale.setScalar(0.01);
    this.camera.add(this.muzzleFlash);
  }

  showWeaponModel(id) {
    for (const [wid, m] of Object.entries(this.vmWeapons)) m.visible = wid === id;
  }

  // Gold/silver powerup skin on the gun in hand ('gold' | 'silver' | null)
  setSkin(kind) {
    const mat = blasterSkin(kind);
    for (const m of Object.values(this.vmWeapons)) {
      const shell = m.children[0];
      shell.material = kind ? mat : (shell.userData.baseMaterial || mat);
    }
  }

  spawn(pos) {
    this.pos.copy(pos);
    this.vel.set(0, 0, 0);
    this.hp = 100;
    this.shield = 0;
    this.alive = true;
    this.damageMult = 1;
    this.powerup = null;
    this.paralyzeT = 0;
    this.weapons = { blaster: true };
    this.ammo = { blaster: Infinity };
    this.weapon = 'blaster';
    this.showWeaponModel('blaster'); // hand model back to blaster
    this.setSkin(null);
    this.yaw = Math.atan2(pos.x, pos.z); // face map center
    this.pitch = 0;
    this.up.set(0, 1, 0);
    this._camSnap = true;   // snap the roll on spawn, don't ease from stale
    this.djumpTime = 0;
    this.jetpack = null;
    this._airJumped = false;
    this.recoil = 0;
    this.cameraKick = 0;
    this.muzzleT = 0;
    this.equipT = 0;
    this.stepDistance = 0;
    if (this.world.escher) {
      // spawn oriented to whatever surface you land on (floor, wall or ceiling)
      const nf = this._nearestSurfaceUpAt(this.pos);
      if (nf) this.up.copy(nf);
      // a heading perpendicular to up (aim into the room)
      const ref = Math.abs(this.up.y) > 0.7 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
      const f = ref.addScaledVector(this.up, -ref.dot(this.up)).normalize();
      this._moveFwd = f.clone();
      this.frameUp.copy(this.up);
      this.frameFwd.copy(f);
      this.pitch = 0;
    }
  }

  onMouseMove(dx, dy) {
    const s = 0.0022;
    this.lookSwayX = clamp(this.lookSwayX + dx * 0.00032, -0.045, 0.045);
    this.lookSwayY = clamp(this.lookSwayY + dy * 0.00024, -0.035, 0.035);
    if (this.world.escher) {
      // yaw turns your heading within the surface plane; pitch is a plain
      // scalar (can't accumulate roll, so you can always look straight up).
      this.frameFwd.applyAxisAngle(this.frameUp, -dx * s).normalize();
      this.pitch = clamp(this.pitch - dy * s, -1.45, 1.45);
    } else {
      this.yaw -= dx * s;
      this.pitch = clamp(this.pitch - dy * s, -1.5, 1.5);
    }
  }

  switchWeapon(id) {
    if (id !== 'blaster' && !(this.weapons[id] && this.ammo[id] > 0)) return;
    if (WEAPONS[id] && id !== this.weapon) {
      this.weapon = id;
      this.cooldown = Math.max(this.cooldown, 0.25);
      this.showWeaponModel(id);
      this.equipT = 1;
      sfx('equip');
    }
  }

  cycleWeapon(dir) {
    const owned = WEAPON_ORDER.filter(w => w === 'blaster' || (this.weapons[w] && this.ammo[w] > 0));
    const i = owned.indexOf(this.weapon);
    this.switchWeapon(owned[(i + dir + owned.length) % owned.length]);
  }

  update(dt, fire) {
    if (!this.alive) return;

    const wasGrounded = this.grounded;
    const fallSpeed = this.vel.y;

    if (this.speedTime > 0) { // speed powerup wearing off
      this.speedTime -= dt;
      if (this.speedTime <= 0) this.speedMult = 1;
    }
    if (this.world.escher) this._moveEscher(dt);
    else this._moveNormal(dt);

    // Firing
    this.cooldown -= dt;
    if (this.firing && this.cooldown <= 0) {
      const w = WEAPONS[this.weapon];
      if (this.weapon === 'blaster' || this.ammo[this.weapon] > 0) {
        const dir = new THREE.Vector3();
        this.camera.getWorldDirection(dir);
        // launch from the gun muzzle (right and below the eye), not the face
        const right = new THREE.Vector3().crossVectors(dir, this.camera.up).normalize();
        const origin = this.camera.position.clone()
          .addScaledVector(dir, 1.1)
          .addScaledVector(right, 0.18)
          .addScaledVector(this.camera.up, -0.22);
        fire(this, origin, dir, this.weapon);
        if (this.weapon !== 'blaster') this.ammo[this.weapon]--;
        this.cooldown = 1 / w.rof;
        const feel = WEAPON_FEEL[this.weapon] || WEAPON_FEEL.blaster;
        this.recoil = Math.min(2.2, this.recoil + feel.recoil);
        this.cameraKick = Math.min(0.035, this.cameraKick + feel.camera);
        this.muzzleT = 0.065;
        this.muzzleStrength = feel.flash;
        if (this.weapon !== 'blaster' && this.ammo[this.weapon] <= 0) {
          this.switchWeapon(nextLoadedWeaponAfter(this.weapon, this.weapons, this.ammo));
        }
      } else {
        sfx('dry');
        this.switchWeapon(nextLoadedWeaponAfter(this.weapon, this.weapons, this.ammo));
      }
    }

    // Layered viewmodel response: locomotion, look inertia, equip dip, weapon kick.
    const feel = WEAPON_FEEL[this.weapon] || WEAPON_FEEL.blaster;
    this.recoil *= Math.exp(-feel.return * dt);
    this.cameraKick *= Math.exp(-18 * dt);
    this.equipT *= Math.exp(-8.5 * dt);
    this.lookSwayX *= Math.exp(-10 * dt);
    this.lookSwayY *= Math.exp(-10 * dt);
    const now = performance.now();
    const moving = this.grounded ? (this._speedRatio || 0) : 0;
    const bobY = Math.sin(now * 0.012) * moving * 0.012;
    const bobX = Math.cos(now * 0.006) * moving * 0.008;
    this.viewmodel.position.set(
      0.3 + bobX - this.lookSwayX * 0.7,
      -0.28 + bobY - this.equipT * 0.2 + this.lookSwayY * 0.35,
      -0.6 + this.recoil * 0.082,
    );
    this.viewmodel.rotation.set(
      this.recoil * 0.22 + this.lookSwayY,
      0.06 - this.lookSwayX,
      this.equipT * 0.12 - bobX * 0.8,
    );
    this.camera.rotateX(this.cameraKick);

    this.muzzleT = Math.max(0, this.muzzleT - dt);
    const flash = this.muzzleT > 0 ? this.muzzleT / 0.065 : 0;
    this.muzzleFlash.material.opacity = flash * 0.82;
    const flashScale = flash * 0.24 * (this.muzzleStrength || 1);
    this.muzzleFlash.scale.set(flashScale * 1.35, flashScale, 1);
    this.muzzleFlash.material.rotation = now * 0.018;

    if (this.grounded && !wasGrounded && fallSpeed < -4.5) sfx('land');
    if (this.grounded && moving > 0.16) {
      this.stepDistance += this.world.playerSpeed * moving * dt;
      if (this.stepDistance >= 3.25) {
        this.stepDistance %= 3.25;
        sfx('footstep');
      }
    } else if (!this.grounded) {
      this.stepDistance = Math.min(this.stepDistance, 2.2);
    }

    // Powerup timer
    if (this.powerup) {
      updateBlasterSkin(this.powerup.kind, now * 0.001);
      this.powerup.timeLeft -= dt;
      if (this.powerup.timeLeft <= 0) {
        this.powerup = null;
        this.damageMult = 1;
        this.setSkin(null);
      }
    }
  }

  // ---- normal, Y-gravity movement + camera (all maps except PRISM RUN) ----
  _moveNormal(dt) {
    this._vineExitT = Math.max(0, (this._vineExitT || 0) - dt);
    const paralyzed = this.paralyzeT > 0;
    if (paralyzed) {
      this.paralyzeT = Math.max(0, this.paralyzeT - dt);
      this.wantJump = false;
      this.firing = false;
    }
    const env = this._environmentState();
    const speed = this.world.playerSpeed * (this.speedMult || 1) * env.speedMult;
    const f = paralyzed ? 0 : (this.keys['KeyW'] ? 1 : 0) - (this.keys['KeyS'] ? 1 : 0);
    const s = paralyzed ? 0 : (this.keys['KeyD'] ? 1 : 0) - (this.keys['KeyA'] ? 1 : 0);
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    let wx = (-sin * f + cos * s), wz = (-cos * f - sin * s);
    const wl = Math.hypot(wx, wz);
    if (wl > 0) { wx /= wl; wz /= wl; }

    const prevHs = Math.hypot(this.vel.x, this.vel.z);
    const accel = this.grounded ? 60 : 18;
    this.vel.x += wx * speed * accel * dt * 0.12;
    this.vel.z += wz * speed * accel * dt * 0.12;
    const damp = this.grounded ? Math.exp(-8 * dt) : Math.exp(-0.4 * dt);
    if (wl === 0 && this.grounded) { this.vel.x *= damp; this.vel.z *= damp; }
    if (paralyzed) { this.vel.x *= Math.exp(-12 * dt); this.vel.z *= Math.exp(-12 * dt); }
    const hs = Math.hypot(this.vel.x, this.vel.z);
    const cap = this.grounded ? speed : Math.max(speed, prevHs);
    if (hs > cap) { this.vel.x *= cap / hs; this.vel.z *= cap / hs; }
    this._speedRatio = Math.min(hs / speed, 1);

    const vine = env.vine;
    const waterfall = env.waterfall;
    const water = env.water;
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    if (this.wantJump) { this.jumpBuffer = 0.15; this.wantJump = false; }
    if (this.djumpTime > 0) this.djumpTime -= dt;
    if (paralyzed) {
      this.jumpBuffer = 0;
      this.wantJump = false;
      this.coyote = 0;
    } else if (vine) {
      this._applyVineMotion(dt, vine);
      this.jumpBuffer = 0;
      this.wantJump = false;
      this.coyote = 0;
    } else if (waterfall) {
      this._applyWaterfallMotion(dt);
      this.jumpBuffer = 0;
      this.wantJump = false;
      this.coyote = 0;
    } else if (water) {
      this._applyWaterMotion(water, dt);
      this.jumpBuffer = 0;
      this.wantJump = false;
      this.coyote = 0.04;
    } else if (this.jumpBuffer > 0 && this.coyote > 0) {
      this.vel.y = this.world.jumpVel;
      this.jumpBuffer = 0; this.coyote = 0; sfx('jump');
    } else if (this.jumpBuffer > 0 && !this.grounded && this.djumpTime > 0 && !this._airJumped) {
      this.vel.y = this.world.jumpVel * 1.5;
      this._airJumped = true; this.jumpBuffer = 0; sfx('boing');
    }

    // Death-bound jetpack equipment. Space supplies capped upward thrust for
    // eight total seconds of fuel; an empty pack locks for four seconds, then
    // refills. Releasing Space preserves the remaining fuel for later bursts.
    if (this.jetpack) {
      const canThrust = this.keys['Space'] && !paralyzed && !vine && !waterfall && !water && !env.lava;
      stepJetpack(this.jetpack, this.vel, dt, canThrust);
    }

    this.grounded = moveCharacter(this, this.world, dt);
    if (this.grounded) this._airJumped = false;
    this.coyote = this.grounded ? 0.14 : Math.max(0, this.coyote - dt);

    this.camera.up.set(0, 1, 0);
    this.camera.position.set(this.pos.x, this.pos.y + this.eyeHeight, this.pos.z);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.yaw);
    this.camera.rotateX(this.pitch);
  }

  /* ---- PRISM RUN: walk on any surface. Gravity pulls toward the nearest
     surface (you can't fall out); movement is relative to a FREE-LOOK camera
     that never rolls — your feet stick to walls/ceilings but the view stays a
     normal FPS camera, so aiming feels identical everywhere. ---- */
  _moveEscher(dt) {
    const up = this.up;
    // walk toward your heading, flattened onto the surface you're on
    let fwd = this.frameFwd.clone().addScaledVector(up, -this.frameFwd.dot(up));
    if (fwd.lengthSq() < 0.04 && this._moveFwd) fwd.copy(this._moveFwd);
    fwd.normalize();
    this._moveFwd = fwd.clone();
    const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
    const speed = this.world.playerSpeed * (this.speedMult || 1) * this._waterSpeedMult();
    const f = (this.keys['KeyW'] ? 1 : 0) - (this.keys['KeyS'] ? 1 : 0);
    const s = (this.keys['KeyD'] ? 1 : 0) - (this.keys['KeyA'] ? 1 : 0);
    const want = new THREE.Vector3().addScaledVector(fwd, f).addScaledVector(right, s);
    const wl = want.length();
    if (wl > 1) want.multiplyScalar(1 / wl);

    const vUp = this.vel.dot(up);
    const planar = this.vel.clone().addScaledVector(up, -vUp);
    const prevHs = planar.length();
    const accel = this.grounded ? 60 : 18;
    planar.addScaledVector(want, speed * accel * dt * 0.12);
    if (wl === 0 && this.grounded) planar.multiplyScalar(Math.exp(-8 * dt));
    const hs = planar.length();
    const cap = this.grounded ? speed : Math.max(speed, prevHs);
    if (hs > cap) planar.multiplyScalar(cap / hs);
    this._speedRatio = Math.min(hs / speed, 1);
    this.vel.copy(planar).addScaledVector(up, vUp);

    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    if (this.wantJump) { this.jumpBuffer = 0.15; this.wantJump = false; }
    if (this.djumpTime > 0) this.djumpTime -= dt;
    if (this.jumpBuffer > 0 && this.coyote > 0) {
      this.vel.addScaledVector(up, this.world.jumpVel - this.vel.dot(up));
      this.jumpBuffer = 0; this.coyote = 0; sfx('jump');
    } else if (this.jumpBuffer > 0 && !this.grounded && this.djumpTime > 0 && !this._airJumped) {
      this.vel.addScaledVector(up, this.world.jumpVel * 1.5 - this.vel.dot(up));
      this._airJumped = true; this.jumpBuffer = 0; sfx('boing');
    }

    // Airborne: gravity pulls toward the NEAREST surface (shell face OR any
    // interior structure) so you always fall onto something — never the void.
    this._climbLock = Math.max(0, (this._climbLock || 0) - dt);
    if (!this.grounded && this._climbLock <= 0) {
      const nf = this._nearestSurfaceUp();
      if (nf && nf.dot(this.up) < 0.99) this.up.copy(nf);
    }

    this.grounded = moveCharacterUp(this, this.world, dt, this._nrm);
    if (this.grounded) { this._airJumped = false; this._climb(); }
    this.coyote = this.grounded ? 0.14 : Math.max(0, this.coyote - dt);

    // Camera: the frame's up eases toward the physics up (smooth roll — a wall
    // becomes your floor), carrying the heading with it; yaw/pitch sit on top
    // and stay instant. Pitch is applied fresh each frame, so it never drifts.
    if (this.frameUp.dot(up) < 0.99999) {
      const q = new THREE.Quaternion().setFromUnitVectors(this.frameUp, up);
      const partial = new THREE.Quaternion().slerp(q, this._camSnap ? 1 : 1 - Math.exp(-13 * dt));
      this.frameUp.applyQuaternion(partial);
      this.frameFwd.applyQuaternion(partial);
    }
    this._camSnap = false;
    this.frameFwd.addScaledVector(this.frameUp, -this.frameFwd.dot(this.frameUp)).normalize();
    const cRight = new THREE.Vector3().crossVectors(this.frameFwd, this.frameUp).normalize();
    const look = this.frameFwd.clone().applyAxisAngle(cRight, this.pitch);
    const eye = this.pos.clone().addScaledVector(up, this.eyeHeight);
    this.camera.up.copy(this.frameUp);
    this.camera.position.copy(eye);
    this.camera.lookAt(eye.add(look));
  }

  _waterSpeedMult() {
    return this._environmentState().speedMult;
  }

  _environmentState() {
    const px = this.pos.x, py = this.pos.y, pz = this.pos.z;
    const eyeY = py + this.eyeHeight;
    const midY = py + this.height * 0.5;
    let lava = false;
    for (const z of this.world.lavaZones || []) {
      if (
        pointInZoneXZ(z, px, pz) &&
        py < z.maxY
      ) { lava = true; break; }
    }

    let waterfall = null;
    if (!lava) {
      for (const z of this.world.waterfallZones || []) {
        if (
          px >= z.minX && px <= z.maxX &&
          pz >= z.minZ && pz <= z.maxZ &&
          midY >= z.minY && midY <= z.maxY
        ) { waterfall = z; break; }
      }
    }

    let water = null;
    if (!lava && !waterfall) {
      for (const z of this.world.waterZones || []) {
        if (
          px >= z.minX && px <= z.maxX &&
          pz >= z.minZ && pz <= z.maxZ &&
          midY >= (z.bottomY ?? z.surfaceY - 4) - 0.4 &&
          py < z.surfaceY + 0.35
        ) { water = z; break; }
      }
    }

    let foliage = false;
    if (!lava && !waterfall && !water) {
      for (const z of this.world.foliageZones || []) {
        if (z.r != null) {
          foliage = (px - z.x) * (px - z.x) +
            (eyeY - z.y) * (eyeY - z.y) +
            (pz - z.z) * (pz - z.z) < z.r * z.r;
        } else {
          foliage = px >= z.minX && px <= z.maxX &&
            eyeY >= z.minY && eyeY <= z.maxY &&
            pz >= z.minZ && pz <= z.maxZ;
        }
        if (foliage) break;
      }
    }

    let vine = null;
    if (!(this._vineExitT > 0)) {
      for (const z of this.world.vineZones || []) {
        const grabR = z.grabR ?? z.r;
        if (
          midY >= z.minY - 0.5 && midY <= z.maxY + 2.0 &&
          (px - z.x) * (px - z.x) + (pz - z.z) * (pz - z.z) < grabR * grabR
        ) { vine = z; break; }
      }
    }

    return {
      lava,
      waterfall,
      water,
      foliage,
      vine,
      speedMult: lava ? 0.34 : waterfall ? 0.58 : water ? 0.68 : foliage ? 0.84 : 1,
    };
  }

  _applyWaterfallMotion(dt) {
    this.vel.y = THREE.MathUtils.damp(this.vel.y, -7.5 + this.world.gravity * dt, 12, dt);
    const drag = Math.exp(-4.2 * dt);
    this.vel.x *= drag;
    this.vel.z *= drag;
    this._airJumped = false;
  }

  _applyWaterMotion(zone, dt) {
    const surface = zone.surfaceY;
    const eyeY = this.pos.y + this.eyeHeight;
    let targetVy = eyeY < surface - 0.25 ? 1.15 : -0.35;
    if (this.keys['Space']) targetVy = eyeY < surface + 0.15 ? 5.6 : this.world.jumpVel * 0.78;
    else if (this.keys['KeyS']) targetVy = -2.4;
    this.vel.y = THREE.MathUtils.damp(this.vel.y, targetVy + this.world.gravity * dt, 8, dt);
    const waterDrag = Math.exp(-2.8 * dt);
    this.vel.x *= waterDrag;
    this.vel.z *= waterDrag;
    this._airJumped = false;
  }

  _applyVineMotion(dt, vine) {
    let climb = -1.15;                 // no input: slide down slowly
    if (this.keys['Space']) climb = 5.4;
    else if (this.keys['KeyS']) climb = -3.0;

    const midY = this.pos.y + this.height * 0.5;
    if (this.keys['Space'] && vine && midY > vine.maxY + 1.35) {
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      const exitX = vine.exitX ?? -sin;
      const exitZ = vine.exitZ ?? -cos;
      this.vel.x += exitX * 4.5;
      this.vel.z += exitZ * 4.5;
      this.vel.y = this.world.jumpVel * 1.12;
      this._vineExitT = 0.45;
      this._airJumped = false;
      return;
    }

    // moveCharacter applies gravity at the start of integration; offset it so
    // vine velocity is controlled by input instead of free fall.
    this.vel.y = climb + this.world.gravity * dt;
    const drag = Math.exp(-4.5 * dt);
    this.vel.x *= drag;
    this.vel.z *= drag;
    this._airJumped = false;
  }

  // Outward normal (as a cardinal "up") of the nearest solid surface to the
  // player — the direction that is "up" while standing on it.
  _nearestSurfaceUp() {
    const mid = this.pos.clone().addScaledVector(this.up, this.height * 0.5);
    return this._nearestSurfaceUpAt(mid);
  }

  _nearestSurfaceUpAt(point) {
    let best = null, bd = Infinity;
    for (const c of this.world.colliders) {
      if (c.type !== 'box') continue;
      const cx = clamp(point.x, c.min.x, c.max.x), cy = clamp(point.y, c.min.y, c.max.y), cz = clamp(point.z, c.min.z, c.max.z);
      const dx = point.x - cx, dy = point.y - cy, dz = point.z - cz;
      let d2 = dx * dx + dy * dy + dz * dz;
      if (d2 <= 1e-4) continue;
      // Hysteresis: the surface you're already aligned to is "cheaper", so you
      // don't flip-flop between two near-equidistant surfaces (e.g. hugging a
      // wall next to a column). Only switch when another is clearly nearer.
      const n = cardinal(new THREE.Vector3(dx, dy, dz));
      if (n.dot(this.up) > 0.9) d2 -= 9;   // ~3-unit bias toward the current face
      if (d2 < bd) { bd = d2; best = n; }
    }
    return best;
  }

  _solidAt(p) {
    for (const c of this.world.colliders) {
      if (c.type !== 'box') continue;
      if (p.x > c.min.x && p.x < c.max.x && p.y > c.min.y && p.y < c.max.y &&
          p.z > c.min.z && p.z < c.max.z) return true;
    }
    return false;
  }

  // Walk into a wall/column while grounded → climb it. The wall ahead becomes
  // your floor and your momentum carries you UP it (so you climb even looking
  // straight at it); a brief lock keeps the nearest-surface gravity from
  // yanking you back to the floor at the base.
  _climb() {
    const dir = this.vel.clone().addScaledVector(this.up, -this.vel.dot(this.up));
    const sp = dir.length();
    if (sp < 1) return;                            // only when actually moving
    dir.multiplyScalar(1 / sp);
    const probe = this.pos.clone()
      .addScaledVector(dir, this.radius + 0.4)
      .addScaledVector(this.up, 0.6);
    if (!this._solidAt(probe)) return;
    const oldUp = this.up.clone();
    this.up.copy(cardinal(dir.clone().negate()));  // the wall ahead becomes the floor
    this.pos.addScaledVector(this.up, 0.06);
    this.vel.copy(oldUp).multiplyScalar(Math.max(sp, 6));   // shoot up the new surface
    this._climbLock = 0.35;
  }
}
