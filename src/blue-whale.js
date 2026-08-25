import * as THREE from 'three';

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
export const buildBlueWhale = () => {
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

