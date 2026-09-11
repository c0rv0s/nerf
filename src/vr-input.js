// WebXR's xr-standard Touch layout. Keep this independent of browser/Three.js.
export function vrStick(gamepad) {
  const axes = gamepad?.axes || [];
  const start = axes.length >= 4 ? 2 : 0;
  const deadzone = value => Number.isFinite(value) && Math.abs(value) > 0.18
    ? Math.max(-1, Math.min(1, value)) : 0;
  return { x: deadzone(axes[start]), y: deadzone(axes[start + 1]) };
}

export function readVRButtons(gamepad) {
  const down = index => !!gamepad?.buttons?.[index]?.pressed;
  return { fire: down(0), grip: down(1), jump: down(4), secondary: down(5) };
}

export function snapTurn(axis, latched) {
  if (Math.abs(axis) < 0.3) return { radians: 0, latched: false };
  if (latched || Math.abs(axis) < 0.65) return { radians: 0, latched: !!latched };
  return { radians: -Math.sign(axis) * Math.PI / 6, latched: true };
}

// Optional eye-relative muzzle offset, shared by sender, relay and host.
export function boundedVRMuzzle(value) {
  if (!value || !['x', 'y', 'z'].every(key => Number.isFinite(value[key]))) return null;
  const scale = Math.min(1, 1.5 / (Math.hypot(value.x, value.y, value.z) || 1));
  return { x: value.x * scale, y: value.y * scale, z: value.z * scale };
}

export function vrControlsNeutral(stick, turn, buttons) {
  return stick.x === 0 && stick.y === 0 && turn.x === 0 && turn.y === 0 &&
    !buttons.fire && !buttons.jump && !buttons.grip;
}

export function vrBlasterTriggers(enabled, dualBlaster, rightVisible, leftVisible, rightButtons, leftButtons) {
  return {
    right: !!(enabled && rightVisible && rightButtons?.fire),
    left: !!(enabled && dualBlaster && leftVisible && leftButtons?.fire),
  };
}
