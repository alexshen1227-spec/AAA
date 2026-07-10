// AudioSys: real-sample engine (CC0 SFX/ambience/music from sfx-manifest.js)
// with the original WebAudio synth kept as a seamless fallback — every sfx
// case falls through to the procedural version until its buffer is loaded,
// and the generative sparse-piano ambience returns if music fails to load.
//
// Graph: master → destination; three buses hang off master:
//   sfxBus (one-shots), ambBus (wind/crickets/birds/river loops),
//   musicBus (day/night crossfade, combat duck, blood-night silence).
// G.settings.mute flips master exactly as before; buses keep relative levels.
import { G } from './state.js';
import { SFX_FILES } from './sfx-manifest.js';
import { loadAudioBuffer } from './assets.js';
import { inRiver } from './terrain.js';

// round-robin / random variation pools (module-scope: no per-call array allocs)
const RR_SWING = ['swing_1', 'swing_2', 'swing_3'];
const RR_HIT = ['hit_1', 'hit_2'];
const RR_SWIM = ['swim_1', 'swim_2'];
const STEP_GRASS = ['step_grass_1', 'step_grass_2', 'step_grass_3'];

// enemy states that count as "in combat" for music ducking
const COMBAT_STATES = {
  alert: 1, chase: 1, orbit: 1, windup: 1, strike: 1, recover: 1,
  backstep: 1, leap: 1, leapCrouch: 1, throwWind: 1, attack: 1,
  dive: 1, // razorkite stoop
};

// linear dt-driven move toward a target (used for all fades; no allocs)
function move(cur, target, maxStep) {
  if (cur < target) return Math.min(target, cur + maxStep);
  return Math.max(target, cur - maxStep);
}

export class AudioSys {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.sfxBus = null;
    this.ambBus = null;
    this.musicBus = null;
    this.reverb = null;
    this.windGain = null;      // synth wind bed (fades out once amb_wind is live)
    this.cricketGain = null;   // synth crickets (fade out once amb_night is live)
    this.nextNote = 0;
    this.enabled = false;

    // decoded sample buffers, filled asynchronously after start()
    this.buffers = {};
    this.rr = {};              // round-robin counters keyed by pool[0]

    // real-music state
    this.musicTried = false;   // both music loads settled (ok or failed)
    this.musicOn = false;      // at least one real music loop is running
    this.musicDayGain = null;  // loop gain nodes, created once buffers arrive
    this.musicNightGain = null;
    this.musicWInit = false;
    this.musicDayW = 1;        // 1 = day track, 0 = night track (~6s crossfade)
    this.duckHold = 0;         // seconds of combat-duck remaining
    this.duckW = 1;            // 1 = full music, 0.35 = ducked
    this.bloodW = 1;           // 1 = normal, 0 = blood-night silence

    // ambience loop gain refs (created once when buffers arrive)
    this.ambWindGain = null;
    this.ambNightGain = null;
    this.ambBirdsGain = null;
    this.ambRiverGain = null;
    this.riverProbeT = 0;      // cheap river probe every ~0.5s
    this.riverProx = 0;        // 0 none / 0.5 near / 1 in river

    // war drums: distant camp skins at night + a combat pulse that resolves
    this.drumProbeT = 0;       // camp-distance probe every ~0.5s
    this.drumProx = 0;         // 0..1 nearness to the closest living camp
    this.percW = 0;            // combat percussion weight (eased)
    this.nextDrum = 0;         // AudioContext-time watermark for the next beat
    this.drumBeat = 0;         // running beat index (accents every 4th)
    this.prevAggro = 0;        // for the combat-ends cadence edge
    this.combatT = 0;          // how long this fight has run (gates the cadence)
  }

  start() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.6;
    this.master.connect(this.ctx.destination);

    // buses (independent gains under master)
    this.sfxBus = this.ctx.createGain();
    this.sfxBus.gain.value = 1;
    this.sfxBus.connect(this.master);
    this.ambBus = this.ctx.createGain();
    this.ambBus.gain.value = 1;
    this.ambBus.connect(this.master);
    this.musicBus = this.ctx.createGain();
    this.musicBus.gain.value = 1;
    this.musicBus.connect(this.master);

    // reverb bus
    this.reverb = this.ctx.createConvolver();
    this.reverb.buffer = this.makeImpulse(2.8, 2.2);
    const revGain = this.ctx.createGain();
    revGain.gain.value = 0.45;
    this.reverb.connect(revGain).connect(this.master);

    this.startWind();
    this.startCrickets();
    this.enabled = true;
    this.nextNote = this.ctx.currentTime + 2;

    // fire-and-forget sample loading; never blocks or throws
    this.loadAll();
  }

  loadAll() {
    try {
      let musicPending = 2;
      for (const name in SFX_FILES) {
        loadAudioBuffer(this.ctx, SFX_FILES[name]).then((buf) => {
          if (buf) this.buffers[name] = buf;
          if (name === 'music_day' || name === 'music_night') {
            musicPending--;
            if (musicPending <= 0) this.musicTried = true;
          }
        }).catch(() => {
          if (name === 'music_day' || name === 'music_night') {
            musicPending--;
            if (musicPending <= 0) this.musicTried = true;
          }
        });
      }
    } catch (e) { /* audio samples are optional — synth covers everything */ }
  }

  // play a decoded sample; returns the source node, or null if not loaded yet
  playBuf(name, opts) {
    if (!this.enabled || !this.ctx) return null;
    const buf = this.buffers[name];
    if (!buf) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    if (opts && opts.rate) src.playbackRate.value = opts.rate;
    if (opts && opts.loop) src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = (opts && opts.vol !== undefined) ? opts.vol : 1;
    src.connect(g).connect((opts && opts.bus) || this.sfxBus);
    src.start();
    return src;
  }

  // round-robin through a pool of sample names
  playRR(pool, opts) {
    const k = pool[0];
    this.rr[k] = ((this.rr[k] || 0) + 1) % pool.length;
    return this.playBuf(pool[this.rr[k]], opts);
  }

  // start a looping ambience/music source at gain 0; returns its gain node
  startLoop(bufName, bus, rate) {
    const buf = this.buffers[bufName];
    if (!buf || !this.ctx) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    if (rate) src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = 0;
    src.connect(g).connect(bus);
    src.start();
    return g;
  }

  makeImpulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const len = rate * seconds;
    const buf = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  makeNoiseBuffer(seconds = 2) {
    const rate = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, rate * seconds, rate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  startWind() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.makeNoiseBuffer(4);
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 420;
    filter.Q.value = 0.6;
    this.windGain = this.ctx.createGain();
    this.windGain.gain.value = 0.025;
    src.connect(filter).connect(this.windGain).connect(this.ambBus);
    src.start();
    // slow wind swell
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 120;
    lfo.connect(lfoGain).connect(filter.frequency);
    lfo.start();
  }

  startCrickets() {
    this.cricketGain = this.ctx.createGain();
    this.cricketGain.gain.value = 0;
    this.cricketGain.connect(this.ambBus);
    const chirp = () => {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      for (let i = 0; i < 3; i++) {
        const o = this.ctx.createOscillator();
        o.frequency.value = 4200 + Math.random() * 600;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(0, t + i * 0.07);
        g.gain.linearRampToValueAtTime(0.012, t + i * 0.07 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.07 + 0.06);
        o.connect(g).connect(this.cricketGain);
        o.start(t + i * 0.07);
        o.stop(t + i * 0.07 + 0.08);
      }
      setTimeout(chirp, 400 + Math.random() * 1600);
    };
    chirp();
  }

  // soft synthesized piano-ish tone
  pianoNote(freq, when, vel = 0.14, dur = 3.2) {
    const t = when;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    for (const [mult, amp] of [[1, 1], [2, 0.28], [3, 0.1], [4.01, 0.05]]) {
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq * mult;
      const og = this.ctx.createGain();
      og.gain.value = amp;
      o.connect(og).connect(g);
      o.start(t);
      o.stop(t + dur);
    }
    g.connect(this.master);
    g.connect(this.reverb);
  }

  // generative ambience: sparse random pentatonic phrases.
  // Demoted to a fallback: only plays if the real music tracks failed to load
  // (and never during a blood night — the crimson moon wants silence).
  updateMusic() {
    if (!this.enabled || G.settings.mute) return;
    if (this.musicOn || !this.musicTried || G.bloodNight) return;
    const t = this.ctx.currentTime;
    if (t < this.nextNote) return;
    // A-minor-ish pentatonic pool across two octaves
    const pool = [220, 246.9, 293.7, 329.6, 392, 440, 493.9, 587.3, 659.3];
    const phraseLen = Math.random() < 0.55 ? 1 : 2 + (Math.random() * 2 | 0);
    let when = t;
    let idx = (Math.random() * pool.length) | 0;
    for (let i = 0; i < phraseLen; i++) {
      this.pianoNote(pool[idx], when, 0.09 + Math.random() * 0.07);
      // wander mostly stepwise
      idx = Math.max(0, Math.min(pool.length - 1, idx + ((Math.random() * 3 | 0) - 1)));
      when += 0.35 + Math.random() * 0.5;
    }
    // occasional low fifth under the phrase
    if (Math.random() < 0.3) this.pianoNote(110, t + 0.1, 0.07, 5);
    this.nextNote = when + 3.5 + Math.random() * 7;
  }

  // real music: day/night loops, ~6s dawn/dusk crossfade, combat duck, blood night
  updateMusicReal(dt, night) {
    if (!this.musicDayGain && this.buffers.music_day) {
      this.musicDayGain = this.startLoop('music_day', this.musicBus);
      if (this.musicDayGain) this.musicOn = true;
    }
    if (!this.musicNightGain && this.buffers.music_night) {
      this.musicNightGain = this.startLoop('music_night', this.musicBus);
      if (this.musicNightGain) this.musicOn = true;
    }
    if (!this.musicOn) return;
    if (!this.musicWInit) {         // snap to the current time of day on first start
      this.musicWInit = true;
      this.musicDayW = night ? 0 : 1;
    }
    this.musicDayW = move(this.musicDayW, night ? 0 : 1, dt / 6);
    // music sits a touch more present in the mix (user note: music matters)
    if (this.musicDayGain) this.musicDayGain.gain.value = 0.21 * this.musicDayW;
    if (this.musicNightGain) this.musicNightGain.gain.value = 0.21 * (1 - this.musicDayW);

    // combat duck: any live enemy in a combat state within 25m
    let combat = false;
    const p = G.player && G.player.pos;
    if (p && G.enemies) {
      for (let i = 0; i < G.enemies.length; i++) {
        const e = G.enemies[i];
        if (!e || e.dead || !e.pos || !COMBAT_STATES[e.state]) continue;
        const dx = e.pos.x - p.x, dz = e.pos.z - p.z;
        if (dx * dx + dz * dz < 625) { combat = true; break; }
      }
    }
    if (combat) this.duckHold = 3;
    else if (this.duckHold > 0) this.duckHold -= dt;
    const duckT = this.duckHold > 0 ? 0.35 : 1;
    // duck fast (~0.5s), restore gently
    this.duckW = move(this.duckW, duckT, dt * (duckT < this.duckW ? 1.3 : 0.45));

    // blood night: music fully out
    this.bloodW = move(this.bloodW, G.bloodNight ? 0 : 1, dt * 0.7);
    this.musicBus.gain.value = this.duckW * this.bloodW;
  }

  updateAmbience(dt, night, altitude, gliding) {
    const w = G.weather;
    const windMul = (w && w.windMul) || 1;
    const raining = !!w && (w.kind === 'rain' || w.kind === 'storm');
    const blood = !!G.bloodNight;

    // ---- wind: real loop scaled by altitude/weather; synth bed until then ----
    if (!this.ambWindGain && this.buffers.amb_wind) {
      this.ambWindGain = this.startLoop('amb_wind', this.ambBus);
    }
    let synthWindT = 0.02 + Math.min(0.1, Math.max(0, altitude - 15) * 0.0015) + (gliding ? 0.1 : 0);
    if (this.ambWindGain) {
      let t = (0.05 + Math.min(0.15, Math.max(0, altitude - 15) * 0.002) + (gliding ? 0.07 : 0)) * windMul;
      if (blood) t *= 1.5;      // eerie: wind up on blood nights
      this.ambWindGain.gain.value += (t - this.ambWindGain.gain.value) * Math.min(1, dt * 2);
      synthWindT = 0;           // real loop is live — fade the synth bed out
    } else if (blood) {
      synthWindT *= 1.5;
    }
    this.windGain.gain.value += (synthWindT - this.windGain.gain.value) * Math.min(1, dt * 2);

    // ---- crickets: night only, silenced by rain/storm and blood nights ----
    if (!this.ambNightGain && this.buffers.amb_night) {
      this.ambNightGain = this.startLoop('amb_night', this.ambBus);
    }
    const cricketsOn = night && !raining && !blood;
    if (this.ambNightGain) {
      this.ambNightGain.gain.value = move(this.ambNightGain.gain.value, cricketsOn ? 0.3 : 0, dt * 0.15);
      this.cricketGain.gain.value += (0 - this.cricketGain.gain.value) * Math.min(1, dt);
    } else {
      this.cricketGain.gain.value += ((cricketsOn ? 0.9 : 0) - this.cricketGain.gain.value) * Math.min(1, dt);
    }

    // ---- birds by day, ducked in rain ----
    if (!this.ambBirdsGain && this.buffers.amb_birds) {
      this.ambBirdsGain = this.startLoop('amb_birds', this.ambBus);
    }
    if (this.ambBirdsGain) {
      const t = !night ? 0.12 * (raining ? 0.25 : 1) : 0;
      this.ambBirdsGain.gain.value = move(this.ambBirdsGain.gain.value, t, dt * 0.08);
    }

    // ---- river by proximity: cheap probe (player pos ± 8m) every ~0.5s ----
    if (!this.ambRiverGain && this.buffers.amb_river) {
      this.ambRiverGain = this.startLoop('amb_river', this.ambBus);
    }
    if (this.ambRiverGain) {
      this.riverProbeT -= dt;
      if (this.riverProbeT <= 0) {
        this.riverProbeT = 0.5;
        this.riverProx = 0;
        const p = G.player && G.player.pos;
        if (p) {
          if (inRiver(p.x, p.z)) this.riverProx = 1;
          else if (inRiver(p.x + 8, p.z) || inRiver(p.x - 8, p.z) ||
                   inRiver(p.x, p.z + 8) || inRiver(p.x, p.z - 8)) this.riverProx = 0.5;
        }
      }
      this.ambRiverGain.gain.value = move(this.ambRiverGain.gain.value, 0.25 * this.riverProx, dt * 0.2);
    }
  }

  update(dt, night, altitude, gliding) {
    if (!this.enabled) return;
    this.master.gain.value = G.settings.mute ? 0 : 0.6;
    this.updateMusicReal(dt, night);
    this.updateMusic();
    this.updateSonglines();
    this.updateAmbience(dt, night, altitude, gliding);
    this.updateWarDrums(dt, night);
  }

  // -------- songlines ------------------------------------------------------
  // The restored valley plays itself back. Each landmark the player brought
  // to life contributes a sparse instrumental voice woven over the score —
  // bells for the eight beacons, an open low fifth for the Mirrormere
  // lanterns, bronze tones for the summit chimes, a settling drone once the
  // hundred-year storm is stilled. Standing in a voice's own country brings
  // it forward. Never announced, never explained: one day a bell is simply
  // there, because the player put it there.
  updateSonglines() {
    if (G.settings.mute || G.bloodNight || G.gameOver || !G.started) return;
    const t = this.ctx.currentTime;
    if (!this.nextSongline) this.nextSongline = t + 20;
    if (t < this.nextSongline) return;
    const flags = (G.story && G.story.flags) || {};
    const region = G.region || '';
    const p = G.player && G.player.pos;
    const voices = [];
    if (G.shrines && G.shrines.length && G.shrines.every(s => s.active)) {
      voices.push({
        w: region === 'The Heartfields' || region === "Wanderer's Plateau" ? 3 : 1,
        play: () => { // the eight flames: two small bells, high and patient
          this.pianoNote(880, t, 0.045, 2.4);
          this.pianoNote(1174.7, t + 0.55, 0.035, 2.8);
        },
      });
    }
    if (flags.lanternsReported) {
      voices.push({
        w: region === 'Mirrormere' ? 3 : 1,
        play: () => { // the moon-road: an open fifth, low and long
          this.pianoNote(110, t, 0.055, 7);
          this.pianoNote(164.8, t + 0.5, 0.045, 7);
        },
      });
    }
    if (flags.chimesResolved) {
      voices.push({
        w: p && p.y > 40 ? 3 : 1,
        play: () => { // the summit chimes: dawn, gale — and sometimes rain
          this.pianoNote(293.66, t, 0.05, 3.2);
          this.pianoNote(392, t + 0.5, 0.045, 3.6);
          if (Math.random() < 0.4) this.pianoNote(523.25, t + 1.05, 0.04, 3.8);
        },
      });
    }
    if (flags.finaleCompleted) {
      voices.push({
        w: (p && p.z > 300) || region === 'The Sunder Ring' ? 3 : 1,
        play: () => { // the stilled storm: fifths settling like dust
          this.pianoNote(110, t, 0.045, 9);
          this.pianoNote(220, t + 0.8, 0.04, 8);
          this.pianoNote(330, t + 1.7, 0.03, 7);
        },
      });
    }
    if (!voices.length) { this.nextSongline = t + 30; return; }
    let total = 0;
    for (const v of voices) total += v.w;
    let r = Math.random() * total;
    for (const v of voices) {
      r -= v.w;
      if (r <= 0) { v.play(); break; }
    }
    this.nextSongline = t + 24 + Math.random() * 22;
  }

  // -------- war drums ------------------------------------------------------
  // At night you hear a boglin camp before you see it: low skin-drums swelling
  // as you creep closer. When a fight starts the drums slam into a combat
  // pulse, and when the last aggroed enemy falls, a falling cadence resolves.
  // Blood nights stay deliberately silent — the valley holds its breath.
  updateWarDrums(dt, night) {
    if (!this.ctx) return;
    // camp proximity, probed sparsely like the river bed
    this.drumProbeT -= dt;
    if (this.drumProbeT <= 0) {
      this.drumProbeT = 0.5;
      this.drumProx = 0;
      const p = G.player && G.player.pos;
      if (p && night && !G.bloodNight && G.enemies) {
        let best = 1e9;
        for (const e of G.enemies) {
          if (e.dead || !e.camp || e.campDoused) continue; // rain-silenced camps carry no ambient drum
          const dx = e.camp.x - p.x, dz = e.camp.y - p.z;
          const d2 = dx * dx + dz * dz;
          if (d2 < best) best = d2;
        }
        if (best < 3600) { // audible inside 60m, full within 16m
          const d = Math.sqrt(best);
          this.drumProx = Math.min(1, Math.max(0, 1 - (d - 16) / 44));
        }
      }
    }
    // aggro count: derived each frame from combat states near the player
    // (state names cover boglins, hollows, and razorkite stoops alike)
    let aggro = 0;
    const p = G.player && G.player.pos;
    if (p && !G.gameOver && G.enemies) {
      for (const e of G.enemies) {
        if (e.dead || !e.pos || !COMBAT_STATES[e.state]) continue;
        const dx = e.pos.x - p.x, dz = e.pos.z - p.z;
        if (dx * dx + dz * dz < 2025) aggro++; // 45m
      }
    }
    if (aggro > 0) this.combatT += dt;
    if (this.prevAggro > 0 && aggro === 0 && this.combatT > 2.5 && !G.gameOver && !G.settings.mute) {
      // the last one fell — let the drums resolve
      const t = this.ctx.currentTime;
      this.pianoNote(196.0, t + 0.06, 0.15, 1.1);
      this.pianoNote(155.6, t + 0.4, 0.13, 1.3);
      this.pianoNote(130.8, t + 0.85, 0.17, 2.8);
      this.blip(58, 0.5, 'sine', 0.3, -20);
    }
    if (aggro === 0) this.combatT = 0;
    this.prevAggro = aggro;
    this.percW = move(this.percW, aggro > 0 && !G.bloodNight ? 1 : 0, dt * 1.2);

    // one shared beat clock serves both layers; combat quickens the pulse
    const rainQuiet = Math.min(1, Math.max(0, (G.weather && G.weather.campQuiet) || 0));
    const amb = this.drumProx * 0.55; // doused camps were excluded by the probe
    const cbt = this.percW * 0.95 * (1 - rainQuiet * 0.35); // combat cadence remains, but rain softens it
    const vol = Math.max(amb, cbt);
    if (vol <= 0.04 || G.settings.mute) return;
    const t = this.ctx.currentTime;
    if (t < this.nextDrum) return;
    const interval = this.percW > 0.5 ? 0.36 : 0.62;
    this.nextDrum = Math.max(t, this.nextDrum) + interval;
    this.drumBeat++;
    const accent = this.drumBeat % 4 === 0;
    this.blip(accent ? 88 : 62, 0.24, 'sine', (accent ? 0.34 : 0.22) * vol, -26);
    this.noiseBurst(0.05, 320, 0.12 * vol, 1);
    if (accent && this.percW > 0.5) this.noiseBurst(0.09, 900, 0.07 * vol, 2); // rim crack in combat
  }

  // -------- procedural SFX (fallback layer for the sample player) --------

  blip(freq, dur, type = 'sine', vel = 0.2, slide = 0) {
    if (!this.enabled || G.settings.mute) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vel, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.sfxBus);
    o.start(t); o.stop(t + dur + 0.02);
  }

  noiseBurst(dur, freq, vel = 0.25, q = 1.2) {
    if (!this.enabled || G.settings.mute) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.makeNoiseBuffer(dur + 0.1);
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vel, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.sfxBus);
    src.start(t); src.stop(t + dur + 0.05);
  }

  chord(freqs, vel = 0.12, spread = 0.06) {
    if (!this.enabled || G.settings.mute) return;
    const t = this.ctx.currentTime;
    freqs.forEach((f, i) => this.pianoNote(f, t + i * spread, vel, 2.5));
  }

  // sfx(name[, arg]) — sample when loaded, synth fallback otherwise.
  // arg is only used by 'land' (impact speed → land_hard when > 14).
  sfx(name, arg) {
    if (!this.enabled || G.settings.mute) return;
    switch (name) {
      case 'swing':
        if (!this.playRR(RR_SWING, { vol: 0.55 })) this.noiseBurst(0.16, 1800, 0.18, 0.8);
        break;
      case 'hit':
        if (!this.playRR(RR_HIT, { vol: 0.6 })) this.noiseBurst(0.12, 700, 0.3, 1.5);
        this.blip(160, 0.1, 'square', 0.12, -60);   // keep the low blip layered
        break;
      case 'clubswing':
        if (!this.playBuf('club_swing', { vol: 0.6 })) this.noiseBurst(0.2, 500, 0.22, 1);
        break;
      case 'block':
        if (!this.playBuf('block', { vol: 0.7 })) this.noiseBurst(0.09, 2600, 0.16, 2);
        break;
      case 'bone_rattle':
        if (!this.playBuf('bone_rattle', { vol: 0.6 })) this.noiseBurst(0.22, 3200, 0.08, 2);
        break;
      case 'hurt':
        if (!this.playBuf('hurt', { vol: 0.8 })) this.blip(180, 0.25, 'sawtooth', 0.18, -90);
        break;
      case 'die':
        if (!this.playBuf('enemy_die', { vol: 0.8 })) this.chord([220, 174.6, 130.8], 0.12, 0.3);
        break;
      case 'poof':
        if (!this.playBuf('enemy_die', { vol: 0.7, rate: 0.8 })) {
          this.noiseBurst(0.5, 900, 0.2, 0.7); this.blip(500, 0.4, 'triangle', 0.1, -300);
        }
        break;
      case 'jump':
        if (!this.playBuf('jump', { vol: 0.5 })) this.blip(300, 0.14, 'triangle', 0.1, 140);
        break;
      case 'land': {
        const hard = (arg || 0) > 14;
        if (!this.playBuf(hard ? 'land_hard' : 'land_soft', { vol: hard ? 0.85 : 0.6 })) {
          this.noiseBurst(0.08, 350, 0.12, 1);
        }
        break;
      }
      case 'step':
        if (!this.playBuf(STEP_GRASS[(Math.random() * STEP_GRASS.length) | 0],
            { vol: 0.5, rate: 0.9 + Math.random() * 0.2 })) {
          this.noiseBurst(0.045, 900 + Math.random() * 300, 0.05, 1);
        }
        break;
      case 'mantle':
        if (!this.playBuf('step_stone_1', { vol: 0.7, rate: 0.8 })) this.noiseBurst(0.06, 600, 0.09, 1);
        break;
      case 'splash':
        if (!this.playBuf('splash', { vol: 0.7 })) this.noiseBurst(0.4, 1100, 0.2, 0.6);
        break;
      case 'swim':
        if (!this.playRR(RR_SWIM, { vol: 0.5 })) this.noiseBurst(0.25, 900, 0.12, 0.7);
        break;
      case 'glide':
        if (!this.playBuf('glide_wind', { vol: 0.7 })) this.noiseBurst(0.5, 600, 0.14, 0.5);
        break;
      case 'updraft':
        if (!this.playBuf('glide_wind', { vol: 0.5, rate: 1.4 })) this.noiseBurst(0.25, 800, 0.12, 0.6);
        break;
      case 'throw':
        if (!this.playBuf('swing_1', { vol: 0.6, rate: 0.7 })) this.noiseBurst(0.18, 1200, 0.14, 0.8);
        break;
      case 'rotate':
        if (!this.playBuf('ui_lock', { vol: 0.3 })) this.blip(740, 0.06, 'square', 0.04);
        break;
      case 'grab':
        if (!this.playBuf('grab', { vol: 0.6 })) this.blip(420, 0.12, 'triangle', 0.1, 80);
        break;
      case 'thud':
        if (!this.playBuf('thud', { vol: 0.7 })) this.noiseBurst(0.12, 260, 0.2, 1.4);
        break;
      case 'slam':
        if (!this.playBuf('slam', { vol: 0.9 })) {
          this.noiseBurst(0.3, 180, 0.3, 1); this.blip(90, 0.25, 'sine', 0.2, -40);
        }
        break;
      case 'thunder':
        if (!this.playBuf('thunder', { vol: 0.8 })) this.noiseBurst(1.2, 110, 0.3, 0.4);
        break;
      case 'pickup':
        if (!this.playBuf('pickup_gem', { vol: 0.6 })) {
          this.blip(660, 0.12, 'sine', 0.14); this.blip(990, 0.18, 'sine', 0.12);
        }
        break;
      case 'eat':
        if (!this.playBuf('eat', { vol: 0.7 })) {
          this.noiseBurst(0.1, 1600, 0.14, 1); this.blip(500, 0.15, 'sine', 0.08, 100);
        }
        break;
      case 'heart':
        if (!this.playBuf('heart', { vol: 0.6 })) this.blip(660, 0.12, 'sine', 0.1, 120);
        break;
      case 'heartup':
        if (!this.playBuf('upgrade', { vol: 0.6 })) this.chord([523.3, 659.3, 784, 1046.5], 0.14, 0.1);
        break;
      case 'shrine':
        if (!this.playBuf('shrine_wake', { vol: 0.7 })) this.chord([261.6, 329.6, 392, 523.3], 0.14, 0.12);
        break;
      case 'tower':
        if (!this.playBuf('tower_wake', { vol: 0.7 })) this.chord([196, 246.9, 293.7, 392, 493.9], 0.15, 0.14);
        break;
      case 'glimmer':
        if (!this.playBuf('glimmer', { vol: 0.5 })) {
          this.blip(880, 0.1, 'sine', 0.12); this.blip(1174.7, 0.14, 'sine', 0.12); this.blip(1568, 0.2, 'sine', 0.1);
        }
        break;
      case 'alert':
        if (!this.playBuf('alert', { vol: 0.5 })) this.blip(520, 0.12, 'square', 0.08, 150);
        break;
      case 'screech': // razorkite telegraph — a raptor cry, heard before it's seen
        if (!this.playBuf('screech', { vol: 0.6 })) {
          this.blip(1800, 0.5, 'sawtooth', 0.11, -900);
          this.blip(2400, 0.35, 'sawtooth', 0.07, -1400);
          this.noiseBurst(0.4, 3000, 0.05, 3);
        }
        break;
      case 'windup':
        if (!this.playBuf('windup', { vol: 0.5 })) this.blip(140, 0.3, 'sawtooth', 0.07, 60);
        break;
      case 'exhaust':
        if (!this.playBuf('exhaust', { vol: 0.5 })) this.blip(240, 0.3, 'sine', 0.1, -120);
        break;
      case 'lock':
        if (!this.playBuf('ui_lock', { vol: 0.5 })) this.blip(740, 0.08, 'square', 0.06);
        break;
      case 'chest':
        if (!this.playBuf('chest_open', { vol: 0.7 })) this.blip(220, 0.3, 'triangle', 0.1, 80);
        break;
      case 'ui_open':
        if (!this.playBuf('ui_open', { vol: 0.5 })) this.blip(600, 0.08, 'sine', 0.07, 120);
        break;
      case 'ui_close':
        if (!this.playBuf('ui_close', { vol: 0.5 })) this.blip(600, 0.08, 'sine', 0.07, -120);
        break;
      case 'ui_toast':
        if (!this.playBuf('ui_toast', { vol: 0.5 })) this.blip(880, 0.1, 'sine', 0.07);
        break;
      // unknown names stay a silent no-op
    }
  }
}
