# Fortress Falls paintover experiment

November 4, 2026. Local changes; not deployed.

[Compare before/after](http://localhost:3000/docs/environment-review/paintover/index.html) · [Explore the map](http://localhost:3000/tools/map-studio.html?map=fortress)

Two iterations used the built-in imagegen tool:

1. Capture the canal, generate a paintover, implement its violet masonry, terracotta keep, rose paving, gold cornices, turquoise shields and warmer lighting.
2. Paint over the implementation, then refine the water, waterfall and clouds. Correct texture density on slabs and ramps.

The generated targets are `concept.png` and `concept-two.png`. Exact prompts are in [prompts.md](prompts.md). All `before`, `pass-one` and `after` screenshots are real Three.js renders. The implementation approximates the concepts with procedural textures, batched inlays and animated shaders; it does not reproduce their painted detail exactly.

## Verification

- 77 tests passed.
- 1,046 map-audit checks passed; no surface conflicts or blocked spawns.
- All 174 collider bounds and spawn positions match the baseline. Navigation remains one connected component of 182 points.
- Five simulated seconds with seven bots; finite positions, no browser or shader errors. High and low graphics profiles render successfully.
- Comparison controls and a 390px mobile layout checked in Chrome.

| Overview | Before | After |
|---|---:|---:|
| Draw calls | 193 | 196 |
| Triangles | 10,180 | 10,508 |
| Colliders | 174 | 174 |

These are camera-specific renderer counts, not a hardware frame-rate benchmark. VR and physical mobile devices were not tested.

## Repeat

Start the server with `npm start`, then:

```sh
node tools/capture-fortress-paintover.mjs
```

Requires Playwright and Chrome. Set `PLAYWRIGHT_MODULE` to an installed Playwright module path if it is outside the project. `NERF_TEST_URL` overrides localhost:3000. The script captures matching views, compares collision and spawns, runs the map audit, checks gameplay at high/low quality, and exercises the comparison page.

[Map measurements](after.json) · [Gameplay check](game-after.json)
