import test from "node:test";
import assert from "node:assert/strict";
import { createTransitSchedule } from "../src/neon-transit.js";
const points = [
  [0, 10, 0],
  [30, 10, 0],
  [30, 20, 40],
  [-30, 20, 40],
  [-30, 10, 0],
  [0, 10, 0],
];
const rail = createTransitSchedule(points, [0, 1, 4], 20, 5);
test("transit dwells and opens doors at every station, including after wrap", () => {
  rail.stops.forEach((distance, i) => {
    const time = distance / rail.speed + i * rail.dwell + 2;
    for (const cycle of [0, 1, 20]) {
      const pose = rail.sample(time + cycle * rail.cycle);
      assert.equal(pose.station, i);
      assert.equal(pose.doors, 1);
      assert.ok(Math.abs(pose.distance - distance) < 1e-8);
    }
  });
});
test("transit is continuous, closed and frame-rate independent across the whole journey", () => {
  let previous = rail.sample(0).position;
  for (let t = 0.01; t <= rail.cycle * 2; t += 0.01) {
    const s = rail.sample(t);
    assert.ok(s.position.every(Number.isFinite));
    assert.ok(
      Math.hypot(...s.position.map((v, i) => v - previous[i])) <= 0.201,
    );
    if (s.station < 0) assert.equal(s.doors, 0);
    assert.ok(Math.abs(Math.hypot(...s.tangent) - 1) < 1e-9);
    previous = s.position;
  }
  assert.deepEqual(rail.sample(0), rail.sample(rail.cycle));
});

test('Neon Heights stops in order at Central, Vice Galleria roof and Laser Palms roof', async()=>{
  const {NEON_TRANSIT_CONTROLS:controls,NEON_TRANSIT_STATIONS:stations}=await import('../src/neon-transit.js');
  assert.deepEqual(stations.map(s=>s.name),['CENTRAL','VICE GALLERIA','LASER PALMS']);
  assert.deepEqual(stations.filter(s=>s.roofY===0).map(s=>[s.x,s.y,s.z]),[[0,10,0]]);
  assert.deepEqual(stations.slice(1).map(s=>s.roofY),[34,28]);
  const schedule=createTransitSchedule(controls,stations.map(s=>s.controlIndex));
  stations.forEach((station,i)=>{
    const t=schedule.stops[i]/schedule.speed+i*schedule.dwell+2;
    const pose=schedule.sample(t);
    assert.equal(pose.station,i);
    assert.equal(pose.doors,1);
    assert.ok(Math.hypot(...pose.position.map((v,a)=>v-[station.x,station.y,station.z][a]))<1e-8);
    if(i>0){
      assert.ok(Math.abs(station.y-station.roofY-1.2)<1e-8);
      for(const index of [station.controlIndex-1,station.controlIndex+1]){
        assert.equal(controls[index][0],station.x);
        assert.equal(controls[index][1],station.y);
        assert.ok(Math.abs(controls[index][2]-station.z)>=16);
      }
    }
  });
});
