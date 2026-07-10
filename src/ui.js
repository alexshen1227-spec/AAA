// HUD & screens: hearts, stamina wheel, counters, minimap, full map, compass,
// toasts, banners, interaction prompt, pause panel, title / game-over screens.
import { G, save, setPauseReason, GLIMMER_TOTAL } from './state.js';
import * as THREE from 'three';
import { renderMapImage, renderMapImageAsync, inRiver } from './terrain.js';
import { propInstance } from './assets.js';
import { spawnHealBloom } from './world.js';
import { clamp } from './noise.js';
import { CHRONICLE, DEEDS } from './remember.js';
import { getActiveObjective, getQuestLog, setActiveQuest } from './quests.js';

const WX_GLYPH = { clear: '☀', breeze: '🍃', overcast: '☁', rain: '☔', storm: '⚡' };
const ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
const COMPASS_PTS = ['N', 'E', 'S', 'W'];
const DEG2RAD = Math.PI / 180;

// full-map region labels (world coords; matches main.js region logic)
const MAP_LABELS = [
  ["Wanderer's Plateau", 60, -80],
  ['Mirrormere', -170, 120],
  ['Thornwood', 80, 200],
  ['Stormridge Massif', -120, -260],
  ['The Heartfields', -40, 40],
  ['The Sunder Ring', 0, 455],
];

const PAUSE_HINTS = [
  'Storms breed rising wind — open your glider where the air shimmers upward.',
  'Rain slicks the stone. Climbing through a downpour is a gamble for the bold.',
  'Thrown crates make fine steps; heavy slabs make better ones — and worse throws.',
  'The crimson moon returns what the sword has taken. Rest before it rises.',
  'Towers chart the land. Beacons remember your fall, and light the way back.',
  'The glimmers hide beneath lonely rocks — and in places only the wind can reach.',
];

// one-time scan for a spot to label the river on the full map
function findRiverSpot() {
  const pts = [];
  let sx = 0, sz = 0;
  for (let x = -400; x <= 400; x += 25) {
    for (let z = -400; z <= 400; z += 25) {
      if (inRiver(x, z)) { pts.push([x, z]); sx += x; sz += z; }
    }
  }
  if (!pts.length) return null;
  sx /= pts.length; sz /= pts.length;
  let best = pts[0], bd = Infinity;
  for (const q of pts) {
    const d = (q[0] - sx) * (q[0] - sx) + (q[1] - sz) * (q[1] - sz);
    if (d < bd) { bd = d; best = q; }
  }
  return { x: best[0], z: best[1] };
}

export class UI {
  constructor() {
    this.el = id => document.getElementById(id);
    this.heartsCv = this.el('hearts');
    this.staminaCv = this.el('stamina');
    this.mapCv = this.el('minimap');
    this.compassCv = this.el('compass');
    // bow crosshair + quiver readout (created here so index.html stays lean)
    this.aimEl = document.createElement('div');
    this.aimEl.style.cssText =
      'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);' +
      'pointer-events:none;display:none;text-align:center;z-index:40;';
    this.aimEl.innerHTML =
      '<div style="width:6px;height:6px;border-radius:50%;background:#fff;' +
      'box-shadow:0 0 6px rgba(0,0,0,0.7);margin:0 auto"></div>' +
      '<div style="margin-top:12px;font:600 14px Cinzel,Georgia;color:#f4ecd2;' +
      'text-shadow:0 1px 3px #000">➳ <span>0</span></div>';
    document.body.appendChild(this.aimEl);
    this.arrowCtEl = this.aimEl.querySelector('span');

    // ---- satchel: the old top counter bar now lives in a proper inventory --
    this.el('counters').style.display = 'none';
    this.bagBtn = document.createElement('div');
    this.bagBtn.style.cssText =
      'position:fixed;top:12px;right:200px;width:40px;height:40px;border-radius:50%;' +
      'background:rgba(14,16,22,.62);border:1px solid rgba(226,203,141,.4);' +
      'display:none;align-items:center;justify-content:center;font-size:20px;' +
      'cursor:pointer;z-index:30;box-shadow:0 2px 8px rgba(0,0,0,.4);';
    this.bagBtn.textContent = '🎒';
    this.bagBtn.title = 'Satchel (I)';
    this.bagBtn.onclick = () => this.toggleInventory();
    document.body.appendChild(this.bagBtn);

    // TotK-style satchel: fullscreen overlay, category tabs, fixed slot grid,
    // and a detail panel describing the selected item
    this.invEl = document.createElement('div');
    this.invEl.style.cssText =
      'position:fixed;inset:0;display:none;z-index:60;align-items:center;justify-content:center;' +
      'background:radial-gradient(ellipse at center,rgba(10,12,18,.82) 0%,rgba(4,5,8,.94) 100%);' +
      'font-family:Cinzel,Georgia,serif;color:#f0e6c8;';
    this.invEl.innerHTML =
      '<div style="width:min(940px,94vw);padding:10px 12px">' +
      '  <div style="display:flex;align-items:baseline;justify-content:space-between">' +
      '    <div style="font-size:26px;letter-spacing:8px">SATCHEL</div>' +
      '    <div id="inv-gems" style="font-family:Georgia;font-size:16px;color:#9fefff">💠 0</div>' +
      '  </div>' +
      '  <div style="height:1px;background:linear-gradient(90deg,rgba(226,203,141,.7),transparent);margin:8px 0 14px"></div>' +
      '  <div style="display:flex;gap:26px;align-items:flex-start">' +
      '    <div style="flex:1">' +
      '      <div id="inv-tabs" style="display:flex;gap:10px;margin-bottom:12px"></div>' +
      '      <div id="inv-grid" style="display:grid;grid-template-columns:repeat(5,84px);grid-auto-rows:84px;gap:9px"></div>' +
      '    </div>' +
      '    <div id="inv-detail" style="width:300px;min-height:360px;border:1px solid rgba(226,203,141,.35);' +
      '      border-radius:12px;background:linear-gradient(160deg,rgba(20,23,32,.9),rgba(30,28,24,.9));' +
      '      padding:20px 22px;text-align:center"></div>' +
      '  </div>' +
      '  <div style="margin-top:14px;font-size:12px;color:#b8ac8c;font-family:Georgia;text-align:center">' +
      '    click an item to inspect · I / ESC — close</div>' +
      '</div>';
    document.body.appendChild(this.invEl);
    this.invGrid = this.invEl.querySelector('#inv-grid');
    this.invTabs = this.invEl.querySelector('#inv-tabs');
    this.invDetail = this.invEl.querySelector('#inv-detail');
    this.invGems = this.invEl.querySelector('#inv-gems');
    this.invOpen = false;
    this.invTab = 'materials';
    this.invSel = null;

    this.mapImg = renderMapImage(256);
    // 512px map for the M overlay: painted progressively in the background so
    // the first M press never hitches; until it completes the minimap image
    // stands in (scaled up — slightly soft for a few seconds, never laggy)
    this.bigImg = null;
    const big = renderMapImageAsync(512, 6, () => { this.bigImg = big; });
    this.riverLabel = undefined;  // lazily-found label spot for the Serpent's Run
    this.toasts = [];             // active toast entries {el, timer}, newest last
    this.lastHearts = -1;
    this.lastMax = -1;
    this.staminaVisible = 0;
    this.lastPrompt = null;
    this.lastWx = '';
    this.lastMoon = null;
    this.objT = -10;              // last objective refresh (G.time)
    this.lastObj = null;
    this.activeObjective = null;
    this.hintIdx = -1;
  }

  // ---- hearts ----------------------------------------------------------

  drawHeart(ctx, x, y, size, fill) {
    // fill: 0..1 fraction of this heart
    ctx.save();
    ctx.translate(x, y);
    const s = size / 24;
    ctx.scale(s, s);
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(12, 21);
      ctx.bezierCurveTo(5, 15, 0, 11, 0, 6.5);
      ctx.bezierCurveTo(0, 2.5, 3, 0, 6.5, 0);
      ctx.bezierCurveTo(9, 0, 11, 1.5, 12, 3.5);
      ctx.bezierCurveTo(13, 1.5, 15, 0, 17.5, 0);
      ctx.bezierCurveTo(21, 0, 24, 2.5, 24, 6.5);
      ctx.bezierCurveTo(24, 11, 19, 15, 12, 21);
      ctx.closePath();
    };
    path();
    ctx.fillStyle = '#2a2028';
    ctx.fill();
    if (fill > 0) {
      ctx.save();
      path();
      ctx.clip();
      ctx.fillStyle = '#e8384a';
      ctx.fillRect(0, 0, 24 * fill, 24);
      ctx.restore();
    }
    path();
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.restore();
  }

  drawHearts() {
    if (G.hearts === this.lastHearts && G.maxHearts === this.lastMax) return;
    const grew = this.lastMax >= 0 &&
      (G.hearts > this.lastHearts || G.maxHearts > this.lastMax);
    this.lastHearts = G.hearts; this.lastMax = G.maxHearts;
    const n = Math.ceil(G.maxHearts / 4);
    const size = 26, pad = 5;
    const perRow = 8;
    this.heartsCv.width = Math.min(n, perRow) * (size + pad) + 4;
    this.heartsCv.height = Math.ceil(n / perRow) * (size + pad) + 6;
    const ctx = this.heartsCv.getContext('2d');
    for (let i = 0; i < n; i++) {
      const fill = clamp((G.hearts - i * 4) / 4, 0, 1);
      const cx = (i % perRow) * (size + pad) + 2;
      const cy = Math.floor(i / perRow) * (size + pad) + 2;
      this.drawHeart(ctx, cx, cy, size, fill);
    }
    // low-health pulse + brief glow pop on any gain
    this.heartsCv.classList.toggle('low', G.hearts <= 4);
    if (grew) {
      this.heartsCv.classList.remove('pop');
      void this.heartsCv.offsetWidth;
      this.heartsCv.classList.add('pop');
    }
  }

  // ---- stamina wheel ------------------------------------------------------

  drawStamina(dt) {
    const p = G.player;
    const inUse = G.stamina < G.maxStamina - 0.5;
    this.staminaVisible += ((inUse ? 1 : 0) - this.staminaVisible) * Math.min(1, dt * 6);
    const cv = this.staminaCv;
    cv.style.opacity = this.staminaVisible.toFixed(2);
    if (this.staminaVisible < 0.02) return;
    const ctx = cv.getContext('2d');
    const W = cv.width, cx = W / 2, cy = W / 2;
    ctx.clearRect(0, 0, W, W);
    const frac = G.stamina / G.maxStamina;
    const r0 = W * 0.32;
    // extra ring for upgraded stamina
    const rings = Math.ceil(G.maxStamina / 100);
    for (let ring = 0; ring < rings; ring++) {
      const lo = ring * 100 / G.maxStamina;
      const hi = Math.min(1, (ring + 1) * 100 / G.maxStamina);
      const ringFrac = clamp((frac - lo) / (hi - lo), 0, 1);
      const rr = r0 + ring * 9;
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(20,26,20,0.55)';
      ctx.lineWidth = 7;
      ctx.stroke();
      if (ringFrac > 0) {
        ctx.beginPath();
        ctx.arc(cx, cy, rr, -Math.PI / 2, -Math.PI / 2 + ringFrac * Math.PI * 2);
        const low = frac < 0.25;
        const flash = p.exhausted && (G.time * 10 % 2 < 1); // sharp exhausted blink
        ctx.strokeStyle = flash ? '#ff3030' : (low ? '#e8b23a' : '#8ae05a');
        ctx.lineWidth = 6;
        ctx.lineCap = 'round';
        ctx.stroke();
      }
      // tick marks every 25 stamina around this ring
      const cap = (hi - lo) * G.maxStamina;
      ctx.strokeStyle = 'rgba(12,16,12,0.8)';
      ctx.lineWidth = 2;
      ctx.lineCap = 'butt';
      for (let f = 25; f < cap - 0.5; f += 25) {
        const a = -Math.PI / 2 + (f / cap) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        ctx.beginPath();
        ctx.moveTo(cx + ca * (rr - 4), cy + sa * (rr - 4));
        ctx.lineTo(cx + ca * (rr + 4), cy + sa * (rr + 4));
        ctx.stroke();
      }
    }
    // pulsing red halo while exhausted
    if (p.exhausted) {
      ctx.beginPath();
      ctx.arc(cx, cy, r0 + (rings - 1) * 9 + 8, 0, Math.PI * 2);
      ctx.globalAlpha = 0.32 + 0.24 * Math.sin(G.time * 14);
      ctx.strokeStyle = '#ff4040';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // ---- minimap -----------------------------------------------------------

  drawMap() {
    const cv = this.mapCv;
    const ctx = cv.getContext('2d');
    const S = cv.width;
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2);
    ctx.clip();

    // world spans ±550 -> map image 256px
    const p = G.player.pos;
    const view = 260; // world units across the minimap
    const imgScale = 256 / 1100;
    const sx = (p.x + 550) * imgScale - (view * imgScale) / 2;
    const sz = (p.z + 550) * imgScale - (view * imgScale) / 2;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.mapImg, sx, sz, view * imgScale, view * imgScale, 0, 0, S, S);

    const toMap = (wx, wz) => [
      ((wx - p.x) / view + 0.5) * S,
      ((wz - p.z) / view + 0.5) * S,
    ];

    // charted region overlay: shrines/towers shown if a tower is active nearby (or shrine already found)
    for (const t of G.towers) {
      const [mx, my] = toMap(t.x, t.z);
      ctx.fillStyle = t.active ? '#54e8ff' : '#ffb03d';
      ctx.beginPath();
      ctx.moveTo(mx, my - 6); ctx.lineTo(mx + 4, my + 4); ctx.lineTo(mx - 4, my + 4);
      ctx.closePath(); ctx.fill();
    }
    const anyTower = G.towers.some(t => t.active);
    for (const s of G.shrines) {
      if (!s.active && !anyTower) continue;
      const [mx, my] = toMap(s.x, s.z);
      if (mx < -8 || mx > S + 8 || my < -8 || my > S + 8) continue;
      ctx.fillStyle = s.active ? '#54e8ff' : '#ff9a3d';
      ctx.beginPath();
      ctx.arc(mx, my, 3.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#10202a'; ctx.lineWidth = 1; ctx.stroke();
    }

    // Active quest target: a small gold diamond that turns the journal into
    // real navigation without overwhelming undiscovered map information.
    const qt = this.activeObjective && this.activeObjective.target;
    if (qt) {
      const [mx, my] = toMap(qt.x, qt.z);
      if (mx > -8 && mx < S + 8 && my > -8 && my < S + 8) {
        ctx.save(); ctx.translate(mx, my); ctx.rotate(Math.PI / 4);
        ctx.fillStyle = '#ffe066'; ctx.strokeStyle = '#342910'; ctx.lineWidth = 1.2;
        ctx.fillRect(-3.5, -3.5, 7, 7); ctx.strokeRect(-3.5, -3.5, 7, 7);
        ctx.restore();
      }
    }

    // player arrow
    ctx.save();
    ctx.translate(S / 2, S / 2);
    ctx.rotate(Math.atan2(Math.sin(G.player.yaw), Math.cos(G.player.yaw)) * -1 + Math.PI);
    ctx.fillStyle = '#ffe066';
    ctx.beginPath();
    ctx.moveTo(0, 7); ctx.lineTo(5, -5); ctx.lineTo(0, -2); ctx.lineTo(-5, -5);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#202020'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.restore();

    ctx.restore();
    // ring + N
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S / 2 - 2, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(226,203,141,0.85)';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S / 2 - 6, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(226,203,141,0.3)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#f0e6c8';
    ctx.font = 'bold 13px Cinzel, Georgia';
    ctx.textAlign = 'center';
    ctx.fillText('N', S / 2, 14);
  }

  // ---- compass strip -------------------------------------------------------

  drawCompass() {
    const cv = this.compassCv;
    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height, cx = W / 2;
    ctx.clearRect(0, 0, W, H);
    // heading: 0 = north (-z), 90° = east (+x); forward = (sin yaw, cos yaw)
    const yaw = G.player.camYaw;
    const heading = Math.atan2(Math.sin(yaw), -Math.cos(yaw));
    const pxPerRad = 150, range = 1.15;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let deg = 0; deg < 360; deg += 15) {
      let rel = deg * DEG2RAD - heading;
      rel = Math.atan2(Math.sin(rel), Math.cos(rel));
      if (rel < -range || rel > range) continue;
      const x = cx + rel * pxPerRad;
      const t = Math.abs(rel) / range;
      ctx.globalAlpha = 1 - t * t;
      if (deg % 90 === 0) {
        ctx.fillStyle = deg === 0 ? '#ffe066' : '#f0e6c8';
        ctx.font = deg === 0 ? 'bold 15px Cinzel, Georgia' : '600 13px Cinzel, Georgia';
        ctx.fillText(COMPASS_PTS[deg / 90], x, H / 2 + 4);
      } else {
        ctx.strokeStyle = 'rgba(226,203,141,0.55)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, H / 2);
        ctx.lineTo(x, H / 2 + 7);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    // center caret
    ctx.fillStyle = '#ffe066';
    ctx.beginPath();
    ctx.moveTo(cx - 4, 1); ctx.lineTo(cx + 4, 1); ctx.lineTo(cx, 7);
    ctx.closePath();
    ctx.fill();

    const target = this.activeObjective && this.activeObjective.target;
    if (target) {
      const p = G.player.pos;
      const tb = Math.atan2(target.x - p.x, -(target.z - p.z));
      let rel = tb - heading;
      rel = Math.atan2(Math.sin(rel), Math.cos(rel));
      if (Math.abs(rel) <= range) {
        const x = cx + rel * pxPerRad;
        ctx.save(); ctx.translate(x, H - 5); ctx.rotate(Math.PI / 4);
        ctx.fillStyle = '#ffe066'; ctx.fillRect(-3, -3, 6, 6); ctx.restore();
      }
    }
  }

  // ---- active quest objective + navigation -----------------------------------

  updateObjective() {
    if (G.time - this.objT < 1) return; // refresh ~1s of game time
    this.objT = G.time;
    const el = this.el('objective');
    const p = G.player.pos;
    const objective = getActiveObjective();
    this.activeObjective = objective;
    if (objective) {
      let nav = '';
      const target = objective.target;
      if (target) {
        const yaw = G.player.camYaw;
        const heading = Math.atan2(Math.sin(yaw), -Math.cos(yaw));
        const tb = Math.atan2(target.x - p.x, -(target.z - p.z));
        let rel = Math.atan2(Math.sin(tb - heading), Math.cos(tb - heading));
        const idx = ((Math.round(rel / (Math.PI / 4)) % 8) + 8) % 8;
        const d = Math.hypot(target.x - p.x, target.z - p.z);
        nav = `\n${target.label || objective.stageTitle} ${ARROWS[idx]} ${Math.round(d)}m`;
      } else if (objective.progress) {
        nav = `\n${objective.progress.current} / ${objective.progress.total} ${objective.progress.label}`;
      }
      const txt = objective.questTitle.toUpperCase() + nav;
      el.title = objective.objective;
      if (txt !== this.lastObj) { this.lastObj = txt; el.textContent = txt; }
      return;
    }
    let best = null, bd = Infinity;
    for (const s of G.shrines) {
      if (s.active) continue;
      const d = (s.x - p.x) * (s.x - p.x) + (s.z - p.z) * (s.z - p.z);
      if (d < bd) { bd = d; best = s; }
    }
    let txt;
    if (!best) {
      txt = '✦ All beacons burn ✦';
    } else {
      const yaw = G.player.camYaw;
      const heading = Math.atan2(Math.sin(yaw), -Math.cos(yaw));
      const tb = Math.atan2(best.x - p.x, -(best.z - p.z));
      let rel = tb - heading;
      rel = Math.atan2(Math.sin(rel), Math.cos(rel));
      const idx = ((Math.round(rel / (Math.PI / 4)) % 8) + 8) % 8;
      txt = 'Beacon ' + ARROWS[idx] + ' ' + Math.round(Math.sqrt(bd)) + 'm';
    }
    el.title = txt;
    if (txt !== this.lastObj) { this.lastObj = txt; el.textContent = txt; }
  }

  // ---- messages ------------------------------------------------------------

  toast(msg, color = 0xffffff, ms = 2600) {
    // queue of up to 2 stacked toasts; oldest fades out first
    while (this.toasts.length >= 2) this.dismissToast(this.toasts[0]);
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    el.style.color = '#' + color.toString(16).padStart(6, '0');
    this.el('toasts').appendChild(el);
    void el.offsetWidth;
    el.classList.add('show');
    const t = { el, timer: 0 };
    t.timer = setTimeout(() => this.dismissToast(t), ms);
    this.toasts.push(t);
  }

  dismissToast(t) {
    const i = this.toasts.indexOf(t);
    if (i >= 0) this.toasts.splice(i, 1);
    clearTimeout(t.timer);
    t.el.classList.remove('show');
    setTimeout(() => t.el.remove(), 350);
  }

  region(name) {
    const r = this.el('region');
    r.textContent = name;
    r.classList.add('show');
    clearTimeout(this.regionTimer);
    this.regionTimer = setTimeout(() => r.classList.remove('show'), 3400);
  }

  // sequential NPC dialogue box; returns true while a conversation is open
  dialog(name, text, hasMore) {
    const d = this.el('dialog');
    if (text === null) {
      // A named caller may close only the conversation it owns. Passing an
      // empty name is an intentional global clear for cinematics/death.
      if (name && this.dialogSpeaker && name !== this.dialogSpeaker) return false;
      d.classList.remove('show');
      this.dialogSpeaker = null;
      return true;
    }
    this.dialogSpeaker = name;
    this.el('dialog-name').textContent = name;
    this.el('dialog-text').textContent = text;
    this.el('dialog-more').textContent = hasMore ? 'E — CONTINUE' : 'E — FAREWELL';
    d.classList.add('show');
    clearTimeout(this.dialogTimer);
    this.dialogTimer = setTimeout(() => {
      d.classList.remove('show');
      if (this.dialogSpeaker === name) this.dialogSpeaker = null;
    }, 14000);
    return true;
  }

  banner(title, sub) {
    const b = this.el('banner');
    this.el('banner-title').textContent = title;
    this.el('banner-sub').textContent = sub;
    b.classList.add('show');
    setTimeout(() => b.classList.remove('show'), 3400);
  }

  // interaction prompt; "E — Label · R — Other" renders keys as styled chips
  prompt(text) {
    const p = this.el('prompt');
    if (!text) {
      if (this.lastPrompt !== null) { this.lastPrompt = null; p.classList.remove('show'); }
      return;
    }
    if (text === this.lastPrompt) return;
    this.lastPrompt = text;
    p.textContent = '';
    const parts = text.split(' · ');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'pr-sep';
        sep.textContent = '·';
        p.appendChild(sep);
      }
      const seg = parts[i];
      const m = seg.indexOf(' — ');
      if (m > 0 && m <= 5) {
        const k = document.createElement('span');
        k.className = 'key';
        k.textContent = seg.slice(0, m);
        p.appendChild(k);
        p.appendChild(document.createTextNode(seg.slice(m + 3)));
      } else {
        p.appendChild(document.createTextNode(seg));
      }
    }
    p.classList.add('show');
  }

  hurtFlash() {
    const v = this.el('vignette');
    v.classList.remove('flash');
    void v.offsetWidth;
    v.classList.add('flash');
  }

  showGameOver() {
    let n = 0;
    for (const s of G.shrines) if (s.active) n++;
    this.el('gameover-beacons').textContent = n > 0
      ? `The valley remembers: ${n} ${n === 1 ? 'beacon burns' : 'beacons burn'}`
      : 'The valley waits in darkness — no beacon burns yet';
    this.el('gameover').classList.add('show');
  }
  hideGameOver() {
    this.el('gameover').classList.remove('show');
  }

  // ---- pause panel -----------------------------------------------------------

  showPause() {
    let sb = 0; for (const s of G.shrines) if (s.active) sb++;
    let tb = 0; for (const t of G.towers) if (t.active) tb++;
    this.el('ps-beacons').textContent = sb + ' / ' + G.shrines.length;
    this.el('ps-towers').textContent = tb + ' / ' + G.towers.length;
    this.el('ps-glim').textContent = G.glimmers;
    this.el('ps-orbs').textContent = G.orbs;
    this.el('ps-gems').textContent = G.gems;
    this.el('ps-hearts').textContent = (G.maxHearts / 4) + ' ♥';
    this.el('ps-stam').textContent = Math.round(G.maxStamina) + ' ◔';
    this.hintIdx = (this.hintIdx + 1) % PAUSE_HINTS.length;
    this.el('pause-hint-line').textContent = PAUSE_HINTS[this.hintIdx];
    this.el('pause').classList.add('show');
  }
  hidePause() {
    this.el('pause').classList.remove('show');
  }

  // ---- full map overlay --------------------------------------------------------

  showMap() {
    if (this.riverLabel === undefined) this.riverLabel = findRiverSpot();
    const cv = this.el('bigmap');
    const ctx = cv.getContext('2d');
    const S = cv.width;
    ctx.clearRect(0, 0, S, S);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.bigImg || this.mapImg, 0, 0, S, S);
    const k = S / 1100;
    const mx = wx => (wx + 550) * k;
    const my = wz => (wz + 550) * k;

    // region names
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = 6;
    ctx.fillStyle = 'rgba(244,236,210,0.92)';
    ctx.font = '600 17px Cinzel, Georgia';
    for (const r of MAP_LABELS) ctx.fillText(r[0], mx(r[1]), my(r[2]));
    if (this.riverLabel) {
      ctx.font = 'italic 15px Georgia';
      ctx.fillStyle = 'rgba(214,240,248,0.9)';
      ctx.fillText("The Serpent's Run", mx(this.riverLabel.x), my(this.riverLabel.z));
    }
    ctx.shadowBlur = 0;

    // towers & beacons — same discovery rules as the minimap
    for (const t of G.towers) {
      const x = mx(t.x), y = my(t.z);
      ctx.fillStyle = t.active ? '#54e8ff' : '#ffb03d';
      ctx.beginPath();
      ctx.moveTo(x, y - 9); ctx.lineTo(x + 7, y + 7); ctx.lineTo(x - 7, y + 7);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#10202a'; ctx.lineWidth = 1.5; ctx.stroke();
    }
    const anyTower = G.towers.some(t => t.active);
    for (const s of G.shrines) {
      if (!s.active && !anyTower) continue;
      const x = mx(s.x), y = my(s.z);
      ctx.fillStyle = s.active ? '#54e8ff' : '#ff9a3d';
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#10202a'; ctx.lineWidth = 1.5; ctx.stroke();
    }

    // player arrow
    const p = G.player.pos;
    ctx.save();
    ctx.translate(mx(p.x), my(p.z));
    ctx.rotate(Math.atan2(Math.sin(G.player.yaw), Math.cos(G.player.yaw)) * -1 + Math.PI);
    ctx.fillStyle = '#ffe066';
    ctx.beginPath();
    ctx.moveTo(0, 10); ctx.lineTo(7, -7); ctx.lineTo(0, -3); ctx.lineTo(-7, -7);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#202020'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.restore();

    const questTarget = this.activeObjective && this.activeObjective.target;
    if (questTarget) {
      const x = mx(questTarget.x), y = my(questTarget.z);
      ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 4);
      ctx.fillStyle = '#ffe066'; ctx.strokeStyle = '#342910'; ctx.lineWidth = 2;
      ctx.fillRect(-6, -6, 12, 12); ctx.strokeRect(-6, -6, 12, 12); ctx.restore();
      ctx.font = '600 12px Cinzel, Georgia'; ctx.fillStyle = '#ffe9b0';
      ctx.textAlign = 'center'; ctx.fillText(questTarget.label || 'ACTIVE QUEST', x, y - 15);
    }

    this.el('map-glim').textContent = '🍃 ' + G.glimmers + ' glimmers found';
    this.el('mapview').classList.add('show');
  }
  hideMap() {
    this.el('mapview').classList.remove('show');
  }

  // ---- counters / clock -------------------------------------------------------

  updateCounters() {
    this.el('c-apples').textContent = G.apples;
    this.el('c-gems').textContent = G.gems;
    this.el('c-orbs').textContent = G.orbs;
    this.el('c-glim').textContent = G.glimmers;
    // clock
    const h = Math.floor(G.dayTime * 24);
    const m = Math.floor((G.dayTime * 24 - h) * 60 / 10) * 10;
    this.el('clock-time').textContent =
      `${((h + 11) % 12) + 1}:${m.toString().padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
    // weather + crimson moon glyphs
    const wx = WX_GLYPH[(G.weather && G.weather.kind) || 'clear'] || WX_GLYPH.clear;
    if (wx !== this.lastWx) { this.lastWx = wx; this.el('wx').textContent = wx; }
    const moon = G.bloodNight ? '☾' : '';
    if (moon !== this.lastMoon) { this.lastMoon = moon; this.el('moon').textContent = moon; }
  }

  // ---- satchel: discovery inventory ---------------------------------------
  // Only item types the hero has actually obtained appear; consumables are
  // clickable (the panel pauses the game and releases the pointer). Icons are
  // real 3D renders of the Blender props, captured once from a tiny renderer.

  renderPropIcons() {
    if (this.propIcons) return;
    try {
      const names = ['apple', 'gem', 'arrow', 'feather', 'mushroom', 'shard', 'gear', 'bow', 'zephyr_pod'];
      const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      r.setSize(96, 96);
      const sc = new THREE.Scene();
      sc.add(new THREE.AmbientLight(0xffffff, 1.5));
      const dl = new THREE.DirectionalLight(0xfff4e0, 2.4);
      dl.position.set(2, 3, 4);
      sc.add(dl);
      const cam = new THREE.PerspectiveCamera(28, 1, 0.01, 20);
      const box = new THREE.Box3(), c = new THREE.Vector3(), sz = new THREE.Vector3();
      const out = {};
      for (const n of names) {
        const g = propInstance(n);
        if (!g) continue;
        sc.add(g);
        box.setFromObject(g);
        box.getCenter(c);
        box.getSize(sz);
        const s = Math.max(sz.x, sz.y, sz.z) * 2.4;
        cam.position.set(c.x + s * 0.55, c.y + s * 0.42, c.z + s * 0.72);
        cam.lookAt(c);
        r.render(sc, cam);
        out[n] = r.domElement.toDataURL();
        sc.remove(g);
      }
      r.dispose();
      if (Object.keys(out).length) this.propIcons = out;
    } catch (e) { /* icons are decoration — emoji fallback covers it */ }
  }

  toggleInventory() {
    this.invOpen = !this.invOpen;
    this.invEl.style.display = this.invOpen ? 'flex' : 'none';
    G.audio.sfx(this.invOpen ? 'ui_open' : 'ui_close');
    if (this.invOpen) {
      G.tut.hints.satchel = true;         // the Wayfarer's satchel lesson
      setPauseReason('inventory', true);  // named ownership composes with map/manual pause
      if (document.pointerLockElement) document.exitPointerLock();
      this.renderPropIcons();
      this.refreshInventory();
    } else {
      setPauseReason('inventory', false);
      // Exiting pointer lock to open the satchel must not silently resume an
      // uncontrollable game. A click on the canvas reacquires and clears this.
      if (G.started && !document.pointerLockElement) setPauseReason('pointer', true);
      G.mouse.dx = 0; G.mouse.dy = 0;
    }
  }

  // full item catalog — discovery-gated; unknown entries simply leave their
  // slots empty until first obtained
  invCatalog() {
    const P = G.player;
    return {
      materials: [
        { key: 'apple', model: 'apple', emoji: '🍎', name: 'APPLE', count: G.apples,
          seen: !!G.seen.apple, use: 'apple', effect: 'Use: eat — restores one heart',
          desc: 'A crisp orchard fruit of the Heartfields. Sweet, cold, and honest.' },
        { key: 'arrow', model: 'arrow', emoji: '➳', name: 'ARROW', count: P ? P.arrows : 0,
          seen: !!G.seen.arrow || (P && P.arrows > 0), effect: 'Loosed by the wind bow',
          desc: 'Straight-flying shafts, fletched with gull feathers from the Sunder Ring.' },
        { key: 'gem', model: 'gem', emoji: '💠', name: 'SKY GEM', count: G.gems,
          seen: !!G.seen.gem, effect: 'A treasure of drowned Aerwyn',
          desc: 'Storm-light, crystallized the night the sky broke. It hums faintly near beacons.' },
        { key: 'orb', emoji: '🔮', name: 'SPIRIT ORB', count: G.orbs,
          seen: G.orbs > 0, effect: 'Four orbs grant a blessing',
          desc: 'The gratitude of an awakened beacon, warm as a held breath.' },
        { key: 'glimmer', emoji: '🍃', name: 'GLIMMER', count: G.glimmers,
          seen: G.glimmers > 0, effect: 'A friend found (' + G.glimmers + ' of ' + GLIMMER_TOTAL + ')',
          desc: 'A giggling forest spirit. It rides in your hood now and criticizes your climbing.' },
        { key: 'feather', model: 'feather', emoji: '🪶', name: 'SWIFT FEATHER', count: G.items.feather,
          seen: !!G.seen.feather, use: 'feather', effect: 'Use: sprint like the wind (30s)',
          desc: 'A plume of the great sky-swallow. It never quite stops moving.' },
        { key: 'mushroom', model: 'mushroom', emoji: '🍄', name: 'HEARTY MUSHROOM', count: G.items.mushroom,
          seen: !!G.seen.mushroom, use: 'mushroom', effect: 'Use: restores ALL hearts',
          desc: 'Smells like warm bread and rain. The boglins guard these jealously.' },
        { key: 'shard', model: 'shard', emoji: '⭐', name: 'STAR SHARD', count: G.items.shard,
          seen: !!G.seen.shard, use: 'shard', effect: 'Use: vigor — stamina surges (60s)',
          desc: 'Fallen starlight, still humming its long high note.' },
        { key: 'gear', model: 'gear', emoji: '⚙️', name: 'ANCIENT GEAR', count: G.items.gear,
          seen: !!G.seen.gear, effect: 'A relic of the sky-works',
          desc: 'A bronze cog from the machines that once held the islands aloft. Somewhere, something misses it.' },
        { key: 'pod', model: 'zephyr_pod', emoji: '🫙', name: 'ZEPHYR POD', count: G.items.pod,
          seen: !!G.seen.pod, use: 'pod', effect: 'Use or G: throw — bursts into an updraft',
          desc: 'A seed pod grown fat on bottled wind. Shake it and it hums like a far-off gale.' },
        { key: 'sigil', model: 'warden_sigil', emoji: '🐍', name: 'THE WARDEN\'S SIGIL', count: G.items.sigil,
          seen: !!G.seen.sigil, effect: 'The ninth pedestal\'s answer',
          desc: 'A small bronze ouroboros, still warm. Eight wardens kept the valley. The ninth was always going to be you.' },
        { key: 'fork', model: 'skysong_fork', emoji: '🎶', name: 'THE SKYSONG FORK', count: G.items.fork,
          seen: !!G.seen.fork, use: 'fork', effect: 'Use: the unfound ring nearby (20s)',
          desc: 'Maerwen\'s tuning fork, verdigris bronze. Struck, it asks the dark a question, and whatever you have not found yet answers — near rings high, far rings low.' },
        { key: 'hushbell', emoji: '🔔', name: 'THE HUSH BELL', count: G.items.hushbell,
          seen: !!G.seen.hushbell, use: 'hushbell', effect: 'Use: the world slows 8s — you don\'t',
          desc: 'A small bell with no clapper. Ring it anyway. The valley leans in to listen, and for a few long breaths, everything but you moves like it is remembering how.' },
        { key: 'berry', model: 'bramble_berries', emoji: '🫐', name: 'BRAMBLE-BERRIES', count: G.items.berry,
          seen: !!G.seen.berry, effect: 'For the simmerpot',
          desc: 'Sharp-sweet and staining. The Thornwood thickets guard them with every thorn they have, which is not enough.' },
        { key: 'stormcap', model: 'stormcap', emoji: '🍄', name: 'STORMCAP', count: G.items.stormcap,
          seen: !!G.seen.stormcap, effect: 'For the simmerpot',
          desc: 'A squat blue mushroom that only fruits after honest rain. It tastes like the smell before thunder.' },
        { key: 'reedheart', model: 'reed_heart', emoji: '🌾', name: 'REED-HEART', count: G.items.reedheart,
          seen: !!G.seen.reedheart, effect: 'For the simmerpot',
          desc: 'The pale sweet core of a river reed. Piet used to eat these on his routes; three of his letters mention it.' },
      ],
      gear: [
        { key: 'bow', model: 'bow', emoji: '🏹', name: 'WIND BOW', count: -1, seen: true,
          effect: 'Hold RIGHT MOUSE to draw · click to loose',
          desc: 'A traveler\'s recurve strung with braided glider-silk.' },
        { key: 'sword', emoji: '⚔️', name: "TRAVELER'S SWORD", count: -1, seen: true,
          effect: 'Click or J — a three-swing combo',
          desc: 'Nicked, honest steel. The third swing knocks boglins flat.' },
        { key: 'shield', emoji: '🛡️', name: 'ROUND SHIELD', count: -1, seen: true,
          effect: 'Carried on your back',
          desc: 'It has stopped exactly one club so far, and it is very proud.' },
        { key: 'glider', emoji: '☂️', name: 'PARAGLIDER', count: -1, seen: true,
          effect: 'Hold SPACE in the air · W dives, S floats',
          desc: 'Maren\'s parting gift. The wind does the rest.' },
        { key: 'stormcloth', emoji: '🪂', name: 'STORMCLOTH GLIDER', count: -1, seen: !!G.equip.stormcloth,
          effect: 'Golem-forged: gliding drains far less stamina',
          desc: 'Canopy silk rewoven with storm-thread by a construct\'s patient hands.' },
        { key: 'barkgrip', emoji: '🧤', name: 'BARKGRIP GAUNTLETS', count: -1, seen: !!G.equip.barkgrip,
          effect: 'Golem-forged: climbing costs far less stamina',
          desc: 'Bronze-jointed gloves that hold stone the way roots do.' },
        { key: 'quiver', emoji: '🏹', name: 'DEEP QUIVER', count: -1, seen: !!G.equip.quiver,
          effect: 'Golem-forged: arrow caches yield double',
          desc: 'It is larger on the inside. The golem would not explain.' },
      ],
    };
  }

  refreshInventory() {
    const icons = this.propIcons || {};
    this.invGems.textContent = '💠 ' + G.gems;
    // tabs
    this.invTabs.innerHTML = '';
    for (const tab of ['materials', 'gear', 'log', 'chronicle', 'deeds']) {
      const b = document.createElement('div');
      const on = this.invTab === tab;
      b.textContent = tab.toUpperCase();
      b.style.cssText =
        'padding:5px 18px;border-radius:8px;font-size:12px;letter-spacing:2px;cursor:pointer;' +
        (on ? 'background:rgba(226,203,141,.18);border:1px solid rgba(226,203,141,.6);color:#ffe9a0;'
            : 'background:rgba(226,203,141,.05);border:1px solid rgba(226,203,141,.2);color:#b8ac8c;');
      b.onclick = () => { this.invTab = tab; this.invSel = null; this.refreshInventory(); };
      this.invTabs.appendChild(b);
    }
    // adventure log: region + story progress instead of the slot grid
    if (this.invTab === 'log') {
      const row = (name, val) =>
        `<div style="display:flex;justify-content:space-between;padding:7px 4px;` +
        `border-bottom:1px solid rgba(226,203,141,.15);font-family:Georgia;font-size:14px">` +
        `<span style="color:#cfc4a6">${name}</span><span style="color:#ffe066">${val}</span></div>`;
      const quests = getQuestLog();
      let questHtml = '<div style="margin-top:12px;font-size:11px;letter-spacing:2px;color:#9a8f74">QUESTS</div>';
      for (const q of quests) {
        const prog = q.progress ? ` · ${q.progress.current}/${q.progress.total}` : '';
        questHtml += `<div data-quest-id="${q.id}" style="padding:9px 7px;margin-top:5px;border-radius:7px;cursor:${q.status === 'active' ? 'pointer' : 'default'};` +
          `border:1px solid ${q.active ? 'rgba(255,224,102,.7)' : 'rgba(226,203,141,.18)'};` +
          `background:${q.active ? 'rgba(255,224,102,.08)' : 'rgba(226,203,141,.035)'}">` +
          `<div style="display:flex;justify-content:space-between;font-size:13px;color:${q.status === 'completed' ? '#9fffb0' : '#ffe066'}">` +
          `<span>${q.kind === 'main' ? '◆ ' : '◇ '}${q.title}</span><span>${q.status === 'completed' ? 'COMPLETE' : q.active ? 'ACTIVE' : ''}</span></div>` +
          `<div style="font:13px Georgia;color:#cfc4a6;margin-top:3px">${q.stageTitle}${prog}</div>` +
          `<div style="font:12px Georgia;color:#8f8875;margin-top:2px;line-height:1.35">${q.objective}</div></div>`;
      }
      this.invGrid.innerHTML =
        '<div style="grid-column:1/-1;height:363px;overflow-y:auto;padding-right:5px">' +
        row('Beacons awakened', G.shrines.filter(s => s.active).length + ' / 8') +
        row('Skywatch towers charted', G.towers.filter(t => t.active).length + ' / 3') +
        row('Glimmers found', G.glimmers + ' / ' + GLIMMER_TOTAL) +
        questHtml + '</div>';
      for (const node of this.invGrid.querySelectorAll('[data-quest-id]')) {
        node.onclick = () => {
          if (setActiveQuest(node.dataset.questId)) this.refreshInventory();
        };
      }
      this.invDetail.innerHTML =
        '<div style="margin-top:95px;color:#9a8f74;font-family:Georgia;font-size:13px;line-height:1.65">' +
        'Select an unfinished quest to track it.<br><br>The gold diamond appears on the compass, minimap, and charted map. ' +
        'Some mysteries must still be followed by ear, weather, or memory.</div>';
      return;
    }
    // the Chronicle: every fragment of the valley's memory found so far
    if (this.invTab === 'chronicle') {
      const found = CHRONICLE.filter(c => G.lore[c.id]).length;
      let html = '<div style="grid-column:1/-1;height:363px;overflow-y:auto">' +
        `<div style="font-family:Georgia;font-size:12px;color:#9a8f74;padding:2px 4px 10px">` +
        `The valley’s memory, recovered piece by piece — ${found} of ${CHRONICLE.length} pages</div>`;
      for (const c of CHRONICLE) {
        if (G.lore[c.id]) {
          html += `<div style="padding:8px 4px;border-bottom:1px solid rgba(226,203,141,.15)">` +
            `<div style="font-size:13px;letter-spacing:1px;color:#ffe066;font-family:Georgia">${c.title}</div>` +
            `<div style="font-size:13px;color:#cfc4a6;font-family:Georgia;line-height:1.5;margin-top:3px">${c.text}</div></div>`;
        } else {
          html += `<div style="padding:8px 4px;border-bottom:1px solid rgba(226,203,141,.08);` +
            `font-family:Georgia;font-size:13px;color:#5f5843;font-style:italic">— an unwritten page —</div>`;
        }
      }
      this.invGrid.innerHTML = html + '</div>';
      this.invDetail.innerHTML =
        '<div style="margin-top:120px;color:#9a8f74;font-family:Georgia;font-size:13px;line-height:1.6">' +
        'Hollow stones hum where the old things stand.<br>Echoes walk at the vaults by night.<br>' +
        'And something is tumbling in the updrafts.</div>';
      return;
    }
    // deed-stars: the Wayfarer constellation, verse by verse
    if (this.invTab === 'deeds') {
      const lit = DEEDS.filter(d => G.deeds[d.id]).length;
      let html = '<div style="grid-column:1/-1;height:363px;overflow-y:auto">' +
        `<div style="font-family:Georgia;font-size:12px;color:#9a8f74;padding:2px 4px 10px">` +
        `Deeds kindle stars in the night sky — ${lit} of ${DEEDS.length} burn in the Wayfarer</div>`;
      for (const d of DEEDS) {
        const on = !!G.deeds[d.id];
        html += `<div style="display:flex;gap:10px;align-items:baseline;padding:7px 4px;` +
          `border-bottom:1px solid rgba(226,203,141,.12)">` +
          `<span style="font-size:15px;color:${on ? '#ffd9a0' : '#4a4436'}">${on ? '★' : '✧'}</span>` +
          `<span style="font-family:Georgia;font-size:14px;letter-spacing:1px;color:${on ? '#ffe066' : '#6a6250'}">` +
          `${on ? '“' + d.verse + '”' : '· · ·'}</span>` +
          `<span style="font-family:Georgia;font-size:12px;color:${on ? '#cfc4a6' : '#7a7158'};margin-left:auto;text-align:right">${d.hint}</span></div>`;
      }
      this.invGrid.innerHTML = html + '</div>';
      this.invDetail.innerHTML =
        '<div style="margin-top:120px;color:#9a8f74;font-family:Georgia;font-size:13px;line-height:1.6">' +
        'On clear nights, look north and high.<br>Your legend is being drawn up there,<br>one star at a time.</div>';
      return;
    }
    // slot grid: fixed 5x4, discovery-gated items first, the rest empty
    const items = this.invCatalog()[this.invTab].filter(it => it.seen);
    if (this.invSel && !items.some(it => it.key === this.invSel)) this.invSel = null;
    this.invGrid.innerHTML = '';
    for (let i = 0; i < 20; i++) {
      const it = items[i];
      const slot = document.createElement('div');
      const sel = it && this.invSel === it.key;
      slot.style.cssText =
        'border-radius:9px;position:relative;display:flex;align-items:center;justify-content:center;' +
        (it ? 'cursor:pointer;background:rgba(226,203,141,.08);' : 'background:rgba(226,203,141,.03);') +
        (sel ? 'border:2px solid #ffe066;box-shadow:0 0 14px rgba(255,224,102,.35);'
             : 'border:1px solid rgba(226,203,141,' + (it ? '.3' : '.12') + ');');
      if (it) {
        slot.innerHTML = (icons[it.model]
          ? `<img src="${icons[it.model]}" width="62" height="62">`
          : `<div style="font-size:34px">${it.emoji}</div>`) +
          (it.count >= 0
            ? `<div style="position:absolute;right:5px;bottom:3px;font-size:12px;color:#ffe066;` +
              `font-family:Georgia;text-shadow:0 1px 2px #000">×${it.count}</div>` : '');
        slot.onclick = () => { this.invSel = it.key; this.refreshInventory(); };
      }
      this.invGrid.appendChild(slot);
    }
    // detail panel
    const it = items.find(x => x.key === this.invSel);
    if (!it) {
      this.invDetail.innerHTML =
        '<div style="margin-top:140px;color:#9a8f74;font-family:Georgia;font-size:13px">' +
        'Select an item to inspect it.</div>';
      return;
    }
    this.invDetail.innerHTML =
      '<div style="height:120px;display:flex;align-items:center;justify-content:center">' +
      (icons[it.model] ? `<img src="${icons[it.model]}" width="110" height="110">`
                       : `<div style="font-size:64px">${it.emoji}</div>`) + '</div>' +
      `<div style="font-size:17px;letter-spacing:3px;margin-top:6px">${it.name}</div>` +
      (it.count >= 0 ? `<div style="font-size:13px;color:#ffe066;font-family:Georgia">held: ${it.count}</div>` : '') +
      '<div style="height:1px;background:linear-gradient(90deg,transparent,rgba(226,203,141,.5),transparent);margin:12px 0"></div>' +
      `<div style="font-size:13px;color:#cfc4a6;font-family:Georgia;line-height:1.5">${it.desc}</div>` +
      `<div style="font-size:12px;color:#9fd8ff;font-family:Georgia;margin-top:10px">${it.effect}</div>` +
      (it.use && it.count > 0
        ? '<div id="inv-use" style="margin-top:16px;display:inline-block;padding:8px 34px;border-radius:9px;' +
          'background:rgba(159,255,176,.12);border:1px solid rgba(159,255,176,.55);color:#9fffb0;' +
          'letter-spacing:3px;font-size:14px;cursor:pointer">USE</div>' : '');
    const useBtn = this.invDetail.querySelector('#inv-use');
    if (useBtn) useBtn.onclick = () => this.useItem(it.key);
  }

  useItem(key) {
    if (key === 'apple') {
      if (G.eatApple) G.eatApple();
    } else if (key === 'feather' && G.items.feather > 0) {
      G.items.feather--;
      G.buffs.swiftUntil = G.time + 30;
      this.toast('The feather dissolves — your stride quickens!', 0x5fd8c0);
      G.audio.sfx('glimmer');
    } else if (key === 'mushroom' && G.items.mushroom > 0) {
      G.items.mushroom--;
      G.hearts = G.maxHearts;
      if (G.player) spawnHealBloom(G.player.pos.x, G.player.pos.y, G.player.pos.z);
      this.toast('Warmth floods back — hearts restored!', 0xff8a9a);
      G.audio.sfx('heart');
    } else if (key === 'fork' && G.items.fork > 0) {
      // a relic, never spent: strike it and listen
      G.buffs.forkUntil = G.time + 20;
      this.toast('The fork rings once — and waits for answers.', 0x9fe8d8);
      G.audio.chord([440, 880], 0.1, 0.08);
    } else if (key === 'hushbell' && G.items.hushbell > 0) {
      if (G.buffs.hushReadyAt > G.time) {
        this.toast('The bell is still remembering its last silence.', 0xcccccc);
        return;
      }
      G.buffs.hushT = 8; // burned in REAL seconds by main.js — the slowed
      G.buffs.hushReadyAt = G.time + 90; // clock must not extend its own silence
      this.toast('The valley leans in to listen.', 0xd8d2ff);
      G.audio.chord([220, 330], 0.07, 1.4);
    } else if (key === 'shard' && G.items.shard > 0) {
      G.items.shard--;
      G.buffs.vigorUntil = G.time + 60;
      this.toast('Starlight hums in your limbs — vigor!', 0xffe066);
      G.audio.sfx('heartup');
    } else if (key === 'pod' && G.items.pod > 0) {
      // can't lob ballistically from a paused menu — close the satchel first,
      // then throw with the live camera (G.throwPod owns the count decrement)
      this.toggleInventory();
      setPauseReason('pointer', false);
      if (G.throwPod) G.throwPod();
      if (!document.pointerLockElement) setPauseReason('pointer', true);
      return; // toggleInventory already refreshed/closed the panel
    }
    save();
    this.refreshInventory();
  }

  update(dt) {
    this.drawHearts();
    this.drawStamina(dt);
    this.drawMap();
    this.drawCompass();
    this.updateCounters();
    this.updateObjective();
    // bow crosshair
    const aiming = G.player && G.player.aiming;
    this.aimEl.style.display = aiming ? 'block' : 'none';
    if (aiming) this.arrowCtEl.textContent = G.player.arrows;
    // satchel button appears with the rest of the HUD; counts stay live
    if (G.started && this.bagBtn.style.display === 'none') this.bagBtn.style.display = 'flex';
    if (this.invOpen) this.refreshInventory();
  }
}
