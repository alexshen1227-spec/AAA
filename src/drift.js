// The Drift — a high glide-road of four small isles arcing from the Coil to
// the serene southern isle. It manifests once the ouroboros gates open (the
// joined wind is what holds it up). Each isle keeps one small thing: a cache,
// a wind-scored note, a scatter of gems, and at the last, a star for anyone
// who walks the whole sky-road. Every hop uses the vocabulary the player
// already owns: rousable vents, glider, patience.
import * as THREE from 'three';
import { G, save } from './state.js';
import { heightAt, toonMat } from './terrain.js';
import { spawnSparkle, registerStandSurface, addPickup } from './world.js';
import { setStoryFlag } from './quests.js';

const FROM = { x: 50, z: 265, y: 92 };   // over the Coil ring
const TO = { x: 0, z: 360, y: 105 };     // the serene isle

const ISLES = [0.2, 0.44, 0.66, 0.88].map((t, i) => ({
  t,
  x: FROM.x + (TO.x - FROM.x) * t + Math.sin(t * Math.PI) * (i % 2 ? -18 : 16),
  z: FROM.z + (TO.z - FROM.z) * t,
  y: FROM.y + (TO.y - FROM.y) * t + Math.sin(t * Math.PI) * 9,
  r: 4.4 - (i % 2) * 0.6,
}));

const DRIFT_NOTE =
  'Scored into the stone, letters worn soft by wind: "THE ROAD IS NOT THE ' +
  'ISLES. THE ROAD IS THE LETTING GO BETWEEN THEM." Beneath, smaller, a ' +
  'different hand: "piet was here. twice. the second time on purpose."';

let built = false;
const isles = [];
const vents = [];

const flag = id => !!(G.story && G.story.flags && G.story.flags[id]);
const manifest = () => flag('coilUnlocked') || flag('coilCompleted') || flag('finaleCompleted');

function buildIsle(spec, index) {
  const group = new THREE.Group();
  group.position.set(spec.x, spec.y, spec.z);
  const stone = new THREE.Mesh(
    new THREE.CylinderGeometry(spec.r, spec.r * 0.72, 2.0, 9), toonMat({ color: 0xa29886 }));
  stone.position.y = -1.15;
  const grass = new THREE.Mesh(
    new THREE.CylinderGeometry(spec.r + 0.12, spec.r, 0.26, 9), toonMat({ color: 0x6dbb4d }));
  grass.position.y = -0.13;
  const shard = new THREE.Mesh(
    new THREE.ConeGeometry(spec.r * 0.4, 3.6, 5), toonMat({ color: 0xa29886 }));
  shard.rotation.x = Math.PI;
  shard.position.y = -3.6;
  stone.castShadow = grass.castShadow = true;
  stone.receiveShadow = grass.receiveShadow = true;
  group.add(stone, grass, shard);
  G.scene.add(group);
  G.colliders.push({ x: spec.x, z: spec.z, r: spec.r, top: spec.y, soft: true });
  registerStandSurface({ x: spec.x, z: spec.z, r: spec.r, top: spec.y });

  // every isle carries a sleeping vent pointing up the road
  const vent = { x: spec.x, z: spec.z, y: spec.y, readyAt: 0, index };
  vents.push(vent);
  const ventMesh = new THREE.Mesh(
    new THREE.CylinderGeometry(0.7, 0.95, 0.45, 8), toonMat({ color: 0x8d8577 }));
  ventMesh.position.set(spec.x, spec.y + 0.22, spec.z);
  ventMesh.castShadow = true;
  G.scene.add(ventMesh);
  G.interactables.push({
    id: `drift_vent_${index}`, pos: new THREE.Vector3(spec.x, spec.y + 0.6, spec.z), r: 2.6,
    label: 'Rouse the drift vent',
    onUse() {
      if (G.time < vent.readyAt) {
        G.ui.toast('The vent is still drawing breath...', 0xcccccc);
        return;
      }
      vent.readyAt = G.time + 20;
      G.updraftZones.push({
        x: vent.x, z: vent.z, r: 4.2, bottomY: vent.y - 4, topY: vent.y + 16,
        strength: 15, expires: G.time + 16,
      });
      spawnSparkle(vent.x, vent.y + 1.5, vent.z, 0xd6e8b8, 22, 4);
      G.audio.sfx('updraft');
      G.ui.toast('The drift breathes — ride it on toward the next isle!', 0xbfe8ff, 3800);
    },
  });
  isles.push({ spec, group });
  return spec;
}

function buildDrift() {
  built = true;
  ISLES.forEach(buildIsle);

  // isle 1: a traveler's cache — world.js chest persistence handles the rest
  // (makeChest lives in world.js's module scope; a plain interactable cache
  // keeps this module self-contained instead)
  const c = ISLES[0];
  const cacheIt = {
    id: 'drift_cache', pos: new THREE.Vector3(c.x + 1.6, c.y + 0.6, c.z + 1), r: 2.4,
    label: 'Open the traveler\'s cache',
    onUse() {
      if (this.gone || flag('driftCache')) { this.gone = true; return; }
      this.gone = true;
      setStoryFlag('driftCache', true);
      G.player.arrows = (Number(G.player.arrows) || 0) + 10;
      G.gems = (Number(G.gems) || 0) + 2;
      spawnSparkle(this.pos.x, this.pos.y + 0.5, this.pos.z, 0xffdf8a, 26, 3.5);
      G.ui.toast('Ten arrows and two gems, left for whoever made the first hop.', 0xf4ecd2, 4600);
      G.audio.sfx('pickup');
    },
  };
  if (flag('driftCache')) cacheIt.gone = true;
  else {
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.55, 0.55), toonMat({ color: 0x795232 }));
    box.position.set(c.x + 1.6, c.y + 0.28, c.z + 1);
    box.castShadow = true;
    G.scene.add(box);
  }
  G.interactables.push(cacheIt);

  // isle 2: the wind-scored note
  const n = ISLES[1];
  const mark = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.4, 0.28), toonMat({ color: 0x8d8577 }));
  mark.position.set(n.x - 1.2, n.y + 0.7, n.z - 0.8);
  mark.rotation.y = 0.6;
  mark.castShadow = true;
  G.scene.add(mark);
  G.interactables.push({
    id: 'drift_note', pos: new THREE.Vector3(n.x - 1.2, n.y + 0.9, n.z - 0.8), r: 2.6,
    label: 'Read the wind-scored stone',
    onUse() {
      const first = !G.lore.driftNote;
      if (first) { G.lore.driftNote = true; save(); }
      G.ui.dialog('THE WIND-SCORED STONE', DRIFT_NOTE, false);
      if (first) {
        G.ui.toast('✦ Chronicle — The Road Between', 0xbfe8ff, 4200);
        G.audio.sfx('glimmer');
      } else G.audio.sfx('lock');
    },
  });

  // isle 3: gems where the wind dropped them
  const g3 = ISLES[2];
  addPickup('gem', g3.x + 1.2, g3.y + 0.6, g3.z + 0.8, 'pickup.drift.gem.0');
  addPickup('gem', g3.x - 1.4, g3.y + 0.6, g3.z - 0.6, 'pickup.drift.gem.1');
  addPickup('gem', g3.x + 0.2, g3.y + 0.6, g3.z - 1.5, 'pickup.drift.gem.2');
}

export function updateDrift(dt = 0) {
  if (!G.started || !G.scene) return;
  if (!built) {
    if (!manifest()) return;
    buildDrift();
  }
  // the last isle: standing there writes the crossing into the sky
  if (!flag('driftCrossed') && G.player) {
    const last = ISLES[ISLES.length - 1];
    const p = G.player.pos;
    if (Math.hypot(p.x - last.x, p.z - last.z) < last.r + 1 && Math.abs(p.y - last.y) < 3) {
      setStoryFlag('driftCrossed', true);
      spawnSparkle(last.x, last.y + 1.5, last.z, 0xfff2d8, 36, 4.5);
      G.audio.chord([392, 523.25, 659.25], 0.09, 0.25);
      G.ui.toast('The whole sky-road, walked. Somewhere above, that counts for something.', 0xfff2d8, 5200);
    }
  }
}

export function getDriftSummary() {
  return {
    built,
    isles: ISLES.map(i => ({ x: +i.x.toFixed(1), y: +i.y.toFixed(1), z: +i.z.toFixed(1) })),
    crossed: flag('driftCrossed'),
    cache: flag('driftCache'),
    note: !!G.lore.driftNote,
  };
}
