// The Gloamhound — a spectral amber stalker that only exists where the dark
// is thickest: inside stray squalls, and abroad on blood nights.
//
// It circles at the edge of what you can see, darts in for one bite, and
// retreats into the murk. Two sword hits (or an arrow) disperse it — but so
// does light: the hearths and the lantern-lit Mirrormere shore drive it off
// without a fight. It drops nothing. Instead, a dispersed hound leaves a
// brief amber wisp that flies a few meters toward the nearest thing you have
// not yet found — a spook converted into a direction.
import * as THREE from 'three';
import { G } from './state.js';
import { heightAt } from './terrain.js';
import { spawnSparkle } from './world.js';
import { preloadModels, propInstance } from './assets.js';
import { getSquallSummary } from './squall.js';

const HEARTH_LIGHTS = [[27, -106], [-143, 111], [3, 317]];
const LAKE = { x: -170, z: 120 };

const hounds = [];
let nextSpawnAt = 0;
let houndGeo = null; // shared geometry once the GLB lands
let wisps = [];      // {sprite, from, to, t}

const flag = id => !!(G.story && G.story.flags && G.story.flags[id]);

function playerInSquall() {
  const s = getSquallSummary();
  if (!s.x || s.stilled) return false;
  const p = G.player.pos;
  return Math.hypot(p.x - s.x, p.z - s.z) < 26;
}

function darkAbroad() {
  return !!G.bloodNight || playerInSquall();
}

function nearLight(x, z) {
  for (const [hx, hz] of HEARTH_LIGHTS) {
    if (Math.hypot(x - hx, z - hz) < 11) return true;
  }
  // the lantern-lit shore, once all five burn
  const lanterns = G.story && G.story.collections && G.story.collections.lanterns;
  if (lanterns && Object.keys(lanterns).length >= 5 &&
      Math.hypot(x - LAKE.x, z - LAKE.z) < 46) return true;
  return false;
}

function ghostMaterial() {
  return new THREE.MeshBasicMaterial({
    color: 0xffb45c, transparent: true, opacity: 0.22,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
}

function buildHoundMesh() {
  const mat = ghostMaterial();
  let root;
  if (!houndGeo) {
    const inst = propInstance('gloamhound'); // returns the toonified root, or null
    if (inst) inst.traverse(o => { if (o.isMesh && !houndGeo) houndGeo = o.geometry; });
  }
  if (houndGeo) {
    root = new THREE.Mesh(houndGeo, mat);
  } else {
    root = new THREE.Mesh(
      new THREE.ConeGeometry(0.3, 1.1, 6).rotateX(Math.PI / 2), mat);
  }
  root.rotation.order = 'YXZ';
  return { root, mat };
}

class Gloamhound {
  constructor(x, z) {
    this.home = new THREE.Vector2(x, z);
    this.pos = new THREE.Vector3(x, heightAt(x, z) + 0.55, z);
    this.radius = 0.8;
    this.hp = 2;
    this.dead = false;
    this.dying = false;
    this.state = 'circle';
    this.stateT = 0;
    this.nextDartAt = G.time + 5 + Math.random() * 5;
    this.orbitDir = Math.random() < 0.5 ? -1 : 1;
    this.ph = Math.random() * 9;
    const built = buildHoundMesh();
    this.mesh = built.root;
    this.mat = built.mat;
    this.mesh.position.copy(this.pos);
    G.scene.add(this.mesh);
  }

  hurt(dmg) {
    if (this.dead) return;
    this.hp -= (Number(dmg) || 1);
    spawnSparkle(this.pos.x, this.pos.y + 0.4, this.pos.z, 0xffb45c, 10, 2);
    if (this.hp <= 0) this.disperse(true);
    else if (this.state !== 'retreat') { this.state = 'retreat'; this.stateT = 0; }
  }

  disperse(withWisp) {
    if (this.dead) return;
    this.dead = true;
    this.dying = true;
    this.stateT = 0;
    if (withWisp) {
      spawnSparkle(this.pos.x, this.pos.y + 0.5, this.pos.z, 0xffb45c, 34, 4);
      if (G.audio) G.audio.chord([440, 587.33], 0.06, 0.25);
      spawnWisp(this.pos);
    }
  }

  update(dt) {
    if (this.dead) {
      // the body unravels into the murk
      this.stateT += dt;
      this.mat.opacity = Math.max(0, 0.22 - this.stateT * 0.3);
      if (this.stateT > 1) this.mesh.visible = false;
      return;
    }
    if (!darkAbroad()) { this.disperse(false); return; }
    if (nearLight(this.pos.x, this.pos.z)) { this.disperse(true); return; }

    const p = G.player.pos;
    const dx = p.x - this.pos.x, dz = p.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    this.stateT += dt;
    let speed = 0, heading = this.mesh.rotation.y;

    if (this.state === 'circle') {
      // hold the edge of sight, drifting around the player
      const targetR = 15;
      const tangentA = Math.atan2(dx, dz) + Math.PI / 2 * this.orbitDir;
      const radial = dist < targetR - 1 ? -1 : dist > targetR + 2 ? 0.6 : 0;
      const moveA = Math.atan2(
        Math.sin(tangentA) + Math.sin(Math.atan2(dx, dz)) * radial,
        Math.cos(tangentA) + Math.cos(Math.atan2(dx, dz)) * radial);
      speed = 5.5;
      heading = moveA;
      if (G.time > this.nextDartAt && dist < 24) { this.state = 'dart'; this.stateT = 0; }
    } else if (this.state === 'dart') {
      speed = 11;
      heading = Math.atan2(dx, dz);
      if (dist < 1.7) {
        G.player.damage(4, this.pos.x, this.pos.z);
        if (G.audio) G.audio.sfx('die');
        this.state = 'retreat';
        this.stateT = 0;
      } else if (this.stateT > 2.4) { this.state = 'retreat'; this.stateT = 0; }
    } else { // retreat into the murk
      speed = 8;
      heading = Math.atan2(-dx, -dz);
      if (this.stateT > 1.6) {
        this.state = 'circle';
        this.nextDartAt = G.time + 6 + Math.random() * 5;
        this.stateT = 0;
      }
    }

    const nx = this.pos.x + Math.sin(heading) * speed * dt;
    const nz = this.pos.z + Math.cos(heading) * speed * dt;
    this.pos.x = nx;
    this.pos.z = nz;
    this.pos.y = heightAt(nx, nz) + 0.55 + Math.sin(G.time * 6 + this.ph) * 0.08;

    this.mesh.position.copy(this.pos);
    // the GLB faces -Z; heading convention matches enemies (atan2(dx,dz))
    this.mesh.rotation.y = heading + Math.PI;
    this.mesh.rotation.z = Math.sin(G.time * 5 + this.ph) * 0.06;
    // barely-there when calm, brighter mid-dart
    const base = this.state === 'dart' ? 0.4 : 0.16 + Math.sin(G.time * 2.3 + this.ph) * 0.07;
    this.mat.opacity = base;
  }
}

function spawnWisp(from) {
  // the payout: a few meters of direction toward something unfound
  let target = null, bestD = Infinity;
  for (const it of G.interactables) {
    if (it.gone || !it.pos) continue;
    if (it.label !== 'Open chest' && it.label !== 'Feel the high wind' &&
        it.label !== 'Stand in the sky') continue;
    const d = (it.pos.x - from.x) ** 2 + (it.pos.z - from.z) ** 2;
    if (d < bestD) { bestD = d; target = it; }
  }
  if (!target) return;
  const dir = new THREE.Vector3(
    target.pos.x - from.x, 0, target.pos.z - from.z).normalize();
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(16, 16, 1, 16, 16, 15);
  grad.addColorStop(0, 'rgba(255,220,160,1)');
  grad.addColorStop(1, 'rgba(255,220,160,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 32, 32);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: new THREE.CanvasTexture(c), transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  sprite.scale.setScalar(0.9);
  sprite.position.set(from.x, from.y + 0.8, from.z);
  G.scene.add(sprite);
  wisps.push({
    sprite,
    from: sprite.position.clone(),
    to: sprite.position.clone().addScaledVector(dir, 9).add(new THREE.Vector3(0, 2.5, 0)),
    t: 0,
  });
}

export function updateGloamhounds(dt = 0) {
  if (!G.started || !G.player || !G.enemies) return;
  const step = Math.min(Number.isFinite(dt) && dt > 0 ? dt : 0, 0.05);

  // spawn while the dark is abroad; the hounds keep their distance in number
  const alive = hounds.filter(h => !h.dead).length;
  const cap = G.bloodNight ? 2 : playerInSquall() ? 1 : 0;
  if (alive < cap && G.time > nextSpawnAt && !G.cinematic) {
    nextSpawnAt = G.time + 22;
    const a = Math.random() * Math.PI * 2;
    const p = G.player.pos;
    const x = p.x + Math.cos(a) * 22, z = p.z + Math.sin(a) * 22;
    if (Math.hypot(x, z) < 440 && !nearLight(x, z)) {
      preloadModels(['gloamhound']).catch(() => { });
      const hound = new Gloamhound(x, z);
      hounds.push(hound);
      G.enemies.push(hound);
      if (G.ui && alive === 0) {
        G.ui.toast('Something amber paces at the edge of sight...', 0xffb45c, 4600);
      }
    }
  }

  // wisps fly their few meters of direction, then let go
  for (let i = wisps.length - 1; i >= 0; i--) {
    const w = wisps[i];
    w.t += step;
    const k = Math.min(1, w.t / 2.4);
    w.sprite.position.lerpVectors(w.from, w.to, k * k * (3 - 2 * k));
    w.sprite.material.opacity = 0.9 * (1 - k);
    if (k >= 1) {
      G.scene.remove(w.sprite);
      wisps.splice(i, 1);
    }
  }
}

export function getGloamhoundSummary() {
  return {
    alive: hounds.filter(h => !h.dead).length,
    total: hounds.length,
    wisps: wisps.length,
    darkAbroad: darkAbroad(),
  };
}
