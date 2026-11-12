/**
 * Playback speed for the recipe films and the demo story, chosen by the viewer and remembered in this browser.
 * 1× is a calm pace; 0.5× halves it, 2× doubles it.
 */
import { useEffect, useReducer } from 'react';

export const SPEEDS = [0.5, 0.75, 1, 1.5, 2] as const;
type Kind = 'film' | 'demo';
const read = (k: Kind) => { try { const v = Number(localStorage.getItem('srs-speed-' + k)); return (SPEEDS as readonly number[]).includes(v) ? v : 1; } catch { return 1; } };
const store: Record<Kind, number> = { film: read('film'), demo: read('demo') };
const subs = new Set<() => void>();

export const getSpeed = (k: Kind) => store[k];
export function setSpeed(k: Kind, v: number) {
  store[k] = v;
  try { localStorage.setItem('srs-speed-' + k, String(v)); } catch { /* storage may be unavailable */ }
  subs.forEach((f) => f());
}
export function useSpeed(k: Kind): [number, (v: number) => void] {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => { subs.add(force); return () => { subs.delete(force); }; }, []);
  return [store[k], (v) => setSpeed(k, v)];
}

/** the demo story's pauses: at 1× they are 1.6 / 0.75 (about 2.13) times the original timings, so each step can be read;
 *  this is what 0.75× used to be. 0.5× and 0.75× slow it further, 1.5× and 2× speed it up. */
export const demoMs = (ms: number) => Math.round((ms * (1.6 / 0.75)) / store.demo);
