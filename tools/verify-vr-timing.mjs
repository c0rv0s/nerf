// Optional browser regression; see docs/vr-validation.md for temporary dependencies.
import {createRequire} from 'node:module';
import {dirname, resolve} from 'node:path';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const require = createRequire(import.meta.url);
const iwerBundle = process.env.IWER_BUNDLE || resolve(dirname(require.resolve('iwer')), '../build/iwer.js');
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const browser=await chromium.launch({headless:true,channel:'chrome',args:['--enable-webgl','--ignore-gpu-blocklist','--enable-unsafe-swiftshader']});
try {
const context=await browser.newContext({viewport:{width:640,height:480},ignoreHTTPSErrors:true});
const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript({content:readFileSync(iwerBundle,'utf8')+`
window.xrDevice=new IWER.XRDevice({...IWER.oculusQuest1,userAgent:navigator.userAgent},{stereoEnabled:true});xrDevice.installRuntime({forceInstall:true});xrDevice.position.set(0,1.6,0);
// Exercise mixed/predicted timestamp resilience, not only the emulator's page clock.
const request=navigator.xr.requestSession.bind(navigator.xr);
navigator.xr.requestSession=async(...args)=>{const s=await request(...args);const raf=s.requestAnimationFrame.bind(s);s.requestAnimationFrame=cb=>raf((t,f)=>{window.xrCallbackCount=(window.xrCallbackCount||0)+1;cb(t+50,f)});return s;};
`});
if(process.env.REPRO_OLD==='1') await page.route('**/src/main.js*',async route=>{
 const response=await route.fetch();let source=await response.text();const original=source;
 source=source.replace(/function startGameLoop\(\) \{[\s\S]*?\n\}/,'function startGameLoop() { renderer.setAnimationLoop(tick); }');
 source=source.replace('function tick(_presentationTime, xrFrame)', 'function tick(now, xrFrame)');
 source=source.replace('if (!G || (renderer.xr.isPresenting && !xrFrame)) return;', 'if (!G) return;');
 source=source.replace('  const now = performance.now();\n  mobileControls.sync();', '  mobileControls.sync();');
 assert.notEqual(source,original);assert.ok(source.includes('function startGameLoop() { renderer.setAnimationLoop(tick); }'));console.log('old loop override applied');
 await route.fulfill({response,body:source});
});
await page.goto(new URL('?quality=high', process.env.NERF_TEST_URL || 'http://localhost:3000').href,{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>window.__game?.()?.player&&document.getElementById('maploading').hidden,{timeout:120000});
await page.evaluate(()=>document.exitPointerLock?.());
await page.waitForFunction(()=>getComputedStyle(document.querySelector('#vr-entry')).display!=='none');
await page.locator('#vr-entry button').click();
await page.waitForFunction(()=>__game().player.vrActive,{timeout:15000});
await page.waitForTimeout(200);
const atriumTiming=await page.evaluate(async()=>{
 const g=__game();let simulated=0;const update=g.world.update?.bind(g.world);
 g.world.update=(dt,...args)=>{simulated+=dt;return update?.(dt,...args);};
 const start=performance.now();await new Promise(r=>setTimeout(r,1000));g.world.update=update;
 return {wall:(performance.now()-start)/1000,simulated};
});
console.log('atrium clock',atriumTiming);assert.ok(atriumTiming.simulated<=atriumTiming.wall*1.06);

await page.evaluate(()=>{window.__start('arena');});
await page.waitForFunction(()=>__game()?.mapDef?.id==='arena'&&document.getElementById('maploading').hidden&&__game().player.vrActive,{timeout:120000});
const quality=await page.evaluate(()=>__perf());console.log('VR quality',{pixelRatio:quality.pixelRatio,shadows:quality.shadows});assert.equal(quality.pixelRatio,1);assert.equal(quality.shadows,false);
const timing=await page.evaluate(async()=>{
 const g=__game();let total=0,count=0;const update=g.world.update?.bind(g.world);
 g.world.update=(dt,...args)=>{total+=dt;count++;return update?.(dt,...args);};
 const framesBefore=window.xrCallbackCount;const start=performance.now();await new Promise(r=>setTimeout(r,2000));
 return {wall:(performance.now()-start)/1000,simulated:total,frames:count,xrFrames:window.xrCallbackCount-framesBefore};
});
console.log('match clock with 50ms predicted-display offset',timing);assert.ok(timing.simulated<=timing.wall*1.03);assert.ok(timing.simulated>=timing.wall*.65);assert.ok(Math.abs(timing.frames-timing.xrFrames)<=1,JSON.stringify(timing));
// Hold forward through a map swap: the new player must stay still until neutral.
await page.evaluate(()=>{xrDevice.controllers.left.updateAxes('thumbstick',0,-1);window.__lobby();});
await page.waitForFunction(()=>__game()?.atrium&&document.getElementById('maploading').hidden&&__game().player.vrActive,{timeout:120000});
await page.waitForTimeout(500);
assert.equal(await page.evaluate(()=>__game().player.moveInput.forward),0);
await page.evaluate(()=>xrDevice.controllers.left.updateAxes('thumbstick',0,0));await page.waitForTimeout(100);
await page.evaluate(()=>xrDevice.controllers.left.updateAxes('thumbstick',0,-1));await page.waitForTimeout(500);
assert.equal(await page.evaluate(()=>__game().player.moveInput.forward),1);
console.log('held-stick map interlock passed');
await page.evaluate(()=>xrDevice.controllers.right.updateButtonValue('b-button',1));
await page.waitForFunction(()=>__vr().paused,{timeout:15000});
await page.evaluate(()=>document.querySelector('#vr-entry button').click());
await page.waitForFunction(()=>!__game().player.vrActive,{timeout:15000});
assert.deepEqual(errors,[]);console.log('desktop restored',await page.evaluate(()=>({pixelRatio:__perf().pixelRatio,shadows:__perf().shadows,paused:__game().paused})));console.log('PASS');
}finally{await browser.close();}
