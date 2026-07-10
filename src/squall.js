// Stray Squalls — the storm's last grief, looking for stillness.
//
// After the Coiled Storm is stilled, small orphaned squalls occasionally
// wander the valley: visible roaming weather cells you can hunt. Ride the
// squall's own eye-wall updraft to the floating mote at its heart and touch
// the lone wind-rune, and the squall exhales into clear sky and gems.
//
// Transient by design, like the fallen stars: nothing persists, one squall
// at a time, and a squall not chased simply wanders on.
import * as THREE from 'three';
import { G, save } from './state.js';
import { heightAt, WATER_Y, toonMat } from './terrain.js';
import { spawnSparkle, registerStandSurface, markSeen } from './world.js';

const CELL_R = 26;    // outer influence: push + gloom
const EYE_R = 6;      // still air at the heart
const MOTE_ALT = 34;  // the rune mote floats here above the eye
const DRIFT_SPEED = 1.7;

const flag = id => !!(G.story && G.story.flags && G.story.flags[id]);

let squall = null;    // { group, layers, shaft, light, flickerAt, pos, dir,
                      //   zone, mote, rune, runeGlow, it, collider, surface }
let nextAt = -1;

function pickSpawnPoint() {
  const p = G.player.pos;
  for (let attempt = 0; attempt < 50; attempt++) {
    const a = Math.random() * Math.PI * 2;
    const r = 120 + Math.random() * 160;
    const x = p.x + Math.cos(a) * r;
    const z = p.z + Math.sin(a) * r;
    if (Math.hypot(x, z) > 360) continue;
    if (Math.hypot(x - 50, z - 265) < 70) continue;  // not over the Coil
    if (Math.hypot(x, z - 360) < 70) continue;       // nor the serene isle
    if (heightAt(x, z) < WATER_Y + 1) continue;
    return { x, z };
  }
  return null;
}

function cloudMat(opacity) {
  return new THREE.MeshBasicMaterial({
    color: 0x2a3340, transparent: true, opacity,
    depthWrite: false, side: THREE.DoubleSide,
  });
}

function spawnSquall() {
  const at = pickSpawnPoint();
  if (!at) return;
  const group = new THREE.Group();
  const layers = [];
  for (const s of [{ r: 24, y: 42, h: 16, op: 0.26, spin: 0.09 },
                   { r: 17, y: 56, h: 13, op: 0.22, spin: -0.07 }]) {
    const mesh = new THREE.Mesh(new THREE.ConeGeometry(s.r, s.h, 14, 1, true), cloudMat(s.op));
    mesh.position.y = s.y;
    mesh.rotation.x = Math.PI;
    mesh.userData.spin = s.spin;
    group.add(mesh);
    layers.push(mesh);
  }
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(7, 12, 62, 12, 1, true), cloudMat(0.13));
  shaft.position.y = 32;
  group.add(shaft);
  const light = new THREE.PointLight(0xbfd8ff, 0, 90, 1.5);
  light.position.y = 40;
  group.add(light);

  // the rune mote: a hanging stone the squall carries at its heart
  const mote = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 1.7, 1.1, 8), toonMat({ color: 0x9b9384 }));
  disc.castShadow = true;
  const runeStone = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.5, 0.3), toonMat({ color: 0x8d8577 }));
  runeStone.position.y = 1.3;
  const runeCoreMat = new THREE.MeshBasicMaterial({ color: 0x2f4a41 });
  const runeCore = new THREE.Mesh(new THREE.OctahedronGeometry(0.13), runeCoreMat);
  runeCore.position.y = 1.55;
  mote.add(disc, runeStone, runeCore);
  mote.position.y = MOTE_ALT;
  group.add(mote);
  G.scene.add(group);

  const pos = new THREE.Vector3(at.x, 0, at.z);
  const a = Math.random() * Math.PI * 2;
  const groundY = heightAt(at.x, at.z);
  group.position.set(at.x, groundY, at.z);

  // the eye wall carries you up; the collider/surface follow the drift
  const zone = {
    x: at.x + EYE_R + 3, z: at.z, r: 4,
    bottomY: groundY - 0.5, topY: groundY + MOTE_ALT + 8, strength: 15,
  };
  G.updraftZones.push(zone);
  const collider = { x: at.x, z: at.z, r: 2.4, top: groundY + MOTE_ALT + 0.55, soft: true };
  G.colliders.push(collider);
  const surface = { x: at.x, z: at.z, r: 2.4, top: groundY + MOTE_ALT + 0.55 };
  registerStandSurface(surface);

  const it = {
    id: 'stray_squall_rune',
    pos: new THREE.Vector3(at.x, groundY + MOTE_ALT + 1.4, at.z), r: 3,
    label: 'Still the stray squall',
    onUse() { stillSquall(); },
  };
  G.interactables.push(it);

  squall = {
    group, layers, shaft, light, flickerAt: 0, pos, groundY,
    dir: new THREE.Vector2(Math.cos(a), Math.sin(a)),
    zone, mote, runeCoreMat, it, collider, surface,
  };

  if (G.ui && G.player) {
    const dx = at.x - G.player.pos.x, dz = at.z - G.player.pos.z;
    const dirs = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
    const idx = ((Math.round(Math.atan2(dx, -dz) / (Math.PI / 4)) % 8) + 8) % 8;
    G.ui.toast(`A stray squall wanders in from the ${dirs[idx]} — the storm's last grief, looking for stillness.`, 0xbfd8ff, 6800);
  }
}

function stillSquall() {
  if (!squall || squall.it.gone) return;
  squall.it.gone = true;
  const { x, z } = squall.collider;
  const y = squall.collider.top;
  G.gems = (Number(G.gems) || 0) + 5;
  G.items.shard = (Number(G.items.shard) || 0) + 1;
  markSeen('gem');
  markSeen('shard');
  save();
  spawnSparkle(x, y + 1, z, 0xbfe8ff, 50, 6);
  spawnSparkle(x, y - 10, z, 0xfff2d8, 30, 8);
  if (G.audio) {
    G.audio.sfx('updraft');
    G.audio.chord([392, 523.25, 659.25, 783.99], 0.12, 0.3);
  }
  if (G.ui) G.ui.toast('The squall exhales — five gems and a Star Shard settle out of the clearing air.', 0xbfe8ff, 5600);
  removeSquall();
}

function removeSquall() {
  if (!squall) return;
  G.scene.remove(squall.group);
  const zi = G.updraftZones.indexOf(squall.zone);
  if (zi >= 0) G.updraftZones.splice(zi, 1);
  const ci = G.colliders.indexOf(squall.collider);
  if (ci >= 0) G.colliders.splice(ci, 1);
  squall.it.gone = true;
  squall.surface.r = 0; // dead stand-surface: standSurfaces has no unregister
  squall = null;
  nextAt = G.time + 240 + Math.random() * 300; // the next grief takes its time
}

export function updateSquall(dt = 0) {
  if (!G.started || !G.player || !flag('finaleCompleted')) return;
  const step = Math.min(Number.isFinite(dt) && dt > 0 ? dt : 0, 0.05);

  if (!squall) {
    if (nextAt < 0) nextAt = G.time + 90 + Math.random() * 120;
    if (G.time >= nextAt && !G.bloodNight) spawnSquall();
    return;
  }

  // drift, bouncing gently off the world edge and the water
  const s = squall;
  const nx = s.group.position.x + s.dir.x * DRIFT_SPEED * step;
  const nz = s.group.position.z + s.dir.y * DRIFT_SPEED * step;
  if (Math.hypot(nx, nz) > 380 || heightAt(nx, nz) < WATER_Y + 0.5) {
    s.dir.rotateAround({ x: 0, y: 0 }, 1.2 + Math.random());
  } else {
    const groundY = heightAt(nx, nz);
    s.group.position.set(nx, groundY, nz);
    s.groundY = groundY;
    // everything it carries drifts with it
    s.zone.x = nx + EYE_R + 3; s.zone.z = nz;
    s.zone.bottomY = groundY - 0.5; s.zone.topY = groundY + MOTE_ALT + 8;
    s.collider.x = nx; s.collider.z = nz;
    s.collider.top = groundY + MOTE_ALT + 0.55;
    s.surface.x = nx; s.surface.z = nz;
    s.surface.top = s.collider.top;
    s.it.pos.set(nx, groundY + MOTE_ALT + 1.4, nz);
  }

  for (const layer of s.layers) layer.rotation.y += layer.userData.spin * step * 6;
  s.mote.rotation.y += step * 0.3;
  if (G.time > s.flickerAt) {
    s.flickerAt = G.time + 3 + Math.random() * 6;
    s.light.intensity = 1.8;
  }
  s.light.intensity = Math.max(0, s.light.intensity - step * 5);

  // a mild outward lean inside the cell; dead calm in the eye — and like the
  // great storm before it, the squall's breath cushions every fall inside it
  const p = G.player.pos;
  const dx = p.x - s.group.position.x, dz = p.z - s.group.position.z;
  const dist = Math.hypot(dx, dz);
  if (dist < CELL_R) {
    if (G.player.vel.y < -8) G.player.vel.y = -8;
    if (dist > EYE_R && p.y < s.groundY + MOTE_ALT) {
      const k = 1 - (dist - EYE_R) / (CELL_R - EYE_R);
      G.player.vel.x += (dx / dist) * 3.2 * k * step;
      G.player.vel.z += (dz / dist) * 3.2 * k * step;
    }
  }
}

export function getSquallSummary() {
  return squall ? {
    x: +squall.group.position.x.toFixed(1),
    z: +squall.group.position.z.toFixed(1),
    moteTop: +squall.collider.top.toFixed(1),
    stilled: squall.it.gone,
  } : { nextAt: +nextAt.toFixed(1) };
}
