// Terrain: analytic height field (shared by rendering + physics),
// terrain mesh with vertex colors, water plane, minimap image.
import * as THREE from 'three';
import { fbm, ridge, smoothstep, clamp, lerp } from './noise.js';
import { G } from './state.js';

export const WORLD_R = 480;      // playable radius
export const WATER_Y = 0;

// ---- height field -----------------------------------------------------

export function heightAt(x, z) {
  const d = Math.hypot(x, z);

  // rolling plains
  let h = 5 + fbm(x * 0.0032, z * 0.0032, 4) * 13
        + fbm(x * 0.013 + 7, z * 0.013 + 3, 2) * 2.2;

  // mountains (boundary ring + interior massif), terraced into
  // climbable cliff shelves
  let m = 0;
  const ringT = smoothstep(300, 470, d);
  m += ringT * (18 + ridge(x * 0.0042 + 31, z * 0.0042 + 11, 3) * 55);
  const dm = Math.hypot(x + 120, z + 260);
  m += smoothstep(190, 40, dm) * (26 + ridge(x * 0.006 + 4, z * 0.006 + 9, 3) * 30);
  if (m > 2) {
    const stepH = 13;
    const f = m / stepH;
    const fl = Math.floor(f);
    const terraced = (fl + smoothstep(0.36, 0.68, f - fl)) * stepH;
    m = lerp(m, terraced, 0.75);
  }
  h += m;

  // river winding through the plains
  const rv = fbm(x * 0.0022 + 100, z * 0.0022 - 50, 3);
  const rw = 0.075;
  if (Math.abs(rv) < rw && d < 430) {
    const t = 1 - Math.abs(rv) / rw;
    h -= t * t * (7 + 4 * smoothstep(0.4, 1, t));
  }

  // lake basin to the west
  const dl = Math.hypot(x + 170, z - 120);
  h -= smoothstep(95, 25, dl) * 11;

  // spawn plateau (cliff-edged) in the south-east
  const dp = Math.hypot(x - 60, z + 80);
  h += smoothstep(63, 56, dp) * 16;

  return h;
}

// true when (x,z) lies in the river channel — used for region naming
export function inRiver(x, z) {
  const d = Math.hypot(x, z);
  if (d >= 430) return false;
  return Math.abs(fbm(x * 0.0022 + 100, z * 0.0022 - 50, 3)) < 0.09;
}

// The Long Reed: the current's direction at a river point. The river runs
// ALONG the channel (the fbm isoline where inRiver is true), so flow is the
// tangent perpendicular to that field's gradient — oriented downhill by a
// coarse terrain slope so it stays smooth instead of flickering with noise.
const _riverFlow = [0, 0];
const _riverField = (x, z) => fbm(x * 0.0022 + 100, z * 0.0022 - 50, 3);
export function riverFlow(x, z) {
  const e = 4;
  const rx = _riverField(x + e, z) - _riverField(x - e, z);
  const rz = _riverField(x, z + e) - _riverField(x, z - e);
  let tx = -rz, tz = rx;                       // tangent along the channel
  const tl = Math.hypot(tx, tz);
  if (tl < 1e-6) { _riverFlow[0] = 0; _riverFlow[1] = 0; return _riverFlow; }
  tx /= tl; tz /= tl;
  const E = 18;                                // coarse slope picks downstream
  const dh = heightAt(x + tx * E, z + tz * E) - heightAt(x - tx * E, z - tz * E);
  if (dh > 0) { tx = -tx; tz = -tz; }          // flow toward the lower ground
  _riverFlow[0] = tx; _riverFlow[1] = tz;
  return _riverFlow;
}

export function normalAt(x, z, out) {
  const e = 0.9;
  const hx = heightAt(x + e, z) - heightAt(x - e, z);
  const hz = heightAt(x, z + e) - heightAt(x, z - e);
  out.set(-hx, 2 * e, -hz).normalize();
  return out;
}

// slope in [0..1]: 0 flat, 1 vertical-ish
export function slopeAt(x, z) {
  const e = 0.9;
  const hx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
  const hz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
  const g = Math.hypot(hx, hz);
  return g / Math.sqrt(1 + g * g); // sin of slope angle
}

// ---- coloring ---------------------------------------------------------

const C = {
  grassA: new THREE.Color(0x76bc48),  // vivid meadow green
  grassB: new THREE.Color(0xaac154),  // dry yellow-green
  grassC: new THREE.Color(0x4c9840),  // deep lush green (meadow patches)
  rock: new THREE.Color(0x94897a),    // warm grey
  rockHi: new THREE.Color(0xa89d8e),
  sand: new THREE.Color(0xe0d09b),    // pale sand
  snow: new THREE.Color(0xf0f4fa),    // bluish white
  dirt: new THREE.Color(0x9a7f55),    // warm dirt
};
const tmpC = new THREE.Color();

// wide-stencil slope for coloring so cliff faces read as rock even when
// mesh vertices straddle the riser
function slopeWide(x, z) {
  let s = slopeAt(x, z);
  for (const [dx, dz] of [[2.2, 0], [-2.2, 0], [0, 2.2], [0, -2.2]]) {
    const s2 = slopeAt(x + dx, z + dz);
    if (s2 > s) s = s2;
  }
  return s;
}

// just the grass ramp of groundColor — cheap enough to run per grass blade,
// so the blade field and the ground beneath it share one palette.
// returns the dryness v so callers can gate blade density on dirt patches.
const R_GOLD = new THREE.Color(0xb99a3e);   // Thornwood: ginkgo-gold ground
const R_LUSH = new THREE.Color(0x3f9a58);   // Mirrormere: lush teal-green
const R_GREY = new THREE.Color(0x7d8a68);   // Stormridge: wind-scoured sage

export function grassColorAt(x, z, out) {
  const v = fbm(x * 0.02 + 40, z * 0.02 - 17, 2) * 0.5 + 0.5;
  out.copy(C.grassA).lerp(C.grassB, v);
  // broad meadow drifts: whole hillsides swing between lush and sun-dried
  const patch = fbm(x * 0.0045 - 220, z * 0.0045 + 90, 2) * 0.5 + 0.5;
  out.lerp(C.grassC, smoothstep(0.52, 0.9, patch) * 0.55);
  // region identity tints: each named land reads differently underfoot
  const dT = Math.hypot(x - 80, z - 200);     // Thornwood
  if (dT < 110) out.lerp(R_GOLD, (1 - dT / 110) * 0.4);
  const dM = Math.hypot(x + 170, z - 120);    // Mirrormere
  if (dM < 120) out.lerp(R_LUSH, (1 - dM / 120) * 0.35);
  const dS = Math.hypot(x + 120, z + 260);    // Stormridge
  if (dS < 170) out.lerp(R_GREY, (1 - dS / 170) * 0.45);
  // dry patches
  if (v > 0.72) out.lerp(C.dirt, (v - 0.72) * 1.4);
  return v;
}

export function groundColor(x, z, h, out) {
  const s = slopeWide(x, z);
  const v = grassColorAt(x, z, out); // dryness also drives the rock tint below
  // beach
  if (h < WATER_Y + 1.4) out.lerp(C.sand, smoothstep(WATER_Y + 1.4, WATER_Y + 0.2, h));
  // rock on steep slopes, with faint strata bands across the cliff faces
  const rockT = smoothstep(0.5, 0.68, s);
  tmpC.copy(C.rock).lerp(C.rockHi, v);
  const band = Math.sin(h * 0.85 + fbm(x * 0.05, z * 0.05, 1) * 3.0);
  tmpC.multiplyScalar(1 - smoothstep(0.2, 0.9, band) * 0.12);
  out.lerp(tmpC, rockT);
  // high altitude rock and snow
  out.lerp(tmpC, smoothstep(30, 44, h) * 0.85);
  out.lerp(C.snow, smoothstep(52, 66, h) * (1 - smoothstep(0.8, 0.95, s)));
  // concavity AO: gully floors and crease lines sit darker, crests catch sun
  const e = 2.6;
  const lap = (heightAt(x + e, z) + heightAt(x - e, z) +
               heightAt(x, z + e) + heightAt(x, z - e)) * 0.25 - h;
  out.multiplyScalar(1 - clamp(lap * 0.5, 0, 0.22));
  out.multiplyScalar(1 + clamp(-lap * 0.3, 0, 0.09));
  return out;
}

// ---- meshes -----------------------------------------------------------

function makeToonGradient() {
  // 6-step gradient map with linear filtering: broad light bands with
  // soft edges (TotK-style soft cel) instead of hard posterized steps
  const data = new Uint8Array([105, 132, 175, 215, 245, 255]);
  const tex = new THREE.DataTexture(data, 6, 1, THREE.RedFormat);
  tex.needsUpdate = true;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  return tex;
}
export const toonGradient = makeToonGradient();

export function toonMat(opts = {}) {
  return new THREE.MeshToonMaterial({ gradientMap: toonGradient, ...opts });
}

let terrainMat = null;

export function buildTerrain() {
  const size = 1100, seg = 384;
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const col = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const h = heightAt(x, z);
    pos.setY(i, h);
    groundColor(x, z, h, col);
    colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mat = toonMat({ vertexColors: true });
  // detail pass: fine ground grain up close (breaks up the flat vertex-color
  // fill) and big soft cloud shadows drifting across the land
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = { value: 0 };
    sh.uniforms.uCloudShade = { value: 0.15 };
    mat.userData.sh = sh;
    sh.vertexShader = 'varying vec3 vWpos;\n' + sh.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vWpos = (modelMatrix * vec4(transformed, 1.0)).xyz;`
    );
    sh.fragmentShader = `uniform float uTime;
      uniform float uCloudShade;
      varying vec3 vWpos;
      float thash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float tnoise(vec2 p){
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(thash(i), thash(i + vec2(1.0, 0.0)), f.x),
                   mix(thash(i + vec2(0.0, 1.0)), thash(i + vec2(1.0, 1.0)), f.x), f.y);
      }
    ` + sh.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
       // two-scale grain: fine detail up close, coarse mottling far out so
       // distant fields still read as grassland instead of flat fill
       float dist = distance(vWpos, cameraPosition);
       float dNear = 1.0 - smoothstep(60.0, 240.0, dist);
       float dFar = 1.0 - smoothstep(150.0, 700.0, dist);
       diffuseColor.rgb *= 1.0 + (tnoise(vWpos.xz * 1.9) - 0.5) * 0.09 * dNear
                               + (tnoise(vWpos.xz * 0.31) - 0.5) * 0.11 * dFar;
       // drifting cumulus shadows sweeping the valley
       float cs = 0.65 * tnoise(vWpos.xz * 0.0045 + vec2(uTime * 0.011, uTime * 0.004))
                + 0.35 * tnoise(vWpos.xz * 0.011 - vec2(uTime * 0.007, 0.0));
       diffuseColor.rgb *= 1.0 - smoothstep(0.52, 0.8, cs) * uCloudShade;`
    );
  };
  terrainMat = mat;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  G.scene.add(mesh);
  return mesh;
}

// Bake a shore-shallowness texture from the height field (once, at build
// time). Each texel encodes how close the terrain below is to the water
// surface: 1 at/above the waterline, falling to 0 at depth >= 1.2 units.
// Covers the same 1100x1100 extent as the water plane.
function makeFoamTexture(px = 256) {
  const data = new Uint8Array(px * px);
  const half = 550;
  for (let j = 0; j < px; j++) {
    for (let i = 0; i < px; i++) {
      const x = (i / (px - 1)) * 2 * half - half;
      const z = (j / (px - 1)) * 2 * half - half;
      const depth = WATER_Y - heightAt(x, z);
      data[j * px + i] = Math.round(clamp(1 - depth / 1.2, 0, 1) * 255);
    }
  }
  const tex = new THREE.DataTexture(data, px, px, THREE.RedFormat);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

let waterMat;
export function buildWater() {
  const geo = new THREE.PlaneGeometry(1100, 1100, 60, 60);
  geo.rotateX(-Math.PI / 2);
  const foamTex = makeFoamTexture();
  waterMat = new THREE.MeshToonMaterial({
    gradientMap: toonGradient,
    color: 0x3fa8c8,
    transparent: true,
    opacity: 0.82,
  });
  waterMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = { value: 0 };
    sh.uniforms.uFoam = { value: foamTex };
    waterMat.userData.sh = sh;
    sh.vertexShader = 'uniform float uTime;\nvarying vec2 vWpos;\n' + sh.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
       vWpos = position.xz;
       transformed.y += sin(position.x * 0.11 + uTime * 1.3) * 0.14
                      + cos(position.z * 0.13 + uTime * 1.7) * 0.12;`
    );
    sh.fragmentShader = 'uniform float uTime;\nuniform sampler2D uFoam;\nvarying vec2 vWpos;\n' + sh.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
       float shore = texture2D(uFoam, vWpos / 1100.0 + 0.5).r;
       // depth tint: deep water falls toward inky blue, shallows glow turquoise
       diffuseColor.rgb = mix(diffuseColor.rgb * vec3(0.34, 0.52, 0.80),
                              diffuseColor.rgb * vec3(1.02, 1.12, 1.0),
                              smoothstep(0.05, 0.85, shore));
       // near-white sparkle bands (post bloom picks these up)
       float band = sin(vWpos.x * 0.16 + uTime * 0.8) * cos(vWpos.y * 0.13 - uTime * 0.6);
       diffuseColor.rgb += smoothstep(0.70, 0.98, band) * vec3(0.42, 0.45, 0.42);
       diffuseColor.rgb += smoothstep(0.85, 1.0, -band) * vec3(0.05, 0.08, 0.1);
       // animated white shore foam from the baked shallowness mask
       float wob = sin(vWpos.x * 0.7 + uTime * 1.4) * cos(vWpos.y * 0.6 - uTime * 1.1) * 0.07
                 + sin((vWpos.x + vWpos.y) * 0.3 + uTime * 0.7) * 0.05;
       float foam = smoothstep(0.52, 0.80, shore + wob) * 0.75
                  + smoothstep(0.88, 0.985, shore) * 0.85;
       foam = clamp(foam, 0.0, 1.0);
       diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), foam);
       diffuseColor.a = mix(diffuseColor.a, 1.0, foam * 0.6);`
    );
  };
  const mesh = new THREE.Mesh(geo, waterMat);
  mesh.position.y = WATER_Y;
  mesh.name = 'water';
  G.scene.add(mesh);
  return mesh;
}

export function updateWater(t) {
  if (waterMat && waterMat.userData.sh) waterMat.userData.sh.uniforms.uTime.value = t;
  if (terrainMat && terrainMat.userData.sh) {
    const sh = terrainMat.userData.sh;
    sh.uniforms.uTime.value = t;
    // rain flattens the light, so the drifting cloud shadows fade with wetness
    const w = G.weather;
    sh.uniforms.uCloudShade.value = 0.15 * (1 - (w ? w.wetness : 0) * 0.75);
  }
}

// ---- minimap source image ----------------------------------------------

function paintMapRows(img, px, j0, j1) {
  const col = new THREE.Color();
  const half = 550;
  for (let j = j0; j < j1; j++) {
    for (let i = 0; i < px; i++) {
      const x = (i / (px - 1)) * 2 * half - half;
      const z = (j / (px - 1)) * 2 * half - half;
      const h = heightAt(x, z);
      if (h < WATER_Y + 0.05) col.set(0x3fa8c8);
      else groundColor(x, z, h, col);
      // simple hillshade
      const e = 4;
      const shade = clamp(0.85 + (heightAt(x - e, z - e) - h) * 0.05, 0.55, 1.15);
      const k = ((j - j0) * px + i) * 4;
      img.data[k] = col.r * 255 * shade;
      img.data[k + 1] = col.g * 255 * shade;
      img.data[k + 2] = col.b * 255 * shade;
      img.data[k + 3] = 255;
    }
  }
}

export function renderMapImage(px = 256) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = px;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(px, px);
  paintMapRows(img, px, 0, px);
  ctx.putImageData(img, 0, 0);
  return cv;
}

// progressive variant: paints a few rows per timeout tick so the big M-map
// can be prepared in the background without ever hitching a frame. Returns
// the canvas immediately (it fills top-to-bottom); onDone fires when complete.
export function renderMapImageAsync(px = 512, rowsPerTick = 6, onDone = null) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = px;
  const ctx = cv.getContext('2d');
  let j0 = 0;
  const step = () => {
    const j1 = Math.min(px, j0 + rowsPerTick);
    const img = ctx.createImageData(px, j1 - j0);
    paintMapRows(img, px, j0, j1);
    ctx.putImageData(img, 0, j0);
    j0 = j1;
    if (j0 < px) setTimeout(step, 30);
    else if (onDone) onDone();
  };
  setTimeout(step, 1200); // let boot + first frames breathe before starting
  return cv;
}
