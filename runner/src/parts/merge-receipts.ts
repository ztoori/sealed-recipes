import type { PartHandler } from '../types.js';

/** Combines two stages' swap receipts so the recipe's value delivered covers the whole workflow. */
export const mergeReceipts: PartHandler = async (inputs, ctx) => {
  const a = (inputs.a as unknown[]) ?? [], b = (inputs.b as unknown[]) ?? [];
  ctx.log(`merged ${a.length} + ${b.length} receipt(s)`);
  return { receipts: [...a, ...b] };
};
