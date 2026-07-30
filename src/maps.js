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
import { rand, pointInZoneXZ } from './engine.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const SURFACE_LAYER_EPS = 0.04;
// Portal faces live inside deep gate frames, so they can sit farther forward
// than ordinary wall trim. Keep this large enough to survive the atrium's
// shallow viewing angles and 900-unit camera depth range without intersecting
// the frame or changing the gate trigger/collision volume.
const PORTAL_SURFACE_EPS = 0.18;
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
      this._t = (this._t || 0) + dt;
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
};

// ---- Web-optimized AI texture set (textures/*.webp) — canvas fallback if absent ----
// A normal map is derived from each image's luminance so surfaces catch light.
const AI_TEX = {};
const AI_TEX_SOURCES = {
  'fortress-royal': './textures/fortress-royal.webp',
  'canopy-wall': './textures/canopy-wall.webp',
  'infinite-bloom-sky-eyeless': './textures/infinite-bloom-sky-eyeless.webp',
  'infinite-bloom-eye-atlas': './textures/infinite-bloom-eye-atlas.webp',
  parasite: './textures/parasite.webp',
  refractor: './textures/refractor.webp',
  'power-gold': './textures/power-gold.webp',
  'power-silver': './textures/power-silver.webp',
  'atrium-gate-frame-atlas': './textures/atrium-gate-frame-atlas.webp',
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
  const normalMap = ai.normal.clone(); normalMap.needsUpdate = true; normalMap.repeat.set(rx, ry);
  return { map, normalMap, normalScale: new THREE.Vector2(0.7, 0.7) };
}

// Resolves when every texture is loaded (or confirmed missing) — the boot
// waits on this so the first scene isn't built with placeholder canvases.
export const texturesReady = Promise.all(
  ['checker', 'panel', 'crate', 'rock', 'suit', 'plastic', 'neonwall', 'neonfloor', 'arcade',
   'fortress-royal', 'canopy-wall',
   'poster1', 'poster2', 'poster3', 'poster4', 'poster5', 'poster6', 'poster7',
   'target', 'hazard', 'grass', 'atrium-grass', 'dirt', 'flowers', 'door', 'lava',
   'blaster', 'scatter', 'pulsar', 'sidewinder', 'zooka', 'whomper', 'hyper', 'parasite', 'refractor',
   'power-gold', 'power-silver',
   'olympus-rock', 'olympus-palace', 'olympus-relief', 'olympus-aether',
   'infinite-bloom-surface', 'infinite-bloom-faces', 'infinite-bloom-sky-eyeless', 'infinite-bloom-eye-atlas',
   'atrium-gate-frame-atlas']
    .map((name) => new Promise((done) => {
      const url = AI_TEX_SOURCES[name] || `./textures/${name}.webp`;
      fetch(url, { method: 'HEAD' }).then((r) => {
        if (!r.ok) return done();
        new THREE.TextureLoader().load(url, (t) => {
          // mirrored repeat hides any seams in not-quite-tileable AI images
          t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping;
          t.colorSpace = THREE.SRGBColorSpace;
          t.anisotropy = 16;
          const n = makeNormalMap(t.image);
          n.wrapS = n.wrapT = THREE.MirroredRepeatWrapping;
          n.anisotropy = 16;
          AI_TEX[name] = { map: t, normal: n };
          done();
        }, undefined, () => done());
      }).catch(() => done());
    })));

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
  scene.add(m);
  return m;
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
    if (ai) {
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
function addRamp(scene, world, { axis, minX, maxX, minZ, maxZ, h0, h1, color, tex = 'panel', visualInset = 0, supportPad0 = 0, supportPad1 = 0 }) {
  world.ramps.push({ axis, minX, maxX, minZ, maxZ, h0, h1, supportPad0, supportPad1 });
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

function addAsteroid(scene, world, x, y, z, radius, color = 0x8a7f72) {
  const geo = new THREE.IcosahedronGeometry(radius, 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const v = V(pos.getX(i), pos.getY(i), pos.getZ(i));
    // keep the lumps subtle: the collider is a sphere, and big bumps poke
    // through it — you end up standing (and clipping the camera) inside rock
    const n = 1 + (Math.sin(v.x * 1.3) + Math.cos(v.z * 1.7) + Math.sin(v.y * 2.1)) * 0.018;
    v.multiplyScalar(n);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, mat(color, { tex: 'rock', repeat: [3, 3], roughness: 0.95, flatShading: true }));
  m.position.set(x, y, z);
  m.rotation.set(rand(0, 3), rand(0, 3), rand(0, 3));
  m.castShadow = m.receiveShadow = true;
  scene.add(m);
  world.colliders.push({ type: 'sphere', center: V(x, y, z), radius });
  return m;
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
  world.waterZones.push({
    minX: x - w / 2, maxX: x + w / 2,
    minZ: z - d / 2, maxZ: z + d / 2,
    surfaceY: y, bottomY: y - depth,
  });

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
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(x, y, z);
  scene.add(mesh);
  if (n) world.anim.push((dt, t) => n.offset.set(t * 0.018, t * 0.03));
}

function addMinnowSchool(scene, world, x, z, travel = 13, phase = 0) {
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
  school.position.set(x, -1.12, z);
  scene.add(school);

  world.anim.push((dt, t, characters = []) => {
    dt = Math.min(dt, 0.05);
    let threat = null;
    let threatDistance = Infinity;
    for (const ch of characters) {
      if (!ch?.alive || ch.pos.y > 0.2 || Math.abs(ch.pos.x - x) > 4.2) continue;
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

function addWaterfall(scene, world, x, z, w, h, bottomY, topY, flowZ = 0, style = {}) {
  const flowsAlongX = style.axis === 'x';
  const worldPosition = (across, y, outward) => flowsAlongX
    ? new THREE.Vector3(x + outward, y, z + across)
    : new THREE.Vector3(x + across, y, z + outward);
  world.waterfallZones ||= [];
  world.waterfallZones.push({
    minX: flowsAlongX ? x - 1.35 : x - w / 2,
    maxX: flowsAlongX ? x + 1.35 : x + w / 2,
    minZ: flowsAlongX ? z - w / 2 : z - 1.35,
    maxZ: flowsAlongX ? z + w / 2 : z + 1.35,
    minY: bottomY - 0.4, maxY: topY + 0.4,
  });

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
  const gator = new THREE.Group();
  gator.name = 'fortress-canal-alligator';

  const hide = mat(0x496522, { roughness: 0.92, flatShading: true });
  const belly = mat(0x91a64a, { roughness: 0.95, flatShading: true });
  const tooth = new THREE.MeshBasicMaterial({ color: 0xf3edc8, toneMapped: false });
  const eye = new THREE.MeshBasicMaterial({ color: 0xffd83d, toneMapped: false });

  const body = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.72, 1.2), hide);
  body.scale.z = 0.82;
  const back = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.22, 0.78), belly);
  back.position.set(-0.25, 0.43, 0);
  const head = new THREE.Mesh(new THREE.BoxGeometry(1.45, 0.62, 1.05), hide);
  head.position.set(2.05, 0.02, 0);
  const upperJaw = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.25, 0.88), hide);
  upperJaw.position.set(3.18, 0.04, 0);
  const lowerJawPivot = new THREE.Group();
  lowerJawPivot.position.set(2.5, -0.11, 0);
  const lowerJaw = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.18, 0.82), belly);
  lowerJaw.position.x = 0.66;
  lowerJawPivot.add(lowerJaw);

  // Keep the tail mesh offset behind a joint at the back of the body. Animating
  // the joint (rather than the mesh itself) makes the tail swing from its base.
  const tailPivot = new THREE.Group();
  tailPivot.position.set(-1.82, -0.02, 0);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.55, 3.1, 6), hide);
  tail.rotation.z = Math.PI / 2;
  tail.position.set(-1.55, 0, 0);
  tailPivot.add(tail);
  gator.add(body, back, head, upperJaw, lowerJawPivot, tailPivot);

  for (const z of [-0.38, 0.38]) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.09, 6, 4), eye);
    e.position.set(2.48, 0.38, z);
    gator.add(e);
    for (const x of [2.78, 3.12, 3.46]) {
      const fang = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.18, 5), tooth);
      fang.position.set(x, -0.11, z * 0.88);
      fang.rotation.z = Math.PI;
      gator.add(fang);
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
    chaseTarget: null,
    chaseT: 0,
    lungeT: 0,
    lungeCooldown: 0,
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
  world.gator = { group: gator, state };
  world.anim.push((dt, t, characters = []) => {
    // Capture riders relative to the old pose so turning carries them as well
    // as straight-line motion.
    const riders = [];
    for (const ch of characters) {
      if (!isOnGatorBack(ch)) continue;
      const local = localToGator(ch);
      riders.push({ ch, ...local, y: ch.pos.y - gator.position.y });
    }
    const inCanalWater = ch => ch?.alive &&
      !isOnGatorBack(ch) && ch.pos.y < -2 &&
      Math.abs(ch.pos.z) < 6.85 && Math.abs(ch.pos.x) < 55;
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
      if (d < nearbyDist && d < 8) { nearbyTarget = ch; nearbyDist = d; }
    }
    if (nearbyTarget) {
      state.chaseTarget = nearbyTarget;
      state.chaseT = 3.25;
    } else {
      state.chaseT = Math.max(0, state.chaseT - dt);
      if (!state.chaseTarget?.alive || state.chaseT <= 0) state.chaseTarget = null;
    }

    let target = state.chaseTarget;
    let targetDist = Infinity;
    if (target) {
      if (!inCanalWater(target) || (state.biteCooldowns.get(target) || 0) > 0) {
        state.chaseTarget = target = null;
        state.chaseT = 0;
      }
    }
    if (target) {
      targetDist = Math.hypot(target.pos.x - gator.position.x, target.pos.z - gator.position.z);
      // The gator gives up after a short pursuit or if the target gets well
      // beyond the canal encounter instead of chasing forever across the map.
      if (targetDist > 18) { state.chaseTarget = target = null; state.chaseT = 0; }
    }

    const desired = V(state.patrolDir, 0, Math.sin(t * 0.55) * 0.36);
    let speed = 2.9;
    state.lungeCooldown = Math.max(0, state.lungeCooldown - dt);
    if (target) {
      desired.set(target.pos.x - gator.position.x, 0, target.pos.z - gator.position.z).normalize();
      if (targetDist < 4.5 && state.lungeCooldown <= 0) {
        state.lungeT = 0.46;
        state.lungeCooldown = 1.8;
      }
      state.lungeT = Math.max(0, state.lungeT - dt);
      speed = state.lungeT > 0 ? 12.5 : (targetDist < 5.5 ? 6.2 : 4);
      const cooldown = state.biteCooldowns.get(target) || 0;
      if (targetDist < 4.5 && cooldown <= 0 && state.snapT <= 0) {
        state.snapT = 0.42;
        state.biteArmed = true;
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
    const biteProgress = state.snapT > 0 ? 1 - state.snapT / 0.42 : 1;
    const jawOpen = state.snapT > 0 ? Math.sin(biteProgress * Math.PI) : 0;
    lowerJawPivot.rotation.z = -0.48 * jawOpen;
    // The second half of the animation is the closing stroke. Check the actual
    // mouth against every character so proximity alone can never cause damage.
    if (state.biteArmed && biteProgress >= 0.5) {
      for (const ch of characters) {
        if ((state.biteCooldowns.get(ch) || 0) > 0 || !mouthHits(ch)) continue;
        state.biteCooldowns.set(ch, 2.75);
        world.onGatorBite?.(ch);
        state.chaseTarget = null;
        state.chaseT = 0;
        state.lungeT = 0;
        state.biteArmed = false;
        break;
      }
      if (biteProgress >= 0.94) state.biteArmed = false;
    }
    tailPivot.rotation.y = Math.sin(t * 5.5) * 0.18;
    for (const ch of characters) {
      const cooldown = state.biteCooldowns.get(ch);
      if (cooldown > 0) state.biteCooldowns.set(ch, Math.max(0, cooldown - dt));
    }
  });
}

function addJumpPad(scene, world, x, y, z, vy, vx = 0, vz = 0, color = 0x30e0ff, playersOnly = false) {
  world.jumpPads.push({ x, y, z, r: 1.7, vy, vx, vz, playersOnly });
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
  const hookX = zone.exitX ?? (leanLen > 0.001 ? leanX / leanLen : 1);
  const hookZ = zone.exitZ ?? (leanLen > 0.001 ? leanZ / leanLen : 0);
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
  world.pickups.push(Object.assign({ kind, pos: V(x, y, z) }, extra));
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
function arenaLabelTexture(text, accent = '#ff7a2d') {
  const key = `${text}:${accent}`;
  if (arenaLabelCache.has(key)) return arenaLabelCache.get(key);
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 128;
  const g = canvas.getContext('2d');
  g.fillStyle = '#09131f'; g.fillRect(0, 0, 512, 128);
  g.fillStyle = accent; g.fillRect(0, 0, 13, 128);
  g.fillRect(26, 18, 460, 4); g.fillRect(26, 106, 460, 4);
  g.font = '900 52px Arial Black, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = '#f4f1e8';
  g.shadowColor = accent; g.shadowBlur = 9;
  g.fillText(text, 266, 65, 444);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  arenaLabelCache.set(key, texture);
  return texture;
}

function addArenaSign(parent, text, x, y, z, w, h, yaw = 0, accent = '#ff7a2d') {
  const material = new THREE.MeshBasicMaterial({
    map: arenaLabelTexture(text, accent),
    side: THREE.DoubleSide,
    toneMapped: false,
    ...DECOR_DEPTH_BIAS,
  });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
  sign.position.set(x, y, z);
  sign.rotation.y = yaw;
  parent.add(sign);
  return sign;
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
function buildFortress(scene) {
  const world = newWorld({ killY: -20, waypointLinkDist: 22, waypointLinkDy: 4.6 });
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
  // Mount the bridge-house vines on the outer faces of their 2.2m support
  // columns. Using the column centers left the visible sheets floating/clipped.
  addVine(scene, world, -46.3, -10.2, 0.2, 6.9, 0.85, -0.24, 0);
  addVine(scene, world, -33.7, -10.2, 0.2, 6.9, 0.85, 0.24, 0);
  addVine(scene, world, 33.7, 10.2, 0.2, 6.9, 0.85, -0.24, 0);
  addVine(scene, world, 46.3, 10.2, 0.2, 6.9, 0.85, 0.24, 0);
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
  pk(world, 'ammo', 8, 8.2, 30, { weapon: 'parasite' });
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
    [-72, 0, -26], [-50, 0, -26], [-30, 0, -30], [-10, 0, -26], [10, 0, -26], [30, 0, -30], [50, 0, -26], [72, 0, -26],
    [-60, 0, -12], [-40, 0, -12], [-20, 0, -12], [0, 0, -12], [20, 0, -12], [40, 0, -12], [60, 0, -12],
    // north field
    [-72, 0, 26], [-50, 0, 26], [-30, 0, 24], [30, 0, 24], [50, 0, 26], [72, 0, 26],
    [-60, 0, 12], [-40, 0, 12], [-20, 0, 12], [20, 0, 12], [40, 0, 12], [60, 0, 12],
    [-24, 0, 40], [24, 0, 40], [-45, 0, 40], [45, 0, 40], [0, 0, 43.5],
    // roofed southwest sluice
    [-58, 0, -30.5], [-52.5, 0, -30.5], [-46.5, 0, -30.5],
    // bridges
    [0, 0, 0], [-40, 0, 0], [40, 0, 0],
    [-40, 3.4, 18], [-40, 6.8, 5], [-40, 8.9, -5.5], [-40, 11, 0],
    [40, 3.4, -18], [40, 6.8, -5], [40, 8.9, 5.5], [40, 11, 0],
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
    [9.75, 7.8, 18], [9.75, 10.625, 22], [9.75, 13.45, 26], [9.75, 16.275, 30], [9.75, 19.1, 34.75],
    [-9.75, 19.1, 17.25], [-9.75, 16.275, 22], [-9.75, 13.45, 26], [-9.75, 10.625, 30], [-9.75, 7.8, 34],
    [-6, 19.1, 18], [0, 19.1, 26], [6, 19.1, 34],
    [0, 19.1, 12], [0, 19.1, 8], [0, 19.1, 3], [0, 19.1, 0],
    [22, 3.9, 27], [34, 0, 27],
    // towers
    [64, 7.6, 38], [52, 3.8, 38], [44, 0, 38],
    [-64, 7.6, -38], [-52, 3.8, -38], [-44, 0, -38],
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
    [1, 10.2, -24.5], [0, 12.6, -15.5],
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
  // Boulder keel under the slab. Its rounded top can poke above wide decks,
  // so pair it with a sphere collider instead of letting players clip through.
  const r = Math.min(w, d) * 0.5;
  const keelX = x + rand(-1, 1);
  const keelY = y - thick - r * 0.5;
  const keelZ = z + rand(-1, 1);
  const keel = new THREE.IcosahedronGeometry(r, 1);
  keel.scale(1, 0.85, 1);
  keel.rotateX(rand(0, 3)); keel.rotateY(rand(0, 3)); keel.rotateZ(rand(0, 3));
  keel.translate(keelX, keelY, keelZ);
  bake(keel, 2);
  world.colliders.push({ type: 'sphere', center: V(keelX, keelY, keelZ), radius: r * 0.85 });
}

function buildAsteroids(scene) {
  const world = newWorld({
    gravity: 5, jumpVel: 8.4, killY: -60, playerSpeed: 12,  // match the bots' hop range
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
  scene.background = new THREE.Color(0x05060f);
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

  // Starfield (two layers) + nebula sprites
  for (const [n, size, rMin, rMax, color] of [[1200, 1.4, 380, 500, 0xffffff], [300, 2.4, 350, 450, 0xaaccff]]) {
    const geo = new THREE.BufferGeometry();
    const posArr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = V(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize().multiplyScalar(rand(rMin, rMax));
      posArr.set([v.x, v.y, v.z], i * 3);
    }
    geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    scene.add(new THREE.Points(geo, new THREE.PointsMaterial({ color, size, sizeAttenuation: false })));
  }
  const nebTex = canvasTex('nebula', (g) => {
    const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,.9)');
    grad.addColorStop(0.4, 'rgba(255,255,255,.25)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad; g.fillRect(0, 0, 128, 128);
  });
  for (const [x, y, z, s, c] of [[-320, 80, -240, 420, 0x4455cc], [300, -60, 200, 380, 0xcc4477], [80, 200, 320, 300, 0x33aa88]]) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: nebTex, color: c, transparent: true, opacity: 0.24, depthWrite: false }));
    sp.position.set(x, y, z);
    sp.scale.setScalar(s);
    scene.add(sp);
  }

  // Ringed planet
  const planet = new THREE.Mesh(new THREE.SphereGeometry(70, 32, 24), mat(0xcc5a2e, { roughness: 1 }));
  planet.position.set(-280, 110, -400);
  scene.add(planet);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(112, 7, 8, 64),
    new THREE.MeshBasicMaterial({ color: 0x8899bb, transparent: true, opacity: 0.4 }));
  ring.position.copy(planet.position);
  ring.rotation.x = 2.3; ring.rotation.y = 0.5;
  scene.add(ring);

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
  pk(world, 'weapon', 0, 9.3, 28, { weapon: 'parasite' });       // station bridge approach
  pk(world, 'ammo', 13, -7.8, 72, { weapon: 'whomper' });
  pk(world, 'ammo', -40, 13.2, -46, { weapon: 'sidewinder' });
  pk(world, 'ammo', 8, 9.3, 28, { weapon: 'parasite' });
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

/* ============== MAP 4 — CANOPY (giant forest, vertical to y=30) ==============
   Five colossal trees with branch decks at 10/20, a tiered center tree
   (8/16/24/crown 30 with the gold), edge bridges, ramps and pad chains up. */
function buildCanopy(scene) {
  const world = newWorld({ killY: -20, waypointLinkDist: 24, waypointLinkDy: 4.6 });
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
  // floating platforms + pads
  addBox(scene, world, 30, 13.7, 55, 10, 0.6, 10, 0x8a6a40, { tex: 'crate' });
  addJumpPad(scene, world, 21, 0, 55, 30, 5, 0, 0xffd23c);
  pk(world, 'star', 30, 14.2, 55, { hidden: true });
  wp(world, 21, 0, 55); wp(world, 30, 14, 55);
  world.manualLinks.push([21, 0, 55, 30, 14, 55, true]);
  addBox(scene, world, -35, 11.7, -60, 10, 0.6, 10, 0x8a6a40, { tex: 'crate' });
  addJumpPad(scene, world, -44, 0, -60, 28, 5, 0, 0xffd23c);
  pk(world, 'health', -35, 12.2, -60);
  wp(world, -44, 0, -60); wp(world, -35, 12, -60);
  world.manualLinks.push([-44, 0, -60, -35, 12, -60, true]);
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
    addBox(scene, world, tx, 15, tz, 8, 30, 8, 0x6b4a2e, { tex: 'crate', repeat: [2, 8] });
  }
  const TR = 0x6b4a2e;
  addBox(scene, world, -45, 26.5, -45, 8, 7, 8, TR, { tex: 'crate' });         // solid crown section
  addBox(scene, world, -48.4, 11.5, -45, 1.2, 23, 8, TR, { tex: 'crate' });    // shaft walls
  addBox(scene, world, -41.6, 11.5, -45, 1.2, 23, 8, TR, { tex: 'crate' });
  addBox(scene, world, -45, 11.5, -48.4, 5.6, 23, 1.2, TR, { tex: 'crate' });
  addBox(scene, world, -45, 9.75, -41.6, 5.6, 13.5, 1.2, TR, { tex: 'crate' }); // south wall (doors above/below)
  addBox(scene, world, -47.1, 1.5, -41.6, 1.4, 3, 1.2, TR, { tex: 'crate' });
  addBox(scene, world, -42.9, 1.5, -41.6, 1.4, 3, 1.2, TR, { tex: 'crate' });
  addBox(scene, world, -45, 18.25, -41.6, 5.6, 3.5, 1.2, TR, { tex: 'crate' });
  addBox(scene, world, -46.9, 21.5, -41.6, 1.8, 3, 1.2, TR, { tex: 'crate' });
  addBox(scene, world, -43.1, 21.5, -41.6, 1.8, 3, 1.2, TR, { tex: 'crate' });
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
  addBox(scene, world, -7.25, 3.95, 0, 1.5, 7.9, 16, 0x5e3f26, { tex: 'crate' });
  addBox(scene, world, 7.25, 3.95, 0, 1.5, 7.9, 16, 0x5e3f26, { tex: 'crate' });
  addBox(scene, world, 0, 3.95, -7.25, 13, 7.9, 1.5, 0x5e3f26, { tex: 'crate' });
  addBox(scene, world, -4.75, 3.95, 7.25, 5.5, 7.9, 1.5, 0x5e3f26, { tex: 'crate' });
  addBox(scene, world, 4.75, 3.95, 7.25, 5.5, 7.9, 1.5, 0x5e3f26, { tex: 'crate' });
  addRamp(scene, world, { axis: 'z', minX: -6, maxX: -3, minZ: -5, maxZ: 5, h0: 4, h1: 0, color: 0x8a6a40 });
  addBox(scene, world, -3, 3.7, -5.75, 6, 0.6, 1.5, 0x8a6a40, { tex: 'crate' }); // landing abuts the flight-1 top (overlap shoves climbers off)
  addRamp(scene, world, { axis: 'x', minX: 0, maxX: 8, minZ: -6.5, maxZ: -3.5, h0: 4, h1: 8, color: 0x8a6a40 });
  const roomLight = new THREE.PointLight(0xffb060, 25, 18);
  roomLight.position.set(0, 5, 0);
  scene.add(roomLight);
  addBox(scene, world, 0, 18.5, 0, 5, 21, 5, 0x5e3f26, { tex: 'crate', repeat: [2, 6] });

  // hedge lanes — break up the open lawn into corridors, plus a small maze
  // pocket in the SE quadrant (the pulsar sits inside it)
  for (const [hx, hz, hw, hd] of [
    [-15, 60, 50, 2], [15, -60, 50, 2], [60, 15, 2, 50], [-60, -15, 2, 50],
    [-30, 14, 2, 26], [30, -14, 2, 26],
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
  const LOG = 0x5e3f26;
  addBox(scene, world, -27, 1.4, -25.6, 14, 2.8, 0.5, LOG, { tex: 'crate' });
  addBox(scene, world, -27, 1.4, -22.4, 14, 2.8, 0.5, LOG, { tex: 'crate' });
  addBox(scene, world, -27, 3, -24, 14, 0.6, 3.7, LOG, { tex: 'crate', repeat: [4, 1] }); // top 3.3
  addBox(scene, world, -37, 0.8, -20, 3, 1.6, 3, 0x6b4a2e, { tex: 'crate' });  // stump steps up
  addBox(scene, world, -33, 1.3, -19.5, 3, 2.6, 3, 0x6b4a2e, { tex: 'crate' });

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
  addBox(scene, world, 0, 15.5, 0, 14, 1, 14, 0x8a6a40, { tex: 'crate' });
  addBox(scene, world, -3, 23.5, 0, 10, 1, 10, 0x8a6a40, { tex: 'crate' });
  addBox(scene, world, 4, 29.5, 0, 8, 1, 8, 0x9a7a4c, { tex: 'crate' });

  // Edge bridges butt exactly into the deck edges at the same height. Their
  // runs stop at z/x ±38, leaving no 2cm lip and no coplanar overlap.
  addBox(scene, world, -45, 19.5, 0, 3, 1, 76, 0x7a5c38, { tex: 'crate', repeat: [1, 10] });
  addBox(scene, world, 45, 19.5, 0, 3, 1, 76, 0x7a5c38, { tex: 'crate', repeat: [1, 10] });
  addBox(scene, world, 0, 9.5, -45, 76, 1, 3, 0x7a5c38, { tex: 'crate', repeat: [10, 1] });
  addBox(scene, world, 0, 9.5, 45, 76, 1, 3, 0x7a5c38, { tex: 'crate', repeat: [10, 1] });
  addVine(scene, world, -46.72, -18, 0.2, 19.1, 1.05, -0.18, 0, 1, 0);  // hanging from west bridge
  addVine(scene, world, 46.72, 16, 0.2, 19.1, 1.05, 0.18, 0, -1, 0);    // hanging from east bridge
  addVine(scene, world, -46.72, 30, 0.2, 19.1, 1.0, -0.18, 0, 1, 0);    // west bridge south drop
  addVine(scene, world, 46.72, -28, 0.2, 19.1, 1.0, 0.18, 0, -1, 0);    // east bridge north drop
  addVine(scene, world, -18, -46.72, 0.2, 9.1, 0.95, 0, -0.18, 0, 1);   // north catwalk drop
  addVine(scene, world, 20, 46.72, 0.2, 9.1, 0.95, 0, 0.18, 0, -1);     // south catwalk drop
  addVine(scene, world, 34, -46.72, 0.2, 9.1, 0.9, 0, -0.18, 0, 1);     // north catwalk east drop
  addVine(scene, world, -34, 46.72, 0.2, 9.1, 0.9, 0, 0.18, 0, -1);     // south catwalk west drop
  addVine(scene, world, 10.28, 3, 0.2, 8.1, 0.85, 0.22, 0, -1, 0);      // center-tree wall growth
  addVine(scene, world, 7.28, 6.35, 8.1, 16.1, 0.85, 0.16, 0, -1, 0);   // center 8 -> 16
  addVine(scene, world, 2.28, -4.75, 16.1, 24.1, 0.8, 0.16, 0, -1, 0);  // center 16 -> 24
  addVine(scene, world, -37.72, -45, 0.2, 20.1, 0.95, 0.18, 0, -1, 0);  // SW hollow tree exterior
  addVine(scene, world, -31.08, 15, 0.2, 4.1, 0.8, -0.14, 0, 1, 0);     // hedge-top shortcut
  addVine(scene, world, 52.28, -45, 0.2, 19.1, 0.9, 0.18, 0, -1, 0);    // NE trunk side
  addVine(scene, world, -52.28, 45, 0.2, 19.1, 0.9, -0.18, 0, 1, 0);    // NW trunk side
  addVine(scene, world, 45, 52.28, 0.2, 19.1, 0.9, 0, 0.18, 0, -1);     // SE trunk side
  addVine(scene, world, -2.8, -7.28, 0.2, 15.1, 0.85, 0, -0.16, 0, 1);  // center tiers north face
  addVine(scene, world, 31.34, 16, 0.2, 4.2, 0.75, 0.16, 0, -1, 0);     // ranger hut east wall
  addVine(scene, world, -11, 61.18, 0.2, 3.8, 0.8, 0, 0.16, 0, -1);     // north hedge lane
  addVine(scene, world, 61.18, -3, 0.2, 3.8, 0.8, 0.16, 0, -1, 0);      // east hedge lane

  // Ramps: ground ↔ center deck 8; bridges ↔ center 16 / center 8
  addRamp(scene, world, { axis: 'x', minX: 10, maxX: 42, minZ: -2, maxZ: 2, h0: 8, h1: 0, color: 0x8a6a40 });
  addRamp(scene, world, { axis: 'x', minX: -42, maxX: -10, minZ: -2, maxZ: 2, h0: 0, h1: 8, color: 0x8a6a40 });
  addRamp(scene, world, { axis: 'x', minX: -43.5, maxX: -7, minZ: -2, maxZ: 2, h0: 20, h1: 16, color: 0x8a6a40 });
  addRamp(scene, world, { axis: 'x', minX: 7, maxX: 43.5, minZ: -2, maxZ: 2, h0: 16, h1: 20, color: 0x8a6a40 });
  addRamp(scene, world, { axis: 'z', minX: -2, maxX: 2, minZ: -43.5, maxZ: -10, h0: 10, h1: 8, color: 0x8a6a40 });
  addRamp(scene, world, { axis: 'z', minX: -2, maxX: 2, minZ: 10, maxZ: 43.5, h0: 8, h1: 10, color: 0x8a6a40 });

  // Pads: ground → corner decks, center tier chain up to the crown
  addJumpPad(scene, world, -30, 0, -30, 24, -11.5, -11.5, 0x9dff70);
  addJumpPad(scene, world, 30, 0, -30, 24, 11.5, -11.5, 0x9dff70);
  addJumpPad(scene, world, -30, 0, 30, 24, -11.5, 11.5, 0x9dff70);
  addJumpPad(scene, world, 30, 0, 30, 24, 11.5, 11.5, 0x9dff70);
  // Opposite corner from the center-tree vines and outside the upper deck's
  // footprint. The gentle diagonal enters that footprint only once high
  // enough to clear its underside.
  addJumpPad(scene, world, -8, 8, 8, 22, 3, -1.05, 0xffd23c);  // 8 → 16
  addJumpPad(scene, world, 7, 16, 0, 22, -8, 0, 0xffd23c);    // 16 → 24 (offset west)
  addJumpPad(scene, world, -6, 24, 0, 20, 8.3, 0, 0xffd23c);  // 24 → crown (offset east)

  // Canopy blobs + bushes (visual only)
  const deco = { colliders: [], ramps: [] };
  const autumn = addAsteroid(scene, deco, 45, 33, 45, 13, 0xd8742a); // one tree turns first
  autumn.material.map = null;
  (world.foliageZones ||= []).push({ x: 45, y: 33, z: 45, r: 12.5 });
  for (const [x, y, z, r] of [[-45, 33, -45, 13], [45, 33, -45, 13], [-45, 33, 45, 13], [0, 39, 0, 16],
                              [-20, 1, -60, 3], [60, 1, 20, 3], [-60, 1, 10, 2.5], [25, 1, 60, 3]]) {
    const blob = addAsteroid(scene, deco, x, y, z, r, 0x3f7a33);
    blob.material.map = null;
    world.foliageZones.push({ x, y, z, r: r * 0.95 });
  }
  addCanopyBirdFlocks(scene, world);

  // Spawns
  for (const dz of [-25, -12, 0, 12, 25]) world.spawns.blue.push(V(-62, 0.1, dz));
  for (const dz of [-25, -12, 0, 12, 25]) world.spawns.red.push(V(62, 0.1, dz));
  // Keep these clear of trunks, ramps, and hedges. The multiplayer server
  // mirrors this pool so its authoritative position cannot snap a player into
  // scenery after the local spawn selection has placed them safely.
  for (const [x, y, z] of [[-32, 10.2, -40], [32, 10.2, 40], [0, 8.2, -7], [-62, 0.1, -25], [62, 0.1, 25],
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
    [0, 8, -7], [0, 8, 7], [-7, 8, 0], [-8, 8, 8],
    [0, 16, 4.5], [7, 16, 0], [-5, 16, -4], [-5, 16, 4],
    [-3, 24, 3], [-6, 24, 0],
    [4, 30, 0],
    // corner decks (offset off the trunk that pierces them)
    [-40, 10, -39.5], [40, 10, -39.5], [-40, 10, 39.5], [40, 10, 39.5],
    [-40, 20, -39.5], [40, 20, -39.5], [-40, 20, 39.5], [40, 20, 39.5],
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
    [-8, 8, 8, -5, 16, 4, true],      // pad chain up the center tree
    [7, 16, 0, -3, 24, 3, true],
    [-6, 24, 0, 4, 30, 0, true],
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
  addArenaSign(essential, 'VICE GALLERIA', -12, 29.2, 21.92, 17, 3.6, Math.PI, '#ff3ca6');
  addArenaSign(essential, 'LASER PALMS', 32, 22.5, -21.92, 14, 3.2, 0, '#32e7ff');
  addArenaSign(essential, 'MIDNIGHT ARCADE', -12, 14.3, -49.98, 16, 3.2, 0, '#ffd23c');
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
    [32, -35, 26, 28, 'north'], [-58, 33, 22, 24, null], [32, 34, 22, 18, null],
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
  addBox(scene, world, 0, 11.7, -20, 12, 0.6, 8, 0x5a4a78, { tex: 'neonwall' });
  addJumpPad(scene, world, -9, 0, -20, 28, 3.8, 0, 0x30e0ff);
  pk(world, 'shield', 0, 12.2, -20);
  wp(world, -9, 0, -20); wp(world, 0, 12, -20);
  world.manualLinks.push([-9, 0, -20, 0, 12, -20, true]);
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
  pk(world, 'ammo', -29, 8.2, 40, { weapon: 'parasite' });
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
  const gateColor = opts.color ?? 0x8a5fff;
  const dmat = new THREE.MeshStandardMaterial({ color: opts.bodyColor ?? 0x8a80a8, roughness: 0.55, metalness: 0.35,
    emissive: gateColor, emissiveIntensity: opts.runePhase == null ? 0.12 : 0.22 });
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
        if (dr.runePhase != null) {
          const active = world.runePhase === dr.runePhase;
          dr.material.emissiveIntensity = active ? 0.62 : 0.2;
        }
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
function addScragglyLava(scene, world, x, z, w, d, floorY, seed) {
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
    const phase = rnd() * 4, period = 1.4 + rnd() * 1.3;
    world.anim.push((dt, t) => {
      const k = ((t + phase) % period) / period;
      blob.visible = k < 0.4;
      const kk = k / 0.4;
      blob.position.set(px, surfY + 6 * kk * (1 - kk), pz);
    });
  }
  const glow = new THREE.PointLight(0xff5a20, 24, Math.max(18, Math.min(w, d)));
  glow.position.set(x, floorY + 2.5, z);
  scene.add(glow);
}

// Continuous square-ring moat for Olympus's outer basin. The outside follows
// the map boundary while the inner shoreline meanders naturally; the central
// hole remains safe ground both visually and in hazard queries.
function addOlympusLavaMoat(scene, world, outerR = 170, innerR = 151, floorY = -0.72) {
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

  for (const [x, z] of [[-158, -90], [158, 82], [-86, 158], [94, -158]]) {
    const glow = new THREE.PointLight(0xff4a18, 18, 34);
    glow.position.set(x, 2.2, z);
    scene.add(glow);
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
  baseLighting(scene, 0x8a7fb8, 0x1a1428, [40, 90, -30], 110);
  const STONE = 0x3e3358, FLOOR = 0x2c2440, DARK = 0x14101f;
  // Deliberately identical. Color-coded wings turned the labyrinth into a
  // compass; matching runes make every threshold feel plausibly familiar.
  const RUNE_COLORS = [0x9a78d8, 0x9a78d8, 0x9a78d8, 0x9a78d8];
  const runeLights = [];

  function addRuneBeacon(x, z, color, height = 4.2) {
    addBox(scene, world, x, 0.65, z, 1.5, 1.3, 1.5, DARK, { tex: 'rock' });
    addBox(scene, world, x, height * 0.5 + 0.7, z, 0.42, height, 0.42, color,
      { collide: false, shadow: false, emissive: color, emissiveIntensity: 1.55 });
    addBox(scene, world, x, height + 0.9, z, 1.15, 0.18, 1.15, color,
      { collide: false, shadow: false, emissive: color, emissiveIntensity: 2.0 });
    const light = new THREE.PointLight(color, 25, 24);
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
  addRamp(scene, world, { axis: 'x', minX: 30, maxX: 40, minZ: -2, maxZ: 2, h0: -6, h1: 0, color: STONE });
  addRamp(scene, world, { axis: 'x', minX: -40, maxX: -30, minZ: -2, maxZ: 2, h0: 0, h1: -6, color: STONE });
  addBox(scene, world, 0, -1.6, 5.9, 60, 0.3, 0.2, 0x30ffc8, { collide: false, shadow: false, emissive: 0x30ffc8, emissiveIntensity: 1.4 });
  addBox(scene, world, 0, -1.6, -5.9, 60, 0.3, 0.2, 0x30ffc8, { collide: false, shadow: false, emissive: 0x30ffc8, emissiveIntensity: 1.4 });
  const cryptLight = new THREE.PointLight(0x30ffc8, 30, 40);
  cryptLight.position.set(0, -3, 0);
  scene.add(cryptLight);

  // CENTER CHAMBER (36×36) + suspended Rune Engine over the crypt aperture.
  for (const s of [1, -1]) {
    addBox(scene, world, -10, 3, 18 * s, 16, 6, 1.2, STONE, { tex: 'rock' });
    addBox(scene, world, 10, 3, 18 * s, 16, 6, 1.2, STONE, { tex: 'rock' });
    addBox(scene, world, 18 * s, 3, -10, 1.2, 6, 16, STONE, { tex: 'rock' });
    addBox(scene, world, 18 * s, 3, 10, 1.2, 6, 16, STONE, { tex: 'rock' });
    addBox(scene, world, 0, 4.8, 18.8 * s, 24, 0.35, 0.25, 0x8a5fff, { collide: false, shadow: false, emissive: 0x8a5fff, emissiveIntensity: 1.4 });
    addBox(scene, world, 18.8 * s, 4.8, 0, 0.25, 0.35, 24, 0x8a5fff, { collide: false, shadow: false, emissive: 0x8a5fff, emissiveIntensity: 1.4 });
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
  const obLight = new THREE.PointLight(0x8a5fff, 55, 34);
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
      { shadow: false, emissive: 0x8a5fff, emissiveIntensity: 0.58 });
  }
  for (const [x, z] of [[12.1, 12.1], [-12.1, 12.1], [12.1, -12.1], [-12.1, -12.1]]) {
    addBox(scene, world, x, 6.2, z, 0.24, 1.55, 0.24, 0xc9b4ff,
      { shadow: false, emissive: 0x8a5fff, emissiveIntensity: 0.7 });
  }
  addRamp(scene, world, { axis: 'z', minX: -2, maxX: 2, minZ: 15.5, maxZ: 26.5,
    h0: 5.45, h1: 6.5, color: STONE });
  addRamp(scene, world, { axis: 'z', minX: -2, maxX: 2, minZ: -26.5, maxZ: -15.5,
    h0: 6.5, h1: 5.45, color: STONE });

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
    obLight.intensity = 42 + pulse * 28;
    runeLights.forEach((light, i) => {
      light.intensity = i === phase ? 40 + pulse * 12 : 15;
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
  addRamp(scene, world, { axis: 'x', minX: -43, maxX: -33, minZ: -8.8, maxZ: -5.8, h0: 5, h1: 0, color: STONE });
  // Mirrored E room balcony and ramp feed the southeast roof loop.
  addBox(scene, world, 39.4, 4.7, -1.5, 8, 0.6, 14.6, STONE, { tex: 'rock' });
  addRamp(scene, world, { axis: 'x', minX: 33, maxX: 43, minZ: 5.8, maxZ: 8.8, h0: 0, h1: 5, color: STONE });

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
        collide: false, shadow: false, emissive: RUNE_COLORS[wing], emissiveIntensity: 0.82,
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
    h0: 5.5, h1: 6.5, color: STONE });
  // Rail endpoints meet two corner posts exactly; no rail volumes overlap.
  for (const [x, z] of [[-40.9, 31.9], [-37.1, 28.1]]) {
    addBox(scene, world, x, 6.2, z, .24, 1.55, .24, RUNE_COLORS[3],
      { shadow: false, emissive: RUNE_COLORS[3], emissiveIntensity: 0.52 });
  }
  for (const [x, z, w, d] of [
    [-40.9, 17.89, .12, 27.78],
    [-37.1, 15.99, .12, 23.98],
    [-26.99, 28.1, 19.98, .12],
    [-28.89, 31.9, 23.78, .12],
  ]) {
    addBox(scene, world, x, 6.15, z, w, 1.35, d, RUNE_COLORS[3],
      { shadow: false, emissive: RUNE_COLORS[3], emissiveIntensity: 0.52 });
  }

  // Exact rotational counterpart to the NW elevated shortcut: east balcony
  // → southeast ambulatory → Storm Cloister roof. Matching silhouette and
  // rail rhythm stop the upper route from revealing which half of the maze
  // the player is in.
  addBox(scene, world, 39, 5.25, -16, 4, 0.5, 24, STONE, { tex: 'rock', repeat: [1, 6] });
  addBox(scene, world, 27, 5.25, -30, 20, 0.5, 4, STONE, { tex: 'rock', repeat: [5, 1] });
  addBox(scene, world, 39, 5.25, -30, 4, 0.5, 4, STONE, { tex: 'rock' });
  addRamp(scene, world, { axis: 'x', minX: 13, maxX: 18, minZ: -32, maxZ: -28,
    h0: 6.5, h1: 5.5, color: STONE });
  for (const [x, z] of [[40.9, -31.9], [37.1, -28.1]]) {
    addBox(scene, world, x, 6.2, z, .24, 1.55, .24, RUNE_COLORS[0],
      { shadow: false, emissive: RUNE_COLORS[0], emissiveIntensity: 0.52 });
  }
  for (const [x, z, w, d] of [
    [40.9, -17.89, .12, 27.78],
    [37.1, -15.99, .12, 23.98],
    [26.99, -28.1, 19.98, .12],
    [28.89, -31.9, 23.78, .12],
  ]) {
    addBox(scene, world, x, 6.15, z, w, 1.35, d, RUNE_COLORS[0],
      { shadow: false, emissive: RUNE_COLORS[0], emissiveIntensity: 0.52 });
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
        { collide: false, shadow: false, emissive: portalColor, emissiveIntensity: 0.82 });
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

  // Matching rune gates occupy every constructed doorway. Their glow follows
  // the engine's pulse, but all doors remain strictly proximity-driven to
  // preserve occlusion and stop long-range shots through unattended openings.
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
  addRamp(scene, world, { axis: 'x', minX: -28.2, maxX: -26.2, minZ: -1.5, maxZ: 1.5, h0: -6, h1: -5.3, color: 0x1a1428 });
  addRamp(scene, world, { axis: 'x', minX: -15.8, maxX: -13.8, minZ: -1.5, maxZ: 1.5, h0: -5.3, h1: -6, color: 0x1a1428 });

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

function addBloomFacePortal(scene, world, x, y, z, w, h, yaw = 0) {
  addMagicPortal(scene, world, x, y, z, w, h, 0x365f08, yaw);
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
  scene.add(faces);
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
  }), 0xbfd923);
  styleBloomRamp(addRamp(arenaRoot, world, {
    axis: 'z', minX: -4, maxX: 4, minZ: -18, maxZ: -12,
    h0: 4, h1: 0, color: 0xe53e13,
  }), 0xe1531d);
  styleBloomRamp(addRamp(arenaRoot, world, {
    axis: 'x', minX: 12, maxX: 18, minZ: -4, maxZ: 4,
    h0: 0, h1: 4, color: 0xff9d12,
  }), 0xe8931b);
  styleBloomRamp(addRamp(arenaRoot, world, {
    axis: 'x', minX: -18, maxX: -12, minZ: -4, maxZ: 4,
    h0: 4, h1: 0, color: 0x69d51a,
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

  // Bodies change representative at the 7m/36m similarity seam. Ease their
  // *height* toward the adjacent layer's scale over the last few metres, but
  // keep the group origin at the feet. Scaling around the eye lifted grounded
  // actors several metres into the air on the corresponding outer copy.
  const seamVisualScale = point => {
    const norm = Math.max(Math.abs(point.x), Math.abs(point.y), Math.abs(point.z));
    const seamT = THREE.MathUtils.clamp(
      (norm - PORTAL_HALF) / ACTOR_SEAM_BLEND,
      0,
      1,
    );
    const easedT = seamT * seamT * (3 - 2 * seamT);
    return THREE.MathUtils.lerp(INNER_SCALE, 1, easedT);
  };
  world.characterVisualScale = character => seamVisualScale(character.pos);
  world.characterMoveScale = character => seamVisualScale(character.pos);

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
    // player falling through the recursive opening. A grounded runner's
    // planar velocity uses the same similarity transform; characterMoveScale
    // then eases it back across the inner band, so apparent speed is continuous
    // instead of jumping by the full recursion ratio on the crossing frame.
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
      character.vel.x *= factor;
      character.vel.y = 0;
      character.vel.z *= factor;
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

const GATE_FRAME_INDEX = { arena: 0, fortress: 1, asteroids: 2, canopy: 3, city: 4, sanctum: 5 };
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

function addMagicPortal(scene, world, x, y, z, w, h, color, yaw = 0) {
  const material = portalMaterial(color);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
    material);
  const nX = Math.sin(yaw);
  const nZ = Math.cos(yaw);
  m.position.set(x + nX * PORTAL_SURFACE_EPS, y, z + nZ * PORTAL_SURFACE_EPS);
  m.rotation.y = yaw;
  m.renderOrder = 2;
  scene.add(m);
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

function addCanopyBirdFlocks(scene, world) {
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

  const rainCount = 1900;
  const rainPositions = new Float32Array(rainCount * 6);
  const rainWindX = -0.42;
  const rainWindZ = 0.18;
  const rainLenY = 3.2;
  const rainLenScale = 1.65;
  const resetDrop = (i, y = rand(8, 44)) => {
    const j = i * 6;
    const x = rand(-92, 92);
    const z = rand(-92, 92);
    rainPositions[j] = x;
    rainPositions[j + 1] = y;
    rainPositions[j + 2] = z;
    rainPositions[j + 3] = x + rainWindX * rainLenScale;
    rainPositions[j + 4] = y - rainLenY;
    rainPositions[j + 5] = z + rainWindZ * rainLenScale;
  };
  for (let i = 0; i < rainCount; i++) resetDrop(i);
  const rainGeo = new THREE.BufferGeometry();
  rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPositions, 3));
  const rainMat = new THREE.LineBasicMaterial({
    color: 0xb4ddff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const rain = new THREE.LineSegments(rainGeo, rainMat);
  rain.frustumCulled = false;
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
      const fall = 55 * dt;
      const windX = rainWindX * fall / rainLenY;
      const windZ = rainWindZ * fall / rainLenY;
      for (let i = 0; i < rainCount; i++) {
        const j = i * 6;
        rainPositions[j] += windX;
        rainPositions[j + 1] -= fall;
        rainPositions[j + 2] += windZ;
        rainPositions[j + 3] += windX;
        rainPositions[j + 4] -= fall;
        rainPositions[j + 5] += windZ;
        if (rainPositions[j + 4] < -4 || Math.abs(rainPositions[j]) > 96 || Math.abs(rainPositions[j + 2]) > 96) resetDrop(i, rand(40, 56));
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

function addGateBrick(scene, world, id, color, x, y, z, w, h, d) {
  world.colliders.push({
    type: 'box',
    min: V(x - w / 2, y - h / 2, z - d / 2),
    max: V(x + w / 2, y + h / 2, z + d / 2),
  });
  const brick = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), gateBrickMaterial(id, color));
  brick.position.set(x, y, z);
  brick.castShadow = brick.receiveShadow = true;
  scene.add(brick);
  return brick;
}

function addAtriumGateBrickFrame(scene, world, id, color, px, pz, horiz) {
  const sideCenters = [-4, 4];
  const brickH = 1.55;
  for (const u of sideCenters) {
    for (let i = 0; i < 4; i++) {
      const y = brickH / 2 + i * brickH;
      if (horiz) addGateBrick(scene, world, id, color, px + u, y, pz, 1.6, brickH, 1.6);
      else addGateBrick(scene, world, id, color, px, y, pz + u, 1.6, brickH, 1.6);
    }
  }
  const lintelY = 6.9;
  const lintelH = 1.4;
  for (const u of sideCenters) {
    if (horiz) addGateBrick(scene, world, id, color, px + u, lintelY, pz, 1.6, lintelH, 1.6);
    else addGateBrick(scene, world, id, color, px, lintelY, pz + u, 1.6, lintelH, 1.6);
  }
  for (let i = 0; i < 4; i++) {
    const u = -2.4 + i * 1.6;
    if (horiz) addGateBrick(scene, world, id, color, px + u, lintelY, pz, 1.6, lintelH, 1.6);
    else addGateBrick(scene, world, id, color, px, lintelY, pz + u, 1.6, lintelH, 1.6);
  }
}

export function buildAtrium(scene) {
  const world = newWorld({ killY: -30, playerSpeed: 12.5 });
  scene.background = new THREE.Color(0xd99cb0);
  scene.fog = new THREE.Fog(0xd99cb0, 120, 340);
  baseLighting(scene, 0xffe0c8, 0x8a6a90, [-40, 80, 30], 90);

  addAtriumSkyDome(scene);

  // courtyard floor + perimeter (inner faces at x ±32, z ±48)
  addBox(scene, world, 0, -0.5, 0, 64, 1, 96, 0x8a8598, { tex: 'neonfloor', repeat: [8, 12] });
  addBox(scene, world, 0, 6, -49.5, 70, 12, 3, 0x6a5f88, { tex: 'neonwall', repeat: [9, 2] });
  addBox(scene, world, 0, 6, 49.5, 70, 12, 3, 0x6a5f88, { tex: 'neonwall', repeat: [9, 2] });
  addBox(scene, world, -33.5, 6, 0, 3, 12, 99, 0x6a5f88, { tex: 'neonwall', repeat: [12, 2] });
  // east wall hides a doorway in the NE corner (z 40..44) behind a slab —
  // slip around its north edge into the passage to the secret gate
  addBox(scene, world, 33.5, 6, -4.75, 3, 12, 89.5, 0x6a5f88, { tex: 'neonwall', repeat: [11, 2] });
  addBox(scene, world, 33.5, 6, 46.75, 3, 12, 5.5, 0x6a5f88, { tex: 'neonwall' });
  addBox(scene, world, 33.5, 8.5, 42, 3, 7, 4, 0x6a5f88, { tex: 'neonwall' });     // lintel
  addBox(scene, world, 31.7, 2.5, 40, 0.6, 5, 5.6, 0x6a5f88, { tex: 'neonwall' }); // concealer slab, back face flush with wall
  addBox(scene, world, 33.5, -0.5, 42, 3, 1, 4, 0x3a3452, { tex: 'panel' });       // threshold owns only the wall thickness
  // the passage: east hallway, then a leg north to the gate chamber
  // hall pieces start at the outer wall face (x 35); the threshold ends there,
  // so the floor planes meet edge-to-edge without coplanar overlap.
  addBox(scene, world, 41.5, -0.5, 42, 13, 1, 8, 0x3a3452, { tex: 'panel' });
  addBox(scene, world, 44, -0.5, 24, 8, 1, 28, 0x3a3452, { tex: 'panel' });
  addBox(scene, world, 37.5, 3, 38.3, 5, 6, 0.6, 0x4a4266, { tex: 'neonwall' });
  addBox(scene, world, 41.5, 3, 45.7, 13, 6, 0.6, 0x4a4266, { tex: 'neonwall' });
  addBox(scene, world, 47.7, 3, 28, 0.6, 6, 36, 0x4a4266, { tex: 'neonwall' });
  addBox(scene, world, 40.3, 3, 24, 0.6, 6, 28, 0x4a4266, { tex: 'neonwall' });
  addBox(scene, world, 44, 3, 10.3, 8, 6, 0.6, 0x4a4266, { tex: 'neonwall' });     // gate wall
  addBox(scene, world, 41.5, 6.1, 42, 13, 0.6, 8, 0x3a3452, { tex: 'panel' });     // roofs
  addBox(scene, world, 44, 6.1, 24, 8, 0.6, 28, 0x3a3452, { tex: 'panel' });
  addMagicPortal(scene, world, 44, 3, 10.9, 7.95, 6.0, 0x8a5fff, 0);
  const sancLight = new THREE.PointLight(0x8a5fff, 20, 16);
  sancLight.position.set(44, 3, 14);
  scene.add(sancLight);

  // A second secret is inset into the same hidden passage as Prism Run.
  // Its trigger hugs the east wall, so simply walking down the corridor does
  // not enter it; the player has to notice the watching faces and approach.
  addBloomFacePortal(scene, world, 47.34, 3, 27.2, 5.7, 5.45, -Math.PI / 2);
  for (const [y, z, w, h, d] of [
    [3, 24.05, 0.46, 6, 0.46],
    [3, 30.35, 0.46, 6, 0.46],
    [0.22, 27.2, 0.46, 0.44, 6.75],
    [5.78, 27.2, 0.46, 0.44, 6.75],
  ]) {
    addBox(scene, world, 47.24, y, z, w, h, d, 0x91b91c, {
      collide: false,
      shadow: false,
      emissive: 0x4d0a00,
      emissiveIntensity: 0.32,
    });
  }
  const bloomGateLight = new THREE.PointLight(0xcfff2c, 9, 15);
  bloomGateLight.position.set(45.2, 3.2, 27.2);
  scene.add(bloomGateLight);

  // grass boulevard + fountain. End rim slabs own the corners; side slabs stop
  // between them so their top faces never overlap and shimmer.
  addBox(scene, world, 0, 0.06, 14, 12, 0.14, 52, 0x3f7a35, { tex: 'atrium-grass', repeat: [2, 9] });
  addBox(scene, world, 0, 0.45, -22, 16, 0.9, 2, 0x555a74, { tex: 'panel' });   // pool rim
  addBox(scene, world, 0, 0.45, -34, 16, 0.9, 2, 0x555a74, { tex: 'panel' });
  addBox(scene, world, -8, 0.45, -28, 2, 0.9, 10, 0x555a74, { tex: 'panel' });
  addBox(scene, world, 8, 0.45, -28, 2, 0.9, 10, 0x555a74, { tex: 'panel' });
  addFittedWater(scene, world, {
    minX: -7, maxX: 7, minZ: -33, maxZ: -23, y: 0.55,
  });
  addBox(scene, world, 0, 1.6, -28, 0.7, 2.6, 0.7, 0x9fd8ff, { collide: false, shadow: false, emissive: 0x9fd8ff, emissiveIntensity: 1.2 }); // jet
  const fLight = new THREE.PointLight(0x9fd8ff, 25, 24);
  fLight.position.set(0, 3, -28);
  scene.add(fLight);

  // rooftop billboard above the north wall
  makeSign(scene, 0, 15.5, -48.5, 26, '#ff4d2e', 'NERF ARENA BLAST REVIVAL');
  addBox(scene, world, -11, 12.7, -48.5, 0.4, 1.8, 0.4, 0x3a3452);
  addBox(scene, world, 11, 12.7, -48.5, 0.4, 1.8, 0.4, 0x3a3452);

  // Gate bays. The long side walls hold the six arenas; the axial gates are
  // reserved for the Hall of Fame ahead and multiplayer behind the spawn.
  world.portals = [];
  const bays = [
    ['hall', 'HALL OF FAME', 0xffd45a, 'n', 0, 'hall'],
    ['fortress', 'FORTRESS FALLS', 0x9a6fe0, 'w', 24, 'map'],
    ['asteroids', 'ASTEROID BELT', 0x8fb8d8, 'w', 0, 'map'],
    ['sanctum', 'THE LABYRINTH', 0x8a5fff, 'w', -24, 'map'],
    ['canopy', 'CANOPY', 0x4dbf6a, 'e', 24, 'map'],
    ['city', 'NEON HEIGHTS', 0xff40a0, 'e', 0, 'map'],
    ['arena', 'BLAST COMPLEX', 0xd88a2b, 'e', -24, 'map'],
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
    // sign panel flat on the wall above the gate (inner faces: z ±48, x ±32)
    makeSign(scene, horiz ? px : sgn * 31.9, 10.2, horiz ? sgn * 47.95 : pz, 13,
      '#' + color.toString(16).padStart(6, '0'), name,
      horiz ? (sgn === -1 ? 0 : Math.PI) : -sgn * Math.PI / 2);
    const L = new THREE.PointLight(color, 26, 20);
    L.position.set(horiz ? px : px - sgn * 2.5, 4.5, horiz ? pz - sgn * 2.5 : pz);
    scene.add(L);
    const trigger = { x: horiz ? px : px + sgn * 0.5, z: horiz ? pz + sgn * 0.5 : pz };
    if (kind === 'hall') world.hallPortal = trigger;
    else if (kind === 'multiplayer') world.multiplayerPortal = trigger;
    else world.portals.push({ ...trigger, map: id, name });
  }
  world.portals.push({ x: 44, z: 11.5, map: 'prism', name: '???' });
  world.portals.push({ x: 46.7, z: 27.2, radius: 1.35, map: 'bloom', name: '???' });

  // flower borders flanking the boulevard
  addBox(scene, world, -8.5, 0.036, 14, 5, 0.07, 52, 0xd8a8c8, { tex: 'flowers', repeat: [1, 10] });
  addBox(scene, world, 8.5, 0.036, 14, 5, 0.07, 52, 0xd8a8c8, { tex: 'flowers', repeat: [1, 10] });

  // controls board to the left of spawn (replaces the old overlay text)
  {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 512;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(8,10,28,.92)';
    g.beginPath(); g.roundRect(8, 8, 496, 496, 22); g.fill();
    g.lineWidth = 6; g.strokeStyle = '#ffd23c'; g.stroke();
    g.textAlign = 'center';
    g.fillStyle = '#ffd23c';
    g.font = 'bold 44px "Arial Black", Arial';
    g.fillText('CONTROLS', 256, 72);
    g.font = 'bold 27px Arial';
    g.fillStyle = '#dde2ff';
    const lines = ['WASD — move', 'Mouse — aim + shoot', 'Space — jump',
      '1–9 / wheel — weapons', 'Tab — scoreboard', 'F — fullscreen · G — glow', 'Esc — pause',
      '', 'Walk into a gate to play!'];
    lines.forEach((t, i) => g.fillText(t, 256, 128 + i * 42));
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const board = new THREE.Mesh(new THREE.PlaneGeometry(7, 7),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
    board.position.set(-12, 4.4, 39);
    board.rotation.y = Math.PI / 2.6; // angled toward the spawn
    scene.add(board);
    addBox(scene, world, -12, 0.45, 39, 0.35, 0.9, 0.35, 0x3a3452);
  }

  // mode pad beside the spawn
  addBox(scene, world, 11, 0.3, 38, 3.4, 0.6, 3.4, 0x2a6a8a, { tex: 'panel' });
  addBox(scene, world, 11, 0.66, 38, 2.6, 0.1, 2.6, 0x30e0ff, { collide: false, shadow: false, emissive: 0x30e0ff, emissiveIntensity: 0.9 });
  world.modePad = { x: 11, z: 38 };
  addBox(scene, world, 11, 1.6, 36.6, 0.3, 3.2, 0.3, 0x3a3452); // sign post at the pad's back edge
  world.setModeSign = makeSign(scene, 11, 3.6, 36.8, 9, '#30e0ff', 'MODE: FREE FOR ALL', 0, true);

  // a little clutter so it feels lived-in
  addBox(scene, world, -14, 1.2, 30, 2.4, 2.4, 2.4, 0xb0763a, { tex: 'crate' });
  addBox(scene, world, -16.6, 1.2, 31, 2.4, 2.4, 2.4, 0xb0763a, { tex: 'crate' });
  addBox(scene, world, -15, 3.6, 30.4, 2.4, 2.4, 2.4, 0xb0763a, { tex: 'crate' });
  addDecal(scene, 'poster1', -24, 6, -47.94, 8, 0);
  addDecal(scene, 'target', 27, 6, -47.94, 8, 0);
  // Keep the side posters in the open end bays rather than behind the newly
  // relocated Fortress and Blast gates.
  addDecal(scene, 'hazard', -31.94, 6, 38, 8, Math.PI / 2);
  addDecal(scene, 'hazard', 31.94, 6, -38, 8, -Math.PI / 2);
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
  asteroids: 'ASTEROID BELT',
  canopy: 'CANOPY',
  city: 'NEON HEIGHTS',
  sanctum: 'THE LABYRINTH',
  prism: 'PRISM RUN',
  olympus: 'OLYMPUS MONS',
};

const HALL_AWARD_LABELS = [
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
  for (const [offset, height] of [[-50, 3.2], [0, 4.2], [50, 3.2]]) {
    const jet = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.16, height, 10), new THREE.MeshBasicMaterial({
      color: 0xc8f5ff,
      transparent: true,
      opacity: 0.76,
    }));
    jet.position.set(x, 0.24 + height / 2, z + offset);
    scene.add(jet);
    const light = new THREE.PointLight(0x8de8ff, 9, 18);
    light.position.set(x, 1.2, z + offset);
    scene.add(light);
    world.anim.push((dt, t) => {
      jet.scale.y = 0.84 + Math.sin(t * 2.2 + offset) * 0.12;
      jet.material.opacity = 0.64 + Math.sin(t * 3.1 + offset) * 0.12;
    });
  }
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
  addBox(scene, world, 0, 5.2, 110.8, 15, 10.4, 1.1, 0xd0a338, { emissive: 0x6b4700, emissiveIntensity: 0.22 });
  addMagicPortal(scene, world, 0, 5.2, 110.15, 11.2, 8.8, 0x73dcff, Math.PI);
  makeSign(scene, 0, 14.5, 110.1, 22, '#73dcff', 'RETURN TO THE ATRIUM', Math.PI);
  addHallGoldPowerupOrnament(scene);
  world.hallExitPortal = { x: 0, z: 106.5 };

  // The back wall is now a proper monument with large, separately spaced title
  // bands above the champion cards rather than a stack of overlapping signs.
  makeSign(scene, 0, 45, -110.85, 42, '#ffd75e', 'THE IMMORTAL HALL OF FAME', 0);
  makeSign(scene, 0, 33, -110.8, 30, '#fff1c9', 'TOP 100 CHAMPIONS', 0);

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
  // A compound inset core makes the crag genuinely solid without using the
  // loose full-bounds AABB that previously snagged players outside the mesh.
  // The broad lower box blocks every walk-through line; a narrower column
  // reaches the actual crown so a player landing from above cannot fall
  // through. Both boxes remain well inside the crag's minimum radial extent.
  if (collide) {
    geo.computeBoundingBox();
    const localBottom = geo.boundingBox?.min.y ?? -radius * 0.44;
    const localTop = geo.boundingBox?.max.y ?? radius * 0.54;
    const baseTop = Math.min(localTop - 0.08, radius * 0.34);
    world.colliders.push({
      type: 'box',
      min: V(x - radius * 0.52, y + localBottom + 0.04, z - radius * 0.52),
      max: V(x + radius * 0.52, y + baseTop, z + radius * 0.52),
    });
    world.colliders.push({
      type: 'box',
      min: V(x - radius * 0.28, y + baseTop - 0.04, z - radius * 0.28),
      max: V(x + radius * 0.28, y + localTop - 0.04, z + radius * 0.28),
    });
  }
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
  const cavernHemi = new THREE.HemisphereLight(0x8a4b3c, 0x140405, 0.8);
  const cavernRim = new THREE.DirectionalLight(0xff804d, 0.7);
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

// Flat-topped volcanic fragments for Olympus Mons sky routes. The tapered,
// low-poly visual keeps the rocks irregular while the inset box collider gives
// players a dependable landing surface after a jump-pad launch.
function addOlympusFloatingRock(scene, world, x, y, z, w, d, depth, seed, cavern = false) {
  const visualDepth = cavern ? Math.min(depth, 3.2) : depth;
  // Keep the original seven-sided floating-rock silhouette. Cavern variants
  // use only a tiny underside guard so their collider cannot end above a low
  // visual facet; the landing surface and inset footprint remain unchanged.
  const colliderBottom = y - visualDepth * (cavern ? 1.025 : 1);
  world.colliders.push({
    type: 'box',
    min: V(x - w * 0.44, colliderBottom, z - d * 0.44),
    max: V(x + w * 0.44, y, z + d * 0.44),
  });
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
}

// Upright, grounded volcanic mound. Unlike a floating island, it is broad at
// the floor and narrow at the crown; four slope fields make the visible cone
// genuinely walkable instead of hiding a vertical box inside it.
function addOlympusVolcanicMound(scene, world, x, z, w, d, height, seed) {
  world.ramps.push(
    { axis: 'x', minX: x - w * 0.46, maxX: x - w * 0.15, minZ: z - d * 0.15, maxZ: z + d * 0.15,
      h0: 0.04, h1: height, supportPad1: 0.18 },
    { axis: 'x', minX: x + w * 0.15, maxX: x + w * 0.46, minZ: z - d * 0.15, maxZ: z + d * 0.15,
      h0: height, h1: 0.04, supportPad0: 0.18 },
    { axis: 'z', minX: x - w * 0.125, maxX: x + w * 0.125, minZ: z - d * 0.46, maxZ: z - d * 0.15,
      h0: 0.04, h1: height, supportPad1: 0.18 },
    { axis: 'z', minX: x - w * 0.125, maxX: x + w * 0.125, minZ: z + d * 0.15, maxZ: z + d * 0.46,
      h0: height, h1: 0.04, supportPad0: 0.18 },
  );
  // The ramps are height fields, not volumetric solids. This core gives the
  // volcanic body real collision below its crown, preventing players and darts
  // from passing through the visible mound between the four climb lanes.
  world.colliders.push({
    type: 'box',
    min: V(x - w * 0.15, 0.02, z - d * 0.15),
    max: V(x + w * 0.15, height, z + d * 0.15),
  });
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
  addOlympusLavaMoat(scene, world);

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
  ]) addScragglyLava(scene, world, x, z, w, d, -0.72, seed);

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
  const emberMat = new THREE.MeshBasicMaterial({ color: 0xff9a3c });
  const emberRnd = seededRandom(0x48414445);
  for (let i = 0; i < 40; i++) {
    const ember = new THREE.Mesh(new THREE.SphereGeometry(0.07 + emberRnd() * 0.09, 5, 4), emberMat);
    const ex = -62 + emberRnd() * 124;
    const ez = -62 + emberRnd() * 124;
    const startY = 1 + emberRnd() * 54;
    const speed = 0.6 + emberRnd() * 1.1;
    const drift = emberRnd() * Math.PI * 2;
    scene.add(ember);
    world.anim.push((dt, t) => {
      const y = 1 + ((startY + t * speed) % 55);
      ember.position.set(ex + Math.sin(t * 0.7 + drift) * 0.55, y, ez + Math.cos(t * 0.5 + drift) * 0.35);
    });
  }

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
  for (const [x, y, z] of [[-22, 5, -10], [30, 23, -2], [-19, 45, 7]]) {
    const light = new THREE.PointLight(0xff8b3d, 13, 24);
    light.position.set(x, y, z);
    scene.add(light);
  }

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
  makeSign(scene, -26.08, 69.5, 0, 11, '#ffb14a', 'ARMORY', Math.PI / 2);
  makeSign(scene, 26.08, 69.5, 0, 11, '#72d8ff', 'STORM CHAPEL', -Math.PI / 2);
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
  makeSign(scene, 0, 97.5, 37.94, 13, '#8ee8ff', 'AETHER CROWN', 0);
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
  makeSign(scene, 0, 96.5, 79.94, 12, '#72d8ff', 'SPRING OF AETHER', Math.PI);

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

  flushOlympusColumns(scene, world);
  buildMeteorSurfaceIndex(world);
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
  { id: 'asteroids', name: 'ASTEROID BELT', emoji: '☄️',
    desc: 'Flat-topped rock plateaus around a derelict station: a cave, a canyon under-deck, balconies. Low gravity, long jumps, fatal void.',
    thumb: 'linear-gradient(135deg,#05060f,#334466)', build: buildAsteroids },
  { id: 'canopy', name: 'CANOPY', emoji: '🌲',
    desc: 'Giant forest: branch decks at three heights, treetop bridges, pad chains to a golden crown 30m up.',
    thumb: 'linear-gradient(135deg,#14291f,#5d9c46)', build: buildCanopy },
  { id: 'city', name: 'NEON HEIGHTS', emoji: '🌃',
    desc: 'A Miami-synthwave skyline with two working tower lifts, rooftop sniper routes, a close-range arcade and subway, skybridges, alleys, and a rideable monorail loop.',
    thumb: 'linear-gradient(135deg,#101032,#ff3ca6 48%,#32e7ff)', build: buildCity },
  { id: 'sanctum', name: 'THE LABYRINTH', emoji: '🔮',
    desc: 'A deliberately disorienting rune maze: four deceptively identical wings fold around a crypt lift, upper gallery, roof loops, and concealed shortcuts.',
    thumb: 'linear-gradient(135deg,#14101f,#8a5fff)', build: buildSanctum },
  { id: 'prism', name: 'PRISM RUN', emoji: '🌈', secret: true,
    desc: 'Inside a neon tesseract in deep space: walk every wall, floor and ceiling. Gravity always pulls to the nearest surface — you never fall out.',
    thumb: 'linear-gradient(135deg,#0b0518,#ff40e0)', build: buildPrism },
  { id: 'bloom', name: 'INFINITE BLOOM', emoji: '👁️', secret: true,
    desc: 'A sentient machine realm recursively contains itself. Fall or fire into the living miniature and emerge above the full-size arena at the same point.',
    thumb: 'linear-gradient(135deg,#101600,#b7ed1c 52%,#e43814)', build: buildInfiniteBloom },
  { id: 'olympus', name: 'OLYMPUS MONS', emoji: '🔴', secret: true,
    desc: 'A Greco-futurist cliff-temple on Mars: stepped golden palaces, Olympian statues, an ornate Aether Crown, connected roof arenas, a mountain-sized Hades cavern, and waterfall caves.',
    thumb: 'linear-gradient(135deg,#351a24,#c75b36)', build: buildOlympusMons },
];
