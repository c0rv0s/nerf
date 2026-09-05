# Neon Heights and Fortress Falls

[Compare seven matching views](http://localhost:3000/docs/environment-review/index.html) · [Explore Neon](http://localhost:3000/tools/map-studio.html?map=city) · [Explore Fortress](http://localhost:3000/tools/map-studio.html?map=fortress)

Implemented locally on September 4, 2026. Nothing pushed or deployed. The comparison starts from the maps as they stood before this request, with matching cameras, viewport and frozen environment time.

## Neon Heights

The monorail makes a closed figure eight inside the city. Its diagonal crosses over the central street at a different elevation. The complete train stays within the boundary throughout the route. The former passages through the outer walls are closed.

Three parallel stations share the ten-metre transfer level: Arcade, Central and Palms. Each has platforms on both sides, separate street stairs, a canopy and signs readable from either direction. The train stops for five seconds at each station and opens its doors. One circuit takes about 35.7 seconds over a 455-metre route.

The train's floor, walls and doors now have rotating triangle collision matching their visible surfaces. The old axis-aligned boxes would expand across the interior during diagonal turns. Riders move with the train through both curves and inclines. Route timing is deterministic and independent of frame rate.

The stations feed the existing city:

- Arcade connects to the west hotel roof and its high bridge, plus the nearby weapon-ammo ledge.
- Central enters the arcade's upper window and the Galleria's gallery through a new opening. These are walkable routes, with onward paths through the buildings.
- Palms connects to both eastern roof routes. The Zooka is on its platform, drawing another weapon contest above the street.

The former west stair ended inside a tower. That access now runs through Arcade station. The west hotel's cramped mezzanine and broken roof hatch have been consolidated into a solid, walkable roof. The Galleria's full interior ascent, two tower elevators, roof launchers and subway remain. One street launcher was moved clear of a station stair and retargeted to its original landing.

Art Deco façade bands, warm and cyan window fields, stepped skyline silhouettes, platform canopies, viaduct piers, rooftop cover, sheltered street kiosks and marked subway entrances connect the visual design. The new details are batched by material. No new point lights or generated textures were added.

The main navigation graph is now one component with 246 nodes, compared with seven components before. Stale multiplayer spawns were replaced with the client map's tested pool.

## Fortress Falls

The layout and environment are unchanged. The review found no blocked local spawns or disconnected navigation. All 25 ramps were walked in both directions using the game's capsule solver without a failed traversal. The keep, canal, battlements and bridge joins were also inspected visually.

Its multiplayer table did need correction. The server still used old spawn coordinates and a 70-metre boundary despite the playable edge and local spawn positions extending farther. The server now mirrors the local spawn pool and uses a 77-metre boundary.

## Verification and cost

- **49 automated tests passed**, including the new deterministic station timing and route continuity tests.
- Neon browser audit: **38,254 checks, zero failures**. Full train envelope swept against the city, boarding at all three stops, two complete rides with gravity and collision, and all twelve new stairs/transfers walked in both directions without jumping.
- Fortress browser audit: **1,043 checks, zero failures**, plus 50 successful ramp traversals.
- Both maps have one connected navigation graph, clear FFA/team spawn probes and no spawn/pickup or pickup/pickup overlap under the repository's separation rule.
- A local Neon match ran with eight characters for eight simulated seconds; positions remained finite.
- `node --check` and `git diff --check` passed.

| Matched city overview | Before | After |
|---|---:|---:|
| Draw calls | 151 | 210 |
| Triangles | 17,216 | 53,888 |
| Colliders | 170 | 193 |

The fuller city costs 59 additional draws and about 37,000 additional triangles in this view. These are renderer counts at pixel ratio 1, without combat or postprocessing, not an FPS claim. Mobile hardware and long multiplayer matches were not profiled.

[Raw results](metrics.json) · [Transit movement audit](../../../tools/neon-audit.js) · [Previous map pass](../round-two.html)
