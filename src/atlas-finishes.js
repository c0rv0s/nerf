import * as THREE from "three";
import { EnvironmentBatch } from "./environment-design.js";

const maps = new Map();
export function atlasTexture(id) {
  if (!maps.has(id)) {
    const file =
      id === "leaves" ? "mycelium-leaf-canopy-neutral" : `atlas-${id}`;
    const url = new URL(`../textures/${file}.webp`, import.meta.url);
    const t = new THREE.TextureLoader().load(url.href);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping;
    t.anisotropy = 8;
    maps.set(id, t);
  }
  return maps.get(id);
}

const pigment = (id, color = 0xffffff) =>
  new THREE.MeshBasicMaterial({
    map: atlasTexture(id),
    color,
    side: THREE.DoubleSide,
  });
const bronze = () =>
  new THREE.MeshStandardMaterial({
    color: 0xaf8040,
    metalness: 0.38,
    roughness: 0.54,
  });

function panel(
  batch,
  material,
  x,
  y,
  z,
  width,
  height,
  yaw = 0,
  pitch = 0,
  repeats = 1,
) {
  const g = new THREE.PlaneGeometry(width, height);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setX(i, uv.getX(i) * repeats);
  g.rotateX(pitch);
  g.rotateY(yaw);
  g.translate(x, y, z);
  batch.add(g, material);
}

export function canopyStandards(scene) {
  const dome = new THREE.SphereGeometry(420, 64, 32),
    uv = dome.attributes.uv;
  for (let i = 0; i < uv.count; i++)
    uv.setXY(
      i,
      uv.getX(i) * 2,
      THREE.MathUtils.clamp(0.29 + (uv.getY(i) - 0.5) * 2.15, 0.015, 0.985),
    );
  const horizon = new THREE.Mesh(
    dome,
    new THREE.MeshBasicMaterial({
      map: atlasTexture("woodland"),
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
    }),
  );
  horizon.renderOrder = -100;
  horizon.frustumCulled = false;
  scene.add(horizon);
  const batch = new EnvironmentBatch(scene),
    textile = pigment("canopy"),
    fittings = bronze();
  function drape(x, y, z, yaw, w, h) {
    const g = new THREE.PlaneGeometry(w, h, 12, 3),
      p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const u = p.getX(i) / w,
        v = 0.5 - p.getY(i) / h;
      p.setXYZ(
        i,
        u * w,
        p.getY(i) - v * (1 - Math.abs(2 * u)) * 0.23 * h,
        Math.sin(u * 13) * (0.07 + v * 0.13),
      );
    }
    g.computeVertexNormals();
    g.rotateY(yaw);
    g.translate(x, y - h / 2, z);
    batch.add(g, textile);
    batch.box(x, y + 0.05, z, w + 0.5, 0.15, 0.17, fittings, yaw);
  }
  for (let i = 0; i < 4; i++) {
    const yaw = (i * Math.PI) / 2,
      nx = Math.sin(yaw),
      nz = Math.cos(yaw);
    for (const [top, r, w, h] of [
      [29.7, 12.14, 6.8, 2.9],
      [23.75, 10.14, 4, 2.1],
      [15.75, 10.14, 4, 2.1],
    ]) {
      drape(nx * r, top, nz * r, yaw, w, h);
    }
    for (const s of [-1, 1]) {
      const dx = Math.cos(yaw) * s * 5.7,
        dz = -Math.sin(yaw) * s * 5.7;
      const x = nx * 8 + dx,
        z = nz * 8 + dz;
      batch.box(x, 32.2, z, 0.14, 4.4, 0.14, fittings);
      drape(
        x + 0.95 * Math.cos(yaw),
        34.4,
        z - 0.95 * Math.sin(yaw),
        yaw,
        1.8,
        2.5,
      );
    }
  }
  for (const x of [-45, 45])
    for (const z of [-45, 45]) {
      drape(x, 34.2, z + Math.sign(z) * 8.6 - Math.sign(z) * 3.62, 0, 6.5, 2.6);
      drape(x, 29.75, z - Math.sign(z) * 13.12, 0, 5.6, 3);
    }
  batch.flush("canopy-woven-council-standards");
}

export function sanctumCarvings(scene) {
  const batch = new EnvironmentBatch(scene),
    relief = pigment("sanctum", 0xc2aada);
  const edge = new THREE.MeshBasicMaterial({ color: 0x765294 });
  for (let i = 0; i < 4; i++) {
    const yaw = (i * Math.PI) / 2,
      nx = Math.sin(yaw),
      nz = Math.cos(yaw);
    for (const side of [-1, 1])
      for (const [r, y, w, h] of [
        [17.32, 2.85, 13.6, 4.15],
        [18.67, 2.6, 12.6, 3.35],
      ]) {
        const x = nx * r + side * 10 * nz,
          z = nz * r - side * 10 * nx;
        panel(batch, relief, x, y, z, w, h, yaw, 0, 3);
        for (const s of [-1, 1])
          batch.box(
            x,
            y + s * (h / 2 + 0.08),
            z,
            w + 0.2,
            0.08,
            0.12,
            edge,
            yaw,
          );
      }
  }
  // Engrave the four dais stones without covering the shaft.
  for (let i = 0; i < 4; i++) {
    const yaw = (i * Math.PI) / 2;
    panel(
      batch,
      relief,
      Math.sin(yaw) * 3.77,
      0.622,
      Math.cos(yaw) * 3.77,
      4.8,
      2.15,
      yaw,
      -Math.PI / 2,
      2,
    );
  }
  batch.flush("sanctum-cut-silver-reliefs");
}

export function hallMosaics(scene) {
  const batch = new EnvironmentBatch(scene),
    mosaic = pigment("hall"),
    metal = bronze();
  mosaic.polygonOffset = true;
  mosaic.polygonOffsetFactor = -3;
  mosaic.polygonOffsetUnits = -12;
  for (let z = -72; z <= 90; z += 18) {
    panel(batch, mosaic, 0, 0.215, z, 7, 7, 0, -Math.PI / 2);
    for (const s of [-1, 1]) {
      panel(
        batch,
        mosaic,
        s * 32.92,
        23.6,
        z - 8,
        7.5,
        7.5,
        (-s * Math.PI) / 2,
      );
      batch.box(s * 32.88, 27.6, z - 8, 0.15, 0.19, 8, metal);
    }
  }
  for (const x of [-4.25, 4.25]) batch.box(x, 0.188, 0, 0.1, 0.02, 208, metal);
  for (const x of [-22.5, 22.5]) panel(batch, mosaic, x, 35, -110.86, 9, 9);
  batch.flush("hall-laurel-mosaics");
}

export function solarInstruments(scene) {
  const batch = new EnvironmentBatch(scene),
    screens = pigment("solar"),
    copper = bronze();
  // Screens fit the solid returns either side of doors and glazing.
  for (const [x, y, z, yaw, w, h] of [
    [-8, 3.5, 13.42, Math.PI, 9.6, 4],
    [15.44, 3.4, 1, -Math.PI / 2, 9, 3.7],
    [34, 3.1, 14.58, 0, 8.8, 3.1],
    [54.42, 10.6, 6.6, -Math.PI / 2, 5.2, 3.6],
    [35.4, 10.7, 11.42, Math.PI, 5.8, 3.25],
  ]) {
    panel(batch, screens, x, y, z, w, h, yaw);
    for (const s of [-1, 1])
      batch.box(
        x,
        y + s * (h / 2 + 0.095),
        z,
        w + 0.2,
        0.14,
        0.13,
        copper,
        yaw,
      );
  }
  batch.flush("solar-heliograph-instruments");
}

export function olympusFrescoes(scene) {
  const batch = new EnvironmentBatch(scene),
    fresco = pigment("olympus");
  for (const s of [-1, 1]) {
    // Broad wall bays below the cornice; leave doors and climbing vines open.
    for (const z of [-14, 14]) {
      panel(
        batch,
        fresco,
        s * 24.43,
        70,
        z + (s * z < 0 ? 0 : 1),
        9.5,
        4.2,
        (-s * Math.PI) / 2,
        0,
        2,
      );
    }
    panel(batch, fresco, s * 15, 72.2, -28.44, 17.6, 5.2, 0, 0, 3);
    for (const [a, b] of [
      [-20, (s < 0 ? 12 : -12) - 2.1],
      [(s < 0 ? 12 : -12) + 2.1, 20],
    ]) {
      panel(
        batch,
        fresco,
        s * 21.41,
        73.71,
        (a + b) / 2,
        b - a,
        0.67,
        (-s * Math.PI) / 2,
        0,
        Math.ceil((b - a) / 4),
      );
    }
    for (const x of [-20.5, 20.5]) {
      panel(batch, fresco, x, 90, 24 + s * 16.04, 23, 0.94, 0, 0, 5);
      if (s === 1)
        panel(batch, fresco, x, 89.46, 24, 22.5, 31.5, 0, Math.PI / 2, 3);
    }
    panel(batch, fresco, 0, 74.9, 62 + s * 1.54, 24.6, 1.6, 0, 0, 5);
  }
  for (const [x, z, w, d, y] of [
    [18, -8, 24, 18, 18],
    [-8, 0, 28, 22, 40],
  ]) {
    for (const s of [-1, 1])
      panel(
        batch,
        fresco,
        x,
        y - 0.44,
        z + s * (d / 2 + 0.04),
        w,
        0.78,
        0,
        0,
        5,
      );
  }
  batch.flush("olympus-griffin-friezes");
}
