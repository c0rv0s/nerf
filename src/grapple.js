// Canopy's innate traversal grapple. Targeting is analytic so the hook uses
// the same collision shapes as movement without turning decorative foliage
// into solid geometry.
import * as THREE from 'three';
import { rayHitsCylinderShell, rayHitsEllipsoid, rayHitsTriangleMesh } from './engine.js';

export const GRAPPLE_MAX_DISTANCE = 112;
export const GRAPPLE_FOLIAGE_EMBED = 1;

const rayBox = (origin, direction, box, maxDistance) => {
  let near = -Infinity;
  let far = Infinity;
  for (const axis of ['x', 'y', 'z']) {
    const o = origin[axis];
    const d = direction[axis];
    if (Math.abs(d) < 1e-8) {
      if (o < box.min[axis] || o > box.max[axis]) return null;
      continue;
    }
    let a = (box.min[axis] - o) / d;
    let b = (box.max[axis] - o) / d;
    if (a > b) [a, b] = [b, a];
    near = Math.max(near, a);
    far = Math.min(far, b);
    if (near > far) return null;
  }
  const t = near > 0.03 ? near : far;
  return t > 0.03 && t <= maxDistance ? { t } : null;
};

const raySphere = (origin, direction, center, radius, maxDistance) => {
  const offset = origin.clone().sub(center);
  const projected = offset.dot(direction);
  const discriminant = projected * projected - (offset.lengthSq() - radius * radius);
  if (discriminant < 0) return null;
  const root = Math.sqrt(discriminant);
  const near = -projected - root;
  const far = -projected + root;
  const t = near > 0.03 ? near : far;
  return t > 0.03 && t <= maxDistance ? { t, far } : null;
};

const rampBounds = ramp => ({
  min: new THREE.Vector3(ramp.minX, Math.min(ramp.h0, ramp.h1) - 0.45, ramp.minZ),
  max: new THREE.Vector3(ramp.maxX, Math.max(ramp.h0, ramp.h1) + 0.1, ramp.maxZ),
});

export function findGrappleAnchor(world, origin, rawDirection, maxDistance = GRAPPLE_MAX_DISTANCE) {
  if (!world?.grappleEnabled) return null;
  const direction = rawDirection.clone().normalize();
  let best = null;
  const consider = (hit, type, embed = 0) => {
    if (!hit || (best && hit.t >= best.distance)) return;
    const anchorDistance = Math.min(maxDistance, hit.far == null
      ? hit.t
      : Math.min(hit.far - 0.05, hit.t + embed));
    best = {
      point: origin.clone().addScaledVector(direction, anchorDistance),
      distance: hit.t,
      type,
    };
  };

  for (const collider of world.colliders || []) {
    if (collider.grapple === false) continue;
    let hit = null;
    if (collider.type === 'box') hit = rayBox(origin, direction, collider, maxDistance);
    else if (collider.type === 'sphere') {
      hit = raySphere(origin, direction, collider.center, collider.radius, maxDistance);
    } else if (collider.type === 'ellipsoid') {
      hit = rayHitsEllipsoid(origin, direction, collider, maxDistance);
    } else if (collider.type === 'triangleMesh') {
      hit = rayHitsTriangleMesh(origin, direction, collider, maxDistance);
    } else if (collider.type === 'cylinderShell') {
      hit = rayHitsCylinderShell(origin, direction, collider, maxDistance);
    }
    consider(hit, 'solid');
  }
  for (const ramp of world.ramps || []) consider(
    rayBox(origin, direction, rampBounds(ramp), maxDistance), 'solid');

  // Tree crowns remain visual-only for ordinary collision. Grappling treats
  // each authored crown volume as leaves wrapped around hidden strong limbs,
  // placing the hook one metre past the first leaf surface.
  for (const target of world.grappleFoliageTargets || []) {
    consider(
      raySphere(origin, direction, target.center, target.radius, maxDistance),
      'foliage',
      target.embed ?? GRAPPLE_FOLIAGE_EMBED,
    );
  }
  return best;
}

export function applyGrapplePull(character, dt) {
  const anchor = character?.grappleAnchor;
  if (!character?.grappleAttached || !anchor || !character.alive) return false;
  const chest = character.pos.clone().add(new THREE.Vector3(0, (character.height || 1.8) * 0.58, 0));
  const toward = anchor.clone().sub(chest);
  const distance = toward.length();
  if (distance < 0.2) return true;
  toward.multiplyScalar(1 / distance);

  character.grappleRopeLength = Math.max(4.2,
    Math.min(character.grappleRopeLength || distance, distance) - 8.5 * dt);
  const stretch = Math.max(0, distance - character.grappleRopeLength);
  const upwardHelp = anchor.y > chest.y + 1 ? 7 : 0;
  const acceleration = Math.min(74, 26 + upwardHelp + stretch * 5.5);
  character.vel.addScaledVector(toward, acceleration * dt);

  // Cancel motion directly away from a taut rope while retaining tangential
  // velocity. That preserved sideways component is what makes broad swings
  // possible instead of reducing the grapple to a vertical elevator.
  const radialSpeed = character.vel.dot(toward);
  if (stretch > 0.1 && radialSpeed < 0) {
    character.vel.addScaledVector(toward, -radialSpeed * Math.min(1, dt * 11));
  }
  const speed = character.vel.length();
  if (speed > 40) character.vel.multiplyScalar(40 / speed);
  return true;
}

export function createGrappleVisual(scene, color = 0xa8ff70) {
  if (!scene) return null;
  // WebGL lineWidth is ignored on most browsers, so the old one-pixel line
  // could never read as a load-bearing rope. A real narrow cylinder gives the
  // tether consistent world-space thickness from every distance and angle.
  const cable = new THREE.Mesh(
    new THREE.CylinderGeometry(0.055, 0.055, 1, 8, 1),
    new THREE.MeshStandardMaterial({
      color, roughness: 0.68, metalness: 0.18,
      emissive: new THREE.Color(color).multiplyScalar(0.18), emissiveIntensity: 0.45,
    }),
  );
  cable.frustumCulled = false;
  cable.visible = false;
  scene.add(cable);

  const hook = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.28, 0),
    new THREE.MeshBasicMaterial({ color: 0xffdf70, toneMapped: false }),
  );
  hook.visible = false;
  scene.add(hook);
  return { cable, hook };
}

export function updateGrappleVisual(visual, start, anchor, visible = true) {
  if (!visual) return;
  const show = !!(visible && start && anchor);
  visual.cable.visible = show;
  visual.hook.visible = show;
  if (!show) return;
  const delta = anchor.clone().sub(start);
  const length = delta.length();
  visual.cable.position.copy(start).add(anchor).multiplyScalar(0.5);
  visual.cable.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    length > 1e-5 ? delta.multiplyScalar(1 / length) : new THREE.Vector3(0, 1, 0),
  );
  visual.cable.scale.set(1, Math.max(0.001, length), 1);
  visual.hook.position.copy(anchor);
}

export function disposeGrappleVisual(visual) {
  if (!visual) return;
  visual.cable.parent?.remove(visual.cable);
  visual.hook.parent?.remove(visual.hook);
  visual.cable.geometry.dispose();
  visual.cable.material.dispose();
  visual.hook.geometry.dispose();
  visual.hook.material.dispose();
}
