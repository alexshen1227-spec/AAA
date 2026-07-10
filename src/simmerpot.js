// The Simmerpot — earned, not given.
//
// Share a fire with someone first (Emberside), and a pot appears at every
// hearth. Then the valley starts feeding you: bramble-berries in the
// Thornwood thickets, stormcaps that fruit only after honest rain on the
// Stormridge, reed-hearts along the river. Six recipes across five
// ingredients, eaten hot at the fire — the fire is the kitchen.
// Forage regrows with the days; nothing here is a checklist, only weather
// and places and knowing when to look.
import * as THREE from 'three';
import { G } from './state.js';
import { heightAt, slopeAt, inRiver, WATER_Y, toonMat } from './terrain.js';
import { spawnSparkle, spawnHealBloom, markSeen } from './world.js';
import { propInstance, preloadModels } from './assets.js';

const HEARTHS = [
  { x: 27, z: -106 }, { x: -143, z: 111 }, { x: 3, z: 317 },
];

const RECIPES = [
  {
    id: 'stew', name: 'Mushroom Stew', needs: { mushroom: 1, reedheart: 1 },
    line: 'Thick enough to stand a spoon in. Every heart returns, and your limbs hum with river-vigor.',
    eat() {
      G.hearts = G.maxHearts;
      G.buffs.vigorUntil = G.time + 30;
      if (G.player) spawnHealBloom(G.player.pos.x, G.player.pos.y, G.player.pos.z);
    },
  },
  {
    id: 'pot', name: 'Wayfarer\'s Pot', needs: { apples: 1, mushroom: 1 },
    line: 'The old road recipe: apple sweetness against mushroom depth. Every heart returns.',
    eat() {
      G.hearts = G.maxHearts;
      if (G.player) spawnHealBloom(G.player.pos.x, G.player.pos.y, G.player.pos.z);
    },
  },
  {
    id: 'skewer', name: 'Stormcap Skewer', needs: { stormcap: 2 },
    line: 'It tastes like the smell before thunder. Three hearts, and the cold stops mattering.',
    eat() { G.hearts = Math.min(G.maxHearts, G.hearts + 12); },
  },
  {
    id: 'seared', name: 'Seared Apples', needs: { apples: 2 },
    line: 'Fire teaches the apple what it always wanted to be. Two hearts return.',
    eat() { G.hearts = Math.min(G.maxHearts, G.hearts + 8); },
  },
  {
    id: 'preserve', name: 'Bramble Preserve', needs: { apples: 1, berry: 1 },
    line: 'Sharp-sweet and warming. One heart, and your stride quickens a while.',
    eat() {
      G.hearts = Math.min(G.maxHearts, G.hearts + 4);
      G.buffs.swiftUntil = G.time + 15;
    },
  },
  {
    id: 'crisp', name: 'Reed Crisp', needs: { reedheart: 1, berry: 1 },
    line: 'Piet\'s trail food, done properly at last. The whole stamina wheel refills, light-footed.',
    eat() {
      G.stamina = G.maxStamina;
      if (G.player) G.player.exhausted = false;
      G.buffs.swiftUntil = G.time + 10;
    },
  },
];

let built = false;
const forage = []; // {kind, x, z, root, it, takenDay, transient}
const pots = [];   // {root, it, shown}
let quote = { recipeId: null, until: 0, potIndex: -1 };
let lastRainAt = -999;

const flag = id => !!(G.story && G.story.flags && G.story.flags[id]);

function have(kind) {
  return kind === 'apples' ? (Number(G.apples) || 0) : (Number(G.items[kind]) || 0);
}
function spend(kind, n) {
  if (kind === 'apples') G.apples -= n;
  else G.items[kind] -= n;
}
function canCook(recipe) {
  return Object.entries(recipe.needs).every(([k, n]) => have(k) >= n);
}

// ---- forage sites ------------------------------------------------------------

function probe(cx, cz, spread, ok) {
  for (let i = 0; i < 40; i++) {
    const a = i * 2.399963;
    const r = (i / 40) * spread;
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    const y = heightAt(x, z);
    if (y < WATER_Y + 0.6 || slopeAt(x, z) > 0.45) continue;
    if (ok && !ok(x, z, y)) continue;
    return { x, z, y };
  }
  return null;
}

function addForage(kind, model, label, x, z, transient) {
  const y = heightAt(x, z);
  const root = new THREE.Group();
  root.position.set(x, y, z);
  G.scene.add(root);
  preloadModels([model]).then(() => {
    const inst = propInstance(model);
    if (inst) root.add(inst);
  }).catch(() => { });
  const rec = { kind, x, z, root, takenDay: -99, transient };
  rec.it = {
    id: `forage_${kind}_${forage.length}`,
    pos: new THREE.Vector3(x, y + 0.5, z), r: 2.4, label,
    onUse() { gather(rec); },
  };
  G.interactables.push(rec.it);
  forage.push(rec);
}

function forageAvailable(rec) {
  if (rec.takenDay === G.dayCount) return false;
  if (rec.transient) {
    // stormcaps fruit after honest rain and stand until the next dawn
    return G.time - lastRainAt < 600 && lastRainAt > 0;
  }
  return true;
}

function gather(rec) {
  if (!forageAvailable(rec)) {
    if (rec.transient) {
      G.ui.dialog('BARE GROUND', 'Only the smell of them remains. Stormcaps fruit after honest rain — come back wet.', false);
    } else {
      G.ui.toast('Picked clean. The valley regrows with the days.', 0xcccccc);
    }
    return;
  }
  rec.takenDay = G.dayCount;
  const n = 1 + (Math.random() < 0.4 ? 1 : 0);
  G.items[rec.kind] = (Number(G.items[rec.kind]) || 0) + n;
  markSeen(rec.kind);
  spawnSparkle(rec.x, heightAt(rec.x, rec.z) + 0.6, rec.z, 0xbfe8a0, 14, 2);
  G.audio.sfx('pickup');
}

function buildForage() {
  // bramble thickets in the Thornwood
  const thicketSeeds = [[92, 208], [70, 188], [104, 226], [58, 206], [86, 240], [112, 196]];
  for (const [cx, cz] of thicketSeeds) {
    const p = probe(cx, cz, 14);
    if (p) addForage('berry', 'bramble_berries', 'Gather bramble-berries', p.x, p.z, false);
  }
  // reed-hearts along the river banks
  let reeds = 0;
  for (let i = 0; i < 400 && reeds < 6; i++) {
    const x = (Math.sin(i * 12.9898) * 0.5 + 0.5 - 0.5) * 500;
    const z = (Math.sin(i * 78.233) * 0.5 + 0.5 - 0.5) * 500;
    if (inRiver(x, z)) continue;
    // a bank: dry here, river within a few strides
    if (!inRiver(x + 4, z) && !inRiver(x - 4, z) && !inRiver(x, z + 4) && !inRiver(x, z - 4)) continue;
    const y = heightAt(x, z);
    if (y < WATER_Y + 0.4 || slopeAt(x, z) > 0.5) continue;
    addForage('reedheart', 'reed_heart', 'Cut a reed-heart', x, z, false);
    reeds++;
  }
  // stormcap rings on the Stormridge (transient: after rain only)
  const capSeeds = [[-104, -238], [-134, -268], [-92, -262], [-150, -240]];
  for (const [cx, cz] of capSeeds) {
    const p = probe(cx, cz, 12);
    if (p) addForage('stormcap', 'stormcap', 'Pick stormcaps', p.x, p.z, true);
  }
}

// ---- the pots ----------------------------------------------------------------

function buildPots() {
  for (let i = 0; i < HEARTHS.length; i++) {
    const h = HEARTHS[i];
    const y = heightAt(h.x, h.z);
    const root = new THREE.Group();
    root.position.set(h.x, y, h.z);
    root.visible = false;
    G.scene.add(root);
    preloadModels(['simmerpot']).then(() => {
      const inst = propInstance('simmerpot');
      if (inst) root.add(inst);
      else {
        const pot = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), toonMat({ color: 0x33363c }));
        pot.position.y = 0.5;
        root.add(pot);
      }
    }).catch(() => { });
    const potIndex = i;
    const it = {
      id: `simmerpot_${i}`, pos: new THREE.Vector3(h.x, y + 0.7, h.z), r: 2.6,
      label: 'Cook at the simmerpot', gone: true, // inert until earned
      onUse() { useSimmerpot(potIndex); },
    };
    G.interactables.push(it);
    pots.push({ root, it, shown: false });
  }
}

function useSimmerpot(potIndex) {
  const cookable = RECIPES.filter(canCook);
  if (!cookable.length) {
    G.ui.dialog('THE SIMMERPOT',
      'The broth waits. It wants pairs: apples, berries, reed-hearts, mushrooms, stormcaps — any honest two that belong together.', false);
    G.audio.sfx('lock');
    return;
  }
  const now = G.time;
  const current = cookable.find(r => r.id === quote.recipeId);
  if (quote.potIndex === potIndex && current && now < quote.until) {
    // second press: cook and eat it hot
    for (const [k, n] of Object.entries(current.needs)) spend(k, n);
    current.eat();
    quote = { recipeId: null, until: 0, potIndex: -1 };
    const h = HEARTHS[potIndex];
    spawnSparkle(h.x, heightAt(h.x, h.z) + 0.9, h.z, 0xffb45c, 26, 3);
    G.audio.sfx('eat');
    G.audio.chord([330, 392], 0.06, 0.2);
    G.ui.toast(current.name + ' — eaten hot at the fire.', 0xffb45c, 4600);
    return;
  }
  // first press (or cycle): quote the next cookable recipe
  const idx = current ? (cookable.indexOf(current) + 1) % cookable.length : 0;
  const next = cookable[idx];
  quote = { recipeId: next.id, until: now + 10, potIndex };
  const needsText = Object.entries(next.needs)
    .map(([k, n]) => `${n} ${k === 'apples' ? 'apple' : k}${n > 1 ? 's' : ''}`).join(' + ');
  G.ui.dialog('THE SIMMERPOT', `${next.name} (${needsText}): ${next.line} Speak again to cook it.`, true);
  G.audio.sfx('ui_open');
}

export function updateSimmerpot(dt = 0) {
  if (!G.started || !G.scene) return;
  if (!built) {
    built = true;
    buildForage();
    buildPots();
  }
  // rain memory feeds the stormcaps
  if (G.weather && G.weather.rainTime > 3) lastRainAt = G.time;
  // the pot is earned by company
  const earned = flag('embersideShared');
  for (const pot of pots) {
    if (pot.shown !== earned) {
      pot.shown = earned;
      pot.root.visible = earned;
      pot.it.gone = !earned;
    }
  }
  // transient forage shows and hides with the weather's memory
  for (const rec of forage) {
    rec.root.visible = forageAvailable(rec);
  }
}

export function getSimmerpotSummary() {
  return {
    built,
    forage: forage.map(f => ({ kind: f.kind, available: forageAvailable(f) })),
    potsShown: pots.filter(p => p.shown).length,
    cookable: RECIPES.filter(canCook).map(r => r.id),
  };
}
