import type { PartHandler, NearTx } from '../types.js';

/**
 * Claims every airdrop an account is eligible for, from a list of distributor contracts, to a fresh address.
 *
 * Distributor interface (the one this part supports; NEAR has no single airdrop standard, so each distributor family
 * needs its own adapter): view `claimable({account_id}) -> {token, amount}` and call `claim({receiver_id})`.
 *  - quote (dry run): reads `claimable` over RPC for each distributor and prices it, so buyers see the value
 *    before paying. Read-only.
 *  - run: the buyer's wallet signs one `claim` per distributor (the runner never holds funds), then the part reads
 *    the recipient's balances on FastNEAR to measure what actually arrived. Delivered = measured on-chain, not trusted.
 * Durable: the eligible list is saved before the approval request, so a restart never asks the buyer twice.
 */
interface Drop { distributor: string; token: string; amount: string }
interface ClaimState { phase: 'approval' | 'submitted'; drops: Drop[]; before: Record<string, string>; txHashes?: string[] }

export const airdropClaim: PartHandler = async (inputs, ctx) => {
  const account = String(inputs.account);
  const to = String(inputs.to);
  const distributors = String(ctx.params.distributors ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!distributors.length) throw new Error('no distributors configured');

  const view = async (contract: string, method: string, args: Record<string, unknown>) => {
    const r = (await ctx.http(ctx.endpoints.rpc, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'srs', method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }),
    }).then((x) => x.json())) as { result?: { result: number[] }; error?: { message?: string } };
    if (!r.result) throw new Error(`${contract}.${method}: ${r.error?.message ?? 'no result'}`);
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result.result)));
  };
  const balances = async (acct: string) => {
    const ft = (await ctx.http(`${ctx.endpoints.fastnear}/v1/account/${acct}/ft`).then((r) => r.json())) as { tokens: { contract_id: string; balance: string }[] };
    return Object.fromEntries(ft.tokens.map((t) => [t.contract_id, t.balance]));
  };

  const rs = ctx.resumeState as ClaimState | undefined;
  let drops: Drop[] = rs?.drops ?? [];
  if (!rs) {
    for (const d of distributors) {
      try {
        const c = (await view(d, 'claimable', { account_id: account })) as { token: string; amount: string };
        if (BigInt(c.amount) > 0n) drops.push({ distributor: d, token: c.token, amount: c.amount });
      } catch (e) { ctx.log(`skip ${d}: ${(e as Error).message}`); }
    }
    ctx.log(`${drops.length} of ${distributors.length} distributors have an allocation for ${account}`, { drops });
  }
  const receipt = (d: Drop, status: string, out: string) => ({ symbol: d.token.split('.')[0], source: d.distributor, assetOut: `nep141:${d.token}`, amountOutUnits: out, minAmountOutUnits: d.amount, status });
  if (ctx.mode === 'quote' || drops.length === 0) return { receipts: drops.map((d) => receipt(d, 'QUOTED', d.amount)) };

  const before = rs?.before ?? await balances(to);
  const transactions: NearTx[] = drops.map((d) => ({ receiverId: d.distributor, actions: [{ type: 'FunctionCall', params: { methodName: 'claim', args: { receiver_id: to }, gas: '30000000000000', deposit: '0' } }] }));
  let txHashes = rs?.txHashes;
  if (rs?.phase !== 'submitted') {
    if (!rs) await ctx.saveState({ phase: 'approval', drops, before } satisfies ClaimState);
    const approval = (rs ? ctx.priorApproval : undefined) ?? await ctx.requestApproval({
      title: `Approve ${drops.length} airdrop claim${drops.length > 1 ? 's' : ''} to your fresh address`,
      signer: account,
      transactions,
      summary: drops.map((d) => ({ symbol: d.token.split('.')[0], amount: d.amount, usd: 0, to })),
    });
    if (!approval.approved) throw new Error('buyer rejected the claim transactions');
    txHashes = approval.txHashes;
    await ctx.saveState({ phase: 'submitted', drops, before, txHashes } satisfies ClaimState);
  }
  // measure what arrived at the recipient, per token, against the balance read before claiming
  const after = await balances(to);
  const receipts = drops.map((d, i) => {
    const got = BigInt(after[d.token] ?? '0') - BigInt(before[d.token] ?? '0');
    return { ...receipt(d, got >= BigInt(d.amount) ? 'SUCCESS' : 'FAILED', (got > 0n ? got : 0n).toString()), originTx: txHashes?.[i] };
  });
  ctx.log(`${receipts.filter((r) => r.status === 'SUCCESS').length}/${receipts.length} claims arrived at ${to.slice(0, 10)}…`, { receipts });
  return { receipts };
};
