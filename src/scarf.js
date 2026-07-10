// The Wayfarer's Scarf — the wind, rendered on your own silhouette.
//
// A long ochre scarf pinned at the hero's neck: a six-point verlet chain
// driven by player velocity, the ambient wind heading, and storm gusts. It
// hangs heavy in the rain, and floats weightless inside the Hush. No rig
// surgery: the pin follows the body root, which is all the neck ever does.
import * as THREE from 'three';
import { G } from './state.js';
import { toonMat } from './terrain.js';

const N = 7;            // chain points (6 segments)
const SEG = 0.21;       // rest length per segment
const WIDTHS = [0.13, 0.12, 0.105, 0.09, 0.075, 0.06, 0.045];

let built = false;
const points = [];      // THREE.Vector3 current
const prev = [];        // previous (verlet)
let mesh = null;
let positions = null;
const _anchor = new THREE.Vector3();
const _wind = new THREE.Vector3();
const _side = new THREE.Vector3();
const _seg = new THREE.Vector3();

function build() {
  built = true;
  for (let i = 0; i < N; i++) {
    points.push(new THREE.Vector3(0, 1.45 - i * SEG, 0));
    prev.push(points[i].clone());
  }
  // a ribbon: two vertices per chain point
  const geo = new THREE.BufferGeometry();
  positions = new Float32Array(N * 2 * 3);
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const index = [];
  for (let i = 0; i < N - 1; i++) {
    const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
    index.push(a, b, c, b, d, c);
  }
  geo.setIndex(index);
  const mat = toonMat({ color: 0xd88a3a }); // wayfarer ochre
  mat.side = THREE.DoubleSide;
  mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; // follows the hero; culling would pop it
  mesh.castShadow = true;
  G.scene.add(mesh);
}

function anchorPoint(out) {
  const P = G.player;
  // nape of the neck: up from the root, a half-step behind the facing
  const yaw = P.yaw !== undefined ? P.yaw : 0;
  return out.set(
    P.pos.x - Math.sin(yaw) * 0.16,
    P.pos.y + 1.42,
    P.pos.z - Math.cos(yaw) * 0.16);
}

export function updateScarf(dt = 0) {
  if (!G.started || !G.player || !G.scene) return;
  if (!built) build();
  const step = Math.min(Number.isFinite(dt) && dt > 0 ? dt : 0, 0.05);
  if (step <= 0) return;

  anchorPoint(_anchor);
  points[0].copy(_anchor);
  prev[0].copy(_anchor);

  const w = G.weather || {};
  const wet = w.wetness || 0;
  const hush = G.hushK || 0;
  const windMul = w.windMul || 1;
  // ambient stream + gusts push the cloth; your own speed streams it back
  _wind.set(
    (w.windDx || 0) * windMul * 1.1 + (w.gustDx || 0) * (w.gustPulse || 0) * 9
      - G.player.vel.x * 0.85,
    0,
    (w.windDz || 0) * windMul * 1.1 + (w.gustDz || 0) * (w.gustPulse || 0) * 9
      - G.player.vel.z * 0.85);
  const gravity = -9 * (1 + wet * 0.8) * (1 - hush * 0.85);
  const damping = 1 - (0.06 + wet * 0.1);
  const dt2 = step * step;

  for (let i = 1; i < N; i++) {
    const p = points[i], q = prev[i];
    const vx = (p.x - q.x) * damping;
    const vy = (p.y - q.y) * damping;
    const vz = (p.z - q.z) * damping;
    q.copy(p);
    // segments further from the pin feel the wind more (they are freer)
    const reach = i / (N - 1);
    p.x += vx + (_wind.x * (0.5 + reach)) * dt2 * 8;
    p.y += vy + gravity * dt2;
    p.z += vz + (_wind.z * (0.5 + reach)) * dt2 * 8;
    // a small life of its own
    p.x += Math.sin(G.time * 3.1 + i) * dt2 * 2;
  }
  // two constraint passes keep the chain honest without stretch
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < N; i++) {
      _seg.subVectors(points[i], points[i - 1]);
      const d = _seg.length() || 1e-5;
      const err = (d - SEG) / d;
      if (i === 1) points[i].addScaledVector(_seg, -err);
      else {
        points[i - 1].addScaledVector(_seg, err * 0.5);
        points[i].addScaledVector(_seg, -err * 0.5);
      }
    }
    points[0].copy(_anchor);
  }

  // ribbon vertices: widen perpendicular to each segment, camera-agnostic
  for (let i = 0; i < N; i++) {
    const dir = i === 0
      ? _seg.subVectors(points[1], points[0])
      : _seg.subVectors(points[i], points[i - 1]);
    _side.set(-dir.z, 0, dir.x).normalize().multiplyScalar(WIDTHS[i] * 0.5);
    if (!Number.isFinite(_side.x)) _side.set(WIDTHS[i] * 0.5, 0, 0);
    const p = points[i];
    positions[i * 6] = p.x - _side.x;
    positions[i * 6 + 1] = p.y;
    positions[i * 6 + 2] = p.z - _side.z;
    positions[i * 6 + 3] = p.x + _side.x;
    positions[i * 6 + 4] = p.y;
    positions[i * 6 + 5] = p.z + _side.z;
  }
  mesh.geometry.attributes.position.needsUpdate = true;
  mesh.visible = !G.cinematic || true; // the scarf belongs in cutscenes too
}

export function getScarfSummary() {
  return built ? {
    tip: points[N - 1].toArray().map(v => +v.toFixed(2)),
    anchor: points[0].toArray().map(v => +v.toFixed(2)),
    spread: +points[0].distanceTo(points[N - 1]).toFixed(2),
  } : { built };
}
