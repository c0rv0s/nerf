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

## Oculus Rift / Touch VR

On the Windows PC connected to the Rift, start the headset runtime and use a
WebXR-capable browser such as Chrome or Edge. The PC must have an active OpenXR
runtime that can see the Rift. Open the game over HTTPS, or run `npm start` on
that PC and open `http://localhost:3000`. Plain HTTP on a LAN IP cannot start VR.

Enter the lobby or an arena, close any menus, then click **ENTER VR** at the
bottom right. Press Esc first if the mouse is captured. **VR SETUP** means the browser cannot currently detect immersive
VR support. A failed session request shows the browser's error beside the button.

| Touch control | Action |
| --- | --- |
| Left stick | Move in the direction you are looking |
| Right stick left/right | Turn 30 degrees; release to turn again |
| Right trigger | Fire the tracked blaster |
| A | Jump; hold for swimming or jetpack thrust |
| X | Next available weapon |
| Left trigger | Toggle the independently aimed left-hand grapple when equipped |
| Left grip | Gallop on mounted maps |
| Y | Recenter seated/standing position |
| B | Pause / resume; opens the headset menu |

After entering VR, changing maps, or regaining headset tracking, release the
sticks and trigger before moving again. This prevents held input from carrying
you straight into another gate.

Health, shield, weapon, ammo, awards, and round status appear inside the headset.
Low health and low ammo turn red; health has the same orange/gold bar as desktop.
B pauses solo play and opens a headset scoreboard with Resume and Back to
Atrium buttons. There is no in-game Exit VR action. Point the right controller and pull its trigger, or use
right-stick up/down and A. Online matches continue while your menu is open.
The results panel appears beside the visible podium at the end of a round.
The desktop VR setup/entry button only appears while paused outside VR. Walk
through an Atrium gate to enter an arena. Multiplayer lobby, voting, settings,
and name-entry menus still use the desktop. Headset/runtime controls handle
leaving VR; B and Back to Atrium always keep the session running.
VR uses a dedicated low-detail profile at 80% headset render scale, without
dynamic shadows or desktop resolution changes during a session. Desktop quality
is restored on exit. VR uses direct stereo rendering without the desktop bloom compositor, camera
shake, recoil rotation or animated death camera. Existing physics still apply,
including jumping, vehicles and unusual gravity maps. Start with a normal arena.
This is seated/standing controller locomotion: physical leaning moves the view,
but room-scale walking does not move the collision capsule. Touch controllers
are required for this control scheme; hand tracking is not implemented.

Multiplayer keeps the existing shot protocol and includes an optional bounded
controller muzzle offset. Older hosts can still receive shots but use their
normal muzzle position. Controller poses are not yet shown on remote avatars.
Hardware tracking, frame rate and comfort require a real Rift playtest.
See [VR regression checks](docs/vr-validation.md) for the reproducible timing test.

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
- **Long-shot awards**: projectile kills over 100m earn **Long Shot**, with the
  measured distance displayed; kills over 500m earn **Dead Eye** instead.
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

On touch devices, the left half of the screen is a floating movement stick and
the right half is a swipe-to-aim surface. Hold FIRE to shoot, hold JUMP to jump
or run a jetpack, tap SWAP to cycle to the next loaded weapon, and use the pause
button in the top-right for the scoreboard and settings.

## Installable mobile app

The site is an installable progressive web app. Android browsers use the in-app
install prompt; iPhone and iPad users can use Share → Add to Home Screen. The
installed app launches fullscreen in landscape. `sw.js` precaches the game shell
and keeps requested textures, audio, and CDN modules available for faster repeat
launches and offline fallback.

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
