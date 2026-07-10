// Gubbin the Craven — the first boglin who would rather talk than fight.
//
// He fled his camp before a blood night and has been hiding in the Deepwood
// since, clutching a secret he is desperate to trade for the promise that
// nobody will make him hold a club again. Approach with your weapon put away
// and he speaks; draw steel or nock an arrow anywhere near him and he bolts
// for the ferns. Sheathe-to-talk: an enemy resolved by a gesture, not a
// fight, and the first crack in the moss-kin faction.
import * as THREE from 'three';
import { G, save } from './state.js';
import { heightAt, toonMat } from './terrain.js';
import { spawnSparkle, makeChest } from './world.js';
import { propInstance, preloadModels } from './assets.js';

const HOME = { x: 116, z: 236 };      // tucked in the Deepwood grove
const CACHE = { x: 138, z: 262 };     // where his rumor leads

const LINES = [
  ['A SMALL VOICE IN THE FERNS',
    'Don\'t — don\'t hit. Please. Gubbin isn\'t fighting. Gubbin NEVER liked the fighting. The others took a club and a name off the totem, but Gubbin took the long way round the swamp instead.', true],
  ['GUBBIN THE CRAVEN',
    'They call me craven. Craven! Like it\'s a bad thing to want to keep all your own teeth. I ran before the red moon and I have been hiding under this gold tree ever since, eating the sweet reeds and being AFRAID, which I am very good at.', true],
  ['GUBBIN THE CRAVEN',
    'You didn\'t swing. Nobody big ever DIDN\'T swing before. Here — Gubbin knows things. There\'s a hollow east of here, past the leaning stones, where the camp hid its shinies before the moon. They forgot it. Gubbin never forgets a hiding place. It is the ONE thing Gubbin is brave about.', true],
  ['GUBBIN THE CRAVEN',
    'Go on. Take it. Just... if you see the others, you never saw Gubbin. Gubbin was never here. Gubbin is very, very good at never being anywhere.', false],
];

let built = false;
let gubbin = null;   // {root, mats, it, spookT, home}
let cacheMade = false;

const flag = id => !!(G.story && G.story.flags && G.story.flags[id]);
const playerArmed = () => {
  const p = G.player;
  return !!p && (p.aiming || (p.attackT !== undefined && p.attackT >= 0) || p.guarding);
};

function buildGubbin() {
  built = true;
  const y = heightAt(HOME.x, HOME.z);
  const root = new THREE.Group();
  root.position.set(HOME.x, y, HOME.z);
  root.rotation.y = Math.atan2(124 - HOME.x, 246 - HOME.z);
  G.scene.add(root);
  const mats = [];
  preloadModels(['boglin']).then(() => {
    const inst = propInstance('boglin');
    if (!inst) {
      const fallback = new THREE.Mesh(new THREE.SphereGeometry(0.4, 8, 6), toonMat({ color: 0x8fa07a }));
      fallback.position.y = 0.7;
      root.add(fallback);
      return;
    }
    // craven kit: keep his hood pulled low, throw the club and war-gear away
    for (const drop of ['club', 'skullcap', 'mosscloak', 'warpaint']) {
      const n = inst.getObjectByName(drop);
      if (n && n.parent) n.parent.remove(n);
    }
    const hood = inst.getObjectByName('hood');
    if (hood) hood.visible = true;
    // wash him a pale, sickly-anxious green, distinct from the ember camp kin
    inst.traverse(o => {
      if (o.isMesh && o.material && o.material.color) {
        const m = o.material.clone();
        if (m.color.r > 0.45 && m.color.g < 0.45) m.color.setHex(0x9fb488); // ember skin -> craven pale
        else m.color.multiplyScalar(0.9);
        o.material = m;
        mats.push(m);
      }
    });
    inst.scale.setScalar(0.92); // a small, hunched thing
    root.add(inst);
  }).catch(() => { });

  const it = {
    id: 'npc_gubbin', pos: new THREE.Vector3(HOME.x, y + 1, HOME.z), r: 3.2,
    label: 'Speak softly (weapon away)',
    onUse() { useGubbin(); },
  };
  G.interactables.push(it);
  gubbin = { root, mats, it, spookT: 0, home: new THREE.Vector3(HOME.x, y, HOME.z), line: 0 };
  if (flag('gubbinMet')) gubbin.line = LINES.length - 1;
}

function useGubbin() {
  if (playerArmed() || gubbin.spookT > 0) {
    G.ui.toast('He\'s bolted into the ferns. Put your weapon away and try again.', 0xcccccc);
    return;
  }
  const i = Math.min(gubbin.line, LINES.length - 1);
  const [name, text, more] = LINES[i];
  G.ui.dialog(name, text, more);
  G.audio.sfx(i === 0 ? 'lock' : 'ui_open');
  if (i === 2 && !cacheMade) {
    cacheMade = true;
    makeChest('chest.gubbin-hoard', CACHE.x, heightAt(CACHE.x, CACHE.z), CACHE.z,
      1.4, { kind: 'gems', n: 7 });
    spawnSparkle(CACHE.x, heightAt(CACHE.x, CACHE.z) + 0.6, CACHE.z, 0xffdf8a, 8, 2);
  }
  if (!flag('gubbinMet') && gubbin.line >= LINES.length - 1) {
    setGubbinMet();
  }
  gubbin.line = Math.min(gubbin.line + 1, LINES.length - 1);
}

function setGubbinMet() {
  if (flag('gubbinMet')) return;
  if (G.story && G.story.flags) G.story.flags.gubbinMet = true;
  if (!G.lore) G.lore = {};
  if (!G.lore.gubbin) {
    G.lore.gubbin = true;
    G.ui.toast('✦ Chronicle — Gubbin the Craven', 0xbfe8ff, 4200);
  }
  save();
}

function spook() {
  if (!gubbin || gubbin.spookT > 0) return;
  gubbin.spookT = 6;
  G.ui.dialog('', null); // drop any open conversation
  spawnSparkle(gubbin.root.position.x, gubbin.root.position.y + 0.6, gubbin.root.position.z, 0x9fb488, 10, 2);
  if (G.audio) G.audio.sfx('lock');
}

export function updateGubbin(dt = 0) {
  if (!G.started || !G.scene) return;
  if (!built) {
    buildGubbin();
    return;
  }
  const step = Math.min(Number.isFinite(dt) && dt > 0 ? dt : 0, 0.05);
  const p = G.player ? G.player.pos : null;
  if (!p) return;
  const near = Math.hypot(p.x - gubbin.home.x, p.z - gubbin.home.z) < 9;

  // steel near his hiding place sends him scurrying
  if (near && playerArmed() && gubbin.spookT <= 0) spook();

  if (gubbin.spookT > 0) {
    gubbin.spookT -= step;
    // he hunkers behind a tree: sink and hide until it passes
    const hide = Math.min(1, (6 - gubbin.spookT) / 0.6) * Math.min(1, gubbin.spookT / 0.6 + 0.2);
    gubbin.root.position.y = gubbin.home.y - hide * 1.4;
    gubbin.it.gone = gubbin.spookT > 0.4;
    if (gubbin.spookT <= 0) {
      gubbin.root.position.y = gubbin.home.y;
      gubbin.it.gone = false;
    }
    return;
  }

  // at ease: a small anxious sway, and he turns to face a peaceful visitor
  gubbin.root.position.y = gubbin.home.y + Math.sin(G.time * 2.3) * 0.02;
  if (near && !playerArmed()) {
    const want = Math.atan2(p.x - gubbin.home.x, p.z - gubbin.home.z);
    let d = want - gubbin.root.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    gubbin.root.rotation.y += d * Math.min(1, step * 3);
  }
}

export function getGubbinSummary() {
  return gubbin ? {
    built, met: flag('gubbinMet'), line: gubbin.line,
    spooked: gubbin.spookT > 0, cacheMade,
  } : { built };
}
