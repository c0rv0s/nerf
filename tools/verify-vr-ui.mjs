// Optional browser regression; see docs/vr-validation.md.
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const require=createRequire(import.meta.url);
const iwerBundle=process.env.IWER_BUNDLE || resolve(dirname(require.resolve('iwer')),'../build/iwer.js');
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true,channel:'chrome',args:['--enable-webgl','--ignore-gpu-blocklist','--enable-unsafe-swiftshader']});
try {
const context=await browser.newContext({viewport:{width:1000,height:800},ignoreHTTPSErrors:true});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.log('ERROR',e.message)});
await page.addInitScript({content:readFileSync(iwerBundle,'utf8')+`\nwindow.xrDevice=new IWER.XRDevice({...IWER.oculusQuest1,userAgent:navigator.userAgent},{stereoEnabled:true});xrDevice.installRuntime({forceInstall:true});xrDevice.position.set(0,1.6,0);const request=navigator.xr.requestSession.bind(navigator.xr);navigator.xr.requestSession=async(...args)=>window.xrTestSession=await request(...args);`});
await page.goto(new URL('?quality=low',process.env.NERF_TEST_URL || 'http://localhost:3000').href,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__game?.()?.player&&document.getElementById('maploading').hidden,{timeout:120000});
await page.evaluate(()=>document.exitPointerLock?.());
await page.waitForFunction(()=>getComputedStyle(document.querySelector('#vr-entry')).display!=='none');
await page.locator('#vr-entry button').click();
await page.waitForFunction(()=>__game().player.vrActive,{timeout:15000});
await page.waitForTimeout(200);assert.equal(await page.locator('#vr-entry').isVisible(),false);
const button=async(hand,id,value)=>{await page.evaluate(({hand,id,value})=>xrDevice.controllers[hand].updateButtonValue(id,value),{hand,id,value});await page.waitForTimeout(120);};
const press=async(hand,id)=>{await button(hand,id,1);await button(hand,id,0);};
const atlas=async(name)=>{const data=await page.evaluate(name=>__vr().ui[name].canvas.toDataURL(),name);writeFileSync(`/tmp/nerf-vr-${name}.png`,Buffer.from(data.split(',')[1],'base64'));};
const clickMenu=async(id,confirmButton='trigger')=>{
 await page.evaluate(async id=>{
  const T=await import('three');const v=__vr(), ui=v.ui, b=ui.buttons.find(b=>b.id===id);
  ui.menu.mesh.updateWorldMatrix(true,false);
  const target=new T.Vector3(((b.x+b.w/2)/1024-.5)*1.38,(.5-(b.y+b.h/2)/1120)*1.51,0);
  ui.menu.mesh.localToWorld(target);v.rig.worldToLocal(target);
  const controller=xrDevice.controllers.right;
  const origin=new T.Vector3(controller.position.x,controller.position.y,controller.position.z);
  const q=new T.Quaternion().setFromUnitVectors(new T.Vector3(0,0,-1),target.sub(origin).normalize());
  controller.quaternion.set(q.x,q.y,q.z,q.w);
 },id);
 await page.waitForTimeout(200);
 assert.equal(await page.evaluate(()=>{const u=__vr().ui;return u.buttons[u.hovered]?.id}),id);
 await press('right',confirmButton);
};
await press('right','b-button');
assert.equal(await page.evaluate(()=>__vr().active&&__vr().paused&&__game().paused),true);
assert.equal(await page.locator('#vr-entry').isVisible(),false);
await atlas('menu');
await clickMenu('resume');assert.equal(await page.evaluate(()=>__vr().paused),false);
console.log('B pauses without exiting; ray-selected resume works');
// Prism must carry the tracked head and controllers through the same rotating
// surface frame as desktop, without resetting movement to world-horizontal.
await page.evaluate(()=>{window.__start('prism');});
await page.waitForFunction(()=>__game()?.mapDef?.id==='prism'&&document.getElementById('maploading').hidden&&__game().player.vrActive,{timeout:120000});
await press('right','b-button');
const prism = await page.evaluate(async()=>{
 const T=await import('three'); const v=__vr(), p=__game().player;
 const samples=[];
 for(const angle of [0,Math.PI/8,Math.PI/4,Math.PI/2,Math.PI]) {
  const q=new T.Quaternion().setFromAxisAngle(new T.Vector3(0,0,1),angle);
  p.frameUp.set(0,1,0).applyQuaternion(q); p.up.copy(p.frameUp);
  p.frameFwd.set(0,0,-1); await new Promise(resolve=>setTimeout(resolve,100));
  const actualUp=new T.Vector3(0,1,0).applyQuaternion(v.rig.quaternion);
  const center=new T.Vector3(0,1.6,0).applyMatrix4(v.rig.matrixWorld);
  const eye=p.pos.clone().addScaledVector(p.up,p.eyeHeight);
  samples.push({upError:actualUp.distanceTo(p.frameUp),eyeError:center.distanceTo(eye)});
 }
 p.frameUp.set(1,0,0);p.up.copy(p.frameUp);p.frameFwd.set(0,1,0);
 return samples;
});
for(const sample of prism) {assert.ok(sample.upError<1e-6);assert.ok(sample.eyeError<1e-6);}
await page.waitForTimeout(150);
assert.ok(await page.evaluate(()=>__game().player.frameFwd.distanceTo({x:0,y:1,z:0})<1e-6));
console.log('Prism VR follows floor, intermediate roll, wall and ceiling frames; eye anchor and surface heading remain aligned');
await page.evaluate(()=>{window.__start('oldwest');});
await page.waitForFunction(()=>__game()?.mapDef?.id==='oldwest'&&document.getElementById('maploading').hidden&&__game().player.vrActive,{timeout:120000});
await page.evaluate(()=>{const p=__game().player;p.dualBlaster=true;p.syncDualBlasterViewmodel();p.recoil=0;p.leftRecoil=0;p.xrHandCooldown.left=0;p.xrHandCooldown.right=0;});
await page.waitForTimeout(200);
const mountedDual=await page.evaluate(()=>({
 horseVisible:__vr().horse?.visible,
 horseParent:__vr().horse?.parent===__vr().rig,
 leftVisible:__vr().leftGun.visible,
 leftParent:__vr().leftGun.parent?.userData?.source?.handedness,
 rightParent:__vr().gun.parent?.userData?.source?.handedness,
}));
assert.deepEqual(mountedDual,{horseVisible:true,horseParent:true,leftVisible:true,leftParent:'left',rightParent:'right'});
const mountGeometry = await page.evaluate(async () => {
 const T = await import('three');
 const v = __vr(), p = __game().player, h = v.horse;
 h.updateWorldMatrix(true, true);
 const bounds = new T.Box3().setFromObject(h);
 const eye = new T.Vector3().setFromMatrixPosition(v.camera.matrixWorld);
 const down = new T.Raycaster(eye, new T.Vector3(0, -1, 0));
 const forward = new T.Vector3(0, 0, 1).transformDirection(h.matrixWorld);
 return {
  legs: h.children.filter(c => Number.isFinite(c.userData.gaitPhase)).length,
  size: bounds.getSize(new T.Vector3()).toArray(),
  saddleBelow: down.intersectObject(h, true).length > 0,
  anchored: Math.hypot(h.getWorldPosition(new T.Vector3()).x-p.pos.x, h.getWorldPosition(new T.Vector3()).z-p.pos.z) < 1e-6,
  forward: forward.dot(new T.Vector3(-Math.sin(p.horseHeading),0,-Math.cos(p.horseHeading))) > .999,
  depth: h.children.every(c => !c.isMesh || (c.material.depthTest && c.material.depthWrite)),
 };
});
assert.equal(mountGeometry.legs, 4);
assert.ok(mountGeometry.size[1] > 2 && mountGeometry.size[2] > 2);
assert.ok(mountGeometry.saddleBelow && mountGeometry.anchored && mountGeometry.forward && mountGeometry.depth);
await page.screenshot({path:'/tmp/nerf-vr-red-rock-dual-stereo.png'});
const originalHead = await page.evaluate(async () => {
 const T = await import('three');
 const {x,y,z,w} = xrDevice.quaternion;
 const original = [x,y,z,w];
 const q = new T.Quaternion().setFromEuler(new T.Euler(-0.85, __game().player.horseHeading - __vr().rig.rotation.y, 0, 'YXZ'));
 xrDevice.quaternion.set(q.x,q.y,q.z,q.w);
 return original;
});
await page.waitForTimeout(250);
await page.screenshot({path:'/tmp/nerf-vr-horse-look-down.png'});
await page.evaluate(q => xrDevice.quaternion.set(...q), originalHead);
await page.waitForTimeout(150);

await button('left','trigger',1);
assert.equal(await page.evaluate(()=>__game().player.leftRecoil>0&&__game().player.recoil===0),true);
await button('left','trigger',0);
await page.evaluate(()=>{const p=__game().player;p.recoil=0;p.leftRecoil=0;p.xrHandCooldown.left=0;p.xrHandCooldown.right=0;});
await button('right','trigger',1);
assert.equal(await page.evaluate(()=>__game().player.recoil>0&&__game().player.leftRecoil===0),true);
await button('right','trigger',0);
console.log('Red Rock horse, two controller pistols and independent trigger hands passed');
await page.evaluate(()=>{window.__start('canopy');});
await page.waitForFunction(()=>__game()?.mapDef?.id==='canopy'&&document.getElementById('maploading').hidden&&__game().player.vrActive,{timeout:120000});
await page.evaluate(()=>{const p=__game().player;p.grapple=true;p.hp=20;p.shield=35;p.weapons.scatter=true;p.ammo.scatter=2;p.switchWeapon('scatter');xrDevice.controllers.right.quaternion.set(0,0,0,1);xrDevice.controllers.left.quaternion.set(Math.sin(.3),0,0,Math.cos(.3));});
await page.waitForTimeout(200);
await atlas('vitals');
await press('right','b-button');const pausedTime=await page.evaluate(()=>__game().timeLeft);await page.waitForTimeout(250);assert.equal(await page.evaluate(()=>__game().timeLeft),pausedTime);await page.evaluate(()=>{__vr().ui.selected=1;});await clickMenu('resume','a-button');await page.waitForTimeout(150);
const aim=await page.evaluate(()=>({gun:__game().player.xrAim.dir.toArray(),grapple:__game().player.xrGrappleAim.dir.toArray(),leftVisible:__vr().grappleGun.visible,leftParent:__vr().grappleGun.parent.userData.source.handedness}));
assert.equal(aim.leftParent,'left');assert.equal(aim.leftVisible,true);assert.notDeepEqual(aim.gun,aim.grapple);
// Put a known grapple target on the left-hand ray, independently of the gun ray.
await page.evaluate(()=>{const p=__game().player,a=p.xrGrappleAim;__game().world.grappleFoliageTargets.push({center:a.origin.clone().addScaledVector(a.dir,12),radius:2});});
await button('left','trigger',1);assert.equal(await page.evaluate(()=>__game().player.grappleAttached),true);
await button('right','trigger',1);
assert.equal(await page.evaluate(()=>__game().player.grappleAttached&&__game().player.firing),true);
await button('left','trigger',0);await button('right','trigger',0);
await press('left','trigger');assert.equal(await page.evaluate(()=>__game().player.grappleAttached),false);
await page.evaluate(()=>__vr().award('LONG SHOT','125 metres · +250','#ffd23c'));await page.waitForTimeout(100);
assert.equal(await page.evaluate(()=>__vr().ui.awards.mesh.visible),true);await atlas('awards');
await page.screenshot({path:'/tmp/nerf-vr-hands-stereo.png'});
await page.waitForTimeout(2600);assert.equal(await page.evaluate(()=>__vr().ui.awards.mesh.visible),false);
console.log('independent left grapple, simultaneous shooting, colored vitals, awards passed');
await page.evaluate(()=>{const p=__game().player;p.hp=100;p.score=2400;p.kills=8;__game().timeLeft=0;});
await page.waitForFunction(()=>__game()?.scene?.userData?.end&&__vr().podium,{timeout:15000});
await page.waitForTimeout(500);
const podium=await page.evaluate(async()=>{const T=await import('three'),v=__vr();return {distance:v.camera.getWorldPosition(new T.Vector3()).distanceTo(v.podium.lookAt),visible:v.ui.menu.mesh.visible,result:v.ui.menu.key};});
assert.ok(podium.distance<20);assert.equal(podium.visible,true);assert.match(podium.result,/2400/);
assert.deepEqual(await page.evaluate(()=>__vr().ui.buttons.map(b=>b.id)),['atrium']);
await press('right','b-button');assert.equal(await page.evaluate(()=>__vr().active&&__game().over),true);await press('right','b-button');
await atlas('menu');await page.screenshot({path:'/tmp/nerf-vr-podium-stereo.png'});
await page.evaluate(()=>xrDevice.quaternion.set(0,Math.sin(-.255),0,Math.cos(-.255)));
await page.waitForTimeout(200);
await page.screenshot({path:'/tmp/nerf-vr-results-stereo.png'});
await clickMenu('atrium');
await page.waitForFunction(()=>__game()?.atrium&&document.getElementById('maploading').hidden&&__game().player.vrActive,{timeout:120000});
await page.evaluate(()=>xrDevice.quaternion.set(0,0,0,1));await page.waitForTimeout(200);
assert.equal(await page.evaluate(()=>__vr().active),true);console.log('podium visible; scores and ray-selected Atrium work without leaving VR');
await press('right','b-button');assert.equal(await page.evaluate(()=>__vr().active),true);
assert.equal(await page.evaluate(()=>__vr().ui.buttons.some(b=>b.id==='exit')),false);
await page.evaluate(()=>window.xrTestSession.end());
await page.waitForFunction(()=>!__vr().active,{timeout:15000});
assert.deepEqual(errors,[]);console.log('PASS');
}finally{await browser.close();}
