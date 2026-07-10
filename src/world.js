// World population: forests, rocks, swaying grass, ancient beacons (shrines),
// skywatch towers, movable crates, hidden glimmers, and pickups.
import * as THREE from 'three';
import { G, save, GLIMMER_TOTAL } from './state.js';
import { heightAt, slopeAt, WATER_Y, toonMat, toonGradient, grassColorAt } from './terrain.js';
import { fbm, hash2, smoothstep, clamp } from './noise.js';
import { mergeGeometries } from './BufferGeometryUtils.js';
import { preloadModels, propInstance, contractInstance, GEN_PROPS, SIGNATURE_PROPS, PACK_PROPS } from './assets.js';
import { signalQuestEvent } from './quests.js';

// special chest-loot items: discovery inventory entries with use-effects
export const ITEM_DEFS = {
  feather: { name: 'Swift Feather', tint: 0x5fd8c0, note: 'sprint like the wind (30s)' },
  mushroom: { name: 'Hearty Mushroom', tint: 0xe08a8a, note: 'restores all hearts' },
  shard: { name: 'Star Shard', tint: 0xffe066, note: 'vigor: stamina surges (60s)' },
  gear: { name: 'Ancient Gear', tint: 0xc09a50, note: 'a relic of the old sky-works' },
  pod: { name: 'Zephyr Pod', tint: 0x9fe8d8, note: 'a bottled updraft — G throws it' },
};

export function markSeen(kind) {
  if (G.seen[kind]) return;
  G.seen[kind] = true;
  const d = ITEM_DEFS[kind];
  G.ui.toast('✦ New item — ' + (d ? d.name : kind) + '!', 0xffe9a0, 4200);
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

// Stable one-shot world progress. The scene is built before a save is chosen,
// so records keep their stable IDs and syncWorldProgress() reconciles visuals
// immediately after applySave(). Objects created later also consult the same
// sparse maps when they are registered.
const glimmerSites = []; // {id, it, applyCollected, applied}

function worldBucket(kind) {
  if (!G.worldState) G.worldState = { chests: {}, glimmers: {}, pickups: {}, vaults: {} };
  if (!G.worldState[kind]) G.worldState[kind] = {};
  return G.worldState[kind];
}

function worldClaimed(kind, id) { return !!(id && worldBucket(kind)[id]); }

function claimWorld(kind, id) {
  if (!id || worldClaimed(kind, id)) return false;
  worldBucket(kind)[id] = true;
  return true;
}

function refreshGlimmerCount() {
  G.glimmers = Math.min(GLIMMER_TOTAL, Object.keys(worldBucket('glimmers')).length);
}

function claimGlimmer(id) {
  if (!claimWorld('glimmers', id)) return false;
  refreshGlimmerCount();
  return true;
}

function registerGlimmer(id, it, applyCollected = null) {
  const rec = { id, it, applyCollected, applied: false };
  glimmerSites.push(rec);
  if (worldClaimed('glimmers', id)) applyCollectedGlimmer(rec);
  return rec;
}

function applyCollectedGlimmer(rec) {
  if (rec.applied) return;
  rec.applied = true;
  if (rec.it) rec.it.gone = true;
  if (rec.applyCollected) rec.applyCollected();
}

// ---------------------------------------------------------------- trees

// gentle wind sway for instanced foliage: vertices above yStart lean with a
// slow travelling wave. Shaders register here; updateGrass drives uTime.
const swayShaders = [];
function windSway(mat, amp, yStart = 2.2) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = { value: 0 };
    swayShaders.push(sh);
    sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       #ifdef USE_INSTANCING
         vec4 swp = instanceMatrix * vec4(transformed, 1.0);
         float lean = max(0.0, transformed.y - ${yStart.toFixed(2)}) * ${(amp * 0.028).toFixed(4)};
         transformed.x += sin(uTime * 1.15 + swp.x * 0.06 + swp.z * 0.04) * lean;
         transformed.z += cos(uTime * 0.95 + swp.z * 0.05) * lean * 0.7;
       #endif`
    );
  };
}

// merged blob-cluster canopy with baked vertex shading: shaded underside
// rising to a sunlit crown, per-blob tonal variation for painterly depth.
// detail: 1 for the first (large) blob, 0 for the small filler blobs.
function makeCanopyGeo(defs, yLo, ySpan) {
  const blobs = defs.map(([x, y, z, r], bi) => {
    const g = new THREE.IcosahedronGeometry(r, bi === 0 ? 1 : 0);
    g.translate(x, y, z);
    const pos = g.attributes.position;
    const cols = new Float32Array(pos.count * 3);
    const blobMul = 0.9 + hash2(bi, 771) * 0.18;
    for (let i = 0; i < pos.count; i++) {
      const t = clamp((pos.getY(i) - yLo) / ySpan, 0, 1);
      const b = (0.56 + t * 0.6) * blobMul;
      cols[i * 3] = b; cols[i * 3 + 1] = b; cols[i * 3 + 2] = b * 0.94;
    }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    return g;
  });
  return mergeGeometries(blobs);
}

// planted groves: [cx, cz, radius] — the fbm scatter leaves some regions
// (notably Thornwood, home of the golden grove) almost bare, so scenic
// forests are seeded explicitly on top of it
const GROVES = [
  [80, 200, 64],     // Thornwood: the ginkgo-gold wood
  [-150, 96, 52],    // Mirrormere shore
  [34, 122, 40],
  [152, -58, 44],
  [-58, -158, 44],
  [214, 124, 48],
];

export function buildForests() {
  const spots = [];
  const pines = [];
  // rejection-sample tree positions
  for (let i = 0; i < 5400; i++) {
    const x = (hash2(i, 11) - 0.5) * 920;
    const z = (hash2(i, 23) - 0.5) * 920;
    const h = heightAt(x, z);
    if (h < WATER_Y + 1.6 || slopeAt(x, z) > 0.5) continue;
    const density = fbm(x * 0.006 + 60, z * 0.006 - 33, 3);
    // dense woods where the noise says so, plus lone meadow trees everywhere
    // else so no region reads empty
    if (density < 0.11 && hash2(i, 29) > 0.085) continue;
    if (Math.hypot(x - 60, z + 80) < 26) continue;       // keep spawn clear
    if (h > 26) { if (h < 48) pines.push([x, h, z, i]); continue; }
    spots.push([x, h, z, i]);
  }
  GROVES.forEach(([cx, cz, r], gi) => {
    const n = (r * r / 26) | 0;
    for (let j = 0; j < n; j++) {
      const seed = gi * 977 + j;
      const a = hash2(seed, 15) * Math.PI * 2;
      const d = Math.sqrt(hash2(seed, 17)) * r;
      const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      const h = heightAt(x, z);
      if (h < WATER_Y + 1.6 || h > 26 || slopeAt(x, z) > 0.5) continue;
      if (Math.hypot(x - 60, z + 80) < 26) continue;
      spots.push([x, h, z, 40000 + seed]);
    }
  });

  // leafy trees: instanced trunk + merged blob-cluster canopy
  const trunkGeo = new THREE.CylinderGeometry(0.32, 0.52, 3.6, 7);
  trunkGeo.translate(0, 1.8, 0);
  const canopyGeo = makeCanopyGeo([
    [0, 4.7, 0, 2.5],
    [1.5, 3.9, 0.55, 1.6],
    [-1.35, 3.8, -0.5, 1.5],
    [0.25, 6.0, -0.35, 1.7],
    [-0.6, 4.1, 1.25, 1.35],
  ], 2.4, 5.3);
  const trunkMat = toonMat({ color: 0x8a6242 }); // warm bark
  const canopyMat = toonMat({ color: 0xffffff, vertexColors: true }); // tinted per instance
  windSway(canopyMat, 2.0, 2.4);
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, spots.length);
  const canopies = new THREE.InstancedMesh(canopyGeo, canopyMat, spots.length);
  const canopyCol = new THREE.Color();
  spots.forEach(([x, y, z, i], k) => {
    const s = 0.8 + hash2(i, 41) * 0.9;
    tmpQ.setFromAxisAngle(UP, hash2(i, 43) * Math.PI * 2);
    tmpM.compose(tmpV.set(x, y - 0.15, z), tmpQ, tmpS.set(s, s * (0.9 + hash2(i, 47) * 0.35), s));
    trunks.setMatrixAt(k, tmpM);
    canopies.setMatrixAt(k, tmpM);
    // Thornwood turns ginkgo-gold (TotK's amber woods); a few stray gold
    // trees dot the higher meadows elsewhere
    const gold = Math.hypot(x - 80, z - 200) < 72 || (hash2(i, 51) < 0.045 && y > 13);
    if (gold) {
      canopyCol.setHSL(0.095 + hash2(i, 53) * 0.035, 0.74, 0.5 + hash2(i, 59) * 0.12);
    } else {
      // TotK two-tone greens: yellow-leaning sunlit leaf color
      canopyCol.setHSL(0.25 + hash2(i, 53) * 0.05, 0.52 + hash2(i, 59) * 0.14, 0.42 + hash2(i, 59) * 0.14);
    }
    canopies.setColorAt(k, canopyCol);
    G.colliders.push({ x, z, r: 0.55 * s, top: y + 3.2 * s });
    // some trees carry apples
    if (hash2(i, 61) < 0.3) {
      const n = 1 + ((hash2(i, 67) * 3) | 0);
      for (let a = 0; a < n; a++) {
        const ang = hash2(i, 71 + a) * Math.PI * 2;
        addPickup('apple', x + Math.cos(ang) * 2.0 * s,
          y + (3.6 + hash2(i, 73 + a) * 1.6) * s,
          z + Math.sin(ang) * 2.0 * s, `pickup.tree.${i}.${a}`);
      }
    }
  });
  trunks.castShadow = canopies.castShadow = true;
  canopies.receiveShadow = true;

  // pines for the highlands: two stacked cones, shaded dark at the skirt
  const pTrunkGeo = new THREE.CylinderGeometry(0.25, 0.4, 3, 6); pTrunkGeo.translate(0, 1.5, 0);
  const cone1 = new THREE.ConeGeometry(2.2, 5.4, 8); cone1.translate(0, 4.4, 0);
  const cone2 = new THREE.ConeGeometry(1.45, 3.6, 8); cone2.translate(0, 7.5, 0);
  const pTopGeo = mergeGeometries([cone1, cone2]);
  {
    const pos = pTopGeo.attributes.position;
    const cols = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const b = 0.6 + clamp((pos.getY(i) - 1.7) / 7.6, 0, 1) * 0.55;
      cols[i * 3] = b; cols[i * 3 + 1] = b; cols[i * 3 + 2] = b * 0.96;
    }
    pTopGeo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  }
  const pineMat = toonMat({ color: 0xffffff, vertexColors: true });
  windSway(pineMat, 1.1, 3.0);
  const pTrunks = new THREE.InstancedMesh(pTrunkGeo, trunkMat, pines.length);
  const pTops = new THREE.InstancedMesh(pTopGeo, pineMat, pines.length);
  pines.forEach(([x, y, z, i], k) => {
    const s = 0.8 + hash2(i, 83) * 0.7;
    tmpQ.setFromAxisAngle(UP, hash2(i, 89) * Math.PI * 2);
    tmpM.compose(tmpV.set(x, y - 0.15, z), tmpQ, tmpS.set(s, s, s));
    pTrunks.setMatrixAt(k, tmpM);
    pTops.setMatrixAt(k, tmpM);
    // deep blue-green pines, subtle per-tree variation
    canopyCol.setHSL(0.40 + hash2(i, 97) * 0.05, 0.42, 0.28 + hash2(i, 83) * 0.10);
    pTops.setColorAt(k, canopyCol);
    G.colliders.push({ x, z, r: 0.5 * s, top: y + 3 * s });
  });
  pTrunks.castShadow = pTops.castShadow = true;

  G.scene.add(trunks, canopies, pTrunks, pTops);
  buildBushes();
}

// low meadow bushes hugging the forest fringes — soft green mounds that knit
// the tree line into the grass
function buildBushes() {
  const spots = [];
  for (let i = 0; i < 5200 && spots.length < 900; i++) {
    const x = (hash2(i, 1101) - 0.5) * 900;
    const z = (hash2(i, 1103) - 0.5) * 900;
    const h = heightAt(x, z);
    if (h < WATER_Y + 1.0 || h > 30 || slopeAt(x, z) > 0.45) continue;
    const density = fbm(x * 0.006 + 60, z * 0.006 - 33, 3);
    // forest fringe band, plus a sparse scatter across the open meadows
    if (!(density > -0.02 && density < 0.13) && hash2(i, 1107) > 0.18) continue;
    if (Math.hypot(x - 60, z + 80) < 24) continue;
    spots.push([x, h, z, i]);
  }
  const geo = makeCanopyGeo([[0, 0.55, 0, 1]], -0.4, 1.9);
  const mat = toonMat({ color: 0xffffff, vertexColors: true });
  windSway(mat, 0.9, 0.3);
  const mesh = new THREE.InstancedMesh(geo, mat, spots.length);
  const col = new THREE.Color();
  spots.forEach(([x, y, z, i], k) => {
    const s = 0.7 + hash2(i, 1109) * 1.1;
    tmpQ.setFromAxisAngle(UP, hash2(i, 1113) * Math.PI * 2);
    tmpM.compose(tmpV.set(x, y - 0.12, z), tmpQ, tmpS.set(s, s * (0.55 + hash2(i, 1117) * 0.25), s));
    mesh.setMatrixAt(k, tmpM);
    const gold = Math.hypot(x - 80, z - 200) < 72;
    if (gold) col.setHSL(0.10 + hash2(i, 1119) * 0.03, 0.68, 0.46 + hash2(i, 1123) * 0.1);
    else col.setHSL(0.26 + hash2(i, 1119) * 0.05, 0.55, 0.34 + hash2(i, 1123) * 0.12);
    mesh.setColorAt(k, col);
  });
  mesh.castShadow = mesh.receiveShadow = true;
  G.scene.add(mesh);
}

// ------------------------------------------------------------- flowers

export function buildFlowers() {
  const spots = [];
  for (let i = 0; i < 15000 && spots.length < 3600; i++) {
    const x = (hash2(i, 601) - 0.5) * 880;
    const z = (hash2(i, 607) - 0.5) * 880;
    const h = heightAt(x, z);
    if (h < WATER_Y + 0.9 || h > 34 || slopeAt(x, z) > 0.4) continue;
    if (fbm(x * 0.02 + 300, z * 0.02 - 120, 2) < 0.22) continue; // flower patches
    spots.push([x, h, z, i]);
  }
  const headGeo = new THREE.CircleGeometry(0.1, 5);
  headGeo.rotateX(-Math.PI / 2);
  headGeo.translate(0, 0.27, 0);
  const heads = new THREE.InstancedMesh(headGeo,
    new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }), spots.length);
  const stemGeo = new THREE.PlaneGeometry(0.035, 0.27);
  stemGeo.translate(0, 0.135, 0);
  const stems = new THREE.InstancedMesh(stemGeo,
    toonMat({ color: 0x4d8a3a, side: THREE.DoubleSide }), spots.length);
  // bright whites / pinks / pale blues — the bloom pass makes these glow gently
  const palette = [0xfffaf0, 0xffe25e, 0xaac6ff, 0xffb0c2, 0xeef2ff, 0xffc172];
  const col = new THREE.Color();
  spots.forEach(([x, y, z, i], k) => {
    tmpQ.setFromAxisAngle(UP, hash2(i, 613) * Math.PI);
    const s = 0.8 + hash2(i, 617) * 1.0;
    tmpM.compose(tmpV.set(x, y - 0.02, z), tmpQ, tmpS.set(s, s, s));
    heads.setMatrixAt(k, tmpM);
    stems.setMatrixAt(k, tmpM);
    col.set(palette[(hash2(i, 619) * palette.length) | 0]);
    heads.setColorAt(k, col);
  });
  G.scene.add(heads, stems);
}

// ------------------------------------------------------------- ancient ruins

const LORE = [
  'When the hundred-year storm swallowed the valley, the beacons dimmed, and the wind forgot our names.',
  'Stack stone upon stone, and even the sky will bow to you.',
  'The glimmers hide beneath lonely rocks. They are terribly pleased when found.',
  'Four orbs, one blessing. The old shrines keep their bargain still.',
  'We built the skywatch towers to read the weather. The weather read us instead.',
];

export const RUIN_SITES = [
  [-60, -20], [95, 125], [-150, -85], [30, 95], [205, 25],
  [-95, 165], [155, -125], [-255, 105], [85, -185], [-35, 275],
];

export function buildRuins() {
  const stone = toonMat({ color: 0xbcb3a0 }); // warm pale sun-bleached stone
  const cols = [], blocks = [], lintels = [], floors = [];
  let loreIdx = 0;
  RUIN_SITES.forEach(([cx, cz], si) => {
    const y0 = heightAt(cx, cz);
    if (y0 < WATER_Y + 0.5) return;
    const R = 5 + hash2(si, 701) * 3;
    const n = 5 + ((hash2(si, 703) * 3) | 0);
    const tops = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + hash2(si, 707) * 0.6;
      const x = cx + Math.cos(a) * R, z = cz + Math.sin(a) * R;
      const y = heightAt(x, z);
      const broken = hash2(si, 709 + i) < 0.45;
      const hgt = broken ? 0.9 + hash2(si, 711 + i) * 1.6 : 3.5 + hash2(si, 713 + i) * 1.2;
      cols.push({ x, y: y - 0.2, z, hgt, rot: hash2(si, 717 + i) * Math.PI });
      G.colliders.push({ x, z, r: 0.55, top: y + hgt - 0.2 });
      tops.push({ x, z, y: y + hgt - 0.2, tall: !broken, a });
    }
    // lintels across adjacent tall columns
    for (let i = 0; i < n; i++) {
      const A = tops[i], B = tops[(i + 1) % n];
      if (!A.tall || !B.tall || hash2(si, 741 + i) < 0.4) continue;
      const len = Math.hypot(B.x - A.x, B.z - A.z) + 1.0;
      if (len > 9) continue;
      lintels.push({
        x: (A.x + B.x) / 2, y: Math.max(A.y, B.y) + 0.3, z: (A.z + B.z) / 2,
        rot: Math.atan2(B.x - A.x, B.z - A.z) + Math.PI / 2, len,
      });
    }
    floors.push({ x: cx, y: y0 - 0.9, z: cz, r: R + 1.4 });
    for (let b = 0; b < 4; b++) {
      const a = hash2(si, 723 + b) * Math.PI * 2, d = 2 + hash2(si, 727 + b) * (R + 3);
      const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      const s = 0.6 + hash2(si, 733 + b) * 0.9;
      blocks.push({ x, y: heightAt(x, z), z, rot: hash2(si, 729 + b) * Math.PI, s });
      if (s > 1.0) G.colliders.push({ x, z, r: s * 0.7, top: heightAt(x, z) + s * 0.75 });
    }
    // lore tablet at every other site
    if (si % 2 === 0 && loreIdx < LORE.length) {
      const text = LORE[loreIdx++];
      const tx = cx + 1.5, tz = cz + 1.2;
      const ty = heightAt(tx, tz);
      const slab = new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.45, 0.2), toonMat({ color: 0x6e6a7c }));
      slab.position.set(tx, ty + 0.62, tz);
      slab.rotation.set(-0.08, hash2(si, 751) * Math.PI, 0.04);
      slab.castShadow = true;
      const runes = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 1.0),
        new THREE.MeshBasicMaterial({ color: 0x7befff, transparent: true, opacity: 0.7 }));
      runes.position.z = 0.11;
      slab.add(runes);
      G.scene.add(slab);
      G.interactables.push({
        pos: slab.position, r: 2.6, label: 'Read the old stone',
        onUse() {
          G.ui.toast('"' + text + '"', 0xbfe8ff, 5200);
          G.audio.sfx('lock');
        },
      });
    }
  });

  const colGeo = new THREE.CylinderGeometry(0.5, 0.6, 1, 7);
  colGeo.translate(0, 0.5, 0);
  const colMesh = new THREE.InstancedMesh(colGeo, stone, cols.length);
  cols.forEach((c, k) => {
    tmpQ.setFromAxisAngle(UP, c.rot);
    tmpM.compose(tmpV.set(c.x, c.y, c.z), tmpQ, tmpS.set(1, c.hgt, 1));
    colMesh.setMatrixAt(k, tmpM);
  });
  const blockGeo = new THREE.BoxGeometry(1.4, 1.5, 1.4);
  const blockMesh = new THREE.InstancedMesh(blockGeo, stone, blocks.length);
  blocks.forEach((b, k) => {
    tmpQ.setFromEuler(new THREE.Euler(hash2(k, 761) * 0.3, b.rot, hash2(k, 763) * 0.3));
    tmpM.compose(tmpV.set(b.x, b.y + b.s * 0.4, b.z), tmpQ, tmpS.set(b.s, b.s, b.s));
    blockMesh.setMatrixAt(k, tmpM);
  });
  const linGeo = new THREE.BoxGeometry(1, 0.55, 0.8);
  const linMesh = new THREE.InstancedMesh(linGeo, stone, lintels.length);
  lintels.forEach((l, k) => {
    tmpQ.setFromAxisAngle(UP, l.rot);
    tmpM.compose(tmpV.set(l.x, l.y, l.z), tmpQ, tmpS.set(l.len, 1, 1));
    linMesh.setMatrixAt(k, tmpM);
  });
  const floorGeo = new THREE.CylinderGeometry(1, 1, 1.1, 9);
  const floorMesh = new THREE.InstancedMesh(floorGeo, toonMat({ color: 0xb2a993 }), floors.length);
  floors.forEach((f, k) => {
    tmpQ.identity();
    tmpM.compose(tmpV.set(f.x, f.y, f.z), tmpQ, tmpS.set(f.r, 1, f.r));
    floorMesh.setMatrixAt(k, tmpM);
  });
  colMesh.castShadow = blockMesh.castShadow = linMesh.castShadow = true;
  colMesh.receiveShadow = blockMesh.receiveShadow = floorMesh.receiveShadow = true;
  G.scene.add(colMesh, blockMesh, linMesh, floorMesh);

  // pressure-plate vaults at two ruin sites (stone slabs wait nearby)
  buildVault('vault.east', 109, 120, -1, 0, { kind: 'gems', n: 8 });   // by the ruin at (95,125)
  buildVault('vault.west', -150, -100, 0, 1,
    { kind: 'glimmer', glimmerId: 'glimmer.vault-west' });              // by the ruin at (-150,-85)
  buildGolemForges(); // offer Ancient Gears to the sentries beside them
  // the ancient wind bellows at a Heartfields ruin (-35,275)
  buildBellows(-27, 281);
  // lone chests: the highest ring-mountain peak and two quiet ruins
  makeChest('chest.peak-ring', -238, heightAt(-238, 394), 394, 2.4, { kind: 'gems', n: 3 });
  makeChest('chest.ruin-west-apples', -252, heightAt(-252, 100), 100,
    hash2(7, 55) * Math.PI * 2, { kind: 'apples', n: 2 });
  makeChest('chest.ruin-east-apples', 211, heightAt(211, 29), 29,
    hash2(4, 55) * Math.PI * 2, { kind: 'apples', n: 2 });
  // relic chests: special items worth going out of the way for
  makeChest('chest.plateau-feather', 66, heightAt(66, -95), -95, 1.2, { kind: 'feather' });
  makeChest('chest.beacon-mushroom', -44, heightAt(-44, 52), 52, 2.8, { kind: 'mushroom' });
  makeChest('chest.east-shard', 150, heightAt(150, -63), -63, 0.4, { kind: 'shard' });
  makeChest('chest.thornwood-gear', 84, heightAt(84, 206), 206, 2.0, { kind: 'gear' });
  makeChest('chest.mirrormere-arrows', -160, heightAt(-160, 90), 90, 1.0,
    { kind: 'arrows', n: 10 });
  makeChest('chest.ruin-north-mushroom', 37, heightAt(37, 125), 125, 0.6, { kind: 'mushroom' });
  makeChest('chest.heartfields-feather', 216, heightAt(216, 120), 120, 2.4, { kind: 'feather' });
}

// ------------------------------------------------------------- birds & fireflies

const BIRDS = 7;
let birdMesh;
let flock = null, nextFlockAt = 30; // migrating V-formation, every minute or so

export function buildBirds() {
  const wing = new THREE.PlaneGeometry(1.15, 0.38);
  wing.translate(0.57, 0, 0); // pivot at the body
  birdMesh = new THREE.InstancedMesh(wing,
    new THREE.MeshBasicMaterial({ color: 0x25292f, side: THREE.DoubleSide }), BIRDS * 2 + 14);
  birdMesh.frustumCulled = false;
  G.scene.add(birdMesh);
}

export function updateBirds(night) {
  if (night) { birdMesh.count = 0; return; }
  let k = 0;
  const eul = new THREE.Euler();
  for (let b = 0; b < BIRDS; b++) {
    const cx = Math.sin(b * 2.1) * 190, cz = Math.cos(b * 3.7) * 190;
    const r = 50 + (b % 3) * 35;
    const sp = (0.05 + (b % 2) * 0.025) * (b % 2 ? 1 : -1);
    const a = G.time * sp + b * 1.7;
    const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
    const y = 42 + (b % 4) * 11 + Math.sin(G.time * 0.7 + b) * 3;
    const heading = a + Math.sign(sp) * Math.PI / 2;
    const flap = Math.sin(G.time * 7 + b * 2) * 0.55;
    for (const side of [-1, 1]) {
      eul.set(0, heading, flap * side, 'YXZ');
      tmpQ.setFromEuler(eul);
      tmpM.compose(tmpV.set(x, y, z), tmpQ, tmpS.set(side, 1, 1));
      birdMesh.setMatrixAt(k++, tmpM);
    }
  }
  // migrating V-formation: seven wanderers crossing the whole valley high up
  if (!flock && G.time > nextFlockAt) {
    const a = hash2((G.time * 7) | 0, 45) * Math.PI * 2;
    flock = { t0: G.time, x0: Math.cos(a) * 430, z0: Math.sin(a) * 430, dx: -Math.cos(a), dz: -Math.sin(a) };
  }
  if (flock) {
    const ft = G.time - flock.t0;
    if (ft > 66) {
      flock = null;
      nextFlockAt = G.time + 45 + hash2((G.time * 3) | 0, 77) * 70;
    } else {
      const heading = Math.atan2(flock.dx, flock.dz);
      for (let b = 0; b < 7; b++) {
        const lag = Math.abs(b - 3) * 2.4;              // the V trails its point
        const side = (b - 3) * 2.1;
        const x = flock.x0 + flock.dx * (ft * 13 - lag) - flock.dz * side;
        const z = flock.z0 + flock.dz * (ft * 13 - lag) + flock.dx * side;
        const y = 74 + Math.sin(G.time * 0.9 + b) * 2;
        const flap = Math.sin(G.time * 6.5 + b * 1.3) * 0.5;
        for (const side2 of [-1, 1]) {
          eul.set(0, heading, flap * side2, 'YXZ');
          tmpQ.setFromEuler(eul);
          tmpM.compose(tmpV.set(x, y, z), tmpQ, tmpS.set(side2 * 1.5, 1.5, 1.5));
          birdMesh.setMatrixAt(k++, tmpM);
        }
      }
    }
  }
  birdMesh.count = k;
  birdMesh.instanceMatrix.needsUpdate = true;
}

const FIREFLIES = 80;
let ffMesh;
const ffAnchors = [];

export function buildFireflies() {
  for (let i = 0; ffAnchors.length < FIREFLIES && i < 6000; i++) {
    const x = (hash2(i, 801) - 0.5) * 700, z = (hash2(i, 807) - 0.5) * 700;
    const h = heightAt(x, z);
    if (h < WATER_Y - 0.5) continue;
    const nearWater = h < WATER_Y + 2.5;
    const inForest = fbm(x * 0.006 + 60, z * 0.006 - 33, 3) > 0.22;
    if (!nearWater && !inForest) continue;
    ffAnchors.push({ x, y: Math.max(h, WATER_Y) + 0.9, z, ph: hash2(i, 811) * 20 });
  }
  ffMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.17, 0.17),
    new THREE.MeshBasicMaterial({
      color: 0xffe9a0, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }), FIREFLIES);
  ffMesh.frustumCulled = false;
  ffMesh.count = 0;
  G.scene.add(ffMesh);
}

export function updateFireflies(night) {
  if (!night) { ffMesh.count = 0; return; }
  let k = 0;
  for (const f of ffAnchors) {
    const t = G.time * 0.7 + f.ph;
    tmpM.compose(
      tmpV.set(f.x + Math.sin(t * 1.3) * 1.6, f.y + Math.sin(t * 2.1) * 0.5 + 0.3, f.z + Math.cos(t) * 1.6),
      G.camera.quaternion,
      tmpS.setScalar(0.75 + Math.sin(t * 4) * 0.45));
    ffMesh.setMatrixAt(k++, tmpM);
  }
  ffMesh.count = k;
  ffMesh.instanceMatrix.needsUpdate = true;
}

// ------------------------------------------------------------- ambient life
// Small always-on visual life: butterflies over the flower meadows, golden
// pollen motes riding the midday air, leaves spiralling out of the gold wood,
// ripple rings behind the swimming hero, and pale light shafts in the deep
// forest. All pooled + instanced; nothing here allocates per frame.

let bflyMesh = null; const bflyAnchors = [];
let pollenMesh = null; const pollenSeeds = [];
let leafMesh = null; const leafAnchors = [];
let shaftMesh = null, shaftMat = null;
const ripples = []; let rippleT = 0;
const tmpE = new THREE.Euler();

export function buildAmbient() {
  // --- butterflies: one flapping quad each, anchored to flower country ----
  const BF = 22;
  for (let i = 0; i < 6000 && bflyAnchors.length < BF; i++) {
    const x = (hash2(i, 1301) - 0.5) * 700, z = (hash2(i, 1307) - 0.5) * 700;
    const h = heightAt(x, z);
    if (h < WATER_Y + 0.9 || h > 30 || slopeAt(x, z) > 0.4) continue;
    if (fbm(x * 0.02 + 300, z * 0.02 - 120, 2) < 0.24) continue; // flower patches
    bflyAnchors.push({ x, y: h + 0.9, z, ph: hash2(i, 1311) * 20, sp: 0.7 + hash2(i, 1313) * 0.7 });
  }
  bflyMesh = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(0.22, 0.16),
    new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.95, depthWrite: false }),
    bflyAnchors.length);
  const bcol = new THREE.Color();
  const BPAL = [0xfff6d8, 0xffd24a, 0xa8c8ff, 0xffb0c2, 0xd8ffb0];
  for (let i = 0; i < bflyAnchors.length; i++) {
    bcol.set(BPAL[(hash2(i, 1317) * BPAL.length) | 0]);
    bflyMesh.setColorAt(i, bcol);
  }
  bflyMesh.frustumCulled = false;
  bflyMesh.count = 0;
  G.scene.add(bflyMesh);

  // --- pollen motes: tiny gold sparks drifting in a box around the player --
  const PM = 54;
  for (let i = 0; i < PM; i++) {
    pollenSeeds.push({ ox: (hash2(i, 1401) - 0.5) * 44, oz: (hash2(i, 1403) - 0.5) * 44, ph: hash2(i, 1407) * 30 });
  }
  pollenMesh = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(0.07, 0.07),
    new THREE.MeshBasicMaterial({
      color: 0xffe9a0, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
    PM);
  pollenMesh.frustumCulled = false;
  pollenMesh.count = 0;
  G.scene.add(pollenMesh);

  // --- falling leaves: gold in Thornwood, green under the deep woods -------
  const LF = 36;
  for (let i = 0; i < 9000 && leafAnchors.length < LF; i++) {
    const x = (hash2(i, 1501) - 0.5) * 800, z = (hash2(i, 1503) - 0.5) * 800;
    const h = heightAt(x, z);
    if (h < WATER_Y + 1.5 || h > 26) continue;
    const gold = Math.hypot(x - 80, z - 200) < 66;
    const dense = fbm(x * 0.006 + 60, z * 0.006 - 33, 3) > 0.2;
    if (!gold && !dense) continue;
    leafAnchors.push({ x, y: h, z, ph: hash2(i, 1507) * 20, gold });
  }
  leafMesh = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(0.16, 0.12),
    new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false }),
    leafAnchors.length);
  const lcol = new THREE.Color();
  leafAnchors.forEach((a, i) => {
    if (a.gold) lcol.setHSL(0.10 + hash2(i, 1511) * 0.03, 0.8, 0.55);
    else lcol.setHSL(0.25 + hash2(i, 1511) * 0.05, 0.55, 0.45);
    leafMesh.setColorAt(i, lcol);
  });
  leafMesh.frustumCulled = false;
  G.scene.add(leafMesh);

  // --- swim ripples: pooled expanding rings ---------------------------------
  for (let i = 0; i < 6; i++) {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.85, 1.0, 22),
      new THREE.MeshBasicMaterial({
        color: 0xe8f8ff, transparent: true, opacity: 0,
        side: THREE.DoubleSide, depthWrite: false,
      }));
    m.rotation.x = -Math.PI / 2;
    m.visible = false;
    G.scene.add(m);
    ripples.push({ m, t: -1 });
  }

  // --- forest light shafts: pale gold columns under the dense canopy -------
  const SH = 26;
  const shafts = [];
  for (let i = 0; i < 8000 && shafts.length < SH; i++) {
    const x = (hash2(i, 1601) - 0.5) * 800, z = (hash2(i, 1603) - 0.5) * 800;
    const h = heightAt(x, z);
    if (h < WATER_Y + 1.5 || h > 26 || slopeAt(x, z) > 0.4) continue;
    if (fbm(x * 0.006 + 60, z * 0.006 - 33, 3) < 0.24) continue; // deep woods only
    shafts.push([x, h, z, i]);
  }
  shaftMat = new THREE.MeshBasicMaterial({
    color: 0xfff2c8, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  shaftMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1.5, 11), shaftMat, shafts.length);
  shafts.forEach(([x, y, z, i], k) => {
    tmpQ.setFromAxisAngle(UP, hash2(i, 1607) * Math.PI);
    tmpM.compose(tmpV.set(x, y + 5, z), tmpQ, tmpS.set(1, 1, 1));
    shaftMesh.setMatrixAt(k, tmpM);
  });
  G.scene.add(shaftMesh);
}

export function updateAmbient(dt, night) {
  const t = G.time;
  const p = G.player.pos;
  // butterflies flutter by day
  if (bflyMesh) {
    if (night) bflyMesh.count = 0;
    else {
      let k = 0;
      for (const a of bflyAnchors) {
        const tt = t * a.sp + a.ph;
        const flap = 0.25 + Math.abs(Math.sin(tt * 16)) * 0.75; // wing-fold beat
        tmpV.set(a.x + Math.sin(tt * 0.9) * 2.2, a.y + Math.sin(tt * 2.3) * 0.5 + 0.4,
                 a.z + Math.cos(tt * 0.7) * 2.2);
        const gu = gustAt(tmpV.x, tmpV.y, tmpV.z); // butterflies tumble downwind as a gust passes
        if (gu) tmpV.set(tmpV.x + gu.dx * gu.s * 1.7, tmpV.y + gu.s * 0.55, tmpV.z + gu.dz * gu.s * 1.7);
        tmpM.compose(tmpV, G.camera.quaternion, tmpS.set(flap, 1, 1));
        bflyMesh.setMatrixAt(k++, tmpM);
      }
      bflyMesh.count = k;
      bflyMesh.instanceMatrix.needsUpdate = true;
    }
  }
  // pollen glimmers around the player at day, strongest mid-morning calm
  if (pollenMesh) {
    const w = G.weather;
    const calm = 1 - Math.min(1, ((w && w.wetness) || 0) * 3);
    if (night || calm <= 0.05) pollenMesh.count = 0;
    else {
      let k = 0;
      for (const s of pollenSeeds) {
        const tt = t * 0.35 + s.ph;
        const x = p.x + s.ox + Math.sin(tt) * 2.4;
        const z = p.z + s.oz + Math.cos(tt * 0.8) * 2.4;
        const y = heightAt(x, z) + 1.1 + Math.sin(tt * 1.7) * 0.8;
        tmpM.compose(tmpV.set(x, y, z), G.camera.quaternion,
          tmpS.setScalar(0.7 + Math.sin(tt * 5) * 0.4));
        pollenMesh.setMatrixAt(k++, tmpM);
      }
      pollenMesh.count = k;
      pollenMesh.instanceMatrix.needsUpdate = true;
    }
  }
  // leaves spiral down from the canopies, looping every ~6s
  if (leafMesh) {
    let k = 0;
    for (const a of leafAnchors) {
      const cyc = ((t * 0.9 + a.ph) % 6) / 6;
      const y = a.y + 5.5 - cyc * 5.2;
      tmpV.set(a.x + Math.sin(cyc * 12 + a.ph) * 0.9, y, a.z + Math.cos(cyc * 10 + a.ph) * 0.9);
      const gu = gustAt(tmpV.x, tmpV.y, tmpV.z); // falling leaves ride a passing gust downwind
      if (gu) { tmpV.x += gu.dx * gu.s * (0.6 + cyc) * 1.5; tmpV.z += gu.dz * gu.s * (0.6 + cyc) * 1.5; }
      tmpM.compose(
        tmpV,
        tmpQ.setFromEuler(tmpE.set(cyc * 9 + a.ph, a.ph, cyc * 7)),
        tmpS.setScalar(1));
      leafMesh.setMatrixAt(k++, tmpM);
    }
    leafMesh.instanceMatrix.needsUpdate = true;
  }
  // swim ripples trail the swimming hero
  if (G.player.mode === 'swim') {
    rippleT -= dt;
    const moving = Math.hypot(G.player.vel.x, G.player.vel.z) > 0.6;
    if (rippleT <= 0 && moving) {
      rippleT = 0.42;
      for (const r of ripples) {
        if (r.t >= 0) continue;
        r.t = 0;
        r.m.position.set(p.x, WATER_Y + 0.06, p.z);
        r.m.visible = true;
        break;
      }
    }
  }
  for (const r of ripples) {
    if (r.t < 0) continue;
    r.t += dt;
    const k = r.t / 1.1;
    if (k >= 1) { r.t = -1; r.m.visible = false; continue; }
    r.m.scale.setScalar(0.5 + k * 2.6);
    r.m.material.opacity = (1 - k) * 0.4;
  }
  // forest shafts glow when the sun rides high
  if (shaftMat) {
    const sunY = G.sunDir ? G.sunDir.y : 0;
    shaftMat.opacity = Math.max(0, sunY * 1.5 - 0.45) * 0.13;
  }
}

// ------------------------------------------------------------- sky islands

// [x, z, topY, radius, reachable]
const ISLANDS = [
  [150, 50, 26, 9, true],    // glide here from the first skywatch tower
  [-260, -70, 68, 12, false],
  [50, 265, 82, 10, false],
  [235, -195, 60, 8, false],
];
const waterfallMists = [];  // additive spray glows at each fall base

// ---- animated flowing waterfall ------------------------------------------
// One shared ShaderMaterial across every fall: vertical flow stripes scrolling
// down, a bright foam lip and splashing base, tapered edges so the sheet reads
// like falling water rather than a flat quad. uTime is driven in updateIslands.
let waterfallMat = null;
function getWaterfallMat() {
  if (waterfallMat) return waterfallMat;
  waterfallMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(0xe6f7ff) },
      fogColor: { value: new THREE.Color(0xffffff) },
      fogNear: { value: 1 }, fogFar: { value: 1000 },
    },
    vertexShader: `
      varying vec2 vUv;
      varying float vFog;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vFog = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float uTime; uniform vec3 uColor;
      uniform vec3 fogColor; uniform float fogNear; uniform float fogFar;
      varying vec2 vUv; varying float vFog;
      float h11(float n){ return fract(sin(n) * 43758.5453); }
      void main() {
        // uv.y = 1 at the rim (top), 0 at the base. water travels downward.
        float y = vUv.y, x = vUv.x;
        float scroll = uTime * 1.7;
        // layered vertical flow: broad ribbons + fine ripples, scrolling down
        float ribbon = sin(y * 26.0 + scroll * 7.0 + x * 3.0) * 0.5 + 0.5;
        float fine   = sin(y * 70.0 - scroll * 12.0 + x * 9.0) * 0.5 + 0.5;
        float flow = mix(ribbon, fine, 0.45);
        // columnar streaks across the width so it isn't a flat sheet
        float col = 0.55 + 0.45 * sin(x * 22.0 + h11(floor(x * 9.0)) * 6.28);
        float bright = flow * col;
        // foam: bright lip at the top, churning splash at the base
        float topFoam = smoothstep(0.9, 1.0, y);
        float botFoam = smoothstep(0.16, 0.0, y) * (0.55 + 0.45 * sin(scroll * 11.0 + x * 24.0));
        vec3 c = uColor + bright * 0.22 + (topFoam + botFoam) * 0.6;
        float a = (0.42 + bright * 0.5);
        a = mix(a, 1.0, clamp(topFoam * 0.85 + botFoam * 0.75, 0.0, 1.0));
        a *= smoothstep(0.0, 0.09, x) * smoothstep(1.0, 0.91, x); // taper sides
        float fog = smoothstep(fogNear, fogFar, vFog);
        c = mix(c, fogColor, fog);
        gl_FragColor = vec4(c, a * (1.0 - fog * 0.6));
      }`,
  });
  return waterfallMat;
}

// width x length falling sheet using the shared animated material. Also drops a
// soft additive spray glow at the base (registered for a gentle bob/flicker).
function makeWaterfall(width, len, mist = true) {
  const geo = new THREE.PlaneGeometry(width, len, 1, 12);
  const mesh = new THREE.Mesh(geo, getWaterfallMat());
  mesh.renderOrder = 2;
  if (mist) {
    const spray = makeGlow(0xeaf8ff, width * 1.7);
    spray.position.y = -len / 2 - 0.2;
    spray.material.opacity = 0.5;
    mesh.add(spray);
    waterfallMists.push({ spray, base: width * 1.7, ph: waterfallMists.length * 1.7 });
  }
  fallPlanes.push(mesh); // upgraded to the authored ribbon once the GLB lands
  return mesh;
}

// rewards for the three far islands (ISLANDS indices 1..3) — one glimmer
// voice and one chest each, all sitting on the cap (y = topY)
const FAR_TOASTS = [
  'A glimmer clings to the drifting stone! "This island missed visitors!"',
  'A glimmer swirls out of the grass! "Highest of the high — that\'s you!"',
  'A glimmer peeks over the rim! "Did the wind carry you, or you the wind?"',
];
const FAR_LOOT = [
  { kind: 'gems', n: 3 },
  { kind: 'apples', n: 2 },
  { kind: 'glimmer' },
];

// one stacked-silhouette floating island: grass cap over telescoping inverted
// rock cones — the TotK sky-island profile
function makeIslandMesh(r, stone, grass, shadows = true) {
  const g = new THREE.Group();
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 0.97, 1.2, 10), grass);
  cap.position.y = -0.6;
  const rockTop = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.96, r * 0.62, r * 0.85, 10), stone);
  rockTop.position.y = -1.2 - r * 0.425;
  const rockMid = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.62, r * 0.3, r * 0.8, 9), stone);
  rockMid.position.y = -1.2 - r * 1.25;
  const tip = new THREE.Mesh(new THREE.ConeGeometry(r * 0.3, r * 0.8, 9), stone);
  tip.rotation.x = Math.PI;
  tip.position.y = -1.2 - r * 2.05;
  if (shadows) {
    cap.castShadow = rockTop.castShadow = rockMid.castShadow = true;
    cap.receiveShadow = true;
  }
  g.add(cap, rockTop, rockMid, tip);
  return g;
}

// far decorative sky islands drifting high over the valley — unreachable
// scenery that fills the TotK sky band, complete with airborne waterfalls
const decoIslands = [];
function buildDecoIslands(stone, grass) {
  for (let i = 0; i < 6; i++) {
    const a = i * 1.13 + 0.4;
    const d = 280 + hash2(i, 61) * 160;
    const r = 13 + hash2(i, 67) * 12;
    const y = 175 + hash2(i, 71) * 70;
    const g = makeIslandMesh(r, stone, grass, false);
    g.position.set(Math.cos(a) * d, y, Math.sin(a) * d);
    if (hash2(i, 73) < 0.7) {
      const len = 40 + hash2(i, 79) * 30;
      const fall = makeWaterfall(2.6, len, false); // too high up for base mist
      const fa = hash2(i, 83) * Math.PI * 2;
      fall.position.set(Math.cos(fa) * (r - 0.5), -len / 2, Math.sin(fa) * (r - 0.5));
      fall.rotation.y = -fa + Math.PI / 2;
      g.add(fall);
    }
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.45, 3.2, 6), toonMat({ color: 0x8a6242 }));
    trunk.position.set(r * 0.25, 1.6, -r * 0.15);
    const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(2.4, 1), toonMat({ color: 0x63b84a }));
    crown.position.set(r * 0.25, 4.4, -r * 0.15);
    g.add(trunk, crown);
    decoIslands.push({ g, baseY: y, ph: hash2(i, 89) * 10 });
    G.scene.add(g);
  }
}

export function buildIslands() {
  initPermanentUpdrafts();
  const stone = toonMat({ color: 0xa29886 });
  const grass = toonMat({ color: 0x6dbb4d });
  buildDecoIslands(stone, grass);
  ISLANDS.forEach(([x, z, topY, r, reachable], ii) => {
    const g = makeIslandMesh(r, stone, grass);
    g.position.set(x, topY, z);

    // soft green mounds so the cap reads lush from below
    for (let b = 0; b < 2; b++) {
      const bush = new THREE.Mesh(new THREE.IcosahedronGeometry(0.9 + hash2(ii, b, 31) * 0.8, 1),
        toonMat({ color: 0x5cae43 }));
      const ba = hash2(ii, b, 37) * Math.PI * 2;
      bush.scale.y = 0.6;
      bush.position.set(Math.cos(ba) * r * 0.55, 0.3, Math.sin(ba) * r * 0.55);
      bush.castShadow = true;
      g.add(bush);
    }

    // hanging rock shards under the island
    for (let s = 0; s < 3; s++) {
      const shard = new THREE.Mesh(new THREE.ConeGeometry(1 + hash2(ii, s) * 1.4, 3 + hash2(ii, s, 3) * 4, 5), stone);
      shard.rotation.x = Math.PI;
      const a = hash2(ii, s, 7) * Math.PI * 2;
      shard.position.set(Math.cos(a) * r * 0.55, -2.2 - hash2(ii, s, 9) * 2, Math.sin(a) * r * 0.55);
      g.add(shard);
    }

    // a tree and rocks on top
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.38, 2.6, 6), toonMat({ color: 0x8a6242 }));
    trunk.position.set(r * 0.3, 1.3, -r * 0.2);
    const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(1.9, 1), toonMat({ color: 0x63b84a }));
    crown.position.set(r * 0.3, 3.4, -r * 0.2);
    trunk.castShadow = crown.castShadow = true;
    g.add(trunk, crown);

    // waterfall spilling off the rim, animated flow + base spray
    const fallLen = reachable ? topY - WATER_Y + 2 : 26;
    const fall = makeWaterfall(2.4, fallLen, reachable);
    const fa = hash2(ii, 21) * Math.PI * 2;
    fall.position.set(Math.cos(fa) * (r - 0.4), -fallLen / 2, Math.sin(fa) * (r - 0.4));
    fall.rotation.y = -fa + Math.PI / 2;
    g.add(fall);

    G.scene.add(g);
    G.colliders.push({ x, z, r: r - 0.5, top: topY, soft: true });

    if (reachable) {
      // treasure for those who learn the wind
      addPickup('gem', x + 2, topY + 0.6, z + 1, `pickup.island.${ii}.gem.0`);
      addPickup('gem', x - 2.5, topY + 0.6, z - 1.5, `pickup.island.${ii}.gem.1`);
      addPickup('gem', x + 0.5, topY + 0.6, z - 3, `pickup.island.${ii}.gem.2`);
      addPickup('apple', x - 1, topY + 0.7, z + 3, `pickup.island.${ii}.apple`);
      const glimmerId = `glimmer.island.${ii}`;
      const it = {
        pos: new THREE.Vector3(x, topY, z), r: 5, label: 'Stand in the sky',
        onUse() {
          if (this.gone) return;
          if (!claimGlimmer(glimmerId)) { this.gone = true; return; }
          applyCollectedGlimmer(glimmerSites.find(g => g.id === glimmerId));
          spawnSparkle(x, topY + 2, z, 0x9fffb0, 40, 5);
          G.ui.toast('A glimmer rides the wind up here! "You found the sky!"', 0x9fffb0);
          G.audio.sfx('glimmer');
          save();
        },
      };
      G.interactables.push(it);
      registerGlimmer(glimmerId, it);
    } else {
      // far islands: reached by riding the permanent updraft columns
      addPickup('gem', x + 2.2, topY + 0.6, z + 1.4, `pickup.island.${ii}.gem.0`);
      addPickup('gem', x - 2.4, topY + 0.6, z - 1.8, `pickup.island.${ii}.gem.1`);
      addPickup('gem', x + 0.4, topY + 0.6, z - 3.2, `pickup.island.${ii}.gem.2`);
      addPickup('apple', x - 1.4, topY + 0.7, z + 2.8, `pickup.island.${ii}.apple`);
      const toast = FAR_TOASTS[(ii - 1) % FAR_TOASTS.length];
      const glimmerId = `glimmer.island.${ii}`;
      const it = {
        pos: new THREE.Vector3(x, topY, z), r: 5, label: 'Stand in the sky',
        onUse() {
          if (this.gone) return;
          if (!claimGlimmer(glimmerId)) { this.gone = true; return; }
          applyCollectedGlimmer(glimmerSites.find(g => g.id === glimmerId));
          spawnSparkle(x, topY + 2, z, 0x9fffb0, 40, 5);
          G.ui.toast(toast, 0x9fffb0);
          G.audio.sfx('glimmer');
          save();
        },
      };
      G.interactables.push(it);
      registerGlimmer(glimmerId, it);
      const islandLoot = { ...FAR_LOOT[(ii - 1) % FAR_LOOT.length] };
      if (islandLoot.kind === 'glimmer') islandLoot.glimmerId = `glimmer.island-chest.${ii}`;
      makeChest(`chest.island.${ii}`, x - r * 0.38, topY, z + r * 0.34,
        hash2(ii, 57) * Math.PI * 2, islandLoot);
    }
  });
  buildCairns();
  buildPeakGlimmers();
}

export function updateIslands() {
  // drive the shared flowing-waterfall shader + keep its fog synced to the scene
  if (waterfallMat) {
    waterfallMat.uniforms.uTime.value = G.time;
    const f = G.scene.fog;
    if (f) {
      waterfallMat.uniforms.fogColor.value.copy(f.color);
      waterfallMat.uniforms.fogNear.value = f.near;
      waterfallMat.uniforms.fogFar.value = f.far;
    }
  }
  // the modeled falls breathe: sheet opacity ripples, foam froths, and the
  // ribbon sways a hair's width so the water never looks frozen
  for (let i = 0; i < fallFx.length; i++) {
    const fx = fallFx[i];
    for (const m of fx.waterMats) m.opacity = 0.5 + Math.sin(G.time * 2.1 + i * 1.7) * 0.08;
    for (const m of fx.foamMats) m.opacity = 0.75 + Math.sin(G.time * 3.4 + i) * 0.15;
    fx.root.scale.x = 1 + Math.sin(G.time * 1.8 + i * 2.2) * 0.045;
  }
  // base spray glows shimmer and bob
  for (let i = 0; i < waterfallMists.length; i++) {
    const m = waterfallMists[i];
    m.spray.material.opacity = 0.4 + Math.sin(G.time * 3.1 + m.ph) * 0.16;
    m.spray.scale.setScalar(m.base * (0.9 + Math.sin(G.time * 2.3 + m.ph) * 0.12));
  }
  // the far islands ride the high wind with a slow bob
  for (let i = 0; i < decoIslands.length; i++) {
    const d = decoIslands[i];
    d.g.position.y = d.baseY + Math.sin(G.time * 0.14 + d.ph) * 2.4;
  }
}

// ------------------------------------------------- permanent updrafts
// rising columns beside each far sky island (enter at ground level,
// ride up past the rim, steer over to land) plus two thermals on the
// Stormridge approach. no expires — they never prune. sky.js draws the tall
// streaks; updateUpdraftFx() swirls leaves at each base.

const updraftBases = []; // {x,z} — cairns mark these on the ground

function initPermanentUpdrafts() {
  if (updraftBases.length) return;
  initUpdraftFx(); // the swirl markers render for every registered zone
  // island columns: same rim angle the waterfall uses, pushed clear of the
  // island underside (zone r 4.5 + ~2m gap outside the rim) so a glider can
  // enter the column from open ground straight below
  for (const ii of [1, 2, 3]) {
    const [ix, iz, topY, ir] = ISLANDS[ii];
    const fa = hash2(ii, 21) * Math.PI * 2; // the waterfall angle
    const d = ir + 6.5;
    // start at the waterfall angle, then walk the rim until the column base
    // lands on dry, standable ground (island 1 hangs over the western water)
    let zx = ix + Math.cos(fa) * d, zz = iz + Math.sin(fa) * d;
    let ground = heightAt(zx, zz);
    for (let k = 1; k < 12; k++) {
      if (ground > WATER_Y + 1 && slopeAt(zx, zz) < 0.55) break;
      const a = fa + k * (Math.PI / 6);
      const tx = ix + Math.cos(a) * d, tz = iz + Math.sin(a) * d;
      const th = heightAt(tx, tz);
      if (th > ground) { zx = tx; zz = tz; ground = th; }
    }
    if (ground < WATER_Y + 0.5) ground = WATER_Y + 0.5; // worst case: hover base over water
    G.updraftZones.push({ x: zx, z: zz, r: 4.5, bottomY: ground - 0.5, topY: topY + 5, strength: 15 });
    updraftBases.push({ x: zx, z: zz });
  }
  // Stormridge approach thermals: probe rings around the massif for open,
  // walkable slope ground; take two well-separated spots
  let prevT = null;
  for (let a = 0; a < 40 && updraftBases.length < 5; a++) {
    const ring = (a / 10) | 0;
    const ang = (a % 10) * 0.6283 + ring * 0.21;
    const dd = 34 + ring * 14;
    const x = -120 + Math.cos(ang) * dd, z = -260 + Math.sin(ang) * dd;
    const h = heightAt(x, z);
    if (h < WATER_Y + 2 || h > 40 || slopeAt(x, z) > 0.55) continue;
    if (prevT && Math.hypot(x - prevT.x, z - prevT.z) < 46) continue;
    G.updraftZones.push({ x, z, r: 4.5, bottomY: h - 0.5, topY: h + 45, strength: 14 });
    updraftBases.push({ x, z });
    prevT = { x, z };
  }
  // fallback spots if the probe was too picky
  for (const [x, z] of [[-152, -226], [-86, -292]]) {
    if (updraftBases.length >= 5) break;
    const h = Math.max(heightAt(x, z), WATER_Y + 1);
    G.updraftZones.push({ x, z, r: 4.5, bottomY: h - 0.5, topY: h + 45, strength: 14 });
    updraftBases.push({ x, z });
  }
}

// ------------------------------------------------- peak glimmers
// three glimmers resting on notable summits, found by coarse-probing the
// terrain for spread-out local maxima. same pattern as the glimmer rocks.

function buildPeakGlimmers() {
  const peaks = [];
  for (let gx = -440; gx <= 440; gx += 22) {
    for (let gz = -440; gz <= 440; gz += 22) {
      const h = heightAt(gx, gz);
      if (h < 48) continue;
      if (h < heightAt(gx + 11, gz) || h < heightAt(gx - 11, gz) ||
          h < heightAt(gx, gz + 11) || h < heightAt(gx, gz - 11)) continue;
      peaks.push({ x: gx, z: gz, h });
    }
  }
  peaks.sort((a, b) => b.h - a.h); // highest first — h > 55 picked naturally
  const chosen = [];
  for (const p of peaks) {
    if (chosen.length >= 3) break;
    let ok = true;
    for (const c of chosen) {
      if (Math.hypot(p.x - c.x, p.z - c.z) < 130) { ok = false; break; }
    }
    if (ok) chosen.push(p);
  }
  const PEAK_TOASTS = [
    'The wind sighs — a glimmer! "You stood where the sky begins!"',
    'A glimmer wakes in the thin air. "So few ever climb this high..."',
    'A glimmer unfurls from the stone. "The peaks remember you now!"',
  ];
  const geo = new THREE.IcosahedronGeometry(0.5, 0);
  const mat = toonMat({ color: 0xb9c4d6 }); // wind-scoured summit stone
  chosen.forEach((p, i) => {
    const glimmerId = `glimmer.peak.${i}`;
    const y = heightAt(p.x, p.z);
    const rock = new THREE.Mesh(geo, mat);
    rock.position.set(p.x, y + 0.2, p.z);
    rock.rotation.set(hash2(i, 941) * 3, hash2(i, 947) * 3, 0);
    rock.castShadow = true;
    const glow = makeGlow(0x9fffb0, 1.6);
    glow.position.set(p.x, y + 1.1, p.z);
    G.scene.add(rock, glow);
    const toast = PEAK_TOASTS[i % PEAK_TOASTS.length];
    const it = {
      pos: rock.position, r: 3, label: 'Feel the high wind',
      onUse() {
        if (this.gone) return;
        if (!claimGlimmer(glimmerId)) { this.gone = true; return; }
        applyCollectedGlimmer(glimmerSites.find(g => g.id === glimmerId));
        spawnSparkle(p.x, y + 1, p.z, 0x9fffb0, 34, 5);
        G.ui.toast(toast, 0x9fffb0);
        G.audio.sfx('glimmer');
        save();
      },
    };
    G.interactables.push(it);
    registerGlimmer(glimmerId, it, () => { glow.visible = false; });
  });
}

// ------------------------------------------------- cairns
// small stacked-stone route markers: updraft bases, the vault ruins, the
// bellows, and the walking lines toward the skywatch towers. one instanced
// mesh, 3 stones per cairn, decoration only — no colliders.

function buildCairns() {
  const spots = [];
  updraftBases.forEach((b, i) => {
    const a = hash2(i, 977) * Math.PI * 2; // just outside the leaf swirl
    spots.push([b.x + Math.cos(a) * 6.2, b.z + Math.sin(a) * 6.2]);
  });
  spots.push([104, 113], [-146, -94]);            // pressure-plate vault ruins
  spots.push([-31.5, 276.5]);                     // the ancient bellows
  spots.push([97, 7], [-185, -123], [-47, 203]);  // paths toward the towers
  const geo = new THREE.IcosahedronGeometry(0.42, 0);
  geo.scale(1, 0.62, 1); // flat river stones
  const mesh = new THREE.InstancedMesh(geo, toonMat({ color: 0x97907f }), spots.length * 3);
  let k = 0;
  spots.forEach(([x, z], i) => {
    let y = heightAt(x, z);
    if (y < WATER_Y + 0.3) return; // never stack stones in a lake
    for (let s = 0; s < 3; s++) {
      const sc = [1.0, 0.74, 0.5][s];
      const half = 0.42 * 0.62 * sc;
      y += half;
      tmpQ.setFromAxisAngle(UP, hash2(i, 983 + s) * Math.PI * 2);
      tmpM.compose(
        tmpV.set(x + (hash2(i, 991 + s) - 0.5) * 0.12, y - 0.05,
                 z + (hash2(i, 997 + s) - 0.5) * 0.12),
        tmpQ,
        tmpS.set(sc, sc, sc * (0.86 + hash2(i, 1009 + s) * 0.28)));
      mesh.setMatrixAt(k++, tmpM);
      y += half - 0.045;
    }
  });
  mesh.count = k;
  mesh.castShadow = mesh.receiveShadow = true;
  G.scene.add(mesh);
}

// ------------------------------------------------------------- the wayfarer

const MAREN_LINES = [
  'Ah — awake at last, wanderer. The storm took your memories, did it? It takes something from all of us.',
  'A hundred years ago the sky broke over Aerwyn. The beacons that guarded the valley went dark, and we grew old waiting for someone who could climb.',
  'Wake the beacons — the orange glow marks the sleeping ones. The skywatch towers will chart the land for you, if your arms hold out.',
  'Mind the boglins. The storm left them cross, and the indigo ones swing twice as hard. A shield on your back is not a shield in your hand, but it makes a fine impression.',
  'They say islands still drift above the valley, torn loose the night the sky broke. If you learn the wind, you might yet stand on one.',
  'The wind favors you, wanderer. Go — and when the crimson moon rises, keep a sword close.',
];

export function buildWayfarer() {
  const x = 42, z = -84;
  const y = heightAt(x, z);
  const g = new THREE.Group();
  g.position.set(x, y, z);

  const robe = new THREE.Mesh(new THREE.ConeGeometry(0.62, 1.7, 8), toonMat({ color: 0x5a4a6e }));
  robe.position.y = 0.85;
  const chest = new THREE.Mesh(new THREE.SphereGeometry(0.34, 8, 6), toonMat({ color: 0x6e5a82 }));
  chest.position.y = 1.55;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 8, 6), toonMat({ color: 0xe8c9a0 }));
  head.position.y = 1.95;
  const hood = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.55, 7), toonMat({ color: 0x5a4a6e }));
  hood.position.y = 2.16;
  const beard = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.4, 6), toonMat({ color: 0xd8d4c8 }));
  beard.position.set(0, 1.78, 0.16);
  const staff = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 2.3, 6), toonMat({ color: 0x6a4a2a }));
  staff.position.set(0.55, 1.15, 0.1);
  staff.rotation.z = -0.08;
  const orb = new THREE.Mesh(new THREE.SphereGeometry(0.11, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xcaf1ff }));
  orb.position.set(0.58, 2.34, 0.1);
  const orbGlow = makeGlow(0x9fe6ff, 1.4);
  orbGlow.position.copy(orb.position);

  g.add(robe, chest, head, hood, beard, staff, orb, orbGlow);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  G.scene.add(g);
  G.colliders.push({ x, z, r: 0.7, top: y + 1.2 });

  const npc = { group: g, line: 0, x, z };
  G.wayfarer = npc;

  G.interactables.push({
    pos: new THREE.Vector3(x, y + 1, z), r: 3.4, label: 'Talk to the Wayfarer',
    onUse() {
      const i = npc.line % MAREN_LINES.length;
      G.ui.dialog('MAREN, THE GREY WAYFARER', MAREN_LINES[i], i < MAREN_LINES.length - 1);
      npc.line = Math.min(npc.line + 1, MAREN_LINES.length - 1);
      if (i === MAREN_LINES.length - 1) npc.line = MAREN_LINES.length - 2; // keep last two cycling
      G.audio.sfx('lock');
    },
  });
}

// Tilla, the Gleaner — a recurring character with a real quest chain:
// stage 0: asks for 3 apples (her stores fell with the sky-ruin)
// stage 1: asks you to inspect the fallen ruin on the meadow
// stage 2: waits for the promised report-back
// stage 3: rewards + a running thread about the sky-works
export function buildGleaner() {
  const x = 22, z = -102;
  const y = heightAt(x, z);
  const g = new THREE.Group();
  g.position.set(x, y, z);
  const skirt = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.5, 8), toonMat({ color: 0x7a5a3a }));
  skirt.position.y = 0.75;
  const torso = new THREE.Mesh(new THREE.SphereGeometry(0.3, 8, 6), toonMat({ color: 0xa8743e }));
  torso.position.y = 1.4;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), toonMat({ color: 0xe8c9a0 }));
  head.position.y = 1.82;
  const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.07, 6, 12), toonMat({ color: 0xc9803a }));
  scarf.position.y = 1.6; scarf.rotation.x = Math.PI / 2;
  const basket = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.2, 0.3, 8), toonMat({ color: 0x9a7a4e }));
  basket.position.set(0.55, 0.9, 0);
  g.add(skirt, torso, head, scarf, basket);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  G.scene.add(g);
  G.colliders.push({ x, z, r: 0.6, top: y + 1.1 });
  if (!G.tut.quests) G.tut.quests = { tilla: 0 };

  G.interactables.push({
    pos: new THREE.Vector3(x, y + 1, z), r: 3.2, label: 'Talk to Tilla',
    onUse() {
      const q = G.tut.quests;
      if (q.tilla === 0) {
        if (G.apples >= 3) {
          G.apples -= 3;
          q.tilla = 1;
          signalQuestEvent('tilla_apples_delivered');
          G.ui.dialog('TILLA, THE GLEANER',
            'Three whole apples! Bless your quick feet. Now — a harder favor. That ruin that fell by the plateau... something GLOWS in it at night. Go and lay a hand on it, would you? I dare not.', true);
          G.audio.sfx('pickup');
          save();
        } else {
          G.ui.dialog('TILLA, THE GLEANER',
            'My winter stores were under that sky-stone when it fell! Bring me 3 apples, wanderer, and I will tell you what I saw the night the ruin came down.', true);
        }
      } else if (q.tilla === 1) {
        G.ui.dialog('TILLA, THE GLEANER',
          'The fallen stone, wanderer — by the plateau, west of the beacon. Touch it and come tell me it is dead metal and my nights can be quiet again.', true);
      } else if (q.tilla === 2) {
        q.tilla = 3;
        signalQuestEvent('tilla_reported');
        G.items.feather = (G.items.feather || 0) + 1;
        markSeen('feather');
        G.ui.dialog('TILLA, THE GLEANER',
          'Still warm? Then the sky-works are NOT dead — only sleeping. Maren must hear of this. You came back when you said you would, wanderer. Keep this feather, and keep your eyes up.', false);
        G.ui.toast('Tilla’s thanks — Swift Feather received', 0x9fffc8, 4600);
        G.audio.sfx('glimmer');
        save();
      } else {
        G.ui.dialog('TILLA, THE GLEANER',
          'Still warm, was it? Then the sky-works are NOT dead — only sleeping. Maren must hear of this... Keep the feather, and keep your eyes up.', false);
      }
      G.audio.sfx('lock');
    },
  });

  // quest target: the fallen sky-ruin from the opening
  G.interactables.push({
    pos: new THREE.Vector3(30, heightAt(30, -96) + 1, -96), r: 3.0,
    label: 'Touch the fallen sky-stone',
    onUse() {
      const q = G.tut.quests || (G.tut.quests = { tilla: 0 });
      if (q.tilla === 1) {
        q.tilla = 2;
        signalQuestEvent('tilla_stone_touched');
        spawnSparkle(30, heightAt(30, -96) + 1.5, -96, 0x39ff88, 24, 4);
        G.ui.toast('The stone hums under your palm — still warm. Return to Tilla with the news.', 0x9fffc8, 5200);
        G.audio.sfx('lock');
        save();
      } else {
        G.ui.toast('Old stone and oxidized bronze. It thrums, very faintly.', 0xbcb3a0);
        G.audio.sfx('lock');
      }
    },
  });
}

export function updateWayfarer(dt) {
  const npc = G.wayfarer;
  if (!npc) return;
  const p = G.player.pos;
  const d = Math.hypot(p.x - npc.x, p.z - npc.z);
  npc.group.position.y = heightAt(npc.x, npc.z) + Math.sin(G.time * 1.3) * 0.03;
  if (d < 8) {
    const target = Math.atan2(p.x - npc.x, p.z - npc.z);
    let diff = target - npc.group.rotation.y;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    npc.group.rotation.y += diff * Math.min(1, dt * 4);
  } else {
    G.ui.dialog('MAREN, THE GREY WAYFARER', null); // close only Maren's own conversation
  }
}

// ------------------------------------------------------------- glow sprites

let glowTex = null;
function getGlowTex() {
  if (glowTex) return glowTex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, 'rgba(255,255,255,1.0)');
  g.addColorStop(0.3, 'rgba(255,255,255,0.42)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(cv);
  return glowTex;
}

export function makeGlow(color, scale) {
  const mat = new THREE.SpriteMaterial({
    map: getGlowTex(), color, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const s = new THREE.Sprite(mat);
  s.scale.setScalar(scale);
  return s;
}

// ---------------------------------------------------------------- rocks

export function buildRocks() {
  const spots = [];
  for (let i = 0; i < 900; i++) {
    const x = (hash2(i, 101) - 0.5) * 940;
    const z = (hash2(i, 103) - 0.5) * 940;
    const h = heightAt(x, z);
    if (h < WATER_Y + 0.4) continue;
    if (hash2(i, 107) > 0.4 && slopeAt(x, z) < 0.3) continue; // prefer slopes
    spots.push([x, h, z, i]);
  }
  const geo = new THREE.IcosahedronGeometry(1, 0);
  const mesh = new THREE.InstancedMesh(geo, toonMat({ color: 0x8f867b }), spots.length);
  spots.forEach(([x, y, z, i], k) => {
    const s = 0.5 + hash2(i, 109) * 2.4;
    tmpQ.setFromEuler(new THREE.Euler(hash2(i, 113) * 3, hash2(i, 127) * 3, hash2(i, 131) * 3));
    tmpM.compose(tmpV.set(x, y + s * 0.2, z), tmpQ, tmpS.set(s, s * (0.7 + hash2(i, 137) * 0.5), s));
    mesh.setMatrixAt(k, tmpM);
    if (s > 1.1) G.colliders.push({ x, z, r: s * 0.8, top: y + s * 0.8 });
  });
  mesh.castShadow = mesh.receiveShadow = true;
  G.scene.add(mesh);
}

// hidden forest spirits under special small rocks
export function buildGlimmers() {
  const places = [
    [130, 40], [-80, -150], [220, 180], [-240, 60], [40, 250],
    [-30, -260], [310, -90], [-150, -60], [170, -190], [-320, 190],
    [90, 130], [-190, 280],
  ];
  const rockGeo = new THREE.IcosahedronGeometry(0.7, 0);
  const rockMat = toonMat({ color: 0x9c9284 });
  places.forEach(([x, z], i) => {
    const glimmerId = `glimmer.forest.${i}`;
    const y = heightAt(x, z);
    if (y < WATER_Y + 0.5) return;
    const rock = new THREE.Mesh(rockGeo, rockMat);
    rock.position.set(x, y + 0.25, z);
    rock.rotation.set(hash2(i, 3) * 3, hash2(i, 5) * 3, 0);
    rock.castShadow = true;
    G.scene.add(rock);
    const it = {
      pos: rock.position, r: 2.4, label: 'Lift rock',
      onUse() {
        if (this.gone) return;
        if (!claimGlimmer(glimmerId)) { this.gone = true; return; }
        applyCollectedGlimmer(glimmerSites.find(g => g.id === glimmerId));
        spawnSparkle(rock.position.x, rock.position.y + 0.6, rock.position.z, 0x9fffb0);
        G.ui.toast('A forest glimmer! "Tee-hee!"', 0x9fffb0);
        G.audio.sfx('glimmer');
        save();
      },
    };
    G.interactables.push(it);
    registerGlimmer(glimmerId, it, () => {
      rock.position.y += 1.2;
      rock.position.x += 0.9;
    });
  });
}

// ---------------------------------------------------------------- grass

let grassMesh, grassSh = null;
let grassAnchor = new THREE.Vector2(1e9, 1e9);
let grassCursor = 0; // time-sliced rebuild progress; >= GRASS_N when settled
let grassFirstBuild = true; // the very first fill is done in one frame (no visible grow-in)
const tmpV2 = new THREE.Vector2();
const GRASS_N = 70000, GRASS_R = 150;
// blades re-placed per frame during a rebuild. Kept small so a single frame
// never breaches budget — the field refills over ~28 frames (~0.5s), which is
// invisible because old blades hold their positions until each is overwritten.
const GRASS_CHUNK = 2500;
const BLADE_H = 0.95;
const _gcol = new THREE.Color();
const ALPINE = new THREE.Color(0xa8a08c); // dry tundra tone for highland blades

export function buildGrass() {
  const blade = new THREE.PlaneGeometry(0.13, BLADE_H, 1, 3);
  blade.translate(0, BLADE_H / 2, 0);
  // taper to a point and bow the blade over like real grass
  {
    const p = blade.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const t = p.getY(i) / BLADE_H;
      p.setX(i, p.getX(i) * (1 - t * 0.88));
      p.setZ(i, p.getZ(i) + t * t * 0.28);
    }
  }
  const mat = new THREE.MeshToonMaterial({
    gradientMap: toonGradient, color: 0xffffff, side: THREE.DoubleSide,
    transparent: true,
  });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = { value: 0 };
    sh.uniforms.uWindMul = { value: 1 }; // weather wind scale (G.weather.windMul)
    sh.uniforms.uPlayer = { value: new THREE.Vector3(0, -999, 0) };
    sh.uniforms.uGust = { value: new THREE.Vector4(0, 0, 0, 0) }; // x,z, radius, strength — nearest live gust line
    grassSh = sh;
    sh.vertexShader = 'uniform float uTime;\nuniform float uWindMul;\nuniform vec3 uPlayer;\nuniform vec4 uGust;\nvarying float vFade;\nvarying float vTip;\n' + sh.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vTip = position.y / ${BLADE_H.toFixed(2)};
       vec4 wp = instanceMatrix * vec4(transformed, 1.0);
       // gusts travel across the field; blades ripple as the wave passes
       float gust = sin(dot(wp.xz, vec2(0.045, 0.028)) - uTime * 2.2);
       float gustAmp = (0.55 + 1.15 * max(0.0, gust) * max(0.0, gust)) * uWindMul;
       // living gusts: blades bend harder where a wind line is passing
       gustAmp += uGust.w * (1.0 - smoothstep(0.0, uGust.z, distance(wp.xz, uGust.xy)));
       float sway = sin(uTime * 2.3 + wp.x * 0.35 + wp.z * 0.28) * 0.2 * position.y * gustAmp;
       transformed.x += sway;
       transformed.z += sway * 0.35;
       // blades shoulder aside under the hero's footsteps
       vec2 toP = wp.xz - uPlayer.xz;
       float pd = length(toP);
       float push = (1.0 - smoothstep(0.25, 1.3, pd))
                  * (1.0 - smoothstep(1.5, 3.0, abs(wp.y - uPlayer.y)));
       transformed.xz += (toP / max(pd, 0.05)) * push * 0.5 * position.y;
       vec4 wp2 = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
       vFade = 1.0 - smoothstep(${(GRASS_R * 0.72).toFixed(1)}, ${GRASS_R.toFixed(1)}, distance(wp2.xyz, cameraPosition));`
    );
    sh.fragmentShader = 'varying float vFade;\nvarying float vTip;\n' + sh.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
       diffuseColor.rgb *= (0.60 + vTip * 0.78); // shadowed base, sunlit tips
       diffuseColor.rgb += vTip * vTip * vec3(0.10, 0.09, 0.02); // warm tip glint`
    ).replace(
      '#include <dithering_fragment>',
      `#include <dithering_fragment>
       gl_FragColor.a *= vFade;
       if (gl_FragColor.a < 0.02) discard;`
    );
  };
  grassMesh = new THREE.InstancedMesh(blade, mat, GRASS_N);
  grassMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  grassMesh.frustumCulled = false;
  // allocate instance colors up front (blades are tinted from the terrain
  // palette during placement rebuilds in updateGrass)
  for (let i = 0; i < GRASS_N; i++) grassMesh.setColorAt(i, _gcol.setRGB(1, 1, 1));
  grassMesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  G.scene.add(grassMesh);
  // prime the whole field around the spawn plateau during boot — the first
  // thing the player sees must never be grass popping in chunk by chunk
  // (saved games that spawn elsewhere refill via the chunked path, where old
  // blades hold their ground until each one is re-placed)
  grassAnchor.set(50, -68);
  grassCursor = 0;
  fillGrassChunk(GRASS_N);
}

// re-place up to n blades from the rebuild cursor. Each blade owns one cell
// of a jittered grid over the field square — pure hash scatter left lattice
// voids (correlated hash pairs), while a jittered grid guarantees even
// coverage with a natural look. Retries re-jitter within the same cell.
const GRASS_GRID = Math.ceil(Math.sqrt(GRASS_N));
function fillGrassChunk(n) {
  const cell = (2 * GRASS_R) / GRASS_GRID;
  const end = Math.min(GRASS_N, grassCursor + n);
  for (let k = grassCursor; k < end; k++) {
    const cx = (k % GRASS_GRID) + 0.5, cz = ((k / GRASS_GRID) | 0) + 0.5;
    let placed = false;
    for (let t = 0; t < 3 && !placed; t++) {
      const seed = k * 3 + t;
      const gx = grassAnchor.x - GRASS_R + (cx + hash2(seed, 301) - 0.5) * cell;
      const gz = grassAnchor.y - GRASS_R + (cz + hash2(seed, 307) - 0.5) * cell;
      const h = heightAt(gx, gz);
      if (h < WATER_Y + 0.7 || h > 52 || slopeAt(gx, gz) > 0.5) continue;
      if (h > 34 && hash2(seed, 337) < (h - 34) / 20) continue; // thin toward the alpine line
      const dry = grassColorAt(gx, gz, _gcol);
      if (dry > 0.75 && hash2(seed, 331) < 0.55) continue; // thin over dirt
      // highland blades dry out to tundra tones that sit on the rocky ground
      _gcol.lerp(ALPINE, smoothstep(30, 46, h) * 0.75);
      const s = 0.75 + hash2(seed, 311) * 0.75;
      tmpQ.setFromAxisAngle(UP, hash2(seed, 313) * Math.PI * 2);
      tmpM.compose(tmpV.set(gx, h - 0.04, gz), tmpQ,
        tmpS.set(s, s * (0.85 + hash2(seed, 317) * 0.5), s));
      grassMesh.setMatrixAt(k, tmpM);
      _gcol.multiplyScalar(0.9 + hash2(seed, 323) * 0.25); // per-blade variation
      grassMesh.setColorAt(k, _gcol);
      placed = true;
    }
    if (!placed) {
      tmpM.compose(tmpV.set(0, -100, 0), tmpQ.identity(), tmpS.set(0.0001, 0.0001, 0.0001));
      grassMesh.setMatrixAt(k, tmpM);
    }
  }
  grassCursor = end;
  grassMesh.instanceMatrix.needsUpdate = true;
  grassMesh.instanceColor.needsUpdate = true;
}

export function updateGrass() {
  if (grassSh) {
    grassSh.uniforms.uTime.value = G.time;
    const w = G.weather;
    grassSh.uniforms.uWindMul.value = (w && w.windMul !== undefined) ? w.windMul : 1;
    grassSh.uniforms.uPlayer.value.copy(G.player.pos);
    // strongest ground gust near the player bends the blades under it
    const ug = grassSh.uniforms.uGust.value;
    ug.set(0, 0, 1, 0);
    let bestS = 0;
    for (const g of gusts) {
      if (g.t < 0 || g.sky) continue;
      const env = Math.sin((g.t / g.T) * Math.PI);
      if (env <= bestS) continue;
      bestS = env;
      ug.set(g.x, g.z, 3.4, env * 1.5);
    }
  }
  // canopy/bush sway rides the same per-frame hook
  for (let i = 0; i < swayShaders.length; i++) swayShaders[i].uniforms.uTime.value = G.time;
  const p = G.player.pos;
  if (grassAnchor.distanceTo(tmpV2.set(p.x, p.z)) >= 42) {
    grassAnchor.set(p.x, p.z); // start a fresh time-sliced rebuild around here
    grassCursor = 0;
  }
  if (grassCursor >= GRASS_N) return;
  fillGrassChunk(GRASS_CHUNK); // time-sliced: a few thousand blades per frame
}

// ---------------------------------------------------------------- beacons (shrines)

export const SHRINE_POS = [
  [60, -80], [-30, 40], [180, 90], [-170, 130], [-90, -210],
  [260, -160], [-280, -60], [120, 290],
];

export function buildShrines() {
  SHRINE_POS.forEach(([x, z], idx) => {
    const y = heightAt(x, z);
    const g = new THREE.Group();
    g.position.set(x, y, z);

    const base = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 4.0, 1.6, 6), toonMat({ color: 0x6e6a7c }));
    base.position.y = 0.7; base.castShadow = base.receiveShadow = true;
    const pillarL = new THREE.Mesh(new THREE.BoxGeometry(0.9, 5.2, 0.9), toonMat({ color: 0x7d7890 }));
    pillarL.position.set(-2.1, 3.6, 0); pillarL.castShadow = true;
    const pillarR = pillarL.clone(); pillarR.position.x = 2.1;
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(5.8, 0.9, 1.1), toonMat({ color: 0x7d7890 }));
    lintel.position.y = 6.4; lintel.castShadow = true;

    // near-white amber core so the bloom pass (threshold ~0.8) catches it;
    // the halo/ring below keep the pure amber color language
    const glowMat = new THREE.MeshBasicMaterial({ color: 0xffc27a });
    const swirl = new THREE.Mesh(new THREE.TorusKnotGeometry(0.85, 0.22, 64, 8, 2, 3), glowMat);
    swirl.position.y = 3.6;
    const eye = new THREE.Mesh(new THREE.CircleGeometry(0.8, 24), glowMat);
    eye.position.set(0, 5.1, 0.56); // on lintel face
    eye.visible = false;

    const light = new THREE.PointLight(0xff9a3d, 0, 26);
    light.position.y = 4;

    // soft halo behind the swirl + rune ring on the ground
    const halo = makeGlow(0xff9a3d, 6.5);
    halo.position.y = 3.6;
    const runeRing = new THREE.Mesh(
      new THREE.RingGeometry(4.0, 4.55, 24),
      new THREE.MeshBasicMaterial({ color: 0xff9a3d, transparent: true, opacity: 0.4, side: THREE.DoubleSide })
    );
    runeRing.rotation.x = -Math.PI / 2;
    runeRing.position.y = 0.06;

    // light pillar rising into the sky — the TotK shrine beam. Amber while
    // asleep, cyan once awakened; updateShrines drives the pulse.
    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.85, 64, 10, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xff9a3d, transparent: true, opacity: 0.09,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }));
    pillar.position.y = 32;

    g.add(base, pillarL, pillarR, lintel, swirl, light, halo, runeRing, pillar);
    G.scene.add(g);
    G.climbMeshes.push(base, pillarL, pillarR);
    G.colliders.push({ x: x - 2.1, z, r: 0.9, top: y + 6.4 }, { x: x + 2.1, z, r: 0.9, top: y + 6.4 });

    const shrine = { group: g, swirl, glowMat, light, halo, runeRing, pillar, active: false, idx, x, y, z };
    G.shrines.push(shrine);

    G.interactables.push({
      pos: new THREE.Vector3(x, y + 2, z), r: 4.5, label: 'Awaken beacon',
      onUse() {
        if (shrine.active) { G.ui.toast('The beacon hums peacefully.', 0x7fe8ff); return; }
        activateShrine(shrine);
      },
    });
  });
}

export function activateShrine(shrine, silent = false) {
  shrine.active = true;
  shrine.glowMat.color.set(0xaef4ff); // near-white cyan core (bloom-friendly)
  shrine.light.color.set(0x54e8ff);
  shrine.halo.material.color.set(0x54e8ff);
  shrine.runeRing.material.color.set(0x54e8ff);
  if (shrine.pillar) shrine.pillar.material.color.set(0x54e8ff);
  recolorAwakened(shrine); // GLB energy seams/core/inlay go cyan too
  G.respawn = { x: shrine.x + 5, y: shrine.y, z: shrine.z + 5 };
  if (silent) return;
  G.orbs++;
  G.hearts = G.maxHearts;
  spawnSparkle(shrine.x, shrine.y + 4, shrine.z, 0x54e8ff);
  if (G.player) spawnHealBloom(G.player.pos.x, G.player.pos.y, G.player.pos.z);
  G.ui.toast('Beacon awakened — Spirit Orb received!', 0x54e8ff);
  G.audio.sfx('shrine');
  if (G.orbs > 0 && G.orbs % 4 === 0) {
    // every 4 orbs: alternate heart / stamina upgrade
    if ((G.orbs / 4) % 2 === 1) {
      G.maxHearts += 4; G.hearts = G.maxHearts;
      G.ui.toast('Your life force grows — +1 Heart!', 0xff6a7a);
    } else {
      G.maxStamina += 30; G.stamina = G.maxStamina;
      G.ui.toast('Your endurance grows — +Stamina!', 0x8aff6a);
    }
  }
  save();
}

export function updateShrines(dt) {
  const p = G.player.pos;
  for (const s of G.shrines) {
    s.swirl.rotation.y += dt * (s.active ? 1.6 : 0.5);
    if (s.ring2) s.ring2.rotation.y -= dt * (s.active ? 1.1 : 0.35);
    if (s.ring3) s.ring3.rotation.y += dt * (s.active ? 0.7 : 0.22);
    const d2 = (p.x - s.x) ** 2 + (p.z - s.z) ** 2;
    s.light.intensity = d2 < 2500 ? (s.active ? 2.2 : 1.2) + Math.sin(G.time * 2.4) * 0.35 : 0;
    const pulse = 0.8 + Math.sin(G.time * 1.8 + s.idx) * 0.2;
    s.halo.material.opacity = (s.active ? 0.85 : 0.55) * pulse;
    s.halo.scale.setScalar(6.5 * pulse);
    s.runeRing.material.opacity = (s.active ? 0.55 : 0.35) * pulse;
    s.runeRing.rotation.z += dt * 0.15;
    if (s.pillar) s.pillar.material.opacity = (s.active ? 0.11 : 0.06) * pulse;
  }
}

// ---------------------------------------------------------------- towers

export const TOWER_POS = [[110, 20], [-200, -140], [-60, 220]];

export function buildTowers() {
  TOWER_POS.forEach(([x, z], idx) => {
    const y = heightAt(x, z);
    const g = new THREE.Group();
    g.position.set(x, y, z);
    const H = 34;

    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 3.4, H, 8), toonMat({ color: 0x7a7688 }));
    shaft.position.y = H / 2; shaft.castShadow = shaft.receiveShadow = true;
    // rest-ledge rings: wide enough to stand on between climbs
    for (let r = 1; r < 5; r++) {
      const ry = (H / 5) * r;
      const shaftR = 3.4 - (ry / H);            // shaft taper at this height
      const ringR = shaftR + 0.75;
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(ringR, ringR, 0.6, 8), toonMat({ color: 0x8a8698 }));
      ring.position.y = ry; ring.castShadow = true;
      g.add(ring); // decorative for climbing — the collider below makes it standable
      G.colliders.push({ x, z, r: ringR, top: y + ry + 0.3, soft: true });
    }
    const platform = new THREE.Mesh(new THREE.CylinderGeometry(4.6, 3.6, 1.2, 8), toonMat({ color: 0x8a8698 }));
    platform.position.y = H + 0.6; platform.castShadow = true;
    const spire = new THREE.Mesh(new THREE.ConeGeometry(1.1, 4.5, 6), toonMat({ color: 0x9a94ac }));
    spire.position.y = H + 3.4;
    const glowMat = new THREE.MeshBasicMaterial({ color: 0xffc27a }); // near-white amber core
    const beacon = new THREE.Mesh(new THREE.OctahedronGeometry(0.9), glowMat);
    beacon.position.y = H + 6.4;
    const beaconHalo = makeGlow(0xff9a3d, 9);
    beaconHalo.position.y = H + 6.4;
    g.add(beaconHalo);
    // slim skybeam above the spire, brightening once the region is charted
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.5, 46, 8, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xff9a3d, transparent: true, opacity: 0.07,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }));
    beam.position.y = H + 6.4 + 23;
    g.add(beam);
    // glowing band just below the platform
    const band = new THREE.Mesh(new THREE.TorusGeometry(2.55, 0.09, 8, 24),
      new THREE.MeshBasicMaterial({ color: 0xff9a3d, transparent: true, opacity: 0.7 }));
    band.rotation.x = Math.PI / 2;
    band.position.y = H - 0.5;
    g.add(band);

    g.add(shaft, platform, spire, beacon);
    G.scene.add(g);
    G.climbMeshes.push(shaft, platform);
    // hard body-block in height bands matching the shaft taper, so upper
    // rings stay standable while the shaft can never be walked through
    for (let b = 0; b < 5; b++) {
      const midR = 3.4 - ((b + 0.5) * (H / 5)) / H; // taper at band middle
      G.colliders.push({ x, z, r: midR + 0.1, bottom: y + b * (H / 5), top: y + (b + 1) * (H / 5) });
    }
    // the platform is a soft stand
    G.colliders.push({ x, z, r: 4.5, top: y + H + 1.2, soft: true });

    const tower = { group: g, glowMat, beacon, beaconHalo, band, beam, active: false, idx, x, y, z, topY: y + H + 1.2 };
    G.towers.push(tower);
  });
}

export function updateTowers() {
  const p = G.player.pos;
  for (const t of G.towers) {
    t.beacon.rotation.y += 0.02;
    if (t.ring) t.ring.rotation.y += 0.012;
    t.beaconHalo.material.opacity = 0.65 + Math.sin(G.time * 2 + t.idx * 2) * 0.2;
    t.beam.material.opacity = (t.active ? 0.10 : 0.05) * (0.8 + Math.sin(G.time * 1.6 + t.idx) * 0.2);
    if (!t.active && Math.hypot(p.x - t.x, p.z - t.z) < 4.8 && p.y > t.topY - 0.6) {
      t.active = true;
      t.glowMat.color.set(0xaef4ff); // near-white cyan core (bloom-friendly)
      t.beaconHalo.material.color.set(0x54e8ff);
      t.band.material.color.set(0x54e8ff);
      t.beam.material.color.set(0x54e8ff);
      if (t.energyMats) for (const m of t.energyMats) { m.color.setHex(0x9feaff); m.emissive.setHex(0x54e8ff); }
      G.ui.banner('REGION CHARTED', 'The land is revealed on your map');
      G.audio.sfx('tower');
      spawnSparkle(t.x, t.topY + 4, t.z, 0x54e8ff);
      save();
    }
  }
}

// ---------------------------------------------------------------- grabbable props
// world.js owns prop physics (SHARED CONTRACT 4): every grabbable carries
// userData { grabbable, kind, size {w,h,d} FULL extents, heavy?, falling,
// floorY, vy, vx, vz }. player.js owns input/carry.

const CRATE_SIZE = { w: 1.6, h: 1.6, d: 1.6 };
const SLAB_SIZE = { w: 2.2, h: 0.5, d: 2.2 };
const standSurfaces = []; // {x, z, r, top} puzzle surfaces props can rest on

function initGrabbable(mesh, kind, size, heavy) {
  Object.assign(mesh.userData, {
    grabbable: true, kind, size, heavy: !!heavy,
    falling: false, floorY: mesh.position.y, vy: 0, vx: 0, vz: 0,
  });
}

export function buildCrates() {
  const clusters = [[68, -72], [52, -90], [-24, 46], [176, 96], [-166, 124], [-86, -204], [114, 284]];
  const geo = new THREE.BoxGeometry(1.6, 1.6, 1.6);
  const mat = toonMat({ color: 0xa8814f });
  const edgeMat = toonMat({ color: 0x6e5433 });
  clusters.forEach(([cx, cz], ci) => {
    const n = 2 + (hash2(ci, 401) * 2 | 0);
    for (let i = 0; i < n; i++) {
      const x = cx + (hash2(ci, 403 + i) - 0.5) * 6;
      const z = cz + (hash2(ci, 409 + i) - 0.5) * 6;
      const y = heightAt(x, z);
      if (y < WATER_Y + 0.3) continue;
      const crate = new THREE.Mesh(geo, mat.clone());
      const frame = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.25, 1.7), edgeMat);
      frame.position.y = 0.7; crate.add(frame);
      const frame2 = frame.clone(); frame2.position.y = -0.7; crate.add(frame2);
      crate.position.set(x, y + 0.8, z);
      crate.rotation.y = hash2(ci, 421 + i) * Math.PI;
      crate.castShadow = crate.receiveShadow = true;
      initGrabbable(crate, 'crate', CRATE_SIZE, false);
      G.scene.add(crate);
      G.grabbables.push(crate);
      G.climbMeshes.push(crate);
    }
  });
  buildSlabs();
}

// heavy stone slabs: bridge / ramp material near two ruin sites and the gorge
const SLAB_SPOTS = [
  [99, 133], [89, 131], [101, 116],      // vault ruin near Thornwood (95,125)
  [-158, -77], [-143, -79], [-155, -84], // western vault ruin (-150,-85)
  [-78, -30], [-84, -21],                // river gorge crossing
];

function buildSlabs() {
  const geo = new THREE.BoxGeometry(SLAB_SIZE.w, SLAB_SIZE.h, SLAB_SIZE.d);
  const mat = toonMat({ color: 0xa9a196 });
  SLAB_SPOTS.forEach(([x, z], i) => {
    const y = heightAt(x, z);
    if (y < WATER_Y + 0.3) return;
    const slab = new THREE.Mesh(geo, mat);
    slab.position.set(x, y + SLAB_SIZE.h / 2, z);
    slab.rotation.y = hash2(i, 431) * Math.PI;
    slab.castShadow = slab.receiveShadow = true;
    initGrabbable(slab, 'slab', SLAB_SIZE, true);
    G.scene.add(slab);
    G.grabbables.push(slab);
  });
}

// resting height for a prop at its current xz: terrain, stacks of other
// grabbables, and puzzle surfaces (pressure plates, vault floors)
function propFloorY(c) {
  const s = c.userData.size || CRATE_SIZE;
  const hh = s.h / 2;
  const p = c.position;
  let floor = heightAt(p.x, p.z) + hh;
  for (const o of G.grabbables) {
    if (o === c) continue;
    const os = o.userData.size || CRATE_SIZE;
    const dx = Math.abs(o.position.x - p.x), dz = Math.abs(o.position.z - p.z);
    if (dx < (s.w + os.w) * 0.5 - 0.1 && dz < (s.d + os.d) * 0.5 - 0.1) {
      const top = o.position.y + os.h / 2;
      if (top + hh > floor && top <= p.y + 0.55) floor = top + hh;
    }
  }
  for (const sf of standSurfaces) {
    if (Math.hypot(p.x - sf.x, p.z - sf.z) < sf.r &&
        sf.top + hh > floor && sf.top <= p.y - hh + 0.75) floor = sf.top + hh;
  }
  return floor;
}

// props fall + stack when released / thrown
export function settleCrate(crate) {
  const ud = crate.userData;
  if (!ud.size) initGrabbable(crate, ud.kind || 'crate', CRATE_SIZE, ud.heavy);
  ud.floorY = propFloorY(crate);
  ud.falling = true;
}

// push a moving prop out of hard world colliders (trees, walls, vault doors)
function propPushOut(c) {
  const s = c.userData.size || CRATE_SIZE;
  const rad = Math.max(s.w, s.d) * 0.5;
  for (const col of G.colliders) {
    if (col.soft) continue;
    const dx = c.position.x - col.x, dz = c.position.z - col.z;
    const min = col.r + rad * 0.7;
    const d2 = dx * dx + dz * dz;
    if (d2 >= min * min || d2 < 1e-8) continue;
    if (col.top !== undefined && c.position.y - s.h * 0.5 > col.top - 0.25) continue;
    if (col.bottom !== undefined && c.position.y + s.h * 0.5 < col.bottom) continue;
    const d = Math.sqrt(d2);
    c.position.x = col.x + (dx / d) * min;
    c.position.z = col.z + (dz / d) * min;
    c.userData.vx *= 0.4;
    c.userData.vz *= 0.4;
  }
}

export function updateCrates(dt) {
  const held = (G.player && G.player.held) || null;
  const list = G.grabbables;
  for (const c of list) {
    if (c === held) continue;
    const ud = c.userData;
    if (!ud.size) initGrabbable(c, 'crate', CRATE_SIZE, false);
    if (ud.falling) {
      ud.vy = (ud.vy || 0) - 25 * dt;
      c.position.y += ud.vy * dt;
      if (ud.vx || ud.vz) {
        c.position.x += ud.vx * dt;
        c.position.z += ud.vz * dt;
        propPushOut(c);
        ud.floorY = propFloorY(c); // floor tracks horizontal flight
      }
      if (c.position.y <= ud.floorY) {
        c.position.y = ud.floorY;
        ud.falling = false;
        const impact = -ud.vy;
        ud.vy = 0;
        const sp = Math.hypot(ud.vx, ud.vz);
        // full thud for drops, a lighter skip for fast shallow slides
        G.audio.sfx(impact > 4.5 || sp < 1.6 ? 'thud' : 'land');
      }
    } else if (ud.vx * ud.vx + ud.vz * ud.vz > 0.001) {
      // sliding on the ground: friction until it stops (decay ~6/s)
      c.position.x += ud.vx * dt;
      c.position.z += ud.vz * dt;
      propPushOut(c);
      const f = Math.max(0, 1 - 6 * dt);
      ud.vx *= f; ud.vz *= f;
      if (ud.vx * ud.vx + ud.vz * ud.vz < 0.04) ud.vx = ud.vz = 0;
      const fl = propFloorY(c);
      if (fl < c.position.y - 0.3) { ud.falling = true; ud.floorY = fl; } // slid off an edge
      else if (fl > c.position.y + 0.45) { ud.vx = ud.vz = 0; }           // bumped a step
      else c.position.y = fl;
    } else {
      // support check: a stack falls when its base is yanked away
      const fl = propFloorY(c);
      if (fl < c.position.y - 0.08) { ud.falling = true; ud.floorY = fl; }
    }
  }
  // simple push-out so thrown props never interpenetrate (xz AABB)
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === held) continue;
    const sa = a.userData.size || CRATE_SIZE;
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      if (b === held) continue;
      const sb = b.userData.size || CRATE_SIZE;
      // cleanly stacked pairs have no vertical overlap — skip
      if (a.position.y + sa.h / 2 - 0.06 <= b.position.y - sb.h / 2 ||
          b.position.y + sb.h / 2 - 0.06 <= a.position.y - sa.h / 2) continue;
      const dx = b.position.x - a.position.x, dz = b.position.z - a.position.z;
      const px = (sa.w + sb.w) * 0.5 - Math.abs(dx);
      const pz = (sa.d + sb.d) * 0.5 - Math.abs(dz);
      if (px < 0.02 || pz < 0.02) continue;
      if (px < pz) {
        const s = (dx >= 0 ? 1 : -1) * px * 0.5;
        a.position.x -= s; b.position.x += s;
      } else {
        const s = (dz >= 0 ? 1 : -1) * pz * 0.5;
        a.position.z -= s; b.position.z += s;
      }
      if (!a.userData.falling) {
        const fa = propFloorY(a);
        if (fa < a.position.y - 0.05) { a.userData.falling = true; a.userData.floorY = fa; }
      }
      if (!b.userData.falling) {
        const fb = propFloorY(b);
        if (fb < b.position.y - 0.05) { b.userData.falling = true; b.userData.floorY = fb; }
      }
    }
  }
  // world systems that ride along with prop physics (driven every frame here;
  // main.js stays untouched)
  updateVaults(dt);
  updateChestLids(dt);
  updateBellows(dt);
  updatePods(dt);
  updateUpdraftFx();
  for (let i = G.updraftZones.length - 1; i >= 0; i--) {
    const z = G.updraftZones[i];
    if (z.expires !== undefined && G.time > z.expires) G.updraftZones.splice(i, 1);
  }
}

// ---------------------------------------------------------------- treasure chests

const chests = [];
let chestKit = null;

function applyOpenedChest(chest) {
  chest.opening = true;
  chest.done = true;
  chest.t = 0.5;
  if (chest.it) chest.it.gone = true;
  chest.lid.rotation.x = chest.openAngle || -1.9;
}

function makeChest(id, x, y, z, yaw, loot, gate) {
  if (!chestKit) {
    chestKit = {
      baseGeo: new THREE.BoxGeometry(0.95, 0.52, 0.62),
      lidGeo: new THREE.BoxGeometry(0.99, 0.22, 0.66),
      bandGeo: new THREE.BoxGeometry(1.03, 0.09, 0.7),
      lockGeo: new THREE.BoxGeometry(0.18, 0.2, 0.07),
      wood: toonMat({ color: 0x8f5f30 }),
      trim: toonMat({ color: 0xd9a83f }),
    };
  }
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.rotation.y = yaw;
  const base = new THREE.Mesh(chestKit.baseGeo, chestKit.wood);
  base.position.y = 0.27;
  const band = new THREE.Mesh(chestKit.bandGeo, chestKit.trim);
  band.position.y = 0.12;
  const lock = new THREE.Mesh(chestKit.lockGeo, chestKit.trim);
  lock.position.set(0, 0.5, 0.33);
  const lid = new THREE.Group();
  lid.position.set(0, 0.53, -0.33); // hinge along the back edge
  const lidMesh = new THREE.Mesh(chestKit.lidGeo, chestKit.wood);
  lidMesh.position.set(0, 0.1, 0.33);
  const lidBand = new THREE.Mesh(chestKit.bandGeo, chestKit.trim);
  lidBand.position.set(0, 0.18, 0.33);
  lid.add(lidMesh, lidBand);
  g.add(base, band, lock, lid);
  g.traverse(o => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
  G.scene.add(g);
  const chest = { id, x, y, z, grp: g, lid, loot, opening: false, t: 0, done: false, it: null };
  chests.push(chest);
  const it = {
    pos: new THREE.Vector3(x, y + 0.4, z), r: 2.4, label: 'Open chest',
    onUse() {
      if (this.gone || chest.opening) return;
      if (gate && !gate()) return;
      this.gone = true;
      chest.opening = true;
      G.audio.sfx('grab');
    },
  };
  chest.it = it;
  G.interactables.push(it);
  if (worldClaimed('chests', id)) applyOpenedChest(chest);
  return chest;
}

// TotK-style reveal: the found item rises out of the chest, spinning
const flourishes = [];
function itemFlourish(ch, kind) {
  const m = propInstance(kind);
  if (!m) return;
  m.position.set(ch.x, ch.y + 0.5, ch.z);
  G.scene.add(m);
  flourishes.push({ m, t: 0, x: ch.x, y: ch.y, z: ch.z });
}

function updateChestLids(dt) {
  for (let i = flourishes.length - 1; i >= 0; i--) {
    const f = flourishes[i];
    f.t += dt;
    const k = f.t / 1.5;
    if (k >= 1) {
      G.scene.remove(f.m);
      flourishes.splice(i, 1);
      continue;
    }
    f.m.position.y = f.y + 0.5 + Math.min(1, k * 1.6) * 1.1;
    f.m.rotation.y = k * 5;
    const s = k > 0.8 ? 1 - (k - 0.8) * 5 : 1; // shrink away at the end
    f.m.scale.setScalar(Math.max(0.01, s * 1.5));
  }
  for (const ch of chests) {
    if (!ch.opening || ch.done) continue;
    ch.t += dt;
    const f = Math.min(1, ch.t / 0.5);
    const e = f * f * (3 - 2 * f);
    ch.lid.rotation.x = e * (ch.openAngle || -1.9);
    if (f >= 1) {
      ch.done = true;
      claimWorld('chests', ch.id);
      spawnSparkle(ch.x, ch.y + 0.9, ch.z, 0xffdf8a, 32, 4);
      const l = ch.loot;
      if (l.kind === 'gems') {
        G.gems += l.n;
        markSeen('gem');
        G.ui.toast(l.n >= 8 ? 'A trove! ' + l.n + ' sky gems!' : 'The chest holds ' + l.n + ' sky gems!', 0x9fefff);
        G.audio.sfx('pickup');
      } else if (l.kind === 'apples') {
        G.apples += l.n;
        G.ui.toast('Someone left ' + l.n + ' apples inside. Still crisp!', 0xffb6a3);
        G.audio.sfx('pickup');
      } else if (l.kind === 'arrows') {
        G.player.arrows += l.n * (G.equip.quiver ? 2 : 1); // deep quiver: caches yield double
        markSeen('arrow');
        G.ui.toast('A bundle of ' + l.n + ' arrows!', 0xf4ecd2);
        G.audio.sfx('pickup');
      } else if (ITEM_DEFS[l.kind]) {
        G.items[l.kind] = (G.items[l.kind] || 0) + 1;
        markSeen(l.kind);
        itemFlourish(ch, l.kind);
        G.ui.toast(ITEM_DEFS[l.kind].name + ' — ' + ITEM_DEFS[l.kind].note, ITEM_DEFS[l.kind].tint, 4600);
        G.audio.sfx('heartup');
      } else if (l.kind === 'glimmer') {
        if (claimGlimmer(l.glimmerId)) {
          G.ui.toast('A glimmer was napping inside! "Rude! ...Tee-hee."', 0x9fffb0);
          G.audio.sfx('glimmer');
        } else {
          G.ui.toast('Only a warm leaf-print remains inside.', 0xcfc4a6);
        }
      }
      save();
    }
  }
}

// ---- Blender prop upgrades: swap procedural stand-ins once GLBs land ------

// the shader-plane falls read as flat stripes from a distance; swap each for
// the authored ribbon (origin at the lip, native drop 10m, stretched to
// length). Foam nodes counter-scale so the stretch never distorts them, and
// the base spray glow moves onto the island group so it survives the swap.
const fallPlanes = [];
const fallFx = [];
function upgradeWaterfalls() {
  for (const plane of fallPlanes) {
    if (!plane.geometry || !plane.geometry.parameters) continue;
    const len = plane.geometry.parameters.height;
    const ci = contractInstance('waterfall');
    if (!ci) return;
    const root = ci.root;
    root.position.set(plane.position.x, plane.position.y + len / 2, plane.position.z);
    root.rotation.y = plane.rotation.y;
    root.scale.y = len / 10;
    const counter = 10 / len;
    const ft = root.getObjectByName('FoamTop');
    const fb = root.getObjectByName('FoamBase');
    if (ft) ft.scale.y = counter;
    if (fb) fb.scale.y = counter;
    // keep the base spray alive on the parent
    const spray = plane.children.find(c => c.isSprite);
    if (spray) {
      plane.remove(spray);
      spray.position.set(plane.position.x, plane.position.y - len / 2 - 0.2, plane.position.z);
      plane.parent.add(spray);
    }
    plane.parent.add(root);
    plane.visible = false;
    fallFx.push({ root, waterMats: ci.mats.Water || [], foamMats: ci.mats.Foam || [] });
  }
}

function upgradeChests() {
  for (const ch of chests) {
    // prefer the signature stone-and-bronze chest; fall back to the gen model
    let inst = null, lid = null, openAngle = -1.3;
    const sig = contractInstance('treasure_chest');
    if (sig) { inst = sig.root; lid = inst.getObjectByName('Lid'); }
    if (!lid) {
      inst = propInstance('chest');
      if (!inst) return;
      lid = inst.getObjectByName('lid');
      openAngle = -1.9;
      if (!lid) return;
    }
    ch.grp.clear();
    ch.grp.add(inst);
    ch.lid = lid;
    ch.openAngle = openAngle;
    if (ch.done) lid.rotation.x = openAngle; // already-opened chests stay open
  }
}

// ---- signature landmarks: swap shrines/towers/bellows to the authored GLBs

function upgradeShrines() {
  for (const s of G.shrines) {
    const ci = contractInstance('beacon_shrine');
    if (!ci) return;
    const keep = new Set([s.light, s.halo, s.pillar]);
    for (const c of [...s.group.children]) if (!keep.has(c)) s.group.remove(c);
    s.group.add(ci.root);
    // rebind animated/stateful pieces onto the GLB nodes
    s.swirl = ci.root.getObjectByName('Ring1') || s.swirl;
    s.ring2 = ci.root.getObjectByName('Ring2');
    s.ring3 = ci.root.getObjectByName('Ring3');
    s.energyMats = (ci.mats.EnergyAmber || []).concat(ci.mats.EnergyGreen || []);
    s.halo.position.y = 5.0;   // the floating core sits at Y 5
    s.light.position.y = 5.0;
    if (s.runeRing) s.runeRing.visible = false; // the GLB floor inlay replaces it
    // stand on the top terrace (Y 2.4, ~8x8 stepped base)
    G.colliders.push({ x: s.x, z: s.z, r: 3.4, top: s.y + 2.4, soft: true });
    // hard body around the terrace sides so you can't wade through the stone —
    // corners + flanks + back, leaving the +Z staircase corridor open
    for (const [ox, oz, r] of [[-2.6, -2.6, 1.7], [2.6, -2.6, 1.7], [-2.6, 2.6, 1.5],
                               [2.6, 2.6, 1.5], [-3.5, 0, 1.2], [3.5, 0, 1.2], [0, -3.6, 1.7]]) {
      G.colliders.push({ x: s.x + ox, z: s.z + oz, r, top: s.y + 2.4 });
    }
    const base = ci.root.getObjectByName('Base');
    if (base) G.climbMeshes.push(base);
    if (s.active) recolorAwakened(s);
  }
}

function recolorAwakened(s) {
  if (!s.energyMats) return;
  for (const m of s.energyMats) {
    m.color.setHex(0x9feaff);
    m.emissive.setHex(0x54e8ff);
  }
}

function upgradeTowers() {
  for (const t of G.towers) {
    const ci = contractInstance('skywatch_tower');
    if (!ci) return;
    const keep = new Set([t.beaconHalo, t.beam]);
    for (const c of [...t.group.children]) if (!keep.has(c)) t.group.remove(c);
    t.group.add(ci.root);
    const beacon = ci.root.getObjectByName('Beacon');
    if (beacon) {
      t.beacon = beacon;
      t.glowMat = beacon.material;
    }
    t.ring = ci.root.getObjectByName('BeaconRing');
    t.energyMats = (ci.mats.EnergyAmber || []).concat(ci.mats.EnergyGreen || []);
    t.beaconHalo.position.y = 39.55;
    t.beam.position.y = 39.55 + 23;
    t.topY = t.y + 37.6;                          // crown walkway height
    G.colliders.push({ x: t.x, z: t.z, r: 3.2, top: t.y + 37.6, soft: true });
    // the stepped plinth is wider than the old shaft bands — match its edge
    G.colliders.push({ x: t.x, z: t.z, r: 4.5, top: t.y + 2.2 });
    for (const n of ['Shaft', 'Crown', 'Plinth1', 'Plinth2']) {
      const m = ci.root.getObjectByName(n);
      if (m) G.climbMeshes.push(m);
    }
    if (t.active) {
      t.glowMat.color.set(0xaef4ff);
      for (const m of t.energyMats) { m.color.setHex(0x9feaff); m.emissive.setHex(0x54e8ff); }
    }
  }
}

function upgradeBellows() {
  if (!bellows) return;
  const ci = contractInstance('wind_bellows');
  if (!ci) return;
  const b = bellows;
  const g = G.interactables; // (bellows group isn't stored; rebuild visuals in place)
  // the procedural bellows lives in its own group added to the scene — find it
  // via the sack's parent chain
  const grp = b.sack.parent;
  const keep = new Set([b.glow]);
  for (const c of [...grp.children]) if (!keep.has(c)) grp.remove(c);
  // face the horn toward the open meadow (+Z locally; rotate to face west)
  const rot = Math.PI * 0.75;
  ci.root.rotation.y = rot;
  grp.add(ci.root);
  b.sack = ci.root.getObjectByName('Sack') || b.sack;
  b.glb = true;
  b.glow.position.y = 3.3;
  // the updraft column rises from the vent plate, 1.5m in front of the maw
  b.ventX = b.x + Math.sin(rot) * 1.5;
  b.ventZ = b.z + Math.cos(rot) * 1.5;
}

// bake a prop's material colors into vertex colors and merge to one geometry
// so apples/gems keep riding a single InstancedMesh draw call
function glbInstGeo(name) {
  const root = propInstance(name);
  if (!root) return null;
  root.updateMatrixWorld(true);
  const geos = [];
  root.traverse(o => {
    if (!o.isMesh) return;
    let g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    if (g.index) g = g.toNonIndexed();
    for (const a of ['uv', 'uv1', 'uv2', 'tangent', 'skinIndex', 'skinWeight']) {
      if (g.attributes[a]) g.deleteAttribute(a);
    }
    const col = (o.material && o.material.color) ? o.material.color : { r: 1, g: 1, b: 1 };
    const n = g.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      arr[i * 3] = col.r; arr[i * 3 + 1] = col.g; arr[i * 3 + 2] = col.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    geos.push(g);
  });
  return geos.length ? mergeGeometries(geos) : null;
}

function upgradePickupMeshes() {
  for (const kind of ['apple', 'gem', 'pod']) {
    const geo = glbInstGeo(kind === 'pod' ? 'zephyr_pod' : kind);
    if (!geo) continue;
    geo.translate(0, kind === 'apple' ? -0.13 : kind === 'pod' ? -0.22 : -0.15, 0); // center like the old geo
    const old = pickupMeshes[kind];
    const mesh = new THREE.InstancedMesh(geo, toonMat({ vertexColors: true }), old.instanceMatrix.count);
    mesh.frustumCulled = false;
    mesh.count = 0;
    G.scene.remove(old);
    G.scene.add(mesh);
    pickupMeshes[kind] = mesh;
  }
}

// world dressing with the signature set: fallen sky-ruin debris on the
// meadows, glowing gloom-flora in the deep woods, golden hero trees in
// Thornwood, ouroboros gate emblems on the old roads, and two dormant
// construct golems standing sentry at the vault ruins.
const gloomFlora = []; // { root, x, z, seed } — burnable by kindled arrows

// A kindled arrow burns away gloom flora, sometimes revealing what the gloom
// was hiding (deterministic per plant, so a bush always hides the same thing).
export function burnGloomAt(x, z, r) {
  let burned = 0;
  for (let i = gloomFlora.length - 1; i >= 0; i--) {
    const f = gloomFlora[i];
    const dx = x - f.x, dz = z - f.z;
    if (dx * dx + dz * dz > r * r) continue;
    gloomFlora.splice(i, 1);
    f.root.visible = false;
    const y = heightAt(f.x, f.z);
    spawnSparkle(f.x, y + 0.8, f.z, 0xff8a3c, 26, 3.4);
    spawnSparkle(f.x, y + 1.1, f.z, 0x7de89a, 10, 2.2);
    const roll = hash2(f.seed, 77);
    if (roll < 0.18) addPickup('gem', f.x, y + 0.4, f.z);
    else if (roll < 0.45) addPickup('apple', f.x, y + 0.4, f.z);
    burned++;
  }
  return burned;
}

function dressWorld() {
  const put = (name, x, z, ry = 0, s = 1, sink = 0.1) => {
    const ci = contractInstance(name);
    if (!ci) return null;
    ci.root.position.set(x, heightAt(x, z) - sink, z);
    ci.root.rotation.y = ry;
    ci.root.scale.setScalar(s);
    G.scene.add(ci.root);
    return ci;
  };
  // fallen sky-tech scattered along the valley floor (every vista gets one)
  const DEBRIS = [
    [95, -30, 1.2], [-40, -120, 2.6], [140, 160, 0.4], [-120, 30, 4.1],
    [10, 150, 5.3], [200, -100, 2.0], [-200, 180, 3.4], [60, 320, 1.7],
  ];
  for (const [x, z, r] of DEBRIS) {
    if (heightAt(x, z) < WATER_Y + 1) continue;
    const sc = 0.9 + hash2(x | 0, z | 0) * 0.5;
    const ci = put('sky_debris', x, z, r, sc);
    if (!ci) continue;
    // collide each debris piece where it actually sits (the set spans ~7m)
    for (const [node, pr, ph] of [['Debris_A', 1.5, 1.6], ['Debris_B', 1.0, 1.8], ['Debris_C', 0.9, 1.0]]) {
      const m = ci.root.getObjectByName(node);
      if (!m) continue;
      const lx = m.position.x * sc, lz = m.position.z * sc;
      const wx = x + lx * Math.cos(r) + lz * Math.sin(r);
      const wz = z - lx * Math.sin(r) + lz * Math.cos(r);
      G.colliders.push({ x: wx, z: wz, r: pr * sc, top: heightAt(x, z) + ph * sc });
    }
  }
  // bioluminescent gloom flora under the dense western woods
  for (let i = 0; i < 4000; i++) {
    const x = (hash2(i, 3301) - 0.5) * 700, z = (hash2(i, 3307) - 0.5) * 700;
    if (heightAt(x, z) < WATER_Y + 1.5) continue;
    if (fbm(x * 0.006 + 60, z * 0.006 - 33, 3) < 0.3) continue; // deepest woods only
    if (hash2(i, 3311) > 0.06) continue;
    const ci = put('gloom_flora', x, z, hash2(i, 3313) * Math.PI * 2, 0.8 + hash2(i, 3317) * 0.6);
    if (ci) gloomFlora.push({ root: ci.root, x, z, seed: i }); // burnable (kindled arrows)
  }
  // golden hero trees crown the Thornwood
  for (const [x, z, r] of [[78, 196, 0.6], [96, 214, 2.2], [64, 220, 4.0]]) {
    put('tree_autumn', x, z, r, 1.5, 0.15);
    G.colliders.push({ x, z, r: 0.8, top: heightAt(x, z) + 5 });
  }
  // ouroboros gate emblems mark the old roads to the towers
  for (const [x, z, ry] of [[97, 7, 0.9], [-47, 203, 2.4]]) {
    const ci = put('ouroboros_ring', x, z, ry, 1.6, -1.2);
    if (ci) ci.root.position.y = heightAt(x, z) + 1.2;
  }
  // --- curated pack dressing (CC0 Kenney / Poly Pizza) ---------------------
  const putPack = (name, x, z, ry = 0, s = 1) => {
    const m = propInstance(name);
    if (!m) return null;
    m.position.set(x, heightAt(x, z) - 0.06, z);
    m.rotation.y = ry;
    m.scale.setScalar(s);
    G.scene.add(m);
    return m;
  };
  // the old lantern road: an authored path from the spawn plateau to the
  // first beacon and on toward the tower — something to follow on foot
  const ROAD = [[50, -68], [56, -75], [60, -84], [70, -70], [82, -52], [94, -32], [104, -8], [110, 14]];
  for (let i = 0; i < ROAD.length; i++) {
    const [x, z] = ROAD[i];
    if (heightAt(x, z) < WATER_Y + 1) continue;
    putPack('pk_lightpost', x + (i % 2 ? 2.2 : -2.2), z, hash2(i, 41) * Math.PI, 1.4);
  }
  // broken gate + waymark obelisks at the region thresholds
  putPack('pk_wall_damaged', 40, 120, 0.4, 2.2);       // Heartfields -> Thornwood road
  putPack('pk_obelisk', 44, 124, 0.4, 1.8);
  putPack('pk_obelisk', -96, 96, 1.2, 1.8);            // Mirrormere approach
  putPack('pk_obelisk', -60, -180, 2.6, 1.8);          // Stormridge approach
  // Stormridge identity: glowing crystals + tall detailed pines
  for (const [x, z, r] of [[-104, -232, 1.1], [-140, -276, 3.0], [-88, -270, 0.2]]) {
    putPack('pk_crystal', x, z, r, 1.6);
    G.colliders.push({ x, z, r: 1.0, top: heightAt(x, z) + 1.6 });
  }
  for (const [x, z] of [[-112, -216, 0], [-132, -246, 0], [-96, -252, 0]]) {
    putPack('pk_pine_tall', x, z, hash2(x | 0, z | 0) * Math.PI, 2.6);
    G.colliders.push({ x, z, r: 0.7, top: heightAt(x, z) + 6 });
  }
  // Mirrormere identity: purple bloom drifts along the shore
  for (let i = 0; i < 14; i++) {
    const a = hash2(i, 4401) * Math.PI * 2, d = 60 + hash2(i, 4407) * 45;
    const x = -170 + Math.cos(a) * d, z = 120 + Math.sin(a) * d;
    if (heightAt(x, z) < WATER_Y + 0.8) continue;
    putPack('pk_flower_purple', x, z, hash2(i, 4411) * Math.PI, 1.8 + hash2(i, 4413));
  }

  // dormant construct golems stand sentry at the vault ruins
  for (const [x, z, ry] of [[106, 124, -2.2], [-146, -96, 0.7]]) {
    const ci = put('construct_golem', x, z, ry, 1.15);
    if (!ci) continue;
    G.colliders.push({ x, z, r: 1.2, top: heightAt(x, z) + 2.6 });
    golems.push({ root: ci.root, ph: hash2(x | 0, z | 0) * 9,
      // energy seams kindle tier by tier as gear is offered (recolor in updateGolems)
      energyMats: (ci.mats.EnergyAmber || []).concat(ci.mats.EnergyGreen || []),
      appliedTier: -1,
      parts: ['Head', 'Torso', 'ArmL', 'ArmR', 'ShoulderL', 'ShoulderR']
        .map(n => ci.root.getObjectByName(n)).filter(Boolean)
        .map(o => ({ o, y: o.position.y })) });
  }
}

// ---- golem-forged wayfarer gear ---------------------------------------------
// Offer Ancient Gears to the dormant vault golems and their eyes kindle as
// they forge permanent upgrades. Registered at fixed coords (not inside
// dressWorld) so the trade works even if the golem GLB never loads.
const FORGE_ORDER = [
  ['stormcloth', 'Stormcloth Glider', 'the canopy sips stamina on the wind'],
  ['barkgrip', 'Barkgrip Gauntlets', 'the cliffs ask less of you'],
  ['quiver', 'Deep Quiver', '+10 arrows now — arrow caches yield double'],
];
export function equipTier() {
  return FORGE_ORDER.reduce((n, [k]) => n + (G.equip[k] ? 1 : 0), 0);
}
function buildGolemForges() {
  for (const [x, z] of [[106, 124], [-146, -96]]) {
    G.interactables.push({
      pos: new THREE.Vector3(x, heightAt(x, z) + 1.6, z),
      r: 3.4, label: 'Offer an Ancient Gear',
      onUse() {
        const next = FORGE_ORDER.find(([k]) => !G.equip[k]);
        if (!next) {
          G.ui.dialog('The Construct', 'The great palm closes, gently. It has given all it holds.', false);
          return;
        }
        if ((G.items.gear || 0) <= 0) {
          G.ui.dialog('The Construct', 'The palm lies open, waiting. It wants the old gears — the bronze ones the sky-works shed when the islands fell.', false);
          return;
        }
        G.items.gear--;
        G.equip[next[0]] = true;
        if (next[0] === 'quiver' && G.player) G.player.arrows += 10;
        G.camShake += 0.3;
        G.audio.sfx('shrine');
        spawnSparkle(x, heightAt(x, z) + 3, z, 0x54e8ff, 30, 3.5);
        G.ui.banner(next[1], next[2]);
        save();
      },
    });
  }
}

// dormant golems breathe: their floating blocks bob out of phase — and when
// the wanderer strays close, the eye flares and the ground trembles once.
// A sleeping danger, not yet a fight.
const golems = [];
// per-forge-tier seam palette: amber sleep -> waking green-cyan -> full awakened
const TIER_SEAMS = [
  null, // tier 0: authored amber, untouched
  { color: 0xc4e4c4, emissive: 0x2f8a6a },
  { color: 0xaee8da, emissive: 0x3fb8c0 },
  { color: 0x9feaff, emissive: 0x54e8ff },
];
export function updateGolems() {
  const p = G.player ? G.player.pos : null;
  const tier = equipTier();
  for (const g of golems) {
    // seams kindle as gear is forged; idempotent, so save-loads recolor too
    if (g.appliedTier !== tier) {
      g.appliedTier = tier;
      const seam = TIER_SEAMS[tier];
      if (seam) for (const m of g.energyMats) {
        m.color.setHex(seam.color);
        m.emissive.setHex(seam.emissive);
      }
    }
    const bobMul = 1 + tier * 0.5; // a waking golem breathes deeper
    for (let i = 0; i < g.parts.length; i++) {
      const pt = g.parts[i];
      pt.o.position.y = pt.y + Math.sin(G.time * 0.9 + g.ph + i * 1.3) * 0.035 * bobMul;
    }
    if (!p) continue;
    const d = Math.hypot(p.x - g.root.position.x, p.z - g.root.position.z);
    if (d < 6 && !g.stirred) {
      g.stirred = true;
      G.camShake += 0.35;
      G.audio.sfx('thud');
      if (tier === 0) G.ui.toast('The construct stirs in its sleep... best not linger.', 0x9fffc8, 3600);
      spawnSparkle(g.root.position.x, g.root.position.y + 2.2, g.root.position.z,
        tier > 0 ? 0x54e8ff : 0x39ff88, 10, 2);
    } else if (d > 14 && g.stirred) {
      g.stirred = false; // it settles once you retreat
    }
  }
}

// kicked from initPickups at boot; every consumer keeps procedural fallbacks
function loadGenProps() {
  preloadModels(GEN_PROPS.concat(SIGNATURE_PROPS, PACK_PROPS)).then(() => {
    upgradeChests();
    upgradePickupMeshes();
    upgradeShrines();
    upgradeTowers();
    upgradeBellows();
    upgradeWaterfalls();
    dressWorld();
  }).catch(() => {});
}

// ------------------------------------------------- pressure-plate vaults

const vaults = [];

function applyOpenedVault(v) {
  v.open = true;
  v.doorT = 1.2;
  v.emblem.material.opacity = 0.95;
  v.door.position.y = v.doorBaseY - 3.1;
  v.doorCol.top = v.y0 + 0.3;
  v.ring.material.opacity = 0.9;
}

function buildVault(id, cx, cz, fx, fz, loot) {
  const y0 = heightAt(cx, cz);
  const rx = fz, rz = -fx; // right basis (f rotated -90°)
  const yaw = Math.atan2(fx, fz);
  const stone = toonMat({ color: 0x9b9384 });
  const dark = toonMat({ color: 0x847c6e });
  const g = new THREE.Group();
  g.position.set(cx, y0, cz);
  g.rotation.y = yaw;

  const floorM = new THREE.Mesh(new THREE.BoxGeometry(5, 0.35, 5), stone);
  floorM.position.y = 0.175;
  const back = new THREE.Mesh(new THREE.BoxGeometry(4.4, 3.2, 0.6), stone);
  back.position.set(0, 1.6, -1.9);
  const sideGeo = new THREE.BoxGeometry(0.6, 3.2, 4.4);
  const sideL = new THREE.Mesh(sideGeo, stone); sideL.position.set(-1.9, 1.6, 0);
  const sideR = new THREE.Mesh(sideGeo, stone); sideR.position.set(1.9, 1.6, 0);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(4.8, 0.45, 4.8), dark);
  roof.position.y = 3.42;
  const door = new THREE.Mesh(new THREE.BoxGeometry(3.4, 3.0, 0.5), toonMat({ color: 0x8d8577 }));
  door.position.set(0, 1.8, 1.9);
  const emblem = new THREE.Mesh(new THREE.CircleGeometry(0.5, 18),
    new THREE.MeshBasicMaterial({ color: 0x54e8ff, transparent: true, opacity: 0.35 }));
  emblem.position.set(0, 0.2, 0.26);
  door.add(emblem);
  for (const m of [floorM, back, sideL, sideR, roof, door]) m.castShadow = m.receiveShadow = true;
  g.add(floorM, back, sideL, sideR, roof, door);
  G.scene.add(g);

  const top = y0 + 3.3;
  G.colliders.push(
    { x: cx - fx * 1.9 - rx * 1.1, z: cz - fz * 1.9 - rz * 1.1, r: 1.15, top },
    { x: cx - fx * 1.9 + rx * 1.1, z: cz - fz * 1.9 + rz * 1.1, r: 1.15, top },
    { x: cx - rx * 1.9 - fx * 0.95, z: cz - rz * 1.9 - fz * 0.95, r: 0.95, top },
    { x: cx - rx * 1.9 + fx * 0.95, z: cz - rz * 1.9 + fz * 0.95, r: 0.95, top },
    { x: cx + rx * 1.9 - fx * 0.95, z: cz + rz * 1.9 - fz * 0.95, r: 0.95, top },
    { x: cx + rx * 1.9 + fx * 0.95, z: cz + rz * 1.9 + fz * 0.95, r: 0.95, top },
    { x: cx, z: cz, r: 2.7, top: y0 + 3.65, soft: true },  // roof stand
    { x: cx, z: cz, r: 2.4, top: y0 + 0.35, soft: true },  // paved floor
  );
  const doorCol = { x: cx + fx * 1.9, z: cz + fz * 1.9, r: 1.7, top };
  G.colliders.push(doorCol);
  standSurfaces.push({ x: cx, z: cz, r: 2.4, top: y0 + 0.35 });

  // wide pressure plate ~8m in front of the sealed door
  const px = cx + fx * 8, pz = cz + fz * 8;
  const py = heightAt(px, pz);
  const plate = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.95, 0.3, 10), dark);
  plate.position.set(px, py + 0.15, pz);
  plate.castShadow = plate.receiveShadow = true;
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.25, 1.62, 22),
    new THREE.MeshBasicMaterial({ color: 0x54e8ff, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(px, py + 0.32, pz);
  G.scene.add(plate, ring);
  const plateTop = py + 0.3;
  standSurfaces.push({ x: px, z: pz, r: 1.7, top: plateTop });
  G.colliders.push({ x: px, z: pz, r: 1.7, top: plateTop, soft: true });

  const vault = {
    id, cx, cz, y0, fx, fz, door, doorCol, emblem,
    doorBaseY: door.position.y, doorTop: top,
    plate, plateBaseY: plate.position.y, plateTop, px, pz, ring,
    sink: 0, open: false, doorT: 0,
  };
  vaults.push(vault);
  if (worldClaimed('vaults', id)) applyOpenedVault(vault);

  makeChest(`${id}.chest`, cx - fx * 0.55, y0 + 0.35, cz - fz * 0.55, yaw, loot, () => {
    if (vault.open) return true;
    G.ui.toast('Sealed away — the stone door still stands.', 0x9ff4ff);
    return false;
  });
}

function updateVaults(dt) {
  const held = (G.player && G.player.held) || null;
  for (const v of vaults) {
    // weigh the plate: crates = 1, slabs (heavy) = 2, player standing = 1
    let load = 0;
    for (const c of G.grabbables) {
      if (c === held || c.userData.falling) continue;
      const dx = c.position.x - v.px, dz = c.position.z - v.pz;
      if (dx * dx + dz * dz > 4.41) continue; // (1.7 + 0.4)^2
      const bottom = c.position.y - (c.userData.size || CRATE_SIZE).h / 2;
      if (bottom > v.plateTop - 0.25 && bottom < v.plateTop + 2.6) load += c.userData.heavy ? 2 : 1;
    }
    const p = G.player;
    if (p) {
      const dx = p.pos.x - v.px, dz = p.pos.z - v.pz;
      if (dx * dx + dz * dz < 2.89 && p.pos.y > v.plateTop - 0.35 && p.pos.y < v.plateTop + 2.6) load += 1;
    }
    // plate visibly sinks under weight
    const target = Math.min(0.2, load * 0.065);
    v.sink += (target - v.sink) * Math.min(1, dt * 5);
    v.plate.position.y = v.plateBaseY - v.sink;
    v.ring.position.y = v.plateTop + 0.02 - v.sink;
    // faint cyan when armed, bright once triggered
    const pulse = 0.75 + Math.sin(G.time * 2.6 + v.cx) * 0.25;
    v.ring.material.opacity = v.open ? 0.9 : Math.min(0.7, (0.22 + load * 0.14) * pulse);
    if (!v.open && load >= 3) {
      v.open = true;
      claimWorld('vaults', v.id);
      signalQuestEvent('vault_opened', { id: v.id });
      v.emblem.material.opacity = 0.95;
      G.ui.toast('Stone grinds — the vault seal releases!', 0x9ff4ff);
      G.audio.sfx('lock');
      save();
    }
    if (v.open && v.doorT < 1.2) {
      const prev = v.doorT;
      v.doorT = Math.min(1.2, v.doorT + dt);
      const f = v.doorT / 1.2;
      const drop = f * 3.1;
      // grinding shudder as the slab descends into the ground
      v.door.position.y = v.doorBaseY - drop + Math.sin(v.doorT * 46) * 0.02 * (1 - f);
      v.doorCol.top = v.doorTop - drop;
      const dwx = v.cx + v.fx * 1.9, dwz = v.cz + v.fz * 1.9;
      if (((prev * 6) | 0) !== ((v.doorT * 6) | 0)) {
        G.audio.sfx('step');
        spawnSparkle(dwx, v.y0 + 0.4, dwz, 0xcfc6b2, 4, 1.4);
      }
      if (v.doorT >= 1.2) {
        v.doorCol.top = v.y0 + 0.3; // flush — the way is open
        G.audio.sfx('thud');
        G.camShake += 0.4;
        spawnSparkle(dwx, v.y0 + 0.6, dwz, 0xd8d0bc, 18, 2.6);
      }
    }
  }
}

// ------------------------------------------------- the wind bellows (ancient device)

let bellows = null;

function buildBellows(x, z) {
  const y0 = heightAt(x, z);
  const g = new THREE.Group();
  g.position.set(x, y0, z);
  const base = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.8, 0.9, 8), toonMat({ color: 0x8d8577 }));
  base.position.y = 0.45;
  const horn = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.3, 2.1, 9), toonMat({ color: 0xb5803c }));
  horn.position.y = 2.0;
  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.85, 0.1, 8, 18), toonMat({ color: 0xd9a83f }));
  collar.rotation.x = Math.PI / 2;
  collar.position.y = 3.02;
  const sack = new THREE.Mesh(new THREE.SphereGeometry(0.85, 9, 7), toonMat({ color: 0xd6c298 }));
  sack.position.set(1.55, 0.95, 0);
  sack.scale.set(1.15, 0.8, 1.15);
  const pipe = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.26, 0.26), toonMat({ color: 0xb5803c }));
  pipe.position.set(0.85, 0.75, 0);
  const glow = makeGlow(0x9fe6ff, 2.2);
  glow.position.y = 3.15;
  g.add(base, horn, collar, sack, pipe, glow);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  G.scene.add(g);
  G.colliders.push({ x, z, r: 1.7, top: y0 + 0.9 });

  bellows = { x, z, y0, sack, glow, state: 'idle', t: 0, readyAt: -1, zone: null };
  G.interactables.push({
    pos: new THREE.Vector3(x, y0 + 1.2, z), r: 3.4, label: 'Rouse the ancient bellows',
    onUse() {
      if (bellows.state !== 'idle') { G.ui.toast('The bellows are already breathing deep.', 0xbfe8ff); return; }
      if (G.time < bellows.readyAt) { G.ui.toast('The bellows wheeze — give them a moment to recover.', 0xbfe8ff); return; }
      bellows.state = 'charging';
      bellows.t = 0;
      G.audio.sfx('windup');
      G.ui.toast('The ancient bellows stir...', 0xbfe8ff);
    },
  });

  // floating cache island straight above — only the bellows' wind reaches it
  const capY = y0 + 34;
  const ig = new THREE.Group();
  ig.position.set(x, capY, z);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(4, 3.8, 1.0, 9), toonMat({ color: 0x6dbb4d }));
  cap.position.y = -0.5;
  const rock = new THREE.Mesh(new THREE.CylinderGeometry(3.7, 0.5, 5.5, 9), toonMat({ color: 0xa29886 }));
  rock.position.y = -3.6;
  cap.castShadow = rock.castShadow = true;
  cap.receiveShadow = true;
  ig.add(cap, rock);
  G.scene.add(ig);
  G.colliders.push({ x, z, r: 3.5, top: capY, soft: true });
  makeChest('chest.bellows-cache', x + 1.1, capY, z - 0.9, 2.1, { kind: 'gems', n: 3 });
  addPickup('gem', x - 1.6, capY + 0.6, z + 1.2, 'pickup.bellows.gem');
  addPickup('apple', x - 0.4, capY + 0.7, z + 2.2, 'pickup.bellows.apple');
}

function updateBellows(dt) {
  if (!bellows) return;
  const b = bellows;
  if (b.state === 'charging') {
    const prev = b.t;
    b.t += dt;
    const f = Math.min(1, b.t / 3); // 3s charge-up: the sack swells
    if (b.glb) b.sack.scale.setScalar(1 + f * 0.55);
    else b.sack.scale.set(1.15 + f * 0.85, 0.8 + f * 0.6, 1.15 + f * 0.85);
    if (((prev * 3) | 0) !== ((b.t * 3) | 0)) {
      spawnSparkle(b.x, b.y0 + 1.2, b.z, 0xcfc6b2, 5, 1.6);
      G.audio.sfx('step');
    }
    if (f >= 1) {
      b.state = 'blowing';
      const zx = b.ventX !== undefined ? b.ventX : b.x;
      const zz = b.ventZ !== undefined ? b.ventZ : b.z;
      b.zone = { x: zx, z: zz, r: 4.5, bottomY: b.y0, topY: b.y0 + 40, strength: 15, expires: G.time + 25 };
      G.updraftZones.push(b.zone);
      b.readyAt = G.time + 30; // 30s cooldown
      G.audio.sfx('glide');
      G.camShake += 0.25;
      G.ui.toast('A great wind roars from the horn — ride it!', 0xbfe8ff);
      spawnSparkle(b.x, b.y0 + 3, b.z, 0xd6e8b8, 26, 5);
    }
  } else if (b.state === 'blowing') {
    if (!b.zone || G.time > b.zone.expires) {
      b.zone = null;
      b.state = 'idle';
      if (b.glb) b.sack.scale.setScalar(1);
      else b.sack.scale.set(1.15, 0.8, 1.15);
    } else {
      // sack slowly empties as the gust spends itself
      const rem = Math.max(0, (b.zone.expires - G.time) / 25);
      const wob = 1 + Math.sin(G.time * 9) * 0.04;
      if (b.glb) b.sack.scale.setScalar((1 + rem * 0.55) * wob);
      else b.sack.scale.set((1.15 + rem * 0.85) * wob, 0.8 + rem * 0.6, (1.15 + rem * 0.85) * wob);
    }
  }
  b.glow.material.opacity = (b.state === 'blowing' ? 0.85 : 0.45) + Math.sin(G.time * 2.2) * 0.15;
}

// ------------------------------------------------- updraft base markers
// drifting dust/leaf quads swirling at the base of every updraft zone so
// they read as discoverable. (sky.js draws the tall wind streaks.)

let upfxMesh = null;
const UPFX_PER = 14, UPFX_ZONES = 10;

function initUpdraftFx() {
  if (upfxMesh) return;
  upfxMesh = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(0.34, 0.34),
    new THREE.MeshBasicMaterial({
      color: 0xd6e8b8, transparent: true, opacity: 0.7,
      side: THREE.DoubleSide, depthWrite: false,
    }),
    UPFX_PER * UPFX_ZONES);
  upfxMesh.frustumCulled = false;
  upfxMesh.count = 0;
  G.scene.add(upfxMesh);
}

function updateUpdraftFx() {
  if (!upfxMesh) return;
  const cam = G.camera;
  let k = 0;
  for (const zn of G.updraftZones) {
    if (k >= UPFX_PER * UPFX_ZONES) break;
    const dx = zn.x - cam.position.x, dz = zn.z - cam.position.z;
    if (dx * dx + dz * dz > 32400) continue; // only near the camera (180m)
    const sp = zn.expires !== undefined ? 2.1 : 1; // roused bellows swirl harder
    for (let i = 0; i < UPFX_PER; i++) {
      const a = i * 2.399 + G.time * sp * (0.9 + (i % 3) * 0.3);
      const rr = zn.r * (0.35 + ((i * 5) % 7) * 0.075);
      const rise = (G.time * sp * (1.5 + (i % 4) * 0.45) + i * 0.83) % 3.4;
      tmpM.compose(
        tmpV.set(zn.x + Math.cos(a) * rr, zn.bottomY + 0.35 + rise, zn.z + Math.sin(a) * rr),
        cam.quaternion,
        tmpS.setScalar(0.5 + 0.4 * Math.abs(Math.sin(G.time * 2.6 + i * 1.3))));
      upfxMesh.setMatrixAt(k++, tmpM);
    }
  }
  upfxMesh.count = k;
  upfxMesh.instanceMatrix.needsUpdate = true;
}

// ---------------------------------------------------------------- pickups

const pickups = [];
let pickupMeshes = { apple: null, heart: null, gem: null, pod: null };

export function initPickups() {
  const appleGeo = new THREE.SphereGeometry(0.28, 10, 8);
  pickupMeshes.apple = new THREE.InstancedMesh(appleGeo, toonMat({ color: 0xe83a30 }), 220);
  const heartGeo = new THREE.OctahedronGeometry(0.32);
  pickupMeshes.heart = new THREE.InstancedMesh(heartGeo, new THREE.MeshBasicMaterial({ color: 0xff8296 }), 60);
  const gemGeo = new THREE.OctahedronGeometry(0.3);
  pickupMeshes.gem = new THREE.InstancedMesh(gemGeo, new THREE.MeshBasicMaterial({ color: 0x8df0ff }), 60);
  const podGeo = new THREE.ConeGeometry(0.24, 0.44, 9); // teardrop stand-in until the GLB lands
  pickupMeshes.pod = new THREE.InstancedMesh(podGeo, toonMat({ color: 0x9fe8d8 }), 24);
  for (const m of Object.values(pickupMeshes)) {
    m.frustumCulled = false;
    m.count = 0;
    G.scene.add(m);
  }
  // zephyr pods grow where the wind pools: under the sky islands, in the
  // Thornwood shade, and one by the old bellows as the teaching pod
  const podSpots = [[72, 188], [92, 214], [64, 222],       // Thornwood
                    [-23, 275],                              // beside the wind bellows
                    [146, 40], [-250, -60], [228, -186]];   // beneath the sky islands
  podSpots.forEach(([x, z], i) =>
    addPickup('pod', x, heightAt(x, z) + 0.3, z, `pickup.pod.${i}`));
  G.throwPod = throwPod; // satchel card + G key both route here
  loadGenProps(); // Blender props swap in asynchronously
}

export function addPickup(kind, x, y, z, id = null) {
  pickups.push({
    id, kind, x, y, z,
    gone: worldClaimed('pickups', id),
    bob: hash2(pickups.length, 501) * 6,
  });
}

export function updatePickups(dt) {
  const p = G.player.pos;
  const counts = { apple: 0, heart: 0, gem: 0, pod: 0 };
  for (const pk of pickups) {
    if (pk.gone) continue;
    const mesh = pickupMeshes[pk.kind];
    const dy = pk.kind === 'apple' ? 0 : Math.sin(G.time * 2 + pk.bob) * 0.15 + 0.2;
    // collect on touch (hearts/gems) or via E (apples handled here too — walk close)
    const dist = Math.hypot(p.x - pk.x, (p.y + 1) - (pk.y + dy), p.z - pk.z);
    if (dist < 1.6) {
      if (pk.id && !claimWorld('pickups', pk.id)) { pk.gone = true; continue; }
      pk.gone = true;
      if (pk.kind === 'apple') { G.apples++; G.ui.toast('You got an apple! (H to eat)', 0xffb6a3); }
      if (pk.kind === 'heart') {
        G.hearts = Math.min(G.maxHearts, G.hearts + 2);
        spawnHealBloom(p.x, p.y, p.z);
        G.ui.toast('Recovered a little life.', 0xff8a9a);
      }
      if (pk.kind === 'gem') { G.gems++; markSeen('gem'); G.ui.toast('You got a sky gem!', 0x9fefff); }
      if (pk.kind === 'pod') {
        G.items.pod = (G.items.pod || 0) + 1;
        markSeen('pod');
        save();
      }
      G.audio.sfx('pickup');
      if (pk.id) save();
      continue;
    }
    if (counts[pk.kind] < mesh.instanceMatrix.count) { // instanceMatrix.count == mesh capacity
      tmpQ.setFromAxisAngle(UP, G.time * (pk.kind === 'apple' ? 0 : 1.5));
      tmpM.compose(tmpV.set(pk.x, pk.y + dy, pk.z), tmpQ, tmpS.set(1, 1, 1));
      mesh.setMatrixAt(counts[pk.kind]++, tmpM);
    }
  }
  for (const [k, m] of Object.entries(pickupMeshes)) {
    m.count = counts[k];
    m.instanceMatrix.needsUpdate = true;
  }
}

// Called after a validated save is applied. The world is intentionally built
// before the title choice, so this pass reconciles every already-created
// one-shot object without rebuilding the scene or replaying rewards.
export function syncWorldProgress() {
  for (const rec of glimmerSites) {
    if (worldClaimed('glimmers', rec.id)) applyCollectedGlimmer(rec);
  }
  for (const ch of chests) {
    if (worldClaimed('chests', ch.id)) applyOpenedChest(ch);
  }
  for (const pk of pickups) {
    if (pk.id && worldClaimed('pickups', pk.id)) pk.gone = true;
  }
  for (const v of vaults) {
    if (worldClaimed('vaults', v.id)) {
      applyOpenedVault(v);
      signalQuestEvent('vault_opened', { id: v.id });
    }
  }
  refreshGlimmerCount();
}

// ---- zephyr pods: bottled updrafts you can throw ----------------------------
// G.throwPod (bound in initPickups) lobs one along the camera ray; where it
// lands, a petal-burst updraft column stands for twelve seconds.
const flyingPods = []; // pooled {mesh, active, t, vx, vy, vz}

function throwPod() {
  if (!G.started || G.cinematic || G.gameOver || G.paused) return;
  if ((G.items.pod || 0) <= 0) { G.ui.toast('No zephyr pods in the satchel...', 0xcccccc); return; }
  let slot = flyingPods.find(f => !f.active);
  if (!slot) {
    if (flyingPods.length >= 3) return; // only so many winds fit in the air at once
    const mesh = propInstance('zephyr_pod') || new THREE.Mesh(
      new THREE.ConeGeometry(0.24, 0.44, 9), toonMat({ color: 0x9fe8d8 }));
    slot = { mesh, active: false, t: 0, vx: 0, vy: 0, vz: 0 };
    G.scene.add(mesh);
    flyingPods.push(slot);
  }
  G.items.pod--;
  save();
  const p = G.player;
  // converge on the camera ray like the bow shot does, but a gentler lob
  G.camera.getWorldDirection(tmpV);
  slot.mesh.position.set(p.pos.x + tmpV.x * 0.7, p.pos.y + 1.5 + tmpV.y * 0.7, p.pos.z + tmpV.z * 0.7);
  const tx = G.camera.position.x + tmpV.x * 30,
        ty = G.camera.position.y + tmpV.y * 30,
        tz = G.camera.position.z + tmpV.z * 30;
  const dx = tx - slot.mesh.position.x, dy = ty - slot.mesh.position.y, dz = tz - slot.mesh.position.z;
  const dl = Math.hypot(dx, dy, dz) || 1;
  slot.vx = (dx / dl) * 20; slot.vy = (dy / dl) * 20 + 3.5; slot.vz = (dz / dl) * 20;
  slot.t = 0;
  slot.active = true;
  slot.mesh.visible = true;
  G.player.throwT = 0; // borrow the crate-throw pose
  G.audio.sfx('throw');
}

function updatePods(dt) {
  for (const f of flyingPods) {
    if (!f.active) continue;
    f.t += dt;
    f.vy -= 16 * dt; // lighter than a rock — it is a seed pod, after all
    const m = f.mesh;
    m.position.x += f.vx * dt;
    m.position.y += f.vy * dt;
    m.position.z += f.vz * dt;
    m.rotation.x += dt * 6;
    m.rotation.z += dt * 4.5;
    const gy = Math.max(heightAt(m.position.x, m.position.z), WATER_Y - 0.05);
    if (m.position.y <= gy + 0.2 || f.t > 6) {
      f.active = false;
      m.visible = false;
      const x = m.position.x, z = m.position.z;
      G.updraftZones.push({ x, z, r: 3.5, bottomY: gy - 0.5, topY: gy + 26, strength: 15, expires: G.time + 12 });
      spawnSparkle(x, gy + 0.8, z, 0x9fe8d8, 30, 4.5); // petal burst
      spawnSparkle(x, gy + 1.4, z, 0xfff2d8, 14, 3);
      G.audio.sfx('updraft');
      G.camShake += 0.08;
    }
  }
}

// ---------------------------------------------------------------- particles

const sparkles = [];
let sparkleMesh;

export function initSparkles() {
  sparkleMesh = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(0.22, 0.22),
    new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, depthWrite: false }),
    400
  );
  sparkleMesh.frustumCulled = false;
  sparkleMesh.count = 0;
  G.scene.add(sparkleMesh);
  initGusts();
}

// ---- healing bloom: soft expanding ring + spiraling green-gold motes -------
let healRing = null, healT = -1;
const healPos = new THREE.Vector3();

export function spawnHealBloom(x, y, z) {
  if (!healRing) {
    healRing = new THREE.Mesh(new THREE.RingGeometry(0.8, 1.0, 26),
      new THREE.MeshBasicMaterial({
        color: 0x9fffb0, transparent: true, opacity: 0,
        side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
    healRing.rotation.x = -Math.PI / 2;
    healRing.visible = false;
    G.scene.add(healRing);
  }
  healT = 0;
  healPos.set(x, y, z);
  healRing.visible = true;
  // spiral of rising motes rides the sparkle pool
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    sparkles.push({
      x: x + Math.cos(a) * 0.7, y: y + 0.1 + (i % 3) * 0.15, z: z + Math.sin(a) * 0.7,
      vx: Math.cos(a + 1.4) * 1.2, vy: 2.4 + (i % 4) * 0.5, vz: Math.sin(a + 1.4) * 1.2,
      life: 0.9 + (i % 5) * 0.12,
      color: i % 3 ? 0x9fffb0 : 0xffe9a0,
    });
  }
}

function updateHealBloom(dt) {
  if (healT < 0) return;
  healT += dt;
  const k = healT / 0.7;
  if (k >= 1) { healT = -1; healRing.visible = false; return; }
  healRing.position.set(healPos.x, healPos.y + 0.15 + k * 1.2, healPos.z);
  healRing.scale.setScalar(0.6 + k * 2.4);
  healRing.material.opacity = 0.75 * (1 - k);
}

// ---- wind gusts: TotK-style curling wind lines sweeping the meadow ---------
// One shared travel direction, matched to the grass shader's baked wave
// (vec2(0.045, 0.028) normalized) so physics and visuals always agree.
const GUST_N = 7;
const GUST_DX = 0.849, GUST_DZ = 0.528;
const gusts = [];
let gustSpawnT = 2;

// Living gusts: the streaks are rideable. Returns the strongest gust whose
// capsule (streak segment, r 3, height band ±4.5) contains the point, as
// {dx, dz, speed, s} with s the 0..1 envelope, or null. Callers each frame:
// player glide surge, butterfly/leaf drift.
export function gustAt(px, py, pz) {
  let best = null, bestS = 0;
  for (const g of gusts) {
    if (g.t < 0) continue;
    const env = Math.sin((g.t / g.T) * Math.PI);
    if (env <= 0.12) continue;
    if (Math.abs(py - g.y) > 4.5) continue;
    const half = g.sky ? 3.6 : 2.2;
    const rx = px - g.x, rz = pz - g.z;
    const along = clamp(rx * GUST_DX + rz * GUST_DZ, -half, half);
    const ox = rx - GUST_DX * along, oz = rz - GUST_DZ * along;
    const d2 = ox * ox + oz * oz;
    if (d2 >= 9) continue;
    const s = env * (1 - Math.sqrt(d2) / 3);
    if (s > bestS) { bestS = s; best = g; }
  }
  return best ? { dx: GUST_DX, dz: GUST_DZ, speed: best.speed, s: bestS } : null;
}

function initGusts() {
  const geo = new THREE.PlaneGeometry(3.2, 0.055, 8, 1);
  { // bow the streak into a gentle arc
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      p.setY(i, p.getY(i) + Math.sin((p.getX(i) / 3.2 + 0.5) * Math.PI) * 0.22);
    }
  }
  for (let i = 0; i < GUST_N; i++) {
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: 0xeef8ff, transparent: true, opacity: 0,
      side: THREE.DoubleSide, depthWrite: false,
    }));
    mesh.visible = false;
    G.scene.add(mesh);
    gusts.push({ mesh, t: -1, T: 2, x: 0, y: 0, z: 0, speed: 10, ph: i * 2.1, sky: false, baseY: 0 });
  }
}

function updateGusts(dt) {
  if (!gusts.length) return;
  const p = G.player ? G.player.pos : null;
  if (!p) return;
  const w = G.weather;
  const windMul = (w && w.windMul) || 1;
  const gliding = G.player.mode === 'glide';
  gustSpawnT -= dt * windMul * (gliding ? 1.7 : 1); // the sky livens up for a glider
  if (gustSpawnT <= 0) {
    gustSpawnT = 2.2 + Math.random() * 3.5;
    for (const g of gusts) {
      if (g.t >= 0) continue;
      g.t = 0;
      g.T = 1.7 + Math.random() * 0.9;
      // while gliding, most gusts spawn at canopy height upwind so they sweep
      // past the rider — a gust line you can wait on and catch
      g.sky = gliding && Math.random() < 0.65;
      if (g.sky) {
        const lat = (Math.random() * 2 - 1) * 9;
        const back = 6 + Math.random() * 18;
        g.x = p.x - GUST_DX * back - GUST_DZ * lat;
        g.z = p.z - GUST_DZ * back + GUST_DX * lat;
        g.baseY = p.y + (Math.random() * 6 - 2);
      } else {
        const a = Math.random() * Math.PI * 2, d = 8 + Math.random() * 30;
        g.x = p.x + Math.cos(a) * d;
        g.z = p.z + Math.sin(a) * d;
      }
      g.y = g.sky ? g.baseY : heightAt(g.x, g.z);
      if (g.y < WATER_Y) g.y = WATER_Y;
      g.speed = (8 + Math.random() * 5) * windMul * (g.sky ? 1.5 : 1);
      g.mesh.scale.set(g.sky ? 2.3 : 1, 1, 1);
      g.mesh.visible = true;
      break;
    }
  }
  const dx = GUST_DX, dz = GUST_DZ;
  for (const g of gusts) {
    if (g.t < 0) continue;
    g.t += dt;
    const k = g.t / g.T;
    if (k >= 1) { g.t = -1; g.mesh.visible = false; continue; }
    g.x += dx * g.speed * dt;
    g.z += dz * g.speed * dt;
    const ground = heightAt(g.x, g.z);
    const baseY = g.sky ? Math.max(g.baseY, Math.max(ground, WATER_Y) + 0.9)
      : Math.max(ground, WATER_Y) + 0.9;
    g.y += ((baseY + Math.sin(g.t * 5 + g.ph) * 0.35) - g.y) * Math.min(1, dt * 4);
    g.mesh.position.set(g.x, g.y, g.z);
    g.mesh.rotation.y = Math.atan2(dx, dz) + Math.PI / 2;
    g.mesh.rotation.x = Math.sin(g.t * 7 + g.ph) * 0.2;
    g.mesh.material.opacity = Math.sin(k * Math.PI) * (g.sky ? 0.66 : 0.5);
  }
}

export function spawnSparkle(x, y, z, color = 0xffffff, n = 26, speed = 4) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, b = Math.random() * Math.PI;
    sparkles.push({
      x, y, z,
      vx: Math.sin(b) * Math.cos(a) * speed * (0.4 + Math.random()),
      vy: Math.cos(b) * speed * (0.5 + Math.random() * 0.8),
      vz: Math.sin(b) * Math.sin(a) * speed * (0.4 + Math.random()),
      life: 0.7 + Math.random() * 0.6,
      color,
    });
  }
}

export function updateSparkles(dt) {
  updateHealBloom(dt);
  updateGusts(dt);
  let k = 0;
  const col = new THREE.Color();
  for (let i = sparkles.length - 1; i >= 0; i--) {
    const s = sparkles[i];
    s.life -= dt;
    if (s.life <= 0) { sparkles.splice(i, 1); continue; }
    s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
    s.vy -= 4 * dt;
    if (k < 400) {
      tmpM.compose(tmpV.set(s.x, s.y, s.z),
        G.camera.quaternion, tmpS.setScalar(Math.min(1, s.life * 2)));
      sparkleMesh.setMatrixAt(k, tmpM);
      col.set(s.color);
      sparkleMesh.setColorAt(k, col);
      k++;
    }
  }
  sparkleMesh.count = k;
  sparkleMesh.instanceMatrix.needsUpdate = true;
  if (sparkleMesh.instanceColor) sparkleMesh.instanceColor.needsUpdate = true;
}
