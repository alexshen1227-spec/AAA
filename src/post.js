// Post-processing: hand-rolled TotK-style pipeline (no three/addons).
// Scene renders into an MSAA HalfFloat target, then:
//   - bright pass (soft-knee threshold 0.8) blurred at 1/2 and 1/4 res  -> main bloom
//   - bright pass (low threshold 0.3) blurred down to 1/8 res           -> faint wide diffusion glow
//   - composite to canvas: scene + bloom + diffusion, exposure + ACES filmic
//     tone mapping (moved here from the renderer), painterly grade (saturation,
//     teal shadows / warm highlights, lifted blacks, vignette), a weather grade
//     driven by G.weather.wetness (desaturate, cool tint, deeper vignette in
//     rain), manual linear->sRGB.
//
// Tone mapping ownership: in three r160, renderer tone mapping and output color
// space encoding only apply when drawing to the default framebuffer, so the scene
// pass into the render target stays linear (materials that manually include
// <tonemapping_fragment>/<colorspace_fragment>, e.g. the sky, compile to no-ops
// there). main.js sets renderer.toneMapping = NoToneMapping while this pipeline
// is active; the composite material is toneMapped = false and never includes
// <colorspace_fragment>, so nothing gets double-mapped or double-encoded.
import * as THREE from 'three';
import { G } from './state.js';

// ---- tuning ---------------------------------------------------------------

const BLOOM_THRESHOLD = 0.8;   // linear space
const BLOOM_KNEE = 0.4;
const BLOOM_STRENGTH = 0.45;
const DIFF_THRESHOLD = 0.3;    // low-threshold "diffusion" glow
const DIFF_KNEE = 0.3;
const DIFF_STRENGTH = 0.12;
const RAY_THRESHOLD = 0.88;    // god-ray source: sun disc + sky glow around it
const RAY_KNEE = 0.25;
const EXPOSURE = 1.12;
const SATURATION = 1.09;
const VIGNETTE = 0.18;

// ---- shaders ----------------------------------------------------------------

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4( position.xy, 0.0, 1.0 );
  }
`;

// Soft-knee bright pass (Unity/Kino-style quadratic threshold).
const BRIGHT_FRAG = /* glsl */`
  uniform sampler2D tSrc;
  uniform float uThreshold;
  uniform float uKnee;
  varying vec2 vUv;
  void main() {
    vec3 c = max( texture2D( tSrc, vUv ).rgb, vec3( 0.0 ) );
    float br = max( c.r, max( c.g, c.b ) );
    float soft = clamp( br - uThreshold + uKnee, 0.0, 2.0 * uKnee );
    soft = soft * soft / ( 4.0 * uKnee + 1e-4 );
    float w = max( soft, br - uThreshold ) / max( br, 1e-4 );
    gl_FragColor = vec4( c * max( w, 0.0 ), 1.0 );
  }
`;

// Separable Gaussian, 5 fetches using linear-sampling offsets (9-tap equivalent).
const BLUR_FRAG = /* glsl */`
  uniform sampler2D tSrc;
  uniform vec2 uDir; // texel size * axis
  varying vec2 vUv;
  void main() {
    vec2 o1 = uDir * 1.3846153846;
    vec2 o2 = uDir * 3.2307692308;
    vec3 sum = texture2D( tSrc, vUv ).rgb * 0.2270270270;
    sum += texture2D( tSrc, vUv + o1 ).rgb * 0.3162162162;
    sum += texture2D( tSrc, vUv - o1 ).rgb * 0.3162162162;
    sum += texture2D( tSrc, vUv + o2 ).rgb * 0.0702702703;
    sum += texture2D( tSrc, vUv - o2 ).rgb * 0.0702702703;
    gl_FragColor = vec4( sum, 1.0 );
  }
`;

// Radial "god ray" blur: 12 taps marching toward the sun's screen position,
// weight decaying per tap. Two iterations give ~144 effective taps.
const RAY_FRAG = /* glsl */`
  uniform sampler2D tSrc;
  uniform vec2 uCenter;
  uniform float uStride;
  varying vec2 vUv;
  void main() {
    vec2 dir = uCenter - vUv;
    float dist = length( dir );
    dir /= max( dist, 1e-4 );
    vec2 stepv = dir * min( dist, 0.4 ) * uStride / 12.0;
    vec3 sum = vec3( 0.0 );
    float w = 1.0, tw = 0.0;
    vec2 uv = vUv;
    for ( int i = 0; i < 12; i++ ) {
      sum += texture2D( tSrc, uv ).rgb * w;
      tw += w; w *= 0.88;
      uv += stepv;
    }
    gl_FragColor = vec4( sum / tw, 1.0 );
  }
`;

const COMPOSITE_FRAG = /* glsl */`
  uniform sampler2D tScene;
  uniform sampler2D tBloomHalf;
  uniform sampler2D tBloomQuarter;
  uniform sampler2D tDiffusion;
  uniform sampler2D tRays;
  uniform float uRay;
  uniform float uBloomStrength;
  uniform float uDiffStrength;
  uniform float uExposure;
  uniform float uSaturation;
  uniform float uVignette;
  uniform float uWetness;
  uniform float uHurtDir;  // screen-relative bearing of the last hit (0 = ahead/top)
  uniform float uHurtAmt;  // 0..1, decayed by main.js
  varying vec2 vUv;

  // ACES filmic fit — identical math to three.js ACESFilmicToneMapping
  // (Stephen Hill's RRT+ODT fit), so the look matches the previous
  // renderer.toneMapping = ACESFilmicToneMapping @ exposure 1.12.
  vec3 RRTAndODTFit( vec3 v ) {
    vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
    vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
    return a / b;
  }
  vec3 acesFilmic( vec3 color ) {
    const mat3 ACESInputMat = mat3(
      vec3( 0.59719, 0.07600, 0.02840 ),
      vec3( 0.35458, 0.90834, 0.13383 ),
      vec3( 0.04823, 0.01566, 0.83777 )
    );
    const mat3 ACESOutputMat = mat3(
      vec3(  1.60475, -0.10208, -0.00327 ),
      vec3( -0.53108,  1.10813, -0.07276 ),
      vec3( -0.07367, -0.00605,  1.07602 )
    );
    color *= uExposure / 0.6;
    color = ACESInputMat * color;
    color = RRTAndODTFit( color );
    color = ACESOutputMat * color;
    return clamp( color, 0.0, 1.0 );
  }

  vec3 linearToSRGB( vec3 c ) {
    c = max( c, vec3( 0.0 ) );
    return mix( c * 12.92,
                pow( c, vec3( 1.0 / 2.4 ) ) * 1.055 - 0.055,
                step( vec3( 0.0031308 ), c ) );
  }

  void main() {
    vec3 col = texture2D( tScene, vUv ).rgb;

    // bloom: blend the tight 1/2-res and wide 1/4-res blurs
    vec3 bloom = texture2D( tBloomHalf, vUv ).rgb * 0.6
               + texture2D( tBloomQuarter, vUv ).rgb * 0.4;
    col += bloom * uBloomStrength;

    // faint very-wide diffusion — the painterly all-over luminosity
    col += texture2D( tDiffusion, vUv ).rgb * uDiffStrength;

    // warm god rays streaming from the sun
    col += texture2D( tRays, vUv ).rgb * uRay * vec3( 1.0, 0.88, 0.72 );

    // exposure + ACES filmic (moved here from the renderer)
    col = acesFilmic( col );

    // grade: saturation, teal shadows, warm highlights
    float luma = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
    col = mix( vec3( luma ), col, uSaturation );
    col += vec3( -0.012, 0.010, 0.024 ) * ( 1.0 - smoothstep( 0.0, 0.5, luma ) );
    col += vec3(  0.020, 0.010, -0.012 ) * smoothstep( 0.55, 1.0, luma );

    // weather grade: as the world gets wet, desaturate ~10% and cool the tint
    float wetLuma = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
    col = mix( col, vec3( wetLuma ), 0.10 * uWetness );
    col *= mix( vec3( 1.0 ), vec3( 0.95, 0.99, 1.05 ), uWetness );

    // lifted blacks
    col = col * 0.97 + vec3( 0.012, 0.016, 0.018 );

    // gentle vignette, deepened slightly by rain
    float d = length( vUv - 0.5 );
    col *= 1.0 - uVignette * ( 1.0 + 0.4 * uWetness ) * smoothstep( 0.28, 0.78, d );

    // directional hurt: a red bloom seeps in from the screen edge the hit
    // came from (world +X shows on screen LEFT for this chase cam, hence -sin)
    if ( uHurtAmt > 0.001 ) {
      vec2 hd = vec2( -sin( uHurtDir ), cos( uHurtDir ) );
      vec2 sv = vUv - 0.5;
      float align = pow( max( dot( sv / max( d, 0.001 ), hd ), 0.0 ), 1.6 );
      col = mix( col, vec3( 0.42, 0.025, 0.02 ),
                 uHurtAmt * align * smoothstep( 0.18, 0.6, d ) * 0.85 );
    }

    vec3 srgb = linearToSRGB( col );

    // tiny ordered-ish dither to keep pastel sky gradients from banding
    float n = fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
    srgb += ( n - 0.5 ) / 255.0;

    gl_FragColor = vec4( srgb, 1.0 );
  }
`;

// ---- pipeline ---------------------------------------------------------------

// Creates the post pipeline. Returns null (never throws) if WebGL2 / float
// render targets are unavailable or anything fails, so the caller can fall
// back to plain renderer.render with the classic ACES renderer settings.
export function initPost(renderer) {
  try {
    if (!renderer.capabilities.isWebGL2) return null;
    // HalfFloat color attachments require this extension even on WebGL2.
    if (!renderer.extensions.has('EXT_color_buffer_float')) return null;

    const rtOpts = { type: THREE.HalfFloatType, depthBuffer: false };
    // Scene target: MSAA so we keep antialiasing (the canvas's own
    // antialias:true no longer applies once we render into a target).
    const rtScene = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, samples: 4, depthBuffer: true,
    });
    const rtHalfA = new THREE.WebGLRenderTarget(1, 1, rtOpts);
    const rtHalfB = new THREE.WebGLRenderTarget(1, 1, rtOpts);
    const rtQuartA = new THREE.WebGLRenderTarget(1, 1, rtOpts);
    const rtQuartB = new THREE.WebGLRenderTarget(1, 1, rtOpts);
    const rtEighthA = new THREE.WebGLRenderTarget(1, 1, rtOpts);
    const rtEighthB = new THREE.WebGLRenderTarget(1, 1, rtOpts);
    const rtRayA = new THREE.WebGLRenderTarget(1, 1, rtOpts);
    const rtRayB = new THREE.WebGLRenderTarget(1, 1, rtOpts);

    // blur directions (texel * axis), mutated in setSize — no per-frame allocs
    const dHalfH = new THREE.Vector2(); const dHalfV = new THREE.Vector2();
    const dQuartH = new THREE.Vector2(); const dQuartV = new THREE.Vector2();
    const dEighthH = new THREE.Vector2(); const dEighthV = new THREE.Vector2();
    const bufSize = new THREE.Vector2();

    // fullscreen single-triangle pass machinery
    const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const fsScene = new THREE.Scene();
    const fsGeo = new THREE.BufferGeometry();
    fsGeo.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const fsMesh = new THREE.Mesh(fsGeo, null);
    fsMesh.frustumCulled = false;
    fsScene.add(fsMesh);

    const brightMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: BRIGHT_FRAG,
      uniforms: {
        tSrc: { value: null },
        uThreshold: { value: BLOOM_THRESHOLD },
        uKnee: { value: BLOOM_KNEE },
      },
      depthTest: false, depthWrite: false, toneMapped: false,
    });
    const blurMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: BLUR_FRAG,
      uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } },
      depthTest: false, depthWrite: false, toneMapped: false,
    });
    const rayMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: RAY_FRAG,
      uniforms: {
        tSrc: { value: null },
        uCenter: { value: new THREE.Vector2(0.5, 0.5) },
        uStride: { value: 1 },
      },
      depthTest: false, depthWrite: false, toneMapped: false,
    });
    // god-ray bookkeeping (module temps so render() stays allocation-free)
    const _sunPos = new THREE.Vector3();
    const _sunNdc = new THREE.Vector3();
    const _camDir = new THREE.Vector3();
    const clamp01 = (v) => Math.min(1, Math.max(0, v));
    const compMat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: COMPOSITE_FRAG,
      uniforms: {
        tScene: { value: rtScene.texture },
        tBloomHalf: { value: rtHalfA.texture },
        tBloomQuarter: { value: rtQuartB.texture },
        tDiffusion: { value: rtEighthB.texture },
        tRays: { value: rtRayA.texture },
        uRay: { value: 0 },
        uBloomStrength: { value: BLOOM_STRENGTH },
        uDiffStrength: { value: DIFF_STRENGTH },
        uExposure: { value: EXPOSURE },
        uSaturation: { value: SATURATION },
        uVignette: { value: VIGNETTE },
        uWetness: { value: 0 },
        uHurtDir: { value: 0 },
        uHurtAmt: { value: 0 },
      },
      depthTest: false, depthWrite: false, toneMapped: false,
    });
    const brightU = brightMat.uniforms;
    const blurU = blurMat.uniforms;
    const compU = compMat.uniforms;

    function pass(material, target) {
      fsMesh.material = material;
      renderer.setRenderTarget(target);
      renderer.render(fsScene, fsCam);
    }

    function blur(src, dst, dir) {
      blurU.tSrc.value = src.texture;
      blurU.uDir.value.copy(dir);
      pass(blurMat, dst);
    }

    function setSize() {
      renderer.getDrawingBufferSize(bufSize);
      const w = Math.max(1, bufSize.x | 0), h = Math.max(1, bufSize.y | 0);
      const hw = Math.max(1, Math.round(w / 2)), hh = Math.max(1, Math.round(h / 2));
      const qw = Math.max(1, Math.round(w / 4)), qh = Math.max(1, Math.round(h / 4));
      const ew = Math.max(1, Math.round(w / 8)), eh = Math.max(1, Math.round(h / 8));
      // setSize disposes + reallocates GPU storage when dimensions change
      rtScene.setSize(w, h);
      rtHalfA.setSize(hw, hh); rtHalfB.setSize(hw, hh);
      rtQuartA.setSize(qw, qh); rtQuartB.setSize(qw, qh);
      rtEighthA.setSize(ew, eh); rtEighthB.setSize(ew, eh);
      rtRayA.setSize(qw, qh); rtRayB.setSize(qw, qh);
      dHalfH.set(1 / hw, 0); dHalfV.set(0, 1 / hh);
      dQuartH.set(1 / qw, 0); dQuartV.set(0, 1 / qh);
      dEighthH.set(1 / ew, 0); dEighthV.set(0, 1 / eh);
    }
    setSize();

    function render(scene, camera) {
      // weather grade input (sky.js writes G.weather; defaults keep this 0)
      compU.uWetness.value = G.weather ? G.weather.wetness : 0;
      compU.uHurtAmt.value = G.hurtAmt || 0;
      compU.uHurtDir.value = G.hurtDir || 0;

      // 1. scene -> HDR target (MSAA auto-resolves at the end of render())
      renderer.setRenderTarget(rtScene);
      renderer.render(scene, camera);

      // 2. main bloom: bright pass @ 1/2, blur @ 1/2, blur down to 1/4
      brightU.tSrc.value = rtScene.texture;
      brightU.uThreshold.value = BLOOM_THRESHOLD;
      brightU.uKnee.value = BLOOM_KNEE;
      pass(brightMat, rtHalfA);
      blur(rtHalfA, rtHalfB, dHalfH);
      blur(rtHalfB, rtHalfA, dHalfV);      // rtHalfA = tight bloom
      blur(rtHalfA, rtQuartA, dQuartH);    // downsample + widen
      blur(rtQuartA, rtQuartB, dQuartV);   // rtQuartB = wide bloom

      // 3. diffusion: low-threshold bright pass @ 1/4, double blur @ 1/8
      brightU.uThreshold.value = DIFF_THRESHOLD;
      brightU.uKnee.value = DIFF_KNEE;
      pass(brightMat, rtQuartA);
      blur(rtQuartA, rtEighthA, dEighthH);
      blur(rtEighthA, rtEighthB, dEighthV);
      blur(rtEighthB, rtEighthA, dEighthH);
      blur(rtEighthA, rtEighthB, dEighthV); // rtEighthB = diffusion

      // 4. god rays: radial blur streaming away from the sun's screen position.
      // Occlusion comes for free — a hidden sun leaves no bright source.
      let rayStrength = 0;
      if (G.sunDir) {
        camera.getWorldDirection(_camDir);
        if (_camDir.dot(G.sunDir) > 0.1) {
          _sunPos.copy(G.sunDir).multiplyScalar(800).add(camera.position);
          _sunNdc.copy(_sunPos).project(camera);
          const w = G.weather || {};
          const sunUp = clamp01(G.sunDir.y * 4 + 0.2);
          const lowSun = clamp01(1 - Math.abs(G.sunDir.y) * 3.2); // dawn/dusk boost
          const edge = Math.max(Math.abs(_sunNdc.x), Math.abs(_sunNdc.y));
          const vis = edge < 1.4 ? clamp01(1.4 - edge) : 0;
          rayStrength = vis * sunUp * (0.16 + lowSun * 0.65) * (1 - (w.grim || 0));
          if (rayStrength > 0.01) {
            brightU.tSrc.value = rtScene.texture;
            brightU.uThreshold.value = RAY_THRESHOLD;
            brightU.uKnee.value = RAY_KNEE;
            pass(brightMat, rtRayA);
            rayMat.uniforms.uCenter.value.set(_sunNdc.x * 0.5 + 0.5, _sunNdc.y * 0.5 + 0.5);
            rayMat.uniforms.tSrc.value = rtRayA.texture;
            rayMat.uniforms.uStride.value = 1.0;
            pass(rayMat, rtRayB);
            rayMat.uniforms.tSrc.value = rtRayB.texture;
            rayMat.uniforms.uStride.value = 2.2;
            pass(rayMat, rtRayA);
          }
        }
      }
      compU.uRay.value = rayStrength;

      // 5. composite + tone map + grade -> canvas
      pass(compMat, null);
    }

    return { render, setSize };
  } catch (err) {
    console.warn('Post pipeline unavailable; falling back to direct rendering.', err);
    try { renderer.setRenderTarget(null); } catch (e) { /* ignore */ }
    return null;
  }
}
