// Game bootstrap: menu, match loop, damage/kills/powerups, input plumbing.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  MAPS, buildAtrium, buildHallOfFame, getSharedTextureLoadProgress,
  getTextureLoadProgress, onTextureLoadProgress, prioritizeTextureLoading,
  sharedTexturesReady, texturesReady,
} from './maps.js';
import {
  buildCollisionIndex, buildWaypointGraph, pick, rand, inRampFootprint, rampSurfaceY, pointInZoneXZ,
  cylinderShellSurfaceY, ellipsoidSurfaceY, pointHitsWorld,
  sphereHitsCylinderShell, sphereHitsEllipsoid, sphereHitsTriangleMesh, triangleMeshSurfaceY,
} from './engine.js';
import { Player } from './player.js';
import { Bot, BOT_NAMES, buildBotMesh, syncJetpackVisual } from './bots.js';
import {
  ProjectileSystem, FXPool, WEAPONS, WEAPON_ORDER, buildBlaster,
  blasterSkin, updateWeaponWarmupVisual, nextLoadedWeaponAfter, applyProjectileBounce,
} from './weapons.js';
import { PickupManager } from './pickups.js';
import { HUD } from './hud.js';
import {
  sfx, setEffectsVolume, setJetpackThrust, setListener, setMasterVolume,
  setRainAmbience, startWhomperWarmup, warmAudioSamplesInBackground,
  warmOlympusImpactAudio,
} from './audio.js';
import { multiplayer } from './multiplayer.js';
import { createJetpack } from './jetpack.js';
import { unlockSecretMap } from './secret-maps.js';
import { byId, setStyle, setText } from './dom.js';
import { mapPlayerLimit } from './map-rules.js';
import { HORSE_HEIGHT_DELTA } from './mount.js';
import { damageMultiplierForPowerup, resolveShieldedDamage } from './combat.js';
import { MobileControls } from './mobile-controls.js';
import { isStandaloneApp, setupPwaInstall } from './pwa.js';
import {
  advanceNetworkTimer, boundedSnapshotLead, coalesceSnapshotEvents,
} from './network-sync.js';
import {
  createGrappleVisual, disposeGrappleVisual, updateGrappleVisual,
} from './grapple.js';
import {
  TOAD_EFFECT_LOCKOUT, queueToadEffect, updateToadEffects,
} from './toad-effects.js';
import { clearDrowningState } from './water-movement.js';

const MATCH_TIME = 5 * 60; // no score limit — most points when time expires wins
const RESPAWN_TIME = 3;
const MULTIPLAYER_PODIUM_HOLD_MS = 15000;
const REMOTE_HUMAN_SNAP_DIST = 8;
const REMOTE_SLOT_SNAP_DIST = 20;
const REMOTE_HUMAN_PREDICT_LEAD = 0.055;
const REMOTE_HUMAN_MAX_PREDICT = 0.18;
const REMOTE_HUMAN_SMOOTH = 20;
const REMOTE_SLOT_SMOOTH = 22;
const MP_SNAPSHOT_HZ = 20;
const MP_INPUT_HZ = 30;
const MP_SNAPSHOT_STALL_MS = 2000;
const DAMAGE_MARKER_LIFETIME = 1.15;
const previousCharacterPos = new THREE.Vector3();
const MULTI_KILL_WINDOW = 2.75;
const MAX_KILL_AWARD = 7;
const KILL_AWARD_LABELS = {
  2: 'DOUBLE KILL',
  3: 'TRIPLE KILL',
  4: 'QUAD KILL',
  5: 'PENTA KILL',
  6: 'HEXA KILL',
  7: 'SEPTUPLE KILL',
};
const HEADSHOT_AWARD_LABELS = {
  2: 'DOUBLE HEADSHOT',
  3: 'TRIPLE HEADSHOT',
  4: 'QUAD HEADSHOT',
  5: 'PENTA HEADSHOT',
  6: 'HEXA HEADSHOT',
  7: 'SEPTUPLE HEADSHOT',
};

const FFA_COLORS = [
  '#5cb3ff', '#ff5c5c', '#6dff6d', '#ff8ce6', '#4dffd2', '#ff9c40', '#b06dff', '#e8e8f0',
  '#ffd166', '#06d6a0', '#ef476f', '#8ecae6', '#f72585', '#90be6d', '#f9844a', '#cdb4db',
];
const LAVA = { name: 'Lava', color: '#ff6a30', isPlayer: false, kills: 0, team: 'lava' };
const WATER = { name: 'Water', color: '#3fcfff', isPlayer: false, kills: 0, team: 'water' };
const LIGHTNING = { name: 'Lightning', color: '#dff7ff', isPlayer: false, kills: 0, team: 'storm' };
const METEOR = { name: 'Meteor', color: '#ff9a42', isPlayer: false, kills: 0, team: 'meteor' };
const COMET = { name: 'Comet', color: '#bde7ff', isPlayer: false, kills: 0, team: 'comet' };
const GATOR = { name: 'Canal Gator', color: '#8fbd45', isPlayer: false, kills: 0, team: 'gator' };
const SHARK = { name: 'Shark', color: '#79b7c8', isPlayer: false, kills: 0, team: 'shark' };
const CACTUS = { name: 'Cactus', color: '#4f9b55', isPlayer: false, kills: 0, team: 'cactus' };
const POISON_TOAD = {
  id: 'toad-poison', name: 'Poison Toad', color: '#79ff5b',
  isPlayer: false, kills: 0, team: 'toad-poison',
};
const SOLAR_FLARE = { name: 'Solar Flare', color: '#ff4b24', isPlayer: false, kills: 0, team: 'solar' };
const EVENT_BLAST_RADIUS = 10;
const EVENT_BLAST_DAMAGE = 50;

// Soundtrack — matches only, never the lobby.
const MUSIC = [
  { title: 'Foam Dart Rumble', src: './music/track1.mp3' },
  { title: 'Neon Foam Frenzy', src: './music/track2.mp3' },
  { title: 'Photon Draft', src: './music/photon-draft.mp3' },
  { title: 'Pixel Rush', src: './music/pixel-rush.mp3' },
  { title: 'Pixel Arena', src: './music/pixel-arena.mp3' },
  { title: 'Blaster Circuit', src: './music/blaster-circuit.mp3' },
  { title: 'Pixel Blast', src: './music/pixel-blast.mp3' },
];
const MUSIC_BASE_VOLUME = 0.3;
let musicEl = null;
let musicIdx = -1;
let loadedMusicIdx = -1;
let preparedMusicIdx = -1;
let currentTrackTitle = '';

function updateTrackTitle() {
  const el = byId('tracktitle');
  setText(el, currentTrackTitle || 'No track playing');
}

function nextMusicIndex() {
  if (MUSIC.length <= 1) return 0;
  let next = Math.floor(Math.random() * MUSIC.length);
  while (next === musicIdx) next = Math.floor(Math.random() * MUSIC.length);
  return next;
}

function ensureMusicElement() {
  if (musicEl) return musicEl;
  musicEl = new Audio();
  musicEl.preload = 'auto';
  musicEl.volume = MUSIC_BASE_VOLUME * gameVolume * musicMix;
  musicEl.addEventListener('ended', () => {
    playMusicIndex(nextMusicIndex());
  });
  return musicEl;
}

function playMusicIndex(idx) {
  const track = MUSIC[idx];
  if (!track) return;
  ensureMusicElement();
  musicIdx = idx;
  preparedMusicIdx = -1;
  currentTrackTitle = track.title;
  updateTrackTitle();
  if (loadedMusicIdx !== idx) {
    musicEl.src = track.src;
    loadedMusicIdx = idx;
  }
  // A track change normally resets this implicitly, but make the new-match
  // contract explicit even when the browser reuses a cached audio resource.
  try { musicEl.currentTime = 0; } catch { /* metadata may not be ready yet */ }
  musicEl.play().catch(() => {}); // blocked until a user gesture — fine
}

function prepareMusic() {
  ensureMusicElement();
  if (preparedMusicIdx >= 0) return;
  const idx = nextMusicIndex();
  const track = MUSIC[idx];
  if (!track) return;
  preparedMusicIdx = idx;
  musicEl.src = track.src;
  loadedMusicIdx = idx;
  try { musicEl.currentTime = 0; } catch { /* metadata may not be ready yet */ }
  musicEl.load();
}

function musicPlay() {
  ensureMusicElement();
  if (loadedMusicIdx < 0) {
    startMatchMusic();
    return;
  }
  musicEl?.play().catch(() => {});
}

function startMatchMusic() {
  const idx = preparedMusicIdx >= 0 ? preparedMusicIdx : nextMusicIndex();
  playMusicIndex(idx);
}

function musicStop() { musicEl?.pause(); }

const volumeStorageKey = 'nerf-arena-volume-v2';
const musicMixStorageKey = 'nerf-arena-music-mix-v1';
const effectsMixStorageKey = 'nerf-arena-effects-mix-v1';
let gameVolume = 1;
let musicMix = 1;
let effectsMix = 1;
try {
  const storedVolume = localStorage.getItem(volumeStorageKey);
  const storedMusic = localStorage.getItem(musicMixStorageKey);
  const storedEffects = localStorage.getItem(effectsMixStorageKey);
  if (storedVolume !== null && Number.isFinite(Number(storedVolume))) gameVolume = Math.max(0, Math.min(1, Number(storedVolume)));
  if (storedMusic !== null && Number.isFinite(Number(storedMusic))) musicMix = Math.max(0, Math.min(1, Number(storedMusic)));
  if (storedEffects !== null && Number.isFinite(Number(storedEffects))) effectsMix = Math.max(0, Math.min(1, Number(storedEffects)));
} catch { /* localStorage may be unavailable */ }
setMasterVolume(gameVolume);
setEffectsVolume(effectsMix);

const ua = navigator.userAgent || '';
const isSafari = /\bSafari\//.test(ua) && !/\b(Chrome|Chromium|CriOS|FxiOS|Edg|OPR)\//.test(ua);
const searchParams = new URLSearchParams(location.search);
const requestedQuality = searchParams.get('quality');
const GRAPHICS_PRESETS = {
  low: { label: 'Low', pixelRatioCap: 1, shadows: false, postprocessing: false, tier: 'low' },
  standard: { label: 'Medium', pixelRatioCap: 1.15, shadows: true, postprocessing: true, tier: 'standard' },
  high: { label: 'High', pixelRatioCap: 1.35, shadows: true, postprocessing: true, tier: 'high' },
};
const validGraphicsModes = new Set(['auto', ...Object.keys(GRAPHICS_PRESETS)]);
const TARGET_FPS = 90;
const FPS_FLOOR = 80;
const AUTO_MATCH_CALIBRATION_SECONDS = 10;
const ADAPTIVE_RENDER_MIN_SCALE = 0.68;
const AUTO_EMERGENCY_DOWNSCALE_SECONDS = 1.25;
const TARGET_FRAME_MS = 1000 / TARGET_FPS;
const FLOOR_FRAME_MS = 1000 / FPS_FLOOR;
const graphicsAutoStorageKey = 'nerf-arena-graphics-auto-v1';
const graphicsOverrideStorageKey = 'nerf-arena-graphics-override-v1';
let autoGraphicsTestStage = null;
let initialAutoGraphicsScale = 1;
let storedGraphicsOverride = null;
let inGameAutoTestStarted = false;
try {
  const storedAuto = localStorage.getItem(graphicsAutoStorageKey);
  const storedOverride = localStorage.getItem(graphicsOverrideStorageKey);
  if (storedAuto) {
    const parsed = JSON.parse(storedAuto);
    if ((parsed?.tested === 'atrium' || parsed?.tested === 'game') && Number.isFinite(Number(parsed.scale))) {
      autoGraphicsTestStage = parsed.tested;
      initialAutoGraphicsScale = Math.max(ADAPTIVE_RENDER_MIN_SCALE, Math.min(1, Number(parsed.scale)));
    }
  }
  if (storedOverride && GRAPHICS_PRESETS[storedOverride]) storedGraphicsOverride = storedOverride;
} catch { /* localStorage may be unavailable or contain an obsolete value */ }
// URL quality remains a temporary testing override. Ordinary launches restore
// a manual preset when one exists; otherwise Auto starts at its last tested
// scale instead of repeating the expensive adjustment from full quality.
let graphicsMode = validGraphicsModes.has(requestedQuality)
  ? requestedQuality
  : (storedGraphicsOverride || 'auto');
let pendingGraphicsMode = null;
const initialGraphicsPreset = GRAPHICS_PRESETS[graphicsMode] || null;
const performanceProfile = {
  safari: isSafari,
  pixelRatioCap: 1.35,
  msaaSamples: 2,
  shadows: true,
  postprocessing: true,
  targetFps: TARGET_FPS,
  fpsFloor: FPS_FLOOR,
};

function setGameVolume(value, persist = true) {
  gameVolume = Math.max(0, Math.min(1, Number(value) || 0));
  setMasterVolume(gameVolume);
  if (musicEl) musicEl.volume = MUSIC_BASE_VOLUME * gameVolume * musicMix;
  if (volumeSlider) volumeSlider.value = String(Math.round(gameVolume * 100));
  setText(volumeValue, `${Math.round(gameVolume * 100)}%`);
  if (persist) {
    try { localStorage.setItem(volumeStorageKey, String(gameVolume)); } catch { /* ignore */ }
  }
}

function setMusicMix(value, persist = true) {
  musicMix = Math.max(0, Math.min(1, Number(value) || 0));
  if (musicEl) musicEl.volume = MUSIC_BASE_VOLUME * gameVolume * musicMix;
  if (musicSlider) musicSlider.value = String(Math.round(musicMix * 100));
  setText(musicValue, `${Math.round(musicMix * 100)}%`);
  if (persist) {
    try { localStorage.setItem(musicMixStorageKey, String(musicMix)); } catch { /* ignore */ }
  }
}

function setEffectsMix(value, persist = true) {
  effectsMix = Math.max(0, Math.min(1, Number(value) || 0));
  setEffectsVolume(effectsMix);
  if (effectsSlider) effectsSlider.value = String(Math.round(effectsMix * 100));
  setText(effectsValue, `${Math.round(effectsMix * 100)}%`);
  if (persist) {
    try { localStorage.setItem(effectsMixStorageKey, String(effectsMix)); } catch { /* ignore */ }
  }
}

const canvas = document.getElementById('game');
const mapLoadingScreen = document.getElementById('maploading');
const mapLoadingTitle = document.getElementById('maploadingtitle');
const mapLoadingStatus = document.getElementById('maploadingstatus');
const mapLoadingTrack = document.getElementById('maploadingtrack');
const mapLoadingBar = document.getElementById('maploadingbar');
const mapLoadingPercent = document.getElementById('maploadingpercent');
const matchTransition = document.getElementById('matchtransition');
const endScreen = document.getElementById('endscreen');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let mapLoadingToken = 0;
let mapLoadingProgress = 0;

function clearVictoryPresentationUI() {
  matchTransition?.classList.remove('active', 'leaving', 'switching');
  endScreen?.classList.remove('visible');
  setStyle(endScreen, 'display', 'none');
}

function setMapLoadingStatus(message) {
  setText(mapLoadingStatus, message);
}

function setMapLoadingProgress(percent, message = null, token = mapLoadingToken) {
  if (token !== mapLoadingToken) return false;
  const next = Math.max(mapLoadingProgress, Math.min(100, Math.round(Number(percent) || 0)));
  mapLoadingProgress = next;
  if (message) setMapLoadingStatus(message);
  if (mapLoadingBar) mapLoadingBar.style.transform = `scaleX(${next / 100})`;
  if (mapLoadingTrack) {
    mapLoadingTrack.setAttribute('aria-valuenow', String(next));
    if (message) mapLoadingTrack.setAttribute('aria-valuetext', `${next}% — ${message}`);
  }
  setText(mapLoadingPercent, `${next}%`);
  return true;
}

function showMapLoading(mapDef) {
  const token = ++mapLoadingToken;
  mapLoadingProgress = 0;
  setText(mapLoadingTitle, mapDef?.name || 'PREPARING ARENA');
  setMapLoadingProgress(0, 'Preparing shared arena assets', token);
  if (mapLoadingScreen) mapLoadingScreen.hidden = false;
  return token;
}

function hideMapLoading() {
  mapLoadingToken++;
  if (mapLoadingScreen) mapLoadingScreen.hidden = true;
}

function finishMapLoading(token = mapLoadingToken) {
  if (!mapLoadingScreen || mapLoadingScreen.hidden || token !== mapLoadingToken) return;
  setMapLoadingProgress(100, 'Arena ready', token);
  // Keep the cover through the first completed game frame. That prevents a
  // flash of an unrendered scene after the synchronous arena build finishes.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (token === mapLoadingToken) mapLoadingScreen.hidden = true;
  }));
}

function paintLoadingStage() {
  return new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
// Post-processing multiplies per-pixel cost — cap the internal resolution.
// (1.35× CSS pixels + 2× MSAA looks nearly identical to 2×/4× at half the GPU load.)
renderer.setPixelRatio(Math.min(devicePixelRatio,
  initialGraphicsPreset?.pixelRatioCap ?? performanceProfile.pixelRatioCap * initialAutoGraphicsScale));
renderer.shadowMap.enabled = initialGraphicsPreset?.shadows ?? performanceProfile.shadows;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.02;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 900);

// Full-screen magical transit used by the atrium's hidden orbital launcher.
// The procedural canvas keeps the destination fully concealed while clouds
// stretch into star trails, and can run backward for the return trip.
const secretTransitCanvas = document.createElement('canvas');
Object.assign(secretTransitCanvas.style, {
  position: 'fixed', inset: '0', width: '100%', height: '100%',
  display: 'none', pointerEvents: 'none', zIndex: '30', opacity: '0',
});
document.body.appendChild(secretTransitCanvas);
const secretTransitCtx = secretTransitCanvas.getContext('2d');
const transitStreaks = Array.from({ length: 150 }, (_, i) => ({
  a: (i * 2.399963229728653) % (Math.PI * 2),
  phase: ((i * 73) % 149) / 149,
  length: 0.35 + ((i * 29) % 71) / 71,
  bright: 0.45 + ((i * 41) % 53) / 95,
}));
const transitClouds = Array.from({ length: 42 }, (_, i) => ({
  a: (i * 2.17) % (Math.PI * 2),
  phase: ((i * 31) % 43) / 43,
  size: 0.65 + ((i * 17) % 29) / 18,
}));
let secretTransitToken = 0;

function sizeSecretTransitCanvas() {
  const ratio = Math.min(devicePixelRatio || 1, 1.5);
  secretTransitCanvas.width = Math.max(1, Math.floor(innerWidth * ratio));
  secretTransitCanvas.height = Math.max(1, Math.floor(innerHeight * ratio));
}

function playSecretTransit(direction, onTransfer) {
  const token = ++secretTransitToken;
  sizeSecretTransitCanvas();
  secretTransitCanvas.style.display = 'block';
  const start = performance.now();
  const duration = 2650;
  let transferred = false;
  const smooth = (edge0, edge1, value) => {
    const x = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
    return x * x * (3 - 2 * x);
  };
  const frame = (now) => {
    if (token !== secretTransitToken) return;
    const p = Math.min(1, (now - start) / duration);
    const travel = direction === 'outbound' ? p : 1 - p;
    if (!transferred && p >= 0.7) {
      transferred = true;
      onTransfer?.();
    }

    const w = secretTransitCanvas.width;
    const h = secretTransitCanvas.height;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const maxR = Math.hypot(w, h) * 0.62;
    const cloudMix = 1 - smooth(0.28, 0.68, travel);
    const spaceMix = smooth(0.34, 0.72, travel);
    const bg = secretTransitCtx.createRadialGradient(cx, cy, 0, cx, cy, maxR);
    bg.addColorStop(0, `rgba(${Math.round(145 - spaceMix * 124)},${Math.round(190 - spaceMix * 174)},${Math.round(235 - spaceMix * 199)},1)`);
    bg.addColorStop(0.55, `rgba(${Math.round(105 - spaceMix * 96)},${Math.round(125 - spaceMix * 114)},${Math.round(190 - spaceMix * 163)},1)`);
    bg.addColorStop(1, `rgba(${Math.round(54 - spaceMix * 50)},${Math.round(42 - spaceMix * 38)},${Math.round(94 - spaceMix * 80)},1)`);
    secretTransitCtx.fillStyle = bg;
    secretTransitCtx.fillRect(0, 0, w, h);

    secretTransitCtx.save();
    secretTransitCtx.globalCompositeOperation = 'screen';
    for (const cloud of transitClouds) {
      const r = ((travel * 1.7 + cloud.phase) % 1) * maxR;
      const x = cx + Math.cos(cloud.a) * r;
      const y = cy + Math.sin(cloud.a) * r * 0.72;
      const size = (28 + r * 0.14) * cloud.size;
      const grad = secretTransitCtx.createRadialGradient(x, y, 0, x, y, size);
      grad.addColorStop(0, `rgba(255,255,255,${0.5 * cloudMix})`);
      grad.addColorStop(0.45, `rgba(220,239,255,${0.24 * cloudMix})`);
      grad.addColorStop(1, 'rgba(200,225,255,0)');
      secretTransitCtx.fillStyle = grad;
      secretTransitCtx.beginPath();
      secretTransitCtx.arc(x, y, size, 0, Math.PI * 2);
      secretTransitCtx.fill();
    }
    secretTransitCtx.lineCap = 'round';
    for (const streak of transitStreaks) {
      const r = (0.05 + ((travel * 2.8 + streak.phase) % 1)) * maxR;
      const trail = (18 + r * 0.2) * streak.length * spaceMix;
      const cos = Math.cos(streak.a), sin = Math.sin(streak.a);
      secretTransitCtx.strokeStyle = `rgba(210,239,255,${streak.bright * spaceMix})`;
      secretTransitCtx.lineWidth = 1.2 + spaceMix * 2.2;
      secretTransitCtx.beginPath();
      secretTransitCtx.moveTo(cx + cos * Math.max(0, r - trail), cy + sin * Math.max(0, r - trail));
      secretTransitCtx.lineTo(cx + cos * r, cy + sin * r);
      secretTransitCtx.stroke();
    }
    const core = secretTransitCtx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(w, h) * 0.24);
    core.addColorStop(0, `rgba(255,255,255,${0.78 - spaceMix * 0.42})`);
    core.addColorStop(0.2, `rgba(115,225,255,${0.35 + spaceMix * 0.2})`);
    core.addColorStop(1, 'rgba(70,130,255,0)');
    secretTransitCtx.fillStyle = core;
    secretTransitCtx.fillRect(0, 0, w, h);
    secretTransitCtx.restore();

    const fadeIn = smooth(0, 0.08, p);
    const fadeOut = 1 - smooth(0.82, 1, p);
    secretTransitCanvas.style.opacity = String(fadeIn * fadeOut);
    if (p < 1) requestAnimationFrame(frame);
    else {
      if (!transferred) onTransfer?.();
      secretTransitCanvas.style.display = 'none';
      secretTransitCanvas.style.opacity = '0';
    }
  };
  requestAnimationFrame(frame);
}

// Post-processing: MSAA render target → bloom on emissives → tonemap/output
const composer = new EffectComposer(renderer,
  new THREE.WebGLRenderTarget(1, 1, {
    samples: initialGraphicsPreset?.postprocessing === false ? 0 : performanceProfile.msaaSamples,
    type: performanceProfile.postprocessing ? THREE.HalfFloatType : THREE.UnsignedByteType,
  }));
const renderPass = new RenderPass(new THREE.Scene(), camera);
const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.42, 0.58, 0.94);
bloomPass.enabled = initialGraphicsPreset?.postprocessing ?? performanceProfile.postprocessing;
const outputPass = new OutputPass();
composer.addPass(renderPass);
composer.addPass(bloomPass);
composer.addPass(outputPass);

// Soft studio environment for PBR reflections (metal medals, station panels)
const pmrem = new THREE.PMREMGenerator(renderer);
const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  composer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  if (secretTransitCanvas.style.display !== 'none') sizeSecretTransitCanvas();
}
addEventListener('resize', resize);
resize();

// Hold a 90 fps work budget on capable/high-refresh hardware, with 80 fps as
// the hard floor. Frame cadence catches real GPU pressure on 90-144 Hz panels;
// measured main-thread work keeps the policy meaningful on a 60 Hz display,
// where requestAnimationFrame cannot physically report 90 fps. Quality changes
// are deliberately gradual so a map load or a single GC hitch cannot trigger a
// visible downgrade.
const adaptiveRender = {
  scale: initialAutoGraphicsScale,
  detectedScale: initialAutoGraphicsScale,
  slowT: 0,
  clearT: 0,
  cooldown: 0,
  fastestFrameMs: Infinity,
  sampleT: 0,
  adjustmentQueued: false,
  visualTier: initialGraphicsPreset?.tier ?? (initialAutoGraphicsScale < 0.76
    ? 'low'
    : initialAutoGraphicsScale < 0.92 ? 'standard' : 'high'),
};
const perfTelemetry = { frameMs: [], workMs: [], maxSamples: 360, sampleCounter: 0 };

function persistAutoGraphicsTest(tested) {
  if (tested !== 'atrium' && tested !== 'game') return;
  const scale = Math.max(ADAPTIVE_RENDER_MIN_SCALE, Math.min(1, adaptiveRender.detectedScale));
  autoGraphicsTestStage = tested;
  try {
    localStorage.setItem(graphicsAutoStorageKey, JSON.stringify({
      scale: Number(scale.toFixed(2)),
      tested,
    }));
  } catch { /* localStorage may be unavailable */ }
}

function finishAtriumAutoGraphicsTest() {
  if (graphicsMode === 'auto' && autoGraphicsTestStage === null && G?.atrium) {
    persistAutoGraphicsTest('atrium');
  }
}

function finishInGameAutoGraphicsTest() {
  if (graphicsMode !== 'auto' || autoGraphicsTestStage === 'game' || !inGameAutoTestStarted || !G || G.atrium) return false;
  const matchDuration = G.world?.matchTime || MATCH_TIME;
  if (matchDuration - G.timeLeft < AUTO_MATCH_CALIBRATION_SECONDS) return false;
  persistAutoGraphicsTest('game');
  inGameAutoTestStarted = false;
  updateGraphicsUI();
  return true;
}

function presentationTier() {
  const preset = GRAPHICS_PRESETS[graphicsMode];
  if (preset) return preset.tier;
  if (adaptiveRender.scale < 0.76) return 'low';
  if (adaptiveRender.scale < 0.92) return 'standard';
  return 'high';
}

function syncWorldVisualQuality() {
  const tier = presentationTier();
  adaptiveRender.visualTier = tier;
  G?.world?.setVisualQuality?.(tier);
}

function applyAdaptiveRenderScale() {
  const preset = GRAPHICS_PRESETS[graphicsMode];
  const ratioCap = preset?.pixelRatioCap ?? performanceProfile.pixelRatioCap * adaptiveRender.scale;
  const ratio = Math.min(devicePixelRatio, ratioCap);
  if (Math.abs(renderer.getPixelRatio() - ratio) >= 0.005) {
    renderer.setPixelRatio(ratio);
    composer.setPixelRatio?.(ratio);
    resize();
  }
  syncWorldVisualQuality();
  syncRenderQuality();
  updateGraphicsUI();
}
function resetAdaptiveRenderScale({ preserveDetection = false } = {}) {
  adaptiveRender.scale = preserveDetection ? adaptiveRender.detectedScale : 1;
  if (!preserveDetection) adaptiveRender.detectedScale = 1;
  adaptiveRender.slowT = 0;
  adaptiveRender.clearT = 0;
  adaptiveRender.cooldown = 0;
  // Keep the learned display cadence across arena swaps. A heavy map that
  // starts out missing every other 60 Hz frame would otherwise mistake 33 ms
  // for the monitor's native cadence and never trigger its emergency scale.
  if (!preserveDetection) adaptiveRender.fastestFrameMs = Infinity;
  adaptiveRender.sampleT = 0;
  adaptiveRender.adjustmentQueued = false;
  perfTelemetry.frameMs.length = 0;
  perfTelemetry.workMs.length = 0;
  perfTelemetry.sampleCounter = 0;
  applyAdaptiveRenderScale();
}
function recordPerformanceSample(frameMs, workMs) {
  // Debug telemetry does not need a 90–144 Hz history. Sampling every fourth
  // frame avoids shifting two 360-entry arrays on every render while retaining
  // several seconds of representative frame pacing for window.__perf().
  if (perfTelemetry.sampleCounter++ % 4 !== 0) return;
  perfTelemetry.frameMs.push(frameMs);
  perfTelemetry.workMs.push(workMs);
  if (perfTelemetry.frameMs.length > perfTelemetry.maxSamples) perfTelemetry.frameMs.shift();
  if (perfTelemetry.workMs.length > perfTelemetry.maxSamples) perfTelemetry.workMs.shift();
}
function updateAdaptiveRenderScale(frameMs, workMs) {
  // A fresh install tests once in the Atrium, then once during the opening of
  // the first arena. After that, quality never climbs mid-match, but sustained
  // missed display frames may still lower it. That catches heavier later maps
  // and 60 Hz machines, where a fixed 80 fps cadence test cannot work.
  if (graphicsMode !== 'auto') return;
  finishInGameAutoGraphicsTest();
  const calibrationOpen = autoGraphicsCalibrationOpen();
  if (calibrationOpen && G && !G.atrium) inGameAutoTestStarted = true;
  const dt = Math.min(0.1, Math.max(0, frameMs / 1000));
  adaptiveRender.cooldown = Math.max(0, adaptiveRender.cooldown - dt);
  adaptiveRender.sampleT += dt;
  if (frameMs > 1 && frameMs < adaptiveRender.fastestFrameMs) adaptiveRender.fastestFrameMs = frameMs;
  // Once each sampling window is established, let the minimum drift upward so
  // moving the tab between displays eventually re-detects the new refresh rate.
  if (adaptiveRender.sampleT > 8) {
    adaptiveRender.fastestFrameMs = Math.min(frameMs, adaptiveRender.fastestFrameMs * 1.08);
    adaptiveRender.sampleT = 0;
  }
  const highRefreshCadence = adaptiveRender.fastestFrameMs < FLOOR_FRAME_MS * 1.08;
  const missedDisplayFrame = Number.isFinite(adaptiveRender.fastestFrameMs) &&
    frameMs > adaptiveRender.fastestFrameMs * 1.55 + 0.5;
  const cadenceOverBudget = highRefreshCadence
    ? frameMs > FLOOR_FRAME_MS * 1.08
    : missedDisplayFrame;
  const workOverBudget = workMs > FLOOR_FRAME_MS;
  const cadenceClear = highRefreshCadence
    ? frameMs < TARGET_FRAME_MS * 1.08
    : frameMs < adaptiveRender.fastestFrameMs * 1.22 + 0.5;
  const workClear = workMs < TARGET_FRAME_MS * 0.78;
  if (cadenceOverBudget || workOverBudget) {
    adaptiveRender.slowT += dt;
    adaptiveRender.clearT = 0;
  } else if (cadenceClear && workClear) {
    adaptiveRender.clearT += dt;
    adaptiveRender.slowT = Math.max(0, adaptiveRender.slowT - dt * 0.5);
  } else {
    adaptiveRender.slowT = Math.max(0, adaptiveRender.slowT - dt * 0.25);
    adaptiveRender.clearT = 0;
  }
  const downscaleAfter = calibrationOpen ? 0.75 : AUTO_EMERGENCY_DOWNSCALE_SECONDS;
  if (!adaptiveRender.adjustmentQueued && !adaptiveRender.cooldown &&
      adaptiveRender.slowT >= downscaleAfter &&
      adaptiveRender.detectedScale > ADAPTIVE_RENDER_MIN_SCALE) {
    adaptiveRender.detectedScale = Math.max(
      ADAPTIVE_RENDER_MIN_SCALE,
      adaptiveRender.detectedScale - 0.08,
    );
    adaptiveRender.slowT = 0;
    adaptiveRender.cooldown = 0.65;
    adaptiveRender.adjustmentQueued = true;
    // Resizing the renderer and both post-processing targets during live play
    // can synchronously block the browser and graphics driver even on a fast
    // GPU. Learn the safer scale now, then apply it once at the next covered
    // arena transition.
    if (!calibrationOpen && autoGraphicsTestStage === 'game') persistAutoGraphicsTest('game');
  } else if (calibrationOpen && !adaptiveRender.adjustmentQueued && !adaptiveRender.cooldown &&
      adaptiveRender.clearT >= 5 && adaptiveRender.detectedScale < 1) {
    adaptiveRender.detectedScale = Math.min(1, adaptiveRender.detectedScale + 0.04);
    adaptiveRender.clearT = 0;
    adaptiveRender.cooldown = 0.8;
    adaptiveRender.adjustmentQueued = true;
  }
}

function usesLightRenderPath() {
  const preset = GRAPHICS_PRESETS[graphicsMode];
  if (preset) return !preset.postprocessing;
  return presentationTier() === 'low';
}

function syncRenderQuality() {
  const preset = GRAPHICS_PRESETS[graphicsMode];
  const tier = presentationTier();
  const presetShadows = preset?.shadows ?? tier !== 'low';
  // Exceptionally large arenas can opt Medium out of the duplicate shadow
  // draw pass while leaving High completely intact. Low already disables it.
  renderer.shadowMap.enabled = presetShadows &&
    !(tier === 'standard' && G?.world?.mediumShadows === false);
  bloomPass.enabled = (preset?.postprocessing ?? presentationTier() !== 'low') && !usesLightRenderPath();
  const samples = usesLightRenderPath() ? 0 : performanceProfile.msaaSamples;
  for (const target of [composer.renderTarget1, composer.renderTarget2]) {
    if (!target || target.samples === samples) continue;
    target.samples = samples;
    target.dispose();
  }
  syncWorldVisualQuality();
}

const hud = new HUD();
const underwaterFx = document.getElementById('underwaterFx');
const foliageFx = document.getElementById('foliageFx');
const hallucinationFx = document.getElementById('hallucinationFx');
const hallucinationSpiral = document.getElementById('hallucinationSpiral');
let G = null; // current match state (or the lobby)
let rafId = 0;
let mapLoadInProgress = false;
let sharedFxPool = null;
let selectedMode = 'ffa';
let openingMultiplayer = false;
let multiplayerVotingTimer = 0;
let multiplayerMapLoadRequest = null;
let multiplayerMapLoadVersion = 0;
let mobilePauseOpen = false;
let mobilePauseOpenedAt = 0;
const lastSpawnByKey = new Map();
const lastSpawnFaceByKey = new Map();

function fxPoolForScene(scene) {
  if (!sharedFxPool) sharedFxPool = new FXPool(scene);
  else sharedFxPool.setScene(scene);
  return sharedFxPool;
}

function usesMobileControls() {
  return mobileControls.active;
}

function startsPausedForPointerLock() {
  return !usesMobileControls() && document.pointerLockElement !== canvas;
}

function gameplayOverlayDisplay() {
  return usesMobileControls() || document.pointerLockElement === canvas ? 'none' : 'flex';
}

function hierarchyPairs(source, copy) {
  const sourceNodes = [];
  const copyNodes = [];
  source.traverse(node => sourceNodes.push(node));
  copy.traverse(node => copyNodes.push(node));
  if (sourceNodes.length !== copyNodes.length) return null;
  return sourceNodes.map((node, i) => [node, copyNodes[i]]);
}

function syncHierarchyPairs(pairs, skipRoot = true) {
  if (!pairs) return;
  for (let i = skipRoot ? 1 : 0; i < pairs.length; i++) {
    const [source, copy] = pairs[i];
    copy.position.copy(source.position);
    copy.quaternion.copy(source.quaternion);
    copy.scale.copy(source.scale);
    copy.visible = source.visible;
    copy.renderOrder = source.renderOrder;
    copy.castShadow = source.castShadow;
    copy.receiveShadow = source.receiveShadow;
    copy.layers.mask = source.layers.mask;
    if ('geometry' in source) copy.geometry = source.geometry;
    if ('material' in source) copy.material = source.material;
    if (source.morphTargetInfluences && copy.morphTargetInfluences) {
      const count = Math.min(source.morphTargetInfluences.length, copy.morphTargetInfluences.length);
      for (let j = 0; j < count; j++) copy.morphTargetInfluences[j] = source.morphTargetInfluences[j];
    }
  }
}

// The first-person player has no canonical world body. Infinite Bloom still
// needs to show that same player in its adjacent recursive layers, so keep one
// detached third-person source built by the exact normal-character factory.
// The map clones this source; it never enters the canonical scene or physics.
function syncRecursivePlayerAvatar(player) {
  if (!player?.world?.recursiveVisual) return null;
  let state = player._recursiveAvatarState;
  if (!state) {
    const color = colorHex(player);
    const { group, body, head, visor, jetpack } = buildBotMesh(color, player.world.mounted);
    group.name = 'infinite-bloom-local-player-source';
    state = {
      root: group,
      body,
      visor,
      jetpack,
      ownedMeshes: [body, head, visor],
      color,
      weaponSource: null,
      gun: null,
      gunPairs: null,
    };
    player._recursiveAvatarState = state;
    player.recursiveRenderSource = group;
  }

  const color = colorHex(player);
  if (state.color !== color) {
    state.color = color;
    state.body.material.color.setHex(color);
    state.visor.material.emissive.setHex(color);
  }

  const weaponSource = player.vmWeapons?.[player.weapon || 'blaster'];
  if (weaponSource && state.weaponSource !== weaponSource) {
    if (state.gun) state.root.remove(state.gun);
    state.weaponSource = weaponSource;
    state.gun = weaponSource.clone(true);
    state.gun.name = `infinite-bloom-local-${player.weapon || 'blaster'}`;
    state.gunPairs = hierarchyPairs(weaponSource, state.gun);
    state.root.add(state.gun);
  }
  if (state.gun) {
    // Copy shell material replacements and nested Whomper charge animation
    // from the live viewmodel, but retain the normal third-person hand pose.
    syncHierarchyPairs(state.gunPairs);
    state.gun.visible = true;
    state.gun.scale.setScalar(0.55);
    state.gun.position.set(0.32, player.world.mounted ? 2 + HORSE_HEIGHT_DELTA : 1.05, 0.25);
    state.gun.rotation.set(0, Math.PI, 0);
  }
  syncJetpackVisual(player, 0, state.jetpack);

  state.root.visible = player.alive !== false;
  state.root.position.copy(player.pos);
  state.root.rotation.set(0, (player.yaw || 0) + Math.PI, 0);
  state.root.scale.set(1, 1, 1);
  return state.root;
}

function disposeRecursivePlayerAvatar(player) {
  const state = player?._recursiveAvatarState;
  if (!state) return;
  if (state.gun) state.root.remove(state.gun); // shares viewmodel resources
  for (const mesh of state.ownedMeshes) {
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      material?.map?.dispose();
      material?.normalMap?.dispose();
      material?.dispose();
    }
  }
  state.root.clear();
  player.recursiveRenderSource = null;
  player._recursiveAvatarState = null;
}

function bindWorldPresentation(world, syncToMultiplayer = false) {
  if (world?.recursiveVisual) {
    world.characterMirrorSource = character => character?.isPlayer
      ? syncRecursivePlayerAvatar(character)
      : (character?.recursiveRenderSource || character?.mesh || null);
  }
  if (!world?.runeEngine) return;
  if (syncToMultiplayer && Number.isFinite(multiplayer.phaseEndsAt)) {
    const remaining = Math.max(0, (multiplayer.phaseEndsAt - Date.now()) / 1000);
    world.runeTimeOffset = Math.max(0, MATCH_TIME - remaining);
  }
}

function modeLabel(mode = selectedMode) {
  return mode === 'tdm' ? 'MODE: TEAM DEATHMATCH' : 'MODE: FREE FOR ALL';
}

async function queueMapLoad(mapDef, mode = selectedMode) {
  if (!mapDef || mapLoadInProgress) return;
  mapLoadInProgress = true;
  const token = showMapLoading(mapDef);
  setStyle(clickcatch, 'display', 'none');
  prioritizeTextureLoading();
  const updateSharedProgress = ({ ready, total }) => {
    const ratio = total ? ready / total : 1;
    setMapLoadingProgress(
      ready >= total ? 20 : Math.floor(ratio * 20),
      ready < total ? `Preparing shared assets (${ready}/${total})` : 'Shared assets ready',
      token,
    );
  };
  let unsubscribe = () => {};
  try {
    // Let a real 0% frame paint before reporting anything already prepared in
    // the Atrium. Otherwise a warm load can replace 0% in the same browser task
    // and the bar appears to begin partway across.
    await paintLoadingStage();
    unsubscribe = onTextureLoadProgress(updateSharedProgress);
    await texturesReady;
    if (token !== mapLoadingToken) return;
    updateSharedProgress(getTextureLoadProgress());
    await paintLoadingStage();
    await startMatchProgressively(mapDef, mode, token);
  } finally {
    unsubscribe();
    mapLoadInProgress = false;
  }
}

function syncAtriumModeSign(world = G?.world) {
  world?.setModeSign?.(modeLabel(selectedMode));
}

setInterval(() => {
  if (!G?.multiplayerHost || multiplayer.phase !== 'playing' || G.over || G.mpConnectionPaused) return;
  const now = performance.now();
  if (now - (G.lastStepWall || 0) < 120) return;
  const dt = Math.min(0.1, Math.max(0.016, (now - G.lastT) / 1000));
  G.lastT = now;
  G.lastStepWall = now;
  step(dt);
}, 100);

document.getElementById('againbtn').addEventListener('click', () => {
  setStyle(document.getElementById('endscreen'), 'display', 'none');
  resetHighScoreForm();
  endMatch(true);
});

/* ---------------- match setup ---------------- */
function clearMatchDrowningState(game = G) {
  for (const ch of game?.characters || []) clearDrowningState(ch);
}

function teardown() {
  clearVictoryPresentationUI();
  if (!G) return;
  clearMatchDrowningState(G);
  mobilePauseOpen = false;
  mobileControls.reset();
  setJetpackThrust(false);
  setPauseScoreboardLayer(false);
  updateUnderwaterFx(1, true);
  updateFoliageFx(1, true);
  updateHallucinationFx(1, true);
  setRainAmbience(0);
  G.over = true;
  for (const ch of G.characters || []) {
    ch.cancelWeaponWarmup?.();
    ch.warmupAudioStop?.();
    disposeGrappleVisual(ch.grappleVisual);
    ch.grappleVisual = null;
    disposeNameTag(ch);
  }
  G.projectiles.clear();
  G.pickups.clear();
  G.fxPool.clear();
  clearEventVisualPools();
  G.meteors = [];
  G.comets = [];
  G.mpTracerPool?.dispose();
  for (const marker of dmgMarkerPool) destroyDmgMarker(marker, G.scene);
  dmgMarkers = [];
  dmgMarkerPool = [];
  // Mounted and map-exclusive equipment must never survive the camera handoff
  // into the Atrium. These are independent camera children rather than part of
  // the normal weapon hierarchy, so remove them explicitly during teardown.
  G.player.dualBlaster = false;
  G.player.galloping = false;
  G.player.syncDualBlasterViewmodel?.();
  camera.remove(G.player.viewmodel);
  camera.remove(G.player.dualBlasterViewmodel);
  camera.remove(G.player.grappleViewmodel);
  camera.remove(G.player.horseViewmodel);
  camera.remove(G.player.muzzleFlash);
  camera.remove(G.player.leftMuzzleFlash);
  hud.els.hud.classList.remove('endboard');
  setStyle(hud.els.board, 'display', 'none');
  setStyle(hud.els.board, 'top', '');
  setStyle(hud.els.board, 'zIndex', '');
  setStyle(hud.els.board, 'background', '');
  G.world.dispose?.();
  disposeRecursivePlayerAvatar(G.player);
  G.scene.clear();
  G = null;
}

function uniqueSpawnPoints(spawns) {
  const seen = new Set();
  const out = [];
  for (const p of spawns || []) {
    const key = spawnCoordKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function spawnCoordKey(p) {
  return `${Math.round(p.x * 10)}:${Math.round(p.y * 10)}:${Math.round(p.z * 10)}`;
}

function cameraUnderwater() {
  const zones = G?.world?.waterZones;
  if (!zones?.length) return false;
  const p = camera.position;
  return zones.some(z => (
    pointInZoneXZ(z, p.x, p.z) &&
    p.y >= (z.bottomY ?? z.surfaceY - 4) - 0.4 &&
    p.y < z.surfaceY - 0.04
  ));
}

function updateUnderwaterFx(dt, forceClear = false) {
  if (!G) return;
  const target = !forceClear && cameraUnderwater() ? 1 : 0;
  G.underwaterMix = forceClear ? 0 : THREE.MathUtils.damp(G.underwaterMix || 0, target, 10, dt);
  const mix = G.underwaterMix;
  const active = mix > 0.01;
  setStyle(underwaterFx, 'opacity', active ? String(0.78 * mix) : '0');

  const scene = G.scene;
  if (!scene) return;
  if (!G.baseFogCaptured) {
    G.baseFog = scene.fog ? {
      color: scene.fog.color.clone(),
      near: scene.fog.near,
      far: scene.fog.far,
    } : null;
    G.baseBackground = scene.background?.isColor ? scene.background.clone() : null;
    G.baseFogCaptured = true;
  }

  if (!active) {
    if (target === 0 && G.underwaterFogActive) {
      if (G.baseFog) {
        scene.fog.color.copy(G.baseFog.color);
        scene.fog.near = G.baseFog.near;
        scene.fog.far = G.baseFog.far;
      } else {
        scene.fog = null;
      }
      if (G.baseBackground && scene.background?.isColor) {
        scene.background.copy(G.baseBackground);
      }
      G.underwaterFogActive = false;
    }
    return;
  }

  if (active) {
    if (!scene.fog) scene.fog = new THREE.Fog(0x0a7aa0, 8, 70);
    scene.fog.color.set(0x0a7aa0);
    scene.fog.near = THREE.MathUtils.lerp(G.baseFog?.near ?? 120, 5, mix);
    scene.fog.far = THREE.MathUtils.lerp(G.baseFog?.far ?? 340, 42, mix);
    if (G.baseBackground && scene.background?.isColor) {
      scene.background.copy(G.baseBackground).lerp(new THREE.Color(0x075d78), mix);
    }
    G.underwaterFogActive = true;
  }
}

function cameraInFoliage() {
  const zones = G?.world?.foliageZones;
  if (!zones?.length) return false;
  const p = camera.position;
  return zones.some(z => {
    if (z.r != null) {
      return (p.x - z.x) * (p.x - z.x) +
        (p.y - z.y) * (p.y - z.y) +
        (p.z - z.z) * (p.z - z.z) < z.r * z.r;
    }
    return p.x >= z.minX && p.x <= z.maxX &&
      p.y >= z.minY && p.y <= z.maxY &&
      p.z >= z.minZ && p.z <= z.maxZ;
  });
}

function paintHallucinationSpiral() {
  const ctx = hallucinationSpiral?.getContext('2d');
  if (!ctx) return;
  const size = hallucinationSpiral.width;
  const center = size / 2;
  ctx.clearRect(0, 0, size, size);

  const aura = typeof ctx.createConicGradient === 'function'
    ? ctx.createConicGradient(Math.PI / 9, center, center)
    : ctx.createLinearGradient(0, 0, size, size);
  aura.addColorStop(0, 'rgba(255,48,220,.58)');
  aura.addColorStop(0.25, 'rgba(70,255,188,.46)');
  aura.addColorStop(0.5, 'rgba(92,96,255,.56)');
  aura.addColorStop(0.75, 'rgba(255,210,70,.42)');
  aura.addColorStop(1, 'rgba(255,48,220,.58)');
  ctx.fillStyle = aura;
  ctx.beginPath();
  ctx.arc(center, center, center, 0, Math.PI * 2);
  ctx.fill();

  const veil = ctx.createRadialGradient(center, center, size * 0.08, center, center, center);
  veil.addColorStop(0, 'rgba(20,5,42,.05)');
  veil.addColorStop(0.48, 'rgba(50,15,82,.08)');
  veil.addColorStop(1, 'rgba(8,3,28,.42)');
  ctx.fillStyle = veil;
  ctx.fillRect(0, 0, size, size);

  ctx.globalCompositeOperation = 'screen';
  ctx.lineCap = 'round';
  const spiralColors = [
    'rgba(126,255,214,.34)',
    'rgba(237,91,255,.31)',
    'rgba(105,117,255,.28)',
  ];
  for (let arm = 0; arm < spiralColors.length; arm++) {
    ctx.beginPath();
    for (let step = 0; step <= 180; step++) {
      const progress = step / 180;
      const angle = arm * Math.PI * 2 / spiralColors.length + progress * Math.PI * 5.5;
      const radius = size * (0.03 + progress * 0.54);
      const x = center + Math.cos(angle) * radius;
      const y = center + Math.sin(angle) * radius;
      if (step === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = spiralColors[arm];
    ctx.lineWidth = size * 0.026;
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
}

paintHallucinationSpiral();

function updateFoliageFx(dt, forceClear = false) {
  if (!G) return;
  const target = !forceClear && cameraInFoliage() ? 1 : 0;
  G.foliageMix = forceClear ? 0 : THREE.MathUtils.damp(G.foliageMix || 0, target, 18, dt);
  const mix = G.foliageMix;
  setStyle(foliageFx, 'opacity', mix > 0.01 ? String(0.72 * mix) : '0');
}

function updateHallucinationFx(dt, forceClear = false) {
  if (!G) return;
  const mix = !forceClear && G.player?.alive ? (G.hallucinationStrength || 0) : 0;
  G.hallucinationMix = mix;
  const strength = mix * mix * (3 - 2 * mix);
  const active = mix > 0;
  setStyle(hallucinationFx, 'opacity', active ? String(0.82 * strength) : '0');
  document.body.classList.toggle('toad-hallucinating', active);

  // Drive the camera warp here so its scale, skew, and color all share the
  // same one-second ease instead of the CSS animation snapping on and off.
  if (active) {
    G.hallucinationPhase = (G.hallucinationPhase || 0) + dt;
    const phase = G.hallucinationPhase;
    const waveX = Math.sin(phase * 8.4);
    const waveY = Math.sin(phase * 6.9 + 1.7);
    const wobbleBoost = 1.5;
    const scaleX = 1 + strength * (0.034 + waveX * 0.012 * wobbleBoost);
    const scaleY = 1 + strength * (0.032 + waveY * 0.014 * wobbleBoost);
    const rotation = strength * waveX * 0.2 * wobbleBoost;
    const skew = strength * waveY * 0.42 * wobbleBoost;
    setStyle(renderer.domElement, 'transform',
      `scale(${scaleX.toFixed(4)},${scaleY.toFixed(4)}) rotate(${rotation.toFixed(3)}deg) skewX(${skew.toFixed(3)}deg)`);
    setStyle(renderer.domElement, 'filter', '');
  } else {
    G.hallucinationPhase = 0;
    setStyle(renderer.domElement, 'transform', '');
    setStyle(renderer.domElement, 'filter', '');
  }
}

function bindMyceliumToadEffects(world) {
  if (!world?.myceliumToads?.length) return;
  world.onToadTouch = (character, toad) => {
    if (!character?.alive || (!character.isPlayer && !character.remoteHuman)) return;
    // Guests predict only their own touch. The host applies poison to every
    // human, while each player's browser owns its local hallucination effect.
    if (G?.multiplayer && !G.multiplayerHost && !character.isPlayer) return;
    if ((character._toadEffectCooldown || 0) > 0) return;
    const personality = toad.touchPersonality;
    if (personality === 'normal') return;
    if (queueToadEffect(character._toadEffects ||= [], personality)) {
      character._toadEffectCooldown = TOAD_EFFECT_LOCKOUT;
    }
  };
}

function updateMyceliumToadEffects(dt) {
  if (!G?.world?.myceliumToads?.length) {
    if (G) {
      G.hallucinating = false;
      G.hallucinationStrength = 0;
    }
    return;
  }
  let playerHallucinating = false;
  let playerHallucinationStrength = 0;
  for (const character of G.characters) {
    character._toadEffectCooldown = Math.max(0, (character._toadEffectCooldown || 0) - dt);
    const effects = character._toadEffects;
    if (!character.alive) {
      if (effects) effects.length = 0;
      continue;
    }
    if (!effects?.length) continue;
    const state = updateToadEffects(effects, dt, {
      onStart: type => {
        if (!character.isPlayer) return;
        if (type === 'poison') hud.message('TOAD POISON -5 / SECOND', '#79ff5b');
        else if (type === 'hallucinogenic') {
          hud.message('THE GROVE IS BREATHING', '#e18cff');
          sfx('powerup');
        }
      },
      onPoisonTick: damage => {
        if (G.multiplayer && !G.multiplayerHost) return;
        applyDamage(character, damage, POISON_TOAD, { environmental: true });
      },
    });
    if (character.isPlayer && state.hallucinating) {
      playerHallucinating = true;
      playerHallucinationStrength = Math.max(
        playerHallucinationStrength,
        state.hallucinationStrength,
      );
    }
  }
  G.hallucinating = playerHallucinating;
  G.hallucinationStrength = playerHallucinationStrength;
}

function updateDeathCamera(dt) {
  if (!G?.player || G.over) return;
  G.deathBaseFov ||= camera.fov;
  const timer = G.respawnTimers?.get(G.player);
  const dead = !G.player.alive && timer != null;
  if (dead) {
    if (!G.deathSpectate) {
      const yaw = G.player.yaw ?? 0;
      const back = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
      const anchor = G.player.pos.clone().add(new THREE.Vector3(0, 1.1, 0));
      G.deathSpectate = {
        anchor,
        pos: anchor.clone().addScaledVector(back, 10).add(new THREE.Vector3(0, 3.2, 0)),
      };
      camera.fov = 70;
      camera.updateProjectionMatrix();
      if (G.player.viewmodel) G.player.viewmodel.visible = false;
      if (G.player.dualBlasterViewmodel) G.player.dualBlasterViewmodel.visible = false;
      if (G.player.grappleViewmodel) G.player.grappleViewmodel.visible = false;
    }
    camera.position.copy(G.deathSpectate.pos);
    camera.lookAt(G.deathSpectate.anchor);
    return;
  }

  if (G.deathSpectate) {
    G.deathSpectate = null;
    if (G.player.viewmodel) G.player.viewmodel.visible = true;
    G.player.syncDualBlasterViewmodel?.();
    if (G.player.grappleViewmodel) G.player.grappleViewmodel.visible = !!G.player.grapple;
  }
  if (Math.abs(camera.fov - G.deathBaseFov) > 0.01) {
    camera.fov = G.deathBaseFov;
    camera.updateProjectionMatrix();
  }
}

// THE LOBBY: a walkable atrium — stroll into a glowing gate to start a match.
async function startAtrium(existingLoadingToken = null) {
  const loadingToken = existingLoadingToken ??
    (mapLoadingScreen?.hidden ? showMapLoading({ name: 'NERF ARENA BLAST' }) : mapLoadingToken);
  setStyle(clickcatch, 'display', 'none');
  // When returning from a match, give 0% a chance to reach the compositor
  // before teardown or the queued Auto-quality resize begins.
  await paintLoadingStage();
  if (loadingToken !== mapLoadingToken) return;
  setMapLoadingProgress(10, 'Applying the queued graphics profile', loadingToken);
  await paintLoadingStage();
  if (loadingToken !== mapLoadingToken) return;
  applyPendingGraphicsMode();
  teardown();
  resetAdaptiveRenderScale({ preserveDetection: true });
  musicStop();
  camera.fov = 75;
  camera.near = 0.1;
  camera.far = 900;
  camera.updateProjectionMatrix();
  const scene = new THREE.Scene();
  scene.environment = envTexture;
  const world = buildAtrium(scene);
  setMapLoadingProgress(60, 'Atrium geometry built', loadingToken);
  renderer.toneMappingExposure = world.toneMappingExposure ?? 1.02;
  buildCollisionIndex(world);
  syncAtriumModeSign(world);
  world.spawnsAll = [...world.spawns.ffa];
  buildWaypointGraph(world);
  scene.add(camera);
  renderPass.scene = scene;

  const fxPool = fxPoolForScene(scene);
  const player = new Player(camera, world);
  player.color = '#ffd23c';
  player.team = 'ffa-you';
  player.score = 0;
  const characters = [player];
  const projectiles = new ProjectileSystem(scene, world, {
    spawnPuff: (p, c, s) => fxPool.spawnPuff(p, c, s),
    characters: () => characters,
    onDamage: () => {},
    targets: () => shootableWorldTargets(),
    onTargetDamage: (target, dmg, attacker, ctx) => damageWorldTarget(target, dmg, attacker, ctx),
  });
  const pickups = new PickupManager(scene, [], { onPickup });
  setMapLoadingProgress(82, 'Atrium routes and player ready', loadingToken);
  world.onPad = (ch) => { if (ch.isPlayer) sfx('boing'); };
  world.onSecretFountainReveal = () => {
    sfx('powerup');
  };
  world.onSecretObservatoryArrival = () => {
    sfx('pickup');
    hud.message('SECRET ORBITAL HUB', '#c8f5ff');
  };
  world.onSecretAtriumReturn = () => {
    sfx('pickup');
    hud.message('RETURNED TO THE ATRIUM', '#c8f5ff');
  };
  world.onSecretTransit = (direction) => {
    sfx('powerup');
    playSecretTransit(direction, () => world.finishSecretTransit?.(direction));
  };
  world.getPickups = () => pickups.items;

  G = {
    atrium: true, mapDef: null, mode: selectedMode, scene, world, player, characters,
    projectiles, pickups, fxPool,
    scores: { blue: 0, red: 0 },
    timeLeft: MATCH_TIME,
    respawnTimers: new Map(),
    over: false,
    paused: startsPausedForPointerLock(),
    showBoard: false,
    padCooldown: 0,
    lastT: performance.now(),
  };
  syncRenderQuality();
  const perch = world.spawns.ffa[0].clone();
  perch.y += 2.6;                  // float above the floor; you drop in on the first click
  player.spawn(perch);
  player.yaw = 0; // face the courtyard
  player.update(0, () => {});      // set the camera NOW — paused frames render this view
  setMapLoadingProgress(88, 'Warming Atrium shaders', loadingToken);
  await paintLoadingStage();
  if (typeof renderer.compileAsync === 'function') await renderer.compileAsync(scene, camera);
  else renderer.compile(scene, camera);
  setMapLoadingProgress(90, 'Uploading Atrium textures', loadingToken);
  await prewarmSceneTexturesAsync(scene, loadingToken);
  setMapLoadingProgress(94, 'Preparing graphics buffers', loadingToken);
  await prewarmPostProcessingAsync(loadingToken);
  setMapLoadingProgress(98, 'Rendering the first Atrium frame', loadingToken);
  await paintLoadingStage();
  renderFrame();
  setMapLoadingProgress(99, 'Atrium ready', loadingToken);

  hud.show(true);
  hud.clearAwards();
  setStyle(document.getElementById('scores'), 'display', 'none');
  setText(document.getElementById('catchtitle'), 'CLICK TO PLAY');
  setStyle(clickcatch, 'display', gameplayOverlayDisplay());
  requestPointerLock();
  hud.message('WALK INTO A GATE TO ENTER AN ARENA', '#ffd23c');
  G.lastT = performance.now();
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);
  finishMapLoading(loadingToken);
}

async function refreshHallLeaderboard(world = G?.world) {
  try {
    const response = await fetch('/api/leaderboard', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Leaderboard request failed (${response.status})`);
    const data = await response.json();
    if (G?.hallOfFame && G.world === world) {
      world.setLeaderboard?.(Array.isArray(data.entries) ? data.entries : []);
    }
  } catch (err) {
    console.warn('Could not load Hall of Fame:', err);
    if (G?.hallOfFame && G.world === world) hud.message('HALL OF FAME IS TEMPORARILY VEILED', '#ff8c6d');
  }
}

function startHallOfFame() {
  hideMapLoading();
  applyPendingGraphicsMode();
  teardown();
  resetAdaptiveRenderScale({ preserveDetection: true });
  musicStop();
  camera.fov = 75;
  camera.near = 0.1;
  camera.far = 900;
  camera.updateProjectionMatrix();
  const scene = new THREE.Scene();
  scene.environment = envTexture;
  const world = buildHallOfFame(scene);
  renderer.toneMappingExposure = world.toneMappingExposure ?? 1.02;
  buildCollisionIndex(world);
  world.spawnsAll = [...world.spawns.ffa];
  buildWaypointGraph(world);
  scene.add(camera);
  renderPass.scene = scene;

  const fxPool = fxPoolForScene(scene);
  const player = new Player(camera, world);
  player.color = '#ffd75e';
  player.team = 'ffa-you';
  player.score = 0;
  const characters = [player];
  const projectiles = new ProjectileSystem(scene, world, {
    spawnPuff: (p, c, s) => fxPool.spawnPuff(p, c, s),
    characters: () => characters,
    onDamage: () => {},
  });
  const pickups = new PickupManager(scene, [], { onPickup });
  world.onPad = () => {};
  world.getPickups = () => pickups.items;

  G = {
    atrium: true,
    hallOfFame: true,
    mapDef: null,
    mode: selectedMode,
    scene,
    world,
    player,
    characters,
    projectiles,
    pickups,
    fxPool,
    scores: { blue: 0, red: 0 },
    timeLeft: MATCH_TIME,
    respawnTimers: new Map(),
    over: false,
    paused: startsPausedForPointerLock(),
    showBoard: false,
    lastT: performance.now(),
  };
  syncRenderQuality();
  const spawn = world.spawns.ffa[0].clone();
  spawn.y += 2.6;
  player.spawn(spawn);
  player.yaw = 0;
  player.update(0, () => {});
  renderer.compile(scene, camera);

  hud.show(true);
  hud.clearAwards();
  hud.msgTimer = 0;
  setStyle(hud.els.msg, 'opacity', '0');
  setStyle(document.getElementById('scores'), 'display', 'none');
  setText(document.getElementById('catchtitle'), 'CLICK TO ENTER THE HALL');
  setStyle(clickcatch, 'display', gameplayOverlayDisplay());
  requestPointerLock();
  refreshHallLeaderboard(world);
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);
}

function* createMatchStages(mapDef, mode = 'ffa', loadingToken = mapLoadingToken, freshMusic = true) {
  finishAtriumAutoGraphicsTest();
  inGameAutoTestStarted = false;
  applyPendingGraphicsMode();
  teardown();
  resetAdaptiveRenderScale({ preserveDetection: true });
  camera.fov = 75;
  camera.near = 0.1;
  camera.far = 900;
  camera.updateProjectionMatrix();
  const scene = new THREE.Scene();
  scene.environment = envTexture;
  const world = mapDef.build(scene);
  yield { progress: 48, status: 'Arena geometry built' };
  renderer.toneMappingExposure = world.toneMappingExposure ?? 1.02;
  buildCollisionIndex(world);
  bindWorldPresentation(world, false);
  world.spawnsAll = uniqueSpawnPoints([...world.spawns.blue, ...world.spawns.red, ...(world.spawns.ffa || [])]);
  buildWaypointGraph(world);
  scene.add(camera);
  renderPass.scene = scene;
  yield { progress: 62, status: 'Routes and collision ready' };

  const fxPool = fxPoolForScene(scene);
  const player = new Player(camera, world);
  player.color = '#ffd23c';

  const characters = [player];
  // Map-specific caps override the normal population, while maps such as
  // Olympus can still opt into a larger single-player crowd on their world.
  const playerCount = Math.max(2, Math.floor(mapPlayerLimit(mapDef, world.playerCount || 8)));
  if (mode === 'tdm') {
    const teamSize = Math.floor(playerCount / 2);
    const teams = { blue: Math.max(0, teamSize - 1), red: playerCount - teamSize };
    let ni = 0;
    for (const team of ['blue', 'red']) {
      for (let i = 0; i < teams[team]; i++) {
        const bot = new Bot(scene, world, team, BOT_NAMES[ni++ % BOT_NAMES.length],
          team === 'blue' ? 0x2e7fd8 : 0xd83a3a);
        bot.color = team === 'blue' ? '#5cb3ff' : '#ff5c5c';
        if (team === 'blue') { // teammate marker — they won't shoot you, don't shoot them
          const m = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.42, 6),
            new THREE.MeshBasicMaterial({ color: 0x5cb3ff }));
          m.position.y = 2.4;
          m.rotation.x = Math.PI;
          bot.mesh.add(m);
        }
        characters.push(bot);
      }
    }
  } else {
    player.team = 'ffa-you';
    for (let i = 0; i < playerCount - 1; i++) {
      const color = FFA_COLORS[i % FFA_COLORS.length];
      const bot = new Bot(scene, world, 'ffa-' + i, BOT_NAMES[i % BOT_NAMES.length],
        parseInt(color.slice(1), 16));
      bot.color = color;
      characters.push(bot);
    }
  }
  for (const ch of characters) {
    ch.score = 0;
    ch.awards = {};
    ch.killChain = null;
  }

  const projectiles = new ProjectileSystem(scene, world, {
    spawnPuff: (p, c, s) => fxPool.spawnPuff(p, c, s),
    characters: () => characters,
    onDamage: (target, dmg, attacker, ctx) => applyDamage(target, dmg, attacker, ctx),
    targets: () => shootableWorldTargets(),
    onTargetDamage: (target, dmg, attacker, ctx) => damageWorldTarget(target, dmg, attacker, ctx),
  });

  const pickups = new PickupManager(scene, world.pickups, { onPickup });

  world.onPad = (ch) => { if (ch.isPlayer) sfx('boing'); };
  world.onPortalTransit = (ch, source) => sfx('portal', ch.isPlayer ? null : source);
  bindMyceliumToadEffects(world);
  world.onLightningStrike = (pos) => sfx('thunder', pos);
  world.onLightningHit = (ch) => {
    if (!ch?.alive) return;
    ch.paralyzeT = Math.max(ch.paralyzeT || 0, 2);
    if (ch.vel) {
      ch.vel.x *= 0.08;
      ch.vel.z *= 0.08;
      if (ch.vel.y > 0) ch.vel.y *= 0.25;
    }
    applyDamage(ch, 50, LIGHTNING, { environmental: true });
    if (ch.isPlayer) hud.message('LIGHTNING STRIKE', '#dff7ff');
  };
  world.onGatorChomp = () => sfx('chomp', world.gator?.group?.position);
  world.onGatorBite = (ch) => {
    if (!ch?.alive) return;
    applyDamage(ch, 35, GATOR, { environmental: true, silentImpact: true });
    sfx('gatorhit', ch.isPlayer ? null : ch.pos);
    if (ch.isPlayer) hud.message('GATOR BITE -35', '#b8e35b');
  };
  world.onSharkBite = (ch, sharkPos) => {
    if (!ch?.alive) return;
    applyDamage(ch, 55, SHARK, { environmental: true, silentImpact: true });
    sfx('chomp', sharkPos || (ch.isPlayer ? null : ch.pos));
    sfx('gatorhit', ch.isPlayer ? null : ch.pos);
    if (ch.isPlayer) hud.message('SHARK BITE -55', '#8ed8e8');
  };
  world.onCactusHit = (ch) => {
    if (!ch?.alive) return;
    applyDamage(ch, 5, CACTUS, { environmental: true });
    if (ch.isPlayer) hud.message('CACTUS -5', '#8dcf72');
  };
  world.onSharkBeached = () => hud.message('SHARK ON DECK!', '#8ed8e8');
  world.onTideWarning = () => sfx('siren');
  world.onSurgeHit = (ch) => {
    sfx('wave', ch?.isPlayer ? null : ch?.pos);
    if (ch?.isPlayer) hud.message('WAVE IMPACT', '#9de9ff');
  };
  world.onSolarFlareWarning = () => {
    sfx('siren');
    hud.message('SOLAR FLARE INBOUND — GET INSIDE', '#ff5638');
  };
  world.onSolarFlareStrike = () => sfx('thunder');
  world.onSolarFlareHit = (ch) => {
    if (!ch?.alive) return;
    applyDamage(ch, 33, SOLAR_FLARE, { environmental: true });
    if (ch.isPlayer) hud.message('SOLAR FLARE -33', '#ff5638');
  };
  world.getPickups = () => pickups.items; // bots window-shop the pickups

  G = {
    atrium: false, mapDef, mode, scene, world, player, characters, projectiles, pickups, fxPool,
    scores: { blue: 0, red: 0 },
    timeLeft: world.matchTime || MATCH_TIME,
    respawnTimers: new Map(),
    over: false,
    paused: startsPausedForPointerLock(), // touch starts immediately; desktop waits for pointer lock
    showBoard: false,
    lastT: performance.now(),
  };
  // Resolve the end-stage location while the arena is still covered. Olympus
  // has a large collision set, so doing this search at 0:00 caused avoidable
  // main-thread work on the final gameplay frame.
  G.podiumAnchor = resolvePodiumAnchor(world);
  syncRenderQuality();
  updateGraphicsUI();
  yield { progress: 82, status: 'Combatants and pickups ready' };

  G.spawnBatchUsed = new Map();
  G.spawnBatchUsedFaces = new Map();
  for (const ch of characters) respawnCharacter(ch, true);
  G.spawnBatchUsed = null;
  G.spawnBatchUsedFaces = null;

  if (world.grappleEnabled) hud.message('FIND A TREETOP GRAPPLE — SHIFT / RIGHT CLICK ONCE EQUIPPED', '#a8ff70');
  else if (world.mounted) hud.message('HORSEBACK — HOLD SHIFT TO GALLOP (15 SEC STAMINA)', '#f2c274');

  player.update(0, () => {});      // camera on the spawn point before the first tick
  yield {
    progress: 88,
    status: 'Warming weapons, arena effects, and victory podium',
    syncWork: () => {
      prewarmMatchVisuals(scene, player, characters, projectiles, fxPool);
      prewarmEventVisuals();
      prewarmVictoryPodium();
    },
    asyncWork: async () => {
      if (mapDef.id === 'olympus') await warmOlympusImpactAudio();
      await prewarmMatchVisualsAsync(scene, player, characters, projectiles, fxPool);
      await prewarmEventVisualsAsync();
      await prewarmVictoryPodiumAsync();
    },
  };
  yield {
    progress: 90,
    status: 'Uploading arena textures',
    syncWork: () => initializeSceneTextures(collectSceneTextures(scene)),
    asyncWork: () => prewarmSceneTexturesAsync(scene, loadingToken),
  };
  yield {
    progress: 94,
    status: 'Preparing graphics buffers',
    syncWork: prewarmPostProcessing,
    asyncWork: () => prewarmPostProcessingAsync(loadingToken),
  };
  yield {
    progress: 98,
    status: 'Rendering the first arena frame',
    syncWork: renderFrame,
  };
  yield { progress: 99, status: 'Arena frame ready' };
  hud.show(true);
  hud.clearAwards();
  setStyle(document.getElementById('scores'), 'display', '');
  setStyle(clickcatch, 'display', gameplayOverlayDisplay());
  requestPointerLock();
  if (freshMusic) startMatchMusic();
  else musicPlay();
  // Loading/compilation time is not a gameplay frame and must not influence
  // Auto's frame sampler when the first requestAnimationFrame arrives.
  G.lastT = performance.now();
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);
  finishMapLoading(loadingToken);
}

function startMatch(mapDef, mode = 'ffa', freshMusic = true) {
  const token = mapLoadingScreen?.hidden ? showMapLoading(mapDef) : mapLoadingToken;
  setMapLoadingProgress(20, 'Shared assets ready', token);
  for (const stage of createMatchStages(mapDef, mode, token, freshMusic)) {
    setMapLoadingProgress(stage.progress, stage.status, token);
    stage.syncWork?.();
  }
}

async function startMatchProgressively(mapDef, mode = 'ffa', token = mapLoadingToken, freshMusic = true) {
  for (const stage of createMatchStages(mapDef, mode, token, freshMusic)) {
    if (!setMapLoadingProgress(stage.progress, stage.status, token)) return;
    await paintLoadingStage();
    if (stage.asyncWork) await stage.asyncWork();
    else stage.syncWork?.();
  }
}

function multiplayerSlotById(id = multiplayer.slotId) {
  return (multiplayer.slots || []).find(s => s.id === id) || null;
}

function multiplayerTeamForSlot(slot, mode = multiplayer.mode || 'ffa') {
  if (!slot) return mode === 'tdm' ? 'blue' : (multiplayer.slotId || 'you');
  return mode === 'tdm' ? (slot.team || 'blue') : slot.id;
}

function multiplayerColorForTeam(team, fallback = '#ffffff') {
  if (team === 'blue') return '#5cb3ff';
  if (team === 'red') return '#ff5c5c';
  return fallback;
}

function addTeamMarker(ch) {
  if (!ch?.mesh || ch._teamMarker || ch.team !== 'blue') return;
  const m = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.42, 6),
    new THREE.MeshBasicMaterial({ color: 0x5cb3ff }));
  m.position.y = 2.4;
  m.rotation.x = Math.PI;
  ch.mesh.add(m);
  ch._teamMarker = m;
}

function startMultiplayerMatch(mapDef, mode = multiplayer.mode || 'ffa', freshMusic = true) {
  const loadingToken = mapLoadingScreen?.hidden ? showMapLoading(mapDef) : mapLoadingToken;
  setMapLoadingProgress(20, 'Shared assets ready', loadingToken);
  finishAtriumAutoGraphicsTest();
  inGameAutoTestStarted = false;
  applyPendingGraphicsMode();
  teardown();
  resetAdaptiveRenderScale({ preserveDetection: true });
  camera.fov = 75;
  camera.near = 0.1;
  camera.far = 900;
  camera.updateProjectionMatrix();
  const scene = new THREE.Scene();
  scene.environment = envTexture;
  const world = mapDef.build(scene);
  if (Number.isFinite(multiplayer.phaseEndsAt)) {
    world.shuffleMyceliumToads?.(multiplayer.phaseEndsAt);
  }
  setMapLoadingProgress(48, 'Multiplayer arena geometry built', loadingToken);
  renderer.toneMappingExposure = world.toneMappingExposure ?? 1.02;
  buildCollisionIndex(world);
  bindWorldPresentation(world, true);
  world.spawnsAll = uniqueSpawnPoints([...world.spawns.blue, ...world.spawns.red, ...(world.spawns.ffa || [])]);
  buildWaypointGraph(world);
  scene.add(camera);
  renderPass.scene = scene;
  setMapLoadingProgress(62, 'Routes and collision ready', loadingToken);

  const fxPool = fxPoolForScene(scene);
  const player = new Player(camera, world);
  const playerSlot = multiplayerSlotById();
  const playerTeam = multiplayerTeamForSlot(playerSlot, mode);
  player.id = multiplayer.slotId;
  player.color = multiplayerColorForTeam(playerTeam, playerSlot?.color || '#ffd23c');
  player.team = playerTeam;
  player.name = multiplayer.name || 'YOU';
  player.score = 0;
  player.awards = {};
  player.killChain = null;

  const characters = [player];
  const projectiles = new ProjectileSystem(scene, world, {
    spawnPuff: (p, c, s) => fxPool.spawnPuff(p, c, s),
    characters: () => characters,
    // Guest projectiles are presentation/prediction only. Damage feedback is
    // shown after the host confirms the hit in an authoritative snapshot.
    onDamage: () => {},
    targets: () => shootableWorldTargets(),
    onTargetDamage: (target, dmg, attacker, ctx) => {
      // The gator has no health authority to reconcile; react immediately on
      // the shooter's client. Destructible world targets remain host-owned.
      if (target?.kind === 'canal-gator' || G?.multiplayerHost) {
        damageWorldTarget(target, dmg, attacker, ctx);
      }
    },
  });
  const pickups = new PickupManager(scene, world.pickups, { onPickup });
  world.onPad = (ch) => { if (ch.isPlayer) sfx('boing'); };
  world.onPortalTransit = (ch, source) => sfx('portal', ch.isPlayer ? null : source);
  bindMyceliumToadEffects(world);
  world.onGatorChomp = () => sfx('chomp', world.gator?.group?.position);
  world.onGatorBite = (ch) => {
    // The host owns environmental damage and distributes the resulting health
    // snapshot/events, preventing every client from applying the same bite.
    if (!ch?.alive) return;
    if (!G?.multiplayerHost) return;
    applyDamage(ch, 35, GATOR, { environmental: true, silentImpact: true });
    sfx('gatorhit', ch.isPlayer ? null : ch.pos);
    if (ch.isPlayer) hud.message('GATOR BITE -35', '#b8e35b');
  };
  world.onSharkBite = (ch, sharkPos) => {
    // As with the canal gator, only the host applies authoritative wildlife
    // damage. Every client still animates the same local predator pursuit.
    if (!ch?.alive || !G?.multiplayerHost) return;
    applyDamage(ch, 55, SHARK, { environmental: true, silentImpact: true });
    sfx('chomp', sharkPos || (ch.isPlayer ? null : ch.pos));
    sfx('gatorhit', ch.isPlayer ? null : ch.pos);
    if (ch.isPlayer) hud.message('SHARK BITE -55', '#8ed8e8');
  };
  world.onSharkBeached = () => hud.message('SHARK ON DECK!', '#8ed8e8');
  world.onTideWarning = () => sfx('siren');
  world.onSurgeHit = (ch) => {
    sfx('wave', ch?.isPlayer ? null : ch?.pos);
    if (ch?.isPlayer) hud.message('WAVE IMPACT', '#9de9ff');
  };
  world.onLightningStrike = (pos) => sfx('thunder', pos);
  world.onLightningHit = (ch) => {
    // Host owns environmental lightning damage; every client still renders the bolt.
    if (!ch?.alive || !G?.multiplayerHost) return;
    ch.paralyzeT = Math.max(ch.paralyzeT || 0, 2);
    if (ch.vel) {
      ch.vel.x *= 0.08;
      ch.vel.z *= 0.08;
      if (ch.vel.y > 0) ch.vel.y *= 0.25;
    }
    applyDamage(ch, 50, LIGHTNING, { environmental: true });
    if (ch.isPlayer) hud.message('LIGHTNING STRIKE', '#dff7ff');
  };
  world.onSolarFlareWarning = () => {
    sfx('siren');
    hud.message('SOLAR FLARE INBOUND — GET INSIDE', '#ff5638');
  };
  world.onSolarFlareStrike = () => sfx('thunder');
  world.onSolarFlareHit = (ch) => {
    if (!ch?.alive || !G?.multiplayerHost) return;
    applyDamage(ch, 33, SOLAR_FLARE, { environmental: true });
    if (ch.isPlayer) hud.message('SOLAR FLARE -33', '#ff5638');
  };
  world.getPickups = () => pickups.items;

  G = {
    multiplayer: true, atrium: false, mapDef, mode, scene, world, player, characters,
    projectiles, pickups, fxPool,
    remoteSlots: new Map(),
    mpDropIds: new Set(),
    mpTracerPool: createMultiplayerTracerPool(scene, projectiles.geoBall),
    scores: { blue: 0, red: 0 },
    timeLeft: Math.max(0, (multiplayer.phaseEndsAt - Date.now()) / 1000),
    respawnTimers: new Map(),
    over: false,
    paused: false,
    showBoard: false,
    lastT: performance.now(),
    mpSendT: 0,
    mpSyncedSelf: false,
    mpSawSelfSnapshot: false,
    mpWorldTimeSynced: false,
    mpLastSnapshotAt: performance.now(),
    mpSnapshotStalled: false,
    mpConnectionPaused: false,
  };
  G.podiumAnchor = resolvePodiumAnchor(world);
  syncRenderQuality();
  updateGraphicsUI();
  setMapLoadingProgress(82, 'Network combatants and pickups ready', loadingToken);

  respawnCharacter(player, true);
  if (world.grappleEnabled) hud.message('FIND A TREETOP GRAPPLE — SHIFT / RIGHT CLICK ONCE EQUIPPED', '#a8ff70');
  player.update(0, () => {});
  setMapLoadingProgress(88, 'Spawn point and camera ready', loadingToken);
  prewarmMatchVisuals(scene, player, characters, projectiles, fxPool);
  prewarmEventVisuals();
  prewarmVictoryPodium();
  setMapLoadingProgress(90, 'Uploading arena textures', loadingToken);
  initializeSceneTextures(collectSceneTextures(scene));
  setMapLoadingProgress(94, 'Preparing graphics buffers', loadingToken);
  prewarmPostProcessing();
  setMapLoadingProgress(98, 'Rendering the first arena frame', loadingToken);
  renderFrame();
  setMapLoadingProgress(99, 'Arena frame ready', loadingToken);
  hud.show(true);
  setStyle(document.getElementById('scores'), 'display', '');
  setStyle(document.getElementById('endscreen'), 'display', 'none');
  setText(document.getElementById('catchtitle'), 'CLICK TO RESUME');
  setStyle(clickcatch, 'display', gameplayOverlayDisplay());
  requestPointerLock();
  if (freshMusic) startMatchMusic();
  else musicPlay();
  G.lastT = performance.now();
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);
  finishMapLoading(loadingToken);
}

function startMultiplayerHostMatch(
  mapDef,
  mode = multiplayer.mode || 'ffa',
  resumeSnapshot = null,
  freshMusic = true,
) {
  startMatch(mapDef, mode, freshMusic);
  if (!G) return;
  if (Number.isFinite(multiplayer.phaseEndsAt)) {
    G.world.shuffleMyceliumToads?.(multiplayer.phaseEndsAt);
  }
  bindWorldPresentation(G.world, true);
  const playerSlot = multiplayerSlotById();
  const playerTeam = multiplayerTeamForSlot(playerSlot, mode);
  G.multiplayerHost = true;
  G.mpSnapshotT = 0;
  G.mpEvents = [];
  G.remoteInputs = new Map();
  G.remoteHumans = new Map();
  G.mpConnectionPaused = false;
  G.paused = false;
  setText(document.getElementById('catchtitle'), 'CLICK TO RESUME');
  setStyle(clickcatch, 'display', gameplayOverlayDisplay());
  G.player.id = multiplayer.slotId;
  G.player.name = multiplayer.name || 'YOU';
  G.player.color = multiplayerColorForTeam(playerTeam, playerSlot?.color || '#ffd23c');
  G.player.team = playerTeam;
  addTeamMarker(G.player);
  let botIdx = 0;
  for (const ch of G.characters) {
    if (ch === G.player) continue;
    ch.id = `bot-${botIdx}`;
    botIdx++;
  }
  syncRemoteHumans();
  if (resumeSnapshot) applyHostHandoffSnapshot(resumeSnapshot);
  syncMultiplayerNameTags();
}

function syncMultiplayerWorldTime(snap, snapshotAge = 0, hostHandoff = false) {
  if (!G?.world || !Number.isFinite(snap?.worldTime)) return;
  const target = Math.max(0, snap.worldTime + Math.max(0, snapshotAge));
  if (hostHandoff) {
    G.world._t = target;
    delete G.world.networkTimeTarget;
    return;
  }
  if (!G.mpWorldTimeSynced) {
    // The guest may have rendered while the host was still constructing. The
    // first authoritative sample is allowed to correct that startup lead.
    G.world._t = target;
    G.mpWorldTimeSynced = true;
  }
  G.world.networkTimeTarget = target;
}

function applyHostHandoffSnapshot(snap) {
  if (!G?.multiplayerHost || !snap) return;
  G.scores = {
    blue: snap.scores?.blue || 0,
    red: snap.scores?.red || 0,
  };
  const phaseEndsAt = Number.isFinite(snap.phaseEndsAt)
    ? snap.phaseEndsAt
    : multiplayer.phaseEndsAt;
  G.timeLeft = Math.max(0, ((phaseEndsAt || Date.now()) - Date.now()) / 1000);
  syncMultiplayerWorldTime(snap, multiplayer.estimateSnapshotAge(snap), true);
  G.mpDropIds ||= new Set();
  applyScoreTargetCooldowns(snap.targetCooldowns);
  G.pickups?.applyAuthoritativeState?.(snap.pickups || []);

  const byId = new Map(G.characters.map(ch => [characterNetworkId(ch), ch]));
  for (const state of snap.players || []) {
    const ch = byId.get(state.id);
    if (!ch || !state.pos) continue;
    ch.name = state.name || ch.name;
    ch.color = state.color || ch.color;
    ch.team = state.team || ch.team;
    ch.pos.set(state.pos.x, state.pos.y, state.pos.z);
    ch.vel?.set(state.vel?.x || 0, state.vel?.y || 0, state.vel?.z || 0);
    ch.yaw = state.yaw || 0;
    ch.pitch = state.pitch || 0;
    if (state.up && ch.up) ch.up.set(state.up.x || 0, state.up.y || 1, state.up.z || 0).normalize();
    ch.hp = state.hp;
    ch.alive = state.alive !== false;
    ch.score = state.score || 0;
    ch.kills = state.kills || 0;
    ch.deaths = state.deaths || 0;
    ch.awards = state.awards || {};
    ch.weapons = Object.fromEntries((state.weapons || ['blaster']).map(id => [id, true]));
    ch.weapons.blaster = true;
    ch.ammo = { blaster: Infinity, ...(state.ammo || {}) };
    ch.weapon = ch.weapons[state.weapon] &&
      (state.weapon === 'blaster' || ch.ammo[state.weapon] > 0)
      ? state.weapon
      : 'blaster';
    ch.dualBlaster = state.dualBlaster === true;
    ch._dualBlasterNextLeft = false;
    applyMultiplayerCombatState(ch, state);
    ch.grapple = state.grapple === true;
    if (ch.grappleViewmodel) ch.grappleViewmodel.visible = ch.grapple && ch.alive;
    if (!ch.grapple) ch.detachGrapple?.();
    if (ch.isPlayer) {
      ch.grappleAttached = !!state.grappleAnchor;
      ch.grappleAnchor = state.grappleAnchor
        ? new THREE.Vector3(state.grappleAnchor.x, state.grappleAnchor.y, state.grappleAnchor.z)
        : null;
      ch.grappleRopeLength = ch.grappleAnchor ? ch.grappleAnchor.distanceTo(ch.pos) : 0;
    } else {
      setRemoteGrappleState(ch, state.grappleAnchor);
    }
    ch.jetpack = state.jetpack ? createJetpack() : null;
    if (ch.jetpack) ch.jetpack.active = !!state.jetpackActive;
    ch.mesh && (ch.mesh.visible = ch.alive);
    ch.syncGunModel?.();
    if (ch.isPlayer) ch.showWeaponModel?.(ch.weapon);
    if (state.respawn > 0 && !ch.alive) G.respawnTimers.set(ch, state.respawn);
    else G.respawnTimers.delete(ch);
    if (ch.remoteHuman) ch.remoteNet = makeRemoteNet(ch.pos);
  }
  reconcileMultiplayerDrops(snap.drops || []);
  G.player.update(0, () => {});
  G.lastT = performance.now();
  G.lastStepWall = G.lastT;
}

function syncRemoteHumans() {
  if (!G?.multiplayerHost) return;
  const remoteSlots = (multiplayer.slots || []).filter(s => s.human && s.id !== multiplayer.slotId);
  const wanted = new Set(remoteSlots.map(s => s.id));
  for (const slot of remoteSlots) ensureHostRemoteHuman(slot);
  for (const [slotId, ch] of G.remoteHumans || []) {
    if (wanted.has(slotId)) continue;
    removeCharacter(ch);
    G.remoteHumans.delete(slotId);
    addReplacementBot();
  }
}

function ensureHostRemoteHuman(slot) {
  if (G.remoteHumans.has(slot.id)) return G.remoteHumans.get(slot.id);
  const team = multiplayerTeamForSlot(slot, G.mode);
  const color = multiplayerColorForTeam(team, slot.color || '#ffffff');
  const bot = G.characters.find(ch => !ch.isPlayer && !ch.remoteHuman && (G.mode !== 'tdm' || ch.team === team)) ||
    G.characters.find(ch => !ch.isPlayer && !ch.remoteHuman);
  if (bot) removeCharacter(bot);
  const remote = new Bot(G.scene, G.world, team, slot.name || 'Player',
    parseInt(String(color).replace('#', ''), 16) || 0xffffff);
  remote.id = slot.id;
  remote.remoteHuman = true;
  remote.human = true;
  remote.team = team;
  remote.name = slot.name || 'Player';
  remote.color = color;
  remote.score = slot.score || 0;
  remote.kills = slot.kills || 0;
  remote.deaths = slot.deaths || 0;
  remote.awards = {};
  remote.killChain = null;
  G.characters.push(remote);
  addTeamMarker(remote);
  respawnCharacter(remote, true);
  remote.remoteNet = makeRemoteNet(remote.pos);
  setNameTag(remote, remote.name, remote.color);
  G.remoteHumans.set(slot.id, remote);
  return remote;
}

function removeCharacter(ch) {
  ch.cancelWeaponWarmup?.();
  ch.warmupAudioStop?.();
  disposeGrappleVisual(ch.grappleVisual);
  ch.grappleVisual = null;
  const idx = G.characters.indexOf(ch);
  if (idx >= 0) G.characters.splice(idx, 1);
  disposeNameTag(ch);
  if (ch.mesh) G.scene.remove(ch.mesh);
  G.respawnTimers.delete(ch);
}

function addReplacementBot() {
  if (!G?.multiplayerHost) return;
  const playerLimit = Math.max(2, Math.floor(mapPlayerLimit(G.mapDef, G.world.playerCount || 8)));
  if (G.characters.length >= playerLimit) return;
  const usedIds = new Set(G.characters.map(ch => ch.id).filter(Boolean));
  let i = 0;
  while (usedIds.has(`bot-${i}`)) i++;
  let team = `ffa-bot-${i}`;
  let color = FFA_COLORS[i % FFA_COLORS.length];
  if (G.mode === 'tdm') {
    const blue = G.characters.filter(ch => ch.team === 'blue').length;
    const red = G.characters.filter(ch => ch.team === 'red').length;
    team = blue <= red ? 'blue' : 'red';
    color = multiplayerColorForTeam(team);
  }
  const bot = new Bot(G.scene, G.world, team, BOT_NAMES[i % BOT_NAMES.length],
    parseInt(color.slice(1), 16));
  bot.id = `bot-${i}`;
  bot.color = color;
  bot.score = 0;
  bot.awards = {};
  bot.killChain = null;
  G.characters.push(bot);
  addTeamMarker(bot);
  respawnCharacter(bot, true);
  setNameTag(bot, bot.name, bot.color);
}

function makeRemoteNet(pos) {
  return {
    targetPos: pos.clone(),
    predictedPos: pos.clone(),
    velocity: new THREE.Vector3(),
    lastInputPos: pos.clone(),
    lastInputAt: performance.now(),
    sampleAge: REMOTE_HUMAN_PREDICT_LEAD,
    lastSeq: null,
  };
}

function smoothNetworkAngle(current, target, a) {
  let d = target - current;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return current + d * a;
}

function updateRemoteHumanMotion(ch, input, dt) {
  if (!input?.pos) return;
  const now = performance.now();
  const net = ch.remoteNet ||= makeRemoteNet(ch.pos);
  const receivedAt = input.receivedAt || now;
  const freshPacket = input.seq !== net.lastSeq;
  if (freshPacket) {
    const rawPos = new THREE.Vector3(input.pos.x, input.pos.y, input.pos.z);
    if (input.vel) {
      net.velocity.set(input.vel.x || 0, input.vel.y || 0, input.vel.z || 0);
    } else {
      const sampleDt = Math.max(0.001, (receivedAt - net.lastInputAt) / 1000);
      net.velocity.copy(rawPos).sub(net.lastInputPos).multiplyScalar(1 / sampleDt);
    }
    if (net.velocity.lengthSq() > 120 * 120) net.velocity.setLength(120);
    net.targetPos.copy(rawPos);
    net.lastInputPos.copy(rawPos);
    net.lastInputAt = receivedAt;
    net.sampleAge = multiplayer.estimateServerSampleAge(
      input.sampledAt,
      REMOTE_HUMAN_MAX_PREDICT,
      REMOTE_HUMAN_PREDICT_LEAD,
    );
    net.lastSeq = input.seq;
    if (ch.pos.distanceToSquared(rawPos) > REMOTE_HUMAN_SNAP_DIST * REMOTE_HUMAN_SNAP_DIST) {
      ch.pos.copy(rawPos);
    }
  }

  const lead = Math.min(REMOTE_HUMAN_MAX_PREDICT,
    Math.max(0, (now - net.lastInputAt) / 1000) + net.sampleAge);
  net.predictedPos.copy(net.targetPos).addScaledVector(net.velocity, lead);
  if (ch.pos.distanceToSquared(net.predictedPos) > REMOTE_HUMAN_SNAP_DIST * REMOTE_HUMAN_SNAP_DIST) {
    ch.pos.copy(net.targetPos);
  } else {
    ch.pos.lerp(net.predictedPos, 1 - Math.exp(-REMOTE_HUMAN_SMOOTH * dt));
  }
  ch.vel.copy(net.velocity);
}

function updateRemoteHuman(ch, dt, fire) {
  const input = G.remoteInputs?.get(ch.id);
  if (!input || !ch.alive) return;
  if (input.alive === false) return;
  updateRemoteHumanMotion(ch, input, dt);
  const turnA = 1 - Math.exp(-24 * dt);
  ch.yaw = smoothNetworkAngle(ch.yaw || 0, input.yaw || 0, turnA);
  ch.pitch += ((input.pitch || 0) - (ch.pitch || 0)) * turnA;
  if (input.up) {
    ch.up ||= new THREE.Vector3(0, 1, 0);
    ch.up.set(input.up.x || 0, input.up.y || 1, input.up.z || 0).normalize();
  }
  setRemoteGrappleState(ch, input.grappleAnchor);
  if (ch.jetpack) ch.jetpack.active = !!input.jetpackActive;
  if (input.weapon && (input.weapon === 'blaster' || (ch.weapons[input.weapon] && ch.ammo[input.weapon] > 0))) {
    if (input.weapon !== ch.weapon) ch.cancelWeaponWarmup();
    ch.weapon = input.weapon;
  }
  ch.cooldown = Math.max(0, ch.cooldown - dt);
  const w = WEAPONS[ch.weapon] || WEAPONS.blaster;
  if (ch.weaponTriggerReady(dt, input.firing)) {
    const cp = Math.cos(ch.pitch || 0);
    const dir = input.aim
      ? new THREE.Vector3(input.aim.x || 0, input.aim.y || 0, input.aim.z || -1).normalize()
      : new THREE.Vector3(
        -Math.sin(ch.yaw || 0) * cp,
        Math.sin(ch.pitch || 0),
        -Math.cos(ch.yaw || 0) * cp,
      ).normalize();
    const up = ch.up || new THREE.Vector3(0, 1, 0);
    const visualScale = G.world.characterVisualScale?.(ch) || 1;
    const origin = ch.pos.clone()
      .addScaledVector(up, (G.world.mounted ? 2.5 + HORSE_HEIGHT_DELTA : 1.55) * visualScale)
      .addScaledVector(dir, 0.8 * visualScale);
    const side = ch.shotHandSide?.() || 1;
    const right = new THREE.Vector3().crossVectors(dir, up).normalize();
    origin.addScaledVector(right, side * 0.22 * visualScale);
    fire(ch, origin, dir, ch.weapon || 'blaster');
    ch.finishWeaponShot(w, 0);
    if (ch.weapon !== 'blaster' && ch.ammo[ch.weapon] <= 0) {
      ch.weapon = nextLoadedWeaponAfter(ch.weapon, ch.weapons, ch.ammo);
      ch.cancelWeaponWarmup();
    }
  }
  if (ch.mesh) {
    ch.syncGunModel?.();
    ch.syncWeaponWarmupVisual?.();
    syncJetpackVisual(ch, dt);
    ch.mesh.position.copy(ch.pos);
    ch.mesh.rotation.y = ch.yaw || 0;
    if (ch.horseVisual) {
      const horizontalSpeed = Math.hypot(ch.vel.x, ch.vel.z);
      if (horizontalSpeed > 0.08) ch.horseHeading = Math.atan2(ch.vel.x, ch.vel.z);
      ch.horseVisual.rotation.y = (ch.horseHeading || 0) - (ch.yaw || 0);
      const gait = performance.now() * 0.012;
      const pace = Math.min(1, horizontalSpeed / Math.max(1, G.world.playerSpeed));
      for (const leg of ch.horseLegs || []) leg.rotation.x = Math.sin(gait + leg.userData.gaitPhase) * 0.48 * pace;
      ch.horseVisual.position.y = Math.abs(Math.sin(gait * 2)) * 0.035 * pace;
    }
  }
  if (ch.powerup) {
    ch.powerup.timeLeft -= dt;
    if (ch.powerup.timeLeft <= 0) { ch.powerup = null; ch.damageMult = 1; }
  }
}

function makeNameTagSprite(text, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = 'rgba(8,10,24,.72)';
  g.beginPath();
  g.roundRect(18, 24, canvas.width - 36, 72, 24);
  g.fill();
  g.lineWidth = 4;
  g.strokeStyle = color;
  g.stroke();
  g.font = 'bold 42px "Arial Black", Arial';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 8;
  g.strokeStyle = 'rgba(0,0,0,.9)';
  g.strokeText(text, canvas.width / 2, 61);
  g.fillStyle = '#ffffff';
  g.fillText(text, canvas.width / 2, 61);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  }));
  sprite.scale.set(2.6, 0.65, 1);
  return sprite;
}

function disposeNameTag(ch) {
  if (!ch?.nameTag) return;
  ch.nameTag.parent?.remove(ch.nameTag);
  ch.nameTag.material.map?.dispose();
  ch.nameTag.material.dispose();
  ch.nameTag = null;
  ch._nameTagText = null;
  ch._nameTagColor = null;
}

function setNameTag(ch, text, color) {
  if (!ch?.mesh || ch.isPlayer) return;
  const label = String(text || ch.name || 'Player').trim().slice(0, 18) || 'Player';
  const tagColor = /^#[0-9a-f]{6}$/i.test(String(color || '')) ? String(color) : '#ffffff';
  if (ch.nameTag && ch._nameTagText === label && ch._nameTagColor === tagColor) return;
  disposeNameTag(ch);
  const sprite = makeNameTagSprite(label, tagColor);
  sprite.position.set(0, (ch.height || 1.8) + 0.65, 0);
  ch.mesh.add(sprite);
  ch.nameTag = sprite;
  ch._nameTagText = label;
  ch._nameTagColor = tagColor;
}

function syncMultiplayerNameTags() {
  if (!G?.characters) return;
  for (const ch of G.characters) {
    if (ch.isPlayer) continue;
    setNameTag(ch, ch.name, ch.color);
  }
}

function setRemoteGrappleState(ch, anchor) {
  if (!ch || ch.isPlayer || !G?.world?.grappleEnabled || !ch.grapple || !anchor) {
    if (ch && !ch.isPlayer) {
      ch.grappleAttached = false;
      ch.grappleAnchor = null;
      updateGrappleVisual(ch.grappleVisual, null, null, false);
    }
    return;
  }
  ch.grappleAttached = true;
  ch.grappleAnchor ||= new THREE.Vector3();
  ch.grappleAnchor.set(anchor.x || 0, anchor.y || 0, anchor.z || 0);
  ch.grappleVisual ||= createGrappleVisual(G.scene, 0xa8ff70);
  syncRemoteGrappleVisual(ch);
}

function syncRemoteGrappleVisual(ch) {
  if (!ch?.grappleVisual) return;
  const start = ch.pos.clone().addScaledVector(ch.up || new THREE.Vector3(0, 1, 0), 1.28);
  updateGrappleVisual(
    ch.grappleVisual,
    start,
    ch.grappleAnchor,
    ch.grappleAttached && ch.alive,
  );
}

function syncRemoteSlotGun(remote) {
  const gunId = `${remote?.weapon || 'blaster'}:${remote?.weapon === 'blaster' && remote?.dualBlaster ? 'dual' : 'single'}`;
  if (!remote?.mesh || remote._gunId === gunId) return;
  remote._gunId = gunId;
  if (remote._gun) remote.mesh.remove(remote._gun);
  if (remote._dualGun) remote.mesh.remove(remote._dualGun);
  remote._dualGun = null;
  remote._gun = buildBlaster(remote.weapon || 'blaster');
  remote._gun.scale.setScalar(0.55);
  remote._gun.position.set(0.32, G.world.mounted ? 2 + HORSE_HEIGHT_DELTA : 1.05, 0.25);
  remote._gun.rotation.y = Math.PI;
  remote.mesh.add(remote._gun);
  if (remote.weapon === 'blaster' && remote.dualBlaster) {
    remote._dualGun = buildBlaster('blaster');
    remote._dualGun.scale.setScalar(0.55);
    remote._dualGun.position.set(-0.32, G.world.mounted ? 2 + HORSE_HEIGHT_DELTA : 1.05, 0.25);
    remote._dualGun.rotation.y = Math.PI;
    remote.mesh.add(remote._dualGun);
  }
}

function ensureRemoteSlot(state) {
  let remote = G.remoteSlots.get(state.id);
  if (remote) return remote;
  const { group, jetpack, horse, horseLegs } = buildBotMesh(
    parseInt(String(state.color || '#ffffff').replace('#', ''), 16),
    G.world.mounted,
  );
  group.visible = false;
  G.scene.add(group);
  remote = {
    id: state.id,
    name: state.name,
    color: state.color,
    isPlayer: false,
    human: state.human,
    pos: new THREE.Vector3(),
    targetPos: new THREE.Vector3(),
    snapshotPos: new THREE.Vector3(),
    snapshotVel: new THREE.Vector3(),
    snapshotReceivedAt: 0,
    snapshotAge: 0,
    hasSnapshot: false,
    up: new THREE.Vector3(0, 1, 0),
    mesh: group,
    jetpackVisual: jetpack,
    horseVisual: horse,
    horseLegs,
    team: state.team || state.id,
    radius: G.world.mounted ? 0.58 : 0.45,
    height: G.world.mounted ? 2.65 + HORSE_HEIGHT_DELTA : 1.8,
    hp: 100,
    shield: 0,
    alive: true,
    score: 0,
    kills: 0,
    deaths: 0,
    awards: {},
    killChain: null,
    damageMult: 1,
    powerup: null,
    grapple: false,
    dualBlaster: false,
    weapons: { blaster: true },
    ammo: { blaster: Infinity },
    weapon: 'blaster',
    warmupProgress: -1,
    warmupAudioStop: null,
    _gun: null,
    _gunId: null,
    yaw: 0,
    targetYaw: 0,
  };
  syncRemoteSlotGun(remote);
  setNameTag(remote, remote.name, remote.color);
  G.remoteSlots.set(state.id, remote);
  G.characters.push(remote);
  return remote;
}

function applyMultiplayerSnapshot(snap) {
  if (!G?.multiplayer) return;
  G.mode = snap.mode || G.mode || 'ffa';
  if (snap.scores) G.scores = { blue: snap.scores.blue || 0, red: snap.scores.red || 0 };
  applyScoreTargetCooldowns(snap.targetCooldowns);
  G.timeLeft = Math.max(0, (snap.phaseEndsAt - Date.now()) / 1000);
  const snapshotReceivedAt = performance.now();
  const snapshotAge = multiplayer.estimateSnapshotAge(snap);
  syncMultiplayerWorldTime(snap, snapshotAge);
  const seen = new Set();
  for (const state of snap.players || []) {
    seen.add(state.id);
    if (state.id === multiplayer.slotId) {
      const statePos = new THREE.Vector3(state.pos.x, state.pos.y, state.pos.z);
      if (state.alive && !G.mpSyncedSelf) {
        G.player.spawn(statePos);
        G.mpSyncedSelf = true;
      }
      G.player.name = state.name;
      G.player.color = state.color || G.player.color;
      G.player.team = state.team || G.player.team;
      const previousScore = G.player.score || 0;
      G.player.score = state.score || 0;
      if (G.mpSawSelfSnapshot && G.player.score > previousScore) {
        const gained = G.player.score - previousScore;
        sfx('coin');
        hud.message(`+${gained} PTS!`, '#ffd23c');
      }
      G.mpSawSelfSnapshot = true;
      G.player.kills = state.kills || 0;
      G.player.deaths = state.deaths || 0;
      G.player.awards = state.awards || G.player.awards || {};
      applyMultiplayerLoadout(state);
      const hadDualBlaster = G.player.dualBlaster;
      G.player.dualBlaster = state.dualBlaster === true;
      G.player.syncDualBlasterViewmodel?.();
      if (!hadDualBlaster && G.player.dualBlaster && G.mpSawSelfSnapshot) {
        G.player.setSkin?.(G.player.powerup?.kind || null);
        sfx('powerup');
        hud.message('DUAL SECRET SHOTS — ALTERNATING FIRE', '#ffb35a');
      }
      applyMultiplayerCombatState(G.player, state);
      if (state.hp < G.player.hp) hud.damageFlash();
      G.player.hp = state.hp;
      if (!state.alive && G.player.alive) {
        G.player.alive = false;
        G.player.jetpack = null;
        G.player.grapple = false;
        if (G.player.grappleViewmodel) G.player.grappleViewmodel.visible = false;
        G.mpSyncedSelf = false;
        hud.showRespawn(true, state.respawn || RESPAWN_TIME);
        sfx('death');
      } else if (state.alive && !G.player.alive) {
        G.player.spawn(statePos);
        G.mpSyncedSelf = true;
      }
      const hadGrapple = G.player.grapple;
      G.player.grapple = state.grapple === true;
      if (G.player.grappleViewmodel) {
        G.player.grappleViewmodel.visible = G.player.grapple && state.alive !== false;
      }
      if (!G.player.grapple) G.player.detachGrapple();
      if (!hadGrapple && G.player.grapple && G.mpSawSelfSnapshot) {
        sfx('powerup');
        hud.message('GRAPPLE EQUIPPED — SHIFT / RIGHT CLICK', '#a8ff70');
      }
      if (state.alive) hud.showRespawn(false);
      if (!state.alive) hud.showRespawn(true, state.respawn || 0);
      continue;
    }
    const remote = ensureRemoteSlot(state);
    remote.name = state.name;
    remote.color = state.color;
    remote.team = state.team || remote.team;
    remote.human = state.human;
    remote.hp = state.hp;
    const wasAlive = remote.alive;
    remote.alive = state.alive;
    remote.score = state.score || 0;
    remote.kills = state.kills || 0;
    remote.deaths = state.deaths || 0;
    remote.awards = state.awards || remote.awards || {};
    applyMultiplayerCombatState(remote, state);
    const nextWeapon = state.weapon || 'blaster';
    if (nextWeapon !== remote.weapon) {
      remote.warmupAudioStop?.();
      remote.warmupAudioStop = null;
    }
    remote.weapon = nextWeapon;
    remote.dualBlaster = state.dualBlaster === true;
    remote.jetpack = state.jetpack ? { active: !!state.jetpackActive } : null;
    remote.grapple = state.grapple === true;
    syncRemoteSlotGun(remote);
    remote.targetYaw = state.yaw || 0;
    if (state.up) remote.up.set(state.up.x || 0, state.up.y || 1, state.up.z || 0).normalize();
    setRemoteGrappleState(remote, state.grappleAnchor);
    setNameTag(remote, remote.name, remote.color);
    remote.snapshotPos.set(state.pos.x, state.pos.y, state.pos.z);
    remote.snapshotVel.set(
      state.alive ? (state.vel?.x || 0) : 0,
      state.alive ? (state.vel?.y || 0) : 0,
      state.alive ? (state.vel?.z || 0) : 0,
    );
    remote.snapshotReceivedAt = snapshotReceivedAt;
    remote.snapshotAge = snapshotAge;
    remote.targetPos.copy(remote.snapshotPos).addScaledVector(
      remote.snapshotVel,
      boundedSnapshotLead(snapshotAge, 0, remote.alive),
    );
    if (!remote.hasSnapshot || remote.alive !== wasAlive) {
      remote.pos.copy(remote.targetPos);
      remote.yaw = remote.targetYaw;
      remote.hasSnapshot = true;
    }
    remote.warmupProgress = Number.isFinite(state.warmup) ? state.warmup : -1;
    if (remote.alive && remote.warmupProgress >= 0) {
      if (!remote.warmupAudioStop) {
        const remaining = WEAPONS.whomper.warmup * (1 - remote.warmupProgress);
        remote.warmupAudioStop = startWhomperWarmup(
          remote.pos,
          Math.max(0.1, remaining),
          remote.warmupProgress,
        );
      }
    } else {
      remote.warmupAudioStop?.();
      remote.warmupAudioStop = null;
    }
    remote.mesh.visible = state.alive;
  }
  for (const [id, remote] of G.remoteSlots) {
    if (seen.has(id)) continue;
    remote.warmupAudioStop?.();
    disposeNameTag(remote);
    G.scene.remove(remote.mesh);
    G.remoteSlots.delete(id);
    const idx = G.characters.indexOf(remote);
    if (idx >= 0) G.characters.splice(idx, 1);
  }
  for (const ev of snap.events || []) {
    if (ev.type === 'shot') spawnMultiplayerTracer(ev);
    if (ev.type === 'meteor') spawnMeteorVisual(ev, false);
    if (ev.type === 'comet-spawn') spawnCometVisual(ev, false);
    if (ev.type === 'comet-impact') receiveCometImpact(ev);
    if (ev.type === 'damage' && ev.attackerId === multiplayer.slotId) {
      const target = G.characters.find(c => c.id === ev.targetId);
      hud.hitmarker();
      sfx('hit');
      if (target) spawnDmgMarker(target, ev.amount || 0);
    }
    if (ev.type === 'damage' && ev.attackerId === 'gator' &&
      ev.targetId === multiplayer.slotId) {
      sfx('gatorhit');
    }
    if (ev.type === 'damage' && ev.attackerId === 'shark' &&
      ev.targetId === multiplayer.slotId) {
      sfx('chomp');
      sfx('gatorhit');
      hud.message('SHARK BITE -55', '#8ed8e8');
    }
    if (ev.type === 'kill') {
      const killer = G.characters.find(c => c.team === ev.killerId || c.id === ev.killerId) ||
        (ev.killerId === multiplayer.slotId ? G.player :
          ev.killerId === 'meteor' ? METEOR :
            ev.killerId === 'comet' ? COMET :
              ev.killerId === 'gator' ? GATOR :
                ev.killerId === 'shark' ? SHARK :
                  ev.killerId === 'lava' ? LAVA :
                    ev.killerId === 'water' ? WATER :
                      ev.killerId === 'storm' ? LIGHTNING :
                        ev.killerId === 'solar' ? SOLAR_FLARE :
                          { name: 'The Void', color: '#8899aa' });
      const victim = G.characters.find(c => c.id === ev.victimId) ||
        (ev.victimId === multiplayer.slotId ? G.player : { name: 'Player', color: '#ccc' });
      if (ev.killerId === 'gator' || ev.killerId === 'shark') hud.chompFeed(victim);
      else hud.killfeed(killer, victim);
      if (ev.victimId === multiplayer.slotId) {
        const weaponName = WEAPONS[ev.weapon]?.name || 'ENVIRONMENT';
        const environmentText = ev.weapon === 'environment'
          ? environmentalEliminationText(ev.killerId, killer.name)
          : null;
        hud.showRespawn(true, RESPAWN_TIME, killer.name, weaponName, environmentText);
      }
      if (ev.killerId === multiplayer.slotId) sfx('kill');
    }
    if (ev.type === 'award') {
      const player = G.characters.find(c => characterNetworkId(c) === ev.playerId) ||
        (ev.playerId === multiplayer.slotId ? G.player : { name: 'Player', color: '#ccc' });
      hud.awardFeed(player, ev.title, ev.color || '#ffd23c');
      if (ev.playerId === multiplayer.slotId) {
        hud.award(ev.title, ev.sub || '', ev.color || '#ffd23c');
      }
    }
  }
  G.pickups?.applyAuthoritativeState?.(snap.pickups || []);
  reconcileMultiplayerDrops(snap.drops || []);
}

function applyMultiplayerLoadout(state) {
  if (!G?.player || !Array.isArray(state.weapons)) return;
  const previouslyOwned = { ...(G.player.weapons || {}) };
  const authoritativeWeapons = { blaster: true };
  const authoritativeAmmo = { blaster: Infinity };

  const newlyOwned = [];
  for (const id of state.weapons) {
    if (!WEAPONS[id]) continue;
    if (!previouslyOwned[id]) newlyOwned.push(id);
    authoritativeWeapons[id] = true;
    if (id !== 'blaster' && Number.isFinite(state.ammo?.[id])) {
      authoritativeAmmo[id] = Math.max(0, state.ammo[id]);
    }
  }
  G.player.weapons = authoritativeWeapons;
  G.player.ammo = authoritativeAmmo;

  const authoritativeWeapon = WEAPONS[state.weapon] && authoritativeWeapons[state.weapon] &&
      (state.weapon === 'blaster' || authoritativeAmmo[state.weapon] > 0)
    ? state.weapon
    : 'blaster';
  const currentIsAuthoritative = authoritativeWeapons[G.player.weapon] &&
    (G.player.weapon === 'blaster' || authoritativeAmmo[G.player.weapon] > 0);
  if (!currentIsAuthoritative) {
    G.player.cancelWeaponWarmup?.();
    G.player.weapon = authoritativeWeapon;
    G.player.showWeaponModel?.(authoritativeWeapon);
  }

  const acquired = newlyOwned.find(id => !previouslyOwned[id] && id !== 'blaster');
  if (acquired) {
    sfx('pickup');
    hud.message(`${WEAPONS[acquired].name}!`, '#7fd0ff');
  }
}

function applyMultiplayerCombatState(ch, state) {
  if (!ch || !state) return;
  ch.shield = Math.max(0, Number(state.shield) || 0);
  const kind = state.powerup?.kind === 'gold' || state.powerup?.kind === 'silver'
    ? state.powerup.kind
    : null;
  ch.powerup = kind
    ? { kind, timeLeft: Math.max(0, Number(state.powerup.timeLeft) || 0) }
    : null;
  ch.damageMult = damageMultiplierForPowerup(ch.powerup);
  if (ch.isPlayer && ch._multiplayerPowerupKind !== kind) {
    ch._multiplayerPowerupKind = kind;
    ch.setSkin?.(kind);
  }
}

function dropSnapshotId(drop) {
  if (drop.id) return String(drop.id);
  const p = drop.pos || {};
  return `${drop.kind}:${drop.weapon || ''}:${drop.amount || 0}:${Math.round((p.x || 0) * 10)}:${Math.round((p.y || 0) * 10)}:${Math.round((p.z || 0) * 10)}`;
}

function reconcileMultiplayerDrops(drops) {
  if ((!G?.multiplayer && !G?.multiplayerHost) || !G.pickups) return;
  G.mpDropIds ||= new Set();
  const live = new Set();
  for (const drop of drops) {
    if (!drop?.pos) continue;
    const id = dropSnapshotId(drop);
    live.add(id);
    const def = {
      id,
      kind: drop.kind,
      amount: drop.amount,
      weapon: drop.weapon,
      timeLeft: drop.timeLeft,
      pos: new THREE.Vector3(drop.pos.x, drop.pos.y, drop.pos.z),
      up: drop.up ? new THREE.Vector3(drop.up.x || 0, drop.up.y || 1, drop.up.z || 0).normalize() : new THREE.Vector3(0, 1, 0),
    };
    const existing = G.pickups.items.find(item => item.mpDropId === id);
    if (existing) {
      existing.def.pos.copy(def.pos);
      existing.def.amount = def.amount;
      existing.def.weapon = def.weapon;
      existing.def.timeLeft = def.timeLeft;
      existing.def.up = def.up;
      existing.hostMirror = true;
      existing.active = true;
      existing.mesh.visible = true;
      G.mpDropIds.add(id);
      continue;
    }
    G.pickups.addDrop(def);
    const item = G.pickups.items[G.pickups.items.length - 1];
    item.mpDropId = id;
    item.hostMirror = true;
    G.mpDropIds.add(id);
  }
  for (let i = G.pickups.items.length - 1; i >= 0; i--) {
    const item = G.pickups.items[i];
    if (!item.mpDropId || live.has(item.mpDropId)) continue;
    G.scene.remove(item.mesh);
    G.pickups.items.splice(i, 1);
    G.mpDropIds.delete(item.mpDropId);
  }
}

function characterNetworkId(ch) {
  if (!ch) return null;
  if (ch.id) return ch.id;
  if (ch.isPlayer) return multiplayer.slotId;
  return ch.team || ch.name || null;
}

function eliminationWeaponName(attacker, ctx = {}) {
  const weaponId = ctx.shotGroup?.weaponId;
  if (weaponId && WEAPONS[weaponId]) return WEAPONS[weaponId].name;
  if (attacker?.weapon && WEAPONS[attacker.weapon]) return WEAPONS[attacker.weapon].name;
  return 'ENVIRONMENT';
}

function environmentalEliminationText(sourceId, sourceName = 'The Environment') {
  const verbs = {
    void: 'SWALLOWED',
    shark: 'DEVOURED',
    gator: 'DEVOURED',
    water: 'DROWNED',
    lava: 'MELTED',
    storm: 'ELECTROCUTED',
    meteor: 'CRUSHED',
    comet: 'OBLITERATED',
    solar: 'INCINERATED',
    'toad-poison': 'POISONED',
  };
  const verb = verbs[sourceId];
  return verb ? `${String(sourceName).toUpperCase()} ${verb} YOU` : null;
}

function queueMultiplayerEvent(ev) {
  if (!G?.multiplayerHost) return;
  G.mpEvents = coalesceSnapshotEvents(G.mpEvents || [], [ev], 80);
}

function recordMultiplayerShot(owner, origin, dir, weaponId) {
  if (!G?.multiplayerHost) return;
  const w = WEAPONS[weaponId] || WEAPONS.blaster;
  const distance = w.beamRange ?? Math.min(80, Math.max(24, w.speed * 0.45));
  queueMultiplayerEvent({
    type: 'shot',
    shooterId: characterNetworkId(owner),
    weapon: weaponId,
    from: { x: origin.x, y: origin.y, z: origin.z },
    to: { x: origin.x + dir.x * distance, y: origin.y + dir.y * distance, z: origin.z + dir.z * distance },
    color: `#${w.color.toString(16).padStart(6, '0')}`,
  });
}

function updateRemoteSlots(dt) {
  if (!G?.remoteSlots) return;
  const now = performance.now();
  const a = 1 - Math.exp(-REMOTE_SLOT_SMOOTH * dt);
  const turnA = 1 - Math.exp(-24 * dt);
  for (const remote of G.remoteSlots.values()) {
    const beforeX = remote.pos.x;
    const beforeZ = remote.pos.z;
    const elapsed = remote.snapshotReceivedAt
      ? Math.max(0, (now - remote.snapshotReceivedAt) / 1000)
      : 0;
    remote.targetPos.copy(remote.snapshotPos).addScaledVector(
      remote.snapshotVel,
      boundedSnapshotLead(remote.snapshotAge, elapsed, remote.alive),
    );
    if (remote.pos.distanceToSquared(remote.targetPos) > REMOTE_SLOT_SNAP_DIST ** 2) remote.pos.copy(remote.targetPos);
    else remote.pos.lerp(remote.targetPos, a);
    remote.yaw = smoothNetworkAngle(remote.yaw || 0, remote.targetYaw || 0, turnA);
    remote.mesh.position.copy(remote.pos);
    remote.mesh.rotation.y = remote.yaw || 0;
    if (remote.horseVisual) {
      const dx = remote.pos.x - beforeX;
      const dz = remote.pos.z - beforeZ;
      if (dx * dx + dz * dz > 1e-6) remote.horseHeading = Math.atan2(dx, dz);
      remote.horseVisual.rotation.y = (remote.horseHeading || 0) - (remote.yaw || 0);
      const gait = performance.now() * 0.012;
      const pace = Math.min(1, Math.hypot(dx, dz) / Math.max(0.001, dt * G.world.playerSpeed));
      for (const leg of remote.horseLegs || []) leg.rotation.x = Math.sin(gait + leg.userData.gaitPhase) * 0.48 * pace;
    }
    syncRemoteGrappleVisual(remote);
    syncJetpackVisual(remote, dt);
    updateWeaponWarmupVisual(
      remote._gun,
      remote.warmupProgress,
      performance.now() * 0.001,
    );
  }
}

// Remote shots are visual-only, but can arrive in bursts. Keep their meshes,
// materials, and vector storage allocated for the life of the match rather
// than creating and disposing them for every network event.
function createMultiplayerTracerPool(scene, geometry, capacity = 64) {
  const pool = { scene, active: [], free: [] };
  for (let i = 0; i < capacity; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.visible = false;
    pool.free.push({
      mesh, mat,
      from: new THREE.Vector3(),
      to: new THREE.Vector3(),
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      previous: new THREE.Vector3(),
      t: 0,
      life: 0.1,
      impact: false,
      color: 0xffffff,
      generation: 0,
      _bloomRecursionCrossings: 0,
      weapon: null,
      weaponId: 'blaster',
      shooterId: null,
      projectileSize: 0.1,
      bounced: 0,
      bounceLimit: 0,
    });
  }
  pool.acquire = () => {
    if (pool.free.length) return pool.free.pop();
    const oldest = pool.active.shift();
    pool.scene.remove(oldest.mesh);
    return oldest;
  };
  pool.release = (tracer) => {
    pool.scene.remove(tracer.mesh);
    tracer.mesh.visible = false;
    pool.free.push(tracer);
  };
  pool.dispose = () => {
    while (pool.active.length) pool.release(pool.active.pop());
    for (const tracer of pool.free) tracer.mat.dispose();
    pool.free.length = 0;
  };
  return pool;
}

const mpTracerFrom = new THREE.Vector3();
const mpTracerTo = new THREE.Vector3();
const mpTracerDir = new THREE.Vector3();
const mpTracerRight = new THREE.Vector3();
const mpTracerUp = new THREE.Vector3();
const mpTracerStep = new THREE.Vector3();
const mpTracerProbe = new THREE.Vector3();
const mpTracerWorldUp = new THREE.Vector3(0, 1, 0);

function spawnMultiplayerTracer(ev) {
  const pool = G?.mpTracerPool;
  if (!pool || !ev.from || !ev.to) return;
  const from = mpTracerFrom.set(ev.from.x, ev.from.y, ev.from.z);
  const to = mpTracerTo.set(ev.to.x, ev.to.y, ev.to.z);
  const distSq = from.distanceToSquared(to);
  if (distSq < 0.01) return;
  const weaponId = WEAPONS[ev.weapon] ? ev.weapon : 'blaster';
  const weapon = WEAPONS[weaponId];
  // Guests already render their own predicted shot immediately. Replaying the
  // host-confirmed shot on the return trip made every trigger pull appear to
  // echo a fraction of a second later; damage/hit events remain authoritative.
  if (ev.shooterId === multiplayer.slotId) return;
  const color = parseInt(String(ev.color || '#ffd23c').replace('#', ''), 16) || 0xffd23c;
  if (weapon.beam) {
    mpTracerDir.subVectors(to, from).normalize();
    G.projectiles.spawnVisualBeam(from, mpTracerDir, weapon);
    G.fxPool.spawnPuff(from, color, 0.22);
    return;
  }
  const pellets = Math.min(weapon.pellets || 1, 6);
  const dir = mpTracerDir.subVectors(to, from).normalize();
  const right = Math.abs(dir.y) > 0.9
    ? mpTracerRight.set(1, 0, 0)
    : mpTracerRight.crossVectors(dir, mpTracerWorldUp).normalize();
  const up = mpTracerUp.crossVectors(right, dir).normalize();
  const dist = Math.sqrt(distSq);
  const life = weapon.remoteBounce
    ? weapon.projectileLife
    : Math.min(
      weapon.tracerLife ?? 0.7,
      Math.max(0.07, dist / Math.max(weapon.speed, 1)),
    );
  for (let i = 0; i < pellets; i++) {
    const tracer = pool.acquire();
    const { mesh, mat } = tracer;
    mesh.geometry = G.projectiles.geoBall;
    if (weapon.disc) mesh.scale.set(weapon.size * 1.5, weapon.size * 0.35, weapon.size * 1.5);
    else mesh.scale.setScalar(Math.max(weapon.size, 0.1));
    // Pooled tracers may previously have represented a differently sized shot.
    // Replace the baseline every time so later shots never inherit its scale.
    mesh._recursiveBaseScale = mesh.scale.clone();
    tracer.to.copy(to);
    if (pellets > 1) {
      const spread = dist * 0.03;
      tracer.to
        .addScaledVector(right, rand(-spread, spread))
        .addScaledVector(up, rand(-spread, spread));
    }
    tracer.from.copy(from);
    tracer.t = 0;
    tracer.life = life;
    tracer.impact = !!ev.hit;
    tracer.color = color;
    tracer.weapon = weapon;
    tracer.weaponId = weaponId;
    tracer.shooterId = ev.shooterId || null;
    tracer.projectileSize = weapon.size || 0.1;
    tracer.bounced = 0;
    tracer.bounceLimit = weapon.bounce || 0;
    tracer.generation++;
    tracer._bloomRecursionCrossings = 0;
    tracer.onRecursionCrossing = null;
    tracer.pos.copy(tracer.from);
    if (weapon.remoteBounce) tracer.vel.copy(dir).multiplyScalar(weapon.speed);
    else tracer.vel.subVectors(tracer.to, tracer.from).multiplyScalar(1 / tracer.life);
    if (G.world.prepareVisualProjectile?.(tracer) === false) {
      pool.release(tracer);
      continue;
    }
    mat.color.setHex(color);
    mat.opacity = 0.95;
    mesh.material = mat;
    mesh.position.copy(tracer.pos);
    mesh.visible = true;
    G.scene.add(mesh);
    pool.active.push(tracer);
  }
  G.fxPool.spawnPuff(from, color, 0.22);
}

function updateMultiplayerTracers(dt) {
  const pool = G?.mpTracerPool;
  if (!pool) return;
  for (let i = pool.active.length - 1; i >= 0; i--) {
    const tr = pool.active[i];
    const moveDt = Math.min(dt, Math.max(0, tr.life - tr.t));
    tr.t += moveDt;
    if (tr.weapon?.remoteBounce && tr.weapon.gravity) {
      const gravity = G.world.gravityAt?.(tr.pos, tr) ?? G.world.gravity;
      tr.vel.y -= gravity * 0.9 * moveDt;
    }
    let remaining = moveDt;
    let traversalFailed = false;
    let detonated = false;
    let guard = 0;
    while (remaining > 1e-6 && !traversalFailed) {
      if (++guard > 512) {
        traversalFailed = true;
        break;
      }
      const speed = tr.vel.length();
      const stepDt = speed > 1e-6 ? Math.min(remaining, 0.5 / speed) : remaining;
      remaining -= stepDt;
      tr.previous.copy(tr.pos);
      mpTracerStep.copy(tr.vel).multiplyScalar(stepDt);
      tr.pos.add(mpTracerStep);
      const traversalResult = G.world.postVisualProjectileMove?.(tr, tr.previous);
      if (traversalResult === false) {
        traversalFailed = true;
        break;
      }
      if (Number.isFinite(traversalResult) && traversalResult !== 1) {
        tr.previous.multiplyScalar(traversalResult);
        mpTracerStep.multiplyScalar(traversalResult);
      }
      if (tr.weapon?.remoteBounce) {
        const shooter = G.characters.find(ch => ch.id === tr.shooterId);
        for (const ch of G.characters) {
          if (!ch.alive || ch.id === tr.shooterId || (shooter && ch.team === shooter.team)) continue;
          if (!G.projectiles.projectileTouchesCharacter(ch, tr)) continue;
          detonated = true;
          break;
        }
        if (detonated) break;
        const radius = tr.projectileSize * 0.6;
        if (pointHitsWorld(tr.pos, radius, G.world)) {
          applyProjectileBounce(tr, tr.previous, mpTracerStep, mpTracerProbe, G.world);
        }
      }
    }
    const done = traversalFailed || detonated || tr.t >= tr.life;
    const a = Math.min(1, tr.t / tr.life);
    tr.mesh.position.copy(tr.pos);
    tr.mat.opacity = tr.weapon?.remoteBounce
      ? Math.min(0.95, Math.max(0, (1 - a) * 4))
      : Math.max(0, 1 - a);
    if (done) {
      if (tr.weapon?.remoteBounce) {
        sfx('explode', tr.pos);
        G.fxPool.spawnPuff(
          tr.pos,
          tr.weapon.explosionColor ?? tr.color,
          Math.max(3.2, (tr.weapon.splash || 0) * 0.75),
        );
      } else if (tr.impact) {
        G.fxPool.spawnPuff(
          tr.pos,
          tr.currentColor || tr.color,
          0.45 * Math.sqrt(tr.recursionScale || 1),
        );
      }
      pool.active.splice(i, 1);
      pool.release(tr);
    }
  }
}

function endMatch(toLobby) {
  teardown();
  hud.show(false);
  hud.clearAwards();
  if (toLobby) startAtrium();
  else document.exitPointerLock?.();
}

function sphereOverlapsBox(pos, radius, box) {
  const x = Math.max(box.min.x, Math.min(box.max.x, pos.x));
  const y = Math.max(box.min.y, Math.min(box.max.y, pos.y));
  const z = Math.max(box.min.z, Math.min(box.max.z, pos.z));
  const dx = pos.x - x, dy = pos.y - y, dz = pos.z - z;
  return dx * dx + dy * dy + dz * dz < radius * radius;
}

function nearestEscherSpawnUp(pos) {
  let best = null, bd = Infinity;
  for (const c of G.world.colliders) {
    if (c.type !== 'box') continue;
    const cx = Math.max(c.min.x, Math.min(c.max.x, pos.x));
    const cy = Math.max(c.min.y, Math.min(c.max.y, pos.y));
    const cz = Math.max(c.min.z, Math.min(c.max.z, pos.z));
    const dx = pos.x - cx, dy = pos.y - cy, dz = pos.z - cz;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 <= 1e-6 || d2 > 1.1 * 1.1 || d2 >= bd) continue;
    const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
    if (ax >= ay && ax >= az) best = new THREE.Vector3(Math.sign(dx), 0, 0);
    else if (ay >= az) best = new THREE.Vector3(0, Math.sign(dy), 0);
    else best = new THREE.Vector3(0, 0, Math.sign(dz));
    bd = d2;
  }
  return best;
}

function spawnSurfaceKey(pos) {
  if (!G.world.escher) return 'flat';
  const up = nearestEscherSpawnUp(pos);
  if (!up) return 'unknown';
  if (Math.abs(up.x) > 0.5) return up.x > 0 ? '+x' : '-x';
  if (Math.abs(up.y) > 0.5) return up.y > 0 ? '+y' : '-y';
  return up.z > 0 ? '+z' : '-z';
}

function spawnHasSupport(pos, ch) {
  if (G.world.escher) return !!nearestEscherSpawnUp(pos);
  const footSlack = 0.45;
  const sideSlack = ch.radius * 0.45;
  for (const c of G.world.colliders) {
    let surfaceY = null;
    if (c.type === 'box') {
      if (pos.x < c.min.x - sideSlack || pos.x > c.max.x + sideSlack ||
          pos.z < c.min.z - sideSlack || pos.z > c.max.z + sideSlack) continue;
      surfaceY = c.max.y;
    } else if (c.type === 'ellipsoid') {
      surfaceY = ellipsoidSurfaceY(c, pos.x, pos.z);
      if (surfaceY == null) continue;
    } else if (c.type === 'triangleMesh') {
      surfaceY = triangleMeshSurfaceY(c, pos.x, pos.z);
      if (surfaceY == null) continue;
    } else if (c.type === 'cylinderShell') {
      surfaceY = cylinderShellSurfaceY(c, pos.x, pos.z);
      if (surfaceY == null) continue;
    } else continue;
    const drop = pos.y - surfaceY;
    if (drop >= -0.08 && drop <= footSlack) return true;
  }
  for (const ramp of G.world.ramps) {
    if (!inRampFootprint(ramp, pos.x, pos.z, sideSlack)) continue;
    const drop = pos.y - rampSurfaceY(ramp, pos.x, pos.z);
    if (drop >= -0.08 && drop <= footSlack) return true;
  }
  return false;
}

function spawnIsClear(pos, ch) {
  const probe = new THREE.Vector3();
  const up = G.world.escher ? (nearestEscherSpawnUp(pos) || ch.up || new THREE.Vector3(0, 1, 0)) : null;
  const sphereYs = [ch.radius, ch.height * 0.5, ch.height - ch.radius];
  for (const c of G.world.colliders) {
    for (const sy of sphereYs) {
      if (up) probe.copy(pos).addScaledVector(up, sy);
      else probe.set(pos.x, pos.y + sy, pos.z);
      if (c.type === 'box') {
        if (sphereOverlapsBox(probe, ch.radius, c)) return false;
      } else if (c.type === 'sphere' && probe.distanceToSquared(c.center) < (ch.radius + c.radius) ** 2) {
        return false;
      } else if (c.type === 'ellipsoid' && sphereHitsEllipsoid(probe, ch.radius, c)) {
        return false;
      } else if (c.type === 'triangleMesh' && sphereHitsTriangleMesh(probe, ch.radius, c)) {
        return false;
      } else if (c.type === 'cylinderShell' && sphereHitsCylinderShell(probe, ch.radius, c)) {
        return false;
      }
    }
  }
  return true;
}

function safeSpawnPoint(base, ch) {
  if (spawnHasSupport(base, ch) && spawnIsClear(base, ch)) return base.clone();
  const jittered = base.clone();
  jittered.x += rand(-0.75, 0.75);
  jittered.z += rand(-0.75, 0.75);
  if (spawnHasSupport(jittered, ch) && spawnIsClear(jittered, ch)) return jittered;
  return null;
}

function spawnPoolKey(poolKey) {
  const map = G.mapDef?.id || 'atrium';
  return `${map}:${G.mode}:${poolKey}`;
}

function pickSpawnPoint(spawns, ch, poolKey) {
  const key = spawnPoolKey(poolKey);
  const last = lastSpawnByKey.get(key);
  const lastFace = G.world.escher ? lastSpawnFaceByKey.get(key) : null;
  const indices = spawns.map((_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  const used = G.spawnBatchUsed?.get(poolKey);
  const usedFaces = G.spawnBatchUsedFaces?.get(poolKey);
  let ordered = indices;
  if (used && used.size < spawns.length) {
    const unused = ordered.filter(i => !used.has(spawnCoordKey(spawns[i])));
    if (unused.length) ordered = unused;
  }
  if (G.world.escher && usedFaces) {
    const unusedFaces = ordered.filter(i => !usedFaces.has(spawnSurfaceKey(spawns[i])));
    if (unusedFaces.length) ordered = unusedFaces;
  }
  if (spawns.length > 1) {
    ordered = ordered.filter(i => spawnCoordKey(spawns[i]) !== last)
      .concat(ordered.filter(i => spawnCoordKey(spawns[i]) === last));
  }
  if (G.world.escher && lastFace && new Set(ordered.map(i => spawnSurfaceKey(spawns[i]))).size > 1) {
    ordered = ordered.filter(i => spawnSurfaceKey(spawns[i]) !== lastFace)
      .concat(ordered.filter(i => spawnSurfaceKey(spawns[i]) === lastFace));
  }
  const awayFromPlayers = [];
  const nearPlayers = [];
  for (const idx of ordered) {
    const p = safeSpawnPoint(spawns[idx], ch);
    if (!p) continue;
    const crowded = G.characters?.some(other => {
      if (other === ch || !other.alive) return false;
      const dy = Math.abs((other.pos.y || 0) - p.y);
      return dy < 8 && other.pos.distanceToSquared(p) < 10 * 10;
    });
    (crowded ? nearPlayers : awayFromPlayers).push([idx, p]);
  }
  const picked = awayFromPlayers[0] || nearPlayers[0];
  if (picked) {
    const [idx, p] = picked;
    const coordKey = spawnCoordKey(spawns[idx]);
    lastSpawnByKey.set(key, coordKey);
    if (G.world.escher) lastSpawnFaceByKey.set(key, spawnSurfaceKey(spawns[idx]));
    used?.add(coordKey);
    usedFaces?.add(spawnSurfaceKey(spawns[idx]));
    return p;
  }
  const fallbackIdx = ordered[0] ?? 0;
  const fallbackKey = spawnCoordKey(spawns[fallbackIdx]);
  lastSpawnByKey.set(key, fallbackKey);
  if (G.world.escher) lastSpawnFaceByKey.set(key, spawnSurfaceKey(spawns[fallbackIdx]));
  used?.add(fallbackKey);
  usedFaces?.add(spawnSurfaceKey(spawns[fallbackIdx]));
  return spawns[fallbackIdx].clone();
}

function respawnCharacter(ch, initial = false) {
  const useTeamStart = initial && G.mode === 'tdm';
  const baseSpawns = useTeamStart ? G.world.spawns[ch.team] : G.world.spawnsAll;
  const spawns = (ch.isPlayer && G.world.playerSpawns && !useTeamStart) ? G.world.playerSpawns : baseSpawns;
  const poolKey = useTeamStart ? `start:${ch.team}` : 'all';
  if (G.spawnBatchUsed && !G.spawnBatchUsed.has(poolKey)) G.spawnBatchUsed.set(poolKey, new Set());
  if (G.spawnBatchUsedFaces && !G.spawnBatchUsedFaces.has(poolKey)) G.spawnBatchUsedFaces.set(poolKey, new Set());
  const p = pickSpawnPoint(spawns, ch, poolKey);
  if (useTeamStart) {
    lastSpawnByKey.set(spawnPoolKey('all'), spawnCoordKey(p));
    if (G.world.escher) lastSpawnFaceByKey.set(spawnPoolKey('all'), spawnSurfaceKey(p));
  }
  ch.spawn(p);
  clearDrowningState(ch);
  if (ch._toadEffects) ch._toadEffects.length = 0;
  ch._toadEffectCooldown = 0;
  if (ch.isPlayer) {
    G.hallucinating = false;
    G.hallucinationStrength = 0;
  }
  if (ch.remoteHuman) {
    ch.remoteNet = makeRemoteNet(ch.pos);
    G.remoteInputs?.delete(ch.id);
  }
  if (ch.isPlayer && !initial) hud.showRespawn(false);
}

/* ---------------- victory podium ---------------- */
function rankedCharacters() {
  return [...G.characters].sort((a, b) =>
    b.score - a.score || b.kills - a.kills || a.deaths - b.deaths ||
    a.name.localeCompare(b.name));
}

function colorHex(ch, fallback = 0xffd23c) {
  if (!ch?.color) return fallback;
  return parseInt(String(ch.color).replace('#', ''), 16) || fallback;
}

function podiumMaterial(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.58,
    metalness: 0.08,
    envMapIntensity: 0.45,
    ...opts,
  });
}

function podiumBox(scene, x, y, z, w, h, d, material) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

function paintEndTextCanvas(canvas, g, text, {
  color = '#7dff7d',
  stroke = 'rgba(0,0,0,.78)',
  bg = 'rgba(8,12,20,.55)',
  font = 'bold 46px "Arial Black", Arial',
  sub = '',
  subColor = '#dbe8ff',
  border = null,
} = {}) {
  const { width, height } = canvas;
  g.clearRect(0, 0, width, height);
  if (bg) {
    g.fillStyle = bg;
    g.beginPath();
    g.roundRect(12, 12, width - 24, height - 24, 20);
    g.fill();
    if (border) {
      g.lineWidth = 7;
      g.strokeStyle = border;
      g.stroke();
    }
  }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = font;
  g.lineWidth = 9;
  g.strokeStyle = stroke;
  g.strokeText(text, width / 2, sub ? height * 0.42 : height / 2);
  g.fillStyle = color;
  g.fillText(text, width / 2, sub ? height * 0.42 : height / 2);
  if (!sub) return;
  g.font = 'bold 28px Arial';
  g.lineWidth = 5;
  g.strokeStyle = stroke;
  g.strokeText(sub, width / 2, height * 0.72);
  g.fillStyle = subColor;
  g.fillText(sub, width / 2, height * 0.72);
}

function makeEndTextSprite(text, options = {}) {
  const normalized = {
    color: '#7dff7d',
    stroke: 'rgba(0,0,0,.78)',
    bg: 'rgba(8,12,20,.55)',
    width: 768,
    height: 192,
    font: 'bold 46px "Arial Black", Arial',
    sub: '',
    subColor: '#dbe8ff',
    border: null,
    scale: [4.8, 1.2],
    ...options,
  };
  const canvas = document.createElement('canvas');
  canvas.width = normalized.width;
  canvas.height = normalized.height;
  const g = canvas.getContext('2d');
  paintEndTextCanvas(canvas, g, text, normalized);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  }));
  sprite.scale.set(normalized.scale[0], normalized.scale[1], 1);
  sprite.userData.tex = tex;
  sprite.userData.endTextCanvas = canvas;
  sprite.userData.endTextContext = g;
  sprite.userData.endTextOptions = normalized;
  return sprite;
}

function updateEndTextSprite(sprite, text, options = {}) {
  if (!sprite?.userData?.endTextCanvas || !sprite.userData.endTextContext) return;
  const normalized = { ...sprite.userData.endTextOptions, ...options };
  sprite.userData.endTextOptions = normalized;
  paintEndTextCanvas(
    sprite.userData.endTextCanvas,
    sprite.userData.endTextContext,
    text,
    normalized,
  );
  sprite.scale.set(normalized.scale[0], normalized.scale[1], 1);
  sprite.userData.tex.needsUpdate = true;
}

function makePodiumRankSprite(rank, color) {
  return makeEndTextSprite(String(rank), {
    color,
    bg: null,
    width: 320,
    height: 320,
    font: 'bold 150px "Arial Black", Arial',
    scale: [0.98, 0.98],
  });
}

function podiumSurfaceYAt(world, x, z) {
  let y = null;
  const pad = 0.65;
  for (const c of world.colliders || []) {
    if (c.type !== 'box') continue;
    if (x < c.min.x - pad || x > c.max.x + pad || z < c.min.z - pad || z > c.max.z + pad) continue;
    if (y === null || c.max.y > y) y = c.max.y;
  }
  for (const ramp of world.ramps || []) {
    if (!inRampFootprint(ramp, x, z, pad)) continue;
    const ry = rampSurfaceY(ramp, x, z);
    if (y === null || ry > y) y = ry;
  }
  return y;
}

function resolvePodiumAnchor(world) {
  const preferred = world.podiumSpot;
  if (preferred) {
    const y = podiumSurfaceYAt(world, preferred.x, preferred.z);
    if (y !== null && y > world.killY + 2) {
      return new THREE.Vector3(preferred.x, y + 0.08, preferred.z);
    }
  }
  const center = new THREE.Vector3();
  const candidates = [
    center,
    ...(world.waypoints || []).map(w => w.pos),
    ...(world.spawnsAll || []),
  ].sort((a, b) => (a.x * a.x + a.z * a.z) - (b.x * b.x + b.z * b.z));
  for (const c of candidates) {
    const y = podiumSurfaceYAt(world, c.x, c.z);
    if (y !== null && y > world.killY + 2) return new THREE.Vector3(c.x, y + 0.08, c.z);
  }
  return new THREE.Vector3(0, Math.max(0, world.killY + 8), 0);
}

function createVictoryWinnerSlot(stage, spec, place) {
  const avatar = buildBotMesh(0xffd23c, G.world.mounted);
  const group = avatar.group;
  const baseRotY = place === 1 ? -0.34 : place === 2 ? 0.34 : 0;
  const baseScale = place === 0 ? 1.18 : 1.05;
  group.position.set(spec.x, spec.h + 0.02, -0.08);
  group.rotation.y = baseRotY;
  group.scale.setScalar(baseScale);
  const weapons = new Map();
  for (const id of Object.keys(WEAPONS)) {
    const gun = buildBlaster(id);
    gun.scale.setScalar(0.55);
    gun.position.set(0.32, G.world.mounted ? 2 + HORSE_HEIGHT_DELTA : 1.05, 0.25);
    gun.rotation.y = Math.PI;
    gun.visible = id === 'blaster';
    group.add(gun);
    weapons.set(id, gun);
  }
  group.traverse(object => { if (object.isMesh) object.castShadow = true; });
  stage.add(group);

  const name = makeEndTextSprite('PLAYER', {
    color: '#ffffff',
    sub: '0 PTS',
    subColor: '#dbe8ff',
    bg: 'rgba(3,7,14,.92)',
    border: '#ffd23c',
    scale: [3.05, 0.8],
    font: 'bold 38px "Arial Black", Arial',
  });
  name.position.set(spec.x, spec.h + 2.72, 0.05);
  name.material.depthTest = false;
  name.renderOrder = 20;
  stage.add(name);
  return {
    ...avatar,
    group,
    name,
    weapons,
    baseY: group.position.y,
    baseRotY,
    baseScale,
    phase: place * 0.23,
    hopHeight: place === 0 ? 0.42 : 0.3,
    hopSpeed: place === 0 ? 1.55 : 1.35,
  };
}

function populateVictoryWinners(presentation, ranked, resetPose = true) {
  presentation.winnerSlots ||= presentation.pedestalSpecs.map((spec, place) =>
    createVictoryWinnerSlot(presentation.stage, spec, place));
  const avatars = [];
  presentation.winnerSlots.forEach((slot, place) => {
    const ch = ranked[place];
    slot.group.visible = !!ch;
    slot.name.visible = !!ch;
    if (!ch) return;
    const color = colorHex(ch);
    slot.body.material.color.setHex(color);
    slot.visor.material.emissive.setHex(color);
    syncJetpackVisual(ch, 0, slot.jetpack);
    const weaponId = slot.weapons.has(ch.weapon) ? ch.weapon : 'blaster';
    for (const [id, gun] of slot.weapons) gun.visible = id === weaponId;
    if (resetPose) {
      slot.group.position.y = slot.baseY;
      slot.group.rotation.set(0, slot.baseRotY, 0);
      slot.group.scale.setScalar(slot.baseScale);
    }
    updateEndTextSprite(slot.name, ch.isPlayer ? 'YOU' : ch.name.toUpperCase(), {
      sub: `${ch.score} PTS`,
      border: ch.color || '#ffd23c',
    });
    avatars.push(slot);
  });
  return avatars;
}

function configureVictoryPresentation(presentation, ranked) {
  const anchor = G.podiumAnchor?.clone() || resolvePodiumAnchor(G.world);
  presentation.stage.position.copy(anchor);
  const avatars = populateVictoryWinners(presentation, ranked);
  const lookAt = anchor.clone().add(new THREE.Vector3(0, 2.25, 0));
  const cameraTarget = anchor.clone().add(new THREE.Vector3(0, 4.15, 11.85));
  const cameraTargetMatrix = new THREE.Matrix4().lookAt(cameraTarget, lookAt, camera.up);
  const end = {
    t: 0,
    avatars,
    anchor,
    confetti: presentation.confetti,
    lookAt,
    cameraStart: camera.position.clone(),
    cameraStartQuaternion: camera.quaternion.clone(),
    cameraStartFov: camera.fov,
    cameraTarget,
    cameraTargetQuaternion: new THREE.Quaternion().setFromRotationMatrix(cameraTargetMatrix),
    cameraTargetFov: 58,
    screenRevealed: false,
  };
  presentation.end = end;
  return presentation;
}

function buildVictoryPresentation({ ranked }) {
  const anchor = G.podiumAnchor?.clone() || resolvePodiumAnchor(G.world);
  const stage = new THREE.Group();
  stage.position.copy(anchor);

  // This remains the podium's original light rig. It is prewarmed while
  // temporarily attached to the covered arena, then detached until match end.
  // That preserves the original combined arena/podium look without discovering
  // five new lights and a map-wide shadow pass on the final gameplay frame.
  const lightRig = new THREE.Group();
  stage.add(lightRig);
  const hemi = new THREE.HemisphereLight(0xffe2a8, 0x223040, 1.5);
  lightRig.add(hemi);
  const key = new THREE.DirectionalLight(0xfff2d0, 3.2);
  key.position.set(-5, 9, 7);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  lightRig.add(key);
  for (const [x, z, c] of [[-5.8, -1.8, 0x30e0ff], [5.8, -1.8, 0xff40a0], [0, 4, 0x8aff30]]) {
    const l = new THREE.PointLight(c, 2.2, 13);
    l.position.set(x, 2.8, z);
    lightRig.add(l);
  }

  const darkWood = podiumMaterial(0x5a2f1e, { roughness: 0.84 });
  const green = podiumMaterial(0x15b15b, { emissive: 0x063d23, emissiveIntensity: 0.24 });
  const brass = podiumMaterial(0xffb02e, { metalness: 0.35, roughness: 0.36 });
  const bronze = podiumMaterial(0xb96d35, { metalness: 0.22, roughness: 0.5 });
  const silver = podiumMaterial(0xdfe5f2, { metalness: 0.48, roughness: 0.31 });

  podiumBox(stage, 0, -0.08, 0, 12.5, 0.16, 8.2, darkWood);
  podiumBox(stage, 0, -0.22, 0, 13.4, 0.22, 9.0, green);

  const pedestalSpecs = [
    { x: 0, h: 2.5, w: 2.5, d: 2.25, mat: brass, medal: '#ffd23c' },
    { x: -3.0, h: 1.55, w: 2.3, d: 2.0, mat: silver, medal: '#e5edf8' },
    { x: 3.0, h: 1.15, w: 2.3, d: 2.0, mat: bronze, medal: '#d98c45' },
  ];
  pedestalSpecs.forEach((spec, i) => {
    podiumBox(stage, spec.x, spec.h / 2, 0, spec.w, spec.h, spec.d, spec.mat);
    podiumBox(stage, spec.x, spec.h + 0.05, 0, spec.w + 0.36, 0.1, spec.d + 0.36, green);
    const face = makePodiumRankSprite(i + 1, spec.medal);
    face.position.set(spec.x, spec.h * 0.5, spec.d / 2 + 0.1);
    face.renderOrder = 4;
    stage.add(face);
  });

  const pos = [];
  const cols = [];
  const palette = [0xffd23c, 0x30e0ff, 0xff40a0, 0x8aff30, 0xff6a30, 0xffffff];
  for (let i = 0; i < 180; i++) {
    pos.push(rand(-5.8, 5.8), rand(2.2, 7.2), rand(-3.4, 2.5));
    const c = new THREE.Color(pick(palette));
    cols.push(c.r, c.g, c.b);
  }
  const confettiGeo = new THREE.BufferGeometry();
  confettiGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  confettiGeo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  const confetti = new THREE.Points(confettiGeo, new THREE.PointsMaterial({
    size: 0.075,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
  }));
  stage.add(confetti);

  return configureVictoryPresentation({
    stage,
    pedestalSpecs,
    confetti,
    winnerSlots: null,
    end: null,
  }, ranked);
}

const victoryPodiumPrewarms = new Map();

function victoryPodiumPrewarmKey() {
  return [
    G?.scene?.fog ? 'fog' : 'clear',
    G?.world?.mounted ? 'mounted' : 'foot',
    usesLightRenderPath() ? 'direct' : 'composer',
    renderer.shadowMap.enabled ? 'shadows' : 'no-shadows',
  ].join(':');
}

function victoryPodiumPrewarmResult() {
  return {
    ranked: rankedCharacters().slice(0, 3),
    title: 'MATCH COMPLETE',
    color: '#ffd23c',
    stats: '',
  };
}

function createVictoryPodiumPrewarm() {
  const key = victoryPodiumPrewarmKey();
  const existing = victoryPodiumPrewarms.get(key);
  if (existing) return existing;
  const entry = {
    presentation: buildVictoryPresentation(victoryPodiumPrewarmResult()),
    warmedScenes: new WeakSet(),
    promise: null,
    promiseScene: null,
  };
  // Keep the presentation alive between rounds. Every newly built arena is
  // still prewarmed with the rig attached because its own materials need the
  // podium-light variants.
  victoryPodiumPrewarms.set(key, entry);
  return entry;
}

function prepareVictoryArenaWarmupState() {
  const visibility = new Map();
  const hide = object => {
    if (!object || visibility.has(object)) return;
    visibility.set(object, object.visible);
    object.visible = false;
  };
  for (const ch of G.characters || []) {
    if (!ch.isPlayer) hide(ch.mesh);
  }
  for (const item of G.pickups?.items || []) {
    hide(item.mesh);
    for (const light of item.lights || []) hide(light);
  }
  hide(G.pickups?.dropPrewarmGroup);
  for (const object of [
    G.player?.viewmodel,
    G.player?.dualBlasterViewmodel,
    G.player?.grappleViewmodel,
    G.player?.horseViewmodel,
    G.player?.muzzleFlash,
    G.player?.leftMuzzleFlash,
  ]) hide(object);
  return () => {
    for (const [object, visible] of visibility) object.visible = visible;
  };
}

function prepareVictoryWinnerVariantWarmup(presentation) {
  const visibility = new Map();
  const reveal = object => {
    if (!object || visibility.has(object)) return;
    visibility.set(object, object.visible);
    object.visible = true;
  };
  for (const slot of presentation.winnerSlots || []) {
    reveal(slot.group);
    reveal(slot.name);
    reveal(slot.jetpack);
    reveal(slot.jetpack?._flames);
    for (const gun of slot.weapons.values()) reveal(gun);
  }
  return () => {
    for (const [object, visible] of visibility) object.visible = visible;
  };
}

function prepareVictoryEventVariantWarmup() {
  const visibility = new Map();
  const reveal = object => {
    if (!object || visibility.has(object)) return;
    visibility.set(object, object.visible);
    object.visible = true;
  };
  for (const visual of G.meteorVisualPool || []) {
    reveal(visual.group);
    reveal(visual.warning);
  }
  for (const visual of G.cometVisualPool || []) reveal(visual.group);
  return () => {
    for (const [object, visible] of visibility) object.visible = visible;
  };
}

function beginVictoryPodiumWarmup(entry, arenaScene) {
  const savedTarget = renderer.getRenderTarget();
  const savedAutoClear = renderer.autoClear;
  const savedRenderScene = renderPass.scene;
  const savedPosition = camera.position.clone();
  const savedQuaternion = camera.quaternion.clone();
  const savedFov = camera.fov;
  const savedNear = camera.near;
  const savedFar = camera.far;
  const { presentation } = entry;
  const end = presentation.end;
  const restoreArenaState = prepareVictoryArenaWarmupState();
  const restoreWinnerVariants = prepareVictoryWinnerVariantWarmup(presentation);
  const restoreEventVariants = prepareVictoryEventVariantWarmup();
  presentation.stage.removeFromParent();
  arenaScene.add(presentation.stage);
  renderPass.scene = arenaScene;
  camera.position.copy(end.cameraTarget);
  camera.quaternion.copy(end.cameraTargetQuaternion);
  camera.fov = end.cameraTargetFov;
  camera.near = 0.1;
  camera.far = 900;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  renderer.setRenderTarget(usesLightRenderPath() ? null : composer.renderTarget1);
  return () => {
    arenaScene.remove(presentation.stage);
    restoreEventVariants();
    restoreWinnerVariants();
    restoreArenaState();
    renderer.setRenderTarget(savedTarget);
    renderer.autoClear = savedAutoClear;
    renderPass.scene = savedRenderScene;
    camera.position.copy(savedPosition);
    camera.quaternion.copy(savedQuaternion);
    camera.fov = savedFov;
    camera.near = savedNear;
    camera.far = savedFar;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  };
}

function renderVictoryPodiumWarmup(arenaScene) {
  // A real covered draw through the active render path prepares the exact
  // output/shadow variants and allocates the podium light's shadow target.
  // The stage is attached to the arena here exactly as it will be at match end.
  if (usesLightRenderPath()) {
    renderer.autoClear = true;
    renderer.setRenderTarget(null);
    renderer.render(arenaScene, camera);
  } else {
    composer.render();
  }
}

function prewarmVictoryPodium() {
  const arenaScene = G.scene;
  const entry = createVictoryPodiumPrewarm();
  G.victoryPodiumEntry = entry;
  if (entry.warmedScenes.has(arenaScene)) return;
  configureVictoryPresentation(entry.presentation, victoryPodiumPrewarmResult().ranked);
  const restore = beginVictoryPodiumWarmup(entry, arenaScene);
  try {
    renderer.compile(arenaScene, camera);
    renderVictoryPodiumWarmup(arenaScene);
    entry.warmedScenes.add(arenaScene);
  } finally {
    restore();
  }
}

async function prewarmVictoryPodiumAsync() {
  const arenaScene = G.scene;
  const entry = createVictoryPodiumPrewarm();
  G.victoryPodiumEntry = entry;
  if (entry.warmedScenes.has(arenaScene)) return;
  if (entry.promise && entry.promiseScene === arenaScene) {
    await entry.promise;
    return;
  }
  configureVictoryPresentation(entry.presentation, victoryPodiumPrewarmResult().ranked);
  const restore = beginVictoryPodiumWarmup(entry, arenaScene);
  entry.promiseScene = arenaScene;
  entry.promise = (async () => {
    if (typeof renderer.compileAsync === 'function') {
      await renderer.compileAsync(arenaScene, camera);
    } else {
      renderer.compile(arenaScene, camera);
    }
    renderVictoryPodiumWarmup(arenaScene);
    entry.warmedScenes.add(arenaScene);
  })();
  try {
    await entry.promise;
  } finally {
    restore();
    entry.promise = null;
    entry.promiseScene = null;
  }
}

function resetHighScoreForm() {
  const form = document.getElementById('highscoreform');
  const input = document.getElementById('highscorename');
  const button = document.getElementById('highscoresubmit');
  setStyle(form, 'display', 'none');
  setText(document.getElementById('highscorestatus'), '');
  if (input) input.disabled = false;
  if (button) {
    button.disabled = false;
    setText(button, 'SUBMIT SCORE');
  }
}

function highScoreCandidate() {
  if (!G?.mapDef?.id || !G.player) return null;
  return {
    name: '',
    score: Math.max(0, Math.round(G.player.score || 0)),
    map: G.mapDef.id,
    gameType: G.mode === 'tdm' ? 'tdm' : 'ffa',
    playType: G.multiplayer || G.multiplayerHost ? 'multiplayer' : 'single',
    awards: { ...(G.player.awards || {}) },
  };
}

async function prepareHighScoreSubmission() {
  resetHighScoreForm();
  const candidate = highScoreCandidate();
  if (!candidate) return;
  G.highScoreCandidate = candidate;
  try {
    const response = await fetch(`/api/leaderboard?score=${encodeURIComponent(candidate.score)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Qualification request failed (${response.status})`);
    const data = await response.json();
    if (!G?.over || G.highScoreCandidate !== candidate || !data.qualifies) return;
    const input = document.getElementById('highscorename');
    let savedName = candidate.playType === 'multiplayer' ? multiplayer.name : '';
    try { savedName = localStorage.getItem('nerf-arena-champion-name') || savedName; } catch { /* ignore */ }
    if (input) input.value = savedName.slice(0, 18);
    setText(document.getElementById('highscorestatus'), `YOUR ${candidate.score.toLocaleString()} POINTS QUALIFY FOR THE TOP 100`);
    setStyle(document.getElementById('highscoreform'), 'display', 'flex');
  } catch (err) {
    console.warn('Could not check Hall of Fame qualification:', err);
  }
}

async function submitHighScore(event) {
  event.preventDefault();
  event.stopPropagation();
  const candidate = G?.highScoreCandidate;
  const input = document.getElementById('highscorename');
  const button = document.getElementById('highscoresubmit');
  const status = document.getElementById('highscorestatus');
  const name = String(input?.value || '').trim();
  if (!candidate || !name) {
    setText(status, 'ENTER YOUR NAME TO CLAIM YOUR PLACE');
    input?.focus();
    return;
  }
  if (input) input.disabled = true;
  if (button) button.disabled = true;
  setText(status, 'INSCRIBING YOUR NAME IN GOLD…');
  try {
    const response = await fetch('/api/leaderboard', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...candidate, name }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not submit high score');
    try { localStorage.setItem('nerf-arena-champion-name', name.slice(0, 18)); } catch { /* ignore */ }
    candidate.submitted = true;
    setText(status, `IMMORTALIZED AT #${data.rank} IN THE HALL OF FAME`);
    setText(button, 'ENTERED');
    sfx('powerup');
  } catch (err) {
    if (input) input.disabled = false;
    if (button) button.disabled = false;
    setText(status, String(err.message || 'COULD NOT SUBMIT').toUpperCase());
  }
}

function applyVictoryResultUI(result) {
  setText(document.getElementById('endtitle'), result.title);
  setStyle(document.getElementById('endtitle'), 'color', result.color);
  setText(document.getElementById('endstats'), result.stats);
  setText(document.getElementById('endawards'), awardsLine(G.player.awards));
}

function revealVictoryScreen(game) {
  if (G !== game || !game.podiumTransitioning) return;
  const transition = game.victoryTransition;
  applyVictoryResultUI(transition.result);
  setStyle(endScreen, 'display', 'flex');
  requestAnimationFrame(() => {
    if (G !== game || !game.podiumTransitioning) return;
    endScreen?.classList.add('visible');
    matchTransition?.classList.add('leaving');
  });
  setTimeout(() => {
    if (G !== game) return;
    matchTransition?.classList.remove('active', 'leaving', 'switching');
  }, 420);
  if (!transition.highScorePrepared) {
    transition.highScorePrepared = true;
    prepareHighScoreSubmission();
  }
  document.exitPointerLock?.();
}

function finishVictoryPodiumSetup(game) {
  if (G !== game || !game.podiumTransitioning || game.scene?.userData?.end) return;
  const oldScene = game.scene;
  for (const marker of dmgMarkerPool) destroyDmgMarker(marker, oldScene);
  dmgMarkers = [];
  dmgMarkerPool = [];
  game.projectiles.clear();
  game.pickups.clear();
  game.fxPool.clear();
  camera.remove(game.player.viewmodel);
  camera.remove(game.player.dualBlasterViewmodel);
  camera.remove(game.player.grappleViewmodel);
  camera.remove(game.player.horseViewmodel);
  camera.remove(game.player.muzzleFlash);
  camera.remove(game.player.leftMuzzleFlash);
  for (const ch of game.characters) {
    if (!ch.isPlayer && ch.mesh) ch.mesh.visible = false;
  }

  const cached = game.victoryPodiumEntry || victoryPodiumPrewarms.get(victoryPodiumPrewarmKey());
  const presentation = cached
    ? configureVictoryPresentation(cached.presentation, game.victoryTransition.result.ranked)
    : buildVictoryPresentation(game.victoryTransition.result);
  if (G !== game || !game.podiumTransitioning) return;
  presentation.end.cameraStart.copy(camera.position);
  presentation.end.cameraStartQuaternion.copy(camera.quaternion);
  presentation.end.cameraStartFov = camera.fov;
  game.scene.userData.end = presentation.end;
  presentation.stage.removeFromParent();
  game.scene.add(presentation.stage);
  game.podiumPresentation = presentation;
  renderPass.scene = game.scene;
  game.victoryTransition.built = true;
  matchTransition?.classList.add('switching');
  // The original podium cuts straight to this composition. Keep that exact
  // camera instead of flying through unvisited parts of a large arena and
  // lazily compiling whatever the travel path happens to expose.
  camera.position.copy(presentation.end.cameraTarget);
  camera.quaternion.copy(presentation.end.cameraTargetQuaternion);
  camera.fov = presentation.end.cameraTargetFov;
  camera.near = 0.1;
  camera.far = 900;
  camera.updateProjectionMatrix();
}

function showVictoryPodium(result) {
  if (!G) return;
  if (G.multiplayer || G.multiplayerHost) G.mpPodiumStartedAt ||= performance.now();
  if (G.podiumTransitioning || G.scene?.userData?.end) {
    if (G.victoryTransition) {
      G.victoryTransition.result = result;
      const end = G.scene?.userData?.end;
      if (end && G.podiumPresentation && Array.isArray(result.ranked)) {
        end.avatars = populateVictoryWinners(G.podiumPresentation, result.ranked, false);
      }
      if (end?.screenRevealed) applyVictoryResultUI(result);
    }
    return;
  }

  const game = G;
  clearMatchDrowningState(game);
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
  game.over = true;
  game.podiumTransitioning = true;
  game.showBoard = false;
  game.victoryTransition = {
    result,
    t: 0,
    built: false,
    highScorePrepared: false,
    cameraStart: camera.position.clone(),
    cameraStartQuaternion: camera.quaternion.clone(),
    cameraStartFov: camera.fov,
    forward,
  };
  setPauseScoreboardLayer(false);
  hud.show(false);
  hud.els.hud.classList.add('endboard');
  setStyle(hud.els.board, 'display', 'none');
  hud.showRespawn(false);
  setStyle(clickcatch, 'display', 'none');
  setStyle(quitBtn, 'display', 'none');
  setStyle(volumeControl, 'display', 'none');
  setStyle(document.getElementById('scores'), 'display', 'none');
  clearVictoryPresentationUI();
  matchTransition?.classList.add('active');
  sfx('powerup');

  // Return to the browser first so the final action frame and the lightweight
  // letterbox can paint. Build the podium on the following frame instead of
  // making the clock-expiry tick do every piece of end-state work at once.
  requestAnimationFrame(() => requestAnimationFrame(() => finishVictoryPodiumSetup(game)));
}

function updateVictoryPodium(dt) {
  const end = G.scene?.userData?.end;
  const transition = G.victoryTransition;
  if (!end) {
    if (!transition) return;
    transition.t += dt;
    const duration = reducedMotion ? 0.01 : 0.28;
    const p = Math.min(1, transition.t / duration);
    const eased = 1 - (1 - p) ** 3;
    camera.position.copy(transition.cameraStart)
      .addScaledVector(transition.forward, eased * 0.34);
    camera.position.y += eased * 0.08;
    camera.quaternion.copy(transition.cameraStartQuaternion);
    return;
  }
  end.t += dt;
  const t = end.t;
  setStyle(hud.els.board, 'top', '');
  setStyle(hud.els.board, 'zIndex', '');
  setStyle(hud.els.board, 'background', '');
  setStyle(hud.els.board, 'display', G.showBoard ? 'block' : 'none');
  if (G.showBoard) hud.renderBoard({ characters: G.characters, scores: G.scores, mode: G.mode });
  const anchor = end.anchor || new THREE.Vector3();
  camera.position.copy(anchor).add(new THREE.Vector3(
    Math.sin(t * 0.28) * 0.65,
    4.15 + Math.sin(t * 0.7) * 0.08,
    11.5 + Math.cos(t * 0.22) * 0.35,
  ));
  camera.lookAt(end.lookAt);
  if (!end.screenRevealed && t >= (reducedMotion ? 0.01 : 0.38)) {
    end.screenRevealed = true;
    revealVictoryScreen(G);
  }
  for (const avatar of end.avatars) {
    const cycle = (t * avatar.hopSpeed + avatar.phase) % 1;
    const lift = Math.sin(cycle * Math.PI) ** 0.62;
    const landing = Math.max(0, 1 - Math.min(cycle, 1 - cycle) / 0.08);
    const squash = landing * (1 - Math.min(1, lift * 8));
    const s = avatar.baseScale;
    avatar.group.position.y = avatar.baseY + lift * avatar.hopHeight;
    avatar.group.rotation.y = avatar.baseRotY + Math.sin(t * 5.2 + avatar.phase * 8) * 0.08;
    avatar.group.rotation.z = Math.sin(t * 6.4 + avatar.phase * 9) * 0.035;
    avatar.group.scale.set(s * (1 + squash * 0.05), s * (1 - squash * 0.08), s * (1 + squash * 0.05));
  }
  end.confetti.rotation.y += dt * 0.12;
  const positions = end.confetti.geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    let y = positions.getY(i) - dt * (0.42 + (i % 5) * 0.035);
    if (y < 1.4) y = 7.1 + (i % 19) * 0.035;
    positions.setY(i, y);
  }
  positions.needsUpdate = true;
}

/* ---------------- damage & kills ---------------- */
// Floating damage numbers above whoever YOU hit. Rapid hits on the same
// target within a beat accumulate into one growing number. Olympus can have
// fifteen targets, so keep one reusable marker per possible opponent instead
// of allocating and destroying a canvas texture on the impact frame.
const DAMAGE_MARKER_POOL_SIZE = 16;
let dmgMarkers = [];
let dmgMarkerPool = [];

function createDmgMarker(scene) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false, depthTest: false,
  }));
  sprite.visible = false;
  sprite.renderOrder = 1000;
  sprite.frustumCulled = false;
  scene.add(sprite);
  return {
    target: null,
    amount: 0,
    age: 0,
    active: false,
    sprite,
    tex,
    canvas,
    rise: new THREE.Vector3(0, 1, 0),
  };
}

function initializeDmgMarkerPool(scene = G?.scene) {
  if (!scene) return;
  if (dmgMarkerPool.some(marker => marker.sprite.parent !== scene)) {
    for (const marker of dmgMarkerPool) destroyDmgMarker(marker, marker.sprite.parent);
    dmgMarkerPool = [];
    dmgMarkers = [];
  }
  while (dmgMarkerPool.length < DAMAGE_MARKER_POOL_SIZE) {
    dmgMarkerPool.push(createDmgMarker(scene));
  }
}

function acquireDmgMarker(scene = G?.scene) {
  initializeDmgMarkerPool(scene);
  let marker = dmgMarkerPool.find(candidate => !candidate.active);
  if (!marker) {
    marker = dmgMarkers.reduce((oldest, candidate) =>
      !oldest || candidate.age > oldest.age ? candidate : oldest, null);
    const index = dmgMarkers.indexOf(marker);
    if (index >= 0) dmgMarkers.splice(index, 1);
  }
  marker.active = true;
  marker.sprite.visible = true;
  marker.sprite.material.opacity = 1;
  return marker;
}

function spawnDmgMarker(target, amount) {
  const recent = dmgMarkers.find(m => m.target === target && m.age < 0.4);
  if (recent) {
    recent.amount += amount;
    recent.age = 0;
    drawDmg(recent);
    return;
  }
  const m = acquireDmgMarker(G.scene);
  const visualScale = G.world.characterVisualScale?.(target) || 1;
  const rise = target.up?.clone?.() || new THREE.Vector3(0, 1, 0);
  if (rise.lengthSq() < 1e-6) rise.set(0, 1, 0);
  else rise.normalize();
  m.target = target;
  m.amount = amount;
  m.age = 0;
  m.sprite.scale.set(2 * visualScale, 2 * visualScale, 1);
  m.sprite.position.copy(target.pos).addScaledVector(rise, 2.5 * visualScale);
  m.rise.copy(rise).multiplyScalar(visualScale);
  drawDmg(m);
  dmgMarkers.push(m);
}
// NAB-style blast marker: purple number on a white-and-gold starburst
function drawDmg(m) {
  const g = m.canvas.getContext('2d');
  g.clearRect(0, 0, 128, 128);
  const star = (rot, scale, fill, stroke) => {
    g.beginPath();
    for (let i = 0; i < 20; i++) {
      const a = i * Math.PI / 10 - Math.PI / 2 + rot;
      const rad = (i % 2 ? 30 : 61) * scale;
      g[i ? 'lineTo' : 'moveTo'](64 + Math.cos(a) * rad, 64 + Math.sin(a) * rad);
    }
    g.closePath();
    g.fillStyle = fill; g.fill();
    if (stroke) { g.lineWidth = 3; g.strokeStyle = stroke; g.stroke(); }
  };
  star(0, 1, '#ffd23c', '#e8b020');
  star(0.16, 0.74, '#fffbe8', null);
  const txt = String(Math.round(m.amount));
  g.font = `bold ${txt.length > 2 ? 40 : 48}px "Arial Black", Arial`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 8; g.strokeStyle = '#3d1070';
  g.strokeText(txt, 64, 66);
  g.fillStyle = m.amount >= 60 ? '#c02fd8' : '#8a2fc8';
  g.fillText(txt, 64, 66);
  m.tex.needsUpdate = true;
}
function updateDmgMarkers(dt) {
  for (let i = dmgMarkers.length - 1; i >= 0; i--) {
    const m = dmgMarkers[i];
    m.age += dt;
    m.sprite.position.addScaledVector(m.rise, dt * 1.1);
    m.sprite.material.opacity = Math.min(1, 2.5 * (1 - m.age / DAMAGE_MARKER_LIFETIME));
    if (m.age > DAMAGE_MARKER_LIFETIME) {
      releaseDmgMarker(m);
      dmgMarkers.splice(i, 1);
    }
  }
}

function releaseDmgMarker(marker) {
  if (!marker) return;
  marker.active = false;
  marker.target = null;
  marker.amount = 0;
  marker.age = 0;
  marker.sprite.visible = false;
  marker.sprite.material.opacity = 0;
}

function destroyDmgMarker(marker, scene = G?.scene) {
  if (!marker) return;
  scene?.remove(marker.sprite);
  marker.sprite?.material?.dispose();
  marker.tex?.dispose();
}

function ensureAwards(ch) {
  ch.awards ||= {};
  return ch.awards;
}

function awardKey(prefix, count) {
  return `${prefix}${Math.min(MAX_KILL_AWARD, Math.max(2, count))}`;
}

function incrementAward(ch, key, title, sub, color = '#ffd23c') {
  const awards = ensureAwards(ch);
  awards[key] = (awards[key] || 0) + 1;
  hud.awardFeed(ch, title, color);
  if (ch.isPlayer) hud.award(title, sub, color);
  if (G.multiplayerHost) {
    queueMultiplayerEvent({
      type: 'award',
      playerId: characterNetworkId(ch),
      key,
      title,
      sub,
      color,
    });
  }
}

function recordHeadshotAwards(attacker, target, ctx = {}) {
  incrementAward(attacker, 'headshot', 'HEADSHOT', 'Hyperstrike precision hit', '#ff3050');

  const shotGroup = ctx.shotGroup;
  if (!shotGroup || shotGroup.owner !== attacker) return;
  shotGroup.headshotTargets ||= new Set();
  const previousCount = shotGroup.headshotTargets.size;
  shotGroup.headshotTargets.add(target);
  if (shotGroup.headshotTargets.size === previousCount) return;

  const count = Math.min(MAX_KILL_AWARD, shotGroup.headshotTargets.size);
  if (count < 2) return;
  incrementAward(
    attacker,
    awardKey('headshot', count),
    HEADSHOT_AWARD_LABELS[count] || `${count}X HEADSHOT`,
    `${count} enemies with one dart`,
    '#ff3050',
  );
}

function recordKillAwards(attacker, target, ctx = {}) {
  if (!attacker || attacker === target) return;
  const now = performance.now() / 1000;
  const chain = attacker.killChain && attacker.killChain.expiresAt >= now
    ? attacker.killChain
    : { count: 0, expiresAt: 0 };
  chain.count = Math.min(MAX_KILL_AWARD, chain.count + 1);
  chain.expiresAt = now + MULTI_KILL_WINDOW;
  attacker.killChain = chain;
  if (chain.count >= 2) {
    const label = KILL_AWARD_LABELS[chain.count] || `${chain.count}X KILL`;
    incrementAward(attacker, awardKey('multi', chain.count), label, `${chain.count} kills in a burst`, attacker.color || '#ffd23c');
  }

  const shotGroup = ctx.shotGroup;
  if (shotGroup && shotGroup.owner === attacker) {
    shotGroup.kills = Math.min(MAX_KILL_AWARD, (shotGroup.kills || 0) + 1);
    if (shotGroup.kills >= 2) {
      incrementAward(
        attacker,
        awardKey('oneShot', shotGroup.kills),
        `ONE SHOT, ${shotGroup.kills} KILLS`,
        'same trigger pull',
        '#7fd0ff',
      );
    }
  }
}

function awardsLine(awards = {}) {
  const labels = [
    ['headshot', 'Headshot'],
    ['headshot2', 'Double Headshot'], ['headshot3', 'Triple Headshot'],
    ['headshot4', 'Quad Headshot'], ['headshot5', 'Penta Headshot'],
    ['headshot6', 'Hexa Headshot'], ['headshot7', 'Septuple Headshot'],
    ['multi2', 'Double Kill'], ['multi3', 'Triple Kill'], ['multi4', 'Quad Kill'],
    ['multi5', 'Penta Kill'], ['multi6', 'Hexa Kill'], ['multi7', 'Septuple Kill'],
    ['oneShot2', 'One Shot, Two Kills'], ['oneShot3', 'One Shot, Three Kills'],
    ['oneShot4', 'One Shot, Four Kills'], ['oneShot5', 'One Shot, Five Kills'],
    ['oneShot6', 'One Shot, Six Kills'], ['oneShot7', 'One Shot, Seven Kills'],
  ];
  const parts = labels.filter(([key]) => awards[key]).map(([key, label]) => `${label} x${awards[key]}`);
  return parts.length ? `Awards: ${parts.join(' · ')}` : 'Awards: none';
}

function applyDamage(target, dmg, attacker, ctx = {}) {
  if (!target.alive || G.over) return;
  const rawDmg = dmg;
  if (attacker.isPlayer && attacker !== target) spawnDmgMarker(target, dmg);
  const resolved = resolveShieldedDamage(target.hp, target.shield, dmg, {
    bypassShield: !!ctx.bypassShield,
  });
  target.shield = resolved.shield;
  target.hp = resolved.hp;
  target.lastAttacker = attacker;  // getting shot reveals the shooter to bots
  target.alertTimer = 4;
  if (ctx.headshot && attacker && attacker !== target) {
    recordHeadshotAwards(attacker, target, ctx);
  }
  if (G.multiplayerHost && attacker && attacker !== target) {
    queueMultiplayerEvent({
      type: 'damage',
      attackerId: characterNetworkId(attacker),
      targetId: characterNetworkId(target),
      amount: rawDmg,
      headshot: !!ctx.headshot,
    });
  }
  if (attacker.isPlayer) { hud.hitmarker(); sfx('hit'); }
  if (target.isPlayer) {
    hud.damageFlash();
    if (!ctx.silentImpact) sfx('hurt');
  }

  if (target.hp <= 0) {
    target.jetpack = null;
    target.grapple = false;
    if (target.grappleViewmodel) target.grappleViewmodel.visible = false;
    target.dualBlaster = false;
    target.syncDualBlasterViewmodel?.();
    if (target.isPlayer) target.detachGrapple?.();
    else setRemoteGrappleState(target, null);
    target.deaths++;
    attacker.kills++;
    recordKillAwards(attacker, target, ctx);
    dropPoints(target); // the points fall with the victim — go collect them
    for (const c of G.characters) {
      if (c.isPlayer || !c.noticeDrop || !c.alive) continue;
      // the killer always races for it; idle bystanders contest close drops
      if (c === attacker || (!c.target && c.pos.distanceTo(target.pos) < 18)) c.noticeDrop(target.pos);
    }
    if (attacker === GATOR || attacker === SHARK) hud.chompFeed(target);
    else hud.killfeed(attacker, target);
    G.fxPool.spawnPuff(new THREE.Vector3(target.pos.x, target.pos.y + 1, target.pos.z),
      target.team === 'blue' ? 0x5cb3ff : 0xff5c5c, 2);

    dropWeapon(target);
    dropPowerup(target);
    if (target.isPlayer) {
      target.alive = false;
      sfx('death');
      const weaponName = eliminationWeaponName(attacker, ctx);
      const environmentText = weaponName === 'ENVIRONMENT'
        ? environmentalEliminationText(characterNetworkId(attacker), attacker.name)
        : null;
      hud.showRespawn(true, RESPAWN_TIME, attacker.name, weaponName, environmentText);
    } else {
      target.die();
      sfx('death', target.pos);
    }
    if (attacker.isPlayer) sfx('kill');
    if (G.multiplayerHost && attacker) {
      queueMultiplayerEvent({
        type: 'kill',
        killerId: characterNetworkId(attacker),
        victimId: characterNetworkId(target),
        weapon: ctx.shotGroup?.weaponId || 'environment',
      });
    }
    G.respawnTimers.set(target, RESPAWN_TIME);
    checkEnd();
  }
}

// A point orb falls where the victim died — anyone can grab (or steal) it.
// Value scales with the victim's current placing: fragging the leader pays.
function dropPoints(victim) {
  if (victim.pos.y < G.world.killY + 10) return; // lost to the void
  const greater = G.characters.filter(c => c.score > victim.score).length;
  const amount = victim.score === 0 ? 250
    : greater === 0 ? 1000 : greater === 1 ? 750 : greater === 2 ? 500 : 250;
  G.pickups.addDrop({
    id: nextDropId('points'),
    kind: 'points',
    amount,
    pos: victim.pos.clone(),
    up: (victim.up || new THREE.Vector3(0, 1, 0)).clone(),
  });
}

// The victim's active weapon (with its remaining ammo) falls where they died.
function dropWeapon(ch) {
  if (!ch.ammo || ch.weapon === 'blaster' || !(ch.ammo[ch.weapon] > 0)) return;
  if (ch.pos.y < G.world.killY + 10) return; // falling into the void takes it with you
  G.pickups.addDrop({
    id: nextDropId('drop'), kind: 'drop', weapon: ch.weapon, amount: ch.ammo[ch.weapon],
    pos: ch.pos.clone(),
    up: (ch.up || new THREE.Vector3(0, 1, 0)).clone(),
  });
}

// Active gold/silver falls with the victim, preserving only its unused time.
function dropPowerup(ch) {
  const kind = ch.powerup?.kind;
  const timeLeft = Math.max(0, Math.min(30, Number(ch.powerup?.timeLeft) || 0));
  if ((kind !== 'gold' && kind !== 'silver') || timeLeft <= 0) return;
  if (ch.pos.y < G.world.killY + 10) return; // falling into the void takes it with you
  G.pickups.addDrop({
    id: nextDropId(kind), kind, timeLeft,
    pos: ch.pos.clone(),
    up: (ch.up || new THREE.Vector3(0, 1, 0)).clone(),
  });
}

function nextDropId(kind) {
  G.dropSeq = (G.dropSeq || 0) + 1;
  return `${multiplayer.lobbyId || 'local'}:${kind}:${G.dropSeq}`;
}

function checkEnd() {
  if (G.over) return;
  if (G.timeLeft > 0) return; // matches run the full clock
  let title, color, stats;
  const playerStats = `You: ${G.player.kills} kills / ${G.player.deaths} deaths`;
  const ranked = rankedCharacters();
  if (G.mode === 'tdm') {
    const { blue, red } = G.scores;
    title = blue === red ? 'DRAW!' : (blue > red ? 'BLUE TEAM WINS!' : 'RED TEAM WINS!');
    color = blue === red ? '#ffd23c' : (blue > red ? '#5cb3ff' : '#ff5c5c');
    const top = ranked[0];
    stats = `BLUE ${blue} - ${red} RED · MVP: ${top.name} ${top.score} · ${playerStats}`;
  } else {
    const leader = ranked[0];
    title = leader.isPlayer ? 'YOU WIN!' : `${leader.name.toUpperCase()} WINS!`;
    color = leader.color;
    const rank = ranked.indexOf(G.player) + 1;
    stats = `Winner: ${leader.name} with ${leader.score} · You placed #${rank} with ${G.player.score} · ${playerStats}`;
  }
  showVictoryPodium({ ranked, title, color, stats });
}

/* ---------------- pickups ---------------- */
function onPickup(ch, def) {
  ch.weapons ||= { blaster: true };
  ch.ammo ||= { blaster: Infinity };
  ch.damageMult ??= 1;
  ch.shield ??= 0;
  ch.score ??= 0;
  const announce = (t, c) => { if (ch.isPlayer) { hud.message(t, c); } };
  switch (def.kind) {
    case 'weapon':
    case 'ammo':
    case 'drop': {
      const w = WEAPONS[def.weapon];
      const cur = ch.ammo[def.weapon] || 0;
      const cap = w.pickupAmmo * 3;
      if (def.kind === 'ammo' && !ch.weapons[def.weapon]) return false; // need the gun first
      if (def.kind === 'ammo' && cur >= cap) return false; // full — leave it
      const gain = def.kind === 'drop' ? def.amount : w.pickupAmmo;
      ch.ammo[def.weapon] = Math.min(cap, cur + gain);
      if (def.kind !== 'ammo') ch.weapons[def.weapon] = true; // ammo alone doesn't grant the gun
      if (ch.isPlayer) {
        sfx('pickup');
        announce(def.kind === 'ammo' ? `${w.name} AMMO` : `${w.name}!`, '#7fd0ff');
        if (def.kind !== 'ammo' && ch.weapon === 'blaster' && !ch.dualBlaster) {
          ch.switchWeapon(def.weapon);
        }
      } else if (ch.remoteHuman && def.kind !== 'ammo' && ch.weapon === 'blaster' && !ch.dualBlaster) {
        ch.weapon = def.weapon;
        ch.cancelWeaponWarmup?.();
      }
      return true;
    }
    case 'health':
      if (ch.hp >= 100) return false;
      ch.hp = Math.min(100, ch.hp + 30);
      if (ch.isPlayer) { sfx('pickup'); announce('+30 HEALTH', '#6f6'); }
      return true;
    case 'shield':
      if (ch.shield >= 75) return false;
      ch.shield = 75;
      if (ch.isPlayer) { sfx('shieldup'); announce('+75 SHIELD', '#7fd0ff'); }
      return true;
    case 'speed':
      ch.speedMult = 2;
      ch.speedTime = 15;
      if (ch.isPlayer) { sfx('powerup'); announce('⚡ SPEED BOOST — 2× FOR 15s ⚡', '#6dff6d'); }
      return true;
    case 'djump':
      if (!ch.isPlayer) return false;   // bots don't air-jump — leave it for players
      ch.djumpTime = 20;
      sfx('powerup');
      announce('⇈ DOUBLE JUMP — 20s ⇈', '#30e0ff');
      return true;
    case 'jetpack':
      if (ch.jetpack) return false;
      ch.jetpack = createJetpack();
      if (ch.isPlayer) {
        sfx('powerup');
        announce('JETPACK EQUIPPED — HOLD JUMP TO FLY', '#43cfff');
      }
      return true;
    case 'grapple':
      if (ch.grapple) return false;
      ch.grapple = true;
      if (ch.grappleViewmodel) ch.grappleViewmodel.visible = true;
      if (ch.isPlayer) {
        sfx('powerup');
        announce('GRAPPLE EQUIPPED — SHIFT / RIGHT CLICK', '#a8ff70');
      }
      return true;
    case 'dual-blaster':
      if (ch.dualBlaster) return false;
      ch.dualBlaster = true;
      ch._dualBlasterNextLeft = false;
      ch.syncDualBlasterViewmodel?.();
      ch.syncGunModel?.();
      ch.setSkin?.(ch.powerup?.kind || null);
      if (ch.isPlayer) {
        sfx('powerup');
        announce('DUAL SECRET SHOTS — ALTERNATING FIRE', '#ffb35a');
      }
      return true;
    case 'points':
      {
        const amount = Number(def.amount);
        // Invalid point data must never poison a player's score with NaN.
        // Authored pickups are rejected while building the map; this second
        // guard also covers malformed temporary or multiplayer drops.
        if (!Number.isFinite(amount) || amount <= 0) return false;
        ch.score += amount;
        if (G.mode === 'tdm') G.scores[ch.team] += amount;
        if (ch.isPlayer) { sfx('coin'); announce(`+${amount} PTS!`, '#ffd23c'); }
      }
      checkEnd();
      return true;
    case 'star':
      ch.score += 500;
      if (G.mode === 'tdm') G.scores[ch.team] += 500;
      if (ch.isPlayer) sfx('star');
      hud.message(ch.isPlayer ? '★ SECRET STAR! +500 PTS ★'
        : `${ch.name} found a star! +500`,
        ch.color || '#ffd23c');
      checkEnd();
      return true;
    case 'gold':
    case 'silver': {
      const gold = def.kind === 'gold';
      const timeLeft = def.timeLeft == null
        ? 30
        : Math.max(0, Math.min(30, Number(def.timeLeft) || 0));
      if (timeLeft <= 0) return false;
      ch.damageMult = gold ? 3 : 2;
      ch.powerup = { kind: def.kind, timeLeft };
      if (ch.isPlayer) { sfx('powerup'); ch.setSkin(def.kind); }
      hud.message(
        `${ch.isPlayer ? 'YOU HAVE' : ch.name + ' has'} the ${gold ? 'GOLD' : 'SILVER'} NERF! ${gold ? '3×' : '2×'} damage!`,
        gold ? '#ffd23c' : '#e8e8f0');
      return true;
    }
  }
  return false;
}

/* ---------------- input ---------------- */
const clickcatch = document.getElementById('clickcatch');
const volumeControl = document.getElementById('pausevolume');
const volumeSlider = document.getElementById('volumeslider');
const volumeValue = document.getElementById('volumevalue');
const musicSlider = document.getElementById('musicslider');
const musicValue = document.getElementById('musicvalue');
const effectsSlider = document.getElementById('effectsslider');
const effectsValue = document.getElementById('effectsvalue');
const graphicsButtons = [...document.querySelectorAll('[data-graphics]')];
const graphicsDetail = document.getElementById('graphicsdetail');
const highScoreForm = document.getElementById('highscoreform');

function autoGraphicsCalibrationOpen() {
  if (autoGraphicsTestStage === 'game') return false;
  if (!G || G.atrium) return autoGraphicsTestStage === null;
  const matchDuration = G.world?.matchTime || MATCH_TIME;
  return matchDuration - G.timeLeft < AUTO_MATCH_CALIBRATION_SECONDS;
}

function updateGraphicsUI() {
  const tier = presentationTier();
  const selectedMode = pendingGraphicsMode || graphicsMode;
  for (const button of graphicsButtons) {
    const active = button.dataset.graphics === selectedMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  if (!graphicsDetail) return;
  if (pendingGraphicsMode) {
    const label = pendingGraphicsMode === 'auto'
      ? 'Auto'
      : GRAPHICS_PRESETS[pendingGraphicsMode].label;
    setText(graphicsDetail, `${label} selected · applies during the next arena load`);
    return;
  }
  const tierLabel = tier === 'standard' ? 'Medium' : tier[0].toUpperCase() + tier.slice(1);
  setText(graphicsDetail, graphicsMode === 'auto'
    ? (autoGraphicsTestStage === 'game'
      ? `Auto · tested ${tierLabel} · saved for future launches`
      : (G && !G.atrium
        ? `Auto · final game test ${tierLabel} · saves after ${AUTO_MATCH_CALIBRATION_SECONDS} seconds`
        : (autoGraphicsTestStage === 'atrium'
          ? `Auto · Atrium tested ${tierLabel} · game test next`
          : `Auto · testing ${tierLabel} in Atrium · targeting ${TARGET_FPS} FPS`)))
    : `Locked ${GRAPHICS_PRESETS[graphicsMode].label} · automatic scaling disabled`);
}

function applyPendingGraphicsMode() {
  if (!pendingGraphicsMode) return false;
  graphicsMode = pendingGraphicsMode;
  pendingGraphicsMode = null;
  return true;
}

function setGraphicsMode(mode, announce = true, persist = true, deferInMatch = true) {
  if (!validGraphicsModes.has(mode)) return;
  // Manual choices are a separate override. Returning to Auto clears only that
  // override and reuses the most recently tested automatic scale.
  if (persist) {
    try {
      if (mode === 'auto') localStorage.removeItem(graphicsOverrideStorageKey);
      else localStorage.setItem(graphicsOverrideStorageKey, mode);
    } catch { /* localStorage may be unavailable */ }
  }
  if (deferInMatch && G && !G.atrium) {
    pendingGraphicsMode = mode;
    updateGraphicsUI();
    if (announce) {
      const label = mode === 'auto' ? 'AUTO' : GRAPHICS_PRESETS[mode].label.toUpperCase();
      hud.message(`GRAPHICS: ${label} · NEXT MATCH`, mode === 'low' ? '#7fd0ff' : '#ffd23c');
    }
    return;
  }
  pendingGraphicsMode = null;
  graphicsMode = mode;
  resetAdaptiveRenderScale({ preserveDetection: true });
  if (announce && G && !G.atrium) {
    const label = mode === 'auto' ? `AUTO · ${presentationTier().toUpperCase()}` : GRAPHICS_PRESETS[mode].label.toUpperCase();
    hud.message(`GRAPHICS: ${label}`, mode === 'low' ? '#7fd0ff' : '#ffd23c');
  }
}

setGameVolume(gameVolume, false);
setMusicMix(musicMix, false);
setEffectsMix(effectsMix, false);
updateGraphicsUI();
updateTrackTitle();

function setPauseScoreboardLayer(on) {
  const board = hud.els.board;
  const parent = on ? clickcatch : hud.els.hud;
  if (board.parentElement !== parent) parent.appendChild(board);
  board.classList.toggle('pause-scoreboard', on);
  if (!on) board.scrollTop = 0;
}

function requestPointerLock() {
  if (usesMobileControls()) return;
  if (!canvas.requestPointerLock) return;
  try {
    const request = canvas.requestPointerLock({ unadjustedMovement: true });
    request?.catch?.(() => canvas.requestPointerLock()?.catch?.(() => {}));
  } catch {
    canvas.requestPointerLock()?.catch?.(() => {});
  }
}

const quitBtn = document.getElementById('quitbtn');

function updatePauseMenuExtras(showPause, multiplayerMatch = !!(G?.multiplayer || G?.multiplayerHost)) {
  setStyle(quitBtn, 'display', showPause ? '' : 'none');
  setStyle(volumeControl, 'display', showPause ? 'block' : 'none');
  setText(quitBtn, multiplayerMatch ? 'EXIT MULTIPLAYER' : 'BACK TO ATRIUM');
  const board = hud.els.board;
  setPauseScoreboardLayer(showPause);
  setStyle(board, 'display', showPause ? 'block' : 'none');
  setStyle(board, 'top', '');
  setStyle(board, 'zIndex', showPause ? 4 : '');
  setStyle(board, 'background', showPause ? 'rgba(10,12,30,.96)' : '');
  if (showPause && G) hud.renderBoard({ characters: G.characters, scores: G.scores, mode: G.mode });
}

async function enterMobileImmersiveMode() {
  if (!usesMobileControls() || isStandaloneApp()) return;
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen();
    }
  } catch { /* iOS browser tabs do not expose fullscreen; the installed app does */ }
  try {
    await screen.orientation?.lock?.('landscape');
  } catch { /* orientation lock support varies by browser */ }
}

function openMobilePause() {
  if (!G || G.over || G.mpConnectionPaused || mobilePauseOpen) return;
  mobilePauseOpen = true;
  mobilePauseOpenedAt = performance.now();
  G.player.firing = false;
  G.player.cancelWeaponWarmup?.();
  G.player.detachGrapple?.();
  G.player.setMoveInput?.(0, 0);
  G.player.keys.Space = false;
  const multiplayerMatch = !!(G.multiplayer || G.multiplayerHost);
  if (!multiplayerMatch) G.paused = true;
  const showPause = !G.atrium && !(multiplayer.overlay && !multiplayer.overlay.hidden) && !multiplayer.isChatOpen();
  setText(document.getElementById('catchtitle'), multiplayerMatch ? 'MENU — TAP TO RESUME' : '⏸ PAUSED — TAP TO RESUME');
  setStyle(clickcatch, 'display', 'flex');
  updatePauseMenuExtras(showPause, multiplayerMatch);
  mobileControls.sync();
}

function resumeMobilePause() {
  if (!G || !mobilePauseOpen || G.mpConnectionPaused) return;
  mobilePauseOpen = false;
  G.paused = false;
  updatePauseMenuExtras(false);
  setStyle(clickcatch, 'display', 'none');
  mobileControls.sync();
}

const mobileControls = new MobileControls({
  root: document.getElementById('mobilecontrols'),
  onMove: (strafe, forward) => G?.player?.setMoveInput?.(strafe, forward),
  onLook: (dx, dy) => {
    if (G && !G.paused && !mobilePauseOpen) G.player.onMouseMove(dx, dy);
  },
  onFire: (pressed) => {
    if (!G) return;
    G.player.firing = !!pressed && !G.paused && !mobilePauseOpen && G.player.alive;
    if (G.player.firing) tryOpenAimedUrlSign();
  },
  onJump: (pressed) => {
    if (!G) return;
    G.player.keys.Space = !!pressed;
    if (pressed && !G.paused && !mobilePauseOpen) G.player.wantJump = true;
  },
  onGrapple: () => {
    if (G && !G.paused && !mobilePauseOpen && G.player.alive) G.player.toggleGrapple();
  },
  onCycleWeapon: () => {
    if (G && !G.paused && !mobilePauseOpen && G.player.alive) G.player.cycleWeapon(1);
  },
  onPause: openMobilePause,
  onEngage: enterMobileImmersiveMode,
  shouldShow: () => !!G && !G.over && !G.paused && !mobilePauseOpen && !mapLoadInProgress &&
    !G.mpConnectionPaused && !(multiplayer.overlay && !multiplayer.overlay.hidden) && !multiplayer.isChatOpen(),
  shouldShowGrapple: () => !!(G?.world?.grappleEnabled && G?.player?.grapple),
});
setupPwaInstall();

document.addEventListener('pointerlockchange', () => {
  if (usesMobileControls()) return;
  const locked = document.pointerLockElement === canvas;
  if (G && !G.over) {
    if (!locked) {
      G.player.firing = false;
      G.player.cancelWeaponWarmup?.();
      G.player.detachGrapple?.();
    }
    const multiplayerMatch = !!(G.multiplayer || G.multiplayerHost);
    const multiplayerPanelOpen = multiplayer.overlay && !multiplayer.overlay.hidden;
    const multiplayerChatOpen = multiplayer.isChatOpen();
    const connectionPaused = !!G.mpConnectionPaused;
    G.paused = connectionPaused ? true : multiplayerMatch ? false : !locked;
    setStyle(clickcatch, 'display',
      (!connectionPaused && (locked || multiplayerPanelOpen || multiplayerChatOpen)) ? 'none' : 'flex');
    if (!connectionPaused) {
      setText(document.getElementById('catchtitle'),
        locked ? '' : (multiplayerMatch ? 'CLICK TO RESUME' : '⏸ PAUSED — CLICK TO RESUME'));
    }
    // pause menu extras (matches only): live scoreboard + quit
    const showPause = !connectionPaused && !locked && !G.atrium &&
      !multiplayerPanelOpen && !multiplayerChatOpen;
    updatePauseMenuExtras(showPause, multiplayerMatch);
  } else {
    updatePauseMenuExtras(false);
    setStyle(clickcatch, 'display', 'none');
  }
});
clickcatch.addEventListener('click', () => {
  warmAudioSamplesInBackground();
  if (G?.atrium) prepareMusic();
  if (G?.mpConnectionPaused) return;
  if (usesMobileControls()) {
    if (performance.now() - mobilePauseOpenedAt < 350) return;
    resumeMobilePause();
    return;
  }
  requestPointerLock();
});
hud.els.board.addEventListener('click', (e) => e.stopPropagation());
hud.els.board.addEventListener('pointerdown', (e) => e.stopPropagation());
volumeControl.addEventListener('click', (e) => e.stopPropagation());
volumeControl.addEventListener('pointerdown', (e) => e.stopPropagation());
volumeSlider.addEventListener('input', () => setGameVolume(Number(volumeSlider.value) / 100));
musicSlider.addEventListener('input', () => setMusicMix(Number(musicSlider.value) / 100));
effectsSlider.addEventListener('input', () => setEffectsMix(Number(effectsSlider.value) / 100));
for (const button of graphicsButtons) {
  button.addEventListener('click', () => setGraphicsMode(button.dataset.graphics));
}
highScoreForm?.addEventListener('submit', submitHighScore);
highScoreForm?.addEventListener('pointerdown', (e) => e.stopPropagation());
quitBtn.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();               // don't let the overlay re-lock the pointer
  e.stopImmediatePropagation();
  mobilePauseOpen = false;
  mobileControls.reset();
  setStyle(quitBtn, 'display', 'none');
  setStyle(volumeControl, 'display', 'none');
  setStyle(clickcatch, 'display', 'none');
  multiplayer.closeOverlay?.();
  setStyle(hud.els.board, 'display', 'none');
  setText(document.getElementById('catchtitle'), 'CLICK TO PLAY');
  const exitingMultiplayer = !!(G?.multiplayer || G?.multiplayerHost);
  if (exitingMultiplayer) multiplayer.leave();
  document.exitPointerLock?.();
  endMatch(true);                    // back to the atrium
});

function popOutOfMultiplayerPortal() {
  clearTimeout(multiplayerVotingTimer);
  openingMultiplayer = false;
  multiplayer.closeOverlay?.();
  setStyle(clickcatch, 'display', gameplayOverlayDisplay());
  setStyle(quitBtn, 'display', 'none');
  setStyle(volumeControl, 'display', 'none');
  setText(document.getElementById('catchtitle'), 'CLICK TO PLAY');
  if (G?.multiplayer || G?.multiplayerHost) {
    endMatch(true);
    document.exitPointerLock?.();
    return;
  }
  if (G?.atrium && G.player) {
    G.player.pos.set(0, 0.1, 18);
    G.player.vel.set(0, 0, 0);
    G.player.update(0, () => {});
    hud.message('LEFT MULTIPLAYER', '#ffd23c');
  }
}

document.addEventListener('mousemove', (e) => {
  if (G && document.pointerLockElement === canvas) {
    G.player.onMouseMove(e.movementX, e.movementY);
  }
});
document.addEventListener('mousedown', (e) => {
  if (!G || document.pointerLockElement !== canvas) return;
  if (e.button === 0) {
    G.player.firing = true;
    // Open atrium URL signs during the click gesture so popups aren't blocked.
    tryOpenAimedUrlSign();
  } else if (e.button === 2 && G.world?.grappleEnabled && G.player.grapple) {
    e.preventDefault();
    G.player.toggleGrapple();
  }
});
document.addEventListener('contextmenu', (e) => {
  if (G?.world?.grappleEnabled && G?.player?.grapple && document.pointerLockElement === canvas) {
    e.preventDefault();
  }
});
document.addEventListener('mouseup', (e) => {
  if (G && e.button === 0) G.player.firing = false;
});
document.addEventListener('wheel', (e) => {
  if (G && document.pointerLockElement === canvas) G.player.cycleWeapon(e.deltaY > 0 ? 1 : -1);
});

function enterFullscreen() {
  if (document.fullscreenElement) return;
  document.documentElement.requestFullscreen?.().catch?.((err) => {
    console.warn('Could not enter fullscreen:', err);
  });
}

document.addEventListener('keydown', (e) => {
  if (!G) return;
  if (multiplayer.isChatOpen()) return;
  if (e.code === 'KeyT' && multiplayer.openChat()) {
    e.preventDefault();
    G.player.firing = false;
    document.exitPointerLock?.();
    return;
  }
  G.player.keys[e.code] = true;
  if ((e.code === 'ShiftLeft' || e.code === 'ShiftRight') && !e.repeat &&
      G.world?.grappleEnabled && G.player.grapple && !G.paused && !mobilePauseOpen && !G.over) {
    G.player.toggleGrapple();
    e.preventDefault();
  }
  if (e.code === 'KeyF' && !e.repeat) { enterFullscreen(); e.preventDefault(); }
  if (e.code === 'Space') { G.player.wantJump = true; e.preventDefault(); }
  if (e.code === 'Tab') { G.showBoard = true; e.preventDefault(); }
  const slot = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9'].indexOf(e.code);
  const mapWeapons = G.world?.availableWeapons || WEAPON_ORDER;
  if (slot >= 0 && slot < mapWeapons.length) G.player.switchWeapon(mapWeapons[slot]);
});
document.addEventListener('keyup', (e) => {
  if (!G) return;
  if (multiplayer.isChatOpen()) return;
  G.player.keys[e.code] = false;
  if (e.code === 'Tab') G.showBoard = false;
});

function cancelMultiplayerMapLoad() {
  if (!multiplayerMapLoadRequest) return;
  multiplayerMapLoadVersion++;
  multiplayerMapLoadRequest = null;
  hideMapLoading();
}

async function startCurrentMultiplayerMatch(
  mapId,
  force = false,
  mode = multiplayer.mode || 'ffa',
  resumeSnapshot = null,
  freshMusic = true,
) {
  clearTimeout(multiplayerVotingTimer);
  setStyle(document.getElementById('endscreen'), 'display', 'none');
  setStyle(clickcatch, 'display', 'none');
  setStyle(quitBtn, 'display', 'none');
  setStyle(volumeControl, 'display', 'none');
  setStyle(hud.els.board, 'display', 'none');
  const map = MAPS.find(m => m.id === mapId) || MAPS[0];
  const endedMultiplayerMatch = !!(G?.over && (G.multiplayer || G.multiplayerHost));
  const shouldHost = multiplayer.shouldHost();
  const needsBuild = shouldHost
    ? force || endedMultiplayerMatch || !G?.multiplayerHost || G.mapDef?.id !== map.id || G.mode !== mode
    : force || endedMultiplayerMatch || !G?.multiplayer || G.mapDef?.id !== map.id || G.mode !== mode;
  if (!needsBuild) {
    if (resumeSnapshot) {
      if (shouldHost) applyHostHandoffSnapshot(resumeSnapshot);
      else applyMultiplayerSnapshot(resumeSnapshot);
    }
    return;
  }

  // Join, phase, host-change, and early snapshot messages can all request the
  // same arena before a cold client has finished its assets. Keep one build in
  // flight and retain the newest authoritative snapshot for when it completes.
  const authorityEpoch = multiplayer.authorityEpoch;
  const role = shouldHost ? 'host' : 'guest';
  const loadKey = [authorityEpoch, multiplayer.slotId, role, map.id, mode].join(':');
  if (multiplayerMapLoadRequest?.key === loadKey) {
    if (resumeSnapshot) multiplayerMapLoadRequest.resumeSnapshot = resumeSnapshot;
    multiplayerMapLoadRequest.freshMusic = multiplayerMapLoadRequest.freshMusic && freshMusic;
    return multiplayerMapLoadRequest.promise;
  }

  const version = ++multiplayerMapLoadVersion;
  const loadingToken = showMapLoading(map);
  const request = {
    key: loadKey,
    version,
    authorityEpoch,
    resumeSnapshot,
    freshMusic,
    promise: null,
  };
  multiplayerMapLoadRequest = request;
  request.promise = (async () => {
    let unsubscribe = () => {};
    let built = false;
    try {
      prioritizeTextureLoading();
      await paintLoadingStage();
      const updateTextureProgress = ({ ready, total }) => {
        const ratio = total ? ready / total : 1;
        setMapLoadingProgress(
          ready >= total ? 20 : Math.floor(ratio * 20),
          ready < total ? `Preparing multiplayer assets (${ready}/${total})` : 'Multiplayer assets ready',
          loadingToken,
        );
      };
      unsubscribe = onTextureLoadProgress(updateTextureProgress);
      // Map/player materials capture whatever is in AI_TEX at construction.
      // Waiting here prevents permanent white fallbacks and keeps normal-map
      // generation from spilling into live multiplayer frames.
      await texturesReady;
      if (version !== multiplayerMapLoadVersion || multiplayerMapLoadRequest !== request) return;
      if (!multiplayer.connected || multiplayer.phase !== 'playing' || multiplayer.mapId !== map.id ||
          (multiplayer.mode || 'ffa') !== mode || multiplayer.shouldHost() !== shouldHost ||
          multiplayer.authorityEpoch !== authorityEpoch) return;

      updateTextureProgress(getTextureLoadProgress());
      await paintLoadingStage();
      if (version !== multiplayerMapLoadVersion || multiplayerMapLoadRequest !== request) return;
      if (shouldHost) {
        startMultiplayerHostMatch(map, mode, request.resumeSnapshot, request.freshMusic);
      } else {
        startMultiplayerMatch(map, mode, request.freshMusic);
        if (request.resumeSnapshot) applyMultiplayerSnapshot(request.resumeSnapshot);
      }
      built = true;
    } catch (err) {
      console.error('Multiplayer arena setup failed:', err);
      hud.message('MULTIPLAYER ARENA FAILED TO LOAD', '#ff5c5c');
    } finally {
      unsubscribe();
      if (multiplayerMapLoadRequest === request) {
        multiplayerMapLoadRequest = null;
        if (!built) hideMapLoading();
      }
    }
  })();
  return request.promise;
}

multiplayer.addEventListener('joined', (e) => {
  if (e.detail.phase === 'playing') {
    const alreadyInThisRound = !!G && !G.over &&
      (G.multiplayer || G.multiplayerHost) &&
      G.mapDef?.id === e.detail.mapId &&
      G.mode === (e.detail.mode || multiplayer.mode || 'ffa');
    const slotChanged = !!G?.player?.id && G.player.id !== e.detail.slotId;
    const roleMismatch = multiplayer.shouldHost() ? !G?.multiplayerHost : !G?.multiplayer;
    startCurrentMultiplayerMatch(
      e.detail.mapId,
      slotChanged || roleMismatch,
      e.detail.mode || multiplayer.mode || 'ffa',
      e.detail.snapshot || null,
      !alreadyInThisRound,
    );
  } else if (G?.multiplayer || G?.multiplayerHost) {
    hud.message('MULTIPLAYER LOBBY REJOINED', '#ffd23c');
    endMatch(true);
  }
});

multiplayer.addEventListener('exit', () => {
  cancelMultiplayerMapLoad();
  popOutOfMultiplayerPortal();
});

multiplayer.addEventListener('phase', (e) => {
  const { phase, mapId, ranked, scores } = e.detail;
  if (phase !== 'playing') cancelMultiplayerMapLoad();
  if (phase === 'playing') {
    startCurrentMultiplayerMatch(mapId, false, e.detail.mode || multiplayer.mode || 'ffa');
  } else if (phase === 'podium' && (G?.multiplayer || G?.multiplayerHost)) {
    clearTimeout(multiplayerVotingTimer);
    G.mpPodiumStartedAt ||= performance.now();
    const currentRanked = ranked?.map(r => {
      const ch = G.characters.find(c => c.id === r.id) || (r.id === multiplayer.slotId ? G.player : null);
      return Object.assign(ch || {}, r);
    }) || rankedCharacters();
    const winner = currentRanked[0];
    const mode = e.detail.mode || G.mode || multiplayer.mode || 'ffa';
    const teamScores = scores || G.scores || { blue: 0, red: 0 };
    const teamTitle = teamScores.blue === teamScores.red ? 'DRAW!'
      : teamScores.blue > teamScores.red ? 'BLUE TEAM WINS!' : 'RED TEAM WINS!';
    showVictoryPodium({
      ranked: currentRanked,
      title: mode === 'tdm' ? teamTitle : (winner ? `${winner.name.toUpperCase()} WINS!` : 'MATCH COMPLETE'),
      color: mode === 'tdm'
        ? (teamScores.blue === teamScores.red ? '#ffd23c' : teamScores.blue > teamScores.red ? '#5cb3ff' : '#ff5c5c')
        : (winner?.color || '#ffd23c'),
      stats: mode === 'tdm'
        ? `BLUE ${teamScores.blue} - ${teamScores.red} RED · Next vote starts automatically`
        : (winner ? `Winner: ${winner.name} with ${winner.score} · Next vote starts automatically` : 'Next vote starts automatically'),
    });
  } else if (phase === 'voting') {
    // The multiplayer panel renders its vote buttons as soon as this phase
    // arrives. Release the cursor at the same boundary instead of waiting for
    // the podium hold/Atrium transition, otherwise the visible ballot cannot
    // be clicked during that delay.
    document.exitPointerLock?.();
    if (G && !usesMobileControls()) G.paused = true;
    const startedAt = G?.mpPodiumStartedAt || 0;
    const wait = startedAt ? Math.max(0, MULTIPLAYER_PODIUM_HOLD_MS - (performance.now() - startedAt)) : 0;
    clearTimeout(multiplayerVotingTimer);
    multiplayerVotingTimer = setTimeout(() => {
      setStyle(document.getElementById('endscreen'), 'display', 'none');
      if (!G?.atrium) startAtrium();
    }, wait);
  }
});

multiplayer.addEventListener('snapshot', (e) => {
  if (multiplayer.shouldHost()) return;
  if (e.detail.phase === 'playing' && (!G || !G.multiplayer || G.over || G.mapDef?.id !== e.detail.mapId)) {
    startCurrentMultiplayerMatch(
      e.detail.mapId,
      false,
      e.detail.mode || multiplayer.mode || 'ffa',
      e.detail,
    );
    return;
  }
  if (G?.multiplayer) {
    G.mpLastSnapshotAt = performance.now();
    if (G.mpSnapshotStalled) {
      G.mpSnapshotStalled = false;
      hud.message('SYNC RESTORED', '#6dff6d');
    }
  }
  applyMultiplayerSnapshot(e.detail);
  finishMultiplayerConnectionPause();
});

multiplayer.addEventListener('remoteInput', (e) => {
  if (!G?.multiplayerHost) return;
  G.remoteInputs ||= new Map();
  G.remoteInputs.set(e.detail.slotId, { ...e.detail.input, receivedAt: performance.now() });
});

multiplayer.addEventListener('hostChanged', (e) => {
  if (multiplayer.phase !== 'playing') return;
  startCurrentMultiplayerMatch(
    multiplayer.mapId,
    multiplayer.shouldHost() ? !G?.multiplayerHost : !G?.multiplayer,
    multiplayer.mode || 'ffa',
    e.detail.snapshot || null,
    false,
  );
});

function pauseMultiplayerForConnection(message = 'CONNECTION LOST — RECONNECTING...') {
  if (!G || (!G.multiplayer && !G.multiplayerHost) || G.mpConnectionPaused) return;
  mobilePauseOpen = false;
  mobileControls.reset();
  G.mpConnectionPaused = true;
  G.paused = true;
  G.player.firing = false;
  G.player.cancelWeaponWarmup?.();
  setPauseScoreboardLayer(false);
  setStyle(hud.els.board, 'display', 'none');
  setStyle(quitBtn, 'display', 'none');
  setStyle(volumeControl, 'display', 'none');
  setText(document.getElementById('catchtitle'), message);
  setStyle(clickcatch, 'display', 'flex');
  document.exitPointerLock?.();
}

function finishMultiplayerConnectionPause(message = 'SYNC RESTORED — CLICK TO RESUME') {
  if (!G || (!G.multiplayer && !G.multiplayerHost) || !G.mpConnectionPaused) return;
  G.mpConnectionPaused = false;
  G.paused = false;
  setText(document.getElementById('catchtitle'), message);
  setStyle(clickcatch, 'display', gameplayOverlayDisplay());
}

multiplayer.addEventListener('connectionLost', () => {
  if (G?.multiplayer || G?.multiplayerHost) {
    hud.message('CONNECTION LOST — REJOINING...', '#ffd23c');
    pauseMultiplayerForConnection();
  }
});

multiplayer.addEventListener('reconnected', () => {
  if (G?.multiplayer || G?.multiplayerHost) {
    hud.message('MULTIPLAYER REJOINED', '#6dff6d');
    if (multiplayer.shouldHost()) finishMultiplayerConnectionPause('REJOINED — CLICK TO RESUME');
  }
});

multiplayer.addEventListener('disconnect', () => {
  if (G?.multiplayer || G?.multiplayerHost) {
    hud.message('MULTIPLAYER DISCONNECTED', '#ff5c5c');
    endMatch(true);
  }
});

/* ---------------- main loop ---------------- */
function tick(now) {
  if (!G) return;
  mobileControls.sync();
  if (G.multiplayer && multiplayer.phase === 'playing' && !G.mpConnectionPaused &&
      now - (G.mpLastSnapshotAt || now) > MP_SNAPSHOT_STALL_MS) {
    // A host frame hitch is not a socket disconnect. Hard-pausing here used to
    // eject only guests from pointer lock after two seconds and leave a click
    // overlay behind even once snapshots resumed—the apparent non-host freeze.
    // Keep local prediction responsive while the server decides whether host
    // authority actually needs to move.
    if (!G.mpSnapshotStalled) {
      G.mpSnapshotStalled = true;
      hud.message('SYNC DELAY — RECOVERING...', '#ffd23c');
    }
  }
  const frameMs = Math.max(0, now - G.lastT);
  const dt = Math.min(0.05, frameMs / 1000);
  G.lastT = now;
  const workStartedAt = performance.now();
  if (!G.paused) {
    G.lastStepWall = now;
    step(dt);
  } else setJetpackThrust(false);
  updateDeathCamera(dt);
  updateUnderwaterFx(dt);
  updateFoliageFx(dt);
  updateHallucinationFx(dt);
  renderFrame();
  const workMs = performance.now() - workStartedAt;
  if (!G.paused && !G.over) {
    recordPerformanceSample(frameMs, workMs);
    updateAdaptiveRenderScale(frameMs, workMs);
  }
  if (G.pendingHall) {
    startHallOfFame();
    return;
  }
  if (G.pendingAtrium) {
    startAtrium();
    return;
  }
  if (G.pendingMap) { // walked into a lobby gate — swap to that arena
    const map = G.pendingMap;
    G.pendingMap = null;
    queueMapLoad(map, selectedMode);
    return; // startMatch scheduled its own loop
  }
  rafId = requestAnimationFrame(tick);
}

function renderFrame() {
  G.world.beforeRender?.({
    renderer,
    scene: renderPass.scene,
    camera,
    player: G.player,
    characters: G.characters,
    projectiles: G.projectiles?.projectiles,
    remoteTracers: G.mpTracerPool?.active,
    effects: G.fxPool?.puffs,
    damageMarkers: dmgMarkers,
    pickups: G.pickups?.items,
    lowQuality: usesLightRenderPath(),
  });
  const shake = G.world.cameraShake || 0;
  const savedPosition = shake > 0 ? camera.position.clone() : null;
  const savedQuaternion = shake > 0 ? camera.quaternion.clone() : null;
  if (shake > 0) {
    const strength = shake * shake;
    camera.position.add(new THREE.Vector3(
      (Math.random() - 0.5) * strength * 0.85,
      (Math.random() - 0.5) * strength * 0.58,
      (Math.random() - 0.5) * strength * 0.85,
    ));
    camera.rotateZ((Math.random() - 0.5) * strength * 0.028);
  }
  if (!usesLightRenderPath()) composer.render();
  else renderer.render(renderPass.scene, camera);
  if (savedPosition) {
    camera.position.copy(savedPosition);
    camera.quaternion.copy(savedQuaternion);
  }
}

// Lobby-only logic: gate triggers and the mode toggle pad
function stepAtrium(dt) {
  G.padCooldown -= dt;
  const hall = G.world.hallPortal;
  if (hall && Math.hypot(G.player.pos.x - hall.x, G.player.pos.z - hall.z) < 2.8) {
    G.pendingHall = true;
    sfx('powerup');
    return;
  }
  const mp = G.world.multiplayerPortal;
  if (mp && !openingMultiplayer &&
      Math.hypot(G.player.pos.x - mp.x, G.player.pos.z - mp.z) < 2.8) {
    openingMultiplayer = true;
    // Use the lobby/voting interval to finish map-specific texture and normal
    // work before an authoritative multiplayer round begins.
    prioritizeTextureLoading();
    document.exitPointerLock?.();
    multiplayer.open();
    setStyle(clickcatch, 'display', 'none');
    setStyle(quitBtn, 'display', 'none');
    setStyle(volumeControl, 'display', 'none');
    hud.message('JOINING MULTIPLAYER', '#ffd23c');
    setTimeout(() => { openingMultiplayer = false; }, 1500);
    return;
  }
  for (const p of G.world.portals) {
    const withinHeight = p.y == null || Math.abs(G.player.pos.y - p.y) < (p.heightRadius ?? 3.2);
    if (withinHeight && Math.hypot(G.player.pos.x - p.x, G.player.pos.z - p.z) < (p.radius ?? 2.6)) {
      G.pendingMap = MAPS.find(m => m.id === p.map);
      if (G.pendingMap?.secret) unlockSecretMap(G.pendingMap.id);
      sfx('powerup');
      break;
    }
  }
  const modePad = G.world.modePad;
  if (modePad && G.padCooldown <= 0 &&
      Math.hypot(G.player.pos.x - modePad.x, G.player.pos.z - modePad.z) < 2.1) {
    G.padCooldown = 1.2;
    selectedMode = selectedMode === 'ffa' ? 'tdm' : 'ffa';
    G.mode = selectedMode;
    syncAtriumModeSign();
    hud.message(modeLabel(selectedMode), '#30e0ff');
    sfx('pickup');
  }
}

function stepHallOfFame() {
  const exit = G.world.hallExitPortal;
  if (exit && Math.hypot(G.player.pos.x - exit.x, G.player.pos.z - exit.z) < 2.8) {
    G.pendingAtrium = true;
    sfx('powerup');
    return;
  }
  const secret = G.world.secretMapPortal;
  if (secret && Math.hypot(G.player.pos.x - secret.x, G.player.pos.z - secret.z) < 2.65) {
    G.pendingMap = MAPS.find(map => map.id === secret.map);
    if (G.pendingMap) {
      unlockSecretMap(G.pendingMap.id);
      hud.message('OLYMPUS MONS AWAKENS', '#ff6a32');
      sfx('powerup');
    }
  }
}

function updateStormAudio() {
  setRainAmbience(G?.world?.storm?.mix || 0);
}

function meteorSurfaceY(world, x, z) {
  let best = -Infinity;
  const index = world.meteorSurfaceIndex;
  const cell = index?.cells.get(`${Math.floor(x / index.cellSize)},${Math.floor(z / index.cellSize)}`);
  const colliders = index ? (cell?.colliders || []) : (world.colliders || []);
  const ramps = index ? (cell?.ramps || []) : (world.ramps || []);
  for (const c of colliders) {
    if (c.type === 'box') {
      if (x >= c.min.x && x <= c.max.x && z >= c.min.z && z <= c.max.z) {
        best = Math.max(best, c.max.y);
      }
    } else if (c.type === 'sphere') {
      const dx = x - c.center.x, dz = z - c.center.z;
      const radialSq = dx * dx + dz * dz;
      if (radialSq <= c.radius * c.radius) {
        best = Math.max(best, c.center.y + Math.sqrt(c.radius * c.radius - radialSq));
      }
    } else if (c.type === 'ellipsoid') {
      const surfaceY = ellipsoidSurfaceY(c, x, z);
      if (surfaceY != null) best = Math.max(best, surfaceY);
    } else if (c.type === 'triangleMesh') {
      const surfaceY = triangleMeshSurfaceY(c, x, z);
      if (surfaceY != null) best = Math.max(best, surfaceY);
    } else if (c.type === 'cylinderShell') {
      const surfaceY = cylinderShellSurfaceY(c, x, z);
      if (surfaceY != null) best = Math.max(best, surfaceY);
    }
  }
  for (const ramp of ramps) {
    if (!inRampFootprint(ramp, x, z)) continue;
    best = Math.max(best, rampSurfaceY(ramp, x, z));
  }
  return best;
}

function chooseMeteorTarget() {
  const cfg = G.world.meteorShower;
  for (let attempt = 0; attempt < 48; attempt++) {
    // Select an X/Z coordinate directly: 80% from the mesa square and 20%
    // from the surrounding map. The surface index below only determines its landing Y.
    const mesa = Math.random() < (cfg.mesaChance ?? 0.8);
    const mesaHalfExtent = cfg.mesaHalfExtent ?? 88;
    const halfExtent = mesa ? mesaHalfExtent : (cfg.mapHalfExtent ?? 170);
    const x = rand(-halfExtent, halfExtent);
    const z = rand(-halfExtent, halfExtent);
    if (!mesa && Math.abs(x) <= mesaHalfExtent && Math.abs(z) <= mesaHalfExtent) continue;
    const y = meteorSurfaceY(G.world, x, z);
    if (!Number.isFinite(y)) continue;
    const inGroundHazard = y < 5 && (G.world.lavaZones || []).some(zone => pointInZoneXZ(zone, x, z));
    if (inGroundHazard) continue;
    return new THREE.Vector3(x, y + 0.08, z);
  }
  const fallbackY = meteorSurfaceY(G.world, 0, 20);
  return new THREE.Vector3(0, Number.isFinite(fallbackY) ? fallbackY + 0.08 : 60.58, 20);
}

function createMeteorVisual() {
  const group = new THREE.Group();
  const rock = new THREE.Mesh(
    new THREE.IcosahedronGeometry(1.36, 1),
    new THREE.MeshStandardMaterial({
      color: 0xc9d1da, emissive: 0x2b2d32, emissiveIntensity: 0.2,
      metalness: 0.78, roughness: 0.3, flatShading: true, transparent: true, opacity: 0,
    }),
  );
  rock.scale.set(1.14, 1, 0.92);
  const outerTail = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 1.08, 7.6, 9, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xff5a18, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  );
  outerTail.position.y = 4.25;
  const innerTail = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.48, 5.2, 8, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xffdf57, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  );
  innerTail.position.y = 3.05;
  group.add(rock, outerTail, innerTail);

  const warning = new THREE.Mesh(
    new THREE.RingGeometry(3.25, 3.75, 28),
    new THREE.MeshBasicMaterial({
      color: 0xff7a2d, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  );
  warning.rotation.x = -Math.PI / 2;
  group.visible = false;
  warning.visible = false;
  G.scene.add(group, warning);
  return { group, rock, outerTail, innerTail, warning, inUse: false };
}

function acquireMeteorVisual() {
  const pool = G.meteorVisualPool ||= [];
  const meteor = pool.find(visual => !visual.inUse) || createMeteorVisual();
  if (!pool.includes(meteor)) pool.push(meteor);
  meteor.inUse = true;
  meteor.group.visible = true;
  meteor.warning.visible = true;
  return meteor;
}

function releaseMeteorVisual(meteor) {
  meteor.inUse = false;
  meteor.group.visible = false;
  meteor.warning.visible = false;
}

function spawnMeteorPickup(pos) {
  const weapons = (G.world.availableWeapons || WEAPON_ORDER)
    .filter(id => id !== 'blaster' && WEAPONS[id]);
  const powerups = ['health', 'shield', 'speed', 'jetpack', 'silver', 'gold'];
  const weapon = Math.random() < 0.56 && weapons.length ? pick(weapons) : null;
  const def = {
    id: nextDropId('meteor'),
    kind: weapon ? 'weapon' : pick(powerups),
    pos: pos.clone().add(new THREE.Vector3(0, 0.26, 0)),
    up: new THREE.Vector3(0, 1, 0),
  };
  if (weapon) def.weapon = weapon;
  G.pickups.addDrop(def);
  const item = G.pickups.items[G.pickups.items.length - 1];
  item.meteorPop = { t: 0, duration: 0.9, baseY: def.pos.y };
}

function impactMeteor(meteor) {
  const pos = meteor.target;
  // Sky events need an unmistakable arena-wide impact cue; normal weapon
  // explosions remain positional, but this uses the Whomper boom at full mix.
  sfx('whomp');
  G.fxPool.spawnPuff(pos, 0xffa030, Math.max(3.2, EVENT_BLAST_RADIUS * 0.75));
  if (!meteor.authoritative) return;

  for (const ch of G.characters) {
    if (!ch.alive) continue;
    const center = ch.pos.clone();
    center.y += ch.height * 0.5;
    const distance = center.distanceTo(pos);
    if (distance >= EVENT_BLAST_RADIUS) continue;
    const damage = EVENT_BLAST_DAMAGE * (1 - distance / EVENT_BLAST_RADIUS);
    applyDamage(ch, damage, METEOR, { environmental: true });
  }
  spawnMeteorPickup(pos);
}

function spawnMeteorVisual(data, authoritative = false) {
  if (!G?.world?.meteorShower) return;
  G.meteorIds ||= new Set();
  if (data.id && G.meteorIds.has(data.id)) return;
  if (data.id) G.meteorIds.add(data.id);

  const target = data.target?.isVector3
    ? data.target.clone()
    : new THREE.Vector3(data.target.x, data.target.y, data.target.z);
  const start = data.start?.isVector3
    ? data.start.clone()
    : new THREE.Vector3(data.start.x, data.start.y, data.start.z);
  const duration = data.duration || 2.8;
  const meteor = acquireMeteorVisual();
  const { group, rock, outerTail, innerTail, warning } = meteor;
  rock.material.opacity = 0;
  outerTail.material.opacity = 0;
  innerTail.material.opacity = 0;
  warning.material.opacity = 0;
  const tailDirection = start.clone().sub(target).normalize();
  group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tailDirection);
  group.position.copy(start);
  warning.position.copy(target).add(new THREE.Vector3(0, 0.06, 0));

  Object.assign(meteor, { id: data.id, start, target, duration, age: 0, authoritative });
  (G.meteors ||= []).push(meteor);
}

function launchMeteor() {
  const cfg = G.world.meteorShower;
  const target = chooseMeteorTarget();
  const startHeight = rand(cfg.startHeightMin ?? 150, cfg.startHeightMax ?? 174);
  const elevation = THREE.MathUtils.degToRad(rand(
    cfg.startElevationMin ?? 60, cfg.startElevationMax ?? 78,
  ));
  const bearing = Math.random() * Math.PI * 2;
  const horizontalDistance = startHeight / Math.tan(elevation);
  const start = target.clone().add(new THREE.Vector3(
    Math.cos(bearing) * horizontalDistance,
    startHeight,
    Math.sin(bearing) * horizontalDistance,
  ));
  const data = {
    id: nextDropId('meteor-flight'), target, start,
    duration: rand(cfg.durationMin ?? 3.32, cfg.durationMax ?? 3.97),
  };
  spawnMeteorVisual(data, true);
  if (G.multiplayerHost) queueMultiplayerEvent({
    type: 'meteor', id: data.id, duration: data.duration,
    start: { x: start.x, y: start.y, z: start.z },
    target: { x: target.x, y: target.y, z: target.z },
  });
}

function updateMeteorShower(dt) {
  const cfg = G.world.meteorShower;
  if (!cfg) return;
  for (let i = (G.meteors?.length || 0) - 1; i >= 0; i--) {
    const meteor = G.meteors[i];
    meteor.age += dt;
    const u = Math.min(1, meteor.age / meteor.duration);
    const fade = Math.min(1, meteor.age / (cfg.fadeIn ?? 1));
    const fall = u * u;
    meteor.group.position.lerpVectors(meteor.start, meteor.target, fall);
    meteor.rock.rotation.x += dt * 2.8;
    meteor.rock.rotation.z += dt * 2.1;
    meteor.rock.material.opacity = fade;
    meteor.outerTail.material.opacity = (0.58 + Math.sin(meteor.age * 19) * 0.12) * fade;
    meteor.innerTail.material.opacity = (0.75 + Math.sin(meteor.age * 25 + 1) * 0.16) * fade;
    const pulse = 1 + Math.sin(meteor.age * 8) * 0.12;
    meteor.warning.scale.setScalar(pulse);
    meteor.warning.material.opacity = (0.32 + u * 0.5) * fade;
    if (u < 1) continue;
    impactMeteor(meteor);
    releaseMeteorVisual(meteor);
    G.meteors.splice(i, 1);
  }

  if (G.multiplayer && !G.multiplayerHost) return;
  if (!Number.isFinite(G.meteorTimer)) G.meteorTimer = rand(cfg.minInterval, cfg.maxInterval);
  G.meteorTimer -= dt;
  if (G.meteorTimer > 0) return;
  launchMeteor();
  G.meteorTimer = rand(cfg.minInterval, cfg.maxInterval);
}

function updateImpactPickupPops(dt) {
  for (const item of G.pickups?.items || []) {
    const pop = item.meteorPop;
    if (!pop) continue;
    pop.t += dt;
    const u = Math.min(1, pop.t / pop.duration);
    item.def.pos.y = pop.baseY + Math.sin(u * Math.PI) * 3.1;
    if (u >= 1) { item.def.pos.y = pop.baseY; delete item.meteorPop; }
  }
}

function createCometVisual(cfg) {
  const group = new THREE.Group();
  const rock = new THREE.Mesh(
    new THREE.IcosahedronGeometry(cfg.radius || 1.36, 1),
    new THREE.MeshStandardMaterial({
      color: 0xdbe6ef, emissive: 0x2d3b48, emissiveIntensity: 0.28,
      metalness: 0.86, roughness: 0.25, flatShading: true, transparent: true, opacity: 0,
    }),
  );
  rock.scale.set(1.14, 0.96, 1.02);
  const outerTail = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 1.08, cfg.outerTailLength || 26, 9, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0x258dff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  );
  outerTail.position.y = (cfg.outerTailLength || 26) * 0.5 + 0.45;
  const innerTail = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.46, cfg.innerTailLength || 17, 8, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xb8eeff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  );
  innerTail.position.y = (cfg.innerTailLength || 17) * 0.5 + 0.35;
  group.add(rock, outerTail, innerTail);
  group.visible = false;
  G.scene.add(group);
  return { group, rock, outerTail, innerTail, inUse: false };
}

function acquireCometVisual(cfg) {
  const pool = G.cometVisualPool ||= [];
  const comet = pool.find(visual => !visual.inUse) || createCometVisual(cfg);
  if (!pool.includes(comet)) pool.push(comet);
  comet.inUse = true;
  comet.group.visible = true;
  return comet;
}

function releaseCometVisual(comet) {
  comet.inUse = false;
  comet.group.visible = false;
}

function disposeEventGroup(group) {
  G.scene.remove(group);
  group.traverse(obj => {
    obj.geometry?.dispose?.();
    if (Array.isArray(obj.material)) obj.material.forEach(material => material.dispose?.());
    else obj.material?.dispose?.();
  });
}

function clearEventVisualPools() {
  for (const meteor of G.meteorVisualPool || []) {
    disposeEventGroup(meteor.group);
    G.scene.remove(meteor.warning);
    meteor.warning.geometry.dispose();
    meteor.warning.material.dispose();
  }
  for (const comet of G.cometVisualPool || []) disposeEventGroup(comet.group);
  G.meteorVisualPool = [];
  G.cometVisualPool = [];
}

function prepareMatchVisualPrewarm(scene, player, characters, projectiles, fxPool) {
  // WebGLRenderer.compile() traverses visible objects only. Temporarily reveal
  // every hidden weapon, powerup-skin probe, and equipped-jetpack part so the
  // loading phase really compiles the variants that can appear mid-match.
  const visibility = new Map();
  const reveal = root => root?.traverse(obj => {
    visibility.set(obj, obj.visible);
    obj.visible = true;
  });
  reveal(player.viewmodel);
  reveal(player.dualBlasterViewmodel);
  reveal(player.grappleViewmodel);
  for (const character of characters) reveal(character.mesh);
  reveal(projectiles.lightningArcPool?.[0]?.group);
  const cleanupDropPrewarm = G?.pickups?.prepareDropPrewarm?.() || (() => {});

  // Damage numbers used to allocate and upload a fresh canvas texture on the
  // exact frame a dart connected. Keep their reusable GPU resources in the
  // scene and compile one representative sprite while the loader is visible.
  initializeDmgMarkerPool(scene);
  const markerProbe = dmgMarkerPool[0];
  const markerProbeState = markerProbe ? {
    visible: markerProbe.sprite.visible,
    position: markerProbe.sprite.position.clone(),
    scale: markerProbe.sprite.scale.clone(),
    opacity: markerProbe.sprite.material.opacity,
  } : null;
  if (markerProbe) {
    markerProbe.sprite.visible = true;
    markerProbe.sprite.position.copy(camera.position);
    markerProbe.sprite.scale.setScalar(0.01);
    markerProbe.sprite.material.opacity = 0.01;
  }

  const probes = new THREE.Group();
  probes.position.set(0, 0, -2);
  probes.scale.setScalar(0.01);
  const probeGeometries = [];
  // Compile the two temporary weapon finishes on the same merged
  // blaster geometry used in play. A tiny material-only box did not exercise
  // the complete live draw path on every browser, leaving a one-frame hitch on
  // the first gold or silver pickup.
  for (const [index, kind] of ['gold', 'silver'].entries()) {
    const skinProbe = buildBlaster('blaster');
    if (skinProbe.children[0]) skinProbe.children[0].material = blasterSkin(kind);
    skinProbe.position.x = index * 1.5;
    probes.add(skinProbe);
  }
  const projectileGeo = new THREE.SphereGeometry(1, 8, 6);
  probeGeometries.push(projectileGeo);
  for (const weapon of Object.values(WEAPONS)) {
    const projectile = new THREE.Mesh(
      projectileGeo,
      projectiles.matFor(weapon.color, weapon.glowingProjectile),
    );
    if (weapon.glowingProjectile) {
      const aura = new THREE.Mesh(projectileGeo, projectiles.projectileAuraMatFor(weapon.color));
      aura.scale.setScalar(1.5);
      projectile.add(aura);
    }
    probes.add(projectile);
  }
  for (const weapon of Object.values(WEAPONS).filter(def => def.beam)) {
    const beamGeo = new THREE.CylinderGeometry(0.08, 0.08, 1, 10);
    probeGeometries.push(beamGeo);
    probes.add(new THREE.Mesh(beamGeo, projectiles.beamMatFor(weapon.color, 0.9)));
    probes.add(new THREE.Mesh(beamGeo, projectiles.beamMatFor(weapon.color, 0.2)));
  }
  camera.add(probes);

  const warmPos = camera.getWorldPosition(new THREE.Vector3())
    .addScaledVector(camera.getWorldDirection(new THREE.Vector3()), 4);
  fxPool.spawnPuff(warmPos, 0xffffff, 0.1);
  return () => {
    fxPool.clear();
    cleanupDropPrewarm();
    camera.remove(probes);
    for (const geometry of probeGeometries) geometry.dispose();
    for (const [object, visible] of visibility) object.visible = visible;
    if (markerProbe && markerProbeState) {
      markerProbe.sprite.visible = markerProbeState.visible;
      markerProbe.sprite.position.copy(markerProbeState.position);
      markerProbe.sprite.scale.copy(markerProbeState.scale);
      markerProbe.sprite.material.opacity = markerProbeState.opacity;
    }
  };
}

function beginGameplayShaderCompile() {
  const previousTarget = renderer.getRenderTarget();
  // EffectComposer renders the arena into a linear render target before bloom
  // and output conversion. Compiling probes against the default sRGB screen
  // warms a different shader key, leaving the real gameplay variant to block
  // on its first hit, death drop, or meteor reward.
  const gameplayTarget = usesLightRenderPath() ? null : composer.renderTarget1;
  if (previousTarget !== gameplayTarget) renderer.setRenderTarget(gameplayTarget);
  return () => {
    if (renderer.getRenderTarget() !== previousTarget) renderer.setRenderTarget(previousTarget);
  };
}

function prewarmMatchVisuals(scene, player, characters, projectiles, fxPool) {
  const cleanup = prepareMatchVisualPrewarm(scene, player, characters, projectiles, fxPool);
  const restoreTarget = beginGameplayShaderCompile();
  try { renderer.compile(scene, camera); } finally {
    restoreTarget();
    cleanup();
  }
}

async function prewarmMatchVisualsAsync(scene, player, characters, projectiles, fxPool) {
  const cleanup = prepareMatchVisualPrewarm(scene, player, characters, projectiles, fxPool);
  const restoreTarget = beginGameplayShaderCompile();
  try {
    if (typeof renderer.compileAsync === 'function') await renderer.compileAsync(scene, camera);
    else renderer.compile(scene, camera);
  } finally {
    restoreTarget();
    cleanup();
  }
}

function collectSceneTextures(scene) {
  const textures = new Set();
  const sourceVariants = new WeakMap();
  const addValue = value => {
    if (value?.isTexture && !value.isRenderTargetTexture) {
      const source = value.source;
      if (!source || (typeof source !== 'object' && typeof source !== 'function')) {
        textures.add(value);
        return;
      }
      const cacheKey = [
        value.wrapS, value.wrapT, value.wrapR || 0, value.magFilter, value.minFilter,
        value.anisotropy, value.internalFormat, value.format, value.type,
        value.generateMipmaps, value.premultiplyAlpha, value.flipY,
        value.unpackAlignment, value.colorSpace,
      ].join();
      let variants = sourceVariants.get(source);
      if (!variants) {
        variants = new Set();
        sourceVariants.set(source, variants);
      }
      if (!variants.has(cacheKey)) {
        variants.add(cacheKey);
        textures.add(value);
      }
    } else if (Array.isArray(value)) value.forEach(addValue);
  };
  addValue(scene.background);
  addValue(scene.environment);
  scene.traverse(object => {
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!material) continue;
      for (const value of Object.values(material)) addValue(value);
      for (const uniform of Object.values(material.uniforms || {})) addValue(uniform?.value);
    }
  });
  // The real gold/silver geometry probes are removed after shader compilation
  // so they never remain in the gameplay scene. Explicitly retain their maps
  // in the upload list; otherwise the first pickup still pays the GPU texture
  // upload even though its shader program was already compiled.
  for (const kind of ['gold', 'silver']) {
    for (const value of Object.values(blasterSkin(kind))) addValue(value);
  }
  return [...textures];
}

function initializeSceneTextures(textures) {
  for (const texture of textures) renderer.initTexture(texture);
}

async function prewarmSceneTexturesAsync(scene, loadingToken = mapLoadingToken) {
  const textures = collectSceneTextures(scene);
  const perSlice = 3;
  for (let i = 0; i < textures.length; i += perSlice) {
    initializeSceneTextures(textures.slice(i, i + perSlice));
    const completed = Math.min(textures.length, i + perSlice);
    setMapLoadingProgress(
      90 + (completed / Math.max(1, textures.length)) * 3,
      `Uploading arena textures (${completed}/${textures.length})`,
      loadingToken,
    );
    await paintLoadingStage();
  }
}

function prepareOutputPassMaterial() {
  if (outputPass._outputColorSpace === renderer.outputColorSpace &&
      outputPass._toneMapping === renderer.toneMapping) return;
  outputPass._outputColorSpace = renderer.outputColorSpace;
  outputPass._toneMapping = renderer.toneMapping;
  outputPass.material.defines = {};
  if (renderer.outputColorSpace === THREE.SRGBColorSpace) {
    outputPass.material.defines.SRGB_TRANSFER = '';
  }
  if (renderer.toneMapping === THREE.ACESFilmicToneMapping) {
    outputPass.material.defines.ACES_FILMIC_TONE_MAPPING = '';
  }
  outputPass.material.needsUpdate = true;
}

function preparePostProcessingShaderPrewarm() {
  prepareOutputPassMaterial();
  const scene = new THREE.Scene();
  const warmCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const geometry = new THREE.PlaneGeometry(2, 2);
  const materials = [
    bloomPass.materialHighPassFilter,
    ...bloomPass.separableBlurMaterials,
    bloomPass.compositeMaterial,
    bloomPass.blendMaterial,
    outputPass.material,
  ];
  for (const material of materials) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    scene.add(mesh);
  }
  return {
    scene,
    camera: warmCamera,
    cleanup: () => {
      scene.clear();
      geometry.dispose();
    },
  };
}

function postProcessingTargets() {
  return [
    composer.renderTarget1,
    composer.renderTarget2,
    bloomPass.renderTargetBright,
    ...bloomPass.renderTargetsHorizontal,
    ...bloomPass.renderTargetsVertical,
  ].filter(Boolean);
}

function initializePostProcessingTargets(targets = postProcessingTargets()) {
  if (usesLightRenderPath()) return;
  for (const target of targets) {
    renderer.setRenderTarget(target);
    renderer.clear(true, true, true);
  }
  renderer.setRenderTarget(null);
}

function prewarmPostProcessing() {
  if (usesLightRenderPath()) return;
  const probe = preparePostProcessingShaderPrewarm();
  try { renderer.compile(probe.scene, probe.camera); } finally { probe.cleanup(); }
  initializePostProcessingTargets();
}

async function prewarmPostProcessingAsync(loadingToken = mapLoadingToken) {
  if (usesLightRenderPath()) return;
  const probe = preparePostProcessingShaderPrewarm();
  try {
    if (typeof renderer.compileAsync === 'function') {
      await renderer.compileAsync(probe.scene, probe.camera);
    } else {
      renderer.compile(probe.scene, probe.camera);
    }
  } finally {
    probe.cleanup();
  }
  const targets = postProcessingTargets();
  // Allocate a couple of framebuffers per browser turn. Large half-float/MSAA
  // targets can involve a driver synchronization; chunking keeps the loading
  // bar responsive and ensures the live match never pays this cost.
  for (let i = 0; i < targets.length; i += 2) {
    initializePostProcessingTargets(targets.slice(i, i + 2));
    const completed = Math.min(targets.length, i + 2);
    setMapLoadingProgress(
      94 + (completed / targets.length) * 3,
      `Allocating graphics buffers (${completed}/${targets.length})`,
      loadingToken,
    );
    await paintLoadingStage();
  }
}

function prepareEventVisualPrewarm() {
  if (!G?.world) return { scene: null, needsCompile: false, cleanup: () => {} };
  const eventScene = G.scene;
  const direction = camera.getWorldDirection(new THREE.Vector3());
  const warmPos = camera.position.clone().addScaledVector(direction, 6);
  const warmMeteors = [];
  const warmComets = [];
  let pickupProbes = null;
  if (G.world.meteorShower) {
    const meteor = acquireMeteorVisual();
    meteor.group.position.copy(warmPos);
    meteor.warning.position.copy(warmPos);
    meteor.rock.material.opacity = 0.01;
    meteor.outerTail.material.opacity = 0.01;
    meteor.innerTail.material.opacity = 0.01;
    meteor.warning.material.opacity = 0.01;
    warmMeteors.push(meteor);

    const weapons = (G.world.availableWeapons || WEAPON_ORDER)
      .filter(id => id !== 'blaster' && WEAPONS[id]);
    const rewardDefs = [
      ...weapons.map(weapon => ({ kind: 'weapon', weapon })),
      ...['health', 'shield', 'speed', 'jetpack', 'silver', 'gold'].map(kind => ({ kind })),
    ];
    pickupProbes = G.pickups?.createDropPrewarmGroup?.(rewardDefs) || null;
    if (pickupProbes?.children.length) {
      pickupProbes.position.copy(warmPos);
      pickupProbes.scale.setScalar(0.01);
      eventScene.add(pickupProbes);
    }
  }
  if (G.world.cometField) {
    const count = G.world.cometField.maxActive ?? 2;
    for (let i = 0; i < count; i++) {
      const comet = acquireCometVisual(G.world.cometField);
      comet.group.position.copy(warmPos);
      comet.rock.material.opacity = 0.01;
      comet.outerTail.material.opacity = 0.01;
      comet.innerTail.material.opacity = 0.01;
      warmComets.push(comet);
    }
  }
  return {
    scene: eventScene,
    needsCompile: warmMeteors.length > 0 || warmComets.length > 0,
    cleanup: () => {
      for (const meteor of warmMeteors) releaseMeteorVisual(meteor);
      for (const comet of warmComets) releaseCometVisual(comet);
      if (pickupProbes) eventScene.remove(pickupProbes);
    },
  };
}

function prewarmEventVisuals() {
  const warm = prepareEventVisualPrewarm();
  const restoreTarget = beginGameplayShaderCompile();
  try {
    if (warm.needsCompile) renderer.compile(warm.scene, camera);
  } finally {
    restoreTarget();
    warm.cleanup();
  }
}

async function prewarmEventVisualsAsync() {
  const warm = prepareEventVisualPrewarm();
  const restoreTarget = beginGameplayShaderCompile();
  try {
    if (warm.needsCompile) {
      if (typeof renderer.compileAsync === 'function') await renderer.compileAsync(warm.scene, camera);
      else renderer.compile(warm.scene, camera);
    }
  } finally {
    restoreTarget();
    warm.cleanup();
  }
}

function retireComet(comet) {
  if (!comet || comet.destroyed) return;
  comet.destroyed = true;
  comet.active = false;
  releaseCometVisual(comet);
  const index = G?.comets?.indexOf(comet) ?? -1;
  if (index >= 0) G.comets.splice(index, 1);
}

function playCometImpact(pos) {
  sfx('whomp');
  G.fxPool.spawnPuff(pos, 0x9fdcff, Math.max(3.2, EVENT_BLAST_RADIUS * 0.75));
}

function impactComet(comet) {
  if (!comet || comet.destroyed) return;
  const pos = comet.pos.clone();
  playCometImpact(pos);

  if (comet.authoritative) {
    for (const ch of G.characters) {
      if (!ch.alive) continue;
      const center = ch.pos.clone().addScaledVector(ch.up || new THREE.Vector3(0, 1, 0), ch.height * 0.5);
      const distance = center.distanceTo(pos);
      if (distance >= EVENT_BLAST_RADIUS) continue;
      const damage = EVENT_BLAST_DAMAGE * (1 - distance / EVENT_BLAST_RADIUS);
      applyDamage(ch, damage, COMET, { environmental: true });
    }
    spawnMeteorPickup(pos);
    if (G.multiplayerHost) queueMultiplayerEvent({
      type: 'comet-impact', id: comet.id,
      pos: { x: pos.x, y: pos.y, z: pos.z },
    });
  }
  retireComet(comet);
}

function receiveCometImpact(data) {
  if (!G?.world?.cometField || !data?.pos) return;
  G.cometImpactIds ||= new Set();
  if (data.id && G.cometImpactIds.has(data.id)) return;
  if (data.id) G.cometImpactIds.add(data.id);
  const pos = new THREE.Vector3(data.pos.x, data.pos.y, data.pos.z);
  const comet = (G.comets || []).find(item => item.id === data.id);
  if (comet) {
    comet.pos.copy(pos);
    comet.group.position.copy(pos);
    playCometImpact(pos);
    retireComet(comet);
  } else {
    playCometImpact(pos);
  }
}

function spawnCometVisual(data, authoritative = false) {
  if (!G?.world?.cometField || !data?.start || !data?.velocity) return;
  G.cometIds ||= new Set();
  if (data.id && G.cometIds.has(data.id)) return;
  if (data.id) G.cometIds.add(data.id);

  const cfg = G.world.cometField;
  const start = data.start?.isVector3
    ? data.start.clone()
    : new THREE.Vector3(data.start.x, data.start.y, data.start.z);
  const velocity = data.velocity?.isVector3
    ? data.velocity.clone()
    : new THREE.Vector3(data.velocity.x, data.velocity.y, data.velocity.z);
  if (velocity.lengthSq() < 1e-6) return;

  const comet = acquireCometVisual(cfg);
  const { group, rock, outerTail, innerTail } = comet;
  rock.material.opacity = 0;
  outerTail.material.opacity = 0;
  innerTail.material.opacity = 0;
  group.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0), velocity.clone().normalize().negate());
  group.position.copy(start);

  Object.assign(comet, {
    id: data.id, group, rock, outerTail, innerTail,
    pos: start.clone(), velocity, age: 0,
    life: data.life || cfg.flightLife || 11,
    health: data.health || cfg.health || 150,
    radius: cfg.radius || 1.36,
    authoritative, active: true, destroyed: false,
  });
  (G.comets ||= []).push(comet);
}

function launchComet() {
  const cfg = G.world.cometField;
  const activeCharacters = G.characters.filter(character => character.alive);
  const anchor = activeCharacters.length ? pick(activeCharacters) : null;
  const jumpReach = (G.world.jumpVel * G.world.jumpVel) / (2 * G.world.gravity);
  const laneSpread = cfg.laneSpread ?? 42;
  const crossing = new THREE.Vector3(
    (anchor?.pos.x || 0) + rand(-laneSpread, laneSpread),
    (anchor?.pos.y || 6) + rand(-jumpReach, jumpReach),
    (anchor?.pos.z || 0) + rand(-laneSpread, laneSpread),
  );
  const bearing = Math.random() * Math.PI * 2;
  const elevation = THREE.MathUtils.degToRad(rand(
    -(cfg.maxElevation ?? 15), cfg.maxElevation ?? 15,
  ));
  // A straight, almost-horizontal path that crosses the current combat area.
  const direction = new THREE.Vector3(
    Math.cos(bearing), Math.tan(elevation), Math.sin(bearing),
  ).normalize();
  const start = crossing.clone().addScaledVector(direction, -(cfg.spawnRadius || 230));
  const velocity = direction.multiplyScalar(rand(cfg.minSpeed || 27, cfg.maxSpeed || 36));
  const data = {
    id: nextDropId('comet-flight'), start, velocity,
    life: cfg.flightLife || 11, health: cfg.health || 150,
  };
  spawnCometVisual(data, true);
  if (G.multiplayerHost) queueMultiplayerEvent({
    type: 'comet-spawn', id: data.id, life: data.life, health: data.health,
    start: { x: start.x, y: start.y, z: start.z },
    velocity: { x: velocity.x, y: velocity.y, z: velocity.z },
  });
}

function distancePointToSegment3(point, a, b) {
  const ab = b.clone().sub(a);
  const lengthSq = ab.lengthSq();
  if (lengthSq < 1e-6) return point.distanceTo(a);
  const t = Math.max(0, Math.min(1, point.clone().sub(a).dot(ab) / lengthSq));
  return point.distanceTo(a.clone().addScaledVector(ab, t));
}

function cometTouchesCharacter(comet, ch) {
  if (!ch.alive) return false;
  const up = ch.up || new THREE.Vector3(0, 1, 0);
  const radius = ch.radius || 0.45;
  const foot = ch.pos.clone().addScaledVector(up, radius);
  const head = ch.pos.clone().addScaledVector(up, Math.max(ch.height - radius, ch.height * 0.55));
  return distancePointToSegment3(comet.pos, foot, head) < comet.radius + radius;
}

function shootableWorldTargets() {
  const comets = G?.comets || [];
  const scoreTargets = G?.world?.scoreTargets || [];
  const gator = G?.world?.gator?.shootTarget;
  return [...comets, ...scoreTargets, ...(gator ? [gator] : [])];
}

function segmentTouchesPlaneTarget(target, a, b, pad = 0) {
  if (!target || target.shape !== 'plane') return false;
  const startX = a.x - target.pos.x;
  const startY = a.y - target.pos.y;
  const startZ = a.z - target.pos.z;
  const endX = b.x - target.pos.x;
  const endY = b.y - target.pos.y;
  const endZ = b.z - target.pos.z;
  const startDistance = startX * target.normal.x + startY * target.normal.y + startZ * target.normal.z;
  const endDistance = endX * target.normal.x + endY * target.normal.y + endZ * target.normal.z;
  const distanceDelta = startDistance - endDistance;
  let t;
  if (Math.abs(distanceDelta) > 1e-6) {
    t = Math.max(0, Math.min(1, startDistance / distanceDelta));
  } else {
    t = Math.abs(startDistance) <= Math.abs(endDistance) ? 0 : 1;
  }
  const offsetX = startX + (endX - startX) * t;
  const offsetY = startY + (endY - startY) * t;
  const offsetZ = startZ + (endZ - startZ) * t;
  const normalOffset = offsetX * target.normal.x + offsetY * target.normal.y + offsetZ * target.normal.z;
  if (Math.abs(normalOffset) > pad + 0.03) return false;
  const rightOffset = offsetX * target.right.x + offsetY * target.right.y + offsetZ * target.right.z;
  const upOffset = offsetX * target.up.x + offsetY * target.up.y + offsetZ * target.up.z;
  return Math.abs(rightOffset) <= target.halfWidth + pad &&
    Math.abs(upOffset) <= target.halfHeight + pad;
}

function openUrlSign(target, { fromGesture = false } = {}) {
  if (!target?.url || !target.active) return false;
  target.setCooldown?.(target.cooldownDuration || 2.5);
  // Prefer opening during the click gesture; deferred projectile hits often get
  // popup-blocked, so keep a quiet fallback attempt either way.
  const win = window.open(target.url, '_blank', 'noopener,noreferrer');
  if (!win && fromGesture) {
    const a = document.createElement('a');
    a.href = target.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  return true;
}

function tryOpenAimedUrlSign() {
  if (!G?.atrium || !G.player?.camera) return;
  const signs = (G.world?.scoreTargets || []).filter((t) => t?.kind === 'url-sign' && t.active);
  if (!signs.length) return;
  const origin = G.player.camera.position;
  const dir = new THREE.Vector3();
  G.player.camera.getWorldDirection(dir);
  const far = origin.clone().addScaledVector(dir, 120);
  let best = null;
  let bestDist = Infinity;
  for (const target of signs) {
    if (!segmentTouchesPlaneTarget(target, origin, far, 0.05)) continue;
    const dist = origin.distanceToSquared(target.pos);
    if (dist < bestDist) {
      best = target;
      bestDist = dist;
    }
  }
  if (!best) return;
  if (openUrlSign(best, { fromGesture: true }) && best.toast) {
    hud.hitmarker();
    sfx('coin');
    hud.message(best.toast, '#ffd23c');
  }
}

function damageWorldTarget(target, damage, attacker) {
  if (target?.kind === 'canal-gator') {
    target.onHit?.(attacker);
    if (attacker?.isPlayer) {
      hud.hitmarker();
      sfx('hit');
    }
    return;
  }
  if (target?.kind === 'url-sign') {
    if (!attacker?.isPlayer || !target.active) return;
    // Projectile path is usually outside the click gesture; still try so
    // hold-to-fire into the plaque works when the browser allows it.
    openUrlSign(target);
    hud.hitmarker();
    sfx('coin');
    if (target.toast) hud.message(target.toast, '#ffd23c');
    return;
  }
  if (target?.kind === 'score-poster') {
    hitScorePoster(target, attacker);
    return;
  }
  damageComet(target, damage, attacker);
}

function hitScorePoster(target, attacker) {
  if (!G || !target?.active || !attacker || G.over || G.atrium) return;
  target.setCooldown?.(target.cooldownDuration || 30);
  const points = Math.max(0, Math.round(target.points || 250));
  attacker.score = Math.max(0, Number(attacker.score) || 0) + points;
  if (G.mode === 'tdm' && Object.hasOwn(G.scores, attacker.team)) {
    G.scores[attacker.team] += points;
  }
  if (attacker.isPlayer) {
    hud.hitmarker();
    sfx('coin');
    hud.message(`BULLSEYE! +${points} PTS`, '#ffd23c');
  }
}

function damageComet(comet, damage, attacker) {
  if (!comet?.authoritative || comet.destroyed || damage <= 0) return;
  comet.health -= damage;
  if (attacker?.isPlayer) {
    hud.hitmarker();
    sfx('hit');
  }
  if (comet.health <= 0) impactComet(comet);
}

function updateCometField(dt) {
  const cfg = G.world.cometField;
  if (!cfg) return;
  for (let i = (G.comets?.length || 0) - 1; i >= 0; i--) {
    const comet = G.comets[i];
    if (!comet || comet.destroyed) continue;
    comet.age += dt;
    const fade = Math.min(1, comet.age / (cfg.fadeIn ?? 1));
    comet.rock.rotation.x += dt * 2.7;
    comet.rock.rotation.z += dt * 2.15;
    comet.rock.material.opacity = fade;
    comet.outerTail.material.opacity = (0.58 + Math.sin(comet.age * 19) * 0.12) * fade;
    comet.innerTail.material.opacity = (0.76 + Math.sin(comet.age * 25 + 1) * 0.14) * fade;

    const moveLength = comet.velocity.length() * dt;
    const steps = Math.max(1, Math.ceil(moveLength / 0.7));
    let impacted = false;
    for (let step = 0; step < steps && !impacted; step++) {
      const previous = comet.pos.clone();
      comet.pos.addScaledVector(comet.velocity, dt / steps);
      if (!comet.authoritative) continue;
      if (pointHitsWorld(comet.pos, comet.radius, G.world)) {
        comet.pos.copy(previous);
        impacted = true;
        break;
      }
      if (G.characters.some(ch => cometTouchesCharacter(comet, ch))) impacted = true;
    }
    comet.group.position.copy(comet.pos);
    if (impacted) {
      impactComet(comet);
      continue;
    }
    if (comet.age >= comet.life) retireComet(comet); // a clean fly-by: no blast, no loot
  }

  if (G.multiplayer && !G.multiplayerHost) return;
  if (!Number.isFinite(G.cometTimer)) G.cometTimer = rand(cfg.minInterval, cfg.maxInterval);
  G.cometTimer -= dt;
  if (G.cometTimer > 0) return;
  if ((G.comets?.length || 0) >= (cfg.maxActive ?? 2)) {
    G.cometTimer = 0.5;
    return;
  }
  launchComet();
  G.cometTimer = rand(cfg.minInterval, cfg.maxInterval);
}

function step(dt) {
  if (G.over) {
    setJetpackThrust(false);
    updateVictoryPodium(dt);
    return;
  }

  if (G.multiplayer) {
    stepMultiplayer(dt);
    return;
  }

  if (G.hallOfFame) stepHallOfFame(dt);
  else if (G.atrium) stepAtrium(dt);
  else if (G.multiplayerHost) {
    G.timeLeft = Math.max(0, (multiplayer.phaseEndsAt - Date.now()) / 1000);
  } else {
    G.timeLeft -= dt;
  }
  setListener(G.player.pos); // distance-based sfx volume

  G.world.update?.(dt, G.characters);
  updateMeteorShower(dt);
  updateCometField(dt);
  updateImpactPickupPops(dt);
  updateStormAudio();
  if (G.multiplayerHost) {
    syncRemoteHumans();
    syncMultiplayerNameTags();
  }

  const fire = (owner, origin, dir, weaponId) => {
    G.projectiles.fire(owner, origin, dir, weaponId);
    recordMultiplayerShot(owner, origin, dir, weaponId);
  };
  const moveHook = G.world.postCharacterMove;
  if (moveHook) previousCharacterPos.copy(G.player.pos);
  G.player.update(dt, fire);
  if (moveHook) moveHook(G.player, previousCharacterPos);
  setJetpackThrust(!!(G.player.alive && G.player.jetpack?.active));
  for (const ch of G.characters) {
    if (!ch.isPlayer) {
      if (moveHook) previousCharacterPos.copy(ch.pos);
      if (ch.remoteHuman) updateRemoteHuman(ch, dt, fire);
      else ch.update(dt, G.characters, fire);
      if (moveHook) moveHook(ch, previousCharacterPos);
    }
  }
  updateMyceliumToadEffects(dt);

  G.world.updateDoors?.(G.characters, dt); // proximity doors (Labyrinth)

  // Lava hurts immediately on entry, then burns ~34 hp/s in three pulses per second.
  if (G.world.lavaZones) {
    for (const ch of G.characters) {
      if (!ch.alive) continue;
      const burning = G.world.lavaZones.some(zn =>
        pointInZoneXZ(zn, ch.pos.x, ch.pos.z) && ch.pos.y < zn.maxY);
      if (burning) {
        if (ch._lavaT == null) {
          ch._lavaT = 0;
          applyDamage(ch, 11.3, LAVA);
        }
        ch._lavaT += dt;
        if (ch._lavaT > 0.33) { ch._lavaT = 0; applyDamage(ch, 11.3, LAVA); }
        const wade = Math.max(0, 1 - 3 * dt);  // molten sludge — wading is slow
        ch.vel.x *= wade;
        ch.vel.z *= wade;
      } else ch._lavaT = null;
    }
  }

  // staying fully underwater too long starts drowning: 40s grace, then 5 hp/s
  if (G.world.waterZones) {
    for (const ch of G.characters) {
      if (!ch.alive) continue;
      const eyeY = ch.pos.y + (ch.eyeHeight ?? 1.55);
      const underwater = G.world.waterZones.some(zn =>
        pointInZoneXZ(zn, ch.pos.x, ch.pos.z) &&
        eyeY < zn.surfaceY - 0.04 &&
        ch.pos.y > (zn.bottomY ?? zn.surfaceY - 4) - 0.6);
      if (underwater) {
        ch._drownT = (ch._drownT || 0) + dt;
        if (ch._drownT > 40) {
          ch._drowning = true;
          ch._drownDamageT = (ch._drownDamageT || 0) + dt;
          while (ch._drownDamageT >= 1 && ch.alive) {
            ch._drownDamageT -= 1;
            applyDamage(ch, 5, WATER, { environmental: true, bypassShield: true });
          }
        } else {
          ch._drowning = false;
        }
      } else {
        const submergedSeconds = clearDrowningState(ch);
        // Ignore tiny surface bobbles, but make a real resurfacing unmistakable:
        // this cue means the local player's breath timer has fully reset.
        if (ch.isPlayer && submergedSeconds >= 0.75) sfx('gasp');
      }
    }
  }

  // fell into the void? (Escher maps: drifting off any edge counts, so a
  // radius from the play center catches sideways/upward falls too)
  const kc = G.world.killCenter, kr = G.world.killRadius;
  const killSpheres = G.world.killSpheres;
  for (const ch of G.characters) {
    if (!ch.alive) continue;
    const drifted = kc && ch.pos.distanceToSquared(kc) > kr * kr;
    const sunHit = killSpheres?.find(s =>
      ch.pos.distanceToSquared(s.center) <= s.radius * s.radius);
    const voided = ch.pos.y < G.world.killY || ch.pos.y > (G.world.killYTop ?? Infinity) || drifted;
    if (!voided && !sunHit) continue;
    ch.hp = 0;
    ch.jetpack = null;
    ch.grapple = false;
    if (ch.grappleViewmodel) ch.grappleViewmodel.visible = false;
    ch.dualBlaster = false;
    ch.syncDualBlasterViewmodel?.();
    ch.deaths++;
    const source = sunHit
      ? { id: 'solar', name: sunHit.name || 'The Sun', color: sunHit.color || '#ff8a24' }
      : { id: 'void', name: 'The Void', color: '#8899aa' };
    if (ch.isPlayer) {
      ch.alive = false; sfx('death'); hud.damageFlash();
      hud.showRespawn(
        true,
        RESPAWN_TIME,
        source.name,
        'ENVIRONMENT',
        environmentalEliminationText(source.id, source.name),
      );
      if (sunHit) hud.message('INCINERATED', sunHit.color || '#ff8a24');
    } else ch.die();
    hud.killfeed(source, ch);
    if (G.multiplayerHost) {
      queueMultiplayerEvent({
        type: 'kill', killerId: source.id, victimId: characterNetworkId(ch), weapon: 'environment',
      });
    }
    G.respawnTimers.set(ch, RESPAWN_TIME);
  }

  // respawns
  for (const [ch, t] of G.respawnTimers) {
    const left = t - dt;
    if (left <= 0) {
      G.respawnTimers.delete(ch);
      respawnCharacter(ch);
    } else {
      G.respawnTimers.set(ch, left);
      if (ch.isPlayer) hud.showRespawn(true, left);
    }
  }

  G.projectiles.update(dt, G.characters);
  G.pickups.update(dt, G.characters);
  checkEnd();
  G.fxPool.update(dt);
  updateDmgMarkers(dt);
  hud.update(dt, {
    player: G.player, mode: G.atrium ? 'atrium' : G.mode, scores: G.scores,
    characters: G.characters, timeLeft: G.timeLeft, showBoard: G.showBoard, world: G.world,
  });
  sendHostSnapshot(dt);
}

function serializeCharacter(ch, i) {
  const weapon = WEAPONS[ch.weapon] || WEAPONS.blaster;
  const warming = ch.warmupWeapon === ch.weapon && !!weapon.warmup;
  const weapons = WEAPON_ORDER.filter(id => ch.weapons?.[id]);
  const ammo = Object.fromEntries(weapons
    .filter(id => id !== 'blaster')
    .map(id => [id, Math.max(0, Math.floor(Number(ch.ammo?.[id]) || 0))]));
  return {
    id: ch.id || (ch.isPlayer ? multiplayer.slotId : `bot-${i}`),
    name: ch.isPlayer ? (multiplayer.name || ch.name || 'YOU') : ch.name,
    human: !!(ch.isPlayer || ch.remoteHuman),
    team: ch.team || ch.id || `bot-${i}`,
    color: ch.color || '#ffffff',
    pos: { x: ch.pos.x, y: ch.pos.y, z: ch.pos.z },
    vel: ch.vel ? { x: ch.vel.x, y: ch.vel.y, z: ch.vel.z } : { x: 0, y: 0, z: 0 },
    yaw: ch.yaw ?? ch.aimYaw ?? 0,
    pitch: ch.pitch ?? 0,
    up: ch.up ? { x: ch.up.x, y: ch.up.y, z: ch.up.z } : { x: 0, y: 1, z: 0 },
    hp: ch.hp ?? 100,
    shield: ch.shield ?? 0,
    alive: ch.alive !== false,
    score: ch.score || 0,
    kills: ch.kills || 0,
    deaths: ch.deaths || 0,
    awards: { ...(ch.awards || {}) },
    respawn: G.respawnTimers.get(ch) || 0,
    weapon: ch.weapon || 'blaster',
    weapons,
    ammo,
    damageMult: ch.damageMult ?? 1,
    powerup: ch.powerup
      ? { kind: ch.powerup.kind, timeLeft: Math.max(0, ch.powerup.timeLeft || 0) }
      : null,
    warmup: warming ? Math.max(0, Math.min(1, 1 - ch.warmupT / weapon.warmup)) : -1,
    jetpack: !!ch.jetpack,
    jetpackActive: !!ch.jetpack?.active,
    grapple: !!ch.grapple,
    dualBlaster: !!ch.dualBlaster,
    grappleAnchor: G.world.grappleEnabled && ch.grapple && ch.grappleAttached && ch.grappleAnchor
      ? { x: ch.grappleAnchor.x, y: ch.grappleAnchor.y, z: ch.grappleAnchor.z }
      : null,
  };
}

function serializeDrops() {
  if (!G?.pickups) return [];
  return G.pickups.items
    .filter(item => item.temporary && item.active && item.def?.pos)
    .map(item => ({
      id: item.def.id || dropSnapshotId(item.def),
      kind: item.def.kind,
      weapon: item.def.weapon,
      amount: item.def.amount || 0,
      timeLeft: item.def.timeLeft,
      pos: { x: item.def.pos.x, y: item.def.pos.y, z: item.def.pos.z },
      up: item.def.up ? { x: item.def.up.x, y: item.def.up.y, z: item.def.up.z } : { x: 0, y: 1, z: 0 },
    }));
}

function serializeScoreTargetCooldowns() {
  return (G?.world?.scoreTargets || [])
    .filter(target => target.cooldown > 0)
    .map(target => ({ id: target.id, cooldown: target.cooldown }));
}

function applyScoreTargetCooldowns(states) {
  if (!Array.isArray(states)) return;
  const cooldownById = new Map(states.map(state => [state.id, state.cooldown]));
  for (const target of G?.world?.scoreTargets || []) {
    target.setCooldown?.(cooldownById.get(target.id) || 0);
  }
}

function sendHostSnapshot(dt) {
  if (!G?.multiplayerHost || multiplayer.phase !== 'playing') return;
  const cadence = advanceNetworkTimer(G.mpSnapshotT, dt, MP_SNAPSHOT_HZ);
  G.mpSnapshotT = cadence.timer;
  if (!cadence.due) return;
  const players = G.characters.map((ch, i) => serializeCharacter(ch, i));
  const events = G.mpEvents?.slice(0, 32) || [];
  const sent = multiplayer.sendHostSnapshot({
    players,
    worldTime: G.world?._t || 0,
    scores: G.scores,
    ranked: players.slice().sort((a, b) => b.score - a.score || b.kills - a.kills || a.deaths - b.deaths),
    events,
    drops: serializeDrops(),
    pickups: G.pickups?.snapshotState?.() || [],
    targetCooldowns: serializeScoreTargetCooldowns(),
  });
  if (sent && events.length) G.mpEvents.splice(0, events.length);
}

function stepMultiplayer(dt) {
  G.timeLeft = Math.max(0, (multiplayer.phaseEndsAt - Date.now()) / 1000);
  setListener(G.player.pos);
  G.world.update?.(dt, G.characters);
  updateMeteorShower(dt);
  updateCometField(dt);
  updateImpactPickupPops(dt);
  G.world.updateDoors?.(G.characters, dt);
  updateStormAudio();
  const fire = (owner, origin, dir, weaponId) => G.projectiles.fire(owner, origin, dir, weaponId);
  const moveHook = G.world.postCharacterMove;
  if (moveHook) previousCharacterPos.copy(G.player.pos);
  G.player.update(dt, fire);
  if (moveHook) moveHook(G.player, previousCharacterPos);
  setJetpackThrust(!!(G.player.alive && G.player.jetpack?.active));
  updateMyceliumToadEffects(dt);
  G.projectiles.update(dt, G.characters);
  G.pickups.update(dt, [G.player]);
  G.fxPool.update(dt);
  updateDmgMarkers(dt);
  updateRemoteSlots(dt);
  syncMultiplayerNameTags();
  updateMultiplayerTracers(dt);
  if (G.mpSyncedSelf && G.player.alive) {
    const cadence = advanceNetworkTimer(G.mpSendT, dt, MP_INPUT_HZ);
    G.mpSendT = cadence.timer;
    if (cadence.due) multiplayer.sendInput(G.player);
  } else {
    G.mpSendT = 0;
  }
  hud.update(dt, {
    player: G.player, mode: G.mode, scores: G.scores,
    characters: G.characters, timeLeft: G.timeLeft, showBoard: G.showBoard, world: G.world,
  });
}

// Debug handles: inspect state / fast-forward the sim headlessly
if (Object.isExtensible(window)) {
window.__game = () => G;
window.__mp = () => ({
  isHost: multiplayer.isHost,
  shouldHost: multiplayer.shouldHost(),
  hostId: multiplayer.hostId,
  playerId: multiplayer.playerId,
  slotId: multiplayer.slotId,
  phase: multiplayer.phase,
  snapshotCount: multiplayer.snapshotCount,
  lastSnapshotAgeMs: multiplayer.lastSnapshotAt ? Math.round(performance.now() - multiplayer.lastSnapshotAt) : null,
  rttMs: Math.round(multiplayer.lastPong || 0),
  lastPongAgeMs: multiplayer.lastPongAt ? Math.round(performance.now() - multiplayer.lastPongAt) : null,
  bufferedBytes: multiplayer.ws?.bufferedAmount || 0,
  droppedInputs: multiplayer.droppedInputs,
  droppedSnapshots: multiplayer.droppedSnapshots,
  coalescedSnapshots: multiplayer.coalescedSnapshots,
  slots: multiplayer.slots,
  path: G?.multiplayerHost ? 'host-real-match' : G?.multiplayer ? 'client-renderer' : G?.atrium ? 'atrium' : 'singleplayer',
  characters: G?.characters?.map(c => ({ name: c.name, id: c.id, bot: !c.isPlayer && !c.remoteHuman, human: !!(c.isPlayer || c.remoteHuman) })) || [],
});
window.__bench = (frames = 60) => {
  renderer.info.autoReset = false;
  renderer.info.reset();
  renderFrame();
  const calls = renderer.info.render.calls, tris = renderer.info.render.triangles;
  renderer.info.autoReset = true;
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) renderFrame();
  return { msPerFrame: +((performance.now() - t0) / frames).toFixed(2),
    drawCalls: calls, triangles: tris, bloom: bloomPass.enabled, safari: performanceProfile.safari,
    shadows: renderer.shadowMap.enabled, pixelRatio: renderer.getPixelRatio(),
    adaptiveRenderScale: adaptiveRender.scale,
    postprocessing: !usesLightRenderPath(),
    lightRenderPath: usesLightRenderPath() };
};
window.__perf = () => {
  const percentile = (values, p) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(2);
  };
  const averageFrameMs = perfTelemetry.frameMs.length
    ? perfTelemetry.frameMs.reduce((sum, value) => sum + value, 0) / perfTelemetry.frameMs.length
    : null;
  return {
    targetFps: TARGET_FPS,
    hardFloorFps: FPS_FLOOR,
    sampledFps: averageFrameMs ? +(1000 / averageFrameMs).toFixed(1) : null,
    p95FrameMs: percentile(perfTelemetry.frameMs, 0.95),
    p95WorkMs: percentile(perfTelemetry.workMs, 0.95),
    samples: perfTelemetry.frameMs.length,
    highRefreshCadence: adaptiveRender.fastestFrameMs < FLOOR_FRAME_MS * 1.08,
    pixelRatio: renderer.getPixelRatio(),
    adaptiveRenderScale: adaptiveRender.scale,
    detectedAutoScale: adaptiveRender.detectedScale,
    visualTier: adaptiveRender.visualTier,
    graphicsMode,
    autoGraphicsTestStage,
    autoQualityLocked: graphicsMode === 'auto' && !autoGraphicsCalibrationOpen(),
  };
};
window.__renderPrograms = () => (renderer.info.programs || []).map(program => ({
  name: program.name,
  type: program.type,
  cacheKey: program.cacheKey,
  usedTimes: program.usedTimes,
}));
window.__mapVisualIssues = () => G?.world?.visualSurfaceIssues ?? [];
window.__mapVisualAudit = () => {
  const boxes = G?.world?._visualBoxes ?? [];
  return {
    unresolved: G?.world?.visualSurfaceIssues?.length ?? 0,
    wallFeatureOverlaps: G?.world?.wallFeatureIssues?.length ?? 0,
    resolvedConflicts: G?.world?.visualSurfaceConflicts?.length ?? 0,
    maxDepthLane: boxes.length ? Math.max(...boxes.map(box => box.depthLane ?? 0)) : 0,
  };
};
window.__mapDebug = () => ({
  map: G?.mapDef?.id ?? null,
  player: G?.player ? {
    position: G.player.pos.toArray(),
    velocity: G.player.vel.toArray(),
    grounded: G.player.grounded,
    toadEffectCooldown: G.player._toadEffectCooldown || 0,
    toadEffects: (G.player._toadEffects || []).map(effect => ({ ...effect })),
    hallucinating: !!G.hallucinating,
  } : null,
  toads: (G?.world?.myceliumToads || []).map((toad, index) => ({
    index,
    personality: toad.touchPersonality,
    position: toad.root.position.toArray(),
  })),
  mushroomPads: (G?.world?.jumpPads || [])
    .filter(pad => pad.kind === 'mushroom')
    .map(pad => ({ x: pad.x, y: pad.y, z: pad.z, vy: pad.vy, vx: pad.vx || 0, vz: pad.vz || 0 })),
  spawns: (G?.world?.spawns?.ffa || []).map(pos => pos.toArray()),
  pickups: (G?.world?.pickups || []).map(item => ({
    kind: item.kind,
    position: item.pos.toArray(),
  })),
});
window.__setGraphics = mode => {
  setGraphicsMode(mode, false, false, false);
  return window.__perf();
};
window.__step = (seconds) => {
  if (!G) return 'no game';
  const n = Math.floor(seconds / 0.016);
  for (let i = 0; i < n && G; i++) step(0.016);
  return G ? { time: G.timeLeft.toFixed(0), scores: { ...G.scores } } : 'match ended';
};
window.__start = (id, mode) => queueMapLoad(MAPS.find(m => m.id === id), mode || selectedMode);
window.__lobby = () => startAtrium();
window.__hall = () => startHallOfFame();
}

// Boot straight into the lobby — pick your arena by walking into its gate.
// Shared weapon/Atrium textures must settle before Player caches its materials;
// the remaining arena art continues in bounded idle slices once the lobby runs.
document.getElementById('menu').style.display = 'none';
const atriumLoadingToken = showMapLoading({ name: 'NERF ARENA BLAST' });
const updateAtriumLoading = () => {
  const { ready, total } = getSharedTextureLoadProgress();
  setMapLoadingProgress(
    total ? (ready / total) * 60 : 60,
    ready < total ? `Preparing shared assets (${ready}/${total})` : 'Shared assets ready',
    atriumLoadingToken,
  );
};
const stopAtriumLoadingProgress = onTextureLoadProgress(updateAtriumLoading);
sharedTexturesReady.then(async () => {
  stopAtriumLoadingProgress();
  if (atriumLoadingToken !== mapLoadingToken) return;
  updateAtriumLoading();
  await paintLoadingStage();
  if (atriumLoadingToken === mapLoadingToken) await startAtrium(atriumLoadingToken);
});
