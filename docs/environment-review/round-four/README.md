# Asteroid Belt, Infinite Bloom, and Solar Flare

This fourth pass is local and has not been deployed. The comparison images use the same 1440 × 900 camera views, time, textures, and renderer settings before and after. They show the actual map geometry without combat or game postprocessing.

## Asteroid Belt

The flat landing crowns now belong to closed, fractured rock bodies with collision generated from those exact meshes. The existing landing positions, jump pads, weapons, and low gravity remain. Side texture projection avoids stretching across the cliff faces. The cave has an arched vault, and the crater has a continuous rim.

Kepler / 04 replaces the central solid block with a through-cabin, two side consoles, a rear airlock apron, and exterior roof access. The cabin and roof routes were traversed in both directions using the game's Player movement code. All rock crown heights and spawn body clearances passed. The navigation graph is connected. Multiplayer fallback spawns now sit on actual landing areas, with bounds that include both bases.

## Infinite Bloom

The inner seam used to shrink the view to roughly 19% while walking speed only fell to 78%. Walking speed now follows the same smooth scale as the view, and seam crossings transform momentum with position. Ground crossings retain floor and eye height. Recursive falling uses a gradual terminal-speed envelope instead of an abrupt velocity reset.

Browser movement checks cover both directions on all four floor faces. Their apparent speed remains approximately 12.2 units per second at the crossing. A two-minute fall simulation remains finite and inside the canonical arena. Unit checks cover all six faces, a corner, and rays at or within fractions of a millimetre of a seam. The existing recursive-beam helper also handles zero-length boundary segments; its browser regression check uses an explicit recursive Refractor configuration because the current weapon list does not enable that helper. Hyperstrike's per-layer pierced-target reset remains intact.

The art and main geometry are unchanged. These are measured continuity fixes; subjective feel still deserves a playthrough.

## Solar Flare

The rooms now have sloped instrument consoles with readable telemetry, service racks, coolant hardware, ceiling frames, and directional room signs. Larger equipment has collision. Small frames and sign fittings are batched by material, using the existing lighting. Room layout, ladders, atmospheric curtains, and interior/exterior gravity remain in place.

Seven pre-existing obstructed FFA starts were moved into clear lanes, and multiplayer fallback starts were aligned with the safe local pool. The lower operations-to-science route and upper operations-to-bridge-to-relay route were traversed in both directions, including settling on their destination floors. Spawn body clearance and gravity checks pass. Existing isolated navigation samples on exterior/vertical routes remain; this pass does not claim to rebuild Solar's entire navigation graph.

## Rendering cost and validation

| Matched overview | Before draws | After draws | Before triangles | After triangles | Before colliders | After colliders |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Asteroid Belt | 55 | 60 | 21,660 | 27,240 | 72 | 51 |
| Solar Flare | 92 | 114 | 64,964 | 70,112 | 178 | 185 |

Draw counts include the map studio's shadow and material passes. Asteroid values use the captured comparison frame (`comparisonStats` in its report); randomly placed decorative debris can vary subsequent overview counts by a few draws. They measure these views, not live-match FPS. No additional point lights were added to Solar; Asteroid Belt reuses the central station's light budget.

`npm test`: 52 passed. Syntax and whitespace checks passed. Browser reports are beside this document; `tools/space-audit.js` runs the movement checks, and `tools/map-audit.js` checks geometry, spawn clearance, navigation, and indexed ray intersections against exhaustive triangle scans. All reported geometry and movement assertions pass for these three maps.
