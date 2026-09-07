import * as THREE from 'three';
import { WEAPONS } from './weapons.js';

const GOLD = '#ffd23c', CYAN = '#7fd0ff', PAPER = '#fff8e9', RED = '#ff6a55';
function panel(width, height, worldWidth, worldHeight) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(worldWidth, worldHeight),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }));
  mesh.renderOrder = 10000;
  return { canvas, ctx: canvas.getContext('2d'), texture, mesh };
}
function text(ctx, label, x, y, size, color = PAPER, align = 'left', max = 950) {
  ctx.font = `bold ${size}px Arial`; ctx.fillStyle = color; ctx.textAlign = align;
  ctx.fillText(String(label), x, y, max);
}
function card(ctx, x, y, w, h, border = '#4b526d') {
  ctx.fillStyle = 'rgba(18,22,40,.94)';
  ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x+w-18,y); ctx.lineTo(x+w,y+18);
  ctx.lineTo(x+w,y+h); ctx.lineTo(x,y+h); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = border; ctx.lineWidth = 3; ctx.stroke();
}

export class VRUI {
  constructor(camera) {
    this.camera = camera;
    this.resultsAnchor = new THREE.Group();
    this.vitals = panel(1024, 220, 1.25, 0.269);
    this.vitals.mesh.position.set(0, -0.5, -1.65);
    this.awards = panel(1024, 440, 1.25, 0.537);
    this.awards.mesh.position.set(0, 0.43, -1.8);
    this.menu = panel(1024, 1120, 1.38, 1.51);
    this.menu.mesh.position.set(0, 0, -1.8);
    this.menu.mesh.visible = false;
    camera.add(this.vitals.mesh, this.awards.mesh, this.menu.mesh);
    this.raycaster = new THREE.Raycaster();
    this.buttons = [];
    this.selected = 0;
    this.previousAxis = 0;
    this.hovered = -1;
  }

  anchorResults(rig, center, headYaw) {
    this.resultsAnchor.position.copy(center);
    this.resultsAnchor.rotation.set(0,headYaw,0);
    rig.add(this.resultsAnchor);
  }

  update(game, { paused, blocked, needsNeutral, awards = [], now = performance.now() }) {
    const p = game.player;
    const hp = Math.max(0, Math.ceil(p.hp));
    const ammo = p.weapon === 'blaster' ? '∞' : p.ammo[p.weapon] || 0;
    const critical = hp <= 25;
    const lowAmmo = ammo !== '∞' && ammo <= 2;
    const status = game.over ? 'SCORES TO YOUR RIGHT · B: menu' : paused ? 'PAUSED' : blocked ? 'LOADING / MENU OPEN' :
      !p.alive ? 'TAGGED · RESPAWNING' : needsNeutral ? 'Release the sticks and triggers' :
      game.atrium ? 'Walk into a gate · B: pause' : `${Math.floor(Math.max(0,game.timeLeft)/60)}:${String(Math.floor(Math.max(0,game.timeLeft)%60)).padStart(2,'0')}  ·  SCORE ${p.score || 0}  ·  B: pause`;
    const key = [hp,p.shield,p.weapon,ammo,status].join('|');
    this.vitals.mesh.visible = !paused;
    if (key !== this.vitals.key) {
      this.vitals.key = key;
      const c = this.vitals.ctx; c.clearRect(0,0,1024,220);
      if (!game.over) {
      card(c,4,4,370,158,critical ? RED : '#505b78');
      text(c,critical ? 'LOW HEALTH' : 'VITALS',24,36,20,critical ? RED : '#b7c1d9');
      text(c,hp,22,108,72,critical ? RED : PAPER);
      text(c,`+${Math.ceil(p.shield || 0)} SHIELD`,355,98,25,CYAN,'right',205);
      c.fillStyle = '#393648'; c.fillRect(24,127,328,16);
      const gradient = c.createLinearGradient(24,0,352,0);
      gradient.addColorStop(0,'#ff5b3e'); gradient.addColorStop(1,'#ffc845');
      c.fillStyle = critical ? RED : gradient; c.fillRect(24,127,328*Math.min(100,hp)/100,16);
      card(c,390,4,630,158,lowAmmo ? RED : '#505b78');
      text(c,'LOADOUT',410,36,20,'#b7c1d9');
      text(c,WEAPONS[p.weapon]?.name || p.weapon,410,75,29,CYAN,'left',470);
      text(c,ammo,990,135,68,lowAmmo ? RED : PAPER,'right',150);
      text(c,lowAmmo ? 'LOW AMMO' : 'AMMO',410,131,20,lowAmmo ? RED : '#b7c1d9');
      }
      c.fillStyle='rgba(18,22,40,.94)'; c.fillRect(4,170,1016,46);
      text(c,status,512,202,25,GOLD,'center',990);
      this.vitals.texture.needsUpdate = true;
    }
    this.drawAwards(awards, now, !paused && !game.over);
    this.drawMenu(game, paused);
  }

  drawAwards(events, now, visible) {
    const live = events.filter(event => event.expiresAt > now).slice(-3).reverse();
    this.awards.mesh.visible = visible && live.length > 0;
    if (!this.awards.mesh.visible) return;
    const key = live.map(e=>`${e.id}:${Math.floor(Math.max(0,700-(e.expiresAt-now))/50)}`).join('|');
    if (key === this.awards.key) return;
    this.awards.key = key;
    const c = this.awards.ctx; c.clearRect(0,0,1024,440);
    live.forEach((event,i) => {
      c.globalAlpha = Math.min(1,(event.expiresAt-now)/700);
      card(c,40,8+i*140,944,124,event.color);
      text(c,event.text,512,59+i*140,36,event.color,'center',900);
      text(c,event.sub,512,101+i*140,24,PAPER,'center',900);
    });
    c.globalAlpha = 1; this.awards.texture.needsUpdate = true;
  }

  drawMenu(game, paused) {
    this.menu.mesh.visible = paused || game.over;
    if (!this.menu.mesh.visible) { this.menu.key = null; this.buttons = []; return; }
    // The side panel stays in the world: turning your head brings it into view.
    // A head-locked side panel would remain clipped no matter where you looked.
    const sidePanel = game.over && !paused;
    const parent = sidePanel ? this.resultsAnchor : this.camera;
    if (this.menu.mesh.parent !== parent) parent.add(this.menu.mesh);
    this.menu.mesh.position.set(sidePanel ? 1.23 : 0, game.over ? -0.08 : 0, game.over ? -2.2 : -1.8);
    const ranked = game.victoryTransition?.result?.ranked || [...(game.characters || [])].sort((a,b)=>(b.score||0)-(a.score||0));
    const rows = ranked.slice(0,8);
    const actions = game.over ? [['atrium','BACK TO ATRIUM'],['exit','EXIT VR']] :
      [['resume','RESUME'], ...(game.atrium ? [] : [['atrium','BACK TO ATRIUM']]), ['exit','EXIT VR']];
    this.buttons = actions.map(([id,label],i)=>({id,label,x:50,y:790+i*94,w:924,h:76}));
    this.selected = Math.min(this.selected,this.buttons.length-1);
    const result = game.victoryTransition?.result;
    const subtitle = game.over ? `YOUR SCORE ${game.player.score || 0}  ·  ${game.player.kills || 0} TAGS` :
      game.multiplayer || game.multiplayerHost ? 'ONLINE MATCH CONTINUES WHILE PAUSED' : 'B TO RESUME';
    const key = JSON.stringify([game.over,paused,subtitle,result?.title,rows.map(r=>[r.name,r.score,r.kills]),this.selected,this.hovered,actions]);
    if (key === this.menu.key) return;
    this.menu.key = key;
    const c = this.menu.ctx; c.clearRect(0,0,1024,1120); card(c,4,4,1016,1112,GOLD);
    text(c,game.over ? result?.title || 'ROUND COMPLETE' : 'PAUSED',512,78,48,GOLD,'center',930);
    text(c,subtitle,512,128,25,CYAN,'center',940);
    text(c,'PLAYER',64,200,22,'#b7c1d9'); text(c,'SCORE',792,200,22,'#b7c1d9','right');
    text(c,'TAGS',952,200,22,'#b7c1d9','right');
    rows.forEach((row,i)=>{
      const own = row.isPlayer || row.id && row.id === game.player.id || row.name === game.player.name;
      const color = own ? GOLD : PAPER;
      text(c,`${i+1}. ${row.name || 'PLAYER'}`,64,253+i*59,30,color,'left',570);
      text(c,row.score || 0,792,253+i*59,30,color,'right',180);
      text(c,row.kills || 0,952,253+i*59,30,color,'right',135);
    });
    text(c,'Point + trigger, or R stick up/down + A',512,751,25,CYAN,'center',940);
    this.buttons.forEach((button,i)=>{
      const active = i === (this.hovered >= 0 ? this.hovered : this.selected);
      c.fillStyle = active ? GOLD : '#303850'; c.fillRect(button.x,button.y,button.w,button.h);
      if (active) { c.strokeStyle = '#fff9d9'; c.lineWidth=4; c.strokeRect(button.x,button.y,button.w,button.h); }
      text(c,button.label,512,button.y+50,32,active ? '#171b2b' : PAPER,'center',880);
    });
    this.menu.texture.needsUpdate = true;
  }

  interact(controller, { trigger, confirm, axis }) {
    if (!this.menu.mesh.visible) { this.previousAxis = 0; return null; }
    this.hovered = -1;
    if (controller?.visible) {
      this.menu.mesh.updateWorldMatrix(true,false);
      this.raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
      this.raycaster.ray.direction.set(0,0,-1).transformDirection(controller.matrixWorld);
      const hit = this.raycaster.intersectObject(this.menu.mesh)[0];
      if (hit?.uv) {
        const x=hit.uv.x*1024, y=(1-hit.uv.y)*1120;
        this.hovered=this.buttons.findIndex(b=>x>=b.x&&x<=b.x+b.w&&y>=b.y&&y<=b.y+b.h);
      }
    }
    if (Math.abs(axis)>0.65 && Math.abs(this.previousAxis)<0.3) {
      this.selected=(this.selected+Math.sign(axis)+this.buttons.length)%this.buttons.length;
    }
    this.previousAxis=axis;
    if (trigger && this.hovered >= 0) return this.buttons[this.hovered]?.id;
    if (confirm) return this.buttons[this.selected]?.id;
    return null;
  }
}
