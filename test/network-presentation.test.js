import test from "node:test";
import assert from "node:assert/strict";
import {
  RemoteTimeline,
  freshInput,
  pendingAmmo,
  mergeShotRequests,
} from "../src/network-sync.js";
const sample = (time, x, extra = {}) => ({
  time,
  received: time + 0.08,
  pos: { x, y: 0, z: 0 },
  yaw: 0,
  up: { x: 0, y: 1, z: 0 },
  alive: true,
  epoch: "0:0",
  ...extra,
});
test("ordered jitter around a stop neither overshoots nor corrects backwards", () => {
  const timeline = new RemoteTimeline();
  const packets = Array.from({ length: 60 }, (_, i) => {
    const t = i * 0.05;
    return sample(t, Math.min(6, t * 6), {
      received: t + 0.08 + (t >= 0.95 && t <= 1.15 ? 0.25 : 0),
    });
  });
  for (let i = 1; i < packets.length; i++)
    packets[i].received = Math.max(
      packets[i].received,
      packets[i - 1].received,
    );
  let index = 0,
    previous = 0,
    maxStep = 0;
  for (let f = 0; f < 480; f++) {
    const now = f / 120;
    while (index < packets.length && packets[index].received <= now)
      timeline.push(packets[index++]);
    const p = timeline.sample(now);
    if (!p) continue;
    assert.ok(p.pos.x <= 6 + 1e-8);
    assert.ok(p.pos.x >= previous - 1e-8);
    maxStep = Math.max(maxStep, p.pos.x - previous);
    previous = p.pos.x;
  }
  assert.ok(maxStep <= (6 * 1.15) / 120 + 1e-8);
  assert.equal(previous, 6);
});
test("seam generations and respawns reset history without interpolating through the arena", () => {
  const t = new RemoteTimeline();
  t.push(sample(0, 35.95));
  t.sample(0.08);
  t.push(sample(0.05, 7.01, { epoch: "0:1" }));
  assert.equal(t.sample(0.13).pos.x, 7.01);
  t.push(sample(0.1, 11, { alive: false }));
  assert.equal(t.sample(0.18).pos.x, 11);
  t.push(sample(0.15, 18, { alive: true, epoch: "1:1" }));
  assert.equal(t.sample(0.23).pos.x, 18);
});
test("surface up preserves zero components and angle interpolation takes the shortest turn", () => {
  const t = new RemoteTimeline();
  t.push(sample(0, 0, { yaw: Math.PI - 0.1, up: { x: 1, y: 0, z: 0 } }));
  t.push(sample(0.1, 1, { yaw: -Math.PI + 0.1, up: { x: 1, y: 0, z: 0 } }));
  const p = t.sample(0.15);
  assert.ok(Math.abs(p.yaw - Math.PI) < 1e-8);
  assert.equal(p.up.y, 0);
});
test("continuous intent expires, but fresh input resumes immediately", () => {
  assert.equal(freshInput({ receivedAt: 1000 }, 1249), true);
  assert.equal(freshInput({ receivedAt: 1000 }, 1251), false);
  assert.equal(freshInput({ receivedAt: 2000 }, 2001), true);
});
test("shot resend is deduplicated and acknowledgement preserves only unprocessed requests", () => {
  const a = { seq: 1, weapon: "scatter" },
    b = { seq: 2, weapon: "scatter" };
  assert.deepEqual(mergeShotRequests([a], [a, b], 0), [a, b]);
  assert.deepEqual(mergeShotRequests([a, b], [a, b], 1), [b]);
  assert.deepEqual(mergeShotRequests([a, b], [a, b], 2), []);
});
test("older ammo retains local consumption until acknowledgement, then converges", () => {
  const shots = [
    { seq: 1, weapon: "scatter" },
    { seq: 2, weapon: "scatter" },
  ];
  assert.equal(pendingAmmo({ scatter: 5 }, shots, 0).scatter, 3);
  assert.equal(pendingAmmo({ scatter: 4 }, shots, 1).scatter, 3);
  assert.equal(pendingAmmo({ scatter: 3 }, shots, 2).scatter, 3);
  assert.equal(pendingAmmo({ scatter: 7 }, shots, 1).scatter, 6); // authoritative pickup
});


test('an immediate floor-to-ceiling transfer cannot interpolate a zero up vector',()=>{
  const t=new RemoteTimeline();t.push(sample(0,0));
  t.push(sample(.1,1,{up:{x:0,y:-1,z:0}}));
  assert.deepEqual(t.sample(.15).up,{x:0,y:-1,z:0});
});
