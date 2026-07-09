// DOM HUD: health, ammo, weapon slots, scores, killfeed, messages, scoreboard.
// Mode-aware: FFA shows YOU vs leader; TDM shows blue vs red.
import { WEAPONS, WEAPON_ORDER } from './weapons.js';

const $ = (id) => document.getElementById(id);
const setText = (el, value) => {
  const next = String(value);
  if (el.textContent !== next) el.textContent = next;
};
const setStyle = (el, prop, value) => {
  if (el.style[prop] !== value) el.style[prop] = value;
};
const setClass = (el, value) => {
  if (el.className !== value) el.className = value;
};

export class HUD {
  constructor() {
    this.els = {
      hud: $('hud'), health: $('healthnum'), shield: $('shieldnum'), fill: $('healthfill'),
      ammo: $('ammonum'), wname: $('weaponname'), slots: $('wslots'),
      left: $('scoreBlue'), right: $('scoreRed'), timer: $('timer'), top3: $('top3'),
      feed: $('killfeed'), msg: $('message'), power: $('powerup'),
      awards: $('awards'),
      vignette: $('vignette'), hit: $('hitmarker'),
      respawn: $('respawn'), respawnCount: $('respawncount'),
      board: $('scoreboard'),
    };
    this.msgTimer = 0;
    this.hitTimer = 0;
    this.vigTimer = 0;
    this._top3Rows = [];
    this._top3Key = '';
    this._ranked = [];
    this._rankKey = '';
    this._boardKey = '';
  }

  show(on) { this.els.hud.classList.toggle('on', on); }

  update(dt, state) {
    const { player, mode, scores, characters, timeLeft, showBoard, world } = state;
    const e = this.els;
    setText(e.health, Math.max(0, Math.ceil(player.hp)));
    e.hud.classList.toggle('critical', player.hp > 0 && player.hp <= 25);
    setText(e.shield, player.shield > 0 ? `+${Math.ceil(player.shield)} 🛡` : '');
    setStyle(e.fill, 'width', Math.max(0, player.hp) + '%');
    const w = WEAPONS[player.weapon];
    setText(e.wname, w.name);
    setText(e.ammo, player.weapon === 'blaster' ? '∞' : player.ammo[player.weapon] ?? 0);
    $('ammo').classList.toggle('low-ammo', player.weapon !== 'blaster' && (player.ammo[player.weapon] ?? 0) <= 2);

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
      setClass(this._slotEls[i], 'wslot' +
        (has ? (loaded ? ' owned' : ' empty') : '') +
        (player.weapon === id ? ' active' : ''));
    });

    // score bar + FFA top-3 leaderboard
    if (mode === 'atrium') {          // lobby: no scores, no leaderboard
      setStyle(e.top3, 'display', 'none');
    } else if (mode === 'tdm') {
      setText(e.left, scores.blue);
      setStyle(e.left, 'color', '#5cb3ff');
      setText(e.right, scores.red);
      setStyle(e.right, 'color', '#ff5c5c');
      setStyle(e.top3, 'display', 'none');
    } else {
      const ranked = this.getRanked(characters);
      const rank = ranked.indexOf(player) + 1;
      setText(e.left, `YOU ${player.score}`);
      setStyle(e.left, 'color', '#ffd23c');
      setText(e.right, `#${rank}`);
      setStyle(e.right, 'color', rank === 1 ? '#ffd23c' : '#ccd');
      setStyle(e.top3, 'display', 'block');
      this.updateTop3(ranked);
    }
    const m = Math.floor(Math.max(0, timeLeft) / 60), s = Math.floor(Math.max(0, timeLeft) % 60);
    setText(e.timer, `${m}:${String(s).padStart(2, '0')}`);

    // powerup banner
    if (player.powerup) {
      setStyle(e.power, 'display', 'block');
      setClass(e.power, 'panel ' + player.powerup.kind);
      const label = player.powerup.kind === 'gold' ? 'GOLD NERF — 3× DAMAGE' : 'SILVER NERF — 2× DAMAGE';
      setText(e.power, `${label} · ${Math.ceil(player.powerup.timeLeft)}s`);
    } else {
      setStyle(e.power, 'display', 'none');
    }

    // fading elements
    this.msgTimer -= dt;
    if (this.msgTimer <= 0) setStyle(e.msg, 'opacity', '0');
    this.hitTimer -= dt;
    setStyle(e.hit, 'opacity', this.hitTimer > 0 ? '1' : '0');
    this.vigTimer -= dt;
    setStyle(e.vignette, 'opacity', this.vigTimer > 0 ? '1' : '0');

    // scoreboard
    setStyle(e.board, 'display', showBoard ? 'block' : 'none');
    if (showBoard) this.renderBoard(state);
  }

  getRanked(characters) {
    const key = characters.map((c) => [
      c.name, c.color || '', c.isPlayer ? 1 : 0, c.score,
    ].join('|')).join('\n');
    if (key !== this._rankKey) {
      this._rankKey = key;
      this._ranked = [...characters].sort((a, b) => b.score - a.score);
    }
    return this._ranked;
  }

  updateTop3(ranked) {
    const e = this.els;
    const key = ranked.map((c) => `${c.isPlayer ? 'YOU' : c.name}|${c.color || ''}`).join('\n');
    if (key !== this._top3Key) {
      e.top3.textContent = '';
      this._top3Key = key;
      this._top3Rows = ranked.map((c, i) => {
        const row = document.createElement('div');
        row.className = 't3row';
        const labelWrap = document.createElement('span');
        const rank = document.createElement('span');
        rank.className = 't3rank';
        rank.textContent = `${i + 1}.`;
        const name = document.createElement('span');
        name.style.color = c.color || '#ccd';
        name.textContent = c.isPlayer ? 'YOU' : c.name;
        labelWrap.append(rank, ' ', name);
        const score = document.createElement('span');
        row.append(labelWrap, score);
        e.top3.appendChild(row);
        return { score };
      });
    }
    ranked.forEach((c, i) => {
      if (this._top3Rows[i]) setText(this._top3Rows[i].score, c.score);
    });
  }

  renderBoard({ characters, scores, mode }) {
    const boardKey = [
      mode, scores.blue, scores.red,
      characters.map((c) => [
        c.name, c.color || '', c.isPlayer ? 1 : 0, c.score, c.kills, c.deaths,
        this.awardsSummary(c.awards),
      ].join('|')).join('\n'),
    ].join('\n');
    if (boardKey === this._boardKey) return;
    this._boardKey = boardKey;

    const rows = [...characters].sort((a, b) => b.score - a.score)
      .map(c => `<tr>
        <td style="color:${c.color}">${c.name}${c.isPlayer ? ' ◄' : ''}</td>
        <td>${c.score}</td><td>${c.kills}</td><td>${c.deaths}</td><td>${this.awardsSummary(c.awards)}</td></tr>`).join('');
    const head = mode === 'tdm'
      ? `<h3><span style="color:#5cb3ff">BLUE ${scores.blue}</span> —
          <span style="color:#ff5c5c">${scores.red} RED</span></h3>`
      : `<h3 style="color:#ffd23c">FREE FOR ALL</h3>`;
    const html = `${head}
      <table><tr><th>Player</th><th>Score</th><th>Kills</th><th>Deaths</th><th>Awards</th></tr>${rows}</table>`;
    if (this.els.board.innerHTML !== html) this.els.board.innerHTML = html;
  }

  awardsSummary(awards = {}) {
    const parts = [];
    const labels = {
      multi2: 'Double', multi3: 'Triple', multi4: 'Quad', multi5: 'Penta', multi6: 'Hexa', multi7: 'Septuple',
      oneShot2: '1S2K', oneShot3: '1S3K', oneShot4: '1S4K', oneShot5: '1S5K', oneShot6: '1S6K', oneShot7: '1S7K',
    };
    for (const [key, label] of Object.entries(labels)) {
      if (awards[key]) parts.push(`${label} x${awards[key]}`);
    }
    return parts.length ? parts.join(', ') : '-';
  }

  award(text, sub = '', color = '#ffd23c') {
    const div = document.createElement('div');
    div.className = 'awardtoast';
    div.style.borderColor = color;
    const title = document.createElement('strong');
    title.style.color = color;
    title.textContent = text;
    div.appendChild(title);
    if (sub) {
      const line = document.createElement('span');
      line.textContent = sub;
      div.appendChild(line);
    }
    this.els.awards.prepend(div);
    while (this.els.awards.children.length > 4) this.els.awards.lastChild.remove();
    setTimeout(() => div.classList.add('fade'), 1900);
    setTimeout(() => div.remove(), 2600);
  }

  clearAwards() {
    this.els.awards.textContent = '';
  }

  message(text, color = '#ffd23c') {
    setText(this.els.msg, text);
    setStyle(this.els.msg, 'color', color);
    setStyle(this.els.msg, 'opacity', '1');
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
    setStyle(this.els.respawn, 'display', on ? 'flex' : 'none');
    if (on) setText(this.els.respawnCount, `Respawning in ${Math.ceil(secs)}…`);
  }
}
