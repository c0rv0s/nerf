// Map construction. Each map returns a `world` object:
// { colliders, ramps, waypoints, spawns:{blue,red,ffa}, spawnsAll, pickups,
//   jumpPads, manualLinks, gravity, jumpVel, killY, playerSpeed,
//   waypointLinkDist, waypointLinkDy, update(dt) }
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rand } from './engine.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

function newWorld(opts) {
  return Object.assign({
    colliders: [], ramps: [], waypoints: [], pickups: [], jumpPads: [],
    manualLinks: [], anim: [], _geoGroups: {},
    spawns: { blue: [], red: [], ffa: [] },
    gravity: 25, jumpVel: 9.2, killY: -40, playerSpeed: 10,
    waypointLinkDist: 16, waypointLinkDy: 3.5,
    update(dt) {
      this._t = (this._t || 0) + dt;
      for (const a of this.anim) a(dt, this._t);
    },
  }, opts);
}

/* ---------------- procedural textures ---------------- */
const texCache = {};
function canvasTex(key, draw) {
  if (texCache[key]) return texCache[key];
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  draw(c.getContext('2d'));
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
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

const TEXES = { checker: texChecker, panel: texPanel, crate: texCrate, rock: texRock };

// ---- AI texture set (textures/*.jpg) — used when present, else canvas fallback ----
// A normal map is derived from each image's luminance so surfaces catch light.
const AI_TEX = {};
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
  ['checker', 'panel', 'crate', 'rock', 'suit', 'plastic', 'neonwall', 'neonfloor', 'arcade']
    .map((name) => new Promise((done) => {
      const url = `./textures/${name}.jpg`;
      fetch(url, { method: 'HEAD' }).then((r) => {
        if (!r.ok) return done();
        new THREE.TextureLoader().load(url, (t) => {
          // mirrored repeat hides any seams in not-quite-tileable AI images
          t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping;
          t.colorSpace = THREE.SRGBColorSpace;
          t.anisotropy = 8;
          const n = makeNormalMap(t.image);
          n.wrapS = n.wrapT = THREE.MirroredRepeatWrapping;
          AI_TEX[name] = { map: t, normal: n };
          done();
        }, undefined, () => done());
      }).catch(() => done());
    })));

function mat(color, opts = {}) {
  const { tex, repeat, emissive, ...rest } = opts;
  const params = { color, roughness: 0.85, metalness: 0.05, envMapIntensity: 0.35, ...rest };
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
      params.normalScale = new THREE.Vector2(0.8, 0.8);
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
  const { collide = true, shadow = true, ...matOpts } = opts;
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
    (world._geoGroups[matOpts.tex || 'plain'] ||= []).push(g);
    return null;
  }
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, matOpts));
  m.position.set(cx, cy, cz);
  if (shadow) { m.castShadow = true; m.receiveShadow = true; }
  scene.add(m);
  return m;
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
    const m = new THREE.Mesh(merged,
      mat(0xffffff, groupMat[key] ?? { tex: key, repeat: [1, 1], vertexColors: true }));
    m.castShadow = m.receiveShadow = true;
    scene.add(m);
    for (const g of geos) g.dispose();
  }
  world._geoGroups = {};
}

// Walkable slope. Rises along `axis` from h0 (at min end) to h1 (at max end).
function addRamp(scene, world, { axis, minX, maxX, minZ, maxZ, h0, h1, color }) {
  world.ramps.push({ axis, minX, maxX, minZ, maxZ, h0, h1 });
  const len = axis === 'x' ? maxX - minX : maxZ - minZ;
  const width = axis === 'x' ? maxZ - minZ : maxX - minX;
  const dh = h1 - h0;
  const slopeLen = Math.hypot(len, dh);
  const geo = new THREE.BoxGeometry(
    axis === 'x' ? slopeLen : width, 0.4, axis === 'x' ? width : slopeLen);
  const m = new THREE.Mesh(geo, mat(color, { tex: 'panel', repeat: [Math.max(1, slopeLen / 5), Math.max(1, width / 5)] }));
  m.position.set((minX + maxX) / 2, (h0 + h1) / 2 - 0.2, (minZ + maxZ) / 2);
  const ang = Math.atan2(dh, len);
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

function addWater(scene, world, x, y, z, w, d) {
  const layers = [];
  for (const [dy, opacity, scale] of [[0, 0.55, 8], [-0.12, 0.3, 13]]) {
    const n = waterNormalTex().clone();
    n.needsUpdate = true;
    n.repeat.set(w / scale, d / scale);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d),
      new THREE.MeshStandardMaterial({
        color: 0x11557f, transparent: true, opacity, roughness: 0.06, metalness: 0.1,
        normalMap: n, normalScale: new THREE.Vector2(0.9, 0.9),
        envMapIntensity: 1.6, emissive: 0x06283f, emissiveIntensity: 0.15,
        depthWrite: false,
      }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, y + dy, z);
    scene.add(mesh);
    layers.push(n);
  }
  world.anim.push((dt, t) => {
    layers[0].offset.set(t * 0.018, t * 0.03);
    layers[1].offset.set(-t * 0.026, t * 0.012);
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

function wp(world, x, y, z) { world.waypoints.push({ pos: V(x, y, z), links: [] }); }
function pk(world, kind, x, y, z, extra = {}) {
  world.pickups.push(Object.assign({ kind, pos: V(x, y, z) }, extra));
}

function baseLighting(scene, skyColor, groundColor, sunDir, shadowHalf) {
  // r155+ physical lighting divides diffuse by π — intensities compensate
  scene.add(new THREE.HemisphereLight(skyColor, groundColor, 3.4));
  scene.add(new THREE.AmbientLight(0xffffff, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 3.0);
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

/* ================= MAP 1 — BLAST COMPLEX (labyrinth, 154×114) =================
   West wing: two rooms (crate maze + mezzanine room with a second floor).
   Center: grand atrium — tall room, tiered tower, balcony, floating top platform.
   East wing: sunken basement lanes with a ground-level bridge crossing above. */
function buildArena(scene) {
  const world = newWorld({ killY: -20, waypointLinkDist: 22, waypointLinkDy: 4.6 });
  scene.background = new THREE.Color(0x10142a);
  scene.fog = new THREE.Fog(0x10142a, 140, 380);
  baseLighting(scene, 0x8899ff, 0x332211, [50, 110, 30], 110);

  // Floors: main level (west + atrium), sunken east basement (top −5)
  addBox(scene, world, -24.5, -0.5, 0, 109, 1, 122, 0x2e6da0, { tex: 'checker', repeat: [14, 15] });
  addBox(scene, world, 54.5, -5.5, 0, 49, 1, 122, 0x274f74, { tex: 'checker', repeat: [6, 15] });
  // retaining wall top sits 0.1 below floor level — flush tops z-fight
  addBox(scene, world, 29.6, -3.05, 0, 1.4, 5.9, 122, 0x8a5230, { tex: 'panel' });

  // Outer walls (drop below the basement floor)
  for (const [x, z, w, d] of [[0, -59, 162, 4], [0, 59, 162, 4], [-79, 0, 4, 122], [79, 0, 4, 122]]) {
    addBox(scene, world, x, 6, z, w, 24, d, 0xc8461e, { tex: 'panel' });
  }
  // Glow stripes + lights
  for (const [x, z, w, d] of [[0, -56.8, 150, 0.3], [0, 56.8, 150, 0.3], [-76.8, 0, 0.3, 112], [76.8, 0, 0.3, 112]]) {
    addBox(scene, world, x, 7, z, w, 0.9, d, 0xffd23c, { collide: false, shadow: false, emissive: 0xffd23c, emissiveIntensity: 1.2 });
  }
  // lamps sit 0.1 proud of the wall face — flush placement z-fights with the wall
  for (const [x, z] of [[-50, -57.9], [0, -57.9], [50, -57.9], [-50, 57.9], [0, 57.9], [50, 57.9]]) {
    addBox(scene, world, x, 15, z, 3, 1.2, 2, 0xffffff, { collide: false, shadow: false, emissive: 0xeef4ff, emissiveIntensity: 2.2 });
  }

  const wallC = 0x7a4fc0; // interior partition color

  // WEST DIVIDER (x −25): doors at z ±26, upper cutout at z 36..44 for the
  // mezzanine — and a low secret crawlway at z −49..−45 behind the maze crates
  addBox(scene, world, -25, 5, -37.5, 1.5, 10, 15, wallC, { tex: 'panel' });
  addBox(scene, world, -25, 5, -53, 1.5, 10, 8, wallC, { tex: 'panel' });
  addBox(scene, world, -25, 6.1, -47, 1.5, 7.8, 4, wallC, { tex: 'panel' });
  addBox(scene, world, -25, 5, 0, 1.5, 10, 44, wallC, { tex: 'panel' });
  addBox(scene, world, -25, 2.5, 43.5, 1.5, 5, 27, wallC, { tex: 'panel' });
  addBox(scene, world, -25, 7.5, 33, 1.5, 5, 6, wallC, { tex: 'panel' });
  addBox(scene, world, -25, 7.5, 50.5, 1.5, 5, 13, wallC, { tex: 'panel' });

  // EAST DIVIDER (x 30): doors at z ±26 and z 0 (bridge); the outer stretches
  // are built in the halls section below (they contain basement drop-doors)
  addBox(scene, world, 30, 5, -13, 1.5, 10, 18, wallC, { tex: 'panel' });
  addBox(scene, world, 30, 5, 13, 1.5, 10, 18, wallC, { tex: 'panel' });

  // WEST WING mid divider (z 0), door at x −54..−46
  addBox(scene, world, -65.5, 5, 0, 23, 10, 1.5, wallC, { tex: 'panel' });
  addBox(scene, world, -35.5, 5, 0, 21, 10, 1.5, wallC, { tex: 'panel' });

  // --- NW room: mezzanine (second floor) ---
  addBox(scene, world, -51.75, 4.7, 44.5, 50.5, 0.6, 25, 0x50b46e, { tex: 'panel' });
  addRamp(scene, world, { axis: 'z', minX: -77, maxX: -71, minZ: 6, maxZ: 32, h0: 0, h1: 5, color: 0x63cc82 });
  addBox(scene, world, -40, 1.25, 20, 2.5, 2.5, 2.5, 0xb0763a, { tex: 'crate' });
  addBox(scene, world, -37.5, 1.25, 20, 2.5, 2.5, 2.5, 0xb0763a, { tex: 'crate' });

  // --- SW room: crate maze ---
  const crate = (x, y, z, s = 2.4) => addBox(scene, world, x, y + s / 2, z, s, s, s, 0xb0763a, { tex: 'crate' });
  for (let x = -70; x <= -50; x += 2.4) crate(x, 0, -15);
  for (let x = -55; x <= -35; x += 2.4) crate(x, 0, -28);
  for (let x = -70; x <= -50; x += 2.4) crate(x, 0, -41);
  crate(-32, 0, -50); crate(-32, 0, -47.5); crate(-45, 0, -50);
  crate(-70, 0, -28); crate(-70, 2.4, -28); // double stack at the west end

  // --- HALLS: walls at z ±28 close the atrium into a room; the bands beyond
  // become enclosed, ceilinged corridors ---
  // north wall (upper opening at x −25..−19 lets the balcony pass through)
  addBox(scene, world, -18.5, 2.2, 28, 13, 4.4, 1.5, wallC, { tex: 'panel' });
  addBox(scene, world, -15.5, 6.2, 28, 7, 3.6, 1.5, wallC, { tex: 'panel' });
  addBox(scene, world, 4, 4, 28, 16, 8, 1.5, wallC, { tex: 'panel' });
  addBox(scene, world, 25, 4, 28, 10, 8, 1.5, wallC, { tex: 'panel' });
  // south wall
  addBox(scene, world, -18.5, 4, -28, 13, 8, 1.5, wallC, { tex: 'panel' });
  addBox(scene, world, 4, 4, -28, 16, 8, 1.5, wallC, { tex: 'panel' });
  addBox(scene, world, 25, 4, -28, 10, 8, 1.5, wallC, { tex: 'panel' });
  // hall ceilings — proper indoor corridors
  // ceilings overlap the wall tops by 0.02 (flush faces shimmer)
  addBox(scene, world, 2.5, 8.38, 42.5, 55, 0.8, 29, 0x3a3358, { tex: 'panel' });
  addBox(scene, world, 2.5, 8.38, -42.5, 55, 0.8, 29, 0x3a3358, { tex: 'panel' });
  for (const [lx, lz] of [[2, 42], [2, -42]]) { // one light per hall — point lights are pricey
    const hl = new THREE.PointLight(0x7fd0ff, 40, 34);
    hl.position.set(lx, 6, lz);
    scene.add(hl);
  }
  // hall → basement drop-doors in the east divider
  addBox(scene, world, 30, 5, -34, 1.5, 10, 8, wallC, { tex: 'panel' });
  addBox(scene, world, 30, 5, -51.5, 1.5, 10, 11, wallC, { tex: 'panel' });
  addBox(scene, world, 30, 5, 34, 1.5, 10, 8, wallC, { tex: 'panel' });
  addBox(scene, world, 30, 5, 51.5, 1.5, 10, 11, wallC, { tex: 'panel' });

  // --- ATRIUM: balcony along west edge (runs through the wall opening onto a
  // ledge above the north hall) ---
  addBox(scene, world, -21.6, 4.7, 10, 5.3, 0.6, 72, 0x50b46e, { tex: 'panel' });
  // east gallery (half-height ledge with a sheltered nook beneath)
  addBox(scene, world, 25, 2.7, 0, 10, 0.6, 40, 0x50b46e, { tex: 'panel' });
  addRamp(scene, world, { axis: 'z', minX: 22, maxX: 28, minZ: 20, maxZ: 27, h0: 3, h1: 0, color: 0x63cc82 });
  addRamp(scene, world, { axis: 'z', minX: 22, maxX: 28, minZ: -27, maxZ: -20, h0: 0, h1: 3, color: 0x63cc82 });
  // tiered tower
  addBox(scene, world, 2, 2, 0, 18, 4, 18, 0xd88a2b, { tex: 'panel' });
  addBox(scene, world, 2, 6.5, 0, 9, 5, 9, 0xb0632a, { tex: 'panel' });
  addBox(scene, world, 2, 14, -7, 14, 0.8, 14, 0x9a6fe0, { tex: 'panel' });  // floating top platform
  addBox(scene, world, 2, 14.53, -7, 14.4, 0.2, 14.4, 0xffd23c, { collide: false, shadow: false, emissive: 0xffa020, emissiveIntensity: 0.5 });
  addRamp(scene, world, { axis: 'x', minX: -16, maxX: -7, minZ: -4, maxZ: 4, h0: 0, h1: 4, color: 0xe8b04a });
  addRamp(scene, world, { axis: 'x', minX: 11, maxX: 20, minZ: -4, maxZ: 4, h0: 4, h1: 0, color: 0xe8b04a });
  // pads: floor→balcony ×2, base→mid, mid→top
  addJumpPad(scene, world, -12, 0, -20, 19, -8, -2);
  addJumpPad(scene, world, -12, 0, 20, 19, -8, 2);
  addJumpPad(scene, world, 2, 4, 7, 19, 0, -4.5, 0xffd23c);
  addJumpPad(scene, world, 2, 9, 3, 19, 0, -7, 0xffd23c);
  // atrium cover
  addBox(scene, world, 12, 4, -22, 4, 8, 4, wallC, { tex: 'panel' });
  addBox(scene, world, 12, 4, 22, 4, 8, 4, wallC, { tex: 'panel' });
  crate(22, 0, -48); crate(24.5, 0, -48); crate(22, 0, 48); crate(19.5, 0, 48);
  // NW room nook wall
  addBox(scene, world, -61, 2.5, 30, 14, 5, 1.5, wallC, { tex: 'panel' });

  // --- EAST WING: basement lanes + bridge + ledge ---
  addRamp(scene, world, { axis: 'x', minX: 30, maxX: 44, minZ: -30, maxZ: -22, h0: 0, h1: -5, color: 0x9a8050 });
  addRamp(scene, world, { axis: 'x', minX: 30, maxX: 44, minZ: 22, maxZ: 30, h0: 0, h1: -5, color: 0x9a8050 });
  addBox(scene, world, 50, -0.4, 0, 40, 0.8, 6, 0xc8461e, { tex: 'panel' });        // bridge (ends at the ledge — overlapping it z-fights)
  addBox(scene, world, 73.5, -0.4, 0, 7, 0.8, 28, 0x5a70b0, { tex: 'panel' });      // east ledge
  // basement lane walls (−5..0)
  addBox(scene, world, 44, -2.5, -14, 12, 5, 1.5, 0x8a5230, { tex: 'panel' });
  addBox(scene, world, 64, -2.5, -14, 12, 5, 1.5, 0x8a5230, { tex: 'panel' });
  addBox(scene, world, 48, -2.5, 14, 20, 5, 1.5, 0x8a5230, { tex: 'panel' });
  addBox(scene, world, 68, -2.5, 14, 4, 5, 1.5, 0x8a5230, { tex: 'panel' });
  crate(50, -5, -36); crate(50, -5, -33.5); crate(66, -5, 33);

  // Spawns
  for (const [x, z] of [[-70, 30], [-60, 15], [-70, -30], [-60, -15], [-35, 30]]) {
    world.spawns.blue.push(V(x, 0.1, z));
  }
  world.spawns.red.push(V(72, 0.1, 6), V(72, 0.1, -6), V(65, -4.9, 30), V(65, -4.9, -30), V(50, -4.9, 0));
  for (const [x, y, z] of [[25, 0.1, 45], [25, 0.1, -45], [-15, 0.1, 20], [-15, 0.1, -20],
                           [-21.5, 5.1, 20], [-60, 5.1, 45], [-55, 0.1, -33], [55, -4.9, 26]]) {
    world.spawns.ffa.push(V(x, y, z));
  }

  // Pickups
  pk(world, 'shield', -4, 4.2, 0);                       // atrium base tier
  pk(world, 'gold', 2, 15, -7);                          // floating top platform
  pk(world, 'silver', -62, 0.2, -28);                    // deep in the crate maze
  pk(world, 'weapon', 72, -4.8, -45, { weapon: 'zooka' });   // basement south corner
  pk(world, 'weapon', -21.5, 5.2, -24, { weapon: 'hyper' }); // balcony south end
  pk(world, 'weapon', -60, 5.2, 45, { weapon: 'pulsar' });   // mezzanine
  pk(world, 'weapon', 65, -4.8, 45, { weapon: 'pulsar' });   // basement north
  pk(world, 'weapon', -40, 0.2, -45, { weapon: 'scatter' }); // maze south
  pk(world, 'weapon', 20, 0.2, 50, { weapon: 'scatter' });   // north hall
  pk(world, 'weapon', 48, -4.8, 0, { weapon: 'whomper' });   // basement mid lane
  pk(world, 'weapon', -15, 0.2, -12, { weapon: 'sidewinder' });
  pk(world, 'ammo', 55, -4.8, 8, { weapon: 'whomper' });
  pk(world, 'ammo', -15, 0.2, -20, { weapon: 'sidewinder' });
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
  pk(world, 'star', 2, 9.4, -2, { hidden: true });       // mid tower, tucked under the overhang
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
    // basement
    [37, -2.5, -26], [37, -2.5, 26],
    [48, -5, -30], [64, -5, -30], [55, -5, -45], [72, -5, -45], [54, -5, -14],
    [48, -5, 0], [64, -5, 0], [62, -5, 14],
    [48, -5, 30], [64, -5, 30], [55, -5, 45], [72, -5, 45],
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
  );
  mergeStatic(scene, world);
  return world;
}

/* ============ MAP 2 — FORTRESS FALLS (150×90: trench, keep, towers) ============ */
function buildFortress(scene) {
  const world = newWorld({ killY: -20, waypointLinkDist: 22, waypointLinkDy: 4.6 });
  scene.background = new THREE.Color(0x87b5d8);
  scene.fog = new THREE.Fog(0x9cc3e0, 120, 420);
  baseLighting(scene, 0xbfdfff, 0x554433, [-70, 110, 50], 120);

  // Ground slabs split by trench (z −7..7, floor top −4)
  addBox(scene, world, 0, -0.5, 26, 154, 1, 38, 0xa8905e, { tex: 'checker', repeat: [20, 5] });
  addBox(scene, world, 0, -0.5, -26, 154, 1, 38, 0xa8905e, { tex: 'checker', repeat: [20, 5] });
  addBox(scene, world, 0, -4.5, 0, 154, 1, 14, 0x3f8f8f, { tex: 'panel', repeat: [20, 2] });
  // Trench side walls (full length — otherwise you can slip under the ground
  // slabs at the trench ends and fall out of the world)
  addBox(scene, world, 0, -2.05, 7.5, 146, 3.9, 1, 0x8a7248);   // tops 0.1 below ground level
  addBox(scene, world, 0, -2.05, -7.5, 146, 3.9, 1, 0x8a7248);

  // Perimeter walls (extend below ground level)
  for (const [x, z, w, d] of [[0, -47, 162, 4], [0, 47, 162, 4], [-79, 0, 4, 98], [79, 0, 4, 98]]) {
    addBox(scene, world, x, 2.5, z, w, 14, d, 0x6e5a8c, { tex: 'panel' });
  }

  // Trench end ramps — run all the way to the end walls so there's no
  // 4-deep dead pocket you can drop into and never climb out of
  addRamp(scene, world, { axis: 'x', minX: -73, maxX: -55, minZ: -8, maxZ: 8, h0: 0, h1: -4, color: 0x9a8050 });
  addRamp(scene, world, { axis: 'x', minX: 55, maxX: 73, minZ: -8, maxZ: 8, h0: -4, h1: 0, color: 0x9a8050 });
  // solid fill between each ramp top and the perimeter wall — this used to be
  // a 4-deep pit you could fall into and only escape by crawling under the ramp
  addBox(scene, world, -75, -2.5, 0, 4, 5, 14, 0x9a8050, { tex: 'panel' });
  addBox(scene, world, 75, -2.5, 0, 4, 5, 14, 0x9a8050, { tex: 'panel' });

  // Canal water — open to the sky mid-map; covered only near the end ramps
  addWater(scene, world, 0, -3.15, 0, 146, 12.6);
  addBox(scene, world, -49, 1.2, 0, 12, 0.8, 14, 0x8a7248, { tex: 'panel' }); // covers to the end ramps
  addBox(scene, world, 49, 1.2, 0, 12, 0.8, 14, 0x8a7248, { tex: 'panel' });
  // raised bunker roofs over the end ramps (tall enough inside for the ramp
  // exit; walk out the sides) + ramplets so the roof-walkway runs end to end
  addBox(scene, world, -64, 2.8, 0, 18, 0.8, 14, 0x8a7248, { tex: 'panel' });
  addBox(scene, world, 64, 2.8, 0, 18, 0.8, 14, 0x8a7248, { tex: 'panel' });
  addRamp(scene, world, { axis: 'x', minX: -55, maxX: -51, minZ: -7, maxZ: 7, h0: 3.2, h1: 1.6, color: 0x9a8050 });
  addRamp(scene, world, { axis: 'x', minX: 51, maxX: 55, minZ: -7, maxZ: 7, h0: 1.6, h1: 3.2, color: 0x9a8050 });
  // full-height collars where hump meets cover — no slit, nothing gets underneath
  addBox(scene, world, -56.5, 2.2, 0, 3, 2, 14, 0x8a7248, { tex: 'panel' });
  addBox(scene, world, 56.5, 2.2, 0, 3, 2, 14, 0x8a7248, { tex: 'panel' });

  // Bridges: grand center bridge + two side bridges
  // decks sit 2cm below bank level — flush tops z-fight where they overlap
  addBox(scene, world, 0, -0.42, 0, 9, 0.8, 20, 0xc8461e, { tex: 'panel' });
  addBox(scene, world, -4.2, 0.7, 0, 0.6, 1.4, 20, 0xffd23c, { emissive: 0xffd23c, emissiveIntensity: 0.35 });
  addBox(scene, world, 4.2, 0.7, 0, 0.6, 1.4, 20, 0xffd23c, { emissive: 0xffd23c, emissiveIntensity: 0.35 });
  addBox(scene, world, -40, -0.42, 0, 6, 0.8, 18, 0x8a7248);
  addBox(scene, world, 40, -0.42, 0, 6, 0.8, 18, 0x8a7248);
  // Gatehouse towers flanking the center bridge (decor + cover)
  addBox(scene, world, -9, 5, 0, 6, 10, 6, 0x7a4fc0, { tex: 'panel' });
  addBox(scene, world, 9, 5, 0, 6, 10, 6, 0x7a4fc0, { tex: 'panel' });
  addBox(scene, world, 0, 10.8, 0, 24, 1.6, 6, 0x9a6fe0);   // arch overhead

  // THE KEEP (north-center): interior room w/ gold, walkable roof
  addBox(scene, world, 0, 3.5, 37, 22, 7, 2, 0x8a5fd0, { tex: 'panel' });   // north wall
  addBox(scene, world, -7.5, 3.5, 15, 7, 7, 2, 0x8a5fd0, { tex: 'panel' }); // south wall w/ door gap
  addBox(scene, world, 7.5, 3.5, 15, 7, 7, 2, 0x8a5fd0, { tex: 'panel' });
  addBox(scene, world, -11, 3.5, 26, 2, 7, 24, 0x8a5fd0, { tex: 'panel' });
  addBox(scene, world, 11, 3.5, 26, 2, 7, 24, 0x8a5fd0, { tex: 'panel' });
  addBox(scene, world, 0, 7.4, 26, 24, 0.8, 26, 0x6e4aa8, { tex: 'panel' }); // roof, top 7.8
  const keepLight = new THREE.PointLight(0xffd23c, 40, 24);
  keepLight.position.set(0, 5, 26);
  scene.add(keepLight);
  // Roof ramp (east side)
  addRamp(scene, world, { axis: 'x', minX: 12, maxX: 32, minZ: 24, maxZ: 30, h0: 7.8, h1: 0, color: 0x8a5fd0 });

  // Climbable corner towers (NE + SW), decor towers (NW + SE)
  addBox(scene, world, 64, 3.5, 38, 9, 7, 9, 0x7a4fc0, { tex: 'panel' });
  addBox(scene, world, 64, 7.3, 38, 10, 0.6, 10, 0x9a6fe0);
  addRamp(scene, world, { axis: 'x', minX: 46, maxX: 59.5, minZ: 35, maxZ: 41, h0: 0, h1: 7.6, color: 0x8a5fd0 });
  addBox(scene, world, -64, 3.5, -38, 9, 7, 9, 0x7a4fc0, { tex: 'panel' });
  addBox(scene, world, -64, 7.3, -38, 10, 0.6, 10, 0x9a6fe0);
  addRamp(scene, world, { axis: 'x', minX: -59.5, maxX: -46, minZ: -41, maxZ: -35, h0: 7.6, h1: 0, color: 0x8a5fd0 });
  addBox(scene, world, -64, 4, 38, 7, 8, 7, 0x5a4a78);
  addBox(scene, world, 64, 4, -38, 7, 8, 7, 0x5a4a78);

  // Lane walls: split each field into corridors (doors at x ±36 and beside the keep)
  for (const zs of [1, -1]) {
    addBox(scene, world, -51, 3, 22 * zs, 22, 6, 1.5, 0x8a7248, { tex: 'panel' });
    addBox(scene, world, -24, 3, 22 * zs, 16, 6, 1.5, 0x8a7248, { tex: 'panel' });
    addBox(scene, world, 24, 3, 22 * zs, 16, 6, 1.5, 0x8a7248, { tex: 'panel' });
    addBox(scene, world, 51, 3, 22 * zs, 22, 6, 1.5, 0x8a7248, { tex: 'panel' });
  }

  // Battlement walkways along the north/south perimeter walls (top y=5)
  addBox(scene, world, -7.5, 4.7, 43.5, 125, 0.6, 3.5, 0x9a6fe0, { tex: 'panel' });  // north (x −70..55)
  addBox(scene, world, 7.5, 4.7, -43.5, 125, 0.6, 3.5, 0x9a6fe0, { tex: 'panel' });  // south (x −55..70)
  addRamp(scene, world, { axis: 'z', minX: -40, maxX: -34, minZ: 30, maxZ: 41.75, h0: 0, h1: 5, color: 0x8a5fd0 });
  addRamp(scene, world, { axis: 'z', minX: 30, maxX: 36, minZ: 30, maxZ: 41.75, h0: 0, h1: 5, color: 0x8a5fd0 });
  addRamp(scene, world, { axis: 'z', minX: -36, maxX: -30, minZ: -41.75, maxZ: -30, h0: 5, h1: 0, color: 0x8a5fd0 });
  addRamp(scene, world, { axis: 'z', minX: 40, maxX: 46, minZ: -41.75, maxZ: -30, h0: 5, h1: 0, color: 0x8a5fd0 });

  // Sky catwalk (north-south): keep roof → under the gatehouse arch → across
  // the trench → ramp down onto the south battlement. Top y=7.8, flush with
  // the keep roof (edge abut at z=13 — no overlap, no z-fight).
  addBox(scene, world, 0, 7.4, -12.5, 4, 0.8, 51, 0x9a6fe0, { tex: 'panel' });
  addBox(scene, world, -1.85, 8.3, -12.5, 0.3, 1.0, 51, 0xffd23c);          // rails
  addBox(scene, world, 1.85, 8.3, -12.5, 0.3, 1.0, 51, 0xffd23c);
  addRamp(scene, world, { axis: 'z', minX: -2, maxX: 2, minZ: -41.75, maxZ: -38, h0: 5.0, h1: 7.8, color: 0x8a5fd0 });
  // Sniper perch two levels up (top y=12.6), reached by a half-width ramp on
  // the catwalk's east lane; the west lane stays walkable underneath it.
  addRamp(scene, world, { axis: 'z', minX: 0, maxX: 2, minZ: -30, maxZ: -19, h0: 7.8, h1: 12.6, color: 0x8a5fd0 });
  addBox(scene, world, 0, 3.25, -15.5, 3.6, 7.5, 5, 0x7a4fc0, { tex: 'panel' }); // ground column to catwalk underside
  addBox(scene, world, 1.6, 9.8, -18.6, 0.5, 4, 0.5, 0x7a4fc0);               // slim posts catwalk → perch
  addBox(scene, world, 1.6, 9.8, -12.6, 0.5, 4, 0.5, 0x7a4fc0);
  addBox(scene, world, 0, 12.2, -15.5, 6, 0.8, 7, 0x9a6fe0, { tex: 'panel' }); // perch deck
  addBox(scene, world, 0, 13.05, -12.35, 6, 0.9, 0.3, 0xffd23c);              // perch rails (gap at ramp)
  addBox(scene, world, 2.85, 13.05, -15.5, 0.3, 0.9, 6.4, 0xffd23c);
  addBox(scene, world, -2.85, 13.05, -15.5, 0.3, 0.9, 6.4, 0xffd23c);
  addBox(scene, world, -1.5, 13.05, -18.8, 3, 0.9, 0.3, 0xffd23c);
  // Sky catwalk (east-west): keep roof → NE tower top (0.15 step down onto the cap)
  addBox(scene, world, 35.75, 7.35, 32, 47.5, 0.8, 4, 0x9a6fe0, { tex: 'panel' });
  addBox(scene, world, 24, 3.2, 32, 2.5, 7.4, 2.5, 0x7a4fc0, { tex: 'panel' }); // support columns
  addBox(scene, world, 50, 3.2, 32, 2.5, 7.4, 2.5, 0x7a4fc0, { tex: 'panel' });

  // Arcade walls just inside the battlements: the walkway above becomes the
  // roof of a covered perimeter corridor (gaps = doorways; also gaps at ramps)
  for (const [c, len] of [[-62.5, 15], [-43.5, 7], [-27, 14], [1.5, 27], [26.5, 7], [40.5, 9], [54, 2]]) {
    addBox(scene, world, c, 2.2, 41.5, len, 4.4, 1.2, 0x8a7248, { tex: 'panel' });
  }
  for (const [c, len] of [[-52.5, 5], [-39, 6], [-25, 10], [1.5, 27], [31.5, 17], [48, 4], [64, 12]]) {
    addBox(scene, world, c, 2.2, -41.5, len, 4.4, 1.2, 0x8a7248, { tex: 'panel' });
  }

  // Cross walls split each courtyard into rooms (center gaps as doorways)
  for (const [x, zs] of [[-45, 1], [45, 1], [-45, -1], [45, -1]]) {
    addBox(scene, world, x, 3, 25.5 * zs, 1.5, 6, 5, 0x8a7248, { tex: 'panel' });
    addBox(scene, world, x, 3, 36.5 * zs, 1.5, 6, 5, 0x8a7248, { tex: 'panel' });
  }

  // Cover
  const crate = (x, z, s = 2.4) => addBox(scene, world, x, s / 2, z, s, s, s, 0xb0763a, { tex: 'crate' });
  crate(-24, 30); crate(-21.5, 30); crate(-24, 32.5); crate(-24, 30 - 0); // cluster NW of bridge
  crate(24, -30); crate(21.5, -30); crate(24, -32.5);
  crate(-52, -28); crate(52, 28); crate(-14, -20); crate(14, 20);
  crate(-40, 16); crate(40, -16); crate(68, 10); crate(-68, -10);
  addBox(scene, world, -28, 1, -12, 14, 2, 1.5, 0x8a7248);
  addBox(scene, world, 28, 1, 12, 14, 2, 1.5, 0x8a7248);

  // Spawns
  for (const dz of [-30, -20, 14, 24, 34]) {
    world.spawns.blue.push(V(-72, 0.1, dz));
    world.spawns.red.push(V(72, 0.1, dz));
  }
  for (const [x, z] of [[-60, 30], [60, -30], [-60, -30], [60, 30], [0, -40], [0, 42], [-30, -40], [30, 40]]) {
    world.spawns.ffa.push(V(x, 0.1, z));
  }

  // Pickups
  pk(world, 'weapon', 64, 8, 38, { weapon: 'hyper' });        // NE tower
  pk(world, 'weapon', -64, 8, -38, { weapon: 'pulsar' });     // SW tower
  pk(world, 'weapon', 0, 8.2, 30, { weapon: 'hyper' });       // keep roof
  pk(world, 'weapon', 40, -3.8, 0, { weapon: 'zooka' });      // east trench
  pk(world, 'weapon', -48, 0.2, -30, { weapon: 'scatter' });
  pk(world, 'weapon', 48, 0.2, 30, { weapon: 'scatter' });
  pk(world, 'weapon', 4, 0.2, 26, { weapon: 'sidewinder' }); // keep interior, beside the gold
  pk(world, 'weapon', -40, 5.4, 43.5, { weapon: 'whomper' }); // north battlement
  pk(world, 'ammo', -4, 0.2, 26, { weapon: 'sidewinder' });
  pk(world, 'ammo', -48, 5.4, 43.5, { weapon: 'whomper' });
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
  pk(world, 'gold', 0, 0.2, 26);                       // inside the keep
  pk(world, 'silver', 0, -3.8, 4);                     // under the center bridge
  pk(world, 'star', 8, 8.2, 36, { hidden: true });     // keep roof corner
  pk(world, 'star', 71, -0.2, 0, { hidden: true });    // top of the east canal ramp
  pk(world, 'star', -24, 2.6, 31, { hidden: true });   // atop crate cluster
  pk(world, 'star', -68, 0.2, -13, { hidden: true });  // behind SW perimeter crate
  pk(world, 'star', -68, 5.4, 43.5, { hidden: true }); // north battlement dead end
  pk(world, 'health', 30, 5.4, 43.5);
  pk(world, 'ammo', 0, 5.4, -43.5, { weapon: 'scatter' });
  pk(world, 'star', 0, 13, -17, { hidden: true });      // sniper perch
  pk(world, 'ammo', 0, 13, -14, { weapon: 'hyper' });

  // Waypoints
  const wps = [
    // south field
    [-72, 0, -26], [-50, 0, -26], [-30, 0, -30], [-10, 0, -26], [10, 0, -26], [30, 0, -30], [50, 0, -26], [72, 0, -26],
    [-60, 0, -12], [-40, 0, -12], [-20, 0, -12], [0, 0, -12], [20, 0, -12], [40, 0, -12], [60, 0, -12],
    // north field
    [-72, 0, 26], [-50, 0, 26], [-30, 0, 24], [30, 0, 24], [50, 0, 26], [72, 0, 26],
    [-60, 0, 12], [-40, 0, 12], [-20, 0, 12], [20, 0, 12], [40, 0, 12], [60, 0, 12],
    [-24, 0, 40], [24, 0, 40], [-45, 0, 40], [45, 0, 40], [0, 0, 42],
    // bridges
    [0, 0, 0], [-40, 0, 0], [40, 0, 0],
    // trench
    [-71, -0.5, 0], [-61, -2.5, 0], [-50, -4, 0], [-28, -4, 0], [-12, -4, 0],
    [0, -4, 0], [12, -4, 0], [28, -4, 0], [50, -4, 0], [61, -2.5, 0], [71, -0.5, 0],
    // keep: door, interior, roof + ramp
    [0, 0, 11], [0, 0, 26], [9, 7.8, 27], [-5, 7.8, 26], [22, 3.9, 27], [34, 0, 27],
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
  // boulder keel below (decor only)
  const r = Math.min(w, d) * 0.5;
  const keel = new THREE.IcosahedronGeometry(r, 1);
  keel.scale(1, 0.85, 1);
  keel.rotateX(rand(0, 3)); keel.rotateY(rand(0, 3)); keel.rotateZ(rand(0, 3));
  keel.translate(x + rand(-1, 1), y - thick - r * 0.5, z + rand(-1, 1));
  bake(keel, 2);
}

function buildAsteroids(scene) {
  const world = newWorld({
    gravity: 5, jumpVel: 8.4, killY: -60, playerSpeed: 12,  // match the bots' hop range
    waypointLinkDist: 45, waypointLinkDy: 16,
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
                           [-44, 13.4, -46], [44, 0.4, 46], [52, 8.4, -38], [-52, -5.6, 38]]) {
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
  pk(world, 'ammo', 13, -7.8, 72, { weapon: 'whomper' });
  pk(world, 'ammo', -40, 13.2, -46, { weapon: 'sidewinder' });
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
  scene.background = new THREE.Color(0x14291f);
  scene.fog = new THREE.Fog(0x14291f, 110, 320);
  baseLighting(scene, 0xa8d8a0, 0x1c3020, [60, 120, -40], 130);

  // Mossy ground + hedge walls
  addBox(scene, world, 0, -0.5, 0, 164, 1, 164, 0x5d9c46, { tex: 'rock', repeat: [16, 16] });
  for (const [x, z, w, d] of [[0, -83, 172, 6], [0, 83, 172, 6], [-83, 0, 6, 172], [83, 0, 6, 172]]) {
    addBox(scene, world, x, 14, z, w, 40, d, 0x2e4d2a, { tex: 'rock' });
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
  addRamp(scene, world, { axis: 'x', minX: 0, maxX: 6.5, minZ: -6.5, maxZ: -3.5, h0: 4, h1: 8, color: 0x8a6a40 });
  const roomLight = new THREE.PointLight(0xffb060, 25, 18);
  roomLight.position.set(0, 5, 0);
  scene.add(roomLight);
  addBox(scene, world, 0, 18.5, 0, 5, 21, 5, 0x5e3f26, { tex: 'crate', repeat: [2, 6] });

  // hedge lanes — break up the open lawn into corridors
  for (const [hx, hz, hw, hd] of [[-15, 60, 50, 2], [15, -60, 50, 2], [60, 15, 2, 50], [-60, -15, 2, 50],
                                  [-30, 14, 2, 26], [30, -14, 2, 26]]) {
    addBox(scene, world, hx, 1.75, hz, hw, 3.5, hd, 0x3a6b30, { tex: 'rock' });
  }

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

  // Edge bridges: west/east at 20, north/south at 10 (2cm below deck tops)
  addBox(scene, world, -45, 19.48, 0, 3, 1, 78, 0x7a5c38, { tex: 'crate', repeat: [1, 10] });
  addBox(scene, world, 45, 19.48, 0, 3, 1, 78, 0x7a5c38, { tex: 'crate', repeat: [1, 10] });
  addBox(scene, world, 0, 9.48, -45, 78, 1, 3, 0x7a5c38, { tex: 'crate', repeat: [10, 1] });
  addBox(scene, world, 0, 9.48, 45, 78, 1, 3, 0x7a5c38, { tex: 'crate', repeat: [10, 1] });

  // Ramps: ground ↔ center deck 8; bridges ↔ center 16 / center 8
  addRamp(scene, world, { axis: 'x', minX: 12, maxX: 42, minZ: -2, maxZ: 2, h0: 8, h1: 0, color: 0x8a6a40 });
  addRamp(scene, world, { axis: 'x', minX: -42, maxX: -12, minZ: -2, maxZ: 2, h0: 0, h1: 8, color: 0x8a6a40 });
  addRamp(scene, world, { axis: 'x', minX: -39, maxX: -9, minZ: -2, maxZ: 2, h0: 20, h1: 16, color: 0x8a6a40 });
  addRamp(scene, world, { axis: 'x', minX: 9, maxX: 39, minZ: -2, maxZ: 2, h0: 16, h1: 20, color: 0x8a6a40 });
  addRamp(scene, world, { axis: 'z', minX: -2, maxX: 2, minZ: -39, maxZ: -12, h0: 10, h1: 8, color: 0x8a6a40 });
  addRamp(scene, world, { axis: 'z', minX: -2, maxX: 2, minZ: 12, maxZ: 39, h0: 8, h1: 10, color: 0x8a6a40 });

  // Pads: ground → corner decks, center tier chain up to the crown
  addJumpPad(scene, world, -30, 0, -30, 24, -11.5, -11.5, 0x9dff70);
  addJumpPad(scene, world, 30, 0, -30, 24, 11.5, -11.5, 0x9dff70);
  addJumpPad(scene, world, -30, 0, 30, 24, -11.5, 11.5, 0x9dff70);
  addJumpPad(scene, world, 30, 0, 30, 24, 11.5, 11.5, 0x9dff70);
  addJumpPad(scene, world, 9, 8, 0, 22, -2, 0, 0xffd23c);     // 8 → 16
  addJumpPad(scene, world, 7, 16, 0, 22, -8, 0, 0xffd23c);    // 16 → 24 (offset west)
  addJumpPad(scene, world, -6, 24, 0, 20, 8.3, 0, 0xffd23c);  // 24 → crown (offset east)

  // Canopy blobs + bushes (visual only)
  const deco = { colliders: [], ramps: [] };
  for (const [x, y, z, r] of [[-45, 33, -45, 13], [45, 33, -45, 13], [-45, 33, 45, 13], [45, 33, 45, 13], [0, 39, 0, 16],
                              [-20, 1, -60, 3], [60, 1, 20, 3], [-60, 1, 10, 2.5], [25, 1, 60, 3]]) {
    const blob = addAsteroid(scene, deco, x, y, z, r, 0x3f7a33);
    blob.material.map = null;
  }

  // Spawns
  for (const dz of [-25, -12, 0, 12, 25]) world.spawns.blue.push(V(-62, 0.1, dz));
  for (const dz of [-25, -12, 0, 12, 25]) world.spawns.red.push(V(62, 0.1, dz));
  for (const [x, y, z] of [[-40, 10.2, -40], [40, 10.2, 40], [0, 8.2, -7], [0, 0.1, -62], [0, 0.1, 62],
                           [-40, 20.2, 40], [40, 20.2, -40], [-30, 0.1, 0]]) {
    world.spawns.ffa.push(V(x, y, z));
  }

  // Pickups
  pk(world, 'shield', 40, 10.4, 40);                     // NE 10-deck
  pk(world, 'gold', 4, 30.2, 0);                          // the crown
  pk(world, 'silver', 0, 0.2, 0);                         // hidden in the tree-base room
  pk(world, 'health', 0, 16.2, 4);
  pk(world, 'weapon', 40, 20.2, 39, { weapon: 'whomper' });
  pk(world, 'weapon', 0, 0.2, -20, { weapon: 'sidewinder' });
  pk(world, 'weapon', -40, 20.2, -39, { weapon: 'hyper' });
  pk(world, 'weapon', 30, 0.2, 24, { weapon: 'zooka' });
  pk(world, 'weapon', -25, 0.2, 25, { weapon: 'scatter' });
  pk(world, 'weapon', 25, 0.2, -25, { weapon: 'pulsar' });
  pk(world, 'ammo', 39, 20.2, 44, { weapon: 'whomper' });
  pk(world, 'ammo', 0, 0.2, -26, { weapon: 'sidewinder' });
  pk(world, 'ammo', -39, 20.2, -44, { weapon: 'hyper' });
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

  // Waypoints: auto grid on the ground, hand-placed for the canopy levels
  const blocked = (x, z) => {
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
    // center tree-base room + interior stairs
    [0, 0, 2], [0, 0, 12], [-4.5, 2, 0], [-1.5, 4, -5], [3, 6, -5],
    // SW hollow tree: door, shaft, ledge, attic, top exit
    [-45, 0, -38], [-45, 0, -45], [-45, 10, -47.4], [-45, 20, -44.5], [-45, 20, -40],
    // center tiers (+ pad spots)
    [0, 8, -7], [0, 8, 7], [-7, 8, 0], [9, 8, 0],
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
    [9, 8, 0, 7, 16, 0, true],        // pad chain up the center tree
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
function buildCity(scene) {
  const world = newWorld({ killY: -20, waypointLinkDist: 24, waypointLinkDy: 4.6 });
  scene.background = new THREE.Color(0x0b1026);
  scene.fog = new THREE.Fog(0x0b1026, 120, 380);
  baseLighting(scene, 0x7788cc, 0x101018, [-60, 110, 40], 130);

  // Street (split into bands leaving two subway stair openings)
  addBox(scene, world, 0, -0.5, -39.5, 174, 1, 55, 0x3a3f4a, { tex: 'neonfloor', repeat: [20, 7] });
  addBox(scene, world, -60.5, -0.5, -7, 53, 1, 10, 0x3a3f4a, { tex: 'neonfloor', repeat: [7, 2] });
  addBox(scene, world, 30.5, -0.5, -7, 113, 1, 10, 0x3a3f4a, { tex: 'neonfloor', repeat: [14, 2] });
  addBox(scene, world, 0, -0.5, 0, 174, 1, 4, 0x3a3f4a, { tex: 'neonfloor', repeat: [20, 1] });
  addBox(scene, world, -29.5, -0.5, 7, 115, 1, 10, 0x3a3f4a, { tex: 'neonfloor', repeat: [14, 2] });
  addBox(scene, world, 61.5, -0.5, 7, 51, 1, 10, 0x3a3f4a, { tex: 'neonfloor', repeat: [7, 2] });
  addBox(scene, world, 0, -0.5, 39.5, 174, 1, 55, 0x3a3f4a, { tex: 'neonfloor', repeat: [20, 7] });

  // SUBWAY: stairs at (-30,-7) and (32,7) down into an L-shaped tunnel
  addRamp(scene, world, { axis: 'z', minX: -34, maxX: -26, minZ: -12, maxZ: -2, h0: -6, h1: 0, color: 0x2f3542 });
  addRamp(scene, world, { axis: 'z', minX: 28, maxX: 36, minZ: 2, maxZ: 12, h0: 0, h1: -6, color: 0x2f3542 });
  addBox(scene, world, 1, -6.5, -7, 70, 1, 10, 0x2f3542, { tex: 'panel', repeat: [9, 2] });   // tunnel floor E-W
  addBox(scene, world, 1, -3.5, -12.5, 70, 5, 1, 0x262b38, { tex: 'panel' });                 // tunnel walls
  addBox(scene, world, -3, -3.5, -1.5, 62, 5, 1, 0x262b38, { tex: 'panel' });
  addBox(scene, world, 32, -6.5, 5, 8, 1, 14, 0x2f3542, { tex: 'panel', repeat: [1, 2] });    // connector leg
  addBox(scene, world, 27.5, -3.5, 5, 1, 5, 14, 0x262b38, { tex: 'panel' });
  addBox(scene, world, 36.5, -3.5, 5, 1, 5, 14, 0x262b38, { tex: 'panel' });
  addBox(scene, world, 32, -3.5, 12.5, 10, 5, 1, 0x262b38, { tex: 'panel' });
  const tubeLight = new THREE.PointLight(0xffe040, 30, 34);
  tubeLight.position.set(0, -3, -7);
  scene.add(tubeLight);
  for (const [x, z, w, d] of [[0, -67, 182, 6], [0, 67, 182, 6], [-88, 0, 6, 140], [88, 0, 6, 140]]) {
    addBox(scene, world, x, 14, z, w, 40, d, 0x1d2433, { tex: 'neonwall' });
  }

  // Buildings [x, z, size, height, color] — roofs are the playground.
  // (The two −12 towers are hollow now — built below as interiors.)
  const buildings = [
    [-58, -35, 26, 12, 0x51607a],
    [32, -35, 26, 28, 0x44586e], [62, -32, 18, 16, 0x60566e],
    [-58, 33, 22, 24, 0x4c5a6a],
    [32, 34, 22, 18, 0x5c4f62], [64, 30, 16, 10, 0x596478],
  ];
  for (const [bx, bz, s, h, c] of buildings) {
    addBox(scene, world, bx, h / 2, bz, s, h, s, c, { tex: 'neonwall', repeat: [Math.round(s / 4), Math.round(h / 4)] });
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
  addRamp(scene, world, { axis: 'x', minX: -18, maxX: -2, minZ: 45, maxZ: 48.5, h0: 8, h1: 16, color: galIn });
  addBox(scene, world, -2.75, 15.6, 36, 6.5, 0.8, 25, galIn, { tex: 'arcade', repeat: [2, 6] });
  // bare catwalks across the void at 16 — the z=30 one ends at the window
  addBox(scene, world, -15.25, 15.6, 30, 18.5, 0.8, 2.5, 0x8a80a8, { tex: 'arcade', repeat: [5, 1] });
  addBox(scene, world, -15.25, 15.6, 42, 18.5, 0.8, 2.5, 0x8a80a8, { tex: 'arcade', repeat: [5, 1] });
  // third ramp stacked over the first: gallery (16) → chamber (24)
  addRamp(scene, world, { axis: 'x', minX: -18, maxX: -6, minZ: 23.5, maxZ: 27, h0: 24, h1: 16, color: galIn });
  // L-shaped top chamber at 24 (west strip + southwest wing) with rails
  addBox(scene, world, -21.25, 23.6, 36, 6.5, 0.8, 25, galIn, { tex: 'arcade', repeat: [2, 6] });
  addBox(scene, world, -14, 23.6, 26.75, 8, 0.8, 6.5, galIn, { tex: 'arcade', repeat: [2, 2] });
  addBox(scene, world, -18.35, 24.45, 37.75, 0.3, 0.9, 21.5, 0xffd23c);
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

  // Spawns
  for (const dz of [-56, -20, 0, 20, 56]) world.spawns.blue.push(V(-76, 0.1, dz));
  for (const dz of [-56, -20, 0, 20, 56]) world.spawns.red.push(V(78, 0.1, dz));
  for (const [x, y, z] of [[-58, 12.2, -35], [32, 18.2, 34], [64, 10.2, 30], [0, 0.1, -56],
                           [0, 0.1, 56], [-40, 0.1, 0], [40, 0.1, 0], [-12, 20.2, -38]]) {
    world.spawns.ffa.push(V(x, y, z));
  }

  // Pickups
  pk(world, 'shield', -12, 20.2, -32);                   // A2 rooftop
  pk(world, 'gold', -12, 34.2, 36);                        // tallest roof
  pk(world, 'silver', 32, 28.2, -35);
  pk(world, 'weapon', 0, -5.8, -7, { weapon: 'whomper' }); // deep in the subway
  pk(world, 'weapon', -58, 24.2, 33, { weapon: 'sidewinder' });
  pk(world, 'weapon', -12, 20.2, -38, { weapon: 'hyper' });
  pk(world, 'weapon', 40, 0.2, 0, { weapon: 'zooka' });
  pk(world, 'weapon', -40, 0.2, 10, { weapon: 'scatter' });
  pk(world, 'weapon', 32, 18.2, 30, { weapon: 'pulsar' });
  pk(world, 'ammo', 26, -5.8, -7, { weapon: 'whomper' });
  pk(world, 'ammo', -54, 24.2, 37, { weapon: 'sidewinder' });
  pk(world, 'ammo', -8, 20.2, -34, { weapon: 'hyper' });
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
  pk(world, 'ammo', -21, 8.2, 40, { weapon: 'pulsar' });   // galleria mezzanine
  pk(world, 'ammo', -21, 24.2, 42, { weapon: 'whomper' }); // galleria top chamber
  pk(world, 'star', -22, 16.2, 30, { hidden: true });      // galleria window catwalk
  pk(world, 'health', -18, 0.2, -44);                      // arcade west room
  pk(world, 'ammo', -6, 6.7, -32, { weapon: 'scatter' });  // arcade floor 2
  pk(world, 'star', -21, 6.7, -29, { hidden: true });      // arcade floor-2 corner
  pk(world, 'ammo', -66, 0.2, -55, { weapon: 'sidewinder' }); // back alley

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
    // galleria: doorways, hall, ramps, mezzanine, gallery, catwalks, chamber
    [-18, 0, 24], [-6, 0, 24], [-12, 0, 47], [-1, 0, 32], [-24, 0, 40],
    [-12, 0, 36], [-20, 0, 32],
    [-10, 4, 25.25], [-21, 8, 30], [-21, 8, 44],
    [-10, 12, 46.75], [-3, 16, 28], [-3, 16, 44],
    [-15, 16, 30], [-15, 16, 42],
    [-11, 19.3, 25.25], [-21, 24, 44], [-14, 24, 27], [-22, 24, 36],
    // arcade: doorways, rooms, stair, floor 2
    [-14, 0, -47], [-18, 0, -29], [-6, 0, -29], [-3, 0, -42],
    [-18, 0, -44], [-6, 0, -44], [-20.75, 3, -43],
    [-12, 6.5, -32], [-19, 6.5, -30], [-4, 6.5, -41],
    // back alley
    [-70, 0, -55], [-56, 0, -55], [-42, 0, -55], [-58, 0, -53], [-58, 0, -49],
  ];
  for (const [x, y, z] of wps) wp(world, x, y, z);
  world.manualLinks.push(
    // interior ramp → upper deck transitions (deck slabs block the LOS ray)
    [-10, 4, 25.25, -21, 8, 30, false],
    [-10, 12, 46.75, -3, 16, 44, false],
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
  );
  mergeStatic(scene, world);
  return world;
}

/* ============== THE LOBBY — walk-in map select, like the original ==============
   A dusk courtyard: grass strip, fountain, and five glowing gates. Walk into
   a gate to enter that arena; step on the mode pad to toggle FFA/TDM. */

// Floating text sign (canvas sprite). Returns a redraw(text) function.
function makeSign(scene, x, y, z, w, color, text) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const draw = (t) => {
    const g = c.getContext('2d');
    g.clearRect(0, 0, 512, 128);
    g.fillStyle = 'rgba(8,10,28,.88)';
    g.beginPath(); g.roundRect(6, 10, 500, 108, 18); g.fill();
    g.lineWidth = 6; g.strokeStyle = color; g.stroke();
    g.font = 'bold 52px "Arial Black", Arial';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = color;
    g.fillText(t, 256, 68);
    tex.needsUpdate = true;
  };
  draw(text);
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  spr.position.set(x, y, z);
  spr.scale.set(w, w / 4, 1);
  scene.add(spr);
  return draw;
}

export function buildAtrium(scene) {
  const world = newWorld({ killY: -30 });
  scene.background = new THREE.Color(0x2a2244);
  scene.fog = new THREE.Fog(0x2a2244, 90, 240);
  baseLighting(scene, 0xbfa8ff, 0x332244, [-40, 80, 30], 90);

  // courtyard floor + perimeter (inner faces at x ±32, z ±48)
  addBox(scene, world, 0, -0.5, 0, 64, 1, 96, 0x8a8598, { tex: 'neonfloor', repeat: [8, 12] });
  addBox(scene, world, 0, 6, -49.5, 70, 12, 3, 0x6a5f88, { tex: 'neonwall', repeat: [9, 2] });
  addBox(scene, world, 0, 6, 49.5, 70, 12, 3, 0x6a5f88, { tex: 'neonwall', repeat: [9, 2] });
  addBox(scene, world, -33.5, 6, 0, 3, 12, 99, 0x6a5f88, { tex: 'neonwall', repeat: [12, 2] });
  addBox(scene, world, 33.5, 6, 0, 3, 12, 99, 0x6a5f88, { tex: 'neonwall', repeat: [12, 2] });

  // grass boulevard + fountain
  addBox(scene, world, 0, 0.06, 14, 12, 0.14, 52, 0x3f7a35);
  addBox(scene, world, 0, 0.45, -22, 16, 0.9, 2, 0x555a74, { tex: 'panel' });   // pool rim
  addBox(scene, world, 0, 0.45, -34, 16, 0.9, 2, 0x555a74, { tex: 'panel' });
  addBox(scene, world, -8, 0.45, -28, 2, 0.9, 14, 0x555a74, { tex: 'panel' });
  addBox(scene, world, 8, 0.45, -28, 2, 0.9, 14, 0x555a74, { tex: 'panel' });
  addWater(scene, world, 0, 0.55, -28, 13.5, 10);
  addBox(scene, world, 0, 1.6, -28, 0.7, 2.6, 0.7, 0x9fd8ff, { collide: false, shadow: false, emissive: 0x9fd8ff, emissiveIntensity: 1.2 }); // jet
  const fLight = new THREE.PointLight(0x9fd8ff, 25, 24);
  fLight.position.set(0, 3, -28);
  scene.add(fLight);

  // big marquee over the north gate
  makeSign(scene, 0, 11.5, -46, 30, '#ff4d2e', 'NERF ARENA BLAST');

  // gate bays: [map, name, color, wall(n/w/e), offset]
  world.portals = [];
  const bays = [
    ['arena', 'BLAST COMPLEX', 0xd88a2b, 'n', 0],
    ['fortress', 'FORTRESS FALLS', 0x9a6fe0, 'w', 14],
    ['asteroids', 'ASTEROID BELT', 0x8fb8d8, 'w', -14],
    ['canopy', 'CANOPY', 0x4dbf6a, 'e', 14],
    ['city', 'NEON HEIGHTS', 0xff40a0, 'e', -14],
  ];
  for (const [id, name, color, wall, off] of bays) {
    const n = wall === 'n';
    const sgn = wall === 'e' ? 1 : -1;
    const px = n ? off : sgn * 30.6, pz = n ? -46.6 : off;   // pillar centerline
    const P = (dx, dz, w, h, d) => addBox(scene, world, px + dx, h / 2, pz + dz, w, h, d, 0x4a4266, { tex: 'neonwall' });
    if (n) {
      P(-4, 0, 1.6, 7, 1.6); P(4, 0, 1.6, 7, 1.6);
      addBox(scene, world, px, 7.6, pz, 9.6, 1.4, 1.6, 0x4a4266, { tex: 'neonwall' });
      addBox(scene, world, px, 3.2, pz - 0.9, 7, 6, 0.5, color, { collide: false, shadow: false, emissive: color, emissiveIntensity: 0.85 });
    } else {
      P(0, -4, 1.6, 7, 1.6); P(0, 4, 1.6, 7, 1.6);
      addBox(scene, world, px, 7.6, pz, 1.6, 1.4, 9.6, 0x4a4266, { tex: 'neonwall' });
      addBox(scene, world, px + sgn * 0.9, 3.2, pz, 0.5, 6, 7, color, { collide: false, shadow: false, emissive: color, emissiveIntensity: 0.85 });
    }
    makeSign(scene, n ? px : px - sgn * 1.6, 9.7, n ? pz + 1.6 : pz, 10, '#' + color.toString(16).padStart(6, '0'), name);
    const L = new THREE.PointLight(color, 26, 20);
    L.position.set(n ? px : px - sgn * 2.5, 4.5, n ? pz + 2.5 : pz);
    scene.add(L);
    world.portals.push({ x: n ? px : px + sgn * 0.5, z: n ? pz - 0.5 : pz, map: id, name });
  }

  // mode pad beside the spawn
  addBox(scene, world, 11, 0.3, 38, 3.4, 0.6, 3.4, 0x2a6a8a, { tex: 'panel' });
  addBox(scene, world, 11, 0.66, 38, 2.6, 0.1, 2.6, 0x30e0ff, { collide: false, shadow: false, emissive: 0x30e0ff, emissiveIntensity: 0.9 });
  world.modePad = { x: 11, z: 38 };
  world.setModeSign = makeSign(scene, 11, 3.4, 38, 9, '#30e0ff', 'MODE: FREE FOR ALL');

  // a little clutter so it feels lived-in
  addBox(scene, world, -14, 1.2, 30, 2.4, 2.4, 2.4, 0xb0763a, { tex: 'crate' });
  addBox(scene, world, -16.6, 1.2, 31, 2.4, 2.4, 2.4, 0xb0763a, { tex: 'crate' });
  addBox(scene, world, -15, 3.6, 30.4, 2.4, 2.4, 2.4, 0xb0763a, { tex: 'crate' });
  for (const [x, z, c] of [[-20, -46.9, 0xff40a0], [20, -46.9, 0x30e0ff]]) {
    addBox(scene, world, x, 8, z, 14, 0.8, 0.3, c, { collide: false, shadow: false, emissive: c, emissiveIntensity: 1.5 });
  }

  world.spawns.ffa.push(V(0, 0.1, 43));
  world.spawns.blue.push(V(0, 0.1, 43));
  world.spawns.red.push(V(0, 0.1, 43));
  wp(world, 0, 0, 20);
  mergeStatic(scene, world);
  return world;
}

export const MAPS = [
  { id: 'arena', name: 'BLAST COMPLEX', emoji: '🏟️',
    desc: 'Indoor labyrinth: crate maze, mezzanine, grand atrium with a floating gold platform, sunken basement.',
    thumb: 'linear-gradient(135deg,#c8461e,#d88a2b)', build: buildArena },
  { id: 'fortress', name: 'FORTRESS FALLS', emoji: '🏰',
    desc: 'Walled corridors around a trench: three bridges, battlements, towers, and a keep hiding the gold.',
    thumb: 'linear-gradient(135deg,#6e5a8c,#87b5d8)', build: buildFortress },
  { id: 'asteroids', name: 'ASTEROID BELT', emoji: '☄️',
    desc: 'Flat-topped rock plateaus around a derelict station: a cave, a canyon under-deck, balconies. Low gravity, long jumps, fatal void.',
    thumb: 'linear-gradient(135deg,#05060f,#334466)', build: buildAsteroids },
  { id: 'canopy', name: 'CANOPY', emoji: '🌲',
    desc: 'Giant forest: branch decks at three heights, treetop bridges, pad chains to a golden crown 30m up.',
    thumb: 'linear-gradient(135deg,#14291f,#5d9c46)', build: buildCanopy },
  { id: 'city', name: 'NEON HEIGHTS', emoji: '🌃',
    desc: 'Night rooftops over a street canyon: a hollow neon galleria with catwalks, an arcade block, back alleys, a subway. Gold on the tallest tower.',
    thumb: 'linear-gradient(135deg,#0b1026,#5a4a78)', build: buildCity },
];
