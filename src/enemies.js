// Boglins: original club-wielding swamp goblins that camp around the wilds.
//
// State machine (kept data-driven and procedural so the rigged-skeleton wave
// can swap the animate() body for an AnimationMixer without touching logic):
//
//   idle/wander -> suspicious ("?" heard sprint behind) -> alert ("!") ->
//   chase -> orbit (circle-strafe inside 6m) -> windup (0.55s telegraph) ->
//   strike (lunge + arc damage) -> recover (vulnerable) -> backstep -> orbit
//   de-aggro (player >45m or unreachable 6s) -> return (walk home, heal full)
//
// Special states: down (knocked over by 3rd combo hit), leapCrouch/leap
// (tough slam attack), throwWind (moss rock lob), dying (tumble+fade).
// Fairness rule: any hit landed during a windup/telegraph CANCELS the attack.
//
// THE HOLLOW — the storm-dead of Aerwyn. Ancient skeletons (rigged KayKit
// models, CC0) risen around the old ruins, guarding the vaults by day and
// swelling in number at night and under the crimson moon. Hollows share the
// Boglin external contract (dead/pos/radius/hurt/update/home/state) so
// lock-on, player attacks and respawnFallen() work unchanged. Until the
// GLBs finish loading, Hollows simply do not spawn.
import * as THREE from 'three';
import { G, save } from './state.js';
import { heightAt, WATER_Y, toonMat, toonGradient } from './terrain.js';
import { hash2, clamp, lerp } from './noise.js';
import { addPickup, spawnSparkle, makeGlow, markSeen } from './world.js';
import { isNight } from './sky.js';
import { preloadModels, instantiate, findClip, propInstance } from './assets.js';

const tmp1 = new THREE.Vector3(), tmp2 = new THREE.Vector3();
const dummy = new THREE.Object3D(); // build-time matrix scratch
const tmpBox = new THREE.Box3();    // build-time model measuring scratch

// TotK-style character rim light: a pale sky-blue view-dependent fresnel
// added into the toon material's outgoing light so boglins lift softly off
// the background. Patches only the surface shader — the depth material is
// untouched, so shadow casting is unaffected. Runs once per material at
// compile time (no per-frame cost). Chains any onBeforeCompile the shared
// toonMat may already carry. (Local copy — mirrors the helper in player.js;
// kept file-local on purpose to avoid cross-file coupling.)
function rimToon(mat, strength = 0.25, power = 2.8) {
  const prior = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prior) prior(shader, renderer);
    shader.uniforms.uRimColor = { value: new THREE.Color(0x9fd8ff) };
    shader.uniforms.uRimStrength = { value: strength };
    shader.uniforms.uRimPower = { value: power };
    shader.fragmentShader =
      'uniform vec3 uRimColor;\nuniform float uRimStrength;\nuniform float uRimPower;\n' +
      shader.fragmentShader.replace(
        '#include <opaque_fragment>',
        // geometryNormal / geometryViewDir are in scope from <lights_fragment_begin>
        'float rimFresnel = pow( 1.0 - saturate( dot( geometryNormal, geometryViewDir ) ), uRimPower );\n' +
        '\toutgoingLight += uRimColor * ( uRimStrength * rimFresnel );\n' +
        '\t#include <opaque_fragment>'
      );
  };
  return mat;
}

const CAMPS = [
  [10, -10, 3], [150, 150, 2], [-120, 60, 3], [-40, -160, 2],
  [230, -60, 3], [-230, -20, 2], [60, 190, 2], [-140, 210, 2], [200, 240, 3],
];

// slide a step around hard world colliders (trees, ruins, tower shafts):
// the inward radial part of the step is stripped and the mover is kept on
// the collider rim, so walkers skirt obstacles instead of plowing into
// them — this is also what lets a de-aggroed enemy find its way home.
function slideStep(pos, y, dx, dz, out) {
  let nx = pos.x + dx, nz = pos.z + dz;
  const cols = G.colliders;
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i];
    if (c.soft) continue;
    if (c.top !== undefined && y > c.top - 0.3) continue;       // standing above it
    if (c.bottom !== undefined && y + 1.6 < c.bottom) continue; // fully below the band
    const ox = nx - c.x, oz = nz - c.z;
    const min = c.r + 0.45;
    const d2 = ox * ox + oz * oz;
    if (d2 >= min * min || d2 < 1e-8) continue;
    const d = Math.sqrt(d2), ux = ox / d, uz = oz / d;
    const inward = Math.min(0, dx * ux + dz * uz);
    // keep the tangential motion, drop the inward part, hug the rim
    nx = c.x + ux * min + (dx - ux * inward);
    nz = c.z + uz * min + (dz - uz * inward);
  }
  out.x = nx; out.z = nz;
  return out;
}
const _slide = { x: 0, z: 0 };

let nightNow = false; // refreshed once per updateEnemies tick

// ---------------------------------------------------------------- pooled fx
// Rocks (moss boglin projectiles) — hard cap across ALL enemies.
const ROCK_MAX = 6;
const rocks = [];
// Expanding shockwave rings (tough slam / heavy landings).
const RING_MAX = 4;
const rings = [];
// Shadow discs shown at the predicted landing spot of a leaping tough.
const DISC_MAX = 3;
const discs = [];
// Hollow-mage energy bolts (neon-green, additive) — hard cap across ALL mages.
const BOLT_MAX = 5;
const BOLT_G = 5; // gentle gravity → shallow, readable arc at ~14 m/s
const bolts = [];
let poolsReady = false;

function initPools() {
  if (poolsReady) return;
  poolsReady = true;
  const rockGeo = new THREE.DodecahedronGeometry(0.24, 0);
  for (let i = 0; i < ROCK_MAX; i++) {
    const mesh = new THREE.Mesh(rockGeo, toonMat({ color: 0x8d8f7c }));
    mesh.castShadow = true;
    mesh.visible = false;
    const marker = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1.05, 20),
      new THREE.MeshBasicMaterial({
        color: 0xffd080, transparent: true, opacity: 0.6,
        depthWrite: false, side: THREE.DoubleSide,
      })
    );
    marker.rotation.x = -Math.PI / 2;
    marker.visible = false;
    G.scene.add(mesh, marker);
    rocks.push({
      mesh, marker, active: false, held: false,
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      tx: 0, ty: 0, tz: 0, t: 0, T: 1,
    });
  }
  const ringGeo = new THREE.RingGeometry(0.82, 1.0, 28);
  for (let i = 0; i < RING_MAX; i++) {
    const mesh = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
      color: 0xffdba0, transparent: true, opacity: 0.85,
      depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.visible = false;
    G.scene.add(mesh);
    rings.push({ mesh, t: 0, active: false });
  }
  const discGeo = new THREE.CircleGeometry(1, 20);
  for (let i = 0; i < DISC_MAX; i++) {
    const mesh = new THREE.Mesh(discGeo, new THREE.MeshBasicMaterial({
      color: 0x101018, transparent: true, opacity: 0.34, depthWrite: false,
    }));
    mesh.rotation.x = -Math.PI / 2;
    mesh.visible = false;
    G.scene.add(mesh);
    discs.push({ mesh, active: false });
  }
  // hollow-mage bolts: additive core sphere + light-less glow sprite, plus a
  // ground ring that marks the predicted impact while the bolt flies and
  // bursts outward on impact
  const boltGeo = new THREE.SphereGeometry(0.17, 10, 8);
  const boltRingGeo = new THREE.RingGeometry(0.88, 1.1, 22);
  for (let i = 0; i < BOLT_MAX; i++) {
    const mesh = new THREE.Mesh(boltGeo, new THREE.MeshBasicMaterial({
      color: 0x63ffa4, transparent: true, opacity: 0.95,
      depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    mesh.add(makeGlow(0x39ff88, 1.5));
    const ring = new THREE.Mesh(boltRingGeo, new THREE.MeshBasicMaterial({
      color: 0x39ff88, transparent: true, opacity: 0.5,
      depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    }));
    ring.rotation.x = -Math.PI / 2;
    mesh.visible = ring.visible = false;
    G.scene.add(mesh, ring);
    bolts.push({
      mesh, ring, active: false, phase: 0,
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, t: 0, T: 1,
      reflected: false, owner: null,
    });
  }
}

function acquireBolt() {
  for (let i = 0; i < bolts.length; i++) if (!bolts[i].active) {
    const b = bolts[i];
    b.active = true; b.phase = 0; b.t = 0;
    b.reflected = false; b.owner = null;
    b.mesh.material.color.setHex(0x63ffa4);
    if (b.mesh.children[0] && b.mesh.children[0].material.color)
      b.mesh.children[0].material.color.setHex(0x39ff88);
    return b;
  }
  return null;
}

function freeBolt(b) {
  b.active = false;
  b.reflected = false;
  b.owner = null;
  b.mesh.visible = false;
  b.ring.visible = false;
}

function combatCenterY(e) {
  const ground = heightAt(e.pos.x, e.pos.z);
  return e.pos.y > ground + 2.2 ? e.pos.y : e.pos.y + 0.95;
}

function reflectBolt(b) {
  b.reflected = true;
  b.t = 0;
  b.ring.visible = false; // the old player-impact marker is no longer truthful
  b.mesh.material.color.setHex(0xc8fff0);
  if (b.mesh.children[0] && b.mesh.children[0].material.color)
    b.mesh.children[0].material.color.setHex(0xb8ffe8);

  const target = b.owner && !b.owner.dead ? b.owner : null;
  if (target) {
    const tx = target.pos.x, ty = combatCenterY(target), tz = target.pos.z;
    const T = clamp(Math.hypot(tx - b.x, ty - b.y, tz - b.z) / 22, 0.25, 1.6);
    b.T = T;
    b.vx = (tx - b.x) / T;
    b.vz = (tz - b.z) / T;
    b.vy = (ty - b.y) / T + 0.5 * BOLT_G * T;
  } else {
    b.T = 1.2;
    b.vx *= -1.25;
    b.vz *= -1.25;
    b.vy = Math.max(3, -b.vy * 0.6);
  }
  spawnSparkle(b.x, b.y, b.z, 0xc8fff0, 18, 5);
}

function updateBolts(dt) {
  const p = G.player.pos;
  for (let i = 0; i < bolts.length; i++) {
    const b = bolts[i];
    if (!b.active) continue;
    if (b.phase === 0) {                 // flying
      b.t += dt;
      b.vy -= BOLT_G * dt;
      b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
      b.mesh.position.set(b.x, b.y, b.z);
      const sourceX = b.owner && !b.owner.dead ? b.owner.pos.x : b.x - b.vx;
      const sourceZ = b.owner && !b.owner.dead ? b.owner.pos.z : b.z - b.vz;

      // A fresh frontal guard catches the spell before its ground burst and
      // redirects it toward the caster. Regular guarding is handled by the
      // eventual damage() call and absorbs rather than reflects.
      if (!b.reflected &&
          Math.hypot(p.x - b.x, (p.y + 1.0) - b.y, p.z - b.z) < 1.3 &&
          G.player.tryPerfectGuard && G.player.tryPerfectGuard(sourceX, sourceZ)) {
        reflectBolt(b);
        continue;
      }

      if (b.reflected) {
        let hit = false;
        for (const e of G.enemies) {
          if (e.dead) continue;
          const dx = e.pos.x - b.x, dz = e.pos.z - b.z;
          const dy = combatCenterY(e) - b.y;
          const r = e.radius + 0.45;
          if (dx * dx + dy * dy + dz * dz < r * r) {
            e.hurt(4, p);
            spawnSparkle(b.x, b.y, b.z, 0xc8fff0, 24, 6);
            G.camShake += 0.18;
            freeBolt(b);
            hit = true;
            break;
          }
        }
        if (hit) continue;
      }
      // impact marker fades in and pulses while the bolt is airborne
      const k = clamp(b.t / b.T, 0, 1);
      b.ring.scale.setScalar(0.55 + k * 0.85);
      b.ring.material.opacity = (0.2 + k * 0.45) * (0.75 + Math.sin(G.time * 14) * 0.25);
      if (b.t >= b.T || b.y < heightAt(b.x, b.z) + 0.12) {
        const gy = heightAt(b.x, b.z);
        if (!b.reflected && Math.hypot(p.x - b.x, p.z - b.z) < 1.4 &&
            Math.abs(p.y - gy) < 2.5) {
          // Large deterministic test steps can skip the near-body check;
          // preserve the perfect-guard contract at the impact boundary too.
          if (G.player.tryPerfectGuard && G.player.tryPerfectGuard(sourceX, sourceZ)) {
            b.x = p.x + Math.sin(G.player.yaw) * 0.72;
            b.y = p.y + 1.12;
            b.z = p.z + Math.cos(G.player.yaw) * 0.72;
            b.mesh.position.set(b.x, b.y, b.z);
            reflectBolt(b);
            continue;
          }
          G.player.damage(3, sourceX, sourceZ);
        }
        spawnSparkle(b.x, gy + 0.4, b.z, 0x63ffa4, 16, 4);
        G.audio.sfx('thud');
        b.phase = 1; b.t = 0;
        b.mesh.visible = false;
        b.ring.position.set(b.x, gy + 0.06, b.z); // burst where it landed
      }
    } else {                              // impact ring burst
      b.t += dt;
      const k = b.t / 0.35;
      if (k >= 1) { freeBolt(b); continue; }
      b.ring.scale.setScalar(1.3 + k * 2.3);
      b.ring.material.opacity = (1 - k) * 0.8;
    }
  }
}

function acquireRock() {
  for (let i = 0; i < rocks.length; i++) if (!rocks[i].active) {
    const r = rocks[i];
    r.active = true; r.held = true; r.t = 0;
    r.mesh.visible = true;
    return r;
  }
  return null;
}

function freeRock(r) {
  r.active = false; r.held = false;
  r.mesh.visible = false;
  r.marker.visible = false;
  const m = r.mesh.material;
  if (m.emissive) { m.emissive.setHex(0x000000); m.emissiveIntensity = 0; }
}

function updateRocks(dt) {
  const p = G.player.pos;
  for (let i = 0; i < rocks.length; i++) {
    const r = rocks[i];
    if (!r.active || r.held) continue;
    r.t += dt;
    r.vy -= 20 * dt;
    r.x += r.vx * dt; r.y += r.vy * dt; r.z += r.vz * dt;
    r.mesh.position.set(r.x, r.y, r.z);
    r.mesh.rotation.x += dt * 7;
    r.mesh.rotation.z += dt * 5;
    // predicted-landing marker grows and pulses while the rock flies
    const k = clamp(r.t / r.T, 0, 1);
    r.marker.scale.setScalar((0.45 + k * 0.75) * 1.2);
    r.marker.material.opacity = 0.45 + Math.sin(G.time * 12) * 0.2;
    if (r.t >= r.T || r.y < heightAt(r.x, r.z) + 0.15) {
      // burst where the rock actually is (it may clip a hillside early)
      const gy = heightAt(r.x, r.z);
      if (Math.hypot(p.x - r.x, p.z - r.z) < 1.2 && Math.abs(p.y - gy) < 2.5) {
        G.player.damage(2, r.x, r.z);
      }
      spawnSparkle(r.x, gy + 0.3, r.z, 0xb9a888, 14, 3); // dust burst
      G.audio.sfx('thud');
      freeRock(r);
    }
  }
}

function spawnRing(x, y, z) {
  for (let i = 0; i < rings.length; i++) if (!rings[i].active) {
    const r = rings[i];
    r.active = true; r.t = 0;
    r.mesh.visible = true;
    r.mesh.position.set(x, y, z);
    r.mesh.scale.setScalar(0.5);
    r.mesh.material.opacity = 0.85;
    return;
  }
}

function updateRings(dt) {
  for (let i = 0; i < rings.length; i++) {
    const r = rings[i];
    if (!r.active) continue;
    r.t += dt;
    const k = r.t / 0.5;
    if (k >= 1) { r.active = false; r.mesh.visible = false; continue; }
    r.mesh.scale.setScalar(0.5 + k * 3.2);
    r.mesh.material.opacity = (1 - k) * 0.85;
  }
}

function acquireDisc() {
  for (let i = 0; i < discs.length; i++) if (!discs[i].active) {
    discs[i].active = true;
    discs[i].mesh.visible = true;
    return discs[i];
  }
  return null;
}

function freeDisc(d) {
  d.active = false;
  d.mesh.visible = false;
}

// ---------------------------------------------------------------- camp props
// Each camp gets a totem pole + fire ring. Repeated geometry is instanced
// (one draw call per part across ALL camps). At night the fire lights and a
// single shared PointLight is granted to the camp nearest the player
// (distance-gated like the shrine lights, but cheaper — one light total).
const campProps = []; // { x, z, y, flame, glow, lit, doused, wetT, dryT }
let campLight = null;
const campSmoke = []; // pooled rising smoke puffs, granted to the nearest lit fire

function setInstance(im, i, x, y, z, ry, rz, s) {
  dummy.position.set(x, y, z);
  dummy.rotation.set(0, ry, rz);
  dummy.scale.setScalar(s);
  dummy.updateMatrix();
  im.setMatrixAt(i, dummy.matrix);
}

function buildCamps() {
  const spots = [];
  for (const [cx, cz] of CAMPS) {
    const h = heightAt(cx, cz);
    if (h < WATER_Y + 0.5) continue;
    spots.push([cx, cz, h]);
  }
  const n = spots.length;
  const trunkIM = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.3, 0.42, 2.7, 7), toonMat({ color: 0x77502e }), n);
  const headIM = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.95, 0.6, 0.75), toonMat({ color: 0xc9803a }), n);
  const topIM = new THREE.InstancedMesh(
    new THREE.ConeGeometry(0.36, 0.65, 6), toonMat({ color: 0x5a3b23 }), n);
  const wingIM = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1.8, 0.16, 0.42), toonMat({ color: 0x8a5f36 }), n);
  const stoneIM = new THREE.InstancedMesh(
    new THREE.DodecahedronGeometry(0.27, 0), toonMat({ color: 0x7f7a72 }), n * 6);
  const logIM = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.09, 0.12, 1.15, 5), toonMat({ color: 0x594026 }), n * 3);
  trunkIM.castShadow = headIM.castShadow = topIM.castShadow = true;

  const flameMat = new THREE.MeshBasicMaterial({
    color: 0xffa03c, transparent: true, opacity: 0.9,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const flameGeo = new THREE.ConeGeometry(0.42, 1.0, 7);

  for (let i = 0; i < n; i++) {
    const [cx, cz, ch] = spots[i];
    // totem, offset from the fire so it reads as a landmark silhouette
    const ta = hash2(cx | 0, cz | 0, 7) * Math.PI * 2;
    const tx = cx + Math.cos(ta) * 2.6, tz = cz + Math.sin(ta) * 2.6;
    const th = heightAt(tx, tz);
    setInstance(trunkIM, i, tx, th + 1.3, tz, ta, 0, 1);
    setInstance(headIM, i, tx, th + 2.85, tz, ta, 0, 1);
    setInstance(topIM, i, tx, th + 3.45, tz, ta, 0, 1);
    setInstance(wingIM, i, tx, th + 2.45, tz, ta + 0.5, 0.12, 1);
    // fire ring stones + teepee logs at the camp center
    for (let s = 0; s < 6; s++) {
      const a = (s / 6) * Math.PI * 2 + hash2(i, s) * 0.5;
      const sx = cx + Math.cos(a) * 0.95, sz = cz + Math.sin(a) * 0.95;
      setInstance(stoneIM, i * 6 + s, sx, heightAt(sx, sz) + 0.12, sz,
        hash2(i, s + 20) * 3, 0, 0.8 + hash2(i, s + 40) * 0.5);
    }
    for (let l = 0; l < 3; l++) {
      const a = (l / 3) * Math.PI * 2 + 0.4;
      dummy.position.set(cx + Math.cos(a) * 0.22, ch + 0.5, cz + Math.sin(a) * 0.22);
      dummy.rotation.set(Math.cos(a) * 0.9, 0, Math.sin(a) * 0.9);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      logIM.setMatrixAt(i * 3 + l, dummy.matrix);
    }
    const flame = new THREE.Mesh(flameGeo, flameMat);
    flame.position.set(cx, ch + 0.75, cz);
    flame.visible = false;
    const glow = makeGlow(0xff9a3d, 3.4);
    glow.position.set(cx, ch + 1.2, cz);
    glow.visible = false;
    G.scene.add(flame, glow);
    campProps.push({
      x: cx, z: cz, y: ch, flame, glow,
      lit: false, doused: false, wetT: 0, dryT: 0, saidDouse: false,
    }); // lit: kindled by an arrow; sustained rain can douse it
  }
  G.scene.add(trunkIM, headIM, topIM, wingIM, stoneIM, logIM);

  campLight = new THREE.PointLight(0xff8a3d, 0, 22);
  G.scene.add(campLight);
  for (let i = 0; i < 4; i++) {
    const puff = makeGlow(0x8a94a2, 2);
    puff.visible = false;
    G.scene.add(puff);
    campSmoke.push(puff);
  }
}

// is this camp's fire burning right now? (kindled flag, or the ambient
// night-lighting within earshot of the player)
function fireBurning(c, distToPlayer) {
  if (c.doused) return false;
  return c.lit || (nightNow && distToPlayer < 120);
}

function campFireAt(x, z) {
  for (let i = 0; i < campProps.length; i++) {
    const c = campProps[i];
    if (Math.abs(c.x - x) < 0.01 && Math.abs(c.z - z) < 0.01) return c;
  }
  return null;
}

function updateCamps(dt) {
  const p = G.player.pos;
  const wet = clamp(G.weather.wetness || 0, 0, 1);
  const soaking = wet > 0.55;
  let best = -1, bestD = 1e9; // nearest BURNING fire (owns the light + smoke)
  for (let i = 0; i < campProps.length; i++) {
    const c = campProps[i];
    const d = Math.hypot(p.x - c.x, p.z - c.z);
    const wasBurning = fireBurning(c, d);
    if (soaking) {
      c.wetT += dt;
      c.dryT = 0;
    } else {
      c.wetT = Math.max(0, c.wetT - dt * 1.5);
      if (c.doused && wet < 0.3) c.dryT += dt;
      else c.dryT = 0;
    }
    // Five continuous seconds of real rain, not a crossfade drizzle, so a
    // player reaching a camp as rain begins still has time to use its flame.
    if (!c.doused && c.wetT >= 5) {
      c.doused = true;
      c.lit = false;
      c.dryT = 0;
      if (wasBurning && d < 80) {
        spawnSparkle(c.x, c.y + 0.8, c.z, 0x9fb7c8, 16, 2.8);
        G.audio.sfx('splash');
      }
      if (wasBurning && d < 45 && !c.saidDouse) {
        c.saidDouse = true;
        G.ui.toast('The rain doused the boglin fire', 0xaed8e8);
      }
    } else if (c.doused && c.dryT >= 10) {
      // Dry wood can resume its ambient night flame; player-kindled daytime
      // fires still need another burning arrow because c.lit was cleared.
      c.doused = false;
      c.wetT = 0;
      c.dryT = 0;
      c.saidDouse = false;
    }
    const lit = fireBurning(c, d);
    if (lit && d < bestD) { bestD = d; best = i; }
    c.flame.visible = lit;
    c.glow.visible = lit;
    if (lit) {
      const fl = 1 + Math.sin(G.time * 11 + i * 2.1) * 0.16 + Math.sin(G.time * 23 + i) * 0.07;
      c.flame.scale.set(1, fl, 1);
      c.glow.scale.setScalar(3.4 * (0.9 + fl * 0.15));
    }
  }
  // one shared light, granted to the nearest burning camp, gated by distance
  if (campLight) {
    if (best >= 0 && bestD < 50) {
      const c = campProps[best];
      campLight.position.set(c.x, c.y + 1.6, c.z);
      campLight.intensity =
        (1.6 + Math.sin(G.time * 9) * 0.3) * clamp((50 - bestD) / 12, 0, 1);
    } else {
      campLight.intensity = 0;
    }
  }
  // smoke coils off the nearest lit fire
  const smokeOn = best >= 0 && bestD < 70;
  for (let i = 0; i < campSmoke.length; i++) {
    const puff = campSmoke[i];
    if (!smokeOn) { puff.visible = false; continue; }
    const c = campProps[best];
    const cyc = (G.time * 0.42 + i * 0.25) % 1;
    puff.visible = true;
    puff.position.set(
      c.x + Math.sin(G.time * 0.8 + i * 2.4) * (0.25 + cyc * 0.8),
      c.y + 1.1 + cyc * 4.6,
      c.z + Math.cos(G.time * 0.7 + i * 2.1) * (0.25 + cyc * 0.8));
    puff.scale.setScalar(1.2 + cyc * 2.6);
    puff.material.opacity = (1 - cyc) * 0.22;
  }
}

// ---- kindled arrows: the world's open flames are real ----------------------
// Is there a burning flame within r of the point? Camp fires + live mage
// bolts both count — an arrow drawn through either catches fire.
export function flameNear(x, y, z, r) {
  const p = G.player.pos;
  for (const c of campProps) {
    if (Math.abs(y - (c.y + 0.9)) > 1.7) continue;
    const dx = x - c.x, dz = z - c.z;
    if (dx * dx + dz * dz < r * r &&
        fireBurning(c, Math.hypot(p.x - c.x, p.z - c.z))) return true;
  }
  for (const b of bolts) {
    if (!b.active || b.phase !== 0) continue;
    const dx = x - b.x, dy = y - b.y, dz = z - b.z;
    if (dx * dx + dy * dy + dz * dz < r * r) return true;
  }
  return false;
}

// A kindled arrow passing an unlit fire ring wakes it — the camp lights
// early, on the player's terms. Returns true if a fire caught.
export function igniteFireNear(x, y, z, r) {
  const p = G.player.pos;
  let caught = false;
  for (const c of campProps) {
    if (c.lit || (!c.doused && nightNow && Math.hypot(p.x - c.x, p.z - c.z) < 120)) continue;
    if (c.doused && (G.weather.wetness || 0) > 0.45) continue;
    if (Math.abs(y - (c.y + 0.75)) > 2.2) continue;
    const dx = x - c.x, dz = z - c.z;
    if (dx * dx + dz * dz < r * r) {
      c.lit = true;
      c.doused = false;
      c.wetT = 0;
      c.dryT = 0;
      c.saidDouse = false;
      caught = true;
      spawnSparkle(c.x, c.y + 1.0, c.z, 0xffa03c, 22, 3.2);
      G.audio.sfx('windup');
    }
  }
  return caught;
}

// ---------------------------------------------------------------- razorkite
// Sail-winged predators circling the thermals above the skywatch towers and
// the old bellows. They only hunt what flies: stray into their gyre on the
// glider (or fall past it) and one folds its wings and comes down at you.
// Two arrows drop one, and a Swift Feather drifts down where it falls.
const KITE_SITES = [
  [110, 20, 46],    // skywatch tower, Heartfields
  [-200, -140, 46], // skywatch tower, Stormridge approach
  [-27, 281, 27],   // the wind bellows thermal
]; // [x, z, orbit height above the ground]

class Razorkite {
  constructor(x, z, alt, idx) {
    this.home = new THREE.Vector2(x, z);
    this.baseY = heightAt(x, z) + alt;
    this.orbitR = 10 + (idx % 2) * 5;
    this.orbitDir = idx % 2 ? 1 : -1;
    this.orbitA = idx * 2.7;
    this.pos = new THREE.Vector3(
      x + Math.cos(this.orbitA) * this.orbitR, this.baseY,
      z + Math.sin(this.orbitA) * this.orbitR);
    this.yaw = 0;
    this.hp = this.maxHp = 4; // two arrows
    this.radius = 1.4;
    this.state = 'circle';
    this.stateT = 0;
    this.dead = false;
    this.dying = false;
    this.dyingT = 0;
    this.isHollow = true; // rides the crimson-moon / night re-knit respawn paths
    this.nightRespawnUsed = false;
    this.diveCd = 2 + idx;
    this.flashT = 0;
    this.hitstopT = 0;
    this.dx = 0; this.dy = 0; this.dz = 0; // dive direction
    this.buildModel();
  }

  buildModel() {
    this.group = new THREE.Group();
    const inner = new THREE.Group();
    // procedural stand-in: slate sail-shape that reads at distance
    const bodyMat = rimToon(toonMat({ color: 0x5c5474 }), 0.25, 2.5);
    const wingMat = toonMat({ color: 0x9c93b8, side: THREE.DoubleSide });
    const body = new THREE.Group();
    const hull = new THREE.Mesh(new THREE.ConeGeometry(0.16, 1.2, 6), bodyMat);
    hull.rotation.x = Math.PI / 2;
    body.add(hull);
    const head = new THREE.Group();
    head.position.set(0, 0.03, 0.55);
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.3, 5), toonMat({ color: 0x2e2a33 }));
    beak.rotation.x = Math.PI / 2;
    beak.position.z = 0.18;
    head.add(beak);
    const wingGeo = new THREE.PlaneGeometry(1.15, 0.65);
    wingGeo.translate(0.62, 0, -0.1); // pivot at the wing root
    const wingL = new THREE.Group(), wingR = new THREE.Group();
    const wL = new THREE.Mesh(wingGeo, wingMat);
    wL.rotation.x = -Math.PI / 2;
    const wR = wL.clone();
    wR.rotation.z = Math.PI;
    wingL.add(wL); wingR.add(wR);
    wingL.position.set(0.12, 0.05, 0); wingR.position.set(-0.12, 0.05, 0);
    const tail = new THREE.Group();
    tail.position.set(0, 0.03, -0.55);
    const tm = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.7, 4), bodyMat);
    tm.rotation.x = -Math.PI / 2;
    tm.position.z = -0.3;
    tail.add(tm);
    inner.add(body, head, wingL, wingR, tail);
    inner.scale.setScalar(1.4); // predator presence — reads from a glide away
    this.body = body; this.headGrp = head;
    this.wingL = wingL; this.wingR = wingR; this.tail = tail;
    this.group.add(inner);
    this.group.traverse(o => { if (o.isMesh) o.castShadow = true; });
    this.cacheMats(inner);
    this.group.position.copy(this.pos);
    G.scene.add(this.group);
    preloadModels(['razorkite']).then(res => {
      if (res && res.razorkite && !this.dead) this.upgradeModel();
    }).catch(() => {});
  }

  // Blender model swap: same holder-wrap contract as the boglin — holders own
  // pivots and take animate()'s rotation writes; GLB nodes keep their baked
  // axis-conversion quaternion. Authored facing -Z -> inner.rotation.y = PI.
  upgradeModel() {
    const root = propInstance('razorkite');
    if (!root) return;
    const inner = new THREE.Group();
    inner.rotation.y = Math.PI;
    inner.scale.setScalar(1.4); // predator presence — reads from a glide away
    const take = (name) => {
      const node = root.getObjectByName(name);
      if (!node) return null;
      const holder = new THREE.Group();
      holder.position.copy(node.position);
      node.position.set(0, 0, 0);
      holder.add(node);
      inner.add(holder);
      return holder;
    };
    const body = take('body'), head = take('head');
    const wingL = take('wingL'), wingR = take('wingR'), tail = take('tail');
    if (!body || !head || !wingL || !wingR || !tail) return; // keep procedural
    this.group.clear();
    this.group.add(inner);
    this.body = body; this.headGrp = head;
    this.wingL = wingL; this.wingR = wingR; this.tail = tail;
    this.cacheMats(inner);
  }

  cacheMats(rootGrp) {
    const mats = new Set();
    rootGrp.traverse(o => {
      if (!o.isMesh) return;
      o.castShadow = true;
      (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => mats.add(m));
    });
    this.flashMats = [...mats].filter(m => m.emissive);
    this.flashBase = this.flashMats.map(m => m.emissive.getHex());
  }

  setState(s) {
    this.state = s;
    this.stateT = 0;
    if (s === 'windup') G.audio.sfx('screech'); // heard before it is seen
  }

  hurt(dmg, fromPos) {
    if (this.dead) return;
    this.hp -= dmg;
    this.flashT = 0.15;
    this.hitstopT = 0.06;
    G.audio.sfx('hit');
    // fairness rule: a hit during the telegraph or dive breaks the attack
    if (this.state === 'windup' || this.state === 'dive') this.setState('recover');
    if (this.hp <= 0) this.die();
  }

  die() {
    this.dead = true;
    this.dying = true;
    this.dyingT = 0;
    this.spinDir = Math.random() < 0.5 ? -1 : 1;
    G.audio.sfx('die');
  }

  reawaken() {
    this.dead = false;
    this.dying = false;
    this.hp = this.maxHp;
    this.diveCd = 4;
    this.pos.set(
      this.home.x + Math.cos(this.orbitA) * this.orbitR, this.baseY,
      this.home.y + Math.sin(this.orbitA) * this.orbitR);
    this.group.visible = true;
    this.group.rotation.set(0, 0, 0);
    this.setState('circle');
  }

  update(dt) {
    if (this.dead && !this.dying) return;
    if (this.dying) { this.updateDying(dt); return; }
    const p = G.player.pos;
    const distXZ = Math.hypot(p.x - this.pos.x, p.z - this.pos.z);
    if (distXZ > 120) return; // asleep on the far thermals
    if (this.hitstopT > 0) { this.hitstopT -= dt; return; }
    if (this.flashT > 0) {
      this.flashT -= dt;
      const k = Math.max(0, this.flashT / 0.15);
      for (let i = 0; i < this.flashMats.length; i++) {
        this.flashMats[i].emissive.setHex(this.flashBase[i]);
        this.flashMats[i].emissive.lerp(FLASH_WHITE, k);
      }
    }
    this.stateT += dt;
    this.diveCd -= dt;
    const groundBelowPlayer = heightAt(p.x, p.z);

    if (this.state === 'circle') {
      this.orbitA += this.orbitDir * 0.6 * dt;
      const tx = this.home.x + Math.cos(this.orbitA) * this.orbitR;
      const tz = this.home.y + Math.sin(this.orbitA) * this.orbitR;
      const ty = this.baseY + Math.sin(G.time * 0.7 + this.orbitA) * 1.6;
      this.pos.x += (tx - this.pos.x) * Math.min(1, dt * 3);
      this.pos.z += (tz - this.pos.z) * Math.min(1, dt * 3);
      this.pos.y += (ty - this.pos.y) * Math.min(1, dt * 2);
      this.yaw = this.orbitA + this.orbitDir * Math.PI / 2 + Math.PI / 2;
      // sky predators only hunt what flies
      const airborne = G.player.mode === 'glide' || p.y > groundBelowPlayer + 6;
      if (this.diveCd <= 0 && airborne && distXZ < 30 && Math.abs(p.y - this.pos.y) < 34) {
        this.setState('windup');
      }
    } else if (this.state === 'windup') {
      // hang in the air, wings spread, facing the prey — the screech is the tell
      this.pos.y += dt * 1.4;
      this.yaw = Math.atan2(p.x - this.pos.x, p.z - this.pos.z);
      if (this.stateT > 0.85) {
        const v = G.player.vel;
        tmp1.set(p.x + v.x * 0.55 - this.pos.x,
                 p.y + 1.2 + v.y * 0.3 - this.pos.y,
                 p.z + v.z * 0.55 - this.pos.z).normalize();
        this.dx = tmp1.x; this.dy = tmp1.y; this.dz = tmp1.z;
        this.setState('dive');
        G.audio.sfx('glide');
      }
    } else if (this.state === 'dive') {
      const sp = 25;
      this.pos.x += this.dx * sp * dt;
      this.pos.y += this.dy * sp * dt;
      this.pos.z += this.dz * sp * dt;
      this.yaw = Math.atan2(this.dx, this.dz);
      const hd = Math.hypot(p.x - this.pos.x, (p.y + 1.2) - this.pos.y, p.z - this.pos.z);
      if (hd < 1.7) {
        if (G.player.iframes <= 0) G.hitStopT = Math.max(G.hitStopT, 0.09);
        G.player.damage(2, this.pos.x, this.pos.z); // damage() slams the canopy shut
        G.camShake += 0.2;
        this.setState('recover');
      } else if (this.stateT > 2.1 || this.pos.y < heightAt(this.pos.x, this.pos.z) + 1.2) {
        this.setState('recover'); // pulled up empty-taloned
      }
    } else { // recover: climb back to the gyre
      const tx = this.home.x + Math.cos(this.orbitA) * this.orbitR;
      const tz = this.home.y + Math.sin(this.orbitA) * this.orbitR;
      tmp1.set(tx - this.pos.x, this.baseY - this.pos.y, tz - this.pos.z);
      const d = tmp1.length();
      if (d < 2.5) {
        this.setState('circle');
        this.diveCd = 6 + Math.random() * 3;
      } else {
        tmp1.normalize();
        this.pos.addScaledVector(tmp1, Math.min(d, 13 * dt));
        this.yaw = Math.atan2(tmp1.x, tmp1.z);
      }
    }
    this.animate(dt);
  }

  updateDying(dt) {
    this.dyingT += dt;
    this.pos.y -= (7 + this.dyingT * 9) * dt;
    this.pos.x += Math.cos(this.dyingT * 5) * dt * 3;
    this.pos.z += Math.sin(this.dyingT * 5) * dt * 3;
    this.group.rotation.z += this.spinDir * dt * 7;
    this.group.rotation.y += dt * 4;
    this.group.position.copy(this.pos);
    const gy = Math.max(heightAt(this.pos.x, this.pos.z), WATER_Y);
    if (this.pos.y <= gy + 0.3) {
      this.dying = false;
      this.group.visible = false;
      G.items.feather = (G.items.feather || 0) + 1;
      markSeen('feather');
      spawnSparkle(this.pos.x, gy + 0.8, this.pos.z, 0x5fd8c0, 22, 3.5);
      G.ui.toast('A Swift Feather drifts down where the razorkite fell.', 0x5fd8c0, 3600);
      G.audio.sfx('glimmer');
      save();
    }
  }

  animate(dt) {
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
    const diving = this.state === 'dive';
    const windup = this.state === 'windup';
    // wings: lazy deep flaps on the gyre, spread high in the telegraph,
    // folded tight for the stoop
    const flap = diving ? -1.05
      : windup ? 0.55 + Math.sin(G.time * 26) * 0.1
      : Math.sin(G.time * 5.5 + this.orbitA) * 0.4 + 0.12;
    this.wingL.rotation.z = lerp(this.wingL.rotation.z, flap, Math.min(1, dt * 10));
    this.wingR.rotation.z = lerp(this.wingR.rotation.z, -flap, Math.min(1, dt * 10));
    // pitch with the dive; bank into the circle
    this.group.rotation.x = lerp(this.group.rotation.x, diving ? Math.asin(clamp(-this.dy, -1, 1)) * 0.7 : 0, Math.min(1, dt * 6));
    this.group.rotation.z = lerp(this.group.rotation.z, this.state === 'circle' ? this.orbitDir * 0.28 : 0, Math.min(1, dt * 4));
    this.tail.rotation.y = Math.sin(G.time * 3.1 + this.orbitA) * 0.3;
    this.headGrp.rotation.x = windup ? -0.35 : 0;
  }
}
const FLASH_WHITE = new THREE.Color(0xffffff);

// ---------------------------------------------------------------- boglin
class Boglin {
  constructor(x, z, variant, campX, campZ) {
    this.home = new THREE.Vector2(x, z);
    this.camp = new THREE.Vector2(campX, campZ);
    this.campFire = campFireAt(campX, campZ);
    this.campDoused = false; // audio.js and aggro both read this shared fact
    this.pos = new THREE.Vector3(x, heightAt(x, z), z);
    this.yaw = hash2(x | 0, z | 0) * Math.PI * 2;
    this.tough = variant === 'tough';   // indigo bruiser: leap slam
    this.moss = variant === 'moss';     // mossy lobber: keeps distance, throws rocks
    this.hp = this.maxHp = this.tough ? 6 : 3;
    this.radius = this.tough ? 0.85 : 0.7;
    this.state = 'idle';
    this.stateT = Math.random() * 3;
    this.wanderTarget = new THREE.Vector2(x, z);
    this.dead = false;
    this.dying = false;
    this.dyingT = 0;
    this.dieSpin = 1;
    this.staggerT = 0;
    this.hitstopT = 0;
    this.flashT = 0;
    this.commitT = 0;        // committed approach after orbit — no re-orbit
    this.frustration = 0;    // unreachable-player timer -> de-aggro
    this.orbitDir = 1;
    this.orbitFor = 1.5;
    this.leapCd = 4 + Math.random() * 3;
    this.throwCd = 1.5;
    this.afterRecover = 'backstep';
    this.attackHitDone = false;
    this.rock = null;        // pooled rock held during throwWind
    this.disc = null;        // pooled shadow disc during leap
    this.lvx = 0; this.lvy = 0; this.lvz = 0; this.leapT = 0.62;
    this.leapTx = 0; this.leapTy = 0; this.leapTz = 0;
    // health-bar damage chip
    this.dispFrac = 1;
    this.chipHold = 0;
    this.barTimer = 99;
    this.buildModel();
  }

  buildModel() {
    const bodyColor = this.tough ? 0x4d5ccd : this.moss ? 0x5e8f3f : 0xcd5433;
    const bodyMat = rimToon(toonMat({ color: bodyColor }), 0.26);
    const g = new THREE.Group();
    g.rotation.order = 'YXZ'; // yaw then fall-over tilt

    const skinMat = rimToon(toonMat({ color: 0xdcae7c }), 0.2);   // snout/belly skin
    const boneMat = toonMat({ color: 0xe8dcc0 });                  // tusks/horn/claws
    const clothMat = toonMat({ color: this.tough ? 0x3a3560 : 0x6a5033, side: THREE.DoubleSide });

    // hunched torso, taller than wide so it reads mean rather than round
    this.body = new THREE.Mesh(new THREE.SphereGeometry(0.6, 12, 10), bodyMat);
    this.body.position.y = 0.9;
    this.body.scale.set(0.95, 1.22, 0.88);
    const belly = new THREE.Mesh(new THREE.SphereGeometry(0.42, 10, 8), bodyMat);
    belly.position.set(0, 0.42, 0.16); belly.scale.set(0.96, 0.78, 0.92);
    this.body.add(belly);

    // --- head group: heavy brow, snout with nostrils, jutting tusks ---------
    this.headGrp = new THREE.Group();
    this.headGrp.position.y = 1.75;
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 8), bodyMat);
    skull.scale.set(1.0, 0.94, 1.06);
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.14, 0.26), bodyMat);
    brow.position.set(0, 0.14, 0.26); brow.rotation.x = 0.34;
    const snout = new THREE.Mesh(new THREE.SphereGeometry(0.19, 8, 6), skinMat);
    snout.position.set(0, -0.08, 0.34); snout.scale.set(1.15, 0.78, 1.25);
    const nostrilMat = new THREE.MeshBasicMaterial({ color: 0x241812 });
    const nostrilL = new THREE.Mesh(new THREE.SphereGeometry(0.032, 5, 4), nostrilMat);
    nostrilL.position.set(-0.07, -0.07, 0.52);
    const nostrilR = nostrilL.clone(); nostrilR.position.x = 0.07;
    const tuskL = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.28, 5), boneMat);
    tuskL.position.set(-0.13, -0.16, 0.32); tuskL.rotation.set(-0.35, 0, 0.12);
    const tuskR = tuskL.clone(); tuskR.position.x = 0.13; tuskR.rotation.z = -0.12;
    const earL = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.52, 5), bodyMat);
    earL.position.set(-0.38, 0.16, -0.02); earL.rotation.set(0, 0.3, 0.98);
    const earR = earL.clone(); earR.position.x = 0.38; earR.rotation.set(0, -0.3, -0.98);
    const horn = new THREE.Mesh(new THREE.ConeGeometry(0.085, 0.34, 5), boneMat);
    horn.position.set(0, 0.4, 0.05);
    // deep-set scowling eyes: dark angled sockets, small burning iris + pupil
    const socketMat = new THREE.MeshBasicMaterial({ color: 0x140d06 });
    const socketL = new THREE.Mesh(new THREE.SphereGeometry(0.11, 6, 5), socketMat);
    socketL.position.set(-0.15, 0.03, 0.27); socketL.scale.set(1, 0.62, 0.5); socketL.rotation.z = -0.32;
    const socketR = socketL.clone(); socketR.position.x = 0.15; socketR.rotation.z = 0.32;
    this.eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.058, 7, 6), new THREE.MeshBasicMaterial({ color: 0xffcf3a }));
    this.eyeL.position.set(-0.15, 0.02, 0.32); this.eyeL.scale.set(1, 0.64, 1);
    const pupilL = new THREE.Mesh(new THREE.SphereGeometry(0.026, 5, 4), new THREE.MeshBasicMaterial({ color: 0x140c04 }));
    pupilL.position.set(0, 0, 0.045);
    this.eyeL.add(pupilL);
    this.eyeR = this.eyeL.clone(); this.eyeR.position.x = 0.15;
    this.eyeMat = this.eyeL.material;
    this.headGrp.add(skull, brow, snout, nostrilL, nostrilR, tuskL, tuskR,
      earL, earR, horn, socketL, socketR, this.eyeL, this.eyeR);

    // legs with splayed clawed feet (feet ride the leg so they follow the gait)
    const legGeo = new THREE.CylinderGeometry(0.13, 0.16, 0.5, 6);
    const mkFoot = () => {
      const foot = new THREE.Mesh(new THREE.SphereGeometry(0.17, 6, 5), bodyMat);
      foot.position.set(0, -0.3, 0.06); foot.scale.set(1, 0.55, 1.5);
      for (let t = 0; t < 3; t++) {
        const claw = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.11, 4), boneMat);
        claw.position.set((t - 1) * 0.09, -0.02, 0.32); claw.rotation.x = 1.5;
        foot.add(claw);
      }
      return foot;
    };
    this.legL = new THREE.Mesh(legGeo, bodyMat); this.legL.position.set(-0.24, 0.25, 0);
    this.legL.add(mkFoot());
    this.legR = new THREE.Mesh(legGeo, bodyMat); this.legR.position.set(0.24, 0.25, 0);
    this.legR.add(mkFoot());

    // clawed hand at the end of each forearm
    const mkHand = () => {
      const h = new THREE.Group();
      const palm = new THREE.Mesh(new THREE.SphereGeometry(0.13, 6, 5), bodyMat);
      palm.scale.set(1.1, 0.8, 1.1);
      h.add(palm);
      for (let f = 0; f < 3; f++) {
        const claw = new THREE.Mesh(new THREE.ConeGeometry(0.028, 0.13, 4), boneMat);
        claw.position.set((f - 1) * 0.09, -0.02, 0.12); claw.rotation.x = 1.1;
        h.add(claw);
      }
      return h;
    };

    const shoulderGeo = new THREE.SphereGeometry(0.17, 7, 6);
    this.armR = new THREE.Group();
    const shoulderR = new THREE.Mesh(shoulderGeo, bodyMat); this.armR.add(shoulderR); // bridges to torso
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.55, 6), bodyMat);
    arm.position.y = -0.27;
    this.armR.add(arm);
    const handR = mkHand(); handR.position.y = -0.55; this.armR.add(handR);
    this.knobMat = null;
    if (!this.moss) {
      const club = new THREE.Group();
      const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.7, 5), toonMat({ color: 0x6a4a2a }));
      handle.position.y = -0.2;
      this.knobMat = toonMat({ color: 0x7a5a36 });
      const knob = new THREE.Mesh(new THREE.DodecahedronGeometry(0.22, 0), this.knobMat);
      knob.position.y = -0.55;
      // crude spikes jutting from the club head
      for (let s = 0; s < 5; s++) {
        const a = (s / 5) * Math.PI * 2;
        const spike = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.16, 4), boneMat);
        spike.position.set(Math.cos(a) * 0.2, -0.55, Math.sin(a) * 0.2);
        spike.rotation.set(Math.sin(a) * 1.4, 0, -Math.cos(a) * 1.4);
        club.add(spike);
      }
      club.add(handle, knob);
      club.position.y = -0.55;
      this.armR.add(club);
    }
    this.armR.position.set(0.5, 1.3, 0.02);
    this.armL = new THREE.Group();
    const shoulderL = new THREE.Mesh(shoulderGeo, bodyMat); this.armL.add(shoulderL);
    const arm2 = arm.clone(); this.armL.add(arm2);
    const handL = mkHand(); handL.position.y = -0.55; this.armL.add(handL);
    this.armL.position.set(-0.5, 1.3, 0.02);

    // ragged loincloth so they don't read as naked spheres
    const cloth = new THREE.Mesh(new THREE.ConeGeometry(0.5, 0.52, 8, 1, true), clothMat);
    cloth.position.y = 0.5;

    let cap = null;
    if (this.moss) { // mossy cap so the lobber reads at a glance
      cap = new THREE.Mesh(new THREE.SphereGeometry(0.34, 8, 6), toonMat({ color: 0x3f6b28 }));
      cap.position.y = 2.02;
      cap.scale.y = 0.45;
    }
    // indigo bruisers carry a row of bony back spikes
    const spikes = [];
    if (this.tough) {
      for (let s = 0; s < 4; s++) {
        const sp = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.34, 5), boneMat);
        sp.position.set(0, 1.15 + s * 0.24, -0.42 + s * 0.03);
        sp.rotation.x = -0.6;
        spikes.push(sp);
      }
    }

    // "!" for alert
    this.alertMark = new THREE.Mesh(
      new THREE.ConeGeometry(0.12, 0.5, 6),
      new THREE.MeshBasicMaterial({ color: 0xff3030 })
    );
    this.alertMark.position.y = 2.7;
    this.alertMark.rotation.x = Math.PI;
    this.alertMark.visible = false;

    // "?" for suspicious (torus arc + dot)
    this.qMark = new THREE.Group();
    const qMat = new THREE.MeshBasicMaterial({ color: 0xffd24a });
    const hook = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.045, 6, 12, Math.PI * 1.45), qMat);
    hook.position.y = 2.82;
    hook.rotation.z = -0.55;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.055, 6, 5), qMat);
    dot.position.y = 2.52;
    this.qMark.add(hook, dot);
    this.qMark.visible = false;

    // health bar billboard with white damage-chip segment
    const barBg = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.13),
      new THREE.MeshBasicMaterial({ color: 0x202028, transparent: true, opacity: 0.75, depthWrite: false }));
    this.barChip = new THREE.Mesh(new THREE.PlaneGeometry(1.16, 0.09),
      new THREE.MeshBasicMaterial({ color: 0xf2f2f2, depthWrite: false }));
    this.barChip.position.z = 0.001;
    this.barFg = new THREE.Mesh(new THREE.PlaneGeometry(1.16, 0.09),
      new THREE.MeshBasicMaterial({ color: 0xd83848, depthWrite: false }));
    this.barFg.position.z = 0.002;
    this.bar = new THREE.Group();
    this.bar.add(barBg, this.barChip, this.barFg);
    this.bar.position.y = 2.45;
    this.bar.visible = false;

    g.add(this.body, this.headGrp, cloth,
      this.legL, this.legR, this.armL, this.armR, this.alertMark, this.qMark, this.bar);
    for (const sp of spikes) g.add(sp);
    if (cap) g.add(cap);
    if (this.tough) g.scale.setScalar(1.15);

    // cache material lists once — no per-frame traverse/closure allocations
    const mats = new Set();
    g.traverse(o => {
      if (o.isMesh) o.castShadow = true;
      if (o.isMesh && o.material) mats.add(o.material);
    });
    barBg.castShadow = this.barChip.castShadow = this.barFg.castShadow = false;
    this.fadeMats = [...mats];
    this.fadeBaseOpacity = this.fadeMats.map(m => m.opacity);
    this.fadeBaseTransparent = this.fadeMats.map(m => m.transparent);
    this.glowMats = this.fadeMats.filter(m => m.emissive);

    this.group = g;
    g.position.copy(this.pos);
    G.scene.add(g);

    // swap in the Blender-authored boglin once its GLB lands (shared cached
    // load across the whole camp); the procedural body above is the fallback
    preloadModels(['boglin']).then(res => {
      if (res && res.boglin && !this.dead) this.upgradeModel();
    }).catch(() => {});
  }

  // Replace the procedural parts with the Blender model's named parts.
  // Each part is wrapped in a holder Group that owns the pivot position and
  // receives animate()'s rotation writes — the GLB node inside keeps the
  // exporter's baked axis-conversion quaternion, which a raw rotation.x
  // assignment would otherwise destroy.
  upgradeModel() {
    const root = propInstance('boglin');
    if (!root) return;
    const inner = new THREE.Group();
    inner.rotation.y = Math.PI; // authored facing -Z -> game faces +Z
    const take = (name) => {
      const node = root.getObjectByName(name);
      if (!node) return null;
      const holder = new THREE.Group();
      holder.position.copy(node.position);
      node.position.set(0, 0, 0);
      holder.add(node);
      inner.add(holder);
      return holder;
    };
    const body = take('body'), head = take('head');
    const armL = take('armL'), armR = take('armR');
    const legL = take('legL'), legR = take('legR');
    if (!body || !head || !armL || !armR || !legL || !legR) return; // keep procedural
    const club = root.getObjectByName('club');
    if (this.moss) {
      if (club && club.parent) club.parent.remove(club); // lobbers carry no club
    } else if (club) {
      const rel = club.position.clone().sub(armR.position);
      club.position.set(0, 0, 0);
      const ch = new THREE.Group();
      ch.position.copy(rel);
      ch.add(club);
      armR.add(ch);
    }
    // strip the procedural body; the markers and health bar stay
    const keep = new Set([this.alertMark, this.qMark, this.bar]);
    for (const c of [...this.group.children]) if (!keep.has(c)) this.group.remove(c);
    this.group.add(inner);
    this.body = body; this.headGrp = head;
    this.armL = armL; this.armR = armR;
    this.legL = legL; this.legR = legR;
    // rebind the material sets driving hit-flash / telegraph / death-fade
    const mats = new Set();
    inner.traverse(o => {
      if (!o.isMesh) return;
      o.castShadow = true;
      (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => mats.add(m));
    });
    this.fadeMats = [...mats];
    this.fadeBaseOpacity = this.fadeMats.map(m => m.opacity);
    this.fadeBaseTransparent = this.fadeMats.map(m => m.transparent);
    this.glowMats = this.fadeMats.filter(m => m.emissive);
    this.eyeMat = this.fadeMats.find(m =>
      m.emissive && m.emissive.r > 0.5 && m.emissive.g > 0.5 && m.emissive.b < 0.5) || this.eyeMat;
    this.knobMat = this.fadeMats.find(m =>
      m.color && m.color.r > 0.7 && m.color.g > 0.3 && m.color.g < 0.6 && m.color.b < 0.25) || null;
    // variant tinting: the model is authored in ember-red; toughs go indigo,
    // moss lobbers go bog-green (only the two reddish skin materials shift)
    if (this.tough || this.moss) {
      const tint = new THREE.Color(this.tough ? 0x4d5ccd : 0x5e8f3f);
      for (const m of this.fadeMats) {
        if (m.color && m.color.r > 0.5 && m.color.g < 0.35 && !m.emissive.getHex()) {
          m.color.lerp(tint, 0.85);
        }
      }
    }
  }

  releaseRock() {
    if (this.rock) { freeRock(this.rock); this.rock = null; }
  }

  releaseDisc() {
    if (this.disc) { freeDisc(this.disc); this.disc = null; }
  }

  setState(s) {
    this.state = s;
    this.stateT = 0;
    this.alertMark.visible = s === 'alert';
    this.qMark.visible = s === 'suspicious';
    if (s === 'alert') G.audio.sfx('alert');
    else if (s === 'orbit') {
      this.orbitDir = Math.random() < 0.5 ? -1 : 1;
      this.orbitFor = 1 + Math.random();
    } else if (s === 'windup' || s === 'leapCrouch' || s === 'throwWind') {
      this.attackHitDone = false;
      G.audio.sfx('windup');
    } else if (s === 'strike') {
      G.audio.sfx('clubswing');
    }
  }

  hurt(dmg, fromPos) {
    if (this.dead) return;
    this.hp -= dmg;
    this.flashT = 0.15;
    this.hitstopT = 0.08;      // brief hit-stop: animation/movement freeze
    this.staggerT = 0.35;
    this.barTimer = 0;
    this.chipHold = 0.3;
    const combo = G.player ? G.player.combo : 0;
    // knockback scales with the player's combo index
    tmp1.set(this.pos.x - fromPos.x, 0, this.pos.z - fromPos.z).normalize();
    this.pos.addScaledVector(tmp1, 0.55 + combo * 0.45);
    G.audio.sfx('hit');
    spawnSparkle(this.pos.x, this.pos.y + 1.2, this.pos.z, 0xffd0a0, 10, 3);
    if (this.hp <= 0) { this.die(); return; }
    if (combo === 2 && this.state !== 'down' && this.state !== 'leap') {
      // 3rd combo hit knocks the boglin flat
      this.releaseRock();
      this.releaseDisc();
      this.setState('down');
    } else if (this.state === 'windup' || this.state === 'throwWind' || this.state === 'leapCrouch') {
      // FAIRNESS: a hit during any telegraph cancels the attack outright
      this.releaseRock();
      this.setState('backstep');
    } else if (this.state === 'idle' || this.state === 'suspicious' || this.state === 'return') {
      this.setState('alert');
    }
  }

  die() {
    this.dead = true;    // combat/lock-on ignores it immediately
    this.dying = true;   // ...but the body tumbles, sinks and fades first
    this.dyingT = 0;
    this.dieSpin = Math.random() < 0.5 ? -1 : 1;
    this.releaseRock();
    this.releaseDisc();
    this.bar.visible = false;
    this.alertMark.visible = false;
    this.qMark.visible = false;
    for (let i = 0; i < this.fadeMats.length; i++) this.fadeMats[i].transparent = true;
    G.audio.sfx('die');
  }

  dropLoot() {
    const x = this.pos.x, y = this.pos.y + 0.6, z = this.pos.z;
    if (this.tough) {          // 2 gems + guaranteed heart, sometimes an ancient gear
      addPickup('gem', x - 0.5, y, z);
      addPickup('gem', x + 0.5, y, z + 0.3);
      addPickup('heart', x, y, z - 0.4);
      if (Math.random() < 0.2) { // the bruisers scavenge the old sky-works
        G.items.gear = (G.items.gear || 0) + 1;
        markSeen('gear');
        spawnSparkle(x, y + 0.6, z, 0xc09a50, 18, 3);
        G.ui.toast('Ancient Gear — a relic of the sky-works', 0xc09a50, 3600);
        G.audio.sfx('glimmer');
        save();
      }
    } else if (this.moss) {    // apple + gem
      addPickup('apple', x - 0.4, y, z);
      addPickup('gem', x + 0.4, y, z);
    } else {                   // heart 40 / gem 30 / apple 20 / nothing 10
      const roll = Math.random();
      if (roll < 0.4) addPickup('heart', x, y, z);
      else if (roll < 0.7) addPickup('gem', x, y, z);
      else if (roll < 0.9) addPickup('apple', x, y, z);
    }
  }

  updateDying(dt) {
    this.dyingT += dt;
    const t = this.dyingT;
    const g = this.group;
    g.rotation.x = -Math.min(1, t / 0.3) * 1.45;                 // tumble over
    g.rotation.z = this.dieSpin * Math.min(1, t / 0.5) * 0.45;
    if (t > 0.25) g.position.y = this.pos.y - (t - 0.25) * 1.3;  // sink
    const k = clamp(1 - t / 0.8, 0, 1);                          // fade
    for (let i = 0; i < this.fadeMats.length; i++) {
      this.fadeMats[i].opacity = this.fadeBaseOpacity[i] * k;
    }
    if (t >= 0.8) {
      this.dying = false;
      G.scene.remove(g);
      spawnSparkle(this.pos.x, this.pos.y + 1, this.pos.z,
        this.tough ? 0x8a9aff : this.moss ? 0x9adf70 : 0xff9a70, 40, 6);
      G.audio.sfx('poof');
      this.dropLoot();
    }
  }

  tryMove(dx, dz) { // returns false when blocked by water or a cliff wall
    slideStep(this.pos, this.pos.y, dx, dz, _slide);
    const nh = heightAt(_slide.x, _slide.z);
    if (nh > WATER_Y + 0.2 && nh < this.pos.y + 1.6) {
      this.pos.x = _slide.x; this.pos.z = _slide.z;
      return true;
    }
    return false;
  }

  faceYaw(x, z) { this.yaw = Math.atan2(x - this.pos.x, z - this.pos.z); }

  startLeap(p) {
    const tx = p.x, tz = p.z, ty = heightAt(tx, tz);
    if (ty < WATER_Y + 0.25) { this.leapCd = 3; this.setState('chase'); return; }
    const T = this.leapT = 0.62;
    this.leapTx = tx; this.leapTy = ty; this.leapTz = tz;
    this.lvx = (tx - this.pos.x) / T;
    this.lvz = (tz - this.pos.z) / T;
    this.lvy = (ty - this.pos.y) / T + 0.5 * 22 * T;
    this.disc = acquireDisc();
    if (this.disc) {
      this.disc.mesh.position.set(tx, ty + 0.06, tz);
      this.disc.mesh.scale.setScalar(0.5);
    }
    G.audio.sfx('jump');
    this.setState('leap');
  }

  launchRock(p) {
    const r = this.rock;
    this.rock = null;
    r.held = false;
    r.t = 0;
    const sx = this.pos.x + Math.sin(this.yaw) * 0.2;
    const sz = this.pos.z + Math.cos(this.yaw) * 0.2;
    const sy = this.pos.y + 2.45;
    const tx = p.x, tz = p.z, ty = heightAt(tx, tz);
    const T = clamp(Math.hypot(tx - sx, tz - sz) / 12, 0.65, 1.15);
    r.x = sx; r.y = sy; r.z = sz;
    r.tx = tx; r.ty = ty; r.tz = tz; r.T = T;
    r.vx = (tx - sx) / T;
    r.vz = (tz - sz) / T;
    r.vy = (ty - sy) / T + 0.5 * 20 * T;
    const m = r.mesh.material;
    m.emissive.setHex(0x000000); m.emissiveIntensity = 0;
    r.marker.visible = true;
    r.marker.position.set(tx, ty + 0.06, tz);
    G.audio.sfx('clubswing');
    this.throwCd = 2.8 + Math.random() * 1.4;
    this.afterRecover = 'chase';
    this.setState('recover');
  }

  update(dt) {
    if (this.dying) { this.updateDying(dt); return; }
    if (this.dead) return;
    const p = G.player.pos;
    const distToPlayer = Math.hypot(p.x - this.pos.x, p.z - this.pos.z);

    // don't bother updating far-away enemies (release any held pool item first)
    if (distToPlayer > 120) { this.releaseRock(); this.releaseDisc(); return; }

    this.flashT = Math.max(0, this.flashT - dt);
    this.updateGlow();
    this.updateBar(distToPlayer, dt);
    if (this.hitstopT > 0) { this.hitstopT -= dt; return; } // frozen by hit-stop
    this.staggerT = Math.max(0, this.staggerT - dt);
    this.stateT += dt;

    this.campDoused = !!(this.campFire && this.campFire.doused);
    // Without firelight and drums, hard rain masks the camp's senses. Existing
    // fights continue; only acquisition range shrinks, so weather never erases
    // an enemy that already committed to the player.
    const rainQuiet = nightNow && this.campDoused ? 1 : 0;
    const aggroR = (nightNow ? 30 : 22) * (1 - rainQuiet * 0.35);
    const speedBase = this.tough ? 5.0 : 4.4;
    const pl = G.player;
    const s = this.state;
    let moveSpeed = 0;
    let blocked = false;

    if (this.staggerT > 0 && s !== 'down' && s !== 'leap') {
      // stagger: frozen briefly (already-cancelled attacks were handled in hurt;
      // a mid-air leap keeps flying — freezing it in the air would look broken)
    } else if (s === 'idle') {
      if (this.stateT > 2.5) {
        this.stateT = 0;
        const a = Math.random() * Math.PI * 2;
        if (nightNow && !this.campDoused) { // gather only around a living fire
          this.wanderTarget.set(this.camp.x + Math.cos(a) * (1.8 + Math.random() * 2),
            this.camp.y + Math.sin(a) * (1.8 + Math.random() * 2));
        } else {
          this.wanderTarget.set(this.home.x + Math.cos(a) * 9, this.home.y + Math.sin(a) * 9);
        }
      }
      const dx = this.wanderTarget.x - this.pos.x, dz = this.wanderTarget.y - this.pos.z;
      if (Math.hypot(dx, dz) > 1) {
        this.yaw = Math.atan2(dx, dz);
        moveSpeed = 1.3;
        this.tryMove(Math.sin(this.yaw) * moveSpeed * dt, Math.cos(this.yaw) * moveSpeed * dt);
      }
      if (!G.gameOver) this.checkAggro(p, distToPlayer, aggroR, pl);
    } else if (s === 'suspicious') {
      // "?" — heard something; look around for a second
      this.yaw += Math.cos(this.stateT * 5) * 2.2 * dt;
      if (this.stateT > 1) {
        if (distToPlayer < aggroR && !G.gameOver) this.setState('alert');
        else this.setState('idle');
      }
    } else if (s === 'alert') {
      this.faceYaw(p.x, p.z);
      if (this.stateT > 0.55) this.setState('chase');
    } else if (s === 'return') {
      // walk home and shake it off; heal to full on arrival
      const dx = this.home.x - this.pos.x, dz = this.home.y - this.pos.z;
      if (Math.hypot(dx, dz) < 1.5) {
        this.hp = this.maxHp;
        this.setState('idle');
      } else {
        this.yaw = Math.atan2(dx, dz);
        moveSpeed = 2.4;
        this.tryMove(Math.sin(this.yaw) * moveSpeed * dt, Math.cos(this.yaw) * moveSpeed * dt);
      }
      if (distToPlayer < aggroR * 0.7 && !G.gameOver) this.setState('alert');
    } else if (s === 'chase') {
      this.commitT = Math.max(0, this.commitT - dt);
      if (G.gameOver || distToPlayer > 45) {
        this.frustration = 0;
        this.setState('return');
      } else if (this.moss) {
        moveSpeed = this.updateKite(p, distToPlayer, dt);
      } else if (this.tickLeap(p, distToPlayer, dt)) {
        // leap crouch started
      } else if (distToPlayer < 2.3) {
        this.setState('windup');
      } else if (distToPlayer < 6 && this.commitT <= 0) {
        this.setState('orbit');
      } else {
        this.faceYaw(p.x, p.z);
        moveSpeed = speedBase;
        blocked = !this.tryMove(Math.sin(this.yaw) * moveSpeed * dt, Math.cos(this.yaw) * moveSpeed * dt);
      }
    } else if (s === 'orbit') {
      // circle-strafe: pick a direction, close in after 1-2s or when attacked
      this.faceYaw(p.x, p.z);
      if (G.gameOver || distToPlayer > 45) {
        this.setState('return');
      } else if (this.tickLeap(p, distToPlayer, dt)) {
        // leap crouch started
      } else if (distToPlayer > 9) {
        this.setState('chase');
      } else if (distToPlayer < 2.0) {
        this.setState('windup'); // player pushed in — punish
      } else if (this.stateT > this.orbitFor ||
        (pl.attackT >= 0 && pl.attackT < 0.1 && distToPlayer < 5)) {
        this.commitT = 3;
        this.setState('chase');
      } else {
        // tangential drift + gentle radial correction toward ~5m
        const inv = 1 / Math.max(0.001, distToPlayer);
        const rx = (this.pos.x - p.x) * inv, rz = (this.pos.z - p.z) * inv;
        const radial = clamp(distToPlayer - 5.2, -1, 1) * -1.4;
        const vx = -rz * this.orbitDir * 2.8 + rx * radial;
        const vz = rx * this.orbitDir * 2.8 + rz * radial;
        moveSpeed = 2.8;
        if (!this.tryMove(vx * dt, vz * dt)) this.orbitDir *= -1;
      }
    } else if (s === 'windup') {
      // 0.55s crouch, club raised high, club/eyes pulsing — THE tell
      this.faceYaw(p.x, p.z);
      if (this.stateT > 0.55) this.setState('strike');
    } else if (s === 'strike') {
      // short lunge step, then the existing arc damage window
      if (this.stateT < 0.15) {
        this.tryMove(Math.sin(this.yaw) * 6 * dt, Math.cos(this.yaw) * 6 * dt);
      }
      if (this.stateT > 0.1 && !this.attackHitDone) {
        this.attackHitDone = true;
        tmp2.set(p.x - this.pos.x, 0, p.z - this.pos.z);
        const d = tmp2.length();
        const vertical = Math.abs(p.y - this.pos.y);
        const facing = d > 0.001 ? (tmp2.x / d) * Math.sin(this.yaw) + (tmp2.z / d) * Math.cos(this.yaw) : 1;
        if (d < 2.8 && vertical < 1.45 && facing > 0.1) {
          if (G.player.iframes <= 0) G.hitStopT = Math.max(G.hitStopT, 0.09); // melee connects both ways
          G.player.damage(this.tough ? 4 : 2, this.pos.x, this.pos.z);
          G.camShake += 0.15;
        }
        // the club smashes the ground in front: dust burst + thud
        const gx = this.pos.x + Math.sin(this.yaw) * 1.3;
        const gz = this.pos.z + Math.cos(this.yaw) * 1.3;
        spawnSparkle(gx, heightAt(gx, gz) + 0.2, gz, 0xcbb896, this.tough ? 12 : 7, 3.2);
        G.audio.sfx('thud');
      }
      if (this.stateT > 0.3) {
        this.afterRecover = 'backstep';
        this.setState('recover');
      }
    } else if (s === 'recover') {
      // 0.5s vulnerable pause with heavy breathing
      if (this.stateT > 0.5) {
        if (this.afterRecover === 'chase') this.setState('chase');
        else this.setState('backstep');
      }
    } else if (s === 'backstep') {
      moveSpeed = 0; // legs don't run — it's a hop
      this.tryMove(-Math.sin(this.yaw) * 5 * dt, -Math.cos(this.yaw) * 5 * dt);
      if (this.stateT > 0.35) {
        if (G.gameOver) this.setState('return');
        else if (distToPlayer < 8 && !this.moss) this.setState('orbit');
        else this.setState('chase');
      }
    } else if (s === 'down') {
      // knocked flat by the combo finisher; gets back up
      if (this.stateT > 1.2) {
        this.group.rotation.x = 0;
        this.setState(G.gameOver ? 'return' : 'chase');
      }
    } else if (s === 'leapCrouch') {
      // tough: 0.7s crouch telegraph before the slam leap
      this.faceYaw(p.x, p.z);
      if (this.stateT > 0.7) this.startLeap(p);
    } else if (s === 'leap') {
      this.lvy -= 22 * dt;
      this.pos.x += this.lvx * dt;
      this.pos.y += this.lvy * dt;
      this.pos.z += this.lvz * dt;
      if (this.disc) { // shadow grows at the landing spot during flight
        this.disc.mesh.scale.setScalar(0.5 + (this.stateT / this.leapT) * 2.3);
      }
      if (this.stateT >= this.leapT) this.landSlam(p);
    } else if (s === 'throwWind') {
      // moss: raise the rock overhead, glowing, for 0.7s
      this.faceYaw(p.x, p.z);
      if (this.rock) {
        this.rock.mesh.position.set(
          this.pos.x + Math.sin(this.yaw) * 0.2,
          this.pos.y + 2.45,
          this.pos.z + Math.cos(this.yaw) * 0.2);
        const m = this.rock.mesh.material;
        m.emissive.setHex(0xffc060);
        m.emissiveIntensity = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(G.time * 26));
      }
      if (this.stateT > 0.7) {
        if (this.rock) this.launchRock(p);
        else { this.throwCd = 1; this.setState('chase'); }
      }
    }

    // unreachable-player de-aggro: blocked pathing or player perched high up
    if (s === 'chase' || s === 'orbit') {
      if (blocked || (distToPlayer < 12 && p.y > this.pos.y + 5)) this.frustration += dt;
      else this.frustration = Math.max(0, this.frustration - dt * 2);
      if (this.frustration > 6) {
        this.frustration = 0;
        this.setState('return');
      }
    }

    if (this.state !== 'leap') this.pos.y = heightAt(this.pos.x, this.pos.z);
    this.animate(dt, moveSpeed);
  }

  checkAggro(p, dist, aggroR, pl) {
    tmp2.set(p.x - this.pos.x, 0, p.z - this.pos.z);
    const d = tmp2.length();
    const facing = d > 0.001 ? (tmp2.x / d) * Math.sin(this.yaw) + (tmp2.z / d) * Math.cos(this.yaw) : 1;
    if (dist < aggroR && (facing > 0.15 || dist < 8)) {
      this.setState('alert');
    } else if (dist < 14 && facing <= 0.15 && pl.mode === 'ground' &&
      pl.vel.x * pl.vel.x + pl.vel.z * pl.vel.z > 49) {
      // heard sprinting footsteps behind it
      this.setState('suspicious');
    }
  }

  tickLeap(p, dist, dt) {
    if (!this.tough) return false;
    if (dist < 12) this.leapCd -= dt;
    if (this.leapCd <= 0 && dist < 12 && dist > 3) {
      this.setState('leapCrouch');
      return true;
    }
    return false;
  }

  landSlam(p) {
    this.pos.set(this.leapTx, this.leapTy, this.leapTz);
    this.releaseDisc();
    const d = Math.hypot(p.x - this.leapTx, p.z - this.leapTz);
    spawnRing(this.leapTx, this.leapTy + 0.12, this.leapTz);
    spawnSparkle(this.leapTx, this.leapTy + 0.4, this.leapTz, 0xb9a888, 20, 5);
    if (d < 3 && Math.abs(p.y - this.leapTy) < 2.1) {
      if (G.player.iframes <= 0) G.hitStopT = Math.max(G.hitStopT, 0.09);
      G.player.damage(4, this.leapTx, this.leapTz);
    }
    if (d < 15) G.camShake += 0.5;
    G.audio.sfx('slam');
    this.leapCd = 7;
    this.afterRecover = 'backstep';
    this.setState('recover');
  }

  updateKite(p, dist, dt) { // moss boglin: hold 10-16m and lob rocks
    this.faceYaw(p.x, p.z);
    this.throwCd -= dt;
    let moveSpeed = 0;
    if (dist > 16) {
      moveSpeed = 4.2;
      this.tryMove(Math.sin(this.yaw) * moveSpeed * dt, Math.cos(this.yaw) * moveSpeed * dt);
    } else if (dist < 10) {
      moveSpeed = 4.6;
      if (!this.tryMove(-Math.sin(this.yaw) * moveSpeed * dt, -Math.cos(this.yaw) * moveSpeed * dt)) {
        // cornered — sidestep instead
        const inv = 1 / Math.max(0.001, dist);
        const rx = (this.pos.x - p.x) * inv, rz = (this.pos.z - p.z) * inv;
        if (!this.tryMove(-rz * this.orbitDir * moveSpeed * dt, rx * this.orbitDir * moveSpeed * dt)) {
          this.orbitDir *= -1;
        }
      }
    } else {
      const inv = 1 / Math.max(0.001, dist);
      const rx = (this.pos.x - p.x) * inv, rz = (this.pos.z - p.z) * inv;
      moveSpeed = 2.0;
      if (!this.tryMove(-rz * this.orbitDir * 2.0 * dt, rx * this.orbitDir * 2.0 * dt)) {
        this.orbitDir *= -1;
      }
    }
    if (this.throwCd <= 0 && dist > 7 && dist < 20) {
      this.rock = acquireRock();
      if (this.rock) this.setState('throwWind');
      else this.throwCd = 1; // pool exhausted — try again shortly
    }
    return moveSpeed;
  }

  // ---- presentation (procedural placeholder — swapped for AnimationMixer
  // clips when the rigged models land in a later wave) --------------------
  animate(dt, moveSpeed) {
    const g = this.group;
    g.position.copy(this.pos);
    g.rotation.y = this.yaw;
    const t = G.time;
    const s = this.state;

    // whole-body lean: knockdown tumble, wind-up anticipation (rock back),
    // strike commit (lunge forward). rotation.order is YXZ so x = fwd/back tilt.
    if (s === 'down') {
      const dtn = this.stateT;
      let tilt;
      if (dtn < 0.35) tilt = -(dtn / 0.35) * 1.4;
      else if (dtn < 0.85) tilt = -1.4;
      else tilt = -1.4 * (1 - (dtn - 0.85) / 0.35);
      g.rotation.x = tilt;
    } else if (s === 'windup' || s === 'leapCrouch' || s === 'throwWind') {
      g.rotation.x = lerp(g.rotation.x, -0.24, Math.min(1, dt * 10)); // coil back
    } else if (s === 'strike') {
      g.rotation.x = lerp(g.rotation.x, 0.3, Math.min(1, dt * 24));   // lunge into it
    } else {
      g.rotation.x = lerp(g.rotation.x, 0, Math.min(1, dt * 10));
    }
    g.rotation.z = 0;

    // head: idle sway, rear back on wind-up, thrust down through the strike, pant on recover
    if (this.headGrp) {
      let hx;
      if (s === 'windup' || s === 'leapCrouch') hx = -0.32;
      else if (s === 'strike') hx = 0.42;
      else if (s === 'recover') hx = 0.18 + Math.sin(t * 9) * 0.06;
      else if (s === 'down') hx = 0.3;
      else hx = Math.sin(t * 2.4 + 1) * 0.05;
      this.headGrp.rotation.x = lerp(this.headGrp.rotation.x, hx, Math.min(1, dt * 12));
    }

    // legs + body bob
    if (s === 'leap') {
      this.legL.rotation.x = this.legR.rotation.x = 1.1; // tucked
      this.body.position.y = 0.85;
      this.body.scale.y = 1.15;
    } else if (moveSpeed > 0) {
      const f = t * (4 + moveSpeed);
      this.legL.rotation.x = Math.sin(f) * 0.6;
      this.legR.rotation.x = -Math.sin(f) * 0.6;
      this.body.position.y = 0.85 + Math.abs(Math.sin(f)) * 0.08;
      this.body.scale.y = 1.15;
    } else if (s === 'windup' || s === 'leapCrouch') {
      // crouched, coiled — reads as "about to swing"
      this.legL.rotation.x = 0.55; this.legR.rotation.x = -0.55;
      this.body.position.y = 0.62;
      this.body.scale.y = 1.0;
    } else if (s === 'recover') {
      // heavy breathing: exaggerated bob while vulnerable
      this.legL.rotation.x = this.legR.rotation.x = 0.15;
      this.body.position.y = 0.76 + Math.sin(t * 9) * 0.07;
      this.body.scale.y = 1.05 + Math.sin(t * 9) * 0.05;
    } else if (s === 'backstep') {
      this.legL.rotation.x = -0.4; this.legR.rotation.x = 0.4;
      this.body.position.y = 0.85 + Math.sin(Math.PI * Math.min(1, this.stateT / 0.35)) * 0.16;
      this.body.scale.y = 1.15;
    } else {
      this.legL.rotation.x = this.legR.rotation.x = 0;
      this.body.position.y = 0.85 + Math.sin(t * 2.5) * 0.03;
      this.body.scale.y = 1.15;
    }

    // club arm: anticipation (cocked & quivering) -> accelerating overhead slam
    // that overshoots -> follow-through settle. torso twist adds weight.
    let armRTarget, armRSpeed;
    if (s === 'windup' || s === 'throwWind') {
      armRTarget = -2.85 - Math.sin(t * 20) * 0.05; armRSpeed = dt * 11; // cocked, trembling
    } else if (s === 'leapCrouch') {
      armRTarget = -2.5; armRSpeed = dt * 12;
    } else if (s === 'strike') {
      const k = Math.min(1, this.stateT / 0.28);
      armRTarget = -2.4 + k * k * 3.75;  // eased-in accelerating chop, overshoots to ~1.35
      armRSpeed = dt * 34;
    } else if (s === 'leap') {
      armRTarget = -2.2; armRSpeed = dt * 10;
    } else {
      armRTarget = Math.sin(t * 2.5) * 0.1 - 0.2; armRSpeed = dt * 6;
    }
    this.armR.rotation.x = lerp(this.armR.rotation.x, armRTarget, Math.min(1, armRSpeed));
    this.armR.rotation.z = lerp(this.armR.rotation.z,
      s === 'strike' ? -0.28 : (s === 'windup' ? 0.22 : 0), Math.min(1, dt * 14));
    // off-hand: swings with the gait, flails up during a leap, braces on strike
    const armLTarget = s === 'leap' ? -2.2
      : s === 'strike' ? 0.6
      : moveSpeed > 0 ? Math.sin(t * 6) * 0.4 : Math.sin(t * 2.4) * 0.06;
    this.armL.rotation.x = lerp(this.armL.rotation.x, armLTarget, Math.min(1, dt * 12));

    this.alertMark.rotation.y = t * 3;
    if (this.qMark.visible) this.qMark.rotation.y = Math.sin(t * 4) * 0.6;
  }

  updateGlow() {
    // white damage flash (cached material list — no traverse, no closures)
    const flash = this.flashT > 0;
    for (let i = 0; i < this.glowMats.length; i++) {
      const m = this.glowMats[i];
      m.emissive.setHex(flash ? 0xffffff : 0x000000);
      m.emissiveIntensity = flash ? 0.3 : 0;
    }
    // telegraph pulse: club knob + eyes brighten during any windup
    const tele = this.state === 'windup' || this.state === 'leapCrouch' || this.state === 'throwWind';
    if (tele && !flash) {
      const pulse = 0.5 + 0.5 * Math.sin(G.time * 26);
      if (this.knobMat) {
        this.knobMat.emissive.setHex(0xff6a2a);
        this.knobMat.emissiveIntensity = 0.35 + pulse * 0.65;
      }
      this.eyeMat.color.setRGB(1, 0.88 + 0.12 * pulse, 0.4 + 0.6 * pulse);
    } else if (!flash) {
      this.eyeMat.color.setHex(0xffe066);
    }
  }

  updateBar(distToPlayer, dt) {
    // "in combat" keeps the bar alive; it hides 4s after combat ends
    const fighting = this.state !== 'idle' && this.state !== 'suspicious' && this.state !== 'return';
    if (fighting) this.barTimer = 0;
    else this.barTimer += dt;
    // white damage chip drains toward the true fraction after a short hold
    const frac = clamp(this.hp / this.maxHp, 0, 1);
    if (this.chipHold > 0) this.chipHold -= dt;
    else this.dispFrac = Math.max(frac, this.dispFrac - dt * 1.1);

    this.bar.visible = this.hp < this.maxHp && distToPlayer < 30 && this.barTimer < 4;
    if (!this.bar.visible) return;
    this.bar.quaternion.copy(G.camera.quaternion);
    this.bar.rotation.z = 0;
    this.barFg.scale.x = Math.max(frac, 0.0001);
    this.barFg.position.x = -(1 - frac) * 0.58;
    const chipW = this.dispFrac - frac;
    this.barChip.visible = chipW > 0.005;
    if (this.barChip.visible) {
      this.barChip.scale.x = chipW;
      this.barChip.position.x = -0.58 + (frac + this.dispFrac) * 0.58;
    }
  }
}

// ---------------------------------------------------------------- hollows
// Rigged KayKit skeletons driven by an AnimationMixer each. Three variants:
//   MINION  — fast rattling chaff, 1H horizontal slice
//   WARRIOR — blade + shield; parries frontal hits while Blocking, 0.8s
//             vulnerable recover after its own swing, drops 2 gems
//   MAGE    — kites at 12-18m, lobs pooled neon bolts with a marked landing,
//             sidesteps approaches and blinks 6m backward when crowded
// All fairness rules carry over: every attack has a readable wind-up and any
// hit landed during a wind-up cancels it.

const HOLLOW_STATS = {
  minion: {
    model: 'skeleton_minion', height: 1.7, hp: 3, speed: 5.2, radius: 0.7,
    range: 2.2, dmg: 2, recover: 0.45, attackClip: '1H_Melee_Attack_Slice_Horizontal',
  },
  warrior: {
    model: 'skeleton_warrior', height: 1.9, hp: 8, speed: 3.6, radius: 0.85,
    range: 2.4, dmg: 4, recover: 0.8, attackClip: '1H_Melee_Attack_Chop',
  },
  mage: {
    model: 'skeleton_mage', height: 1.7, hp: 4, speed: 4.2, radius: 0.7,
    range: 2.0, dmg: 2, recover: 0.5, attackClip: '1H_Melee_Attack_Chop',
  },
};

// vault ruins get standing garrisons (day AND night); the storm-dead linger
// among three more ruin sites — 11 Hollows total
const HOLLOW_SITES = [
  { x: 109, z: 120, squad: ['warrior', 'minion', 'minion'] },   // Thornwood vault
  { x: -150, z: -100, squad: ['warrior', 'minion', 'minion'] }, // western vault
  { x: 30, z: 95, squad: ['mage', 'minion', 'minion'] },        // old ring ruin
  { x: 205, z: 25, squad: ['mage'] },                           // lone storm-caller
  { x: -95, z: 165, squad: ['mage'] },                          // lone storm-caller
];

const HOLLOW_CLIPS = {
  idle: 'Idle_Combat', walk: 'Walking_D_Skeletons', run: 'Running_C',
  walkBack: 'Walking_Backwards', strafeL: 'Running_Strafe_Left',
  strafeR: 'Running_Strafe_Right', hit: 'Hit_A', death: 'Death_C_Skeletons',
  awaken: 'Skeletons_Awaken_Floor', block: 'Blocking', blockHit: 'Block_Hit',
  dodgeL: 'Dodge_Left', dodgeR: 'Dodge_Right',
  cast: 'Spellcast_Shoot', raise: 'Spellcast_Raise',
};
const HOLLOW_LOOPING = {
  idle: true, walk: true, run: true, walkBack: true,
  strafeL: true, strafeR: true, block: true,
};

const BLINK_TRIES = [0, 0.55, -0.55, 1.2, -1.2]; // yaw offsets tried for a blink spot
const hollowScaleCache = {}; // model name -> uniform scale to target height
let gearGeo = null;          // shared weapon geometry (built once)

function initGearGeo() {
  if (gearGeo) return;
  gearGeo = {
    grip: new THREE.CylinderGeometry(0.035, 0.05, 0.26, 6),
    guard: new THREE.BoxGeometry(0.26, 0.06, 0.09),
    blade: new THREE.BoxGeometry(0.1, 0.9, 0.035),
    bladeShort: new THREE.BoxGeometry(0.11, 0.62, 0.04),
    shield: new THREE.CylinderGeometry(0.4, 0.4, 0.07, 12),
    boss: new THREE.SphereGeometry(0.1, 8, 6),
    staff: new THREE.CylinderGeometry(0.04, 0.055, 1.55, 7),
    crystal: new THREE.OctahedronGeometry(0.15, 0),
  };
}

// convert one glTF material to the game's toon look, keeping the KayKit
// palette texture; the 'Glow' eye material burns storm-green instead
function hollowToonMat(src) {
  const m = new THREE.MeshToonMaterial({
    map: src.map || null, gradientMap: toonGradient,
  });
  if (src.color) m.color.copy(src.color);
  if (/glow/i.test(src.name || '')) {
    m.emissive.setHex(0x3dff7c);
    m.emissiveIntensity = 1.0;
  } else if (src.emissive) {
    m.emissive.copy(src.emissive);
  }
  return rimToon(m, 0.22);
}

class Hollow {
  constructor(x, z, kind) {
    const st = HOLLOW_STATS[kind];
    this.isHollow = true;
    this.kind = kind;
    this.home = new THREE.Vector2(x, z);
    this.pos = new THREE.Vector3(x, heightAt(x, z), z);
    this.yaw = hash2(x | 0, z | 0, 3) * Math.PI * 2;
    this.hp = this.maxHp = st.hp;
    this.speed = st.speed;
    this.radius = st.radius;
    this.range = st.range;
    this.dmg = st.dmg;
    this.recoverFor = st.recover;
    this.dead = false;
    this.dying = false;
    this.dyingT = 0;
    this.fadeStarted = false;
    this.state = 'idle';
    this.stateT = 0;
    this.wanderTarget = new THREE.Vector2(x, z);
    this.orbitDir = Math.random() < 0.5 ? -1 : 1;
    this.frustration = 0;
    this.flashT = 0;
    this.hitstopT = 0;
    this.attackCd = 0;
    this.attackDur = 1;
    this.attackHitAt = 0.45;
    this.attackHitDone = false;
    this.castCd = 1.5;
    this.castDur = 1.1;
    this.castFireAt = 0.55;
    this.castFired = false;
    this.blinkCd = 2;
    this.dodgeCd = 1;
    this.dodgeDir = 1;
    this.rattleT = 2 + Math.random() * 3;
    this.awakenDur = 2;
    this.awakenPuffed = false;
    this.nightRespawnUsed = false;
    this.curAct = null;
    // health-bar damage chip (same look as boglins)
    this.dispFrac = 1;
    this.chipHold = 0;
    this.barTimer = 99;
    this.buildModel(st);
    this.setState('awaken'); // SPAWNING IS THE SHOWPIECE: rise from the ground
    // settle the first awaken frame now (past the fade-in) so a Hollow seen
    // from beyond the 120m AI-sleep radius is a bone pile, never a T-pose
    this.mixer.update(0.1);
  }

  buildModel(st) {
    initGearGeo();
    const inst = instantiate(st.model);
    const root = inst.root;
    root.updateMatrixWorld(true);
    // uniform scale to the target silhouette height (measured once per model)
    let sc = hollowScaleCache[st.model];
    if (!sc) {
      tmpBox.setFromObject(root);
      sc = hollowScaleCache[st.model] =
        st.height / Math.max(0.001, tmpBox.max.y - tmpBox.min.y);
    }
    root.scale.setScalar(sc);

    // toon conversion — per-Hollow materials so hit-flash and death-fade
    // never bleed onto siblings sharing the source GLB materials
    const conv = new Map();
    const mats = [];
    let handR = null, handL = null;
    const convert = (src) => {
      let m = conv.get(src);
      if (!m) { m = hollowToonMat(src); conv.set(src, m); mats.push(m); }
      return m;
    };
    root.traverse(o => {
      // GLTFLoader strips '.' from node names: handslot.l -> handslotl
      const n = o.name ? o.name.toLowerCase() : '';
      if (o.isBone && n.includes('handslot')) {
        if (n.endsWith('l')) handL = o;
        else if (n.endsWith('r')) handR = o;
      }
      if (o.isMesh) {
        o.castShadow = true;
        if (o.isSkinnedMesh) o.frustumCulled = false;
        if (Array.isArray(o.material)) o.material = o.material.map(convert);
        else o.material = convert(o.material);
      }
    });
    this.buildGear(handR, handL, mats);

    this.fadeMats = mats;
    this.fadeBaseOpacity = mats.map(m => m.opacity);
    this.fadeBaseTransparent = mats.map(m => m.transparent);
    this.glowMats = mats;
    this.baseEmissive = mats.map(m => m.emissive.getHex());
    this.baseEmissiveI = mats.map(m => m.emissiveIntensity);

    const g = new THREE.Group();
    g.add(root);

    // "!" for alert (matches the boglin tell)
    this.alertMark = new THREE.Mesh(
      new THREE.ConeGeometry(0.12, 0.5, 6),
      new THREE.MeshBasicMaterial({ color: 0xff3030 })
    );
    const markY = st.height + 0.8;
    this.alertMark.position.y = markY;
    this.alertMark.rotation.x = Math.PI;
    this.alertMark.visible = false;

    // health bar billboard with white damage-chip segment
    const barBg = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.13),
      new THREE.MeshBasicMaterial({ color: 0x202028, transparent: true, opacity: 0.75, depthWrite: false }));
    this.barChip = new THREE.Mesh(new THREE.PlaneGeometry(1.16, 0.09),
      new THREE.MeshBasicMaterial({ color: 0xf2f2f2, depthWrite: false }));
    this.barChip.position.z = 0.001;
    this.barFg = new THREE.Mesh(new THREE.PlaneGeometry(1.16, 0.09),
      new THREE.MeshBasicMaterial({ color: 0xd83848, depthWrite: false }));
    this.barFg.position.z = 0.002;
    this.bar = new THREE.Group();
    this.bar.add(barBg, this.barChip, this.barFg);
    this.bar.position.y = markY - 0.35;
    this.bar.visible = false;
    g.add(this.alertMark, this.bar);

    this.group = g;
    g.position.copy(this.pos);
    g.rotation.y = this.yaw;
    G.scene.add(g);

    // one mixer per Hollow; only updated within 120m of the player
    this.mixer = new THREE.AnimationMixer(root);
    this.acts = {};
    for (const key in HOLLOW_CLIPS) {
      const clip = findClip(inst.clips, HOLLOW_CLIPS[key]);
      if (!clip) continue;
      const a = this.mixer.clipAction(clip);
      if (!HOLLOW_LOOPING[key]) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
      this.acts[key] = a;
    }
    const atkClip = findClip(inst.clips, st.attackClip);
    if (atkClip) {
      const a = this.mixer.clipAction(atkClip);
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
      this.acts.attack = a;
    }
    if (this.acts.run) this.acts.run.timeScale = this.kind === 'warrior' ? 0.85 : 1.1;
  }

  // ancient magic-tech armaments: oxidized bronze + verdigris + neon crystal
  buildGear(handR, handL, mats) {
    const bronze = toonMat({ color: 0x8a6f3e });
    const verdigris = toonMat({ color: 0x4fa385 });
    mats.push(bronze, verdigris);
    if (this.kind === 'mage') {
      if (handR) {
        const staffGrp = new THREE.Group();
        const staff = new THREE.Mesh(gearGeo.staff, bronze);
        staff.position.y = 0.45;
        const crystalMat = toonMat({ color: 0x1d3a2a });
        crystalMat.emissive.setHex(0x39ff88);
        crystalMat.emissiveIntensity = 1.2;
        mats.push(crystalMat);
        const crystal = new THREE.Mesh(gearGeo.crystal, crystalMat);
        crystal.position.y = 1.32;
        // staff-hand telegraph glow: flares during Spellcast wind-ups
        this.castGlow = makeGlow(0x39ff88, 0.8);
        this.castGlow.position.y = 1.32;
        this.castGlow.visible = false;
        staff.castShadow = crystal.castShadow = true;
        staffGrp.add(staff, crystal, this.castGlow);
        handR.add(staffGrp);
      }
      return;
    }
    if (handR) { // corroded blade — short for minions, long for the warrior
      const blade = new THREE.Group();
      const grip = new THREE.Mesh(gearGeo.grip, bronze);
      const guard = new THREE.Mesh(gearGeo.guard, verdigris);
      guard.position.y = 0.15;
      const edge = new THREE.Mesh(
        this.kind === 'warrior' ? gearGeo.blade : gearGeo.bladeShort, verdigris);
      edge.position.y = 0.15 + (this.kind === 'warrior' ? 0.46 : 0.32);
      grip.castShadow = guard.castShadow = edge.castShadow = true;
      blade.add(grip, guard, edge);
      handR.add(blade);
    }
    if (this.kind === 'warrior' && handL) { // round bronze shield
      const shield = new THREE.Group();
      const face = new THREE.Mesh(gearGeo.shield, bronze);
      face.rotation.x = Math.PI / 2;
      const boss = new THREE.Mesh(gearGeo.boss, verdigris);
      boss.position.z = 0.06;
      face.castShadow = true;
      shield.add(face, boss);
      shield.position.y = 0.08;
      handL.add(shield);
    }
  }

  // crossfade helper: looped clips are left running, one-shots restart
  playAct(name, fade = 0.18) {
    const a = this.acts[name];
    if (!a) return 0;
    if (this.curAct === a) {
      if (HOLLOW_LOOPING[name]) return a.getClip().duration;
      a.reset().play();
      return a.getClip().duration;
    }
    if (this.curAct) this.curAct.fadeOut(fade);
    a.reset().fadeIn(fade).play();
    this.curAct = a;
    return a.getClip().duration;
  }

  faceYaw(x, z) { this.yaw = Math.atan2(x - this.pos.x, z - this.pos.z); }

  tryMove(dx, dz) { // same water/cliff/collider rules as boglins
    slideStep(this.pos, this.pos.y, dx, dz, _slide);
    const nh = heightAt(_slide.x, _slide.z);
    if (nh > WATER_Y + 0.2 && nh < this.pos.y + 1.6) {
      this.pos.x = _slide.x; this.pos.z = _slide.z;
      return true;
    }
    return false;
  }

  setState(s) {
    this.state = s;
    this.stateT = 0;
    this.alertMark.visible = s === 'alert';
    if (s === 'awaken') {
      // rise from the ground: ~2s, invulnerable but harmless
      this.awakenPuffed = false;
      this.awakenDur = this.playAct('awaken', 0.06) || 2.0;
      spawnSparkle(this.pos.x, this.pos.y + 0.25, this.pos.z, 0xb9a888, 16, 2.5);
      G.audio.sfx('bone_rattle');
    } else if (s === 'alert') {
      this.playAct('idle', 0.15);
      G.audio.sfx('bone_rattle');
      G.audio.sfx('alert');
    } else if (s === 'attack') {
      this.attackHitDone = false;
      const dur = this.playAct('attack', 0.1) || 1.0;
      this.attackDur = dur;
      this.attackHitAt = dur * 0.45; // wind-up half — hits here cancel it
      G.audio.sfx('windup');
    } else if (s === 'block') {
      this.playAct('block', 0.1); // shield up — THE readable stance
    } else if (s === 'idle' || s === 'recover') {
      this.playAct('idle', 0.25);
    } else if (s === 'hitreact') {
      this.playAct('hit', 0.05);
    } else if (s === 'windup') {
      // mage Spellcast_Shoot — named 'windup' so combat-music ducking sees it
      this.castFired = false;
      const dur = this.playAct('cast', 0.12) || 1.1;
      this.castDur = Math.min(dur, 1.3);
      this.castFireAt = Math.min(0.55, this.castDur * 0.55);
      G.audio.sfx('windup');
    } else if (s === 'blinkRaise') {
      this.playAct('raise', 0.08);
      G.audio.sfx('windup');
    } else if (s === 'dodge') {
      this.dodgeDir = Math.random() < 0.5 ? -1 : 1;
      this.playAct(this.dodgeDir < 0 ? 'dodgeL' : 'dodgeR', 0.06);
      G.audio.sfx('jump');
    }
    // chase / return pick locomotion clips per-frame
  }

  hurt(dmg, fromPos) {
    if (this.dead) return;
    if (this.state === 'awaken') return; // still knitting together — untouchable
    tmp1.set(fromPos.x - this.pos.x, 0, fromPos.z - this.pos.z);
    const d = tmp1.length();
    const facing = d > 0.001
      ? (tmp1.x / d) * Math.sin(this.yaw) + (tmp1.z / d) * Math.cos(this.yaw) : 1;
    // warrior parry: frontal hits during Block bounce off the shield
    if (this.kind === 'warrior' && this.state === 'block' && facing > 0.2) {
      this.playAct('blockHit', 0.05);
      this.stateT = Math.min(this.stateT, 0.4); // hold the stance a beat longer
      spawnSparkle(
        this.pos.x + Math.sin(this.yaw) * 0.9, this.pos.y + 1.2,
        this.pos.z + Math.cos(this.yaw) * 0.9, 0xbfffd9, 12, 5);
      G.audio.sfx('block');
      G.camShake += 0.08;
      return;
    }
    this.hp -= dmg;
    this.flashT = 0.15;
    this.hitstopT = 0.08;
    this.barTimer = 0;
    this.chipHold = 0.3;
    const combo = G.player ? G.player.combo : 0;
    tmp1.set(this.pos.x - fromPos.x, 0, this.pos.z - fromPos.z).normalize();
    this.pos.addScaledVector(tmp1, (this.kind === 'warrior' ? 0.3 : 0.55) + combo * 0.35);
    G.audio.sfx('hit');
    spawnSparkle(this.pos.x, this.pos.y + 1.2, this.pos.z, 0xe9e4cf, 10, 3);
    if (this.hp <= 0) { this.die(); return; }
    // FAIRNESS: hits during any wind-up (attack pre-hit, cast pre-release,
    // blink raise) cancel it outright; the hit reaction interrupts everything
    if (this.state === 'windup' && !this.castFired) this.castCd = 1.2;
    if (this.state === 'blinkRaise') this.blinkCd = 0.8;
    this.setState('hitreact');
  }

  die() {
    this.dead = true;   // combat/lock-on ignores it immediately
    this.dying = true;  // ...but the bones collapse and rest a while first
    this.dyingT = 0;
    this.fadeStarted = false;
    this.bar.visible = false;
    this.alertMark.visible = false;
    if (this.castGlow) this.castGlow.visible = false;
    this.deathDur = this.playAct('death', 0.08) || 2.0;
    G.audio.sfx('die');
    G.audio.sfx('bone_rattle');
  }

  dropLoot() {
    const x = this.pos.x, y = this.pos.y + 0.6, z = this.pos.z;
    if (this.kind === 'warrior') {        // 2 gems guaranteed
      addPickup('gem', x - 0.5, y, z);
      addPickup('gem', x + 0.5, y, z + 0.3);
    } else if (this.kind === 'mage') {    // gem + heart 35
      addPickup('gem', x, y, z);
      if (Math.random() < 0.35) addPickup('heart', x + 0.5, y, z);
    } else {                              // gem 35 / heart 25 / nothing 40
      const roll = Math.random();
      if (roll < 0.35) addPickup('gem', x, y, z);
      else if (roll < 0.6) addPickup('heart', x, y, z);
    }
  }

  // collapse-to-bone-pile: let Death_C finish, hold the pile 1s, then fade
  updateDying(dt) {
    this.dyingT += dt;
    this.mixer.update(dt);
    const holdEnd = this.deathDur + 1.0;
    if (this.dyingT <= holdEnd) return;
    if (!this.fadeStarted) {
      this.fadeStarted = true;
      for (let i = 0; i < this.fadeMats.length; i++) this.fadeMats[i].transparent = true;
    }
    const k = clamp(1 - (this.dyingT - holdEnd) / 0.7, 0, 1);
    for (let i = 0; i < this.fadeMats.length; i++) {
      this.fadeMats[i].opacity = this.fadeBaseOpacity[i] * k;
    }
    if (k <= 0) {
      this.dying = false;
      G.scene.remove(this.group);
      spawnSparkle(this.pos.x, this.pos.y + 0.6, this.pos.z, 0x9fe8b8, 30, 5);
      G.audio.sfx('poof');
      this.dropLoot();
    }
  }

  // rebuild from the bone pile: night watch + crimson moon both come here
  reawaken() {
    this.dead = false;
    this.dying = false;
    this.dyingT = 0;
    this.fadeStarted = false;
    this.hp = this.maxHp;
    this.flashT = 0;
    this.hitstopT = 0;
    this.attackCd = 0;
    this.castCd = 2;
    this.blinkCd = 1.5;
    this.dodgeCd = 1;
    this.frustration = 0;
    this.attackHitDone = false;
    this.castFired = false;
    this.dispFrac = 1;
    this.chipHold = 0;
    this.barTimer = 99;
    this.bar.visible = false;
    this.alertMark.visible = false;
    for (let i = 0; i < this.fadeMats.length; i++) {
      this.fadeMats[i].opacity = this.fadeBaseOpacity[i];
      this.fadeMats[i].transparent = this.fadeBaseTransparent[i];
    }
    this.pos.set(this.home.x, heightAt(this.home.x, this.home.y), this.home.y);
    this.wanderTarget.copy(this.home);
    this.group.position.copy(this.pos);
    this.group.rotation.set(0, this.yaw, 0);
    if (!this.group.parent) G.scene.add(this.group);
    this.mixer.stopAllAction();
    this.curAct = null;
    this.setState('awaken');
    this.mixer.update(0.1); // settle past the fade — no T-pose flash
  }

  checkAggro(p, dist, aggroR) {
    if (G.gameOver) return;
    tmp2.set(p.x - this.pos.x, 0, p.z - this.pos.z);
    const d = tmp2.length();
    const facing = d > 0.001
      ? (tmp2.x / d) * Math.sin(this.yaw) + (tmp2.z / d) * Math.cos(this.yaw) : 1;
    // empty eye sockets see everything up close
    if (dist < aggroR && (facing > 0.1 || dist < 9)) this.setState('alert');
  }

  doBlink(p) {
    const inv = 1 / Math.max(0.001, Math.hypot(this.pos.x - p.x, this.pos.z - p.z));
    const base = Math.atan2((this.pos.x - p.x) * inv, (this.pos.z - p.z) * inv);
    for (let i = 0; i < BLINK_TRIES.length; i++) {
      const a = base + BLINK_TRIES[i];
      const nx = this.pos.x + Math.sin(a) * 6, nz = this.pos.z + Math.cos(a) * 6;
      const nh = heightAt(nx, nz);
      if (nh > WATER_Y + 0.25 && Math.abs(nh - this.pos.y) < 4) {
        spawnSparkle(this.pos.x, this.pos.y + 1.1, this.pos.z, 0x54ff9c, 18, 4);
        this.pos.set(nx, nh, nz);
        spawnSparkle(nx, nh + 1.1, nz, 0x54ff9c, 22, 4);
        G.audio.sfx('poof');
        this.blinkCd = 3.5;
        this.setState('chase');
        return;
      }
    }
    this.blinkCd = 1.2; // cornered — sidestep instead
    this.setState('dodge');
  }

  fireBolt(p) {
    const b = acquireBolt();
    if (!b) return false; // pool exhausted (5 live max) — hold the spell
    const sx = this.pos.x + Math.sin(this.yaw) * 0.5;
    const sz = this.pos.z + Math.cos(this.yaw) * 0.5;
    const sy = this.pos.y + 1.6;
    const tx = p.x, tz = p.z, ty = heightAt(tx, tz);
    const T = clamp(Math.hypot(tx - sx, tz - sz) / 14, 0.3, 1.6);
    b.x = sx; b.y = sy; b.z = sz; b.T = T;
    b.owner = this;
    b.reflected = false;
    b.vx = (tx - sx) / T;
    b.vz = (tz - sz) / T;
    b.vy = (ty - sy) / T + 0.5 * BOLT_G * T;
    b.mesh.visible = true;
    b.mesh.position.set(sx, sy, sz);
    b.ring.visible = true;
    b.ring.position.set(tx, ty + 0.06, tz);
    b.ring.scale.setScalar(0.55);
    b.ring.material.opacity = 0.25;
    return true;
  }

  update(dt) {
    if (this.dying) { this.updateDying(dt); return; }
    if (this.dead) return;
    const p = G.player.pos;
    const distToPlayer = Math.hypot(p.x - this.pos.x, p.z - this.pos.z);

    // far away: AI and the AnimationMixer both sleep
    if (distToPlayer > 120) return;

    this.flashT = Math.max(0, this.flashT - dt);
    this.updateGlow();
    this.updateBar(distToPlayer, dt);
    if (this.hitstopT > 0) { this.hitstopT -= dt; return; } // frozen by hit-stop
    this.stateT += dt;
    this.attackCd = Math.max(0, this.attackCd - dt);
    this.castCd = Math.max(0, this.castCd - dt);
    this.blinkCd = Math.max(0, this.blinkCd - dt);
    this.dodgeCd = Math.max(0, this.dodgeCd - dt);

    const aggroR = nightNow ? 26 : 18; // the dark makes the dead bold
    const pl = G.player;
    const s = this.state;
    let loco = null;     // desired locomotion clip for this frame
    let blocked = false;

    if (s === 'awaken') {
      if (!this.awakenPuffed && this.stateT > this.awakenDur * 0.45) {
        this.awakenPuffed = true; // second dust puff as the ribs clear the soil
        spawnSparkle(this.pos.x, this.pos.y + 0.4, this.pos.z, 0xb9a888, 14, 2.5);
      }
      if (this.stateT >= this.awakenDur) this.setState('idle');
    } else if (s === 'idle') {
      if (this.stateT > 3.2) {
        this.stateT = 0;
        const a = Math.random() * Math.PI * 2;
        this.wanderTarget.set(this.home.x + Math.cos(a) * 3.5, this.home.y + Math.sin(a) * 3.5);
      }
      const dx = this.wanderTarget.x - this.pos.x, dz = this.wanderTarget.y - this.pos.z;
      if (Math.hypot(dx, dz) > 0.8) {
        this.yaw = Math.atan2(dx, dz);
        this.tryMove(Math.sin(this.yaw) * 1.4 * dt, Math.cos(this.yaw) * 1.4 * dt);
        loco = 'walk';
      } else loco = 'idle';
      this.checkAggro(p, distToPlayer, aggroR);
    } else if (s === 'alert') {
      this.faceYaw(p.x, p.z);
      if (this.stateT > 0.5) this.setState('chase');
    } else if (s === 'return') {
      const dx = this.home.x - this.pos.x, dz = this.home.y - this.pos.z;
      if (Math.hypot(dx, dz) < 1.5) {
        this.hp = this.maxHp; // the storm re-knits the bones
        this.setState('idle');
      } else {
        this.yaw = Math.atan2(dx, dz);
        this.tryMove(Math.sin(this.yaw) * 2.6 * dt, Math.cos(this.yaw) * 2.6 * dt);
        loco = 'walk';
      }
      if (distToPlayer < aggroR * 0.7 && !G.gameOver) this.setState('alert');
    } else if (s === 'chase') {
      // pursuit: melee closes in; the mage holds 12-18m, casts with marked
      // landings, sidesteps rushes and blinks away when crowded
      if (G.gameOver || distToPlayer > (this.kind === 'mage' ? 50 : 45)) {
        this.frustration = 0;
        this.setState('return');
      } else if (this.kind === 'mage') {
        this.faceYaw(p.x, p.z);
        const inv = 1 / Math.max(0.001, distToPlayer);
        const closing =
          (pl.vel.x * (this.pos.x - p.x) + pl.vel.z * (this.pos.z - p.z)) * inv;
        if (this.blinkCd <= 0 && distToPlayer < 6) {
          this.setState('blinkRaise'); // raise the staff, then vanish backward
        } else if (this.dodgeCd <= 0 && distToPlayer < 10 && closing > 3.2) {
          this.setState('dodge');
        } else {
          if (distToPlayer > 18) {
            blocked = !this.tryMove(Math.sin(this.yaw) * this.speed * dt,
              Math.cos(this.yaw) * this.speed * dt);
            loco = 'run';
          } else if (distToPlayer < 12) {
            if (!this.tryMove(-Math.sin(this.yaw) * 3.6 * dt, -Math.cos(this.yaw) * 3.6 * dt)) {
              const rx = (this.pos.x - p.x) * inv, rz = (this.pos.z - p.z) * inv;
              if (!this.tryMove(-rz * this.orbitDir * 3.6 * dt, rx * this.orbitDir * 3.6 * dt)) {
                this.orbitDir *= -1;
              }
            }
            loco = 'walkBack';
          } else {
            const rx = (this.pos.x - p.x) * inv, rz = (this.pos.z - p.z) * inv;
            if (!this.tryMove(-rz * this.orbitDir * 2.4 * dt, rx * this.orbitDir * 2.4 * dt)) {
              this.orbitDir *= -1;
            }
            loco = this.orbitDir > 0 ? 'strafeL' : 'strafeR';
          }
          if (this.castCd <= 0 && distToPlayer > 8 && distToPlayer < 24) {
            this.setState('windup');
          }
        }
      } else if (this.kind === 'warrior' && distToPlayer < 4.5 &&
        pl.attackT >= 0 && pl.attackT < 0.12) {
        // shield up against a frontal swing — flank it or bait the parry
        this.faceYaw(p.x, p.z);
        this.setState('block');
      } else if (distToPlayer < this.range && this.attackCd <= 0) {
        this.faceYaw(p.x, p.z);
        this.setState('attack');
      } else if (distToPlayer < 4.5) {
        // shuffle around the player while the next swing charges
        this.faceYaw(p.x, p.z);
        const inv = 1 / Math.max(0.001, distToPlayer);
        const rx = (this.pos.x - p.x) * inv, rz = (this.pos.z - p.z) * inv;
        const radial = clamp(distToPlayer - this.range - 0.2, -1, 1) * -1.2;
        if (!this.tryMove((-rz * this.orbitDir * 1.8 + rx * radial) * dt,
          (rx * this.orbitDir * 1.8 + rz * radial) * dt)) this.orbitDir *= -1;
        loco = 'walk';
      } else {
        this.faceYaw(p.x, p.z);
        blocked = !this.tryMove(Math.sin(this.yaw) * this.speed * dt,
          Math.cos(this.yaw) * this.speed * dt);
        loco = 'run';
      }
    } else if (s === 'block') {
      // planted: yaw frozen so a quick side-step gets behind the shield
      if (this.stateT > 0.9) this.setState('chase');
    } else if (s === 'attack') {
      if (this.stateT < this.attackHitAt * 0.7) this.faceYaw(p.x, p.z);
      if (this.stateT > this.attackHitAt - 0.18 && this.stateT < this.attackHitAt) {
        // short lunge step into the swing
        this.tryMove(Math.sin(this.yaw) * 4.5 * dt, Math.cos(this.yaw) * 4.5 * dt);
      }
      if (!this.attackHitDone && this.stateT >= this.attackHitAt) {
        this.attackHitDone = true;
        G.audio.sfx(this.kind === 'warrior' ? 'clubswing' : 'swing');
        tmp2.set(p.x - this.pos.x, 0, p.z - this.pos.z);
        const d = tmp2.length();
        const vertical = Math.abs(p.y - this.pos.y);
        const facing = d > 0.001
          ? (tmp2.x / d) * Math.sin(this.yaw) + (tmp2.z / d) * Math.cos(this.yaw) : 1;
        if (d < this.range + 0.6 && vertical < 1.45 && facing > 0.1) {
          if (G.player.iframes <= 0) G.hitStopT = Math.max(G.hitStopT, 0.09); // melee connects both ways
          G.player.damage(this.dmg, this.pos.x, this.pos.z);
          G.camShake += this.kind === 'warrior' ? 0.22 : 0.12;
        }
      }
      if (this.stateT >= this.attackDur) {
        this.attackCd = this.kind === 'warrior' ? 1.2 : 0.8;
        this.setState('recover'); // warrior: 0.8s wide open — punish it
      }
    } else if (s === 'recover') {
      if (this.stateT > this.recoverFor) {
        this.setState(G.gameOver ? 'return' : 'chase');
      }
    } else if (s === 'hitreact') {
      if (this.stateT > 0.4) {
        this.setState(G.gameOver ? 'return' : 'chase');
      }
    } else if (s === 'dodge') {
      const inv = 1 / Math.max(0.001, distToPlayer);
      const rx = (this.pos.x - p.x) * inv, rz = (this.pos.z - p.z) * inv;
      this.tryMove(-rz * this.dodgeDir * 5.5 * dt, rx * this.dodgeDir * 5.5 * dt);
      if (this.stateT > 0.42) {
        this.dodgeCd = 2.2 + Math.random();
        this.setState('chase');
      }
    } else if (s === 'windup') {
      // mage spellcast: staff flares through the wind-up, bolt at castFireAt
      this.faceYaw(p.x, p.z);
      if (!this.castFired && this.stateT >= this.castFireAt) {
        this.castFired = true;
        if (this.fireBolt(p)) G.audio.sfx('throw');
        this.castCd = 2.4 + Math.random() * 1.4;
      }
      if (this.stateT >= this.castDur) this.setState('chase');
    } else if (s === 'blinkRaise') {
      // readable pre-blink: staff raised, crystal flaring
      if (this.stateT > 0.55) this.doBlink(p);
    }

    // unreachable-player de-aggro (blocked pathing / player perched high up)
    if (s === 'chase') {
      if (blocked || (distToPlayer < 12 && p.y > this.pos.y + 5)) this.frustration += dt;
      else this.frustration = Math.max(0, this.frustration - dt * 2);
      if (this.frustration > 6) {
        this.frustration = 0;
        this.setState('return');
      }
    }

    // minions rattle as they move
    if (this.kind === 'minion' && (loco === 'walk' || loco === 'run')) {
      this.rattleT -= dt;
      if (this.rattleT <= 0) {
        this.rattleT = 3 + Math.random() * 4;
        G.audio.sfx('bone_rattle');
      }
    }

    // staff-tip telegraph flare during spell / blink wind-ups
    if (this.castGlow) {
      const tele = (this.state === 'windup' && !this.castFired) || this.state === 'blinkRaise';
      this.castGlow.visible = tele;
      if (tele) {
        const k = clamp(this.stateT / 0.5, 0, 1);
        this.castGlow.scale.setScalar(0.6 + k * 1.3 + Math.sin(G.time * 24) * 0.12);
      }
    }

    // apply the locomotion clip only if we are still in a locomotion state —
    // a same-frame setState('windup'/'alert'/...) must keep its one-shot clip
    if (loco && (this.state === 'idle' || this.state === 'chase' ||
      this.state === 'return')) {
      this.playAct(loco, 0.22);
    }
    this.pos.y = heightAt(this.pos.x, this.pos.z);
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
    if (this.alertMark.visible) this.alertMark.rotation.y = G.time * 3;
    this.mixer.update(dt);
  }

  updateGlow() {
    // white damage flash over the stored base emissives (eyes stay lit)
    const flash = this.flashT > 0;
    for (let i = 0; i < this.glowMats.length; i++) {
      const m = this.glowMats[i];
      m.emissive.setHex(flash ? 0xffffff : this.baseEmissive[i]);
      m.emissiveIntensity = flash ? 0.45 : this.baseEmissiveI[i];
    }
  }

  updateBar(distToPlayer, dt) {
    const fighting = this.state !== 'idle' && this.state !== 'return' && this.state !== 'awaken';
    if (fighting) this.barTimer = 0;
    else this.barTimer += dt;
    const frac = clamp(this.hp / this.maxHp, 0, 1);
    if (this.chipHold > 0) this.chipHold -= dt;
    else this.dispFrac = Math.max(frac, this.dispFrac - dt * 1.1);

    this.bar.visible = this.hp < this.maxHp && distToPlayer < 30 && this.barTimer < 4;
    if (!this.bar.visible) return;
    this.bar.quaternion.copy(G.camera.quaternion);
    this.bar.rotation.z = 0;
    this.barFg.scale.x = Math.max(frac, 0.0001);
    this.barFg.position.x = -(1 - frac) * 0.58;
    const chipW = this.dispFrac - frac;
    this.barChip.visible = chipW > 0.005;
    if (this.barChip.visible) {
      this.barChip.scale.x = chipW;
      this.barChip.position.x = -0.58 + (frac + this.dispFrac) * 0.58;
    }
  }
}

// kick off the skeleton GLB downloads; Hollows rise once all three are in
let hollowsSpawned = false;
function loadHollows() {
  preloadModels(['skeleton_minion', 'skeleton_warrior', 'skeleton_mage']).then(res => {
    if (hollowsSpawned) return;
    if (!res.skeleton_minion || !res.skeleton_warrior || !res.skeleton_mage) return;
    hollowsSpawned = true;
    HOLLOW_SITES.forEach((site, si) => {
      site.squad.forEach((kind, i) => {
        const a = (i / site.squad.length) * Math.PI * 2 + hash2(si, i) * 1.3;
        const d = 2.5 + hash2(si, i + 9) * 4;
        const x = site.x + Math.cos(a) * d, z = site.z + Math.sin(a) * d;
        if (heightAt(x, z) < WATER_Y + 0.5) return;
        G.enemies.push(new Hollow(x, z, kind));
      });
    });
  });
}

// ---------------------------------------------------------------- exports
export function buildEnemies() {
  initPools();
  buildCamps();
  for (const [cx, cz, n] of CAMPS) {
    const h = heightAt(cx, cz);
    if (h < WATER_Y + 0.5) continue;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const x = cx + Math.cos(a) * (3 + hash2(cx | 0, i) * 5);
      const z = cz + Math.sin(a) * (3 + hash2(cz | 0, i) * 5);
      if (heightAt(x, z) < WATER_Y + 0.5) continue;
      const roll = hash2(cx | 0, cz | 0, i);
      const variant = roll < 0.25 ? 'tough' : roll < 0.4 ? 'moss' : 'normal';
      G.enemies.push(new Boglin(x, z, variant, cx, cz));
    }
  }
  // razorkites wheel over the tower and bellows thermals, two to a gyre
  for (let s = 0; s < KITE_SITES.length; s++) {
    const [kx, kz, alt] = KITE_SITES[s];
    for (let i = 0; i < 2; i++) G.enemies.push(new Razorkite(kx, kz, alt, s * 2 + i));
  }
  loadHollows(); // async — the storm-dead rise once their GLBs arrive
}

let wasNight = false; // night-edge detector for the once-per-night hollow watch

export function updateEnemies(dt) {
  nightNow = isNight();
  // each nightfall, every fallen Hollow earns one respawn-awakening
  if (nightNow && !wasNight) {
    for (const e of G.enemies) if (e.isHollow) e.nightRespawnUsed = false;
  }
  wasNight = nightNow;
  const p = G.player ? G.player.pos : null;
  for (const e of G.enemies) {
    // dead Hollows far from the player (>60m) re-knit under cover of dark
    if (nightNow && p && e.isHollow && e.dead && !e.dying && !e.nightRespawnUsed &&
      Math.hypot(p.x - e.home.x, p.z - e.home.y) > 60) {
      e.nightRespawnUsed = true;
      e.reawaken();
    }
    e.update(dt);
  }
  updateRocks(dt);
  updateBolts(dt);
  updateRings(dt);
  updateCamps(dt);
}

// the crimson moon calls the fallen back to their camps — boglins reappear
// where they camped; Hollows re-AWAKEN with the floor-rise animation
export function respawnFallen() {
  let n = 0;
  for (const e of G.enemies) {
    if (!e.dead) continue;
    if (e.isHollow) {
      e.reawaken();
      spawnSparkle(e.pos.x, e.pos.y + 1.2, e.pos.z, 0xff4a3a, 24, 4);
      n++;
      continue;
    }
    e.dead = false;
    e.dying = false;
    e.dyingT = 0;
    e.hp = e.maxHp;
    e.state = 'idle';
    e.stateT = 0;
    e.staggerT = 0;
    e.hitstopT = 0;
    e.flashT = 0;
    e.commitT = 0;
    e.frustration = 0;
    e.leapCd = 4 + Math.random() * 3;
    e.throwCd = 1.5;
    e.attackHitDone = false;
    e.dispFrac = 1;
    e.chipHold = 0;
    e.barTimer = 99;
    e.releaseRock();
    e.releaseDisc();
    e.bar.visible = false;
    e.alertMark.visible = false;
    e.qMark.visible = false;
    for (let i = 0; i < e.fadeMats.length; i++) {
      e.fadeMats[i].opacity = e.fadeBaseOpacity[i];
      e.fadeMats[i].transparent = e.fadeBaseTransparent[i];
    }
    e.group.rotation.set(0, e.yaw, 0);
    e.pos.set(e.home.x, heightAt(e.home.x, e.home.y), e.home.y);
    e.group.position.copy(e.pos);
    G.scene.add(e.group);
    spawnSparkle(e.pos.x, e.pos.y + 1.2, e.pos.z, 0xff4a3a, 24, 4);
    n++;
  }
  return n;
}
