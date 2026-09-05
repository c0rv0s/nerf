# Environment pass two

[Compare all twelve views](http://localhost:3000/docs/environment-review/index.html) · [Explore the maps](http://localhost:3000/tools/map-studio.html)

Implemented locally on September 4, 2026. No push or deployment. The comparison starts from the completed first pass, immediately before your feedback. Images use matching cameras and frozen environment time; small randomized decoration can differ between builds. No new generated images were needed for this pass.

## Your feedback

**Canopy:** restored the original thick hedge texture and removed the unused forest-depth texture from runtime loading. Six closed, curved rock vaults replace the exposed rectangular river lids and connector mouths. They follow the channel bends, have arched underwater interiors, and use separate projection directions on their top and vertical rock faces. Their visible meshes supply collision. The east bank has a clear bot connection around the new mounds.

**Olympus:** the moat is approximately **270 metres wide**, increased from 19 metres. Its texture repeats once per 28 metres rather than ten times per metre. The floor sits **1.4 metres below the bank**, with the lava surface 0.55 metres below it. An irregular island rim replaces the old floor slab through the lava, and the distant terrain begins beyond the wider moat. Cornice gaps expose the courtyard-facing Armory and Storm Chapel vine exits. Multiplayer bounds now include the moat, with a regression test.

## Mycelium Grove

Broad living limbs replace the straight box planks while keeping the established endpoints and walking widths. Their shallow crowns and rounded undersides have matching mesh collision. Elder balconies now use one exact collider each instead of dozens of overlapping boxes. Layered, flatter crowns share colors within each grove: warm western foliage, violet eastern foliage and teal around the pond. The continuous rock boundary has an irregular upper silhouette.

Mushroom platforms have modeled caps, curved stems and underside gills. Root braces and fine veins connect the elder shelves to their trunks. Static bracket fungi are batched into 12 material draws. Small decorative shelf waypoints that formed isolated bot destinations were removed; the ground, limb, mushroom and vine network forms one component. Players can still use the physical bracket shelves. Three previously obstructed spawns were corrected in both client and server lists.

## Blast Complex

Rounded padded barriers replace the crate-shaped training blocks. The central tower has shaped corners and framed upper structure. Roof trusses, doorway surrounds, mezzanine supports, bridge bracing and paired coolant pipes give the rooms a common structural design. The main maze, floor levels, lava rooms, subway, water lanes and launch routes remain. One local spawn was moved out of a divider wall. Architecture is batched by material.

## Rendering measurements

These are matched overview views in the map studio, at pixel ratio 1. They exclude combat and bloom. They are camera-specific counts, not FPS predictions.

| Map | Draw calls before → after | Triangles before → after | Colliders before → after |
|---|---:|---:|---:|
| Canopy | 308 → 312 | 442,368 → 447,488 | 166 → 168 |
| Olympus | 398 → 398 | 66,373 → 66,561 | 465 → 466 |
| Mycelium | 848 → 681 | 705,605 → 736,704 | 1,970 → 1,080 |
| Blast | 100 → 113 | 9,286 → 13,108 | 207 → 211 |

Mycelium saves approximately **20% of draws and 45% of colliders**, at a 4% triangle increase. Blast's structural additions cost 13 draws and about 3,800 triangles in this view. Grass, field of view and randomized decorative objects can change counts slightly. Mobile hardware and long multiplayer matches were not profiled.

## Verification

- **47 tests passed**, including the new Olympus multiplayer boundary test.
- All four browser audits pass. They check finite geometry, indexed rays against exhaustive intersection, spawn clearance and connected main navigation, plus the new creek passages, limb crowns, mushroom landings and lava bed.
- Navigation: Canopy 419 nodes, Olympus 167, Mycelium 361, Blast 116; one component each, no blocked FFA spawn probes.
- Real-game checks ran the revised maps with bots and verified finite character positions. A living-limb drop landed grounded at the rendered crown. Landing on a mushroom launcher retained its upward launch.
- In-game lava test: the player fell to y=-1.4 and took damage, then jumped back to the y=0 bank. A direct full-fuel jetpack crossing from the ground-level rim reached x≈287 before dying in lava; the far bank begins at x=430. This is a tested ordinary crossing, not a guarantee against every advanced traversal combination.

[Raw audit and renderer results](metrics.json) · [Audit implementation](../../../tools/map-audit.js)
