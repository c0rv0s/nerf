const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const stage = process.argv[2],
  shots = {
    orrery: [
      [5, 0.2, 52, 0, 28, 0],
      [45, 10.4, 4, 0, 17, 0],
    ],
    canopy: [
      [27, 33, 32, 0, 30, 0],
      [29, 0.6, 39, 0, 13, 0],
    ],
    sanctum: [
      [10, 0.15, 13, 0, 4, 0],
      [0, 0.13, 37, 0, 5, 27],
    ],
    prism: [
      [8, 0.15, 16, 0, 22, -15],
      [-14, 0.17, -10, 4, 26, 18],
    ],
    bloom: [
      [21, 0.16, 18, 0, 5, 0],
      [33, 0.16, 0, 95, 3, 0],
    ],
    solar: [
      [-10, 0.3, -9, -2, 3, 8],
      [32, 8, -7, 45, 10, 3],
    ],
    olympus: [
      [16, 61.3, 25, 0, 81, -9],
      [25, 2.5, 18, 0, 20, -33],
    ],
    hall: [
      [0, 0.22, 82, 0, 15, -84],
      [3, 0.22, -73, 0, 10, -108],
    ],
  };
assert.ok(["before", "after"].includes(stage), "Use before or after");
const ids =
  process.argv.length > 3 ? process.argv.slice(3) : Object.keys(shots);
assert.ok(
  ids.every((id) => Object.hasOwn(shots, id)),
  "Unknown map",
);
const b = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    "--enable-webgl",
    "--ignore-gpu-blocklist",
    "--enable-unsafe-swiftshader",
  ],
});
try {
  for (const id of ids) {
    const dir = "docs/environment-review/atlas/" + id + "/";
    mkdirSync(dir, { recursive: true });
    const p = await b.newPage({
      viewport: { width: 1200, height: 720 },
      ignoreHTTPSErrors: true,
    });
    const errors = [];
    p.on("pageerror", (e) => errors.push(String(e)));
    p.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    if (process.env.BASELINE_MAPS)
      for (const [url, file] of [
        ["maps", process.env.BASELINE_MAPS],
        ["orrery-map", process.env.BASELINE_ORRERY],
      ]) {
        if (file)
          await p.route("**/src/" + url + ".js", (route) =>
            route.fulfill({
              path: file,
              contentType: "application/javascript",
            }),
          );
      }
    await p.addInitScript(() => {
      let s = 9204;
      Math.random = () =>
        (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
    });
    await p.goto(
      (process.env.GAME_URL || "http://localhost:3000") + "/?quality=high",
    );
    await p.waitForFunction(
      () =>
        window.__game?.()?.player &&
        document.getElementById("maploading").hidden,
      null,
      { timeout: 120000 },
    );
    await p.evaluate((id) => (id === "hall" ? __hall() : __start(id)), id);
    await p.waitForFunction(
      (id) =>
        (id === "hall" ? __game().hallOfFame : __game()?.mapDef?.id === id) &&
        document.getElementById("maploading").hidden,
      id,
      { timeout: 120000 },
    );
    await p.addStyleTag({ content: "#message{visibility:hidden}" });
    await p.evaluate(() => {
      let g = __game();
      __setGraphics("high");
      g.paused = false;
      g.characters
        .filter((c) => c !== g.player)
        .forEach((c) => (c.update = () => {}));
      __step(3);
      g.paused = true;
    });
    for (const [i, [x, y, z, tx, ty, tz]] of shots[id].entries()) {
      const name = ["hero", "detail"][i];
      await p.evaluate(
        ({ x, y, z, tx, ty, tz }) => {
          let g = __game();
          g.paused = false;
          let c = g.player;
          c.pos.set(x, y, z);
          c.yaw = Math.atan2(x - tx, z - tz);
          if (g.world.escher) {
            c.up.set(0, 1, 0);
            c.frameUp.copy(c.up);
            c.frameFwd.set(tx - x, 0, tz - z).normalize();
            c._moveFwd.copy(c.frameFwd);
          }
          c.pitch = Math.atan2(
            ty - y - c.eyeHeight,
            Math.hypot(tx - x, tz - z),
          );
          __step(0.016);
          g.paused = true;
        },
        { x, y, z, tx, ty, tz },
      );
      await p.waitForTimeout(900);
      await p.screenshot({
        path: dir + name + "-" + stage + ".jpg",
        quality: 90,
      });
    }
    const result = await p.evaluate(async (id) => {
      const { scene, world: w } = __game();
      const a = (await import("/tools/map-audit.js")).auditEnvironment(
        scene,
        w,
        id,
      );
      const extra = [];
      if (id === "orrery") {
        const m = await import("/tools/orrery-audit.js");
        extra.push(
          m.auditOrreryGallerySlab(scene),
          m.auditOrreryStairFaces(scene),
        );
      }
      if (["solar", "bloom"].includes(id))
        extra.push(
          (await import("/tools/space-audit.js")).auditSpace(scene, w, id),
        );
      const v = (p) => p?.toArray?.().map((n) => Math.round(n * 100) / 100);
      const layout = {
        colliders: w.colliders.length,
        ramps: w.ramps.length,
        ffa: w.spawns.ffa.length,
        waypoints: w.waypoints.length,
        pickups: w.pickups.length,
      };
      return {
        report: {
          checks: a.checks + extra.reduce((n, e) => n + e.checks, 0),
          failures: [...a.failures, ...extra.flatMap((e) => e.failures)],
          layout,
        },
        routes: [
          w.ramps,
          w.spawns.ffa.map(v),
          w.waypoints.map((p) => v(p.pos) || [p.x, p.y, p.z]),
          w.pickups.map((p) => [p.kind, p.weapon, v(p.pos)]),
        ],
      };
    }, id);
    const { report, routes } = result;
    report.routes = createHash("sha256")
      .update(JSON.stringify(routes))
      .digest("hex");
    writeFileSync(
      dir + stage + ".json",
      JSON.stringify({ report, errors }, null, 2) + "\n",
    );
    console.log(id, stage, report.checks, report.failures, errors);
    await p.close();
    if (stage === "after") {
      const before = JSON.parse(
        readFileSync(dir + "before.json", "utf8"),
      ).report;
      assert.deepEqual(errors, []);
      assert.deepEqual(report.failures, []);
      assert.deepEqual(report.layout, before.layout);
      assert.equal(report.routes, before.routes);
    }
  }
} finally {
  await b.close();
}
