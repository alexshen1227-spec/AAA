# The Wilds of Aerwyn

An original open-air action-adventure for the browser, built with Three.js.
Aerwyn is a painterly, cel-shaded wilderness where traversal, weather, music,
memory, and wind are part of the same world—not separate minigames.

Play the published build at:
[alexshen1227-spec.github.io/AAA](https://alexshen1227-spec.github.io/AAA/)

The game takes high-level inspiration from modern open-world adventures while
using its own setting, characters, story, mechanics, music systems, and assets.
Signature landmarks, characters, creatures, relics, and props are original
locally authored GLBs under `assets/models/blender` and `assets/models/gen`.
CC0/attributed supporting packs are documented under `assets/licenses`.

## Run it

For development:

```text
python serve.py
```

Open [http://localhost:8123](http://localhost:8123).

For a portable offline build, double-click `WildsOfAerwyn.html`. It embeds all
runtime modules, fonts, models, and audio. Rebuild it with:

```text
python build_standalone.py
```

## Controls

| Input | Action |
|---|---|
| WASD + mouse | Move and look; click the game to capture the cursor |
| Shift | Sprint; drains stamina |
| Space | Jump; hold in the air to open the glider |
| W / S while gliding | Dive / flare |
| Walk into a cliff | Climb; Space leaps away from the wall |
| Click / J | Sword attack; fires while aiming; throws a held prop |
| Hold right mouse | Aim the bow on the ground or in the air |
| Q | Guard; a precisely timed guard reflects Hollow magic |
| Tab | Lock on to the nearest hostile target |
| E | Interact, speak, awaken, cook, rest, or inspect |
| F / R | Grab or place a prop / rotate a held prop |
| G | Throw a Zephyr Pod to plant a temporary updraft |
| H | Eat an apple |
| I | Open the satchel, quest log, Chronicle, deeds, and journal |
| C | Frame or keep a postcard moment |
| M / N / P | Map / mute / pause |

When a save exists, Enter or click continues it. Shift+Enter deliberately starts
a new journey.

## The adventure

The complete main story, **The Ninth Warden**, carries the player from the
opening meadow through eight beacons, three skywatch towers, Warden testimony,
twin pressure-vaults, golem-forged equipment, the two ouroboros gates, the Coil
sky-vault, the Coiled Storm, and a skippable authored credits sequence.

The wider world includes:

- Tilla's fallen-sky-stone quest, Ilyra's five Mirrormere lanterns, Sella
  Vane's weather-aware road shop, Gubbin the Craven, and fire-side gatherings.
- The Under-Mere workshop, Tumbled Vale, Sixth's Vigil, the Drift sky-road,
  Hollow Stones, Gloamings, letters on the wind, the Pale Hart, Warden Echoes,
  and an auto-written Wanderer's Journal.
- Twenty persistent glimmers, deed-stars that form a constellation, ancient
  gear upgrades, relics, cooking and regrowing forage, rumors, and postcards.
- Sword combos, lock-on, guarding and perfect reflection, ground/aerial archery,
  kindled arrows, movable/throwable props, Boglins, Hollows, Razorkites,
  Gloamhounds, camp variants, and camp-clear Last Light moments.
- Climbing, mantling, gliding, living gusts, portable updrafts, swimming, a
  rideable river current, sky islands, wind trials, and the Hush Bell.
- A ten-minute day/night cycle; rain, warned lightning, wet climbing, doused
  camps, blood nights, fallen-star chases, post-game Stray Squalls, rainbows,
  regional Songlines, adaptive ambience, real music, and synthesized fallbacks.
- Authored deer, rabbits, fish, NPCs, enemies, relics, landmarks, waterfalls,
  plus birds, thermal riders, fireflies, butterflies, foliage, and instanced grass.

## Architecture

| Area | Main modules |
|---|---|
| Bootstrap, save, input, simulation | `src/main.js`, `src/state.js` |
| Terrain, sky, weather | `src/terrain.js`, `src/sky.js`, `src/noise.js` |
| Player, combat, enemies, wildlife | `src/player.js`, `src/hero-rig.js`, `src/enemies.js`, `src/animals.js` |
| World and campaign | `src/world.js`, `src/quests.js`, `src/coil.js`, `src/finale.js` |
| Characters and side stories | `src/adventure.js`, `src/remember.js`, `src/gubbin.js`, `src/undermere.js`, `src/vigil.js` |
| Dynamic/world systems | `src/fallenstar.js`, `src/squall.js`, `src/hearth.js`, `src/simmerpot.js`, `src/drift.js` |
| Presentation | `src/ui.js`, `src/audio.js`, `src/post.js`, `src/scarf.js`, `src/postcard.js` |
| Assets | `src/assets.js`, `src/sfx-manifest.js` |

The world uses an analytic deterministic height field, so terrain rendering,
collision, placement, river flow, and map generation agree. Persistent content
uses versioned stable IDs and validated localStorage migration.

## Verification

Run the dependency-free regression suite:

```text
python verify_game.py --build
```

It checks JavaScript syntax, the complete local import graph, DOM references,
runtime asset presence, GLB structure, and the self-contained build manifest.
The game also exposes `window.__game` and `window.__step(dt, n)` for focused
browser scenarios.
