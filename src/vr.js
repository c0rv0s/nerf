import * as THREE from 'three';
import { VRUI } from './vr-ui.js';
import { buildBlaster, WEAPONS, updateWeaponWarmupVisual } from './weapons.js';
import { vrStick, readVRButtons, snapTurn, boundedVRMuzzle, vrControlsNeutral } from './vr-input.js';

// The simulation camera stays independent: headset poses never feed recoil or
// death-camera animation back into the user's physical head orientation.
export class VRControls {
  constructor({ renderer, getGame, onEnter, onExit, canEnter, onPause, onAtrium, getAwards, isPaused }) {
    Object.assign(this, { renderer, getGame, onEnter, onExit, canEnter, onPause, onAtrium, getAwards, isPaused });
    this.paused = false;
    this.rig = new THREE.Group();
    this.camera = new THREE.PerspectiveCamera(75, 1, 0.1, 900);
    this.rig.add(this.camera);
    this.heading = 0;
    this.center = new THREE.Vector3();
    this.head = new THREE.Vector3();
    this.headRotation = new THREE.Quaternion();
    this.direction = new THREE.Vector3();
    this.controllers = [0, 1].map(index => {
      const controller = renderer.xr.getController(index);
      controller.addEventListener('connected', event => { controller.userData.source = event.data; });
      controller.addEventListener('disconnected', () => { controller.userData.source = null; });
      const ray = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -3)]),
        new THREE.LineBasicMaterial({ color: 0x76edff, transparent: true, opacity: 0.45 }),
      );
      controller.add(ray);
      this.rig.add(controller);
      return controller;
    });
    this.gun = new THREE.Group();
    this.gun.position.set(0, -0.025, -0.12);
    this.gun.scale.setScalar(0.42);
    this.models = {};
    this.grappleGun = new THREE.Group();
    this.grappleGun.position.set(0, -0.025, -0.12);
    this.grappleGun.scale.setScalar(0.42);
    this.ui = new VRUI(this.camera);
    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local-floor');
    renderer.xr.setFramebufferScaleFactor(0.8);
    renderer.xr.addEventListener('sessionstart', () => {
      this.player = null;
      this.paused = false;
      this.previous = {};
      this.turnLatched = false;
      this.onEnter();
      this.button.textContent = 'EXIT VR';
    });
    renderer.xr.addEventListener('sessionend', () => {
      this.releasePlayer();
      this.rig.removeFromParent();
      this.paused = false;
      this.onExit();
      this.syncButton();
      this.button.textContent = 'ENTER VR';
    });
    this.createButton();
  }

  get active() { return this.renderer.xr.isPresenting; }

  createButton() {
    const style = document.createElement('style');
    style.textContent = `#vr-entry{position:fixed;right:16px;bottom:16px;z-index:1000;display:flex;align-items:flex-end;flex-direction:column;gap:8px;max-width:340px}#vr-entry button{background:#122132;color:#fff;border:2px solid #76edff;border-radius:8px;padding:12px 20px;font:bold 14px Arial;cursor:pointer}#vr-entry button:disabled{opacity:.6;cursor:default}#vr-status{background:#122132;color:#fff;padding:10px;border-radius:6px;font:13px/1.4 Arial}#vr-status:empty{display:none}@media(pointer:coarse){#vr-entry[data-supported=false]{display:none}}`;
    document.head.appendChild(style);
    const root = document.createElement('div');
    root.id = 'vr-entry';
    root.style.display = 'none';
    this.root = root;
    this.status = document.createElement('div');
    this.status.id = 'vr-status';
    this.status.setAttribute('role', 'status');
    this.button = document.createElement('button');
    this.button.textContent = 'CHECKING VR';
    this.button.disabled = true;
    root.append(this.status, this.button);
    document.body.appendChild(root);
    this.button.addEventListener('click', async () => {
      if (this.active) { await this.exit(); return; }
      if (!this.supported || !this.isPaused()) return;
      if (!this.getGame() || !this.canEnter()) {
        this.status.textContent = 'Enter the lobby or an arena and close any menus, then select ENTER VR.';
        return;
      }
      this.button.disabled = true;
      let session;
      try {
        session = await navigator.xr.requestSession('immersive-vr', { requiredFeatures: ['local-floor'] });
        await this.renderer.xr.setSession(session);
        this.status.textContent = '';
      } catch (error) {
        if (session) await session.end().catch(() => {});
        this.status.textContent = `VR could not start: ${error.message}. Check the Rift connection and your PC's active OpenXR runtime.`;
      } finally { this.button.disabled = false; }
    });
    this.checkSupport();
    navigator.xr?.addEventListener('devicechange', () => this.checkSupport());
  }

  async checkSupport() {
    if (this.active) return;
    try {
      const supported = !!navigator.xr && await navigator.xr.isSessionSupported('immersive-vr');
      this.root.dataset.supported = String(supported);
      this.button.textContent = supported ? 'ENTER VR' : 'VR SETUP';
      this.button.disabled = false;
      if (!supported) {
        this.button.onclick = () => {
          this.status.textContent = 'Rift needs a connected Windows PC, an active OpenXR runtime, and a WebXR-capable browser. Open this game over HTTPS or localhost.';
        };
      } else { this.button.onclick = null; this.status.textContent = ''; }
      this.supported = supported;
    } catch {
      this.button.textContent = 'VR UNAVAILABLE';
      this.status.textContent = 'This browser could not check VR support. Use HTTPS or localhost on your Rift PC.';
    }
  }

  releasePlayer() {
    if (!this.player) return;
    this.player.firing = false;
    this.player.setMoveInput(0, 0);
    this.player.keys = {};
    this.player.wantJump = false;
    this.player.jumpBuffer = 0;
    this.player.xrAim = null;
    this.player.xrGrappleAim = null;
    this.player.vrActive = false;
    this.player.camera.visible = true;
    this.player.cancelWeaponWarmup?.();
    this.player.detachGrapple?.();
    this.grappleGun.removeFromParent();
    this.grappleGun.clear();
    this.grappleMuzzle = null;
    this.podium = null;
    this.ui.resultsAnchor.removeFromParent();
    this.player = null;
  }

  syncButton() {
    this.root.style.display = this.isPaused() ? 'flex' : 'none';
  }

  setPaused(value) {
    this.paused = !!value;
    this.needsNeutral = true;
    const player = this.getGame()?.player;
    if (player) {
      player.firing = false;
      player.setMoveInput(0, 0);
      player.keys = {};
      player.wantJump = false;
      player.cancelWeaponWarmup?.();
      player.detachGrapple?.();
    }
    this.onPause(this.paused);
    this.syncButton();
  }

  async exit() {
    try { await this.renderer.xr.getSession()?.end(); }
    catch (error) { this.status.textContent = `Could not exit VR: ${error.message}`; }
  }

  syncRig(player) {
    this.rig.rotation.set(0, this.heading, 0);
    const scale = player.world.characterVisualScale?.(player) || 1;
    this.rig.position.copy(this.center).applyAxisAngle(THREE.Object3D.DEFAULT_UP, this.heading).negate();
    if (this.podium) {
      this.rig.position.add(this.podium.anchor || new THREE.Vector3()).add(new THREE.Vector3(0,4.15,11.5));
    } else {
      this.rig.position.add(player.pos);
      this.rig.position.y += player.eyeHeight * scale;
    }
    this.rig.updateMatrixWorld(true);
  }

  beforeFrame(frame, scene, blocked = false) {
    if (!this.active) return;
    const game = this.getGame();
    const player = game?.player;
    if (!player || !frame) return;
    const pose = frame.getViewerPose(this.renderer.xr.getReferenceSpace());
    const session = this.renderer.xr.getSession();
    const focused = session.visibilityState === 'visible';
    if (!pose || !focused) {
      player.setMoveInput(0, 0);
      player.firing = false;
      player.xrAim = null;
      player.xrGrappleAim = null;
      player.detachGrapple?.();
      player.keys.Space = false;
      player.keys.ShiftLeft = false;
      player.cancelWeaponWarmup?.();
      this.needsNeutral = true;
      return;
    }
    this.head.copy(pose.transform.position);
    this.headRotation.copy(pose.transform.orientation);
    const headForward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.headRotation);
    const headYaw = Math.atan2(-headForward.x, -headForward.z);
    if (this.player !== player) {
      this.releasePlayer();
      this.player = player;
      this.paused = false;
      this.heading = player.yaw - headYaw;
      this.center.copy(this.head);
      this.previous = {};
      this.turnLatched = false;
      this.needsNeutral = true;
      player.vel.set(0, 0, 0);
      player.keys = {};
    }
    if (this.rig.parent !== scene) scene.add(this.rig);
    player.vrActive = true;
    player.camera.visible = false;
    const right = this.controllers.find(c => c.userData.source?.handedness === 'right');
    const left = this.controllers.find(c => c.userData.source?.handedness === 'left');
    const rb = readVRButtons(right?.userData.source?.gamepad);
    const lb = readVRButtons(left?.userData.source?.gamepad);
    if (rb.secondary && !this.previous.pause) this.setPaused(!this.paused);
    if (lb.secondary && !this.previous.center) this.center.copy(this.head);
    const stick = vrStick(left?.userData.source?.gamepad);
    const rightStick = vrStick(right?.userData.source?.gamepad);
    if (blocked) this.needsNeutral = true;
    if (!blocked && !this.paused && !lb.fire && vrControlsNeutral(stick, rightStick, rb)) this.needsNeutral = false;
    const turn = snapTurn(this.needsNeutral || this.paused || game.over ? 0 : rightStick.x, this.turnLatched);
    this.turnLatched = turn.latched;
    this.heading += turn.radians;
    const podium = game.over ? game.scene?.userData?.end : null;
    if (podium && this.podium !== podium) {
      this.podium = podium;
      this.center.copy(this.head);
      const view = (podium.anchor || new THREE.Vector3()).clone().add(new THREE.Vector3(0,4.15,11.5));
      const target = podium.lookAt || podium.anchor || new THREE.Vector3();
      this.heading = Math.atan2(view.x-target.x,view.z-target.z) - headYaw;
      this.ui.anchorResults(this.rig, this.center, headYaw);
    }
    this.syncRig(player);
    this.renderer.xr.updateCamera(this.camera);
    player.yaw = this.heading + headYaw;
    player.pitch = Math.asin(THREE.MathUtils.clamp(headForward.y, -1, 1));
    player.frameFwd.set(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
    const enabled = !this.needsNeutral && !this.paused && !blocked && !game.paused && !game.over && player.alive;
    player.setMoveInput(enabled ? stick.x : 0, enabled ? -stick.y : 0);
    player.keys.Space = enabled && rb.jump;
    player.keys.ShiftLeft = enabled && lb.grip;
    if (enabled && rb.jump && !this.previous.jump) player.wantJump = true;
    if (enabled && lb.jump && !this.previous.weapon) player.cycleWeapon(1);
    player.xrAim = null;
    player.firing = enabled && !!right?.visible && rb.fire;
    if (right?.visible) {
      if (this.gun.parent !== right) right.add(this.gun);
      // Target-ray space points down -Z; Object3D.getWorldDirection uses +Z.
      this.direction.set(0, 0, -1).transformDirection(right.matrixWorld);
      const origin = new THREE.Vector3().setFromMatrixPosition(right.matrixWorld).addScaledVector(this.direction, 0.38);
      const eye = player.pos.clone();
      eye.y += player.eyeHeight * (player.world.characterVisualScale?.(player) || 1);
      player.xrAim = { dir: this.direction.clone(), muzzle: boundedVRMuzzle(origin.sub(eye)) };
    }
    player.xrGrappleAim = null;
    if (left?.visible && player.grapple && player.grappleLauncher && !game.over) {
      if (!this.grappleMuzzle) {
        const model = player.grappleLauncher.clone(true);
        this.grappleGun.add(model);
        this.grappleMuzzle = model.getObjectByName('canopy-grapple-muzzle');
      }
      if (this.grappleGun.parent !== left) left.add(this.grappleGun);
      this.grappleGun.updateWorldMatrix(true,true);
      const muzzleOrigin = this.grappleMuzzle.getWorldPosition(new THREE.Vector3());
      player.xrGrappleAim = {
        offset: muzzleOrigin.clone().sub(player.pos),
        dir: new THREE.Vector3(0,0,-1).transformDirection(left.matrixWorld),
        origin: muzzleOrigin,
      };
    }
    this.grappleGun.visible = !!player.xrGrappleAim && !this.paused && player.alive;
    if (!player.xrGrappleAim) player.detachGrapple?.();
    if (enabled && player.xrGrappleAim && lb.fire && !this.previous.grapple) player.toggleGrapple();
    this.gun.visible = !!right?.visible && player.alive && !this.paused && !game.over;
    this.gun.position.z = -0.12 + player.recoil * 0.025;
    this.gun.rotation.x = player.recoil * 0.05;
    if (!this.models[player.weapon]) {
      this.models[player.weapon] = buildBlaster(player.weapon);
      this.gun.add(this.models[player.weapon]);
    }
    for (const [id, model] of Object.entries(this.models)) model.visible = id === player.weapon;
    updateWeaponWarmupVisual(this.models.whomper,
      player.warmupWeapon === 'whomper' ? 1 - player.warmupT / WEAPONS.whomper.warmup : -1,
      performance.now() / 1000);
    this.ui.update(game, { paused: this.paused, blocked, needsNeutral: this.needsNeutral, awards: this.getAwards() });
    const action = this.ui.interact(right, {
      trigger: rb.fire && !this.previous.fire,
      confirm: rb.jump && !this.previous.jump,
      axis: rightStick.y,
    });
    this.previous = { jump: rb.jump, fire: rb.fire, weapon: lb.jump, grapple: lb.fire, pause: rb.secondary, center: lb.secondary };
    if (action === 'resume') this.setPaused(false);
    if (action === 'exit') this.exit();
    if (action === 'atrium') {
      this.setPaused(false);
      this.onAtrium();
    }
  }

  render(scene) {
    if (this.player) this.syncRig(this.player);
    this.renderer.render(scene, this.camera);
  }
}
