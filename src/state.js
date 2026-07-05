// Shared mutable game state. Modules import G and read/write what they own.
export const G = {
  // three.js core
  scene: null, camera: null, renderer: null,

  // timing
  time: 0,          // seconds since start
  dayTime: 0.3,     // 0..1 (0 = midnight, 0.25 = morning, 0.5 = noon)
  started: false,   // past title screen
  paused: false,
  gameOver: false,

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
  items: { feather: 0, mushroom: 0, shard: 0, gear: 0 },
  seen: { apple: true },   // apples are known from the start (you carry 3)
  buffs: { swiftUntil: 0, vigorUntil: 0 },
  tut: { done: false, hints: {} },

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

  // systems (set in main.js)
  ui: null, audio: null, player: null,

  // input snapshot (filled by main.js)
  keys: {},
  mouse: { dx: 0, dy: 0, attack: false },

  settings: { mute: false, quality: 1 },
};

export function save() {
  try {
    localStorage.setItem('echoes-save', JSON.stringify({
      maxHearts: G.maxHearts, maxStamina: G.maxStamina,
      orbs: G.orbs, apples: G.apples, gems: G.gems, glimmers: G.glimmers,
      respawn: G.respawn,
      shrines: G.shrines.map(s => s.active),
      towers: G.towers.map(t => t.active),
      items: G.items, seen: G.seen, tut: G.tut,
      arrows: G.player ? G.player.arrows : 20,
    }));
  } catch (e) { /* storage unavailable — ignore */ }
}

export function load() {
  try {
    const raw = localStorage.getItem('echoes-save');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) { return null; }
}

export function wipeSave() {
  try { localStorage.removeItem('echoes-save'); } catch (e) { }
}
