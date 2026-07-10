// Emberside — company at the fire.
//
// Linger near a lit hearth at night and its keeper notices: Tilla crosses
// her meadow to the meadow-hearth, Ilyra walks up the shore to the
// shore-fire. They sit (a lowered ease onto the log bench — their long
// robes make the pose honest), say one small thing keyed to the weather
// and the story, and stay as long as you do. Then they walk home.
import * as THREE from 'three';
import { G } from './state.js';
import { heightAt, toonMat } from './terrain.js';

const GATHERINGS = [
  {
    hearth: { x: 27, z: -106 },
    root: () => G.tillaRoot,
    promptLabel: 'Talk to Tilla',
    name: 'TILLA, THE GLEANER',
    seat: { dx: 1.7, dz: 0.4 },
    lines: [
      {
        when: () => G.weather && G.weather.wetness > 0.4,
        text: 'Roof of cloud tonight. Rain is just the sky gleaning — it drops what it can\'t carry. Sit; the fire doesn\'t mind either of us.',
      },
      {
        when: () => !!(G.story && G.story.flags && G.story.flags.finaleCompleted),
        text: 'I used to count the falling stones from my window. Now I count sparks going UP instead. You did that, you know. Same window.',
      },
      {
        when: () => true,
        text: 'The stores are full and the night is long and the fire is good. There are worse ways for a valley to end a day, wanderer.',
      },
    ],
  },
  {
    hearth: { x: -143, z: 111 },
    root: () => G.ilyraRoot,
    promptLabel: 'Talk to Ilyra Fen',
    name: 'ILYRA FEN, LANTERNKEEPER',
    seat: { dx: -1.7, dz: 0.5 },
    lines: [
      {
        when: () => G.weather && G.weather.windMul > 1.9,
        text: 'Hear the five of them holding in this wind? A lantern is just a promise with glass around it. Promises hold best in weather.',
      },
      {
        when: () => !!(G.story && G.story.flags && G.story.flags.finaleCompleted),
        text: 'The lake sleeps easier since the south went quiet. Some nights the moon-road lies down on the water for no reason at all. Just to be a road.',
      },
      {
        when: () => true,
        text: 'I keep the lanterns, the lanterns keep the lake, the lake keeps what it is given. Sit a while. Keeping is lighter in company.',
      },
    ],
  },
];

const states = []; // per gathering: {phase, home, yaw0, saidNight, seatPos, bench}
let built = false;

const isNightNow = () => G.dayTime < 0.21 || G.dayTime > 0.79;
const nightId = () => G.dayTime > 0.79 ? G.dayCount : G.dayCount - 1;

function buildBenches() {
  built = true;
  for (const gathering of GATHERINGS) {
    const { x, z } = gathering.hearth;
    const sx = x + gathering.seat.dx * 1.35, sz = z + gathering.seat.dz * 1.35;
    const y = heightAt(sx, sz);
    const bench = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.18, 1.6, 6), toonMat({ color: 0x5a4028 }));
    bench.rotation.z = Math.PI / 2;
    bench.rotation.y = Math.atan2(x - sx, z - sz) + Math.PI / 2;
    bench.position.set(sx, y + 0.18, sz);
    bench.castShadow = true;
    G.scene.add(bench);
    states.push({
      gathering, phase: 'home', home: null, yaw0: 0, saidNight: -99,
      seatPos: new THREE.Vector3(sx, y, sz), lingerT: 0,
    });
  }
}

function promptFor(state) {
  return G.interactables.find(i => i.label === state.gathering.promptLabel);
}

function updateOne(state, dt) {
  const root = state.gathering.root();
  if (!root) return;
  const p = G.player.pos;
  const h = state.gathering.hearth;
  const playerNear = Math.hypot(p.x - h.x, p.z - h.z) < 7;
  const wantCompany = playerNear && isNightNow() && !G.bloodNight;

  if (state.phase === 'home') {
    if (!state.home) {
      state.home = root.position.clone();
      state.yaw0 = root.rotation.y;
    }
    if (wantCompany) {
      state.lingerT += dt;
      if (state.lingerT > 3) { state.phase = 'walking'; state.lingerT = 0; }
    } else state.lingerT = 0;
    return;
  }

  const it = promptFor(state);
  if (state.phase === 'walking' || state.phase === 'leaving') {
    const target = state.phase === 'walking' ? state.seatPos : state.home;
    const dx = target.x - root.position.x, dz = target.z - root.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.4) {
      if (state.phase === 'walking') state.phase = 'seated';
      else { state.phase = 'home'; root.rotation.y = state.yaw0; }
    } else {
      const step = Math.min(dist, 1.15 * dt);
      root.position.x += (dx / dist) * step;
      root.position.z += (dz / dist) * step;
      root.position.y = heightAt(root.position.x, root.position.z);
      root.rotation.y = Math.atan2(dx, dz);
    }
    if (it) it.pos.set(root.position.x, root.position.y + 1, root.position.z);
    return;
  }

  if (state.phase === 'seated') {
    // the ease onto the bench: lowered, leaning a touch toward the flame
    const ground = heightAt(state.seatPos.x, state.seatPos.z);
    root.position.set(state.seatPos.x, ground - 0.32, state.seatPos.z);
    root.rotation.y = Math.atan2(h.x - state.seatPos.x, h.z - state.seatPos.z);
    if (it) it.pos.set(root.position.x, ground + 0.8, root.position.z);
    // one small thing, once a night
    const n = nightId();
    if (state.saidNight !== n) {
      state.saidNight = n;
      const line = state.gathering.lines.find(l => l.when());
      if (line && G.ui) G.ui.dialog(state.gathering.name, line.text, false);
      if (G.audio) G.audio.sfx('ui_open');
    }
    if (!wantCompany) {
      state.phase = 'leaving';
      root.position.y = heightAt(root.position.x, root.position.z);
    }
  }
}

export function updateEmberside(dt = 0) {
  if (!G.started || !G.scene) return;
  if (!built) buildBenches();
  const step = Math.min(Number.isFinite(dt) && dt > 0 ? dt : 0, 0.05);
  for (const state of states) updateOne(state, step);
}

export function getEmbersideSummary() {
  return states.map(s => ({
    who: s.gathering.name.split(',')[0],
    phase: s.phase,
    saidNight: s.saidNight,
  }));
}
