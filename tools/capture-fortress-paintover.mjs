// Optional browser capture; see docs/environment-review/paintover/README.md.
import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const output = fileURLToPath(new URL('../docs/environment-review/paintover/', import.meta.url));
const stage = process.argv[2] || 'after';
assert.match(stage, /^[a-z-]+$/);
mkdirSync(output, {recursive:true});
const base = process.env.NERF_TEST_URL || 'http://localhost:3000';
const browser = await chromium.launch({headless:true,channel:'chrome',args:['--enable-webgl','--ignore-gpu-blocklist','--enable-unsafe-swiftshader']});
const save = (name, data) => writeFileSync(`${output}${name}.json`, JSON.stringify(data, null, 2));
try {
  const page = await browser.newPage({viewport:{width:1440,height:900},ignoreHTTPSErrors:true});
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => {if(m.type() === 'error') errors.push(m.text());});
  await page.goto(`${base}/tools/map-studio.html?map=fortress`);
  await page.waitForFunction(() => window.studio?.world, {timeout:120000});
  await page.addStyleTag({content:'aside {display:none}'});
  for(const view of ['Keep','Canal','Overview']) {
    await page.evaluate(view => studio.view(view), view);
    await page.waitForTimeout(600);
    await page.screenshot({path:`${output}${view.toLowerCase()}-${stage}.png`});
  }
  const report = await page.evaluate(() => ({
    stats:studio.stats(), audit:studio.audit(),
    colliders:studio.world.colliders.map(c => ({type:c.type,min:c.min?.toArray(),max:c.max?.toArray()})),
    spawns:studio.world.spawns,
  }));
  if(stage === 'after') {
    const baseline = JSON.parse(readFileSync(`${output}before.json`));
    assert.deepEqual(report.colliders, baseline.colliders);
    assert.deepEqual(report.spawns, baseline.spawns);
    assert.deepEqual(report.audit.navigationComponents, baseline.audit.navigationComponents);
  }
  assert.deepEqual(report.audit.failures, []);
  assert.deepEqual(errors, []);
  report.errors = [...errors];
  save(stage, report);
  await page.goto(`${base}/?quality=high`, {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => window.__game?.()?.player && document.getElementById('maploading').hidden, {timeout:120000});
  await page.evaluate(() => __start('fortress'));
  await page.waitForFunction(() => __game()?.mapDef?.id === 'fortress' && document.getElementById('maploading').hidden, {timeout:120000});
  const game = await page.evaluate(() => {
    const g = __game(); __setGraphics('high'); g.paused = false; __step(5); g.paused = true;
    return {visual:__mapVisualAudit(),perf:__perf(),bots:g.characters.filter(b => !b.isPlayer).map(b => ({alive:b.alive,position:b.pos.toArray()}))};
  });
  await page.waitForTimeout(800);
  await page.screenshot({path:`${output}game-${stage}.png`});
  assert.ok(game.bots.every(b => b.position.every(Number.isFinite)));
  assert.equal(game.visual.unresolved, 0);
  await page.evaluate(() => __setGraphics('low'));
  await page.waitForTimeout(600);
  game.low = await page.evaluate(() => ({perf:__perf(),visual:__mapVisualAudit()}));
  assert.equal(game.low.perf.visualTier, 'low');
  assert.deepEqual(errors, []);
  game.errors = [...errors];
  save(`game-${stage}`, game);
  await page.goto(`${base}/docs/environment-review/paintover/index.html`);
  await page.getByRole('button', {name:'Keep',exact:true}).click();
  await page.locator('#wipe').fill('72');
  assert.match(await page.locator('#after').getAttribute('src'), /^keep-after/);
  assert.match(await page.locator('.after').getAttribute('style'), /28%/);
  await page.waitForFunction(() => [...document.images].every(img => img.complete && img.naturalWidth > 0));
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({stats:report.stats,audit:report.audit,gameErrors:game.errors,comparison:'desktop controls and mobile layout passed'}, null, 2));
} finally {await browser.close();}
