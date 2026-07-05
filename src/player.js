// The hero: procedural low-poly character, third-person camera,
// and a BotW-style movement controller — sprint, jump, climb anything,
// paraglide, swim — all governed by a stamina wheel. Plus the grab ability.
import * as THREE from 'three';
import { G } from './state.js';
import { heightAt, slopeAt, normalAt, WATER_Y, toonMat } from './terrain.js';
import { clamp, lerp } from './noise.js';
import { settleCrate, spawnSparkle } from './world.js';
import { HeroRig } from './hero-rig.js';
import { preloadModels, propInstance } from './assets.js';

const V = () => new THREE.Vector3();
const tmp1 = V(), tmp2 = V(), tmp3 = V(), nrm = V();
const ray = new THREE.Raycaster();

// dedicated camera temps (updateCamera must not fight helpers over tmp1..3)
const CAM_OFF = V(), CAM_TGT = V(), CAM_POS = V();
// glider wind-streak trail temps
const UP = new THREE.Vector3(0, 1, 0);
const tmpQ = new THREE.Quaternion();
const tmpM = new THREE.Matrix4();
const tmpS = V();
const STREAK_N = 24;
const DUST = 0xcbb586;   // sandy dust for landings / footfalls

// TotK-style character rim light: a pale sky-blue view-dependent fresnel
// added into the toon material's outgoing light so the hero lifts softly
// off the background. Patches only the surface shader — the depth material
// is untouched, so shadow casting is unaffected. Runs once per material at
// compile time (no per-frame cost). Chains any onBeforeCompile the shared
// toonMat may already carry.
export function rimToon(mat, strength = 0.25, power = 2.8) {
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

export class Player {
  constructor() {
    this.pos = new THREE.Vector3(50, 0, -68);
    this.vel = V();
    this.yaw = 0;            // facing
    this.camYaw = 0.6;       // camera orbit
    this.camPitch = 0.32;
    this.mode = 'ground';    // ground | air | glide | climb | swim
    this.grounded = true;
    this.exhausted = false;
    this.staminaUse = 0;     // time since stamina last used
    this.iframes = 0;
    this.climbCooldown = 0;  // breather after stepping onto a ledge
    this.attackT = -1;       // attack timer, -1 idle
    this.combo = 0;
    this.stepPhase = 0;
    this.held = null;        // grabbed crate
    this.climbNormal = V(0, 0, 1);
    this.lockTarget = null;

    // --- traversal feel state ---
    this.coyoteT = 99;       // time since last grounded (jump grace)
    this.jumpBufT = 99;      // time since Space was freshly pressed
    this.prevSpaceKey = false;
    this.landSquash = 0;     // 0..1 landing crouch, decays in update
    this.mantleT = -1;       // animated mantle timer, -1 idle
    this.mantleFrom = V(); this.mantleTo = V();
    this.hitStop = 0;        // combat hit-stop remaining (freezes attackT)
    this.throwT = -1;        // throw pose timer
    this.sprinting = false;
    this.glideDive = false;
    this.glidePitch = 0.28;  // visual nose lean while gliding
    this.bank = 0;           // visual roll from turn rate
    this.prevGlideYaw = 0;
    this.inUpdraft = false;  // edge detect for updraft sfx
    this.exhaustDropT = 0;   // sweat-drop cadence while exhausted
    this.gripDustT = 0;      // climbing grip dust cadence
    // held-prop rotate input (R tap = 90° snap, R hold = free rotate)
    this.rHeldT = 0; this.rWasDown = false;
    this.rSnapT = -1; this.rSnapFrom = 0; this.rSnapTo = 0;
    // camera springs
    this.camDist = 6.4; this.camHeight = 2.2;
    this.camOccl = 1;        // smoothed terrain-occlusion pull factor
    this.camInit = false; this.camSnap = true; this.camPosSmooth = V();
    this.lookX = 0; this.lookZ = 0;
    this.baseFov = null;     // captured from G.camera on first frame
    this.fovKick = 0;

    // rigged KayKit knight (visual only; sim never depends on it). Until the
    // GLB loads — or if it never does — the procedural body below is shown.
    this.rigActive = false;
    this.moveInput = 0;      // last frame's input magnitude, read by the rig

    // --- bow & quiver ---
    this.aiming = false;
    this.aimT = 0;
    this.arrows = 20;
    this.arrowPool = [];
    this.shootCd = 0;

    this.bodyReady = false;  // no body shown until the rig loads or fails
    this.buildModel();
    this.buildBow();
    this.rig = new HeroRig();
    this.rig.onReady = () => this.attachRig();
    this.rig.onFail = () => { this.bodyReady = true; }; // procedural fallback
    this.pos.y = heightAt(this.pos.x, this.pos.z);
  }

  // ---- procedural hero model ------------------------------------------

  buildModel() {
    const g = new THREE.Group();
    // yaw first, THEN pitch/roll in the facing frame — with the default XYZ
    // order the swim/climb/glide lean rotated about the WORLD x-axis, which
    // turned into a sideways roll whenever the hero faced east or west
    g.rotation.order = 'YXZ';
    // stay hidden until the knight rig lands (or its load fails) — no
    // placeholder body flashing at spawn
    g.visible = false;
    const skin = rimToon(toonMat({ color: 0xf2cda6 }), 0.18);
    const tunic = rimToon(toonMat({ color: 0x2aa39a }), 0.28);  // teal adventurer's tunic
    const pants = rimToon(toonMat({ color: 0x97714a }), 0.24);
    const hairM = rimToon(toonMat({ color: 0x9a6230 }), 0.22);  // auburn hair

    // torso
    this.torso = new THREE.Group();
    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.72, 0.36), tunic);
    chest.position.y = 1.06;
    const belt = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.12, 0.38), rimToon(toonMat({ color: 0x63492c }), 0.2));
    belt.position.y = 0.72;
    this.torso.add(chest, belt);

    // head
    this.head = new THREE.Group();
    const skull = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.44, 0.42), skin);
    const hair = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.24, 0.48), hairM);
    hair.position.y = 0.18;
    const fringe = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.1), hairM);
    fringe.position.set(0, 0.1, 0.2);
    const eyeL = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.08, 0.02), new THREE.MeshBasicMaterial({ color: 0x203030 }));
    eyeL.position.set(-0.1, 0.02, 0.22);
    const eyeR = eyeL.clone(); eyeR.position.x = 0.1;
    this.head.add(skull, hair, fringe, eyeL, eyeR);
    this.head.position.y = 1.66;

    // limbs (pivot at shoulder/hip)
    const mkLimb = (w, l, mat) => {
      const grp = new THREE.Group();
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, l, w), mat);
      m.position.y = -l / 2;
      grp.add(m);
      return grp;
    };
    this.armL = mkLimb(0.16, 0.62, tunic); this.armL.position.set(-0.4, 1.36, 0);
    this.armR = mkLimb(0.16, 0.62, tunic); this.armR.position.set(0.4, 1.36, 0);
    this.legL = mkLimb(0.2, 0.72, pants); this.legL.position.set(-0.17, 0.72, 0);
    this.legR = mkLimb(0.2, 0.72, pants); this.legR.position.set(0.17, 0.72, 0);

    // sword (in right hand when attacking, on back otherwise)
    this.sword = new THREE.Group();
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.95, 0.16), toonMat({ color: 0xcfd8e8 }));
    blade.position.y = 0.55;
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.06, 0.2), toonMat({ color: 0x3a6fd8 }));
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.22, 0.08), toonMat({ color: 0x333340 }));
    grip.position.y = -0.14;
    this.sword.add(blade, guard, grip);
    this.swordOnBack();

    // round shield strapped over the sword
    const shield = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.05, 12), toonMat({ color: 0x4a6a9a }));
    const boss = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), toonMat({ color: 0xc8cad0 }));
    boss.position.y = 0.04;
    shield.add(boss);
    shield.rotation.x = Math.PI / 2;
    shield.position.set(-0.08, 1.08, -0.34);
    this.torso.add(shield);

    // glider canopy (hidden unless gliding)
    this.glider = new THREE.Group();
    const sail = new THREE.Mesh(
      new THREE.SphereGeometry(1.25, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.32),
      toonMat({ color: 0xde5334, side: THREE.DoubleSide })
    );
    sail.scale.set(1.5, 0.8, 1);
    const barL = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.9), toonMat({ color: 0x6a4a2a }));
    barL.position.set(-0.5, -0.4, 0);
    const barR = barL.clone(); barR.position.x = 0.5;
    this.glider.add(sail, barL, barR);
    this.glider.position.y = 2.6;
    this.glider.visible = false;

    // travel cape, pinned at the shoulders
    this.cape = new THREE.Mesh(
      new THREE.PlaneGeometry(0.56, 0.72, 1, 3),
      rimToon(toonMat({ color: 0x9e3232, side: THREE.DoubleSide }), 0.28)
    );
    this.cape.geometry.translate(0, -0.36, 0);
    this.cape.position.set(0, 1.44, -0.2);
    this.torso.add(this.cape);

    g.add(this.torso, this.head, this.armL, this.armR, this.legL, this.legR, this.glider);
    g.traverse(o => { if (o.isMesh) o.castShadow = true; });
    this.group = g;
    G.scene.add(g);

    // pooled glider wind-streak trail: one InstancedMesh, quads stretched
    // along velocity, recycled round-robin — zero per-frame allocation
    this.streakMesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.055, 1),
      new THREE.MeshBasicMaterial({
        color: 0xe6f4ff, transparent: true, opacity: 0.38,
        depthWrite: false, side: THREE.DoubleSide,
      }),
      STREAK_N
    );
    this.streakMesh.frustumCulled = false;
    this.streakMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.streaks = [];
    tmpS.setScalar(0);
    tmpM.compose(tmp1.set(0, -999, 0), tmpQ.identity(), tmpS);
    for (let i = 0; i < STREAK_N; i++) {
      this.streaks.push({ x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 1, len: 1, life: 0 });
      this.streakMesh.setMatrixAt(i, tmpM);
    }
    this.streakIdx = 0;
    this.streakT = 0;
    this.streaksClear = true;
    G.scene.add(this.streakMesh);
  }

  // swap the procedural body for the loaded KayKit knight. Visual only:
  // same outer group, same transforms — the sim never notices the change.
  attachRig() {
    const r = this.rig;
    this.group.add(r.container);
    this.torso.visible = this.head.visible = false;
    this.armL.visible = this.armR.visible = false;
    this.legL.visible = this.legR.visible = false;
    this.sword.visible = false;                    // the knight carries his own
    if (r.capeMount) r.capeMount.add(this.cape);   // cloth cape rides the chest bone
    this.rigActive = true;
    this.bodyReady = true;
    if (this.attackT >= 0) r.swordInHand(); else r.swordOnBack();
  }

  swordOnBack() {
    this.torso.add(this.sword);
    this.sword.position.set(0.16, 1.18, -0.28);
    this.sword.rotation.set(0, 0, 2.45);
    if (this.rigActive) this.rig.swordOnBack();
  }
  swordInHand() {
    this.armR.add(this.sword);
    this.sword.position.set(0, -0.62, 0);
    this.sword.rotation.set(0, 0, 0);
    if (this.rigActive) this.rig.swordInHand();
  }

  // ---- helpers ----------------------------------------------------------

  groundY() {
    let y = heightAt(this.pos.x, this.pos.z);
    // standing on crates / platforms (userData.size = FULL extents; 1.6 cube fallback)
    for (const c of G.grabbables) {
      if (c === this.held) continue;
      const s = c.userData.size;
      const hw = (s ? s.w : 1.6) * 0.5 + 0.2, hd = (s ? s.d : 1.6) * 0.5 + 0.2;
      const hh = (s ? s.h : 1.6) * 0.5;
      const dx = Math.abs(c.position.x - this.pos.x), dz = Math.abs(c.position.z - this.pos.z);
      if (dx < hw && dz < hd) {
        const top = c.position.y + hh;
        if (top > y && this.pos.y >= top - 0.5) y = top;
      }
    }
    for (const col of G.colliders) {
      if (col.top === undefined) continue;
      const d = Math.hypot(col.x - this.pos.x, col.z - this.pos.z);
      if (d < col.r && col.top > y && this.pos.y >= col.top - 0.6) y = col.top;
    }
    return y;
  }

  pushOutOfColliders() {
    for (const c of G.colliders) {
      if (c.soft) continue; // standable ledges never push sideways
      const dx = this.pos.x - c.x, dz = this.pos.z - c.z;
      const d = Math.hypot(dx, dz);
      const min = c.r + 0.35;
      if (d < min && d > 1e-4) {
        if (c.top !== undefined && this.pos.y > c.top - 0.4) continue; // on top
        if (c.bottom !== undefined && this.pos.y + 1.7 < c.bottom) continue; // below band
        this.pos.x = c.x + (dx / d) * min;
        this.pos.z = c.z + (dz / d) * min;
      }
    }
    for (const c of G.grabbables) {
      if (c === this.held) continue;
      const s = c.userData.size;
      const hw = (s ? s.w : 1.6) * 0.5 + 0.35, hd = (s ? s.d : 1.6) * 0.5 + 0.35;
      const hh = (s ? s.h : 1.6) * 0.5;
      const dx = this.pos.x - c.position.x, dz = this.pos.z - c.position.z;
      const top = c.position.y + hh;
      if (this.pos.y >= top - 0.45) continue;
      if (this.pos.y + 1.7 < c.position.y - hh) continue;
      const ax = Math.abs(dx), az = Math.abs(dz);
      if (ax < hw && az < hd) {
        if (ax / hw > az / hd) this.pos.x = c.position.x + Math.sign(dx) * hw;
        else this.pos.z = c.position.z + Math.sign(dz) * hd;
      }
    }
  }

  useStamina(amount) {
    if (this.exhausted) return false;
    G.stamina -= amount;
    this.staminaUse = 0;
    if (G.stamina <= 0) {
      G.stamina = 0;
      this.exhausted = true;
      G.audio.sfx('exhaust');
    }
    return !this.exhausted;
  }

  damage(quarters, fromX, fromZ) {
    if (this.iframes > 0 || G.gameOver) return;
    G.hearts -= quarters;
    this.iframes = 1.0;
    G.ui.hurtFlash();
    G.camShake += 0.28;          // the hit lands in the camera too
    this.fovKick -= 2.5;         // brief punch-in that springs back
    G.audio.sfx('hurt');
    if (fromX !== undefined) {
      const dx = this.pos.x - fromX, dz = this.pos.z - fromZ;
      const d = Math.hypot(dx, dz) || 1;
      this.vel.x += (dx / d) * 9;
      this.vel.z += (dz / d) * 9;
      this.vel.y = 4;
      this.mode = 'air';
    }
    if (G.hearts <= 0) {
      G.hearts = 0;
      G.gameOver = true;
      G.ui.showGameOver();
      G.audio.sfx('die');
      // player updates stop while game-over; bake the death pose now so the
      // knight lies fallen behind the overlay instead of freezing mid-swing
      if (this.rigActive) this.rig.beginDeath();
    }
  }

  respawnNow() {
    const r = G.respawn;
    this.pos.set(r.x, heightAt(r.x, r.z) + 0.5, r.z);
    this.vel.set(0, 0, 0);
    G.hearts = G.maxHearts;
    G.stamina = G.maxStamina;
    this.exhausted = false;
    this.mode = 'ground';
    G.gameOver = false;
    this.snapCameraNextFrame();
  }

  snapCameraNextFrame() {
    this.camInit = false;
    this.camSnap = true;
    this.camOccl = 1;
    this.lookX = 0;
    this.lookZ = 0;
    G.mouse.dx = 0;
    G.mouse.dy = 0;
  }

  // wall probe: terrain steepness OR climbable meshes ahead
  probeWall() {
    const fwd = tmp1.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    // meshes
    ray.set(tmp2.copy(this.pos).add(tmp3.set(0, 1.1, 0)), fwd);
    ray.far = 1.1;
    const hits = ray.intersectObjects(G.climbMeshes, false);
    if (hits.length) {
      const h = hits[0];
      const n = h.face.normal.clone().transformDirection(h.object.matrixWorld);
      if (Math.abs(n.y) < 0.55) return { type: 'mesh', point: h.point, normal: n, object: h.object };
    }
    // terrain
    const px = this.pos.x + fwd.x * 0.7, pz = this.pos.z + fwd.z * 0.7;
    const hAhead = heightAt(px, pz);
    if (hAhead > this.pos.y + 1.1 && slopeAt(px, pz) > 0.68) {
      normalAt(px, pz, nrm);
      const n = tmp3.set(nrm.x, 0, nrm.z);
      if (n.lengthSq() > 1e-6) n.normalize(); else n.copy(fwd).negate();
      return { type: 'terrain', normal: n.clone() };
    }
    return null;
  }

  // ---- grab ability -----------------------------------------------------

  tryGrab() {
    if (this.mode === 'mantle') return;
    if (this.held) {  // drop / place
      settleCrate(this.held);
      this.held = null;
      this.rSnapT = -1;
      this.rWasDown = false;
      G.ui.toast('Released.', 0xd8c8a0);
      return;
    }
    let best = null, bestD = 4.5;
    for (const c of G.grabbables) {
      const d = c.position.distanceTo(this.pos);
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best) {
      this.held = best;
      best.userData.falling = false;
      best.userData.vy = 0;
      best.userData.vx = 0;
      best.userData.vz = 0;
      this.rHeldT = 0;
      this.rSnapT = -1;
      this.rWasDown = false;
      G.audio.sfx('grab');
      G.ui.toast(best.userData.heavy
        ? 'Holding (heavy) — F place, R rotate, attack to throw'
        : 'Holding — F place, R rotate, attack to throw', 0xd8c8a0);
    }
  }

  throwHeld() {
    const c = this.held;
    this.held = null;
    this.rSnapT = -1;
    this.rWasDown = false;
    const heavy = !!c.userData.heavy;
    const fwd = tmp1.set(Math.sin(this.camYaw), 0, Math.cos(this.camYaw));
    this.yaw = this.camYaw;
    settleCrate(c);  // world.js computes floorY + sets falling; physics takes over
    const sp = heavy ? 3.5 : 7;
    c.userData.vy = 5;
    c.userData.vx = fwd.x * sp;
    c.userData.vz = fwd.z * sp;
    this.throwT = 0;
    G.audio.sfx('throw');
    G.camShake += heavy ? 0.12 : 0.06;
  }

  updateHeld(dt) {
    if (!this.held) return;
    const ud = this.held.userData;
    const halfH = (ud.size ? ud.size.h : 1.6) * 0.5;
    const fwd = tmp1.set(Math.sin(this.camYaw), 0, Math.cos(this.camYaw));
    const target = tmp2.copy(this.pos).addScaledVector(fwd, 2.9);
    target.y = this.pos.y + 1.4 + clamp(-this.camPitch, -0.9, 1.2) * 2.2;
    const minY = heightAt(target.x, target.z) + halfH + 0.05;
    if (target.y < minY) target.y = minY;
    this.held.position.lerp(target, Math.min(1, dt * 14));

    // R: tap = animated 90° yaw snap, hold >0.35s = continuous rotate
    const rDown = !!G.keys['KeyR'];
    if (rDown) {
      this.rHeldT += dt;
      if (this.rHeldT > 0.35) this.held.rotation.y += dt * 2.5;
    } else {
      if (this.rWasDown && this.rHeldT <= 0.35) {
        this.rSnapT = 0;
        this.rSnapFrom = this.held.rotation.y;
        this.rSnapTo = this.rSnapFrom + Math.PI / 2;
        G.audio.sfx('rotate');
      }
      this.rHeldT = 0;
    }
    this.rWasDown = rDown;
    if (this.rSnapT >= 0) {
      this.rSnapT += dt;
      const p = Math.min(1, this.rSnapT / 0.16);
      const e = p * p * (3 - 2 * p);  // smoothstep
      this.held.rotation.y = this.rSnapFrom + (this.rSnapTo - this.rSnapFrom) * e;
      if (p >= 1) this.rSnapT = -1;
    }
  }

  // ---- bow --------------------------------------------------------------

  buildBow() {
    // recurve bow: two mirrored arcs + grip + string, wind-wood and bronze
    this.bowGrp = new THREE.Group();
    const wood = toonMat({ color: 0x7a5230 });
    const limbGeo = new THREE.TorusGeometry(0.42, 0.028, 6, 10, Math.PI * 0.52);
    const limbT = new THREE.Mesh(limbGeo, wood);
    limbT.rotation.z = Math.PI * 0.24;
    const limbB = new THREE.Mesh(limbGeo, wood);
    limbB.rotation.z = -Math.PI * 0.76;
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.22, 6), toonMat({ color: 0xd9a83f }));
    grip.position.x = 0.42;
    const string = new THREE.Mesh(new THREE.BoxGeometry(0.008, 1.28, 0.008),
      new THREE.MeshBasicMaterial({ color: 0xe8e2d0 }));
    string.position.x = -0.16;
    this.bowGrp.add(limbT, limbB, grip, string);
    this.bowGrp.traverse(o => { if (o.isMesh) o.castShadow = true; });
    this.bowGrp.visible = false;
    this.group.add(this.bowGrp);

    // pooled arrows: shaft + head + fletching
    for (let i = 0; i < 6; i++) {
      const a = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.78, 5), toonMat({ color: 0x9a7a4e }));
      shaft.rotation.x = Math.PI / 2;
      const head = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.1, 5), toonMat({ color: 0xb8bcc8 }));
      head.rotation.x = Math.PI / 2;
      head.position.z = 0.44;
      const fl = new THREE.Mesh(new THREE.PlaneGeometry(0.09, 0.12),
        toonMat({ color: 0xe8f0f4, side: THREE.DoubleSide }));
      fl.position.z = -0.34;
      a.add(shaft, head, fl);
      a.visible = false;
      G.scene.add(a);
      this.arrowPool.push({ g: a, t: -1, stuck: 0, vx: 0, vy: 0, vz: 0 });
    }

    // swap in the Blender-authored bow + arrows once their GLBs land
    // (procedural stand-ins above cover the load window and any failure)
    preloadModels(['bow', 'arrow']).then(res => {
      if (res.bow) {
        this.bowGrp.clear();
        const b = propInstance('bow');
        this.bowGrp.add(b);
      }
      if (res.arrow) {
        for (const slot of this.arrowPool) {
          slot.g.clear();
          const m = propInstance('arrow');
          m.rotation.x = Math.PI / 2; // glTF Y-up shaft -> game +Z flight axis
          slot.g.add(m);
        }
      }
    }).catch(() => {});
  }

  tryShoot() {
    if (this.shootCd > 0 || !this.aiming) return;
    if (this.arrows <= 0) { G.ui.toast('Out of arrows...', 0xcccccc); return; }
    let arrow = null;
    for (const a of this.arrowPool) if (a.t < 0) { arrow = a; break; }
    if (!arrow) return;
    this.arrows--;
    this.shootCd = 0.55;
    // converge on the crosshair: aim from the arrow's origin at the point the
    // camera ray focuses on, so over-shoulder parallax can't drift the shot
    G.camera.getWorldDirection(tmp1);
    tmp2.copy(G.camera.position).addScaledVector(tmp1, 55);
    arrow.g.position.set(this.pos.x + tmp1.x * 0.8, this.pos.y + 1.5 + tmp1.y * 0.8, this.pos.z + tmp1.z * 0.8);
    tmp1.copy(tmp2).sub(arrow.g.position).normalize();
    arrow.vx = tmp1.x * 40; arrow.vy = tmp1.y * 40 + 1.2; arrow.vz = tmp1.z * 40;
    arrow.t = 0; arrow.stuck = 0;
    arrow.g.visible = true;
    G.audio.sfx('throw');
    G.camShake += 0.04;
    this.fovKick -= 1.5; // release kick
  }

  updateArrows(dt) {
    this.shootCd = Math.max(0, this.shootCd - dt);
    for (const a of this.arrowPool) {
      if (a.t < 0) continue;
      a.t += dt;
      if (a.stuck > 0) { // planted in the ground / a target
        if (a.t > a.stuck) { a.t = -1; a.g.visible = false; }
        continue;
      }
      a.vy -= 11 * dt;
      const g = a.g;
      g.position.x += a.vx * dt;
      g.position.y += a.vy * dt;
      g.position.z += a.vz * dt;
      tmp1.set(a.vx, a.vy, a.vz).normalize();
      tmp2.copy(g.position).add(tmp1);
      g.lookAt(tmp2);
      // enemy hit
      for (const e of G.enemies) {
        if (e.dead) continue;
        const dx = e.pos.x - g.position.x, dz = e.pos.z - g.position.z;
        const dy = (e.pos.y + 1.1) - g.position.y;
        if (dx * dx + dz * dz + dy * dy < (e.radius + 0.5) * (e.radius + 0.5)) {
          e.hurt(2, this.pos);
          spawnSparkle(g.position.x, g.position.y, g.position.z, 0xffd0a0, 8, 3);
          a.t = -1; g.visible = false;
          break;
        }
      }
      if (a.t < 0) continue;
      // terrain / water
      const gy = heightAt(g.position.x, g.position.z);
      if (g.position.y <= WATER_Y - 0.1 && gy < WATER_Y - 0.5) {
        spawnSparkle(g.position.x, WATER_Y + 0.1, g.position.z, 0xbfe8ff, 5, 1.6);
        a.t = -1; g.visible = false;
      } else if (g.position.y <= gy + 0.05) {
        a.stuck = a.t + 6; // stand in the turf a while, then fade away
        g.position.y = gy + 0.05;
      } else if (a.t > 5) {
        a.t = -1; g.visible = false;
      }
    }
  }

  // ---- combat -----------------------------------------------------------

  tryAttack() {
    if (this.mode === 'climb' || this.mode === 'glide' || this.mode === 'mantle') return;
    if (this.held) { this.throwHeld(); return; }  // attack while carrying = throw
    if (this.attackT >= 0 && this.attackT < 0.18) return;
    if (this.attackT >= 0) this.combo = (this.combo + 1) % 3;
    else this.combo = 0;
    this.attackT = 0;
    this.hitStop = 0;
    this.swordInHand();
    G.audio.sfx('swing');
    // face the lock target; otherwise strike where the camera looks unless
    // the player is actively steering (then the run direction wins)
    if (this.lockTarget && !this.lockTarget.dead) {
      const e = this.lockTarget;
      this.yaw = Math.atan2(e.pos.x - this.pos.x, e.pos.z - this.pos.z);
    } else {
      const k = G.keys;
      const steering = k['KeyW'] || k['KeyA'] || k['KeyS'] || k['KeyD'];
      if (!steering) this.yaw = this.camYaw;
    }
    // small forward step impulse sells each swing
    if (this.mode === 'ground') {
      this.vel.x += Math.sin(this.yaw) * 3.4;
      this.vel.z += Math.cos(this.yaw) * 3.4;
    }
    // hit check happens mid-swing in update
    this.attackHitDone = false;
  }

  attackHitCheck() {
    const reach = 2.5;
    const fwd = tmp1.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    let hits = 0;
    for (const e of G.enemies) {
      if (e.dead) continue;
      tmp2.set(e.pos.x - this.pos.x, 0, e.pos.z - this.pos.z);
      const d = tmp2.length();
      if (d < reach + e.radius && tmp2.normalize().dot(fwd) > 0.35) {
        e.hurt(1 + (this.combo === 2 ? 1 : 0), this.pos);
        hits++;
      }
    }
    return hits;
  }

  // ---- main update --------------------------------------------------------

  update(dt) {
    const k = G.keys;
    this.iframes = Math.max(0, this.iframes - dt);
    this.climbCooldown = Math.max(0, this.climbCooldown - dt);
    this.staminaUse += dt;

    // jump feel timers: coyote grace + input buffering
    this.coyoteT += dt;
    if (k['Space'] && !this.prevSpaceKey) this.jumpBufT = 0;
    else this.jumpBufT += dt;
    this.prevSpaceKey = !!k['Space'];
    this.landSquash = Math.max(0, this.landSquash - dt * 3.2);
    if (this.throwT >= 0) { this.throwT += dt; if (this.throwT > 0.3) this.throwT = -1; }
    this.sprinting = false;
    this.glideDive = false;

    // exhaustion readability: a sweat drop every ~0.7s
    if (this.exhausted) {
      this.exhaustDropT += dt;
      if (this.exhaustDropT > 0.7) {
        this.exhaustDropT = 0;
        spawnSparkle(this.pos.x, this.pos.y + 1.8, this.pos.z, 0x9fd8ff, 2, 1.2);
      }
    } else this.exhaustDropT = 0;

    // stamina regen (star shard vigor doubles it while the buff runs)
    if (this.staminaUse > 0.65 && this.mode !== 'climb' && this.mode !== 'glide' && this.mode !== 'swim') {
      const regen = G.time < G.buffs.vigorUntil ? 76 : 38;
      G.stamina = Math.min(G.maxStamina, G.stamina + regen * dt);
      if (this.exhausted && G.stamina > G.maxStamina * 0.32) this.exhausted = false;
    }

    // camera orbit from mouse
    this.camYaw -= G.mouse.dx * 0.0028;
    this.camPitch = clamp(this.camPitch + G.mouse.dy * 0.0022, -0.55, 1.25);
    G.mouse.dx = G.mouse.dy = 0;

    // lock-on
    if (k._lockPressed) {
      k._lockPressed = false;
      if (this.lockTarget) this.lockTarget = null;
      else {
        let best = null, bestD = 24;
        for (const e of G.enemies) {
          if (e.dead) continue;
          const d = e.pos.distanceTo(this.pos);
          if (d < bestD) { bestD = d; best = e; }
        }
        this.lockTarget = best;
        if (best) G.audio.sfx('lock');
      }
    }
    if (this.lockTarget && (this.lockTarget.dead || this.lockTarget.pos.distanceTo(this.pos) > 32)) this.lockTarget = null;

    // bow aim: hold RMB on solid ground — the hero turns quickly (never
    // snaps: an instant yaw = camYaw read as a wild spin when the camera
    // faced the hero) and squares up behind the arrow
    const wantAim = !!k._rmb && this.mode === 'ground' && !this.held && this.attackT < 0;
    if (wantAim && !this.aiming) this.aimT = 0;
    this.aiming = wantAim;
    if (this.aiming) {
      this.aimT += dt;
      let d = this.camYaw - this.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      const maxTurn = (this.aimT < 0.2 ? 8.5 : 6.5) * dt;
      this.yaw += clamp(d, -maxTurn, maxTurn);
    } else this.aimT = 0;
    this.updateArrows(dt);

    // move input in camera space: forward is (sin cy, cos cy), so screen-right
    // is forward x up = (-cos cy, sin cy) — D strafes right, A strafes left
    let ix = (k['KeyD'] ? 1 : 0) - (k['KeyA'] ? 1 : 0);
    let iz = (k['KeyW'] ? 1 : 0) - (k['KeyS'] ? 1 : 0);
    const inputLen = Math.hypot(ix, iz);
    if (inputLen > 0) { ix /= inputLen; iz /= inputLen; }
    const sin = Math.sin(this.camYaw), cos = Math.cos(this.camYaw);
    const moveX = -ix * cos + iz * sin;
    const moveZ = ix * sin + iz * cos;

    const waterHere = WATER_Y - heightAt(this.pos.x, this.pos.z);

    switch (this.mode) {
      case 'ground': this.updateGround(dt, moveX, moveZ, inputLen, k); break;
      case 'air': this.updateAir(dt, moveX, moveZ, inputLen, k); break;
      case 'glide': this.updateGlide(dt, moveX, moveZ, inputLen, k); break;
      case 'climb': this.updateClimb(dt, ix, iz, k); break;
      case 'swim': this.updateSwim(dt, moveX, moveZ, inputLen, k); break;
      case 'mantle': this.updateMantle(dt); break;
    }
    if (this.mode !== 'air' && this.mode !== 'glide') this.inUpdraft = false;

    // attack timing (hit-stop briefly freezes the swing on contact)
    if (this.attackT >= 0) {
      if (this.hitStop > 0) {
        this.hitStop -= dt;
      } else {
        this.attackT += dt;
        if (!this.attackHitDone && this.attackT > 0.12) {
          this.attackHitDone = true;
          if (this.attackHitCheck() > 0) {
            G.camShake += 0.15;
            this.hitStop = 0.06;
          }
        }
        // the rig's swing clips are compressed to ~0.45s — ending here keeps
        // the sword from freezing on the last frame before it re-shoulders
        if (this.attackT > 0.55) {
          this.attackT = -1;
          this.swordOnBack();
        }
      }
    }

    this.updateHeld(dt);
    if (this.mode !== 'mantle') this.pushOutOfColliders();
    this.updateStreaks(dt);
    this.animate(dt, inputLen, k);
    if (!G.cinematic) this.updateCamera(dt); // opening beats own the camera
  }

  // shared updraft contract: lift while airborne inside a registered zone
  applyUpdrafts(dt) {
    let strength = 0, inside = false;
    for (const z of G.updraftZones) {
      const dx = this.pos.x - z.x, dz = this.pos.z - z.z;
      if (dx * dx + dz * dz < z.r * z.r &&
          this.pos.y >= z.bottomY && this.pos.y <= z.topY) {
        inside = true; strength = z.strength;
        break;
      }
    }
    if (inside) {
      // works best with the glider open — much stronger coupling; even without
      // it the column clearly lifts (beats the 24/s2 gravity, TotK-style toss)
      const rate = this.mode === 'glide' ? 46 : 32;
      if (this.vel.y < strength) this.vel.y = Math.min(strength, this.vel.y + rate * dt);
      if (!this.inUpdraft) { this.inUpdraft = true; G.audio.sfx('updraft'); }
    } else this.inUpdraft = false;
  }

  updateGround(dt, mx, mz, inputLen, k) {
    const heavyHeld = this.held && this.held.userData.heavy;
    const sprinting = k['ShiftLeft'] && inputLen > 0 && !this.exhausted && !this.held;
    const swift = G.time < G.buffs.swiftUntil; // feather-blessed stride
    // shuffle slowly while catching breath on a climb ledge
    let speed = (sprinting ? (swift ? 11.6 : 9.2) : 5.4) * (this.climbCooldown > 0 ? 0.15 : 1);
    if (this.exhausted) speed *= 0.6;       // weary legs
    if (heavyHeld) speed *= 0.55;           // heavy prop drag
    if (this.aiming) speed *= 0.42;         // drawn bow = careful steps
    this.sprinting = sprinting;
    if (sprinting) this.useStamina((swift ? 8 : 14) * dt);

    const accel = 40;
    this.vel.x = lerp(this.vel.x, mx * speed, Math.min(1, accel * dt / speed * 4));
    this.vel.z = lerp(this.vel.z, mz * speed, Math.min(1, accel * dt / speed * 4));
    if (inputLen > 0 && !this.aiming) { // while aiming, the aim owns the yaw
      const targetYaw = Math.atan2(mx, mz);
      let d = targetYaw - this.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.yaw += d * Math.min(1, dt * 12);
    }

    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

    const gy = this.groundY();

    // fall into water
    if (heightAt(this.pos.x, this.pos.z) < WATER_Y - 1.2 && gy < WATER_Y - 1.2) {
      this.enterSwim(0);
      return;
    }

    // walk into a wall -> climb
    if (inputLen > 0 && !this.held && this.climbCooldown <= 0) {
      const wall = this.probeWall();
      if (wall && !this.exhausted) {
        this.enterClimb(wall);
        return;
      }
    }

    // jump (fresh press OR a press buffered just before landing)
    const wantJump = (k['Space'] && !k._spaceLatch) || this.jumpBufT < 0.15;
    if (wantJump && !heavyHeld) {
      if (k['Space']) k._spaceLatch = true;  // never latch an already-released key
      this.jumpBufT = 99;
      this.vel.y = 8.4;
      this.mode = 'air';
      this.pos.y = gy + 0.05;
      G.audio.sfx('jump');
      return;
    }

    // snap to ground / step off ledge; steep drops always become falls
    const steepDrop = gy < this.pos.y - 0.12 && slopeAt(this.pos.x, this.pos.z) > 0.75;
    if (gy < this.pos.y - 0.45 || steepDrop) {
      this.mode = 'air';
      this.vel.y = 0;
    } else {
      this.pos.y = gy;
      this.vel.y = 0;
      this.grounded = true;
      this.coyoteT = 0;   // may still jump for a beat after stepping off
      // footsteps
      if (inputLen > 0) {
        this.stepPhase += dt * (sprinting ? 11 : 7);
        if (this.stepPhase > Math.PI) {
          this.stepPhase -= Math.PI;
          G.audio.sfx('step');
          // sprinting footfalls kick tiny dust puffs
          if (sprinting) {
            spawnSparkle(
              this.pos.x - Math.sin(this.yaw) * 0.35, this.pos.y + 0.12,
              this.pos.z - Math.cos(this.yaw) * 0.35, DUST, 3, 1.1);
          }
        }
      }
    }
  }

  updateAir(dt, mx, mz, inputLen, k) {
    this.vel.y -= 24 * dt;
    this.applyUpdrafts(dt);
    this.vel.x = lerp(this.vel.x, mx * 5.4, dt * 2.4);
    this.vel.z = lerp(this.vel.z, mz * 5.4, dt * 2.4);
    this.pos.addScaledVector(this.vel, dt);

    // splash into deep water at the surface
    if (this.pos.y <= WATER_Y - 0.2 && heightAt(this.pos.x, this.pos.z) < WATER_Y - 1.2) {
      this.enterSwim(-this.vel.y);
      return;
    }

    // coyote jump: a fresh press just after walking off an edge still jumps
    if (k['Space'] && !k._spaceLatch && this.coyoteT < 0.12 && this.vel.y <= 0 &&
        !(this.held && this.held.userData.heavy)) {
      k._spaceLatch = true;
      this.coyoteT = 99;
      this.vel.y = 8.4;
      G.audio.sfx('jump');
      return;
    }

    // deploy glider: hold space while falling (also right after a jump)
    if (k['Space'] && this.vel.y < -1 && !this.exhausted && !this.held) {
      this.mode = 'glide';
      this.glider.visible = true;
      this.prevGlideYaw = this.yaw;
      this.bank = 0;
      G.audio.sfx('glide');
      return;
    }

    // grab wall mid-air
    if (inputLen > 0 && !this.exhausted && !this.held && this.climbCooldown <= 0) {
      const wall = this.probeWall();
      if (wall) { this.enterClimb(wall); return; }
    }

    const gy = this.groundY();
    if (this.pos.y <= gy) {
      const impact = -this.vel.y;
      this.pos.y = gy;
      this.vel.y = 0;
      this.mode = 'ground';
      G.audio.sfx('land');
      // landing feedback: dust scaled by impact, squash, shake on hard slams
      if (impact > 17) {
        this.damage(Math.min(8, Math.round((impact - 15) * 0.5) * 2));
        spawnSparkle(this.pos.x, this.pos.y + 0.2, this.pos.z, DUST, 18, 3.4);
        G.camShake += 0.5;
        this.landSquash = 1;
      } else if (impact > 8) {
        spawnSparkle(this.pos.x, this.pos.y + 0.15, this.pos.z, DUST, 8, 1.6);
        this.landSquash = Math.min(1, impact / 17);
      }
      if (heightAt(this.pos.x, this.pos.z) < WATER_Y - 1.2) {
        this.enterSwim(impact);
        return;
      }
      // buffered jump: Space pressed just before touchdown fires now
      if (this.jumpBufT < 0.15 && !(this.held && this.held.userData.heavy) && !G.gameOver) {
        if (k['Space']) k._spaceLatch = true;
        this.jumpBufT = 99;
        this.vel.y = 8.4;
        this.mode = 'air';
        this.pos.y = gy + 0.05;
        G.audio.sfx('jump');
      }
    }
  }

  updateGlide(dt, mx, mz, inputLen, k) {
    // W = dive (fast, nose-down), S = flare (float, drains stamina ~2x)
    const iz = (k['KeyW'] ? 1 : 0) - (k['KeyS'] ? 1 : 0);
    const dive = iz > 0, flare = iz < 0;
    if (!k['Space'] || this.exhausted || !this.useStamina((flare ? 13 : 6.5) * dt)) {
      this.mode = 'air';
      this.glider.visible = false;
      return;
    }
    this.glideDive = dive;
    this.glidePitch = dive ? 0.55 : flare ? 0.04 : 0.28;
    const sink = dive ? -7.5 : flare ? -1.2 : -2.6;
    this.vel.y = Math.max(this.vel.y - 20 * dt, sink);
    this.applyUpdrafts(dt);
    const gSpeed = dive ? 14 : flare ? 7.5 : 10.5;
    const gAccel = dive ? 2.2 : 1.6;
    this.vel.x = lerp(this.vel.x, mx * gSpeed, dt * gAccel);
    this.vel.z = lerp(this.vel.z, mz * gSpeed, dt * gAccel);
    if (inputLen > 0) {
      const targetYaw = Math.atan2(this.vel.x, this.vel.z);
      let d = targetYaw - this.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.yaw += d * Math.min(1, dt * 6);
    }
    // banking: roll with the lateral turn rate
    let dy = this.yaw - this.prevGlideYaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    const yawRate = dy / Math.max(dt, 1e-4);
    this.bank = lerp(this.bank, clamp(-yawRate * 0.32, -0.55, 0.55), Math.min(1, dt * 6));
    this.prevGlideYaw = this.yaw;
    this.pos.addScaledVector(this.vel, dt);

    const gy = this.groundY();
    if (this.pos.y <= gy + 0.2) {
      this.pos.y = gy;
      this.mode = 'ground';
      this.glider.visible = false;
      G.audio.sfx('land');
      if (heightAt(this.pos.x, this.pos.z) < WATER_Y - 1.2) {
        this.enterSwim(2);
        return;
      }
    }
  }

  enterClimb(wall) {
    this.mode = 'climb';
    this.climbStartY = this.pos.y;
    this.vel.set(0, 0, 0);
    this.climbNormal.copy(wall.normal);
    this.climbObject = wall.object || null;
    this.yaw = Math.atan2(-wall.normal.x, -wall.normal.z);
    if (wall.point) {
      this.pos.x = wall.point.x + wall.normal.x * 0.42;
      this.pos.z = wall.point.z + wall.normal.z * 0.42;
    }
  }

  updateClimb(dt, ix, iz, k) {
    const drain = (Math.abs(ix) + Math.abs(iz)) > 0 ? 7.5 : 2.5;
    if (!this.useStamina(drain * dt)) {  // stamina gone -> fall
      this.mode = 'air';
      return;
    }
    // climb jump
    if (k['Space'] && !k._spaceLatch) {
      k._spaceLatch = true;
      if (this.useStamina(12)) {
        this.pos.y += 0.1;
        this.vel.set(this.climbNormal.x * 1.5, 7.5, this.climbNormal.z * 1.5);
        this.pos.addScaledVector(this.climbNormal, 0.1);
        this.mode = 'air';
        G.audio.sfx('jump');
        return;
      }
    }

    const n = this.climbNormal;
    const right = tmp1.set(-n.z, 0, n.x); // tangent
    const climbSpeed = 2.3;
    this.pos.addScaledVector(right, -ix * climbSpeed * dt);
    this.pos.y += iz * climbSpeed * dt;
    // ease toward the wall facing — terrain normals jitter frame to frame,
    // and snapping yaw to them made climbing look twitchy
    {
      const tYaw = Math.atan2(-n.x, -n.z);
      let dy = tYaw - this.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      this.yaw += dy * Math.min(1, dt * 10);
    }

    if (this.climbObject) {
      // re-stick to mesh; probe at chest, then waist, before declaring a top edge
      const into = tmp2.copy(n).negate();
      const stick = (heightOff) => {
        ray.set(tmp3.copy(this.pos).add(tmp1.set(0, heightOff, 0)).addScaledVector(n, 0.6), into);
        ray.far = 2.4;
        const hits = ray.intersectObjects(G.climbMeshes, false);
        if (!hits.length) return null;
        const hn = hits[0].face.normal.clone().transformDirection(hits[0].object.matrixWorld);
        if (Math.abs(hn.y) >= 0.6) return null;
        return hits[0];
      };
      const hit = stick(1.1) || stick(0.45);
      if (hit) {
        const hn = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
        this.climbNormal.set(hn.x, 0, hn.z).normalize();
        const p = hit.point;
        this.pos.x = p.x + this.climbNormal.x * 0.42;
        this.pos.z = p.z + this.climbNormal.z * 0.42;
        this.climbObject = hit.object;
      } else {
        // reached the top edge -> animated mantle up over the ledge
        this.startMantle(n);
        return;
      }
      // stepping onto a raised ledge (tower ring, crate top) while climbing —
      // must be well above the terrain or we'd "stand" at the wall base forever
      const ledgeY = this.groundY();
      const terrY = heightAt(this.pos.x, this.pos.z);
      if (ledgeY > terrY + 0.5 && ledgeY > this.climbStartY + 0.5 &&
          this.pos.y <= ledgeY + 0.15 && this.pos.y > ledgeY - 0.7) {
        this.pos.y = ledgeY;
        this.mode = 'ground';
        this.climbCooldown = 1.6; // catch your breath on the ledge
        return;
      }
    } else {
      // terrain climbing: follow the surface
      const surfaceY = heightAt(this.pos.x, this.pos.z);
      const s = slopeAt(this.pos.x, this.pos.z);
      if (s < 0.6 || this.pos.y >= surfaceY - 0.2) {
        // slope relaxed -> stand up
        this.pos.y = surfaceY;
        this.mode = 'ground';
        return;
      }
      // keep pinned near the wall: pull toward surface horizontally
      normalAt(this.pos.x, this.pos.z, nrm);
      this.climbNormal.set(nrm.x, 0, nrm.z);
      if (this.climbNormal.lengthSq() > 1e-6) this.climbNormal.normalize();
      // push into wall so we hug it as it recedes
      const wallX = this.pos.x - this.climbNormal.x * 0.55;
      const wallZ = this.pos.z - this.climbNormal.z * 0.55;
      const wallY = heightAt(wallX, wallZ);
      if (wallY < this.pos.y - 0.3) {
        this.pos.x = wallX; this.pos.z = wallZ;
      }
      if (this.pos.y < surfaceY - 8) {
        // wall got overhung / weird: nudge out
        this.pos.y = surfaceY - 8;
      }
    }
    // ground check below
    const gy = heightAt(this.pos.x, this.pos.z);
    if (iz < 0 && this.pos.y <= gy + 0.1) {
      this.pos.y = gy;
      this.mode = 'ground';
      return;
    }
    // occasional grip dust while hauling upward
    if (Math.abs(ix) + Math.abs(iz) > 0) {
      this.gripDustT += dt;
      if (this.gripDustT > 0.55) {
        this.gripDustT = 0;
        spawnSparkle(
          this.pos.x - this.climbNormal.x * 0.35, this.pos.y + 1.25,
          this.pos.z - this.climbNormal.z * 0.35, 0xbfae8e, 3, 0.9);
      }
    }
  }

  // ~0.35s up-and-over mantle arc; input is ignored, ends standing
  startMantle(n) {
    this.mode = 'mantle';
    this.mantleT = 0;
    this.mantleFrom.copy(this.pos);
    this.mantleTo.set(this.pos.x - n.x * 1.3, this.pos.y + 2.2, this.pos.z - n.z * 1.3);
    this.vel.set(0, 0, 0);
    G.audio.sfx('mantle');
  }

  updateMantle(dt) {
    this.mantleT += dt;
    const p = Math.min(1, this.mantleT / 0.35);
    // rise first, then swing the body over the lip
    const pv = Math.min(1, p / 0.62);
    const ph = p < 0.3 ? 0 : (p - 0.3) / 0.7;
    const ev = pv * pv * (3 - 2 * pv);
    const eh = ph * ph * (3 - 2 * ph);
    this.pos.x = lerp(this.mantleFrom.x, this.mantleTo.x, eh);
    this.pos.z = lerp(this.mantleFrom.z, this.mantleTo.z, eh);
    this.pos.y = lerp(this.mantleFrom.y, this.mantleTo.y, ev) + Math.sin(p * Math.PI) * 0.12;
    if (p >= 1) {
      this.mantleT = -1;
      this.climbCooldown = 0.4;
      const gy = this.groundY();
      if (this.pos.y <= gy + 0.9) {
        this.pos.y = gy;
        this.mode = 'ground';
        this.vel.set(0, 0, 0);
      } else {
        this.mode = 'air';       // odd geometry: settle with a tiny hop
        this.vel.set(0, 2, 0);
      }
    }
  }

  updateSwim(dt, mx, mz, inputLen, k) {
    if (!this.useStamina((inputLen > 0 ? 7 : 3.5) * dt)) {
      // drowning: teleport to respawn-ish shore with damage
      this.damage(2);
      if (!G.gameOver) {
        this.mode = 'ground';
        const r = G.respawn;
        this.pos.set(r.x, heightAt(r.x, r.z), r.z);
        G.stamina = G.maxStamina * 0.4;
        this.exhausted = false;
        G.ui.toast('You nearly drowned...', 0x88bbff);
      }
      return;
    }
    const speed = 3.4;
    this.vel.x = lerp(this.vel.x, mx * speed, dt * 4);
    this.vel.z = lerp(this.vel.z, mz * speed, dt * 4);
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    // gentle stroke bob layered over the ambient chop; ride high enough that
    // the head and arm strokes break the surface
    const strokeBob = inputLen > 0 ? Math.sin(G.time * 6) * 0.06 : 0;
    this.pos.y = WATER_Y - 0.26 + Math.sin(G.time * 2.2) * 0.08 + strokeBob;
    if (inputLen > 0) {
      // turn smoothly into the stroke direction instead of snapping
      const tYaw = Math.atan2(mx, mz);
      let dy = tYaw - this.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      this.yaw += dy * Math.min(1, dt * 8);
      this.stepPhase += dt * 4;
    }
    const gy = heightAt(this.pos.x, this.pos.z);
    if (gy > WATER_Y - 1.0) { // reached shore
      this.pos.y = gy;
      this.mode = 'ground';
    }
  }

  // splash into deep water; particle burst scales with fall speed
  enterSwim(fallSpeed = 0) {
    this.mode = 'swim';
    this.glider.visible = false;
    this.pos.y = WATER_Y - 0.26;
    this.vel.y = 0;
    const f = Math.max(0, fallSpeed);
    spawnSparkle(this.pos.x, WATER_Y + 0.15, this.pos.z, 0xbfe8ff,
      Math.round(clamp(6 + f * 1.4, 6, 26)), 2 + Math.min(5, f * 0.28));
    G.audio.sfx('splash');
  }

  // pooled wind streaks behind the glider at speed (recycled, no allocs)
  updateStreaks(dt) {
    const sp = Math.hypot(this.vel.x, this.vel.y, this.vel.z);
    if (this.mode === 'glide' && sp > 6.5) {
      this.streakT -= dt;
      if (this.streakT <= 0) {
        this.streakT = 0.07;
        const s = this.streaks[this.streakIdx];
        this.streakIdx = (this.streakIdx + 1) % STREAK_N;
        const inv = 1 / sp;
        s.dx = this.vel.x * inv; s.dy = this.vel.y * inv; s.dz = this.vel.z * inv;
        s.x = this.pos.x - s.dx * 1.4 + (Math.random() - 0.5) * 1.7;
        s.y = this.pos.y + 2.1 - s.dy * 1.4 + (Math.random() - 0.5) * 0.9;
        s.z = this.pos.z - s.dz * 1.4 + (Math.random() - 0.5) * 1.7;
        s.len = 0.5 + sp * 0.07;
        s.life = 0.38;
      }
    }
    let any = false;
    for (let i = 0; i < STREAK_N; i++) {
      const s = this.streaks[i];
      if (s.life > 0) { s.life -= dt; if (s.life > 0) any = true; }
    }
    if (!any && this.streaksClear) return;  // pool idle and already zeroed
    for (let i = 0; i < STREAK_N; i++) {
      const s = this.streaks[i];
      if (s.life <= 0) {
        tmpS.setScalar(0);
        tmpM.compose(tmp1.set(0, -999, 0), tmpQ.identity(), tmpS);
      } else {
        tmpQ.setFromUnitVectors(UP, tmp1.set(s.dx, s.dy, s.dz));
        tmpS.set(Math.max(0.05, s.life / 0.38), s.len, 1);
        tmpM.compose(tmp1.set(s.x, s.y, s.z), tmpQ, tmpS);
      }
      this.streakMesh.setMatrixAt(i, tmpM);
    }
    this.streakMesh.instanceMatrix.needsUpdate = true;
    this.streaksClear = !any;
  }

  // ---- animation ---------------------------------------------------------

  animate(dt, inputLen, k) {
    const g = this.group;
    g.position.copy(this.pos);
    g.rotation.y = this.yaw;

    const t = G.time;
    const speed = Math.hypot(this.vel.x, this.vel.z);
    const runT = clamp(speed / 9, 0, 1);
    const ease = Math.min(1, dt * 14);

    // ---- whole-body transform, shared by both bodies --------------------
    // lean (pitch) and landing crouch per mode
    let lean = 0, crouch = 0;
    if (this.mode === 'ground') {
      if (inputLen > 0 || speed > 0.5) lean = runT * 0.18;
      if (this.exhausted) lean += 0.14 + Math.sin(t * 2.2) * 0.05; // weary slump
      if (this.landSquash > 0) {       // landing crouch squash
        crouch = this.landSquash;
        lean += crouch * 0.15;
      }
    } else if (this.mode === 'glide') {
      lean = this.glidePitch;          // nose-down dive / nose-up flare
    } else if (this.mode === 'mantle') {
      const p = clamp(this.mantleT / 0.35, 0, 1);
      lean = 0.35 - p * 0.25;
    } else if (this.mode === 'climb') {
      lean = 0.25;
    } else if (this.mode === 'swim') {
      lean = 1.15;
    }
    g.rotation.x = lerp(g.rotation.x, lean, ease);

    // roll: glide banking, or a weary side-sway when exhausted on foot
    let roll = 0;
    if (this.mode === 'glide') roll = this.bank;
    else if (this.exhausted && this.mode === 'ground') roll = Math.sin(t * 2.2) * 0.045;
    g.rotation.z = lerp(g.rotation.z, roll, Math.min(1, dt * 8));

    // drawn bow rides in front while aiming, pitching with the camera
    if (this.bowGrp) {
      this.bowGrp.visible = this.aiming && this.bodyReady;
      if (this.aiming) {
        this.bowGrp.position.set(0.3, 1.42, 0.46);
        this.bowGrp.rotation.set(0, -Math.PI / 2, -this.camPitch * 0.9);
      }
    }

    // cape trails with motion and flutters (rides the rig's chest bone too)
    const capeLift = this.mode === 'glide' ? 1.15
      : this.mode === 'climb' ? 0.1
      : clamp(speed / 9, 0, 1) * 0.75;
    this.cape.rotation.x = lerp(this.cape.rotation.x,
      0.12 + capeLift + Math.sin(t * 5.2) * 0.045, Math.min(1, dt * 8));

    // damage blink (the rig root rides group visibility); never hide the
    // fallen hero — updates stop during game over, so a blink-off frame
    // would otherwise freeze him invisible behind the overlay. bodyReady
    // gates everything: nothing shows until the knight (or fallback) is in.
    if (!this.bodyReady && G.time > 8) this.bodyReady = true; // stuck loader safety
    g.visible = this.bodyReady &&
      (G.gameOver || this.iframes <= 0 || (t * 14) % 2 < 1.3);

    // ---- rigged knight: mixer-driven limbs, same sim dt ------------------
    if (this.rigActive) {
      this.moveInput = inputLen;
      this.rig.update(dt, this);
      return;
    }

    // ---- procedural fallback body ----------------------------------------
    let armL = 0, armR = 0, legL = 0, legR = 0;

    if (this.mode === 'ground') {
      if (inputLen > 0 || speed > 0.5) {
        const f = t * (6 + runT * 5);
        legL = Math.sin(f) * (0.5 + runT * 0.45);
        legR = -legL;
        armL = -legL * 0.8; armR = legL * 0.8;
      } else {
        armL = armR = Math.sin(t * 1.6) * 0.04;  // breathe
      }
      if (this.exhausted) { armL += 0.15; armR += 0.15; }
      if (crouch > 0) { legL += crouch * 0.9; legR += crouch * 0.9; }
    } else if (this.mode === 'air') {
      legL = 0.35; legR = -0.2; armL = -0.5; armR = -0.5;
    } else if (this.mode === 'glide') {
      armL = Math.PI - 0.35; armR = Math.PI - 0.35; // arms up to bars
      legL = 0.25 + Math.sin(t * 2) * 0.06; legR = 0.12;
    } else if (this.mode === 'mantle') {
      const p = clamp(this.mantleT / 0.35, 0, 1);
      armL = armR = Math.PI - 0.4 - p * 2.4;   // reach up -> push down
      legL = 0.9 - p * 0.7; legR = 0.55 - p * 0.35;
    } else if (this.mode === 'climb') {
      const f = t * 5;
      armL = Math.PI - 0.3 + Math.sin(f) * 0.25;
      armR = Math.PI - 0.3 - Math.sin(f) * 0.25;
      legL = 0.5 + Math.cos(f) * 0.2; legR = 0.5 - Math.cos(f) * 0.2;
    } else if (this.mode === 'swim') {
      const f = t * 6;
      armL = Math.PI - Math.sin(f) * 0.7; armR = Math.PI - Math.sin(f + Math.PI) * 0.7;
      legL = Math.sin(f) * 0.35; legR = -legL;
    }

    // attack overrides right arm
    if (this.attackT >= 0) {
      const p = this.attackT / 0.42;
      const swing = Math.sin(clamp(p, 0, 1) * Math.PI);
      armR = -0.4 - swing * 1.8;
      this.armR.rotation.z = this.combo === 1 ? -swing * 1.1 : swing * 0.4;
      this.torso.rotation.y = (this.combo === 1 ? 1 : -1) * swing * 0.4;
    } else {
      this.armR.rotation.z = 0;
      this.torso.rotation.y = 0;
    }

    // brief two-hand push when throwing a carried prop
    if (this.throwT >= 0) {
      const tp = Math.sin(clamp(this.throwT / 0.3, 0, 1) * Math.PI);
      armL = armR = -1.5 * tp;
    }

    this.armL.rotation.x = lerp(this.armL.rotation.x, armL, ease);
    if (this.attackT < 0) this.armR.rotation.x = lerp(this.armR.rotation.x, armR, ease);
    else this.armR.rotation.x = armR;
    this.legL.rotation.x = lerp(this.legL.rotation.x, legL, ease);
    this.legR.rotation.x = lerp(this.legR.rotation.x, legR, ease);

    // crouch squash sinks the torso and head onto bent legs
    this.torso.position.y = lerp(this.torso.position.y, -crouch * 0.26, ease);
    this.head.position.y = lerp(this.head.position.y, 1.66 - crouch * 0.34, ease);
    // head droop while exhausted
    this.head.rotation.x = lerp(this.head.rotation.x, this.exhausted ? 0.3 : 0, Math.min(1, dt * 6));
  }

  updateCamera(dt) {
    const cam = G.camera;
    if (this.baseFov === null) this.baseFov = cam.fov;

    // spring distance/height toward per-mode targets (no snapping between modes)
    let tDist = 6.4, tHeight = 2.2;
    if (this.aiming) { tDist = 3.3; tHeight = 1.9; }       // over-shoulder draw
    else if (this.mode === 'glide') { tDist = 8; tHeight = 2.8; }
    else if (this.mode === 'swim') { tDist = 6.8; tHeight = 2.0; }
    this.camDist = lerp(this.camDist, tDist, Math.min(1, dt * 3.5));
    this.camHeight = lerp(this.camHeight, tHeight, Math.min(1, dt * 3.5));

    if (this.lockTarget && !this.lockTarget.dead) {
      // bias camera to keep both in frame
      const e = this.lockTarget;
      const toE = Math.atan2(e.pos.x - this.pos.x, e.pos.z - this.pos.z);
      let d = toE - this.camYaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.camYaw += d * Math.min(1, dt * 3);
    }

    // slight velocity look-ahead of the orbit target
    this.lookX = lerp(this.lookX, clamp(this.vel.x * 0.13, -1.1, 1.1), Math.min(1, dt * 3));
    this.lookZ = lerp(this.lookZ, clamp(this.vel.z * 0.13, -1.1, 1.1), Math.min(1, dt * 3));

    const cy = this.camYaw, cp = this.camPitch;
    // orbit: camera sits behind the facing direction (W walks away from camera)
    CAM_OFF.set(
      -Math.sin(cy) * Math.cos(cp),
      Math.sin(cp),
      -Math.cos(cy) * Math.cos(cp)
    ).multiplyScalar(this.camDist);
    CAM_TGT.set(this.pos.x + this.lookX, this.pos.y + this.camHeight, this.pos.z + this.lookZ);
    // climbing: pivot the orbit off the wall so the occlusion march below
    // isn't fighting the cliff face right at the target
    if (this.mode === 'climb') {
      CAM_TGT.x += this.climbNormal.x * 1.1;
      CAM_TGT.z += this.climbNormal.z * 1.1;
    }
    CAM_POS.copy(CAM_TGT).add(CAM_OFF);

    // smooth chase; first gameplay frame and respawns snap straight to the
    // target chase position so the camera never lerps out of the title or a
    // beacon interior.
    if (!this.camInit || this.camSnap) {
      this.camInit = true;
      this.camSnap = false;
      this.camPosSmooth.copy(CAM_POS);
    } else {
      this.camPosSmooth.lerp(CAM_POS, Math.min(1, dt * 9));
    }
    CAM_POS.copy(this.camPosSmooth);

    // terrain occlusion: march from the look target toward the camera and
    // pull the camera in front of any hill in between (stops cliff clipping).
    // The pull factor is SMOOTHED — tighten fast, release slowly — because on
    // bumpy cliff faces the raw march flips between step values every frame,
    // which used to read as violent camera shake while climbing.
    const STEPS = 10;
    let f = 1;
    for (let i = 2; i <= STEPS; i++) {
      const s = i / STEPS;
      const sx = CAM_TGT.x + (CAM_POS.x - CAM_TGT.x) * s;
      const sy = CAM_TGT.y + (CAM_POS.y - CAM_TGT.y) * s;
      const sz = CAM_TGT.z + (CAM_POS.z - CAM_TGT.z) * s;
      if (heightAt(sx, sz) + 0.35 > sy) { f = Math.max(0.12, (i - 1) / STEPS); break; }
    }
    this.camOccl = f < this.camOccl
      ? lerp(this.camOccl, f, Math.min(1, dt * 14))   // tighten fast (never clip long)
      : lerp(this.camOccl, f, Math.min(1, dt * 2.5)); // release gently (no popping)
    if (this.camOccl < 0.999) CAM_POS.sub(CAM_TGT).multiplyScalar(this.camOccl).add(CAM_TGT);

    // keep camera above terrain
    const ch = heightAt(CAM_POS.x, CAM_POS.z) + 0.5;
    if (CAM_POS.y < ch) CAM_POS.y = ch;

    // hard structure colliders should not swallow the camera. Soft standable
    // tops are ignored so tower rings and platforms still frame naturally.
    for (const c of G.colliders) {
      if (c.soft || !c.r) continue;
      if (c.top !== undefined && CAM_POS.y > c.top + 0.6) continue;
      if (c.bottom !== undefined && CAM_POS.y < c.bottom - 0.6) continue;
      let dx = CAM_POS.x - c.x, dz = CAM_POS.z - c.z;
      let d2 = dx * dx + dz * dz;
      const min = c.r + 0.45;
      if (d2 >= min * min) continue;
      if (d2 < 1e-6) {
        dx = CAM_POS.x - CAM_TGT.x;
        dz = CAM_POS.z - CAM_TGT.z;
        d2 = dx * dx + dz * dz;
        if (d2 < 1e-6) { dx = -Math.sin(this.camYaw); dz = -Math.cos(this.camYaw); d2 = 1; }
      }
      const d = Math.sqrt(d2);
      CAM_POS.x = c.x + (dx / d) * min;
      CAM_POS.z = c.z + (dz / d) * min;
      const gh = heightAt(CAM_POS.x, CAM_POS.z) + 0.5;
      if (CAM_POS.y < gh) CAM_POS.y = gh;
    }

    // camera shake: decaying trig noise, consumed only here
    const sh = Math.min(G.camShake, 1.2);
    if (sh > 0.002) {
      const st = G.time;
      CAM_POS.x += (Math.sin(st * 39.7) + Math.sin(st * 71.3 + 1.3)) * 0.055 * sh;
      CAM_POS.y += (Math.sin(st * 47.1 + 0.7) + Math.sin(st * 83.7 + 2.1)) * 0.045 * sh;
      CAM_POS.z += (Math.sin(st * 43.9 + 2.6) + Math.sin(st * 67.1 + 0.4)) * 0.055 * sh;
    }
    G.camShake = Math.min(G.camShake, 1.2) * Math.exp(-6 * dt);

    cam.position.copy(CAM_POS);
    cam.lookAt(CAM_TGT.x, CAM_TGT.y + 0.2, CAM_TGT.z);

    // FOV kick: sprint +4, glide dive +6, aim zooms in, springs back on stop
    const kick = this.aiming ? -6 : this.sprinting ? 4 : (this.mode === 'glide' && this.glideDive ? 6 : 0);
    this.fovKick = lerp(this.fovKick, kick, Math.min(1, dt * 5));
    const nf = this.baseFov + this.fovKick;
    if (Math.abs(nf - cam.fov) > 0.05) {
      cam.fov = nf;
      cam.updateProjectionMatrix();
    }
  }
}
