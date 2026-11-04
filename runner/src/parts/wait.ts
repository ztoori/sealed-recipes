import type { PartHandler } from '../types.js';

/**
 * Holds a workflow for `seconds`, then passes the holdings through. Durable: the deadline is saved before waiting,
 * so a runner that restarts resumes the remaining wait instead of starting over. Waiting is excluded from max_ms.
 * In quote mode it returns at once (quotes price the whole workflow now).
 */
export const wait: PartHandler = async (inputs, ctx) => {
  if (ctx.mode === 'quote') return { holdings: inputs.holdings };
  const seconds = Number(ctx.params.seconds ?? 0);
  if (!(seconds >= 0) || seconds > 30 * 86_400) throw new Error('seconds must be between 0 and 30 days');
  const saved = ctx.resumeState as { until: number } | undefined;
  const until = saved?.until ?? Date.now() + seconds * 1000;
  if (!saved) await ctx.saveState({ until });
  const left = Math.max(0, until - Date.now());
  ctx.log(saved ? `resumed: ${Math.ceil(left / 1000)} s of the wait left` : `waiting ${seconds} s before the next stage`);
  await ctx.wait(left);
  ctx.log('wait finished');
  return { holdings: inputs.holdings };
};
