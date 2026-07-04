# NERF ARENA BLAST — Web Homage

A browser tribute to *Nerf Arena Blast* (1999): first-person team deathmatch
against NPC bots, built with Three.js. No build step, no dependencies to
install — plain ES modules with Three.js loaded from a CDN.

## Run it

Any static file server works (ES modules can't load from `file://`):

```sh
python3 -m http.server 8123
# then open http://localhost:8123
```

## The game

- **Modes**: **Free-for-all** (default) — you vs 7 bots, first to 5000 points —
  or **Team deathmatch**, blue (you + 3 bots) vs red (4 bots), first to 8000.
  Both cap at 8 minutes.
- **Scoring (PointBlast style)**: frags drop a **point orb** at the body that
  anyone can collect — or steal. Value scales with the victim's placing:
  1000 for the leader, 750 for second, 500 for third, 250 otherwise.
  Hidden ★ stars are +500.
- **Weapons** (keys 1–7, or scroll):
  1. **Secret Shot** — default blaster, infinite ammo
  2. **Scatterblast** — 6-pellet shotgun
  3. **Pulsator** — rapid fire
  4. **Sidewinder** — ricocheting disc (3 bounces)
  5. **Ballzooka** — slow arcing ball with splash damage
  6. **Whomper** — massive single foam slug with mini-splash
  7. **Hyperstrike** — high-damage sniper dart
  All except the Secret Shot must be found on the map, with limited ammo;
  your active weapon (with its ammo) drops where you die.
- **Powerups**:
  - **Gold Nerf medal** — 3× damage for 30 seconds
  - **Silver Nerf medal** — 2× damage for 30 seconds
  - **Hidden ★ stars** — +5 team score, tucked behind crates / on hard-to-reach rocks
  - **Health kits** — +30 HP
  Bots will grab all of these too if they walk over them.

## Maps

1. **Blast Complex** — indoor labyrinth: a crate-maze room, a mezzanine room
   with a second floor, a grand atrium with a tiered tower, jump pads, a
   floating gold platform, and a sunken basement wing under a bridge.
2. **Fortress Falls** — walled courtyard split by a trench: lane walls form
   corridors, battlement walkways run along the perimeter, sniper towers on
   two corners, and a keep hiding the gold medal inside.
3. **Asteroid Belt** — floating rocks around a derelict station in deep space,
   very low gravity, bounce pads (watch your landing — the void is fatal).
   The gold medal sits on a tiny rock high above the station.
4. **Canopy** — giant forest: branch decks at 10/20, treetop bridges, and a
   pad chain up the center tree to a golden crown 30m up.
5. **Neon Heights** — night rooftops over a street canyon: fire escapes,
   sloped sky-bridges, and pad-hops up the skyline to the gold at 34m.

## Controls

WASD move · mouse aim · left-click shoot · Space jump · 1–5/scroll switch
weapon · Tab scoreboard · Esc release mouse.

## Code layout

| File | What it does |
|---|---|
| `src/main.js` | menu, match loop, damage/kills, pickups wiring, input |
| `src/engine.js` | capsule physics vs boxes/spheres/ramps, LOS, waypoint graph + BFS |
| `src/maps.js` | the three maps: geometry, colliders, spawns, pickups, waypoints |
| `src/player.js` | pointer-lock FPS controller + viewmodel |
| `src/bots.js` | bot AI: waypoint patrol, combat strafing, ballistic asteroid hops |
| `src/weapons.js` | weapon stats, projectile simulation, hit effects |
| `src/pickups.js` | spinning pickup items with respawn timers |
| `src/hud.js` | DOM HUD: health, ammo, scores, killfeed, scoreboard |
| `src/audio.js` | procedural WebAudio sound effects |

Debug helpers in the console: `__game()` returns match state,
`__step(seconds)` fast-forwards the simulation headlessly.
