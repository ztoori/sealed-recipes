/** The web app's explicit state machines: navigation, the story, and the Get a quote flow. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoute, routeHash } from '../web/src/route.js';

test('route: every page round-trips through the URL hash', () => {
  for (const h of ['#/', '#/recipes', '#/recipes/CLNP', '#/quote/STAK', '#/compose/recipe', '#/compose/part', '#/compose/part/ai.spam-shield%401.1.0', '#/wallet', '#/docs/standard', '#/docs/trust', '#/docs/landscape']) assert.equal(routeHash(parseRoute(h)), h, h);
  assert.deepEqual(parseRoute(''), { page: 'home' }, 'the landing page is the front door');
  assert.deepEqual(parseRoute('#/nonsense'), { page: 'recipes' });
  assert.deepEqual(parseRoute('#/docs'), { page: 'docs', sub: 'standard' }, 'Documentation opens on the standard');
  assert.deepEqual(parseRoute('#/quote'), { page: 'recipes' }, 'a quote needs a recipe');
});

test('quote flow: inputs edited after a quote drop it; a run in flight cannot be edited, re-paid or re-quoted', async () => {
  const { quoteReducer } = await import('../web/src/pages/quote-machine.js');
  let p: any = { name: 'form' };
  const go = (...acts: any[]) => { for (const a of acts) p = quoteReducer(p, a); return p.name; };
  assert.equal(go({ t: 'quote' }, { t: 'quoted', q: { id: 1 } }), 'quoted');
  assert.equal(go({ t: 'edit' }), 'form', 'editing after a quote drops it (the sealed job no longer matches)');
  assert.equal(go({ t: 'quote' }, { t: 'quoted', q: {} }, { t: 'choose', guaranteed: true }, { t: 'edit' }), 'preparing', 'inputs are locked while preparing payment');
  assert.equal(go({ t: 'prepared', pay: {} }, { t: 'pay' }, { t: 'pay' }), 'paying', 'a second pay is ignored');
  assert.equal(go({ t: 'quote' }, { t: 'edit' }), 'paying');
  assert.equal(go({ t: 'paid' }, { t: 'ended', ok: true }), 'finished');
  assert.equal(go({ t: 'pay' }), 'finished', 'a finished run cannot be paid again');
  assert.equal(go({ t: 'again' }), 'form');
  assert.equal(go({ t: 'quote' }, { t: 'quote_failed' }), 'form');
  assert.equal(go({ t: 'quote' }, { t: 'unquotable', error: 'x' }, { t: 'choose', guaranteed: true }), 'unquotable');
});

test('story: steps only move forward from the step they were called in; replay starts a new run', async () => {
  const { storyReducer } = await import('../web/src/story-machine.js');
  let s = storyReducer({ run: 0, step: 0 }, { type: 'start' });
  assert.deepEqual(s, { run: 1, step: 1 });
  s = storyReducer(s, { type: 'advance', from: 1 }); s = storyReducer(s, { type: 'advance', from: 1 });
  assert.equal(s.step, 2, 'a stale advance from step 1 is ignored');
  for (const f of [2, 3, 4] as const) s = storyReducer(s, { type: 'advance', from: f });
  assert.equal(s.step, 5);
  assert.equal(storyReducer(s, { type: 'advance', from: 5 }).step, 5);
  assert.deepEqual(storyReducer(s, { type: 'start' }), { run: 2, step: 1 });
  assert.equal(storyReducer({ run: 1, step: 3 }, { type: 'stop' }).step, 0);
});
