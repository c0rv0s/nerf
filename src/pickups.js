// Spinning/bobbing pickup items: weapons, ammo, health, hidden stars,
// and the gold/silver Nerf medal powerups.
import * as THREE from 'three';
import { WEAPONS, buildBlaster } from './weapons.js';
import { aiTex } from './maps.js';

const RESPAWN = { weapon: 18, ammo: 14, health: 16, shield: 40, star: 45, gold: 60, silver: 50, speed: 45 };

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
      map: pointBadge(def.amount), transparent: true, depthWrite: false }));
    sprite.scale.setScalar(1.7);
    g.add(sprite);
  } else if (def.kind === 'shield') {
    const bubble = new THREE.Mesh(new THREE.SphereGeometry(0.6, 14, 10),
      new THREE.MeshStandardMaterial({ color: 0x7fd0ff, transparent: true, opacity: 0.35,
        roughness: 0.1, emissive: 0x3aa0e0, emissiveIntensity: 0.5 }));
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.28), glowMat(0x7fd0ff, 1.2));
    g.add(bubble, core);
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
    const color = def.kind === 'gold' ? 0xffd23c : 0xdcdce8;
    const medal = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.18, 20),
      new THREE.MeshStandardMaterial({ color, metalness: 0.9, roughness: 0.25,
        emissive: color, emissiveIntensity: 0.5 }));
    medal.rotation.x = Math.PI / 2;
    g.add(medal);
    const glow = new THREE.Mesh(new THREE.SphereGeometry(1.1, 12, 8),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.15 }));
    g.add(glow);
    const light = new THREE.PointLight(color, 60, 16);
    g.add(light);
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
      mesh.position.copy(def.pos).y += 1.0;
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
    mesh.position.copy(def.pos).y += 1.0;
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
      it.mesh.rotation.y += dt * 2;
      it.mesh.position.y = it.def.pos.y + 1.0 + Math.sin(this.t * 2 + it.phase) * 0.18;

      for (const ch of characters) {
        if (!ch.alive) continue;
        const dx = ch.pos.x - it.def.pos.x;
        const dy = (ch.pos.y + 0.9) - (it.def.pos.y + 1.0);
        const dz = ch.pos.z - it.def.pos.z;
        if (dx * dx + dz * dz < 2.6 && Math.abs(dy) < 2.2) {
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
