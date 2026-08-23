const STICK_RADIUS = 58;
const STICK_DEAD_ZONE = 0.12;
const TOUCH_LOOK_SCALE = 2.4;

export function touchControlsSupported(win = window, nav = navigator) {
  const forced = new URLSearchParams(win.location.search).get('touch');
  if (forced === '1') return true;
  if (forced === '0') return false;
  return (nav.maxTouchPoints || 0) > 0 && win.matchMedia?.('(pointer: coarse)').matches;
}

export function stickVector(originX, originY, pointerX, pointerY, radius = STICK_RADIUS) {
  const dx = pointerX - originX;
  const dy = pointerY - originY;
  const distance = Math.hypot(dx, dy);
  const directionX = distance > 0 ? dx / distance : 0;
  const directionY = distance > 0 ? dy / distance : 0;
  const rawStrength = Math.min(1, distance / radius);
  const strength = rawStrength <= STICK_DEAD_ZONE
    ? 0
    : (rawStrength - STICK_DEAD_ZONE) / (1 - STICK_DEAD_ZONE);
  const visualDistance = Math.min(radius, distance);
  const strafe = directionX * strength;
  const forward = -directionY * strength;
  return {
    strafe: strafe === 0 ? 0 : strafe,
    forward: forward === 0 ? 0 : forward,
    knobX: directionX * visualDistance,
    knobY: directionY * visualDistance,
  };
}

export class MobileControls {
  constructor({
    root,
    onMove,
    onLook,
    onFire,
    onJump,
    onGrapple,
    onCycleWeapon,
    onPause,
    onEngage,
    shouldShow,
    shouldShowGrapple,
  }) {
    this.root = root;
    this.onMove = onMove;
    this.onLook = onLook;
    this.onFire = onFire;
    this.onJump = onJump;
    this.onCycleWeapon = onCycleWeapon;
    this.onPause = onPause;
    this.onEngage = onEngage;
    this.shouldShow = shouldShow;
    this.shouldShowGrapple = shouldShowGrapple;
    this.active = !!root && touchControlsSupported();
    this.visible = false;
    this.movePointer = null;
    this.lookPointer = null;
    this.moveOrigin = { x: 0, y: 0 };
    this.lookPoint = { x: 0, y: 0 };
    this.engaged = false;

    document.body.classList.toggle('touch-capable', this.active);
    if (!this.active) return;

    this.moveZone = root.querySelector('#mobileMoveZone');
    this.lookZone = root.querySelector('#mobileLookZone');
    this.stickBase = root.querySelector('#mobileStickBase');
    this.stickKnob = root.querySelector('#mobileStickKnob');
    this.fireButton = root.querySelector('#mobileFire');
    this.jumpButton = root.querySelector('#mobileJump');
    this.weaponButton = root.querySelector('#mobileWeapon');
    this.grappleButton = root.querySelector('#mobileGrapple');
    this.pauseButton = root.querySelector('#mobilePause');

    this._bindMoveSurface();
    this._bindLookSurface();
    this._bindHeldButton(this.fireButton, onFire, { dragToLook: true });
    this._bindHeldButton(this.jumpButton, onJump, { dragToLook: true });
    this.weaponButton.addEventListener('pointerdown', (event) => {
      this._consume(event);
      this._engage();
      onCycleWeapon?.();
    });
    this.grappleButton?.addEventListener('pointerdown', (event) => {
      this._consume(event);
      this._engage();
      onGrapple?.();
    });
    this.pauseButton.addEventListener('click', (event) => {
      this._consume(event);
      onPause?.();
    });
    root.addEventListener('contextmenu', (event) => event.preventDefault());
    window.addEventListener('blur', () => this.reset());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.reset();
    });
  }

  _consume(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  _engage() {
    if (this.engaged) return;
    this.engaged = true;
    this.onEngage?.();
  }

  _bindMoveSurface() {
    this.moveZone.addEventListener('pointerdown', (event) => {
      if (this.movePointer !== null) return;
      this._consume(event);
      this._engage();
      this.movePointer = event.pointerId;
      this.moveOrigin = { x: event.clientX, y: event.clientY };
      this.moveZone.setPointerCapture?.(event.pointerId);
      this.stickBase.hidden = false;
      this.stickBase.style.left = `${event.clientX}px`;
      this.stickBase.style.top = `${event.clientY}px`;
      this._updateMove(event.clientX, event.clientY);
    });
    this.moveZone.addEventListener('pointermove', (event) => {
      if (event.pointerId !== this.movePointer) return;
      this._consume(event);
      this._updateMove(event.clientX, event.clientY);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      this.moveZone.addEventListener(type, (event) => {
        if (event.pointerId !== this.movePointer) return;
        this._consume(event);
        this.movePointer = null;
        this.stickBase.hidden = true;
        this.stickKnob.style.transform = 'translate(-50%, -50%)';
        this.onMove?.(0, 0);
      });
    }
  }

  _updateMove(x, y) {
    const vector = stickVector(this.moveOrigin.x, this.moveOrigin.y, x, y);
    this.stickKnob.style.transform = `translate(calc(-50% + ${vector.knobX}px), calc(-50% + ${vector.knobY}px))`;
    this.onMove?.(vector.strafe, vector.forward);
  }

  _bindLookSurface() {
    this.lookZone.addEventListener('pointerdown', (event) => {
      if (this.lookPointer !== null) return;
      this._consume(event);
      this._engage();
      this.lookPointer = event.pointerId;
      this.lookPoint = { x: event.clientX, y: event.clientY };
      this.lookZone.setPointerCapture?.(event.pointerId);
    });
    this.lookZone.addEventListener('pointermove', (event) => {
      if (event.pointerId !== this.lookPointer) return;
      this._consume(event);
      const dx = event.clientX - this.lookPoint.x;
      const dy = event.clientY - this.lookPoint.y;
      this.lookPoint = { x: event.clientX, y: event.clientY };
      this.onLook?.(dx * TOUCH_LOOK_SCALE, dy * TOUCH_LOOK_SCALE);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      this.lookZone.addEventListener(type, (event) => {
        if (event.pointerId !== this.lookPointer) return;
        this._consume(event);
        this.lookPointer = null;
      });
    }
  }

  _bindHeldButton(button, callback, { dragToLook = false } = {}) {
    let pointer = null;
    let point = null;
    const release = (event) => {
      if (event.pointerId !== pointer) return;
      this._consume(event);
      pointer = null;
      point = null;
      button.classList.remove('pressed');
      button.setAttribute('aria-pressed', 'false');
      callback?.(false);
    };
    button.addEventListener('pointerdown', (event) => {
      if (pointer !== null) return;
      this._consume(event);
      this._engage();
      pointer = event.pointerId;
      point = { x: event.clientX, y: event.clientY };
      button.setPointerCapture?.(event.pointerId);
      button.classList.add('pressed');
      button.setAttribute('aria-pressed', 'true');
      callback?.(true);
    });
    button.addEventListener('pointermove', (event) => {
      if (!dragToLook || event.pointerId !== pointer || !point) return;
      this._consume(event);
      const dx = event.clientX - point.x;
      const dy = event.clientY - point.y;
      point = { x: event.clientX, y: event.clientY };
      this.onLook?.(dx * TOUCH_LOOK_SCALE, dy * TOUCH_LOOK_SCALE);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      button.addEventListener(type, release);
    }
  }

  sync() {
    if (!this.active) return;
    if (this.grappleButton) this.grappleButton.hidden = !this.shouldShowGrapple?.();
    const nextVisible = !!this.shouldShow?.();
    if (nextVisible === this.visible) return;
    this.visible = nextVisible;
    this.root.hidden = !nextVisible;
    this.root.setAttribute('aria-hidden', String(!nextVisible));
    document.body.classList.toggle('touch-controls-visible', nextVisible);
    if (!nextVisible) this.reset();
  }

  reset() {
    if (!this.active) return;
    this.movePointer = null;
    this.lookPointer = null;
    this.stickBase.hidden = true;
    this.stickKnob.style.transform = 'translate(-50%, -50%)';
    for (const button of [this.fireButton, this.jumpButton]) {
      button.classList.remove('pressed');
      button.setAttribute('aria-pressed', 'false');
    }
    this.onMove?.(0, 0);
    this.onFire?.(false);
    this.onJump?.(false);
  }
}
