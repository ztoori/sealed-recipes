/**
 * The guided demo film: what it says, when, and where the camera looks. Everything on screen is drawn in code
 * (DemoFilm.tsx), so the film is a few kilobytes and stays sharp at any size; this file is its screenplay.
 *
 * Times are seconds of film at normal speed. Each beat is one spoken line: the caption shows it, and an optional
 * narration clip (scripts/film-voice.ts → web/public/assets/film/) speaks it. Keep every line short enough to say
 * in its beat at a calm pace: about 2.4 words a second (scripts/film-voice.ts checks the real clip lengths).
 */

export interface Beat { id: string; at: number; text: string; cue?: Cue }
export type Cue = 'heartbeat' | 'deny' | 'impact' | 'seal' | 'whoosh' | 'type' | 'lock' | 'ticks' | 'chime' | 'coin' | 'dive' | 'pings' | 'hush' | 'unlock' | 'register' | 'success' | 'drop' | 'glitch' | 'resolve';

export const CHAPTERS = [
  { id: 'problem', label: 'The problem', a: 0, b: 20 },
  { id: 'twist', label: 'The box', a: 20, b: 31 },
  { id: 'pick', label: 'Pick', a: 31, b: 43 },
  { id: 'seal', label: 'Seal & quote', a: 43, b: 63 },
  { id: 'pay', label: 'Pay', a: 63, b: 73 },
  { id: 'run', label: 'Run', a: 73, b: 90 },
  { id: 'paid', label: 'Result', a: 90, b: 106 },
  { id: 'proof', label: 'Proof', a: 106, b: 117 },
  { id: 'agents', label: 'Agents', a: 117, b: 148 },
  { id: 'end', label: 'Your turn', a: 148, b: 157 },
] as const;
export type ChapterId = (typeof CHAPTERS)[number]['id'];
export const END = 157;

export const BEATS: Beat[] = [
  { id: 'b01', at: 0.4, text: 'You’ve got a wallet worth protecting.', cue: 'heartbeat' },
  { id: 'b02', at: 4.4, text: 'And somewhere, an expert knows exactly how to check it.' },
  { id: 'b03', at: 9.0, text: 'Here’s the catch: neither of you can trust the other.', cue: 'heartbeat' },
  { id: 'b04', at: 13.6, text: 'Show your wallet, you’re exposed. Show the method, it’s copied.', cue: 'deny' },
  { id: 'b05', at: 20.2, text: 'So we built a box nobody can open. Not you, not them, not even us.', cue: 'impact' },
  { id: 'b06', at: 26.6, text: 'It’s called a sealed recipe.', cue: 'seal' },
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
  { id: 'b21', at: 106.4, text: 'Don’t take our word for it. Every claim checks out, live.', cue: 'success' },
  { id: 'b22', at: 112.2, text: 'But here’s what you didn’t see coming…', cue: 'drop' },
  { id: 'b23', at: 117.2, text: 'The buyer doesn’t have to be a person.', cue: 'glitch' },
  { id: 'b24', at: 121.4, text: 'An AI agent reads the listings, checks the hardware, and seals its inputs.', cue: 'type' },
  { id: 'b25', at: 128.4, text: 'It asks three recipes for signed quotes. Its own rules pick one.', cue: 'ticks' },
  { id: 'b26', at: 135.4, text: 'It pays, and checks every signature before it trusts the answer.', cue: 'coin' },
  { id: 'b27', at: 142.6, text: 'No account manager. No API key. No trust needed.' },
  { id: 'b28', at: 148.2, text: 'Your data stays yours. Their method stays theirs. Everyone gets paid.', cue: 'resolve' },
  { id: 'b29', at: 153.6, text: 'Try a recipe, live on NEAR testnet.' },
];
/** the beat being spoken at t, and how far into it */
export const beatAt = (t: number) => { let i = -1; for (let k = 0; k < BEATS.length; k++) if (t >= BEATS[k].at) i = k; return i < 0 ? null : { beat: BEATS[i], i, end: BEATS[i + 1]?.at ?? END }; };

/**
 * The camera, over the "world": four app screens laid out on a 2000 × 1180 canvas (DemoFilm.tsx, WX). Inside an app
 * window the page starts 32 px below the window's top (its title bar): the y values below include it.
 * A key frame says where the camera looks (centre x, y) and how close (z: 1 = one world pixel per stage pixel),
 * reached at t after a `move`-second glide; between key frames it holds and drifts in slowly (Ken Burns).
 */
export interface Key { t: number; x: number; y: number; z: number; move?: number }
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
