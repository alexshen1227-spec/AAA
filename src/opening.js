// The Waking — the first minutes as an authored story sequence instead of a
// checklist. Beats: wake beside Maren -> see the fallen sky-ruin -> be sent
// to the first beacon -> the beacon answers and the camera lifts to a sky
// island, revealing the mystery. Letterboxed, skippable, runs once per save.
import * as THREE from 'three';
import { G, save } from './state.js';
import { heightAt, toonMat } from './terrain.js';
import { contractInstance, preloadModels } from './assets.js';
import { spawnSparkle } from './world.js';

let stage = -1, t = 0;
const said = {}; // one-shot dialog flags — timing never depends on frame size
let barTop = null, barBot = null, skipEl = null;
const camFrom = new THREE.Vector3();
const camTo = new THREE.Vector3();
let skipArmed = false, prevSkip = false;
let debrisRoot = null, debrisFallback = null, debrisColliderAdded = false;

function makeDebrisFallback() {
  const g = new THREE.Group();
  const stone = toonMat({ color: 0x777b86 });
  const bronze = toonMat({ color: 0x3d856f });
  for (const [x, y, z, sx, sy, sz, rz] of [
    [-1.2, 0.5, 0.2, 2.5, 0.7, 1.2, 0.25],
    [1.0, 0.7, -0.5, 1.5, 1.0, 1.0, -0.42],
    [0.2, 0.3, 1.0, 1.2, 0.5, 1.8, 0.12],
  ]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), stone);
    m.position.set(x, y, z); m.rotation.set(0.12, rz * 2, rz); m.castShadow = true;
    g.add(m);
  }
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.14, 7, 20), bronze);
  ring.position.set(0.15, 0.65, 0.05); ring.rotation.set(1.1, 0.25, 0.4); ring.castShadow = true;
  g.add(ring);
  return g;
}

function placeDebris(root) {
  root.position.set(30, heightAt(30, -96), -96);
  root.rotation.y = 0.8;
  G.scene.add(root);
}

function ensureOpeningDebris() {
  if (debrisRoot) return;
  const ci = contractInstance('sky_debris');
  debrisRoot = ci ? ci.root : makeDebrisFallback();
  debrisFallback = ci ? null : debrisRoot;
  placeDebris(debrisRoot);
  if (!debrisColliderAdded) {
    debrisColliderAdded = true;
    G.colliders.push({ x: 30, z: -96, r: 2.2, top: heightAt(30, -96) + 1.4 });
  }
  if (!ci) preloadModels(['sky_debris']).then(res => {
    if (!res || !res.sky_debris || debrisRoot !== debrisFallback) return;
    const loaded = contractInstance('sky_debris');
    if (!loaded) return;
    G.scene.remove(debrisRoot);
    debrisRoot = loaded.root;
    debrisFallback = null;
    placeDebris(debrisRoot);
  }).catch(() => { });
}

export function bars(show, showSkip = show) {
  if (!barTop) {
    const mk = (pos) => {
      const d = document.createElement('div');
      d.style.cssText = 'position:fixed;left:0;right:0;height:0;background:#000;' +
        pos + ':0;z-index:50;transition:height .8s ease;pointer-events:none;';
      document.body.appendChild(d);
      return d;
    };
    barTop = mk('top');
    barBot = mk('bottom');
    skipEl = document.createElement('div');
    skipEl.textContent = 'SPACE — skip ▸';
    skipEl.style.cssText = 'position:fixed;right:22px;bottom:16px;z-index:51;' +
      'font:600 12px Cinzel,Georgia;letter-spacing:2px;color:#b8ac8c;display:none;';
    document.body.appendChild(skipEl);
  }
  barTop.style.height = barBot.style.height = show ? '9vh' : '0';
  skipEl.style.display = showSkip ? 'block' : 'none';
  // lift the dialog box clear of the bottom letterbox bar while cinematic
  const dlg = document.getElementById('dialog');
  if (dlg) dlg.style.bottom = show ? '14vh' : '';
}

export function isCinematic() { return stage >= 0 && stage < 3; }

export function initOpening() {
  ensureOpeningDebris();
  if (G.tut.openingDone) return;
  stage = 0; t = 0;
  prevSkip = !!G.keys['Space'];
  skipArmed = !prevSkip;
  G.cinematic = true;
  // wake beside Maren
  const P = G.player;
  P.pos.set(45, heightAt(45, -82), -82);
  P.camYaw = Math.atan2(42 - 45, -84 + 82); // facing the Wayfarer
  P.yaw = P.camYaw;
  bars(true);
}

function say(title, text) { G.ui.dialog(title, text, false); }

export function updateOpening(dt) {
  if (stage < 0) return;
  const P = G.player;
  const cam = G.camera;
  // Skip only on a fresh press. Space may also have started the game, and
  // carrying that same held key into frame one used to erase the whole opening.
  const skipDown = !!G.keys['Space'];
  if (!skipDown) skipArmed = true;
  if (stage < 3 && skipArmed && skipDown && !prevSkip) {
    stage = 3; t = 0; skipArmed = false;
    G.keys._spaceLatch = true; // held skip must not become a jump as control returns
  }
  prevSkip = skipDown;

  if (stage >= 0 && stage < 3) {
    // suppress player input during the letterboxed beats
    for (const k in G.keys) { if (k !== 'Space') G.keys[k] = false; }
    G.keys._spaceLatch = true; // retained skip key can never leak into player jump logic
    G.mouse.dx = G.mouse.dy = 0;
  }

  t += dt;
  if (stage === 0) {
    // slow descent from above the meadow down to the hero and Maren
    const k = Math.min(1, t / 5);
    const e = k * k * (3 - 2 * k);
    camFrom.set(P.pos.x + 10, P.pos.y + 16, P.pos.z + 16);
    camTo.set(P.pos.x + 2.5, P.pos.y + 2.2, P.pos.z + 4);
    cam.position.lerpVectors(camFrom, camTo, e);
    cam.lookAt(P.pos.x, P.pos.y + 1.3, P.pos.z);
    if (t > 1.2 && !said.wake) {
      said.wake = true;
      say('MAREN, THE GREY WAYFARER',
        'Ah — awake at last, wanderer. The storm took your memories, did it? It takes something from all of us.');
    }
    if (t > 6.5) { stage = 1; t = 0; G.ui.dialog('', null); }
  } else if (stage === 1) {
    // pan to the fallen sky-ruin
    const k = Math.min(1, t / 3);
    const e = k * k * (3 - 2 * k);
    camFrom.copy(cam.position);
    camTo.set(38, heightAt(38, -90) + 3.2, -88);
    cam.position.lerp(camTo, Math.min(1, dt * 2));
    const lx = P.pos.x + (30 - P.pos.x) * e, lz = P.pos.z + (-96 - P.pos.z) * e;
    cam.lookAt(lx, heightAt(30, -96) + 1.5, lz);
    if (t > 1.0 && !said.ruin) {
      said.ruin = true;
      say('MAREN, THE GREY WAYFARER',
        'See there — that stone fell from the SKY. More falls each night the beacons stay dark. The old works that hold the islands aloft are failing.');
    }
    if (t > 7) { stage = 2; t = 0; G.ui.dialog('', null); }
  } else if (stage === 2) {
    // turn to the first beacon on the plateau
    const s = G.shrines[0];
    cam.position.lerp(camTo.set(P.pos.x - 4, P.pos.y + 3.5, P.pos.z + 6), Math.min(1, dt * 2));
    cam.lookAt(s.x, s.y + 5, s.z);
    if (t > 1.0 && !said.task) {
      said.task = true;
      say('MAREN, THE GREY WAYFARER',
        'Wake the first beacon — the amber light there, on the plateau. Show the valley it still has a guardian. Then we will speak of the sky.');
    }
    if (t > 6.5) { stage = 3; t = 0; }
  } else if (stage === 3) {
    // control returns; wait for the first beacon
    if (G.cinematic) {
      G.cinematic = false;
      bars(false);
      G.ui.dialog('', null);
      G.ui.toast('Wake the first beacon on the plateau (follow the compass).', 0xffc27a, 5200);
    }
    if (G.shrines[0] && G.shrines[0].active) { stage = 4; t = 0; G.cinematic = true; bars(true); }
  } else if (stage === 4) {
    // the beacon answers: slow orbit, then lift to the sky island
    for (const k in G.keys) G.keys[k] = false;
    G.keys._spaceLatch = true;
    G.mouse.dx = G.mouse.dy = 0;
    const s = G.shrines[0];
    if (t < 3.5) {
      const a = 0.8 + t * 0.35;
      cam.position.set(s.x + Math.sin(a) * 11, s.y + 5.5, s.z + Math.cos(a) * 11);
      cam.lookAt(s.x, s.y + 5, s.z);
      if (t > 0.6 && !said.answer) {
        said.answer = true;
        say('MAREN, THE GREY WAYFARER',
          'The old light answers you! Listen — the sky-works are stirring...');
      }
      if (t > 3.2) G.ui.dialog('', null); // clear before the tilt-up shot
    } else {
      // tilt up to the drifting island
      const k = Math.min(1, (t - 3.5) / 3);
      const e = k * k * (3 - 2 * k);
      cam.position.lerp(camTo.set(s.x - 6, s.y + 4 + e * 3, s.z + 10), Math.min(1, dt * 1.5));
      cam.lookAt(150, 26 + e * 40, 50); // the near sky island, then higher drifters
      if (k > 0.5 && !G.tut.islandLine) {
        G.tut.islandLine = true;
        say('MAREN, THE GREY WAYFARER',
          'Do you see them, wanderer? The islands still wait above the clouds. Wake the beacons, climb the towers — and the wind itself will carry you up.');
      }
      // the wider valley: the beacons are only the beginning of what's here
      if (k >= 1 && t > 6.6 && !G.tut.wideLine) {
        G.tut.wideLine = true;
        say('MAREN, THE GREY WAYFARER',
          'But the valley is more than its old machines. There are people yet, and letters caught on the wind, and quiet things that only wake at night. Do not only wake it, wanderer — WALK it. It has been a long time since anyone was here to see.');
      }
    }
    if (t > 10.5) {
      stage = -1;
      G.cinematic = false;
      bars(false);
      G.ui.dialog('', null);
      G.tut.openingDone = true;
      G.ui.banner('THE WILDS OF AERWYN', 'The valley remembers. The sky is waiting.');
      save();
    }
  }
}
