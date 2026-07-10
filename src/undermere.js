// The Under-Mere — Maerwen's half-sunken workshop on the Mirrormere's west
// shore. A sealed warden door faces the water; it opens only while the
// moon-road shines (all five lanterns lit, reported to Ilyra, at night).
// Inside the broken dome: her desk, a drawer of three letters she wrote and
// never sent, and the Skysong Fork — a relic that, struck, makes everything
// unfound nearby ring in the dark.
//
// The letters were written before the rooms, as ordered.
import * as THREE from 'three';
import { G, save } from './state.js';
import { heightAt, slopeAt, WATER_Y, toonMat } from './terrain.js';
import { spawnSparkle, markSeen, registerStandSurface } from './world.js';

const UNSENT = [
  {
    id: 'undermere1', title: 'Unsent — to the First',
    text: '"Sister of the plateau light — I never told you this. In the dark years I crossed the water by your beacon, every crossing, every winter. I charted my whole life by you and called it geography. If I sent this you would only say: that is what a light is FOR. So I will not send it. Some debts are better kept lit."',
  },
  {
    id: 'undermere2', title: 'Unsent — to the Fifth',
    text: '"To the keeper of the great horn. You said the works should be left to sleep, and I called you sentimental, and we did not speak for a season. You were right. The bellows still holds the shape of your breath, and I still hold the shape of that quarrel. I have written sorry a hundred ways and posted none of them. The wind was kinder than my pride. It carried nothing."',
  },
  {
    id: 'undermere3', title: 'Unsent — to the Ninth',
    text: '"I do not know your name. I have started this letter a hundred times and the name is always the empty place on the page, the way your seat is the empty place at the Coil. I know only that you will come when we are past mending — that is how keeping works; it skips a hand. Forgive us the state of the house. The lanterns want kindling, the gates want wind, and the storm... the storm wants what storms always want: to be heard out. Hear it out. Then still it. — M."',
  },
];

let built = false;
let site = null; // {x, z, y}
let door = null; // {slab, open, target}
let drawer = null;
let forkTaken = () => (Number(G.items.fork) || 0) > 0 || !!G.seen.fork;
let forkChimeAt = 0;

const flag = id => !!(G.story && G.story.flags && G.story.flags[id]);
const roadOpen = () => flag('lanternsReported') && (G.dayTime < 0.21 || G.dayTime > 0.79);

function findSite() {
  // west shore, above the waterline, gentle ground
  for (let attempt = 0; attempt < 40; attempt++) {
    const a = Math.PI - 0.35 + (attempt % 8) * 0.09;      // west-ish arc of the lake
    const r = 88 + (attempt / 8 | 0) * 8;
    const x = -170 + Math.cos(a) * r, z = 120 + Math.sin(a) * r;
    const y = heightAt(x, z);
    if (y < WATER_Y + 0.8 || y > 14 || slopeAt(x, z) > 0.4) continue;
    return { x, z, y };
  }
  return { x: -262, z: 104, y: Math.max(WATER_Y + 1, heightAt(-262, 104)) };
}

function buildUnderMere() {
  built = true;
  site = findSite();
  const { x, z, y } = site;
  const stone = toonMat({ color: 0x8a8790 });
  const stoneDark = toonMat({ color: 0x6d6a74 });
  const wood = toonMat({ color: 0x5c4632 });
  const faceLake = Math.atan2(-170 - x, 120 - z);

  // the broken dome: a ring of leaning wall slabs, open above, one doorway
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.rotation.y = faceLake;
  for (let i = 0; i < 8; i++) {
    if (i === 0) continue; // the doorway gap faces the lake
    const a = (i / 8) * Math.PI * 2;
    const wall = new THREE.Mesh(new THREE.BoxGeometry(4.6, 4.0 - (i % 3) * 0.7, 0.7), stone);
    wall.position.set(Math.sin(a) * 5.6, (4.0 - (i % 3) * 0.7) / 2, Math.cos(a) * 5.6);
    wall.rotation.y = a;
    wall.rotation.x = (i % 2 ? 0.06 : -0.05);
    wall.castShadow = wall.receiveShadow = true;
    group.add(wall);
    G.colliders.push({
      x: x + Math.sin(a + faceLake) * 5.6, z: z + Math.cos(a + faceLake) * 5.6,
      r: 2.1, top: y + 4,
    });
  }
  // waterline stain: the mere once stood higher here
  const stain = new THREE.Mesh(
    new THREE.CylinderGeometry(6.05, 6.05, 0.5, 18, 1, true),
    new THREE.MeshBasicMaterial({ color: 0x3d4a4e, transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
  stain.position.y = 1.7;
  group.add(stain);
  // dark seeped floor
  const floor = new THREE.Mesh(new THREE.CircleGeometry(5.8, 18),
    new THREE.MeshBasicMaterial({ color: 0x2c3236, transparent: true, opacity: 0.5 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.05;
  group.add(floor);

  // her desk, her chair, the drawer, the fork's small pedestal
  const desk = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.14, 1.0), wood);
  desk.position.set(0, 1.0, -3.6);
  const legs = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.9, 0.8), stoneDark);
  legs.position.set(0, 0.5, -3.6);
  const chair = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.1, 0.6), wood);
  chair.position.set(1.5, 0.55, -3.2);
  desk.castShadow = legs.castShadow = chair.castShadow = true;
  group.add(desk, legs, chair);
  const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.36, 1.1, 8), stoneDark);
  pedestal.position.set(-2.6, 0.55, -2.6);
  pedestal.castShadow = true;
  group.add(pedestal);
  const forkMesh = new THREE.Group();
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.045, 0.5, 6), toonMat({ color: 0x4fa385 }));
  for (const s of [-1, 1]) {
    const tine = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.45, 5), toonMat({ color: 0x4fa385 }));
    tine.position.set(0.07 * s, 0.42, 0);
    forkMesh.add(tine);
  }
  forkMesh.add(stem);
  forkMesh.position.set(-2.6, 1.35, -2.6);
  group.add(forkMesh);
  G.scene.add(group);
  registerStandSurface({ x, z, r: 5.6, top: y + 0.05 });

  // the sealed door: a slab that sinks into the shore when the road shines
  const slab = new THREE.Mesh(new THREE.BoxGeometry(3.4, 4.0, 0.5), stoneDark);
  const doorX = x + Math.sin(faceLake) * 5.6, doorZ = z + Math.cos(faceLake) * 5.6;
  slab.position.set(doorX, y + 2.0, doorZ);
  slab.rotation.y = faceLake;
  slab.castShadow = true;
  G.scene.add(slab);
  const collider = { x: doorX, z: doorZ, r: 1.7, top: y + 4 };
  G.colliders.push(collider);
  door = { slab, collider, openK: 0, baseY: y + 2.0 };

  G.interactables.push({
    id: 'undermere_door', pos: new THREE.Vector3(doorX, y + 1.4, doorZ), r: 3.2,
    label: 'A sealed warden door',
    onUse() {
      if (door.openK > 0.9) return;
      if (!flag('lanternsReported')) {
        G.ui.dialog('THE SEALED DOOR',
          'Five lantern-marks ring its face, all dark. The lake is keeping something until its road returns.', false);
      } else {
        G.ui.dialog('THE SEALED DOOR',
          'Five lantern-marks ring its face, all lit. It is waiting for the road — come back when the moon lies on the water.', false);
      }
      G.audio.sfx('lock');
    },
  });

  // the drawer of unsent letters
  let read = UNSENT.filter(l => G.lore[l.id]).length;
  drawer = {
    it: {
      id: 'undermere_drawer',
      pos: new THREE.Vector3(x + Math.sin(faceLake + Math.PI) * 3.4, y + 1.0,
        z + Math.cos(faceLake + Math.PI) * 3.4),
      r: 2.8, label: read >= 3 ? 'Her letters, resting' : 'Open the letter drawer',
      onUse() {
        const next = UNSENT.find(l => !G.lore[l.id]);
        if (!next) {
          G.ui.dialog('THE LETTER DRAWER',
            'Three letters, read and returned. The drawer closes more easily than it opened.', false);
          return;
        }
        G.lore[next.id] = true;
        G.ui.dialog('A LETTER, NEVER SENT', next.text, false);
        G.ui.toast('✉ Chronicle — ' + next.title, 0xbfe8ff, 4600);
        G.audio.sfx('glimmer');
        const left = UNSENT.filter(l => !G.lore[l.id]).length;
        if (!left) drawer.it.label = 'Her letters, resting';
        save();
      },
    },
  };
  G.interactables.push(drawer.it);

  // the Skysong Fork — pedestal local (-2.6, -2.6) rotated into world space
  const px = x + (-2.6) * Math.cos(faceLake) + (-2.6) * Math.sin(faceLake);
  const pz = z - (-2.6) * Math.sin(faceLake) + (-2.6) * Math.cos(faceLake);
  const forkIt = {
    id: 'undermere_fork',
    pos: new THREE.Vector3(px, y + 1.2, pz),
    r: 2.6, label: 'Take the Skysong Fork',
    onUse() {
      if (forkTaken()) {
        G.ui.dialog('THE EMPTY PEDESTAL', 'The fork rides in your satchel now. The pedestal keeps its shape of it.', false);
        return;
      }
      G.items.fork = 1;
      markSeen('fork');
      forkMesh.visible = false;
      spawnSparkle(forkIt.pos.x, forkIt.pos.y + 0.6, forkIt.pos.z, 0x9fe8d8, 30, 3.5);
      G.audio.chord([440, 660, 880], 0.09, 0.3);
      G.ui.toast('The Skysong Fork — strike it, and the unfound will answer.', 0x9fe8d8, 5600);
      save();
    },
  };
  G.interactables.push(forkIt);
  if (forkTaken()) forkMesh.visible = false;
}

function updateDoor(dt) {
  if (!door) return;
  const want = roadOpen() ? 1 : 0;
  if (Math.abs(door.openK - want) < 0.01) return;
  const wasShut = door.openK < 0.1;
  door.openK += (want - door.openK) * Math.min(1, dt * 0.8);
  door.slab.position.y = door.baseY - door.openK * 3.6;
  door.collider.top = site.y + 4 - door.openK * 3.9;
  if (wasShut && want === 1 && G.player &&
      Math.hypot(G.player.pos.x - door.slab.position.x, G.player.pos.z - door.slab.position.z) < 40) {
    G.ui.toast('Stone grinds somewhere on the west shore — the mere is opening its door.', 0xbfe8ff, 5200);
    G.audio.sfx('grab');
  }
}

// the fork's answer: everything unfound nearby rings in the dark,
// nearest highest — capped so dense country never becomes chime soup
function updateForkSense() {
  if (!G.buffs || !(G.buffs.forkUntil > G.time)) return;
  if (G.time < forkChimeAt) return;
  forkChimeAt = G.time + 1.4;
  const p = G.player.pos;
  const found = [];
  for (const it of G.interactables) {
    if (it.gone || !it.pos) continue;
    if (it.label !== 'Open chest' && it.label !== 'Feel the high wind' &&
        it.label !== 'Stand in the sky') continue;
    const d = Math.hypot(it.pos.x - p.x, it.pos.z - p.z);
    if (d < 40) found.push(d);
  }
  found.sort((a, b) => a - b);
  found.slice(0, 3).forEach((d, i) => {
    const pitch = 880 - (d / 40) * 500; // near rings high
    G.audio.pianoNote(pitch, G.audio.ctx.currentTime + i * 0.22, 0.05, 1.6);
  });
}

export function updateUnderMere(dt = 0) {
  if (!G.started || !G.scene) return;
  const step = Math.min(Number.isFinite(dt) && dt > 0 ? dt : 0, 0.05);
  if (!built) buildUnderMere();
  updateDoor(step);
  updateForkSense();
}

export function getUnderMereSummary() {
  return {
    built, site,
    doorOpen: door ? +door.openK.toFixed(2) : null,
    lettersRead: UNSENT.filter(l => G.lore[l.id]).length,
    forkTaken: forkTaken(),
  };
}
