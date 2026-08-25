export const TOAD_TOUCH_PERSONALITIES = Object.freeze([
  'normal',
  'poison',
  'hallucinogenic',
]);

export const TOAD_EFFECT_DELAY = 3;
export const TOAD_EFFECT_LOCKOUT = 20;
export const TOAD_POISON_DURATION = 4;
export const TOAD_POISON_DAMAGE = 5;
export const TOAD_HALLUCINATION_DURATION = 10;
export const TOAD_HALLUCINATION_TRANSITION = 1;

function seededRandom(seed) {
  let state = (Number(seed) >>> 0) || 0x746f6164;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function shuffledToadPersonalities(count, seed) {
  const total = Math.max(0, Math.floor(count));
  const personalities = Array.from(
    { length: total },
    (_, index) => TOAD_TOUCH_PERSONALITIES[index % TOAD_TOUCH_PERSONALITIES.length],
  );
  const random = seededRandom(seed);
  for (let index = personalities.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(random() * (index + 1));
    [personalities[index], personalities[swapIndex]] = [personalities[swapIndex], personalities[index]];
  }
  return personalities;
}

export function queueToadEffect(effects, personality) {
  if (!Array.isArray(effects) || personality === 'normal' ||
      !TOAD_TOUCH_PERSONALITIES.includes(personality)) return false;
  // A second toad of the same kind does not stack while that effect is pending
  // or active. Once it ends, leaving and touching a matching toad can trigger it again.
  if (effects.some(effect => effect.type === personality)) return false;
  effects.push({
    type: personality,
    delay: TOAD_EFFECT_DELAY,
    remaining: personality === 'poison'
      ? TOAD_POISON_DURATION
      : TOAD_HALLUCINATION_DURATION,
    started: false,
    poisonTicks: 0,
    poisonTickTimer: 0,
  });
  return true;
}

export function updateToadEffects(effects, dt, hooks = {}) {
  if (!Array.isArray(effects)) return { hallucinating: false, hallucinationStrength: 0 };
  const step = Math.max(0, Number(dt) || 0);
  let hallucinationStrength = 0;
  for (let index = effects.length - 1; index >= 0; index--) {
    const effect = effects[index];
    let activeStep = step;
    if (!effect.started) {
      if (activeStep + 1e-9 < effect.delay) {
        effect.delay -= activeStep;
        continue;
      }
      activeStep = Math.max(0, activeStep - effect.delay);
      effect.delay = 0;
      effect.started = true;
      hooks.onStart?.(effect.type);
      if (effect.type === 'poison') {
        effect.poisonTicks = 1;
        effect.poisonTickTimer = 1;
        hooks.onPoisonTick?.(TOAD_POISON_DAMAGE);
      }
    }

    effect.remaining = Math.max(0, effect.remaining - activeStep);
    if (effect.type === 'poison' && effect.poisonTicks < TOAD_POISON_DURATION) {
      effect.poisonTickTimer -= activeStep;
      while (effect.poisonTickTimer <= 1e-9 && effect.poisonTicks < TOAD_POISON_DURATION) {
        effect.poisonTicks++;
        effect.poisonTickTimer += 1;
        hooks.onPoisonTick?.(TOAD_POISON_DAMAGE);
      }
    }
    if (effect.type === 'hallucinogenic' && effect.started && effect.remaining > 1e-9) {
      const elapsed = TOAD_HALLUCINATION_DURATION - effect.remaining;
      hallucinationStrength = Math.max(hallucinationStrength, Math.min(
        1,
        elapsed / TOAD_HALLUCINATION_TRANSITION,
        effect.remaining / TOAD_HALLUCINATION_TRANSITION,
      ));
    }
    if (effect.remaining <= 1e-9) effects.splice(index, 1);
  }
  return {
    hallucinating: effects.some(effect => effect.type === 'hallucinogenic' && effect.started),
    hallucinationStrength,
  };
}
