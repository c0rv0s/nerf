import test from "node:test";
import assert from "node:assert/strict";
import {
  bloomScale,
  bloomCrossing,
  bloomRayBoundary,
  BLOOM_RATIO as ratio,
} from "../src/bloom-seams.js";
const p = (x, y = 0, z = 0) => ({ x, y, z });
test("Bloom movement and eye scale agree across all six faces and cube corners", () => {
  for (const axis of ["x", "y", "z"])
    for (const sign of [-1, 1])
      for (const outward of [false, true]) {
        const previous = p(0),
          current = p(0);
        previous[axis] = sign * (outward ? 35.999999 : 7.000001);
        current[axis] = sign * (outward ? 36.000001 : 6.999999);
        const factor = bloomCrossing(previous, current);
        assert.equal(factor, outward ? 1 / ratio : ratio);
        const mapped = {
          x: current.x * factor,
          y: current.y * factor,
          z: current.z * factor,
        };
        assert.ok(
          Math.abs(bloomScale(previous) * factor - bloomScale(mapped)) < 1e-9,
        );
        assert.equal(bloomCrossing(mapped, mapped), 1);
      }
  assert.equal(bloomCrossing(p(7.01, 0, 7.01), p(6.99, 0, 6.99)), ratio);
});
test("recursive rays cannot skip a boundary within the former 3cm dead zone", () => {
  for (const distance of [0.02, 0.0005, 0]) {
    assert.ok(
      Math.abs(bloomRayBoundary(p(36 - distance), p(1)).distance - distance) <
        1e-9,
    );
    assert.ok(
      Math.abs(bloomRayBoundary(p(7 + distance), p(-1)).distance - distance) <
        1e-9,
    );
  }
  assert.equal(bloomRayBoundary(p(36), p(-1)).distance, 29);
  assert.equal(bloomRayBoundary(p(36.1), p(1)).factor, 1 / ratio);
  assert.equal(bloomRayBoundary(p(6.9), p(-1)).factor, ratio);
  assert.equal(bloomRayBoundary(p(35), p(1), 0.5), null);
});
test("ground travel crosses with continuous perceived speed and fixed floor height", () => {
  for (const outward of [false, true]) {
    let pos = p(outward ? 35.5 : 7.5),
      previousScale = bloomScale(pos),
      crossed = false;
    for (let i = 0; i < 100; i++) {
      const next = p(
        pos.x + ((outward ? 1 : -1) * 12.2 * bloomScale(pos)) / 120,
      );
      const factor = bloomCrossing(pos, next);
      if (factor !== 1) {
        const v = 12.2 * bloomScale(pos) * factor;
        next.x *= factor;
        assert.ok(Math.abs(v / bloomScale(next) - 12.2) < 0.02);
        crossed = true;
        break;
      }
      assert.ok(Math.abs(bloomScale(next) - previousScale) < 0.01);
      pos = next;
      previousScale = bloomScale(pos);
    }
    assert.ok(crossed);
  }
});
