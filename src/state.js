// Shared mutable game state. Modules import G and read/write what they own.

export const SAVE_VERSION = 2;
export const GLIMMER_TOTAL = 20;

// Stable order used only when migrating legacy saves, which stored a bare
// glimmer count and could not identify the individual discoveries.
const LEGACY_GLIMMER_IDS = [
  // Forest site 2 is below the lake surface and was never spawned. Preserve
  // the eleven collectible rock sites, then both chest glimmers, so a legacy
  // count maps onto the same 20 discoveries that exist in v2.
  ...Array.from({ length: 12 }, (_, i) => i)
    .filter(i => i !== 2).map(i => `glimmer.forest.${i}`),
  ...Array.from({ length: 4 }, (_, i) => `glimmer.island.${i}`),
  ...Array.from({ length: 3 }, (_, i) => `glimmer.peak.${i}`),
  'glimmer.vault-west',
  'glimmer.island-chest.3',
];

function emptyWorldState() {
  return { chests: {}, glimmers: {}, pickups: {}, vaults: {} };
}

function emptyQuests() {
  return { version: 1, activeId: null, entries: {} };
}

function emptyStory() {
  return {
    version: 1,
    mainArcId: 'main_ninth_warden',
    mainStageId: 'wake_beneath_broken_sky',
    flags: {},
    vaults: {},
    gates: { phase: 'dormant', seen: {}, attuned: {} },
    collections: { lanterns: {}, chimes: {} },
  };
}

export const G = {
  // three.js core
  scene: null, camera: null, renderer: null,

  // timing
  time: 0,          // seconds since start
  dayTime: 0.3,     // 0..1 (0 = midnight, 0.25 = morning, 0.5 = noon)
  dayCount: 0,
  lastCrimsonNight: -999,
  started: false,   // past title screen
  paused: false,
  gameOver: false,
  slowmo: 0,        // seconds of Last Light slow time remaining
  lastLight: 0,     // 0..1 warm-grade envelope for the camp-clear beat

  // player progress
  hearts: 12,       // quarter-hearts (12 = 3 hearts)
  maxHearts: 12,
  stamina: 100,
  maxStamina: 100,
  orbs: 0,
  apples: 3,
  gems: 0,
  glimmers: 0,
  respawn: { x: 50, y: 0, z: -68 },
  // discovery inventory: special items + which item types have been obtained
  items: { feather: 0, mushroom: 0, shard: 0, gear: 0, pod: 0 },
  seen: { apple: true },   // apples are known from the start (you carry 3)
  buffs: { swiftUntil: 0, vigorUntil: 0 },
  // golem-forged permanent upgrades (offer Ancient Gears at the vault golems)
  equip: { stormcloth: false, barkgrip: false, quiver: false },
  tut: { done: false, hints: {} },
  // The Remembering: chronicle entries found, deed-stars kindled, regions greeted
  lore: {},          // {entryId: true} — whisper stones, gloamings, letters, the hart
  deeds: {},         // {deedId: true} — each lights a star (sky.js reads G.deedStars)
  regionsSeen: {},   // {regionName: true} — first-entry title cards
  quests: emptyQuests(),
  story: emptyStory(),
  // Stable one-shot world progress. Values are sparse {stableId: true} maps.
  worldState: emptyWorldState(),

  // world registries (filled by world.js / enemies.js)
  heightAt: null,       // (x,z) => y  terrain height
  climbMeshes: [],      // meshes the player can climb via raycast
  colliders: [],        // {x, z, r} cylinder colliders
  interactables: [],    // {pos, r, label, onUse, gone}
  grabbables: [],       // movable crate meshes
  enemies: [],
  shrines: [],
  towers: [],

  // environment & feel systems (writers noted; readers must handle defaults)
  weather: { kind: 'clear', windMul: 1, wetness: 0 },  // written by sky.js
  updraftZones: [],  // {x,z,r,bottomY,topY,strength,expires?} — registered by world.js
  camShake: 0,       // impulse accumulator; any system may +=, player camera consumes
  hitStopT: 0,       // global hit-stop seconds remaining (main.js scales sim dt while > 0)
  hurtAmt: 0,        // directional hurt bloom 0..1 (post.js composite reads, main.js decays)
  hurtDir: 0,        // screen-relative bearing of the last hit (0 = ahead)

  // systems (set in main.js)
  ui: null, audio: null, player: null,
  onPauseChanged: null,

  // input snapshot (filled by main.js)
  keys: {},
  mouse: { dx: 0, dy: 0, attack: false },

  settings: { mute: false, quality: 1 },
};

// Pause is derived from named owners instead of snapshotting a shared boolean.
// This makes map/inventory/manual/pointer-lock interleavings order-independent.
const pauseReasons = new Set();

export function setPauseReason(reason, active) {
  if (!reason) return G.paused;
  const before = pauseReasons.has(reason);
  if (active) pauseReasons.add(reason); else pauseReasons.delete(reason);
  G.paused = pauseReasons.size > 0;
  if (before !== !!active && G.onPauseChanged) G.onPauseChanged(reason, !!active);
  return G.paused;
}

export function hasPauseReason(reason) { return pauseReasons.has(reason); }

export function clearPauseReasons() {
  if (!pauseReasons.size) return;
  pauseReasons.clear();
  G.paused = false;
  if (G.onPauseChanged) G.onPauseChanged(null, false);
}

function finiteNumber(value, fallback, min, max, integer = false) {
  let n = Number(value);
  if (!Number.isFinite(n)) n = fallback;
  n = Math.min(max, Math.max(min, n));
  return integer ? Math.round(n) : n;
}

function safeValue(value, depth) {
  if (value === null) return null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (depth > 7 || !value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    return value.slice(0, 2048).map(v => safeValue(v, depth + 1)).filter(v => v !== undefined);
  }
  return safeRecord(value, depth);
}

function safeRecord(value, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 7) return {};
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
    const clean = safeValue(val, depth + 1);
    if (clean !== undefined) out[key] = clean;
  }
  return out;
}

function boolRecord(value) {
  const src = safeRecord(value);
  const out = {};
  for (const [key, val] of Object.entries(src)) if (val === true) out[key] = true;
  return out;
}

function mergeDefaults(defaults, value) {
  const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};
  for (const [key, val] of Object.entries(defaults)) {
    if (val && typeof val === 'object' && !Array.isArray(val)) out[key] = mergeDefaults(val, src[key]);
    else out[key] = val;
  }
  for (const [key, val] of Object.entries(src)) {
    const def = defaults[key];
    if (def && typeof def === 'object' && !Array.isArray(def)) continue;
    out[key] = val;
  }
  return out;
}

function normalizeWorldState(value) {
  const src = value && typeof value === 'object' ? value : {};
  return {
    chests: boolRecord(src.chests),
    glimmers: boolRecord(src.glimmers),
    pickups: boolRecord(src.pickups),
    vaults: boolRecord(src.vaults),
  };
}

function normalizeBoolArray(value, length) {
  const src = Array.isArray(value) ? value : [];
  return Array.from({ length }, (_, i) => src[i] === true);
}

function normalizeSave(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rawVersion = finiteNumber(raw.version, 1, 1, SAVE_VERSION, true);
  const worldState = normalizeWorldState(raw.worldState);
  const legacyCount = finiteNumber(raw.glimmers, 0, 0, GLIMMER_TOTAL, true);
  if (rawVersion < 2 && Object.keys(worldState.glimmers).length === 0) {
    for (let i = 0; i < legacyCount; i++) worldState.glimmers[LEGACY_GLIMMER_IDS[i]] = true;
  }

  const items = raw.items && typeof raw.items === 'object' ? raw.items : {};
  const equip = raw.equip && typeof raw.equip === 'object' ? raw.equip : {};
  const respawn = raw.respawn && typeof raw.respawn === 'object' ? raw.respawn : {};
  const tut = safeRecord(raw.tut);
  if (!tut.hints || typeof tut.hints !== 'object') tut.hints = {};
  if (rawVersion < 2 && tut.quests && tut.quests.tilla === 2) tut.quests.tilla = 3;

  let maxHearts = finiteNumber(raw.maxHearts, 12, 4, 80, true);
  maxHearts = Math.max(4, Math.round(maxHearts / 4) * 4);
  const maxStamina = finiteNumber(raw.maxStamina, 100, 50, 400, true);
  const claimedGlimmers = Math.min(GLIMMER_TOTAL, Object.keys(worldState.glimmers).length);
  const quests = mergeDefaults(emptyQuests(), safeRecord(raw.quests));
  const story = mergeDefaults(emptyStory(), safeRecord(raw.story));

  return {
    version: SAVE_VERSION,
    maxHearts,
    maxStamina,
    orbs: finiteNumber(raw.orbs, 0, 0, 100, true),
    apples: finiteNumber(raw.apples, 3, 0, 9999, true),
    gems: finiteNumber(raw.gems, 0, 0, 99999, true),
    glimmers: claimedGlimmers,
    respawn: {
      x: finiteNumber(respawn.x, 50, -520, 520),
      y: finiteNumber(respawn.y, 0, -100, 500),
      z: finiteNumber(respawn.z, -68, -520, 520),
    },
    shrines: normalizeBoolArray(raw.shrines, 8),
    towers: normalizeBoolArray(raw.towers, 3),
    items: {
      feather: finiteNumber(items.feather, 0, 0, 999, true),
      mushroom: finiteNumber(items.mushroom, 0, 0, 999, true),
      shard: finiteNumber(items.shard, 0, 0, 999, true),
      gear: finiteNumber(items.gear, 0, 0, 999, true),
      pod: finiteNumber(items.pod, 0, 0, 999, true),
      sigil: finiteNumber(items.sigil, 0, 0, 9, true),
    },
    seen: boolRecord(raw.seen),
    tut,
    equip: {
      stormcloth: equip.stormcloth === true,
      barkgrip: equip.barkgrip === true,
      quiver: equip.quiver === true,
    },
    lore: boolRecord(raw.lore),
    deeds: boolRecord(raw.deeds),
    regionsSeen: boolRecord(raw.regionsSeen),
    quests,
    story,
    worldState,
    arrows: finiteNumber(raw.arrows, 20, 0, 999, true),
    time: finiteNumber(raw.time, 0, 0, 1e9),
    dayTime: finiteNumber(raw.dayTime, 0.3, 0, 0.999999),
    dayCount: finiteNumber(raw.dayCount, 0, 0, 1000000, true),
    lastCrimsonNight: finiteNumber(raw.lastCrimsonNight, -999, -999, 1000000, true),
    settings: {
      mute: !!(raw.settings && raw.settings.mute),
      quality: finiteNumber(raw.settings && raw.settings.quality, 1, 0.5, 1, false),
    },
  };
}

export function save() {
  try {
    const glimmers = Math.min(GLIMMER_TOTAL, Object.keys(G.worldState.glimmers || {}).length);
    G.glimmers = glimmers;
    localStorage.setItem('echoes-save', JSON.stringify({
      version: SAVE_VERSION,
      maxHearts: G.maxHearts, maxStamina: G.maxStamina,
      orbs: G.orbs, apples: G.apples, gems: G.gems, glimmers,
      respawn: G.respawn,
      shrines: G.shrines.map(s => s.active),
      towers: G.towers.map(t => t.active),
      items: G.items, seen: G.seen, tut: G.tut, equip: G.equip,
      lore: G.lore, deeds: G.deeds, regionsSeen: G.regionsSeen,
      quests: G.quests, story: G.story,
      worldState: G.worldState,
      arrows: G.player ? G.player.arrows : 20,
      time: G.time, dayTime: G.dayTime, dayCount: G.dayCount,
      lastCrimsonNight: G.lastCrimsonNight,
      settings: G.settings,
    }));
  } catch (e) { /* storage unavailable — ignore */ }
}

export function load() {
  try {
    const raw = localStorage.getItem('echoes-save');
    if (!raw) return null;
    const normalized = normalizeSave(JSON.parse(raw));
    if (!normalized) return null;
    // Rewrite validated data immediately so legacy saves migrate atomically.
    localStorage.setItem('echoes-save', JSON.stringify(normalized));
    return normalized;
  } catch (e) { return null; }
}

export function wipeSave() {
  try { localStorage.removeItem('echoes-save'); } catch (e) { }
}
