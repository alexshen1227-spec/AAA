// Sky dome with day/night cycle, sun/moon, stars, drifting clouds,
// the scene lighting that follows the cycle, and the living weather
// system: clear/breeze/overcast/rain/storm states that crossfade light,
// fog, cloud cover and sky saturation, instanced rain streaks, storm
// lightning, and TotK-signature white wind lines (ambient drift +
// rising streaks inside G.updraftZones).
// Painterly-pastel restyle: three-stop gradient dome with a layered
// horizon haze, warm sun glow, big flat-bottomed cumulus and bluish
// readable nights.
// sky.js is the only WRITER of G.weather = { kind, windMul, wetness }.
import * as THREE from 'three';
import { G } from './state.js';
import { makeGlow, spawnSparkle } from './world.js';
import { heightAt, slopeAt, WATER_Y } from './terrain.js';
import { hash2, lerp, clamp, smoothstep } from './noise.js';

const DAY_LENGTH = 600; // seconds for a full cycle

let skyMat, sun, moon, sunHalo, hemi, dirLight, ambient, clouds = [];
let cloudMat = null;
let cirrusMat = null;
const cirrus = [];
// phase-4 sky life: meteors, moon halo, rainbow, blood aurora, moonglade
const shootPool = [];
let shootNextAt = 30;
let moonGlow = null;
let rainbow = null, rainbowW = 0, prevWet = 0;
let auroraMat = null; const auroras = [];
let auroraW = 0;
let moonGlade = null;
// deed-stars: the Wayfarer constellation — one warm star per deed in
// remember.js DEEDS (index order matters). Camera-relative like sun/moon.
let deedGroup = null;
const deedStars = [];   // {sprite, fade}
let deedLines = null, deedLineCol = null, deedLineMax = 0;
const DEED_POINTS = [   // (u,v) star chart of the striding Wayfarer
  [0, 0.42], [0, 0.95], [0.85, 1.15], [0.36, 0.58], [-0.34, 0.6],
  [-0.88, 0.72], [-0.18, -0.06], [0.2, -0.02], [0.5, -0.5], [0.74, -0.95],
  [-0.42, -0.55], [-0.68, -1.0], [0.62, 0.12], [-0.62, 0.32],
];
const DEED_EDGES = [[1, 0], [0, 4], [0, 3], [0, 6], [0, 7], [3, 12], [12, 2],
  [4, 13], [13, 5], [6, 10], [10, 11], [7, 8], [8, 9]];
const _svec = new THREE.Vector3();
const _X_AXIS = new THREE.Vector3(1, 0, 0);
const RED_TOP = new THREE.Color(0x260812);
const RED_MID = new THREE.Color(0x3c0f18);
const RED_BOT = new THREE.Color(0x5a1420);
const RED_FOG = new THREE.Color(0x340e16);

// module-scope temps so updateSky stays allocation-free
const _sunDir = new THREE.Vector3();
const _negDir = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _sampleCol = new THREE.Color();
const _grey = new THREE.Color();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _side = new THREE.Vector3();
const _nrm = new THREE.Vector3();
const _toCam = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m4 = new THREE.Matrix4();
const GLOW_HI = new THREE.Color(0xfff2dc);  // subtle warm dome glow at high sun
const GLOW_LOW = new THREE.Color(0xffa050); // wide rose-gold glow at low sun
const CLOUD_NIGHT = new THREE.Color(0x39415e); // moonlit slate
const _cloudTint = new THREE.Color();
const _warm = new THREE.Color();

const PALETTE = {
  // dayTime keyframes: 0 midnight, .22 dawn, .35 morning, .5 noon, .68 dusk, .78 night
  keys: [0.0, 0.22, 0.3, 0.5, 0.68, 0.78, 1.0],
  // zenith: deep indigo night, lavender-blue dawn, saturated azure noon, magenta-cast dusk
  top: [0x0d1430, 0x5566b0, 0x3277d8, 0x2b7de2, 0x3b3d78, 0x0d1430, 0x0d1430].map(c => new THREE.Color(c)),
  // mid band (~0.15 up the dome): the pastel body of the sky
  mid: [0x141d3c, 0xcf9fae, 0x8fc4ec, 0x8ccaf2, 0xcb7a80, 0x141d3c, 0x141d3c].map(c => new THREE.Color(c)),
  // horizon: pale and luminous by day, rose-gold dawn, coral-orange dusk, blue night
  bottom: [0x1b2748, 0xf5b06a, 0xdcedf6, 0xddf1f8, 0xff7e4f, 0x1b2748, 0x1b2748].map(c => new THREE.Color(c)),
  // directional light: bluish moonlight at night so the world reads blue, never grey
  sunCol: [0x8fa5cc, 0xffb877, 0xfff2d8, 0xfff6e6, 0xff9a5a, 0x8fa5cc, 0x8fa5cc].map(c => new THREE.Color(c)),
  sunInt: [0.3, 0.6, 1.15, 1.35, 0.6, 0.32, 0.3],
  hemiInt: [0.34, 0.52, 0.8, 0.92, 0.52, 0.36, 0.34],
  // blue-leaning aerial haze: distant terrain fades into atmosphere, not white-out
  fog: [0x162040, 0xecc39a, 0xbdd8ee, 0xc4def2, 0xeba17e, 0x162040, 0x162040].map(c => new THREE.Color(c)),
};

function sample(arr, t) {
  const k = PALETTE.keys;
  for (let i = 0; i < k.length - 1; i++) {
    if (t >= k[i] && t <= k[i + 1]) {
      const f = (t - k[i]) / (k[i + 1] - k[i]);
      const a = arr[i], b = arr[i + 1];
      if (a instanceof THREE.Color) return _sampleCol.copy(a).lerp(b, f);
      return lerp(a, b, f);
    }
  }
  return arr[0];
}

// ---- weather state machine ---------------------------------------------------
// Visual params per state. light scales sun/hemi, fogNear/fogFar multiply the
// altitude-based fog distances, cloud is extra coverage 0..1, grim drives the
// grey desaturation of sky/fog/clouds. windMul/wetness go out via G.weather.
const WEATHER_PARAMS = {
  clear:    { windMul: 1.0, wetness: 0.00, light: 1.00, fogNear: 1.00, fogFar: 1.00, cloud: 0.00, grim: 0.00 },
  breeze:   { windMul: 1.6, wetness: 0.00, light: 0.96, fogNear: 1.00, fogFar: 1.00, cloud: 0.18, grim: 0.08 },
  overcast: { windMul: 1.3, wetness: 0.10, light: 0.60, fogNear: 0.72, fogFar: 0.78, cloud: 0.80, grim: 0.55 },
  rain:     { windMul: 1.7, wetness: 0.75, light: 0.55, fogNear: 0.50, fogFar: 0.55, cloud: 0.95, grim: 0.70 },
  storm:    { windMul: 2.2, wetness: 1.00, light: 0.45, fogNear: 0.38, fogFar: 0.45, cloud: 1.00, grim: 0.85 },
};
const WEATHER_FIELDS = ['windMul', 'wetness', 'light', 'fogNear', 'fogFar', 'cloud', 'grim'];
// weighted transitions: clear-heavy overall, storm rare and only via wet states
const WEATHER_NEXT = {
  clear:    [['clear', 30], ['breeze', 35], ['overcast', 27], ['rain', 8]],
  breeze:   [['clear', 45], ['breeze', 12], ['overcast', 28], ['rain', 15]],
  overcast: [['clear', 28], ['breeze', 20], ['overcast', 7], ['rain', 33], ['storm', 12]],
  rain:     [['clear', 18], ['breeze', 12], ['overcast', 32], ['rain', 8], ['storm', 30]],
  storm:    [['clear', 15], ['breeze', 5], ['overcast', 30], ['rain', 50]],
};
const WEATHER_FADE = 8; // seconds to crossfade all visual params

let wKind = 'clear';                                    // current (target) state
const wPrev = Object.assign({}, WEATHER_PARAMS.clear);  // params fading from
const wCur = Object.assign({}, WEATHER_PARAMS.clear);   // blended params, per frame
let wBlend = 1;                                         // 0..1 crossfade progress
let wDwell = 70 + Math.random() * 110;                  // seconds until next roll
let rainSustain = 0;                                    // seconds above real-rain threshold

const STORM_GUST_WARN = 1.1;
const STORM_GUST_DUR = 0.8;
let stormGustPhase = 0; // 0 waiting, 1 telegraph, 2 pulse
let stormGustT = 0;
let stormGustTimer = 6;
let stormGustAngle = 0;

function pickNextWeather() {
  const table = WEATHER_NEXT[wKind];
  let total = 0;
  for (let i = 0; i < table.length; i++) total += table[i][1];
  let r = Math.random() * total;
  for (let i = 0; i < table.length; i++) {
    r -= table[i][1];
    if (r <= 0) return table[i][0];
  }
  return 'clear';
}

function startWeather(next) {
  for (let i = 0; i < WEATHER_FIELDS.length; i++) {
    const f = WEATHER_FIELDS[i];
    wPrev[f] = wCur[f]; // fade from wherever the blend currently sits
  }
  wKind = next;
  wBlend = 0;
}

// External weather lock (the finale storm). While locked, the dwell roll is
// suspended and the sky holds the requested state; pass null to release.
// A single lock slot — re-requesting the same kind is a no-op, so entering
// and leaving the caller's trigger radius repeatedly cannot stack anything.
let weatherLock = null;
export function requestWeather(kind) {
  if (kind === null) { weatherLock = null; return; }
  if (!WEATHER_PARAMS[kind]) return;
  weatherLock = kind;
  if (wKind !== kind) startWeather(kind);
}

function updateWeather(dt) {
  if (weatherLock) {
    if (wKind !== weatherLock) startWeather(weatherLock);
  } else {
    wDwell -= dt;
    if (wDwell <= 0) {
      wDwell = 60 + Math.random() * 120;
      let next = pickNextWeather();
      if (next === 'storm' && G.bloodNight) next = 'rain'; // no storms under the crimson moon
      if (next !== wKind) startWeather(next);
    }
  }
  if (G.bloodNight && wKind === 'storm' && !weatherLock) startWeather('rain');
  if (wBlend < 1) wBlend = Math.min(1, wBlend + dt / WEATHER_FADE);
  const tgt = WEATHER_PARAMS[wKind];
  for (let i = 0; i < WEATHER_FIELDS.length; i++) {
    const f = WEATHER_FIELDS[i];
    wCur[f] = lerp(wPrev[f], tgt[f], wBlend);
  }
  // shared contract: sky.js is the sole writer of G.weather (mutate in place)
  G.weather.kind = wKind;
  G.weather.windMul = wCur.windMul;
  G.weather.wetness = wCur.wetness;
  G.weather.grim = wCur.grim; // post.js reads this to fade the god rays
  if (wCur.wetness > 0.55) rainSustain += dt;
  else rainSustain = Math.max(0, rainSustain - dt * 1.5);
  G.weather.rainTime = rainSustain;
  G.weather.campQuiet = clamp((rainSustain - 3) / 3, 0, 1) *
    clamp((wCur.wetness - 0.35) / 0.65, 0, 1);
}

function updateStormGust(dt) {
  G.weather.gustTelegraph = 0;
  G.weather.gustPulse = 0;
  G.weather.gustDx = Math.cos(stormGustAngle);
  G.weather.gustDz = Math.sin(stormGustAngle);

  const activeStorm = wKind === 'storm' && wBlend > 0.6 && !G.bloodNight && G.started;
  if (!activeStorm) {
    stormGustPhase = 0;
    stormGustT = 0;
    stormGustTimer = Math.max(stormGustTimer, 4);
    return;
  }

  if (stormGustPhase === 0) {
    stormGustTimer -= dt;
    if (stormGustTimer <= 0 && lightningState === 0) {
      stormGustPhase = 1;
      stormGustT = STORM_GUST_WARN;
      stormGustAngle = hash2((G.time * 10) | 0, G.dayCount || 0, 913) * Math.PI * 2;
      G.weather.gustDx = Math.cos(stormGustAngle);
      G.weather.gustDz = Math.sin(stormGustAngle);
      // Flush ambient slots so every replacement line points down the warned
      // direction instead of leaving contradictory old wind trails onscreen.
      for (let i = STREAK_UP; i < STREAK_N; i++)
        streakData[i * STREAK_STRIDE + 5] = 0;
      if (G.audio) G.audio.sfx('windup');
      if (G.ui && G.player && G.player.mode === 'glide')
        G.ui.toast('A storm gust is building — steer into it', 0xd8f3ff);
    }
  } else if (stormGustPhase === 1) {
    stormGustT -= dt;
    G.weather.gustTelegraph = clamp(1 - stormGustT / STORM_GUST_WARN, 0, 1);
    if (stormGustT <= 0) {
      stormGustPhase = 2;
      stormGustT = STORM_GUST_DUR;
      if (G.audio) G.audio.sfx('updraft');
    }
  } else {
    stormGustT -= dt;
    const p = clamp(1 - stormGustT / STORM_GUST_DUR, 0, 1);
    G.weather.gustPulse = Math.sin(p * Math.PI);
    if (stormGustT <= 0) {
      stormGustPhase = 0;
      stormGustTimer = 7 + hash2((G.time * 7) | 0, 411) * 6;
      G.weather.gustPulse = 0;
    }
  }
}

// desaturate + slightly darken a color in place (weather greying)
function greyLerp(c, k) {
  if (k <= 0) return c;
  const l = c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
  _grey.setRGB(l, l, l);
  c.lerp(_grey, k * 0.75).multiplyScalar(1 - k * 0.3);
  return c;
}

// ---- lightning ----------------------------------------------------------------
const FLASH_DUR = 0.09; // seconds — a 2-frame-ish spike
const LIGHTNING_WARN = 1.1;
const LIGHTNING_AFTER = 0.24;
let boltTimer = 9;
let flashT = 0;
let thunderT = -1; // pending thunder delay; -1 = none
let lightningState = 0; // 0 waiting, 1 warned target, 2 impact afterglow
let lightningT = 0;
let strikeX = 0, strikeY = 0, strikeZ = 0;
let lightningRing = null, lightningPillar = null, lightningGlow = null;

function buildLightningMarker() {
  lightningRing = new THREE.Mesh(
    new THREE.RingGeometry(1.55, 2.05, 32),
    new THREE.MeshBasicMaterial({
      color: 0xbfe8ff, transparent: true, opacity: 0,
      depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    })
  );
  lightningRing.rotation.x = -Math.PI / 2;
  lightningPillar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.14, 1, 6),
    new THREE.MeshBasicMaterial({
      color: 0xdff7ff, transparent: true, opacity: 0,
      depthWrite: false, blending: THREE.AdditiveBlending,
    })
  );
  lightningPillar.frustumCulled = false;
  lightningGlow = makeGlow(0xc9efff, 4.5);
  lightningRing.visible = lightningPillar.visible = lightningGlow.visible = false;
  G.scene.add(lightningRing, lightningPillar, lightningGlow);
}

function chooseLightningTarget() {
  const pl = G.player;
  if (!pl || pl.mode !== 'ground') return false;
  const p = pl.pos;
  const seed = (G.time * 10) | 0;
  for (let i = 0; i < 10; i++) {
    const a = hash2(seed, i, 701) * Math.PI * 2;
    // Start inside the danger radius, but never dead-centre: walking roughly
    // one body length during the 1.1s warning is enough to escape.
    const r = 0.65 + hash2(seed, i, 709) * 0.65;
    const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
    const y = heightAt(x, z);
    if (y <= WATER_Y + 0.25 || slopeAt(x, z) > 0.62 || Math.abs(y - p.y) > 1.6) continue;
    let hidden = false;
    for (let j = 0; j < G.colliders.length; j++) {
      const c = G.colliders[j];
      if (c.soft || !c.r) continue;
      const dx = x - c.x, dz = z - c.z;
      if (dx * dx + dz * dz < (c.r + 2.2) * (c.r + 2.2)) { hidden = true; break; }
    }
    if (hidden) continue;
    strikeX = x; strikeY = y; strikeZ = z;
    return true;
  }
  return false;
}

function showLightningMarker() {
  lightningRing.visible = lightningPillar.visible = lightningGlow.visible = true;
  lightningRing.position.set(strikeX, strikeY + 0.07, strikeZ);
  lightningPillar.position.set(strikeX, strikeY + 20, strikeZ);
  lightningGlow.position.set(strikeX, strikeY + 0.35, strikeZ);
}

function hideLightningMarker() {
  if (!lightningRing) return;
  lightningRing.visible = lightningPillar.visible = lightningGlow.visible = false;
}

function updateLightning(dt) {
  if (thunderT >= 0) {
    thunderT -= dt;
    if (thunderT < 0) {
      if (G.audio) G.audio.sfx('thunder');
      thunderT = -1;
    }
  }
  if (flashT > 0) flashT -= dt;

  const storm = wKind === 'storm' && wBlend > 0.6 && !G.bloodNight && G.started;
  if (lightningState === 0) {
    hideLightningMarker();
    if (storm && !G.gameOver && stormGustPhase === 0) {
      boltTimer -= dt;
      if (boltTimer <= 0) {
        if (chooseLightningTarget()) {
          lightningState = 1;
          lightningT = LIGHTNING_WARN;
          showLightningMarker();
          if (G.audio) G.audio.sfx('windup');
          if (G.ui) G.ui.toast('Lightning gathering — move from the ring!', 0xd8f3ff);
        } else boltTimer = 1; // perched/climbing: retry later, never strike blindly
      }
    }
  } else if (lightningState === 1) {
    lightningT -= dt;
    const p = clamp(1 - lightningT / LIGHTNING_WARN, 0, 1);
    const pulse = 0.82 + Math.sin(G.time * 24) * 0.18;
    lightningRing.scale.setScalar(1 + Math.sin(G.time * 10) * 0.06);
    lightningRing.material.opacity = (0.22 + p * 0.5) * pulse;
    lightningPillar.scale.set(0.28 + p * 0.5, 40, 0.28 + p * 0.5);
    lightningPillar.material.opacity = (0.08 + p * 0.26) * pulse;
    lightningGlow.material.opacity = 0.22 + p * 0.5;
    lightningGlow.scale.setScalar(3.5 + p * 2.2);
    if (lightningT <= 0) {
      lightningState = 2;
      lightningT = LIGHTNING_AFTER;
      flashT = FLASH_DUR;
      thunderT = 0.06;
      G.camShake += 0.48;
      G.hitStopT = Math.max(G.hitStopT, 0.06);
      spawnSparkle(strikeX, strikeY + 0.35, strikeZ, 0xdff7ff, 34, 7);
      const pl = G.player;
      if (pl && Math.hypot(pl.pos.x - strikeX, pl.pos.z - strikeZ) < 2.1 &&
          Math.abs(pl.pos.y - strikeY) < 2.4) {
        pl.damage(4, strikeX, strikeZ, true); // lightning bypasses a raised shield
      }
    }
  } else {
    lightningT -= dt;
    const p = clamp(1 - lightningT / LIGHTNING_AFTER, 0, 1);
    lightningRing.scale.setScalar(1 + p * 1.8);
    lightningRing.material.opacity = (1 - p) * 0.85;
    lightningPillar.scale.set(2.8 * (1 - p), 40, 2.8 * (1 - p));
    lightningPillar.material.opacity = (1 - p) * 0.95;
    lightningGlow.material.opacity = (1 - p) * 0.9;
    lightningGlow.scale.setScalar(6 + p * 5);
    if (lightningT <= 0) {
      lightningState = 0;
      boltTimer = 11 + hash2((G.time * 9) | 0, 733) * 9;
      hideLightningMarker();
    }
  }
  const flash = flashT > 0 ? flashT / FLASH_DUR : 0;
  skyMat.uniforms.uFlash.value = flash * 0.9;
  dirLight.intensity += flash * 2.4; // spike on top of the weather-scaled base
}

export function buildSky() {
  // gradient dome: 3-stop painterly gradient + horizon haze + sun glow + stars
  skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      cTop: { value: new THREE.Color(0x3f8ce0) },
      cMid: { value: new THREE.Color(0x9fd0ec) },
      cBot: { value: new THREE.Color(0xeef7f2) },
      uFogCol: { value: new THREE.Color(0xd7ebf0) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uGlowCol: { value: new THREE.Color(0xfff2dc) },
      uGlow: { value: 0 },
      uStar: { value: 0 },
      uTime: { value: 0 },
      uFlash: { value: 0 },
    },
    vertexShader: `
      varying vec3 vPos;
      void main() {
        vPos = position;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = (projectionMatrix * mv).xyww; // stay at far plane
      }`,
    fragmentShader: `
      uniform vec3 cTop; uniform vec3 cMid; uniform vec3 cBot;
      uniform vec3 uFogCol; uniform vec3 uSunDir; uniform vec3 uGlowCol;
      uniform float uGlow; uniform float uStar; uniform float uTime;
      uniform float uFlash;
      varying vec3 vPos;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      void main() {
        vec3 dir = normalize(vPos);
        float h = dir.y;
        // three-stop gradient: pale horizon, pastel mid band, vivid zenith
        vec3 col = mix(cBot, cMid, smoothstep(-0.02, 0.15, h));
        col = mix(col, cTop, smoothstep(0.15, 0.55, h));
        // layered aerial haze: lift the low sky toward the fog colour
        float haze = 1.0 - smoothstep(0.0, 0.08, h);
        col = mix(col, uFogCol, haze * 0.85);
        // warm glow around the sun: wide at dawn/dusk, subtle at noon
        float sd = max(dot(dir, uSunDir), 0.0);
        float glow = pow(sd, 4.0) * 0.45 + pow(sd, 48.0) * 0.85;
        col += uGlowCol * glow * uGlow;
        if (uStar > 0.01 && h > 0.02) {
          vec2 sp = dir.xz / (0.35 + h) * 90.0;
          vec2 cell = floor(sp);
          float sh = hash(cell);
          float star = step(0.992, sh) * smoothstep(0.4, 0.0, length(fract(sp) - 0.5));
          float tw = 0.6 + 0.4 * sin(uTime * (1.5 + sh * 5.0) + sh * 40.0);
          float bright = 0.45 + 0.55 * fract(sh * 71.7);
          col += star * uStar * tw * bright * vec3(0.9, 0.95, 1.05);
        }
        // lightning: brief whole-dome flash, slightly blue
        col += vec3(0.75, 0.82, 1.0) * uFlash;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(900, 32, 16), skyMat);
  dome.frustumCulled = false;
  G.scene.add(dome);

  // sun & moon discs: near-white sun disc, the post bloom supplies the glare
  // (transparent so heavy weather can fade them behind the cloud deck)
  sun = new THREE.Mesh(new THREE.CircleGeometry(28, 24),
    new THREE.MeshBasicMaterial({ color: 0xfffbef, fog: false, transparent: true }));
  moon = new THREE.Mesh(new THREE.CircleGeometry(16, 24),
    new THREE.MeshBasicMaterial({ color: 0xdfe8ff, fog: false, transparent: true }));
  sunHalo = makeGlow(0xffd9a0, 220);
  sunHalo.material.fog = false;
  G.scene.add(sun, moon, sunHalo);

  // soft ring of light around the moon on clear nights
  moonGlow = makeGlow(0xcfe0ff, 90);
  moonGlow.material.fog = false;
  moon.add(moonGlow);

  // shooting stars: two pooled streaks arcing across the night dome
  for (let i = 0; i < 2; i++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(9, 0.1),
      new THREE.MeshBasicMaterial({
        color: 0xeef4ff, transparent: true, opacity: 0, fog: false,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }));
    m.visible = false;
    G.scene.add(m);
    shootPool.push({ m, t: -1, T: 1, x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 0 });
  }

  // rainbow: five translucent arc bands, conjured when rain clears
  rainbow = new THREE.Group();
  const RB = [0xff6a5a, 0xffb04a, 0xffe95e, 0x7fdc6a, 0x7fa8ff];
  RB.forEach((c, i) => {
    const arc = new THREE.Mesh(
      new THREE.RingGeometry(56 + i * 2.3, 58.1 + i * 2.3, 44, 1, 0, Math.PI),
      new THREE.MeshBasicMaterial({
        color: c, transparent: true, opacity: 0, fog: false,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }));
    rainbow.add(arc);
  });
  rainbow.visible = false;
  G.scene.add(rainbow);

  // crimson aurora curtains, reserved for blood nights
  {
    const cv = document.createElement('canvas');
    cv.width = 64; cv.height = 128;
    const cx = cv.getContext('2d');
    const grad = cx.createLinearGradient(0, 0, 0, 128);
    grad.addColorStop(0, 'rgba(255,60,60,0)');
    grad.addColorStop(0.35, 'rgba(255,70,80,0.55)');
    grad.addColorStop(0.8, 'rgba(180,30,60,0.25)');
    grad.addColorStop(1, 'rgba(120,20,50,0)');
    cx.fillStyle = grad;
    cx.fillRect(0, 0, 64, 128);
    const tex = new THREE.CanvasTexture(cv);
    auroraMat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0, fog: false,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    for (let i = 0; i < 3; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(150, 60), auroraMat);
      m.visible = false;
      G.scene.add(m);
      auroras.push(m);
    }
  }

  // moonglade: a shimmering lane of moonlight across the Mirrormere
  moonGlade = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 52),
    new THREE.MeshBasicMaterial({
      color: 0xbfd4ff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
  moonGlade.rotation.x = -Math.PI / 2;
  moonGlade.position.set(-170, 0.07, 120);
  moonGlade.visible = false;
  G.scene.add(moonGlade);

  // deed-stars: authored directions high in the southern sky, hidden until
  // their deed kindles them (G.deedStars written by remember.js)
  deedGroup = new THREE.Group();
  const dirFor = (u, v) => {
    const az = Math.PI + u * 0.42, el = 0.55 + v * 0.3;
    return new THREE.Vector3(
      Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
  };
  for (let i = 0; i < DEED_POINTS.length; i++) {
    const s = makeGlow(0xffd9a0, 14 + hash2(i, 401) * 8);
    s.material.fog = false;
    s.material.opacity = 0;
    s.position.copy(dirFor(...DEED_POINTS[i])).multiplyScalar(780);
    deedGroup.add(s);
    deedStars.push({ sprite: s, fade: 0 });
  }
  {
    const pos = new Float32Array(DEED_EDGES.length * 6);
    deedLineCol = new Float32Array(DEED_EDGES.length * 6);
    DEED_EDGES.forEach(([a, b], i) => {
      dirFor(...DEED_POINTS[a]).multiplyScalar(776).toArray(pos, i * 6);
      dirFor(...DEED_POINTS[b]).multiplyScalar(776).toArray(pos, i * 6 + 3);
    });
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    lg.setAttribute('color', new THREE.BufferAttribute(deedLineCol, 3));
    deedLines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }));
    deedLines.frustumCulled = false;
    deedGroup.add(deedLines);
  }
  G.scene.add(deedGroup);

  // lights: pale-teal sky bounce over warm moss ground
  hemi = new THREE.HemisphereLight(0xa8d8e8, 0x7a8a58, 0.85);
  ambient = new THREE.AmbientLight(0xdfeef2, 0.14);
  dirLight = new THREE.DirectionalLight(0xfff6e6, 1.35);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(3072, 3072);
  const sc = dirLight.shadow.camera;
  sc.near = 10; sc.far = 400;
  sc.left = sc.bottom = -95; sc.right = sc.top = 95;
  dirLight.shadow.bias = -0.0004;
  dirLight.shadow.normalBias = 0.35;
  G.scene.add(hemi, ambient, dirLight, dirLight.target);

  // aerial perspective: haze starts well back so the mid-ground keeps its
  // color and distant ridges fade blue instead of whiting out
  G.scene.fog = new THREE.Fog(0xc4def2, 150, 950);

  buildClouds();
  buildRain();
  buildStreaks();
  buildLightningMarker();
}

function buildClouds() {
  // big cumulus: flat clamped bottoms, puffy crowns, two drifting altitude
  // layers. Unlit, with the shading baked into vertex colors — bright white
  // sunlit crowns falling to a cool blue-grey underside — then tinted per
  // frame with the day cycle so they glow warm at dawn and go slate at night.
  cloudMat = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.96, fog: false,
  });
  // wispy cirrus far above the cumulus deck — thin stretched sheets that
  // drift very slowly and take the same day-cycle tint
  cirrusMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.10,
    depthWrite: false, fog: false, side: THREE.DoubleSide,
  });
  for (let i = 0; i < 8; i++) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(220 + hash2(i, 401) * 260, 30 + hash2(i, 403) * 30),
      cirrusMat);
    // a slight random tilt so the sheets never collapse into hard edge-on
    // lines when seen from the valley floor
    m.rotation.x = -Math.PI / 2 + (hash2(i, 405) - 0.5) * 0.2;
    m.rotation.z = hash2(i, 407) * Math.PI;
    m.position.set((hash2(i, 409) - 0.5) * 1500, 360 + hash2(i, 411) * 70,
      (hash2(i, 413) - 0.5) * 1500);
    G.scene.add(m);
    cirrus.push(m);
  }
  const mat = cloudMat;
  const puffGeo = new THREE.SphereGeometry(1, 10, 8);
  {
    const pos = puffGeo.attributes.position;
    const cols = new Float32Array(pos.count * 3);
    const bot = new THREE.Color(0x9db0d0);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      c.copy(bot).lerp(_warm.setRGB(1, 1, 1), smoothstep(-0.55, 0.8, pos.getY(i)));
      cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b;
    }
    puffGeo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  }
  for (let i = 0; i < 30; i++) {
    const g = new THREE.Group();
    const big = 1.2 + hash2(i, 11) * 0.9;
    const n = 4 + ((hash2(i, 7) * 4) | 0);
    let width = 0;
    for (let j = 0; j < n; j++) {
      // base row: puff bottoms clamped to the y=0 plane for a flat cloud floor
      const s = (17 + hash2(i, j) * 24) * big;
      const sy = 0.42 + hash2(i, j, 9) * 0.16;
      const puff = new THREE.Mesh(puffGeo, mat);
      puff.scale.set(s, s * sy, s * (0.8 + hash2(i, j, 21) * 0.3));
      const x = (j - (n - 1) / 2) * s * 0.82;
      puff.position.set(x, s * sy + hash2(i, j, 3) * 3, (hash2(i, j, 5) - 0.5) * s * 0.7);
      g.add(puff);
      width = Math.max(width, Math.abs(x) + s);
    }
    // crown puffs stacked on top for the cauliflower silhouette
    const m = 2 + ((hash2(i, 13) * 3) | 0);
    for (let j = 0; j < m; j++) {
      const s = (11 + hash2(i, j, 17) * 16) * big;
      const puff = new THREE.Mesh(puffGeo, mat);
      puff.scale.set(s, s * 0.62, s * 0.9);
      puff.position.set(
        (hash2(i, j, 19) - 0.5) * width * 0.8,
        s * 0.62 + (9 + hash2(i, j, 23) * 10) * big,
        (hash2(i, j, 25) - 0.5) * width * 0.3);
      g.add(puff);
    }
    const high = (i & 1) === 1; // two altitude layers
    g.position.set(
      (hash2(i, 1) - 0.5) * 1700,
      high ? 245 + hash2(i, 2) * 60 : 150 + hash2(i, 2) * 45,
      (hash2(i, 3) - 0.5) * 1700);
    g.userData.speed = (high ? 1.8 : 1.1) + hash2(i, 4) * 1.4;
    g.userData.baseY = g.position.y; // weather lowers the deck from here
    clouds.push(g);
    G.scene.add(g);
  }
}

// ---- rain -----------------------------------------------------------------------
// One InstancedMesh of thin vertical streak quads recycled inside a cylinder
// around the camera. count follows wetness, so rain fades in/out with the
// weather crossfade; count = 0 when dry.
const RAIN_N = 600;
const RAIN_R = 26; // cylinder radius around the camera
const RAIN_H = 24; // cylinder height
let rainMesh = null;
let rainOn = false;
const rainData = new Float32Array(RAIN_N * 5); // x, y, z, fallSpeed, length

function buildRain() {
  const geo = new THREE.PlaneGeometry(0.035, 1);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xbdd2e4, transparent: true, opacity: 0.3,
    depthWrite: false, side: THREE.DoubleSide,
  });
  rainMesh = new THREE.InstancedMesh(geo, mat, RAIN_N);
  rainMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  rainMesh.frustumCulled = false;
  rainMesh.count = 0;
  rainMesh.visible = false;
  for (let i = 0; i < RAIN_N; i++) {
    const o = i * 5;
    rainData[o + 3] = 19 + Math.random() * 9;      // fall speed
    rainData[o + 4] = 0.7 + Math.random() * 0.8;   // streak length
  }
  G.scene.add(rainMesh);
}

function seedRain(pc) {
  for (let i = 0; i < RAIN_N; i++) {
    const o = i * 5;
    rainData[o] = pc.x + (Math.random() - 0.5) * 2 * RAIN_R;
    rainData[o + 1] = pc.y - RAIN_H * 0.5 + Math.random() * RAIN_H;
    rainData[o + 2] = pc.z + (Math.random() - 0.5) * 2 * RAIN_R;
  }
}

function updateRain(dt, pc) {
  const amt = clamp((wCur.wetness - 0.25) / 0.75, 0, 1); // rain ~0.67, storm 1
  const n = (RAIN_N * amt) | 0;
  rainMesh.count = n;
  rainMesh.visible = n > 0;
  if (n === 0) { rainOn = false; return; }
  if (!rainOn) { rainOn = true; seedRain(pc); }
  rainMesh.material.opacity = 0.12 + amt * 0.22;

  // shared orientation: face the camera about Y, lean with the wind
  G.camera.getWorldDirection(_fwd);
  _q.setFromEuler(_e.set(0, Math.atan2(_fwd.x, _fwd.z), -0.055 * wCur.windMul));
  const drift = 2.5 * wCur.windMul;
  const fall = 1 + wCur.wetness * 0.3;
  for (let i = 0; i < n; i++) {
    const o = i * 5;
    rainData[o + 1] -= rainData[o + 3] * fall * dt;
    rainData[o] += drift * dt;
    if (rainData[o + 1] < pc.y - RAIN_H * 0.5 ||
        Math.abs(rainData[o] - pc.x) > RAIN_R * 1.3 ||
        Math.abs(rainData[o + 2] - pc.z) > RAIN_R * 1.3) {
      rainData[o] = pc.x + (Math.random() - 0.5) * 2 * RAIN_R;
      rainData[o + 1] = pc.y + RAIN_H * (0.25 + Math.random() * 0.35);
      rainData[o + 2] = pc.z + (Math.random() - 0.5) * 2 * RAIN_R;
    }
    _pos.set(rainData[o], rainData[o + 1], rainData[o + 2]);
    _scl.set(1, rainData[o + 4], 1);
    rainMesh.setMatrixAt(i, _m4.compose(_pos, _q, _scl));
  }
  rainMesh.instanceMatrix.needsUpdate = true;
}

// ---- wind streaks -----------------------------------------------------------------
// TotK-signature white wind lines, one pooled InstancedMesh:
//   slots [0, STREAK_UP)      rise inside G.updraftZones near the camera
//   slots [STREAK_UP, STREAK_N) ambient horizontal drift when windMul >= 1.5
const STREAK_N = 40;
const STREAK_UP = 24;
const STREAK_STRIDE = 8; // mode, x, y, z, heading/phase, life, maxLife, speed
let streakMesh = null;
const streakData = new Float32Array(STREAK_N * STREAK_STRIDE);

function buildStreaks() {
  // slightly arced thin quad — the signature curved wind line
  const geo = new THREE.PlaneGeometry(1, 0.05, 8, 1);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    pos.setY(i, pos.getY(i) + (0.25 - x * x) * 0.14);
  }
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.42,
    depthWrite: false, side: THREE.DoubleSide,
  });
  streakMesh = new THREE.InstancedMesh(geo, mat, STREAK_N);
  streakMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  streakMesh.frustumCulled = false;
  _m4.makeScale(0, 0, 0);
  for (let i = 0; i < STREAK_N; i++) streakMesh.setMatrixAt(i, _m4);
  G.scene.add(streakMesh);
}

function spawnAmbientStreak(o, pc) {
  const d = streakData;
  const a = Math.random() * Math.PI * 2;
  const r = 6 + Math.random() * 20;
  const cue = Math.max(G.weather.gustTelegraph || 0, G.weather.gustPulse || 0);
  d[o] = 0;
  d[o + 1] = pc.x + Math.cos(a) * r;
  d[o + 2] = pc.y + (Math.random() - 0.3) * 8;
  d[o + 3] = pc.z + Math.sin(a) * r;
  d[o + 4] = cue > 0.01
    ? Math.atan2(G.weather.gustDz || 0, G.weather.gustDx || 1) + (Math.random() - 0.5) * 0.18
    : (Math.random() - 0.5) * 0.6; // ordinary weather: mostly downwind (+x)
  d[o + 6] = 1.2 + Math.random() * 1.4;
  d[o + 5] = d[o + 6];
  d[o + 7] = 6 + Math.random() * 3; // scaled by live windMul during update
}

function spawnUpdraftStreak(o, z) {
  const d = streakData;
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * (z.r || 5) * 0.8;
  const bottom = z.bottomY || 0;
  const span = Math.max(1, (z.topY || 0) - bottom);
  d[o] = 1;
  d[o + 1] = z.x + Math.cos(a) * r;
  d[o + 2] = bottom + Math.random() * span * 0.35;
  d[o + 3] = z.z + Math.sin(a) * r;
  d[o + 4] = Math.random() * Math.PI * 2; // spiral phase
  d[o + 7] = Math.max(6, (z.strength || 14) * 0.8);
  d[o + 6] = Math.max(0.5, Math.min(2.6, (bottom + span - d[o + 2]) / d[o + 7]));
  d[o + 5] = d[o + 6];
}

function updateStreaks(dt, pc) {
  const d = streakData;
  const ambientOn = wCur.windMul >= 1.5;
  const stormCue = Math.max(G.weather.gustTelegraph || 0, G.weather.gustPulse || 0);
  streakMesh.material.opacity = 0.42 + stormCue * 0.34;

  // reservoir-pick one eligible updraft zone within 120m (skip expired ones)
  let zone = null, zn = 0;
  const zones = G.updraftZones;
  for (let i = 0; i < zones.length; i++) {
    const z = zones[i];
    if (z.expires !== undefined && z.expires < G.time) continue;
    const dx = z.x - pc.x, dz = z.z - pc.z;
    if (dx * dx + dz * dz > 14400) continue;
    zn++;
    if (Math.random() * zn < 1) zone = z;
  }

  let spawnUp = 2, spawnAmb = stormCue > 0.01 ? 6 : 2; // warned gust rapidly fills aligned slots
  let anyActive = false;
  for (let i = 0; i < STREAK_N; i++) {
    const o = i * STREAK_STRIDE;
    if (d[o + 5] <= 0) {
      if (i < STREAK_UP) {
        if (zone && spawnUp > 0) { spawnUpdraftStreak(o, zone); spawnUp--; }
      } else if (ambientOn && spawnAmb > 0) { spawnAmbientStreak(o, pc); spawnAmb--; }
    }
    if (d[o + 5] > 0) {
      d[o + 5] -= dt;
      if (d[o] === 0) { // ambient: drift downwind
        const sp = d[o + 7] * wCur.windMul * (1 + stormCue * 1.2);
        d[o + 1] += Math.cos(d[o + 4]) * sp * dt;
        d[o + 3] += Math.sin(d[o + 4]) * sp * dt;
        _fwd.set(Math.cos(d[o + 4]), 0, Math.sin(d[o + 4]));
      } else {          // updraft: rise with a light spiral
        d[o + 2] += d[o + 7] * dt;
        d[o + 1] += Math.sin(G.time * 2.2 + d[o + 4]) * 0.6 * dt;
        d[o + 3] += Math.cos(G.time * 2.0 + d[o + 4]) * 0.6 * dt;
        _fwd.set(0, 1, 0);
      }
      // orient: length axis along motion, face turned toward the camera
      _pos.set(d[o + 1], d[o + 2], d[o + 3]);
      _toCam.copy(pc).sub(_pos);
      _side.crossVectors(_fwd, _toCam);
      if (_side.lengthSq() < 1e-4) _side.set(0, 0, 1);
      _side.normalize();
      _nrm.crossVectors(_side, _fwd);
      const env = Math.sin(Math.PI * clamp(d[o + 5] / d[o + 6], 0, 1));
      const len = (d[o] === 0 ? 2.4 + d[o + 7] * 0.14 : 3.2) * (0.5 + 0.5 * env);
      _fwd.multiplyScalar(len);
      _side.multiplyScalar(env);
      streakMesh.setMatrixAt(i, _m4.makeBasis(_fwd, _side, _nrm).setPosition(_pos));
      anyActive = true;
    } else {
      streakMesh.setMatrixAt(i, _m4.makeScale(0, 0, 0));
    }
  }
  streakMesh.visible = anyActive;
  if (anyActive) streakMesh.instanceMatrix.needsUpdate = true;
}

export function updateSky(dt) {
  const prev = G.dayTime;
  G.dayTime = (G.dayTime + dt / DAY_LENGTH) % 1;
  if (G.dayTime < prev) G.dayCount = (G.dayCount || 0) + 1; // midnight passed
  const t = G.dayTime;

  updateWeather(dt);
  updateStormGust(dt);
  const grim = wCur.grim;

  // sun position: t=0.5 noon overhead; orbit in a tilted plane
  const ang = (t - 0.25) * Math.PI * 2; // t=.25 sunrise at horizon
  _sunDir.set(Math.cos(ang), Math.sin(ang), 0.35).normalize();
  const pc = G.camera ? G.camera.position : _origin;

  sun.position.copy(pc).addScaledVector(_sunDir, 800);
  sun.lookAt(pc);
  moon.position.copy(pc).addScaledVector(_sunDir, -800);
  moon.lookAt(pc);

  const dayUp = clamp(_sunDir.y * 3 + 0.1, 0, 1);
  dirLight.position.copy(pc).addScaledVector(
    _sunDir.y > -0.1 ? _sunDir : _negDir.copy(_sunDir).negate(), 160);
  dirLight.target.position.copy(pc);
  dirLight.color.copy(sample(PALETTE.sunCol, t));
  dirLight.intensity = sample(PALETTE.sunInt, t) * wCur.light;
  hemi.intensity = sample(PALETTE.hemiInt, t) * wCur.light;

  greyLerp(skyMat.uniforms.cTop.value.copy(sample(PALETTE.top, t)), grim);
  greyLerp(skyMat.uniforms.cMid.value.copy(sample(PALETTE.mid, t)), grim);
  greyLerp(skyMat.uniforms.cBot.value.copy(sample(PALETTE.bottom, t)), grim);
  const night = 1 - clamp(_sunDir.y * 4 + 0.4, 0, 1);
  skyMat.uniforms.uStar.value = night * (1 - wCur.cloud * 0.85); // clouds hide stars
  skyMat.uniforms.uTime.value = (skyMat.uniforms.uTime.value + dt) % 1000;
  skyMat.uniforms.uSunDir.value.copy(_sunDir);
  // shared with post.js (god rays aim at the sun's screen position)
  if (!G.sunDir) G.sunDir = new THREE.Vector3();
  G.sunDir.copy(_sunDir);
  sun.material.opacity = 1 - grim * 0.9; // heavy weather swallows the disc
  sun.visible = _sunDir.y > -0.12;
  moon.material.opacity = 1 - grim * 0.85;
  moon.visible = _sunDir.y < 0.12;

  // warm halo + dome glow around a low sun at dawn and dusk (dimmed by weather)
  const lowSun = clamp(1 - Math.abs(_sunDir.y) * 3.2, 0, 1) * (_sunDir.y > -0.15 ? 1 : 0);
  sunHalo.position.copy(sun.position);
  sunHalo.material.opacity = (0.15 + lowSun * 0.5) * (1 - grim * 0.9);
  sunHalo.material.color.setHSL(0.075 - lowSun * 0.03, 0.9, 0.62);
  const dayGlow = clamp(_sunDir.y * 5 + 0.5, 0, 1); // fade dome glow once the sun sinks
  skyMat.uniforms.uGlow.value = dayGlow * (0.3 + lowSun * 0.7) * (1 - grim * 0.85);
  skyMat.uniforms.uGlowCol.value.copy(GLOW_HI).lerp(GLOW_LOW, lowSun);

  greyLerp(G.scene.fog.color.copy(sample(PALETTE.fog, t)), grim);

  // haze thins as the camera climbs, so the valley stays visible from the sky;
  // rain pulls the fog planes back in
  const alt = Math.max(0, pc.y - 20);
  G.scene.fog.near = (150 + alt * 2.6) * wCur.fogNear;
  G.scene.fog.far = (950 + alt * 2.2) * wCur.fogFar;

  // the crimson moon: every third night the sky bleeds
  if (G.bloodNight) {
    const k = night * 0.75;
    skyMat.uniforms.cTop.value.lerp(RED_TOP, k);
    skyMat.uniforms.cMid.value.lerp(RED_MID, k);
    skyMat.uniforms.cBot.value.lerp(RED_BOT, k);
    G.scene.fog.color.lerp(RED_FOG, k);
    moon.material.color.setHex(0xe8402e);
    hemi.color.setHex(0xc06a6a);
  } else {
    moon.material.color.setHex(0xdfe8ff);
    hemi.color.setHex(0xa8d8e8);
  }
  // the dome's horizon haze band always tracks the scene fog (blood moon included)
  skyMat.uniforms.uFogCol.value.copy(G.scene.fog.color);

  // lightning after the weather-scaled dirLight base is set (it adds a spike)
  updateLightning(dt);

  // clouds: drift with the wind, swell/lower/grey over as weather closes in
  const cov = wCur.cloud;
  for (const c of clouds) {
    c.position.x += c.userData.speed * wCur.windMul * dt;
    if (c.position.x > 900) c.position.x = -900;
    c.scale.setScalar(1 + cov * 0.45);
    c.position.y = c.userData.baseY - cov * 36;
  }
  // unlit cloud tint follows the cycle: white day, peach dawn/dusk, slate night
  _cloudTint.setRGB(1, 1, 1).lerp(CLOUD_NIGHT, night);
  _cloudTint.lerp(_warm.setRGB(1.0, 0.72, 0.55), lowSun * 0.85 * (1 - night));
  greyLerp(_cloudTint, grim * 0.7);
  cloudMat.color.copy(_cloudTint);
  // cirrus sheets creep east and fade at night / in grim weather
  if (cirrusMat) {
    cirrusMat.color.copy(_cloudTint);
    cirrusMat.opacity = 0.15 * (1 - night * 0.55) * (1 - grim * 0.8);
    for (let i = 0; i < cirrus.length; i++) {
      const c = cirrus[i];
      c.position.x += dt * (1.1 + (i % 3) * 0.4);
      if (c.position.x > 850) c.position.x = -850;
    }
  }

  // ---- phase-4 sky life ----------------------------------------------------
  // moon halo breathes on clear nights
  if (moonGlow) {
    moonGlow.material.opacity = 0.24 * night * (1 - grim * 0.85) *
      (0.9 + Math.sin(G.time * 0.7) * 0.1);
  }
  // deed-stars: kindled deeds fade in over ~3s and twinkle with the sky
  if (deedGroup) {
    deedGroup.position.copy(pc);
    const starVis = night * (1 - wCur.cloud * 0.85) * (G.bloodNight ? 0.5 : 1);
    deedGroup.visible = starVis > 0.02;
    if (deedGroup.visible) {
      let fading = false;
      for (let i = 0; i < deedStars.length; i++) {
        const s = deedStars[i];
        if (G.deedStars && G.deedStars[i] && s.fade < 1) {
          s.fade = Math.min(1, s.fade + dt / 3);
          fading = true;
        }
        s.sprite.material.opacity = starVis * s.fade *
          (0.7 + 0.2 * Math.sin(G.time * 1.3 + i * 2.3));
      }
      // constellation lines emerge between pairs of kindled stars; the color
      // buffer only changes during a ~3s kindle fade, so upload only then
      if (fading) {
        deedLineMax = 0;
        for (let i = 0; i < DEED_EDGES.length; i++) {
          const k = Math.min(deedStars[DEED_EDGES[i][0]].fade, deedStars[DEED_EDGES[i][1]].fade);
          if (k > deedLineMax) deedLineMax = k;
          for (let j = 0; j < 6; j++) deedLineCol[i * 6 + j] = k;
        }
        deedLines.geometry.attributes.color.needsUpdate = true;
      }
      deedLines.material.opacity = 0.14 * starVis;
      deedLines.visible = deedLineMax > 0;
    }
  }
  // shooting stars on deep clear nights
  if (night > 0.85 && grim < 0.3 && G.time > shootNextAt) {
    shootNextAt = G.time + 13 + hash2((G.time * 5) | 0, 91) * 25;
    for (const s of shootPool) {
      if (s.t >= 0) continue;
      const a = hash2((G.time * 9) | 0, 93) * Math.PI * 2;
      s.x = pc.x + Math.cos(a) * 260;
      s.y = 250 + hash2((G.time * 11) | 0, 97) * 130;
      s.z = pc.z + Math.sin(a) * 260;
      s.dx = -Math.cos(a + 0.7) * 150; s.dy = -60; s.dz = -Math.sin(a + 0.7) * 150;
      s.t = 0; s.T = 1.1;
      s.m.visible = true;
      // now and then one does not burn out — fallenstar.js takes it from here
      if (hash2((G.time * 13) | 0, 101) < 0.16) G.pendingStarfall = true;
      break;
    }
  }
  for (const s of shootPool) {
    if (s.t < 0) continue;
    s.t += dt;
    const k = s.t / s.T;
    if (k >= 1 || night < 0.5) { s.t = -1; s.m.visible = false; continue; }
    s.x += s.dx * dt; s.y += s.dy * dt; s.z += s.dz * dt;
    s.m.position.set(s.x, s.y, s.z);
    _svec.set(s.dx, s.dy, s.dz).normalize();
    s.m.quaternion.setFromUnitVectors(_X_AXIS, _svec);
    s.m.material.opacity = Math.sin(k * Math.PI) * 0.9 * night;
  }
  // rainbow: rain clearing under a risen sun conjures the bow opposite it
  const wetNow = wCur.wetness;
  if (prevWet > 0.4 && wetNow <= 0.4 && _sunDir.y > 0.15) rainbowW = 26;
  prevWet = wetNow;
  if (rainbowW > 0 && rainbow) {
    rainbowW -= dt;
    const env = Math.max(0, Math.min(1, Math.min(rainbowW / 6, (26 - rainbowW) / 3)));
    rainbow.visible = env > 0.01;
    const ax = -_sunDir.x, az = -_sunDir.z;
    const al = Math.hypot(ax, az) || 1;
    rainbow.position.set(pc.x + (ax / al) * 250, -8, pc.z + (az / al) * 250);
    rainbow.rotation.y = Math.atan2(pc.x - rainbow.position.x, pc.z - rainbow.position.z);
    for (let i = 0; i < rainbow.children.length; i++) {
      rainbow.children[i].material.opacity = 0.11 * env;
    }
  } else if (rainbow) rainbow.visible = false;
  // crimson aurora curtains sway over blood nights
  auroraW += (((G.bloodNight && night > 0.6) ? 1 : 0) - auroraW) * Math.min(1, dt * 0.4);
  if (auroraMat) {
    auroraMat.opacity = 0.34 * auroraW;
    for (let i = 0; i < auroras.length; i++) {
      const m = auroras[i];
      m.visible = auroraW > 0.02;
      if (!m.visible) continue;
      const a = i * 2.1 + 0.8 + Math.sin(G.time * 0.05 + i) * 0.15;
      m.position.set(pc.x + Math.cos(a) * 420, 225 + Math.sin(G.time * 0.21 + i * 2) * 12,
        pc.z + Math.sin(a) * 420);
      m.lookAt(pc.x, 160, pc.z);
      m.rotation.z = Math.sin(G.time * 0.13 + i * 1.7) * 0.14;
      m.scale.x = 1 + Math.sin(G.time * 0.17 + i) * 0.18;
    }
  }
  // moonglade shimmers on the Mirrormere under a visible moon
  if (moonGlade) {
    const gladeK = night * (1 - grim) * (moon.visible ? 1 : 0) * (G.bloodNight ? 0.4 : 1);
    moonGlade.visible = gladeK > 0.03;
    if (moonGlade.visible) {
      moonGlade.rotation.z = Math.atan2(-_sunDir.x, -_sunDir.z);
      moonGlade.material.opacity = 0.16 * gladeK * (0.85 + Math.sin(G.time * 1.9) * 0.15);
      moonGlade.material.color.setHex(G.bloodNight ? 0xff8a7a : 0xbfd4ff);
    }
  }

  if (G.camera && rainMesh) {
    updateRain(dt, pc);
    updateStreaks(dt, pc);
  }
  return dayUp;
}

export function isNight() {
  return G.dayTime < 0.21 || G.dayTime > 0.79;
}
