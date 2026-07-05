// Tutorial: a quest-style checklist that teaches the core verbs one at a
// time (advancing only when the player actually performs each), plus
// one-time contextual hints the first time a traversal mode kicks in.
// Everything persists via G.tut in the save.
import { G, save } from './state.js';

const STEPS = [
  { key: 'move', label: 'Walk with W A S D', test: (P) => P.moveInput > 0 },
  { key: 'sprint', label: 'Hold SHIFT to sprint', test: (P) => P.sprinting },
  { key: 'jump', label: 'Press SPACE to jump', test: (P) => P.mode === 'air' && P.vel.y > 2 },
  { key: 'attack', label: 'Click (or J) to swing your sword', test: (P) => P.attackT >= 0 },
  { key: 'bow', label: 'Hold RIGHT MOUSE to draw the bow', test: (P) => P.aiming },
  // completes via the flag ui.js sets on open — the satchel pauses the sim,
  // so testing invOpen directly could never be sampled while it was true
  { key: 'satchel', label: 'Press I to open your satchel', test: () => !!G.tut.hints.satchel },
];

const HINTS = {
  climb: 'You grabbed the rock! W climbs, SPACE leaps off — watch your stamina.',
  glide: 'The paraglider! Keep SPACE held; W dives, S floats gently.',
  swim: 'Swimming drains stamina — reach the shore before it empties!',
  updraft: 'An updraft! Open the paraglider inside it to soar.',
};

let el = null, stepIdx = 0, holdT = 0, flashT = 0;

export function initTutorial() {
  if (G.tut.done) return;
  el = document.createElement('div');
  el.style.cssText =
    'position:fixed;left:16px;top:130px;z-index:35;pointer-events:none;' +
    'background:rgba(14,16,22,.62);border:1px solid rgba(226,203,141,.35);' +
    'border-radius:10px;padding:10px 16px;font-family:Cinzel,Georgia,serif;' +
    'color:#f0e6c8;font-size:13px;letter-spacing:.5px;max-width:250px;' +
    'box-shadow:0 2px 10px rgba(0,0,0,.4);transition:opacity .6s;';
  document.body.appendChild(el);
  renderStep();
}

function renderStep() {
  if (!el) return;
  const s = STEPS[stepIdx];
  el.innerHTML =
    '<div style="font-size:10px;color:#b8ac8c;letter-spacing:2px">' +
    `THE WAYFARER'S LESSONS · ${stepIdx + 1}/${STEPS.length}</div>` +
    `<div style="margin-top:4px">${s.label}</div>`;
}

export function updateTutorial(dt) {
  const P = G.player;
  // contextual one-time hints fire regardless of checklist progress
  for (const mode of ['climb', 'glide', 'swim']) {
    if (P.mode === mode && !G.tut.hints[mode]) {
      G.tut.hints[mode] = true;
      G.ui.toast(HINTS[mode], 0xbfe8ff, 5200);
      save();
    }
  }
  if (P.inUpdraft && !G.tut.hints.updraft) {
    G.tut.hints.updraft = true;
    G.ui.toast(HINTS.updraft, 0xbfe8ff, 5200);
    save();
  }

  if (G.tut.done) { // belt & braces: never leave a stale panel behind
    if (el) { el.remove(); el = null; }
    return;
  }
  if (!el) return;
  // the lessons panel steps aside while a cutscene owns the screen
  el.style.display = G.cinematic ? 'none' : 'block';
  if (G.cinematic) return;
  if (flashT > 0) { // brief "✓" beat between steps
    flashT -= dt;
    if (flashT <= 0) {
      stepIdx++;
      if (stepIdx >= STEPS.length) {
        G.tut.done = true;
        el.style.opacity = '0';
        const dead = el;
        setTimeout(() => dead.remove(), 800);
        el = null;
        G.ui.toast('Lessons complete — the wilds are yours. Seek the beacons!', 0xffe9a0, 5200);
        save();
      } else renderStep();
    }
    return;
  }
  const s = STEPS[stepIdx];
  if (s.test(P)) {
    holdT += dt;
    if (holdT > (s.key === 'move' ? 0.8 : 0.05)) { // move needs a real stroll
      holdT = 0;
      flashT = 0.9;
      el.innerHTML =
        '<div style="font-size:10px;color:#b8ac8c;letter-spacing:2px">' +
        `THE WAYFARER'S LESSONS · ${stepIdx + 1}/${STEPS.length}</div>` +
        `<div style="margin-top:4px;color:#9fffb0">✓ ${s.label}</div>`;
      G.audio.sfx('lock');
    }
  } else holdT = 0;
}
