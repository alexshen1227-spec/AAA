// HeroRig: presentation-only rigged KayKit Knight that replaces the
// procedural blocky hero once the GLB arrives. The Player class keeps
// owning ALL simulation — this class only reads player state each frame
// and drives an AnimationMixer plus a few post-mixer bone overlays.
// If the model never loads (file://, offline, bad fetch) the Player keeps
// its procedural body; nothing in here throws or blocks boot.
//
// Determinism: the mixer advances with the exact sim dt the player was
// stepped with (never wall clock), all overlays are driven by sim state or
// G.time, and the update path allocates nothing on the heap.
import * as THREE from 'three';
import { G } from './state.js';
import { preloadModels, instantiate, findClip } from './assets.js';
import { toonGradient } from './terrain.js';
import { rimToon } from './player.js';
import { clamp } from './noise.js';

// module-scope temps (no per-frame allocation)
const M1 = new THREE.Matrix4(), M2 = new THREE.Matrix4();
const V1 = new THREE.Vector3(), V2 = new THREE.Vector3();
const Q1 = new THREE.Quaternion(), Q2 = new THREE.Quaternion();
const E1 = new THREE.Euler();
const AXIS = new THREE.Vector3();
const BOX = new THREE.Box3();

// KayKit props the knight doesn't use (he keeps 1H_Sword, Round_Shield and
// his helmet; the rigid Knight_Cape is swapped for the fluttering cloth cape)
const HIDE = ['1H_Sword_Offhand', '2H_Sword', 'Badge_Shield', 'Rectangle_Shield', 'Spike_Shield'];

// state -> clip. Several states intentionally share a clip; the mixer caches
// one action per clip, so shared states hand off without any crossfade pop.
const CLIPS = {
  idle: 'Idle',
  walk: 'Walking_A',
  carrywalk: 'Walking_B',
  run: 'Running_A',
  sprint: 'Running_B',
  jump: 'Jump_Start',
  fall: 'Jump_Idle',
  glide: 'Jump_Idle',
  climb: 'Jump_Idle',
  mantle: 'Jump_Idle',
  swim: 'Walking_A',
  land: 'Jump_Land',
  attack0: '1H_Melee_Attack_Slice_Horizontal',
  attack1: '1H_Melee_Attack_Slice_Diagonal',
  attack2: '1H_Melee_Attack_Chop',
  hurt: 'Hit_A',
  death: 'Death_A',
  pickup: 'PickUp',
  throw: 'Throw',
};
const ONE_SHOTS = ['jump', 'land', 'attack0', 'attack1', 'attack2', 'hurt', 'death', 'pickup', 'throw'];
const ATTACKS = ['attack0', 'attack1', 'attack2'];

// rotate a bone about the character's local X axis (call AFTER mixer.update
// so it composes with the playing clip; pivot stays at the bone origin)
function leanBone(bone, group, angle) {
  if (!bone || !bone.parent) return;
  AXIS.set(1, 0, 0).applyQuaternion(group.quaternion);  // hero sideways axis, world space
  bone.parent.getWorldQuaternion(Q2).invert();
  AXIS.applyQuaternion(Q2);                             // -> bone-parent local space
  Q1.setFromAxisAngle(AXIS, angle);
  bone.quaternion.premultiply(Q1);
}

export class HeroRig {
  constructor() {
    this.ready = false;
    this.onReady = null;      // player assigns; fired once after a successful build
    this.onFail = null;       // fired when the GLB can't be used (fallback body shows)
    this.container = null;    // scaled Group the player adds to its outer group
    this.mixer = null;
    this.actions = {};
    this.state = 'idle';
    this.cur = null;          // current AnimationAction
    this.baseScale = 1;
    this.durJump = 0.6;

    // bones & mounts (resolved by traversal at build time)
    this.chest = null; this.spine = null;
    this.upperarmL = null; this.upperarmR = null;
    this.handslotR = null; this.handslotL = null;
    this.swordNode = null;
    this.backMount = null;    // scabbard frame on the chest bone
    this.capeMount = null;    // chest-following frame aligned with the group
    this.swordHomePos = new THREE.Vector3();
    this.swordHomeQuat = new THREE.Quaternion();

    // per-frame edge trackers
    this.prevMode = 'ground';
    this.prevIframes = 0;
    this.prevVelY = 0;
    this.prevHeld = false;
    this.hurtT = 0;
    this.landT = 0;
    this.pickupT = 0;
    this.climbPhase = 0;

    preloadModels(['knight']).then((res) => {
      if (!res || !res.knight) { this._fail(); return; }  // download failed
      try {
        this._build();
        if (!this.ready) this._fail();  // built but refused (missing clips)
      } catch (e) {
        console.warn('hero rig build failed, keeping procedural hero:', e);
        this._fail();
      }
    }).catch(() => this._fail());
  }

  _fail() {
    if (this.ready) return;
    if (this.onFail) this.onFail();
  }

  _build() {
    const inst = instantiate('knight');
    if (!inst) return;
    const root = inst.root, clips = inst.clips;
    // refuse to swap if the core clips are missing — never risk a T-posing hero
    if (!findClip(clips, 'Idle') || !findClip(clips, 'Walking_A')) return;

    // --- measure & scale: standing height ~1.75m, feet at y=0 ------------
    // skinned bind-space bounds == model space (mesh nodes sit at identity),
    // and the bind pose is upright, so Y extent is the standing height
    BOX.makeEmpty();
    root.traverse((o) => {
      if (o.isSkinnedMesh) {
        if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
        BOX.union(o.geometry.boundingBox);
      }
    });
    if (BOX.isEmpty()) return;
    const h0 = Math.max(0.1, BOX.max.y - BOX.min.y);
    const s = 1.75 / h0;
    this.baseScale = s;
    root.position.y = -BOX.min.y;       // feet on the origin plane
    const container = new THREE.Group();
    container.name = 'heroRig';
    container.add(root);
    container.scale.setScalar(s);
    this.container = container;

    // --- materials: toon + pale fresnel rim, shadows, no culling pop -----
    const converted = {};               // src material uuid -> shared toon material
    root.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        if (o.isSkinnedMesh) o.frustumCulled = false;  // bind-pose bbox lies off-screen
        const src = o.material;
        if (src && src.isMaterial) {
          if (!converted[src.uuid]) {
            const m = new THREE.MeshToonMaterial({
              map: src.map || null,
              color: src.color ? src.color.clone() : new THREE.Color(0xffffff),
              gradientMap: toonGradient,
            });
            converted[src.uuid] = rimToon(m, 0.22);
          }
          o.material = converted[src.uuid];
        }
        if (HIDE.indexOf(o.name) !== -1) o.visible = false;
      }
      // bones / prop nodes (verified names, with a loose fallback)
      const n = o.name;
      if (n === 'handslot.r') this.handslotR = o;
      else if (n === 'handslot.l') this.handslotL = o;
      else if (n === 'chest') this.chest = o;
      else if (n === 'spine') this.spine = o;
      else if (n === 'upperarm.l') this.upperarmL = o;
      else if (n === 'upperarm.r') this.upperarmR = o;
      else if (n === '1H_Sword') this.swordNode = o;
    });
    if (!this.handslotR || !this.handslotL) {
      root.traverse((o) => {
        const n = o.name.toLowerCase();
        if (n.indexOf('handslot') !== -1) {
          if (!this.handslotR && /r$/.test(n)) this.handslotR = o;
          else if (!this.handslotL && /l$/.test(n)) this.handslotL = o;
        }
      });
    }

    // --- mounts on the chest bone ----------------------------------------
    // container is still detached, so matrixWorld below is group-relative
    if (this.chest) {
      container.updateMatrixWorld(true);
      // back scabbard: the same frame the procedural hero used for its
      // on-back sword (grip by the right shoulder, blade diagonal down-left).
      // The KayKit sword's blade runs along +Y of its slot frame, exactly
      // like the procedural blade did, so the same rotation reads the same.
      this.backMount = new THREE.Object3D();
      this.backMount.name = 'swordBackMount';
      this.chest.add(this.backMount);
      M1.copy(this.chest.matrixWorld).invert();
      Q1.setFromEuler(E1.set(0, 0, 2.45));
      M2.compose(V1.set(0.16, 1.18, -0.28), Q1, V2.set(s, s, s));
      M1.multiply(M2);
      M1.decompose(this.backMount.position, this.backMount.quaternion, this.backMount.scale);
      // cape mount: chest-following frame that matches the hero group's axes
      // and unit world scale at bind, so the procedural cloth cape reparents
      // here unchanged and its rotation.x flutter keeps meaning what it meant
      this.capeMount = new THREE.Object3D();
      this.capeMount.name = 'capeMount';
      this.chest.add(this.capeMount);
      M1.copy(this.chest.matrixWorld).invert();
      M1.decompose(this.capeMount.position, this.capeMount.quaternion, this.capeMount.scale);
      // the cloth cape replaces KayKit's rigid one
      const rigidCape = root.getObjectByName('Knight_Cape');
      if (rigidCape) rigidCape.visible = false;
    }

    // --- sword home (as authored in the right hand slot) ------------------
    if (this.swordNode) {
      this.swordHomePos.copy(this.swordNode.position);
      this.swordHomeQuat.copy(this.swordNode.quaternion);
    }

    // --- animation actions -------------------------------------------------
    this.mixer = new THREE.AnimationMixer(root);
    const durs = {};
    for (const st in CLIPS) {
      const clip = findClip(clips, CLIPS[st]);
      if (!clip) continue;              // missing clip: that state degrades gracefully
      this.actions[st] = this.mixer.clipAction(clip);  // cached per clip -> shared actions
      durs[st] = clip.duration;
    }
    for (let i = 0; i < ONE_SHOTS.length; i++) {
      const a = this.actions[ONE_SHOTS[i]];
      if (!a) continue;
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;       // hold the last frame; never dissolve to T-pose
    }
    // attacks compress so the blade's contact frame lands near the game's
    // hit check at attackT = 0.12s (whole swing ~0.45s)
    for (let i = 0; i < ATTACKS.length; i++) {
      const a = this.actions[ATTACKS[i]];
      if (a) a.timeScale = durs[ATTACKS[i]] / 0.45;
    }
    if (this.actions.hurt) this.actions.hurt.timeScale = durs.hurt / 0.4;
    if (this.actions.land) this.actions.land.timeScale = durs.land / 0.3;
    if (this.actions.jump) this.actions.jump.timeScale = durs.jump / 0.45;
    if (this.actions.pickup) this.actions.pickup.timeScale = durs.pickup / 0.5;
    if (this.actions.throw) this.actions.throw.timeScale = durs.throw / 0.6;
    this.durJump = durs.jump || 0.6;

    // start in idle and snap the pose so the swap never shows a T-pose
    this.state = 'idle';
    this.cur = this.actions.idle;
    this.cur.play();
    this.mixer.update(0.001);
    this.swordOnBack();

    this.ready = true;
    if (this.onReady) this.onReady();
  }

  // ---- sword slots (player's swordOnBack/swordInHand forward here) -------

  swordInHand() {
    const sw = this.swordNode;
    if (!sw || !this.handslotR) return;
    this.handslotR.add(sw);
    sw.position.copy(this.swordHomePos);
    sw.quaternion.copy(this.swordHomeQuat);
  }

  swordOnBack() {
    const sw = this.swordNode;
    if (!sw || !this.backMount) return;
    this.backMount.add(sw);
    sw.position.copy(this.swordHomePos);
    sw.quaternion.copy(this.swordHomeQuat);
  }

  // ---- death: player updates stop while G.gameOver, so bake the fall now
  // (fixed sub-steps -> deterministic) and clampWhenFinished holds the pose
  beginDeath() {
    if (!this.ready) return;
    this.setState('death', 0.1);
    for (let i = 0; i < 12; i++) this.mixer.update(0.09);
  }

  // ---- state machine -------------------------------------------------------

  setState(name, fade) {
    if (name === this.state) return;
    const next = this.actions[name];
    this.state = name;
    if (!next) return;                  // clip missing: keep whatever is playing
    if (next === this.cur) return;      // states sharing a clip hand off for free
    next.reset();
    next.play();
    if (this.cur) this.cur.crossFadeTo(next, fade, false);
    else next.fadeIn(fade);
    this.cur = next;
  }

  // p is the Player instance (sim owner); read-only here
  update(dt, p) {
    if (!this.ready) return;
    const g = p.group;
    const m = p.mode;
    const speed = Math.hypot(p.vel.x, p.vel.z);
    const heldNow = !!p.held;

    // --- one-shot triggers (pure edge detection off sim state) ------------
    if (p.iframes > this.prevIframes + 0.4) this.hurtT = 0.34;   // damage() just fired
    this.prevIframes = p.iframes;
    if (this.hurtT > 0) this.hurtT -= dt;
    if (heldNow && !this.prevHeld) this.pickupT = 0.45;          // fresh grab
    if (!heldNow) this.pickupT = 0;
    this.prevHeld = heldNow;
    if (this.pickupT > 0) this.pickupT -= dt;
    if (m === 'ground' && (this.prevMode === 'air' || this.prevMode === 'glide'))
      this.landT = p.landSquash > 0.03 ? 0.26 : 0.13;            // brief touchdown pose
    if (m !== 'ground') this.landT = 0;
    else if (this.landT > 0) this.landT -= dt;

    // --- desired state ------------------------------------------------------
    let st, fade = 0.16;
    if (G.gameOver) { st = 'death'; fade = 0.1; }
    else if (this.hurtT > 0) { st = 'hurt'; fade = 0.08; }       // damage interrupts anything
    else if (p.attackT >= 0) { st = ATTACKS[p.combo % 3]; fade = 0.1; }
    else if (p.throwT >= 0) { st = 'throw'; fade = 0.08; }
    else if (this.pickupT > 0 && m === 'ground') { st = 'pickup'; fade = 0.1; }
    else if (m === 'climb') st = 'climb';
    else if (m === 'glide') st = 'glide';
    else if (m === 'swim') st = 'swim';
    else if (m === 'mantle') { st = 'mantle'; fade = 0.12; }
    else if (m === 'air') {
      fade = 0.12;
      // fresh launch (jump / climb-jump / bellows toss) -> Jump_Start intro
      if (p.vel.y > 5 && p.vel.y > this.prevVelY + 4) st = 'jump';
      else if (this.state === 'jump' && p.vel.y > -0.5 &&
               this.actions.jump && this.actions.jump.time < this.durJump - 0.05) st = 'jump';
      else st = 'fall';
    } else { // ground locomotion
      if (this.landT > 0 && speed < 4 && !heldNow) { st = 'land'; fade = 0.08; }
      else if (speed < 0.35 && p.moveInput === 0) st = 'idle';
      else if (p.sprinting) st = 'sprint';
      else if (speed < 4) st = heldNow ? 'carrywalk' : 'walk';
      else st = heldNow ? 'carrywalk' : 'run';
    }

    // gait speeds track the sim, never wall clock
    const a = this.actions[st];
    if (a) {
      if (st === 'run') a.timeScale = clamp(speed / 9, 0.55, 1.45);
      else if (st === 'sprint') a.timeScale = clamp(speed / 9, 0.8, 1.5);
      else if (st === 'walk' || st === 'carrywalk') a.timeScale = clamp(speed / 4.5, 0.55, 1.7);
      else if (st === 'swim') a.timeScale = 0.6;
      else if (st === 'idle' || st === 'fall' || st === 'glide' ||
               st === 'climb' || st === 'mantle') a.timeScale = 1;
    }

    this.setState(st, fade);

    // combat hit-stop freezes the swing exactly like the sim freezes attackT
    if (this.cur) this.cur.paused = p.hitStop > 0 && ATTACKS.indexOf(this.state) !== -1;

    this.mixer.update(dt);

    // --- post-mixer bone overlays (compose with the clip; subtle) ----------
    if (m === 'climb') {
      // alternate arm reach driven by actual climb movement
      this.climbPhase += dt * 5 * Math.min(1, p.moveInput * 1.6);
      const sw = Math.sin(this.climbPhase);
      leanBone(this.upperarmL, g, -(0.85 + sw * 0.45));
      leanBone(this.upperarmR, g, -(0.85 - sw * 0.45));
      leanBone(this.spine, g, 0.14);                    // hug the wall
    } else if (m === 'mantle') {
      const prog = clamp(p.mantleT / 0.35, 0, 1);
      const reach = -(1.15 - prog * 1.0);               // reach up -> push down
      leanBone(this.upperarmL, g, reach);
      leanBone(this.upperarmR, g, reach);
    } else if (m === 'glide') {
      leanBone(this.spine, g, -0.22);                   // hang back under the canopy
    } else if (m === 'swim') {
      // alternating overarm strokes layered over the base clip
      const f = G.time * (p.moveInput > 0 ? 5.5 : 2.2);
      leanBone(this.upperarmL, g, -(1.0 + Math.sin(f) * 0.75));
      leanBone(this.upperarmR, g, -(1.0 + Math.sin(f + Math.PI) * 0.75));
      leanBone(this.spine, g, -0.1);                    // keep the head above water
    } else if (p.aiming && m === 'ground') {
      // archer's draw: bow arm out, string hand at the cheek
      leanBone(this.upperarmL, g, -1.25);
      leanBone(this.upperarmR, g, -1.0);
      leanBone(this.spine, g, 0.05);
    } else if (p.exhausted && m === 'ground') {
      const still = 1 - clamp(speed / 3, 0, 1);         // weary idle sway
      if (still > 0.01) leanBone(this.spine, g, (0.1 + Math.sin(G.time * 2.2) * 0.05) * still);
    }

    // landing squash pinches the whole rig from the feet
    const sq = p.landSquash, s = this.baseScale;
    if (sq > 0.001) {
      this.container.scale.set(s * (1 + 0.08 * sq), s * (1 - 0.16 * sq), s * (1 + 0.08 * sq));
    } else if (this.container.scale.y !== s) {
      this.container.scale.setScalar(s);
    }

    this.prevMode = m;
    this.prevVelY = p.vel.y;
  }
}
