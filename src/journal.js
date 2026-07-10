// The Wanderer's Journal — a diary the wayfarer keeps without meaning to.
//
// Each beat of the journey writes one wistful line, in the game's own voice,
// stamped with the in-game day. It is never announced: no toast, no chime,
// no "+1 memory". You find it later, in the satchel, the way you find a page
// you don't remember writing. One line per beat, silent, forever.
import { G, save } from './state.js';

const isObj = v => !!v && typeof v === 'object';
const flag = id => !!(isObj(G.story) && isObj(G.story.flags) && G.story.flags[id]);
const lore = id => !!(isObj(G.lore) && G.lore[id]);
const deed = id => !!(isObj(G.deeds) && G.deeds[id]);
const region = name => !!(isObj(G.regionsSeen) && G.regionsSeen[name]);
const beacons = () => (G.shrines || []).filter(s => s && s.active).length;
const towers = () => (G.towers || []).filter(t => t && t.active).length;

// Ordered beats. Each: id (stable, saved), test(), text (the line written).
// Kept in a rough story order so a burst of unlocks reads chronologically.
const BEATS = [
  { id: 'wake', test: () => flag('openingDone') || (G.tut && G.tut.openingDone),
    text: 'I woke in a meadow with no memory and a grey man who called me wanderer. The sky was broken above us. He did not seem surprised that I was.' },
  { id: 'firstbeacon', test: () => beacons() >= 1,
    text: 'I woke the first beacon and the light knew me — leaned toward me like it had been waiting. I do not know for how long. It felt like an apology I was owed.' },
  { id: 'r_heartfields', test: () => region('The Heartfields'),
    text: 'The Heartfields, they call this green middle of the world. Apples and quiet. You would not know the sky had ever fallen here, if you did not look up.' },
  { id: 'r_mirrormere', test: () => region('Mirrormere'),
    text: 'Mirrormere holds the whole sky on its back and does not spill a drop. I stood at the shore a long time. The lake was patient about it.' },
  { id: 'r_thornwood', test: () => region('Thornwood'),
    text: 'The Thornwood keeps its gold late into the cold. Every leaf that falls seems to have been named first. I keep expecting to be introduced.' },
  { id: 'r_stormridge', test: () => region('Stormridge Massif'),
    text: 'Stormridge is all teeth and cold crystal. The wind up here does not push — it leans, like it wants to tell you something and has forgotten how.' },
  { id: 'lanterns', test: () => flag('lanternsReported'),
    text: 'Ilyra\'s five lanterns burn again, and the lake laid down a road of moonlight to prove it remembered. Some roads are made of stone. That one is made of being seen.' },
  { id: 'chimes', test: () => flag('chimesResolved'),
    text: 'Three bronze rings, three far summits, one wind. I carried the note between them and the whole high country sang it back. I did not know the mountains had been waiting to be asked.' },
  { id: 'hart', test: () => lore('hartDone'),
    text: 'A white hart waited at dawn and did not run. It led me to a glade where a forgotten shrine woke — for it, not for me. That felt exactly right.' },
  { id: 'letters', test: () => lore('lettersLaid'),
    text: 'I caught Piet\'s letters out of the wind and laid them under the gold trees, and told the wind they arrived. It stopped, all of it, everywhere — then turned once around the cairn, like a route being finished.' },
  { id: 'eightbeacons', test: () => beacons() >= 8,
    text: 'All eight beacons burn now. The old network answers itself across the valley at night, a slow conversation of light. I am only the one who struck the matches.' },
  { id: 'threetowers', test: () => towers() >= 3,
    text: 'Three skywatch towers charted, three lost roads traced. From the top of each, the valley looks less like something broken and more like something being mended. By me, I suppose. Strange.' },
  { id: 'gates', test: () => (isObj(G.story) && isObj(G.story.gates) &&
      Object.values(G.story.gates.attuned || {}).filter(Boolean).length >= 2),
    text: 'Both ouroboros gates woke when I carried the wind through them. The serpents that bite their own tails turned, slowly, and something far above began to listen.' },
  { id: 'coil', test: () => flag('coilCompleted'),
    text: 'Eight wardens kept this valley. There was a ninth seat, and it was empty, and it had my shape. Maerwen left a letter for whoever came too late. I am whoever came too late.' },
  { id: 'crystalvigil', test: () => lore('sixthVigil'),
    text: 'I held the Sixth\'s five crystal tones through one cold night and her echo sang with them. The song was never for the crystals. It was for whoever had to keep them next. I am learning what that means.' },
  { id: 'giantspalm', test: () => lore('giantsPalm'),
    text: 'The kneeling giant opened its hand and lifted me the way I would lift a ladybird — with a care so large it felt like weather. From its shoulder I saw the whole valley I had kept. I did not want to come down.' },
  { id: 'shrine', test: () => lore('boglinShrine'),
    text: 'The boglins ring a fallen sky-cog with totems and offerings, deep past the gold trees. They did not loot it. They knelt to it. Whatever broke the sky, the moss-kin grieve it too. I did not expect that of them.' },
  { id: 'drift', test: () => flag('driftCrossed'),
    text: 'I walked the sky-road, isle to isle, on nothing but glider and patience. A stone up there said the road is not the isles — it is the letting go between them. I am getting better at the letting go.' },
  { id: 'finale', test: () => flag('finaleCompleted'),
    text: 'The hundred-year storm is still. I did not fight it; I heard it out, and then I closed the circle, and it let go the breath it had been holding since before I was born. The valley of Aerwyn — kept. The wind remembers.' },
];

let built = false;

function logged() {
  if (!Array.isArray(G.journal)) G.journal = [];
  return G.journal;
}

export function updateJournal() {
  if (!G.started) return;
  const entries = logged();
  const have = new Set(entries.map(e => e.id));
  // First tick on a loaded save: any beat already satisfied by pre-journal
  // progress is backfilled silently at day 0, so an old deed reads "Day 1"
  // (the beginning) instead of being stamped with today's date. New beats
  // that fire during live play still get the current day, one per tick.
  const stampDay = built ? (Number.isFinite(G.dayCount) ? G.dayCount : 0) : 0;
  let wrote = false;
  for (const beat of BEATS) {
    if (have.has(beat.id)) continue;
    let ok = false;
    try { ok = !!beat.test(); } catch (e) { ok = false; }
    if (!ok) continue;
    entries.push({ d: stampDay, id: beat.id });
    have.add(beat.id);
    wrote = true;
    if (built) break; // in play, one line per tick — the diary fills a page at a time
  }
  built = true; // subsequent ticks stamp the real day and write one at a time
  if (wrote) { try { save(); } catch (e) { /* best effort */ } }
}

// Postcards write a free-text line the beats don't cover: "stood a while at
// [place]". Stored with id 'pc' and the line carried on the entry itself.
export function addPostcard(place) {
  const entries = logged();
  const text = `Stood a while at ${place}. Nothing happened. I wanted to remember it anyway.`;
  entries.push({ d: Number.isFinite(G.dayCount) ? G.dayCount : 0, id: 'pc', text });
  try { save(); } catch (e) { /* best effort */ }
}

// for ui.js: the written pages, in the order they were written
export function getJournal() {
  const byId = {};
  for (const b of BEATS) byId[b.id] = b.text;
  return logged()
    .filter(e => e.id === 'pc' ? typeof e.text === 'string' : byId[e.id])
    .map(e => ({ day: e.d, text: e.id === 'pc' ? e.text : byId[e.id] }));
}
