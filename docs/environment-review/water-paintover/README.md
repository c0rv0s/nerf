# Mycelium Grove and shared water

[Compare the renders](index.html) · [Approved night concept](moonlit-target.png) · [Prompts](prompts.md)

Grove stays moonlit. Painted bark, amber gills, trailing leaves, wildflowers, slate and moss banks, and soft fireflies distinguish the paths from the night sky. The grove uses less environment fill in matches to keep bloom from washing out the pond.

Animated caustics now use world distances and a shared clock across adjoining lit water surfaces. Waterfalls share strand shading and impact foam. The explicitly unlit Olympus pool and Tidebreaker’s custom storm ocean keep their own render paths.

## Verification

- Three.js r160 → r187 in the game, studios and service worker; pg 8.22 → 8.23.1.
- 77 tests passed. All 15 arenas and the Hall of Fame loaded in Chrome; bot positions stayed finite. The grove rendered on high and low graphics.
- The emulated VR timing check passed, including controller interlocks and restoring desktop rendering. Physical headset and mobile hardware were not tested.
- A fresh service worker cached 15 CDN modules and imported r187 offline.
- Seven fixed-camera captures retain identical water and waterfall volumes, spawns, ramps, waypoints, and collider types/counts. The existing geometry audits passed in Mycelium, Canopy, Fortress, and Olympus.
- Full geometry hashes can differ: some terrain rotates procedurally, trunks follow the terrain, and triangulation can change between Three.js versions. Renderer counters across these releases are not a frame-rate benchmark.

[Before](before.json) · [After and audits](after.json) · [Game checks](game.json)

With the server running, use `node tools/capture-water-paintover.mjs after` to repeat the seven views. Set `PLAYWRIGHT_MODULE` if Playwright is installed outside this project.
