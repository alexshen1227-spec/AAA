// Hearths — three friendly rest-fires (the welcome half of "Emberside").
//
// Boglin camps own every other flame in the valley; these three are safe:
// Tilla's meadow, Ilyra's shore, and the lull shrine on the storm road.
// Sit, and the world fades gently to the next dawn or dusk — TotK-style
// time-passing with no menu, and a little warmth back in your hearts.
import * as THREE from 'three';
import { G, save } from './state.js';
import { heightAt, toonMat } from './terrain.js';
import { spawnSparkle } from './world.js';

const HEARTHS = [
  { x: 27, z: -106, name: 'Tilla\'s hearth' },
  { x: -143, z: 111, name: 'Ilyra\'s shore-fire' },
  { x: 3, z: 317, name: 'the shrine hearth' },
];

const hearths = []; // {group, flame, light, ph}
let built = false;
let fadeEl = null;
let resting = null; // {t, target, crossesMidnight, label}

function fadeOverlay() {
  if (fadeEl) return fadeEl;
  fadeEl = document.createElement('div');
  fadeEl.style.cssText = 'position:fixed;inset:0;background:#000;opacity:0;' +
    'pointer-events:none;z-index:49;transition:opacity 1.1s ease;';
  document.body.appendChild(fadeEl);
  return fadeEl;
}

function buildHearth(spec, index) {
  const y = heightAt(spec.x, spec.z);
  const group = new THREE.Group();
  group.position.set(spec.x, y, spec.z);
  const stoneMat = toonMat({ color: 0x8d8577 });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + index;
    const stone = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.16 + (i % 3) * 0.04, 0), stoneMat);
    stone.position.set(Math.cos(a) * 0.55, 0.1, Math.sin(a) * 0.55);
    stone.scale.y = 0.7;
    stone.castShadow = true;
    group.add(stone);
  }
  for (let i = 0; i < 3; i++) {
    const log = new THREE.Mesh(
      new THREE.CylinderGeometry(0.055, 0.07, 0.7, 5), toonMat({ color: 0x5a4028 }));
    log.rotation.set(0.25, i * 2.1, Math.PI / 2 - 0.4);
    log.position.y = 0.14;
    group.add(log);
  }
  const flame = new THREE.Mesh(
    new THREE.ConeGeometry(0.22, 0.66, 7),
    new THREE.MeshBasicMaterial({
      color: 0xffb45c, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
  flame.position.y = 0.5;
  group.add(flame);
  const light = new THREE.PointLight(0xff9a4d, 0.9, 12, 1.8);
  light.position.y = 0.9;
  group.add(light);
  G.scene.add(group);
  G.colliders.push({ x: spec.x, z: spec.z, r: 0.65, top: y + 0.35, soft: true });
  G.interactables.push({
    id: `hearth_${index}`, pos: new THREE.Vector3(spec.x, y + 0.7, spec.z), r: 2.8,
    label: 'Rest by the fire',
    onUse() { beginRest(spec); },
  });
  hearths.push({ group, flame, light, ph: index * 2.4 });
}

function beginRest(spec) {
  if (resting) return;
  const t = G.dayTime;
  const night = t < 0.21 || t > 0.79;
  resting = {
    t: 0,
    target: night ? 0.25 : 0.8,
    crossesMidnight: night && t > 0.5,
    label: night ? 'dawn' : 'dusk',
  };
  fadeOverlay().style.opacity = '1';
  if (G.audio) G.audio.chord([196, 261.6], 0.06, 0.6);
  spawnSparkle(spec.x, heightAt(spec.x, spec.z) + 0.8, spec.z, 0xffb45c, 12, 1.8);
}

function updateRest(dt) {
  if (!resting) return;
  resting.t += dt;
  if (resting.t < 1.3) return; // hold the dark a breath
  if (resting.target !== null) {
    if (resting.crossesMidnight) G.dayCount = (G.dayCount || 0) + 1;
    G.dayTime = resting.target;
    G.hearts = Math.min(G.maxHearts, G.hearts + 4);
    if (G.ui) G.ui.toast(
      `You rest until ${resting.label}. The fire kept its side of the bargain. +1 heart`,
      0xffb45c, 5200);
    save();
    resting.target = null; // fade back up
    fadeOverlay().style.opacity = '0';
  }
  if (resting.t > 2.6) resting = null;
}

export function updateHearths(dt = 0) {
  if (!G.started || !G.scene) return;
  const step = Math.min(Number.isFinite(dt) && dt > 0 ? dt : 0, 0.05);
  if (!built) {
    built = true;
    HEARTHS.forEach(buildHearth);
  }
  const night = G.dayTime < 0.25 || G.dayTime > 0.75;
  for (const h of hearths) {
    const flick = 0.9 + Math.sin(G.time * 9 + h.ph) * 0.12 + Math.sin(G.time * 23 + h.ph) * 0.05;
    h.flame.scale.set(flick, flick * (1 + Math.sin(G.time * 13 + h.ph) * 0.1), flick);
    h.flame.material.opacity = 0.65 + Math.sin(G.time * 11 + h.ph) * 0.12;
    h.light.intensity = (night ? 1.15 : 0.55) * flick;
  }
  updateRest(step);
}

export function getHearthSummary() {
  return { built, count: hearths.length, resting: !!resting };
}
