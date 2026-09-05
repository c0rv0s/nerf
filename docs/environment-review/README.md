Latest: [Neon Heights and Fortress Falls, September 4](round-three/README.md).

> Updated after feedback: [environment pass two](round-two/README.md). This document records the first pass.

# Nerf environment review

Implemented locally on September 4, 2026. No deployment or push.

[Open the interactive comparison](http://localhost:3000/docs/environment-review/index.html) · [Explore the actual maps](http://localhost:3000/tools/map-studio.html)

Run `npm start` from the repository if the local server is not already running. The map studio lets you orbit, pan, switch cameras and animate the actual map geometry. It excludes combat and postprocessing; the comparison images are captured from that studio, not generated concept images.

## Canopy

Rounded, fluted living trunks replace rectangular supports. The village now has continuous planked suspension spans, rope rails, supporting joists and radial braces. Meandering banks include shallow shelves, reeds and stones, with clear swimming channels and preserved tunnel mouths. A hollow fallen log and rounded thickets replace box assemblies. Distant tree silhouettes and a generated forest-depth texture enclose the arena.

The elevated circuit, treehouse access, grapple routes and swim connections remain. New bridge and bank collision comes from the visible geometry. Bot routes follow the sagging decks and changing channel position.

## Olympus Mons

Sculpted mountain faces and walkable foothills ground the palace in a continuous Martian landscape. Court-facing colonnades and roof coffers give the existing wings a shared architectural structure. A new opening in the upper Aether court and skylight expose the vertical court; the throne dais remains accessible around the opening. The underworld lift platforms gain chains and supporting beams.

The basin flank now follows a clear outer route, with curb crossings and gully connections to the cliff vines. Shrine approaches, the underworld and floating-rock recovery route remain. Two upper-roof spawns were moved two metres outward to clear existing statue plinths.

## Sunken Reef and rendering

The existing 220 swaying plant objects are baked into 58 spatial/material batches. Their individual sway runs in the vertex shader, including matching shadow shaders. Existing terrain, animals, water and collision remain. Indexed triangle-ray queries reduce unnecessary collision work on the more detailed surfaces; the audit compares their results against the previous exhaustive scan.

| Overview render | Before → after draw calls | Before → after triangles | Before → after colliders |
|---|---:|---:|---:|
| Canopy | 285 → 310 | 362,502 → 448,494 | 232 → 166 |
| Olympus | 392 → 398 | 45,617 → 66,373 | 457 → 465 |
| Reef | 378 → 216 | 81,906 → 81,906 | 231 → 231 |

Reef uses **43% fewer draw calls** in the recorded overview. Canopy costs about 9% more draws and 24% more triangles; Olympus costs about 2% more draws and 46% more triangles, from a much smaller starting mesh. These are camera-specific renderer counts, not FPS guarantees. Shadows, camera position, graphics settings and device change real match costs. Some original decorative grass is randomized, so Canopy counts vary slightly between loads. Mobile hardware was not profiled.

## Verification

- All **46 automated tests passed**, including six new ray-grid boundary/range tests and the multiplayer integration suite.
- Browser audits: Canopy 2,045 checks, Olympus 2,949, Reef 2,341; no audit failures. They include finite geometry, collision rays, new walking/swimming surfaces, bridge clearance and the basin flank.
- Canopy and Olympus navigation each form one connected component; their FFA spawns pass the clearance probe.
- 4,320 sampled ray queries agree with exhaustive triangle scans. Candidate triangle work falls 79–88% in these audit samples.
- All three maps ran five simulated seconds with bots in the full game, with finite character positions, shadows and bloom. The Aether opening also passed a one-second player fall check. Reef shader diagnostics reported no compilation failures.

The generic ground-navigation probe reports fragmented components and one obstructed spawn probe in Reef's original map as well as the current version. Reef uses separate underwater movement/recovery behavior; this pass does not certify or redesign that navigation. Full network play across devices and long matches remain outside these local checks.

[Raw measurements](metrics.json) · [Browser audit source](../../tools/map-audit.js) · [Image asset and prompt](texture-prompt.md)
