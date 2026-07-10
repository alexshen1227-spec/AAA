// The Coiled Storm — the finale, part two of the main quest.
//
// After the Coil names the player the ninth warden, the hundred-year storm
// manifests in the southern wilds. The approach is fought with the valley's
// own gifts (lulls, vents, a checkpoint shrine of still air); the eye is a
// spiral of the storm's own updrafts; and the ending is enacted with wind:
// setting the Warden's Sigil ignites a final ouroboros ring, and only a full
// glided circuit — the serpent closing its own loop — stills the storm.
//
// Everything here reconstructs from story flags (coilCompleted, stormLull,
// sigilSet, finaleCompleted): saves made mid-approach, mid-eye, or mid-ring
// rebuild cleanly with no duplicate props or zones.
import * as THREE from 'three';
import { G, save } from './state.js';
import { heightAt, toonMat } from './terrain.js';
import { spawnSparkle, registerStandSurface } from './world.js';
import { requestWeather } from './sky.js';
import { bars } from './opening.js';
import { contractInstance, preloadModels, propInstance } from './assets.js';
import { signalQuestEvent, setStoryFlag } from './quests.js';

const STORM = { x: 0, z: 360 };
const WALL_R = 90;   // the storm's reach: headwind grows toward the wall
const EYE_R = 12;    // dead-still air inside
const HEART_Y = 105; // the standing disc below the dark core
const CORE_Y = HEART_Y + 6;
const RING_BAND = { inner: 8, outer: 22, halfHeight: 9 };
const LULL = { x: 0, z: 315 };

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const flag = id => !!(isObject(G.story) && isObject(G.story.flags) && G.story.flags[id]);

let built = false;
let storm = null;   // { group, layers[], shaft, light, flickerAt, zones[], vents[] }
let heart = null;   // { disc, core, debris[], ring, socketIt }
let isle = null;
let lull = null;
let weatherHeld = false;
let debrisMeshes = null; // map-wide sky-debris, collected once for the amber answer
const circuit = { lastA: null, acc: 0 };
const stilling = { on: false, t: 0 };
const credits = { on: false, t: 0, shot: -1, el: null, prevSkip: false, queuedAt: 0 };
let ninthStar = null;
let starBeam = null;      // the star's faint lean toward something unfound
let starBeamNextAt = 0;
let starBeamTarget = null;

const stormActive = () => flag('coilCompleted') && !flag('finaleCompleted');

// ---------------------------------------------------------------- the storm

function cloudMat(opacity) {
  return new THREE.MeshBasicMaterial({
    color: 0x232c38, transparent: true, opacity,
    depthWrite: false, side: THREE.DoubleSide,
  });
}

function buildStorm() {
  if (storm) return;
  const groundY = heightAt(STORM.x, STORM.z);
  const group = new THREE.Group();
  group.position.set(STORM.x, 0, STORM.z);

  // three slow-turning cloud strata — cones opened like a coiled shell
  const layers = [];
  const specs = [
    { r: 74, y: 62, h: 26, op: 0.30, spin: 0.06 },
    { r: 60, y: 88, h: 22, op: 0.26, spin: -0.045 },
    { r: 44, y: 112, h: 18, op: 0.22, spin: 0.03 },
  ];
  for (const s of specs) {
    const mesh = new THREE.Mesh(
      new THREE.ConeGeometry(s.r, s.h, 18, 1, true), cloudMat(s.op));
    mesh.position.y = s.y;
    mesh.rotation.x = Math.PI; // opens downward, a hanging coil
    mesh.userData.spin = s.spin;
    mesh.userData.baseOp = s.op;
    mesh.userData.baseY = s.y;
    group.add(mesh);
    layers.push(mesh);
  }
  // the dark shaft to the ground
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(16, 26, 130, 16, 1, true), cloudMat(0.16));
  shaft.position.y = groundY + 62;
  group.add(shaft);

  const light = new THREE.PointLight(0xbfd8ff, 0, 220, 1.4);
  light.position.set(0, 84, 0);
  group.add(light);

  G.scene.add(group);
  storm = { group, layers, shaft, light, flickerAt: 0, zones: [], vents: [] };

  // the eye's spiral: four of the storm's own winds, stepping upward
  const colSpecs = [
    [0, groundY - 0.5, 35], [Math.PI / 2, 30, 60],
    [Math.PI, 55, 85], [Math.PI * 1.5, 80, 110],
  ];
  for (const [a, lo, hi] of colSpecs) {
    const zone = {
      x: STORM.x + Math.cos(a) * 8, z: STORM.z + Math.sin(a) * 8,
      r: 4, bottomY: lo, topY: hi, strength: 15,
    };
    G.updraftZones.push(zone);
    storm.zones.push(zone);
  }

  buildHeart();
  buildLullShrine();
}

function buildHeart() {
  const disc = new THREE.Mesh(
    new THREE.CylinderGeometry(5, 3.6, 1.6, 10), toonMat({ color: 0x9b9384 }));
  disc.position.set(STORM.x, HEART_Y - 0.9, STORM.z);
  disc.castShadow = disc.receiveShadow = true;
  G.scene.add(disc);
  G.colliders.push({ x: STORM.x, z: STORM.z, r: 5, top: HEART_Y, soft: true });
  registerStandSurface({ x: STORM.x, z: STORM.z, r: 5, top: HEART_Y });

  const core = new THREE.Mesh(
    new THREE.IcosahedronGeometry(2.1, 1),
    new THREE.MeshBasicMaterial({ color: 0x10141c }));
  core.position.set(STORM.x, CORE_Y, STORM.z);
  G.scene.add(core);

  // a ring of storm-shrapnel orbiting the core
  const debris = [];
  const place = () => {
    for (let i = 0; i < 6; i++) {
      const inst = contractInstance('sky_debris');
      const root = inst ? inst.root : new THREE.Mesh(
        new THREE.BoxGeometry(1.4, 1.0, 1.1), toonMat({ color: 0x777b86 }));
      root.scale.setScalar(0.55);
      root.userData.orbitA = (i / 6) * Math.PI * 2;
      G.scene.add(root);
      debris.push(root);
    }
  };
  preloadModels(['sky_debris']).then(place).catch(place);

  // the final ouroboros: dark until the sigil is set
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(15, 0.5, 8, 42),
    new THREE.MeshBasicMaterial({
      color: 0x9fffc8, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
  ring.position.set(STORM.x, CORE_Y, STORM.z);
  ring.rotation.x = Math.PI / 2 - 0.12;
  G.scene.add(ring);

  const socketIt = {
    id: 'storm_heart_socket',
    pos: new THREE.Vector3(STORM.x + 2.4, HEART_Y + 1.2, STORM.z), r: 3.4,
    label: 'Set the Warden\'s Sigil',
    onUse() { setSigil(); },
  };
  G.interactables.push(socketIt);
  heart = { disc, core, debris, ring, socketIt };
  applySigilState();
}

function buildLullShrine() {
  const y = heightAt(LULL.x, LULL.z);
  const stone = toonMat({ color: 0x9b9384 });
  const g = new THREE.Group();
  g.position.set(LULL.x, y, LULL.z);
  for (const sx of [-1.6, 1.6]) {
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.7, 3.4, 0.7), stone);
    pillar.position.set(sx, 1.7, 0);
    pillar.castShadow = true;
    g.add(pillar);
  }
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.6, 0.9), stone);
  lintel.position.y = 3.5;
  lintel.castShadow = true;
  g.add(lintel);
  const glow = new THREE.PointLight(0xbfe8ff, 0.8, 12, 1.8);
  glow.position.y = 2.6;
  g.add(glow);
  G.scene.add(g);
  G.colliders.push({ x: LULL.x - 1.6, z: LULL.z, r: 0.5, top: y + 3.4 });
  G.colliders.push({ x: LULL.x + 1.6, z: LULL.z, r: 0.5, top: y + 3.4 });
  lull = { group: g, y, reached: flag('stormLull') };

  // two sleeping vents on the road in: hops forward between gusts
  for (const [vx, vz] of [[-6, 336], [5, 350]]) {
    const vy = heightAt(vx, vz);
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.85, 1.1, 0.5, 8), toonMat({ color: 0x8d8577 }));
    mesh.position.set(vx, vy + 0.25, vz);
    mesh.castShadow = true;
    G.scene.add(mesh);
    const vent = { x: vx, z: vz, y: vy, readyAt: 0 };
    storm.vents.push(vent);
    G.interactables.push({
      id: `storm_vent_${vx}`, pos: new THREE.Vector3(vx, vy + 0.6, vz), r: 2.6,
      label: 'Rouse the sleeping vent',
      onUse() {
        if (G.time < vent.readyAt) {
          if (G.ui) G.ui.toast('The vent is still drawing breath...', 0xcccccc);
          return;
        }
        vent.readyAt = G.time + 24;
        G.updraftZones.push({
          x: vent.x, z: vent.z, r: 4, bottomY: vent.y - 0.5, topY: vent.y + 26,
          strength: 15, expires: G.time + 14,
        });
        spawnSparkle(vent.x, vent.y + 1.5, vent.z, 0xd6e8b8, 22, 4);
        if (G.audio) G.audio.sfx('updraft');
        if (G.ui) G.ui.toast('A vent wakes — ride it south while the gust rests!', 0xbfe8ff, 4200);
      },
    });
  }
}

// ------------------------------------------------------------ sigil & ring

function setSigil() {
  if (flag('sigilSet')) {
    if (G.ui) G.ui.dialog('THE STORM HEART',
      'The sigil is set. The green ring waits for a rider to close the circle.', false);
    return;
  }
  if (!(Number(G.items.sigil) > 0)) {
    if (G.ui) G.ui.dialog('THE STORM HEART',
      'A socket in the shape of a serpent eating its tail. Something from the Coil belongs here.', false);
    if (G.audio) G.audio.sfx('lock');
    return;
  }
  G.items.sigil -= 1;
  setStoryFlag('sigilSet', true);
  applySigilState();
  spawnSparkle(STORM.x, CORE_Y, STORM.z, 0x9fffc8, 52, 6);
  if (G.audio) {
    G.audio.sfx('updraft');
    G.audio.chord([196, 261.6, 329.6], 0.12, 0.25);
  }
  if (G.ui) {
    G.ui.banner('THE LAST OUROBOROS', 'Ride the turning wind. Close the circle.');
  }
  save();
}

function applySigilState() {
  if (!heart) return;
  const litRing = flag('sigilSet');
  heart.ring.material.opacity = litRing ? 0.5 : 0;
  heart.socketIt.label = litRing ? 'The set sigil' : 'Set the Warden\'s Sigil';
}

function updateCircuit(dt) {
  if (!flag('sigilSet') || stilling.on || flag('finaleCompleted')) return;
  const p = G.player.pos;
  const dx = p.x - STORM.x, dz = p.z - STORM.z;
  const dist = Math.hypot(dx, dz);
  const inBand = dist > RING_BAND.inner && dist < RING_BAND.outer &&
    Math.abs(p.y - CORE_Y) < RING_BAND.halfHeight &&
    (G.player.mode === 'glide' || G.player.mode === 'air');

  // the storm's own rotation carries the rider — a strong turning stream
  if (inBand) {
    const tx = -dz / dist, tz = dx / dist;
    const v = G.player.vel;
    const along = v.x * tx + v.z * tz;
    if (along < 7) { v.x += tx * 14 * dt; v.z += tz * 14 * dt; }
    const a = Math.atan2(dz, dx);
    if (circuit.lastA !== null) {
      let d = a - circuit.lastA;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      if (d > 0) circuit.acc += d; // only with the wind — the serpent turns one way
    }
    circuit.lastA = a;
    if (circuit.acc >= Math.PI * 2) beginStilling();
  } else {
    circuit.lastA = null;
    circuit.acc = Math.max(0, circuit.acc - dt * 0.35); // forgiving, not punishing
  }
}

// ------------------------------------------------------------- the stilling

function collectDebrisMeshes() {
  if (debrisMeshes) return debrisMeshes;
  debrisMeshes = [];
  G.scene.traverse(o => {
    if (o.isMesh && /^Debris_/.test(o.name || '') && o.material && o.material.emissive) {
      debrisMeshes.push(o);
    }
  });
  return debrisMeshes;
}

function beginStilling() {
  if (stilling.on) return;
  stilling.on = true;
  stilling.t = 0;
  if (G.audio) G.audio.chord([261.6, 329.6, 392, 523.3], 0.14, 0.5);
  if (G.ui) G.ui.banner('THE CIRCLE CLOSES', 'A hundred years of held breath, released');
}

function updateStilling(dt) {
  if (!stilling.on) return;
  const t = (stilling.t += dt);
  if (storm) {
    for (const layer of storm.layers) {
      const k = Math.min(1, t / 18);
      layer.userData.spin *= (1 - dt * 0.15);
      layer.position.y = layer.userData.baseY + k * 55;
      layer.material.opacity = layer.userData.baseOp * (1 - k);
    }
    storm.shaft.material.opacity = 0.16 * Math.max(0, 1 - t / 10);
    storm.light.intensity = 0;
  }
  requestWeather('clear');
  // the valley answers: every piece of fallen sky remembers its storm
  if (t > 5 && t < 14) {
    for (const m of collectDebrisMeshes()) {
      const pulse = Math.sin((t - 5) / 9 * Math.PI);
      m.material.emissive.setHex(0xff9a3d);
      m.material.emissiveIntensity = 0.8 * pulse;
    }
  } else if (t >= 14 && debrisMeshes) {
    for (const m of debrisMeshes) m.material.emissiveIntensity = 0;
  }
  if (t >= 20) finishStilling();
}

function finishStilling() {
  stilling.on = false;
  removeStorm();
  signalQuestEvent('finale_completed');
  requestWeather(null);
  buildIsle();
  if (G.ui) G.ui.banner('THE STORM IS STILL', 'The valley of Aerwyn — kept');
  if (G.audio) G.audio.chord([261.6, 329.6, 392, 523.3, 659.3, 784], 0.16, 0.8);
  save();
  credits.queuedAt = G.time + 7; // the wind gathers itself, then remembers
}

function removeStorm() {
  if (storm) {
    G.scene.remove(storm.group);
    for (const zone of storm.zones) {
      const i = G.updraftZones.indexOf(zone);
      if (i >= 0) G.updraftZones.splice(i, 1);
    }
    storm = null;
  }
  if (heart) {
    heart.socketIt.gone = true;
    G.scene.remove(heart.core, heart.ring);
    for (const d of heart.debris) G.scene.remove(d);
    // the disc remains — it becomes the serene isle's foundation
  }
}

// ------------------------------------------------------------ the serene isle

function buildIsle() {
  if (isle) return;
  const g = new THREE.Group();
  g.position.set(STORM.x, HEART_Y, STORM.z);
  const grass = new THREE.Mesh(
    new THREE.CylinderGeometry(6.1, 4.2, 1.7, 10), toonMat({ color: 0x6dbb4d }));
  grass.position.y = -0.85;
  grass.receiveShadow = true;
  g.add(grass);
  const tree = propInstance('pk_pine_tall') || (() => {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, 1.6, 7),
      toonMat({ color: 0x7a5230 }));
    trunk.position.y = 0.8;
    const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(1.0, 1),
      toonMat({ color: 0x5cae43 }));
    crown.position.y = 2.0;
    const t = new THREE.Group();
    t.add(trunk, crown);
    return t;
  })();
  tree.position.set(-2.2, 0, 1.4);
  tree.scale.setScalar(0.9);
  g.add(tree);
  G.scene.add(g);
  G.colliders.push({ x: STORM.x, z: STORM.z, r: 5.8, top: HEART_Y, soft: true });
  registerStandSurface({ x: STORM.x, z: STORM.z, r: 5.8, top: HEART_Y });
  // a standing wind so the isle can always be revisited
  G.updraftZones.push({
    x: STORM.x + 11, z: STORM.z, r: 4,
    bottomY: heightAt(STORM.x + 11, STORM.z) - 0.5, topY: HEART_Y + 6, strength: 15,
  });
  G.interactables.push({
    id: 'serene_isle_rest', pos: new THREE.Vector3(STORM.x - 2.2, HEART_Y + 1, STORM.z + 1.4),
    r: 3.2, label: 'Rest, and remember',
    onUse() {
      if (G.ui) G.ui.dialog('THE NINTH WARDEN',
        'The wind moves through the branches, unhurried. It has nowhere it needs to be — and neither, for a while, do you.', false);
      credits.queuedAt = G.time + 4; // sitting a moment, the valley replays itself
    },
  });
  isle = { group: g };
  ensureNinthStar();
}

// ----------------------------------------------------- the credits: remember

// One new star, brighter than the rest, low in the southern sky. It is not
// labeled and never explained: the star is the name.
function ensureNinthStar() {
  if (ninthStar || !flag('finaleCompleted')) return;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(32, 32, 1, 32, 32, 31);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,244,214,0.8)');
  grad.addColorStop(1, 'rgba(255,244,214,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  ninthStar = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(c), transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  ninthStar.scale.setScalar(26);
  ninthStar.position.set(120, 560, 900); // low over the stilled south
  G.scene.add(ninthStar);
}

const CREDIT_SHOTS = [
  {
    dur: 8, from: [45, 26, -60], to: [45, 14, -74], look: [45, 6, -86],
    text: () => 'THE WILDS OF AERWYN',
  },
  {
    dur: 8, from: [48, 22, -66], to: [56, 16, -74], look: [60, 10, -84],
    text: () => `${G.shrines.filter(s => s.active).length} beacons — burning`,
  },
  {
    dur: 9, from: [-120, 24, 96], to: [-146, 12, 108], look: [-170, 2, 120],
    text: () => {
      const letters = Object.keys(G.lore).filter(k => /^let/.test(k) && G.lore[k]).length;
      const deeds = Object.keys(G.deeds).filter(k => G.deeds[k]).length;
      return `${Math.max(1, G.dayCount + 1)} days wandered · ${G.glimmers} glimmers befriended` +
        ` · ${letters} letters carried · ${deeds} deeds written in stars`;
    },
  },
  {
    dur: 9, from: [12, 108, 232], to: [26, 100, 244], look: [50, 96, 265],
    text: () => 'The valley of Aerwyn — kept',
  },
  {
    dur: 12, night: true, from: [40, 30, 60], to: [40, 42, 66], look: [120, 560, 900],
    text: () => '',
  },
];

function creditsTextEl() {
  if (credits.el) return credits.el;
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;left:0;right:0;bottom:16vh;text-align:center;' +
    'font:600 19px Cinzel,Georgia;letter-spacing:4px;color:#e9dcb8;z-index:52;' +
    'text-shadow:0 2px 14px rgba(0,0,0,.75);opacity:0;transition:opacity 1.6s ease;' +
    'pointer-events:none;padding:0 8vw;';
  document.body.appendChild(el);
  credits.el = el;
  return el;
}

function startCredits() {
  if (credits.on) return;
  credits.on = true;
  credits.t = 0;
  credits.shot = -1;
  credits.prevSkip = !!G.keys['Space'];
  credits.dayTimeBefore = G.dayTime;
  G.cinematic = true;
  bars(true);
  if (G.audio) G.audio.chord([196, 261.6, 329.6, 392], 0.1, 1.2);
}

function endCredits() {
  if (!credits.on) return;
  credits.on = false;
  G.cinematic = false;
  bars(false);
  if (credits.el) credits.el.style.opacity = '0';
  if (Number.isFinite(credits.dayTimeBefore)) G.dayTime = credits.dayTimeBefore;
  if (ninthStar) ninthStar.material.opacity = 0;
  G.keys._spaceLatch = true;
  if (G.player) G.player.snapCameraNextFrame();
  setStoryFlag('creditsSeen', true);
}

function updateCredits(dt) {
  if (!credits.on) {
    if (credits.queuedAt && G.time >= credits.queuedAt && flag('finaleCompleted')) {
      credits.queuedAt = 0;
      startCredits();
    }
    return;
  }
  // a fresh Space press leaves the memory early
  const skipDown = !!G.keys['Space'];
  if (skipDown && !credits.prevSkip) { endCredits(); return; }
  credits.prevSkip = skipDown;

  // suppress play input under the letterbox
  for (const k in G.keys) { if (k !== 'Space') G.keys[k] = false; }
  G.keys._spaceLatch = true;
  G.mouse.dx = G.mouse.dy = 0;

  credits.t += dt;
  let t = credits.t;
  let idx = 0;
  while (idx < CREDIT_SHOTS.length && t > CREDIT_SHOTS[idx].dur) {
    t -= CREDIT_SHOTS[idx].dur;
    idx++;
  }
  if (idx >= CREDIT_SHOTS.length) { endCredits(); return; }
  const shot = CREDIT_SHOTS[idx];
  if (idx !== credits.shot) {
    credits.shot = idx;
    const el = creditsTextEl();
    el.style.opacity = '0';
    const line = shot.text();
    setTimeout(() => {
      if (!credits.on || credits.shot !== idx) return;
      el.textContent = line;
      el.style.opacity = line ? '1' : '0';
    }, 700);
    if (shot.night) G.dayTime = 0.92; // the last memory is the night sky
  }
  const k = Math.min(1, t / shot.dur);
  const e = k * k * (3 - 2 * k);
  const cam = G.camera;
  cam.position.set(
    shot.from[0] + (shot.to[0] - shot.from[0]) * e,
    shot.from[1] + (shot.to[1] - shot.from[1]) * e,
    shot.from[2] + (shot.to[2] - shot.from[2]) * e);
  cam.lookAt(shot.look[0], shot.look[1], shot.look[2]);

  // the last shot: one new star kindles, then the three words
  if (shot.night && ninthStar) {
    const wake = Math.max(0, (t - 4) / 4);
    ninthStar.material.opacity = Math.min(1, wake);
    if (t > 8.5 && credits.el && credits.el.textContent !== 'The wind remembers.') {
      credits.el.textContent = 'The wind remembers.';
      credits.el.style.opacity = '1';
      if (G.audio) G.audio.chord([523.25, 659.25, 783.99], 0.08, 0.9);
    }
  }
}

// ----------------------------------------------------------------- update

function updateStormPresence(dt) {
  if (!storm) return;
  const cam = G.camera;
  const dx = cam.position.x - STORM.x, dz = cam.position.z - STORM.z;
  const camDist = Math.hypot(dx, dz);

  // strata turn; far away, only two layers render (fill-rate mercy)
  for (let i = 0; i < storm.layers.length; i++) {
    const layer = storm.layers[i];
    layer.rotation.y += layer.userData.spin * dt;
    layer.visible = !(camDist > 260 && i === 1);
  }
  // lightning flicker
  if (G.time > storm.flickerAt) {
    storm.flickerAt = G.time + 2 + Math.random() * 5;
    storm.light.intensity = 2.6;
  }
  storm.light.intensity = Math.max(0, storm.light.intensity - dt * 6);

  if (heart) {
    for (const d of heart.debris) {
      d.userData.orbitA += dt * 0.35;
      d.position.set(
        STORM.x + Math.cos(d.userData.orbitA) * 10,
        CORE_Y + Math.sin(d.userData.orbitA * 2.3) * 1.4,
        STORM.z + Math.sin(d.userData.orbitA) * 10);
      d.rotation.y += dt * 0.8;
    }
    heart.ring.rotation.z += dt * 0.4;
    if (flag('sigilSet') && !flag('finaleCompleted')) {
      heart.ring.material.opacity = 0.42 + Math.sin(G.time * 2.4) * 0.14;
    }
  }
}

function updateApproach(dt) {
  const p = G.player.pos;
  const dx = p.x - STORM.x, dz = p.z - STORM.z;
  const dist = Math.hypot(dx, dz);
  const inside = dist < WALL_R;

  // hold the sky in storm while the player walks the wall; release outside
  const shouldHold = inside && !stilling.on;
  if (shouldHold && !weatherHeld) { requestWeather('storm'); weatherHeld = true; }
  if (!shouldHold && weatherHeld) { requestWeather(null); weatherHeld = false; }

  if (!inside) return;

  // the lull shrine: a pocket of still air, and the road's one checkpoint
  const nearLull = Math.hypot(p.x - LULL.x, p.z - LULL.z) < 8;
  if (nearLull && lull && !lull.reached) {
    lull.reached = true;
    setStoryFlag('stormLull', true);
    G.respawn = { x: LULL.x, y: lull.y, z: LULL.z };
    spawnSparkle(LULL.x, lull.y + 2.5, LULL.z, 0xbfe8ff, 30, 4);
    if (G.ui) G.ui.toast('Still air under the old arch. The wind will carry you back here.', 0xbfe8ff, 5200);
    if (G.audio) G.audio.sfx('glimmer');
    save();
  }

  if (dist < EYE_R) {
    // the eye: dead still, and the storm's breath cushions every fall
    if (G.player.vel.y < -8) G.player.vel.y = -8;
    return;
  }
  if (nearLull) return;

  // headwind: radial push outward, growing toward the wall
  const k = Math.min(1, (dist - EYE_R) / (WALL_R - EYE_R));
  const push = 6.5 * k * (flag('sigilSet') ? 0.4 : 1);
  G.player.vel.x += (dx / dist) * push * dt;
  G.player.vel.z += (dz / dist) * push * dt;
}

export function updateFinale(dt = 0) {
  if (!G.scene || !G.player) return;
  const step = Math.min(Number.isFinite(dt) && dt > 0 ? dt : 0, 0.05);
  if (!built) {
    built = true;
    // reconstruct whatever the flags say should exist
    if (flag('finaleCompleted')) buildIsle();
  }
  if (stormActive() && !storm && !stilling.on) buildStorm();
  if (storm) {
    updateStormPresence(step);
    updateApproach(step);
    updateCircuit(step);
    updateStilling(step);
  }
  if (ninthStar && !credits.on) {
    // faint but findable on any clear night, forever
    const night = G.dayTime < 0.21 || G.dayTime > 0.79;
    ninthStar.material.opacity = night ? 0.85 : 0;
    updateStarBeam(night);
  }
  updateCredits(step);
}

// The Ninth Star Points: on clear nights the star leans a faint beam toward
// the nearest thing still unfound — the valley remembering its warden back.
// No UI, no text; wordless post-game wander fuel.
function nearestUnfound() {
  const p = G.player.pos;
  let best = null, bestD = Infinity;
  for (const it of G.interactables) {
    if (it.gone || !it.pos) continue;
    if (it.label !== 'Open chest' && it.label !== 'Feel the high wind' &&
        it.label !== 'Stand in the sky') continue;
    const d = (it.pos.x - p.x) ** 2 + (it.pos.z - p.z) ** 2;
    if (d < bestD) { bestD = d; best = it; }
  }
  return best;
}

function updateStarBeam(night) {
  const grim = G.weather ? (G.weather.grim || 0) : 0;
  const shouldShow = night && grim < 0.35 && !!flag('finaleCompleted');
  if (!starBeam) {
    if (!shouldShow) return;
    starBeam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.4, 3.2, 130, 6, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xfff2d8, transparent: true, opacity: 0, fog: false,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }));
    G.scene.add(starBeam);
  }
  if (!shouldShow) { starBeam.material.opacity = 0; return; }
  if (G.time > starBeamNextAt) {
    starBeamNextAt = G.time + 8; // re-aim occasionally, not per frame
    starBeamTarget = nearestUnfound();
  }
  if (!starBeamTarget || starBeamTarget.gone) { starBeam.material.opacity = 0; return; }
  const from = ninthStar.position;
  const to = starBeamTarget.pos;
  // a short lean out of the star, pointing the way — not a map marker
  const dir = new THREE.Vector3(to.x - from.x, to.y - from.y, to.z - from.z).normalize();
  starBeam.position.set(
    from.x + dir.x * 70, from.y + dir.y * 70, from.z + dir.z * 70);
  starBeam.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
  starBeam.material.opacity = 0.10 + Math.sin(G.time * 0.9) * 0.035;
}

export function getFinaleSummary() {
  return {
    stormBuilt: !!storm,
    isleBuilt: !!isle,
    sigilSet: flag('sigilSet'),
    lullReached: !!(lull && lull.reached),
    circuitProgress: +(circuit.acc / (Math.PI * 2)).toFixed(3),
    stilling: { ...stilling },
    weatherHeld,
  };
}
