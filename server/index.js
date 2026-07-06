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
const STALE_CONNECTION_MS = 45000;
const HOST_SNAPSHOT_TIMEOUT_MS = 5000;
const BOT_NAMES = ['Whiplash', 'Tornado', 'Cyclone', 'Vortex', 'Blitz', 'Comet', 'Turbo', 'Zapper'];
const COLORS = ['#5cb3ff', '#ff5c5c', '#6dff6d', '#ff8ce6', '#4dffd2', '#ff9c40', '#b06dff', '#e8e8f0'];
const MAPS = [
  { id: 'arena', name: 'BLAST COMPLEX', bounds: 62, spawns: [[-22, 0.1, -22], [22, 0.1, 22], [-22, 0.1, 22], [22, 0.1, -22], [0, 0.1, -30], [0, 0.1, 30], [-30, 0.1, 0], [30, 0.1, 0]] },
  { id: 'fortress', name: 'FORTRESS FALLS', bounds: 70, spawns: [[-45, 0.1, -20], [45, 0.1, 20], [-45, 0.1, 20], [45, 0.1, -20], [0, 0.1, -42], [0, 0.1, 42], [-25, 0.1, 0], [25, 0.1, 0]] },
  { id: 'asteroids', name: 'ASTEROID BELT', bounds: 78, spawns: [[-45, 8, -20], [45, 8, 20], [-30, 8, 35], [30, 8, -35], [0, 8, -45], [0, 8, 45], [-55, 8, 0], [55, 8, 0]] },
  { id: 'canopy', name: 'CANOPY', bounds: 78, spawns: [[-48, 0.1, -48], [48, 0.1, 48], [-48, 0.1, 48], [48, 0.1, -48], [0, 0.1, -62], [0, 0.1, 62], [-62, 0.1, 0], [62, 0.1, 0]] },
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

  const conn = {
    id: randomUUID(),
    socket,
    name: 'Player',
    lobbyId: null,
    slotId: null,
    buffer: Buffer.alloc(0),
    alive: true,
    lastSeen: Date.now(),
  };
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
  conn.lastSeen = Date.now();
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
    const input = {
      seq: Number(msg.seq || 0),
      yaw: finite(msg.yaw, slot.yaw),
      pitch: finite(msg.pitch, slot.pitch),
      firing: !!msg.firing,
      weapon: String(msg.weapon || slot.weapon || 'blaster'),
      pos: sanitizePos(msg.pos, lobby.map),
    };
    slot.input = input;
    slot.lastInputAt = Date.now();
    if (lobby.hostConnId && lobby.hostConnId !== conn.id) {
      const host = connections.get(lobby.hostConnId);
      if (host) send(host, { type: 'remoteInput', slotId: slot.id, name: slot.name, input });
    }
  } else if (msg.type === 'hostSnapshot') {
    const lobby = lobbies.get(conn.lobbyId);
    if (!lobby || lobby.hostConnId !== conn.id || lobby.phase !== 'playing') return;
    const snap = sanitizeHostSnapshot(msg.snapshot, lobby);
    if (snap) {
      lobby.lastHostSnapshotAt = Date.now();
      mergeHostSnapshot(lobby, snap);
      broadcastExcept(lobby, { type: 'snapshot', ...snap }, conn.id);
    }
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
    y: Math.max(-200, Math.min(260, finite(pos.y, 0))),
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
    latestRanked: null,
    lastHostSnapshotAt: Date.now(),
    slots: [],
    hostConnId: null,
    tickHandle: null,
    lastTick: Date.now(),
    humanCount() { return this.slots.filter(s => s.human).length; },
  };
  for (let i = 0; i < SLOTS; i++) lobby.slots.push(makeBotSlot(i, lobby.map));
  lobbies.set(id, lobby);
  startLobbyTimers(lobby);
  return lobby;
}

function makeBotSlot(i, map, previousSpawnIndex = null) {
  const spawn = chooseSpawn(map, previousSpawnIndex);
  const s = {
    id: `slot-${i}`,
    human: false,
    connId: null,
    name: BOT_NAMES[i % BOT_NAMES.length],
    color: COLORS[i % COLORS.length],
    pos: spawn.pos,
    lastSpawnIndex: spawn.index,
    yaw: Math.random() * Math.PI * 2,
    pitch: 0,
    score: 0,
    kills: 0,
    deaths: 0,
    input: null,
    lastInputAt: 0,
  };
  return s;
}

function resetSlotForHuman(slot, conn, lobby) {
  const spawn = chooseSpawn(lobby.map, slot.lastSpawnIndex);
  Object.assign(slot, {
    human: true,
    connId: conn.id,
    name: conn.name,
    pos: spawn.pos,
    lastSpawnIndex: spawn.index,
    yaw: 0,
    pitch: 0,
    score: 0,
    kills: 0,
    deaths: 0,
    input: null,
    lastInputAt: Date.now(),
  });
}

function convertToBot(slot, lobby) {
  const idx = Number(slot.id.split('-')[1]) || 0;
  Object.assign(slot, makeBotSlot(idx, lobby.map, slot.lastSpawnIndex), { id: slot.id, color: slot.color });
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
  if (!lobby.hostConnId) lobby.hostConnId = conn.id;
  send(conn, {
    type: 'joinedLobby',
    lobbyId: lobby.id,
    slotId: slot.id,
    hostId: lobby.hostConnId,
    isHost: lobby.hostConnId === conn.id,
    phase: lobby.phase,
    mapId: lobby.map.id,
    phaseEndsAt: lobby.phaseEndsAt,
    maps: MAPS.map(({ id, name }) => ({ id, name })),
    slots: publicSlots(lobby),
  });
  broadcastHost(lobby);
  broadcastLobbyMeta(lobby);
}

function leaveLobby(conn) {
  const lobby = lobbies.get(conn.lobbyId);
  if (!lobby) return;
  const slot = lobby.slots.find(s => s.connId === conn.id);
  if (slot) convertToBot(slot, lobby);
  lobby.votes.delete(conn.id);
  if (lobby.hostConnId === conn.id) {
    const nextHost = [...connections.values()].find(c => c.lobbyId === lobby.id && c.id !== conn.id);
    lobby.hostConnId = nextHost?.id || null;
  }
  conn.lobbyId = null;
  conn.slotId = null;
  if (lobby.humanCount() === 0) destroyLobby(lobby);
  else {
    broadcastHost(lobby);
    broadcastLobbyMeta(lobby);
  }
}

function destroyLobby(lobby) {
  clearInterval(lobby.tickHandle);
  lobbies.delete(lobby.id);
}

function startLobbyTimers(lobby) {
  lobby.tickHandle = setInterval(() => tickLobby(lobby), 1000 / TICK_HZ);
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
    hostId: l.hostConnId,
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
    hostId: lobby.hostConnId,
    slots: publicSlots(lobby),
  });
}

function broadcast(lobby, data) {
  for (const conn of connections.values()) {
    if (conn.lobbyId === lobby.id) send(conn, data);
  }
}

function broadcastExcept(lobby, data, exceptConnId) {
  for (const conn of connections.values()) {
    if (conn.lobbyId === lobby.id && conn.id !== exceptConnId) send(conn, data);
  }
}

function broadcastHost(lobby) {
  for (const conn of connections.values()) {
    if (conn.lobbyId !== lobby.id) continue;
    send(conn, {
      type: 'hostChanged',
      hostId: lobby.hostConnId,
      isHost: conn.id === lobby.hostConnId,
      slots: publicSlots(lobby),
    });
  }
}

function publicSlots(lobby) {
  return lobby.slots.map(s => ({
    id: s.id,
    human: s.human,
    name: s.name,
    color: s.color,
    connId: s.human ? s.connId : null,
  }));
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
    lobby.latestRanked = null;
    for (let i = 0; i < lobby.slots.length; i++) {
      const s = lobby.slots[i];
      if (!s.human) Object.assign(s, makeBotSlot(i, lobby.map, s.lastSpawnIndex), { id: s.id, color: s.color });
    }
  } else if (phase === 'playing') {
    lobby.map = chooseVotedMap(lobby);
    lobby.phaseEndsAt = now + MATCH_TIME * 1000;
    lobby.latestRanked = null;
    lobby.lastHostSnapshotAt = now;
    const usedSpawns = new Set();
    for (let i = 0; i < lobby.slots.length; i++) {
      const s = lobby.slots[i];
      const spawn = chooseSpawn(lobby.map, s.lastSpawnIndex, usedSpawns);
      usedSpawns.add(spawn.index);
      s.pos = spawn.pos;
      s.lastSpawnIndex = spawn.index;
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
  broadcast(lobby, {
    type: 'phaseChanged',
    phase: lobby.phase,
    mapId: lobby.map.id,
    phaseEndsAt: lobby.phaseEndsAt,
    ranked: phase === 'podium' && lobby.latestRanked ? lobby.latestRanked : ranked(lobby),
    hostId: lobby.hostConnId,
    slots: publicSlots(lobby),
  });
  broadcastLobbyMeta(lobby);
}

function chooseSpawn(map, previousIndex = null, usedIndices = null) {
  const spawns = map.spawns;
  let candidates = spawns.map((_, i) => i);
  if (usedIndices && usedIndices.size < spawns.length) candidates = candidates.filter(i => !usedIndices.has(i));
  if (spawns.length > 1 && candidates.length > 1) candidates = candidates.filter(i => i !== previousIndex);
  const index = candidates[Math.floor(Math.random() * candidates.length)] ?? 0;
  const p = spawns[index];
  return { index, pos: { x: p[0], y: p[1], z: p[2] } };
}

function tickLobby(lobby) {
  if (!lobbies.has(lobby.id) || lobby.humanCount() === 0) return;
  const now = Date.now();
  const dt = Math.min(0.1, (now - lobby.lastTick) / 1000);
  lobby.lastTick = now;
  if (lobby.phase === 'playing') promoteHostIfStale(lobby, now);
  if (now >= lobby.phaseEndsAt) {
    if (lobby.phase === 'voting') setPhase(lobby, 'playing');
    else if (lobby.phase === 'playing') setPhase(lobby, 'podium');
    else setPhase(lobby, 'voting');
  }
}

function promoteHostIfStale(lobby, now = Date.now()) {
  if (lobby.humanCount() <= 1) return;
  if (now - (lobby.lastHostSnapshotAt || 0) <= HOST_SNAPSHOT_TIMEOUT_MS) return;
  const candidates = [...connections.values()]
    .filter(c => c.lobbyId === lobby.id && c.id !== lobby.hostConnId)
    .map(conn => {
      const slot = lobby.slots.find(s => s.connId === conn.id);
      return { conn, activity: Math.max(slot?.lastInputAt || 0, conn.lastSeen || 0) };
    })
    .sort((a, b) => b.activity - a.activity);
  const next = candidates[0]?.conn;
  if (!next) {
    lobby.lastHostSnapshotAt = now;
    return;
  }
  lobby.hostConnId = next.id;
  lobby.lastHostSnapshotAt = now;
  broadcastHost(lobby);
  broadcastLobbyMeta(lobby);
}

function ranked(lobby) {
  return [...lobby.slots].sort((a, b) => b.score - a.score || b.kills - a.kills || a.deaths - b.deaths)
    .map(s => ({ id: s.id, name: s.name, score: s.score, kills: s.kills, deaths: s.deaths, color: s.color, human: s.human }));
}

function sanitizeHostSnapshot(snapshot, lobby) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const players = Array.isArray(snapshot.players) ? snapshot.players.slice(0, SLOTS) : [];
  const sanitizedPlayers = players.map((p, i) => {
    const id = String(p.id || `slot-${i}`).slice(0, 32);
    const pos = sanitizePos(p.pos, lobby.map) || { x: 0, y: 0, z: 0 };
    return {
      id,
      name: cleanName(p.name || id),
      human: !!p.human,
      color: /^#[0-9a-f]{6}$/i.test(String(p.color || '')) ? p.color : COLORS[i % COLORS.length],
      pos,
      yaw: finite(p.yaw, 0),
      pitch: finite(p.pitch, 0),
      hp: Math.max(0, Math.min(100, finite(p.hp, 100))),
      alive: p.alive !== false,
      score: Math.max(0, Math.floor(finite(p.score, 0))),
      kills: Math.max(0, Math.floor(finite(p.kills, 0))),
      deaths: Math.max(0, Math.floor(finite(p.deaths, 0))),
      respawn: Math.max(0, finite(p.respawn, 0)),
      weapon: String(p.weapon || 'blaster').slice(0, 24),
    };
  });
  const ranked = Array.isArray(snapshot.ranked) ? snapshot.ranked.slice(0, SLOTS).map((r, i) => ({
    id: String(r.id || `slot-${i}`).slice(0, 32),
    name: cleanName(r.name || r.id || `slot-${i}`),
    score: Math.max(0, Math.floor(finite(r.score, 0))),
    kills: Math.max(0, Math.floor(finite(r.kills, 0))),
    deaths: Math.max(0, Math.floor(finite(r.deaths, 0))),
    color: /^#[0-9a-f]{6}$/i.test(String(r.color || '')) ? r.color : COLORS[i % COLORS.length],
    human: !!r.human,
  })) : sanitizedPlayers;
  const events = Array.isArray(snapshot.events) ? snapshot.events.slice(0, 32).map(sanitizeEvent).filter(Boolean) : [];
  const drops = Array.isArray(snapshot.drops) ? snapshot.drops.slice(0, 32).map(d => sanitizeDrop(d, lobby)).filter(Boolean) : [];
  return {
    tick: Date.now(),
    phase: lobby.phase,
    phaseEndsAt: lobby.phaseEndsAt,
    mapId: lobby.map.id,
    ranked,
    players: sanitizedPlayers,
    events,
    drops,
  };
}

function sanitizeDrop(drop, lobby) {
  if (!drop || typeof drop !== 'object') return null;
  const kind = String(drop.kind || '');
  if (!['points', 'drop'].includes(kind)) return null;
  const pos = sanitizePos(drop.pos, lobby.map);
  if (!pos) return null;
  const id = String(drop.id || `${kind}:${Math.round(pos.x * 10)}:${Math.round(pos.y * 10)}:${Math.round(pos.z * 10)}`).slice(0, 64);
  const out = {
    id,
    kind,
    pos,
    amount: Math.max(0, Math.min(5000, Math.floor(finite(drop.amount, kind === 'points' ? 250 : 0)))),
  };
  if (kind === 'drop') out.weapon = String(drop.weapon || 'blaster').slice(0, 24);
  return out;
}

function mergeHostSnapshot(lobby, snap) {
  const byId = new Map(snap.players.map(p => [p.id, p]));
  for (const slot of lobby.slots) {
    const p = byId.get(slot.id);
    if (!p) continue;
    slot.pos = p.pos;
    slot.yaw = p.yaw;
    slot.pitch = p.pitch;
    slot.hp = p.hp;
    slot.alive = p.alive;
    slot.respawn = p.respawn;
    slot.score = p.score;
    slot.kills = p.kills;
    slot.deaths = p.deaths;
  }
  lobby.latestRanked = snap.ranked || ranked(lobby);
}

function sanitizeEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const type = String(ev.type || '');
  if (type === 'shot') {
    const from = sanitizeEventPoint(ev.from);
    const to = sanitizeEventPoint(ev.to);
    if (!from || !to) return null;
    return {
      type,
      shooterId: String(ev.shooterId || '').slice(0, 32),
      from,
      to,
      color: /^#[0-9a-f]{6}$/i.test(String(ev.color || '')) ? ev.color : '#ffd23c',
      hit: !!ev.hit,
    };
  }
  if (type === 'damage') {
    return {
      type,
      attackerId: String(ev.attackerId || '').slice(0, 32),
      targetId: String(ev.targetId || '').slice(0, 32),
      amount: Math.max(0, Math.min(999, finite(ev.amount, 0))),
    };
  }
  if (type === 'kill') {
    return {
      type,
      killerId: String(ev.killerId || '').slice(0, 32),
      victimId: String(ev.victimId || '').slice(0, 32),
    };
  }
  return null;
}

function sanitizeEventPoint(p) {
  if (!p || typeof p !== 'object') return null;
  return {
    x: Math.max(-250, Math.min(250, finite(p.x, 0))),
    y: Math.max(-50, Math.min(120, finite(p.y, 0))),
    z: Math.max(-250, Math.min(250, finite(p.z, 0))),
  };
}

function pruneStaleConnections() {
  const now = Date.now();
  for (const conn of [...connections.values()]) {
    if (!conn.alive || conn.socket.destroyed || now - conn.lastSeen <= STALE_CONNECTION_MS) continue;
    close(conn);
  }
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

setInterval(pruneStaleConnections, 5000);
