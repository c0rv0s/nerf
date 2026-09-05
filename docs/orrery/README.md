# The Orrery

A playable clockwork observatory suspended inside a storm. Enter THE ORRERY through the north Atrium gate, or select it in multiplayer voting. The local map studio is at http://localhost:3000/tools/map-studio.html?map=orrery.

The lower cloister and four bridges stay connected. Curved stairs lead to the pavilion roofs; two sanctuary stairs reach the central gallery. A rotating ring and opposed bridges connect the upper galleries, pause for six seconds, and turn ninety degrees over twelve seconds. Grounded riders move with the deck; jumping releases them. The bridge indicators show the boarding windows. Rotation uses the shared world clock for multiplayer.

The four rooms contain a star archive, engine house, refracting telescope, and southern gallery. Weapons and powerups are distributed across rooms and elevations. The central armillary, flying buttresses, storm panorama, enamel globe, ceiling inlays, and glass roof lanterns share one material palette. Static decoration is merged by material; walkable curved structures have matching triangle collision. There is one shadow-casting light, with four short-range gallery lights that do not cast shadows.

## Validation

- All 57 repository tests passed, including new motion continuity, rider eligibility, frame-rate independence, and multiplayer map-selection/world-clock checks.
- Browser player-physics checks covered all 16 authored routes in both directions, all four upper crossings in both directions, and riding three parts of the rotating deck at 30 and 120 Hz.
- Final scene audit: 4,453 checks, no failures; all 178 navigation nodes in one connected component; no blocked spawns. Collider ray candidate indexing reduced the sampled triangle search by 76%.
- Entered through the actual Atrium portal and ran an eight-character local match. See `live-match.json` for sampled performance and renderer counters. These are observations on this machine at the review viewport, not a hardware-independent FPS guarantee.
- `traversal.json`, `final-traversal.json`, and `scene-audit.json` contain the browser evidence. `tools/orrery-audit.js` makes the route checks reproducible in the map studio.
- Local changes only; not deployed.

## Images

- `overview.png`: complete arena.
- `arrival.png`: lower gallery arrival.
- `archive.png`: archive interior.
- `engine.png`: engine house interior.
- `crossing.png`: upper crossing.
- `gameplay.jpg`: actual game renderer with HUD.

## Generated materials

Mode: built-in `image_gen`, two fresh generations. The generated PNGs were converted to RGB WebP for the game. Geometry, collision, and architectural surface patterns are authored in JavaScript.

### Storm panorama

Saved project asset: `textures/orrery-storm.webp`.
Original: `/Users/nate/.codex/generated_images/01a06e7c-b38b-7393-ab2f-b790b8f6f1a3/exec-643b87b8-2e35-4e71-80f9-b31cb3124277.png`.

Prompt:

> Create one project-ready environment texture for a stylized 3D arena game called The Orrery: a gigantic luminous storm enclosing a brass celestial observatory floating in the eye of a hurricane. Asset only, not concept art: 360-degree equirectangular sky panorama, wide 2:1 aspect ratio. Seamless left and right edges. No land, no buildings, no objects, no horizon silhouettes, no words. Deep midnight indigo and desaturated teal storm clouds form enormous rolling banks, a soft luminous ivory-peach break in the storm low across one side, faint scattered stars in dark gaps high overhead, distant fine branching turquoise lightning embedded within a few cloud banks. The lower half is a misty dark teal cloud abyss, not ground. The zenith remains dark navy. Beautiful painterly cloud volume, deliberately broad readable masses, restrained contrast and rich cinematic light. Crisp high-quality hand-painted game sky, luxurious mysterious astronomical atmosphere. Do not include a central planet, sun disk, rings, architecture, frames, UI, or text. Entire image is usable sky texture.

### Celestial enamel

Saved project asset: `textures/orrery-celestial.webp`.
Original: `/Users/nate/.codex/generated_images/01a06e7c-b38b-7393-ab2f-b790b8f6f1a3/exec-37b4899a-268a-415c-9632-961ed15b0da0.png`.

Prompt:

> Create a square seamless albedo texture for an ancient celestial globe in a luxurious fantasy observatory game. Texture only, straight-on flat scan, evenly lit with no shadows or perspective. Pale celadon jade enamel and oxidized teal ceramic ground, with exquisite thin antique gold inlaid constellation lines, tiny stars, abstract astronomical glyphs, compass arcs, and delicate engraved orbit diagrams. A few broad cloudy mineral variations in the jade so the surface has depth at a distance. Elegant antique scientific instrument craftsmanship, restrained and mysterious, no real continents, no text or readable writing, no borders, no objects, no frame, no globe silhouette. Seamless repeating material designed to wrap a large spherical object. Gold line work is thin and deliberate, base colors teal jade sea green, with small ivory accents.
