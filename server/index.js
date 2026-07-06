import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);

const MATCH_TIME = 5 * 60;
const VOTE_TIME = 10;
const PODIUM_TIME = 6;
const MAX_LOBBIES = 5;
const SLOTS = 8;
const TICK_HZ = 30;
const SNAPSHOT_HZ = 20;
const RESPAWN_TIME = 3;
const BOT_NAMES = ['Whiplash', 'Tornado', 'Cyclone', 'Vortex', 'Blitz', 'Comet', 'Turbo', 'Zapper'];
const COLORS = ['#5cb3ff', '#ff5c5c', '#6dff6d', '#ff8ce6', '#4dffd2', '#ff9c40', '#b06dff', '#e8e8f0'];
const MAPS = [
  { id: 'arena', name: 'BLAST COMPLEX', bounds: 62, spawns: [[-22, 0.1, -22], [22, 0.1, 22], [-22, 0.1, 22], [22, 0.1, -22], [0, 0.1, -30], [0, 0.1, 30], [-30, 0.1, 0], [30, 0.1, 0]] },
  { id: 'fortress', name: 'FORTRESS FALLS', bounds: 70, spawns: [[-45, 0.1, -20], [45, 0.1, 20], [-45, 0.1, 20], [45, 0.1, -20], [0, 0.1, -42], [0, 0.1, 42], [-25, 0.1, 0], [25, 0.1, 0]] },
  { id: 'asteroids', name: 'ASTEROID BELT', bounds: 78, spawns: [[-45, 8, -20], [45, 8, 20], [-30, 8, 35], [30, 8, -35], [0, 8, -45], [0, 8, 45], [-55, 8, 0], [55, 8, 0]] },
  { id: 'canopy', name: 'CANOPY', bounds: 78, spawns: [[-40, 10, -40], [40, 10, 40], [0, 8, -7], [0, 0.1, -62], [0, 0.1, 62], [-40, 20, 40], [40, 20, -40], [-30, 0.1, 0]] },
  { id: 'city', name: 'NEON HEIGHTS', bounds: 86, spawns: [[-55, 0.1, -35], [55, 0.1, 35], [-55, 0.1, 35], [55, 0.1, -35], [0, 16, -35], [0, 16, 35], [-35, 8, 0], [35, 8, 0]] },
  { id: 'sanctum', name: 'THE LABYRINTH', bounds: 64, spawns: [[-32, 0.1, -32], [32, 0.1, 32], [-32, 0.1, 32], [32, 0.1, -32], [0, 0.1, -40], [0, 0.1, 40], [-40, 0.1, 0], [40, 0.1, 0]] },
  { id: 'prism', name: 'PRISM RUN', bounds: 44, spawns: [[-20, 0.1, -20], [20, 0.1, 20], [-20, 0.1, 20], [20, 0.1, -20], [0, 0.1, -25], [0, 0.1, 25], [-25, 0.1, 0], [25, 0.1, 0]] },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
};

const connections = new Map();
const lobbies = new Map();
let nextLobbyNum = 1;

function serveStatic(req, res) {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, lobbies: lobbies.size, players: connections.size }));
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const file = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const full = resolve(join(ROOT, file));
  if (!full.startsWith(ROOT) || !existsSync(full) || !statSync(full).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(full).toLowerCase()] || 'application/octet-stream',
    'cache-control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=3600',
  });
  createReadStream(full).pipe(res);
}

const httpServer = createServer(serveStatic);
httpServer.on('upgrade', (req, socket) => {
  if (new URL(req.url, `http://${req.headers.host}`).pathname !== '/ws') {
    socket.destroy();
    return;
  }
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ].join('\r\n'));

  const conn = { id: randomUUID(), socket, name: 'Player', lobbyId: null, slotId: null, buffer: Buffer.alloc(0), alive: true };
  connections.set(conn.id, conn);
  socket.on('data', (chunk) => onData(conn, chunk));
  socket.on('end', () => disconnect(conn));
  socket.on('close', () => disconnect(conn));
  socket.on('error', () => disconnect(conn));
  send(conn, { type: 'welcome', id: conn.id });
});

function onData(conn, chunk) {
  conn.buffer = Buffer.concat([conn.buffer, chunk]);
  while (conn.buffer.length >= 2) {
    const b0 = conn.buffer[0];
    const b1 = conn.buffer[1];
    const opcode = b0 & 0x0f;
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) {
      if (conn.buffer.length < 4) return;
      len = conn.buffer.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      close(conn);
      return;
    }
    const masked = (b1 & 0x80) !== 0;
    if (!masked || conn.buffer.length < off + 4 + len) return;
    const mask = conn.buffer.subarray(off, off + 4);
    off += 4;
    const payload = Buffer.alloc(len);
    for (let i = 0; i < len; i++) payload[i] = conn.buffer[off + i] ^ mask[i % 4];
    conn.buffer = conn.buffer.subarray(off + len);
    if (opcode === 0x8) {
      close(conn);
      return;
    }
    if (opcode !== 0x1) continue;
    try {
      handleMessage(conn, JSON.parse(payload.toString('utf8')));
    } catch {
      send(conn, { type: 'error', message: 'Bad message' });
    }
  }
}

function frame(data) {
  const body = Buffer.from(JSON.stringify(data));
  if (body.length < 126) return Buffer.concat([Buffer.from([0x81, body.length]), body]);
  const head = Buffer.alloc(4);
  head[0] = 0x81;
  head[1] = 126;
  head.writeUInt16BE(body.length, 2);
  return Buffer.concat([head, body]);
}

function send(conn, data) {
  if (!conn.alive || conn.socket.destroyed) return;
  conn.socket.write(frame(data));
}

function close(conn) {
  if (!conn.alive) return;
  conn.alive = false;
  conn.socket.end();
  disconnect(conn);
}

function disconnect(conn) {
  if (!connections.has(conn.id)) return;
  conn.alive = false;
  leaveLobby(conn);
  connections.delete(conn.id);
}

function handleMessage(conn, msg) {
  if (msg.type === 'hello') {
    conn.name = cleanName(msg.name);
    autoJoin(conn);
  } else if (msg.type === 'joinLobby') {
    joinLobby(conn, String(msg.lobbyId || ''));
  } else if (msg.type === 'voteMap') {
    const lobby = lobbies.get(conn.lobbyId);
    if (!lobby || lobby.phase !== 'voting' || !MAPS.some(m => m.id === msg.mapId)) return;
    lobby.votes.set(conn.id, msg.mapId);
    broadcastLobbyMeta(lobby);
  } else if (msg.type === 'input') {
    const lobby = lobbies.get(conn.lobbyId);
    const slot = lobby?.slots.find(s => s.connId === conn.id);
    if (!slot || !slot.human) return;
    slot.input = {
      seq: Number(msg.seq || 0),
      yaw: finite(msg.yaw, slot.yaw),
      pitch: finite(msg.pitch, slot.pitch),
      firing: !!msg.firing,
      weapon: String(msg.weapon || slot.weapon || 'blaster'),
      pos: sanitizePos(msg.pos, lobby.map),
      hp: Number.isFinite(msg.hp) ? Math.max(0, Math.min(100, msg.hp)) : slot.hp,
      alive: msg.alive !== false,
    };
    applyHumanInput(slot, lobby);
  } else if (msg.type === 'leaveLobby') {
    leaveLobby(conn);
  } else if (msg.type === 'ping') {
    send(conn, { type: 'pong', t: msg.t, serverTime: Date.now() });
  }
}

function cleanName(name) {
  return String(name || 'Player').replace(/[^\w .'-]/g, '').trim().slice(0, 18) || 'Player';
}

function finite(v, fallback = 0) {
  return Number.isFinite(v) ? v : fallback;
}

function sanitizePos(pos, map) {
  const b = map?.bounds || 70;
  if (!pos || typeof pos !== 'object') return null;
  return {
    x: Math.max(-b, Math.min(b, finite(pos.x, 0))),
    y: Math.max(-20, Math.min(80, finite(pos.y, 0))),
    z: Math.max(-b, Math.min(b, finite(pos.z, 0))),
  };
}

function autoJoin(conn) {
  const active = [...lobbies.values()].filter(l => l.humanCount() > 0 && l.humanCount() < SLOTS);
  if (active.length <= 1) {
    if (!active[0] && lobbies.size >= MAX_LOBBIES) {
      send(conn, { type: 'lobbyList', lobbies: lobbyList(), full: true });
      return;
    }
    joinLobby(conn, active[0]?.id || createLobby().id);
    return;
  }
  send(conn, { type: 'lobbyList', lobbies: lobbyList(), choose: true });
}

function createLobby() {
  const id = `lobby-${nextLobbyNum++}`;
  const lobby = {
    id,
    label: `Lobby ${id.split('-')[1]}`,
    phase: 'voting',
    phaseEndsAt: Date.now() + VOTE_TIME * 1000,
    map: MAPS[0],
    votes: new Map(),
    slots: [],
    tickHandle: null,
    snapshotHandle: null,
    lastTick: Date.now(),
    events: [],
    humanCount() { return this.slots.filter(s => s.human).length; },
  };
  for (let i = 0; i < SLOTS; i++) lobby.slots.push(makeBotSlot(i, lobby.map));
  lobbies.set(id, lobby);
  startLobbyTimers(lobby);
  return lobby;
}

function makeBotSlot(i, map) {
  const s = {
    id: `slot-${i}`,
    human: false,
    connId: null,
    name: BOT_NAMES[i % BOT_NAMES.length],
    color: COLORS[i % COLORS.length],
    pos: spawnFor(i, map),
    yaw: Math.random() * Math.PI * 2,
    pitch: 0,
    hp: 100,
    alive: true,
    score: 0,
    kills: 0,
    deaths: 0,
    weapon: 'blaster',
    cooldown: 0,
    respawn: 0,
    botGoal: null,
    input: null,
  };
  return s;
}

function resetSlotForHuman(slot, conn, lobby) {
  Object.assign(slot, {
    human: true,
    connId: conn.id,
    name: conn.name,
    pos: spawnFor(Number(slot.id.split('-')[1]) || 0, lobby.map),
    yaw: 0,
    pitch: 0,
    hp: 100,
    alive: true,
    score: 0,
    kills: 0,
    deaths: 0,
    weapon: 'blaster',
    cooldown: 0,
    respawn: 0,
    input: null,
  });
}

function convertToBot(slot, lobby) {
  const idx = Number(slot.id.split('-')[1]) || 0;
  Object.assign(slot, makeBotSlot(idx, lobby.map), { id: slot.id, color: slot.color });
}

function joinLobby(conn, lobbyId) {
  leaveLobby(conn);
  let lobby = lobbies.get(lobbyId);
  if (!lobby) lobby = createLobby();
  if (lobby.humanCount() >= SLOTS) {
    if (lobbies.size < MAX_LOBBIES) lobby = createLobby();
    else {
      send(conn, { type: 'lobbyList', lobbies: lobbyList(), full: true });
      return;
    }
  }
  const slot = lobby.slots.find(s => !s.human) || lobby.slots[0];
  resetSlotForHuman(slot, conn, lobby);
  conn.lobbyId = lobby.id;
  conn.slotId = slot.id;
  send(conn, { type: 'joinedLobby', lobbyId: lobby.id, slotId: slot.id, phase: lobby.phase, mapId: lobby.map.id, phaseEndsAt: lobby.phaseEndsAt, maps: MAPS.map(({ id, name }) => ({ id, name })) });
  broadcastLobbyMeta(lobby);
}

function leaveLobby(conn) {
  const lobby = lobbies.get(conn.lobbyId);
  if (!lobby) return;
  const slot = lobby.slots.find(s => s.connId === conn.id);
  if (slot) convertToBot(slot, lobby);
  lobby.votes.delete(conn.id);
  conn.lobbyId = null;
  conn.slotId = null;
  if (lobby.humanCount() === 0) destroyLobby(lobby);
  else broadcastLobbyMeta(lobby);
}

function destroyLobby(lobby) {
  clearInterval(lobby.tickHandle);
  clearInterval(lobby.snapshotHandle);
  lobbies.delete(lobby.id);
}

function startLobbyTimers(lobby) {
  lobby.tickHandle = setInterval(() => tickLobby(lobby), 1000 / TICK_HZ);
  lobby.snapshotHandle = setInterval(() => broadcastSnapshot(lobby), 1000 / SNAPSHOT_HZ);
}

function lobbyList() {
  return [...lobbies.values()].map(l => ({
    id: l.id,
    label: l.label,
    humans: l.humanCount(),
    max: SLOTS,
    phase: l.phase,
    mapId: l.map.id,
    mapName: l.map.name,
    phaseEndsAt: l.phaseEndsAt,
  }));
}

function broadcastLobbyMeta(lobby) {
  const counts = Object.fromEntries(MAPS.map(m => [m.id, 0]));
  for (const mapId of lobby.votes.values()) counts[mapId] = (counts[mapId] || 0) + 1;
  broadcast(lobby, {
    type: 'lobbyMeta',
    lobby: lobbyList().find(l => l.id === lobby.id),
    votes: counts,
    phase: lobby.phase,
    mapId: lobby.map.id,
    phaseEndsAt: lobby.phaseEndsAt,
  });
}

function broadcast(lobby, data) {
  for (const conn of connections.values()) {
    if (conn.lobbyId === lobby.id) send(conn, data);
  }
}

function chooseVotedMap(lobby) {
  const counts = new Map();
  for (const id of lobby.votes.values()) counts.set(id, (counts.get(id) || 0) + 1);
  if (counts.size === 0) return MAPS[Math.floor(Math.random() * MAPS.length)];
  const max = Math.max(...counts.values());
  const tied = [...counts.entries()].filter(([, c]) => c === max).map(([id]) => id);
  return MAPS.find(m => m.id === tied[Math.floor(Math.random() * tied.length)]) || MAPS[0];
}

function setPhase(lobby, phase) {
  lobby.phase = phase;
  const now = Date.now();
  if (phase === 'voting') {
    lobby.phaseEndsAt = now + VOTE_TIME * 1000;
    lobby.votes.clear();
    for (let i = 0; i < lobby.slots.length; i++) {
      const s = lobby.slots[i];
      if (!s.human) Object.assign(s, makeBotSlot(i, lobby.map), { id: s.id, color: s.color });
    }
  } else if (phase === 'playing') {
    lobby.map = chooseVotedMap(lobby);
    lobby.phaseEndsAt = now + MATCH_TIME * 1000;
    for (let i = 0; i < lobby.slots.length; i++) {
      const s = lobby.slots[i];
      s.pos = spawnFor(i, lobby.map);
      s.hp = 100;
      s.alive = true;
      s.respawn = 0;
      s.cooldown = 0;
      s.score = s.human ? 0 : s.score;
      s.kills = s.human ? 0 : s.kills;
      s.deaths = s.human ? 0 : s.deaths;
    }
  } else if (phase === 'podium') {
    lobby.phaseEndsAt = now + PODIUM_TIME * 1000;
  }
  broadcast(lobby, { type: 'phaseChanged', phase: lobby.phase, mapId: lobby.map.id, phaseEndsAt: lobby.phaseEndsAt, ranked: ranked(lobby) });
  broadcastLobbyMeta(lobby);
}

function spawnFor(i, map) {
  const p = map.spawns[i % map.spawns.length];
  return { x: p[0], y: p[1], z: p[2] };
}

function tickLobby(lobby) {
  if (!lobbies.has(lobby.id) || lobby.humanCount() === 0) return;
  const now = Date.now();
  const dt = Math.min(0.1, (now - lobby.lastTick) / 1000);
  lobby.lastTick = now;
  if (now >= lobby.phaseEndsAt) {
    if (lobby.phase === 'voting') setPhase(lobby, 'playing');
    else if (lobby.phase === 'playing') setPhase(lobby, 'podium');
    else setPhase(lobby, 'voting');
  }
  if (lobby.phase !== 'playing') return;
  for (const slot of lobby.slots) {
    if (slot.respawn > 0) {
      slot.respawn -= dt;
      if (slot.respawn <= 0) {
        slot.alive = true;
        slot.hp = 100;
        slot.pos = spawnFor(Number(slot.id.split('-')[1]) || 0, lobby.map);
      }
      continue;
    }
    if (!slot.alive) continue;
    if (!slot.human) updateBot(slot, lobby, dt);
    slot.cooldown = Math.max(0, slot.cooldown - dt);
    if (slot.human && slot.input?.firing) tryFire(slot, lobby);
  }
}

function applyHumanInput(slot, lobby) {
  if (!slot.input) return;
  if (slot.input.pos && slot.alive) slot.pos = slot.input.pos;
  slot.yaw = slot.input.yaw;
  slot.pitch = slot.input.pitch;
  slot.weapon = slot.input.weapon;
  if (slot.input.hp <= 0 && slot.alive) killSlot(slot, slot, lobby);
}

function updateBot(slot, lobby, dt) {
  const b = lobby.map.bounds;
  if (!slot.botGoal || dist2(slot.pos, slot.botGoal) < 16) {
    slot.botGoal = { x: rand(-b * 0.75, b * 0.75), y: slot.pos.y, z: rand(-b * 0.75, b * 0.75) };
  }
  const target = nearestEnemy(slot, lobby);
  if (target) {
    slot.yaw = Math.atan2(target.pos.x - slot.pos.x, target.pos.z - slot.pos.z);
    if (Math.sqrt(dist2(slot.pos, target.pos)) < 42) tryFire(slot, lobby);
  }
  const goal = target && Math.random() < 0.55 ? target.pos : slot.botGoal;
  const dx = goal.x - slot.pos.x;
  const dz = goal.z - slot.pos.z;
  const len = Math.hypot(dx, dz) || 1;
  const speed = 7.5;
  slot.pos.x = Math.max(-b, Math.min(b, slot.pos.x + (dx / len) * speed * dt));
  slot.pos.z = Math.max(-b, Math.min(b, slot.pos.z + (dz / len) * speed * dt));
}

function tryFire(attacker, lobby) {
  if (attacker.cooldown > 0) return;
  attacker.cooldown = attacker.human ? 0.24 : 0.55 + Math.random() * 0.35;
  const target = bestShotTarget(attacker, lobby);
  if (!target) return;
  const dmg = attacker.human ? 12 : 9;
  target.hp -= dmg;
  lobby.events.push({ type: 'damage', attackerId: attacker.id, targetId: target.id, amount: dmg });
  if (target.hp <= 0) killSlot(target, attacker, lobby);
}

function bestShotTarget(attacker, lobby) {
  let best = null;
  let bestScore = Infinity;
  for (const target of lobby.slots) {
    if (target === attacker || !target.alive || target.respawn > 0) continue;
    const dx = target.pos.x - attacker.pos.x;
    const dz = target.pos.z - attacker.pos.z;
    const d = Math.hypot(dx, dz);
    if (d > 48) continue;
    const yaw = Math.atan2(dx, dz);
    const angle = Math.abs(angleDiff(yaw, attacker.yaw));
    const cone = attacker.human ? 0.18 : 0.42;
    if (angle > cone) continue;
    const score = d + angle * 120;
    if (score < bestScore) {
      bestScore = score;
      best = target;
    }
  }
  return best;
}

function nearestEnemy(slot, lobby) {
  let best = null;
  let bd = Infinity;
  for (const other of lobby.slots) {
    if (other === slot || !other.alive || other.respawn > 0) continue;
    const d = dist2(slot.pos, other.pos);
    if (d < bd) {
      bd = d;
      best = other;
    }
  }
  return best;
}

function killSlot(victim, attacker, lobby) {
  if (!victim.alive) return;
  victim.alive = false;
  victim.hp = 0;
  victim.deaths++;
  victim.respawn = RESPAWN_TIME;
  if (attacker && attacker !== victim) {
    attacker.kills++;
    attacker.score += 250;
  }
  lobby.events.push({ type: 'kill', killerId: attacker?.id, victimId: victim.id });
}

function ranked(lobby) {
  return [...lobby.slots].sort((a, b) => b.score - a.score || b.kills - a.kills || a.deaths - b.deaths)
    .map(s => ({ id: s.id, name: s.name, score: s.score, kills: s.kills, deaths: s.deaths, color: s.color, human: s.human }));
}

function broadcastSnapshot(lobby) {
  if (!lobbies.has(lobby.id) || lobby.humanCount() === 0) return;
  const events = lobby.events.splice(0, 20);
  broadcast(lobby, {
    type: 'snapshot',
    tick: Date.now(),
    phase: lobby.phase,
    phaseEndsAt: lobby.phaseEndsAt,
    mapId: lobby.map.id,
    ranked: ranked(lobby),
    players: lobby.slots.map(s => ({
      id: s.id,
      name: s.name,
      human: s.human,
      color: s.color,
      pos: s.pos,
      yaw: s.yaw,
      pitch: s.pitch,
      hp: s.hp,
      alive: s.alive,
      score: s.score,
      kills: s.kills,
      deaths: s.deaths,
      respawn: Math.max(0, s.respawn),
      weapon: s.weapon,
      self: false,
    })),
    events,
  });
}

function dist2(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return dx * dx + dz * dz;
}

function rand(a, b) {
  return a + Math.random() * (b - a);
}

function angleDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

httpServer.listen(PORT, () => {
  console.log(`NERF Arena server listening on :${PORT}`);
});
