// Tiny procedural sound effects — no assets needed.
let ctx = null;
let masterBus = null;
let masterVolume = 1;
let effectsVolume = 1;
let rainAmbience = null;
let jetpackAmbience = null;
let _sourceAt = null;
const noiseBuffers = new Map();
const sampleBuffers = new Map();
let samplesWarmed = false;
const SAMPLE_GROUPS = {
  small: Array.from({ length: 5 }, (_, i) => `laserSmall_${String(i).padStart(3, '0')}.ogg`),
  retro: Array.from({ length: 5 }, (_, i) => `laserRetro_${String(i).padStart(3, '0')}.ogg`),
  large: Array.from({ length: 5 }, (_, i) => `laserLarge_${String(i).padStart(3, '0')}.ogg`),
  impact: Array.from({ length: 5 }, (_, i) => `impactMetal_${String(i).padStart(3, '0')}.ogg`),
  explosion: Array.from({ length: 5 }, (_, i) => `explosionCrunch_${String(i).padStart(3, '0')}.ogg`),
};
function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  if (!samplesWarmed) warmSampleBank();
  return ctx;
}

function warmSampleBank() {
  samplesWarmed = true;
  for (const file of Object.values(SAMPLE_GROUPS).flat()) {
    fetch(`./assets/sfx/${file}`)
      .then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error('sample unavailable')))
      .then(data => ctx.decodeAudioData(data))
      .then(buffer => sampleBuffers.set(file, buffer))
      .catch(() => {});
  }
}
// All sfx route through a limiter — a busy firefight used to sum a dozen raw
// oscillators past 0dB and clip into a horrible buzz.
function bus(a) {
  if (!masterBus) {
    const comp = a.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 20;
    comp.ratio.value = 10;
    comp.attack.value = 0.002;
    comp.release.value = 0.12;
    masterBus = a.createGain();
    masterBus.gain.value = 0.8 * masterVolume * effectsVolume;
    masterBus.connect(comp);
    comp.connect(a.destination);
  }
  return masterBus;
}

export function setMasterVolume(value) {
  masterVolume = Math.max(0, Math.min(1, Number(value) || 0));
  if (masterBus) masterBus.gain.value = 0.8 * masterVolume * effectsVolume;
}

export function getMasterVolume() {
  return masterVolume;
}

export function setEffectsVolume(value) {
  effectsVolume = Math.max(0, Math.min(1, Number(value) || 0));
  if (masterBus) masterBus.gain.value = 0.8 * masterVolume * effectsVolume;
}

// Distance attenuation: sfx(name, at) scales volume by how far `at` is from
// the listener (set every frame). sfx(name) plays at full volume (your own).
const _listener = { x: 0, y: 0, z: 0 };
export function setListener(pos) {
  _listener.x = pos.x; _listener.y = pos.y; _listener.z = pos.z;
  if (!ctx) return;
  const L = ctx.listener;
  if (L.positionX) {
    L.positionX.value = pos.x; L.positionY.value = pos.y; L.positionZ.value = pos.z;
  } else {
    L.setPosition(pos.x, pos.y, pos.z);
  }
}
let _mult = 1;

function connectOutput(a, node) {
  if (_sourceAt && a.createPanner) {
    const p = a.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 4;
    p.maxDistance = 100;
    p.rolloffFactor = 1.15;
    if (p.positionX) {
      p.positionX.value = _sourceAt.x;
      p.positionY.value = _sourceAt.y;
      p.positionZ.value = _sourceAt.z;
    } else {
      p.setPosition(_sourceAt.x, _sourceAt.y, _sourceAt.z);
    }
    node.connect(p).connect(bus(a));
  } else {
    node.connect(bus(a));
  }
}

function blip({ freq = 440, end = freq, type = 'square', dur = 0.1, vol = 0.15, delay = 0 }) {
  try {
    const a = ac();
    const t = a.currentTime + delay;
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(end, 1), t + dur);
    g.gain.setValueAtTime(vol * _mult, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g);
    connectOutput(a, g);
    o.start(t); o.stop(t + dur + 0.02);
  } catch { /* audio blocked — fine */ }
}

function noiseBurst({ dur = 0.08, vol = 0.1, low = 180, high = 3200, delay = 0 } = {}) {
  try {
    const a = ac();
    const t = a.currentTime + delay;
    const source = a.createBufferSource();
    source.buffer = noiseBuffer(a, Math.max(0.12, dur + 0.04));
    const hp = a.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = low;
    const lp = a.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = high;
    const g = a.createGain();
    g.gain.setValueAtTime(Math.max(0.001, vol * _mult), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    source.connect(hp).connect(lp).connect(g);
    connectOutput(a, g);
    source.start(t); source.stop(t + dur + 0.03);
  } catch { /* audio blocked — fine */ }
}

function sample(group, { vol = 0.12, rate = 1, delay = 0 } = {}) {
  try {
    const a = ac();
    const files = SAMPLE_GROUPS[group];
    if (!files?.length) return;
    const file = files[Math.floor(Math.random() * files.length)];
    const buffer = sampleBuffers.get(file);
    if (!buffer) return;
    const source = a.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate * (0.97 + Math.random() * 0.06);
    const g = a.createGain();
    g.gain.value = vol * _mult;
    source.connect(g);
    connectOutput(a, g);
    source.start(a.currentTime + delay);
  } catch { /* audio blocked — fine */ }
}

const SFX = {
  blaster:  () => { sample('small', { vol: 0.13, rate: 0.92 });
                    noiseBurst({ dur: 0.055, vol: 0.05, low: 450, high: 5200 });
                    blip({ freq: 980, end: 240, dur: 0.09, vol: 0.1 });
                    blip({ freq: 190, end: 95, dur: 0.08, vol: 0.07, type: 'sine' }); },
  scatter:  () => { sample('large', { vol: 0.18, rate: 0.72 });
                    noiseBurst({ dur: 0.18, vol: 0.12, low: 90, high: 2300 });
                    blip({ freq: 180, end: 52, dur: 0.24, vol: 0.19, type: 'sawtooth' });
                    blip({ freq: 1250, end: 720, dur: 0.045, vol: 0.07, delay: 0.02 }); },
  pulsar:   () => { sample('small', { vol: 0.085, rate: 1.24 });
                    noiseBurst({ dur: 0.032, vol: 0.03, low: 800, high: 6500 });
                    blip({ freq: 1450, end: 620, dur: 0.055, vol: 0.075 }); },
  zooka:    () => { sample('large', { vol: 0.2, rate: 0.62 });
                    noiseBurst({ dur: 0.28, vol: 0.14, low: 45, high: 900 });
                    blip({ freq: 170, end: 38, dur: 0.38, vol: 0.22, type: 'sawtooth' }); },
  hyper:    () => { sample('large', { vol: 0.15, rate: 1.12 });
                    noiseBurst({ dur: 0.12, vol: 0.075, low: 700, high: 7200 });
                    blip({ freq: 2100, end: 180, dur: 0.24, vol: 0.14, type: 'sawtooth' }); },
  whomp:    () => { sample('explosion', { vol: 0.19, rate: 0.78 });
                    blip({ freq: 120, end: 40, dur: 0.35, vol: 0.28, type: 'sine' });
                    blip({ freq: 300, end: 80, dur: 0.15, vol: 0.15, type: 'square' }); },
  disc:     () => { sample('retro', { vol: 0.12, rate: 1.08 });
                    blip({ freq: 1100, end: 1600, dur: 0.12, vol: 0.07, type: 'triangle' }); },
  footstep: () => { noiseBurst({ dur: 0.075, vol: 0.045 + Math.random() * 0.018, low: 80, high: 900 });
                    blip({ freq: 105 + Math.random() * 24, end: 58, dur: 0.09, vol: 0.045, type: 'sine' }); },
  land:     () => { noiseBurst({ dur: 0.16, vol: 0.1, low: 55, high: 1200 });
                    blip({ freq: 92, end: 38, dur: 0.18, vol: 0.11, type: 'sine' }); },
  equip:    () => { blip({ freq: 720, end: 480, dur: 0.045, vol: 0.045, type: 'square' });
                    blip({ freq: 260, end: 190, dur: 0.075, vol: 0.045, type: 'triangle', delay: 0.035 }); },
  dry:      () => { blip({ freq: 180, end: 120, dur: 0.045, vol: 0.065, type: 'square' });
                    blip({ freq: 95, end: 70, dur: 0.06, vol: 0.04, type: 'triangle', delay: 0.035 }); },
  coin:     () => { blip({ freq: 990, dur: 0.07, vol: 0.14, type: 'square' });
                    blip({ freq: 1320, dur: 0.18, vol: 0.14, type: 'square', delay: 0.07 }); },
  hit:      () => { sample('impact', { vol: 0.095, rate: 1.35 });
                    blip({ freq: 1400, end: 1000, dur: 0.05, vol: 0.07, type: 'triangle' }); },
  hurt:     () => blip({ freq: 200, end: 90, dur: 0.18, vol: 0.2, type: 'sawtooth' }),
  jump:     () => blip({ freq: 300, end: 500, dur: 0.1, vol: 0.06, type: 'triangle' }),
  boing:    () => blip({ freq: 180, end: 700, dur: 0.25, vol: 0.16, type: 'triangle' }),
  shieldup: () => { blip({ freq: 500, end: 900, dur: 0.14, vol: 0.13, type: 'sine' });
                    blip({ freq: 900, end: 1400, dur: 0.16, vol: 0.12, type: 'sine', delay: 0.1 }); },
  pickup:   () => { blip({ freq: 600, end: 900, dur: 0.08, vol: 0.12, type: 'triangle' });
                    blip({ freq: 900, end: 1200, dur: 0.08, vol: 0.12, type: 'triangle', delay: 0.07 }); },
  star:     () => { for (let i = 0; i < 4; i++) blip({ freq: 700 + i * 200, dur: 0.09, vol: 0.12, type: 'triangle', delay: i * 0.06 }); },
  powerup:  () => { for (let i = 0; i < 5; i++) blip({ freq: 400 + i * 180, dur: 0.12, vol: 0.14, type: 'square', delay: i * 0.08 }); },
  kill:     () => { blip({ freq: 500, end: 800, dur: 0.1, vol: 0.14 }); blip({ freq: 800, end: 1100, dur: 0.12, vol: 0.14, delay: 0.09 }); },
  death:    () => blip({ freq: 400, end: 60, dur: 0.5, vol: 0.2, type: 'sawtooth' }),
  explode:  () => { sample('explosion', { vol: 0.22, rate: 0.82 });
                    blip({ freq: 150, end: 30, dur: 0.4, vol: 0.25, type: 'sawtooth' });
                    blip({ freq: 90, end: 25, dur: 0.5, vol: 0.2, type: 'square', delay: 0.03 }); },
  thunder:  () => thunder(),
};

function noiseBuffer(a, seconds = 2) {
  const key = `${a.sampleRate}:${seconds.toFixed(2)}`;
  if (noiseBuffers.has(key)) return noiseBuffers.get(key);
  const buffer = a.createBuffer(1, Math.floor(a.sampleRate * seconds), a.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  noiseBuffers.set(key, buffer);
  return buffer;
}

function thunder() {
  try {
    const a = ac();
    const t = a.currentTime;
    const noise = a.createBufferSource();
    noise.buffer = noiseBuffer(a, 1.7);
    const lp = a.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(520, t);
    lp.frequency.exponentialRampToValueAtTime(70, t + 1.55);
    const g = a.createGain();
    g.gain.setValueAtTime(0.001 * _mult, t);
    g.gain.exponentialRampToValueAtTime(0.26 * _mult, t + 0.045);
    g.gain.exponentialRampToValueAtTime(0.018 * _mult, t + 1.65);
    noise.connect(lp).connect(g).connect(bus(a));
    noise.start(t);
    noise.stop(t + 1.75);

    blip({ freq: 58, end: 28, type: 'sine', dur: 1.25, vol: 0.18, delay: 0.03 });
    blip({ freq: 92, end: 38, type: 'sine', dur: 0.72, vol: 0.08, delay: 0.18 });
  } catch { /* audio blocked — fine */ }
}

export function setRainAmbience(level = 0) {
  const target = Math.max(0, Math.min(1, Number(level) || 0));
  try {
    const a = ac();
    if (!rainAmbience) {
      const source = a.createBufferSource();
      source.buffer = noiseBuffer(a, 3);
      source.loop = true;
      const hp = a.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 650;
      const lp = a.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 5200;
      const gain = a.createGain();
      gain.gain.value = 0.001;
      source.connect(hp).connect(lp).connect(gain).connect(bus(a));
      source.start();
      rainAmbience = { gain };
    }
    const now = a.currentTime;
    rainAmbience.gain.gain.cancelScheduledValues(now);
    rainAmbience.gain.gain.setTargetAtTime(0.06 * target, now, 0.25);
  } catch { /* audio blocked — fine */ }
}

// Continuous local jetpack thrust. A filtered noise wash supplies the exhaust
// while a low oscillator gives it turbine weight; both share a quick attack
// and a softer release so short Space taps do not click or sound like gunfire.
export function setJetpackThrust(active = false) {
  const next = !!active;
  if (!jetpackAmbience && !next) return;
  if (jetpackAmbience?.active === next) return;
  try {
    const a = ac();
    if (!jetpackAmbience) {
      const exhaust = a.createBufferSource();
      exhaust.buffer = noiseBuffer(a, 2.4);
      exhaust.loop = true;
      const hp = a.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 75;
      const lp = a.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 1250; lp.Q.value = 0.65;
      const exhaustGain = a.createGain();
      exhaustGain.gain.value = 0.82;

      const turbine = a.createOscillator();
      turbine.type = 'sawtooth';
      turbine.frequency.value = 58;
      const turbineGain = a.createGain();
      turbineGain.gain.value = 0.18;

      const flutter = a.createOscillator();
      flutter.type = 'sine'; flutter.frequency.value = 16.5;
      const flutterDepth = a.createGain();
      flutterDepth.gain.value = 105;
      flutter.connect(flutterDepth).connect(lp.frequency);

      const gain = a.createGain();
      gain.gain.value = 0.001;
      exhaust.connect(hp).connect(lp).connect(exhaustGain).connect(gain);
      turbine.connect(turbineGain).connect(gain);
      gain.connect(bus(a));
      exhaust.start(); turbine.start(); flutter.start();
      jetpackAmbience = { gain, active: false };
    }
    const now = a.currentTime;
    const gain = jetpackAmbience.gain.gain;
    if (gain.cancelAndHoldAtTime) gain.cancelAndHoldAtTime(now);
    else {
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(Math.max(0.001, gain.value), now);
    }
    gain.setTargetAtTime(next ? 0.105 : 0.001, now, next ? 0.035 : 0.11);
    jetpackAmbience.active = next;
  } catch { /* audio blocked — fine */ }
}

export function sfx(name, at = null) {
  if (at) {
    const dx = at.x - _listener.x, dy = at.y - _listener.y, dz = at.z - _listener.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > 90) return;                    // out of earshot
    _mult = 1 / (1 + dist * 0.07);            // gentle rolloff
  } else {
    _mult = 1;
  }
  _sourceAt = at;
  (SFX[name] || (() => {}))();
  _sourceAt = null;
  _mult = 1;
}
