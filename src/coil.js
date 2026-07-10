// The Coil, part one: the ouroboros gates remember.
//
// The two ring emblems on the old roads become the seals of the main quest.
// Their voice deepens with the valley's restoration (the quest director owns
// that phase), and attunement is enacted with the game's own verb — wind.
// Glide through a gate's ring, or plant a zephyr pod so its updraft washes
// through the bronze, and the gate answers. When both gates sing, a great
// standing wind rises at the Coil island and two skybeams mark the way.
//
// This module owns the gate props (world.js no longer places them) and stores
// nothing of its own: all progress lives in G.story.gates via quest events.
import * as THREE from 'three';
import { G } from './state.js';
import { heightAt, toonMat } from './terrain.js';
import {
  spawnSparkle, registerStandSurface, makePuzzleCrate, markSeen, makeChest,
} from './world.js';
import { mergeGeometries } from './BufferGeometryUtils.js';
import { contractInstance, preloadModels } from './assets.js';
import { signalQuestEvent, setStoryFlag } from './quests.js';

const GATES = [
  { id: 'gate.heartfields', x: 97, z: 7, ry: 0.9 },
  { id: 'gate.thornwood', x: -47, z: 203, ry: 2.4 },
];

// the Coil island (world.js ISLANDS[2]) — where the joined wind will stand.
// The old drifting isle at its center becomes the hub of a great stone ring.
const COIL = { x: 50, z: 265, topY: 82 };
const RING_R = 24;        // ring plateau radius
const RING_Y = 88;        // ring walking height
const HEART_Y = 97;       // the ninth-pedestal disc floats over the center
const SLOTS = 14;         // ring is built of this many slabs
const GAP_SLOTS = [3, 4]; // two missing slabs form the Leap
const LIFT_SLOT = 0;      // the gates' joined wind rises to this slab

const RUNE_FLAGS = ['coilRuneCarry', 'coilRuneLeap', 'coilRuneStill'];

const LETTER_PAGES = [
  'To the Ninth, who never came. We waited through the last storm. Aldwyn said you were already here — that the ninth seat was never for a keeper of beacons, but for whoever the valley itself would one day choose to remember it.',
  'So we left the seat empty, and the gates listening. If you are reading this, the wind found you worth carrying. The valley is yours to keep now. Its light was never ours to hold — only to hand on. — Maerwen, Eighth Warden',
];

const MURMURS = {
  dormant: 'Cold bronze. The serpent bites its tail and waits for something the valley no longer has.',
  murmuring: 'The ring hums, almost below hearing. One beacon\'s worth of wind is circling inside it.',
  resonant: 'The hum has become a chord. The gate is listening for the towers, the vaults, the old names.',
  awakened: 'The ring strains toward the sky. It wants the one thing you carry everywhere: moving wind. Give it wind.',
  open: 'The gate sings one long note. Far above the Thornwood, the Coil is answering.',
  quiet: 'The bronze is warm and still. Whatever it guarded has been given back.',
};

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

let built = false;
const gates = []; // {id, x, z, ry, root, mats, swirl, light, baseY, apertureY, apertureR, prevSide, seenToasted}
let coilLiftZone = null;
const skybeams = [];
let appliedKey = '';

function gatePhase() {
  return isObject(G.story) && isObject(G.story.gates) && G.story.gates.phase
    ? G.story.gates.phase : 'dormant';
}

function attunedMap() {
  return isObject(G.story) && isObject(G.story.gates) && isObject(G.story.gates.attuned)
    ? G.story.gates.attuned : {};
}

function attunedCount() {
  return Object.values(attunedMap()).filter(Boolean).length;
}

// procedural stand-in so a failed GLB download never leaves an empty road
function fallbackRing() {
  const root = new THREE.Group();
  const bronze = toonMat({ color: 0x4fa385 });
  const stone = toonMat({ color: 0x8d8577 });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.2, 0.6, 8), stone);
  base.position.y = 0.3;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.35, 0.16, 8, 26), bronze);
  ring.position.y = 2.1;
  root.add(base, ring);
  root.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return { root, mats: {} };
}

function energyMats(mats) {
  const out = [];
  for (const [name, list] of Object.entries(mats || {})) {
    if (/energy/i.test(name)) out.push(...list);
  }
  return out;
}

function buildGate(rec, instance) {
  const inst = instance || fallbackRing();
  const groundY = heightAt(rec.x, rec.z);
  inst.root.position.set(rec.x, groundY + 1.2, rec.z);
  inst.root.rotation.y = rec.ry;
  inst.root.scale.setScalar(1.6);
  G.scene.add(inst.root);
  G.colliders.push({ x: rec.x, z: rec.z, r: 1.0, top: groundY + 1.0 });

  // measure the placed prop so the aperture checks track the real model
  const bb = new THREE.Box3().setFromObject(inst.root);
  const apertureY = (bb.min.y + bb.max.y) / 2 + 0.35; // ring sits above the base stones
  const apertureR = Math.max(0.9, (bb.max.x - bb.min.x) * 0.28);

  // the gate's inner void: a slow additive swirl that wakes with the phase
  const swirl = new THREE.Mesh(
    new THREE.CircleGeometry(apertureR, 26),
    new THREE.MeshBasicMaterial({
      color: 0x9fe8d8, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
  swirl.position.set(rec.x, apertureY, rec.z);
  swirl.rotation.y = rec.ry;
  G.scene.add(swirl);

  const light = new THREE.PointLight(0x9fe8d8, 0, 16, 1.8);
  light.position.set(rec.x, apertureY, rec.z);
  G.scene.add(light);

  Object.assign(rec, {
    root: inst.root, mats: inst.mats || {}, swirl, light,
    baseY: groundY, apertureY, apertureR, prevSide: 0, seenToasted: false,
  });

  G.interactables.push({
    id: rec.id, pos: new THREE.Vector3(rec.x, groundY + 1.4, rec.z), r: 3.6,
    label: 'Listen to the ouroboros gate',
    onUse() { murmur(rec); },
  });
}

function murmur(rec) {
  signalQuestEvent('gate_seen', { id: rec.id });
  const attuned = !!attunedMap()[rec.id];
  const phase = gatePhase();
  const line = attuned ? MURMURS.open : (MURMURS[phase] || MURMURS.dormant);
  if (G.ui) G.ui.dialog('THE OUROBOROS GATE', line, false);
  if (G.audio) {
    if (phase === 'dormant') G.audio.sfx('lock');
    else G.audio.chord([98, 147, 196].map(f => f * (attuned ? 2 : 1)), 0.05, 0.2);
  }
}

function attuneGate(rec, how) {
  if (attunedMap()[rec.id]) return;
  const changed = signalQuestEvent('gate_attuned', { id: rec.id });
  if (!changed) return;
  spawnSparkle(rec.x, rec.apertureY, rec.z, 0x9fe8d8, 44, 5);
  spawnSparkle(rec.x, rec.apertureY + 1.2, rec.z, 0xfff2d8, 20, 3.5);
  G.camShake = (G.camShake || 0) + 0.3;
  if (G.audio) {
    G.audio.sfx('updraft');
    G.audio.chord([196, 261.6, 329.6, 392], 0.11, 0.16);
  }
  const n = attunedCount();
  if (n >= GATES.length) {
    // Progress is world state, not presentation state: unlocking must not
    // depend on whether the HUD happened to be available for the banner.
    signalQuestEvent('coil_unlocked');
    if (G.ui) G.ui.banner('THE GATES REMEMBER', 'A joined wind rises beyond the Thornwood');
  } else if (G.ui) {
    G.ui.toast(how === 'pod'
      ? 'The bottled wind washes the bronze — the gate drinks it and turns.'
      : 'You thread the ring, and the gate wakes around you like a drawn breath.',
      0x9fe8d8, 5200);
  }
}

function slotPos(slot) {
  const a = (slot / SLOTS) * Math.PI * 2;
  return {
    x: COIL.x + Math.cos(a) * RING_R,
    z: COIL.z + Math.sin(a) * RING_R,
    a,
    top: RING_Y + Math.sin(slot * 2.3) * 0.5 + 1.1,
  };
}

function ensureCoilLift() {
  if (coilLiftZone) return;
  // the column stands just outside the ring so the landing slab stays calm
  const lp = slotPos(LIFT_SLOT);
  const a = lp.a;
  const lx = COIL.x + Math.cos(a) * (RING_R + 7.5);
  const lz = COIL.z + Math.sin(a) * (RING_R + 7.5);
  const ground = heightAt(lx, lz);
  coilLiftZone = {
    x: lx, z: lz, r: 4.5,
    bottomY: ground - 0.5, topY: lp.top + 7, strength: 15,
  };
  G.updraftZones.push(coilLiftZone);

  // two quiet skybeams: each gate remembers the road up
  for (const rec of gates) {
    if (!rec.root) continue;
    const from = new THREE.Vector3(rec.x, rec.apertureY, rec.z);
    const to = new THREE.Vector3(lp.x, lp.top + 2, lp.z);
    const len = from.distanceTo(to);
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.55, len, 7, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x9fe8d8, transparent: true, opacity: 0.14,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }));
    beam.position.lerpVectors(from, to, 0.5);
    beam.lookAt(to);
    beam.rotateX(Math.PI / 2);
    G.scene.add(beam);
    skybeams.push(beam);
  }
}

// idempotent visual sync — safe on build, on save-load, and every frame
function applyGateVisuals() {
  const phase = gatePhase();
  const attuned = attunedMap();
  const key = phase + '|' + GATES.map(g => attuned[g.id] ? 1 : 0).join('');
  if (key === appliedKey) return;
  appliedKey = key;
  for (const rec of gates) {
    if (!rec.root) continue;
    const isAttuned = !!attuned[rec.id];
    const glow = energyMats(rec.mats);
    const strength = isAttuned ? 1.4
      : phase === 'awakened' ? 1.0
      : phase === 'resonant' ? 0.55
      : phase === 'murmuring' ? 0.25 : 0.06;
    for (const m of glow) {
      m.emissive.setHex(isAttuned ? 0x39ff88 : 0xff9a3d);
      m.emissiveIntensity = 0.3 + strength;
    }
  }
  if (coilAccessible()) ensureCoilLift();
}

function updateGate(rec, dt) {
  if (!rec.root) return;
  const phase = gatePhase();
  const isAttuned = !!attunedMap()[rec.id];
  const p = G.player ? G.player.pos : null;

  // presentation: the inner void stirs as the valley wakes
  const base = isAttuned ? 0.34 : phase === 'awakened' ? 0.2
    : phase === 'resonant' ? 0.1 : phase === 'murmuring' ? 0.05 : 0;
  rec.swirl.material.opacity = base > 0
    ? base + Math.sin(G.time * (isAttuned ? 2.2 : 1.1) + rec.x) * base * 0.35 : 0;
  rec.swirl.rotation.z += dt * (isAttuned ? 1.6 : 0.4);
  rec.light.intensity = isAttuned ? 1.5 + Math.sin(G.time * 2.1) * 0.3
    : phase === 'awakened' ? 0.7 : 0;

  if (!p) return;
  const dx = p.x - rec.x, dz = p.z - rec.z;
  const d2 = dx * dx + dz * dz;

  // first close approach: the gate notices you noticing it
  if (!rec.seenToasted && d2 < 100) {
    rec.seenToasted = true;
    const first = signalQuestEvent('gate_seen', { id: rec.id });
    if (first && G.ui) {
      G.ui.toast('An ouroboros gate — the bronze serpent hums as you pass.', 0x9fe8d8, 4600);
    }
  }

  if (isAttuned || phase !== 'awakened') { rec.prevSide = 0; return; }

  // wind offering one: carry your own wind through the ring — a glide or a
  // leap both count. Landing transitions can outrun the crossing test by a
  // frame, so recent airtime still counts as airborne.
  if (G.player.mode === 'glide' || G.player.mode === 'air') rec.airAt = G.time;
  const airborne = rec.airAt !== undefined && G.time - rec.airAt < 0.4;
  const nx = Math.sin(rec.ry), nz = Math.cos(rec.ry); // gate plane normal
  const side = Math.sign(dx * nx + dz * nz) || 0;
  const inPlaneR = Math.abs(dx * nz - dz * nx);
  const dy = (p.y + 1.0) - rec.apertureY;
  if (airborne && rec.prevSide !== 0 && side !== 0 && side !== rec.prevSide &&
      d2 < 16 && inPlaneR < rec.apertureR + 0.7 && Math.abs(dy) < 2.4) {
    attuneGate(rec, 'glide');
  }
  // dead-center crossings read side 0 for a frame; keep the last real side
  if (side !== 0) rec.prevSide = d2 < 36 ? side : 0;

  // wind offering two: a zephyr pod's column washing through the ring
  for (const zone of G.updraftZones) {
    if (zone.expires === undefined) continue;
    const zd = Math.hypot(zone.x - rec.x, zone.z - rec.z);
    if (zd < 5) { attuneGate(rec, 'pod'); break; }
  }
}

// ------------------------------------------------------------ warden echoes
// Each statue at the heart names the place its warden kept. Read a name, and
// on clear nights an amber echo stands at that place, still keeping it.
// Stand with all eight and a star kindles ("The Eight Names" deed).

const WARDEN_EPITAPHS = [
  { x: 60, z: -80, line: 'THE FIRST kept the plateau light. Where the first beacon answers, she watched the old road for travelers who never came.' },
  { x: 110, z: 20, line: 'THE SECOND kept the watchers. From the Heartfields tower he counted every wing that crossed the valley, and forgot none.' },
  { x: -150, z: 118, line: 'THE THIRD kept the Mirrormere. She walked the shore when the lanterns were young, and the lake held her reflection kindly.' },
  { x: 78, z: 196, line: 'THE FOURTH kept the gold trees of Thornwood, and named each falling leaf before it landed.' },
  { x: -27, z: 281, line: 'THE FIFTH kept the great horn. The bellows still hold the shape of her breath.' },
  { x: -104, z: -232, line: 'THE SIXTH kept the Stormridge crystals, and sang to them on the cold nights so they would not dim.' },
  { x: 109, z: 120, line: 'THE SEVENTH kept the eastern vault, and the construct that kneels beside it. They were, in the end, friends.' },
  { x: -150, z: -100, line: 'THE EIGHTH kept the western vault. Maerwen, who wrote the letter. She waited the longest.' },
];

const WARDEN_MEETINGS = [
  'The echo turns from the beacon to look at you. It does not speak. It bows, the way one warden greets another.',
  'The echo is counting something far above. It pauses, marks you on its unseen ledger, and seems glad of the entry.',
  'The echo stands where the water meets the stones. For a moment there are two reflections in the Mirrormere, and both are yours.',
  'A gold leaf falls through the echo. It watches the leaf land, then looks at you, as if to say: that one was named for you.',
  'The echo rests a hand on the old horn. The bellows sighs — one soft note, held for a hundred years, finally let go.',
  'The echo hums, too low to hear. The nearest crystal brightens all the same. It has not forgotten the song.',
  'The echo kneels beside the kneeling construct, and for one breath the amber light and the storm-green seams pulse together.',
  'Maerwen\'s echo holds an unsent letter. She looks at you a long time. Then the letter is gone, and her hands are folded, and she is smiling.',
];

const echoes = []; // {index, group, mat, glow, it, y}

function buildEchoSites() {
  for (let i = 0; i < WARDEN_EPITAPHS.length; i++) {
    const site = WARDEN_EPITAPHS[i];
    const y = heightAt(site.x, site.z);
    const group = makeGhost();
    group.position.set(site.x, y, site.z);
    G.scene.add(group);
    const glow = makeRuneGlow();
    glow.material.color.setHex(0xffc27a);
    glow.position.y = 1.1;
    group.add(glow);
    const rec = { index: i, group, mat: group.userData.mat, glow, y };
    const it = {
      id: `warden_echo_${i}`,
      pos: new THREE.Vector3(site.x, y + 1, site.z), r: 3.2,
      label: 'Stand with the echo',
      onUse() { meetEcho(rec); },
    };
    rec.it = it;
    G.interactables.push(it);
    echoes.push(rec);
  }
}

function echoVisible(rec) {
  const night = G.dayTime < 0.21 || G.dayTime > 0.79;
  return night && flag(`wardenName_${rec.index}`) && !flag(`wardenMet_${rec.index}`);
}

function meetEcho(rec) {
  if (!echoVisible(rec)) {
    if (G.ui) G.ui.dialog('A KEPT PLACE',
      'Nothing stands here now. But the grass is pressed, as if someone keeps returning.', false);
    return;
  }
  setStoryFlag(`wardenMet_${rec.index}`, true);
  if (G.ui) G.ui.dialog('A WARDEN\'S ECHO', WARDEN_MEETINGS[rec.index], false);
  spawnSparkle(rec.group.position.x, rec.y + 1.4, rec.group.position.z, 0xffc27a, 34, 4);
  if (G.audio) G.audio.chord([293.66 * Math.pow(1.122, rec.index), 440], 0.08, 0.5);
  const met = WARDEN_EPITAPHS.reduce((n, _, i) => n + (flag(`wardenMet_${i}`) ? 1 : 0), 0);
  if (G.ui && met < WARDEN_EPITAPHS.length) {
    G.ui.toast(`The echo settles — ${met} of ${WARDEN_EPITAPHS.length} wardens stood with.`, 0xffc27a, 4600);
  }
}

function updateEchoes(dt) {
  for (const rec of echoes) {
    const target = echoVisible(rec) ? 0.3 : 0;
    rec.mat.opacity += (target - rec.mat.opacity) * Math.min(1, dt * 1.5);
    rec.glow.material.opacity = rec.mat.opacity * 0.9;
    if (rec.mat.opacity > 0.02 && G.player) {
      rec.group.rotation.y = Math.atan2(
        G.player.pos.x - rec.group.position.x, G.player.pos.z - rec.group.position.z);
    }
  }
}

// ============================================================ the Coil island
// A great stone ring in the sky above the old drifting isle. Three stations —
// a carried crate, a leap across the broken arc, a climb into the still air —
// light three wind-runes; together they raise the center wind to the heart,
// where eight warden statues circle one empty pedestal.

const island = {
  builtProps: false,
  runes: [],          // {flag, mesh, coreMat, glow, applied}
  plate: null,        // the Carry pressure plate {x, z, top, mesh}
  crate: null,        // the Carry crate (lives in world.js grabbable physics)
  crateHome: null,
  vent: null,         // the Leap's sleeping vent {x, z, y, readyAt}
  statues: [],        // 8 contract instances (lantern hearts glow in sequence)
  pedestal: null,     // the ninth pedestal record {root, interactable}
  ghosts: [],         // 8 amber silhouettes for the reveal
  heartLift: null,
  entered: false,
  reveal: { state: 'idle', t: 0, page: 0 },
  flares: [],         // beacon-answer pillars during the stinger
  appliedProgress: '',
};

const flag = id => !!(isObject(G.story) && isObject(G.story.flags) && G.story.flags[id]);
const runeCount = () => RUNE_FLAGS.reduce((n, id) => n + (flag(id) ? 1 : 0), 0);
const coilAccessible = () => attunedCount() >= GATES.length || flag('coilUnlocked') ||
  flag('coilCompleted') || flag('finaleCompleted');

function grassTopMat() { return toonMat({ color: 0x6dbb4d }); }

function buildRingGeometry() {
  const stoneGeos = [];
  const grassGeos = [];
  const push = (list, geo, x, y, z, ry = 0) => {
    geo.rotateY(ry);
    geo.translate(x, y, z);
    list.push(geo);
  };
  for (let i = 0; i < SLOTS; i++) {
    if (GAP_SLOTS.includes(i)) continue;
    const sp = slotPos(i);
    const slabTop = sp.top;
    push(stoneGeos, new THREE.CylinderGeometry(4.3, 3.4, 2.2, 9),
      sp.x, slabTop - 1.35, sp.z, sp.a);
    push(grassGeos, new THREE.CylinderGeometry(4.42, 4.3, 0.28, 9),
      sp.x, slabTop - 0.14, sp.z, sp.a);
    // a hanging root-shard beneath every other slab
    if (i % 2 === 0) {
      const shard = new THREE.ConeGeometry(1.5, 4.5 + (i % 3), 5);
      shard.rotateX(Math.PI);
      push(stoneGeos, shard, sp.x + Math.sin(i) * 1.2, slabTop - 4.6, sp.z + Math.cos(i) * 1.2);
    }
    G.colliders.push({ x: sp.x, z: sp.z, r: 4.35, top: slabTop, soft: true });
    registerStandSurface({ x: sp.x, z: sp.z, r: 4.35, top: slabTop });
  }
  // the heart disc over the center
  push(stoneGeos, new THREE.CylinderGeometry(6.1, 4.6, 1.8, 10), COIL.x, HEART_Y - 1.1, COIL.z);
  push(grassGeos, new THREE.CylinderGeometry(6.25, 6.1, 0.26, 10), COIL.x, HEART_Y - 0.13, COIL.z);
  const heartShard = new THREE.ConeGeometry(2.6, 7, 6);
  heartShard.rotateX(Math.PI);
  push(stoneGeos, heartShard, COIL.x, HEART_Y - 5.4, COIL.z);
  G.colliders.push({ x: COIL.x, z: COIL.z, r: 6.1, top: HEART_Y, soft: true });
  registerStandSurface({ x: COIL.x, z: COIL.z, r: 6.1, top: HEART_Y });

  const stone = new THREE.Mesh(mergeGeometries(stoneGeos), toonMat({ color: 0xa29886 }));
  const grass = new THREE.Mesh(mergeGeometries(grassGeos), grassTopMat());
  stone.castShadow = grass.castShadow = true;
  stone.receiveShadow = grass.receiveShadow = true;
  G.scene.add(stone, grass);
}

function makeRune(flagId, x, z, y, label) {
  const root = new THREE.Group();
  root.position.set(x, y, z);
  const stone = new THREE.Mesh(new THREE.BoxGeometry(0.55, 1.7, 0.34), toonMat({ color: 0x8d8577 }));
  stone.position.y = 0.85;
  stone.rotation.y = Math.atan2(COIL.x - x, COIL.z - z);
  stone.castShadow = true;
  const coreMat = new THREE.MeshBasicMaterial({ color: 0x2f4a41 });
  const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.14), coreMat);
  core.position.set(0, 1.15, 0);
  const glow = makeRuneGlow();
  glow.position.y = 1.15;
  root.add(stone, core, glow);
  G.scene.add(root);
  G.colliders.push({ x, z, r: 0.4, top: y + 1.7 });
  const rec = { flag: flagId, root, coreMat, glow, applied: null };
  island.runes.push(rec);
  G.interactables.push({
    id: flagId, pos: new THREE.Vector3(x, y + 1.1, z), r: 2.8, label,
    onUse() { touchRune(rec); },
  });
  return rec;
}

function makeRuneGlow() {
  const mat = new THREE.SpriteMaterial({
    map: glowTexture(), color: 0x9fffc8, transparent: true, opacity: 0.03,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.setScalar(1.9);
  return sprite;
}

let glowTex = null;
function glowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 31);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

function touchRune(rec) {
  if (!coilAccessible()) {
    if (G.ui) G.ui.dialog('A SILENT WIND-RUNE',
      'The mark is cold. Whatever wakes this place must begin with the twin gates below.', false);
    if (G.audio) G.audio.sfx('lock');
    return;
  }
  if (rec.flag === 'coilRuneCarry') {
    // the Carry rune answers the plate, not the hand
    if (!flag(rec.flag)) {
      if (G.ui) G.ui.dialog('WIND-RUNE OF BURDENS',
        'The rune is waiting for weight it did not have to carry itself. Something rests wrong nearby.', false);
      if (G.audio) G.audio.sfx('lock');
      return;
    }
  }
  if (flag(rec.flag)) {
    if (G.ui) G.ui.dialog('WIND-RUNE', 'It holds its note, steady as a kept promise.', false);
    return;
  }
  lightRune(rec.flag);
}

function lightRune(flagId) {
  if (!coilAccessible() || flag(flagId)) return;
  setStoryFlag(flagId, true);
  const rec = island.runes.find(r => r.flag === flagId);
  if (rec) {
    spawnSparkle(rec.root.position.x, rec.root.position.y + 1.4, rec.root.position.z,
      0x9fffc8, 30, 4);
  }
  if (G.audio) G.audio.chord([392, 523.25, 659.25].map(f => f * (0.8 + runeCount() * 0.1)), 0.09, 0.14);
  const n = runeCount();
  if (G.ui) {
    if (n >= RUNE_FLAGS.length) {
      G.ui.banner('THE COIL TURNS', 'A pillar of wind rises to the heart');
    } else {
      G.ui.toast(`A wind-rune wakes — ${n} of ${RUNE_FLAGS.length}. The ring hums a fuller chord.`, 0x9fffc8, 4600);
    }
  }
}

function buildStations() {
  // the Carry: a rune plate on one slab, its crate two slabs away
  const plateSlot = slotPos(7);
  const plateMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(1.25, 1.4, 0.16, 10),
    toonMat({ color: 0x7d8a80 }));
  plateMesh.position.set(plateSlot.x, plateSlot.top + 0.08, plateSlot.z);
  plateMesh.receiveShadow = true;
  G.scene.add(plateMesh);
  island.plate = { x: plateSlot.x, z: plateSlot.z, top: plateSlot.top, mesh: plateMesh };
  makeRune('coilRuneCarry', plateSlot.x + 2.6, plateSlot.z + 1.2, plateSlot.top,
    'Read the wind-rune of burdens');
  const crateSlot = slotPos(9);
  island.crateHome = { x: crateSlot.x + 1.2, y: crateSlot.top, z: crateSlot.z - 0.8 };
  island.crate = makePuzzleCrate(island.crateHome.x, island.crateHome.y, island.crateHome.z);

  // the Leap: a sleeping vent before the broken arc, its rune beyond
  const ventSlot = slotPos(2);
  const ventMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.9, 1.15, 0.5, 8),
    toonMat({ color: 0x8d8577 }));
  ventMesh.position.set(ventSlot.x, ventSlot.top + 0.25, ventSlot.z);
  ventMesh.castShadow = true;
  G.scene.add(ventMesh);
  island.vent = { x: ventSlot.x, z: ventSlot.z, y: ventSlot.top, readyAt: 0 };
  G.interactables.push({
    id: 'coil_vent', pos: new THREE.Vector3(ventSlot.x, ventSlot.top + 0.6, ventSlot.z),
    r: 2.6, label: 'Rouse the sleeping vent',
    onUse() { rouseVent(); },
  });
  const leapSlot = slotPos(5);
  makeRune('coilRuneLeap', leapSlot.x, leapSlot.z, leapSlot.top, 'Touch the wind-rune of the leap');

  // the Still: a climb into quieter air
  const towerSlot = slotPos(12);
  const tower = new THREE.Mesh(new THREE.BoxGeometry(3.1, 9, 3.1), toonMat({ color: 0x9b9384 }));
  tower.position.set(towerSlot.x, towerSlot.top + 4.5, towerSlot.z);
  tower.castShadow = tower.receiveShadow = true;
  G.scene.add(tower);
  G.climbMeshes.push(tower);
  G.colliders.push({ x: towerSlot.x, z: towerSlot.z, r: 2.1, top: towerSlot.top + 9 });
  registerStandSurface({ x: towerSlot.x, z: towerSlot.z, r: 2.1, top: towerSlot.top + 9 });
  makeRune('coilRuneStill', towerSlot.x + 0.9, towerSlot.z - 0.9, towerSlot.top + 9,
    'Touch the wind-rune of still air');
  // the highest honest climb in the game keeps the quietest prize
  makeChest('chest.coil-tower-hush', towerSlot.x - 0.9, towerSlot.top + 9, towerSlot.z + 0.9,
    0.8, { kind: 'hushbell' });
}

function rouseVent() {
  if (!coilAccessible()) {
    if (G.ui) G.ui.toast('No joined wind answers. The twin gates are still silent.', 0xcccccc);
    if (G.audio) G.audio.sfx('lock');
    return;
  }
  const v = island.vent;
  if (!v || G.time < v.readyAt) {
    if (G.ui) G.ui.toast('The vent is still drawing breath...', 0xcccccc);
    return;
  }
  v.readyAt = G.time + 26;
  const gapA = ((GAP_SLOTS[0] + GAP_SLOTS[1]) / 2 / SLOTS) * Math.PI * 2;
  const gx = COIL.x + Math.cos(gapA) * RING_R;
  const gz = COIL.z + Math.sin(gapA) * RING_R;
  G.updraftZones.push({
    x: gx, z: gz, r: 4.5, bottomY: RING_Y - 34, topY: RING_Y + 13,
    strength: 15, expires: G.time + 20,
  });
  spawnSparkle(gx, RING_Y + 2, gz, 0xd6e8b8, 26, 5);
  if (G.audio) G.audio.sfx('updraft');
  if (G.ui) G.ui.toast('Wind roars up through the broken arc — leap!', 0xbfe8ff, 4200);
}

function placeHeartProps() {
  if (island.builtProps) return;
  island.builtProps = true;
  const ninthAngle = Math.PI / 2; // the empty seat faces the old isle's rising wind
  for (let i = 0; i < 9; i++) {
    const a = ninthAngle + (i / 9) * Math.PI * 2;
    const px = COIL.x + Math.cos(a) * 4.3;
    const pz = COIL.z + Math.sin(a) * 4.3;
    if (i === 0) {
      const inst = contractInstance('ninth_pedestal');
      const root = inst ? inst.root : fallbackPedestal();
      root.position.set(px, HEART_Y, pz);
      root.rotation.y = a + Math.PI / 2;
      G.scene.add(root);
      G.colliders.push({ x: px, z: pz, r: 0.55, top: HEART_Y + 1.0 });
      const interactable = {
        id: 'ninth_pedestal', pos: new THREE.Vector3(px, HEART_Y + 1, pz), r: 3,
        label: 'Stand before the empty pedestal',
        onUse() { usePedestal(); },
      };
      G.interactables.push(interactable);
      island.pedestal = { root, interactable, x: px, z: pz, mats: inst ? inst.mats : {} };
    } else {
      const inst = contractInstance('warden_statue');
      const root = inst ? inst.root : fallbackStatue();
      root.position.set(px, HEART_Y, pz);
      root.rotation.y = a + Math.PI / 2; // each warden faces the empty seat's circle
      root.scale.setScalar(0.92 + (i % 3) * 0.05);
      G.scene.add(root);
      G.colliders.push({ x: px, z: pz, r: 0.5, top: HEART_Y + 1.2 });
      island.statues.push({ root, mats: inst ? inst.mats : {}, index: i - 1 });

      // read a warden's name, and its echo begins keeping its place at night
      const statueIndex = i - 1;
      G.interactables.push({
        id: `warden_statue_${statueIndex}`,
        pos: new THREE.Vector3(px, HEART_Y + 1.1, pz), r: 2.6,
        label: 'Read the warden\'s name',
        onUse() {
          const first = !flag(`wardenName_${statueIndex}`);
          if (first) setStoryFlag(`wardenName_${statueIndex}`, true);
          if (G.ui) {
            G.ui.dialog('THE PEDESTAL READS', WARDEN_EPITAPHS[statueIndex].line, false);
            if (first && !flag(`wardenMet_${statueIndex}`)) {
              G.ui.toast('On a clear night, that place will not be empty.', 0xffc27a, 4600);
            }
          }
          if (G.audio) G.audio.sfx('lock');
        },
      });

      // an amber silhouette waits, unseen, beside each statue
      const ghost = makeGhost();
      ghost.position.set(px + Math.cos(a) * 0.9, HEART_Y, pz + Math.sin(a) * 0.9);
      G.scene.add(ghost);
      island.ghosts.push(ghost);
    }
  }
}

function fallbackPedestal() {
  const root = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.58, 0.95, 9),
    toonMat({ color: 0x8d8577 }));
  base.position.y = 0.48;
  base.castShadow = true;
  root.add(base);
  return root;
}

function fallbackStatue() {
  const root = new THREE.Group();
  const robe = new THREE.Mesh(new THREE.ConeGeometry(0.4, 1.8, 8), toonMat({ color: 0xbcb3a0 }));
  robe.position.y = 0.9;
  robe.castShadow = true;
  root.add(robe);
  return root;
}

function makeGhost() {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffc27a, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const robe = new THREE.Mesh(new THREE.ConeGeometry(0.34, 1.6, 8), mat);
  robe.position.y = 0.8;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), mat);
  head.position.y = 1.75;
  group.add(robe, head);
  group.userData.mat = mat;
  return group;
}

function ensureHeartLift() {
  if (island.heartLift) return;
  // rises from the old isle's rim BESIDE the heart disc, not through it —
  // the pedestal circle must stay still air for the reveal
  island.heartLift = {
    x: COIL.x + 8.5, z: COIL.z, r: 3.6,
    bottomY: COIL.topY - 1, topY: HEART_Y + 5, strength: 15,
  };
  G.updraftZones.push(island.heartLift);
}

function usePedestal() {
  const r = island.reveal;
  if (flag('coilCompleted')) {
    if (G.ui) G.ui.dialog('THE NINTH PEDESTAL',
      'The seat is no longer empty. It never really was.', false);
    return;
  }
  if (!coilAccessible() || runeCount() < RUNE_FLAGS.length) {
    if (G.ui) G.ui.dialog('THE NINTH PEDESTAL',
      'The empty seat keeps its silence. Three wind-runes around the Coil have not yet joined their voices.', false);
    if (G.audio) G.audio.sfx('lock');
    return;
  }
  if (r.state === 'idle') {
    r.state = 'tone';
    r.t = 0;
    island.pedestal.interactable.label = 'Listen';
    if (G.audio) G.audio.chord([98, 196], 0.14, 2.2);
    if (G.ui) G.ui.toast('The wind goes very still.', 0xffe9c0, 3600);
    return;
  }
  if (r.state === 'letter') {
    const page = LETTER_PAGES[r.page];
    const hasMore = r.page < LETTER_PAGES.length - 1;
    if (G.ui) G.ui.dialog('A WIND-WORN LETTER', page, hasMore);
    if (!hasMore) completeCoil();
    else r.page++;
  }
}

function completeCoil() {
  if (!coilAccessible() || runeCount() < RUNE_FLAGS.length || flag('coilCompleted')) return;
  if (!G.items.sigil) {
    G.items.sigil = 1;
    markSeen('sigil');
  }
  signalQuestEvent('coil_completed');
  island.pedestal.interactable.label = 'Remember the ninth warden';
  spawnSparkle(island.pedestal.x, HEART_Y + 1.4, island.pedestal.z, 0x9fffc8, 48, 5);
  if (G.audio) G.audio.chord([261.6, 329.6, 392, 523.3, 659.3], 0.12, 0.3);
  if (G.ui) G.ui.banner('THE NINTH WARDEN', 'The valley chose. The wind agrees.');
  // the stinger: far below, every beacon you woke answers in turn
  let delay = 2.2;
  for (const s of G.shrines) {
    if (!s || !s.active) continue;
    island.flares.push({ x: s.x, z: s.z, at: G.time + delay, mesh: null, t: 0 });
    delay += 0.65;
  }
  island.flares.push({ storm: true, at: G.time + delay + 1.6, mesh: null, t: 0 });
}

function updateReveal(dt) {
  const r = island.reveal;
  // A reloaded completed Coil starts at the module-default 'idle' with ghosts
  // rebuilt invisible; promote straight to the standing vigil so the faint
  // presence is restored (the live reveal sets coilCompleted only in 'letter',
  // never 'idle', so this cannot skip the first-time sequence).
  if (r.state === 'idle' && flag('coilCompleted')) r.state = 'done';
  if (r.state === 'done') {
    // the vigil dims to a faint standing presence
    for (const ghost of island.ghosts) {
      ghost.userData.mat.opacity = Math.max(0.06, ghost.userData.mat.opacity - dt * 0.05);
    }
    return;
  }
  if (r.state === 'idle') return;
  r.t += dt;
  if (r.state === 'tone') {
    // eight lanterns kindle; eight amber figures stand beside their statues
    const step = 0.9;
    for (let i = 0; i < island.ghosts.length; i++) {
      const wake = i * step + 1.2;
      if (r.t > wake) {
        const k = Math.min(1, (r.t - wake) / 1.4);
        island.ghosts[i].userData.mat.opacity = 0.34 * k;
        if (r.t - dt <= wake && G.audio) {
          G.audio.chord([293.66 * Math.pow(1.122, i)], 0.05, 0.4);
        }
      }
    }
    // the figures turn toward the wayfarer
    if (G.player) {
      for (const ghost of island.ghosts) {
        ghost.rotation.y = Math.atan2(
          G.player.pos.x - ghost.position.x, G.player.pos.z - ghost.position.z);
      }
    }
    if (r.t > island.ghosts.length * step + 3) {
      r.state = 'letterfall';
      r.t = 0;
    }
  } else if (r.state === 'letterfall') {
    if (!r.letter) {
      r.letter = new THREE.Mesh(
        new THREE.PlaneGeometry(0.42, 0.58),
        new THREE.MeshBasicMaterial({
          color: 0xf4ecd2, transparent: true, opacity: 0.95, side: THREE.DoubleSide,
        }));
      G.scene.add(r.letter);
    }
    const k = Math.min(1, r.t / 3.2);
    const sway = Math.sin(r.t * 2.6) * 0.5 * (1 - k);
    r.letter.position.set(
      island.pedestal.x + sway, HEART_Y + 1.05 + (1 - k) * 7, island.pedestal.z + Math.cos(r.t * 1.9) * 0.3 * (1 - k));
    r.letter.rotation.set(-Math.PI / 2 * k, sway, r.t * (1 - k) * 1.5);
    if (k >= 1) {
      r.state = 'letter';
      island.pedestal.interactable.label = 'Read the wind-worn letter';
      spawnSparkle(island.pedestal.x, HEART_Y + 1.2, island.pedestal.z, 0xf4ecd2, 16, 2.5);
      if (G.audio) G.audio.sfx('glimmer');
    }
  }
  // ghosts hold their vigil through the reading, then slowly dim (see 'done')
  if (flag('coilCompleted')) r.state = 'done';
}

function updateFlares(dt) {
  for (let i = island.flares.length - 1; i >= 0; i--) {
    const f = island.flares[i];
    if (G.time < f.at) continue;
    if (f.storm) {
      if (G.ui) {
        G.ui.toast('Far to the south, the hundred-year storm begins to uncoil.', 0xffa09a, 6200);
      }
      island.flares.splice(i, 1);
      continue;
    }
    if (!f.mesh) {
      f.mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(0.9, 1.6, 130, 7, 1, true),
        new THREE.MeshBasicMaterial({
          color: 0xffc27a, transparent: true, opacity: 0.35,
          blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
        }));
      f.mesh.position.set(f.x, heightAt(f.x, f.z) + 60, f.z);
      G.scene.add(f.mesh);
      if (G.audio) G.audio.chord([523.25, 659.25], 0.05, 0.2);
    }
    f.t += dt;
    f.mesh.material.opacity = 0.35 * Math.max(0, 1 - f.t / 4.5);
    if (f.t > 4.5) {
      G.scene.remove(f.mesh);
      island.flares.splice(i, 1);
    }
  }
}

function updateIslandProgress() {
  const accessible = coilAccessible();
  const key = RUNE_FLAGS.map(id => flag(id) ? 1 : 0).join('') +
    '|' + (flag('coilCompleted') ? 1 : 0) + '|' + (accessible ? 1 : 0);
  if (key !== island.appliedProgress) {
    island.appliedProgress = key;
    for (const rec of island.runes) {
      const lit = flag(rec.flag);
      if (rec.applied !== lit) {
        rec.applied = lit;
        rec.coreMat.color.setHex(lit ? 0xc8ffe4 : 0x2f4a41);
      }
    }
    if (accessible && (runeCount() >= RUNE_FLAGS.length || flag('coilCompleted'))) ensureHeartLift();
    if (flag('coilCompleted') && island.pedestal) {
      island.pedestal.interactable.label = 'Remember the ninth warden';
    }
  }
  for (let i = 0; i < island.runes.length; i++) {
    const rec = island.runes[i];
    rec.glow.material.opacity = flag(rec.flag)
      ? 0.5 + Math.sin(G.time * 1.7 + i * 2.1) * 0.12 : 0.03;
  }
}

function updateIsland(dt) {
  updateIslandProgress();
  // Geometry remains visible as a distant landmark, but no arrival, puzzle,
  // wind, or reveal state may advance until the gates create the joined lift.
  if (!coilAccessible()) return;
  updateReveal(dt);
  updateFlares(dt);
  const p = G.player ? G.player.pos : null;
  if (!p) return;
  const dx = p.x - COIL.x, dz = p.z - COIL.z;
  const dist = Math.hypot(dx, dz);

  // arrival: the first footfall on the ring names the place
  if (!island.entered && p.y > RING_Y - 2.5 && dist < RING_R + 6) {
    island.entered = true;
    const first = signalQuestEvent('coil_entered');
    if (first && G.ui) G.ui.banner('THE COIL', 'Eight kept the valley. One seat stands empty.');
  }

  // the coil wind: a steady turning stream over the ring band
  if (p.y > RING_Y - 5 && Math.abs(dist - RING_R) < 8 && dist > 1) {
    const tx = -dz / dist, tz = dx / dist; // counterclockwise stream
    const v = G.player.vel;
    const along = v.x * tx + v.z * tz;
    if (along < 2.4) {
      v.x += tx * 5 * dt;
      v.z += tz * 5 * dt;
    }
  }

  // the Carry: the plate listens for the crate's weight
  if (island.plate && island.crate && !flag('coilRuneCarry')) {
    const c = island.crate.position;
    if (Math.hypot(c.x - island.plate.x, c.z - island.plate.z) < 1.25 &&
        Math.abs(c.y - 0.8 - island.plate.top) < 0.9 &&
        G.player.held !== island.crate) {
      lightRune('coilRuneCarry');
    }
  }
  // a crate lost over the edge finds its way home
  if (island.crate && island.crate.position.y < RING_Y - 30 &&
      G.player.held !== island.crate) {
    island.crate.position.set(island.crateHome.x, island.crateHome.y + 0.8, island.crateHome.z);
    island.crate.userData.vy = 0;
    island.crate.userData.floorY = island.crateHome.y + 0.8;
  }
}

export function buildCoil() {
  if (built) return true;
  if (!G.scene || !Array.isArray(G.interactables)) return false;
  built = true;
  for (const spec of GATES) gates.push({ ...spec });
  buildRingGeometry();
  buildStations();
  buildEchoSites();
  preloadModels(['ouroboros_ring', 'warden_statue', 'ninth_pedestal']).then(() => {
    for (const rec of gates) buildGate(rec, contractInstance('ouroboros_ring'));
    placeHeartProps();
    appliedKey = ''; // force a visual sync now that the props exist
  }).catch(() => {
    for (const rec of gates) buildGate(rec, null);
    placeHeartProps();
    appliedKey = '';
  });
  return true;
}

export function updateCoil(dt = 0) {
  if (!built && !buildCoil()) return;
  const step = Math.min(Number.isFinite(dt) && dt > 0 ? dt : 0, 0.05);
  applyGateVisuals();
  for (const rec of gates) updateGate(rec, step);
  updateIsland(step);
  updateEchoes(step);
}

export function getCoilSummary() {
  return {
    phase: gatePhase(),
    attuned: { ...attunedMap() },
    liftActive: !!coilLiftZone,
    gates: gates.map(rec => ({ id: rec.id, x: rec.x, z: rec.z, built: !!rec.root })),
    runes: RUNE_FLAGS.map(id => flag(id)),
    reveal: { state: island.reveal.state, t: +island.reveal.t.toFixed(2), page: island.reveal.page },
    ghosts: island.ghosts.map(g => +g.userData.mat.opacity.toFixed(3)),
    heartLift: !!island.heartLift,
  };
}
