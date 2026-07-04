// Game bootstrap: menu, match loop, damage/kills/powerups, input plumbing.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { MAPS } from './maps.js';
import { buildWaypointGraph, pick, rand } from './engine.js';
import { Player } from './player.js';
import { Bot, BOT_NAMES } from './bots.js';
import { ProjectileSystem, FXPool, WEAPONS, WEAPON_ORDER } from './weapons.js';
import { PickupManager } from './pickups.js';
import { HUD } from './hud.js';
import { sfx } from './audio.js';

const MATCH_TIME = 7 * 60; // no score limit — most points when time expires wins
const RESPAWN_TIME = 3;

const FFA_COLORS = ['#5cb3ff', '#ff5c5c', '#6dff6d', '#ff8ce6', '#4dffd2', '#ff9c40', '#b06dff', '#e8e8f0'];

const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
// Post-processing multiplies per-pixel cost — cap the internal resolution.
// (1.35× CSS pixels + 2× MSAA looks nearly identical to 2×/4× at half the GPU load.)
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.35));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 900);

// Post-processing: MSAA render target → bloom on emissives → tonemap/output
const composer = new EffectComposer(renderer,
  new THREE.WebGLRenderTarget(1, 1, { samples: 2, type: THREE.HalfFloatType }));
const renderPass = new RenderPass(new THREE.Scene(), camera);
const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.35, 0.5, 0.9);
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

const hud = new HUD();
let G = null; // current match state

/* ---------------- menu ---------------- */
const menuEl = document.getElementById('menu');
const mapsEl = document.getElementById('maps');
let selectedMode = 'ffa';
for (const btn of document.querySelectorAll('.modebtn')) {
  btn.addEventListener('click', () => {
    selectedMode = btn.dataset.mode;
    for (const b of document.querySelectorAll('.modebtn')) b.classList.toggle('active', b === btn);
    document.getElementById('menusub').textContent = selectedMode === 'ffa'
      ? 'FREE FOR ALL · 7 MINUTES' : 'TEAM DEATHMATCH · 7 MINUTES';
  });
}
for (const map of MAPS) {
  const card = document.createElement('div');
  card.className = 'mapcard';
  card.innerHTML = `
    <div class="mapthumb" style="background:${map.thumb}">${map.emoji}</div>
    <h2>${map.name}</h2><p>${map.desc}</p>`;
  card.addEventListener('click', () => startMatch(map, selectedMode));
  mapsEl.appendChild(card);
}

document.getElementById('againbtn').addEventListener('click', () => {
  document.getElementById('endscreen').style.display = 'none';
  endMatch(true);
});

/* ---------------- match setup ---------------- */
function startMatch(mapDef, mode = 'ffa') {
  const scene = new THREE.Scene();
  scene.environment = envTexture;
  const world = mapDef.build(scene);
  world.spawnsAll = [...world.spawns.blue, ...world.spawns.red, ...(world.spawns.ffa || [])];
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
  for (const ch of characters) ch.score = 0;

  const projectiles = new ProjectileSystem(scene, world, {
    spawnPuff: (p, c, s) => fxPool.spawnPuff(p, c, s),
    characters: () => characters,
    onDamage: (target, dmg, attacker) => applyDamage(target, dmg, attacker),
  });

  const pickups = new PickupManager(scene, world.pickups, { onPickup });

  world.onPad = (ch) => { if (ch.isPlayer) sfx('boing'); };
  world.getPickups = () => pickups.items; // bots window-shop the pickups

  G = {
    mapDef, mode, scene, world, player, characters, projectiles, pickups, fxPool,
    scores: { blue: 0, red: 0 },
    timeLeft: MATCH_TIME,
    respawnTimers: new Map(),
    over: false,
    paused: true, // unpauses when the pointer locks
    showBoard: false,
    lastT: performance.now(),
  };

  for (const ch of characters) respawnCharacter(ch, true);

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

  menuEl.style.display = 'none';
  hud.show(true);
  document.getElementById('clickcatch').style.display = 'flex';
  requestPointerLock();
  requestAnimationFrame(tick);
}

function endMatch(toMenu) {
  if (!G) return;
  G.over = true;
  G.projectiles.clear();
  G.pickups.clear();
  G.fxPool.clear();
  camera.remove(G.player.viewmodel);
  G.scene.clear();
  G = null;
  hud.show(false);
  document.exitPointerLock?.();
  if (toMenu) menuEl.style.display = 'flex';
}

function respawnCharacter(ch, initial = false) {
  const spawns = G.mode === 'tdm' ? G.world.spawns[ch.team] : G.world.spawnsAll;
  // prefer spawn points away from living enemies — but pick randomly among the
  // safest few so you don't respawn in the same spot every time
  const scored = spawns.map(s => {
    let nearest = Infinity;
    for (const e of G.characters) {
      if (e.team === ch.team || !e.alive) continue;
      nearest = Math.min(nearest, e.pos.distanceToSquared(s));
    }
    return { s, nearest };
  }).sort((a, b) => b.nearest - a.nearest);
  const best = pick(scored.slice(0, Math.max(3, Math.floor(scored.length / 3)))).s;
  const p = best.clone();
  p.x += rand(-1, 1); p.z += rand(-1, 1);
  ch.spawn(p);
  if (ch.isPlayer && !initial) hud.showRespawn(false);
}

/* ---------------- damage & kills ---------------- */
function applyDamage(target, dmg, attacker) {
  if (!target.alive || G.over) return;
  if (target.shield > 0) { // shield soaks damage first
    const absorbed = Math.min(target.shield, dmg);
    target.shield -= absorbed;
    dmg -= absorbed;
  }
  target.hp -= dmg;
  target.lastAttacker = attacker;  // getting shot reveals the shooter to bots
  target.alertTimer = 4;
  if (attacker.isPlayer) { hud.hitmarker(); sfx('hit'); }
  if (target.isPlayer) { hud.damageFlash(); sfx('hurt'); }

  if (target.hp <= 0) {
    target.deaths++;
    attacker.kills++;
    dropPoints(target); // the points fall with the victim — go collect them
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
    }
    if (attacker.isPlayer) sfx('kill');
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
  G.pickups.addDrop({ kind: 'points', amount, pos: victim.pos.clone() });
}

// The victim's active weapon (with its remaining ammo) falls where they died.
function dropWeapon(ch) {
  if (ch.weapon === 'blaster' || !(ch.ammo[ch.weapon] > 0)) return;
  if (ch.pos.y < G.world.killY + 10) return; // falling into the void takes it with you
  G.pickups.addDrop({
    kind: 'drop', weapon: ch.weapon, amount: ch.ammo[ch.weapon],
    pos: ch.pos.clone(),
  });
}

function checkEnd() {
  if (G.over) return;
  if (G.timeLeft > 0) return; // matches run the full clock
  let title, color, stats;
  const playerStats = `You: ${G.player.kills} kills / ${G.player.deaths} deaths`;
  if (G.mode === 'tdm') {
    const { blue, red } = G.scores;
    title = blue === red ? 'DRAW!' : (blue > red ? 'BLUE TEAM WINS!' : 'RED TEAM WINS!');
    color = blue === red ? '#ffd23c' : (blue > red ? '#5cb3ff' : '#ff5c5c');
    stats = `BLUE ${blue} — ${red} RED · ${playerStats}`;
  } else {
    const ranked = [...G.characters].sort((a, b) => b.score - a.score);
    const leader = ranked[0];
    title = leader.isPlayer ? 'YOU WIN!' : `${leader.name.toUpperCase()} WINS!`;
    color = leader.color;
    const rank = ranked.indexOf(G.player) + 1;
    stats = `Winner: ${leader.name} with ${leader.score} · You placed #${rank} with ${G.player.score} · ${playerStats}`;
  }
  const end = document.getElementById('endscreen');
  document.getElementById('endtitle').textContent = title;
  document.getElementById('endtitle').style.color = color;
  document.getElementById('endstats').textContent = stats;
  end.style.display = 'flex';
  document.exitPointerLock?.();
  G.over = true;
  sfx('powerup');
}

/* ---------------- pickups ---------------- */
function onPickup(ch, def) {
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

function requestPointerLock() {
  canvas.requestPointerLock?.();
}

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  if (G && !G.over) {
    G.paused = !locked;              // Esc releases the pointer → game pauses
    clickcatch.style.display = locked ? 'none' : 'flex';
    document.getElementById('catchtitle').textContent =
      locked ? '' : '⏸ PAUSED — CLICK TO RESUME';
  } else {
    clickcatch.style.display = 'none';
  }
});
clickcatch.addEventListener('click', requestPointerLock);

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
  const slot = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7'].indexOf(e.code);
  if (slot >= 0) G.player.switchWeapon(WEAPON_ORDER[slot]);
  if (e.code === 'KeyG') { // glow toggle for slower machines
    bloomPass.enabled = !bloomPass.enabled;
    hud.message(bloomPass.enabled ? 'GLOW ON' : 'GLOW OFF', '#7fd0ff');
  }
});
document.addEventListener('keyup', (e) => {
  if (!G) return;
  G.player.keys[e.code] = false;
  if (e.code === 'Tab') G.showBoard = false;
});

/* ---------------- main loop ---------------- */
function tick(now) {
  if (!G) return;
  const dt = Math.min(0.05, (now - G.lastT) / 1000);
  G.lastT = now;
  if (!G.paused) step(dt);
  composer.render();
  requestAnimationFrame(tick);
}

function step(dt) {
  if (!G.over) {
    G.timeLeft -= dt;

    const fire = (owner, origin, dir, weaponId) => G.projectiles.fire(owner, origin, dir, weaponId);
    G.player.update(dt, fire);
    for (const ch of G.characters) {
      if (!ch.isPlayer) ch.update(dt, G.characters, fire);
    }

    // fell into the void?
    for (const ch of G.characters) {
      if (ch.alive && ch.pos.y < G.world.killY) {
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
  }

  G.world.update?.(dt);
  G.fxPool.update(dt);
  hud.update(dt, {
    player: G.player, mode: G.mode, scores: G.scores,
    characters: G.characters, timeLeft: G.timeLeft, showBoard: G.showBoard,
  });
}

// Debug handles: inspect state / fast-forward the sim headlessly
window.__game = () => G;
window.__bench = (frames = 60) => {
  renderer.info.autoReset = false;
  renderer.info.reset();
  composer.render();
  const calls = renderer.info.render.calls, tris = renderer.info.render.triangles;
  renderer.info.autoReset = true;
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) composer.render();
  return { msPerFrame: +((performance.now() - t0) / frames).toFixed(2),
    drawCalls: calls, triangles: tris, bloom: bloomPass.enabled };
};
window.__step = (seconds) => {
  if (!G) return 'no game';
  const n = Math.floor(seconds / 0.016);
  for (let i = 0; i < n && G; i++) step(0.016);
  return G ? { time: G.timeLeft.toFixed(0), scores: { ...G.scores } } : 'match ended';
};
