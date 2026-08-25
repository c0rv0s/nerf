import * as THREE from 'three';

const V = (x, y, z) => new THREE.Vector3(x, y, z);

// Tidebreaker's cruise/rise/breach/dive state machine and foam burst, shared
// with Sunken Reef. Only the surface height and safe central footprint differ.
export function addTidebreakerWhaleBehavior(scene, world, whaleParts, {
  surfaceY: oceanSurfaceY = 18,
  boundaryRadius = 120,
  onUpdate = null,
} = {}) {
  const whale = whaleParts.group;
  whale.position.set(145, oceanSurfaceY - 18, -55);
  whale.visible = true;
  scene.add(whale);
  world.whale = whale;

  const whaleSplashCount = 140;
  const whaleSplashPos = new Float32Array(whaleSplashCount * 3);
  const whaleSplashVel = Array.from({ length: whaleSplashCount }, () => V(0, 0, 0));
  const whaleSplashLife = new Float32Array(whaleSplashCount);
  const whaleSplashGeo = new THREE.BufferGeometry();
  whaleSplashGeo.setAttribute('position', new THREE.BufferAttribute(whaleSplashPos, 3));
  const whaleSplashMat = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: 0 } },
    vertexShader: `
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = clamp(140.0 / max(1.0, -mvPosition.z), 2.4, 11.0);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform float uOpacity;
      void main() {
        vec2 p = gl_PointCoord - vec2(0.5);
        float d = length(p);
        float alpha = 1.0 - smoothstep(0.18, 0.5, d);
        gl_FragColor = vec4(0.86, 0.95, 1.0, alpha * uOpacity);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const whaleSplash = new THREE.Points(whaleSplashGeo, whaleSplashMat);
  whaleSplash.frustumCulled = false;
  whaleSplash.visible = false;
  scene.add(whaleSplash);
  const burstWhaleSplash = (ox, oy, oz, power = 1) => {
    for (let i = 0; i < whaleSplashCount; i++) {
      const i3 = i * 3;
      const ang = Math.random() * Math.PI * 2;
      const rad = Math.random() * 4.5 * power;
      whaleSplashPos[i3] = ox + Math.cos(ang) * rad;
      whaleSplashPos[i3 + 1] = oy + Math.random() * 1.2;
      whaleSplashPos[i3 + 2] = oz + Math.sin(ang) * rad;
      whaleSplashVel[i].set(
        Math.cos(ang) * (2 + Math.random() * 10) * power,
        (4 + Math.random() * 14) * power,
        Math.sin(ang) * (2 + Math.random() * 10) * power,
      );
      whaleSplashLife[i] = 0.45 + Math.random() * 0.85;
    }
    whaleSplashGeo.attributes.position.needsUpdate = true;
    whaleSplash.visible = true;
    whaleSplashMat.uniforms.uOpacity.value = 0.95;
  };
  
  const WHALE_MAX_DEPTH = 40;
  const WHALE_BREACH_CLEAR = 35;
  const WHALE_BREACH_DUR = 4.6;
  // Keep Tidebreaker's breach clearance rule, measured from the reef's inner
  // combat radius. This makes breaches happen in the open ocean beyond the
  // invisible shark boundary, never through dense central coral.
  const whaleDistFromPlatform = (x, z) =>
    Math.max(0, Math.hypot(x, z) - boundaryRadius * 0.72);
  const whaleCruise = {
    angle: 0.55,
    radiusX: 168,
    radiusZ: 138,
    radiusPulse: 0,
    speed: 0.032,
    phase: 'cruise', // cruise | rise | breach | dive
    phaseT: 0,
    nextBreachT: 14 + Math.random() * 18,
    depthBias: 0.45,
    pitch: 0,
    roll: 0,
    breachSide: 1, // which way the belly rolls / which pec goes vertical
    splashExit: false,
    splashCrash: false,
  };
  world.anim.push((dt, t) => {
    const inBreach = whaleCruise.phase === 'breach';
    whaleCruise.angle += whaleCruise.speed * dt * (inBreach ? 0.42 : 1);
    whaleCruise.radiusPulse = Math.sin(t * 0.11) * 18;
    const a = whaleCruise.angle;
    const rx = whaleCruise.radiusX + whaleCruise.radiusPulse;
    const rz = whaleCruise.radiusZ + whaleCruise.radiusPulse * 0.7;
    const x = Math.cos(a) * rx;
    const z = Math.sin(a) * rz;
    const clear = whaleDistFromPlatform(x, z);
    const deepY = oceanSurfaceY - WHALE_MAX_DEPTH;
    const surfaceY = oceanSurfaceY - 1.1;
  
    whaleCruise.nextBreachT -= dt;
    whaleCruise.phaseT += dt;
  
    if (whaleCruise.phase === 'cruise') {
      whaleCruise.depthBias = 0.5 + 0.5 * Math.sin(t * 0.09 + a * 0.35);
      if (whaleCruise.nextBreachT <= 0 && clear >= WHALE_BREACH_CLEAR) {
        whaleCruise.phase = 'rise';
        whaleCruise.phaseT = 0;
        whaleCruise.breachSide = Math.random() < 0.5 ? 1 : -1;
      } else if (whaleCruise.nextBreachT <= 0) {
        whaleCruise.nextBreachT = 4 + Math.random() * 6;
      }
    } else if (whaleCruise.phase === 'rise') {
      // Climb hard from depth toward a launch just under the swell.
      whaleCruise.depthBias = Math.max(0, whaleCruise.depthBias - dt * 0.38);
      if (whaleCruise.depthBias <= 0.04 && clear >= WHALE_BREACH_CLEAR) {
        whaleCruise.phase = 'breach';
        whaleCruise.phaseT = 0;
        whaleCruise.splashExit = false;
        whaleCruise.splashCrash = false;
      } else if (whaleCruise.phaseT > 12 || clear < WHALE_BREACH_CLEAR * 0.85) {
        whaleCruise.phase = 'dive';
        whaleCruise.phaseT = 0;
      }
    } else if (whaleCruise.phase === 'breach') {
      if (clear < WHALE_BREACH_CLEAR * 0.7) {
        whaleCruise.phase = 'dive';
        whaleCruise.phaseT = 0;
      } else if (whaleCruise.phaseT > WHALE_BREACH_DUR) {
        whaleCruise.phase = 'dive';
        whaleCruise.phaseT = 0;
        whaleCruise.nextBreachT = 26 + Math.random() * 34;
      }
    } else if (whaleCruise.phase === 'dive') {
      whaleCruise.depthBias = Math.min(1, whaleCruise.depthBias + dt * 0.24);
      if (whaleCruise.depthBias >= 0.92 || whaleCruise.phaseT > 12) {
        whaleCruise.phase = 'cruise';
        whaleCruise.phaseT = 0;
        whaleCruise.nextBreachT = Math.max(whaleCruise.nextBreachT, 16 + Math.random() * 24);
      }
    }
  
    let y;
    let targetPitch = 0;
    let targetRoll = 0;
    let pecUp = 0.12;   // rotation lifting a pec toward vertical
    let pecOut = 0.18;  // the other pec stays more horizontal / trailing
    let targetFluke = 0;
    const side = whaleCruise.breachSide;
  
    if (inBreach) {
      // Classic humpback breach: steep ~55° exit, roll the belly open, one pec
      // vertical, most of the body clear, then a heavy side/belly crash.
      const u = Math.min(1, whaleCruise.phaseT / WHALE_BREACH_DUR);
      const launch = THREE.MathUtils.smoothstep(u, 0, 0.18);
      const peak = Math.sin(THREE.MathUtils.clamp(u / 0.52, 0, 1) * Math.PI);
      const crash = THREE.MathUtils.smoothstep(u, 0.52, 1);
      // Midsection sits near the waterline at peak so ~2/3 of the body clears.
      y = oceanSurfaceY
        + launch * 2.2
        + peak * 9.5
        - crash * 11.5
        + Math.sin(u * Math.PI) * 1.4;
      // Pitch: climb to ~55°, hold, then tuck through the crash.
      targetPitch = THREE.MathUtils.lerp(0.35, 0.98, launch)
        * (1 - crash * 0.15)
        - crash * 0.55;
      // Roll open to show the white belly / vertical pec silhouette.
      targetRoll = side * (
        THREE.MathUtils.lerp(0.05, 0.72, THREE.MathUtils.smoothstep(u, 0.05, 0.35))
        + crash * 0.35
      );
      pecUp = THREE.MathUtils.lerp(0.2, 1.35, THREE.MathUtils.smoothstep(u, 0.08, 0.4));
      pecOut = THREE.MathUtils.lerp(0.15, 0.55, THREE.MathUtils.smoothstep(u, 0.1, 0.45));
      if (crash > 0.2) {
        pecUp = THREE.MathUtils.lerp(pecUp, 0.35, crash);
        pecOut = THREE.MathUtils.lerp(pecOut, 0.8, crash);
      }
      // One hard launch stroke, then let the fluke trail and tuck into the
      // splashdown rather than beating continuously in the air.
      targetFluke = launch * 0.28
        + Math.sin(u * Math.PI * 2.15) * (1 - crash) * 0.13
        - crash * 0.24;
      whaleCruise.depthBias = 0;
  
      if (!whaleCruise.splashExit && u > 0.08) {
        whaleCruise.splashExit = true;
        burstWhaleSplash(x, oceanSurfaceY + 0.4, z, 1.15);
      }
      if (!whaleCruise.splashCrash && u > 0.72) {
        whaleCruise.splashCrash = true;
        burstWhaleSplash(x, oceanSurfaceY + 0.2, z, 1.35);
      }
    } else {
      const cruiseWobble = Math.sin(t * 0.19) * 2.4 + Math.sin(a * 1.7) * 1.6;
      y = THREE.MathUtils.lerp(surfaceY, deepY, whaleCruise.depthBias) + cruiseWobble;
      if (whaleCruise.phase === 'rise') {
        targetPitch = 0.48;
        pecUp = 0.22;
        pecOut = 0.28;
        targetFluke = Math.sin(t * 3.8) * 0.30;
      } else if (whaleCruise.phase === 'dive') {
        targetPitch = -0.42;
        targetRoll = 0;
        targetFluke = Math.sin(t * 3.0) * 0.23;
      } else {
        targetPitch = (0.5 - whaleCruise.depthBias) * 0.12;
        targetFluke = Math.sin(t * 2.25) * 0.16;
      }
    }
  
    whale.position.set(x, y, z);
    const tx = -Math.sin(a) * rx;
    const tz = Math.cos(a) * rz;
    const yaw = Math.atan2(-tz, tx);
    let dyaw = yaw - whale.rotation.y;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    // Hold heading steadier through the breach so the silhouette reads clean.
    whale.rotation.y += dyaw * (1 - Math.exp(-(inBreach ? 3.2 : 1.5) * dt));
    whaleCruise.pitch = THREE.MathUtils.damp(whaleCruise.pitch, targetPitch, inBreach ? 5.5 : 2.2, dt);
    whaleCruise.roll = THREE.MathUtils.damp(whaleCruise.roll, targetRoll, inBreach ? 4.5 : 2.0, dt);
    // +X forward: z = pitch (nose up), x = roll (belly open).
    whale.rotation.z = whaleCruise.pitch;
    whale.rotation.x = whaleCruise.roll;
    // Cetaceans propel themselves vertically with a horizontal fluke.
    whaleParts.fluke.rotation.z = THREE.MathUtils.damp(
      whaleParts.fluke.rotation.z, targetFluke, inBreach ? 6.5 : 4.8, dt);
  
    // Pecs scull gently for stability while submerged. During a breach one
    // flares almost vertically while its opposite trails against the roll.
    const swimBob = Math.sin(t * 1.35) * 0.08;
    if (!inBreach) {
      const baseLift = whaleCruise.phase === 'rise' ? 0.22
        : whaleCruise.phase === 'dive' ? 0.09 : 0.13;
      whaleParts.leftPec.rotation.x = THREE.MathUtils.damp(
        whaleParts.leftPec.rotation.x, -baseLift + swimBob, 4.2, dt);
      whaleParts.rightPec.rotation.x = THREE.MathUtils.damp(
        whaleParts.rightPec.rotation.x, baseLift - swimBob, 4.2, dt);
      whaleParts.leftPec.rotation.z = THREE.MathUtils.damp(
        whaleParts.leftPec.rotation.z, -0.06 + swimBob * 0.25, 3.5, dt);
      whaleParts.rightPec.rotation.z = THREE.MathUtils.damp(
        whaleParts.rightPec.rotation.z, 0.06 - swimBob * 0.25, 3.5, dt);
    } else if (side > 0) {
      whaleParts.leftPec.rotation.x = THREE.MathUtils.damp(
        whaleParts.leftPec.rotation.x, -pecUp, 5, dt);
      whaleParts.rightPec.rotation.x = THREE.MathUtils.damp(
        whaleParts.rightPec.rotation.x, pecOut * 0.35 + 0.15, 5, dt);
      whaleParts.leftPec.rotation.z = THREE.MathUtils.damp(
        whaleParts.leftPec.rotation.z, -0.25, 4, dt);
      whaleParts.rightPec.rotation.z = THREE.MathUtils.damp(
        whaleParts.rightPec.rotation.z, 0.45, 4, dt);
    } else {
      whaleParts.rightPec.rotation.x = THREE.MathUtils.damp(
        whaleParts.rightPec.rotation.x, pecUp, 5, dt);
      whaleParts.leftPec.rotation.x = THREE.MathUtils.damp(
        whaleParts.leftPec.rotation.x, -pecOut * 0.35 - 0.15, 5, dt);
      whaleParts.rightPec.rotation.z = THREE.MathUtils.damp(
        whaleParts.rightPec.rotation.z, 0.25, 4, dt);
      whaleParts.leftPec.rotation.z = THREE.MathUtils.damp(
        whaleParts.leftPec.rotation.z, -0.45, 4, dt);
    }
  
    // Splash particles.
    let splashAlive = 0;
    let splashMaxLife = 0;
    for (let i = 0; i < whaleSplashCount; i++) {
      if (whaleSplashLife[i] <= 0) continue;
      whaleSplashLife[i] -= dt;
      if (whaleSplashLife[i] <= 0) continue;
      splashAlive++;
      splashMaxLife = Math.max(splashMaxLife, whaleSplashLife[i]);
      const i3 = i * 3;
      whaleSplashVel[i].y -= 18 * dt;
      whaleSplashPos[i3] += whaleSplashVel[i].x * dt;
      whaleSplashPos[i3 + 1] += whaleSplashVel[i].y * dt;
      whaleSplashPos[i3 + 2] += whaleSplashVel[i].z * dt;
      if (whaleSplashPos[i3 + 1] < oceanSurfaceY) {
        whaleSplashPos[i3 + 1] = oceanSurfaceY;
        whaleSplashVel[i].y *= -0.15;
        whaleSplashVel[i].x *= 0.85;
        whaleSplashVel[i].z *= 0.85;
      }
    }
    if (splashAlive) {
      whaleSplash.visible = true;
      whaleSplashGeo.attributes.position.needsUpdate = true;
      whaleSplashMat.uniforms.uOpacity.value = THREE.MathUtils.clamp(splashMaxLife * 1.1, 0, 0.95);
    } else {
      whaleSplash.visible = false;
      whaleSplashMat.uniforms.uOpacity.value = 0;
    }
  });
  
  world.anim.push(() => onUpdate?.(whale));
  return whale;
}

