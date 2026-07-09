// Game bootstrap: menu, match loop, damage/kills/powerups, input plumbing.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MAPS, buildAtrium, texturesReady } from './maps.js';
import { buildWaypointGraph, pick, rand, rampSurfaceY } from './engine.js';
import { Player } from './player.js';
import { Bot, BOT_NAMES, buildBotMesh } from './bots.js';
import { ProjectileSystem, FXPool, WEAPONS, WEAPON_ORDER, buildBlaster, nextLoadedWeaponAfter } from './weapons.js';
import { PickupManager } from './pickups.js';
import { HUD } from './hud.js';
import { sfx, setEffectsVolume, setListener, setMasterVolume, setRainAmbience } from './audio.js';
import { multiplayer } from './multiplayer.js';

const MATCH_TIME = 5 * 60; // no score limit — most points when time expires wins
const RESPAWN_TIME = 3;
const MULTIPLAYER_PODIUM_HOLD_MS = 6000;
const REMOTE_HUMAN_SNAP_DIST = 8;
const REMOTE_HUMAN_PREDICT_LEAD = 0.055;
const REMOTE_HUMAN_MAX_PREDICT = 0.18;
const REMOTE_HUMAN_SMOOTH = 20;
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

const FFA_COLORS = ['#5cb3ff', '#ff5c5c', '#6dff6d', '#ff8ce6', '#4dffd2', '#ff9c40', '#b06dff', '#e8e8f0'];
const LAVA = { name: 'Lava', color: '#ff6a30', isPlayer: false, kills: 0, team: 'lava' };
const WATER = { name: 'Water', color: '#3fcfff', isPlayer: false, kills: 0, team: 'water' };
const LIGHTNING = { name: 'Lightning', color: '#dff7ff', isPlayer: false, kills: 0, team: 'storm' };

function setText(el, value) {
  if (!el) return;
  const next = String(value);
  if (el.textContent !== next) el.textContent = next;
}

function setStyle(el, prop, value) {
  if (!el) return;
  const next = value == null ? '' : String(value);
  if (el.style[prop] !== next) el.style[prop] = next;
}

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
let musicIdx = Math.floor(Math.random() * MUSIC.length);
let currentTrackTitle = '';

function updateTrackTitle() {
  const el = document.getElementById('tracktitle');
  setText(el, currentTrackTitle || 'No track playing');
}

function nextMusicIndex() {
  if (MUSIC.length <= 1) return 0;
  let next = Math.floor(Math.random() * MUSIC.length);
  while (next === musicIdx) next = Math.floor(Math.random() * MUSIC.length);
  return next;
}

function playMusicIndex(idx) {
  const track = MUSIC[idx];
  if (!track || !musicEl) return;
  musicIdx = idx;
  currentTrackTitle = track.title;
  updateTrackTitle();
  musicEl.src = track.src;
  musicEl.play().catch(() => {}); // blocked until a user gesture — fine
}

function musicPlay() {
  if (!musicEl) {
    musicEl = new Audio();
    musicEl.volume = MUSIC_BASE_VOLUME * gameVolume * musicMix;
    musicEl.addEventListener('ended', () => {
      playMusicIndex(nextMusicIndex());
    });
  }
  playMusicIndex(nextMusicIndex());
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
const lowQuality = requestedQuality === 'low';
const performanceProfile = {
  safari: isSafari,
  pixelRatioCap: lowQuality ? 1 : 1.35,
  msaaSamples: lowQuality ? 0 : 2,
  shadows: !lowQuality,
  postprocessing: !lowQuality,
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
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
// Post-processing multiplies per-pixel cost — cap the internal resolution.
// (1.35× CSS pixels + 2× MSAA looks nearly identical to 2×/4× at half the GPU load.)
renderer.setPixelRatio(Math.min(devicePixelRatio, performanceProfile.pixelRatioCap));
renderer.shadowMap.enabled = performanceProfile.shadows;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.02;
renderer.outputColorSpace = THREE.SRGBColorSpace;
const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 900);

// Post-processing: MSAA render target → bloom on emissives → tonemap/output
const composer = new EffectComposer(renderer,
  new THREE.WebGLRenderTarget(1, 1, {
    samples: performanceProfile.msaaSamples,
    type: performanceProfile.postprocessing ? THREE.HalfFloatType : THREE.UnsignedByteType,
  }));
const renderPass = new RenderPass(new THREE.Scene(), camera);
const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.42, 0.58, 0.94);
bloomPass.enabled = performanceProfile.postprocessing;
composer.addPass(renderPass);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

// Soft studio environment for PBR reflections (metal medals, station panels)
const pmrem = new THREE.PMREMGenerator(renderer);
const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  composer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

function usesLightRenderPath() {
  return lowQuality;
}

function syncRenderQuality() {
  renderer.shadowMap.enabled = !usesLightRenderPath();
  bloomPass.enabled = performanceProfile.postprocessing && !usesLightRenderPath();
}

const hud = new HUD();
const underwaterFx = document.getElementById('underwaterFx');
const foliageFx = document.getElementById('foliageFx');
let G = null; // current match state (or the lobby)
let rafId = 0;
let selectedMode = 'ffa';
let openingMultiplayer = false;
let multiplayerVotingTimer = 0;
const lastSpawnByKey = new Map();
const lastSpawnFaceByKey = new Map();

function bindWorldPresentation(world, syncToMultiplayer = false) {
  if (!world?.runeEngine) return;
  if (syncToMultiplayer && Number.isFinite(multiplayer.phaseEndsAt)) {
    const remaining = Math.max(0, (multiplayer.phaseEndsAt - Date.now()) / 1000);
    world.runeTimeOffset = Math.max(0, MATCH_TIME - remaining);
  }
}

function modeLabel(mode = selectedMode) {
  return mode === 'tdm' ? 'MODE: TEAM DEATHMATCH' : 'MODE: FREE FOR ALL';
}

function syncAtriumModeSign(world = G?.world) {
  world?.setModeSign?.(modeLabel(selectedMode));
}

setInterval(() => {
  if (!G?.multiplayerHost || multiplayer.phase !== 'playing' || G.over) return;
  const now = performance.now();
  if (now - (G.lastStepWall || 0) < 120) return;
  const dt = Math.min(0.1, Math.max(0.016, (now - G.lastT) / 1000));
  G.lastT = now;
  G.lastStepWall = now;
  step(dt);
}, 100);

document.getElementById('againbtn').addEventListener('click', () => {
  setStyle(document.getElementById('endscreen'), 'display', 'none');
  endMatch(true);
});

/* ---------------- match setup ---------------- */
function teardown() {
  if (!G) return;
  setPauseScoreboardLayer(false);
  updateUnderwaterFx(1, true);
  updateFoliageFx(1, true);
  setRainAmbience(0);
  G.over = true;
  for (const ch of G.characters || []) disposeNameTag(ch);
  G.projectiles.clear();
  G.pickups.clear();
  G.fxPool.clear();
  if (G.mpTracers) {
    for (const tr of G.mpTracers) {
      tr.geo.dispose();
      tr.mat.dispose();
    }
  }
  camera.remove(G.player.viewmodel);
  hud.els.hud.classList.remove('endboard');
  setStyle(hud.els.board, 'display', 'none');
  setStyle(hud.els.board, 'top', '');
  setStyle(hud.els.board, 'zIndex', '');
  setStyle(hud.els.board, 'background', '');
  G.scene.clear();
  dmgMarkers = [];
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
    p.x >= z.minX && p.x <= z.maxX &&
    p.z >= z.minZ && p.z <= z.maxZ &&
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
      G.underwaterFogActive = false;
    }
    return;
  }

  if (active) {
    if (!scene.fog) scene.fog = new THREE.Fog(0x0a7aa0, 8, 70);
    scene.fog.color.set(0x0a7aa0);
    scene.fog.near = THREE.MathUtils.lerp(G.baseFog?.near ?? 120, 5, mix);
    scene.fog.far = THREE.MathUtils.lerp(G.baseFog?.far ?? 340, 42, mix);
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

function updateFoliageFx(dt, forceClear = false) {
  if (!G) return;
  const target = !forceClear && cameraInFoliage() ? 1 : 0;
  G.foliageMix = forceClear ? 0 : THREE.MathUtils.damp(G.foliageMix || 0, target, 18, dt);
  const mix = G.foliageMix;
  setStyle(foliageFx, 'opacity', mix > 0.01 ? String(0.72 * mix) : '0');
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
    }
    camera.position.copy(G.deathSpectate.pos);
    camera.lookAt(G.deathSpectate.anchor);
    return;
  }

  if (G.deathSpectate) {
    G.deathSpectate = null;
    if (G.player.viewmodel) G.player.viewmodel.visible = true;
  }
  if (Math.abs(camera.fov - G.deathBaseFov) > 0.01) {
    camera.fov = G.deathBaseFov;
    camera.updateProjectionMatrix();
  }
}

// THE LOBBY: a walkable atrium — stroll into a glowing gate to start a match.
function startAtrium() {
  teardown();
  musicStop();
  camera.fov = 75;
  camera.near = 0.1;
  camera.far = 900;
  camera.updateProjectionMatrix();
  const scene = new THREE.Scene();
  scene.environment = envTexture;
  const world = buildAtrium(scene);
  syncAtriumModeSign(world);
  world.spawnsAll = [...world.spawns.ffa];
  buildWaypointGraph(world);
  scene.add(camera);
  renderPass.scene = scene;

  const fxPool = new FXPool(scene);
  const player = new Player(camera, world);
  player.color = '#ffd23c';
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
    atrium: true, mapDef: null, mode: selectedMode, scene, world, player, characters,
    projectiles, pickups, fxPool,
    scores: { blue: 0, red: 0 },
    timeLeft: MATCH_TIME,
    respawnTimers: new Map(),
    over: false,
    paused: document.pointerLockElement !== canvas,
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
  renderer.compile(scene, camera);

  hud.show(true);
  hud.clearAwards();
  setStyle(document.getElementById('scores'), 'display', 'none');
  setText(document.getElementById('catchtitle'), 'CLICK TO PLAY');
  setStyle(clickcatch, 'display', document.pointerLockElement === canvas ? 'none' : 'flex');
  requestPointerLock();
  hud.message('WALK INTO A GATE TO ENTER AN ARENA', '#ffd23c');
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);
}

function startMatch(mapDef, mode = 'ffa') {
  teardown();
  camera.fov = 75;
  camera.near = 0.1;
  camera.far = 900;
  camera.updateProjectionMatrix();
  const scene = new THREE.Scene();
  scene.environment = envTexture;
  const world = mapDef.build(scene);
  bindWorldPresentation(world, false);
  world.spawnsAll = uniqueSpawnPoints([...world.spawns.blue, ...world.spawns.red, ...(world.spawns.ffa || [])]);
  buildWaypointGraph(world);
  scene.add(camera);
  renderPass.scene = scene;

  const fxPool = new FXPool(scene);
  const player = new Player(camera, world);
  player.color = '#ffd23c';

  const characters = [player];
  if (mode === 'tdm') {
    const teams = { blue: 3, red: 4 }; // player joins blue → 4v4
    let ni = 0;
    for (const team of ['blue', 'red']) {
      for (let i = 0; i < teams[team]; i++) {
        const bot = new Bot(scene, world, team, BOT_NAMES[ni++],
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
    for (let i = 0; i < 7; i++) {
      const bot = new Bot(scene, world, 'ffa-' + i, BOT_NAMES[i],
        parseInt(FFA_COLORS[i].slice(1), 16));
      bot.color = FFA_COLORS[i];
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
  });

  const pickups = new PickupManager(scene, world.pickups, { onPickup });

  world.onPad = (ch) => { if (ch.isPlayer) sfx('boing'); };
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
  world.getPickups = () => pickups.items; // bots window-shop the pickups

  G = {
    atrium: false, mapDef, mode, scene, world, player, characters, projectiles, pickups, fxPool,
    scores: { blue: 0, red: 0 },
    timeLeft: MATCH_TIME,
    respawnTimers: new Map(),
    over: false,
    paused: document.pointerLockElement !== canvas, // unpauses when the pointer locks
    showBoard: false,
    lastT: performance.now(),
  };
  syncRenderQuality();

  G.spawnBatchUsed = new Map();
  G.spawnBatchUsedFaces = new Map();
  for (const ch of characters) respawnCharacter(ch, true);
  G.spawnBatchUsed = null;
  G.spawnBatchUsedFaces = null;

  // Pre-warm every shader (incl. hidden viewmodels, powerup skins, projectile
  // and puff materials) so nothing compiles mid-match and causes a hitch.
  const probes = new THREE.Group();
  probes.visible = false;
  const probeGeo = new THREE.BoxGeometry(0.01, 0.01, 0.01);
  for (const id of Object.keys(WEAPONS)) {
    probes.add(new THREE.Mesh(probeGeo, projectiles.matFor(WEAPONS[id].color)));
  }
  probes.add(new THREE.Mesh(probeGeo,
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 })));
  scene.add(probes);
  renderer.compile(scene, camera);

  player.update(0, () => {});      // camera on the spawn point before the first tick
  hud.show(true);
  hud.clearAwards();
  setStyle(document.getElementById('scores'), 'display', '');
  setStyle(clickcatch, 'display', document.pointerLockElement === canvas ? 'none' : 'flex');
  requestPointerLock();
  musicPlay();
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);
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

function startMultiplayerMatch(mapDef, mode = multiplayer.mode || 'ffa') {
  teardown();
  camera.fov = 75;
  camera.near = 0.1;
  camera.far = 900;
  camera.updateProjectionMatrix();
  const scene = new THREE.Scene();
  scene.environment = envTexture;
  const world = mapDef.build(scene);
  bindWorldPresentation(world, true);
  world.spawnsAll = uniqueSpawnPoints([...world.spawns.blue, ...world.spawns.red, ...(world.spawns.ffa || [])]);
  buildWaypointGraph(world);
  scene.add(camera);
  renderPass.scene = scene;

  const fxPool = new FXPool(scene);
  const player = new Player(camera, world);
  const playerSlot = multiplayerSlotById();
  const playerTeam = multiplayerTeamForSlot(playerSlot, mode);
  player.id = multiplayer.slotId;
  player.color = multiplayerColorForTeam(playerTeam, '#ffd23c');
  player.team = playerTeam;
  player.name = multiplayer.name || 'YOU';
  player.score = 0;
  player.awards = {};
  player.killChain = null;

  const characters = [player];
  const projectiles = new ProjectileSystem(scene, world, {
    spawnPuff: (p, c, s) => fxPool.spawnPuff(p, c, s),
    characters: () => characters,
    onDamage: (target, dmg, attacker, ctx) => applyPredictedMultiplayerDamage(target, dmg, attacker, ctx),
  });
  const pickups = new PickupManager(scene, world.pickups, { onPickup });
  world.onPad = (ch) => { if (ch.isPlayer) sfx('boing'); };
  world.getPickups = () => pickups.items;

  G = {
    multiplayer: true, atrium: false, mapDef, mode, scene, world, player, characters,
    projectiles, pickups, fxPool,
    remoteSlots: new Map(),
    mpDropIds: new Set(),
    mpTracers: [],
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
  };
  syncRenderQuality();

  respawnCharacter(player, true);
  renderer.compile(scene, camera);
  player.update(0, () => {});
  hud.show(true);
  setStyle(document.getElementById('scores'), 'display', '');
  setStyle(document.getElementById('endscreen'), 'display', 'none');
  setText(document.getElementById('catchtitle'), 'CLICK TO RESUME');
  setStyle(clickcatch, 'display', document.pointerLockElement === canvas ? 'none' : 'flex');
  requestPointerLock();
  musicPlay();
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);
}

function startMultiplayerHostMatch(mapDef, mode = multiplayer.mode || 'ffa') {
  startMatch(mapDef, mode);
  if (!G) return;
  bindWorldPresentation(G.world, true);
  const playerSlot = multiplayerSlotById();
  const playerTeam = multiplayerTeamForSlot(playerSlot, mode);
  G.multiplayerHost = true;
  G.mpSnapshotT = 0;
  G.mpEvents = [];
  G.remoteInputs = new Map();
  G.remoteHumans = new Map();
  G.paused = false;
  setText(document.getElementById('catchtitle'), 'CLICK TO RESUME');
  setStyle(clickcatch, 'display', document.pointerLockElement === canvas ? 'none' : 'flex');
  G.player.id = multiplayer.slotId;
  G.player.name = multiplayer.name || 'YOU';
  G.player.color = multiplayerColorForTeam(playerTeam, '#ffd23c');
  G.player.team = playerTeam;
  addTeamMarker(G.player);
  let botIdx = 0;
  for (const ch of G.characters) {
    if (ch === G.player) continue;
    ch.id = `bot-${botIdx}`;
    botIdx++;
  }
  syncMultiplayerNameTags();
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
  const idx = G.characters.indexOf(ch);
  if (idx >= 0) G.characters.splice(idx, 1);
  disposeNameTag(ch);
  if (ch.mesh) G.scene.remove(ch.mesh);
  G.respawnTimers.delete(ch);
}

function addReplacementBot() {
  if (!G?.multiplayerHost || G.characters.length >= 8) return;
  const i = G.characters.filter(ch => !ch.isPlayer && !ch.remoteHuman).length;
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
    net.lastSeq = input.seq;
    if (ch.pos.distanceToSquared(rawPos) > REMOTE_HUMAN_SNAP_DIST * REMOTE_HUMAN_SNAP_DIST) {
      ch.pos.copy(rawPos);
    }
  }

  const lead = Math.min(REMOTE_HUMAN_MAX_PREDICT,
    Math.max(0, (now - net.lastInputAt) / 1000) + REMOTE_HUMAN_PREDICT_LEAD);
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
  if (input.up) ch.up.set(input.up.x || 0, input.up.y || 1, input.up.z || 0).normalize();
  if (input.weapon && (input.weapon === 'blaster' || (ch.weapons[input.weapon] && ch.ammo[input.weapon] > 0))) {
    ch.weapon = input.weapon;
  }
  ch.cooldown = Math.max(0, ch.cooldown - dt);
  if (input.firing && ch.cooldown <= 0) {
    const w = WEAPONS[ch.weapon] || WEAPONS.blaster;
    const cp = Math.cos(ch.pitch || 0);
    const dir = input.aim
      ? new THREE.Vector3(input.aim.x || 0, input.aim.y || 0, input.aim.z || -1).normalize()
      : new THREE.Vector3(
        -Math.sin(ch.yaw || 0) * cp,
        Math.sin(ch.pitch || 0),
        -Math.cos(ch.yaw || 0) * cp,
      ).normalize();
    const up = ch.up || new THREE.Vector3(0, 1, 0);
    const origin = ch.pos.clone().addScaledVector(up, 1.55).addScaledVector(dir, 0.8);
    fire(ch, origin, dir, ch.weapon || 'blaster');
    if (ch.weapon !== 'blaster') ch.ammo[ch.weapon]--;
    ch.cooldown = 1 / w.rof;
    if (ch.weapon !== 'blaster' && ch.ammo[ch.weapon] <= 0) {
      ch.weapon = nextLoadedWeaponAfter(ch.weapon, ch.weapons, ch.ammo);
    }
  }
  if (ch.mesh) {
    ch.syncGunModel?.();
    ch.mesh.position.copy(ch.pos);
    ch.mesh.rotation.y = ch.yaw || 0;
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
  sprite.userData.tex = tex;
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

function ensureRemoteSlot(state) {
  let remote = G.remoteSlots.get(state.id);
  if (remote) return remote;
  const { group } = buildBotMesh(parseInt(String(state.color || '#ffffff').replace('#', ''), 16));
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
    up: new THREE.Vector3(0, 1, 0),
    mesh: group,
    team: state.team || state.id,
    radius: 0.45,
    height: 1.8,
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
    weapons: { blaster: true },
    ammo: { blaster: Infinity },
    weapon: 'blaster',
    yaw: 0,
  };
  setNameTag(remote, remote.name, remote.color);
  G.remoteSlots.set(state.id, remote);
  G.characters.push(remote);
  return remote;
}

function applyMultiplayerSnapshot(snap) {
  if (!G?.multiplayer) return;
  G.mode = snap.mode || G.mode || 'ffa';
  if (snap.scores) G.scores = { blue: snap.scores.blue || 0, red: snap.scores.red || 0 };
  G.timeLeft = Math.max(0, (snap.phaseEndsAt - Date.now()) / 1000);
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
      if (state.hp < G.player.hp) hud.damageFlash();
      G.player.hp = state.hp;
      if (!state.alive && G.player.alive) {
        G.player.alive = false;
        G.mpSyncedSelf = false;
        hud.showRespawn(true, state.respawn || RESPAWN_TIME);
        sfx('death');
      } else if (state.alive && !G.player.alive) {
        G.player.spawn(statePos);
        G.mpSyncedSelf = true;
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
    remote.alive = state.alive;
    remote.score = state.score || 0;
    remote.kills = state.kills || 0;
    remote.deaths = state.deaths || 0;
    remote.awards = state.awards || remote.awards || {};
    remote.weapon = state.weapon || 'blaster';
    remote.yaw = state.yaw || 0;
    if (state.up) remote.up.set(state.up.x || 0, state.up.y || 1, state.up.z || 0).normalize();
    setNameTag(remote, remote.name, remote.color);
    remote.targetPos.set(state.pos.x, state.pos.y, state.pos.z);
    if (remote.pos.lengthSq() === 0) remote.pos.copy(remote.targetPos);
    remote.mesh.visible = state.alive;
  }
  for (const [id, remote] of G.remoteSlots) {
    if (seen.has(id)) continue;
    disposeNameTag(remote);
    G.scene.remove(remote.mesh);
    G.remoteSlots.delete(id);
    const idx = G.characters.indexOf(remote);
    if (idx >= 0) G.characters.splice(idx, 1);
  }
  for (const ev of snap.events || []) {
    if (ev.type === 'shot') spawnMultiplayerTracer(ev);
    if (ev.type === 'damage' && ev.attackerId === multiplayer.slotId) {
      hud.hitmarker();
      const target = G.characters.find(c => c.id === ev.targetId);
      if (target) spawnDmgMarker(target, ev.amount || 0);
    }
    if (ev.type === 'kill') {
      const killer = G.characters.find(c => c.team === ev.killerId || c.id === ev.killerId) ||
        (ev.killerId === multiplayer.slotId ? G.player : { name: 'The Void', color: '#8899aa' });
      const victim = G.characters.find(c => c.id === ev.victimId) ||
        (ev.victimId === multiplayer.slotId ? G.player : { name: 'Player', color: '#ccc' });
      hud.killfeed(killer, victim);
      if (ev.killerId === multiplayer.slotId) sfx('kill');
    }
    if (ev.type === 'award' && ev.playerId === multiplayer.slotId) {
      hud.award(ev.title, ev.sub || '', ev.color || '#ffd23c');
    }
  }
  reconcileMultiplayerDrops(snap.drops || []);
}

function applyPredictedMultiplayerDamage(target, dmg, attacker, ctx = {}) {
  if (!G?.multiplayer || attacker !== G.player || !target || target === G.player) return;
}

function dropSnapshotId(drop) {
  if (drop.id) return String(drop.id);
  const p = drop.pos || {};
  return `${drop.kind}:${drop.weapon || ''}:${drop.amount || 0}:${Math.round((p.x || 0) * 10)}:${Math.round((p.y || 0) * 10)}:${Math.round((p.z || 0) * 10)}`;
}

function reconcileMultiplayerDrops(drops) {
  if (!G?.multiplayer || !G.pickups) return;
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
      pos: new THREE.Vector3(drop.pos.x, drop.pos.y, drop.pos.z),
      up: drop.up ? new THREE.Vector3(drop.up.x || 0, drop.up.y || 1, drop.up.z || 0).normalize() : new THREE.Vector3(0, 1, 0),
    };
    const existing = G.pickups.items.find(item => item.mpDropId === id);
    if (existing) {
      existing.def.pos.copy(def.pos);
      existing.def.amount = def.amount;
      existing.def.weapon = def.weapon;
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

function queueMultiplayerEvent(ev) {
  if (!G?.multiplayerHost) return;
  G.mpEvents ||= [];
  G.mpEvents.push(ev);
  if (G.mpEvents.length > 80) G.mpEvents.splice(0, G.mpEvents.length - 80);
}

function recordMultiplayerShot(owner, origin, dir, weaponId) {
  if (!G?.multiplayerHost) return;
  const w = WEAPONS[weaponId] || WEAPONS.blaster;
  const to = origin.clone().addScaledVector(dir, Math.min(80, Math.max(24, w.speed * 0.45)));
  queueMultiplayerEvent({
    type: 'shot',
    shooterId: characterNetworkId(owner),
    weapon: weaponId,
    from: { x: origin.x, y: origin.y, z: origin.z },
    to: { x: to.x, y: to.y, z: to.z },
    color: `#${w.color.toString(16).padStart(6, '0')}`,
  });
}

function updateRemoteSlots(dt) {
  if (!G?.remoteSlots) return;
  const a = Math.min(1, dt * 14);
  for (const remote of G.remoteSlots.values()) {
    remote.pos.lerp(remote.targetPos, a);
    remote.mesh.position.copy(remote.pos);
    remote.mesh.rotation.y = remote.yaw || 0;
  }
}

function spawnMultiplayerTracer(ev) {
  if (!G?.multiplayer || !ev.from || !ev.to) return;
  const from = new THREE.Vector3(ev.from.x, ev.from.y, ev.from.z);
  const to = new THREE.Vector3(ev.to.x, ev.to.y, ev.to.z);
  const distSq = from.distanceToSquared(to);
  if (distSq < 0.01) return;
  const weaponId = WEAPONS[ev.weapon] ? ev.weapon : 'blaster';
  const weapon = WEAPONS[weaponId];
  const color = parseInt(String(ev.color || '#ffd23c').replace('#', ''), 16) || 0xffd23c;
  const pellets = Math.min(weapon.pellets || 1, 6);
  const dir = new THREE.Vector3().subVectors(to, from).normalize();
  const right = Math.abs(dir.y) > 0.9
    ? new THREE.Vector3(1, 0, 0)
    : new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, dir).normalize();
  const dist = Math.sqrt(distSq);
  const life = Math.min(0.2, Math.max(0.07, dist / Math.max(weapon.speed, 1)));
  for (let i = 0; i < pellets; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.95,
    });
    const mesh = new THREE.Mesh(G.projectiles.geoBall, mat);
    if (weapon.disc) mesh.scale.set(weapon.size * 1.5, weapon.size * 0.35, weapon.size * 1.5);
    else mesh.scale.setScalar(Math.max(weapon.size, 0.1));
    const pelletTo = to.clone();
    if (pellets > 1) {
      const spread = dist * 0.03;
      pelletTo
        .addScaledVector(right, rand(-spread, spread))
        .addScaledVector(up, rand(-spread, spread));
    }
    mesh.position.copy(from);
    G.scene.add(mesh);
    G.mpTracers.push({ mesh, mat, from: from.clone(), to: pelletTo, t: 0, life, impact: !!ev.hit, color });
  }
  G.fxPool.spawnPuff(from, color, 0.22);
}

function updateMultiplayerTracers(dt) {
  if (!G?.mpTracers) return;
  for (let i = G.mpTracers.length - 1; i >= 0; i--) {
    const tr = G.mpTracers[i];
    tr.t += dt;
    const done = tr.t >= tr.life;
    if (tr.mesh) {
      const a = Math.min(1, tr.t / tr.life);
      tr.mesh.position.lerpVectors(tr.from, tr.to, a);
      tr.mat.opacity = Math.max(0, 1 - a);
      if (done) {
        if (tr.impact) G.fxPool.spawnPuff(tr.to, tr.color, 0.45);
        G.scene.remove(tr.mesh);
        tr.mat.dispose();
        G.mpTracers.splice(i, 1);
      }
      continue;
    }
    tr.mat.opacity = Math.max(0, 1 - tr.t / tr.life);
    if (done) {
      G.scene.remove(tr.line);
      tr.geo.dispose();
      tr.mat.dispose();
      G.mpTracers.splice(i, 1);
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
    if (c.type !== 'box') continue;
    if (pos.x < c.min.x - sideSlack || pos.x > c.max.x + sideSlack ||
        pos.z < c.min.z - sideSlack || pos.z > c.max.z + sideSlack) continue;
    const drop = pos.y - c.max.y;
    if (drop >= -0.08 && drop <= footSlack) return true;
  }
  for (const ramp of G.world.ramps) {
    if (pos.x < ramp.minX - sideSlack || pos.x > ramp.maxX + sideSlack ||
        pos.z < ramp.minZ - sideSlack || pos.z > ramp.maxZ + sideSlack) continue;
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

function makeEndTextSprite(text, {
  color = '#7dff7d',
  stroke = 'rgba(0,0,0,.78)',
  bg = 'rgba(8,12,20,.55)',
  width = 768,
  height = 192,
  font = 'bold 46px "Arial Black", Arial',
  sub = '',
  subColor = '#dbe8ff',
  scale = [4.8, 1.2],
} = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, width, height);
  if (bg) {
    g.fillStyle = bg;
    g.beginPath();
    g.roundRect(12, 12, width - 24, height - 24, 20);
    g.fill();
  }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = font;
  g.lineWidth = 9;
  g.strokeStyle = stroke;
  g.strokeText(text, width / 2, sub ? height * 0.42 : height / 2);
  g.fillStyle = color;
  g.fillText(text, width / 2, sub ? height * 0.42 : height / 2);
  if (sub) {
    g.font = 'bold 28px Arial';
    g.lineWidth = 5;
    g.strokeStyle = stroke;
    g.strokeText(sub, width / 2, height * 0.72);
    g.fillStyle = subColor;
    g.fillText(sub, width / 2, height * 0.72);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
  }));
  sprite.scale.set(scale[0], scale[1], 1);
  sprite.userData.tex = tex;
  return sprite;
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

function buildPodiumAvatar(ch, place) {
  const { group } = buildBotMesh(colorHex(ch));
  const gun = buildBlaster(ch.weapon || 'blaster');
  gun.scale.setScalar(0.55);
  gun.position.set(0.32, 1.05, 0.25);
  gun.rotation.y = Math.PI;
  group.add(gun);
  group.traverse(obj => { if (obj.isMesh) obj.castShadow = true; });
  group.scale.setScalar(place === 0 ? 1.18 : 1.05);
  return group;
}

function podiumSurfaceYAt(x, z) {
  let y = null;
  const pad = 0.65;
  for (const c of G.world.colliders) {
    if (c.type !== 'box') continue;
    if (x < c.min.x - pad || x > c.max.x + pad || z < c.min.z - pad || z > c.max.z + pad) continue;
    if (y === null || c.max.y > y) y = c.max.y;
  }
  for (const ramp of G.world.ramps) {
    if (x < ramp.minX - pad || x > ramp.maxX + pad || z < ramp.minZ - pad || z > ramp.maxZ + pad) continue;
    const ry = rampSurfaceY(ramp, x, z);
    if (y === null || ry > y) y = ry;
  }
  return y;
}

function podiumAnchor() {
  const center = new THREE.Vector3();
  const candidates = [
    center,
    ...(G.world.waypoints || []).map(w => w.pos),
    ...(G.world.spawnsAll || []),
  ].sort((a, b) => (a.x * a.x + a.z * a.z) - (b.x * b.x + b.z * b.z));
  for (const c of candidates) {
    const y = podiumSurfaceYAt(c.x, c.z);
    if (y !== null && y > G.world.killY + 2) return new THREE.Vector3(c.x, y + 0.08, c.z);
  }
  return new THREE.Vector3(0, Math.max(0, G.world.killY + 8), 0);
}

function buildVictoryScene({ ranked, title, color, stats }) {
  const scene = G.scene;
  const anchor = podiumAnchor();
  const stage = new THREE.Group();
  stage.position.copy(anchor);
  scene.add(stage);

  camera.fov = 58;
  camera.near = 0.1;
  camera.far = 900;
  camera.updateProjectionMatrix();
  camera.position.copy(anchor).add(new THREE.Vector3(0, 4.2, 11.6));
  camera.lookAt(anchor.clone().add(new THREE.Vector3(0, 2.1, 0)));

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
  const avatars = [];
  pedestalSpecs.forEach((spec, i) => {
    podiumBox(stage, spec.x, spec.h / 2, 0, spec.w, spec.h, spec.d, spec.mat);
    podiumBox(stage, spec.x, spec.h + 0.05, 0, spec.w + 0.36, 0.1, spec.d + 0.36, green);
    const face = makePodiumRankSprite(i + 1, spec.medal);
    face.position.set(spec.x, spec.h * 0.5, spec.d / 2 + 0.1);
    face.renderOrder = 4;
    stage.add(face);

    const ch = ranked[i];
    if (!ch) return;
    const avatar = buildPodiumAvatar(ch, i);
    avatar.position.set(spec.x, spec.h + 0.02, -0.08);
    avatar.rotation.y = i === 1 ? -0.34 : i === 2 ? 0.34 : 0;
    stage.add(avatar);
    avatars.push({
      group: avatar,
      baseY: avatar.position.y,
      baseRotY: avatar.rotation.y,
      baseScale: avatar.scale.x,
      phase: i * 0.23,
      hopHeight: i === 0 ? 0.42 : 0.3,
      hopSpeed: i === 0 ? 1.55 : 1.35,
    });

    const name = makeEndTextSprite(ch.isPlayer ? 'YOU' : ch.name.toUpperCase(), {
      color: ch.color || '#ffffff',
      sub: `${ch.score} PTS`,
      bg: 'rgba(4,10,12,.46)',
      scale: [2.8, 0.7],
      font: 'bold 34px "Arial Black", Arial',
    });
    name.position.set(spec.x, spec.h + 3.0, 0.05);
    stage.add(name);
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

  scene.userData.end = {
    t: 0,
    avatars,
    anchor,
    confetti,
    lookAt: anchor.clone().add(new THREE.Vector3(0, 2.25, 0)),
  };
  return scene;
}

function showVictoryPodium(result) {
  const oldScene = G.scene;
  if (G.multiplayer || G.multiplayerHost) G.mpPodiumStartedAt ||= performance.now();
  G.over = true;
  G.showBoard = false;
  setPauseScoreboardLayer(false);
  hud.show(false);
  hud.els.hud.classList.add('endboard');
  setStyle(hud.els.board, 'display', 'none');
  hud.showRespawn(false);
  setStyle(clickcatch, 'display', 'none');
  setStyle(quitBtn, 'display', 'none');
  setStyle(volumeControl, 'display', 'none');
  setStyle(document.getElementById('scores'), 'display', 'none');

  for (const marker of dmgMarkers) {
    oldScene.remove(marker.sprite);
    marker.tex.dispose();
  }
  dmgMarkers = [];
  G.projectiles.clear();
  G.pickups.clear();
  G.fxPool.clear();
  camera.remove(G.player.viewmodel);
  for (const ch of G.characters) {
    if (!ch.isPlayer && ch.mesh) ch.mesh.visible = false;
  }

  const podiumScene = buildVictoryScene(result);
  G.scene = podiumScene;
  renderPass.scene = podiumScene;

  const end = document.getElementById('endscreen');
  setText(document.getElementById('endtitle'), result.title);
  setStyle(document.getElementById('endtitle'), 'color', result.color);
  setText(document.getElementById('endstats'), result.stats);
  setText(document.getElementById('endawards'), awardsLine(G.player.awards));
  setStyle(end, 'display', 'flex');
  document.exitPointerLock?.();
  sfx('powerup');
}

function updateVictoryPodium(dt) {
  const end = G.scene?.userData?.end;
  if (!end) return;
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
// target within a beat accumulate into one growing number.
let dmgMarkers = [];
function spawnDmgMarker(target, amount) {
  const recent = dmgMarkers.find(m => m.target === target && m.age < 0.4);
  if (recent) {
    recent.amount += amount;
    recent.age = 0;
    drawDmg(recent);
    return;
  }
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false, depthTest: false }));
  sprite.scale.set(1.7, 1.7, 1);
  sprite.position.set(target.pos.x, target.pos.y + 2.5, target.pos.z);
  G.scene.add(sprite);
  const m = { target, amount, age: 0, sprite, tex, canvas: c };
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
    m.sprite.position.y += dt * 1.1;
    m.sprite.material.opacity = Math.min(1, 2.5 * (1 - m.age / 0.9));
    if (m.age > 0.9) {
      G.scene.remove(m.sprite);
      m.tex.dispose();
      dmgMarkers.splice(i, 1);
    }
  }
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
  if (target.shield > 0) { // shield soaks damage first
    const absorbed = Math.min(target.shield, dmg);
    target.shield -= absorbed;
    dmg -= absorbed;
  }
  target.hp -= dmg;
  target.lastAttacker = attacker;  // getting shot reveals the shooter to bots
  target.alertTimer = 4;
  if (G.multiplayerHost && attacker && attacker !== target) {
    queueMultiplayerEvent({
      type: 'damage',
      attackerId: characterNetworkId(attacker),
      targetId: characterNetworkId(target),
      amount: rawDmg,
    });
  }
  if (attacker.isPlayer) { hud.hitmarker(); sfx('hit'); }
  if (target.isPlayer) { hud.damageFlash(); sfx('hurt'); }

  if (target.hp <= 0) {
    target.deaths++;
    attacker.kills++;
    recordKillAwards(attacker, target, ctx);
    dropPoints(target); // the points fall with the victim — go collect them
    for (const c of G.characters) {
      if (c.isPlayer || !c.noticeDrop || !c.alive) continue;
      // the killer always races for it; idle bystanders contest close drops
      if (c === attacker || (!c.target && c.pos.distanceTo(target.pos) < 18)) c.noticeDrop(target.pos);
    }
    hud.killfeed(attacker, target);
    G.fxPool.spawnPuff(new THREE.Vector3(target.pos.x, target.pos.y + 1, target.pos.z),
      target.team === 'blue' ? 0x5cb3ff : 0xff5c5c, 2);

    dropWeapon(target);
    if (target.isPlayer) {
      target.alive = false;
      sfx('death');
      hud.showRespawn(true, RESPAWN_TIME);
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
      if (def.kind === 'ammo' && cur >= cap) return false; // full — leave it
      const gain = def.kind === 'drop' ? def.amount : w.pickupAmmo;
      ch.ammo[def.weapon] = Math.min(cap, cur + gain);
      if (def.kind !== 'ammo') ch.weapons[def.weapon] = true; // ammo alone doesn't grant the gun
      if (ch.isPlayer) {
        sfx('pickup');
        announce(def.kind === 'ammo' ? `${w.name} AMMO` : `${w.name}!`, '#7fd0ff');
        if (def.kind !== 'ammo' && ch.weapon === 'blaster') ch.switchWeapon(def.weapon);
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
    case 'points':
      ch.score += def.amount;
      if (G.mode === 'tdm') G.scores[ch.team] += def.amount;
      if (ch.isPlayer) { sfx('coin'); announce(`+${def.amount} PTS!`, '#ffd23c'); }
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
      ch.damageMult = gold ? 3 : 2;
      ch.powerup = { kind: def.kind, timeLeft: 30 };
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
setGameVolume(gameVolume, false);
setMusicMix(musicMix, false);
setEffectsMix(effectsMix, false);
updateTrackTitle();

function setPauseScoreboardLayer(on) {
  const board = hud.els.board;
  const parent = on ? clickcatch : hud.els.hud;
  if (board.parentElement !== parent) parent.appendChild(board);
}

function requestPointerLock() {
  if (!canvas.requestPointerLock) return;
  try {
    const request = canvas.requestPointerLock({ unadjustedMovement: true });
    request?.catch?.(() => canvas.requestPointerLock());
  } catch {
    canvas.requestPointerLock();
  }
}

const quitBtn = document.getElementById('quitbtn');
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  if (G && !G.over) {
    const multiplayerMatch = !!(G.multiplayer || G.multiplayerHost);
    const multiplayerPanelOpen = multiplayer.overlay && !multiplayer.overlay.hidden;
    G.paused = multiplayerMatch ? false : !locked;
    setStyle(clickcatch, 'display', (locked || multiplayerPanelOpen) ? 'none' : 'flex');
    setText(document.getElementById('catchtitle'),
      locked ? '' : (multiplayerMatch ? 'CLICK TO RESUME' : '⏸ PAUSED — CLICK TO RESUME'));
    // pause menu extras (matches only): live scoreboard + quit
    const showPause = !locked && !G.atrium && !multiplayerPanelOpen;
    setStyle(quitBtn, 'display', showPause ? '' : 'none');
    setStyle(volumeControl, 'display', showPause ? 'block' : 'none');
    setText(quitBtn, multiplayerMatch ? 'EXIT MULTIPLAYER' : 'BACK TO ATRIUM');
    const board = hud.els.board;
    setPauseScoreboardLayer(showPause);
    setStyle(board, 'display', showPause ? 'block' : 'none');
    setStyle(board, 'top', showPause ? '27%' : '');    // scoreboard on top, resume mid, quit bottom
    setStyle(board, 'zIndex', showPause ? 4 : '');     // above the pause overlay
    setStyle(board, 'background', showPause ? 'rgba(10,12,30,.96)' : ''); // solid — the tint washed it out
    if (showPause) hud.renderBoard({ characters: G.characters, scores: G.scores, mode: G.mode });
  } else {
    setPauseScoreboardLayer(false);
    setStyle(clickcatch, 'display', 'none');
    setStyle(quitBtn, 'display', 'none');
    setStyle(volumeControl, 'display', 'none');
  }
});
clickcatch.addEventListener('click', requestPointerLock);
hud.els.board.addEventListener('click', (e) => e.stopPropagation());
hud.els.board.addEventListener('pointerdown', (e) => e.stopPropagation());
volumeControl.addEventListener('click', (e) => e.stopPropagation());
volumeControl.addEventListener('pointerdown', (e) => e.stopPropagation());
volumeSlider.addEventListener('input', () => setGameVolume(Number(volumeSlider.value) / 100));
musicSlider.addEventListener('input', () => setMusicMix(Number(musicSlider.value) / 100));
effectsSlider.addEventListener('input', () => setEffectsMix(Number(effectsSlider.value) / 100));
quitBtn.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();               // don't let the overlay re-lock the pointer
  e.stopImmediatePropagation();
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
  setStyle(clickcatch, 'display', document.pointerLockElement === canvas ? 'none' : 'flex');
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
  if (G && document.pointerLockElement === canvas && e.button === 0) G.player.firing = true;
});
document.addEventListener('mouseup', (e) => {
  if (G && e.button === 0) G.player.firing = false;
});
document.addEventListener('wheel', (e) => {
  if (G && document.pointerLockElement === canvas) G.player.cycleWeapon(e.deltaY > 0 ? 1 : -1);
});
document.addEventListener('keydown', (e) => {
  if (!G) return;
  G.player.keys[e.code] = true;
  if (e.code === 'Space') { G.player.wantJump = true; e.preventDefault(); }
  if (e.code === 'Tab') { G.showBoard = true; e.preventDefault(); }
  const slot = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9'].indexOf(e.code);
  if (slot >= 0) G.player.switchWeapon(WEAPON_ORDER[slot]);
  if (e.code === 'KeyG') { // glow toggle for slower machines
    if (!performanceProfile.postprocessing) {
      hud.message('GLOW OFF FOR SAFARI PERFORMANCE', '#7fd0ff');
    } else {
      bloomPass.enabled = !bloomPass.enabled;
      hud.message(bloomPass.enabled ? 'GLOW ON' : 'GLOW OFF', '#7fd0ff');
    }
  }
});
document.addEventListener('keyup', (e) => {
  if (!G) return;
  G.player.keys[e.code] = false;
  if (e.code === 'Tab') G.showBoard = false;
});

function startCurrentMultiplayerMatch(mapId, force = false, mode = multiplayer.mode || 'ffa') {
  clearTimeout(multiplayerVotingTimer);
  setStyle(document.getElementById('endscreen'), 'display', 'none');
  setStyle(clickcatch, 'display', 'none');
  setStyle(quitBtn, 'display', 'none');
  setStyle(volumeControl, 'display', 'none');
  setStyle(hud.els.board, 'display', 'none');
  const map = MAPS.find(m => m.id === mapId) || MAPS[0];
  const endedMultiplayerMatch = !!(G?.over && (G.multiplayer || G.multiplayerHost));
  if (multiplayer.shouldHost()) {
    if (force || endedMultiplayerMatch || !G?.multiplayerHost || G.mapDef?.id !== map.id || G.mode !== mode) {
      startMultiplayerHostMatch(map, mode);
    }
  } else if (force || endedMultiplayerMatch || !G?.multiplayer || G.mapDef?.id !== map.id || G.mode !== mode) {
    startMultiplayerMatch(map, mode);
  }
}

multiplayer.addEventListener('joined', (e) => {
  if (e.detail.phase === 'playing') {
    const slotChanged = !!G?.player?.id && G.player.id !== e.detail.slotId;
    const roleMismatch = multiplayer.shouldHost() ? !G?.multiplayerHost : !G?.multiplayer;
    startCurrentMultiplayerMatch(e.detail.mapId, slotChanged || roleMismatch, e.detail.mode || multiplayer.mode || 'ffa');
  } else if (G?.multiplayer || G?.multiplayerHost) {
    hud.message('MULTIPLAYER LOBBY REJOINED', '#ffd23c');
    endMatch(true);
  }
});

multiplayer.addEventListener('exit', () => {
  popOutOfMultiplayerPortal();
});

multiplayer.addEventListener('phase', (e) => {
  const { phase, mapId, ranked, scores } = e.detail;
  if (phase === 'playing') {
    startCurrentMultiplayerMatch(mapId, false, e.detail.mode || multiplayer.mode || 'ffa');
  } else if (phase === 'podium' && (G?.multiplayer || G?.multiplayerHost)) {
    clearTimeout(multiplayerVotingTimer);
    G.mpPodiumStartedAt = performance.now();
    if (G.over && G.scene?.userData?.end) return;
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
    const startedAt = G?.mpPodiumStartedAt || 0;
    const wait = startedAt ? Math.max(0, MULTIPLAYER_PODIUM_HOLD_MS - (performance.now() - startedAt)) : 0;
    clearTimeout(multiplayerVotingTimer);
    multiplayerVotingTimer = setTimeout(() => {
      setStyle(document.getElementById('endscreen'), 'display', 'none');
      if (!G?.atrium) startAtrium();
      document.exitPointerLock?.();
      if (G) G.paused = true;
    }, wait);
  }
});

multiplayer.addEventListener('snapshot', (e) => {
  if (multiplayer.shouldHost()) return;
  if (e.detail.phase === 'playing' && (!G || !G.multiplayer || G.over || G.mapDef?.id !== e.detail.mapId)) {
    const map = MAPS.find(m => m.id === e.detail.mapId) || MAPS[0];
    startMultiplayerMatch(map, e.detail.mode || multiplayer.mode || 'ffa');
  }
  applyMultiplayerSnapshot(e.detail);
});

multiplayer.addEventListener('remoteInput', (e) => {
  if (!G?.multiplayerHost) return;
  G.remoteInputs ||= new Map();
  G.remoteInputs.set(e.detail.slotId, { ...e.detail.input, receivedAt: performance.now() });
});

multiplayer.addEventListener('hostChanged', () => {
  if (multiplayer.phase !== 'playing') return;
  const map = MAPS.find(m => m.id === multiplayer.mapId) || MAPS[0];
  if (multiplayer.shouldHost()) {
    if (!G?.multiplayerHost) startMultiplayerHostMatch(map, multiplayer.mode || 'ffa');
  } else if (G?.multiplayerHost) {
    startMultiplayerMatch(map, multiplayer.mode || 'ffa');
  }
});

multiplayer.addEventListener('connectionLost', () => {
  if (G?.multiplayer || G?.multiplayerHost) {
    hud.message('CONNECTION LOST — REJOINING...', '#ffd23c');
  }
});

multiplayer.addEventListener('reconnected', () => {
  if (G?.multiplayer || G?.multiplayerHost) {
    hud.message('MULTIPLAYER REJOINED', '#6dff6d');
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
  const dt = Math.min(0.05, (now - G.lastT) / 1000);
  G.lastT = now;
  if (!G.paused) {
    G.lastStepWall = now;
    step(dt);
  }
  updateDeathCamera(dt);
  updateUnderwaterFx(dt);
  updateFoliageFx(dt);
  renderFrame();
  if (G.pendingMap) { // walked into a lobby gate — swap to that arena
    const map = G.pendingMap;
    startMatch(map, selectedMode);
    return; // startMatch scheduled its own loop
  }
  rafId = requestAnimationFrame(tick);
}

function renderFrame() {
  if (performanceProfile.postprocessing && !usesLightRenderPath()) composer.render();
  else renderer.render(renderPass.scene, camera);
}

// Lobby-only logic: gate triggers and the mode toggle pad
function stepAtrium(dt) {
  G.padCooldown -= dt;
  const mp = G.world.multiplayerPortal;
  if (mp && !openingMultiplayer &&
      Math.hypot(G.player.pos.x - mp.x, G.player.pos.z - mp.z) < 2.8) {
    openingMultiplayer = true;
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
    if (Math.hypot(G.player.pos.x - p.x, G.player.pos.z - p.z) < 2.6) {
      G.pendingMap = MAPS.find(m => m.id === p.map);
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

function updateStormAudio() {
  setRainAmbience(G?.world?.storm?.mix || 0);
}

function step(dt) {
  if (G.over) {
    updateVictoryPodium(dt);
    return;
  }

  if (G.multiplayer) {
    stepMultiplayer(dt);
    return;
  }

  if (G.atrium) stepAtrium(dt);
  else G.timeLeft -= dt;
  setListener(G.player.pos); // distance-based sfx volume

  G.world.update?.(dt, G.characters);
  updateStormAudio();
  if (G.multiplayerHost) {
    syncRemoteHumans();
    syncMultiplayerNameTags();
  }

  const fire = (owner, origin, dir, weaponId) => {
    G.projectiles.fire(owner, origin, dir, weaponId);
    recordMultiplayerShot(owner, origin, dir, weaponId);
  };
  G.player.update(dt, fire);
  for (const ch of G.characters) {
    if (!ch.isPlayer) {
      if (ch.remoteHuman) updateRemoteHuman(ch, dt, fire);
      else ch.update(dt, G.characters, fire);
    }
  }

  G.world.updateDoors?.(G.characters, dt); // proximity doors (Labyrinth)

  // lava burns ~34 hp/s in three pulses per second
  if (G.world.lavaZones) {
    for (const ch of G.characters) {
      if (!ch.alive) continue;
      const burning = G.world.lavaZones.some(zn =>
        ch.pos.x > zn.minX && ch.pos.x < zn.maxX &&
        ch.pos.z > zn.minZ && ch.pos.z < zn.maxZ && ch.pos.y < zn.maxY);
      if (burning) {
        ch._lavaT = (ch._lavaT || 0) + dt;
        if (ch._lavaT > 0.33) { ch._lavaT = 0; applyDamage(ch, 11.3, LAVA); }
        const wade = Math.max(0, 1 - 3 * dt);  // molten sludge — wading is slow
        ch.vel.x *= wade;
        ch.vel.z *= wade;
      } else ch._lavaT = 0;
    }
  }

  // staying fully underwater too long starts drowning: 40s grace, then 5 hp/s
  if (G.world.waterZones) {
    for (const ch of G.characters) {
      if (!ch.alive) continue;
      const eyeY = ch.pos.y + (ch.eyeHeight ?? 1.55);
      const underwater = G.world.waterZones.some(zn =>
        ch.pos.x > zn.minX && ch.pos.x < zn.maxX &&
        ch.pos.z > zn.minZ && ch.pos.z < zn.maxZ &&
        eyeY < zn.surfaceY - 0.04 &&
        ch.pos.y > (zn.bottomY ?? zn.surfaceY - 4) - 0.6);
      if (underwater) {
        ch._drownT = (ch._drownT || 0) + dt;
        if (ch._drownT > 40) {
          ch._drownDamageT = (ch._drownDamageT || 0) + dt;
          while (ch._drownDamageT >= 1 && ch.alive) {
            ch._drownDamageT -= 1;
            applyDamage(ch, 5, WATER);
          }
        }
      } else {
        ch._drownT = 0;
        ch._drownDamageT = 0;
      }
    }
  }

  // fell into the void? (Escher maps: drifting off any edge counts, so a
  // radius from the play center catches sideways/upward falls too)
  const kc = G.world.killCenter, kr = G.world.killRadius;
  for (const ch of G.characters) {
    const drifted = kc && ch.pos.distanceToSquared(kc) > kr * kr;
    if (ch.alive && (ch.pos.y < G.world.killY || ch.pos.y > (G.world.killYTop ?? Infinity) || drifted)) {
      ch.hp = 0;
      ch.deaths++;
      if (ch.isPlayer) {
        ch.alive = false; sfx('death'); hud.damageFlash(); hud.showRespawn(true, RESPAWN_TIME);
      } else ch.die();
      hud.killfeed({ name: 'The Void', color: '#8899aa' }, ch);
      G.respawnTimers.set(ch, RESPAWN_TIME);
    }
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
  return {
    id: ch.id || (ch.isPlayer ? multiplayer.slotId : `bot-${i}`),
    name: ch.isPlayer ? (multiplayer.name || ch.name || 'YOU') : ch.name,
    human: !!(ch.isPlayer || ch.remoteHuman),
    team: ch.team || ch.id || `bot-${i}`,
    color: ch.color || '#ffffff',
    pos: { x: ch.pos.x, y: ch.pos.y, z: ch.pos.z },
    yaw: ch.yaw ?? ch.aimYaw ?? 0,
    pitch: ch.pitch ?? 0,
    up: ch.up ? { x: ch.up.x, y: ch.up.y, z: ch.up.z } : { x: 0, y: 1, z: 0 },
    hp: ch.hp ?? 100,
    alive: ch.alive !== false,
    score: ch.score || 0,
    kills: ch.kills || 0,
    deaths: ch.deaths || 0,
    awards: { ...(ch.awards || {}) },
    respawn: G.respawnTimers.get(ch) || 0,
    weapon: ch.weapon || 'blaster',
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
      pos: { x: item.def.pos.x, y: item.def.pos.y, z: item.def.pos.z },
      up: item.def.up ? { x: item.def.up.x, y: item.def.up.y, z: item.def.up.z } : { x: 0, y: 1, z: 0 },
    }));
}

function sendHostSnapshot(dt) {
  if (!G?.multiplayerHost || multiplayer.phase !== 'playing') return;
  G.mpSnapshotT = (G.mpSnapshotT || 0) - dt;
  if (G.mpSnapshotT > 0) return;
  G.mpSnapshotT = 1 / 20;
  const players = G.characters.map((ch, i) => serializeCharacter(ch, i));
  multiplayer.sendHostSnapshot({
    players,
    scores: G.scores,
    ranked: players.slice().sort((a, b) => b.score - a.score || b.kills - a.kills || a.deaths - b.deaths),
    events: G.mpEvents?.splice(0, 32) || [],
    drops: serializeDrops(),
  });
}

function stepMultiplayer(dt) {
  G.timeLeft = Math.max(0, (multiplayer.phaseEndsAt - Date.now()) / 1000);
  setListener(G.player.pos);
  G.world.update?.(dt, G.characters);
  G.world.updateDoors?.(G.characters, dt);
  updateStormAudio();
  const fire = (owner, origin, dir, weaponId) => G.projectiles.fire(owner, origin, dir, weaponId);
  G.player.update(dt, fire);
  G.projectiles.update(dt, G.characters);
  G.pickups.update(dt, [G.player]);
  G.fxPool.update(dt);
  updateDmgMarkers(dt);
  updateRemoteSlots(dt);
  syncMultiplayerNameTags();
  updateMultiplayerTracers(dt);
  G.mpSendT -= dt;
  if (G.mpSendT <= 0 && G.mpSyncedSelf && G.player.alive) {
    G.mpSendT = 1 / 30;
    multiplayer.sendInput(G.player);
  }
  hud.update(dt, {
    player: G.player, mode: G.mode, scores: G.scores,
    characters: G.characters, timeLeft: G.timeLeft, showBoard: G.showBoard, world: G.world,
  });
}

// Debug handles: inspect state / fast-forward the sim headlessly
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
    postprocessing: performanceProfile.postprocessing && !usesLightRenderPath(),
    lightRenderPath: usesLightRenderPath() };
};
window.__step = (seconds) => {
  if (!G) return 'no game';
  const n = Math.floor(seconds / 0.016);
  for (let i = 0; i < n && G; i++) step(0.016);
  return G ? { time: G.timeLeft.toFixed(0), scores: { ...G.scores } } : 'match ended';
};
window.__start = (id, mode) => startMatch(MAPS.find(m => m.id === id), mode || selectedMode);
window.__lobby = () => startAtrium();

// Boot straight into the lobby — pick your arena by walking into its gate.
// (Wait for textures so the first build isn't placeholder canvases; 3s cap.)
document.getElementById('menu').style.display = 'none';
Promise.race([texturesReady, new Promise(r => setTimeout(r, 3000))]).then(() => startAtrium());
