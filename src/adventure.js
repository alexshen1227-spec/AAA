// Adventure content layer: a wandering road-tinker, the Mirrormere lantern
// story, and three high-country wind chimes.
//
// This file owns its props and NPC presentation, but stores only plain JSON in
// G.worldFlags. It can be built before or after a save is applied: every visual
// reads the live flags in updateAdventure(), and quest events are idempotent.
import * as THREE from 'three';
import { G, save } from './state.js';
import { heightAt, slopeAt, WATER_Y, toonMat } from './terrain.js';
import {
  makeGlow, markSeen, spawnSparkle, spawnHealBloom,
} from './world.js';
import { contractInstance, preloadModels } from './assets.js';
import { signalQuestEvent } from './quests.js';

const FLAGS_VERSION = 1;
const LAKE = { x: -170, z: 120 };
const LANTERN_IDS = [
  'mirror_lantern_east', 'mirror_lantern_south', 'mirror_lantern_west',
  'mirror_lantern_northwest', 'mirror_lantern_north',
];
const CHIME_IDS = ['high_chime_dawn', 'high_chime_gale', 'high_chime_rain'];
const CHIME_NOTES = [293.66, 392.0, 523.25];

const TRADER_OFFERS = Object.freeze([
  {
    id: 'arrow_bundle', name: 'Twelve field arrows', cost: 3, repeatable: true,
    detail: 'Straight shafts, repaired and re-fletched on the road.',
  },
  {
    id: 'zephyr_pod', name: 'One zephyr pod', cost: 5, repeatable: true,
    detail: 'A pocket of rising wind, tied shut with three careful knots.',
  },
  {
    id: 'orchard_wrap', name: 'Three cold apples', cost: 2, repeatable: true,
    detail: 'Wrapped in dock leaves so they survive the long roads.',
  },
  {
    id: 'hearty_mushroom', name: 'One hearty mushroom', cost: 7, repeatable: true,
    detail: 'Rare, filling, and much safer than the red-spotted kind.',
  },
  {
    id: 'rumor_mirror', name: 'A Mirrormere rumor', cost: 1, repeatable: false,
    detail: 'Sella marks a place where five dark lights face the water.',
  },
  {
    id: 'rumor_chimes', name: 'A high-country rumor', cost: 1, repeatable: false,
    detail: 'Sella has heard bronze singing above the cloud line.',
  },
  // the storm ledger: some stock only exists in certain skies
  {
    id: 'storm_glass', name: 'A storm-glass bead', cost: 4, repeatable: true,
    detail: 'Rain pressed hard enough to remember its lightning. Only sets in wet weather.',
    when: () => G.weather && G.weather.wetness > 0.4,
  },
  {
    id: 'crimson_ember', name: 'A crimson-night ember', cost: 2, repeatable: true,
    detail: 'Nobody shops under a bleeding sky, so tonight it goes cheap. Warms to the bone.',
    when: () => !!G.bloodNight,
  },
  {
    id: 'rumor_squalls', name: 'A rumor of stray weather', cost: 1, repeatable: false,
    detail: 'Sella has seen small storms walking the hills like lost sheep.',
    when: () => !!(G.story && G.story.flags && G.story.flags.finaleCompleted),
  },
]);

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const safeTime = () => Number.isFinite(G.time) ? G.time : 0;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

let built = false;
let trader = null;
let lanternKeeper = null;
const shoreLanterns = [];
const summitChimes = [];
let chimeCairn = null;
let lanternLight = null;
let moonPath = null;
let moonLines = null;
let purchaseBusy = false;
let lastPurchase = { id: '', at: -Infinity };
let lastQuestSyncKey = '';

function ensureWorldFlags() {
  // `story` is already a versioned, forward-compatible save root. Keep the
  // adventure flags aliased there so this isolated module persists without a
  // state.js schema edit; after Continue replaces G.story, the next update
  // automatically adopts the loaded adventure object.
  if (isObject(G.story) && isObject(G.story.adventure) &&
      G.worldFlags !== G.story.adventure) {
    G.worldFlags = G.story.adventure;
  }
  if (!isObject(G.worldFlags)) G.worldFlags = {};
  G.worldFlags.version = Math.max(Number(G.worldFlags.version) || 0, FLAGS_VERSION);

  if (!isObject(G.worldFlags.trader)) G.worldFlags.trader = {};
  const tf = G.worldFlags.trader;
  if (!isObject(tf.purchased)) tf.purchased = {};
  if (!isObject(tf.purchaseCounts)) tf.purchaseCounts = {};
  if (!isObject(tf.rumors)) tf.rumors = {};
  if (typeof tf.met !== 'boolean') tf.met = false;

  if (!isObject(G.worldFlags.lanterns)) G.worldFlags.lanterns = {};
  const lf = G.worldFlags.lanterns;
  if (!isObject(lf.lit)) lf.lit = {};
  if (typeof lf.keeperMet !== 'boolean') lf.keeperMet = false;
  if (typeof lf.reported !== 'boolean') lf.reported = false;
  if (typeof lf.rewarded !== 'boolean') lf.rewarded = false;

  if (!isObject(G.worldFlags.chimes)) G.worldFlags.chimes = {};
  const cf = G.worldFlags.chimes;
  if (!isObject(cf.awake)) cf.awake = {};
  if (typeof cf.resolved !== 'boolean') cf.resolved = false;
  if (typeof cf.rewarded !== 'boolean') cf.rewarded = false;
  if (cf.rewarded) cf.resolved = true;
  if (lf.rewarded) lf.reported = true;
  if (isObject(G.story)) G.story.adventure = G.worldFlags;
  return G.worldFlags;
}

function persist() {
  try { save(); } catch (error) { /* storage is best-effort */ }
}

function toast(text, color = 0xffe9a0, ms = 3600) {
  if (G.ui && typeof G.ui.toast === 'function') G.ui.toast(text, color, ms);
}

function dialog(name, text, more = false) {
  if (G.ui && typeof G.ui.dialog === 'function') G.ui.dialog(name, text, more);
}

function sound(name) {
  if (G.audio && typeof G.audio.sfx === 'function') G.audio.sfx(name);
}

function chord(notes, velocity = 0.07, spread = 0.12) {
  if (G.audio && typeof G.audio.chord === 'function') G.audio.chord(notes, velocity, spread);
}

function discover(kind) {
  if (!isObject(G.seen)) G.seen = {};
  if (G.seen[kind]) return;
  if (G.ui) markSeen(kind);
  else G.seen[kind] = true;
}

function nightNow() {
  return G.dayTime < 0.21 || G.dayTime > 0.79;
}

// Finds a nearby dry, gentle point. This runs only during build and keeps all
// authored coordinates resilient to later edits of the analytic terrain.
function safeGroundNear(x, z, options = {}) {
  const radius = options.radius || 36;
  const maxSlope = options.maxSlope === undefined ? 0.48 : options.maxSlope;
  const minY = options.minY === undefined ? WATER_Y + 0.65 : options.minY;
  const maxY = options.maxY === undefined ? Infinity : options.maxY;
  let best = null;
  for (let ring = 0; ring <= 9; ring++) {
    const r = ring === 0 ? 0 : (ring / 9) * radius;
    const samples = ring === 0 ? 1 : 8 + ring * 2;
    for (let i = 0; i < samples; i++) {
      const a = i * 2.399963 + ring * 0.37;
      const px = x + Math.cos(a) * r;
      const pz = z + Math.sin(a) * r;
      if (Math.hypot(px, pz) > 455) continue;
      const y = heightAt(px, pz);
      const slope = slopeAt(px, pz);
      if (y < minY || y > maxY || slope > maxSlope) continue;
      const score = r + slope * 12;
      if (!best || score < best.score) best = { x: px, y, z: pz, score };
    }
    if (best && ring >= 2) break;
  }
  if (best) return best;
  const y = Math.max(minY, heightAt(x, z));
  return { x, y, z, score: Infinity };
}

function shorePoint(angle, ordinal) {
  let best = null;
  const radii = [82, 92, 102, 112, 124, 136];
  for (let ri = 0; ri < radii.length; ri++) {
    for (let ai = -3; ai <= 3; ai++) {
      const a = angle + ai * 0.08;
      const r = radii[(ri + ordinal) % radii.length];
      const x = LAKE.x + Math.cos(a) * r;
      const z = LAKE.z + Math.sin(a) * r;
      const y = heightAt(x, z);
      const slope = slopeAt(x, z);
      if (y < WATER_Y + 0.55 || y > 18 || slope > 0.46) continue;
      const score = Math.abs(y - 2.5) + slope * 8 + ri * 0.08 + Math.abs(ai) * 0.03;
      if (!best || score < best.score) best = { x, y, z, score };
    }
  }
  if (best) return best;
  const r = 118;
  return safeGroundNear(LAKE.x + Math.cos(angle) * r, LAKE.z + Math.sin(angle) * r,
    { radius: 45, maxSlope: 0.5, maxY: 24 });
}

function buildTraderModel() {
  const root = new THREE.Group();
  root.rotation.order = 'YXZ';
  const coat = toonMat({ color: 0x357a73 });
  const coatDark = toonMat({ color: 0x25514f });
  const skin = toonMat({ color: 0xd8ad82 });
  const leather = toonMat({ color: 0x795232 });
  const bronze = toonMat({ color: 0xc58a3b });
  const cloth = toonMat({ color: 0xc98943 });

  const body = new THREE.Mesh(new THREE.ConeGeometry(0.56, 1.45, 8), coat);
  body.position.y = 0.92;
  const shoulders = new THREE.Mesh(new THREE.SphereGeometry(0.43, 8, 6), coatDark);
  shoulders.position.y = 1.42; shoulders.scale.y = 0.65;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.23, 8, 6), skin);
  head.position.y = 1.82;
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.3, 0.14, 8), cloth);
  cap.position.y = 2.04;
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.39, 0.39, 0.045, 10), cloth);
  brim.position.y = 1.98;
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.18, 5), skin);
  nose.rotation.x = Math.PI / 2; nose.position.set(0, 1.8, 0.23);

  // Amber-lensed road goggles make Sella readable at a glance.
  const lensMat = new THREE.MeshBasicMaterial({ color: 0xffc45c });
  for (const sx of [-0.1, 0.1]) {
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.072, 0.072, 0.035, 10), lensMat);
    lens.rotation.x = Math.PI / 2;
    lens.position.set(sx, 1.87, 0.205);
    root.add(lens);
  }
  const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.025, 0.03), bronze);
  bridge.position.set(0, 1.87, 0.22);

  const pack = new THREE.Group();
  pack.position.set(0, 1.18, -0.43);
  const packBox = new THREE.Mesh(new THREE.BoxGeometry(0.78, 1.05, 0.34), leather);
  const rack = new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.08, 0.44), bronze);
  rack.position.y = 0.48;
  pack.add(packBox, rack);
  for (let i = 0; i < 3; i++) {
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 0.25, 7), bronze);
    pot.position.set(-0.28 + i * 0.28, 0.64 + (i % 2) * 0.09, -0.04);
    pack.add(pot);
  }
  const roll = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.82, 8), cloth);
  roll.rotation.z = Math.PI / 2; roll.position.y = -0.55;
  pack.add(roll);

  const limbGeo = new THREE.CylinderGeometry(0.075, 0.09, 0.72, 6);
  limbGeo.translate(0, -0.36, 0);
  const armL = new THREE.Mesh(limbGeo, coatDark);
  const armR = new THREE.Mesh(limbGeo, coatDark);
  armL.position.set(-0.42, 1.45, 0); armR.position.set(0.42, 1.45, 0);
  const legL = new THREE.Mesh(limbGeo, leather);
  const legR = new THREE.Mesh(limbGeo, leather);
  legL.position.set(-0.2, 0.7, 0); legR.position.set(0.2, 0.7, 0);

  const handLamp = new THREE.Group();
  handLamp.position.set(0.55, 0.82, 0.08);
  const lampCage = new THREE.Mesh(new THREE.OctahedronGeometry(0.14), bronze);
  const lampCore = new THREE.Mesh(new THREE.SphereGeometry(0.065, 7, 5), lensMat);
  handLamp.add(lampCage, lampCore);
  const lampGlow = makeGlow(0xffc45c, 1.15);
  handLamp.add(lampGlow);

  root.add(body, shoulders, head, cap, brim, nose, bridge, pack,
    armL, armR, legL, legR, handLamp);
  root.traverse(object => { if (object.isMesh) object.castShadow = true; });
  return { root, body, head, pack, armL, armR, legL, legR, lampGlow };
}

function buildTrader() {
  const routeSeeds = [
    [18, -112], [44, -74], [92, -34], [116, 18],
    [78, 68], [24, 52], [-12, 4], [-8, -62],
  ];
  const route = routeSeeds.map(([x, z]) => safeGroundNear(x, z, { radius: 28, maxY: 34 }));
  const model = buildTraderModel();
  model.root.position.set(route[0].x, route[0].y, route[0].z);
  G.scene.add(model.root);
  const collider = { x: route[0].x, z: route[0].z, r: 0.68, top: route[0].y + 1.5 };
  G.colliders.push(collider);
  const interactable = {
    id: 'npc_sella_vane', pos: model.root.position, r: 3.4,
    label: 'Talk to Sella Vane', onUse: useTrader,
  };
  G.interactables.push(interactable);
  const lamp = new THREE.PointLight(0xffb85c, 0, 13, 1.7);
  G.scene.add(lamp);
  trader = {
    ...model, route, routeIndex: 1, collider, interactable, lamp,
    yaw: 0, moving: false, shopCursor: 0, quoteId: null, quoteUntil: 0,
  };
}

function availableOffers() {
  const flags = ensureWorldFlags().trader;
  return TRADER_OFFERS.filter(offer =>
    (offer.repeatable || !flags.purchased[offer.id]) &&
    (!offer.when || offer.when()));
}

function currentBrowseOffer() {
  const offers = availableOffers();
  if (!offers.length) return null;
  if (trader) trader.shopCursor %= offers.length;
  return offers[trader ? trader.shopCursor : 0];
}

function useTrader() {
  const flags = ensureWorldFlags().trader;
  if (!flags.met) {
    flags.met = true;
    persist();
    dialog('SELLA VANE, ROAD-TINKER',
      'Good boots, empty pack, eyes on the horizon. I know the type. I mend what the wilds break and trade what the roads leave behind. Sky gems spend well here.', true);
    sound('ui_open');
    return;
  }
  const offer = currentBrowseOffer();
  if (!offer) {
    dialog('SELLA VANE, ROAD-TINKER', 'You bought every secret I had. Supplies, though? Roads always make more of those.', false);
    return;
  }
  const now = safeTime();
  if (!trader || trader.quoteId !== offer.id || now > trader.quoteUntil) {
    trader.quoteId = offer.id;
    trader.quoteUntil = now + 10;
    trader.interactable.label = `Buy ${offer.name} - ${offer.cost} gems`;
    dialog('SELLA VANE, ROAD-TINKER',
      `${offer.name}, for ${offer.cost} sky gem${offer.cost === 1 ? '' : 's'}. ${offer.detail} Speak again if the trade suits you.`, true);
    sound('lock');
    return;
  }
  const result = buyTraderOffer(offer.id);
  if (result.ok) {
    trader.quoteId = null;
    trader.shopCursor++;
    trader.interactable.label = 'Browse Sella\'s wares';
  } else if (result.reason === 'gems') {
    dialog('SELLA VANE, ROAD-TINKER', `That one costs ${offer.cost} sky gems. The road teaches patience better than I do.`, false);
  }
}

function applyOfferReward(id) {
  if (id === 'arrow_bundle') {
    if (!G.player) return false;
    G.player.arrows = (Number(G.player.arrows) || 0) + 12;
    discover('arrow');
    toast('Sella counts out twelve field arrows.', 0xf4ecd2);
  } else if (id === 'zephyr_pod') {
    G.items.pod = (Number(G.items.pod) || 0) + 1;
    discover('pod');
    toast('Zephyr Pod added to the satchel.', 0x9fe8d8);
  } else if (id === 'orchard_wrap') {
    G.apples = (Number(G.apples) || 0) + 3;
    if (isObject(G.seen)) G.seen.apple = true;
    toast('Three cold apples, wrapped for the road.', 0xffb6a3);
  } else if (id === 'hearty_mushroom') {
    G.items.mushroom = (Number(G.items.mushroom) || 0) + 1;
    discover('mushroom');
    toast('Hearty Mushroom added to the satchel.', 0xe08a8a);
  } else if (id === 'rumor_mirror') {
    G.worldFlags.trader.rumors.mirror = true;
    dialog('SELLA VANE, ROAD-TINKER',
      'Five lanterns stand dark around Mirrormere. Their keeper waits on the eastern shore. On a clear night, each empty cage points at the same path across the water.', false);
  } else if (id === 'rumor_chimes') {
    G.worldFlags.trader.rumors.chimes = true;
    dialog('SELLA VANE, ROAD-TINKER',
      'Three bronze rings crown three far summits. Reach one and the wind gives it a note. Reach all three and listen again at the cairn in the Heartfields.', false);
  } else if (id === 'storm_glass') {
    G.items.shard = (Number(G.items.shard) || 0) + 1;
    discover('shard');
    toast('The bead hums like far thunder — it will spend as a Star Shard.', 0xbfd8ff);
  } else if (id === 'crimson_ember') {
    G.hearts = G.maxHearts;
    if (G.player) spawnHealBloom(G.player.pos.x, G.player.pos.y, G.player.pos.z);
    toast('The ember\'s warmth pours through you — every heart refilled.', 0xffb6a3);
  } else if (id === 'rumor_squalls') {
    G.worldFlags.trader.rumors.squalls = true;
    dialog('SELLA VANE, ROAD-TINKER',
      'Since the big one went quiet, I have seen little storms walking the hills like lost sheep. There is a stone floating in each one\'s eye, and a mark on the stone. If you can reach it... well. Storms pay their debts.', false);
  } else return false;
  return true;
}

export function getTraderOffers() {
  const flags = ensureWorldFlags().trader;
  return TRADER_OFFERS.map(offer => ({
    ...offer,
    sold: !offer.repeatable && !!flags.purchased[offer.id],
    purchaseCount: Number(flags.purchaseCounts[offer.id]) || 0,
    affordable: (Number(G.gems) || 0) >= offer.cost,
    available: !offer.when || !!offer.when(),
  }));
}

// Safe for both the interaction fallback and a future shop UI. Unique offers
// are persisted before returning, and a short duplicate-call guard prevents a
// double click from charging twice for repeatable supplies.
export function buyTraderOffer(id) {
  ensureWorldFlags();
  const offer = TRADER_OFFERS.find(item => item.id === id);
  if (!offer || purchaseBusy) return { ok: false, reason: offer ? 'busy' : 'unknown' };
  const flags = G.worldFlags.trader;
  if (!offer.repeatable && flags.purchased[id]) return { ok: false, reason: 'sold' };
  // the sky changed while the quote stood — the ledger closes that page
  if (offer.when && !offer.when()) return { ok: false, reason: 'weather' };
  if ((Number(G.gems) || 0) < offer.cost) return { ok: false, reason: 'gems', cost: offer.cost };
  const wallNow = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (lastPurchase.id === id && wallNow - lastPurchase.at < 250) return { ok: false, reason: 'duplicate' };

  purchaseBusy = true;
  try {
    // Apply the reward first only when its runtime dependency exists (arrows
    // need a player); then charge and mark the transaction in one sync turn.
    if (!applyOfferReward(id)) return { ok: false, reason: 'unavailable' };
    G.gems -= offer.cost;
    flags.purchaseCounts[id] = (Number(flags.purchaseCounts[id]) || 0) + 1;
    if (!offer.repeatable) flags.purchased[id] = true;
    lastPurchase = { id, at: wallNow };
    sound('pickup');
    if (trader) spawnSparkle(trader.root.position.x, trader.root.position.y + 1.3,
      trader.root.position.z, 0x9fefff, 12, 2.2);
    persist();
    return { ok: true, offerId: id, gems: G.gems };
  } finally {
    purchaseBusy = false;
  }
}

function buildLanternKeeperModel() {
  const root = new THREE.Group();
  const robe = toonMat({ color: 0x304563 });
  const mantle = toonMat({ color: 0x58799a });
  const skin = toonMat({ color: 0xd5aa83 });
  const silver = toonMat({ color: 0xb8c4cc });
  const wood = toonMat({ color: 0x5c4632 });
  const light = new THREE.MeshBasicMaterial({ color: 0xcfe8ff });
  const skirt = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.55, 8), robe);
  skirt.position.y = 0.78;
  const torso = new THREE.Mesh(new THREE.SphereGeometry(0.34, 8, 6), mantle);
  torso.position.y = 1.4; torso.scale.y = 0.8;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.21, 8, 6), skin);
  head.position.y = 1.78;
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.225, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.62), silver);
  hair.position.y = 1.83;
  const shawl = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.09, 6, 14), mantle);
  shawl.rotation.x = Math.PI / 2; shawl.position.y = 1.55;
  const staff = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.055, 2.05, 6), wood);
  staff.position.set(0.52, 1.02, 0);
  const lantern = new THREE.Mesh(new THREE.OctahedronGeometry(0.18), silver);
  lantern.position.set(0.52, 1.95, 0);
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.08, 7, 5), light);
  core.position.copy(lantern.position);
  const glow = makeGlow(0xcfe8ff, 1.45);
  glow.position.copy(lantern.position);
  root.add(skirt, torso, head, hair, shawl, staff, lantern, core, glow);
  root.traverse(object => { if (object.isMesh) object.castShadow = true; });
  return { root, glow, staff };
}

function buildShoreLantern(id, point, index) {
  const group = new THREE.Group();
  group.position.set(point.x, point.y, point.z);
  const stone = toonMat({ color: 0x8a8790 });
  const bronze = toonMat({ color: 0x4f8b79 });
  const dark = toonMat({ color: 0x39434b });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.56, 0.45, 8), stone);
  base.position.y = 0.22;
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.11, 2.1, 7), bronze);
  post.position.y = 1.36;
  const hook = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.045, 6, 12, Math.PI), bronze);
  hook.rotation.z = Math.PI / 2; hook.position.set(0.25, 2.25, 0);
  const cage = new THREE.Mesh(new THREE.OctahedronGeometry(0.27), dark);
  cage.position.set(0.5, 2.12, 0);
  const coreMat = new THREE.MeshBasicMaterial({ color: 0x26343d });
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.105, 8, 6), coreMat);
  core.position.copy(cage.position);
  const glow = makeGlow(0xbfe6ff, 1.8);
  glow.position.copy(cage.position); glow.material.opacity = 0.02;
  group.add(base, post, hook, cage, core, glow);
  group.rotation.y = Math.atan2(LAKE.x - point.x, LAKE.z - point.z) + index * 0.04;
  group.traverse(object => { if (object.isMesh) object.castShadow = true; });
  G.scene.add(group);
  G.colliders.push({ x: point.x, z: point.z, r: 0.48, top: point.y + 2.35 });
  const rec = { id, group, point, core, coreMat, glow, applied: null };
  const interactable = {
    id, pos: new THREE.Vector3(point.x, point.y + 1.3, point.z), r: 3,
    label: 'Kindle the shore lantern',
    onUse() { kindleLantern(rec); },
  };
  rec.interactable = interactable;
  G.interactables.push(interactable);
  shoreLanterns.push(rec);
}

function kindleLantern(rec) {
  const flags = ensureWorldFlags().lanterns;
  if (flags.lit[rec.id]) {
    dialog('MIRRORMERE LANTERN', 'Its pale flame leans toward the center of the lake, though the wind blows elsewhere.', false);
    sound('lock');
    return;
  }
  flags.lit[rec.id] = true;
  rec.interactable.label = 'Listen to the shore lantern';
  signalQuestEvent('lantern_lit', { id: rec.id });
  spawnSparkle(rec.point.x, rec.point.y + 2.15, rec.point.z, 0xbfe6ff, 28, 3.5);
  chord([220, 293.66, 440], 0.055, 0.11);
  const count = litLanternCount();
  toast(`Mirrormere lantern kindled - ${count} of ${LANTERN_IDS.length}`, 0xbfe6ff, 4200);
  if (count === LANTERN_IDS.length) {
    toast('Five lights turn toward one another. Ilyra will want to see this after moonrise.', 0xffe9c0, 5400);
  }
  persist();
}

function litLanternCount() {
  const lit = ensureWorldFlags().lanterns.lit;
  return LANTERN_IDS.reduce((n, id) => n + (lit[id] ? 1 : 0), 0);
}

function useLanternKeeper() {
  const flags = ensureWorldFlags().lanterns;
  if (!flags.keeperMet) {
    flags.keeperMet = true;
    signalQuestEvent('lantern_keeper_met');
    dialog('ILYRA FEN, LANTERNKEEPER',
      'The lake kept a road of light before the sky broke. Five shore-lanterns remember its shape, but their flames are gone. If you wake them, return when the moon is high.', true);
    sound('ui_open');
    persist();
    return;
  }
  const count = litLanternCount();
  if (count < LANTERN_IDS.length) {
    dialog('ILYRA FEN, LANTERNKEEPER',
      `${count} of the five answer. Follow the shore both ways; each lantern faces water, never road.`, true);
    return;
  }
  if (!nightNow()) {
    dialog('ILYRA FEN, LANTERNKEEPER',
      'All five burn. Come back after moonrise. Some roads are made of stone; this one is made of being seen.', false);
    return;
  }
  completeLanternStory();
}

function completeLanternStory() {
  const flags = ensureWorldFlags().lanterns;
  if (!flags.reported) {
    flags.reported = true;
    signalQuestEvent('lanterns_reported');
  }
  if (!flags.rewarded) {
    flags.rewarded = true; // mark before granting: re-entrant calls cannot duplicate it
    G.gems = (Number(G.gems) || 0) + 5;
    G.items.shard = (Number(G.items.shard) || 0) + 1;
    discover('gem'); discover('shard');
    if (G.player) spawnHealBloom(G.player.pos.x, G.player.pos.y, G.player.pos.z);
    spawnSparkle(lanternKeeper.root.position.x, lanternKeeper.root.position.y + 1.8,
      lanternKeeper.root.position.z, 0xd8ecff, 42, 4.5);
    chord([220, 293.66, 392, 587.33], 0.08, 0.18);
    toast('The lake reveals its old moon-road - 5 sky gems and a Star Shard.', 0xd8ecff, 5600);
  } else {
    dialog('ILYRA FEN, LANTERNKEEPER',
      'There - the silver road. It does not lead away from Aerwyn. It leads deeper into what Aerwyn remembers.', false);
  }
  persist();
}

function buildLanternStory() {
  const angles = [-0.55, 0.2, 1.12, 2.42, -2.42];
  const points = angles.map((angle, index) => shorePoint(angle, index));
  points.forEach((point, index) => buildShoreLantern(LANTERN_IDS[index], point, index));

  const kp = safeGroundNear(points[0].x + 7, points[0].z - 5,
    { radius: 24, maxSlope: 0.42, maxY: 20 });
  const model = buildLanternKeeperModel();
  model.root.position.set(kp.x, kp.y, kp.z);
  model.root.rotation.y = Math.atan2(LAKE.x - kp.x, LAKE.z - kp.z);
  G.scene.add(model.root);
  G.colliders.push({ x: kp.x, z: kp.z, r: 0.62, top: kp.y + 1.5 });
  const interactable = {
    id: 'npc_ilyra_fen', pos: new THREE.Vector3(kp.x, kp.y + 1, kp.z), r: 3.4,
    label: 'Talk to Ilyra Fen', onUse: useLanternKeeper,
  };
  G.interactables.push(interactable);
  lanternKeeper = { ...model, point: kp, interactable };
  G.ilyraRoot = lanternKeeper.root; // (re-pointed if her GLB swaps in later)

  lanternLight = new THREE.PointLight(0xbfe6ff, 0, 24, 1.7);
  G.scene.add(lanternLight);

  moonPath = new THREE.Mesh(
    new THREE.PlaneGeometry(7, 88, 1, 10),
    new THREE.MeshBasicMaterial({
      color: 0xcfe4ff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
  moonPath.rotation.x = -Math.PI / 2;
  moonPath.position.set(LAKE.x, WATER_Y + 0.09, LAKE.z);
  moonPath.visible = false;
  G.scene.add(moonPath);

  const linePos = new Float32Array(points.length * 6);
  points.forEach((point, index) => {
    linePos[index * 6] = point.x;
    linePos[index * 6 + 1] = point.y + 2.12;
    linePos[index * 6 + 2] = point.z;
    linePos[index * 6 + 3] = LAKE.x;
    linePos[index * 6 + 4] = WATER_Y + 0.25;
    linePos[index * 6 + 5] = LAKE.z;
  });
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
  moonLines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({
    color: 0xbfe6ff, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  moonLines.visible = false;
  G.scene.add(moonLines);
}

function findSummits(count) {
  const candidates = [];
  const step = 32;
  for (let x = -416; x <= 416; x += step) {
    for (let z = -416; z <= 416; z += step) {
      const y = heightAt(x, z);
      if (y < 48 || Math.hypot(x, z) > 450) continue;
      if (y < heightAt(x + 12, z) || y < heightAt(x - 12, z) ||
          y < heightAt(x, z + 12) || y < heightAt(x, z - 12)) continue;
      candidates.push({ x, y, z, slope: slopeAt(x, z) });
    }
  }
  candidates.sort((a, b) => (b.y - a.y) || (a.slope - b.slope));
  const chosen = [];
  for (const point of candidates) {
    if (point.slope > 0.55) continue;
    if (chosen.some(other => Math.hypot(point.x - other.x, point.z - other.z) < 150)) continue;
    chosen.push(point);
    if (chosen.length >= count) break;
  }
  const fallbacks = [[-242, 396], [-396, -308], [308, -418]];
  for (const [x, z] of fallbacks) {
    if (chosen.length >= count) break;
    if (chosen.some(other => Math.hypot(x - other.x, z - other.z) < 120)) continue;
    chosen.push({ x, y: heightAt(x, z), z, slope: slopeAt(x, z) });
  }
  return chosen.slice(0, count);
}

function buildSummitChime(id, point, index) {
  const root = new THREE.Group();
  root.position.set(point.x, point.y, point.z);
  root.rotation.y = Math.atan2(-point.x, -point.z);
  const stone = toonMat({ color: 0x8e8b83 });
  const bronze = toonMat({ color: 0x4f907e });
  const bronzeDark = toonMat({ color: 0x315e57 });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(1.35, 1.65, 0.6, 10), stone);
  base.position.y = 0.3;
  const plinth = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 1.0, 0.9, 8), stone);
  plinth.position.y = 0.95;
  const ringHolder = new THREE.Group();
  ringHolder.position.y = 2.65;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.18, 0.13, 8, 28), bronze);
  ringHolder.add(ring);
  const cross = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 2.05, 6), bronzeDark);
  cross.rotation.z = Math.PI / 2; cross.position.y = 1.15;
  root.add(base, plinth, ringHolder, cross);
  const rods = [];
  for (let i = 0; i < 3; i++) {
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.72 + i * 0.13, 7), bronze);
    rod.position.set(-0.38 + i * 0.38, 1.95 - i * 0.06, 0);
    root.add(rod); rods.push(rod);
  }
  const coreMat = new THREE.MeshBasicMaterial({ color: 0x304841 });
  const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.16), coreMat);
  core.position.y = 2.65;
  const glow = makeGlow(0xbfe8d8, 1.55);
  glow.position.y = 2.65; glow.material.opacity = 0.02;
  root.add(core, glow);
  root.traverse(object => { if (object.isMesh) object.castShadow = true; });
  G.scene.add(root);
  G.colliders.push({ x: point.x, z: point.z, r: 1.25, top: point.y + 0.6, soft: true });
  const rec = { id, point, root, ringHolder, ring, rods, core, coreMat, glow, index, applied: null };
  const interactable = {
    id, pos: new THREE.Vector3(point.x, point.y + 1.4, point.z), r: 3.1,
    label: 'Wake the silent chime', onUse() { wakeChime(rec); },
  };
  rec.interactable = interactable;
  G.interactables.push(interactable);
  summitChimes.push(rec);
}

function awakeChimeCount() {
  const awake = ensureWorldFlags().chimes.awake;
  return CHIME_IDS.reduce((n, id) => n + (awake[id] ? 1 : 0), 0);
}

function wakeChime(rec) {
  const flags = ensureWorldFlags().chimes;
  if (flags.awake[rec.id]) {
    chord([CHIME_NOTES[rec.index], CHIME_NOTES[rec.index] * 1.5], 0.05, 0.08);
    dialog('HIGH WIND CHIME', 'Its note travels beyond hearing. Somewhere far away, another ring answers faintly.', false);
    return;
  }
  flags.awake[rec.id] = true;
  rec.interactable.label = 'Listen to the awakened chime';
  signalQuestEvent('wind_chime_found', { id: rec.id });
  spawnSparkle(rec.point.x, rec.point.y + 2.65, rec.point.z, 0xbfe8d8, 34, 4.2);
  chord([CHIME_NOTES[rec.index], CHIME_NOTES[rec.index] * 1.5,
    CHIME_NOTES[rec.index] * 2], 0.075, 0.14);
  const count = awakeChimeCount();
  toast(`A summit chime answers - ${count} of ${CHIME_IDS.length}`, 0xbfe8d8, 4300);
  if (count === CHIME_IDS.length) {
    toast('Three notes cross above the valley. Return to the listening cairn in the Heartfields.', 0xffe9c0, 5600);
  }
  persist();
}

function buildChimeCairn() {
  const point = safeGroundNear(-18, 34, { radius: 34, maxSlope: 0.38, maxY: 25 });
  const root = new THREE.Group();
  root.position.set(point.x, point.y, point.z);
  const stones = new THREE.Group();
  const stone = toonMat({ color: 0x8e8b83 });
  let y = 0;
  for (let i = 0; i < 4; i++) {
    const r = 0.54 - i * 0.09;
    const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 0), stone);
    mesh.scale.y = 0.52;
    mesh.position.set((i % 2 ? 0.08 : -0.06), y + r * 0.32, 0);
    mesh.rotation.y = i * 1.7;
    mesh.castShadow = true;
    stones.add(mesh);
    y += r * 0.52;
  }
  const modelHolder = new THREE.Group();
  const glow = makeGlow(0xbfe8d8, 1.8);
  glow.position.y = 1.15; glow.material.opacity = 0.08;
  root.add(stones, modelHolder, glow);
  G.scene.add(root);
  G.colliders.push({ x: point.x, z: point.z, r: 0.58, top: point.y + 1.2 });
  const interactable = {
    id: 'chime_listening_cairn', pos: new THREE.Vector3(point.x, point.y + 0.8, point.z),
    r: 3, label: 'Listen at the weathered cairn', onUse: resolveChimes,
  };
  G.interactables.push(interactable);
  chimeCairn = { point, root, stones, modelHolder, glow, interactable };
}

function resolveChimes() {
  const flags = ensureWorldFlags().chimes;
  const count = awakeChimeCount();
  if (count < CHIME_IDS.length) {
    dialog('THE LISTENING CAIRN',
      `${count === 0 ? 'No note has found this place yet.' : `${count} note${count === 1 ? '' : 's'} circle the stones.`} The chord is still waiting.`, false);
    sound('lock');
    return;
  }
  if (!flags.resolved) {
    flags.resolved = true;
    signalQuestEvent('wind_chimes_resolved');
  }
  if (!flags.rewarded) {
    flags.rewarded = true;
    G.items.pod = (Number(G.items.pod) || 0) + 2;
    G.items.shard = (Number(G.items.shard) || 0) + 1;
    discover('pod'); discover('shard');
    spawnSparkle(chimeCairn.point.x, chimeCairn.point.y + 1.2,
      chimeCairn.point.z, 0xbfe8d8, 44, 4.5);
    chord([293.66, 392, 523.25, 783.99], 0.09, 0.2);
    toast('The three notes meet - two Zephyr Pods and a Star Shard take shape.', 0xbfe8d8, 5600);
  } else {
    dialog('THE LISTENING CAIRN', 'Dawn, gale, rain. Three voices; one wind.', false);
  }
  persist();
}

function upgradeAuthoredProps() {
  for (const rec of summitChimes) {
    const instance = contractInstance('ouroboros_ring');
    if (!instance) continue;
    rec.ring.visible = false;
    instance.root.scale.setScalar(1.5);
    rec.ringHolder.add(instance.root);
  }
  if (chimeCairn) {
    const instance = contractInstance('cairn');
    if (instance) {
      chimeCairn.stones.visible = false;
      instance.root.scale.setScalar(1.2);
      chimeCairn.modelHolder.add(instance.root);
    }
  }
  upgradeNpcModels();
}

// Swap the procedural placeholder people for their authored Blender selves.
// The GLBs carry the same animation contract (ArmL/ArmR/LegL/LegR pivots,
// Sella's Pack, Ilyra's Staff), so the walk and idle code drives them as-is.
function upgradeNpcModels() {
  if (trader) {
    const inst = contractInstance('sella_vane');
    if (inst) {
      const get = name => inst.root.getObjectByName(name);
      const armL = get('ArmL'), armR = get('ArmR');
      const legL = get('LegL'), legR = get('LegR');
      const pack = get('Pack');
      if (armL && armR && legL && legR && pack) {
        inst.root.rotation.order = 'YXZ';
        inst.root.position.copy(trader.root.position);
        inst.root.rotation.y = trader.yaw;
        const lampGlow = makeGlow(0xffc45c, 1.15);
        lampGlow.position.set(0.53, 1.6, 0.2); // the pack's hanging lamp
        inst.root.add(lampGlow);
        G.scene.remove(trader.root);
        G.scene.add(inst.root);
        Object.assign(trader, { root: inst.root, armL, armR, legL, legR, pack, lampGlow });
        trader.interactable.pos = inst.root.position; // the prompt follows her walk
      }
    }
  }
  if (lanternKeeper) {
    const inst = contractInstance('ilyra_fen');
    if (inst) {
      inst.root.position.copy(lanternKeeper.root.position);
      inst.root.rotation.y = lanternKeeper.root.rotation.y;
      const glow = makeGlow(0xcfe8ff, 1.45);
      glow.position.set(0.5, 2.22, -0.05); // her staff-lantern
      inst.root.add(glow);
      G.scene.remove(lanternKeeper.root);
      G.scene.add(inst.root);
      Object.assign(lanternKeeper, { root: inst.root, glow });
    }
    G.ilyraRoot = lanternKeeper.root; // emberside.js seats her at the shore-fire
  }
}

function buildChimes() {
  const points = findSummits(CHIME_IDS.length);
  points.forEach((point, index) => buildSummitChime(CHIME_IDS[index], point, index));
  buildChimeCairn();
  preloadModels(['ouroboros_ring', 'cairn', 'sella_vane', 'ilyra_fen'])
    .then(upgradeAuthoredProps).catch(() => { });
}

function hydrateFlagsFromQuestState() {
  if (!isObject(G.story)) return;
  const lanternStory = G.story.collections && G.story.collections.lanterns;
  if (isObject(lanternStory)) {
    for (const id of LANTERN_IDS) if (lanternStory[id]) G.worldFlags.lanterns.lit[id] = true;
  }
  const chimeStory = G.story.collections && G.story.collections.chimes;
  if (isObject(chimeStory)) {
    for (const id of CHIME_IDS) if (chimeStory[id]) G.worldFlags.chimes.awake[id] = true;
  }
  if (G.story.flags) {
    if (G.story.flags.lanternKeeperMet) G.worldFlags.lanterns.keeperMet = true;
    if (G.story.flags.lanternsReported) G.worldFlags.lanterns.reported = true;
    if (G.story.flags.chimesResolved) G.worldFlags.chimes.resolved = true;
  }
}

function syncQuestState() {
  hydrateFlagsFromQuestState();
  const lf = G.worldFlags.lanterns;
  if (lf.keeperMet) signalQuestEvent('lantern_keeper_met');
  for (const id of LANTERN_IDS) if (lf.lit[id]) signalQuestEvent('lantern_lit', { id });
  if (lf.reported) signalQuestEvent('lanterns_reported');
  const cf = G.worldFlags.chimes;
  for (const id of CHIME_IDS) if (cf.awake[id]) signalQuestEvent('wind_chime_found', { id });
  if (cf.resolved) signalQuestEvent('wind_chimes_resolved');
  lastQuestSyncKey = questSyncKey();
}

function questSyncKey() {
  const wf = ensureWorldFlags();
  const story = isObject(G.story) ? G.story : {};
  const sc = isObject(story.collections) ? story.collections : {};
  const sf = isObject(story.flags) ? story.flags : {};
  return [
    wf.lanterns.keeperMet ? 1 : 0,
    LANTERN_IDS.map(id => wf.lanterns.lit[id] ? 1 : 0).join(''),
    wf.lanterns.reported ? 1 : 0,
    CHIME_IDS.map(id => wf.chimes.awake[id] ? 1 : 0).join(''),
    wf.chimes.resolved ? 1 : 0,
    isObject(sc.lanterns) ? LANTERN_IDS.map(id => sc.lanterns[id] ? 1 : 0).join('') : '',
    isObject(sc.chimes) ? CHIME_IDS.map(id => sc.chimes[id] ? 1 : 0).join('') : '',
    sf.lanternKeeperMet ? 1 : 0,
    sf.lanternsReported ? 1 : 0,
    sf.chimesResolved ? 1 : 0,
  ].join('|');
}

function updateTrader(dt, night) {
  if (!trader) return;
  const player = G.player;
  const root = trader.root;
  let speed = 0;
  const nearPlayer = player && Math.hypot(player.pos.x - root.position.x,
    player.pos.z - root.position.z) < 5.5;
  if (nearPlayer) {
    const want = Math.atan2(player.pos.x - root.position.x, player.pos.z - root.position.z);
    let d = want - trader.yaw;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    trader.yaw += d * Math.min(1, dt * 5);
  } else if (trader.route.length > 1) {
    const target = trader.route[trader.routeIndex];
    const dx = target.x - root.position.x;
    const dz = target.z - root.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1.1) {
      trader.routeIndex = (trader.routeIndex + 1) % trader.route.length;
    } else {
      const nx = root.position.x + (dx / dist) * dt * 1.25;
      const nz = root.position.z + (dz / dist) * dt * 1.25;
      const ny = heightAt(nx, nz);
      if (ny > WATER_Y + 0.45 && ny < root.position.y + 1.2 && slopeAt(nx, nz) < 0.62) {
        root.position.x = nx; root.position.z = nz;
        speed = 1.25;
        const want = Math.atan2(dx, dz);
        let d = want - trader.yaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        trader.yaw += d * Math.min(1, dt * 4);
      } else {
        trader.routeIndex = (trader.routeIndex + 1) % trader.route.length;
      }
    }
  }
  const ground = heightAt(root.position.x, root.position.z);
  root.position.y = ground + Math.sin(safeTime() * 4.5) * speed * 0.035;
  root.rotation.y = trader.yaw;
  const walk = Math.sin(safeTime() * 7.5) * (speed > 0 ? 0.55 : 0.04);
  trader.legL.rotation.x = walk; trader.legR.rotation.x = -walk;
  trader.armL.rotation.x = -walk * 0.55; trader.armR.rotation.x = walk * 0.55;
  trader.pack.rotation.z = Math.sin(safeTime() * 5.5) * speed * 0.025;
  trader.collider.x = root.position.x; trader.collider.z = root.position.z;
  trader.collider.top = ground + 1.55;
  trader.lamp.position.set(root.position.x + Math.sin(trader.yaw) * 0.5,
    ground + 1.0, root.position.z + Math.cos(trader.yaw) * 0.5);
  trader.lamp.intensity = night ? 0.9 : 0;
  trader.lampGlow.material.opacity = night ? 0.65 + Math.sin(safeTime() * 5) * 0.12 : 0.18;
  if (trader.quoteId && safeTime() > trader.quoteUntil) {
    trader.quoteId = null;
    trader.interactable.label = 'Browse Sella\'s wares';
  }
}

function updateLanternStory(dt, night) {
  if (!lanternKeeper) return;
  const flags = ensureWorldFlags().lanterns;
  let nearest = null;
  let nearestD2 = Infinity;
  for (let i = 0; i < shoreLanterns.length; i++) {
    const rec = shoreLanterns[i];
    const lit = !!flags.lit[rec.id];
    if (rec.applied !== lit) {
      rec.applied = lit;
      rec.coreMat.color.setHex(lit ? 0xd8efff : 0x26343d);
      rec.interactable.label = lit ? 'Listen to the shore lantern' : 'Kindle the shore lantern';
    }
    rec.glow.material.opacity = lit
      ? (0.62 + Math.sin(safeTime() * 2.1 + i * 1.7) * 0.13) * (night ? 1 : 0.55)
      : 0.02;
    if (lit && G.player) {
      const d2 = (G.player.pos.x - rec.point.x) ** 2 + (G.player.pos.z - rec.point.z) ** 2;
      if (d2 < nearestD2) { nearestD2 = d2; nearest = rec; }
    }
  }
  if (nearest && nearestD2 < 45 * 45) {
    lanternLight.position.set(nearest.point.x, nearest.point.y + 2.15, nearest.point.z);
    lanternLight.intensity = night ? 1.35 : 0.45;
  } else lanternLight.intensity = 0;

  const allLit = litLanternCount() >= LANTERN_IDS.length;
  const reveal = allLit && flags.reported && night;
  moonPath.visible = reveal;
  moonLines.visible = reveal;
  if (reveal) {
    const pulse = 0.82 + Math.sin(safeTime() * 1.7) * 0.18;
    moonPath.material.opacity = 0.13 * pulse;
    moonPath.material.color.setHex(G.bloodNight ? 0xffa09a : 0xcfe4ff);
    moonLines.material.opacity = 0.08 * pulse;
    moonPath.rotation.z = Math.sin(safeTime() * 0.22) * 0.025;
  }

  if (G.player) {
    const dx = G.player.pos.x - lanternKeeper.root.position.x;
    const dz = G.player.pos.z - lanternKeeper.root.position.z;
    if (dx * dx + dz * dz < 64) {
      const want = Math.atan2(dx, dz);
      let d = want - lanternKeeper.root.rotation.y;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      lanternKeeper.root.rotation.y += d * Math.min(1, dt * 3.5);
    }
  }
  lanternKeeper.glow.material.opacity = night ? 0.65 : 0.28;
}

function updateChimes(dt) {
  const flags = ensureWorldFlags().chimes;
  const wind = G.weather && Number.isFinite(G.weather.windMul) ? G.weather.windMul : 1;
  for (let i = 0; i < summitChimes.length; i++) {
    const rec = summitChimes[i];
    const awake = !!flags.awake[rec.id];
    if (rec.applied !== awake) {
      rec.applied = awake;
      rec.coreMat.color.setHex(awake ? 0xc8f4e8 : 0x304841);
      rec.interactable.label = awake ? 'Listen to the awakened chime' : 'Wake the silent chime';
    }
    rec.glow.material.opacity = awake
      ? 0.55 + Math.sin(safeTime() * 1.8 + i) * 0.13 : 0.025;
    rec.ringHolder.rotation.z = Math.sin(safeTime() * 0.55 + i * 1.9) * 0.025 * wind;
    for (let j = 0; j < rec.rods.length; j++) {
      rec.rods[j].rotation.z = Math.sin(safeTime() * (1.2 + j * 0.15) + i + j) * 0.08 * wind;
    }
  }
  if (chimeCairn) {
    const count = awakeChimeCount();
    chimeCairn.glow.material.opacity = flags.resolved ? 0.72
      : 0.06 + count * 0.11 + Math.sin(safeTime() * 1.4) * 0.025;
  }
}

export function buildAdventure() {
  ensureWorldFlags();
  if (built) { syncQuestState(); return true; }
  if (!G.scene || !Array.isArray(G.interactables) || !Array.isArray(G.colliders)) return false;
  buildTrader();
  buildLanternStory();
  buildChimes();
  built = true;
  syncQuestState();
  return true;
}

// Navigation targets consumed by quests.js objectiveTarget() for the stages
// this module owns. Nearest-first so "3 of 5 lit" always points somewhere new.
function nearestSite(records, skip) {
  const p = G.player && G.player.pos ? G.player.pos : { x: 0, z: 0 };
  let best = null, bestD = Infinity;
  for (const rec of records) {
    if (skip(rec)) continue;
    const d = (rec.point.x - p.x) ** 2 + (rec.point.z - p.z) ** 2;
    if (d < bestD) { bestD = d; best = rec; }
  }
  return best;
}

function updateQuestTargets() {
  const wf = ensureWorldFlags();
  const targets = {};
  if (lanternKeeper) {
    const kp = lanternKeeper.point;
    targets.meet_mist_lantern_keeper = { x: kp.x, z: kp.z, label: 'Ilyra Fen' };
    targets.return_to_lantern_keeper = { x: kp.x, z: kp.z, label: 'Ilyra Fen' };
  }
  const darkLantern = nearestSite(shoreLanterns, rec => wf.lanterns.lit[rec.id]);
  if (darkLantern) {
    targets.rekindle_five_lanterns = {
      x: darkLantern.point.x, z: darkLantern.point.z, label: 'Dark shore-lantern',
    };
  }
  const silentChime = nearestSite(summitChimes, rec => wf.chimes.awake[rec.id]);
  if (silentChime) {
    const t = { x: silentChime.point.x, z: silentChime.point.z, label: 'Silent chime' };
    targets.find_first_silent_chime = t;
    targets.answer_three_chimes = t;
  }
  if (chimeCairn) {
    targets.listen_at_chime_cairn = {
      x: chimeCairn.point.x, z: chimeCairn.point.z, label: 'Listening cairn',
    };
  }
  G.adventureTargets = targets;
}

export function updateAdventure(dt = 0, night = nightNow()) {
  ensureWorldFlags();
  if (!built && !buildAdventure()) return;
  // The base game constructs its world before the player chooses Continue.
  // Detect a subsequently applied save (or quest-state migration) and mirror
  // it into the physical props without requiring a second build call.
  if (questSyncKey() !== lastQuestSyncKey) syncQuestState();
  const step = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.05);
  updateTrader(step, !!night);
  updateLanternStory(step, !!night);
  updateChimes(step);
  updateQuestTargets();
}

export function getAdventureSummary() {
  ensureWorldFlags();
  return {
    traderMet: G.worldFlags.trader.met,
    lanternsLit: litLanternCount(),
    lanternsComplete: G.worldFlags.lanterns.reported,
    chimesAwake: awakeChimeCount(),
    chimesComplete: G.worldFlags.chimes.resolved,
    traderPosition: trader ? {
      x: trader.root.position.x, y: trader.root.position.y, z: trader.root.position.z,
    } : null,
    lanternSites: shoreLanterns.map(rec => ({ id: rec.id, ...rec.point })),
    chimeSites: summitChimes.map(rec => ({ id: rec.id, ...rec.point })),
  };
}
