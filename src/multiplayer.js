import { MAPS } from './maps.js';
import * as THREE from 'three';
import { canVoteForMap } from './secret-maps.js';

const WS_PATH = '/ws';

class MultiplayerClient extends EventTarget {
  constructor() {
    super();
    this.ws = null;
    this.connected = false;
    this.playerId = null;
    this.slotId = null;
    this.lobbyId = null;
    this.phase = null;
    this.mapId = null;
    this.mode = 'ffa';
    this.phaseEndsAt = 0;
    this.isHost = false;
    this.hostId = null;
    this.authorityEpoch = 0;
    this.hostSnapshotSeq = 0;
    this.lastSnapshotSeq = -1;
    this.slots = [];
    this.seq = 0;
    this.name = localStorage.getItem('nerf-mp-name') || '';
    this.resumeToken = this._loadResumeToken();
    this.pendingInput = null;
    this.lastSnapshot = null;
    this.snapshotCount = 0;
    this.lastSnapshotAt = 0;
    this.lastPong = 0;
    this.intentionalClose = false;
    this.reconnecting = false;
    this.reconnectAttempts = 0;
    this.reconnectLobbyId = null;
    this.reconnectTimer = null;
    this._buildUI();
    this._buildChat();
    window.addEventListener('pagehide', () => this._closeForPageHide());
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
    this.intentionalClose = false;
    this.ws.addEventListener('open', () => {
      this.connected = true;
      this.status.textContent = this.reconnecting ? 'Rejoining lobby...' : 'Finding lobby...';
      const hello = { type: 'hello', name: this.name, resumeToken: this.resumeToken };
      if (this.reconnecting && this.reconnectLobbyId) hello.lobbyId = this.reconnectLobbyId;
      this.send(hello);
      this._ping();
    });
    this.ws.addEventListener('message', (e) => this._message(JSON.parse(e.data)));
    this.ws.addEventListener('close', () => {
      this.connected = false;
      this.ws = null;
      if (this.intentionalClose) {
        this.intentionalClose = false;
        return;
      }
      const lobbyId = this.lobbyId || this.reconnectLobbyId;
      if (lobbyId) {
        this.reconnectLobbyId = lobbyId;
        this.status.textContent = 'Connection lost. Rejoining...';
        this.dispatchEvent(new CustomEvent('connectionLost', { detail: { lobbyId } }));
        this._scheduleReconnect();
        return;
      }
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

  _loadResumeToken() {
    try {
      const stored = localStorage.getItem('nerf-mp-resume-token-v1');
      if (stored) return stored;
      const token = crypto.randomUUID().replaceAll('-', '');
      localStorage.setItem('nerf-mp-resume-token-v1', token);
      return token;
    } catch {
      return `session_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
    }
  }

  sendInput(player) {
    if (!player || !this.connected || !this.slotId) return;
    const aim = new THREE.Vector3(0, 0, -1);
    player.camera?.getWorldDirection?.(aim);
    this.seq++;
    this.send({
      type: 'input',
      authorityEpoch: this.authorityEpoch,
      seq: this.seq,
      yaw: player.yaw || 0,
      pitch: player.pitch || 0,
      up: player.up ? { x: player.up.x, y: player.up.y, z: player.up.z } : { x: 0, y: 1, z: 0 },
      aim: { x: aim.x, y: aim.y, z: aim.z },
      firing: !!player.firing,
      weapon: player.weapon || 'blaster',
      pos: { x: player.pos.x, y: player.pos.y, z: player.pos.z },
      vel: player.vel ? { x: player.vel.x, y: player.vel.y, z: player.vel.z } : { x: 0, y: 0, z: 0 },
      alive: player.alive !== false,
    });
  }

  vote(mapId) {
    this.send({ type: 'voteMap', mapId });
  }

  voteMode(mode) {
    this.send({ type: 'voteMode', mode });
  }

  leave() {
    this._clearReconnect();
    this.send({ type: 'leaveLobby' });
    this.slotId = null;
    this.lobbyId = null;
    this.phase = null;
    this.mapId = null;
    this.mode = 'ffa';
    this.phaseEndsAt = 0;
    this.isHost = false;
    this.hostId = null;
    this.authorityEpoch = 0;
    this.hostSnapshotSeq = 0;
    this.lastSnapshotSeq = -1;
    this.slots = [];
    this.lastSnapshot = null;
    this._clearChat();
  }

  isChatOpen() {
    return !!this.chatInput && !this.chatInput.hidden;
  }

  openChat() {
    if (!this.connected || !this.lobbyId || !this.chatInput || this.isChatOpen()) return false;
    this.chatInput.hidden = false;
    this.chatInput.value = '';
    this.chatInput.focus();
    return true;
  }

  closeChat() {
    if (!this.isChatOpen()) return false;
    this.chatInput.hidden = true;
    this.chatInput.value = '';
    this.chatInput.blur();
    return true;
  }

  sendChat(text) {
    const message = String(text || '').trim().slice(0, 120);
    if (message) this.send({ type: 'chat', text: message });
  }

  exitLobby() {
    this.leave();
    this.closeOverlay();
    this.dispatchEvent(new CustomEvent('exit'));
  }

  _closeForPageHide() {
    if (!this.ws) return;
    this.intentionalClose = true;
    this.send({ type: 'leaveLobby' });
    try {
      this.ws.close(1000, 'pagehide');
    } catch {}
  }

  _message(msg) {
    if (msg.type === 'welcome') {
      this.playerId = msg.id;
    } else if (msg.type === 'joinedLobby') {
      const wasReconnecting = this.reconnecting;
      if (this.lobbyId && this.lobbyId !== msg.lobbyId) this._clearChat();
      this._acceptAuthority(msg);
      this.slotId = msg.slotId;
      this.lobbyId = msg.lobbyId;
      this.phase = msg.phase;
      this.mapId = msg.mapId;
      this.mode = msg.mode || 'ffa';
      this.phaseEndsAt = msg.phaseEndsAt;
      this.isHost = !!msg.isHost;
      this.hostId = msg.hostId || null;
      this.slots = msg.slots || [];
      this._clearReconnect();
      this.closeOverlay();
      this.dispatchEvent(new CustomEvent('joined', { detail: msg }));
      if (wasReconnecting) this.dispatchEvent(new CustomEvent('reconnected', { detail: msg }));
      this._renderPhase();
    } else if (msg.type === 'hostChanged') {
      this._acceptAuthority(msg);
      this.isHost = !!msg.isHost;
      this.hostId = msg.hostId || null;
      this.slots = msg.slots || [];
      this.dispatchEvent(new CustomEvent('hostChanged', { detail: msg }));
    } else if (msg.type === 'lobbyList') {
      this._renderLobbyList(msg);
    } else if (msg.type === 'lobbyMeta') {
      this._acceptAuthority(msg);
      this.phase = msg.phase;
      this.mapId = msg.mapId;
      this.mode = msg.mode || this.mode || 'ffa';
      this.phaseEndsAt = msg.phaseEndsAt;
      this.hostId = msg.hostId || this.hostId;
      this.slots = msg.slots || this.slots;
      this._renderPhase(msg.votes, msg.modeVotes);
      this.dispatchEvent(new CustomEvent('meta', { detail: msg }));
    } else if (msg.type === 'phaseChanged') {
      this._acceptAuthority(msg);
      this.phase = msg.phase;
      this.mapId = msg.mapId;
      this.mode = msg.mode || this.mode || 'ffa';
      this.phaseEndsAt = msg.phaseEndsAt;
      this.hostId = msg.hostId || this.hostId;
      this.slots = msg.slots || this.slots;
      this.closeOverlay();
      this._renderPhase();
      this.dispatchEvent(new CustomEvent('phase', { detail: msg }));
    } else if (msg.type === 'remoteInput') {
      if (msg.authorityEpoch !== this.authorityEpoch) return;
      this.dispatchEvent(new CustomEvent('remoteInput', { detail: msg }));
    } else if (msg.type === 'snapshot') {
      if (!this._acceptSnapshot(msg)) return;
      this.lastSnapshot = msg;
      this.snapshotCount++;
      this.lastSnapshotAt = performance.now();
      this.phase = msg.phase;
      this.mapId = msg.mapId;
      this.mode = msg.mode || this.mode || 'ffa';
      this.phaseEndsAt = msg.phaseEndsAt;
      this.dispatchEvent(new CustomEvent('snapshot', { detail: msg }));
    } else if (msg.type === 'chat') {
      this._addChatMessage(msg.name, msg.text);
    } else if (msg.type === 'pong') {
      this.lastPong = performance.now() - msg.t;
    } else if (msg.type === 'error') {
      this.status.textContent = msg.message;
    }
  }

  sendHostSnapshot(snapshot) {
    this.hostSnapshotSeq++;
    this.send({
      type: 'hostSnapshot',
      authorityEpoch: this.authorityEpoch,
      seq: this.hostSnapshotSeq,
      snapshot,
    });
  }

  _acceptAuthority(msg) {
    const next = Math.max(0, Math.floor(Number(msg.authorityEpoch) || 0));
    if (!next || next === this.authorityEpoch) return;
    this.authorityEpoch = next;
    this.hostSnapshotSeq = 0;
    this.lastSnapshotSeq = -1;
    this.lastSnapshot = null;
  }

  _acceptSnapshot(msg) {
    const epoch = Math.max(0, Math.floor(Number(msg.authorityEpoch) || 0));
    const seq = Math.floor(Number(msg.seq));
    if (!epoch || !Number.isFinite(seq)) return false;
    if (this.authorityEpoch && epoch !== this.authorityEpoch) return false;
    if (!this.authorityEpoch) this._acceptAuthority(msg);
    if (seq <= this.lastSnapshotSeq) return false;
    this.lastSnapshotSeq = seq;
    return true;
  }

  shouldHost() {
    return !!this.isHost || (!!this.hostId && this.hostId === this.playerId);
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
    this._clearReconnect();
    this.ensureConnected();
    if (this.ws?.readyState === WebSocket.OPEN) this.send({ type: 'hello', name, resumeToken: this.resumeToken });
  }

  _scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnecting = true;
    this.reconnectAttempts++;
    const delay = Math.min(8000, 750 * 2 ** Math.min(this.reconnectAttempts - 1, 4));
    this.reconnectTimer = setTimeout(() => {
      this.ensureConnected();
    }, delay);
  }

  _clearReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnecting = false;
    this.reconnectAttempts = 0;
    this.reconnectLobbyId = null;
  }

  _renderLobbyList(msg) {
    this.overlay.hidden = false;
    this.panel.dataset.mode = 'lobbies';
    this.title.textContent = msg.full ? 'All Lobbies Full' : 'Choose Lobby';
    this.body.innerHTML = '';
    for (const lobby of msg.lobbies) {
      const btn = document.createElement('button');
      btn.className = 'mp-row';
      btn.innerHTML = `<span>${lobby.label}</span><small>${lobby.humans}/${lobby.max} humans · ${lobby.phase.toUpperCase()} · ${(lobby.mode || 'ffa').toUpperCase()} · ${lobby.mapName}</small>`;
      btn.disabled = lobby.humans >= lobby.max;
      btn.addEventListener('click', () => {
        this.send({ type: 'joinLobby', lobbyId: lobby.id });
        this.status.textContent = 'Joining...';
      });
      this.body.append(btn);
    }
    this.status.textContent = msg.full ? 'Wait for a slot to open.' : '';
  }

  _renderPhase(votes = {}, modeVotes = null) {
    if (this.phase === 'voting') {
      this.overlay.hidden = false;
      this.panel.dataset.mode = 'vote';
      this.title.textContent = 'Vote For Next Match';
      this.body.innerHTML = '';
      const humans = (this.slots || []).filter(s => s.human).length;
      const summary = document.createElement('div');
      summary.className = 'mp-lobby-summary';
      summary.textContent = `${humans}/${this.slots.length || 8} human players in lobby`;
      this.body.append(summary);
      const modes = [
        ['ffa', 'FREE FOR ALL'],
        ['tdm', 'TEAM DEATHMATCH'],
      ];
      const modeCounts = modeVotes || {};
      const modeWrap = document.createElement('div');
      modeWrap.className = 'mp-section';
      modeWrap.innerHTML = '<h3>Mode</h3>';
      for (const [mode, label] of modes) {
        const btn = document.createElement('button');
        btn.className = 'mp-map';
        btn.innerHTML = `<span>${label}</span><small>${modeCounts[mode] || 0} votes</small>`;
        btn.addEventListener('click', () => this.voteMode(mode));
        modeWrap.append(btn);
      }
      this.body.append(modeWrap);
      const mapWrap = document.createElement('div');
      mapWrap.className = 'mp-section';
      mapWrap.innerHTML = '<h3>Map</h3>';
      for (const map of MAPS.filter(canVoteForMap)) {
        const btn = document.createElement('button');
        btn.className = 'mp-map';
        btn.innerHTML = `<span>${map.emoji} ${map.name}</span><small>${votes[map.id] || 0} votes</small>`;
        btn.addEventListener('click', () => this.vote(map.id));
        mapWrap.append(btn);
      }
      this.body.append(mapWrap);
      const exit = document.createElement('button');
      exit.className = 'mp-exit';
      exit.textContent = 'EXIT MULTIPLAYER';
      exit.addEventListener('click', () => this.exitLobby());
      this.body.append(exit);
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
      .mp-section{display:grid;gap:10px}
      .mp-section h3{font-size:14px;letter-spacing:2px;text-transform:uppercase;color:#9fb0ff;margin:4px 0 0}
      .mp-lobby-summary{font-family:Arial,sans-serif;font-weight:900;text-align:center;color:#c9d2ff;background:rgba(80,100,180,.18);border:1px solid rgba(159,176,255,.35);border-radius:8px;padding:9px 12px}
      .mp-exit{font:inherit;cursor:pointer;border-radius:8px;border:2px solid rgba(255,92,92,.65);background:rgba(120,20,32,.72);color:#fff;padding:12px 14px;text-align:center;margin-top:4px}
      .mp-exit:hover{border-color:#ffd23c;background:rgba(160,34,42,.85)}
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

  _buildChat() {
    const style = document.createElement('style');
    style.textContent = `
      #mpChat{position:fixed;left:18px;bottom:150px;z-index:21;width:min(420px,calc(100vw - 36px));pointer-events:none;color:#fff;font-family:Arial,sans-serif;font-weight:bold;text-shadow:0 2px 3px #000}
      #mpChatMessages{display:flex;flex-direction:column;gap:4px;min-height:24px;justify-content:flex-end}
      .mp-chat-line{padding:4px 7px;border-radius:3px;background:rgba(8,10,24,.68);overflow-wrap:anywhere;font-size:14px;line-height:1.25}
      .mp-chat-name{color:#ffd23c;margin-right:6px}
      #mpChatInput{width:100%;margin-top:7px;padding:9px 11px;border:1px solid rgba(255,210,60,.8);border-radius:3px;background:rgba(8,10,24,.94);color:#fff;font:700 14px Arial,sans-serif;pointer-events:auto;outline:none}
      #mpChatInput:focus{box-shadow:0 0 0 2px rgba(92,179,255,.75)}
      @media (max-width:720px){#mpChat{left:10px;bottom:132px;width:calc(100vw - 20px)}.mp-chat-line{font-size:12px}}
    `;
    document.head.append(style);
    this.chat = document.createElement('div');
    this.chat.id = 'mpChat';
    this.chat.innerHTML = '<div id="mpChatMessages"></div><input id="mpChatInput" hidden maxlength="120" autocomplete="off" placeholder="Type a message…">';
    document.body.append(this.chat);
    this.chatMessages = this.chat.querySelector('#mpChatMessages');
    this.chatInput = this.chat.querySelector('#mpChatInput');
    this.chatInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.code === 'Enter') {
        this.sendChat(this.chatInput.value);
        this.closeChat();
        document.getElementById('game')?.requestPointerLock?.();
      } else if (e.code === 'Escape') {
        this.closeChat();
        document.getElementById('game')?.requestPointerLock?.();
      }
    });
  }

  _addChatMessage(name, text) {
    if (!this.chatMessages || typeof text !== 'string') return;
    const line = document.createElement('div');
    line.className = 'mp-chat-line';
    const sender = document.createElement('span');
    sender.className = 'mp-chat-name';
    sender.textContent = `${String(name || 'Player')}:`;
    line.append(sender, document.createTextNode(text));
    this.chatMessages.append(line);
    while (this.chatMessages.children.length > 6) this.chatMessages.firstElementChild.remove();
  }

  _clearChat() {
    this.closeChat();
    this.chatMessages?.replaceChildren();
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
