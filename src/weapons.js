// Weapon definitions + shared projectile system (used by player and bots).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { pointHitsWorld, rand } from './engine.js';
import { aiTex } from './maps.js';
import { sfx } from './audio.js';

export const WEAPON_ORDER = ['blaster', 'scatter', 'pulsar', 'sidewinder', 'zooka', 'whomper', 'hyper'];

export const WEAPONS = {
  blaster:    { name: 'SECRET SHOT',  slot: 1, dmg: 12, rof: 3.2, speed: 65,  spread: 0.012,
                pellets: 1, ammo: Infinity, pickupAmmo: 0, color: 0xffa020, size: 0.13,
                sound: 'blaster' },
  scatter:    { name: 'SCATTERBLAST', slot: 2, dmg: 9,  rof: 1.1, speed: 90,  spread: 0.07,
                pellets: 6, ammo: 0, pickupAmmo: 12, color: 0x40d0ff, size: 0.11,
                sound: 'scatter' },
  pulsar:     { name: 'PULSATOR',     slot: 3, dmg: 7,  rof: 9,   speed: 75,  spread: 0.035,
                pellets: 1, ammo: 0, pickupAmmo: 60, color: 0xb060ff, size: 0.1,
                sound: 'pulsar' },
  sidewinder: { name: 'SIDEWINDER',   slot: 4, dmg: 24, rof: 1.6, speed: 55,  spread: 0.01,
                pellets: 1, ammo: 0, pickupAmmo: 10, color: 0x8aff30, size: 0.17,
                disc: true, bounce: 3, sound: 'disc' },
  zooka:      { name: 'BALLZOOKA',    slot: 5, dmg: 42, rof: 0.8, speed: 38,  spread: 0.005,
                pellets: 1, ammo: 0, pickupAmmo: 6, color: 0xffe040, size: 0.35,
                splash: 5.5, splashDmg: 32, gravity: true, trail: true, sound: 'zooka' },
  whomper:    { name: 'WHOMPER',      slot: 6, dmg: 85, rof: 0.5, speed: 42,  spread: 0.004,
                pellets: 1, ammo: 0, pickupAmmo: 4, color: 0xff4fa0, size: 0.42,
                splash: 10, splashDmg: 50, sound: 'whomp' },
  hyper:      { name: 'HYPERSTRIKE',  slot: 7, dmg: 68, rof: 0.7, speed: 160, spread: 0.001,
                pellets: 1, ammo: 0, pickupAmmo: 5, color: 0xff3050, size: 0.12,
                trail: true, sound: 'hyper' },
};

/* ---------------- procedural blaster models ----------------
   Distinct Nerf-style silhouettes per weapon, merged into 2 draw calls each
   (plastic shell with baked vertex colors + one emissive "energy" mesh). */
const _blasterMats = {};
function blasterMats(color) {
  if (!_blasterMats.body) {
    _blasterMats.body = new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.45, metalness: 0.05,
      envMapIntensity: 0.5, ...aiTex('plastic', 0.6, 0.6) });
  }
  const key = 'e' + color;
  if (!_blasterMats[key]) {
    _blasterMats[key] = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 1.3, roughness: 0.4 });
  }
  return { body: _blasterMats.body, energy: _blasterMats[key] };
}

// Powerup skins: the blaster shell goes metallic gold/silver while active.
export function blasterSkin(kind) {
  if (!kind) return blasterMats(0).body; // the shared plastic shell material
  const key = 'skin-' + kind;
  if (!_blasterMats[key]) {
    const c = kind === 'gold' ? 0xffd23c : 0xdfe2ea;
    _blasterMats[key] = new THREE.MeshStandardMaterial({
      color: c, metalness: 0.95, roughness: 0.22, envMapIntensity: 1.2,
      emissive: c, emissiveIntensity: 0.12 });
  }
  return _blasterMats[key];
}

// Muzzle points −z, grip hangs down. Total length ≈ 1.2–1.7.
export function buildBlaster(id) {
  const w = WEAPONS[id];
  const geos = [], glow = [];
  const DARK = 0x232330, WHITE = 0xf0f0f4, SHELL = w.color;
  const add = (arr, geo, color, x, y, z, rx = 0, rz = 0) => {
    if (rx) geo.rotateX(rx);
    if (rz) geo.rotateZ(rz);
    geo.translate(x, y, z);
    if (arr === geos) {
      const c = new THREE.Color(color);
      const n = geo.attributes.position.count;
      const cols = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) cols.set([c.r, c.g, c.b], i * 3);
      geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    }
    arr.push(geo);
  };
  const B = (bw, bh, bd) => new THREE.BoxGeometry(bw, bh, bd);
  const C = (rt, rb, h) => new THREE.CylinderGeometry(rt, rb, h, 10);
  const HPI = Math.PI / 2;

  if (id === 'blaster') {
    add(geos, B(0.16, 0.22, 0.55), SHELL, 0, 0, 0.02);
    add(geos, B(0.08, 0.05, 0.4), WHITE, 0, 0.14, 0);
    add(geos, C(0.05, 0.05, 0.4), DARK, 0, 0.02, -0.45, HPI);
    add(geos, C(0.08, 0.08, 0.1), WHITE, 0, 0.02, -0.62, HPI);
    add(geos, B(0.12, 0.3, 0.15), DARK, 0, -0.22, 0.18, 0.25);
    add(glow, B(0.18, 0.05, 0.3), 0, 0, 0.05, 0);
  } else if (id === 'scatter') {
    add(geos, B(0.2, 0.24, 0.6), SHELL, 0, 0, 0.1);
    add(geos, C(0.06, 0.06, 0.65), DARK, -0.06, 0.04, -0.45, HPI);
    add(geos, C(0.06, 0.06, 0.65), DARK, 0.06, 0.04, -0.45, HPI);
    add(geos, B(0.26, 0.15, 0.1), WHITE, 0, 0.04, -0.72);
    add(geos, B(0.18, 0.14, 0.25), WHITE, 0, -0.12, -0.38);
    add(geos, B(0.12, 0.28, 0.15), DARK, 0, -0.24, 0.28, 0.3);
    add(geos, B(0.14, 0.16, 0.3), DARK, 0, -0.02, 0.5);
    add(glow, B(0.22, 0.04, 0.25), 0, 0, 0.09, 0.05);
  } else if (id === 'pulsar') {
    add(geos, B(0.16, 0.26, 0.6), SHELL, 0, 0.02, 0);
    add(geos, C(0.035, 0.035, 0.5), DARK, 0, 0.06, -0.5, HPI);
    add(geos, C(0.06, 0.06, 0.08), WHITE, 0, 0.06, -0.72, HPI);
    add(geos, C(0.13, 0.13, 0.12), WHITE, 0, -0.15, 0.02, 0, HPI); // side drum
    add(geos, B(0.08, 0.05, 0.45), WHITE, 0, 0.18, -0.05);
    add(geos, B(0.05, 0.12, 0.3), DARK, 0, 0.02, 0.45);
    add(glow, C(0.05, 0.05, 0.14), 0, 0, -0.15, 0.02, 0, HPI);   // drum core
  } else if (id === 'sidewinder') {
    add(geos, B(0.16, 0.22, 0.6), SHELL, 0, 0, 0.05);
    add(geos, B(0.22, 0.1, 0.3), WHITE, 0, 0.02, -0.45);        // wide flat muzzle
    add(geos, C(0.16, 0.16, 0.05), WHITE, 0, 0.2, 0.1, 0, HPI); // vertical disc magazine
    add(geos, B(0.12, 0.28, 0.15), DARK, 0, -0.22, 0.2, 0.25);
    add(geos, B(0.08, 0.05, 0.35), DARK, 0, 0.13, -0.15);
    add(glow, C(0.17, 0.17, 0.02), 0, 0, 0.2, 0.1, 0, HPI);     // disc rim
  } else if (id === 'whomper') {
    add(geos, C(0.13, 0.13, 0.65), SHELL, 0, 0.02, 0.05, HPI);  // fat body tube
    add(geos, C(0.2, 0.16, 0.28), WHITE, 0, 0.02, -0.42, HPI);  // huge bell muzzle
    add(geos, C(0.15, 0.15, 0.12), DARK, 0, 0.02, 0.42, HPI);
    add(geos, B(0.12, 0.26, 0.15), DARK, 0, -0.2, 0.2, 0.25);
    add(geos, B(0.1, 0.18, 0.12), DARK, 0, -0.18, -0.15);
    add(geos, B(0.06, 0.1, 0.3), WHITE, 0, 0.17, 0.1);
    add(glow, C(0.165, 0.165, 0.06), 0, 0, 0.02, -0.3, HPI);    // charge ring
  } else if (id === 'zooka') {
    add(geos, C(0.15, 0.15, 1.1), SHELL, 0, 0.02, 0, HPI);
    add(geos, C(0.21, 0.15, 0.22), WHITE, 0, 0.02, -0.62, HPI);
    add(geos, C(0.15, 0.18, 0.18), DARK, 0, 0.02, 0.6, HPI);
    add(geos, B(0.12, 0.26, 0.15), DARK, 0, -0.22, 0.15, 0.2);
    add(geos, B(0.1, 0.2, 0.12), DARK, 0, -0.2, -0.25);
    add(geos, B(0.06, 0.08, 0.4), DARK, 0, 0.21, 0);
    add(geos, B(0.02, 0.06, 0.5), WHITE, -0.15, 0.06, 0);
    add(geos, B(0.02, 0.06, 0.5), WHITE, 0.15, 0.06, 0);
    add(glow, new THREE.SphereGeometry(0.11, 10, 8), 0, 0, 0.02, -0.56);
  } else { // hyper
    add(geos, B(0.14, 0.2, 0.7), SHELL, 0, 0, 0.1);
    add(geos, C(0.04, 0.04, 0.85), DARK, 0, 0.03, -0.65, HPI);
    add(geos, C(0.06, 0.06, 0.12), WHITE, 0, 0.03, -1.02, HPI);
    add(geos, C(0.055, 0.055, 0.35), DARK, 0, 0.18, -0.05, HPI); // scope
    add(geos, B(0.12, 0.18, 0.35), SHELL, 0, -0.04, 0.55);
    add(geos, B(0.1, 0.06, 0.2), WHITE, 0, 0.09, 0.5);
    add(geos, B(0.12, 0.26, 0.15), DARK, 0, -0.2, 0.3, 0.3);
    add(glow, C(0.045, 0.045, 0.02), 0, 0, 0.18, 0.14, HPI);     // scope lens
  }

  const { body, energy } = blasterMats(w.color);
  const g = new THREE.Group();
  const shellMesh = new THREE.Mesh(mergeGeometries(geos.map(x => x.toNonIndexed()), false), body);
  shellMesh.castShadow = true;
  g.add(shellMesh);
  if (glow.length) g.add(new THREE.Mesh(mergeGeometries(glow.map(x => x.toNonIndexed()), false), energy));
  return g;
}

export class ProjectileSystem {
  constructor(scene, world, fx) {
    this.scene = scene;
    this.world = world;
    this.fx = fx;           // {spawnPuff(pos,color,scale), onDamage(target, dmg, attacker)}
    this.projectiles = [];
    this.geoBall = new THREE.SphereGeometry(1, 8, 6);
    this.mats = {};
  }

  matFor(color) {
    if (!this.mats[color]) {
      this.mats[color] = new THREE.MeshBasicMaterial({ color });
    }
    return this.mats[color];
  }

  fire(owner, origin, dir, weaponId) {
    const w = WEAPONS[weaponId];
    for (let i = 0; i < w.pellets; i++) {
      const d = dir.clone();
      d.x += rand(-w.spread, w.spread);
      d.y += rand(-w.spread, w.spread);
      d.z += rand(-w.spread, w.spread);
      d.normalize();
      const mesh = new THREE.Mesh(this.geoBall, this.matFor(w.color));
      if (w.disc) mesh.scale.set(w.size * 1.5, w.size * 0.35, w.size * 1.5);
      else mesh.scale.setScalar(w.size);
      mesh.position.copy(origin);
      this.scene.add(mesh);
      this.projectiles.push({
        mesh, owner, weapon: w,
        pos: origin.clone(),
        vel: d.multiplyScalar(w.speed),
        life: 4, trailT: 0, bounced: 0,
      });
    }
    // muzzle flash only for other shooters — your own fills the screen
    if (!owner.isPlayer) this.fx.spawnPuff(origin, w.color, 0.3);
    sfx(w.sound);
  }

  // Characters: array of {pos, height, radius, alive, team, ...}
  update(dt, characters) {
    const step = new THREE.Vector3();
    const prev = new THREE.Vector3();
    const probe = new THREE.Vector3();
    for (let pi = this.projectiles.length - 1; pi >= 0; pi--) {
      const p = this.projectiles[pi];
      p.life -= dt;
      if (p.weapon.gravity) p.vel.y -= this.world.gravity * 0.9 * dt;
      if (p.weapon.trail) {
        p.trailT += dt;
        if (p.trailT > 0.05) { p.trailT = 0; this.fx.spawnPuff(p.pos, p.weapon.color, 0.25); }
      }

      const moveLen = p.vel.length() * dt;
      const nSteps = Math.max(1, Math.ceil(moveLen / 0.8));
      let dead = p.life <= 0;
      for (let s = 0; s < nSteps && !dead; s++) {
        step.copy(p.vel).multiplyScalar(dt / nSteps);
        prev.copy(p.pos);
        p.pos.add(step);

        // hit a character?
        for (const ch of characters) {
          if (!ch.alive || ch === p.owner || ch.team === p.owner.team) continue;
          const dx = p.pos.x - ch.pos.x;
          const dy = p.pos.y - (ch.pos.y + ch.height * 0.55);
          const dz = p.pos.z - ch.pos.z;
          if (dx * dx + dz * dz < 0.85 && Math.abs(dy) < ch.height * 0.65) {
            this.fx.onDamage(ch, p.weapon.dmg * p.owner.damageMult, p.owner);
            this.fx.spawnPuff(p.pos, p.weapon.color, 0.6);
            dead = true;
            break;
          }
        }
        if (!dead && pointHitsWorld(p.pos, p.weapon.size * 0.6, this.world)) {
          if (p.weapon.bounce && p.bounced < p.weapon.bounce) {
            // Sidewinder disc: reflect off whichever axis is blocked
            const r = p.weapon.size * 0.6;
            p.pos.copy(prev);
            let hitAxis = false;
            if (pointHitsWorld(probe.set(prev.x + step.x, prev.y, prev.z), r, this.world)) { p.vel.x *= -1; hitAxis = true; }
            if (pointHitsWorld(probe.set(prev.x, prev.y + step.y, prev.z), r, this.world)) { p.vel.y *= -1; hitAxis = true; }
            if (pointHitsWorld(probe.set(prev.x, prev.y, prev.z + step.z), r, this.world)) { p.vel.z *= -1; hitAxis = true; }
            if (!hitAxis) p.vel.negate(); // cornered — bounce straight back
            p.vel.multiplyScalar(0.95);
            p.bounced++;
            this.fx.spawnPuff(p.pos, p.weapon.color, 0.3);
          } else {
            dead = true;
          }
        }
        if (!dead && p.pos.y < this.world.killY) dead = true;
      }

      if (dead) {
        if (p.weapon.splash && p.life > 0) this.explode(p);
        else if (p.life > 0) this.fx.spawnPuff(p.pos, p.weapon.color, 0.5);
        this.scene.remove(p.mesh);
        this.projectiles.splice(pi, 1);
        continue;
      }
      p.mesh.position.copy(p.pos);
    }
  }

  explode(p) {
    sfx('explode');
    this.fx.spawnPuff(p.pos, 0xffa030, Math.max(3.2, p.weapon.splash * 0.75));
    for (const ch of this.fx.characters()) {
      if (!ch.alive || ch.team === p.owner.team && ch !== p.owner) continue;
      if (ch === p.owner) continue; // no self-splash damage (keeps zooka fun)
      const center = ch.pos.clone(); center.y += ch.height * 0.5;
      const d = center.distanceTo(p.pos);
      if (d < p.weapon.splash) {
        const dmg = p.weapon.splashDmg * (1 - d / p.weapon.splash);
        this.fx.onDamage(ch, dmg * p.owner.damageMult, p.owner);
      }
    }
  }

  clear() {
    for (const p of this.projectiles) this.scene.remove(p.mesh);
    this.projectiles.length = 0;
  }
}

// Simple expanding-fading puff effects.
export class FXPool {
  constructor(scene) {
    this.scene = scene;
    this.puffs = [];
    this.geo = new THREE.SphereGeometry(1, 8, 6);
  }
  spawnPuff(pos, color, scale = 1) {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 });
    const m = new THREE.Mesh(this.geo, mat);
    m.position.copy(pos);
    m.scale.setScalar(scale * 0.3);
    this.scene.add(m);
    this.puffs.push({ m, t: 0, scale });
  }
  update(dt) {
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      p.t += dt * 3.5;
      p.m.scale.setScalar(p.scale * (0.3 + p.t));
      p.m.material.opacity = Math.max(0, 0.85 * (1 - p.t));
      if (p.t >= 1) {
        this.scene.remove(p.m);
        p.m.material.dispose();
        this.puffs.splice(i, 1);
      }
    }
  }
  clear() {
    for (const p of this.puffs) { this.scene.remove(p.m); p.m.material.dispose(); }
    this.puffs.length = 0;
  }
}
