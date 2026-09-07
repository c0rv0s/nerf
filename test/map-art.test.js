import test from 'node:test';
import assert from 'node:assert/strict';
import library from '../assets/models/map-art.js';

// Corrupt exports otherwise fail only when a specific map is opened in WebGL.
test('Blender exports have finite attributes, valid indices, and bounded mesh budgets', () => {
  assert.equal(Object.keys(library).length,29);
  for (const [name,g] of Object.entries(library)) {
    assert.equal(g.p.length%3,0,name);
    assert.equal(g.n.length,g.p.length,name);
    assert.equal(g.c.length,g.p.length,name);
    assert.equal(g.i.length%3,0,name);
    assert.ok(g.i.length/3<=2600,`${name} exceeds the per-asset triangle budget`);
    for(const key of ['p','n','c']) assert.ok(g[key].every(Number.isFinite),`${name}.${key}`);
    assert.ok(g.i.every(i=>Number.isInteger(i)&&i>=0&&i<g.p.length/3),name);
    assert.ok(g.c.every(v=>v>=0&&v<=1),name);
    for(let i=0;i<g.n.length;i+=3) assert.ok(Math.abs(Math.hypot(...g.n.slice(i,i+3))-1)<.001,`${name} normal ${i/3}`);
  }
});
test('statue bodies rest on their existing pedestals and fish face the travel axis',()=>{
  for(const [name,g] of Object.entries(library)) {
    if(name.startsWith('statue_')) {
      // Central lower body must touch the pedestal; projecting staffs may descend beside it.
      const bodyY=[];
      for(let i=0;i<g.p.length;i+=3) if(Math.abs(g.p[i])<1.05&&Math.abs(g.p[i+2])<1.05)bodyY.push(g.p[i+1]);
      assert.ok(Math.min(...bodyY)>=-.05&&Math.min(...bodyY)<.08,name);
    }
    if(name.startsWith('fish_')) {
      const xs=g.p.filter((_,i)=>i%3===0);
      assert.ok(Math.min(...xs)<-1.1&&Math.max(...xs)>.8,name);
    }
  }
});
