// Entry point: bootstraps renderer, world, player, systems, input, loop.
import * as THREE from 'three';
import { G, save, load, wipeSave } from './state.js';
import { heightAt, inRiver, buildTerrain, buildWater, updateWater } from './terrain.js';
import { buildSky, updateSky, isNight } from './sky.js';
import {
  buildForests, buildRocks, buildGrass, updateGrass, buildGlimmers,
  buildShrines, updateShrines, activateShrine, buildTowers, updateTowers,
  buildCrates, updateCrates, initPickups, updatePickups, addPickup,
  initSparkles, updateSparkles, spawnSparkle, spawnHealBloom,
  buildFlowers, buildRuins, buildBirds, updateBirds, buildFireflies, updateFireflies,
  buildIslands, updateIslands, buildWayfarer, updateWayfarer, buildGleaner,
  buildAmbient, updateAmbient, updateGolems,
} from './world.js';
import { buildEnemies, updateEnemies, respawnFallen } from './enemies.js';
import { buildAnimals, updateAnimals } from './animals.js';
import { initTutorial, updateTutorial } from './tutorial.js';
import { initOpening, updateOpening } from './opening.js';
import { Player } from './player.js';
import { UI } from './ui.js';
import { AudioSys } from './audio.js';
import { initPost } from './post.js';

// ---- renderer -------------------------------------------------------------

const canvas = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.6));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;

// Post pipeline (bloom + grade). While active, exposure + ACES live in its
// composite shader, so renderer tone mapping is disabled to avoid doubling up.
// If unavailable (or if it ever fails at runtime) we render directly with the
// classic ACES settings above.
let post = initPost(renderer);
if (post) renderer.toneMapping = THREE.NoToneMapping;

function renderFrame() {
  if (post) {
    try {
      post.render(G.scene, G.camera);
      return;
    } catch (err) {
      post = null; // disable for good; restore direct-render settings
      renderer.setRenderTarget(null);
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      console.warn('Post pipeline failed; reverting to direct rendering.', err);
    }
  }
  renderer.render(G.scene, G.camera);
}

G.renderer = renderer;
G.scene = new THREE.Scene();
G.camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 2000);
G.heightAt = heightAt;

window.addEventListener('resize', () => {
  G.camera.aspect = window.innerWidth / window.innerHeight;
  G.camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (post) post.setSize();
});

// ---- build world ------------------------------------------------------------

buildSky();
buildTerrain();
buildWater();
initSparkles();
initPickups();
buildForests();
buildRocks();
buildGrass();
buildShrines();
buildTowers();
buildCrates();
buildGlimmers();
buildFlowers();
buildRuins();
buildBirds();
buildFireflies();
buildAmbient();
buildAnimals();
buildIslands();
buildWayfarer();
buildGleaner();
buildEnemies();

G.player = new Player();
G.ui = new UI();
G.audio = new AudioSys();

// ---- save/load ---------------------------------------------------------------

let saved = load();
if (saved) {
  document.getElementById('continue-hint').style.display = 'block';
}

function applySave(s) {
  G.maxHearts = s.maxHearts; G.hearts = s.maxHearts;
  G.maxStamina = s.maxStamina; G.stamina = s.maxStamina;
  G.orbs = s.orbs; G.apples = s.apples; G.gems = s.gems; G.glimmers = s.glimmers;
  G.respawn = s.respawn;
  s.shrines.forEach((a, i) => { if (a && G.shrines[i]) activateShrine(G.shrines[i], true); });
  s.towers.forEach((a, i) => {
    if (a && G.towers[i]) {
      const t = G.towers[i];
      t.active = true;
      t.glowMat.color.set(0xaef4ff);
      t.beaconHalo.material.color.set(0x54e8ff);
      t.band.material.color.set(0x54e8ff);
      t.beam.material.color.set(0x54e8ff);
      if (t.energyMats) for (const m of t.energyMats) { m.color.setHex(0x9feaff); m.emissive.setHex(0x54e8ff); }
    }
  });
  G.respawn = s.respawn;
  if (s.items) Object.assign(G.items, s.items);
  if (s.seen) Object.assign(G.seen, s.seen);
  if (s.tut) Object.assign(G.tut, s.tut);
  if (s.arrows !== undefined) G.player.arrows = s.arrows;
  G.player.pos.set(s.respawn.x, heightAt(s.respawn.x, s.respawn.z), s.respawn.z);
}

// ---- input --------------------------------------------------------------------

const keys = G.keys;
window.addEventListener('keydown', (e) => {
  if (e.code === 'Tab') e.preventDefault();
  if (e.repeat) return;
  keys[e.code] = true;

  if (!G.started && (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space')) {
    startGame(!!(e.shiftKey && saved));
    return;
  }
  if (!G.started) return;

  if (G.gameOver && (e.code === 'Enter' || e.code === 'NumpadEnter')) {
    G.player.respawnNow();
    G.ui.hideGameOver();
    return;
  }
  switch (e.code) {
    case 'KeyM': toggleMap(); break;
    case 'KeyI': G.ui.toggleInventory(); break;
    case 'Escape': if (G.ui.invOpen) G.ui.toggleInventory(); break;
    case 'KeyN':
      G.settings.mute = !G.settings.mute;
      G.ui.toast(G.settings.mute ? 'Sound off' : 'Sound on', 0xcccccc);
      break;
    case 'KeyP':
      if (!mapOpen) setPaused(!G.paused);
      break;
    case 'Tab': keys._lockPressed = true; break;
  }
  if (G.paused || mapOpen) return; // gameplay inputs are inert while frozen
  switch (e.code) {
    case 'KeyE': tryInteract(); break;
    case 'KeyF': G.player.tryGrab(); break;
    case 'KeyH': eatApple(); break;
    case 'KeyJ':
      if (G.player.aiming) G.player.tryShoot();
      else G.player.tryAttack();
      break;
  }
});
window.addEventListener('keyup', (e) => {
  keys[e.code] = false;
  if (e.code === 'Space') keys._spaceLatch = false;
});
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });

canvas.addEventListener('click', (e) => {
  if (!G.started) { startGame(!!(e.shiftKey && saved)); return; } // clicking the title starts too
  if (mapOpen) return;                          // map is keyboard-driven
  if (document.pointerLockElement !== canvas) {
    lockPointer();
  } else if (!G.paused) {
    if (G.player.aiming) G.player.tryShoot();
    else G.player.tryAttack();
  }
});

// bow draw: hold right mouse to aim (contextmenu suppressed for it)
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 2 && document.pointerLockElement === canvas) keys._rmb = true;
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 2) keys._rmb = false;
});

function lockPointer() {
  try {
    const p = canvas.requestPointerLock();
    if (p && p.catch) p.catch(() => { });
  } catch (err) { /* pointer lock unavailable — mouse look via drag not supported, game still runs */ }
}

// ---- pause panel & full map ------------------------------------------------

let mapOpen = false;        // full-map overlay open (force-pauses the sim)
let mapPrevPaused = false;  // user-pause state to restore when the map closes
let pausedByLock = false;   // pause came from losing pointer lock

function refreshPausedHint() {
  document.getElementById('paused-hint').style.display =
    (G.started && document.pointerLockElement !== canvas && !G.paused && !mapOpen)
      ? 'block' : 'none';
}

// Pause still just flips G.paused — the sim freeze in tick() is unchanged.
function setPaused(v, fromLock = false) {
  if (G.paused === v) return;
  G.paused = v;
  pausedByLock = v && fromLock;
  if (v) {
    G.ui.showPause();
  } else {
    G.ui.hidePause();
    G.mouse.dx = 0; G.mouse.dy = 0; // no camera snap from deltas gathered while frozen
  }
  refreshPausedHint();
}

function toggleMap() {
  if (!G.started || G.gameOver) return;
  mapOpen = !mapOpen;
  if (mapOpen) {
    mapPrevPaused = G.paused;   // force-pause; separate from user-pause
    G.paused = true;
    G.ui.hidePause();
    G.ui.showMap();
  } else {
    G.ui.hideMap();
    G.paused = mapPrevPaused;   // restore prior pause state
    if (G.paused) G.ui.showPause();
    else { G.mouse.dx = 0; G.mouse.dy = 0; }
  }
  refreshPausedHint();
}

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  if (!locked && G.started && !G.gameOver && !mapOpen && !G.paused) {
    setPaused(true, true);      // losing the pointer opens the pause panel
  } else if (locked && pausedByLock && !mapOpen) {
    setPaused(false);           // clicking back in resumes an auto-pause
  }
  refreshPausedHint();
});
window.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === canvas) {
    G.mouse.dx += e.movementX;
    G.mouse.dy += e.movementY;
  }
});

function startGame(continueSaved) {
  if (G.started) return;
  const usingSave = !!(continueSaved && saved);
  if (usingSave) {
    applySave(saved);
  } else if (saved) {
    wipeSave();
    saved = null;
    document.getElementById('continue-hint').style.display = 'none';
  }
  G.player.snapCameraNextFrame();
  G.started = true;
  document.getElementById('title').classList.add('hide');
  document.body.classList.add('ingame');
  G.audio.start();
  initTutorial();
  initOpening();
  lockPointer();
  setTimeout(() => {
    G.ui.banner('THE WILDS OF AERWYN', 'Seek the beacons. The wind will carry you.');
  }, 800);
  if (!usingSave) {
    setTimeout(() => {
      G.ui.toast('The beacons of Aerwyn have gone dark. Climb. Glide. Wake them.', 0xe2cb8d, 5200);
    }, 5200);
  }
}

// ---- regions & the crimson moon ---------------------------------------------------

const REGIONS = [
  { name: "Wanderer's Plateau", x: 60, z: -80, r: 68 },
  { name: 'Mirrormere', x: -170, z: 120, r: 100 },
  { name: 'Thornwood', x: 80, z: 200, r: 85 },
  { name: 'Stormridge Massif', x: -120, z: -260, r: 190 },
];
let lastRegion = '';

function updateRegion() {
  const p = G.player.pos;
  let name = null;
  for (const r of REGIONS) {
    if (Math.hypot(p.x - r.x, p.z - r.z) < r.r) { name = r.name; break; }
  }
  if (!name) {
    const d = Math.hypot(p.x, p.z);
    if (d > 330) name = 'The Sunder Ring';
    else if (inRiver(p.x, p.z)) name = "The Serpent's Run";
    else name = 'The Heartfields';
  }
  if (name !== lastRegion) {
    lastRegion = name;
    G.ui.region(name);
    // a soft region-entry motif — each named land greets the wanderer
    G.audio.chord([392, 493.9, 587.3], 0.07, 0.16);
  }
}

function updateBloodMoon() {
  const night = isNight();
  const due = (G.dayCount || 0) % 3 === 2;
  if (night && due && !G.bloodNight) {
    G.bloodNight = true;
    const n = respawnFallen();
    G.ui.banner('THE CRIMSON MOON', 'The fallen stir beneath a bleeding sky');
    if (n > 0) G.audio.sfx('die');
  } else if (!night && G.bloodNight) {
    G.bloodNight = false;
    G.ui.toast('The crimson moon wanes. The valley breathes again.', 0xffb6a3, 3600);
  }
}

// ---- interactions ----------------------------------------------------------------

function tryInteract() {
  const p = G.player.pos;
  for (const it of G.interactables) {
    if (it.gone) continue;
    if (it.pos.distanceTo(p) < it.r) { it.onUse(); return; }
  }
}

G.eatApple = eatApple; // the satchel's apple card uses it too
function eatApple() {
  if (G.apples <= 0) { G.ui.toast('No apples left...', 0xcccccc); return; }
  if (G.hearts >= G.maxHearts) { G.ui.toast('Life is already full.', 0xcccccc); return; }
  G.apples--;
  G.hearts = Math.min(G.maxHearts, G.hearts + 4);
  G.audio.sfx('eat');
  spawnHealBloom(p2().x, p2().y, p2().z);
  G.ui.toast('Delicious! +1 heart', 0xffb6a3);
}
const p2 = () => G.player.pos;

function updatePrompt() {
  const p = G.player.pos;
  let label = null;
  for (const it of G.interactables) {
    if (it.gone) continue;
    if (it.pos.distanceTo(p) < it.r) { label = 'E — ' + it.label; break; }
  }
  if (!label && G.player.held) {
    label = 'F — Place · R — Rotate · J — Throw';
  }
  if (!label && !G.player.held) {
    for (const c of G.grabbables) {
      if (c.position.distanceTo(p) < 4.5) {
        const ud = c.userData || {};
        label = 'F — ' + (ud.heavy ? 'Heave ' : 'Grab ') + (ud.kind || 'crate');
        break;
      }
    }
  }
  G.ui.prompt(label);
}

// ---- loop -------------------------------------------------------------------------

let last = performance.now();
let frame = 0;
let simNow = performance.now();
let doRender = true;

function step(dt, now) {
  if (G.started && !G.gameOver) {
    G.time += dt;
    G.player.update(dt);
  }

  updateSky(G.started ? dt : dt * 0.15);
  updateWater(G.time);
  if (G.started) {
    updateGrass();
    updateShrines(dt);
    updateTowers();
    updateCrates(dt);
    updatePickups(dt);
    updateEnemies(G.gameOver ? 0 : dt);
    updateSparkles(dt);
    updateBirds(isNight());
    updateFireflies(isNight());
    updateAmbient(dt, isNight());
    updateAnimals(dt, isNight());
    updateTutorial(dt);
    updateOpening(dt);
    updateGolems();
    updateIslands();
    updateWayfarer(dt);
    if (frame % 19 === 0) updateRegion();
    updateBloodMoon();
    if (frame % 3 === 0) updatePrompt();
    if (doRender) G.ui.update(dt);
    G.audio.update(dt, isNight(), G.player.pos.y, G.player.mode === 'glide');
  } else {
    // title screen: slow orbiting camera over the world
    const t = now * 0.00004;
    const cx = Math.sin(t) * 180, cz = Math.cos(t) * 180;
    G.camera.position.set(cx, heightAt(cx, cz) + 40, cz);
    G.camera.lookAt(0, 12, 0);
    updateSparkles(dt);
  }

  frame++;
  if (doRender) renderFrame();
}

function tick(now) {
  requestAnimationFrame(tick);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (dt <= 0) return;
  if (G.paused) { renderFrame(); return; }
  simNow = now;
  step(dt, now);
}
requestAnimationFrame(tick);

// debug hooks for automated testing: run n synchronous simulation steps
window.__game = G;
G.renderFrame = renderFrame; // lets headless capture render a freecam frame with full post FX
window.__step = (dt = 1 / 60, n = 1) => {
  for (let i = 0; i < n; i++) {
    simNow += dt * 1000;
    last = simNow; // keep rAF ticks from double-stepping
    doRender = i === n - 1;
    step(Math.min(0.05, dt), simNow);
  }
  doRender = true;
  return {
    pos: G.player.pos.toArray().map(v => +v.toFixed(2)),
    mode: G.player.mode, hearts: G.hearts,
    stamina: +G.stamina.toFixed(1), time: +G.time.toFixed(1),
  };
};
