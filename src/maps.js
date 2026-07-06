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
  ['checker', 'panel', 'crate', 'rock', 'suit', 'plastic', 'neonwall', 'neonfloor', 'arcade',
   'poster1', 'target', 'hazard', 'grass', 'atrium-grass', 'dirt', 'flowers', 'door', 'lava']
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

// Loud 90s wall art (posters / targets / hazard banners), unlit for punch.
// Pure decoration — no collider, mounted a few cm off the wall face.
function addDecal(scene, name, x, y, z, w, yaw = 0, h = w) {
  const ai = AI_TEX[name];
  if (!ai) return;
  const map = ai.map.clone();
  map.needsUpdate = true;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map }));
  m.position.set(x, y, z);
  m.rotation.y = yaw;
  scene.add(m);
}

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

function addWater(scene, world, x, y, z, w, d, depth = 4) {
  world.waterZones ||= [];
  world.waterZones.push({
    minX: x - w / 2, maxX: x + w / 2,
    minZ: z - d / 2, maxZ: z + d / 2,
    surfaceY: y, bottomY: y - depth,
  });

  const n = waterNormalTex().clone();
  n.needsUpdate = true;
  n.repeat.set(w / 9, d / 9);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d),
    new THREE.MeshStandardMaterial({
      color: 0x11557f, transparent: true, opacity: 0.58, roughness: 0.08, metalness: 0.05,
      normalMap: n, normalScale: new THREE.Vector2(0.75, 0.75),
      envMapIntensity: 1.15, emissive: 0x06283f, emissiveIntensity: 0.12,
      depthWrite: false,
    }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(x, y, z);
  scene.add(mesh);
  world.anim.push((dt, t) => {
    n.offset.set(t * 0.018, t * 0.03);
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

function addVine(scene, world, x, z, y0, y1, r = 0.9, leanX = 0, leanZ = 0) {
  (world.vineZones ||= []).push({ x, z, minY: Math.min(y0, y1), maxY: Math.max(y0, y1), r });
  const h = Math.abs(y1 - y0);
  const matVine = new THREE.MeshStandardMaterial({
    color: 0x2d8a32, roughness: 0.9, metalness: 0,
    emissive: 0x0b2a0f, emissiveIntensity: 0.08,
  });
  const matLeaf = new THREE.MeshStandardMaterial({ color: 0x57b33a, roughness: 0.85, metalness: 0 });
  for (let i = 0; i < 5; i++) {
    const a = i * 2.15;
    const strand = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.055, h, 6), matVine);
    strand.position.set(
      x + Math.cos(a) * r * 0.22 + leanX * 0.5,
      (y0 + y1) / 2,
      z + Math.sin(a) * r * 0.22 + leanZ * 0.5,
    );
    strand.rotation.z = leanX * 0.035;
    strand.rotation.x = -leanZ * 0.035;
    strand.castShadow = strand.receiveShadow = true;
    scene.add(strand);
  }
  for (let i = 0; i < Math.max(6, Math.floor(h * 1.3)); i++) {
    const yy = Math.min(y0, y1) + 0.45 + (i / Math.max(1, Math.floor(h * 1.3))) * (h - 0.7);
    const a = i * 2.4;
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.16 + (i % 3) * 0.035, 6, 4), matLeaf);
    leaf.scale.set(1.25, 0.45, 0.75);
    leaf.position.set(x + Math.cos(a) * r * 0.28, yy, z + Math.sin(a) * r * 0.28);
    leaf.rotation.set(rand(-0.7, 0.7), rand(0, Math.PI), rand(-0.5, 0.5));
    scene.add(leaf);
  }
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
    const collider = { type: 'box', min: V(0, 0, 0), max: V(0, 0, 0) };
    world.colliders.push(collider);
    boxes.push({ lx, ly, lz, hx: w / 2, hy: h / 2, hz: d / 2, collider });
  };
  const addDoor = (lx, ly, lz, w, h, d, openDir) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), doorMat);
    mesh.position.set(lx, ly, lz);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
    const collider = { type: 'box', min: V(0, 0, 0), max: V(0, 0, 0) };
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
  // wall art — the complex is a sports venue, let it look like one
  // (bottoms sit above the y≈7 glow stripes — intersecting them glitched)
  addDecal(scene, 'poster1', -50, 12.2, -56.9, 9, 0);
  addDecal(scene, 'target', 50, 12.2, -56.9, 9, 0);
  addDecal(scene, 'hazard', 0, 10.6, 56.9, 12, Math.PI, 6);
  addDecal(scene, 'poster1', -76.9, 12.2, 30, 9, Math.PI / 2);
  addDecal(scene, 'target', 76.9, 12.2, -30, 9, -Math.PI / 2);
  // ground variety: an arcade-carpet lounge in the west wing
  addBox(scene, world, -52, 0.031, -30, 40, 0.06, 40, 0x9088b0, { tex: 'arcade', repeat: [8, 8] });
  addBox(scene, world, -52, 0.031, 30, 36, 0.06, 36, 0x7a94b0, { tex: 'grass', repeat: [7, 7] });
  // floating platform over the east basement + pad up
  addBox(scene, world, 54, 6.7, 30, 10, 0.6, 8, 0x7a4fc0, { tex: 'panel' });
  addJumpPad(scene, world, 45, -5, 30, 28, 5, 0, 0xffd23c); // offset — straight under bonks the underside
  pk(world, 'ammo', 54, 7.2, 30, { weapon: 'hyper' });
  wp(world, 45, -5, 30); wp(world, 54, 7, 30);
  world.manualLinks.push([45, -5, 30, 54, 7, 30, true]);

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
  pk(world, 'speed', 20, 0.2, -20);                      // crate maze lane
  pk(world, 'djump', -52, 0.2, 30);                      // west-wing turf
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
  // banners on the perimeter + a target on the west gatehouse tower
  addDecal(scene, 'target', -30, 6.5, -44.9, 7, 0);
  addDecal(scene, 'poster1', 30, 6.5, 44.9, 7, Math.PI);
  addDecal(scene, 'hazard', 76.9, 5.5, 20, 8, -Math.PI / 2);
  addDecal(scene, 'poster1', -76.9, 5.5, -20, 8, Math.PI / 2);
  addDecal(scene, 'target', -9, 6, -3.06, 4, Math.PI);
  // ground variety: grass courtyards, dirt lanes
  addBox(scene, world, -45, 0.031, 30, 26, 0.06, 22, 0x6aa84f, { tex: 'grass', repeat: [5, 4] });
  addBox(scene, world, 45, 0.031, -30, 26, 0.06, 22, 0x6aa84f, { tex: 'grass', repeat: [5, 4] });
  addBox(scene, world, 0, 0.031, 14.75, 100, 0.06, 8, 0xb08a5a, { tex: 'dirt', repeat: [14, 1] });
  addBox(scene, world, 0, 0.031, -14.75, 100, 0.06, 8, 0xb08a5a, { tex: 'dirt', repeat: [14, 1] });
  addBox(scene, world, -45, 0.036, -30, 20, 0.07, 16, 0xd8a8c8, { tex: 'flowers', repeat: [4, 3] });
  // floating platforms over the courtyards + pads
  addBox(scene, world, -30, 8.7, 30, 9, 0.6, 9, 0x9a6fe0, { tex: 'panel' });
  addJumpPad(scene, world, -39, 0, 30, 24, 6.4, 0, 0x9dff70);
  pk(world, 'health', -30, 9.2, 30);
  wp(world, -39, 0, 30); wp(world, -30, 9, 30);
  world.manualLinks.push([-39, 0, 30, -30, 9, 30, true]);
  addBox(scene, world, 30, 8.7, -30, 9, 0.6, 9, 0x9a6fe0, { tex: 'panel' });
  addJumpPad(scene, world, 39, 0, -30, 24, -6.4, 0, 0x9dff70);
  pk(world, 'ammo', 30, 9.2, -30, { weapon: 'sidewinder' });
  wp(world, 39, 0, -30); wp(world, 30, 9, -30);
  world.manualLinks.push([39, 0, -30, 30, 9, -30, true]);
  // glow strips along the trench lips
  addBox(scene, world, 0, 0, 7.5, 146, 0.15, 0.3, 0x30e0ff, { collide: false, shadow: false, emissive: 0x30e0ff, emissiveIntensity: 1.3 });
  addBox(scene, world, 0, 0, -7.5, 146, 0.15, 0.3, 0x30e0ff, { collide: false, shadow: false, emissive: 0x30e0ff, emissiveIntensity: 1.3 });

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
  // east rail splits around the perch ramp (z −30..−19) — the ramp slab cut
  // through it at a near-flat angle and the intersection shimmered
  addBox(scene, world, 1.85, 8.3, -3, 0.3, 1.0, 32, 0xffd23c);
  addBox(scene, world, 1.85, 8.3, -34, 0.3, 1.0, 8, 0xffd23c);
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
  pk(world, 'speed', -30, 0.2, 0);                       // west field
  pk(world, 'djump', 30, 0.2, 30);                       // NE courtyard
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
  pk(world, 'speed', 18, 9, 0);                          // station east wing
  pk(world, 'djump', 0, 9.2, 4);                         // station center
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
  scene.background = new THREE.Color(0x14291f);
  scene.fog = new THREE.Fog(0x14291f, 110, 320);
  baseLighting(scene, 0xa8d8a0, 0x1c3020, [60, 120, -40], 130);

  // Mossy ground split by twin RIVERS (channels x −58..−50 and x 50..58,
  // bed −4.8, water −0.55): swim them, cross the plank bridges, or duck into
  // the covered flooded tunnels. A submerged connector runs under the south
  // lawn between the two riverbeds.
  addBox(scene, world, -70, -0.5, 0, 24, 1, 164, 0x5d9c46, { tex: 'rock', repeat: [3, 16] });
  addBox(scene, world, 0, -0.5, 0, 100, 1, 164, 0x5d9c46, { tex: 'rock', repeat: [10, 16] });
  addBox(scene, world, 70, -0.5, 0, 24, 1, 164, 0x5d9c46, { tex: 'rock', repeat: [3, 16] });
  addBox(scene, world, -54, -5.3, 0, 8, 1, 164, 0x3f6e5e, { tex: 'rock', repeat: [1, 16] });   // riverbed
  addBox(scene, world, 54, -5.3, 0, 8, 1, 164, 0x3f6e5e, { tex: 'rock', repeat: [1, 16] });
  const riverSide = (x, gapZ = null) => {
    if (gapZ == null) {
      addBox(scene, world, x, -2.45, 0, 0.7, 4.8, 164, 0x4a7a52);
      return;
    }
    addBox(scene, world, x, -2.45, (gapZ - 4 - 82) / 2, 0.7, 4.8, 82 + gapZ - 4, 0x4a7a52);
    addBox(scene, world, x, -2.45, (gapZ + 4 + 82) / 2, 0.7, 4.8, 82 - gapZ - 4, 0x4a7a52);
  };
  riverSide(-57.6);        // channel sides — inset 5cm from the bank faces
  riverSide(-50.4, 64);    // gap opens into the underwater connector
  riverSide(50.4, 64);
  riverSide(57.6);
  addWater(scene, world, -54, -0.55, 0, 7.8, 162, 5.4);
  addWater(scene, world, 54, -0.55, 0, 7.8, 162, 5.4);
  addBox(scene, world, 0, -5.3, 64, 108, 1, 8, 0x3f6e5e, { tex: 'rock', repeat: [12, 1] });   // underwater connector bed
  addBox(scene, world, 0, -2.45, 59.6, 108, 4.8, 0.7, 0x4a7a52, { tex: 'rock', repeat: [12, 1] });
  addBox(scene, world, 0, -2.45, 68.4, 108, 4.8, 0.7, 0x4a7a52, { tex: 'rock', repeat: [12, 1] });
  addBox(scene, world, 0, -0.1, 64, 108, 0.3, 8.8, 0x4a7a52, { tex: 'rock', repeat: [12, 1] }); // low ceiling keeps it underwater
  addWater(scene, world, 0, -0.55, 64, 108, 7.8, 5.4);
  addBox(scene, world, -54, -0.1, 4, 8.6, 0.3, 20, 0x5d9c46, { tex: 'rock' });   // flooded tunnel covers
  addBox(scene, world, -54, -0.1, 46, 8.6, 0.3, 12, 0x5d9c46, { tex: 'rock' });
  addBox(scene, world, 54, -0.1, -4, 8.6, 0.3, 20, 0x5d9c46, { tex: 'rock' });
  addBox(scene, world, 54, -0.1, 46, 8.6, 0.3, 12, 0x5d9c46, { tex: 'rock' });
  addBox(scene, world, -54, 0.14, -40, 10, 0.28, 3, 0x8a6a40, { tex: 'crate', repeat: [3, 1] }); // plank bridge
  addBox(scene, world, 54, 0.14, -40, 10, 0.28, 3, 0x8a6a40, { tex: 'crate', repeat: [3, 1] });
  addRamp(scene, world, { axis: 'x', minX: -56.5, maxX: -50, minZ: 28, maxZ: 32, h0: -4.8, h1: 0.3, color: 0x4a7a52 });
  addRamp(scene, world, { axis: 'x', minX: -58, maxX: -51.5, minZ: -52, maxZ: -48, h0: 0.3, h1: -4.8, color: 0x4a7a52 });
  addRamp(scene, world, { axis: 'x', minX: 50, maxX: 56.5, minZ: 28, maxZ: 32, h0: 0.3, h1: -4.8, color: 0x4a7a52 });
  addRamp(scene, world, { axis: 'x', minX: 51.5, maxX: 58, minZ: -52, maxZ: -48, h0: -4.8, h1: 0.3, color: 0x4a7a52 });
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
  addDecal(scene, 'target', -20, 8, -79.94, 10, 0);
  addDecal(scene, 'poster1', 20, 9, 79.94, 10, Math.PI);
  addDecal(scene, 'hazard', -79.94, 8, 20, 10, Math.PI / 2);
  addDecal(scene, 'target', 0, 12, -2.56, 4, Math.PI);
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

  // hedge lanes — break up the open lawn into corridors, plus a small maze
  // pocket in the SE quadrant (the pulsar sits inside it)
  for (const [hx, hz, hw, hd] of [[-15, 60, 50, 2], [15, -60, 50, 2], [60, 15, 2, 50], [-60, -15, 2, 50],
                                  [-30, 14, 2, 26], [30, -14, 2, 26],
                                  [18, -33, 24, 2], [10, -22, 2, 20], [24, -40, 2, 12]]) {
    addBox(scene, world, hx, 1.75, hz, hw, 3.5, hd, 0x3a6b30, { tex: 'rock' });
    (world.foliageZones ||= []).push({
      minX: hx - hw / 2 - 0.45, maxX: hx + hw / 2 + 0.45,
      minY: -0.1, maxY: 3.7,
      minZ: hz - hd / 2 - 0.45, maxZ: hz + hd / 2 + 0.45,
    });
  }
  // hedge-top balance beam: side ramp near the hedge's north end, then walk
  // the 2-wide top south (the south end abuts the big west ramp's corridor)
  addRamp(scene, world, { axis: 'x', minX: -29, maxX: -22.5, minZ: 21, maxZ: 23.5, h0: 3.8, h1: 0, color: 0x4a7a3a });

  // RANGER HUT (NE lawn): room with a west door, walkable roof, roof ramp
  const HUT = 0x8a6a40;
  addBox(scene, world, 26, 1.85, 12.3, 10, 3.7, 0.6, HUT, { tex: 'crate' });   // south wall
  addBox(scene, world, 26, 1.85, 19.7, 10, 3.7, 0.6, HUT, { tex: 'crate' });   // north wall
  addBox(scene, world, 30.7, 1.85, 16, 0.6, 3.7, 8, HUT, { tex: 'crate' });    // east wall
  addBox(scene, world, 21.3, 1.85, 13.4, 0.6, 3.7, 2.8, HUT, { tex: 'crate' }); // west wall + door gap
  addBox(scene, world, 21.3, 1.85, 18.6, 0.6, 3.7, 2.8, HUT, { tex: 'crate' });
  addBox(scene, world, 26, 4, 16, 10.6, 0.6, 8.6, HUT, { tex: 'crate' });      // roof (top 4.3)
  addRamp(scene, world, { axis: 'x', minX: 12.5, maxX: 21.2, minZ: 13, maxZ: 16.5, h0: 0, h1: 4.6, color: HUT });

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

  // Edge bridges: west/east at 20, north/south at 10 (2cm below deck tops)
  addBox(scene, world, -45, 19.48, 0, 3, 1, 78, 0x7a5c38, { tex: 'crate', repeat: [1, 10] });
  addBox(scene, world, 45, 19.48, 0, 3, 1, 78, 0x7a5c38, { tex: 'crate', repeat: [1, 10] });
  addBox(scene, world, 0, 9.48, -45, 78, 1, 3, 0x7a5c38, { tex: 'crate', repeat: [10, 1] });
  addBox(scene, world, 0, 9.48, 45, 78, 1, 3, 0x7a5c38, { tex: 'crate', repeat: [10, 1] });
  addVine(scene, world, -45, -18, 0.2, 19.1, 1.05);  // hanging from west bridge
  addVine(scene, world, 45, 16, 0.2, 19.1, 1.05);    // hanging from east bridge
  addVine(scene, world, -45, 30, 0.2, 19.1, 1.0);    // west bridge south drop
  addVine(scene, world, 45, -28, 0.2, 19.1, 1.0);    // east bridge north drop
  addVine(scene, world, -18, -45, 0.2, 9.1, 0.95);   // north catwalk drop
  addVine(scene, world, 20, 45, 0.2, 9.1, 0.95);     // south catwalk drop
  addVine(scene, world, 34, -45, 0.2, 9.1, 0.9);     // north catwalk east drop
  addVine(scene, world, -34, 45, 0.2, 9.1, 0.9);     // south catwalk west drop
  addVine(scene, world, 7.8, 3, 0.2, 8.1, 0.85, -0.4, 0);     // center-tree wall growth
  addVine(scene, world, 7.8, 7.2, 8.1, 16.1, 0.85, -0.35, 0.2); // center 8 → 16
  addVine(scene, world, 3.6, -6.8, 16.1, 24.1, 0.8, 0.2, -0.25); // center 16 → 24
  addVine(scene, world, -38.1, -45, 0.2, 20.1, 0.95, -0.2, 0); // SW hollow tree exterior
  addVine(scene, world, -30, 15, 0.2, 4.1, 0.8, 0, -0.2);     // hedge-top shortcut
  addVine(scene, world, 51.9, -45, 0.2, 19.1, 0.9, 0.2, 0);   // NE trunk side
  addVine(scene, world, -51.9, 45, 0.2, 19.1, 0.9, -0.2, 0);  // NW trunk side
  addVine(scene, world, 45, 51.9, 0.2, 19.1, 0.9, 0, 0.2);    // SE trunk side
  addVine(scene, world, -2.8, -9.8, 0.2, 15.1, 0.85, 0, -0.25); // center tiers north face
  addVine(scene, world, 30.9, 16, 0.2, 4.2, 0.75, 0.25, 0);   // ranger hut east wall
  addVine(scene, world, -11, 60, 0.2, 3.8, 0.8, 0, 0.25);     // north hedge lane
  addVine(scene, world, 60, -3, 0.2, 3.8, 0.8, 0.25, 0);      // east hedge lane

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
  const autumn = addAsteroid(scene, deco, 45, 33, 45, 13, 0xd8742a); // one tree turns first
  autumn.material.map = null;
  (world.foliageZones ||= []).push({ x: 45, y: 33, z: 45, r: 12.5 });
  for (const [x, y, z, r] of [[-45, 33, -45, 13], [45, 33, -45, 13], [-45, 33, 45, 13], [0, 39, 0, 16],
                              [-20, 1, -60, 3], [60, 1, 20, 3], [-60, 1, 10, 2.5], [25, 1, 60, 3]]) {
    const blob = addAsteroid(scene, deco, x, y, z, r, 0x3f7a33);
    blob.material.map = null;
    world.foliageZones.push({ x, y, z, r: r * 0.95 });
  }

  // Spawns
  for (const dz of [-25, -12, 0, 12, 25]) world.spawns.blue.push(V(-62, 0.1, dz));
  for (const dz of [-25, -12, 0, 12, 25]) world.spawns.red.push(V(62, 0.1, dz));
  for (const [x, y, z] of [[-40, 10.2, -40], [40, 10.2, 40], [0, 8.2, -7], [-62, 0.1, -25], [62, 0.1, 25],
                           [-40, 20.2, 40], [40, 20.2, -40], [-30, 0.1, 0]]) {
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
  pk(world, 'health', 26, 0.2, 16);                       // inside the ranger hut
  pk(world, 'ammo', -27, 0.2, -24, { weapon: 'scatter' }); // in the fallen log
  pk(world, 'star', -30, 3.9, 25, { hidden: true });      // hedge-top balance beam

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
    // ranger hut: door, interior, ramp, roof
    [19, 0, 16], [26, 0, 16], [16.5, 2.2, 14.75], [26, 4.3, 16],
    // fallen log tunnel + SE hedge maze pocket
    [-27, 0, -24], [-20, 0, -24], [-34, 0, -24],
    [16, 0, -18], [16, 0, -29], [4, 0, -29], [28, 0, -37],
    // river: bed line, flooded tunnels, exit-ramp mids, crossings on top
    [-54, -2.6, -20], [-54, -2.6, 4], [-54, -2.6, 24], [-54, -2.6, 40], [-54, -2.6, 56],
    [-53, -1.2, 30], [-55, -1.2, -50],
    [54, -2.6, -20], [54, -2.6, 4], [54, -2.6, 24], [54, -2.6, 40], [54, -2.6, 56],
    [53, -1.2, 30], [55, -1.2, -50],
    [-40, -2.6, 64], [-18, -2.6, 64], [0, -2.6, 64], [18, -2.6, 64], [40, -2.6, 64],
    [-54, 0, -40], [-54, 0, 10], [-54, 0, 46],
    [54, 0, -40], [54, 0, 10], [54, 0, 46],
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

  // SUBWAY: stairs at (-30,-7) and (32,7) down into an L-shaped tunnel
  addRamp(scene, world, { axis: 'z', minX: -34, maxX: -26, minZ: -12, maxZ: -2, h0: -6, h1: 0, color: 0x2f3542 });
  addRamp(scene, world, { axis: 'z', minX: 28, maxX: 36, minZ: 2, maxZ: 12, h0: -6, h1: 0, color: 0x2f3542 });
  // Stairwell guard walls: keep the ramp mouths open, but seal the side voids
  // so players cannot fall out of the map beside the subway entrances.
  addBox(scene, world, -34.5, -3.35, -7, 1, 6.3, 10.5, 0x262b38, { tex: 'panel' });
  addBox(scene, world, -25.5, -3.35, -7, 1, 6.3, 10.5, 0x262b38, { tex: 'panel' });
  addBox(scene, world, 27.5, -3.35, 7, 1, 6.3, 10.5, 0x262b38, { tex: 'panel' });
  addBox(scene, world, 36.5, -3.35, 7, 1, 6.3, 10.5, 0x262b38, { tex: 'panel' });
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
    [32, -35, 26, 28, 0x44586e], [62, -32, 18, 16, 0x60566e],
    [-58, 33, 22, 24, 0x4c5a6a],
    [32, 34, 22, 18, 0x5c4f62], [64, 30, 16, 10, 0x596478],
    [-78, 24, 12, 16, 0x40506a], [-78, -30, 12, 18, 0x4f5a78],
    [-38, 58, 14, 14, 0x4a6070], [10, 58, 16, 12, 0x59606f],
    [78, 48, 12, 22, 0x4d5570], [78, -50, 12, 18, 0x5a4a70],
    [-36, -60, 14, 10, 0x4a586a], [12, -58, 12, 14, 0x565d76],
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
    [-20, -58, 52, 6], [52, -58, 54, 6], [-58, 0, 5, 54], [32, 0, 5, 54],
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
  // crests 0.5 above the gallery deck and overlaps its edge — a flush joint
  // at this slope wedges the capsule against the deck's side face instead
  addRamp(scene, world, { axis: 'x', minX: -18, maxX: -5.4, minZ: 45, maxZ: 48.5, h0: 8, h1: 16.5, color: galIn });
  addBox(scene, world, -2.75, 15.6, 36, 6.5, 0.8, 25, galIn, { tex: 'arcade', repeat: [2, 6] });
  // bare catwalks across the void at 16 — the z=30 one ends at the window
  addBox(scene, world, -15.25, 15.6, 30, 18.5, 0.8, 2.5, 0x8a80a8, { tex: 'arcade', repeat: [5, 1] });
  addBox(scene, world, -15.25, 15.6, 42, 18.5, 0.8, 2.5, 0x8a80a8, { tex: 'arcade', repeat: [5, 1] });
  // third ramp stacked over the first: gallery (16) → chamber (24)
  addRamp(scene, world, { axis: 'x', minX: -18, maxX: -6, minZ: 23.5, maxZ: 27, h0: 24, h1: 16, color: galIn });
  // L-shaped top chamber at 24 (west strip + southwest wing) with rails
  addBox(scene, world, -21.25, 23.6, 36, 6.5, 0.8, 25, galIn, { tex: 'arcade', repeat: [2, 6] });
  addBox(scene, world, -14, 23.6, 29.5, 8, 0.8, 1, galIn, { tex: 'arcade', repeat: [2, 1] }); // leaves ramp crest open
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
  // lava pit in the SE corner — mind the glow, and mind the edge
  addLava(scene, world, 56, -50, 8, 8, -1.1);
  // ground variety: galleria plaza, crosswalk bands
  addBox(scene, world, -12, 0.031, 14, 30, 0.06, 14, 0x9088b0, { tex: 'arcade', repeat: [6, 3] });
  addBox(scene, world, 0, 0.031, -20, 8, 0.06, 30, 0x8a94b0, { tex: 'checker', repeat: [2, 7] });
  addBox(scene, world, 41.5, 0.031, 0, 7, 0.06, 60, 0x8a94b0, { tex: 'checker', repeat: [2, 14] });
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
  addDecal(scene, 'poster1', -40, 14, -63.94, 14, 0);
  addDecal(scene, 'target', 40, 14, -63.94, 12, 0);
  addDecal(scene, 'hazard', 0, 12, 63.94, 16, Math.PI);
  addDecal(scene, 'poster1', 84.94, 12, 20, 12, -Math.PI / 2);
  addDecal(scene, 'target', -12, 29, 21.94, 8, Math.PI);
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

  // Spawns
  for (const dz of [-56, -20, 0, 8, 56]) world.spawns.blue.push(V(-76, 0.1, dz));
  for (const dz of [-38, -20, 0, 20, 56]) world.spawns.red.push(V(78, 0.1, dz));
  for (const [x, y, z] of [[-58, 12.2, -35], [32, 18.2, 34], [64, 10.2, 30], [0, 0.1, -56],
                           [0, 0.1, 56], [-40, 0.1, 0], [40, 0.1, 0], [-12, 20.2, -38]]) {
    world.spawns.ffa.push(V(x, y, z));
  }

  // Pickups
  pk(world, 'shield', -12, 20.2, -32);                   // A2 rooftop
  pk(world, 'speed', -56, 0.2, -55);                     // back alley mid
  pk(world, 'djump', -20, 0.2, 10);                      // galleria plaza edge
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
  );
  mergeStatic(scene, world);
  return world;
}

/* ---------------- automatic doors ---------------- */
// Sliding pocket doors: closed until someone steps close, so you can't see
// or shoot through a doorway without committing to it. Colliders join the
// world on the first update tick — AFTER the waypoint graph is built — so
// bot paths still link through the openings.
function addDoor(scene, world, x, y, z, w, h, d) {
  const dmat = new THREE.MeshStandardMaterial({ color: 0x8a80a8, roughness: 0.55, metalness: 0.35,
    emissive: 0x8a5fff, emissiveIntensity: 0.12 });
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
  const collider = { type: 'box', min: V(x - w / 2, y, z - d / 2), max: V(x + w / 2, y + h, z + d / 2) };
  (world.doors ||= []).push({ mesh, collider, x, y, z, w, h, d, along: w >= d, off: 0 });
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

/* ============== SECRET MAP — THE SANCTUM (hidden gate in the lobby) ==============
   An obsidian temple: obelisk chamber at the center, four rune rooms reached
   through tight corridors, a crypt below (the gold), a balcony, rooftops via
   pads, and a dark ambulatory ring around it all. */
function buildSanctum(scene) {
  const world = newWorld({ killY: -25, waypointLinkDist: 20, waypointLinkDy: 4.6 });
  scene.background = new THREE.Color(0x0a0714);
  scene.fog = new THREE.Fog(0x0a0714, 70, 220);
  baseLighting(scene, 0x8a7fb8, 0x1a1428, [40, 90, -30], 110);
  const STONE = 0x3e3358, FLOOR = 0x2c2440, DARK = 0x14101f;

  // shell + floor (two stair holes over the crypt at x ±(30..40), z −2..2)
  for (const [x, z, w, d] of [[0, -50.5, 104, 3], [0, 50.5, 104, 3], [-50.5, 0, 3, 104], [50.5, 0, 3, 104]]) {
    addBox(scene, world, x, 6, z, w, 12, d, STONE, { tex: 'rock', repeat: [12, 2] });
  }
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
  addBox(scene, world, 0, -0.5, 0, 60, 1, 4, FLOOR, { tex: 'panel', repeat: [8, 1] });
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
  addRamp(scene, world, { axis: 'x', minX: 30, maxX: 40, minZ: -2, maxZ: 2, h0: -6, h1: 0.3, color: STONE });
  addRamp(scene, world, { axis: 'x', minX: -40, maxX: -30, minZ: -2, maxZ: 2, h0: 0.3, h1: -6, color: STONE });
  addBox(scene, world, 0, -1.6, 5.9, 60, 0.3, 0.2, 0x30ffc8, { collide: false, shadow: false, emissive: 0x30ffc8, emissiveIntensity: 1.4 });
  addBox(scene, world, 0, -1.6, -5.9, 60, 0.3, 0.2, 0x30ffc8, { collide: false, shadow: false, emissive: 0x30ffc8, emissiveIntensity: 1.4 });
  const cryptLight = new THREE.PointLight(0x30ffc8, 30, 40);
  cryptLight.position.set(0, -3, 0);
  scene.add(cryptLight);

  // CENTER CHAMBER (36×36, walls h6, door mid each side) + obelisk dais
  for (const s of [1, -1]) {
    addBox(scene, world, -10, 3, 18 * s, 16, 6, 1.2, STONE, { tex: 'rock' });
    addBox(scene, world, 10, 3, 18 * s, 16, 6, 1.2, STONE, { tex: 'rock' });
    addBox(scene, world, 18 * s, 3, -10, 1.2, 6, 16, STONE, { tex: 'rock' });
    addBox(scene, world, 18 * s, 3, 10, 1.2, 6, 16, STONE, { tex: 'rock' });
    addBox(scene, world, 0, 4.8, 18.8 * s, 24, 0.35, 0.25, 0x8a5fff, { collide: false, shadow: false, emissive: 0x8a5fff, emissiveIntensity: 1.4 });
    addBox(scene, world, 18.8 * s, 4.8, 0, 0.25, 0.35, 24, 0x8a5fff, { collide: false, shadow: false, emissive: 0x8a5fff, emissiveIntensity: 1.4 });
  }
  addBox(scene, world, 0, 0.3, 0, 10, 0.6, 10, DARK, { tex: 'panel' });          // dais
  addBox(scene, world, 0, 4.6, 0, 2.6, 8, 2.6, DARK, { tex: 'rock', repeat: [1, 3] }); // obelisk
  addBox(scene, world, 0, 9.2, 0, 1.4, 1.2, 1.4, 0x8a5fff, { collide: false, shadow: false, emissive: 0x8a5fff, emissiveIntensity: 1.6 });
  const obLight = new THREE.PointLight(0x8a5fff, 55, 34);
  obLight.position.set(0, 10, 0);
  scene.add(obLight);

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
  addRamp(scene, world, { axis: 'x', minX: -43, maxX: -33, minZ: -8.8, maxZ: -5.8, h0: 5.3, h1: 0, color: STONE });

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

  // cavern ceiling: no open sky — discs ricochet back down (no shadow cast,
  // or the sun would flat-black the whole temple; faint glow sells the rock)
  addBox(scene, world, 0, 12.45, 0, 104, 0.9, 104, 0x241c38,
    { tex: 'rock', repeat: [12, 12], emissive: 0x2a1a4a, emissiveIntensity: 0.35, shadow: false });

  // automatic doors on every doorway — no peeking, no doorway sniping
  addDoor(scene, world, 0, 0, 18, 4.2, 5.9, 1.4);      // chamber
  addDoor(scene, world, 0, 0, -18, 4.2, 5.9, 1.4);
  addDoor(scene, world, 18, 0, 0, 1.4, 5.9, 4.2);
  addDoor(scene, world, -18, 0, 0, 1.4, 5.9, 4.2);
  addDoor(scene, world, 26.6, 0, 0, 1.4, 5.9, 4.2);    // E/W rooms
  addDoor(scene, world, 43.4, 0, 0, 1.4, 5.9, 4.2);
  addDoor(scene, world, -26.6, 0, 0, 1.4, 5.9, 4.2);
  addDoor(scene, world, -43.4, 0, 0, 1.4, 5.9, 4.2);
  addDoor(scene, world, 0, 0, 26.6, 4.2, 5.9, 1.4);    // N/S rooms + ring doors
  addDoor(scene, world, 0, 0, -26.6, 4.2, 5.9, 1.4);
  addDoor(scene, world, 13.4, 0, 37.5, 1.4, 5.9, 5.2);
  addDoor(scene, world, 13.4, 0, -37.5, 1.4, 5.9, 5.2);

  // lava pools in the NW and SE courts — the temple demands sacrifice
  addLava(scene, world, -28, 28, 9, 9, -1.1);
  addLava(scene, world, 28, -28, 9, 9, -1.1);
  // and a molten stretch of the crypt, crossed by a narrow plank
  addLava(scene, world, -21, 0, 10, 11.3, -7.1);
  addBox(scene, world, -21, -5.65, 0, 10.5, 0.7, 3, 0x1a1428, { tex: 'rock', repeat: [3, 1] });
  addRamp(scene, world, { axis: 'x', minX: -28.2, maxX: -26.2, minZ: -1.5, maxZ: 1.5, h0: -6, h1: -5.28, color: 0x1a1428 });
  addRamp(scene, world, { axis: 'x', minX: -15.8, maxX: -13.8, minZ: -1.5, maxZ: 1.5, h0: -5.28, h1: -6, color: 0x1a1428 });

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
  for (const [x, z] of [[44, 44], [-44, 44], [44, -44], [-44, -44], [0, 35], [0, -35], [35, 6], [-35, 6]]) {
    world.spawns.ffa.push(V(x, 0.1, z));
  }

  // Pickups
  pk(world, 'gold', 0, -5.8, 0);                          // crypt heart
  pk(world, 'silver', 0, 0.8, -3.2);                      // dais
  pk(world, 'shield', 0, 0.8, 3.2);
  pk(world, 'speed', 0, 0.2, -32);                        // S room
  pk(world, 'djump', 0, 0.2, 47);                         // north ambulatory
  pk(world, 'weapon', 0, 6.7, 35, { weapon: 'whomper' }); // N roof
  pk(world, 'weapon', -39, 5.2, 4, { weapon: 'hyper' });  // W balcony
  pk(world, 'weapon', 26, -5.8, 0, { weapon: 'zooka' });  // crypt
  pk(world, 'weapon', 35, 0.2, 6, { weapon: 'scatter' });
  pk(world, 'weapon', 0, 0.2, -37, { weapon: 'pulsar' });
  pk(world, 'weapon', 22, 0.2, 22, { weapon: 'sidewinder' });
  pk(world, 'ammo', 4, 6.7, 35, { weapon: 'whomper' });
  pk(world, 'ammo', -39, 5.2, -1, { weapon: 'hyper' });
  pk(world, 'ammo', 20, -5.8, 0, { weapon: 'zooka' });
  pk(world, 'ammo', 35, 0.2, -6, { weapon: 'scatter' });
  pk(world, 'ammo', -5, 0.2, -35, { weapon: 'pulsar' });
  pk(world, 'ammo', -22, 0.2, -22, { weapon: 'sidewinder' });
  pk(world, 'health', 14, 0.2, 14);
  pk(world, 'health', -14, 0.2, -14);
  pk(world, 'health', 47, 0.2, 0);
  pk(world, 'health', -47, 0.2, 24);
  pk(world, 'star', -26, -5.8, 0, { hidden: true });      // crypt west run
  pk(world, 'star', 47, 0.2, -47, { hidden: true });      // ring corner brazier
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
    [30, 0, 6], [40, 0, 6], [35, 0, -6], [42, 0, 0],
    [-30, 0, 6], [-40, 0, 6], [-35, 0, -6], [-42, 0, 0],
    [35, -2.85, 0], [-35, -2.85, 0],
    [28, -6, 0], [14, -6, 0], [0, -6, 0], [-14, -6, 0], [-28, -6, 0],
    // N/S rooms + their ring doors
    [0, 0, 30], [-8, 0, 40], [8, 0, 40], [16, 0, 37.5],
    [0, 0, -30], [-8, 0, -40], [8, 0, -40], [16, 0, -37.5],
    // W balcony ramp + deck
    [-38, 2.6, -7.3], [-39, 5, 2],
    // ambulatory ring (≤16 apart so it chains) + diagonal courts
    [47, 0, 0], [47, 0, 16], [47, 0, -16], [47, 0, 32], [47, 0, -32],
    [-47, 0, 0], [-47, 0, 16], [-47, 0, -16], [-47, 0, 32], [-47, 0, -32],
    [0, 0, 47], [16, 0, 47], [-16, 0, 47], [32, 0, 47], [-32, 0, 47],
    [0, 0, -47], [16, 0, -47], [-16, 0, -47], [32, 0, -47], [-32, 0, -47],
    [46, 0, 46], [-46, 0, 46], [46, 0, -46], [-46, 0, -46],
    [22, 0, 22], [-22, 0, 22], [22, 0, -22], [-22, 0, -22],
    [30, 0, 16], [-30, 0, 16], [30, 0, -16], [-30, 0, -16],
    [16, 0, 30], [-16, 0, 30], [16, 0, -30], [-16, 0, -30],
    // roofs + pads
    [0, 6.5, 35], [0, 6.5, -35], [20, 0, 40], [-20, 0, -40],
  ];
  for (const [x, y, z] of wps) wp(world, x, y, z);
  world.manualLinks.push(
    [-38, 2.6, -7.3, -39, 5, 2, false],   // balcony ramp → deck (deck edge blocks LOS)
    [20, 0, 40, 0, 6.5, 35, true],        // pads → roofs
    [-20, 0, -40, 0, 6.5, -35, true],
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
  const beam = (x, y, z, w, h, d) => addBox(scene, world, x, y, z, w, h, d, IC, iw);
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
  world.spawns.blue = spawns.filter((_, i) => i % 2 === 0);
  world.spawns.red = spawns.filter((_, i) => i % 2 === 1);

  // Pickups over every surface + the lattice — reward exploring all of it
  pk(world, 'gold', 6, 46.6, 6);                          // ceiling
  pk(world, 'silver', 0, 25.5, 0);                        // centre of the lattice
  pk(world, 'shield', 23.4, CY, 8);                       // +X wall
  pk(world, 'speed', 8, CY, -23.4);                       // -Z wall
  pk(world, 'djump', -23.4, CY, -8);                      // -X wall
  pk(world, 'star', -6, 46.6, -6, { hidden: true });      // ceiling
  pk(world, 'star', -23.4, 35, 0, { hidden: true });      // high on the -X wall
  pk(world, 'star', 17, 40, 17, { hidden: true });        // high on a corner pillar
  pk(world, 'star', 0, 13.5, 9, { hidden: true });        // lower inner ring
  pk(world, 'weapon', 0, 0.2, 20, { weapon: 'zooka' });   // floor
  pk(world, 'weapon', 23.4, 14, 0, { weapon: 'scatter' }); // low on +X wall
  pk(world, 'weapon', 0, 25.5, 12, { weapon: 'pulsar' });  // main ring
  pk(world, 'weapon', -6, 46.6, 12, { weapon: 'hyper' });  // ceiling
  pk(world, 'weapon', 23.4, 32, -8, { weapon: 'sidewinder' });
  pk(world, 'weapon', -9, 37.5, 0, { weapon: 'whomper' }); // upper inner ring
  pk(world, 'ammo', 0, 0.2, -20, { weapon: 'zooka' });
  pk(world, 'ammo', 17, 25.5, 0, { weapon: 'scatter' });
  pk(world, 'ammo', 0, 25.5, -12, { weapon: 'pulsar' });
  pk(world, 'ammo', 6, 46.6, 12, { weapon: 'hyper' });
  pk(world, 'ammo', 23.4, 26, -8, { weapon: 'sidewinder' });
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

/* ============== THE LOBBY — walk-in map select, like the original ==============
   A dusk courtyard: grass strip, fountain, and five glowing gates. Walk into
   a gate to enter that arena; step on the mode pad to toggle FFA/TDM. */

// Flat text sign mounted on a wall (canvas-textured plane, fixed yaw —
// sprites clipped through the walls). Returns a redraw(text) function.
function makeSign(scene, x, y, z, w, color, text, yaw = 0) {
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
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w / 4),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
  m.position.set(x, y, z);
  m.rotation.y = yaw;
  scene.add(m);
  return draw;
}

export function buildAtrium(scene) {
  const world = newWorld({ killY: -30 });
  scene.background = new THREE.Color(0xd99cb0);
  scene.fog = new THREE.Fog(0xd99cb0, 120, 340);
  baseLighting(scene, 0xffe0c8, 0x8a6a90, [-40, 80, 30], 90);

  // warm dusk sky dome: gradient + a sprinkle of early stars up top
  const skyC = document.createElement('canvas');
  skyC.width = 512; skyC.height = 512;
  const sg = skyC.getContext('2d');
  const grad = sg.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, '#4a3a8e');
  grad.addColorStop(0.42, '#9a63b8');
  grad.addColorStop(0.62, '#e88aa0');
  grad.addColorStop(0.8, '#ffc978');
  grad.addColorStop(1, '#ffc978');
  sg.fillStyle = grad;
  sg.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 90; i++) {
    sg.fillStyle = `rgba(255,255,255,${0.25 + Math.random() * 0.55})`;
    const s = Math.random() < 0.15 ? 2 : 1;
    sg.fillRect(Math.random() * 512, Math.random() * 190, s, s);
  }
  const skyTex = new THREE.CanvasTexture(skyC);
  skyTex.colorSpace = THREE.SRGBColorSpace;
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(380, 24, 12),
    new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false })));

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
  addBox(scene, world, 30.2, 2.5, 40, 0.6, 5, 5.6, 0x6a5f88, { tex: 'neonwall' }); // concealer slab
  addBox(scene, world, 32.5, -0.5, 42, 1.2, 1, 4.2, 0x3a3452, { tex: 'panel' });   // door threshold (no void gap)
  // the passage: east hallway, then a leg north to the gate chamber
  // hall pieces start at x 33, buried inside the wall box (32..35) — ending
  // exactly on the wall's inner face plane (x 32) z-fought with it
  addBox(scene, world, 40.5, -0.5, 42, 15, 1, 8, 0x3a3452, { tex: 'panel' });
  addBox(scene, world, 44, -0.5, 24, 8, 1, 28, 0x3a3452, { tex: 'panel' });
  addBox(scene, world, 36.5, 3, 38.3, 7, 6, 0.6, 0x4a4266, { tex: 'neonwall' });
  addBox(scene, world, 40.5, 3, 45.7, 15, 6, 0.6, 0x4a4266, { tex: 'neonwall' });
  addBox(scene, world, 47.7, 3, 28, 0.6, 6, 36, 0x4a4266, { tex: 'neonwall' });
  addBox(scene, world, 40.3, 3, 24, 0.6, 6, 28, 0x4a4266, { tex: 'neonwall' });
  addBox(scene, world, 44, 3, 10.3, 8, 6, 0.6, 0x4a4266, { tex: 'neonwall' });     // gate wall
  addBox(scene, world, 40.5, 6.1, 42, 15, 0.6, 8, 0x3a3452, { tex: 'panel' });     // roofs
  addBox(scene, world, 44, 6.1, 24, 8, 0.6, 28, 0x3a3452, { tex: 'panel' });
  addBox(scene, world, 44, 2.6, 10.9, 5, 4.4, 0.4, 0x8a5fff, { collide: false, shadow: false, emissive: 0x8a5fff, emissiveIntensity: 0.9 });
  makeSign(scene, 44, 5.1, 11.2, 7, '#ff40e0', '? ? ?');
  const sancLight = new THREE.PointLight(0x8a5fff, 20, 16);
  sancLight.position.set(44, 3, 14);
  scene.add(sancLight);

  // grass boulevard + fountain
  addBox(scene, world, 0, 0.06, 14, 12, 0.14, 52, 0x3f7a35, { tex: 'atrium-grass', repeat: [2, 9] });
  addBox(scene, world, 0, 0.45, -22, 16, 0.9, 2, 0x555a74, { tex: 'panel' });   // pool rim
  addBox(scene, world, 0, 0.45, -34, 16, 0.9, 2, 0x555a74, { tex: 'panel' });
  addBox(scene, world, -8, 0.45, -28, 2, 0.9, 14, 0x555a74, { tex: 'panel' });
  addBox(scene, world, 8, 0.45, -28, 2, 0.9, 14, 0x555a74, { tex: 'panel' });
  addWater(scene, world, 0, 0.55, -28, 13.5, 10);
  addBox(scene, world, 0, 1.6, -28, 0.7, 2.6, 0.7, 0x9fd8ff, { collide: false, shadow: false, emissive: 0x9fd8ff, emissiveIntensity: 1.2 }); // jet
  const fLight = new THREE.PointLight(0x9fd8ff, 25, 24);
  fLight.position.set(0, 3, -28);
  scene.add(fLight);

  // multiplayer portal: central always-on lobby entry
  addBox(scene, world, 0, 0.18, 10, 6.4, 0.36, 6.4, 0x141a38, { tex: 'panel' });
  addBox(scene, world, 0, 0.46, 10, 5.2, 0.16, 5.2, 0xffd23c, {
    collide: false, shadow: false, emissive: 0xffd23c, emissiveIntensity: 1.1,
  });
  addBox(scene, world, -3.2, 2.4, 10, 0.35, 4.8, 0.35, 0x30e0ff, {
    collide: false, shadow: false, emissive: 0x30e0ff, emissiveIntensity: 1.2,
  });
  addBox(scene, world, 3.2, 2.4, 10, 0.35, 4.8, 0.35, 0xff40a0, {
    collide: false, shadow: false, emissive: 0xff40a0, emissiveIntensity: 1.2,
  });
  addBox(scene, world, 0, 4.9, 10, 6.8, 0.35, 0.35, 0xffd23c, {
    collide: false, shadow: false, emissive: 0xffd23c, emissiveIntensity: 1.2,
  });
  makeSign(scene, 0, 6.2, 13.4, 12, '#ffd23c', 'MULTIPLAYER');
  world.multiplayerPortal = { x: 0, z: 10 };
  const mpLight = new THREE.PointLight(0xffd23c, 24, 24);
  mpLight.position.set(0, 4, 10);
  scene.add(mpLight);

  // rooftop billboard above the north wall
  makeSign(scene, 0, 15.5, -48.5, 26, '#ff4d2e', 'NERF ARENA BLAST REVIVAL');
  addBox(scene, world, -11, 12.7, -48.5, 0.4, 1.8, 0.4, 0x3a3452);
  addBox(scene, world, 11, 12.7, -48.5, 0.4, 1.8, 0.4, 0x3a3452);

  // gate bays: [map, name, color, wall(n/w/e), offset]
  world.portals = [];
  const bays = [
    ['arena', 'BLAST COMPLEX', 0xd88a2b, 'n', 0],
    ['fortress', 'FORTRESS FALLS', 0x9a6fe0, 'w', 14],
    ['asteroids', 'ASTEROID BELT', 0x8fb8d8, 'w', -14],
    ['canopy', 'CANOPY', 0x4dbf6a, 'e', 14],
    ['city', 'NEON HEIGHTS', 0xff40a0, 'e', -14],
    ['sanctum', 'THE LABYRINTH', 0x8a5fff, 's', 0],  // behind you at spawn
  ];
  for (const [id, name, color, wall, off] of bays) {
    const horiz = wall === 'n' || wall === 's';
    const sgn = (wall === 'e' || wall === 's') ? 1 : -1;
    const px = horiz ? off : sgn * 30.6, pz = horiz ? sgn * 46.6 : off;  // pillar centerline
    const P = (dx, dz, w, h, d) => addBox(scene, world, px + dx, h / 2, pz + dz, w, h, d, 0x4a4266, { tex: 'neonwall' });
    if (horiz) {
      P(-4, 0, 1.6, 7, 1.6); P(4, 0, 1.6, 7, 1.6);
      addBox(scene, world, px, 7.6, pz, 9.6, 1.4, 1.6, 0x4a4266, { tex: 'neonwall' });
      addBox(scene, world, px, 3.2, pz + sgn * 0.9, 7, 6, 0.5, color, { collide: false, shadow: false, emissive: color, emissiveIntensity: 0.85 });
    } else {
      P(0, -4, 1.6, 7, 1.6); P(0, 4, 1.6, 7, 1.6);
      addBox(scene, world, px, 7.6, pz, 1.6, 1.4, 9.6, 0x4a4266, { tex: 'neonwall' });
      addBox(scene, world, px + sgn * 0.9, 3.2, pz, 0.5, 6, 7, color, { collide: false, shadow: false, emissive: color, emissiveIntensity: 0.85 });
    }
    // sign panel flat on the wall above the gate (inner faces: z ±48, x ±32)
    makeSign(scene, horiz ? px : sgn * 31.9, 9.6, horiz ? sgn * 47.95 : pz, 10,
      '#' + color.toString(16).padStart(6, '0'), name,
      horiz ? (sgn === -1 ? 0 : Math.PI) : -sgn * Math.PI / 2);
    const L = new THREE.PointLight(color, 26, 20);
    L.position.set(horiz ? px : px - sgn * 2.5, 4.5, horiz ? pz - sgn * 2.5 : pz);
    scene.add(L);
    world.portals.push({ x: horiz ? px : px + sgn * 0.5, z: horiz ? pz + sgn * 0.5 : pz, map: id, name });
  }
  world.portals.push({ x: 44, z: 11.5, map: 'prism', name: '???' });

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
      '1–7 / wheel — weapons', 'Tab — scoreboard', 'Esc — pause', 'G — toggle glow',
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
  world.setModeSign = makeSign(scene, 11, 3.6, 36.8, 9, '#30e0ff', 'MODE: FREE FOR ALL');

  // a little clutter so it feels lived-in
  addBox(scene, world, -14, 1.2, 30, 2.4, 2.4, 2.4, 0xb0763a, { tex: 'crate' });
  addBox(scene, world, -16.6, 1.2, 31, 2.4, 2.4, 2.4, 0xb0763a, { tex: 'crate' });
  addBox(scene, world, -15, 3.6, 30.4, 2.4, 2.4, 2.4, 0xb0763a, { tex: 'crate' });
  addDecal(scene, 'poster1', -24, 6, -47.94, 8, 0);
  addDecal(scene, 'target', 27, 6, -47.94, 8, 0);
  addDecal(scene, 'hazard', -31.94, 6, 30, 8, Math.PI / 2);
  addDecal(scene, 'hazard', 31.94, 6, -30, 8, -Math.PI / 2);
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
    desc: 'Night rooftops over a denser street canyon: galleria, arcade block, back alleys, subway, and a rideable second-floor monorail loop. Gold on the tallest tower.',
    thumb: 'linear-gradient(135deg,#0b1026,#5a4a78)', build: buildCity },
  { id: 'sanctum', name: 'THE LABYRINTH', emoji: '🔮',
    desc: 'An obsidian temple: rune rooms off a central obelisk chamber, a crypt below, rooftops above.',
    thumb: 'linear-gradient(135deg,#14101f,#8a5fff)', build: buildSanctum },
  { id: 'prism', name: 'PRISM RUN', emoji: '🌈',
    desc: 'Inside a neon tesseract in deep space: walk every wall, floor and ceiling. Gravity always pulls to the nearest surface — you never fall out.',
    thumb: 'linear-gradient(135deg,#0b0518,#ff40e0)', build: buildPrism },
];
