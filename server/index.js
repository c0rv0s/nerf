import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);

const envSeconds = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const MATCH_TIME = envSeconds('MATCH_TIME', 5 * 60);
const VOTE_TIME = envSeconds('VOTE_TIME', 10);
const PODIUM_TIME = envSeconds('PODIUM_TIME', 6);
const MAX_LOBBIES = 5;
const SLOTS = 8;
const TICK_HZ = 30;
const SNAPSHOT_HZ = 20;
const RESPAWN_TIME = 3;
const STALE_CONNECTION_MS = 3 * 60 * 1000;
const EMPTY_LOBBY_GRACE_MS = 60 * 1000;
const HOST_SNAPSHOT_TIMEOUT_MS = 5000;
const RECONNECT_GRACE_MS = 12 * 1000;
const MAX_INPUTS_PER_SECOND = 75;
const MAX_SNAPSHOTS_PER_SECOND = 30;
const MAX_CONTROL_MESSAGES_PER_SECOND = 12;
const INPUT_POSITION_SLOP = 3;
const INPUT_MAX_METERS_PER_SECOND = 140;
const BOT_NAMES = ['Whiplash', 'Tornado', 'Cyclone', 'Vortex', 'Blitz', 'Comet', 'Turbo', 'Zapper'];
const COLORS = ['#5cb3ff', '#ff5c5c', '#6dff6d', '#ff8ce6', '#4dffd2', '#ff9c40', '#b06dff', '#e8e8f0'];
const MODES = ['ffa', 'tdm'];
const DEFAULT_MODE = 'ffa';
const TEAM_COLORS = { blue: '#5cb3ff', red: '#ff5c5c' };
const WEAPON_IDS = new Set(['blaster', 'scatter', 'pulsar', 'sidewinder', 'zooka', 'whomper', 'hyper', 'parasite', 'refractor']);
const WORLD_EVENT_IDS = new Set(['lava', 'water', 'storm', 'void']);
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
  '.ogg': 'audio/ogg',
};

const connections = new Map();
const lobbies = new Map();
const reconnectReservations = new Map();
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
  const ext = extname(full).toLowerCase();
  const cacheControl = file.endsWith('index.html') || ext === '.js' || file.startsWith('/textures/')
    ? 'no-store'
    : 'public, max-age=3600';
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': cacheControl,
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
    rateWindows: new Map(),
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
  leaveLobby(conn, true);
  connections.delete(conn.id);
}

function handleMessage(conn, msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
  conn.lastSeen = Date.now();
  const rateLimit = msg.type === 'input' ? MAX_INPUTS_PER_SECOND
    : msg.type === 'hostSnapshot' ? MAX_SNAPSHOTS_PER_SECOND
      : MAX_CONTROL_MESSAGES_PER_SECOND;
  if (!allowMessage(conn, msg.type, rateLimit)) return;
  if (msg.type === 'hello') {
    conn.name = cleanName(msg.name);
    conn.resumeToken = cleanResumeToken(msg.resumeToken);
    const requestedLobbyId = String(msg.lobbyId || '');
    if (requestedLobbyId && lobbies.has(requestedLobbyId)) joinLobby(conn, requestedLobbyId);
    else autoJoin(conn);
  } else if (msg.type === 'joinLobby') {
    joinLobby(conn, String(msg.lobbyId || ''));
  } else if (msg.type === 'voteMap') {
    const lobby = lobbies.get(conn.lobbyId);
    if (!lobby || lobby.phase !== 'voting' || !MAPS.some(m => m.id === msg.mapId)) return;
    lobby.votes.set(conn.id, msg.mapId);
    broadcastLobbyMeta(lobby);
  } else if (msg.type === 'voteMode') {
    const lobby = lobbies.get(conn.lobbyId);
    if (!lobby || lobby.phase !== 'voting' || !MODES.includes(msg.mode)) return;
    lobby.modeVotes.set(conn.id, msg.mode);
    broadcastLobbyMeta(lobby);
  } else if (msg.type === 'input') {
    const lobby = lobbies.get(conn.lobbyId);
    const slot = lobby?.slots.find(s => s.connId === conn.id);
    if (!slot || !slot.human || lobby.phase !== 'playing') return;
    if (Math.floor(finite(msg.authorityEpoch, -1)) !== lobby.authorityEpoch) return;
    const seq = Math.floor(finite(msg.seq, -1));
    if (seq <= (slot.lastInputSeq ?? -1)) return;
    const pos = sanitizePos(msg.pos, lobby.map);
    const now = Date.now();
    if (!pos || !plausibleInputPosition(slot, pos, now)) return;
    const weapon = String(msg.weapon || slot.weapon || 'blaster');
    const input = {
      seq,
      yaw: finite(msg.yaw, slot.yaw),
      pitch: Math.max(-1.55, Math.min(1.55, finite(msg.pitch, slot.pitch))),
      up: sanitizeUnitVec(msg.up, slot.up || { x: 0, y: 1, z: 0 }),
      aim: sanitizeUnitVec(msg.aim, slot.aim || { x: 0, y: 0, z: -1 }),
      firing: !!msg.firing,
      weapon: WEAPON_IDS.has(weapon) ? weapon : 'blaster',
      pos,
      vel: sanitizeVel(msg.vel),
      alive: slot.alive !== false,
    };
    slot.input = input;
    slot.up = input.up;
    slot.aim = input.aim;
    slot.lastInputAt = now;
    slot.lastInputPos = pos;
    slot.lastInputSeq = seq;
    if (lobby.hostConnId && lobby.hostConnId !== conn.id) {
      const host = connections.get(lobby.hostConnId);
      if (host) send(host, {
        type: 'remoteInput', authorityEpoch: lobby.authorityEpoch,
        slotId: slot.id, name: slot.name, input,
      });
    }
  } else if (msg.type === 'hostSnapshot') {
    const lobby = lobbies.get(conn.lobbyId);
    if (!lobby || lobby.hostConnId !== conn.id || lobby.phase !== 'playing') return;
    const authorityEpoch = Math.floor(finite(msg.authorityEpoch, -1));
    const snapshotSeq = Math.floor(finite(msg.seq, -1));
    if (authorityEpoch !== lobby.authorityEpoch || snapshotSeq <= lobby.lastHostSnapshotSeq) return;
    const snap = sanitizeHostSnapshot(msg.snapshot, lobby, snapshotSeq);
    if (snap) {
      lobby.lastHostSnapshotAt = Date.now();
      lobby.lastHostSnapshotSeq = snapshotSeq;
      mergeHostSnapshot(lobby, snap);
      broadcastExcept(lobby, { type: 'snapshot', ...snap }, conn.id);
    }
  } else if (msg.type === 'leaveLobby') {
    leaveLobby(conn);
  } else if (msg.type === 'ping') {
    send(conn, { type: 'pong', t: msg.t, serverTime: Date.now() });
  }
}

function allowMessage(conn, type, limit) {
  const now = Date.now();
  let window = conn.rateWindows.get(type);
  if (!window || now - window.startedAt >= 1000) {
    window = { startedAt: now, count: 0 };
    conn.rateWindows.set(type, window);
  }
  window.count++;
  return window.count <= limit;
}

function cleanName(name) {
  return String(name || 'Player').replace(/[^\w .'-]/g, '').trim().slice(0, 18) || 'Player';
}

function cleanResumeToken(token) {
  const value = String(token || '').trim();
  return /^[a-zA-Z0-9_-]{16,96}$/.test(value) ? value : null;
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

function sanitizeVel(vel) {
  if (!vel || typeof vel !== 'object') return { x: 0, y: 0, z: 0 };
  return {
    x: Math.max(-120, Math.min(120, finite(vel.x, 0))),
    y: Math.max(-160, Math.min(160, finite(vel.y, 0))),
    z: Math.max(-120, Math.min(120, finite(vel.z, 0))),
  };
}

function plausibleInputPosition(slot, pos, now) {
  if (!slot.lastInputPos || !slot.lastInputAt) return true;
  const dt = Math.max(1 / 120, Math.min(0.25, (now - slot.lastInputAt) / 1000));
  const maxDistance = INPUT_POSITION_SLOP + INPUT_MAX_METERS_PER_SECOND * dt;
  const dx = pos.x - slot.lastInputPos.x;
  const dy = pos.y - slot.lastInputPos.y;
  const dz = pos.z - slot.lastInputPos.z;
  return dx * dx + dy * dy + dz * dz <= maxDistance * maxDistance;
}

function sanitizeUnitVec(vec, fallback) {
  if (!vec || typeof vec !== 'object') return fallback;
  const x = Math.max(-1, Math.min(1, finite(vec.x, fallback.x)));
  const y = Math.max(-1, Math.min(1, finite(vec.y, fallback.y)));
  const z = Math.max(-1, Math.min(1, finite(vec.z, fallback.z)));
  const len = Math.hypot(x, y, z);
  if (len < 1e-6) return fallback;
  return { x: x / len, y: y / len, z: z / len };
}

function autoJoin(conn) {
  const active = [...lobbies.values()].filter(l => l.humanCount() > 0 && l.humanCount() < SLOTS);
  const occupied = [...lobbies.values()].filter(l => l.humanCount() > 0);
  if (active.length <= 1) {
    if (!active[0] && occupied.length >= MAX_LOBBIES) {
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
    mode: DEFAULT_MODE,
    votes: new Map(),
    modeVotes: new Map(),
    latestRanked: null,
    latestScores: { blue: 0, red: 0 },
    lastHostSnapshotAt: Date.now(),
    authorityEpoch: 1,
    lastHostSnapshotSeq: -1,
    slots: [],
    hostConnId: null,
    tickHandle: null,
    destroyTimer: null,
    lastTick: Date.now(),
    humanCount() { return this.slots.filter(s => s.human).length; },
  };
  for (let i = 0; i < SLOTS; i++) lobby.slots.push(makeBotSlot(i, lobby.map, null, lobby.mode));
  lobbies.set(id, lobby);
  startLobbyTimers(lobby);
  return lobby;
}

function teamForSlot(i, mode) {
  return mode === 'tdm' ? (i % 2 === 0 ? 'blue' : 'red') : `slot-${i}`;
}

function colorForSlot(i, team, mode) {
  return mode === 'tdm' ? TEAM_COLORS[team] : COLORS[i % COLORS.length];
}

function makeBotSlot(i, map, previousSpawnIndex = null, mode = DEFAULT_MODE) {
  const spawn = chooseSpawn(map, previousSpawnIndex);
  const team = teamForSlot(i, mode);
  const s = {
    id: `slot-${i}`,
    human: false,
    connId: null,
    name: BOT_NAMES[i % BOT_NAMES.length],
    team,
    color: colorForSlot(i, team, mode),
    pos: spawn.pos,
    lastSpawnIndex: spawn.index,
    yaw: Math.random() * Math.PI * 2,
    pitch: 0,
    up: { x: 0, y: 1, z: 0 },
    aim: { x: 0, y: 0, z: -1 },
    score: 0,
    kills: 0,
    deaths: 0,
    input: null,
    lastInputAt: 0,
    lastInputSeq: -1,
    lastInputPos: spawn.pos,
  };
  return s;
}

function resetSlotForHuman(slot, conn, lobby) {
  const idx = Number(slot.id.split('-')[1]) || 0;
  const spawn = chooseSpawn(lobby.map, slot.lastSpawnIndex);
  const team = teamForSlot(idx, lobby.mode);
  Object.assign(slot, {
    human: true,
    connId: conn.id,
    name: conn.name,
    team,
    color: colorForSlot(idx, team, lobby.mode),
    pos: spawn.pos,
    lastSpawnIndex: spawn.index,
    yaw: 0,
    pitch: 0,
    up: { x: 0, y: 1, z: 0 },
    aim: { x: 0, y: 0, z: -1 },
    score: 0,
    kills: 0,
    deaths: 0,
    input: null,
    lastInputAt: Date.now(),
    lastInputSeq: -1,
    lastInputPos: spawn.pos,
  });
  delete slot.reservedToken;
  clearTimeout(slot.reservationTimer);
  delete slot.reservationTimer;
}

function convertToBot(slot, lobby) {
  const idx = Number(slot.id.split('-')[1]) || 0;
  if (slot.reservedToken) reconnectReservations.delete(slot.reservedToken);
  clearTimeout(slot.reservationTimer);
  Object.assign(slot, makeBotSlot(idx, lobby.map, slot.lastSpawnIndex, lobby.mode), { id: slot.id });
  delete slot.reservedToken;
  delete slot.reservationTimer;
}

function joinLobby(conn, lobbyId) {
  leaveLobby(conn);
  let lobby = lobbies.get(lobbyId);
  if (!lobby) lobby = createLobby();
  clearEmptyLobbyDestroy(lobby);
  const reservation = conn.resumeToken ? reconnectReservations.get(conn.resumeToken) : null;
  const reservedSlot = reservation?.lobbyId === lobby.id && reservation.expiresAt > Date.now()
    ? lobby.slots.find(s => s.id === reservation.slotId && s.reservedToken === conn.resumeToken)
    : null;
  if (reservedSlot) {
    clearTimeout(reservedSlot.reservationTimer);
    reconnectReservations.delete(conn.resumeToken);
    reservedSlot.human = true;
    reservedSlot.connId = conn.id;
    reservedSlot.name = conn.name;
    reservedSlot.lastInputAt = Date.now();
    reservedSlot.lastInputSeq = -1;
    delete reservedSlot.reservedToken;
    delete reservedSlot.reservationTimer;
    conn.lobbyId = lobby.id;
    conn.slotId = reservedSlot.id;
    if (!lobby.hostConnId) setLobbyHost(lobby, conn.id);
    sendJoinedLobby(conn, lobby, true);
    broadcastHost(lobby);
    broadcastLobbyMeta(lobby);
    return;
  }
  if (lobby.humanCount() >= SLOTS) {
    const occupied = [...lobbies.values()].filter(l => l.humanCount() > 0);
    if (occupied.length < MAX_LOBBIES) lobby = createLobby();
    else {
      send(conn, { type: 'lobbyList', lobbies: lobbyList(), full: true });
      return;
    }
  }
  const slot = lobby.slots.find(s => !s.human && !s.reservedToken);
  if (!slot) {
    const occupied = [...lobbies.values()].filter(l => l.humanCount() > 0);
    if (occupied.length < MAX_LOBBIES) return joinLobby(conn, createLobby().id);
    send(conn, { type: 'lobbyList', lobbies: lobbyList(), full: true });
    return;
  }
  resetSlotForHuman(slot, conn, lobby);
  conn.lobbyId = lobby.id;
  conn.slotId = slot.id;
  if (!lobby.hostConnId) setLobbyHost(lobby, conn.id, false);
  sendJoinedLobby(conn, lobby, false);
  broadcastHost(lobby);
  broadcastLobbyMeta(lobby);
}

function sendJoinedLobby(conn, lobby, resumed) {
  send(conn, {
    type: 'joinedLobby',
    lobbyId: lobby.id,
    slotId: conn.slotId,
    hostId: lobby.hostConnId,
    isHost: lobby.hostConnId === conn.id,
    phase: lobby.phase,
    mapId: lobby.map.id,
    mode: lobby.mode,
    phaseEndsAt: lobby.phaseEndsAt,
    authorityEpoch: lobby.authorityEpoch,
    resumed,
    maps: MAPS.map(({ id, name }) => ({ id, name })),
    slots: publicSlots(lobby),
  });
}

function leaveLobby(conn, reserveForReconnect = false) {
  const lobby = lobbies.get(conn.lobbyId);
  if (!lobby) return;
  const slot = lobby.slots.find(s => s.connId === conn.id);
  if (slot && reserveForReconnect && conn.resumeToken) reserveSlot(slot, conn, lobby);
  else if (slot) convertToBot(slot, lobby);
  lobby.votes.delete(conn.id);
  if (lobby.hostConnId === conn.id) {
    const nextHost = [...connections.values()].find(c => c.lobbyId === lobby.id && c.id !== conn.id);
    setLobbyHost(lobby, nextHost?.id || null);
  }
  conn.lobbyId = null;
  conn.slotId = null;
  if (lobby.humanCount() === 0) scheduleEmptyLobbyDestroy(lobby);
  else {
    broadcastHost(lobby);
    broadcastLobbyMeta(lobby);
  }
}

function reserveSlot(slot, conn, lobby) {
  const token = conn.resumeToken;
  slot.human = false;
  slot.connId = null;
  slot.reservedToken = token;
  const expiresAt = Date.now() + RECONNECT_GRACE_MS;
  reconnectReservations.set(token, { lobbyId: lobby.id, slotId: slot.id, expiresAt });
  clearTimeout(slot.reservationTimer);
  slot.reservationTimer = setTimeout(() => {
    if (slot.reservedToken !== token) return;
    convertToBot(slot, lobby);
    if (lobbies.has(lobby.id) && lobby.humanCount() > 0) {
      broadcastHost(lobby);
      broadcastLobbyMeta(lobby);
    }
  }, RECONNECT_GRACE_MS);
}

function scheduleEmptyLobbyDestroy(lobby) {
  if (lobby.destroyTimer) return;
  lobby.destroyTimer = setTimeout(() => {
    lobby.destroyTimer = null;
    if (lobby.humanCount() === 0) destroyLobby(lobby);
  }, EMPTY_LOBBY_GRACE_MS);
}

function clearEmptyLobbyDestroy(lobby) {
  if (!lobby?.destroyTimer) return;
  clearTimeout(lobby.destroyTimer);
  lobby.destroyTimer = null;
}

function destroyLobby(lobby) {
  clearEmptyLobbyDestroy(lobby);
  clearInterval(lobby.tickHandle);
  for (const slot of lobby.slots) {
    clearTimeout(slot.reservationTimer);
    if (slot.reservedToken) reconnectReservations.delete(slot.reservedToken);
  }
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
    mode: l.mode,
    phaseEndsAt: l.phaseEndsAt,
    hostId: l.hostConnId,
    authorityEpoch: l.authorityEpoch,
  }));
}

function broadcastLobbyMeta(lobby) {
  const counts = Object.fromEntries(MAPS.map(m => [m.id, 0]));
  for (const mapId of lobby.votes.values()) counts[mapId] = (counts[mapId] || 0) + 1;
  const modeCounts = Object.fromEntries(MODES.map(mode => [mode, 0]));
  for (const mode of lobby.modeVotes.values()) modeCounts[mode] = (modeCounts[mode] || 0) + 1;
  broadcast(lobby, {
    type: 'lobbyMeta',
    lobby: lobbyList().find(l => l.id === lobby.id),
    votes: counts,
    phase: lobby.phase,
    mapId: lobby.map.id,
    mode: lobby.mode,
    modeVotes: modeCounts,
    phaseEndsAt: lobby.phaseEndsAt,
    hostId: lobby.hostConnId,
    authorityEpoch: lobby.authorityEpoch,
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
      authorityEpoch: lobby.authorityEpoch,
      slots: publicSlots(lobby),
    });
  }
}

function setLobbyHost(lobby, hostConnId, bumpAuthority = true) {
  if (lobby.hostConnId === hostConnId) return;
  lobby.hostConnId = hostConnId;
  if (bumpAuthority) lobby.authorityEpoch++;
  lobby.lastHostSnapshotSeq = -1;
  lobby.lastHostSnapshotAt = Date.now();
}

function publicSlots(lobby) {
  return lobby.slots.map(s => ({
    id: s.id,
    human: s.human,
    name: s.name,
    color: s.color,
    team: s.team,
    connId: s.human ? s.connId : null,
    connected: s.human,
    score: s.score || 0,
    kills: s.kills || 0,
    deaths: s.deaths || 0,
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

function chooseVotedMode(lobby) {
  const counts = new Map();
  for (const mode of lobby.modeVotes.values()) counts.set(mode, (counts.get(mode) || 0) + 1);
  if (counts.size === 0) return DEFAULT_MODE;
  const max = Math.max(...counts.values());
  const tied = [...counts.entries()].filter(([, c]) => c === max).map(([mode]) => mode);
  return tied[Math.floor(Math.random() * tied.length)] || DEFAULT_MODE;
}

function setPhase(lobby, phase) {
  lobby.phase = phase;
  const now = Date.now();
  if (phase === 'voting') {
    lobby.mode = DEFAULT_MODE;
    lobby.phaseEndsAt = now + VOTE_TIME * 1000;
    lobby.votes.clear();
    lobby.modeVotes.clear();
    lobby.latestRanked = null;
    lobby.latestScores = { blue: 0, red: 0 };
    for (let i = 0; i < lobby.slots.length; i++) {
      const s = lobby.slots[i];
      if (!s.human) Object.assign(s, makeBotSlot(i, lobby.map, s.lastSpawnIndex, lobby.mode), { id: s.id });
    }
  } else if (phase === 'playing') {
    lobby.map = chooseVotedMap(lobby);
    lobby.mode = chooseVotedMode(lobby);
    lobby.phaseEndsAt = now + MATCH_TIME * 1000;
    lobby.latestRanked = null;
    lobby.latestScores = { blue: 0, red: 0 };
    lobby.lastHostSnapshotAt = now;
    lobby.authorityEpoch++;
    lobby.lastHostSnapshotSeq = -1;
    const usedSpawns = new Set();
    for (let i = 0; i < lobby.slots.length; i++) {
      const s = lobby.slots[i];
      const spawn = chooseSpawn(lobby.map, s.lastSpawnIndex, usedSpawns);
      const team = teamForSlot(i, lobby.mode);
      usedSpawns.add(spawn.index);
      s.team = team;
      s.color = colorForSlot(i, team, lobby.mode);
      s.pos = spawn.pos;
      s.lastSpawnIndex = spawn.index;
      s.hp = 100;
      s.alive = true;
      s.respawn = 0;
      s.cooldown = 0;
      s.score = s.human ? 0 : s.score;
      s.kills = s.human ? 0 : s.kills;
      s.deaths = s.human ? 0 : s.deaths;
      s.lastInputSeq = -1;
      s.lastInputPos = spawn.pos;
      s.lastInputAt = now;
    }
  } else if (phase === 'podium') {
    lobby.phaseEndsAt = now + PODIUM_TIME * 1000;
  }
  broadcast(lobby, {
    type: 'phaseChanged',
    phase: lobby.phase,
    mapId: lobby.map.id,
    mode: lobby.mode,
    phaseEndsAt: lobby.phaseEndsAt,
    ranked: phase === 'podium' && lobby.latestRanked ? lobby.latestRanked : ranked(lobby),
    scores: lobby.latestScores,
    hostId: lobby.hostConnId,
    authorityEpoch: lobby.authorityEpoch,
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
  setLobbyHost(lobby, next.id);
  broadcastHost(lobby);
  broadcastLobbyMeta(lobby);
}

function ranked(lobby) {
  return [...lobby.slots].sort((a, b) => b.score - a.score || b.kills - a.kills || a.deaths - b.deaths)
    .map(s => ({ id: s.id, name: s.name, team: s.team, score: s.score, kills: s.kills, deaths: s.deaths, color: s.color, human: s.human }));
}

function sanitizeHostSnapshot(snapshot, lobby, snapshotSeq) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const players = Array.isArray(snapshot.players) ? snapshot.players.slice(0, SLOTS) : [];
  const humanSlots = new Map(lobby.slots.filter(s => s.human).map(s => [s.id, s]));
  const seenIds = new Set();
  const sanitizedPlayers = players.map((p, i) => {
    const id = String(p.id || `slot-${i}`).slice(0, 32);
    if (seenIds.has(id) || (!humanSlots.has(id) && !/^bot-\d{1,2}$/.test(id))) return null;
    seenIds.add(id);
    const canonical = humanSlots.get(id);
    const pos = sanitizePos(p.pos, lobby.map) || { x: 0, y: 0, z: 0 };
    const weapon = String(p.weapon || 'blaster').slice(0, 24);
    return {
      id,
      name: canonical?.name || cleanName(p.name || id),
      human: !!canonical,
      team: canonical?.team || String(p.team || id).slice(0, 32),
      color: canonical?.color || (/^#[0-9a-f]{6}$/i.test(String(p.color || '')) ? p.color : COLORS[i % COLORS.length]),
      pos,
      yaw: finite(p.yaw, 0),
      pitch: Math.max(-1.55, Math.min(1.55, finite(p.pitch, 0))),
      up: sanitizeUnitVec(p.up, { x: 0, y: 1, z: 0 }),
      hp: Math.max(0, Math.min(100, finite(p.hp, 100))),
      alive: p.alive !== false,
      score: clampInt(p.score, 0, 250000),
      kills: clampInt(p.kills, 0, 999),
      deaths: clampInt(p.deaths, 0, 999),
      awards: sanitizeAwards(p.awards),
      respawn: Math.max(0, Math.min(RESPAWN_TIME + 1, finite(p.respawn, 0))),
      weapon: WEAPON_IDS.has(weapon) ? weapon : 'blaster',
    };
  }).filter(Boolean);
  for (const [id, slot] of humanSlots) {
    if (seenIds.has(id)) continue;
    sanitizedPlayers.push({
      id, name: slot.name, human: true, team: slot.team, color: slot.color,
      pos: slot.pos || { x: 0, y: 0, z: 0 }, yaw: slot.yaw || 0, pitch: slot.pitch || 0,
      up: slot.up || { x: 0, y: 1, z: 0 }, hp: slot.hp ?? 100, alive: slot.alive !== false,
      score: slot.score || 0, kills: slot.kills || 0, deaths: slot.deaths || 0,
      awards: {}, respawn: slot.respawn || 0, weapon: 'blaster',
    });
  }
  const ranked = [...sanitizedPlayers].sort((a, b) =>
    b.score - a.score || b.kills - a.kills || a.deaths - b.deaths || a.id.localeCompare(b.id));
  const scores = snapshot.scores && typeof snapshot.scores === 'object'
    ? {
        blue: clampInt(snapshot.scores.blue, 0, 500000),
        red: clampInt(snapshot.scores.red, 0, 500000),
      }
    : { blue: 0, red: 0 };
  const allowedEventIds = new Set([...sanitizedPlayers.map(p => p.id), ...WORLD_EVENT_IDS]);
  const events = Array.isArray(snapshot.events)
    ? snapshot.events.slice(0, 32).map(ev => sanitizeEvent(ev, allowedEventIds)).filter(Boolean)
    : [];
  const drops = Array.isArray(snapshot.drops) ? snapshot.drops.slice(0, 32).map(d => sanitizeDrop(d, lobby)).filter(Boolean) : [];
  return {
    tick: Date.now(),
    authorityEpoch: lobby.authorityEpoch,
    seq: snapshotSeq,
    phase: lobby.phase,
    phaseEndsAt: lobby.phaseEndsAt,
    mapId: lobby.map.id,
    mode: lobby.mode,
    scores,
    ranked,
    players: sanitizedPlayers,
    events,
    drops,
  };
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.floor(finite(value, min))));
}

function sanitizeAwards(awards) {
  if (!awards || typeof awards !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(awards).slice(0, 24)) {
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(key)) continue;
    out[key] = clampInt(value, 0, 999);
  }
  return out;
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
    up: sanitizeUnitVec(drop.up, { x: 0, y: 1, z: 0 }),
    amount: Math.max(0, Math.min(5000, Math.floor(finite(drop.amount, kind === 'points' ? 250 : 0)))),
  };
  if (kind === 'drop') {
    const weapon = String(drop.weapon || 'blaster').slice(0, 24);
    out.weapon = WEAPON_IDS.has(weapon) ? weapon : 'blaster';
  }
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
    slot.up = p.up;
    slot.hp = p.hp;
    slot.alive = p.alive;
    slot.team = p.team;
    slot.color = p.color;
    slot.respawn = p.respawn;
    slot.score = p.score;
    slot.kills = p.kills;
    slot.deaths = p.deaths;
    if (slot.alive !== false && (!slot.lastInputPos || distance3(slot.lastInputPos, p.pos) > 18)) {
      slot.lastInputPos = p.pos;
      slot.lastInputAt = Date.now();
    }
  }
  lobby.latestRanked = snap.ranked || ranked(lobby);
  lobby.latestScores = snap.scores || lobby.latestScores;
}

function sanitizeEvent(ev, allowedIds) {
  if (!ev || typeof ev !== 'object') return null;
  const type = String(ev.type || '');
  if (type === 'shot') {
    const from = sanitizeEventPoint(ev.from);
    const to = sanitizeEventPoint(ev.to);
    if (!from || !to) return null;
    const shooterId = String(ev.shooterId || '').slice(0, 32);
    const weapon = String(ev.weapon || 'blaster').slice(0, 24);
    if (!allowedIds.has(shooterId)) return null;
    return {
      type,
      shooterId,
      weapon: WEAPON_IDS.has(weapon) ? weapon : 'blaster',
      from,
      to,
      color: /^#[0-9a-f]{6}$/i.test(String(ev.color || '')) ? ev.color : '#ffd23c',
      hit: !!ev.hit,
    };
  }
  if (type === 'damage') {
    const attackerId = String(ev.attackerId || '').slice(0, 32);
    const targetId = String(ev.targetId || '').slice(0, 32);
    if (!allowedIds.has(attackerId) || !allowedIds.has(targetId) || attackerId === targetId) return null;
    return {
      type,
      attackerId,
      targetId,
      amount: Math.max(0, Math.min(999, finite(ev.amount, 0))),
    };
  }
  if (type === 'kill') {
    const killerId = String(ev.killerId || '').slice(0, 32);
    const victimId = String(ev.victimId || '').slice(0, 32);
    if (!allowedIds.has(killerId) || !allowedIds.has(victimId) || killerId === victimId) return null;
    return {
      type,
      killerId,
      victimId,
    };
  }
  if (type === 'award') {
    const playerId = String(ev.playerId || '').slice(0, 32);
    if (!allowedIds.has(playerId)) return null;
    return {
      type,
      playerId,
      key: String(ev.key || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32),
      title: String(ev.title || '').replace(/[<>]/g, '').slice(0, 48),
      sub: String(ev.sub || '').replace(/[<>]/g, '').slice(0, 72),
      color: /^#[0-9a-f]{6}$/i.test(String(ev.color || '')) ? ev.color : '#ffd23c',
    };
  }
  return null;
}

function distance3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
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
