# Multiplayer smoothness audit

Follow-up: the fixes and validation are documented in [FIXES.md](./FIXES.md). The findings below preserve the original audit.

2026-09-04. Read-only review of production gameplay code. The audit adds this report and a reproducible browser probe; it does not change networking behavior.

The clunkiness has reproducible causes in movement presentation and shot synchronization. Existing reconnect, authority-epoch, send-cadence, and host-failover tests pass. Those tests do not exercise the irregular packet timing and prediction conflicts below.

## Findings, in recommended fix order

### P1: Bloom prediction repeatedly undoes a seam crossing

Location: `src/main.js:2208-2216`, `src/main.js:6390-6393`, `src/maps.js:10043-10083`.

The host extrapolates a guest from an unchanged network target, then invokes Bloom's post-move similarity transform. When prediction crosses the outer seam, the character is rebased near the inner seam, but `remoteNet.targetPos`, `lastInputPos`, and velocity remain in the previous coordinate system. On the next frame the distance threshold snaps the character back to the old target. Prediction crosses again on the following frame.

Reproduction: latest guest input x=35.95, vx=2, sampled 80ms ago, no replacement input for 150ms. The character alternates between roughly x=35.95 and x=7.001 and wraps nine times in 18 frames. This can affect host-side hit tests and shooting origins, not only the visible avatar.

Fix: give network samples a seam generation/coordinate frame and rebase the complete prediction state atomically. Never let a stale pre-crossing sample restore an obsolete coordinate frame. Add a host/guest seam regression with delayed samples.

### P1: A stale held-fire input keeps creating authoritative shots

Location: `src/main.js:2219-2239`, `src/main.js:5137-5140`.

`updateRemoteHuman` keeps consuming the last entry in `G.remoteInputs`. Motion extrapolation stops extending after 180ms, but firing has no corresponding input-age cutoff. A connected guest whose input delivery stalls can continue firing at its last aim until another input or disconnect cleanup arrives.

Reproduction: one Secret Shot input with firing=true, then no input for two seconds. The production host update and Bot cooldown methods produce seven shots, including three during the second second.

Fix: expire continuous input intent after a bounded delivery gap. Prefer explicit sequenced shot requests with acknowledgement, especially alongside the short-click and ammo fixes below. A release message alone is insufficient because it may be stuck behind other TCP traffic.

### P2: Latest-sample extrapolation produces overshoot and backward correction

Location: `src/main.js:2810-2826`, `src/network-sync.js:1-23`.

Every received snapshot replaces the previous motion target. Remote avatars extrapolate up to 180ms and then exponentially chase that target. There is no timestamped interpolation buffer, acceleration model, or collision constraint in this presentation path. Stops and changes of direction therefore reveal the prediction error when a delayed packet arrives.

Reproduction: a 6m/s runner stops at x=6; 20Hz ordered samples have 80ms base delay and a 250ms stall around the stop; rendering is 120Hz. The avatar reaches x=6.679 and then moves backward by as much as 0.114m in one frame. If the stopping location is a wall, that predicted path can visibly enter it. The probe uses a stopping plane, not a real wall collider.

Fix: interpolate remote presentation from a short timestamped history with a delay adapted to packet jitter. Keep extrapolation brief and bounded during underflow. Handle teleports and map seam changes explicitly, and separate visual smoothing from authoritative hit-test positions. Do not apply extra delay to the local player's camera.

### P2: A brief local shot can be absent from every host input

Location: `src/multiplayer.js:131-158`, `src/main.js:6632-6636`, `src/player.js:414-419`.

The guest immediately draws/fires locally, but transmits only the current firing boolean at 30Hz. There is no latched press edge or sequenced shot command. A press and release between two sends is absent from the host's input history.

Reproduction: at 120Hz, a 25ms held-button interval between two sends produces zero transmitted firing=true samples. The probe demonstrates the missing intent; it does not simulate a complete local projectile hit.

Fix: retain shot/press events until acknowledged. Preserve continuous fire and warmup semantics separately from discrete trigger edges.

### P2: Older ammo snapshots overwrite predicted local consumption

Location: `src/main.js:2657-2683`, `src/player.js:414-419`.

The guest spends ammo locally. Each incoming host snapshot then replaces the entire ammo map, without a last-processed shot identifier or replay of unacknowledged consumption. Under latency the HUD can regain ammunition that was just spent; near zero this also interacts with automatic weapon selection.

Reproduction: predicted Scattershot ammo is 4 after a shot. Applying an older host loadout with 5 resets it to 5 immediately.

Fix: acknowledge shot sequences and reconcile authoritative ammo with outstanding local shots. Cover last-round firing, automatic weapon fallback, pickups, and death/respawn resets.

### P2: Horizontal wall-walk orientation is corrupted

Location: `src/main.js:2227-2229`, `src/main.js:2552`, `src/main.js:2828-2829`.

Using `input.up.y || 1` substitutes 1 for a valid zero component. A wall-walking up vector [1,0,0] becomes [0.707,0.707,0] on the host, tilting the shot origin. The guest snapshot application repeats the same zero-value problem. Remote meshes also receive yaw only rather than full surface orientation.

Reproduction: pass [1,0,0] through the actual host update; observe [0.707,0.707,0].

Fix: preserve zero components with nullish defaults and transmit/render a complete orientation suitable for Prism. Verify wall, ceiling, and ordinary floor cases.

## Verification and limits

- `npm test`: 57 passed, zero failures or skips. Includes actual local WebSocket servers and host/guest protocol tests.
- `probe.js` runs current production function bodies with actual Three.js vectors and Bot weapon cooldown methods. A controlled clock and ordered sample schedule make the failure cases reproducible. Rendering and audio callbacks are stubbed.
- Run in the existing map studio console:
  ```js
  const probe = await import('/docs/multiplayer-audit/probe.js');
  await probe.runAudit(studio.world); // load Infinite Bloom first
  ```
- `results.json` stores the observed values and motion trace. The Bloom result records whether the real map post-move hook was used.
- This is a local code/protocol audit with controlled timing, not a measurement of production Railway latency, real WAN packet loss, or physical two-device gameplay. The examples establish failure mechanisms, not their frequency in real matches.
- No production fixes or deployment were made during this audit. Previous map work remains intact.
