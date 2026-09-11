import * as THREE from 'three';
import { aiTex } from './maps.js';
import { HORSE_HEIGHT_DELTA, HORSE_LEG_HEIGHT } from './mount.js';

// Full mount in ground-relative coordinates, facing +Z.
export function buildHorseVisual() {
  const skin = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.7, ...extra });
  const horse = new THREE.Group();
  const horseLegs = [];
  const coatTexture = aiTex('horse-coat', 1.7, 1.7);
  const coat = skin(coatTexture.map ? 0xffffff : 0xa6532b, {
    roughness: 0.9, ...coatTexture,
  });
  const dark = skin(0x24170f, { roughness: 0.95 });
  const tack = skin(0x3a2418, { roughness: 0.82 });
  const horseBody = new THREE.Mesh(new THREE.CapsuleGeometry(0.5, 1.45, 5, 10), coat);
  horseBody.rotation.x = Math.PI / 2;
  horseBody.position.set(0, 0.9 + HORSE_HEIGHT_DELTA, 0.05);
  horse.add(horseBody);
  const neck = new THREE.Mesh(new THREE.CapsuleGeometry(0.27, 0.72, 4, 9), coat);
  neck.rotation.x = -0.5;
  neck.position.set(0, 1.25 + HORSE_HEIGHT_DELTA, 0.86);
  horse.add(neck);
  const horseHead = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.5, 0.9), coat);
  horseHead.position.set(0, 1.55 + HORSE_HEIGHT_DELTA, 1.42);
  horseHead.rotation.x = -0.13;
  horse.add(horseHead);
  for (const side of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.36, 6), coat);
    ear.position.set(side * 0.14, 1.96 + HORSE_HEIGHT_DELTA, 1.48);
    horse.add(ear);
  }
  const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.16, 0.84), tack);
  saddle.position.set(0, 1.38 + HORSE_HEIGHT_DELTA, -0.05);
  horse.add(saddle);
  for (const [x, z, phase] of [[-.34,-.48,0],[.34,-.48,Math.PI],[-.34,.52,Math.PI],[.34,.52,0]]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.14, HORSE_LEG_HEIGHT, 7), coat);
    leg.position.set(x, 0.28 + HORSE_HEIGHT_DELTA / 2, z);
    leg.userData.gaitPhase = phase;
    horse.add(leg);
    horseLegs.push(leg);
  }
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.16, 1.15, 7), dark);
  tail.rotation.x = -0.62;
  tail.position.set(0, 0.9 + HORSE_HEIGHT_DELTA, -1.12);
  horse.add(tail);
  horse.traverse(child => { if (child.isMesh) child.castShadow = child.receiveShadow = true; });
  return { horse, horseLegs };
}
