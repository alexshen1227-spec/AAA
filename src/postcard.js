// Postcards — a quiet place to stand and look.
//
// Press C and the interface falls away: two soft letterbox bars, the name of
// wherever you are, and the wind. Press C again to keep the moment — a line
// in the Wanderer's Journal, "stood a while at [place]" — or Escape to just
// let it go. It saves no image and calls nothing outside the game. The
// reward is the standing still, and the sentence you find later.
import { G } from './state.js';
import { addPostcard } from './journal.js';

let framing = false;
let els = null;
let hidden = [];

function build() {
  const bar = (side) => {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:0;right:0;height:0;background:#000;' +
      side + ':0;z-index:48;transition:height .7s ease;pointer-events:none;';
    document.body.appendChild(d);
    return d;
  };
  const name = document.createElement('div');
  name.style.cssText = 'position:fixed;left:0;right:0;bottom:9vh;text-align:center;' +
    'font:600 22px Cinzel,Georgia;letter-spacing:5px;color:#f0e6c8;z-index:49;' +
    'text-shadow:0 2px 16px rgba(0,0,0,.8);opacity:0;transition:opacity .9s ease;' +
    'pointer-events:none';
  document.body.appendChild(name);
  const hint = document.createElement('div');
  hint.style.cssText = 'position:fixed;right:22px;bottom:3vh;z-index:49;' +
    'font:600 12px Cinzel,Georgia;letter-spacing:2px;color:#b8ac8c;opacity:0;' +
    'transition:opacity .9s ease;pointer-events:none';
  hint.textContent = 'C — keep this  ·  ESC — let it go';
  document.body.appendChild(hint);
  els = { top: bar('top'), bot: bar('bottom'), name, hint };
}

function placeName() {
  return (G.region || 'The Wilds of Aerwyn').toUpperCase();
}

function enter() {
  if (!els) build();
  framing = true;
  els.top.style.height = els.bot.style.height = '11vh';
  els.name.textContent = placeName();
  els.name.style.opacity = '1';
  els.hint.style.opacity = '1';
  // the HUD falls away
  hidden = [];
  for (const el of document.querySelectorAll('.hud')) {
    if (el.style.visibility !== 'hidden') { hidden.push(el); el.style.visibility = 'hidden'; }
  }
  if (G.audio) G.audio.sfx('ui_open');
}

function leave(kept) {
  framing = false;
  if (els) {
    els.top.style.height = els.bot.style.height = '0';
    els.name.style.opacity = '0';
    els.hint.style.opacity = '0';
  }
  for (const el of hidden) el.style.visibility = '';
  hidden = [];
  if (kept) {
    addPostcard(G.region || 'the wilds of Aerwyn'); // proper-cased, as the land is named
    if (G.ui) G.ui.toast('Kept. The journal will remember this place.', 0xf0e6c8, 3600);
    if (G.audio) G.audio.sfx('glimmer');
  } else if (G.audio) {
    G.audio.sfx('ui_close');
  }
}

// C toggles: open the frame, or (if framing) keep the moment
export function togglePostcard() {
  if (!G.started || G.gameOver || G.cinematic || G.paused) return;
  if (G.ui && (G.ui.invOpen)) return; // not over a menu
  if (framing) leave(true); else enter();
}

// Escape while framing lets the moment go without keeping it
export function cancelPostcard() {
  if (framing) { leave(false); return true; }
  return false;
}

export function isFraming() { return framing; }

// keep the place-name current if the player drifts across a border while framing
export function updatePostcard() {
  if (framing && els) {
    const n = placeName();
    if (els.name.textContent !== n) els.name.textContent = n;
  }
}
