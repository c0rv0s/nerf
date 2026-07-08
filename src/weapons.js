// Weapon definitions + shared projectile system (used by player and bots).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { pointHitsWorld, rand, shellInnerNormal } from './engine.js';
import { aiTex } from './maps.js';
import { sfx } from './audio.js';

export const WEAPON_ORDER = ['blaster', 'scatter', 'pulsar', 'sidewinder', 'zooka', 'whomper', 'hyper', 'parasite', 'refractor'];

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
  sidewinder: { name: 'SIDEWINDER',   slot: 4, dmg: 18, rof: 1.6, speed: 55,  spread: 0.01,
                pellets: 1, ammo: 0, pickupAmmo: 10, color: 0x8aff30, size: 0.17,
                disc: true, bounce: 6, bounceDmgGain: 5, sound: 'disc' },
  zooka:      { name: 'BALLZOOKA',    slot: 5, dmg: 42, rof: 0.8, speed: 38,  spread: 0.005,
                pellets: 1, ammo: 0, pickupAmmo: 6, color: 0xffe040, size: 0.35,
                splash: 5.5, splashDmg: 32, gravity: true, trail: true, sound: 'zooka' },
  whomper:    { name: 'WHOMPER',      slot: 6, dmg: 85, rof: 0.5, speed: 42,  spread: 0.004,
                pellets: 1, ammo: 0, pickupAmmo: 4, color: 0xff4fa0, size: 0.42,
                splash: 10, splashDmg: 50, sound: 'whomp' },
  hyper:      { name: 'HYPERSTRIKE',  slot: 7, dmg: 68, rof: 0.7, speed: 320, spread: 0.001,
                pellets: 1, ammo: 0, pickupAmmo: 5, color: 0xff3050, size: 0.12,
                pierce: 2, trail: true, sound: 'hyper' },
  parasite:   { name: 'PARASITE',      slot: 8, dmg: 24, rof: 0.95, speed: 130, spread: 0.006,
                pellets: 1, ammo: 0, pickupAmmo: 8, color: 0x00f5d4, size: 0.14,
                bounce: 1, split: 6, childDmg: 16, childSpeed: 105, childBounce: 2, texture: 'parasite',
                trail: true, sound: 'hyper' },
  refractor:  { name: 'REFRACTOR',     slot: 9, dmg: 22, rof: 0.5, speed: 0,   spread: 0,
                pellets: 1, ammo: 0, pickupAmmo: 5, color: 0xff4ff7, size: 0.09,
                beam: true, beamBounces: 5, beamRange: 130, beamLife: 2.8, beamRetract: 0.9,
                beamDamageInterval: 0.4, secretMapOnly: true, texture: 'refractor', sound: 'hyper' },
};

export function nextLoadedWeaponAfter(currentId, owned = {}, ammo = {}) {
  const start = Math.max(0, WEAPON_ORDER.indexOf(currentId));
  for (let offset = 1; offset < WEAPON_ORDER.length; offset++) {
    const id = WEAPON_ORDER[(start + offset) % WEAPON_ORDER.length];
    if (id !== 'blaster' && owned[id] && ammo[id] > 0) return id;
  }
  return 'blaster';
}

/* ---------------- procedural blaster models ----------------
   Distinct Nerf-style silhouettes per weapon, merged into 2 draw calls each
   (plastic shell with baked vertex colors + one emissive "energy" mesh). */
const _blasterMats = {};
function blasterMats(color, textureName = null) {
  const bodyKey = textureName ? `body-${textureName}` : 'body';
  if (!_blasterMats[bodyKey]) {
    _blasterMats[bodyKey] = new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.45, metalness: 0.05,
      envMapIntensity: textureName ? 0.85 : 0.5,
      ...aiTex(textureName || 'plastic', textureName ? 1.3 : 0.6, textureName ? 1.3 : 0.6),
    });
  }
  const key = 'e' + color;
  if (!_blasterMats[key]) {
    _blasterMats[key] = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 1.3, roughness: 0.4 });
  }
  return { body: _blasterMats[bodyKey], energy: _blasterMats[key] };
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
  } else if (id === 'hyper') {
    add(geos, B(0.14, 0.2, 0.7), SHELL, 0, 0, 0.1);
    add(geos, C(0.04, 0.04, 0.85), DARK, 0, 0.03, -0.65, HPI);
    add(geos, C(0.06, 0.06, 0.12), WHITE, 0, 0.03, -1.02, HPI);
    add(geos, C(0.055, 0.055, 0.35), DARK, 0, 0.18, -0.05, HPI); // scope
    add(geos, B(0.12, 0.18, 0.35), SHELL, 0, -0.04, 0.55);
    add(geos, B(0.1, 0.06, 0.2), WHITE, 0, 0.09, 0.5);
    add(geos, B(0.12, 0.26, 0.15), DARK, 0, -0.2, 0.3, 0.3);
    add(glow, C(0.045, 0.045, 0.02), 0, 0, 0.18, 0.14, HPI);     // scope lens
  } else if (id === 'parasite') {
    add(geos, B(0.18, 0.22, 0.68), SHELL, 0, 0, 0.06);
    add(geos, C(0.055, 0.045, 0.72), DARK, 0, 0.02, -0.56, HPI);
    add(geos, C(0.09, 0.075, 0.08), 0xff36b8, 0, 0.02, -0.94, HPI);
    add(geos, C(0.11, 0.11, 0.14), 0xff36b8, -0.13, 0.02, -0.16, HPI); // side sacs
    add(geos, C(0.11, 0.11, 0.14), 0xff36b8, 0.13, 0.02, -0.16, HPI);
    add(geos, C(0.075, 0.105, 0.22), WHITE, 0, 0.16, 0.05, 0, HPI);
    add(geos, C(0.075, 0.105, 0.22), WHITE, 0, -0.13, 0.05, 0, HPI);
    add(geos, B(0.09, 0.07, 0.46), DARK, 0, 0.17, 0.16);
    add(geos, B(0.11, 0.28, 0.16), DARK, 0, -0.24, 0.28, 0.25);
    add(geos, B(0.22, 0.14, 0.22), 0xff36b8, 0, -0.05, 0.5);
    add(glow, C(0.115, 0.115, 0.035), 0, -0.13, 0.02, -0.16, HPI);
    add(glow, C(0.115, 0.115, 0.035), 0, 0.13, 0.02, -0.16, HPI);
    add(glow, B(0.14, 0.035, 0.35), 0, 0, 0.08, 0.18);
  } else { // refractor
    add(geos, B(0.13, 0.2, 0.72), SHELL, 0, 0, 0.08);
    add(geos, B(0.22, 0.08, 0.4), WHITE, 0, 0.08, -0.3);
    add(geos, C(0.045, 0.035, 0.88), DARK, 0, 0.03, -0.62, HPI);
    add(geos, C(0.11, 0.11, 0.07), WHITE, 0, 0.03, -1.04, HPI);
    add(geos, C(0.12, 0.12, 0.08), 0x7ffcff, -0.12, 0.08, 0.08, 0, HPI);
    add(geos, C(0.12, 0.12, 0.08), 0xffe040, 0.12, 0.08, 0.08, 0, HPI);
    add(geos, B(0.12, 0.26, 0.15), DARK, 0, -0.22, 0.25, 0.28);
    add(geos, B(0.08, 0.07, 0.38), WHITE, 0, 0.18, 0.12);
    add(glow, C(0.08, 0.08, 0.03), 0, 0, 0.03, -1.08, HPI);
    add(glow, B(0.16, 0.035, 0.42), 0, 0, 0.1, -0.06);
  }

  const { body, energy } = blasterMats(w.color, w.texture);
  const g = new THREE.Group();
  const shellMesh = new THREE.Mesh(mergeGeometries(geos.map(x => x.toNonIndexed()), false), body);
  shellMesh.userData.baseMaterial = body;
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
    this.beams = [];
    this.nextShotId = 1;
    this.nextBeamId = 1;
    this.geoBall = new THREE.SphereGeometry(1, 8, 6);
    this.mats = {};
    this.beamMats = {};
  }

  makeShotGroup(owner, weapon) {
    return { id: this.nextShotId++, owner, weaponId: Object.keys(WEAPONS).find(id => WEAPONS[id] === weapon), kills: 0 };
  }

  matFor(color) {
    if (!this.mats[color]) {
      this.mats[color] = new THREE.MeshBasicMaterial({ color });
    }
    return this.mats[color];
  }

  beamMatFor(color, alpha = 0.68) {
    const key = `${color}:${alpha}`;
    if (!this.beamMats[key]) {
      this.beamMats[key] = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: alpha, depthWrite: false,
      });
    }
    return this.beamMats[key];
  }

  rayBox(origin, dir, box, maxDist) {
    let tmin = -Infinity, tmax = Infinity;
    const nmin = new THREE.Vector3();
    const nmax = new THREE.Vector3();
    const axes = [
      ['x', new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0)],
      ['y', new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 1, 0)],
      ['z', new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, 1)],
    ];
    for (const [axis, lowNormal, highNormal] of axes) {
      const o = origin[axis], d = dir[axis], mn = box.min[axis], mx = box.max[axis];
      if (Math.abs(d) < 1e-6) {
        if (o < mn || o > mx) return null;
        continue;
      }
      let t1 = (mn - o) / d, t2 = (mx - o) / d;
      let n1 = lowNormal, n2 = highNormal;
      if (t1 > t2) {
        [t1, t2] = [t2, t1];
        [n1, n2] = [n2, n1];
      }
      if (t1 > tmin) { tmin = t1; nmin.copy(n1); }
      if (t2 < tmax) { tmax = t2; nmax.copy(n2); }
      if (tmin > tmax) return null;
    }
    const t = tmin > 0.03 ? tmin : tmax;
    if (t <= 0.03 || t > maxDist) return null;
    return { t, normal: (tmin > 0.03 ? nmin : nmax).clone() };
  }

  rayShell(origin, dir, box, maxDist) {
    const normal = shellInnerNormal(box, this.world, new THREE.Vector3());
    if (!normal) return null;
    const axis = Math.abs(normal.x) > 0.5 ? 'x' : Math.abs(normal.y) > 0.5 ? 'y' : 'z';
    const sign = normal[axis];
    const plane = sign > 0 ? box.max[axis] : box.min[axis];
    const signedDist = (origin[axis] - plane) * sign;
    const approach = dir[axis] * sign;
    if (approach >= -1e-6) return null;
    const t = -signedDist / approach;
    if (t <= 0.03 || t > maxDist) return null;
    for (const other of ['x', 'y', 'z']) {
      if (other === axis) continue;
      const v = origin[other] + dir[other] * t;
      if (v < box.min[other] - 0.03 || v > box.max[other] + 0.03) return null;
    }
    return { t, normal: normal.clone() };
  }

  rayWorld(origin, dir, maxDist) {
    let best = null;
    for (const c of this.world.colliders || []) {
      if (c.type !== 'box') continue;
      const hit = c.shell ? this.rayShell(origin, dir, c, maxDist) : this.rayBox(origin, dir, c, maxDist);
      if (hit && (!best || hit.t < best.t)) best = hit;
    }
    return best;
  }

  makeBeamSegment(start, end, color) {
    const len = start.distanceTo(end);
    const g = new THREE.Group();
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 1, 10), this.beamMatFor(color, 0.86));
    const glow = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1, 10), this.beamMatFor(color, 0.18));
    g.add(glow, core);
    this.scene.add(g);
    const seg = { group: g, start: start.clone(), end: end.clone(), len, activeStart: start.clone(), activeEnd: end.clone() };
    this.placeBeamSegment(seg, start, end);
    return seg;
  }

  placeBeamSegment(seg, start, end) {
    const len = start.distanceTo(end);
    seg.activeStart.copy(start);
    seg.activeEnd.copy(end);
    seg.group.visible = len > 0.05;
    if (!seg.group.visible) return;
    seg.group.position.copy(start).lerp(end, 0.5);
    seg.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.clone().sub(start).normalize());
    for (const m of seg.group.children) m.scale.y = len;
  }

  spawnBeam(owner, origin, dir, weapon, shotGroup = this.makeShotGroup(owner, weapon)) {
    const points = [origin.clone()];
    let pos = origin.clone();
    let vel = dir.clone().normalize();
    let remaining = weapon.beamRange || 120;
    for (let i = 0; i <= (weapon.beamBounces || 0); i++) {
      const hit = this.rayWorld(pos, vel, remaining);
      if (!hit) {
        points.push(pos.clone().addScaledVector(vel, remaining));
        break;
      }
      const end = pos.clone().addScaledVector(vel, hit.t);
      points.push(end);
      remaining -= hit.t;
      if (i >= (weapon.beamBounces || 0) || remaining <= 1) break;
      vel.reflect(hit.normal).normalize();
      pos.copy(end).addScaledVector(vel, 0.08);
    }
    if (points.length < 2) return;
    const segments = [];
    let totalLen = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const seg = this.makeBeamSegment(points[i], points[i + 1], weapon.color);
      segments.push(seg);
      totalLen += seg.len;
    }
    this.beams.push({
      id: this.nextBeamId++, owner, weapon, shotGroup, segments, totalLen,
      age: 0, life: weapon.beamLife || 2.5, retract: weapon.beamRetract || 0.8,
      hitCooldowns: new Map(),
    });
    this.fx.spawnPuff(points[points.length - 1], weapon.color, 0.45);
  }

  spawnProjectile(owner, origin, dir, weapon, opts = {}) {
    const mesh = new THREE.Mesh(this.geoBall, this.matFor(weapon.color));
    if (weapon.disc) mesh.scale.set(weapon.size * 1.5, weapon.size * 0.35, weapon.size * 1.5);
    else mesh.scale.setScalar(opts.size ?? weapon.size);
    mesh.position.copy(origin);
    this.scene.add(mesh);
    this.projectiles.push({
      mesh, owner, weapon,
      pos: origin.clone(),
      vel: dir.clone().multiplyScalar(opts.speed ?? weapon.speed),
      life: opts.life ?? 4,
      trailT: 0,
      bounced: 0,
      bounceLimit: opts.bounce ?? weapon.bounce,
      pierced: weapon.pierce ? new Set() : null,
      ignore: opts.ignore ? new Set(opts.ignore) : null,
      damage: opts.damage ?? weapon.dmg,
      noSplit: opts.noSplit === true,
      shotGroup: opts.shotGroup || this.makeShotGroup(owner, weapon),
    });
  }

  fire(owner, origin, dir, weaponId) {
    const w = WEAPONS[weaponId];
    const shotGroup = this.makeShotGroup(owner, w);
    if (w.beam) {
      this.spawnBeam(owner, origin, dir, w, shotGroup);
      sfx(w.sound, owner.isPlayer ? null : origin);
      return;
    }
    for (let i = 0; i < w.pellets; i++) {
      const d = dir.clone();
      d.x += rand(-w.spread, w.spread);
      d.y += rand(-w.spread, w.spread);
      d.z += rand(-w.spread, w.spread);
      d.normalize();
      this.spawnProjectile(owner, origin, d, w, { shotGroup });
    }
    // muzzle flash only for other shooters — your own fills the screen
    if (!owner.isPlayer) this.fx.spawnPuff(origin, w.color, 0.3);
    sfx(w.sound, owner.isPlayer ? null : origin);
  }

  splitParasite(p, ch) {
    const origin = ch.pos.clone();
    origin.y += ch.height * 0.5;
    const base = p.vel.clone();
    base.y = 0;
    if (base.lengthSq() < 0.001) base.set(0, 0, -1);
    base.normalize();
    const count = p.weapon.split || 3;
    const spread = 0.9;
    for (let i = 0; i < count; i++) {
      const angle = count === 1 ? 0 : -spread + (spread * 2 * i) / (count - 1);
      const dir = base.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), angle).normalize();
      this.spawnProjectile(p.owner, origin, dir, p.weapon, {
        damage: p.weapon.childDmg ?? p.weapon.dmg,
        speed: p.weapon.childSpeed ?? p.weapon.speed,
        size: p.weapon.size * 0.82,
        life: 2.2,
        bounce: p.weapon.childBounce ?? p.weapon.bounce,
        ignore: [ch],
        noSplit: true,
        shotGroup: p.shotGroup,
      });
    }
  }

  distancePointToSegment(point, a, b) {
    const ab = b.clone().sub(a);
    const d2 = ab.lengthSq();
    if (d2 < 1e-6) return point.distanceTo(a);
    const t = Math.max(0, Math.min(1, point.clone().sub(a).dot(ab) / d2));
    return point.distanceTo(a.clone().addScaledVector(ab, t));
  }

  characterTouchesSegment(ch, a, b, pad = 0.25) {
    const up = ch.up || new THREE.Vector3(0, 1, 0);
    const samples = [0.35, 0.55, 0.8].map(f => ch.pos.clone().addScaledVector(up, ch.height * f));
    const r = (ch.radius || 0.45) + pad;
    return samples.some(p => this.distancePointToSegment(p, a, b) < r);
  }

  projectileTouchesCharacter(ch, p) {
    const up = ch.up || new THREE.Vector3(0, 1, 0);
    const radius = (ch.radius || 0.45) + (p.weapon.size || 0.12) * 0.6 + 0.35;
    const foot = ch.pos.clone().addScaledVector(up, ch.radius || 0.45);
    const head = ch.pos.clone().addScaledVector(up, Math.max(ch.height - (ch.radius || 0.45), ch.height * 0.55));
    return this.distancePointToSegment(p.pos, foot, head) < radius;
  }

  updateBeams(dt, characters) {
    for (let bi = this.beams.length - 1; bi >= 0; bi--) {
      const b = this.beams[bi];
      b.age += dt;
      const retractStart = Math.max(0.05, b.life - b.retract);
      const tailDist = b.age <= retractStart ? 0 :
        Math.min(b.totalLen, ((b.age - retractStart) / b.retract) * b.totalLen);
      let cursor = 0;
      for (const seg of b.segments) {
        const segTail = Math.max(0, tailDist - cursor);
        if (segTail >= seg.len) {
          seg.group.visible = false;
        } else {
          const start = seg.start.clone().lerp(seg.end, segTail / seg.len);
          this.placeBeamSegment(seg, start, seg.end);
        }
        cursor += seg.len;
      }
      for (const [ch, t] of b.hitCooldowns) b.hitCooldowns.set(ch, Math.max(0, t - dt));
      for (const ch of characters) {
        if (!ch.alive || ch === b.owner || ch.team === b.owner.team) continue;
        if ((b.hitCooldowns.get(ch) || 0) > 0) continue;
        if (b.segments.some(seg => seg.group.visible && this.characterTouchesSegment(ch, seg.activeStart, seg.activeEnd))) {
          this.fx.onDamage(ch, b.weapon.dmg * b.owner.damageMult, b.owner, { shotGroup: b.shotGroup });
          const hitPos = ch.pos.clone().addScaledVector(ch.up || new THREE.Vector3(0, 1, 0), ch.height * 0.55);
          this.fx.spawnPuff(hitPos, b.weapon.color, 0.45);
          b.hitCooldowns.set(ch, b.weapon.beamDamageInterval || 0.4);
        }
      }
      if (b.age >= b.life) {
        for (const seg of b.segments) this.scene.remove(seg.group);
        this.beams.splice(bi, 1);
      }
    }
  }

  // Characters: array of {pos, height, radius, alive, team, ...}
  update(dt, characters) {
    this.updateBeams(dt, characters);
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
          if (!ch.alive || ch === p.owner || ch.team === p.owner.team ||
              p.pierced?.has(ch) || p.ignore?.has(ch)) continue;
          if (this.projectileTouchesCharacter(ch, p)) {
            this.fx.onDamage(ch, p.damage * p.owner.damageMult, p.owner, { shotGroup: p.shotGroup });
            this.fx.spawnPuff(p.pos, p.weapon.color, 0.6);
            if (p.weapon.split && !p.noSplit) {
              this.splitParasite(p, ch);
              dead = true;
            } else if (p.weapon.pierce && p.pierced.size < p.weapon.pierce) {
              p.pierced.add(ch);
            } else {
              dead = true;
            }
            break;
          }
        }
        if (!dead && pointHitsWorld(p.pos, p.weapon.size * 0.6, this.world)) {
          if (p.bounceLimit && p.bounced < p.bounceLimit) {
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
            if (p.weapon.bounceDmgGain) p.damage += p.weapon.bounceDmgGain;
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
    sfx('explode', p.pos);
    this.fx.spawnPuff(p.pos, 0xffa030, Math.max(3.2, p.weapon.splash * 0.75));
    for (const ch of this.fx.characters()) {
      if (!ch.alive || ch.team === p.owner.team && ch !== p.owner) continue;
      if (ch === p.owner) continue; // no self-splash damage (keeps zooka fun)
      const center = ch.pos.clone(); center.y += ch.height * 0.5;
      const d = center.distanceTo(p.pos);
      if (d < p.weapon.splash) {
        const dmg = p.weapon.splashDmg * (1 - d / p.weapon.splash);
        this.fx.onDamage(ch, dmg * p.owner.damageMult, p.owner, { shotGroup: p.shotGroup });
      }
    }
  }

  clear() {
    for (const p of this.projectiles) this.scene.remove(p.mesh);
    this.projectiles.length = 0;
    for (const b of this.beams) for (const seg of b.segments) this.scene.remove(seg.group);
    this.beams.length = 0;
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
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false });
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
