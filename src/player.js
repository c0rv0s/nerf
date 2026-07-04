// First-person player: pointer-lock look, WASD movement, firing, weapon switching,
// and a simple viewmodel blaster with recoil.
import * as THREE from 'three';
import { moveCharacter, clamp } from './engine.js';
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
  }

  onMouseMove(dx, dy) {
    this.yaw -= dx * 0.0022;
    this.pitch = clamp(this.pitch - dy * 0.0022, -1.5, 1.5);
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

    // Movement intent in camera-yaw space
    const speed = this.world.playerSpeed;
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
    // friction / speed clamp (horizontal)
    const damp = this.grounded ? Math.exp(-8 * dt) : Math.exp(-0.4 * dt);
    if (wl === 0 && this.grounded) { this.vel.x *= damp; this.vel.z *= damp; }
    // Speed cap: run speed on the ground. In the air, cap at whatever speed you
    // took off with — keeps jump-pad momentum without letting air-control
    // accelerate ordinary jumps past run speed.
    const hs = Math.hypot(this.vel.x, this.vel.z);
    const cap = this.grounded ? speed : Math.max(speed, prevHs);
    if (hs > cap) { this.vel.x *= cap / hs; this.vel.z *= cap / hs; }

    // Buffered + coyote jump: pressing Space slightly early or just after the
    // ground curves away (asteroids!) still jumps.
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    if (this.wantJump) { this.jumpBuffer = 0.15; this.wantJump = false; }
    if (this.jumpBuffer > 0 && this.coyote > 0) {
      this.vel.y = this.world.jumpVel;
      this.jumpBuffer = 0;
      this.coyote = 0;
      sfx('jump');
    }

    this.grounded = moveCharacter(this, this.world, dt);
    this.coyote = this.grounded ? 0.14 : Math.max(0, this.coyote - dt);

    // Camera
    this.camera.position.set(this.pos.x, this.pos.y + this.eyeHeight, this.pos.z);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.yaw);
    this.camera.rotateX(this.pitch);

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
    const bob = this.grounded ? Math.sin(performance.now() * 0.012) * Math.min(hs / speed, 1) * 0.012 : 0;
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
}
