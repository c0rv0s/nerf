// Weapon definitions + shared projectile system (used by player and bots).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  hasLOS, pointHitsWorld, rand, rayHitsCylinderShell, rayHitsEllipsoid, shellInnerNormal,
} from './engine.js';
import { aiTex } from './maps.js';
import { sfx } from './audio.js';
import { HORSE_HEIGHT_DELTA } from './mount.js';

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const BEAM_SAMPLE_HEIGHTS = [0.35, 0.55, 0.8];
const LIGHTNING_ARC_POINTS = 9;
const LIGHTNING_ARC_PREALLOCATE = 12;

export const WEAPON_ORDER = ['blaster', 'scatter', 'pulsar', 'sidewinder', 'zooka', 'hyper', 'parasite', 'whomper', 'loophole', 'refractor', 'thunderbolt'];

export const WEAPONS = {
  blaster:    { name: 'SECRET SHOT',  slot: 1, dmg: 12, rof: 3.2, speed: 65,  spread: 0.012,
                pellets: 1, ammo: Infinity, pickupAmmo: 0, color: 0xffa020, size: 0.13,
                texture: 'blaster', sound: 'blaster' },
  scatter:    { name: 'SCATTERBLAST', slot: 2, dmg: 9,  rof: 1.1, speed: 90,  spread: 0.07,
                pellets: 6, ammo: 0, pickupAmmo: 12, color: 0x40d0ff, size: 0.11,
                texture: 'scatter', sound: 'scatter' },
  pulsar:     { name: 'PULSATOR',     slot: 3, dmg: 7,  rof: 9,   speed: 75,  spread: 0.035,
                pellets: 1, ammo: 0, pickupAmmo: 60, color: 0xb060ff, size: 0.1,
                texture: 'pulsar', sound: 'pulsar' },
  sidewinder: { name: 'SIDEWINDER',   slot: 4, dmg: 18, rof: 1.6, speed: 55,  spread: 0.01,
                pellets: 1, ammo: 0, pickupAmmo: 10, color: 0x8aff30, size: 0.17,
                disc: true, bounce: 6, bounceDmgGain: 5, homingRange: 38, homingTurn: 0.58, homingTurnGain: 0.04,
                texture: 'sidewinder', sound: 'disc' },
  zooka:      { name: 'BALLZOOKA',    slot: 5, dmg: 42, rof: 0.8, speed: 38,  spread: 0.005,
                pellets: 1, ammo: 0, pickupAmmo: 6, color: 0xffe040, size: 0.35,
                splash: 5.5, splashDmg: 38, gravity: true, trail: true, texture: 'zooka', sound: 'zooka' },
  whomper:    { name: 'WHOMPER',      slot: 8, dmg: 135, rof: 0.33, speed: 42, spread: 0.004,
                pellets: 1, ammo: 0, pickupAmmo: 4, color: 0xff4fa0, size: 0.84,
                warmup: 3, splash: 10, splashDmg: 85, flatSplash: true, splashExcludesDirect: true,
                glowingProjectile: true, texture: 'whomper', sound: 'whomp' },
  hyper:      { name: 'HYPERSTRIKE',  slot: 6, dmg: 68, rof: 0.7, speed: 420, spread: 0.001,
                pellets: 1, ammo: 0, pickupAmmo: 5, color: 0xff3050, size: 0.12,
                pierce: 2, headshotDmg: 175, trail: true, texture: 'hyper', sound: 'hyper' },
  parasite:   { name: 'PARASITE',      slot: 7, dmg: 24, rof: 0.95, speed: 130, spread: 0.006,
                pellets: 1, ammo: 0, pickupAmmo: 8, color: 0x00f5d4, size: 0.14,
                bounce: 1, split: 6, childDmg: 16, childSpeed: 105, childBounce: 2, texture: 'parasite',
                homingRange: 38, homingTurn: 0.58, childHomingRange: 34, childHomingTurn: 0.72,
                trail: true, sound: 'hyper' },
  loophole:   { name: 'LOOPHOLE',       slot: 5, dmg: 38, rof: 0.72, speed: 34, spread: 0.006,
                pellets: 1, ammo: 0, pickupAmmo: 6, color: 0x79ff16, size: 0.52,
                splash: 6.2, splashDmg: 38, gravity: true, trail: true, glowingProjectile: true,
                bounce: Infinity, groundBounce: true, bounceRestitution: 0.46,
                wallRestitution: 0.82, bounceFriction: 0.985, minBounceSpeed: 2.5,
                projectileLife: 8, explodeOnExpiry: true,
                explosionColor: 0x9dff24, remoteBounce: true,
                secretMapOnly: true, texture: 'infinite-bloom-surface', sound: 'zooka' },
  refractor:  { name: 'REFRACTOR',     slot: 9, dmg: 22, rof: 0.5, speed: 0,   spread: 0,
                pellets: 1, ammo: 0, pickupAmmo: 5, color: 0xff4ff7, size: 0.09,
                beam: true, beamBounces: 8, beamRange: 130, beamLife: 2.8, beamRetract: 0.9,
                beamDamageInterval: 0.4, secretMapOnly: true, texture: 'refractor', sound: 'hyper' },
  thunderbolt:{ name: 'THUNDERBOLT',    slot: 9, dmg: 46, rof: 0.62, speed: 165, spread: 0.002,
                pellets: 1, ammo: 0, pickupAmmo: 4, color: 0xffd43b, size: 0.18,
                lightning: true, chainRange: 17, chainCount: 3, chainDmg: 27,
                homingRange: 38, homingTurn: 0.58,
                trail: true, secretMapOnly: true, texture: 'power-gold', sound: 'thunder' },
};

// Presentation-only weapon character. These values never change damage, spread,
// rate of fire, or projectile behavior; they drive viewmodel and camera response.
export const WEAPON_FEEL = {
  blaster:    { recoil: 0.62, camera: 0.004, return: 13, flash: 0.85 },
  scatter:    { recoil: 1.35, camera: 0.012, return: 8,  flash: 1.25 },
  pulsar:     { recoil: 0.34, camera: 0.003, return: 18, flash: 0.72 },
  sidewinder: { recoil: 0.82, camera: 0.007, return: 10, flash: 0.9 },
  zooka:      { recoil: 1.55, camera: 0.016, return: 7,  flash: 1.45 },
  whomper:    { recoil: 1.8,  camera: 0.02,  return: 6,  flash: 1.6 },
  hyper:      { recoil: 1.15, camera: 0.011, return: 9,  flash: 1.1 },
  parasite:   { recoil: 0.92, camera: 0.008, return: 10, flash: 1.05 },
  loophole:   { recoil: 1.55, camera: 0.016, return: 7, flash: 1.55 },
  refractor:  { recoil: 0.7,  camera: 0.006, return: 8,  flash: 1.35 },
  thunderbolt:{ recoil: 1.45, camera: 0.016, return: 7,  flash: 1.65 },
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
const _blasterModels = {};
function blasterMats(color, textureName = null) {
  const bodyKey = textureName ? `body-${textureName}` : 'body';
  if (!_blasterMats[bodyKey]) {
    const tex = aiTex(textureName || 'plastic', textureName ? 0.16 : 0.6, textureName ? 0.16 : 0.6);
    if (textureName && tex.normalScale) tex.normalScale.set(0.06, 0.28);
    _blasterMats[bodyKey] = new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.45, metalness: 0.05,
      envMapIntensity: textureName ? 0.85 : 0.5,
      ...tex,
    });
  }
  const key = 'e' + color;
  if (!_blasterMats[key]) {
    _blasterMats[key] = new THREE.MeshStandardMaterial({
      color, emissive: color, emissiveIntensity: 1.3, roughness: 0.4 });
  }
  return { body: _blasterMats[bodyKey], energy: _blasterMats[key] };
}

// Powerup skins: generated, seamless energized-metal finishes replace the
// previous flat gold/silver tint while preserving each weapon's glow geometry.
export function blasterSkin(kind) {
  if (!kind) return blasterMats(0).body; // the shared plastic shell material
  const key = 'skin-' + kind;
  if (!_blasterMats[key]) {
    const gold = kind === 'gold';
    const c = gold ? 0xffc62e : 0xcfe7ff;
    const tex = aiTex(gold ? 'power-gold' : 'power-silver', 0.2, 0.2);
    if (tex.normalScale) tex.normalScale.set(gold ? 0.18 : 0.08, gold ? 0.08 : 0.18);
    _blasterMats[key] = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      metalness: gold ? 0.78 : 0.88,
      roughness: gold ? 0.27 : 0.2,
      envMapIntensity: 1.35,
      emissive: c,
      emissiveIntensity: gold ? 0.1 : 0.075,
      ...tex,
    });
    _blasterMats[key].userData.baseEmissive = gold ? 0.1 : 0.075;
  }
  return _blasterMats[key];
}

// Slow material drift makes the temporary skin feel energized without
// changing weapon geometry or creating extra viewmodel draw calls.
export function updateBlasterSkin(kind, t) {
  if (!kind) return;
  const mat = _blasterMats['skin-' + kind];
  if (!mat?.map) return;
  const gold = kind === 'gold';
  const x = t * (gold ? 0.018 : -0.012);
  const y = Math.sin(t * 0.32) * 0.035;
  mat.map.offset.set(x, y);
  if (mat.normalMap) mat.normalMap.offset.copy(mat.map.offset);
  mat.emissiveIntensity = mat.userData.baseEmissive + (0.5 + 0.5 * Math.sin(t * (gold ? 3.2 : 4.1))) * 0.055;
}

// Muzzle points −z, grip hangs down. Total length ≈ 1.2–1.7.
// Building and merging this geometry is expensive, especially when several
// Olympus bots reach different weapon pickups during the same fight. Keep one
// untouched source model per weapon and hand callers lightweight clones that
// share its immutable geometry and materials.
function createBlasterModel(id) {
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
  } else if (id === 'loophole') {
    // Nested square rails make the barrel look like a tiny arena containing
    // itself. The wide cage muzzle launches the oversized recursive blast orb.
    add(geos, B(0.26, 0.3, 0.82), SHELL, 0, 0, 0.08);
    add(geos, B(0.18, 0.16, 0.42), DARK, 0, -0.06, 0.55);
    add(geos, B(0.13, 0.32, 0.17), DARK, 0, -0.25, 0.3, 0.28);
    add(geos, B(0.32, 0.08, 0.62), 0xffb018, 0, 0.19, -0.13);
    for (const [s, z, color] of [[0.32, -0.34, WHITE], [0.25, -0.58, 0xf0ee1b], [0.18, -0.78, 0xff6816]]) {
      const bar = 0.045;
      add(geos, B(s, bar, 0.16), color, 0, s * 0.5, z);
      add(geos, B(s, bar, 0.16), color, 0, -s * 0.5, z);
      add(geos, B(bar, s, 0.16), color, s * 0.5, 0, z);
      add(geos, B(bar, s, 0.16), color, -s * 0.5, 0, z);
    }
    add(glow, new THREE.OctahedronGeometry(0.105, 0), 0, 0, 0.04, -0.86);
    add(glow, new THREE.TorusGeometry(0.15, 0.025, 7, 20), 0, 0, 0.04, -0.3);
  } else if (id === 'thunderbolt') {
    // A compact ceremonial rail-launcher: twin golden prongs cradle an
    // energized zig-zag core, giving Olympus its own unmistakable silhouette.
    add(geos, B(0.24, 0.28, 0.86), SHELL, 0, 0, 0.05);
    add(geos, B(0.1, 0.08, 0.72), WHITE, 0, 0.18, -0.04);
    add(geos, C(0.045, 0.045, 0.92), DARK, -0.13, 0.03, -0.58, HPI);
    add(geos, C(0.045, 0.045, 0.92), DARK, 0.13, 0.03, -0.58, HPI);
    add(geos, B(0.1, 0.18, 0.34), WHITE, -0.17, 0.02, -0.7);
    add(geos, B(0.1, 0.18, 0.34), WHITE, 0.17, 0.02, -0.7);
    add(geos, C(0.16, 0.16, 0.1), DARK, 0, 0.02, 0.38, 0, HPI);
    add(geos, B(0.14, 0.3, 0.17), DARK, 0, -0.24, 0.25, 0.28);
    add(geos, B(0.38, 0.06, 0.25), WHITE, 0, -0.02, 0.46);
    add(glow, new THREE.TorusGeometry(0.14, 0.025, 7, 20), 0, 0, 0.03, -0.38);
    for (const [x, z, a] of [[-0.055, -0.05, -0.48], [0.055, -0.27, 0.48], [-0.055, -0.49, -0.48], [0.055, -0.71, 0.48]]) {
      const bolt = B(0.045, 0.055, 0.28);
      bolt.rotateY(a);
      add(glow, bolt, 0, x, 0.03, z);
    }
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
  // Keep live Three.js objects out of userData. Object3D.clone() serializes
  // userData, so storing a Material here prevented recursive arena copies from
  // cloning the real held-weapon hierarchy safely.
  shellMesh._baseMaterial = body;
  shellMesh.castShadow = true;
  g.add(shellMesh);
  if (glow.length) g.add(new THREE.Mesh(mergeGeometries(glow.map(x => x.toNonIndexed()), false), energy));
  if (id === 'whomper') {
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(1, 14, 10),
      new THREE.MeshBasicMaterial({ color: w.color, toneMapped: false }),
    );
    const aura = new THREE.Mesh(
      new THREE.SphereGeometry(1, 12, 8),
      new THREE.MeshBasicMaterial({
        color: w.color, transparent: true, opacity: 0.28, depthWrite: false,
        blending: THREE.AdditiveBlending, toneMapped: false,
      }),
    );
    aura.scale.setScalar(1.58);
    const chargeOrb = new THREE.Group();
    chargeOrb.name = 'weapon-charge-orb';
    chargeOrb.position.set(0, 0.02, -0.62);
    chargeOrb.scale.setScalar(0.01);
    chargeOrb.visible = false;
    chargeOrb.add(core, aura);
    g.add(chargeOrb);
    // This is an object reference (and therefore circular through `parent`).
    // A private runtime field survives our source model without poisoning
    // Object3D.clone()'s JSON-based userData copy.
    g._chargeOrb = chargeOrb;
  }
  return g;
}

export function buildBlaster(id) {
  const source = _blasterModels[id] ||= createBlasterModel(id);
  const clone = source.clone(true);
  if (source.children[0]?._baseMaterial) {
    clone.children[0]._baseMaterial = source.children[0]._baseMaterial;
  }
  if (source._chargeOrb) clone._chargeOrb = clone.getObjectByName('weapon-charge-orb');
  return clone;
}

export function updateWeaponWarmupVisual(model, progress = -1, time = 0) {
  const orb = model?._chargeOrb;
  if (!orb) return;
  if (progress < 0) {
    orb.visible = false;
    return;
  }
  const p = Math.max(0, Math.min(1, progress));
  const pulse = 1 + Math.sin(time * (8 + p * 14)) * (0.025 + p * 0.035);
  orb.scale.setScalar((0.055 + p * 0.36) * pulse);
  orb.rotation.y = time * 2.4;
  orb.rotation.z = time * 1.7;
  orb.visible = true;
}

export function applyProjectileBounce(projectile, previous, step, probe, world) {
  const radius = (projectile.projectileSize || projectile.weapon.size) * 0.6;
  projectile.pos.copy(previous);
  let hitAxis = false;
  const hitX = pointHitsWorld(
    probe.set(previous.x + step.x, previous.y, previous.z), radius, world);
  const hitY = pointHitsWorld(
    probe.set(previous.x, previous.y + step.y, previous.z), radius, world);
  const hitZ = pointHitsWorld(
    probe.set(previous.x, previous.y, previous.z + step.z), radius, world);
  if (projectile.weapon.groundBounce) {
    const wallRestitution = projectile.weapon.wallRestitution ?? 0.82;
    if (hitX) { projectile.vel.x *= -wallRestitution; hitAxis = true; }
    if (hitY) {
      projectile.vel.y *= -(projectile.weapon.bounceRestitution ?? 0.5);
      const minBounceSpeed = projectile.weapon.minBounceSpeed || 0;
      if (Math.abs(projectile.vel.y) < minBounceSpeed) {
        projectile.vel.y = Math.sign(projectile.vel.y || -step.y || 1) * minBounceSpeed;
      }
      const friction = projectile.weapon.bounceFriction ?? 0.985;
      projectile.vel.x *= friction;
      projectile.vel.z *= friction;
      hitAxis = true;
    }
    if (hitZ) { projectile.vel.z *= -wallRestitution; hitAxis = true; }
    if (!hitAxis) projectile.vel.negate().multiplyScalar(wallRestitution);
  } else {
    if (hitX) { projectile.vel.x *= -1; hitAxis = true; }
    if (hitY) { projectile.vel.y *= -1; hitAxis = true; }
    if (hitZ) { projectile.vel.z *= -1; hitAxis = true; }
    if (!hitAxis) projectile.vel.negate(); // cornered — bounce straight back
    projectile.vel.multiplyScalar(0.95);
  }
  projectile.bounced++;
  if (projectile.weapon.bounceDmgGain) projectile.damage += projectile.weapon.bounceDmgGain;
  if (projectile.homingTurnGain) projectile.homingTurn += projectile.homingTurnGain;
}

export class ProjectileSystem {
  constructor(scene, world, fx) {
    this.scene = scene;
    this.world = world;
    this.fx = fx;           // {spawnPuff(pos,color,scale), onDamage(target, dmg, attacker)}
    this.projectiles = [];
    this.beams = [];
    this.lightningArcs = [];
    this.lightningArcPool = [];
    this.freeLightningArcs = [];
    this.nextShotId = 1;
    this.nextBeamId = 1;
    this.geoBall = new THREE.SphereGeometry(1, 8, 6);
    this.mats = {};
    this.beamMats = {};
    this._beamDirection = new THREE.Vector3();
    this._beamStart = new THREE.Vector3();
    this._homingDesired = new THREE.Vector3();
    this._homingCurrent = new THREE.Vector3();
    this._segmentAB = new THREE.Vector3();
    this._segmentOffset = new THREE.Vector3();
    this._segmentClosest = new THREE.Vector3();
    this._segmentPoint = new THREE.Vector3();
    this._bodyFoot = new THREE.Vector3();
    this._bodyHead = new THREE.Vector3();
    this._horseForward = new THREE.Vector3();
    this._horseBodyStart = new THREE.Vector3();
    this._horseBodyEnd = new THREE.Vector3();
    this._horseBodyCenter = new THREE.Vector3();
    this._horseHead = new THREE.Vector3();
    this._headCenter = new THREE.Vector3();
    this._headOffset = new THREE.Vector3();
    this._headClosest = new THREE.Vector3();
    this._step = new THREE.Vector3();
    this._previous = new THREE.Vector3();
    this._probe = new THREE.Vector3();
    for (let i = 0; i < LIGHTNING_ARC_PREALLOCATE; i++) {
      this.freeLightningArcs.push(this.createLightningArc());
    }
  }

  makeShotGroup(owner, weapon) {
    return { id: this.nextShotId++, owner, weaponId: Object.keys(WEAPONS).find(id => WEAPONS[id] === weapon), kills: 0 };
  }

  matFor(color, glowing = false) {
    const key = `${color}:${glowing ? 'glow' : 'plain'}`;
    if (!this.mats[key]) {
      this.mats[key] = new THREE.MeshBasicMaterial({ color, toneMapped: !glowing });
    }
    return this.mats[key];
  }

  projectileAuraMatFor(color) {
    const key = `${color}:aura`;
    if (!this.mats[key]) {
      this.mats[key] = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.24, depthWrite: false,
        blending: THREE.AdditiveBlending, toneMapped: false,
      });
    }
    return this.mats[key];
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

  raySphere(origin, dir, sphere, maxDist) {
    // All rayWorld callers pass a normalized direction. Solve the quadratic
    // in its reduced form and choose the exit root when a shot begins inside
    // a sphere, matching rayBox's inside-solid behaviour.
    const offset = origin.clone().sub(sphere.center);
    const projected = offset.dot(dir);
    const discriminant = projected * projected
      - (offset.lengthSq() - sphere.radius * sphere.radius);
    if (discriminant < 0) return null;
    const root = Math.sqrt(discriminant);
    const near = -projected - root;
    const far = -projected + root;
    const t = near > 0.03 ? near : far;
    if (t <= 0.03 || t > maxDist) return null;
    const point = origin.clone().addScaledVector(dir, t);
    return { t, normal: point.sub(sphere.center).normalize() };
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
      let hit = null;
      if (c.type === 'box') hit = c.shell
        ? this.rayShell(origin, dir, c, maxDist)
        : this.rayBox(origin, dir, c, maxDist);
      else if (c.type === 'sphere') hit = this.raySphere(origin, dir, c, maxDist);
      else if (c.type === 'ellipsoid') hit = rayHitsEllipsoid(origin, dir, c, maxDist);
      else if (c.type === 'cylinderShell') hit = rayHitsCylinderShell(origin, dir, c, maxDist);
      if (hit && (!best || hit.t < best.t)) best = hit;
    }
    return best;
  }

  makeBeamSegment(start, end, color, options = {}) {
    const len = start.distanceTo(end);
    const widthScale = options.widthScale || 1;
    const displayScale = options.displayScale || 1;
    const coreRadius = (options.coreRadius || 0.055) * widthScale * displayScale;
    const glowRadius = (options.glowRadius || 0.16) * widthScale * displayScale;
    const g = new THREE.Group();
    const core = new THREE.Mesh(new THREE.CylinderGeometry(coreRadius, coreRadius, 1, 10), this.beamMatFor(color, 0.9));
    const glow = new THREE.Mesh(new THREE.CylinderGeometry(glowRadius, glowRadius, 1, 12), this.beamMatFor(color, 0.2));
    g.add(glow, core);
    this.scene.add(g);
    const seg = {
      group: g,
      start: start.clone(),
      end: end.clone(),
      len,
      activeStart: start.clone(),
      activeEnd: end.clone(),
      displayScale,
      stage: options.stage || 0,
      damage: options.damage,
      color,
    };
    this.placeBeamSegment(seg, start, end);
    return seg;
  }

  createLightningArc() {
    const geometry = new THREE.BufferGeometry();
    const positions = new THREE.BufferAttribute(new Float32Array(LIGHTNING_ARC_POINTS * 3), 3);
    positions.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', positions);
    const glowMat = new THREE.LineBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.62, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const coreMat = new THREE.LineBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.96, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const glow = new THREE.Line(geometry, glowMat);
    const core = new THREE.Line(geometry, coreMat);
    // The vertices move whenever an arc is reused, so a cached bounding sphere
    // would be stale. These effects live for only a fraction of a second.
    glow.frustumCulled = false;
    core.frustumCulled = false;
    const group = new THREE.Group();
    group.visible = false;
    group.add(glow, core);
    this.scene.add(group);
    const arc = {
      group, geometry, positions, mats: [glowMat, coreMat], age: 0, life: 0.22,
    };
    this.lightningArcPool.push(arc);
    return arc;
  }

  acquireLightningArc(color) {
    const arc = this.freeLightningArcs.pop() || this.createLightningArc();
    arc.age = 0;
    arc.mats[0].color.setHex(color);
    arc.mats[0].opacity = 0.62;
    arc.mats[1].opacity = 0.96;
    arc.group.visible = true;
    this.lightningArcs.push(arc);
    return arc;
  }

  releaseLightningArc(arc) {
    arc.group.visible = false;
    this.freeLightningArcs.push(arc);
  }

  spawnLightningArc(start, end, color) {
    const arc = this.acquireLightningArc(color);
    const positions = arc.positions.array;
    const jitter = Math.min(0.9, start.distanceTo(end) * 0.055);
    for (let i = 0; i < LIGHTNING_ARC_POINTS; i++) {
      const t = i / (LIGHTNING_ARC_POINTS - 1);
      const offset = i * 3;
      positions[offset] = start.x + (end.x - start.x) * t;
      positions[offset + 1] = start.y + (end.y - start.y) * t;
      positions[offset + 2] = start.z + (end.z - start.z) * t;
      if (i > 0 && i < LIGHTNING_ARC_POINTS - 1) {
        positions[offset] += rand(-jitter, jitter);
        positions[offset + 1] += rand(-jitter * 0.65, jitter * 0.65);
        positions[offset + 2] += rand(-jitter, jitter);
      }
    }
    arc.positions.needsUpdate = true;
  }

  updateLightningArcs(dt) {
    for (let i = this.lightningArcs.length - 1; i >= 0; i--) {
      const arc = this.lightningArcs[i];
      arc.age += dt;
      const fade = Math.max(0, 1 - arc.age / arc.life);
      arc.mats[0].opacity = 0.62 * fade;
      arc.mats[1].opacity = 0.96 * fade;
      if (arc.age >= arc.life) {
        this.lightningArcs.splice(i, 1);
        this.releaseLightningArc(arc);
      }
    }
  }

  placeBeamSegment(seg, start, end) {
    const len = start.distanceTo(end);
    seg.activeStart.copy(start);
    seg.activeEnd.copy(end);
    seg.group.visible = len > 0.05;
    if (!seg.group.visible) return;
    seg.group.position.copy(start).lerp(end, 0.5).multiplyScalar(seg.displayScale || 1);
    this._beamDirection.subVectors(end, start).normalize();
    seg.group.quaternion.setFromUnitVectors(WORLD_UP, this._beamDirection);
    for (const m of seg.group.children) m.scale.y = len * (seg.displayScale || 1);
  }

  traceRecursiveBeam(origin, dir, weapon) {
    const specs = [];
    const velocity = dir.clone().normalize();
    let pos = origin.clone();
    let remaining = weapon.beamRange || 120;
    let displayScale = 1;
    const maxCrossings = weapon.recursionMaxCrossings ?? 5;
    let stage = 0;
    for (let guard = 0; guard < maxCrossings + 2 && remaining > 0.05; guard++) {
      const boundary = this.world.recursiveRayBoundary?.(pos, velocity, remaining);
      const wall = this.rayWorld(pos, velocity, remaining);
      const boundaryDistance = boundary?.distance ?? Infinity;
      const wallDistance = wall?.t ?? Infinity;
      const distance = Math.min(remaining, boundaryDistance, wallDistance);
      if (!Number.isFinite(distance) || distance <= 0.001) break;
      const end = pos.clone().addScaledVector(velocity, distance);
      const widthScale = 1 + stage * (weapon.recursionSizeGain || 0);
      const colors = weapon.recursionColors || [weapon.color];
      specs.push({
        start: pos.clone(),
        end,
        stage,
        displayScale,
        widthScale,
        color: colors[Math.min(stage, colors.length - 1)],
        damage: weapon.dmg + stage * (weapon.recursionDamageGain || 0),
      });
      remaining -= distance;
      if (wallDistance <= boundaryDistance || !boundary || stage >= maxCrossings) break;
      // Step through the boundary before changing charts. Dividing the visual
      // scale by the coordinate transform keeps the two rendered endpoints
      // coincident, while widthScale makes each new local beam unmistakably
      // thicker relative to its arena.
      const seamNudge = Math.min(0.035, remaining);
      pos.copy(end).addScaledVector(velocity, seamNudge).multiplyScalar(boundary.factor);
      displayScale /= boundary.factor;
      remaining -= seamNudge;
      stage++;
    }
    return specs;
  }

  spawnBeam(owner, origin, dir, weapon, shotGroup = this.makeShotGroup(owner, weapon), visualOnly = false) {
    if (weapon.recursiveBeam && this.world.recursiveRayBoundary) {
      const specs = this.traceRecursiveBeam(origin, dir, weapon);
      if (!specs.length) return;
      const segments = specs.map(spec => this.makeBeamSegment(spec.start, spec.end, spec.color, {
        widthScale: spec.widthScale,
        displayScale: spec.displayScale,
        coreRadius: weapon.beamCoreRadius,
        glowRadius: weapon.beamGlowRadius,
        stage: spec.stage,
        damage: spec.damage,
      }));
      const totalLen = segments.reduce((sum, seg) => sum + seg.len, 0);
      this.beams.push({
        id: this.nextBeamId++, owner, weapon, shotGroup, segments, totalLen,
        age: 0, life: weapon.beamLife || 0.85, retract: weapon.beamRetract || 0.36,
        hitCooldowns: new Map(), visualOnly,
      });
      const final = segments[segments.length - 1];
      this.fx.spawnPuff(final.end.clone().multiplyScalar(final.displayScale), final.color, 0.45);
      return;
    }
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
      hitCooldowns: new Map(), visualOnly,
    });
    this.fx.spawnPuff(points[points.length - 1], weapon.color, 0.45);
  }

  spawnVisualBeam(origin, dir, weapon) {
    const owner = { damageMult: 0, team: '__remote_visual__', isPlayer: false };
    this.spawnBeam(owner, origin, dir, weapon, { id: `visual-${this.nextShotId++}`, owner, weaponId: 'beam', kills: 0 }, true);
  }

  spawnProjectile(owner, origin, dir, weapon, opts = {}) {
    const mesh = new THREE.Mesh(this.geoBall, this.matFor(weapon.color, weapon.glowingProjectile));
    if (weapon.glowingProjectile) {
      const aura = new THREE.Mesh(this.geoBall, this.projectileAuraMatFor(weapon.color));
      aura.scale.setScalar(1.5);
      mesh.add(aura);
    }
    if (weapon.disc) mesh.scale.set(weapon.size * 1.5, weapon.size * 0.35, weapon.size * 1.5);
    else if (weapon.lightning) {
      mesh.scale.set(weapon.size * 0.72, weapon.size * 0.72, weapon.size * 4.2);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize());
    }
    else mesh.scale.setScalar(opts.size ?? weapon.size);
    mesh.position.copy(origin);
    this.scene.add(mesh);
    const projectile = {
      mesh, owner, weapon,
      pos: origin.clone(),
      vel: dir.clone().multiplyScalar(opts.speed ?? weapon.speed),
      life: opts.life ?? weapon.projectileLife ?? 4,
      trailT: 0,
      bounced: 0,
      bounceLimit: opts.bounce ?? weapon.bounce,
      pierced: weapon.pierce ? new Set() : null,
      ignore: opts.ignore ? new Set(opts.ignore) : null,
      damage: opts.damage ?? weapon.dmg,
      baseDamage: opts.damage ?? weapon.dmg,
      baseProjectileSize: opts.size ?? weapon.size,
      projectileSize: opts.size ?? weapon.size,
      homingRange: opts.homingRange ?? weapon.homingRange,
      homingTurn: opts.homingTurn ?? weapon.homingTurn,
      homingTurnGain: opts.homingTurnGain ?? weapon.homingTurnGain,
      limitedTarget: opts.limitedTarget || null,
      limitedTargetHits: opts.limitedTargetHits || null,
      limitedTargetHitLimit: opts.limitedTargetHitLimit ?? 0,
      limitedTargetMinBounces: opts.limitedTargetMinBounces ?? 0,
      noSplit: opts.noSplit === true,
      shotGroup: opts.shotGroup || this.makeShotGroup(owner, weapon),
    };
    // A muzzle can extend across a recursive seam even while its owner remains
    // canonical. Give that map a chance to choose the equivalent spawn before
    // the first movement substep, otherwise the projectile can begin stranded
    // in a non-physical visual copy and never cross a boundary.
    if (this.world.prepareProjectile?.(projectile) === false) {
      this.scene.remove(mesh);
      return;
    }
    mesh.position.copy(projectile.pos);
    this.projectiles.push(projectile);
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
    const originalTargetHits = { count: 0 };
    for (let i = 0; i < count; i++) {
      const angle = count === 1 ? 0 : -spread + (spread * 2 * i) / (count - 1);
      const dir = base.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), angle).normalize();
      this.spawnProjectile(p.owner, origin, dir, p.weapon, {
        damage: p.weapon.childDmg ?? p.weapon.dmg,
        speed: p.weapon.childSpeed ?? p.weapon.speed,
        size: p.weapon.size * 0.82,
        life: 2.2,
        bounce: p.weapon.childBounce ?? p.weapon.bounce,
        homingRange: p.weapon.childHomingRange ?? p.weapon.homingRange,
        homingTurn: p.weapon.childHomingTurn ?? p.weapon.homingTurn,
        limitedTarget: ch,
        limitedTargetHits: originalTargetHits,
        limitedTargetHitLimit: 1,
        limitedTargetMinBounces: 1,
        noSplit: true,
        shotGroup: p.shotGroup,
      });
    }
  }

  dischargeThunderbolt(p, primary, characters) {
    if (p.discharged) return;
    p.discharged = true;
    sfx('thunder', p.pos);
    this.fx.spawnPuff(p.pos, p.weapon.color, 2.5);
    let origin = p.pos.clone();
    const struck = new Set(primary ? [primary] : []);
    for (let hop = 0; hop < (p.weapon.chainCount || 0); hop++) {
      let target = null;
      let targetCenter = null;
      let best = (p.weapon.chainRange || 0) ** 2;
      for (const ch of characters) {
        if (!ch.alive || ch === p.owner || ch.team === p.owner.team || struck.has(ch)) continue;
        const visualScale = this.world.characterVisualScale?.(ch) || 1;
        const center = ch.pos.clone().addScaledVector(ch.up || WORLD_UP, ch.height * 0.55 * visualScale);
        const distSq = center.distanceToSquared(origin);
        if (distSq >= best) continue;
        // The indexed quarter-metre sampling retains the former exact ray's
        // thin-cover behavior without scanning and allocating against every
        // collider in Olympus for every possible chain target.
        if (!hasLOS(origin, center, this.world, 0.25)) continue;
        target = ch;
        targetCenter = center;
        best = distSq;
      }
      if (!target) break;
      this.spawnLightningArc(origin, targetCenter, p.weapon.color);
      const damage = (p.weapon.chainDmg || p.weapon.dmg) * Math.pow(0.78, hop);
      this.fx.onDamage(target, damage * p.owner.damageMult, p.owner, { shotGroup: p.shotGroup });
      this.fx.spawnPuff(targetCenter, p.weapon.color, 0.85);
      struck.add(target);
      origin = targetCenter;
    }
  }

  distancePointToSegment(point, a, b) {
    const ab = this._segmentAB.subVectors(b, a);
    const d2 = ab.lengthSq();
    if (d2 < 1e-6) return point.distanceTo(a);
    const t = Math.max(0, Math.min(1,
      this._segmentOffset.subVectors(point, a).dot(ab) / d2));
    return point.distanceTo(this._segmentClosest.copy(a).addScaledVector(ab, t));
  }

  segmentTouchesTarget(target, a, b, pad = 0) {
    if (target.shape !== 'plane') {
      return this.distancePointToSegment(target.pos, a, b) < (target.radius || 1) + pad;
    }
    const startX = a.x - target.pos.x;
    const startY = a.y - target.pos.y;
    const startZ = a.z - target.pos.z;
    const endX = b.x - target.pos.x;
    const endY = b.y - target.pos.y;
    const endZ = b.z - target.pos.z;
    const startDistance = startX * target.normal.x + startY * target.normal.y + startZ * target.normal.z;
    const endDistance = endX * target.normal.x + endY * target.normal.y + endZ * target.normal.z;
    const distanceDelta = startDistance - endDistance;
    let t;
    if (Math.abs(distanceDelta) > 1e-6) {
      t = Math.max(0, Math.min(1, startDistance / distanceDelta));
    } else {
      t = Math.abs(startDistance) <= Math.abs(endDistance) ? 0 : 1;
    }
    const offsetX = startX + (endX - startX) * t;
    const offsetY = startY + (endY - startY) * t;
    const offsetZ = startZ + (endZ - startZ) * t;
    const normalOffset = offsetX * target.normal.x + offsetY * target.normal.y + offsetZ * target.normal.z;
    if (Math.abs(normalOffset) > pad + 0.03) return false;
    const rightOffset = offsetX * target.right.x + offsetY * target.right.y + offsetZ * target.right.z;
    const upOffset = offsetX * target.up.x + offsetY * target.up.y + offsetZ * target.up.z;
    return Math.abs(rightOffset) <= target.halfWidth + pad &&
      Math.abs(upOffset) <= target.halfHeight + pad;
  }

  characterTouchesSegment(ch, a, b, pad = 0.25) {
    const up = ch.up || WORLD_UP;
    const visualScale = this.world.characterVisualScale?.(ch) || 1;
    const r = (ch.radius || 0.45) * visualScale + pad;
    for (const fraction of BEAM_SAMPLE_HEIGHTS) {
      this._segmentPoint.copy(ch.pos)
        .addScaledVector(up, ch.height * fraction * visualScale);
      if (this.distancePointToSegment(this._segmentPoint, a, b) < r) return true;
    }
    if (this.world.mounted) {
      this.mountedHorseHitVolumes(ch, visualScale);
      const horseRadius = 0.58 * visualScale + pad;
      for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
        this._segmentPoint.lerpVectors(this._horseBodyStart, this._horseBodyEnd, fraction);
        if (this.distancePointToSegment(this._segmentPoint, a, b) < horseRadius) return true;
      }
      if (this.distancePointToSegment(this._horseHead, a, b) < 0.48 * visualScale + pad) return true;
    }
    return false;
  }

  mountedHorseHitVolumes(ch, visualScale = 1) {
    const up = ch.up || WORLD_UP;
    const heading = ch.horseHeading ?? ch.yaw ?? 0;
    // Player movement defines forward as -Z at yaw zero; Bot instances define
    // their rendered horse as +Z. Both resolve to the horse's actual world
    // direction here, including host-controlled multiplayer riders.
    if (ch.isPlayer) this._horseForward.set(-Math.sin(heading), 0, -Math.cos(heading));
    else this._horseForward.set(Math.sin(heading), 0, Math.cos(heading));
    this._horseBodyCenter.copy(ch.pos)
      .addScaledVector(up, (0.92 + HORSE_HEIGHT_DELTA) * visualScale);
    this._horseBodyStart.copy(this._horseBodyCenter)
      .addScaledVector(this._horseForward, -0.95 * visualScale);
    this._horseBodyEnd.copy(this._horseBodyCenter)
      .addScaledVector(this._horseForward, 1.25 * visualScale);
    this._horseHead.copy(ch.pos)
      .addScaledVector(up, (1.58 + HORSE_HEIGHT_DELTA) * visualScale)
      .addScaledVector(this._horseForward, 1.42 * visualScale);
  }

  projectileHitCharacter(ch, p) {
    const up = ch.up || WORLD_UP;
    const visualScale = this.world.characterVisualScale?.(ch) || 1;
    const scaledRadius = (ch.radius || 0.45) * visualScale;
    const projectileRadius = (p.projectileSize || p.weapon.size || 0.12) * 0.6;
    const foot = this._bodyFoot.copy(ch.pos).addScaledVector(up, scaledRadius);
    const headHeight = Math.max(
      (ch.height - (ch.radius || 0.45)) * visualScale,
      ch.height * 0.55 * visualScale,
    );
    const head = this._bodyHead.copy(ch.pos).addScaledVector(up, headHeight);
    const riderHit = this.distancePointToSegment(p.pos, foot, head) <
      scaledRadius + projectileRadius + 0.35;
    let horseHit = false;
    if (this.world.mounted) {
      this.mountedHorseHitVolumes(ch, visualScale);
      const bodyHitRadius = 0.58 * visualScale + projectileRadius + 0.28;
      const headHitRadius = 0.48 * visualScale + projectileRadius + 0.22;
      horseHit = this.distancePointToSegment(
        p.pos, this._horseBodyStart, this._horseBodyEnd,
      ) < bodyHitRadius || p.pos.distanceToSquared(this._horseHead) < headHitRadius ** 2;
    }
    if (!riderHit && !horseHit) return null;

    // The generous body capsule reaches in front of the visible head, so a
    // point-only head test would resolve a head-bound dart as a body hit first.
    // Give the actual beige head sphere priority along the dart's travel ray.
    // Its centre and radius mirror buildBotMesh()'s visual head exactly.
    const headCenter = this._headCenter.copy(ch.pos)
      .addScaledVector(up, ch.height * 0.9 * visualScale);
    const headRadius = ch.height * visualScale / 6;
    const hitRadius = headRadius + projectileRadius;
    const travelSq = p.vel.lengthSq();
    const toHead = this._headOffset.copy(headCenter).sub(p.pos);
    const ahead = travelSq > 1e-6 ? toHead.dot(p.vel) / travelSq : 0;
    const closestPoint = this._headClosest.copy(p.pos)
      .addScaledVector(p.vel, Math.max(0, ahead));
    const headshot = riderHit && p.weapon.headshotDmg != null &&
      closestPoint.distanceToSquared(headCenter) < hitRadius ** 2;
    return { headshot };
  }

  shootableTargets() {
    return (this.fx.targets?.() || []).filter(target =>
      target && target.active !== false && target.destroyed !== true && target.pos);
  }

  projectileTouchesTarget(target, p, previous = p.pos) {
    const projectileRadius = (p.projectileSize || p.weapon.size || 0.12) * 0.6;
    return this.segmentTouchesTarget(target, previous, p.pos, projectileRadius);
  }

  hitLimitReached(p, ch) {
    return p.limitedTarget === ch &&
      (p.bounced < p.limitedTargetMinBounces ||
        p.limitedTargetHits?.count >= p.limitedTargetHitLimit);
  }

  steerHomingProjectile(p, characters, dt) {
    if (!p.homingRange || !p.homingTurn) return;

    let target = null;
    let targetScale = 1;
    let closestDistSq = p.homingRange * p.homingRange;
    for (const ch of characters) {
      if (!ch.alive || ch === p.owner || ch.team === p.owner.team ||
          p.pierced?.has(ch) || p.ignore?.has(ch) || this.hitLimitReached(p, ch)) continue;
      const candidateScale = this.world.projectileTargetScale?.(p, ch) || 1;
      const targetUp = ch.up || WORLD_UP;
      const visualScale = this.world.characterVisualScale?.(ch) || 1;
      const centerHeight = ch.height * 0.55 * visualScale;
      const dx = (ch.pos.x + targetUp.x * centerHeight) * candidateScale - p.pos.x;
      const dy = (ch.pos.y + targetUp.y * centerHeight) * candidateScale - p.pos.y;
      const dz = (ch.pos.z + targetUp.z * centerHeight) * candidateScale - p.pos.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq < closestDistSq) {
        closestDistSq = distSq;
        target = ch;
        targetScale = candidateScale;
      }
    }
    if (!target) return;

    const speed = p.vel.length();
    if (speed < 1e-4) return;
    const desired = this._homingDesired.copy(target.pos);
    const targetVisualScale = this.world.characterVisualScale?.(target) || 1;
    desired.addScaledVector(target.up || WORLD_UP, target.height * 0.55 * targetVisualScale);
    desired.multiplyScalar(targetScale);
    desired.sub(p.pos).normalize();
    const current = this._homingCurrent.copy(p.vel).multiplyScalar(1 / speed);
    const angle = current.angleTo(desired);
    if (angle < 1e-4) return;

    // Turn at a capped rate so homing rounds nudge toward their nearest enemy
    // instead of snapping onto targets, even when they start far off-course.
    current.lerp(desired, Math.min(1, (p.homingTurn * dt) / angle)).normalize();
    p.vel.copy(current).multiplyScalar(speed);
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
          const start = this._beamStart.copy(seg.start).lerp(seg.end, segTail / seg.len);
          this.placeBeamSegment(seg, start, seg.end);
        }
        cursor += seg.len;
      }
      for (const [ch, t] of b.hitCooldowns) b.hitCooldowns.set(ch, Math.max(0, t - dt));
      if (!b.visualOnly) {
        for (const ch of characters) {
          if (!ch.alive || ch === b.owner || ch.team === b.owner.team) continue;
          if ((b.hitCooldowns.get(ch) || 0) > 0) continue;
          let hitSegment = null;
          for (const seg of b.segments) {
            if (!seg.group.visible ||
                !this.characterTouchesSegment(ch, seg.activeStart, seg.activeEnd)) continue;
            if (!hitSegment || (seg.damage ?? b.weapon.dmg) > (hitSegment.damage ?? b.weapon.dmg)) {
              hitSegment = seg;
            }
          }
          if (hitSegment) {
            this.fx.onDamage(
              ch,
              (hitSegment.damage ?? b.weapon.dmg) * b.owner.damageMult,
              b.owner,
              { shotGroup: b.shotGroup },
            );
            const hitPos = ch.pos.clone().addScaledVector(ch.up || new THREE.Vector3(0, 1, 0), ch.height * 0.55);
            this.fx.spawnPuff(hitPos, hitSegment.color || b.weapon.color, 0.45);
            b.hitCooldowns.set(ch, b.weapon.beamDamageInterval || 0.4);
          }
        }
        for (const target of this.shootableTargets()) {
          if ((b.hitCooldowns.get(target) || 0) > 0) continue;
          let hitSegment = null;
          for (const seg of b.segments) {
            if (!seg.group.visible ||
                !this.segmentTouchesTarget(target, seg.activeStart, seg.activeEnd, 0.18)) continue;
            if (!hitSegment || (seg.damage ?? b.weapon.dmg) > (hitSegment.damage ?? b.weapon.dmg)) {
              hitSegment = seg;
            }
          }
          if (hitSegment) {
            this.fx.onTargetDamage?.(
              target,
              (hitSegment.damage ?? b.weapon.dmg) * b.owner.damageMult,
              b.owner,
              { shotGroup: b.shotGroup },
            );
            this.fx.spawnPuff(target.pos, hitSegment.color || b.weapon.color, 0.72);
            b.hitCooldowns.set(target, b.weapon.beamDamageInterval || 0.4);
          }
        }
      }
      if (b.age >= b.life) {
        for (const seg of b.segments) {
          this.scene.remove(seg.group);
          for (const child of seg.group.children) child.geometry?.dispose();
        }
        this.beams.splice(bi, 1);
      }
    }
  }

  // Characters: array of {pos, height, radius, alive, team, ...}
  update(dt, characters) {
    this.updateLightningArcs(dt);
    this.updateBeams(dt, characters);
    const step = this._step;
    const prev = this._previous;
    const probe = this._probe;
    const shootableTargets = this.projectiles.length ? this.shootableTargets() : null;
    for (let pi = this.projectiles.length - 1; pi >= 0; pi--) {
      const p = this.projectiles[pi];
      p.life -= dt;
      if (p.weapon.gravity) p.vel.y -= this.world.gravity * 0.9 * dt;
      this.steerHomingProjectile(p, characters, dt);
      if (p.weapon.trail) {
        p.trailT += dt;
        if (p.trailT > 0.05) {
          p.trailT = 0;
          this.fx.spawnPuff(p.pos, p.currentColor || p.weapon.color, 0.25 * Math.sqrt(p.recursionScale || 1));
        }
      }

      // The spatial broad phase keeps these checks cheap enough to sample at
      // half-metre intervals, preventing small rounds from skipping most thin
      // railings and deck lips. Recomputing the time slice after each movement
      // is important in recursive space: only the substep that crosses a seam
      // is rescaled into the new chart, while future motion keeps the weapon's
      // authored speed just like character movement does.
      let remainingDt = dt;
      let substepGuard = 0;
      let dead = p.life <= 0;
      while (remainingDt > 1e-6 && !dead) {
        if (++substepGuard > 512) {
          // A malformed recursive traversal is expendable after this bounded
          // guard; never trade a frame hitch for another copy.
          p.life = 0;
          dead = true;
          break;
        }
        const speed = p.vel.length();
        const requestedStepDistance = this.world.projectileStepDistance?.(p);
        const maxStepDistance = Number.isFinite(requestedStepDistance) && requestedStepDistance > 0
          ? Math.min(0.5, requestedStepDistance)
          : 0.5;
        const stepDt = speed > 1e-6 ? Math.min(remainingDt, maxStepDistance / speed) : remainingDt;
        remainingDt -= stepDt;
        step.copy(p.vel).multiplyScalar(stepDt);
        prev.copy(p.pos);
        p.pos.add(step);
        const traversalResult = this.world.postProjectileMove?.(p, prev);
        if (traversalResult === false || p.life <= 0) {
          dead = true;
          break;
        }
        if (Number.isFinite(traversalResult) && traversalResult !== 1) {
          // Bounce rollback/probes below must operate in the same recursive
          // chart as the transformed projectile position.
          prev.multiplyScalar(traversalResult);
          step.multiplyScalar(traversalResult);
        }

        // hit a character?
        for (const ch of characters) {
          if (!ch.alive || ch === p.owner || ch.team === p.owner.team ||
              p.pierced?.has(ch) || p.ignore?.has(ch) || this.hitLimitReached(p, ch)) continue;
          const hit = this.projectileHitCharacter(ch, p);
          if (hit) {
            if (p.limitedTarget === ch) p.limitedTargetHits.count++;
            p.directTarget = ch;
            const baseDamage = hit.headshot ? p.weapon.headshotDmg : p.damage;
            this.fx.onDamage(ch, baseDamage * p.owner.damageMult, p.owner, {
              shotGroup: p.shotGroup,
              headshot: hit.headshot,
            });
            if (p.weapon.lightning) p.chainPrimary = ch;
            this.fx.spawnPuff(p.pos, p.currentColor || p.weapon.color, 0.6 * Math.sqrt(p.recursionScale || 1));
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
        // Map-specific shootables (comets and score posters) use the same
        // sub-stepped collision path as characters, so Hyperstrike and other
        // fast rounds cannot tunnel through them between frames.
        if (!dead) {
          for (const target of shootableTargets) {
            if (!target || target.active === false || target.destroyed === true) continue;
            if (p.pierced?.has(target) || p.ignore?.has(target)) continue;
            if (!this.projectileTouchesTarget(target, p, prev)) continue;
            this.fx.onTargetDamage?.(
              target, p.damage * p.owner.damageMult, p.owner, { shotGroup: p.shotGroup });
            this.fx.spawnPuff(p.pos, p.currentColor || p.weapon.color, 0.72 * Math.sqrt(p.recursionScale || 1));
            if (p.weapon.pierce && p.pierced.size < p.weapon.pierce) p.pierced.add(target);
            else dead = true;
            break;
          }
        }
        if (!dead && pointHitsWorld(p.pos, (p.projectileSize || p.weapon.size) * 0.6, this.world)) {
          if (p.bounceLimit && p.bounced < p.bounceLimit) {
            // Reflect off whichever axis is blocked. Sidewinder keeps its
            // near-elastic ricochet; Loophole uses a lower vertical response
            // and preserves planar speed so its orb skips along the ground.
            applyProjectileBounce(p, prev, step, probe, this.world);
            this.fx.spawnPuff(p.pos, p.currentColor || p.weapon.color, 0.3);
          } else {
            dead = true;
          }
        }
        if (!dead && p.pos.y < this.world.killY) dead = true;
      }

      if (dead) {
        if (p.weapon.lightning && p.life > 0) this.dischargeThunderbolt(p, p.chainPrimary, characters);
        if (p.weapon.splash && (p.life > 0 || p.weapon.explodeOnExpiry)) this.explode(p);
        else if (p.life > 0) this.fx.spawnPuff(p.pos, p.currentColor || p.weapon.color, 0.5);
        this.scene.remove(p.mesh);
        this.projectiles.splice(pi, 1);
        continue;
      }
      p.mesh.position.copy(p.pos);
    }
  }

  explode(p) {
    sfx('explode', p.pos);
    this.fx.spawnPuff(
      p.pos,
      p.weapon.explosionColor ?? 0xffa030,
      Math.max(3.2, p.weapon.splash * 0.75),
    );
    for (const ch of this.fx.characters()) {
      if (!ch.alive || ch.team === p.owner.team && ch !== p.owner) continue;
      if (ch === p.owner) continue; // no self-splash damage (keeps zooka fun)
      if (p.weapon.splashExcludesDirect && ch === p.directTarget) continue;
      const center = ch.pos.clone(); center.y += ch.height * 0.5;
      let d = center.distanceTo(p.pos);
      if (this.world.mounted) {
        const visualScale = this.world.characterVisualScale?.(ch) || 1;
        this.mountedHorseHitVolumes(ch, visualScale);
        const bodyDistance = Math.max(0,
          this.distancePointToSegment(p.pos, this._horseBodyStart, this._horseBodyEnd) - 0.58 * visualScale);
        const headDistance = Math.max(0, p.pos.distanceTo(this._horseHead) - 0.48 * visualScale);
        d = Math.min(d, bodyDistance, headDistance);
      }
      if (d < p.weapon.splash) {
        const dmg = p.weapon.flatSplash
          ? p.weapon.splashDmg
          : p.weapon.splashDmg * (1 - d / p.weapon.splash);
        this.fx.onDamage(ch, dmg * p.owner.damageMult, p.owner, { shotGroup: p.shotGroup });
      }
    }
    for (const target of this.shootableTargets()) {
      if (target.receivesSplash === false) continue;
      const d = target.pos.distanceTo(p.pos);
      if (d >= p.weapon.splash + (target.radius || 1)) continue;
      const dmg = p.weapon.flatSplash
        ? p.weapon.splashDmg
        : p.weapon.splashDmg * (1 - Math.min(1, d / p.weapon.splash));
      if (dmg > 0) this.fx.onTargetDamage?.(
        target, dmg * p.owner.damageMult, p.owner, { shotGroup: p.shotGroup });
    }
  }

  clear() {
    for (const p of this.projectiles) this.scene.remove(p.mesh);
    this.projectiles.length = 0;
    for (const b of this.beams) {
      for (const seg of b.segments) {
        this.scene.remove(seg.group);
        for (const child of seg.group.children) child.geometry?.dispose();
      }
    }
    this.beams.length = 0;
    for (const arc of this.lightningArcPool) {
      this.scene.remove(arc.group);
      arc.geometry.dispose();
      for (const material of arc.mats) material.dispose();
    }
    this.lightningArcs.length = 0;
    this.freeLightningArcs.length = 0;
    this.lightningArcPool.length = 0;
  }
}

// Simple expanding-fading puff effects. These happen on almost every shot,
// impact, trail tick, and damage event, so keep a bounded set of meshes and
// materials alive instead of allocating and collecting them during a fight.
export class FXPool {
  constructor(scene, capacity = 72) {
    this.scene = scene;
    this.puffs = [];
    this.free = [];
    this.geo = new THREE.SphereGeometry(1, 8, 6);
    this.ringGeo = new THREE.TorusGeometry(1, 0.09, 5, 18);
    for (let i = 0; i < capacity; i++) this.free.push(this.createPuff());
  }
  setScene(scene) {
    if (!scene || scene === this.scene) return;
    // Release active effects from the previous world before rebinding. The
    // geometry and materials stay warm and are reused by the next arena.
    this.clear();
    this.scene = scene;
  }
  createPuff() {
    const coreMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.72, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const group = new THREE.Group();
    group.visible = false;
    const core = new THREE.Mesh(this.geo, coreMat);
    const ring = new THREE.Mesh(this.ringGeo, ringMat);
    group.add(core, ring);
    return { m: group, core, ring, coreMat, ringMat, t: 0, scale: 1 };
  }
  acquirePuff() {
    if (this.free.length) return this.free.pop();
    // Preserve a stable ceiling even when several rapid-fire effects overlap.
    // Recycling the oldest puff is visually preferable to a GC spike.
    const oldest = this.puffs.shift();
    this.scene.remove(oldest.m);
    return oldest;
  }
  releasePuff(p) {
    this.scene.remove(p.m);
    p.m.visible = false;
    this.free.push(p);
  }
  spawnPuff(pos, color, scale = 1) {
    const p = this.acquirePuff();
    p.t = 0;
    p.scale = scale;
    p.coreMat.color.setHex(color);
    p.ringMat.color.setHex(color);
    p.coreMat.opacity = 0.72;
    p.ringMat.opacity = 0.9;
    p.ring.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
    p.m.position.copy(pos);
    p.m.scale.setScalar(scale * 0.22);
    p.m.visible = true;
    this.scene.add(p.m);
    this.puffs.push(p);
  }
  update(dt) {
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      p.t += dt * 3.5;
      const ease = 1 - (1 - Math.min(1, p.t)) ** 3;
      p.m.scale.setScalar(p.scale * (0.22 + ease * 0.9));
      p.core.scale.setScalar(1 + ease * 0.35);
      p.ring.scale.setScalar(0.7 + ease * 1.7);
      p.coreMat.opacity = Math.max(0, 0.72 * (1 - p.t));
      p.ringMat.opacity = Math.max(0, 0.9 * (1 - p.t) ** 1.5);
      if (p.t >= 1) {
        this.puffs.splice(i, 1);
        this.releasePuff(p);
      }
    }
  }
  clear() {
    while (this.puffs.length) this.releasePuff(this.puffs.pop());
  }
  dispose() {
    this.clear();
    for (const p of this.free) {
      this.scene.remove(p.m);
      p.coreMat.dispose();
      p.ringMat.dispose();
    }
    this.free.length = 0;
    this.geo.dispose();
    this.ringGeo.dispose();
  }
}
