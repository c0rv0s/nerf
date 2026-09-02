// Map construction. Each map returns a `world` object:
// { colliders, ramps, waypoints, spawns:{blue,red,ffa}, spawnsAll, pickups,
//   jumpPads, manualLinks, gravity, jumpVel, killY, playerSpeed,
//   waypointLinkDist, waypointLinkDy, update(dt) }
//
// Raised-route seam invariant: walkable slabs at the same elevation may share
// a boundary, but their top faces must never overlap. Use a dedicated corner
// slab for turns, make straight runs butt against it exactly, and terminate
// rail runs at corner posts rather than crossing them. Ramps may meet a deck
// at its edge or sit at a deliberately different elevation, never coplanar.
// Decorative layers follow the same rule: never build a thin box whose outer
// face exactly matches the face beneath it. Use addSurfacePanel(), which adds a
// small world-space separation and a depth bias, and keep the build-time
// coplanar audit clean. This is a map-wide invariant, not a per-map workaround.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rand, pointInZoneXZ, pointHitsWorld, triangleMeshSurfaceY } from './engine.js';
import { advanceNetworkClock } from './network-sync.js';
import { shuffledToadPersonalities } from './toad-effects.js';
import { buildBlueWhale } from './blue-whale.js';
import { buildTidebreakerShark } from './tidebreaker-shark.js';
import { addTidebreakerWhaleBehavior } from './tidebreaker-whale-behavior.js';
import { RED_ROCK_RANGE_BOUNDS } from './map-rules.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const SURFACE_LAYER_EPS = 0.04;
// Portal faces live inside deep gate frames, so they can sit farther forward
// than ordinary wall trim. Keep this large enough to survive the atrium's
// shallow viewing angles and 900-unit camera depth range without intersecting
// the frame or changing the gate trigger/collision volume.
const PORTAL_SURFACE_EPS = 0.18;
// Portal faces continue just 1 cm behind the surrounding frame at the sides and
// top. Keep the bottom flush with the authored opening so the effect cannot
// spill below the gate; this changes only the rendered face, never the portal
// trigger or collision geometry.
const PORTAL_FRAME_OVERLAP = 0.01;
const DECOR_DEPTH_BIAS = Object.freeze({
  polygonOffset: true,
  polygonOffsetFactor: -2,
  polygonOffsetUnits: -8,
});
const depthBiasFor = (collide, lane) => {
  if (!collide) return { ...DECOR_DEPTH_BIAS, polygonOffsetUnits: -8 - lane * 4 };
  if (lane > 0) return { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -lane * 2 };
  return {};
};

function newWorld(opts) {
  return Object.assign({
    colliders: [], ramps: [], waypoints: [], pickups: [], jumpPads: [],
    scoreTargets: [],
    manualLinks: [], anim: [], _geoGroups: {}, _surfaceGeometries: [], _visualBoxes: [],
    _wallFeatures: [], visualSurfaceConflicts: [], visualSurfaceIssues: [], wallFeatureIssues: [],
    spawns: { blue: [], red: [], ffa: [] },
    gravity: 25, jumpVel: 9.2, killY: -40, playerSpeed: 10,
    waypointLinkDist: 16, waypointLinkDy: 3.5,
    update(dt, characters = []) {
      const clock = advanceNetworkClock(this._t, this.networkTimeTarget, dt);
      this._t = clock.time;
      if (clock.target != null) this.networkTimeTarget = clock.target;
      for (const a of this.anim) a(dt, this._t, characters);
    },
  }, opts);
}

/* ---------------- procedural textures ---------------- */
const texCache = {};
function canvasTex(key, draw) {
  if (texCache[key]) return texCache[key];
  const c = document.createElement('canvas');
  // These textures are projected across the large floors, ramps, and walls in
  // Blast Complex and Fortress Falls. At the old 128px resolution they became
  // visibly soft up close, and without anisotropic filtering they blurred even
  // more aggressively at the shallow viewing angles used for walkable ground.
  // Keep the procedural artwork's 128-unit coordinate system while rasterizing
  // it at 4x resolution so every existing drawing remains visually identical.
  const scale = 4;
  c.width = c.height = 128 * scale;
  const g = c.getContext('2d');
  g.scale(scale, scale);
  draw(g);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 16;
  texCache[key] = t;
  return t;
}
function texChecker() {
  return canvasTex('checker', (g) => {
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      g.fillStyle = (x + y) % 2 ? '#e8e8e8' : '#ffffff';
      g.fillRect(x * 32, y * 32, 32, 32);
    }
    g.strokeStyle = 'rgba(0,0,0,.18)'; g.lineWidth = 2;
    for (let i = 0; i <= 4; i++) {
      g.beginPath(); g.moveTo(i * 32, 0); g.lineTo(i * 32, 128); g.stroke();
      g.beginPath(); g.moveTo(0, i * 32); g.lineTo(128, i * 32); g.stroke();
    }
  });
}
function texPanel() {
  return canvasTex('panel', (g) => {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 128, 128);
    g.strokeStyle = 'rgba(0,0,0,.25)'; g.lineWidth = 3;
    g.strokeRect(4, 4, 120, 120);
    g.fillStyle = 'rgba(0,0,0,.14)';
    g.fillRect(10, 10, 108, 8);
    for (const [x, y] of [[14, 110], [106, 110], [14, 26], [106, 26]]) {
      g.beginPath(); g.arc(x, y, 4, 0, 7); g.fill();
    }
  });
}
function texCrate() {
  return canvasTex('crate', (g) => {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 128, 128);
    g.strokeStyle = 'rgba(60,30,0,.4)'; g.lineWidth = 6;
    g.strokeRect(6, 6, 116, 116);
    g.beginPath(); g.moveTo(6, 6); g.lineTo(122, 122); g.stroke();
    g.beginPath(); g.moveTo(122, 6); g.lineTo(6, 122); g.stroke();
    for (let i = 0; i < 40; i++) {
      g.fillStyle = `rgba(80,40,0,${Math.random() * 0.12})`;
      g.fillRect(Math.random() * 120, Math.random() * 120, 8, 3);
    }
  });
}
function texRock() {
  return canvasTex('rock', (g) => {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 260; i++) {
      const v = 0.75 + Math.random() * 0.25;
      g.fillStyle = `rgba(${v * 255},${v * 250},${v * 245},.5)`;
      const s = 2 + Math.random() * 9;
      g.fillRect(Math.random() * 128, Math.random() * 128, s, s);
    }
  });
}

function texTurtleShell() {
  return canvasTex('turtle-shell', (g) => {
    // Broad, high-contrast scutes stay readable on the small low-poly turtle
    // at combat distance. The stepped greens nod to block-built sea turtles
    // while the irregular shield shapes keep this shell its own design.
    g.fillStyle = '#24552f';
    g.fillRect(0, 0, 128, 128);
    const scute = (x, y, w, h, outer, inner) => {
      g.fillStyle = outer;
      g.strokeStyle = '#143c25';
      g.lineWidth = 5;
      g.beginPath();
      g.moveTo(x + w * 0.22, y);
      g.lineTo(x + w * 0.78, y);
      g.lineTo(x + w, y + h * 0.28);
      g.lineTo(x + w * 0.88, y + h * 0.82);
      g.lineTo(x + w * 0.62, y + h);
      g.lineTo(x + w * 0.26, y + h * 0.94);
      g.lineTo(x, y + h * 0.56);
      g.closePath();
      g.fill();
      g.stroke();
      g.fillStyle = inner;
      g.beginPath();
      g.moveTo(x + w * 0.3, y + h * 0.22);
      g.lineTo(x + w * 0.7, y + h * 0.18);
      g.lineTo(x + w * 0.79, y + h * 0.48);
      g.lineTo(x + w * 0.65, y + h * 0.75);
      g.lineTo(x + w * 0.34, y + h * 0.72);
      g.lineTo(x + w * 0.2, y + h * 0.45);
      g.closePath();
      g.fill();
    };
    for (const [x, y, w, h, outer, inner] of [
      [-8, -7, 45, 42, '#34763c', '#4c984a'],
      [34, -5, 58, 45, '#3b8343', '#56a652'],
      [89, -7, 47, 42, '#2f7139', '#438e45'],
      [-14, 34, 52, 54, '#2f6f38', '#499348'],
      [34, 37, 60, 55, '#438b45', '#67ac54'],
      [91, 34, 51, 54, '#32763b', '#4a9849'],
      [-9, 84, 46, 49, '#2d6b36', '#448b43'],
      [34, 88, 58, 47, '#397d3f', '#58a04d'],
      [89, 84, 47, 49, '#2e7038', '#469246'],
    ]) scute(x, y, w, h, outer, inner);
    // Small mottled pixels stop the broad panels reading as painted plastic.
    g.fillStyle = 'rgba(205,239,120,.24)';
    for (const [x, y, s] of [[18,18,5],[73,21,6],[108,54,4],[18,69,5],
      [62,66,4],[84,106,6],[111,111,4],[22,109,5]]) g.fillRect(x, y, s, s);
  });
}

function texArenaFloor() {
  return canvasTex('arena-floor', (g) => {
    g.fillStyle = '#d9e1e6'; g.fillRect(0, 0, 128, 128);
    g.fillStyle = 'rgba(30,52,66,.11)';
    for (let y = 0; y < 128; y += 32) g.fillRect(0, y, 128, 2);
    for (let x = 0; x < 128; x += 32) g.fillRect(x, 0, 2, 128);
    g.strokeStyle = 'rgba(255,255,255,.34)'; g.lineWidth = 1;
    for (let i = 8; i < 128; i += 32) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 128); g.stroke();
      g.beginPath(); g.moveTo(0, i); g.lineTo(128, i); g.stroke();
    }
    for (let y = 10; y < 128; y += 32) for (let x = 10; x < 128; x += 32) {
      g.fillStyle = 'rgba(24,36,44,.28)';
      g.beginPath(); g.arc(x, y, 1.6, 0, Math.PI * 2); g.fill();
    }
  });
}

function texArenaWall() {
  return canvasTex('arena-wall', (g) => {
    const grd = g.createLinearGradient(0, 0, 128, 128);
    grd.addColorStop(0, '#f1f3f2'); grd.addColorStop(1, '#b9c5c9');
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
    g.strokeStyle = 'rgba(31,47,58,.24)'; g.lineWidth = 3;
    g.strokeRect(5, 5, 118, 118);
    g.fillStyle = 'rgba(18,36,48,.10)';
    g.fillRect(8, 16, 112, 7); g.fillRect(8, 104, 112, 7);
    g.strokeStyle = 'rgba(255,255,255,.42)'; g.lineWidth = 1;
    g.strokeRect(9, 28, 110, 70);
    for (const [x, y] of [[13, 13], [115, 13], [13, 115], [115, 115]]) {
      g.fillStyle = 'rgba(20,34,42,.34)';
      g.beginPath(); g.arc(x, y, 2.2, 0, Math.PI * 2); g.fill();
    }
  });
}

function texArenaFoam() {
  return canvasTex('arena-foam', (g) => {
    g.fillStyle = '#ece8df'; g.fillRect(0, 0, 128, 128);
    g.strokeStyle = 'rgba(58,66,70,.13)'; g.lineWidth = 2;
    for (let x = -128; x < 256; x += 18) {
      g.beginPath(); g.moveTo(x, 128); g.lineTo(x + 128, 0); g.stroke();
    }
    g.strokeStyle = 'rgba(255,255,255,.42)'; g.lineWidth = 1;
    for (let x = -128; x < 256; x += 18) {
      g.beginPath(); g.moveTo(x + 3, 128); g.lineTo(x + 131, 0); g.stroke();
    }
  });
}

function texFortressStone() {
  return canvasTex('fortress-stone', (g) => {
    g.fillStyle = '#d8d2c8'; g.fillRect(0, 0, 128, 128);
    for (let row = 0; row < 5; row++) {
      const y = row * 26;
      const offset = row % 2 ? -18 : 0;
      g.strokeStyle = 'rgba(42,34,55,.38)'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(0, y); g.lineTo(128, y); g.stroke();
      for (let x = offset; x < 146; x += 36) {
        g.beginPath(); g.moveTo(x, y); g.lineTo(x, Math.min(128, y + 26)); g.stroke();
        g.strokeStyle = 'rgba(255,255,255,.34)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(x + 3, y + 3); g.lineTo(x + 33, y + 3); g.stroke();
        g.strokeStyle = 'rgba(42,34,55,.38)'; g.lineWidth = 3;
      }
    }
    g.fillStyle = 'rgba(58,45,72,.09)';
    for (const [x, y, w] of [[8, 8, 22], [70, 34, 31], [28, 61, 26], [91, 87, 24], [10, 112, 30]]) {
      g.fillRect(x, y, w, 5);
    }
  });
}

function texFortressFloor() {
  return canvasTex('fortress-floor', (g) => {
    g.fillStyle = '#e4ddd0'; g.fillRect(0, 0, 128, 128);
    g.strokeStyle = 'rgba(52,43,62,.24)'; g.lineWidth = 2;
    for (let y = 0; y <= 128; y += 32) {
      g.beginPath(); g.moveTo(0, y); g.lineTo(128, y); g.stroke();
    }
    for (let row = 0; row < 4; row++) {
      const offset = row % 2 ? 20 : 0;
      for (let x = offset; x < 128; x += 40) {
        g.beginPath(); g.moveTo(x, row * 32); g.lineTo(x, row * 32 + 32); g.stroke();
      }
    }
    g.strokeStyle = 'rgba(255,255,255,.42)'; g.lineWidth = 1;
    for (let y = 4; y < 128; y += 32) {
      g.beginPath(); g.moveTo(4, y); g.lineTo(124, y); g.stroke();
    }
  });
}

function texFortressDeck() {
  return canvasTex('fortress-deck', (g) => {
    g.fillStyle = '#a9a4ae'; g.fillRect(0, 0, 128, 128);
    for (let x = 0; x < 128; x += 16) {
      g.fillStyle = x % 32 ? 'rgba(255,255,255,.10)' : 'rgba(24,20,37,.10)';
      g.fillRect(x, 0, 15, 128);
      g.strokeStyle = 'rgba(31,24,44,.32)'; g.lineWidth = 2;
      g.strokeRect(x + 1, 2, 14, 124);
      g.fillStyle = 'rgba(30,24,40,.45)';
      for (const y of [10, 118]) { g.beginPath(); g.arc(x + 8, y, 1.6, 0, 7); g.fill(); }
    }
    g.fillStyle = 'rgba(255,255,255,.28)'; g.fillRect(0, 62, 128, 3);
  });
}

function texSolarHull() {
  return canvasTex('solar-hull', (g) => {
    g.fillStyle = '#d8d6ca'; g.fillRect(0, 0, 128, 128);
    g.strokeStyle = 'rgba(31,45,62,.42)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, 34); g.lineTo(128, 34); g.stroke();
    g.beginPath(); g.moveTo(0, 96); g.lineTo(128, 96); g.stroke();
    g.beginPath(); g.moveTo(31, 0); g.lineTo(31, 34); g.stroke();
    g.beginPath(); g.moveTo(87, 34); g.lineTo(87, 96); g.stroke();
    g.beginPath(); g.moveTo(54, 96); g.lineTo(54, 128); g.stroke();
    g.fillStyle = '#26394d'; g.fillRect(6, 7, 54, 7);
    g.fillStyle = '#38cde7'; g.fillRect(9, 9, 31, 3);
    g.fillStyle = '#9e402a'; g.fillRect(67, 108, 45, 5);
    g.fillStyle = 'rgba(255,255,255,.35)'; g.fillRect(0, 36, 128, 3);
    for (const [x, y] of [[8, 26], [119, 26], [8, 88], [119, 88], [47, 119]]) {
      g.fillStyle = '#65717c'; g.beginPath(); g.arc(x, y, 1.7, 0, Math.PI * 2); g.fill();
    }
  });
}

const TEXES = {
  checker: texChecker,
  panel: texPanel,
  crate: texCrate,
  rock: texRock,
  'arena-floor': texArenaFloor,
  'arena-wall': texArenaWall,
  'arena-foam': texArenaFoam,
  'fortress-stone': texFortressStone,
  'fortress-floor': texFortressFloor,
  'fortress-deck': texFortressDeck,
  'solar-hull': texSolarHull,
  'turtle-shell': texTurtleShell,
};

// ---- Web-optimized AI texture set (textures/*.webp) — canvas fallback if absent ----
// A normal map is derived from each image's luminance so surfaces catch light.
const AI_TEX = {};
const AI_TEX_SOURCES = {
  'fortress-royal': './textures/fortress-royal.webp',
  'crocodile-scales': './textures/crocodile-scales.webp',
  'canopy-bark': './textures/canopy-bark.webp',
  'canopy-wall': './textures/canopy-wall.webp',
  'canopy-grapple': './textures/canopy-grapple.webp',
  'infinite-bloom-sky-eyeless': './textures/infinite-bloom-sky-eyeless.webp',
  'infinite-bloom-eye-atlas': './textures/infinite-bloom-eye-atlas.webp',
  parasite: './textures/parasite.webp',
  refractor: './textures/refractor.webp',
  'power-gold': './textures/power-gold.webp',
  'power-silver': './textures/power-silver.webp',
  'atrium-gate-frame-atlas': './textures/atrium-gate-frame-atlas.webp',
  'coral-brain-red': './textures/coral-brain-red.webp',
  'coral-cup-blue': './textures/coral-cup-blue.webp',
  'coral-plate-pink': './textures/coral-plate-pink.webp',
};
function makeNormalMap(img) {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, size, size);
  const src = g.getImageData(0, 0, size, size).data;
  const out = g.createImageData(size, size);
  const lum = (x, y) => {
    const i = (((y + size) % size) * size + ((x + size) % size)) * 4;
    return (src[i] + src[i + 1] + src[i + 2]) / 765;
  };
  const strength = 1.6;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (lum(x - 1, y) - lum(x + 1, y)) * strength;
      const dy = (lum(x, y - 1) - lum(x, y + 1)) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = (y * size + x) * 4;
      out.data[i] = (dx * inv * 0.5 + 0.5) * 255;
      out.data[i + 1] = (dy * inv * 0.5 + 0.5) * 255;
      out.data[i + 2] = inv * 255;
      out.data[i + 3] = 255;
    }
  }
  g.putImageData(out, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
// Textures usable by other modules (character suits, weapon plastic, …)
export function aiTex(name, rx = 1, ry = 1) {
  const ai = AI_TEX[name];
  if (!ai) return {};
  const map = ai.map.clone(); map.needsUpdate = true; map.repeat.set(rx, ry);
  if (!ai.normal) return { map };
  const normalMap = ai.normal.clone(); normalMap.needsUpdate = true; normalMap.repeat.set(rx, ry);
  return { map, normalMap, normalScale: new THREE.Vector2(0.7, 0.7) };
}

// Load shared/Atrium assets first, then keep filling the cache while the player
// explores the lobby. A small worker pool avoids a cold launch decoding fifty
// images at once, and normal maps are finalized one idle slice at a time.
const TEXTURE_NAMES = Object.freeze([
  'panel', 'plastic', 'suit', 'blaster', 'scatter', 'pulsar', 'sidewinder', 'zooka',
  'whomper', 'hyper', 'parasite', 'refractor', 'power-gold', 'power-silver',
  'infinite-bloom-surface', 'neonwall', 'neonfloor', 'atrium-grass', 'flowers', 'poster1', 'target',
  'canopy-bark', 'tidebreaker-deck', 'atrium-gate-frame-atlas',
  'canopy-grapple',
  'checker', 'crate', 'rock', 'arcade', 'fortress-royal', 'crocodile-scales',
  'canopy-wall', 'grass', 'dirt', 'door', 'lava', 'poster2', 'poster3', 'poster4',
  'poster5', 'poster6', 'poster7',
  'poster-oldwest', 'poster-bloom', 'poster-tidebreaker', 'poster-solar',
  'poster-mycelium', 'poster-reef',
  'hazard', 'tidebreaker-orange-steel',
  'mycelium-mossy-slab', 'mycelium-mossy-rock',
  'olympus-rock', 'olympus-palace', 'olympus-relief', 'olympus-aether',
  'infinite-bloom-faces', 'infinite-bloom-sky-eyeless',
  'infinite-bloom-eye-atlas',
  'horse-coat', 'cactus-skin',
  // Reef species textures must be in the actual load queue as well as the URL
  // registry below. Without these entries mat() cannot find AI_TEX and falls
  // back to texPanel, which is the white riveted material seen in screenshots.
  'coral-brain-red', 'coral-cup-blue', 'coral-plate-pink',
]);
const SHARED_TEXTURE_NAMES = new Set(TEXTURE_NAMES.slice(0, 24));
const textureSettledResolvers = new Map();
const textureSettledPromises = new Map(TEXTURE_NAMES.map((name) => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  textureSettledResolvers.set(name, resolve);
  return [name, promise];
}));
const COLOR_ONLY_TEXTURES = new Set([
  'poster1', 'poster2', 'poster3', 'poster4', 'poster5', 'poster6', 'poster7',
  'poster-oldwest', 'poster-bloom', 'poster-tidebreaker', 'poster-solar',
  'poster-mycelium', 'poster-reef',
  'target', 'hazard', 'atrium-gate-frame-atlas',
  'infinite-bloom-sky-eyeless', 'infinite-bloom-eye-atlas',
]);
// These sources are authored to tile directly. Mirroring them would reflect
// recognizable rock landmarks into the symmetrical face-like patterns that
// direct repeat is meant to avoid.
const DIRECT_REPEAT_TEXTURES = new Set(['mycelium-mossy-slab', 'mycelium-mossy-rock']);
const textureLoader = new THREE.TextureLoader();
const textureProgressListeners = new Set();
const textureFinalizeQueue = [];
let textureFinalizeScheduled = false;
let textureFinalizeScheduleVersion = 0;
let textureLoadingUrgent = true;
let textureReadyCount = 0;
let sharedTextureReadyCount = 0;

export function getTextureLoadProgress() {
  return { ready: textureReadyCount, total: TEXTURE_NAMES.length };
}

export function getSharedTextureLoadProgress() {
  return { ready: sharedTextureReadyCount, total: SHARED_TEXTURE_NAMES.size };
}

export const sharedTexturesReady = Promise.all(
  [...SHARED_TEXTURE_NAMES].map(name => textureSettledPromises.get(name)),
).then(() => undefined);

export function onTextureLoadProgress(listener) {
  if (typeof listener !== 'function') return () => {};
  textureProgressListeners.add(listener);
  listener(getTextureLoadProgress());
  return () => textureProgressListeners.delete(listener);
}

function markTextureSettled(name) {
  const settle = textureSettledResolvers.get(name);
  if (!settle) return;
  textureReadyCount++;
  settle();
  textureSettledResolvers.delete(name);
  if (SHARED_TEXTURE_NAMES.has(name)) {
    sharedTextureReadyCount++;
    if (sharedTextureReadyCount >= SHARED_TEXTURE_NAMES.size) textureLoadingUrgent = false;
  }
  const progress = getTextureLoadProgress();
  for (const listener of textureProgressListeners) listener(progress);
}

function scheduleTextureFinalize() {
  if (textureFinalizeScheduled || !textureFinalizeQueue.length) return;
  textureFinalizeScheduled = true;
  const version = ++textureFinalizeScheduleVersion;
  const run = (deadline = null) => {
    if (version !== textureFinalizeScheduleVersion) return;
    textureFinalizeScheduled = false;
    if (!textureLoadingUrgent && deadline && deadline.timeRemaining() < 6) {
      scheduleTextureFinalize();
      return;
    }
    textureFinalizeQueue.shift()?.();
    scheduleTextureFinalize();
  };
  if (textureLoadingUrgent) setTimeout(run, 0);
  else if (typeof requestIdleCallback === 'function') requestIdleCallback(run);
  else setTimeout(run, 120);
}

export function prioritizeTextureLoading() {
  textureLoadingUrgent = true;
  if (textureFinalizeScheduled) {
    textureFinalizeScheduled = false;
    textureFinalizeScheduleVersion++;
  }
  scheduleTextureFinalize();
}

function enqueueTextureFinalize(finalize) {
  textureFinalizeQueue.push(finalize);
  scheduleTextureFinalize();
}

function loadTexture(name) {
  return new Promise((done) => {
    const url = AI_TEX_SOURCES[name] || `./textures/${name}.webp`;
    textureLoader.load(url, (t) => {
      const finalize = () => {
        try {
          // Mirrored repeat hides seams in not-quite-tileable source images;
          // deliberately seamless materials retain their asymmetric layout.
          const wrapping = DIRECT_REPEAT_TEXTURES.has(name)
            ? THREE.RepeatWrapping
            : THREE.MirroredRepeatWrapping;
          t.wrapS = t.wrapT = wrapping;
          t.colorSpace = THREE.SRGBColorSpace;
          t.anisotropy = 16;
          let normal = null;
          // Decals, atlases, and sky art are never lit as repeating surfaces;
          // deriving a normal map for them was pure cold-start CPU work.
          if (!COLOR_ONLY_TEXTURES.has(name)) {
            normal = makeNormalMap(t.image);
            normal.wrapS = normal.wrapT = wrapping;
            normal.anisotropy = 16;
          }
          AI_TEX[name] = { map: t, normal };
        } finally {
          markTextureSettled(name);
          done();
        }
      };
      if (COLOR_ONLY_TEXTURES.has(name)) finalize();
      else enqueueTextureFinalize(finalize);
    }, undefined, () => {
      markTextureSettled(name);
      done();
    });
  });
}

let nextTextureJob = 0;
async function runTextureWorker() {
  while (nextTextureJob < TEXTURE_NAMES.length) {
    const name = TEXTURE_NAMES[nextTextureJob++];
    await loadTexture(name);
  }
}

// Resolves once all background jobs have either loaded or failed. Match entry
// awaits this same promise, so decode/normal-map work cannot spill into play.
export const texturesReady = Promise.all(
  Array.from({ length: Math.min(6, TEXTURE_NAMES.length) }, () => runTextureWorker()),
).then(() => undefined);

// Loud 90s wall art (posters / targets / hazard banners), unlit for punch.
// Pure decoration — no collider, mounted a few cm off the wall face.
function addDecal(scene, name, x, y, z, w, yaw = 0, h = w) {
  const ai = AI_TEX[name];
  if (!ai) return;
  const map = ai.map.clone();
  map.needsUpdate = true;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({
    map,
    ...DECOR_DEPTH_BIAS,
  }));
  m.position.set(x, y, z);
  m.rotation.y = yaw;
  m.name = `arena-decal:${name}`;
  scene.add(m);
  return m;
}

// Maps without planar architecture still get the same arena-poster language.
// These lightweight placards are visual-only so their posts never create a
// hidden snag in open traversal or underwater swimming routes.
function addPosterStand(scene, name, x, groundY, z, w, yaw = 0, h = w, color = 0x344a4a) {
  const normal = V(Math.sin(yaw), 0, Math.cos(yaw));
  const right = V(Math.cos(yaw), 0, -Math.sin(yaw));
  const bottomClearance = 1.2;
  const centerY = groundY + bottomClearance + h / 2;
  const backing = new THREE.Mesh(
    new THREE.BoxGeometry(w + 0.55, h + 0.55, 0.18),
    new THREE.MeshStandardMaterial({ color, roughness: 0.78, metalness: 0.22 }),
  );
  backing.position.set(x, centerY, z);
  backing.rotation.y = yaw;
  backing.name = `arena-poster-stand:${name}`;
  backing.castShadow = backing.receiveShadow = true;
  scene.add(backing);

  const postHeight = bottomClearance + 0.15;
  const postMaterial = new THREE.MeshStandardMaterial({ color: 0x263638, roughness: 0.7, metalness: 0.38 });
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.24, postHeight, 0.24), postMaterial);
    post.position.set(
      x + right.x * side * w * 0.36,
      groundY + postHeight / 2,
      z + right.z * side * w * 0.36,
    );
    post.rotation.y = yaw;
    post.name = `arena-poster-post:${name}`;
    post.castShadow = true;
    scene.add(post);
  }
  return addDecal(
    scene, name,
    x + normal.x * 0.101, centerY, z + normal.z * 0.101,
    w, yaw, h,
  );
}

// Bullseye posters are thin rectangular targets rather than spherical props.
// Their material dims while cooling down so players can tell when that exact
// poster is ready to score again.
function addScoreTarget(scene, world, x, y, z, w, yaw = 0, h = w) {
  const mesh = addDecal(scene, 'target', x, y, z, w, yaw, h);
  if (!mesh) return null;
  const normal = V(0, 0, 1).applyAxisAngle(V(0, 1, 0), yaw).normalize();
  const right = V(1, 0, 0).applyAxisAngle(V(0, 1, 0), yaw).normalize();
  const target = {
    id: `target-poster-${world.scoreTargets.length}`,
    kind: 'score-poster',
    shape: 'plane',
    pos: V(x, y, z),
    normal,
    right,
    up: V(0, 1, 0),
    halfWidth: w / 2,
    halfHeight: h / 2,
    points: 250,
    cooldownDuration: 30,
    cooldown: 0,
    active: true,
    receivesSplash: false,
    mesh,
    setCooldown(seconds) {
      this.cooldown = Math.max(0, Math.min(this.cooldownDuration, Number(seconds) || 0));
      this.active = this.cooldown <= 0;
      const brightness = this.active ? 1
        : this.cooldown > 3 ? 0.28 : 0.28 + 0.72 * (1 - this.cooldown / 3);
      this.mesh.material.color.setRGB(brightness, brightness, brightness);
    },
  };
  world.scoreTargets.push(target);
  world.anim.push((dt) => {
    if (target.cooldown <= 0) return;
    target.setCooldown(target.cooldown - dt);
  });
  return mesh;
}

function mat(color, opts = {}) {
  const { tex, repeat, emissive, ...rest } = opts;
  const params = { color, roughness: 0.72, metalness: 0.07, envMapIntensity: 0.48, ...rest };
  if (tex) {
    const rx = repeat?.[0] ?? 1, ry = repeat?.[1] ?? 1;
    const ai = AI_TEX[tex];
    const t = (ai ? ai.map : (TEXES[tex] || texPanel)()).clone();
    t.needsUpdate = true;
    t.repeat.set(rx, ry);
    params.map = t;
    if (ai?.normal) {
      const n = ai.normal.clone();
      n.needsUpdate = true;
      n.repeat.set(rx, ry);
      params.normalMap = n;
      params.normalScale = new THREE.Vector2(0.92, 0.92);
    }
  }
  if (emissive) { params.emissive = new THREE.Color(emissive); params.emissiveIntensity = opts.emissiveIntensity ?? 0.8; }
  return new THREE.MeshStandardMaterial(params);
}

/* ---------------- geometry helpers ---------------- */
// Box: (cx, cy, cz) is the CENTER.
// Static non-emissive boxes are pooled per texture and merged into a single
// mesh per group (colors baked into vertices) — one draw call instead of ~200.
function addBox(scene, world, cx, cy, cz, w, h, d, color, opts = {}) {
  const { collide = true, shadow = true, debugName = '', ...matOpts } = opts;
  if (matOpts.tex && !matOpts.repeat) {
    matOpts.repeat = [Math.max(1, Math.round(Math.max(w, d) / 4)), Math.max(1, Math.round(Math.max(h, Math.min(w, d)) / 4))];
  }
  if (collide) {
    world.colliders.push({
      type: 'box',
      min: V(cx - w / 2, cy - h / 2, cz - d / 2),
      max: V(cx + w / 2, cy + h / 2, cz + d / 2),
    });
  }
  const visualBox = {
    min: V(cx - w / 2, cy - h / 2, cz - d / 2),
    max: V(cx + w / 2, cy + h / 2, cz + d / 2),
    collide,
    debugName: debugName || `box-${world._visualBoxes.length}`,
    depthLane: 0,
  };
  const conflicts = [];
  const unavailableLanes = new Set();
  for (const other of world._visualBoxes) {
    const faces = coplanarFacesBetween(visualBox, other);
    if (!faces.length) continue;
    unavailableLanes.add(other.depthLane);
    conflicts.push({ other: other.debugName, faces });
  }
  while (unavailableLanes.has(visualBox.depthLane)) visualBox.depthLane++;
  world._visualBoxes.push(visualBox);
  for (const conflict of conflicts) {
    world.visualSurfaceConflicts.push({
      a: conflict.other,
      b: visualBox.debugName,
      faces: conflict.faces,
      resolvedByDepthLanes: true,
    });
  }
  Object.assign(matOpts, depthBiasFor(collide, visualBox.depthLane));
  if (!matOpts.emissive && world._geoGroups) {
    const g = new THREE.BoxGeometry(w, h, d);
    const [rx, ry] = matOpts.repeat || [1, 1];
    if (rx !== 1 || ry !== 1) {
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * rx, uv.getY(i) * ry);
    }
    const col = new THREE.Color(color);
    const n = g.attributes.position.count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) colors.set([col.r, col.g, col.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    g.translate(cx, cy, cz);
    const groupKey = `${collide ? 'solid' : 'decor'}${visualBox.depthLane}:${matOpts.tex || 'plain'}`;
    (world._geoGroups[groupKey] ||= []).push(g);
    return null;
  }
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, matOpts));
  m.position.set(cx, cy, cz);
  if (shadow) { m.castShadow = true; m.receiveShadow = true; }
  scene.add(m);
  return m;
}

// A surface layer is paint, signage, or trim—not physical structure. Its plane
// is moved four centimetres along its normal and receives a conservative depth
// bias. The separation survives shallow viewing angles and different GPU depth
// implementations without creating a meaningful collider/visual mismatch.
function addSurfacePanel(world, {
  x, y, z, width, height, normal = [0, 0, 1], color = 0xffffff,
}) {
  const n = V(...normal).normalize();
  const geometry = new THREE.PlaneGeometry(width, height);
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 0, 1), n));
  geometry.translate(
    x + n.x * SURFACE_LAYER_EPS,
    y + n.y * SURFACE_LAYER_EPS,
    z + n.z * SURFACE_LAYER_EPS,
  );
  const c = new THREE.Color(color);
  const colors = new Float32Array(geometry.attributes.position.count * 3);
  for (let i = 0; i < geometry.attributes.position.count; i++) colors.set([c.r, c.g, c.b], i * 3);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  world._surfaceGeometries.push(geometry);
}

function findCoplanarVisualFaces(boxes, epsilon = 1e-5) {
  const issues = [];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    for (const face of coplanarFacesBetween(a, b, epsilon)) {
      if (a.depthLane !== b.depthLane) continue;
      issues.push({
        a: a.debugName,
        b: b.debugName,
        face,
        depthLane: a.depthLane,
      });
    }
  }
  return issues;
}

function registerWallFeature(world, wall, name, center, y, width, height) {
  world._wallFeatures.push({ wall, name, center, y, width, height });
}

function findWallFeatureOverlaps(features, padding = 0.35) {
  const issues = [];
  for (let i = 0; i < features.length; i++) for (let j = i + 1; j < features.length; j++) {
    const a = features[i], b = features[j];
    if (a.wall !== b.wall) continue;
    const horizontal = Math.abs(a.center - b.center) < (a.width + b.width) / 2 + padding;
    const vertical = Math.abs(a.y - b.y) < (a.height + b.height) / 2 + padding;
    if (horizontal && vertical) issues.push({ wall: a.wall, a: a.name, b: b.name });
  }
  return issues;
}

function coplanarFacesBetween(a, b, epsilon = 1e-5) {
  const overlap = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0) > epsilon;
  const same = (u, v) => Math.abs(u - v) <= epsilon;
  const checks = [
    ['min', 'x', 'y', 'z'], ['max', 'x', 'y', 'z'],
    ['min', 'y', 'x', 'z'], ['max', 'y', 'x', 'z'],
    ['min', 'z', 'x', 'y'], ['max', 'z', 'x', 'y'],
  ];
  const faces = [];
  for (const [side, axis, crossA, crossB] of checks) {
    if (!same(a[side][axis], b[side][axis])) continue;
    if (!overlap(a.min[crossA], a.max[crossA], b.min[crossA], b.max[crossA])) continue;
    if (!overlap(a.min[crossB], a.max[crossB], b.min[crossB], b.max[crossB])) continue;
    faces.push(`${side}${axis.toUpperCase()}`);
  }
  return faces;
}

// Build the merged static meshes for a world (call once at the end of a map build).
function mergeStatic(scene, world) {
  const groupMat = {
    plain: { vertexColors: true },
    rockflat: { tex: 'rock', repeat: [1, 1], vertexColors: true, flatShading: true, roughness: 0.95 },
  };
  for (const [key, geos] of Object.entries(world._geoGroups)) {
    if (!geos.length) continue;
    for (const g of geos) {
      const ks = Object.keys(g.attributes).sort().join(',');
      if (ks !== 'color,normal,position,uv') console.warn('geo attr mismatch in', key, ':', ks);
    }
    const merged = mergeGeometries(geos, false);
    const [layerKey, textureKey] = key.includes(':') ? key.split(':') : ['solid0', key];
    const lane = +(layerKey.match(/\d+$/)?.[0] ?? 0);
    const isDecor = layerKey.startsWith('decor');
    const options = groupMat[textureKey]
      ? { ...groupMat[textureKey] }
      : { tex: textureKey, repeat: [1, 1], vertexColors: true };
    Object.assign(options, depthBiasFor(!isDecor, lane));
    const m = new THREE.Mesh(merged, mat(0xffffff, options));
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
    for (const g of geos) g.dispose();
  }
  if (world._surfaceGeometries.length) {
    const merged = mergeGeometries(world._surfaceGeometries, false);
    const surface = new THREE.Mesh(merged, mat(0xffffff, {
      vertexColors: true,
      roughness: 0.58,
      ...DECOR_DEPTH_BIAS,
    }));
    surface.renderOrder = 2;
    scene.add(surface);
    for (const geometry of world._surfaceGeometries) geometry.dispose();
  }
  world.visualSurfaceIssues = findCoplanarVisualFaces(world._visualBoxes);
  if (world.visualSurfaceIssues.length) {
    console.error(`[map geometry] ${world.visualSurfaceIssues.length} unresolved coplanar box surface(s)`, world.visualSurfaceIssues);
  }
  world.wallFeatureIssues = findWallFeatureOverlaps(world._wallFeatures);
  if (world.wallFeatureIssues.length) {
    console.error(`[map geometry] ${world.wallFeatureIssues.length} overlapping wall feature(s)`, world.wallFeatureIssues);
  }
  world._geoGroups = {};
  world._surfaceGeometries = [];
}

// Walkable slope. Rises along `axis` from h0 (at min end) to h1 (at max end).
function addRamp(scene, world, {
  axis, minX, maxX, minZ, maxZ, h0, h1, color, tex = 'panel', visualInset = 0,
  supportPad0 = 0, supportPad1 = 0, crestBlend0 = 0, crestBlend1 = 0,
}) {
  world.ramps.push({
    axis, minX, maxX, minZ, maxZ, h0, h1,
    supportPad0, supportPad1, crestBlend0, crestBlend1,
  });
  const len = axis === 'x' ? maxX - minX : maxZ - minZ;
  const width = axis === 'x' ? maxZ - minZ : maxX - minX;
  const dh = h1 - h0;
  const safeInset = Math.max(0, Math.min(visualInset, len * 0.45));
  const vLen = len - safeInset * 2;
  const t0 = safeInset / len;
  const t1 = 1 - t0;
  const vh0 = h0 + dh * t0;
  const vh1 = h0 + dh * t1;
  const slopeLen = Math.hypot(vLen, vh1 - vh0);
  const ang = Math.atan2(dh, len);
  const halfThickness = 0.2;
  const geo = new THREE.BoxGeometry(
    axis === 'x' ? slopeLen : width, 0.4, axis === 'x' ? width : slopeLen);
  const m = new THREE.Mesh(geo, mat(color, { tex, repeat: [Math.max(1, slopeLen / 5), Math.max(1, width / 5)] }));
  // Rotation moves the slab's top face backward/down by its projected half
  // thickness. Offset the center by the inverse projection so the visible top
  // still begins at h0 and ends exactly at h1.
  m.position.set(
    (minX + maxX) / 2 + (axis === 'x' ? halfThickness * Math.sin(ang) : 0),
    (vh0 + vh1) / 2 - halfThickness * Math.cos(ang),
    (minZ + maxZ) / 2 + (axis === 'z' ? halfThickness * Math.sin(ang) : 0),
  );
  // rising along +x tilts the box by +ang about z; rising along +z by −ang about x
  if (axis === 'x') m.rotation.z = ang; else m.rotation.x = -ang;
  m.castShadow = m.receiveShadow = true;
  scene.add(m);
  return m;
}

function triangleMeshColliderFromMesh(mesh, debugName = 'triangle-mesh') {
  mesh.updateMatrixWorld(true);
  const geometry = mesh.geometry;
  const positions = geometry.getAttribute('position');
  const index = geometry.getIndex();
  const triangles = [];
  const bounds = new THREE.Box3();
  const center = mesh.getWorldPosition(new THREE.Vector3());
  const vertex = i => V(positions.getX(i), positions.getY(i), positions.getZ(i))
    .applyMatrix4(mesh.matrixWorld);
  const faceCount = index ? index.count / 3 : positions.count / 3;
  for (let face = 0; face < faceCount; face++) {
    const ia = index ? index.getX(face * 3) : face * 3;
    const ib = index ? index.getX(face * 3 + 1) : face * 3 + 1;
    const ic = index ? index.getX(face * 3 + 2) : face * 3 + 2;
    const a = vertex(ia), b = vertex(ib), c = vertex(ic);
    const triangle = new THREE.Triangle(a, b, c);
    const normal = triangle.getNormal(new THREE.Vector3());
    const centroid = triangle.getMidpoint(new THREE.Vector3());
    // Some imported/generated geometries do not promise winding. Keep every
    // face normal pointing away from the mesh center so inside/outside tests
    // remain stable.
    if (normal.dot(centroid.sub(center)) < 0) {
      triangle.b = c;
      triangle.c = b;
      normal.negate();
    }
    const box = new THREE.Box3().setFromPoints([triangle.a, triangle.b, triangle.c]);
    bounds.union(box);
    triangles.push({ triangle, normal, box });
  }
  const triangleCellSize = THREE.MathUtils.clamp(
    Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z) / 12,
    2,
    8,
  );
  const triangleCells = new Map();
  for (const entry of triangles) {
    const minX = Math.floor(entry.box.min.x / triangleCellSize);
    const maxX = Math.floor(entry.box.max.x / triangleCellSize);
    const minZ = Math.floor(entry.box.min.z / triangleCellSize);
    const maxZ = Math.floor(entry.box.max.z / triangleCellSize);
    for (let ix = minX; ix <= maxX; ix++) for (let iz = minZ; iz <= maxZ; iz++) {
      const key = `${ix},${iz}`;
      let cell = triangleCells.get(key);
      if (!cell) triangleCells.set(key, cell = []);
      cell.push(entry);
    }
  }
  return {
    type: 'triangleMesh', triangles, triangleCells, triangleCellSize,
    min: bounds.min.clone(), max: bounds.max.clone(), debugName,
  };
}

function addAsteroid(
  scene, world, x, y, z, radius, color = 0x8a7f72, exactCollider = false, shape = null,
) {
  const geo = new THREE.IcosahedronGeometry(radius, 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const v = V(pos.getX(i), pos.getY(i), pos.getZ(i));
    // Keep the lumps subtle for ordinary asteroids, whose collider remains a
    // sphere. Terrain can opt into the exact transformed triangles below.
    const n = 1 + (Math.sin(v.x * 1.3) + Math.cos(v.z * 1.7) + Math.sin(v.y * 2.1)) * 0.018;
    v.multiplyScalar(n);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, mat(shape?.materialColor ?? color, {
    tex: shape?.tex ?? 'rock',
    repeat: shape?.repeat ?? [3, 3],
    roughness: shape?.roughness ?? 0.95,
    emissive: shape?.emissive,
    emissiveIntensity: shape?.emissiveIntensity,
    flatShading: true,
  }));
  m.position.set(x, y, z);
  m.scale.set(shape?.scaleX ?? 1, shape?.scaleY ?? 1, shape?.scaleZ ?? 1);
  if (shape?.lockRotation) m.rotation.set(0, 0, 0);
  else m.rotation.set(rand(0, 3), rand(0, 3), rand(0, 3));
  m.castShadow = m.receiveShadow = true;
  scene.add(m);
  world.colliders.push(exactCollider
    ? triangleMeshColliderFromMesh(m, 'faceted-asteroid')
    : { type: 'sphere', center: V(x, y, z), radius });
  return m;
}

function softMeadowPatchGeometry(palette) {
  const positions = [];
  const colors = [];
  const indices = [];
  for (let blade = 0; blade < 16; blade++) {
    const angle = blade * 2.39996 + Math.sin(blade * 4.7) * 0.42;
    const centerX = (blade % 4 - 1.5) * 0.31 + Math.sin(blade * 3.1) * 0.075;
    const centerZ = (Math.floor(blade / 4) - 1.5) * 0.31 + Math.cos(blade * 2.7) * 0.075;
    const sideX = Math.cos(angle);
    const sideZ = -Math.sin(angle);
    const width = 0.16 + (blade % 3) * 0.027;
    const midWidth = width * (0.78 + (blade % 2) * 0.07);
    const topWidth = width * (0.48 + (blade % 2) * 0.08);
    const height = 0.25 + (blade % 5) * 0.032;
    const lean = 0.1 + (blade % 3) * 0.035;
    const midX = centerX + Math.sin(angle) * lean * 0.34;
    const midZ = centerZ + Math.cos(angle) * lean * 0.34;
    const topX = centerX + Math.sin(angle) * lean;
    const topZ = centerZ + Math.cos(angle) * lean;
    const base = positions.length / 3;
    positions.push(
      centerX - sideX * width / 2, 0, centerZ - sideZ * width / 2,
      centerX + sideX * width / 2, 0, centerZ + sideZ * width / 2,
      midX - sideX * midWidth / 2, height * 0.52, midZ - sideZ * midWidth / 2,
      midX + sideX * midWidth / 2, height * 0.52, midZ + sideZ * midWidth / 2,
      topX - sideX * topWidth / 2, height, topZ - sideZ * topWidth / 2,
      topX + sideX * topWidth / 2, height, topZ + sideZ * topWidth / 2,
    );
    const bladeColor = new THREE.Color(palette[blade % palette.length]);
    const midColor = bladeColor.clone().offsetHSL(0, 0, 0.008);
    const tipColor = bladeColor.clone().offsetHSL(0, 0, 0.015);
    for (const color of [bladeColor, bladeColor, midColor, midColor, tipColor, tipColor]) {
      colors.push(color.r, color.g, color.b);
    }
    indices.push(
      base, base + 1, base + 2,
      base + 1, base + 3, base + 2,
      base + 2, base + 3, base + 4,
      base + 3, base + 5, base + 4,
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function softMeadowMaterial(cacheKey, { calmColor = null } = {}) {
  // One gently lit ground tone plus ambient fill keeps differently oriented
  // blades dimensional without turning a meadow into a noisy checkerboard.
  const material = calmColor == null
    ? new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      side: THREE.DoubleSide,
      roughness: 1,
      metalness: 0,
      flatShading: false,
    })
    : new THREE.MeshStandardMaterial({
      color: calmColor,
      vertexColors: false,
      side: THREE.DoubleSide,
      roughness: 1,
      metalness: 0,
      flatShading: false,
      // Lift the darkest faces without erasing the broad ribbon bends.
      emissive: 0x17351f,
      emissiveIntensity: 0.42,
    });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.grassTime = { value: 0 };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float grassTime;')
      .replace('#include <begin_vertex>', `
        vec3 transformed = vec3(position);
        float grassPhase = 0.0;
        #ifdef USE_INSTANCING
          grassPhase = instanceMatrix[3].x * 0.19 + instanceMatrix[3].z * 0.13;
        #endif
        float bladeTip = smoothstep(0.02, 0.36, position.y);
        float breeze = sin(grassTime * 1.35 + grassPhase)
          + sin(grassTime * 0.62 + grassPhase * 1.7) * 0.45;
        transformed.x += breeze * bladeTip * bladeTip * 0.055;
        transformed.z += cos(grassTime * 0.9 + grassPhase) * bladeTip * bladeTip * 0.035;
      `);
    material.userData.shader = shader;
  };
  material.customProgramCacheKey = () => cacheKey;
  return material;
}

// Universal renderer for dimensional grass. Maps only supply placement rules
// and a ground-matching tint; blade shape, restrained lighting, wind, density
// batching, and shadow behavior stay identical everywhere.
function addSoftMeadowGrass(scene, world, {
  count,
  tint,
  seed,
  name,
  cacheKey = 'soft-meadow-wind-v1',
  attemptMultiplier = 16,
  place,
}) {
  const geometry = softMeadowPatchGeometry([tint]);
  const material = softMeadowMaterial(cacheKey, { calmColor: tint });
  const grass = new THREE.InstancedMesh(geometry, material, count);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const orientation = new THREE.Quaternion();
  const up = V(0, 1, 0);
  const rnd = seededRandom(seed);
  const placement = { rnd, position, scale, orientation, up };
  let placed = 0;
  let attempts = 0;
  while (placed < count && attempts++ < count * attemptMultiplier) {
    position.set(0, 0, 0);
    scale.set(1, 1, 1);
    orientation.identity();
    if (!place(placement)) continue;
    matrix.compose(position, orientation, scale);
    grass.setMatrixAt(placed++, matrix);
  }
  grass.count = placed;
  grass.instanceMatrix.needsUpdate = true;
  grass.castShadow = grass.receiveShadow = false;
  grass.name = name;
  scene.add(grass);
  world.anim.push((_dt, t) => {
    if (material.userData.shader) material.userData.shader.uniforms.grassTime.value = t;
  });
  return grass;
}

function addCanopyMeadowGrass(scene, world, count = 4300) {
  const flowerBeds = [
    [-20, 55, 22, 18], [40, -65, 18, 14], [-70, 30, 16, 20],
  ];
  const treeCenters = [[0, 0, 8.8], [-45, -45, 6], [45, -45, 6], [-45, 45, 6], [45, 45, 6]];
  return addSoftMeadowGrass(scene, world, {
    count,
    tint: 0x3b6837,
    seed: 0xca70a55,
    name: 'canopy-soft-meadow',
    place: ({ rnd, position, scale, orientation, up }) => {
      const x = rnd() * 158 - 79;
      const z = rnd() * 158 - 79;
      const density = THREE.MathUtils.clamp(
        0.82 + Math.sin(x * 0.075 + z * 0.031) * 0.1
        + Math.sin(z * 0.064 - x * 0.027) * 0.08,
        0.62,
        0.98,
      );
      if (rnd() > density) return false;
      const inRiver = Math.abs(Math.abs(x) - 54) < 4.4;
      const onRoad = x > -51 && x < 71 && Math.abs(z + 40) < 4;
      const inFlowers = flowerBeds.some(([cx, cz, width, depth]) => (
        Math.abs(x - cx) < width / 2 + 0.5 && Math.abs(z - cz) < depth / 2 + 0.5
      ));
      const underTree = treeCenters.some(([cx, cz, radius]) => (
        Math.hypot(x - cx, z - cz) < radius
      ));
      const atRangerHut = x > 11.5 && x < 32 && z > 11.5 && z < 21;
      const atFallenLog = x > -39 && x < -19 && z > -28 && z < -18;
      const atTunnelOpening = Math.abs(x) < 4 && z > 39 && z < 69;
      if (inRiver || onRoad || inFlowers || underTree || atRangerHut
        || atFallenLog || atTunnelOpening) return false;

      const size = 0.96 + rnd() * 0.34;
      position.set(x, 0.035, z);
      orientation.setFromAxisAngle(up, rnd() * Math.PI * 2);
      scale.set(size * (0.9 + rnd() * 0.2), size, size * (0.9 + rnd() * 0.2));
      return true;
    },
  });
}

// A wide, layered crown reads as a real treetop instead of one round boulder.
// Broad overlapping leaf fans keep the low-poly silhouette soft, while the
// foliage stays visual-only so the existing deck routes and collision remain
// unchanged.
function addCanopyCrown(scene, x, y, z, radius, seed = 1, autumn = false, branchBaseY = null) {
  const rnd = seededRandom(0xca70f0 + seed * 977);
  const foliageGeometries = [];
  const branchGeometries = [];
  const greens = autumn
    ? [0x9b4825, 0xc45f24, 0xdd7b2c, 0xa83d22, 0xe09231]
    : [0x245f31, 0x32783a, 0x3f8641, 0x2b6e38, 0x4a8f43];
  const ringCount = radius > 14 ? 11 : 9;
  const branchRoot = V(x, branchBaseY ?? y - radius * 0.25, z);

  const colorGeometry = (geometry, color) => {
    const c = new THREE.Color(color);
    const sourceColors = geometry.getAttribute('color');
    const colors = new Float32Array(geometry.attributes.position.count * 3);
    for (let i = 0; i < geometry.attributes.position.count; i++) {
      const shade = sourceColors ? sourceColors.getX(i) : 1;
      colors.set([c.r * shade, c.g * shade, c.b * shade], i * 3);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return geometry;
  };
  const branchBetween = (start, end, bottomRadius, topRadius) => {
    const delta = end.clone().sub(start);
    const geometry = new THREE.CylinderGeometry(topRadius, bottomRadius, delta.length(), 7, 2);
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), delta.normalize()));
    geometry.translate(
      (start.x + end.x) * 0.5,
      (start.y + end.y) * 0.5,
      (start.z + end.z) * 0.5,
    );
    return geometry;
  };

  // A lifted central mass anchors the silhouette without filling the whole
  // crown; the radial lobes do most of the spreading.
  for (const [ox, oy, oz, sx, sy, sz, colorIndex] of [
    [0, 2.7, 0, 0.68, 0.58, 0.62, 0],
    [-0.28, 0.45, 0.18, 0.58, 0.44, 0.52, 2],
    [0.3, 0.9, -0.2, 0.54, 0.48, 0.58, 1],
  ]) {
    const geometry = myceliumLeafCrownGeometry().clone();
    geometry.scale(radius * sx, radius * sy, radius * sz);
    geometry.rotateY(rnd() * Math.PI);
    geometry.rotateZ((rnd() - 0.5) * 0.26);
    geometry.translate(x + radius * ox, y + oy, z + radius * oz);
    foliageGeometries.push(colorGeometry(geometry, greens[colorIndex]));
  }

  for (let i = 0; i < ringCount; i++) {
    const angle = i / ringCount * Math.PI * 2 + (rnd() - 0.5) * 0.24;
    const reach = radius * (0.58 + rnd() * 0.18);
    const end = V(
      x + Math.cos(angle) * reach,
      y - radius * (0.19 + rnd() * 0.07),
      z + Math.sin(angle) * reach,
    );
    branchGeometries.push(branchBetween(
      branchRoot,
      end,
      radius * 0.105,
      radius * 0.035,
    ));

    const geometry = myceliumLeafCrownGeometry().clone();
    const lobeRadius = radius * (0.34 + rnd() * 0.12);
    geometry.scale(
      lobeRadius * (1.28 + rnd() * 0.35),
      lobeRadius * (0.82 + rnd() * 0.23),
      lobeRadius * (1.02 + rnd() * 0.38),
    );
    geometry.rotateY(angle + (rnd() - 0.5) * 0.7);
    geometry.rotateZ((rnd() - 0.5) * 0.3);
    geometry.translate(
      end.x,
      y + radius * ((rnd() - 0.42) * 0.32),
      end.z,
    );
    foliageGeometries.push(colorGeometry(geometry, greens[(seed + i) % greens.length]));
  }

  const foliage = new THREE.Mesh(
    mergeGeometries(foliageGeometries, false),
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.96,
      metalness: 0,
      flatShading: true,
    }),
  );
  foliage.castShadow = foliage.receiveShadow = true;
  scene.add(foliage);

  const branches = new THREE.Mesh(
    mergeGeometries(branchGeometries, false),
    mat(0xffffff, { tex: 'canopy-bark', repeat: [2, 3], roughness: 0.98, metalness: 0 }),
  );
  branches.castShadow = branches.receiveShadow = true;
  scene.add(branches);

  for (const geometry of foliageGeometries) geometry.dispose();
  for (const geometry of branchGeometries) geometry.dispose();
  return { foliage, branches };
}

// Animated water: two overlapping planes with counter-scrolling wave normal
// maps, glassy roughness for sun glints, env reflections for the sky sheen.
let _waterNormal = null;
function waterNormalTex() {
  if (!_waterNormal) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#808080';
    g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 60; i++) {
      const x = Math.random() * 128, y = Math.random() * 128, r = 6 + Math.random() * 16;
      const grad = g.createRadialGradient(x, y, 1, x, y, r);
      const v = Math.random() > 0.5 ? 200 : 60;
      grad.addColorStop(0, `rgba(${v},${v},${v},0.5)`);
      grad.addColorStop(1, 'rgba(128,128,128,0)');
      g.fillStyle = grad;
      g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    }
    _waterNormal = makeNormalMap(c);
  }
  return _waterNormal;
}

function addWater(scene, world, x, y, z, w, d, depth = 4, opts = {}) {
  world.waterZones ||= [];
  const zone = {
    minX: x - w / 2, maxX: x + w / 2,
    minZ: z - d / 2, maxZ: z + d / 2,
    surfaceY: y, bottomY: y - depth,
  };
  if (opts.points?.length) zone.points = opts.points.map(point => [...point]);
  world.waterZones.push(zone);

  const n = opts.unlit ? null : waterNormalTex().clone();
  if (n) {
    n.needsUpdate = true;
    n.repeat.set(w / 9, d / 9);
  }
  const material = opts.unlit
    ? new THREE.MeshBasicMaterial({
      color: opts.color ?? 0x216f93, transparent: true, opacity: opts.opacity ?? 0.5,
      depthWrite: false,
    })
    : new THREE.MeshStandardMaterial({
      color: 0x11557f, transparent: true, opacity: 0.58, roughness: 0.08, metalness: 0.05,
      normalMap: n, normalScale: new THREE.Vector2(0.75, 0.75),
      envMapIntensity: 1.15, emissive: 0x06283f, emissiveIntensity: 0.12,
      depthWrite: false,
    });
  let geometry;
  if (opts.points?.length) {
    const shape = new THREE.Shape();
    opts.points.forEach(([px, pz], index) => {
      const sx = px - x;
      const sy = -(pz - z);
      if (index === 0) shape.moveTo(sx, sy);
      else shape.lineTo(sx, sy);
    });
    shape.closePath();
    geometry = new THREE.ShapeGeometry(shape);
    material.side = THREE.DoubleSide;
  } else geometry = new THREE.PlaneGeometry(w, d);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(x, y, z);
  // Water is presentation and an environment zone, never a ray target. Keep
  // hooks (and any other scene ray queries) travelling through the surface to
  // the first real solid beyond it.
  mesh.raycast = () => {};
  scene.add(mesh);
  if (n) world.anim.push((dt, t) => n.offset.set(t * 0.018, t * 0.03));
}

function addMyceliumPondBasin(
  scene, world, points, centerX, centerZ, bottomY = -4.4, options = {},
) {
  const innerScale = 0.5;
  const outer = points.map(([x, z]) => V(x, 0.02, z));
  const inner = points.map(([x, z]) => V(
    centerX + (x - centerX) * innerScale,
    bottomY + 0.22,
    centerZ + (z - centerZ) * innerScale,
  ));
  const positions = [];
  const indices = [];
  for (const point of [...outer, ...inner, V(centerX, bottomY, centerZ)]) {
    positions.push(point.x, point.y, point.z);
  }
  const count = points.length;
  const centerIndex = count * 2;
  for (let i = 0; i < count; i++) {
    const next = (i + 1) % count;
    indices.push(i, next, count + i, next, count + next, count + i);
    indices.push(centerIndex, count + i, count + next);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const basin = new THREE.Mesh(geometry, mat(0x29463a, {
    tex: 'rock', repeat: [5, 5], roughness: 0.99, side: THREE.DoubleSide,
  }));
  basin.receiveShadow = true;
  scene.add(basin);

  // The arena floor around this irregular cutout is assembled from broad
  // rectangular beds. Bridge their triangular corner gaps with one continuous
  // apron that follows the actual shoreline and overlaps the surrounding
  // grass. A matching grid of shallow support cells prevents visual fixes from
  // hiding places where a player could still fall through.
  const apronWidth = 4.2;
  const apronPoints = points.map(([x, z]) => {
    const dx = x - centerX;
    const dz = z - centerZ;
    const distance = Math.hypot(dx, dz) || 1;
    return [x + dx / distance * apronWidth, z + dz / distance * apronWidth];
  });
  const shoreShape = new THREE.Shape();
  apronPoints.forEach(([x, z], index) => {
    if (index === 0) shoreShape.moveTo(x, -z);
    else shoreShape.lineTo(x, -z);
  });
  shoreShape.closePath();
  const pondHole = new THREE.Path();
  [...points].reverse().forEach(([x, z], index) => {
    if (index === 0) pondHole.moveTo(x, -z);
    else pondHole.lineTo(x, -z);
  });
  pondHole.closePath();
  shoreShape.holes.push(pondHole);
  const apron = new THREE.Mesh(
    new THREE.ShapeGeometry(shoreShape),
    // ShapeGeometry UVs are already expressed in world-sized coordinates.
    // One texture repeat per ~6 units matches the neighboring understory beds;
    // the former 9x multiplier aliased into a flat-looking solid-green wedge.
    mat(0x183d2d, {
      tex: 'grass', repeat: [1 / 6, 1 / 6], roughness: 0.99, side: THREE.DoubleSide,
    }),
  );
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = 0.025;
  apron.receiveShadow = true;
  scene.add(apron);

  const shoreZone = { points: apronPoints, holes: [points] };
  // Use a fine, overlapping grid and keep every cell that intersects the
  // shoreline ring. Center-only selection left thin diagonal slivers between
  // the polygon and the square grid, which is exactly where the visible pond
  // gaps appeared. The half-size overlap is small enough to remain a natural
  // shallow bank rather than creating a broad invisible shelf over the water.
  const cellSize = 1;
  const cellHalf = 0.52;
  const minX = Math.min(...apronPoints.map(point => point[0]));
  const maxX = Math.max(...apronPoints.map(point => point[0]));
  const minZ = Math.min(...apronPoints.map(point => point[1]));
  const maxZ = Math.max(...apronPoints.map(point => point[1]));
  for (let x = minX + cellSize / 2; x < maxX; x += cellSize) {
    for (let z = minZ + cellSize / 2; z < maxZ; z += cellSize) {
      const supportBlocked = options.supportClearZones?.some(zone => (
        x + cellHalf >= zone.minX && x - cellHalf <= zone.maxX
        && z + cellHalf >= zone.minZ && z - cellHalf <= zone.maxZ
      ));
      if (supportBlocked) continue;
      const intersectsShore = [
        [0, 0], [-cellHalf, -cellHalf], [cellHalf, -cellHalf],
        [-cellHalf, cellHalf], [cellHalf, cellHalf],
        [-cellHalf, 0], [cellHalf, 0], [0, -cellHalf], [0, cellHalf],
      ].some(([dx, dz]) => pointInZoneXZ(shoreZone, x + dx, z + dz));
      if (!intersectsShore) continue;
      world.colliders.push({
        type: 'box',
        min: V(x - cellHalf, -0.32, z - cellHalf),
        max: V(x + cellHalf, 0.035, z + cellHalf),
        debugName: 'mycelium-pond-shore-support',
      });
    }
  }

  // A deep central floor plus four broad slopes makes the pool genuinely
  // swimmable while keeping multiple natural walk-in/walk-out edges.
  world.colliders.push({
    type: 'box', min: V(centerX - 8.7, bottomY - 0.7, centerZ - 7.1),
    max: V(centerX + 8.7, bottomY, centerZ + 7.1),
  });
  world.ramps.push(
    { axis: 'x', minX: -17.4, maxX: -6.7, minZ: -43.2, maxZ: -28.2, h0: 0, h1: bottomY },
    { axis: 'x', minX: 11.2, maxX: 21.3, minZ: -43.2, maxZ: -28.2, h0: bottomY, h1: 0 },
    { axis: 'z', minX: -6.8, maxX: 11.8, minZ: -50, maxZ: -42.6, h0: 0, h1: bottomY },
    { axis: 'z', minX: -6.8, maxX: 11.8, minZ: -28.4, maxZ: -20.8, h0: bottomY, h1: 0 },
  );
}

function addMinnowSchool(scene, world, x, z, travel = 13, phase = 0, surfaceY = -0.55) {
  const school = new THREE.Group();
  const fishMaterial = mat(0x9fd7c5, {
    roughness: 0.5, metalness: 0.12, flatShading: true,
  });
  const tailMaterial = new THREE.MeshStandardMaterial({
    color: 0x74b7a6, roughness: 0.55, metalness: 0.08,
    flatShading: true, side: THREE.DoubleSide,
  });
  const tailGeometry = new THREE.BufferGeometry();
  tailGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, -0.02,
    0, -0.24, -0.42,
    0, 0.24, -0.42,
  ], 3));
  tailGeometry.computeVertexNormals();
  const fish = [];
  for (let i = 0; i < 9; i++) {
    const minnow = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 5), fishMaterial);
    body.scale.set(0.78, 0.58, 1.75);
    body.position.z = 0.08;
    const tailPivot = new THREE.Group();
    tailPivot.position.z = -0.24;
    const tail = new THREE.Mesh(tailGeometry, tailMaterial);
    tailPivot.add(tail);
    minnow.add(body, tailPivot);
    minnow.position.set(
      ((i * 1.73) % 3.2) - 1.6,
      -0.16 - (i % 3) * 0.11,
      ((i * 2.31) % 4.8) - 2.4,
    );
    minnow.scale.setScalar((0.82 + (i % 4) * 0.08) / 3);
    school.add(minnow);
    const heading = phase + i * 0.68;
    fish.push({
      mesh: minnow,
      tailPivot,
      seed: i * 0.91,
      vx: Math.sin(heading) * 0.7,
      vz: Math.cos(heading) * 0.7,
      fear: 0,
    });
  }
  // Keep the same readable distance beneath the water surface across ponds
  // and rivers with different authored elevations.
  school.position.set(x, surfaceY - 0.57, z);
  scene.add(school);

  world.anim.push((dt, t, characters = []) => {
    dt = Math.min(dt, 0.05);
    let threat = null;
    let threatDistance = Infinity;
    for (const ch of characters) {
      if (!ch?.alive || ch.pos.y > surfaceY + 0.75 || Math.abs(ch.pos.x - x) > 4.2) continue;
      const distance = Math.hypot(ch.pos.x - x, ch.pos.z - z);
      if (distance < threatDistance && distance < travel + 7) {
        threat = ch;
        threatDistance = distance;
      }
    }

    for (const f of fish) {
      let centerX = 0;
      let centerZ = 0;
      let alignX = 0;
      let alignZ = 0;
      let separateX = 0;
      let separateZ = 0;
      let neighbors = 0;
      for (const other of fish) {
        if (other === f) continue;
        const dx = other.mesh.position.x - f.mesh.position.x;
        const dz = other.mesh.position.z - f.mesh.position.z;
        const distanceSq = dx * dx + dz * dz;
        if (distanceSq > 16) continue;
        centerX += other.mesh.position.x;
        centerZ += other.mesh.position.z;
        alignX += other.vx;
        alignZ += other.vz;
        neighbors++;
        if (distanceSq < 0.7 && distanceSq > 0.0001) {
          separateX -= dx / distanceSq;
          separateZ -= dz / distanceSq;
        }
      }

      let ax = Math.sin(t * 0.72 + f.seed) * 0.18;
      let az = Math.cos(t * 0.57 + f.seed * 1.3) * 0.18;
      if (neighbors) {
        ax += (centerX / neighbors - f.mesh.position.x) * 0.32;
        az += (centerZ / neighbors - f.mesh.position.z) * 0.32;
        ax += (alignX / neighbors - f.vx) * 0.48 + separateX * 0.85;
        az += (alignZ / neighbors - f.vz) * 0.48 + separateZ * 0.85;
      }

      // Turn back before touching the narrow river walls or the end of the
      // school's stretch of channel.
      const channelHalfWidth = 3.15;
      if (Math.abs(f.mesh.position.x + f.vx * 0.8) > channelHalfWidth - 0.55) {
        ax += -Math.sign(f.mesh.position.x + f.vx * 0.8) * 5.5;
      }
      if (Math.abs(f.mesh.position.z + f.vz * 0.8) > travel - 0.7) {
        az += -Math.sign(f.mesh.position.z + f.vz * 0.8) * 5.5;
      }

      if (threat) {
        const dx = x + f.mesh.position.x - threat.pos.x;
        const dz = z + f.mesh.position.z - threat.pos.z;
        const distance = Math.hypot(dx, dz);
        if (distance < 6) {
          const force = (6 - distance) / 6;
          ax += dx / Math.max(distance, 0.1) * (8 + force * 12);
          az += dz / Math.max(distance, 0.1) * (8 + force * 12);
          f.fear = 1;
        }
      }
      f.fear = Math.max(0, f.fear - dt * 0.7);
      f.vx += ax * dt;
      f.vz += az * dt;
      const speed = Math.hypot(f.vx, f.vz) || 1;
      const maxSpeed = 1.15 + f.fear * 4.8;
      const minSpeed = 0.42;
      const clampedSpeed = THREE.MathUtils.clamp(speed, minSpeed, maxSpeed);
      f.vx = f.vx / speed * clampedSpeed;
      f.vz = f.vz / speed * clampedSpeed;
      f.mesh.position.x += f.vx * dt;
      f.mesh.position.z += f.vz * dt;
      // Panic steering can be strong, so finish with a strict containment
      // step. Fish turn back into the water instead of clipping through the
      // solid river banks or the ends of their assigned channel stretch.
      if (Math.abs(f.mesh.position.x) > channelHalfWidth) {
        f.mesh.position.x = Math.sign(f.mesh.position.x) * channelHalfWidth;
        f.vx = -Math.sign(f.mesh.position.x) * Math.max(0.5, Math.abs(f.vx));
      }
      if (Math.abs(f.mesh.position.z) > travel) {
        f.mesh.position.z = Math.sign(f.mesh.position.z) * travel;
        f.vz = -Math.sign(f.mesh.position.z) * Math.max(0.5, Math.abs(f.vz));
      }
      f.mesh.position.y = -0.16 - (Math.round(f.seed / 0.91) % 3) * 0.11
        + Math.sin(t * 1.8 + f.seed) * 0.025;
      f.mesh.rotation.y = Math.atan2(f.vx, f.vz);
      f.tailPivot.rotation.y = Math.sin(t * (5 + f.fear * 15) + f.seed) * (0.12 + f.fear * 0.34);
    }
  });
}

// Fit water from the actual inner faces of a basin instead of hand-tuning a
// slightly undersized plane. The small overlap is hidden beneath the solid rim
// or channel wall, eliminating edge cracks without exposing water beyond it.
function addFittedWater(scene, world, {
  minX, maxX, minZ, maxZ, y, depth = 4, edgeOverlap = 0.2, opts = {},
}) {
  addWater(
    scene,
    world,
    (minX + maxX) / 2,
    y,
    (minZ + maxZ) / 2,
    maxX - minX + edgeOverlap * 2,
    maxZ - minZ + edgeOverlap * 2,
    depth,
    opts,
  );
}

function addAtriumUnderwaterChamber(scene, world) {
  const chamberFloorY = -54;
  const shaftHalfX = 7;
  const shaftHalfZ = 5;
  const chamber = new THREE.Group();
  chamber.name = 'atrium-hidden-underwater-chamber';
  scene.add(chamber);

  const stone = mat(0x24485b, { tex: 'rock', repeat: [3, 3], roughness: 0.92 });
  const shell = (x, y, z, w, h, d) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), stone);
    mesh.position.set(x, y, z);
    mesh.castShadow = mesh.receiveShadow = true;
    chamber.add(mesh);
    world.colliders.push({
      type: 'box', min: V(x - w / 2, y - h / 2, z - d / 2),
      max: V(x + w / 2, y + h / 2, z + d / 2),
    });
    return mesh;
  };

  // Square stone throat beneath the circular basin. The atrium slab is split
  // around this opening in buildAtrium, so once its submerged lid retracts the
  // descent is continuous player-controlled swimming rather than a teleport.
  // End the throat immediately below the courtyard slab. Its original top
  // extended into that slab from y=-1 to y=-0.18, putting identical inner
  // faces on all four pool walls and causing the striped z-fighting revealed
  // by the open hatch.
  const throatBottomY = -39.2;
  const throatTopY = -1.02;
  const throatHeight = throatTopY - throatBottomY;
  const throatCenterY = (throatTopY + throatBottomY) / 2;
  shell(-shaftHalfX - 0.5, throatCenterY, 0, 1, throatHeight, shaftHalfZ * 2 + 2);
  shell(shaftHalfX + 0.5, throatCenterY, 0, 1, throatHeight, shaftHalfZ * 2 + 2);
  shell(0, throatCenterY, -shaftHalfZ - 0.5, shaftHalfX * 2, throatHeight, 1);
  shell(0, throatCenterY, shaftHalfZ + 0.5, shaftHalfX * 2, throatHeight, 1);

  // A broad flooded antechamber gives the descent somewhere physical to end.
  // Its ceiling meets the shaft, while the southern gate sits comfortably
  // above the coral-stone floor.
  shell(0, chamberFloorY - 0.8, 0, 38, 1.6, 34);
  shell(-19.2, chamberFloorY + 7, 0, 1.6, 15.6, 34);
  shell(19.2, chamberFloorY + 7, 0, 1.6, 15.6, 34);
  shell(0, chamberFloorY + 7, 17.2, 38, 15.6, 1.6);
  // The portal is a proximity trigger, not a passage through this shell. Use
  // one uninterrupted back wall and mount the gate in front of it, exactly as
  // the Atrium does, so no wall edge or sky seam can show beside the frame.
  shell(0, chamberFloorY + 7, -17.2, 38, 15.6, 1.6);
  shell(-13, chamberFloorY + 14.2, 0, 12, 1.2, 34);
  shell(13, chamberFloorY + 14.2, 0, 12, 1.2, 34);
  shell(0, chamberFloorY + 14.2, -11, 14, 1.2, 12);
  shell(0, chamberFloorY + 14.2, 11, 14, 1.2, 12);

  const gateY = chamberFloorY + 3.7;
  addAtriumGateBrickFrame(scene, world, 'tidebreaker', 0x49e6d0,
    0, -16.35, true, chamberFloorY, chamber);
  addMagicPortal(scene, world, 0, gateY, -16.18, 7.8, 7.8,
    0x49e6d0, 0, chamber);
  const marquee = addAtriumMarquee(scene, 'tidebreaker', 'SUNKEN REEF', 0x49e6d0,
    0, chamberFloorY + 10.45, -16.3, 0, 16.5);
  chamber.add(marquee);
  world.portals.push({
    x: 0, y: chamberFloorY + 1, z: -14.8,
    radius: 2.8, heightRadius: 5.5, map: 'reef', name: 'SUNKEN REEF',
  });

  const chamberGlow = new THREE.PointLight(0x43e4d2, 28, 44);
  chamberGlow.position.set(0, chamberFloorY + 8, -7);
  chamber.add(chamberGlow);
  for (const [x, z, color] of [
    [-13, -7, 0xff6d82], [13, -5, 0xffb44a], [-10, 8, 0x8d65ff], [11, 9, 0x48e0a4],
  ]) {
    const coral = new THREE.Group();
    coral.position.set(x, chamberFloorY, z);
    for (let i = 0; i < 4; i++) {
      const branch = new THREE.Mesh(
        new THREE.CylinderGeometry(0.18, 0.34, 2.4 + i * 0.45, 6),
        mat(color, { roughness: 0.82, emissive: color, emissiveIntensity: 0.12 }),
      );
      branch.position.set((i - 1.5) * 0.45, 1.2 + i * 0.22, Math.sin(i * 2.2) * 0.35);
      branch.rotation.z = (i - 1.5) * -0.13;
      coral.add(branch);
    }
    chamber.add(coral);
  }

  // The shaft owns the only surface-height water zone. The wider chamber uses
  // a lower virtual surface so players walking across the atrium above it are
  // never incorrectly treated as swimming.
  world.waterZones.push({
    minX: -19, maxX: 19, minZ: -17, maxZ: 17,
    surfaceY: chamberFloorY + 14, bottomY: chamberFloorY - 1.8,
  });

  // The entire visible basin floor is one moving lid. Closed, it completely
  // conceals the full-pool shaft and its stone throat; triggered, it slides
  // beneath the east courtyard slab for a few seconds before returning.
  const basinFloorWidth = 14;
  const basinFloorDepth = 10;
  const basinFloorY = -0.15;
  const hatchCollider = {
    type: 'box', dynamic: true,
    min: V(-basinFloorWidth / 2, -0.26, -basinFloorDepth / 2),
    max: V(basinFloorWidth / 2, -0.04, basinFloorDepth / 2),
  };
  world.colliders.push(hatchCollider);
  const hatch = new THREE.Mesh(
    new THREE.BoxGeometry(basinFloorWidth, 0.22, basinFloorDepth),
    mat(0x3c5365, { tex: 'panel', repeat: [3, 2], roughness: 0.62, metalness: 0.18 }),
  );
  hatch.position.set(0, basinFloorY, 0);
  hatch.castShadow = hatch.receiveShadow = true;
  scene.add(hatch);

  // Mirror the south lawn plate on the north side of the fountain.
  const plateBase = addBox(scene, world, 0, 0.19, -12, 5.4, 0.18, 3.6, 0x33445c, {
    collide: false, emissive: 0x10263c, emissiveIntensity: 0.35,
  });
  const plateGrass = addBox(scene, world, 0, 0.305, -12, 5, 0.08, 3.2, 0x4d8e3f, {
    tex: 'atrium-grass', repeat: [1, 1], collide: false, shadow: false,
    emissive: 0x102808, emissiveIntensity: 0.12,
  });
  for (const x of [-2.38, 2.38]) for (const z of [-13.52, -10.48]) {
    addBox(scene, world, x, 0.37, z, 0.22, 0.12, 0.22, 0x49e6d0, {
      collide: false, shadow: false, emissive: 0x167a70, emissiveIntensity: 1.2,
    });
  }

  const mechanism = {
    phase: 'closed', progress: 0, openTimer: 0, plateArmed: true,
    plate: { x: 0, z: -12, radius: 2.35 },
  };
  world.reefFountainMechanism = mechanism;
  world.anim.push((dt, _t, characters = []) => {
    const player = characters.find(ch => ch.isPlayer && ch.alive);
    const onPlate = !!player && Math.abs(player.pos.y) < 2 &&
      Math.hypot(player.pos.x, player.pos.z + 12) < mechanism.plate.radius;
    if (!onPlate && mechanism.phase === 'closed') mechanism.plateArmed = true;
    if (mechanism.phase === 'closed' && mechanism.plateArmed && onPlate) {
      mechanism.phase = 'opening';
      mechanism.plateArmed = false;
      world.onSecretFountainReveal?.();
    }
    if (mechanism.phase === 'opening') {
      mechanism.progress = Math.min(1, mechanism.progress + dt * 0.9);
      if (mechanism.progress >= 1) {
        mechanism.phase = 'open';
        mechanism.openTimer = 4;
      }
    } else if (mechanism.phase === 'open') {
      mechanism.openTimer -= dt;
      if (mechanism.openTimer <= 0) mechanism.phase = 'closing';
    } else if (mechanism.phase === 'closing') {
      mechanism.progress = Math.max(0, mechanism.progress - dt * 0.72);
      if (mechanism.progress <= 0) mechanism.phase = 'closed';
    }
    const p = mechanism.progress;
    const eased = p * p * (3 - 2 * p);
    const floorX = eased * 16.5;
    hatch.position.x = floorX;
    hatchCollider.min.x = floorX - basinFloorWidth / 2;
    hatchCollider.max.x = floorX + basinFloorWidth / 2;
    plateBase.position.y = 0.19 - eased * 0.1;
    plateGrass.position.y = 0.305 - eased * 0.1;
  });
}

function addAtriumFountain(scene, world, x, z) {
  const root = new THREE.Group();
  root.position.set(x, 0, z);
  root.name = 'atrium-fountain-centerpiece';
  scene.add(root);

  const stone = mat(0x66728d, { metalness: 0.42, roughness: 0.3 });
  const darkStone = mat(0x303951, { metalness: 0.5, roughness: 0.28 });
  const orange = mat(0xff6a2b, {
    emissive: 0x7a1705, emissiveIntensity: 0.55, metalness: 0.5, roughness: 0.24,
  });
  const water = new THREE.MeshBasicMaterial({
    color: 0xa8efff, transparent: true, opacity: 0.82,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const waterSurface = new THREE.MeshStandardMaterial({
    color: 0x6bdcff, emissive: 0x117aa0, emissiveIntensity: 0.65,
    transparent: true, opacity: 0.86, roughness: 0.08, metalness: 0.08,
    depthWrite: false,
  });
  const add = (geometry, material, y, { rotateX = 0, shadow = true } = {}) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = y;
    mesh.rotation.x = rotateX;
    if (shadow) mesh.castShadow = mesh.receiveShadow = true;
    root.add(mesh);
    return mesh;
  };

  // A compact art-deco pedestal and two stepped bowls create a recognizable
  // fountain silhouette without blocking sightlines across the atrium.
  // Plinth rises from the pool floor through the water instead of resting on
  // the surface plane.
  add(new THREE.CylinderGeometry(1.5, 1.8, 0.9, 12), darkStone, 0.45);
  add(new THREE.CylinderGeometry(0.72, 1.04, 1.65, 12), stone, 1.72);
  add(new THREE.CylinderGeometry(1.78, 0.68, 0.46, 24), stone, 2.67);
  add(new THREE.TorusGeometry(1.67, 0.14, 8, 32), orange, 2.91, { rotateX: Math.PI / 2 });
  add(new THREE.CylinderGeometry(1.48, 1.48, 0.07, 28), waterSurface, 2.93, { shadow: false });
  add(new THREE.CylinderGeometry(0.3, 0.48, 1.18, 10), darkStone, 3.46);
  add(new THREE.CylinderGeometry(1.0, 0.38, 0.35, 20), stone, 4.12);
  add(new THREE.TorusGeometry(0.92, 0.11, 8, 28), orange, 4.31, { rotateX: Math.PI / 2 });
  add(new THREE.CylinderGeometry(0.78, 0.78, 0.055, 24), waterSurface, 4.32, { shadow: false });
  const crown = add(new THREE.IcosahedronGeometry(0.38, 1), orange, 4.74);

  // Six visible arcs spill from the upper bowl into the basin. Tube geometry
  // reads as actual water from oblique angles where a flat sprite disappears.
  const jets = [];
  for (let i = 0; i < 6; i++) {
    const a = i * Math.PI / 3;
    const radial = V(Math.cos(a), 0, Math.sin(a));
    const start = radial.clone().multiplyScalar(0.66).setY(4.43);
    const control = radial.clone().multiplyScalar(2.05).setY(5.5);
    // Pool water surface sits at y=0.55; land the arcs in the open basin.
    const end = radial.clone().multiplyScalar(3.35).setY(0.55);
    const curve = new THREE.QuadraticBezierCurve3(start, control, end);
    const jet = new THREE.Mesh(new THREE.TubeGeometry(curve, 28, 0.065, 7, false), water.clone());
    jet.renderOrder = 4;
    root.add(jet);
    jets.push(jet);
  }
  const plumeCurve = new THREE.CatmullRomCurve3([
    V(0, 4.82, 0), V(0.08, 5.65, -0.03), V(-0.06, 6.35, 0.04), V(0, 6.85, 0),
  ]);
  const plume = new THREE.Mesh(new THREE.TubeGeometry(plumeCurve, 22, 0.09, 7, false), water.clone());
  plume.renderOrder = 4;
  root.add(plume);

  const glow = new THREE.PointLight(0x70dfff, 18, 18);
  glow.position.set(0, 4.2, 0);
  root.add(glow);
  world.anim.push((dt, t) => {
    crown.rotation.y += dt * 0.7;
    plume.material.opacity = 0.72 + Math.sin(t * 4.2) * 0.12;
    jets.forEach((jet, i) => { jet.material.opacity = 0.68 + Math.sin(t * 3.4 + i) * 0.11; });
  });
  return root;
}

function addAtriumSecretObservatory(scene, world, fountain) {
  const floorY = 420;
  const observatory = new THREE.Group();
  observatory.name = 'atrium-hidden-secret-space-map';
  observatory.visible = false;
  scene.add(observatory);

  const rnd = seededRandom(0x51aceb00);

  // A very large seamless sky shell replaces the atrium's pink background
  // while this hidden destination is active. Its scale and lack of a visible
  // rim make it read as open space rather than another enclosed bubble.
  const voidCanvas = document.createElement('canvas');
  voidCanvas.width = 2048;
  voidCanvas.height = 1024;
  const voidCtx = voidCanvas.getContext('2d');
  const voidGradient = voidCtx.createLinearGradient(0, 0, 0, 1024);
  voidGradient.addColorStop(0, '#020511');
  voidGradient.addColorStop(0.48, '#090a27');
  voidGradient.addColorStop(1, '#01030b');
  voidCtx.fillStyle = voidGradient;
  voidCtx.fillRect(0, 0, 2048, 1024);
  for (const [x, y, radius, inner, outer] of [
    [420, 390, 520, 'rgba(55,35,125,.23)', 'rgba(9,8,35,0)'],
    [1520, 570, 600, 'rgba(16,75,118,.2)', 'rgba(2,4,18,0)'],
    [1040, 820, 440, 'rgba(92,24,92,.12)', 'rgba(4,2,16,0)'],
  ]) {
    const nebula = voidCtx.createRadialGradient(x, y, 0, x, y, radius);
    nebula.addColorStop(0, inner);
    nebula.addColorStop(1, outer);
    voidCtx.fillStyle = nebula;
    voidCtx.fillRect(0, 0, 2048, 1024);
  }
  for (let i = 0; i < 1500; i++) {
    const x = rnd() * 2048;
    const y = rnd() * 1024;
    const r = 0.35 + rnd() * (rnd() > 0.96 ? 2.6 : 1.25);
    voidCtx.globalAlpha = 0.35 + rnd() * 0.65;
    const tint = rnd();
    voidCtx.fillStyle = tint > 0.94 ? '#8bdcff' : tint < 0.04 ? '#d6b6ff' : '#ffffff';
    voidCtx.beginPath();
    voidCtx.arc(x, y, r, 0, Math.PI * 2);
    voidCtx.fill();
  }
  voidCtx.globalAlpha = 1;
  const voidTexture = new THREE.CanvasTexture(voidCanvas);
  voidTexture.colorSpace = THREE.SRGBColorSpace;
  const deepSpace = new THREE.Mesh(new THREE.SphereGeometry(240, 64, 40),
    new THREE.MeshBasicMaterial({
      map: voidTexture, side: THREE.BackSide, fog: false, depthWrite: false,
    }));
  deepSpace.position.y = floorY + 8;
  deepSpace.renderOrder = -20;
  deepSpace.name = 'observatory-deep-space-sky';
  observatory.add(deepSpace);

  const deckMaterial = mat(0x202944, { tex: 'panel', repeat: [4, 4], roughness: 0.42, metalness: 0.3 });
  const addDeckBox = (x, y, z, w, h, d, material = deckMaterial, collide = true) => {
    if (collide) world.colliders.push({
      type: 'box', min: V(x - w / 2, y - h / 2, z - d / 2), max: V(x + w / 2, y + h / 2, z + d / 2),
    });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = mesh.receiveShadow = true;
    observatory.add(mesh);
    return mesh;
  };

  // The hub is a complete solid deck. The special launcher handles arrival
  // above it, so the chamber never needs a visible hole or access shaft.
  addDeckBox(0, floorY - 0.35, 0, 40, 0.7, 40);

  // Monumental orbital paths surround the platform without entering the
  // 40x40 walkable square. Their different planes make the hub feel suspended
  // inside a much larger celestial mechanism rather than fenced in.
  const orbitRoot = new THREE.Group();
  orbitRoot.position.y = floorY + 7;
  observatory.add(orbitRoot);
  const orbitMaterial = new THREE.MeshBasicMaterial({
    color: 0x7be5ff, transparent: true, opacity: 0.78,
    depthWrite: false, fog: false, toneMapped: false,
  });
  const orbitSpecs = [
    { radius: 31, tube: 0.18, rot: [Math.PI / 2, 0, 0] },
    { radius: 42, tube: 0.2, rot: [Math.PI / 2 + 0.3, 0.18, 0.12] },
    { radius: 53, tube: 0.24, rot: [Math.PI / 2 - 0.24, -0.3, -0.16] },
  ];
  for (const spec of orbitSpecs) {
    const orbit = new THREE.Mesh(
      new THREE.TorusGeometry(spec.radius, spec.tube, 8, 128),
      orbitMaterial.clone(),
    );
    orbit.rotation.set(...spec.rot);
    orbitRoot.add(orbit);
  }

  // Keep the asteroid dressing high above the whole station so all four
  // destination marquees retain permanently clear sightlines.
  for (let i = 0; i < 12; i++) {
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.7 + rnd() * 1.7, 0),
      mat(0x34334f, { roughness: 0.9, metalness: 0.04 }));
    rock.position.set(-46 + rnd() * 92, floorY + 38 + rnd() * 28, -46 + rnd() * 92);
    rock.rotation.set(rnd() * Math.PI, rnd() * Math.PI, rnd() * Math.PI);
    observatory.add(rock);
  }
  const doorSpecs = [
    {
      id: 'asteroids', name: 'ASTEROID BELT', color: 0x8fb8d8, frame: 'asteroids', marquee: 'asteroids',
      x: 0, z: -19.2, horiz: true, yaw: 0, portalX: 0, portalZ: -19.02, triggerX: 0, triggerZ: -17.7,
    },
    {
      id: 'prism', name: 'PRISM RUN', color: 0x9a6fe0, frame: 'sanctum', marquee: 'sanctum',
      x: -19.2, z: 0, horiz: false, yaw: Math.PI / 2,
      portalX: -19.02, portalZ: 0, triggerX: -17.7, triggerZ: 0,
    },
    {
      id: 'bloom', name: 'INFINITE BLOOM', color: 0xcfff2c, frame: 'canopy', marquee: 'canopy',
      x: 19.2, z: 0, horiz: false, yaw: -Math.PI / 2,
      portalX: 19.02, portalZ: 0, triggerX: 17.7, triggerZ: 0,
    },
    {
      id: 'solar', name: 'SOLAR FLARE', color: 0xff8a24, frame: 'arena', marquee: 'solar',
      x: 0, z: 19.2, horiz: true, yaw: Math.PI,
      portalX: 0, portalZ: 19.02, triggerX: 0, triggerZ: 17.7,
    },
  ];
  for (const door of doorSpecs) {
    addAtriumGateBrickFrame(scene, world, door.frame, door.color,
      door.x, door.z, door.horiz, floorY, observatory);
    if (door.id === 'bloom') {
      addBloomFacePortal(scene, world, door.portalX, floorY + 3.7, door.portalZ,
        6.2, 7.6, door.yaw, observatory);
    } else {
      addMagicPortal(scene, world, door.portalX, floorY + 3.7, door.portalZ,
        6.2, 7.6, door.color, door.yaw, observatory);
    }
    const marquee = addAtriumMarquee(scene, door.marquee, door.name, door.color,
      door.x, floorY + 10.35, door.z, door.yaw, 15.5);
    observatory.add(marquee);
    const light = new THREE.PointLight(door.color, 16, 18);
    light.position.set(
      door.portalX + Math.sin(door.yaw) * 2.5,
      floorY + 4,
      door.portalZ + Math.cos(door.yaw) * 2.5,
    );
    observatory.add(light);
    world.portals.push({
      x: door.triggerX, y: floorY, z: door.triggerZ,
      radius: 2.45, map: door.id, name: door.name,
    });
  }

  // The plate deliberately reads as a slightly raised patch of lawn rather
  // than a glowing mission button. Orange corner hardware rewards a closer look.
  const plateBase = addBox(scene, world, 0, 0.19, 12, 5.4, 0.18, 3.6, 0x33445c, {
    collide: false, emissive: 0x10263c, emissiveIntensity: 0.35,
  });
  const plateGrass = addBox(scene, world, 0, 0.305, 12, 5, 0.08, 3.2, 0x4d8e3f, {
    tex: 'atrium-grass', repeat: [1, 1], collide: false, shadow: false,
    emissive: 0x102808, emissiveIntensity: 0.12,
  });
  for (const x of [-2.38, 2.38]) for (const z of [10.48, 13.52]) {
    addBox(scene, world, x, 0.37, z, 0.22, 0.12, 0.22, 0xff8a2b, {
      collide: false, shadow: false, emissive: 0x8a2600, emissiveIntensity: 1.2,
    });
  }

  const launch = addJumpPad(scene, world, 0, 0.55, 0, 95, 0, 0, 0x65e8ff, true);
  launch.pad.disabled = true;
  launch.base.visible = launch.disc.visible = false;
  const mechanism = {
    activated: false, phase: 'closed', progress: 0, openTimer: 0,
    plateArmed: true, inHub: false, boosting: false,
    transit: null, transportPlayer: null, transportAnchor: null,
    plate: { x: 0, z: 12, radius: 2.35 },
  };
  world.secretFountainMechanism = mechanism;
  world.finishSecretTransit = (direction) => {
    const player = mechanism.transportPlayer;
    if (!player || mechanism.transit !== direction) return;
    if (direction === 'outbound') {
      mechanism.inHub = true;
      observatory.visible = true;
      // The rush ejects the player above and slightly behind the platform.
      // Ordinary gravity completes the visible landing arc.
      player.pos.set(0, floorY + 18, 11);
      player.vel.set(0, -2, -6);
      world.onSecretObservatoryArrival?.();
    } else {
      mechanism.inHub = false;
      observatory.visible = false;
      // Reverse transit ends above the atrium, leaving the final drop physical.
      player.pos.set(0, 32, 9);
      player.vel.set(0, -14, 0);
      world.onSecretAtriumReturn?.();
    }
    mechanism.boosting = false;
    mechanism.transit = null;
    mechanism.transportPlayer = null;
    mechanism.transportAnchor = null;
  };
  world.anim.push((dt, t, characters) => {
    const player = characters.find(ch => ch.isPlayer && ch.alive);
    const onPlate = !!player && Math.abs(player.pos.y) < 2 &&
      Math.hypot(player.pos.x, player.pos.z - 12) < mechanism.plate.radius;
    if (!onPlate && mechanism.phase === 'closed') mechanism.plateArmed = true;
    if (mechanism.phase === 'closed' && mechanism.plateArmed && onPlate) {
      mechanism.activated = true;
      mechanism.plateArmed = false;
      mechanism.phase = 'opening';
      world.onSecretFountainReveal?.();
    }

    if (mechanism.phase === 'opening') {
      mechanism.progress = Math.min(1, mechanism.progress + dt * 0.9);
      if (mechanism.progress >= 1) {
        mechanism.phase = 'open';
        mechanism.openTimer = 5;
      }
    } else if (mechanism.phase === 'open') {
      mechanism.openTimer -= dt;
      if (mechanism.openTimer <= 0) mechanism.phase = 'closing';
    } else if (mechanism.phase === 'closing') {
      mechanism.progress = Math.max(0, mechanism.progress - dt * 1.15);
      if (mechanism.progress <= 0) {
        mechanism.phase = 'closed';
        mechanism.activated = false;
      }
    }

    const p = mechanism.progress;
    const eased = p * p * (3 - 2 * p);
    // Stop just shy of a perfectly flat 180-degree fold. At exactly PI the
    // fountain's side faces become coplanar with the pool-side geometry and
    // z-fight; 98% remains visually retracted without sharing that plane.
    fountain.rotation.z = eased * Math.PI * 0.98;
    fountain.position.y = -0.35 * eased;
    plateBase.position.y = 0.19 - eased * 0.1;
    plateGrass.position.y = 0.305 - eased * 0.1;
    const padVisible = mechanism.phase !== 'closing' && mechanism.phase !== 'closed' && p > 0.38;
    launch.base.visible = launch.disc.visible = padVisible;
    launch.pad.disabled = !padVisible || p <= 0.72;

    if (!mechanism.inHub && !mechanism.transit && !mechanism.boosting && player && player.vel.y > 80 &&
        Math.hypot(player.pos.x, player.pos.z) < 2.2) {
      mechanism.boosting = true;
    }
    if (mechanism.boosting && !mechanism.transit && player) {
      // Engine gravity is still active, so this produces a genuinely
      // accelerating launch rather than a constant-speed scripted lift.
      player.vel.y += 130 * dt;
      player.vel.x *= Math.max(0, 1 - dt * 4);
      player.vel.z *= Math.max(0, 1 - dt * 4);
      if (player.pos.y >= 140) {
        mechanism.boosting = false;
        mechanism.transit = 'outbound';
        mechanism.transportPlayer = player;
        mechanism.transportAnchor = player.pos.clone();
        player.vel.set(0, 0, 0);
        world.onSecretTransit?.('outbound');
      }
    } else if (mechanism.inHub && !mechanism.transit && player && player.pos.y < floorY - 22) {
      mechanism.transit = 'inbound';
      mechanism.transportPlayer = player;
      mechanism.transportAnchor = player.pos.clone();
      player.vel.set(0, 0, 0);
      world.onSecretTransit?.('inbound');
    }
    if (mechanism.transit && mechanism.transportPlayer) {
      mechanism.transportPlayer.pos.copy(mechanism.transportAnchor);
      mechanism.transportPlayer.vel.set(0, 0, 0);
    }
    observatory.visible = mechanism.inHub;
    orbitRoot.rotation.y += dt * 0.012;
  });
}

function addWaterfall(scene, world, x, z, w, h, bottomY, topY, flowZ = 0, style = {}) {
  const flowsAlongX = style.axis === 'x';
  const worldPosition = (across, y, outward) => flowsAlongX
    ? new THREE.Vector3(x + outward, y, z + across)
    : new THREE.Vector3(x + across, y, z + outward);
  if (!style.passThrough) {
    world.waterfallZones ||= [];
    world.waterfallZones.push({
      minX: flowsAlongX ? x - 1.35 : x - w / 2,
      maxX: flowsAlongX ? x + 1.35 : x + w / 2,
      minZ: flowsAlongX ? z - w / 2 : z - 1.35,
      maxZ: flowsAlongX ? z + w / 2 : z + 1.35,
      minY: bottomY - 0.4, maxY: topY + 0.4,
    });
  }

  if (!style.skipLip) {
    addBox(
      scene, world,
      x + (flowsAlongX ? flowZ * 0.5 : 0), topY + 0.3,
      z + (flowsAlongX ? 0 : flowZ * 0.5),
      flowsAlongX ? 1.2 : w + 1.4, 0.6, flowsAlongX ? w + 1.4 : 1.2,
      style.lipColor ?? 0x4a7a52, { tex: style.lipTex ?? 'rock', repeat: [2, 1] },
    );
  }
  const streams = [];
  for (const [across, outward, ww, opacity, phase] of [
    [0, 0, w, 0.7, 0],
    [-w * 0.18, flowZ * 0.2, w * 0.34, 0.46, 1.7],
    [w * 0.2, flowZ * 0.36, w * 0.28, 0.38, 3.1],
  ]) {
    const n = waterNormalTex().clone();
    n.needsUpdate = true;
    n.repeat.set(Math.max(1, ww / 3), Math.max(3, h / 3.2));
    const m = new THREE.Mesh(new THREE.PlaneGeometry(ww, h),
      new THREE.MeshStandardMaterial({
        color: 0x55d8ff, transparent: true, opacity, roughness: 0.12,
        metalness: 0.02, normalMap: n, normalScale: new THREE.Vector2(0.45, 1.55),
        emissive: 0x0b5f86, emissiveIntensity: 0.36, depthWrite: false,
        side: THREE.DoubleSide,
      }));
    if (flowsAlongX) m.rotation.y = Math.PI / 2;
    m.position.copy(worldPosition(across, (bottomY + topY) / 2, outward));
    scene.add(m);
    streams.push({ n, m, phase });
  }
  world.anim.push((dt, t) => {
    for (const s of streams) {
      s.n.offset.set(Math.sin(t * 1.6 + s.phase) * 0.025, t * 2.1 + s.phase);
      s.m.material.opacity = s.m.material.opacity * 0.92 + (0.42 + Math.sin(t * 5 + s.phase) * 0.1) * 0.08;
    }
  });

  const impactRings = [];
  for (let i = 0; i < 4; i++) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.24, 0.34, 14),
      new THREE.MeshBasicMaterial({
        color: 0xf2feff, transparent: true, opacity: 0.5,
        depthWrite: false, side: THREE.DoubleSide,
      }));
    ring.rotation.x = -Math.PI / 2;
    scene.add(ring);
    impactRings.push({
      ring,
      across: (Math.random() - 0.5) * w * 0.82,
      outward: (Math.random() - 0.5) * 0.75 + flowZ * 0.35,
      phase: i / 4,
    });
  }

  const bubbles = [];
  for (let i = 0; i < Math.max(20, Math.ceil(w * 2.4)); i++) {
    const p = new THREE.Mesh(new THREE.SphereGeometry(0.055 + Math.random() * 0.09, 7, 5),
      new THREE.MeshBasicMaterial({
        color: i % 4 === 0 ? 0xffffff : 0xd8fbff,
        transparent: true, opacity: 0.82, depthWrite: false,
      }));
    scene.add(p);
    const outwardZ = (Math.random() < 0.5 ? -1 : 1) * (0.45 + Math.random() * 1.35);
    bubbles.push({
      p,
      across: (Math.random() - 0.5) * w * 0.92,
      acrossSpeed: (Math.random() - 0.5) * 1.15,
      outwardSpeed: flowZ === 0 ? outwardZ : flowZ * (0.55 + Math.random() * 1.15) + outwardZ * 0.25,
      phase: Math.random(),
      dur: 0.72 + Math.random() * 0.62,
      bounce: 1.75 + Math.random() * 1.25,
    });
  }
  world.anim.push((dt, t) => {
    for (const r of impactRings) {
      const k = (t * 0.72 + r.phase) % 1;
      r.ring.position.copy(worldPosition(r.across, bottomY + 0.075, r.outward));
      r.ring.rotation.z = flowsAlongX ? Math.PI / 2 : 0;
      r.ring.scale.set(0.7 + k * 4.3, 0.42 + k * 1.9, 1);
      r.ring.material.opacity = 0.48 * (1 - k) * (1 - k);
    }
    for (const b of bubbles) {
      const k = ((t / b.dur) + b.phase) % 1;
      // Repeated absolute-sine arcs create two or three visibly damped bounces.
      const hop = Math.abs(Math.sin(k * Math.PI * b.bounce)) * (1 - k) * 0.72;
      b.p.position.copy(worldPosition(
        b.across + b.acrossSpeed * k,
        bottomY + 0.1 + hop,
        flowZ * 0.35 + b.outwardSpeed * k,
      ));
      b.p.material.opacity = Math.min(1, k * 8) * 0.82 * (1 - k);
      const squash = hop < 0.08 ? 0.72 : 1;
      b.p.scale.set(1 + k * 0.65, squash * (1 + k * 0.35), 1 + k * 0.65);
    }
  });
}

function addCanalAlligator(scene, world) {
  const BITE_DURATION = 0.7;
  const PROVOKED_CHASE_DURATION = 4.5;
  const AMBIENT_CHASE_DURATION = 3.25;
  const DISENGAGE_DURATION = 3;
  const gator = new THREE.Group();
  gator.name = 'fortress-canal-alligator';

  const hide = mat(0x496522, {
    tex: 'crocodile-scales', repeat: [2.2, 1.35], roughness: 0.92, flatShading: true,
  });
  const belly = mat(0x91a64a, {
    tex: 'crocodile-scales', repeat: [2.6, 1.65], roughness: 0.95, flatShading: true,
  });
  const tooth = new THREE.MeshBasicMaterial({ color: 0xf3edc8, toneMapped: false });
  const eye = new THREE.MeshBasicMaterial({ color: 0xffd83d, toneMapped: false });
  const mouth = new THREE.MeshBasicMaterial({ color: 0x4f1618, toneMapped: false });

  const body = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.72, 1.2), hide);
  body.scale.z = 0.82;
  const back = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.22, 0.78), belly);
  back.position.set(-0.25, 0.43, 0);
  const head = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.62, 1.05), hide);
  head.position.set(2.05, 0.02, 0);
  // Both jaws pivot at the back of the mouth. Moving the upper jaw as well as
  // the lower one keeps the attack readable above the canal waterline.
  const upperJawPivot = new THREE.Group();
  upperJawPivot.position.set(2.5, 0.04, 0);
  const upperJaw = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.25, 0.88), hide);
  upperJaw.position.x = 0.68;
  upperJawPivot.add(upperJaw);
  const lowerJawPivot = new THREE.Group();
  lowerJawPivot.position.set(2.5, -0.11, 0);
  const lowerJaw = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.18, 0.82), belly);
  lowerJaw.position.x = 0.66;
  const mouthInterior = new THREE.Mesh(new THREE.BoxGeometry(1.18, 0.035, 0.7), mouth);
  mouthInterior.position.set(0.68, 0.105, 0);
  lowerJawPivot.add(lowerJaw, mouthInterior);

  // Keep the tail mesh offset behind a joint at the back of the body. Animating
  // the joint (rather than the mesh itself) makes the tail swing from its base.
  const tailPivot = new THREE.Group();
  tailPivot.position.set(-1.82, -0.02, 0);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.55, 3.1, 6), hide);
  tail.rotation.z = Math.PI / 2;
  tail.position.set(-1.55, 0, 0);
  tailPivot.add(tail);
  gator.add(body, back, head, upperJawPivot, lowerJawPivot, tailPivot);

  for (const z of [-0.38, 0.38]) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.09, 6, 4), eye);
    e.position.set(2.48, 0.38, z);
    gator.add(e);
    for (const x of [2.78, 3.12, 3.46]) {
      const fang = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.18, 5), tooth);
      fang.position.set(x - upperJawPivot.position.x, -0.15, z * 0.88);
      fang.rotation.z = Math.PI;
      upperJawPivot.add(fang);
    }
  }

  gator.position.set(-28, -2.92, 2.2);
  scene.add(gator);

  const state = {
    heading: V(1, 0, 0),
    patrolDir: 1,
    biteCooldowns: new WeakMap(),
    snapT: 0,
    biteArmed: false,
    chompPlayed: false,
    biteTarget: null,
    chaseTarget: null,
    chaseT: 0,
    provokedTarget: null,
    lungeT: 0,
    lungeCooldown: 0,
  };
  const disengageFrom = (target, cooldown = 0) => {
    if (!target) return;
    if (cooldown > 0) {
      state.biteCooldowns.set(
        target,
        Math.max(state.biteCooldowns.get(target) || 0, cooldown),
      );
    }
    if (state.chaseTarget === target) {
      state.chaseTarget = null;
      state.chaseT = 0;
      state.lungeT = 0;
    }
    if (state.provokedTarget === target) state.provokedTarget = null;
  };
  // The body is a moving solid surface. Deliberately stop it before the head so
  // the rideable area is the back, not the snapping mouth.
  const bodyCollider = {
    type: 'box',
    dynamic: true,
    min: V(),
    max: V(),
  };
  world.colliders.push(bodyCollider);
  const localToGator = ch => {
    const dx = ch.pos.x - gator.position.x;
    const dz = ch.pos.z - gator.position.z;
    return {
      x: dx * state.heading.x + dz * state.heading.z,
      z: -dx * state.heading.z + dz * state.heading.x,
    };
  };
  const isOnGatorBack = ch => {
    if (!ch?.alive) return false;
    const local = localToGator(ch);
    const relativeY = ch.pos.y - gator.position.y;
    return local.x > -1.78 && local.x < 1.36 && Math.abs(local.z) < 0.72 &&
      relativeY > 0.38 && relativeY < 2.15;
  };
  // Capsule-vs-oriented-mouth test. Damage is permitted only while the jaws
  // are closing and this volume actually intersects a character capsule.
  const mouthHits = ch => {
    if (!ch?.alive) return false;
    const local = localToGator(ch);
    const radius = ch.radius ?? 0.45;
    const height = ch.height ?? 1.8;
    const minX = 2.48, maxX = 3.88;
    const minY = -0.2, maxY = 0.3;
    const minZ = -0.52, maxZ = 0.52;
    for (const sy of [radius, height * 0.5, height - radius]) {
      const localY = ch.pos.y + sy - gator.position.y;
      const dx = local.x - THREE.MathUtils.clamp(local.x, minX, maxX);
      const dy = localY - THREE.MathUtils.clamp(localY, minY, maxY);
      const dz = local.z - THREE.MathUtils.clamp(local.z, minZ, maxZ);
      if (dx * dx + dy * dy + dz * dz <= radius * radius) return true;
    }
    return false;
  };
  const updateBodyCollider = () => {
    const halfLength = 1.72;
    const halfWidth = 0.58;
    const centerOffset = -0.16;
    const cx = gator.position.x + state.heading.x * centerOffset;
    const cz = gator.position.z + state.heading.z * centerOffset;
    const ex = Math.abs(state.heading.x) * halfLength + Math.abs(state.heading.z) * halfWidth;
    const ez = Math.abs(state.heading.z) * halfLength + Math.abs(state.heading.x) * halfWidth;
    bodyCollider.min.set(cx - ex, gator.position.y - 0.38, cz - ez);
    bodyCollider.max.set(cx + ex, gator.position.y + 0.55, cz + ez);
  };
  updateBodyCollider();
  const shootTarget = {
    kind: 'canal-gator',
    pos: gator.position,
    radius: 3.1,
    receivesSplash: true,
    onHit(attacker) {
      if (!attacker?.alive) return;
      state.biteCooldowns.set(attacker, 0);
      state.provokedTarget = attacker;
      state.chaseTarget = attacker;
      state.chaseT = PROVOKED_CHASE_DURATION;
      state.snapT = 0;
      state.biteArmed = false;
      state.biteTarget = null;
      state.lungeT = 0.75;
      state.lungeCooldown = 0;
    },
  };
  world.gator = { group: gator, state, shootTarget };
  const canalWater = (world.waterZones || []).find(zone =>
    gator.position.x >= zone.minX && gator.position.x <= zone.maxX &&
    gator.position.z >= zone.minZ && gator.position.z <= zone.maxZ);
  world.anim.push((dt, t, characters = []) => {
    // Tick existing immunity before detection so a newly bitten character gets
    // the complete three-second ignore window.
    for (const ch of characters) {
      const cooldown = state.biteCooldowns.get(ch);
      if (cooldown > 0) state.biteCooldowns.set(ch, Math.max(0, cooldown - dt));
    }
    // Capture riders relative to the old pose so turning carries them as well
    // as straight-line motion.
    const riders = [];
    for (const ch of characters) {
      if (!isOnGatorBack(ch)) continue;
      const local = localToGator(ch);
      riders.push({ ch, ...local, y: ch.pos.y - gator.position.y });
    }
    // Sight and hearing aggro only exist inside the registered canal water
    // volume. Characters on either bank, a bridge, or the gator's back are
    // ignored unless they explicitly provoke it by shooting.
    const inCanalWater = ch => {
      if (!ch?.alive || !canalWater || isOnGatorBack(ch)) return false;
      const midY = ch.pos.y + (ch.height ?? 1.8) * 0.5;
      return ch.pos.x >= canalWater.minX && ch.pos.x <= canalWater.maxX &&
        ch.pos.z >= canalWater.minZ && ch.pos.z <= canalWater.maxZ &&
        midY >= (canalWater.bottomY ?? canalWater.surfaceY - 4) - 0.4 &&
        ch.pos.y < canalWater.surfaceY + 0.35;
    };
    let nearbyTarget = null;
    let nearbyDist = Infinity;
    for (const ch of characters) {
      if (!inCanalWater(ch)) continue;
      // A bitten character gets a real escape window: the gator will not
      // reacquire them until this cooldown expires.
      if ((state.biteCooldowns.get(ch) || 0) > 0) continue;
      const dx = ch.pos.x - gator.position.x;
      const dz = ch.pos.z - gator.position.z;
      const d = Math.hypot(dx, dz);
      // Sight works across the forward half-plane whether the target moves or
      // not. Hearing covers every direction, but only moving characters make
      // enough noise to be detected.
      const inFront = d > 0 && (dx * state.heading.x + dz * state.heading.z) / d >= 0;
      const moving = Math.hypot(ch.vel?.x || 0, ch.vel?.z || 0) > 0.35;
      const detected = d < 10 && (inFront || moving);
      if (d < nearbyDist && detected) { nearbyTarget = ch; nearbyDist = d; }
    }
    if (state.chaseTarget) {
      state.chaseT = Math.max(0, state.chaseT - dt);
      if (!state.chaseTarget.alive) {
        disengageFrom(state.chaseTarget);
      } else if (state.chaseT <= 0 && !state.biteArmed) {
        // Let a bite already in progress finish, but do not pursue forever.
        disengageFrom(state.chaseTarget, DISENGAGE_DURATION);
      }
    }
    if (!state.chaseTarget && nearbyTarget &&
      (state.biteCooldowns.get(nearbyTarget) || 0) <= 0) {
      state.provokedTarget = null;
      state.chaseTarget = nearbyTarget;
      state.chaseT = AMBIENT_CHASE_DURATION;
    }

    let target = state.chaseTarget;
    let targetDist = Infinity;
    if (target) {
      const provoked = state.provokedTarget === target;
      if ((!provoked && !inCanalWater(target)) || (state.biteCooldowns.get(target) || 0) > 0) {
        disengageFrom(target);
        target = null;
      }
    }
    if (target) {
      targetDist = Math.hypot(target.pos.x - gator.position.x, target.pos.z - gator.position.z);
      // The gator gives up after a short pursuit or if the target gets well
      // beyond the canal encounter instead of chasing forever across the map.
      if (targetDist > 18 && state.provokedTarget !== target) {
        disengageFrom(target, DISENGAGE_DURATION);
        target = null;
      }
    }

    const desired = V(state.patrolDir, 0, Math.sin(t * 0.55) * 0.36);
    let speed = 2.9;
    state.lungeCooldown = Math.max(0, state.lungeCooldown - dt);
    if (target) {
      desired.set(target.pos.x - gator.position.x, 0, target.pos.z - gator.position.z).normalize();
      // Distances are measured from the gator's centre; its mouth projects
      // about 3.5m forward. Begin the burst and open the jaws at ~3m from the
      // mouth so the full wind-up remains visible on the final approach.
      if (targetDist < 6.5 && state.lungeCooldown <= 0) {
        state.lungeT = 0.75;
        state.lungeCooldown = 1.8;
      }
      state.lungeT = Math.max(0, state.lungeT - dt);
      speed = state.provokedTarget === target || state.lungeT > 0
        ? 12.5
        : (targetDist < 5.5 ? 6.2 : 4);
      const cooldown = state.biteCooldowns.get(target) || 0;
      if (targetDist < 6.5 && cooldown <= 0 && state.snapT <= 0) {
        state.snapT = BITE_DURATION;
        state.biteArmed = true;
        state.chompPlayed = false;
        state.biteTarget = target;
      }
    } else state.lungeT = 0;

    state.heading.lerp(desired, Math.min(1, dt * (state.lungeT > 0 ? 8 : 2.8))).normalize();
    gator.position.addScaledVector(state.heading, speed * dt);
    // The end ramps begin at |x|=55. Keeping the body center inside 51 leaves
    // room for the long snout and tail, so no part of the gator clips through.
    if (gator.position.x > 50.5) state.patrolDir = -1;
    else if (gator.position.x < -50.5) state.patrolDir = 1;
    gator.position.x = THREE.MathUtils.clamp(gator.position.x, -51, 51);
    gator.position.z = THREE.MathUtils.clamp(gator.position.z, -5.15, 5.15);
    gator.rotation.y = Math.atan2(-state.heading.z, state.heading.x);
    gator.position.y = -2.92 + Math.sin(t * 3.2) * 0.05;

    for (const rider of riders) {
      rider.ch.pos.x = gator.position.x + state.heading.x * rider.x - state.heading.z * rider.z;
      rider.ch.pos.z = gator.position.z + state.heading.z * rider.x + state.heading.x * rider.z;
      rider.ch.pos.y = gator.position.y + rider.y;
    }
    updateBodyCollider();

    state.snapT = Math.max(0, state.snapT - dt);
    const biteProgress = state.snapT > 0 ? 1 - state.snapT / BITE_DURATION : 1;
    // Open quickly, then close immediately while the gator carries full lunge
    // speed through the target. There is no pause or escape-speed dip.
    const jawOpen = state.snapT <= 0 ? 0 : biteProgress < 0.35
      ? biteProgress / 0.35
      : Math.max(0, 1 - (biteProgress - 0.35) / 0.65);
    upperJawPivot.rotation.z = 0.48 * jawOpen;
    lowerJawPivot.rotation.z = -0.82 * jawOpen;
    if (state.biteArmed && biteProgress >= 0.35 && !state.chompPlayed) {
      state.chompPlayed = true;
      world.onGatorChomp?.();
    }
    // The second half of the animation is the closing stroke. Check the actual
    // mouth against every character so proximity alone can never cause damage.
    if (state.biteArmed && biteProgress >= 0.35) {
      for (const ch of characters) {
        if ((state.biteCooldowns.get(ch) || 0) > 0 || !mouthHits(ch)) continue;
        // After landing a bite, ignore this victim for a full three seconds so
        // they have a real chance to escape before pursuit can resume.
        state.biteCooldowns.set(ch, 3);
        world.onGatorBite?.(ch);
        disengageFrom(state.chaseTarget || ch, DISENGAGE_DURATION);
        state.biteArmed = false;
        state.biteTarget = null;
        break;
      }
      if (biteProgress >= 0.94 && state.biteArmed) {
        // One complete closing stroke counts as a fair attack opportunity.
        // Whether it lands or misses, the gator breaks off instead of chaining
        // bite attempts forever.
        const attemptedTarget = state.biteTarget;
        state.biteArmed = false;
        state.biteTarget = null;
        disengageFrom(attemptedTarget, DISENGAGE_DURATION);
      }
    }
    tailPivot.rotation.y = Math.sin(t * 5.5) * 0.18;
  });
}

function addJumpPad(scene, world, x, y, z, vy, vx = 0, vz = 0, color = 0x30e0ff, playersOnly = false) {
  const pad = { x, y, z, r: 1.7, vy, vx, vz, playersOnly, disabled: false };
  world.jumpPads.push(pad);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 2.1, 0.3, 20),
    mat(0x223344, { roughness: 0.6 }));
  base.position.set(x, y + 0.15, z);
  base.castShadow = base.receiveShadow = true;
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 0.14, 20),
    mat(color, { emissive: color, emissiveIntensity: 1.6, roughness: 0.4 }));
  disc.position.set(x, y + 0.34, z);
  scene.add(base, disc);
  world.anim.push((dt, t) => {
    disc.position.y = y + 0.34 + Math.abs(Math.sin(t * 3)) * 0.12;
    disc.material.emissiveIntensity = 1.2 + Math.sin(t * 6) * 0.6;
  });
  return { pad, base, disc };
}

function addVine(scene, world, x, z, y0, y1, r = 0.9, leanX = 0, leanZ = 0, exitX = 0, exitZ = 0, visualTopPad = 0.16, visualWidth = null, vineColor = 0x5fc84d, visualStyle = 'sheet') {
  const zone = { x, z, minY: Math.min(y0, y1), maxY: Math.max(y0, y1), r, grabR: Math.max(r, 1.28) };
  const exitLen = Math.hypot(exitX, exitZ);
  if (exitLen > 0.001) {
    zone.exitX = exitX / exitLen;
    zone.exitZ = exitZ / exitLen;
  }
  (world.vineZones ||= []).push(zone);
  const h = Math.abs(y1 - y0);
  const bottomY = Math.min(y0, y1);
  const topY = Math.max(y0, y1);
  const leanLen = Math.hypot(leanX, leanZ);
  // The visible sheet belongs on the exposed face selected by leanX/leanZ.
  // exitX/exitZ points the climber back onto the landing and is often the
  // exact opposite direction; using it for visuals tucked vines underneath
  // roof overhangs even though their climb volume was correctly outside.
  const hookX = leanLen > 0.001 ? leanX / leanLen : (zone.exitX ?? 1);
  const hookZ = leanLen > 0.001 ? leanZ / leanLen : (zone.exitZ ?? 0);
  const visualTopY = topY - Math.min(visualTopPad, h * 0.18);
  const visualBottomY = bottomY + Math.min(0.04, h * 0.02);

  // Hades uses the same forgiving climb volume but replaces the bright flat
  // sheet with a crooked volcanic root. The root stays within the zone radius,
  // so it reads as attached geology without becoming an uncollided solid pole.
  if (visualStyle === 'magma-root') {
    const points = [];
    const pointCount = Math.max(4, Math.min(8, Math.ceil(h / 5)));
    for (let i = 0; i <= pointCount; i++) {
      const t = i / pointCount;
      const fade = Math.sin(Math.PI * t);
      points.push(V(
        x + leanX * t + Math.sin(t * 8.7 + x * 0.11 + z * 0.07) * 0.32 * fade,
        THREE.MathUtils.lerp(visualBottomY, visualTopY, t),
        z + leanZ * t + Math.cos(t * 7.9 + z * 0.09) * 0.28 * fade,
      ));
    }
    const rootGeometries = [];
    const up = V(0, 1, 0);
    for (let i = 0; i < points.length - 1; i++) {
      const delta = points[i + 1].clone().sub(points[i]);
      const geometry = new THREE.CylinderGeometry(
        THREE.MathUtils.lerp(0.70, 0.34, (i + 1) / pointCount),
        THREE.MathUtils.lerp(0.82, 0.40, i / pointCount),
        delta.length(), 7, 1, false,
      );
      geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, delta.clone().normalize()));
      geometry.translate(
        (points[i].x + points[i + 1].x) / 2,
        (points[i].y + points[i + 1].y) / 2,
        (points[i].z + points[i + 1].z) / 2,
      );
      rootGeometries.push(geometry);
    }
    const rootGeometry = mergeGeometries(rootGeometries, false);
    if (rootGeometry) {
      const root = new THREE.Mesh(rootGeometry, mat(0x69291e, {
        tex: 'olympus-rock', repeat: [1, Math.max(1, h / 5)], roughness: 0.96,
        emissive: 0x8a0d06, emissiveIntensity: 0.42, flatShading: true,
      }));
      root.castShadow = false;
      root.receiveShadow = true;
      scene.add(root);
    }
    rootGeometries.forEach(geometry => geometry.dispose());
    return;
  }
  const vineTex = canvasTex('vine-sheet', (g) => {
    g.clearRect(0, 0, 128, 256);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 8; x++) {
        const keep = ((x * 7 + y * 5) % 11) < 8 || (x > 2 && x < 5);
        if (!keep) continue;
        const hue = 80 + ((x * 13 + y * 17) % 42);
        const shade = 58 + ((x * 19 + y * 11) % 28);
        g.fillStyle = `hsl(${hue}, ${shade}%, ${26 + ((x + y) % 4) * 6}%)`;
        g.fillRect(x * 16, y * 16, 18, 18);
      }
    }
    g.strokeStyle = 'rgba(20,90,18,.7)';
    g.lineWidth = 4;
    for (let x = 16; x < 128; x += 28) {
      g.beginPath();
      g.moveTo(x, 0);
      for (let y = 0; y <= 256; y += 24) g.lineTo(x + Math.sin(y * 0.08 + x) * 7, y);
      g.stroke();
    }
  });
  const map = vineTex.clone();
  map.repeat.set(1, Math.max(1, h / 4));
  map.needsUpdate = true;
  const themedVine = vineColor !== 0x5fc84d;
  const matVine = new THREE.MeshStandardMaterial({
    map, color: vineColor, roughness: 0.95, metalness: 0,
    transparent: false, alphaTest: 0.34, side: THREE.DoubleSide,
    depthWrite: true,
    emissive: themedVine ? vineColor : 0x0b2a0f,
    emissiveIntensity: themedVine ? 0.34 : 0.04,
  });
  const quat = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(hookX, 0, hookZ).normalize(),
  );
  const stripH = Math.max(0.7, visualTopY - visualBottomY);
  const width = visualWidth ?? Math.max(0.95, Math.min(1.45, zone.grabR * 1.05));
  const leaf = new THREE.Mesh(new THREE.PlaneGeometry(width, stripH, 1, Math.max(1, Math.floor(stripH / 1.6))), matVine);
  leaf.quaternion.copy(quat);
  // Keep the sheet visibly on the outside face while the invisible climb zone
  // remains round and forgiving.
  leaf.position.set(
    x + hookX * 0.14,
    visualTopY - stripH / 2,
    z + hookZ * 0.14,
  );
  leaf.castShadow = leaf.receiveShadow = true;
  scene.add(leaf);
}

function addMonorailTrain(scene, world, route, y = 10, speed = 18, dwell = 4) {
  const group = new THREE.Group();
  scene.add(group);
  const boxes = [];
  const doors = [];
  const onboardPowerup = { kind: 'silver', pos: V(0, y + 0.25, 0) };
  world.pickups.push(onboardPowerup);
  const bodyMat = mat(0xd8e2f0, { tex: 'panel', repeat: [3, 1], roughness: 0.38, metalness: 0.28 });
  const glassMat = mat(0x203650, { emissive: 0x30e0ff, emissiveIntensity: 0.35, transparent: true, opacity: 0.82 });
  const trimMat = mat(0xff40a0, { emissive: 0xff40a0, emissiveIntensity: 1.5, roughness: 0.42 });
  const doorMat = mat(0x18273c, {
    emissive: 0x30e0ff, emissiveIntensity: 0.25, roughness: 0.5, metalness: 0.2,
    transparent: true, opacity: 0.78,
  });

  const addPart = (lx, ly, lz, w, h, d, material, collide = true) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(lx, ly, lz);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
    if (!collide) return;
    const collider = { type: 'box', dynamic: true, min: V(0, 0, 0), max: V(0, 0, 0) };
    world.colliders.push(collider);
    boxes.push({ lx, ly, lz, hx: w / 2, hy: h / 2, hz: d / 2, collider });
  };
  const addDoor = (lx, ly, lz, w, h, d, openDir) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), doorMat);
    mesh.position.set(lx, ly, lz);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
    const collider = { type: 'box', dynamic: true, min: V(0, 0, 0), max: V(0, 0, 0) };
    world.colliders.push(collider);
    const door = { lx, ly, lz, hx: w / 2, hy: h / 2, hz: d / 2, collider, mesh, openDir, open: 0 };
    boxes.push(door);
    doors.push(door);
  };

  // local +X is the train's forward axis. Side walls have center door gaps.
  addPart(0, -0.22, 0, 15.5, 0.44, 4.8, bodyMat);          // floor, top at y
  addPart(0, 3.05, 0, 15.5, 0.38, 4.8, bodyMat);           // roof
  for (const z of [-2.25, 2.25]) {
    for (const x of [-5.25, 5.25]) {
      addPart(x, 0.55, z, 4.8, 0.8, 0.34, bodyMat);        // lower sill
      addPart(x, 2.72, z, 4.8, 0.52, 0.34, bodyMat);       // upper rail
      addPart(x - 2.25, 1.62, z, 0.32, 1.7, 0.34, bodyMat);
      addPart(x + 2.25, 1.62, z, 0.32, 1.7, 0.34, bodyMat);
      addPart(x, 1.62, z, 3.8, 1.45, 0.22, glassMat);      // side window
    }
    addDoor(-1.25, 1.42, z, 2.5, 2.45, 0.38, -1);
    addDoor(1.25, 1.42, z, 2.5, 2.45, 0.38, 1);
    addPart(0, 2.25, z, 4.2, 0.35, 0.36, glassMat, false); // glowing door header
  }
  addPart(-7.85, 1.42, 0, 0.34, 2.55, 4.8, bodyMat);
  addPart(7.85, 1.42, 0, 0.34, 2.55, 4.8, bodyMat);
  addPart(0, 1.9, -2.47, 12.8, 0.22, 0.18, trimMat, false);
  addPart(0, 1.9, 2.47, 12.8, 0.22, 0.18, trimMat, false);

  const segs = [];
  let total = 0;
  for (let i = 0; i < route.length; i++) {
    const a = route[i], b = route[(i + 1) % route.length];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    segs.push({ a, b, len, start: total, yaw: Math.atan2(a.z - b.z, b.x - a.x) });
    total += len;
  }
  const sample = (dist) => {
    dist = ((dist % total) + total) % total;
    const seg = segs.find(s => dist >= s.start && dist <= s.start + s.len) || segs[segs.length - 1];
    const k = seg.len ? (dist - seg.start) / seg.len : 0;
    return {
      x: seg.a.x + (seg.b.x - seg.a.x) * k,
      z: seg.a.z + (seg.b.z - seg.a.z) * k,
      yaw: seg.yaw,
    };
  };
  const rotate = (x, z, yaw) => ({
    x: Math.cos(yaw) * x + Math.sin(yaw) * z,
    z: -Math.sin(yaw) * x + Math.cos(yaw) * z,
  });
  const setOnboardPowerup = (pos) => {
    const rc = rotate(0, 0, pos.yaw);
    onboardPowerup.pos.set(pos.x + rc.x, y + 0.25, pos.z + rc.z);
  };
  const updateColliders = (pos) => {
    const ca = Math.abs(Math.cos(pos.yaw)), sa = Math.abs(Math.sin(pos.yaw));
    for (const b of boxes) {
      const lx = b.lx + (b.openDir || 0) * (b.open || 0) * 2.8;
      if (b.mesh) b.mesh.position.x = lx;
      const rc = rotate(lx, b.lz, pos.yaw);
      const cx = pos.x + rc.x, cy = y + b.ly, cz = pos.z + rc.z;
      const hx = ca * b.hx + sa * b.hz;
      const hz = sa * b.hx + ca * b.hz;
      b.collider.min.set(cx - hx, cy - b.hy, cz - hz);
      b.collider.max.set(cx + hx, cy + b.hy, cz + hz);
    }
  };
  const inside = (ch, pos) => {
    const dx = ch.pos.x - pos.x, dz = ch.pos.z - pos.z;
    const c = Math.cos(-pos.yaw), s = Math.sin(-pos.yaw);
    const lx = c * dx + s * dz;
    const lz = -s * dx + c * dz;
    const ly = ch.pos.y - y;
    return Math.abs(lx) < 8.4 && Math.abs(lz) < 2.8 && ly > -0.45 && ly < 3.35;
  };
  const carry = (ch, oldPos, newPos) => {
    const dx = ch.pos.x - oldPos.x, dz = ch.pos.z - oldPos.z;
    const c = Math.cos(-oldPos.yaw), s = Math.sin(-oldPos.yaw);
    const lx = c * dx + s * dz;
    const lz = -s * dx + c * dz;
    const rc = rotate(lx, lz, newPos.yaw);
    ch.pos.x = newPos.x + rc.x;
    ch.pos.z = newPos.z + rc.z;
  };

  let prev = sample(0);
  setOnboardPowerup(prev);
  updateColliders(prev);
  world.anim.push((dt, t, characters) => {
    const cycle = total / speed + dwell;
    const phase = t % cycle;
    const opening = Math.min(1, phase / 0.45, (dwell - phase) / 0.45);
    for (const door of doors) door.open = Math.max(0, opening);
    const dist = phase < dwell ? 0 : (phase - dwell) * speed;
    const next = sample(dist);
    for (const ch of characters) {
      if (ch.alive && inside(ch, prev)) carry(ch, prev, next);
    }
    group.position.set(next.x, y, next.z);
    group.rotation.y = next.yaw;
    setOnboardPowerup(next);
    updateColliders(next);
    prev = next;
  });
}

// A real moving platform: the visible cab, its floor collider, and riders all
// share one position source. This prevents the common "working elevator with
// an invisible ledge" failure when a map is rearranged later.
function addCityElevator(scene, world, {
  x, z, bottomY, topY, width = 5.5, depth = 5.5,
  accent = 0x30e0ff, phase = 0,
}) {
  const group = new THREE.Group();
  scene.add(group);
  const bodyMat = mat(0x15142c, { tex: 'panel', repeat: [2, 1], roughness: 0.42, metalness: 0.3 });
  const glowMat = mat(accent, { emissive: accent, emissiveIntensity: 1.8, roughness: 0.35 });
  const floor = new THREE.Mesh(new THREE.BoxGeometry(width, 0.42, depth), bodyMat);
  floor.position.y = -0.21;
  floor.castShadow = floor.receiveShadow = true;
  group.add(floor);
  // Keep both building-facing and street-facing edges open. Corner posts make
  // the moving footprint readable without trapping a rider behind a rail.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.35, 0.18), glowMat);
    post.position.set(sx * (width / 2 - 0.09), 0.57, sz * (depth / 2 - 0.09));
    group.add(post);
  }
  for (const sz of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(width - 0.35, 0.16, 0.18), glowMat);
    rail.position.set(0, 0.86, sz * (depth / 2 - 0.09));
    group.add(rail);
  }
  const collider = { type: 'box', dynamic: true, min: V(), max: V() };
  world.colliders.push(collider);
  const setHeight = y => {
    group.position.set(x, y, z);
    collider.min.set(x - width / 2, y - 0.42, z - depth / 2);
    collider.max.set(x + width / 2, y, z + depth / 2);
  };
  const rideZone = ch => ch.alive &&
    Math.abs(ch.pos.x - x) < width / 2 - 0.15 &&
    Math.abs(ch.pos.z - z) < depth / 2 - 0.15 &&
    ch.pos.y >= group.position.y - 0.5 && ch.pos.y <= group.position.y + 2.2;
  const travel = Math.max(3.5, (topY - bottomY) / 5.2);
  const dwell = 2.4;
  const cycle = dwell * 2 + travel * 2;
  let previousY = bottomY;
  setHeight(previousY);
  world.anim.push((dt, t, characters) => {
    let p = (t + phase) % cycle;
    let y = bottomY;
    if (p < dwell) y = bottomY;
    else if ((p -= dwell) < travel) {
      const k = p / travel;
      y = bottomY + (topY - bottomY) * (k * k * (3 - 2 * k));
    } else if ((p -= travel) < dwell) y = topY;
    else {
      p -= dwell;
      const k = p / travel;
      y = topY - (topY - bottomY) * (k * k * (3 - 2 * k));
    }
    const dy = y - previousY;
    if (Math.abs(dy) > 1e-5) for (const ch of characters) if (rideZone(ch)) ch.pos.y += dy;
    setHeight(y);
    previousY = y;
  });
}

function wp(world, x, y, z) { world.waypoints.push({ pos: V(x, y, z), links: [] }); }
function pk(world, kind, x, y, z, extra = {}) {
  const def = Object.assign({ kind, pos: V(x, y, z) }, extra);
  if (kind === 'points' && (!Number.isFinite(def.amount) || def.amount <= 0)) {
    throw new Error(`[map pickup] points pickup at (${x}, ${y}, ${z}) requires a positive amount`);
  }
  world.pickups.push(def);
}

function baseLighting(scene, skyColor, groundColor, sunDir, shadowHalf) {
  // Directional contrast gives geometry weight; restrained fill preserves texture detail.
  scene.add(new THREE.HemisphereLight(skyColor, groundColor, 2.35));
  scene.add(new THREE.AmbientLight(0xeaf0ff, 0.38));
  const sun = new THREE.DirectionalLight(0xfff5e6, 3.65);
  sun.position.set(...sunDir);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  const c = sun.shadow.camera;
  c.left = -shadowHalf; c.right = shadowHalf; c.top = shadowHalf; c.bottom = -shadowHalf;
  c.near = 10; c.far = 400;
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.6; // kills the jagged acne on large flat surfaces
  scene.add(sun);
  scene.add(sun.target);
  return sun;
}

const arenaLabelCache = new Map();
function arenaLabelTexture(text, accent = '#ff7a2d', style = 'industrial') {
  const key = `${style}:${text}:${accent}`;
  if (arenaLabelCache.has(key)) return arenaLabelCache.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 128;
  const g = canvas.getContext('2d');
  g.textAlign = 'center'; g.textBaseline = 'middle';

  if (style === 'olympus') {
    // Transparent lettering lets the real stone slab and raised metal border
    // beneath this canvas remain visible instead of painting another UI card.
    g.strokeStyle = 'rgba(83,49,24,.82)'; g.lineWidth = 5;
    g.strokeRect(20, 19, 472, 90);
    g.strokeStyle = accent; g.lineWidth = 2;
    for (let x = 28; x <= 484; x += 24) {
      g.beginPath(); g.moveTo(x, 27); g.lineTo(x + 8, 19); g.lineTo(x + 16, 27); g.stroke();
      g.beginPath(); g.moveTo(x, 101); g.lineTo(x + 8, 109); g.lineTo(x + 16, 101); g.stroke();
    }
    g.font = '900 47px Georgia, "Times New Roman", serif';
    g.lineWidth = 7; g.strokeStyle = 'rgba(61,35,19,.95)'; g.strokeText(text, 256, 65, 438);
    g.fillStyle = accent; g.fillText(text, 256, 63, 438);
  } else if (style === 'neon') {
    g.fillStyle = 'rgba(8,4,23,.94)'; g.fillRect(0, 0, 512, 128);
    const gradient = g.createLinearGradient(0, 0, 512, 128);
    gradient.addColorStop(0, 'rgba(255,255,255,.04)');
    gradient.addColorStop(0.5, 'rgba(255,255,255,0)');
    gradient.addColorStop(1, 'rgba(255,255,255,.08)');
    g.fillStyle = gradient; g.fillRect(0, 0, 512, 128);
    g.strokeStyle = accent; g.lineWidth = 5; g.strokeRect(11, 11, 490, 106);
    g.shadowColor = accent; g.shadowBlur = 18;
    g.strokeStyle = accent; g.lineWidth = 4;
    g.beginPath(); g.moveTo(28, 27); g.lineTo(484, 27); g.moveTo(28, 101); g.lineTo(484, 101); g.stroke();
    g.font = '900 49px Arial Black, sans-serif';
    g.lineWidth = 10; g.strokeStyle = 'rgba(0,0,0,.92)'; g.strokeText(text, 256, 66, 446);
    g.lineWidth = 4; g.strokeStyle = accent; g.strokeText(text, 256, 65, 446);
    g.fillStyle = '#fff8ee'; g.fillText(text, 256, 65, 446);
  } else if (style === 'marine') {
    g.fillStyle = '#b7522c'; g.fillRect(0, 0, 512, 128);
    g.fillStyle = 'rgba(18,37,43,.92)'; g.fillRect(28, 18, 456, 92);
    g.fillStyle = accent;
    for (let x = -12; x < 44; x += 16) {
      g.beginPath(); g.moveTo(x, 128); g.lineTo(x + 18, 128); g.lineTo(x + 58, 0); g.lineTo(x + 40, 0); g.closePath(); g.fill();
    }
    g.strokeStyle = '#d17a42'; g.lineWidth = 4; g.strokeRect(27, 17, 458, 94);
    g.fillStyle = '#d2b07a';
    for (const x of [39, 473]) for (const y of [30, 98]) { g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill(); }
    g.font = '900 45px Arial Black, sans-serif';
    g.lineWidth = 8; g.strokeStyle = 'rgba(0,0,0,.8)'; g.strokeText(text, 276, 65, 394);
    g.fillStyle = '#f3e4c1'; g.fillText(text, 276, 64, 394);
  } else if (style === 'hall') {
    g.fillStyle = '#17100d'; g.fillRect(0, 0, 512, 128);
    const gold = g.createLinearGradient(0, 0, 0, 128);
    gold.addColorStop(0, '#fff0a3'); gold.addColorStop(0.48, accent); gold.addColorStop(1, '#87510f');
    g.strokeStyle = gold; g.lineWidth = 8; g.strokeRect(12, 12, 488, 104);
    g.lineWidth = 2; g.strokeRect(24, 23, 464, 82);
    g.font = '900 46px Georgia, "Times New Roman", serif';
    g.lineWidth = 8; g.strokeStyle = '#090504'; g.strokeText(text, 256, 66, 438);
    g.fillStyle = gold; g.fillText(text, 256, 64, 438);
  } else {
    g.fillStyle = '#17222a'; g.fillRect(0, 0, 512, 128);
    g.fillStyle = '#0b1116'; g.fillRect(24, 14, 464, 100);
    g.fillStyle = accent;
    for (let y = -16; y < 144; y += 32) {
      g.beginPath(); g.moveTo(0, y); g.lineTo(18, y + 12); g.lineTo(18, y + 28); g.lineTo(0, y + 16); g.closePath(); g.fill();
    }
    g.fillRect(31, 19, 449, 4); g.fillRect(31, 105, 449, 4);
    g.fillStyle = '#a9bbc5';
    for (const x of [35, 477]) for (const y of [31, 97]) { g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.fill(); }
    g.font = '900 49px Arial Black, sans-serif';
    g.lineWidth = 8; g.strokeStyle = '#020609'; g.strokeText(text, 268, 65, 414);
    g.fillStyle = '#f4f1e8'; g.fillText(text, 268, 64, 414);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.anisotropy = 8;
  arenaLabelCache.set(key, texture);
  return texture;
}

function addArenaSign(
  parent, text, x, y, z, w, h, yaw = 0,
  accent = '#ff7a2d', style = 'industrial', doubleFaced = false,
) {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.rotation.y = yaw;
  group.name = `${style}-environment-sign-${text.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  parent.add(group);

  const styleMaterials = {
    industrial: {
      backing: () => mat(0x27343d, { tex: 'panel', repeat: [Math.max(1, w / 4), 1], roughness: 0.5, metalness: 0.48 }),
      trim: () => mat(new THREE.Color(accent), { roughness: 0.34, metalness: 0.58 }),
    },
    neon: {
      backing: () => mat(0x120b24, { tex: 'neonwall', repeat: [Math.max(1, w / 5), 1], roughness: 0.38, metalness: 0.28 }),
      trim: () => new THREE.MeshBasicMaterial({ color: accent, toneMapped: false }),
    },
    marine: {
      backing: () => mat(0xffffff, { tex: 'tidebreaker-orange-steel', repeat: [Math.max(1, w / 5), 1], roughness: 0.56, metalness: 0.46 }),
      trim: () => mat(0x26383d, { roughness: 0.42, metalness: 0.7 }),
    },
    olympus: {
      backing: () => mat(0xffffff, { tex: 'olympus-aether', repeat: [Math.max(1, w / 5), 1], roughness: 0.58, metalness: 0.05 }),
      trim: () => mat(new THREE.Color(accent), { roughness: 0.3, metalness: 0.68 }),
    },
    hall: {
      backing: () => mat(0x25150f, { tex: 'panel', repeat: [Math.max(1, w / 5), 1], roughness: 0.42, metalness: 0.34 }),
      trim: () => mat(new THREE.Color(accent), { roughness: 0.24, metalness: 0.82 }),
    },
  };
  const signStyle = styleMaterials[style] || styleMaterials.industrial;
  const backingDepth = style === 'olympus' ? 0.5 : 0.32;
  const backing = new THREE.Mesh(
    new THREE.BoxGeometry(w + 0.55, h + 0.48, backingDepth),
    signStyle.backing(),
  );
  backing.position.z = -backingDepth / 2 - 0.035;
  backing.castShadow = backing.receiveShadow = true;
  group.add(backing);

  const trimMaterial = signStyle.trim();
  const addTrim = (px, py, pw, ph, pd = backingDepth + 0.08, pz = -backingDepth / 2 + 0.015) => {
    const piece = new THREE.Mesh(new THREE.BoxGeometry(pw, ph, pd), trimMaterial);
    piece.position.set(px, py, pz);
    piece.castShadow = true;
    group.add(piece);
  };
  const railThickness = style === 'olympus' || style === 'hall' ? 0.17 : 0.13;
  addTrim(0, h / 2 + 0.15, w + 0.72, railThickness);
  addTrim(0, -h / 2 - 0.15, w + 0.72, railThickness);
  addTrim(-w / 2 - 0.16, 0, railThickness, h + 0.42);
  addTrim(w / 2 + 0.16, 0, railThickness, h + 0.42);

  if (style === 'industrial' || style === 'marine') {
    const boltMaterial = mat(style === 'marine' ? 0xb6a77f : 0x9aabb4, { roughness: 0.28, metalness: 0.82 });
    for (const bx of [-w / 2 + 0.22, w / 2 - 0.22]) for (const by of [-h / 2 + 0.2, h / 2 - 0.2]) {
      const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.08, 8), boltMaterial);
      bolt.rotation.x = Math.PI / 2;
      bolt.position.set(bx, by, 0.055);
      group.add(bolt);
    }
  }

  const material = new THREE.MeshBasicMaterial({
    map: arenaLabelTexture(text, accent, style),
    transparent: style === 'olympus',
    side: THREE.DoubleSide,
    toneMapped: false,
    ...DECOR_DEPTH_BIAS,
  });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
  sign.position.z = 0.025;
  sign.renderOrder = 3;
  group.add(sign);
  if (doubleFaced) {
    const reverse = sign.clone();
    reverse.position.z = -backingDepth - 0.095;
    reverse.rotation.y = Math.PI;
    reverse.name = `${group.name}-reverse-face`;
    group.add(reverse);
  }
  return group;
}

// A single padded barrier replaces a run of touching crates. The colored skin
// remains entirely inside the same box collider, including its top and side
// accents, so the visible silhouette and collision envelope cannot diverge.
function addArenaBarrier(scene, world, cx, baseY, cz, w, h = 2.4, d = 2.4, accent = 0xff7a2d) {
  addBox(scene, world, cx, baseY + h / 2, cz, w, h, d, 0x6946b8, {
    tex: 'arena-foam', repeat: [Math.max(1, Math.round(w / 3)), 1], roughness: 0.82,
  });
  addSurfacePanel(world, {
    x: cx, y: baseY + h, z: cz,
    width: Math.max(0.2, w - 0.12), height: Math.max(0.2, d - 0.12),
    normal: [0, 1, 0], color: accent,
  });
  for (const side of [-1, 1]) {
    addSurfacePanel(world, {
      x: cx, y: baseY + h * 0.62, z: cz + side * d / 2,
      width: Math.max(0.2, w - 0.18), height: 0.28,
      normal: [0, 0, side], color: accent,
    });
  }
}

function addBlastComplexPresentation(scene, world) {
  const essential = new THREE.Group();
  const standard = new THREE.Group();
  const high = new THREE.Group();
  essential.name = 'blast-complex-essential-presentation';
  standard.name = 'blast-complex-standard-presentation';
  high.name = 'blast-complex-high-presentation';
  scene.add(essential, standard, high);

  // The visual ceiling is exactly coincident with the underside of the solid
  // ceiling collider. A lit navy surface and recessed light graphics replace
  // the old unlit black plane without hanging non-colliding geometry into the
  // play space.
  const ceilingSkin = new THREE.Mesh(
    new THREE.PlaneGeometry(158, 118),
    new THREE.MeshBasicMaterial({ color: 0x13283a, side: THREE.DoubleSide, toneMapped: false }),
  );
  ceilingSkin.rotation.x = Math.PI / 2;
  ceilingSkin.position.y = 24.1 - SURFACE_LAYER_EPS;
  essential.add(ceilingSkin);

  const surfaceBatch = (parent, color, geometries, opacity = 1) => {
    const merged = mergeGeometries(geometries, false);
    const mesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({
      color, transparent: opacity < 1, opacity, side: THREE.DoubleSide,
      depthWrite: opacity >= 1, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    parent.add(mesh);
    for (const geometry of geometries) geometry.dispose();
    return mesh;
  };
  const ceilingPlane = (x, z, w, d) => {
    const geometry = new THREE.PlaneGeometry(w, d);
    geometry.rotateX(Math.PI / 2);
    geometry.translate(x, 24.1 - SURFACE_LAYER_EPS * 1.35, z);
    return geometry;
  };
  const ceilingLights = [];
  for (const x of [-58, -30, -2, 26, 54]) {
    ceilingLights.push(ceilingPlane(x, 0, 1.15, 104));
  }
  surfaceBatch(standard, 0x48dfff, ceilingLights, 0.68);

  // Flush wall ribs subdivide the giant perimeter planes without protruding
  // into the playable volume. All 38 pieces share one draw call.
  const ribGeo = new THREE.BoxGeometry(0.7, 17.5, 0.3);
  const ribMat = mat(0x13283a, { roughness: 0.6, metalness: 0.22 });
  const ribTransforms = [];
  for (let x = -70; x <= 70; x += 10) {
    ribTransforms.push({ x, y: 12, z: -57.15, yaw: 0 });
    ribTransforms.push({ x, y: 12, z: 57.15, yaw: 0 });
  }
  for (let z = -50; z <= 50; z += 10) {
    ribTransforms.push({ x: -77.15, y: 12, z, yaw: Math.PI / 2 });
    ribTransforms.push({ x: 77.15, y: 12, z, yaw: Math.PI / 2 });
  }
  const ribs = new THREE.InstancedMesh(ribGeo, ribMat, ribTransforms.length);
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < ribTransforms.length; i++) {
    const rib = ribTransforms[i];
    matrix.compose(
      new THREE.Vector3(rib.x, rib.y, rib.z),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rib.yaw),
      new THREE.Vector3(1, 1, 1),
    );
    ribs.setMatrixAt(i, matrix);
  }
  ribs.castShadow = ribs.receiveShadow = true;
  standard.add(ribs);

  // Each perimeter sign owns a clear wall bay. These positions are registered
  // with the map audit below alongside posters, lamps, and light bands.
  addArenaSign(essential, 'BLAST COMPLEX', 0, 20, -56.96, 24, 6, 0, '#ff7a2d');
  registerWallFeature(world, 'north', 'BLAST COMPLEX sign', 0, 20, 24, 6);
  addArenaSign(essential, 'TRAINING DECK', -76.96, 13.5, 5, 17, 4.25, Math.PI / 2, '#ffd04b');
  registerWallFeature(world, 'west', 'TRAINING DECK sign', 5, 13.5, 17, 4.25);
  addArenaSign(essential, 'COOLANT RUN', 76.96, 11.5, -5, 17, 4.25, -Math.PI / 2, '#38d6ff');
  registerWallFeature(world, 'east', 'COOLANT RUN sign', -5, 11.5, 17, 4.25);
  addArenaSign(essential, 'TOWER 01', 2, 7, 4.51, 7, 2.2, Math.PI, '#ffd04b');

  const wallPlane = (x, y, z, w, h, yaw = 0) => {
    const geometry = new THREE.PlaneGeometry(w, h);
    geometry.rotateY(yaw);
    geometry.translate(x, y, z);
    return geometry;
  };
  surfaceBatch(essential, 0xff742d, [
    wallPlane(-18.5, 3.3, -27.25 + SURFACE_LAYER_EPS, 12.6, 0.28),
    wallPlane(4, 6.5, -27.25 + SURFACE_LAYER_EPS, 15.6, 0.28),
    wallPlane(25, 6.5, -27.25 + SURFACE_LAYER_EPS, 9.6, 0.28),
    wallPlane(-18.5, 3.3, 27.25 - SURFACE_LAYER_EPS, 12.6, 0.28, Math.PI),
    wallPlane(4, 6.5, 27.25 - SURFACE_LAYER_EPS, 15.6, 0.28, Math.PI),
    wallPlane(25, 6.5, 27.25 - SURFACE_LAYER_EPS, 9.6, 0.28, Math.PI),
  ]);
  surfaceBatch(essential, 0x42d9ff, [
    wallPlane(29.25 - SURFACE_LAYER_EPS, 7.2, -13, 17.6, 0.25, -Math.PI / 2),
    wallPlane(29.25 - SURFACE_LAYER_EPS, 7.2, 13, 17.6, 0.25, -Math.PI / 2),
    wallPlane(-24.25 + SURFACE_LAYER_EPS, 7.2, -37.5, 14.6, 0.25, Math.PI / 2),
    wallPlane(-24.25 + SURFACE_LAYER_EPS, 7.2, 0, 43.6, 0.25, Math.PI / 2),
  ]);

  const floorBatch = (color, geometries) => surfaceBatch(essential, color, geometries, 0.82);
  const floorPlane = (x, z, w, d, y = SURFACE_LAYER_EPS) => {
    const geometry = new THREE.PlaneGeometry(w, d);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(x, y, z);
    return geometry;
  };
  const floorRing = (x, z, inner, outer, y = SURFACE_LAYER_EPS) => {
    const geometry = new THREE.RingGeometry(inner, outer, 64);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(x, y, z);
    return geometry;
  };
  floorBatch(0xff7a2d, [
    floorRing(2, 0, 10.8, 11.25),
    floorPlane(-15.5, -14, 0.45, 17),
    floorPlane(-15.5, 14, 0.45, 17),
    floorPlane(-49, 0, 9, 0.38),
  ]);
  floorBatch(0x38d6ff, [
    floorPlane(40, 0, 18, 0.34),
    floorPlane(59, 0, 13, 0.34),
    floorPlane(72.5, -7, 0.34, 10),
    floorPlane(72.5, 7, 0.34, 10),
  ]);

  // The target beacon is deliberately holographic: it reads as the arena's
  // hero landmark while clearly communicating that shots and players pass
  // through it. No hidden physical structure is implied.
  const beacon = new THREE.Group();
  beacon.position.set(2, 18.1, -7);
  const beaconMat = new THREE.MeshBasicMaterial({
    color: 0xffc43d, transparent: true, opacity: 0.72,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });
  const outer = new THREE.Mesh(new THREE.TorusGeometry(3.7, 0.16, 8, 56), beaconMat);
  const inner = new THREE.Mesh(new THREE.TorusGeometry(2.25, 0.09, 8, 48), beaconMat);
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.55, 24), beaconMat);
  beacon.add(outer, inner, dot);
  essential.add(beacon);

  const ribbonMat = new THREE.MeshBasicMaterial({
    color: 0x42dcff, transparent: true, opacity: 0.5,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });
  for (const z of [-18, 18]) {
    const curve = new THREE.CatmullRomCurve3([
      V(-22, 22.55, z), V(-12, 23.1, z * 0.7), V(2, 22.7, z * 0.55),
      V(16, 23.1, z * 0.7), V(29, 22.55, z),
    ]);
    high.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 32, 0.1, 5, false), ribbonMat));
  }

  const ledGeo = new THREE.SphereGeometry(0.12, 5, 4);
  const ledMat = new THREE.MeshBasicMaterial({ color: 0xffc43d, toneMapped: false });
  const ledPositions = [];
  for (let x = -68; x <= 68; x += 4) {
    ledPositions.push(V(x, 21.4 + Math.sin(x * 0.3) * 0.35, -56.82));
    ledPositions.push(V(x, 21.4 + Math.cos(x * 0.27) * 0.35, 56.82));
  }
  const leds = new THREE.InstancedMesh(ledGeo, ledMat, ledPositions.length);
  for (let i = 0; i < ledPositions.length; i++) {
    matrix.makeTranslation(ledPositions[i].x, ledPositions[i].y, ledPositions[i].z);
    leds.setMatrixAt(i, matrix);
  }
  high.add(leds);

  world.anim.push((dt, t) => {
    beacon.rotation.y = Math.sin(t * 0.38) * 0.16;
    beacon.rotation.z = Math.sin(t * 0.72) * 0.035;
    beaconMat.opacity = 0.62 + Math.sin(t * 2.1) * 0.1;
  });
  world.setVisualQuality = tier => {
    essential.visible = true;
    standard.visible = tier !== 'low';
    high.visible = tier === 'high';
  };
  world.setVisualQuality('high');
}

/* ================= MAP 1 — BLAST COMPLEX (labyrinth, 154×114) =================
   West wing: two rooms (crate maze + mezzanine room with a second floor).
   Center: grand atrium — tall room, tiered tower, balcony, floating top platform.
   East wing: sunken basement lanes with a ground-level bridge crossing above. */
function buildArena(scene) {
  const world = newWorld({ killY: -20, waypointLinkDist: 22, waypointLinkDy: 4.6 });
  const arenaColor = {
    floor: 0x2e74bd,
    lowerFloor: 0x28539a,
    shell: 0xd94b24,
    blue: 0x3277d5,
    purple: 0x7548c7,
    magenta: 0xc63e9f,
    partition: 0x7548c7,
    ceiling: 0x152638,
    orange: 0xff642b,
    yellow: 0xffd43b,
    cyan: 0x28d8ff,
    green: 0x42bf69,
  };
  scene.background = new THREE.Color(0x100b2c);
  scene.fog = new THREE.Fog(0x19143d, 82, 245);
  baseLighting(scene, 0xb0a7ff, 0x432758, [42, 105, 34], 110);
  const lavaRoomPits = [[-12, 50], [22, 36], [-12, -50], [22, -36]];

  // Floors: main level (west + atrium), sunken east basement (top −5)
  // Main floor is split around inset lava basins.
  for (const [x, z, w, d] of [
    // West floor, split around the subway ramp openings.
    [-47.75, 32.75, 62.5, 56.5],
    [-47.75, -41.5, 62.5, 39],
    [-57, -13.25, 44, 17.5],
    [-22.75, -13.25, 12.5, 17.5],
    [-75.5, 0, 7, 9],
    [-37.25, 0, 41.5, 9],
    // Atrium center floor, split around the north subway ramp opening.
    [0.25, -28.25, 15.5, 65.5],
    [0.25, 41.5, 15.5, 39],
    [-2.75, 13.25, 9.5, 17.5],
    [-12, -57.75, 9, 6.5],
    [-12, -36.25, 9, 18.5],
    [-12, 0, 9, 54],
    [-12, 36.25, 9, 18.5],
    [-12, 57.75, 9, 6.5],
  ]) {
    addBox(scene, world, x, -0.5, z, w, 1, d, arenaColor.floor, { tex: 'arena-floor', repeat: [Math.max(1, Math.round(w / 8)), Math.max(1, Math.round(d / 8))] });
  }
  for (const [x, z, w, d] of [
    [23, -50.75, 14, 19.5],
    [23, 0, 14, 63],
    [23, 50.75, 14, 19.5],
    [16.75, -36, 1.5, 9],
    [28.25, -36, 3.5, 9],
    [16.75, 36, 1.5, 9],
    [28.25, 36, 3.5, 9],
  ]) {
    addBox(scene, world, x, -0.5, z, w, 1, d, arenaColor.floor, { tex: 'arena-floor', repeat: [Math.max(1, Math.round(w / 8)), Math.max(1, Math.round(d / 8))] });
  }
  addBox(scene, world, 12, -0.5, -54.5, 8, 1, 13, arenaColor.floor, { tex: 'arena-floor', repeat: [1, 2] });
  addBox(scene, world, 12, -0.5, -44, 8, 1, 8, arenaColor.floor, { tex: 'arena-floor', repeat: [1, 1] });
  addBox(scene, world, 12, -0.5, -17, 8, 1, 46, arenaColor.floor, { tex: 'arena-floor', repeat: [1, 6] });
  addBox(scene, world, 12, -0.5, 10, 8, 1, 8, arenaColor.floor, { tex: 'arena-floor', repeat: [1, 1] });
  addBox(scene, world, 12, -0.5, 37.5, 8, 1, 47, arenaColor.floor, { tex: 'arena-floor', repeat: [1, 6] });
  // Backfill tiny floor slivers around lava rims just below the main floor.
  // This avoids visible void gaps without reintroducing coplanar z-fighting.
  for (const [x, z] of lavaRoomPits) {
    addBox(scene, world, x - 5.05, -0.515, z, 0.8, 0.97, 10.2, arenaColor.floor, { tex: 'arena-floor', repeat: [1, 1] });
    addBox(scene, world, x + 5.05, -0.515, z, 0.8, 0.97, 10.2, arenaColor.floor, { tex: 'arena-floor', repeat: [1, 1] });
    addBox(scene, world, x, -0.515, z - 5.05, 10.2, 0.97, 0.8, arenaColor.floor, { tex: 'arena-floor', repeat: [1, 1] });
    addBox(scene, world, x, -0.515, z + 5.05, 10.2, 0.97, 0.8, arenaColor.floor, { tex: 'arena-floor', repeat: [1, 1] });
  }
  const lazyRiverRects = [
    [50, -33.5, 12, 9],
    [62, -25, 28, 9],
    [72, -8, 10, 28],
    [62, 9, 28, 9],
    [62, 16, 8, 6],
    [62, 29, 12, 26],
  ];
  const rectBounds = ([x, z, w, d]) => ({
    minX: x - w / 2, maxX: x + w / 2,
    minZ: z - d / 2, maxZ: z + d / 2,
  });
  const riverCuts = lazyRiverRects.map(rectBounds);
  const subwayFlatEntryCut = { minX: 30, maxX: 30.55, minZ: -4.25, maxZ: 4.25 };
  const basementBounds = { minX: 30, maxX: 79, minZ: -61, maxZ: 61 };
  const uniqueSorted = (values) => [...new Set(values.map(v => Math.round(v * 1000) / 1000))].sort((a, b) => a - b);
  const floorXs = uniqueSorted([basementBounds.minX, basementBounds.maxX, subwayFlatEntryCut.maxX, ...riverCuts.flatMap(r => [r.minX, r.maxX])]);
  const floorZs = uniqueSorted([basementBounds.minZ, basementBounds.maxZ, subwayFlatEntryCut.minZ, subwayFlatEntryCut.maxZ, ...riverCuts.flatMap(r => [r.minZ, r.maxZ])]);
  const isRiverCell = (minX, maxX, minZ, maxZ) => {
    const x = (minX + maxX) / 2;
    const z = (minZ + maxZ) / 2;
    return riverCuts.some(r => x > r.minX && x < r.maxX && z > r.minZ && z < r.maxZ);
  };
  const isSubwayFlatEntryCell = (minX, maxX, minZ, maxZ) => {
    const x = (minX + maxX) / 2;
    const z = (minZ + maxZ) / 2;
    return x > subwayFlatEntryCut.minX && x < subwayFlatEntryCut.maxX &&
      z > subwayFlatEntryCut.minZ && z < subwayFlatEntryCut.maxZ;
  };
  for (let zi = 0; zi < floorZs.length - 1; zi++) {
    const minZ = floorZs[zi], maxZ = floorZs[zi + 1];
    let runStart = null, runEnd = null;
    for (let xi = 0; xi < floorXs.length - 1; xi++) {
      const minX = floorXs[xi], maxX = floorXs[xi + 1];
      const dry = !isRiverCell(minX, maxX, minZ, maxZ) && !isSubwayFlatEntryCell(minX, maxX, minZ, maxZ);
      if (dry && runStart == null) runStart = minX;
      if (dry) runEnd = maxX;
      if ((!dry || xi === floorXs.length - 2) && runStart != null) {
        addBox(scene, world,
          (runStart + runEnd) / 2, -5.5, (minZ + maxZ) / 2,
          runEnd - runStart, 1, maxZ - minZ, arenaColor.lowerFloor,
          { tex: 'arena-floor', repeat: [Math.max(1, Math.round((runEnd - runStart) / 8)), Math.max(1, Math.round((maxZ - minZ) / 8))] });
        runStart = null; runEnd = null;
      }
    }
  }
  // Last-resort underside deck: intentional pools sit above this, but
  // any accidental floor seam now lands on geometry instead of out-of-map void.
  addBox(scene, world, 55, -9.25, 0, 50, 0.5, 118, 0x102033, { tex: 'panel', repeat: [6, 14] });
  // Retaining wall top sits 0.1 below floor level; flush tops z-fight.
  // Split at z 0 to make the under-map service-tunnel doorway.
  addBox(scene, world, 29.6, -3.05, -32.5, 1.4, 5.9, 57, 0x8a5230, { tex: 'panel' });
  addBox(scene, world, 29.6, -3.05, 32.5, 1.4, 5.9, 57, 0x8a5230, { tex: 'panel' });

  // Outer walls (drop below the basement floor)
  for (const [x, z, w, d, color] of [
    [0, -59, 162, 4, arenaColor.shell],
    [0, 59, 162, 4, arenaColor.purple],
    [-79, 0, 4, 122, arenaColor.blue],
    [79, 0, 4, 122, arenaColor.green],
  ]) {
    addBox(scene, world, x, 9, z, w, 30, d, color, { tex: 'arena-wall' });
  }
  // Main ceiling at the top of the perimeter walls so indoor shots ricochet
  // instead of escaping upward.
  addBox(scene, world, 0, 24.35, 0, 162, 0.5, 122, arenaColor.ceiling, { tex: 'arena-wall', repeat: [20, 15] });
  // Glow stripes + lights
  for (const [x, z, w, d, wall, span] of [
    [0, -56.8, 150, 0.3, 'north', 150], [0, 56.8, 150, 0.3, 'south', 150],
    [-76.8, 0, 0.3, 112, 'west', 112], [76.8, 0, 0.3, 112, 'east', 112],
  ]) {
    addBox(scene, world, x, 7, z, w, 0.9, d, arenaColor.orange, { collide: false, shadow: false, emissive: arenaColor.orange, emissiveIntensity: 0.72 });
    registerWallFeature(world, wall, `${wall} light band`, 0, 7, span, 0.9);
  }
  // lamps sit 0.1 proud of the wall face — flush placement z-fights with the wall
  for (const [x, z, wall] of [
    [-30, -57.9, 'north'], [0, -57.9, 'north'], [30, -57.9, 'north'],
    [-50, 57.9, 'south'], [28, 57.9, 'south'], [50, 57.9, 'south'],
  ]) {
    addBox(scene, world, x, 15, z, 3, 1.2, 2, 0xffffff, { collide: false, shadow: false, emissive: 0xeef4ff, emissiveIntensity: 2.2 });
    registerWallFeature(world, wall, `${wall} lamp ${x}`, x, 15, 3, 1.2);
  }
  // wall art — keep clear vertical separation from the y≈7 glow stripes.
  addDecal(scene, 'poster1', -50, 13.5, -56.9, 9, 0);
  registerWallFeature(world, 'north', 'Rumble poster', -50, 13.5, 9, 9);
  addScoreTarget(scene, world, 50, 13.5, -56.9, 9, 0);
  registerWallFeature(world, 'north', 'target poster', 50, 13.5, 9, 9);
  addDecal(scene, 'hazard', 0, 12.2, 56.9, 12, Math.PI, 6);
  registerWallFeature(world, 'south', 'hazard poster', 0, 12.2, 12, 6);
  addDecal(scene, 'poster1', -76.9, 13.5, 30, 9, Math.PI / 2);
  registerWallFeature(world, 'west', 'Rumble poster', 30, 13.5, 9, 9);
  addScoreTarget(scene, world, 76.9, 13.5, -30, 9, -Math.PI / 2);
  registerWallFeature(world, 'east', 'target poster', -30, 13.5, 9, 9);
  // ground variety: an arcade-carpet lounge in the west wing
  addBox(scene, world, -55, 0.031, -30, 34, 0.06, 40, arenaColor.magenta, { tex: 'arcade', repeat: [7, 8], roughness: 0.96 });
  addBox(scene, world, -35, 0.031, -38, 6, 0.06, 24, arenaColor.magenta, { tex: 'arcade', repeat: [1, 5], roughness: 0.96 });
  addBox(scene, world, -52, 0.031, 30, 36, 0.06, 36, arenaColor.green, { tex: 'arena-floor', repeat: [7, 7], roughness: 0.92 });
  // floating platform over the east basement + pad up
  addBox(scene, world, 54, 6.7, 30, 10, 0.6, 8, 0x7a4fc0, { tex: 'panel' });
  addJumpPad(scene, world, 45, -5, 30, 28, 5, 0, 0xffd23c); // offset — straight under bonks the underside
  pk(world, 'ammo', 54, 7.2, 30, { weapon: 'hyper' });
  wp(world, 45, -5, 30); wp(world, 54, 7, 30);
  world.manualLinks.push([45, -5, 30, 54, 7, 30, true]);

  const wallC = arenaColor.partition;
  const eastWallC = arenaColor.orange;
  const northHallC = arenaColor.blue;
  const southHallC = arenaColor.magenta;

  // WEST DIVIDER (x −25): doors at z ±26, upper cutout at z 36..44 for the
  // mezzanine — and a low secret crawlway at z −49..−45 behind the maze crates
  addBox(scene, world, -25, 5, -37.5, 1.5, 10, 15, wallC, { tex: 'arena-wall' });
  addBox(scene, world, -25, 5, -53, 1.5, 10, 8, wallC, { tex: 'arena-wall' });
  addBox(scene, world, -25, 6.1, -47, 1.5, 7.8, 4, wallC, { tex: 'arena-wall' });
  addBox(scene, world, -25, 5, 0, 1.5, 10, 44, wallC, { tex: 'arena-wall' });
  addBox(scene, world, -25, 2.5, 43.5, 1.5, 5, 27, wallC, { tex: 'arena-wall' });
  addBox(scene, world, -25, 7.5, 33, 1.5, 5, 6, wallC, { tex: 'arena-wall' });
  addBox(scene, world, -25, 7.5, 50.5, 1.5, 5, 13, wallC, { tex: 'arena-wall' });

  // EAST DIVIDER (x 30): doors at z ±26 and z 0 (bridge); the outer stretches
  // are built in the halls section below (they contain basement drop-doors)
  addBox(scene, world, 30, 5, -13, 1.5, 10, 18, eastWallC, { tex: 'arena-wall' });
  addBox(scene, world, 30, 5, 13, 1.5, 10, 18, eastWallC, { tex: 'arena-wall' });

  // WEST WING mid divider (z 0), door at x −54..−46
  addBox(scene, world, -65.5, 5, 0, 23, 10, 1.5, arenaColor.green, { tex: 'arena-wall' });
  addBox(scene, world, -35.5, 5, 0, 21, 10, 1.5, arenaColor.green, { tex: 'arena-wall' });

  // --- NW room: mezzanine (second floor) ---
  addBox(scene, world, -51.75, 4.7, 44.5, 50.5, 0.6, 25, arenaColor.green, { tex: 'arena-floor' });
  addRamp(scene, world, { axis: 'z', minX: -77, maxX: -71, minZ: 6, maxZ: 32, h0: 0, h1: 5, color: arenaColor.green, tex: 'arena-floor' });
  addArenaBarrier(scene, world, -40, 0, 20, 2.5, 2.5, 2.5, arenaColor.yellow);
  addArenaBarrier(scene, world, -37.5, 0, 20, 2.5, 2.5, 2.5, arenaColor.orange);

  // --- SW room: crate maze ---
  const crate = (x, y, z, s = 2.4, accent = arenaColor.orange) =>
    addArenaBarrier(scene, world, x, y, z, s, s, s, accent);
  addArenaBarrier(scene, world, -60.4, 0, -15, 21.6, 2.4, 2.4, arenaColor.orange);
  addArenaBarrier(scene, world, -45.4, 0, -28, 21.6, 2.4, 2.4, arenaColor.yellow);
  addArenaBarrier(scene, world, -60.4, 0, -41, 21.6, 2.4, 2.4, arenaColor.orange);
  crate(-32, 0, -50); crate(-32, 0, -47.5); crate(-45, 0, -50);
  crate(-70, 0, -28, 2.4, arenaColor.yellow);
  crate(-70, 2.4, -28, 2.4, arenaColor.yellow); // double stack at the west end

  // --- HALLS: walls at z ±28 close the atrium into a room; the bands beyond
  // become enclosed, ceilinged corridors ---
  // north wall (upper opening at x −25..−19 lets the balcony pass through)
  addBox(scene, world, -18.5, 2.2, 28, 13, 4.4, 1.5, northHallC, { tex: 'arena-wall' });
  addBox(scene, world, -15.5, 6.2, 28, 7, 3.6, 1.5, northHallC, { tex: 'arena-wall' });
  addBox(scene, world, 4, 4, 28, 16, 8, 1.5, northHallC, { tex: 'arena-wall' });
  addBox(scene, world, 25, 4, 28, 10, 8, 1.5, northHallC, { tex: 'arena-wall' });
  // south wall
  addBox(scene, world, -18.5, 4, -28, 13, 8, 1.5, southHallC, { tex: 'arena-wall' });
  addBox(scene, world, 4, 4, -28, 16, 8, 1.5, southHallC, { tex: 'arena-wall' });
  addBox(scene, world, 25, 4, -28, 10, 8, 1.5, southHallC, { tex: 'arena-wall' });
  // hall ceilings — proper indoor corridors
  // ceilings overlap the wall tops by 0.02 (flush faces shimmer)
  addBox(scene, world, 2.5, 8.38, 42.5, 55, 0.8, 29, arenaColor.ceiling, { tex: 'arena-wall' });
  addBox(scene, world, 2.5, 8.38, -42.5, 55, 0.8, 29, arenaColor.ceiling, { tex: 'arena-wall' });
  for (const [lx, lz] of [[2, 42], [2, -42]]) { // one light per hall — point lights are pricey
    const hl = new THREE.PointLight(0x7fd0ff, 40, 34);
    hl.position.set(lx, 6, lz);
    scene.add(hl);
  }
  // hall → basement drop-doors in the east divider
  addBox(scene, world, 30, 5, -34, 1.5, 10, 8, eastWallC, { tex: 'arena-wall' });
  addBox(scene, world, 30, 5, -51.5, 1.5, 10, 11, eastWallC, { tex: 'arena-wall' });
  addBox(scene, world, 30, 5, 34, 1.5, 10, 8, eastWallC, { tex: 'arena-wall' });
  addBox(scene, world, 30, 5, 51.5, 1.5, 10, 11, eastWallC, { tex: 'arena-wall' });

  // --- ATRIUM: balcony along west edge (runs through the wall opening onto a
  // ledge above the north hall) ---
  addBox(scene, world, -21.6, 4.7, 10, 5.3, 0.6, 72, arenaColor.green, { tex: 'arena-floor' });
  // east gallery (half-height ledge with a sheltered nook beneath)
  addBox(scene, world, 25, 2.7, 0, 10, 0.6, 40, arenaColor.green, { tex: 'arena-floor' });
  addRamp(scene, world, { axis: 'z', minX: 22, maxX: 28, minZ: 20, maxZ: 27, h0: 3, h1: 0, color: arenaColor.green, tex: 'arena-floor' });
  addRamp(scene, world, { axis: 'z', minX: 22, maxX: 28, minZ: -27, maxZ: -20, h0: 0, h1: 3, color: arenaColor.green, tex: 'arena-floor' });
  // tiered tower
  addBox(scene, world, 2, 2, 0, 18, 4, 18, 0xb84822, { tex: 'arena-wall' });
  addBox(scene, world, 2, 6.5, 0, 9, 5, 9, arenaColor.orange, { tex: 'arena-wall' });
  addBox(scene, world, 2, 14, -7, 14, 0.8, 14, arenaColor.partition, { tex: 'arena-floor' });  // floating top platform
  addBox(scene, world, 2, 14.53, -7, 14.4, 0.2, 14.4, arenaColor.yellow, { collide: false, shadow: false, emissive: arenaColor.orange, emissiveIntensity: 0.42 });
  addRamp(scene, world, { axis: 'x', minX: -16, maxX: -7, minZ: -4, maxZ: 4, h0: 0, h1: 4, color: arenaColor.yellow, tex: 'arena-floor' });
  addRamp(scene, world, { axis: 'x', minX: 11, maxX: 20, minZ: -4, maxZ: 4, h0: 4, h1: 0, color: arenaColor.yellow, tex: 'arena-floor' });
  // pads: floor→balcony ×2, base→mid, mid→top
  addJumpPad(scene, world, -12, 0, -20, 19, -8, -2);
  addJumpPad(scene, world, -12, 0, 20, 19, -8, 2);
  addJumpPad(scene, world, 2, 4, 7, 19, 0, -4.5, 0xffd23c);
  addJumpPad(scene, world, 2, 9, 3, 19, 0, -7, 0xffd23c);
  // atrium cover
  addBox(scene, world, 12, 4, -22, 4, 8, 4, wallC, { tex: 'arena-wall' });
  addBox(scene, world, 12, 4, 22, 4, 8, 4, wallC, { tex: 'arena-wall' });
  crate(22, 0, -48); crate(24.5, 0, -48); crate(22, 0, 48); crate(19.5, 0, 48);
  // NW room nook wall
  addBox(scene, world, -61, 2.5, 30, 14, 5, 1.5, wallC, { tex: 'arena-wall' });

  // --- EAST WING: basement lanes + bridge + ledge ---
  addRamp(scene, world, { axis: 'x', minX: 30, maxX: 44, minZ: -30, maxZ: -22, h0: 0, h1: -5, color: arenaColor.yellow, tex: 'arena-floor' });
  addRamp(scene, world, { axis: 'x', minX: 30, maxX: 44, minZ: 22, maxZ: 30, h0: 0, h1: -5, color: arenaColor.yellow, tex: 'arena-floor' });
  addBox(scene, world, 50, -0.4, 0, 40, 0.8, 6, arenaColor.orange, { tex: 'arena-floor' });        // bridge (ends at the ledge — overlapping it z-fights)
  addBox(scene, world, 73.5, -0.4, 0, 7, 0.8, 28, arenaColor.partition, { tex: 'arena-floor' });      // east ledge
  // basement lane walls (-5..0)
  addBox(scene, world, 44, -2.5, -14, 12, 5, 1.5, arenaColor.partition, { tex: 'arena-wall' });
  addBox(scene, world, 64, -2.5, -14, 12, 5, 1.5, arenaColor.partition, { tex: 'arena-wall' });
  addBox(scene, world, 48, -2.5, 14, 20, 5, 1.5, arenaColor.partition, { tex: 'arena-wall' });
  addBox(scene, world, 68, -2.5, 14, 4, 5, 1.5, arenaColor.partition, { tex: 'arena-wall' });
  crate(62, -5, -42); crate(65, -5, -42); crate(72, -5, 33);
  // Lazy river: swimmable water snakes through the east basement instead of
  // flooding the whole floor. It dives under the main floor and resurfaces
  // through two floor cuts reached by ramps.
  const riverRects = lazyRiverRects;
  for (let zi = 0; zi < floorZs.length - 1; zi++) {
    const minZ = floorZs[zi], maxZ = floorZs[zi + 1];
    let runStart = null, runEnd = null;
    for (let xi = 0; xi < floorXs.length - 1; xi++) {
      const minX = floorXs[xi], maxX = floorXs[xi + 1];
      const wet = isRiverCell(minX, maxX, minZ, maxZ);
      if (wet && runStart == null) runStart = minX;
      if (wet) runEnd = maxX;
      if ((!wet || xi === floorXs.length - 2) && runStart != null) {
        const w = runEnd - runStart;
        const d = maxZ - minZ;
        const x = (runStart + runEnd) / 2;
        const z = (minZ + maxZ) / 2;
        addBox(scene, world, x, -8.3, z, w, 1, d, 0x1f5f72,
          { tex: 'panel', repeat: [Math.max(1, Math.round(w / 6)), Math.max(1, Math.round(d / 6))] });
        addWater(scene, world, x, -4.95, z, w, d, 3.0);
        runStart = null; runEnd = null;
      }
    }
  }
  const riverBounds = riverRects.map(rectBounds);
  const openIntervals = (min, max, cuts) => {
    const clipped = cuts
      .map(([a, b]) => [Math.max(min, a), Math.min(max, b)])
      .filter(([a, b]) => b - a > 0.05)
      .sort((a, b) => a[0] - b[0]);
    const out = [];
    let cursor = min;
    for (const [a, b] of clipped) {
      if (a - cursor > 0.05) out.push([cursor, a]);
      cursor = Math.max(cursor, b);
    }
    if (max - cursor > 0.05) out.push([cursor, max]);
    return out;
  };
  const addRiverWall = (x, z, w, d) => addBox(scene, world, x, -6.5, z, w, 2.8, d, 0x173548,
    { tex: 'panel', repeat: [Math.max(1, Math.round(w / 6)), Math.max(1, Math.round(d / 6))] });
  for (let i = 0; i < riverBounds.length; i++) {
    const r = riverBounds[i];
    for (const side of ['left', 'right']) {
      const edgeX = side === 'left' ? r.minX : r.maxX;
      const cuts = riverBounds
        .filter((o, j) => j !== i && o.minX < edgeX && o.maxX > edgeX)
        .map(o => [Math.max(r.minZ, o.minZ), Math.min(r.maxZ, o.maxZ)])
        .filter(([a, b]) => b > a);
      for (const [a, b] of openIntervals(r.minZ, r.maxZ, cuts)) {
        addRiverWall(edgeX, (a + b) / 2, 0.5, b - a);
      }
    }
    for (const side of ['near', 'far']) {
      const edgeZ = side === 'near' ? r.minZ : r.maxZ;
      const cuts = riverBounds
        .filter((o, j) => j !== i && o.minZ < edgeZ && o.maxZ > edgeZ)
        .map(o => [Math.max(r.minX, o.minX), Math.min(r.maxX, o.maxX)])
        .filter(([a, b]) => b > a);
      for (const [a, b] of openIntervals(r.minX, r.maxX, cuts)) {
        addRiverWall((a + b) / 2, edgeZ, b - a, 0.5);
      }
    }
  }
  addBox(scene, world, 60, -0.95, 0, 22, 0.7, 28, 0x3a3358, { tex: 'panel' });
  addRamp(scene, world, { axis: 'z', minX: 47, maxX: 53, minZ: -51, maxZ: -39, h0: 0, h1: -5, color: arenaColor.cyan, tex: 'arena-floor' });
  addRamp(scene, world, { axis: 'z', minX: 59, maxX: 65, minZ: 42, maxZ: 54, h0: -5, h1: 0, color: arenaColor.cyan, tex: 'arena-floor' });
  const addRiverTrim = (x, z, w, d) => addBox(scene, world, x, -4.72, z, w, 0.32, d, 0x30e0ff,
    { collide: false, shadow: false, emissive: 0x30e0ff, emissiveIntensity: 1.0 });
  for (let i = 0; i < riverBounds.length; i++) {
    const r = riverBounds[i];
    for (const side of ['left', 'right']) {
      const edgeX = side === 'left' ? r.minX : r.maxX;
      const cuts = riverBounds
        .filter((o, j) => j !== i && o.minX < edgeX && o.maxX > edgeX)
        .map(o => [Math.max(r.minZ, o.minZ), Math.min(r.maxZ, o.maxZ)])
        .filter(([a, b]) => b > a);
      for (const [a, b] of openIntervals(r.minZ, r.maxZ, cuts)) {
        addRiverTrim(edgeX, (a + b) / 2, 0.32, b - a);
      }
    }
    for (const side of ['near', 'far']) {
      const edgeZ = side === 'near' ? r.minZ : r.maxZ;
      const cuts = riverBounds
        .filter((o, j) => j !== i && o.minZ < edgeZ && o.maxZ > edgeZ)
        .map(o => [Math.max(r.minX, o.minX), Math.min(r.maxX, o.maxX)])
        .filter(([a, b]) => b > a);
      for (const [a, b] of openIntervals(r.minX, r.maxX, cuts)) {
        addRiverTrim((a + b) / 2, edgeZ, b - a, 0.32);
      }
    }
  }
  // Subway-style under-map tunnel. It begins at the lower east retaining-wall
  // doorway, then runs west beneath the main floor with ramp exits back up.
  addBox(scene, world, -13.75, -5.5, 0, 88.5, 1, 8, 0x2f3542, { tex: 'panel', repeat: [12, 1] });
  addRamp(scene, world, { axis: 'x', minX: -72, maxX: -58, minZ: -4, maxZ: 4, h0: 0, h1: -5, color: arenaColor.ceiling, tex: 'arena-floor', visualInset: 0.25 });
  addRamp(scene, world, { axis: 'z', minX: 2, maxX: 8, minZ: 4.5, maxZ: 22, h0: -5, h1: 0, color: arenaColor.ceiling, tex: 'arena-floor', visualInset: 0.25 });
  addRamp(scene, world, { axis: 'z', minX: -35, maxX: -29, minZ: -22, maxZ: -4.5, h0: 0, h1: -5, color: arenaColor.ceiling, tex: 'arena-floor', visualInset: 0.25 });
  // Raised threshold plates hide the floor/ramp lip where coplanar slab edges shimmer.
  addBox(scene, world, -72, 0.035, 0, 0.65, 0.07, 8.4, 0x202638, { collide: false, shadow: false, tex: 'panel', repeat: [1, 1] });
  addBox(scene, world, 5, 0.035, 22, 6.4, 0.07, 0.65, 0x202638, { collide: false, shadow: false, tex: 'panel', repeat: [1, 1] });
  addBox(scene, world, -32, 0.035, -22, 6.4, 0.07, 0.65, 0x202638, { collide: false, shadow: false, tex: 'panel', repeat: [1, 1] });
  addBox(scene, world, -28, -2.85, 4.5, 60, 4.3, 0.8, 0x262b38, { tex: 'panel', repeat: [8, 1] });
  addBox(scene, world, 18.3, -2.85, 4.5, 20.6, 4.3, 0.8, 0x262b38, { tex: 'panel', repeat: [3, 1] });
  addBox(scene, world, -46.5, -2.85, -4.5, 23, 4.3, 0.8, 0x262b38, { tex: 'panel', repeat: [3, 1] });
  addBox(scene, world, -0.2, -2.85, -4.5, 57.6, 4.3, 0.8, 0x262b38, { tex: 'panel', repeat: [8, 1] });
  addBox(scene, world, -65, -2.85, 4.5, 14, 4.3, 0.8, 0x262b38, { tex: 'panel', repeat: [2, 1] });
  addBox(scene, world, -65, -2.85, -4.5, 14, 4.3, 0.8, 0x262b38, { tex: 'panel', repeat: [2, 1] });
  addBox(scene, world, 1.5, -2.85, 13.25, 0.7, 4.3, 17.5, 0x262b38, { tex: 'panel', repeat: [1, 2] });
  addBox(scene, world, 8.5, -2.85, 13.25, 0.7, 4.3, 17.5, 0x262b38, { tex: 'panel', repeat: [1, 2] });
  addBox(scene, world, -35.5, -2.85, -13.25, 0.7, 4.3, 17.5, 0x262b38, { tex: 'panel', repeat: [1, 2] });
  addBox(scene, world, -28.5, -2.85, -13.25, 0.7, 4.3, 17.5, 0x262b38, { tex: 'panel', repeat: [1, 2] });
  const tunnelLight = new THREE.PointLight(0x36e0ff, 24, 36);
  tunnelLight.position.set(-12, -3.2, 0);
  scene.add(tunnelLight);
  for (const [x, z, w, d] of [
    [-13.75, 3.85, 88.5, 0.25],
    [-13.75, -3.85, 88.5, 0.25],
    [-65, 3.85, 14, 0.25],
    [-65, -3.85, 14, 0.25],
    [5, 21.5, 6, 0.25],
    [-32, -21.5, 6, 0.25],
  ]) {
    addBox(scene, world, x, -4.72, z, w, 0.28, d, 0x30e0ff,
      { collide: false, shadow: false, emissive: 0x30e0ff, emissiveIntensity: 1.0 });
  }
  for (const [x, z] of lavaRoomPits) {
    addLava(scene, world, x, z, 9, 9, -1.1);
    addBox(scene, world, x, -0.55, z - 4.65, 9.6, 1.1, 0.4, 0x3a2018, { tex: 'rock' });
    addBox(scene, world, x, -0.55, z + 4.65, 9.6, 1.1, 0.4, 0x3a2018, { tex: 'rock' });
    addBox(scene, world, x - 4.65, -0.55, z, 0.4, 1.1, 9.6, 0x3a2018, { tex: 'rock' });
    addBox(scene, world, x + 4.65, -0.55, z, 0.4, 1.1, 9.6, 0x3a2018, { tex: 'rock' });
    addBox(scene, world, x, 0.08, z - 4.65, 9.6, 0.16, 0.28, 0xff5a20,
      { collide: false, shadow: false, emissive: 0xff5a20, emissiveIntensity: 1.1 });
    addBox(scene, world, x, 0.08, z + 4.65, 9.6, 0.16, 0.28, 0xff5a20,
      { collide: false, shadow: false, emissive: 0xff5a20, emissiveIntensity: 1.1 });
    addBox(scene, world, x - 4.65, 0.08, z, 0.28, 0.16, 9.6, 0xff5a20,
      { collide: false, shadow: false, emissive: 0xff5a20, emissiveIntensity: 1.1 });
    addBox(scene, world, x + 4.65, 0.08, z, 0.28, 0.16, 9.6, 0xff5a20,
      { collide: false, shadow: false, emissive: 0xff5a20, emissiveIntensity: 1.1 });
  }

  // Spawns
  for (const [x, z] of [[-70, 30], [-60, 15], [-70, -30], [-60, -15], [-35, 30]]) {
    world.spawns.blue.push(V(x, 0.1, z));
  }
  world.spawns.red.push(V(72, 0.1, 6), V(72, 0.1, -6), V(65, -4.9, 30), V(65, -4.9, -30), V(50, -4.9, 0));
  for (const [x, y, z] of [[25, 0.1, 45], [25, 0.1, -45], [-15, 0.1, 20], [-15, 0.1, -24],
                           [-21.5, 5.1, 20], [-50, 5.1, 45], [-55, 0.1, -33], [55, -4.9, 26],
                           [-72, 0.1, 0], [72, 0.1, 0], [54, -4.9, -26], [2, 9.2, -4]]) {
    world.spawns.ffa.push(V(x, y, z));
  }

  // Pickups
  pk(world, 'shield', -4, 4.2, 0);                       // atrium base tier
  pk(world, 'speed', 20, 0.2, -20);                      // crate maze lane
  pk(world, 'speed', 26, -4.8, 0);                       // tunnel east entrance
  pk(world, 'speed', -64, -2.2, 0);                      // tunnel far exit ramp
  pk(world, 'djump', -52, 0.2, 30);                      // west-wing turf
  pk(world, 'gold', 2, 15, -7);                          // floating top platform
  pk(world, 'silver', -62, 0.2, -28);                    // deep in the crate maze
  pk(world, 'weapon', 72, -4.8, -45, { weapon: 'zooka' });   // basement south corner
  pk(world, 'weapon', -21.5, 5.2, -24, { weapon: 'hyper' }); // balcony south end
  pk(world, 'weapon', -60, 5.2, 45, { weapon: 'pulsar' });   // mezzanine
  pk(world, 'weapon', 65, -4.8, 45, { weapon: 'pulsar' });   // basement north
  pk(world, 'weapon', -40, 0.2, -45, { weapon: 'scatter' }); // maze south
  pk(world, 'weapon', 20, 0.2, 50, { weapon: 'scatter' });   // north hall
  pk(world, 'weapon', 45, -4.8, 0, { weapon: 'whomper' });   // basement mid lane, clear of the red spawn
  pk(world, 'weapon', -15, 0.2, -12, { weapon: 'sidewinder' });
  pk(world, 'weapon', 6, 9.2, 6, { weapon: 'parasite' });        // mid tower upper deck
  pk(world, 'ammo', 55, -4.8, 8, { weapon: 'whomper' });
  pk(world, 'ammo', -15, 0.2, -20, { weapon: 'sidewinder' });
  pk(world, 'ammo', -4, 9.2, 6, { weapon: 'parasite' });
  pk(world, 'ammo', 60, -4.8, 0, { weapon: 'zooka' });
  pk(world, 'ammo', 75, 0.2, -10, { weapon: 'hyper' });
  pk(world, 'ammo', -35, 0.2, 10, { weapon: 'pulsar' });
  pk(world, 'ammo', 2, 4.2, -6, { weapon: 'scatter' });
  pk(world, 'ammo', 20, 0.2, -50, { weapon: 'pulsar' });
  pk(world, 'ammo', -21.5, 5.2, 44, { weapon: 'hyper' });   // hall ledge end
  pk(world, 'health', -60, 0.2, 50);
  pk(world, 'health', -65, 0.2, -47);
  pk(world, 'health', -15, 0.2, 12);
  pk(world, 'health', 25, 0.2, 0);
  pk(world, 'health', 50, -4.8, -26);
  pk(world, 'health', 2, 9.2, 3.5);
  pk(world, 'star', -2, 9.4, 2, { hidden: true });       // mid tower, tucked away from the upper spawn
  pk(world, 'star', 75, 0.2, 10, { hidden: true });      // east ledge end
  pk(world, 'star', -60, 2.6, -41, { hidden: true });    // atop a maze crate row
  pk(world, 'star', -21.5, 0.2, 10, { hidden: true });   // beneath the balcony

  // Waypoints
  const wps = [
    // NW room (ground + under-mezz) and mezzanine
    [-60, 0, 8], [-35, 0, 8], [-65, 0, 25], [-45, 0, 25], [-60, 0, 45], [-35, 0, 45],
    [-74, 2.5, 20], [-70, 5, 40], [-50, 5, 40], [-32, 5, 40],
    // west doors + wing mid door
    [-25, 0, -26], [-25, 0, 26], [-50, 0, 0],
    // SW room (maze)
    [-60, 0, -8], [-35, 0, -8], [-62, 0, -22], [-45, 0, -22], [-60, 0, -34],
    [-40, 0, -45], [-65, 0, -50], [-32, 0, -35],
    [-74, 0, -48], [-74, 0, -30], [-74, 0, -12],   // west corridor past the maze rows
    [-28, 0, -47], [-22, 0, -47],                  // secret crawlway maze ↔ south hall
    // atrium floor + pads
    [-12, 0, -20], [-12, 0, 20],
    [25, 0, -12], [25, 0, 12],
    [2, 0, -24], [2, 0, 24], [2, 0, -14], [2, 0, 14], [14, 0, -14], [14, 0, 14],
    // east gallery + ramp mids
    [25, 3.1, 0], [25, 3.1, -15], [25, 3.1, 15], [25, 1.5, 23.5], [25, 1.5, -23.5],
    // halls (enclosed corridors) + their doors + basement drop points
    [-15, 0, 42], [5, 0, 42], [20, 0, 42], [-15, 0, -42], [5, 0, -42], [20, 0, -42],
    [-8, 0, 28], [16, 0, 28], [-8, 0, -28], [16, 0, -28],
    [27, 0, 42], [27, 0, -42], [34, -5, 42], [34, -5, -42],
    [50, 0, -51], [50, -2.5, -45], [62, 0, 51], [62, -2.5, 45],
    [-50, 0, 30],
    // tower: ramp mids, base ledge (corners route around the mid block), mid, top
    [-11.5, 2, 0], [15.5, 2, 0],
    [2, 4, 6.5], [2, 4, -6], [-4, 4, 0], [8, 4, 0],
    [8.5, 4, 6.5], [8.5, 4, -6.5], [-4.5, 4, 6.5], [-4.5, 4, -6.5],
    [2, 9, 3], [2, 14.4, -7],
    // balcony (runs into the ledge above the north hall)
    [-21.5, 5, -22], [-21.5, 5, 0], [-21.5, 5, 20], [-21.5, 5, 40],
    // east doors + bridge + ledge
    [30, 0, -26], [30, 0, 26], [30, 0, 0],
    [40, 0, 0], [55, 0, 0], [66, 0, 0], [73, 0, 8], [73, 0, -8],
    // under-map subway tunnel: lower doorway, buried run, ramp exits
    [32, -5, 0], [24, -5, 0], [5, -5, 0], [-14, -5, 0], [-32, -5, 0], [-52, -5, 0],
    [-62, -3, 0], [-70, 0, 0], [5, -2.5, 12], [5, 0, 22], [-32, -2.5, -12], [-32, 0, -22],
    // basement
    [37, -2.5, -26], [37, -2.5, 26],
    [50, -5, -45], [50, -5, -36], [62, -5, -25], [72, -5, -14], [72, -5, -4],
    [62, -5, 9], [62, -5, 16], [62, -5, 24], [62, -5, 38],
    [64, -5, -30], [72, -5, -45], [48, -5, 0], [64, -5, 0], [62, -5, 14], [64, -5, 30], [72, -5, 45],
  ];
  for (const [x, y, z] of wps) wp(world, x, y, z);
  world.manualLinks.push(
    [-12, 0, -20, -21.5, 5, -22, true],   // pad → balcony
    [-12, 0, 20, -21.5, 5, 20, true],
    [2, 4, 6.5, 2, 9, 3, true],           // pad → mid tower
    [2, 9, 3, 2, 14.4, -7, true],         // pad → top platform
    [2, 14.4, -7, 2, 4, -6, true],        // step off the top to descend
    [-21.5, 5, -22, -12, 0, -20, true],   // hop down from balcony
    [-21.5, 5, 40, -15, 0, 42, true],     // ledge → north hall floor
    [27, 0, 42, 34, -5, 42, true],        // hall drop-doors → basement
    [27, 0, -42, 34, -5, -42, true],
    [5, -5, 0, 5, 0, 22],                 // subway-tunnel side ramp
    [-32, -5, 0, -32, 0, -22],
    [-52, -5, 0, -70, 0, 0],              // far ramp out
  );
  addBlastComplexPresentation(scene, world);
  mergeStatic(scene, world);
  return world;
}

function addFortressPresentation(scene, world) {
  const essential = new THREE.Group();
  const standard = new THREE.Group();
  const high = new THREE.Group();
  essential.name = 'fortress-essential-presentation';
  standard.name = 'fortress-standard-presentation';
  high.name = 'fortress-high-presentation';
  scene.add(essential, standard, high);

  const surfaceBatch = (parent, color, geometries, opacity = 1) => {
    const merged = mergeGeometries(geometries, false);
    const mesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({
      color,
      transparent: opacity < 1,
      opacity,
      side: THREE.DoubleSide,
      depthWrite: opacity >= 1,
      toneMapped: false,
      ...DECOR_DEPTH_BIAS,
    }));
    parent.add(mesh);
    for (const geometry of geometries) geometry.dispose();
    return mesh;
  };
  const wallPlane = (x, y, z, w, h, yaw = 0) => {
    const geometry = new THREE.PlaneGeometry(w, h);
    geometry.rotateY(yaw);
    geometry.translate(x, y, z);
    return geometry;
  };
  const floorPlane = (x, y, z, w, d) => {
    const geometry = new THREE.PlaneGeometry(w, d);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(x, y, z);
    return geometry;
  };

  // Cyan waterline insets make the canal readable as a deliberate central
  // route. The planes sit on the solid trench faces and do not change cover.
  surfaceBatch(essential, 0x43dcff, [
    wallPlane(0, -2.1, 7.09, 145.6, 0.32, Math.PI),
    wallPlane(0, -2.1, -7.09, 145.6, 0.32),
  ], 0.9);

  // Bridge markings distinguish the three crossings at a glance without
  // adding non-colliding volume above their existing deck silhouettes.
  surfaceBatch(essential, 0xffd34d, [
    floorPlane(-3.15, 0.012, 0, 0.42, 15.8),
    floorPlane(3.15, 0.012, 0, 0.42, 15.8),
    floorPlane(-40, 0.012, 0, 0.44, 15.8),
    floorPlane(40, 0.012, 0, 0.44, 15.8),
  ], 0.94);

  registerWallFeature(world, 'south', 'target poster', -30, 6.5, 7, 7);
  registerWallFeature(world, 'north', 'Rumble poster', 30, 6.5, 7, 7);
  registerWallFeature(world, 'east', 'hazard poster', 20, 5.5, 8, 8);
  registerWallFeature(world, 'west', 'Rumble poster', -20, 5.5, 8, 8);

  // Paired falls leave the east and west edges of the high center platform,
  // framing its north-south bridge approach without covering the walkway. Use
  // the same complete stream, scalloped foam, ripple, and bubble treatment as
  // Canopy and Olympus; only the fall plane's axis differs here.
  for (const [x, outward] of [[-4.54, -1], [4.54, 1]]) {
    addWaterfall(scene, world, x, 0, 5.2, 22.1, -3.1, 19, outward, {
      axis: 'x',
      skipLip: true,
    });
  }

  // Repeated shield crests break up the long blank lane walls. Instancing
  // keeps the whole set to one draw call; they remain flush wall decoration.
  const crestGeo = new THREE.RingGeometry(0.52, 0.72, 20);
  const crestMat = new THREE.MeshBasicMaterial({
    color: 0xffd34d,
    side: THREE.DoubleSide,
    toneMapped: false,
    ...DECOR_DEPTH_BIAS,
  });
  const crestData = [];
  // Keep the outer crests inset from the ends of their wall segments. Placing
  // a ring directly on x = +/-62 centered it on the wall edge, leaving half
  // the decoration floating in open space.
  for (const x of [-58, -48, -24, 24, 48, 58]) {
    crestData.push({ x, y: 4.2, z: 21.23, yaw: Math.PI });
    crestData.push({ x, y: 4.2, z: -21.23, yaw: 0 });
  }
  const crests = new THREE.InstancedMesh(crestGeo, crestMat, crestData.length);
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < crestData.length; i++) {
    const crest = crestData[i];
    matrix.compose(
      new THREE.Vector3(crest.x, crest.y, crest.z),
      new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), crest.yaw),
      V(1, 1, 1),
    );
    crests.setMatrixAt(i, matrix);
  }
  standard.add(crests);

  // High-tier banners are cloth planes, clearly non-solid and kept away from
  // combat sightlines. A subtle sway sells the open-air fortress setting.
  const bannerMat = new THREE.MeshBasicMaterial({
    color: 0xff5c35,
    transparent: true,
    opacity: 0.88,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const banners = [];
  for (const [x, z, yaw] of [[-67, 44.72, Math.PI], [67, -44.72, 0]]) {
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 5.8), bannerMat.clone());
    banner.position.set(x, 6.1, z);
    banner.rotation.y = yaw;
    high.add(banner);
    banners.push(banner);
  }
  registerWallFeature(world, 'north', 'west royal banner', -67, 6.1, 3.2, 5.8);
  registerWallFeature(world, 'south', 'east royal banner', 67, 6.1, 3.2, 5.8);

  world.anim.push((dt, t) => {
    for (let i = 0; i < banners.length; i++) {
      banners[i].rotation.z = Math.sin(t * 1.6 + i * 2.1) * 0.035;
    }
  });

  world.setVisualQuality = tier => {
    essential.visible = true;
    standard.visible = tier !== 'low';
    high.visible = tier === 'high';
  };
  world.setVisualQuality('high');
}

/* ============ MAP 2 — FORTRESS FALLS (150×90: trench, keep, towers) ============ */
function addOldWestCactus(scene, world, x, z, height = 4.8, rotation = 0) {
  const cactus = new THREE.Group();
  const cactusTexture = aiTex('cactus-skin', 1.35, 2.6);
  cactusTexture.normalScale?.set(0.92, 0.92);
  const green = new THREE.MeshStandardMaterial({
    color: cactusTexture.map ? 0xffffff : 0x4f9b55,
    roughness: 0.94, metalness: 0.07, envMapIntensity: 0.48,
    flatShading: true, ...cactusTexture,
  });
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.56, height, 9), green);
  trunk.position.y = height / 2;
  cactus.add(trunk);
  for (const [side, armY, armHeight] of [[-1, height * 0.48, height * 0.34], [1, height * 0.63, height * 0.27]]) {
    const horizontal = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.3, 1.25, 8), green);
    horizontal.rotation.z = Math.PI / 2;
    horizontal.position.set(side * 0.62, armY, 0);
    cactus.add(horizontal);
    const upright = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, armHeight, 8), green);
    upright.position.set(side * 1.2, armY + armHeight * 0.38, 0);
    cactus.add(upright);
  }
  cactus.position.set(x, 0, z);
  cactus.rotation.y = rotation;
  cactus.traverse(child => { if (child.isMesh) child.castShadow = child.receiveShadow = true; });
  scene.add(cactus);
  world.colliders.push({ type: 'box', min: V(x - 0.58, 0, z - 0.58), max: V(x + 0.58, height, z + 0.58) });
  (world.cactusHazards ||= []).push({ x, z, radius: 0.58 });
}

function addOldWestCactusContactDamage(world) {
  world.postCharacterMove = (character) => {
    if (!character?.alive) return;
    const previousContacts = character._oldWestCactusContacts || new Set();
    const currentContacts = new Set();
    const characterRadius = character.radius || 0.4;
    for (let i = 0; i < world.cactusHazards.length; i++) {
      const cactus = world.cactusHazards[i];
      const dx = character.pos.x - cactus.x;
      const dz = character.pos.z - cactus.z;
      const contactRadius = cactus.radius + characterRadius + 0.14;
      if (dx * dx + dz * dz > contactRadius * contactRadius) continue;
      currentContacts.add(i);
      if (!previousContacts.has(i)) world.onCactusHit?.(character);
    }
    // A cactus cannot hit again until the rider has physically separated from
    // it. This makes each collision exactly one five-damage impact rather than
    // frame-rate-dependent damage while the movement collider holds them back.
    character._oldWestCactusContacts = currentContacts;
  };
}

function addOldWestHill(scene, world, x, z, rx, height, rz, color = 0xb95f35, collide = true) {
  const ry = Math.max(11, height * 2.1);
  const centerY = height - ry;
  const geometry = new THREE.IcosahedronGeometry(1, 3);
  geometry.scale(rx, ry, rz);
  const hill = new THREE.Mesh(geometry, mat(color, { tex: 'rock', repeat: [8, 5], roughness: 0.98, flatShading: true }));
  hill.position.set(x, centerY, z);
  hill.castShadow = hill.receiveShadow = true;
  scene.add(hill);
  if (collide) {
    world.colliders.push(triangleMeshColliderFromMesh(hill, 'old-west-wide-hill'));
  }
}

function addOldWestArch(scene, world, x, z) {
  const red = 0xa83f24;
  addBox(scene, world, x - 10, 3.5, z, 5.5, 7, 6.5, red, { tex: 'rock', repeat: [2, 3] });
  addBox(scene, world, x + 10, 3.5, z, 5.5, 7, 6.5, red, { tex: 'rock', repeat: [2, 3] });
  const arch = new THREE.Mesh(
    new THREE.TorusGeometry(10, 2.8, 9, 34, Math.PI),
    mat(red, { tex: 'rock', repeat: [5, 2], roughness: 0.98, flatShading: true }),
  );
  arch.position.set(x, 5.2, z);
  arch.castShadow = arch.receiveShadow = true;
  scene.add(arch);
  world.colliders.push({
    type: 'box',
    min: V(x - 8.5, 10.4, z - 3.1),
    max: V(x + 8.5, 15.8, z + 3.1),
    debugName: 'red-stone-arch-crown',
  });
}

function addOldWestCliff(scene, world) {
  const centerX = 50, centerZ = -40;
  const length = 120, width = 66;
  const lowY = 0, highY = 28;
  // Keep the cliff south of the railway, but close enough that its low
  // southeast end is part of the central fight rather than an outer-edge ride.
  // The tall drop continues to face northwest into the arena.
  const yaw = Math.atan2(40, -70);
  const cos = Math.cos(yaw), sin = Math.sin(yaw);
  const toWorld = (along, y, cross) => V(
    centerX + along * cos - cross * sin,
    y,
    centerZ + along * sin + cross * cos,
  );
  const sections = [
    [-60, 56], [-46, 61], [-31, 64], [-15, 67],
    [0, 66], [16, 69], [31, 65], [46, 62], [60, 58],
  ].map(([along, sectionWidth]) => ({
    along,
    width: sectionWidth,
    y: lowY + (highY - lowY) * (along / length + 0.5),
  }));
  const positions = [];
  const colors = [];
  const palette = [0x8d3524, 0xa84428, 0xb65331, 0x963823, 0xc15e35];
  const pushTri = (a, b, c, color) => {
    const tint = new THREE.Color(color);
    // The cliff is authored from its outer shell. Keep every triangle wound
    // outward; the previous order pointed the normals into the rock, which
    // culled whichever near face the camera was looking directly at.
    for (const p of [a, c, b]) {
      positions.push(p.x, p.y, p.z);
      colors.push(tint.r, tint.g, tint.b);
    }
  };
  for (let i = 0; i < sections.length - 1; i++) {
    const a = sections[i], b = sections[i + 1];
    const al = toWorld(a.along, a.y, -a.width / 2);
    const ar = toWorld(a.along, a.y, a.width / 2);
    const bl = toWorld(b.along, b.y, -b.width / 2);
    const br = toWorld(b.along, b.y, b.width / 2);
    const abl = toWorld(a.along, -0.45, -a.width / 2);
    const abr = toWorld(a.along, -0.45, a.width / 2);
    const bbl = toWorld(b.along, -0.45, -b.width / 2);
    const bbr = toWorld(b.along, -0.45, b.width / 2);
    pushTri(al, bl, br, palette[(i + 2) % palette.length]);
    pushTri(al, br, ar, palette[(i + 2) % palette.length]);
    pushTri(abl, bbl, bl, palette[i % palette.length]);
    pushTri(abl, bl, al, palette[i % palette.length]);
    pushTri(ar, br, bbr, palette[(i + 1) % palette.length]);
    pushTri(ar, bbr, abr, palette[(i + 1) % palette.length]);
  }
  const low = sections[0], high = sections.at(-1);
  const lowL = toWorld(low.along, low.y, -low.width / 2);
  const lowR = toWorld(low.along, low.y, low.width / 2);
  const lowBL = toWorld(low.along, -0.45, -low.width / 2);
  const lowBR = toWorld(low.along, -0.45, low.width / 2);
  pushTri(lowBL, lowL, lowR, 0x8f3a26);
  pushTri(lowBL, lowR, lowBR, 0x8f3a26);
  const highL = toWorld(high.along, high.y, -high.width / 2);
  const highR = toWorld(high.along, high.y, high.width / 2);
  const highBL = toWorld(high.along, -0.45, -high.width / 2);
  const highBR = toWorld(high.along, -0.45, high.width / 2);
  pushTri(highBL, highR, highL, 0x7c2d20);
  pushTri(highBL, highBR, highR, 0x7c2d20);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  // Project UVs per face so the sandy rock texture stays legible on both the
  // sloped top and the tall vertical cuts. The texture is white/neutral and
  // therefore multiplies over, rather than replacing, the authored red shades.
  const uvs = [];
  const uvScale = 0.11;
  const triA = new THREE.Vector3();
  const triB = new THREE.Vector3();
  const triC = new THREE.Vector3();
  const triNormal = new THREE.Vector3();
  for (let i = 0; i < positions.length; i += 9) {
    triA.fromArray(positions, i);
    triB.fromArray(positions, i + 3);
    triC.fromArray(positions, i + 6);
    triNormal.subVectors(triB, triA).cross(triC.clone().sub(triA)).normalize();
    const ax = Math.abs(triNormal.x);
    const ay = Math.abs(triNormal.y);
    const az = Math.abs(triNormal.z);
    for (const point of [triA, triB, triC]) {
      if (ay >= ax && ay >= az) uvs.push(point.x * uvScale, point.z * uvScale);
      else if (ax >= az) uvs.push(point.z * uvScale, point.y * uvScale);
      else uvs.push(point.x * uvScale, point.y * uvScale);
    }
  }
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  const cliff = new THREE.Mesh(geometry, mat(0xffffff, {
    tex: 'rock', vertexColors: true, roughness: 0.99, metalness: 0,
    flatShading: true, repeat: [1, 1],
  }));
  cliff.castShadow = cliff.receiveShadow = true;
  scene.add(cliff);

  const extentX = Math.abs(cos) * length / 2 + Math.abs(sin) * width / 2;
  const extentZ = Math.abs(sin) * length / 2 + Math.abs(cos) * width / 2;
  const ramp = {
    oriented: true, centerX, centerZ, length, width, yaw, h0: lowY, h1: highY,
    solidToGround: true, solidBottom: -0.45,
    minX: centerX - extentX, maxX: centerX + extentX,
    minZ: centerZ - extentZ, maxZ: centerZ + extentZ,
  };
  world.ramps.push(ramp);
  world.oldWestCliffRamp = ramp;

  // Embedded crags roughen the high half of the formation. They sit inside
  // the main mass, so there are no detached or floating decorative strips.
  for (const [along, cross, sx, sy, sz, shade] of [
    [18,-24,11,5,8,0x873021], [31,22,9,6,11,0xa83f27],
    [44,-15,13,7,9,0x913522], [52,16,10,8,8,0xb34b2b],
  ]) {
    const rock = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1, 1),
      mat(shade, { tex: 'rock', repeat: [3, 2], roughness: 1, flatShading: true }),
    );
    const surfaceY = lowY + (highY - lowY) * (along / length + 0.5);
    rock.position.copy(toWorld(along, surfaceY - sy * 0.65, cross));
    rock.scale.set(sx, sy, sz);
    rock.rotation.set(0.18, -yaw * 0.55 + along * 0.006, -0.12);
    rock.castShadow = rock.receiveShadow = true;
    scene.add(rock);
    const rotation = rock.quaternion.clone();
    world.colliders.push({
      type: 'ellipsoid',
      center: rock.position.clone(),
      radii: V(sx, sy, sz),
      rotation,
      inverseRotation: rotation.clone().invert(),
      debugName: 'old-west-cliff-boulder',
    });
  }
}

function addOldWestRideBoundary(world) {
  // The desert continues visually into the horizon; this boundary is purely
  // behavioral, letting riders approach it before the horse turns inward.
  const { halfX, halfZ } = RED_ROCK_RANGE_BOUNDS;
  const margin = 4.5;
  world.rideBoundary = { halfX, halfZ, margin };
  world.anim.push((dt, t, characters) => {
    for (const ch of characters) {
      if (!ch?.alive || !ch.pos || !ch.vel) continue;
      const ax = Math.abs(ch.pos.x), az = Math.abs(ch.pos.z);
      const atEdge = ax >= halfX || az >= halfZ;
      const nearEdge = ax >= halfX - margin || az >= halfZ - margin;
      if (!nearEdge) continue;

      const inward = V(-ch.pos.x / (halfX * halfX), 0, -ch.pos.z / (halfZ * halfZ));
      if (inward.lengthSq() < 1e-6) inward.set(0, 0, -1);
      inward.normalize();
      const outwardMotion = ch.vel.x * -inward.x + ch.vel.z * -inward.z;
      if (!atEdge && outwardMotion <= 0.05) continue;

      if (atEdge) {
        ch.pos.x = Math.max(-halfX, Math.min(halfX, ch.pos.x));
        ch.pos.z = Math.max(-halfZ, Math.min(halfZ, ch.pos.z));
        const returnSpeed = world.playerSpeed * (ch.isPlayer ? 1.05 : 0.86);
        ch.vel.x = inward.x * returnSpeed;
        ch.vel.z = inward.z * returnSpeed;
      } else {
        ch.vel.x += inward.x * world.playerSpeed * dt * 2.8;
        ch.vel.z += inward.z * world.playerSpeed * dt * 2.8;
      }

      if (ch.isPlayer) ch.horseHeading = Math.atan2(-inward.x, -inward.z);
      else ch.horseHeading = Math.atan2(inward.x, inward.z);
      ch.galloping = false;
    }
  });
}

function addOldWestStorefront(scene, { x, z, w, d, label, accent, kind }) {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 640;
  const g = canvas.getContext('2d');

  // One painted panel covers the whole street-facing wall. The plank seams,
  // faded trim, lettering, windows, and doors are all intentionally flat so
  // the little frontier buildings stay readable without becoming doorways or
  // snagging a mounted player on extra collision geometry.
  g.fillStyle = '#c68a50';
  g.fillRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y += 54) {
    g.fillStyle = y % 108 === 0 ? 'rgba(88,45,24,.12)' : 'rgba(255,224,164,.08)';
    g.fillRect(0, y, canvas.width, 5);
  }
  for (let i = 0; i < 70; i++) {
    const px = (i * 173) % canvas.width;
    const py = (i * 97) % canvas.height;
    g.fillStyle = `rgba(75,38,22,${0.025 + (i % 4) * 0.012})`;
    g.fillRect(px, py, 18 + (i % 6) * 8, 3);
  }

  g.fillStyle = accent;
  g.fillRect(55, 35, canvas.width - 110, 172);
  g.strokeStyle = '#4a2819';
  g.lineWidth = 18;
  g.strokeRect(55, 35, canvas.width - 110, 172);
  g.strokeStyle = '#e7bd72';
  g.lineWidth = 5;
  g.strokeRect(78, 58, canvas.width - 156, 126);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `900 ${label.length > 9 ? 94 : 112}px Georgia, serif`;
  g.lineWidth = 13;
  g.strokeStyle = '#3a2117';
  g.strokeText(label, canvas.width / 2, 121);
  g.fillStyle = '#f4d492';
  g.fillText(label, canvas.width / 2, 121);

  const window = (cx, cy, ww = 210, wh = 225) => {
    g.fillStyle = '#422b25';
    g.fillRect(cx - ww / 2 - 16, cy - wh / 2 - 16, ww + 32, wh + 32);
    g.fillStyle = '#315866';
    g.fillRect(cx - ww / 2, cy - wh / 2, ww, wh);
    const shine = g.createLinearGradient(cx - ww / 2, cy - wh / 2, cx + ww / 2, cy + wh / 2);
    shine.addColorStop(0, 'rgba(218,237,214,.5)');
    shine.addColorStop(.42, 'rgba(218,237,214,.08)');
    shine.addColorStop(.45, 'rgba(255,255,255,.38)');
    shine.addColorStop(.58, 'rgba(255,255,255,.05)');
    g.fillStyle = shine;
    g.fillRect(cx - ww / 2, cy - wh / 2, ww, wh);
    g.strokeStyle = '#d4a15f';
    g.lineWidth = 12;
    g.beginPath();
    g.moveTo(cx, cy - wh / 2); g.lineTo(cx, cy + wh / 2);
    g.moveTo(cx - ww / 2, cy); g.lineTo(cx + ww / 2, cy);
    g.stroke();
  };
  const door = (cx, top, ww = 205, hh = 300) => {
    g.fillStyle = '#3c241a';
    g.fillRect(cx - ww / 2 - 18, top - 18, ww + 36, hh + 18);
    g.fillStyle = kind === 'hotel' ? '#38576a' : '#7b3f27';
    g.fillRect(cx - ww / 2, top, ww, hh);
    g.strokeStyle = '#d4a15f';
    g.lineWidth = 11;
    g.strokeRect(cx - ww / 2 + 24, top + 28, ww - 48, hh - 56);
    g.fillStyle = '#e4b75e';
    g.beginPath(); g.arc(cx + ww * .28, top + hh * .55, 11, 0, Math.PI * 2); g.fill();
  };

  if (kind === 'saloon') {
    window(230, 405, 190, 205);
    window(794, 405, 190, 205);
    // Painted batwing doors make the saloon distinct even at gallop speed.
    g.fillStyle = '#40251a';
    g.fillRect(386, 260, 252, 330);
    for (const side of [-1, 1]) {
      g.fillStyle = '#8d4328';
      g.beginPath();
      g.moveTo(512 + side * 8, 350);
      g.lineTo(512 + side * 118, 306);
      g.lineTo(512 + side * 118, 520);
      g.lineTo(512 + side * 8, 558);
      g.closePath(); g.fill();
      g.strokeStyle = '#d4a15f'; g.lineWidth = 9; g.stroke();
    }
  } else if (kind === 'hotel') {
    window(215, 405, 180, 215);
    door(512, 286, 190, 304);
    window(809, 405, 180, 215);
  } else {
    window(215, 405, 190, 215);
    door(512, 286, 210, 304);
    window(809, 405, 190, 215);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  const facade = new THREE.Mesh(
    new THREE.PlaneGeometry(w - 0.5, 6),
    new THREE.MeshStandardMaterial({ map: texture, roughness: 0.92, side: THREE.DoubleSide, ...DECOR_DEPTH_BIAS }),
  );
  // Face the town street (-Z) so the lettering is not mirrored from the side
  // players actually approach.
  facade.rotation.y = Math.PI;
  facade.position.set(x, 3.15, z - d / 2 - SURFACE_LAYER_EPS);
  facade.castShadow = false;
  facade.receiveShadow = true;
  scene.add(facade);
}

function addOldWestRailroad(scene, world) {
  const railZ = 35;
  const horizonLength = 1500;
  const iron = 0x4a4039;
  const tieWood = 0x573722;
  // Keep every rail component below a horse's step height and visual-only.
  // The line can therefore cross the full range without turning into hundreds
  // of tiny movement colliders.
  addBox(scene, world, 0, 0.035, railZ, horizonLength, 0.07, 7.5, 0x805338, {
    tex: 'rock', repeat: [190, 2], collide: false,
  });
  for (let x = -horizonLength / 2 + 3; x <= horizonLength / 2 - 3; x += 4) {
    addBox(scene, world, x, 0.13, railZ, 0.62, 0.22, 6.4, tieWood, {
      collide: false, shadow: false, roughness: 1,
    });
  }
  for (const z of [railZ - 2, railZ + 2]) {
    addBox(scene, world, 0, 0.29, z, horizonLength, 0.2, 0.22, iron, {
      collide: false, metalness: 0.72, roughness: 0.34,
    });
  }

  // A low timber depot platform sits between the storefronts and the track,
  // turning the painted façades into a proper station-facing town frontage.
  addBox(scene, world, -32, 0.38, 45.5, 86, 0.76, 9.5, tieWood, {
    tex: 'panel', repeat: [15, 2], debugName: 'old-west-station-platform',
  });
  addBox(scene, world, -32, 0.82, 41.05, 86, 0.14, 0.25, 0xd4a568, {
    collide: false, shadow: false,
  });
}

function buildOldWest(scene) {
  const world = newWorld({
    killY: -25, playerSpeed: 13, waypointLinkDist: 72, waypointLinkDy: 7.5,
    mounted: true, horseTurnRate: 1.45, horseGallopSpeed: 20.5,
    horseGallopDuration: 15, horseGallopRecharge: 0.65,
  });
  scene.background = new THREE.Color(0x79b6d0);
  const horizonExtension = RED_ROCK_RANGE_BOUNDS.expansionPerEdge;
  scene.fog = new THREE.Fog(0xd8a366, 300 + horizonExtension, 920 + horizonExtension);
  baseLighting(scene, 0xffd9a4, 0x71402c, [-85, 125, 55], 260);
  addDaytimeSkyDome(scene);

  // One uninterrupted ground mesh runs beneath both the arena and its distant
  // horizon. The horse's invisible ride boundary controls play space without
  // introducing a second material, UV island, overlap, or visible join.
  addBox(scene, world, 0, -0.65, 0, 1600, 1.3, 1600, 0xc77b45, {
    tex: 'rock', repeat: [223, 223], debugName: 'old-west-continuous-desert',
  });
  addOldWestHill(scene, world, -140, 112, 58, 9, 42, 0xb75b31);
  addOldWestHill(scene, world, 132, 108, 52, 7.5, 58, 0xc46d3b);
  addOldWestHill(scene, world, -55, -78, 42, 6.5, 36, 0xb85a32);
  addOldWestArch(scene, world, -145, -45);
  addOldWestCliff(scene, world);
  addOldWestRailroad(scene, world);
  addOldWestRideBoundary(world);

  // Distant formations are scenery only: they sell a continuous Utah desert
  // beyond the ride boundary and dissolve into the warm horizon fog.
  for (const spec of [
    [-430,250,150,58,105,0x9a482e], [390,-330,190,70,120,0xa95331],
    [470,180,105,82,70,0x8d3b28], [-330,-410,170,48,130,0xb45b35],
  ]) addOldWestHill(scene, world, ...spec, false);

  const timber = 0x784625, plaster = 0xd4a568, roof = 0x5d3022;
  for (const [x, z, w, d, label, accent, kind] of [
    [-48, 62, 15, 10, 'GENERAL STORE', '#7f3b29', 'store'],
    [-27, 66, 18, 12, 'HOTEL', '#315e73', 'hotel'],
    [-2, 63, 14, 10, 'SALOON', '#8a472a', 'saloon'],
  ]) {
    addBox(scene, world, x, 3.2, z, w, 6.4, d, plaster, { tex: 'panel', repeat: [3, 2] });
    addBox(scene, world, x, 6.8, z, w + 1.2, 0.8, d + 1.2, roof, { tex: 'rock', repeat: [3, 2] });
    addOldWestStorefront(scene, { x, z, w, d, label, accent, kind });
    for (const sx of [-1, 1]) addBox(scene, world, x + sx * (w / 2 - 0.7), 1.6, z - d / 2 - 2.1, 0.45, 3.2, 0.45, timber);
    addBox(scene, world, x, 0.35, z - d / 2 - 2.1, w, 0.7, 4, timber, { tex: 'panel', repeat: [4, 1] });
  }
  // The plain side walls keep the tournament art clear of storefront signs,
  // windows, porches, and the mounted combat line through town.
  addDecal(scene, 'poster-oldwest', -55.56, 3.2, 62, 5.2, -Math.PI / 2);
  addDecal(scene, 'poster-oldwest', 5.06, 3.2, 63, 5.2, Math.PI / 2);

  const cactusSpecs = [
    [-205,-145,5.8,.2],[-178,-65,4.5,1.1],[-202,142,5.1,2.4],[-154,126,4.3,.7],
    [-118,-142,5.5,2.8],[-105,142,4.7,1.6],[-72,-118,3.9,.4],[-62,132,5.6,2.1],
    [22,-148,4.6,1.3],[35,142,5.2,2.7],[82,130,4.2,.8],[105,-143,5.9,1.9],
    [196,-118,4.8,2.5],[208,-8,5.4,.5],[172,135,4.1,1.5],[-210,12,4.9,2.9],
    [-105,2,3.8,.9],[80,5,4.5,2.2],[-20,-20,3.9,.3],[-52,18,4.2,1.7],
    [145,-32,5.4,.6],[188,72,4.6,1.8],[-165,45,5.1,2.5],[12,112,4.3,.9],
    [122,152,5.8,2.2],[-22,-132,4.7,1.4],[204,118,4.2,.2],[-192,-15,5.2,2.8],
  ];
  for (const spec of cactusSpecs) addOldWestCactus(scene, world, ...spec);
  addOldWestCactusContactDamage(world);

  world.spawns.blue = [V(-190, 0.1, -108), V(-190, 0.1, 0), V(-190, 0.1, 108), V(-142, 0.1, -30)];
  world.spawns.red = [V(190, 0.1, 108), V(190, 0.1, 0), V(190, 0.1, -108), V(175, 0.1, -45)];
  world.spawns.ffa = [
    V(-190,0.1,-108), V(190,0.1,108), V(-190,0.1,108), V(190,0.1,-108),
    V(0,0.1,-152), V(0,0.1,152), V(-172,0.1,0), V(172,0.1,0),
  ];
  // The enlarged range needs a broad open-ground graph; otherwise bots would
  // only navigate inside the original central footprint. Exclude authored
  // hills, the frontier buildings, and the cliff, then link their dedicated
  // elevated routes into this grid below.
  const cliffRamp = world.oldWestCliffRamp;
  for (let x = -200; x <= 200; x += 50) for (let z = -150; z <= 150; z += 50) {
    const inWestHill = ((x + 140) / 62) ** 2 + ((z - 112) / 46) ** 2 < 1;
    const inEastHill = ((x - 132) / 56) ** 2 + ((z - 108) / 63) ** 2 < 1;
    const inSouthwestHill = ((x + 55) / 46) ** 2 + ((z + 78) / 40) ** 2 < 1;
    const inTown = x > -62 && x < 10 && z > 48 && z < 82;
    const cliffDx = x - cliffRamp.centerX;
    const cliffDz = z - cliffRamp.centerZ;
    const cliffAlong = cliffDx * Math.cos(cliffRamp.yaw) + cliffDz * Math.sin(cliffRamp.yaw);
    const cliffCross = -cliffDx * Math.sin(cliffRamp.yaw) + cliffDz * Math.cos(cliffRamp.yaw);
    const inCliff = Math.abs(cliffAlong) < cliffRamp.length / 2 + 8 &&
      Math.abs(cliffCross) < cliffRamp.width / 2 + 8;
    if (!inWestHill && !inEastHill && !inSouthwestHill && !inTown && !inCliff) wp(world, x, 0, z);
  }
  for (const [x, y, z] of [
    [-205,0,0],[-170,0,-92],[-140,7,112],[-105,0,0],[-55,6,-78],[-62,0,132],
    [0,0,-152],[0,0,-82],[0,0,10],[-60,.8,45.5],[-30,.8,45.5],[0,.8,45.5],[0,0,142],[68,0,58],
    [132,6,108],[170,0,142],[102,0,-70],[76,7,-55],[50,14,-40],[24,21,-25],[-2,28,-10],[205,0,-85],
  ]) wp(world, x, y, z);
  world.manualLinks.push(
    [132,6,108,170,0,142], [102,0,-70,76,7,-55], [76,7,-55,50,14,-40],
    [50,14,-40,24,21,-25], [24,21,-25,-2,28,-10], [102,0,-70,150,0,-100],
    [-140,7,112,-105,0,0], [-140,7,112,-62,0,132],
    [-55,6,-78,-100,0,-100], [-55,6,-78,0,0,-50],
  );
  for (const [kind, x, y, z, extra] of [
    ['weapon', -118, 0.7, -64, { weapon: 'scatter', amount: 8 }],
    ['weapon', 72, 0.7, 18, { weapon: 'sidewinder', amount: 10 }],
    ['weapon', 5, 26.7, -14, { weapon: 'pulsar', amount: 14 }],
    ['dual-blaster', 9, 26.7, -14, {}],
    ['weapon', -145, 0.7, -45, { weapon: 'zooka', amount: 4 }],
    ['weapon', 0, 0.9, 45.5, { weapon: 'hyper', amount: 5 }],
    ['weapon', 132, 7.7, 108, { weapon: 'parasite', amount: 8 }],
    ['weapon', -140, 9.2, 112, { weapon: 'whomper', amount: 4 }],
    ['ammo', -185, 0.7, -85, { weapon: 'scatter' }],
    ['ammo', -70, 0.7, -145, { weapon: 'scatter' }],
    ['ammo', 155, 0.7, 5, { weapon: 'sidewinder' }],
    ['ammo', 70, 0.7, 65, { weapon: 'sidewinder' }],
    ['ammo', 25, 0.7, -105, { weapon: 'pulsar' }],
    ['ammo', 180, 0.7, -145, { weapon: 'pulsar' }],
    ['ammo', -80, 0.7, 5, { weapon: 'zooka' }],
    ['ammo', -20, 0.7, -115, { weapon: 'zooka' }],
    ['ammo', -75, 0.7, 80, { weapon: 'hyper' }],
    ['ammo', 65, 0.7, 95, { weapon: 'hyper' }],
    ['ammo', 190, 0.7, 145, { weapon: 'parasite' }],
    ['ammo', 205, 0.7, 55, { weapon: 'parasite' }],
    ['ammo', -205, 0.7, 60, { weapon: 'whomper' }],
    ['ammo', -75, 0.7, 150, { weapon: 'whomper' }],
    ['health', -42, 0.7, 46, {}],
    ['health', 50, 14.2, -40, {}],       // halfway up the cliff ramp
    ['health', -210, 0.7, 158, {}],      // far corner opposite the cliff
    ['shield', 18, 0.7, 82, {}],
    ['speed', -155, 0.7, 92, {}], ['points', 205, 0.7, -82, { amount: 250 }],
  ]) pk(world, kind, x, y, z, extra);

  // Secret Shot is granted on spawn; every other regular loadout slot must be
  // represented by a physical pickup somewhere in the range.
  const requiredWeapons = ['scatter', 'pulsar', 'sidewinder', 'zooka', 'hyper', 'parasite', 'whomper'];
  const missingWeapons = requiredWeapons.filter(weapon =>
    !world.pickups.some(pickup => pickup.kind === 'weapon' && pickup.weapon === weapon));
  if (missingWeapons.length) {
    throw new Error(`[oldwest] missing regular weapon pickup(s): ${missingWeapons.join(', ')}`);
  }
  const invalidAmmoCounts = requiredWeapons.map(weapon => ({
    weapon,
    count: world.pickups.filter(pickup => pickup.kind === 'ammo' && pickup.weapon === weapon).length,
  })).filter(({ count }) => count < 1 || count > 2);
  if (invalidAmmoCounts.length) {
    throw new Error(`[oldwest] regular weapons require 1-2 ammo pickups: ${invalidAmmoCounts
      .map(({ weapon, count }) => `${weapon}=${count}`).join(', ')}`);
  }

  // Hard invariant: no authored team or FFA spawn may sit beneath the
  // diagonal cliff. Fail during map construction instead of spawning a rider
  // inside the rock if these coordinates are ever edited into its footprint.
  const unsafeCliffSpawns = [...world.spawns.blue, ...world.spawns.red, ...world.spawns.ffa]
    .filter(spawn => {
      const dx = spawn.x - cliffRamp.centerX;
      const dz = spawn.z - cliffRamp.centerZ;
      const along = dx * Math.cos(cliffRamp.yaw) + dz * Math.sin(cliffRamp.yaw);
      const cross = -dx * Math.sin(cliffRamp.yaw) + dz * Math.cos(cliffRamp.yaw);
      if (Math.abs(along) > cliffRamp.length / 2 || Math.abs(cross) > cliffRamp.width / 2) return false;
      const surfaceY = cliffRamp.h0 + (cliffRamp.h1 - cliffRamp.h0) * (along / cliffRamp.length + 0.5);
      return spawn.y + 1 < surfaceY;
    });
  if (unsafeCliffSpawns.length) {
    throw new Error(`[oldwest] ${unsafeCliffSpawns.length} spawn point(s) are underneath the cliff`);
  }

  mergeStatic(scene, world);
  return world;
}

function buildFortress(scene) {
  const world = newWorld({
    killY: -20,
    waypointLinkDist: 22,
    waypointLinkDy: 4.6,
    waypointLinkClearance: 0.35,
  });
  const fortress = {
    courtyard: 0xd2c39b,
    canalBed: 0x275e74,
    sandstone: 0x9a7e55,
    rampStone: 0xb09062,
    perimeter: 0x493b68,
    royalDark: 0x4a3177,
    royal: 0x7655b8,
    royalMid: 0x65459f,
    royalShadow: 0x392b57,
    bridge: 0xcf5730,
    cyanStone: 0x47cbe1,
    limeStone: 0x82c653,
    hotOrange: 0xe86632,
    gold: 0xffd34d,
  };
  scene.background = new THREE.Color(0x83c5df);
  scene.fog = new THREE.Fog(0x9ed3e7, 135, 420);
  baseLighting(scene, 0xd4efff, 0x59425f, [-70, 110, 50], 120);
  addDaytimeSkyDome(scene);

  // Ground slabs split by trench (z −7..7, floor top −4)
  addBox(scene, world, 0, -0.5, 26, 154, 1, 38, fortress.courtyard, { tex: 'fortress-floor', repeat: [20, 5] });
  addBox(scene, world, 0, -0.5, -26, 154, 1, 38, fortress.courtyard, { tex: 'fortress-floor', repeat: [20, 5] });
  addBox(scene, world, 0, -4.5, 0, 154, 1, 14, fortress.canalBed, { tex: 'fortress-floor', repeat: [20, 2] });
  // Trench side walls (full length — otherwise you can slip under the ground
  // slabs at the trench ends and fall out of the world)
  addBox(scene, world, 0, -2.1, 7.55, 146, 3.8, 0.9, fortress.sandstone, { tex: 'fortress-stone', repeat: [20, 1] });   // tops 0.2 below ground level
  addBox(scene, world, 0, -2.1, -7.55, 146, 3.8, 0.9, fortress.sandstone, { tex: 'fortress-stone', repeat: [20, 1] });

  // Perimeter walls (extend below ground level). The generated royal masonry
  // is deliberately reserved for this background shell; foreground buildings
  // use contrasting stone colors so their silhouettes never disappear into it.
  // Top at y=11 gives the large arena signs and legacy posters a full metre of
  // masonry above them; only the exterior shell grows, so combat sightlines and
  // the height of every interior wall remain unchanged.
  for (const [x, z, w, d] of [[0, -47, 162, 4], [0, 47, 162, 4], [-79, 0, 4, 98], [79, 0, 4, 98]]) {
    addBox(scene, world, x, 3, z, w, 16, d, 0xffffff, { tex: 'fortress-royal' });
  }

  // Trench end ramps — run all the way to the end walls so there's no
  // 4-deep dead pocket you can drop into and never climb out of
  addRamp(scene, world, { axis: 'x', minX: -73, maxX: -55, minZ: -8, maxZ: 8, h0: 0, h1: -4, color: fortress.rampStone, tex: 'fortress-floor' });
  addRamp(scene, world, { axis: 'x', minX: 55, maxX: 73, minZ: -8, maxZ: 8, h0: -4, h1: 0, color: fortress.rampStone, tex: 'fortress-floor' });
  // solid fill between each ramp top and the perimeter wall — this used to be
  // a 4-deep pit you could fall into and only escape by crawling under the ramp
  addBox(scene, world, -75, -2.5, 0, 4, 5, 14, fortress.rampStone, { tex: 'fortress-stone' });
  addBox(scene, world, 75, -2.5, 0, 4, 5, 14, fortress.rampStone, { tex: 'fortress-stone' });

  // Canal water. Fit to the inner faces of the end ramps/fills and trench
  // walls, then tuck the plane beneath them so no dry floor strip can show.
  addFittedWater(scene, world, {
    minX: -73, maxX: 73, minZ: -7.1, maxZ: 7.1, y: -3.15,
  });
  addCanalAlligator(scene, world);

  // Bridges: grand center bridge + two side bridges
  // decks sit 2cm below bank level — flush tops z-fight where they overlap
  addBox(scene, world, 0, -0.42, 0, 9, 0.8, 20, fortress.bridge, { tex: 'fortress-deck' });
  addBox(scene, world, -40, -0.42, 0, 6, 0.8, 18, fortress.royalDark, { tex: 'fortress-deck', repeat: [1, 3] });
  addBox(scene, world, 40, -0.42, 0, 6, 0.8, 18, fortress.royalDark, { tex: 'fortress-deck', repeat: [1, 3] });
  // Castle bridge houses over the side crossings, replacing the old floating
  // end-ramp covers with something anchored to the bridge geometry.
  for (const cx of [-40, 40]) {
    const bridgeStone = fortress.cyanStone;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      addBox(scene, world, cx + sx * 5.2, 2.8, sz * 10.2, 2.2, 5.6, 2.2, bridgeStone, { tex: 'fortress-stone' });
      addBox(scene, world, cx + sx * 5.2, 5.9, sz * 10.2, 2.8, 0.6, 2.8, fortress.royal, { tex: 'fortress-deck' });
    }
    addBox(scene, world, cx, 6.1, 0, 13.5, 1.4, 23, fortress.royal, { tex: 'fortress-deck', repeat: [2, 4] });
    for (const z of [-9.6, 0, 9.6]) {
      addBox(scene, world, cx - 4.1, 7.2, z, 2.3, 0.8, 2.1, fortress.gold, { emissive: fortress.gold, emissiveIntensity: 0.25 });
      addBox(scene, world, cx + 4.1, 7.2, z, 2.3, 0.8, 2.1, fortress.gold, { emissive: fortress.gold, emissiveIntensity: 0.25 });
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      addBox(scene, world, cx + sx * 3.1, 8.7, sz * 3.2, 1.4, 3.8, 1.4, bridgeStone, { tex: 'fortress-stone' });
    }
    // The compact upper deck leaves enough lower-deck runout behind each ramp,
    // so descending players do not step straight off the bridge at its edge.
    addBox(scene, world, cx, 10.6, 0, 8.5, 0.8, 8, fortress.royal, { tex: 'fortress-deck', repeat: [2, 2] });
    for (const z of [-3.2, 0, 3.2]) {
      addBox(scene, world, cx - 3.6, 11.35, z, 1.5, 0.7, 1.5, fortress.gold, { emissive: fortress.gold, emissiveIntensity: 0.25 });
      addBox(scene, world, cx + 3.6, 11.35, z, 1.5, 0.7, 1.5, fortress.gold, { emissive: fortress.gold, emissiveIntensity: 0.25 });
    }
  }
  // Bridge access uses short level landings at every crest. A capsule reaches
  // full deck height before touching the destination box face, so walking up
  // never requires a jump. The lower ramps also sit wholly inside the lane-
  // wall door gaps instead of clipping their ends.
  addRamp(scene, world, { axis: 'z', minX: -39.2, maxX: -33.4, minZ: 12, maxZ: 25, h0: 6.8, h1: 0, color: fortress.royalMid, tex: 'fortress-deck' });
  addRamp(scene, world, { axis: 'z', minX: -39.2, maxX: -33.4, minZ: 11.5, maxZ: 12, h0: 6.8, h1: 6.8, color: fortress.royalMid, tex: 'fortress-deck' });
  addRamp(scene, world, { axis: 'z', minX: 33.4, maxX: 39.2, minZ: -25, maxZ: -12, h0: 0, h1: 6.8, color: fortress.royalMid, tex: 'fortress-deck' });
  addRamp(scene, world, { axis: 'z', minX: 33.4, maxX: 39.2, minZ: -12, maxZ: -11.5, h0: 6.8, h1: 6.8, color: fortress.royalMid, tex: 'fortress-deck' });
  addRamp(scene, world, { axis: 'z', minX: -41.7, maxX: -38.3, minZ: -9, maxZ: -4.5, h0: 6.8, h1: 11, color: fortress.royalMid, tex: 'fortress-deck' });
  addRamp(scene, world, { axis: 'z', minX: -41.7, maxX: -38.3, minZ: -4.5, maxZ: -4, h0: 11, h1: 11, color: fortress.royalMid, tex: 'fortress-deck' });
  addRamp(scene, world, { axis: 'z', minX: 38.3, maxX: 41.7, minZ: 4.5, maxZ: 9, h0: 11, h1: 6.8, color: fortress.royalMid, tex: 'fortress-deck' });
  addRamp(scene, world, { axis: 'z', minX: 38.3, maxX: 41.7, minZ: 4, maxZ: 4.5, h0: 11, h1: 11, color: fortress.royalMid, tex: 'fortress-deck' });
  // Hang the bridge-house vines from the outer faces of the purple deck, not
  // the inset cyan columns. addVine offsets each visible sheet another 0.14m
  // outward, while the climb volume at the deck edge clears the overhang.
  addVine(scene, world, -46.75, -10.2, 0.2, 6.9, 0.85, -0.24, 0);
  addVine(scene, world, -33.25, -10.2, 0.2, 6.9, 0.85, 0.24, 0);
  addVine(scene, world, 33.25, 10.2, 0.2, 6.9, 0.85, -0.24, 0);
  addVine(scene, world, 46.75, 10.2, 0.2, 6.9, 0.85, 0.24, 0);
  addVine(scene, world, -44.25, 4, 6.9, 11.1, 0.75, -0.2, 0);
  addVine(scene, world, 44.25, -4, 6.9, 11.1, 0.75, 0.2, 0);
  // Banners and targets on the perimeter walls.
  addScoreTarget(scene, world, -30, 6.5, -44.9, 7, 0);
  addDecal(scene, 'poster2', 30, 6.5, 44.9, 7, Math.PI);
  addDecal(scene, 'hazard', 76.9, 5.5, 20, 8, -Math.PI / 2);
  addDecal(scene, 'poster2', -76.9, 5.5, -20, 8, Math.PI / 2);
  addVine(scene, world, -55, -43.5, 0.2, 5.1, 0.95, 0, -0.25);
  addVine(scene, world, 53, 43.5, 0.2, 5.1, 0.9, 0, 0.25);
  addVine(scene, world, -34, -43.5, 0.2, 5.1, 0.85, 0, -0.25);
  addVine(scene, world, 33, 43.5, 0.2, 5.1, 0.85, 0, 0.25);
  // ground variety: grass courtyards, dirt lanes
  addBox(scene, world, -45, 0.031, 30, 26, 0.06, 22, 0x6aa84f, { tex: 'grass', repeat: [5, 4] });
  addBox(scene, world, 45, 0.031, -30, 26, 0.06, 22, 0x6aa84f, { tex: 'grass', repeat: [5, 4] });
  addBox(scene, world, 0, 0.031, 14.75, 100, 0.06, 8, 0xb08a5a, { tex: 'dirt', repeat: [14, 1] });
  addBox(scene, world, 0, 0.031, -14.75, 100, 0.06, 8, 0xb08a5a, { tex: 'dirt', repeat: [14, 1] });
  addBox(scene, world, -45, 0.036, -30, 20, 0.07, 16, 0xd8a8c8, { tex: 'flowers', repeat: [4, 3] });
  // floating platforms over the courtyards + pads
  addBox(scene, world, -30, 8.7, 30, 9, 0.6, 9, fortress.royal, { tex: 'fortress-deck' });
  addJumpPad(scene, world, -39, 0, 30, 24, 6.4, 0, 0x9dff70);
  pk(world, 'health', -30, 9.2, 30);
  wp(world, -39, 0, 30); wp(world, -30, 9, 30);
  world.manualLinks.push([-39, 0, 30, -30, 9, 30, true]);
  // The southeast courtyard intentionally breaks the diagonal symmetry: a
  // lower, wider siege deck uses a long ramp through the cross-wall doorway.
  // That produces a defendable mid-height fight instead of a second copy of
  // the northwest jump-pad encounter.
  addBox(scene, world, 32, 5.6, -31, 13, 0.6, 7, fortress.royal, { tex: 'fortress-deck' });
  addBox(scene, world, 28.5, 2.65, -31, 1.5, 5.3, 1.5, fortress.cyanStone, { tex: 'fortress-stone' });
  addBox(scene, world, 35.5, 2.65, -31, 1.5, 5.3, 1.5, fortress.cyanStone, { tex: 'fortress-stone' });
  addRamp(scene, world, { axis: 'x', minX: 38.5, maxX: 52, minZ: -33.7, maxZ: -28.3, h0: 5.9, h1: 0, color: fortress.royalMid, tex: 'fortress-deck' });
  pk(world, 'ammo', 32, 6.35, -31, { weapon: 'sidewinder' });
  wp(world, 32, 6, -31); wp(world, 42, 4.2, -31); wp(world, 51, 0, -31);
  // Canal escape vines: climb from the trench floor back to the banks without
  // forcing a long run to the end ramps.
  for (const [x, z, leanZ] of [
    [-58, 6.62, 0.26], [-28, -6.62, -0.26],
    [-10, 6.62, 0.26], [18, -6.62, -0.26],
    [46, 6.62, 0.26], [60, -6.62, -0.26],
  ]) {
    addVine(scene, world, x, z, -3.8, 0.55, 1.05, 0, leanZ, 0, 0, 0.68);
  }

  // THE KEEP (north-center): interior room w/ gold, walkable roof. The split
  // rear wall creates a concealed sally passage into the covered battlement
  // arcade; its roof, wall opening, and navigation route are all physical.
  addBox(scene, world, -7.5, 3.5, 37, 7, 7, 2, fortress.hotOrange, { tex: 'fortress-stone' });
  addBox(scene, world, 7.5, 3.5, 37, 7, 7, 2, fortress.hotOrange, { tex: 'fortress-stone' });
  addBox(scene, world, -7.5, 3.5, 15, 7, 7, 2, fortress.hotOrange, { tex: 'fortress-stone' }); // south wall w/ door gap
  addBox(scene, world, 7.5, 3.5, 15, 7, 7, 2, fortress.hotOrange, { tex: 'fortress-stone' });
  addBox(scene, world, -11, 3.5, 26, 2, 7, 24, fortress.hotOrange, { tex: 'fortress-stone' });
  addBox(scene, world, 11, 3.5, 26, 2, 7, 24, fortress.hotOrange, { tex: 'fortress-stone' });
  // Short rear ramp occupies only the gap between the back-wall walkway and
  // the second-floor edge: y=5 at z=41.75 to y=7.8 at z=39.
  addRamp(scene, world, { axis: 'z', minX: -3, maxX: 3, minZ: 39, maxZ: 41.75, h0: 7.8, h1: 5, color: fortress.royalMid, tex: 'fortress-deck' });
  // The original roof becomes a broad terrace around a narrower second room.
  // At 10.5m the upper room is exactly 1.5x the height of the room below. Its
  // front and back stay completely open; only the two ramp-side walls remain.
  addBox(scene, world, 0, 7.4, 26, 24, 0.8, 26, fortress.royal, { tex: 'fortress-deck' }); // second floor, top 7.8
  // Each side wall is only as long as its neighboring ramp plus that ramp's
  // small top landing, rather than spanning the entire lower keep.
  addBox(scene, world, -7, 13.05, 25.25, 2, 10.5, 17.5, fortress.hotOrange, { tex: 'fortress-stone' });
  addBox(scene, world, 7, 13.05, 26.75, 2, 10.5, 17.5, fortress.hotOrange, { tex: 'fortress-stone' });

  // Mirrored ramps now sit fully on the second-floor terrace between the
  // inset room walls and the terrace edges. Pulling both runs four metres
  // inward leaves a generous approach at each bottom landing.
  addRamp(scene, world, { axis: 'z', minX: 8, maxX: 11.5, minZ: 18, maxZ: 34, h0: 7.8, h1: 19.1, color: fortress.royalMid, tex: 'fortress-deck' });
  addRamp(scene, world, { axis: 'z', minX: -11.5, maxX: -8, minZ: 18, maxZ: 34, h0: 19.1, h1: 7.8, color: fortress.royalMid, tex: 'fortress-deck' });

  addBox(scene, world, 0, 18.7, 26, 16, 0.8, 26, fortress.royal, { tex: 'fortress-deck' }); // inset upper roof, top 19.1
  // Level top landings extend beyond each slope. Short gold end-stops
  // prevent players from carrying their momentum straight off the far ends
  // while leaving the inward turn onto the roof open.
  addBox(scene, world, 9.75, 18.9, 34.75, 3.5, 0.4, 1.5, fortress.royal, { tex: 'fortress-deck' });
  addBox(scene, world, -9.75, 18.9, 17.25, 3.5, 0.4, 1.5, fortress.royal, { tex: 'fortress-deck' });
  addBox(scene, world, 9.75, 19.6, 35.35, 3.5, 1, 0.3, fortress.gold, { tex: 'fortress-stone' });
  addBox(scene, world, -9.75, 19.6, 16.65, 3.5, 1, 0.3, fortress.gold, { tex: 'fortress-stone' });
  // Small gold crenellations crown the roof while leaving both ramp landings
  // and the north/south centerline open.
  for (const z of [13.45, 38.55]) for (const x of [-6, -2, 2, 6]) {
    addBox(scene, world, x, 19.85, z, 2.2, 1.5, 0.9, fortress.gold, { tex: 'fortress-stone' });
  }

  // A narrow high bridge continues the keep's north-south route to a lookout
  // centered over the canal. The lookout matches the nine-metre width of the
  // rust bridge directly below and provides the lip for paired side falls.
  addBox(scene, world, 0, 18.7, 8, 4, 0.8, 10, fortress.royal, { tex: 'fortress-deck' });
  addBox(scene, world, 0, 18.7, 0, 9, 0.8, 6, fortress.bridge, { tex: 'fortress-deck' });
  addVine(scene, world, -5.5, 15, 0.2, 7.9, 0.85, 0, -0.2);
  addVine(scene, world, 11, 22, 0.2, 7.9, 0.85, 0.25, 0);
  addVine(scene, world, -11, 31, 0.2, 7.9, 0.85, -0.25, 0);
  const keepLight = new THREE.PointLight(0xffd23c, 40, 24);
  keepLight.position.set(0, 5, 26);
  scene.add(keepLight);
  // Roof ramp (east side)
  addRamp(scene, world, { axis: 'x', minX: 12, maxX: 32, minZ: 24, maxZ: 30, h0: 7.8, h1: 0, color: fortress.royalMid, tex: 'fortress-deck' });

  // Climbable corner towers (NE + SW), decor towers (NW + SE)
  addBox(scene, world, 64, 3.5, 38, 9, 7, 9, fortress.cyanStone, { tex: 'fortress-stone' });
  // Extend the cap south through z=30 so the entire four-metre sky catwalk
  // lands on the tower platform rather than touching it at one narrow corner.
  addBox(scene, world, 64, 7.3, 36.5, 10, 0.6, 13, fortress.royal, { tex: 'fortress-deck' });
  addVine(scene, world, 59.5, 38, 0.2, 7.7, 0.85, -0.25, 0);
  addRamp(scene, world, { axis: 'x', minX: 46, maxX: 58.5, minZ: 35, maxZ: 41, h0: 0, h1: 7.6, color: fortress.royalMid, tex: 'fortress-deck' });
  addRamp(scene, world, { axis: 'x', minX: 58.5, maxX: 59, minZ: 35, maxZ: 41, h0: 7.6, h1: 7.6, color: fortress.royalMid, tex: 'fortress-deck' });
  addBox(scene, world, -64, 3.5, -38, 9, 7, 9, fortress.hotOrange, { tex: 'fortress-stone' });
  addBox(scene, world, -64, 7.3, -38, 10, 0.6, 10, fortress.royal, { tex: 'fortress-deck' });
  addVine(scene, world, -59.5, -38, 0.2, 7.7, 0.85, 0.25, 0);
  addRamp(scene, world, { axis: 'x', minX: -58.5, maxX: -46, minZ: -41, maxZ: -35, h0: 7.6, h1: 0, color: fortress.royalMid, tex: 'fortress-deck' });
  addRamp(scene, world, { axis: 'x', minX: -59, maxX: -58.5, minZ: -41, maxZ: -35, h0: 7.6, h1: 7.6, color: fortress.royalMid, tex: 'fortress-deck' });
  addBox(scene, world, -64, 4, 38, 7, 8, 7, fortress.limeStone, { tex: 'fortress-stone' });
  addBox(scene, world, 64, 4, -38, 7, 8, 7, fortress.gold, { tex: 'fortress-stone' });
  addVine(scene, world, -60.5, 38, 0.2, 8.1, 0.85, 0.25, 0);
  addVine(scene, world, 60.5, -38, 0.2, 8.1, 0.85, -0.25, 0);

  // Lane walls: split each field into corridors (doors at x ±36 and beside the keep)
  for (const zs of [1, -1]) {
    addBox(scene, world, -51, 3, 22 * zs, 22, 6, 1.5, fortress.sandstone, { tex: 'fortress-stone' });
    addBox(scene, world, -24, 3, 22 * zs, 16, 6, 1.5, fortress.sandstone, { tex: 'fortress-stone' });
    addBox(scene, world, 24, 3, 22 * zs, 16, 6, 1.5, fortress.sandstone, { tex: 'fortress-stone' });
    addBox(scene, world, 51, 3, 22 * zs, 22, 6, 1.5, fortress.sandstone, { tex: 'fortress-stone' });
  }
  addVine(scene, world, -51, 21.2, 0.2, 6.2, 0.85, 0, -0.2);
  addVine(scene, world, 24, -21.2, 0.2, 6.2, 0.85, 0, 0.2);
  addVine(scene, world, -24, -21.2, 0.2, 6.2, 0.8, 0, 0.2);
  addVine(scene, world, 51, -21.2, 0.2, 6.2, 0.85, 0, 0.2);

  // Battlement walkways along the north/south perimeter walls (top y=5)
  addBox(scene, world, -7.5, 4.7, 43.5, 125, 0.6, 3.5, fortress.royal, { tex: 'fortress-deck' });  // north (x −70..55)
  addBox(scene, world, 7.5, 4.7, -43.5, 125, 0.6, 3.5, fortress.royal, { tex: 'fortress-deck' });  // south (x −55..70)
  addRamp(scene, world, { axis: 'z', minX: -40, maxX: -34, minZ: 30, maxZ: 41.75, h0: 0, h1: 5, color: fortress.royalMid, tex: 'fortress-deck' });
  addRamp(scene, world, { axis: 'z', minX: 30, maxX: 36, minZ: 30, maxZ: 41.75, h0: 0, h1: 5, color: fortress.royalMid, tex: 'fortress-deck' });
  addRamp(scene, world, { axis: 'z', minX: -36, maxX: -30, minZ: -41.75, maxZ: -30, h0: 5, h1: 0, color: fortress.royalMid, tex: 'fortress-deck' });
  addRamp(scene, world, { axis: 'z', minX: 40, maxX: 46, minZ: -41.75, maxZ: -30, h0: 5, h1: 0, color: fortress.royalMid, tex: 'fortress-deck' });

  // Sky catwalk (north-south): keep roof → under the gatehouse arch → across
  // the trench → ramp down onto the south battlement. Top y=7.8, flush with
  // the keep roof (edge abut at z=13 — no overlap, no z-fight).
  addBox(scene, world, 0, 7.4, -12.5, 4, 0.8, 51, fortress.royal, { tex: 'fortress-deck' });
  addBox(scene, world, -1.85, 8.3, -12.5, 0.3, 1.0, 51, fortress.gold);          // rails
  // east rail splits around the perch ramp (z −30..−19) — the ramp slab cut
  // through it at a near-flat angle and the intersection shimmered
  addBox(scene, world, 1.85, 8.3, -3, 0.3, 1.0, 32, fortress.gold);
  addBox(scene, world, 1.85, 8.3, -34, 0.3, 1.0, 8, fortress.gold);
  addRamp(scene, world, { axis: 'z', minX: -2, maxX: 2, minZ: -41.75, maxZ: -38, h0: 5.0, h1: 7.8, color: fortress.royalMid, tex: 'fortress-deck' });
  // Sniper perch two levels up (top y=12.6), reached by a half-width ramp on
  // the catwalk's east lane; the west lane stays walkable underneath it.
  addRamp(scene, world, { axis: 'z', minX: 0, maxX: 2, minZ: -30, maxZ: -19, h0: 7.8, h1: 12.6, color: fortress.royalMid, tex: 'fortress-deck' });
  addBox(scene, world, 0, 3.25, -15.5, 3.6, 7.5, 5, fortress.cyanStone, { tex: 'fortress-stone' }); // ground column to catwalk underside
  addBox(scene, world, 1.6, 9.8, -18.6, 0.5, 4, 0.5, fortress.royalDark);               // slim posts catwalk → perch
  addBox(scene, world, 1.6, 9.8, -12.6, 0.5, 4, 0.5, fortress.royalDark);
  addBox(scene, world, 0, 12.2, -15.5, 6, 0.8, 7, fortress.royal, { tex: 'fortress-deck' }); // perch deck
  addBox(scene, world, 0, 13.05, -12.35, 6, 0.9, 0.3, fortress.gold);              // perch rails (gap at ramp)
  addBox(scene, world, 2.85, 13.05, -15.5, 0.3, 0.9, 6.4, fortress.gold);
  addBox(scene, world, -2.85, 13.05, -15.5, 0.3, 0.9, 6.4, fortress.gold);
  addBox(scene, world, -1.5, 13.05, -18.8, 3, 0.9, 0.3, fortress.gold);
  // Sky catwalk (east-west): keep roof → NE tower top (0.15 step down onto the cap)
  addBox(scene, world, 35.75, 7.35, 32, 47.5, 0.8, 4, fortress.royal, { tex: 'fortress-deck' });
  addBox(scene, world, 24, 3.2, 32, 2.5, 7.4, 2.5, fortress.cyanStone, { tex: 'fortress-stone' }); // support columns
  addBox(scene, world, 50, 3.2, 32, 2.5, 7.4, 2.5, fortress.cyanStone, { tex: 'fortress-stone' });
  // Matching low rails make the long exposed route read as an intentional
  // battlement. They are real colliders, not a decorative shell.
  addBox(scene, world, 35.75, 8.22, 30.15, 47.5, 0.9, 0.3, fortress.gold);
  addBox(scene, world, 35.75, 8.22, 33.85, 47.5, 0.9, 0.3, fortress.gold);

  // Arcade walls just inside the battlements: the walkway above becomes the
  // roof of a covered perimeter corridor (gaps = doorways; also gaps at ramps)
  for (const [c, len] of [[-62.5, 15], [-43.5, 7], [-27, 14], [-8, 8], [9.5, 11], [26.5, 7], [40.5, 9], [54, 2]]) {
    addBox(scene, world, c, 2.2, 41.5, len, 4.4, 1.2, fortress.sandstone, { tex: 'fortress-stone' });
  }
  for (const [c, len] of [[-52.5, 5], [-39, 6], [-25, 10], [1.5, 27], [31.5, 17], [48, 4], [64, 12]]) {
    addBox(scene, world, c, 2.2, -41.5, len, 4.4, 1.2, fortress.sandstone, { tex: 'fortress-stone' });
  }

  // Cross walls split each courtyard into rooms (center gaps as doorways)
  for (const [x, zs] of [[-45, 1], [45, 1], [-45, -1], [45, -1]]) {
    addBox(scene, world, x, 3, 25.5 * zs, 1.5, 6, 5, fortress.sandstone, { tex: 'fortress-stone' });
    // The NE and SW tower ramps cross this wall line. Keeping the rear segment
    // there made the slope look connected from above while its foot was sealed
    // behind a collider. Those two openings are intentional ramp gates.
    const isTowerRampGate = (x === 45 && zs === 1) || (x === -45 && zs === -1);
    if (!isTowerRampGate) {
      addBox(scene, world, x, 3, 36.5 * zs, 1.5, 6, 5, fortress.sandstone, { tex: 'fortress-stone' });
    }
  }
  addVine(scene, world, -45, 36.5, 0.2, 6.2, 0.8, -0.18, 0.18);
  addVine(scene, world, 45, -36.5, 0.2, 6.2, 0.8, 0.18, -0.18);

  // A roofed southwest sluice creates a deliberately compressed shotgun
  // route between the open courtyard and the cross-wall doorway. Every visible
  // structural piece is the collider-bearing box itself.
  addBox(scene, world, -52.5, 3.55, -30.5, 13, 0.7, 6, fortress.royalShadow, { tex: 'fortress-deck' });
  addBox(scene, world, -52.5, 1.9, -33.25, 13, 3.8, 0.5, fortress.cyanStone, { tex: 'fortress-stone' });
  addBox(scene, world, -52.5, 1.9, -27.75, 13, 3.8, 0.5, fortress.cyanStone, { tex: 'fortress-stone' });

  // Cover: staggered arena barriers make the long sightlines playable without
  // turning them into a crate maze. Accent skins are inset into their exact
  // collider silhouettes by addArenaBarrier().
  const crate = (x, z, s = 2.4) => addBox(scene, world, x, s / 2, z, s, s, s, 0xb0763a, { tex: 'crate' });
  crate(-24, 30); crate(-21.5, 30); crate(-24, 32.5); // cluster NW of bridge
  crate(24, -30); crate(21.5, -30); crate(24, -32.5);
  crate(-54, -25); crate(52, 28); crate(-14, -20); crate(14, 20);
  crate(-40, 16); crate(40, -16); crate(68, 10); crate(-68, -10);
  addArenaBarrier(scene, world, -31, 0, -13, 7, 2.2, 1.8, 0x43dcff);
  addArenaBarrier(scene, world, -23.5, 0, -10.5, 4.5, 3, 2, fortress.gold);
  addArenaBarrier(scene, world, 26, 0, 11, 9, 2.4, 1.8, 0xff6438);

  // Spawns
  for (const dz of [-30, -20, 14, 24, 34]) {
    world.spawns.blue.push(V(-72, 0.1, dz));
    world.spawns.red.push(V(72, 0.1, dz));
  }
  for (const [x, z] of [[-60, 30], [60, -30], [-60, -30], [60, 30], [0, -40], [0, 42],
                        [-30, -40], [30, 40], [-40, 0], [40, 0], [-72, 8], [72, 8]]) {
    world.spawns.ffa.push(V(x, 0.1, z));
  }

  // Pickups
  pk(world, 'weapon', 64, 8, 38, { weapon: 'hyper' });        // NE tower
  pk(world, 'weapon', -64, 8, -38, { weapon: 'pulsar' });     // SW tower
  pk(world, 'weapon', 0, 19.5, 0, { weapon: 'hyper' });       // high waterfall platform
  pk(world, 'weapon', 40, -3.8, 0, { weapon: 'zooka' });      // east trench
  pk(world, 'weapon', -52.5, 0.2, -30.5, { weapon: 'scatter' }); // close-range sluice reward
  pk(world, 'weapon', 48, 0.2, 30, { weapon: 'scatter' });
  pk(world, 'weapon', 4, 0.2, 26, { weapon: 'sidewinder' }); // keep interior, beside the gold
  pk(world, 'weapon', -40, 5.4, 43.5, { weapon: 'whomper' }); // north battlement
  pk(world, 'weapon', 0, 8.2, 30, { weapon: 'parasite' });    // former Hyperstrike position
  pk(world, 'ammo', -4, 0.2, 26, { weapon: 'sidewinder' });
  pk(world, 'ammo', -48, 5.4, 43.5, { weapon: 'whomper' });
  pk(world, 'ammo', 4, 8.2, 30, { weapon: 'parasite' }); // beside the gun, clear of the inset wall
  pk(world, 'ammo', 64, 8, 35, { weapon: 'hyper' });
  pk(world, 'ammo', -64, 8, -35, { weapon: 'pulsar' });
  pk(world, 'ammo', 34, -3.8, 0, { weapon: 'zooka' });
  pk(world, 'ammo', -28, 0.2, -14, { weapon: 'scatter' });
  pk(world, 'ammo', 28, 0.2, 14, { weapon: 'pulsar' });
  pk(world, 'ammo', -71, -0.2, 0, { weapon: 'hyper' });       // top of the west canal ramp
  pk(world, 'health', 0, 0.2, -34);
  pk(world, 'health', -40, 0.2, 30);
  pk(world, 'health', 40, 0.2, -30);
  pk(world, 'health', 0, -3.8, -4);
  pk(world, 'health', -64, 0.2, 30);
  pk(world, 'health', 64, 0.2, -30);
  pk(world, 'shield', 0, 0.6, 0);                        // on the center bridge
  pk(world, 'speed', -30, 0.2, 0);                       // west field
  pk(world, 'djump', 30, 0.2, 30);                       // NE courtyard
  pk(world, 'gold', 0, 0.2, 26);                       // inside the keep
  pk(world, 'silver', 0, -3.8, 4, { quietWaterMedal: true }); // under the center bridge
  pk(world, 'star', 8, 8.2, 36, { hidden: true });     // keep roof corner
  pk(world, 'star', 71, -0.2, 0, { hidden: true });    // top of the east canal ramp
  pk(world, 'star', -24, 2.6, 31, { hidden: true });   // atop crate cluster
  pk(world, 'star', -68, 0.2, -13, { hidden: true });  // behind SW perimeter crate
  pk(world, 'star', -68, 5.4, 43.5, { hidden: true }); // north battlement dead end
  pk(world, 'health', 30, 5.4, 43.5);
  pk(world, 'ammo', 0, 5.4, -43.5, { weapon: 'scatter' });
  pk(world, 'star', 0, 13, -17, { hidden: true });      // sniper perch
  pk(world, 'star', 0, 0.2, 39.5, { hidden: true });    // keep's concealed rear sally passage
  pk(world, 'ammo', 0, 13, -14, { weapon: 'hyper' });

  // Waypoints
  const wps = [
    // south field
    [-72, 0, -26], [-48, 0, -18], [-30, 0, -30], [-10, 0, -26], [10, 0, -26], [30, 0, -30], [50, 0, -26], [72, 0, -26],
    [-60, 0, -12], [-40, 0, -12], [-20, 0, -12], [0, 0, -12], [20, 0, -12], [40, 0, -12], [60, 0, -12],
    // north field
    [-72, 0, 26], [-50, 0, 26], [-30, 0, 24], [30, 0, 24], [50, 0, 26], [72, 0, 26],
    [-60, 0, 12], [-40, 0, 12], [-20, 0, 12], [20, 0, 12], [40, 0, 12], [60, 0, 12],
    [-24, 0, 40], [24, 0, 40], [-45, 0, 40], [45, 0, 40], [0, 0, 43.5],
    // roofed southwest sluice
    [-58, 0, -30.5], [-52.5, 0, -30.5], [-46.5, 0, -30.5],
    // bridges
    [0, 0, 0], [-40, 0, 0], [40, 0, 0],
    [-40, 3.65, 18], [-40, 6.8, 12], [-40, 6.8, 5], [-40, 6.8, -9], [-40, 8.9, -6.75], [-40, 11, -4.5], [-40, 11, 0],
    [40, 3.65, -18], [40, 6.8, -12], [40, 6.8, -5], [40, 6.8, 9], [40, 8.9, 6.75], [40, 11, 4.5], [40, 11, 0],
    // trench
    [-71, -0.5, 0], [-61, -2.5, 0], [-50, -4, 0], [-28, -4, 0], [-12, -4, 0],
    [0, -4, 0], [12, -4, 0], [28, -4, 0], [50, -4, 0], [61, -2.5, 0], [71, -0.5, 0],
    [-58, -4, 7], [-58, 0, 11], [-28, -4, -7], [-28, 0, -11],
    [-10, -4, 7], [-10, 0, 11], [18, -4, -7], [18, 0, -11],
    [46, -4, 7], [46, 0, 11], [60, -4, -7], [60, 0, -11],
    // keep: ground room, tall second room, exterior ramps, and upper roof
    [0, 0, 11], [0, 0, 26], [0, 0, 35], [0, 0, 39.5],
    [0, 5, 41.75], [0, 6.4, 40.375], [0, 7.8, 39],
    [0, 7.8, 16], [-5, 7.8, 26], [0, 7.8, 36], [9, 7.8, 32],
    [9.75, 7.8, 18], [9.75, 10.625, 22], [9.75, 13.45, 26], [9.75, 16.275, 30], [9.75, 19.1, 34],
    [-9.75, 19.1, 18], [-9.75, 16.275, 22], [-9.75, 13.45, 26], [-9.75, 10.625, 30], [-9.75, 7.8, 34],
    [-6, 19.1, 18], [0, 19.1, 26], [6, 19.1, 34],
    [0, 19.1, 12], [0, 19.1, 8], [0, 19.1, 3], [0, 19.1, 0],
    [22, 3.9, 27], [34, 0, 27],
    // towers
    [64, 7.6, 38], [58.5, 7.6, 38], [52, 3.8, 38], [44, 0, 38],
    [-64, 7.6, -38], [-58.5, 7.6, -38], [-52, 3.8, -38], [-44, 0, -38],
    // lane doors
    [-36, 0, 22], [36, 0, 22], [-36, 0, -22], [36, 0, -22],
    [-13.5, 0, 22], [13.5, 0, 22], [0, 0, -22],
    // battlements + their ramp mids
    [-65, 5, 43.5], [-48, 5, 43.5], [-31, 5, 43.5], [-14, 5, 43.5], [3, 5, 43.5], [20, 5, 43.5], [37, 5, 43.5], [51, 5, 43.5],
    [-37, 2.5, 35], [33, 2.5, 35],
    [-50, 5, -43.5], [-33, 5, -43.5], [-16, 5, -43.5], [1, 5, -43.5], [18, 5, -43.5], [35, 5, -43.5], [52, 5, -43.5], [66, 5, -43.5],
    [-33, 2.5, -35], [43, 2.5, -35],
    // covered arcade corridors (under the battlements) + their doorways
    [-60, 0, 43.5], [-40, 0, 43.5], [-20, 0, 43.5], [0, 0, 43.5], [20, 0, 43.5], [40, 0, 43.5],
    [-51, 0, 39.5], [-16, 0, 39.5], [19, 0, 39.5], [49, 0, 39.5],
    [-45, 0, -43.5], [-25, 0, -43.5], [-5, 0, -43.5], [15, 0, -43.5], [35, 0, -43.5], [55, 0, -43.5], [65, 0, -43.5],
    [-46, 0, -39.5], [-16, 0, -39.5], [16, 0, -39.5], [54, 0, -39.5],
    // courtyard cross-wall doorways
    [-45, 0, 31], [45, 0, 31], [-45, 0, -31], [45, 0, -31],
    // north-south catwalk (west lane hugs x −1 beside the perch ramp)
    [0, 7.8, 8], [-1, 7.8, -6], [-1, 7.8, -20], [-1, 7.8, -33], [0, 6.4, -40],
    // sniper perch ramp + deck
    [1, 10.2, -24.5], [1, 12.6, -19], [0, 12.6, -15.5],
    // east-west catwalk to the NE tower
    [16, 7.75, 32], [30, 7.75, 32], [44, 7.75, 32], [57, 7.75, 33],
  ];
  for (const [x, y, z] of wps) wp(world, x, y, z);
  addFortressPresentation(scene, world);
  mergeStatic(scene, world);
  return world;
}

/* ============== MAP 3 — ASTEROID BELT (low gravity, 240×240) ==============
   Flat-topped rock platforms (easy to walk) with features: a cave rock with a
   walkable roof, a canyon rock with an under-deck, side balconies, and
   stepping-stone paths. Decorative boulder keels sell the asteroid look. */

// A walkable rock: flat box collider on top, rocky slab visual + boulder keel.
function addRockPlatform(scene, world, x, y, z, w, d, color = 0x8a7f72) {
  const thick = 2.5;
  world.colliders.push({
    type: 'box',
    min: V(x - w / 2, y - thick, z - d / 2),
    max: V(x + w / 2, y, z + d / 2),
  });
  // slab visual: flat top, craggy sides/bottom — pooled into one merged mesh
  const bake = (geoIn, uvScale) => {
    // icosahedra are non-indexed and boxes are indexed — normalize so the
    // whole rockflat group can merge into one mesh
    const geo = geoIn.index ? geoIn.toNonIndexed() : geoIn;
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * uvScale, uv.getY(i) * uvScale);
    const col = new THREE.Color(color);
    const n = geo.attributes.position.count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) colors.set([col.r, col.g, col.b], i * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    (world._geoGroups.rockflat ||= []).push(geo);
  };
  const geo = new THREE.BoxGeometry(w, thick, d, 3, 2, 3);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i), vy = pos.getY(i), vz = pos.getZ(i);
    if (vy > thick / 2 - 0.01) {
      pos.setXYZ(i, vx + rand(-0.3, 0.3), vy, vz + rand(-0.3, 0.3));
    } else {
      pos.setXYZ(i, vx * rand(1.0, 1.12), vy - rand(0, 0.9), vz * rand(1.0, 1.12));
    }
  }
  geo.computeVertexNormals();
  geo.translate(x, y - thick / 2, z);
  bake(geo, 3);
  // Boulder keel under the slab. On wide decks its rounded top can poke above
  // the walkable face — keep the original placement/look, but size the sphere
  // to the visual radius so players cannot walk through the crest.
  const r = Math.min(w, d) * 0.5;
  const keelX = x + rand(-1, 1);
  const keelY = y - thick - r * 0.5;
  const keelZ = z + rand(-1, 1);
  const keel = new THREE.IcosahedronGeometry(r, 1);
  keel.scale(1, 0.85, 1);
  keel.rotateX(rand(0, 3)); keel.rotateY(rand(0, 3)); keel.rotateZ(rand(0, 3));
  keel.translate(keelX, keelY, keelZ);
  bake(keel, 2);
  // After scale+tilt the mesh still fits in ~r of the center; 0.85 left a
  // walkable gap through the part that sticks above the deck.
  world.colliders.push({ type: 'sphere', center: V(keelX, keelY, keelZ), radius: r });
}

function buildAsteroids(scene) {
  const world = newWorld({
    gravity: 4.8, jumpVel: 8.4, killY: -60, playerSpeed: 12,  // match the bots' hop range
    waypointLinkDist: 45, waypointLinkDy: 16,
    availableWeapons: ['blaster', 'scatter', 'pulsar', 'sidewinder', 'zooka', 'hyper', 'parasite', 'whomper'],
    cometField: {
      minInterval: 13.34, maxInterval: 26.67,
      spawnRadius: 230, flightLife: 16,
      minSpeed: 27, maxSpeed: 36,
      health: 150, radius: 1.36,
      maxElevation: 15, laneSpread: 42,
      outerTailLength: 26, innerTailLength: 17,
      fadeIn: 1, maxActive: 2,
    },
  });
  scene.background = new THREE.Color(0x01020a);
  scene.fog = null; // open space — don't inherit fog from the previous map
  scene.add(new THREE.HemisphereLight(0x5566aa, 0x221833, 2.4));
  scene.add(new THREE.AmbientLight(0x8899cc, 0.8));
  const sun = new THREE.DirectionalLight(0xfff0dd, 3.4);
  sun.position.set(90, 120, -60);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -140, right: 140, top: 140, bottom: -140, near: 10, far: 500 });
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.6;
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0x5570ff, 1.2); // cool rim fill (cheaper than giant point lights)
  rim.position.set(-200, -80, 150);
  scene.add(rim);

  // Sky shell: a few small distant nebula pockets on a deep starfield.
  // Soft source-over paint (no additive "lighter") so it doesn't read as a
  // nearby lit canvas — high-res + gentle falloff keeps the infinite-void feel.
  // Paint stars FIRST, then gas on top. Stamping pin-stars over the nebula
  // made the clouds look like stippled canvas.
  const skyW = 4096, skyH = 2048;
  const skyCanvas = document.createElement('canvas');
  skyCanvas.width = skyW;
  skyCanvas.height = skyH;
  const skyCtx = skyCanvas.getContext('2d');
  const skyRnd = seededRandom(0xa57e801d);
  skyCtx.fillStyle = '#01020a';
  skyCtx.fillRect(0, 0, skyW, skyH);

  // Fade to transparent with the SAME rgb — fading to rgba(0,0,0,0) tints every
  // blob edge toward black, and stacked edges read as a mesh.
  const rgbaFade = (color, a) => {
    const m = String(color).match(/([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
    if (!m) return `rgba(0,0,0,${a})`;
    return `rgba(${m[1]},${m[2]},${m[3]},${a})`;
  };
  const softBlob = (x, y, rx, ry, color, alpha = 1) => {
    const R = Math.max(rx, ry);
    const grad = skyCtx.createRadialGradient(0, 0, 0, 0, 0, R);
    grad.addColorStop(0, color);
    grad.addColorStop(0.5, rgbaFade(color, 0.45));
    grad.addColorStop(1, rgbaFade(color, 0));
    skyCtx.save();
    skyCtx.globalAlpha = alpha;
    skyCtx.translate(x, y);
    skyCtx.scale(rx / R, ry / R);
    skyCtx.fillStyle = grad;
    skyCtx.beginPath();
    skyCtx.arc(0, 0, R, 0, Math.PI * 2);
    skyCtx.fill();
    skyCtx.restore();
  };

  // Starfield behind the gas — pin dots stay sharp on the hi-res map.
  for (let i = 0; i < 9000; i++) {
    const x = skyRnd() * skyW;
    const y = skyRnd() * skyH;
    const bright = skyRnd() > 0.97;
    const r = bright ? 0.8 + skyRnd() * 1.4 : 0.25 + skyRnd() * 0.55;
    skyCtx.globalAlpha = bright ? 0.85 + skyRnd() * 0.15 : 0.28 + skyRnd() * 0.5;
    const tint = skyRnd();
    skyCtx.fillStyle = tint > 0.92 ? '#a8dcff' : tint < 0.06 ? '#e8c8ff' : tint < 0.12 ? '#ffe8b0' : '#ffffff';
    skyCtx.beginPath();
    skyCtx.arc(x, y, r, 0, Math.PI * 2);
    skyCtx.fill();
  }
  // Soft bright stars only — hard cross spikes scream "painted texture".
  skyCtx.globalAlpha = 1;
  for (let i = 0; i < 22; i++) {
    const x = skyRnd() * skyW;
    const y = 120 + skyRnd() * (skyH - 240);
    const arm = 4 + skyRnd() * 9;
    const glow = skyCtx.createRadialGradient(x, y, 0, x, y, arm);
    glow.addColorStop(0, 'rgba(255,255,255,0.95)');
    glow.addColorStop(0.25, 'rgba(220,230,255,0.35)');
    glow.addColorStop(1, 'rgba(220,230,255,0)');
    skyCtx.fillStyle = glow;
    skyCtx.beginPath();
    skyCtx.arc(x, y, arm, 0, Math.PI * 2);
    skyCtx.fill();
  }

  // Nebula = a handful of huge soft washes (no particle stamping). Shape comes
  // from elongated ellipses along a spine, not hundreds of overlapping dots.
  const wash = (x, y, rx, ry, color, alpha, rot = 0) => {
    skyCtx.save();
    skyCtx.translate(x, y);
    skyCtx.rotate(rot);
    softBlob(0, 0, rx, ry, color, alpha);
    skyCtx.restore();
  };

  // Planet sits near UV ~(3470, 880). Long wispy trail streams away behind it.
  const trailAngle = -0.16;
  wash(3320, 860, 420, 130, 'rgba(70,25,130,0.55)', 0.55, trailAngle);
  wash(3100, 820, 480, 110, 'rgba(100,35,150,0.5)', 0.45, trailAngle);
  wash(2850, 780, 420, 90, 'rgba(80,30,140,0.42)', 0.38, trailAngle);
  wash(2580, 740, 340, 70, 'rgba(60,40,150,0.35)', 0.3, trailAngle);
  wash(3380, 880, 200, 70, 'rgba(160,55,190,0.55)', 0.4, trailAngle);
  wash(3200, 850, 280, 55, 'rgba(120,80,210,0.45)', 0.32, trailAngle - 0.05);
  wash(2950, 800, 300, 48, 'rgba(180,70,175,0.4)', 0.28, trailAngle + 0.04);
  wash(2700, 760, 260, 40, 'rgba(90,110,210,0.35)', 0.22, trailAngle);
  // Soft bright head tucked just behind the planet silhouette.
  wash(3360, 870, 110, 55, 'rgba(210,225,255,0.55)', 0.3, trailAngle);
  wash(3280, 860, 160, 65, 'rgba(150,160,230,0.4)', 0.26, trailAngle);
  wash(3180, 840, 200, 70, 'rgba(110,70,200,0.3)', 0.22, trailAngle);

  // Compact distant pockets (still just large washes — no particle clouds).
  wash(680, 1480, 260, 180, 'rgba(130,25,100,0.55)', 0.55, 0.25);
  wash(720, 1460, 180, 120, 'rgba(180,50,150,0.5)', 0.4, 0.1);
  wash(640, 1500, 140, 100, 'rgba(90,40,170,0.4)', 0.35, -0.2);
  wash(650, 1490, 60, 42, 'rgba(240,220,240,0.5)', 0.28, 0);

  wash(1780, 460, 200, 130, 'rgba(50,35,120,0.4)', 0.42, -0.15);
  wash(1820, 450, 140, 90, 'rgba(90,60,180,0.4)', 0.3, 0.1);

  softenCanvasHorizontalSeam(skyCtx, skyW, skyH, 280);

  const skyMap = new THREE.CanvasTexture(skyCanvas);
  skyMap.colorSpace = THREE.SRGBColorSpace;
  // No mipmaps — they turn pin stars into fat blobs and wash nebulae out.
  skyMap.generateMipmaps = false;
  skyMap.minFilter = THREE.LinearFilter;
  skyMap.magFilter = THREE.LinearFilter;
  const skyShell = new THREE.Mesh(
    // Larger dome (still inside camera.far=900) = shallower curvature.
    new THREE.SphereGeometry(820, 64, 40),
    new THREE.MeshBasicMaterial({
      map: skyMap,
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
    }),
  );
  skyShell.renderOrder = -30;
  skyShell.frustumCulled = false;
  skyShell.name = 'asteroid-sky-shell';
  scene.add(skyShell);

  // Ringed gas giant — banded storm texture + layered translucent rings.
  const gasGiantTex = canvasTex('asteroid-gas-giant', (g) => {
    const w = 128, h = 128;
    // Base dusty rose / terracotta atmosphere.
    const base = g.createLinearGradient(0, 0, 0, h);
    base.addColorStop(0, '#5a2a38');
    base.addColorStop(0.18, '#a85a48');
    base.addColorStop(0.35, '#d4a090');
    base.addColorStop(0.5, '#c87858');
    base.addColorStop(0.62, '#e8c8b0');
    base.addColorStop(0.78, '#b06050');
    base.addColorStop(1, '#3a1828');
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);
    // Horizontal cloud bands with turbulent edges.
    const bandCols = [
      ['#f2e4d0', 0.12], ['#8a3830', 0.16], ['#e8b8a0', 0.1],
      ['#6e2c38', 0.14], ['#d89878', 0.11], ['#c05040', 0.13],
      ['#f0d8c0', 0.09], ['#7a4048', 0.12],
    ];
    for (let i = 0; i < 28; i++) {
      const y = (i / 28) * h + (Math.sin(i * 2.7) * 2.2);
      const thick = 1.6 + (i % 5) * 0.9 + Math.abs(Math.sin(i * 1.3)) * 2.4;
      const [col, a] = bandCols[i % bandCols.length];
      g.globalAlpha = a + 0.35;
      g.fillStyle = col;
      g.beginPath();
      g.moveTo(0, y);
      for (let x = 0; x <= w; x += 4) {
        const wobble = Math.sin(x * 0.11 + i * 1.7) * 2.8
          + Math.sin(x * 0.31 - i * 0.9) * 1.4
          + Math.sin(x * 0.07 + i) * 1.1;
        g.lineTo(x, y + wobble);
      }
      for (let x = w; x >= 0; x -= 4) {
        const wobble = Math.sin(x * 0.11 + i * 1.7) * 2.8
          + Math.sin(x * 0.31 - i * 0.9) * 1.4
          + Math.sin(x * 0.07 + i) * 1.1;
        g.lineTo(x, y + thick + wobble * 0.55);
      }
      g.closePath();
      g.fill();
    }
    g.globalAlpha = 1;
    // Wispy cream streaks / storm eddies.
    for (let i = 0; i < 40; i++) {
      const y = 10 + Math.random() * (h - 20);
      const x0 = Math.random() * w;
      g.strokeStyle = `rgba(255,236,214,${0.18 + Math.random() * 0.35})`;
      g.lineWidth = 0.6 + Math.random() * 1.8;
      g.beginPath();
      g.moveTo(x0, y);
      for (let k = 1; k < 8; k++) {
        g.lineTo(x0 + k * 5.5, y + Math.sin(k * 0.9 + i) * 3.2);
      }
      g.stroke();
    }
    // Polar vortex (darker circular storm near the top of the lat map).
    const vortex = g.createRadialGradient(64, 14, 2, 64, 16, 22);
    vortex.addColorStop(0, 'rgba(40,12,22,0.85)');
    vortex.addColorStop(0.45, 'rgba(120,40,50,0.45)');
    vortex.addColorStop(1, 'rgba(120,40,50,0)');
    g.fillStyle = vortex;
    g.fillRect(0, 0, w, h);
    // Soft terminator shading baked into the texture for distant readability.
    const shade = g.createLinearGradient(0, 0, w, 0);
    shade.addColorStop(0, 'rgba(8,4,12,0.55)');
    shade.addColorStop(0.35, 'rgba(8,4,12,0)');
    shade.addColorStop(0.7, 'rgba(255,220,180,0.08)');
    shade.addColorStop(1, 'rgba(8,4,12,0.35)');
    g.fillStyle = shade;
    g.fillRect(0, 0, w, h);
  });
  gasGiantTex.wrapS = gasGiantTex.wrapT = THREE.RepeatWrapping;
  gasGiantTex.anisotropy = 8;

  // Bust the old barcode-stripe cache key — UVs + art both changed.
  const ringTex = canvasTex('asteroid-gas-rings-v2', (g) => {
    const w = 128, h = 128;
    g.clearRect(0, 0, w, h);
    // Planar map: concentric circles around the texture center so stripes
    // follow the ring geometry instead of reading as a slanted barcode.
    const cx = 64, cy = 64;
    for (let i = 0; i < 72; i++) {
      const t = i / 72;
      const radius = 6 + t * 56;
      const gap = (i % 7 === 3 || i % 11 === 5);
      if (gap) continue;
      const warm = i % 4 === 0;
      const a = 0.28 + (Math.sin(t * 36) * 0.5 + 0.5) * 0.42;
      g.strokeStyle = warm
        ? `rgba(220,200,175,${a})`
        : `rgba(155,180,210,${a})`;
      g.lineWidth = 0.7 + (i % 3) * 0.55;
      g.beginPath();
      g.arc(cx, cy, radius, 0, Math.PI * 2);
      g.stroke();
    }
    g.strokeStyle = 'rgba(235,245,255,0.75)';
    g.lineWidth = 2.2;
    g.beginPath(); g.arc(cx, cy, 12, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = 'rgba(190,205,225,0.5)';
    g.lineWidth = 1.8;
    g.beginPath(); g.arc(cx, cy, 60, 0, Math.PI * 2); g.stroke();
    for (let i = 0; i < 8; i++) {
      const radius = 16 + Math.random() * 40;
      g.strokeStyle = `rgba(255,255,255,${0.12 + Math.random() * 0.22})`;
      g.lineWidth = 0.8;
      g.beginPath(); g.arc(cx, cy, radius, 0, Math.PI * 2); g.stroke();
    }
  });
  ringTex.wrapS = ringTex.wrapT = THREE.ClampToEdgeWrapping;
  ringTex.anisotropy = 8;

  const planet = new THREE.Mesh(
    new THREE.SphereGeometry(78, 48, 36),
    new THREE.MeshStandardMaterial({
      map: gasGiantTex,
      roughness: 0.92,
      metalness: 0.04,
      emissive: new THREE.Color(0x3a1810),
      emissiveIntensity: 0.18,
    }),
  );
  planet.position.set(-280, 110, -400);
  planet.rotation.z = 0.22;
  scene.add(planet);

  const ringMat = new THREE.MeshBasicMaterial({
    map: ringTex,
    color: 0xc8d4e4,
    transparent: true,
    opacity: 0.82,
    side: THREE.DoubleSide,
    depthWrite: false,
    toneMapped: false,
  });
  // Flat ring disk with planar UVs so concentric texture circles stay circular.
  const buildPlanetRingGeo = (inner, outer, segments = 96) => {
    const geo = new THREE.RingGeometry(inner, outer, segments, 6);
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i), py = pos.getY(i);
      uv.setXY(i, (px / outer) * 0.5 + 0.5, (py / outer) * 0.5 + 0.5);
    }
    uv.needsUpdate = true;
    return geo;
  };
  const ring = new THREE.Mesh(buildPlanetRingGeo(98, 168, 96), ringMat);
  ring.position.copy(planet.position);
  ring.rotation.x = Math.PI / 2.35;
  ring.rotation.y = 0.35;
  ring.rotation.z = 0.15;
  scene.add(ring);
  // Soft under-ring ghost for thickness at glancing angles.
  const ringGhost = new THREE.Mesh(
    buildPlanetRingGeo(102, 162, 64),
    new THREE.MeshBasicMaterial({
      color: 0x8899bb, transparent: true, opacity: 0.18,
      side: THREE.DoubleSide, depthWrite: false, toneMapped: false,
    }),
  );
  ringGhost.position.copy(planet.position);
  ringGhost.position.y -= 1.8;
  ringGhost.rotation.copy(ring.rotation);
  scene.add(ringGhost);

  world.anim.push((_dt, t) => {
    planet.rotation.y = t * 0.012;
    ring.rotation.z = 0.15 + t * 0.004;
    ringGhost.rotation.z = ring.rotation.z;
  });

  // ---- Walkable platforms (x, y=top, z, w, d) ----
  addRockPlatform(scene, world, -75, 14, 0, 26, 20, 0x6f7fa0);  // blue base
  addRockPlatform(scene, world, 75, 14, 0, 26, 20, 0xa07070);   // red base
  addRockPlatform(scene, world, -40, 8, -18, 14, 12);           // west mid
  addRockPlatform(scene, world, 40, 8, 18, 14, 12);             // east mid
  addRockPlatform(scene, world, -48, 4, -10, 8, 6);             // west balcony (below the mid)
  addRockPlatform(scene, world, 48, 4, 10, 8, 6);               // east balcony
  addRockPlatform(scene, world, -44, 13, -46, 12, 10);          // NW
  addRockPlatform(scene, world, 44, 0, 46, 12, 10);             // SE
  addRockPlatform(scene, world, -52, -6, 38, 13, 11);           // SW
  addRockPlatform(scene, world, 52, 8, -38, 13, 11);            // NE
  addRockPlatform(scene, world, -14, 14, -68, 10, 9);           // far north
  addRockPlatform(scene, world, 16, -8, 72, 10, 9);             // far south
  addRockPlatform(scene, world, -72, 8, -56, 8, 8);             // outer west
  addRockPlatform(scene, world, 72, -4, 56, 8, 8);              // outer east
  // stepping stones
  addRockPlatform(scene, world, -58, 12, -8, 9, 7);
  addRockPlatform(scene, world, -64, 4, 20, 9, 7);
  addRockPlatform(scene, world, 58, 11, 8, 9, 7);
  addRockPlatform(scene, world, 64, 11, -20, 9, 7);
  addRockPlatform(scene, world, -26, -2, 42, 9, 7);
  addRockPlatform(scene, world, 26, 10, -42, 9, 7);
  addRockPlatform(scene, world, 8, -4, 58, 8, 7);   // stepping stone on the whomper route
  // gold perch + far star rocks
  addRockPlatform(scene, world, 0, 22, 0, 6, 6, 0xffd8a0);
  addRockPlatform(scene, world, 72, 4, -62, 8, 8);
  addRockPlatform(scene, world, -72, -10, 62, 8, 8);
  addRockPlatform(scene, world, 0, -2, -78, 8, 8);

  // CAVE ROCK (north): tunnel through the slab, walkable roof on top
  addRockPlatform(scene, world, 0, 12, -44, 18, 14);
  addBox(scene, world, -5, 13.5, -44, 1.2, 3, 10, 0x77695c, { tex: 'rock' });   // cave walls
  addBox(scene, world, 5, 13.5, -44, 1.2, 3, 10, 0x77695c, { tex: 'rock' });
  addBox(scene, world, 0, 15.9, -44, 11.5, 1.2, 10, 0x77695c, { tex: 'rock' }); // roof (top 16.5)
  const caveLight = new THREE.PointLight(0xffb060, 20, 14);
  caveLight.position.set(0, 14.4, -44);
  scene.add(caveLight);

  // CANYON ROCK (south): two rims with a gap, under-deck below the gap
  addRockPlatform(scene, world, -5.5, 2, 44, 7, 14);
  addRockPlatform(scene, world, 5.5, 2, 44, 7, 14);
  addRockPlatform(scene, world, 0, -3, 44, 12, 10);

  // Derelict station (center)
  addBox(scene, world, 0, 8, 0, 30, 2, 20, 0x6a7688, { tex: 'panel' });          // deck, top y=9
  addBox(scene, world, 0, 11, -6, 12, 4, 6, 0x59657a, { tex: 'panel' });         // core room block
  addBox(scene, world, 0, 13.6, -6, 13, 1.2, 7, 0x8892a8);                       // core roof
  addBox(scene, world, -18, 8.4, 0, 8, 0.8, 8, 0x59657a, { tex: 'panel' });      // west wing
  addBox(scene, world, 18, 8.4, 0, 8, 0.8, 8, 0x59657a, { tex: 'panel' });       // east wing
  addDecal(scene, 'poster3', 0, 11, -2.94, 4.5, 0);
  addBox(scene, world, 0, 12, 8, 1, 6, 1, 0x8892a8, { collide: false });         // antenna
  addBox(scene, world, 0, 15.2, 8, 1.6, 0.5, 1.6, 0xff3050, { collide: false, shadow: false, emissive: 0xff3050, emissiveIntensity: 2 });
  const stnLight = new THREE.PointLight(0x30e0ff, 60, 30);
  stnLight.position.set(0, 11, 0);
  scene.add(stnLight);

  // Bounce pads (players only — bots use their own ballistic hops)
  addJumpPad(scene, world, 6, 9, 2, 15, -1.6, -0.6, 0xffd23c, true);   // deck → gold perch
  addJumpPad(scene, world, -40, 8, -15, 14, 6, 2.2, 0x30e0ff, true);   // west mid → station
  addJumpPad(scene, world, 40, 8, 15, 14, -6, -2.2, 0x30e0ff, true);   // east mid → station
  // return pads on the outlying rocks — every far rock has a way back
  addJumpPad(scene, world, 16, -8, 72, 12, 7, -6.5, 0x9dff70, true);   // far south → SE
  addJumpPad(scene, world, -14, 14, -68, 9, -8.1, 5.9, 0x9dff70, true); // far north → NW
  addJumpPad(scene, world, -72, 8, -56, 11, 7.2, 2.6, 0x9dff70, true); // outer west → NW
  addJumpPad(scene, world, 72, -4, 56, 9, -9.1, -3.2, 0x9dff70, true); // outer east → SE
  addJumpPad(scene, world, 72, 4, -62, 9, -6.5, 7.8, 0x9dff70, true);  // star rock → NE mid
  addJumpPad(scene, world, -72, -10, 62, 9, 6.5, -7.8, 0x9dff70, true);// star rock → SW mid
  addJumpPad(scene, world, 0, -2, -78, 13, 0, 9.2, 0x9dff70, true);    // deep north → cave rock
  // the southern belt was a one-way bowl for players — pads back up and out
  addJumpPad(scene, world, 5.5, 2, 40, 14, -1.3, -9.3, 0x9dff70, true);   // canyon rim → station deck
  addJumpPad(scene, world, -52, -6, 36, 16, -2.1, -2.8, 0x9dff70, true);  // SW rock → base stone
  addJumpPad(scene, world, 44, 0, 42, 15, -0.7, -4.4, 0x9dff70, true);    // SE rock → east mid

  // Decorative floating debris
  for (let i = 0; i < 14; i++) {
    addAsteroid(scene, { colliders: [], ramps: [] },
      rand(-120, 120), rand(30, 90) * (Math.random() < 0.5 ? -1 : 1), rand(-120, 120), rand(1, 3));
  }

  // Spawns
  for (const [dx, dz] of [[0, 0], [6, 5], [-6, 5], [6, -5], [-6, -5]]) {
    world.spawns.blue.push(V(-75 + dx, 14.2, dz));
    world.spawns.red.push(V(75 + dx, 14.2, dz));
  }
  for (const [x, y, z] of [[0, 12.4, -48], [-5.5, 2.4, 44], [-40, 8.4, -18], [40, 8.4, 18],
                           [-44, 13.4, -46], [44, 0.4, 46], [56, 8.4, -38], [-56, -5.6, 38],
                           [-8, 9.3, -2], [20, -7.8, 72], [-10, 14.2, -64], [4, 16.7, -44]]) {
    world.spawns.ffa.push(V(x, y, z));
  }

  // Pickups
  pk(world, 'weapon', 0, 9.3, 4, { weapon: 'zooka' });            // station deck
  pk(world, 'weapon', 0, 12.2, -44, { weapon: 'hyper' });         // inside the cave
  pk(world, 'weapon', -14, 14.2, -68, { weapon: 'hyper' });       // far north rock
  pk(world, 'weapon', -58, 12.2, -8, { weapon: 'scatter' });      // stones near bases
  pk(world, 'weapon', 58, 11.2, 8, { weapon: 'scatter' });
  pk(world, 'weapon', -40, 8.2, -21, { weapon: 'pulsar' });       // mids
  pk(world, 'weapon', 40, 8.2, 21, { weapon: 'pulsar' });
  pk(world, 'weapon', 16, -7.8, 68, { weapon: 'whomper' });  // far south rock
  pk(world, 'weapon', -44, 13.2, -42, { weapon: 'sidewinder' });
  pk(world, 'weapon', 44, 0.2, 46, { weapon: 'parasite' });       // SE rock
  pk(world, 'ammo', 13, -7.8, 72, { weapon: 'whomper' });
  pk(world, 'ammo', -40, 13.2, -46, { weapon: 'sidewinder' });
  pk(world, 'ammo', 40, 0.2, 49, { weapon: 'parasite' });
  pk(world, 'ammo', -3, 9.3, -2, { weapon: 'zooka' });
  pk(world, 'ammo', 0, 16.7, -44, { weapon: 'hyper' });           // cave roof
  pk(world, 'ammo', -48, 4.2, -10, { weapon: 'pulsar' });         // west balcony
  pk(world, 'ammo', 48, 4.2, 10, { weapon: 'scatter' });          // east balcony
  pk(world, 'ammo', 0, -2.8, 46, { weapon: 'hyper' });            // canyon under-deck
  pk(world, 'health', -75, 14.2, -6);
  pk(world, 'health', 75, 14.2, 6);
  pk(world, 'health', -52, -5.8, 38);
  pk(world, 'health', 52, 8.2, -38);
  pk(world, 'health', 16, -7.8, 72);
  pk(world, 'shield', -18, 9, 0);                        // station west wing
  pk(world, 'speed', 18, 9, 0);                          // station east wing
  pk(world, 'djump', 8, 9.2, -2);                         // station center
  // LAVA CRATER ROCK: walk the rim, fall in the heart, jump for your life
  addBox(scene, world, 40, 2.75, 60, 20, 2.5, 20, 0x8a7f72, { tex: 'rock' });  // body (top 4) + safe apron
  addBox(scene, world, 40, 4.55, 55, 16, 1.1, 6, 0x8a7f72, { tex: 'rock' });   // rim ring (top 5.1)
  addBox(scene, world, 40, 4.55, 65, 16, 1.1, 6, 0x8a7f72, { tex: 'rock' });
  addBox(scene, world, 35, 4.55, 60, 6, 1.1, 4, 0x8a7f72, { tex: 'rock' });
  addBox(scene, world, 45, 4.55, 60, 6, 1.1, 4, 0x8a7f72, { tex: 'rock' });
  addLava(scene, world, 40, 60, 4, 4, 3.95);
  pk(world, 'star', 40, 5.5, 60, { hidden: true });    // hovers over the melt — jump the crater
  pk(world, 'gold', 0, 22.2, 0);                          // the perch above the station
  pk(world, 'silver', 0, 14.4, -8);                       // station core roof
  pk(world, 'star', 72, 4.2, -62, { hidden: true });      // far rocks
  pk(world, 'star', -72, -9.8, 62, { hidden: true });
  pk(world, 'star', 0, -1.8, -78, { hidden: true });
  pk(world, 'star', 0, -2.8, 42, { hidden: true });       // canyon under-deck

  // Waypoints (flat tops — much friendlier landings than sphere crowns)
  const wpsList = [
    [-75, 14, 5], [-75, 14, -5], [-68, 14, 0],
    [75, 14, -5], [75, 14, 5], [68, 14, 0],
    [0, 9, 4], [8, 9, -2], [-8, 9, -2], [-18, 8.8, 0], [18, 8.8, 0],  // station
    [-58, 12, -8], [-64, 4, 20], [58, 11, 8], [64, 11, -20],          // base stones
    [-26, -2, 42], [26, 10, -42], [8, -4, 58],                        // mid stones
    [-40, 8, -18], [40, 8, 18], [-48, 4, -10], [48, 4, 10],           // mids + balconies
    [-44, 13, -46], [44, 0, 46], [-52, -6, 38], [52, 8, -38],
    [-14, 14, -68], [16, -8, 72], [-72, 8, -56], [72, -4, 56],
    [0, 12, -38], [0, 12, -50], [0, 12, -44], [0, 16.5, -44],         // cave: doors, inside, roof
    [-5.5, 2, 44], [5.5, 2, 44], [0, -3, 44],                         // canyon rims + under-deck
    [72, 4, -62], [-72, -10, 62], [0, -2, -78],                       // star rocks
  ];
  for (const [x, y, z] of wpsList) wp(world, x, y, z);
  world.manualLinks.push(
    [-40, 8, -18, -48, 4, -10],       // mid ↔ balcony (LOS clips the slab edge)
    [40, 8, 18, 48, 4, 10],
    [0, 12, -38, 0, 16.5, -44],       // cave doors ↔ roof (hop up)
    [0, 12, -50, 0, 16.5, -44],
    [-5.5, 2, 44, 0, -3, 44],         // canyon rims ↔ under-deck
    [5.5, 2, 44, 0, -3, 44],
  );
  mergeStatic(scene, world);
  return world;
}

function addCanopyVillageBridge(scene, world, start, end, width = 4.2) {
  const delta = end.clone().sub(start);
  const length = Math.hypot(delta.x, delta.z);
  const yaw = Math.atan2(delta.x, delta.z);
  const bridge = new THREE.Mesh(
    new THREE.BoxGeometry(width, 0.62, length),
    mat(0x8f693d, { tex: 'crate', repeat: [2, Math.max(3, length / 5)], roughness: 0.94 }),
  );
  // Sink the rendered top four centimetres below the collision plane. The
  // bridge ends overlap the destination decks for seamless walking, and a
  // coplanar top there used to shimmer badly at the four council corners.
  bridge.position.copy(start).add(end).multiplyScalar(0.5).add(V(0, -0.35, 0));
  bridge.rotation.y = yaw;
  bridge.name = 'canopy-village-bridge';
  bridge.castShadow = bridge.receiveShadow = true;
  scene.add(bridge);

  // Short overlapping support cells follow the diagonal without filling the
  // empty corners of its bounding box.
  const steps = Math.max(3, Math.ceil(length / 2.4));
  const stepX = delta.x / steps;
  const stepZ = delta.z / steps;
  let previous = null;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = V(start.x + delta.x * t, start.y, start.z + delta.z * t);
    world.colliders.push({
      type: 'box',
      min: V(p.x - Math.abs(stepX) * 0.62 - width * 0.42, p.y - 0.62,
        p.z - Math.abs(stepZ) * 0.62 - width * 0.42),
      max: V(p.x + Math.abs(stepX) * 0.62 + width * 0.42, p.y,
        p.z + Math.abs(stepZ) * 0.62 + width * 0.42),
    });
    if (i % 2 === 0 || i === steps) {
      wp(world, p.x, p.y, p.z);
      world.waypoints[world.waypoints.length - 1].manualLinksOnly = true;
      if (previous) world.manualLinks.push([...previous, p.x, p.y, p.z]);
      previous = [p.x, p.y, p.z];
    }
  }

}

function addCanopyTreehouse(scene, world, x, floorY, z, doorSignX, accent = 0xffc45c) {
  const wood = 0x76502f;
  const halfW = 3.8;
  const halfD = 3.3;
  const wallH = 4.3;
  const facing = Math.sign(doorSignX) || 1;
  const frontX = x + facing * halfW;
  addBox(scene, world, x, floorY + wallH / 2, z - halfD, halfW * 2, wallH, 0.48, wood,
    { tex: 'crate', repeat: [3, 2] });
  addBox(scene, world, x, floorY + wallH / 2, z + halfD, halfW * 2, wallH, 0.48, wood,
    { tex: 'crate', repeat: [3, 2] });
  // Matching doors in both tangential walls turn the hut into a walk-through
  // room parallel to the trunk rather than a dead end at the balcony edge.
  for (const wallSign of [-1, 1]) {
    const wallX = x + wallSign * halfW;
    for (const side of [-1, 1]) addBox(
      scene, world, wallX, floorY + wallH / 2, z + side * 2.4,
      0.48, wallH, 1.8, wood, { tex: 'crate', repeat: [1, 2] },
    );
    addBox(scene, world, wallX, floorY + wallH - 0.45, z, 0.48, 0.9, 3, wood,
      { tex: 'crate' });
  }

  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(5.8, 2.7, 4),
    mat(0x3f6f3d, { tex: 'grass', repeat: [2, 2], roughness: 0.98 }),
  );
  roof.position.set(x, floorY + wallH + 1.25, z);
  roof.rotation.y = Math.PI / 4;
  roof.name = 'canopy-village-treehouse-roof';
  roof.castShadow = roof.receiveShadow = true;
  scene.add(roof);
  // Match the visible four-sided roof exactly so players can land and walk on
  // its slopes instead of passing through the presentation-only mesh.
  world.colliders.push(triangleMeshColliderFromMesh(
    roof,
    'canopy-village-treehouse-roof',
  ));

  const lantern = new THREE.PointLight(accent, 12, 12);
  lantern.position.set(frontX + facing * 0.45, floorY + 2.6, z);
  scene.add(lantern);
  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(0.24, 8, 6),
    new THREE.MeshBasicMaterial({ color: accent, toneMapped: false }),
  );
  glow.position.copy(lantern.position);
  scene.add(glow);
}

/* ============== MAP 4 — CANOPY (giant forest, vertical to y=50) ==============
   Five colossal trees with branch decks at 10/20, a connected village at 30,
   and living crowns above y=40. Edge bridges, vines, ramps, and pad chains
   make the whole forest playable from riverbed to treetop roofs. */
function buildCanopy(scene) {
  const world = newWorld({
    killY: -20,
    grappleEnabled: true,
    waypointLinkDist: 24,
    waypointLinkDy: 4.6,
    // Keep the victory presentation below the treetops on the open west side
    // of the dirt road. The generic highest-surface choice lands inside the
    // center crown now that its canopy wraps around the gold platform.
    podiumSpot: V(-15, 0, -40),
  });
  scene.background = new THREE.Color(0x8fcbe6);
  scene.fog = new THREE.Fog(0x47684e, 120, 330);
  baseLighting(scene, 0xa8d8a0, 0x1c3020, [60, 120, -40], 130);
  addDaytimeSkyDome(scene);
  addCanopyStorm(scene, world);

  // Mossy ground split by twin RIVERS (channels x −58..−50 and x 50..58,
  // bed −4.8, water −0.55): swim them, cross the plank bridges, or duck into
  // the covered flooded tunnels. A submerged connector runs under the south
  // lawn between the two riverbeds.
  addBox(scene, world, -70, -0.5, 0, 24, 1, 164, 0x5d9c46, { tex: 'rock', repeat: [3, 16] });
  // The center lawn is tiled around a 6x10 opening beneath the south bridge.
  // That opening is the surfaced end of the secret connector branch below.
  addBox(scene, world, -26.5, -0.5, 0, 47, 1, 164, 0x5d9c46, { tex: 'rock', repeat: [5, 16] });
  addBox(scene, world, 26.5, -0.5, 0, 47, 1, 164, 0x5d9c46, { tex: 'rock', repeat: [5, 16] });
  addBox(scene, world, 0, -0.5, -21, 6, 1, 122, 0x5d9c46, { tex: 'rock', repeat: [1, 12] });
  addBox(scene, world, 0, -0.5, 66, 6, 1, 32, 0x5d9c46, { tex: 'rock', repeat: [1, 3] });
  addBox(scene, world, 70, -0.5, 0, 24, 1, 164, 0x5d9c46, { tex: 'rock', repeat: [3, 16] });
  addBox(scene, world, -54, -5.3, 0, 8, 1, 164, 0x3f6e5e, { tex: 'rock', repeat: [1, 16] });   // riverbed
  addBox(scene, world, 54, -5.3, 0, 8, 1, 164, 0x3f6e5e, { tex: 'rock', repeat: [1, 16] });
  const addRiverSide = (x, z, d) => addBox(scene, world, x, -2.45, z, 0.7, 4.8, d, 0x4a7a52, {
    tex: 'rock', repeat: [Math.max(1, Math.round(d / 10)), 1],
  });
  const riverSide = (x, gapZ = null) => {
    if (gapZ == null) {
      addRiverSide(x, 0, 164);
      return;
    }
    addRiverSide(x, (gapZ - 4 - 82) / 2, 82 + gapZ - 4);
    addRiverSide(x, (gapZ + 4 + 82) / 2, 82 - gapZ - 4);
  };
  riverSide(-57.6);        // channel sides — inset 5cm from the bank faces
  riverSide(-50.4, 64);    // gap opens into the underwater connector
  riverSide(50.4, 64);
  riverSide(57.6);
  addWater(scene, world, -54, -0.55, 0, 7.8, 162, 5.4);
  addWater(scene, world, 54, -0.55, 0, 7.8, 162, 5.4);
  // Small decorative schools patrol beneath the open portions of both rivers.
  // They intentionally have no collision or gameplay state.
  addMinnowSchool(scene, world, -54, -50, 15, 0.2);
  addMinnowSchool(scene, world, -54, 27, 13, 2.4);
  addMinnowSchool(scene, world, 54, -34, 16, 1.1);
  addMinnowSchool(scene, world, 54, 35, 12, 3.5);
  addWaterfall(scene, world, -54, -79.86, 8.4, 28.6, -0.55, 28, 1);
  addWaterfall(scene, world, 54, 79.86, 8.4, 28.6, -0.55, 28, -1);
  addBox(scene, world, 0, -5.3, 64, 108, 1, 8, 0x3f6e5e, { tex: 'rock', repeat: [12, 1] });   // underwater connector bed
  // Split the north wall around the branch mouth at x 0.
  addBox(scene, world, -28.7, -2.45, 59.6, 50.6, 4.8, 0.7, 0x4a7a52, { tex: 'rock', repeat: [6, 1] });
  addBox(scene, world, 28.7, -2.45, 59.6, 50.6, 4.8, 0.7, 0x4a7a52, { tex: 'rock', repeat: [6, 1] });
  addBox(scene, world, 0, -2.45, 68.4, 108, 4.8, 0.7, 0x4a7a52, { tex: 'rock', repeat: [12, 1] });
  addBox(scene, world, 0, -0.1, 64, 108, 0.3, 8.8, 0x4a7a52, { tex: 'rock', repeat: [12, 1] }); // low ceiling keeps it underwater
  addWater(scene, world, 0, -0.55, 64, 108, 7.8, 5.4);
  // Secret flooded branch: north from the connector, then a ramp up through
  // the lawn beneath the south bridge for a third entrance into the system.
  addBox(scene, world, 0, -5.3, 55, 6, 1, 10, 0x3f6e5e, { tex: 'rock', repeat: [1, 2] });
  // Above z=50 the lawn slab supplies the upper part of each tunnel wall.
  // Split these side walls at its underside so their inner faces do not sit
  // directly on top of the lawn's faces and z-fight at the entrance.
  const addBranchSide = x => {
    addBox(scene, world, x, -2.925, 50, 0.7, 3.85, 20, 0x4a7a52, { tex: 'rock', repeat: [1, 3] });
    addBox(scene, world, x, -0.525, 45, 0.7, 0.95, 10, 0x4a7a52, { tex: 'rock', repeat: [1, 2] });
  };
  addBranchSide(-3.35);
  addBranchSide(3.35);
  addRamp(scene, world, { axis: 'z', minX: -3, maxX: 3, minZ: 40, maxZ: 50,
    h0: 0, h1: -4.8, color: 0x4a7a52, visualInset: 0.16 });
  addWater(scene, world, 0, -0.55, 50, 6.4, 20, 5.4);
  const branchLight = new THREE.PointLight(0x30e0ff, 18, 14);
  branchLight.position.set(0, -2.2, 55);
  scene.add(branchLight);
  addBox(scene, world, -54, -0.1, 4, 8.6, 0.3, 20, 0x5d9c46, { tex: 'rock' });   // flooded tunnel covers
  addBox(scene, world, -54, -0.1, 46, 8.6, 0.3, 12, 0x5d9c46, { tex: 'rock' });
  addBox(scene, world, 54, -0.1, -4, 8.6, 0.3, 20, 0x5d9c46, { tex: 'rock' });
  addBox(scene, world, 54, -0.1, 46, 8.6, 0.3, 12, 0x5d9c46, { tex: 'rock' });
  addBox(scene, world, -54, 0.14, -40, 10, 0.28, 3, 0x8a6a40, { tex: 'crate', repeat: [3, 1] }); // plank bridge
  addBox(scene, world, 54, 0.14, -40, 10, 0.28, 3, 0x8a6a40, { tex: 'crate', repeat: [3, 1] });
  addRamp(scene, world, { axis: 'x', minX: -56.5, maxX: -50, minZ: 28, maxZ: 32, h0: -4.8, h1: 0, color: 0x4a7a52 });
  addRamp(scene, world, { axis: 'x', minX: -58, maxX: -51.5, minZ: -52, maxZ: -48, h0: 0, h1: -4.8, color: 0x4a7a52 });
  addRamp(scene, world, { axis: 'x', minX: 50, maxX: 56.5, minZ: 28, maxZ: 32, h0: 0, h1: -4.8, color: 0x4a7a52 });
  addRamp(scene, world, { axis: 'x', minX: 51.5, maxX: 58, minZ: -52, maxZ: -48, h0: -4.8, h1: 0, color: 0x4a7a52 });
  // ground variety: dirt roads + flower meadows across the lawn
  addBox(scene, world, 10, 0.031, -40, 120, 0.06, 7, 0xb08a5a, { tex: 'dirt', repeat: [16, 1] });
  addBox(scene, world, -20, 0.036, 55, 22, 0.07, 18, 0xd8a8c8, { tex: 'flowers', repeat: [4, 3] });
  addBox(scene, world, 40, 0.036, -65, 18, 0.07, 14, 0xd8a8c8, { tex: 'flowers', repeat: [3, 3] });
  addBox(scene, world, -70, 0.036, 30, 16, 0.07, 20, 0xd8a8c8, { tex: 'flowers', repeat: [3, 4] });
  // Short curved ribbons add a continuous soft meadow layer without filling
  // the rivers, authored paths, flower beds, or major traversal landmarks.
  addCanopyMeadowGrass(scene, world, 4300);
  // floating platforms + pads
  addBox(scene, world, 30, 13.7, 55, 10, 0.6, 10, 0x8a6a40, { tex: 'crate' });
  addJumpPad(scene, world, 21, 0, 55, 30, 5, 0, 0xffd23c);
  // Launch from the far outside corner. The steeper arc rises above the
  // village deck before moving beneath its footprint, then descends on top.
  addJumpPad(scene, world, 26.5, 14, 58.5, 36, 9, -6, 0xa8ff70);
  pk(world, 'star', 30, 14.2, 55, { hidden: true });
  wp(world, 21, 0, 55); wp(world, 30, 14, 55);
  world.manualLinks.push(
    [21, 0, 55, 30, 14, 55, true],
    [30, 14, 55, 51.2, 30, 45, true],
  );
  addBox(scene, world, -35, 11.7, -60, 10, 0.6, 10, 0x8a6a40, { tex: 'crate' });
  addJumpPad(scene, world, -44, 0, -60, 28, 5, 0, 0xffd23c);
  addJumpPad(scene, world, -31.5, 12, -63.5, 36, -9, 8, 0xa8ff70);
  pk(world, 'health', -35, 12.2, -60);
  wp(world, -44, 0, -60); wp(world, -35, 12, -60);
  world.manualLinks.push(
    [-44, 0, -60, -35, 12, -60, true],
    [-35, 12, -60, -51.2, 30, -45, true],
  );
  // tournament banners on the hedges + the big tree
  addScoreTarget(scene, world, -20, 8, -79.94, 10, 0);
  addDecal(scene, 'poster4', 20, 9, 79.94, 10, Math.PI);
  addDecal(scene, 'hazard', -79.94, 8, 20, 10, Math.PI / 2);
  addScoreTarget(scene, world, 0, 12, -2.56, 4, Math.PI);
  for (const [x, z, w, d] of [[0, -83, 172, 6], [0, 83, 172, 6], [-83, 0, 6, 172], [83, 0, 6, 172]]) {
    addBox(scene, world, x, 14, z, w, 40, d, 0xf4fbf2, { tex: 'canopy-wall', repeat: [10, 3] });
  }
  // Perimeter wall vines — scattered climbs at varied start/end heights.
  // Keep x ≈ ±54 clear on the north/south wall faces (river-mouth waterfalls).
  for (const [x, z, y0, y1, r, leanX, leanZ, exitX, exitZ] of [
    [-28, -79.2, 0.2, 6.8, 0.85, 0, -0.18, 0, -1],
    [18, -79.2, 0.2, 28.6, 0.95, 0, -0.16, 0, -1],
    [58, -79.2, 10.4, 23.2, 0.9, 0, -0.2, 0, -1],
    [-38, 79.2, 0.2, 14.5, 0.85, 0, 0.18, 0, 1],
    [12, 79.2, 13.1, 31.4, 0.9, 0, 0.16, 0, 1],
    [64, 79.2, 0.2, 4.6, 0.8, 0, 0.2, 0, 1],
    [-79.2, -58, 0.2, 26.2, 0.95, -0.18, 0, -1, 0],
    [-79.2, 8, 8.2, 19.8, 0.85, -0.16, 0, -1, 0],
    [79.2, -22, 0.2, 11.2, 0.85, 0.18, 0, 1, 0],
    [79.2, 44, 16.6, 33.1, 0.95, 0.2, 0, 1, 0],
  ]) {
    addVine(scene, world, x, z, y0, y1, r, leanX, leanZ, exitX, exitZ);
  }

  // Trunks: NE/NW/SE solid; the SW tree is HOLLOW — slip in the ground door,
  // ride the hidden pad shaft to an attic, and step out onto the 20-deck.
  for (const [tx, tz] of [[45, -45], [-45, 45], [45, 45]]) {
    addBox(scene, world, tx, 21, tz, 8, 42, 8, 0xffffff, { tex: 'canopy-bark', repeat: [2, 11] });
  }
  const TR = 0xffffff;
  addBox(scene, world, -45, 32.5, -45, 8, 19, 8, TR, { tex: 'canopy-bark', repeat: [2, 5] }); // solid upper trunk
  addBox(scene, world, -48.4, 11.5, -45, 1.2, 23, 8, TR, { tex: 'canopy-bark', repeat: [2, 6] }); // shaft walls
  addBox(scene, world, -41.6, 11.5, -45, 1.2, 23, 8, TR, { tex: 'canopy-bark', repeat: [2, 6] });
  addBox(scene, world, -45, 11.5, -48.4, 5.6, 23, 1.2, TR, { tex: 'canopy-bark', repeat: [2, 6] });
  addBox(scene, world, -45, 9.75, -41.6, 5.6, 13.5, 1.2, TR, { tex: 'canopy-bark', repeat: [2, 4] }); // south wall (doors above/below)
  addBox(scene, world, -47.1, 1.5, -41.6, 1.4, 3, 1.2, TR, { tex: 'canopy-bark' });
  addBox(scene, world, -42.9, 1.5, -41.6, 1.4, 3, 1.2, TR, { tex: 'canopy-bark' });
  addBox(scene, world, -45, 18.25, -41.6, 5.6, 3.5, 1.2, TR, { tex: 'canopy-bark' });
  addBox(scene, world, -46.9, 21.5, -41.6, 1.8, 3, 1.2, TR, { tex: 'canopy-bark' });
  addBox(scene, world, -43.1, 21.5, -41.6, 1.8, 3, 1.2, TR, { tex: 'canopy-bark' });
  addBox(scene, world, -45, 9.7, -47.5, 5, 0.6, 1.6, 0x8a6a40, { tex: 'crate' });   // mid ledge
  addBox(scene, world, -45, 19.7, -44.45, 5.6, 0.6, 2.9, 0x8a6a40, { tex: 'crate' }); // attic (open shaft column at back)
  addJumpPad(scene, world, -45, 0, -43.5, 26, 0, -4.2, 0xffd23c);  // floor → mid ledge (clears its lip)
  addJumpPad(scene, world, -45, 10, -47.4, 24, 0, 1.5, 0xffd23c);  // ledge → attic
  const shaftLight = new THREE.PointLight(0xffb060, 25, 18);
  shaftLight.position.set(-45, 8, -45);
  scene.add(shaftLight);

  // center tree: hollow base room (door south, stairs up through the deck)
  // walls stop at 7.9 — tops tucked inside the deck slab (7..8); flush tops
  // at exactly 8 z-fight with the deck surface wherever they underlap it
  addBox(scene, world, -7.25, 3.95, 0, 1.5, 7.9, 16, 0xffffff, { tex: 'canopy-bark', repeat: [3, 2] });
  addBox(scene, world, 7.25, 3.95, 0, 1.5, 7.9, 16, 0xffffff, { tex: 'canopy-bark', repeat: [3, 2] });
  addBox(scene, world, 0, 3.95, -7.25, 13, 7.9, 1.5, 0xffffff, { tex: 'canopy-bark', repeat: [3, 2] });
  addBox(scene, world, -4.75, 3.95, 7.25, 5.5, 7.9, 1.5, 0xffffff, { tex: 'canopy-bark', repeat: [2, 2] });
  addBox(scene, world, 4.75, 3.95, 7.25, 5.5, 7.9, 1.5, 0xffffff, { tex: 'canopy-bark', repeat: [2, 2] });
  addRamp(scene, world, { axis: 'z', minX: -6, maxX: -3, minZ: -5, maxZ: 5, h0: 4, h1: 0, color: 0x8a6a40 });
  addBox(scene, world, -3, 3.7, -5.75, 6, 0.6, 1.5, 0x8a6a40, { tex: 'crate' }); // landing abuts the flight-1 top (overlap shoves climbers off)
  addRamp(scene, world, { axis: 'x', minX: 0, maxX: 8, minZ: -6.5, maxZ: -3.5, h0: 4, h1: 8, color: 0x8a6a40 });
  const roomLight = new THREE.PointLight(0xffb060, 25, 18);
  roomLight.position.set(0, 5, 0);
  scene.add(roomLight);
  addBox(scene, world, 0, 24, 0, 5, 32, 5, 0xffffff, { tex: 'canopy-bark', repeat: [2, 8] });

  // hedge lanes — break up the open lawn into corridors, plus a small maze
  // pocket in the SE quadrant (the pulsar sits inside it)
  for (const [hx, hz, hw, hd] of [
    [-15, 60, 50, 2], [15, -60, 50, 2], [60, 15, 2, 50], [-60, -15, 2, 50],
    // Stop the mirrored long hedges just short of the broad center ramps at
    // z = +/-2 instead of letting their ends clip into the ramp surfaces.
    [-30, 14, 2, 23.4], [30, -14, 2, 23.4],
    [18, -33, 24, 2], [10, -22, 2, 20], [24, -40, 2, 12],
    // tighter ground pockets around the tree room, hut, and log approaches
    [-18, -9, 18, 2], [18, 9, 18, 2],
    [14, 24, 18, 2], [38, 14, 2, 20],
    [-18, 35, 2, 18], [2, 35, 18, 2],
    [-39, -34, 18, 2], [-15, -16, 2, 18],
  ]) {
    addBox(scene, world, hx, 1.75, hz, hw, 3.5, hd, 0x588a42, {
      tex: 'grass', repeat: [Math.max(1, Math.round(Math.max(hw, hd) / 6)), 1],
    });
    (world.foliageZones ||= []).push({
      minX: hx - hw / 2 - 0.45, maxX: hx + hw / 2 + 0.45,
      minY: -0.1, maxY: 3.7,
      minZ: hz - hd / 2 - 0.45, maxZ: hz + hd / 2 + 0.45,
    });
  }
  // hedge-top balance beam: side ramp near the hedge's north end, then walk
  // the 2-wide top south (the south end abuts the big west ramp's corridor)
  addRamp(scene, world, { axis: 'x', minX: -29, maxX: -22.5, minZ: 21, maxZ: 23.5, h0: 3.5, h1: 0, color: 0x4a7a3a });

  // RANGER HUT (NE lawn): room with a west door, walkable roof, roof ramp
  const HUT = 0x8a6a40;
  addBox(scene, world, 26, 1.85, 12.3, 10, 3.7, 0.6, HUT, { tex: 'crate' });   // south wall
  addBox(scene, world, 26, 1.85, 19.7, 10, 3.7, 0.6, HUT, { tex: 'crate' });   // north wall
  addBox(scene, world, 30.7, 1.85, 16, 0.6, 3.7, 8, HUT, { tex: 'crate' });    // east wall
  addBox(scene, world, 21.3, 1.85, 13.4, 0.6, 3.7, 2.8, HUT, { tex: 'crate' }); // west wall + door gap
  addBox(scene, world, 21.3, 1.85, 18.6, 0.6, 3.7, 2.8, HUT, { tex: 'crate' });
  addBox(scene, world, 26, 4, 16, 10.6, 0.6, 8.6, HUT, { tex: 'crate' });      // roof (top 4.3)
  addRamp(scene, world, { axis: 'x', minX: 12.5, maxX: 20.7, minZ: 13, maxZ: 16.5, h0: 0, h1: 4.3, color: HUT });

  // FALLEN LOG (SW lawn): crawl-through tunnel, walkable on top via stumps
  const LOG = 0xffffff;
  addBox(scene, world, -27, 1.4, -25.6, 14, 2.8, 0.5, LOG, { tex: 'canopy-bark', repeat: [4, 1] });
  addBox(scene, world, -27, 1.4, -22.4, 14, 2.8, 0.5, LOG, { tex: 'canopy-bark', repeat: [4, 1] });
  addBox(scene, world, -27, 3, -24, 14, 0.6, 3.7, LOG, { tex: 'canopy-bark', repeat: [4, 1] }); // top 3.3
  addBox(scene, world, -37, 0.8, -20, 3, 1.6, 3, 0xffffff, { tex: 'canopy-bark' }); // stump steps up
  addBox(scene, world, -33, 1.3, -19.5, 3, 2.6, 3, 0xffffff, { tex: 'canopy-bark' });

  // Corner branch decks (tops at 10 and 20, trunk pierces through).
  // The SW tree's decks are donuts — its trunk is a hollow shaft inside.
  for (const [tx, tz] of [[45, -45], [-45, 45], [45, 45]]) {
    addBox(scene, world, tx, 9.5, tz, 14, 1, 14, 0x8a6a40, { tex: 'crate' });
    addBox(scene, world, tx, 19.5, tz, 14, 1, 14, 0x8a6a40, { tex: 'crate' });
  }
  for (const dy of [9.5, 19.5]) {
    addBox(scene, world, -45, dy, -39.5, 14, 1, 3, 0x8a6a40, { tex: 'crate' });   // south strip
    addBox(scene, world, -45, dy, -50.5, 14, 1, 3, 0x8a6a40, { tex: 'crate' });   // north strip
    addBox(scene, world, -50.5, dy, -45, 3, 1, 8, 0x8a6a40, { tex: 'crate' });    // west strip
    addBox(scene, world, -39.5, dy, -45, 3, 1, 8, 0x8a6a40, { tex: 'crate' });    // east strip
  }
  // Center tree tiers + crown (24 and the crown are offset so pad arcs can
  // approach from the side instead of bonking the underside of the next tier)
  // deck 8 has a stair-hole (NE) where the interior staircase emerges
  addBox(scene, world, 0, 7.5, -9, 20, 1, 2, 0x8a6a40, { tex: 'crate' });
  addBox(scene, world, -5, 7.5, -5, 10, 1, 6, 0x8a6a40, { tex: 'crate' });
  addBox(scene, world, 9, 7.5, -5, 2, 1, 6, 0x8a6a40, { tex: 'crate' });
  addBox(scene, world, 0, 7.5, 4, 20, 1, 12, 0x8a6a40, { tex: 'crate' });
  // Broad upper terraces leave enough room to circulate around the trunk and
  // receive the spiral ramps below. The top council deck extends slightly
  // farther so the four suspension bridges meet it with generous landings.
  addBox(scene, world, 0, 15.5, 0, 20, 1, 20, 0x8a6a40, { tex: 'crate', repeat: [5, 5] });
  addBox(scene, world, 0, 23.5, 0, 20, 1, 20, 0x8a6a40, { tex: 'crate', repeat: [5, 5] });
  addBox(scene, world, 0, 29.5, 0, 24, 1, 24, 0x9a7a4c, { tex: 'crate', repeat: [6, 6] });

  // TREETOP VILLAGE — broad settlement decks sit above the older combat
  // platforms, with treehouses tucked against the outer rim and suspension
  // bridges converging on the center-tree council platform.
  const villageY = 30;
  const villageCorners = [[-45, -45], [45, -45], [-45, 45], [45, 45]];
  const addVillageNavRing = (cx, cz, radius = 6.2) => {
    const points = [];
    for (let i = 0; i < 8; i++) {
      const angle = i * Math.PI / 4;
      const point = [cx + Math.cos(angle) * radius, villageY, cz + Math.sin(angle) * radius];
      points.push(point);
      wp(world, ...point);
      world.waypoints[world.waypoints.length - 1].manualLinksOnly = true;
    }
    for (let i = 0; i < points.length; i++) {
      world.manualLinks.push([...points[i], ...points[(i + 1) % points.length]]);
    }
    return points;
  };
  const nearestVillagePoint = (points, x, z) => points.reduce((best, candidate) => (
    Math.hypot(candidate[0] - x, candidate[2] - z)
      < Math.hypot(best[0] - x, best[2] - z) ? candidate : best
  ));
  const centerVillageRing = addVillageNavRing(0, 0, 6.2);
  // Tie the new council-square loop into the existing crown landing. The
  // village nodes deliberately opt out of broad automatic links so bots do
  // not cut across the trunk or hut walls.
  world.manualLinks.push([4, villageY, 0, ...nearestVillagePoint(centerVillageRing, 4, 0)]);
  for (let index = 0; index < villageCorners.length; index++) {
    const [tx, tz] = villageCorners[index];
    const sx = Math.sign(tx);
    const sz = Math.sign(tz);
    addBox(scene, world, tx, villageY - 0.5, tz, 26, 1, 26, 0x86613a,
      { tex: 'crate', repeat: [6, 6] });
    const cornerRing = addVillageNavRing(tx, tz, 6.2);

    const bridgeStart = V(tx - sx * 10.5, villageY, tz - sz * 10.5);
    const bridgeEnd = V(sx * 8, villageY, sz * 8);
    addCanopyVillageBridge(scene, world, bridgeStart, bridgeEnd, 4.4 * 1.3);
    world.manualLinks.push(
      [bridgeStart.x, bridgeStart.y, bridgeStart.z, ...nearestVillagePoint(cornerRing, bridgeStart.x, bridgeStart.z)],
      [bridgeEnd.x, bridgeEnd.y, bridgeEnd.z, ...nearestVillagePoint(centerVillageRing, bridgeEnd.x, bridgeEnd.z)],
    );

    // Doors face tangentially toward the bridge-side balcony instead of
    // opening radially toward the trunk or the outside edge.
    addCanopyTreehouse(
      scene, world, tx, villageY, tz + sz * 8.6, -sx,
      [0xffc45c, 0x75e0ff, 0xff8ac7, 0xa5ff78][index],
    );
    pk(world, 'grapple', tx, villageY + 0.2, tz + sz * 8.6);

    // Hang the village vine from the platform's true outer lip. The previous
    // upper-deck anchor sat six metres underneath the platform, which made the
    // vine look as though it grew through the ceiling. Keeping it continuous
    // to the lawn preserves a reachable two-way route after moving it outward.
    const vineX = tx + sx * 13.28;
    const vineZ = tz;
    addVine(scene, world, vineX, vineZ, 0.2, villageY + 0.15, 0.95,
      sx * 0.16, 0, -sx, 0);
    wp(world, vineX, 0.2, vineZ);
    wp(world, vineX, villageY, vineZ);
    world.manualLinks.push(
      [vineX, 0.2, vineZ, vineX, villageY, vineZ, true],
      [vineX, villageY, vineZ, ...nearestVillagePoint(cornerRing, vineX, vineZ)],
    );
  }

  // Lanterns mark the council square without posts blocking the four bridge
  // landings on the center platform.
  for (const [px, pz] of [[-7.8, -7.8], [7.8, -7.8], [-7.8, 7.8], [7.8, 7.8]]) {
    const lantern = new THREE.PointLight(0xffce72, 8, 10);
    lantern.position.set(px, 31.3, pz);
    scene.add(lantern);
  }

  // Edge bridges butt exactly into the deck edges at the same height. Their
  // runs stop at z/x ±38, leaving no 2cm lip and no coplanar overlap.
  addBox(scene, world, -45, 19.5, 0, 3.45, 1, 76, 0x7a5c38, { tex: 'crate', repeat: [1, 10] });
  addBox(scene, world, 45, 19.5, 0, 3.45, 1, 76, 0x7a5c38, { tex: 'crate', repeat: [1, 10] });
  addBox(scene, world, 0, 9.5, -45, 76, 1, 3.45, 0x7a5c38, { tex: 'crate', repeat: [10, 1] });
  addBox(scene, world, 0, 9.5, 45, 76, 1, 3.45, 0x7a5c38, { tex: 'crate', repeat: [10, 1] });
  addVine(scene, world, -46.72, -18, 0.2, 19.1, 1.05, -0.18, 0, 1, 0);  // hanging from west bridge
  addVine(scene, world, 46.72, 16, 0.2, 19.1, 1.05, 0.18, 0, -1, 0);    // hanging from east bridge
  addVine(scene, world, -46.72, 30, 0.2, 19.1, 1.0, -0.18, 0, 1, 0);    // west bridge south drop
  addVine(scene, world, 46.72, -28, 0.2, 19.1, 1.0, 0.18, 0, -1, 0);    // east bridge north drop
  addVine(scene, world, -18, -46.72, 0.2, 9.1, 0.95, 0, -0.18, 0, 1);   // north catwalk drop
  addVine(scene, world, 20, 46.72, 0.2, 9.1, 0.95, 0, 0.18, 0, -1);     // south catwalk drop
  addVine(scene, world, 34, -46.72, 0.2, 9.1, 0.9, 0, -0.18, 0, 1);     // north catwalk east drop
  addVine(scene, world, -34, 46.72, 0.2, 9.1, 0.9, 0, 0.18, 0, -1);     // south catwalk west drop
  addVine(scene, world, 10.28, -3, 0.2, 8.1, 0.85, 0.22, 0, -1, 0);     // lower deck edge opposite pathway
  addVine(scene, world, -10.28, 6.35, 8.1, 16.1, 0.85, -0.16, 0, 1, 0); // center 8 -> 16 west edge
  addVine(scene, world, 10.28, -4.75, 16.1, 24.1, 0.8, 0.16, 0, -1, 0); // center 16 -> 24 east edge
  addVine(scene, world, -45, -52.28, 0.2, 20.1, 0.95, 0, -0.18, 0, 1);   // SW hollow tree north outer edge
  addVine(scene, world, -31.08, 15, 0.2, 4.1, 0.8, -0.14, 0, 1, 0);     // hedge-top shortcut
  addVine(scene, world, 45, -52.28, 0.2, 19.1, 0.9, 0, -0.18, 0, 1);    // NE tree north outer edge
  addVine(scene, world, -45, 52.28, 0.2, 19.1, 0.9, 0, 0.18, 0, -1);    // NW tree south outer edge
  addVine(scene, world, 45, 52.28, 0.2, 19.1, 0.9, 0, 0.18, 0, -1);     // SE trunk side
  addVine(scene, world, -4, 10.28, 0.2, 15.1, 0.85, 0, 0.16, 0, -1);    // center tiers south edge
  addVine(scene, world, 31.38, 16, 0.2, 4.2, 0.75, 0.16, 0, -1, 0);     // ranger hut roof east edge
  addVine(scene, world, -11, 61.18, 0.2, 3.8, 0.8, 0, 0.16, 0, -1);     // north hedge lane
  addVine(scene, world, 61.18, -3, 0.2, 3.8, 0.8, 0.16, 0, -1, 0);      // east hedge lane
  // Keep the upper vines outside the decks they serve. The west vine hangs
  // from the exposed outer edge of the diagonal council ramp, well away from
  // the stacked center platforms; the east vine begins on level 24 instead of
  // passing through that floor.
  addVine(scene, world, 12.28, -6, 24.1, 30.1, 0.9, 0.16, 0, -1, 0);     // center 24 -> council edge
  addVine(scene, world, -30, -9.28, 0.2, 25, 0.9, 0, -0.16, 0, 1);      // ground -> diagonal ramp edge

  // Ramps: ground ↔ center deck 8; bridges ↔ center 16 / center 8
  addRamp(scene, world, { axis: 'x', minX: 10, maxX: 42, minZ: -2, maxZ: 2, h0: 8, h1: 0, color: 0x8a6a40 });
  addRamp(scene, world, { axis: 'x', minX: -42, maxX: -10, minZ: -2, maxZ: 2, h0: 0, h1: 8, color: 0x8a6a40 });
  addRamp(scene, world, { axis: 'x', minX: -43.5, maxX: -7, minZ: -2, maxZ: 2, h0: 20, h1: 16, color: 0x8a6a40 });
  // The east middle-tier catwalk doubles as the launch runway for the
  // level-16 pad. Keep it broad enough to circulate past the pad safely.
  // Both center jump-pad runways are 20% wider than their original authored
  // widths: 8 -> 9.6 here and 4 -> 4.8 on the south approach.
  addRamp(scene, world, { axis: 'x', minX: 7, maxX: 43.5, minZ: -4.8, maxZ: 4.8,
    h0: 16, h1: 20, color: 0x8a6a40 });
  addRamp(scene, world, { axis: 'z', minX: -2, maxX: 2, minZ: -43.5, maxZ: -10, h0: 10, h1: 8, color: 0x8a6a40 });
  addRamp(scene, world, { axis: 'z', minX: -2.4, maxX: 2.4, minZ: 10, maxZ: 43.5,
    h0: 8, h1: 10, color: 0x8a6a40 });

  // Continuous center-tree ascent. Every flight now runs fully outside the
  // destination deck footprint. Short level landings meet the deck edges, so
  // climbers rise beside each floor and step sideways onto its top instead of
  // walking into the underside.
  addRamp(scene, world, { axis: 'z', minX: 10.5, maxX: 14, minZ: -9, maxZ: 9,
    h0: 8, h1: 16, color: 0x8a6a40, visualInset: 0.08 });
  addBox(scene, world, 12, 7.75, -9.5, 4, 0.5, 1, 0x8a6a40, { tex: 'crate' });
  addBox(scene, world, 12, 15.75, 9.5, 4, 0.5, 1, 0x8a6a40, { tex: 'crate' });

  addRamp(scene, world, { axis: 'z', minX: -14, maxX: -10.5, minZ: -9, maxZ: 9,
    h0: 24, h1: 16, color: 0x8a6a40, visualInset: 0.08 });
  addBox(scene, world, -12, 15.75, 9.5, 4, 0.5, 1, 0x8a6a40, { tex: 'crate' });
  addBox(scene, world, -12, 23.75, -9.5, 4, 0.5, 1, 0x8a6a40, { tex: 'crate' });

  addRamp(scene, world, { axis: 'x', minX: -9, maxX: 9, minZ: -16, maxZ: -12.5,
    h0: 24, h1: 30, color: 0x8a6a40, visualInset: 0.08 });
  addBox(scene, world, -9.5, 23.75, -13, 1, 0.5, 6, 0x8a6a40,
    { tex: 'crate', repeat: [1, 2] });
  addBox(scene, world, 9.5, 29.75, -14, 1, 0.5, 4, 0x8a6a40,
    { tex: 'crate' });
  // An additional direct approach rises from the west level-20 catwalk to the
  // council deck. Stop the sloped slab before the deck underside and bridge
  // the last metre with a level landing, so the ramp meets the open deck lip
  // instead of visually and physically disappearing into the floor.
  addRamp(scene, world, { axis: 'x', minX: -43.5, maxX: -16, minZ: -9, maxZ: -5,
    h0: 20, h1: 30, color: 0x8a6a40, visualInset: 0.08 });
  addBox(scene, world, -14, 29.75, -7, 4, 0.5, 8, 0x8a6a40,
    { tex: 'crate', repeat: [2, 2] });
  for (const [a, b] of [
    [[12, 8, -9.5], [12, 16, 9.5]],
    [[-12, 16, 9.5], [-12, 24, -9.5]],
    [[-9.5, 24, -14], [9.5, 30, -14]],
    [[-43.5, 20, -7], [-14, 30, -7]],
  ]) {
    wp(world, ...a); wp(world, ...b);
    world.manualLinks.push([...a, ...b]);
  }

  // Pads: ground → corner decks, plus a direct center-tree launch to the
  // concealed gold fort. The upper-tier pads remain as alternate routes.
  addJumpPad(scene, world, -30, 0, -30, 24, -11.5, -11.5, 0x9dff70);
  addJumpPad(scene, world, 30, 0, -30, 24, 11.5, -11.5, 0x9dff70);
  addJumpPad(scene, world, -30, 0, 30, 24, -11.5, 11.5, 0x9dff70);
  addJumpPad(scene, world, 30, 0, 30, 24, 11.5, 11.5, 0x9dff70);
  // Center the lower pad on the 20%-wider south runway and move it two metres
  // toward the outer wall. Its northward arc still clears the level-16 deck.
  addJumpPad(scene, world, 0, 8.52, 18, 38.5, 3.3, -7, 0xffd23c); // 8 → crown
  // Center the entire pad on the widened runway and move it two metres toward
  // the corner tree, leaving clear walking space on both sides.
  addJumpPad(scene, world, 17, 17.2, 0, 22, -8, -1.2, 0xffd23c); // 16 → 24

  // Broad, layered treetops now rise well above the village roofs. Their
  // foliage zones
  // deliberately retain the old radii so this visual upgrade does not expand
  // the movement slowdown or camera-leaf overlay into the bridge routes.
  const deco = { colliders: [], ramps: [] };
  world.grappleFoliageTargets = [
    { center: V(45, 45.5, 45), radius: 12.5, embed: 1 },
    { center: V(-45, 45.5, -45), radius: 12.5, embed: 1 },
    { center: V(45, 45.5, -45), radius: 12.5, embed: 1 },
    { center: V(-45, 45.5, 45), radius: 12.5, embed: 1 },
    { center: V(0, 50.5, 0), radius: 15.2, embed: 1 },
  ];
  addCanopyCrown(scene, 45, 45.5, 45, 13, 1, true, 42); // one tree turns first
  (world.foliageZones ||= []).push({ x: 45, y: 49, z: 45, r: 12.5 });
  for (const [x, z, seed] of [
    [-45, -45, 2], [45, -45, 3], [-45, 45, 4],
  ]) {
    addCanopyCrown(scene, x, 45.5, z, 13, seed, false, 42);
    world.foliageZones.push({ x, y: 49, z, r: 13 * 0.95 });
  }
  // The center crown sits around the gold platform like a hidden tree fort.
  // Its limbs begin above the extended trunk, sheltering the council deck
  // while leaving the jump-pad landing and platform collision untouched.
  addCanopyCrown(scene, 0, 50.5, 0, 16, 5, false, 40);
  world.foliageZones.push({ x: 0, y: 55, z: 0, r: 16 * 0.95 });
  // A second, inaccessible tree line beyond the arena wall closes the horizon
  // into a continuous canopy. These trees are presentation-only: their limbs
  // never alter the playable collision or bot graph inside the village.
  const horizonBark = mat(0xffffff, { tex: 'canopy-bark', repeat: [2, 10], roughness: 0.96 });
  for (const [x, z, seed] of [
    [-98, -48, 11], [-98, 42, 12], [98, -40, 13], [98, 50, 14],
    [-44, -98, 15], [48, 98, 16],
  ]) {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(3.1, 4.1, 44, 10), horizonBark);
    trunk.position.set(x, 22, z);
    trunk.castShadow = trunk.receiveShadow = true;
    scene.add(trunk);
    addCanopyCrown(scene, x, 47, z, 11, seed, seed % 4 === 0, 42);
  }
  // Smaller ground bushes keep their compact silhouette.
  for (const [x, y, z, r] of [
    [-20, 1, -60, 3], [60, 1, 20, 3], [-60, 1, 10, 2.5], [25, 1, 60, 3],
  ]) {
    const blob = addAsteroid(scene, deco, x, y, z, r, 0x3f7a33);
    blob.material.map = null;
    world.foliageZones.push({ x, y, z, r: r * 0.95 });
  }
  addCanopyBirdFlocks(scene, world);

  // Spawns
  // Keep the side starts out from behind the x = +/-60 hedge lanes. Facing
  // toward mid from the old rows put several players directly into a hedge.
  for (const dz of [25, 35, 45, 55, 65]) world.spawns.blue.push(V(-70, 0.1, dz));
  for (const dz of [-65, -55, -45, -35, -25]) world.spawns.red.push(V(70, 0.1, dz));
  // Keep these clear of trunks, ramps, and hedges. The multiplayer server
  // mirrors this pool so its authoritative position cannot snap a player into
  // scenery after the local spawn selection has placed them safely.
  for (const [x, y, z] of [[-32, 10.2, -40], [32, 10.2, 40], [0, 8.2, -7], [-68, 0.1, 25], [68, 0.1, -25],
                           [-40, 20.2, 40], [40, 20.2, -40], [8, 10.2, 45], [-8, 10.2, -45],
                           [-34, 0.1, -30], [34, 0.1, -30], [-34, 0.1, 30], [34, 0.1, 30]]) {
    world.spawns.ffa.push(V(x, y, z));
  }

  // Pickups
  pk(world, 'shield', 40, 10.4, 40);                     // NE 10-deck
  pk(world, 'speed', 20, 0.2, 42);                       // NE lawn
  pk(world, 'djump', 55, 0.2, -20);                      // on the dirt road
  pk(world, 'gold', 4, 30.2, 0);                          // the crown
  pk(world, 'silver', 0, 0.2, 0);                         // hidden in the tree-base room
  pk(world, 'health', 0, 16.2, 4);
  pk(world, 'weapon', 40, 20.2, 39, { weapon: 'whomper' });
  pk(world, 'weapon', 0, 0.2, -20, { weapon: 'sidewinder' });
  pk(world, 'weapon', -40, 20.2, -39, { weapon: 'hyper' });
  pk(world, 'weapon', 30, 0.2, 24, { weapon: 'zooka' });
  pk(world, 'weapon', -25, 0.2, 25, { weapon: 'scatter' });
  pk(world, 'weapon', 25, 0.2, -25, { weapon: 'pulsar' });
  pk(world, 'speed', -46, -3.1, 64);                         // just inside the west connector entrance
  pk(world, 'weapon', 0, -4.35, 55, { weapon: 'hyper' });    // secret branch stash
  pk(world, 'weapon', -20, 6.1, 0, { weapon: 'parasite' });      // west ramp
  pk(world, 'ammo', 39, 20.2, 44, { weapon: 'whomper' });
  pk(world, 'ammo', 0, 0.2, -26, { weapon: 'sidewinder' });
  pk(world, 'ammo', -39, 20.2, -44, { weapon: 'hyper' });
  pk(world, 'ammo', -28, 3.9, 0, { weapon: 'parasite' });
  pk(world, 'ammo', 0, 10.2, -45, { weapon: 'zooka' });    // north bridge mid
  pk(world, 'ammo', 0, 10.2, 45, { weapon: 'scatter' });
  pk(world, 'ammo', -40, 10.2, 40, { weapon: 'pulsar' });
  pk(world, 'health', -60, 0.2, -60);
  pk(world, 'health', 60, 0.2, 60);
  pk(world, 'health', 0, 8.2, 7);
  pk(world, 'health', 40, 10.2, -40);
  pk(world, 'health', -40, 10.2, -40);
  pk(world, 'star', -45, 0.2, -53, { hidden: true });     // behind the SW trunk
  pk(world, 'star', 0, 0.2, 8, { hidden: true });         // beneath the center deck
  pk(world, 'star', 45, 20.2, 0, { hidden: true });       // east bridge mid
  pk(world, 'star', -45, 20.4, -44, { hidden: true });    // the SW tree's secret attic
  pk(world, 'health', 26, 0.2, 16);                       // inside the ranger hut
  pk(world, 'ammo', -27, 0.2, -24, { weapon: 'scatter' }); // in the fallen log
  pk(world, 'star', -30, 3.9, 25, { hidden: true });      // hedge-top balance beam

  // Waypoints: auto grid on the ground, hand-placed for the canopy levels
  const blocked = (x, z) => {
    if (Math.abs(x) < 4 && z > 39 && z < 51) return true; // surfaced tunnel opening
    const p = V(x, 1, z);
    for (const c of world.colliders) {
      if (c.type !== 'box') continue;
      if (p.x > c.min.x - 1.2 && p.x < c.max.x + 1.2 && p.y > c.min.y && p.y < c.max.y &&
          p.z > c.min.z - 1.2 && p.z < c.max.z + 1.2) return true;
    }
    return false;
  };
  for (let gx = -62; gx <= 62; gx += 15.5) {
    for (let gz = -62; gz <= 62; gz += 15.5) {
      const x = Math.round(gx), z = Math.round(gz);
      if (!blocked(x, z)) wp(world, x, 0, z);
    }
  }
  const wps = [
    [27, 4, 0], [-27, 4, 0],                                // ground ramps
    // ranger hut: door, interior, ramp, roof
    [19, 0, 16], [26, 0, 16], [16.5, 2.2, 14.75], [26, 4.3, 16],
    // fallen log tunnel + SE hedge maze pocket
    [-27, 0, -24], [-20, 0, -24], [-34, 0, -24],
    [16, 0, -18], [16, 0, -29], [4, 0, -29], [28, 0, -37],
    [-45, 0, -34], [-30, 0, -34], [-15, 0, -7], [-15, 0, -25],
    // close-quarters hedge pockets around center tree, ranger hut, north lawn
    [-26, 0, -9], [-10, 0, -9], [10, 0, 9], [26, 0, 9],
    [5, 0, 24], [23, 0, 24], [38, 0, 4], [38, 0, 24],
    [-18, 0, 25], [-18, 0, 44], [-7, 0, 35], [12, 0, 35],
    // river: bed line, flooded tunnels, exit-ramp mids, crossings on top
    [-54, -2.6, -20], [-54, -2.6, 4], [-54, -2.6, 24], [-54, -2.6, 40], [-54, -2.6, 56],
    [-53, -1.2, 30], [-55, -1.2, -50],
    [54, -2.6, -20], [54, -2.6, 4], [54, -2.6, 24], [54, -2.6, 40], [54, -2.6, 56],
    [53, -1.2, 30], [55, -1.2, -50],
    [-40, -2.6, 64], [-18, -2.6, 64], [0, -2.6, 64], [18, -2.6, 64], [40, -2.6, 64],
    [0, -2.6, 59], [0, -3.5, 55], [0, -4.4, 51],           // secret branch corridor
    [0, -3.4, 48], [0, -1.9, 45], [0, -0.5, 42], [0, 0, 39], // branch ramp + surface exit
    [-54, 0, -40], [-54, 0, 10], [-54, 0, 46],
    [54, 0, -40], [54, 0, 10], [54, 0, 46],
    // center tree-base room + interior stairs
    [0, 0, 2], [0, 0, 12], [-4.5, 2, 0], [-1.5, 4, -5], [3, 6, -5],
    // SW hollow tree: door, shaft, ledge, attic, top exit
    [-45, 0, -38], [-45, 0, -45], [-45, 10, -47.4], [-45, 20, -44.5], [-45, 20, -40],
    // center tiers (+ pad spots)
    [0, 8, -7], [0, 8, 7], [-7, 8, 0], [0, 8.52, 18],
    [0, 16, 4.5], [17, 17.2, 0], [-5, 16, -4], [-5, 16, 4],
    [-3, 24, 3],
    [4, 30, 0],
    // relocated usable vine endpoints
    [10.28, 0.2, -3], [10.28, 8, -3],
    [-10.28, 8, 6.35], [-10.28, 16, 6.35],
    [10.28, 16, -4.75], [10.28, 24, -4.75],
    [-4, 0.2, 10.28], [-4, 15, 10.28],
    [-45, 0.2, -52.28], [-45, 20, -52.28],
    [-30, 0.2, -9.28], [-30, 24.9, -9.28], [-30, 24.9, -7],
    [12.28, 24, -6], [12.28, 30, -6],
    // corner decks (offset off the trunk that pierces them)
    [-40, 10, -39.5], [40, 10, -39.5], [-40, 10, 39.5], [40, 10, 39.5],
    [-40, 20, -39.5], [40, 20, -39.5], [-40, 20, 39.5], [40, 20, 39.5],
    [-40, 20, -50.5],                                    // SW hollow tree north landing
    // bridges (10 N/S, 20 W/E) + tier ramps
    [-19, 10, -45], [0, 10, -45], [19, 10, -45], [-19, 10, 45], [0, 10, 45], [19, 10, 45],
    [-32, 10, -45], [32, 10, -45], [-32, 10, 45], [32, 10, 45],   // bridge↔deck joins
    [-45, 20, -19], [-45, 20, 0], [-45, 20, 19], [45, 20, -19], [45, 20, 0], [45, 20, 19],
    [-45, 20, -32], [-45, 20, 32], [45, 20, -32], [45, 20, 32],
    [-24, 18, 0], [24, 18, 0],                              // bridge↔center-16 ramps
    [0, 9, -25], [0, 9, 25],                                // bridge-10↔center-8 ramps
  ];
  for (const [x, y, z] of wps) wp(world, x, y, z);
  world.manualLinks.push(
    [-30, 0, -30, -45, 10, -45, true], [30, 0, -30, 45, 10, -45, true],
    [-30, 0, 30, -45, 10, 45, true], [30, 0, 30, 45, 10, 45, true],
    [-45, 0, -45, -45, 10, -47.4, true],  // SW tree shaft pads
    [-45, 10, -47.4, -45, 20, -44.5, true],
    [0, -2.6, 64, 0, -3.5, 55], [0, -3.5, 55, 0, 0, 39], // connector branch and exit
    [0, 8.52, 18, 4, 30, 0, true],     // direct pad to the crown gold
    [17, 17.2, 0, -3, 24, 3, true],
    [10.28, 0.2, -3, 10.28, 8, -3, true],
    [10.28, 8, -3, 0, 8, -7],
    [-10.28, 8, 6.35, -10.28, 16, 6.35, true],
    [-10.28, 8, 6.35, 0, 8, 7],
    [-10.28, 16, 6.35, 0, 16, 4.5],
    [10.28, 16, -4.75, 10.28, 24, -4.75, true],
    [10.28, 16, -4.75, -5, 16, -4],
    [10.28, 24, -4.75, -3, 24, 3],
    [-4, 0.2, 10.28, -4, 15, 10.28, true],
    [-4, 15, 10.28, 0, 16, 4.5],
    [-45, 0.2, -52.28, -45, 20, -52.28, true],
    [-45, 20, -52.28, -40, 20, -50.5],
    [-40, 20, -50.5, -40, 20, -39.5],
    [-30, 0.2, -9.28, -30, 24.9, -9.28, true],
    [-30, 24.9, -9.28, -30, 24.9, -7],
    [-30, 24.9, -7, -14, 30, -7],
    [12.28, 24, -6, 12.28, 30, -6, true],
    [12.28, 24, -6, -3, 24, 3],
    [12.28, 30, -6, 4, 30, 0],
    [4, 30, 0, 0, 8, 7, true],        // step off the crown to descend
    [-45, 20, -45, -45, 10, -45, true], [45, 20, -45, 45, 10, -45, true],
    [-45, 20, 45, -45, 10, 45, true], [45, 20, 45, 45, 10, 45, true],
    [-45, 10, -45, -30, 0, -30, true], [45, 10, 45, 30, 0, 30, true],
  );
  mergeStatic(scene, world);
  return world;
}

/* ============== MAP 5 — NEON HEIGHTS (city rooftops, vertical to y=34) ==============
   Two rows of towers over a street canyon: fire escapes up, pad-hops between
   roofs, two long sloped skybridges linking the rows. Gold tops the tallest. */
function addCityPresentation(scene, world) {
  const essential = new THREE.Group();
  const standard = new THREE.Group();
  const high = new THREE.Group();
  scene.add(essential, standard, high);

  // Landmark labels make the vertical routes legible from the street without
  // competing with the existing wall posters.
  addArenaSign(essential, 'VICE GALLERIA', -12, 29.2, 21.92, 17, 3.6, Math.PI, '#ff3ca6', 'neon');
  addArenaSign(essential, 'LASER PALMS', 32, 22.5, -21.92, 14, 3.2, 0, '#32e7ff', 'neon');
  addArenaSign(essential, 'MIDNIGHT ARCADE', -12, 14.3, -49.98, 16, 3.2, 0, '#ffd23c', 'neon');
  registerWallFeature(world, 'galleria-south', 'Vice Galleria sign', -12, 29.2, 17, 3.6);
  registerWallFeature(world, 'east-tower-north', 'Laser Palms sign', 32, 22.5, 14, 3.2);
  registerWallFeature(world, 'arcade-south', 'Midnight Arcade sign', -12, 14.3, 16, 3.2);

  // A striped synthwave sun is an unlit skyline landmark. Every stripe has
  // its own geometry, so there are no transparent coplanar layers to flicker.
  const sunMat = new THREE.MeshBasicMaterial({ color: 0xff6a73, toneMapped: false, side: THREE.DoubleSide });
  for (let i = 0; i < 7; i++) {
    const y = 19 + i * 1.18;
    const half = Math.sqrt(Math.max(0, 64 - (y - 23) * (y - 23)));
    const stripe = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, 0.72), sunMat);
    stripe.position.set(47, y, 63.7);
    stripe.rotation.y = Math.PI;
    standard.add(stripe);
  }

  // Instanced windows keep the skyline vivid without turning hundreds of
  // window meshes into hundreds of draw calls.
  const windowGeo = new THREE.PlaneGeometry(1.45, 0.48);
  const windowMat = new THREE.MeshBasicMaterial({
    color: 0x45eaff, toneMapped: false, transparent: true, opacity: 0.88,
    side: THREE.DoubleSide, ...DECOR_DEPTH_BIAS,
  });
  const windows = [];
  for (const [cx, cz, size, height, signedFace] of [
    // The blue and pink towers close the east end of the street canyon; both
    // need lit façades so that end of the map reads as occupied skyline.
    [32, -35, 26, 28, 'north'], [62, -32, 18, 16, null],
    [-58, 33, 22, 24, null], [32, 34, 22, 18, null],
    // Carry the same window grid across the remaining skyline blocks,
    // including the purple and pink towers at the opposite end.
    [64, 30, 16, 10, null], [-78, 24, 12, 16, null], [-78, -30, 12, 18, null],
    [-38, 58, 14, 14, null], [10, 58, 16, 12, null], [78, 48, 12, 22, null],
    [78, -50, 12, 18, null], [-36, -60, 14, 10, null], [12, -58, 12, 14, null],
  ]) {
    const edge = size / 2 + 0.04;
    for (const face of ['north', 'south', 'east', 'west']) {
      for (let y = 3; y < height - 1; y += 2.7) for (let q = -size / 2 + 2; q < size / 2 - 1; q += 3.4) {
        // Preserve a clean field around the LASER PALMS hero sign.
        if (signedFace === face && y > 19.5 && y < 25.2 && Math.abs(q) < 8) continue;
        windows.push({
          x: face === 'north' || face === 'south' ? cx + q : cx + (face === 'east' ? edge : -edge),
          y,
          z: face === 'east' || face === 'west' ? cz + q : cz + (face === 'north' ? edge : -edge),
          yaw: face === 'east' || face === 'west' ? Math.PI / 2 : 0,
        });
      }
    }
  }
  const windowMesh = new THREE.InstancedMesh(windowGeo, windowMat, windows.length);
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    matrix.compose(V(w.x, w.y, w.z), new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), w.yaw), V(1, 1, 1));
    windowMesh.setMatrixAt(i, matrix);
  }
  standard.add(windowMesh);

  // Curved, tapered palms replace the old asterisk silhouettes. Geometry is
  // merged into two meshes, so adding a sidewalk row does not add dozens of
  // draw calls. baseY is the exact supporting surface: no floating trunks.
  const trunkGeometries = [], frondGeometries = [];
  const addPalmGeometry = (x, baseY, z, scale = 1, lean = 0) => {
    const trunkH = 4.8 * scale;
    const trunk = new THREE.CylinderGeometry(0.14 * scale, 0.34 * scale, trunkH, 7, 4);
    trunk.rotateZ(lean);
    // A +Z rotation sends the trunk's local +Y toward -X. Translate around
    // the ground endpoint, then derive the crown from that same transform.
    trunk.translate(x - Math.sin(lean) * trunkH * 0.5, baseY + Math.cos(lean) * trunkH * 0.5, z);
    trunkGeometries.push(trunk);
    const crownX = x - Math.sin(lean) * trunkH;
    const crownY = baseY + Math.cos(lean) * trunkH;
    for (let i = 0; i < 7; i++) {
      const a = i * Math.PI * 2 / 7 + 0.18;
      const len = (2.7 + (i % 2) * 0.45) * scale;
      const curve = new THREE.CatmullRomCurve3([
        V(crownX, crownY, z),
        V(crownX + Math.cos(a) * len * 0.42, crownY + 0.48 * scale, z + Math.sin(a) * len * 0.42),
        V(crownX + Math.cos(a) * len * 0.78, crownY + 0.15 * scale, z + Math.sin(a) * len * 0.78),
        V(crownX + Math.cos(a) * len, crownY - 0.65 * scale, z + Math.sin(a) * len),
      ]);
      frondGeometries.push(new THREE.TubeGeometry(curve, 6, 0.095 * scale, 4, false));
    }
  };
  for (const palm of [
    // Rooftops: bases exactly match their supporting roof heights.
    [70, 10, 26, 0.85, 0.07], [-73, 16, 26, 0.8, -0.06], [39, 28, -30, 0.9, 0.08],
    // Ground-level sidewalk rhythm, kept outside primary firing lanes.
    [-73, 0, -10, 0.9, -0.05], [-73, 0, 12, 1.0, 0.06], [-73, 0, 51, 0.82, -0.04],
    [73, 0, -13, 0.88, 0.05], [73, 0, 14, 0.96, -0.06], [73, 0, 55, 0.84, 0.04],
  ]) addPalmGeometry(...palm);
  const palms = new THREE.Group();
  palms.add(
    new THREE.Mesh(mergeGeometries(trunkGeometries, false), mat(0xff5a8f, { roughness: 0.5, emissive: 0x6e173d, emissiveIntensity: 0.55 })),
    new THREE.Mesh(mergeGeometries(frondGeometries, false), new THREE.MeshBasicMaterial({ color: 0x65ffb0, toneMapped: false })),
  );
  standard.add(palms);

  world.anim.push((dt, t) => {
    windowMat.opacity = 0.84 + Math.sin(t * 0.7) * 0.08;
  });
  world.setVisualQuality = tier => {
    essential.visible = true;
    standard.visible = tier !== 'low';
    high.visible = tier === 'high';
  };
  world.setVisualQuality('high');
}

function buildCity(scene) {
  const world = newWorld({ killY: -20, waypointLinkDist: 24, waypointLinkDy: 4.6 });
  scene.background = new THREE.Color(0x0b1026);
  scene.fog = new THREE.Fog(0x0b1026, 120, 380);
  baseLighting(scene, 0x7788cc, 0x101018, [-60, 110, 40], 130);
  addNightSkyDome(scene);

  // Street (split into bands leaving two subway stair openings)
  addBox(scene, world, -17.5, -0.5, -39.5, 139, 1, 55, 0x3a3f4a, { tex: 'neonfloor', repeat: [16, 7] });
  addBox(scene, world, 73.5, -0.5, -39.5, 27, 1, 55, 0x3a3f4a, { tex: 'neonfloor', repeat: [3, 7] });
  addBox(scene, world, 56, -0.5, -29, 8, 1, 34, 0x3a3f4a, { tex: 'neonfloor', repeat: [1, 4] });
  addBox(scene, world, 56, -0.5, -60.5, 8, 1, 13, 0x3a3f4a, { tex: 'neonfloor', repeat: [1, 2] });
  addBox(scene, world, -60.5, -0.5, -7, 53, 1, 10, 0x3a3f4a, { tex: 'neonfloor', repeat: [7, 2] });
  addBox(scene, world, 30.5, -0.5, -7, 113, 1, 10, 0x3a3f4a, { tex: 'neonfloor', repeat: [14, 2] });
  addBox(scene, world, 0, -0.5, 0, 174, 1, 4, 0x3a3f4a, { tex: 'neonfloor', repeat: [20, 1] });
  addBox(scene, world, -29.5, -0.5, 7, 115, 1, 10, 0x3a3f4a, { tex: 'neonfloor', repeat: [14, 2] });
  addBox(scene, world, 61.5, -0.5, 7, 51, 1, 10, 0x3a3f4a, { tex: 'neonfloor', repeat: [7, 2] });
  addBox(scene, world, 0, -0.5, 39.5, 174, 1, 55, 0x3a3f4a, { tex: 'neonfloor', repeat: [20, 7] });

  // SUBWAY: two ramps into one sealed underground room. Keep the interiors
  // open; only perimeter walls seal the void.
  addRamp(scene, world, {
    axis: 'z', minX: -34, maxX: -26, minZ: -12, maxZ: -2,
    h0: -6, h1: 0, color: 0x2f3542, supportPad1: 0.8,
  });
  // South subway exit stops exactly at the street slab's z=12 edge. The old
  // extra meter ran beneath that slab, producing a visible lip at the crest.
  addRamp(scene, world, { axis: 'z', minX: 28, maxX: 36, minZ: -1, maxZ: 12, h0: -6, h1: 0, color: 0x2f3542 });
  addBox(scene, world, 1, -6.5, -6.8, 74, 1, 14.4, 0x2f3542, { tex: 'panel', repeat: [10, 2] });
  addBox(scene, world, -32, -6.5, 7.2, 8, 1, 13.6, 0x2f3542, { tex: 'panel', repeat: [1, 2] });
  addBox(scene, world, 36, -6.5, 7.2, 4, 1, 13.6, 0x2f3542, { tex: 'panel', repeat: [1, 2] });
  addBox(scene, world, 1, -3.55, -14.5, 74, 4.9, 1, 0x262b38, { tex: 'panel', repeat: [10, 1] });
  addBox(scene, world, 1, -3.55, 14.5, 74, 4.9, 1, 0x262b38, { tex: 'panel', repeat: [10, 1] });
  addBox(scene, world, -36.5, -3.55, 0, 1, 4.9, 28, 0x262b38, { tex: 'panel', repeat: [1, 4] });
  addBox(scene, world, 38.5, -3.55, 0, 1, 4.9, 28, 0x262b38, { tex: 'panel', repeat: [1, 4] });
  addLava(scene, world, 3, 7.4, 62, 14, -6.89);
  world.lavaZones[world.lavaZones.length - 1].maxY = -6.04;
  for (const [x, z, w, d] of [[-22, 7, 6, 4.5], [-6, 7, 5, 4], [11, 7, 5, 4], [29, 5, 6, 5]]) {
    addBox(scene, world, x, -6.22, z, w, 0.44, d, 0x4d5668, { tex: 'panel', repeat: [2, 1] });
  }
  const tubeLight = new THREE.PointLight(0xffe040, 30, 34);
  tubeLight.position.set(0, -3, -7);
  scene.add(tubeLight);
  for (const [x, z, w, d] of [[0, -67, 182, 6], [0, 67, 182, 6]]) {
    addBox(scene, world, x, 14, z, w, 40, d, 0x1d2433, { tex: 'neonwall' });
  }
  // East/west perimeter walls split around the second-floor monorail tunnels.
  for (const x of [-88, 88]) {
    addBox(scene, world, x, 14, -37, 6, 40, 60, 0x1d2433, { tex: 'neonwall' });
    addBox(scene, world, x, 14, 37, 6, 40, 60, 0x1d2433, { tex: 'neonwall' });
    addBox(scene, world, x, 0.55, 0, 6, 13.1, 12, 0x1d2433, { tex: 'neonwall' });
    addBox(scene, world, x, 25.3, 0, 6, 17.4, 12, 0x1d2433, { tex: 'neonwall' });
    addBox(scene, world, x, 7.1, -6.2, 6.4, 2.2, 0.4, 0x30e0ff,
      { collide: false, shadow: false, emissive: 0x30e0ff, emissiveIntensity: 1.8 });
    addBox(scene, world, x, 7.1, 6.2, 6.4, 2.2, 0.4, 0xff40a0,
      { collide: false, shadow: false, emissive: 0xff40a0, emissiveIntensity: 1.8 });
  }

  // MONORAIL: second-floor station, rideable train, and an outer return loop.
  const railY = 10;
  addBox(scene, world, 0, railY - 0.55, 0, 178, 0.32, 0.45, 0x171b28,
    { collide: false, shadow: false, emissive: 0x30e0ff, emissiveIntensity: 0.7 });
  addBox(scene, world, 0, railY - 0.18, 0, 178, 0.3, 1.15, 0x202638, { tex: 'panel', repeat: [22, 1] });
  addBox(scene, world, 0, railY - 0.95, -2.7, 178, 0.28, 0.35, 0x202638, { collide: false });
  addBox(scene, world, 0, railY - 0.95, 2.7, 178, 0.28, 0.35, 0x202638, { collide: false });
  addBox(scene, world, 104, railY - 0.95, 39, 0.35, 0.28, 78, 0x202638, { collide: false });
  addBox(scene, world, -104, railY - 0.95, 39, 0.35, 0.28, 78, 0x202638, { collide: false });
  addBox(scene, world, 0, railY - 0.95, 78, 208, 0.28, 0.35, 0x202638, { collide: false });
  addBox(scene, world, 104, railY - 0.18, 39, 1.15, 0.3, 78, 0x202638, { tex: 'panel', repeat: [1, 10] });
  addBox(scene, world, -104, railY - 0.18, 39, 1.15, 0.3, 78, 0x202638, { tex: 'panel', repeat: [1, 10] });
  addBox(scene, world, 0, railY - 0.18, 78, 208, 0.3, 1.15, 0x202638, { tex: 'panel', repeat: [26, 1] });
  addBox(scene, world, 0, railY - 0.3, 5.3, 30, 0.6, 5, 0x596478, { tex: 'arcade', repeat: [6, 1] });
  addBox(scene, world, 0, railY - 0.3, -5.3, 30, 0.6, 5, 0x596478, { tex: 'arcade', repeat: [6, 1] });
  addBox(scene, world, 0, railY + 1.4, 8.05, 28, 0.7, 0.3, 0xffd23c,
    { collide: false, shadow: false, emissive: 0xffd23c, emissiveIntensity: 1.5 });
  addBox(scene, world, 0, railY + 1.4, -8.05, 28, 0.7, 0.3, 0xffd23c,
    { collide: false, shadow: false, emissive: 0xffd23c, emissiveIntensity: 1.5 });
  addRamp(scene, world, { axis: 'z', minX: 9, maxX: 15, minZ: 8, maxZ: 30, h0: railY, h1: 0, color: 0x596478 });
  addRamp(scene, world, { axis: 'z', minX: -15, maxX: -9, minZ: -22, maxZ: -8, h0: 0, h1: railY, color: 0x596478 });
  addBox(scene, world, 38, railY - 0.35, 26, 46, 0.5, 3, 0x596478, { tex: 'panel', repeat: [8, 1] });
  addBox(scene, world, -37, railY - 0.35, -18, 44, 0.5, 3, 0x51607a, { tex: 'panel', repeat: [8, 1] });
  addRamp(scene, world, { axis: 'z', minX: -60, maxX: -56, minZ: -34, maxZ: -18, h0: 12, h1: railY, color: 0x51607a });
  for (const x of [-72, -48, -24, 24, 48, 72]) {
    addBox(scene, world, x, railY - 5.1, 0, 0.45, 9.8, 0.45, 0x242b3a, { tex: 'panel' });
  }
  addMonorailTrain(scene, world, [V(0, 0, 0), V(104, 0, 0), V(104, 0, 78), V(-104, 0, 78), V(-104, 0, 0)], railY, 27, 8);

  // Buildings [x, z, size, height, color] — roofs are the playground.
  // (The two −12 towers are hollow now — built below as interiors.)
  const buildings = [
    [32, -35, 26, 28, 0x1287a8], [62, -32, 18, 16, 0xb72c88],
    [-58, 33, 22, 24, 0x5d38bd],
    [32, 34, 22, 18, 0xd84979], [64, 30, 16, 10, 0x148f88],
    [-78, 24, 12, 16, 0x7636c8], [-78, -30, 12, 18, 0xcf376d],
    [-38, 58, 14, 14, 0x167f9f], [10, 58, 16, 12, 0xd55b38],
    [78, 48, 12, 22, 0x633cb8], [78, -50, 12, 18, 0xbc2d80],
    [-36, -60, 14, 10, 0x177f86], [12, -58, 12, 14, 0xcc4d58],
  ];
  for (const [bx, bz, s, h, c] of buildings) {
    addBox(scene, world, bx, h / 2, bz, s, h, s, c, { tex: 'neonwall', repeat: [Math.round(s / 4), Math.round(h / 4)] });
  }
  /* ---- WEST SKYSCRAPER: the west station skywalk used to dead-end into this
     tower. It now enters a hollow interior floor, ramps up, and exits onto the
     roof. Shell x −71..−45, z −48..−22, roof top y=12. ---- */
  const westTower = 0x51607a;
  const westIn = 0x5f6f90;
  addBox(scene, world, -58, 0.03, -35, 24.5, 0.06, 24.5, westIn, { tex: 'arcade', repeat: [5, 5] });
  addBox(scene, world, -58, 9.65, -35, 24.5, 0.7, 24.5, westIn, { tex: 'arcade', repeat: [5, 5] }); // skywalk interior floor
  addBox(scene, world, -58, 11.6, -42, 24.5, 0.8, 11, westTower, { tex: 'neonwall', repeat: [5, 2] }); // roof north slab
  addBox(scene, world, -64.5, 11.6, -28, 11.5, 0.8, 15, westTower, { tex: 'neonwall', repeat: [3, 3] }); // roof west/east strips leave hatch
  addBox(scene, world, -51.5, 11.6, -28, 11.5, 0.8, 15, westTower, { tex: 'neonwall', repeat: [3, 3] });
  addBox(scene, world, -68.75, 6, -35, 4.5, 12, 26, westTower, { tex: 'neonwall', repeat: [1, 4] }); // west wall
  addBox(scene, world, -47.25, 6, -35, 4.5, 12, 26, westTower, { tex: 'neonwall', repeat: [1, 4] }); // east wall
  addBox(scene, world, -58, 6, -47.25, 26, 12, 1.5, westTower, { tex: 'neonwall', repeat: [6, 3] }); // south wall
  // North face with a skywalk doorway centered at x -58, y 10.
  addBox(scene, world, -67, 6, -22.75, 8, 12, 1.5, westTower, { tex: 'neonwall' });
  addBox(scene, world, -49, 6, -22.75, 8, 12, 1.5, westTower, { tex: 'neonwall' });
  addBox(scene, world, -58, 4, -22.75, 10, 8, 1.5, westTower, { tex: 'neonwall' });
  addBox(scene, world, -58, 10.25, -20.35, 11, 0.45, 4.5, westIn, { tex: 'panel', repeat: [2, 1] }); // skywalk threshold
  addRamp(scene, world, { axis: 'z', minX: -62.5, maxX: -55.5, minZ: -41, maxZ: -29, h0: 10, h1: 12.3, color: westIn });
  addBox(scene, world, -55, 12.35, -23.8, 0.3, 0.9, 5.5, 0xffd23c);
  addBox(scene, world, -61, 12.35, -23.8, 0.3, 0.9, 5.5, 0xffd23c);
  const westTowerLight = new THREE.PointLight(0x30e0ff, 24, 20);
  westTowerLight.position.set(-58, 10.8, -35);
  scene.add(westTowerLight);
  // Extra ground-level pathway texture so the city reads less like open asphalt.
  for (const [x, z, w, d] of [
    [-78, 0, 8, 128], [78, 0, 8, 128], [-20, 58, 52, 6], [52, 58, 54, 6],
    [-20, -58, 52, 6], [52, -58, 54, 6], [-58, 0, 5, 54],
  ]) {
    addBox(scene, world, x, 0.035, z, w, 0.06, d, 0x6f7888, { collide: false, tex: 'checker', repeat: [Math.max(1, Math.round(w / 4)), Math.max(1, Math.round(d / 4))] });
  }

  /* ---- THE GALLERIA (tallest tower, hollow): ground hall → mezzanine (8)
     → gallery + bare catwalks over the void (16) → top chamber (24) → jump
     pad through the roof hatch (34). Shell x −26..2, z 22..50. ---- */
  const gal = 0x3f4e66, galIn = 0x55628a;
  const gw = { tex: 'neonwall' };
  // south wall: doors at x −20..−16 and −8..−4
  addBox(scene, world, -23, 16.6, 22.75, 6, 33.2, 1.5, gal, gw);
  addBox(scene, world, -12, 16.6, 22.75, 8, 33.2, 1.5, gal, gw);
  addBox(scene, world, -1, 16.6, 22.75, 6, 33.2, 1.5, gal, gw);
  addBox(scene, world, -18, 18.6, 22.75, 4, 29.2, 1.5, gal, gw);   // lintels
  addBox(scene, world, -6, 18.6, 22.75, 4, 29.2, 1.5, gal, gw);
  // north wall: door at x −14..−10
  addBox(scene, world, -20, 16.6, 49.25, 12, 33.2, 1.5, gal, gw);
  addBox(scene, world, -4, 16.6, 49.25, 12, 33.2, 1.5, gal, gw);
  addBox(scene, world, -12, 18.6, 49.25, 4, 29.2, 1.5, gal, gw);
  // west wall: door z 38..42, gallery-level window z 28..34 (jump-out ledge)
  addBox(scene, world, -25.25, 16.6, 25, 1.5, 33.2, 6, gal, gw);
  addBox(scene, world, -25.25, 8.25, 31, 1.5, 16.5, 6, gal, gw);   // below window
  addBox(scene, world, -25.25, 26.1, 31, 1.5, 14.2, 6, gal, gw);   // above window
  addBox(scene, world, -25.25, 16.6, 36, 1.5, 33.2, 4, gal, gw);
  addBox(scene, world, -25.25, 18.6, 40, 1.5, 29.2, 4, gal, gw);   // door lintel
  addBox(scene, world, -25.25, 16.6, 46, 1.5, 33.2, 8, gal, gw);
  // east wall: door z 30..34
  addBox(scene, world, 1.25, 16.6, 26, 1.5, 33.2, 8, gal, gw);
  addBox(scene, world, 1.25, 16.6, 42, 1.5, 33.2, 16, gal, gw);
  addBox(scene, world, 1.25, 18.6, 32, 1.5, 29.2, 4, gal, gw);
  // roof (top 34) with a hatch over the chamber at x −24..−20, z 34..38
  addBox(scene, world, -25, 33.6, 36, 2, 0.8, 28, gal, gw);
  addBox(scene, world, -9, 33.6, 36, 22, 0.8, 28, gal, gw);
  addBox(scene, world, -22, 33.6, 44, 4, 0.8, 12, gal, gw);
  addBox(scene, world, -22, 33.6, 28, 4, 0.8, 12, gal, gw);
  // interior: carpet floor (6cm above street — flush would z-fight)
  addBox(scene, world, -12, 0.03, 36, 24.9, 0.06, 24.9, 0x9088b0, { tex: 'arcade', repeat: [6, 6] });
  // ramps + decks: south ramp up, west mezzanine, north ramp up, east gallery
  addRamp(scene, world, { axis: 'x', minX: -18, maxX: -2, minZ: 23.5, maxZ: 27, h0: 8, h1: 0, color: galIn });
  addBox(scene, world, -21.25, 7.6, 36, 6.5, 0.8, 25, galIn, { tex: 'arcade', repeat: [2, 6] });
  // The upper flight ends flush against the gallery's west edge (x = −6),
  // sharing a boundary and height but never overlapping its top face.
  addRamp(scene, world, { axis: 'x', minX: -18, maxX: -6, minZ: 45, maxZ: 48.5, h0: 8, h1: 16, color: galIn });
  addBox(scene, world, -2.75, 15.6, 36, 6.5, 0.8, 25, galIn, { tex: 'arcade', repeat: [2, 6] });
  // bare catwalks across the void at 16 — the z=30 one ends at the window
  addBox(scene, world, -15.25, 15.6, 30, 18.5, 0.8, 2.5, 0x8a80a8, { tex: 'arcade', repeat: [5, 1] });
  addBox(scene, world, -15.25, 15.6, 42, 18.5, 0.8, 2.5, 0x8a80a8, { tex: 'arcade', repeat: [5, 1] });
  // third ramp stacked over the first: gallery (16) → chamber (24)
  addRamp(scene, world, { axis: 'x', minX: -18, maxX: -6, minZ: 23.5, maxZ: 27, h0: 24, h1: 16, color: galIn });
  // L-shaped top chamber at 24 (west strip + southwest wing) with rails
  addBox(scene, world, -21.25, 23.6, 36, 6.5, 0.8, 25, galIn, { tex: 'arcade', repeat: [2, 6] });
  addBox(scene, world, -14, 23.6, 29.5, 8, 0.8, 1, galIn, { tex: 'arcade', repeat: [2, 1] }); // leaves ramp crest open
  // Start the east rail a full metre beyond the upper ramp's z=27 crest.
  // Touching the ramp boundary was enough for the player capsule to catch on
  // the rail collider and forced an otherwise unnecessary jump.
  addBox(scene, world, -18.35, 24.45, 38.25, 0.3, 0.9, 20.5, 0xffd23c);
  addBox(scene, world, -10.35, 24.45, 26.75, 0.3, 0.9, 6.5, 0xffd23c);
  addBox(scene, world, -14, 24.45, 29.65, 8, 0.9, 0.3, 0xffd23c);
  // gallery + mezzanine edge rails (gaps where the ramps arrive)
  addBox(scene, world, -5.8, 16.45, 36, 0.3, 0.9, 18, 0xffd23c);
  addBox(scene, world, -18.35, 8.45, 36, 0.3, 0.9, 18, 0xffd23c);
  // pad through the roof hatch — slight east drift so you clear the hole
  // on the way down and land on the roof instead of falling back in
  addJumpPad(scene, world, -22, 24, 36, 24.5, 2.6, 0, 0xff70c8);
  const galLight = new THREE.PointLight(0xff70c8, 55, 42);
  galLight.position.set(-12, 20, 36);
  scene.add(galLight);
  const chamberLight = new THREE.PointLight(0x30e0ff, 25, 18);
  chamberLight.position.set(-21, 27, 36);
  scene.add(chamberLight);
  addBox(scene, world, -24.2, 12, 36, 0.4, 0.8, 20, 0xff40a0, { collide: false, shadow: false, emissive: 0xff40a0, emissiveIntensity: 1.4 });
  addBox(scene, world, 0.25, 12, 36, 0.4, 0.8, 20, 0x30e0ff, { collide: false, shadow: false, emissive: 0x30e0ff, emissiveIntensity: 1.4 });

  /* ---- THE ARCADE (A2, hollow): two ground rooms with a connecting door,
     a west stair to floor 2 (6.5), a street-facing sniper window, and the
     original roof (20) untouched above. Shell x −24..0, z −50..−26. ---- */
  const arc = 0x5a4a78;
  addBox(scene, world, -20, 9.4, -49.25, 8, 18.8, 1.5, arc, gw);   // south wall + door
  addBox(scene, world, -6, 9.4, -49.25, 12, 18.8, 1.5, arc, gw);
  addBox(scene, world, -14, 11.4, -49.25, 4, 14.8, 1.5, arc, gw);
  addBox(scene, world, -22, 9.4, -26.75, 4, 18.8, 1.5, arc, gw);   // north wall: 2 doors + window
  addBox(scene, world, -12, 3.75, -26.75, 8, 7.5, 1.5, arc, gw);   // below window x −16..−8
  addBox(scene, world, -12, 14.15, -26.75, 8, 9.3, 1.5, arc, gw);  // above window
  addBox(scene, world, -2, 9.4, -26.75, 4, 18.8, 1.5, arc, gw);
  addBox(scene, world, -18, 11.4, -26.75, 4, 14.8, 1.5, arc, gw);  // door lintels
  addBox(scene, world, -6, 11.4, -26.75, 4, 14.8, 1.5, arc, gw);
  addBox(scene, world, -23.25, 9.4, -38, 1.5, 18.8, 24, arc, gw);  // west wall (solid)
  addBox(scene, world, -0.75, 9.4, -47, 1.5, 18.8, 6, arc, gw);    // east wall + door z −44..−40
  addBox(scene, world, -0.75, 9.4, -33, 1.5, 18.8, 14, arc, gw);
  addBox(scene, world, -0.75, 11.4, -42, 1.5, 14.8, 4, arc, gw);
  addBox(scene, world, -12, 19.4, -38, 24, 1.2, 24, arc, gw);      // roof slab (top 20)
  addBox(scene, world, -12, 0.03, -38, 22.4, 0.06, 22.4, 0x8a80a8, { tex: 'arcade', repeat: [6, 6] });
  addBox(scene, world, -12, 3, -48, 1.5, 6, 4, arc, gw);           // ground partition + door
  addBox(scene, world, -12, 3, -40, 1.5, 6, 4, arc, gw);
  addRamp(scene, world, { axis: 'z', minX: -22.5, maxX: -19, minZ: -48.5, maxZ: -38, h0: 0, h1: 6.5, color: arc });
  addBox(scene, world, -12, 6.1, -32.75, 21, 0.8, 10.5, arc, { tex: 'arcade', repeat: [5, 3] }); // floor 2 (top 6.5)
  addBox(scene, world, -3.75, 6.1, -41, 4.5, 0.8, 6, arc, { tex: 'arcade', repeat: [1, 2] });    // east balcony strip
  addBox(scene, world, -12.5, 6.95, -38.2, 13, 0.9, 0.3, 0xffd23c); // deck rail (gaps at ramp + strip)
  const arcLight = new THREE.PointLight(0x8aff30, 35, 30);
  arcLight.position.set(-12, 9, -32);
  scene.add(arcLight);

  /* ---- BACK ALLEY: covered corridor along the south edge (three ways in:
     both open ends + a mid door), a tight flanking route. ---- */
  addBox(scene, world, -68, 2.3, -52, 16, 4.6, 1.2, 0x2a3040, gw);
  addBox(scene, world, -46, 2.3, -52, 20, 4.6, 1.2, 0x2a3040, gw); // gap x −60..−56 = door
  addBox(scene, world, -56, 2.3, -58, 40, 4.6, 1.2, 0x2a3040, gw);
  addBox(scene, world, -56, 4.9, -55, 42, 0.6, 7.2, 0x2a3040, gw); // roof (top 5.2)
  addBox(scene, world, -56, 4.1, -55, 30, 0.25, 0.25, 0xffd23c, { collide: false, shadow: false, emissive: 0xffd23c, emissiveIntensity: 1.6 });
  // Neon strips + rooftop clutter + beacon
  for (const [x, y, z, w, h, d, c] of [
    [-58, 8, -21.6, 18, 1, 0.3, 0xff40a0], [32, 20, -21.6, 20, 1, 0.3, 0x30e0ff],
    [-12, 26, 21.6, 20, 1, 0.3, 0x8aff30], [62, 10, -22.6, 12, 1, 0.3, 0xffd23c],
    [-58, 16, 44.2, 16, 1, 0.3, 0xb060ff], [64, 6, 21.6, 10, 1, 0.3, 0xff6a30],
  ]) {
    addBox(scene, world, x, y, z, w, h, d, c, { collide: false, shadow: false, emissive: c, emissiveIntensity: 1.6 });
  }
  addBox(scene, world, -20, 35.5, 30, 3, 3, 3, 0x2a3040, { tex: 'panel' });  // AC units
  addBox(scene, world, 38, 29.5, -40, 3, 3, 3, 0x2a3040, { tex: 'panel' });
  addBox(scene, world, -12, 37, 44, 1, 6, 1, 0x8892a8, { collide: false });
  addBox(scene, world, -12, 40.5, 44, 1.8, 0.6, 1.8, 0xff3050, { collide: false, shadow: false, emissive: 0xff3050, emissiveIntensity: 2 });
  // lava pit in the SE corner — mind the glow, and mind the edge
  addLava(scene, world, 56, -50, 8, 8, -0.85);
  // ground variety: galleria plaza, crosswalk bands
  addBox(scene, world, -12, 0.031, 14, 30, 0.06, 14, 0x9088b0, { tex: 'arcade', repeat: [6, 3] });
  // floating platforms over the street + pads
  // Recess the west edge from x = -6 to x = -3 so the nearby pad's launch
  // clears the underside. The east edge stays at x = 6 and the pickup remains
  // supported near the platform center.
  addBox(scene, world, 1.5, 11.7, -20, 9, 0.6, 8, 0x5a4a78, { tex: 'neonwall' });
  // Keep the pad clear of the monorail ramp edge at x = -9.
  addJumpPad(scene, world, -6, 0, -20, 28, 3.8, 0, 0x30e0ff);
  pk(world, 'shield', 0, 12.2, -20);
  wp(world, -6, 0, -20); wp(world, 0, 12, -20);
  world.manualLinks.push([-6, 0, -20, 0, 12, -20, true]);
  addBox(scene, world, -40, 9.7, 20, 10, 0.6, 8, 0x5a4a78, { tex: 'neonwall' });
  addJumpPad(scene, world, -49, 0, 20, 26, 5.5, 0, 0x30e0ff);
  pk(world, 'ammo', -40, 10.2, 20, { weapon: 'whomper' });
  wp(world, -49, 0, 20); wp(world, -40, 10, 20);
  world.manualLinks.push([-49, 0, 20, -40, 10, 20, true]);
  // billboards — it's a city, sell something
  addDecal(scene, 'poster5', -40, 14, -63.94, 14, 0);
  addScoreTarget(scene, world, 40, 14, -63.94, 12, 0);
  addDecal(scene, 'hazard', 0, 12, 63.94, 16, Math.PI);
  addDecal(scene, 'poster5', 84.94, 12, 20, 12, -Math.PI / 2);
  // The Galleria's south face is reserved for its large route label above.
  // Keep this poster on the west face so neither landmark obscures the other.
  addScoreTarget(scene, world, -25.96, 20, 44, 8, Math.PI / 2);
  addDecal(scene, 'hazard', -12, 15, -27.56, 9, Math.PI);

  // street clutter (cars/kiosks)
  addBox(scene, world, -48, 1.2, 2, 5, 2.4, 10, 0x7a3a4a, { tex: 'panel' });
  addBox(scene, world, 18, 1.2, -6, 5, 2.4, 10, 0x3a6a7a, { tex: 'panel' });
  addBox(scene, world, 48, 1.5, 8, 8, 3, 6, 0x6a6a3a, { tex: 'panel' });

  // Skybridges (sloped, link the rows): A1(12)↔B1(24) and A3(28)↔B3(18)
  addRamp(scene, world, { axis: 'z', minX: -60, maxX: -56, minZ: -22, maxZ: 22, h0: 12, h1: 24, color: 0x4c5a6a });
  addRamp(scene, world, { axis: 'z', minX: 30, maxX: 34, minZ: -22, maxZ: 23, h0: 28, h1: 18, color: 0x5c4f62 });

  // Fire escapes: street → B4 roof (two flights), street → A1 (wall ramp + landing)
  addRamp(scene, world, { axis: 'x', minX: 40, maxX: 56, minZ: 19, maxZ: 22, h0: 0, h1: 5, color: 0x596478 });
  addRamp(scene, world, { axis: 'x', minX: 56, maxX: 72, minZ: 19, maxZ: 22, h0: 5, h1: 10, color: 0x596478 });
  addRamp(scene, world, { axis: 'z', minX: -80, maxX: -74, minZ: -22, maxZ: 8, h0: 12, h1: 0, color: 0x51607a });
  addBox(scene, world, -73.5, 11.45, -26, 7, 1, 8, 0x51607a, { tex: 'panel' }); // landing → A1 roof

  // Roof-hop pads (one-way up the skyline)
  addJumpPad(scene, world, -48, 12, -36, 26, 15.8, -0.6, 0x30e0ff);  // A1 → A2
  addJumpPad(scene, world, -3, 20, -36, 26, 14.6, 0, 0x30e0ff);      // A2 → A3
  addJumpPad(scene, world, 55, 16, -33, 28, -7.8, 0.6, 0x30e0ff);    // A4 → A3
  addJumpPad(scene, world, -49, 24, 34, 28, 14.5, 0.6, 0x30e0ff);    // B1 → B2
  addJumpPad(scene, world, 23, 18, 33, 32, -12.2, 0.6, 0x30e0ff);    // B3 → B2
  addJumpPad(scene, world, 58, 10, 30, 22, -14.4, 0, 0x30e0ff);      // B4 → B3
  addJumpPad(scene, world, 62, 0, -14, 32, 0, -7.4, 0x30e0ff);       // street → A4 roof

  // Two deterministic vertical routes complement the riskier pads and long
  // ramps. Cab and collider are updated together by addCityElevator.
  addCityElevator(scene, world, {
    x: 5, z: 42, bottomY: 0.08, topY: 34, width: 6, depth: 5.5,
    accent: 0xff3ca6, phase: 0,
  });
  addCityElevator(scene, world, {
    x: 48, z: -35, bottomY: 0.08, topY: 28, width: 6, depth: 5.5,
    accent: 0x32e7ff, phase: 5.2,
  });

  // Spawns
  for (const dz of [-56, -20, 0, 8, 56]) world.spawns.blue.push(V(-76, 0.1, dz));
  for (const dz of [-38, -20, 0, 20, 56]) world.spawns.red.push(V(78, 0.1, dz));
  for (const [x, y, z] of [[-58, 12.2, -35], [32, 18.2, 34], [64, 10.2, 30], [0, 0.1, -56],
                           [0, 0.1, 56], [-40, 0.1, 0], [52, 0.1, 0], [-18, 20.2, -42],
                           [-21, 8.2, 32], [-64, 24.2, 39], [8, 10.2, 5.3], [24, 28.2, -43]]) {
    world.spawns.ffa.push(V(x, y, z));
  }

  // Pickups
  pk(world, 'shield', -12, 20.2, -32);                   // A2 rooftop
  pk(world, 'speed', -56, 0.2, -55);                     // back alley mid
  pk(world, 'djump', -20, 0.2, 10);                      // galleria plaza edge
  pk(world, 'gold', -12, 34.2, 36);                        // tallest roof
  pk(world, 'silver', 32, 28.2, -35);
  pk(world, 'weapon', -6, -5.8, 7, { weapon: 'whomper' }); // subway lava island
  pk(world, 'weapon', -58, 24.2, 33, { weapon: 'sidewinder' });
  pk(world, 'weapon', -12, 20.2, -38, { weapon: 'hyper' });
  pk(world, 'weapon', 40, 0.2, 0, { weapon: 'zooka' });
  pk(world, 'weapon', -40, 0.2, 10, { weapon: 'scatter' });
  pk(world, 'weapon', 32, 18.2, 30, { weapon: 'pulsar' });
  pk(world, 'weapon', -21, 8.2, 40, { weapon: 'parasite' });    // galleria mezzanine
  pk(world, 'ammo', 26, -5.8, -7, { weapon: 'whomper' });
  pk(world, 'ammo', -54, 24.2, 37, { weapon: 'sidewinder' });
  pk(world, 'ammo', -8, 20.2, -34, { weapon: 'hyper' });
  pk(world, 'ammo', -29, 0.2, 40, { weapon: 'parasite' }); // street outside the galleria
  pk(world, 'ammo', 44, 0.2, -6, { weapon: 'zooka' });
  pk(world, 'ammo', 60, 0.2, -8, { weapon: 'scatter' });
  pk(world, 'ammo', 36, 18.2, 38, { weapon: 'pulsar' });
  pk(world, 'health', -70, 0.2, 0);
  pk(world, 'health', 70, 0.2, 0);
  pk(world, 'health', -58, 12.2, -30);
  pk(world, 'health', 32, 18.2, 40);
  pk(world, 'health', 0, 0.2, 60);
  pk(world, 'star', 15, -5.8, -7, { hidden: true });       // subway tunnel
  pk(world, 'star', 70, 10.2, 24, { hidden: true });       // B4 roof corner
  pk(world, 'star', -58, 0.2, 4, { hidden: true });        // under the west skybridge
  pk(world, 'star', 32, 23.2, 0, { hidden: true });        // east skybridge mid
  pk(world, 'health', -12, 0.2, 36);                       // galleria ground hall
  pk(world, 'ammo', -21, 8.2, 44, { weapon: 'pulsar' });   // galleria mezzanine
  pk(world, 'ammo', -21, 24.2, 42, { weapon: 'whomper' }); // galleria top chamber
  pk(world, 'star', -22, 16.2, 30, { hidden: true });      // galleria window catwalk
  pk(world, 'health', -18, 0.2, -44);                      // arcade west room
  pk(world, 'ammo', -6, 6.7, -32, { weapon: 'scatter' });  // arcade floor 2
  pk(world, 'star', -21, 6.7, -29, { hidden: true });      // arcade floor-2 corner
  pk(world, 'ammo', -66, 0.2, -55, { weapon: 'sidewinder' }); // back alley
  pk(world, 'speed', 0, 10.2, 5.3);                        // monorail station
  pk(world, 'health', 0, 10.2, -5.3);                      // monorail station
  pk(world, 'ammo', 42, 10.2, 26, { weapon: 'pulsar' });   // east station skywalk
  pk(world, 'ammo', -37, 10.2, -18, { weapon: 'hyper' });  // west station skywalk
  pk(world, 'star', 90, 10.2, 0, { hidden: true });        // monorail tunnel lip

  // Waypoints: auto grid at street level, hand-placed above
  const blocked = (x, z) => {
    const p = V(x, 1, z);
    for (const c of world.colliders) {
      if (c.type !== 'box') continue;
      if (p.x > c.min.x - 1.2 && p.x < c.max.x + 1.2 && p.y > c.min.y && p.y < c.max.y &&
          p.z > c.min.z - 1.2 && p.z < c.max.z + 1.2) return true;
    }
    return false;
  };
  for (let gx = -78; gx <= 78; gx += 15.6) {
    for (let gz = -58; gz <= 58; gz += 14.5) {
      const x = Math.round(gx), z = Math.round(gz);
      if (!blocked(x, z)) wp(world, x, 0, z);
    }
  }
  const wps = [
    // roofs
    [-58, 12, -35], [-12, 20, -38], [32, 28, -35], [32, 28, -26], [62, 16, -32],
    [-58, 24, 33], [-12, 34, 36], [32, 18, 34], [32, 18, 26], [64, 10, 30],
    // skybridges (with mid points so the climb stays within link tolerance)
    [-58, 15, -11], [-58, 18, 0], [-58, 21, 11], [-58, 23.5, 19],
    [32, 25.5, -11], [32, 23, 0], [32, 20.5, 11],
    // west skyscraper interior: skywalk entrance → inside floor → roof exit
    [-58, 10, -21], [-58, 10, -34], [-58, 11, -38], [-58, 12.4, -29],
    // east fire escape: street → B4 roof
    [48, 2.5, 20.5], [56, 5, 20.5], [64, 7.5, 20.5], [71, 10, 20.5],
    // west wall ramp: street → A1 landing → roof
    [-76, 0, 6], [-77, 2, 3], [-77, 5.5, -8], [-77, 9, -17], [-77, 11.6, -21], [-73.5, 11.9, -26],
    // street pad up to A4
    [62, 0, -14],
    // subway: stair tops, ramps, tunnel run
    [-30, -1, -3.5], [-30, -3, -7], [-15, -6, -7], [5, -6, -7], [25, -6, -7],
    [32, -6, 5], [32, -4, 10], [32, -1, 3.7],
    // pads
    [-48, 12, -36], [-3, 20, -36], [55, 16, -33], [-49, 24, 34], [23, 18, 33], [58, 10, 30],
    // elevator landings (bots use explicit vertical links; players ride cabs)
    [5, 0, 42], [5, 34, 42], [48, 0, -35], [48, 28, -35],
    // galleria: doorways, hall, ramps, mezzanine, gallery, catwalks, chamber
    [-18, 0, 24], [-6, 0, 24], [-12, 0, 47], [-1, 0, 32], [-24, 0, 40],
    [-12, 0, 36], [-20, 0, 32],
    [-10, 4, 25.25], [-21, 8, 30], [-21, 8, 44],
    [-12, 12, 46.75], [-3, 16, 28], [-3, 16, 44],
    [-15, 16, 30], [-15, 16, 42],
    [-11, 19.3, 25.25], [-21, 24, 44], [-14, 24, 27], [-22, 24, 36],
    // arcade: doorways, rooms, stair, floor 2
    [-14, 0, -47], [-18, 0, -29], [-6, 0, -29], [-3, 0, -42],
    [-18, 0, -44], [-6, 0, -44], [-20.75, 3, -43],
    [-12, 6.5, -32], [-19, 6.5, -30], [-4, 6.5, -41],
    // back alley
    [-70, 0, -55], [-56, 0, -55], [-42, 0, -55], [-58, 0, -53], [-58, 0, -49],
    // monorail station, access ramps, and new skywalks
    [0, 10, 0], [0, 10, 5.3], [0, 10, -5.3], [10, 10, 5.3], [-10, 10, -5.3],
    [12, 2.5, 25], [12, 5.5, 19], [12, 8.4, 12], [12, 10, 7],
    [-12, 2.5, -19], [-12, 5.5, -15], [-12, 8.4, -11], [-12, 10, -7],
    [20, 10, 26], [38, 10, 26], [60, 10, 26],
    [-18, 10, -18], [-37, 10, -18], [-56, 11.2, -22], [-58, 12, -30],
    [88, 10, 0], [-88, 10, 0],
  ];
  for (const [x, y, z] of wps) wp(world, x, y, z);
  world.manualLinks.push(
    // interior ramp → upper deck transitions (deck slabs block the LOS ray)
    [-10, 4, 25.25, -21, 8, 30, false],
    [-12, 12, 46.75, -3, 16, 44, false],
    [-11, 19.3, 25.25, -14, 24, 27, false],
    [-20.75, 3, -43, -19, 6.5, -30, false],
    [-22, 24, 36, -12, 34, 36, true],     // chamber hatch pad → roof
    [-48, 12, -36, -12, 20, -38, true],   // pad hops
    [-3, 20, -36, 32, 28, -35, true],
    [55, 16, -33, 32, 28, -26, true],
    [-49, 24, 34, -12, 34, 36, true],
    [23, 18, 33, -12, 34, 36, true],
    [58, 10, 30, 32, 18, 26, true],
    [62, 0, -14, 62, 16, -32, true],      // street pad → A4 roof
    [-12, 34, 36, -58, 24, 33, true],     // step-off descents
    [32, 28, -35, -12, 20, -38, true],
    [-12, 20, -38, -12, 0, -56, true],
    [64, 10, 30, 64, 0, 57, true],
    [62, 16, -32, 62, 0, -14, true],
    [12, 0, 30, 12, 2.5, 25, false],       // station ramps
    [12, 8.4, 12, 12, 10, 7, false],
    [-12, 0, -22, -12, 2.5, -19, false],
    [-12, 8.4, -11, -12, 10, -7, false],
    [12, 10, 7, 0, 10, 5.3, false],
    [-12, 10, -7, 0, 10, -5.3, false],
    [0, 10, 5.3, 0, 10, 0, false],
    [0, 10, -5.3, 0, 10, 0, false],
    [-56, 11.2, -22, -58, 10, -21, false],
    [-58, 10, -34, -58, 12.4, -29, false],
    [-58, 12.4, -29, -58, 12, -35, false],
    [0, 10, 5.3, 20, 10, 26, false],
    [0, 10, -5.3, -18, 10, -18, false],
    [5, 0, 42, 5, 34, 42, true],
    [48, 0, -35, 48, 28, -35, true],
  );
  addCityPresentation(scene, world);
  mergeStatic(scene, world);
  return world;
}

/* ---------------- automatic doors ---------------- */
// Sliding pocket doors: closed until someone steps close, so you can't see
// or shoot through a doorway without committing to it. Colliders join the
// world on the first update tick — AFTER the waypoint graph is built — so
// bot paths still link through the openings.
function addDoor(scene, world, x, y, z, w, h, d, opts = {}) {
  const dmat = new THREE.MeshStandardMaterial({
    color: opts.bodyColor ?? opts.color ?? 0x8a80a8,
    roughness: 0.55,
    metalness: 0.35,
  });
  const ai = AI_TEX.door;
  if (ai) {
    dmat.map = ai.map.clone();
    dmat.map.needsUpdate = true;
    dmat.color = new THREE.Color(0xffffff);
  }
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), dmat);
  mesh.position.set(x, y + h / 2, z);
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);
  const collider = { type: 'box', dynamic: true, min: V(x - w / 2, y, z - d / 2), max: V(x + w / 2, y + h, z + d / 2) };
  (world.doors ||= []).push({
    mesh, collider, material: dmat, x, y, z, w, h, d,
    along: w >= d, off: 0, runePhase: opts.runePhase ?? null,
  });
  if (!world.updateDoors) {
    world._doorsArmed = false;
    world.updateDoors = (chars, dt) => {
      if (!world._doorsArmed) {
        for (const dr of world.doors) world.colliders.push(dr.collider);
        world._doorsArmed = true;
      }
      for (const dr of world.doors) {
        let open = false;
        for (const ch of chars) {
          if (!ch.alive) continue;
          const dx = ch.pos.x - dr.x, dz = ch.pos.z - dr.z;
          if (dx * dx + dz * dz < 46 && Math.abs(ch.pos.y - dr.y) < 4) { open = true; break; } // opens from ~6.8 out
        }
        const target = open ? (dr.along ? dr.w : dr.d) + 0.1 : 0;   // pocket fully into the wall
        const step = 9 * dt;
        dr.off += Math.max(-step, Math.min(step, target - dr.off));
        const ox = dr.along ? dr.off : 0, oz = dr.along ? 0 : dr.off;
        dr.mesh.position.set(dr.x + ox, dr.y + dr.h / 2, dr.z + oz);
        dr.collider.min.set(dr.x - dr.w / 2 + ox, dr.y, dr.z - dr.d / 2 + oz);
        dr.collider.max.set(dr.x + dr.w / 2 + ox, dr.y + dr.h, dr.z + dr.d / 2 + oz);
      }
    };
  }
}

/* ---------------- lava pools ---------------- */
// A rimmed basin of glowing lava. Standing in it burns ~34 hp/s (handled in
// main.js via world.lavaZones) — about three seconds to scramble out.
function addLava(scene, world, x, z, w, d, floorY = -1.1) {
  // A waist-deep molten basin sunk into the floor: fall in, burn, and you
  // have to JUMP to get back out. floorY = the basin bottom you stand on.
  addBox(scene, world, x, floorY - 0.5, z, w, 1, d, 0x3a2018, { tex: 'rock' });
  const lmat = new THREE.MeshStandardMaterial({
    color: 0xff8040, roughness: 0.35, emissive: 0xff5a10, emissiveIntensity: 1.1 });
  const ai = AI_TEX.lava;
  if (ai) {
    lmat.map = ai.map.clone();
    lmat.map.needsUpdate = true;
    lmat.map.repeat.set(Math.max(1, Math.round(w / 10)), Math.max(1, Math.round(d / 10)));
    lmat.emissiveMap = lmat.map;
    lmat.color = new THREE.Color(0xffffff);
    lmat.emissive = new THREE.Color(0xcc7040); // the liquid texture is bright — keep bloom in check
  }
  const surfY = floorY + 0.85;
  const lava = new THREE.Mesh(new THREE.PlaneGeometry(w, d), lmat);
  lava.rotation.x = -Math.PI / 2;
  lava.position.set(x, surfY, z);
  scene.add(lava);
  world.anim.push((dt, t) => {
    lmat.emissiveIntensity = 0.55 + Math.sin(t * 2.6 + x) * 0.18;
    if (lmat.map) { lmat.map.offset.x = t * 0.014; lmat.map.offset.y = t * 0.009; } // slow molten drift
  });
  // splurting blobs — little magma spits popping off the surface
  for (let i = 0; i < 3; i++) {
    const blob = new THREE.Mesh(new THREE.SphereGeometry(0.14 + Math.random() * 0.12, 6, 5),
      new THREE.MeshBasicMaterial({ color: 0xffa030 }));
    scene.add(blob);
    const px = x + (Math.random() - 0.5) * (w - 1.2);
    const pz = z + (Math.random() - 0.5) * (d - 1.2);
    const phase = Math.random() * 4, period = 1.4 + Math.random() * 1.3;
    world.anim.push((dt, t) => {
      const k = ((t + phase) % period) / period;
      blob.visible = k < 0.4;                         // brief spit, then gone
      const kk = k / 0.4;
      blob.position.set(px, surfY + 4 * kk * (1 - kk) * 1.5, pz);
    });
  }
  const L = new THREE.PointLight(0xff5a20, 32, 20);
  L.position.set(x, floorY + 2.5, z);
  scene.add(L);
  (world.lavaZones ||= []).push({
    minX: x - w / 2 + 0.2, maxX: x + w / 2 - 0.2,
    minZ: z - d / 2 + 0.2, maxZ: z + d / 2 - 0.2, maxY: floorY + 1.0,
  });
}

// A jagged lava lake whose damaging area follows the rendered polygon. This is
// intentionally separate from the compact rectangular arena pits above: broad
// natural caverns look artificial when every shoreline is ruler-straight.
function addScragglyLava(scene, world, x, z, w, d, floorY, seed, {
  pointLight = true,
  qualityControlled = false,
} = {}) {
  const rnd = seededRandom(seed);
  const outline = [
    [-0.50, -0.34], [-0.37, -0.49], [-0.13, -0.43], [0.10, -0.50], [0.34, -0.43],
    [0.50, -0.31], [0.43, -0.10], [0.50, 0.10], [0.39, 0.30], [0.48, 0.49],
    [0.22, 0.43], [-0.02, 0.50], [-0.27, 0.41], [-0.50, 0.48], [-0.42, 0.20],
    [-0.50, -0.03], [-0.41, -0.23],
  ].map(([px, pz]) => [
    x + (px + (rnd() - 0.5) * 0.055) * w,
    z + (pz + (rnd() - 0.5) * 0.055) * d,
  ]);

  const shape = new THREE.Shape();
  outline.forEach(([px, pz], i) => {
    if (i === 0) shape.moveTo(px, -pz);
    else shape.lineTo(px, -pz);
  });
  shape.closePath();

  const lmat = new THREE.MeshStandardMaterial({
    color: 0xff8040, roughness: 0.35, emissive: 0xff5a10, emissiveIntensity: 0.9,
    side: THREE.DoubleSide,
  });
  const ai = AI_TEX.lava;
  if (ai) {
    lmat.map = ai.map.clone();
    lmat.map.needsUpdate = true;
    lmat.map.repeat.set(Math.max(1, Math.round(w / 10)), Math.max(1, Math.round(d / 10)));
    lmat.emissiveMap = lmat.map;
    lmat.color = new THREE.Color(0xffffff);
    lmat.emissive = new THREE.Color(0xcc7040);
  }
  const surfY = floorY + 0.85;
  const lava = new THREE.Mesh(new THREE.ShapeGeometry(shape), lmat);
  lava.rotation.x = -Math.PI / 2;
  lava.position.y = surfY;
  lava.receiveShadow = true;
  scene.add(lava);
  world.anim.push((dt, t) => {
    lmat.emissiveIntensity = 0.52 + Math.sin(t * 2.2 + seed) * 0.15;
    if (lmat.map) { lmat.map.offset.x = t * 0.012; lmat.map.offset.y = t * 0.008; }
  });

  const zone = { points: outline, maxY: floorY + 1.0 };
  (world.lavaZones ||= []).push(zone);
  for (let i = 0; i < 2; i++) {
    let px = x, pz = z;
    for (let tries = 0; tries < 12; tries++) {
      px = x + (rnd() - 0.5) * w * 0.8;
      pz = z + (rnd() - 0.5) * d * 0.8;
      if (pointInZoneXZ(zone, px, pz)) break;
    }
    const blob = new THREE.Mesh(new THREE.SphereGeometry(0.14 + rnd() * 0.12, 6, 5),
      new THREE.MeshBasicMaterial({ color: 0xffa030 }));
    scene.add(blob);
    if (qualityControlled) (world._olympusLavaBlobs ||= []).push({ blob, index: i });
    const phase = rnd() * 4, period = 1.4 + rnd() * 1.3;
    world.anim.push((dt, t) => {
      const tier = world._olympusVisualTier || 'high';
      const detailVisible = !qualityControlled || tier === 'high' || (tier === 'standard' && i === 0);
      if (!detailVisible) {
        blob.visible = false;
        return;
      }
      const k = ((t + phase) % period) / period;
      blob.visible = k < 0.4;
      const kk = k / 0.4;
      blob.position.set(px, surfY + 6 * kk * (1 - kk), pz);
    });
  }
  if (pointLight) {
    const glow = new THREE.PointLight(0xff5a20, 24, Math.max(18, Math.min(w, d)));
    glow.position.set(x, floorY + 2.5, z);
    scene.add(glow);
  }
}

// Continuous square-ring moat for Olympus's outer basin. The outside follows
// the map boundary while the inner shoreline meanders naturally; the central
// hole remains safe ground both visually and in hazard queries.
function addOlympusLavaMoat(scene, world, outerR = 170, innerR = 151, floorY = -0.72, {
  pointLights = true,
} = {}) {
  const rnd = seededRandom(0x4d4f4154);
  const outer = [
    [-outerR, -outerR], [outerR, -outerR],
    [outerR, outerR], [-outerR, outerR],
  ];
  const inner = [];
  const steps = 9;
  const wobble = () => (rnd() - 0.5) * 8;
  for (let i = 0; i < steps; i++) inner.push([-innerR + i * innerR * 2 / steps, -innerR + wobble()]);
  for (let i = 0; i < steps; i++) inner.push([innerR + wobble(), -innerR + i * innerR * 2 / steps]);
  for (let i = 0; i < steps; i++) inner.push([innerR - i * innerR * 2 / steps, innerR + wobble()]);
  for (let i = 0; i < steps; i++) inner.push([-innerR + wobble(), innerR - i * innerR * 2 / steps]);

  const shape = new THREE.Shape();
  outer.forEach(([px, pz], i) => i === 0 ? shape.moveTo(px, -pz) : shape.lineTo(px, -pz));
  shape.closePath();
  const hole = new THREE.Path();
  [...inner].reverse().forEach(([px, pz], i) => i === 0 ? hole.moveTo(px, -pz) : hole.lineTo(px, -pz));
  hole.closePath();
  shape.holes.push(hole);

  const lmat = new THREE.MeshStandardMaterial({
    color: 0xff8040, roughness: 0.32, emissive: 0xff5410, emissiveIntensity: 0.82,
    side: THREE.DoubleSide,
  });
  const ai = AI_TEX.lava;
  if (ai) {
    lmat.map = ai.map.clone();
    lmat.map.needsUpdate = true;
    // This is a map-scale surface, so keep the lava cells broad enough to read
    // as flows instead of a dense, shimmering fabric pattern.
    lmat.map.repeat.set(10, 10);
    lmat.emissiveMap = lmat.map;
    lmat.color = new THREE.Color(0xffffff);
    lmat.emissive = new THREE.Color(0xc86432);
  }
  const surfY = floorY + 0.85;
  const moat = new THREE.Mesh(new THREE.ShapeGeometry(shape), lmat);
  moat.rotation.x = -Math.PI / 2;
  moat.position.y = surfY;
  moat.receiveShadow = true;
  scene.add(moat);
  world.anim.push((dt, t) => {
    lmat.emissiveIntensity = 0.48 + Math.sin(t * 1.65) * 0.12;
    if (lmat.map) { lmat.map.offset.x = t * 0.009; lmat.map.offset.y = t * 0.006; }
  });
  // The north river is a true water-only outlet. Exclude the whole channel
  // from lava damage even though its transparent surface crosses the moat.
  const riverCut = [
    [-7.5, -outerR - 1], [7.5, -outerR - 1],
    [7.5, -innerR + 10], [-7.5, -innerR + 10],
  ];
  (world.lavaZones ||= []).push({ points: outer, holes: [inner, riverCut], maxY: floorY + 1.0 });

  if (pointLights) {
    for (const [x, z] of [[-158, -90], [158, 82], [-86, 158], [94, -158]]) {
      const glow = new THREE.PointLight(0xff4a18, 18, 34);
      glow.position.set(x, 2.2, z);
      scene.add(glow);
    }
  }
}

/* ============== SECRET MAP — THE RUNE ENGINE (hidden gate in the lobby) ==============
   An obsidian labyrinth built around a suspended arcane machine. Four visually
   distinct rune wings surround a vertical crypt-to-gallery combat spine; the
   engine pulses through the wings and pre-opens two rune gates at a time. */
function buildSanctum(scene) {
  const world = newWorld({ killY: -25, waypointLinkDist: 20, waypointLinkDy: 4.6 });
  scene.background = new THREE.Color(0x0a0714);
  scene.fog = new THREE.Fog(0x0a0714, 70, 220);
  // This is a sealed cavern: lava, runes, portals, and the engine are the
  // only light sources. Global fill would make the enclosing rock read like
  // an outdoor arena instead of letting those local glows reveal the maze.
  const STONE = 0x3e3358, FLOOR = 0x2c2440, DARK = 0x14101f;
  // Deliberately identical. Color-coded wings turned the labyrinth into a
  // compass; matching runes make every threshold feel plausibly familiar.
  const RUNE_COLORS = [0x9a78d8, 0x9a78d8, 0x9a78d8, 0x9a78d8];
  // Continue ramp support just beneath each destination deck so the player
  // capsule cannot catch on the deck's vertical edge at a flush crest.
  const LANDING_SUPPORT = 1.2;
  const runeLights = [];

  function addRuneBeacon(x, z, color, height = 4.2) {
    addBox(scene, world, x, 0.65, z, 1.5, 1.3, 1.5, DARK, { tex: 'rock' });
    addBox(scene, world, x, height * 0.5 + 0.7, z, 0.42, height, 0.42, color,
      { collide: false, shadow: false, emissive: color, emissiveIntensity: 1.55 });
    addBox(scene, world, x, height + 0.9, z, 1.15, 0.18, 1.15, color,
      { collide: false, shadow: false, emissive: color, emissiveIntensity: 2.0 });
    const light = new THREE.PointLight(color, 8, 13);
    light.position.set(x, height * 0.7 + 1, z);
    scene.add(light);
    runeLights.push(light);
  }

  // shell + floor (two stair holes over the crypt at x ±(30..40), z −2..2)
  for (const [x, z, w, d] of [[0, -50.5, 104, 3], [0, 50.5, 104, 3], [-50.5, 0, 3, 104], [50.5, 0, 3, 104]]) {
    addBox(scene, world, x, 6, z, w, 12, d, STONE, { tex: 'rock', repeat: [12, 2] });
  }
  addDecal(scene, 'poster6', -18, 6, -48.94, 8, 0);
  addDecal(scene, 'poster6', 18, 6, 48.94, 8, Math.PI);
  // (each half is split around a 9x9 lava-pit hole in its court)
  addBox(scene, world, -41.25, -0.5, 26, 17.5, 1, 48, FLOOR, { tex: 'panel', repeat: [2, 6] });
  addBox(scene, world, 13.25, -0.5, 26, 73.5, 1, 48, FLOOR, { tex: 'panel', repeat: [9, 6] });
  addBox(scene, world, -28, -0.5, 41.25, 9, 1, 17.5, FLOOR, { tex: 'panel', repeat: [1, 2] });
  addBox(scene, world, -28, -0.5, 12.75, 9, 1, 21.5, FLOOR, { tex: 'panel', repeat: [1, 3] });
  addBox(scene, world, 41.25, -0.5, -26, 17.5, 1, 48, FLOOR, { tex: 'panel', repeat: [2, 6] });
  addBox(scene, world, -13.25, -0.5, -26, 73.5, 1, 48, FLOOR, { tex: 'panel', repeat: [9, 6] });
  addBox(scene, world, 28, -0.5, -41.25, 9, 1, 17.5, FLOOR, { tex: 'panel', repeat: [1, 2] });
  addBox(scene, world, 28, -0.5, -12.75, 9, 1, 21.5, FLOOR, { tex: 'panel', repeat: [1, 3] });
  addBox(scene, world, -45, -0.5, 0, 10, 1, 4, FLOOR, { tex: 'panel' });
  // Split the central cross-floor around a 6×4 aperture into the crypt.
  addBox(scene, world, -16.5, -0.5, 0, 27, 1, 4, FLOOR, { tex: 'panel', repeat: [4, 1] });
  addBox(scene, world, 16.5, -0.5, 0, 27, 1, 4, FLOOR, { tex: 'panel', repeat: [4, 1] });
  addBox(scene, world, 45, -0.5, 0, 10, 1, 4, FLOOR, { tex: 'panel' });

  // CRYPT (x −40..40, z −6..6, floor −6) + stair ramps down from the E/W rooms
  addBox(scene, world, -33, -6.5, 0, 14, 1, 12, DARK, { tex: 'panel', repeat: [2, 2] });
  addBox(scene, world, 12, -6.5, 0, 56, 1, 12, DARK, { tex: 'panel', repeat: [7, 2] });
  addBox(scene, world, 0, -3.5, 6.35, 80.7, 5.1, 0.7, STONE, { tex: 'rock' });
  addBox(scene, world, 0, -3.5, -6.35, 80.7, 5.1, 0.7, STONE, { tex: 'rock' });
  addBox(scene, world, 40.35, -3.5, 0, 0.7, 5.1, 13.4, STONE, { tex: 'rock' });
  addBox(scene, world, -40.35, -3.5, 0, 0.7, 5.1, 13.4, STONE, { tex: 'rock' });
  // feet face the crypt CENTER — pointed outward, the slab undersides pinch
  // you against the floor before you can reach the climbable end (a gold trap)
  addRamp(scene, world, { axis: 'x', minX: 30, maxX: 40, minZ: -2, maxZ: 2,
    h0: -6, h1: 0, color: STONE, supportPad1: LANDING_SUPPORT });
  addRamp(scene, world, { axis: 'x', minX: -40, maxX: -30, minZ: -2, maxZ: 2,
    h0: 0, h1: -6, color: STONE, supportPad0: LANDING_SUPPORT });
  addBox(scene, world, 0, -1.6, 5.9, 60, 0.3, 0.2, 0x30ffc8, { collide: false, shadow: false, emissive: 0x30ffc8, emissiveIntensity: 1.4 });
  addBox(scene, world, 0, -1.6, -5.9, 60, 0.3, 0.2, 0x30ffc8, { collide: false, shadow: false, emissive: 0x30ffc8, emissiveIntensity: 1.4 });
  const cryptLight = new THREE.PointLight(0x30ffc8, 14, 24);
  cryptLight.position.set(0, -3, 0);
  scene.add(cryptLight);

  // CENTER CHAMBER (36×36) + suspended Rune Engine over the crypt aperture.
  for (const s of [1, -1]) {
    addBox(scene, world, -10, 3, 18 * s, 16, 6, 1.2, STONE, { tex: 'rock' });
    addBox(scene, world, 10, 3, 18 * s, 16, 6, 1.2, STONE, { tex: 'rock' });
    addBox(scene, world, 18 * s, 3, -10, 1.2, 6, 16, STONE, { tex: 'rock' });
    addBox(scene, world, 18 * s, 3, 10, 1.2, 6, 16, STONE, { tex: 'rock' });
    addBox(scene, world, 0, 4.8, 18.8 * s, 24, 0.35, 0.25, 0x8a5fff, { collide: false, shadow: false });
    addBox(scene, world, 18.8 * s, 4.8, 0, 0.25, 0.35, 24, 0x8a5fff, { collide: false, shadow: false });
  }
  // Broken ring dais leaves the lift shaft readable from every entrance.
  addBox(scene, world, 0, 0.3, 3.75, 10, 0.6, 2.5, DARK, { tex: 'panel' });
  addBox(scene, world, 0, 0.3, -3.75, 10, 0.6, 2.5, DARK, { tex: 'panel' });
  addBox(scene, world, 3.75, 0.3, 0, 2.5, 0.6, 5, DARK, { tex: 'panel' });
  addBox(scene, world, -3.75, 0.3, 0, 2.5, 0.6, 5, DARK, { tex: 'panel' });

  const engine = new THREE.Group();
  const coreMat = new THREE.MeshStandardMaterial({
    color: 0x30234d, roughness: 0.28, metalness: 0.48,
    emissive: 0x8a5fff, emissiveIntensity: 1.8,
  });
  const engineCore = new THREE.Mesh(new THREE.OctahedronGeometry(1.45, 1), coreMat);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xc9b4ff, transparent: true, opacity: 0.76,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const ringA = new THREE.Mesh(new THREE.TorusGeometry(2.7, 0.09, 7, 40), ringMat);
  const ringB = new THREE.Mesh(new THREE.TorusGeometry(2.1, 0.07, 7, 36), ringMat.clone());
  ringA.rotation.x = Math.PI / 2;
  ringB.rotation.y = Math.PI / 2;
  engine.add(engineCore, ringA, ringB);
  engine.position.set(0, 7.2, 0);
  scene.add(engine);
  const motePositions = new Float32Array(90 * 3);
  for (let i = 0; i < 90; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 3.5 + Math.random() * 12;
    motePositions[i * 3] = Math.cos(a) * r;
    motePositions[i * 3 + 1] = 1 + Math.random() * 10;
    motePositions[i * 3 + 2] = Math.sin(a) * r;
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute('position', new THREE.BufferAttribute(motePositions, 3));
  const motes = new THREE.Points(moteGeo, new THREE.PointsMaterial({
    color: 0xbda5ff, size: 0.08, transparent: true, opacity: 0.5,
    depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  scene.add(motes);
  for (const [x, z] of [[-2.2, -2.2], [2.2, -2.2], [-2.2, 2.2], [2.2, 2.2]]) {
    addBox(scene, world, x, 9.2, z, 0.16, 6.2, 0.16, 0x8a789e,
      { collide: false, shadow: false, metalness: 0.75, roughness: 0.34 });
  }
  const obLight = new THREE.PointLight(0x8a5fff, 18, 20);
  obLight.position.set(0, 7.2, 0);
  scene.add(obLight);

  // Upper gallery: a readable combat loop above the ground-floor cross.
  // Hard seam rule: straight runs end exactly where a dedicated corner tile
  // begins. No coplanar overlap, no gap, and one consistent top height.
  addBox(scene, world, 0, 5.2, 14, 24.8, 0.5, 3.2, STONE, { tex: 'rock', repeat: [6, 1] });
  addBox(scene, world, 0, 5.2, -14, 24.8, 0.5, 3.2, STONE, { tex: 'rock', repeat: [6, 1] });
  addBox(scene, world, 14, 5.2, 0, 3.2, 0.5, 24.8, STONE, { tex: 'rock', repeat: [1, 6] });
  addBox(scene, world, -14, 5.2, 0, 3.2, 0.5, 24.8, STONE, { tex: 'rock', repeat: [1, 6] });
  for (const [x, z] of [[14, 14], [-14, 14], [14, -14], [-14, -14]]) {
    addBox(scene, world, x, 5.2, z, 3.2, 0.5, 3.2, STONE, { tex: 'rock' });
  }
  // Rail runs butt against their corner posts instead of intersecting them.
  for (const [x, z, w, d] of [[0, 12.1, 23.96, .14], [0, -12.1, 23.96, .14], [12.1, 0, .14, 23.96], [-12.1, 0, .14, 23.96]]) {
    addBox(scene, world, x, 6.15, z, w, 1.35, d, 0x8a5fff,
      { shadow: false });
  }
  for (const [x, z] of [[12.1, 12.1], [-12.1, 12.1], [12.1, -12.1], [-12.1, -12.1]]) {
    addBox(scene, world, x, 6.2, z, 0.24, 1.55, 0.24, 0xc9b4ff,
      { shadow: false });
  }
  addRamp(scene, world, { axis: 'z', minX: -2, maxX: 2, minZ: 15.5, maxZ: 26.5,
    h0: 5.45, h1: 6.5, color: STONE, supportPad1: LANDING_SUPPORT });
  addRamp(scene, world, { axis: 'z', minX: -2, maxX: 2, minZ: -26.5, maxZ: -15.5,
    h0: 6.5, h1: 5.45, color: STONE, supportPad0: LANDING_SUPPORT });

  // A one-way arc lift makes the crypt a fast re-entry route instead of a dead end.
  addJumpPad(scene, world, 0, -6, 0, 24, 5.5, 0, 0x8a5fff);

  world.runeEngine = true;
  world.runePhase = 0;
  const runeColorObjects = RUNE_COLORS.map(c => new THREE.Color(c));
  world.anim.push((dt, t) => {
    const clock = t + (world.runeTimeOffset || 0);
    const phase = Math.floor(clock / 12) % 4;
    if (phase !== world.runePhase) {
      world.runePhase = phase;
    }
    const pulse = 0.5 + 0.5 * Math.sin(clock * 2.6);
    engine.position.y = 7.2 + Math.sin(clock * 1.05) * 0.22;
    engine.rotation.y = clock * 0.34;
    ringA.rotation.z = clock * 0.72;
    ringB.rotation.x = clock * -0.56;
    motes.rotation.y = clock * 0.055;
    motes.material.opacity = 0.34 + pulse * 0.28;
    coreMat.emissive.copy(runeColorObjects[phase]);
    coreMat.emissiveIntensity = 1.45 + pulse * 1.05;
    ringMat.color.copy(runeColorObjects[phase]);
    ringB.material.color.copy(runeColorObjects[(phase + 1) % 4]);
    obLight.color.copy(runeColorObjects[phase]);
    obLight.intensity = 14 + pulse * 10;
    runeLights.forEach((light, i) => {
      light.intensity = i === phase ? 12 + pulse * 5 : 4;
    });
  });

  // corridors to the four rooms (h4 — tight) with walkable roof slabs
  for (const s of [1, -1]) {
    addBox(scene, world, 2.6, 2, 22.3 * s, 1.2, 4, 7.4, STONE, { tex: 'rock' });
    addBox(scene, world, -2.6, 2, 22.3 * s, 1.2, 4, 7.4, STONE, { tex: 'rock' });
    addBox(scene, world, 0, 4.3, 22.3 * s, 6.4, 0.6, 7.4, STONE, { tex: 'rock' });
    addBox(scene, world, 22.3 * s, 2, 2.6, 7.4, 4, 1.2, STONE, { tex: 'rock' });
    addBox(scene, world, 22.3 * s, 2, -2.6, 7.4, 4, 1.2, STONE, { tex: 'rock' });
    addBox(scene, world, 22.3 * s, 4.3, 0, 7.4, 0.6, 6.4, STONE, { tex: 'rock' });
  }

  // E/W ROOMS (x ±(26..44), z −9..9) — the crypt stairs open in their floors
  for (const s of [1, -1]) {
    addBox(scene, world, 26.6 * s, 3, 5.5, 1.2, 6, 7, STONE, { tex: 'rock' });
    addBox(scene, world, 26.6 * s, 3, -5.5, 1.2, 6, 7, STONE, { tex: 'rock' });
    addBox(scene, world, 43.4 * s, 3, 5.5, 1.2, 6, 7, STONE, { tex: 'rock' });
    addBox(scene, world, 43.4 * s, 3, -5.5, 1.2, 6, 7, STONE, { tex: 'rock' });
    addBox(scene, world, 35 * s, 3, 9.4, 18, 6, 1.2, STONE, { tex: 'rock' });
    addBox(scene, world, 35 * s, 3, -9.4, 18, 6, 1.2, STONE, { tex: 'rock' });
  }
  // W room balcony (top 5) + its ramp along the south wall
  addBox(scene, world, -39.4, 4.7, 1.5, 8, 0.6, 14.6, STONE, { tex: 'rock' });
  addRamp(scene, world, { axis: 'x', minX: -43, maxX: -33, minZ: -8.8, maxZ: -5.8,
    h0: 5, h1: 0, color: STONE, supportPad0: LANDING_SUPPORT });
  // Mirrored E room balcony and ramp feed the southeast roof loop.
  addBox(scene, world, 39.4, 4.7, -1.5, 8, 0.6, 14.6, STONE, { tex: 'rock' });
  addRamp(scene, world, { axis: 'x', minX: 33, maxX: 43, minZ: 5.8, maxZ: 8.8,
    h0: 0, h1: 5, color: STONE, supportPad1: LANDING_SUPPORT });

  // N/S ROOMS (z ±(26..44), x −14..14) with walkable roofs (pads in the ring)
  for (const s of [1, -1]) {
    addBox(scene, world, -8, 3, 26.6 * s, 12, 6, 1.2, STONE, { tex: 'rock' });
    addBox(scene, world, 8, 3, 26.6 * s, 12, 6, 1.2, STONE, { tex: 'rock' });
    addBox(scene, world, 0, 3, 43.4 * s, 28, 6, 1.2, STONE, { tex: 'rock' });
    addBox(scene, world, -13.4, 3, 35 * s, 1.2, 6, 18, STONE, { tex: 'rock' });
    addBox(scene, world, 13.4, 3, 30.5 * s, 1.2, 6, 9, STONE, { tex: 'rock' });   // ring door z ±(35..40)
    addBox(scene, world, 13.4, 3, 42 * s, 1.2, 6, 4, STONE, { tex: 'rock' });
    addBox(scene, world, 0, 6.2, 35 * s, 28.6, 0.6, 18.6, STONE, { tex: 'rock' }); // roof (top 6.5)
  }
  addJumpPad(scene, world, 20, 0, 40, 20, -7, 0, 0x8a5fff);
  addJumpPad(scene, world, -20, 0, -40, 20, 7, 0, 0x8a5fff);

  /* ---- FOUR FALSELY FAMILIAR WINGS ----
     Combat geometry remains different beneath the surface, but every room
     repeats the same rotated shrine. The repetition is useful cover and an
     intentionally unreliable landmark: seeing it never tells you north. */
  // Local +Z points away from the central chamber in every wing. Keeping
  // that convention matters: reversed E/W rotations put the rear shrine
  // column directly behind the entrance doors.
  const wingCenters = [[0, 35, 0], [35, 0, Math.PI / 2], [0, -35, Math.PI], [-35, 0, -Math.PI / 2]];
  const rotateWing = (cx, cz, yaw, lx, lz) => ({
    x: cx + Math.cos(yaw) * lx + Math.sin(yaw) * lz,
    z: cz - Math.sin(yaw) * lx + Math.cos(yaw) * lz,
  });
  for (let wing = 0; wing < wingCenters.length; wing++) {
    const [cx, cz, yaw] = wingCenters[wing];
    for (const lx of [-8.5, 8.5]) {
      const beacon = rotateWing(cx, cz, yaw, lx, -1.5);
      addRuneBeacon(beacon.x, beacon.z, RUNE_COLORS[wing], 4.5);
    }
    // Every wing has a door at both ends, so its local centerline must remain
    // clear. Earlier versions moved the axial pillar from one doorway into
    // the other; the repeated shrine now uses only flanking pillars.
    for (const [lx, lz, h] of [[-4.4, 5.2, 2.8], [4.4, 5.2, 2.8]]) {
      const p = rotateWing(cx, cz, yaw, lx, lz);
      addBox(scene, world, p.x, h / 2, p.z, 2.2, h, 2.2, STONE, { tex: 'rock' });
      addBox(scene, world, p.x, h + 0.14, p.z, 2.45, 0.16, 2.45, RUNE_COLORS[wing], {
        collide: false, shadow: false,
      });
    }
    for (const lx of [-3.7, 3.7]) {
      const p = rotateWing(cx, cz, yaw, lx, -6.2);
      addBox(scene, world, p.x, 0.65, p.z, 3.2, 1.3, 1.7, STONE, { tex: 'rock' });
    }
  }

  // NW elevated shortcut uses the same butt-jointed construction: two runs
  // and one unique 4m corner tile, all sharing a 5.5m top surface.
  addBox(scene, world, -39, 5.25, 16, 4, 0.5, 24, STONE, { tex: 'rock', repeat: [1, 6] });
  addBox(scene, world, -27, 5.25, 30, 20, 0.5, 4, STONE, { tex: 'rock', repeat: [5, 1] });
  addBox(scene, world, -39, 5.25, 30, 4, 0.5, 4, STONE, { tex: 'rock' });
  addRamp(scene, world, { axis: 'x', minX: -18, maxX: -13, minZ: 28, maxZ: 32,
    h0: 5.5, h1: 6.5, color: STONE, supportPad1: LANDING_SUPPORT });
  // Rail endpoints meet two corner posts exactly; no rail volumes overlap.
  for (const [x, z] of [[-40.9, 31.9], [-37.1, 28.1]]) {
    addBox(scene, world, x, 6.2, z, .24, 1.55, .24, RUNE_COLORS[3],
      { shadow: false });
  }
  for (const [x, z, w, d] of [
    [-40.9, 17.89, .12, 27.78],
    [-37.1, 15.99, .12, 23.98],
    [-26.99, 28.1, 19.98, .12],
    [-28.89, 31.9, 23.78, .12],
  ]) {
    addBox(scene, world, x, 6.15, z, w, 1.35, d, RUNE_COLORS[3],
      { shadow: false });
  }

  // Exact rotational counterpart to the NW elevated shortcut: east balcony
  // → southeast ambulatory → Storm Cloister roof. Matching silhouette and
  // rail rhythm stop the upper route from revealing which half of the maze
  // the player is in.
  addBox(scene, world, 39, 5.25, -16, 4, 0.5, 24, STONE, { tex: 'rock', repeat: [1, 6] });
  addBox(scene, world, 27, 5.25, -30, 20, 0.5, 4, STONE, { tex: 'rock', repeat: [5, 1] });
  addBox(scene, world, 39, 5.25, -30, 4, 0.5, 4, STONE, { tex: 'rock' });
  addRamp(scene, world, { axis: 'x', minX: 13, maxX: 18, minZ: -32, maxZ: -28,
    h0: 6.5, h1: 5.5, color: STONE, supportPad0: LANDING_SUPPORT });
  for (const [x, z] of [[40.9, -31.9], [37.1, -28.1]]) {
    addBox(scene, world, x, 6.2, z, .24, 1.55, .24, RUNE_COLORS[0],
      { shadow: false });
  }
  for (const [x, z, w, d] of [
    [40.9, -17.89, .12, 27.78],
    [37.1, -15.99, .12, 23.98],
    [26.99, -28.1, 19.98, .12],
    [28.89, -31.9, 23.78, .12],
  ]) {
    addBox(scene, world, x, 6.15, z, w, 1.35, d, RUNE_COLORS[0],
      { shadow: false });
  }

  // NE and SW used to be empty courts. Matching false-terminal shrines give
  // them close-range cover and a diagonal portal route. The two ends are
  // deliberately indistinguishable, reinforcing the map's unreliable sense
  // of direction.
  const portalColor = RUNE_COLORS[0];
  const portalCooldown = new WeakMap();
  const cornerPortals = [
    { x: 28, z: 48.45, yaw: Math.PI, triggerZ: 46.0, outX: -28, outZ: -44.5 },
    { x: -28, z: -48.45, yaw: 0, triggerZ: -46.0, outX: 28, outZ: 44.5 },
  ];
  for (const portal of cornerPortals) {
    const wallSide = Math.sign(portal.z);
    addMagicPortal(scene, world, portal.x, 3.1, portal.z, 7.2, 5.8, portalColor, portal.yaw);
    for (const sx of [-1, 1]) {
      addBox(scene, world, portal.x + sx * 4.05, 3.1, portal.z - wallSide * 0.08,
        0.7, 6.2, 0.7, STONE, { tex: 'rock' });
    }
    addBox(scene, world, portal.x, 6.05, portal.z - wallSide * 0.08,
      7.4, 0.7, 0.7, STONE, { tex: 'rock' });
    // Repeated obelisks and staggered waist cover make each destination safe
    // enough to arrive in, without sealing its exits into the ambulatory.
    for (const sx of [-1, 1]) {
      addBox(scene, world, portal.x + sx * 5.8, 2.1, portal.z - wallSide * 7.2,
        1.8, 4.2, 1.8, STONE, { tex: 'rock' });
      addBox(scene, world, portal.x + sx * 5.8, 4.32, portal.z - wallSide * 7.2,
        2.05, 0.18, 2.05, portalColor,
        { collide: false, shadow: false });
    }
    addBox(scene, world, portal.x, 0.75, portal.z - wallSide * 9.6,
      6.8, 1.5, 2.0, STONE, { tex: 'rock' });
  }
  world.anim.push((dt, t, characters) => {
    for (const ch of characters) {
      if (!ch.alive || (portalCooldown.get(ch) || 0) > t || ch.pos.y > 6.5) continue;
      for (const portal of cornerPortals) {
        if (Math.abs(ch.pos.x - portal.x) > 3.3 || Math.abs(ch.pos.z - portal.triggerZ) > 1.45) continue;
        ch.pos.x = portal.outX;
        ch.pos.z = portal.outZ;
        ch.pos.y = 0.1;
        if (ch.vel) ch.vel.set(0, 0, 0);
        portalCooldown.set(ch, t + 1.25);
        world.onPortalTransit?.(ch, { x: portal.x, y: 3.1, z: portal.triggerZ });
        break;
      }
    }
  });

  // SE collapsed ambulatory: irregular cover breaks the old four-way symmetry.
  addBox(scene, world, 40, 0.85, -40, 6.5, 1.7, 3.2, 0x302943, { tex: 'rock', flatShading: true });
  addBox(scene, world, 44, 1.35, -35, 3.4, 2.7, 4.2, 0x29223b, { tex: 'rock', flatShading: true });
  addBox(scene, world, 36.5, 0.55, -34, 4.6, 1.1, 2.8, 0x403653, { tex: 'rock', flatShading: true });

  // cavern ceiling: no open sky — discs ricochet back down (no shadow cast,
  // or the sun would flat-black the whole temple; faint glow sells the rock)
  addBox(scene, world, 0, 12.45, 0, 104, 0.9, 104, 0x241c38,
    { tex: 'rock', repeat: [12, 12], emissive: 0x2a1a4a, emissiveIntensity: 0.35, shadow: false });

  // Matching rune gates occupy every constructed doorway. They remain dark
  // architectural surfaces while opening strictly from proximity, preserving
  // occlusion and stopping long-range shots through unattended openings.
  addDoor(scene, world, 0, 0, 26.6, 4.2, 5.9, 1.4, { color: RUNE_COLORS[0], runePhase: 0 });
  addDoor(scene, world, 26.6, 0, 0, 1.4, 5.9, 4.2, { color: RUNE_COLORS[1], runePhase: 1 });
  addDoor(scene, world, 0, 0, -26.6, 4.2, 5.9, 1.4, { color: RUNE_COLORS[2], runePhase: 2 });
  addDoor(scene, world, -26.6, 0, 0, 1.4, 5.9, 4.2, { color: RUNE_COLORS[3], runePhase: 3 });
  // The central chamber previously had four bare corridor mouths. Matching
  // doors make every transition obey the same visual grammar and prevent an
  // open arch from becoming an accidental compass marker.
  addDoor(scene, world, 0, 0, 18, 4.2, 5.9, 1.4, { color: RUNE_COLORS[0] });
  addDoor(scene, world, 18, 0, 0, 1.4, 5.9, 4.2, { color: RUNE_COLORS[0] });
  addDoor(scene, world, 0, 0, -18, 4.2, 5.9, 1.4, { color: RUNE_COLORS[0] });
  addDoor(scene, world, -18, 0, 0, 1.4, 5.9, 4.2, { color: RUNE_COLORS[0] });
  // Outer-ring exits use the same door treatment in every wing that has an
  // opening. E/W used to be bare while N/S had doors.
  addDoor(scene, world, 43.4, 0, 0, 1.4, 5.9, 4.2, { color: RUNE_COLORS[0] });
  addDoor(scene, world, -43.4, 0, 0, 1.4, 5.9, 4.2, { color: RUNE_COLORS[0] });
  addDoor(scene, world, 13.4, 0, 37.5, 1.4, 5.9, 5.2, { color: RUNE_COLORS[0] });
  addDoor(scene, world, 13.4, 0, -37.5, 1.4, 5.9, 5.2, { color: RUNE_COLORS[0] });

  // lava pools in the NW and SE courts — the temple demands sacrifice
  addLava(scene, world, -28, 28, 9, 9, -1.1);
  addLava(scene, world, 28, -28, 9, 9, -1.1);
  // and a molten stretch of the crypt, crossed by a narrow plank
  addLava(scene, world, -21, 0, 10, 11.3, -7.1);
  addBox(scene, world, -21, -5.65, 0, 10.5, 0.7, 3, 0x1a1428, { tex: 'rock', repeat: [3, 1] });
  addRamp(scene, world, { axis: 'x', minX: -28.2, maxX: -26.2, minZ: -1.5, maxZ: 1.5,
    h0: -6, h1: -5.3, color: 0x1a1428, supportPad1: LANDING_SUPPORT });
  addRamp(scene, world, { axis: 'x', minX: -15.8, maxX: -13.8, minZ: -1.5, maxZ: 1.5,
    h0: -5.3, h1: -6, color: 0x1a1428, supportPad0: LANDING_SUPPORT });

  // ambulatory braziers
  for (const [x, z] of [[47, 47], [-47, 47], [47, -47], [-47, -47]]) {
    addBox(scene, world, x, 0.6, z, 1.2, 1.2, 1.2, DARK, { tex: 'rock' });
    addBox(scene, world, x, 1.45, z, 0.7, 0.5, 0.7, 0xff9c40, { collide: false, shadow: false, emissive: 0xff9c40, emissiveIntensity: 1.6 });
    const L = new THREE.PointLight(0xff9c40, 18, 22);
    L.position.set(x, 2.5, z);
    scene.add(L);
  }

  // Spawns
  for (const dz of [-44, -20, 20, 44]) world.spawns.blue.push(V(-47, 0.1, dz));
  for (const dz of [-44, -20, 20, 44]) world.spawns.red.push(V(47, 0.1, dz));
  for (const [x, z] of [[44, 44], [-44, 44], [44, -44], [-44, -44], [0, 30], [0, -35],
                        [35, 14], [-35, 6], [16, 22], [-16, 22], [22, -22], [-16, -22]]) {
    world.spawns.ffa.push(V(x, 0.1, z));
  }

  // Pickups
  pk(world, 'gold', -8, -5.8, 0);                         // crypt heart, clear of the arc lift
  pk(world, 'silver', 0, 0.8, -3.2);                      // dais
  pk(world, 'shield', 0, 0.8, 3.2);
  pk(world, 'speed', 0, 0.2, -32);                        // S room
  pk(world, 'djump', 0, 0.2, 47);                         // north ambulatory
  pk(world, 'weapon', 0, 6.7, 35, { weapon: 'whomper' }); // N roof
  pk(world, 'weapon', -39, 5.2, 2, { weapon: 'hyper' });  // W balcony
  pk(world, 'weapon', 26, -5.8, 0, { weapon: 'zooka' });  // crypt
  pk(world, 'weapon', 35, 0.2, 4.8, { weapon: 'scatter' });
  pk(world, 'weapon', 0, 0.2, -37, { weapon: 'pulsar' });
  pk(world, 'weapon', 22, 0.2, 22, { weapon: 'sidewinder' });
  pk(world, 'weapon', -22, 0.2, 22, { weapon: 'parasite' });
  pk(world, 'ammo', 4, 6.7, 35, { weapon: 'whomper' });
  pk(world, 'ammo', -39, 5.2, -1, { weapon: 'hyper' });
  pk(world, 'ammo', 20, -5.8, 0, { weapon: 'zooka' });
  pk(world, 'ammo', -28, 0.2, 22, { weapon: 'parasite' });
  pk(world, 'ammo', 35, 0.2, -4.8, { weapon: 'scatter' });
  pk(world, 'ammo', -5, 0.2, -35, { weapon: 'pulsar' });
  pk(world, 'ammo', -22, 0.2, -22, { weapon: 'sidewinder' });
  pk(world, 'health', 14, 0.2, 14);
  pk(world, 'health', -14, 0.2, -14);
  pk(world, 'health', 47, 0.2, 0);
  pk(world, 'health', -47, 0.2, 24);
  pk(world, 'star', -26, -5.0, 0, { hidden: true });      // atop the crypt bridge
  pk(world, 'star', 41, 0.2, -47, { hidden: true });      // broken SE ambulatory
  pk(world, 'star', 0, 6.7, -35, { hidden: true });       // S roof
  pk(world, 'star', -12, 0.2, 42, { hidden: true });      // N room corner

  // Waypoints
  const wps = [
    // chamber + dais ring
    [0, 0, 12], [0, 0, -12], [12, 0, 0], [-12, 0, 0],
    [13, 0, 13], [-13, 0, 13], [13, 0, -13], [-13, 0, -13],
    // corridors
    [0, 0, 22], [0, 0, -22], [22, 0, 0], [-22, 0, 0],
    // E/W rooms (skirting the stair holes) + hole ramps + crypt line
    [29, 0, 0], [40, 0, 6], [35, 0, -6], [42, 0, 0],
    [-30, 0, 6], [-40, 0, 6], [-35, 0, -6], [-42, 0, 0],
    [35, -2.85, 0], [-35, -2.85, 0],
    [28, -6, 0], [14, -6, 0], [0, -6, 0], [-14, -6, 0], [-28, -6, 0],
    // N/S rooms + their ring doors
    [0, 0, 30], [-10, 0, 36], [8, 0, 40], [16, 0, 37.5],
    [0, 0, -30], [-9.5, 0, -40], [8, 0, -40], [16, 0, -37.5],
    // W balcony ramp + deck
    [-38, 2.6, -7.3], [-39, 5, 2],
    // mirrored E balcony ramp + deck
    [38, 2.6, 7.3], [39, 5, -2],
    // Rune Engine upper gallery + north/south roof connectors
    [0, 5.45, 14], [14, 5.45, 0], [0, 5.45, -14], [-14, 5.45, 0],
    [14, 5.45, 14], [-14, 5.45, 14], [14, 5.45, -14], [-14, 5.45, -14],
    [0, 5.8, 20], [0, 6.5, 28], [0, 5.8, -20], [0, 6.5, -28],
    // NW balcony shortcut to the Astral Archive roof
    [-39, 5.5, 12], [-39, 5.5, 24], [-39, 5.5, 30], [-27, 5.5, 30], [-14, 6.5, 30],
    // SE balcony shortcut to the Storm Cloister roof
    [39, 5.5, -12], [39, 5.5, -24], [39, 5.5, -30], [27, 5.5, -30], [14, 6.5, -30],
    // ambulatory ring (≤16 apart so it chains) + diagonal courts
    [47, 0, 0], [47, 0, 16], [47, 0, -16], [47, 0, 32], [47, 0, -32],
    [-47, 0, 0], [-47, 0, 16], [-47, 0, -16], [-47, 0, 32], [-47, 0, -32],
    [0, 0, 47], [16, 0, 47], [-16, 0, 47], [32, 0, 47], [-32, 0, 47],
    [0, 0, -47], [16, 0, -47], [-16, 0, -47], [32, 0, -47], [-32, 0, -47],
    [46, 0, 46], [-46, 0, 46], [46, 0, -46], [-46, 0, -46],
    [22, 0, 22], [-22, 0, 22], [22, 0, -22], [-22, 0, -22],
    [30, 0, 16], [-30, 0, 16], [30, 0, -16], [-30, 0, -16],
    [16, 0, 30], [-16, 0, 30], [16, 0, -30], [-16, 0, -30],
    // paired diagonal portal thresholds
    [28, 0, 46], [-28, 0, -46],
    // roofs + pads
    [0, 6.5, 35], [0, 6.5, -35], [20, 0, 40], [-20, 0, -40],
  ];
  for (const [x, y, z] of wps) wp(world, x, y, z);
  world.manualLinks.push(
    [-38, 2.6, -7.3, -39, 5, 2, false],   // balcony ramp → deck (deck edge blocks LOS)
    [38, 2.6, 7.3, 39, 5, -2, false],      // mirrored east balcony ramp → deck
    [0, -6, 0, 14, 5.45, 0, true],        // crypt arc lift → east gallery
    [0, 5.45, 14, 0, 6.5, 28, false],     // north gallery ramp → archive roof
    [0, 5.45, -14, 0, 6.5, -28, false],   // south gallery ramp → cloister roof
    [-39, 5, 2, -39, 5.5, 12, false],     // west balcony → high ambulatory
    [-27, 5.5, 30, -14, 6.5, 30, false],  // high ambulatory → archive roof
    [39, 5, -2, 39, 5.5, -12, false],      // east balcony → high ambulatory
    [27, 5.5, -30, 14, 6.5, -30, false],  // mirrored high ambulatory → south roof
    [20, 0, 40, 0, 6.5, 35, true],        // pads → roofs
    [-20, 0, -40, 0, 6.5, -35, true],
    [28, 0, 46, -28, 0, -46, false],      // diagonal court portal pair
  );
  mergeStatic(scene, world);
  return world;
}

/* ============== SECRET MAP — PRISM RUN (inside-out tesseract) ==============
   You play INSIDE a small neon cube packed with pillars and cross-walls.
   Gravity always pulls toward the NEAREST surface (a shell face OR any
   interior structure) so you fall onto something no matter what — you can't
   drop into the void. Walk into any wall or column and you run straight up
   it. The camera is a plain free-look FPS camera that NEVER rolls — your feet
   stick to walls and ceilings but aiming feels identical everywhere. Very
   low gravity for a floaty deep-space feel. Bots keep their feet on the
   floor and weave the doorways — the walls and ceiling are yours. */
function buildPrism(scene) {
  const H = 24, CY = 24;   // 25% smaller cube; floor y=0, ceiling y=48
  const world = newWorld({
    escher: true, cube: { cx: 0, cy: CY, cz: 0, h: H },
    gravity: 8, jumpVel: 7, playerSpeed: 11,        // very floaty — deep-space feel
    killY: -160, killYTop: 240, killCenter: V(0, CY, 0), killRadius: 240,
    waypointLinkDist: 16, waypointLinkDy: 3,
    availableWeapons: ['blaster', 'scatter', 'pulsar', 'sidewinder', 'zooka', 'hyper', 'parasite', 'whomper', 'refractor'],
  });
  scene.background = new THREE.Color(0x05030f);
  baseLighting(scene, 0xc8a8ff, 0x1a0f2e, [40, 90, -30], 110);

  // starfield dome + drifting nebula veils
  const sc = document.createElement('canvas');
  sc.width = sc.height = 512;
  const sg = sc.getContext('2d');
  sg.fillStyle = '#0b0518'; sg.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 340; i++) {
    sg.fillStyle = `rgba(255,255,255,${0.2 + Math.random() * 0.7})`;
    const s = Math.random() < 0.1 ? 2 : 1;
    sg.fillRect(Math.random() * 512, Math.random() * 512, s, s);
  }
  const st = new THREE.CanvasTexture(sc);
  st.colorSpace = THREE.SRGBColorSpace;
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(400, 24, 12),
    new THREE.MeshBasicMaterial({ map: st, side: THREE.BackSide, fog: false })));
  const nebC = document.createElement('canvas');
  nebC.width = nebC.height = 128;
  const ng = nebC.getContext('2d');
  const grad = ng.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, 'rgba(255,255,255,.9)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ng.fillStyle = grad; ng.fillRect(0, 0, 128, 128);
  const nebT = new THREE.CanvasTexture(nebC);
  for (const [x, y, z, s, c] of [[-140, 60, -180, 220, 0xb040ff], [180, -40, 120, 260, 0x30e0ff],
                                 [60, 120, 200, 200, 0xff40a0], [-200, -80, 60, 180, 0x6dff6d]]) {
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map: nebT, color: c, transparent: true, opacity: 0.22, depthWrite: false }));
    spr.position.set(x, y, z);
    spr.scale.setScalar(s);
    scene.add(spr);
  }

  const bar = (x, y, z, w, h, d, glow) =>
    addBox(scene, world, x, y, z, w, h, d, glow, { collide: false, shadow: false, emissive: glow, emissiveIntensity: 0.9 });

  /* ---- THE CUBE: you play INSIDE it. All six inner faces are walkable and
     gravity always pulls toward the nearest one, so you fall onto a surface
     no matter what — you can't drop into the void. Faces are translucent
     neon grid (stars glow through); the 12 edges are bright bars. ---- */
  const faces = [
    [0, -1.5, 0, 52, 3, 52, 'neonfloor'],   // floor  (top y=0)
    [0, 49.5, 0, 52, 3, 52, 'neonfloor'],   // ceiling(bottom y=48)
    [-25.5, CY, 0, 3, 52, 52, 'neonwall'],  // -X wall (inner x=-24)
    [25.5, CY, 0, 3, 52, 52, 'neonwall'],   // +X wall (inner x=24)
    [0, CY, -25.5, 52, 52, 3, 'neonwall'],  // -Z wall
    [0, CY, 25.5, 52, 52, 3, 'neonwall'],   // +Z wall
  ];
  for (const [x, y, z, w, h, d, tex] of faces) {
    world.colliders.push({ type: 'box', shell: true, min: V(x - w / 2, y - h / 2, z - d / 2), max: V(x + w / 2, y + h / 2, z + d / 2) });
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ ...aiTex(tex, 7, 7), color: 0x3a3470,
        transparent: true, opacity: 0.72, side: THREE.DoubleSide, roughness: 0.55,
        emissive: 0x1a1440, emissiveIntensity: 0.5 }));
    m.position.set(x, y, z);
    scene.add(m);
  }
  addDecal(scene, 'poster7', 0, CY + 10, -23.94, 9, 0);
  addDecal(scene, 'poster7', 23.94, CY + 10, 0, 9, -Math.PI / 2);
  // 12 neon edge bars (the tesseract wireframe)
  const EC = [0xff3050, 0x40ff60, 0x30e0ff, 0xffe030, 0xff40e0, 0xb060ff];
  let ei = 0;
  for (const sx of [-1, 1]) for (const sz of [-1, 1])            // 4 verticals
    bar(sx * 23.7, CY, sz * 23.7, 0.6, 48, 0.6, EC[ei++ % 6]);
  for (const y of [0.4, 47.6]) for (const s of [-1, 1]) {        // 8 horizontals
    bar(0, y, s * 23.7, 48, 0.6, 0.6, EC[ei++ % 6]);
    bar(s * 23.7, y, 0, 0.6, 0.6, 48, EC[ei++ % 6]);
  }
  for (const [x, y, z, c] of [[0, 24, 0, 0xff70c8], [0, 8, 0, 0x30e0ff],
                              [-18, 36, -18, 0xffe030], [18, 12, 18, 0x60ff80]]) {
    const L = new THREE.PointLight(c, 15, 50); L.position.set(x, y, z); scene.add(L);
  }

  /* ---- interior: a 3D LATTICE with beams along all three axes, so structure
     runs every direction (not just floor↔ceiling). Everything is climbable —
     walk into any beam and you run up it; gravity pulls you to the nearest
     surface so you can hop between beams and never fall out. ---- */
  const IC = 0x2a2352, iw = { tex: 'neonwall' };
  const BEAM_WIDTH = 3.75;  // 25% wider than the original 3-unit lattice
  const beamDims = (w, h, d) => {
    if (w >= h && w >= d) return [w, BEAM_WIDTH, BEAM_WIDTH];
    if (h >= d) return [BEAM_WIDTH, h, BEAM_WIDTH];
    return [BEAM_WIDTH, BEAM_WIDTH, d];
  };
  const beamVisualDims = (w, h, d) => {
    const shrink = 0.08;
    if (w >= h && w >= d) return [Math.max(0.1, w - shrink), 3.575, 3.425];
    if (h >= d) return [3.85, Math.max(0.1, h - shrink), 3.65];
    return [3.7, 3.925, Math.max(0.1, d - shrink)];
  };
  const beam = (x, y, z, w, h, d) => {
    [w, h, d] = beamDims(w, h, d);
    world.colliders.push({
      type: 'box',
      wrapEdges: true,
      min: V(x - w / 2, y - h / 2, z - d / 2),
      max: V(x + w / 2, y + h / 2, z + d / 2),
    });
    const [vw, vh, vd] = beamVisualDims(w, h, d);
    addBox(scene, world, x, y, z, vw, vh, vd, IC, { ...iw, collide: false });
  };
  // central 3D cross: one beam per axis, meeting in the middle → run from any
  // face, through the centre, out to any other face
  beam(0, CY, 0, 48, 3, 3);   // X: -X wall ↔ +X wall
  beam(0, CY, 0, 3, 3, 48);   // Z: -Z wall ↔ +Z wall
  beam(0, CY, 0, 3, 48, 3);   // Y: floor ↔ ceiling
  // four corner pillars tied by a mid-height ring (lots of extra X/Z routes)
  for (const [sx, sz] of [[-1, -1], [1, 1], [-1, 1], [1, -1]]) beam(sx * 17, CY, sz * 17, 3, 48, 3);
  beam(0, CY, 17, 34, 3, 3); beam(0, CY, -17, 34, 3, 3);
  beam(17, CY, 0, 3, 3, 34); beam(-17, CY, 0, 3, 3, 34);
  // a second, smaller ring higher/lower for more mid-air routes (kept clear of
  // the shell walls so wall-climbs stay smooth)
  beam(0, 12, 9, 18, 3, 3); beam(0, 36, -9, 18, 3, 3);
  beam(9, 12, 0, 3, 3, 18); beam(-9, 36, 0, 3, 3, 18);
  const crate = (x, y, z, s = 3) => addBox(scene, world, x, y, z, s, s, s, 0xb0763a, { tex: 'crate' });
  crate(-20, 1.5, -8); crate(20, 1.5, 8); crate(8, 1.5, 20); crate(-8, 1.5, -20);

  // SPAWNS anywhere — a grid across ALL SIX faces (every "wall" is just a floor
  // at another angle), skipping any point that would land inside a beam. Both
  // the player and the bots use the whole set.
  const clearAt = (x, y, z) => {
    for (const c of world.colliders) {
      if (c.type !== 'box' || c.shell) continue;   // near the shell is fine — that's the floor
      if (x > c.min.x - 0.7 && x < c.max.x + 0.7 && y > c.min.y - 0.7 && y < c.max.y + 0.7 &&
          z > c.min.z - 0.7 && z < c.max.z + 0.7) return false;
    }
    return true;
  };
  const spawns = [];
  const push = (x, y, z) => { if (clearAt(x, y, z)) spawns.push(V(x, y, z)); };
  const AX = [-18, -9, 0, 9, 18];
  for (const a of AX) for (const b of AX) {
    push(a, 0.3, b); push(a, 47.7, b);                          // floor + ceiling
    push(23.4, CY + a, b); push(-23.4, CY + a, b);              // ±X walls
    push(b, CY + a, 23.4); push(b, CY + a, -23.4);              // ±Z walls
  }
  world.spawns.ffa = spawns;
  world.playerSpawns = spawns;
  world.spawns.blue = spawns.filter(p => p.x < -0.5);
  world.spawns.red = spawns.filter(p => p.x > 0.5);

  // Pickups over every surface + the lattice — reward exploring all of it
  pk(world, 'gold', 6, 46.6, 6);                          // ceiling
  pk(world, 'silver', 0, CY + BEAM_WIDTH / 2, 0);         // centre of the lattice
  pk(world, 'shield', 23.4, CY, 5);                       // +X wall
  pk(world, 'speed', 5, CY, -23.4);                       // -Z wall
  pk(world, 'djump', -23.4, CY, -5);                      // -X wall
  pk(world, 'star', -6, 46.6, -6, { hidden: true });      // ceiling
  pk(world, 'star', -23.4, 35, 5, { hidden: true });      // high on the -X wall
  pk(world, 'star', 17, 40, 17, { hidden: true });        // high on a corner pillar
  pk(world, 'star', 0, 12 + BEAM_WIDTH / 2, 9, { hidden: true }); // lower inner ring
  pk(world, 'weapon', 0, 0.2, 20, { weapon: 'zooka' });   // floor
  pk(world, 'weapon', 23.4, 12, 0, { weapon: 'scatter' }); // low on +X wall
  pk(world, 'weapon', 0, CY + BEAM_WIDTH / 2, 12, { weapon: 'pulsar' }); // main ring
  pk(world, 'weapon', -6, 46.6, 12, { weapon: 'hyper' });  // ceiling
  pk(world, 'weapon', 23.4, 32, -5, { weapon: 'sidewinder' });
  pk(world, 'weapon', -9, 36 + BEAM_WIDTH / 2, 0, { weapon: 'whomper' }); // upper inner ring
  pk(world, 'weapon', -23.4, 20, 0, { weapon: 'parasite' });   // mid on -X wall
  pk(world, 'weapon', 0, 37.5, -23.4, { weapon: 'refractor' }); // secret-map beam gun
  pk(world, 'ammo', 0, 0.2, -20, { weapon: 'zooka' });
  pk(world, 'ammo', 17, CY + BEAM_WIDTH / 2, 0, { weapon: 'scatter' });
  pk(world, 'ammo', 0, CY + BEAM_WIDTH / 2, -12, { weapon: 'pulsar' });
  pk(world, 'ammo', 6, 46.6, 12, { weapon: 'hyper' });
  pk(world, 'ammo', 23.4, 27, -5, { weapon: 'sidewinder' });
  pk(world, 'ammo', -23.4, 26, 0, { weapon: 'parasite' });
  pk(world, 'ammo', 4, 14, 23.4, { weapon: 'refractor' });
  pk(world, 'health', -20, 0.2, 8);
  pk(world, 'health', 20, 0.2, -8);
  pk(world, 'health', 0, 47.7, 12);                       // ceiling

  // Waypoints on ALL SIX faces (bots roam every surface, not just the floor).
  // Escher bots seek these directly; a,b range over a grid within each face.
  world.faceWps = [];
  const GRID = [[-16, -16], [0, -16], [16, -16], [-16, 0], [0, 0], [16, 0], [-16, 16], [0, 16], [16, 16]];
  const face = (fn) => { for (const [a, b] of GRID) world.faceWps.push(fn(a, b)); };
  face((a, b) => V(a, 0.3, b));          // floor
  face((a, b) => V(a, 47.7, b));         // ceiling
  face((a, b) => V(23.7, 24 + a, b));    // +X wall
  face((a, b) => V(-23.7, 24 + a, b));   // -X wall
  face((a, b) => V(b, 24 + a, 23.7));    // +Z wall
  face((a, b) => V(b, 24 + a, -23.7));   // -Z wall
  for (const p of world.faceWps) wp(world, p.x, p.y, p.z);
  mergeStatic(scene, world);
  return world;
}

/* ============== SECRET MAP — INFINITE BLOOM (recursive machine realm) ==============
   One square annulus is repeated at exact powers of its own inner/outer scale.
   The playable copy therefore meets a giant outer copy and a miniature inner
   copy edge-for-edge instead of presenting the center as a portal or pit. */
function bloomTexture(name, rx = 1, ry = 1) {
  const source = AI_TEX[name]?.map;
  if (!source) return null;
  const map = source.clone();
  map.needsUpdate = true;
  map.repeat.set(rx, ry);
  return map;
}

function addBloomFacePortal(scene, world, x, y, z, w, h, yaw = 0, parent = scene) {
  addMagicPortal(scene, world, x, y, z, w, h, 0x365f08, yaw, parent);
  const map = bloomTexture('infinite-bloom-faces', 1.15, 1.15);
  if (!map) return;
  const normalX = Math.sin(yaw), normalZ = Math.cos(yaw);
  const material = new THREE.MeshBasicMaterial({
    map,
    color: 0xffe56a,
    transparent: true,
    opacity: 0.79,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const faces = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.94, h * 0.94), material);
  faces.position.set(x + normalX * 0.09, y, z + normalZ * 0.09);
  faces.rotation.y = yaw;
  parent.add(faces);
  world.anim.push((dt, t) => {
    material.opacity = 0.73 + Math.sin(t * 2.7) * 0.07;
    map.offset.set(Math.sin(t * 0.17) * 0.035, Math.cos(t * 0.13) * 0.035);
  });
}

function buildInfiniteBloom(scene) {
  const ARENA_HALF = 36;
  const PORTAL_HALF = 7;
  const PORTAL_SCALE = ARENA_HALF / PORTAL_HALF;
  const INNER_SCALE = 1 / PORTAL_SCALE;
  const DEEP_SCALE = INNER_SCALE * INNER_SCALE;
  const ULTRA_DEEP_SCALE = DEEP_SCALE * INNER_SCALE;
  const FAR_OUTER_SCALE = PORTAL_SCALE * PORTAL_SCALE;
  const OUTER_VISUAL_HALF = ARENA_HALF * PORTAL_SCALE;
  const FLOOR_BAND_COUNT = 4;
  const FOG_EDGE_LEAD = 10;
  const NEXT_OUTER_PEEK = (OUTER_VISUAL_HALF - ARENA_HALF) * 0.2;
  const FOG_REVEAL_RATE = 1.6;
  const STRUCTURE_DETAIL_SCALE = 1.35;
  const RAMP_LANDING_SUPPORT = 1.2;
  const sceneRootsBeforeBuild = new Set(scene.children);
  let bloomOwnedRoots = [];
  const world = newWorld({
    gravity: 18,
    jumpVel: 10.4,
    killY: -85,
    playerSpeed: 12.2,
    waypointLinkDist: 19,
    waypointLinkDy: 5.4,
    availableWeapons: ['blaster', 'scatter', 'pulsar', 'sidewinder', 'loophole', 'hyper', 'parasite', 'whomper'],
  });
  world.playerCount = 4;
  world.recursivePortal = {
    half: PORTAL_HALF,
    outerHalf: ARENA_HALF,
    scale: PORTAL_SCALE,
    innerScale: INNER_SCALE,
    deepScale: DEEP_SCALE,
    maxProjectileCrossings: 9,
  };

  scene.background = new THREE.Color(0x050800);
  // This baseline is refined from the live camera in beforeRender. The full
  // adjacent outer edge stays readable and the fade continues a short way
  // into the following recursion instead of concealing the first copy early.
  scene.fog = new THREE.Fog(0x070a00, 150, 190);
  baseLighting(scene, 0xb6ff38, 0x3a0800, [34, 92, -46], 64);

  // Everything parented to this root is one canonical copy of the arena.
  // Cloning only this root (rather than the whole scene) keeps the repeated
  // layers free of cameras, lights, particles, actors, and gameplay colliders.
  const arenaRoot = new THREE.Group();
  arenaRoot.name = 'infinite-bloom-canonical-arena';
  scene.add(arenaRoot);

  // A dark, tiled crowd of circuit-built faces surrounds the arena. Mirrored
  // repeat is intentional here: this is an endless material, not a mural.
  // The source is square, so 6x3 tiles keep each repeat roughly square in
  // angular space on this 2:1 sphere while tripling the apparent detail.
  const skyMap = bloomTexture('infinite-bloom-sky-eyeless', 6, 3);
  let sky = null;
  let skySparks = null;
  if (skyMap) {
    sky = new THREE.Mesh(
      new THREE.SphereGeometry(285, 48, 24),
      new THREE.MeshBasicMaterial({
        map: skyMap,
        color: 0xdfff86,
        side: THREE.BackSide,
        fog: false,
        depthTest: false,
        depthWrite: false,
      }),
    );
    sky.renderOrder = -1000;
    sky.frustumCulled = false;
    scene.add(sky);
  }

  // The sky architecture is deliberately eyeless. Independent billboarded
  // atlas sprites sit just inside it, so every gaze shift and blink is real
  // animation rather than a baked texture sliding over the sphere.
  const eyeField = new THREE.Group();
  eyeField.name = 'infinite-bloom-animated-sky-eyes';
  scene.add(eyeField);
  const eyeStates = [];
  const eyeRnd = seededRandom(0xe7e5b11);
  const eyeMotionRnd = seededRandom(0x51e7a11);
  const eyeGazeFrames = [0, 1, 2, 3, 4, 9, 10, 11, 12, 13, 14, 15];
  const eyeAtlasSource = AI_TEX['infinite-bloom-eye-atlas']?.map;
  const setEyeFrame = (state, frame) => {
    if (state.frame === frame) return;
    state.frame = frame;
    const column = frame % 4;
    const row = Math.floor(frame / 4);
    state.map.offset.set(column * 0.25, 1 - (row + 1) * 0.25);
  };
  if (eyeAtlasSource) {
    const horizonEyeCount = 30;
    const overheadEyeCount = 6;
    const eyeCount = horizonEyeCount + overheadEyeCount;
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < eyeCount; i++) {
      const map = eyeAtlasSource.clone();
      map.needsUpdate = true;
      map.flipY = false;
      map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
      map.repeat.set(0.25, 0.25);
      const material = new THREE.SpriteMaterial({
        map,
        color: 0xffffff,
        transparent: true,
        opacity: 0.94,
        alphaTest: 0.035,
        depthWrite: false,
        fog: false,
      });
      const sprite = new THREE.Sprite(material);
      const isOverhead = i >= horizonEyeCount;
      const bandIndex = isOverhead ? i - horizonEyeCount : i;
      const bandProgress = bandIndex / ((isOverhead ? overheadEyeCount : horizonEyeCount) - 1);
      const yNorm = isOverhead
        ? THREE.MathUtils.clamp(0.76 + 0.18 * bandProgress + (eyeRnd() - 0.5) * 0.035, 0.74, 0.95)
        : THREE.MathUtils.clamp(-0.62 + 1.24 * bandProgress + (eyeRnd() - 0.5) * 0.055, -0.68, 0.68);
      const longitude = i * goldenAngle + (eyeRnd() - 0.5) * 0.24;
      const radial = Math.sqrt(1 - yNorm * yNorm);
      const radius = 272 + eyeRnd() * 5;
      sprite.position.set(
        Math.sin(longitude) * radial * radius,
        yNorm * radius,
        Math.cos(longitude) * radial * radius,
      );
      const baseSize = 17 + eyeRnd() * 11;
      const size = baseSize * (1 + eyeRnd() * 2) * 1.3;
      sprite.scale.set(size, size, 1);
      material.rotation = (eyeRnd() - 0.5) * 0.18;
      eyeField.add(sprite);
      const gazeFrame = eyeGazeFrames[Math.floor(eyeRnd() * eyeGazeFrames.length)];
      const state = { map, frame: -1, gazeFrame, closed: false };
      setEyeFrame(state, gazeFrame);
      eyeStates.push(state);
    }
  }
  const eyeMotion = {
    stillT: 0,
    transition: null,
  };
  eyeField.userData.currentFrames = eyeStates.map(state => state.frame);
  eyeField.userData.action = 'still';
  eyeField.userData.stillDuration = 5;
  eyeField.userData.transitionDuration = 0.5;
  const beginEyeTransition = () => {
    const entries = eyeStates.map(state => {
      const roll = eyeMotionRnd();
      const action = state.closed ? 'open' : (roll < 0.5 ? 'gaze' : roll < 0.82 ? 'blink' : 'close');
      let frames;
      let finalFrame;
      if (action === 'blink') {
        frames = [state.gazeFrame, 5, 6, 7, 7, 6, 5, state.gazeFrame];
        finalFrame = state.gazeFrame;
      } else if (action === 'close') {
        frames = [state.gazeFrame, 5, 6, 7];
        finalFrame = 7;
        state.closed = true;
      } else if (action === 'open') {
        frames = [7, 6, 5, state.gazeFrame];
        finalFrame = state.gazeFrame;
        state.closed = false;
      } else {
        const previous = state.gazeFrame;
        let nextIndex = Math.floor(eyeMotionRnd() * eyeGazeFrames.length);
        if (eyeGazeFrames[nextIndex] === previous) nextIndex = (nextIndex + 1) % eyeGazeFrames.length;
        state.gazeFrame = eyeGazeFrames[nextIndex];
        const intermediate = ({ 9: 3, 10: 3, 11: 4, 12: 4 })[state.gazeFrame] ?? 0;
        frames = [previous];
        if (intermediate !== previous && intermediate !== state.gazeFrame) frames.push(intermediate);
        frames.push(state.gazeFrame);
        finalFrame = state.gazeFrame;
      }
      setEyeFrame(state, frames[0]);
      return { state, action, frames, finalFrame, frameIndex: 0 };
    });
    eyeMotion.transition = { entries, elapsed: 0 };
    eyeField.userData.action = 'mixed';
    eyeField.userData.currentActions = entries.map(entry => entry.action);
    eyeField.userData.currentFrames = eyeStates.map(state => state.frame);
  };
  world.anim.push((dt, t) => {
    const yaw = t * 0.012;
    const roll = Math.sin(t * 0.035) * 0.025;
    if (sky) {
      sky.rotation.y = yaw;
      sky.rotation.z = roll;
    }
    eyeField.rotation.y = yaw;
    eyeField.rotation.z = roll;
    if (!eyeStates.length) return;
    if (!eyeMotion.transition) {
      eyeMotion.stillT += dt;
      if (eyeMotion.stillT >= 5) beginEyeTransition();
      return;
    }
    const transition = eyeMotion.transition;
    transition.elapsed = Math.min(0.5, transition.elapsed + dt);
    const progress = transition.elapsed / 0.5;
    for (const entry of transition.entries) {
      const frameIndex = Math.min(
        entry.frames.length - 1,
        Math.floor(progress * entry.frames.length),
      );
      if (frameIndex === entry.frameIndex) continue;
      entry.frameIndex = frameIndex;
      setEyeFrame(entry.state, entry.frames[frameIndex]);
    }
    eyeField.userData.currentFrames = eyeStates.map(state => state.frame);
    if (transition.elapsed >= 0.5) {
      for (const entry of transition.entries) setEyeFrame(entry.state, entry.finalFrame);
      eyeMotion.transition = null;
      eyeMotion.stillT = 0;
      eyeField.userData.action = 'still';
      eyeField.userData.currentActions = [];
      eyeField.userData.currentFrames = eyeStates.map(state => state.frame);
    }
  });

  // Main square ring. Its outer half-width and inner half-width use the same
  // ratio as every repeated layer, so adjoining copies meet edge-for-edge.
  const surface = { tex: 'infinite-bloom-surface' };
  const addBloomFloorCollider = (x, z, w, d) => {
    world.colliders.push({
      type: 'box',
      min: V(x - w / 2, -1, z - d / 2),
      max: V(x + w / 2, 0, z + d / 2),
    });
  };
  for (const [x, z, w, d] of [
    [0, 21.5, 72, 29],
    [0, -21.5, 72, 29],
    [21.5, 0, 29, 14],
    [-21.5, 0, 29, 14],
  ]) {
    addBloomFloorCollider(x, z, w, d);
  }

  // The ground is an infinite sequence of concentric square bands rather
  // than a texture. Each recursion contains four logarithmically spaced
  // bands: white at the inner edge, then black, white, black at the outer
  // edge. Because four is even, the adjacent copy begins white again and the
  // shared boundary reads as one more stripe instead of a layer seam.
  const floorPalette = [new THREE.Color(0xf4f2df), new THREE.Color(0x070806)];
  const floorGeometries = [];
  const addFloorSheet = (x, z, w, d, color) => {
    const geometry = new THREE.PlaneGeometry(w, d);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(x, 0, z);
    const vertexColors = new Float32Array(geometry.attributes.position.count * 3);
    for (let i = 0; i < geometry.attributes.position.count; i++) {
      vertexColors.set([color.r, color.g, color.b], i * 3);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(vertexColors, 3));
    floorGeometries.push(geometry);
  };
  const addFloorBand = (innerHalf, outerHalf, color) => {
    const edgeWidth = outerHalf - innerHalf;
    const sideCenter = (innerHalf + outerHalf) / 2;
    addFloorSheet(0, sideCenter, outerHalf * 2, edgeWidth, color);
    addFloorSheet(0, -sideCenter, outerHalf * 2, edgeWidth, color);
    addFloorSheet(sideCenter, 0, edgeWidth, innerHalf * 2, color);
    addFloorSheet(-sideCenter, 0, edgeWidth, innerHalf * 2, color);
  };
  for (let band = 0; band < FLOOR_BAND_COUNT; band++) {
    const innerHalf = band === 0
      ? PORTAL_HALF
      : PORTAL_HALF * Math.pow(PORTAL_SCALE, band / FLOOR_BAND_COUNT);
    const outerHalf = band === FLOOR_BAND_COUNT - 1
      ? ARENA_HALF
      : PORTAL_HALF * Math.pow(PORTAL_SCALE, (band + 1) / FLOOR_BAND_COUNT);
    addFloorBand(innerHalf, outerHalf, floorPalette[band % 2]);
  }
  const floorMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    side: THREE.DoubleSide,
    fog: true,
  });
  const floor = new THREE.Mesh(mergeGeometries(floorGeometries, false), floorMaterial);
  floor.name = 'infinite-bloom-concentric-floor';
  arenaRoot.add(floor);
  for (const geometry of floorGeometries) geometry.dispose();

  // Four raised "petals" make the silhouette readable again inside every
  // recursive copy. Their ramps point inward toward the next scale.
  const decks = [
    { x: 0, z: 24, w: 16, d: 12, color: 0xd9ef20 },
    { x: 0, z: -24, w: 16, d: 12, color: 0xe53e13 },
    { x: 24, z: 0, w: 12, d: 16, color: 0xff9d12 },
    { x: -24, z: 0, w: 12, d: 16, color: 0x69d51a },
  ];
  for (const deck of decks) {
    addBox(arenaRoot, world, deck.x, 3.5, deck.z, deck.w, 1, deck.d, deck.color, {
      ...surface,
      repeat: [
        Math.max(1.25, deck.w / (4 * STRUCTURE_DETAIL_SCALE)),
        Math.max(1.25, deck.d / (4 * STRUCTURE_DETAIL_SCALE)),
      ],
    });
  }
  const styleBloomRamp = (ramp, color) => {
    ramp.material.map?.dispose();
    ramp.material.normalMap?.dispose();
    ramp.material.dispose();
    ramp.material = mat(color, {
      tex: 'infinite-bloom-surface',
      repeat: [2.4 / STRUCTURE_DETAIL_SCALE, 1.25 / STRUCTURE_DETAIL_SCALE],
      roughness: 0.58,
      metalness: 0.12,
    });
  };
  styleBloomRamp(addRamp(arenaRoot, world, {
    axis: 'z', minX: -4, maxX: 4, minZ: 12, maxZ: 18,
    h0: 0, h1: 4, color: 0xd9ef20,
    supportPad1: RAMP_LANDING_SUPPORT, crestBlend1: RAMP_LANDING_SUPPORT,
  }), 0xbfd923);
  styleBloomRamp(addRamp(arenaRoot, world, {
    axis: 'z', minX: -4, maxX: 4, minZ: -18, maxZ: -12,
    h0: 4, h1: 0, color: 0xe53e13,
    supportPad0: RAMP_LANDING_SUPPORT, crestBlend0: RAMP_LANDING_SUPPORT,
  }), 0xe1531d);
  styleBloomRamp(addRamp(arenaRoot, world, {
    axis: 'x', minX: 12, maxX: 18, minZ: -4, maxZ: 4,
    h0: 0, h1: 4, color: 0xff9d12,
    supportPad1: RAMP_LANDING_SUPPORT, crestBlend1: RAMP_LANDING_SUPPORT,
  }), 0xe8931b);
  styleBloomRamp(addRamp(arenaRoot, world, {
    axis: 'x', minX: -18, maxX: -12, minZ: -4, maxZ: 4,
    h0: 4, h1: 0, color: 0x69d51a,
    supportPad0: RAMP_LANDING_SUPPORT, crestBlend0: RAMP_LANDING_SUPPORT,
  }), 0x64c522);

  // Blocky machine-elf totems stare toward the center. The texture crop on
  // each screen is different, so the same tile produces many distinct faces.
  const faceRnd = seededRandom(0xe1f51f);
  const addWatcher = (x, y, z, w, h, yaw, tint = 0xffffff, blocking = false) => {
    let panelX = x;
    let panelZ = z;
    if (blocking) {
      // Perimeter watchers are square cover blocks, not intangible cards. The
      // supplied coordinate remains their outer face; the solid extends into
      // the playable ring so it never crosses the recursive 36m boundary.
      const thickness = 1.1;
      const nx = Math.sin(yaw);
      const nz = Math.cos(yaw);
      const blockX = x + nx * thickness * 0.5;
      const blockZ = z + nz * thickness * 0.5;
      const alongX = Math.abs(nx) > 0.5;
      addBox(
        arenaRoot,
        world,
        blockX,
        y,
        blockZ,
        alongX ? thickness : w,
        h,
        alongX ? w : thickness,
        tint,
        {
          ...surface,
          repeat: [1 / STRUCTURE_DETAIL_SCALE, 1 / STRUCTURE_DETAIL_SCALE],
        },
      );
      panelX = blockX + nx * (thickness * 0.5 + 0.012);
      panelZ = blockZ + nz * (thickness * 0.5 + 0.012);
    }
    const map = bloomTexture('infinite-bloom-faces', 0.34, 0.34);
    if (!map) return;
    map.offset.set(faceRnd(), faceRnd());
    const material = new THREE.MeshStandardMaterial({
      map,
      color: tint,
      emissive: new THREE.Color(tint).multiplyScalar(0.28),
      emissiveIntensity: 0.72,
      roughness: 0.46,
      metalness: 0.18,
      side: THREE.DoubleSide,
    });
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
    panel.position.set(panelX, y, panelZ);
    panel.rotation.y = yaw;
    arenaRoot.add(panel);
    world.anim.push((dt, t) => {
      material.emissiveIntensity = 0.58 + Math.sin(t * 2.1 + x * 0.17 + z * 0.11) * 0.18;
    });
  };
  const totems = [
    [-14, -14, 0xff4b17], [14, -14, 0xf2db18],
    [-14, 14, 0x60d817], [14, 14, 0xff9615],
  ];
  for (const [x, z, color] of totems) {
    addBox(arenaRoot, world, x, 2.8, z, 3.6, 5.6, 3.6, color, {
      ...surface,
      repeat: [1 / STRUCTURE_DETAIL_SCALE, 2 / STRUCTURE_DETAIL_SCALE],
    });
    const yaw = Math.atan2(-x, -z);
    const nx = Math.sin(yaw), nz = Math.cos(yaw);
    addWatcher(x + nx * 1.83, 3.25, z + nz * 1.83, 2.7, 3.5, yaw, color);
    const eye = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.32, 0),
      new THREE.MeshBasicMaterial({ color: 0xffff79, toneMapped: false }),
    );
    eye.position.set(x + nx * 2.08, 4.05, z + nz * 2.08);
    arenaRoot.add(eye);
  }
  // The inward totem faces remain living machine portraits. Poster art goes
  // on the flat north faces and repeats naturally with the canonical arena.
  for (const x of [-14, 14]) {
    addDecal(arenaRoot, 'poster-bloom', x, 3.25, -15.83, 3, Math.PI);
  }
  for (const [x, y, z, yaw, tint] of [
    [-24, 6, -35.94, 0, 0xff5417], [0, 8, -35.94, 0, 0xe8ed1a], [24, 5, -35.94, 0, 0x79d91c],
    [24, 7, 35.94, Math.PI, 0xff7315], [0, 5, 35.94, Math.PI, 0xd8ef1a], [-24, 8, 35.94, Math.PI, 0x68d219],
    [-35.94, 6, -23, Math.PI / 2, 0x71d718], [-35.94, 8, 23, Math.PI / 2, 0xe9e719],
    [35.94, 8, -23, -Math.PI / 2, 0xff4615], [35.94, 6, 23, -Math.PI / 2, 0xff9d16],
  ]) addWatcher(x, y, z, 5.6, 5.6, yaw, tint, true);

  // Cardinal seeds double as cover and scale landmarks in the miniature.
  const seeds = [];
  for (const [x, y, z, color, phase] of [
    [0, 6.2, 24, 0xeaff29, 0],
    [0, 6.2, -24, 0xff3d14, 1.4],
    [24, 6.2, 0, 0xffa414, 2.8],
    [-24, 6.2, 0, 0x63e31a, 4.2],
  ]) {
    const seed = new THREE.Mesh(
      new THREE.DodecahedronGeometry(1.15, 0),
      new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 1.05,
        metalness: 0.4,
        roughness: 0.28,
      }),
    );
    seed.position.set(x, y, z);
    arenaRoot.add(seed);
    seeds.push({ seed, y, phase });
    const light = new THREE.PointLight(color, 16, 24);
    light.position.set(x, y + 0.5, z);
    scene.add(light);
  }
  world.anim.push((dt, t) => {
    for (const { seed, y, phase } of seeds) {
      seed.rotation.x = t * 0.7 + phase;
      seed.rotation.y = t * 1.05 - phase;
      seed.position.y = y + Math.sin(t * 1.8 + phase) * 0.35;
    }
  });

  // Materialize the canonical static geometry before cloning it. The outer
  // copy's 14-unit opening becomes exactly 72 units wide (the current arena),
  // while the inner copy's 72-unit outside becomes exactly 14 units wide (the
  // current opening). The result is one continuous, coplanar onion of arenas.
  mergeStatic(arenaRoot, world);
  const sourceNodes = [];
  arenaRoot.traverse(node => sourceNodes.push(node));
  const repeatedLayers = [];
  const addRepeatedLayer = (name, scale, mirrorActors) => {
    const root = arenaRoot.clone(true);
    root.name = name;
    root.scale.setScalar(scale);
    root.traverse(obj => {
      if (!obj.isMesh) return;
      obj.castShadow = false;
      obj.receiveShadow = true;
    });
    scene.add(root);
    const nodes = [];
    root.traverse(node => nodes.push(node));
    repeatedLayers.push({ root, nodes, scale, mirrorActors });
    return root;
  };
  // One extra copy on either side of the immediately adjacent layers keeps
  // both sightline ends recursive. The far outer copy is atmospheric only:
  // fog reveals just its inward edge beyond the complete playable outer copy.
  const farOuterArenaRoot = addRepeatedLayer('infinite-bloom-far-outer-arena', FAR_OUTER_SCALE, false);
  const outerArenaRoot = addRepeatedLayer('infinite-bloom-outer-arena', PORTAL_SCALE, true);
  const innerArenaRoot = addRepeatedLayer('infinite-bloom-inner-arena', INNER_SCALE, true);
  const deepArenaRoot = addRepeatedLayer('infinite-bloom-deep-arena', DEEP_SCALE, false);
  const ultraDeepArenaRoot = addRepeatedLayer('infinite-bloom-ultra-deep-arena', ULTRA_DEEP_SCALE, false);
  world.recursiveVisual = {
    canonicalRoot: arenaRoot,
    farOuterRoot: farOuterArenaRoot,
    outerRoot: outerArenaRoot,
    innerRoot: innerArenaRoot,
    deepRoot: deepArenaRoot,
    ultraDeepRoot: ultraDeepArenaRoot,
    layers: repeatedLayers,
    farOuterScale: FAR_OUTER_SCALE,
    outerScale: PORTAL_SCALE,
    innerScale: INNER_SCALE,
    deepScale: DEEP_SCALE,
    ultraDeepScale: ULTRA_DEEP_SCALE,
  };
  // Animated landmarks stay phase-locked across all visible scales. Materials
  // and geometry are shared by clone(), while these local transforms are not.
  world.anim.push(() => {
    for (const { nodes } of repeatedLayers) {
      const count = Math.min(sourceNodes.length, nodes.length);
      for (let i = 1; i < count; i++) {
        nodes[i].position.copy(sourceNodes[i].position);
        nodes[i].quaternion.copy(sourceNodes[i].quaternion);
        nodes[i].visible = sourceNodes[i].visible;
      }
    }
  });

  // The fourth visible level is deliberately static and capped. The cap is
  // only half a metre wide in world space, enough to avoid a black pinhole
  // without reintroducing the conspicuous flat portal used by the first pass.
  const deepCap = new THREE.Mesh(
    new THREE.PlaneGeometry(PORTAL_HALF * 2 * ULTRA_DEEP_SCALE * 1.02, PORTAL_HALF * 2 * ULTRA_DEEP_SCALE * 1.02),
    new THREE.MeshBasicMaterial({ color: floorPalette[1], side: THREE.DoubleSide, fog: true }),
  );
  deepCap.name = 'infinite-bloom-deep-cap';
  deepCap.rotation.x = -Math.PI / 2;
  deepCap.position.y = 0.008;
  scene.add(deepCap);

  // Dynamic copies use real perspective geometry too. The playable character
  // meshes remain canonical; exact copies of their live render hierarchies
  // occupy the immediately adjacent inner and outer repetitions. The deepest
  // decorative copy stays empty, matching the finite recursion budget above.
  const mirrorRoot = new THREE.Group();
  mirrorRoot.name = 'infinite-bloom-entity-mirrors';
  scene.add(mirrorRoot);
  world.recursiveVisual.mirrorRoot = mirrorRoot;

  const actorMirrors = new Map();
  const actorAuthoredScales = new WeakMap();
  const projectileMirrors = new Map();
  const tracerMirrors = new Map();
  const effectMirrors = new Map();
  const damageMarkerMirrors = new Map();
  const pickupMirrors = new Map();
  const mirrorScales = [INNER_SCALE, PORTAL_SCALE];
  const ACTOR_SEAM_BLEND = 8;
  const SEAM_MOVE_MIN_SCALE = 0.78;
  const SEAM_MOVE_RECOVERY = 0.45;

  // Bodies change representative at the 7m/36m similarity seam. Ease their
  // *height* toward the adjacent layer's scale over the last few metres, but
  // keep the group origin at the feet. Scaling around the eye lifted grounded
  // actors several metres into the air on the corresponding outer copy.
  const seamBlend = point => {
    const norm = Math.max(Math.abs(point.x), Math.abs(point.y), Math.abs(point.z));
    const seamT = THREE.MathUtils.clamp(
      (norm - PORTAL_HALF) / ACTOR_SEAM_BLEND,
      0,
      1,
    );
    return seamT * seamT * (3 - 2 * seamT);
  };
  const seamVisualScale = point => THREE.MathUtils.lerp(INNER_SCALE, 1, seamBlend(point));
  const seamMoveScale = point => THREE.MathUtils.lerp(SEAM_MOVE_MIN_SCALE, 1, seamBlend(point));
  world.characterVisualScale = character => seamVisualScale(character.pos);
  world.characterMoveScale = character => {
    const positionalScale = seamMoveScale(character.pos);
    const elapsed = (world._t || 0) - (character._bloomMoveSlowAt ?? -Infinity);
    if (elapsed >= SEAM_MOVE_RECOVERY) return positionalScale;
    const recoveryT = THREE.MathUtils.clamp(elapsed / SEAM_MOVE_RECOVERY, 0, 1);
    const easedT = recoveryT * recoveryT * (3 - 2 * recoveryT);
    return Math.min(positionalScale, THREE.MathUtils.lerp(SEAM_MOVE_MIN_SCALE, 1, easedT));
  };

  const actorSource = character => world.characterMirrorSource?.(character) ||
    character?.recursiveRenderSource || character?.mesh || null;
  const authoredScale = source => {
    let scale = actorAuthoredScales.get(source);
    if (!scale) {
      scale = source.scale.clone();
      actorAuthoredScales.set(source, scale);
    }
    return scale;
  };
  // Name tags are screen-facing UI, not part of the character model. Copy the
  // full render tree otherwise—including gun, suit, visor, team marker, and
  // nested charge effects—without sharing scene-graph nodes.
  const excludeActorNode = (node, character, root) => node !== root &&
    (node === character?.nameTag || node.isSprite || node.userData?.recursiveMirrorExclude);
  const cloneActorHierarchy = (source, character) => {
    const sourceNodes = [];
    const copyNodes = [];
    const cloneNode = node => {
      const copy = node.clone(false);
      sourceNodes.push(node);
      copyNodes.push(copy);
      for (const child of node.children) {
        if (excludeActorNode(child, character, source)) continue;
        copy.add(cloneNode(child));
      }
      return copy;
    };
    return { root: cloneNode(source), sourceNodes, copyNodes };
  };
  const actorHierarchyMatches = (entry, source, character) => {
    if (entry.source !== source) return false;
    let cursor = 0;
    let matches = true;
    const visit = node => {
      if (!matches || entry.sourceNodes[cursor++] !== node) {
        matches = false;
        return;
      }
      for (const child of node.children) {
        if (!excludeActorNode(child, character, source)) visit(child);
      }
    };
    visit(source);
    return matches && cursor === entry.sourceNodes.length;
  };
  const syncActorNode = (source, copy) => {
    copy.position.copy(source.position);
    copy.quaternion.copy(source.quaternion);
    copy.scale.copy(source.scale);
    copy.visible = source.visible;
    copy.renderOrder = source.renderOrder;
    copy.castShadow = source.castShadow;
    copy.receiveShadow = source.receiveShadow;
    copy.layers.mask = source.layers.mask;
    copy.matrixAutoUpdate = source.matrixAutoUpdate;
    if (!source.matrixAutoUpdate) copy.matrix.copy(source.matrix);
    copy.matrixWorldNeedsUpdate = true;
    if ('geometry' in source) copy.geometry = source.geometry;
    if ('material' in source) copy.material = source.material;
    if (source.morphTargetInfluences && copy.morphTargetInfluences) {
      const count = Math.min(source.morphTargetInfluences.length, copy.morphTargetInfluences.length);
      for (let i = 0; i < count; i++) copy.morphTargetInfluences[i] = source.morphTargetInfluences[i];
    }
  };
  const removeActorMirror = entry => {
    if (!entry) return;
    mirrorRoot.remove(entry.inner, entry.outer);
  };
  const addActorMirror = (character, source) => {
    const innerTree = cloneActorHierarchy(source, character);
    const outerTree = cloneActorHierarchy(source, character);
    const inner = innerTree.root;
    const outer = outerTree.root;
    inner.name = `infinite-bloom-inner-${character.name || 'character'}`;
    outer.name = `infinite-bloom-outer-${character.name || 'character'}`;
    inner.userData.recursiveMirror = true;
    outer.userData.recursiveMirror = true;
    mirrorRoot.add(inner, outer);
    const entry = {
      source,
      sourceNodes: innerTree.sourceNodes,
      innerNodes: innerTree.copyNodes,
      outerNodes: outerTree.copyNodes,
      inner,
      outer,
      baseMeshScale: character.mesh ? authoredScale(character.mesh) : null,
      baseSourceScale: authoredScale(source),
    };
    actorMirrors.set(character, entry);
    return entry;
  };
  const syncActorMirrors = characters => {
    const live = new Set(characters || []);
    for (const character of live) {
      const source = actorSource(character);
      let entry = actorMirrors.get(character);
      if (!source) {
        removeActorMirror(entry);
        actorMirrors.delete(character);
        continue;
      }
      if (!entry || !actorHierarchyMatches(entry, source, character)) {
        removeActorMirror(entry);
        entry = addActorMirror(character, source);
      }
      for (let i = 1; i < entry.sourceNodes.length; i++) {
        syncActorNode(entry.sourceNodes[i], entry.innerNodes[i]);
        syncActorNode(entry.sourceNodes[i], entry.outerNodes[i]);
      }
      const visible = character.alive !== false && source.visible !== false;
      // At the inner/current seam an equivalence-class representative changes
      // from the canonical body to its scaled copy (or vice versa). Shrinking
      // every visible representative over the final few metres makes the two
      // overlapping bodies meet at exactly the same apparent size instead of
      // popping by the full recursion ratio on the crossing frame. Character
      // meshes are authored with their origin at their feet, which is also the
      // correct fixed point for a player standing on the y=0 arena plane.
      const visualScale = seamVisualScale(character.pos);
      if (character.mesh && entry.baseMeshScale) {
        character.mesh.scale.copy(entry.baseMeshScale).multiplyScalar(visualScale);
        character.mesh.position.copy(character.pos);
      }
      for (let i = 0; i < mirrorScales.length; i++) {
        const scale = mirrorScales[i];
        const proxy = i === 0 ? entry.inner : entry.outer;
        proxy.visible = visible;
        proxy.position.copy(character.pos).multiplyScalar(scale);
        proxy.quaternion.copy(source.quaternion);
        proxy.scale.copy(entry.baseSourceScale).multiplyScalar(scale * visualScale);
      }
    }
    for (const [character, entry] of actorMirrors) {
      if (live.has(character)) continue;
      removeActorMirror(entry);
      actorMirrors.delete(character);
    }
  };

  world.projectileTargetScale = (projectile, character) => {
    const up = character.up || THREE.Object3D.DEFAULT_UP;
    const centerHeight = (character.height || 1.8) * 0.55 * seamVisualScale(character.pos);
    const cx = character.pos.x + up.x * centerHeight;
    const cy = character.pos.y + up.y * centerHeight;
    const cz = character.pos.z + up.z * centerHeight;
    let bestScale = 1;
    let bestDistance = Infinity;
    for (const scale of [INNER_SCALE, 1, PORTAL_SCALE]) {
      const dx = cx * scale - projectile.pos.x;
      const dy = cy * scale - projectile.pos.y;
      const dz = cz * scale - projectile.pos.z;
      const distance = dx * dx + dy * dy + dz * dz;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestScale = scale;
      }
    }
    return bestScale;
  };

  // Transient gameplay visuals borrow the exact canonical render hierarchy.
  // Geometry, materials, textures, and animated child transforms stay shared;
  // only Object3D transforms are cloned so one object can occupy three scene
  // locations simultaneously without becoming three gameplay objects.
  const cloneBorrowedHierarchy = source => {
    const sourceNodes = [];
    const copyNodes = [];
    const cloneNode = node => {
      const copy = node.clone(false);
      sourceNodes.push(node);
      copyNodes.push(copy);
      for (const child of node.children) copy.add(cloneNode(child));
      return copy;
    };
    return { root: cloneNode(source), sourceNodes, copyNodes };
  };
  const borrowedHierarchyMatches = (entry, source) => {
    if (entry.source !== source) return false;
    let cursor = 0;
    let matches = true;
    source.traverse(node => {
      if (matches && entry.sourceNodes[cursor++] !== node) matches = false;
    });
    return matches && cursor === entry.sourceNodes.length;
  };
  const addBorrowedMirrors = (source, name) => {
    const innerTree = cloneBorrowedHierarchy(source);
    const outerTree = cloneBorrowedHierarchy(source);
    const entry = {
      source,
      sourceNodes: innerTree.sourceNodes,
      innerNodes: innerTree.copyNodes,
      outerNodes: outerTree.copyNodes,
      inner: innerTree.root,
      outer: outerTree.root,
    };
    entry.inner.name = `infinite-bloom-inner-${name}`;
    entry.outer.name = `infinite-bloom-outer-${name}`;
    entry.inner.userData.recursiveMirror = true;
    entry.outer.userData.recursiveMirror = true;
    mirrorRoot.add(entry.inner, entry.outer);
    return entry;
  };
  const removeBorrowedMirrors = entry => {
    if (entry) mirrorRoot.remove(entry.inner, entry.outer);
  };
  const syncBorrowedChildren = entry => {
    for (let i = 1; i < entry.sourceNodes.length; i++) {
      syncActorNode(entry.sourceNodes[i], entry.innerNodes[i]);
      syncActorNode(entry.sourceNodes[i], entry.outerNodes[i]);
    }
  };
  const syncBorrowedRoot = (source, copy, scale) => {
    syncActorNode(source, copy);
    copy.position.copy(source.position).multiplyScalar(scale);
    copy.scale.copy(source.scale).multiplyScalar(scale);
  };

  const addProjectileMirror = projectile => {
    const entry = addBorrowedMirrors(projectile.mesh, 'projectile');
    entry.baseScale = (projectile.mesh._recursiveBaseScale || projectile.mesh.scale).clone();
    projectileMirrors.set(projectile, entry);
    return entry;
  };
  const syncProjectileMirrors = projectiles => {
    const live = new Set(projectiles || []);
    for (const projectile of live) {
      let entry = projectileMirrors.get(projectile);
      if (!entry || !borrowedHierarchyMatches(entry, projectile.mesh)) {
        removeBorrowedMirrors(entry);
        entry = addProjectileMirror(projectile);
      }
      syncBorrowedChildren(entry);
      // The representative swaps at a seam. Apply the same linear shrink as
      // actors so the exact projectile entering the inner arena is the exact
      // size of the copy continuing from the opposite edge on the next frame.
      const visualScale = seamVisualScale(projectile.pos);
      projectile.mesh.scale.copy(entry.baseScale).multiplyScalar(
        visualScale * (projectile.recursionScale || 1),
      );
      projectile.mesh.visible = projectile.life > 0;
      for (let i = 0; i < mirrorScales.length; i++) {
        const scale = mirrorScales[i];
        const proxy = i === 0 ? entry.inner : entry.outer;
        syncBorrowedRoot(projectile.mesh, proxy, scale);
      }
    }
    for (const [projectile, entry] of projectileMirrors) {
      if (live.has(projectile)) continue;
      removeBorrowedMirrors(entry);
      projectileMirrors.delete(projectile);
    }
  };

  const addTracerMirror = tracer => {
    const entry = addBorrowedMirrors(tracer.mesh, 'remote-tracer');
    entry.baseScale = (tracer.mesh._recursiveBaseScale || tracer.mesh.scale).clone();
    entry.generation = tracer.generation;
    tracerMirrors.set(tracer, entry);
    return entry;
  };
  const syncTracerMirrors = tracers => {
    const live = new Set(tracers || []);
    for (const tracer of live) {
      let entry = tracerMirrors.get(tracer);
      if (!entry || entry.generation !== tracer.generation ||
          !borrowedHierarchyMatches(entry, tracer.mesh)) {
        removeBorrowedMirrors(entry);
        entry = addTracerMirror(tracer);
      }
      syncBorrowedChildren(entry);
      const visualScale = seamVisualScale(tracer.mesh.position);
      tracer.mesh.scale.copy(entry.baseScale).multiplyScalar(
        visualScale * (tracer.recursionScale || 1),
      );
      for (let i = 0; i < mirrorScales.length; i++) {
        const scale = mirrorScales[i];
        const proxy = i === 0 ? entry.inner : entry.outer;
        syncBorrowedRoot(tracer.mesh, proxy, scale);
      }
    }
    for (const [tracer, entry] of tracerMirrors) {
      if (live.has(tracer)) continue;
      removeBorrowedMirrors(entry);
      tracerMirrors.delete(tracer);
    }
  };

  const syncEffectMirrors = effects => {
    // Projectiles themselves are never capped. Only secondary trail/impact
    // puffs use this ceiling so a four-player rapid-fire exchange cannot turn
    // the two presentation layers into hundreds of extra draw calls.
    const mirroredEffects = effects?.length > 24 ? effects.slice(-24) : (effects || []);
    const live = new Set(mirroredEffects);
    for (const effect of live) {
      const source = effect?.m;
      if (!source) continue;
      let entry = effectMirrors.get(effect);
      if (!entry || !borrowedHierarchyMatches(entry, source)) {
        removeBorrowedMirrors(entry);
        entry = addBorrowedMirrors(source, 'effect');
        effectMirrors.set(effect, entry);
      }
      syncBorrowedChildren(entry);
      for (let i = 0; i < mirrorScales.length; i++) {
        syncBorrowedRoot(source, i === 0 ? entry.inner : entry.outer, mirrorScales[i]);
      }
    }
    for (const [effect, entry] of effectMirrors) {
      if (live.has(effect)) continue;
      removeBorrowedMirrors(entry);
      effectMirrors.delete(effect);
    }
  };

  const syncDamageMarkerMirrors = markers => {
    const live = new Set(markers || []);
    for (const marker of live) {
      const source = marker?.sprite;
      if (!source) continue;
      let entry = damageMarkerMirrors.get(marker);
      if (!entry || !borrowedHierarchyMatches(entry, source)) {
        removeBorrowedMirrors(entry);
        entry = addBorrowedMirrors(source, 'damage-marker');
        damageMarkerMirrors.set(marker, entry);
      }
      for (let i = 0; i < mirrorScales.length; i++) {
        syncBorrowedRoot(source, i === 0 ? entry.inner : entry.outer, mirrorScales[i]);
      }
    }
    for (const [marker, entry] of damageMarkerMirrors) {
      if (live.has(marker)) continue;
      removeBorrowedMirrors(entry);
      damageMarkerMirrors.delete(marker);
    }
  };

  const syncPickupMirrors = pickups => {
    const live = new Set(pickups || []);
    for (const pickup of live) {
      const source = pickup?.mesh;
      if (!source) continue;
      let entry = pickupMirrors.get(pickup);
      if (!entry || !borrowedHierarchyMatches(entry, source)) {
        removeBorrowedMirrors(entry);
        entry = addBorrowedMirrors(source, 'pickup');
        pickupMirrors.set(pickup, entry);
      }
      syncBorrowedChildren(entry);
      for (let i = 0; i < mirrorScales.length; i++) {
        syncBorrowedRoot(source, i === 0 ? entry.inner : entry.outer, mirrorScales[i]);
      }
    }
    for (const [pickup, entry] of pickupMirrors) {
      if (live.has(pickup)) continue;
      removeBorrowedMirrors(entry);
      pickupMirrors.delete(pickup);
    }
  };

  world.beforeRender = ({
    camera, characters = [], projectiles = [], remoteTracers = [], effects = [], damageMarkers = [], pickups = [],
  }) => {
    // Sky and atmospheric eyes are direction-only scenery. Keeping their
    // center on the active camera removes all parallax from the 36 -> 7 chart
    // rebase, so the backdrop cannot jump vertically or slide at a seam.
    if (camera) {
      if (sky) sky.position.copy(camera.position);
      eyeField.position.copy(camera.position);
      if (skySparks) {
        skySparks.position.set(
          camera.position.x,
          camera.position.y + (skySparks.userData.floatY || 0),
          camera.position.z,
        );
      }
    }
    // Linear scene fog is camera-relative, but its far plane must also follow
    // the square recursion. Start fading just before the adjacent outer edge,
    // keep that boundary legible, and finish roughly twenty percent of one
    // outer-ring span into the next copy. This preserves the useful large
    // target layer without letting the extra recursion dominate the scene.
    if (camera && scene.fog) {
      const cameraRadius = Math.max(Math.abs(camera.position.x), Math.abs(camera.position.z));
      const edgeDistance = OUTER_VISUAL_HALF - cameraRadius;
      const targetNear = Math.max(54, edgeDistance - FOG_EDGE_LEAD);
      const targetFar = edgeDistance + NEXT_OUTER_PEEK;
      const now = world._t || 0;
      const dt = world._bloomFogT == null
        ? 1 / 60
        : THREE.MathUtils.clamp(now - world._bloomFogT, 0, 0.05);
      world._bloomFogT = now;
      // Both expansion and contraction ease. The crossing hook below first
      // transforms the live fog distances by the exact recursion factor, so
      // objects keep the same fog coverage on the crossing frame and then
      // feather in or out while the chart settles.
      scene.fog.near = THREE.MathUtils.damp(scene.fog.near, targetNear, FOG_REVEAL_RATE, dt);
      scene.fog.far = THREE.MathUtils.damp(scene.fog.far, targetFar, FOG_REVEAL_RATE, dt);
    }
    syncActorMirrors(characters);
    syncProjectileMirrors(projectiles);
    syncTracerMirrors(remoteTracers);
    syncEffectMirrors(effects);
    syncDamageMarkerMirrors(damageMarkers);
    syncPickupMirrors(pickups);
  };

  // Canonical physics lives in the middle annulus. Crossing either similarity
  // boundary simply chooses the adjacent equivalent coordinate. The max norm
  // is deliberate: it matches the square arena and also makes a straight fall
  // through the origin re-scale before it can ever reach the center.
  const RECURSION_EPSILON = 0.03;
  const recursiveNorm = point => Math.max(Math.abs(point.x), Math.abs(point.y), Math.abs(point.z));
  const crossingFactor = (previous, current) => {
    const previousNorm = recursiveNorm(previous);
    const currentNorm = recursiveNorm(current);
    if (previousNorm >= PORTAL_HALF && currentNorm < PORTAL_HALF) return PORTAL_SCALE;
    if (previousNorm <= ARENA_HALF && currentNorm > ARENA_HALF) return INNER_SCALE;
    return 1;
  };
  const canonicalFactor = point => {
    const norm = recursiveNorm(point);
    if (norm < PORTAL_HALF - RECURSION_EPSILON) return PORTAL_SCALE;
    if (norm > ARENA_HALF + RECURSION_EPSILON) return INNER_SCALE;
    return 1;
  };
  const rayCubeInterval = (origin, dir, half) => {
    let enter = -Infinity;
    let exit = Infinity;
    for (const axis of ['x', 'y', 'z']) {
      if (Math.abs(dir[axis]) < 1e-7) {
        if (origin[axis] < -half || origin[axis] > half) return null;
        continue;
      }
      let a = (-half - origin[axis]) / dir[axis];
      let b = (half - origin[axis]) / dir[axis];
      if (a > b) [a, b] = [b, a];
      enter = Math.max(enter, a);
      exit = Math.min(exit, b);
      if (enter > exit) return null;
    }
    return { enter, exit };
  };
  // Recursive hitscan effects need the exact next chart boundary. Returning
  // the similarity transform lets them draw one connected segment on each
  // recursion level instead of pretending the seam is a flat portal.
  world.recursiveRayBoundary = (origin, dir, maxDistance = Infinity) => {
    const candidates = [];
    const inner = rayCubeInterval(origin, dir, PORTAL_HALF);
    if (inner?.enter > RECURSION_EPSILON && inner.enter <= maxDistance) {
      candidates.push({ distance: inner.enter, factor: PORTAL_SCALE });
    }
    const outer = rayCubeInterval(origin, dir, ARENA_HALF);
    if (outer?.exit > RECURSION_EPSILON && outer.exit <= maxDistance) {
      candidates.push({ distance: outer.exit, factor: INNER_SCALE });
    }
    candidates.sort((a, b) => a.distance - b.distance);
    return candidates[0] || null;
  };
  const syncRecursivePlayerCamera = (character, up, eyeHeight) => {
    if (!character.isPlayer || !character.camera) return;
    // The first-person eye follows the same linear body shrink as the actor
    // proxies. Just inside the seam, multiplying the camera by PORTAL_SCALE
    // therefore lands on the full-height camera just outside it without a
    // vertical pop or the old several-metre launch/fall.
    const visualScale = seamVisualScale(character.pos);
    character.camera.position.copy(character.pos).addScaledVector(up, eyeHeight * visualScale);
  };
  world.postCharacterMove = (character, previous) => {
    if (!character?.alive || !previous) return;
    const up = character.up || new THREE.Vector3(0, 1, 0);
    const eyeHeight = character.isPlayer ? (character.eyeHeight || 1.6) : 0;
    const factor = crossingFactor(previous, character.pos);
    if (factor === 1) {
      syncRecursivePlayerCamera(character, up, eyeHeight);
      return;
    }
    // Position is a feet-space coordinate. Scaling it directly keeps y=0
    // fixed for a grounded crossing and preserves full 3D similarity for a
    // player falling through the recursive opening. Grounded runners get a
    // shallow, short movement blend instead of inheriting the adjacent layer's
    // full 0.194x scale or keeping enough speed to read as a seam boost.
    const planarFloorCrossing = up.y > 0.9 &&
      Math.abs(previous.y) < 0.25 && Math.abs(character.pos.y) < 0.25 &&
      Math.abs(character.vel.y) < 2;
    if (character.isPlayer && scene.fog) {
      const scaledNear = scene.fog.near * factor;
      const scaledFar = Math.min(820, scene.fog.far * factor);
      scene.fog.far = Math.max(2, scaledFar);
      scene.fog.near = THREE.MathUtils.clamp(scaledNear, 0.5, scene.fog.far - 1);
      // Prevent beforeRender from consuming the transition on the same tick.
      world._bloomFogT = world._t || 0;
    }
    character.pos.multiplyScalar(factor);
    if (planarFloorCrossing) {
      character.pos.y = 0;
      character.vel.y = 0;
      if (factor < 1) {
        const beforeScale = seamMoveScale(previous);
        const afterScale = seamMoveScale(character.pos);
        const velocityScale = beforeScale > 0 ? Math.min(1, afterScale / beforeScale) : 1;
        character.vel.x *= velocityScale;
        character.vel.z *= velocityScale;
      }
      character._bloomMoveSlowAt = world._t || 0;
    }
    if (factor > 1 && character.vel.y < -12) character.vel.y = -12;
    character.grounded = planarFloorCrossing;
    character._camSnap = true;
    character._bloomRecursionLevel = (character._bloomRecursionLevel || 0) + (factor > 1 ? 1 : -1);
    character.path = null;
    character.pathIdx = 0;
    character.mesh?.position.copy(character.pos);
    syncRecursivePlayerCamera(character, up, eyeHeight);
    world._recursivePulse = 1;
  };
  world.postProjectileMove = (projectile, previous) => {
    if (!projectile?.pos || !previous) return true;
    // Keep every live shot inside the canonical half-open shell. Unlike a
    // character, a shot can originate beyond a seam because the muzzle is in
    // front of its owner, so relying only on a previous/current sign change is
    // insufficient. The tiny deadband prevents floating-point ping-pong.
    const factor = canonicalFactor(projectile.pos);
    if (factor === 1) return 1;
    projectile._bloomRecursionCrossings = (projectile._bloomRecursionCrossings || 0) + 1;
    const maxCrossings = projectile.weapon?.maxRecursiveCrossings ??
      world.recursivePortal.maxProjectileCrossings;
    if (projectile._bloomRecursionCrossings > maxCrossings) {
      projectile.life = 0;
      return false;
    }
    // Piercing is scoped to one topological pass through the arena. Once the
    // shot crosses a seam it has entered the next recursive copy, so a player
    // it already pierced is a valid target again there. This lets Hyperstrike
    // loop through Bloom and damage the same canonical player once per layer.
    projectile.pierced?.clear();
    projectile.onRecursionCrossing?.(projectile._bloomRecursionCrossings, factor);
    projectile.pos.multiplyScalar(factor);
    projectile._bloomRecursionLevel = (projectile._bloomRecursionLevel || 0) + (factor > 1 ? 1 : -1);
    return factor;
  };
  // Multiplayer clients render remote shots as lightweight tracers rather
  // than authoritative projectiles. Move those presentation objects through
  // the same quotient-space chart so they continue through the inner/outer
  // seam instead of drawing a straight Euclidean line through the recursion.
  world.postVisualProjectileMove = visual => {
    if (!visual?.pos || !visual?.vel) return true;
    const factor = canonicalFactor(visual.pos);
    if (factor === 1) return 1;
    visual._bloomRecursionCrossings = (visual._bloomRecursionCrossings || 0) + 1;
    const maxCrossings = visual.weapon?.maxRecursiveCrossings ??
      world.recursivePortal.maxProjectileCrossings;
    if (visual._bloomRecursionCrossings > maxCrossings) {
      return false;
    }
    visual.onRecursionCrossing?.(visual._bloomRecursionCrossings, factor);
    visual.pos.multiplyScalar(factor);
    return factor;
  };
  // A normal half-metre projectile step grows to 2.57m when it crosses the
  // inward seam. Refine only the final half-metre before that boundary so the
  // transformed collision segment remains <= 0.5m without taxing every shot.
  world.projectileStepDistance = projectile =>
    recursiveNorm(projectile.pos) <= PORTAL_HALF + 0.51
      ? 0.5 * INNER_SCALE
      : 0.5;
  world.prepareProjectile = projectile => {
    if (!projectile?.pos || !projectile?.vel) return false;
    // At most one correction is expected (muzzles are only ~1m long), but the
    // bounded loop also makes split projectiles safe if a future weapon emits
    // them farther from its owner. Spawn normalization is not travel, so it
    // does not consume one of the projectile's visible seam crossings.
    for (let i = 0; i < 2; i++) {
      const factor = canonicalFactor(projectile.pos);
      if (factor === 1) return true;
      projectile.pos.multiplyScalar(factor);
      projectile._bloomRecursionLevel = (projectile._bloomRecursionLevel || 0) + (factor > 1 ? 1 : -1);
    }
    return canonicalFactor(projectile.pos) === 1;
  };
  world.prepareVisualProjectile = visual => {
    if (!visual?.pos || !visual?.vel) return false;
    for (let i = 0; i < 2; i++) {
      const factor = canonicalFactor(visual.pos);
      if (factor === 1) return true;
      visual.pos.multiplyScalar(factor);
    }
    return canonicalFactor(visual.pos) === 1;
  };
  world.anim.push(dt => {
    world._recursivePulse = Math.max(0, (world._recursivePulse || 0) - dt * 2.8);
  });

  world.dispose = () => {
    const disposed = new Set();
    const disposeOnce = resource => {
      if (!resource || disposed.has(resource)) return;
      disposed.add(resource);
      resource.dispose?.();
    };
    // Actor copies borrow the canonical character/weapon resources. Detach
    // them before disposing map-owned roots so leaving Bloom cannot invalidate
    // the globally shared blaster materials or another character's model.
    mirrorRoot.clear();
    for (const root of bloomOwnedRoots) {
      if (root === mirrorRoot) continue;
      root.traverse(obj => {
        disposeOnce(obj.geometry);
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const material of materials) {
          if (!material) continue;
          for (const value of Object.values(material)) {
            if (value?.isTexture) disposeOnce(value);
          }
          disposeOnce(material);
        }
      });
    }
    scene.remove(mirrorRoot);
    actorMirrors.clear();
    projectileMirrors.clear();
    tracerMirrors.clear();
    effectMirrors.clear();
    damageMarkerMirrors.clear();
    pickupMirrors.clear();
    bloomOwnedRoots = [];
  };

  // Floating circuit sparks are part of the direction-only sky field. Like
  // the dome and eyes, they stay camera-relative so a chart rebase cannot
  // slide the atmosphere past the arena.
  {
    const rnd = seededRandom(0xb100f11);
    const count = 280;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const palette = [new THREE.Color(0x79ff16), new THREE.Color(0xffe61b), new THREE.Color(0xff3d12)];
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (rnd() - 0.5) * 100;
      positions[i * 3 + 1] = 2 + rnd() * 54;
      positions[i * 3 + 2] = (rnd() - 0.5) * 100;
      const c = palette[Math.floor(rnd() * palette.length)];
      colors.set([c.r, c.g, c.b], i * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const sparks = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        size: 0.18,
        vertexColors: true,
        transparent: true,
        opacity: 0.72,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    skySparks = sparks;
    scene.add(sparks);
    world.anim.push((dt, t) => {
      sparks.rotation.y = t * 0.018;
      sparks.userData.floatY = Math.sin(t * 0.16) * 1.8;
    });
  }

  const spawns = [
    V(-24, 0.1, -24), V(24, 0.1, 24), V(-24, 0.1, 24), V(24, 0.1, -24),
    V(0, 0.1, -27), V(0, 0.1, 27), V(-27, 0.1, 0), V(27, 0.1, 0),
  ];
  world.spawns.ffa = spawns;
  world.spawns.blue = [spawns[0], spawns[2], spawns[4], spawns[6]];
  world.spawns.red = [spawns[1], spawns[3], spawns[5], spawns[7]];

  pk(world, 'gold', 0, 4.2, 24);
  pk(world, 'silver', 0, 4.2, -24);
  pk(world, 'shield', 24, 4.2, 0);
  pk(world, 'speed', -24, 4.2, 0);
  pk(world, 'star', -31, 0.2, 31, { hidden: true });
  pk(world, 'star', 31, 0.2, -31, { hidden: true });
  pk(world, 'star', 14, 5.8, 14, { hidden: true });
  pk(world, 'star', -14, 5.8, -14, { hidden: true });
  pk(world, 'weapon', -18, 0.2, -27, { weapon: 'scatter' });
  pk(world, 'weapon', 18, 0.2, 27, { weapon: 'pulsar' });
  pk(world, 'weapon', 27, 0.2, -18, { weapon: 'loophole' });
  pk(world, 'weapon', -27, 0.2, 18, { weapon: 'parasite' });
  pk(world, 'weapon', 5, 4.2, 27, { weapon: 'hyper' });
  pk(world, 'weapon', -5, 4.2, -27, { weapon: 'whomper' });
  pk(world, 'ammo', -13, 0.2, -27, { weapon: 'scatter' });
  pk(world, 'ammo', 13, 0.2, 27, { weapon: 'pulsar' });
  pk(world, 'ammo', 27, 0.2, -13, { weapon: 'loophole' });
  pk(world, 'ammo', -27, 0.2, 13, { weapon: 'parasite' });
  pk(world, 'ammo', -5, 4.2, 26, { weapon: 'hyper' });
  pk(world, 'ammo', 5, 4.2, -26, { weapon: 'whomper' });
  pk(world, 'health', -10, 0.2, -10);
  pk(world, 'health', 10, 0.2, 10);
  pk(world, 'health', -10, 0.2, 10);
  pk(world, 'health', 10, 0.2, -10);

  for (const x of [-28, -14, 0, 14, 28]) {
    for (const z of [-28, -14, 0, 14, 28]) {
      if (Math.abs(x) < 9 && Math.abs(z) < 9) continue;
      if (Math.abs(Math.abs(x) - 14) < 1 && Math.abs(Math.abs(z) - 14) < 1) continue;
      wp(world, x, 0, z);
    }
  }
  for (const [x, y, z] of [
    [0, 0, 0],
    [0, 2, 15], [0, 4, 21], [0, 4, 27],
    [0, 2, -15], [0, 4, -21], [0, 4, -27],
    [15, 2, 0], [21, 4, 0], [27, 4, 0],
    [-15, 2, 0], [-21, 4, 0], [-27, 4, 0],
  ]) wp(world, x, y, z);

  mergeStatic(scene, world);
  bloomOwnedRoots = scene.children.filter(child => !sceneRootsBeforeBuild.has(child));
  return world;
}

/* ============== THE LOBBY — walk-in map select, like the original ==============
   A dusk courtyard: grass strip, fountain, and five glowing gates. Walk into
   a gate to enter that arena; step on the mode pad to toggle FFA/TDM. */

// Flat text sign mounted on a wall (canvas-textured plane, fixed yaw —
// sprites clipped through the walls). Returns a redraw(text) function.
function makeSign(scene, x, y, z, w, color, text, yaw = 0, doubleFaced = false) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const draw = (t) => {
    const g = c.getContext('2d');
    g.clearRect(0, 0, 512, 128);
    g.fillStyle = 'rgba(8,10,28,.92)';
    g.beginPath(); g.roundRect(6, 10, 500, 108, 18); g.fill();
    g.lineWidth = 6; g.strokeStyle = color; g.stroke();
    let size = 52;
    g.font = `bold ${size}px "Arial Black", Arial`;
    const tw = g.measureText(t).width;
    if (tw > 460) {
      size = Math.floor(size * 460 / tw);
      g.font = `bold ${size}px "Arial Black", Arial`;
    }
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = color;
    g.fillText(t, 256, 68);
    tex.needsUpdate = true;
  };
  draw(text);
  const makeFace = () => new THREE.Mesh(new THREE.PlaneGeometry(w, w / 4),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
  const m = makeFace();
  const nX = Math.sin(yaw);
  const nZ = Math.cos(yaw);
  const faceOffset = doubleFaced ? 0.015 : 0;
  m.position.set(x, y, z);
  m.position.x += nX * faceOffset;
  m.position.z += nZ * faceOffset;
  m.rotation.y = yaw;
  scene.add(m);
  if (doubleFaced) {
    const back = makeFace();
    back.position.set(x - nX * faceOffset, y, z - nZ * faceOffset);
    back.rotation.y = yaw + Math.PI;
    scene.add(back);
  }
  return draw;
}

const ATRIUM_CONTROLS_REPO_URL = 'https://github.com/c0rv0s/nerf';
const ATRIUM_CONTROLS_RICKROLL_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

// Double-sided CONTROLS plaque. Front links to the repo; the rarely-seen back
// face rickrolls anyone curious enough to shoot it.
function addAtriumControlsSign(scene, world, x, y, z, yaw) {
  const size = 7;
  const faceOffset = 0.02;
  const nX = Math.sin(yaw);
  const nZ = Math.cos(yaw);

  const paintFace = (title, lines, accentLast = false) => {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 512;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(8,10,28,.92)';
    g.beginPath();
    g.roundRect(8, 8, 496, 496, 22);
    g.fill();
    g.lineWidth = 6;
    g.strokeStyle = '#ffd23c';
    g.stroke();
    g.textAlign = 'center';
    g.fillStyle = '#ffd23c';
    g.font = 'bold 44px "Arial Black", Arial';
    g.fillText(title, 256, 72);
    const lineH = lines.length > 9 ? 36 : 42;
    lines.forEach((entry, i) => {
      const text = typeof entry === 'string' ? entry : entry.text;
      const color = typeof entry === 'string'
        ? (accentLast && i === lines.length - 1 ? '#ffd23c' : '#dde2ff')
        : (entry.color || '#dde2ff');
      const font = typeof entry === 'string'
        ? (accentLast && i === lines.length - 1 ? 'bold 24px Arial' : 'bold 27px Arial')
        : (entry.font || 'bold 27px Arial');
      g.font = font;
      g.fillStyle = color;
      g.fillText(text, 256, 120 + i * lineH);
    });
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true }),
    );
  };

  const front = paintFace('CONTROLS', [
    'WASD — move',
    'Mouse — aim + shoot',
    'Space — jump / swim up',
    '1–9 / wheel — weapons',
    'Tab — scoreboard',
    'F — fullscreen',
    'Esc — pause',
    'Shift — dive / map ability',
    'Walk into a gate to play!',
    "I'm open source — shoot me to view",
  ], true);
  front.position.set(x + nX * faceOffset, y, z + nZ * faceOffset);
  front.rotation.y = yaw;
  scene.add(front);

  const back = paintFace('BACKSIDE', [
    { text: 'You found the backside.', font: 'bold 28px Arial', color: '#ffd23c' },
    { text: '', font: 'bold 20px Arial', color: '#dde2ff' },
    { text: 'Not many manage to do it.', font: 'bold 26px Arial', color: '#dde2ff' },
    { text: '', font: 'bold 20px Arial', color: '#dde2ff' },
    { text: 'I wonder what happens', font: 'bold 26px Arial', color: '#dde2ff' },
    { text: 'if you shoot me...', font: 'bold 26px Arial', color: '#ffd23c' },
  ]);
  back.position.set(x - nX * faceOffset, y, z - nZ * faceOffset);
  back.rotation.y = yaw + Math.PI;
  scene.add(back);

  addBox(scene, world, x, 0.45, z, 0.35, 0.9, 0.35, 0x3a3452);

  const registerUrlFace = (mesh, faceYaw, url, toast) => {
    const normal = V(0, 0, 1).applyAxisAngle(V(0, 1, 0), faceYaw).normalize();
    const right = V(1, 0, 0).applyAxisAngle(V(0, 1, 0), faceYaw).normalize();
    const target = {
      id: `url-sign-${world.scoreTargets.length}`,
      kind: 'url-sign',
      shape: 'plane',
      url,
      toast,
      pos: mesh.position.clone(),
      normal,
      right,
      up: V(0, 1, 0),
      halfWidth: size / 2,
      halfHeight: size / 2,
      cooldownDuration: 2.5,
      cooldown: 0,
      active: true,
      receivesSplash: false,
      mesh,
      setCooldown(seconds) {
        this.cooldown = Math.max(0, Math.min(this.cooldownDuration, Number(seconds) || 0));
        this.active = this.cooldown <= 0;
        const brightness = this.active ? 1
          : this.cooldown > 0.8 ? 0.35 : 0.35 + 0.65 * (1 - this.cooldown / 0.8);
        this.mesh.material.color.setRGB(brightness, brightness, brightness);
      },
    };
    world.scoreTargets.push(target);
    world.anim.push((dt) => {
      if (target.cooldown <= 0) return;
      target.setCooldown(target.cooldown - dt);
    });
  };

  registerUrlFace(front, yaw, ATRIUM_CONTROLS_REPO_URL, 'OPEN SOURCE — GITHUB');
  registerUrlFace(back, yaw + Math.PI, ATRIUM_CONTROLS_RICKROLL_URL, 'NEVER GONNA GIVE YOU UP');
}

// The original Arena Blast atrium treated every entrance like an attraction:
// huge, irregular wordmarks floated over the storefronts instead of sharing a
// single UI-panel template. Keep utility signs on makeSign(), but give arena
// gates their own arcade marquee with a chunky drop-shadow and map motif.
function addAtriumMarquee(scene, id, text, color, x, y, z, yaw, width = 15.5) {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 384;
  const g = c.getContext('2d');
  const ink = '#' + color.toString(16).padStart(6, '0');
  const accent = new THREE.Color(color).offsetHSL(0.08, 0.12, 0.18).getStyle();
  const dark = new THREE.Color(color).offsetHSL(-0.02, 0.04, -0.3).getStyle();

  // Each attraction gets a genuinely different silhouette, not one plaque
  // with a swapped icon. All keep a broad, quiet center for distant legibility.
  g.beginPath();
  if (id === 'fortress') {
    g.moveTo(74, 318); g.lineTo(74, 104); g.lineTo(126, 104); g.lineTo(126, 58);
    g.lineTo(204, 58); g.lineTo(204, 104); g.lineTo(820, 104); g.lineTo(820, 58);
    g.lineTo(898, 58); g.lineTo(898, 104); g.lineTo(950, 104); g.lineTo(950, 318);
  } else if (id === 'asteroids') {
    g.ellipse(512, 192, 448, 132, -0.045, 0, Math.PI * 2);
  } else if (id === 'sanctum') {
    g.moveTo(150, 42); g.lineTo(874, 42); g.lineTo(970, 138); g.lineTo(970, 246);
    g.lineTo(874, 342); g.lineTo(150, 342); g.lineTo(54, 246); g.lineTo(54, 138);
  } else if (id === 'canopy') {
    g.moveTo(75, 265); g.bezierCurveTo(25, 180, 92, 105, 190, 112);
    g.bezierCurveTo(240, 35, 350, 60, 390, 105); g.bezierCurveTo(480, 18, 615, 48, 646, 108);
    g.bezierCurveTo(755, 48, 930, 90, 944, 190); g.bezierCurveTo(955, 282, 824, 326, 718, 290);
    g.bezierCurveTo(604, 350, 460, 318, 406, 286); g.bezierCurveTo(290, 350, 126, 328, 75, 265);
  } else if (id === 'city') {
    g.moveTo(62, 320); g.lineTo(62, 132); g.lineTo(145, 132); g.lineTo(145, 74);
    g.lineTo(230, 74); g.lineTo(230, 118); g.lineTo(324, 118); g.lineTo(324, 46);
    g.lineTo(418, 46); g.lineTo(418, 104); g.lineTo(962, 104); g.lineTo(962, 320);
  } else if (id === 'arena') {
    g.moveTo(48, 192); g.lineTo(176, 48); g.lineTo(858, 48); g.lineTo(976, 192);
    g.lineTo(858, 336); g.lineTo(176, 336);
  } else if (id === 'tidebreaker') {
    // A breaking-wave profile: the tall curl at the left rolls into a long,
    // uneven swell instead of reusing the Labyrinth's octagonal plaque.
    g.moveTo(42, 278);
    g.bezierCurveTo(84, 252, 78, 174, 126, 126);
    g.bezierCurveTo(176, 74, 246, 58, 304, 86);
    g.bezierCurveTo(264, 88, 230, 115, 219, 152);
    g.bezierCurveTo(258, 124, 304, 116, 358, 116);
    g.lineTo(872, 92);
    g.bezierCurveTo(914, 110, 950, 142, 976, 184);
    g.bezierCurveTo(947, 204, 936, 244, 942, 278);
    g.bezierCurveTo(874, 325, 790, 330, 706, 309);
    g.bezierCurveTo(606, 285, 532, 344, 424, 326);
    g.bezierCurveTo(332, 311, 282, 340, 196, 330);
    g.bezierCurveTo(120, 321, 70, 304, 42, 278);
  } else if (id === 'multiplayer') {
    g.moveTo(58, 122); g.lineTo(156, 122); g.lineTo(218, 54); g.lineTo(806, 54);
    g.lineTo(868, 122); g.lineTo(966, 122); g.lineTo(906, 192); g.lineTo(966, 262);
    g.lineTo(868, 262); g.lineTo(806, 330); g.lineTo(218, 330); g.lineTo(156, 262); g.lineTo(58, 262); g.lineTo(118, 192);
  } else if (id === 'solar') {
    g.moveTo(92, 192); g.lineTo(154, 148); g.lineTo(128, 82); g.lineTo(210, 102);
    g.lineTo(258, 38); g.lineTo(304, 94); g.lineTo(864, 74); g.lineTo(936, 138);
    g.lineTo(910, 192); g.lineTo(936, 246); g.lineTo(864, 310); g.lineTo(304, 290);
    g.lineTo(258, 346); g.lineTo(210, 282); g.lineTo(128, 302); g.lineTo(154, 236);
  } else { // Hall of Fame: a medal/crest rather than another storefront banner.
    g.moveTo(138, 64); g.lineTo(886, 64); g.lineTo(950, 192); g.lineTo(886, 320);
    g.lineTo(650, 320); g.lineTo(610, 354); g.lineTo(512, 318); g.lineTo(414, 354);
    g.lineTo(374, 320); g.lineTo(138, 320); g.lineTo(74, 192);
  }
  g.closePath();
  g.fillStyle = 'rgba(5,7,18,.97)'; g.fill();
  g.lineJoin = 'round';
  g.lineWidth = 30; g.strokeStyle = 'rgba(0,0,0,.68)'; g.stroke();
  g.lineWidth = 15; g.strokeStyle = dark; g.stroke();
  g.lineWidth = 7; g.strokeStyle = ink; g.stroke();

  // The interior detailing also follows the attraction instead of repeating
  // the same two light rails everywhere.
  g.globalAlpha = 0.55; g.strokeStyle = accent; g.fillStyle = accent; g.lineWidth = 5;
  if (id === 'asteroids') {
    g.beginPath(); g.ellipse(520, 192, 380, 86, -0.12, 0, Math.PI * 2); g.stroke();
    for (const [sx, sy, sr] of [[245, 115, 6], [770, 245, 9], [850, 145, 5]]) { g.beginPath(); g.arc(sx, sy, sr, 0, Math.PI * 2); g.fill(); }
  } else if (id === 'sanctum') {
    for (const ox of [105, 855]) { g.strokeRect(ox, 115, 64, 154); g.strokeRect(ox + 18, 139, 46, 52); }
  } else if (id === 'canopy') {
    g.beginPath(); g.moveTo(90, 280); g.bezierCurveTo(230, 240, 192, 98, 356, 83); g.stroke();
    g.beginPath(); g.moveTo(930, 270); g.bezierCurveTo(790, 240, 840, 100, 690, 84); g.stroke();
  } else if (id === 'city') {
    for (let bx = 90; bx < 930; bx += 46) for (const by of [145, 275]) g.fillRect(bx, by, 13, 9);
  } else if (id === 'arena') {
    for (const by of [112, 272]) { g.beginPath(); g.moveTo(170, by); g.lineTo(854, by); g.stroke(); }
  } else if (id === 'tidebreaker') {
    for (const by of [118, 272]) { g.beginPath(); g.moveTo(150, by); g.lineTo(874, by); g.stroke(); }
    g.beginPath(); g.moveTo(112, 238); g.bezierCurveTo(228, 152, 324, 284, 438, 196);
    g.bezierCurveTo(558, 108, 674, 278, 906, 174); g.stroke();
  } else if (id === 'solar') {
    g.beginPath(); g.arc(512, 192, 114, 0, Math.PI * 2); g.stroke();
    for (let i = 0; i < 16; i++) {
      const a = i * Math.PI / 8;
      g.beginPath(); g.moveTo(512 + Math.cos(a) * 126, 192 + Math.sin(a) * 126);
      g.lineTo(512 + Math.cos(a) * 156, 192 + Math.sin(a) * 156); g.stroke();
    }
  } else if (id === 'multiplayer') {
    for (let bx = 190; bx <= 834; bx += 54) { g.beginPath(); g.arc(bx, 92, 5, 0, Math.PI * 2); g.fill(); }
  } else if (id === 'hall') {
    for (let bx = 185; bx <= 839; bx += 48) { g.beginPath(); g.arc(bx, 100, 5, 0, Math.PI * 2); g.fill(); }
  } else {
    g.fillRect(95, 286, 834, 14);
  }
  g.globalAlpha = 1;

  // A tiny arena-specific glyph keeps the eight marquees from feeling cloned.
  g.save();
  g.strokeStyle = ink; g.fillStyle = ink; g.lineWidth = 10;
  if (id === 'fortress') {
    for (const bx of [92, 126, 160]) g.fillRect(bx, 150, 23, 24);
    g.fillRect(92, 170, 91, 58); g.clearRect(125, 194, 25, 34);
  } else if (id === 'asteroids') {
    g.beginPath(); g.ellipse(137, 192, 62, 25, -0.3, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(137, 192, 24, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(189, 166, 9, 0, Math.PI * 2); g.fill();
  } else if (id === 'sanctum') {
    g.strokeRect(91, 148, 92, 88); g.beginPath();
    g.moveTo(111, 216); g.lineTo(111, 170); g.lineTo(160, 170);
    g.lineTo(160, 194); g.lineTo(134, 194); g.lineTo(134, 225); g.stroke();
  } else if (id === 'canopy') {
    g.beginPath(); g.ellipse(120, 177, 22, 52, -0.7, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(160, 204, 20, 47, 0.75, 0, Math.PI * 2); g.fill();
    g.strokeStyle = accent; g.beginPath(); g.moveTo(102, 224); g.lineTo(179, 158); g.stroke();
  } else if (id === 'city') {
    g.fillRect(91, 174, 26, 57); g.fillRect(124, 143, 32, 88); g.fillRect(163, 164, 24, 67);
    g.fillStyle = accent; for (const wx of [100, 135, 146, 172]) for (const wy of [181, 202]) g.fillRect(wx, wy, 6, 8);
  } else if (id === 'arena') {
    for (let i = 0; i < 3; i++) { g.beginPath(); g.moveTo(87 + i * 17, 155); g.lineTo(139 + i * 17, 192); g.lineTo(87 + i * 17, 229); g.stroke(); }
  } else if (id === 'tidebreaker') {
    g.beginPath(); g.arc(137, 192, 45, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.moveTo(91, 201); g.bezierCurveTo(111, 166, 130, 224, 151, 183);
    g.bezierCurveTo(165, 158, 178, 194, 190, 178); g.stroke();
  } else if (id === 'solar') {
    g.beginPath(); g.arc(137, 192, 31, 0, Math.PI * 2); g.fill();
    for (let i = 0; i < 12; i++) {
      g.save(); g.translate(137, 192); g.rotate(i * Math.PI / 6); g.fillRect(43, -5, 28, 10); g.restore();
    }
  } else if (id === 'multiplayer') {
    g.beginPath(); g.arc(119, 176, 26, 0, Math.PI * 2); g.arc(163, 176, 26, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(119, 229, 38, Math.PI, 0); g.arc(163, 229, 38, Math.PI, 0); g.fill();
  } else { // Hall of Fame
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 5;
      const r = i % 2 ? 22 : 48;
      g.lineTo(137 + Math.cos(a) * r, 192 + Math.sin(a) * r);
    }
    g.closePath(); g.fill();
  }
  g.restore();

  // Solid pale faces stay readable against every gate color and at oblique
  // angles. One dark keyline replaces the previous stack of competing outlines.
  let fontSize = 104;
  g.font = `900 ${fontSize}px "Arial Black", Impact, sans-serif`;
  while (g.measureText(text).width > 720 && fontSize > 52) {
    fontSize -= 2;
    g.font = `900 ${fontSize}px "Arial Black", Impact, sans-serif`;
  }
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = 22; g.strokeStyle = 'rgba(0,0,0,.98)'; g.strokeText(text, 574, 198);
  g.lineWidth = 8; g.strokeStyle = ink; g.strokeText(text, 574, 198);
  g.fillStyle = '#fffaf0'; g.fillText(text, 574, 198);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  const material = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, alphaTest: 0.025, depthWrite: false,
  });
  const marquee = new THREE.Mesh(new THREE.PlaneGeometry(width, width * 0.375), material);
  marquee.position.set(x, y, z);
  marquee.rotation.y = yaw;
  marquee.renderOrder = 3;
  marquee.name = `atrium-marquee-${id}`;
  scene.add(marquee);
  return marquee;
}

function addAtriumHeroSign(scene, x, y, z) {
  const c = document.createElement('canvas');
  c.width = 1536; c.height = 512;
  const g = c.getContext('2d');
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(108, 92); g.lineTo(1228, 92); g.lineTo(1428, 256);
  g.lineTo(1228, 420); g.lineTo(108, 420); g.lineTo(250, 256); g.closePath();
  g.fillStyle = 'rgba(7,8,20,.98)'; g.fill();
  g.lineWidth = 38; g.strokeStyle = 'rgba(0,0,0,.7)'; g.stroke();
  g.lineWidth = 18; g.strokeStyle = '#ff4d25'; g.stroke();
  g.lineWidth = 7; g.strokeStyle = '#ffbd3d'; g.stroke();

  // Speed fins and a target burst make this the atrium's unmistakable anchor.
  g.fillStyle = '#ff4d25';
  for (let i = 0; i < 3; i++) {
    const yy = 176 + i * 48;
    g.beginPath(); g.moveTo(32, yy); g.lineTo(232, yy - 24); g.lineTo(198, yy + 20); g.closePath(); g.fill();
  }
  g.save(); g.translate(1328, 256);
  for (let i = 0; i < 16; i++) { g.rotate(Math.PI / 8); g.fillRect(62, -5, 82, 10); }
  for (const [r, fill] of [[70, '#fffaf0'], [51, '#ff4d25'], [31, '#ffbd3d'], [14, '#172034']]) {
    g.fillStyle = fill; g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill();
  }
  g.restore();

  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = '900 82px "Arial Black", Impact, sans-serif';
  g.lineWidth = 18; g.strokeStyle = '#000'; g.strokeText('NERF ARENA', 748, 205);
  g.fillStyle = '#ff5a2f'; g.fillText('NERF ARENA', 748, 205);
  g.font = '900 118px "Arial Black", Impact, sans-serif';
  g.lineWidth = 22; g.strokeStyle = '#000'; g.strokeText('BLAST REVIVAL', 748, 310);
  g.lineWidth = 7; g.strokeStyle = '#ff5a2f'; g.strokeText('BLAST REVIVAL', 748, 310);
  g.fillStyle = '#fff8e7'; g.fillText('BLAST REVIVAL', 748, 310);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 16;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(29, 29 / 3),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.025, depthWrite: false }));
  mesh.position.set(x, y, z); mesh.renderOrder = 3; mesh.name = 'atrium-hero-sign';
  scene.add(mesh);
}

const GATE_FRAME_INDEX = {
  arena: 0, fortress: 1, oldwest: 1, asteroids: 2, canopy: 3, city: 4, sanctum: 5,
};
const gateFrameCache = {};
function gateFrameTex(index) {
  if (gateFrameCache[index]) return gateFrameCache[index];
  const atlas = AI_TEX['atrium-gate-frame-atlas']?.map?.image;
  if (!atlas) return null;
  const cols = 3;
  const rows = 2;
  const tileW = Math.floor(atlas.width / cols);
  const tileH = Math.floor(atlas.height / rows);
  const col = index % cols;
  const row = Math.floor(index / cols);
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.drawImage(atlas, col * tileW, row * tileH, tileW, tileH, 0, 0, 512, 512);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  gateFrameCache[index] = t;
  return t;
}

function portalMaterial(color) {
  const base = new THREE.Color(color);
  const accent = base.clone().offsetHSL(0.12, 0.08, 0.16);
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: base },
      uAccent: { value: accent },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision mediump float;
      varying vec2 vUv;
      uniform float uTime;
      uniform vec3 uColor;
      uniform vec3 uAccent;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }

      float puff(vec2 uv, vec2 c, vec2 r) {
        vec2 d = (uv - c) / r;
        return exp(-dot(d, d));
      }

      void main() {
        vec2 uv = vUv;
        vec3 dark = vec3(0.08, 0.08, 0.18);
        vec3 col = mix(dark, uColor, smoothstep(0.0, 0.85, 1.0 - uv.y));
        col = mix(col, uAccent, smoothstep(0.65, 1.0, 1.0 - uv.y) * 0.65);

        float mist = 0.0;
        for (int i = 0; i < 16; i++) {
          float fi = float(i);
          vec2 seed = vec2(fi * 17.23, fi * 9.41);
          vec2 c = vec2(
            fract(hash(seed) + sin(uTime * 0.19 + fi) * 0.08),
            fract(hash(seed + 3.7) + uTime * (0.045 + hash(seed + 9.1) * 0.045))
          );
          vec2 r = vec2(0.14 + hash(seed + 1.0) * 0.18, 0.055 + hash(seed + 2.0) * 0.12);
          mist += puff(uv, c, r) * (0.08 + hash(seed + 5.0) * 0.18);
        }

        vec2 p = uv - 0.5;
        float angle = atan(p.y, p.x) + sin(uTime * 0.45) * 0.18;
        float radius = length(p);
        float bands = 0.0;
        bands += smoothstep(0.93, 1.0, sin((uv.y + sin(uv.x * 18.0 + uTime * 2.1) * 0.025 + uTime * 0.16) * 26.0));
        bands += smoothstep(0.94, 1.0, sin(angle * 5.0 + radius * 24.0 - uTime * 1.35));

        float edge = smoothstep(0.5, 0.0, abs(uv.x - 0.5)) * smoothstep(0.0, 0.16, uv.y) * smoothstep(1.0, 0.84, uv.y);
        col += uAccent * mist;
        col += mix(vec3(1.0), uAccent, 0.55) * bands * edge * 0.32;
        col += vec3(1.0) * pow(1.0 - radius, 3.0) * 0.08;

        gl_FragColor = vec4(col, 1.0);
      }
    `,
    depthWrite: true,
    // ShaderMaterial does not inherit the wall-decoration depth policy. Give
    // portal faces the same deterministic foreground lane so a backing wall
    // can never intermittently win the depth test while the player moves.
    ...DECOR_DEPTH_BIAS,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: false,
  });
}

function addMagicPortal(scene, world, x, y, z, w, h, color, yaw = 0, parent = scene) {
  const material = portalMaterial(color);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(
    w + PORTAL_FRAME_OVERLAP * 2,
    h + PORTAL_FRAME_OVERLAP,
  ),
    material);
  const nX = Math.sin(yaw);
  const nZ = Math.cos(yaw);
  m.position.set(
    x + nX * PORTAL_SURFACE_EPS,
    y + PORTAL_FRAME_OVERLAP / 2,
    z + nZ * PORTAL_SURFACE_EPS,
  );
  m.rotation.y = yaw;
  m.renderOrder = 2;
  parent.add(m);
  world.anim.push((dt, t) => {
    material.uniforms.uTime.value = t;
  });
  return m;
}

function seededRandom(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
}

function softenCanvasHorizontalSeam(ctx, width, height, margin = 220) {
  const img = ctx.getImageData(0, 0, width, height);
  const src = new Uint8ClampedArray(img.data);
  const m = Math.min(margin, Math.floor(width / 2));
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < m; x++) {
      const weight = 1 - x / m;
      const li = row + x * 4;
      const ri = row + (width - 1 - x) * 4;
      for (let c = 0; c < 4; c++) {
        const avg = (src[li + c] + src[ri + c]) * 0.5;
        img.data[li + c] = src[li + c] * (1 - weight) + avg * weight;
        img.data[ri + c] = src[ri + c] * (1 - weight) + avg * weight;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

function addCanvasSkyDome(scene, draw, radius = 420) {
  const width = 2048;
  const height = 1024;
  const skyC = document.createElement('canvas');
  skyC.width = width;
  skyC.height = height;
  const sg = skyC.getContext('2d');
  draw(sg, width, height);
  softenCanvasHorizontalSeam(sg, width, height);

  const skyTex = new THREE.CanvasTexture(skyC);
  skyTex.colorSpace = THREE.SRGBColorSpace;
  skyTex.generateMipmaps = true;
  skyTex.minFilter = THREE.LinearMipmapLinearFilter;
  skyTex.magFilter = THREE.LinearFilter;

  const sky = new THREE.Mesh(new THREE.SphereGeometry(radius, 64, 32),
    new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false }));
  sky.frustumCulled = false;
  scene.add(sky);
  return sky;
}

function addDaytimeSkyDome(scene) {
  const rnd = seededRandom(0x5c0f4e57);
  addCanvasSkyDome(scene, (sg, width, height) => {
    const grad = sg.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, '#4f9ed8');
    grad.addColorStop(0.38, '#7fc5eb');
    grad.addColorStop(0.68, '#bfe7f4');
    grad.addColorStop(0.86, '#d8f0cf');
    grad.addColorStop(1, '#f5dfa3');
    sg.fillStyle = grad;
    sg.fillRect(0, 0, width, height);

    const sunX = width * 0.22;
    const sunY = height * 0.18;
    const halo = sg.createRadialGradient(sunX, sunY, 12, sunX, sunY, width * 0.34);
    halo.addColorStop(0, 'rgba(255,250,214,0.95)');
    halo.addColorStop(0.18, 'rgba(255,244,188,0.42)');
    halo.addColorStop(0.45, 'rgba(255,223,148,0.16)');
    halo.addColorStop(1, 'rgba(255,223,148,0)');
    sg.fillStyle = halo;
    sg.fillRect(0, 0, width, height);
    const sunDisc = sg.createRadialGradient(sunX - 6, sunY - 6, 3, sunX, sunY, 54);
    sunDisc.addColorStop(0, '#fffdf2');
    sunDisc.addColorStop(0.55, '#fff4a8');
    sunDisc.addColorStop(1, 'rgba(255,214,116,0)');
    sg.fillStyle = sunDisc;
    sg.beginPath();
    sg.arc(sunX, sunY, 58, 0, Math.PI * 2);
    sg.fill();

    const haze = sg.createRadialGradient(width * 0.52, height * 1.04, width * 0.05, width * 0.52, height * 1.04, width * 0.62);
    haze.addColorStop(0, 'rgba(255,235,178,0.34)');
    haze.addColorStop(0.5, 'rgba(255,255,255,0.12)');
    haze.addColorStop(1, 'rgba(255,255,255,0)');
    sg.fillStyle = haze;
    sg.fillRect(0, 0, width, height);

    sg.save();
    sg.globalCompositeOperation = 'screen';
    for (let i = 0; i < 42; i++) {
      const x = rnd() * width;
      const y = height * (0.08 + (rnd() ** 1.2) * 0.48);
      const rx = 80 + rnd() * 280;
      const ry = 18 + rnd() * 46;
      sg.save();
      sg.translate(x, y);
      sg.rotate((rnd() - 0.5) * 0.18);
      sg.scale(1, ry / rx);
      const cloud = sg.createRadialGradient(0, 0, 0, 0, 0, rx);
      cloud.addColorStop(0, `rgba(255,255,255,${0.16 + rnd() * 0.18})`);
      cloud.addColorStop(0.52, `rgba(255,255,255,${0.06 + rnd() * 0.1})`);
      cloud.addColorStop(1, 'rgba(255,255,255,0)');
      sg.fillStyle = cloud;
      sg.beginPath();
      sg.arc(0, 0, rx, 0, Math.PI * 2);
      sg.fill();
      sg.restore();
    }
    sg.restore();

    sg.save();
    sg.globalCompositeOperation = 'multiply';
    for (let i = 0; i < 12; i++) {
      const x = rnd() * width;
      const y = height * (0.18 + rnd() * 0.38);
      const rx = 130 + rnd() * 260;
      const ry = 18 + rnd() * 28;
      sg.save();
      sg.translate(x, y + ry * 0.38);
      sg.rotate((rnd() - 0.5) * 0.12);
      sg.scale(1, ry / rx);
      const shade = sg.createRadialGradient(0, 0, 0, 0, 0, rx);
      shade.addColorStop(0, 'rgba(84,128,170,0.045)');
      shade.addColorStop(1, 'rgba(84,128,170,0)');
      sg.fillStyle = shade;
      sg.beginPath();
      sg.arc(0, 0, rx, 0, Math.PI * 2);
      sg.fill();
      sg.restore();
    }
    sg.restore();
  });
}

function addStormCloudDome(scene) {
  const rnd = seededRandom(0x61a7c0de);
  const stormSky = addCanvasSkyDome(scene, (sg, width, height) => {
    const grad = sg.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, '#0a1018');
    grad.addColorStop(0.42, '#182333');
    grad.addColorStop(0.72, '#273343');
    grad.addColorStop(1, '#344038');
    sg.fillStyle = grad;
    sg.fillRect(0, 0, width, height);

    sg.save();
    sg.globalCompositeOperation = 'screen';
    for (let i = 0; i < 70; i++) {
      const x = rnd() * width;
      const y = height * (0.04 + rnd() * 0.48);
      const rx = 150 + rnd() * 360;
      const ry = 40 + rnd() * 90;
      sg.save();
      sg.translate(x, y);
      sg.rotate((rnd() - 0.5) * 0.16);
      sg.scale(1, ry / rx);
      const cloud = sg.createRadialGradient(0, 0, 0, 0, 0, rx);
      cloud.addColorStop(0, `rgba(120,142,160,${0.18 + rnd() * 0.16})`);
      cloud.addColorStop(0.62, `rgba(72,88,106,${0.08 + rnd() * 0.1})`);
      cloud.addColorStop(1, 'rgba(20,28,38,0)');
      sg.fillStyle = cloud;
      sg.beginPath();
      sg.arc(0, 0, rx, 0, Math.PI * 2);
      sg.fill();
      sg.restore();
    }
    sg.restore();

    sg.save();
    sg.globalCompositeOperation = 'multiply';
    for (let i = 0; i < 24; i++) {
      const x = rnd() * width;
      const y = height * (0.02 + rnd() * 0.5);
      const rx = 180 + rnd() * 420;
      const ry = 38 + rnd() * 84;
      sg.save();
      sg.translate(x, y);
      sg.rotate((rnd() - 0.5) * 0.1);
      sg.scale(1, ry / rx);
      const shade = sg.createRadialGradient(0, 0, 0, 0, 0, rx);
      shade.addColorStop(0, 'rgba(2,5,10,0.28)');
      shade.addColorStop(1, 'rgba(2,5,10,0)');
      sg.fillStyle = shade;
      sg.beginPath();
      sg.arc(0, 0, rx, 0, Math.PI * 2);
      sg.fill();
      sg.restore();
    }
    sg.restore();
  }, 418);
  stormSky.material.transparent = true;
  stormSky.material.opacity = 0;
  stormSky.material.depthWrite = false;
  return stormSky;
}

function createCanopyBirdFlock(scene) {
  const flock = new THREE.Group();
  flock.visible = false;
  scene.add(flock);

  const featherMaterial = new THREE.MeshStandardMaterial({
    color: 0x26382f,
    roughness: 0.9,
    flatShading: true,
    side: THREE.DoubleSide,
  });
  const bodyGeometry = new THREE.ConeGeometry(0.1, 0.56, 5);
  bodyGeometry.rotateX(Math.PI / 2);
  const leftWingGeometry = new THREE.BufferGeometry();
  leftWingGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0.12, -0.82, 0, -0.08, -0.14, 0, -0.22,
  ], 3));
  leftWingGeometry.computeVertexNormals();
  const rightWingGeometry = new THREE.BufferGeometry();
  rightWingGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, 0.12, 0.14, 0, -0.22, 0.82, 0, -0.08,
  ], 3));
  rightWingGeometry.computeVertexNormals();

  const birds = [];
  for (let i = 0; i < 11; i++) {
    const bird = new THREE.Group();
    const body = new THREE.Mesh(bodyGeometry, featherMaterial);
    const leftWing = new THREE.Mesh(leftWingGeometry, featherMaterial);
    const rightWing = new THREE.Mesh(rightWingGeometry, featherMaterial);
    bird.add(body, leftWing, rightWing);
    bird.scale.setScalar(0.72 + (i % 4) * 0.08);
    flock.add(bird);
    birds.push({
      bird, leftWing, rightWing,
      side: ((i * 1.73) % 5.8) - 2.9,
      behind: (i % 4) * 1.25 + Math.floor(i / 4) * 0.8,
      height: ((i * 2.1) % 2.8) - 1.1,
      phase: i * 0.83,
    });
  }

  return { flock, birds };
}

function addCanopyBirdFlocks(scene, world) {
  const { flock, birds } = createCanopyBirdFlock(scene);

  const crowns = [
    { x: -45, y: 38, z: -45 }, { x: 45, y: 38, z: -45 },
    { x: -45, y: 38, z: 45 }, { x: 45, y: 38, z: 45 },
    { x: 0, y: 45, z: 0 },
  ];
  let launches = 0;
  let nextLaunch = rand(34, 78);
  let flightTime = 0;
  let flightDuration = 0;
  let playerInCrown = false;
  let crownTriggerCooldown = 0;
  const direction = new THREE.Vector3();
  const origin = new THREE.Vector3();

  const launch = (scheduled = true) => {
    const crown = crowns[Math.floor(Math.random() * crowns.length)];
    let outwardX = crown.x;
    let outwardZ = crown.z;
    const outwardLength = Math.hypot(outwardX, outwardZ);
    if (outwardLength < 1) {
      const angle = rand(0, Math.PI * 2);
      outwardX = Math.sin(angle);
      outwardZ = Math.cos(angle);
    } else {
      outwardX /= outwardLength;
      outwardZ /= outwardLength;
    }
    const crownRadius = crown.x === 0 && crown.z === 0 ? 14.5 : 11.5;
    origin.set(
      crown.x - outwardX * crownRadius,
      crown.y - 0.5,
      crown.z - outwardZ * crownRadius,
    );
    direction.set(-outwardX, rand(0.12, 0.28), -outwardZ);
    direction.normalize();
    flock.position.copy(origin);
    flock.rotation.y = Math.atan2(direction.x, direction.z);
    flock.visible = true;
    flightTime = 0;
    flightDuration = rand(15, 19);
    if (scheduled) launches++;
  };

  world.anim.push((dt, t, characters = []) => {
    const raining = (world.storm?.mix || 0) > 0.01;
    crownTriggerCooldown = Math.max(0, crownTriggerCooldown - dt);
    const player = characters.find(ch => ch?.isPlayer && ch.alive);
    const insideCrown = !!player && crowns.some(crown => {
      const dx = player.pos.x - crown.x;
      const dy = player.pos.y + 1.5 - crown.y;
      const dz = player.pos.z - crown.z;
      const radius = crown.x === 0 && crown.z === 0 ? 15.2 : 12;
      return dx * dx + dy * dy + dz * dz < radius * radius;
    });
    if (insideCrown && !playerInCrown && !raining && crownTriggerCooldown <= 0) {
      launch(false);
      crownTriggerCooldown = 12;
    }
    playerInCrown = insideCrown;

    if (!flock.visible) {
      if (launches >= 2 || raining) return;
      nextLaunch -= dt;
      if (nextLaunch <= 0) launch();
      return;
    }

    flightTime += dt;
    if (flightTime >= flightDuration || raining) {
      flock.visible = false;
      nextLaunch = rand(75, 135);
      return;
    }

    const distance = flightTime * 12.5;
    flock.position.set(
      origin.x + direction.x * distance,
      origin.y + direction.y * distance + Math.sin(flightTime / flightDuration * Math.PI) * 5,
      origin.z + direction.z * distance,
    );
    const urgency = Math.min(1, flightTime * 1.5);
    for (const b of birds) {
      b.bird.position.set(
        b.side,
        b.height + Math.sin(t * 1.1 + b.phase) * 0.35,
        -b.behind * urgency,
      );
      const flap = Math.sin(t * 9.5 + b.phase) * 0.62;
      b.leftWing.rotation.z = flap;
      b.rightWing.rotation.z = -flap;
    }
  });
}

function addReefBirdFlocks(scene, world) {
  // Reuse Canopy's deliberately low-poly V formation. Reef launches it from
  // beyond one side of the ocean and lets it cross the whole playable view,
  // keeping the tropical sky alive without leaving permanent visual clutter.
  const { flock, birds } = createCanopyBirdFlock(scene);
  flock.name = 'sunken-reef-overhead-bird-flock';
  flock.scale.setScalar(1.25);

  const direction = new THREE.Vector3();
  const origin = new THREE.Vector3();
  let nextLaunch = rand(14, 30);
  let flightTime = 0;
  let flightDuration = 0;

  const launch = () => {
    const angle = rand(0, Math.PI * 2);
    direction.set(Math.cos(angle), rand(-0.015, 0.035), Math.sin(angle)).normalize();
    const sideX = -direction.z;
    const sideZ = direction.x;
    const lateralOffset = rand(-58, 58);
    origin.set(
      -direction.x * 170 + sideX * lateralOffset,
      rand(48, 60),
      -direction.z * 170 + sideZ * lateralOffset,
    );
    flock.position.copy(origin);
    flock.rotation.y = Math.atan2(direction.x, direction.z);
    flock.visible = true;
    flightTime = 0;
    flightDuration = rand(20, 24);
  };

  world.anim.push((dt, t) => {
    if (!flock.visible) {
      nextLaunch -= dt;
      if (nextLaunch <= 0) launch();
      return;
    }

    flightTime += dt;
    if (flightTime >= flightDuration) {
      flock.visible = false;
      nextLaunch = rand(55, 105);
      return;
    }

    const progress = flightTime / flightDuration;
    const distance = flightTime * 17;
    flock.position.set(
      origin.x + direction.x * distance,
      origin.y + direction.y * distance + Math.sin(progress * Math.PI) * 4.5,
      origin.z + direction.z * distance,
    );
    const formationSpread = Math.min(1, flightTime * 1.4);
    for (const b of birds) {
      b.bird.position.set(
        b.side,
        b.height + Math.sin(t * 1.05 + b.phase) * 0.3,
        -b.behind * formationSpread,
      );
      const flap = Math.sin(t * 9.5 + b.phase) * 0.62;
      b.leftWing.rotation.z = flap;
      b.rightWing.rotation.z = -flap;
    }
  });
}

function addCanopyStorm(scene, world) {
  const stormStart = rand(10, 270);
  const storm = {
    startAt: stormStart,
    endAt: stormStart + rand(60, 240),
    nextLightning: rand(3, 6),
    flashT: 0,
  };
  world.storm = storm;

  const baseBackground = scene.background?.clone?.() || new THREE.Color(0x8fcbe6);
  const baseFog = scene.fog ? {
    color: scene.fog.color.clone(),
    near: scene.fog.near,
    far: scene.fog.far,
  } : null;
  const stormBackground = new THREE.Color(0x111923);
  const stormFog = new THREE.Color(0x182b2b);
  const flashSky = new THREE.Color(0xdaf8ff);
  const flashFog = new THREE.Color(0xcff8ff);

  const cloudDome = addStormCloudDome(scene);

  // Viewer-centered rain: a fixed arena box + one shared slant made streaks
  // disappear when facing away from the volume or lining up with the wind.
  const rainCount = 1900;
  const rainPositions = new Float32Array(rainCount * 6);
  const rainOrigin = { x: 0, z: 0 };
  const rainHalfX = 40;
  const rainHalfZ = 40;
  const rainWindX = -0.42;
  const rainWindZ = 0.18;
  const rainLenY = 3.2;
  const rainLenScale = 1.65;
  const resetDrop = (i, y = rand(8, 44)) => {
    const j = i * 6;
    const x = rainOrigin.x + rand(-rainHalfX, rainHalfX);
    const z = rainOrigin.z + rand(-rainHalfZ, rainHalfZ);
    // Keep the prevailing wind, but jitter each streak so one camera yaw cannot
    // collapse the whole field to near-zero screen width.
    const slantX = (rainWindX + rand(-0.18, 0.18)) * rainLenScale;
    const slantZ = (rainWindZ + rand(-0.14, 0.14)) * rainLenScale;
    rainPositions[j] = x;
    rainPositions[j + 1] = y;
    rainPositions[j + 2] = z;
    rainPositions[j + 3] = x + slantX;
    rainPositions[j + 4] = y - rainLenY;
    rainPositions[j + 5] = z + slantZ;
  };
  for (let i = 0; i < rainCount; i++) resetDrop(i);
  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPositions, 3));
  rainGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 24, 0), 110);
  const rainMat = new THREE.LineBasicMaterial({
    color: 0xb4ddff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
  });
  const rain = new THREE.LineSegments(rainGeo, rainMat);
  rain.frustumCulled = false;
  rain.renderOrder = 3;
  scene.add(rain);

  const boltPoints = 11;
  const boltMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const boltGlowMat = new THREE.MeshBasicMaterial({
    color: 0x8fe8ff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  // LineBasicMaterial is only one pixel wide in WebGL, which made the old
  // lightning effectively disappear against the bright sky. Use a real tube
  // for the white-hot core plus a wider translucent tube for its glow.
  const emptyBoltGeo = () => new THREE.CylinderGeometry(0.01, 0.01, 0.01, 3);
  const bolt = new THREE.Mesh(emptyBoltGeo(), boltMat);
  bolt.frustumCulled = false;
  scene.add(bolt);
  const boltGlow = new THREE.Mesh(emptyBoltGeo(), boltGlowMat);
  boltGlow.frustumCulled = false;
  scene.add(boltGlow);

  const forkCount = 8;
  const forkPositions = new Float32Array(forkCount * 2 * 3);
  const forkGeo = new THREE.BufferGeometry();
  forkGeo.setAttribute('position', new THREE.BufferAttribute(forkPositions, 3));
  const forkMat = new THREE.LineBasicMaterial({
    color: 0xbff8ff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const forks = new THREE.LineSegments(forkGeo, forkMat);
  forks.frustumCulled = false;
  scene.add(forks);

  const flashLight = new THREE.PointLight(0xdff7ff, 0, 260);
  scene.add(flashLight);

  const strikeAt = (x, z, characters = []) => {
    const topY = 62;
    const hitY = 0.12;
    const points = [];
    for (let i = 0; i < boltPoints; i++) {
      const p = i / (boltPoints - 1);
      const jag = i === 0 || i === boltPoints - 1 ? 0 : 2.8;
      points.push(new THREE.Vector3(
        x + rand(-jag, jag),
        topY + (hitY - topY) * p,
        z + rand(-jag, jag),
      ));
    }
    const curve = new THREE.CatmullRomCurve3(points, false, 'chordal');
    const coreGeo = new THREE.TubeGeometry(curve, 48, 0.16, 5, false);
    const glowGeo = new THREE.TubeGeometry(curve, 48, 0.42, 6, false);
    bolt.geometry.dispose();
    boltGlow.geometry.dispose();
    bolt.geometry = coreGeo;
    boltGlow.geometry = glowGeo;
    for (let i = 0; i < forkCount; i++) {
      const baseP = rand(0.16, 0.82);
      const baseY = topY + (hitY - topY) * baseP;
      const baseX = x + rand(-2.4, 2.4);
      const baseZ = z + rand(-2.4, 2.4);
      const len = rand(4.5, 10);
      const j = i * 6;
      forkPositions[j] = baseX;
      forkPositions[j + 1] = baseY;
      forkPositions[j + 2] = baseZ;
      forkPositions[j + 3] = baseX + rand(-len, len);
      forkPositions[j + 4] = baseY - rand(3, 8);
      forkPositions[j + 5] = baseZ + rand(-len, len);
    }
    forkGeo.attributes.position.needsUpdate = true;
    flashLight.position.set(x, 22, z);
    storm.flashT = 0.72;
    world.onLightningStrike?.({ x, y: hitY, z });

    const hitR = 3.4;
    for (const ch of characters || []) {
      if (!ch?.alive) continue;
      const dx = ch.pos.x - x;
      const dz = ch.pos.z - z;
      if (dx * dx + dz * dz <= hitR * hitR) world.onLightningHit?.(ch, { x, z });
    }
  };

  world.anim.push((dt, t, characters = []) => {
    const active = t >= storm.startAt && t < storm.endAt;
    const fadeIn = THREE.MathUtils.smoothstep(t, storm.startAt, storm.startAt + 4);
    const fadeOut = 1 - THREE.MathUtils.smoothstep(t, storm.endAt - 5, storm.endAt);
    const mix = active ? Math.min(fadeIn, fadeOut) : 0;
    storm.mix = mix;
    storm.flashT = Math.max(0, storm.flashT - dt);
    const flash = Math.min(1, storm.flashT / 0.42);

    cloudDome.material.opacity = 0.86 * mix;
    rainMat.opacity = 0.78 * mix;
    if (scene.background?.isColor) scene.background.copy(baseBackground).lerp(stormBackground, 0.82 * mix).lerp(flashSky, 0.32 * flash);
    if (scene.fog && baseFog) {
      scene.fog.color.copy(baseFog.color).lerp(stormFog, 0.8 * mix).lerp(flashFog, 0.36 * flash);
      scene.fog.near = THREE.MathUtils.lerp(baseFog.near, 36, mix);
      scene.fog.far = THREE.MathUtils.lerp(baseFog.far, 120, mix);
    }

    if (mix > 0.01) {
      const viewer = characters.find(ch => ch?.isPlayer && ch.alive) || characters.find(ch => ch?.alive);
      if (viewer) {
        rainOrigin.x = viewer.pos.x;
        rainOrigin.z = viewer.pos.z;
        rainGeo.boundingSphere.center.set(rainOrigin.x, viewer.pos.y + 18, rainOrigin.z);
      }
      const fall = 55 * dt;
      const windX = rainWindX * fall / rainLenY;
      const windZ = rainWindZ * fall / rainLenY;
      const wrapX = rainHalfX * 2;
      const wrapZ = rainHalfZ * 2;
      for (let i = 0; i < rainCount; i++) {
        const j = i * 6;
        rainPositions[j] += windX;
        rainPositions[j + 1] -= fall;
        rainPositions[j + 2] += windZ;
        rainPositions[j + 3] += windX;
        rainPositions[j + 4] -= fall;
        rainPositions[j + 5] += windZ;
        let dx = rainPositions[j] - rainOrigin.x;
        while (dx > rainHalfX) {
          rainPositions[j] -= wrapX; rainPositions[j + 3] -= wrapX; dx -= wrapX;
        }
        while (dx < -rainHalfX) {
          rainPositions[j] += wrapX; rainPositions[j + 3] += wrapX; dx += wrapX;
        }
        let dz = rainPositions[j + 2] - rainOrigin.z;
        while (dz > rainHalfZ) {
          rainPositions[j + 2] -= wrapZ; rainPositions[j + 5] -= wrapZ; dz -= wrapZ;
        }
        while (dz < -rainHalfZ) {
          rainPositions[j + 2] += wrapZ; rainPositions[j + 5] += wrapZ; dz += wrapZ;
        }
        if (rainPositions[j + 4] < -4) resetDrop(i, rand(40, 56));
      }
      rainGeo.attributes.position.needsUpdate = true;
    }

    boltMat.opacity = flash;
    boltGlowMat.opacity = flash * 0.34;
    forkMat.opacity = flash * 0.72;
    flashLight.intensity = flash * 360;

    if (!active) return;
    storm.nextLightning -= dt;
    if (storm.nextLightning <= 0) {
      strikeAt(rand(-76, 76), rand(-76, 76), characters);
      storm.nextLightning = rand(20, 30);
    }
  });
}

function addNightSkyDome(scene) {
  const rnd = seededRandom(0x91e35a7b);
  addCanvasSkyDome(scene, (sg, width, height) => {
    const grad = sg.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, '#02030b');
    grad.addColorStop(0.48, '#091129');
    grad.addColorStop(0.78, '#132347');
    grad.addColorStop(1, '#22143a');
    sg.fillStyle = grad;
    sg.fillRect(0, 0, width, height);

    const glow = sg.createRadialGradient(width * 0.62, height * 0.18, 16, width * 0.62, height * 0.18, width * 0.28);
    glow.addColorStop(0, 'rgba(175,205,255,0.3)');
    glow.addColorStop(0.36, 'rgba(95,125,255,0.12)');
    glow.addColorStop(1, 'rgba(95,125,255,0)');
    sg.fillStyle = glow;
    sg.fillRect(0, 0, width, height);

    sg.save();
    sg.globalCompositeOperation = 'screen';
    for (let i = 0; i < 340; i++) {
      const x = rnd() * width;
      const y = height * (0.03 + (rnd() ** 1.55) * 0.62);
      const bright = 0.32 + rnd() * 0.64;
      const radius = rnd() < 0.08 ? 1.45 + rnd() * 1.3 : 0.55 + rnd() * 0.75;
      sg.shadowColor = `rgba(210,228,255,${bright * 0.7})`;
      sg.shadowBlur = radius * 4;
      sg.fillStyle = `rgba(235,244,255,${bright})`;
      sg.beginPath();
      sg.arc(x, y, radius, 0, Math.PI * 2);
      sg.fill();
    }
    sg.restore();

    const moonX = width * 0.72;
    const moonY = height * 0.2;
    const moon = sg.createRadialGradient(moonX, moonY, 4, moonX, moonY, 46);
    moon.addColorStop(0, 'rgba(245,248,255,0.98)');
    moon.addColorStop(0.4, 'rgba(212,226,255,0.72)');
    moon.addColorStop(1, 'rgba(160,190,255,0)');
    sg.fillStyle = moon;
    sg.beginPath();
    sg.arc(moonX, moonY, 46, 0, Math.PI * 2);
    sg.fill();
    sg.fillStyle = '#070c1f';
    sg.beginPath();
    sg.arc(moonX + 18, moonY - 8, 44, 0, Math.PI * 2);
    sg.fill();
  });
}

function addAtriumSkyDome(scene) {
  const width = 2048;
  const height = 1024;
  let seed = 0x7c6f3a21;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  const skyC = document.createElement('canvas');
  skyC.width = width;
  skyC.height = height;
  const sg = skyC.getContext('2d');

  const grad = sg.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, '#43308a');
  grad.addColorStop(0.28, '#6848aa');
  grad.addColorStop(0.58, '#b06ac7');
  grad.addColorStop(0.78, '#df91bc');
  grad.addColorStop(1, '#ffc37a');
  sg.fillStyle = grad;
  sg.fillRect(0, 0, width, height);

  const zenith = sg.createRadialGradient(width * 0.5, height * 0.16, 24, width * 0.5, height * 0.16, width * 0.42);
  zenith.addColorStop(0, 'rgba(32,31,118,0.62)');
  zenith.addColorStop(0.45, 'rgba(50,39,141,0.32)');
  zenith.addColorStop(1, 'rgba(50,39,141,0)');
  sg.fillStyle = zenith;
  sg.fillRect(0, 0, width, height);

  const horizon = sg.createRadialGradient(width * 0.5, height * 1.08, width * 0.12, width * 0.5, height * 1.08, width * 0.72);
  horizon.addColorStop(0, 'rgba(255,226,160,0.5)');
  horizon.addColorStop(0.48, 'rgba(255,177,170,0.23)');
  horizon.addColorStop(1, 'rgba(255,177,170,0)');
  sg.fillStyle = horizon;
  sg.fillRect(0, 0, width, height);

  sg.save();
  sg.globalCompositeOperation = 'screen';
  for (let i = 0; i < 24; i++) {
    const x = rnd() * width;
    const y = rnd() * height * 0.58 + height * 0.02;
    const rx = 90 + rnd() * 260;
    const ry = 10 + rnd() * 26;
    sg.translate(x, y);
    sg.rotate((rnd() - 0.5) * 0.45);
    const mist = sg.createRadialGradient(0, 0, 0, 0, 0, rx);
    mist.addColorStop(0, `rgba(255,240,255,${0.025 + rnd() * 0.035})`);
    mist.addColorStop(1, 'rgba(255,240,255,0)');
    sg.scale(1, ry / rx);
    sg.fillStyle = mist;
    sg.beginPath();
    sg.arc(0, 0, rx, 0, Math.PI * 2);
    sg.fill();
    sg.setTransform(1, 0, 0, 1, 0, 0);
  }
  sg.restore();

  sg.save();
  sg.globalCompositeOperation = 'screen';
  for (let i = 0; i < 170; i++) {
    const yBias = rnd() ** 1.65;
    const x = rnd() * width;
    const y = height * (0.04 + yBias * 0.45);
    const bright = 0.32 + rnd() * 0.58;
    const radius = rnd() < 0.12 ? 1.8 + rnd() * 1.4 : 0.75 + rnd() * 0.9;
    sg.shadowColor = `rgba(255,245,255,${bright * 0.6})`;
    sg.shadowBlur = radius * 4.5;
    sg.fillStyle = `rgba(255,248,255,${bright})`;
    sg.beginPath();
    sg.arc(x, y, radius, 0, Math.PI * 2);
    sg.fill();
  }
  sg.restore();

  const skyTex = new THREE.CanvasTexture(skyC);
  skyTex.colorSpace = THREE.SRGBColorSpace;
  skyTex.generateMipmaps = true;
  skyTex.minFilter = THREE.LinearMipmapLinearFilter;
  skyTex.magFilter = THREE.LinearFilter;

  const sky = new THREE.Mesh(new THREE.SphereGeometry(380, 64, 32),
    new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false }));
  scene.add(sky);
}

function gateBrickMaterial(id, color) {
  if (id === 'oldwest') {
    return mat(0xd58a4c, {
      tex: 'rock', repeat: [1.35, 1.6],
      roughness: 0.96, metalness: 0,
      emissive: 0x6f2d16, emissiveIntensity: 0.1,
    });
  }
  if (id === 'mycelium') {
    return mat(0x7d6bc7, {
      tex: 'canopy-bark', repeat: [1.1, 1.4],
      roughness: 0.78, metalness: 0.02,
      emissive: 0x3f235f, emissiveIntensity: 0.28,
    });
  }
  if (id === 'tidebreaker') {
    // Tidebreaker was added after the original six-tile gate atlas. Tint its
    // generated wet deck texture aqua so the frame keeps real storm-worn metal
    // detail while reading immediately as the ocean arena.
    if (AI_TEX['tidebreaker-deck']) return mat(0x62dce2, {
      tex: 'tidebreaker-deck', repeat: [0.9, 1.1],
      roughness: 0.48, metalness: 0.38, envMapIntensity: 0.78,
      emissive: 0x0b6875, emissiveIntensity: 0.16,
    });
    // The normal boot waits for AI textures, but retain a textured fallback if
    // a slow or failed request reaches the three-second startup cap.
    return mat(color, { tex: 'panel', repeat: [0.9, 1.1], roughness: 0.62, metalness: 0.2 });
  }
  const tex = gateFrameTex(GATE_FRAME_INDEX[id]);
  if (!tex) return mat(color, { tex: 'neonwall' });
  const map = tex.clone();
  map.needsUpdate = true;
  map.wrapS = map.wrapT = THREE.MirroredRepeatWrapping;
  map.repeat.set(1.15, 1.15);
  return new THREE.MeshStandardMaterial({
    map,
    color: 0xffffff,
    roughness: 0.72,
    metalness: 0.08,
    emissive: new THREE.Color(color),
    emissiveIntensity: 0.06,
    envMapIntensity: 0.35,
  });
}

function addGateBrick(scene, world, id, color, x, y, z, w, h, d, parent = scene) {
  world.colliders.push({
    type: 'box',
    min: V(x - w / 2, y - h / 2, z - d / 2),
    max: V(x + w / 2, y + h / 2, z + d / 2),
  });
  const brick = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), gateBrickMaterial(id, color));
  brick.position.set(x, y, z);
  brick.castShadow = brick.receiveShadow = true;
  parent.add(brick);
  return brick;
}

function addAtriumGateBrickFrame(scene, world, id, color, px, pz, horiz, baseY = 0, parent = scene) {
  const sideCenters = [-4, 4];
  const brickH = 1.55;
  for (const u of sideCenters) {
    for (let i = 0; i < 4; i++) {
      const y = baseY + brickH / 2 + i * brickH;
      if (horiz) addGateBrick(scene, world, id, color, px + u, y, pz, 1.6, brickH, 1.6, parent);
      else addGateBrick(scene, world, id, color, px, y, pz + u, 1.6, brickH, 1.6, parent);
    }
  }
  const lintelY = baseY + 6.9;
  const lintelH = 1.4;
  for (const u of sideCenters) {
    if (horiz) addGateBrick(scene, world, id, color, px + u, lintelY, pz, 1.6, lintelH, 1.6, parent);
    else addGateBrick(scene, world, id, color, px, lintelY, pz + u, 1.6, lintelH, 1.6, parent);
  }
  for (let i = 0; i < 4; i++) {
    const u = -2.4 + i * 1.6;
    if (horiz) addGateBrick(scene, world, id, color, px + u, lintelY, pz, 1.6, lintelH, 1.6, parent);
    else addGateBrick(scene, world, id, color, px, lintelY, pz + u, 1.6, lintelH, 1.6, parent);
  }
}

export function buildAtrium(scene) {
  const world = newWorld({ killY: -75, playerSpeed: 12.5 });
  scene.background = new THREE.Color(0xd99cb0);
  scene.fog = new THREE.Fog(0xd99cb0, 120, 340);
  baseLighting(scene, 0xffe0c8, 0x8a6a90, [-40, 80, 30], 90);

  addAtriumSkyDome(scene);

  // Courtyard floor, split around the full 14×10 fountain basin. Its one-piece
  // submerged floor seals this entire footprint until the north plate retracts it.
  addBox(scene, world, -19.5, -0.5, 0, 25, 1, 96, 0x8a8598, { tex: 'neonfloor', repeat: [4, 12] });
  addBox(scene, world, 19.5, -0.5, 0, 25, 1, 96, 0x8a8598, { tex: 'neonfloor', repeat: [4, 12] });
  addBox(scene, world, 0, -0.5, -26.5, 14, 1, 43, 0x8a8598, { tex: 'neonfloor', repeat: [2, 6] });
  addBox(scene, world, 0, -0.5, 26.5, 14, 1, 43, 0x8a8598, { tex: 'neonfloor', repeat: [2, 6] });
  addBox(scene, world, 0, 6, -49.5, 70, 12, 3, 0x6a5f88, { tex: 'neonwall', repeat: [9, 2] });
  addBox(scene, world, 0, 6, 49.5, 70, 12, 3, 0x6a5f88, { tex: 'neonwall', repeat: [9, 2] });
  addBox(scene, world, -33.5, 6, 0, 3, 12, 99, 0x6a5f88, { tex: 'neonwall', repeat: [12, 2] });
  // The former secret hallway is gone; the east wall is once again a complete
  // atrium boundary. Secret-map discovery now happens above the fountain.
  addBox(scene, world, 33.5, 6, 0, 3, 12, 99, 0x6a5f88, { tex: 'neonwall', repeat: [12, 2] });

  // Central fountain with matching lawn runs on both sides. End rim slabs own
  // the corners; side slabs stop between them so their top faces never overlap.
  addBox(scene, world, 0, 0.06, 25, 12, 0.14, 30, 0x3f7a35, { tex: 'atrium-grass', repeat: [2, 5] });
  addBox(scene, world, 0, 0.06, -25, 12, 0.14, 30, 0x3f7a35, { tex: 'atrium-grass', repeat: [2, 5] });
  addBox(scene, world, 0, 0.45, 6, 16, 0.9, 2, 0x555a74, { tex: 'panel' });   // pool rim
  addBox(scene, world, 0, 0.45, -6, 16, 0.9, 2, 0x555a74, { tex: 'panel' });
  addBox(scene, world, -8, 0.45, 0, 2, 0.9, 10, 0x555a74, { tex: 'panel' });
  addBox(scene, world, 8, 0.45, 0, 2, 0.9, 10, 0x555a74, { tex: 'panel' });
  addFittedWater(scene, world, {
    minX: -7, maxX: 7, minZ: -5, maxZ: 5, y: 0.55, depth: 58,
  });
  const fountain = addAtriumFountain(scene, world, 0, 0);

  // The atrium's visual anchor: a large two-tier arcade wordmark rather than a
  // stretched version of the small utility sign component.
  addAtriumHeroSign(scene, 0, 16.2, -48.5);
  addBox(scene, world, -11, 12.7, -48.5, 0.4, 1.8, 0.4, 0x3a3452);
  addBox(scene, world, 11, 12.7, -48.5, 0.4, 1.8, 0.4, 0x3a3452);

  // Gate bays. The long side walls hold the eight arenas; the axial gates are
  // reserved for the Hall of Fame ahead and multiplayer behind the spawn.
  world.portals = [];
  const bays = [
    ['hall', 'HALL OF FAME', 0xffd45a, 'n', 0, 'hall'],
    ['fortress', 'FORTRESS FALLS', 0x9a6fe0, 'w', 36, 'map'],
    ['oldwest', 'RED ROCK RANGE', 0xd46a32, 'w', 12, 'map'],
    ['sanctum', 'THE LABYRINTH', 0x8a5fff, 'w', -12, 'map'],
    ['tidebreaker', 'TIDEBREAKER', 0x35b9d0, 'w', -36, 'map'],
    ['arena', 'BLAST COMPLEX', 0xd88a2b, 'e', 36, 'map'],
    ['canopy', 'CANOPY', 0x4dbf6a, 'e', 12, 'map'],
    ['mycelium', 'MYCELIUM GROVE', 0xa96eff, 'e', -12, 'map'],
    ['city', 'NEON HEIGHTS', 0xff40a0, 'e', -36, 'map'],
    ['multiplayer', 'MULTIPLAYER', 0x30e0ff, 's', 0, 'multiplayer'],
  ];
  for (const [id, name, color, wall, off, kind] of bays) {
    const horiz = wall === 'n' || wall === 's';
    const sgn = (wall === 'e' || wall === 's') ? 1 : -1;
    const px = horiz ? off : sgn * 31.2, pz = horiz ? sgn * 47.2 : off;  // back face flush with wall
    const frameId = id === 'hall' ? 'arena' : id === 'multiplayer' ? 'sanctum' : id;
    if (horiz) {
      addAtriumGateBrickFrame(scene, world, frameId, color, px, pz, true);
      addMagicPortal(scene, world, px, 3.7, pz + sgn * 0.82, 7.8, 7.8, color, sgn === -1 ? 0 : Math.PI);
    } else {
      addAtriumGateBrickFrame(scene, world, frameId, color, px, pz, false);
      addMagicPortal(scene, world, px + sgn * 0.82, 3.7, pz, 7.8, 7.8, color, -sgn * Math.PI / 2);
    }
    // Oversized attraction marquees echo the original Arena Blast atrium.
    // Pull them slightly into the room so their transparent wings clear the wall.
    addAtriumMarquee(scene, id, name, color,
      horiz ? px : sgn * 31.86, 10.45, horiz ? sgn * 47.9 : pz,
      horiz ? (sgn === -1 ? 0 : Math.PI) : -sgn * Math.PI / 2,
      horiz ? 16.5 : 15.5);
    const L = new THREE.PointLight(color, 26, 20);
    L.position.set(horiz ? px : px - sgn * 2.5, 4.5, horiz ? pz - sgn * 2.5 : pz);
    scene.add(L);
    const trigger = { x: horiz ? px : px + sgn * 0.5, z: horiz ? pz + sgn * 0.5 : pz };
    if (kind === 'hall') world.hallPortal = trigger;
    else if (kind === 'multiplayer') world.multiplayerPortal = trigger;
    else world.portals.push({ ...trigger, map: id, name });
  }
  addAtriumSecretObservatory(scene, world, fountain);
  addAtriumUnderwaterChamber(scene, world);

  // Flower borders flank both halves of the boulevard without running beneath
  // the centered fountain.
  for (const x of [-8.5, 8.5]) {
    addBox(scene, world, x, 0.036, 25, 5, 0.07, 30, 0xd8a8c8, { tex: 'flowers', repeat: [1, 5] });
    addBox(scene, world, x, 0.036, -25, 5, 0.07, 30, 0xd8a8c8, { tex: 'flowers', repeat: [1, 5] });
  }

  // controls board to the left of spawn (replaces the old overlay text).
  // Shoot the front to open the repo; the backside is a rickroll easter egg.
  addAtriumControlsSign(scene, world, -12, 4.4, 39, Math.PI / 2.6);

  // mode pad beside the spawn
  addBox(scene, world, 11, 0.3, 38, 3.4, 0.6, 3.4, 0x2a6a8a, { tex: 'panel' });
  addBox(scene, world, 11, 0.66, 38, 2.6, 0.1, 2.6, 0x30e0ff, { collide: false, shadow: false, emissive: 0x30e0ff, emissiveIntensity: 0.9 });
  world.modePad = { x: 11, z: 38 };
  addBox(scene, world, 11, 1.6, 36.6, 0.3, 3.2, 0.3, 0x3a3452); // sign post at the pad's back edge
  world.setModeSign = makeSign(scene, 11, 3.6, 36.8, 9, '#30e0ff', 'MODE: FREE FOR ALL', 0, true);

  addDecal(scene, 'poster1', -24, 6, -47.94, 8, 0);
  addDecal(scene, 'target', 27, 6, -47.94, 8, 0);
  // Mount the north-wall glow strips above the poster line, close to the wall,
  // so they frame the Hall of Fame without washing across either poster.
  for (const [x, z, c] of [[-19, -47.78, 0xff40a0], [19, -47.78, 0x30e0ff]]) {
    addBox(scene, world, x, 11.35, z, 11.5, 0.55, 0.22, c, { collide: false, shadow: false, emissive: c, emissiveIntensity: 1.5 });
  }

  world.spawns.ffa.push(V(0, 0.1, 43));
  world.spawns.blue.push(V(0, 0.1, 43));
  world.spawns.red.push(V(0, 0.1, 43));
  wp(world, 0, 0, 20);
  mergeStatic(scene, world);
  return world;
}

const HALL_MAP_NAMES = {
  arena: 'BLAST COMPLEX',
  fortress: 'FORTRESS FALLS',
  oldwest: 'RED ROCK RANGE',
  asteroids: 'ASTEROID BELT',
  canopy: 'CANOPY',
  mycelium: 'MYCELIUM GROVE',
  city: 'NEON HEIGHTS',
  sanctum: 'THE LABYRINTH',
  tidebreaker: 'TIDEBREAKER',
  prism: 'PRISM RUN',
  olympus: 'OLYMPUS MONS',
};

const HALL_AWARD_LABELS = [
  ['longShot100', '100M LONG SHOT'], ['longShot250', '250M LONG SHOT'],
  ['deadEye500', '500M DEAD EYE'],
  ['multi2', 'DOUBLE KILL'], ['multi3', 'TRIPLE KILL'], ['multi4', 'QUAD KILL'],
  ['multi5', 'PENTA KILL'], ['multi6', 'HEXA KILL'], ['multi7', 'SEPTUPLE KILL'],
  ['oneShot2', 'ONE SHOT, TWO KILLS'], ['oneShot3', 'ONE SHOT, THREE KILLS'],
  ['oneShot4', 'ONE SHOT, FOUR KILLS'], ['oneShot5', 'ONE SHOT, FIVE KILLS'],
  ['oneShot6', 'ONE SHOT, SIX KILLS'], ['oneShot7', 'ONE SHOT, SEVEN KILLS'],
];

function hallAwardParts(awards = {}) {
  const known = new Set(HALL_AWARD_LABELS.map(([key]) => key));
  const parts = HALL_AWARD_LABELS
    .filter(([key]) => Number(awards[key]) > 0)
    .map(([key, label]) => `${label} ×${Math.floor(Number(awards[key]))}`);
  for (const [key, count] of Object.entries(awards || {})) {
    if (known.has(key) || !Number.isFinite(Number(count)) || Number(count) <= 0) continue;
    const label = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toUpperCase();
    parts.push(`${label} ×${Math.floor(Number(count))}`);
  }
  return parts;
}

function drawHallAwards(g, awards, x, y, maxWidth, maxLines = 2, align = 'left', fontSize = 13, lineHeight = 18) {
  const parts = hallAwardParts(awards);
  const phrases = parts.length ? parts : ['NONE'];
  let size = fontSize;
  let lines = [];
  do {
    g.font = `800 ${size}px Arial`;
    lines = [];
    let line = 'AWARDS:';
    for (const phrase of phrases) {
      const next = line === 'AWARDS:' ? `${line} ${phrase}` : `${line}  •  ${phrase}`;
      if (line !== 'AWARDS:' && g.measureText(next).width > maxWidth) {
        lines.push(line);
        line = phrase;
      } else {
        line = next;
      }
    }
    lines.push(line);
    size -= 1;
  } while (lines.length > maxLines && size >= 8);
  g.textAlign = align;
  g.fillStyle = parts.length ? '#f2cf68' : '#737d91';
  lines.forEach((line, index) => g.fillText(line, x, y + index * lineHeight));
}

function drawHallEntry(g, entry, rank, y, width) {
  const occupied = !!entry;
  const medal = rank === 1 ? '#ffd75e' : rank === 2 ? '#dce6f3' : rank === 3 ? '#d28a4d' : '#e8c86a';
  g.fillStyle = occupied ? 'rgba(17,23,39,.94)' : 'rgba(17,23,39,.58)';
  g.fillRect(22, y, width - 44, 116);
  g.fillStyle = medal;
  g.font = '900 27px Arial';
  g.textAlign = 'left';
  g.fillText(String(rank).padStart(2, '0'), 38, y + 32);
  if (!occupied) {
    g.fillStyle = '#7f8797';
    g.font = '700 20px Arial';
    g.fillText('AWAITING A CHAMPION', 94, y + 32);
    g.font = '600 14px Arial';
    g.fillText('THIS PLACE IS UNCLAIMED', 94, y + 60);
    drawHallAwards(g, {}, 94, y + 88, width - 132, 1, 'left', 12, 16);
    return;
  }
  const name = String(entry.name || 'PLAYER').toUpperCase().slice(0, 18);
  g.fillStyle = '#fff7df';
  g.font = '900 24px Arial';
  g.fillText(name, 94, y + 30);
  g.fillStyle = '#ffd75e';
  g.font = '900 23px Arial';
  g.textAlign = 'right';
  g.fillText(Number(entry.score || 0).toLocaleString(), width - 38, y + 30);
  g.textAlign = 'left';
  g.fillStyle = '#aebbd2';
  g.font = '700 13px Arial';
  const map = HALL_MAP_NAMES[entry.map] || String(entry.map || 'UNKNOWN').toUpperCase();
  const mode = entry.gameType === 'tdm' ? 'TEAM DEATHMATCH' : 'FREE FOR ALL';
  const play = entry.playType === 'multiplayer' ? 'MULTIPLAYER' : 'SINGLE PLAYER';
  g.fillText(`${map}  •  ${mode}  •  ${play}`, 94, y + 57);
  drawHallAwards(g, entry.awards, 94, y + 83, width - 132, 2, 'left', 13, 18);
}

function makeHallLeaderboardBoard(scene, x, y, z, yaw, startRank) {
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 700;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const draw = (entries = []) => {
    const g = canvas.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, canvas.height);
    grad.addColorStop(0, '#4a3410');
    grad.addColorStop(0.08, '#17121a');
    grad.addColorStop(1, '#080b14');
    g.fillStyle = grad;
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.strokeStyle = '#e7bd4c';
    g.lineWidth = 12;
    g.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
    g.fillStyle = '#f7d979';
    g.font = '900 25px "Arial Black", Arial';
    g.textAlign = 'center';
    g.fillText(`IMMORTAL RANKS ${startRank}–${startRank + 4}`, canvas.width / 2, 44);
    for (let i = 0; i < 5; i++) drawHallEntry(g, entries[startRank + i - 1], startRank + i, 65 + i * 124, canvas.width);
    tex.needsUpdate = true;
  };
  draw();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(13.8, 12.55), new THREE.MeshStandardMaterial({
    map: tex,
    emissive: 0x4d350b,
    emissiveIntensity: 0.18,
    roughness: 0.48,
    metalness: 0.08,
  }));
  mesh.position.set(x, y, z);
  mesh.rotation.y = yaw;
  scene.add(mesh);
  return draw;
}

function makeHallPodiumCard(scene, x, y, z, place, width = 8.2, height = 4.6) {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const placeColor = ['#ffd75e', '#e6edf8', '#d89050'][place - 1];
  const draw = (entries = []) => {
    const entry = entries[place - 1];
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = 'rgba(8,10,18,.95)';
    g.beginPath(); g.roundRect(12, 12, 616, 336, 30); g.fill();
    g.lineWidth = 12; g.strokeStyle = placeColor; g.stroke();
    g.textAlign = 'center';
    g.fillStyle = placeColor;
    g.font = '900 72px "Arial Black", Arial';
    g.fillText(String(place), 320, 78);
    if (!entry) {
      g.fillStyle = '#8c93a3';
      g.font = '800 30px Arial';
      g.fillText('AWAITING A CHAMPION', 320, 190);
      g.font = '700 20px Arial';
      g.fillText('THE THRONE IS UNCLAIMED', 320, 242);
    } else {
      g.fillStyle = '#fff8e6';
      g.font = '900 36px Arial';
      g.fillText(String(entry.name || 'PLAYER').toUpperCase().slice(0, 18), 320, 130);
      g.fillStyle = placeColor;
      g.font = '900 37px Arial';
      g.fillText(`${Number(entry.score || 0).toLocaleString()} POINTS`, 320, 176);
      const map = HALL_MAP_NAMES[entry.map] || String(entry.map || 'UNKNOWN').toUpperCase();
      const mode = entry.gameType === 'tdm' ? 'TEAM DEATHMATCH' : 'FREE FOR ALL';
      const play = entry.playType === 'multiplayer' ? 'MULTIPLAYER' : 'SINGLE PLAYER';
      g.fillStyle = '#b9c3d7';
      g.font = '700 18px Arial';
      g.fillText(map, 320, 212);
      g.fillText(`${mode}  •  ${play}`, 320, 242);
      drawHallAwards(g, entry.awards, 320, 271, 570, 4, 'center', 15, 19);
    }
    tex.needsUpdate = true;
  };
  draw();
  const edge = new THREE.MeshStandardMaterial({
    color: new THREE.Color(placeColor), metalness: 0.58, roughness: 0.3,
  });
  const face = new THREE.MeshBasicMaterial({ map: tex });
  // A shallow box gives the plaque a real front surface instead of placing a
  // plane almost coplanar with the podium. The old 2.5cm offset still fought
  // the podium depth buffer when viewed from the far entrance.
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(width, height, 0.14),
    [edge, edge, edge, edge, face, edge],
  );
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  scene.add(mesh);
  return draw;
}

function addHallColumn(scene, world, x, z, height = 84) {
  const marble = new THREE.MeshStandardMaterial({ color: 0xfff1cf, roughness: 0.5, metalness: 0.02 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xd5a72f, roughness: 0.3, metalness: 0.62 });
  const shaftHeight = height - 1.8;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.22, shaftHeight, 24), marble);
  shaft.position.set(x, 1.08 + shaftHeight / 2, z);
  shaft.castShadow = shaft.receiveShadow = true;
  const base = new THREE.Mesh(new THREE.CylinderGeometry(1.55, 1.8, 0.72, 24), gold);
  base.position.set(x, 0.72, z);
  const capital = new THREE.Mesh(new THREE.CylinderGeometry(1.75, 1.18, 1.1, 24), gold);
  capital.position.set(x, height + 0.05, z);
  scene.add(shaft, base, capital);
  world.colliders.push({ type: 'box', min: V(x - 1.05, 0, z - 1.05), max: V(x + 1.05, height + 0.6, z + 1.05) });
}

function addHallPoolFountain(scene, world, x, z, scale = 1, phase = 0) {
  const root = new THREE.Group();
  root.position.set(x, 0, z);
  root.scale.setScalar(scale);
  root.name = 'hall-of-fame-fountain';
  scene.add(root);

  const marble = new THREE.MeshStandardMaterial({ color: 0xfff1cf, roughness: 0.42, metalness: 0.05 });
  const gold = new THREE.MeshStandardMaterial({
    color: 0xd5a72f, emissive: 0x5b3500, emissiveIntensity: 0.24,
    roughness: 0.26, metalness: 0.7,
  });
  const waterSurface = new THREE.MeshStandardMaterial({
    color: 0x87e9ff, emissive: 0x0b6f98, emissiveIntensity: 0.5,
    transparent: true, opacity: 0.82, roughness: 0.08, depthWrite: false,
  });
  const waterJets = [];
  const add = (geometry, material, y, rotateX = 0) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = y;
    mesh.rotation.x = rotateX;
    mesh.castShadow = mesh.receiveShadow = true;
    root.add(mesh);
    return mesh;
  };

  // Plinth sits on the pool floor and rises through the reflecting-pool surface.
  add(new THREE.CylinderGeometry(0.78, 0.98, 0.58, 16), gold, 0.29);
  add(new THREE.CylinderGeometry(0.3, 0.46, 1.18, 14), marble, 1.12);
  add(new THREE.CylinderGeometry(1.02, 0.34, 0.34, 24), gold, 1.86);
  add(new THREE.TorusGeometry(0.95, 0.1, 7, 28), gold, 2.04, Math.PI / 2);
  add(new THREE.CylinderGeometry(0.82, 0.82, 0.045, 24), waterSurface, 2.05);
  add(new THREE.CylinderGeometry(0.16, 0.24, 0.72, 12), marble, 2.38);
  const finial = add(new THREE.OctahedronGeometry(0.27, 0), gold, 2.82);

  const jetMaterial = () => new THREE.MeshBasicMaterial({
    color: 0xc8f5ff, transparent: true, opacity: 0.78,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + Math.PI / 4;
    const radial = V(Math.cos(a), 0, Math.sin(a));
    // Reflecting-pool surface is world y=0.24; divide by scale so the
    // scaled root still lands the arc on the water plane.
    const curve = new THREE.QuadraticBezierCurve3(
      radial.clone().multiplyScalar(0.7).setY(2.14),
      radial.clone().multiplyScalar(1.12).setY(2.9),
      radial.clone().multiplyScalar(1.65).setY(0.24 / scale),
    );
    const jet = new THREE.Mesh(new THREE.TubeGeometry(curve, 20, 0.045, 6, false), jetMaterial());
    jet.renderOrder = 4;
    root.add(jet);
    waterJets.push(jet);
  }
  const plumeCurve = new THREE.CatmullRomCurve3([
    V(0, 2.95, 0), V(0.035, 3.48, 0), V(-0.025, 3.95, 0), V(0, 4.26, 0),
  ]);
  const plume = new THREE.Mesh(new THREE.TubeGeometry(plumeCurve, 18, 0.06, 6, false), jetMaterial());
  plume.renderOrder = 4;
  root.add(plume);
  waterJets.push(plume);

  const light = new THREE.PointLight(0x8de8ff, 8, 16);
  light.position.set(0, 2.4, 0);
  root.add(light);
  world.anim.push((dt, t) => {
    finial.rotation.y += dt * 0.55;
    waterJets.forEach((jet, i) => {
      jet.material.opacity = 0.68 + Math.sin(t * 3.1 + phase + i * 0.7) * 0.1;
    });
  });
}

function addHallReflectingPool(scene, world, x, z, w, d) {
  addBox(scene, world, x, 0.06, z, w + 0.8, 0.12, d + 0.8, 0xb88b2c, { collide: false, emissive: 0x543500, emissiveIntensity: 0.12 });
  addBox(scene, world, x, 0.13, z, w, 0.16, d, 0x173e55, { collide: false, emissive: 0x08263a, emissiveIntensity: 0.22 });
  addWater(scene, world, x, 0.24, z, w - 0.65, d - 0.65, 0.38);
  // Side and end rails butt together instead of crossing at the four corners.
  // Overlapping boxes shared the same top plane there and visibly z-fought.
  for (const side of [-1, 1]) {
    addBox(scene, world, x + side * (w / 2 + 0.24), 0.24, z, 0.48, 0.48, d, 0xd5a72f, { collide: false });
  }
  for (const end of [-1, 1]) {
    addBox(scene, world, x, 0.24, z + end * (d / 2 + 0.24), w + 0.96, 0.48, 0.48, 0xd5a72f, { collide: false });
  }
  addHallPoolFountain(scene, world, x, z - 50, 0.92, 0);
  addHallPoolFountain(scene, world, x, z, 1.16, 2.1);
  addHallPoolFountain(scene, world, x, z + 50, 0.92, 4.2);
}

function addHallGoldPowerupOrnament(scene) {
  const z = 110.05;
  const centerY = 44;
  const bronze = new THREE.MeshStandardMaterial({
    color: 0x4b2505,
    metalness: 0.74,
    roughness: 0.3,
  });
  const brightGold = new THREE.MeshStandardMaterial({
    color: 0xffd75e,
    emissive: 0x6c4100,
    emissiveIntensity: 0.28,
    metalness: 0.86,
    roughness: 0.2,
  });
  const powerGold = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    ...aiTex('power-gold', 1, 1),
    emissive: 0x5d3500,
    emissiveIntensity: 0.18,
    metalness: 0.64,
    roughness: 0.3,
  });

  // A flat octagonal mosaic made from the gold-powerup artwork. Layered rings
  // and a shallow N relief make it read as palace ornament, never as a pickup.
  const back = new THREE.Mesh(new THREE.CircleGeometry(16.4, 8), bronze);
  back.position.set(0, centerY, z + 0.14);
  back.rotation.y = Math.PI;
  const face = new THREE.Mesh(new THREE.CircleGeometry(14.7, 8), powerGold);
  face.position.set(0, centerY, z);
  face.rotation.y = Math.PI;
  const outerRing = new THREE.Mesh(new THREE.RingGeometry(14.65, 16.05, 8), brightGold);
  outerRing.position.set(0, centerY, z - 0.08);
  outerRing.rotation.y = Math.PI;
  const innerRing = new THREE.Mesh(new THREE.RingGeometry(12.55, 13.05, 8), brightGold);
  innerRing.position.set(0, centerY, z - 0.11);
  innerRing.rotation.y = Math.PI;
  scene.add(back, face, outerRing, innerRing);

  for (const [x, rotation, height] of [[-4.1, 0, 10.2], [4.1, 0, 10.2], [0, -0.68, 12.8]]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(1.35, height, 0.62), bronze);
    bar.position.set(x, centerY, z - 0.48);
    bar.rotation.z = rotation;
    scene.add(bar);
  }

  const glow = new THREE.PointLight(0xffc928, 9, 44);
  glow.position.set(0, centerY, 101);
  scene.add(glow);
}

export function buildHallOfFame(scene) {
  const world = newWorld({ killY: -20, playerSpeed: 12.5 });
  scene.background = new THREE.Color(0x98c9f0);
  scene.fog = new THREE.Fog(0xe8d9b8, 180, 360);
  baseLighting(scene, 0xfff0c2, 0x7385a3, [-35, 120, 30], 135);
  addDaytimeSkyDome(scene);

  const halfWidth = 34;
  const halfLength = 112;
  const ceilingY = 92;

  // A genuinely monumental Olympus-inspired nave: more than five times the
  // former ceiling height, wider walls, and a much longer ceremonial axis.
  addBox(scene, world, 0, -0.5, 0, halfWidth * 2, 1, halfLength * 2, 0xf4e5c6, { tex: 'checker', repeat: [15, 46] });
  addBox(scene, world, -halfWidth, ceilingY / 2, 0, 2, ceilingY, halfLength * 2, 0xffefcf);
  addBox(scene, world, halfWidth, ceilingY / 2, 0, 2, ceilingY, halfLength * 2, 0xffefcf);
  addBox(scene, world, 0, ceilingY / 2, -halfLength, halfWidth * 2, ceilingY, 2, 0xffefcf);
  addBox(scene, world, 0, ceilingY / 2, halfLength, halfWidth * 2, ceilingY, 2, 0xffefcf);
  addBox(scene, world, 0, ceilingY, 0, halfWidth * 2, 1.6, halfLength * 2, 0xc99a2f);
  addBox(scene, world, 0, 0.08, 0, 9, 0.16, halfLength * 2 - 12, 0xb07d1e, { collide: false, emissive: 0x5a3400, emissiveIntensity: 0.16 });
  for (let z = -99; z <= 99; z += 18) {
    addBox(scene, world, 0, ceilingY - 0.9, z, halfWidth * 2 - 2, 0.72, 0.8, 0xe9c65f, { collide: false, emissive: 0x6a4800, emissiveIntensity: 0.1 });
  }
  for (const x of [-22, 0, 22]) {
    addBox(scene, world, x, ceilingY - 0.86, 0, 0.72, 0.78, halfLength * 2 - 2, 0xe9c65f, { collide: false, emissive: 0x6a4800, emissiveIntensity: 0.1 });
  }

  for (let z = -90; z <= 90; z += 18) {
    addHallColumn(scene, world, -26.5, z, 84);
    addHallColumn(scene, world, 26.5, z, 84);
  }

  // Great hanging rings illuminate the enormous upper volume and make its
  // height legible from the floor instead of reading as an empty void.
  for (const z of [-72, -36, 0, 36, 72]) {
    const chain = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 31, 8), new THREE.MeshStandardMaterial({
      color: 0x9b731d,
      metalness: 0.72,
      roughness: 0.3,
    }));
    chain.position.set(0, 75.5, z);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(3.2, 0.22, 12, 36), new THREE.MeshStandardMaterial({
      color: 0xf0cc65,
      emissive: 0x6a4300,
      emissiveIntensity: 0.32,
      metalness: 0.76,
      roughness: 0.24,
    }));
    ring.rotation.x = Math.PI / 2;
    ring.position.set(0, 59.8, z);
    scene.add(chain, ring);
    const light = new THREE.PointLight(0xffdf8a, 18, 76);
    light.position.set(0, 58.8, z);
    scene.add(light);
  }

  // Twin reflecting pools flank the gold processional carpet. Three fountain
  // jets in each pool keep the long hall alive without obstructing the route.
  addHallReflectingPool(scene, world, -13, 5, 7, 150);
  addHallReflectingPool(scene, world, 13, 5, 7, 150);

  // Hanging vine curtains fill the high side walls between leaderboard boards.
  const vineGaps = [73, 55, 37, 19, 1, -17, -35, -53, -71];
  vineGaps.forEach((z, i) => {
    const bottom = 19 + (i % 3) * 4;
    const top = 82 + (i % 2) * 4;
    addVine(scene, world, -32.75, z, bottom, top, 0.95, 0, 0, 1, 0, 0.4, 3.2);
    addVine(scene, world, 32.75, z, bottom, top, 0.95, 0, 0, -1, 0, 0.4, 3.2);
  });

  // Return portal at the entrance, behind the player when they arrive.
  // Match the atrium-side Hall of Fame entrance while retaining the blue
  // return portal, so both ends read as the same doorway.
  addAtriumGateBrickFrame(scene, world, 'arena', 0xffd45a, 0, 110.8, true);
  addMagicPortal(scene, world, 0, 3.7, 110.15, 7.8, 7.8, 0x73dcff, Math.PI);
  addAtriumMarquee(scene, 'hall', 'RETURN TO ATRIUM', 0xffd45a,
    0, 10.45, 110.1, Math.PI, 16.5);
  addHallGoldPowerupOrnament(scene);
  world.hallExitPortal = { x: 0, z: 106.5 };

  // The back wall is now a proper monument with large, separately spaced title
  // bands above the champion cards rather than a stack of overlapping signs.
  addArenaSign(scene, 'THE IMMORTAL HALL OF FAME', 0, 45, -110.85, 42, 10.5, 0, '#ffd75e', 'hall');
  addArenaSign(scene, 'TOP 100 CHAMPIONS', 0, 33, -110.8, 30, 7.5, 0, '#fff1c9', 'hall');

  const leaderboardDraws = [];
  for (let i = 0; i < 10; i++) {
    const z = 82 - i * 18;
    leaderboardDraws.push(makeHallLeaderboardBoard(scene, -32.85, 11.5, z, Math.PI / 2, i * 10 + 1));
    leaderboardDraws.push(makeHallLeaderboardBoard(scene, 32.85, 11.5, z, -Math.PI / 2, i * 10 + 6));
  }

  // Far-end dais and the three champion thrones.
  addBox(scene, world, 0, 0.4, -95, 34, 0.8, 20, 0xc3962e);
  addBox(scene, world, 0, 0.92, -96, 31, 0.32, 16.5, 0xffedba);
  const podiumSpecs = [
    { x: 0, h: 10.2, w: 11.4, d: 9.4, color: 0xe0b538, cardW: 8.2, cardH: 4.6 },
    { x: -10, h: 5.4, w: 7, d: 6.5, color: 0xcbd4df, cardW: 6.4, cardH: 3.6 },
    { x: 10, h: 4.4, w: 7, d: 6.5, color: 0xbd7441, cardW: 6, cardH: 3.37 },
  ];
  const podiumDraws = [];
  for (let i = 0; i < podiumSpecs.length; i++) {
    const spec = podiumSpecs[i];
    addBox(scene, world, spec.x, 1.08 + spec.h / 2, -96, spec.w, spec.h, spec.d, spec.color);
    const orb = new THREE.Mesh(new THREE.SphereGeometry(i === 0 ? 0.82 : 0.68, 20, 14), new THREE.MeshStandardMaterial({
      color: spec.color,
      emissive: spec.color,
      emissiveIntensity: 0.24,
      metalness: 0.65,
      roughness: 0.22,
    }));
    orb.position.set(spec.x, 1.8 + spec.h, -96);
    scene.add(orb);
    const cardY = 1.08 + spec.h * 0.52;
    const cardZ = -96 + spec.d / 2 + 0.07;
    podiumDraws.push(makeHallPodiumCard(scene, spec.x, cardY, cardZ, i + 1, spec.cardW, spec.cardH));
  }

  // The Hall's final secret is built into the rear face of first place. The
  // oversized champion podium blocks every view from the nave; the Martian
  // gate only appears after a player circles fully behind the gold monolith.
  const goldPodiumBackZ = -96 - podiumSpecs[0].d / 2;
  addMagicPortal(scene, world, 0, 5.6, goldPodiumBackZ - 0.06, 8.4, 7.4, 0xff5a24, Math.PI);
  // Frame pieces meet edge-to-edge. Previously their coplanar front faces
  // overlapped at all four corners, producing a flickering z-stack.
  for (const x of [-4.5, 4.5]) {
    addBox(scene, world, x, 5.6, goldPodiumBackZ - 0.1, 0.6, 8.4, 0.34, 0xb77a32, {
      collide: false, emissive: 0x7a2b10, emissiveIntensity: 0.34,
    });
  }
  for (const y of [1.6, 9.6]) {
    addBox(scene, world, 0, y, goldPodiumBackZ - 0.1, 8.4, 0.6, 0.34, 0xb77a32, {
      collide: false, emissive: 0x7a2b10, emissiveIntensity: 0.34,
    });
  }
  addBox(scene, world, 0, 1.12, goldPodiumBackZ - 1.25, 1.2, 0.1, 1.8, 0xff6a2a, {
    collide: false, shadow: false, emissive: 0xff3d17, emissiveIntensity: 1.1,
  });
  world.secretMapPortal = { x: 0, z: goldPodiumBackZ - 0.55, map: 'olympus' };

  const crown = new THREE.PointLight(0xffd75e, 42, 38);
  crown.position.set(0, 25, -94);
  scene.add(crown);

  world.setLeaderboard = (entries = []) => {
    for (const draw of leaderboardDraws) draw(entries);
    for (const draw of podiumDraws) draw(entries);
  };
  world.spawns.ffa.push(V(0, 0.1, 96));
  world.spawns.blue.push(V(0, 0.1, 96));
  world.spawns.red.push(V(0, 0.1, 96));
  wp(world, 0, 0, 92);
  wp(world, 0, 0, 48);
  wp(world, 0, 0, 4);
  wp(world, 0, 0, -40);
  wp(world, 0, 0, -82);
  mergeStatic(scene, world);
  return world;
}

function addMarsSkyDome(scene) {
  const rnd = seededRandom(0x4f4c594d);
  addCanvasSkyDome(scene, (g, width, height) => {
    const sky = g.createLinearGradient(0, 0, 0, height);
    sky.addColorStop(0, '#160f20');
    sky.addColorStop(0.28, '#472238');
    sky.addColorStop(0.62, '#a54e35');
    sky.addColorStop(0.83, '#dc8550');
    sky.addColorStop(1, '#f2b36a');
    g.fillStyle = sky;
    g.fillRect(0, 0, width, height);

    // Thin atmosphere: the zenith still shows stars while iron dust burns
    // orange at the horizon.
    g.fillStyle = '#ffe0a0';
    for (let i = 0; i < 220; i++) {
      const y = 20 + rnd() * height * 0.5;
      const a = 0.22 + rnd() * 0.65;
      const r = rnd() < 0.08 ? 1.7 : 0.65 + rnd() * 0.75;
      g.globalAlpha = a;
      g.beginPath();
      g.arc(rnd() * width, y, r, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;

    const sunX = width * 0.2;
    const sunY = height * 0.22;
    const halo = g.createRadialGradient(sunX, sunY, 4, sunX, sunY, 92);
    halo.addColorStop(0, 'rgba(255,255,238,1)');
    halo.addColorStop(0.2, 'rgba(255,230,165,.76)');
    halo.addColorStop(1, 'rgba(255,164,92,0)');
    g.fillStyle = halo;
    g.beginPath(); g.arc(sunX, sunY, 94, 0, Math.PI * 2); g.fill();

    // Phobos hangs low and visibly irregular over the volcano.
    const moonX = width * 0.73;
    const moonY = height * 0.24;
    g.save();
    g.translate(moonX, moonY);
    g.rotate(-0.18);
    g.scale(1.45, 0.82);
    const moon = g.createRadialGradient(-10, -10, 3, 0, 0, 56);
    moon.addColorStop(0, '#ead2ad');
    moon.addColorStop(0.55, '#8e715f');
    moon.addColorStop(1, '#352837');
    g.fillStyle = moon;
    g.beginPath(); g.arc(0, 0, 58, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(45,31,36,.42)';
    for (const [x, y, r] of [[-18, 3, 10], [15, -13, 8], [22, 15, 6], [-3, -21, 7]]) {
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    g.restore();

    const dust = g.createLinearGradient(0, height * 0.72, 0, height);
    dust.addColorStop(0, 'rgba(255,167,91,0)');
    dust.addColorStop(0.65, 'rgba(255,171,92,.24)');
    dust.addColorStop(1, 'rgba(86,31,24,.58)');
    g.fillStyle = dust;
    g.fillRect(0, height * 0.7, width, height * 0.3);
  }, 540);
}

function addOlympusCrag(scene, world, x, y, z, radius, color, seed, { collide = true } = {}) {
  const geo = new THREE.IcosahedronGeometry(radius, 1);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
    const wobble = 0.82 + 0.18 * Math.sin(px * 1.7 + pz * 2.3 + seed);
    pos.setXYZ(i, px * wobble, py * (0.55 + 0.12 * Math.cos(seed + px)), pz * wobble);
  }
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mat(color, {
    tex: 'olympus-rock', repeat: [2, 2], roughness: 1, flatShading: true,
    emissive: 0x2a0d08, emissiveIntensity: 0.46,
  }));
  mesh.position.set(x, y, z);
  // Keep the deliberately flattened axis upright. Arbitrary X/Z rotation made
  // the old sphere collider extend well beyond the visible stone and could
  // snag players on empty air beside a pile.
  mesh.rotation.y = seed * 0.71;
  mesh.castShadow = mesh.receiveShadow = true;
  scene.add(mesh);
  if (collide) world.colliders.push(triangleMeshColliderFromMesh(mesh, 'olympus-crag'));
  return mesh;
}

function addOlympusCavernShell(scene, world) {
  // The mountain already supplies exact rectangular visual/collision walls at
  // +/-68 and the palace foundation supplies the ceiling at y=60. Keep those
  // authoritative surfaces visible. Cavern character comes from fitted corner
  // fragments below, not a second curved shell or radial collision field.
  const halfX = 67.94;
  const halfZ = 67.94;
  const floorY = 0.08;

  // Two broad, shadowless cross-lights reveal the baked facets without the
  // per-fragment cost of point-light pools. Olympus already owns strong global
  // lighting; these are restrained enough to keep the exterior palette intact.
  const cavernHemi = new THREE.HemisphereLight(0x8a4b3c, 0x140405, 0.92);
  const cavernRim = new THREE.DirectionalLight(0xff804d, 0.78);
  cavernRim.position.set(-70, 28, 52);
  cavernRim.castShadow = false;
  scene.add(cavernHemi, cavernRim);

  // A single non-overlapping underside ring covers the palace foundation.
  // World-space square UVs preserve the wall artwork's aspect ratio. A seven
  // metre tile matches the six-to-eight-metre scale of the surrounding
  // mountain-wall faces instead of stretching the ceiling artwork. One
  // mesh also removes coplanar seams entirely.
  const ceilingPositions = [];
  const ceilingUvs = [];
  const addCeilingQuad = (minX, maxX, minZ, maxZ) => {
    ceilingPositions.push(
      minX, 59.96, minZ, maxX, 59.96, minZ, maxX, 59.96, maxZ,
      minX, 59.96, minZ, maxX, 59.96, maxZ, minX, 59.96, maxZ,
    );
    ceilingUvs.push(
      minX / 7, minZ / 7, maxX / 7, minZ / 7, maxX / 7, maxZ / 7,
      minX / 7, minZ / 7, maxX / 7, maxZ / 7, minX / 7, maxZ / 7,
    );
  };
  addCeilingQuad(-68, 68, -68, -16);
  addCeilingQuad(-68, 68, 16, 68);
  addCeilingQuad(-68, -8, -16, 16);
  addCeilingQuad(8, 68, -16, 16);
  const ceilingGeometry = new THREE.BufferGeometry();
  ceilingGeometry.setAttribute('position', new THREE.Float32BufferAttribute(ceilingPositions, 3));
  ceilingGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(ceilingUvs, 2));
  ceilingGeometry.computeVertexNormals();
  const ceiling = new THREE.Mesh(ceilingGeometry, mat(0x8d3d2c, {
    tex: 'olympus-rock', repeat: [1, 1], roughness: 1, metalness: 0,
    emissive: 0x180604, emissiveIntensity: 0.3,
    side: THREE.DoubleSide,
  }));
  // The underside faces away from the exterior key light. The cavern's broad
  // hemisphere light now reveals the same rock response as
  // the walls. Avoiding a full-colour emissive map prevents the ceiling from
  // reading as a bright tiled mosaic while still keeping the underside legible.
  ceiling.castShadow = ceiling.receiveShadow = false;
  scene.add(ceiling);

  // Each corner is a single floor-to-ceiling wedge: two wall-fitting backs and
  // one broken diagonal face toward the room, like a cube with its exposed
  // half fractured away. This matches the user's requested fitted-corner rock
  // instead of reading as a square pillar.
  const cornerGeometries = [];
  const addFittedCornerRock = (xSign, zSign, legX, legZ, seed) => {
    const wallX = halfX + 0.10;
    const wallZ = halfZ + 0.10;
    const bottomY = floorY - 0.12;
    const topY = 60.08;
    const positions = [];
    const uvs = [];
    const pushTriangle = (a, b, c, auv, buv, cuv) => {
      positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
      uvs.push(...auv, ...buv, ...cuv);
    };
    const horizontalSegments = 8;
    const verticalSegments = 18;
    const inward = V(-xSign, 0, -zSign).normalize();
    const rows = [];
    let minRowLegX = Infinity;
    let minRowLegZ = Infinity;
    for (let iy = 0; iy <= verticalSegments; iy++) {
      const v = iy / verticalSegments;
      // Slow, non-repeating changes break the ruler-straight silhouette while
      // retaining overlap with both the floor and ceiling at the endpoints.
      const edgeNoise = 0.62 * Math.sin(seed * 0.17 + iy * 0.83)
        + 0.31 * Math.sin(seed * 0.31 + iy * 1.91);
      const rowLegX = legX + edgeNoise;
      const rowLegZ = legZ - edgeNoise * 0.72;
      minRowLegX = Math.min(minRowLegX, rowLegX);
      minRowLegZ = Math.min(minRowLegZ, rowLegZ);
      const a = V(xSign * (wallX - rowLegX), THREE.MathUtils.lerp(bottomY, topY, v), zSign * wallZ);
      const b = V(xSign * wallX, a.y, zSign * (wallZ - rowLegZ));
      const row = [];
      for (let iu = 0; iu <= horizontalSegments; iu++) {
        const u = iu / horizontalSegments;
        const faceFade = Math.sin(Math.PI * u) * Math.sin(Math.PI * v);
        const broadRelief = 0.5 + 0.5 * Math.sin(seed * 0.23 + iu * 1.17 + iy * 0.79);
        const chippedRelief = 0.5 + 0.5 * Math.sin(seed * 0.47 + iu * 2.21 + iy * 1.37);
        const relief = faceFade * (0.24 + 1.06 * (broadRelief * 0.62 + chippedRelief * 0.38));
        row.push(a.clone().lerp(b, u).addScaledVector(inward, relief));
      }
      rows.push(row);
    }
    for (let iy = 0; iy < verticalSegments; iy++) for (let iu = 0; iu < horizontalSegments; iu++) {
      const a = rows[iy][iu];
      const b = rows[iy][iu + 1];
      const c = rows[iy + 1][iu];
      const d = rows[iy + 1][iu + 1];
      const u0 = iu / horizontalSegments * Math.hypot(legX, legZ) / 7;
      const u1 = (iu + 1) / horizontalSegments * Math.hypot(legX, legZ) / 7;
      const v0 = a.y / 7;
      const v1 = c.y / 7;
      pushTriangle(a, c, b, [u0, v0], [u0, v1], [u1, v0]);
      pushTriangle(b, c, d, [u1, v0], [u0, v1], [u1, v1]);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.computeVertexNormals();
    cornerGeometries.push(geometry);

    // Ten inset stair-steps approximate the diagonal wedge from behind. The
    // collision never protrudes beyond the visible rock, while remaining far
    // cheaper than the obsolete hundreds-of-boxes cavern shell.
    const colliderSteps = 10;
    // Use the smallest silhouette measured across every vertical row, then
    // inset it slightly. This keeps the stair-step collision behind the most
    // recessed part of the noisy face at every height.
    const collisionLegX = Math.max(0.1, minRowLegX - 0.12);
    const collisionLegZ = Math.max(0.1, minRowLegZ - 0.12);
    for (let i = 0; i < colliderSteps; i++) {
      const u0 = i / colliderSteps;
      const u1 = (i + 1) / colliderSteps;
      const localX0 = wallX - collisionLegX + u0 * collisionLegX;
      const localX1 = wallX - collisionLegX + u1 * collisionLegX;
      const localZ = wallZ - u0 * collisionLegZ;
      const x0 = xSign * localX0;
      const x1 = xSign * localX1;
      const z0 = zSign * localZ;
      const z1 = zSign * wallZ;
      world.colliders.push({
        type: 'box',
        min: V(Math.min(x0, x1), bottomY, Math.min(z0, z1)),
        max: V(Math.max(x0, x1), topY, Math.max(z0, z1)),
      });
    }
  };

  for (const spec of [
    [-1, -1, 7.6, 8.4, 701],
    [1, -1, 8.2, 7.4, 709],
    [-1, 1, 7.8, 8.7, 719],
    [1, 1, 8.5, 7.7, 727],
  ]) addFittedCornerRock(...spec);

  const cornerGeometry = mergeGeometries(cornerGeometries, false);
  if (cornerGeometry) {
    const corners = new THREE.Mesh(cornerGeometry, mat(0x704238, {
      tex: 'olympus-rock', repeat: [1, 1], roughness: 1, metalness: 0,
      emissive: 0x2e0b08, emissiveIntensity: 0.65,
      flatShading: true, side: THREE.DoubleSide,
    }));
    corners.castShadow = corners.receiveShadow = false;
    scene.add(corners);
  }
  cornerGeometries.forEach(geometry => geometry.dispose());

  // A single tightly joined Greco-Deco gate anchors the south wall. Every
  // structural part overlaps its neighbour slightly and the jambs meet the
  // floor, eliminating the gaps and stray ground curb from the earlier ruin.
  addBox(scene, world, 0, 11.7, 67.54, 19.2, 23.4, 0.50, 0x26121a, {
    shadow: false, tex: 'olympus-rock', repeat: [3, 4],
    debugName: 'olympus-cavern-gate-panel',
  });
  for (const [x, y, w, h, color] of [
    [-11.55, 13.7, 4.2, 27.4, 0xe9d9b3],
    [11.55, 13.7, 4.2, 27.4, 0xe9d9b3],
    [0, 25.5, 27.3, 4.4, 0xd7aa42],
    [0, 28.15, 30.2, 1.25, 0xc78c2c],
    [0, 29.45, 22.2, 1.05, 0xf0d171],
    [0, 23.15, 19.3, 0.9, 0xe8bd58],
  ]) addBox(scene, world, x, y, 67.20, w, h, 0.34, color, {
    shadow: false, tex: 'olympus-palace',
    repeat: [Math.max(1, w / 4), Math.max(1, h / 4)],
    debugName: 'olympus-cavern-gate-frame',
  });
  const ruinSun = new THREE.Mesh(new THREE.RingGeometry(4.1, 5.0, 12), new THREE.MeshStandardMaterial({
    color: 0xe8b63e, emissive: 0x9b4b12, emissiveIntensity: 0.46,
    roughness: 0.48, metalness: 0.38, side: THREE.DoubleSide,
  }));
  ruinSun.position.set(0, 12.2, 66.98);
  ruinSun.rotation.y = Math.PI;
  scene.add(ruinSun);

  // Short, forked fissure networks are flat tapered ribbons, not tubes. A soft
  // orange underlay and a narrower red-hot core sit a few centimetres off the
  // rock, producing a crack-shaped glow without cable-like volume.
  const outerVeinGeometries = [];
  const coreVeinGeometries = [];
  const makeCrackRibbon = (points, surfaceNormal, startWidth, endWidth, offset, target) => {
    const positions = [];
    const uvs = [];
    for (let i = 0; i < points.length; i++) {
      const previous = points[Math.max(0, i - 1)];
      const next = points[Math.min(points.length - 1, i + 1)];
      const tangent = next.clone().sub(previous).normalize();
      const sideways = tangent.clone().cross(surfaceNormal).normalize();
      const width = THREE.MathUtils.lerp(startWidth, endWidth, i / (points.length - 1));
      const centre = points[i].clone().addScaledVector(surfaceNormal, offset);
      const left = centre.clone().addScaledVector(sideways, width * 0.5);
      const right = centre.clone().addScaledVector(sideways, -width * 0.5);
      positions.push(left.x, left.y, left.z, right.x, right.y, right.z);
      uvs.push(0, i / (points.length - 1), 1, i / (points.length - 1));
    }
    const indices = [];
    for (let i = 0; i < points.length - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      indices.push(a, c, b, b, c, d);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    target.push(geometry);
  };
  const addCrackLayers = (points, surfaceNormal, startWidth, endWidth) => {
    // Both layers have real geometric separation from the rock and from one
    // another; polygon offset remains a secondary guard, never the only thing
    // preventing coplanar flicker while the camera moves.
    makeCrackRibbon(points, surfaceNormal, startWidth, endWidth, 0.038, outerVeinGeometries);
    // The hot channel owns just over half of the fracture. A one-third core
    // left too much near-black border and made the faults read as outlined
    // neon decals; this broader channel reads as heat inside split rock.
    makeCrackRibbon(points, surfaceNormal, startWidth * 0.54, endWidth * 0.54, 0.072, coreVeinGeometries);
  };
  const wallCrackPoint = (face, along, y) => {
    const isXWall = face === 'west' || face === 'east';
    const surface = isXWall
      ? (face === 'west' ? -halfX + 0.02 : halfX - 0.02)
      : (face === 'north' ? -halfZ + 0.02 : halfZ - 0.02);
    return isXWall ? V(surface, y, along) : V(along, y, surface);
  };
  const addWallCrackNetwork = (face, along, startY, height, seed, withFloor, widthScale) => {
    const rnd = seededRandom(seed);
    const inward = face === 'west' ? V(1, 0, 0)
      : face === 'east' ? V(-1, 0, 0)
        : face === 'north' ? V(0, 0, 1) : V(0, 0, -1);
    const direction = rnd() > 0.5 ? 1 : -1;
    const main = [];
    for (let i = 0; i <= 9; i++) {
      const t = i / 9;
      // A broad diagonal drift with irregular reversals reads as a split in
      // the rock, not a glowing tree trunk standing against it.
      const offset = direction * height * 0.29 * t
        + Math.sin(t * 14.7 + seed) * (0.55 + t * 0.8)
        + (rnd() - 0.5) * 0.85;
      main.push(wallCrackPoint(face, along + offset, startY + height * t));
    }
    addCrackLayers(main, inward, 2.4 * widthScale, 0.48 * widthScale);
    // Two uneven side fractures avoid the old symmetrical neon-tree shape.
    for (const [index, side] of [[3, -1], [7, 1]]) {
      const origin = main[index];
      const branch = [origin];
      const branchLength = 5.2 + rnd() * 5.4;
      for (let i = 1; i <= 4; i++) {
        const t = i / 4;
        const branchAlong = along + side * branchLength * t + Math.sin(seed + i) * 0.35;
        const branchY = startY + height * (index / 9)
          + (side === direction ? 2.5 : -1.7) * t + (rnd() - 0.5) * 0.65;
        branch.push(wallCrackPoint(face, branchAlong, branchY));
      }
      addCrackLayers(branch, inward, 1.05 * widthScale, 0.22 * widthScale);
    }

    if (withFloor) {
      // Only the low primary fissure on a wall continues across the floor.
      // Secondary high fractures stay on the rock face, avoiding a repeated
      // tree-root silhouette while retaining the best embedded wall/floor join.
      const floorPoints = [];
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        const travel = (face === 'west' || face === 'east' ? 24 : 17) * t;
        const sway = Math.sin(seed * 0.17 + t * 12.3) * (0.3 + t * 0.8);
        if (face === 'west') floorPoints.push(V(-66.28 + travel, floorY + 0.045, along + sway));
        else if (face === 'east') floorPoints.push(V(66.28 - travel, floorY + 0.045, along + sway));
        else if (face === 'north') floorPoints.push(V(along + sway, floorY + 0.045, -67.46 + travel));
        else floorPoints.push(V(along + sway, floorY + 0.045, 67.46 - travel));
      }
      addCrackLayers(floorPoints, V(0, 1, 0), 1.5 * widthScale, 0.32 * widthScale);
    }
  };
  // Two deliberately mismatched faults per wall break the old mirrored look.
  // Several climb into the upper third of the chamber; only four begin at the
  // floor, and every wall uses different drift, width, and branching seeds.
  for (const [face, along, startY, height, seed, withFloor, widthScale] of [
    ['west', -30, 0.14, 39, 511, true, 0.88],
    ['west', 24, 16, 37, 527, false, 0.68],
    ['east', -23, 0.14, 32, 513, true, 0.78],
    ['east', 31, 10, 44, 541, false, 0.96],
    ['south', -29, 0.14, 42, 518, true, 0.84],
    ['south', 34, 18, 31, 557, false, 0.62],
    ['north', -31, 8, 43, 563, false, 0.74],
    ['north', 30, 0.14, 35, 571, true, 0.90],
  ]) addWallCrackNetwork(face, along, startY, height, seed, withFloor, widthScale);

  const roofCrackPoint = (x, z) => V(x, 59.94, z);
  const addRoofCrackNetwork = (x, z, angle, length, seed) => {
    const rnd = seededRandom(seed);
    const dx = Math.cos(angle), dz = Math.sin(angle);
    const main = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      const sway = Math.sin(seed + t * 10) * 0.48 + (rnd() - 0.5) * 0.32;
      main.push(roofCrackPoint(
        x + dx * length * t - dz * sway,
        z + dz * length * t + dx * sway,
      ));
    }
    addCrackLayers(main, V(0, -1, 0), 1.8, 0.38);
    const origin = main[3];
    const branch = [origin];
    for (let i = 1; i <= 3; i++) {
      const t = i / 3;
      branch.push(roofCrackPoint(
        origin.x + (-dz * 4.8 + dx * 1.2) * t,
        origin.z + (dx * 4.8 + dz * 1.2) * t,
      ));
    }
    addCrackLayers(branch, V(0, -1, 0), 0.86, 0.18);
  };
  addRoofCrackNetwork(-39, -27, 0.34, 21, 641);
  const outerVeinGeometry = mergeGeometries(outerVeinGeometries, false);
  const coreVeinGeometry = mergeGeometries(coreVeinGeometries, false);
  if (outerVeinGeometry && coreVeinGeometry) {
    const outerVeinMaterial = new THREE.MeshBasicMaterial({
      color: 0xb52b0e, transparent: true, opacity: 0.78, toneMapped: false,
      depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const coreVeinMaterial = new THREE.MeshBasicMaterial({
      color: 0xff4d12, side: THREE.DoubleSide, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    });
    const outerVeins = new THREE.Mesh(outerVeinGeometry, outerVeinMaterial);
    const coreVeins = new THREE.Mesh(coreVeinGeometry, coreVeinMaterial);
    outerVeins.castShadow = outerVeins.receiveShadow = false;
    coreVeins.castShadow = coreVeins.receiveShadow = false;
    outerVeins.renderOrder = 1;
    coreVeins.renderOrder = 2;
    scene.add(outerVeins, coreVeins);
    world._olympusCoreVeins = coreVeins;
    world.anim.push((dt, t) => {
      const pulse = 0.5 + 0.5 * Math.sin(t * 2.15);
      outerVeinMaterial.opacity = 0.70 + pulse * 0.16;
      outerVeinMaterial.color.setRGB(0.46 + pulse * 0.18, 0.035 + pulse * 0.045, 0.008);
      coreVeinMaterial.color.setRGB(1, 0.16 + pulse * 0.22, 0.02 + pulse * 0.03);
    });
  }
  outerVeinGeometries.forEach(geometry => geometry.dispose());
  coreVeinGeometries.forEach(geometry => geometry.dispose());
}

// Flat-topped volcanic fragments for Olympus Mons sky routes. Their collision
// follows the rotated, tapered low-poly rock itself, including its flat crown.
function addOlympusFloatingRock(scene, world, x, y, z, w, d, depth, seed, cavern = false) {
  const visualDepth = cavern ? Math.min(depth, 3.2) : depth;
  const geo = new THREE.CylinderGeometry(1, 0.42, 1, 7, 2, false);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
    if (py < 0.42) {
      const taper = 0.88 + 0.12 * Math.sin(seed + px * 2.7 + pz * 3.1);
      pos.setXYZ(i, px * taper, py - (0.08 + 0.1 * Math.cos(seed + px)), pz * taper);
    }
  }
  geo.computeVertexNormals();
  const rock = new THREE.Mesh(geo, mat(seed % 2 ? 0x82412f : 0x6f342b, {
    tex: 'olympus-rock', repeat: [2.4, 2.4], roughness: 1, metalness: 0,
    emissive: 0x260d09, emissiveIntensity: 0.16,
  }));
  rock.scale.set(w / 2, visualDepth, d / 2);
  rock.position.set(x, y - visualDepth / 2, z);
  rock.rotation.y = seed * 0.61;
  rock.castShadow = rock.receiveShadow = true;
  scene.add(rock);
  world.colliders.push(triangleMeshColliderFromMesh(rock, 'olympus-floating-rock'));
}

// Upright, grounded volcanic mound. Unlike a floating island, it is broad at
// the floor and narrow at the crown. The rendered cone itself is the collider,
// so every direction around its perimeter is an equivalent walkable approach.
function addOlympusVolcanicMound(scene, world, x, z, w, d, height, seed) {
  const geo = new THREE.CylinderGeometry(0.38, 1, 1, 9, 3, false);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i), py = pos.getY(i), pz = pos.getZ(i);
    const edge = 0.94 + 0.06 * Math.sin(seed + px * 4.1 + pz * 3.7);
    pos.setXYZ(i, px * edge, py, pz * edge);
  }
  geo.computeVertexNormals();
  const mound = new THREE.Mesh(geo, mat(0x743126, {
    tex: 'olympus-rock', repeat: [2.4, 1.4], roughness: 1, flatShading: true,
    emissive: 0x220b08, emissiveIntensity: 0.12,
  }));
  mound.scale.set(w / 2, height, d / 2);
  mound.position.set(x, height / 2, z);
  mound.rotation.y = seed * 0.19;
  mound.castShadow = mound.receiveShadow = true;
  scene.add(mound);
  world.colliders.push(triangleMeshColliderFromMesh(mound, 'olympus-volcanic-mound'));
}

function addOlympusColumn(scene, world, x, z, baseY = 60, height = 17) {
  // A faceted shaft and stepped square capital read as Greco-futurist Art
  // Deco from much farther away than the old three smooth cylinders. The
  // collars stay inside the same footprint, so the visible column and its
  // collision remain in sync in the palace's narrow roof lanes.
  const batch = (world._olympusColumnInstances ||= {});
  const queue = (kind, y, sx, sy, sz) => (batch[kind] ||= []).push({ x, y, z, sx, sy, sz });
  queue('shaft', baseY + 1.05 + (height - 2.25) / 2, 1, height - 2.25, 1);
  queue('plinth', baseY + 0.25, 1.8, 0.5, 1.8);
  queue('base', baseY + 0.8, 1.45, 0.6, 1.45);
  queue('lowerCollar', baseY + 1.18, 0.82, 0.24, 0.82);
  queue('upperCollar', baseY + height - 1.1, 0.8, 0.3, 0.8);
  queue('cap', baseY + height - 0.73, 1.55, 0.55, 1.55);
  queue('abacus', baseY + height - 0.24, 1.9, 0.42, 1.9);
  world.colliders.push({
    type: 'box',
    min: V(x - 0.95, baseY, z - 0.95),
    max: V(x + 0.95, baseY + height, z + 0.95),
  });
}

function flushOlympusColumns(scene, world) {
  const batch = world._olympusColumnInstances;
  if (!batch) return;
  const stone = new THREE.MeshStandardMaterial({ color: 0xf0d5ac, roughness: 0.53, metalness: 0.02 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xc69132, roughness: 0.3, metalness: 0.56 });
  const defs = {
    shaft: [new THREE.CylinderGeometry(0.57, 0.72, 1, 12), stone],
    plinth: [new THREE.BoxGeometry(1, 1, 1), gold],
    base: [new THREE.BoxGeometry(1, 1, 1), stone],
    lowerCollar: [new THREE.CylinderGeometry(1, 1, 1, 12), gold],
    upperCollar: [new THREE.CylinderGeometry(1, 1, 1, 12), gold],
    cap: [new THREE.BoxGeometry(1, 1, 1), stone],
    abacus: [new THREE.BoxGeometry(1, 1, 1), gold],
  };
  const matrix = new THREE.Matrix4();
  const identity = new THREE.Quaternion();
  for (const [kind, instances] of Object.entries(batch)) {
    const [geometry, material] = defs[kind];
    const mesh = new THREE.InstancedMesh(geometry, material, instances.length);
    instances.forEach((inst, i) => {
      matrix.compose(V(inst.x, inst.y, inst.z), identity, V(inst.sx, inst.sy, inst.sz));
      mesh.setMatrixAt(i, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = mesh.receiveShadow = true;
    scene.add(mesh);
  }
  delete world._olympusColumnInstances;
}

function addOlympusStatues(scene, world) {
  const ivory = new THREE.MeshStandardMaterial({ color: 0xc4a878, roughness: 0.58, metalness: 0.02 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xd4a83f, emissive: 0x493008, emissiveIntensity: 0.12, roughness: 0.28, metalness: 0.62 });
  const bronze = new THREE.MeshStandardMaterial({ color: 0x7c4b29, roughness: 0.42, metalness: 0.52 });
  const weaponGold = new THREE.MeshBasicMaterial({ color: 0xffd66a });
  const visor = new THREE.MeshStandardMaterial({ color: 0x28303a, emissive: 0xd4a83f, emissiveIntensity: 0.38, roughness: 0.3, metalness: 0.48 });
  const parts = {
    // These first three geometries exactly mirror buildBotMesh. Their shared
    // proportions make the pantheon unmistakably the same pill people as the
    // combatants, simply monumental and cast in ivory stone.
    body: [new THREE.CapsuleGeometry(0.42, 0.8, 4, 10), ivory],
    head: [new THREE.SphereGeometry(0.3, 12, 10), ivory],
    visor: [new THREE.BoxGeometry(0.42, 0.14, 0.2), visor],
    crown: [new THREE.CylinderGeometry(0.42, 0.31, 0.24, 8), gold],
    halo: [new THREE.TorusGeometry(0.55, 0.065, 6, 20), gold],
    wing: [new THREE.ConeGeometry(0.36, 1.25, 5), gold],
    plume: [new THREE.ConeGeometry(0.22, 1.2, 5), gold],
    ray: [new THREE.BoxGeometry(0.11, 0.72, 0.12), gold],
    staff: [new THREE.CylinderGeometry(0.045, 0.055, 1, 6), bronze],
    blade: [new THREE.BoxGeometry(0.3, 1, 0.14), weaponGold],
    guard: [new THREE.BoxGeometry(0.95, 0.12, 0.2), bronze],
    point: [new THREE.ConeGeometry(0.14, 0.42, 6), gold],
    shield: [new THREE.CylinderGeometry(0.56, 0.56, 0.12, 12), gold],
    bolt: [new THREE.BoxGeometry(0.16, 0.72, 0.16), gold],
  };
  const placements = [
    [-18, 60.5, 43.5, 0, 'hermes'], [18, 60.5, 43.5, 0, 'sun'],
    [-14, 78.5, -52, Math.PI, 'guardian'], [14, 78.5, -52, Math.PI, 'trident'],
    [-25, 90.5, 17, Math.PI / 2, 'winged'], [25, 90.5, 17, -Math.PI / 2, 'thunder'],
  ];
  const transforms = Object.fromEntries(Object.keys(parts).map(key => [key, []]));
  const addPart = (kind, x, y, z, yaw, lx, ly, lz, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0) => {
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    const position = V(x + lx * cos + lz * sin, y + ly, z - lx * sin + lz * cos);
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, yaw, rz));
    transforms[kind].push({ position, quaternion, scale: V(sx, sy, sz) });
  };
  for (const [x, y, z, yaw, myth] of placements) {
    addBox(scene, world, x, y + 0.35, z, 2.3, 0.7, 2.3, 0xc3973d, {
      tex: 'olympus-palace', repeat: [1, 1], metalness: 0.38, roughness: 0.34,
    });
    addBox(scene, world, x, y + 0.83, z, 1.75, 0.26, 1.75, 0xf0d6aa, {
      tex: 'olympus-aether', repeat: [1, 1], roughness: 0.5,
    });
    const rootY = y + 0.96;
    const scale = 2.45;
    addPart('body', x, rootY, z, yaw, 0, 0.85 * scale, 0, scale, scale, scale);
    addPart('head', x, rootY, z, yaw, 0, 1.62 * scale, 0, scale, scale, scale);
    addPart('visor', x, rootY, z, yaw, 0, 1.66 * scale, 0.22 * scale, scale, scale, scale);

    const addWingPair = (small = false) => {
      const wingScale = small ? 0.72 : 1;
      addPart('wing', x, rootY, z, yaw, -0.67, 2.8, -0.54, 0.75 * wingScale, 1.45 * wingScale, 0.34, 0, -0.82);
      addPart('wing', x, rootY, z, yaw, 0.67, 2.8, -0.54, 0.75 * wingScale, 1.45 * wingScale, 0.34, 0, 0.82);
    };
    const addCrest = (spread = 1) => {
      // The crown now clears the pill head and carries a broad three-pronged
      // crest. At arena distance this reads as a headdress, not a tiny hat.
      addPart('crown', x, rootY, z, yaw, 0, 4.66, -0.03, 1.95 * spread, 1.6, 1.95 * spread);
      addPart('plume', x, rootY, z, yaw, -0.52 * spread, 5.2, -0.03, 1.15, 1.05, 1.15, 0, -0.17);
      addPart('plume', x, rootY, z, yaw, 0, 5.34, -0.03, 1.28, 1.34, 1.28);
      addPart('plume', x, rootY, z, yaw, 0.52 * spread, 5.2, -0.03, 1.15, 1.05, 1.15, 0, 0.17);
    };
    const addStaff = (trident = false) => {
      // Weapons float well beside the body, as though held by the same
      // invisible hands as the pill combatants. Their silhouette intentionally
      // reaches beyond the statue so it remains legible across the arena.
      addPart('staff', x, rootY, z, yaw, 1.48, 2.72, 0.04, 2.4, 5.45, 2.4);
      addPart('point', x, rootY, z, yaw, 1.48, 5.68, 0.04, 1.55, 1.55, 1.55);
      if (trident) {
        addPart('staff', x, rootY, z, yaw, 1.08, 5.32, 0.04, 2.1, 1.26, 2.1, 0, -0.38);
        addPart('staff', x, rootY, z, yaw, 1.88, 5.32, 0.04, 2.1, 1.26, 2.1, 0, 0.38);
        addPart('point', x, rootY, z, yaw, 0.91, 5.91, 0.04, 1.38, 1.38, 1.38);
        addPart('point', x, rootY, z, yaw, 2.05, 5.91, 0.04, 1.38, 1.38, 1.38);
      }
    };
    const addSword = () => {
      const swordX = 1.95;
      const swordTilt = -0.1;
      addPart('staff', x, rootY, z, yaw, swordX, 0.78, 0.62, 2.25, 1.05, 2.25, 0, swordTilt);
      addPart('guard', x, rootY, z, yaw, swordX, 1.27, 0.62, 1.5, 1.45, 1.5, 0, swordTilt);
      addPart('blade', x, rootY, z, yaw, swordX, 3.18, 0.62, 2.1, 3.95, 1.7, 0, swordTilt);
      // Continue along the tilted blade axis. The old x offset leaned opposite
      // the blade and left this cone floating between the crown and sword.
      const pointAxisDistance = 3.95 / 2 + (0.42 * 1.32) / 2;
      addPart('point', x, rootY, z, yaw,
        swordX - Math.sin(swordTilt) * pointAxisDistance,
        3.18 + Math.cos(swordTilt) * pointAxisDistance,
        0.62, 1.42, 1.32, 1.42, 0, swordTilt);
    };

    if (myth === 'hermes') {
      addWingPair(true);
      addPart('wing', x, rootY, z, yaw, -0.62, 4.62, -0.06, 0.72, 1.28, 0.34, 0, -0.9);
      addPart('wing', x, rootY, z, yaw, 0.62, 4.62, -0.06, 0.72, 1.28, 0.34, 0, 0.9);
    } else if (myth === 'sun') {
      addPart('halo', x, rootY, z, yaw, 0, 4.18, -0.16, 2.05, 2.05, 2.05);
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        addPart('ray', x, rootY, z, yaw, Math.sin(a) * 1.18, 4.18 + Math.cos(a) * 1.18, -0.16,
          1.35, 1.25, 1.35, 0, -a);
      }
      addCrest(0.9);
    } else if (myth === 'guardian') {
      addSword();
      addPart('shield', x, rootY, z, yaw, -1.05, 2.3, 0.35, 1.4, 1.4, 1.4, Math.PI / 2, 0);
      addCrest(1.05);
    } else if (myth === 'trident') {
      addStaff(true);
      addCrest(1.15);
    } else if (myth === 'winged') {
      addWingPair(false);
      addPart('halo', x, rootY, z, yaw, 0, 4.18, -0.16, 1.9, 1.9, 1.9);
      addPart('wing', x, rootY, z, yaw, -0.58, 4.62, -0.06, 0.62, 1.12, 0.32, 0, -0.84);
      addPart('wing', x, rootY, z, yaw, 0.58, 4.62, -0.06, 0.62, 1.12, 0.32, 0, 0.84);
    } else {
      addCrest(1.1);
      // Three angled segments form an unmistakable lightning bolt without a
      // large translucent effect or another light source.
      addPart('bolt', x, rootY, z, yaw, 1.35, 3.48, 0.34, 1.7, 1.75, 1.7, 0, 0.55);
      addPart('bolt', x, rootY, z, yaw, 1.02, 2.5, 0.34, 1.7, 1.75, 1.7, 0, -0.48);
      addPart('point', x, rootY, z, yaw, 0.7, 1.65, 0.34, 1.55, 1.9, 1.55, 0, 0.5);
    }
  }
  const matrix = new THREE.Matrix4();
  for (const [kind, instances] of Object.entries(transforms)) {
    const [geometry, material] = parts[kind];
    const mesh = new THREE.InstancedMesh(geometry, material, instances.length);
    instances.forEach((inst, i) => {
      matrix.compose(inst.position, inst.quaternion, inst.scale);
      mesh.setMatrixAt(i, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    scene.add(mesh);
  }
}

function addOlympusDecoArchitecture(scene, world) {
  const gold = 0xd4a63a;
  const darkGold = 0x936426;
  const ivory = 0xf1ddba;

  // Tall, recessed-looking fins break the broad palace boxes into a repeated
  // vertical rhythm. They sit just beyond the wall faces and never intrude on
  // combat space.
  for (const side of [-1, 1]) for (const z of [-18, -9, 9, 18]) {
    addBox(scene, world, side * 63.56, 67.3, z, 0.12, 10.8, 0.72, gold, {
      collide: false, shadow: false, metalness: 0.48, roughness: 0.31,
    });
    addBox(scene, world, side * 63.64, 67.3, z, 0.1, 6.4, 1.25, darkGold, {
      collide: false, shadow: false, metalness: 0.44, roughness: 0.35,
    });
  }
  for (const x of [-20, -12, 12, 20]) addBox(scene, world, x, 69.1, -63.56, 0.7, 13.2, 0.12, gold, {
    collide: false, shadow: false, metalness: 0.5, roughness: 0.3,
  });

  // A stepped crown gives the Aether façade a ceremonial skyline. Its central
  // opening preserves the sign below and the sky slit behind it. These ledges
  // are reachable with the jetpack, so their visible boxes must be solid.
  for (const [y, width] of [[103.8, 42], [105.15, 31], [106.5, 20], [107.85, 9]]) {
    addBox(scene, world, 0, y, 39.2, width, 0.72, 1.15, y > 106 ? gold : ivory, {
      shadow: false, tex: 'olympus-aether', repeat: [Math.max(1, width / 8), 1],
      metalness: y > 106 ? 0.42 : 0.08, roughness: 0.36,
    });
  }
  for (const side of [-1, 1]) for (const z of [16, 24, 32]) {
    addBox(scene, world, side * 32.06, 96.2, z, 0.12, 8.8, 0.65, gold, {
      collide: false, shadow: false, metalness: 0.52, roughness: 0.3,
    });
  }

  // Paired geometric pylons frame the central court without narrowing its
  // north-south circulation lane.
  for (const x of [-58, 58]) for (const z of [35, 43]) {
    addBox(scene, world, x, 63, z, 2.5, 5, 2.5, ivory, { tex: 'olympus-aether', repeat: [1, 2] });
    addBox(scene, world, x, 66.05, z, 3.3, 1.1, 3.3, gold, {
      tex: 'olympus-palace', repeat: [1, 1], metalness: 0.46, roughness: 0.32,
    });
    addBox(scene, world, x, 67.2, z, 1.7, 1.2, 1.7, darkGold, {
      tex: 'olympus-palace', repeat: [1, 1], metalness: 0.48, roughness: 0.32,
    });
  }
}

function addOlympusBrazier(scene, world, x, baseY, z, flameColor = 0xff8a32) {
  const bronze = new THREE.MeshStandardMaterial({
    color: 0x8f5728, roughness: 0.34, metalness: 0.62,
  });
  const fire = new THREE.MeshBasicMaterial({ color: flameColor });
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.52, 1.15, 10), bronze);
  stem.position.set(x, baseY + 0.58, z);
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.92, 0.48, 0.42, 12), bronze);
  bowl.position.set(x, baseY + 1.27, z);
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.48, 1.18, 9), fire);
  flame.position.set(x, baseY + 2.02, z);
  stem.castShadow = bowl.castShadow = true;
  scene.add(stem, bowl, flame);
  world.colliders.push({
    type: 'box', min: V(x - 0.82, baseY, z - 0.82), max: V(x + 0.82, baseY + 1.5, z + 0.82),
  });
}

// Conservatory foliage is accumulated and emitted as seven instanced meshes.
// The original version created roughly one hundred independently shaded,
// shadow-casting meshes here, which made the otherwise small dome GPU-heavy.
function conservatoryInstance(world, kind, position, quaternion, scale, color) {
  const batch = (world._conservatoryInstances ||= {});
  (batch[kind] ||= []).push({ position, quaternion, scale, color });
}

function addOlympusConservatoryPlant(scene, world, x, baseY, z, scale = 1, seed = 1, hanging = false) {
  const rnd = seededRandom(0x5a17 + seed * 97);
  const identity = new THREE.Quaternion();
  const planterY = hanging ? baseY : baseY + 0.48 * scale;
  conservatoryInstance(world, 'pot', V(x, planterY, z), identity, V(scale, scale, scale), hanging ? 0xb88748 : 0xe0c08b);
  if (hanging) {
    const chainH = 4.2 * scale;
    conservatoryInstance(world, 'chain', V(x, baseY + chainH / 2, z), identity, V(scale, chainH, scale), 0x8d7138);
  } else world.colliders.push({
    type: 'box',
    min: V(x - 0.58 * scale, baseY, z - 0.58 * scale),
    max: V(x + 0.58 * scale, baseY + 0.96 * scale, z + 0.58 * scale),
  });

  const stemH = (hanging ? 1.05 : 2.25) * scale;
  const stemY = hanging ? baseY - 0.48 * scale - stemH / 2 : baseY + 0.86 * scale + stemH / 2;
  conservatoryInstance(world, 'stem', V(x, stemY, z), identity, V(scale, stemH, scale), 0x496332);
  const crownY = hanging ? baseY - 0.48 * scale - stemH : baseY + 0.86 * scale + stemH;
  const leafColors = [0x315e3a, 0x3f7d46, 0x5a914b, 0x2c6a55];
  for (let i = 0; i < 8; i++) {
    const angle = i * Math.PI * 0.25 + rnd() * 0.28;
    const rise = hanging ? -0.48 - rnd() * 0.55 : 0.05 + rnd() * 0.4;
    const dir = new THREE.Vector3(Math.cos(angle), rise, Math.sin(angle)).normalize();
    const len = (1.65 + rnd() * 1.05) * scale;
    const width = ((0.32 + rnd() * 0.12) / 0.36) * scale;
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    conservatoryInstance(
      world, 'leaf', V(x, crownY, z).addScaledVector(dir, len * 0.45), q,
      V(width, len, width), leafColors[(i + seed) % leafColors.length],
    );
  }
}

function addOlympusConservatoryTree(scene, world, x, baseY, z, height = 6, seed = 1) {
  const rnd = seededRandom(0x71ee + seed * 131);
  const leanX = (rnd() - 0.5) * 0.65;
  const leanZ = (rnd() - 0.5) * 0.65;
  const trunkQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(leanZ / height, 0, -leanX / height));
  conservatoryInstance(world, 'trunk', V(x + leanX * 0.5, baseY + height / 2, z + leanZ * 0.5), trunkQ,
    V(1, height, 1), 0x665235);

  const crownY = baseY + height;
  const colors = [0x285c3b, 0x397a42, 0x4d8b48, 0x2f6f50];
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * Math.PI * 2 + rnd() * 0.35;
    const radius = 1.1 + rnd() * 0.75;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd() * 0.6, rnd() * Math.PI, rnd() * 0.45));
    conservatoryInstance(world, 'canopy', V(
      x + leanX + Math.cos(a) * (0.7 + rnd() * 0.8),
      crownY - 0.3 + (rnd() - 0.5) * 1.4,
      z + leanZ + Math.sin(a) * (0.7 + rnd() * 0.8),
    ), q, V(radius * (1.2 + rnd() * 0.45), radius * (0.72 + rnd() * 0.3), radius * (1.1 + rnd() * 0.5)),
    colors[(seed + i) % colors.length]);
  }
  for (let i = 0; i < 3; i++) {
    const vineH = 1.7 + rnd() * 2.2;
    const a = rnd() * Math.PI * 2;
    conservatoryInstance(world, 'vine', V(x + Math.cos(a) * 1.2, crownY - vineH / 2, z + Math.sin(a) * 1.2),
      new THREE.Quaternion(), V(1, vineH, 1), 0x487b35);
  }
}

function flushOlympusConservatoryFoliage(scene, world) {
  const batch = world._conservatoryInstances;
  if (!batch) return;
  const defs = {
    pot: [new THREE.CylinderGeometry(0.72, 0.54, 0.96, 8), { roughness: 0.52, metalness: 0.12 }],
    chain: [new THREE.CylinderGeometry(0.045, 0.045, 1, 5), { roughness: 0.34, metalness: 0.7 }],
    stem: [new THREE.CylinderGeometry(0.1, 0.16, 1, 6), { roughness: 0.94 }],
    leaf: [new THREE.ConeGeometry(0.36, 1, 5), { roughness: 0.88, flatShading: true }],
    trunk: [new THREE.CylinderGeometry(0.2, 0.34, 1, 7), { roughness: 0.98 }],
    canopy: [new THREE.IcosahedronGeometry(1, 1), { roughness: 0.94, flatShading: true }],
    vine: [new THREE.CylinderGeometry(0.035, 0.055, 1, 5), { roughness: 0.96 }],
  };
  const matrix = new THREE.Matrix4();
  for (const [kind, instances] of Object.entries(batch)) {
    const def = defs[kind];
    if (!def || !instances.length) continue;
    const mesh = new THREE.InstancedMesh(def[0], new THREE.MeshStandardMaterial({ color: 0xffffff, ...def[1] }), instances.length);
    instances.forEach((inst, i) => {
      matrix.compose(inst.position, inst.quaternion, inst.scale);
      mesh.setMatrixAt(i, matrix);
      mesh.setColorAt(i, new THREE.Color(inst.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = mesh.receiveShadow = false;
    scene.add(mesh);
  }
  delete world._conservatoryInstances;
}

function addOlympusConservatoryDome(scene, world, x, baseY, z) {
  const rx = 21, ry = 18, rz = 16;
  const oculusTheta = 0.22;
  const doorwayFrameHeight = 6.2;
  const doorwayTheta = Math.acos(doorwayFrameHeight / ry);
  const angleDelta = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  const doorwayAngles = [Math.PI, Math.PI * 1.5]; // west terrace + north processional hall

  // One low-poly glass mesh replaces the old closed hemisphere. Cells are
  // omitted at both palace approaches and around the crown, so the visible
  // shell now has the same two doors and jetpack oculus as its collision.
  const glassPositions = [];
  const glassAzimuths = 24;
  const glassStep = Math.PI * 2 / glassAzimuths;
  const doorwayHalfAngle = glassStep / 2;
  // Make the glass edge land exactly at the lintel height instead of dropping
  // an entire coarse band above it. That keeps both doors flush with their
  // gold frames from inside and outside the conservatory.
  const glassThetaEdges = [
    ...Array.from({ length: 8 }, (_, i) => oculusTheta + (doorwayTheta - oculusTheta) * i / 7),
    ...Array.from({ length: 2 }, (_, i) => doorwayTheta + (Math.PI / 2 - doorwayTheta) * (i + 1) / 2),
  ];
  const domePoint = (theta, phi) => V(
    x + rx * Math.sin(theta) * Math.cos(phi),
    baseY + ry * Math.cos(theta),
    z + rz * Math.sin(theta) * Math.sin(phi),
  );
  const pushTri = (a, b, c) => glassPositions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  for (let band = 0; band < glassThetaEdges.length - 1; band++) {
    const theta0 = glassThetaEdges[band];
    const theta1 = glassThetaEdges[band + 1];
    for (let i = 0; i < glassAzimuths; i++) {
      const phi = i * glassStep;
      const isDoor = theta0 >= doorwayTheta - 1e-6 && doorwayAngles.some(a => angleDelta(phi, a) < glassStep * 0.55);
      if (isDoor) continue;
      const phi0 = phi - glassStep / 2, phi1 = phi + glassStep / 2;
      const a = domePoint(theta0, phi0), b = domePoint(theta1, phi0);
      const c = domePoint(theta1, phi1), d = domePoint(theta0, phi1);
      pushTri(a, b, c); pushTri(a, c, d);
    }
  }
  const glassGeo = new THREE.BufferGeometry();
  glassGeo.setAttribute('position', new THREE.Float32BufferAttribute(glassPositions, 3));
  glassGeo.computeVertexNormals();
  // Players spend time inside this dome, where its broad transparent surface
  // covers much of the screen. It is a decorative tint, so an unlit material
  // avoids running the full PBR + point-light path over every covered pixel.
  const glass = new THREE.Mesh(glassGeo, new THREE.MeshBasicMaterial({
    color: 0x9fe7df, transparent: true, opacity: 0.17,
    side: THREE.DoubleSide, depthWrite: false,
  }));
  // Vertices were emitted in world space so the doorway cuts align exactly
  // with the separately generated shell colliders and frames.
  glass.position.set(0, 0, 0);
  // Double-sided transparent materials normally render two passes. A single
  // pass is enough for this broad tint and avoids doubling the dome cost.
  glass.material.forceSinglePass = true;
  glass.renderOrder = 3;
  scene.add(glass);

  const frameMat = new THREE.MeshStandardMaterial({
    color: 0xc99c3f, emissive: 0x4e3308, emissiveIntensity: 0.16,
    roughness: 0.3, metalness: 0.62,
  });
  const frameGeometries = [];
  const tube = (points, radius = 0.13, closed = false) => {
    const curve = new THREE.CatmullRomCurve3(points, closed, closed ? 'centripetal' : 'catmullrom', 0.4);
    frameGeometries.push(new THREE.TubeGeometry(curve, 28, radius, 5, closed));
  };
  const doorwayFrameTop = baseY + doorwayFrameHeight + 0.25;
  const isInsideDoorwayClearance = (point) => {
    if (point.y > doorwayFrameTop) return false;
    const phi = Math.atan2((point.z - z) / rz, (point.x - x) / rx);
    return doorwayAngles.some(angle => angleDelta(phi, angle) < 0.215);
  };
  const tubeOutsideDoorways = (points, radius = 0.13) => {
    let visible = [];
    const flush = () => {
      if (visible.length >= 2) tube(visible, radius);
      visible = [];
    };
    for (const point of points) {
      if (isInsideDoorwayClearance(point)) flush();
      else visible.push(point);
    }
    flush();
  };

  // Radial greenhouse ribs stop at the oculus instead of crossing it. Latitude
  // bands make the shell read as architecture rather than a force field. All
  // ribs are clipped against the same doorway volumes as the glass/colliders,
  // so later dome edits cannot leave decorative pipes across a usable route.
  for (const azimuth of [0, Math.PI / 4, Math.PI / 2, Math.PI * 3 / 4]) {
    for (const [start, end] of [[0, Math.PI / 2 - oculusTheta], [Math.PI / 2 + oculusTheta, Math.PI]]) {
      const points = [];
      for (let i = 0; i <= 24; i++) {
        const t = start + (end - start) * i / 24;
        points.push(V(
          x + rx * Math.cos(t) * Math.cos(azimuth),
          baseY + ry * Math.sin(t),
          z + rz * Math.cos(t) * Math.sin(azimuth),
        ));
      }
      tubeOutsideDoorways(points, 0.14);
    }
  }
  for (const elevation of [0.08, 0.34, 0.62, 1 - oculusTheta / (Math.PI / 2)]) {
    const angle = elevation * Math.PI / 2;
    const points = [];
    const ringRx = rx * Math.cos(angle), ringRz = rz * Math.cos(angle);
    // Begin inside the west opening and include the closing sample. That lets
    // the clipping helper emit clean visible arcs without a seam elsewhere.
    for (let i = 0; i <= 96; i++) {
      const a = Math.PI + i / 96 * Math.PI * 2;
      points.push(V(x + ringRx * Math.cos(a), baseY + ry * Math.sin(angle), z + ringRz * Math.sin(a)));
    }
    tubeOutsideDoorways(points, elevation < 0.1 ? 0.2 : 0.11);
  }
  const frameGeo = mergeGeometries(frameGeometries, false);
  if (frameGeo) {
    const frame = new THREE.Mesh(frameGeo, frameMat);
    frame.castShadow = frame.receiveShadow = false;
    scene.add(frame);
    frameGeometries.forEach(geo => geo.dispose());
  }

  // Five coarse ellipsoid bands provide a dependable shell collider without
  // adding render meshes. The lower north/west segments are deliberately
  // absent for the two doors; the polar cap is absent for the open oculus.
  const colliderAzimuths = 16;
  const colliderStep = Math.PI * 2 / colliderAzimuths;
  const thetaEdges = [oculusTheta, 0.47, 0.72, 0.98, doorwayTheta, Math.PI / 2];
  for (let band = 0; band < thetaEdges.length - 1; band++) {
    const theta0 = thetaEdges[band], theta1 = thetaEdges[band + 1];
    for (let i = 0; i < colliderAzimuths; i++) {
      const phi = i * colliderStep;
      const isDoor = band === thetaEdges.length - 2 &&
        doorwayAngles.some(a => angleDelta(phi, a) < colliderStep * 0.55);
      if (isDoor) continue;
      const samples = [];
      for (const theta of [theta0, (theta0 + theta1) / 2, theta1]) {
        for (const samplePhi of [phi - colliderStep / 2, phi, phi + colliderStep / 2]) {
          samples.push(domePoint(theta, samplePhi));
        }
      }
      const min = V(Infinity, Infinity, Infinity), max = V(-Infinity, -Infinity, -Infinity);
      for (const p of samples) { min.min(p); max.max(p); }
      min.addScalar(-0.16); max.addScalar(0.16);
      world.colliders.push({ type: 'box', min, max });
    }
  }

  // Gold jambs follow the same cell edges as the glass opening. The previous
  // hand-set widths left a visible moat between each pane and its frame.
  const frameThickness = 0.45;
  const northDoorHalfWidth = rx * Math.sin(doorwayHalfAngle);
  const westDoorHalfWidth = rz * Math.sin(doorwayHalfAngle);
  for (const side of [-1, 1]) addBox(scene, world, side * (northDoorHalfWidth + frameThickness / 2), baseY + doorwayFrameHeight / 2, z - rz, frameThickness, doorwayFrameHeight, frameThickness, 0xc99c3f, {
    metalness: 0.62, roughness: 0.3,
  });
  addBox(scene, world, 0, baseY + doorwayFrameHeight, z - rz, (northDoorHalfWidth + frameThickness) * 2, frameThickness, frameThickness, 0xc99c3f, {
    metalness: 0.62, roughness: 0.3,
  });
  for (const side of [-1, 1]) addBox(scene, world, x - rx, baseY + doorwayFrameHeight / 2, z + side * (westDoorHalfWidth + frameThickness / 2), frameThickness, doorwayFrameHeight, frameThickness, 0xc99c3f, {
    metalness: 0.62, roughness: 0.3,
  });
  addBox(scene, world, x - rx, baseY + doorwayFrameHeight, z, frameThickness, frameThickness, (westDoorHalfWidth + frameThickness) * 2, 0xc99c3f, {
    metalness: 0.62, roughness: 0.3,
  });

  // The frame's emissive gold supplies the same warm greenhouse read without
  // adding another per-pixel point-light loop to every material in the scene.
  frameMat.emissiveIntensity = 0.28;
}

function addOlympusTower(scene, world, x, z, baseY, height = 22, width = 9) {
  const lowerHeight = height * 0.84;
  const lowerTop = baseY + lowerHeight;
  addBox(scene, world, x, baseY + lowerHeight / 2, z, width, lowerHeight, width, 0xd7b98d, {
    tex: 'olympus-relief', repeat: [2, 5],
  });
  addBox(scene, world, x, lowerTop + 1.3, z, width + 1.8, 2.6, width + 1.8, 0xb88748, {
    tex: 'olympus-palace', repeat: [3, 1],
  });
  const ledgeTop = lowerTop + 2.6;
  addBox(scene, world, x, ledgeTop + 1.5, z, width * 0.66, 3, width * 0.66, 0xe4c692, {
    tex: 'olympus-palace', repeat: [2, 1],
  });
  const upperTop = ledgeTop + 3;
  addBox(scene, world, x, upperTop + 1, z, width * 0.8, 2, width * 0.8, 0xc69132, {
    tex: 'olympus-palace', repeat: [2, 1], metalness: 0.42, roughness: 0.32,
  });
  addBox(scene, world, x, upperTop + 2.75, z, width * 0.48, 1.5, width * 0.48, 0xe0b851, {
    tex: 'olympus-palace', repeat: [1, 1], metalness: 0.48, roughness: 0.3,
  });
}

function addOlympusBanner(scene, x, y, z, yaw, color) {
  const cloth = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 7), new THREE.MeshStandardMaterial({
    color, emissive: color, emissiveIntensity: 0.1, roughness: 0.82,
    side: THREE.DoubleSide,
  }));
  cloth.position.set(x, y, z);
  cloth.rotation.y = yaw;
  cloth.castShadow = true;
  scene.add(cloth);
}

const OLYMPUS_BASE_RADIUS = 88;
const OLYMPUS_SUMMIT_RADIUS = 68;
const OLYMPUS_SUMMIT_Y = 60;

function olympusSurfaceY(x, z) {
  const r = Math.max(Math.abs(x), Math.abs(z));
  if (r <= OLYMPUS_SUMMIT_RADIUS) return OLYMPUS_SUMMIT_Y;
  if (r <= 72) return THREE.MathUtils.lerp(60, 38, (r - 68) / 4);
  if (r <= 76) return 38;
  if (r <= 80) return THREE.MathUtils.lerp(38, 12, (r - 76) / 4);
  if (r <= 84) return 12;
  if (r < OLYMPUS_BASE_RADIUS) return THREE.MathUtils.lerp(12, 0.08, (r - 84) / 4);
  return 0.08;
}

function addOlympusMountain(scene, world) {
  // The visible cliff and its collision are now the exact same five boxes.
  // This removes the several-metre mismatch created by a noisy heightfield
  // drawn over a simpler invisible collision ring.
  for (const [x, z, w, d, repeat] of [
    [-78, 0, 20, 176, [7, 28]], [78, 0, 20, 176, [7, 28]],
    [0, 78, 136, 20, [22, 7]],
    [-38, -78, 60, 20, [10, 7]], [38, -78, 60, 20, [10, 7]],
  ]) addBox(scene, world, x, 30, z, w, 60, d, 0x8d3d2c, {
    tex: 'olympus-rock', repeat, roughness: 1, metalness: 0,
  });
}

// Meteors need the highest walkable surface under a random X/Z position. The
// Olympus palace has a large collider set, so indexing those static colliders
// at map build time avoids a full-map scan when a meteor is launched.
/* ================= MAP 7 — TIDEBREAKER (storm-lashed offshore platform) =================
   A low processing deck sits between two raised evacuation routes. The warning
   sirens are gameplay: a modeled surge crosses the low deck, floods it a bit
   above waist height, then continuously drains until the deck is dry again.
   Ocean, flood, rain, spray, crane, and beacon animation all scale through
   the map's visual-quality hook. */
function buildTidebreaker(scene) {
  const world = newWorld({
    // Falling from the rig enters the ocean rather than an instant void. The
    // emergency kill plane is far below the playable water column and exists
    // only as a numerical safety net if something escapes the volume.
    killY: -260,
    waypointLinkDist: 23,
    waypointLinkDy: 4.8,
    waypointLinkClearance: 0.45,
    toneMappingExposure: 0.94,
  });
  scene.background = new THREE.Color(0x172531);
  // Fog far sits inside the ocean extent so the horizon reads as open water
  // instead of a hard plane edge from the ops roof or crane.
  scene.fog = new THREE.Fog(0x172531, 96, 560);

  const sky = addStormCloudDome(scene);
  sky.material.opacity = 0.96;
  scene.add(new THREE.HemisphereLight(0xa7c8d7, 0x101820, 1.55));
  scene.add(new THREE.AmbientLight(0xb8cad2, 0.24));
  const stormLight = new THREE.DirectionalLight(0xd9e7ec, 2.25);
  stormLight.position.set(-72, 115, -48);
  stormLight.castShadow = true;
  stormLight.shadow.mapSize.set(1024, 1024);
  Object.assign(stormLight.shadow.camera, {
    left: -105, right: 105, top: 105, bottom: -105, near: 18, far: 300,
  });
  stormLight.shadow.bias = -0.0002;
  stormLight.shadow.normalBias = 0.6;
  scene.add(stormLight, stormLight.target);

  const essential = new THREE.Group();
  const standard = new THREE.Group();
  const high = new THREE.Group();
  essential.name = 'tidebreaker-essential-presentation';
  standard.name = 'tidebreaker-standard-presentation';
  high.name = 'tidebreaker-high-presentation';
  scene.add(essential, standard, high);

  const steel = 0xffffff;
  const darkSteel = 0x26323a;
  const railSteel = 0xb5c2c7;
  const emergencyOrange = 0xffffff;
  const wetDeck = { tex: 'tidebreaker-deck', roughness: 0.43, metalness: 0.38, envMapIntensity: 0.92 };
  const orangeSteel = { tex: 'tidebreaker-orange-steel', roughness: 0.58, metalness: 0.32, envMapIntensity: 0.72 };

  // The ocean is three interchangeable meshes, never three simultaneous draw
  // calls. Vertex displacement combines directional swells with short chop;
  // the fragment normal comes from the deformed surface itself.
  const waterVertex = `
    #include <fog_pars_vertex>
    uniform float uTime;
    uniform float uAmplitude;
    uniform float uChop;
    varying vec3 vWorldPosition;
    varying float vElevation;
    void main() {
      vec3 p = position;
      float h = sin(p.x * 0.038 + p.y * 0.021 + uTime * 0.92) * uAmplitude;
      h += sin(p.x * -0.021 + p.y * 0.054 + uTime * 1.28) * uAmplitude * 0.54;
      h += sin(p.x * 0.112 + p.y * -0.083 + uTime * 2.05) * uChop;
      h += sin((p.x + p.y) * 0.19 - uTime * 2.75) * uChop * 0.34;
      p.z += h;
      vec4 worldPosition = modelMatrix * vec4(p, 1.0);
      vWorldPosition = worldPosition.xyz;
      vElevation = h;
      vec4 mvPosition = viewMatrix * worldPosition;
      gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }
  `;
  const waterFragment = `
    #include <fog_pars_fragment>
    uniform vec3 uDeep;
    uniform vec3 uShallow;
    uniform float uOpacity;
    uniform float uFoamLine;
    varying vec3 vWorldPosition;
    varying float vElevation;
    void main() {
      vec3 dx = dFdx(vWorldPosition);
      vec3 dy = dFdy(vWorldPosition);
      vec3 normal = normalize(cross(dx, dy));
      if (normal.y < 0.0) normal *= -1.0;
      vec3 viewDir = normalize(cameraPosition - vWorldPosition);
      float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 2.35);
      float light = max(dot(normal, normalize(vec3(-0.35, 0.86, -0.22))), 0.0);
      vec3 color = mix(uDeep, uShallow, 0.24 + light * 0.4 + fresnel * 0.28);
      float foamBreakup = sin(vWorldPosition.x * 0.63 + vWorldPosition.z * 0.27) * 0.11
        + sin(vWorldPosition.x * -0.31 + vWorldPosition.z * 0.74) * 0.07;
      float foam = smoothstep(uFoamLine + foamBreakup, uFoamLine + 0.18 + foamBreakup, vElevation);
      color = mix(color, vec3(0.72, 0.88, 0.91), foam * 0.1);
      gl_FragColor = vec4(color, uOpacity);
      #include <fog_fragment>
    }
  `;
  const waterMaterial = (deep, shallow, amplitude, chop, opacity, foamLine) => new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uAmplitude: { value: amplitude },
        uChop: { value: chop },
        uDeep: { value: new THREE.Color(deep) },
        uShallow: { value: new THREE.Color(shallow) },
        uOpacity: { value: opacity },
        uFoamLine: { value: foamLine },
      },
    ]),
    vertexShader: waterVertex,
    fragmentShader: waterFragment,
    transparent: opacity < 1,
    depthWrite: opacity >= 0.95,
    side: THREE.DoubleSide,
    fog: true,
  });

  const oceanSurfaceY = -7.25;
  const oceanBottomY = -240;
  const oceanSize = 1600;
  const oceanHalf = oceanSize * 0.5;
  const oceanMat = waterMaterial(0x061c29, 0x1b5a6c, 1.42, 0.34, 1, 1.72);
  // One shared material, three LOD meshes. Size clears fog + camera far so the
  // sea never ends in a visible cliff; segment counts stay modest because fog
  // already softens distant chop.
  const oceanMeshes = [
    new THREE.Mesh(new THREE.PlaneGeometry(oceanSize, oceanSize, 48, 48), oceanMat),
    new THREE.Mesh(new THREE.PlaneGeometry(oceanSize, oceanSize, 84, 84), oceanMat),
    new THREE.Mesh(new THREE.PlaneGeometry(oceanSize, oceanSize, 140, 140), oceanMat),
  ];
  for (const mesh of oceanMeshes) {
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = oceanSurfaceY;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    scene.add(mesh);
  }
  const oceanZone = {
    minX: -oceanHalf, maxX: oceanHalf, minZ: -oceanHalf, maxZ: oceanHalf,
    surfaceY: oceanSurfaceY, bottomY: oceanBottomY,
    openOcean: true,
  };
  world.waterZones = [oceanZone];

  // Heavy legs, diagonal braces, and caissons establish the platform above the
  // animated sea without turning under-map decoration into collision clutter.
  const supportMat = mat(0x56636a, { roughness: 0.64, metalness: 0.52 });
  const supportGeometries = [];
  const cylinderBetween = (start, end, radius, radial = 8) => {
    const delta = end.clone().sub(start);
    const geo = new THREE.CylinderGeometry(radius, radius, delta.length(), radial, 1);
    geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), delta.clone().normalize()));
    geo.translate((start.x + end.x) / 2, (start.y + end.y) / 2, (start.z + end.z) / 2);
    return geo;
  };
  for (const x of [-58, -20, 20, 58]) for (const z of [-26, 26]) {
    // Stop under the processing-deck underside (top is y=0) so the column
    // caps never sit coplanar with the walkable slab and z-fight.
    const legTopY = -1.18;
    supportGeometries.push(cylinderBetween(V(x, -210, z), V(x, legTopY, z), 1.1, 10));
    world.colliders.push({
      type: 'box',
      min: V(x - 0.9, -210, z - 0.9),
      max: V(x + 0.9, legTopY, z + 0.9),
    });
    const braceX = x < 0 ? x + 9 : x - 9;
    supportGeometries.push(cylinderBetween(V(x, -11.5, z), V(braceX, -0.6, z), 0.34, 6));
  }
  const supports = new THREE.Mesh(mergeGeometries(supportGeometries, false), supportMat);
  supports.castShadow = supports.receiveShadow = true;
  essential.add(supports);
  supportGeometries.forEach(g => g.dispose());

  // Three low-poly sharks patrol below the swell. Only one commits to a
  // swimmer at a time; after biting it breaks away briefly, making the exact
  // two-second damage cooldown readable rather than looking like contact DPS.
  const SHARK_TOP = 0x4d5354;
  const SHARK_UPPER_SIDE = 0x707676;
  const SHARK_BELLY = 0xf1eee5;
  const SHARK_FIN_EDGE = 0x454a4a;
  const sharkMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.82, metalness: 0.025,
    flatShading: true, side: THREE.DoubleSide,
  });
  const sharkDetailMat = new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.DoubleSide, toneMapped: false,
  });
  const pushSharkTri = (positions, colors, a, b, c, color) => {
    positions.push(...a, ...b, ...c);
    const r = ((color >> 16) & 255) / 255;
    const g = ((color >> 8) & 255) / 255;
    const bl = (color & 255) / 255;
    for (let n = 0; n < 3; n++) colors.push(r, g, bl);
  };
  const sharkMeshFromTris = (positions, colors) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, sharkMat);
  };
  const buildSharkBody = () => {
    const positions = [];
    const colors = [];
    // Broad, blunt head and a hard taper into the tail reproduce the reference's
    // unmistakable low-poly great-white silhouette. +X is forward.
    const stations = [
      [3.35, 0.42, 0.34, -0.30],
      [3.02, 0.82, 0.62, -0.58],
      [2.30, 0.98, 0.78, -0.72],
      [1.10, 1.04, 0.86, -0.78],
      [-0.25, 0.94, 0.82, -0.70],
      [-1.35, 0.68, 0.61, -0.50],
      [-2.15, 0.38, 0.36, -0.30],
      [-2.75, 0.18, 0.18, -0.15],
    ];
    const ring = (x, halfW, topY, botY) => {
      const midY = (topY + botY) * 0.5;
      return [
        [x, topY, 0],
        [x, topY * 0.70 + midY * 0.30, halfW * 0.72],
        [x, midY * 0.12, halfW],
        [x, botY * 0.68 + midY * 0.32, halfW * 0.78],
        [x, botY, 0],
        [x, botY * 0.68 + midY * 0.32, -halfW * 0.78],
        [x, midY * 0.12, -halfW],
        [x, topY * 0.70 + midY * 0.30, -halfW * 0.72],
      ];
    };
    const rings = stations.map(([x, w, ty, by]) => ring(x, w, ty, by));
    const panelColors = [
      SHARK_TOP, SHARK_UPPER_SIDE, SHARK_BELLY, SHARK_BELLY,
      SHARK_BELLY, SHARK_BELLY, SHARK_UPPER_SIDE, SHARK_TOP,
    ];
    for (let s = 0; s < rings.length - 1; s++) {
      const a = rings[s], b = rings[s + 1];
      for (let i = 0; i < 8; i++) {
        const j = (i + 1) % 8;
        const color = panelColors[i];
        pushSharkTri(positions, colors, a[i], a[j], b[j], color);
        pushSharkTri(positions, colors, a[i], b[j], b[i], color);
      }
    }
    // Faceted end caps keep the snout broad instead of capsule-round.
    for (const [ringVerts, center, reverse] of [
      [rings[0], [stations[0][0] + 0.08, 0.01, 0], false],
      [rings[rings.length - 1], [stations[stations.length - 1][0], 0.01, 0], true],
    ]) {
      for (let i = 0; i < 8; i++) {
        const j = (i + 1) % 8;
        const color = panelColors[i];
        if (reverse) pushSharkTri(positions, colors, center, ringVerts[j], ringVerts[i], color);
        else pushSharkTri(positions, colors, center, ringVerts[i], ringVerts[j], color);
      }
    }
    return sharkMeshFromTris(positions, colors);
  };
  const buildSharkBlade = (points, offset, faceColor, backColor = faceColor) => {
    const positions = [];
    const colors = [];
    const front = points.map(p => [p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]]);
    const back = points.map(p => [p[0] - offset[0], p[1] - offset[1], p[2] - offset[2]]);
    for (let i = 1; i < points.length - 1; i++) {
      pushSharkTri(positions, colors, front[0], front[i], front[i + 1], faceColor);
      pushSharkTri(positions, colors, back[0], back[i + 1], back[i], backColor);
    }
    for (let i = 0; i < points.length; i++) {
      const j = (i + 1) % points.length;
      pushSharkTri(positions, colors, front[i], back[i], back[j], SHARK_FIN_EDGE);
      pushSharkTri(positions, colors, front[i], back[j], front[j], SHARK_FIN_EDGE);
    }
    return sharkMeshFromTris(positions, colors);
  };
  const sharkEyeGeometry = new THREE.SphereGeometry(0.07, 6, 4);
  const sharkEyeMaterial = new THREE.MeshBasicMaterial({ color: 0x050708 });
  const buildShark = () => {
    const group = new THREE.Group();
    const body = buildSharkBody();
    const dorsal = buildSharkBlade([
      [0.65, 0.72, 0], [-0.25, 1.90, 0], [-0.82, 0.66, 0],
    ], [0, 0, 0.055], SHARK_TOP);
    // Each propulsive/control surface has its pivot at the body joint so the
    // animation bends the fin rather than orbiting it around the shark's center.
    const leftPec = new THREE.Group();
    leftPec.name = 'shark-left-pectoral-pivot';
    leftPec.position.set(1.05, -0.22, 0.62);
    leftPec.add(buildSharkBlade([
      [0, 0, 0], [-1.23, -0.02, 1.43], [-2.23, 0.02, 1.93], [-1.77, 0.04, 0.03],
    ], [0, 0.045, 0], SHARK_UPPER_SIDE, SHARK_BELLY));
    const rightPec = new THREE.Group();
    rightPec.name = 'shark-right-pectoral-pivot';
    rightPec.position.set(1.05, -0.22, -0.62);
    rightPec.add(buildSharkBlade([
      [0, 0, 0], [-1.77, 0.04, -0.03], [-2.23, 0.02, -1.93], [-1.23, -0.02, -1.43],
    ], [0, 0.045, 0], SHARK_UPPER_SIDE, SHARK_BELLY));
    const tail = new THREE.Group();
    tail.name = 'shark-tail-pivot';
    tail.position.set(-2.62, 0, 0);
    tail.add(buildSharkBlade([
      [0, 0, 0], [-0.80, 1.58, 0], [-1.10, 1.78, 0], [-0.83, 0.24, 0],
      [-1.08, 0, 0], [-0.83, -0.24, 0], [-1.10, -1.48, 0], [-0.80, -1.28, 0],
    ], [0, 0, 0.065], SHARK_TOP, SHARK_UPPER_SIDE));
    group.add(body, dorsal, leftPec, rightPec, tail);
    group.userData.animParts = { tail, leftPec, rightPec };
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(sharkEyeGeometry, sharkEyeMaterial);
      eye.position.set(2.42, 0.28, side * 0.84);
      group.add(eye);

      // Dark inset mouth, little triangular teeth, and four swept gill cuts.
      const detailPositions = [];
      const detailColors = [];
      pushSharkTri(detailPositions, detailColors,
        [2.90, -0.20, side * 0.83], [1.72, -0.34, side * 0.95], [2.42, -0.39, side * 0.87], 0x242b2d);
      pushSharkTri(detailPositions, detailColors,
        [2.90, -0.20, side * 0.83], [2.42, -0.39, side * 0.87], [3.02, -0.28, side * 0.79], 0x242b2d);
      for (let tooth = 0; tooth < 3; tooth++) {
        const x = 2.15 + tooth * 0.27;
        const toothZ = side * (1.02 - (x - 1.65) * 0.12);
        pushSharkTri(detailPositions, detailColors,
          [x, -0.34, toothZ],
          [x + 0.12, -0.36, toothZ],
          [x + 0.065, -0.46, toothZ], 0xf4efe2);
      }
      for (let gill = 0; gill < 4; gill++) {
        const x = 1.47 - gill * 0.17;
        pushSharkTri(detailPositions, detailColors,
          [x + 0.08, 0.28, side * 1.035], [x, -0.36, side * 1.035], [x - 0.055, -0.34, side * 1.035], 0x36474d);
        pushSharkTri(detailPositions, detailColors,
          [x + 0.08, 0.28, side * 1.035], [x - 0.055, -0.34, side * 1.035], [x + 0.025, 0.29, side * 1.035], 0x36474d);
      }
      const details = sharkMeshFromTris(detailPositions, detailColors);
      details.material = sharkDetailMat;
      group.add(details);
    }
    group.scale.setScalar(0.92);
    return group;
  };
  const sharkStates = [0, 1, 2].map(i => {
    const group = buildShark();
    const angle = i * Math.PI * 2 / 3 + 0.45;
    group.position.set(Math.cos(angle) * (46 + i * 7), oceanSurfaceY - 2.4 - i * 0.7,
      Math.sin(angle) * (34 + i * 5));
    essential.add(group);
    return {
      group, orbitAngle: angle, orbitRadius: 48 + i * 8,
      biteCooldown: 0, retreatT: 0,
      riding: false, beached: false, falling: false, hopping: false,
      collide: false,
      rideAcross: 0, beachDirX: 0, beachDirZ: 1, flopT: 0,
      fallVx: 0, fallVy: 0, fallVz: 0, stuckT: 0, hopVy: 0, hopCool: 0,
    };
  });
  world.sharks = sharkStates.map(state => state.group);
  let sharkTarget = null;
  let sharkHunter = null;
  let sharkAcquireT = 0;
  let sharkWashCycle = -1;
  const sharkProbe = V(0, 0, 0);
  // Simple wall test — floor slabs are ignored by probing above deck height.
  // Past the lip counts as open so he can walk off into the sea.
  const sharkBlockedAt = (x, z) => {
    if (Math.abs(x) > 60.5 || Math.abs(z) > 31.5) return false;
    sharkProbe.set(x, 1.55, z);
    if (pointHitsWorld(sharkProbe, 0.7, world, true)) return true;
    sharkProbe.set(x, 2.35, z);
    return pointHitsWorld(sharkProbe, 0.5, world, true);
  };
  const nearestEdgeDir = (x, z) => {
    const options = [
      [62.8 - x, 0], [-62.8 - x, 0], [0, 33.8 - z], [0, -33.8 - z],
    ];
    let best = options[0], bestScore = Infinity;
    for (const [ex, ez] of options) {
      const score = ex * ex + ez * ez;
      if (score < bestScore) { bestScore = score; best = [ex, ez]; }
    }
    const len = Math.hypot(best[0], best[1]) || 1;
    return [best[0] / len, best[1] / len];
  };
  const sharkBusy = state => state.riding || state.beached || state.falling;
  const swimmingInOcean = ch => ch?.alive &&
    ch.pos.x >= oceanZone.minX && ch.pos.x <= oceanZone.maxX &&
    ch.pos.z >= oceanZone.minZ && ch.pos.z <= oceanZone.maxZ &&
    ch.pos.y < oceanZone.surfaceY + 0.35 && ch.pos.y > oceanZone.bottomY;
  const startSharkRide = (cycleId, halfSpan) => {
    // Some surges carry a shark in the breaker, then drop it on deck.
    const shark = sharkStates.find(state => !sharkBusy(state) && state !== sharkHunter)
      || sharkStates.find(state => !sharkBusy(state))
      || sharkStates[0];
    if (!shark || sharkBusy(shark)) return;
    const lane = halfSpan * (2 / 3);
    shark.rideAcross = THREE.MathUtils.lerp(-lane, lane, Math.random());
    shark.rideDropAt = THREE.MathUtils.lerp(0.22, 0.72, Math.random());
    shark.riding = true;
    shark.beached = false;
    shark.falling = false;
    shark.collide = false;
    shark.flopT = 0;
    shark.rideDeckT = 0;
    shark.rideLastOnDeckX = 0;
    shark.rideLastOnDeckZ = 0;
    shark.retreatT = 0;
    shark.stuckT = 0;
    if (shark === sharkHunter) {
      sharkHunter = null;
      sharkTarget = null;
    }
  };
  const dropSharkOnDeck = (state, x, z, dirX, dirZ) => {
    state.riding = false;
    state.beached = true;
    state.falling = false;
    state.hopping = false;
    state.collide = true;
    state.flopT = 0;
    state.stuckT = 0;
    state.hopVy = 0;
    state.hopCool = 0;
    const dropX = THREE.MathUtils.clamp(x, -56, 56);
    const dropZ = THREE.MathUtils.clamp(z, -28, 28);
    state.group.position.set(dropX, 0.9, dropZ);
    // Prefer the wash direction, but always end up aimed at an ocean lip.
    const [ex, ez] = nearestEdgeDir(dropX, dropZ);
    const wx = dirX || 0, wz = dirZ || 0;
    let aimX = wx * 0.55 + ex, aimZ = wz * 0.55 + ez;
    const aimLen = Math.hypot(aimX, aimZ) || 1;
    state.beachDirX = aimX / aimLen;
    state.beachDirZ = aimZ / aimLen;
    state.group.rotation.y = Math.atan2(-state.beachDirZ, state.beachDirX);
    // Planted inside a prop — jump once toward the edge like a player would.
    if (sharkBlockedAt(dropX, dropZ)) {
      state.hopping = true;
      state.hopVy = 5.5;
    }
    world.onSharkBeached?.(state.group.position);
  };
  world.anim.push((dt, t, characters = []) => {
    const swimmers = characters.filter(swimmingInOcean);
    if (!sharkTarget || !swimmingInOcean(sharkTarget) || sharkBusy(sharkHunter || {})) {
      sharkTarget = null;
      sharkHunter = null;
      sharkAcquireT = swimmers.length ? Math.max(0, sharkAcquireT || 0.7) : 0;
    }
    if (!sharkTarget && swimmers.length) {
      sharkAcquireT -= dt;
      if (sharkAcquireT <= 0) {
        let bestDistance = Infinity;
        for (const state of sharkStates) {
          if (sharkBusy(state)) continue;
          for (const swimmer of swimmers) {
            const distance = state.group.position.distanceToSquared(swimmer.pos);
            if (distance < bestDistance) {
              bestDistance = distance;
              sharkHunter = state;
              sharkTarget = swimmer;
            }
          }
        }
        // A patrol may be on the far side of the platform. Re-enter near the
        // swimmer's depth at a fair but urgent distance instead of taking ten
        // seconds to cross the whole ocean. Detection itself has no range
        // limit — any living swimmer in the ocean volume is fair game.
        if (sharkHunter && sharkTarget) {
          const toHunter = sharkHunter.group.position.clone().sub(sharkTarget.pos);
          toHunter.y = 0;
          if (toHunter.length() > 38) {
            if (toHunter.lengthSq() < 0.01) toHunter.set(1, 0, 0);
            toHunter.normalize();
            sharkHunter.group.position.set(
              sharkTarget.pos.x + toHunter.x * 34,
              THREE.MathUtils.clamp(sharkTarget.pos.y + 0.65, oceanBottomY + 2, oceanSurfaceY - 1.15),
              sharkTarget.pos.z + toHunter.z * 34,
            );
          }
        }
      }
    }

    for (let i = 0; i < sharkStates.length; i++) {
      const state = sharkStates[i];
      state.biteCooldown = Math.max(0, state.biteCooldown - dt);
      state.retreatT = Math.max(0, state.retreatT - dt);
      const current = state.group.position;
      const parts = state.group.userData.animParts;
      const hunting = state === sharkHunter && !!sharkTarget;
      const swimPhase = t * (hunting ? 10.5 : 5.4) + i * 1.9;
      let tailTarget = Math.sin(swimPhase) * (hunting ? 0.52 : 0.32);
      let pecStroke = Math.sin(swimPhase * 0.46) * (hunting ? 0.055 : 0.035);
      if (state.beached) {
        tailTarget = Math.sin(state.flopT * 13.0) * 0.68;
        pecStroke = Math.sin(state.flopT * 9.5) * 0.15;
      } else if (state.falling) {
        tailTarget = Math.sin(state.flopT * 10.5) * 0.50;
        pecStroke = Math.sin(state.flopT * 7.5) * 0.10;
      } else if (state.riding) {
        tailTarget = Math.sin(t * 8.0 + i) * 0.42;
        pecStroke = Math.sin(t * 2.8 + i) * 0.06;
      }
      // Sharks generate thrust by sweeping the vertical tail laterally. Their
      // pectorals stay mostly rigid and only scull a little for pitch/balance.
      parts.tail.rotation.y = THREE.MathUtils.damp(parts.tail.rotation.y, tailTarget, 12, dt);
      parts.leftPec.rotation.x = THREE.MathUtils.damp(
        parts.leftPec.rotation.x, -0.045 + pecStroke, 7, dt);
      parts.rightPec.rotation.x = THREE.MathUtils.damp(
        parts.rightPec.rotation.x, 0.045 - pecStroke, 7, dt);

      if (state.riding) {
        // Position is owned by the tide surge tick so the shark stays inside the breaker.
        continue;
      }

      if (state.falling) {
        state.flopT += dt;
        state.fallVy -= 26 * dt;
        current.x += state.fallVx * dt;
        current.y += state.fallVy * dt;
        current.z += state.fallVz * dt;
        state.group.rotation.x += dt * 2.8;
        state.group.rotation.z += dt * 1.7;
        if (current.y <= oceanSurfaceY - 1.6) {
          state.falling = false;
          state.beached = false;
          state.collide = false;
          state.flopT = 0;
          current.y = oceanSurfaceY - 2.2;
          state.group.rotation.x = 0;
          state.group.rotation.z = 0;
          state.orbitAngle = Math.atan2(current.z, current.x);
        }
        continue;
      }

      if (state.beached) {
        // Same idea as a player: walk toward the ocean lip, jump if blocked,
        // flop animation on top. No special pathfinder / teleport system.
        state.flopT += dt;
        state.hopCool = Math.max(0, state.hopCool - dt);
        const [ex, ez] = nearestEdgeDir(current.x, current.z);
        let dirX = state.beachDirX * 0.35 + ex;
        let dirZ = state.beachDirZ * 0.35 + ez;
        const dirLen = Math.hypot(dirX, dirZ) || 1;
        dirX /= dirLen; dirZ /= dirLen;
        state.beachDirX = dirX;
        state.beachDirZ = dirZ;

        const walkSpeed = 5.6; // ~half of Tidebreaker player walk speed
        let stepX = dirX, stepZ = dirZ;
        let moved = false;

        if (state.hopping) {
          state.hopVy -= 28 * dt;
          current.y += state.hopVy * dt;
          current.x += dirX * walkSpeed * 1.15 * dt;
          current.z += dirZ * walkSpeed * 1.15 * dt;
          moved = true;
          if (current.y <= 0.78) {
            current.y = 0.78;
            state.hopVy = 0;
            state.hopping = false;
          }
        } else {
          const trySteps = [
            [dirX, dirZ],
            [dirX * 0.7 - dirZ * 0.7, dirZ * 0.7 + dirX * 0.7],
            [dirX * 0.7 + dirZ * 0.7, dirZ * 0.7 - dirX * 0.7],
          ];
          for (const [tx, tz] of trySteps) {
            const len = Math.hypot(tx, tz) || 1;
            const nx = current.x + (tx / len) * walkSpeed * dt;
            const nz = current.z + (tz / len) * walkSpeed * dt;
            if (sharkBlockedAt(nx, nz)) continue;
            current.x = nx;
            current.z = nz;
            stepX = tx / len;
            stepZ = tz / len;
            moved = true;
            break;
          }
          if (!moved && state.hopCool <= 0) {
            state.hopping = true;
            state.hopVy = 5.8;
            state.hopCool = 0.55;
          }
          current.y = 0.78 + Math.abs(Math.sin(state.flopT * 9.0)) * 0.28;
        }

        state.stuckT = moved ? 0 : state.stuckT + dt;
        const yaw = Math.atan2(-stepZ, stepX) + Math.sin(state.flopT * 6.2) * 0.22;
        state.group.rotation.y = yaw;
        state.group.rotation.z = Math.sin(state.flopT * 10.5) * 0.48;
        state.group.rotation.x = state.hopping
          ? -0.45 + state.hopVy * 0.035
          : 0.1 + Math.sin(state.flopT * 7.5) * 0.32;

        if (state.biteCooldown <= 0) {
          const mouthX = current.x + Math.cos(yaw) * 2.4;
          const mouthZ = current.z - Math.sin(yaw) * 2.4;
          for (const ch of characters) {
            if (!ch?.alive || ch.pos.y > 3.8) continue;
            const dx = ch.pos.x - mouthX;
            const dz = ch.pos.z - mouthZ;
            if (dx * dx + dz * dz <= 2.2 * 2.2 && Math.abs(ch.pos.y - current.y) < 2.4) {
              state.biteCooldown = 2;
              world.onSharkBite?.(ch, current);
              break;
            }
          }
        }

        if (Math.abs(current.x) > 60.8 || Math.abs(current.z) > 31.8) {
          state.beached = false;
          state.falling = true;
          state.collide = false;
          const outX = Math.abs(current.x) > 60.8 ? Math.sign(current.x) : dirX;
          const outZ = Math.abs(current.z) > 31.8 ? Math.sign(current.z) : dirZ;
          const outLen = Math.hypot(outX, outZ) || 1;
          state.fallVx = (outX / outLen) * 6.5;
          state.fallVz = (outZ / outLen) * 6.5;
          state.fallVy = 3.2;
          current.x += (outX / outLen) * 1.1;
          current.z += (outZ / outLen) * 1.1;
        }
        continue;
      }

      const desired = V(0, 0, 0);
      let speed = 6.5;
      if (state === sharkHunter && sharkTarget) {
        // Follow the swimmer through the full water column — no shallow-only
        // chase band, so deep dives stay hunted the same as surface swims.
        const targetY = THREE.MathUtils.clamp(
          sharkTarget.pos.y + 0.65, oceanBottomY + 2, oceanSurfaceY - 1.15,
        );
        desired.set(sharkTarget.pos.x, targetY, sharkTarget.pos.z);
        if (state.retreatT > 0) {
          const away = current.clone().sub(sharkTarget.pos);
          away.y = 0;
          if (away.lengthSq() < 0.01) away.set(1, 0, 0);
          away.normalize();
          const retreatY = THREE.MathUtils.clamp(
            current.y, oceanBottomY + 2, oceanSurfaceY - 1.15,
          );
          desired.set(current.x + away.x * 12, retreatY, current.z + away.z * 12);
          speed = 18;
        } else {
          speed = 21;
        }
      } else {
        const orbitSpeed = 0.16 + i * 0.025;
        const angle = state.orbitAngle + t * orbitSpeed;
        desired.set(
          Math.cos(angle) * state.orbitRadius,
          oceanSurfaceY - 2.6 - i * 0.65 + Math.sin(t * 0.7 + i) * 0.45,
          Math.sin(angle) * state.orbitRadius * 0.72,
        );
      }
      const travel = desired.sub(current);
      const distance = travel.length();
      if (distance > 0.001) {
        travel.multiplyScalar(Math.min(distance, speed * dt) / distance);
        current.add(travel);
        const flatSpeed = Math.hypot(travel.x, travel.z);
        if (flatSpeed > 0.0001) {
          const yaw = Math.atan2(-travel.z, travel.x);
          state.group.rotation.y = THREE.MathUtils.lerp(
            state.group.rotation.y, yaw,
            1 - Math.exp(-8 * dt),
          );
          state.group.rotation.z = THREE.MathUtils.lerp(
            state.group.rotation.z,
            THREE.MathUtils.clamp(-travel.y / flatSpeed, -0.28, 0.28),
            1 - Math.exp(-5 * dt),
          );
        }
      }
      if (state === sharkHunter && sharkTarget && state.retreatT <= 0 &&
          state.biteCooldown <= 0 && current.distanceTo(sharkTarget.pos) < 2.75) {
        state.biteCooldown = 2;
        state.retreatT = 0.72;
        world.onSharkBite?.(sharkTarget, state.group.position);
      }
    }
  });

  // One huge low-poly blue whale — mottled slate-blue dorsal surface, cooler
  // flanks and a muted pale underside. Scenic only.
  const WHALE_BLUE = 0x315f78;
  const WHALE_BLUE_LIGHT = 0x4d7f95;
  const WHALE_SIDE = 0x294f68;
  const WHALE_WHITE = 0x729cac;
  const WHALE_JAW = 0x86aeba;
  const WHALE_GROOVE = 0x4f7889;
  const whaleDorsalMottle = [0x315f78, 0x3f7188, 0x4d7f95, 0x2b536b];
  const whaleUpperMottle = [0x2e5870, 0x3b6a82, 0x46778d, 0x294f66];
  const whaleFlankMottle = [0x294f68, 0x315d75, 0x22445b, 0x3d6a7e];
  const whaleBellyMottle = [0x729cac, 0x82aab6, 0x648e9f, 0x8db2bd];
  const whaleMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.78,
    metalness: 0.04,
    emissive: 0x0d2938,
    emissiveIntensity: 0.22,
    envMapIntensity: 0.72,
    flatShading: true,
    side: THREE.DoubleSide,
  });
  const pushWhaleTri = (positions, colors, ax, ay, az, bx, by, bz, cx, cy, cz, color) => {
    positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    const r = ((color >> 16) & 255) / 255;
    const g = ((color >> 8) & 255) / 255;
    const b = (color & 255) / 255;
    for (let n = 0; n < 3; n++) colors.push(r, g, b);
  };
  const meshFromTris = (positions, colors) => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, whaleMat);
  };
  const buildPectoralMesh = (side) => {
    const positions = [];
    const colors = [];
    // Local space: root at origin, fin extends along +Z for side=+1.
    // Built flat in XY so rotation.x lifts the tip like a wing.
    const root = [0, 0, 0];
    const aft = [-1.8, -0.38, side * 1.0];
    const mid = [-2.8, -0.52, side * 5.2];
    const tip = [-5.4, -0.92, side * 10.0];
    const lead = [0.25, 0.04, side * 3.35];
    // Blue topside
    pushWhaleTri(positions, colors,
      root[0], 0.1, root[2], aft[0], 0.08, aft[2], lead[0], 0.12, lead[2], WHALE_BLUE);
    pushWhaleTri(positions, colors,
      aft[0], 0.08, aft[2], tip[0], 0.05, tip[2], mid[0], 0.08, mid[2], WHALE_BLUE);
    pushWhaleTri(positions, colors,
      lead[0], 0.12, lead[2], aft[0], 0.08, aft[2], mid[0], 0.08, mid[2], WHALE_BLUE);
    pushWhaleTri(positions, colors,
      lead[0], 0.12, lead[2], mid[0], 0.08, mid[2], tip[0], 0.05, tip[2], WHALE_BLUE);
    // White underside
    pushWhaleTri(positions, colors,
      root[0], -0.1, root[2], lead[0], -0.08, lead[2], aft[0], -0.08, aft[2], WHALE_WHITE);
    pushWhaleTri(positions, colors,
      aft[0], -0.08, aft[2], mid[0], -0.08, mid[2], tip[0], -0.05, tip[2], WHALE_WHITE);
    pushWhaleTri(positions, colors,
      lead[0], -0.08, lead[2], mid[0], -0.08, mid[2], aft[0], -0.08, aft[2], WHALE_WHITE);
    pushWhaleTri(positions, colors,
      lead[0], -0.08, lead[2], tip[0], -0.05, tip[2], mid[0], -0.08, mid[2], WHALE_WHITE);
    return meshFromTris(positions, colors);
  };
  const buildBlueWhale = () => {
    const positions = [];
    const colors = [];
    const flukePositions = [];
    const flukeColors = [];
    let flukePivotX = 0;
    let flukePivotY = 0;
    // Low-poly loft: broad squared snout (+X) → narrow fluke (−X). The
    // reference's long, almost level back replaces the old bulbous body.
    const stations = [
      [14.15, 2.15, 0.72, -1.45],
      [13.55, 3.32, 1.02, -1.92],
      [12.15, 3.62, 1.28, -2.18],
      [9.55, 3.55, 1.58, -2.35],
      [6.25, 3.32, 1.88, -2.45],
      [2.65, 3.00, 2.02, -2.38],
      [-0.85, 2.66, 1.92, -2.15],
      [-4.15, 2.25, 1.66, -1.78],
      [-7.10, 1.68, 1.28, -1.28],
      [-9.55, 1.06, 0.82, -0.78],
      [-11.45, 0.48, 0.40, -0.36],
      [-12.35, 0.20, 0.18, -0.16],
    ];
    const ring = (x, halfW, topY, botY) => {
      const midY = (topY + botY) * 0.5;
      return [
        [x, topY, 0],
        [x, topY * 0.72 + midY * 0.28, halfW * 0.72],
        [x, midY * 0.15, halfW],
        [x, botY * 0.55 + midY * 0.45, halfW * 0.78],
        [x, botY, 0],
        [x, botY * 0.55 + midY * 0.45, -halfW * 0.78],
        [x, midY * 0.15, -halfW],
        [x, topY * 0.72 + midY * 0.28, -halfW * 0.72],
      ];
    };
    const rings = stations.map(([x, w, ty, by]) => ring(x, w, ty, by));
    const colorAt = (y, topY, botY) => {
      const tt = (y - botY) / Math.max(0.001, topY - botY);
      if (tt >= 0.74) return WHALE_BLUE;
      if (tt >= 0.43) return WHALE_SIDE;
      return WHALE_WHITE;
    };
    const facetColor = (station, panel, triangle) => {
      const palette = panel === 0 || panel === 7 ? whaleDorsalMottle
        : panel === 1 || panel === 6 ? whaleUpperMottle
          : panel === 2 || panel === 5 ? whaleFlankMottle : whaleBellyMottle;
      // Deterministic variation keeps every whale identical while breaking the
      // body into the irregular blue-gray mottling characteristic of the species.
      return palette[(station * 5 + panel * 3 + triangle * 2) % palette.length];
    };
    for (let s = 0; s < rings.length - 1; s++) {
      const ra = rings[s], rb = rings[s + 1];
      for (let i = 0; i < 8; i++) {
        const j = (i + 1) % 8;
        const [ax, ay, az] = ra[i], [bx, by, bz] = ra[j];
        const [cx, cy, cz] = rb[j], [dx, dy, dz] = rb[i];
        pushWhaleTri(positions, colors, ax, ay, az, bx, by, bz, cx, cy, cz,
          facetColor(s, i, 0));
        pushWhaleTri(positions, colors, ax, ay, az, cx, cy, cz, dx, dy, dz,
          facetColor(s, i, 1));
      }
    }
    const nose = rings[0];
    // A tiny forward bevel leaves a broad, flat rostrum instead of a pointed
    // fish-like nose.
    const tip = [stations[0][0] + 0.10, -0.32, 0];
    for (let i = 0; i < 8; i++) {
      const j = (i + 1) % 8;
      const col = colorAt((nose[i][1] + nose[j][1] + tip[1]) / 3, stations[0][2], stations[0][3]);
      pushWhaleTri(positions, colors,
        tip[0], tip[1], tip[2],
        nose[i][0], nose[i][1], nose[i][2],
        nose[j][0], nose[j][1], nose[j][2], col);
    }
    // Small swept dorsal bump, matching the understated fin in the reference.
    pushWhaleTri(positions, colors, -3.15, 1.72, 0, -5.05, 2.72, 0, -5.92, 1.46, 0, WHALE_BLUE);
    pushWhaleTri(positions, colors, -3.15, 1.72, 0, -5.92, 1.46, 0, -5.05, 2.72, 0, WHALE_BLUE);
    // Long, darker throat pleats are one of a blue whale's clearest markings.
    for (let i = -2; i <= 2; i++) {
      const gz = i * 0.48;
      pushWhaleTri(positions, colors,
        13.2, -1.72, gz - 0.06, 6.1, -2.28, gz - 0.06, 6.1, -2.35, gz + 0.06, WHALE_GROOVE);
      pushWhaleTri(positions, colors,
        13.2, -1.72, gz - 0.06, 6.1, -2.35, gz + 0.06, 13.2, -1.79, gz + 0.06, WHALE_GROOVE);
    }

    // Solid fluke welded to the peduncle — no floating sheets / see-through slits.
    {
      const last = stations[stations.length - 1];
      const ped = rings[rings.length - 1];
      const px = last[0];
      const midY = (last[2] + last[3]) * 0.5;
      flukePivotX = px;
      flukePivotY = midY;
      // Cap the open loft end so the body doesn't leave a hole behind the fluke.
      for (let i = 0; i < 8; i++) {
        const j = (i + 1) % 8;
        const col = colorAt((ped[i][1] + ped[j][1] + midY) / 3, last[2], last[3]);
        pushWhaleTri(positions, colors,
          px, midY, 0,
          ped[i][0], ped[i][1], ped[i][2],
          ped[j][0], ped[j][1], ped[j][2], col);
      }
      // Fluke outline in the horizontal plane (root → left tip → notch → right tip).
      // Shared verts for top/bottom so the edge walls seal the volume.
      const ht = 0.34; // half-thickness
      const outline = [
        [px - 0.05, midY, 0],
        [px - 1.15, midY + 0.08, 2.55],
        [px - 2.55, midY + 0.22, 5.55],
        [px - 3.35, midY + 0.32, 0.55],
        [px - 3.75, midY + 0.38, 0],
        [px - 3.35, midY + 0.32, -0.55],
        [px - 2.55, midY + 0.22, -5.55],
        [px - 1.15, midY + 0.08, -2.55],
      ];
      const top = outline.map(([x, y, z]) => [x, y + ht, z]);
      const bot = outline.map(([x, y, z]) => [x, y - ht, z]);
      // Mottled blue-gray top face — fan from root.
      for (let i = 1; i < outline.length - 1; i++) {
        pushWhaleTri(flukePositions, flukeColors,
          top[0][0], top[0][1], top[0][2],
          top[i][0], top[i][1], top[i][2],
          top[i + 1][0], top[i + 1][1], top[i + 1][2],
          whaleDorsalMottle[i % whaleDorsalMottle.length]);
      }
      // Pale, irregular underside.
      for (let i = 1; i < outline.length - 1; i++) {
        pushWhaleTri(flukePositions, flukeColors,
          bot[0][0], bot[0][1], bot[0][2],
          bot[i + 1][0], bot[i + 1][1], bot[i + 1][2],
          bot[i][0], bot[i][1], bot[i][2],
          whaleBellyMottle[(i * 3) % whaleBellyMottle.length]);
      }
      // Edge ribbon seals top to bottom all the way around.
      for (let i = 0; i < outline.length; i++) {
        const j = (i + 1) % outline.length;
        const edgeCol = Math.abs(outline[i][2]) + Math.abs(outline[j][2]) > 0.8 ? WHALE_BLUE : WHALE_WHITE;
        pushWhaleTri(flukePositions, flukeColors,
          top[i][0], top[i][1], top[i][2],
          top[j][0], top[j][1], top[j][2],
          bot[j][0], bot[j][1], bot[j][2], edgeCol);
        pushWhaleTri(flukePositions, flukeColors,
          top[i][0], top[i][1], top[i][2],
          bot[j][0], bot[j][1], bot[j][2],
          bot[i][0], bot[i][1], bot[i][2], edgeCol);
      }
      // Weld fluke root into the peduncle cap (fills the body→tail joint).
      for (let i = 0; i < 8; i++) {
        const j = (i + 1) % 8;
        const col = colorAt((ped[i][1] + ped[j][1] + midY) / 3, last[2], last[3]);
        pushWhaleTri(flukePositions, flukeColors,
          ped[i][0], ped[i][1], ped[i][2],
          ped[j][0], ped[j][1], ped[j][2],
          top[0][0], top[0][1], top[0][2], col);
        pushWhaleTri(flukePositions, flukeColors,
          ped[i][0], ped[i][1], ped[i][2],
          top[0][0], top[0][1], top[0][2],
          bot[0][0], bot[0][1], bot[0][2], col);
      }
    }

    const group = new THREE.Group();
    const body = meshFromTris(positions, colors);
    group.add(body);
    const fluke = new THREE.Group();
    fluke.name = 'whale-fluke-pivot';
    fluke.position.set(flukePivotX, flukePivotY, 0);
    const flukeMesh = meshFromTris(flukePositions, flukeColors);
    flukeMesh.position.set(-flukePivotX, -flukePivotY, 0);
    fluke.add(flukeMesh);
    group.add(fluke);
    // Pale jawline and tiny eyes are the two high-contrast details that make
    // the faceted head read like the supplied whale at gameplay distance.
    const markingPositions = [];
    const markingColors = [];
    for (const side of [-1, 1]) {
      const z0 = side * 2.13;
      const z1 = side * 3.34;
      const z2 = side * 3.58;
      const z3 = side * 3.30;
      pushWhaleTri(markingPositions, markingColors,
        14.18, -0.45, z0, 13.45, -0.18, z1, 9.45, -0.04, z2, WHALE_JAW);
      pushWhaleTri(markingPositions, markingColors,
        14.18, -0.45, z0, 9.45, -0.04, z2, 6.2, -0.27, z3, WHALE_JAW);
    }
    group.add(meshFromTris(markingPositions, markingColors));
    const whaleEyeGeo = new THREE.SphereGeometry(0.13, 6, 4);
    const whaleEyeMat = new THREE.MeshBasicMaterial({ color: 0x11141b });
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(whaleEyeGeo, whaleEyeMat);
      eye.position.set(8.35, 0.34, side * 3.36);
      group.add(eye);
    }
    const blowholeGeo = new THREE.SphereGeometry(0.16, 6, 3);
    const blowholeMat = new THREE.MeshBasicMaterial({ color: 0x263b43 });
    for (const side of [-1, 1]) {
      const blowhole = new THREE.Mesh(blowholeGeo, blowholeMat);
      blowhole.position.set(9.35, 1.61, side * 0.19);
      blowhole.scale.set(1.05, 0.16, 0.52);
      group.add(blowhole);
    }
    const leftPec = new THREE.Group();
    leftPec.name = 'whale-left-pectoral-pivot';
    leftPec.position.set(3.6, -0.35, 2.55);
    leftPec.add(buildPectoralMesh(1));
    const rightPec = new THREE.Group();
    rightPec.name = 'whale-right-pectoral-pivot';
    rightPec.position.set(3.6, -0.35, -2.55);
    rightPec.add(buildPectoralMesh(-1));
    group.add(leftPec, rightPec);
    // A mature blue whale should feel enormous beside the rig and human-scale
    // combatants, while still fitting its wide offshore cruise/breach path.
    group.scale.setScalar(2.35);
    return { group, body, fluke, leftPec, rightPec };
  };
  const whaleParts = buildBlueWhale();
  const whale = whaleParts.group;
  whale.position.set(145, oceanSurfaceY - 18, -55);
  essential.add(whale);
  world.whale = whale;

  // Breach splash — short-lived foam burst at the exit / crash point.
  const whaleSplashCount = 140;
  const whaleSplashPos = new Float32Array(whaleSplashCount * 3);
  const whaleSplashVel = Array.from({ length: whaleSplashCount }, () => V(0, 0, 0));
  const whaleSplashLife = new Float32Array(whaleSplashCount);
  const whaleSplashGeo = new THREE.BufferGeometry();
  whaleSplashGeo.setAttribute('position', new THREE.BufferAttribute(whaleSplashPos, 3));
  const whaleSplashMat = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0 } },
    vertexShader: `
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = clamp(140.0 / max(1.0, -mvPosition.z), 2.4, 11.0);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform float uOpacity;
      void main() {
        vec2 p = gl_PointCoord - vec2(0.5);
        float d = length(p);
        float alpha = 1.0 - smoothstep(0.18, 0.5, d);
        gl_FragColor = vec4(0.86, 0.95, 1.0, alpha * uOpacity);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const whaleSplash = new THREE.Points(whaleSplashGeo, whaleSplashMat);
  whaleSplash.frustumCulled = false;
  whaleSplash.visible = false;
  essential.add(whaleSplash);
  const burstWhaleSplash = (ox, oy, oz, power = 1) => {
    for (let i = 0; i < whaleSplashCount; i++) {
      const i3 = i * 3;
      const ang = Math.random() * Math.PI * 2;
      const rad = Math.random() * 4.5 * power;
      whaleSplashPos[i3] = ox + Math.cos(ang) * rad;
      whaleSplashPos[i3 + 1] = oy + Math.random() * 1.2;
      whaleSplashPos[i3 + 2] = oz + Math.sin(ang) * rad;
      whaleSplashVel[i].set(
        Math.cos(ang) * (2 + Math.random() * 10) * power,
        (4 + Math.random() * 14) * power,
        Math.sin(ang) * (2 + Math.random() * 10) * power,
      );
      whaleSplashLife[i] = 0.45 + Math.random() * 0.85;
    }
    whaleSplashGeo.attributes.position.needsUpdate = true;
    whaleSplash.visible = true;
    whaleSplashMat.uniforms.uOpacity.value = 0.95;
  };

  const WHALE_DECK_HALF_X = 62;
  const WHALE_DECK_HALF_Z = 33;
  const WHALE_MAX_DEPTH = 40;
  const WHALE_BREACH_CLEAR = 35;
  const WHALE_BREACH_DUR = 4.6;
  const whaleDistFromPlatform = (x, z) => {
    const dx = Math.max(0, Math.abs(x) - WHALE_DECK_HALF_X);
    const dz = Math.max(0, Math.abs(z) - WHALE_DECK_HALF_Z);
    if (dx === 0 && dz === 0) return 0;
    if (dx === 0) return dz;
    if (dz === 0) return dx;
    return Math.hypot(dx, dz);
  };
  const whaleCruise = {
    angle: 0.55,
    radiusX: 168,
    radiusZ: 138,
    radiusPulse: 0,
    speed: 0.032,
    phase: 'cruise', // cruise | rise | breach | dive
    phaseT: 0,
    nextBreachT: 14 + Math.random() * 18,
    depthBias: 0.45,
    pitch: 0,
    roll: 0,
    breachSide: 1, // which way the belly rolls / which pec goes vertical
    splashExit: false,
    splashCrash: false,
  };
  world.anim.push((dt, t) => {
    const inBreach = whaleCruise.phase === 'breach';
    whaleCruise.angle += whaleCruise.speed * dt * (inBreach ? 0.42 : 1);
    whaleCruise.radiusPulse = Math.sin(t * 0.11) * 18;
    const a = whaleCruise.angle;
    const rx = whaleCruise.radiusX + whaleCruise.radiusPulse;
    const rz = whaleCruise.radiusZ + whaleCruise.radiusPulse * 0.7;
    const x = Math.cos(a) * rx;
    const z = Math.sin(a) * rz;
    const clear = whaleDistFromPlatform(x, z);
    const deepY = oceanSurfaceY - WHALE_MAX_DEPTH;
    const surfaceY = oceanSurfaceY - 1.1;

    whaleCruise.nextBreachT -= dt;
    whaleCruise.phaseT += dt;

    if (whaleCruise.phase === 'cruise') {
      whaleCruise.depthBias = 0.5 + 0.5 * Math.sin(t * 0.09 + a * 0.35);
      if (whaleCruise.nextBreachT <= 0 && clear >= WHALE_BREACH_CLEAR) {
        whaleCruise.phase = 'rise';
        whaleCruise.phaseT = 0;
        whaleCruise.breachSide = Math.random() < 0.5 ? 1 : -1;
      } else if (whaleCruise.nextBreachT <= 0) {
        whaleCruise.nextBreachT = 4 + Math.random() * 6;
      }
    } else if (whaleCruise.phase === 'rise') {
      // Climb hard from depth toward a launch just under the swell.
      whaleCruise.depthBias = Math.max(0, whaleCruise.depthBias - dt * 0.38);
      if (whaleCruise.depthBias <= 0.04 && clear >= WHALE_BREACH_CLEAR) {
        whaleCruise.phase = 'breach';
        whaleCruise.phaseT = 0;
        whaleCruise.splashExit = false;
        whaleCruise.splashCrash = false;
      } else if (whaleCruise.phaseT > 12 || clear < WHALE_BREACH_CLEAR * 0.85) {
        whaleCruise.phase = 'dive';
        whaleCruise.phaseT = 0;
      }
    } else if (whaleCruise.phase === 'breach') {
      if (clear < WHALE_BREACH_CLEAR * 0.7) {
        whaleCruise.phase = 'dive';
        whaleCruise.phaseT = 0;
      } else if (whaleCruise.phaseT > WHALE_BREACH_DUR) {
        whaleCruise.phase = 'dive';
        whaleCruise.phaseT = 0;
        whaleCruise.nextBreachT = 26 + Math.random() * 34;
      }
    } else if (whaleCruise.phase === 'dive') {
      whaleCruise.depthBias = Math.min(1, whaleCruise.depthBias + dt * 0.24);
      if (whaleCruise.depthBias >= 0.92 || whaleCruise.phaseT > 12) {
        whaleCruise.phase = 'cruise';
        whaleCruise.phaseT = 0;
        whaleCruise.nextBreachT = Math.max(whaleCruise.nextBreachT, 16 + Math.random() * 24);
      }
    }

    let y;
    let targetPitch = 0;
    let targetRoll = 0;
    let pecUp = 0.12;   // rotation lifting a pec toward vertical
    let pecOut = 0.18;  // the other pec stays more horizontal / trailing
    let targetFluke = 0;
    const side = whaleCruise.breachSide;

    if (inBreach) {
      // Classic humpback breach: steep ~55° exit, roll the belly open, one pec
      // vertical, most of the body clear, then a heavy side/belly crash.
      const u = Math.min(1, whaleCruise.phaseT / WHALE_BREACH_DUR);
      const launch = THREE.MathUtils.smoothstep(u, 0, 0.18);
      const peak = Math.sin(THREE.MathUtils.clamp(u / 0.52, 0, 1) * Math.PI);
      const crash = THREE.MathUtils.smoothstep(u, 0.52, 1);
      // Midsection sits near the waterline at peak so ~2/3 of the body clears.
      y = oceanSurfaceY
        + launch * 2.2
        + peak * 9.5
        - crash * 11.5
        + Math.sin(u * Math.PI) * 1.4;
      // Pitch: climb to ~55°, hold, then tuck through the crash.
      targetPitch = THREE.MathUtils.lerp(0.35, 0.98, launch)
        * (1 - crash * 0.15)
        - crash * 0.55;
      // Roll open to show the white belly / vertical pec silhouette.
      targetRoll = side * (
        THREE.MathUtils.lerp(0.05, 0.72, THREE.MathUtils.smoothstep(u, 0.05, 0.35))
        + crash * 0.35
      );
      pecUp = THREE.MathUtils.lerp(0.2, 1.35, THREE.MathUtils.smoothstep(u, 0.08, 0.4));
      pecOut = THREE.MathUtils.lerp(0.15, 0.55, THREE.MathUtils.smoothstep(u, 0.1, 0.45));
      if (crash > 0.2) {
        pecUp = THREE.MathUtils.lerp(pecUp, 0.35, crash);
        pecOut = THREE.MathUtils.lerp(pecOut, 0.8, crash);
      }
      // One hard launch stroke, then let the fluke trail and tuck into the
      // splashdown rather than beating continuously in the air.
      targetFluke = launch * 0.28
        + Math.sin(u * Math.PI * 2.15) * (1 - crash) * 0.13
        - crash * 0.24;
      whaleCruise.depthBias = 0;

      if (!whaleCruise.splashExit && u > 0.08) {
        whaleCruise.splashExit = true;
        burstWhaleSplash(x, oceanSurfaceY + 0.4, z, 1.15);
      }
      if (!whaleCruise.splashCrash && u > 0.72) {
        whaleCruise.splashCrash = true;
        burstWhaleSplash(x, oceanSurfaceY + 0.2, z, 1.35);
      }
    } else {
      const cruiseWobble = Math.sin(t * 0.19) * 2.4 + Math.sin(a * 1.7) * 1.6;
      y = THREE.MathUtils.lerp(surfaceY, deepY, whaleCruise.depthBias) + cruiseWobble;
      if (whaleCruise.phase === 'rise') {
        targetPitch = 0.48;
        pecUp = 0.22;
        pecOut = 0.28;
        targetFluke = Math.sin(t * 3.8) * 0.30;
      } else if (whaleCruise.phase === 'dive') {
        targetPitch = -0.42;
        targetRoll = 0;
        targetFluke = Math.sin(t * 3.0) * 0.23;
      } else {
        targetPitch = (0.5 - whaleCruise.depthBias) * 0.12;
        targetFluke = Math.sin(t * 2.25) * 0.16;
      }
    }

    whale.position.set(x, y, z);
    const tx = -Math.sin(a) * rx;
    const tz = Math.cos(a) * rz;
    const yaw = Math.atan2(-tz, tx);
    let dyaw = yaw - whale.rotation.y;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    // Hold heading steadier through the breach so the silhouette reads clean.
    whale.rotation.y += dyaw * (1 - Math.exp(-(inBreach ? 3.2 : 1.5) * dt));
    whaleCruise.pitch = THREE.MathUtils.damp(whaleCruise.pitch, targetPitch, inBreach ? 5.5 : 2.2, dt);
    whaleCruise.roll = THREE.MathUtils.damp(whaleCruise.roll, targetRoll, inBreach ? 4.5 : 2.0, dt);
    // +X forward: z = pitch (nose up), x = roll (belly open).
    whale.rotation.z = whaleCruise.pitch;
    whale.rotation.x = whaleCruise.roll;
    // Cetaceans propel themselves vertically with a horizontal fluke.
    whaleParts.fluke.rotation.z = THREE.MathUtils.damp(
      whaleParts.fluke.rotation.z, targetFluke, inBreach ? 6.5 : 4.8, dt);

    // Pecs scull gently for stability while submerged. During a breach one
    // flares almost vertically while its opposite trails against the roll.
    const swimBob = Math.sin(t * 1.35) * 0.08;
    if (!inBreach) {
      const baseLift = whaleCruise.phase === 'rise' ? 0.22
        : whaleCruise.phase === 'dive' ? 0.09 : 0.13;
      whaleParts.leftPec.rotation.x = THREE.MathUtils.damp(
        whaleParts.leftPec.rotation.x, -baseLift + swimBob, 4.2, dt);
      whaleParts.rightPec.rotation.x = THREE.MathUtils.damp(
        whaleParts.rightPec.rotation.x, baseLift - swimBob, 4.2, dt);
      whaleParts.leftPec.rotation.z = THREE.MathUtils.damp(
        whaleParts.leftPec.rotation.z, -0.06 + swimBob * 0.25, 3.5, dt);
      whaleParts.rightPec.rotation.z = THREE.MathUtils.damp(
        whaleParts.rightPec.rotation.z, 0.06 - swimBob * 0.25, 3.5, dt);
    } else if (side > 0) {
      whaleParts.leftPec.rotation.x = THREE.MathUtils.damp(
        whaleParts.leftPec.rotation.x, -pecUp, 5, dt);
      whaleParts.rightPec.rotation.x = THREE.MathUtils.damp(
        whaleParts.rightPec.rotation.x, pecOut * 0.35 + 0.15, 5, dt);
      whaleParts.leftPec.rotation.z = THREE.MathUtils.damp(
        whaleParts.leftPec.rotation.z, -0.25, 4, dt);
      whaleParts.rightPec.rotation.z = THREE.MathUtils.damp(
        whaleParts.rightPec.rotation.z, 0.45, 4, dt);
    } else {
      whaleParts.rightPec.rotation.x = THREE.MathUtils.damp(
        whaleParts.rightPec.rotation.x, pecUp, 5, dt);
      whaleParts.leftPec.rotation.x = THREE.MathUtils.damp(
        whaleParts.leftPec.rotation.x, -pecOut * 0.35 - 0.15, 5, dt);
      whaleParts.rightPec.rotation.z = THREE.MathUtils.damp(
        whaleParts.rightPec.rotation.z, 0.25, 4, dt);
      whaleParts.leftPec.rotation.z = THREE.MathUtils.damp(
        whaleParts.leftPec.rotation.z, -0.45, 4, dt);
    }

    // Splash particles.
    let splashAlive = 0;
    let splashMaxLife = 0;
    for (let i = 0; i < whaleSplashCount; i++) {
      if (whaleSplashLife[i] <= 0) continue;
      whaleSplashLife[i] -= dt;
      if (whaleSplashLife[i] <= 0) continue;
      splashAlive++;
      splashMaxLife = Math.max(splashMaxLife, whaleSplashLife[i]);
      const i3 = i * 3;
      whaleSplashVel[i].y -= 18 * dt;
      whaleSplashPos[i3] += whaleSplashVel[i].x * dt;
      whaleSplashPos[i3 + 1] += whaleSplashVel[i].y * dt;
      whaleSplashPos[i3 + 2] += whaleSplashVel[i].z * dt;
      if (whaleSplashPos[i3 + 1] < oceanSurfaceY) {
        whaleSplashPos[i3 + 1] = oceanSurfaceY;
        whaleSplashVel[i].y *= -0.15;
        whaleSplashVel[i].x *= 0.85;
        whaleSplashVel[i].z *= 0.85;
      }
    }
    if (splashAlive) {
      whaleSplash.visible = true;
      whaleSplashGeo.attributes.position.needsUpdate = true;
      whaleSplashMat.uniforms.uOpacity.value = THREE.MathUtils.clamp(splashMaxLife * 1.1, 0, 0.95);
    } else {
      whaleSplash.visible = false;
      whaleSplashMat.uniforms.uOpacity.value = 0;
    }
  });

  // Main low deck, evacuation catwalks, east operations roof, and west helipad.
  addBox(scene, world, 0, -0.55, 0, 124, 1.1, 66, steel, { ...wetDeck, debugName: 'processing deck' });
  // Evac decks grow 0.65 toward center so their inner faces meet the ramp
  // crests (full height before the vertical slab face — no jump lip).
  addBox(scene, world, 0, 7.5, -34.675, 132, 1, 8.65, steel, { ...wetDeck, debugName: 'north evacuation deck' });
  addBox(scene, world, 0, 7.5, 34.675, 132, 1, 8.65, steel, { ...wetDeck, debugName: 'south evacuation deck' });
  addBox(scene, world, 49, 7.5, 0, 30, 1, 60.7, steel, { ...wetDeck, debugName: 'operations roof' });
  addBox(scene, world, -49, 13.5, 0, 34, 1, 35.3, steel, { ...wetDeck, debugName: 'helipad deck' });

  // Broad, honest ramps make every tier navigable by players and bots.
  // Crests finish ~0.65 short of the destination face so the capsule is already
  // at deck height before the slab wall; supportPad carries collision under it.
  addRamp(scene, world, { axis: 'z', minX: -6, maxX: 6, minZ: -30.35, maxZ: -18, h0: 8, h1: 0,
    color: steel, tex: 'tidebreaker-deck', supportPad0: 1.1, supportPad1: 0.4 });
  addRamp(scene, world, { axis: 'z', minX: -6, maxX: 6, minZ: 18, maxZ: 30.35, h0: 0, h1: 8,
    color: steel, tex: 'tidebreaker-deck', supportPad0: 0.4, supportPad1: 1.1 });
  addRamp(scene, world, { axis: 'z', minX: -57, maxX: -49, minZ: -30.35, maxZ: -17.65, h0: 8, h1: 14,
    color: steel, tex: 'tidebreaker-deck', supportPad0: 1.1, supportPad1: 1.1 });
  addRamp(scene, world, { axis: 'z', minX: -57, maxX: -49, minZ: 17.65, maxZ: 30.35, h0: 14, h1: 8,
    color: steel, tex: 'tidebreaker-deck', supportPad0: 1.1, supportPad1: 1.1 });

  // A four-metre service deck interrupts the low floor's longest sightlines
  // without sealing the arena into rooms. Two arrivals keep it useful for
  // circulation rather than turning it into a one-way sniper perch.
  addBox(scene, world, -7, 3.5, -4, 18, 1, 12, steel, {
    ...wetDeck, debugName: 'surge winch service platform',
  });
  addRamp(scene, world, { axis: 'x', minX: -22, maxX: -16, minZ: -8, maxZ: -2, h0: 0, h1: 4,
    color: steel, tex: 'tidebreaker-deck', supportPad0: 0.35, supportPad1: 0.35 });
  addRamp(scene, world, { axis: 'z', minX: -4, maxX: 2, minZ: 2, maxZ: 12, h0: 4, h1: 0,
    color: steel, tex: 'tidebreaker-deck', supportPad0: 0.35, supportPad1: 0.35 });

  // The winch's pump cabinet fills only the middle of the undercroft, creating
  // real eye-level cover while preserving two generous routes around it.
  addBox(scene, world, -8, 1.4, -4, 7.2, 2.8, 3.8, emergencyOrange, {
    ...orangeSteel, debugName: 'surge winch pump cabinet',
  });
  for (const x of [-11.64, -4.36]) addBox(scene, world, x, 1.48, -4, 0.08, 1.9, 2.55, darkSteel, {
    collide: false, shadow: false, roughness: 0.62, metalness: 0.5,
    debugName: 'pump cabinet louver panel',
  });
  for (const x of [-10.4, -8.8, -7.2, -5.6]) {
    for (const z of [-5.94, -2.06]) addBox(scene, world, x, 1.42, z, 0.13, 2.25, 0.08, railSteel, {
      collide: false, shadow: false, roughness: 0.44, metalness: 0.62,
      debugName: 'pump cabinet rib',
    });
  }
  for (const [x, z] of [[-15.35, -9.35], [1.35, -9.35], [-15.35, 1.35]]) {
    addBox(scene, world, x, 1.5, z, 0.62, 3, 0.62, darkSteel, {
      roughness: 0.58, metalness: 0.62, debugName: 'service platform leg',
    });
  }
  const platformBraceGeometries = [];
  for (const [x, z, sx, sz] of [
    [-15.35, -9.35, 1, 1], [1.35, -9.35, -1, 1],
    [-15.35, 1.35, 1, -1],
  ]) platformBraceGeometries.push(cylinderBetween(
    V(x, 0.25, z), V(x + sx * 2.4, 2.95, z + sz * 1.7), 0.13, 7,
  ));
  const platformBraces = new THREE.Mesh(mergeGeometries(platformBraceGeometries, false), mat(railSteel, {
    roughness: 0.46, metalness: 0.64,
  }));
  platformBraces.castShadow = true;
  essential.add(platformBraces);
  platformBraceGeometries.forEach(g => g.dispose());

  // Rail runs have actual posts and two rails, but share the merged static
  // steel material. Openings line up with ramps rather than being decorative.
  const addRailRun = (axis, fixed, y, start, end, openings = []) => {
    const openAt = u => openings.some(([a, b]) => u >= a && u <= b);
    for (let u = start; u <= end + 0.01; u += 4) {
      if (openAt(u)) continue;
      const x = axis === 'x' ? u : fixed;
      const z = axis === 'x' ? fixed : u;
      addBox(scene, world, x, y + 1.05, z, 0.16, 2.1, 0.16, railSteel, {
        roughness: 0.42, metalness: 0.62, debugName: 'rail post',
      });
    }
    let runStart = start;
    const segments = [...openings].sort((a, b) => a[0] - b[0]);
    for (const [a, b] of [...segments, [end, end]]) {
      const stop = Math.min(end, a);
      const len = stop - runStart;
      if (len > 0.3) for (const h of [0.72, 1.65]) {
        addBox(scene, world,
          axis === 'x' ? (runStart + stop) / 2 : fixed,
          y + h,
          axis === 'x' ? fixed : (runStart + stop) / 2,
          axis === 'x' ? len : 0.13, 0.13, axis === 'x' ? 0.13 : len,
          railSteel, { roughness: 0.42, metalness: 0.62, debugName: 'rail beam' });
      }
      runStart = Math.max(runStart, b);
    }
  };
  addRailRun('x', -38.65, 8, -66, 66, [[-59, -47], [-7, 7]]);
  addRailRun('x', 38.65, 8, -66, 66, [[-59, -47], [-7, 7]]);
  addRailRun('z', -66.2, 8, -38, 38, [[-31, 31]]);
  addRailRun('z', 64.2, 8, -38, 38, [[-29, 29]]);
  // Leave the helipad's north and south ramp landings unobstructed. These
  // openings match the full ramp width with a little shoulder clearance so a
  // player cannot clip the end of a beam while stepping onto the pad.
  addRailRun('x', -17.4, 14, -66, -32, [[-58, -48]]);
  addRailRun('x', 17.4, 14, -66, -32, [[-58, -48]]);
  addRailRun('z', -66.4, 14, -17.65, 17.65, []);

  // Partial rails make the new mid deck readable while leaving both ramp
  // landings generously open. The south edge stays open on its east half so
  // players can drop back into the center lane during a surge.
  addRailRun('x', -10.35, 4, -16, 2, [[-5.1, -1.9]]);
  addRailRun('x', 2.35, 4, -16, 2, [[-4.5, 2]]);
  addRailRun('z', -16.35, 4, -10, 2, [[-8.5, -1.5]]);
  addRailRun('z', 2.35, 4, -10, 2, []);

  // Third approach: a proper climbable maintenance ladder on the north face.
  // It reuses the established climb-zone physics (Space climbs, S descends)
  // while the merged steel rails and rungs provide an honest visual surface.
  const ladderX = -3.5, ladderZ = -10.52;
  const ladderGeometries = [];
  for (const x of [ladderX - 0.72, ladderX + 0.72]) {
    ladderGeometries.push(cylinderBetween(V(x, 0.15, ladderZ), V(x, 5.25, ladderZ), 0.09, 7));
  }
  for (let y = 0.45; y <= 4.35; y += 0.48) {
    ladderGeometries.push(cylinderBetween(V(ladderX - 0.72, y, ladderZ), V(ladderX + 0.72, y, ladderZ), 0.075, 7));
  }
  const ladder = new THREE.Mesh(mergeGeometries(ladderGeometries, false), mat(railSteel, {
    roughness: 0.42, metalness: 0.66,
  }));
  ladder.castShadow = true;
  essential.add(ladder);
  ladderGeometries.forEach(g => g.dispose());
  (world.vineZones ||= []).push({
    x: ladderX, z: ladderZ - 0.08, minY: 0.1, maxY: 4.15,
    r: 0.82, grabR: 1.18, exitX: 0, exitZ: 1,
  });

  // Ocean recovery ladders on opposite ends of the rig: west face of the
  // helipad and east face of the ops block. Reachable from the water and
  // exiting inward onto the nearest high deck.
  const addOceanLadder = (x, z, y0, y1, exitX, exitZ) => {
    const geometries = [];
    const half = 0.72;
    for (const dz of [-half, half]) {
      geometries.push(cylinderBetween(V(x, y0, z + dz), V(x, y1, z + dz), 0.1, 7));
    }
    for (let y = y0 + 0.4; y <= y1 - 0.3; y += 0.48) {
      geometries.push(cylinderBetween(V(x, y, z - half), V(x, y, z + half), 0.08, 7));
    }
    const mesh = new THREE.Mesh(mergeGeometries(geometries, false), mat(railSteel, {
      roughness: 0.4, metalness: 0.68,
    }));
    mesh.castShadow = true;
    essential.add(mesh);
    geometries.forEach(g => g.dispose());
    (world.vineZones ||= []).push({
      x: x - exitX * 0.08, z, minY: y0, maxY: y1 - 0.3,
      r: 0.9, grabR: 1.35, exitX, exitZ,
    });
  };
  // West helipad face → pad deck; east ops outer wall → operations roof.
  addOceanLadder(-66.3, 0, oceanSurfaceY - 1.2, 14.25, 1, 0);
  addOceanLadder(64.2, 0, oceanSurfaceY - 1.2, 8.25, -1, 0);

  // A cable-loaded surge winch supplies a broad rounded occluder instead of a
  // plain cover cube. Braced A-frames, bearing flanges, axle, and rope bands
  // keep the silhouette legible from both floor level and the high catwalks.
  addBox(scene, world, -8, 4.35, -4, 9.8, 0.7, 6.6, darkSteel, {
    roughness: 0.55, metalness: 0.58, debugName: 'surge winch plinth',
  });
  const winchDrumMaterial = mat(0x323a3c, { roughness: 0.68, metalness: 0.42 });
  const winchOrangeMaterial = mat(0xffffff, orangeSteel);
  const winchDrum = new THREE.Mesh(new THREE.CylinderGeometry(1.85, 1.85, 4.6, 24, 1), winchDrumMaterial);
  winchDrum.rotation.x = Math.PI / 2;
  winchDrum.position.set(-8, 6.45, -4);
  winchDrum.castShadow = winchDrum.receiveShadow = true;
  essential.add(winchDrum);
  for (const z of [-6.42, -1.58]) {
    const flange = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 0.24, 22, 1), winchOrangeMaterial);
    flange.rotation.x = Math.PI / 2;
    flange.position.set(-8, 6.45, z);
    flange.castShadow = true;
    essential.add(flange);
  }
  const cableGeometries = [];
  for (const z of [-5.62, -4.82, -4.02, -3.22, -2.42]) {
    const cableRing = new THREE.TorusGeometry(1.9, 0.12, 7, 24);
    cableRing.translate(-8, 6.45, z);
    cableGeometries.push(cableRing);
  }
  const winchCable = new THREE.Mesh(mergeGeometries(cableGeometries, false), mat(0x171a18, {
    roughness: 0.92, metalness: 0.08,
  }));
  winchCable.castShadow = true;
  essential.add(winchCable);
  cableGeometries.forEach(g => g.dispose());
  const winchBraceGeometries = [];
  for (const z of [-6.55, -1.45]) {
    winchBraceGeometries.push(cylinderBetween(V(-12.1, 4.65, z), V(-8, 6.45, z), 0.22, 7));
    winchBraceGeometries.push(cylinderBetween(V(-3.9, 4.65, z), V(-8, 6.45, z), 0.22, 7));
  }
  const winchBraces = new THREE.Mesh(mergeGeometries(winchBraceGeometries, false), winchOrangeMaterial);
  winchBraces.castShadow = true;
  essential.add(winchBraces);
  winchBraceGeometries.forEach(g => g.dispose());
  const winchAxle = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 5.5, 10), mat(0xc99c3f, {
    roughness: 0.34, metalness: 0.72,
  }));
  winchAxle.rotation.x = Math.PI / 2;
  winchAxle.position.set(-8, 6.45, -4);
  essential.add(winchAxle);
  world.colliders.push({
    type: 'box', min: V(-10.2, 4.55, -6.55), max: V(-5.8, 8.65, -1.45),
  });

  // A compact local control stand adds close cover without hiding a ramp or
  // widening the main winch collider beyond its visible machinery.
  addBox(scene, world, -13.3, 4.9, -7.3, 2.2, 1.8, 1.7, emergencyOrange, {
    ...orangeSteel, debugName: 'surge winch control stand',
  });
  addBox(scene, world, -13.3, 5.35, -6.42, 1.45, 0.52, 0.08, 0x5be7d0, {
    collide: false, shadow: false, emissive: 0x2ccbb9, emissiveIntensity: 1.1,
    debugName: 'surge winch control screen',
  });

  // Operations block: floodable machinery rooms below, a protected combat
  // roof above, and a glazed control cabin instead of an empty box landmark.
  addBox(scene, world, 63.4, 3.8, 0, 1.2, 7.6, 62, emergencyOrange, { ...orangeSteel, debugName: 'east outer wall' });
  for (const z of [-25, 25]) {
    addBox(scene, world, 49, 3.8, z, 28, 7.6, 1.2, emergencyOrange, { ...orangeSteel, debugName: 'operations end wall' });
  }
  for (const z of [-14.5, 14.5]) {
    addBox(scene, world, 35.2, 3.8, z, 1.2, 7.6, 19, emergencyOrange, { ...orangeSteel, debugName: 'operations doorway wall' });
  }
  // Face the processing deck so both posters announce the ops block without
  // covering its doors, windows, warning fascia, or climb route.
  for (const z of [-14.5, 14.5]) {
    addDecal(scene, 'poster-tidebreaker', 34.57, 3.8, z, 5.8, -Math.PI / 2);
  }
  // A painted fascia and external stiffeners keep the broad roof silhouette
  // from reading as a featureless dark slab when viewed from the ocean.
  for (const z of [-30.41, 30.41]) addBox(scene, world, 49, 7.48, z, 30, 0.9, 0.12, emergencyOrange, {
    ...orangeSteel, collide: false, shadow: false, debugName: 'operations roof fascia',
  });
  for (const x of [33.94, 64.06]) addBox(scene, world, x, 7.48, 0, 0.12, 0.9, 60.7, emergencyOrange, {
    ...orangeSteel, collide: false, shadow: false, debugName: 'operations roof fascia',
  });
  for (let z = -27; z <= 27; z += 6) addBox(scene, world, 64.03, 3.8, z, 0.14, 6.5, 0.32, railSteel, {
    collide: false, roughness: 0.42, metalness: 0.62, debugName: 'operations wall stiffener',
  });
  addBox(scene, world, 52, 11.2, 0, 18, 6.4, 15, emergencyOrange, { ...orangeSteel, debugName: 'control cabin' });
  const windowMaterial = new THREE.MeshStandardMaterial({
    color: 0x244b5f, emissive: 0x0c3146, emissiveIntensity: 0.42,
    roughness: 0.12, metalness: 0.12, transparent: true, opacity: 0.78,
  });
  for (const z of [-7.56, 7.56]) {
    const windows = new THREE.Mesh(new THREE.PlaneGeometry(12, 2.6), windowMaterial);
    windows.position.set(52, 11.7, z);
    windows.rotation.y = z > 0 ? 0 : Math.PI;
    essential.add(windows);
  }
  addArenaSign(essential, 'TIDEBREAKER // OPS', 52, 15.1, 7.62, 13, 2.2, 0, '#e6b45c', 'marine');

  // Cargo containers use corrugated ribs, end doors, locking bars, and corner
  // castings. Colliders remain a single box apiece; the visible detail merges.
  const addContainer = (x, y, z, yaw = 0, color = 0xffffff) => {
    const alongX = Math.abs(Math.sin(yaw)) < 0.5;
    const w = alongX ? 12 : 3.4;
    const d = alongX ? 3.4 : 12;
    addBox(scene, world, x, y + 1.55, z, w, 3.1, d, color, { ...orangeSteel, debugName: 'cargo container' });
    const ribColor = 0x35434a;
    for (let u = -5; u <= 5; u += 1.25) {
      addBox(scene, world,
        x + (alongX ? u : -1.74), y + 1.55, z + (alongX ? -1.74 : u),
        alongX ? 0.12 : 0.11, 2.65, alongX ? 0.11 : 0.12,
        ribColor, { collide: false, shadow: false, roughness: 0.55, metalness: 0.48, debugName: 'container rib' });
    }
    const end = alongX ? x + 6.04 : z + 6.04;
    for (const side of [-0.72, 0.72]) {
      addBox(scene, world,
        alongX ? end : x + side, y + 1.55, alongX ? z + side : end,
        alongX ? 0.1 : 0.09, 2.7, alongX ? 0.09 : 0.1,
        railSteel, { collide: false, shadow: false, metalness: 0.62, debugName: 'container locking bar' });
    }
  };
  addContainer(-23, 0, -12, 0);
  addContainer(-28, 0, 9, 0);
  addContainer(-8, 0, 10, Math.PI / 2);
  addContainer(12, 0, -11, Math.PI / 2);
  addContainer(22, 0, 11, 0);

  // Cylindrical separators, pressure rings, manifolds, and bent pipe runs sell
  // the processing deck while keeping the center lanes readable.
  const tankMat = mat(0xaebbc0, { roughness: 0.38, metalness: 0.62 });
  for (const [x, z, r, h] of [[48, -14, 2.7, 5.2], [55, -14, 2.2, 4.2], [49, 14, 2.4, 4.8]]) {
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.03, h, 18, 1), tankMat);
    tank.position.set(x, h / 2, z);
    tank.castShadow = tank.receiveShadow = true;
    standard.add(tank);
    world.colliders.push({ type: 'box', min: V(x - r, 0, z - r), max: V(x + r, h, z + r) });
    for (const ringY of [0.65, h - 0.65]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r + 0.06, 0.11, 6, 24), tankMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(x, ringY, z);
      standard.add(ring);
    }
  }
  // Building-side termini seat inside the separator tanks so the runs read as
  // hard-piped into the vessels instead of stopping a few feet short.
  const pipePaths = [
    [V(47.6, 1.55, -14.15), V(43.2, 1.85, -16.4), V(41, 2.2, -8), V(34, 2.2, -2), V(26, 1.0, -2)],
    [V(47.9, 1.45, 14.2), V(43.4, 1.7, 16.6), V(36, 2.8, 18), V(30, 2.8, 13), V(26, 1.1, 13)],
  ];
  const pipeGeometries = [];
  for (const points of pipePaths) {
    const curve = new THREE.CatmullRomCurve3(points);
    pipeGeometries.push(new THREE.TubeGeometry(curve, 28, 0.32, 7, false));
    // Closely spaced sphere colliders follow the actual bends instead of using
    // one oversized box that would invisibly block the open diagonal lanes.
    const collisionSamples = curve.getSpacedPoints(Math.ceil(curve.getLength() / 1.05));
    for (const center of collisionSamples) world.colliders.push({
      type: 'sphere', center: center.clone(), radius: 0.38,
    });
  }
  const pipes = new THREE.Mesh(mergeGeometries(pipeGeometries, false), mat(0xe5c15a, {
    roughness: 0.42, metalness: 0.58,
  }));
  pipes.castShadow = true;
  // Gameplay collision remains active on low quality, so the pipe silhouette
  // must remain visible there as well.
  essential.add(pipes);
  pipeGeometries.forEach(g => g.dispose());

  // Both low open pipe mouths now leak. Curved falling streams make the oil
  // visibly leave the actual pipe ends instead of appearing beneath a made-up
  // drain halfway along one run.
  const oilStreamMaterial = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uOpacity: { value: 1 } },
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uOpacity;
      varying vec2 vUv;
      void main() {
        float flow = sin((vUv.x - uTime * 1.35) * 42.0 + sin(vUv.y * 13.0) * 1.7);
        float glint = smoothstep(0.52, 1.0, flow) * 0.12;
        vec3 oil = mix(vec3(0.055, 0.045, 0.025), vec3(0.20, 0.14, 0.035), glint);
        gl_FragColor = vec4(oil, uOpacity * (0.84 + glint));
      }
    `,
    transparent: true,
    depthWrite: false,
  });
  const oilStreams = [];
  for (const [mouthY, z, bendZ] of [[1.0, -2, -2.15], [1.1, 13, 12.8]]) {
    const streamCurve = new THREE.CatmullRomCurve3([
      V(25.78, mouthY, z), V(25.15, mouthY * 0.78, bendZ), V(24.45, 0.09, bendZ),
    ]);
    const stream = new THREE.Mesh(new THREE.TubeGeometry(streamCurve, 12, 0.13, 7, false), oilStreamMaterial);
    stream.renderOrder = 5;
    essential.add(stream);
    oilStreams.push(stream);
  }

  // One connected, concave shoreline forms two source branches that converge
  // into a broad center-lane pool. Shape coordinates use -Z because the mesh
  // is rotated onto the deck with its front face pointing upward.
  // Sit above deck tread / surface panels (eps ~0.04) so the slick never z-fights.
  const oilCenter = V(5.5, 0.09, 4.1);
  const oilShape = new THREE.Shape();
  const oilOutline = [
    [25.2, -4.0], [22.0, -3.8], [18.1, -2.8], [14.2, -1.0], [10.4, 0.9],
    [8.0, -0.5], [4.2, -1.2], [1.0, 0.1], [-0.8, 2.6], [-0.2, 6.1],
    [2.0, 8.8], [5.7, 10.1], [8.9, 9.0], [12.0, 9.8], [16.0, 12.0],
    [20.6, 14.7], [24.7, 15.4], [26.0, 13.2], [24.6, 10.8], [20.2, 10.1],
    [16.2, 7.8], [12.1, 5.5], [10.9, 3.9], [14.2, 3.3], [18.2, 1.8],
    [22.1, 0.4], [25.5, 0.2], [26.1, -1.9],
  ];
  for (let i = 0; i < oilOutline.length; i++) {
    const [x, z] = oilOutline[i];
    const ragX = x + Math.sin(i * 2.17) * 0.16;
    const ragZ = z + Math.cos(i * 1.73) * 0.14;
    if (i === 0) oilShape.moveTo(ragX, -ragZ); else oilShape.lineTo(ragX, -ragZ);
  }
  oilShape.closePath();
  const oilPuddleMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uOpacity: { value: 0.86 }, uFill: { value: 1 },
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uOpacity;
      uniform float uFill;
      varying vec3 vWorldPosition;
      void main() {
        float fillFront = mix(24.8, -1.5, uFill);
        float revealed = smoothstep(fillFront - 0.8, fillFront + 1.1, vWorldPosition.x);
        float longFlow = sin(vWorldPosition.x * 1.42 + vWorldPosition.z * 0.23 + uTime * 2.5);
        float crossFlow = sin(vWorldPosition.x * 0.38 - vWorldPosition.z * 1.9 + uTime * 1.15);
        float sheen = smoothstep(0.58, 1.0, longFlow * 0.72 + crossFlow * 0.28) * 0.16;
        vec3 base = vec3(0.035, 0.031, 0.022);
        vec3 amber = vec3(0.22, 0.15, 0.035);
        gl_FragColor = vec4(mix(base, amber, sheen), uOpacity * revealed * (0.82 + sheen));
      }
    `,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -10,
  });
  const oilPuddle = new THREE.Mesh(new THREE.ShapeGeometry(oilShape, 1), oilPuddleMaterial);
  oilPuddle.rotation.x = -Math.PI / 2;
  oilPuddle.position.y = oilCenter.y;
  oilPuddle.receiveShadow = true;
  oilPuddle.renderOrder = 4;
  essential.add(oilPuddle);

  let oilFill = 1;
  let oilWashedCycle = -1;
  world.oilSlick = { center: oilCenter, get fill() { return oilFill; } };
  world.characterTraction = character => {
    if (oilFill < 0.08 || !character?.pos || character.pos.y > 1.25) return 1;
    const fillFront = THREE.MathUtils.lerp(24.8, -1.5, oilFill);
    if (character.pos.x < fillFront - 1.2) return 1;
    const distanceToSegment = (ax, az, bx, bz) => {
      const abx = bx - ax, abz = bz - az;
      const t = THREE.MathUtils.clamp(((character.pos.x - ax) * abx + (character.pos.z - az) * abz) / (abx * abx + abz * abz), 0, 1);
      return Math.hypot(character.pos.x - (ax + abx * t), character.pos.z - (az + abz * t));
    };
    const sourceA = 1 - distanceToSegment(24.7, -2, 7.5, 3.5) / 2.65;
    const sourceB = 1 - distanceToSegment(24.7, 13, 7.5, 4.8) / 2.8;
    const pool = 1 - Math.hypot((character.pos.x - oilCenter.x) / 6.8, (character.pos.z - oilCenter.z) / 5.7);
    const depth = Math.max(sourceA, sourceB, pool);
    if (depth <= 0) return 1;
    return THREE.MathUtils.lerp(0.28, 0.045, THREE.MathUtils.smoothstep(depth, 0, 0.72));
  };

  // The crane is a real truss silhouette with braced tower, operator cab,
  // trolley, cable, hook, and a suspended rescue pallet that moves subtly.
  const craneGeometries = [];
  const craneBeam = (a, b, r = 0.22) => craneGeometries.push(cylinderBetween(a, b, r, 6));
  const craneX = 6, craneZ = 5;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x0 = craneX + sx * 1.5, z0 = craneZ + sz * 1.5;
    const x1 = craneX + sx * 1.05, z1 = craneZ + sz * 1.05;
    craneBeam(V(x0, 0, z0), V(x1, 24, z1), 0.34);
    // Solid support poles — players should bump into the tower legs.
    const pad = 0.4;
    world.colliders.push({
      type: 'box',
      min: V(Math.min(x0, x1) - pad, 0, Math.min(z0, z1) - pad),
      max: V(Math.max(x0, x1) + pad, 24, Math.max(z0, z1) + pad),
    });
  }
  for (let y = 2; y <= 22; y += 4) {
    craneBeam(V(craneX - 1.4 + y * 0.015, y, craneZ - 1.4 + y * 0.015), V(craneX + 1.4 - y * 0.015, y + 3.2, craneZ - 1.4 + y * 0.015), 0.16);
    craneBeam(V(craneX + 1.4 - y * 0.015, y, craneZ + 1.4 - y * 0.015), V(craneX - 1.4 + y * 0.015, y + 3.2, craneZ + 1.4 - y * 0.015), 0.16);
  }
  for (const zOff of [-1.05, 1.05]) {
    craneBeam(V(craneX - 19, 24, craneZ + zOff), V(craneX + 31, 24, craneZ + zOff), 0.3);
    craneBeam(V(craneX - 19, 24, craneZ + zOff), V(craneX + 9, 31, craneZ + zOff), 0.24);
    craneBeam(V(craneX + 9, 31, craneZ + zOff), V(craneX + 31, 24, craneZ + zOff), 0.24);
    for (let x = craneX - 17; x < craneX + 30; x += 5) {
      craneBeam(V(x, 24, craneZ + zOff), V(x + 5, 25.25 + Math.sin((x - craneX) * 0.1) * 1.8, craneZ + zOff), 0.12);
    }
  }
  const crane = new THREE.Mesh(mergeGeometries(craneGeometries, false), mat(0xffffff, orangeSteel));
  crane.castShadow = crane.receiveShadow = true;
  essential.add(crane);
  craneGeometries.forEach(g => g.dispose());
  const craneCab = new THREE.Mesh(new THREE.BoxGeometry(5.2, 3.8, 4.4), mat(0xffffff, orangeSteel));
  craneCab.position.set(craneX + 4.6, 25.4, craneZ);
  essential.add(craneCab);
  const cabGlass = new THREE.Mesh(new THREE.PlaneGeometry(3.1, 1.55), windowMaterial);
  cabGlass.position.set(craneX + 7.22, 25.7, craneZ);
  cabGlass.rotation.y = Math.PI / 2;
  essential.add(cabGlass);
  const trolley = new THREE.Group();
  trolley.position.set(craneX + 21, 23.4, craneZ);
  const trolleyBody = new THREE.Mesh(new THREE.BoxGeometry(2.7, 1.2, 3.2), mat(0x343d42, { metalness: 0.7, roughness: 0.38 }));
  const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 12.5, 6), mat(0x14191c, { metalness: 0.8, roughness: 0.4 }));
  cable.position.y = -6.6;
  const hook = new THREE.Mesh(new THREE.TorusGeometry(0.48, 0.13, 7, 16, Math.PI * 1.55), mat(0xd2a43e, { metalness: 0.62, roughness: 0.42 }));
  hook.position.y = -13;
  hook.rotation.z = Math.PI / 2;
  trolley.add(trolleyBody, cable, hook);
  high.add(trolley);

  // Enclosed orange lifeboats are layered capsules with glazing, keel, racks,
  // and davit arms; they read as purpose-built safety equipment at a glance.
  // Parked on the evacuation catwalks (not the inner lip) so the davit poles
  // plant into solid deck instead of hanging over the gap to the low floor.
  const lifeboats = [];
  for (const [x, z, yaw] of [[-26, -34.2, 0], [21, 34.2, Math.PI]]) {
    const boat = new THREE.Group();
    boat.position.set(x, 10.7, z);
    boat.rotation.y = yaw;
    const hull = new THREE.Mesh(new THREE.CapsuleGeometry(1.75, 6.2, 6, 12), mat(0xffffff, orangeSteel));
    hull.rotation.z = Math.PI / 2;
    hull.scale.set(1, 1, 0.82);
    const keel = new THREE.Mesh(new THREE.BoxGeometry(7.2, 0.35, 0.32), mat(0x303a40, { metalness: 0.52, roughness: 0.5 }));
    keel.position.y = -1.15;
    const glass = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.72, 2.78), windowMaterial);
    glass.position.y = 0.72;
    boat.add(hull, keel, glass);
    for (const sx of [-4.6, 4.6]) {
      // Bottom digs into the catwalk slab (top y=8) so the poles read as mounted.
      const davit = new THREE.Mesh(cylinderBetween(V(sx, -3.05, 0), V(sx, 2.8, 0), 0.15, 7), mat(0xb7c2c7, { metalness: 0.62, roughness: 0.42 }));
      boat.add(davit);
    }
    // Five overlapping spheres follow the capsule hull closely enough to keep
    // its rounded ends and curved top, unlike one oversized invisible box.
    // Lifeboats remain visible on low quality because they are now gameplay
    // geometry rather than presentation-only dressing.
    for (const localX of [-3.4, -1.7, 0, 1.7, 3.4]) {
      const rotatedX = Math.cos(yaw) * localX;
      const rotatedZ = -Math.sin(yaw) * localX;
      world.colliders.push({
        type: 'sphere', center: V(x + rotatedX, 10.7, z + rotatedZ), radius: 1.65,
      });
    }
    essential.add(boat);
    lifeboats.push(boat);
  }

  // Helipad paint is a surface layer above the generated tread, not a second
  // coplanar slab. Concentric rings and spokes stay crisp at every tier.
  const helipad = new THREE.Group();
  helipad.position.set(-49, 14.04, 0);
  const padDisc = new THREE.Mesh(new THREE.CircleGeometry(14.7, 64), new THREE.MeshBasicMaterial({ color: 0x1e3138, ...DECOR_DEPTH_BIAS }));
  padDisc.rotation.x = -Math.PI / 2;
  const padRing = new THREE.Mesh(new THREE.RingGeometry(11.8, 12.45, 64), new THREE.MeshBasicMaterial({ color: 0xffc84a, side: THREE.DoubleSide, ...DECOR_DEPTH_BIAS }));
  padRing.rotation.x = -Math.PI / 2;
  padRing.position.y = 0.025;
  helipad.add(padDisc, padRing);
  for (const x of [-3.9, 3.9]) {
    const stroke = new THREE.Mesh(new THREE.BoxGeometry(1.25, 0.04, 9.8), new THREE.MeshBasicMaterial({ color: 0xf0eadb }));
    stroke.position.set(x, 0.06, 0);
    helipad.add(stroke);
  }
  const cross = new THREE.Mesh(new THREE.BoxGeometry(7.8, 0.04, 1.25), new THREE.MeshBasicMaterial({ color: 0xf0eadb }));
  cross.position.y = 0.06;
  helipad.add(cross);
  essential.add(helipad);

  // Warning beacons: emissive housings are always present; point-light bloom
  // and rotating volumetric cones are reserved for medium/high tiers.
  const beaconLenses = [];
  const beaconLights = [];
  const beaconCones = [];
  for (const [x, y, z] of [[-8, 10.2, -35], [8, 10.2, 35], [34, 10.2, -35], [34, 10.2, 35]]) {
    addBox(scene, world, x, y - 1.1, z, 0.32, 2.2, 0.32, darkSteel, { collide: false, metalness: 0.62, debugName: 'warning beacon mast' });
    const lensMat = new THREE.MeshBasicMaterial({ color: 0x280806, toneMapped: false });
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.42, 0.62, 12), lensMat);
    lens.position.set(x, y + 0.28, z);
    essential.add(lens);
    beaconLenses.push(lens);
    const light = new THREE.PointLight(0xff3c18, 0, 19);
    light.position.set(x, y + 0.25, z);
    standard.add(light);
    beaconLights.push(light);
    // Pivot at the lens so the volume sweeps out of the lamp instead of
    // spinning around the cone's geometric center above it.
    const pivot = new THREE.Group();
    pivot.position.set(x, y + 0.35, z);
    const coneLen = 12;
    const cone = new THREE.Mesh(new THREE.ConeGeometry(2.7, coneLen, 18, 1, true), new THREE.MeshBasicMaterial({
      color: 0xff4b26, transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false,
    }));
    cone.rotation.z = Math.PI / 2;
    cone.position.set(coneLen * 0.5, 0, 0);
    pivot.add(cone);
    high.add(pivot);
    beaconCones.push({ pivot, cone });
  }

  // Flood plane and the breaker are separate animated surfaces. The breaker
  // curls forward through an actual grid; it is never a translated wall box.
  // Top sheet covers the full 124×66 processing deck; vertical spill sheets on
  // each lip sell water pouring off the sides instead of a floating inset slab.
  // During the surge the sheet is clipped to the wet side of the front so the
  // breaker reads as bringing the water onto the deck.
  const DECK_HALF_X = 62;
  const DECK_HALF_Z = 33;
  const floodMat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uAmplitude: { value: 0.17 },
        uChop: { value: 0.065 },
        uDeep: { value: new THREE.Color(0x0a3242) },
        uShallow: { value: new THREE.Color(0x3e8390) },
        uOpacity: { value: 0.68 },
        uFoamLine: { value: 0.31 },
        uFront: { value: 200 },
        uDirX: { value: 0 },
        uDirZ: { value: 1 },
        uClip: { value: 0 },
      },
    ]),
    vertexShader: waterVertex,
    fragmentShader: `
      #include <fog_pars_fragment>
      uniform vec3 uDeep;
      uniform vec3 uShallow;
      uniform float uOpacity;
      uniform float uFoamLine;
      uniform float uFront;
      uniform float uDirX;
      uniform float uDirZ;
      uniform float uClip;
      varying vec3 vWorldPosition;
      varying float vElevation;
      void main() {
        float edge = 1.0;
        if (uClip > 0.5) {
          float along = vWorldPosition.x * uDirX + vWorldPosition.z * uDirZ;
          // Soft foam band just behind the breaker; dry ahead of the crest.
          edge = smoothstep(uFront + 1.2, uFront - 3.4, along);
          if (edge <= 0.008) discard;
        }
        vec3 dx = dFdx(vWorldPosition);
        vec3 dy = dFdy(vWorldPosition);
        vec3 normal = normalize(cross(dx, dy));
        if (normal.y < 0.0) normal *= -1.0;
        vec3 viewDir = normalize(cameraPosition - vWorldPosition);
        float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 2.35);
        float light = max(dot(normal, normalize(vec3(-0.35, 0.86, -0.22))), 0.0);
        vec3 color = mix(uDeep, uShallow, 0.24 + light * 0.4 + fresnel * 0.28);
        float foamBreakup = sin(vWorldPosition.x * 0.63 + vWorldPosition.z * 0.27) * 0.11
          + sin(vWorldPosition.x * -0.31 + vWorldPosition.z * 0.74) * 0.07;
        float foam = smoothstep(uFoamLine + foamBreakup, uFoamLine + 0.18 + foamBreakup, vElevation);
        // Brighter chop where the flood meets the breaker face.
        float frontFoam = uClip > 0.5 ? (1.0 - smoothstep(0.15, 0.95, edge)) * 0.55 : 0.0;
        color = mix(color, vec3(0.78, 0.92, 0.94), foam * 0.1 + frontFoam);
        gl_FragColor = vec4(color, uOpacity * edge);
        #include <fog_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  });
  const floodMesh = new THREE.Mesh(new THREE.PlaneGeometry(DECK_HALF_X * 2, DECK_HALF_Z * 2, 60, 34), floodMat);
  floodMesh.rotation.x = -Math.PI / 2;
  floodMesh.position.y = -4.8;
  floodMesh.renderOrder = 3;
  essential.add(floodMesh);
  const floodZone = {
    minX: -DECK_HALF_X, maxX: DECK_HALF_X, minZ: -DECK_HALF_Z, maxZ: DECK_HALF_Z,
    surfaceY: -4.8, bottomY: -2.4,
  };
  world.waterZones.push(floodZone);
  const FLOOD_PEAK = 1.95;
  const FLOOD_EMPTY = 0.02;
  const syncFloodZoneBounds = (clipping, front, dirX, dirZ) => {
    floodZone.minX = -DECK_HALF_X;
    floodZone.maxX = DECK_HALF_X;
    floodZone.minZ = -DECK_HALF_Z;
    floodZone.maxZ = DECK_HALF_Z;
    if (!clipping) return;
    const pad = 2.2;
    if (dirX > 0.5) floodZone.maxX = Math.min(DECK_HALF_X, front - pad);
    else if (dirX < -0.5) floodZone.minX = Math.max(-DECK_HALF_X, -(front - pad));
    else if (dirZ > 0.5) floodZone.maxZ = Math.min(DECK_HALF_Z, front - pad);
    else if (dirZ < -0.5) floodZone.minZ = Math.max(-DECK_HALF_Z, -(front - pad));
  };

  const spillMat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uOpacity: { value: 0 },
        uDeep: { value: new THREE.Color(0x0a3242) },
        uShallow: { value: new THREE.Color(0x4e96a4) },
      },
    ]),
    vertexShader: `
      #include <fog_pars_vertex>
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }
    `,
    fragmentShader: `
      #include <fog_pars_fragment>
      uniform float uTime;
      uniform float uOpacity;
      uniform vec3 uDeep;
      uniform vec3 uShallow;
      varying vec2 vUv;
      void main() {
        // Top of the sheet is the flood surface; flow runs downward off the lip.
        float flow = vUv.y * 5.5 + uTime * 2.4;
        float streaks = 0.5 + 0.5 * sin(vUv.x * 54.0 - flow * 3.1);
        streaks *= 0.65 + 0.35 * sin(vUv.x * 17.0 + uTime * 1.3);
        float curtain = smoothstep(0.0, 0.08, vUv.y) * smoothstep(1.0, 0.42, vUv.y);
        float lipFoam = smoothstep(0.78, 1.0, vUv.y) * (0.55 + 0.45 * sin(vUv.x * 90.0 - uTime * 10.0));
        vec3 color = mix(uDeep, uShallow, streaks * 0.55 + lipFoam * 0.35);
        float alpha = uOpacity * curtain * (0.28 + streaks * 0.55 + lipFoam * 0.3);
        gl_FragColor = vec4(color, alpha);
        #include <fog_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  });
  // [width, x, z, yaw] — yaw faces the sheet outward from the deck.
  const spillDefs = [
    [DECK_HALF_X * 2, 0, -DECK_HALF_Z - 0.04, Math.PI],
    [DECK_HALF_X * 2, 0, DECK_HALF_Z + 0.04, 0],
    [DECK_HALF_Z * 2, -DECK_HALF_X - 0.04, 0, -Math.PI / 2],
    [DECK_HALF_Z * 2, DECK_HALF_X + 0.04, 0, Math.PI / 2],
  ];
  const spillMeshes = spillDefs.map(([width, x, z, yaw]) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, 1, Math.max(12, Math.round(width / 3)), 14), spillMat);
    mesh.position.set(x, -4.8, z);
    mesh.rotation.y = yaw;
    mesh.renderOrder = 4;
    mesh.visible = false;
    essential.add(mesh);
    return mesh;
  });
  const spillBottomY = oceanSurfaceY + 0.65;

  const breakerCols = 88;
  const breakerRows = 12;
  const breakerGeometry = new THREE.PlaneGeometry(1, 1, breakerCols, breakerRows);
  const breakerPositions = breakerGeometry.attributes.position;
  const breakerMaterial = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uOpacity: { value: 0 } },
    vertexShader: `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uOpacity;
      varying vec2 vUv;
      void main() {
        float waveHeight = 1.0 - vUv.y;
        float crest = smoothstep(0.67, 0.96, waveHeight);
        float ribbons = sin(vUv.x * 105.0 + uTime * 4.2) * 0.06 + sin(vUv.y * 31.0 - uTime * 3.0) * 0.05;
        vec3 deep = vec3(0.025, 0.22, 0.29);
        vec3 pale = vec3(0.68, 0.9, 0.93);
        float foamRag = sin(vUv.x * 147.0 - uTime * 5.1) * 0.045 + sin(vUv.x * 61.0 + uTime * 2.8) * 0.035;
        float foam = smoothstep(0.86 + foamRag, 0.97 + foamRag, waveHeight);
        vec3 color = mix(deep, pale, crest * 0.3 + foam * 0.76 + ribbons);
        gl_FragColor = vec4(color, uOpacity * (0.58 + crest * 0.34));
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const breaker = new THREE.Mesh(breakerGeometry, breakerMaterial);
  breaker.frustumCulled = false;
  breaker.renderOrder = 4;
  essential.add(breaker);

  const sprayCount = 260;
  const sprayPositions = new Float32Array(sprayCount * 3);
  const sprayVelocity = Array.from({ length: sprayCount }, () => V(0, 0, 0));
  const sprayLife = new Float32Array(sprayCount);
  const sprayGeo = new THREE.BufferGeometry();
  sprayGeo.setAttribute('position', new THREE.BufferAttribute(sprayPositions, 3));
  const sprayMaterial = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0 } },
    vertexShader: `
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = clamp(96.0 / max(1.0, -mvPosition.z), 1.8, 7.0);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform float uOpacity;
      void main() {
        vec2 p = gl_PointCoord - vec2(0.5);
        float d = length(p);
        float alpha = 1.0 - smoothstep(0.26, 0.5, d);
        gl_FragColor = vec4(0.78, 0.95, 1.0, alpha * uOpacity);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const spray = new THREE.Points(sprayGeo, sprayMaterial);
  spray.frustumCulled = false;
  essential.add(spray);

  // Permanent slanted rain uses one line-segment buffer centered on the local
  // viewer. A fixed arena box made rain vanish when facing open water, and a
  // single shared slant collapsed every streak when the camera lined up with it.
  // Draw range and update work both follow visual quality; low still keeps
  // enough rain for identity.
  const rainCount = 980;
  const rainPositions = new Float32Array(rainCount * 6);
  const rainOrigin = { x: 0, z: 0 };
  const rainHalfX = 36;
  const rainHalfZ = 36;
  const rainLenY = 3.4;
  const resetRain = (i, y = rand(5, 55)) => {
    const j = i * 6;
    const x = rainOrigin.x + rand(-rainHalfX, rainHalfX);
    const z = rainOrigin.z + rand(-rainHalfZ, rainHalfZ);
    // Per-drop slant variance keeps streaks from disappearing at one camera yaw.
    const slantX = -0.45 - Math.random() * 0.7;
    const slantZ = 0.12 + Math.random() * 0.45;
    rainPositions[j] = x; rainPositions[j + 1] = y; rainPositions[j + 2] = z;
    rainPositions[j + 3] = x + slantX; rainPositions[j + 4] = y - rainLenY; rainPositions[j + 5] = z + slantZ;
  };
  for (let i = 0; i < rainCount; i++) resetRain(i);
  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPositions, 3));
  rainGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 24, 0), 96);
  const rain = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({
    color: 0xaed9e9, transparent: true, opacity: 0.58, depthWrite: false, fog: false,
  }));
  rain.frustumCulled = false;
  rain.renderOrder = 3;
  essential.add(rain);

  // Permanent storm lightning across the full visible map field (platform +
  // surrounding ocean still inside fog). Uniform X/Z picks so bolts hit every
  // side equally — not one corner, and not invisible far-ocean samples.
  const LIGHTNING_MIN_X = -200;
  const LIGHTNING_MAX_X = 200;
  const LIGHTNING_MIN_Z = -160;
  const LIGHTNING_MAX_Z = 160;
  const randomLightningCoord = () => [
    THREE.MathUtils.lerp(LIGHTNING_MIN_X, LIGHTNING_MAX_X, Math.random()),
    THREE.MathUtils.lerp(LIGHTNING_MIN_Z, LIGHTNING_MAX_Z, Math.random()),
  ];
  const boltPoints = 11;
  const boltMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending, fog: false,
  });
  const boltGlowMat = new THREE.MeshBasicMaterial({
    color: 0x8fe8ff, transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending, fog: false,
  });
  const emptyBoltGeo = () => new THREE.CylinderGeometry(0.01, 0.01, 0.01, 3);
  const bolt = new THREE.Mesh(emptyBoltGeo(), boltMat);
  bolt.frustumCulled = false;
  scene.add(bolt);
  const boltGlow = new THREE.Mesh(emptyBoltGeo(), boltGlowMat);
  boltGlow.frustumCulled = false;
  scene.add(boltGlow);
  const forkCount = 8;
  const forkPositions = new Float32Array(forkCount * 2 * 3);
  const forkGeo = new THREE.BufferGeometry();
  forkGeo.setAttribute('position', new THREE.BufferAttribute(forkPositions, 3));
  const forkMat = new THREE.LineBasicMaterial({
    color: 0xbff8ff, transparent: true, opacity: 0, depthWrite: false, fog: false,
  });
  const forks = new THREE.LineSegments(forkGeo, forkMat);
  forks.frustumCulled = false;
  scene.add(forks);
  const flashLight = new THREE.PointLight(0xdff7ff, 0, 520);
  scene.add(flashLight);
  const baseBackground = scene.background.clone();
  const baseFogColor = scene.fog.color.clone();
  const flashBackground = new THREE.Color(0xdaf8ff);
  const flashFogColor = new THREE.Color(0xcff8ff);
  const lightningHitY = (x, z) => {
    if (x > -66 && x < -32 && Math.abs(z) < 17) return 14.15;
    if (x > 34 && x < 64 && Math.abs(z) < 31) return 8.15;
    if (Math.abs(x) < 66 && Math.abs(z) > 31 && Math.abs(z) < 39) return 8.15;
    if (Math.abs(x) < 66 && Math.abs(z) < 33) return 0.15;
    return oceanSurfaceY;
  };
  const strikeLightning = (x, z, characters = []) => {
    const topY = 88;
    const hitY = lightningHitY(x, z);
    const points = [];
    for (let i = 0; i < boltPoints; i++) {
      const p = i / (boltPoints - 1);
      const jag = i === 0 || i === boltPoints - 1 ? 0 : 3.4;
      points.push(new THREE.Vector3(
        x + rand(-jag, jag),
        topY + (hitY - topY) * p,
        z + rand(-jag, jag),
      ));
    }
    const curve = new THREE.CatmullRomCurve3(points, false, 'chordal');
    bolt.geometry.dispose();
    boltGlow.geometry.dispose();
    bolt.geometry = new THREE.TubeGeometry(curve, 48, 0.18, 5, false);
    boltGlow.geometry = new THREE.TubeGeometry(curve, 48, 0.48, 6, false);
    for (let i = 0; i < forkCount; i++) {
      const baseP = rand(0.16, 0.82);
      const baseY = topY + (hitY - topY) * baseP;
      const baseX = x + rand(-2.8, 2.8);
      const baseZ = z + rand(-2.8, 2.8);
      const len = rand(5, 12);
      const j = i * 6;
      forkPositions[j] = baseX;
      forkPositions[j + 1] = baseY;
      forkPositions[j + 2] = baseZ;
      forkPositions[j + 3] = baseX + rand(-len, len);
      forkPositions[j + 4] = baseY - rand(3, 9);
      forkPositions[j + 5] = baseZ + rand(-len, len);
    }
    forkGeo.attributes.position.needsUpdate = true;
    flashLight.position.set(x, Math.max(18, hitY + 20), z);
    world.storm.flashT = 0.72;
    world.onLightningStrike?.({ x, y: hitY, z });
    const hitR = 3.4;
    for (const ch of characters || []) {
      if (!ch?.alive) continue;
      const dx = ch.pos.x - x;
      const dz = ch.pos.z - z;
      if (dx * dx + dz * dz <= hitR * hitR) world.onLightningHit?.(ch, { x, z });
    }
  };

  // Gameplay cycle: 26s calm, 8s siren, 8s surge fill, then an immediate
  // continuous drain (~24s) back to a dry deck, with calm filling the rest.
  const CYCLE = 82;
  const DRAIN_START = 42;
  // ~20% faster empty than the original 24s drain window.
  const DRAIN_END = 61.2;
  let visualTier = 'high';
  let activeRainCount = rainCount;
  let previousPhase = 'calm';
  let activeWaveCycle = -1;
  let waveAngle = 0;
  const waveDirection = V(0, 0, 1);
  const waveTangent = V(-1, 0, 0);
  let waveReach = 76;
  let waveHalfSpan = 76;
  const WAVE_SIDES = [0, Math.PI / 2, Math.PI, -Math.PI / 2]; // +X, +Z, -X, -Z
  let lastWaveSideIndex = -1;
  const randomWaveAngle = () => {
    // True random among the four platform sides; never the same side twice in a row.
    let side = Math.floor(Math.random() * 4);
    if (side === lastWaveSideIndex) {
      side = (side + 1 + Math.floor(Math.random() * 3)) % 4;
    }
    lastWaveSideIndex = side;
    return WAVE_SIDES[side];
  };
  world.tide = {
    phase: 'calm', level: -4.8, warningMix: 0, surgeMix: 0,
    front: -waveReach, directionX: waveDirection.x, directionZ: waveDirection.z,
  };
  world.storm = { mix: 0.78, flashT: 0, nextLightning: rand(3, 9) };
  world.anim.push((dt, t, characters = []) => {
    oceanMat.uniforms.uTime.value = t;
    floodMat.uniforms.uTime.value = t;
    breakerMaterial.uniforms.uTime.value = t;
    const cycleTime = t % CYCLE;
    const cycleId = Math.floor(t / CYCLE);
    if (cycleId !== activeWaveCycle) {
      waveAngle = randomWaveAngle();
      activeWaveCycle = cycleId;
      waveDirection.set(Math.cos(waveAngle), 0, Math.sin(waveAngle));
      waveTangent.set(-waveDirection.z, 0, waveDirection.x);
      // Project the arena bounds onto the travel and cross-wave axes. This
      // keeps diagonal breakers long enough to cross every playable corner.
      waveReach = Math.abs(waveDirection.x) * 68 + Math.abs(waveDirection.z) * 39 + 8;
      waveHalfSpan = Math.abs(waveTangent.x) * 68 + Math.abs(waveTangent.z) * 39 + 8;
    }
    let phase = 'calm';
    let level = -4.8;
    let warningMix = 0;
    let surgeMix = 0;
    let waveFront = -waveReach;
    if (cycleTime >= 26 && cycleTime < 34) {
      phase = 'warning';
      warningMix = THREE.MathUtils.smoothstep(cycleTime, 26, 27.5);
    } else if (cycleTime >= 34 && cycleTime < DRAIN_START) {
      phase = 'surge';
      warningMix = 1;
      surgeMix = Math.sin((cycleTime - 34) / 8 * Math.PI);
      const p = (cycleTime - 34) / 8;
      waveFront = THREE.MathUtils.lerp(-waveReach, waveReach, p * p * (3 - 2 * p));
      // Flood surface comes up with the breaker — water is already high behind
      // the crest; the shader/AABB clip reveals it as the front advances.
      const deckHalfAlong = Math.abs(waveDirection.x) * DECK_HALF_X
        + Math.abs(waveDirection.z) * DECK_HALF_Z;
      const boarded = THREE.MathUtils.smoothstep(waveFront, -deckHalfAlong - 6, -deckHalfAlong + 10);
      level = THREE.MathUtils.lerp(0.55, FLOOD_PEAK, Math.max(
        boarded,
        THREE.MathUtils.smoothstep(cycleTime, 34.2, 36.8),
      ));
    } else if (cycleTime >= DRAIN_START && cycleTime < DRAIN_END) {
      phase = 'draining';
      // Linear continuous empty — no held high-tide slab that then pops away.
      const drainT = (cycleTime - DRAIN_START) / (DRAIN_END - DRAIN_START);
      level = THREE.MathUtils.lerp(FLOOD_PEAK, FLOOD_EMPTY, drainT);
      warningMix = 0.22 * (1 - drainT);
    }
    if (phase === 'warning' && previousPhase !== 'warning') world.onTideWarning?.();
    previousPhase = phase;
    Object.assign(world.tide, {
      phase, level, warningMix, surgeMix, front: waveFront,
      directionX: waveDirection.x, directionZ: waveDirection.z,
    });
    floodZone.surfaceY = level;
    floodMesh.position.y = level;
    const clippingFlood = phase === 'surge';
    floodMat.uniforms.uClip.value = clippingFlood ? 1 : 0;
    floodMat.uniforms.uFront.value = waveFront;
    floodMat.uniforms.uDirX.value = waveDirection.x;
    floodMat.uniforms.uDirZ.value = waveDirection.z;
    syncFloodZoneBounds(clippingFlood, waveFront, waveDirection.x, waveDirection.z);
    // Fade out as the pool empties so the last centimeters dissolve instead of
    // snapping off as a still-thick water block.
    const floodCover = THREE.MathUtils.smoothstep(level, FLOOD_EMPTY, 0.28);
    floodMesh.visible = floodCover > 0.01;
    floodMat.uniforms.uOpacity.value = THREE.MathUtils.lerp(0.18, 0.76, THREE.MathUtils.smoothstep(level, 0.08, FLOOD_PEAK)) * floodCover;
    // Spill sheets hang from the live surface to the sea so the pool reads as
    // water leaving over the lip, strongest while the drain counter is running.
    const drainT = phase === 'draining'
      ? (cycleTime - DRAIN_START) / (DRAIN_END - DRAIN_START)
      : 0;
    // During surge, wait until the front has wet a lip before spilling — otherwise
    // sheets pour off dry edges ahead of the water.
    const deckHalfAlongSpill = Math.abs(waveDirection.x) * DECK_HALF_X
      + Math.abs(waveDirection.z) * DECK_HALF_Z;
    const spillUnlocked = phase !== 'surge'
      || waveFront > -deckHalfAlongSpill * 0.15;
    const spillLive = floodCover * THREE.MathUtils.smoothstep(level, 0.12, 0.55)
      * (spillUnlocked ? 1 : 0);
    const spillBoost = phase === 'draining' ? 0.55 * (1 - drainT * 0.35)
      : phase === 'surge' ? 0.22 * THREE.MathUtils.smoothstep(level, 0.4, FLOOD_PEAK)
      : 0;
    const spillHeight = Math.max(0.05, level - spillBottomY);
    const spillMidY = (level + spillBottomY) * 0.5;
    spillMat.uniforms.uTime.value = t;
    spillMat.uniforms.uOpacity.value = Math.min(0.88, (0.4 + spillBoost) * spillLive);
    for (const mesh of spillMeshes) {
      mesh.visible = spillLive > 0.02;
      mesh.position.y = spillMidY;
      mesh.scale.y = spillHeight;
    }

    // The breaker removes the slick only when its advancing front actually
    // reaches the merged slick. It stays gone through drainage, then the two
    // running pipe mouths push fresh oil inward during calm.
    const oilProgress = oilCenter.x * waveDirection.x + oilCenter.z * waveDirection.z;
    if (phase === 'surge' && waveFront >= oilProgress - 2.2) oilWashedCycle = cycleId;
    const keepingOilClear = oilWashedCycle === cycleId && cycleTime < DRAIN_END;
    if (keepingOilClear || level > 0.18) oilFill = Math.max(0, oilFill - dt * 2.5);
    else oilFill = Math.min(1, oilFill + dt / 16);
    const oilVisibility = THREE.MathUtils.smoothstep(oilFill, 0.025, 0.24);
    oilPuddleMaterial.uniforms.uTime.value = t;
    oilPuddleMaterial.uniforms.uFill.value = oilFill;
    oilPuddleMaterial.uniforms.uOpacity.value = 0.86 * oilVisibility * (1 - THREE.MathUtils.smoothstep(level, 0.15, 1.05) * 0.5);
    oilPuddle.visible = oilVisibility > 0.01;
    oilStreamMaterial.uniforms.uTime.value = t;
    const leakVisibility = 1 - THREE.MathUtils.smoothstep(level, 0.05, 0.92);
    oilStreamMaterial.uniforms.uOpacity.value = leakVisibility;
    for (const stream of oilStreams) stream.visible = leakVisibility > 0.015;

    const pulse = warningMix * (0.5 + 0.5 * Math.sin(t * 9.2));
    for (let i = 0; i < beaconLenses.length; i++) {
      beaconLenses[i].material.color.setRGB(0.18 + pulse * 1.8, 0.025 + pulse * 0.11, 0.012);
      beaconLights[i].intensity = pulse * 34;
      beaconCones[i].cone.material.opacity = pulse * 0.045;
      beaconCones[i].pivot.rotation.y = t * 2.6 + i * Math.PI * 0.5;
    }

    if (phase === 'surge') {
      breaker.visible = true;
      breakerMaterial.uniforms.uOpacity.value = 0.9 * Math.min(1, surgeMix * 2.4);
      for (let row = 0; row <= breakerRows; row++) {
        const v = row / breakerRows;
        const curl = THREE.MathUtils.smoothstep(v, 0.68, 1) * Math.sin(THREE.MathUtils.clamp((v - 0.68) / 0.32, 0, 1) * Math.PI) * 3.8;
        for (let col = 0; col <= breakerCols; col++) {
          const u = col / breakerCols;
          const across = THREE.MathUtils.lerp(-waveHalfSpan, waveHalfSpan, u);
          const chop = Math.sin(across * 0.12 + t * 2.4 + v * 6.0) * (0.18 + v * 0.38);
          const along = waveFront - Math.pow(v, 1.55) * 3.2 + curl + chop;
          const x = waveDirection.x * along + waveTangent.x * across;
          const z = waveDirection.z * along + waveTangent.z * across;
          const crestVariation = Math.sin(across * 0.09 + t * 2.1) * (0.16 + v * 0.58)
            + Math.sin(across * 0.23 - t * 1.7) * v * 0.24;
          // Bottom sits on the deck (y≈0), not on the rising flood sheet — tying
          // the curl to `level` made the face hover above the platform.
          const y = -0.12 + v * 5.7 - THREE.MathUtils.smoothstep(v, 0.84, 1) * 0.95 + crestVariation;
          breakerPositions.setXYZ(row * (breakerCols + 1) + col, x, y, z);
        }
      }
      breakerPositions.needsUpdate = true;
      // ~30% of surges wash a shark onto the deck with the breaker.
      if (sharkWashCycle !== cycleId) {
        sharkWashCycle = cycleId;
        if (Math.random() < 0.3) startSharkRide(cycleId, waveHalfSpan);
      }
      for (const state of sharkStates) {
        if (!state.riding) continue;
        const along = waveFront - 1.6;
        const x = waveDirection.x * along + waveTangent.x * state.rideAcross;
        const z = waveDirection.z * along + waveTangent.z * state.rideAcross;
        // Sit in the mid-curl of the modeled breaker so it reads inside the wave.
        const y = 2.55 + Math.sin(t * 7.2 + state.rideAcross) * 0.45;
        state.group.position.set(x, y, z);
        state.group.rotation.y = Math.atan2(-waveDirection.z, waveDirection.x);
        state.group.rotation.z = 0.55 + Math.sin(t * 9.0) * 0.3;
        state.group.rotation.x = -0.4 + Math.sin(t * 5.5) * 0.15;
        const onDeck = Math.abs(x) < 56 && Math.abs(z) < 28;
        if (onDeck) {
          state.rideDeckT = (state.rideDeckT || 0) + dt;
          state.rideLastOnDeckX = x;
          state.rideLastOnDeckZ = z;
        }
        // Progress 0 = boarding lip, 1 = far lip. Drop at a per-surge threshold
        // that is always before 75% across so the crest leaves him behind.
        const deckHalfAlong = Math.abs(waveDirection.x) * 56 + Math.abs(waveDirection.z) * 28;
        const alongPos = x * waveDirection.x + z * waveDirection.z;
        const progress = deckHalfAlong > 0.1
          ? (alongPos + deckHalfAlong) / (deckHalfAlong * 2)
          : 0;
        const dropAt = Math.min(state.rideDropAt ?? 0.55, 0.74);
        if (onDeck && progress >= dropAt) {
          dropSharkOnDeck(state, x, z, waveDirection.x, waveDirection.z);
        } else if (!onDeck && state.rideDeckT > 0.1 && progress > 0.05) {
          // Crest carried him off a side lane — plant at last on-deck sample.
          dropSharkOnDeck(
            state, state.rideLastOnDeckX, state.rideLastOnDeckZ,
            waveDirection.x, waveDirection.z,
          );
        }
      }
      for (const ch of characters) {
        if (!ch?.alive || ch.pos.y > 4.6 || Math.abs(ch.pos.x) > 65 || Math.abs(ch.pos.z) > 35) continue;
        const characterProgress = ch.pos.x * waveDirection.x + ch.pos.z * waveDirection.z;
        if (ch._tidebreakerWaveCycle === cycleId || waveFront < characterProgress - 0.8) continue;
        ch._tidebreakerWaveCycle = cycleId;
        // Carry timer: a one-frame shove dies to grounded friction/speed clamp
        // before the next pose reads, so the breaker owns movement for a beat.
        ch._tidebreakerWavePush = 2.4;
        const currentForwardSpeed = ch.vel.x * waveDirection.x + ch.vel.z * waveDirection.z;
        const impulse = Math.max(0, 13.5 - currentForwardSpeed);
        ch.vel.x += waveDirection.x * impulse;
        ch.vel.z += waveDirection.z * impulse;
        ch.vel.y = Math.max(ch.vel.y, 6.6);
        ch.grounded = false;
        world.onSurgeHit?.(ch);
      }
    } else {
      breakerMaterial.uniforms.uOpacity.value = 0;
      breaker.visible = false;
      for (const state of sharkStates) {
        if (!state.riding) continue;
        const p = state.group.position;
        if (Math.abs(p.x) < 60 && Math.abs(p.z) < 32) {
          dropSharkOnDeck(state, p.x, p.z, waveDirection.x, waveDirection.z);
        } else {
          state.riding = false;
          p.y = oceanSurfaceY - 2.2;
          state.group.rotation.x = 0;
          state.group.rotation.z = 0;
          state.orbitAngle = Math.atan2(p.z, p.x);
        }
      }
    }

    // Decaying wash after impact. Stay lofted while the shove is strong so the
    // walk-speed cap cannot cancel it, then ease into the flooded current.
    const WAVE_PUSH_DUR = 2.4;
    for (const ch of characters) {
      const pushT = ch._tidebreakerWavePush || 0;
      if (!ch?.alive || pushT <= 0) continue;
      ch._tidebreakerWavePush = Math.max(0, pushT - dt);
      if (ch.pos.y > 6.5 || Math.abs(ch.pos.x) > 70 || Math.abs(ch.pos.z) > 40) {
        ch._tidebreakerWavePush = 0;
        continue;
      }
      const fade = pushT / WAVE_PUSH_DUR;
      const targetSpeed = 6 + 14 * fade;
      const forward = ch.vel.x * waveDirection.x + ch.vel.z * waveDirection.z;
      if (forward < targetSpeed) {
        const add = targetSpeed - forward;
        ch.vel.x += waveDirection.x * add;
        ch.vel.z += waveDirection.z * add;
      }
      if (fade > 0.25) {
        ch.vel.y = Math.max(ch.vel.y, 1.2 + 4.2 * fade);
        ch.grounded = false;
      }
    }

    // A broad post-break current makes the flooded deck tactically different
    // without stun-locking anyone. Elevated routes are completely unaffected.
    if (level > 0.2) for (const ch of characters) {
      if (!ch?.alive || ch.pos.y > 2.2 || Math.abs(ch.pos.x) > 62 || Math.abs(ch.pos.z) > 33) continue;
      // Skip the gentle current while the breaker carry is still owning them.
      if ((ch._tidebreakerWavePush || 0) > 0.2) continue;
      const currentStrength = (phase === 'surge' ? 4.8 : 1.4) * dt;
      ch.vel.x += waveDirection.x * currentStrength;
      ch.vel.z += waveDirection.z * currentStrength;
    }

    const sprayOpacity = phase === 'surge' ? Math.min(1, surgeMix * 2.6) : 0;
    sprayMaterial.uniforms.uOpacity.value = 0.82 * sprayOpacity;
    const liveSpray = visualTier === 'high' ? 260 : visualTier === 'standard' ? 150 : 70;
    sprayGeo.setDrawRange(0, liveSpray);
    for (let i = 0; i < liveSpray; i++) {
      sprayLife[i] -= dt;
      const j = i * 3;
      if (sprayLife[i] <= 0 && phase === 'surge') {
        const across = rand(-waveHalfSpan, waveHalfSpan);
        const along = waveFront + rand(-1.8, 2.2);
        sprayPositions[j] = waveDirection.x * along + waveTangent.x * across;
        sprayPositions[j + 1] = level + rand(3.5, 6.3);
        sprayPositions[j + 2] = waveDirection.z * along + waveTangent.z * across;
        const lateralVelocity = rand(-0.9, 0.9);
        const forwardVelocity = rand(0.8, 4.2);
        sprayVelocity[i].set(
          waveTangent.x * lateralVelocity + waveDirection.x * forwardVelocity,
          rand(2.2, 6.2),
          waveTangent.z * lateralVelocity + waveDirection.z * forwardVelocity,
        );
        sprayLife[i] = rand(0.35, 1.05);
      } else if (sprayLife[i] > 0) {
        sprayPositions[j] += sprayVelocity[i].x * dt;
        sprayPositions[j + 1] += sprayVelocity[i].y * dt;
        sprayPositions[j + 2] += sprayVelocity[i].z * dt;
        sprayVelocity[i].y -= 10.5 * dt;
      }
    }
    sprayGeo.attributes.position.needsUpdate = true;

    const viewer = characters.find(ch => ch?.isPlayer && ch.alive) || characters.find(ch => ch?.alive);
    if (viewer) {
      rainOrigin.x = viewer.pos.x;
      rainOrigin.z = viewer.pos.z;
      rainGeo.boundingSphere.center.set(rainOrigin.x, viewer.pos.y + 18, rainOrigin.z);
    }
    const rainFall = 51 * dt;
    const wrapX = rainHalfX * 2;
    const wrapZ = rainHalfZ * 2;
    for (let i = 0; i < activeRainCount; i++) {
      const j = i * 6;
      for (const end of [0, 3]) {
        rainPositions[j + end] -= 0.22 * rainFall;
        rainPositions[j + end + 1] -= rainFall;
        rainPositions[j + end + 2] += 0.1 * rainFall;
      }
      // Toroidal wrap keeps the storm volume glued to the viewer without a
      // visible pop when they strafe, turn toward open water, or respawn.
      let dx = rainPositions[j] - rainOrigin.x;
      while (dx > rainHalfX) {
        rainPositions[j] -= wrapX; rainPositions[j + 3] -= wrapX; dx -= wrapX;
      }
      while (dx < -rainHalfX) {
        rainPositions[j] += wrapX; rainPositions[j + 3] += wrapX; dx += wrapX;
      }
      let dz = rainPositions[j + 2] - rainOrigin.z;
      while (dz > rainHalfZ) {
        rainPositions[j + 2] -= wrapZ; rainPositions[j + 5] -= wrapZ; dz -= wrapZ;
      }
      while (dz < -rainHalfZ) {
        rainPositions[j + 2] += wrapZ; rainPositions[j + 5] += wrapZ; dz += wrapZ;
      }
      if (rainPositions[j + 4] < -9) resetRain(i, rand(36, 58));
    }
    rainGeo.attributes.position.needsUpdate = true;

    world.storm.flashT = Math.max(0, world.storm.flashT - dt);
    const flash = Math.min(1, world.storm.flashT / 0.42);
    boltMat.opacity = flash;
    boltGlowMat.opacity = flash * 0.34;
    forkMat.opacity = flash * 0.72;
    flashLight.intensity = flash * 420;
    stormLight.intensity = 2.25 + flash * 7.5;
    if (scene.background?.isColor) {
      scene.background.copy(baseBackground).lerp(flashBackground, 0.3 * flash);
    }
    scene.fog.color.copy(baseFogColor).lerp(flashFogColor, 0.36 * flash);
    world.storm.nextLightning -= dt;
    if (world.storm.nextLightning <= 0) {
      const [strikeX, strikeZ] = randomLightningCoord();
      strikeLightning(strikeX, strikeZ, characters);
      world.storm.nextLightning = rand(7, 15);
    }

    for (let i = 0; i < lifeboats.length; i++) {
      lifeboats[i].rotation.z = Math.sin(t * 0.72 + i * 2.2) * 0.018;
    }
    trolley.position.x = craneX + 21 + Math.sin(t * 0.11) * 5.5;
    trolley.rotation.z = Math.sin(t * 0.63) * 0.012;
  });

  // Public-map weapon distribution. The riskiest rewards stay on the flooded
  // low deck; long-range power sits on exposed high routes.
  pk(world, 'weapon', -48, 14.2, 0, { weapon: 'hyper' });
  pk(world, 'weapon', -20, 0.2, -20, { weapon: 'scatter' });
  pk(world, 'weapon', -8, 0.2, 20, { weapon: 'pulsar' });
  pk(world, 'weapon', 18, 0.2, -20, { weapon: 'sidewinder' });
  pk(world, 'weapon', 47, 0.2, 0, { weapon: 'zooka' });
  pk(world, 'weapon', 10, 8.2, -35, { weapon: 'parasite' });
  pk(world, 'weapon', 56, 8.2, 12, { weapon: 'whomper' });
  pk(world, 'ammo', -42, 14.2, 0, { weapon: 'hyper' });
  pk(world, 'ammo', -19, 8.2, 35, { weapon: 'scatter' });
  pk(world, 'ammo', 30, 0.2, 18, { weapon: 'sidewinder' });
  pk(world, 'ammo', 38, 8.2, -22, { weapon: 'parasite' });
  pk(world, 'health', -46, 8.2, -35);
  pk(world, 'health', 5, 0.2, 13);
  pk(world, 'health', 51, 0.2, -18);
  pk(world, 'shield', 0, 8.2, 35);
  pk(world, 'speed', 0, 8.2, -35);
  pk(world, 'silver', 29, 8.2, 35);
  pk(world, 'gold', -60, 14.2, -8);
  pk(world, 'star', -60, 14.2, 10, { hidden: true });
  pk(world, 'star', 60, 0.2, -21, { hidden: true });
  pk(world, 'star', 7, 0.2, 6, { hidden: true });

  const ffaSpawns = [
    [-50, 14.2, -8], [-50, 14.2, 8], [-35, 8.2, -34], [-12, 8.2, 34],
    [18, 8.2, -34], [38, 8.2, 34], [49, 8.2, -18], [49, 8.2, 18],
  ];
  for (const [x, y, z] of ffaSpawns) world.spawns.ffa.push(V(x, y, z));
  for (const p of [[-54, 14.2, -8], [-54, 14.2, 8], [-35, 8.2, -34], [-35, 8.2, 34]]) world.spawns.blue.push(V(...p));
  for (const p of [[50, 8.2, -18], [50, 8.2, 18], [35, 8.2, -34], [35, 8.2, 34]]) world.spawns.red.push(V(...p));

  const waypoints = [
    // low processing deck and open container lanes
    [-54, 0, -22], [-54, 0, 0], [-54, 0, 22], [-38, 0, -18], [-38, 0, 0], [-38, 0, 18],
    [-22, 0, -24], [-22, 0, 0], [-22, 0, 24], [-8, 0, -14], [-13, 0, 20],
    [8, 0, -18], [8, 0, 18], [24, 0, -22], [24, 0, 0], [24, 0, 22],
    [40, 0, -22], [40, 0, 0], [40, 0, 18], [55, 0, -22], [55, 0, 0], [55, 0, 18],
    // surge winch platform: west ramp, two paths around the drum, south ramp
    [-20, 0, -5], [-18, 2, -5], [-15, 4, -5], [-13, 4, 0], [-4, 4, 0],
    [-15, 4, -9], [-11, 4, -9], [-3, 4, -8], [-1, 4, 2], [-1, 2, 7], [-1, 0, 12],
    [-3.5, 0, -12.5], [-3.5, 2, -10.7], [-3.5, 4, -9.2],
    // north access ramp and deck
    [0, 2.7, -22], [0, 5.3, -26], [0, 8, -30.35], [-20, 8, -35], [-40, 8, -35], [-58, 8, -35],
    [20, 8, -35], [40, 8, -35], [58, 8, -35],
    // south access ramp and deck
    [0, 2.7, 22], [0, 5.3, 26], [0, 8, 30.35], [-20, 8, 35], [-40, 8, 35], [-58, 8, 35],
    [20, 8, 35], [40, 8, 35], [58, 8, 35],
    // helipad ramps and deck
    [-53, 10, -26], [-53, 12, -21], [-53, 14, -15], [-49, 14, 0], [-58, 14, 10], [-40, 14, 10],
    [-53, 10, 26], [-53, 12, 21], [-53, 14, 15],
    // operations roof
    [38, 8, -20], [50, 8, -18], [40, 8, 0], [50, 8, 18], [38, 8, 20],
  ];
  for (const [x, y, z] of waypoints) wp(world, x, y, z);
  world.manualLinks.push(
    [0, 0, -18, 0, 2.7, -22, false],
    [0, 5.3, -26, 0, 8, -30.35, false],
    [0, 0, 18, 0, 2.7, 22, false],
    [0, 5.3, 26, 0, 8, 30.35, false],
    [-20, 0, -5, -18, 2, -5, false],
    [-18, 2, -5, -15, 4, -5, false],
    [-15, 4, -5, -13, 4, 0, false],
    [-15, 4, -5, -15, 4, -9, false],
    [-15, 4, -9, -11, 4, -9, false],
    [-11, 4, -9, -3, 4, -8, false],
    [-13, 4, 0, -4, 4, 0, false],
    [-3, 4, -8, -4, 4, 0, false],
    [-4, 4, 0, -1, 4, 2, false],
    [-1, 4, 2, -1, 2, 7, false],
    [-1, 2, 7, -1, 0, 12, false],
    [-3.5, 0, -12.5, -3.5, 2, -10.7, false],
    [-3.5, 2, -10.7, -3.5, 4, -9.2, false],
    [-3.5, 4, -9.2, -3, 4, -8, false],
    [-58, 8, -35, -53, 10, -26, false],
    [-53, 12, -21, -53, 14, -15, false],
    [-58, 8, 35, -53, 10, 26, false],
    [-53, 12, 21, -53, 14, 15, false],
    [40, 8, -35, 38, 8, -20, false],
    [40, 8, 35, 38, 8, 20, false],
  );

  world.podiumSpot = V(-49, 14.2, 0);
  world.setVisualQuality = tier => {
    visualTier = tier;
    oceanMeshes[0].visible = tier === 'low';
    oceanMeshes[1].visible = tier === 'standard';
    oceanMeshes[2].visible = tier === 'high';
    standard.visible = tier !== 'low';
    high.visible = tier === 'high';
    activeRainCount = tier === 'high' ? 980 : tier === 'standard' ? 620 : 300;
    rainGeo.setDrawRange(0, activeRainCount * 2);
  };
  world.setVisualQuality('high');
  mergeStatic(scene, world);
  return world;
}

function buildMeteorSurfaceIndex(world, cellSize = 16) {
  const cells = new Map();
  const add = (kind, item, minX, maxX, minZ, maxZ) => {
    const startX = Math.floor(minX / cellSize);
    const endX = Math.floor(maxX / cellSize);
    const startZ = Math.floor(minZ / cellSize);
    const endZ = Math.floor(maxZ / cellSize);
    for (let ix = startX; ix <= endX; ix++) for (let iz = startZ; iz <= endZ; iz++) {
      const key = `${ix},${iz}`;
      let cell = cells.get(key);
      if (!cell) cells.set(key, cell = { colliders: [], ramps: [] });
      cell[kind].push(item);
    }
  };
  for (const collider of world.colliders) {
    if (collider.type === 'box') {
      add('colliders', collider, collider.min.x, collider.max.x, collider.min.z, collider.max.z);
    } else if (collider.type === 'sphere') {
      add('colliders', collider,
        collider.center.x - collider.radius, collider.center.x + collider.radius,
        collider.center.z - collider.radius, collider.center.z + collider.radius);
    } else if (collider.type === 'triangleMesh') {
      add('colliders', collider,
        collider.min.x, collider.max.x, collider.min.z, collider.max.z);
    }
  }
  for (const ramp of world.ramps) {
    add('ramps', ramp, ramp.minX, ramp.maxX, ramp.minZ, ramp.maxZ);
  }
  world.meteorSurfaceIndex = { cellSize, cells };
}

/* ============== SECRET MAP — OLYMPUS MONS (340×340, 103m tall) =============
   A Palutena-style cliff temple: recovery basin, floating return routes,
   waterfall undercroft, indoor armories, open court, and connected roof city. */
function buildOlympusMons(scene) {
  const world = newWorld({
    killY: -34,
    matchTime: 10 * 60,
    playerSpeed: 11.2,
    playerCount: 16,
    waypointLinkDist: 38,
    waypointLinkDy: 24,
    availableWeapons: ['blaster', 'scatter', 'pulsar', 'sidewinder', 'zooka', 'hyper', 'parasite', 'whomper', 'thunderbolt'],
    meteorShower: {
      minInterval: 20, maxInterval: 40,
      mesaChance: 0.8, mesaHalfExtent: 88, mapHalfExtent: 170,
      // 30% longer than the original 2.55–3.05s fall, beginning higher in sky.
      durationMin: 3.32, durationMax: 3.97,
      startHeightMin: 150, startHeightMax: 174,
      // A sideward approach lets meteors pass beneath the palace terraces.
      startElevationMin: 60, startElevationMax: 78,
      fadeIn: 1,
    },
  });
  world.toneMappingExposure = 1.25;
  // Olympus's unusually dense PBR scene gets a cheaper Medium path; High
  // keeps the full shadow pass, while Low already disables shadows globally.
  world.mediumShadows = false;
  scene.background = new THREE.Color(0x7d3b2d);
  scene.fog = new THREE.Fog(0xa45b3c, 250, 660);
  baseLighting(scene, 0xffb879, 0x351a24, [-120, 175, 80], 220);
  addMarsSkyDome(scene);

  // Flat recovery basin. Falling from the temple is survivable, but the sparse
  // outer loot and obvious return shrines push play immediately back upward.
  addBox(scene, world, 0, -1, 0, 340, 2, 340, 0x7f3828, {
    tex: 'dirt', repeat: [48, 48],
  });
  for (const [x, z, w, d, c] of [
    [-137.5, -92, 15, 104, 0x984932], [137.5, 78, 15, 116, 0x6f3027],
    [-90, 137.5, 112, 15, 0xa75635], [92, -137.5, 118, 15, 0x743126],
  ]) addBox(scene, world, x, 0.32, z, w, 0.65, d, c, { collide: false, tex: 'dirt' });
  addOlympusLavaMoat(scene, world, 170, 151, -0.72, { pointLights: false });

  addOlympusMountain(scene, world);

  // Crimson Martian creepers mark climbable recovery lines on the exterior
  // cliffs. They sit on the visible wall faces and spill all the way down to
  // the basin, creating quieter alternatives to the jump-pad shrines.
  for (const [x, z, exitX, exitZ] of [
    [-88.35, -38, 1, 0], [88.35, 34, -1, 0],
    [-30, 88.35, 0, -1], [34, -88.35, 0, 1],
  ]) addVine(scene, world, x, z, 0.15, 60.45, 1.18, exitX * 0.16, exitZ * 0.16,
    exitX, exitZ, 0.22, 1.75, 0xc83a3f);

  // Monumental buttresses break the huge cliff into readable vertical bays.
  // They use the same visible boxes as their collision, so the added density
  // does not reintroduce the old cliff/physics mismatch.
  for (const z of [-56, 0, 56]) {
    addBox(scene, world, -90, 21, z, 4, 42, 10, 0x6d332b, { tex: 'olympus-rock', repeat: [2, 8] });
    addBox(scene, world, 90, 21, z, 4, 42, 10, 0x6d332b, { tex: 'olympus-rock', repeat: [2, 8] });
  }
  for (const x of [-48, 0, 48]) {
    addBox(scene, world, x, 18, 90, 10, 36, 4, 0x75402f, { tex: 'olympus-rock', repeat: [3, 7] });
  }
  for (const x of [-50, -24, 24, 50]) {
    addBox(scene, world, x, 22, -90, 9, 44, 4, 0x63302a, { tex: 'olympus-rock', repeat: [3, 8] });
  }
  addOlympusBanner(scene, -88.02, 34, -28, Math.PI / 2, 0xb8392f);
  addOlympusBanner(scene, -88.02, 34, 28, Math.PI / 2, 0xd8912d);
  addOlympusBanner(scene, 88.02, 34, -28, Math.PI / 2, 0x3a74b8);
  addOlympusBanner(scene, 88.02, 34, 28, Math.PI / 2, 0x6f4bb8);

  // Broken pilgrimage markers and half-buried ruins give the recovery basin
  // landmarks without turning its broad movement lanes into another maze.
  for (const [x, z, h, w] of [
    [-151, 20, 7, 3.2], [-142, 18, 3.8, 5], [-136, -36, 9, 2.8],
    [151, 25, 6, 3.2], [142, 48, 4.5, 5], [136, -52, 8, 2.8],
    [-58, 138, 7.5, 3], [-43, 146, 4, 6], [52, 141, 9, 3],
    [-48, -145, 6, 3.4], [45, -148, 8, 3.2], [72, -138, 3.5, 6],
  ]) addBox(scene, world, x, h / 2, z, w, h, w, 0x9a6845, {
    tex: 'olympus-palace', repeat: [1, Math.max(1, h / 2)],
  });

  // Basin cover and cliff-edge outcrops. Every visible crag has inset collision.
  const crags = [
    [-137, -105, 12], [-126, 118, 10], [148, 132, 11], [132, -124, 11],
    [-112, -70, 9], [-108, 68, 11], [110, 72, 10], [112, -74, 8],
    [-84, -48, 8], [-84, 48, 7], [84, 46, 8], [84, -46, 7],
  ];
  crags.forEach(([x, z, r], i) => addOlympusCrag(scene, world, x, olympusSurfaceY(x, z) + r * 0.28, z, r, i % 2 ? 0x6e3028 : 0x8b402d, i + 1));

  for (const [x, z] of [[-146, 38], [145, -34], [-116, -14], [116, 14]]) {
    addBox(scene, world, x, 3, z, 2.1, 6, 2.1, 0x9d7040, { tex: 'panel' });
    addBox(scene, world, x, 6.4, z, 3.6, 0.8, 3.6, 0xff8a32, {
      collide: false, shadow: false, emissive: 0xff4a1f, emissiveIntensity: 1.25,
    });
  }

  // Three fast return shrines turn the basin into circulation, not a second
  // arena. Each two-pad route lands at a different palace entrance.
  for (const [x, z, seed] of [[-100, 28, 81], [100, 28, 82], [0, 100, 83]]) {
    addOlympusFloatingRock(scene, world, x, 26, z, 18, 18, 6, seed);
  }
  addJumpPad(scene, world, -120, 0.02, 20, 39, 9.28, 3.71, 0xff7a32);
  addJumpPad(scene, world, -96, 26.02, 28, 55, 10, 2.7, 0xffb13a);
  addJumpPad(scene, world, 120, 0.02, 20, 39, -9.28, 3.71, 0xff7a32);
  addJumpPad(scene, world, 96, 26.02, 28, 55, -10, 2.7, 0xffb13a);
  addJumpPad(scene, world, 0, 0.02, 120, 39, 0, -9.28, 0xff7a32);
  // Offset east of the south-arcade trim and descend onto the broad palace
  // foundation instead of clipping the centered roof rail on the way down.
  addJumpPad(scene, world, 0, 26.02, 96, 55, 10, -10, 0xffb13a);
  for (const [x, z, color] of [
    [-127, 9, 0xff7a32], [-127, 33, 0xffb13a],
    [127, 9, 0xff7a32], [127, 33, 0x72d8ff],
    [-11, 129, 0xffb13a], [11, 129, 0x72d8ff],
  ]) addOlympusBrazier(scene, world, x, 0, z, color);

  // Southeast skybridge climbs through four differently sized rocks and now
  // physically meets the palace's upper south arcade instead of ending nearby.
  const skyRocks = [
    [113, 18, 94, 18, 14, 5.2],
    [102, 34, 80, 11, 9, 4.2],
    [100, 50, 65, 20, 16, 6.4],
    [96, 72, 54, 14, 12, 4.8],
  ];
  skyRocks.forEach(([x, y, z, w, d, depth], i) =>
    addOlympusFloatingRock(scene, world, x, y, z, w, d, depth, 71 + i));
  for (const [x, z, y0, y1, exitX, exitZ] of [
    [104.4, 94, 0.15, 18.1, 1, 0],
    [90.7, 65, 34, 50.1, 1, 0],
    [89.5, 54, 50, 72.1, 1, 0],
  ]) addVine(scene, world, x, z, y0, y1, 1.0, exitX * 0.14, exitZ * 0.14,
    exitX, exitZ, 0.2, 1.45, 0xc83a3f);

  addJumpPad(scene, world, 134, 0.02, 104, 34, -7.5, -5, 0xff7a32);
  addJumpPad(scene, world, 109, 18.02, 92, 33, -4.5, -6, 0xffa13a);
  addJumpPad(scene, world, 104, 34.02, 78, 33, -2, -6.5, 0xffc24a);
  addJumpPad(scene, world, 102, 50.02, 63, 37, -2.5, -3.75, 0x72d8ff);

  // --- CLIFF PALACE FOUNDATION: four non-overlapping slabs around a real
  // central lift shaft. Their edges butt exactly; no coplanar floor layers. ---
  for (const [x, z, w, d] of [
    [0, -42, 136, 52], [0, 42, 136, 52],
    [-38, 0, 60, 32], [38, 0, 60, 32],
  ]) addBox(scene, world, x, 60.25, z, w, 0.5, d, 0xe8cfaa, { tex: 'checker' });

  // Low rails guard the two long sides of the 16x32m undercroft shaft. They
  // stop an accidental backward step but remain comfortably below the normal
  // jump apex; both short ends stay open for deliberate drops and lift play.
  for (const side of [-1, 1]) {
    const railX = side * 8.35;
    for (const [y, h] of [[60.96, 0.2], [61.56, 0.24]]) {
      addBox(scene, world, railX, y, 0, 0.34, h, 29, 0xb88748, {
        tex: 'olympus-palace', repeat: [1, 7],
      });
    }
    for (const z of [-14.2, -7.1, 0, 7.1, 14.2]) {
      addBox(scene, world, railX, 61.1, z, 0.64, 1.2, 0.64, 0xc69132, {
        tex: 'olympus-palace', repeat: [1, 1],
      });
    }
  }

  // Two tall watchtowers make the palace read as a city from the basin and
  // frame the north temple without occupying its combat roof.
  addOlympusTower(scene, world, -56, -55, 60.5, 22, 9);
  addOlympusTower(scene, world, 56, -55, 60.5, 22, 9);
  addOlympusBanner(scene, -56, 73, -59.52, 0, 0xb8392f);
  addOlympusBanner(scene, 56, 73, -59.52, 0, 0x3a74b8);

  // Waterfall cave tunnel opens directly into the full under-palace cavern.
  // The old 56x36 rectangular Hades room made the real 136x136 void feel like
  // unused backstage space, so only a rough volcanic cave mouth remains.
  const fallZ = -83;
  addBox(scene, world, -7.4, 5, -69.5, 1.2, 10, 31, 0x4a292b, { tex: 'olympus-rock' });
  addBox(scene, world, 7.4, 5, -69.5, 1.2, 10, 31, 0x4a292b, { tex: 'olympus-rock' });
  // Keep the walkable top at y=10.4, but make the roof deep enough that a
  // player falling from the summit cannot tunnel through a paper-thin slab.
  // The forward cap meets it at z=-85 and covers the visible craggy cave lip.
  addBox(scene, world, 0, 9.4, -69.5, 16, 2, 31, 0x3c2429, { tex: 'olympus-rock' });
  addBox(scene, world, 0, 9.4, -86.5, 18, 2, 3, 0x3c2429, { tex: 'olympus-rock' });
  // The north mountain is built from two cliff boxes with a 16m centre gap.
  // Below y=10.4 that gap is the waterfall doorway; above it the old gap ran
  // all the way to the palace and exposed purple sky/patterned undersides when
  // the player looked up from the river. This rock tympanum closes only that
  // upper void, overlapping the cliff shoulders by 10cm while preserving the
  // exact 16x10.4m entrance and its existing tunnel floor/roof collision.
  addBox(scene, world, 0, 35.2, -87.35, 16.2, 49.6, 1.3, 0x4a2926, {
    shadow: false, tex: 'olympus-rock', repeat: [4, 10], roughness: 1,
    emissive: 0x2d0c09, emissiveIntensity: 0.34,
    debugName: 'olympus-cavern-waterfall-tympanum',
  });
  // A controlled rock crown grows out of the tunnel roof, while two landmark
  // ground crags frame its cavern-side mouth like a passage cut through the
  // mountain. Their visible inner edges stop just outside +/-8m and their
  // small inscribed colliders stop farther out, so neither the waterfall nor
  // the nearby speed pickup and west launch-pad approach are obstructed.
  addOlympusCrag(scene, world, -15.0, 3.14, -54.8, 8.0, 0x71383b, 781);
  addOlympusCrag(scene, world, 14.7, 3.0, -54.4, 7.6, 0x7b3b34, 782);
  // These upper stones are embedded in the already-solid tunnel roof; that
  // roof owns collision, avoiding duplicate spheres hanging over the doorway.
  for (const [x, y, z, radius, seed] of [
    [-6.0, 12.1, -54.9, 3.1, 783],
    [0.2, 12.8, -55.2, 3.8, 784],
    [6.2, 12.0, -54.6, 3.0, 785],
  ]) addOlympusCrag(scene, world, x, y, z, radius, 0x6f342f, seed, { collide: false });

  // Fitted corners, an aspect-correct ceiling skin, and rough wall accents
  // soften the rectangular foundation without replacing it with a vault.
  addOlympusCavernShell(scene, world);

  // Large, overlapping crag clusters restore the strongest part of the earlier
  // cavern pass: natural piles along the perimeter. Grounded stones may grow
  // through the authoritative side walls, deliberately making the exterior
  // palace foundation read as a mountain; their low profiles remain far below
  // the palace ceiling and they never enter the central combat routes.
  const cavernEdgeCrags = [
    // West wall: two deliberately uneven three-stone piles.
    [-64.0, -36.5, 9.6, 801], [-59.7, -30.0, 7.4, 802], [-63.0, -24.0, 5.8, 803],
    [-64.0, 17.0, 9.9, 804], [-59.6, 24.0, 7.2, 805], [-63.2, 30.0, 5.9, 806],
    // East wall.
    [64.0, -34.0, 9.2, 807], [59.8, -27.8, 7.0, 808], [63.2, -22.0, 5.7, 809],
    [64.0, 42.0, 9.7, 810], [66.0, 48.5, 7.3, 811], [63.0, 55.0, 5.8, 812],
    // North wall, well clear of the central waterfall/cave-mouth route.
    [-44.0, -64.0, 9.4, 813], [-37.0, -59.8, 7.1, 814], [-30.8, -63.2, 5.7, 815],
    [32.0, -64.0, 9.0, 816], [39.0, -59.8, 6.9, 817], [45.0, -63.2, 5.6, 818],
    // South wall, split around the Greco-Deco gate.
    [-45.0, 64.0, 9.8, 819], [-38.0, 59.7, 7.2, 820], [-31.5, 63.2, 5.7, 821],
    [34.0, 64.0, 9.3, 822], [41.0, 59.7, 7.0, 823], [47.0, 63.1, 5.8, 824],
  ];
  cavernEdgeCrags.forEach(([x, z, radius, seed], index) => addOlympusCrag(
    scene, world, x, 0.10 + radius * 0.38, z, radius,
    index % 3 === 0 ? 0x7b3b34 : 0x63302d, seed,
  ));

  // Three landmark crags give the sixty-metre chamber the geological scale it
  // was missing. Most of each 19-24m stone is buried beyond two intersecting
  // foundation walls, so only a rough mountain shoulder enters the cavern.
  // These corners are intentionally far from every pickup, jump pad, spawn,
  // waterfall approach, and the south gate. Even the tallest visual vertex is
  // below y=26, leaving more than thirty metres of ceiling clearance.
  for (const [x, z, radius, seed, color] of [
    [-66.5, -66.0, 23.5, 831, 0x71352f],
    [66.0, -66.5, 20.5, 832, 0x66302c],
    [-66.5, 66.0, 22.0, 833, 0x79382f],
  ]) addOlympusCrag(scene, world, x, 0.10 + radius * 0.38, z, radius, color, seed);

  // Hades now occupies the whole under-palace cavern. Broad lava lakes leave
  // readable stone corridors between them instead of concentrating every
  // hazard inside the former little room.
  for (const [x, z, w, d, seed] of [
    // Split the north lake around a broad dry causeway. The waterfall is an
    // entrance, so players can move straight from its cave mouth into Hades
    // without being forced to take lava damage or already own a jetpack.
    [-16.5, -40, 17, 22, 401], [16.5, -40, 17, 22, 402],
    [-45, -4, 24, 34, 403], [45, -4, 24, 34, 404],
    [0, 36, 34, 24, 405], [-45, 40, 22, 18, 406], [45, 40, 22, 18, 407],
  ]) addScragglyLava(scene, world, x, z, w, d, -0.72, seed, {
    pointLight: false,
    qualityControlled: true,
  });

  // The main cave-to-lift chain now crosses the large north lake; additional
  // fragments spread over the side and south lakes so the whole cavern has a
  // vertical combat layer rather than one isolated platform puzzle.
  for (const [x, y, z, w, d, depth, seed] of [
    [-18, 6, -44, 14, 10, 4.5, 231],
    [12, 13, -30, 14, 12, 5.2, 232],
    [-14, 21, -12, 12, 10, 4.6, 233],
    [-45, 7, -5, 16, 14, 5.2, 234], [-42, 14, 8, 12, 10, 4.4, 235],
    [45, 7, -5, 16, 14, 5.2, 236], [42, 14, 8, 12, 10, 4.4, 237],
    [0, 7, 36, 16, 14, 5.2, 238], [-12, 14, 39, 10, 10, 4.2, 239],
    [12, 20, 34, 10, 10, 4.2, 240],
    [-48, 29, 30, 14, 12, 5, 241], [48, 32, 28, 14, 12, 5, 242],
    [-28, 38, 49, 12, 10, 4.5, 243], [28, 43, 46, 12, 10, 4.5, 244],
  ]) addOlympusFloatingRock(scene, world, x, y, z, w, d, depth, seed, true);

  // Hanging crimson vines make several Hades fragments into two-way routes,
  // while the highest pair remain dramatic dangling escape lines.
  for (const [x, z, y0, y1, exitX, exitZ, width] of [
    [-52.2, -5, 0.15, 7.1, 1, 0, 1.45], [52.2, -5, 0.15, 7.1, -1, 0, 1.45],
    [0, 43.2, 0.15, 7.1, 0, -1, 1.35],
    [-54.2, 30, 0.15, 29.1, 1, 0, 1.5], [54.2, 28, 0.15, 32.1, -1, 0, 1.5],
  ]) addVine(scene, world, x, z, y0, y1, 1.02, exitX * 0.14, exitZ * 0.14,
    exitX, exitZ, 0.2, width, 0xff5a36, 'magma-root');

  // A low, grounded volcanic dais breaks up the cavern's broad central floor
  // without cutting any of its three jump-pad routes. The upright cone and its
  // paired slope fields let players run onto the weapon perch from either side.
  addOlympusVolcanicMound(scene, world, 0, 4, 12, 10, 1.8, 260);
  // The cave-mouth crown is solid. Launch from its west shoulder rather than
  // firing straight into the overhead crag.
  addJumpPad(scene, world, -30, 0.02, -54, 21.5, 8.6, 7.2, 0xff5a24);
  addJumpPad(scene, world, -18, 6.02, -44, 27, 16.1, 7.5, 0xff7a2e);
  addJumpPad(scene, world, 12, 13.02, -30, 28, -13.65, 9.45, 0xffa13a);
  addJumpPad(scene, world, -14, 21.02, -12, 20, 18, 2.2, 0xffc24a);
  addJumpPad(scene, world, -30, 0.02, -4, 24, -9.6, 0, 0xff7a32);
  // Offset the east pad from the central-platform vine so entering the climb
  // zone cannot accidentally trigger a launch. A slight northward push keeps
  // its landing centered on the same floating rock.
  addJumpPad(scene, world, 30, 0.02, -10, 24, 9.6, 1.2, 0x72d8ff);
  addJumpPad(scene, world, 0, 0.02, 20, 24, 0, 10.5, 0xffa13a);

  // Slow embers make the full sixty-metre chamber legible without adding
  // collision or turning the view into particle noise.
  const emberCount = 40;
  const emberMat = new THREE.MeshBasicMaterial({ color: 0xff9a3c });
  const emberRnd = seededRandom(0x48414445);
  const emberSpecs = Array.from({ length: emberCount }, () => ({
    radius: 0.07 + emberRnd() * 0.09,
    x: -62 + emberRnd() * 124,
    z: -62 + emberRnd() * 124,
    startY: 1 + emberRnd() * 54,
    speed: 0.6 + emberRnd() * 1.1,
    drift: emberRnd() * Math.PI * 2,
  }));
  const embers = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 5, 4),
    emberMat,
    emberCount,
  );
  embers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // The full cavern-wide cloud is cheap as one draw and should not disappear
  // because its instance bounds were computed before a later wraparound.
  embers.frustumCulled = false;
  const emberMatrix = new THREE.Matrix4();
  const emberPosition = new THREE.Vector3();
  const emberScale = new THREE.Vector3();
  const emberRotation = new THREE.Quaternion();
  let lastEmberTime = 0;
  const updateEmbers = t => {
    lastEmberTime = t;
    const activeCount = Math.min(embers.count, emberSpecs.length);
    if (activeCount === 0) return;
    for (let i = 0; i < activeCount; i++) {
      const ember = emberSpecs[i];
      emberPosition.set(
        ember.x + Math.sin(t * 0.7 + ember.drift) * 0.55,
        1 + ((ember.startY + t * ember.speed) % 55),
        ember.z + Math.cos(t * 0.5 + ember.drift) * 0.35,
      );
      emberScale.setScalar(ember.radius);
      emberMatrix.compose(emberPosition, emberRotation, emberScale);
      embers.setMatrixAt(i, emberMatrix);
    }
    embers.instanceMatrix.needsUpdate = true;
  };
  updateEmbers(0);
  scene.add(embers);
  world.anim.push((_dt, t) => updateEmbers(t));

  // Three-stage internal lift links cave/lower hall -> mid deck -> storm
  // gallery -> palace court. Restore the two readable rectangular slabs: the
  // experimental fractured silhouettes made both landing edges look broken.
  addBox(scene, world, 18, 17.7, -8, 24, 0.6, 18, 0x9a603e, {
    tex: 'olympus-palace', repeat: [6, 4.5], debugName: 'olympus-cavern-mid-slab',
  });
  addBox(scene, world, -8, 39.7, 0, 28, 0.6, 22, 0x9a603e, {
    tex: 'olympus-palace', repeat: [7, 5.5], debugName: 'olympus-cavern-high-slab',
  });
  // Three floor-to-platform vines turn the central lift slabs into climbable
  // cavern landmarks instead of unreachable ceilings viewed from below.
  for (const [x, z, topY, exitX, exitZ] of [
    [5.85, -12, 18.05, 1, 0], [30.15, -4, 18.05, -1, 0],
    [-22.15, 4, 40.05, 1, 0],
  ]) addVine(scene, world, x, z, 0.15, topY, 1.05, exitX * 0.14, exitZ * 0.14,
    exitX, exitZ, 0.2, 1.55, 0xff7042, 'magma-root');
  // Centered in the 12m doorway gap: the old x=-12 placement intersected the
  // west wall segment and left half of the visible pad buried in masonry.
  // Pull the lower lift pad away from the mid-deck lip so its arc rises above
  // the slab before entering the destination footprint.
  addJumpPad(scene, world, 0, 0.02, -26, 32.3, 10, 10, 0xff8a32);
  addJumpPad(scene, world, 22, 18.02, -8, 37, -14.04, 3.75, 0xffc24a);
  addJumpPad(scene, world, -4, 40.02, 0, 36, 1.9, 9.53, 0x72d8ff);
  // The broad shadowless cavern lights above replace the former three
  // overlapping point lights here. Emissive lava, cracks, and jump pads still
  // provide the local warm landmarks without adding per-fragment light loops.

  // West Armory and East Storm Chapel: enclosed ground-floor combat rooms
  // whose internal ramps emerge onto the connected roof city.
  const palaceStone = 0xd7b98d;
  for (const side of [-1, 1]) {
    const cx = side * 44;
    const outerX = side * 62, innerX = side * 26;
    for (const [x, z, w, d] of [
      [outerX, -14, 3, 17], [outerX, 14, 3, 17],
      [innerX, -14, 3, 17], [innerX, 14, 3, 17],
      [cx, -24, 33, 3], [cx, 24, 33, 3],
    ]) addBox(scene, world, x, 67, z, w, 13, d, palaceStone, { tex: 'olympus-palace' });
    const laneX0 = side < 0 ? -58 : 50;
    const laneX1 = side < 0 ? -50 : 58;
    const outerStripX = side < 0 ? -60.75 : 60.75;
    const innerRoofX = side < 0 ? -37.25 : 37.25;
    addBox(scene, world, outerStripX, 74, 0, 5.5, 1, 51, 0xcaa875, { tex: 'olympus-palace' });
    addBox(scene, world, innerRoofX, 74, 0, 25.5, 1, 51, 0xcaa875, { tex: 'olympus-palace' });
    addBox(scene, world, side * 54, 74, -21.75, 8, 1, 7.5, 0xcaa875, { tex: 'olympus-palace' });
    addBox(scene, world, side * 54, 74, 21.75, 8, 1, 7.5, 0xcaa875, { tex: 'olympus-palace' });
    addRamp(scene, world, {
      axis: 'z', minX: laneX0, maxX: laneX1, minZ: -18, maxZ: 18,
      h0: 60.5, h1: 74.5, color: 0xb88748,
    });
  }

  // Green interior ladder-vines provide the remaining unique floor changes.
  // The Aether climb follows the same treatment as the other wall vines: its
  // visible sheet sits 0.29m in front of the Crown's z=8 face to avoid
  // z-fighting, while its forgiving grab zone still overlaps the ledge.
  for (const [x, z, y0, y1, exitX, exitZ] of [
    [-22.35, -46, 60.5, 78.45, -1, 0], [22.35, -46, 60.5, 78.45, 1, 0],
    [29.8, 7.85, 74.5, 90.45, 0, 1],
  ]) addVine(scene, world, x, z, y0, y1, 1.0, exitX * 0.12, exitZ * 0.12,
    exitX, exitZ, 0.2, 1.4);
  // Two exterior climbs per wing: one beside the court-facing entrance and
  // one on the far outside wall. Both crest directly onto solid roof strips.
  for (const [x, z, exitX, exitZ] of [
    [-24.35, 12, -1, 0], [-63.65, -12, 1, 0],
    [24.35, -12, 1, 0], [63.65, 12, -1, 0],
  ]) addVine(scene, world, x, z, 60.5, 74.45, 1.02, exitX * 0.13, exitZ * 0.13,
    exitX, exitZ, 0.2, 1.5);
  addArenaSign(scene, 'ARMORY', -26.08, 69.5, 0, 11, 2.75, Math.PI / 2, '#d6ad45', 'olympus');
  addArenaSign(scene, 'STORM CHAPEL', 26.08, 69.5, 0, 11, 2.75, -Math.PI / 2, '#d6ad45', 'olympus');
  addBox(scene, world, -44, 67, -22.42, 15, 7, 0.16, 0xffffff, {
    collide: false, tex: 'olympus-relief', repeat: [1, 1],
  });
  addBox(scene, world, 44, 67, -22.42, 15, 7, 0.16, 0xbadfff, {
    collide: false, tex: 'olympus-relief', repeat: [1, 1], emissive: 0x183e58, emissiveIntensity: 0.15,
  });

  // Room-specific silhouettes make the two interior wings identifiable even
  // during a fast chase: weapon racks and warm fire in the armory, suspended
  // storm machinery and cool light in the chapel. The large hanging panels are
  // real cover, so their visible boxes also own matching collision.
  for (const z of [-12, 0, 12]) {
    addBox(scene, world, -60.32, 65.4, z, 0.36, 5.2, 4.8, 0x734529, {
      tex: 'panel', repeat: [1, 2],
    });
    for (const y of [64, 66.2]) addBox(scene, world, -60.05, y, z, 0.22, 0.3, 3.6, 0xe0a43b, {
      collide: false, emissive: 0x6f2a08, emissiveIntensity: 0.25,
    });
    addBox(scene, world, 60.32, 65.4, z, 0.36, 5.2, 4.8, 0x355f78, {
      tex: 'panel', repeat: [1, 2], emissive: 0x163a55, emissiveIntensity: 0.32,
    });
  }
  for (const side of [-1, 1]) for (const z of [-16, 0, 16]) {
    addBox(scene, world, side * 44, 73.34, z, 32, 0.32, 0.8, 0xa97a3d, {
      collide: false, tex: 'olympus-palace', repeat: [8, 1],
    });
  }
  addOlympusBrazier(scene, world, -34, 60.5, 18, 0xff7a32);
  addOlympusBrazier(scene, world, 34, 60.5, 18, 0x72d8ff);
  const stormCore = new THREE.Mesh(new THREE.IcosahedronGeometry(1.45, 2), new THREE.MeshStandardMaterial({
    color: 0xbdeeff, emissive: 0x2f9fe8, emissiveIntensity: 1.4, roughness: 0.2, metalness: 0.15,
  }));
  stormCore.position.set(38, 67, -12);
  const stormRing = new THREE.Mesh(new THREE.TorusGeometry(2.7, 0.16, 8, 32), new THREE.MeshStandardMaterial({
    color: 0xd9b35b, emissive: 0x60420c, emissiveIntensity: 0.4, metalness: 0.7, roughness: 0.25,
  }));
  stormRing.position.copy(stormCore.position);
  stormRing.rotation.x = Math.PI / 2;
  scene.add(stormCore, stormRing);
  const stormLight = new THREE.PointLight(0x72d8ff, 10, 22);
  stormLight.position.copy(stormCore.position);
  scene.add(stormLight);

  // North temple roof wraps the water channel. Its two halves and the channel
  // meet at edges instead of stacking on the same plane.
  for (const [x, z, w, d] of [
    [-24, -46, 3, 29], [24, -46, 3, 29],
    [-15, -62, 18, 3], [15, -62, 18, 3],
    [-15, -30, 18, 3], [15, -30, 18, 3],
  ]) addBox(scene, world, x, 69, z, w, 17, d, palaceStone, { tex: 'olympus-palace' });
  addBox(scene, world, -15, 69, -60.42, 15, 9, 0.16, 0xffffff, {
    collide: false, tex: 'olympus-relief', repeat: [1, 1],
  });
  addBox(scene, world, 15, 69, -60.42, 15, 9, 0.16, 0xffffff, {
    collide: false, tex: 'olympus-relief', repeat: [1, 1],
  });
  addBox(scene, world, -15, 78, -46, 18, 1, 35, 0xd8b572, { tex: 'olympus-palace' });
  addBox(scene, world, 15, 78, -46, 18, 1, 35, 0xd8b572, { tex: 'olympus-palace' });
  for (const z of [-42, -58]) for (const x of [-9, 9]) {
    addOlympusColumn(scene, world, x, z, 60.5, 16.8);
  }

  // Connected roof city: armory <-> central bridge <-> north temple, plus a
  // broad south arcade that receives the floating skybridge.
  addBox(scene, world, 0, 74, -20, 49, 1, 8, 0xd8b572, { tex: 'olympus-palace' });
  addBox(scene, world, 0, 74, 52, 120, 1, 10, 0xd8b572, { tex: 'olympus-palace' });
  addBox(scene, world, -44, 74, 36.25, 10, 1, 21.5, 0xd8b572, { tex: 'olympus-palace' });
  addBox(scene, world, 44, 74, 36.25, 10, 1, 21.5, 0xd8b572, { tex: 'olympus-palace' });
  for (const x of [-15, 15]) addRamp(scene, world, {
    axis: 'z', minX: x - 6, maxX: x + 6, minZ: -28.5, maxZ: -24,
    h0: 78.5, h1: 74.5, color: 0xd8b572,
  });
  addRamp(scene, world, {
    axis: 'x', minX: 60, maxX: 89, minZ: 49, maxZ: 59,
    h0: 74.5, h1: 72, color: 0x9a603e,
  });
  for (const x of [-56, -40, -24, 24, 40, 56]) addOlympusColumn(scene, world, x, 52, 60.5, 13.5);
  addOlympusColumn(scene, world, -11, 62, 60.5, 13.5);
  addOlympusColumn(scene, world, 11, 62, 60.5, 13.5);
  addBox(scene, world, 0, 74.9, 62, 25, 1.8, 3, 0xc69132, {
    tex: 'olympus-palace', repeat: [6, 1],
  });
  addOlympusBrazier(scene, world, -20, 60.5, 48, 0xff8a32);
  addOlympusBrazier(scene, world, 20, 60.5, 48, 0x72d8ff);
  addOlympusBrazier(scene, world, -20, 78.5, -58, 0xff8a32);
  addOlympusBrazier(scene, world, 20, 78.5, -58, 0x72d8ff);
  for (const x of [-48, -16, 16, 48]) addBox(scene, world, x, 75.2, 56.5, 20, 1.4, 1, 0xb88748, {
    tex: 'olympus-palace', repeat: [5, 1],
  });
  for (const x of [-23.5, 23.5]) for (const z of [-55, -38]) {
    addBox(scene, world, x, 79.2, z, 1, 1.4, 13, 0xb88748, {
      tex: 'olympus-palace', repeat: [1, 3],
    });
  }

  // Aether Crown: a true third palace tier above the connected roof city.
  // Twin walkable ramps rise from the north bridge, while the south arcade's
  // jump pad provides a faster one-way flank. The open front, side balconies,
  // and rear doorway all let players drop back into a different palace route.
  const aetherFloorY = 90;
  addBox(scene, world, 0, aetherFloorY, 24, 64, 1, 32, 0xffffff, {
    tex: 'olympus-aether', repeat: [4, 2], roughness: 0.5, metalness: 0.1,
  });
  addBox(scene, world, -38, aetherFloorY, 28, 12, 1, 16, 0xf3dfba, {
    tex: 'olympus-aether', repeat: [1, 2],
  });
  addBox(scene, world, 38, aetherFloorY, 28, 12, 1, 16, 0xf3dfba, {
    tex: 'olympus-aether', repeat: [1, 2],
  });
  for (const x of [-17, 17]) addRamp(scene, world, {
    axis: 'z', minX: x - 5, maxX: x + 5, minZ: -16, maxZ: 8,
    h0: 74.5, h1: aetherFloorY + 0.5, color: 0xe3c27d,
  });
  // The processional hall now occupies the old pad route. The fast flank moves
  // to the open east arcade and lands on the Aether side balcony instead.
  addJumpPad(scene, world, 44, 74.52, 52, 31.5, -3.4, -13.4, 0x72d8ff);
  for (const x of [-29, 29]) for (const z of [26, 36]) {
    addOlympusColumn(scene, world, x, z, 60.5, 29);
  }

  // The upper hall is partially enclosed rather than another bare roof. The
  // split canopy preserves a bright sky slit, and all wall/column collision is
  // generated from the visible geometry itself.
  for (const x of [-21, 21]) addBox(scene, world, x, 96.5, 39, 22, 12, 2, 0xf4e1bd, {
    tex: 'olympus-aether', repeat: [2, 2],
  });
  for (const x of [-29, 29]) for (const z of [14, 26, 36]) {
    addOlympusColumn(scene, world, x, z, 90.5, 12);
  }
  // Solid side panels give ricochet weapons useful bank-shot surfaces without
  // sealing the Crown into a box. Gaps at every column remain movement lanes.
  for (const side of [-1, 1]) {
    for (const [z, d] of [[20, 8], [31, 6]]) addBox(
      scene, world, side * 31, 94.5, z, 2, 8, d, 0xead4ad,
      { tex: 'olympus-aether', repeat: [1, 2] },
    );
    addBox(scene, world, side * 43, 94, 28, 2, 7, 16, 0xd9bd8f, {
      tex: 'olympus-aether', repeat: [1, 2],
    });
  }
  for (const x of [-17, 17]) addBox(scene, world, x, 102.9, 24, 28, 0.8, 32, 0xf6e6c6, {
    tex: 'olympus-aether', repeat: [2, 3],
  });
  for (const z of [10, 24, 38]) addBox(scene, world, 0, 103.55, z, 6, 0.5, 2, 0xd4a53d, {
    tex: 'olympus-aether', repeat: [1, 1], metalness: 0.35, roughness: 0.32,
  });
  addBox(scene, world, 0, 91.2, 27, 14, 1.4, 10, 0xe2b956, {
    tex: 'olympus-aether', repeat: [2, 1], metalness: 0.28, roughness: 0.38,
  });
  addBox(scene, world, -37.5, 91.25, 20, 11, 1.5, 1, 0xb88748, {
    tex: 'olympus-aether', repeat: [2, 1],
  });
  addBox(scene, world, 37.5, 91.25, 20, 11, 1.5, 1, 0xb88748, {
    tex: 'olympus-aether', repeat: [2, 1],
  });
  addArenaSign(scene, 'AETHER CROWN', 0, 97.5, 37.94, 13, 3.25, 0, '#d6ad45', 'olympus', true);
  addOlympusBrazier(scene, world, -23, 90.5, 34, 0xffd36a);
  addOlympusBrazier(scene, world, 23, 90.5, 34, 0x72d8ff);
  const aetherLight = new THREE.PointLight(0xc4edff, 12, 32);
  aetherLight.position.set(0, 99, 25);
  scene.add(aetherLight);

  // The rear doorway now continues into a proper enclosed processional hall,
  // then opens into the spring terrace instead of stopping at the back wall.
  addBox(scene, world, 0, 90, 50, 20, 1, 20, 0xf8e8ca, {
    tex: 'olympus-aether', repeat: [2, 3],
  });
  for (const side of [-1, 1]) addBox(scene, world, side * 9.25, 96.5, 50, 1.5, 12, 20, 0xe9d2aa, {
    tex: 'olympus-aether', repeat: [1, 4],
  });
  addBox(scene, world, 0, 102.9, 50, 20, 0.8, 20, 0xf3dfba, {
    tex: 'olympus-aether', repeat: [2, 3],
  });
  for (const z of [43, 50, 57]) addBox(scene, world, 0, 102.42, z, 20, 0.36, 0.7, 0xc89a38, {
    tex: 'olympus-aether', repeat: [4, 1], metalness: 0.4, roughness: 0.3,
  });

  // Open spring terrace. Its side and rear walls provide more close-quarters
  // bounce geometry, while the west wall leaves a centered outlet for water.
  addBox(scene, world, 0, 90, 71, 36, 1, 22, 0xf5e4c2, {
    tex: 'olympus-aether', repeat: [3, 2],
  });
  addBox(scene, world, 17, 95, 70, 2, 9, 20, 0xe3c79a, {
    tex: 'olympus-aether', repeat: [1, 3],
  });
  for (const [z, d] of [[64, 8], [77, 6]]) addBox(
    scene, world, -17, 95, z, 2, 9, d, 0xe3c79a,
    { tex: 'olympus-aether', repeat: [1, 2] },
  );
  addBox(scene, world, 0, 95, 81, 36, 9, 2, 0xe3c79a, {
    tex: 'olympus-aether', repeat: [4, 2],
  });
  // These columns stand on two different real surfaces: the inner pair rests
  // on the palace foundation, while the outer pair rests on the mountain box.
  // olympusSurfaceY follows the old stepped profile at z=78 and buried those
  // outer bases 35 metres inside the current flat-topped mountain geometry.
  for (const x of [-14, 14]) for (const z of [64, 78]) {
    const baseY = z === 64 ? 60.5 : OLYMPUS_SUMMIT_Y;
    addOlympusColumn(scene, world, x, z, baseY, 89.5 - baseY);
  }

  // A glass-and-gold conservatory turns the Spring into its own enclosed
  // biome. The dome rises well above the combat floor; planted beds hug the
  // perimeter so the pool, aqueduct outlet, and processional doorway remain
  // clear circulation lanes.
  addOlympusConservatoryDome(scene, world, 0, 90.55, 70.5);
  for (const [x, z, w, d] of [
    [13.5, 70.5, 5, 14], [-13.5, 63.5, 5, 4], [-13.5, 78.5, 5, 4],
  ]) {
    addBox(scene, world, x, 90.9, z, w, 0.8, d, 0xd1aa69, {
      tex: 'olympus-aether', repeat: [Math.max(1, w / 3), Math.max(1, d / 3)],
    });
    addBox(scene, world, x, 91.34, z, w - 0.5, 0.06, d - 0.5, 0x4c7d3f, {
      collide: false, tex: x < 0 ? 'flowers' : 'grass',
      repeat: [Math.max(1, w / 3), Math.max(1, d / 3)],
    });
  }
  for (const [x, z, scale, seed] of [
    [12.2, 65.5, 1.05, 301], [12.2, 70.5, 1.25, 302], [12.2, 75.5, 1.1, 303],
    [-12.2, 63.5, 1.15, 304], [-12.2, 78.5, 1.25, 305],
  ]) addOlympusConservatoryPlant(scene, world, x, 91.33, z, scale, seed);
  for (const [x, z, height, seed] of [
    [14.6, 64.5, 5.8, 321], [14.6, 76.3, 6.8, 322],
    [-14.7, 63.4, 6.4, 323], [-14.7, 78.6, 7.1, 324],
  ]) addOlympusConservatoryTree(scene, world, x, 91.36, z, height, seed);
  for (const [x, y, z, scale, seed] of [
    [-8.5, 101, 66, 0.82, 311], [8.5, 101, 66, 0.82, 312],
    [-8.5, 101, 76, 0.82, 313], [8.5, 101, 76, 0.82, 314],
  ]) addOlympusConservatoryPlant(scene, world, x, y, z, scale, seed, true);
  flushOlympusConservatoryFoliage(scene, world);

  // The sacred pool is the source of a high, exposed aqueduct. Its water
  // planes meet only at their edges: pool -> west branch -> two dedicated
  // corners -> long sky channel -> north spillway.
  const sourceWaterY = 91.15;
  const sourceSegments = [
    [0, 71, 16, 10, true],    // pool: often fills the view inside the dome
    [-21.5, 71, 27, 6],      // pool to south corner
    [-38, 71, 6, 6],         // south corner
    [-38, 22.5, 6, 91],      // exposed north/south aqueduct
    [-38, -26, 6, 6],        // north corner
    [-16, -26, 38, 6],       // spillway fully feeds the 6m waterfall lip
  ];
  for (const [x, z, w, d, unlit] of sourceSegments) {
    addBox(scene, world, x, 90.8, z, w, 0.6, d, 0xd5a33e, {
      tex: 'olympus-aether', repeat: [Math.max(1, w / 7), Math.max(1, d / 7)],
      metalness: 0.24, roughness: 0.38,
    });
    addFittedWater(scene, world, {
      minX: x - w / 2, maxX: x + w / 2,
      minZ: z - d / 2, maxZ: z + d / 2,
      // These six exposed sheets join one another, so they must butt exactly.
      // Hidden overlap is reserved for water edges tucked beneath solid walls.
      y: sourceWaterY, depth: 0.55, edgeOverlap: 0,
      opts: unlit ? { unlit: true, color: 0x287da0, opacity: 0.5 } : {},
    });
  }
  // Pool coping butts against the water rather than overlapping it.
  addBox(scene, world, 8.6, 91.35, 71, 1.2, 1.7, 12, 0xe1b94f, { tex: 'olympus-aether' });
  for (const z of [67, 75]) addBox(scene, world, -8.6, 91.35, z, 1.2, 1.7, 2, 0xe1b94f, {
    tex: 'olympus-aether',
  });
  for (const z of [65.4, 76.6]) addBox(scene, world, 0, 91.35, z, 16, 1.7, 1.2, 0xe1b94f, {
    tex: 'olympus-aether', repeat: [3, 1],
  });
  // Repeated side pylons make the hundred-metre sky channel readable without
  // creating a continuous waist-high wall that would trap players in water.
  for (const z of [-18, -4, 10, 24, 38, 52, 66]) for (const x of [-41.2, -34.8]) {
    addBox(scene, world, x, 91.65, z, 0.8, 2.3, 1.2, 0xc69631, {
      tex: 'olympus-aether', repeat: [1, 1],
    });
  }
  for (const x of [-30, -18, -6]) addOlympusColumn(scene, world, x, -26, 60.5, 30);
  addWaterfall(scene, world, 0, -28.8, 6, 13, 78.15, sourceWaterY, -1.5, {
    lipColor: 0xd5a33e, lipTex: 'olympus-aether',
  });
  addArenaSign(scene, 'SPRING OF AETHER', 0, 96.5, 79.94, 12, 3, Math.PI, '#d6ad45', 'olympus');

  // The receiving aqueduct on the north roof still drops the full cliff face,
  // then becomes a wadeable river running all the way to the map boundary.
  addBox(scene, world, 0, 77.2, -57, 12, 1.6, 55, 0xcaa875, { tex: 'olympus-palace' });
  addBox(scene, world, -6.2, 78.35, -57, 0.7, 1.1, 55, 0xd6a947, { tex: 'panel' });
  addBox(scene, world, 6.2, 78.35, -57, 0.7, 1.1, 55, 0xd6a947, { tex: 'panel' });
  // Fit to the actual inner faces of the aqueduct walls. The former 10.4m
  // sheet left a visible 65cm dry strip down both sides of the channel.
  addFittedWater(scene, world, {
    minX: -5.85, maxX: 5.85, minZ: -84.5, maxZ: -29.5,
    y: 78.15, depth: 0.3, edgeOverlap: 0.14,
  });
  addWaterfall(scene, world, 0, fallZ, 12, 78, -0.4, 77.8, 0);
  // An opaque riverbed masks the moat below the transparent water sheet, so
  // the outlet reads purely as water rather than a water/lava blend.
  addBox(scene, world, 0, 0.16, -155.5, 12.2, 0.1, 29, 0x123f57, {
    collide: false, shadow: false, roughness: 0.7,
  });
  addFittedWater(scene, world, {
    minX: -6.1, maxX: 6.1, minZ: -170, maxZ: -82,
    y: 0.24, depth: 0.38, edgeOverlap: 0.14,
  });
  addBox(scene, world, -6.7, 0.45, -126, 1.2, 0.9, 88, 0x7b4635, { tex: 'olympus-rock' });
  addBox(scene, world, 6.7, 0.45, -126, 1.2, 0.9, 88, 0x7b4635, { tex: 'olympus-rock' });
  const caveShade = new THREE.Mesh(new THREE.PlaneGeometry(11, 8.5), new THREE.MeshBasicMaterial({
    color: 0x06060a, transparent: true, opacity: 0.54, side: THREE.DoubleSide, depthWrite: false,
  }));
  caveShade.position.set(0, 4.25, fallZ + 0.35);
  scene.add(caveShade);
  // Two small grounded rocks frame the base without entering the +/-8m cave
  // passage or crossing the +/-6m water sheet. Their nearest visual points
  // are x=+/-8.3m; the waterfall therefore remains continuous top-to-bottom.
  addOlympusCrag(scene, world, -11.1, 2.25, fallZ + 0.6, 2.8, 0x71383b, 91);
  addOlympusCrag(scene, world, 11.1, 2.25, fallZ + 0.6, 2.8, 0x71383b, 92);

  // One shared architectural language now carries from the summit palace to
  // the Crown: stepped Deco crowns, gold fins, pylons, and low-poly Olympian
  // guardians. Statue pedestals own the only collision; projecting limbs and
  // spears are decorative and cannot create surprise snags in a firefight.
  addOlympusDecoArchitecture(scene, world);
  addOlympusStatues(scene, world);

  // Court shrine and throne sit south of the lift's new rock throat. Moving
  // the ensemble nine metres deeper into the court preserves its focal role
  // while leaving a real two-metre clear landing beyond the tunnel exit.
  addBox(scene, world, 0, 62.5, 39, 16, 4, 14, 0x9d6738, { tex: 'olympus-palace' });
  addBox(scene, world, 0, 64.65, 39, 16.8, 0.3, 14.8, 0xf0bf55, {
    emissive: 0x7a3609, emissiveIntensity: 0.22,
  });
  const throneBack = new THREE.Mesh(new THREE.TorusGeometry(3.5, 0.42, 12, 40, Math.PI), new THREE.MeshStandardMaterial({
    color: 0xf0b94e, emissive: 0x6d2808, emissiveIntensity: 0.35, metalness: 0.66, roughness: 0.26,
  }));
  throneBack.rotation.z = Math.PI;
  throneBack.position.set(0, 69, 36);
  scene.add(throneBack);
  // Every Olympus weapon has a primary placement in or on the palace. The
  // desert and Hades placements are deliberately duplicates, so players who
  // fall can re-arm without making the recovery areas the main battlefield.
  for (const [kind, x, y, z, extra] of [
    ['weapon', -118, 0.25, 20, { weapon: 'scatter' }],
    ['weapon', 118, 0.25, -20, { weapon: 'pulsar' }],
    ['weapon', 0, 2.05, 4, { weapon: 'zooka' }],
    // Secondary Sidewinder placement on an otherwise empty Hades fragment;
    // its primary placement remains on the Armory roof.
    ['weapon', -45, 7.3, -5, { weapon: 'sidewinder' }],
    ['ammo', 14, 13.3, -30, { weapon: 'zooka' }],
    ['speed', 0, 0.65, -60, {}],
    ['health', -17, 21.3, -12, {}],
    ['jetpack', -11, 21.3, -12, {}],
    ['weapon', -44, 60.8, 0, { weapon: 'hyper' }],
    ['weapon', 44, 60.8, 0, { weapon: 'whomper' }],
    // Opposite ends of the monumental south pavilion now reward crossing the
    // whole hall, while the center Ballzooka pulls fights through its axis.
    ['weapon', -48, 60.8, 42, { weapon: 'scatter' }],
    ['weapon', 48, 60.8, 42, { weapon: 'pulsar' }],
    ['weapon', 0, 60.8, 52, { weapon: 'zooka' }],
    ['weapon', -44, 74.8, 52, { weapon: 'sidewinder' }],
    ['weapon', 0, 74.8, -20, { weapon: 'parasite' }],
    ['weapon', 14, 78.8, -44, { weapon: 'thunderbolt' }],
    ['gold', -14, 78.8, -44, {}], ['silver', 18, 18.4, -8, {}],
    ['health', -30, 0.65, -24, {}], ['health', 0, 0.25, 102, {}],
    ['shield', -44, 60.8, 15, {}], ['shield', 44, 60.8, 15, {}],
    ['shield', 0, 91.2, 71, {}],
    ['jetpack', 100, 50.3, 68, {}],
    ['jetpack', 0, 92.2, 27, {}],
    ['ammo', 0, 90.8, 13, { weapon: 'thunderbolt' }],
    ['ammo', -38, 91.2, 24, { weapon: 'thunderbolt' }],
    ['ammo', 96, 72.3, 56, { weapon: 'thunderbolt' }],
    ['ammo', -36, 74.8, -20, { weapon: 'hyper' }],
    ['ammo', 36, 74.8, -20, { weapon: 'parasite' }],
    ['star', 0, 40.4, 0, { hidden: true }],
    ['star', -58, 74.8, 52, { hidden: true }],
  ]) pk(world, kind, x, y ?? olympusSurfaceY(x, z) + 0.25, z, extra);

  world.spawns.blue.push(
    V(-52, 60.6, 38), V(-44, 60.6, -14), V(-18, 60.6, 32), V(-15, 60.6, -52),
    V(-44, 74.6, 20), V(-30, 74.6, 52), V(-15, 78.6, -52), V(-30, 0.1, -22),
    V(-20, 90.6, 26),
  );
  world.spawns.red.push(
    V(52, 60.6, 38), V(44, 60.6, -14), V(18, 60.6, 32), V(15, 60.6, -52),
    V(44, 74.6, 20), V(30, 74.6, 52), V(15, 78.6, -52), V(30, 0.1, -22),
    V(20, 90.6, 26),
  );
  world.spawns.ffa.push(
    V(-18, 60.6, 32), V(18, 60.6, 32), V(-52, 60.6, 38), V(52, 60.6, 38),
    V(-44, 60.6, -14), V(44, 60.6, -14), V(-15, 60.6, -52), V(15, 60.6, -52),
    V(-44, 74.6, 20), V(44, 74.6, 20), V(-30, 74.6, 52), V(30, 74.6, 52),
    V(-15, 78.6, -52), V(15, 78.6, -52), V(-30, 0.1, -22), V(30, 0.1, -22),
    V(-20, 90.6, 26), V(20, 90.6, 26),
  );

  // Basin recovery loop, explicit pad links, indoor lift, palace rooms, roof
  // city, and skybridge all form one navigable graph.
  const outerR = 108;
  for (let i = 0; i < 8; i++) {
    const u = -outerR + (outerR * 2 * i) / 8;
    wp(world, -outerR, 0, u); wp(world, u, 0, outerR);
    wp(world, outerR, 0, -u); wp(world, -u, 0, -outerR);
  }
  world.manualLinks.push(
    [-120, 0, 20, -100, 26, 28], [-96, 26, 28, -62, 60.5, 38],
    [120, 0, 20, 100, 26, 28], [96, 26, 28, 62, 60.5, 38],
    [0, 0, 120, 0, 26, 100], [0, 26, 96, 36, 60.5, 60],
    [36, 60.5, 60, 0, 60.5, 60],
    [134, 0, 104, 113, 18, 94], [109, 18, 92, 102, 34, 80],
    [104, 34, 78, 100, 50, 65], [102, 50, 63, 96, 72, 54],
    [113, 18, 94, 109, 18, 92], [102, 34, 80, 104, 34, 78],
    [100, 50, 65, 102, 50, 63],
    // Red cliff and floating-rock vines are genuine recovery routes, not just
    // decoration, so bots can include them in the circulation graph.
    [-89, 0, -38, -84, 60.5, -38], [89, 0, 34, 84, 60.5, 34],
    [-30, 0, 89, -30, 60.5, 84], [34, 0, -89, 34, 60.5, -84],
    [104, 0, 94, 113, 18, 94],
    [0, 0, -26, 18, 18, -8], [22, 18, -8, -8, 40, 0],
    [-4, 40, 0, 0, 60.5, 20],
    [-30, 0, -54, -18, 6, -44], [-18, 6, -44, 12, 13, -30],
    [12, 13, -30, -14, 21, -12], [-14, 21, -12, 18, 18, -8],
    [-30, 0, -4, -45, 7, -5], [30, 0, -10, 45, 7, -5],
    [30, 0, -4, 30, 0, -10],
    [0, 0, 20, 0, 7, 36],
    [-52, 0, -5, -50, 7, -5], [52, 0, -5, 50, 7, -5],
    [0, 0, 43, 0, 7, 41],
    [-54, 0, 30, -52, 29, 30], [54, 0, 28, 52, 32, 28],
    [6, 0, -12, 8, 18, -12], [30, 0, -4, 28, 18, -4],
    [-22, 0, 4, -20, 40, 4],
    // Explicit circulation links keep walls/floor edges from splitting the
    // bot graph even though each route is physically walkable for players.
    [-62, 60.5, 38, -52, 60.5, 0], [-52, 60.5, 0, -44, 60.5, 15],
    [-44, 60.5, 15, -30, 60.5, 0], [-30, 60.5, 0, 0, 60.5, 20],
    [62, 60.5, 38, 52, 60.5, 0], [52, 60.5, 0, 44, 60.5, 15],
    [44, 60.5, 15, 30, 60.5, 0], [30, 60.5, 0, 0, 60.5, 20],
    [0, 60.5, 20, -18, 60.5, 32], [0, 60.5, 20, 18, 60.5, 32],
    [-18, 60.5, 32, 0, 60.5, 48], [18, 60.5, 32, 0, 60.5, 48],
    [0, 60.5, 48, 0, 60.5, 60],
    [-44, 60.5, 15, -44, 74.5, 20], [44, 60.5, 15, 44, 74.5, 20],
    [-44, 74.5, 20, -44, 74.5, -20], [44, 74.5, 20, 44, 74.5, -20],
    [-44, 74.5, -20, 0, 74.5, -20], [44, 74.5, -20, 0, 74.5, -20],
    [-44, 74.5, 20, -30, 74.5, 52], [44, 74.5, 20, 30, 74.5, 52],
    // Interior green ladder-vines provide unique roof changes without
    // duplicating the existing Armory and Storm Chapel exterior climbs.
    [-22, 60.5, -46, -22, 78.5, -46], [22, 60.5, -46, 22, 78.5, -46],
    [30, 74.5, 8, 30, 90.5, 10],
    // Court-facing and far-side exterior vines climb the Armory and Storm
    // Chapel walls onto their roof strips.
    [-24, 60.5, 12, -26, 74.5, 12], [-64, 60.5, -12, -61, 74.5, -12],
    [24, 60.5, -12, 26, 74.5, -12], [64, 60.5, 12, 61, 74.5, 12],
    [-30, 74.5, 52, 0, 74.5, 52], [30, 74.5, 52, 0, 74.5, 52],
    [0, 74.5, -20, -15, 78.5, -46], [0, 74.5, -20, 15, 78.5, -46],
    [-15, 78.5, -46, 15, 78.5, -46],
    [0, 74.5, -20, -17, 74.5, -20], [-17, 74.5, -20, -17, 90.5, 10],
    [0, 74.5, -20, 17, 74.5, -20], [17, 74.5, -20, 17, 90.5, 10],
    [-17, 90.5, 10, 0, 90.5, 24], [17, 90.5, 10, 0, 90.5, 24],
    [0, 90.5, 24, -38, 90.5, 28], [0, 90.5, 24, 38, 90.5, 28],
    [30, 74.5, 52, 44, 74.5, 52], [44, 74.5, 52, 38, 90.5, 28],
    [38, 90.5, 28, 0, 90.5, 24], [0, 90.5, 34, 0, 90.5, 24],
    [0, 90.5, 34, 0, 90.5, 48], [0, 90.5, 48, 0, 90.5, 60],
    [0, 90.5, 60, 0, 90.5, 71], [0, 90.5, 71, -17, 90.5, 71],
    [-17, 90.5, 71, -38, 90.5, 71], [-38, 90.5, 71, -38, 90.5, 38],
    [-38, 90.5, 38, -38, 90.5, 10], [-38, 90.5, 10, -38, 90.5, -20],
    [-38, 90.5, -20, -17, 90.5, -26], [-17, 90.5, -26, 0, 90.5, -26],
    [96, 72, 54, 89, 72, 54], [89, 72, 54, 60, 74.5, 54],
    [60, 74.5, 54, 30, 74.5, 52],
    [0, 0, -104, 0, 0, -86], [0, 0, -86, 0, 0, -72],
    [0, 0, -72, 0, 0, -56], [0, 0, -56, 0, 0, -54],
    [0, 0, -54, -30, 0, -54], [-30, 0, -54, -30, 0, -24],
    [0, 0, -54, 30, 0, -54], [30, 0, -54, 30, 0, -24],
    [-30, 0, -24, 0, 0, -26], [30, 0, -24, 0, 0, -26],
    [0, 0, -26, -30, 0, -4], [0, 0, -26, 30, 0, -4],
    [0, 0, -26, 0, 0, 20],
  );
  for (const [x, y, z] of [
    [-120, 0, 20], [-100, 26, 28], [-96, 26, 28], [-62, 60.5, 38],
    [120, 0, 20], [100, 26, 28], [96, 26, 28], [62, 60.5, 38],
    [0, 0, 120], [0, 26, 100], [0, 26, 96], [36, 60.5, 60], [0, 60.5, 60],
    [134, 0, 104], [113, 18, 94], [109, 18, 92], [102, 34, 80],
    [104, 34, 78], [100, 50, 65], [102, 50, 63], [96, 72, 54],
    [89, 72, 54], [60, 74.5, 54],
    [-89, 0, -38], [-84, 60.5, -38], [89, 0, 34], [84, 60.5, 34],
    [-30, 0, 89], [-30, 60.5, 84], [34, 0, -89], [34, 60.5, -84],
    [104, 0, 94],
    [0, 0, -104], [0, 0, -86], [0, 0, -72], [0, 0, -56], [0, 0, -54],
    [-18, 6, -44], [12, 13, -30], [-14, 21, -12],
    [-30, 0, -54], [30, 0, -54], [-30, 0, -24], [30, 0, -24],
    [0, 0, -26], [-30, 0, -4], [30, 0, -4], [30, 0, -10], [0, 0, 20],
    [-45, 7, -5], [45, 7, -5], [0, 7, 36], [18, 18, -8], [22, 18, -8],
    [-52, 0, -5], [-50, 7, -5], [52, 0, -5], [50, 7, -5], [0, 0, 43], [0, 7, 41],
    [-54, 0, 30], [-52, 29, 30], [54, 0, 28], [52, 32, 28],
    [6, 0, -12], [8, 18, -12], [30, 0, -4], [28, 18, -4],
    [-22, 0, 4], [-20, 40, 4],
    [-8, 40, 0], [-4, 40, 0], [0, 60.5, 20],
    [-52, 60.5, 0], [-44, 60.5, 15], [-30, 60.5, 0],
    [52, 60.5, 0], [44, 60.5, 15], [30, 60.5, 0],
    [-18, 60.5, 32], [18, 60.5, 32], [0, 60.5, 48],
    [-44, 74.5, 20], [-44, 74.5, -20], [44, 74.5, 20], [44, 74.5, -20],
    [-28, 60.5, 8], [-28, 74.5, 8], [28, 60.5, -8], [28, 74.5, -8],
    [-22, 60.5, -46], [-22, 78.5, -46], [22, 60.5, -46], [22, 78.5, -46],
    [30, 74.5, 20], [30, 90.5, 20],
    [-24, 60.5, 12], [-26, 74.5, 12], [-64, 60.5, -12], [-61, 74.5, -12],
    [24, 60.5, -12], [26, 74.5, -12], [64, 60.5, 12], [61, 74.5, 12],
    [-30, 74.5, 52], [0, 74.5, 52], [30, 74.5, 52],
    [-15, 78.5, -46], [15, 78.5, -46], [0, 74.5, -20],
    [-17, 74.5, -20], [-17, 90.5, 10], [17, 74.5, -20], [17, 90.5, 10],
    [0, 90.5, 24], [-38, 90.5, 28], [38, 90.5, 28],
    [0, 74.5, 52], [44, 74.5, 52], [0, 90.5, 34],
    [0, 90.5, 48], [0, 90.5, 60], [0, 90.5, 71], [-17, 90.5, 71],
    [-38, 90.5, 71], [-38, 90.5, 38], [-38, 90.5, 10], [-38, 90.5, -20],
    [-17, 90.5, -26], [0, 90.5, -26],
  ]) wp(world, x, y, z);

  world.setVisualQuality = tier => {
    world._olympusVisualTier = tier;

    // Keep every damaging lava surface visible at every tier; only the small
    // decorative spit meshes scale down, so the hazard never becomes unclear.
    const lavaBlobsPerLake = tier === 'high' ? 2 : tier === 'standard' ? 1 : 0;
    for (const { blob, index } of world._olympusLavaBlobs || []) {
      blob.visible = index < lavaBlobsPerLake;
    }

    const activeEmbers = tier === 'high' ? emberCount : tier === 'standard' ? 22 : 0;
    embers.count = activeEmbers;
    embers.visible = activeEmbers > 0;
    if (activeEmbers > 0) updateEmbers(lastEmberTime);

    // The broader outer crack network remains visible on Low, while its
    // brighter inner overlay is optional decoration.
    if (world._olympusCoreVeins) world._olympusCoreVeins.visible = tier !== 'low';
  };
  world.setVisualQuality('high');

  flushOlympusColumns(scene, world);
  buildMeteorSurfaceIndex(world);
  mergeStatic(scene, world);
  return world;
}

/* ============== SECRET MAP — SOLAR FLARE (orbital power station) ============== */
function buildSolarFlare(scene) {
  const world = newWorld({
    gravity: 25, jumpVel: 9.2, killY: -70, playerSpeed: 11.5,
    waypointLinkDist: 19, waypointLinkDy: 5,
    availableWeapons: ['blaster', 'scatter', 'pulsar', 'sidewinder', 'zooka', 'hyper', 'parasite', 'whomper'],
  });
  scene.background = new THREE.Color(0x03040b);
  baseLighting(scene, 0xffb85a, 0x120b18, [70, 110, -55], 100);

  // Deep star field with a hot red corona behind the station.
  const starGeo = new THREE.BufferGeometry();
  const starPos = new Float32Array(1300 * 3);
  for (let i = 0; i < 1300; i++) {
    const p = V(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize().multiplyScalar(rand(260, 430));
    starPos.set([p.x, p.y, p.z], i * 3);
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({
    color: 0xfff4dc, size: 1.35, sizeAttenuation: false, fog: false,
  })));

  const hot = 0xff7a18;
  const cool = 0x36d8ff;
  const hull = 0xd8d6ca;
  const inner = 0x26384a;
  const floor = 0x5d6872;

  const wallH = 6.2;
  const addRealGlass = (side, cx, baseY, cz, w, d, feature) => {
    const alongZ = side === 'west' || side === 'east';
    const wallX = side === 'west' ? cx - w / 2 : side === 'east' ? cx + w / 2 : feature.center;
    const wallZ = side === 'north' ? cz - d / 2 : side === 'south' ? cz + d / 2 : feature.center;
    const glassH = feature.top - feature.bottom;
    const glass = new THREE.Mesh(
      new THREE.BoxGeometry(alongZ ? 0.16 : feature.width, glassH, alongZ ? feature.width : 0.16),
      new THREE.MeshPhysicalMaterial({
        color: feature.tint || 0xa8eaff, transparent: true, opacity: 0.18,
        transmission: 0.72, roughness: 0.08, metalness: 0.04,
        thickness: 0.12, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    glass.position.set(wallX, baseY + (feature.bottom + feature.top) / 2, wallZ);
    scene.add(glass);
    world.colliders.push({
      type: 'box',
      min: V(wallX - (alongZ ? 0.12 : feature.width / 2), baseY + feature.bottom, wallZ - (alongZ ? feature.width / 2 : 0.12)),
      max: V(wallX + (alongZ ? 0.12 : feature.width / 2), baseY + feature.top, wallZ + (alongZ ? feature.width / 2 : 0.12)),
    });
  };
  const addWallSide = (cx, baseY, cz, w, d, side, doorCenter = null, windowFeatures = []) => {
    const alongZ = side === 'west' || side === 'east';
    const length = alongZ ? d : w;
    const center = alongZ ? cz : cx;
    const wallX = side === 'west' ? cx - w / 2 : side === 'east' ? cx + w / 2 : cx;
    const wallZ = side === 'north' ? cz - d / 2 : side === 'south' ? cz + d / 2 : cz;
    const openings = [];
    if (doorCenter != null) openings.push({
      min: doorCenter - 2.7, max: doorCenter + 2.7, bottom: 0, top: 5.4,
    });
    for (const feature of windowFeatures) openings.push({
      min: feature.center - feature.width / 2, max: feature.center + feature.width / 2,
      bottom: feature.bottom, top: feature.top,
    });
    const min = center - length / 2;
    const max = center + length / 2;
    const alongCuts = [...new Set([min, max, ...openings.flatMap((o) => [Math.max(min, o.min), Math.min(max, o.max)])])].sort((a, b) => a - b);
    const yCuts = [...new Set([0, wallH, ...openings.flatMap((o) => [Math.max(0, o.bottom), Math.min(wallH, o.top)])])].sort((a, b) => a - b);
    for (let ai = 0; ai < alongCuts.length - 1; ai++) for (let yi = 0; yi < yCuts.length - 1; yi++) {
      const a0 = alongCuts[ai], a1 = alongCuts[ai + 1];
      const y0 = yCuts[yi], y1 = yCuts[yi + 1];
      if (a1 - a0 < 0.05 || y1 - y0 < 0.05) continue;
      const am = (a0 + a1) / 2, ym = (y0 + y1) / 2;
      if (openings.some((o) => am > o.min && am < o.max && ym > o.bottom && ym < o.top)) continue;
      addBox(scene, world,
        alongZ ? wallX : am, baseY + ym, alongZ ? am : wallZ,
        alongZ ? 1 : a1 - a0, y1 - y0, alongZ ? a1 - a0 : 1,
        hull, { tex: 'solar-hull' });
    }
    for (const feature of windowFeatures) addRealGlass(side, cx, baseY, cz, w, d, feature);
  };
  const addModuleShell = (cx, baseY, cz, w, d, {
    doors = {}, windows = {}, roof = true, hasFloor = true,
  } = {}) => {
    if (hasFloor) addBox(scene, world, cx, baseY - 0.55, cz, w, 1.1, d, floor, { tex: 'solar-hull' });
    if (roof) addBox(scene, world, cx, baseY + wallH + 0.35, cz, w, 0.7, d, hull, { tex: 'solar-hull' });
    for (const side of ['west', 'east', 'north', 'south'])
      addWallSide(cx, baseY, cz, w, d, side, doors[side], windows[side] || []);
  };
  const addPassage = (x, baseY, z, w, d, axis = 'x') => {
    addBox(scene, world, x, baseY - 0.45, z, w, 0.9, d, floor, { tex: 'solar-hull' });
    addBox(scene, world, x, baseY + 5.75, z, w, 0.9, d, hull, { tex: 'solar-hull' });
    if (axis === 'x') for (const sz of [-1, 1])
      addBox(scene, world, x, baseY + 2.65, z + sz * d / 2, w, 5.3, 0.7, inner, { tex: 'solar-hull' });
    else for (const sx of [-1, 1])
      addBox(scene, world, x + sx * w / 2, baseY + 2.65, z, 0.7, 5.3, d, inner, { tex: 'solar-hull' });
  };

  // Three readable modules. Interiors are intentionally open rooms; geometry
  // inside them stays waist-high so the hull boundaries and exits remain clear.
  // (The old port-side engineering dead-end was cut to keep the loop tight.)
  addModuleShell(0, 0, 0, 32, 28, {
    doors: { south: 8 }, roof: false,
    windows: { west: [{ center: 0, width: 17, bottom: 1.5, top: 5.1, tint: 0xffc58a }] },
  });                                                               // central lower
  addModuleShell(34, 0, 25, 24, 22, {
    doors: { west: 25 },
    windows: { south: [{ center: 34, width: 13, bottom: 1.5, top: 5.1 }] },
    roof: false,
  });                                                               // science
  addModuleShell(42, 7.4, 0, 26, 24, {
    doors: { west: 0, east: 0, south: 42 },
    windows: { north: [{ center: 42, width: 16, bottom: 1.5, top: 5.1 }] },
  });                                                               // elevated bridge

  // The central module's uninterrupted north bulkhead is the one large hull
  // surface that stays readable without competing with doors or glass.
  for (const x of [-9, 9]) addDecal(scene, 'poster-solar', x, 3.1, -13.47, 5.4, 0);

  // L-bend to science and one upper bridge. Each connection has a single
  // obvious direction of travel.
  addPassage(8, 0, 18, 6, 8, 'z');
  addModuleShell(8, 0, 25, 8, 8, { doors: { north: 8, east: 25 } });
  addPassage(17, 0, 25, 10, 6, 'x');
  addPassage(22.5, 7.4, 0, 13, 6, 'x');

  // Science has a real maintenance hatch rather than an ornamental ladder
  // disappearing into a ceiling. The compact upper relay room closes the map
  // loop: science -> ladder -> relay -> bridge -> ramp -> central -> science.
  for (const [x, z, w, d] of [
    [31.25, 25, 18.5, 22], [44.75, 25, 2.5, 22],
    [42, 18.75, 3, 9.5], [42, 31.25, 3, 9.5],
  ]) addBox(scene, world, x, 6.55, z, w, 0.7, d, hull, { tex: 'solar-hull' });

  addModuleShell(42, 7.4, 25, 14, 10, {
    doors: { north: 42, west: 25 }, hasFloor: false,
  });
  for (const [x, z, w, d] of [
    [37.75, 25, 5.5, 10], [46.25, 25, 5.5, 10],
    [42, 21.75, 3, 3.5], [42, 28.25, 3, 3.5],
  ]) addBox(scene, world, x, 6.85, z, w, 1.1, d, floor, { tex: 'solar-hull' });
  addPassage(42, 7.4, 16, 6, 8, 'z');
  const solarCylinderBetween = (start, end, radius, radial = 8) => {
    const delta = end.clone().sub(start);
    const geometry = new THREE.CylinderGeometry(radius, radius, delta.length(), radial, 1);
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), delta.clone().normalize()));
    geometry.translate((start.x + end.x) / 2, (start.y + end.y) / 2, (start.z + end.z) / 2);
    return geometry;
  };
  const addMaintenanceLadder = (x, z, y0, y1, exitX, exitZ) => {
    const geometries = [];
    for (const dx of [-0.68, 0.68])
      geometries.push(solarCylinderBetween(V(x + dx, y0, z), V(x + dx, y1, z), 0.075, 7));
    for (let y = y0 + 0.35; y <= y1 - 0.35; y += 0.48)
      geometries.push(solarCylinderBetween(V(x - 0.68, y, z), V(x + 0.68, y, z), 0.065, 7));
    const ladder = new THREE.Mesh(mergeGeometries(geometries, false), mat(0x768b98, {
      roughness: 0.38, metalness: 0.72, emissive: 0x102b35, emissiveIntensity: 0.18,
    }));
    ladder.castShadow = true;
    scene.add(ladder);
    geometries.forEach((geometry) => geometry.dispose());
    (world.vineZones ||= []).push({
      x, z, minY: y0, maxY: y1 - 0.35, r: 0.84, grabR: 1.22, exitX, exitZ,
    });
  };
  addMaintenanceLadder(42, 25, 0.15, 7.75, -1, 0);
  addMaintenanceLadder(42, 30.48, 7.1, 14.65, 0, -1);

  // Central upper storey with a large ramp opening. No partitions are placed
  // around the landing, so players immediately understand the floor change.
  addBox(scene, world, 0, 6.85, -9.5, 32, 1.1, 9, hull, { tex: 'solar-hull' });
  addBox(scene, world, 0, 6.85, 9.5, 32, 1.1, 9, hull, { tex: 'solar-hull' });
  addBox(scene, world, -12.5, 6.85, 0, 7, 1.1, 10, hull, { tex: 'solar-hull' });
  addBox(scene, world, 12, 6.85, 0, 8, 1.1, 10, hull, { tex: 'solar-hull' });
  addWallSide(0, 7.4, 0, 32, 28, 'west');
  addWallSide(0, 7.4, 0, 32, 28, 'east', 0);
  addWallSide(0, 7.4, 0, 32, 28, 'north', null,
    [{ center: 0, width: 29, bottom: 0.65, top: 5.6 }]);
  addWallSide(0, 7.4, 0, 32, 28, 'south');
  // Central roof with a ceiling airlock hatch (SE) so fights can spill onto the
  // outer decks instead of looping the two main interior rooms forever.
  const roofHatch = { x: 10, z: 9, halfW: 2.6, halfD: 2.6 };
  for (const [x, z, w, d] of [
    [0, -3.8, 32, 20.4],                                  // north of hatch
    [0, 12.8, 32, 2.4],                                   // south strip
    [-4.3, 9, 23.4, 5.2],                                 // west of hatch
    [14.3, 9, 3.4, 5.2],                                  // east of hatch
  ]) addBox(scene, world, x, 13.95, z, w, 0.7, d, hull, { tex: 'solar-hull' });
  // No raised collar around the hatch — a rim forced a hop to walk the roof.
  addMaintenanceLadder(roofHatch.x, roofHatch.z, 7.55, 14.55, 1, 0);
  addRamp(scene, world, {
    axis: 'x', minX: -8, maxX: 8, minZ: -5, maxZ: 5,
    h0: 0, h1: 7.4, color: 0xc7c9c3, tex: 'solar-hull',
  });

  // Purposeful room furniture: flare emitter cover is separate; map table, lab
  // bench, and bridge console stay waist-high so exits remain readable.
  // Central map table sits south of the ramp well (ramp occupies z −5..5).
  for (const [x, y, z, w, d, color] of [
    // West of the ramp well — keep cover off the x −8..8 / z −5..5 climb.
    [-10, 1.05, 8, 6, 4, 0x4b5965],
    [34, 1.05, 25, 9, 3, 0x365266], [42, 8.05, 3, 11, 3, 0x394f62],
  ]) addBox(scene, world, x, y, z, w, 2.1, d, color, { tex: 'solar-hull' });

  // Artificial gravity is full-strength inside pressurized modules. Crossing
  // a doorway onto a roof or passing through the aft energy curtain drops you
  // into the same low exterior field as Asteroid Belt.
  const solarExteriorGravity = 4.8; // match Asteroid Belt
  const solarInteriorZones = [
    // Central lower/upper, science, and bridge rooms.
    { minX: -15.5, maxX: 15.5, minY: -0.1, maxY: 13.6, minZ: -13.5, maxZ: 13.5 },
    { minX: 22.5, maxX: 45.5, minY: -0.1, maxY: 6.4, minZ: 14.5, maxZ: 35.5 },
    { minX: 29.5, maxX: 54.9, minY: 7.3, maxY: 13.6, minZ: -11.5, maxZ: 11.5 },
    { minX: 35.5, maxX: 48.5, minY: 7.3, maxY: 13.6, minZ: 20.5, maxZ: 29.5 },
    // Fully enclosed connector tubes and the L-shaped science junction.
    { minX: 5.3, maxX: 10.7, minY: -0.1, maxY: 5.3, minZ: 13.5, maxZ: 29 },
    { minX: 8.5, maxX: 22.5, minY: -0.1, maxY: 5.3, minZ: 22.3, maxZ: 27.7 },
    { minX: 15.5, maxX: 29.5, minY: 7.3, maxY: 13.0, minZ: -2.7, maxZ: 2.7 },
    { minX: 39.3, maxX: 44.7, minY: 7.3, maxY: 13.0, minZ: 11.5, maxZ: 20.5 },
  ];
  world.gravityAt = (pos) => solarInteriorZones.some((zone) =>
    pos.x >= zone.minX && pos.x <= zone.maxX &&
    pos.y >= zone.minY && pos.y <= zone.maxY &&
    pos.z >= zone.minZ && pos.z <= zone.maxZ)
    ? world.gravity : solarExteriorGravity;

  // Shuttle-bay-style atmospheric curtain: completely non-solid, luminous,
  // and placed in the upper aft opening leading directly onto the outer hull.
  const fieldCanvas = document.createElement('canvas');
  fieldCanvas.width = fieldCanvas.height = 256;
  const fg = fieldCanvas.getContext('2d');
  const fieldGrad = fg.createLinearGradient(0, 0, 0, 256);
  fieldGrad.addColorStop(0, 'rgba(175,250,255,.35)');
  fieldGrad.addColorStop(0.5, 'rgba(45,215,255,.68)');
  fieldGrad.addColorStop(1, 'rgba(95,125,255,.38)');
  fg.fillStyle = fieldGrad; fg.fillRect(0, 0, 256, 256);
  fg.strokeStyle = 'rgba(225,255,255,.48)'; fg.lineWidth = 2;
  for (let y = 12; y < 256; y += 20) { fg.beginPath(); fg.moveTo(0, y); fg.lineTo(256, y + 5); fg.stroke(); }
  const fieldTex = new THREE.CanvasTexture(fieldCanvas);
  fieldTex.wrapS = fieldTex.wrapT = THREE.RepeatWrapping;
  // Air curtains: aft hull exit, science-roof side exit, and the new central
  // ceiling hatch. Indoor connector doorways stay clear.
  const energyField = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 5.25),
    new THREE.MeshBasicMaterial({ map: fieldTex, transparent: true, opacity: 0.72, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }));
  energyField.rotation.y = Math.PI / 2;
  energyField.position.set(55.08, 10.025, 0);
  const roofEnergyField = energyField.clone();
  roofEnergyField.material = energyField.material.clone();
  roofEnergyField.position.set(34.92, 10.025, 25);
  const ceilingEnergyField = energyField.clone();
  ceilingEnergyField.material = energyField.material.clone();
  ceilingEnergyField.rotation.set(-Math.PI / 2, 0, 0);
  ceilingEnergyField.position.set(roofHatch.x, 13.95, roofHatch.z);
  scene.add(energyField, roofEnergyField, ceilingEnergyField);
  for (const [x, y, z] of [[53, 10.1, 0], [37, 10.1, 25], [roofHatch.x, 12.2, roofHatch.z]]) {
    const fieldLight = new THREE.PointLight(cool, 8, 16);
    fieldLight.position.set(x, y, z);
    scene.add(fieldLight);
  }
  for (const [x, y, z, color] of [
    // Central lower light mounts under the south lip of the upper deck — the
    // ramp well has no ceiling at (0,0), so a bar there just floated in space.
    [0, 6.2, 5.55, 0xffb34c],
    [34, 5.7, 25, 0x58ddff], [0, 12.7, 0, 0x58ddff],
    [42, 12.7, 0, 0xffa63d],
  ]) {
    addBox(scene, world, x, y, z, 5.5, 0.12, 0.28, color, {
      collide: false, shadow: false, emissive: color, emissiveIntensity: 1.5,
    });
    const light = new THREE.PointLight(color, 5.5, 15);
    light.position.set(x, y - 0.8, z);
    scene.add(light);
  }

  // The end module opens through its air curtain onto an irregular exterior
  // hull chain rather than the roof of one giant rectangle. A raised hull sill
  // runs through the doorway at top 7.45 — proud of the dark bridge floor
  // (7.4) — so the curtain is one continuous walk surface visually and for
  // collision; the floor's east face stays buried under the sill.
  for (const [x, z, w, d] of [[63.5, 0, 17, 12], [75, 8, 18, 16], [88, 0, 20, 18]])
    addBox(scene, world, x, 7.0, z, w, 0.9, d, hull, { tex: 'solar-hull' }); // top 7.45
  addBox(scene, world, 54.5, 7.0, 0, 5.5, 0.9, 5.5, hull, { tex: 'solar-hull' }); // through curtain
  // Science-roof curtain: relay deck 7.4 → roof walk 6.9. The relay floor's
  // west face begins at x=35, so the ramp must reach full height there; letting
  // it keep climbing inside the floor leaves a vertical lip at the doorway.
  addRamp(scene, world, {
    axis: 'x', minX: 32.3, maxX: 35, minZ: 22.6, maxZ: 27.4,
    h0: 6.9, h1: 7.4, color: 0xc7c9c3, tex: 'solar-hull',
  });
  const sensorDishR = 5.2;
  const sensorDishTube = 0.35;
  const sensorDishArc = Math.PI * 1.35;
  const sensorDish = new THREE.Mesh(
    new THREE.TorusGeometry(sensorDishR, sensorDishTube, 8, 48, sensorDishArc),
    mat(0xb6c9d1, { metalness: 0.55, roughness: 0.28 }),
  );
  sensorDish.position.set(88, 13.2, 0);
  sensorDish.rotation.set(0.4, -0.7, 0.3);
  sensorDish.castShadow = sensorDish.receiveShadow = true;
  scene.add(sensorDish);
  // Approximate the tube with overlapping spheres so the arc is solid cover.
  sensorDish.updateMatrixWorld(true);
  {
    const along = new THREE.Vector3();
    const segs = 16;
    const hitR = sensorDishTube + 0.2;
    for (let i = 0; i <= segs; i++) {
      const u = (i / segs) * sensorDishArc;
      along.set(sensorDishR * Math.cos(u), sensorDishR * Math.sin(u), 0)
        .applyMatrix4(sensorDish.matrixWorld);
      world.colliders.push({ type: 'sphere', center: along.clone(), radius: hitR });
    }
  }

  // Flare emitter sits south of the central ramp (which owns x −8..8, z −5..5).
  // The actual sun is a colossal environmental body off the port side.
  addBox(scene, world, 0, 1.6, 11, 8, 3.2, 6, 0x34384a, { tex: 'panel' });
  const sunRadius = 394; // 315 × 1.25
  const solarW = 4096;
  const solarH = 2048;
  const solarCanvas = document.createElement('canvas');
  solarCanvas.width = solarW;
  solarCanvas.height = solarH;
  const sg = solarCanvas.getContext('2d');
  sg.imageSmoothingEnabled = true;
  sg.imageSmoothingQuality = 'high';
  const solarGradient = sg.createLinearGradient(0, 0, 0, solarH);
  solarGradient.addColorStop(0, '#ffc84a');
  solarGradient.addColorStop(0.35, '#ff9a1c');
  solarGradient.addColorStop(0.62, '#ff6a0c');
  solarGradient.addColorStop(1, '#b82e04');
  sg.fillStyle = solarGradient;
  sg.fillRect(0, 0, solarW, solarH);
  const solarRnd = seededRandom(0x501af1a7);
  // Broad soft convection cells — keeps the disc from reading as flat paint.
  for (let i = 0; i < 90; i++) {
    const x = solarRnd() * solarW;
    const y = solarRnd() * solarH;
    const r = 60 + solarRnd() * 220;
    const cell = sg.createRadialGradient(x, y, 0, x, y, r);
    if (solarRnd() > 0.45) {
      cell.addColorStop(0, `rgba(255,236,140,${0.1 + solarRnd() * 0.18})`);
      cell.addColorStop(0.55, `rgba(255,170,40,${0.04 + solarRnd() * 0.08})`);
      cell.addColorStop(1, 'rgba(255,140,20,0)');
    } else {
      cell.addColorStop(0, `rgba(160,40,0,${0.08 + solarRnd() * 0.14})`);
      cell.addColorStop(0.55, `rgba(190,55,0,${0.04 + solarRnd() * 0.07})`);
      cell.addColorStop(1, 'rgba(140,30,0,0)');
    }
    sg.fillStyle = cell;
    sg.beginPath(); sg.ellipse(x, y, r, r * (0.55 + solarRnd() * 0.35), solarRnd() * Math.PI, 0, Math.PI * 2); sg.fill();
  }
  sg.lineCap = 'round';
  sg.lineJoin = 'round';
  // Medium plasma filaments.
  for (let i = 0; i < 4200; i++) {
    const x = solarRnd() * solarW;
    const y = solarRnd() * solarH;
    const len = 28 + solarRnd() * 140;
    const bend = (solarRnd() - 0.5) * 70;
    sg.strokeStyle = solarRnd() > 0.5
      ? `rgba(255,244,154,${0.06 + solarRnd() * 0.22})`
      : `rgba(105,18,0,${0.04 + solarRnd() * 0.14})`;
    sg.lineWidth = 1.2 + solarRnd() * 4.5;
    sg.beginPath();
    sg.moveTo(x, y);
    sg.quadraticCurveTo(x + len * 0.48, y + bend, x + len, y + bend * 0.25);
    sg.stroke();
  }
  // Fine granulation — reads sharp even when the sun fills half the frame.
  for (let i = 0; i < 9000; i++) {
    const x = solarRnd() * solarW;
    const y = solarRnd() * solarH;
    const len = 6 + solarRnd() * 28;
    const bend = (solarRnd() - 0.5) * 14;
    sg.strokeStyle = solarRnd() > 0.55
      ? `rgba(255,250,190,${0.04 + solarRnd() * 0.12})`
      : `rgba(70,10,0,${0.03 + solarRnd() * 0.1})`;
    sg.lineWidth = 0.4 + solarRnd() * 1.4;
    sg.beginPath();
    sg.moveTo(x, y);
    sg.quadraticCurveTo(x + len * 0.5, y + bend, x + len, y + bend * 0.2);
    sg.stroke();
  }
  for (let i = 0; i < 48; i++) {
    const x = solarRnd() * solarW;
    const y = solarH * 0.08 + solarRnd() * solarH * 0.84;
    const rx = 14 + solarRnd() * 52;
    const spot = sg.createRadialGradient(x, y, 0, x, y, rx);
    spot.addColorStop(0, 'rgba(45,4,0,.78)');
    spot.addColorStop(0.45, 'rgba(105,18,0,.42)');
    spot.addColorStop(1, 'rgba(125,22,0,0)');
    sg.fillStyle = spot;
    sg.beginPath(); sg.ellipse(x, y, rx, rx * 0.48, solarRnd() * Math.PI, 0, Math.PI * 2); sg.fill();
  }
  const solarTexture = new THREE.CanvasTexture(solarCanvas);
  solarTexture.colorSpace = THREE.SRGBColorSpace;
  solarTexture.anisotropy = 8;
  solarTexture.generateMipmaps = true;
  solarTexture.minFilter = THREE.LinearMipmapLinearFilter;
  solarTexture.magFilter = THREE.LinearFilter;
  const sunCore = new THREE.Mesh(new THREE.SphereGeometry(sunRadius, 128, 80),
    new THREE.MeshBasicMaterial({ map: solarTexture, color: 0xffffff, toneMapped: false }));
  // Parked well clear of the sunward PV wing (~z −61); prior (−300,75,−340)
  // with radius 394 intersected the tip hub/blankets.
  sunCore.position.set(-420, 90, -490);
  scene.add(sunCore);
  const corona = new THREE.Mesh(new THREE.SphereGeometry(sunRadius * 1.086, 96, 56),
    new THREE.MeshBasicMaterial({
      color: 0xff6818, transparent: true, opacity: 0.16, side: THREE.FrontSide,
      depthWrite: false, toneMapped: false,
    }));
  corona.position.copy(sunCore.position);
  scene.add(corona);
  const sunLight = new THREE.DirectionalLight(0xff8a32, 4.8);
  sunLight.position.copy(sunCore.position).add(V(0, 40, 0));
  sunLight.target.position.set(0, 0, 0);
  scene.add(sunLight);
  scene.add(sunLight.target);
  // Touch the photosphere and you are gone.
  world.killSpheres = [{
    center: sunCore.position, radius: sunRadius,
    name: 'The Sun', color: '#ff8a24',
  }];

  // Roof photovoltaic inlays sit flush with each deck top — no walkable lips.
  // (floorTop is the walkable surface; the thin plate is inset to avoid z-fight.)
  const pvInlayMat = mat(0x173c71, {
    emissive: 0x092050, emissiveIntensity: 0.65, metalness: 0.65, roughness: 0.28,
  });
  for (const [x, floorTop, z, w, d] of [
    [29, 6.9, 29, 6, 5], [4, 14.3, 8, 6, 5], [75, 7.2, 8, 5, 6],
  ]) {
    const h = 0.06;
    const panel = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), pvInlayMat);
    panel.position.set(x, floorTop - h / 2 - 0.02, z);
    panel.receiveShadow = true;
    scene.add(panel);
  }
  for (const [x, y, z, w, d] of [
    [6, 1.3, -7, 5, 3], [38, 1.3, 29, 4, 5],
    [-7, 8.6, 7, 4, 5], [45, 8.6, 4, 3, 4],
    [25, 8.2, 21, 4, 3],
    [-8, 15.6, 7, 4, 3], [47, 15.6, 5, 4, 3], [88, 8.7, 4, 4, 4],
  ]) addBox(scene, world, x, y, z, w, 2.6, d, 0x425468, { tex: 'solar-hull' });

  // Diagonal solar arm: 45° up and sunward from the central upper roof, with a
  // giant PV wing mounted at the tip (ISS-style boom + blanket array).
  const pvCellCanvas = document.createElement('canvas');
  pvCellCanvas.width = pvCellCanvas.height = 256;
  const pvg = pvCellCanvas.getContext('2d');
  pvg.fillStyle = '#0d2a58'; pvg.fillRect(0, 0, 256, 256);
  pvg.strokeStyle = 'rgba(70,160,220,.55)'; pvg.lineWidth = 2;
  for (let i = 0; i <= 256; i += 32) {
    pvg.beginPath(); pvg.moveTo(i, 0); pvg.lineTo(i, 256); pvg.stroke();
    pvg.beginPath(); pvg.moveTo(0, i); pvg.lineTo(256, i); pvg.stroke();
  }
  pvg.fillStyle = 'rgba(40,190,255,.14)';
  for (let y = 4; y < 256; y += 32) for (let x = 4; x < 256; x += 32)
    pvg.fillRect(x, y, 24, 24);
  pvg.fillStyle = 'rgba(255,180,80,.2)';
  pvg.fillRect(0, 124, 256, 8);
  const pvCellTex = new THREE.CanvasTexture(pvCellCanvas);
  pvCellTex.colorSpace = THREE.SRGBColorSpace;
  pvCellTex.wrapS = pvCellTex.wrapT = THREE.RepeatWrapping;
  const armAng = Math.PI / 4;
  const armLen = 54;
  const armRun = armLen * Math.cos(armAng);
  const armRise = armLen * Math.sin(armAng);
  // Hinge on the north lip of the central upper roof (station center module).
  // Approach pad top is flush with the ramp start; hinge blocks sit to the sides.
  const armRoot = V(0, 15.4, -13.5);
  const armTip = V(0, armRoot.y + armRise, armRoot.z - armRun);
  addBox(scene, world, 0, 14.85, -11.5, 10, 1.1, 5, 0x425468, { tex: 'solar-hull' });
  for (const sx of [-3.4, 3.4])
    addBox(scene, world, sx, 16.05, -13.2, 2.6, 2.8, 3.6, 0x5a6570, { tex: 'solar-hull' });
  // Thick structural boom (visual) under the walkable ramp spine.
  const boomMat = mat(0x8a9298, { roughness: 0.38, metalness: 0.72 });
  const boomCore = new THREE.Mesh(
    solarCylinderBetween(armRoot.clone().add(V(0, -0.9, 0)), armTip.clone().add(V(0, -0.9, 0)), 1.35, 10),
    boomMat,
  );
  boomCore.castShadow = boomCore.receiveShadow = true;
  scene.add(boomCore);
  for (const dx of [-1.55, 1.55]) {
    const rail = new THREE.Mesh(
      solarCylinderBetween(armRoot.clone().add(V(dx, 0.15, 0)), armTip.clone().add(V(dx, 0.15, 0)), 0.22, 7),
      boomMat,
    );
    rail.castShadow = true;
    scene.add(rail);
  }
  // Walkable 45° spine — players climb the arm itself.
  addRamp(scene, world, {
    axis: 'z',
    minX: -2.4, maxX: 2.4,
    minZ: armTip.z, maxZ: armRoot.z,
    h0: armTip.y, h1: armRoot.y,
    color: 0xb8bcc0, tex: 'solar-hull',
  });
  // Ring trusses along the boom so it reads as a heavy station arm.
  const boomDir = V(0, armRise, -armRun).normalize();
  for (let i = 1; i <= 4; i++) {
    const t = i / 5;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.05, 0.18, 6, 20), boomMat);
    ring.position.set(0, armRoot.y + armRise * t - 0.9, armRoot.z - armRun * t);
    ring.quaternion.setFromUnitVectors(V(0, 0, 1), boomDir);
    scene.add(ring);
  }
  // Tip hub + giant lateral solar wing. Hub sits entirely sunward of the ramp
  // tip so the climb lands flush on the deck instead of hitting a wall.
  const hubY = armTip.y;
  const hubDepth = 9;
  const hubZ = armTip.z - hubDepth / 2;
  addBox(scene, world, 0, hubY - 0.45, hubZ, 8, 0.9, hubDepth, 0x425468, { tex: 'solar-hull' });
  // Beacon on the far sunward end — clear of the arrival lip.
  addBox(scene, world, 0, hubY + 0.9, armTip.z - hubDepth + 1.8, 2.8, 1.8, 2.8, 0x5a6570, { tex: 'solar-hull' });
  addBox(scene, world, 0, hubY + 2.0, armTip.z - hubDepth + 1.8, 1.4, 0.22, 1.4, cool, {
    collide: false, shadow: false, emissive: cool, emissiveIntensity: 1.5,
  });
  // Cross-spar carrying the PV blankets.
  addBox(scene, world, 0, hubY - 0.45, hubZ, 52, 0.9, 2.4, 0x6a7580, { tex: 'solar-hull' });
  const addPvBlanket = (x, y, z, w, d, repeatX, repeatZ) => {
    const cellMap = pvCellTex.clone();
    cellMap.needsUpdate = true;
    cellMap.repeat.set(repeatX, repeatZ);
    const blanket = new THREE.Mesh(
      new THREE.BoxGeometry(w, 0.55, d),
      mat(0x163a72, {
        map: cellMap,
        emissive: 0x071a40, emissiveIntensity: 0.6, metalness: 0.55, roughness: 0.3,
      }),
    );
    // Slight sunward tilt so the wing reads as an array, not a roof tile.
    blanket.position.set(x, y, z);
    blanket.rotation.x = -0.18;
    blanket.castShadow = blanket.receiveShadow = true;
    scene.add(blanket);
    world.colliders.push({
      type: 'box',
      min: V(x - w / 2, hubY - 0.45, z - d / 2 - 0.2),
      max: V(x + w / 2, hubY + 0.55, z + d / 2 + 0.2),
    });
  };
  // Keep blankets on the hub footprint only — no overhang back over the ramp.
  for (const x of [-18, 18]) addPvBlanket(x, hubY + 0.05, hubZ, 20, 8, 6, 4);
  for (const x of [-30, 30]) addPvBlanket(x, hubY + 0.1, hubZ - 0.5, 12, 7, 3, 3);
  // The flare is a physical-looking plasma tentacle from the nearby sun, not
  // a rotating arena laser. It snakes across the void and terminates at the
  // exterior hull's aft emitter.
  const strikePoint = V(75, 9.2, 8);
  const towardStation = strikePoint.clone().sub(sunCore.position).normalize();
  const flareStart = sunCore.position.clone().addScaledVector(towardStation, sunRadius * 0.97);
  const flareCurve = new THREE.CatmullRomCurve3([
    flareStart,
    flareStart.clone().lerp(strikePoint, 0.24).add(V(12, 24, -8)),
    flareStart.clone().lerp(strikePoint, 0.48).add(V(-18, -12, 20)),
    flareStart.clone().lerp(strikePoint, 0.72).add(V(15, 16, -12)),
    strikePoint,
  ]);
  const flareGlowMat = new THREE.MeshBasicMaterial({
    color: 0xff2108, transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending, toneMapped: false,
  });
  const flareCoreMat = new THREE.MeshBasicMaterial({
    color: 0xffc04a, transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending, toneMapped: false,
  });
  const flareGlow = new THREE.Mesh(new THREE.TubeGeometry(flareCurve, 72, 7.5, 8, false), flareGlowMat);
  const flareCore = new THREE.Mesh(new THREE.TubeGeometry(flareCurve, 72, 2.8, 8, false), flareCoreMat);
  scene.add(flareGlow, flareCore);
  const flareBranches = [];
  for (const [offset, bend] of [[V(8, 0, 7), V(14, 10, -2)], [V(-9, 2, 5), V(-12, -4, 9)], [V(5, 5, -8), V(8, 13, -10)]]) {
    const end = strikePoint.clone().add(offset);
    const curve = new THREE.CatmullRomCurve3([
      flareCurve.getPoint(0.68), flareCurve.getPoint(0.83).add(bend), end,
    ]);
    const branch = new THREE.Mesh(new THREE.TubeGeometry(curve, 28, 1.25, 6, false), flareCoreMat.clone());
    scene.add(branch);
    flareBranches.push(branch);
  }
  const impactLight = new THREE.PointLight(0xff3518, 0, 180);
  impactLight.position.copy(strikePoint).add(V(0, 5, 0));
  scene.add(impactLight);
  const baseBackground = scene.background.clone();
  const flashBackground = new THREE.Color(0xffd0a8);
  const calmSunTint = new THREE.Color(0xffffff);
  const warningSunTint = new THREE.Color(0xff5530);
  const calmCoronaTint = new THREE.Color(0xff6818);
  const warningCoronaTint = new THREE.Color(0xff174d);
  const calmSunLightTint = new THREE.Color(0xff8a32);
  const warningSunLightTint = new THREE.Color(0xff3b20);
  let struckCycle = -1;
  world.anim.push((dt, t, characters) => {
    const CYCLE = 70;
    const cycle = Math.floor(t / CYCLE);
    const local = t % CYCLE;
    const striking = local >= 32 && local < 36;
    const impact = local >= 34 && local < 35.2;
    // The sun itself is the countdown. It visibly reddens and becomes more
    // violent for seven seconds before the strike, then cools after impact.
    const warningHeat = local < 34
      ? THREE.MathUtils.smoothstep(local, 27, 34)
      : 1 - THREE.MathUtils.smoothstep(local, 35.2, 38);
    sunCore.rotation.y += dt * 0.007;
    sunCore.rotation.x = Math.sin(t * 0.05) * 0.025;
    sunCore.material.color.lerpColors(calmSunTint, warningSunTint, warningHeat);
    corona.material.color.lerpColors(calmCoronaTint, warningCoronaTint, warningHeat);
    sunLight.color.lerpColors(calmSunLightTint, warningSunLightTint, warningHeat);
    sunLight.intensity = 4.8 + warningHeat * 2.4;
    corona.scale.setScalar(1.01 + Math.sin(t * (1.7 + warningHeat * 2.8)) * (0.025 + warningHeat * 0.035));
    corona.material.opacity = 0.13 + Math.sin(t * 2.1) * 0.035 + warningHeat * 0.11;
    fieldTex.offset.y = (t * 0.13) % 1;
    energyField.material.opacity = 0.62 + Math.sin(t * 5.5) * 0.1;
    roofEnergyField.material.opacity = 0.62 + Math.sin(t * 5.5 + 1.6) * 0.1;
    ceilingEnergyField.material.opacity = 0.62 + Math.sin(t * 5.5 + 2.4) * 0.1;
    const charge = striking ? THREE.MathUtils.smoothstep(local, 32, 34) : 0;
    const fade = local >= 34 ? 1 - THREE.MathUtils.smoothstep(local, 34.3, 36) : 1;
    flareGlowMat.opacity = striking ? (0.16 + charge * 0.5) * fade : 0;
    flareCoreMat.opacity = striking ? (0.3 + charge * 0.7) * fade : 0;
    for (const branch of flareBranches) branch.material.opacity = striking ? charge * 0.72 * fade : 0;
    const flash = impact ? 1 - THREE.MathUtils.smoothstep(local, 34, 35.2) : 0;
    impactLight.intensity = flash * 520;
    scene.background.copy(baseBackground).lerp(flashBackground, flash * 0.72);
    world.cameraShake = impact ? Math.max(world.cameraShake || 0, flash) : Math.max(0, (world.cameraShake || 0) - dt * 2.2);
    if (local >= 34 && struckCycle !== cycle) {
      struckCycle = cycle;
      world.cameraShake = 1;
      world.onSolarFlareStrike?.();
      for (const ch of characters) {
        if (!ch?.alive) continue;
        const outside = (world.gravityAt?.(ch.pos, ch) ?? world.gravity) < world.gravity;
        if (!outside) continue;
        ch.vel.y = Math.max(ch.vel.y, 3.8);
        ch.grounded = false;
        world.onSolarFlareHit?.(ch);
      }
    }
  });

  // Indoor starts plus dedicated exterior hull spawns so bots actually contest
  // the flare-exposed arsenal instead of looping the pressurized rooms.
  world.spawns.blue.push(
    V(-8, 0.1, -8), V(-8, 0.1, 8), V(-8, 7.4, 8),
    V(0, 14.5, -8), V(-8, 14.5, 8), V(5, 7.4, -8),
  );
  world.spawns.red.push(
    V(30, 0.1, 20), V(38, 0.1, 30), V(45, 7.4, 4),
    V(63, 7.5, -3), V(75, 7.5, 8), V(88, 7.5, 3), V(28, 7.3, 30),
  );
  world.spawns.ffa.push(
    ...world.spawns.blue, ...world.spawns.red,
    V(0, 0.1, 8), V(8, 0.1, 8),
    V(56, 7.5, 0), V(70, 7.5, 0), V(82, 7.5, -2),
    V(0, 14.5, 0), V(0, hubY + 0.2, hubZ), V(70, 7.5, -12),
  );
  for (const [x, y, z] of [
    [-8, 0.1, -8], [-8, 0.1, 8], [0, 0.1, 0], [8, 0.1, 8],
    [8, 0.1, 14], [8, 0.1, 18], [8, 0.1, 22], [8, 0.1, 25],
    [13, 0.1, 25], [17, 0.1, 25], [22, 0.1, 25],
    [28, 0.1, 20], [34, 0.1, 25], [38, 0.1, 30],
    [0, 7.4, 0], [8, 7.4, 0], [16, 7.4, 0], [22, 7.4, 0],
    [29, 7.4, 0], [38, 7.4, 0], [46, 7.4, 0], [52, 7.5, 0],
    [42, 7.4, 12], [42, 7.4, 16], [42, 7.4, 20], [42, 7.4, 25],
    [35, 7.4, 25], [42, 7.0, 31], [42, 14.4, 29],
    // Exterior roof circuits + hull pads (dense enough for bot loot routes).
    [8, 6.3, 18], [8, 7.0, 25], [17, 6.3, 25],
    [24, 7.2, 28], [28, 7.3, 30], [32, 7.2, 26], [34, 7.3, 30],
    [-8, 14.5, 0], [0, 14.5, 0], [8, 14.5, 0],
    [0, 14.5, 8], [0, 14.5, -8], [-8, 14.5, 8], [8, 14.5, -8],
    // Ceiling airlock climb: upper deck → hatch → roof.
    [10, 7.5, 9], [10, 11.0, 9], [10, 14.5, 9], [10, 14.5, 12], [14, 14.5, 9],
    [22, 13.7, 0], [42, 14.4, 0], [42, 13.7, 16], [42, 14.4, 25],
    // Aft exterior pads through the air curtain.
    [56, 7.5, 0], [56, 7.5, 3], [56, 7.5, -3],
    [63, 7.5, 0], [63, 7.5, -4], [63, 7.5, 4],
    [70, 7.5, 0], [70, 7.5, 8], [75, 7.5, 4], [75, 7.5, 8], [75, 7.5, 12],
    [82, 7.5, 0], [88, 7.5, -4], [88, 7.5, 0], [88, 7.5, 4],
    // Solar-arm approach from the aft deck lip.
    [70, 7.5, -8], [70, 7.5, -12],
  ]) wp(world, x, y, z);
  for (const t of [0, 0.25, 0.5, 0.75, 1])
    wp(world, 0, armRoot.y + armRise * t, armRoot.z - armRun * t);
  wp(world, -18, hubY + 0.2, hubZ);
  wp(world, 18, hubY + 0.2, hubZ);
  wp(world, -30, hubY + 0.2, hubZ);
  wp(world, 30, hubY + 0.2, hubZ);
  world.manualLinks.push(
    [-8, 0.1, 0, 8, 7.4, 0],
    [42, 0.1, 25, 42, 7.4, 25],
    [42, 7.0, 31, 42, 14.4, 29],
    [28, 7.3, 30, 42, 7.4, 25],
    [32, 7.2, 26, 35, 7.4, 25],
    [-8, 14.5, 0, 8, 14.5, 0],
    [0, 14.5, 0, 0, 14.5, 8],
    [0, 14.5, 0, 0, 14.5, -8],
    [10, 7.5, 9, 10, 14.5, 9],
    [10, 14.5, 9, 10, 14.5, 12],
    [10, 14.5, 9, 0, 14.5, 8],
    [42, 14.4, 0, 42, 13.7, 16],
    [42, 13.7, 16, 42, 14.4, 25],
    [-8, 14.5, 0, armRoot.x, armRoot.y, armRoot.z],
    [8, 14.5, 0, armRoot.x, armRoot.y, armRoot.z],
    [0, 14.5, -8, armRoot.x, armRoot.y, armRoot.z],
    // Bridge interior → air curtain → aft hull (force the outdoor loot graph).
    [46, 7.4, 0, 52, 7.5, 0],
    [52, 7.5, 0, 56, 7.5, 0],
    [56, 7.5, 0, 63, 7.5, 0],
    [63, 7.5, 0, 70, 7.5, 0],
    [70, 7.5, 0, 75, 7.5, 8],
    [75, 7.5, 8, 88, 7.5, 0],
    [63, 7.5, 0, 70, 7.5, -8],
    [70, 7.5, -8, 70, 7.5, -12],
    // Upper roof hop onto the science exterior deck / aft pads.
    [8, 14.5, 0, 28, 7.3, 30],
    [42, 14.4, 0, 56, 7.5, 0],
  );
  // Lean loot: one pickup per room when possible, weapons split across inside
  // and outside. Secret Shot (blaster) is the default — never a floor drop.
  // Central lower / upper
  pk(world, 'weapon', -8, 0.2, 6, { weapon: 'scatter' });
  pk(world, 'ammo', -5, 0.2, 8, { weapon: 'scatter' });
  pk(world, 'health', 8, 0.2, -8);
  pk(world, 'silver', 12, 7.5, 0);
  // Science + L-junction
  pk(world, 'weapon', 34, 0.2, 28, { weapon: 'zooka' });
  pk(world, 'ammo', 30, 0.2, 20, { weapon: 'zooka' });
  pk(world, 'health', 8, 0.2, 25);
  // Bridge + relay
  pk(world, 'weapon', 42, 7.6, -6, { weapon: 'sidewinder' });
  pk(world, 'ammo', 40, 7.6, -4, { weapon: 'sidewinder' });
  pk(world, 'shield', 48, 7.6, 4);
  pk(world, 'weapon', 42, 7.6, 25, { weapon: 'parasite' });
  pk(world, 'ammo', 40, 7.6, 27, { weapon: 'parasite' });
  pk(world, 'star', 46, 7.6, 28, { hidden: true });
  // Exterior hull / roof (not the solar wing) — Pulsator + Gold on the main roof.
  pk(world, 'weapon', 10, 14.5, 12, { weapon: 'pulsar' });
  pk(world, 'ammo', 14, 14.5, 9, { weapon: 'pulsar' });
  pk(world, 'gold', -10, 14.5, -4);
  pk(world, 'weapon', 75, 7.3, 8, { weapon: 'whomper' });
  pk(world, 'ammo', 70, 7.3, 0, { weapon: 'whomper' });
  pk(world, 'health', 88, 7.3, 0);
  pk(world, 'star', 0, 14.5, -8, { hidden: true });
  // Solar wing — Hyperstrike climb reward only (do not add more here).
  pk(world, 'weapon', 0, hubY + 0.3, hubZ - 0.5, { weapon: 'hyper' });
  pk(world, 'ammo', -18, hubY + 0.3, hubZ - 0.5, { weapon: 'hyper' });
  pk(world, 'shield', 18, hubY + 0.3, hubZ - 0.5);
  mergeStatic(scene, world);
  return world;
}

/* ============== MAP 12 — MYCELIUM GROVE ===============================
   Moonlit mushroom forest with a waterfall-hidden cave, climbable tree
   villages, living bounce caps, and drifting bioluminescent spores. */
function addMyceliumSpores(scene, world) {
  const count = 84;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const seeds = [];
  const rnd = seededRandom(0x6d796365);
  const palette = [0x8fffe1, 0x85c8ff, 0xd99bff, 0xffd47d];
  for (let i = 0; i < count; i++) {
    const seed = {
      x: rnd() * 148 - 74,
      y: rnd() * 28 + 0.8,
      z: rnd() * 148 - 74,
      phase: rnd() * Math.PI * 2,
      speed: 0.18 + rnd() * 0.42,
    };
    seeds.push(seed);
    positions[i * 3] = seed.x;
    positions[i * 3 + 1] = seed.y;
    positions[i * 3 + 2] = seed.z;
    const color = new THREE.Color(palette[i % palette.length]);
    colors.set([color.r, color.g, color.b], i * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({
    size: 0.24,
    vertexColors: true,
    transparent: true,
    opacity: 0.82,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  const spores = new THREE.Points(geometry, material);
  scene.add(spores);
  world.anim.push((_dt, t) => {
    const p = geometry.attributes.position.array;
    for (let i = 0; i < count; i++) {
      const seed = seeds[i];
      const j = i * 3;
      p[j] = seed.x + Math.sin(t * seed.speed + seed.phase) * 1.4;
      p[j + 1] = 0.8 + ((seed.y + t * seed.speed * 2.2) % 28);
      p[j + 2] = seed.z + Math.cos(t * seed.speed * 0.82 + seed.phase) * 1.1;
    }
    geometry.attributes.position.needsUpdate = true;
    material.opacity = 0.72 + Math.sin(t * 0.7) * 0.1;
  });
}

function addMyceliumPatch(scene, world, count = 72) {
  const rnd = seededRandom(0x66756e67);
  const stemGeometry = new THREE.CylinderGeometry(0.14, 0.2, 1, 6, 1);
  const capGeometry = new THREE.SphereGeometry(1, 9, 5, 0, Math.PI * 2, 0, Math.PI / 2);
  const stemMaterial = new THREE.MeshStandardMaterial({ color: 0xc9d6c0, roughness: 0.86 });
  const capMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.62,
    emissive: 0x245d5a,
    emissiveIntensity: 0.55,
  });
  const stems = new THREE.InstancedMesh(stemGeometry, stemMaterial, count);
  const caps = new THREE.InstancedMesh(capGeometry, capMaterial, count);
  const capColors = [0x55dfbd, 0x7f8fff, 0xd56cff, 0xff8bb7, 0xffc65f];
  const matrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    let x;
    let z;
    do {
      x = rnd() * 146 - 73;
      z = rnd() * 146 - 73;
    } while ((Math.abs(x) < 18 && z < -20) || (Math.abs(x) < 9 && z < -46));
    const height = 0.55 + rnd() * 1.35;
    const radius = 0.26 + rnd() * 0.54;
    rotation.setFromAxisAngle(V(0, 1, 0), rnd() * Math.PI * 2);
    position.set(x, height / 2, z);
    scale.set(0.72 + rnd() * 0.38, height, 0.72 + rnd() * 0.38);
    matrix.compose(position, rotation, scale);
    stems.setMatrixAt(i, matrix);
    position.set(x, height, z);
    scale.set(radius, radius * (0.34 + rnd() * 0.14), radius);
    matrix.compose(position, rotation, scale);
    caps.setMatrixAt(i, matrix);
    caps.setColorAt(i, new THREE.Color(capColors[i % capColors.length]));
  }
  stems.instanceMatrix.needsUpdate = true;
  caps.instanceMatrix.needsUpdate = true;
  if (caps.instanceColor) caps.instanceColor.needsUpdate = true;
  stems.castShadow = stems.receiveShadow = true;
  caps.castShadow = caps.receiveShadow = true;
  scene.add(stems, caps);
  world.anim.push((_dt, t) => {
    capMaterial.emissiveIntensity = 0.48 + Math.sin(t * 1.35) * 0.16;
  });
}

function addMyceliumGrassTufts(scene, world, count = 9000) {
  const normal = new THREE.Vector3();
  const candidateNormal = new THREE.Vector3();
  const yaw = new THREE.Quaternion();
  const terrain = world.colliders.filter(c => c.type === 'triangleMesh'
    && c.debugName === 'faceted-asteroid');
  return addSoftMeadowGrass(scene, world, {
    count,
    tint: 0x294d38,
    seed: 0x67726173,
    name: 'mycelium-grass-tufts',
    attemptMultiplier: 18,
    place: ({ rnd, position, scale, orientation: grassOrientation, up }) => {
      const x = rnd() * 150 - 75;
      const z = rnd() * 150 - 75;
      // Broad overlapping noise bands make lush swaths and softer clearings
      // instead of distributing every tuft at the same visual density.
      const meadowDensity = THREE.MathUtils.clamp(
        0.84
        + Math.sin(x * 0.105 + z * 0.034) * 0.1
        + Math.sin(z * 0.083 - x * 0.027) * 0.08,
        0.62,
        0.99,
      );
      if (rnd() > meadowDensity) return false;
      // Preserve the clean water silhouette and the authored interior routes.
      const pond = ((x - 2) / 22) ** 2 + ((z + 35.5) / 17) ** 2 < 1;
      const hollowLogInterior = Math.abs(x) < 27 && Math.abs(z - 31) < 6.3;
      const scatterTunnelInterior = Math.abs(x + 52) < 7.2 && z > 14 && z < 60;
      const grottoInterior = Math.abs(x) < 12 && z < -47;
      const podiumClearing = Math.abs(x) < 8 && z > -21.2 && z < -10.8;
      if (pond || hollowLogInterior || scatterTunnelInterior || grottoInterior || podiumClearing) return false;
      if (world.myceliumTreeRoots?.some(root => (
        Math.hypot(x - root.x, z - root.z) < Math.max(1.1, root.radius * 0.42)
      ))) return false;
      if (world.colliders.some(c => c.debugName === 'mycelium-boulder' && (
        ((x - c.center.x) / (c.radii.x + 0.55)) ** 2
        + ((z - c.center.z) / (c.radii.z + 0.55)) ** 2 < 1
      ))) return false;

      let y = 0.025;
      normal.set(0, 1, 0);
      for (const collider of terrain) {
        const candidateY = triangleMeshSurfaceY(collider, x, z, candidateNormal);
        if (candidateY == null || candidateY < 0 || candidateY > 8.5 || candidateY <= y) continue;
        y = candidateY + 0.025;
        normal.copy(candidateNormal);
      }
      // Skip near-vertical facets; grass belongs on walkable soil, not cliffs.
      if (normal.y < 0.72) return false;
      position.set(x, y, z);
      grassOrientation.setFromUnitVectors(up, normal);
      yaw.setFromAxisAngle(up, rnd() * Math.PI * 2);
      grassOrientation.multiply(yaw);
      const size = 0.88 + rnd() * 0.38;
      scale.set(size * (0.9 + rnd() * 0.2), size, size * (0.9 + rnd() * 0.2));
      return true;
    },
  });
}

function addMyceliumLeafLitter(scene, world, count = 1100) {
  // A lightly folded diamond reads as a broad fallen leaf rather than another
  // grass blade. Instance variation supplies the irregular forest-floor mix.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0.026, 0,       // raised central vein
    0, 0, 0.3,
    0.18, 0, 0.035,
    0.035, 0, -0.25,
    -0.17, 0, -0.015,
  ], 3));
  // Keep the shared leaf geometry neutral so its brown/olive instance tint is
  // preserved instead of being multiplied by an absent (black) color stream.
  const leafVertexColors = new Float32Array(5 * 3);
  leafVertexColors.fill(1);
  geometry.setAttribute('color', new THREE.BufferAttribute(leafVertexColors, 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1]);
  geometry.computeVertexNormals();
  const material = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    side: THREE.DoubleSide,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  const leaves = new THREE.InstancedMesh(geometry, material, count);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const candidateNormal = new THREE.Vector3();
  const orientation = new THREE.Quaternion();
  const yaw = new THREE.Quaternion();
  const up = V(0, 1, 0);
  const rnd = seededRandom(0x6c656166);
  const palette = [
    0x9b6a36, 0xb47a3d, 0x7c4f34, 0xa45f45, 0x725047,
    0x7f6f3a, 0x665a35, 0x80516c,
  ];
  const terrain = world.colliders.filter(c => c.type === 'triangleMesh'
    && c.debugName === 'faceted-asteroid');
  const roots = world.myceliumTreeRoots || [];
  let placed = 0;
  let attempts = 0;
  while (placed < count && attempts++ < count * 16) {
    let x;
    let z;
    // Most leaf litter collects beneath and downwind of trees; the remainder
    // breaks up open grass without carpeting it uniformly.
    if (roots.length && rnd() < 0.62) {
      const root = roots[Math.floor(rnd() * roots.length)];
      const angle = rnd() * Math.PI * 2;
      const distance = root.radius * 0.46 + 0.7 + rnd() * 5.2;
      x = root.x + Math.cos(angle) * distance + 0.8;
      z = root.z + Math.sin(angle) * distance - 0.35;
    } else {
      x = rnd() * 148 - 74;
      z = rnd() * 148 - 74;
    }
    if (Math.abs(x) > 75 || Math.abs(z) > 75) continue;
    const pond = ((x - 2) / 22) ** 2 + ((z + 35.5) / 17) ** 2 < 1;
    const hollowLogInterior = Math.abs(x) < 27 && Math.abs(z - 31) < 6.3;
    const scatterTunnelInterior = Math.abs(x + 52) < 7.2 && z > 14 && z < 60;
    const grottoInterior = Math.abs(x) < 12 && z < -47;
    const podiumClearing = Math.abs(x) < 8 && z > -21.2 && z < -10.8;
    if (pond || hollowLogInterior || scatterTunnelInterior || grottoInterior || podiumClearing) continue;
    if (world.colliders.some(c => c.debugName === 'mycelium-boulder' && (
      ((x - c.center.x) / (c.radii.x + 0.25)) ** 2
      + ((z - c.center.z) / (c.radii.z + 0.25)) ** 2 < 1
    ))) continue;

    let y = 0.035;
    normal.set(0, 1, 0);
    for (const collider of terrain) {
      candidateNormal.set(0, 1, 0);
      const candidateY = triangleMeshSurfaceY(collider, x, z, candidateNormal);
      if (candidateY == null || candidateY < 0 || candidateY > 8.5 || candidateY <= y) continue;
      y = candidateY + 0.035;
      normal.copy(candidateNormal);
    }
    if (normal.y < 0.7) continue;
    position.set(x, y, z);
    orientation.setFromUnitVectors(up, normal);
    yaw.setFromAxisAngle(up, rnd() * Math.PI * 2);
    orientation.multiply(yaw);
    const leafSize = 0.48 + rnd() * 0.72;
    scale.set(leafSize * (0.72 + rnd() * 0.7), 1, leafSize);
    matrix.compose(position, orientation, scale);
    leaves.setMatrixAt(placed, matrix);
    leaves.setColorAt(placed, new THREE.Color(palette[Math.floor(rnd() * palette.length)]));
    placed++;
  }
  leaves.count = placed;
  leaves.instanceMatrix.needsUpdate = true;
  if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
  leaves.castShadow = leaves.receiveShadow = false;
  leaves.name = 'mycelium-fallen-leaf-litter';
  scene.add(leaves);
}

function addMyceliumFairyToads(scene, world) {
  const palettes = [
    { name: 'moonmint', body: 0x72d7aa, belly: 0xc8f3c7, accent: 0x9a7cff },
    { name: 'violetcap', body: 0xa780e8, belly: 0xe4c8ff, accent: 0x61f0cf },
    { name: 'roseglow', body: 0xe989b2, belly: 0xffd0d9, accent: 0xffd36c },
    { name: 'pondstar', body: 0x69bfe5, belly: 0xc5efff, accent: 0xf18bc6 },
    { name: 'ambermoss', body: 0xd6ad62, belly: 0xf5df9c, accent: 0x6fe0b7 },
    { name: 'limewish', body: 0x94cf68, belly: 0xdff2a8, accent: 0xc083ef },
    { name: 'coralspell', body: 0xdd806e, belly: 0xffc8a8, accent: 0x68dbe3 },
    { name: 'dreamblue', body: 0x758bdc, belly: 0xcbd4ff, accent: 0xff91b8 },
  ];
  const patternNames = ['spots', 'twin-stripe', 'mosaic', 'constellation'];
  const personalityProfiles = [
    // A few remain genuinely unhurried, while the other personalities cover
    // a much wider speed and jump range. The old sub-20cm pitter hops barely
    // lifted the model's feet and made every toad read as slow at a distance.
    { name: 'mosey', mode: 'walk', speed: 0.42, cycle: 1.18 },
    { name: 'patient-popper', mode: 'surprise', cycle: 3.8, hopStart: 0.7,
      hopDuration: 0.25, stepDistance: 2.4, hopHeight: 1.15 },
    { name: 'pitter-patter', mode: 'hop', cycle: 0.46, airTime: 0.62,
      stepDistance: 0.9, hopHeight: 0.46 },
    { name: 'big-bounder', mode: 'hop', cycle: 1.15, airTime: 0.72,
      stepDistance: 3.2, hopHeight: 1.55 },
    { name: 'excitable', mode: 'hop', cycle: 0.58, airTime: 0.68,
      stepDistance: 1.75, hopHeight: 0.82 },
    { name: 'wanderer', mode: 'walk', speed: 1.08, cycle: 0.72 },
  ];
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const shadowGeometry = new THREE.CircleGeometry(0.62, 12);
  const shadowMaterial = new THREE.MeshBasicMaterial({
    color: 0x06120f, transparent: true, opacity: 0.3, depthWrite: false,
  });
  const eyeMaterial = new THREE.MeshStandardMaterial({
    color: 0xf6efce, roughness: 0.6, emissive: 0x7869a6, emissiveIntensity: 0.12,
  });
  const pupilMaterial = new THREE.MeshBasicMaterial({ color: 0x10151c });
  const mouthMaterial = new THREE.MeshBasicMaterial({ color: 0x35243b });
  const makeBox = (parent, material, sx, sy, sz, x, y, z) => {
    const piece = new THREE.Mesh(unitBox, material);
    piece.scale.set(sx, sy, sz);
    piece.position.set(x, y, z);
    piece.castShadow = piece.receiveShadow = true;
    parent.add(piece);
    return piece;
  };

  const branchRoute = (a, b) => {
    const delta = b.clone().sub(a);
    const horizontalLength = Math.hypot(delta.x, delta.z);
    const forward = delta.clone().normalize();
    const right = V(delta.z / horizontalLength, 0, -delta.x / horizontalLength);
    const normal = forward.clone().cross(right).normalize();
    return { kind: 'branch', a, b, normal, length: delta.length(), closed: false };
  };
  const groundRoute = (a, b) => ({
    kind: 'ground', a, b, normal: V(0, 1, 0), length: a.distanceTo(b), closed: false,
  });
  const circleRoute = (x, y, z, radius, phase = 0, kind = 'platform') => ({
    kind, x, y, z, radius, phase, length: Math.PI * 2 * radius, closed: true,
  });
  const trunkRoute = (x, baseY, z, baseRadius, maxRadius, maxY, angle, arc = 0.42) => ({
    kind: 'trunk', x, baseY, z, baseRadius, maxRadius, maxY, angle, arc,
    length: Math.max(3, maxY - baseY
      + Math.abs(arc) * (baseRadius + maxRadius) * 0.5 + 1.2),
    closed: false,
  });
  const elderTrunkRoute = (x, baseY, z, topDeckY, maxY, angle, arc = 0.42) => {
    const baseRadius = 2.35;
    const renderedTopRadius = baseRadius * 0.72;
    const trunkTopY = topDeckY + 8;
    const maxFraction = THREE.MathUtils.clamp(
      (maxY - baseY) / Math.max(0.1, trunkTopY - baseY), 0, 1,
    );
    const maxRadius = THREE.MathUtils.lerp(baseRadius, renderedTopRadius, maxFraction);
    return trunkRoute(x, baseY, z, baseRadius, maxRadius, maxY, angle, arc);
  };

  // Ground, branch, cap, balcony, and trunk routes make the creatures feel
  // native to the whole playspace rather than confined to decorative pens.
  // Every authored normal faces upward or sideways; ceilings are intentionally
  // absent so a toad can climb a tree without ever becoming fully inverted.
  const routes = [
    groundRoute(V(-63, 0.12, 8), V(-44, 0.12, 8)),
    groundRoute(V(44, 0.12, 10), V(64, 0.12, 12)),
    groundRoute(V(-28, 0.12, 61), V(-10, 0.12, 68)),
    groundRoute(V(10, 0.12, 67), V(31, 0.12, 59)),
    groundRoute(V(-28, 0.12, -14), V(-8, 0.12, -10)),
    branchRoute(V(-34.5, 7.08, -4), V(-9, 7.95, 7.2)),
    branchRoute(V(9, 7.95, 7.2), V(34.5, 7.08, -3.2)),
    branchRoute(V(-28.5, 13.12, 44), V(26.5, 14.92, 43.1)),
    branchRoute(V(-21.5, 14.12, -35.4), V(-1.5, 15.9, -61)),
    circleRoute(-20, 14.08, 51, 2.55, 0.4, 'mushroom-cap'),
    circleRoute(0, 8.08, 8, 5.15, 1.2, 'tree-balcony'),
    elderTrunkRoute(-37, 0, -5, 14, 6.35, 0.15),
    elderTrunkRoute(37, 0, -4, 14, 6.3, 2.75, -0.38),
    elderTrunkRoute(-31, 0, 44, 13, 6.3, 1.2, 0.5),
    elderTrunkRoute(29, 0, 43, 15, 7.25, 3.65, -0.45),
    elderTrunkRoute(-23, 0, -34, 14, 6.35, 5.15, 0.4),
    elderTrunkRoute(0, 10, -63, 23, 15.35, 0.7, -0.42),
    trunkRoute(0, 0, 8, 9.6, 9.6, 7.25, 2.2, 0.32),
  ];

  const toads = [];
  routes.forEach((route, index) => {
    const palette = palettes[index % palettes.length];
    const pattern = patternNames[index % patternNames.length];
    const personality = personalityProfiles[index % personalityProfiles.length];
    const root = new THREE.Group();
    root.name = 'mycelium-fairy-toad';
    root.userData.palette = palette.name;
    root.userData.pattern = pattern;
    root.userData.personality = personality.name;
    root.userData.routeKind = route.kind;
    root.userData.allowUpsideDown = false;
    const model = new THREE.Group();
    root.add(model);

    const bodyMaterial = new THREE.MeshStandardMaterial({
      color: palette.body,
      roughness: 0.78,
      emissive: new THREE.Color(palette.body).multiplyScalar(0.28),
      emissiveIntensity: 0.18,
      flatShading: true,
    });
    const bellyMaterial = new THREE.MeshStandardMaterial({
      color: palette.belly, roughness: 0.82, flatShading: true,
    });
    const accentMaterial = new THREE.MeshStandardMaterial({
      color: palette.accent,
      roughness: 0.64,
      emissive: palette.accent,
      emissiveIntensity: 0.58,
      flatShading: true,
    });

    makeBox(model, bodyMaterial, 1.08, 0.5, 0.9, 0, 0.36, -0.08);
    makeBox(model, bodyMaterial, 1.2, 0.44, 0.58, 0, 0.48, 0.42);
    makeBox(model, bellyMaterial, 0.82, 0.27, 0.08, 0, 0.37, 0.72);
    const hindLegs = [
      makeBox(model, bodyMaterial, 0.55, 0.18, 0.5, -0.53, 0.16, -0.3),
      makeBox(model, bodyMaterial, 0.55, 0.18, 0.5, 0.53, 0.16, -0.3),
    ];
    const frontLegs = [
      makeBox(model, bellyMaterial, 0.28, 0.13, 0.38, -0.43, 0.12, 0.47),
      makeBox(model, bellyMaterial, 0.28, 0.13, 0.38, 0.43, 0.12, 0.47),
    ];
    const eyes = [];
    const pupils = [];
    for (const side of [-1, 1]) {
      eyes.push(makeBox(model, eyeMaterial, 0.24, 0.24, 0.23, side * 0.38, 0.78, 0.53));
      pupils.push(makeBox(model, pupilMaterial, 0.1, 0.11, 0.025, side * 0.38, 0.78, 0.66));
    }
    makeBox(model, mouthMaterial, 0.44, 0.035, 0.025, 0, 0.35, 0.735);

    if (pattern === 'spots') {
      for (const [x, z, size] of [[-0.3, -0.27, 0.18], [0.16, -0.3, 0.14], [0.34, 0.02, 0.12]]) {
        makeBox(model, accentMaterial, size, 0.035, size, x, 0.63, z);
      }
    } else if (pattern === 'twin-stripe') {
      makeBox(model, accentMaterial, 0.78, 0.035, 0.12, 0, 0.63, -0.27);
      makeBox(model, accentMaterial, 0.68, 0.035, 0.1, 0, 0.63, 0.04);
    } else if (pattern === 'mosaic') {
      for (const [x, z] of [[-0.3, -0.25], [0.05, -0.31], [0.31, -0.06], [-0.12, 0.08]]) {
        makeBox(model, accentMaterial, 0.16, 0.035, 0.13, x, 0.63, z);
      }
    } else {
      for (const [x, z, size] of [[-0.36, -0.2, 0.09], [-0.08, -0.34, 0.07], [0.2, -0.18, 0.1], [0.34, 0.08, 0.07], [-0.18, 0.1, 0.08]]) {
        makeBox(model, accentMaterial, size, 0.045, size, x, 0.64, z);
      }
    }

    const shadow = new THREE.Mesh(shadowGeometry, shadowMaterial);
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.018;
    shadow.renderOrder = 1;
    root.add(shadow);
    root.scale.setScalar(0.58 + (index % 5) * 0.055);
    scene.add(root);
    toads.push({
      root, model, shadow, hindLegs, frontLegs, eyes, pupils, route,
      personality: personality.name,
      behavior: personality.mode,
      hopping: personality.mode !== 'walk',
      speed: (personality.speed || 0) * (0.82 + (index % 3) * 0.24),
      hopPeriod: personality.cycle * (0.88 + (index % 3) * 0.1),
      hopHeight: (personality.hopHeight || 0) * (0.88 + (index % 4) * 0.16),
      stepDistance: (personality.stepDistance || 0) * (0.86 + (index % 3) * 0.2),
      airTime: personality.airTime || 0,
      hopStart: personality.hopStart || 0,
      hopDuration: personality.hopDuration || 0,
      offset: (index * 0.371) % 1,
      phase: (index * 0.217) % 1,
      lastNormal: V(0, 1, 0),
      touching: new WeakSet(),
    });
  });

  // Keep the three touch personalities evenly represented while hiding which
  // individual toad has which effect. A new map build gets a fresh shuffle;
  // multiplayer can reshuffle with its shared round timestamp so every client
  // agrees on the same toads.
  world.shuffleMyceliumToads = seed => {
    const personalities = shuffledToadPersonalities(toads.length, seed);
    toads.forEach((toad, index) => {
      toad.touchPersonality = personalities[index];
      toad.root.userData.touchPersonality = personalities[index];
      toad.touching = new WeakSet();
    });
    world.myceliumToadShuffleSeed = Number(seed) >>> 0;
    return personalities;
  };
  world.shuffleMyceliumToads(Math.floor(Math.random() * 0x100000000));

  const position = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const right = new THREE.Vector3();
  const wallNormal = new THREE.Vector3();
  const orientation = new THREE.Matrix4();
  const toadTouchPosition = new THREE.Vector3();
  const toadTouchTargets = [];
  const trunkSurfaceRadius = (route, y) => THREE.MathUtils.lerp(
    route.baseRadius,
    route.maxRadius,
    THREE.MathUtils.clamp((y - route.baseY) / Math.max(0.1, route.maxY - route.baseY), 0, 1),
  );
  const sampleGroundSurface = (x, z, outNormal) => {
    let surfaceY = 0;
    outNormal.set(0, 1, 0);
    // Follow the exact faceted hill collider used by players so the toads'
    // feet and shadows remain planted on the polygon that is actually drawn.
    for (const collider of world.colliders) {
      if (collider.type === 'triangleMesh') {
        const candidateY = triangleMeshSurfaceY(collider, x, z, wallNormal);
        if (candidateY == null || candidateY <= surfaceY || candidateY > 9) continue;
        surfaceY = candidateY;
        outNormal.copy(wallNormal);
        continue;
      }
      if (collider.type !== 'sphere' || collider.radius < 12) continue;
      const dx = x - collider.center.x;
      const dz = z - collider.center.z;
      const horizontalSq = dx * dx + dz * dz;
      if (horizontalSq >= collider.radius * collider.radius) continue;
      const candidateY = collider.center.y
        + Math.sqrt(collider.radius * collider.radius - horizontalSq);
      // Higher sphere faces belong to cliffs, cave roofs, or other authored
      // routes. Ground roamers only select the gentle understory terrain band.
      if (candidateY <= surfaceY || candidateY > 9) continue;
      surfaceY = candidateY;
      outNormal.set(dx, candidateY - collider.center.y, dz).normalize();
    }
    return surfaceY + 0.12;
  };
  const sampleRoute = (route, u, direction) => {
    if (route.kind === 'ground') {
      position.lerpVectors(route.a, route.b, u);
      position.y = sampleGroundSurface(position.x, position.z, normal);
      tangent.copy(route.b).sub(route.a).multiplyScalar(direction);
    } else if (route.kind === 'branch') {
      position.lerpVectors(route.a, route.b, u);
      normal.copy(route.normal);
      tangent.copy(route.b).sub(route.a).multiplyScalar(direction);
    } else if (route.kind === 'platform' || route.kind === 'mushroom-cap' || route.kind === 'tree-balcony') {
      const angle = route.phase + u * Math.PI * 2;
      position.set(route.x + Math.cos(angle) * route.radius, route.y, route.z + Math.sin(angle) * route.radius);
      normal.set(0, 1, 0);
      tangent.set(-Math.sin(angle), 0, Math.cos(angle));
    } else {
      const transitionEnd = 0.16;
      if (u < transitionEnd) {
        const raw = u / transitionEnd;
        const blend = raw * raw * (3 - 2 * raw);
        const angle = route.angle;
        wallNormal.set(Math.cos(angle), 0, Math.sin(angle));
        const y = route.baseY + 0.1 + blend * 0.72;
        const attachRadius = trunkSurfaceRadius(route, y) + 0.06 + (1 - blend) * 1.2;
        position.set(
          route.x + wallNormal.x * attachRadius,
          y,
          route.z + wallNormal.z * attachRadius,
        );
        normal.set(0, 1, 0).lerp(wallNormal, blend).normalize();
        tangent.set(-wallNormal.x * 1.2, 0.72, -wallNormal.z * 1.2).multiplyScalar(direction);
      } else {
        const climb = (u - transitionEnd) / (1 - transitionEnd);
        const angle = route.angle + route.arc * climb;
        const y = THREE.MathUtils.lerp(route.baseY + 0.82, route.maxY, climb);
        const attachRadius = trunkSurfaceRadius(route, y) + 0.06;
        wallNormal.set(Math.cos(angle), 0, Math.sin(angle));
        position.set(
          route.x + wallNormal.x * attachRadius,
          y,
          route.z + wallNormal.z * attachRadius,
        );
        normal.copy(wallNormal);
        tangent.set(
          -Math.sin(angle) * route.arc * attachRadius,
          route.maxY - route.baseY - 0.82,
          Math.cos(angle) * route.arc * attachRadius,
        ).multiplyScalar(direction);
      }
    }
    tangent.addScaledVector(normal, -tangent.dot(normal)).normalize();
  };

  const updateToads = (_dt, t, characters = []) => {
    // Reuse one human-only list so 18 toads do not each scan the full bot roster.
    toadTouchTargets.length = 0;
    for (const character of characters) {
      if (character?.pos && (character.isPlayer || character.remoteHuman)) {
        toadTouchTargets.push(character);
      }
    }
    for (const toad of toads) {
      const cycleProgress = t / toad.hopPeriod + toad.phase;
      const cycleIndex = Math.floor(cycleProgress);
      const gait = cycleProgress - cycleIndex;
      let hopPhase = 0;
      let airborne = false;
      let travelDistance;
      if (toad.behavior === 'walk') {
        travelDistance = t * toad.speed;
      } else if (toad.behavior === 'surprise') {
        const rawHop = (gait - toad.hopStart) / toad.hopDuration;
        const hopTravel = THREE.MathUtils.smoothstep(rawHop, 0, 1);
        travelDistance = (cycleIndex + hopTravel) * toad.stepDistance;
        airborne = rawHop >= 0 && rawHop <= 1;
        hopPhase = THREE.MathUtils.clamp(rawHop, 0, 1);
      } else {
        const rawHop = gait / toad.airTime;
        const hopTravel = THREE.MathUtils.smoothstep(rawHop, 0, 1);
        travelDistance = (cycleIndex + hopTravel) * toad.stepDistance;
        airborne = gait < toad.airTime;
        hopPhase = THREE.MathUtils.clamp(rawHop, 0, 1);
      }
      const routeProgress = travelDistance / toad.route.length + toad.offset;
      let u;
      let direction = 1;
      if (toad.route.closed) {
        u = routeProgress % 1;
      } else {
        const backAndForth = routeProgress % 2;
        direction = backAndForth <= 1 ? 1 : -1;
        u = backAndForth <= 1 ? backAndForth : 2 - backAndForth;
      }
      sampleRoute(toad.route, u, direction);
      toad.root.position.copy(position);
      toad.lastNormal.copy(normal);
      right.crossVectors(normal, tangent).normalize();
      orientation.makeBasis(right, normal, tangent);
      toad.root.quaternion.setFromRotationMatrix(orientation);

      if (toad.behavior !== 'walk') {
        const hop = airborne ? Math.sin(hopPhase * Math.PI) * toad.hopHeight : 0;
        const landingStart = toad.behavior === 'surprise'
          ? toad.hopStart + toad.hopDuration : toad.airTime;
        const landingPhase = THREE.MathUtils.clamp((gait - landingStart) / 0.12, 0, 1);
        const landing = gait >= landingStart && gait < landingStart + 0.12;
        const preJumpStart = toad.behavior === 'surprise' ? toad.hopStart - 0.08 : -1;
        const preJumpPhase = THREE.MathUtils.clamp((gait - preJumpStart) / 0.08, 0, 1);
        const preJump = toad.behavior === 'surprise'
          && gait >= preJumpStart && gait < toad.hopStart;
        const squash = landing ? Math.sin(landingPhase * Math.PI) * 0.14
          : preJump ? Math.sin(preJumpPhase * Math.PI / 2) * 0.16 : 0;
        const idleBreath = toad.behavior === 'surprise' && !airborne && !preJump && !landing
          ? (Math.sin(t * 1.25 + toad.phase * 13) + 1) * 0.008 : 0;
        toad.model.position.y = hop + idleBreath;
        toad.model.scale.set(1 + squash * 0.45, 1 - squash, 1 + squash * 0.3);
        for (const leg of toad.hindLegs) leg.rotation.x = airborne ? -0.5 * Math.sin(hopPhase * Math.PI) : 0;
        for (const leg of toad.frontLegs) leg.rotation.x = airborne ? 0.28 * Math.sin(hopPhase * Math.PI) : 0;
        toad.shadow.scale.setScalar(1 - Math.min(0.35, hop * 0.55));
        toad.model.rotation.y = toad.behavior === 'surprise' && !airborne
          ? Math.sin(t * 0.62 + toad.phase * 17) * 0.09 : 0;
      } else {
        const step = Math.sin(gait * Math.PI * 2);
        toad.model.position.y = 0.025 + Math.abs(step) * 0.035;
        toad.model.scale.set(1, 1, 1);
        toad.hindLegs[0].rotation.x = step * 0.24;
        toad.hindLegs[1].rotation.x = -step * 0.24;
        toad.frontLegs[0].rotation.x = -step * 0.18;
        toad.frontLegs[1].rotation.x = step * 0.18;
        toad.shadow.scale.setScalar(1);
        toad.model.rotation.y = step * 0.035;
      }
      const blinkCycle = (t * (0.38 + toad.phase * 0.06) + toad.phase * 5.7) % 1;
      const blinkScale = blinkCycle > 0.955 ? 0.22 : 1;
      for (const eye of toad.eyes) eye.scale.y = 0.24 * blinkScale;
      for (const pupil of toad.pupils) pupil.scale.y = 0.11 * blinkScale;

      if (!toadTouchTargets.length) continue;
      // Derive the moving model's center directly from its authored root. This
      // avoids forcing a scene-graph world-matrix update for every toad.
      toadTouchPosition.copy(toad.model.position)
        .multiply(toad.root.scale)
        .applyQuaternion(toad.root.quaternion)
        .add(toad.root.position);
      for (const character of toadTouchTargets) {
        if (!character.alive) {
          toad.touching.delete(character);
          continue;
        }
        const dx = character.pos.x - toadTouchPosition.x;
        const dz = character.pos.z - toadTouchPosition.z;
        const contactRadius = (character.radius ?? 0.45) + toad.root.scale.x * 0.82;
        const radiusSq = contactRadius * contactRadius;
        const horizontalSq = dx * dx + dz * dz;
        let touching = false;
        if (horizontalSq <= radiusSq) {
          const minY = character.pos.y - 0.18;
          const maxY = character.pos.y + (character.height ?? 1.8) + 0.18;
          const dy = toadTouchPosition.y < minY ? minY - toadTouchPosition.y
            : toadTouchPosition.y > maxY ? maxY - toadTouchPosition.y : 0;
          touching = horizontalSq + dy * dy <= radiusSq;
        }
        if (touching && !toad.touching.has(character)) {
          toad.touching.add(character);
          world.onToadTouch?.(character, toad);
        } else if (!touching) {
          toad.touching.delete(character);
        }
      }
    }
  };
  updateToads(0, 0);
  world.anim.push(updateToads);
  world.myceliumToads = toads;
}

function addBouncyMushroom(scene, world, x, baseY, z, stemHeight, radius, vy, color, vx = 0, vz = 0) {
  // The old launch speeds only cleared the first canopy tier by a narrow
  // margin. Raise the ballistic apex to about 70% over the original tuning;
  // this is only ~6.5% more velocity than the previous pass, so trajectories
  // gain useful landing margin without turning into vertical teleporters.
  const launchVy = vy * Math.sqrt(1.7);
  const stemMaterial = mat(0xdacbd2, { roughness: 0.8, flatShading: true });
  const capMaterial = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.5,
    metalness: 0.02,
    emissive: new THREE.Color(color),
    emissiveIntensity: 0.25,
    flatShading: true,
  });
  const undersideMaterial = new THREE.MeshStandardMaterial({
    color: 0xf2d8e8,
    roughness: 0.9,
    emissive: new THREE.Color(color),
    emissiveIntensity: 0.08,
    side: THREE.DoubleSide,
  });
  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.18, radius * 0.27, stemHeight, 10, 3),
    stemMaterial,
  );
  stem.position.set(x, baseY + stemHeight / 2, z);
  stem.castShadow = stem.receiveShadow = true;
  scene.add(stem);

  const cap = new THREE.Group();
  cap.position.set(x, baseY + stemHeight, z);
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(1, 22, 10, 0, Math.PI * 2, 0, Math.PI / 2),
    capMaterial,
  );
  dome.scale.set(radius, radius * 0.42, radius);
  dome.castShadow = dome.receiveShadow = true;
  const underside = new THREE.Mesh(new THREE.CircleGeometry(radius, 22), undersideMaterial);
  underside.rotation.x = -Math.PI / 2;
  underside.position.y = -0.015;
  cap.add(dome, underside);
  const spotGeometry = new THREE.SphereGeometry(1, 7, 5);
  const spotMaterial = new THREE.MeshBasicMaterial({ color: 0xfff4d8, toneMapped: false });
  for (let i = 0; i < 9; i++) {
    const angle = i * 2.39996;
    const spread = radius * (0.18 + (i % 4) * 0.16);
    const spot = new THREE.Mesh(spotGeometry, spotMaterial);
    spot.position.set(
      Math.cos(angle) * spread,
      Math.sqrt(Math.max(0, 1 - (spread * spread) / (radius * radius))) * radius * 0.42 + 0.02,
      Math.sin(angle) * spread,
    );
    spot.scale.setScalar(radius * (0.055 + (i % 3) * 0.018));
    cap.add(spot);
  }
  scene.add(cap);

  const topY = baseY + stemHeight + radius * 0.42;
  const stemRadius = radius * 0.23;
  world.colliders.push({
    type: 'box',
    min: V(x - stemRadius, baseY, z - stemRadius),
    max: V(x + stemRadius, baseY + stemHeight, z + stemRadius),
  });
  const bounce = { value: 0 };
  const pad = {
    x, y: topY, z,
    r: radius * 0.82,
    vy: launchVy, vx, vz,
    // Running into the living rim starts lower than landing on the dome. Give
    // that contact case a little extra lift so both approaches clear the same
    // destination edge reliably on the first trigger.
    contactVy: launchVy * 1.05,
    playersOnly: false,
    disabled: false,
    kind: 'mushroom',
    oneWay: true,
    contactBounce: true,
    contactRadius: radius * 0.95,
    contactMinY: baseY + stemHeight - radius * 0.16,
    contactMaxY: topY + radius * 0.24,
    sideImpulse: 4.2,
    cooldown: 0.36,
    onTrigger: () => { bounce.value = 1; },
  };
  world.jumpPads.push(pad);
  world.anim.push((dt, t) => {
    bounce.value = Math.max(0, bounce.value - dt * 2.7);
    const squash = Math.sin(bounce.value * Math.PI);
    cap.scale.y = 1 - squash * 0.3;
    cap.rotation.z = Math.sin(t * 1.1 + x * 0.03 + z * 0.05) * 0.025;
    capMaterial.emissiveIntensity = 0.2 + Math.sin(t * 2.2 + x) * 0.08 + squash * 0.35;
  });
  return { cap, pad, topY };
}

function addMyceliumBranch(scene, start, end, radius = 0.65) {
  const delta = end.clone().sub(start);
  const branch = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.72, radius, delta.length(), 8, 2),
    mat(0xffffff, { tex: 'canopy-bark', repeat: [1, Math.max(1, delta.length() / 6)], roughness: 0.96 }),
  );
  branch.quaternion.setFromUnitVectors(V(0, 1, 0), delta.clone().normalize());
  branch.position.copy(start).add(end).multiplyScalar(0.5);
  branch.castShadow = branch.receiveShadow = true;
  scene.add(branch);
}

// A branch route uses a broad, shallow bark plank as the visible bridge. Short
// overlapping collision cells follow that slope closely enough to walk while
// keeping the route grown-looking instead of turning it into a catwalk.
function addWalkableMyceliumBranch(scene, world, start, end, radius = 1.05, options = {}) {
  // These are primary traversal lanes, so make the usable limb substantially
  // broader than the decorative branch arms around each crown. The additional
  // 1.5 multiplier is the requested second widening pass.
  const walkRadius = radius * 1.58 * 1.5;
  const delta = end.clone().sub(start);
  const horizontalLength = Math.hypot(delta.x, delta.z);
  const plankWidth = walkRadius * 1.5;
  const plankBodyDepth = Math.max(0.7, walkRadius * 0.32);
  const crownDepth = Math.max(0.18, walkRadius * 0.1);
  const plankDepth = plankBodyDepth + crownDepth;

  // A shallow structural body replaces the old full-radius cylinder. Its cap
  // remains separately trimmable where a route merges into the hollow log, so
  // the junction stays clean without making the rest of the limb bulky.
  if (horizontalLength > 0.01) {
    const forward = delta.clone().normalize();
    const right = V(delta.z / horizontalLength, 0, -delta.x / horizontalLength);
    const up = forward.clone().cross(right).normalize();
    const orientation = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(right, up, forward),
    );
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(plankWidth, plankBodyDepth, delta.length()),
      mat(0xffffff, {
        tex: 'canopy-bark', repeat: [2, Math.max(1, delta.length() / 6)], roughness: 0.96,
      }),
    );
    body.quaternion.copy(orientation);
    body.position.copy(start).add(end).multiplyScalar(0.5)
      .addScaledVector(up, -crownDepth - plankBodyDepth / 2);
    body.name = options.debugName ? `${options.debugName}-body` : 'mycelium-branch-plank-body';
    body.castShadow = body.receiveShadow = true;
    scene.add(body);

    const matchingDeck = point => world.myceliumCanopyDecks?.find(deck => (
      Math.hypot(point.x - deck.x, point.z - deck.z) < 0.08
      && Math.abs(point.y - deck.y) < 0.08
    ));
    const startDeck = matchingDeck(start);
    const endDeck = matchingDeck(end);
    // Routes are authored center-to-center for pathfinding and collision. The
    // visible bark crown must begin at the circular balcony rim, though, or it
    // lies directly on the deck's top face and the two textures z-fight over a
    // large wedge. Leave the lower structural body and colliders overlapping
    // beneath the deck so the transition remains completely walkable.
    const seamGap = 0.04;
    const autoStartInset = startDeck ? startDeck.topRadius + seamGap : 0;
    const autoEndInset = endDeck ? endDeck.topRadius + seamGap : 0;
    const maxInset = Math.max(0, delta.length() - 0.2);
    const crownStartInset = Math.min(
      Math.max(0, options.crownStartInset ?? autoStartInset),
      maxInset,
    );
    const crownEndInset = Math.min(
      Math.max(0, options.crownEndInset ?? autoEndInset),
      maxInset - crownStartInset,
    );
    const crownLength = delta.length() - crownStartInset - crownEndInset;
    const crownStart = start.clone().addScaledVector(forward, crownStartInset);
    const crownEnd = crownStart.clone().addScaledVector(forward, crownLength);
    const crown = new THREE.Mesh(
      new THREE.BoxGeometry(plankWidth, crownDepth, crownLength),
      mat(0xffffff, {
        tex: 'canopy-bark', repeat: [2, Math.max(1, crownLength / 6)], roughness: 0.96,
      }),
    );
    crown.quaternion.copy(orientation);
    crown.position.copy(crownStart).add(crownEnd).multiplyScalar(0.5)
      .addScaledVector(up, -crownDepth / 2);
    crown.name = options.debugName || 'mycelium-branch-crown';
    crown.userData.routeStart = crownStart.toArray();
    crown.userData.routeEnd = crownEnd.toArray();
    crown.castShadow = crown.receiveShadow = true;
    scene.add(crown);
  }
  // The visible/supporting limb continues beneath each balcony, but bot route
  // nodes must stop on the walkable ring. A center-to-center route puts its
  // endpoint inside the solid trunk, where bots simply face the bark and keep
  // trying to reach an impossible node.
  const matchingRouteDeck = point => world.myceliumCanopyDecks?.find(deck => (
    Math.hypot(point.x - deck.x, point.z - deck.z) < 0.08
    && Math.abs(point.y - deck.y) < 0.08
  ));
  const startRouteDeck = matchingRouteDeck(start);
  const endRouteDeck = matchingRouteDeck(end);
  const forwardXZ = horizontalLength > 0.01
    ? V(delta.x / horizontalLength, 0, delta.z / horizontalLength)
    : V(1, 0, 0);
  const navStart = startRouteDeck
    ? V(
      startRouteDeck.x + forwardXZ.x * startRouteDeck.navRadius,
      start.y,
      startRouteDeck.z + forwardXZ.z * startRouteDeck.navRadius,
    )
    : start.clone();
  const navEnd = endRouteDeck
    ? V(
      endRouteDeck.x - forwardXZ.x * endRouteDeck.navRadius,
      end.y,
      endRouteDeck.z - forwardXZ.z * endRouteDeck.navRadius,
    )
    : end.clone();
  const navDelta = navEnd.clone().sub(navStart);
  const navHorizontalLength = Math.hypot(navDelta.x, navDelta.z);
  const steps = Math.max(2, Math.ceil(navHorizontalLength / 2.4));
  const stepX = navDelta.x / steps;
  const stepZ = navDelta.z / steps;
  let previousWaypoint = null;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = navStart.x + navDelta.x * t;
    const y = navStart.y + navDelta.y * t;
    const z = navStart.z + navDelta.z * t;
    world.colliders.push({
      type: 'box',
      min: V(x - Math.abs(stepX) * 0.62 - walkRadius * 0.48, y - plankDepth,
        z - Math.abs(stepZ) * 0.62 - walkRadius * 0.48),
      max: V(x + Math.abs(stepX) * 0.62 + walkRadius * 0.48, y,
        z + Math.abs(stepZ) * 0.62 + walkRadius * 0.48),
    });
    if (i % 2 === 0 || i === steps) {
      wp(world, x, y, z);
      if (previousWaypoint) world.manualLinks.push([
        previousWaypoint.x, previousWaypoint.y, previousWaypoint.z, x, y, z,
      ]);
      previousWaypoint = { x, y, z };
    }
  }
  const linkEndpointToDeckRing = (point, deck) => {
    if (!deck?.navPoints?.length) return;
    const nearest = deck.navPoints.reduce((best, candidate) => (
      Math.hypot(candidate[0] - point.x, candidate[2] - point.z)
        < Math.hypot(best[0] - point.x, best[2] - point.z) ? candidate : best
    ));
    world.manualLinks.push([point.x, point.y, point.z, ...nearest]);
  };
  linkEndpointToDeckRing(navStart, startRouteDeck);
  linkEndpointToDeckRing(navEnd, endRouteDeck);
}

function addPlatformMushroom(scene, world, x, topY, z, radius, color, seed = 0) {
  // Platform caps can stand over pond slopes and other uneven terrain. Sink
  // the stalk well below the lowest playable ground so its flat end is never
  // exposed when viewed from underwater or downhill.
  const stemBottomY = -6;
  const stemTopY = topY - 0.25;
  const stemHeight = Math.max(2.4, stemTopY - stemBottomY);
  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.2, radius * 0.31, stemHeight, 12, 3),
    mat(0xe1d2d9, { roughness: 0.86, flatShading: true }),
  );
  stem.position.set(x, (stemBottomY + stemTopY) / 2, z);
  stem.rotation.z = Math.sin(seed * 2.1) * 0.035;
  stem.castShadow = stem.receiveShadow = true;

  const capMaterial = new THREE.MeshStandardMaterial({
    color, roughness: 0.62, emissive: new THREE.Color(color), emissiveIntensity: 0.16,
    flatShading: true,
  });
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 0.9, radius, 0.82, 20, 2),
    capMaterial,
  );
  cap.position.set(x, topY - 0.41, z);
  cap.rotation.y = seed * 0.83;
  cap.castShadow = cap.receiveShadow = true;
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(1, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    capMaterial,
  );
  // Keep the visible dome apex exactly on the walkable collision plane.
  dome.position.set(x, topY - 0.5, z);
  dome.scale.set(radius * 0.97, 0.5, radius * 0.97);
  dome.castShadow = dome.receiveShadow = true;
  scene.add(stem, cap, dome);

  const stemRadius = radius * 0.26;
  // Match the broad visible top rather than only supporting its inner 78%.
  // A small amount of forgiving edge support is intentional: these caps are
  // landing targets reached at speed from directional bounce trajectories.
  const capSupportRadius = radius * 0.94;
  world.colliders.push(
    { type: 'box', min: V(x - stemRadius, stemBottomY, z - stemRadius), max: V(x + stemRadius, topY - 0.75, z + stemRadius) },
    {
      type: 'box',
      min: V(x - capSupportRadius, topY - 0.82, z - capSupportRadius),
      max: V(x + capSupportRadius, topY, z + capSupportRadius),
      debugName: 'mycelium-platform-mushroom-cap',
      visualRadius: radius,
      supportRadius: capSupportRadius,
    },
  );
  wp(world, x, topY, z);
  world.anim.push((_dt, t) => {
    capMaterial.emissiveIntensity = 0.13 + Math.sin(t * 0.75 + seed) * 0.045;
  });
  return { x, y: topY, z, radius };
}

// Climbable bracket fungi. Local +Z points away from the host surface, so yaw
// alone can plant an ascending cluster on a trunk, log wall, or rock face.
// A cylinder-X host lets each step follow the curved side of a horizontal log.
function addMyceliumShelfFungi(
  scene, world, x, y, z, yaw, scale = 1, seed = 0, count = 3, hostSurface = null,
) {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.rotation.y = yaw;
  group.name = 'mycelium-shelf-fungi';

  const capColors = [0xd98559, 0xc96f68, 0xb77ac4, 0xe0a45f, 0x9c7ad0];
  const capColor = capColors[Math.abs(seed) % capColors.length];
  const capMaterial = new THREE.MeshStandardMaterial({
    color: capColor,
    roughness: 0.9,
    emissive: new THREE.Color(capColor),
    emissiveIntensity: 0.08,
    flatShading: true,
  });
  const edgeMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color(capColor).multiplyScalar(0.72),
    roughness: 0.96,
    flatShading: true,
  });
  const undersideMaterial = new THREE.MeshStandardMaterial({
    color: seed % 2 ? 0xe8d5bd : 0xd8d0c2,
    roughness: 1,
    flatShading: true,
  });
  const shelves = [];
  for (let i = 0; i < count; i++) {
    const horizontalLogShelf = hostSurface?.type === 'cylinderX';
    const radius = scale * (0.9 + ((Math.abs(seed) + i * 5) % 4) * 0.1);
    const thickness = Math.max(0.2, radius * (0.16 + (i % 2) * 0.025));
    // Long climbs sweep clearly across the host surface; shorter tree/rock
    // clusters use a gentler run so their roots still meet curved hosts.
    const stepRun = scale * (count > 4 ? 0.95 : 0.62);
    // Horizontal-log shelves retain a flat bark-facing edge. Tree, wall, and
    // boulder shelves use a complete circular cap whose center sits on the
    // host surface, embedding half the fungus for a gap-free attachment.
    const shelf = new THREE.Mesh(
      new THREE.CylinderGeometry(
        radius * 0.9, radius, thickness, 14, 1, false,
        horizontalLogShelf ? -Math.PI / 2 : 0,
        horizontalLogShelf ? Math.PI : Math.PI * 2,
      ),
      [edgeMaterial, capMaterial, undersideMaterial],
    );
    const localX = (i - (count - 1) / 2) * stepRun
      + Math.sin(seed + i) * scale * 0.06;
    const localY = i * scale * 1.18;
    let surfaceDepth = 0;
    if (hostSurface?.type === 'cylinderX') {
      const worldY = y + localY;
      const verticalOffset = THREE.MathUtils.clamp(
        worldY - hostSurface.centerY,
        -hostSurface.radius * 0.985,
        hostSurface.radius * 0.985,
      );
      surfaceDepth = Math.sqrt(Math.max(
        0,
        hostSurface.radius ** 2 - verticalOffset ** 2,
      ));
    } else if (hostSurface?.type === 'cylinderY') {
      const worldY = y + localY;
      const heightFraction = THREE.MathUtils.clamp(
        (worldY - hostSurface.bottomY) / (hostSurface.topY - hostSurface.bottomY),
        0,
        1,
      );
      const hostRadius = THREE.MathUtils.lerp(
        hostSurface.bottomRadius,
        hostSurface.topRadius,
        heightFraction,
      );
      const lateralOffset = THREE.MathUtils.clamp(
        localX,
        -hostRadius * 0.985,
        hostRadius * 0.985,
      );
      surfaceDepth = Math.sqrt(Math.max(0, hostRadius ** 2 - lateralOffset ** 2));
    }
    shelf.position.set(
      localX,
      localY,
      surfaceDepth - (horizontalLogShelf ? 0.01 : 0),
    );
    // Shelves on a horizontal log must keep their flat attachment edge
    // parallel to the log axis. The general staircase twist accumulated with
    // every step, turning the upper fans noticeably sideways across the bark.
    shelf.rotation.y = horizontalLogShelf
      ? Math.sin(seed * 1.7 + i) * 0.025
      : (i - 0.5) * 0.12 + Math.sin(seed * 1.7 + i) * 0.08;
    shelf.rotation.z = Math.sin(seed * 0.9 + i * 2.1) * 0.07;
    shelf.castShadow = shelf.receiveShadow = true;
    group.add(shelf);
    shelves.push({ shelf, radius, thickness });
  }
  scene.add(group);
  group.updateMatrixWorld(true);
  for (const { shelf, radius, thickness } of shelves) {
    world.colliders.push(triangleMeshColliderFromMesh(shelf, 'mycelium-shelf-fungus-step'));
    const perch = shelf.localToWorld(V(0, thickness / 2 + 0.08, radius * 0.5));
    wp(world, perch.x, perch.y, perch.z);
  }
  return group;
}

function addHollowMyceliumLogTunnel(scene, world, x, z, length = 48, radius = 5.4) {
  const bark = mat(0xffffff, {
    tex: 'canopy-bark', repeat: [2, Math.max(5, length / 5)], roughness: 0.98,
    side: THREE.DoubleSide,
  });
  const shell = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 22, 5, true), bark);
  shell.rotation.z = Math.PI / 2;
  shell.position.set(x, radius - 0.2, z);
  shell.castShadow = shell.receiveShadow = true;
  scene.add(shell);
  // Each broad side gets a full ground-to-roof bracket-fungus staircase. The
  // alternating fans provide forgiving landings without covering either mouth.
  addMyceliumShelfFungi(
    scene, world, x - length * 0.24, 0.85, z, 0, 1.18, 2, 7,
    { type: 'cylinderX', centerY: radius - 0.2, radius },
  );
  addMyceliumShelfFungi(
    scene, world, x + length * 0.24, 0.85, z, Math.PI, 1.18, 7, 7,
    { type: 'cylinderX', centerY: radius - 0.2, radius },
  );
  for (const endX of [x - length / 2, x + length / 2]) {
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(radius, 0.48, 8, 22),
      mat(0x59402d, { roughness: 0.98, flatShading: true }),
    );
    rim.rotation.y = Math.PI / 2;
    rim.position.set(endX, radius - 0.2, z);
    rim.castShadow = rim.receiveShadow = true;
    scene.add(rim);
  }

  // Match the visible tube with one analytic hollow-cylinder collider. The
  // former stack of rectangular bands made both the outside and the tunnel
  // wall feel like stairs even though the rendered log was perfectly round.
  const half = length / 2;
  world.colliders.push({
    type: 'cylinderShell',
    center: V(x, radius - 0.2, z),
    axis: 'x',
    halfLength: half,
    innerRadius: radius - 0.38,
    outerRadius: radius,
    debugName: 'mycelium-hollow-log-shell',
  });
  for (const px of [x - half - 2, x, x + half + 2]) wp(world, px, 0.1, z);
  for (const px of [x - half + 2, x, x + half - 2]) wp(world, px, radius * 1.94, z);
  const leftVineX = x - Math.min(10, half - 2);
  // The east bank rises under the log, so keep this climb nearer the center
  // where its full capsule clears both the hill and the rounded bark bands.
  const rightVineX = x + Math.min(4, half - 2);
  const vineEdgeGap = 0.06;
  const leftVineZ = z - radius - vineEdgeGap;
  const rightVineZ = z + radius + vineEdgeGap;
  addVine(scene, world, leftVineX, leftVineZ, 0.1, radius * 1.94 + 0.1,
    0.95, 0, -0.18, 0, 1, 0.18, 1.35, 0x65ef9b);
  addVine(scene, world, rightVineX, rightVineZ, 0.1, radius * 1.94 + 0.1,
    0.95, 0, 0.18, 0, -1, 0.18, 1.35, 0x9c78ff);
  wp(world, leftVineX, 0.1, leftVineZ);
  wp(world, rightVineX, 0.1, rightVineZ);
  wp(world, leftVineX, radius * 1.94, z);
  wp(world, rightVineX, radius * 1.94, z);
  world.manualLinks.push(
    [x - half - 2, 0.1, z, x, 0.1, z], [x, 0.1, z, x + half + 2, 0.1, z],
    [leftVineX, 0.1, leftVineZ, leftVineX, radius * 1.94, z],
    [rightVineX, 0.1, rightVineZ, rightVineX, radius * 1.94, z],
    [leftVineX, radius * 1.94, z, x, radius * 1.94, z],
    [rightVineX, radius * 1.94, z, x, radius * 1.94, z],
    [x - half + 2, radius * 1.94, z, x, radius * 1.94, z],
    [x, radius * 1.94, z, x + half - 2, radius * 1.94, z],
  );
}

function addMyceliumRingDeck(scene, world, x, y, z, outerRadius, innerRadius, color) {
  const thickness = 0.7;
  const ringShape = new THREE.Shape();
  ringShape.absarc(0, 0, outerRadius, 0, Math.PI * 2, false);
  const ringHole = new THREE.Path();
  ringHole.absarc(0, 0, innerRadius, 0, Math.PI * 2, true);
  ringShape.holes.push(ringHole);
  const ring = new THREE.Mesh(
    new THREE.ExtrudeGeometry(ringShape, {
      depth: thickness,
      bevelEnabled: false,
      curveSegments: 40,
      steps: 1,
    }),
    mat(color, { tex: 'canopy-bark', repeat: [3, 3], roughness: 0.98, side: THREE.DoubleSide }),
  );
  // Extrusion runs along local +Z. Rotating +90 degrees puts the cap at y and
  // gives the balcony a real outer wall, inner wall, and underside down to the
  // same depth used by gameplay collision.
  ring.rotation.x = Math.PI / 2;
  ring.position.set(x, y, z);
  ring.name = 'mycelium-hollow-tree-ring-deck';
  ring.castShadow = ring.receiveShadow = true;
  scene.add(ring);
  const band = outerRadius - innerRadius;
  const mid = (outerRadius + innerRadius) / 2;
  // Follow the circular deck with short tangent cells. The previous four-box
  // approximation filled the square corners outside the visible ring and
  // created invisible walls across the route.
  const segments = 40;
  const radialHalf = band / 2;
  const tangentHalf = Math.PI * mid / segments * 1.08;
  for (let i = 0; i < segments; i++) {
    const angle = i * Math.PI * 2 / segments;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const extentX = Math.abs(cos) * radialHalf + Math.abs(sin) * tangentHalf;
    const extentZ = Math.abs(sin) * radialHalf + Math.abs(cos) * tangentHalf;
    const cx = x + cos * mid;
    const cz = z + sin * mid;
    world.colliders.push({
      type: 'box',
      min: V(cx - extentX, y - thickness, cz - extentZ),
      max: V(cx + extentX, y, cz + extentZ),
    });
  }
  for (const [dx, dz] of [[-mid, 0], [mid, 0], [0, -mid], [0, mid]]) wp(world, x + dx, y, z + dz);
  world.manualLinks.push(
    [x - mid, y, z, x, y, z - mid], [x, y, z - mid, x + mid, y, z],
    [x + mid, y, z, x, y, z + mid], [x, y, z + mid, x - mid, y, z],
  );
  return { band };
}

// Mycelium crowns start from one natural green. Seasonal/fantasy variants are
// controlled HSL hue and brightness shifts rather than separately baked art.
const MYCELIUM_CROWN_VARIANTS = [
  [0, 1],          // green
  [-0.17, 1.08],   // yellow
  [-0.25, 1.04],   // orange
  [-0.34, 0.98],   // red
  [0.08, 1.08],    // mint
  [0.15, 1.04],    // teal
  [0.42, 1.08],    // purple
];

function myceliumCrownTint(index = 0, brightness = 1) {
  const [hueShift, variantBrightness] = MYCELIUM_CROWN_VARIANTS[
    ((index % MYCELIUM_CROWN_VARIANTS.length) + MYCELIUM_CROWN_VARIANTS.length)
      % MYCELIUM_CROWN_VARIANTS.length
  ];
  const hue = (0.335 + hueShift + 1) % 1;
  const lightness = THREE.MathUtils.clamp(0.41 * variantBrightness * brightness, 0.32, 0.55);
  return new THREE.Color().setHSL(hue, 0.54, lightness);
}

let _myceliumLeafCrownGeometry = null;
function myceliumLeafCrownGeometry() {
  if (_myceliumLeafCrownGeometry) return _myceliumLeafCrownGeometry;
  const positions = [];
  const normals = [];
  const colors = [];
  const pushTriangle = (a, b, c, shade) => {
    const normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
    for (const point of [a, b, c]) {
      positions.push(point.x, point.y, point.z);
      normals.push(normal.x, normal.y, normal.z);
      colors.push(shade, shade, shade);
    }
  };

  // A faceted core prevents sky holes, while broad, nearly flush leaf fans
  // soften its silhouette without turning the crown into a ball of spikes.
  const coreSource = new THREE.DodecahedronGeometry(1, 1);
  coreSource.scale(1, 0.7, 1);
  const core = coreSource.index ? coreSource.toNonIndexed() : coreSource;
  core.computeVertexNormals();
  const corePosition = core.getAttribute('position');
  const coreNormal = core.getAttribute('normal');
  for (let i = 0; i < corePosition.count; i++) {
    positions.push(corePosition.getX(i), corePosition.getY(i), corePosition.getZ(i));
    normals.push(coreNormal.getX(i), coreNormal.getY(i), coreNormal.getZ(i));
    const shade = 0.54 + Math.max(0, coreNormal.getY(i)) * 0.08;
    colors.push(shade, shade, shade);
  }

  const leafRings = [
    [0.42, 8, 0.22, 0.19],
    [0.72, 11, 0.27, 0.22],
    [1.02, 14, 0.32, 0.25],
    [1.3, 16, 0.37, 0.28],
    [1.57, 18, 0.43, 0.31],
  ];
  leafRings.forEach(([theta, count, length, halfWidth], ring) => {
    for (let i = 0; i < count; i++) {
      const phi = i * Math.PI * 2 / count + ring * 0.47;
      const sinTheta = Math.sin(theta);
      const center = V(
        Math.cos(phi) * sinTheta * 1.015,
        Math.cos(theta) * 0.71,
        Math.sin(phi) * sinTheta * 1.015,
      );
      const outward = V(center.x, center.y / 0.7, center.z).normalize();
      const across = V(-Math.sin(phi), 0, Math.cos(phi)).normalize();
      const down = V(
        Math.cos(theta) * Math.cos(phi),
        -Math.sin(theta) * 0.7,
        Math.cos(theta) * Math.sin(phi),
      ).normalize();
      const root = center.clone().addScaledVector(down, -length * 0.32)
        .addScaledVector(outward, 0.025);
      const left = center.clone().addScaledVector(down, length * 0.1)
        .addScaledVector(across, -halfWidth).addScaledVector(outward, 0.035);
      const right = center.clone().addScaledVector(down, length * 0.1)
        .addScaledVector(across, halfWidth).addScaledVector(outward, 0.035);
      const middle = center.clone().addScaledVector(down, length * 0.42)
        .addScaledVector(outward, 0.052);
      const tipLeft = center.clone().addScaledVector(down, length)
        .addScaledVector(across, -halfWidth * 0.22)
        .addScaledVector(outward, ring > 2 ? -0.005 : 0.012);
      const tipRight = center.clone().addScaledVector(down, length)
        .addScaledVector(across, halfWidth * 0.22)
        .addScaledVector(outward, ring > 2 ? -0.005 : 0.012);
      const shade = 0.72 + ((ring * 7 + i * 3) % 6) * 0.028;
      pushTriangle(root, left, middle, shade * 0.97);
      pushTriangle(root, middle, right, shade);
      pushTriangle(left, tipLeft, middle, shade * 0.95);
      pushTriangle(middle, tipLeft, tipRight, shade * 0.98);
      pushTriangle(middle, tipRight, right, shade * 0.96);
    }
  });
  if (core !== coreSource) core.dispose();
  coreSource.dispose();

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  _myceliumLeafCrownGeometry = geometry;
  return geometry;
}

function myceliumCrownMaterial(color = 0xffffff) {
  return new THREE.MeshStandardMaterial({
    color,
    vertexColors: true,
    side: THREE.DoubleSide,
    roughness: 0.96,
    metalness: 0,
    flatShading: true,
    emissive: 0x101414,
    emissiveIntensity: 0.1,
  });
}

function addHollowMyceliumTree(scene, world, x, baseY, z) {
  const radius = 9.6;
  const innerRadius = 7.35;
  const trunkHeight = 25;
  (world.myceliumTreeRoots ||= []).push({ x, z, baseY, radius, kind: 'hollow-elder' });
  const wallThickness = radius - innerRadius;
  const wallMidRadius = (radius + innerRadius) / 2;
  const wallSegments = 36;
  const tangentWidth = Math.PI * 2 * wallMidRadius / wallSegments * 1.08;
  const branchDoors = [0, Math.PI, Math.PI / 4, Math.PI * 3 / 4];
  const tunnelDoors = [Math.PI / 2, Math.PI * 3 / 2];
  const angleDistance = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  const wallBands = [
    [baseY, baseY + 4.2, tunnelDoors, 0.34],
    [baseY + 4.2, baseY + 7.05, [], 0],
    [baseY + 7.05, baseY + 10.35, branchDoors, 0.36],
    [baseY + 10.35, baseY + 14.05, [], 0],
    [baseY + 14.05, baseY + 17.35, branchDoors, 0.36],
    [baseY + 17.35, baseY + trunkHeight, [], 0],
  ];
  const wallPieces = [];
  for (const [minY, maxY, doors, doorHalfAngle] of wallBands) {
    for (let i = 0; i < wallSegments; i++) {
      const angle = i * Math.PI * 2 / wallSegments;
      if (doors.some(door => angleDistance(angle, door) < doorHalfAngle)) continue;
      wallPieces.push({ angle, minY, maxY });
    }
  }
  const bark = mat(0xffffff, {
    tex: 'canopy-bark', repeat: [2, 7], roughness: 0.99,
  });
  const shell = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), bark, wallPieces.length);
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  wallPieces.forEach((piece, index) => {
    const { angle, minY, maxY } = piece;
    const yaw = Math.PI / 2 - angle;
    const height = maxY - minY;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    position.set(x + cos * wallMidRadius, (minY + maxY) / 2, z + sin * wallMidRadius);
    rotation.setFromAxisAngle(V(0, 1, 0), yaw);
    scale.set(tangentWidth, height, wallThickness);
    matrix.compose(position, rotation, scale);
    shell.setMatrixAt(index, matrix);
    const halfTangent = tangentWidth / 2;
    const halfWall = wallThickness / 2;
    const extentX = Math.abs(Math.cos(yaw)) * halfTangent + Math.abs(Math.sin(yaw)) * halfWall;
    const extentZ = Math.abs(Math.sin(yaw)) * halfTangent + Math.abs(Math.cos(yaw)) * halfWall;
    world.colliders.push({
      type: 'box',
      min: V(position.x - extentX, minY, position.z - extentZ),
      max: V(position.x + extentX, maxY, position.z + extentZ),
    });
  });
  shell.instanceMatrix.needsUpdate = true;
  shell.castShadow = shell.receiveShadow = true;
  scene.add(shell);

  addMyceliumRingDeck(scene, world, x, baseY + 8, z, 7.25, 3.15, 0x5b4638);
  addMyceliumRingDeck(scene, world, x, baseY + 15, z, 7.05, 3.15, 0x654a3a);
  addJumpPad(scene, world, x, baseY, z, 29, 2.8, 0, 0xa86cff);
  wp(world, x, baseY + 0.1, z + radius + 2.5);
  wp(world, x, baseY + 0.1, z - radius - 2.5);
  world.manualLinks.push(
    [x, baseY + 0.1, z + radius + 2.5, x, baseY + 0.1, z],
    [x, baseY + 0.1, z - radius - 2.5, x, baseY + 0.1, z],
  );

  // An exterior vine keeps the lower ring reachable in either direction; the
  // launcher is the fast interior route to the upper canopy.
  const vineAngle = Math.PI * 3 / 4;
  const vineRadius = radius + 0.06;
  const vineX = x + Math.cos(vineAngle) * vineRadius;
  const vineZ = z + Math.sin(vineAngle) * vineRadius;
  addVine(scene, world, vineX, vineZ, baseY + 0.1, baseY + 8.15, 0.95,
    -0.18, 0.18, Math.SQRT1_2, -Math.SQRT1_2, 0.18, 1.35, 0x65ef9b);
  wp(world, vineX, baseY + 0.1, vineZ);
  world.manualLinks.push([vineX, baseY + 0.1, vineZ, x - 5, baseY + 8, z + 5]);

  const crownGeometry = myceliumLeafCrownGeometry();
  const crownMaterial = myceliumCrownMaterial(myceliumCrownTint(5, 0.96));
  for (const [ox, oy, oz, r] of [[0, 0, 0, 12], [-8, -1, 3, 7.2], [8, -0.5, -3, 7.5], [0, -1, -8, 7]]) {
    const lobe = new THREE.Mesh(crownGeometry, crownMaterial);
    lobe.position.set(x + ox, baseY + trunkHeight + oy, z + oz);
    lobe.scale.setScalar(r);
    lobe.castShadow = lobe.receiveShadow = true;
    scene.add(lobe);
  }
  (world.foliageZones ||= []).push({ x, y: baseY + trunkHeight, z, r: 16 });
}

function addMyceliumCanopyDeck(scene, world, x, y, z, radius, seed, trunkRadius = 2.35) {
  // `radius` described the old outer edge. Preserve the trunk footprint while
  // Keep the expanded balcony substantial without letting it dominate the
  // surrounding branches: 25% back from the previous 3x treatment leaves the
  // exposed walking band at 2.25x its original width.
  const balconyRadius = trunkRadius + (radius - trunkRadius) * 2.25;
  const thickness = 1.45;
  const deck = new THREE.Mesh(
    new THREE.CylinderGeometry(balconyRadius * 0.94, balconyRadius, thickness, 24, 2),
    mat(0xffffff, {
      tex: 'canopy-bark', repeat: [Math.max(4, balconyRadius / 2), 2], roughness: 0.98,
    }),
  );
  deck.position.set(x, y - thickness / 2, z);
  deck.rotation.y = seed * 0.61;
  deck.castShadow = deck.receiveShadow = true;
  scene.add(deck);
  const navRadius = trunkRadius + 1.45;
  const navPoints = [];
  // Eight nodes keep the ring safely outside the trunk while making the
  // around-tree route shorter (in graph hops) than detouring through an
  // unrelated mushroom or distant branch.
  const navSegments = 8;
  for (let i = 0; i < navSegments; i++) {
    const angle = i * Math.PI * 2 / navSegments;
    const point = [x + Math.cos(angle) * navRadius, y, z + Math.sin(angle) * navRadius];
    navPoints.push(point);
    wp(world, ...point);
    world.waypoints[world.waypoints.length - 1].manualLinksOnly = true;
  }
  for (let i = 0; i < navSegments; i++) {
    world.manualLinks.push([...navPoints[i], ...navPoints[(i + 1) % navSegments]]);
  }
  const deckRoute = {
    x, y, z, radius: balconyRadius, topRadius: balconyRadius * 0.94,
    navRadius, navPoints,
  };
  (world.myceliumCanopyDecks ||= []).push(deckRoute);

  // Follow the circular balcony instead of filling its bounding square with
  // an invisible floor. Short tangent cells provide full-width support while
  // keeping the outer edge and the trunk opening faithful to the mesh.
  const innerSupportRadius = trunkRadius * 0.76;
  const radialHalf = (balconyRadius - innerSupportRadius) / 2;
  const midRadius = (balconyRadius + innerSupportRadius) / 2;
  const segments = 48;
  const tangentHalf = Math.PI * midRadius / segments * 1.08;
  for (let i = 0; i < segments; i++) {
    const angle = i * Math.PI * 2 / segments;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const extentX = Math.abs(cos) * radialHalf + Math.abs(sin) * tangentHalf;
    const extentZ = Math.abs(sin) * radialHalf + Math.abs(cos) * tangentHalf;
    const cx = x + cos * midRadius;
    const cz = z + sin * midRadius;
    world.colliders.push({
      type: 'box',
      min: V(cx - extentX, y - thickness, cz - extentZ),
      max: V(cx + extentX, y, cz + extentZ),
    });
  }
  return { ...deckRoute, thickness };
}

function addMyceliumRockField(scene, world, specs) {
  // Detail 2 keeps the faceted silhouette while closely following the exact
  // oriented ellipsoid used by gameplay collision.
  const geometry = new THREE.IcosahedronGeometry(1, 2);
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.98,
    flatShading: true,
    ...aiTex('rock', 1.35, 1.35),
  });
  const rocks = new THREE.InstancedMesh(geometry, material, specs.length);
  const matrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const palette = [0x35433e, 0x3d4d43, 0x46534a, 0x32433f, 0x4a584c];
  const mossMatrices = Array.from({ length: 4 }, () => []);
  specs.forEach((spec, index) => {
    const [x, y, z, rx, ry = rx * 0.72, rz = rx * 0.9, collide = true,
      options = {}] = spec;
    position.set(x, y, z);
    // Broad tunnel stones need to stay upright: freely rotating an elongated
    // roof ellipsoid can turn its ten-meter horizontal radius vertical and
    // fill the passage it is meant to frame. The renderer and collider share
    // this transform, so stabilizing it improves both clearance and fidelity.
    rotation.setFromEuler(options.upright
      ? new THREE.Euler(0, options.yaw || 0, 0)
      : new THREE.Euler(index * 0.37, index * 0.83, index * 0.21));
    scale.set(rx, ry, rz);
    matrix.compose(position, rotation, scale);
    rocks.setMatrixAt(index, matrix);
    rocks.setColorAt(index, new THREE.Color(palette[index % palette.length]));
    // Moss belongs to selected boulders only. Four different connected face
    // masks keep the patches from repeating in the same place on every rock.
    if (index % 3 === 1 || (rx > 5 && index % 2 === 0)) {
      mossMatrices[index % mossMatrices.length].push(matrix.clone());
    }
    if (collide) {
      world.colliders.push({
        type: 'ellipsoid',
        center: V(x, y, z),
        radii: V(rx, ry, rz),
        rotation: rotation.clone(),
        inverseRotation: rotation.clone().invert(),
        debugName: 'mycelium-boulder',
      });
    }
  });
  rocks.instanceMatrix.needsUpdate = true;
  if (rocks.instanceColor) rocks.instanceColor.needsUpdate = true;
  rocks.castShadow = rocks.receiveShadow = true;
  scene.add(rocks);

  const source = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  const sourcePosition = source.getAttribute('position');
  const sourceNormal = source.getAttribute('normal');
  const sourceUv = source.getAttribute('uv');
  const maskCenters = [
    [V(0.76, 0.48, 0.43), V(-0.05, 0.94, -0.34)],
    [V(-0.68, 0.57, 0.46)],
    [V(0.24, 0.72, -0.65), V(-0.72, 0.34, -0.6)],
    [V(-0.18, 0.9, 0.4)],
  ].map(centers => centers.map(center => center.normalize()));
  const mossMaterial = mat(0x355f3b, {
    tex: 'grass', repeat: [1.5, 1.5], roughness: 1, flatShading: true,
  });
  // The moss triangles occupy the exact same surface as their rock faces.
  // Polygon offset only resolves depth precision; it does not alter geometry.
  mossMaterial.polygonOffset = true;
  mossMaterial.polygonOffsetFactor = -1;
  mossMaterial.polygonOffsetUnits = -1;
  mossMatrices.forEach((matrices, variant) => {
    if (!matrices.length) return;
    const facePositions = [];
    const faceNormals = [];
    const faceUvs = [];
    const faceNormal = new THREE.Vector3();
    for (let face = 0; face < sourcePosition.count / 3; face++) {
      faceNormal.set(0, 0, 0);
      for (let corner = 0; corner < 3; corner++) {
        const vertex = face * 3 + corner;
        faceNormal.x += sourceNormal.getX(vertex);
        faceNormal.y += sourceNormal.getY(vertex);
        faceNormal.z += sourceNormal.getZ(vertex);
      }
      faceNormal.normalize();
      const inPatch = maskCenters[variant].some((center, patch) => (
        faceNormal.dot(center) > (patch ? 0.925 : 0.89)
      ));
      if (!inPatch || faceNormal.y < -0.18) continue;
      for (let corner = 0; corner < 3; corner++) {
        const vertex = face * 3 + corner;
        facePositions.push(
          sourcePosition.getX(vertex), sourcePosition.getY(vertex), sourcePosition.getZ(vertex),
        );
        faceNormals.push(
          sourceNormal.getX(vertex), sourceNormal.getY(vertex), sourceNormal.getZ(vertex),
        );
        faceUvs.push(sourceUv.getX(vertex), sourceUv.getY(vertex));
      }
    }
    const mossGeometry = new THREE.BufferGeometry();
    mossGeometry.setAttribute('position', new THREE.Float32BufferAttribute(facePositions, 3));
    mossGeometry.setAttribute('normal', new THREE.Float32BufferAttribute(faceNormals, 3));
    mossGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(faceUvs, 2));
    const moss = new THREE.InstancedMesh(mossGeometry, mossMaterial, matrices.length);
    matrices.forEach((mossMatrix, index) => moss.setMatrixAt(index, mossMatrix));
    moss.instanceMatrix.needsUpdate = true;
    moss.name = `mycelium-boulder-moss-faces-${variant}`;
    moss.castShadow = moss.receiveShadow = true;
    scene.add(moss);
  });
  if (source !== geometry) source.dispose();
}

function addMyceliumGrottoRoof(scene, world, centerZ = -64) {
  const topY = 9.7;
  const ceilingY = 7.8;
  // triangleMeshColliderFromMesh orients generated faces away from the mesh
  // origin, so keep that origin inside the roof slab—not down in the cave.
  const centerY = (topY + ceilingY) / 2;
  // Two related, deliberately uneven outlines form one continuous terrain
  // bridge. The inner outline is the flat fighting surface; the outer one
  // drops into the two flanking hills and buries most of its rear edge in the
  // north wall. Its lifted west-rear seam forms one deliberate back entrance
  // while the center and opposite rear corner remain sealed.
  const top = [
    [-10.5, 16], [0, 16.7], [10.5, 16], [14.5, 12.5],
    [15.5, 5], [14.5, -6], [13, -14], [8, -16.5],
    [-1, -17], [-10, -16], [-14, -11], [-15.5, -2],
    [-15, 8], [-13, 13],
  ].map(([x, z]) => V(x, topY, z));
  const outer = [
    [-15, 17, 7.8], [0, 18, 8], [15, 17, 7.8], [21, 14, 3.6],
    [23, 6, 6.6], [22, -7, 5.5], [21, -15.5, 1.2], [12, -17.8, 0.2],
    [-1, -18, 0.1], [-12.5, -17.2, 5.4], [-21.5, -14.2, 5.8], [-22, -4, 5.4],
    [-22, 8, 6.3], [-19, 14.5, 3.2],
  ].map(([x, z, y]) => V(x, y, z));
  const underside = top.map(point => V(point.x, ceilingY, point.z));
  const topCenter = top.reduce((sum, point) => sum.add(point), V()).multiplyScalar(1 / top.length);
  const undersideCenter = V(topCenter.x, ceilingY, topCenter.z);
  const positions = [];
  const uvs = [];
  const addTriangle = (a, b, c) => {
    for (const point of [a, b, c]) {
      positions.push(point.x, point.y - centerY, point.z);
      uvs.push(point.x / 7, point.z / 7);
    }
  };

  // Flat crown. The outline is convex enough for a center fan, and its broad
  // top preserves the existing upper combat route and elder-tree footing.
  for (let i = 0; i < top.length; i++) {
    addTriangle(topCenter, top[i], top[(i + 1) % top.length]);
  }
  const topVertexCount = positions.length / 3;

  // Faceted shoulders taper into the hills. The matching inner underside
  // slopes downward toward the same outer seam. The raised west-rear span
  // keeps over five meters of clearance above the new back route while the
  // remaining rear seam still closes against the perimeter wall.
  for (let i = 0; i < top.length; i++) {
    const next = (i + 1) % top.length;
    addTriangle(top[i], outer[next], top[next]);
    addTriangle(top[i], outer[i], outer[next]);
    addTriangle(underside[i], underside[next], outer[next]);
    addTriangle(underside[i], outer[next], outer[i]);
  }
  for (let i = 0; i < underside.length; i++) {
    addTriangle(undersideCenter, underside[(i + 1) % underside.length], underside[i]);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  geometry.addGroup(0, topVertexCount, 0);
  geometry.addGroup(topVertexCount, positions.length / 3 - topVertexCount, 1);
  const caveRockMaterial = mat(0xffffff, {
    tex: 'mycelium-mossy-rock', repeat: [1.35, 1.35], roughness: 0.99,
    emissive: 0x77907c, emissiveIntensity: 0.85,
    flatShading: true, side: THREE.DoubleSide,
  });
  // The grotto is intentionally dim, but its ceiling still needs to read as
  // mossy stone instead of a black polygon. Reusing the albedo as a restrained
  // emissive map preserves the rock detail wherever the cave lights fall off.
  caveRockMaterial.emissiveMap = caveRockMaterial.map;
  caveRockMaterial.needsUpdate = true;
  const roof = new THREE.Mesh(geometry, [
    mat(0x315141, { tex: 'grass', repeat: [1.15, 1.15], roughness: 0.98 }),
    caveRockMaterial,
  ]);
  roof.position.set(0, centerY, centerZ);
  roof.castShadow = roof.receiveShadow = true;
  roof.name = 'mycelium-natural-grotto-roof';
  scene.add(roof);
  world.colliders.push(triangleMeshColliderFromMesh(roof, 'mycelium-natural-grotto-roof'));
  return roof;
}

function myceliumTreeBurialDepth(world, x, baseY, z, trunkRadius) {
  // Hills in this map are huge buried meshes. Their curved surface often
  // sits a little below a tree's authored base height on the downhill side,
  // so a trunk that ends exactly at baseY appears to float. Find the nearby
  // terrain surface and extend the trunk well through it while leaving the
  // authored canopy, decks, and branch heights unchanged.
  let terrainSurface = -Infinity;
  for (const collider of world.colliders) {
    if (collider.type === 'triangleMesh') {
      const surfaceY = triangleMeshSurfaceY(collider, x, z);
      if (surfaceY == null || surfaceY <= 0.05 || Math.abs(surfaceY - baseY) > 8) continue;
      terrainSurface = Math.max(terrainSurface, surfaceY);
      continue;
    }
    if (collider.type !== 'sphere' || collider.radius < 12) continue;
    const dx = x - collider.center.x;
    const dz = z - collider.center.z;
    const horizontalSq = dx * dx + dz * dz;
    if (horizontalSq >= collider.radius * collider.radius) continue;
    const surfaceY = collider.center.y
      + Math.sqrt(collider.radius * collider.radius - horizontalSq);
    // A buried sphere whose cap never rises through the arena's y=0 ground is
    // not the tree's visible hillside and should not make the trunk needlessly
    // extend far underground.
    if (surfaceY <= 0.05) continue;
    // Ignore distant buried spheres beneath unrelated platforms or tunnels.
    if (Math.abs(surfaceY - baseY) > 8) continue;
    terrainSurface = Math.max(terrainSurface, surfaceY);
  }
  const naturalEmbed = Math.max(2.4, trunkRadius * 0.72);
  if (!Number.isFinite(terrainSurface)) return Math.max(1.35, trunkRadius * 0.38);
  return Math.max(naturalEmbed, baseY - terrainSurface + naturalEmbed);
}

function addDenseMyceliumForest(scene, world, specs) {
  const trunkGeometry = new THREE.CylinderGeometry(0.72, 1, 1, 8, 3);
  const trunkMaterial = mat(0xffffff, { tex: 'canopy-bark', repeat: [1, 4], roughness: 0.98 });
  const crownGeometry = myceliumLeafCrownGeometry();
  const crownMaterial = myceliumCrownMaterial(0xffffff);
  const trunks = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, specs.length);
  const crowns = new THREE.InstancedMesh(crownGeometry, crownMaterial, specs.length * 3);
  const matrix = new THREE.Matrix4();
  const rotation = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const colors = MYCELIUM_CROWN_VARIANTS.map((_, index) => myceliumCrownTint(index));
  specs.forEach(([x, baseY, z, height, radius], index) => {
    const burialDepth = myceliumTreeBurialDepth(world, x, baseY, z, radius);
    const renderedHeight = height + burialDepth;
    const visualBaseY = baseY - burialDepth;
    (world.myceliumTreeRoots ||= []).push({
      x, z, baseY, visualBaseY, radius, kind: 'forest',
    });
    rotation.setFromAxisAngle(V(0, 1, 0), index * 1.73);
    position.set(x, visualBaseY + renderedHeight / 2, z);
    scale.set(radius * 0.34, renderedHeight, radius * 0.34);
    matrix.compose(position, rotation, scale);
    trunks.setMatrixAt(index, matrix);
    world.colliders.push({
      type: 'box',
      min: V(x - radius * 0.27, visualBaseY, z - radius * 0.27),
      max: V(x + radius * 0.27, baseY + height, z + radius * 0.27),
    });
    if ([2, 8, 14, 20].includes(index)) {
      const fungusYaw = index * 0.91;
      addMyceliumShelfFungi(
        scene,
        world,
        x,
        baseY + 1,
        z,
        fungusYaw,
        0.92,
        index + 3,
        3,
        {
          type: 'cylinderY',
          bottomY: visualBaseY,
          topY: baseY + height,
          bottomRadius: radius * 0.34,
          topRadius: radius * 0.34 * 0.72,
        },
      );
    }
    for (let lobe = 0; lobe < 3; lobe++) {
      const angle = lobe * Math.PI * 2 / 3 + index * 0.77;
      position.set(
        x + Math.cos(angle) * radius * 0.42,
        baseY + height + (lobe === 0 ? radius * 0.28 : 0),
        z + Math.sin(angle) * radius * 0.42,
      );
      scale.setScalar(radius);
      rotation.setFromEuler(new THREE.Euler(index * 0.13, angle, lobe * 0.19));
      matrix.compose(position, rotation, scale);
      const crownIndex = index * 3 + lobe;
      crowns.setMatrixAt(crownIndex, matrix);
      crowns.setColorAt(crownIndex, new THREE.Color(colors[(index + lobe) % colors.length]));
    }
  });
  trunks.instanceMatrix.needsUpdate = true;
  crowns.instanceMatrix.needsUpdate = true;
  if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
  trunks.castShadow = trunks.receiveShadow = true;
  crowns.castShadow = crowns.receiveShadow = true;
  scene.add(trunks, crowns);
}

function addMyceliumLog(scene, world, x, z, width, depth) {
  const alongX = width >= depth;
  const length = Math.max(width, depth);
  const start = V(
    x - (alongX ? length * 0.5 : 0),
    1.05,
    z - (alongX ? 0 : length * 0.5),
  );
  const end = V(
    x + (alongX ? length * 0.5 : 0),
    0.85,
    z + (alongX ? 0 : length * 0.5),
  );
  addMyceliumBranch(scene, start, end, 1.05);
  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  world.colliders.push({
    type: 'box',
    min: V(x - halfWidth, 0, z - halfDepth),
    max: V(x + halfWidth, 1.85, z + halfDepth),
  });
}

function addMyceliumTree(scene, world, x, baseY, z, deckHeights, seed = 1, options = {}) {
  const topDeck = Math.max(...deckHeights);
  const trunkHeight = topDeck - baseY + 8;
  const trunkRadius = 2.35;
  const burialDepth = options.burialDepth
    ?? myceliumTreeBurialDepth(world, x, baseY, z, trunkRadius);
  const renderedTrunkHeight = trunkHeight + burialDepth;
  const visualBaseY = baseY - burialDepth;
  (world.myceliumTreeRoots ||= []).push({
    x, z, baseY, visualBaseY, radius: trunkRadius, kind: 'elder',
  });
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(trunkRadius * 0.72, trunkRadius, renderedTrunkHeight, 11, 5),
    mat(0xffffff, {
      tex: 'canopy-bark', repeat: [2, Math.max(3, renderedTrunkHeight / 4)], roughness: 0.98,
    }),
  );
  trunk.position.set(x, visualBaseY + renderedTrunkHeight / 2, z);
  trunk.rotation.y = seed * 0.73;
  trunk.castShadow = trunk.receiveShadow = true;
  scene.add(trunk);
  world.colliders.push({
    type: 'box',
    min: V(x - 1.8, visualBaseY, z - 1.8),
    max: V(x + 1.8, baseY + trunkHeight, z + 1.8),
  });
  if ([1, 4, 6, 8].includes(seed)) {
    const fungusYaw = seed * 1.37;
    addMyceliumShelfFungi(
      scene,
      world,
      x,
      baseY + 1.05,
      z,
      fungusYaw,
      1.02,
      seed,
      3,
      {
        type: 'cylinderY',
        bottomY: visualBaseY,
        topY: baseY + trunkHeight,
        bottomRadius: trunkRadius,
        topRadius: trunkRadius * 0.72,
      },
    );
  }

  let previousDeckRoute = null;
  deckHeights.forEach((deckY, index) => {
    const oldDeckRadius = index ? 5.2 : 6.2;
    const deckRoute = addMyceliumCanopyDeck(
      scene, world, x, deckY, z, oldDeckRadius, seed + index, trunkRadius,
    );
    const deckRadius = deckRoute.radius;
    const dir = (seed + index) % 2 === 0 ? 1 : -1;
    const alongX = index % 2 === 0;
    // Keep the climb volume just beyond the landing collider, with the sheet
    // visibly hooked over the canopy rim. The exit impulse points inward, so
    // reaching the top always pops the climber onto the deck instead of into
    // its underside.
    // A few decks sit directly under inter-tree branches. Give those climbs a
    // clear face of the canopy instead of letting the widened branch cross the
    // vine volume. Other elder trees retain their seeded cardinal placement.
    const clearFaces = {
      '1:0': -Math.PI / 2,
      '1:1': Math.PI / 3,
      '3:0': 0,
      '3:1': 0,
      '4:0': Math.PI / 12,
      '4:1': Math.PI / 2,
      '5:0': 0,
    };
    const clearFace = clearFaces[`${seed}:${index}`];
    const vineAngle = clearFace ?? (alongX
      ? (dir > 0 ? 0 : Math.PI)
      : (dir > 0 ? Math.PI / 2 : -Math.PI / 2));
    const vineOffset = deckRadius + 0.06;
    const outwardX = Math.cos(vineAngle);
    const outwardZ = Math.sin(vineAngle);
    const vineX = x + outwardX * vineOffset;
    const vineZ = z + outwardZ * vineOffset;
    const y0 = index === 0 ? baseY + 0.2 : deckHeights[index - 1] + 0.15;
    addVine(scene, world, vineX, vineZ, y0, deckY + 0.15, 0.86,
      outwardX * 0.18, outwardZ * 0.18,
      -outwardX, -outwardZ,
      0.2, 1.18, index % 2 ? 0x9a74ff : 0x55efba);
    wp(world, vineX, y0, vineZ);
    const nearestDeckPoint = (route, px, pz) => route.navPoints.reduce((best, candidate) => (
      Math.hypot(candidate[0] - px, candidate[2] - pz)
        < Math.hypot(best[0] - px, best[2] - pz) ? candidate : best
    ));
    if (previousDeckRoute) {
      world.manualLinks.push([
        ...nearestDeckPoint(previousDeckRoute, vineX, vineZ), vineX, y0, vineZ,
      ]);
    }
    world.manualLinks.push([
      vineX, y0, vineZ, ...nearestDeckPoint(deckRoute, vineX, vineZ),
    ]);
    previousDeckRoute = deckRoute;
    const branchY = deckY - 0.65;
    for (let arm = 0; arm < 4; arm++) {
      const angle = arm * Math.PI / 2 + seed * 0.29 + index * 0.42;
      addMyceliumBranch(
        scene,
        V(x, branchY - 1.8, z),
        V(x + Math.cos(angle) * 7.5, branchY, z + Math.sin(angle) * 7.5),
        0.72 - index * 0.08,
      );
    }
  });

  const crown = new THREE.Group();
  crown.position.set(x, baseY + trunkHeight - 0.5, z);
  const crownColors = MYCELIUM_CROWN_VARIANTS.map((_, index) => myceliumCrownTint(index));
  const crownMaterials = crownColors.map(color => myceliumCrownMaterial(color));
  const crownGeometry = myceliumLeafCrownGeometry();
  const crownOffsets = [
    [0, 1.8, 0, 7.2], [-5.2, 0, 1.3, 5.4], [5.1, 0.5, -0.8, 5.6],
    [-1.4, 0.2, -5.2, 5.2], [1.6, 0.3, 5.1, 5.0],
  ];
  crownOffsets.forEach(([ox, oy, oz, radius], index) => {
    const lobe = new THREE.Mesh(crownGeometry, crownMaterials[index % crownMaterials.length]);
    lobe.position.set(ox, oy, oz);
    lobe.scale.setScalar(radius);
    lobe.rotation.set(seed * 0.11 + index, index * 0.47, index * 0.19);
    lobe.castShadow = lobe.receiveShadow = true;
    crown.add(lobe);
  });
  scene.add(crown);
  (world.foliageZones ||= []).push({ x, y: baseY + trunkHeight + 0.5, z, r: 10.5 });

  const glow = new THREE.PointLight(seed % 2 ? 0x8c7dff : 0x63f3c4, 15, 25);
  glow.position.set(x, baseY + trunkHeight - 1.5, z);
  scene.add(glow);
  world.anim.push((_dt, t) => {
    crown.rotation.y = Math.sin(t * 0.12 + seed) * 0.035;
    crown.rotation.z = Math.sin(t * 0.2 + seed * 0.8) * 0.012;
    glow.intensity = 12 + Math.sin(t * 1.4 + seed) * 4;
    for (let i = 0; i < crownMaterials.length; i++) {
      crownMaterials[i].emissiveIntensity = 0.13 + Math.sin(t * 0.8 + seed + i) * 0.045;
    }
  });
}

function buildMyceliumGrove(scene) {
  const world = newWorld({
    killY: -22,
    waypointLinkDist: 19,
    waypointLinkDy: 5.8,
    waypointLinkClearance: 0.3,
    // The center meadow gives the winners a clean stage and frames the
    // waterfall directly behind them from the fixed south-facing camera.
    podiumSpot: V(0, 0, -16),
  });
  scene.background = new THREE.Color(0x06141c);
  scene.fog = new THREE.Fog(0x12332e, 58, 205);
  baseLighting(scene, 0x79bfa9, 0x120b28, [-52, 94, 28], 78);

  const moon = new THREE.Mesh(
    new THREE.SphereGeometry(11, 28, 18),
    new THREE.MeshBasicMaterial({ color: 0xd8eeff, toneMapped: false, fog: false }),
  );
  moon.position.set(-104, 105, -188);
  scene.add(moon);

  // The low slab is now only a safety bed. Moss hills, the pond basin, tunnel
  // ridge, grotto, rocks, roots, and dense trees cover and subdivide it so no
  // sightline reads as an empty rectangular arena.
  // Leave a real opening beneath the pond instead of placing water over the
  // arena's ground slab. Four outer beds and four corner shelves frame the
  // irregular basin without changing the rest of the map's floor.
  for (const [x, z, w, d, repeat] of [
    [-50, 0, 64, 164, [10, 24]], [52, 0, 60, 164, [10, 24]],
    [2, -66, 40, 32, [7, 5]], [2, 30.6, 40, 102.8, [7, 16]],
    [-12.1, -46.6, 10.6, 6.8, [2, 1]], [16.55, -46.6, 9.5, 6.8, [2, 1]],
    [-12.1, -24.5, 10.6, 7.4, [2, 1]], [16.55, -24.5, 9.5, 7.4, [2, 1]],
    [-17.7, -35.4, 0.6, 29.2, [1, 5]], [21.65, -35.4, 0.7, 29.2, [1, 5]],
  ]) addBox(scene, world, x, -0.72, z, w, 1.44, d, 0x183d2d, {
    tex: 'grass', repeat, debugName: 'mycelium-understory-bed',
  });
  // The perimeter must contain players launched from the upper branch network,
  // not only people walking at ground level. Raise the continuous rock ring
  // above every playable canopy route and bury its foot below the safety bed so
  // there is no ledge or lower seam to slip through.
  const boundaryWallBottom = -2;
  const boundaryWallTop = 36;
  const boundaryWallHeight = boundaryWallTop - boundaryWallBottom;
  for (const [x, z, w, d] of [[0, -82, 168, 4], [0, 82, 168, 4], [-82, 0, 4, 168], [82, 0, 4, 168]]) {
    addBox(scene, world, x, boundaryWallBottom + boundaryWallHeight / 2, z,
      w, boundaryWallHeight, d, 0xc7d1ca, {
        tex: 'mycelium-mossy-slab', repeat: [3, 1.5], debugName: 'mycelium-perimeter-wall',
      });
  }
  // Keep the new art between the north-wall shelf clusters. At this height it
  // reads from the ground and branch routes without blocking either climb.
  for (const x of [-23, 23]) addDecal(scene, 'poster-mycelium', x, 14, -79.94, 10, 0);
  // Scattered bracket-fungus stair clusters grow from the inward faces. Each
  // starts near ground height and retains exact shelf collision, making these
  // useful little wall perches rather than unreachable decoration.
  for (const [x, y, z, yaw, scale, seed, count] of [
    [-48, 0.9, -79.92, 0, 1.02, 22, 4],
    [43, 1.05, -79.92, 0, 0.92, 27, 3],
    [-55, 0.9, 79.92, Math.PI, 0.95, 31, 3],
    [47, 1.1, 79.92, Math.PI, 1.05, 36, 4],
    [-79.92, 1, -24, Math.PI / 2, 0.98, 41, 3],
    [-79.92, 0.9, 47, Math.PI / 2, 1.04, 46, 4],
    [79.92, 1.05, -39, -Math.PI / 2, 1, 51, 4],
    [79.92, 0.95, 34, -Math.PI / 2, 0.94, 56, 3],
  ]) addMyceliumShelfFungi(scene, world, x, y, z, yaw, scale, seed, count);

  // Very large meshes buried almost completely below grade leave broad,
  // gentle caps above the floor. The old smaller hills reached similar
  // heights over much tighter footprints, producing slopes too steep to walk.
  // On the waterfall's west side, widen the low outer cap into the taller
  // grotto hill. Their overlapping silhouettes form the same gradual uphill
  // route that already works on the east side, without restoring a ramp. Pull
  // its north edge away from the perimeter wall just enough to turn the small
  // rear slit into a readable one-player exterior approach.
  addAsteroid(scene, world, -61, 6.5 - 46, -45.5, 46, 0x31583f, true, {
    scaleX: 1.35, scaleZ: 1.2, lockRotation: true,
  });
  for (const [x, z, radius, height] of [
    [60, -49, 48, 6.5],
    [66, 25, 48, 7], [-28, 69, 44, 6], [29, 70, 44, 6],
    [-21, 14, 19, 2.8], [23, 18, 20, 2.8],
    [-12, 38, 18, 2.5], [14, 43, 19, 2.6],
  ]) addAsteroid(scene, world, x, height - radius, z, radius, 0x31583f, true);

  // The central clearing now has a landmark at ground and canopy height: a
  // full-size hollow trunk through the terrain whose roof doubles as a ridge.
  addHollowMyceliumLogTunnel(scene, world, 0, 31, 50, 5.4);

  // A real tunnel passes beneath the western ridge. The planted roof is an
  // upper fighting route, while the two rock-framed mouths lead through a
  // lower, softly lit shortcut.
  // Its overlapping boulders below carry their own closely matched ellipsoid
  // colliders. Do not add a continuous hidden box shell here: any gap visibly
  // left between those stones should also be a real side entrance.
  // The surrounding closed boulders provide the tunnel's visible walls and
  // ceiling from both inside and outside. Flat interior planes protruded at
  // the mouths as paper-thin fins, especially from shallow viewing angles.
  // Let the overlapping boulders define both ridge exteriors. A freestanding
  // grass ramp here read as a geometric wedge rather than part of the terrain.
  const tunnelLightA = new THREE.PointLight(0x70ffd0, 18, 24);
  tunnelLightA.position.set(-52, 2.8, 25);
  const tunnelLightB = new THREE.PointLight(0xa06fff, 18, 24);
  tunnelLightB.position.set(-52, 2.8, 49);
  scene.add(tunnelLightA, tunnelLightB);

  // Waterfall grove: an irregular boulder shore encloses a genuinely deep,
  // rounded pond. Behind the
  // falling water, a low passage opens into the purple-lit secret chamber;
  // the same rock mass is a climbable shelf above the grotto.
  const myceliumPondPoints = [
    [2, -20.8], [10.5, -22.4], [18.3, -27.8], [21.3, -35.2],
    [18.8, -42.7], [11.8, -48.1], [2.5, -50], [-6.8, -48.4],
    [-14.7, -43.4], [-17.4, -36], [-15.2, -28.7], [-7, -23],
  ];
  addMyceliumPondBasin(scene, world, myceliumPondPoints, 2, -35.5, -4.4, {
    // The pond's real north ramp and the cave bed already meet beneath the
    // waterfall. Shore-apron support cells here overlapped that ramp into an
    // invisible step that stopped swimmers before they reached the cave.
    supportClearZones: [{ minX: -7, maxX: 7, minZ: -54.5, maxZ: -47 }],
  });
  addWater(scene, world, 2, 0.2, -35.4, 40, 29.2, 4.6, { points: myceliumPondPoints });
  // The same reactive minnow school used in Canopy patrols the broad center of
  // the pond, safely inside its irregular shore even while fleeing swimmers.
  addMinnowSchool(scene, world, 2, -35.4, 9, 1.7, 0.2);
  // A second school patrols the eastern half on its own shorter route, keeping
  // the two groups visually distinct while both remain clear of the shore.
  addMinnowSchool(scene, world, 10.5, -35.4, 7, 4.2, 0.2);
  // Carry the roof's exposed mossy-rock finish onto both flanking grotto hills
  // so the cave reads as one continuous formation instead of a textured roof
  // wedged between two plain dark-green masses.
  const grottoHillFinish = {
    materialColor: 0xffffff,
    tex: 'mycelium-mossy-rock',
    repeat: [3, 3],
    roughness: 0.99,
    emissive: 0x526858,
    emissiveIntensity: 0.2,
  };
  addAsteroid(scene, world, -25, -7, -62, 18, 0x2f4d3d, true, grottoHillFinish);
  // Broaden the eastern waterfall hill toward the large outer hillside while
  // preserving its crown height and pond-facing depth. Its exact mesh remains
  // the collider, so the new overlapping terrain replaces the former ramp.
  addAsteroid(scene, world, 25, -7, -62, 18, 0x2f4d3d, true, {
    ...grottoHillFinish,
    scaleX: 1.55, scaleZ: 1.08, lockRotation: true,
  });
  // Only the buried rear seal is box-shaped. The visible exterior is the pair
  // of rounded cliff masses plus the natural terrain bridge below.
  world.colliders.push(
    { type: 'box', min: V(-9, 0, -77.3), max: V(9, 7.4, -75.5) },
  );
  addMyceliumGrottoRoof(scene, world);
  // The north understory bed already provides an exact y=0 cave floor. Keep
  // that continuous meadow surface exposed instead of laying a slightly
  // raised rectangular slab over the walking route.
  addWaterfall(scene, world, 0, -48, 13, 9.5, 0.2, 9.7, 0.8, {
    skipLip: true, passThrough: true, lipColor: 0x315141,
  });
  const caveLight = new THREE.PointLight(0x9b6cff, 48, 33);
  caveLight.position.set(0, 3.8, -66);
  const fallLight = new THREE.PointLight(0x51e2ff, 34, 34);
  fallLight.position.set(0, 5.2, -43);
  scene.add(caveLight, fallLight);

  const rockSpecs = [];
  // Pond stones create an organic shoreline while leaving four approach gaps.
  for (let i = 0; i < 22; i++) {
    const angle = i * Math.PI * 2 / 22;
    if (Math.abs(Math.cos(angle)) > 0.9 || Math.abs(Math.sin(angle)) > 0.82) continue;
    const radius = 1.4 + (i % 4) * 0.28;
    rockSpecs.push([
      2 + Math.cos(angle) * 19.2,
      radius * 0.48,
      -35.5 + Math.sin(angle) * 13.3,
      radius, radius * (0.62 + (i % 2) * 0.12), radius * 0.92,
      i % 3 !== 0,
    ]);
  }
  // Grotto facade and upper shelf use deliberately non-uniform spacing. The
  // former row of same-height rocks read like a wall of traffic barriers.
  for (let i = 0; i < 28; i++) {
    const side = i % 2 ? -1 : 1;
    const n = Math.floor(i / 2);
    const radius = 1.8 + ((i * 7) % 5) * 0.38;
    rockSpecs.push([
      side * (7.4 + ((n * 3) % 6) * 4.1),
      1.3 + ((n * 5) % 5) * 1.85,
      -48.5 - ((n * 7) % 6) * 4.7,
      radius, radius * (0.68 + (i % 3) * 0.08), radius * (0.88 + (i % 2) * 0.15),
      n % 4 === 0,
    ]);
  }
  rockSpecs.push(
    [-7.2, 7.5, -48.7, 3.4, 2.5, 3.1, true],
    [7.1, 7.8, -48.4, 3.7, 2.6, 3.2, true],
    [-2.7, 10.1, -49.2, 3.4, 2.3, 3.1, false],
    [3.2, 10.4, -49.8, 3.2, 2.4, 3.4, false],
  );
  for (const z of [16, 57]) for (let i = 0; i < 10; i++) {
    const angle = Math.PI * i / 9;
    const radius = 1.8 + (i % 3) * 0.4;
    rockSpecs.push([-52 + Math.cos(angle) * 10.6, 3.2 + Math.sin(angle) * 4.6,
      z, radius, radius * 0.8, radius, true, { upright: true, yaw: angle * 0.18 }]);
  }
  // Keep an unmistakable sixteen-meter-wide walking channel between the side
  // stones. Upright, slightly raised roof rocks preserve almost five meters of
  // headroom while still overlapping the walls into one natural ridge.
  for (const z of [21, 32, 44, 55]) {
    rockSpecs.push([-65.5, 3.1, z, 5.5, 4.5, 6.8, true, { upright: true }]);
    rockSpecs.push([-38.5, 3.0, z + 1.4, 5.4, 4.4, 6.5, true, { upright: true }]);
  }
  for (const [z, offset] of [[22, -1.4], [34, 1.1], [46, -0.6], [54, 1.5]]) {
    rockSpecs.push([-52 + offset, 7.6, z, 10.2, 2.8, 6.8, true, { upright: true }]);
  }
  for (const spec of [
    [-73, 1.4, -8, 3.4, 2.1, 4.1], [-68, 1.2, -17, 2.7, 1.8, 3.2],
    [71, 1.4, 3, 3.5, 2.1, 4], [57, 1.2, 55, 3, 1.8, 3.6],
    [-28, 1.2, 66, 3.1, 1.7, 3.8], [26, 1.3, 61, 3.4, 1.9, 3.2],
  ]) rockSpecs.push([...spec, true]);
  addMyceliumRockField(scene, world, rockSpecs);
  // The rendered understory bed is intentionally thin, but the earth beneath
  // this tight rock formation must not be. Add the subgrade after the boulder
  // colliders so even an unusually large final rock push is caught and sent
  // back to the exact visible y=0 walking surface in the same collision pass.
  // Its entire volume is below grade, so it cannot create an invisible wall or
  // alter any of the visible side entrances around the tunnel.
  world.colliders.push({
    type: 'box',
    min: V(-75, world.killY - 80, 10),
    max: V(-30, 0, 63),
    debugName: 'mycelium-scatter-tunnel-solid-earth',
  });
  (world.hardFloorZones ||= []).push({
    minX: -75, maxX: -30, minZ: 10, maxZ: 63, y: 0,
  });
  // A few of the larger isolated rocks carry low two-step brackets. Keep them
  // away from the pond approaches and tunnel mouths so they read as optional
  // perches rather than required route blockers.
  addMyceliumShelfFungi(scene, world, -69.9, 0.85, -8, Math.PI / 2, 0.9, 11, 2);
  addMyceliumShelfFungi(scene, world, 67.8, 0.85, 3, -Math.PI / 2, 0.92, 13, 2);
  addMyceliumShelfFungi(scene, world, -7.2, 7.05, -45.75, 0, 0.95, 15, 2);
  addMyceliumShelfFungi(scene, world, 7.1, 7.25, -45.45, 0, 0.9, 17, 2);

  // Seven climbable elder trees anchor a web of walkable limbs. The upper
  // branches cross the pond and reach the waterfall shelf, so vertical combat
  // is a route network rather than isolated square platforms.
  const elderTrees = [
    [-37, 0, -5, [7, 14], 1], [37, 0, -4, [7, 14], 3],
    [-31, 0, 44, [7, 13], 4], [29, 0, 43, [8, 15], 5],
    [-23, 0, -34, [7, 14], 6], [24, 0, -34, [7, 14], 7],
    // The rear elder stands on the grotto roof rather than a rounded hill.
    // Embed it only a few centimeters so its trunk cannot poke through the
    // cave ceiling below.
    [0, 10, -63, [16, 23], 8, { burialDepth: 0.35 }],
  ];
  for (const [x, baseY, z, decks, seed, options] of elderTrees) {
    addMyceliumTree(scene, world, x, baseY, z, decks, seed, options);
  }
  addHollowMyceliumTree(scene, world, 0, 0, 8);
  for (const [a, b, radius, options] of [
    [V(-37, 7, -5), V(-7, 8, 8), 1.18], [V(7, 8, 8), V(37, 7, -4), 1.18],
    [V(-37, 7, -5), V(-31, 7, 44), 1.12], [V(37, 7, -4), V(29, 8, 43), 1.12],
    [V(-37, 7, -5), V(-23, 7, -34), 1.05], [V(37, 7, -4), V(24, 7, -34), 1.05],
    [V(-31, 13, 44), V(29, 15, 43), 1.02],
    [V(-23, 14, -34), V(0, 16, -63), 1.08], [V(24, 14, -34), V(0, 16, -63), 1.08],
    [V(-37, 14, -5), V(-7, 15, 8), 0.98], [V(7, 15, 8), V(37, 14, -4), 0.98],
    [V(-31, 7, 44), V(-20, 10.55, 31), 1.08,
      { crownEndInset: 4.6, debugName: 'hollow-log-west-approach' }],
    [V(20, 10.55, 31), V(29, 8, 43), 1.08,
      { crownStartInset: 4.6, debugName: 'hollow-log-east-approach' }],
    [V(-31, 13, 44), V(-5, 15, 13), 1.0], [V(5, 15, 13), V(29, 15, 43), 1.0],
    [V(-37, 14, -5), V(-31, 13, 44), 0.98], [V(37, 14, -4), V(29, 15, 43), 0.98],
  ]) addWalkableMyceliumBranch(scene, world, a, b, radius, options);

  addDenseMyceliumForest(scene, world, [
    [-73, 0, 67, 15, 4.7], [-61, 0, 65, 17, 5.2], [-49, 7.5, 35, 15, 4.7],
    [-70, 0, 2, 16, 5], [-68, 3.6, -39, 16, 5.2], [-53, 3.7, -58, 15, 4.6],
    [-35, 7.1, -67, 17, 5.4], [-18, 5.4, -73, 15, 4.6], [18, 5.4, -73, 15, 4.8],
    [35, 7.1, -67, 18, 5.4], [56, 5.2, -58, 16, 5], [69, 2.9, -39, 17, 5.3],
    [72, 0, -7, 15, 4.6], [70, 7.1, 20, 17, 5.2], [68, 0, 57, 17, 5],
    [53, 0, 67, 15, 4.6], [12, 0, 70, 15, 4.8], [-8, 0, 72, 16, 5],
    [-46, 0, 66, 15, 4.7],
    [-56, 0, 3, 13, 4.2], [57, 0, 4, 14, 4.4], [-50, 0, -24, 14, 4.6],
    [50, 0, -24, 13, 4.3], [-70, 0, 34, 15, 4.7], [70, 0, 40, 15, 4.7],
  ]);

  // Large caps are traversal objects. They launch on a landing or on lateral
  // body contact, so charging through a cap is impossible.
  addBouncyMushroom(scene, world, -17, 0, -14, 0.55, 3.5, 18.5, 0xc35cff, -3.5, -7.5);
  addBouncyMushroom(scene, world, 18, 0, -13, 0.5, 3.6, 19.5, 0x4fd6ff, 4.2, -7.2);
  addBouncyMushroom(scene, world, -63, 0, -3, 0.7, 3.2, 16.5, 0xff789e, 6.8, 3.2);
  addBouncyMushroom(scene, world, 62, 0, 12, 0.65, 3.4, 17.5, 0x6ff0ad, -6.7, 2.8);
  // Clears the nearby tall-cap chain: the descending arc lands around the
  // broad platform at (-10, 15, 55), rather than peaking below its rim.
  addBouncyMushroom(scene, world, -19, 0, 58, 0.65, 3.3, 22.5, 0xffbd55, 4.8, -2.4);
  addBouncyMushroom(scene, world, 17, 0, 59, 0.58, 3.5, 17.5, 0x8c77ff, -4.8, -2.6);
  addBouncyMushroom(scene, world, -52, 7.5, 37, 0.65, 3.1, 17.5, 0x65f2d1, 5.6, -2.2);
  addBouncyMushroom(scene, world, 29, 10, -60, 0.7, 3.2, 17.5, 0x67f0cf, -5.2, 4.8);

  // The grassy shelf above the waterfall sits beneath the rear elder tree's
  // first balcony. Launch inward from beyond the balcony rim so players rise
  // past its outer edge and land on top instead of striking its underside.
  // The widened mossy hill now reaches y≈10.07 at this spot; keep the launcher
  // rooted on that visible surface instead of leaving its cap buried beneath
  // the terrain with only the decorative white spots showing.
  const waterfallShelfLauncher = addBouncyMushroom(
    scene, world, 15, 10.1, -62, 0.5, 1.8, 16.5, 0x72f2da, -6.2, 0,
  );
  wp(world, 15, waterfallShelfLauncher.topY, -62);
  world.manualLinks.push([15, waterfallShelfLauncher.topY, -62, 0, 16, -63, true]);

  // Broad, non-bouncy caps form real mid-air rooms and stepping-stone routes.
  // The lower trio wraps around the log ridge; the rear chain gives the upper
  // village a second route that is exposed and jump-based instead of a limb.
  for (const spec of [
    [-16, 8, 22, 4.6, 0x8b69df, 1], [0, 9.5, 21, 4.8, 0x4dbfa9, 2], [16, 8, 22, 4.6, 0xd269a9, 3],
    [-20, 14, 51, 4.3, 0xb667d5, 4], [-10, 15, 55, 4.2, 0x5caed4, 5],
    [0, 15.5, 56, 4.4, 0xe17aa7, 6], [10, 15, 55, 4.2, 0x6ccf9b, 7],
    [20, 14.5, 51, 4.3, 0xb08bea, 8],
    [-12, 18.5, -44, 4.1, 0x5dbfc0, 9], [-7.5, 20, -52, 4.4, 0xad75e8, 10],
    [7.5, 20, -52, 4.4, 0x6cbfd6, 11], [12, 18.5, -44, 4.1, 0xeb7caa, 12],
  ]) addPlatformMushroom(scene, world, ...spec);

  // The outer east and west clearings were visually flat compared with the
  // center canopy. These mirrored, non-bouncy platforms create side routes
  // that rise back toward the elder-tree branches instead of ending at the
  // perimeter wall.
  for (const spec of [
    [-63, 5.5, -19, 5.2, 0x58c9b0, 21],
    [-54, 9, -9, 5.0, 0xb06ddd, 22],
    [-46, 12.5, 1, 4.8, 0xe27fa9, 23],
    [63, 5.5, -18, 5.2, 0x69bfe1, 24],
    [54, 9, -8, 5.0, 0xc873df, 25],
    [46, 12.5, 2, 4.8, 0x66d39f, 26],
  ]) addPlatformMushroom(scene, world, ...spec);

  // Small directional caps carry players up each new three-platform chain;
  // exterior vines make both routes reversible from ground level.
  addBouncyMushroom(scene, world, -63, 5.5, -19, 0.35, 1.25, 13.5, 0x7af2cf, 7.9, 8.8);
  addBouncyMushroom(scene, world, -54, 9, -9, 0.35, 1.25, 13.5, 0xd58aff, 7.0, 8.8);
  addBouncyMushroom(scene, world, 63, 5.5, -18, 0.35, 1.25, 13.5, 0x7edcff, -7.9, 8.8);
  addBouncyMushroom(scene, world, 54, 9, -8, 0.35, 1.25, 13.5, 0xe08bff, -7.0, 8.8);
  const westOuterVine = [-65.71, -23.51];
  const eastOuterVine = [68.26, -18];
  addVine(scene, world, westOuterVine[0], westOuterVine[1], 0.1, 5.65, 0.95,
    -0.12, -0.1, 0.514, 0.857, 0.18, 1.3, 0x66e6a0);
  addVine(scene, world, eastOuterVine[0], eastOuterVine[1], 0.1, 5.65, 0.95,
    0.12, 0, -1, 0, 0.18, 1.3, 0x9c78ff);
  wp(world, westOuterVine[0], 0.1, westOuterVine[1]);
  wp(world, eastOuterVine[0], 0.1, eastOuterVine[1]);
  world.manualLinks.push(
    [westOuterVine[0], 0.1, westOuterVine[1], -63, 5.5, -19],
    [-63, 5.5, -19, -54, 9, -9],
    [-54, 9, -9, -46, 12.5, 1],
    [-46, 12.5, 1, -37, 14, -5],
    [eastOuterVine[0], 0.1, eastOuterVine[1], 63, 5.5, -18],
    [63, 5.5, -18, 54, 9, -8],
    [54, 9, -8, 46, 12.5, 2],
    [46, 12.5, 2, 37, 14, -4],
  );

  // Mini caps on the lower platforms are directional elevators to the upper
  // ring and its outgoing branches, rather than generic straight-up pads.
  addBouncyMushroom(scene, world, -16, 8, 22, 0.35, 1.35, 16.5, 0x73f1cf, 5.2, -5.2);
  addBouncyMushroom(scene, world, 16, 8, 22, 0.35, 1.35, 16.5, 0xff85bd, -5.2, -5.2);
  addBouncyMushroom(scene, world, -12, 18.5, -44, 0.3, 1.25, 14.5, 0x7bf5de, 4.8, -3.5);
  addBouncyMushroom(scene, world, 12, 18.5, -44, 0.3, 1.25, 14.5, 0xff92c8, -4.8, -3.5);

  // Vines make each new chain reversible and create deliberate up/down loops.
  addVine(scene, world, -20.1, 23.4, 0.1, 8.15, 0.9, -0.15, 0.1, 1, -0.15,
    0.18, 1.25, 0x66e6a0);
  addVine(scene, world, 11.5, 23.21, 0.1, 8.15, 0.9, -0.17, 0.05, 0.966, -0.259,
    0.18, 1.25, 0xa878ef);
  addVine(scene, world, -15.64, 51, 0.1, 14.15, 0.9, 0.18, 0, -1, 0,
    0.18, 1.25, 0x67efb2);
  addVine(scene, world, 15.64, 51, 0.1, 14.65, 0.9, -0.18, 0, 1, 0,
    0.18, 1.25, 0x9c76ed);
  addVine(scene, world, -7.5, -47.54, 10.1, 20.15, 0.95, 0, 0.18, 0, -1,
    0.18, 1.35, 0x7fe6bd);

  addMyceliumGrassTufts(scene, world, 9000);
  addMyceliumLeafLitter(scene, world, 1100);
  addMyceliumPatch(scene, world, 118);
  addMyceliumSpores(scene, world);
  addMyceliumFairyToads(scene, world);

  // A few fallen trunks close short sightlines without forming a parking-grid
  // obstacle course; each is embedded at the foot of a hill or tree cluster.
  for (const [x, z, w, d] of [
    [-66, 12, 15, 2.3], [65, 51, 14, 2.2], [-12, 53, 13, 2.2],
    [51, -16, 2.2, 14], [-48, -20, 2.2, 13],
  ]) addMyceliumLog(scene, world, x, z, w, d);

  world.spawns.blue.push(
    V(-72, 0.1, 55), V(-72, 0.1, -25), V(-34.2, 7.2, -5), V(-10, 10.2, -66),
  );
  world.spawns.red.push(
    V(72, 0.1, 55), V(72, 0.1, -25), V(34.2, 7.2, -4), V(10, 10.2, -66),
  );
  world.spawns.ffa.push(
    ...world.spawns.blue, ...world.spawns.red,
    V(0, 0.1, 63), V(0, 0.1, 18), V(3.1, 8.2, 8), V(3.1, 15.2, 8),
    V(0, 0.25, -63), V(-52, 7.7, 43),
  );

  pk(world, 'weapon', -52, 0.2, 35, { weapon: 'scatter' });
  pk(world, 'ammo', -52, 0.2, 45, { weapon: 'scatter' });
  // These sit on the curved eastern hill's exact polygon surface rather than
  // on the y=0 understory floor beneath it.
  pk(world, 'weapon', 63, 3.6, 43, { weapon: 'pulsar' });
  pk(world, 'ammo', 57, 0.4, 48, { weapon: 'pulsar' });
  pk(world, 'weapon', -37, 7.2, 1, { weapon: 'sidewinder' });
  pk(world, 'ammo', -37, 14.2, -8, { weapon: 'sidewinder' });
  pk(world, 'weapon', 37, 7.2, 2, { weapon: 'zooka' });
  pk(world, 'ammo', 37, 14.2, -7, { weapon: 'zooka' });
  pk(world, 'weapon', 0, 15.2, 5, { weapon: 'parasite' });
  pk(world, 'ammo', -7, 15.2, 10, { weapon: 'parasite' });
  pk(world, 'weapon', 0, 0.25, -69, { weapon: 'whomper' });
  pk(world, 'ammo', 5, 0.25, -63, { weapon: 'whomper' });
  // Keep the upper-ring reward clear of the elder tree's trunk volume.
  pk(world, 'weapon', -5, 23.2, -63, { weapon: 'hyper' });
  pk(world, 'ammo', 7, 16.2, -60, { weapon: 'hyper' });
  pk(world, 'health', -57, 0.2, 63);
  pk(world, 'health', 55, 0.2, 66);
  pk(world, 'shield', 0, 0.2, 36);
  pk(world, 'speed', -25, 0.2, -19);
  // Three Double Jumps total: one in the central understory and one atop each
  // outer mushroom chain, where the mobility reward naturally feeds into the
  // neighboring upper branches without overlapping the chain's bounce pads.
  pk(world, 'djump', 27, 0.2, -18);
  pk(world, 'djump', -46, 12.7, 1);
  pk(world, 'djump', 46, 12.7, 2);
  pk(world, 'silver', -4, 0.25, -72);
  pk(world, 'gold', 5, 23.2, -66);
  pk(world, 'star', 0, 0.25, -73, { hidden: true });
  pk(world, 'star', -52, 7.7, 30, { hidden: true });

  for (const [x, y, z] of [
    [-72, 0, 55], [-60, 0, 58], [-34, 0, 60], [0, 0, 63], [34, 0, 60], [60, 0, 58], [72, 0, 55],
    [-70, 0, 5], [-56, 0, -12], [-35, 0, -18], [0, 0, 3], [35, 0, -18], [56, 0, -12], [70, 0, 5],
    [-20, 0, 26], [0, 0, 28], [20, 0, 26], [-22, 0, -19], [22, 0, -19],
    [-18, 0, -24], [18, 0, -24], [-15, 0.2, -43], [15, 0.2, -43],
    [0, 0.2, -52], [0, 0.2, -63], [0, 0.2, -71],
    [-52, 0, 18], [-52, 0, 28], [-52, 0, 40], [-52, 0, 54], [-52, 7.5, 37],
    [-61, 6.4, -49], [60, 6.4, -49], [66, 6.9, 25], [-28, 5.9, 69], [29, 5.9, 70],
    [-24, 10, -63], [0, 10, -58.5], [24, 10, -63],
    [-66, 0, 30], [66, 0, 30], [-72, 0, -25], [72, 0, -25],
    [-10, 0, -8], [10, 0, -8], [-50, 0, -63], [50, 0, -63],
    [-28, 0, 37], [-52, 7.5, 43],
    // West-rear grotto entrance: follow the open strip beside the north wall,
    // then angle inward beneath the raised rock arch.
    [-50, 0, -77], [-34, 0, -76.5], [-27, 0, -78.2],
    [-19, 0, -77.7], [-10, 0, -76.5], [-3, 0, -73.8],
  ]) wp(world, x, y, z);
  const linkRoute = points => {
    for (let i = 1; i < points.length; i++) {
      world.manualLinks.push([...points[i - 1], ...points[i]]);
    }
  };
  linkRoute([[-72, 0, 55], [-60, 0, 58], [-34, 0, 60], [0, 0, 63], [34, 0, 60], [60, 0, 58], [72, 0, 55]]);
  linkRoute([[-72, 0, 55], [-66, 0, 30], [-70, 0, 5], [-72, 0, -25], [-56, 0, -12]]);
  linkRoute([[72, 0, 55], [66, 0, 30], [70, 0, 5], [72, 0, -25], [56, 0, -12]]);
  linkRoute([[-70, 0, 5], [-56, 0, -12], [-35, 0, -18], [-22, 0, -19], [-10, 0, -8], [0, 0, 3], [10, 0, -8], [22, 0, -19], [35, 0, -18], [56, 0, -12], [70, 0, 5]]);
  linkRoute([[0, 0, 63], [0, 0, 28], [0, 0, 3]]);
  linkRoute([[-56, 0, -12], [-35, 0, -18], [-18, 0, -24], [-15, 0.2, -43], [0, 0.2, -52], [0, 0.2, -63], [0, 0.2, -71]]);
  linkRoute([[56, 0, -12], [35, 0, -18], [18, 0, -24], [15, 0.2, -43], [0, 0.2, -52]]);
  linkRoute([[-66, 0, 30], [-52, 0, 18], [-52, 0, 28], [-52, 0, 40], [-52, 0, 54], [-60, 0, 58]]);
  linkRoute([[-52, 7.5, 37], [-52, 7.5, 43], [-28, 0, 37]]);
  // Bend the upper shelf route around the rear elder trunk. The former center
  // node sat inside the bark collider and made bots walk straight into it.
  linkRoute([[-50, 0, -63], [-24, 10, -63], [0, 10, -58.5], [24, 10, -63], [50, 0, -63]]);
  // Keep the new back entrance in the authored navigation graph. The slight
  // bend toward the wall follows the exact clear ground between the broad hill
  // and perimeter, then rejoins the existing cave route at its rear pickup.
  linkRoute([[-50, 0, -77], [-34, 0, -76.5], [-27, 0, -78.2],
    [-19, 0, -77.7], [-10, 0, -76.5], [-3, 0, -73.8], [0, 0.2, -71]]);
  linkRoute([[-72, 0, -25], [-61, 6.4, -49], [-50, 0, -63]]);
  linkRoute([[72, 0, -25], [60, 6.4, -49], [50, 0, -63]]);
  linkRoute([[70, 0, 5], [66, 6.9, 25], [66, 0, 30]]);
  linkRoute([[-34, 0, 60], [-28, 5.9, 69]]);
  linkRoute([[34, 0, 60], [29, 5.9, 70]]);
  linkRoute([[-31, 13, 44], [-20, 14, 51], [-10, 15, 55], [0, 15.5, 56], [10, 15, 55], [20, 14.5, 51], [29, 15, 43]]);
  linkRoute([[-23, 14, -34], [-12, 18.5, -44], [-7.5, 20, -52], [7.5, 20, -52], [12, 18.5, -44], [24, 14, -34]]);
  linkRoute([[-31, 7, 44], [-16, 8, 22], [0, 9.5, 21], [16, 8, 22], [29, 8, 43]]);
  world.manualLinks.push(
    [-52, 0, 18, -52, 0, 28], [-52, 0, 40, -52, 0, 54],
    [-52, 0, 28, -52, 7.5, 37], [0, 0.2, -52, 0, 10, -58.5],
    [0, 0.1, 8, 4.2, 15, 8, true],
    [-20, 0, 26, 0, 0, 28], [20, 0, 26, 0, 0, 28],
    [-20.1, 0.1, 23.4, -16, 8, 22, true], [20.1, 0.1, 23.4, 16, 8, 22, true],
    [-16, 8, 22, -4.7, 15, 8, true], [16, 8, 22, 4.7, 15, 8, true],
    [-15.64, 0.1, 51, -20, 14, 51, true], [15.64, 0.1, 51, 20, 14.5, 51, true],
    [-7.5, 10.1, -56.1, -7.5, 20, -52, true],
  );

  mergeStatic(scene, world);
  return world;
}

/* ================= SECRET MAP — SUNKEN REEF =================
   A fully swimmable coral basin with a breathable surface above it. The inner
   seabed is a real heightfield of ridges, trenches, shelves, and bowls; beyond
   it the bottom and water continue into fog while boundary sharks intercept
   anyone trying to reach the unseen physical edge. */
function reefSurfaceY(x, z) {
  const r = Math.hypot(x, z);
  const mound = (cx, cz, height, spread) => {
    const dx = x - cx, dz = z - cz;
    return height * Math.exp(-(dx * dx + dz * dz) / spread);
  };
  let y = -39;
  y += mound(-48, -18, 18, 920);
  y += mound(43, 30, 15, 760);
  y += mound(8, -55, 13, 620);
  y += mound(-12, 48, 10, 520);
  y += mound(0, 0, 8, 1350);
  y -= mound(27, -12, 8, 360);      // east trench
  y -= mound(-28, 34, 5.5, 300);    // north bowl
  y += Math.sin(x * 0.105) * Math.cos(z * 0.087) * 1.7;
  y += Math.sin((x + z) * 0.052) * 1.25;
  const edgeFade = THREE.MathUtils.smoothstep(r, 92, 126);
  return THREE.MathUtils.lerp(THREE.MathUtils.clamp(y, -43.5, -17.5), -44.5, edgeFade);
}

function reefGroundRangeUnder(x, z, halfWidth, halfDepth) {
  let low = Infinity;
  let high = -Infinity;
  // Match the heightfield's faceted variation more safely than one center
  // sample. Corners, edges, and interior points catch a hill falling away
  // beneath one side of a wide coral base.
  for (const ux of [-1, -0.5, 0, 0.5, 1]) {
    for (const uz of [-1, -0.5, 0, 0.5, 1]) {
      const ground = reefSurfaceY(x + ux * halfWidth, z + uz * halfDepth);
      low = Math.min(low, ground);
      high = Math.max(high, ground);
    }
  }
  return { low, high };
}

function reefCoralTexture(color, requested = null) {
  if (requested) return requested;
  // Every coral species uses surface art, including the small plates and the
  // pieces that previously fell back to flat rock. Keep a deterministic color
  // family so connected structures retain one continuous biological pattern.
  if (color === 0xd95362) return 'coral-brain-red';
  if (color === 0x388bc1 || color === 0x2faf8a) return 'coral-cup-blue';
  return 'coral-plate-pink';
}

const reefGrowthMaterials = [
  mat(0x2e8f62, { roughness: 0.9, side: THREE.DoubleSide }),
  mat(0x52b16f, { roughness: 0.88, side: THREE.DoubleSide }),
  mat(0x7a9e42, { roughness: 0.92, side: THREE.DoubleSide }),
  mat(0x279488, { roughness: 0.86, side: THREE.DoubleSide }),
];

function addReefFrondCluster(scene, world, x, y, z, seed, scale = 1, tilt = 0) {
  const rnd = seededRandom(seed);
  const root = new THREE.Group();
  root.position.set(x, y, z);
  root.rotation.z = tilt;
  const frondCount = 3 + Math.floor(rnd() * 4);
  const geometries = [];
  for (let i = 0; i < frondCount; i++) {
    const height = scale * (1.1 + rnd() * 2.5);
    const leanX = (rnd() - 0.5) * height * 0.42;
    const leanZ = (rnd() - 0.5) * height * 0.42;
    const baseX = (rnd() - 0.5) * scale * 0.75;
    const baseZ = (rnd() - 0.5) * scale * 0.75;
    const curve = new THREE.CatmullRomCurve3([
      V(baseX, 0, baseZ),
      V(baseX + leanX * 0.18, height * 0.34, baseZ + leanZ * 0.12),
      V(baseX - leanX * 0.12, height * 0.68, baseZ + leanZ * 0.66),
      V(baseX + leanX, height, baseZ + leanZ),
    ]);
    geometries.push(new THREE.TubeGeometry(
      curve, 7, scale * (0.055 + rnd() * 0.055), 4, false,
    ));
    // A small fork makes each cluster read as leafy reef growth rather than a
    // bundle of smooth drinking straws.
    if (i % 2 === 0) {
      const fork = new THREE.ConeGeometry(scale * 0.12, height * 0.34, 4);
      fork.rotateZ((rnd() - 0.5) * 0.9);
      fork.translate(baseX + leanX * 0.25, height * 0.6, baseZ + leanZ * 0.3);
      geometries.push(fork);
    }
  }
  const merged = mergeGeometries(geometries, false);
  const growthMesh = new THREE.Mesh(
    merged,
    reefGrowthMaterials[Math.floor(Math.abs(seed)) % reefGrowthMaterials.length],
  );
  growthMesh.castShadow = true;
  root.add(growthMesh);
  geometries.forEach(geometry => geometry.dispose());
  scene.add(root);
  (world.reefGrowthClusters ||= []).push({
    root, baseX: root.rotation.x, baseZ: root.rotation.z,
    phase: rnd() * Math.PI * 2, sway: 0.018 + rnd() * 0.025,
  });
  return root;
}

function addReefCoralSegment(scene, world, start, end, radius, color, texture, name) {
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length < 0.1) return null;
  const geometry = new THREE.CylinderGeometry(radius * 0.78, radius, length, 6, 1, false);
  geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(
    V(0, 1, 0), delta.clone().normalize(),
  ));
  geometry.translate(
    (start.x + end.x) * 0.5,
    (start.y + end.y) * 0.5,
    (start.z + end.z) * 0.5,
  );
  const tint = new THREE.Color(color);
  if (texture) tint.lerp(new THREE.Color(0xffffff), 0.82);
  const colors = new Float32Array(geometry.attributes.position.count * 3);
  for (let i = 0; i < geometry.attributes.position.count; i++) {
    colors.set([tint.r, tint.g, tint.b], i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const colliderSource = new THREE.Mesh(geometry);
  world.colliders.push(triangleMeshColliderFromMesh(colliderSource, name));
  const key = texture || 'rock';
  (world._reefCoralSegmentGeometries ||= new Map());
  if (!world._reefCoralSegmentGeometries.has(key)) world._reefCoralSegmentGeometries.set(key, []);
  world._reefCoralSegmentGeometries.get(key).push(geometry);
  return colliderSource;
}

function flushReefCoralSegments(scene, world) {
  for (const [texture, geometries] of world._reefCoralSegmentGeometries || []) {
    const merged = mergeGeometries(geometries, false);
    const mesh = new THREE.Mesh(merged, mat(0xffffff, {
      tex: texture, repeat: [1.35, 1.35], vertexColors: true,
      roughness: 0.96, flatShading: true,
    }));
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.name = `sunken-reef-merged-coral-${texture}`;
    scene.add(mesh);
    geometries.forEach(geometry => geometry.dispose());
  }
  world._reefCoralSegmentGeometries = new Map();
}

function addReefCoralCrown(scene, world, x, baseY, z, color, texture, scale, seed, type) {
  const rnd = seededRandom(seed);
  const angle = rnd() * Math.PI * 2;
  const dir = V(Math.cos(angle), 0, Math.sin(angle));
  const side = V(-dir.z, 0, dir.x);
  const anchorOffset = type === 'arch' ? (rnd() < 0.5 ? -5 : 5) * scale : 0;
  const anchor = V(x + anchorOffset, baseY + (type === 'shelves' ? 7.2 : 6.5) * scale, z);
  const elbow = anchor.clone()
    .addScaledVector(dir, (4.2 + rnd() * 2.2) * scale)
    .add(V(0, (2.2 + rnd() * 1.8) * scale, 0));
  addReefCoralSegment(scene, world, anchor, elbow, 1.15 * scale, color, texture,
    'sunken-reef-coral-primary-branch');

  const tips = [
    elbow.clone().addScaledVector(dir, (2.8 + rnd() * 2.1) * scale)
      .addScaledVector(side, (1.8 + rnd() * 1.5) * scale).add(V(0, 2.7 * scale, 0)),
    elbow.clone().addScaledVector(dir, (2.3 + rnd() * 1.7) * scale)
      .addScaledVector(side, -(2 + rnd() * 1.4) * scale).add(V(0, 2.1 * scale, 0)),
    elbow.clone().addScaledVector(dir, (1.2 + rnd() * 1.5) * scale)
      .add(V(0, 4.3 * scale, 0)),
  ];
  for (let i = 0; i < tips.length; i++) {
    addReefCoralSegment(scene, world, elbow, tips[i], (0.68 - i * 0.08) * scale,
      color, texture, 'sunken-reef-coral-fork');
    addReefFrondCluster(scene, world, tips[i].x, tips[i].y, tips[i].z,
      seed + 110 + i * 19, 0.38 + scale * 0.22);
  }

  // Larger colonies receive a second, lower fork on the opposite face so the
  // silhouette branches in more than one plane when approached from below.
  if (scale >= 1.02) {
    const lowerAnchor = anchor.clone().addScaledVector(side, -1.5 * scale).add(V(0, -1.4 * scale, 0));
    const lowerElbow = lowerAnchor.clone().addScaledVector(dir, -4.2 * scale)
      .addScaledVector(side, 1.5 * scale).add(V(0, 1.4 * scale, 0));
    const lowerTip = lowerElbow.clone().addScaledVector(dir, -2.5 * scale)
      .addScaledVector(side, -2.4 * scale).add(V(0, 2.3 * scale, 0));
    addReefCoralSegment(scene, world, lowerAnchor, lowerElbow, 0.9 * scale,
      color, texture, 'sunken-reef-coral-secondary-branch');
    addReefCoralSegment(scene, world, lowerElbow, lowerTip, 0.58 * scale,
      color, texture, 'sunken-reef-coral-secondary-fork');
    addReefFrondCluster(scene, world, lowerTip.x, lowerTip.y, lowerTip.z,
      seed + 207, 0.42 + scale * 0.18);
  }
}

function addBlockyReefFormation(scene, world, x, z, color, type = 'bommie', scale = 1, texture = null) {
  texture = reefCoralTexture(color, texture);
  const baseY = reefSurfaceY(x, z) - 0.35;
  const blocks = [];
  if (type === 'arch') blocks.push(
    [-5, 3, 0, 4, 7, 5], [5, 3, 0, 4, 7, 5],
    [-5, 8.5, 0, 4, 4, 5], [5, 8.5, 0, 4, 4, 5], [0, 11, 0, 7, 4, 5],
    [-7, 2, 2.5, 3, 4, 3], [7, 2, -2.5, 3, 5, 3],
  );
  else if (type === 'shelves') blocks.push(
    [0, 2, 0, 7, 5, 7], [0, 6, 0, 5, 4, 5], [0, 10, 0, 3, 5, 3],
    [5, 4, 0, 5, 3, 5], [-5, 7, 0, 5, 3, 5], [0, 8, 5, 5, 3, 5],
  );
  else if (type === 'maze') blocks.push(
    [-5, 2, -4, 4, 5, 4], [0, 3, -4, 6, 7, 4], [5, 5, -4, 4, 11, 4],
    [-5, 5, 2, 4, 11, 4], [0, 2, 4, 6, 5, 4], [5, 3, 4, 4, 7, 4],
    [-7, 2, 7, 3, 5, 3], [7, 2, -7, 3, 5, 3],
  );
  else blocks.push(
    [0, 2, 0, 8, 5, 8], [0, 6, 0, 6, 4, 6], [0, 9.5, 0, 4, 4, 4],
    [-5, 4, 1, 5, 4, 5], [5, 3, -1, 5, 4, 5], [-2, 7, 5, 4, 4, 4],
  );
  for (let i = 0; i < blocks.length; i++) {
    const [dx, dy, dz, w, h, d] = blocks[i];
    // Generated coral maps carry their own strong species color. Keep vertex
    // tint close to white so the surface art stays intact, while retaining a
    // little block-to-block variation across each formation.
    const tintColor = new THREE.Color(color);
    if (texture) tintColor.lerp(new THREE.Color(0xffffff), 0.82);
    const tint = tintColor.offsetHSL(0, 0, (i % 3 - 1) * 0.035).getHex();
    const blockX = x + dx * scale;
    const blockZ = z + dz * scale;
    let blockY = baseY + dy * scale;
    let blockHeight = h * scale;
    const localBottom = dy - h * 0.5;
    if (localBottom <= 0.25) {
      // Grounded blocks preserve their authored top while growing a buried
      // root through the complete terrain footprint. This prevents a slope
      // from exposing a floating square underside on any side of the colony.
      const topY = blockY + blockHeight * 0.5;
      const { low } = reefGroundRangeUnder(
        blockX, blockZ, w * scale * 0.52, d * scale * 0.52,
      );
      const buriedBottomY = Math.min(blockY - blockHeight * 0.5, low - Math.max(1.2, scale * 1.5));
      blockHeight = topY - buriedBottomY;
      blockY = (topY + buriedBottomY) * 0.5;
    }
    addBox(scene, world, blockX, blockY, blockZ,
      w * scale, blockHeight, d * scale, tint, {
        tex: texture || 'rock', roughness: 0.96, debugName: `reef-${type}-${x}-${z}-${i}`,
      });
    if (i % 2 === 0) {
      addReefFrondCluster(
        scene, world,
        x + (dx + (i % 3 - 1) * w * 0.18) * scale,
        baseY + (dy + h * 0.5) * scale + 0.04,
        z + (dz + ((i + 1) % 3 - 1) * d * 0.18) * scale,
        Math.abs(x * 193 + z * 977 + i * 71),
        0.42 + scale * 0.28,
      );
    }
  }
  addReefCoralCrown(scene, world, x, baseY, z, color, texture, scale,
    Math.abs(x * 271 + z * 619 + Math.round(scale * 100)), type);
}

function addReefCoralBridge(scene, world, from, to, color, texture, seed) {
  texture = reefCoralTexture(color, texture);
  const start = V(from[0], reefSurfaceY(from[0], from[1]) + 7.5, from[1]);
  const end = V(to[0], reefSurfaceY(to[0], to[1]) + 8.2, to[1]);
  const center = start.clone().lerp(end, 0.5).add(V(0, 5.5, 0));
  const travel = end.clone().sub(start).setY(0).normalize();
  const side = V(-travel.z, 0, travel.x);
  const leftKnee = start.clone().lerp(center, 0.72).addScaledVector(side, 1.5);
  const rightKnee = end.clone().lerp(center, 0.72).addScaledVector(side, -1.5);
  const radius = 1.05;
  addReefCoralSegment(scene, world, start, leftKnee, radius, color, texture,
    'sunken-reef-connected-colony-branch');
  addReefCoralSegment(scene, world, leftKnee, center, radius * 0.88, color, texture,
    'sunken-reef-connected-colony-branch');
  addReefCoralSegment(scene, world, center, rightKnee, radius * 0.88, color, texture,
    'sunken-reef-connected-colony-branch');
  addReefCoralSegment(scene, world, rightKnee, end, radius, color, texture,
    'sunken-reef-connected-colony-branch');

  // A small fork at the bridge crest keeps the connector organic and offers a
  // recognizable high point without closing the broad swim-through below it.
  const forkA = center.clone().addScaledVector(side, 4.2).add(V(0, 2.7, 0));
  const forkB = center.clone().addScaledVector(side, -3.2).addScaledVector(travel, 1.4).add(V(0, 2.1, 0));
  addReefCoralSegment(scene, world, center, forkA, 0.62, color, texture,
    'sunken-reef-connected-colony-fork');
  addReefCoralSegment(scene, world, center, forkB, 0.54, color, texture,
    'sunken-reef-connected-colony-fork');
  addReefFrondCluster(scene, world, center.x, center.y + radius * 0.8, center.z,
    seed, 0.8);
  addReefFrondCluster(scene, world, forkA.x, forkA.y, forkA.z, seed + 31, 0.62);
}

function addReefPlateCoral(scene, x, y, z, color, seed, scale = 1) {
  const rnd = seededRandom(seed);
  const root = new THREE.Group();
  root.position.set(x, y, z);
  const texture = reefCoralTexture(color);
  const tint = new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.82);
  const material = mat(tint.getHex(), {
    tex: texture, repeat: [1.2, 1.2], roughness: 0.9,
    emissive: color, emissiveIntensity: 0.025,
  });
  const geometries = [];
  for (let i = 0; i < 3 + Math.floor(rnd() * 3); i++) {
    const width = scale * (1.1 + rnd() * 1.8);
    let height = scale * (0.45 + rnd() * 0.7);
    const depth = scale * (1.1 + rnd() * 1.8);
    const px = (rnd() - 0.5) * scale * 2.2;
    const pz = (rnd() - 0.5) * scale * 2.2;
    let py = scale * (0.35 + i * 0.7);
    if (i === 0) {
      const topY = y + py + height * 0.5;
      const { low } = reefGroundRangeUnder(x + px, z + pz, width * 0.52, depth * 0.52);
      const buriedBottomY = Math.min(y + py - height * 0.5, low - Math.max(0.4, scale * 0.55));
      height = topY - buriedBottomY;
      py = (topY + buriedBottomY) * 0.5 - y;
    }
    const plate = new THREE.BoxGeometry(width, height, depth);
    plate.translate(px, py, pz);
    geometries.push(plate);
  }
  const merged = mergeGeometries(geometries, false);
  const plates = new THREE.Mesh(merged, material);
  plates.castShadow = plates.receiveShadow = true;
  plates.name = 'sunken-reef-textured-plate-coral';
  root.add(plates);
  geometries.forEach(geometry => geometry.dispose());
  scene.add(root);
}

function createReefFishGeometry(kind, colors) {
  const proportions = {
    minnow: [1.45, 0.48, 0.48], tang: [1.05, 0.85, 0.3], butterfly: [0.9, 1.05, 0.28],
    parrot: [1.3, 0.62, 0.48], angel: [0.78, 1.22, 0.25],
  }[kind] || [1.2, 0.65, 0.4];
  const paint = (geometry, color) => {
    if (geometry.index) {
      const nonIndexed = geometry.toNonIndexed();
      geometry.dispose();
      geometry = nonIndexed;
    }
    geometry.deleteAttribute('uv');
    const c = new THREE.Color(color);
    const values = new Float32Array(geometry.attributes.position.count * 3);
    for (let i = 0; i < geometry.attributes.position.count; i++) {
      values.set([c.r, c.g, c.b], i * 3);
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(values, 3));
    return geometry;
  };
  const geometries = [];
  const body = new THREE.SphereGeometry(0.7, 8, 5);
  body.scale(...proportions);
  geometries.push(paint(body, colors[0]));
  const tailGeo = new THREE.BufferGeometry();
  tailGeo.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.78, 0, 0, -1.45, 0.7, 0, -1.45, -0.7, 0,
  ], 3));
  tailGeo.computeVertexNormals();
  tailGeo.translate(-0.15, 0, 0);
  geometries.push(paint(tailGeo, colors[1] ?? colors[0]));
  const dorsal = new THREE.ConeGeometry(0.5, 1.15, 3);
  dorsal.scale(1, 1, 0.22);
  dorsal.rotateZ(kind === 'angel' ? 0.15 : 0.45);
  dorsal.translate(-0.05, 0.75, 0);
  geometries.push(paint(dorsal, colors[1] ?? colors[0]));
  for (const side of [-1, 1]) {
    const eye = new THREE.SphereGeometry(0.075, 5, 3);
    eye.translate(0.68, 0.18, side * (proportions[2] * 0.67));
    geometries.push(paint(eye, 0x07131a));
  }
  const merged = mergeGeometries(geometries, false);
  merged.computeBoundingSphere();
  geometries.forEach(geometry => geometry.dispose());
  return merged;
}

function addReefFishLife(scene, world) {
  const schools = [];
  const species = [
    { kind: 'minnow', colors: [0x9fd7c5, 0x69ab9f], count: 18, center: [-42, -8, -5], radius: 15, size: 0.42 },
    { kind: 'minnow', colors: [0xffc95c, 0xff744d], count: 13, center: [38, -18, 31], radius: 12, size: 0.55 },
    { kind: 'tang', colors: [0x247ee5, 0xffdd3f], count: 9, center: [9, -12, -48], radius: 10, size: 0.7 },
    { kind: 'butterfly', colors: [0xffe66b, 0x272329], count: 7, center: [-50, -22, 42], radius: 9, size: 0.78 },
    { kind: 'parrot', colors: [0x36d9ba, 0xff6ca8], count: 1, center: [-12, -14, 30], radius: 18, size: 1.25, speed: 0.07 },
    { kind: 'parrot', colors: [0x55cf77, 0x4f6be8], count: 1, center: [55, -9, -21], radius: 15, size: 1.1, speed: 0.07 },
    { kind: 'angel', colors: [0xf1f3f0, 0x151a23], count: 1, center: [-63, -17, -30], radius: 12, size: 1.15, speed: 0.07 },
    { kind: 'angel', colors: [0xff8acb, 0x7c4fd6], count: 1, center: [25, -25, 8], radius: 14, size: 1.05, speed: 0.07 },
  ];
  let seed = 0;
  for (const spec of species) {
    const geometry = createReefFishGeometry(spec.kind, spec.colors);
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.5,
      metalness: 0.04, flatShading: true, side: THREE.DoubleSide,
    });
    const school = new THREE.InstancedMesh(geometry, material, spec.count);
    school.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    school.frustumCulled = false;
    school.name = `sunken-reef-${spec.kind}-school`;
    scene.add(school);
    const members = [];
    for (let i = 0; i < spec.count; i++) {
      const angle = i / spec.count * Math.PI * 2 + (i % 4) * 0.19;
      members.push({
        angle,
        lane: spec.count === 1 ? 0 : (i % 5 - 2) * 0.8,
        speed: spec.speed ?? (0.16 + (i % 4) * 0.018),
        seed: seed++,
        scale: spec.size * (spec.count === 1 ? 1 : 0.78 + (i % 5) * 0.08),
      });
    }
    schools.push({ school, spec, members });
  }
  const dummy = new THREE.Object3D();
  const updateSchools = (t) => {
    for (const { school, spec, members } of schools) {
      const [cx, cy, cz] = spec.center;
      for (let i = 0; i < members.length; i++) {
        const member = members[i];
        const a = member.angle + t * member.speed;
        dummy.position.set(
          cx + Math.cos(a) * spec.radius,
          cy + member.lane + Math.sin(t * 0.7 + member.seed) * 0.7,
          cz + Math.sin(a) * spec.radius * 0.65,
        );
        // A subtle whole-body yaw retains the readable swimming motion while
        // allowing each full fish to remain one instance rather than five
        // separately submitted meshes.
        dummy.rotation.set(0, -a + Math.sin(t * 7.5 + member.seed) * 0.055, 0);
        dummy.scale.setScalar(member.scale);
        dummy.updateMatrix();
        school.setMatrixAt(i, dummy.matrix);
      }
      school.instanceMatrix.needsUpdate = true;
    }
  };
  updateSchools(0);
  world.anim.push((_dt, t) => updateSchools(t));
}

function movingAnimalCollider(world, halfSize) {
  const collider = { type: 'box', dynamic: true, min: V(), max: V(), debugName: 'reef-sea-life' };
  world.colliders.push(collider);
  return (position, active = true) => {
    if (!active) {
      collider.min.set(9000, 9000, 9000); collider.max.set(9001, 9001, 9001); return;
    }
    collider.min.copy(position).sub(halfSize);
    collider.max.copy(position).add(halfSize);
  };
}

function createSeaTurtle() {
  const root = new THREE.Group();
  root.name = 'sunken-reef-sea-turtle';
  // A dark full shell closes the seam between the two visible halves. The
  // patterned carapace sits slightly proud of it, while a smaller cream
  // plastron leaves a green rim around the turtle when viewed from below.
  const shellRim = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 8),
    mat(0x244f31, { roughness: 0.9, flatShading: true }),
  );
  shellRim.scale.set(2.25, 0.62, 1.55);
  shellRim.name = 'turtle-shell-rim';
  const carapace = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.54),
    mat(0xffffff, { tex: 'turtle-shell', repeat: [1, 2], roughness: 0.86, flatShading: true }),
  );
  carapace.scale.set(2.28, 0.65, 1.58);
  carapace.position.y = 0.015;
  carapace.name = 'turtle-patterned-carapace';
  const belly = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 6, 0, Math.PI * 2, Math.PI * 0.47, Math.PI * 0.53),
    mat(0xfff8e7, {
      roughness: 0.94, flatShading: true,
      emissive: 0xc9d8cc, emissiveIntensity: 0.38,
    }),
  );
  belly.scale.set(2.08, 0.66, 1.4);
  belly.position.y = -0.055;
  belly.name = 'turtle-white-plastron';
  const skin = mat(0x789b65, { roughness: 0.88, flatShading: true });
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.55, 9, 6), skin);
  head.scale.set(1.2, 0.7, 0.75); head.position.x = 2.1;
  const flippers = [];
  for (const [x, z, yaw] of [[0.9, 1.55, -0.65], [0.9, -1.55, 0.65], [-1, 1.35, -2.35], [-1, -1.35, 2.35]]) {
    const flipper = new THREE.Mesh(new THREE.ConeGeometry(0.55, 2.1, 4), skin);
    flipper.rotation.z = -Math.PI / 2; flipper.rotation.y = yaw; flipper.position.set(x, -0.05, z);
    root.add(flipper); flippers.push(flipper);
  }
  root.add(shellRim, carapace, belly, head);
  root.userData.flippers = flippers;
  return root;
}

function addReefLargeSeaLife(scene, world, boundaryRadius = 120) {
  const turtles = [[-38, -11, 31, 16, 0], [51, -19, -36, 12, 2.1], [8, -8, 58, 14, 4.2]].map((spec, i) => {
    const model = createSeaTurtle(); model.scale.setScalar(0.9 + i * 0.12); scene.add(model);
    return { model, spec, updateCollider: movingAnimalCollider(world, V(2.7, 0.95, 2.7)) };
  });
  world.anim.push((_dt, t) => {
    for (let i = 0; i < turtles.length; i++) {
      const { model, spec, updateCollider } = turtles[i];
      const [cx, cy, cz, radius, phase] = spec; const a = t * (0.075 + i * 0.012) + phase;
      model.position.set(cx + Math.cos(a) * radius, cy + Math.sin(t * 0.4 + phase) * 1.2, cz + Math.sin(a) * radius * 0.65);
      model.rotation.y = -a; model.rotation.z = Math.sin(t * 0.65 + phase) * 0.08;
      for (let j = 0; j < 4; j++) model.userData.flippers[j].rotation.x = Math.sin(t * 2.1 + phase + j * 0.7) * 0.22;
      updateCollider(model.position);
    }
  });

  // Tidebreaker's exact whale model and cruise/rise/breach/dive state machine.
  // Three moving volumes keep its head, body, and fluke solid underwater and
  // during a breach instead of letting players pass through the scenic animal.
  const whaleParts = buildBlueWhale();
  const whale = whaleParts.group;
  whale.name = 'sunken-reef-tidebreaker-whale';
  const whaleColliders = [
    { local: V(8, -0.2, 0), update: movingAnimalCollider(world, V(20, 7, 15)) },
    { local: V(-3.5, -0.3, 0), update: movingAnimalCollider(world, V(19, 7, 14)) },
    { local: V(-12.5, 0, 0), update: movingAnimalCollider(world, V(11, 4.5, 16)) },
  ];
  addTidebreakerWhaleBehavior(scene, world, whaleParts, {
    surfaceY: 18,
    boundaryRadius,
    onUpdate: () => {
      whale.updateMatrixWorld(true);
      for (const collider of whaleColliders) {
        collider.update(whale.localToWorld(collider.local.clone()));
      }
    },
  });
}

function addReefBoundarySharks(scene, world, boundaryRadius = 120) {
  const oceanSurfaceY = 18;
  const oceanBottomY = -44.5;
  const sharkStates = [0, 1, 2].map(i => {
    const group = buildTidebreakerShark();
    const angle = i * Math.PI * 2 / 3 + 0.45;
    // The patrol is elliptical, so size its short Z axis beyond the trigger as
    // well; none of the idle sharks cut visibly back into the playable reef.
    const orbitRadius = boundaryRadius / 0.82 + 12 + i * 12;
    group.position.set(
      Math.cos(angle) * orbitRadius,
      oceanSurfaceY - 8.5 - i * 2.4,
      Math.sin(angle) * orbitRadius * 0.82,
    );
    scene.add(group);
    return { group, orbitAngle: angle, orbitRadius, biteCooldown: 0, retreatT: 0 };
  });
  world.sharks = sharkStates.map(state => state.group);
  let sharkTarget = null;
  let sharkHunter = null;
  let sharkAcquireT = 0;
  const beyondReefBoundary = ch => ch?.alive &&
    Math.hypot(ch.pos.x, ch.pos.z) > boundaryRadius &&
    ch.pos.y < oceanSurfaceY + 0.35 && ch.pos.y > oceanBottomY;

  world.anim.push((dt, t, characters = []) => {
    const swimmers = characters.filter(beyondReefBoundary);
    if (!sharkTarget || !beyondReefBoundary(sharkTarget)) {
      sharkTarget = null;
      sharkHunter = null;
      sharkAcquireT = swimmers.length ? Math.max(0, sharkAcquireT || 0.7) : 0;
    }
    if (!sharkTarget && swimmers.length) {
      sharkAcquireT -= dt;
      if (sharkAcquireT <= 0) {
        let bestDistance = Infinity;
        for (const state of sharkStates) for (const swimmer of swimmers) {
          const distance = state.group.position.distanceToSquared(swimmer.pos);
          if (distance < bestDistance) {
            bestDistance = distance;
            sharkHunter = state;
            sharkTarget = swimmer;
          }
        }
        // Tidebreaker's urgency rule: a patrol on the far side re-enters at a
        // fair 34-unit distance, but only after the boundary crossing delay.
        if (sharkHunter && sharkTarget) {
          const toHunter = sharkHunter.group.position.clone().sub(sharkTarget.pos);
          toHunter.y = 0;
          if (toHunter.length() > 38) {
            if (toHunter.lengthSq() < 0.01) toHunter.set(1, 0, 0);
            toHunter.normalize();
            sharkHunter.group.position.set(
              sharkTarget.pos.x + toHunter.x * 34,
              THREE.MathUtils.clamp(sharkTarget.pos.y + 0.65, oceanBottomY + 2, oceanSurfaceY - 1.15),
              sharkTarget.pos.z + toHunter.z * 34,
            );
          }
        }
      }
    }

    for (let i = 0; i < sharkStates.length; i++) {
      const state = sharkStates[i];
      state.biteCooldown = Math.max(0, state.biteCooldown - dt);
      state.retreatT = Math.max(0, state.retreatT - dt);
      const current = state.group.position;
      const parts = state.group.userData.animParts;
      const hunting = state === sharkHunter && !!sharkTarget;
      const swimPhase = t * (hunting ? 10.5 : 5.4) + i * 1.9;
      const tailTarget = Math.sin(swimPhase) * (hunting ? 0.52 : 0.32);
      const pecStroke = Math.sin(swimPhase * 0.46) * (hunting ? 0.055 : 0.035);
      parts.tail.rotation.y = THREE.MathUtils.damp(parts.tail.rotation.y, tailTarget, 12, dt);
      parts.leftPec.rotation.x = THREE.MathUtils.damp(parts.leftPec.rotation.x, -0.045 + pecStroke, 7, dt);
      parts.rightPec.rotation.x = THREE.MathUtils.damp(parts.rightPec.rotation.x, 0.045 - pecStroke, 7, dt);

      const desired = V(0, 0, 0);
      let speed = 6.5;
      if (hunting) {
        desired.set(
          sharkTarget.pos.x,
          THREE.MathUtils.clamp(sharkTarget.pos.y + 0.65, oceanBottomY + 2, oceanSurfaceY - 1.15),
          sharkTarget.pos.z,
        );
        if (state.retreatT > 0) {
          const away = current.clone().sub(sharkTarget.pos);
          away.y = 0;
          if (away.lengthSq() < 0.01) away.set(1, 0, 0);
          away.normalize();
          desired.set(current.x + away.x * 12, current.y, current.z + away.z * 12);
          speed = 18;
        } else {
          speed = 21;
        }
      } else {
        const angle = state.orbitAngle + t * (0.16 + i * 0.025);
        desired.set(
          Math.cos(angle) * state.orbitRadius,
          oceanSurfaceY - 8.5 - i * 2.4 + Math.sin(t * 0.7 + i) * 0.45,
          Math.sin(angle) * state.orbitRadius * 0.82,
        );
      }
      const travel = desired.sub(current);
      const distance = travel.length();
      if (distance > 0.001) {
        travel.multiplyScalar(Math.min(distance, speed * dt) / distance);
        current.add(travel);
        const flatSpeed = Math.hypot(travel.x, travel.z);
        if (flatSpeed > 0.0001) {
          const yaw = Math.atan2(-travel.z, travel.x);
          state.group.rotation.y = THREE.MathUtils.lerp(state.group.rotation.y, yaw, 1 - Math.exp(-8 * dt));
          state.group.rotation.z = THREE.MathUtils.lerp(
            state.group.rotation.z,
            THREE.MathUtils.clamp(-travel.y / flatSpeed, -0.28, 0.28),
            1 - Math.exp(-5 * dt),
          );
        }
      }
      if (hunting && state.retreatT <= 0 && state.biteCooldown <= 0 &&
          current.distanceTo(sharkTarget.pos) < 2.75) {
        state.biteCooldown = 2;
        state.retreatT = 0.72;
        world.onSharkBite?.(sharkTarget, current);
      }
    }
  });
}

function buildSunkenReef(scene) {
  const world = newWorld({
    killY: -92,
    playerSpeed: 12,
    waypointLinkDist: 26,
    waypointLinkDy: 13,
    waypointLinkClearance: 0.5,
    toneMappingExposure: 1.08,
  });
  // Above the water this is a bright tropical day, intentionally far removed
  // from the deep cyan underwater fog. Crossing the surface now reads at once.
  scene.background = new THREE.Color(0xa5e4ef);
  // Surface haze merges the water and sky well before the physical ocean
  // geometry ends. Underwater fog is still replaced by the denser dive effect.
  scene.fog = new THREE.Fog(0xa5e4ef, 80, 320);
  scene.add(new THREE.HemisphereLight(0x8eeaf0, 0x082a32, 2.2));
  scene.add(new THREE.AmbientLight(0x70c8cf, 0.46));
  const sun = new THREE.DirectionalLight(0xc8ffff, 3.15);
  sun.position.set(-80, 120, 45);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, {
    left: -135, right: 135, top: 135, bottom: -135, near: 20, far: 310,
  });
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.7;
  scene.add(sun, sun.target);

  // The surface and bottom extend far beyond fog. Players see a continuous
  // ocean in every direction; the shark ring is the actual gameplay boundary.
  addWater(scene, world, 0, 18, 0, 1650, 1650, 82, {
    color: 0x1d8ba0, opacity: 0.66,
  });
  world.waterZones[0].underwaterArena = true;
  // A luminous underside gives divers a clear ceiling to swim toward. The
  // scattered rings read as wave caustics rather than a second solid roof.
  const surfaceGlow = new THREE.Mesh(
    new THREE.PlaneGeometry(1650, 1650),
    new THREE.MeshBasicMaterial({ color: 0x5ce3ed, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false }),
  );
  surfaceGlow.rotation.x = -Math.PI / 2;
  surfaceGlow.position.y = 17.93;
  surfaceGlow.name = 'sunken-reef-visible-water-surface-underside';
  scene.add(surfaceGlow);
  const ringMaterial = new THREE.MeshBasicMaterial({ color: 0xd2ffff, transparent: true, opacity: 0.23, side: THREE.DoubleSide, depthWrite: false });
  const surfaceRings = [];
  for (let i = 0; i < 16; i++) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(5 + (i % 4) * 2.2, 5.45 + (i % 4) * 2.2, 32), ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(((i * 47) % 210) - 105, 17.88, ((i * 83) % 210) - 105);
    ring.scale.set(1.8, 0.7 + (i % 3) * 0.2, 1);
    scene.add(ring); surfaceRings.push(ring);
  }
  world.anim.push((_dt, t) => {
    for (let i = 0; i < surfaceRings.length; i++) {
      const pulse = 0.9 + Math.sin(t * 0.55 + i) * 0.12;
      surfaceRings[i].scale.set(1.8 * pulse, (0.7 + (i % 3) * 0.2) * pulse, 1);
    }
  });
  addReefBirdFlocks(scene, world);

  const seabedY = -44.5;
  // Red Rock Range uses one uninterrupted desert beneath both its playable
  // space and distant horizon. Build this seabed the same way: the sculpted
  // center and four flat horizon extensions are non-overlapping pieces merged
  // into one mesh with one material, so the shark trigger never coincides with
  // a visible material, UV, or geometry boundary.
  world.colliders.push({ type: 'box', min: V(-825, seabedY - 2, -825), max: V(825, seabedY, 825) });

  // Dense inner heightfield: large authored masses create the routes while
  // layered waves break up every local patch, avoiding a disguised flat bowl.
  const terrainGeometry = new THREE.PlaneGeometry(260, 260, 42, 42);
  terrainGeometry.rotateX(-Math.PI / 2);
  const positions = terrainGeometry.attributes.position;
  const colors = new Float32Array(positions.count * 3);
  const deepSand = new THREE.Color(0x78957c);
  const shelfSand = new THREE.Color(0x91aa82);
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i), z = positions.getZ(i);
    const y = reefSurfaceY(x, z);
    positions.setY(i, y);
    const depth = THREE.MathUtils.clamp((y + 44) / 27, 0, 1);
    const color = new THREE.Color().lerpColors(deepSand, shelfSand, depth);
    colors.set([color.r, color.g, color.b], i * 3);
  }
  terrainGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  terrainGeometry.computeVertexNormals();

  // Keep the detailed center as the exact walkable collider. The flat outer
  // collider above already covers the horizon floor; visual geometry is merged
  // separately below so collision cost does not grow with the 1650-unit floor.
  const terrainColliderSource = new THREE.Mesh(terrainGeometry);
  world.colliders.push(triangleMeshColliderFromMesh(terrainColliderSource, 'sunken-reef-heightfield'));

  const addUniformColor = (geometry, color) => {
    const count = geometry.getAttribute('position').count;
    const values = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) values.set([color.r, color.g, color.b], i * 3);
    geometry.setAttribute('color', new THREE.BufferAttribute(values, 3));
    return geometry;
  };
  const horizonSpan = (1650 - 260) / 2;
  const horizonCenter = 130 + horizonSpan / 2;
  const horizonGeometries = [
    [1650, horizonSpan, 0, horizonCenter],
    [1650, horizonSpan, 0, -horizonCenter],
    [horizonSpan, 260, horizonCenter, 0],
    [horizonSpan, 260, -horizonCenter, 0],
  ].map(([width, depth, x, z]) => {
    const geometry = new THREE.PlaneGeometry(width, depth);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(x, seabedY, z);
    return addUniformColor(geometry, deepSand);
  });
  const seabedGeometry = mergeGeometries([terrainGeometry, ...horizonGeometries], false);
  const terrain = new THREE.Mesh(seabedGeometry, new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.97, metalness: 0, flatShading: true,
  }));
  terrain.castShadow = terrain.receiveShadow = true;
  terrain.name = 'sunken-reef-continuous-seabed';
  scene.add(terrain);

  // Swim-through stone arches and towering bommies turn the vertical water
  // column into combat space instead of leaving all geometry on the floor.
  for (const [archIndex, [x, z, majorRadius, tubeRadius, yaw]] of [
    [-48, -19, 10.5, 2.9, 0.18], [34, 33, 8.5, 2.5, -0.5], [5, -57, 7.2, 2.2, 0.72],
  ].entries()) {
    const archMaterial = mat(0x315651, {
      tex: 'rock', repeat: [3, 2], roughness: 0.98, flatShading: true,
    });
    const crown = new THREE.Mesh(
      new THREE.TorusGeometry(majorRadius, tubeRadius, 8, 28, Math.PI),
      archMaterial,
    );
    const dx = Math.cos(yaw) * majorRadius;
    const dz = -Math.sin(yaw) * majorRadius;
    const feet = [[x - dx, z - dz], [x + dx, z + dz]];
    const footprintRange = (fx, fz) => {
      let low = Infinity;
      let high = -Infinity;
      const r = tubeRadius * 0.82;
      for (const [ox, oz] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r],
        [r * 0.7, r * 0.7], [-r * 0.7, r * 0.7], [r * 0.7, -r * 0.7], [-r * 0.7, -r * 0.7]]) {
        const ground = reefSurfaceY(fx + ox, fz + oz);
        low = Math.min(low, ground);
        high = Math.max(high, ground);
      }
      return { low, high };
    };
    const ranges = feet.map(([fx, fz]) => footprintRange(fx, fz));
    // The crown is a separate curved third piece. Its two joints share one
    // level, while straight legs independently continue through however much
    // hill lies beneath them. Matching radius, facets, material, and overlap
    // make the three meshes read as one uninterrupted stone arch.
    const jointY = Math.max(ranges[0].high, ranges[1].high) + Math.max(4.2, tubeRadius * 1.7);
    crown.position.set(x, jointY, z);
    crown.rotation.y = yaw;
    crown.castShadow = crown.receiveShadow = true;
    scene.add(crown);
    crown.updateMatrixWorld(true);
    world.colliders.push(triangleMeshColliderFromMesh(crown, 'sunken-reef-stone-arch-crown'));

    for (let side = 0; side < feet.length; side++) {
      const [fx, fz] = feet[side];
      const bottomY = ranges[side].low - tubeRadius * 1.35;
      const topY = jointY + tubeRadius * 0.22;
      const height = topY - bottomY;
      const leg = new THREE.Mesh(
        new THREE.CylinderGeometry(tubeRadius, tubeRadius, height, 8, 1, false),
        archMaterial,
      );
      leg.position.set(fx, (topY + bottomY) * 0.5, fz);
      // Keep each column's octagonal faces in phase with the curved crown so
      // the joint reads as one continuous piece instead of two rotated meshes.
      leg.rotation.y = yaw;
      leg.castShadow = leg.receiveShadow = true;
      scene.add(leg);
      leg.updateMatrixWorld(true);
      world.colliders.push(triangleMeshColliderFromMesh(leg, 'sunken-reef-stone-arch-leg'));

      const outward = side === 0 ? -1 : 1;
      addReefFrondCluster(scene, world,
        fx + Math.cos(yaw) * tubeRadius * outward,
        ranges[side].high + tubeRadius * 0.45,
        fz - Math.sin(yaw) * tubeRadius * outward,
        51000 + archIndex * 101 + side * 17, 0.8 + tubeRadius * 0.12,
        outward * 0.42);
    }
    addReefFrondCluster(scene, world, x, jointY + majorRadius + tubeRadius * 0.82, z,
      52000 + archIndex * 97, 0.9 + tubeRadius * 0.1);
  }
  for (const [x, z, radius, sx, sy] of [
    [58, -36, 10, 0.82, 1.55], [-66, 37, 9, 0.75, 1.7],
    [13, 66, 8, 0.85, 1.45], [-4, -7, 7, 0.72, 1.35],
  ]) {
    const base = reefSurfaceY(x, z);
    addAsteroid(scene, world, x, base + radius * sy * 0.34, z, radius, 0x315651, true, {
      scaleX: sx, scaleY: sy, scaleZ: 0.78,
      materialColor: 0x315651, roughness: 0.98,
    });
  }

  // Major block-built reef heads form real cover, tunnels, and vertical lanes.
  // Smaller plate coral decorates these routes without becoming the only reef.
  const coralColors = [0xd95362, 0xe3a632, 0x7357cc, 0x2faf8a, 0xcf4b9e, 0x388bc1];
  const reefFormations = [
    [-73, 2, 0xd95362, 'arch', 1.18, 'coral-brain-red'],
    [-30, -28, 0x388bc1, 'maze', 1.08, 'coral-cup-blue'],
    [21, 35, 0x7357cc, 'shelves', 1.2, 'coral-plate-pink'],
    [63, 18, 0xe3a632, 'arch', 1.0, null],
    [55, -54, 0xcf4b9e, 'maze', 1.05, 'coral-plate-pink'],
    [6, -23, 0x388bc1, 'arch', 0.9, 'coral-cup-blue'],
    [-21, 59, 0x2faf8a, 'bommie', 1.25], [-64, -52, 0xe3a632, 'shelves', 1.08],
    [79, -10, 0xd95362, 'bommie', 1.16, 'coral-brain-red'],
    [4, 73, 0xcf4b9e, 'arch', 0.95, 'coral-plate-pink'],
    [-7, 15, 0x7357cc, 'maze', 0.86, 'coral-cup-blue'],
    [36, -4, 0x2faf8a, 'shelves', 0.92],
    [-43, 22, 0xcf4b9e, 'shelves', 0.82, 'coral-plate-pink'],
    [47, 55, 0xd95362, 'bommie', 0.88, 'coral-brain-red'],
    [-84, -24, 0x388bc1, 'shelves', 0.78, 'coral-cup-blue'],
    [72, 44, 0xe3a632, 'maze', 0.82, null],
  ];
  for (const [x, z, color, type, scale, texture] of reefFormations) {
    addBlockyReefFormation(scene, world, x, z, color, type, scale, texture);
  }
  // Several colonies have grown into one another above the seabed. The
  // elevated forked spans create swim-under cover and make neighboring reef
  // heads read as a continuous living system rather than isolated props.
  addReefCoralBridge(scene, world, [-30, -28], [6, -23], 0x388bc1, 'coral-cup-blue', 71001);
  addReefCoralBridge(scene, world, [21, 35], [-7, 15], 0x7357cc, 'coral-plate-pink', 71043);
  addReefCoralBridge(scene, world, [-21, 59], [4, 73], 0x2faf8a, null, 71087);
  addReefCoralBridge(scene, world, [47, 55], [72, 44], 0xd95362, 'coral-brain-red', 71129);
  flushReefCoralSegments(scene, world);
  const coralRnd = seededRandom(0xc0a1b33f);
  for (let i = 0; i < 42; i++) {
    const angle = coralRnd() * Math.PI * 2;
    const radius = 13 + Math.sqrt(coralRnd()) * 95;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    addReefPlateCoral(scene, x, reefSurfaceY(x, z), z,
      coralColors[i % coralColors.length], 8000 + i * 37, 0.45 + coralRnd() * 0.75);
  }
  // Loose growth fills the negative space between major reef heads. Uneven
  // densities and sizes make it feel naturally colonized instead of placing a
  // uniform decorative ring around every landmark.
  const growthRnd = seededRandom(0x5ea5eed);
  for (let i = 0; i < 92; i++) {
    const angle = growthRnd() * Math.PI * 2;
    const radius = 7 + Math.sqrt(growthRnd()) * 105;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    addReefFrondCluster(scene, world, x, reefSurfaceY(x, z) + 0.05, z,
      62000 + i * 43, 0.35 + growthRnd() * 0.72);
  }
  world.anim.push((_dt, t) => {
    for (const growth of world.reefGrowthClusters || []) {
      growth.root.rotation.x = growth.baseX + Math.sin(t * 0.72 + growth.phase) * growth.sway * 0.55;
      growth.root.rotation.z = growth.baseZ + Math.sin(t * 0.58 + growth.phase * 1.37) * growth.sway;
    }
  });
  addReefFishLife(scene, world);
  addReefLargeSeaLife(scene, world, 120);
  addReefBoundarySharks(scene, world, 120);

  // Salvaged placards make the arena identity visible in a map with no planar
  // walls. They face the center from two common spawn lanes and remain purely
  // decorative, so swimmers and projectiles pass through the frames.
  for (const [x, z] of [[-38, 46], [40, -45]]) {
    const yaw = Math.atan2(-x, -z);
    addPosterStand(scene, 'poster-reef', x, reefSurfaceY(x, z), z, 7, yaw, 7, 0x315f5e);
  }

  const spawnXZ = [
    [-72, -24], [72, 24], [-52, 43], [50, -44],
    [-20, -66], [23, 67], [-13, 15], [18, -16],
    [-47, -19], [39, 30], [0, 54], [4, -54],
  ];
  for (const [x, z] of spawnXZ) world.spawns.ffa.push(V(x, reefSurfaceY(x, z) + 0.3, z));
  world.spawns.blue.push(...world.spawns.ffa.filter((_, i) => i % 2 === 0).map(v => v.clone()));
  world.spawns.red.push(...world.spawns.ffa.filter((_, i) => i % 2 === 1).map(v => v.clone()));

  const pickupSpecs = [
    ['weapon', -54, -19, { weapon: 'scatter' }], ['ammo', -49, -14, { weapon: 'scatter' }],
    ['weapon', 42, 29, { weapon: 'pulsar' }], ['ammo', 47, 34, { weapon: 'pulsar' }],
    ['weapon', 7, -56, { weapon: 'zooka' }], ['ammo', 13, -51, { weapon: 'zooka' }],
    ['weapon', -11, 49, { weapon: 'sidewinder' }], ['ammo', -17, 54, { weapon: 'sidewinder' }],
    ['weapon', 24, -7, { weapon: 'parasite' }], ['ammo', 30, -11, { weapon: 'parasite' }],
    ['weapon', -29, 29, { weapon: 'whomper' }], ['ammo', -34, 34, { weapon: 'whomper' }],
    ['weapon', 64, -16, { weapon: 'hyper' }], ['ammo', 69, -11, { weapon: 'hyper' }],
    ['health', -67, 28, {}], ['health', 67, -28, {}], ['health', -25, -57, {}],
    ['health', 27, 58, {}], ['health', -6, 5, {}], ['health', 37, 10, {}],
    ['speed', -41, 5, {}], ['speed', 45, -3, {}],
    ['shield', 0, 36, {}], ['gold', -47, -19, {}], ['silver', 39, 30, {}],
    ['star', 9, -60, { hidden: true }], ['star', -78, -42, { hidden: true }],
    ['star', 73, 47, { hidden: true }], ['star', -4, 77, { hidden: true }],
  ];
  for (const [kind, x, z, extra] of pickupSpecs) {
    // Every item is deliberately anchored to the seabed. Even the powerups
    // require giving up surface air and swimming down to collect them.
    pk(world, kind, x, reefSurfaceY(x, z) + 0.28, z, extra);
  }

  // Ground navigation follows the major terrain shelves. Bots can leave the
  // graph vertically while swimming, but connected bottom routes keep loot and
  // respawns reachable once they dive.
  const waypointRings = [18, 43, 72, 98];
  for (const radius of waypointRings) {
    const count = radius < 30 ? 8 : radius < 60 ? 12 : 16;
    for (let i = 0; i < count; i++) {
      const a = i / count * Math.PI * 2;
      const x = Math.cos(a) * radius, z = Math.sin(a) * radius;
      wp(world, x, reefSurfaceY(x, z) + 0.35, z);
    }
  }
  world.manualLinks.push(
    [0, reefSurfaceY(0, 18), 18, 0, reefSurfaceY(0, 43), 43],
    [43, reefSurfaceY(43, 0), 0, 72, reefSurfaceY(72, 0), 0],
    [-43, reefSurfaceY(-43, 0), 0, -72, reefSurfaceY(-72, 0), 0],
  );

  mergeStatic(scene, world);
  return world;
}

export const MAPS = [
  { id: 'arena', name: 'BLAST COMPLEX', emoji: '🏟️',
    desc: 'Indoor labyrinth: crate maze, mezzanine, grand atrium with a floating gold platform, sunken basement.',
    thumb: 'linear-gradient(135deg,#c8461e,#d88a2b)', build: buildArena },
  { id: 'fortress', name: 'FORTRESS FALLS', emoji: '🏰',
    desc: 'A royal canal fortress: three bridges, sniper battlements, a ramp-fed siege deck, close-range sluice, and a keep with a concealed rear passage.',
    thumb: 'linear-gradient(135deg,#5c24c9,#35cce6 58%,#ffb527)', build: buildFortress },
  { id: 'oldwest', name: 'RED ROCK RANGE', emoji: '🤠',
    desc: 'A vast Utah-style frontier range built for horseback combat: open desert, wide red hills, cactus fields, a frontier strip, a towering stone arch, and an eastern cliff.',
    thumb: 'linear-gradient(135deg,#6f2f25,#c46b38 52%,#e5b86a)', build: buildOldWest },
  { id: 'asteroids', name: 'ASTEROID BELT', emoji: '☄️',
    desc: 'Flat-topped rock plateaus around a derelict station: a cave, a canyon under-deck, balconies. Low gravity, long jumps, fatal void.',
    thumb: 'linear-gradient(135deg,#05060f,#334466)', build: buildAsteroids },
  { id: 'canopy', name: 'CANOPY', emoji: '🌲',
    desc: 'A towering forest village: climb from river paths to branch decks, suspension bridges, treehouses, and a golden council crown.',
    thumb: 'linear-gradient(135deg,#14291f,#5d9c46)', build: buildCanopy },
  { id: 'mycelium', name: 'MYCELIUM GROVE', emoji: '🍄',
    desc: 'A moonlit mushroom forest: bounce across living caps, climb connected tree villages, and break through a waterfall into the glowing cave behind it.',
    thumb: 'linear-gradient(135deg,#071c24,#315f55 48%,#9a55dd)', build: buildMyceliumGrove },
  { id: 'city', name: 'NEON HEIGHTS', emoji: '🌃',
    desc: 'A Miami-synthwave skyline with two working tower lifts, rooftop sniper routes, a close-range arcade and subway, skybridges, alleys, and a rideable monorail loop.',
    thumb: 'linear-gradient(135deg,#101032,#ff3ca6 48%,#32e7ff)', build: buildCity },
  { id: 'sanctum', name: 'THE LABYRINTH', emoji: '🔮',
    desc: 'A deliberately disorienting rune maze: four deceptively identical wings fold around a crypt lift, upper gallery, roof loops, and concealed shortcuts.',
    thumb: 'linear-gradient(135deg,#14101f,#8a5fff)', build: buildSanctum },
  { id: 'tidebreaker', name: 'TIDEBREAKER', emoji: '🌊',
    desc: 'A storm-lashed offshore platform: floodable processing deck, evacuation catwalks, operations roof, crane lanes, and a siren-warned breaker that reshapes the fight.',
    thumb: 'linear-gradient(135deg,#071b28,#23788d 58%,#e86e2d)', build: buildTidebreaker },
  { id: 'reef', name: 'SUNKEN REEF', emoji: '🩸', secret: true,
    desc: 'An entirely underwater coral basin of trenches, caves, arches, and tall reef bommies. Surface for air, or gamble on seabed health packs while boundary sharks guard the endless ocean.',
    thumb: 'linear-gradient(135deg,#052f3c,#15939b 48%,#ff7a82)', build: buildSunkenReef },
  { id: 'prism', name: 'PRISM RUN', emoji: '🌈', secret: true,
    desc: 'Inside a neon tesseract in deep space: walk every wall, floor and ceiling. Gravity always pulls to the nearest surface — you never fall out.',
    thumb: 'linear-gradient(135deg,#0b0518,#ff40e0)', build: buildPrism },
  { id: 'bloom', name: 'INFINITE BLOOM', emoji: '👁️', secret: true,
    desc: 'A sentient machine realm recursively contains itself. Fall or fire into the living miniature and emerge above the full-size arena at the same point.',
    thumb: 'linear-gradient(135deg,#101600,#b7ed1c 52%,#e43814)', build: buildInfiniteBloom },
  { id: 'solar', name: 'SOLAR FLARE', emoji: '☀️', secret: true,
    desc: 'A compact two-deck starship beside a colossal sun: tight maintenance tunnels, bridge rooms, a permeable air curtain, and a 45° solar arm climbing to a giant PV wing in the void.',
    thumb: 'linear-gradient(135deg,#080611,#ff5a18 48%,#ffd45a)', build: buildSolarFlare },
  { id: 'olympus', name: 'OLYMPUS MONS', emoji: '🔴', secret: true,
    desc: 'A Greco-futurist cliff-temple on Mars: stepped golden palaces, Olympian statues, an ornate Aether Crown, connected roof arenas, a mountain-sized Hades cavern, and waterfall caves.',
    thumb: 'linear-gradient(135deg,#351a24,#c75b36)', build: buildOlympusMons },
];
