# NERF ARENA BLAST — Web Homage

A browser tribute to *Nerf Arena Blast* (1999): first-person team deathmatch
against NPC bots, built with Three.js. Solo play is still plain ES modules
with Three.js loaded from a CDN; multiplayer runs through the included Node
WebSocket server.

Live: https://nerf-arena-blast-revival.up.railway.app/

## Run it

For single-player only, any static file server works (ES modules can't load
from `file://`):

```sh
python3 -m http.server 8123
# then open http://localhost:8123
```

For multiplayer or Railway-style local testing, run the all-in-one Node server:

```sh
npm start
# then open http://localhost:3000
```

The Node server serves the same static files, hosts `/ws` for continuous
multiplayer lobbies, and exposes the Hall of Fame API at `/api/leaderboard`.
Railway uses `npm start` via `railway.json`.

## Hall of Fame database

The Hall of Fame uses PostgreSQL whenever `DATABASE_URL` is present. On
Railway, add a PostgreSQL service to the project and reference its
`DATABASE_URL` from the game service. The server creates the leaderboard table
and ranking index automatically on startup. Without `DATABASE_URL`, local
development uses an in-memory top 100 that resets when the server restarts.

- Enter the **HALL OF FAME** through the gold portal at the far end of the atrium.
- All 100 ranked places are displayed along the hall walls; the top three are
  repeated on the champion podium at the far end.
- Qualifying players can enter a name on the post-match podium. Each entry
  records score, map, game type, whether it was single-player or multiplayer,
  and every award earned during that match.

## Multiplayer

- Enter through the **MULTIPLAYER** portal in the atrium.
- The first human creates a lobby; empty lobbies wind down automatically.
- Up to five lobbies are supported, with eight competitor slots per lobby.
- Humans replace bots when they join. If a human joins mid-match, their score
  starts at 0.
- Each cycle is 10 seconds of map voting, 5 minutes of play, then a 15-second
  winner podium before the next vote.

## The game

- **Modes**: **Free-for-all** (default) — you vs 7 bots, first to 5000 points —
  or **Team deathmatch**, blue (you + 3 bots) vs red (4 bots), first to 8000.
  Both cap at 8 minutes.
- **Scoring (PointBlast style)**: frags drop a **point orb** at the body that
  anyone can collect — or steal. Value scales with the victim's placing:
  1000 for the leader, 750 for second, 500 for third, 250 otherwise.
  Hidden ★ stars are +500.
- **Weapons** (keys 1–8, or scroll):
  1. **Secret Shot** — default blaster, infinite ammo
  2. **Scatterblast** — 6-pellet shotgun
  3. **Pulsator** — rapid fire
  4. **Sidewinder** — ricocheting disc (3 bounces)
  5. **Ballzooka** — slow arcing ball with splash damage
  6. **Whomper** — massive single foam slug with mini-splash
  7. **Hyperstrike** — high-damage sniper dart
  8. **Parasite** — one-bounce dart that spawns five waist-level two-bounce balls on hit
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

WASD move · mouse aim · left-click shoot · Space jump · 1–8/scroll switch
weapon · Tab scoreboard · F fullscreen · Esc release mouse.

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
