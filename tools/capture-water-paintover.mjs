// Optional: PLAYWRIGHT_MODULE can point to an external Playwright installation.
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const stage = process.argv[2] || 'after';
assert.ok(['before', 'after'].includes(stage));
const dir = fileURLToPath(new URL('../docs/environment-review/water-paintover/', import.meta.url));
const base = process.env.NERF_TEST_URL || 'http://localhost:3000';
mkdirSync(dir, {recursive:true});
const browser = await chromium.launch({headless:true,channel:'chrome',args:['--enable-webgl','--ignore-gpu-blocklist','--enable-unsafe-swiftshader']});
const results = {};
// Terrain rotates per load. Check authored routes and volumes separately from the full geometry fingerprint.
const signature = layout => createHash('sha256').update(JSON.stringify({...layout,
  boxes: layout.boxes.map(c => c[0])
})).digest('hex');
try {
  for (const [map, view] of [['mycelium','Pond'],['canopy','River'],['fortress','Canal'],['arena','Coolant'],['olympus','Court'],['reef','Overview'],['atrium','Fountain']]) {
    const page = await browser.newPage({viewport:{width:1280,height:800},ignoreHTTPSErrors:true});
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => {if(m.type()==='error') errors.push(m.text());});
    await page.addInitScript(() => {let s=16381; Math.random=()=>((s=Math.imul(s,1664525)+1013904223>>>0)/4294967296);});
    await page.goto(base+'/tools/map-studio.html?map='+map);
    await page.waitForFunction(id=>window.studio?.stats().map===id, map, {timeout:120000});
    await page.evaluate(view => {studio.view(view);studio.freezeAt(7);document.querySelector('aside').hidden=true;}, view);
    await page.waitForTimeout(650);
    await page.screenshot({path:dir+map+'-'+stage+'.jpg',quality:92});
    const data = await page.evaluate(() => {
      const w=studio.world;
      return {layout:{water:w.waterZones,falls:w.waterfallZones,boxes:w.colliders.map(c=>[c.type,c.min,c.max,c.center,c.radius,c.triangles?.length]),ramps:w.ramps,spawns:w.spawns,waypoints:w.waypoints},stats:studio.stats()};
    });
    const routeHash=signature(data.layout);
    const layoutHash=createHash('sha256').update(JSON.stringify(data.layout)).digest('hex');
    results[map]={layoutHash,routeHash,stats:data.stats,errors};
    assert.deepEqual(errors,[],map);
    if(stage==='after') assert.equal(routeHash,JSON.parse(readFileSync(dir+'before.json'))[map].routeHash,map+' layout');
    console.log(map,JSON.stringify(results[map]));
    if (['mycelium','canopy','fortress','olympus'].includes(map)) {
      results[map].audit=await page.evaluate(()=>studio.audit());
    }
    await page.close();
  }
  writeFileSync(dir+stage+'.json',JSON.stringify(results,null,2)+'\n');
} finally {await browser.close();}
