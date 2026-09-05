import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { EnvironmentBatch, ribbonSolid } from "./environment-design.js";
import { orreryPose, orreryRideDelta, onOrreryDeck } from "./orrery-motion.js";
const TAU = Math.PI * 2,
  V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const polar = (r, a, y = 0) => V(r * Math.cos(a), y, r * Math.sin(a));

function surfaceTexture(kind) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 512;
  const g = canvas.getContext("2d");
  g.fillStyle = kind === "floor" ? "#bec7c3" : "#e5e1d2";
  g.fillRect(0, 0, 512, 512);
  let seed = 41;
  const rnd = () =>
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let i = 0; i < 12000; i++) {
    g.fillStyle = `rgba(34,53,53,${rnd() * 0.075})`;
    g.fillRect(rnd() * 512, rnd() * 512, 1 + rnd() * 3, 1 + rnd() * 2);
  }
  g.lineWidth = 2;
  g.strokeStyle = kind === "floor" ? "#7d8c87" : "#abae9f";
  for (let y = 0; y <= 512; y += 128) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(512, y);
    g.stroke();
    for (let x = ((y / 128) % 2) * 128; x < 512; x += 256) {
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x, y + 128);
      g.stroke();
    }
  }
  if (kind === "floor") {
    g.strokeStyle = "#cdb47b";
    g.lineWidth = 4;
    g.strokeRect(12, 12, 488, 488);
    g.strokeStyle = "#596e6b";
    g.lineWidth = 1;
    g.strokeRect(19, 19, 474, 474);
    for (const [x, y] of [
      [0, 0],
      [512, 0],
      [0, 512],
      [512, 512],
    ]) {
      g.beginPath();
      g.arc(x, y, 46, 0, TAU);
      g.stroke();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  return texture;
}
function annulus(
  inner,
  outer,
  y,
  depth = 1,
  start = 0,
  end = TAU,
  segments = 128,
) {
  return ribbonSolid(
    (t) => {
      const a = start + (end - start) * t;
      return {
        left: polar(inner, a, y).toArray(),
        right: polar(outer, a, y).toArray(),
      };
    },
    segments,
    depth,
  );
}
function prism(outline, holes, y, depth) {
  const shape = new THREE.Shape(
    outline.map(([x, z]) => new THREE.Vector2(x, -z)),
  );
  for (const points of holes)
    shape.holes.push(
      new THREE.Path(points.map(([x, z]) => new THREE.Vector2(x, -z))),
    );
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: false,
    steps: 1,
  });
  g.rotateX(-Math.PI / 2);
  g.translate(0, y - depth, 0);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++)
    uv.setXY(i, uv.getX(i) * 0.12, uv.getY(i) * 0.12);
  return g;
}
function archGeometry(width, rise, spring, thickness, depth) {
  const shape = new THREE.Shape();
  for (let i = 0; i <= 24; i++) {
    const a = Math.PI - (i * Math.PI) / 24,
      x = (Math.cos(a) * width) / 2,
      y = spring + Math.sin(a) * rise;
    i ? shape.lineTo(x, y) : shape.moveTo(x, y);
  }
  for (let i = 24; i >= 0; i--) {
    const a = Math.PI - (i * Math.PI) / 24;
    shape.lineTo(
      Math.cos(a) * (width / 2 - thickness),
      spring + Math.sin(a) * (rise - thickness),
    );
  }
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  g.translate(0, 0, -depth / 2);
  return g;
}

export function buildOrrery(scene, kit) {
  const {
    newWorld,
    mat,
    addRamp,
    wp,
    pk,
    mergeStatic,
    triangleMeshColliderFromMesh,
    aiTex,
  } = kit;
  const world = newWorld({
    gravity: 23,
    jumpVel: 9.4,
    playerSpeed: 11.5,
    killY: -32,
    waypointLinkDist: 16,
    waypointLinkDy: 3.6,
    availableWeapons: [
      "blaster",
      "scatter",
      "pulsar",
      "sidewinder",
      "zooka",
      "hyper",
      "parasite",
      "whomper",
    ],
  });
  world.orreryRoutes = [];
  world.orreryLandmarks = [];
  world.toneMappingExposure = 1.05;
  scene.background = new THREE.Color(0x0b2435);
  scene.fog = new THREE.Fog(0x123b47, 105, 320);
  let stormSky;
  const skyMap = aiTex("orrery-storm").map;
  if (skyMap) {
    skyMap.wrapS = THREE.RepeatWrapping;
    skyMap.wrapT = THREE.ClampToEdgeWrapping;
    skyMap.repeat.set(1, 1);
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(440, 48, 24),
      new THREE.MeshBasicMaterial({
        map: skyMap,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      }),
    );
    sky.rotation.y = 0.8;
    sky.name = "orrery-storm-sky";
    scene.add(sky);
    stormSky = sky;
  }
  scene.add(new THREE.HemisphereLight(0xb3e7e7, 0x67837d, 2.15));
  scene.add(new THREE.AmbientLight(0xc7d8c7, 0.7));
  if (skyMap) {
    const reflection = skyMap.clone();
    reflection.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = reflection;
  }
  const sun = new THREE.DirectionalLight(0xffe0af, 3.2);
  sun.position.set(-70, 110, 40);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, {
    left: -75,
    right: 75,
    top: 75,
    bottom: -75,
    near: 10,
    far: 220,
  });
  sun.shadow.bias = -0.00015;
  sun.shadow.normalBias = 0.2;
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0x63bfd1, 1.4);
  fill.position.set(60, 35, -70);
  scene.add(fill);
  const stoneMap = surfaceTexture("stone"),
    floorMap = surfaceTexture("floor");
  const materials = {
    stone: new THREE.MeshStandardMaterial({
      color: 0xc5cabe,
      map: stoneMap,
      roughness: 0.88,
    }),
    floor: new THREE.MeshStandardMaterial({
      color: 0x687f7a,
      map: floorMap,
      roughness: 0.8,
    }),
    dark: mat(0x183841, { roughness: 0.75, metalness: 0.18 }),
    brass: mat(0xb79750, { roughness: 0.39, metalness: 0.65 }),
    copper: mat(0x75553d, { roughness: 0.62, metalness: 0.4 }),
    book: mat(0x294a54, { roughness: 0.93 }),
    red: mat(0x8b5348, { roughness: 0.9 }),
    light: new THREE.MeshBasicMaterial({ color: 0xc3f5dc, toneMapped: false }),
    warm: new THREE.MeshBasicMaterial({ color: 0xf8cd86, toneMapped: false }),
  };
  const { stone, floor, dark, brass, copper, book, red, light, warm } =
    materials;
  const batch = new EnvironmentBatch(scene);
  const solid = (
    geometry,
    material,
    name = "orrery-structure",
    target = batch,
  ) => {
    const mesh = new THREE.Mesh(geometry, material);
    world.colliders.push(triangleMeshColliderFromMesh(mesh, name, true));
    target.add(geometry, material);
    return mesh;
  };
  const box = (
    x,
    y,
    z,
    w,
    h,
    d,
    m = stone,
    collide = true,
    yaw = 0,
    target = batch,
  ) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.rotateY(yaw);
    g.translate(x, y, z);
    if (collide) solid(g, m, "orrery-solid", target);
    else target.add(g, m);
  };
  const cylinder = (x, base, z, r, height, m = stone, rTop = r) => {
    const g = new THREE.CylinderGeometry(rTop, r, height, 12);
    g.translate(x, base + height / 2, z);
    solid(g, m);
  };
  const route = (points) => {
    world.orreryRoutes.push(points);
    for (const p of points) wp(world, ...p);
    for (let i = 1; i < points.length; i++)
      world.manualLinks.push([...points[i - 1], ...points[i]]);
  };
  const band = (r, y, width, material, start = 0, end = TAU, target = batch) =>
    target.add(
      annulus(
        r - width / 2,
        r + width / 2,
        y,
        0.025,
        start,
        end,
        Math.ceil(((end - start) * r) / 1.8),
      ),
      material,
    );
  const column = (x, z, base, height, r = 0.62) => {
    const parts = [];
    for (const [radius, h, cy, rt] of [
      [r * 1.65, 0.55, 0.275, r * 1.65],
      [r, height - 1.2, height / 2 - 0.05, r * 0.85],
      [r * 1.55, 0.65, height - 0.325, r * 1.55],
    ]) {
      const g = new THREE.CylinderGeometry(rt, radius, h, 12);
      g.translate(x, base + cy, z);
      parts.push(g);
    }
    const g = mergeGeometries(parts, false);
    parts.forEach((p) => p.dispose());
    solid(g, stone, "orrery-column");
    for (const y of [0.58, height - 0.68]) {
      const collar = new THREE.CylinderGeometry(r * 1.15, r * 1.15, 0.12, 12);
      collar.translate(x, base + y, z);
      batch.add(collar, brass);
    }
  };
  const sign = (text, x, y, z, width, yaw = 0, color = "#cde6d9") => {
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 160;
    const g = canvas.getContext("2d");
    g.fillStyle = "#102c35";
    g.fillRect(0, 0, 1024, 160);
    g.strokeStyle = "#b79a60";
    g.lineWidth = 4;
    g.strokeRect(10, 10, 1004, 140);
    g.fillStyle = color;
    g.font = "54px Georgia";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(text, 512, 84, 930);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(width, (width * 160) / 1024),
      new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }),
    );
    mesh.position.set(x, y, z);
    mesh.rotation.y = yaw;
    scene.add(mesh);
    return mesh;
  };
  const octagon = [
    [-16, -11],
    [-11, -16],
    [11, -16],
    [16, -11],
    [16, 11],
    [11, 16],
    [-11, 16],
    [-16, 11],
  ];
  solid(prism(octagon, [], 0, 2.5), floor, "orrery-sanctuary-floor");
  const upperHole = [
    [-12, -10],
    [12, -10],
    [12, 9],
    [8, 9],
    [8, 10],
    [-8, 10],
    [-8, 9],
    [-12, 9],
  ];
  solid(prism(octagon, [upperHole], 10, 0.8), floor, "orrery-upper-gallery");
  // Four axial thresholds continue out of the octagonal gallery to the moving deck.
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2,
      p = polar(18, a, 9.6);
    box(p.x, p.y, p.z, 4, 0.8, 6, brass, true, -a);
    const bridgeCenter = polar(29.5, a, -0.65);
    box(
      bridgeCenter.x,
      bridgeCenter.y,
      bridgeCenter.z,
      27,
      1.3,
      7,
      floor,
      true,
      -a,
    );
    route([
      polar(13, a, 0.05).toArray(),
      polar(22, a, 0.05).toArray(),
      polar(33, a, 0.05).toArray(),
      polar(46, a, 0.05).toArray(),
      polar(49, a, 0.05).toArray(),
    ]);
    // Arched stone haunches visibly support the permanent bridges.
    for (const side of [-1, 1]) {
      const curve = new THREE.CatmullRomCurve3([
        V(16, -6, side * 3),
        V(22, -3, side * 3),
        V(34, -3, side * 3),
        V(43, -7, side * 3),
      ]);
      const g = new THREE.TubeGeometry(curve, 16, 0.48, 6, false);
      g.rotateY(-a);
      batch.add(g, stone);
      for (const r of [20, 28, 36, 41]) {
        const p = V(r, 0, side * 3.32).applyAxisAngle(V(0, 1, 0), -a);
        box(p.x, 0.78, p.z, 0.22, 1.56, 0.22, brass);
      }
      const rail = new THREE.BoxGeometry(25, 0.14, 0.16);
      rail.translate(29.5, 1.53, side * 3.32);
      rail.rotateY(-a);
      solid(rail, brass, "orrery-bridge-rail");
      const inlay = new THREE.BoxGeometry(25, 0.025, 0.12);
      inlay.translate(29.5, 0.035, side * 2.8);
      inlay.rotateY(-a);
      batch.add(inlay, brass);
    }
    const stepStart = polar(52, a + 0.95, 0.04);
    wp(world, ...stepStart.toArray());
  }
  // The outer cloister has flat inner thresholds exactly meeting the bridge ends.
  const outerFloor = ribbonSolid(
    (t) => {
      const a = t * TAU,
        nearest = (Math.round(a / (Math.PI / 2)) * Math.PI) / 2,
        off = a - nearest;
      const inner =
        Math.abs(43 * Math.tan(off)) <= 5.5 ? 43 / Math.cos(off) : 43;
      return {
        left: polar(inner, a, 0).toArray(),
        right: polar(61, a, 0).toArray(),
      };
    },
    256,
    2,
  );
  solid(outerFloor, floor, "orrery-cloister-floor");
  solid(
    annulus(59.8, 61, 1.4, 1.4, 0, TAU, 192),
    stone,
    "orrery-outer-parapet",
  );
  band(60, 1.44, 0.22, brass);
  band(44, 0.035, 0.18, brass);
  band(58.8, 0.035, 0.16, brass);
  // Brass compass rose, stepped central instrument, and four real shelter islands.
  for (const r of [3.7, 4.15, 6.3, 13.5]) band(r, 0.04, 0.1, brass);
  cylinder(0, 0, 0, 2.7, 1.1, dark, 2.5);
  cylinder(0, 1.1, 0, 2.5, 0.3, brass, 2.8);
  const chart = new THREE.Mesh(
    new THREE.CircleGeometry(2.3, 48),
    new THREE.MeshBasicMaterial({
      color: 0xcde8c9,
      map: aiTex("orrery-celestial").map,
    }),
  );
  chart.rotation.x = -Math.PI / 2;
  chart.position.y = 1.42;
  scene.add(chart);
  for (let i = 0; i < 32; i++) {
    const p = polar(5.8, (i * TAU) / 32, 0.055);
    box(
      p.x,
      p.y,
      p.z,
      0.07,
      0.025,
      i % 4 === 0 ? 1.2 : 0.35,
      brass,
      false,
      (-i * TAU) / 32,
    );
  }
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2,
      p = polar(7, a, 0.9);
    box(p.x, p.y, p.z, 3.5, 1.8, 2.1, dark, true, -a);
    box(p.x, 1.83, p.z, 3.3, 0.05, 1.9, brass, false, -a);
  }
  for (const x of [-10, 10]) {
    addRamp(scene, world, {
      axis: "z",
      minX: x - 2,
      maxX: x + 2,
      minZ: -9,
      maxZ: 9,
      h0: 0,
      h1: 10,
      color: 0x87958a,
    });
    route([
      [x, 0, -10.7],
      [x, 0, -9],
      [x, 2.5, -4.5],
      [x, 5, 0],
      [x, 7.5, 4.5],
      [x, 10, 9],
      [x, 10, 12],
    ]);
    for (const z of [-6, -2, 2, 6]) {
      const y = ((z + 9) / 18) * 10;
      box(x, y + 0.035, z, 3.7, 0.025, 0.12, brass, false);
    }
  }
  route([
    [12.65, 10, 0],
    [12.65, 10, 8],
    [10, 10, 12.5],
    [0, 10, 12.5],
    [-10, 10, 12.5],
    [-12.65, 10, 8],
    [-12.65, 10, 0],
    [-12.65, 10, -9],
    [-10, 10, -12.5],
    [0, 10, -12.5],
    [10, 10, -12.5],
    [12.65, 10, -9],
    [12.65, 10, 0],
  ]);
  // Ribbed sanctuary: the machinery hangs above a genuinely occupiable gallery.
  for (let i = 0; i < 8; i++) {
    const a = Math.PI / 8 + (i * TAU) / 8,
      p = polar(15.25, a);
    column(p.x, p.z, 0, 23, 0.65);
    const curve = new THREE.CatmullRomCurve3([
      polar(15.25, a, 22.5),
      polar(14, a, 26),
      polar(10, a, 30),
      polar(5.5, a, 31.5),
    ]);
    batch.add(new THREE.TubeGeometry(curve, 20, 0.36, 7, false), stone);
    const cap = polar(15.25, a, 23.1);
    const g = new THREE.SphereGeometry(0.85, 10, 6);
    g.translate(...cap.toArray());
    batch.add(g, brass);
  }
  band(5.8, 31.5, 0.65, brass);
  band(5.8, 31.6, 0.16, light);
  // Four enclosed gallery bays with vaulted arcades and open axial doorways.
  const pavilionNames = [
    "MERIDIAN",
    "SOUTH GALLERY",
    "ENGINE HOUSE",
    "STAR ARCHIVE",
  ];
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2;
    solid(
      annulus(43, 60, 10, 0.8, a - 0.3, a + 0.3, 28),
      floor,
      "orrery-pavilion-roof",
    );
    // Inlaid soffit ribs and warm lanterns give the sheltered galleries a ceiling.
    for (const r of [45, 51.5, 58])
      band(r, 9.17, 0.1, warm, a - 0.28, a + 0.28);
    for (const phi of [-0.18, 0.18]) {
      const rib = new THREE.BoxGeometry(15, 0.08, 0.1);
      rib.translate(51.5, 9.14, 0);
      rib.rotateY(-(a + phi));
      batch.add(rib, brass);
      const p = polar(51.5, a + phi, 7.8);
      const lamp = new THREE.IcosahedronGeometry(0.32, 1);
      lamp.translate(p.x, p.y, p.z);
      batch.add(lamp, warm);
      const chain = new THREE.CylinderGeometry(0.035, 0.035, 1.3, 5);
      chain.translate(p.x, 8.5, p.z);
      batch.add(chain, brass);
    }
    const glow = new THREE.PointLight(0xffd5a1, 65, 22, 2);
    glow.position.copy(polar(52, a, 6));
    scene.add(glow);
    for (const edge of [-0.3, 0.3]) {
      for (const [r, w] of edge > 0
        ? [
            [45.1, 3.7],
            [56.9, 5.7],
          ]
        : [[51.5, 16.5]]) {
        const p = polar(r, a + edge, 10.8);
        box(p.x, p.y, p.z, w, 1.6, 0.34, stone, true, -(a + edge));
        const trim = new THREE.BoxGeometry(w + 0.1, 0.08, 0.4);
        trim.translate(r, 11.62, 0);
        trim.rotateY(-(a + edge));
        batch.add(trim, brass);
      }
    }
    for (const phi of [-0.24, 0, 0.24]) {
      const angle = a + phi;
      for (const r of [43.8, 59.1]) {
        const p = polar(r, angle);
        column(p.x, p.z, 0, 3.65, 0.52);
      }
      const vault = archGeometry(16.4, 5.65, 3.55, 0.5, 1.05);
      vault.translate(51.5, 0, 0);
      vault.rotateY(-angle);
      solid(vault, stone, "orrery-vault");
      const rib = archGeometry(16.48, 5.71, 3.55, 0.13, 1.16);
      rib.translate(51.5, 0, 0);
      rib.rotateY(-angle);
      batch.add(rib, brass);
    }
    const facade = polar(43.5, a, 6.9);
    sign(pavilionNames[k], facade.x, facade.y, facade.z, 11, -a - Math.PI / 2);
    world.orreryLandmarks.push({
      name: pavilionNames[k],
      position: polar(51, a).toArray(),
    });
    // Sweep each stair through a third of its quadrant, joined to the roof at .30.
    const steps = [];
    const stair = ribbonSolid(
      (t) => {
        const angle = a + 0.94 - t * 0.64,
          y = t * 10;
        return {
          left: polar(47.5, angle, y).toArray(),
          right: polar(53.5, angle, y).toArray(),
        };
      },
      40,
      0.5,
    );
    solid(stair, stone, "orrery-curved-stair");
    for (let i = 0; i <= 8; i++)
      steps.push(
        polar(50.5, a + 0.94 - (i * 0.64) / 8, (i * 10) / 8).toArray(),
      );
    steps.unshift(polar(50.5, a + 1.0, 0.04).toArray());
    steps.push(polar(50.5, a + 0.24, 10).toArray());
    route(steps);
    for (let i = 0; i < 28; i++) {
      const t = (i + 0.5) / 28,
        angle = a + 0.94 - t * 0.64,
        y = t * 10;
      const g = new THREE.BoxGeometry(5.7, 0.035, 0.12);
      g.translate(50.5, y + 0.025, 0);
      g.rotateY(-angle);
      batch.add(g, brass);
    }
    for (const r of [47.6, 53.4]) {
      const curve = new THREE.CatmullRomCurve3(
        Array.from({ length: 33 }, (_, i) =>
          polar(r, a + 0.94 - (i * 0.64) / 32, (i * 10) / 32 + 0.95),
        ),
      );
      solid(
        new THREE.TubeGeometry(curve, 48, 0.085, 5, false),
        brass,
        "orrery-stair-handrail",
      );
      for (let i = 0; i <= 8; i++) {
        const p = polar(r, a + 0.94 - (i * 0.64) / 8, (i * 10) / 8 + 0.46);
        box(p.x, p.y, p.z, 0.13, 0.92, 0.13, brass);
      }
    }
    route([
      polar(44.5, a, 10).toArray(),
      polar(47.5, a + 0.16, 10).toArray(),
      polar(50.5, a + 0.24, 10).toArray(),
    ]);
    // Structural counterweights and ribs continue far below the occupied deck.
    for (const da of [-0.21, 0.21]) {
      const p = polar(55, a + da, -8);
      cylinder(p.x, -15, p.z, 2, 15, dark, 1.1);
      const g = new THREE.ConeGeometry(3.4, 8, 8);
      g.translate(p.x, -19, p.z);
      batch.add(g, brass);
    }
  }
  // The public ring is a dependable flank route through every gallery.
  const cloister = Array.from({ length: 65 }, (_, i) =>
    polar(46, (i * TAU) / 64, 0.04).toArray(),
  );
  route(cloister);
  // Star archive: curved banks of books, reading desks, and hanging chart discs.
  for (const a of [-Math.PI / 2 - 0.18, -Math.PI / 2 + 0.18]) {
    const p = polar(57.4, a, 2.6);
    box(p.x, p.y, p.z, 0.3, 5.2, 7, dark, true, -a);
    for (const edge of [-3.45, 3.45]) {
      const panel = new THREE.BoxGeometry(1.7, 5.2, 0.16);
      panel.translate(56.75, 2.6, edge);
      panel.rotateY(-a);
      solid(panel, dark, "orrery-shelf-end");
    }
    for (let shelf = 0; shelf < 5; shelf++) {
      const plank = new THREE.BoxGeometry(1.7, 0.12, 6.8);
      plank.translate(56.75, 0.6 + shelf * 0.93, 0);
      plank.rotateY(-a);
      batch.add(plank, brass);
      for (let j = 0; j < 13; j++) {
        const g = new THREE.BoxGeometry(0.9, 0.58 + (j % 3) * 0.11, 0.27);
        g.translate(56.55, 1 + shelf * 0.93, -3 + j * 0.48);
        g.rotateY(-a);
        batch.add(g, (j + shelf) % 3 === 0 ? red : book);
        const spine = new THREE.BoxGeometry(0.035, 0.04, 0.25);
        spine.translate(56.06, 1.14 + shelf * 0.93, -3 + j * 0.48);
        spine.rotateY(-a);
        batch.add(spine, brass);
      }
    }
  }
  for (const x of [-5, 5]) {
    box(x, 0.8, -49, 3.2, 1.6, 2, dark);
    box(x, 1.63, -49, 3.3, 0.08, 2.1, brass, false);
  }
  // Engine house: three housed flywheels, with a protected lane on each side.
  const turbines = [];
  for (const z of [-6, 0, 6]) {
    box(-56, 1.05, z, 3.2, 2.1, 3.7, dark);
    const g = new THREE.TorusGeometry(1.45, 0.23, 8, 24);
    g.rotateY(Math.PI / 2);
    g.translate(-54.35, 3.1, z);
    batch.add(g, brass);
    const rotor = new THREE.Group();
    rotor.position.set(-54.3, 3.1, z);
    scene.add(rotor);
    const rb = new EnvironmentBatch(rotor);
    for (let i = 0; i < 8; i++) {
      const b = new THREE.BoxGeometry(0.12, 0.33, 2.55);
      b.rotateX((i * Math.PI) / 4);
      rb.add(b, copper);
    }
    rb.flush("orrery-flywheel");
    turbines.push(rotor);
    cylinder(-56, 2.1, z, 0.55, 4, brass, 0.55);
  }
  // Meridian: an enormous articulated refractor overlooks the open gallery.
  cylinder(53, 0, 0, 1.8, 2.4, dark, 1.3);
  const telescope = new THREE.Group();
  telescope.position.set(53, 3.3, 0);
  telescope.rotation.z = 0.42;
  scene.add(telescope);
  const tb = new EnvironmentBatch(telescope);
  for (const [x, r, len, m] of [
    [0, 1.3, 7, stone],
    [3.3, 1.45, 0.4, brass],
    [-3.2, 1.5, 0.6, brass],
    [3.65, 1.17, 0.08, light],
  ]) {
    const g = new THREE.CylinderGeometry(r, r, len, 24);
    g.rotateZ(Math.PI / 2);
    g.translate(x, 0, 0);
    tb.add(g, m);
  }
  telescope.updateMatrixWorld(true);
  for (const m of tb.groups.values())
    for (const g of m) {
      const physical = g.clone().applyMatrix4(telescope.matrixWorld);
      world.colliders.push(
        triangleMeshColliderFromMesh(
          new THREE.Mesh(physical, dark),
          "orrery-telescope",
          true,
        ),
      );
      physical.dispose();
    }
  tb.flush("orrery-refractor");
  for (const z of [-7, 7]) {
    box(51, 1, z, 3, 2, 2, dark);
  }
  // Arrival gallery: paired benches and shallow luminous astronomical mosaics.
  for (const x of [-7, 7]) {
    box(x, 0.65, 54, 2, 1.3, 5, dark);
    box(x, 1.32, 54, 2.1, 0.08, 5.1, brass, false);
  }
  for (const z of [48, 53, 58]) {
    const disc = new THREE.CircleGeometry(1.1, 24);
    disc.rotateX(-Math.PI / 2);
    disc.translate(0, 0.05, z);
    batch.add(disc, brass);
  }
  // Roof lanterns echo the observatory rather than becoming solid box rooms.
  for (const angle of [Math.PI / 2, -Math.PI / 2]) {
    const p = polar(53, angle, 10),
      radius = 5;
    const glass = new THREE.Mesh(
      new THREE.SphereGeometry(radius, 24, 12, 0, TAU, 0, Math.PI / 2),
      new THREE.MeshStandardMaterial({
        color: 0x32666a,
        metalness: 0.5,
        roughness: 0.25,
        transparent: true,
        opacity: 0.6,
        side: THREE.DoubleSide,
      }),
    );
    glass.position.copy(p);
    glass.castShadow = false;
    scene.add(glass);
    world.colliders.push(
      triangleMeshColliderFromMesh(glass, "orrery-roof-lantern", true),
    );
    for (let i = 0; i < 8; i++) {
      const arc = new THREE.EllipseCurve(
        0,
        0,
        radius,
        radius,
        0,
        Math.PI / 2,
        false,
        0,
      )
        .getPoints(16)
        .map((v) => V(v.x, v.y, 0));
      const curve = new THREE.CatmullRomCurve3(arc);
      const g = new THREE.TubeGeometry(curve, 16, 0.09, 5, false);
      g.rotateY((i * TAU) / 8);
      g.translate(...p.toArray());
      batch.add(g, brass);
    }
    const rim = annulus(4.8, 5.2, 10.1, 0.3);
    rim.translate(p.x, 0, p.z);
    solid(rim, brass, "orrery-lantern-sill");
  }
  // A suspended armillary sphere dominates the whole arena, with three
  // independently turning bands. All of it stays above the playable headroom.
  const armillary = new THREE.Group();
  armillary.position.y = 40;
  scene.add(armillary);
  const orb = new THREE.Mesh(
    new THREE.IcosahedronGeometry(6.2, 3),
    new THREE.MeshStandardMaterial({
      color: 0xd1e6ce,
      emissive: 0x163f39,
      emissiveIntensity: 0.55,
      roughness: 0.52,
      metalness: 0.25,
      ...aiTex("orrery-celestial", 1, 1),
    }),
  );
  armillary.add(orb);
  const latitudes = new EnvironmentBatch(armillary);
  for (let i = -3; i <= 3; i++) {
    const latitude = i * 0.36,
      r = Math.cos(latitude) * 6.28,
      g = new THREE.TorusGeometry(r, 0.035, 5, 64);
    g.rotateX(Math.PI / 2);
    g.translate(0, Math.sin(latitude) * 6.28, 0);
    latitudes.add(g, light);
  }
  for (let i = 0; i < 6; i++) {
    const g = new THREE.TorusGeometry(6.29, 0.035, 5, 64);
    g.rotateY((i * Math.PI) / 6);
    latitudes.add(g, light);
  }
  latitudes.flush("orrery-celestial-globe");
  const rings = [];
  for (let i = 0; i < 3; i++) {
    const root = new THREE.Group();
    root.rotation.set(0.5 + i * 0.55, 0.2 + i * 0.7, 0.3 + i * 0.35);
    armillary.add(root);
    const rb = new EnvironmentBatch(root),
      r = 10 + i * 4.5;
    rb.add(new THREE.TorusGeometry(r, 0.32 + i * 0.05, 8, 128), brass);
    rb.add(new THREE.TorusGeometry(r - 0.12, 0.075, 5, 128), light);
    for (let j = 0; j < 48; j++) {
      const a = (j * TAU) / 48,
        p = V(Math.cos(a) * r, Math.sin(a) * r, 0);
      const tick = new THREE.BoxGeometry(j % 4 === 0 ? 0.65 : 0.3, 0.1, 0.14);
      tick.rotateZ(a);
      tick.translate(...p.toArray());
      rb.add(tick, brass);
    }
    const moon = new THREE.IcosahedronGeometry(0.85 + i * 0.3, 1);
    moon.translate(r, 0, 0);
    rb.add(moon, i === 1 ? stone : copper);
    rb.flush("orrery-armillary-band");
    rings.push(root);
  }
  // Static hanging chains and a pointed underside give the station a complete silhouette.
  for (let i = 0; i < 8; i++) {
    const a = Math.PI / 8 + (i * TAU) / 8;
    batch.beam(polar(15.25, a, -1), polar(8, a, -14), 0.32, brass);
    batch.beam(polar(8, a, -14), V(0, -22, 0), 0.25, dark);
  }
  const pendant = new THREE.IcosahedronGeometry(2.4, 1);
  pendant.scale(1, 2.2, 1);
  pendant.translate(0, -19, 0);
  batch.add(pendant, light);
  // Four flying buttresses connect the outer foundations to the celestial crown.
  // Their height leaves every deck and stair clear underneath.
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2,
      p = polar(59, a);
    column(p.x, p.z, 1.4, 13, 1.05);
    const points = [
      polar(59, a, 13.8),
      polar(61, a, 26),
      polar(51, a, 44),
      polar(37, a, 54),
      polar(27, a, 56),
    ];
    const path = new THREE.CatmullRomCurve3(points);
    solid(
      new THREE.TubeGeometry(path, 36, 0.85, 8, false),
      stone,
      "orrery-flying-buttress",
    );
    const accent = new THREE.CatmullRomCurve3(
      points.map((p) => p.clone().add(V(0, 0.9, 0))),
    );
    batch.add(new THREE.TubeGeometry(accent, 36, 0.09, 5, false), brass);
  }
  band(27, 56, 0.8, brass);
  band(27, 56.06, 0.12, light);
  batch.flush("orrery-architecture");

  // The annular floor is rotationally symmetric: its exact cylindrical
  // collision does not need to rebuild as the visible floor rotates.
  const moving = new THREE.Group();
  scene.add(moving);
  const mb = new EnvironmentBatch(moving);
  mb.add(annulus(24, 31, 10, 0.8), dark);
  world.colliders.push({
    type: "cylinderShell",
    axis: "y",
    center: V(0, 9.6, 0),
    halfLength: 0.4,
    innerRadius: 24,
    outerRadius: 31,
  });
  for (const r of [24.3, 30.7]) band(r, 10.04, 0.12, light, 0, TAU, mb);
  for (let i = 0; i < 64; i++) {
    const a = (i * TAU) / 64,
      g = new THREE.BoxGeometry(i % 4 === 0 ? 4.8 : 1.2, 0.035, 0.09);
    g.translate(27.5, 10.025, 0);
    g.rotateY(-a);
    mb.add(g, brass);
    if (i % 4 === 0) {
      const tooth = new THREE.BoxGeometry(0.9, 0.8, 0.5);
      tooth.translate(31.3, 9.4, 0);
      tooth.rotateY(-a);
      mb.add(tooth, brass);
    }
  }
  const movingRamps = [];
  for (const sign of [-1, 1])
    for (const [start, end] of [
      [20, 24.12],
      [30.88, 43],
    ]) {
      const cx = (sign * (start + end)) / 2,
        length = end - start;
      const g = new THREE.BoxGeometry(length, 0.44, 6);
      g.translate(cx, 9.74, 0);
      mb.add(g, brass);
      for (const z of [-2.65, 2.65]) {
        const line = new THREE.BoxGeometry(length, 0.03, 0.12);
        line.translate(cx, 9.98, z);
        mb.add(line, light);
      }
      const r = {
        oriented: true,
        dynamic: true,
        centerX: cx,
        centerZ: 0,
        length,
        width: 6,
        yaw: 0,
        h0: 9.96,
        h1: 9.96,
      };
      world.ramps.push(r);
      movingRamps.push({ r, cx });
    }
  mb.flush("orrery-rotating-deck");
  const indicatorMaterials = [0, 1].map(
    () => new THREE.MeshBasicMaterial({ color: 0xc3f5dc, toneMapped: false }),
  );
  const indicators = new EnvironmentBatch(scene);
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2,
      g = new THREE.BoxGeometry(0.12, 0.08, 5.5);
    g.translate(43.45, 10.08, 0);
    g.rotateY(-a);
    indicators.add(g, indicatorMaterials[i % 2]);
  }
  indicators.flush("orrery-dock-indicators");
  let lastAngle = 0;
  const update = (dt, t, characters) => {
    const pose = orreryPose(t),
      delta = orreryRideDelta(lastAngle, pose.angle),
      c = Math.cos(delta),
      s = Math.sin(delta);
    for (const ch of characters) {
      if (
        !ch?.alive ||
        !onOrreryDeck(ch.pos, lastAngle, ch.grounded, ch.vel?.y)
      )
        continue;
      const x = ch.pos.x,
        z = ch.pos.z;
      ch.pos.x = x * c - z * s;
      ch.pos.z = x * s + z * c;
    }
    moving.rotation.y = -pose.angle;
    for (const { r, cx } of movingRamps) {
      r.centerX = cx * Math.cos(pose.angle);
      r.centerZ = cx * Math.sin(pose.angle);
      r.yaw = pose.angle;
      delete r._obb;
    }
    for (let i = 0; i < 2; i++)
      indicatorMaterials[i].color.setHex(
        pose.moving
          ? 0xe0a44f
          : pose.eastWest === (i === 0)
            ? 0xc3f5dc
            : 0x45564e,
      );
    if (stormSky) stormSky.rotation.y = 0.8 + t * 0.0015;
    orb.rotation.y = t * 0.06;
    for (let i = 0; i < rings.length; i++)
      rings[i].rotation.z =
        0.3 + i * 0.35 + t * (i % 2 ? -0.025 : 0.018) * (i + 1);
    for (let i = 0; i < turbines.length; i++)
      turbines[i].rotation.x = t * (0.65 + i * 0.09);
    world.orrery.pose = pose;
    lastAngle = pose.angle;
  };
  world.orrery = { moving, movingRamps, pose: orreryPose(0), update };
  update(0, 0, []);
  world.anim.push(update);
  // Weapons pull fights into different rooms and onto both elevation layers.
  for (const [kind, x, y, z, extra] of [
    ["weapon", 0, 0.25, -49, { weapon: "hyper" }],
    ["ammo", -4, 0.25, -47, { weapon: "hyper" }],
    ["weapon", -50, 0.25, 6, { weapon: "whomper" }],
    ["ammo", -49, 0.25, -6, { weapon: "whomper" }],
    ["weapon", 48, 0.25, 5, { weapon: "parasite" }],
    ["ammo", 49, 0.25, -5, { weapon: "parasite" }],
    ["weapon", 0, 0.25, 49, { weapon: "scatter" }],
    ["ammo", 4, 0.25, 49, { weapon: "scatter" }],
    ["weapon", 0, 10.25, 13, { weapon: "pulsar" }],
    ["ammo", 4, 10.25, 13, { weapon: "pulsar" }],
    ["weapon", -14, 10.25, 0, { weapon: "zooka" }],
    ["weapon", 44.5, 10.25, 0, { weapon: "sidewinder" }],
    ["gold", 0, 10.25, -13, {}],
    ["silver", -44.5, 10.25, 0, {}],
    ["health", 0, 0.25, -24, {}],
    ["health", 24, 0.25, 0, {}],
    ["health", 0, 0.25, 24, {}],
    ["health", -24, 0.25, 0, {}],
    ["health", 0, 10.25, 44.5, {}],
    ["shield", 0, 10.25, -44.5, {}],
    ["star", -8, 0.25, -52, { hidden: true }],
    ["star", 57, 0.25, 9, { hidden: true }],
    ["star", 14, 10.25, -8, { hidden: true }],
  ])
    pk(world, kind, x, y, z, extra);
  // Every start has a solid floor, cover nearby, and two exits.
  for (const p of [
    [-50, 0.1, 10],
    [-50, 0.1, -10],
    [-46, 0.1, 0],
    [-14, 10.1, -8],
  ])
    world.spawns.blue.push(V(...p));
  for (const p of [
    [50, 0.1, 10],
    [50, 0.1, -10],
    [46, 0.1, 0],
    [14, 10.1, 8],
  ])
    world.spawns.red.push(V(...p));
  world.spawns.ffa.push(
    ...world.spawns.blue,
    ...world.spawns.red,
    V(10, 0.1, 51),
    V(-8, 0.1, -52),
    V(0, 10.1, 44.5),
    V(0, 10.1, -44.5),
  );
  // Static graph connections deliberately do not promise a moving bridge.
  // Bots can fight and collect the whole permanent route network at any phase.
  for (const p of [
    V(0, 0, 7),
    V(0, 0, -7),
    V(7, 0, 0),
    V(-7, 0, 0),
    V(0, 10, 13),
    V(0, 10, -13),
  ])
    wp(world, ...p.toArray());
  mergeStatic(scene, world);
  return world;
}
