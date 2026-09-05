import test from "node:test";
import assert from "node:assert/strict";
import {
  orreryPose,
  orreryRideDelta,
  onOrreryDeck,
  ORRERY_PERIOD,
} from "../src/orrery-motion.js";
test("Orrery alternates gallery pairs with six-second boarding windows", () => {
  for (let q = 0; q < 4; q++)
    for (const dt of [0, 3, 6]) {
      const p = orreryPose(q * 18 + dt);
      assert.equal(p.moving, false);
      assert.equal(p.eastWest, q % 2 === 0);
      assert.equal(p.angle, (q * Math.PI) / 2);
      assert.equal(p.angularSpeed, 0);
    }
  assert.equal(orreryPose(12).moving, true);
  assert.ok(Math.abs(orreryPose(12).angle - Math.PI / 4) < 1e-12);
});
test("Orrery position and velocity are continuous at departure, arrival, and wrap", () => {
  for (const boundary of [6, 18, 24, 36, 42, 54, 60, 72]) {
    const a = orreryPose(boundary - 1e-5),
      b = orreryPose(boundary + 1e-5);
    assert.ok(Math.abs(orreryRideDelta(a.angle, b.angle)) < 1e-8);
    assert.ok(Math.abs(a.angularSpeed - b.angularSpeed) < 1e-8);
  }
  for (const t of [0, 6, 12, 31.5, 60, 71.99])
    assert.ok(
      Math.abs(
        orreryRideDelta(
          orreryPose(t).angle,
          orreryPose(t + ORRERY_PERIOD * 100).angle,
        ),
      ) < 1e-9,
    );
});
test("Orrery carries grounded ring and bridge riders, without catching airborne players or static docks", () => {
  assert.equal(onOrreryDeck({ x: 27, y: 10, z: 0 }, 0, true), true);
  assert.equal(onOrreryDeck({ x: 40, y: 9.96, z: 0 }, 0, true), true);
  assert.equal(onOrreryDeck({ x: 0, y: 9.96, z: 40 }, Math.PI / 2, true), true);
  for (const [p, grounded, vy] of [
    [{ x: 27, y: 10, z: 0 }, false, 0],
    [{ x: 27, y: 10, z: 0 }, true, 2],
    [{ x: 44, y: 10, z: 0 }, true, 0],
    [{ x: 18, y: 10, z: 0 }, true, 0],
    [{ x: 27, y: 0, z: 0 }, true, 0],
    [{ x: 35, y: 10, z: 8 }, true, 0],
  ])
    assert.equal(onOrreryDeck(p, 0, grounded, vy), false);
});
test("Orrery rider transport gives the same landing at different frame rates", () => {
  for (const hz of [30, 60, 120]) {
    let x = 27,
      z = 0,
      angle = 0;
    for (let i = 1; i <= 18 * hz; i++) {
      const next = orreryPose(i / hz).angle,
        d = orreryRideDelta(angle, next),
        c = Math.cos(d),
        s = Math.sin(d);
      [x, z] = [x * c - z * s, x * s + z * c];
      angle = next;
    }
    assert.ok(Math.abs(x) < 1e-9);
    assert.ok(Math.abs(z - 27) < 1e-9);
  }
});
