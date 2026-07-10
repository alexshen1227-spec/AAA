// The Tumbled Vale — where an island came down.
//
// The far southeast corner of the map was empty. Now it holds a shallow
// crater of half-buried sky-wreckage: the shards of a floating island that
// fell in the Sundering, gloom flora grown up in its long shadow, and at its
// heart the ground where someone rode it down. The gloaming of that fall
// (remember.js: gloam4) plays here at night — that is the reason to come.
// The small cache in the wreck is only set-dressing for the standing stone.
import * as THREE from 'three';
import { G } from './state.js';
import { heightAt, slopeAt, WATER_Y, toonMat } from './terrain.js';
import { makeChest, makeGlow } from './world.js';
import { contractInstance, propInstance, preloadModels } from './assets.js';

const VALE = { x: 284, z: 300 }; // matches GLOAMS.gloam4 in remember.js

let built = false;

function safeGround(cx, cz, spread) {
  for (let i = 0; i < 40; i++) {
    const a = i * 2.399963;
    const r = (i / 40) * spread;
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    const y = heightAt(x, z);
    if (y < WATER_Y + 0.8 || slopeAt(x, z) > 0.5) continue;
    return { x, z, y };
  }
  return { x: cx, z: cz, y: Math.max(WATER_Y + 1, heightAt(cx, cz)) };
}

export function buildTumbledVale() {
  if (built) return;
  built = true;
  const center = safeGround(VALE.x, VALE.z, 20);
  const cy = center.y;

  // the scorch bowl: a dark disc where the island struck
  const bowl = new THREE.Mesh(
    new THREE.CircleGeometry(11, 24),
    new THREE.MeshBasicMaterial({ color: 0x2b241d, transparent: true, opacity: 0.5 }));
  bowl.rotation.x = -Math.PI / 2;
  bowl.position.set(center.x, cy + 0.06, center.z);
  G.scene.add(bowl);

  // the standing stone at the heart — the last patch that was still an island,
  // a low grassy shelf the gloaming stands upon
  const shelf = new THREE.Mesh(
    new THREE.CylinderGeometry(2.4, 3.0, 1.1, 9), toonMat({ color: 0xa29886 }));
  shelf.position.set(center.x, cy + 0.4, center.z);
  shelf.castShadow = shelf.receiveShadow = true;
  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(2.5, 2.4, 0.24, 9), toonMat({ color: 0x6dbb4d }));
  cap.position.set(center.x, cy + 1.05, center.z);
  G.scene.add(shelf, cap);
  const glow = makeGlow(0xffc27a, 2.6);
  glow.position.set(center.x, cy + 1.6, center.z);
  glow.material.opacity = 0.05;
  G.scene.add(glow);

  // half-buried sky-debris shards, flung out around the bowl
  preloadModels(['sky_debris', 'gloom_flora']).then(() => {
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + 0.4;
      const r = 6 + (i % 3) * 3.5;
      const x = center.x + Math.cos(a) * r, z = center.z + Math.sin(a) * r;
      const ci = contractInstance('sky_debris');
      if (!ci) continue;
      const gy = heightAt(x, z);
      ci.root.position.set(x, gy - 1.2 - (i % 2) * 0.6, z); // driven into the earth
      ci.root.rotation.set((i % 3) * 0.4, a * 1.7, (i % 2 ? 0.5 : -0.4));
      ci.root.scale.setScalar(0.8 + (i % 3) * 0.35);
      G.scene.add(ci.root);
      G.colliders.push({ x, z, r: 1.2, top: gy + 0.6 });
    }
    // gloom flora in the wreck's long shadow
    for (let i = 0; i < 9; i++) {
      const a = i * 2.1, r = 3 + (i % 4) * 2.4;
      const x = center.x + Math.cos(a) * r, z = center.z + Math.sin(a) * r;
      const inst = propInstance('gloom_flora');
      if (!inst) continue;
      inst.position.set(x, heightAt(x, z), z);
      inst.rotation.y = a;
      inst.scale.setScalar(0.7 + (i % 3) * 0.4);
      G.scene.add(inst);
    }
  }).catch(() => { });

  // set-dressing only: a modest cache in the wreck, not the point of the place
  const c = safeGround(center.x + 8, center.z - 6, 6);
  makeChest('chest.tumbled-vale', c.x, c.y, c.z, 2.1, { kind: 'shard' });
}

export function updateTumbledVale() {
  if (!built) buildTumbledVale();
  // the gloaming and its Chronicle entry are owned by remember.js (gloam4);
  // nothing to tick here — the fallen island simply is, and waits for a night.
}
