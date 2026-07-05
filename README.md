# The Wilds of Aerwyn

Static website build for GitHub Pages:
https://alexshen1227-spec.github.io/AAA/

An original open-air adventure for the browser, inspired by the *feel* of modern
open-world exploration games: a painterly cel-shaded wilderness where you can
climb anything, glide anywhere, and chart the land beacon by beacon. Built with
Three.js. World geometry is largely procedural; signature landmarks and props
are original Blender-authored GLBs (assets/models/blender, assets/models/gen),
and the game also uses CC0 asset packs — KayKit characters and Kenney
sounds/models — credited in assets/licenses/.

## Run it

```
python serve.py
```

Then open http://localhost:8123 — or use the Claude Code preview launch config
(`.claude/launch.json`, server name `game`).

## How to play

| Input | Action |
|---|---|
| WASD + mouse | Move / look (click to capture the cursor) |
| SHIFT | Sprint (drains stamina) |
| SPACE | Jump — hold in the air to deploy the glider |
| Walk into a cliff | Climb (stamina; SPACE leaps up the wall) |
| Click / J | Sword attack (3-hit combo) |
| TAB | Lock on to the nearest boglin |
| E | Interact — awaken beacons, lift glimmer rocks |
| F / R | Grab & place crates / rotate held crate |
| H | Eat an apple (+1 heart) |
| P / M | Pause / mute |

## The loop

- **Awaken the 8 ancient beacons** — each is a checkpoint, heals you, and grants
  a Spirit Orb. Every 4 orbs: +1 heart or +stamina.
- **Climb the 3 skywatch towers** — rest ledges ring the shaft; topping one
  charts the region and reveals beacons on the minimap.
- **Boglin camps** roam the plains (indigo ones hit harder). They drop life
  and sky gems.
- **12 forest glimmers** hide under suspicious small rocks.
- **Ancient ruins** dot the plains — read the glowing lore tablets to piece
  together what happened to Aerwyn.
- Day/night cycle (~10 min), swimming, fall damage, crate-stacking physics
  puzzles, generative piano ambience, full save via localStorage.
- Ambient life: birds circle by day, fireflies rise near water and woods at
  night, flowers sway in the meadows.

## Architecture

| File | Role |
|---|---|
| `src/noise.js` | Seeded simplex noise / fbm / ridge — the world is deterministic |
| `src/terrain.js` | Analytic height field (physics = graphics), terraced cliffs, vertex-colored toon terrain, water, minimap render |
| `src/sky.js` | Day/night palette lighting, sun/moon, stars, clouds, fog |
| `src/world.js` | Forests, rocks, grass (26k swaying instanced blades), beacons, towers, crates, glimmers, pickups, particles |
| `src/player.js` | Procedural hero + controller: run/sprint/jump/climb/glide/swim, stamina, combat, grab ability, orbit camera |
| `src/enemies.js` | Boglin AI: wander → alert → chase → attack, health bars, drops |
| `src/audio.js` | WebAudio synthesis: generative pentatonic piano, wind, crickets, all SFX |
| `src/ui.js` | Hearts, stamina wheel, minimap, toasts, banners, prompts |
| `src/main.js` | Bootstrap, input, save/load, game loop (`window.__step` drives headless testing) |

Testing hook: `window.__game` exposes state; `window.__step(dt, n)` steps the
simulation synchronously (rendering only the final frame), which is how the
whole game was verified end-to-end in an automated browser.
