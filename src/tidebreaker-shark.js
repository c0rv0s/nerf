import * as THREE from 'three';

// Shared exact Tidebreaker great-white model. Reef boundary sharks use this
// builder so their silhouette, coloring, teeth, gills, and animated fin pivots
// remain identical to the original map.
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
export const buildTidebreakerShark = () => {
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

