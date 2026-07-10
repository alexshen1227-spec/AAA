// The Sixth's Vigil — Stormridge earns its warden.
//
// The Sixth kept the crystals and sang to them on cold nights so they would
// not dim. Now, at night, the five clusters of the massif resonate: touch
// one and it holds a pure tone until dawn. Wake all five in a single night
// and her echo stands at the great crystal, still keeping the last watch.
// The tone and the remembering are the whole payment — no loot.
import * as THREE from 'three';
import { G, save } from './state.js';
import { heightAt, toonMat } from './terrain.js';
import { spawnSparkle } from './world.js';
import { propInstance, preloadModels } from './assets.js';

// three sites reuse the crystals world.js already plants; two are new
const SITES = [
  { x: -104, z: -232, note: 261.63, place: false },
  { x: -140, z: -276, note: 329.63, place: false, great: true },
  { x: -88, z: -270, note: 392.0, place: false },
  { x: -162, z: -242, note: 440.0, place: true },
  { x: -118, z: -302, note: 523.25, place: true },
];

let built = false;
const crystals = []; // {site, glow, lit, litNight}
let echo = null;     // {group, mat, it}
let toneAt = 0;

const isNightNow = () => G.dayTime < 0.21 || G.dayTime > 0.79;
function nightId() {
  return G.dayTime > 0.79 ? G.dayCount : G.dayTime < 0.21 ? G.dayCount - 1 : null;
}

function makeGlowSprite(color, scale) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 31);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(c), color, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  sprite.scale.setScalar(scale);
  return sprite;
}

function buildVigil() {
  built = true;
  for (const site of SITES) {
    const y = heightAt(site.x, site.z);
    if (site.place) {
      const m = propInstance('pk_crystal');
      if (m) {
        m.position.set(site.x, y - 0.06, site.z);
        m.rotation.y = site.note; // arbitrary but stable
        m.scale.setScalar(1.5);
        G.scene.add(m);
        G.colliders.push({ x: site.x, z: site.z, r: 1.0, top: y + 1.6 });
      }
    }
    const glow = makeGlowSprite(0xbfd8ff, 3.2);
    glow.position.set(site.x, y + 1.6, site.z);
    G.scene.add(glow);
    const rec = { site, glow, lit: false, litNight: null };
    crystals.push(rec);
    G.interactables.push({
      id: `vigil_crystal_${site.note | 0}`,
      pos: new THREE.Vector3(site.x, y + 1.2, site.z), r: 2.8,
      label: 'Touch the crystal',
      onUse() { touchCrystal(rec); },
    });
  }
  // her echo waits, unseen, by the great crystal
  const great = SITES.find(s => s.great);
  const gy = heightAt(great.x, great.z);
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
  group.position.set(great.x + 1.8, gy, great.z + 1.2);
  G.scene.add(group);
  echo = {
    group, mat,
    it: {
      id: 'vigil_echo', pos: new THREE.Vector3(great.x + 1.8, gy + 1, great.z + 1.2),
      r: 3, label: 'Stand with the Sixth',
      onUse() { meetSixth(); },
    },
  };
  G.interactables.push(echo.it);
}

function litCount() {
  const n = nightId();
  return crystals.filter(c => c.lit && c.litNight === n).length;
}

function echoWaiting() {
  return litCount() >= SITES.length && !G.lore.sixthVigil && isNightNow();
}

function touchCrystal(rec) {
  if (!isNightNow()) {
    G.ui.dialog('THE COLD CRYSTAL',
      'By day it is only stone and light. The Sixth sang to them at NIGHT — cold nights, when the dimming was worst.', false);
    G.audio.sfx('lock');
    return;
  }
  const n = nightId();
  if (rec.lit && rec.litNight === n) {
    G.audio.pianoNote(rec.site.note, G.audio.ctx.currentTime, 0.06, 3);
    return;
  }
  rec.lit = true;
  rec.litNight = n;
  G.audio.pianoNote(rec.site.note, G.audio.ctx.currentTime, 0.09, 4);
  spawnSparkle(rec.site.x, heightAt(rec.site.x, rec.site.z) + 1.6, rec.site.z, 0xbfd8ff, 24, 3.5);
  const count = litCount();
  if (count < SITES.length) {
    G.ui.toast(`The crystal holds its tone — ${count} of ${SITES.length}, before dawn takes them.`, 0xbfd8ff, 4600);
  } else if (!G.lore.sixthVigil) {
    G.ui.toast('Five tones hold together in the cold. By the great crystal, something amber is waiting.', 0xffc27a, 6000);
    G.audio.chord(SITES.map(s => s.note), 0.07, 0.5);
  }
}

function meetSixth() {
  if (!echoWaiting()) {
    G.ui.dialog('THE GREAT CRYSTAL',
      G.lore.sixthVigil
        ? 'The crystals hold their light better now. Somewhere in the cold, someone is humming.'
        : 'Nothing stands here. The crystals are dim, or the night is wrong, or both.', false);
    return;
  }
  G.lore.sixthVigil = true;
  G.ui.dialog('THE SIXTH\'S ECHO',
    'She is singing — too low to hear, the way she always did. Five tones answer her from across the massif. She turns to you, and does not stop singing, and somehow you understand: the song was never for the crystals. It was for whoever had to keep them next.', false);
  G.ui.toast('✦ Chronicle — The Sixth\'s Vigil', 0xbfe8ff, 4600);
  G.audio.chord(SITES.map(s => s.note), 0.1, 0.8);
  spawnSparkle(echo.group.position.x, echo.group.position.y + 1.4, echo.group.position.z, 0xffc27a, 40, 4.5);
  save();
}

export function updateVigil(dt = 0) {
  if (!G.started || !G.scene) return;
  if (!built) {
    preloadModels(['pk_crystal']).catch(() => { });
    buildVigil();
  }
  const step = Math.min(Number.isFinite(dt) && dt > 0 ? dt : 0, 0.05);
  const n = nightId();
  const night = isNightNow();
  for (const rec of crystals) {
    const holds = night && rec.lit && rec.litNight === n;
    if (!holds && rec.lit && rec.litNight !== n) { rec.lit = false; rec.litNight = null; }
    const target = holds ? 0.55 : 0;
    rec.glow.material.opacity += (target - rec.glow.material.opacity) * Math.min(1, step * 2);
  }
  // the held tones breathe every so often while lit
  if (night && G.time > toneAt) {
    toneAt = G.time + 9 + Math.random() * 6;
    const holding = crystals.filter(c => c.lit && c.litNight === n);
    if (holding.length) {
      const rec = holding[(Math.random() * holding.length) | 0];
      G.audio.pianoNote(rec.site.note, G.audio.ctx.currentTime, 0.035, 3.5);
    }
  }
  if (echo) {
    const target = echoWaiting() ? 0.32 : 0;
    echo.mat.opacity += (target - echo.mat.opacity) * Math.min(1, step * 1.5);
    if (echo.mat.opacity > 0.02 && G.player) {
      echo.group.rotation.y = Math.atan2(
        G.player.pos.x - echo.group.position.x, G.player.pos.z - echo.group.position.z);
    }
  }
}

export function getVigilSummary() {
  return {
    built,
    lit: litCount(),
    nightId: nightId(),
    echoWaiting: echoWaiting(),
    done: !!G.lore.sixthVigil,
  };
}
