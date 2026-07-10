// Asset loading: rigged glTF characters (KayKit, CC0) + audio files.
// Works from the static server (fetch relative paths) and from the standalone
// single-file build, where build_standalone.py injects window.__ASSET_DATA =
// { 'assets/models/knight.glb': 'data:...base64', ... } before main.js runs.
import * as THREE from 'three';
import { GLTFLoader } from './GLTFLoader.js';
import { clone as cloneSkinned } from './SkeletonUtils.js';

export const MODELS = {
  knight: 'assets/models/knight.glb',
  skeleton_minion: 'assets/models/skeleton_minion.glb',
  skeleton_warrior: 'assets/models/skeleton_warrior.glb',
  skeleton_mage: 'assets/models/skeleton_mage.glb',
  // stylized props authored in Blender (assets/models/gen, this project)
  bow: 'assets/models/gen/bow.glb',
  arrow: 'assets/models/gen/arrow.glb',
  chest: 'assets/models/gen/chest.glb',
  apple: 'assets/models/gen/apple.glb',
  gem: 'assets/models/gen/gem.glb',
  feather: 'assets/models/gen/feather.glb',
  mushroom: 'assets/models/gen/mushroom.glb',
  shard: 'assets/models/gen/shard.glb',
  gear: 'assets/models/gen/gear.glb',
  boglin: 'assets/models/gen/boglin.glb',
};

// generated prop names, preloaded together at boot
export const GEN_PROPS = ['bow', 'arrow', 'chest', 'apple', 'gem', 'feather',
  'mushroom', 'shard', 'gear', 'boglin'];

// signature structures + creatures (assets/models/blender — material contract)
Object.assign(MODELS, {
  beacon_shrine: 'assets/models/blender/beacon_shrine.glb',
  skywatch_tower: 'assets/models/blender/skywatch_tower.glb',
  wind_bellows: 'assets/models/blender/wind_bellows.glb',
  treasure_chest: 'assets/models/blender/treasure_chest.glb',
  sky_debris: 'assets/models/blender/sky_debris.glb',
  gloom_flora: 'assets/models/blender/gloom_flora.glb',
  construct_golem: 'assets/models/blender/construct_golem.glb',
  ouroboros_ring: 'assets/models/blender/ouroboros_ring.glb',
  tree_autumn: 'assets/models/blender/tree_autumn.glb',
  waterfall: 'assets/models/blender/waterfall.glb',
  // The Remembering: whisper stones, Piet's cairn, the Pale Hart
  whisper_stone: 'assets/models/blender/whisper_stone.glb',
  cairn: 'assets/models/blender/cairn.glb',
  pale_hart: 'assets/models/blender/pale_hart.glb',
  // The Wind & The Wild: sail-winged sky predator + throwable bottled updraft
  razorkite: 'assets/models/blender/razorkite.glb',
  zephyr_pod: 'assets/models/blender/zephyr_pod.glb',
  // The Coil: the eight warden statues and the empty ninth pedestal
  warden_statue: 'assets/models/blender/warden_statue.glb',
  ninth_pedestal: 'assets/models/blender/ninth_pedestal.glb',
  // the valley's people: the road-tinker and the lanternkeeper
  sella_vane: 'assets/models/blender/sella_vane.glb',
  ilyra_fen: 'assets/models/blender/ilyra_fen.glb',
  // ...and the meadow folk who started it all
  maren_wayfarer: 'assets/models/blender/maren_wayfarer.glb',
  tilla_gleaner: 'assets/models/blender/tilla_gleaner.glb',
  // Windwise Wilds: the herd's authored body (antlers node toggles bucks)
  deer: 'assets/models/blender/deer.glb',
  // the gloamhound: a spectral stalker (shape only; materials become ghost-light)
  gloamhound: 'assets/models/blender/gloamhound.glb',
  // true relic icons for the satchel
  skysong_fork: 'assets/models/blender/skysong_fork.glb',
  warden_sigil: 'assets/models/blender/warden_sigil.glb',
});
export const SIGNATURE_PROPS = ['beacon_shrine', 'skywatch_tower', 'wind_bellows',
  'treasure_chest', 'sky_debris', 'gloom_flora', 'construct_golem',
  'ouroboros_ring', 'tree_autumn', 'waterfall', 'zephyr_pod'];

// curated pack props (CC0 — Kenney / Poly Pizza; credits in assets/licenses)
Object.assign(MODELS, {
  pk_lightpost: 'assets/models/packs/kenney-graveyard-kit/lightpost-single.glb',
  pk_obelisk: 'assets/models/packs/kenney-graveyard-kit/pillar-obelisk.glb',
  pk_wall_damaged: 'assets/models/packs/kenney-graveyard-kit/stone-wall-damaged.glb',
  pk_pine_tall: 'assets/models/packs/kenney-nature-kit/tree_pineTallA_detailed.glb',
  pk_crystal: 'assets/models/packs/polypizza-singles/crystal_cluster.glb',
  pk_flower_purple: 'assets/models/packs/kenney-nature-kit/flower_purpleA.glb',
});
export const PACK_PROPS = ['pk_lightpost', 'pk_obelisk', 'pk_wall_damaged',
  'pk_pine_tall', 'pk_crystal', 'pk_flower_purple'];

// the signature models name their materials by a fixed contract; the game
// remaps each name onto its toon palette (energy materials keep emission so
// the bloom pass catches them)
const CONTRACT = {
  Stone:       { color: 0xbcb3a0 },
  StoneDark:   { color: 0x8d8577 },
  Bronze:      { color: 0x4fa385 },   // oxidized verdigris — the sky-tech metal
  BronzeDark:  { color: 0x2f6f5c },
  EnergyAmber: { color: 0xffc27a, emissive: 0xff9a3d, intensity: 1.1 },
  EnergyGreen: { color: 0x9fffc8, emissive: 0x39ff88, intensity: 1.1 },
  Wood:        { color: 0x7a5230 },
  Cloth:       { color: 0xd6c298 },
  Rope:        { color: 0x8a6f3e },
  Leaf:        { color: 0x4f9a3e },
  LeafAutumn:  { color: 0xe8b23a },
  Water:       { color: 0xcfeaff, opacity: 0.55 },
  Foam:        { color: 0xffffff, opacity: 0.85 },
};

// resolves an asset path for either serving mode
export function assetURL(path) {
  if (typeof window !== 'undefined' && window.__ASSET_DATA && window.__ASSET_DATA[path]) {
    return window.__ASSET_DATA[path];
  }
  return './' + path;
}

const gltfLoader = new GLTFLoader();

// cache: name -> { scene, animations } (the master copy — never added to the
// scene directly; call instantiate() to get a skinned clone you own)
const loaded = {};
const pending = {};

export function loadModel(name) {
  if (loaded[name]) return Promise.resolve(loaded[name]);
  if (pending[name]) return pending[name];
  const path = MODELS[name];
  if (!path) return Promise.reject(new Error('unknown model: ' + name));
  pending[name] = new Promise((resolve, reject) => {
    gltfLoader.load(assetURL(path), (gltf) => {
      loaded[name] = gltf;
      delete pending[name];
      resolve(gltf);
    }, undefined, (err) => {
      delete pending[name];
      reject(err);
    });
  });
  return pending[name];
}

// preload several models; resolves with { name: gltf|null } — null on failure
// (callers keep procedural fallbacks, so a failed download never breaks boot)
export function preloadModels(names = Object.keys(MODELS)) {
  return Promise.all(names.map(n =>
    loadModel(n).catch(err => {
      console.warn('model failed to load, using procedural fallback:', n, err);
      return null;
    })
  )).then(list => {
    const out = {};
    names.forEach((n, i) => { out[n] = list[i]; });
    return out;
  });
}

export function getModel(name) { return loaded[name] || null; }

// Deep-clone a loaded character (SkeletonUtils handles skinned meshes/bones).
// Returns { root, clips } or null if the model isn't loaded.
export function instantiate(name) {
  const gltf = loaded[name];
  if (!gltf) return null;
  const root = cloneSkinned(gltf.scene);
  return { root, clips: gltf.animations };
}

// convert a prop's exported PBR materials to the game's toon look, keeping
// base color + emissive; shared per source material within the prop
import { toonGradient } from './terrain.js';
export function toonifyProp(root) {
  const conv = new Map();
  root.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = true;
    const src = o.material;
    if (!src || !src.isMaterial) return;
    let m = conv.get(src);
    if (!m) {
      m = new THREE.MeshToonMaterial({
        color: src.color ? src.color.clone() : new THREE.Color(0xffffff),
        gradientMap: toonGradient,
        map: src.map || null,
        lightMap: src.lightMap || null,
        lightMapIntensity: src.lightMapIntensity !== undefined ? src.lightMapIntensity : 1,
        aoMap: src.aoMap || null,
        aoMapIntensity: src.aoMapIntensity !== undefined ? src.aoMapIntensity : 1,
        emissiveMap: src.emissiveMap || null,
        bumpMap: src.bumpMap || null,
        bumpScale: src.bumpScale !== undefined ? src.bumpScale : 1,
        normalMap: src.normalMap || null,
        displacementMap: src.displacementMap || null,
        displacementScale: src.displacementScale !== undefined ? src.displacementScale : 1,
        displacementBias: src.displacementBias !== undefined ? src.displacementBias : 0,
        alphaMap: src.alphaMap || null,
        transparent: !!src.transparent,
        opacity: src.opacity !== undefined ? src.opacity : 1,
        alphaTest: src.alphaTest || 0,
        side: src.side,
        vertexColors: !!src.vertexColors,
        depthWrite: src.depthWrite,
        depthTest: src.depthTest,
      });
      m.name = src.name ? src.name + '_AerwynToon' : 'AerwynToon';
      if (src.normalScale && m.normalScale) m.normalScale.copy(src.normalScale);
      if (src.emissive && (src.emissive.r + src.emissive.g + src.emissive.b) > 0.01) {
        m.emissive.copy(src.emissive);
        m.emissiveIntensity = src.emissiveIntensity !== undefined ? src.emissiveIntensity : 1;
      }
      // Preserve intentionally additive/glass-like materials. Signature props
      // still use contractInstance(), whose authored palette remains in charge.
      m.blending = src.blending;
      m.premultipliedAlpha = src.premultipliedAlpha;
      m.dithering = src.dithering;
      m.toneMapped = src.toneMapped;
      conv.set(src, m);
    }
    o.material = m;
  });
  return root;
}

// instantiate + toonify a static prop; null until its GLB has loaded
export function propInstance(name) {
  const inst = instantiate(name);
  return inst ? toonifyProp(inst.root) : null;
}

// instantiate a signature model and remap its contract materials to toon.
// Materials are created fresh PER INSTANCE (state changes like a beacon
// awakening recolor them without bleeding onto siblings). Returns
// { root, mats: { EnergyAmber: [..], Bronze: [..], ... } } or null.
export function contractInstance(name) {
  const inst = instantiate(name);
  if (!inst) return null;
  const made = new Map();          // src material -> toon material
  const mats = {};                 // contract name -> [toon materials]
  inst.root.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = true;
    const remapOne = (src) => {
      let m = made.get(src);
      if (m) return m;
      const spec = CONTRACT[src.name] || null;
      m = new THREE.MeshToonMaterial({
        color: spec ? spec.color : (src.color ? src.color.getHex() : 0xffffff),
        gradientMap: toonGradient,
      });
      if (spec && spec.emissive) {
        m.emissive.setHex(spec.emissive);
        m.emissiveIntensity = spec.intensity || 1;
      }
      if (spec && spec.opacity !== undefined) {
        m.transparent = true;
        m.opacity = spec.opacity;
        m.depthWrite = false;
        m.side = THREE.DoubleSide;
      }
      made.set(src, m);
      const key = src.name || 'unnamed';
      (mats[key] = mats[key] || []).push(m);
      return m;
    };
    o.material = Array.isArray(o.material) ? o.material.map(remapOne) : remapOne(o.material);
  });
  return { root: inst.root, mats };
}

// find a clip by exact name, else case-insensitive substring
export function findClip(clips, name) {
  let c = THREE.AnimationClip.findByName(clips, name);
  if (c) return c;
  const lower = name.toLowerCase();
  return clips.find(cl => cl.name.toLowerCase().includes(lower)) || null;
}

// ---- audio -----------------------------------------------------------------

const audioBuffers = {};

// decode an audio file into an AudioBuffer (cached); null on failure
export function loadAudioBuffer(ctx, path) {
  if (audioBuffers[path]) return Promise.resolve(audioBuffers[path]);
  return fetch(assetURL(path))
    .then(r => { if (!r.ok) throw new Error('http ' + r.status); return r.arrayBuffer(); })
    .then(ab => ctx.decodeAudioData(ab))
    .then(buf => { audioBuffers[path] = buf; return buf; })
    .catch(err => { console.warn('audio failed to load:', path, err); return null; });
}
