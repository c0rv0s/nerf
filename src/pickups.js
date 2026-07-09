// Spinning/bobbing pickup items: weapons, ammo, health, hidden stars,
// and the gold/silver Nerf medal powerups.
import * as THREE from 'three';
import { WEAPONS, buildBlaster } from './weapons.js';
import { aiTex } from './maps.js';

const RESPAWN = { weapon: 18, ammo: 14, health: 16, shield: 40, star: 45, gold: 60, silver: 50, speed: 45, djump: 45 };
const WORLD_UP = new THREE.Vector3(0, 1, 0);

function pickupUp(def) {
  return def.up || WORLD_UP;
}

function pickupFloatHeight(def) {
  return def.kind === 'points' ? 1.75 : 1.0;
}

function placePickupMesh(mesh, def, t = 0, phase = 0) {
  const up = pickupUp(def);
  const height = pickupFloatHeight(def) + Math.sin(t * 2 + phase) * 0.18;
  mesh.position.copy(def.pos).addScaledVector(up, height);
}

// Neon point-value badges (canvas sprites, cached per value)
const POINT_COLORS = { 1000: '#ffd23c', 750: '#ff9c40', 500: '#c86aff', 250: '#4dffd2' };
const _badgeTex = {};
function pointBadge(amount) {
  if (!_badgeTex[amount]) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const col = POINT_COLORS[amount] || '#ffffff';
    g.beginPath(); g.arc(64, 64, 56, 0, 7);
    g.fillStyle = 'rgba(10,10,30,.85)'; g.fill();
    g.lineWidth = 8; g.strokeStyle = col; g.stroke();
    g.beginPath(); g.arc(64, 64, 44, 0, 7);
    g.lineWidth = 3; g.strokeStyle = col; g.stroke();
    g.font = 'bold 34px Arial Black, Arial';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = col;
    g.fillText(String(amount), 64, 66);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    _badgeTex[amount] = t;
  }
  return _badgeTex[amount];
}

function makeMesh(def) {
  const g = new THREE.Group();
  const glowMat = (color, glow = 0.45) => new THREE.MeshStandardMaterial({
    color, roughness: 0.5, emissive: color, emissiveIntensity: glow });
  if (def.kind === 'weapon' || def.kind === 'drop') {
    const gun = buildBlaster(def.weapon);
    gun.rotation.y = Math.PI / 2;
    gun.rotation.z = -0.15;
    g.add(gun);
  } else if (def.kind === 'ammo') {
    const w = WEAPONS[def.weapon];
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.7, 0.5, 0.4),
      new THREE.MeshStandardMaterial({ color: w.color, roughness: 0.5,
        emissive: w.color, emissiveIntensity: 0.4, ...aiTex('plastic') }));
    g.add(body);
  } else if (def.kind === 'health') {
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 }));
    g.add(box);
    for (const rot of [0, Math.PI / 2]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.2, 0.85), glowMat(0xe03030, 0.6));
      bar.rotation.z = rot;
      g.add(bar);
    }
  } else if (def.kind === 'points') {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: pointBadge(def.amount),
      transparent: true,
      alphaTest: 0.04,
      depthWrite: false,
      depthTest: true,
    }));
    sprite.renderOrder = 30;
    sprite.scale.setScalar(1.7);
    g.add(sprite);
  } else if (def.kind === 'shield') {
    const bubble = new THREE.Mesh(new THREE.SphereGeometry(0.6, 14, 10),
      new THREE.MeshStandardMaterial({ color: 0x7fd0ff, transparent: true, opacity: 0.35,
        roughness: 0.1, emissive: 0x3aa0e0, emissiveIntensity: 0.5 }));
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.28), glowMat(0x7fd0ff, 1.2));
    g.add(bubble, core);
  } else if (def.kind === 'djump') {
    // stacked up-chevrons — jump, then jump again
    for (const dy of [-0.18, 0.24]) {
      const c = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.45, 4), glowMat(0x30e0ff, 1.2));
      c.position.y = dy;
      g.add(c);
    }
  } else if (def.kind === 'speed') {
    // double chevron — go faster
    for (const dx of [-0.22, 0.22]) {
      const c = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.55, 4), glowMat(0x6dff6d, 1.2));
      c.rotation.z = -Math.PI / 2;
      c.position.x = dx;
      g.add(c);
    }
  } else if (def.kind === 'star') {
    const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.55), glowMat(0xffe040, 1.4));
    g.add(star);
  } else { // gold / silver medal
    const gold = def.kind === 'gold';
    const color = gold ? 0xffc928 : 0xdce7f4;
    const edgeColor = gold ? 0xffee9a : 0xf7fbff;
    const insetColor = gold ? 0x743900 : 0x536174;
    const quietWaterMedal = def.quietWaterMedal === true;
    const metal = new THREE.MeshStandardMaterial({
      color, metalness: quietWaterMedal ? 0.46 : 0.94,
      roughness: quietWaterMedal ? 0.58 : (gold ? 0.2 : 0.15),
      envMapIntensity: quietWaterMedal ? 0.25 : 1.25,
      emissive: color, emissiveIntensity: quietWaterMedal ? 0.06 : 0.14,
    });
    const brightMetal = new THREE.MeshStandardMaterial({
      color: edgeColor, metalness: 0.92, roughness: 0.16,
      emissive: color, emissiveIntensity: quietWaterMedal ? 0.04 : 0.2,
    });
    const inset = new THREE.MeshStandardMaterial({
      color: insetColor, metalness: 0.72, roughness: 0.3,
      emissive: color, emissiveIntensity: quietWaterMedal ? 0.02 : 0.08,
    });

    // A layered, beveled relic rather than a flat glowing disc. The raised N
    // reads from either side while the toothed rim gives it a trophy silhouette.
    const edge = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.72, 0.12, 32), inset);
    edge.rotation.x = Math.PI / 2;
    const face = new THREE.Mesh(new THREE.CylinderGeometry(0.63, 0.63, 0.2, 32), metal);
    face.rotation.x = Math.PI / 2;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.64, 0.055, 8, 36), brightMetal);
    const innerRim = new THREE.Mesh(new THREE.TorusGeometry(0.44, 0.025, 6, 30), inset);
    g.add(edge, face, rim, innerRim);

    const addEmblem = z => {
      for (const [x, rot] of [[-0.18, 0], [0.18, 0], [0, -0.57]]) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(0.105, 0.52, 0.065), inset);
        bar.position.set(x, 0, z);
        bar.rotation.z = rot;
        g.add(bar);
      }
    };
    addEmblem(0.125);
    addEmblem(-0.125);

    for (let i = 0; i < 12; i++) {
      const a = i * Math.PI / 6;
      const tooth = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.055, 0.075), brightMetal);
      tooth.position.set(Math.cos(a) * 0.78, Math.sin(a) * 0.78, 0);
      tooth.rotation.z = a;
      g.add(tooth);
    }
    if (!quietWaterMedal) {
      const haloMat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.62, depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const halo = new THREE.Mesh(new THREE.TorusGeometry(0.94, 0.018, 5, 42), haloMat);
      const arc = new THREE.Mesh(new THREE.TorusGeometry(1.03, 0.012, 5, 32, Math.PI * 1.35), haloMat.clone());
      arc.rotation.z = -0.65;
      g.add(halo, arc);
      for (const [x, y, s] of [[-0.92, 0.42, .11], [.86, -.5, .085], [.18, .96, .07]]) {
        const spark = new THREE.Mesh(new THREE.OctahedronGeometry(s, 0),
          new THREE.MeshBasicMaterial({ color: edgeColor }));
        spark.position.set(x, y, 0);
        g.add(spark);
      }
      const light = new THREE.PointLight(color, 24, 12);
      g.add(light);
    }
  }
  return g;
}

export class PickupManager {
  // hooks: {onPickup(character, def) -> bool (true = consumed)}
  constructor(scene, defs, hooks) {
    this.scene = scene;
    this.hooks = hooks;
    this.items = defs.map(def => {
      const mesh = makeMesh(def);
      placePickupMesh(mesh, def);
      scene.add(mesh);
      // Detach lights from the toggled group: removing a light from the render
      // list changes the scene's light count and forces a full shader
      // recompile (the pickup hitch). Kept in-scene, dimmed to 0 instead.
      const lights = [];
      mesh.traverse(o => { if (o.isPointLight) lights.push(o); });
      for (const L of lights) {
        const wp = new THREE.Vector3();
        L.getWorldPosition(wp);
        L.parent.remove(L);
        L.position.copy(wp);
        L.userData.base = L.intensity;
        scene.add(L);
      }
      return { def, mesh, lights, active: true, timer: 0, phase: Math.random() * 6 };
    });
    this.t = 0;
  }

  // Drop a one-off pickup into the world (e.g. a dead player's weapon).
  // No respawn — despawns after 30s if nobody grabs it.
  addDrop(def) {
    const mesh = makeMesh(def);
    placePickupMesh(mesh, def);
    this.scene.add(mesh);
    this.items.push({ def, mesh, lights: [], active: true, temporary: true, ttl: 30, timer: 0, phase: Math.random() * 6 });
  }

  update(dt, characters) {
    this.t += dt;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.temporary) {
        it.ttl -= dt;
        if (it.ttl <= 0 || !it.active) {
          this.scene.remove(it.mesh);
          this.items.splice(i, 1);
          continue;
        }
      }
      if (!it.active) {
        it.timer -= dt;
        if (it.timer <= 0) {
          it.active = true;
          it.mesh.visible = true;
          for (const L of it.lights) L.intensity = L.userData.base;
        }
        continue;
      }
      if (it.def.kind !== 'points') it.mesh.rotation.y += dt * 2;
      placePickupMesh(it.mesh, it.def, this.t, it.phase);
      for (const L of it.lights) L.position.copy(it.mesh.position);
      if (it.hostMirror) continue;

      for (const ch of characters) {
        if (!ch.alive) continue;
        const pickupCenter = it.def.pos.clone().addScaledVector(pickupUp(it.def), pickupFloatHeight(it.def));
        const charCenter = ch.pos.clone().addScaledVector(ch.up || WORLD_UP, ch.height * 0.5);
        if (charCenter.distanceToSquared(pickupCenter) < 5.2) {
          if (this.hooks.onPickup(ch, it.def)) {
            it.active = false;
            it.mesh.visible = false;
            for (const L of it.lights) L.intensity = 0;
            it.timer = RESPAWN[it.def.kind] ?? 20;
          }
          break;
        }
      }
    }
  }

  clear() {
    for (const it of this.items) {
      this.scene.remove(it.mesh);
      for (const L of it.lights) this.scene.remove(L);
    }
    this.items.length = 0;
  }
}
