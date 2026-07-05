// Wildlife: deer herds grazing the forest fringes, rabbits in the meadows,
// fish circling (and leaping from) the Mirrormere. Pure ambience — nothing
// here fights back; deer and rabbits simply flee. All procedural, all
// deterministic placement, per-frame work gated by distance to the player.
import * as THREE from 'three';
import { G } from './state.js';
import { heightAt, slopeAt, WATER_Y, toonMat } from './terrain.js';
import { fbm, hash2, clamp, lerp } from './noise.js';
import { spawnSparkle } from './world.js';

const tmpV = new THREE.Vector3();
const deer = [];
const rabbits = [];
const fish = [];
let fishMesh = null;

// herd home spots: forest-fringe country (some tree cover, mostly open)
const HERDS = [[-60, 120], [140, -30], [-30, 250]];
const WARY_R = 11;      // flee when the hero gets this close
const SPRINT_WARY = 17; // ...or sprints this close
const MODEL_FORWARD_TO_GAME_FORWARD = -Math.PI / 2; // procedural bodies face local +X

// ---------------------------------------------------------------- deer

function buildDeer(x, z, buck, seed) {
  const g = new THREE.Group();
  g.rotation.order = 'YXZ';
  const coat = toonMat({ color: buck ? 0x9a7448 : 0xb08a5e });
  const cream = toonMat({ color: 0xe8d9bd });

  const body = new THREE.Mesh(new THREE.SphereGeometry(0.52, 10, 8), coat);
  body.position.y = 1.0;
  body.scale.set(1.45, 1, 0.82);
  const rump = new THREE.Mesh(new THREE.SphereGeometry(0.34, 8, 6), cream);
  rump.position.set(-0.62, 1.05, 0);
  const tail = new THREE.Mesh(new THREE.SphereGeometry(0.11, 6, 5), cream);
  tail.position.set(-0.85, 1.18, 0);

  const neck = new THREE.Group();          // pivot at the shoulders
  neck.position.set(0.55, 1.28, 0);
  const neckM = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.16, 0.72, 7), coat);
  neckM.position.y = 0.3;
  neckM.rotation.z = -0.5;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 8, 6), coat);
  head.position.set(0.28, 0.62, 0);
  head.scale.set(1.35, 0.9, 0.8);
  const snout = new THREE.Mesh(new THREE.SphereGeometry(0.09, 6, 5), cream);
  snout.position.set(0.48, 0.58, 0);
  const earGeo = new THREE.ConeGeometry(0.06, 0.2, 5);
  const earL = new THREE.Mesh(earGeo, coat);
  earL.position.set(0.2, 0.8, -0.13); earL.rotation.z = 0.5;
  const earR = earL.clone(); earR.position.z = 0.13;
  neck.add(neckM, head, snout, earL, earR);
  if (buck) { // forked antlers
    const antMat = toonMat({ color: 0xd8c9a8 });
    for (const s of [-1, 1]) {
      const main = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.035, 0.5, 5), antMat);
      main.position.set(0.2, 0.98, 0.1 * s);
      main.rotation.set(0.5 * s, 0, -0.3);
      const fork = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.028, 0.3, 5), antMat);
      fork.position.set(0.14, 1.1, 0.2 * s);
      fork.rotation.set(0.9 * s, 0, 0.35);
      neck.add(main, fork);
    }
  }

  const legGeo = new THREE.CylinderGeometry(0.055, 0.045, 0.85, 6);
  legGeo.translate(0, -0.425, 0); // pivot at the hip
  const legs = [];
  for (const [lx, lz] of [[0.45, -0.22], [0.45, 0.22], [-0.5, -0.22], [-0.5, 0.22]]) {
    const leg = new THREE.Mesh(legGeo, coat);
    leg.position.set(lx, 0.95, lz);
    legs.push(leg);
    g.add(leg);
  }

  g.add(body, rump, tail, neck);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  const y = heightAt(x, z);
  g.position.set(x, y, z);
  G.scene.add(g);
  return {
    g, neck, legs, home: new THREE.Vector2(x, z),
    pos: new THREE.Vector3(x, y, z),
    yaw: hash2(seed, 3) * Math.PI * 2,
    state: 'graze', stateT: hash2(seed, 5) * 4, fleeT: 0,
    tx: x, tz: z, ph: hash2(seed, 7) * 10,
  };
}

// deer/rabbit shared: walk with terrain + water avoidance
function walkerMove(a, dx, dz) {
  const nx = a.pos.x + dx, nz = a.pos.z + dz;
  const nh = heightAt(nx, nz);
  if (nh > WATER_Y + 0.25 && nh < a.pos.y + 1.4 && slopeAt(nx, nz) < 0.55) {
    a.pos.x = nx; a.pos.z = nz;
    return true;
  }
  return false;
}

function updateDeerOne(d, dt, p, sprinting) {
  const dist = Math.hypot(p.x - d.pos.x, p.z - d.pos.z);
  if (dist > 150) return; // asleep beyond view

  // spook check
  if (d.state !== 'flee' && (dist < WARY_R || (sprinting && dist < SPRINT_WARY))) {
    d.state = 'flee'; d.fleeT = 3.2 + Math.random() * 1.2;
    d.yaw = Math.atan2(d.pos.x - p.x, d.pos.z - p.z); // away
  }

  let speed = 0;
  d.stateT += dt;
  if (d.state === 'flee') {
    d.fleeT -= dt;
    speed = 8.6;
    // veer softly while bolting
    d.yaw += Math.sin(G.time * 1.3 + d.ph) * dt * 0.7;
    if (!walkerMove(d, Math.sin(d.yaw) * speed * dt, Math.cos(d.yaw) * speed * dt)) {
      d.yaw += 1.2; // bounced off water/cliff — cut hard
    }
    if (d.fleeT <= 0 && dist > 24) { d.state = 'graze'; d.stateT = 0; }
  } else if (d.state === 'graze') {
    if (d.stateT > 4 + hash2((d.ph * 91) | 0, 11) * 5) {
      d.state = 'amble'; d.stateT = 0;
      const a = Math.random() * Math.PI * 2;
      d.tx = d.home.x + Math.cos(a) * 22;
      d.tz = d.home.y + Math.sin(a) * 22;
    }
  } else { // amble toward the target
    const ddx = d.tx - d.pos.x, ddz = d.tz - d.pos.z;
    if (Math.hypot(ddx, ddz) < 1.2 || d.stateT > 12) { d.state = 'graze'; d.stateT = 0; }
    else {
      const want = Math.atan2(ddx, ddz);
      let dy = want - d.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      d.yaw += dy * Math.min(1, dt * 3);
      speed = 1.6;
      walkerMove(d, Math.sin(d.yaw) * speed * dt, Math.cos(d.yaw) * speed * dt);
    }
  }
  d.pos.y = heightAt(d.pos.x, d.pos.z);

  // presentation
  d.g.position.copy(d.pos);
  d.g.rotation.y = d.yaw + MODEL_FORWARD_TO_GAME_FORWARD;
  const t = G.time;
  if (speed > 4) {          // gallop: bounding legs + body pitch
    const f = t * 11;
    for (let i = 0; i < 4; i++) d.legs[i].rotation.x = Math.sin(f + (i < 2 ? 0 : Math.PI)) * 0.9;
    d.g.rotation.x = Math.sin(f) * 0.08;
    d.neck.rotation.x = lerp(d.neck.rotation.x, 0.25, Math.min(1, dt * 8));
  } else if (speed > 0) {   // walk
    const f = t * 5;
    for (let i = 0; i < 4; i++) d.legs[i].rotation.x = Math.sin(f + (i % 2) * Math.PI + (i < 2 ? 0 : 1.4)) * 0.45;
    d.g.rotation.x = 0;
    d.neck.rotation.x = lerp(d.neck.rotation.x, 0, Math.min(1, dt * 6));
  } else {                   // grazing: head dips to the grass, tail flicks
    for (let i = 0; i < 4; i++) d.legs[i].rotation.x = 0;
    d.g.rotation.x = 0;
    const dip = Math.sin(t * 0.5 + d.ph) > 0.1 ? 0.95 : 0.1;
    d.neck.rotation.x = lerp(d.neck.rotation.x, dip, Math.min(1, dt * 2.5));
  }
}

// ---------------------------------------------------------------- rabbits

function buildRabbit(x, z, seed) {
  const g = new THREE.Group();
  const fur = toonMat({ color: hash2(seed, 13) < 0.4 ? 0xc9bda8 : 0x9a8468 });
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), fur);
  body.position.y = 0.16;
  body.scale.set(1.25, 1, 0.9);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 7, 6), fur);
  head.position.set(0.16, 0.28, 0);
  const earGeo = new THREE.CapsuleGeometry ? new THREE.CapsuleGeometry(0.025, 0.14, 3, 5)
    : new THREE.CylinderGeometry(0.025, 0.03, 0.16, 5);
  const earL = new THREE.Mesh(earGeo, fur);
  earL.position.set(0.14, 0.44, -0.04); earL.rotation.z = -0.15;
  const earR = earL.clone(); earR.position.z = 0.04;
  const tail = new THREE.Mesh(new THREE.SphereGeometry(0.05, 5, 4), toonMat({ color: 0xf2ead8 }));
  tail.position.set(-0.2, 0.2, 0);
  g.add(body, head, earL, earR, tail);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  const y = heightAt(x, z);
  g.position.set(x, y, z);
  G.scene.add(g);
  return {
    g, pos: new THREE.Vector3(x, y, z), home: new THREE.Vector2(x, z),
    yaw: hash2(seed, 17) * Math.PI * 2, hopT: hash2(seed, 19), state: 'idle',
    fleeT: 0, ph: hash2(seed, 23) * 9,
  };
}

function updateRabbitOne(r, dt, p, night) {
  r.g.visible = !night; // rabbits burrow after dark
  if (night) return;
  const dist = Math.hypot(p.x - r.pos.x, p.z - r.pos.z);
  if (dist > 120) return;
  if (r.state !== 'flee' && dist < 7) {
    r.state = 'flee'; r.fleeT = 2.6;
    r.yaw = Math.atan2(r.pos.x - p.x, r.pos.z - p.z);
  }
  const fleeing = r.state === 'flee';
  if (fleeing) {
    r.fleeT -= dt;
    if (r.fleeT <= 0) r.state = 'idle';
  }
  // rabbits move in discrete hops
  r.hopT += dt * (fleeing ? 2.6 : 0.55);
  const cyc = r.hopT % 1;
  if (cyc < 0.45) { // airborne part of the hop
    const k = cyc / 0.45;
    const hop = Math.sin(k * Math.PI);
    const sp = fleeing ? 4.6 : 1.4;
    walkerMove(r, Math.sin(r.yaw) * sp * dt / 0.45, Math.cos(r.yaw) * sp * dt / 0.45);
    r.pos.y = heightAt(r.pos.x, r.pos.z);
    r.g.position.set(r.pos.x, r.pos.y + hop * (fleeing ? 0.34 : 0.18), r.pos.z);
  } else {
    r.pos.y = heightAt(r.pos.x, r.pos.z);
    r.g.position.copy(r.pos);
    if (!fleeing && cyc > 0.98) {
      // pick a new nibble direction, drifting back toward home
      const toHome = Math.atan2(r.home.x - r.pos.x, r.home.y - r.pos.z);
      r.yaw = toHome + (hash2((G.time * 13) | 0, 29) - 0.5) * 2.4;
    }
  }
  r.g.rotation.y = r.yaw + MODEL_FORWARD_TO_GAME_FORWARD;
}

// ---------------------------------------------------------------- fish

const LAKE = { x: -170, z: 120 };

export function buildAnimals() {
  // deer herds: a buck and two does around each home spot
  HERDS.forEach(([hx, hz], hi) => {
    for (let i = 0; i < 3; i++) {
      const a = hash2(hi * 31 + i, 41) * Math.PI * 2;
      const d = 3 + hash2(hi * 31 + i, 43) * 8;
      const x = hx + Math.cos(a) * d, z = hz + Math.sin(a) * d;
      if (heightAt(x, z) < WATER_Y + 1 || slopeAt(x, z) > 0.4) continue;
      deer.push(buildDeer(x, z, i === 0, hi * 31 + i));
    }
  });
  // rabbits scattered through flower country
  for (let i = 0; i < 6000 && rabbits.length < 7; i++) {
    const x = (hash2(i, 2101) - 0.5) * 600, z = (hash2(i, 2103) - 0.5) * 600;
    const h = heightAt(x, z);
    if (h < WATER_Y + 1 || h > 26 || slopeAt(x, z) > 0.35) continue;
    if (fbm(x * 0.02 + 300, z * 0.02 - 120, 2) < 0.2) continue;
    rabbits.push(buildRabbit(x, z, i));
  }
  // fish: sleek dark shapes circling under the Mirrormere
  fishMesh = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.16, 7, 5),
    toonMat({ color: 0x4a6a78 }), 10);
  fishMesh.frustumCulled = false;
  G.scene.add(fishMesh);
  for (let i = 0; i < 10; i++) {
    fish.push({
      cx: LAKE.x + (hash2(i, 2201) - 0.5) * 60,
      cz: LAKE.z + (hash2(i, 2203) - 0.5) * 60,
      r: 2.5 + hash2(i, 2207) * 5,
      sp: 0.5 + hash2(i, 2211) * 0.7,
      ph: hash2(i, 2213) * 20,
      jumpAt: 6 + hash2(i, 2217) * 14,
      jumpT: -1,
    });
  }
}

const _fq = new THREE.Quaternion();
const _fe = new THREE.Euler();
const _fm = new THREE.Matrix4();
const _fs = new THREE.Vector3();

export function updateAnimals(dt, night) {
  const p = G.player.pos;
  const sprinting = !!G.player.sprinting;
  for (let i = 0; i < deer.length; i++) updateDeerOne(deer[i], dt, p, sprinting);
  for (let i = 0; i < rabbits.length; i++) updateRabbitOne(rabbits[i], dt, p, night);

  // fish circle beneath the surface; now and then one leaps
  if (fishMesh) {
    let k = 0;
    for (let i = 0; i < fish.length; i++) {
      const f = fish[i];
      const t = G.time * f.sp + f.ph;
      const x = f.cx + Math.cos(t) * f.r;
      const z = f.cz + Math.sin(t) * f.r;
      if (heightAt(x, z) > WATER_Y - 0.8) continue; // circling into a shallow — skip draw
      let y = WATER_Y - 0.32;
      // leap: launch, arc, splash back in
      if (f.jumpT < 0 && !night && G.time > f.jumpAt) { f.jumpT = 0; }
      if (f.jumpT >= 0) {
        f.jumpT += dt;
        const jk = f.jumpT / 0.85;
        if (jk >= 1) {
          f.jumpT = -1;
          f.jumpAt = G.time + 7 + hash2((G.time * 3) | 0, i) * 16;
          spawnSparkle(x, WATER_Y + 0.1, z, 0xbfe8ff, 8, 2.2);
        } else {
          y = WATER_Y - 0.32 + Math.sin(jk * Math.PI) * 1.1;
          if (jk < 0.12 && f.jumpT - dt <= 0) spawnSparkle(x, WATER_Y + 0.1, z, 0xbfe8ff, 6, 1.8);
        }
      }
      const heading = -t + MODEL_FORWARD_TO_GAME_FORWARD;
      _fq.setFromEuler(_fe.set(f.jumpT >= 0 ? -Math.cos((f.jumpT / 0.85) * Math.PI) * 0.7 : 0, heading, 0, 'YXZ'));
      _fm.compose(tmpV.set(x, y, z), _fq, _fs.set(2.2, 0.8, 0.7));
      fishMesh.setMatrixAt(k++, _fm);
    }
    fishMesh.count = k;
    fishMesh.instanceMatrix.needsUpdate = true;
  }
}
