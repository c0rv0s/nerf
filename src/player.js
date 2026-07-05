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
    this.bodyFwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this._camSnap = true;   // don't slerp from a stale orientation on respawn
    this.djumpTime = 0;
    this._airJumped = false;
  }

  onMouseMove(dx, dy) {
    const s = 0.0022;
    if (this.world.escher) {
      // yaw = swing forward around your current up; works on any wall
      this.bodyFwd.applyAxisAngle(this.up, -dx * s).normalize();
      this.pitch = clamp(this.pitch - dy * s, -1.4, 1.4);
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

  // ---- PRISM RUN: gravity is -up; run up walls, across ceilings, camera rolls ----
  _moveEscher(dt) {
    const up = this.up, fwd = this.bodyFwd;
    const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
    const speed = this.world.playerSpeed * (this.speedMult || 1);
    const f = (this.keys['KeyW'] ? 1 : 0) - (this.keys['KeyS'] ? 1 : 0);
    const s = (this.keys['KeyD'] ? 1 : 0) - (this.keys['KeyA'] ? 1 : 0);
    const want = new THREE.Vector3().addScaledVector(fwd, f).addScaledVector(right, s);
    const wl = want.length();
    if (wl > 1) want.multiplyScalar(1 / wl);

    // split velocity: along-up (gravity/jump) stays, planar gets input
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

    // Airborne: gravity always pulls toward the NEAREST inner face of the cube,
    // so you curve down onto some surface — you can never fall out into space.
    // (Skip briefly after a climb so it doesn't fight the corner transition.)
    this._climbLock = Math.max(0, (this._climbLock || 0) - dt);
    if (!this.grounded && this._climbLock <= 0) {
      const nf = this._nearestFace();
      if (nf && nf.dot(this.up) < 0.99) this._reorient(nf);
    }

    this.grounded = moveCharacterUp(this, this.world, dt, this._nrm);
    if (this.grounded) { this._airJumped = false; this._climb(); }
    this.coyote = this.grounded ? 0.14 : Math.max(0, this.coyote - dt);

    this._escherCamera(dt);
  }

  // Smooth first-person camera for the tilted frame. Physics `up` snaps at a
  // transition (robust), but the camera SLERPS to the new orientation over a
  // beat — so the view rolls over instead of flipping instantly.
  _escherCamera(dt) {
    const eye = this.pos.clone().addScaledVector(this.up, this.eyeHeight);
    const rgt = new THREE.Vector3().crossVectors(this.bodyFwd, this.up).normalize();
    const look = this.bodyFwd.clone().applyAxisAngle(rgt, this.pitch);
    const m = new THREE.Matrix4().lookAt(eye, eye.clone().add(look), this.up);
    const targetQ = new THREE.Quaternion().setFromRotationMatrix(m);
    if (this._camSnap) { this.camQuat.copy(targetQ); this._camSnap = false; }
    else this.camQuat.slerp(targetQ, 1 - Math.exp(-16 * dt));
    this.camera.up.copy(this.up);
    this.camera.position.copy(eye);
    this.camera.quaternion.copy(this.camQuat);
  }

  // Inward normal of the cube face the player is closest to (the way "down"
  // points at any moment — toward the nearest surface, i.e. toward center).
  _nearestFace() {
    const c = this.world.cube; if (!c) return null;
    const p = this.pos, h = c.h;
    const d = [
      [p.y - (c.cy - h), 0, 1, 0], [(c.cy + h) - p.y, 0, -1, 0],
      [p.x - (c.cx - h), 1, 0, 0], [(c.cx + h) - p.x, -1, 0, 0],
      [p.z - (c.cz - h), 0, 0, 1], [(c.cz + h) - p.z, 0, 0, -1],
    ].sort((a, b) => a[0] - b[0])[0];
    return new THREE.Vector3(d[1], d[2], d[3]);
  }

  // Rotate the whole body frame so up becomes newUp (heading preserved).
  _reorient(newUp) {
    const q = new THREE.Quaternion().setFromUnitVectors(this.up, newUp);
    this.bodyFwd.applyQuaternion(q);
    this.up.copy(newUp);
    this.bodyFwd.addScaledVector(this.up, -this.bodyFwd.dot(this.up)).normalize();
  }

  _solidAt(p) {
    for (const c of this.world.colliders) {
      if (c.type !== 'box') continue;
      if (p.x > c.min.x && p.x < c.max.x && p.y > c.min.y && p.y < c.max.y &&
          p.z > c.min.z && p.z < c.max.z) return true;
    }
    return false;
  }

  // Concave corner: a wall rises directly ahead → rotate onto it and climb up.
  _climb() {
    if (this.vel.dot(this.bodyFwd) < 1) return;   // only when actually running forward
    const probe = this.pos.clone()
      .addScaledVector(this.bodyFwd, this.radius + 0.4)
      .addScaledVector(this.up, 0.6);
    if (!this._solidAt(probe)) return;
    const oldUp = this.up.clone();
    this.up.copy(cardinal(this.bodyFwd.clone().negate()));  // wall face becomes the floor
    this.bodyFwd.copy(oldUp);                                // old up = new "up the wall" heading
    this.pos.addScaledVector(this.up, 0.06);
    this.vel.multiplyScalar(0.9);
    this._climbLock = 0.25;                                  // let the new face settle
    sfx('boing');
  }
}
