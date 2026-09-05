// Read-only audit: compiles the current production movement functions against
// a controlled clock. Rendering/audio hooks are stubbed; vector math and weapon
// cooldown methods come from the game's actual Three.js and Bot modules.
import * as THREE from 'three';
import { Bot } from '../../src/bots.js';
import { WEAPONS } from '../../src/weapons.js';
import { boundedSnapshotLead, advanceNetworkTimer } from '../../src/network-sync.js';
import { bloomCrossing } from '../../src/bloom-seams.js';
export async function runAudit(bloomWorld = null) {
  const source=await (await fetch('/src/main.js',{cache:'no-store'})).text();
  const names=['makeRemoteNet','smoothNetworkAngle','updateRemoteHumanMotion','updateRemoteHuman','updateRemoteSlots','applyMultiplayerLoadout'];
  const code=names.map(name=>{const start=source.indexOf(`function ${name}(`);if(start<0)throw Error(name);return source.slice(start,source.indexOf('\n}',start)+2);}).join('\n');
  const constants=[...source.matchAll(/^const (REMOTE_(?:HUMAN|SLOT)_\w+) = ([^;]+);/gm)].map(m=>`const ${m[1]}=${m[2]};`).join('\n');
  let now=1000;
  const G={world:{},remoteSlots:new Map(),remoteInputs:new Map(),player:null};
  const multiplayer={estimateServerSampleAge:sampledAt=>Math.max(0,Math.min(.18,(now-sampledAt)/1000))};
  const noop=()=>{};
  const api=new Function('THREE','performance','multiplayer','G','WEAPONS','Bot','boundedSnapshotLead',`
    const setRemoteGrappleState=()=>{},syncRemoteGrappleVisual=()=>{},syncJetpackVisual=()=>{},updateWeaponWarmupVisual=()=>{},sfx=()=>{};
    const hud={message:()=>{}};const HORSE_HEIGHT_DELTA=0;
    ${constants}\n${code}\nreturn {${names.join(',')}};
  `)(THREE,{now:()=>now},multiplayer,G,WEAPONS,Bot,boundedSnapshotLead);
  const V=(x=0,y=0,z=0)=>new THREE.Vector3(x,y,z);
  const actor=()=>({id:'guest',pos:V(),vel:V(),up:V(0,1,0),alive:true,yaw:0,pitch:0,weapons:{blaster:true},ammo:{blaster:Infinity},weapon:'blaster',cooldown:0,mesh:null,cancelWeaponWarmup:noop,weaponTriggerReady:Bot.prototype.weaponTriggerReady,finishWeaponShot:Bot.prototype.finishWeaponShot});
  const remote=()=>({pos:V(),snapshotPos:V(),snapshotVel:V(),snapshotReceivedAt:0,snapshotAge:0,targetPos:V(),alive:true,yaw:0,targetYaw:0,mesh:{position:V(),rotation:{}},horseVisual:null});
  // A runner stops at x=6. Latest moving sample is x=5.9. Ordered packets
  // stall for 250ms around the stop, as a TCP delivery gap can do.
  const runner=remote();G.remoteSlots.set('runner',runner);
  const packets=[];for(let i=0;i<60;i++){const t=i*.05;packets.push({t,arrival:t+.08+(t>=.95&&t<=1.15?.25:0),x:Math.min(6,t*6),vx:t<1?6:0});}
  for(let i=1;i<packets.length;i++)packets[i].arrival=Math.max(packets[i].arrival,packets[i-1].arrival);
  let pi=0,maxX=0,maxReverse=0,previous=0;const trace=[];
  for(let f=0;f<360;f++){const t=f/120;now=1000+t*1000;while(pi<packets.length&&packets[pi].arrival<=t){const p=packets[pi++];runner.snapshotPos.set(p.x,0,0);runner.snapshotVel.set(p.vx,0,0);runner.snapshotReceivedAt=now;runner.snapshotAge=Math.min(.18,t-p.t);}
    api.updateRemoteSlots(1/120);maxX=Math.max(maxX,runner.pos.x);if(t>1)maxReverse=Math.max(maxReverse,previous-runner.pos.x);previous=runner.pos.x;if(f%4===0)trace.push({t,x:runner.pos.x});}
  const stop={wallAtX:6,maxRenderedX:maxX,overshoot:maxX-6,maxBackwardFrame:maxReverse,trace};
  // A single final firing packet remains in the host input map for 2 seconds.
  const stale=actor();const input={seq:1,receivedAt:1000,sampledAt:1000,pos:{x:0,y:0,z:0},vel:{x:0,y:0,z:0},firing:true,weapon:'blaster',alive:true,aim:{x:0,y:0,z:-1}};
  G.remoteInputs.set('guest',input);let shots=0,lateShots=0;
  for(let i=0;i<240;i++){now=1000+i*1000/120;api.updateRemoteHuman(stale,1/120,()=>{shots++;if(i>=120)lateShots++;});}
  // A 25ms click between two 30Hz sends is visible to local 120Hz input,
  // but absent from every transmitted held-button sample.
  let timer=0,sentTrue=0;for(let f=0;f<12;f++){const fire=f>=1&&f<=3;const c=advanceNetworkTimer(timer,1/120,30);timer=c.timer;if(c.due&&fire)sentTrue++;}
  // Same authoritative ammo packet after a local predicted shot restores it.
  G.player={weapons:{blaster:true,scatter:true},ammo:{blaster:Infinity,scatter:4},weapon:'scatter'};
  api.applyMultiplayerLoadout({weapons:['blaster','scatter'],ammo:{scatter:5},weapon:'scatter'});
  const ammo={afterLocalShot:4,afterOlderAuthorityPacket:G.player.ammo.scatter};
  // Horizontal wall-walk up vector goes through the actual host input path.
  const wall=actor();G.remoteInputs.set('guest',{...input,firing:false,up:{x:1,y:0,z:0}});now=1100;api.updateRemoteHuman(wall,1/120,noop);
  const wallUp={sent:[1,0,0],host:wall.up.toArray()};
  // Just before Bloom's outer seam, host extrapolation crosses the seam.
  // The post-move similarity rebase is the same map operation as production.
  const bloom=actor();bloom.pos.x=35.95;let wraps=0;const bloomTrace=[];
  const edge={...input,pos:{x:35.95,y:0,z:0},vel:{x:2,y:0,z:0},firing:false};
  for(let i=0;i<18;i++){now=1080+i*1000/120;const prev=bloom.pos.clone();api.updateRemoteHumanMotion(bloom,edge,1/120);const factor=bloomCrossing(prev,bloom.pos);if(factor!==1)wraps++;if(bloomWorld){bloomWorld._t=now/1000;bloomWorld.postCharacterMove(bloom,prev);}else if(factor!==1){bloom.pos.multiplyScalar(factor);bloom.vel.multiplyScalar(factor);}bloomTrace.push(bloom.pos.x);}
  return {stop,staleFire:{secondsWithoutNewInput:2,shots,shotsDuringSecondSecond:lateShots},shortClick:{localHeldFrames:3,clickDurationMs:25,sentFiringPackets:sentTrue},ammo,wallUp,bloom:{actualMapHook:!!bloomWorld,wraps,positions:bloomTrace},productionConstants:constants};
}
