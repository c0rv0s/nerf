// Authored environment geometry. Repeated details are baked into material
// batches; collision is built from the same closed surfaces by the map builder.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
const V = (x, y, z) => new THREE.Vector3(x, y, z);

export class EnvironmentBatch {
  constructor(scene) {
    this.scene = scene;
    this.groups = new Map();
  }
  add(geometry, material, matrix = null) {
    if (matrix) geometry.applyMatrix4(matrix);
    if (geometry.index) {
      const indexed = geometry;
      geometry = geometry.toNonIndexed();
      indexed.dispose();
    }
    let group = this.groups.get(material);
    if (!group) this.groups.set(material, (group = []));
    group.push(geometry);
  }
  beam(a, b, radius, material, sides = 6) {
    const delta = b.clone().sub(a);
    const g = new THREE.CylinderGeometry(radius, radius, delta.length(), sides);
    g.applyQuaternion(
      new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), delta.normalize()),
    );
    g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    this.add(g, material);
  }
  box(x, y, z, w, h, d, material, yaw = 0) {
    const g = new THREE.BoxGeometry(w, h, d);
    g.rotateY(yaw);
    g.translate(x, y, z);
    this.add(g, material);
  }
  flush(name) {
    for (const [material, geometries] of this.groups) {
      const mesh = new THREE.Mesh(mergeGeometries(geometries, false), material);
      mesh.name = name;
      mesh.castShadow = mesh.receiveShadow = true;
      this.scene.add(mesh);
      geometries.forEach((g) => g.dispose());
    }
    this.groups.clear();
  }
}

// A closed curved slab, with a stable winding for concave banks and bridges.
// crossSection(t) returns its left/right XZ edges and their upper elevations.
export function ribbonSolid(crossSection, segments, bottomDepth = 0.35) {
  const positions = [],
    uvs = [];
  const quad = (a, b, c, d) => {
    for (const p of [a, b, c, a, c, d]) {
      positions.push(...p);
      uvs.push(p[0] * 0.18, p[2] * 0.18);
    }
  };
  let prev;
  for (let i = 0; i <= segments; i++) {
    const section = crossSection(i / segments);
    const top = section.middle
      ? [section.left, section.middle, section.right]
      : [section.left, section.right];
    const bottom = (p) =>
      typeof bottomDepth === "function" ? bottomDepth(p) : p[1] - bottomDepth;
    const low = top.map((p) => [p[0], bottom(p), p[2]]);
    if (prev) {
      for (let j = 0; j < top.length - 1; j++) {
        quad(prev.top[j], top[j], top[j + 1], prev.top[j + 1]);
        quad(prev.low[j], prev.low[j + 1], low[j + 1], low[j]);
      }
      quad(prev.top[0], prev.low[0], low[0], top[0]);
      const last = top.length - 1;
      quad(prev.top[last], top[last], low[last], prev.low[last]);
    } else
      for (let j = 0; j < top.length - 1; j++)
        quad(top[j], top[j + 1], low[j + 1], low[j]);
    prev = { top, low };
  }
  for (let j = 0; j < prev.top.length - 1; j++)
    quad(prev.top[j], prev.low[j], prev.low[j + 1], prev.top[j + 1]);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.computeVertexNormals();
  return g;
}

export function timberSpan(batch, start, end, width, materials, sag = 0.8) {
  const dx = end.x - start.x,
    dz = end.z - start.z,
    length = Math.hypot(dx, dz);
  const nx = dz / length,
    nz = -dx / length,
    yaw = Math.atan2(dx, dz);
  const at = (t, side = 0, raise = 0) =>
    V(
      start.x + dx * t + nx * side,
      start.y + (end.y - start.y) * t - Math.sin(Math.PI * t) * sag + raise,
      start.z + dz * t + nz * side,
    );
  const steps = Math.ceil(length / 0.72);
  // Gaps are a dark inlay in one solid walking surface, not physical holes.
  const deck = ribbonSolid(
    (t) => ({
      left: at(t, -width / 2).toArray(),
      right: at(t, width / 2).toArray(),
    }),
    steps,
    0.32,
  );
  batch.add(deck.clone(), materials.wood);
  for (let i = 1; i < steps; i++) {
    const c = at(i / steps, 0, 0.009);
    batch.box(c.x, c.y, c.z, width, 0.018, 0.024, materials.dark, yaw);
  }
  for (const side of [-1, 1]) {
    const count = Math.ceil(length / 4.5);
    for (let i = 0; i <= count; i++) {
      const t = i / count,
        foot = at(t, side * (width / 2 - 0.16), -0.38);
      batch.beam(
        foot,
        at(t, side * (width / 2 - 0.16), 1.35),
        0.095,
        materials.wood,
      );
    }
    for (const raise of [0.62, 1.32]) {
      let prev = at(0, side * (width / 2 - 0.16), raise);
      for (let i = 1; i <= count * 3; i++) {
        const cur = at(i / (count * 3), side * (width / 2 - 0.16), raise);
        batch.beam(prev, cur, 0.045, materials.rope, 5);
        prev = cur;
      }
    }
    // Underslung stringers support the plank surface along the full span.
    let prev = at(0, side * (width / 2 - 0.42), -0.4);
    for (let i = 1; i <= count; i++) {
      const cur = at(i / count, side * (width / 2 - 0.42), -0.4);
      batch.beam(prev, cur, 0.16, materials.dark);
      prev = cur;
    }
  }
  return { geometry: deck, at, length };
}

export function livingTrunkGeometry(radius, height, seed = 0) {
  const g = new THREE.CylinderGeometry(radius * 0.74, radius, height, 16, 8);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i),
      t = (y + height / 2) / height,
      x = p.getX(i),
      z = p.getZ(i);
    const angle = Math.atan2(z, x);
    const buttress =
      1 + 0.2 * Math.pow(1 - t, 5) * (0.5 + 0.5 * Math.cos(angle * 5 + seed));
    const flute = 1 + 0.035 * Math.sin(angle * 8 + seed);
    p.setXYZ(
      i,
      x * buttress * flute + Math.sin(t * 2.4 + seed) * t * 0.42,
      y,
      z * buttress * flute,
    );
  }
  g.computeVertexNormals();
  return g;
}

// The old channel envelope and tunnel mouths stay open. Banks alternate in
// width to make pools and gravel tongues, while leaving a continuous swim lane.
export function canopyRiverOffset(z, center) {
  const clearance = Math.min(
    ...[-80, -50, -40, -6, 14, 30, 40, 52, 64, 80].map((v) => Math.abs(z - v)),
  );
  const blend = THREE.MathUtils.smoothstep(clearance, 0, 7);
  return Math.sin(z * 0.043 + Math.sign(center) * 1.8) * 3.2 * blend;
}

export function canopyBankSection(center, side, z) {
  const mouth = Math.max(0, 1 - Math.abs(z - 64) / 8);
  const crossing = Math.max(0, 1 - Math.abs(z + 40) / 7);
  const exit = Math.max(
    0,
    1 - Math.min(Math.abs(z - 30), Math.abs(z + 50)) / 5,
  );
  const clear = Math.max(mouth, crossing, exit);
  const width =
    (1.6 +
      0.75 * Math.sin(z * 0.071 + side * 1.7) +
      0.36 * Math.sin(z * 0.19)) *
      (1 - clear) +
    0.35 * clear;
  const outer = center + side * 4 + canopyRiverOffset(z, center);
  const inner = outer - side * width;
  return { outer, inner };
}

// Bake unique reef plants into spatial batches. The GPU rotates each plant
// around its own root, including the shadow pass, instead of updating and
// submitting a separate Object3D for every little cluster each frame.
export function batchReefGrowth(scene, clusters, anim) {
  const time = { value: 0 };
  const groups = new Map();
  const owned = [];
  const vertexHeader = `uniform float reefTime;
    attribute vec3 reefPivot;
    attribute vec2 reefMotion;
    mat3 reefRotation() {
      float ax = sin(reefTime * .72 + reefMotion.x) * reefMotion.y * .55;
      float az = sin(reefTime * .58 + reefMotion.x * 1.37) * reefMotion.y;
      float cx = cos(ax), sx = sin(ax), cz = cos(az), sz = sin(az);
      return mat3(cz,sz*cx,sz*sx, -sz,cz*cx,cz*sx, 0.,-sx,cx);
    }`;
  const patch = (shader) => {
    shader.uniforms.reefTime = time;
    shader.vertexShader = vertexHeader + "\n" + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      "#include <begin_vertex>\ntransformed = reefPivot + reefRotation() * (transformed - reefPivot);",
    );
    shader.vertexShader = shader.vertexShader.replace(
      "#include <beginnormal_vertex>",
      "#include <beginnormal_vertex>\nobjectNormal = reefRotation() * objectNormal;",
    );
  };
  for (const cluster of clusters) {
    const { root, phase, sway } = cluster,
      source = root.children[0];
    root.updateMatrixWorld(true);
    const key =
      source.material.uuid +
      ":" +
      Math.floor(root.position.x / 56) +
      ":" +
      Math.floor(root.position.z / 56);
    let bucket = groups.get(key);
    if (!bucket)
      groups.set(key, (bucket = { material: source.material, geometries: [] }));
    const geometry = source.geometry.clone().applyMatrix4(source.matrixWorld);
    const count = geometry.attributes.position.count;
    const pivots = new Float32Array(count * 3),
      motion = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) {
      pivots.set(root.position.toArray(), i * 3);
      motion.set([phase, sway], i * 2);
    }
    geometry.setAttribute("reefPivot", new THREE.BufferAttribute(pivots, 3));
    geometry.setAttribute("reefMotion", new THREE.BufferAttribute(motion, 2));
    bucket.geometries.push(geometry);
    scene.remove(root);
    source.geometry.dispose();
  }
  for (const { material, geometries } of groups.values()) {
    const geometry = mergeGeometries(geometries, false);
    geometry.computeBoundingBox();
    geometry.boundingBox.expandByScalar(0.5);
    geometry.computeBoundingSphere();
    geometry.boundingSphere.radius += 0.5;
    const animated = material.clone();
    animated.onBeforeCompile = patch;
    animated.customProgramCacheKey = () => "reef-root-sway-v1";
    const mesh = new THREE.Mesh(geometry, animated);
    mesh.name = "reef-batched-swaying-growth";
    mesh.castShadow = true;
    mesh.customDepthMaterial = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
    });
    mesh.customDepthMaterial.onBeforeCompile = patch;
    mesh.customDepthMaterial.customProgramCacheKey = () =>
      "reef-root-sway-depth-v1";
    mesh.customDistanceMaterial = new THREE.MeshDistanceMaterial();
    mesh.customDistanceMaterial.onBeforeCompile = patch;
    mesh.customDistanceMaterial.customProgramCacheKey = () =>
      "reef-root-sway-distance-v1";
    scene.add(mesh);
    owned.push(mesh);
    geometries.forEach((g) => g.dispose());
  }
  anim.push((_dt, t) => {
    time.value = t;
  });
  return {
    plants: clusters.length,
    batches: groups.size,
    dispose() {
      for (const mesh of owned) {
        mesh.geometry.dispose();
        mesh.material.dispose();
        mesh.customDepthMaterial.dispose();
        mesh.customDistanceMaterial.dispose();
      }
    },
  };
}

export function olympusMountainGeometry(x, z, width, depth) {
  const g = new THREE.BoxGeometry(
    width,
    60,
    depth,
    Math.ceil(width / 7),
    10,
    Math.ceil(depth / 7),
  );
  const p = g.attributes.position;
  const protect = (u, anchors) =>
    Math.min(1, ...anchors.map((a) => Math.max(0, (Math.abs(u - a) - 5) / 10)));
  for (let i = 0; i < p.count; i++) {
    let px = p.getX(i) + x,
      py = p.getY(i) + 30,
      pz = p.getZ(i) + z;
    const vertical = Math.sin((Math.PI * py) / 60);
    const fold = (u) =>
      3.5 + 3 * Math.sin(u * 0.15) + 1.7 * Math.sin(u * 0.43 + py * 0.04);
    if (Math.abs(px) > 87.9) {
      const sign = Math.sign(px);
      const keep = protect(pz, sign < 0 ? [-38, 28] : [34, 28, 54, 65]);
      px += sign * vertical * Math.max(0.5, fold(pz)) * keep;
    }
    if (Math.abs(pz) > 87.9) {
      const sign = Math.sign(pz);
      const keep = protect(px, sign < 0 ? [0, 34] : [-30, 0]);
      pz += sign * vertical * Math.max(0.5, fold(px)) * keep;
    }
    p.setXYZ(i, px, py, pz);
  }
  g.computeVertexNormals();
  return g;
}

// One continuous distant landform, so the basin does not end at the square
// edge of the recovery floor or sit inside a ring of disconnected rock props.
export function martianHorizonGeometry() {
  const positions = [],
    colors = [],
    indices = [];
  const sectors = 112,
    rings = 22;
  const low = new THREE.Color(0x704535),
    high = new THREE.Color(0xa4785b);
  for (let ring = 0; ring <= rings; ring++)
    for (let i = 0; i <= sectors; i++) {
      const a = (i / sectors) * Math.PI * 2;
      const inner =
        430 / Math.max(Math.abs(Math.cos(a)), Math.abs(Math.sin(a)));
      const t = ring / rings,
        radius = inner + (1100 - inner) * t;
      const ridgeRadius = 680 + 58 * Math.sin(a * 3) + 27 * Math.sin(a * 7);
      const ridge = Math.exp(
        -Math.pow((radius - ridgeRadius) / (65 + 15 * Math.sin(a * 5)), 2),
      );
      const skyline = 57 + 23 * Math.sin(a * 4 + 0.6) + 18 * Math.cos(a * 9);
      const foothills = Math.sin(radius * 0.026 + Math.sin(a * 6)) * 7;
      const y =
        -2.4 +
        Math.sin((Math.min(1, t * 5) * Math.PI) / 2) *
          (ridge * skyline + foothills);
      positions.push(Math.cos(a) * radius, y, Math.sin(a) * radius);
      const c = low.clone().lerp(high, THREE.MathUtils.clamp(y / 90, 0, 1));
      colors.push(c.r, c.g, c.b);
      if (ring < rings && i < sectors) {
        const n = ring * (sectors + 1) + i,
          next = n + sectors + 1;
        indices.push(n, n + 1, next, n + 1, next + 1, next);
      }
    }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

// Broad living limbs retain a level crown while their edges and undersides
// taper organically. The same closed mesh provides the walking surface.
export function livingLimbGeometry(
  start,
  end,
  width,
  depth,
  startInset = 0,
  endInset = 0,
) {
  const delta = end.clone().sub(start),
    length = Math.hypot(delta.x, delta.z);
  const right = V(delta.z / length, 0, -delta.x / length),
    positions = [],
    uvs = [];
  const steps = Math.max(8, Math.ceil(length / 1.5)),
    sides = 16;
  const at = (t, i) => {
    const angle = (i / sides) * Math.PI * 2;
    const blend = Math.sin(Math.PI * t);
    const across =
      Math.sin(angle) * width * 0.5 * (1 + 0.07 * Math.sin(t * 9) * blend);
    const crownY = start.y + delta.y * t;
    const inset = Math.min(
      t * length - startInset,
      (1 - t) * length - endInset,
    );
    const y =
      crownY -
      (inset < 0 ? 0.09 : 0) -
      (Math.cos(angle) >= 0
        ? 0.1 * Math.sin(angle) ** 2
        : depth * Math.sqrt(-Math.cos(angle)));
    return [
      start.x + delta.x * t + right.x * (across + 0.35 * blend),
      y,
      start.z + delta.z * t + right.z * (across + 0.35 * blend),
    ];
  };
  const tri = (a, b, c) => {
    for (const p of [a, b, c]) {
      positions.push(...p);
      uvs.push(p[0] * 0.22, p[2] * 0.22);
    }
  };
  for (let j = 0; j < steps; j++)
    for (let i = 0; i < sides; i++) {
      const a = at(j / steps, i),
        b = at((j + 1) / steps, i),
        c = at((j + 1) / steps, i + 1),
        d = at(j / steps, i + 1);
      tri(a, b, c);
      tri(a, c, d);
    }
  for (let i = 1; i < sides - 1; i++) {
    tri(at(0, 0), at(0, i), at(0, i + 1));
    tri(at(1, 0), at(1, i + 1), at(1, i));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.computeVertexNormals();
  return g;
}

export function roundedDeckGeometry(width, depth, height, bevel = 0.5) {
  const shape = new THREE.Shape(),
    x = width / 2,
    z = depth / 2,
    r = Math.min(bevel, x * 0.6, z * 0.6);
  shape.moveTo(-x + r, -z);
  shape.lineTo(x - r, -z);
  shape.quadraticCurveTo(x, -z, x, -z + r);
  shape.lineTo(x, z - r);
  shape.quadraticCurveTo(x, z, x - r, z);
  shape.lineTo(-x + r, z);
  shape.quadraticCurveTo(-x, z, -x, z - r);
  shape.lineTo(-x, -z + r);
  shape.quadraticCurveTo(-x, -z, -x + r, -z);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: height,
    bevelEnabled: false,
    curveSegments: 4,
  });
  g.rotateX(-Math.PI / 2);
  return g;
}

// One closed rock body, with a broad flat landing crown and fractured flanks.
// Ring vertices are shared spatially, so the top never separates from its keel.
export function asteroidBodyGeometry(width, depth, seed = 1) {
  const sides = 28,
    positions = [],
    uv = [];
  const height = Math.max(3.8, Math.min(12, Math.min(width, depth) * 0.68));
  const triangle = (a, b, c) => {
    const ab = b.map((v, i) => v - a[i]),
      ac = c.map((v, i) => v - a[i]);
    const n = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ].map(Math.abs);
    const axes =
      n[1] >= n[0] && n[1] >= n[2] ? [0, 2] : n[0] > n[2] ? [2, 1] : [0, 1];
    for (const p of [a, b, c]) {
      positions.push(...p);
      uv.push(p[axes[0]] * 0.22, p[axes[1]] * 0.22);
    }
  };
  const quad = (a, b, c, d) => {
    triangle(a, b, c);
    triangle(a, c, d);
  };
  const outline = (i) => {
    const t = (i / sides) * Math.PI * 2,
      c = Math.cos(t),
      s = Math.sin(t);
    const n =
      1 + 0.035 * Math.sin(i * 2.3 + seed) + 0.018 * Math.cos(i * 4.2 - seed);
    return [
      Math.sign(c) * Math.abs(c) ** 0.55 * width * 0.5 * n,
      Math.sign(s) * Math.abs(s) ** 0.55 * depth * 0.5 * n,
    ];
  };
  const rings = [
    [1, 0],
    [1.045, -0.65],
    [0.9, -height * 0.47],
    [0.58, -height * 0.86],
    [0.19, -height],
  ].map(([scale, y], r) =>
    Array.from({ length: sides }, (_, i) => {
      const p = outline(i),
        shear = r * 0.19 * Math.sin(seed);
      if (r > 1) {
        const fracture = 1 + 0.12 * Math.sin(i * 1.9 + seed + r * 0.8);
        p[0] *= fracture;
        p[1] *= fracture;
      }
      return [
        p[0] * scale + shear,
        y + (r > 1 ? 0.3 * Math.sin(i * 1.7 + seed) : 0),
        p[1] * scale - r * 0.08 * Math.cos(seed),
      ];
    }),
  );
  for (let i = 0; i < sides; i++) {
    const next = (i + 1) % sides;
    triangle([0, 0, 0], rings[0][next], rings[0][i]);
    for (let r = 1; r < rings.length; r++)
      quad(rings[r - 1][i], rings[r - 1][next], rings[r][next], rings[r][i]);
    triangle(rings.at(-1)[i], rings.at(-1)[next], [0, -height - 0.8, 0]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  return g;
}
