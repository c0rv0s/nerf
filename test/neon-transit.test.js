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
