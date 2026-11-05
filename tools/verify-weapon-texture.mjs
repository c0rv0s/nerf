// Run against a local game server with Playwright installed.
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser=await chromium.launch({channel:'chrome',args:['--enable-unsafe-swiftshader']});
let release;
const delayed=new Promise(done=>{release=done;});
try{
  const page=await browser.newPage({ignoreHTTPSErrors:true,serviceWorkers:'block'});
  await page.route('**/textures/blaster.webp',async route=>{await delayed;await route.continue();});
  await page.goto(process.env.NERF_TEST_URL || 'http://localhost:3000',{waitUntil:'domcontentloaded'});
  const early=await page.evaluate(async()=>{
    const {buildBlaster}=await import('/src/weapons.js');
    window.earlyShell=buildBlaster('blaster').children[0].material;
    return !!earlyShell.map;
  });
  assert.equal(early,false,'Test must create a cold, untextured shell');
  release();
  const loaded=await page.evaluate(async()=>{
    const {sharedTexturesReady}=await import('/src/maps.js');
    await sharedTexturesReady;
    return [window.earlyShell.map?.image?.src,!!window.earlyShell.normalMap];
  });
  assert.match(loaded[0] || '',/\/textures\/blaster\.webp$/,'Already-built gun must gain its orange texture');
  assert.equal(loaded[1],true);
  await page.waitForFunction(()=>window.__game?.()?.player && document.getElementById('maploading').hidden,null,{timeout:120000});
  for(const map of ['arena','oldwest']){
    await page.evaluate(id=>__start(id),map);
    await page.waitForFunction(id=>__game()?.mapDef?.id===id && document.getElementById('maploading').hidden,map,{timeout:120000});
    assert.ok(await page.evaluate(()=>{
      const p=__game().player,r=p.vmWeapons.blaster.children[0],l=p.dualBlasterViewmodel.children[0];
      const single=r.material===earlyShell && !p.dualBlaster;
      p.dualBlaster=true;p.showWeaponModel('blaster');
      p.setSkin('gold');const powered=r.material!==earlyShell && r.material===l.material;
      p.setSkin(null);
      return single && powered && p.dualBlasterViewmodel.visible && r.material===earlyShell && l.material===earlyShell;
    }),map+' single, dual, and restored base finish');
  }
  console.log('Delayed texture repaired the original shell; single, dual, and restored skins passed in both arenas.');
}finally{release();await browser.close();}
