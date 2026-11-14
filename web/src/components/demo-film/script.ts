/**
 * The guided demo film: what it says, when, and where the camera looks. Everything on screen is drawn in code
 * (DemoFilm.tsx), so the film is a few kilobytes and stays sharp at any size; this file is its screenplay.
 *
 * Times are seconds of film at normal speed (film seconds: RATE of them pass in one real second). Each beat is one spoken line: the caption shows it, and an optional
 * narration clip (scripts/film-voice.ts → web/public/assets/film/) speaks it. Keep every line short enough to say
 * in its beat at a calm pace: about 3 words a second (scripts/film-voice.ts checks the real clip lengths, and
 * scripts/record-film.mjs relies on every clip ending before the next line starts).
 */

export interface Beat { id: string; at: number; text: string; cue?: Cue }
export type Cue = 'heartbeat' | 'deny' | 'impact' | 'seal' | 'whoosh' | 'type' | 'lock' | 'ticks' | 'chime' | 'coin' | 'dive' | 'pings' | 'hush' | 'unlock' | 'register' | 'success' | 'drop' | 'glitch' | 'resolve';

/**
 * Two cuts of the same film share everything from "The box" on:
 *  - `full`: the guided demo on the site. It opens with the whole story: too many apps and agents to vet, the few who
 *    do the homework and can't sell what they learn, and the market's four seats (users, creators, builders, runners).
 *  - `x`: the cut for an X post, which must stay under 140 s. Its opening tells the same story in four lines, over
 *    the same pictures played faster (INTRO_MAP).
 * Everything after the opening was drawn on one timeline (where "The box" starts at 20 s); a cut plays it `shift`
 * seconds later, so DemoFilm.tsx hands those scenes `t - shift`, and the camera and spotlights below keep their times.
 */
export type CutId = 'full' | 'x';
export interface Chapter { id: string; label: string; a: number; b: number }
/** where the shared scenes start on their own timeline */
const BOX = 20;

const OPENING: Record<CutId, { chapters: Chapter[]; beats: Beat[]; len: number }> = {
  full: {
    len: 56.2,
    chapters: [
      { id: 'toomuch', label: 'Too much', a: 0, b: 16.2 },
      { id: 'edge', label: 'The edge', a: 16.2, b: 32.4 },
      { id: 'market', label: 'The market', a: 32.4, b: 56.2 },
    ],
    beats: [
      { id: 'a01', at: 0.4, text: 'Every week there’s a new app. A new feature. A new agent that swears it can do it all.', cue: 'pings' },
      { id: 'a02', at: 5.4, text: 'Each one comes with rules. Do this. Never do that. Did you read them?', cue: 'whoosh' },
      { id: 'a03', at: 10.3, text: 'Most of us don’t. We find out the hard way: money lost, a scam, a fine.', cue: 'deny' },
      { id: 'a04', at: 16.4, text: 'A few people do the homework.', cue: 'ticks' },
      { id: 'a05', at: 18.5, text: 'They work out which tools to trust, in what order, and what to check. That’s a recipe.' },
      { id: 'a06', at: 23.2, text: 'It’s their edge. So how do they sell it?', cue: 'chime' },
      { id: 'a07', at: 25.8, text: 'Paywalls, copyright, licences. Each one leaks. One copy gets out, and the edge is gone.', cue: 'deny' },
      { id: 'a08', at: 32.6, text: 'Sealed Recipes is a market with a seat for everyone.', cue: 'seal' },
      { id: 'a09', at: 36.2, text: 'Users pick a recipe and pay per run. If the run fails, they get their money back.', cue: 'chime' },
      { id: 'a10', at: 41.6, text: 'Creators compose recipes from parts. No code.', cue: 'chime' },
      { id: 'a11', at: 45.5, text: 'Builders write the parts to an open spec, and earn each time one is used.', cue: 'chime' },
      { id: 'a12', at: 50.2, text: 'Runners bring sealed hardware, and earn on every run.', cue: 'chime' },
      { id: 'a13', at: 54.0, text: 'Here’s how it plays out.', cue: 'coin' },
    ],
  },
  x: {
    len: 18,
    chapters: [{ id: 'story', label: 'The story', a: 0, b: 18 }],
    beats: [
      { id: 'x01', at: 0.4, text: 'A new app, a new agent, every week. Nobody reads the fine print.', cue: 'pings' },
      { id: 'x02', at: 4.5, text: 'Most learn the hard way. A few do the homework, and turn it into a recipe.', cue: 'deny' },
      { id: 'x03', at: 9.1, text: 'But sell a recipe, and it’s copied by morning.', cue: 'deny' },
      { id: 'x04', at: 12.4, text: 'Sealed Recipes fixes that. Users pay per run. Creators, builders and runners get paid.', cue: 'seal' },
    ],
  },
};
/**
 * The opening's pictures are drawn once, on the full cut's clock. The X cut plays stretches of them faster:
 * [from, to] on its own clock shows [v0, v1] of the full opening.
 */
const INTRO_MAP: [number, number, number, number][] = [
  [0, 4.5, 0, 10.3],
  [4.5, 6.1, 10.3, 16.0],
  [6.1, 9.1, 16.4, 23.2],
  [9.1, 12.4, 25.8, 32.3],
  [12.4, 18, 34.5, 56.2],
];

/** from "The box" on, on the shared timeline */
const LATER_CHAPTERS: Chapter[] = [
  { id: 'twist', label: 'The box', a: 20, b: 31 },
  { id: 'pick', label: 'Pick', a: 31, b: 43 },
  { id: 'seal', label: 'Seal & quote', a: 43, b: 63 },
  { id: 'pay', label: 'Pay', a: 63, b: 73 },
  { id: 'run', label: 'Run', a: 73, b: 90 },
  { id: 'paid', label: 'Result', a: 90, b: 106 },
  { id: 'proof', label: 'Proof', a: 106, b: 112 },
  { id: 'agents', label: 'Agents', a: 112, b: 143 },
  { id: 'end', label: 'Your turn', a: 143, b: 152 },
];
const LATER_END = 152;
/** the agents and closing scenes were drawn on a timeline 5 s later; they read the clock shifted by this much */
export const LATE_SHIFT = 5;
/**
 * Film seconds per real second at 1× (the viewer's speed control multiplies it). The narration plays at the same rate,
 * so voice and picture stay together at any speed.
 */
export const RATE = 1.15;
/**
 * A breath before these lines, in real seconds, after the previous line has been spoken in full. Every line also
 * waits for the narrator to finish the one before it (DemoFilm.tsx), so a line never talks over the next.
 */
export const BREATH: Record<string, number> = { b13: 0.9, b27: 1.2 };

const LATER_BEATS: Beat[] = [
  { id: 'b05', at: 20.2, text: 'It all rests on a box nobody can open. Not you, not them, not even us.', cue: 'impact' },
  { id: 'b06', at: 26.6, text: 'Seal a recipe inside, and the method stays secret.', cue: 'seal' },
  { id: 'b07', at: 31.2, text: 'Recipes are expert methods: priced, risk-labelled, with a public track record.', cue: 'whoosh' },
  { id: 'b08', at: 37.6, text: 'What you can’t see is how they work. That stays sealed.' },
  { id: 'b09', at: 43.2, text: 'Pick one, and type the account you want checked.', cue: 'type' },
  { id: 'b10', at: 48.2, text: 'Your browser locks it before it leaves your screen.', cue: 'lock' },
  { id: 'b11', at: 53.8, text: 'Then it checks the sealed hardware with Intel itself.', cue: 'ticks' },
  { id: 'b12', at: 58.8, text: 'A dry run returns a signed price. Nothing has moved yet.', cue: 'chime' },
  { id: 'b13', at: 63.4, text: 'Pay a few cents. The contract holds it in escrow.', cue: 'coin' },
  { id: 'b14', at: 68.4, text: 'If anything goes wrong, you get it back.' },
  { id: 'b15', at: 73.2, text: 'Now the recipe runs, inside the box.', cue: 'dive' },
  { id: 'b16', at: 77.8, text: 'Parts from different builders, each allowed to reach only what it declared.', cue: 'pings' },
  { id: 'b17', at: 84.2, text: 'Nobody can watch. Not us, and not the creator.', cue: 'hush' },
  { id: 'b18', at: 90.2, text: 'The result is locked to your browser. Only you can open it.', cue: 'unlock' },
  { id: 'b19', at: 96.4, text: 'And one receipt pays everyone: builders, runner, creator.', cue: 'register' },
  { id: 'b20', at: 101.6, text: 'Every cent accounted for, on-chain.' },
  { id: 'b21', at: 106.4, text: 'Don’t take our word for it. Check every claim yourself.', cue: 'success' },
  { id: 'b22', at: 112.2, text: 'AI agents can also read the listings, check the hardware, and seal their inputs.', cue: 'glitch' },
  { id: 'b23', at: 123.4, text: 'This one asks three recipes for signed quotes. Its own rules pick one.', cue: 'ticks' },
  { id: 'b24', at: 130.4, text: 'It pays, and checks every signature before it trusts the answer.', cue: 'coin' },
  { id: 'b25', at: 137.0, text: 'No account to create: your own key pays, and nothing moves without its owner’s signature.' },
  { id: 'b26', at: 143.2, text: 'Your data stays yours. Their method stays theirs. And everyone gets paid.', cue: 'resolve' },
  { id: 'b27', at: 148.6, text: 'Try a recipe on NEAR testnet.' },
];

export interface Cut {
  id: CutId;
  chapters: Chapter[];
  beats: Beat[];
  end: number;
  /** the shared scenes play this many seconds later than on their own timeline */
  shift: number;
  /** the opening's picture clock at film time t (see INTRO_MAP) */
  intro: (t: number) => number;
  /** the beat being spoken at t, and when the next one starts */
  beatAt: (t: number) => { beat: Beat; i: number; end: number } | null;
}
function cut(id: CutId): Cut {
  const o = OPENING[id], shift = o.len - BOX;
  const beats = [...o.beats, ...LATER_BEATS.map((b) => ({ ...b, at: +(b.at + shift).toFixed(2) }))];
  const end = LATER_END + shift;
  return {
    id, shift, end, beats,
    chapters: [...o.chapters, ...LATER_CHAPTERS.map((c) => ({ ...c, a: c.a + shift, b: c.b + shift }))],
    intro: id === 'full' ? (t) => t : (t) => {
      const s = INTRO_MAP.find((m) => t < m[1]) ?? INTRO_MAP[INTRO_MAP.length - 1];
      return s[2] + (s[3] - s[2]) * Math.max(0, Math.min(1, (t - s[0]) / (s[1] - s[0])));
    },
    beatAt: (t) => { let i = -1; for (let k = 0; k < beats.length; k++) if (t >= beats[k].at) i = k; return i < 0 ? null : { beat: beats[i], i, end: beats[i + 1]?.at ?? end }; },
  };
}
export const CUTS: Record<CutId, Cut> = { full: cut('full'), x: cut('x') };
/** how long the opening's pictures run on their own clock (the full cut's opening) */
export const INTRO_END = OPENING.full.len;

/**
 * The camera, over the "world": four app screens laid out on a 2000 × 1180 canvas (DemoFilm.tsx, WX). Inside an app
 * window the page starts 32 px below the window's top (its title bar): the y values below include it.
 * A key frame says where the camera looks (centre x, y) and how close (z: 1 = one world pixel per stage pixel),
 * reached at t after a `move`-second glide; between key frames it holds and drifts in slowly (Ken Burns).
 */
export interface Key { t: number; x: number; y: number; z: number; move?: number }
/** camera and spotlight times are on the shared timeline (the film's clock minus the cut's shift) */
export const CAMERA: Key[] = [
  { t: 31.2, x: 1000, y: 590, z: 0.44, move: 0 },
  { t: 34.0, x: 500, y: 310, z: 1.0, move: 2.2 },
  { t: 38.6, x: 500, y: 250, z: 1.08, move: 1.4 },
  { t: 44.4, x: 1500, y: 310, z: 1.0, move: 1.6 },
  { t: 46.0, x: 1291, y: 250, z: 1.6, move: 1.2 },
  { t: 54.6, x: 1291, y: 410, z: 1.42, move: 1.2 },
  { t: 59.6, x: 1712, y: 322, z: 1.42, move: 1.2 },
  { t: 64.0, x: 1712, y: 470, z: 1.42, move: 1.0 },
  { t: 68.6, x: 1500, y: 380, z: 0.9, move: 1.4 },
  { t: 74.4, x: 1000, y: 620, z: 0.52, move: 1.2 },
  { t: 76.0, x: 500, y: 890, z: 1.0, move: 1.4 },
  { t: 79.0, x: 500, y: 905, z: 1.0, move: 1.4 },
  { t: 91.2, x: 1500, y: 890, z: 1.0, move: 1.6 },
  { t: 92.6, x: 1290, y: 915, z: 1.4, move: 1.0 },
  { t: 97.2, x: 1712, y: 950, z: 1.2, move: 1.4 },
  { t: 102.2, x: 1500, y: 925, z: 0.92, move: 1.4 },
];

/** a highlighted region of the world, with a short label beside it */
export interface Spot { a: number; b: number; x: number; y: number; w: number; h: number; label: string; side?: 'above' | 'below' }
export const SPOTS: Spot[] = [
  { a: 38.8, b: 43.0, x: 80, y: 204, w: 840, h: 76, label: 'Price, risk and track record are public. The method is sealed.', side: 'below' },
  { a: 46.4, b: 53.4, x: 1086, y: 204, w: 410, h: 84, label: 'Locked in your browser', side: 'below' },
  { a: 54.9, b: 58.6, x: 1086, y: 350, w: 410, h: 156, label: 'Verified against Intel’s keys, in your browser', side: 'above' },
  { a: 59.9, b: 63.2, x: 1532, y: 194, w: 360, h: 250, label: 'Signed by the sealed hardware', side: 'below' },
  { a: 64.3, b: 68.3, x: 1532, y: 462, w: 360, h: 76, label: 'Held in escrow until the run reports', side: 'above' },
  { a: 79.2, b: 84.0, x: 90, y: 752, w: 820, h: 330, label: 'Each part reaches only its declared services', side: 'above' },
  { a: 92.8, b: 96.2, x: 1090, y: 792, w: 400, h: 250, label: 'Only your browser has the key', side: 'above' },
  { a: 97.4, b: 101.8, x: 1532, y: 802, w: 360, h: 292, label: 'One receipt, every payee', side: 'above' },
];
