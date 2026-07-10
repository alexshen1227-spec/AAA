// Quest director for Aerwyn.
//
// This module deliberately owns no world objects. It derives progress from the
// shared registries when they exist and accepts small, stable story events for
// content whose state is still private to another module (vault doors, gates,
// future lanterns/chimes, the Coil, and the finale).
//
// Serializable state contract:
//   G.quests = { version, activeId, entries: { [questId]: QuestState } }
//   G.story  = { version, mainArcId, mainStageId, flags, vaults, gates,
//                collections }
//
// state.js must include both roots in save/load before this is wired into the
// game loop. No functions, Sets, Three.js objects, or DOM nodes are stored in
// either root.
import { G, save } from './state.js';

export const QUEST_IDS = Object.freeze({
  NINTH_WARDEN: 'main_ninth_warden',
  TILLAS_WORRY: 'side_tillas_worry',
  MIST_LANTERNS: 'side_mist_lanterns',
  SILENT_CHIMES: 'side_silent_chimes',
});

const QUEST_VERSION = 1;
const STORY_VERSION = 1;
const EXPECTED_BEACONS = 8;
const EXPECTED_TOWERS = 3;
const EXPECTED_VAULTS = 2;
const EXPECTED_GEAR = 3;
const REQUIRED_WARDEN_LORE = 4;
const GATE_PHASES = ['dormant', 'murmuring', 'resonant', 'awakened', 'open', 'quiet'];
const WARDEN_LORE_IDS = [
  'stone3', 'stone8', 'stone9', 'stone12',
  'gloam1', 'gloam2', 'gloam3', 'hartDone',
];
const WARDEN_LORE_TARGETS = {
  stone3: [97, 12], stone8: [109, 112], stone9: [-150, -92], stone12: [-280, -52],
  gloam1: [97, 7], gloam2: [109, 120], gloam3: [-150, -100], hartDone: [58, 232],
};

const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const safeArray = value => Array.isArray(value) ? value : [];
const trueCount = value => isObject(value)
  ? Object.values(value).reduce((n, on) => n + (on ? 1 : 0), 0)
  : 0;
const stamp = () => Number.isFinite(G.time) ? G.time : 0;

function countActive(registry) {
  let n = 0;
  for (const item of safeArray(registry)) if (item && item.active) n++;
  return n;
}

function gearCount() {
  const equip = isObject(G.equip) ? G.equip : {};
  return ['stormcloth', 'barkgrip', 'quiver'].reduce((n, id) => n + (equip[id] ? 1 : 0), 0);
}

function wardenLoreCount() {
  const lore = isObject(G.lore) ? G.lore : {};
  return WARDEN_LORE_IDS.reduce((n, id) => n + (lore[id] ? 1 : 0), 0);
}

function exposedVaultCount() {
  let n = trueCount(Object.fromEntries(
    Object.entries(G.story.vaults).map(([id, v]) => [id, !!(v && v.opened)])));
  // Future world integration may expose G.vaults. Count it without requiring
  // that registry, and never double-count a vault carrying the same stable id.
  const seen = new Set(Object.entries(G.story.vaults)
    .filter(([, v]) => v && v.opened).map(([id]) => id));
  safeArray(G.vaults).forEach((vault, index) => {
    if (!vault || !vault.open) return;
    const id = typeof vault.id === 'string' && vault.id ? vault.id : `vault_${index + 1}`;
    if (!seen.has(id)) { seen.add(id); n++; }
  });
  return n;
}

function facts() {
  const story = G.story;
  return {
    openingDone: !!(G.tut && G.tut.openingDone),
    beacons: countActive(G.shrines),
    towers: countActive(G.towers),
    vaults: exposedVaultCount(),
    gear: gearCount(),
    wardenLore: wardenLoreCount(),
    gatesAttuned: trueCount(story.gates.attuned),
    lanterns: trueCount(story.collections.lanterns),
    chimes: trueCount(story.collections.chimes),
    flags: story.flags,
  };
}

function nearestTarget(candidates) {
  if (!candidates || !candidates.length) return null;
  const p = G.player && G.player.pos ? G.player.pos : { x: 0, z: 0 };
  let best = null, bestD = Infinity;
  for (const c of candidates) {
    if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.z)) continue;
    const d = (c.x - p.x) ** 2 + (c.z - p.z) ** 2;
    if (d < bestD) { bestD = d; best = c; }
  }
  return best ? { x: best.x, z: best.z, label: best.label || null } : null;
}

function objectiveTarget(questId, stageId) {
  if (questId === QUEST_IDS.NINTH_WARDEN) {
    if (stageId === 'wake_beneath_broken_sky') return { x: 42, z: -84, label: 'Maren' };
    if (stageId === 'kindle_first_beacon') {
      const s = safeArray(G.shrines)[0];
      return s ? { x: s.x, z: s.z, label: 'Plateau beacon' } : { x: 60, z: -80, label: 'Plateau beacon' };
    }
    if (stageId === 'recover_warden_testimony') {
      const lore = isObject(G.lore) ? G.lore : {};
      return nearestTarget(WARDEN_LORE_IDS.filter(id => !lore[id]).map(id => {
        const q = WARDEN_LORE_TARGETS[id];
        return q ? { x: q[0], z: q[1], label: 'Warden testimony' } : null;
      }));
    }
    if (stageId === 'restore_eight_beacons') {
      return nearestTarget(safeArray(G.shrines).filter(s => s && !s.active)
        .map(s => ({ x: s.x, z: s.z, label: 'Sleeping beacon' })));
    }
    if (stageId === 'chart_three_watchers') {
      return nearestTarget(safeArray(G.towers).filter(t => t && !t.active)
        .map(t => ({ x: t.x, z: t.z, label: 'Skywatch tower' })));
    }
    if (stageId === 'open_twin_vaults') {
      const vaults = [
        { id: 'vault.east', x: 109, z: 120 },
        { id: 'vault.west', x: -150, z: -100 },
      ];
      return nearestTarget(vaults.filter(v => !(G.story.vaults[v.id] && G.story.vaults[v.id].opened))
        .map(v => ({ ...v, label: 'Warden vault' })));
    }
    if (stageId === 'forge_warden_regalia') {
      return nearestTarget([{ x: 106, z: 124, label: 'Kneeling construct' },
        { x: -146, z: -96, label: 'Kneeling construct' }]);
    }
    if (stageId === 'attune_twin_gates') {
      const gates = [
        { id: 'gate.heartfields', x: 97, z: 7 },
        { id: 'gate.thornwood', x: -47, z: 203 },
      ];
      return nearestTarget(gates.filter(g => !G.story.gates.attuned[g.id])
        .map(g => ({ ...g, label: 'Ouroboros gate' })));
    }
    if (stageId === 'enter_the_coil' || stageId === 'still_the_coil_heart')
      return { x: 50, z: 265, label: 'The Coil' };
    if (stageId === 'face_hundred_year_storm') return { x: 0, z: 360, label: 'The Coiled Storm' };
  }
  if (questId === QUEST_IDS.TILLAS_WORRY) {
    if (stageId === 'inspect_fallen_stone') return { x: 30, z: -96, label: 'Fallen sky-stone' };
    return { x: 22, z: -102, label: 'Tilla' };
  }
  const external = G.adventureTargets && G.adventureTargets[stageId];
  if (external && Number.isFinite(external.x) && Number.isFinite(external.z)) {
    return { x: external.x, z: external.z, label: external.label || null };
  }
  return null;
}

const progress = (current, total, label) => ({ current, total, label });

const QUEST_DEFS = Object.freeze({
  [QUEST_IDS.NINTH_WARDEN]: {
    id: QUEST_IDS.NINTH_WARDEN,
    kind: 'main',
    title: 'The Ninth Warden',
    initialStatus: 'active',
    stages: [
      {
        id: 'wake_beneath_broken_sky',
        title: 'The Waking',
        objective: 'Wake beneath the broken sky and hear the Grey Wayfarer.',
        done: f => f.openingDone,
      },
      {
        id: 'kindle_first_beacon',
        title: 'The First Answer',
        objective: 'Awaken the beacon above the Wanderer\'s Plateau.',
        progress: f => progress(f.beacons, 1, 'beacon awakened'),
        done: f => f.beacons >= 1,
      },
      {
        id: 'recover_warden_testimony',
        title: 'A Missing Name',
        objective: 'Recover old testimony about the Wardens from stones and echoes.',
        progress: f => progress(Math.min(f.wardenLore, REQUIRED_WARDEN_LORE),
          REQUIRED_WARDEN_LORE, 'warden testimonies'),
        done: f => f.wardenLore >= REQUIRED_WARDEN_LORE,
      },
      {
        id: 'restore_eight_beacons',
        title: 'The Eight Flames',
        objective: 'Restore all eight beacons so the old network can answer.',
        progress: f => progress(Math.min(f.beacons, EXPECTED_BEACONS), EXPECTED_BEACONS, 'beacons awakened'),
        done: f => f.beacons >= EXPECTED_BEACONS,
      },
      {
        id: 'chart_three_watchers',
        title: 'The Three Watchers',
        objective: 'Chart all three skywatch towers and trace the lost Warden roads.',
        progress: f => progress(Math.min(f.towers, EXPECTED_TOWERS), EXPECTED_TOWERS, 'towers charted'),
        done: f => f.towers >= EXPECTED_TOWERS,
      },
      {
        id: 'open_twin_vaults',
        title: 'Hands Beneath Stone',
        objective: 'Open the two Warden vaults guarded by the kneeling constructs.',
        progress: f => progress(Math.min(f.vaults, EXPECTED_VAULTS), EXPECTED_VAULTS, 'vaults opened'),
        done: f => f.vaults >= EXPECTED_VAULTS,
      },
      {
        id: 'forge_warden_regalia',
        title: 'The Warden\'s Measure',
        objective: 'Return Ancient Gears to the constructs and complete their three gifts.',
        progress: f => progress(Math.min(f.gear, EXPECTED_GEAR), EXPECTED_GEAR, 'golem-forged gifts'),
        done: f => f.gear >= EXPECTED_GEAR,
      },
      {
        id: 'attune_twin_gates',
        title: 'The Gates Remember',
        objective: 'Attune both ouroboros gates. Each now answers the restored network.',
        progress: f => progress(Math.min(f.gatesAttuned, 2), 2, 'gates attuned'),
        done: f => f.gatesAttuned >= 2,
      },
      {
        id: 'enter_the_coil',
        title: 'The Empty Pedestal',
        objective: 'Follow the joined wind beyond the gates and enter the Coil.',
        done: f => !!f.flags.coilEntered,
      },
      {
        id: 'still_the_coil_heart',
        title: 'The Heart of the Coil',
        objective: 'Reach the sky-vault heart and learn why the ninth pedestal stood empty.',
        done: f => !!f.flags.coilCompleted,
      },
      {
        id: 'face_hundred_year_storm',
        title: 'The Coiled Storm',
        objective: 'Carry the Ninth Warden\'s answer into the hundred-year storm.',
        done: f => !!f.flags.finaleCompleted,
      },
      {
        id: 'wind_remembers',
        title: 'The Wind Remembers',
        objective: 'Aerwyn remembers its Wardens, and the wind remembers your name.',
        complete: true,
      },
    ],
  },

  [QUEST_IDS.TILLAS_WORRY]: {
    id: QUEST_IDS.TILLAS_WORRY,
    kind: 'side',
    title: 'Tilla\'s Worry',
    initialStatus: 'active',
    stages: [
      {
        id: 'gather_three_apples',
        title: 'Winter Stores',
        objective: 'Bring Tilla three apples to replace the stores lost beneath the fallen stone.',
        progress: () => progress(Math.min(Number(G.apples) || 0, 3), 3, 'apples held'),
        done: () => legacyTillaStage() >= 1,
      },
      {
        id: 'inspect_fallen_stone',
        title: 'Warm Metal',
        objective: 'Touch the fallen sky-stone west of the plateau beacon.',
        done: () => legacyTillaStage() >= 2,
      },
      {
        id: 'report_to_tilla',
        title: 'What Still Stirs',
        objective: 'Return to Tilla and tell her the old sky-work is still warm.',
        done: f => legacyTillaStage() >= 3 || !!f.flags.tillaReported,
      },
      {
        id: 'tillas_worry_resolved',
        title: 'Worry Shared',
        objective: 'Tilla knows the truth, and no longer carries it alone.',
        complete: true,
      },
    ],
  },

  [QUEST_IDS.MIST_LANTERNS]: {
    id: QUEST_IDS.MIST_LANTERNS,
    kind: 'side',
    title: 'Lanterns in the Mist',
    initialStatus: 'locked',
    stages: [
      {
        id: 'meet_mist_lantern_keeper',
        title: 'A Light by Mirrormere',
        objective: 'Speak with the keeper of the dark shore-lanterns.',
        done: f => !!f.flags.lanternKeeperMet,
      },
      {
        id: 'rekindle_five_lanterns',
        title: 'Five Lost Lights',
        objective: 'Rekindle the five lanterns hidden along Mirrormere\'s misty shore.',
        progress: f => progress(Math.min(f.lanterns, 5), 5, 'lanterns rekindled'),
        done: f => f.lanterns >= 5,
      },
      {
        id: 'return_to_lantern_keeper',
        title: 'The Lake Answers',
        objective: 'Return to the lantern keeper and watch the five lights answer one another.',
        done: f => !!f.flags.lanternsReported,
      },
      {
        id: 'mist_lanterns_complete',
        title: 'A Road Across the Water',
        objective: 'The shore lights burn again, and moonlight gathers between them.',
        complete: true,
      },
    ],
  },

  [QUEST_IDS.SILENT_CHIMES]: {
    id: QUEST_IDS.SILENT_CHIMES,
    kind: 'side',
    title: 'The Silent Chimes',
    initialStatus: 'locked',
    stages: [
      {
        id: 'find_first_silent_chime',
        title: 'A Voice Without Wind',
        objective: 'Find the source of the faint bronze note in the high country.',
        done: f => f.chimes >= 1,
      },
      {
        id: 'answer_three_chimes',
        title: 'Carry the Note',
        objective: 'Wake all three old chimes by carrying living wind through their rings.',
        progress: f => progress(Math.min(f.chimes, 3), 3, 'chimes awakened'),
        done: f => f.chimes >= 3,
      },
      {
        id: 'listen_at_chime_cairn',
        title: 'Where the Notes Meet',
        objective: 'Return to the weathered cairn and listen as the three notes meet.',
        done: f => !!f.flags.chimesResolved,
      },
      {
        id: 'silent_chimes_complete',
        title: 'The Wind Has a Voice',
        objective: 'The high paths sing again when the wind crosses them.',
        complete: true,
      },
    ],
  },
});

let built = false;
let updateAccumulator = 0;

function ensureRoots() {
  if (!isObject(G.quests)) G.quests = {};
  if (!isObject(G.quests.entries)) G.quests.entries = {};
  G.quests.version = QUEST_VERSION;
  if (typeof G.quests.activeId !== 'string') G.quests.activeId = null;

  if (!isObject(G.story)) G.story = {};
  G.story.version = STORY_VERSION;
  G.story.mainArcId = QUEST_IDS.NINTH_WARDEN;
  if (!isObject(G.story.flags)) G.story.flags = {};
  if (!isObject(G.story.vaults)) G.story.vaults = {};
  if (!isObject(G.story.gates)) G.story.gates = {};
  if (!isObject(G.story.gates.seen)) G.story.gates.seen = {};
  if (!isObject(G.story.gates.attuned)) G.story.gates.attuned = {};
  if (!GATE_PHASES.includes(G.story.gates.phase)) G.story.gates.phase = 'dormant';
  if (!isObject(G.story.collections)) G.story.collections = {};
  if (!isObject(G.story.collections.lanterns)) G.story.collections.lanterns = {};
  if (!isObject(G.story.collections.chimes)) G.story.collections.chimes = {};

  for (const def of Object.values(QUEST_DEFS)) normalizeEntry(def);
}

function normalizeEntry(def) {
  let entry = G.quests.entries[def.id];
  if (!isObject(entry)) {
    entry = {
      id: def.id,
      status: def.initialStatus,
      stageId: def.stages[0].id,
      startedAt: def.initialStatus === 'active' ? stamp() : null,
      updatedAt: stamp(),
      completedAt: null,
      flags: {},
    };
    G.quests.entries[def.id] = entry;
  }
  entry.id = def.id;
  if (!['locked', 'active', 'completed'].includes(entry.status)) entry.status = def.initialStatus;
  if (!def.stages.some(stage => stage.id === entry.stageId)) entry.stageId = def.stages[0].id;
  if (entry.status === 'completed') {
    const completedStage = def.stages.find(stage => stage.complete);
    if (completedStage) entry.stageId = completedStage.id;
  }
  if (!isObject(entry.flags)) entry.flags = {};
  return entry;
}

function legacyTillaStage() {
  const value = G.tut && G.tut.quests ? Number(G.tut.quests.tilla) : 0;
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function setLegacyTillaStage(stage) {
  if (!isObject(G.tut)) G.tut = {};
  if (!isObject(G.tut.quests)) G.tut.quests = {};
  G.tut.quests.tilla = Math.max(legacyTillaStage(), stage);
}

function unlockQuest(id) {
  const entry = G.quests.entries[id];
  if (!entry || entry.status !== 'locked') return false;
  entry.status = 'active';
  entry.startedAt = stamp();
  entry.updatedAt = stamp();
  return true;
}

function unlockFromStory() {
  let changed = false;
  if (G.story.flags.lanternKeeperMet) changed = unlockQuest(QUEST_IDS.MIST_LANTERNS) || changed;
  if (trueCount(G.story.collections.chimes) > 0) changed = unlockQuest(QUEST_IDS.SILENT_CHIMES) || changed;
  return changed;
}

function syncGatePhase(f) {
  let target = 'dormant';
  if (f.beacons >= 1) target = 'murmuring';
  if (f.beacons >= EXPECTED_BEACONS) target = 'resonant';
  if (f.beacons >= EXPECTED_BEACONS && f.towers >= EXPECTED_TOWERS &&
      f.vaults >= EXPECTED_VAULTS && f.gear >= EXPECTED_GEAR &&
      f.wardenLore >= REQUIRED_WARDEN_LORE) target = 'awakened';
  if (f.gatesAttuned >= 2 || f.flags.coilUnlocked) target = 'open';
  if (f.flags.finaleCompleted) target = 'quiet';

  const current = G.story.gates.phase;
  // Phase is derived from durable world facts. Assigning the exact value also
  // repairs saves made while an early Coil arrival incorrectly promoted the
  // gates to "open" and made them impossible to attune.
  if (target !== current) {
    G.story.gates.phase = target;
    G.story.gates.changedAt = stamp();
    return true;
  }
  return false;
}

function stageFor(def, entry) {
  return def.stages.find(stage => stage.id === entry.stageId) || def.stages[0];
}

function notifyAdvance(def, entry, stage) {
  if (!G.started || !G.ui) return;
  if (entry.status === 'completed') {
    if (typeof G.ui.banner === 'function') G.ui.banner('QUEST COMPLETE', def.title);
    return;
  }
  if (G.quests.activeId === def.id && typeof G.ui.toast === 'function') {
    G.ui.toast(`${def.title} - ${stage.title}`, def.kind === 'main' ? 0xffd9a0 : 0xbfe8ff, 4200);
  }
}

function advanceOne(def, entry, f, announce) {
  if (entry.status !== 'active') return false;
  const stage = stageFor(def, entry);
  if (stage.complete) {
    entry.status = 'completed';
    entry.completedAt = stamp();
    entry.updatedAt = stamp();
    if (announce) notifyAdvance(def, entry, stage);
    return true;
  }
  if (typeof stage.done !== 'function' || !stage.done(f, entry)) return false;
  const index = def.stages.indexOf(stage);
  const next = def.stages[Math.min(index + 1, def.stages.length - 1)];
  entry.stageId = next.id;
  entry.updatedAt = stamp();
  if (next.complete) {
    entry.status = 'completed';
    entry.completedAt = stamp();
  }
  if (announce) notifyAdvance(def, entry, next);
  return true;
}

function chooseActiveQuest() {
  const current = G.quests.entries[G.quests.activeId];
  if (current && current.status === 'active') return;
  const main = G.quests.entries[QUEST_IDS.NINTH_WARDEN];
  if (main && main.status === 'active') { G.quests.activeId = main.id; return; }
  const next = Object.values(G.quests.entries).find(entry => entry.status === 'active');
  G.quests.activeId = next ? next.id : null;
}

function syncStoryStage() {
  const main = G.quests.entries[QUEST_IDS.NINTH_WARDEN];
  if (main) G.story.mainStageId = main.stageId;
}

function reconcile(announce) {
  ensureRoots();
  let changed = unlockFromStory();
  // A bounded loop catches a progressed legacy save up to its first unmet
  // requirement without allowing malformed definitions to spin forever.
  for (let pass = 0; pass < 20; pass++) {
    const f = facts();
    changed = syncGatePhase(f) || changed;
    let advanced = false;
    for (const def of Object.values(QUEST_DEFS)) {
      const entry = G.quests.entries[def.id];
      if (advanceOne(def, entry, f, announce && pass === 0)) advanced = true;
    }
    changed = changed || advanced;
    if (!advanced) break;
  }
  chooseActiveQuest();
  syncStoryStage();
  return changed;
}

function commit() {
  try { save(); } catch (error) { /* persistence is best-effort */ }
}

function ensureBuilt() {
  if (!built) buildQuests();
  else ensureRoots();
}

export function buildQuests() {
  ensureRoots();
  built = true;
  updateAccumulator = 0;
  // Loading an existing save should land directly on its current objective,
  // not play every historical quest toast in a single frame.
  reconcile(false);
  return G.quests;
}

export function updateQuests(dt = 0) {
  ensureBuilt();
  const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
  updateAccumulator += step;
  if (step > 0 && updateAccumulator < 0.25) return false;
  updateAccumulator = 0;
  const changed = reconcile(true);
  if (changed) commit();
  return changed;
}

export function setActiveQuest(id) {
  ensureBuilt();
  const entry = G.quests.entries[id];
  if (!entry || entry.status !== 'active') return false;
  if (G.quests.activeId === id) return true;
  G.quests.activeId = id;
  entry.updatedAt = stamp();
  commit();
  return true;
}

export function getActiveObjective() {
  ensureBuilt();
  const id = G.quests.activeId;
  const def = QUEST_DEFS[id];
  const entry = G.quests.entries[id];
  if (!def || !entry || entry.status !== 'active') return null;
  const stage = stageFor(def, entry);
  const f = facts();
  return {
    questId: id,
    questTitle: def.title,
    kind: def.kind,
    stageId: stage.id,
    stageTitle: stage.title,
    objective: typeof stage.objective === 'function' ? stage.objective(f, entry) : stage.objective,
    progress: typeof stage.progress === 'function' ? stage.progress(f, entry) : null,
    target: objectiveTarget(id, stage.id),
  };
}

export function getQuestLog(options = {}) {
  ensureBuilt();
  const includeLocked = !!options.includeLocked;
  const f = facts();
  const log = [];
  for (const def of Object.values(QUEST_DEFS)) {
    const entry = G.quests.entries[def.id];
    if (!includeLocked && entry.status === 'locked') continue;
    const stage = stageFor(def, entry);
    log.push({
      id: def.id,
      title: def.title,
      kind: def.kind,
      status: entry.status,
      active: G.quests.activeId === def.id,
      stageId: stage.id,
      stageTitle: stage.title,
      objective: typeof stage.objective === 'function' ? stage.objective(f, entry) : stage.objective,
      progress: typeof stage.progress === 'function' ? stage.progress(f, entry) : null,
      startedAt: entry.startedAt,
      completedAt: entry.completedAt,
    });
  }
  return log;
}

function stableEventId(value, fallback) {
  if (typeof value === 'string' && /^[a-z0-9_.\-]+$/i.test(value)) return value;
  if (Number.isInteger(value) && value >= 0) return `${fallback}_${value + 1}`;
  return null;
}

function recordUnique(collection, id) {
  if (!id || collection[id]) return false;
  collection[id] = true;
  return true;
}

// Stable world-to-story event bridge. World content should call this only at
// the moment its own persistent state changes; duplicate calls are idempotent.
export function signalQuestEvent(type, payload = {}) {
  ensureBuilt();
  const data = isObject(payload) ? payload : {};
  let changed = false;
  switch (type) {
    case 'tilla_apples_delivered':
      changed = legacyTillaStage() < 1; setLegacyTillaStage(1); break;
    case 'tilla_stone_touched':
      changed = legacyTillaStage() < 2; setLegacyTillaStage(2); break;
    case 'tilla_reported':
      setLegacyTillaStage(3);
      changed = !G.story.flags.tillaReported;
      G.story.flags.tillaReported = true;
      break;
    case 'vault_opened': {
      const id = stableEventId(data.id, 'vault') || stableEventId(data.index, 'vault');
      if (!id) return false;
      if (!isObject(G.story.vaults[id])) G.story.vaults[id] = {};
      changed = !G.story.vaults[id].opened;
      G.story.vaults[id].opened = true;
      G.story.vaults[id].openedAt = G.story.vaults[id].openedAt ?? stamp();
      break;
    }
    case 'gate_seen': {
      const id = stableEventId(data.id, 'gate') || stableEventId(data.index, 'gate');
      if (!id) return false;
      changed = recordUnique(G.story.gates.seen, id);
      break;
    }
    case 'gate_attuned': {
      const id = stableEventId(data.id, 'gate') || stableEventId(data.index, 'gate');
      if (!id) return false;
      changed = recordUnique(G.story.gates.attuned, id);
      break;
    }
    case 'coil_unlocked':
      changed = !G.story.flags.coilUnlocked; G.story.flags.coilUnlocked = true; break;
    case 'coil_entered':
      changed = !G.story.flags.coilEntered; G.story.flags.coilEntered = true; break;
    case 'coil_completed':
      changed = !G.story.flags.coilCompleted; G.story.flags.coilCompleted = true; break;
    case 'finale_completed':
      changed = !G.story.flags.finaleCompleted; G.story.flags.finaleCompleted = true; break;
    case 'lantern_keeper_met':
      changed = !G.story.flags.lanternKeeperMet;
      G.story.flags.lanternKeeperMet = true;
      changed = unlockQuest(QUEST_IDS.MIST_LANTERNS) || changed;
      break;
    case 'lantern_lit': {
      const id = stableEventId(data.id, 'lantern') || stableEventId(data.index, 'lantern');
      if (!id) return false;
      changed = recordUnique(G.story.collections.lanterns, id);
      break;
    }
    case 'lanterns_reported':
      changed = !G.story.flags.lanternsReported; G.story.flags.lanternsReported = true; break;
    case 'wind_chime_found': {
      const id = stableEventId(data.id, 'chime') || stableEventId(data.index, 'chime');
      if (!id) return false;
      changed = recordUnique(G.story.collections.chimes, id);
      changed = unlockQuest(QUEST_IDS.SILENT_CHIMES) || changed;
      break;
    }
    case 'wind_chimes_resolved':
      changed = !G.story.flags.chimesResolved; G.story.flags.chimesResolved = true; break;
    default:
      return false;
  }
  if (changed) {
    reconcile(true);
    commit();
  }
  return changed;
}

// Small escape hatch for later authored set-pieces. Prefer signalQuestEvent()
// for known events so spelling remains centralized and grep-friendly.
export function setStoryFlag(id, value = true) {
  ensureBuilt();
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_]*$/i.test(id)) return false;
  if (G.story.flags[id] === value) return false;
  G.story.flags[id] = value;
  reconcile(true);
  commit();
  return true;
}
