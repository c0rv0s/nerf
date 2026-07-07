// DOM HUD: health, ammo, weapon slots, scores, killfeed, messages, scoreboard.
// Mode-aware: FFA shows YOU vs leader; TDM shows blue vs red.
import { WEAPONS, WEAPON_ORDER } from './weapons.js';

const $ = (id) => document.getElementById(id);

export class HUD {
  constructor() {
    this.els = {
      hud: $('hud'), health: $('healthnum'), shield: $('shieldnum'), fill: $('healthfill'),
      ammo: $('ammonum'), wname: $('weaponname'), slots: $('wslots'),
      left: $('scoreBlue'), right: $('scoreRed'), timer: $('timer'), top3: $('top3'),
      feed: $('killfeed'), msg: $('message'), power: $('powerup'),
      vignette: $('vignette'), hit: $('hitmarker'),
      respawn: $('respawn'), respawnCount: $('respawncount'),
      board: $('scoreboard'),
    };
    this.msgTimer = 0;
    this.hitTimer = 0;
    this.vigTimer = 0;
  }

  show(on) { this.els.hud.classList.toggle('on', on); }

  update(dt, state) {
    const { player, mode, scores, characters, timeLeft, showBoard, world } = state;
    const e = this.els;
    e.health.textContent = Math.max(0, Math.ceil(player.hp));
    e.shield.textContent = player.shield > 0 ? `+${Math.ceil(player.shield)} 🛡` : '';
    e.fill.style.width = Math.max(0, player.hp) + '%';
    const w = WEAPONS[player.weapon];
    e.wname.textContent = w.name;
    e.ammo.textContent = player.weapon === 'blaster' ? '∞' : player.ammo[player.weapon] ?? 0;

    // weapon slots
    const weaponOrder = world?.availableWeapons || WEAPON_ORDER.filter(id => !WEAPONS[id].secretMapOnly);
    const slotKey = weaponOrder.join(',');
    if (!this._slotEls || this._slotKey !== slotKey) {
      e.slots.innerHTML = '';
      this._slotKey = slotKey;
      this._slotEls = weaponOrder.map((id) => {
        const d = document.createElement('div');
        d.className = 'wslot';
        d.textContent = WEAPONS[id].slot;
        e.slots.appendChild(d);
        return d;
      });
    }
    weaponOrder.forEach((id, i) => {
      // a dry gun stays in your inventory (dashed slot) — find ammo to reload it
      const has = id === 'blaster' || player.weapons[id];
      const loaded = id === 'blaster' || player.ammo[id] > 0;
      this._slotEls[i].className = 'wslot' +
        (has ? (loaded ? ' owned' : ' empty') : '') +
        (player.weapon === id ? ' active' : '');
    });

    // score bar + FFA top-3 leaderboard
    if (mode === 'atrium') {          // lobby: no scores, no leaderboard
      e.top3.style.display = 'none';
    } else if (mode === 'tdm') {
      e.left.textContent = scores.blue;
      e.left.style.color = '#5cb3ff';
      e.right.textContent = scores.red;
      e.right.style.color = '#ff5c5c';
      e.top3.style.display = 'none';
    } else {
      const ranked = [...characters].sort((a, b) => b.score - a.score);
      const rank = ranked.indexOf(player) + 1;
      e.left.textContent = `YOU ${player.score}`;
      e.left.style.color = '#ffd23c';
      e.right.textContent = `#${rank}`;
      e.right.style.color = rank === 1 ? '#ffd23c' : '#ccd';
      e.top3.style.display = 'block';
      e.top3.innerHTML = ranked.map((c, i) => `
        <div class="t3row"><span><span class="t3rank">${i + 1}.</span>
        <span style="color:${c.color}">${c.isPlayer ? 'YOU' : c.name}</span></span>
        <span>${c.score}</span></div>`).join('');
    }
    const m = Math.floor(Math.max(0, timeLeft) / 60), s = Math.floor(Math.max(0, timeLeft) % 60);
    e.timer.textContent = `${m}:${String(s).padStart(2, '0')}`;

    // powerup banner
    if (player.powerup) {
      e.power.style.display = 'block';
      e.power.className = 'panel ' + player.powerup.kind;
      const label = player.powerup.kind === 'gold' ? 'GOLD NERF — 3× DAMAGE' : 'SILVER NERF — 2× DAMAGE';
      e.power.textContent = `${label} · ${Math.ceil(player.powerup.timeLeft)}s`;
    } else {
      e.power.style.display = 'none';
    }

    // fading elements
    this.msgTimer -= dt;
    if (this.msgTimer <= 0) e.msg.style.opacity = 0;
    this.hitTimer -= dt;
    e.hit.style.opacity = this.hitTimer > 0 ? 1 : 0;
    this.vigTimer -= dt;
    e.vignette.style.opacity = this.vigTimer > 0 ? 1 : 0;

    // scoreboard
    e.board.style.display = showBoard ? 'block' : 'none';
    if (showBoard) this.renderBoard(state);
  }

  renderBoard({ characters, scores, mode }) {
    const rows = [...characters].sort((a, b) => b.score - a.score)
      .map(c => `<tr>
        <td style="color:${c.color}">${c.name}${c.isPlayer ? ' ◄' : ''}</td>
        <td>${c.score}</td><td>${c.kills}</td><td>${c.deaths}</td></tr>`).join('');
    const head = mode === 'tdm'
      ? `<h3><span style="color:#5cb3ff">BLUE ${scores.blue}</span> —
          <span style="color:#ff5c5c">${scores.red} RED</span></h3>`
      : `<h3 style="color:#ffd23c">FREE FOR ALL</h3>`;
    this.els.board.innerHTML = `${head}
      <table><tr><th>Player</th><th>Score</th><th>Kills</th><th>Deaths</th></tr>${rows}</table>`;
  }

  message(text, color = '#ffd23c') {
    this.els.msg.textContent = text;
    this.els.msg.style.color = color;
    this.els.msg.style.opacity = 1;
    this.msgTimer = 2.2;
  }

  killfeed(killer, victim) {
    const div = document.createElement('div');
    div.innerHTML = `<span style="color:${killer.color || '#ccc'}">${killer.name}</span>
      🎯 <span style="color:${victim.color || '#ccc'}">${victim.name}</span>`;
    this.els.feed.prepend(div);
    while (this.els.feed.children.length > 5) this.els.feed.lastChild.remove();
    setTimeout(() => div.remove(), 5000);
  }

  hitmarker() { this.hitTimer = 0.12; }
  damageFlash() { this.vigTimer = 0.35; }

  showRespawn(on, secs = 0) {
    this.els.respawn.style.display = on ? 'flex' : 'none';
    if (on) this.els.respawnCount.textContent = `Respawning in ${Math.ceil(secs)}…`;
  }
}
