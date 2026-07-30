import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

class TestClient {
  constructor(url, name, resumeToken) {
    this.messages = [];
    this.waiters = [];
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolveOpen, rejectOpen) => {
      this.ws.addEventListener('open', resolveOpen, { once: true });
      this.ws.addEventListener('error', rejectOpen, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      this.messages.push(message);
      for (const waiter of [...this.waiters]) {
        if (!waiter.predicate(message)) continue;
        clearTimeout(waiter.timer);
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    });
    this.joined = this.opened.then(() => {
      this.send({ type: 'hello', name, resumeToken });
      return this.waitFor(message => message.type === 'joinedLobby');
    });
  }

  send(message) {
    this.ws.send(JSON.stringify(message));
  }

  waitFor(predicate, timeoutMs = 3000) {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolveWait, rejectWait) => {
      const waiter = {
        predicate,
        resolve: resolveWait,
        timer: setTimeout(() => {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          rejectWait(new Error('Timed out waiting for multiplayer message'));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  close() {
    this.ws.close();
  }
}

async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

async function startServer(port, env = {}) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: '',
      VOTE_TIME: '0.5',
      MATCH_TIME: '10',
      PODIUM_TIME: '0.5',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolveStart, rejectStart) => {
    let output = '';
    const timer = setTimeout(() => rejectStart(new Error(`Server did not start: ${output}`)), 4000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (!output.includes('NERF Arena server listening')) return;
      clearTimeout(timer);
      resolveStart();
    });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('exit', (code) => {
      clearTimeout(timer);
      rejectStart(new Error(`Server exited before startup (${code}): ${output}`));
    });
  });
  return child;
}

test('guest input follows the host spawn and loadout snapshots include dropped weapons', {
  skip: typeof WebSocket === 'undefined' ? 'Requires the Node WebSocket client' : false,
}, async (t) => {
  const port = await freePort();
  const server = await startServer(port);
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.close();
    server.kill('SIGTERM');
    await once(server, 'exit').catch(() => {});
  });

  const url = `ws://127.0.0.1:${port}/ws`;
  const host = new TestClient(url, 'Host', 'integration_host_token_123456');
  clients.push(host);
  const hostJoined = await host.joined;
  const guest = new TestClient(url, 'Guest', 'integration_guest_token_12345');
  clients.push(guest);
  const guestJoined = await guest.joined;

  host.send({ type: 'voteMap', mapId: 'arena' });
  guest.send({ type: 'voteMap', mapId: 'arena' });
  const playing = await host.waitFor(message =>
    message.type === 'phaseChanged' && message.phase === 'playing', 4000);
  const epoch = playing.authorityEpoch;
  const hostSlot = hostJoined.slotId;
  const guestSlot = guestJoined.slotId;
  let snapshotSeq = 1;

  host.send({
    type: 'hostSnapshot',
    authorityEpoch: epoch,
    seq: snapshotSeq,
    snapshot: {
      players: [{
        id: hostSlot,
        name: 'Host',
        human: true,
        pos: { x: -22, y: 0.1, z: -22 },
        hp: 100,
        alive: true,
        weapons: ['blaster'],
        ammo: {},
      }],
      events: [],
      drops: [],
    },
  });
  const initialSnapshot = await guest.waitFor(message =>
    message.type === 'snapshot' && message.seq === snapshotSeq);
  const canonical = initialSnapshot.players.find(player => player.id === guestSlot).pos;
  const shifted = {
    x: canonical.x + (canonical.x === 0 ? 17 : -Math.sign(canonical.x) * 17),
    y: canonical.y,
    z: canonical.z,
  };

  snapshotSeq++;
  host.send({
    type: 'hostSnapshot',
    authorityEpoch: epoch,
    seq: snapshotSeq,
    snapshot: {
      players: [
        {
          id: hostSlot,
          name: 'Host',
          human: true,
          pos: { x: -22, y: 0.1, z: -22 },
          hp: 100,
          alive: true,
          weapons: ['blaster'],
          ammo: {},
        },
        {
          id: guestSlot,
          name: 'Guest',
          human: true,
          pos: shifted,
          hp: 100,
          alive: true,
          weapon: 'scatter',
          weapons: ['blaster', 'scatter'],
          ammo: { scatter: 7 },
        },
      ],
      events: [{
        type: 'damage',
        attackerId: guestSlot,
        targetId: hostSlot,
        amount: 25,
      }],
      drops: [
        {
          id: 'integration:points:1',
          kind: 'points',
          amount: 250,
          pos: { x: 0, y: 0.1, z: 0 },
        },
        {
          id: 'integration:drop:2',
          kind: 'drop',
          weapon: 'scatter',
          amount: 7,
          pos: { x: 1, y: 0.1, z: 0 },
        },
      ],
      targetCooldowns: [
        { id: 'target-poster-0', cooldown: 29.25 },
        { id: 'target-poster-0', cooldown: 5 },
        { id: 'not-a-target', cooldown: 30 },
      ],
    },
  });
  const shiftedSnapshot = await guest.waitFor(message =>
    message.type === 'snapshot' && message.seq === snapshotSeq);
  const guestState = shiftedSnapshot.players.find(player => player.id === guestSlot);
  assert.equal(guestState.weapon, 'scatter');
  assert.deepEqual(guestState.weapons, ['blaster', 'scatter']);
  assert.deepEqual(guestState.ammo, { scatter: 7 });
  assert.deepEqual(shiftedSnapshot.events, [{
    type: 'damage',
    attackerId: guestSlot,
    targetId: hostSlot,
    amount: 25,
  }]);
  assert.deepEqual(shiftedSnapshot.drops.map(drop => ({
    id: drop.id,
    kind: drop.kind,
    weapon: drop.weapon,
    amount: drop.amount,
  })), [
    { id: 'integration:points:1', kind: 'points', weapon: undefined, amount: 250 },
    { id: 'integration:drop:2', kind: 'drop', weapon: 'scatter', amount: 7 },
  ]);
  assert.deepEqual(shiftedSnapshot.targetCooldowns, [
    { id: 'target-poster-0', cooldown: 29.25 },
  ]);

  guest.send({
    type: 'input',
    authorityEpoch: epoch,
    seq: 1,
    pos: shifted,
    vel: { x: 0, y: 0, z: 0 },
    alive: true,
    weapon: 'scatter',
  });
  const accepted = await host.waitFor(message =>
    message.type === 'remoteInput' &&
    message.slotId === guestSlot &&
    message.input.seq === 1);
  assert.deepEqual(accepted.input.pos, shifted);
  assert.equal(accepted.input.weapon, 'scatter');

  snapshotSeq++;
  host.send({
    type: 'hostSnapshot',
    authorityEpoch: epoch,
    seq: snapshotSeq,
    snapshot: {
      players: [
        {
          id: hostSlot,
          name: 'Host',
          human: true,
          pos: { x: -22, y: 0.1, z: -22 },
          hp: 100,
          alive: true,
          weapons: ['blaster'],
          ammo: {},
        },
        {
          id: guestSlot,
          name: 'Guest',
          human: true,
          pos: shifted,
          hp: 0,
          alive: false,
          respawn: 3,
          weapons: ['blaster', 'scatter'],
          ammo: { scatter: 7 },
        },
      ],
      events: [],
      drops: [],
    },
  });
  await guest.waitFor(message => message.type === 'snapshot' && message.seq === snapshotSeq);

  const respawned = { x: 22, y: 0.1, z: 22 };
  snapshotSeq++;
  host.send({
    type: 'hostSnapshot',
    authorityEpoch: epoch,
    seq: snapshotSeq,
    snapshot: {
      players: [
        {
          id: hostSlot,
          name: 'Host',
          human: true,
          pos: { x: -22, y: 0.1, z: -22 },
          hp: 100,
          alive: true,
          weapons: ['blaster'],
          ammo: {},
        },
        {
          id: guestSlot,
          name: 'Guest',
          human: true,
          pos: respawned,
          hp: 100,
          alive: true,
          weapons: ['blaster'],
          ammo: {},
        },
      ],
      events: [],
      drops: [],
    },
  });
  await guest.waitFor(message => message.type === 'snapshot' && message.seq === snapshotSeq);
  guest.send({
    type: 'input',
    authorityEpoch: epoch,
    seq: 2,
    pos: respawned,
    vel: { x: 0, y: 0, z: 0 },
    alive: true,
    weapon: 'blaster',
  });
  const acceptedRespawn = await host.waitFor(message =>
    message.type === 'remoteInput' &&
    message.slotId === guestSlot &&
    message.input.seq === 2);
  assert.deepEqual(acceptedRespawn.input.pos, respawned);
});

test('stalled clients do not ping-pong host authority and restart the match', {
  skip: typeof WebSocket === 'undefined' ? 'Requires the Node WebSocket client' : false,
}, async (t) => {
  const port = await freePort();
  const server = await startServer(port, { HOST_SNAPSHOT_TIMEOUT_MS: '200' });
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.close();
    server.kill('SIGTERM');
    await once(server, 'exit').catch(() => {});
  });

  const url = `ws://127.0.0.1:${port}/ws`;
  const first = new TestClient(url, 'First', 'failover_first_token_12345');
  clients.push(first);
  await first.joined;
  const second = new TestClient(url, 'Second', 'failover_second_token_1234');
  clients.push(second);
  await second.joined;

  await first.waitFor(message =>
    message.type === 'phaseChanged' && message.phase === 'playing', 4000);
  first.messages = [];
  second.messages = [];

  // Neither rendered client publishes snapshots. Authority may fail over once,
  // but it must not bounce back to the already-stalled host every timeout.
  await new Promise(resolveWait => setTimeout(resolveWait, 1100));
  const firstChanges = first.messages.filter(message => message.type === 'hostChanged');
  const secondChanges = second.messages.filter(message => message.type === 'hostChanged');
  assert.equal(firstChanges.length, 1);
  assert.equal(secondChanges.length, 1);
  assert.equal(firstChanges[0].authorityEpoch, secondChanges[0].authorityEpoch);
});
