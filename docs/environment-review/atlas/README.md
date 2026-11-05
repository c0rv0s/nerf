# Arena paintovers

[Compare the game captures and painted references](index.html). The gallery covers all 15 match maps, the Atrium, and the Hall of Fame.

The final eight reviews each have two game cameras, a paintover of the first view, and before/after audit reports. The route fingerprint covers ramps, free-for-all spawn positions, waypoints, and pickups. Collider counts are checked separately. Solar Flare and Infinite Bloom also run the space gameplay audit; the Orrery checks its gallery and stair faces.

With the local server running and Playwright available:

```sh
node tools/capture-atlas-paintovers.mjs after          # all eight maps
node tools/capture-atlas-paintovers.mjs after canopy   # one map
```

Set `GAME_URL` for another server or `PLAYWRIGHT_MODULE` for an external Playwright installation.
