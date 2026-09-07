# VR match-loading regression

The arena transition previously called `renderer.setAnimationLoop(tick)` again.
In the pinned Three.js r160 renderer, that restarts the page animation loop even
while a headset session is active. Both page and XR callbacks then stepped the
game. Predicted XR timestamps alternating with page timestamps could repeatedly
hit the 50 ms simulation cap, accelerating matches and doubling render work.

The fix registers the loop once, rejects page frames during XR, and uses
`performance.now()` for simulation and the host fallback. Desktop resize and
resolution settings no longer alter the active XR framebuffer during loading.
The original movement speed is unchanged.

`npm test` covers controller mapping, the neutral-input interlock, and multiplayer
muzzle validation. The optional browser check uses IWER and installed Google Chrome.
Start the game with `npm start`. In another terminal:

```sh
npm install --prefix /tmp/nerf-vr-check playwright iwer
PLAYWRIGHT_MODULE=/tmp/nerf-vr-check/node_modules/playwright/index.mjs IWER_BUNDLE=/tmp/nerf-vr-check/node_modules/iwer/build/iwer.js node tools/verify-vr-timing.mjs
```

Set `NERF_TEST_URL` if the server is not at `http://localhost:3000`.
Set `REPRO_OLD=1` to restore the old loop behavior only in intercepted browser
responses. That run should fail the match-timing assertion; it does not edit files.

The check injects a 50 ms predicted-display timestamp offset and compares
Atrium timing with timing after loading Blast Complex. It also checks one
simulation update per XR callback, stable XR resolution through loading, held-stick
interlocks after map changes, and desktop rendering restoration on exit.

Measured September 7, 2026: the old path ran normally in the Atrium, then advanced
6.000 simulated seconds in 2.001 real seconds after loading a match, with 240
simulation updates for 120 XR callbacks. The fixed path advanced 1.998 simulated
seconds in 2.001 real seconds, with 120 updates for 120 XR callbacks.
These are emulation regression measurements; Rift frame rate and comfort still
require a hardware playtest.
