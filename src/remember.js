// The Remembering — the valley's memory made visible. Four quiet systems:
//   Hollow Stones  — whisper-stones at the old places; each speaks one
//                    fragment of what happened to Aerwyn into the Chronicle.
//   Gloamings      — translucent amber echoes that replay ten seconds of the
//                    world before the Sundering, at the vaults, at night.
//   Letters        — a fallen sky-courier's letters tumbling in the updrafts;
//                    catch them mid-glide, lay them to rest at his cairn.
//   Deed-stars     — deeds kindle real stars (sky.js renders them as the
//                    Wayfarer constellation; index order matches DEEDS below).
// Plus: glimmer-wisps that ride with the hero, and letterboxed title cards
// the first time each named land is entered.
import * as THREE from 'three';
import { G, save, GLIMMER_TOTAL } from './state.js';
import { heightAt, slopeAt, WATER_Y, toonMat } from './terrain.js';
import { hash2, clamp, lerp, smoothstep } from './noise.js';
import { makeGlow, spawnSparkle, markSeen } from './world.js';
import { preloadModels, contractInstance, instantiate, findClip } from './assets.js';
import { isNight } from './sky.js';
import { bars } from './opening.js';

const tmpV = new THREE.Vector3();

// ------------------------------------------------------------- the writings

// One story in twelve fragments, scattered where each was carved.
const STONES = [
  { id: 'stone1', x: 55, z: -75, title: 'I — The Raising',
    text: 'We did not build the islands. We asked the land, and the land rose. Every stone that hangs above you once agreed to go.' },
  { id: 'stone2', x: -40, z: 40, title: 'II — The Fields',
    text: 'The Heartfields fed two worlds — one below, one above. Apples went up in baskets on the wind. Letters came down.' },
  { id: 'stone3', x: 97, z: 12, title: 'III — The Gates',
    text: 'The serpent-rings are doors. The sky-folk walked through them the way you walk through morning — certain there would be an evening.' },
  { id: 'stone4', x: 80, z: 188, title: 'IV — The Gold Wood',
    text: 'When the first island fell, Thornwood turned gold in a single night, the way hair goes grey. It has never turned back.' },
  { id: 'stone5', x: -27, z: 273, title: 'V — The Breath',
    text: 'The bellows are not machines. They are the valley breathing out, so that small things with cloth wings could come home.' },
  { id: 'stone6', x: -47, z: 208, title: 'VI — The Crossing',
    text: 'On the last day, the gates were opened wide and held. Not everyone crossed. Some stayed to tend the flames, knowing.' },
  { id: 'stone7', x: -150, z: 100, title: 'VII — The Mirror',
    text: 'The Mirrormere is not water. It is the piece of sky that fell gentlest, and on clear nights it still practices being the moon.' },
  { id: 'stone8', x: 109, z: 112, title: 'VIII — The Works',
    text: 'Every gear you find belonged to something that held something else aloft. The works did not fail. They were asked to let go.' },
  { id: 'stone9', x: -150, z: -92, title: 'IX — The Wardens',
    text: 'The wardens were not soldiers. They carried children on their shoulders and beacons on their backs. They knelt when there was no one left to carry.' },
  { id: 'stone10', x: -118, z: -252, title: 'X — The Storm',
    text: 'The storm that broke the sky circled for a hundred days. Stormridge stood into its teeth so the valley behind it could keep its roofs.' },
  { id: 'stone11', x: 260, z: -152, title: 'XI — The Silence',
    text: 'One by one the beacons closed their eyes. The last keeper sang to hers until morning, then hung her lantern on the wind and walked into the ring.' },
  { id: 'stone12', x: -280, z: -52, title: 'XII — The Promise',
    text: 'Carve this last: when every flame stands lit again, the wind will remember our names, and the sky will lean down to listen.' },
];

// Piet's letters — read in the order found, wherever the wind hides them.
const LETTERS = [
  { id: 'letter1', title: "Piet's Letter — the first",
    text: '"To whoever the wind finds — I am Piet, courier of the high isles, and I am writing this FALLING, which I want noted as dedication to the craft."' },
  { id: 'letter2', title: "Piet's Letter — the second",
    text: '"Update: not falling anymore. Landed in a very opinionated tree. Dear Mara of the Heartfields: your gran\'s parcel is fine. I ate one apple. Courier tax."' },
  { id: 'letter3', title: "Piet's Letter — the third",
    text: '"The isles look wrong from underneath, like reading the back of a letter. My leg is bad. Walking to the gold wood — Mara\'s farm is past it, I think. The birds here don\'t know me."' },
  { id: 'letter4', title: "Piet's Letter — the fourth",
    text: '"Cold night. I told the wind every name on every letter in my bag, in case it delivers faster than I do. It seemed interested. Wind makes a terrible courier. No pockets."' },
  { id: 'letter5', title: "Piet's Letter — the last",
    text: '"Friend — you caught these, so the wind kept my route. One kindness: there is a cairn beneath the gold trees where the wind turns. Tell it the letters arrived. A courier likes to know."' },
];

// Letters Home — the valley writes back. Each reply appears on the wind near
// its writer's home once you have earned it, and is caught like Piet's.
const REPLIES = [
  {
    id: 'reply_tilla', x: 26, z: -98, title: 'A Reply — from Tilla',
    ready: () => !!(G.tut.quests && G.tut.quests.tilla >= 3),
    text: '"Wanderer — I watched you go up the plateau like the hill owed you money. The stores are full again and I sleep with the window open now. If the sky-works wake, tell them the Gleaner kept faith. — T."',
  },
  {
    id: 'reply_ilyra', x: -146, z: 114, title: 'A Reply — from Ilyra',
    ready: () => !!(G.story && G.story.flags && G.story.flags.lanternsReported),
    text: '"The moon-road holds. Some nights I walk the shore and the five flames lean toward me like old friends leaning over a fence. You gave the lake back its memory. It has not forgotten who. — Ilyra Fen."',
  },
  {
    id: 'reply_sella', x: 46, z: -72, title: 'A Bill of Sale — from Sella',
    ready: () => {
      const t = G.story && G.story.adventure && G.story.adventure.trader;
      if (!t || !t.purchaseCounts) return false;
      return Object.values(t.purchaseCounts).reduce((n, c) => n + (Number(c) || 0), 0) >= 3;
    },
    text: '"RECEIVED: assorted gems, good conversation, proof the roads are worth walking. OWED: one favor, redeemable wherever my pack and I happen to be. The roads say hello. They talk about you, you know. — S. Vane, Road-Tinker."',
  },
  {
    id: 'reply_maren', x: 40, z: -86, title: 'A Reply — from Maren',
    ready: () => !!(G.story && G.story.flags && G.story.flags.coilCompleted),
    text: '"I taught you to walk and the wind taught you the rest — that is how I will tell it, anyway. Eight kept the valley, and I greeted the ninth by the fallen stone and did not know it. An old man can still be surprised. Good. — M."',
  },
];

const GLOAMS = [
  { id: 'gloam1', x: 97, z: 7, r: 36, title: 'The Parting',
    entry: 'Two amber figures at the serpent-gate: one crossed, one knelt and stayed. The ring held their shapes a hundred years, like a held breath.' },
  { id: 'gloam2', x: 109, z: 120, r: 34, title: 'The Offering',
    entry: 'An echo at the vault door: a keeper laying something small and loved against the stone, then looking up, the way you look at weather. Or farewell.' },
  { id: 'gloam3', x: -150, z: -100, r: 34, title: 'The Vigil',
    entry: 'An echo kneeling beside the kneeling warden, keeping it company. Whoever they were, they stayed long enough to leave a mark in the light.' },
];

// Deed-stars: index order here IS the constellation order in sky.js
// (DEED_POINTS — keep both arrays at 14 entries, same order). A deed with no
// matching point simply never draws a star; nothing crashes.
export const DEEDS = [
  { id: 'waking', verse: 'The First Light', hint: 'Wake beneath the broken sky.' },
  { id: 'beacon', verse: 'The First Answer', hint: 'Wake a beacon from its long dark.' },
  { id: 'beacons', verse: 'The Eight Flames', hint: 'Wake every beacon in Aerwyn.' },
  { id: 'towers', verse: 'The Three Watchers', hint: 'Chart every skywatch tower.' },
  { id: 'glimmers', verse: 'Nine Friends', hint: 'Find nine forest glimmers.' },
  { id: 'glimmerAll', verse: 'The Laughing Wood', hint: 'Find every last glimmer.' },
  { id: 'stones', verse: 'The Listening', hint: 'Hear all twelve hollow stones.' },
  { id: 'gloam', verse: 'Keeper of Echoes', hint: 'Witness the three gloamings.' },
  { id: 'letters', verse: 'The Last Delivery', hint: "Lay the courier's letters to rest." },
  { id: 'hart', verse: 'The Pale Hart', hint: 'Follow where the white one leads.' },
  { id: 'crimson', verse: 'Under the Bleeding Sky', hint: 'Keep your feet through a crimson moon.' },
  { id: 'longglide', verse: 'The Long Glide', hint: 'Ride the wind, unlanding, a long while.' },
  { id: 'skyhigh', verse: 'Above the Clouds', hint: 'Stand where only birds have stood.' },
  { id: 'mirror', verse: "The Mirror's Guest", hint: 'Swim the Mirrormere by moonlight.' },
  { id: 'echoes', verse: 'The Eight Names', hint: "Stand with every warden's echo." },
];

// Chronicle page order: the stones' story, then the echoes, then Piet.
export const CHRONICLE = [
  ...STONES.map(s => ({ id: s.id, title: 'The Hollow Stones · ' + s.title, text: s.text })),
  ...GLOAMS.map(g => ({ id: g.id, title: 'Gloaming · ' + g.title, text: g.entry })),
  ...LETTERS.map(l => ({ id: l.id, title: 'On the Wind · ' + l.title, text: l.text })),
  ...REPLIES.map(l => ({ id: l.id, title: 'Letters Home · ' + l.title, text: l.text })),
  { id: 'lettersLaid', title: "On the Wind · Piet's Cairn",
    text: 'The letters lie under the stones beneath the gold trees now. The feather charm turned all the while, like a route being planned. Delivered.' },
  { id: 'hartDone', title: 'The Pale Hart',
    text: 'At dawn a white hart waited, and did not run. It led the way old rivers lead — certain, unhurried — to a glade where a forgotten shrine woke for it. Not for you. That felt right.' },
  { id: 'boglinShrine', title: 'The Moss-Kin Shrine',
    text: 'Deep past the gold trees, the boglins ring a fallen sky-cog with totems and small offerings. They did not loot it; they knelt to it. Whatever broke the sky, the moss-kin remember it as a god falling — which means they remember it too.' },
];

// ------------------------------------------------------------- module state

// the cairn's prompt is pure derived state — one rule, applied everywhere
function cairnLabel() {
  if (G.lore.lettersLaid) return 'A quiet cairn';
  if (LETTERS.every(l => G.lore[l.id])) return 'Lay the letters to rest';
  return 'A lonely cairn';
}

const stones = [];            // {x,z,y,g,runeMats,pulse,id,idx}
const letters = [];           // {mesh,zone,ph,it,gone}
let lettersInit = false;
let cairn = null;             // {x,z,y,g,charm,it}
const wisps = [];             // sprites
let wispLight = null;
let wispTier = -1;
let knightReady = false;
let activeGloam = null;       // playing vignette
let card = { active: false, t: 0, el: null, nameEl: null };
let deedT = 0;
let crimsonT = 0;
let glideT = 0, bestGlide = 0;

// --------------------------------------------------------------- build

export function buildRemembering() {
  // whisper stones: procedural monolith now, GLB swap after preload
  STONES.forEach((s, i) => {
    // nudge inland if the carved spot ended up underwater
    let { x, z } = s;
    for (let n = 0; n < 8 && heightAt(x, z) < WATER_Y + 0.6; n++) {
      x -= Math.sign(x) * 4; z -= Math.sign(z) * 4;
    }
    const y = heightAt(x, z);
    const g = new THREE.Group();
    const rock = new THREE.Mesh(
      new THREE.CylinderGeometry(0.30, 0.48, 2.1, 6), toonMat({ color: 0x8d8577 }));
    rock.position.y = 1.0;
    rock.castShadow = true;
    const runeMat = new THREE.MeshBasicMaterial({
      color: 0x9fffc8, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false });
    const rune = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 1.3), runeMat);
    rune.position.set(0, 1.05, 0.42);
    g.add(rock, rune);
    g.position.set(x, y - 0.06, z);
    g.rotation.y = hash2(i, 761) * Math.PI * 2;
    g.rotation.z = (hash2(i, 763) - 0.5) * 0.1;
    G.scene.add(g);
    G.colliders.push({ x, z, r: 0.55, top: y + 2.0 });

    const st = { x, z, y, g, runeMats: [runeMat], pulse: 0, id: s.id, idx: i };
    stones.push(st);
    G.interactables.push({
      pos: new THREE.Vector3(x, y + 1, z), r: 3,
      label: 'Listen to the hollow stone',
      onUse() {
        G.ui.dialog('THE HOLLOW STONE', s.title + ' — ' + s.text, false);
        st.pulse = 1;
        G.audio.sfx('lock');
        G.audio.chord([174.6, 220], 0.05, 0.5);
        if (!G.lore[s.id]) {
          G.lore[s.id] = true;
          G.ui.toast('✦ Chronicle — ' + s.title, 0xbfe8ff, 4200);
          save();
        }
      },
    });
  });

  // Piet's cairn under the gold trees
  {
    const x = 58, z = 232;
    const y = heightAt(x, z);
    const g = new THREE.Group();
    const stoneMat = toonMat({ color: 0x8d8577 });
    for (const [sy, r] of [[0.22, 0.42], [0.55, 0.3], [0.8, 0.19]]) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 7, 5), stoneMat);
      m.position.y = sy; m.scale.y = 0.72; m.castShadow = true;
      g.add(m);
    }
    g.position.set(x, y - 0.05, z);
    G.scene.add(g);
    G.colliders.push({ x, z, r: 0.55, top: y + 0.9 });
    cairn = { x, z, y, g, charm: null, it: null };
    cairn.it = {
      pos: new THREE.Vector3(x, y + 0.8, z), r: 3,
      label: 'A lonely cairn',
      onUse() {
        const found = LETTERS.filter(l => G.lore[l.id]).length;
        if (G.lore.lettersLaid) {
          G.ui.toast('The cairn is quiet now. The feather charm turns in the wind.', 0xcfc4a6, 4200);
        } else if (found < LETTERS.length) {
          G.ui.dialog('A LONELY CAIRN',
            'Stones stacked with care, and a courier\'s feather charm turning in the wind. ' +
            (found === 0 ? 'It is waiting for something.'
                         : 'It is waiting for the rest of the letters. (' + found + ' of 5 caught)'), false);
          G.audio.sfx('lock');
        } else {
          G.lore.lettersLaid = true;
          this.label = cairnLabel();
          G.ui.dialog("PIET'S CAIRN",
            'You tell the wind the letters arrived. For a moment it stops — all of it, everywhere — and then it turns once around the cairn, like a route being finished.', false);
          G.ui.toast('✦ Chronicle — The Last Delivery', 0xffd9a0, 4600);
          G.items.feather++; markSeen('feather');
          G.items.shard++; markSeen('shard');
          if (G.player) { G.player.arrows += 10; G.ui.toast('Piet\'s satchel: +10 arrows, a feather, a star shard', 0x9fffb0, 4600); }
          spawnSparkle(x, y + 1.2, z, 0xffd9a0, 40, 4);
          G.audio.chord([293.7, 392, 587.3], 0.09, 0.3);
          save();
        }
      },
    };
    G.interactables.push(cairn.it);
  }

  // GLB upgrades + the knight clone the gloamings borrow
  preloadModels(['whisper_stone', 'cairn', 'knight']).then((res) => {
    if (res && res.whisper_stone) upgradeStones();
    if (res && res.cairn) upgradeCairn();
    if (res && res.knight) knightReady = true;
  }).catch(() => { });
}

function upgradeStones() {
  for (const st of stones) {
    const ci = contractInstance('whisper_stone');
    if (!ci) return;
    st.g.clear();
    ci.root.scale.setScalar(0.95 + hash2(st.idx, 771) * 0.35);
    st.g.add(ci.root);
    st.runeMats = ci.mats.EnergyGreen || [];
  }
}

function upgradeCairn() {
  const ci = contractInstance('cairn');
  if (!ci || !cairn) return;
  cairn.g.clear();
  cairn.g.add(ci.root);
  cairn.charm = ci.root.getObjectByName('Charm');
}

// --------------------------------------------------------------- letters

function initLetters() {
  lettersInit = true;
  // runs after applySave — derive the cairn's state for loaded saves
  if (cairn) cairn.it.label = cairnLabel();
  const zones = G.updraftZones.filter(z => z.expires === undefined).slice(0, 5);
  // fallback flutter spots if the world ever yields fewer than five updrafts
  while (zones.length < 5) {
    const i = zones.length;
    const x = [-80, 150, -30, 60, -200][i], z = [60, -60, 160, 120, 40][i];
    const h = heightAt(x, z);
    zones.push({ x, z, r: 4, bottomY: h + 2, topY: h + 12 });
  }
  const found = LETTERS.filter(l => G.lore[l.id]).length;
  const geo = new THREE.PlaneGeometry(0.36, 0.27);
  for (let i = found; i < 5; i++) {
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0xf2e8cf, side: THREE.DoubleSide }));
    const zone = zones[i];
    mesh.position.set(zone.x, (zone.bottomY + zone.topY) / 2, zone.z);
    G.scene.add(mesh);
    const rec = { mesh, zone, ph: i * 2.3, gone: false, it: null };
    rec.it = {
      pos: mesh.position, r: 3.2, label: 'Catch the letter',
      onUse() { catchLetter(rec); },
    };
    G.interactables.push(rec.it);
    letters.push(rec);
  }
}

function catchLetter(rec) {
  if (rec.gone) return;
  rec.gone = true;
  rec.it.gone = true;
  rec.mesh.visible = false;
  spawnSparkle(rec.mesh.position.x, rec.mesh.position.y, rec.mesh.position.z, 0xf2e8cf, 14, 2.5);
  // letters read in story order, whichever is caught
  const n = LETTERS.findIndex(l => !G.lore[l.id]);
  if (n < 0) return;
  const L = LETTERS[n];
  G.lore[L.id] = true;
  G.ui.dialog('A LETTER ON THE WIND', L.text, false);
  G.ui.toast('✉ Chronicle — ' + L.title + ' (' + (n + 1) + ' of 5)', 0xbfe8ff, 4600);
  G.audio.sfx('glimmer');
  if (n === LETTERS.length - 1 && cairn) {
    cairn.it.label = cairnLabel();
    G.ui.toast('The last letter speaks of a cairn beneath the gold trees...', 0xffd9a0, 5200);
  }
  save();
}

// Letters Home: spawn a reply the moment it is earned, in a low flutter
// pocket by its writer's home; caught with the same snatch-or-interact verbs.
const replies = []; // {def, mesh, zone, ph, gone, it}
let replyCheckT = 0;

function spawnReply(def) {
  const h = heightAt(def.x, def.z);
  const zone = { x: def.x, z: def.z, r: 3, bottomY: h + 1.5, topY: h + 8 };
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.36, 0.27),
    new THREE.MeshBasicMaterial({ color: 0xf7edd4, side: THREE.DoubleSide }));
  mesh.position.set(zone.x, h + 4, zone.z);
  G.scene.add(mesh);
  const rec = { def, mesh, zone, ph: Math.random() * 9, gone: false, it: null };
  rec.it = {
    pos: mesh.position, r: 3.2, label: 'Catch the letter',
    onUse() { catchReply(rec); },
  };
  G.interactables.push(rec.it);
  replies.push(rec);
}

function catchReply(rec) {
  if (rec.gone) return;
  rec.gone = true;
  rec.it.gone = true;
  rec.mesh.visible = false;
  spawnSparkle(rec.mesh.position.x, rec.mesh.position.y, rec.mesh.position.z, 0xf7edd4, 14, 2.5);
  G.lore[rec.def.id] = true;
  G.ui.dialog('A LETTER, ADDRESSED TO YOU', rec.def.text, false);
  G.ui.toast('✉ Chronicle — ' + rec.def.title, 0xbfe8ff, 4600);
  G.audio.sfx('glimmer');
  save();
}

function updateReplies(dt) {
  replyCheckT += dt;
  if (replyCheckT > 3) {
    replyCheckT = 0;
    for (const def of REPLIES) {
      if (G.lore[def.id] || replies.some(r => r.def === def)) continue;
      if (def.ready()) {
        spawnReply(def);
        G.ui.toast('Something pale tumbles on the wind, near ' +
          (def.id === 'reply_sella' ? 'the old road' : 'a friend\'s home') + '...', 0xf7edd4, 4600);
      }
    }
  }
  const p = G.player.pos;
  for (const rec of replies) {
    if (rec.gone) continue;
    const z = rec.zone;
    if ((p.x - z.x) ** 2 + (p.z - z.z) ** 2 > 140 * 140) continue;
    const t = G.time * 0.55 + rec.ph;
    const span = Math.max(3, z.topY - z.bottomY - 3);
    rec.mesh.position.set(
      z.x + Math.cos(t) * z.r * 0.6,
      z.bottomY + 1.5 + (Math.sin(t * 0.37 + rec.ph) * 0.5 + 0.5) * span,
      z.z + Math.sin(t) * z.r * 0.6);
    rec.mesh.rotation.set(Math.sin(t * 2.1) * 0.9, t * 1.4, Math.sin(t * 1.7) * 0.6);
    if ((p.x - rec.mesh.position.x) ** 2 + (p.y + 1.2 - rec.mesh.position.y) ** 2 +
        (p.z - rec.mesh.position.z) ** 2 < 1.9 * 1.9) {
      catchReply(rec);
    }
  }
}

function updateLetters(dt) {
  if (!lettersInit) { initLetters(); return; }
  updateReplies(dt);
  const p = G.player.pos;
  for (const rec of letters) {
    if (rec.gone) continue;
    const z = rec.zone;
    // sub-pixel from across the map — skip the flutter for far letters
    if ((p.x - z.x) ** 2 + (p.z - z.z) ** 2 > 140 * 140) continue;
    const t = G.time * 0.55 + rec.ph;
    const span = Math.max(3, z.topY - z.bottomY - 6);
    rec.mesh.position.set(
      z.x + Math.cos(t) * z.r * 0.5,
      z.bottomY + 3 + (Math.sin(t * 0.37 + rec.ph) * 0.5 + 0.5) * span,
      z.z + Math.sin(t) * z.r * 0.5);
    rec.mesh.rotation.set(Math.sin(t * 2.1) * 0.9, t * 1.4, Math.sin(t * 1.7) * 0.6);
    // glide straight through one to snatch it from the air (body-center test)
    if ((p.x - rec.mesh.position.x) ** 2 + (p.y + 1.2 - rec.mesh.position.y) ** 2 +
        (p.z - rec.mesh.position.z) ** 2 < 1.9 * 1.9) {
      catchLetter(rec);
    }
  }
}

// --------------------------------------------------------------- gloamings

const GHOST_HIDE = new Set(['1H_Sword_Offhand', '2H_Sword', 'Badge_Shield',
  'Rectangle_Shield', 'Spike_Shield', 'Knight_Cape', '1H_Sword']);

function makeGhost(anchor) {
  const inst = instantiate('knight');
  if (!inst) return null;
  const { root, clips } = inst;
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffc27a, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false });
  const box = new THREE.Box3();
  let has = false;
  root.traverse(o => {
    if (o.isSkinnedMesh) {
      o.frustumCulled = false;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      if (has) box.union(o.geometry.boundingBox); else { box.copy(o.geometry.boundingBox); has = true; }
    }
    if (o.isMesh) {
      o.castShadow = false;
      o.material = mat;
      if (GHOST_HIDE.has(o.name)) o.visible = false;
    }
  });
  const h = has ? (box.max.y - box.min.y) : 1.75;
  const container = new THREE.Group();
  container.scale.setScalar(1.75 / Math.max(0.01, h));
  if (has) root.position.y = -box.min.y;
  container.add(root);
  const glow = makeGlow(0xffc27a, 2.4);
  glow.material.opacity = 0;
  glow.position.y = 0.6;
  container.add(glow);
  const mixer = new THREE.AnimationMixer(root);
  const act = (name) => {
    const c = findClip(clips, name);
    return c ? mixer.clipAction(c) : null;
  };
  G.scene.add(container);
  return { container, mixer, act, mat, glow, cur: null, anchor,
    setClip(name, fade = 0.25) {
      const next = this.act(name);
      if (!next || next === this.cur) return;
      next.reset().play();
      if (this.cur) this.cur.crossFadeTo(next, fade, false);
      this.cur = next;
    },
    place(dx, dz, yaw) {
      const x = this.anchor.x + dx, z = this.anchor.z + dz;
      this.container.position.set(x, heightAt(x, z), z);
      if (yaw !== undefined) this.container.rotation.y = yaw;
    } };
}

// segment: {clip, dur, from:[dx,dz], to:[dx,dz], face:[dx,dz]?}
const GLOAM_SCRIPTS = {
  gloam1: [ // the Parting — one crosses the gate, one stays
    { clip: 'Walking_A', dur: 6.5, from: [-7, -5], to: [-0.5, -0.5] },
    { clip: 'Idle', dur: 3.5, from: [-0.5, -0.5], to: [-0.5, -0.5], face: [-5, -7] },
    { clip: 'Walking_A', dur: 3.5, from: [-0.5, -0.5], to: [2.5, 2], vanish: true },
  ],
  gloam1b: [ // the one who stayed
    { clip: 'Idle', dur: 7, from: [-5, -7], to: [-5, -7], face: [0, 0] },
    { clip: 'PickUp', dur: 3.5, from: [-5, -7], to: [-5, -7], face: [0, 0] },
    { clip: 'Idle', dur: 4, from: [-5, -7], to: [-5, -7], face: [0, 0] },
  ],
  gloam2: [ // the Offering — before the vault door (vault 1 faces -X)
    { clip: 'Walking_A', dur: 5.5, from: [-15, -3], to: [-5.8, 0] },
    { clip: 'PickUp', dur: 3.5, from: [-5.8, 0], to: [-5.8, 0], face: [0, 0] },
    { clip: 'Throw', dur: 2.5, from: [-5.8, 0], to: [-5.8, 0], face: [0, 0] },
    { clip: 'Idle', dur: 3.5, from: [-5.8, 0], to: [-5.8, 0], face: [0, 0] },
  ],
  gloam3: [ // the Vigil — keeping the warden company (vault 2 faces +Z)
    { clip: 'Walking_A', dur: 4.5, from: [4, 14], to: [1.5, 6] },
    { clip: 'Idle', dur: 4, from: [1.5, 6], to: [1.5, 6], face: [0, 0] },
    { clip: 'PickUp', dur: 3.5, from: [1.5, 6], to: [1.5, 6], face: [0, 0] },
    { clip: 'Idle', dur: 3.5, from: [1.5, 6], to: [1.5, 6], face: [0, 0] },
  ],
};

function startGloam(gl) {
  const ghosts = [];
  const a = makeGhost(gl);
  if (!a) return;
  ghosts.push({ ghost: a, script: GLOAM_SCRIPTS[gl.id], seg: 0, segT: 0 });
  if (gl.id === 'gloam1') {
    const b = makeGhost(gl);
    if (b) ghosts.push({ ghost: b, script: GLOAM_SCRIPTS.gloam1b, seg: 0, segT: 0 });
  }
  const total = Math.max(...ghosts.map(g => g.script.reduce((s, x) => s + x.dur, 0)));
  activeGloam = { gl, ghosts, t: 0, total, done: false };
  G.audio.chord([110, 164.8], 0.045, 0.9);
}

function endGloam(completed) {
  if (!activeGloam) return;
  for (const rec of activeGloam.ghosts) {
    G.scene.remove(rec.ghost.container);
  }
  if (completed) {
    const gl = activeGloam.gl;
    G.lore[gl.id] = true;
    G.ui.toast('✦ Chronicle — Gloaming: ' + gl.title, 0xffd9a0, 4600);
    G.audio.chord([220, 293.7], 0.05, 0.6);
    save();
  }
  activeGloam = null;
}

function updateGloams(dt, night) {
  const p = G.player.pos;
  if (activeGloam) {
    const ag = activeGloam;
    ag.t += dt;
    const distSq = (p.x - ag.gl.x) ** 2 + (p.z - ag.gl.z) ** 2;
    if (distSq > 70 * 70 || (!night && ag.t > 2)) { endGloam(false); return; }
    // amber presence: fade in 2.5s, hold, fade the last 3s
    const k = Math.min(ag.t / 2.5, 1, Math.max(0, (ag.total - ag.t) / 3));
    for (const rec of ag.ghosts) {
      const gh = rec.ghost;
      gh.mat.opacity = 0.24 * k;
      gh.glow.material.opacity = 0.1 * k;
      gh.mixer.update(dt);
      // advance the vignette script
      let seg = rec.script[rec.seg];
      if (seg) {
        rec.segT += dt;
        if (rec.segT >= seg.dur && rec.seg < rec.script.length - 1) {
          rec.seg++; rec.segT = 0; seg = rec.script[rec.seg];
        }
        if (rec.lastSeg !== rec.seg) { // crossfade only on segment changes
          gh.setClip(seg.clip);
          rec.lastSeg = rec.seg;
        }
        const sk = clamp(rec.segT / seg.dur, 0, 1);
        const e = smoothstep(0, 1, sk);
        const dx = lerp(seg.from[0], seg.to[0], e);
        const dz = lerp(seg.from[1], seg.to[1], e);
        let yaw;
        if (seg.face) yaw = Math.atan2(seg.face[0] - dx, seg.face[1] - dz);
        else if (seg.to[0] !== seg.from[0] || seg.to[1] !== seg.from[1])
          yaw = Math.atan2(seg.to[0] - seg.from[0], seg.to[1] - seg.from[1]);
        gh.place(dx, dz, yaw);
        if (seg.vanish) gh.mat.opacity *= Math.max(0, 1 - sk * 1.2);
      }
    }
    if (ag.t >= ag.total) endGloam(true);
    return;
  }
  if (!night || !knightReady) return;
  for (const gl of GLOAMS) {
    if (G.lore[gl.id]) continue;
    if ((p.x - gl.x) ** 2 + (p.z - gl.z) ** 2 < gl.r * gl.r) { startGloam(gl); return; }
  }
}

// --------------------------------------------------------------- wisps

const WISP_TOASTS = [
  'A glimmer slips from your hood to ride the air beside you.',
  'Another wisp joins the first. They gossip about your climbing.',
  'The wisps burn bright enough to light your way at night.',
];

function updateWisps(dt, night) {
  const tier = G.glimmers >= GLIMMER_TOTAL ? 3 : G.glimmers >= 12 ? 2 : G.glimmers >= 6 ? 1 : 0;
  if (wispTier === -1) wispTier = tier; // no fanfare for a loaded save
  else if (tier > wispTier) {
    G.ui.toast(WISP_TOASTS[tier - 1], 0x9fffb0, 4600);
    G.audio.sfx('glimmer');
    wispTier = tier;
  }
  while (wisps.length < tier) {
    const s = makeGlow(0x9fffb0, 0.55);
    s.material.opacity = 0.8;
    s.position.copy(G.player.pos);
    G.scene.add(s);
    wisps.push(s);
  }
  while (wisps.length > tier) G.scene.remove(wisps.pop());
  if (!wisps.length) return;
  const p = G.player.pos;
  const k = 1 - Math.exp(-3.2 * dt);
  for (let i = 0; i < wisps.length; i++) {
    const a = G.time * 0.9 + i * 2.1;
    tmpV.set(
      p.x + Math.cos(a) * (1.15 + Math.sin(G.time * 1.7 + i) * 0.2),
      p.y + 1.55 + Math.sin(G.time * 1.3 + i * 1.4) * 0.28,
      p.z + Math.sin(a) * (1.15 + Math.cos(G.time * 1.5 + i) * 0.2));
    wisps[i].position.lerp(tmpV, k);
  }
  if (tier >= 3 && !wispLight) {
    wispLight = new THREE.PointLight(0xcaffd8, 0, 15, 1.6);
    G.scene.add(wispLight);
  }
  if (wispLight) {
    wispLight.position.copy(wisps[0].position);
    const want = tier >= 3 && night ? 1.15 : 0;
    wispLight.intensity = lerp(wispLight.intensity, want, k);
  }
}

// --------------------------------------------------------------- title cards

function ensureCardEl() {
  if (card.el) return;
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;left:0;right:0;top:27%;text-align:center;' +
    'z-index:52;pointer-events:none;opacity:0;';
  el.innerHTML =
    '<div style="font:400 13px Cinzel,Georgia;letter-spacing:8px;color:#b8ac8c">— ❖ —</div>' +
    '<div id="landname" style="font:600 46px Cinzel,Georgia;letter-spacing:12px;' +
    'color:#f4e6c2;text-shadow:0 2px 22px rgba(0,0,0,.75);margin-top:10px"></div>' +
    '<div style="width:280px;height:1px;margin:16px auto 0;background:linear-gradient(' +
    '90deg,transparent,rgba(226,203,141,.7),transparent)"></div>';
  document.body.appendChild(el);
  card.el = el;
  card.nameEl = el.querySelector('#landname');
}

function showCard(name) {
  ensureCardEl();
  card.nameEl.textContent = name.toUpperCase();
  card.active = true;
  card.t = 0;
  bars(true, false); // letterbox without the opening's skip hint
  G.regionsSeen[name] = true;
  save();
  // a rising harp-line in the world's own key
  G.audio.chord([293.7, 392, 440, 587.3, 659.3], 0.08, 0.2);
}

// Returns true when the big card takes the moment (suppresses the small
// reveal). When the moment is taken — mid-cinematic or another card showing —
// fall back to the small reveal and leave the region unmarked, so its card
// simply plays on a later entry. No queue: a queued card would announce a
// region the player already left.
export function onRegionEnter(name) {
  if (!G.started || G.regionsSeen[name]) return false;
  if (G.cinematic || card.active) return false;
  showCard(name);
  return true;
}

function updateCard(dt) {
  if (!card.active) return;
  card.t += dt;
  const t = card.t;
  card.el.style.opacity = Math.min(t / 1.1, 1, Math.max(0, (4.9 - t) / 1.1)).toFixed(3);
  if (t >= 4.9) {
    card.active = false;
    if (!G.cinematic) bars(false); // never yank the opening's letterbox
  }
}

// --------------------------------------------------------------- deed-stars

const DEED_CHECKS = {
  waking: () => !!G.tut.openingDone,
  beacon: () => G.shrines.some(s => s.active),
  beacons: () => G.shrines.length > 0 && G.shrines.every(s => s.active),
  towers: () => G.towers.length > 0 && G.towers.every(t => t.active),
  glimmers: () => G.glimmers >= 9,
  glimmerAll: () => G.glimmers >= GLIMMER_TOTAL,
  stones: () => STONES.every(s => G.lore[s.id]),
  gloam: () => GLOAMS.every(g => G.lore[g.id]),
  letters: () => !!G.lore.lettersLaid,
  hart: () => !!G.lore.hartDone,
  crimson: () => crimsonT >= 30,
  longglide: () => bestGlide >= 20,
  skyhigh: () => G.player.pos.y > 80,
  mirror: () => G.player.mode === 'swim' && isNight() &&
    Math.hypot(G.player.pos.x + 170, G.player.pos.z - 120) < 32,
  echoes: () => {
    const f = G.story && G.story.flags;
    if (!f) return false;
    for (let i = 0; i < 8; i++) if (!f['wardenMet_' + i]) return false;
    return true;
  },
};

function syncStars() {
  G.deedStars = DEEDS.map(d => !!G.deeds[d.id]);
}

function updateDeeds(dt) {
  // one unbroken night on your feet — the counter resets at every dawn
  if (G.bloodNight) crimsonT += dt; else crimsonT = 0;
  if (G.player.mode === 'glide') { glideT += dt; if (glideT > bestGlide) bestGlide = glideT; }
  else glideT = 0;
  deedT += dt;
  if (deedT < 0.8) return;
  deedT = 0;
  if (!G.deedStars) syncStars();
  for (const d of DEEDS) {
    if (G.deeds[d.id]) continue;
    if (DEED_CHECKS[d.id]()) {
      G.deeds[d.id] = true;
      syncStars();
      save();
      G.ui.toast('★ A star kindles — "' + d.verse + '"', 0xffd9a0, 5600);
      G.audio.chord([587.3, 880, 1174.7], 0.06, 0.18);
      return; // one star a beat — let each kindling breathe
    }
  }
}

// --------------------------------------------------------------- update

export function updateRemembering(dt, night) {
  updateLetters(dt);
  updateGloams(dt, night);
  updateWisps(dt, night);
  updateCard(dt);
  updateDeeds(dt);

  // whisper stones breathe; louder for a beat after speaking
  const p = G.player.pos;
  for (const st of stones) {
    if (st.pulse > 0) st.pulse = Math.max(0, st.pulse - dt * 0.7);
    if ((p.x - st.x) ** 2 + (p.z - st.z) ** 2 > 90 * 90) continue;
    const glow = 0.55 + Math.sin(G.time * 1.6 + st.idx * 1.7) * 0.25 + st.pulse * 2.2;
    for (const m of st.runeMats) {
      if (m.emissiveIntensity !== undefined) m.emissiveIntensity = 1.1 * glow;
      else m.opacity = clamp(0.5 * glow, 0.15, 0.95);
    }
  }
  // the feather charm on Piet's cairn turns in the wind
  if (cairn && cairn.charm) {
    cairn.charm.rotation.y = Math.sin(G.time * 0.7) * 0.5;
    cairn.charm.rotation.z = Math.sin(G.time * 1.9) * 0.2;
  }
}
