import { MAPS } from './maps.js';

const WS_PATH = '/ws';

export class MultiplayerClient extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.connected = false;
    this.playerId = null;
    this.slotId = null;
    this.lobbyId = null;
    this.phase = null;
    this.mapId = null;
    this.phaseEndsAt = 0;
    this.isHost = false;
    this.hostId = null;
    this.slots = [];
    this.seq = 0;
    this.name = localStorage.getItem('nerf-mp-name') || '';
    this.pendingInput = null;
    this.lastSnapshot = null;
    this.lastPong = 0;
    this._buildUI();
  }

  open() {
    this._renderNameEntry();
    this.overlay.hidden = false;
    this.nameInput.value = this.name;
    this.status.textContent = '';
    this.nameInput.focus();
  }

  closeOverlay() {
    this.overlay.hidden = true;
  }

  ensureConnected() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${proto}//${location.host}${WS_PATH}`);
    this.ws.addEventListener('open', () => {
      this.connected = true;
      this.status.textContent = 'Finding lobby...';
      this.send({ type: 'hello', name: this.name });
      this._ping();
    });
    this.ws.addEventListener('message', (e) => this._message(JSON.parse(e.data)));
    this.ws.addEventListener('close', () => {
      this.connected = false;
      this.status.textContent = 'Disconnected. Re-enter the portal to retry.';
      this.dispatchEvent(new CustomEvent('disconnect'));
    });
    this.ws.addEventListener('error', () => {
      this.status.textContent = 'Multiplayer server is not available from this page.';
    });
  }

  send(msg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  sendInput(player) {
    if (!player || !this.connected || !this.slotId) return;
    this.seq++;
    this.send({
      type: 'input',
      seq: this.seq,
      yaw: player.yaw || 0,
      pitch: player.pitch || 0,
      firing: !!player.firing,
      weapon: player.weapon || 'blaster',
      pos: { x: player.pos.x, y: player.pos.y, z: player.pos.z },
    });
  }

  vote(mapId) {
    this.send({ type: 'voteMap', mapId });
  }

  leave() {
    this.send({ type: 'leaveLobby' });
    this.slotId = null;
    this.lobbyId = null;
  }

  _message(msg) {
    if (msg.type === 'welcome') {
      this.playerId = msg.id;
    } else if (msg.type === 'joinedLobby') {
      this.slotId = msg.slotId;
      this.lobbyId = msg.lobbyId;
      this.phase = msg.phase;
      this.mapId = msg.mapId;
      this.phaseEndsAt = msg.phaseEndsAt;
      this.isHost = !!msg.isHost;
      this.hostId = msg.hostId || null;
      this.slots = msg.slots || [];
      this.closeOverlay();
      this.dispatchEvent(new CustomEvent('joined', { detail: msg }));
      this._renderPhase();
    } else if (msg.type === 'hostChanged') {
      this.isHost = !!msg.isHost;
      this.hostId = msg.hostId || null;
      this.slots = msg.slots || [];
      this.dispatchEvent(new CustomEvent('hostChanged', { detail: msg }));
    } else if (msg.type === 'lobbyList') {
      this._renderLobbyList(msg);
    } else if (msg.type === 'lobbyMeta') {
      this.phase = msg.phase;
      this.mapId = msg.mapId;
      this.phaseEndsAt = msg.phaseEndsAt;
      this.hostId = msg.hostId || this.hostId;
      this.slots = msg.slots || this.slots;
      this._renderPhase(msg.votes);
      this.dispatchEvent(new CustomEvent('meta', { detail: msg }));
    } else if (msg.type === 'phaseChanged') {
      this.phase = msg.phase;
      this.mapId = msg.mapId;
      this.phaseEndsAt = msg.phaseEndsAt;
      this.hostId = msg.hostId || this.hostId;
      this.slots = msg.slots || this.slots;
      this.closeOverlay();
      this._renderPhase();
      this.dispatchEvent(new CustomEvent('phase', { detail: msg }));
    } else if (msg.type === 'remoteInput') {
      this.dispatchEvent(new CustomEvent('remoteInput', { detail: msg }));
    } else if (msg.type === 'snapshot') {
      this.lastSnapshot = msg;
      this.phase = msg.phase;
      this.mapId = msg.mapId;
      this.phaseEndsAt = msg.phaseEndsAt;
      this.dispatchEvent(new CustomEvent('snapshot', { detail: msg }));
    } else if (msg.type === 'pong') {
      this.lastPong = performance.now() - msg.t;
    } else if (msg.type === 'error') {
      this.status.textContent = msg.message;
    }
  }

  sendHostSnapshot(snapshot) {
    this.send({ type: 'hostSnapshot', snapshot });
  }

  _submitName() {
    const name = this.nameInput.value.trim().slice(0, 18);
    if (!name) {
      this.status.textContent = 'Enter a name first.';
      return;
    }
    this.name = name;
    localStorage.setItem('nerf-mp-name', name);
    this.status.textContent = 'Connecting...';
    this.ensureConnected();
    if (this.ws?.readyState === WebSocket.OPEN) this.send({ type: 'hello', name });
  }

  _renderLobbyList(msg) {
    this.overlay.hidden = false;
    this.panel.dataset.mode = 'lobbies';
    this.title.textContent = msg.full ? 'All Lobbies Full' : 'Choose Lobby';
    this.body.innerHTML = '';
    for (const lobby of msg.lobbies) {
      const btn = document.createElement('button');
      btn.className = 'mp-row';
      btn.innerHTML = `<span>${lobby.label}</span><small>${lobby.humans}/${lobby.max} humans · ${lobby.phase.toUpperCase()} · ${lobby.mapName}</small>`;
      btn.disabled = lobby.humans >= lobby.max;
      btn.addEventListener('click', () => {
        this.send({ type: 'joinLobby', lobbyId: lobby.id });
        this.status.textContent = 'Joining...';
      });
      this.body.append(btn);
    }
    this.status.textContent = msg.full ? 'Wait for a slot to open.' : '';
  }

  _renderPhase(votes = {}) {
    if (this.phase === 'voting') {
      this.overlay.hidden = false;
      this.panel.dataset.mode = 'vote';
      this.title.textContent = 'Vote For Next Map';
      this.body.innerHTML = '';
      for (const map of MAPS) {
        const btn = document.createElement('button');
        btn.className = 'mp-map';
        btn.innerHTML = `<span>${map.emoji} ${map.name}</span><small>${votes[map.id] || 0} votes</small>`;
        btn.addEventListener('click', () => this.vote(map.id));
        this.body.append(btn);
      }
    } else if (this.phase === 'podium') {
      this.overlay.hidden = true;
    } else if (this.phase === 'playing') {
      this.overlay.hidden = true;
    }
    this._tickCountdown();
  }

  _tickCountdown() {
    clearInterval(this.countdownTimer);
    const tick = () => {
      if (!this.phaseEndsAt) return;
      const left = Math.max(0, Math.ceil((this.phaseEndsAt - Date.now()) / 1000));
      if (this.phase === 'voting') this.status.textContent = `Voting ends in ${left}s`;
      else if (this.phase === 'podium') this.status.textContent = `Next vote in ${left}s`;
    };
    tick();
    this.countdownTimer = setInterval(tick, 250);
  }

  _ping() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.send({ type: 'ping', t: performance.now() });
    setTimeout(() => this._ping(), 5000);
  }

  _buildUI() {
    const style = document.createElement('style');
    style.textContent = `
      #mpOverlay[hidden]{display:none}
      #mpOverlay{position:fixed;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;background:rgba(0,0,12,.62);color:#fff;pointer-events:auto}
      #mpPanel{width:min(92vw,680px);max-height:86vh;overflow:auto;background:rgba(9,12,30,.96);border:2px solid rgba(255,210,60,.58);border-radius:10px;box-shadow:0 18px 70px rgba(0,0,0,.5);padding:20px}
      #mpPanel h2{font-size:28px;color:#ffd23c;margin-bottom:14px;text-align:center}
      #mpBody{display:grid;gap:10px}
      #mpNameRow{display:flex;gap:10px}
      #mpName{flex:1;font:inherit;font-size:18px;padding:12px;border-radius:8px;border:2px solid #2a3468;background:#11162f;color:#fff}
      .mp-primary,.mp-row,.mp-map{font:inherit;cursor:pointer;border-radius:8px;border:2px solid #2a3468;background:#141a38;color:#fff;padding:12px 14px;text-align:left}
      .mp-primary{background:#c8461e;border-color:#ffd23c;text-align:center}
      .mp-row,.mp-map{display:flex;align-items:center;justify-content:space-between;gap:18px}
      .mp-row:hover,.mp-map:hover{border-color:#ffd23c}
      .mp-row small,.mp-map small{font-family:Arial,sans-serif;color:#9fb0ff;font-weight:bold}
      #mpStatus{margin-top:12px;min-height:20px;text-align:center;color:#9fb0ff;font-family:Arial,sans-serif;font-weight:bold}
    `;
    document.head.append(style);

    this.overlay = document.createElement('div');
    this.overlay.id = 'mpOverlay';
    this.overlay.hidden = true;
    this.overlay.innerHTML = `
      <div id="mpPanel">
        <h2 id="mpTitle">Join Multiplayer</h2>
        <div id="mpBody"></div>
        <div id="mpStatus"></div>
      </div>
    `;
    document.body.append(this.overlay);
    this.panel = this.overlay.querySelector('#mpPanel');
    this.title = this.overlay.querySelector('#mpTitle');
    this.body = this.overlay.querySelector('#mpBody');
    this.status = this.overlay.querySelector('#mpStatus');
    this._renderNameEntry();
  }

  _renderNameEntry() {
    if (!this.body) return;
    this.title.textContent = 'Join Multiplayer';
    this.body.innerHTML = `
      <div id="mpNameRow">
        <input id="mpName" maxlength="18" autocomplete="nickname" placeholder="Your name">
        <button class="mp-primary" id="mpJoin">JOIN</button>
      </div>
    `;
    this.nameInput = this.overlay.querySelector('#mpName');
    this.nameInput.value = this.name;
    this.overlay.querySelector('#mpJoin').addEventListener('click', () => this._submitName());
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.code === 'Enter') this._submitName();
    });
  }
}

export const multiplayer = new MultiplayerClient();
