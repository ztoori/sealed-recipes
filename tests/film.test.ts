/**
 * The demo film's screenplay (web/src/components/demo-film/script.ts): both cuts are well-formed, the X cut fits an
 * X post, and every spoken line has its narration clip in the repo, short enough for its beat. The recorder
 * (scripts/record-film.mjs) lays each clip at its line's time, so a clip that ran long would talk over the next.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CUTS, RATE } from '../web/src/components/demo-film/script.js';

const FILM = fileURLToPath(new URL('../web/public/assets/film/', import.meta.url));

test('film: both cuts have ordered lines inside ordered, gapless chapters', () => {
  for (const c of Object.values(CUTS)) {
    assert.equal(c.chapters[0].a, 0);
    c.chapters.forEach((ch, i) => { assert.ok(ch.b > ch.a, `${c.id}/${ch.id}`); if (i) assert.equal(ch.a, c.chapters[i - 1].b, `${c.id}/${ch.id} starts where the previous chapter ends`); });
    assert.equal(c.chapters[c.chapters.length - 1].b, c.end);
    c.beats.forEach((b, i) => { if (i) assert.ok(b.at > c.beats[i - 1].at, `${c.id}/${b.id} comes after ${c.beats[i - 1].id}`); assert.ok(b.at < c.end); });
    assert.equal(new Set(c.beats.map((b) => b.id)).size, c.beats.length, `${c.id}: line ids are unique`);
  }
});

test('film: the two cuts tell the same story from "The box" on, and the X cut fits an X post (140 s)', () => {
  const later = (id: 'full' | 'x') => CUTS[id].beats.filter((b) => b.id.startsWith('b')).map((b) => [b.id, b.text, +(b.at - CUTS[id].shift).toFixed(2)]);
  assert.deepEqual(later('x'), later('full'));
  assert.ok(CUTS.x.end / RATE <= 138, `the X cut runs ${(CUTS.x.end / RATE).toFixed(1)} s`);
  assert.ok(CUTS.full.end / RATE < 180, 'the full film stays under three minutes');
  // the X cut's opening shows the full opening's pictures, in order, and reaches their end
  let last = -1; for (let t = 0; t <= 18; t += 0.1) { const v = CUTS.x.intro(t); assert.ok(v >= last); last = v; }
  assert.ok(last > 55);
});

test('film: every line of both cuts has a narration clip in the repo', () => {
  const voice = JSON.parse(readFileSync(FILM + 'voice.json', 'utf8')) as { credit: string; clips: Record<string, string> };
  assert.match(voice.credit, /CC BY 4\.0/, 'the voice is CC BY: its credit travels with the clips');
  for (const c of Object.values(CUTS)) for (const b of c.beats) assert.ok(voice.clips[b.id] && existsSync(FILM + voice.clips[b.id]), `${c.id}/${b.id}: ${b.text}`);
});
