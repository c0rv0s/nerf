# Multiplayer fixes

Implemented locally on 2026-09-04 after the audit. No deployment or commit was made.

## What changed

Remote players now use a bounded, timestamped presentation history on both host and guest. The normal buffer is 100 ms and can adapt up to 220 ms during jitter. If samples stop arriving, presentation holds the last confirmed point and catches up gradually instead of predicting through geometry and correcting backward. Your own camera and movement remain immediate.

The host uses each guest's latest accepted position for gameplay, with a separate interpolated mesh for presentation. Bloom's coordinates have already been canonicalized by the guest; the host no longer wraps that guest a second time. A recursion generation and life counter reset presentation history across seams and respawns.

Completed local shots become bounded, sequenced requests, resent until acknowledged. The host deduplicates requests and validates their weapon, ammo, life, age, and firing cadence. A brief trigger press survives release. Continuous legacy input expires after 250 ms, and completed requests older than one second are acknowledged and discarded rather than played back after a long stall.

The guest subtracts unacknowledged shots from authoritative ammo. Old packets no longer restore rounds already spent. Death, respawn, exhausted magazines, charged shots, and host handoff have explicit handling. Charged weapon visuals use the guest's reported remaining charge; this does not create extra shots.

Zero components of surface-up and aim vectors are preserved. Remote meshes use full surface orientation. An immediate floor-to-ceiling transfer resets the orientation history instead of interpolating through a zero up vector.

New hosts advertise support for shot requests. Updated clients fall back to the existing held-input protocol when paired with an older host; the full shot improvements require an updated host and guest.

## Results

| Reproduction | Before | After |
|---|---|---|
| Runner stops during a 250 ms delivery stall | 0.679 m overshoot; backward correction | Zero overshoot; zero backward correction |
| Guest approaches a Bloom seam with delayed input | Nine repeated wraps in 150 ms | Zero host-invented wraps |
| Last input holds fire, then goes quiet | Seven shots in two seconds | One initial shot; no shots in second second |
| Brief click released before a send | No held-fire sample | Request retained and processed exactly once |
| Local ammo 4 followed by older authority ammo 5 | Restored to 5 | Remains 4 until acknowledgement |
| Horizontal up vector [1,0,0] | Changed to [0.707,0.707,0] | Preserved on host and rendered mesh |

Additional browser probes checked last-round automatic fallback, request expiration, charged weapon presentation/cadence, old-life rejection, and older-host fallback. `verify-fixes.js` runs production function bodies with a controlled clock and actual Three.js/Bot weapon methods. Rendering/audio callbacks are stubbed for this deterministic probe. `fixed-results.json` contains the full results.

All 65 Node tests pass. The integration suite starts real local WebSocket servers and checks request relay, acknowledgement propagation, seam/life fields, and acknowledgement retention through host handoff.

A separate real host and guest ran on an isolated local server. With 125 ms of artificial guest input delay, one brief click produced one authoritative shot, acknowledgement 1, and an empty pending queue. Both clients reported no browser errors. This is local integration evidence, not a production WAN latency benchmark.

## Re-run

Run `npm test`. In the existing map studio with Infinite Bloom loaded:

```js
const probe = await import('/docs/multiplayer-audit/verify-fixes.js');
await probe.runAudit(studio.world);
```

The original audit and pre-fix observations remain in `README.md` and `results.json`.
