/**
 * The demo story as an explicit state machine. `run` increments every time the story starts, so each page can tell a
 * fresh run from one it already automated (replaying the story works). Steps only move forward through `advance(from)`,
 * which ignores stale calls from a step that already ended.
 */
/** 0 idle · 1 compose · 2 find + quote · 3 run · 4 settle · 5 price · 6 proof · 7 your turn · 8 done */
export type StoryStep = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export const STORY_LAST = 7;
export interface StoryState { run: number; step: StoryStep }
export type StoryEvent = { type: 'start' } | { type: 'advance'; from: StoryStep } | { type: 'stop' };
export function storyReducer(s: StoryState, e: StoryEvent): StoryState {
  switch (e.type) {
    case 'start': return { run: s.run + 1, step: 1 };
    case 'advance': return s.step === e.from && s.step >= 1 && s.step <= STORY_LAST ? { ...s, step: (s.step + 1) as StoryStep } : s;
    case 'stop': return { ...s, step: 0 };
  }
}
