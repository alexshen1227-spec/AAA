// Chase the Fallen Star — a spontaneous night adventure.
//
// Most shooting stars burn out. Now and then (sky.js raises
// G.pendingStarfall) one arcs all the way down and lands somewhere real:
// a thin gold pillar stands over the crater until dawn, visible across the
// valley. Reach it before the light fades and pry loose what fell.
//
// Deliberately transient: nothing here persists. A star not chased is a
// star missed — the night sky owes nobody twice.
import * as THREE from 'three';
import { G, save } from './state.js';
import { heightAt, slopeAt, WATER_Y, toonMat } from './terrain.js';
import { spawnSparkle, markSeen } from './world.js';

const CHASE_MIN_R = 70;   // never lands on top of the player...
const CHASE_MAX_R = 190;  // ...nor beyond a night's run
const DAWN = 0.235;       // the pillar dies with the stars

let fall = null;   // the descending streak {mesh, from, to, t, T}
let site = null;   // the landed crater {group, rock, pillar, glow, it, bornDay}
let cooldownUntil = -1;

function isNightNow() {
  return G.dayTime < 0.21 || G.dayTime > 0.79;
}

function pickLandingPoint() {
  const p = G.player.pos;
  for (let attempt = 0; attempt < 60; attempt++) {
    const a = Math.random() * Math.PI * 2;
    const r = CHASE_MIN_R + Math.random() * (CHASE_MAX_R - CHASE_MIN_R);
    const x = p.x + Math.cos(a) * r;
    const z = p.z + Math.sin(a) * r;
    if (Math.hypot(x, z) > 430) continue;
    const y = heightAt(x, z);
    if (y < WATER_Y + 1.2 || y > 60) continue;
    if (slopeAt(x, z) > 0.4) continue;
    return { x, y, z };
  }
  return null;
}

function beginFall(target) {
  const from = new THREE.Vector3(
    target.x + 120, target.y + 220, target.z - 90);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(14, 0.5),
    new THREE.MeshBasicMaterial({
      color: 0xffe9b0, transparent: true, opacity: 0.95, fog: false,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
  mesh.position.copy(from);
  G.scene.add(mesh);
  fall = { mesh, from, to: new THREE.Vector3(target.x, target.y, target.z), t: 0, T: 2.6 };
}

function landStar(pos) {
  const group = new THREE.Group();
  group.position.set(pos.x, pos.y, pos.z);

  // scorched earth, still smoking faintly
  const scorch = new THREE.Mesh(
    new THREE.CircleGeometry(2.6, 14),
    new THREE.MeshBasicMaterial({ color: 0x241d16, transparent: true, opacity: 0.75 }));
  scorch.rotation.x = -Math.PI / 2;
  scorch.position.y = 0.04;
  group.add(scorch);

  // the star itself: a half-buried shard of skyiron, humming amber
  const rock = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.62, 0), toonMat({ color: 0x5b5464 }));
  rock.position.y = 0.34;
  rock.rotation.set(0.4, 1.2, 0.2);
  rock.castShadow = true;
  const veins = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.34, 0),
    new THREE.MeshBasicMaterial({ color: 0xffd88a }));
  veins.position.y = 0.42;
  group.add(rock, veins);

  // the thin gold pillar that calls across the map
  const pillar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.55, 1.1, 120, 7, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xffd88a, transparent: true, opacity: 0.30, fog: false,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }));
  pillar.position.y = 60;
  group.add(pillar);

  const glow = new THREE.PointLight(0xffd88a, 1.6, 22, 1.8);
  glow.position.y = 1.4;
  group.add(glow);
  G.scene.add(group);

  const it = {
    id: 'fallen_star', pos: new THREE.Vector3(pos.x, pos.y + 0.8, pos.z), r: 3,
    label: 'Pry loose the fallen star',
    onUse() {
      if (this.gone) return;
      this.gone = true;
      G.items.shard = (Number(G.items.shard) || 0) + 2;
      G.gems = (Number(G.gems) || 0) + 3;
      markSeen('shard');
      markSeen('gem');
      spawnSparkle(pos.x, pos.y + 1.2, pos.z, 0xffd88a, 46, 5);
      if (G.audio) {
        G.audio.sfx('glimmer');
        G.audio.chord([392, 523.25, 659.25, 880], 0.1, 0.2);
      }
      if (G.ui) G.ui.toast('Skyiron, still warm — two Star Shards and three gems come loose.', 0xffd88a, 5200);
      removeSite();
      save();
    },
  };
  G.interactables.push(it);
  site = { group, rock, veins, pillar, glow, it, expiresWithDawn: true };

  spawnSparkle(pos.x, pos.y + 2, pos.z, 0xffd88a, 40, 6);
  if (G.audio) G.audio.sfx('updraft');
  if (G.ui && G.player) {
    const dx = pos.x - G.player.pos.x, dz = pos.z - G.player.pos.z;
    const dirs = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
    const idx = ((Math.round(Math.atan2(dx, -dz) / (Math.PI / 4)) % 8) + 8) % 8;
    G.ui.toast(
      `A star has fallen to the ${dirs[idx]} — its light won't outlive the dawn.`,
      0xffd88a, 6400);
  }
}

function removeSite() {
  if (!site) return;
  site.it.gone = true;
  G.scene.remove(site.group);
  site = null;
  cooldownUntil = G.time + 60; // one gift a night is plenty
}

export function updateFallenStar(dt = 0) {
  if (!G.started || !G.player) return;
  const step = Math.min(Number.isFinite(dt) && dt > 0 ? dt : 0, 0.05);

  // sky.js offers a star; take it only when a chase is actually possible
  if (G.pendingStarfall) {
    G.pendingStarfall = false;
    if (!fall && !site && isNightNow() && G.time > cooldownUntil && !G.bloodNight) {
      const target = pickLandingPoint();
      if (target) beginFall(target);
    }
  }

  if (fall) {
    fall.t += step;
    const k = Math.min(1, fall.t / fall.T);
    const e = k * k;
    fall.mesh.position.lerpVectors(fall.from, fall.to, e);
    fall.mesh.lookAt(fall.to);
    fall.mesh.material.opacity = 0.95 * (0.35 + 0.65 * (1 - k));
    if (k >= 1) {
      const pos = { x: fall.to.x, y: fall.to.y, z: fall.to.z };
      G.scene.remove(fall.mesh);
      fall = null;
      landStar(pos);
      if (G.camShake !== undefined) G.camShake += 0.15;
    }
  }

  if (site) {
    const pulse = 0.5 + Math.sin(G.time * 2.3) * 0.2;
    site.veins.rotation.y += step * 0.8;
    site.glow.intensity = 1.2 + pulse;
    // daylight takes the pillar, then the prize
    const day = G.dayTime > DAWN && G.dayTime < 0.75;
    if (day) {
      site.pillar.material.opacity -= step * 0.12;
      if (site.pillar.material.opacity <= 0.02) {
        if (G.ui) G.ui.toast('Somewhere behind you, a fallen star goes out with the night.', 0xcfc4a6, 4600);
        removeSite();
      }
    } else {
      site.pillar.material.opacity = 0.24 + pulse * 0.14;
    }
  }
}

export function getFallenStarSummary() {
  return {
    falling: !!fall,
    site: site ? {
      x: +site.group.position.x.toFixed(1),
      z: +site.group.position.z.toFixed(1),
      pillarOpacity: +site.pillar.material.opacity.toFixed(2),
    } : null,
  };
}
