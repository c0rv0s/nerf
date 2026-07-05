// First-person player: pointer-lock look, WASD movement, firing, weapon switching,
// and a simple viewmodel blaster with recoil.
import * as THREE from 'three';
import { moveCharacter, moveCharacterUp, cardinal, clamp } from './engine.js';
import { WEAPONS, WEAPON_ORDER, buildBlaster, blasterSkin } from './weapons.js';
import { sfx } from './audio.js';

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
    this.weapons = { blaster: true };  // owned guns — ammo alone isn't enough
    this.ammo = { blaster: Infinity };
    this.weapon = 'blaster';
    this.cooldown = 0;
    this.coyote = 0;           // grace after leaving ground (curved asteroids!)
    this.jumpBuffer = 0;       // grace after pressing jump

    this.yaw = 0; this.pitch = 0;
    // Escher worlds (PRISM RUN): a full body frame that can tilt onto any wall.
    // up = which way is "down" (negated); fwd = look/run direction in that plane.
    this.up = new THREE.Vector3(0, 1, 0);
    this.bodyFwd = new THREE.Vector3(0, 0, -1);
    this.camQuat = new THREE.Quaternion();   // eased camera orientation (Escher)
    this._camSnap = true;
    this._nrm = new THREE.Vector3();
    this.djumpTime = 0;        // double-jump powerup timer
    this._airJumped = false;
    this.keys = {};
    this.firing = false;
    this.grounded = false;
    this.recoil = 0;
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
  }

  showWeaponModel(id) {
    for (const [wid, m] of Object.entries(this.vmWeapons)) m.visible = wid === id;
  }

  // Gold/silver powerup skin on the gun in hand ('gold' | 'silver' | null)
  setSkin(kind) {
    const mat = blasterSkin(kind);
    for (const m of Object.values(this.vmWeapons)) m.children[0].material = mat;
  }

  spawn(pos) {
    this.pos.copy(pos);
    this.vel.set(0, 0, 0);
    this.hp = 100;
    this.shield = 0;
    this.alive = true;
    this.damageMult = 1;
    this.powerup = null;
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
    this._airJumped = false;
    if (this.world.escher) {
      // spawn oriented to whatever surface you land on (floor, wall or ceiling)
      const nf = this._nearestSurfaceUp();
      if (nf) this.up.copy(nf);
      // a forward perpendicular to up (aim into the room)
      const ref = Math.abs(this.up.y) > 0.7 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
      const f = ref.addScaledVector(this.up, -ref.dot(this.up)).normalize();
      this._moveFwd = f.clone();
      this.camQuat.setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), f, this.up));
    }
  }

  onMouseMove(dx, dy) {
    const s = 0.0022;
    if (this.world.escher) {
      // rotate the camera quaternion directly — instant, 1:1 responsive.
      // yaw about the surface up (turning stays level with your floor), pitch
      // about the camera's own right axis, clamped away from straight up/down.
      this.camQuat.premultiply(new THREE.Quaternion().setFromAxisAngle(this.up, -dx * s));
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camQuat);
      const test = this.camQuat.clone().premultiply(new THREE.Quaternion().setFromAxisAngle(right, -dy * s));
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(test);
      if (Math.abs(fwd.dot(this.up)) < 0.985) this.camQuat.copy(test);
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
    }
  }

  cycleWeapon(dir) {
    const owned = WEAPON_ORDER.filter(w => w === 'blaster' || (this.weapons[w] && this.ammo[w] > 0));
    const i = owned.indexOf(this.weapon);
    this.switchWeapon(owned[(i + dir + owned.length) % owned.length]);
  }

  update(dt, fire) {
    if (!this.alive) return;

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
          .addScaledVector(right, 0.18);
        origin.y -= 0.22;
        fire(this, origin, dir, this.weapon);
        if (this.weapon !== 'blaster') this.ammo[this.weapon]--;
        this.cooldown = 1 / w.rof;
        this.recoil = 1;
        if (this.weapon !== 'blaster' && this.ammo[this.weapon] <= 0) {
          this.switchWeapon('blaster'); // auto-swap when dry
        }
      } else {
        this.switchWeapon('blaster');
      }
    }

    // Viewmodel bob + recoil
    this.recoil = Math.max(0, this.recoil - dt * 6);
    const bob = this.grounded ? Math.sin(performance.now() * 0.012) * (this._speedRatio || 0) * 0.012 : 0;
    this.viewmodel.position.set(0.3, -0.28 + bob, -0.6 + this.recoil * 0.09);
    this.viewmodel.rotation.x = this.recoil * 0.25;

    // Powerup timer
    if (this.powerup) {
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
    const speed = this.world.playerSpeed * (this.speedMult || 1);
    const f = (this.keys['KeyW'] ? 1 : 0) - (this.keys['KeyS'] ? 1 : 0);
    const s = (this.keys['KeyD'] ? 1 : 0) - (this.keys['KeyA'] ? 1 : 0);
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
    const hs = Math.hypot(this.vel.x, this.vel.z);
    const cap = this.grounded ? speed : Math.max(speed, prevHs);
    if (hs > cap) { this.vel.x *= cap / hs; this.vel.z *= cap / hs; }
    this._speedRatio = Math.min(hs / speed, 1);

    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    if (this.wantJump) { this.jumpBuffer = 0.15; this.wantJump = false; }
    if (this.djumpTime > 0) this.djumpTime -= dt;
    if (this.jumpBuffer > 0 && this.coyote > 0) {
      this.vel.y = this.world.jumpVel;
      this.jumpBuffer = 0; this.coyote = 0; sfx('jump');
    } else if (this.jumpBuffer > 0 && !this.grounded && this.djumpTime > 0 && !this._airJumped) {
      this.vel.y = this.world.jumpVel * 1.5;
      this._airJumped = true; this.jumpBuffer = 0; sfx('boing');
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
    // walk toward where the camera looks, projected onto the surface you're on
    let fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camQuat);
    fwd.addScaledVector(up, -fwd.dot(up));
    if (fwd.lengthSq() < 0.04 && this._moveFwd) fwd.copy(this._moveFwd);  // looking along up: reuse
    fwd.normalize();
    this._moveFwd = fwd.clone();
    const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
    const speed = this.world.playerSpeed * (this.speedMult || 1);
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

    // Camera: mouse look was applied 1:1 to camQuat already (responsive). Here
    // we only smoothly ROLL it so its up eases toward the surface normal — so a
    // wall becomes your floor visually, without ever lagging the look.
    const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camQuat);
    if (camUp.dot(up) < 0.99995) {
      const qAlign = new THREE.Quaternion().setFromUnitVectors(camUp, up);
      const t = this._camSnap ? 1 : 1 - Math.exp(-13 * dt);
      this.camQuat.premultiply(new THREE.Quaternion().slerp(qAlign, t));
    }
    this._camSnap = false;
    this.camera.up.copy(new THREE.Vector3(0, 1, 0).applyQuaternion(this.camQuat));
    this.camera.position.copy(this.pos).addScaledVector(up, this.eyeHeight);
    this.camera.quaternion.copy(this.camQuat);
  }

  // Outward normal (as a cardinal "up") of the nearest solid surface to the
  // player — the direction that is "up" while standing on it.
  _nearestSurfaceUp() {
    const mid = this.pos.clone().addScaledVector(this.up, this.height * 0.5);
    let best = null, bd = Infinity;
    for (const c of this.world.colliders) {
      if (c.type !== 'box') continue;
      const cx = clamp(mid.x, c.min.x, c.max.x), cy = clamp(mid.y, c.min.y, c.max.y), cz = clamp(mid.z, c.min.z, c.max.z);
      const dx = mid.x - cx, dy = mid.y - cy, dz = mid.z - cz;
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
