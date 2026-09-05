import test from "node:test";
import assert from "node:assert/strict";
import {
  rayBoundsInterval,
  rayTriangleCandidates,
} from "../src/triangle-ray-grid.js";
const v = (x, y, z) => ({ x, y, z });
const box = { min: v(-8, -8, -8), max: v(8, 8, 8) };
function grid() {
  const triangleCells = new Map();
  const triangles = [];
  for (let x = -2; x <= 2; x++)
    for (let z = -2; z <= 2; z++) {
      const entry = { id: `${x},${z}` };
      triangles.push(entry);
      triangleCells.set(entry.id, [entry]);
    }
  return { ...box, triangleCellSize: 4, triangleCells, triangles };
}

test("ray bounds clip range, support inside starts, and reject parallel misses", () => {
  assert.deepEqual(rayBoundsInterval(v(-12, 0, 0), v(1, 0, 0), box), {
    near: 4,
    far: 20,
  });
  assert.deepEqual(rayBoundsInterval(v(0, 0, 0), v(0, -1, 0), box, 5), {
    near: 0,
    far: 5,
  });
  assert.equal(rayBoundsInterval(v(9, 0, 0), v(0, 1, 0), box), null);
  assert.equal(rayBoundsInterval(v(-12, 0, 0), v(1, 0, 0), box, 3.9), null);
  assert.equal(rayBoundsInterval(v(12, 0, 0), v(1, 0, 0), box), null);
});

test("vertical rays visit only their XZ column", () => {
  const hits = rayTriangleCandidates(grid(), v(1, 12, 1), v(0, -1, 0));
  assert.deepEqual(
    hits.map((e) => e.id),
    ["0,0"],
  );
});

test("ray cell traversal handles negative directions and finite ranges", () => {
  const hits = rayTriangleCandidates(grid(), v(7, 0, 1), v(-1, 0, 0), 8);
  assert.deepEqual(
    hits.map((e) => e.id),
    ["1,0", "0,0", "-1,0"],
  );
});

test("mixed-sign diagonal rays include side cells at exact corner tangencies", () => {
  const hits = rayTriangleCandidates(grid(), v(-2, 0, 2), v(1, 0, -1), 4);
  const ids = hits.map((e) => e.id);
  assert.ok(ids.includes("0,0"));
  assert.ok(ids.includes("-1,-1"));
  assert.ok(ids.includes("0,-1"));
});

test("shared triangles are returned once and reusable query storage is cleared", () => {
  const collider = grid();
  const shared = { id: "wide triangle" };
  for (const entries of collider.triangleCells.values()) entries.push(shared);
  assert.equal(
    rayTriangleCandidates(collider, v(-12, 0, 1), v(1, 0, 0)).filter(
      (e) => e === shared,
    ).length,
    1,
  );
  assert.deepEqual(
    rayTriangleCandidates(collider, v(1, 12, 1), v(0, -1, 0)).map((e) => e.id),
    ["0,0", "wide triangle"],
  );
  assert.deepEqual(
    rayTriangleCandidates(collider, v(12, 12, 12), v(0, 1, 0)),
    [],
  );
});

test("unindexed triangle meshes retain the full-scan fallback", () => {
  const triangles = [{ id: 1 }];
  assert.equal(
    rayTriangleCandidates({ ...box, triangles }, v(0, 0, 0), v(1, 0, 0)),
    triangles,
  );
});
