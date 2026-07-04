// Tiny procedural sound effects — no assets needed.
let ctx = null;
function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
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
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(a.destination);
    o.start(t); o.stop(t + dur + 0.02);
  } catch { /* audio blocked — fine */ }
}

const SFX = {
  blaster:  () => blip({ freq: 900, end: 300, dur: 0.08, vol: 0.12 }),
  scatter:  () => { blip({ freq: 500, end: 120, dur: 0.16, vol: 0.16, type: 'sawtooth' }); },
  pulsar:   () => blip({ freq: 1300, end: 700, dur: 0.05, vol: 0.08 }),
  zooka:    () => blip({ freq: 220, end: 60, dur: 0.3, vol: 0.2, type: 'sawtooth' }),
  hyper:    () => { blip({ freq: 1800, end: 200, dur: 0.22, vol: 0.15, type: 'sawtooth' }); },
  whomp:    () => { blip({ freq: 120, end: 40, dur: 0.35, vol: 0.28, type: 'sine' });
                    blip({ freq: 300, end: 80, dur: 0.15, vol: 0.15, type: 'square' }); },
  disc:     () => blip({ freq: 1100, end: 1600, dur: 0.12, vol: 0.1, type: 'triangle' }),
  coin:     () => { blip({ freq: 990, dur: 0.07, vol: 0.14, type: 'square' });
                    blip({ freq: 1320, dur: 0.18, vol: 0.14, type: 'square', delay: 0.07 }); },
  hit:      () => blip({ freq: 1400, end: 1000, dur: 0.05, vol: 0.1, type: 'triangle' }),
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
  explode:  () => { blip({ freq: 150, end: 30, dur: 0.4, vol: 0.25, type: 'sawtooth' });
                    blip({ freq: 90, end: 25, dur: 0.5, vol: 0.2, type: 'square', delay: 0.03 }); },
};

export function sfx(name) { (SFX[name] || (() => {}))(); }
