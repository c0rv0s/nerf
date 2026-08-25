// First-person player: pointer-lock look, WASD movement, firing, weapon switching,
// and a simple viewmodel blaster with recoil.
import * as THREE from 'three';
import { moveCharacter, moveCharacterUp, cardinal, clamp, pointInZoneXZ } from './engine.js';
import { WEAPONS, WEAPON_FEEL, WEAPON_ORDER, buildBlaster, blasterSkin, updateBlasterSkin, updateWeaponWarmupVisual, nextLoadedWeaponAfter } from './weapons.js';
import { sfx, startWhomperWarmup } from './audio.js';
import { stepJetpack } from './jetpack.js';
import {
  clearDrowningState, waterSpeedMultiplier, waterVerticalInput,
} from './water-movement.js';
import {
  applyGrapplePull, createGrappleVisual, findGrappleAnchor, updateGrappleVisual,
} from './grapple.js';
import { aiTex } from './maps.js';
import { HORSE_HEIGHT_DELTA } from './mount.js';

export class Player {
  constructor(camera, world) {
    this.camera = camera;
    this.world = world;
    this.team = 'blue';
    this.name = 'YOU';
    this.isPlayer = true;

    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.radius = world.mounted ? 0.58 : 0.45;
    this.height = world.mounted ? 2.65 + HORSE_HEIGHT_DELTA : 1.8;
    this.eyeHeight = world.mounted ? 2.48 + HORSE_HEIGHT_DELTA : 1.6;

    this.hp = 100;
    this.shield = 0;
    this.alive = true;
    this.kills = 0; this.deaths = 0;
    this.damageMult = 1;
    this.powerup = null;       // {kind, timeLeft}
    this.paralyzeT = 0;
    this.weapons = { blaster: true };  // owned guns — ammo alone isn't enough
    this.ammo = { blaster: Infinity };
    this.weapon = 'blaster';
    this.cooldown = 0;
    this.warmupT = 0;
    this.warmupWeapon = null;
    this.warmupAudioStop = null;
    this.coyote = 0;           // grace after leaving ground (curved asteroids!)
    this.jumpBuffer = 0;       // grace after pressing jump

    this.yaw = 0; this.pitch = 0;
    // Escher worlds (PRISM RUN): a full body frame that can tilt onto any wall.
    // up = which way is "down" (negated); fwd = look/run direction in that plane.
    this.up = new THREE.Vector3(0, 1, 0);        // physics up (snaps at a transition)
    this.frameUp = new THREE.Vector3(0, 1, 0);   // camera up — eases toward `up` (smooth roll)
    this.frameFwd = new THREE.Vector3(0, 0, -1); // camera heading in that frame (mouse yaw turns it)
    this._camSnap = true;
    this._nrm = new THREE.Vector3();
    this.djumpTime = 0;        // double-jump powerup timer
    this.jetpack = null;       // {fuel, cooldown, active}; cleared on death
    this.grapple = false;      // Canopy pickup; retained until death
    this.dualBlaster = false;  // Red Rock Range second Secret Shot; retained until death
    this._dualBlasterNextLeft = false;
    this._airJumped = false;
    this.keys = {};
    this.moveInput = { strafe: 0, forward: 0 };
    this.firing = false;
    this.grounded = false;
    this.recoil = 0;
    this.leftRecoil = 0;
    this.cameraKick = 0;
    this.muzzleT = 0;
    this.leftMuzzleT = 0;
    this.equipT = 0;
    this.lookSwayX = 0;
    this.lookSwayY = 0;
    this.stepDistance = 0;
    // Visual suspension for faceted ground. Physics remains exact, while the
    // eye height absorbs the small frame-to-frame Y corrections produced when
    // the capsule crosses from one terrain polygon to the next.
    this._cameraRideY = null;
    this.wasGrounded = false;
    this.wantJump = false;
    this.horseHeading = 0;
    this.gallopStamina = world.horseGallopDuration || 0;
    this.galloping = false;
    this.gallopExhausted = false;
    this.grappleAttached = false;
    this.grappleAnchor = null;
    this.grappleRopeLength = 0;
    this.grappleVisual = world.grappleEnabled
      ? createGrappleVisual(camera.parent, 0xa8ff70)
      : null;

    this.buildViewmodel();
  }

  buildViewmodel() {
    // One model per weapon; the active one is shown
    const g = new THREE.Group();
    this.vmWeapons = {};
    for (const id of WEAPON_ORDER) {
      const m = buildBlaster(id);
      m.visible = id === 'blaster';
      g.add(m);
      this.vmWeapons[id] = m;
    }
    g.scale.setScalar(0.55);
    g.position.set(0.32, -0.3, -0.55);
    g.rotation.y = 0.06;
    this.viewmodel = g;
    this.camera.add(g);

    // Red Rock Range can grant a second Secret Shot. It lives in its own
    // left-hand viewmodel so switching weapons hides it without disturbing
    // the normal right-hand weapon hierarchy.
    this.dualBlasterViewmodel = buildBlaster('blaster');
    this.dualBlasterViewmodel.scale.setScalar(0.55);
    this.dualBlasterViewmodel.position.set(-0.32, -0.3, -0.55);
    this.dualBlasterViewmodel.rotation.y = -0.06;
    this.dualBlasterViewmodel.visible = false;
    this.camera.add(this.dualBlasterViewmodel);

    if (this.world.mounted) {
      const horse = new THREE.Group();
      const coatTexture = aiTex('horse-coat', 1.7, 1.7);
      const coat = new THREE.MeshStandardMaterial({
        color: coatTexture.map ? 0xffffff : 0xa6532b,
        roughness: 0.88, ...coatTexture,
      });
      const mane = new THREE.MeshStandardMaterial({ color: 0x24170f, roughness: 0.94 });
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.55, 1.05), coat);
      head.position.set(0, -0.62, -1.25);
      head.rotation.x = -0.12;
      horse.add(head);
      for (const side of [-1, 1]) {
        const ear = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.42, 6), coat);
        ear.position.set(side * 0.16, -0.24, -1.53);
        ear.rotation.x = -0.18;
        horse.add(ear);
      }
      const forelock = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.5, 6), mane);
      forelock.position.set(0, -0.34, -1.54);
      forelock.rotation.x = Math.PI * 0.42;
      horse.add(forelock);
      horse.traverse(child => { if (child.isMesh) child.castShadow = true; });
      this.horseViewmodel = horse;
      this.camera.add(horse);
    }

    // The grapple is an innate left-hand tool, not part of the equipped-gun
    // hierarchy. Keeping it in a separate camera child means weapon recoil,
    // equip kick, and powerup skins can never move or recolor it.
    if (this.world.grappleEnabled) {
      const launcher = new THREE.Group();
      const shell = new THREE.MeshStandardMaterial({
        color: 0xffffff, roughness: 0.5, metalness: 0.34,
        emissive: 0x18381d, emissiveIntensity: 0.13,
        ...aiTex('canopy-grapple', 0.72, 0.72),
      });
      const brass = new THREE.MeshStandardMaterial({
        color: 0xc59135, roughness: 0.34, metalness: 0.76,
      });
      const glow = new THREE.MeshBasicMaterial({ color: 0xbaff70, toneMapped: false });
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.3, 0.72), shell);
      body.rotation.z = 0.05;
      launcher.add(body);
      const topHousing = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.18, 0.42), shell);
      topHousing.position.set(0, 0.2, -0.02);
      launcher.add(topHousing);
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.15, 0.55, 10), brass);
      barrel.name = 'canopy-grapple-barrel';
      barrel.rotation.x = Math.PI / 2;
      barrel.position.z = -0.56;
      launcher.add(barrel);
      const coil = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.038, 7, 14), glow);
      coil.position.z = -0.85;
      launcher.add(coil);
      const sideSpool = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.13, 10), brass);
      sideSpool.rotation.z = Math.PI / 2;
      sideSpool.position.set(0.31, 0.02, 0.08);
      launcher.add(sideSpool);
      const grip = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.52, 0.25), shell);
      grip.name = 'canopy-grapple-hand-grip';
      grip.position.set(0, -0.35, 0.16);
      grip.rotation.x = -0.24;
      launcher.add(grip);
      const gripCollar = new THREE.Mesh(new THREE.BoxGeometry(0.31, 0.1, 0.3), brass);
      gripCollar.name = 'canopy-grapple-grip-collar';
      gripCollar.position.set(0, -0.12, 0.07);
      gripCollar.rotation.x = -0.08;
      launcher.add(gripCollar);
      const status = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.065, 0.22), glow);
      status.position.set(0, 0.31, -0.02);
      launcher.add(status);
      const muzzleAnchor = new THREE.Object3D();
      muzzleAnchor.name = 'canopy-grapple-muzzle';
      muzzleAnchor.position.set(0, 0, -0.87);
      launcher.add(muzzleAnchor);
      launcher.name = 'canopy-grapple-launcher';

      const grappleViewmodel = new THREE.Group();
      grappleViewmodel.add(launcher);
      grappleViewmodel.scale.setScalar(0.48);
      grappleViewmodel.position.set(-0.37, -0.28, -0.68);
      grappleViewmodel.rotation.set(-0.04, -0.12, -0.06);
      this.grappleLauncher = launcher;
      this.grappleMuzzle = muzzleAnchor;
      this.grappleViewmodel = grappleViewmodel;
      grappleViewmodel.visible = this.grapple;
      this.camera.add(grappleViewmodel);
    }

    const flashMat = new THREE.SpriteMaterial({
      color: 0xffe2a0, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false,
    });
    this.muzzleFlash = new THREE.Sprite(flashMat);
    this.muzzleFlash.position.set(0.27, -0.16, -0.96);
    this.muzzleFlash.scale.setScalar(0.01);
    this.camera.add(this.muzzleFlash);
    this.leftMuzzleFlash = new THREE.Sprite(flashMat.clone());
    this.leftMuzzleFlash.position.set(-0.27, -0.16, -0.96);
    this.leftMuzzleFlash.scale.setScalar(0.01);
    this.camera.add(this.leftMuzzleFlash);
  }

  showWeaponModel(id) {
    for (const [wid, m] of Object.entries(this.vmWeapons)) m.visible = wid === id;
    this.syncDualBlasterViewmodel();
  }

  syncDualBlasterViewmodel() {
    if (this.dualBlasterViewmodel) {
      this.dualBlasterViewmodel.visible = !!(this.dualBlaster && this.alive && this.weapon === 'blaster');
      if (!this.dualBlasterViewmodel.visible && this.leftMuzzleFlash) {
        this.leftMuzzleT = 0;
        this.leftMuzzleFlash.material.opacity = 0;
      }
    }
  }

  // Gold/silver powerup skin on the gun in hand ('gold' | 'silver' | null)
  setSkin(kind) {
    const mat = blasterSkin(kind);
    for (const m of Object.values(this.vmWeapons)) {
      const shell = m.children[0];
      shell.material = kind ? mat : (shell._baseMaterial || mat);
    }
    const leftShell = this.dualBlasterViewmodel?.children[0];
    if (leftShell) leftShell.material = kind ? mat : (leftShell._baseMaterial || mat);
  }

  spawn(pos) {
    this.cancelWeaponWarmup();
    this.detachGrapple();
    this.pos.copy(pos);
    this.vel.set(0, 0, 0);
    this.hp = 100;
    this.shield = 0;
    this.alive = true;
    this.damageMult = 1;
    this.powerup = null;
    this.paralyzeT = 0;
    this.weapons = { blaster: true };
    this.ammo = { blaster: Infinity };
    this.weapon = 'blaster';
    this.showWeaponModel('blaster'); // hand model back to blaster
    this.setSkin(null);
    this.yaw = Math.atan2(pos.x, pos.z); // face map center
    this.horseHeading = this.yaw;
    this.gallopStamina = this.world.horseGallopDuration || 0;
    this.galloping = false;
    this.gallopExhausted = false;
    this.pitch = 0;
    this.up.set(0, 1, 0);
    this._camSnap = true;   // snap the roll on spawn, don't ease from stale
    this.djumpTime = 0;
    this.jetpack = null;
    this.grapple = false;
    if (this.grappleViewmodel) this.grappleViewmodel.visible = false;
    this.dualBlaster = false;
    this._dualBlasterNextLeft = false;
    this.syncDualBlasterViewmodel();
    this._airJumped = false;
    this.recoil = 0;
    this.leftRecoil = 0;
    this.cameraKick = 0;
    this.muzzleT = 0;
    this.leftMuzzleT = 0;
    this.equipT = 0;
    this.stepDistance = 0;
    this._cameraRideY = null;
    clearDrowningState(this);
    if (this.world.escher) {
      // spawn oriented to whatever surface you land on (floor, wall or ceiling)
      const nf = this._nearestSurfaceUpAt(this.pos);
      if (nf) this.up.copy(nf);
      // a heading perpendicular to up (aim into the room)
      const ref = Math.abs(this.up.y) > 0.7 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
      const f = ref.addScaledVector(this.up, -ref.dot(this.up)).normalize();
      this._moveFwd = f.clone();
      this.frameUp.copy(this.up);
      this.frameFwd.copy(f);
      this.pitch = 0;
    }
  }

  onMouseMove(dx, dy) {
    const s = 0.0022;
    this.lookSwayX = clamp(this.lookSwayX + dx * 0.00032, -0.045, 0.045);
    this.lookSwayY = clamp(this.lookSwayY + dy * 0.00024, -0.035, 0.035);
    if (this.world.escher) {
      // yaw turns your heading within the surface plane; pitch is a plain
      // scalar (can't accumulate roll, so you can always look straight up).
      this.frameFwd.applyAxisAngle(this.frameUp, -dx * s).normalize();
      this.pitch = clamp(this.pitch - dy * s, -1.45, 1.45);
    } else {
      this.yaw -= dx * s;
      this.pitch = clamp(this.pitch - dy * s, -1.5, 1.5);
    }
  }

  setMoveInput(strafe, forward) {
    this.moveInput.strafe = clamp(Number(strafe) || 0, -1, 1);
    this.moveInput.forward = clamp(Number(forward) || 0, -1, 1);
  }

  toggleGrapple() {
    if (!this.world.grappleEnabled || !this.grapple || !this.alive) return false;
    if (this.grappleAttached) {
      this.detachGrapple();
      return false;
    }
    const direction = new THREE.Vector3();
    this.camera.getWorldDirection(direction);
    const hit = findGrappleAnchor(this.world, this.camera.position, direction);
    if (!hit) return false;
    this.grappleAttached = true;
    this.grappleAnchor = hit.point;
    this.grappleRopeLength = Math.max(4.2, hit.point.distanceTo(this.pos) * 0.82);
    this._syncGrappleVisual();
    return true;
  }

  detachGrapple() {
    this.grappleAttached = false;
    this.grappleAnchor = null;
    this.grappleRopeLength = 0;
    updateGrappleVisual(this.grappleVisual, null, null, false);
  }

  _syncGrappleVisual() {
    if (!this.grappleVisual) return;
    const start = new THREE.Vector3();
    if (this.grappleMuzzle) this.grappleMuzzle.getWorldPosition(start);
    else start.copy(this.camera.position);
    updateGrappleVisual(
      this.grappleVisual,
      start,
      this.grappleAnchor,
      this.grappleAttached && this.alive,
    );
  }

  _forwardInput() {
    const keyboard = (this.keys['KeyW'] ? 1 : 0) - (this.keys['KeyS'] ? 1 : 0);
    return clamp(keyboard + this.moveInput.forward, -1, 1);
  }

  _strafeInput() {
    const keyboard = (this.keys['KeyD'] ? 1 : 0) - (this.keys['KeyA'] ? 1 : 0);
    return clamp(keyboard + this.moveInput.strafe, -1, 1);
  }

  switchWeapon(id) {
    if (id !== 'blaster' && !(this.weapons[id] && this.ammo[id] > 0)) return;
    if (WEAPONS[id] && id !== this.weapon) {
      this.cancelWeaponWarmup();
      this.weapon = id;
      this.cooldown = Math.max(this.cooldown, 0.25);
      this.showWeaponModel(id);
      this.equipT = 1;
      sfx('equip');
    }
  }

  cycleWeapon(dir) {
    const owned = WEAPON_ORDER.filter(w => w === 'blaster' || (this.weapons[w] && this.ammo[w] > 0));
    const i = owned.indexOf(this.weapon);
    this.switchWeapon(owned[(i + dir + owned.length) % owned.length]);
  }

  cancelWeaponWarmup() {
    this.warmupAudioStop?.();
    this.warmupAudioStop = null;
    this.warmupT = 0;
    this.warmupWeapon = null;
    updateWeaponWarmupVisual(this.vmWeapons?.whomper, -1);
  }

  fireCurrentWeapon(fire, w) {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    // launch from the gun muzzle (right and below the eye), not the face
    const right = new THREE.Vector3().crossVectors(dir, this.camera.up).normalize();
    const visualScale = this.world.characterVisualScale?.(this) || 1;
    const handSide = this.weapon === 'blaster' && this.dualBlaster
      ? (this._dualBlasterNextLeft ? -1 : 1)
      : 1;
    if (this.weapon === 'blaster' && this.dualBlaster) {
      this._dualBlasterNextLeft = !this._dualBlasterNextLeft;
    }
    const origin = this.camera.position.clone()
      .addScaledVector(dir, 1.1 * visualScale)
      .addScaledVector(right, handSide * 0.18 * visualScale)
      .addScaledVector(this.camera.up, -0.22 * visualScale);
    fire(this, origin, dir, this.weapon);
    if (this.weapon !== 'blaster') this.ammo[this.weapon]--;
    // Warmup weapons pay their entire firing delay before the shot releases.
    const cadence = this.weapon === 'blaster' && this.dualBlaster ? 2 : 1;
    this.cooldown = w.warmup ? 0 : 1 / (w.rof * cadence);
    const feel = WEAPON_FEEL[this.weapon] || WEAPON_FEEL.blaster;
    if (handSide < 0) this.leftRecoil = Math.min(2.2, this.leftRecoil + feel.recoil);
    else this.recoil = Math.min(2.2, this.recoil + feel.recoil);
    this.cameraKick = Math.min(0.035, this.cameraKick + feel.camera);
    if (handSide < 0) this.leftMuzzleT = 0.065;
    else this.muzzleT = 0.065;
    this.muzzleStrength = feel.flash;
    if (this.weapon !== 'blaster' && this.ammo[this.weapon] <= 0) {
      this.switchWeapon(nextLoadedWeaponAfter(this.weapon, this.weapons, this.ammo));
    }
  }

  update(dt, fire) {
    if (!this.alive) {
      this.detachGrapple();
      this.cancelWeaponWarmup();
      updateWeaponWarmupVisual(this.vmWeapons.whomper, -1);
      return;
    }

    const wasGrounded = this.grounded;
    const fallSpeed = this.vel.y;

    if (this.speedTime > 0) { // speed powerup wearing off
      this.speedTime -= dt;
      if (this.speedTime <= 0) this.speedMult = 1;
    }
    if (this.world.escher) this._moveEscher(dt);
    else this._moveNormal(dt);
    this._syncGrappleVisual();

    // Firing
    this.cooldown -= dt;
    const w = WEAPONS[this.weapon];
    const hasAmmo = this.weapon === 'blaster' || this.ammo[this.weapon] > 0;
    if (w.warmup) {
      if (!this.firing || !hasAmmo || this.cooldown > 0) {
        this.cancelWeaponWarmup();
      } else if (this.warmupWeapon !== this.weapon) {
        this.warmupWeapon = this.weapon;
        this.warmupT = w.warmup;
        this.warmupAudioStop = startWhomperWarmup(null, w.warmup);
      } else {
        this.warmupT -= dt;
        if (this.warmupT <= 0) {
          this.cancelWeaponWarmup();
          this.fireCurrentWeapon(fire, w);
        }
      }
    } else {
      this.cancelWeaponWarmup();
      if (this.firing && this.cooldown <= 0 && hasAmmo) this.fireCurrentWeapon(fire, w);
    }
    if (this.firing && !hasAmmo) {
      sfx('dry');
      this.switchWeapon(nextLoadedWeaponAfter(this.weapon, this.weapons, this.ammo));
    }

    // Layered viewmodel response: locomotion, look inertia, equip dip, weapon kick.
    const feel = WEAPON_FEEL[this.weapon] || WEAPON_FEEL.blaster;
    this.recoil *= Math.exp(-feel.return * dt);
    this.leftRecoil *= Math.exp(-feel.return * dt);
    this.cameraKick *= Math.exp(-18 * dt);
    this.equipT *= Math.exp(-8.5 * dt);
    this.lookSwayX *= Math.exp(-10 * dt);
    this.lookSwayY *= Math.exp(-10 * dt);
    const now = performance.now();
    const warming = this.warmupWeapon === this.weapon && !!w.warmup;
    updateWeaponWarmupVisual(
      this.vmWeapons.whomper,
      warming ? 1 - this.warmupT / w.warmup : -1,
      now * 0.001,
    );
    // Every map registers swimmable areas in waterZones. Splash footsteps are
    // reserved for wading: feet grounded, with the player's head above water.
    // Swimming or walking along a fully submerged riverbed stays silent.
    const water = this._environmentState().water;
    const inWater = !!water;
    const underwater = inWater && this.pos.y + this.eyeHeight < water.surfaceY - 0.1;
    const wading = inWater && this.grounded && !underwater;
    const moving = (this.grounded || inWater) ? (this._speedRatio || 0) : 0;
    const bobY = Math.sin(now * 0.012) * moving * 0.012;
    const bobX = Math.cos(now * 0.006) * moving * 0.008;
    this.viewmodel.position.set(
      0.3 + bobX - this.lookSwayX * 0.7,
      -0.28 + bobY - this.equipT * 0.2 + this.lookSwayY * 0.35,
      -0.6 + this.recoil * 0.082,
    );
    this.viewmodel.rotation.set(
      this.recoil * 0.22 + this.lookSwayY,
      0.06 - this.lookSwayX,
      this.equipT * 0.12 - bobX * 0.8,
    );
    this.dualBlasterViewmodel.position.set(
      -0.3 - bobX - this.lookSwayX * 0.7,
      -0.28 + bobY - this.equipT * 0.2 + this.lookSwayY * 0.35,
      -0.6 + this.leftRecoil * 0.082,
    );
    this.dualBlasterViewmodel.rotation.set(
      this.leftRecoil * 0.22 + this.lookSwayY,
      -0.06 - this.lookSwayX,
      -this.equipT * 0.12 + bobX * 0.8,
    );
    if (this.grappleViewmodel) {
      this.grappleViewmodel.position.set(
        -0.37 - bobX * 0.7 - this.lookSwayX * 0.24,
        -0.28 + bobY * 0.7 + this.lookSwayY * 0.18,
        -0.68,
      );
      this.grappleViewmodel.rotation.set(
        -0.04 + this.lookSwayY * 0.28,
        -0.12 - this.lookSwayX * 0.28,
        -0.06 + bobX * 0.35,
      );
    }
    if (this.horseViewmodel) {
      const gait = this.galloping ? 0.019 : 0.013;
      const stride = Math.sin(now * (this.galloping ? 0.021 : 0.013)) * moving;
      const horseViewYaw = Math.atan2(
        Math.sin(this.horseHeading - this.yaw),
        Math.cos(this.horseHeading - this.yaw),
      );
      this.horseViewmodel.position.set(0, stride * 0.018, Math.abs(stride) * gait);
      this.horseViewmodel.rotation.set(
        stride * 0.012,
        horseViewYaw,
        Math.cos(now * 0.009) * moving * 0.006,
      );
    }
    this.camera.rotateX(this.cameraKick);

    this.muzzleT = Math.max(0, this.muzzleT - dt);
    const flash = this.muzzleT > 0 ? this.muzzleT / 0.065 : 0;
    this.muzzleFlash.material.opacity = flash * 0.82;
    const flashScale = flash * 0.24 * (this.muzzleStrength || 1);
    this.muzzleFlash.scale.set(flashScale * 1.35, flashScale, 1);
    this.muzzleFlash.material.rotation = now * 0.018;
    this.leftMuzzleT = Math.max(0, this.leftMuzzleT - dt);
    const leftFlash = this.leftMuzzleT > 0 ? this.leftMuzzleT / 0.065 : 0;
    this.leftMuzzleFlash.material.opacity = leftFlash * 0.82;
    const leftFlashScale = leftFlash * 0.24 * (this.muzzleStrength || 1);
    this.leftMuzzleFlash.scale.set(leftFlashScale * 1.35, leftFlashScale, 1);
    this.leftMuzzleFlash.material.rotation = -now * 0.018;

    if (this.grounded && !wasGrounded && fallSpeed < -4.5) sfx('land');
    const canStep = this.grounded && (!inWater || wading);
    if (canStep && moving > 0.16) {
      const moveScale = this.world.characterMoveScale?.(this) || 1;
      this.stepDistance += this.world.playerSpeed * moveScale * moving * dt;
      const stepLength = wading ? 2.7 : 3.25;
      if (this.stepDistance >= stepLength) {
        this.stepDistance %= stepLength;
        sfx(wading ? 'splashstep' : 'footstep');
      }
    } else if (!canStep) {
      this.stepDistance = Math.min(this.stepDistance, 2.2);
    }

    // Powerup timer
    if (this.powerup) {
      updateBlasterSkin(this.powerup.kind, now * 0.001);
      this.powerup.timeLeft -= dt;
      if (this.powerup.timeLeft <= 0) {
        this.powerup = null;
        this.damageMult = 1;
        this.setSkin(null);
      }
    }
  }

  // ---- normal, Y-gravity movement + camera (all maps except PRISM RUN) ----
  _suspendedCameraY(targetY, dt) {
    if (!Number.isFinite(this._cameraRideY) || !this.grounded || dt <= 0) {
      this._cameraRideY = targetY;
      return targetY;
    }
    // A short, bounded exponential suspension removes polygon chatter without
    // letting the camera materially separate from the player's real capsule.
    // Mounted movement gets a touch more travel to evoke the horse's body;
    // aim rotation and input sensitivity are deliberately untouched.
    const maxTravel = this.world.mounted ? 0.2 : 0.12;
    const response = this.world.mounted ? 9 : 12;
    this._cameraRideY += (targetY - this._cameraRideY) * (1 - Math.exp(-response * dt));
    this._cameraRideY = clamp(this._cameraRideY, targetY - maxTravel, targetY + maxTravel);
    return this._cameraRideY;
  }

  _moveNormal(dt) {
    this._vineExitT = Math.max(0, (this._vineExitT || 0) - dt);
    const paralyzed = this.paralyzeT > 0;
    if (paralyzed) {
      this.paralyzeT = Math.max(0, this.paralyzeT - dt);
      this.wantJump = false;
      this.firing = false;
    }
    const env = this._environmentState();
    const moveScale = this.world.characterMoveScale?.(this) || 1;
    const traction = THREE.MathUtils.clamp(this.world.characterTraction?.(this) ?? 1, 0.04, 1);
    let speed = this.world.playerSpeed * moveScale * (this.speedMult || 1) * env.speedMult;
    const f = paralyzed ? 0 : this._forwardInput();
    const s = paralyzed ? 0 : this._strafeInput();
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    let wx = (-sin * f + cos * s), wz = (-cos * f - sin * s);
    const wl = Math.hypot(wx, wz);
    if (wl > 0) { wx /= wl; wz /= wl; }

    if (this.world.mounted) {
      const maxStamina = this.world.horseGallopDuration || 15;
      const shiftHeld = !!(this.keys.ShiftLeft || this.keys.ShiftRight);
      if (!shiftHeld && this.gallopStamina >= Math.min(3, maxStamina)) this.gallopExhausted = false;
      const wantsGallop = shiftHeld && !this.gallopExhausted && wl > 0.05;
      this.galloping = wantsGallop && this.gallopStamina > 0.001 && !paralyzed;
      if (this.galloping) {
        this.gallopStamina = Math.max(0, this.gallopStamina - dt);
        if (this.gallopStamina <= 0.001) this.gallopExhausted = true;
        speed = (this.world.horseGallopSpeed || speed * 1.55) * moveScale * (this.speedMult || 1) * env.speedMult;
      } else {
        this.gallopStamina = Math.min(maxStamina,
          this.gallopStamina + (this.world.horseGallopRecharge || 0.65) * dt);
      }
      if (wl > 0.05) {
        const desiredHeading = Math.atan2(-wx, -wz);
        const difference = Math.atan2(
          Math.sin(desiredHeading - this.horseHeading),
          Math.cos(desiredHeading - this.horseHeading),
        );
        const turn = clamp(difference,
          -(this.world.horseTurnRate || 1.45) * dt,
          (this.world.horseTurnRate || 1.45) * dt);
        this.horseHeading += turn;
        wx = -Math.sin(this.horseHeading) * Math.min(1, wl);
        wz = -Math.cos(this.horseHeading) * Math.min(1, wl);

        // A horse arcs into a new travel direction; it never keeps a large
        // sideways velocity while its body points somewhere else. Remove the
        // lateral component quickly while preserving forward momentum.
        const along = this.vel.x * wx + this.vel.z * wz;
        const lateralDamp = Math.exp(-7.5 * dt);
        this.vel.x = wx * along + (this.vel.x - wx * along) * lateralDamp;
        this.vel.z = wz * along + (this.vel.z - wz * along) * lateralDamp;
      }
    }

    const prevHs = Math.hypot(this.vel.x, this.vel.z);
    const accel = this.grounded ? 60 * traction : 18;
    this.vel.x += wx * speed * accel * dt * 0.12;
    this.vel.z += wz * speed * accel * dt * 0.12;
    const damp = this.grounded ? Math.exp(-8 * traction * dt) : Math.exp(-0.4 * dt);
    if (wl === 0 && this.grounded) { this.vel.x *= damp; this.vel.z *= damp; }
    if (paralyzed) { this.vel.x *= Math.exp(-12 * dt); this.vel.z *= Math.exp(-12 * dt); }
    const hs = Math.hypot(this.vel.x, this.vel.z);
    const cap = this.grounded && traction >= 0.98 ? speed : Math.max(speed, prevHs);
    if (hs > cap) { this.vel.x *= cap / hs; this.vel.z *= cap / hs; }
    this._speedRatio = Math.min(hs / speed, 1);

    const vine = env.vine;
    const waterfall = env.waterfall;
    const water = env.water;
    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    if (this.wantJump) { this.jumpBuffer = 0.15; this.wantJump = false; }
    if (this.djumpTime > 0) this.djumpTime -= dt;
    if (paralyzed) {
      this.jumpBuffer = 0;
      this.wantJump = false;
      this.coyote = 0;
    } else if (vine) {
      this._applyVineMotion(dt, vine);
      this.jumpBuffer = 0;
      this.wantJump = false;
      this.coyote = 0;
    } else if (waterfall) {
      this._applyWaterfallMotion(dt);
      this.jumpBuffer = 0;
      this.wantJump = false;
      this.coyote = 0;
    } else if (water) {
      this._applyWaterMotion(water, dt, speed);
      this.jumpBuffer = 0;
      this.wantJump = false;
      this.coyote = 0.04;
    } else if (this.jumpBuffer > 0 && this.coyote > 0) {
      this.vel.y = this.world.jumpVel;
      this.jumpBuffer = 0; this.coyote = 0; sfx('jump');
    } else if (this.jumpBuffer > 0 && !this.grounded && this.djumpTime > 0 && !this._airJumped) {
      this.vel.y = this.world.jumpVel * 1.5;
      this._airJumped = true; this.jumpBuffer = 0; sfx('boing');
    }

    // Death-bound jetpack equipment. Space supplies capped upward thrust for
    // eight total seconds of fuel; an empty pack locks for four seconds, then
    // refills. Releasing Space preserves the remaining fuel for later bursts.
    if (this.jetpack) {
      const canThrust = this.keys['Space'] && !paralyzed && !vine && !waterfall && !water && !env.lava;
      stepJetpack(this.jetpack, this.vel, dt, canThrust);
    }

    if (this.grapple && !paralyzed && !waterfall) applyGrapplePull(this, dt);

    this.grounded = moveCharacter(this, this.world, dt);
    if (this.grounded) this._airJumped = false;
    this.coyote = this.grounded ? 0.14 : Math.max(0, this.coyote - dt);

    this.camera.up.set(0, 1, 0);
    const visualScale = this.world.characterVisualScale?.(this) || 1;
    const targetEyeY = this.pos.y + this.eyeHeight * visualScale;
    this.camera.position.set(this.pos.x, this._suspendedCameraY(targetEyeY, dt), this.pos.z);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.yaw);
    this.camera.rotateX(this.pitch);
  }

  /* ---- PRISM RUN: walk on any surface. Gravity pulls toward the nearest
     surface (you can't fall out); movement is relative to a FREE-LOOK camera
     that never rolls — your feet stick to walls/ceilings but the view stays a
     normal FPS camera, so aiming feels identical everywhere. ---- */
  _moveEscher(dt) {
    const up = this.up;
    const wasGrounded = this.grounded;
    const beforeMove = this.pos.clone();
    // walk toward your heading, flattened onto the surface you're on
    let fwd = this.frameFwd.clone().addScaledVector(up, -this.frameFwd.dot(up));
    if (fwd.lengthSq() < 0.04 && this._moveFwd) fwd.copy(this._moveFwd);
    fwd.normalize();
    this._moveFwd = fwd.clone();
    const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
    const moveScale = this.world.characterMoveScale?.(this) || 1;
    const speed = this.world.playerSpeed * moveScale * (this.speedMult || 1) * this._waterSpeedMult();
    const f = this._forwardInput();
    const s = this._strafeInput();
    const want = new THREE.Vector3().addScaledVector(fwd, f).addScaledVector(right, s);
    const wl = want.length();
    if (wl > 1) want.multiplyScalar(1 / wl);

    const vUp = this.vel.dot(up);
    const planar = this.vel.clone().addScaledVector(up, -vUp);
    const prevHs = planar.length();
    const accel = this.grounded ? 60 : 18;
    planar.addScaledVector(want, speed * accel * dt * 0.12);
    if (wl === 0 && this.grounded) planar.multiplyScalar(Math.exp(-8 * dt));
    const hs = planar.length();
    const cap = this.grounded ? speed : Math.max(speed, prevHs);
    if (hs > cap) planar.multiplyScalar(cap / hs);
    this._speedRatio = Math.min(hs / speed, 1);
    this.vel.copy(planar).addScaledVector(up, vUp);

    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    if (this.wantJump) { this.jumpBuffer = 0.15; this.wantJump = false; }
    if (this.djumpTime > 0) this.djumpTime -= dt;
    let jumped = false;
    if (this.jumpBuffer > 0 && this.coyote > 0) {
      this.vel.addScaledVector(up, this.world.jumpVel - this.vel.dot(up));
      this.jumpBuffer = 0; this.coyote = 0; jumped = true; sfx('jump');
    } else if (this.jumpBuffer > 0 && !this.grounded && this.djumpTime > 0 && !this._airJumped) {
      this.vel.addScaledVector(up, this.world.jumpVel * 1.5 - this.vel.dot(up));
      this._airJumped = true; this.jumpBuffer = 0; jumped = true; sfx('boing');
    }

    // Airborne: gravity pulls toward the NEAREST surface (shell face OR any
    // interior structure) so you always fall onto something — never the void.
    this._climbLock = Math.max(0, (this._climbLock || 0) - dt);
    if (!this.grounded && this._climbLock <= 0) {
      const nf = this._nearestSurfaceUp();
      if (nf && nf.dot(this.up) < 0.99) this.up.copy(nf);
    }

    this.grounded = moveCharacterUp(this, this.world, dt, this._nrm);
    const climbed = this.grounded && this._climb();
    if (!climbed && wasGrounded && !jumped && this._wrapBeamEdge(beforeMove)) this.grounded = true;
    if (this.grounded) this._airJumped = false;
    this.coyote = this.grounded ? 0.14 : Math.max(0, this.coyote - dt);

    // Camera: the frame's up eases toward the physics up (smooth roll — a wall
    // becomes your floor), carrying the heading with it; yaw/pitch sit on top
    // and stay instant. Pitch is applied fresh each frame, so it never drifts.
    if (this.frameUp.dot(up) < 0.99999) {
      const q = new THREE.Quaternion().setFromUnitVectors(this.frameUp, up);
      const partial = new THREE.Quaternion().slerp(q, this._camSnap ? 1 : 1 - Math.exp(-13 * dt));
      this.frameUp.applyQuaternion(partial);
      this.frameFwd.applyQuaternion(partial);
    }
    this._camSnap = false;
    this.frameFwd.addScaledVector(this.frameUp, -this.frameFwd.dot(this.frameUp)).normalize();
    const cRight = new THREE.Vector3().crossVectors(this.frameFwd, this.frameUp).normalize();
    const look = this.frameFwd.clone().applyAxisAngle(cRight, this.pitch);
    const eye = this.pos.clone().addScaledVector(up, this.eyeHeight);
    this.camera.up.copy(this.frameUp);
    this.camera.position.copy(eye);
    this.camera.lookAt(eye.add(look));
  }

  _waterSpeedMult() {
    return this._environmentState().speedMult;
  }

  _environmentState() {
    const px = this.pos.x, py = this.pos.y, pz = this.pos.z;
    const eyeY = py + this.eyeHeight;
    const midY = py + this.height * 0.5;
    let lava = false;
    for (const z of this.world.lavaZones || []) {
      if (
        pointInZoneXZ(z, px, pz) &&
        py < z.maxY
      ) { lava = true; break; }
    }

    let waterfall = null;
    if (!lava) {
      for (const z of this.world.waterfallZones || []) {
        if (
          px >= z.minX && px <= z.maxX &&
          pz >= z.minZ && pz <= z.maxZ &&
          midY >= z.minY && midY <= z.maxY
        ) { waterfall = z; break; }
      }
    }

    let water = null;
    if (!lava && !waterfall) {
      for (const z of this.world.waterZones || []) {
        if (
          pointInZoneXZ(z, px, pz) &&
          midY >= (z.bottomY ?? z.surfaceY - 4) - 0.4 &&
          py < z.surfaceY + 0.35
        ) { water = z; break; }
      }
    }

    let foliage = false;
    if (!lava && !waterfall && !water) {
      for (const z of this.world.foliageZones || []) {
        if (z.r != null) {
          foliage = (px - z.x) * (px - z.x) +
            (eyeY - z.y) * (eyeY - z.y) +
            (pz - z.z) * (pz - z.z) < z.r * z.r;
        } else {
          foliage = px >= z.minX && px <= z.maxX &&
            eyeY >= z.minY && eyeY <= z.maxY &&
            pz >= z.minZ && pz <= z.maxZ;
        }
        if (foliage) break;
      }
    }

    let vine = null;
    if (!(this._vineExitT > 0)) {
      for (const z of this.world.vineZones || []) {
        const grabR = z.grabR ?? z.r;
        if (
          midY >= z.minY - 0.5 && midY <= z.maxY + 2.0 &&
          (px - z.x) * (px - z.x) + (pz - z.z) * (pz - z.z) < grabR * grabR
        ) { vine = z; break; }
      }
    }

    return {
      lava,
      waterfall,
      water,
      foliage,
      vine,
      speedMult: lava ? 0.34 : waterfall ? 0.58 : water ? waterSpeedMultiplier(this, water) : foliage ? 0.84 : 1,
    };
  }

  _applyWaterfallMotion(dt) {
    this.vel.y = THREE.MathUtils.damp(this.vel.y, -7.5 + this.world.gravity * dt, 12, dt);
    const drag = Math.exp(-4.2 * dt);
    this.vel.x *= drag;
    this.vel.z *= drag;
    this._airJumped = false;
  }

  _applyWaterMotion(zone, dt, horizontalSwimSpeed) {
    const surface = zone.surfaceY;
    const eyeY = this.pos.y + this.eyeHeight;
    let targetVy = eyeY < surface - 0.25 ? 1.15 : -0.35;
    const verticalInput = waterVerticalInput(this.keys, this.world, this.grapple);
    // Held Space is full swimming movement on the vertical axis. Reuse the
    // exact horizontal speed already calculated for this frame, including the
    // underwater multiplier and any active speed pickup.
    if (verticalInput === 'up') targetVy = eyeY < surface + 0.15
      ? horizontalSwimSpeed
      : this.world.jumpVel * 0.78;
    else if (verticalInput === 'down') targetVy = -5.6;
    else if (this._forwardInput() < -0.25) targetVy = -2.4;
    this.vel.y = THREE.MathUtils.damp(this.vel.y, targetVy + this.world.gravity * dt, 8, dt);
    const waterDrag = Math.exp(-2.8 * dt);
    this.vel.x *= waterDrag;
    this.vel.z *= waterDrag;
    this._airJumped = false;
  }

  _applyVineMotion(dt, vine) {
    let climb = -1.15;                 // no input: slide down slowly
    if (this.keys['Space']) climb = 5.4;
    else if (this._forwardInput() < -0.25) climb = -3.0;

    const midY = this.pos.y + this.height * 0.5;
    if (this.keys['Space'] && vine && midY > vine.maxY + 1.35) {
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      const exitX = vine.exitX ?? -sin;
      const exitZ = vine.exitZ ?? -cos;
      this.vel.x += exitX * 4.5;
      this.vel.z += exitZ * 4.5;
      this.vel.y = this.world.jumpVel * 1.12;
      this._vineExitT = 0.45;
      this._airJumped = false;
      return;
    }

    // moveCharacter applies gravity at the start of integration; offset it so
    // vine velocity is controlled by input instead of free fall.
    this.vel.y = climb + this.world.gravity * dt;
    const drag = Math.exp(-4.5 * dt);
    this.vel.x *= drag;
    this.vel.z *= drag;
    this._airJumped = false;
  }

  // Outward normal (as a cardinal "up") of the nearest solid surface to the
  // player — the direction that is "up" while standing on it.
  _nearestSurfaceUp() {
    const mid = this.pos.clone().addScaledVector(this.up, this.height * 0.5);
    return this._nearestSurfaceUpAt(mid);
  }

  _nearestSurfaceUpAt(point) {
    let best = null, bd = Infinity;
    for (const c of this.world.colliders) {
      if (c.type !== 'box') continue;
      const cx = clamp(point.x, c.min.x, c.max.x), cy = clamp(point.y, c.min.y, c.max.y), cz = clamp(point.z, c.min.z, c.max.z);
      const dx = point.x - cx, dy = point.y - cy, dz = point.z - cz;
      let d2 = dx * dx + dy * dy + dz * dz;
      if (d2 <= 1e-4) continue;
      // Hysteresis: the surface you're already aligned to is "cheaper", so you
      // don't flip-flop between two near-equidistant surfaces (e.g. hugging a
      // wall next to a column). Only switch when another is clearly nearer.
      const n = cardinal(new THREE.Vector3(dx, dy, dz));
      if (n.dot(this.up) > 0.9) d2 -= 9;   // ~3-unit bias toward the current face
      if (d2 < bd) { bd = d2; best = n; }
    }
    return best;
  }

  _solidAt(p) {
    for (const c of this.world.colliders) {
      if (c.type !== 'box') continue;
      if (p.x > c.min.x && p.x < c.max.x && p.y > c.min.y && p.y < c.max.y &&
          p.z > c.min.z && p.z < c.max.z) return true;
    }
    return false;
  }

  // Prism's lattice is meant to be traversable around its entire outside.
  // When grounded movement crosses a convex beam edge, rotate the player's
  // support normal and tangent velocity onto the next face instead of letting
  // momentum launch the player into the low-gravity interior. Jumping skips
  // this path, so leaving a beam still requires an intentional jump.
  _wrapBeamEdge(beforeMove) {
    const oldUp = this.up.clone();
    const oldAxis = Math.abs(oldUp.x) > 0.5 ? 'x' : Math.abs(oldUp.y) > 0.5 ? 'y' : 'z';
    const oldSign = Math.sign(oldUp[oldAxis]);
    const tangentAxes = ['x', 'y', 'z'].filter(axis => axis !== oldAxis);
    const faceTolerance = this.radius + 0.18;
    let support = null;
    let supportScore = Infinity;

    for (const c of this.world.colliders) {
      if (c.type !== 'box' || !c.wrapEdges) continue;
      const face = oldSign > 0 ? c.max[oldAxis] : c.min[oldAxis];
      const faceGap = Math.abs(beforeMove[oldAxis] - face);
      if (faceGap > faceTolerance) continue;
      let outside = 0;
      let nearFace = true;
      for (const axis of tangentAxes) {
        if (beforeMove[axis] < c.min[axis] - faceTolerance ||
            beforeMove[axis] > c.max[axis] + faceTolerance) {
          nearFace = false;
          break;
        }
        outside += Math.max(c.min[axis] - beforeMove[axis], 0,
          beforeMove[axis] - c.max[axis]);
      }
      if (!nearFace) continue;
      const score = faceGap + outside;
      if (score < supportScore) { support = c; supportScore = score; }
    }
    if (!support) return false;

    // At a cross intersection, another beam may continue supporting the old
    // plane. In that case keep walking straight instead of wrapping early.
    const stillSupported = this.world.colliders.some(c => {
      if (c.type !== 'box' || !c.wrapEdges) return false;
      const face = oldSign > 0 ? c.max[oldAxis] : c.min[oldAxis];
      if (Math.abs(this.pos[oldAxis] - face) > faceTolerance) return false;
      return tangentAxes.every(axis =>
        this.pos[axis] >= c.min[axis] - 0.02 && this.pos[axis] <= c.max[axis] + 0.02);
    });
    if (stillSupported) return false;

    const planarVel = this.vel.clone().addScaledVector(oldUp, -this.vel.dot(oldUp));
    let edgeAxis = null;
    let edgeSign = 0;
    let bestCrossing = 0;
    for (const axis of tangentAxes) {
      const vel = planarVel[axis];
      const beyondMax = this.pos[axis] - support.max[axis];
      const beyondMin = support.min[axis] - this.pos[axis];
      if (vel > 0.5 && beyondMax > -0.02 && beyondMax + Math.abs(vel) * 0.01 > bestCrossing) {
        edgeAxis = axis; edgeSign = 1; bestCrossing = beyondMax + Math.abs(vel) * 0.01;
      }
      if (vel < -0.5 && beyondMin > -0.02 && beyondMin + Math.abs(vel) * 0.01 > bestCrossing) {
        edgeAxis = axis; edgeSign = -1; bestCrossing = beyondMin + Math.abs(vel) * 0.01;
      }
    }
    if (!edgeAxis) return false;

    const newUp = new THREE.Vector3();
    newUp[edgeAxis] = edgeSign;
    const aroundSpeed = planarVel[edgeAxis] * edgeSign;
    if (aroundSpeed <= 0.5) return false;

    // Preserve motion along the edge and rotate only the component carrying
    // the player over it. The inset starts them down the new face with their
    // feet already touching its collision plane.
    const edgeTangent = planarVel.clone().addScaledVector(newUp, -aroundSpeed);
    this.vel.copy(edgeTangent).addScaledVector(oldUp, -aroundSpeed);
    this.pos[edgeAxis] = edgeSign > 0 ? support.max[edgeAxis] : support.min[edgeAxis];
    const oldFace = oldSign > 0 ? support.max[oldAxis] : support.min[oldAxis];
    this.pos[oldAxis] = oldFace - oldSign * 0.06;
    this.up.copy(newUp);
    this._climbLock = 0.14;
    return true;
  }

  // Walk into a wall/column while grounded → climb it. The wall ahead becomes
  // your floor and your momentum carries you UP it (so you climb even looking
  // straight at it); a brief lock keeps the nearest-surface gravity from
  // yanking you back to the floor at the base.
  _climb() {
    const dir = this.vel.clone().addScaledVector(this.up, -this.vel.dot(this.up));
    const sp = dir.length();
    if (sp < 1) return false;                      // only when actually moving
    dir.multiplyScalar(1 / sp);
    const probe = this.pos.clone()
      .addScaledVector(dir, this.radius + 0.4)
      .addScaledVector(this.up, 0.6);
    if (!this._solidAt(probe)) return false;
    const oldUp = this.up.clone();
    this.up.copy(cardinal(dir.clone().negate()));  // the wall ahead becomes the floor
    this.pos.addScaledVector(this.up, 0.06);
    this.vel.copy(oldUp).multiplyScalar(Math.max(sp, 6));   // shoot up the new surface
    this._climbLock = 0.35;
    return true;
  }
}
