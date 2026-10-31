import type { BlockHandler, Holding } from '../types.js';

/** FastNEAR: GET /v1/account/{id}/ft → { tokens: [{ contract_id, balance }] }; metadata via RPC ft_metadata; prices via 1Click /v0/tokens. */
export const walletScanner: BlockHandler = async (inputs, ctx) => {
  const account = String(inputs.account);
  if (!/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(account) || account.length < 2 || account.length > 64) throw new Error(`invalid NEAR account id "${account}"`);
  const ftRes = await ctx.http(`${ctx.endpoints.fastnear}/v1/account/${account}/ft`);
  if (!ftRes.ok) throw new Error(`FastNEAR ${ftRes.status}`);
  const ft = (await ftRes.json()) as { tokens: { contract_id: string; balance: string }[] };
  const tokRes = await ctx.http(`${ctx.endpoints.oneclick}/v0/tokens`);
  const listed = (await tokRes.json()) as { assetId: string; symbol: string; decimals: number; price: string; blockchain: string }[];
  const byAsset = new Map(listed.filter((t) => t.blockchain === 'near').map((t) => [t.assetId, t]));
  ctx.log(`FastNEAR returned ${ft.tokens.length} token balances; 1Click lists ${byAsset.size} NEAR assets`);

  const out: Holding[] = [];
  for (const t of ft.tokens) {
    if (BigInt(t.balance || '0') === 0n) continue;
    const assetId = `nep141:${t.contract_id}`;
    // ft_metadata via JSON-RPC call_function (args "{}" base64 = e30=)
    const md = await ctx.http(ctx.endpoints.rpc, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'frs', method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: t.contract_id, method_name: 'ft_metadata', args_base64: 'e30=' } }),
    }).then((r) => r.json() as Promise<{ result?: { result: number[] } }>);
    const meta = md.result ? (JSON.parse(new TextDecoder().decode(Uint8Array.from(md.result.result))) as { symbol: string; name: string; decimals: number }) : { symbol: '?', name: t.contract_id, decimals: 0 };
    const l = byAsset.get(assetId);
    const decimals = l?.decimals ?? meta.decimals;
    const human = Number(t.balance) / 10 ** decimals;
    out.push({ owner: account, assetId, contract: t.contract_id, symbol: meta.symbol, name: meta.name, decimals, amount: t.balance, usd: l ? +(human * Number(l.price)).toFixed(4) : 0, listed: !!l });
  }
  out.sort((a, b) => b.usd - a.usd);
  ctx.log(`priced ${out.length} holdings, total $${out.reduce((s, h) => s + h.usd, 0).toFixed(2)}`, { holdings: out.map((h) => ({ symbol: h.symbol, usd: h.usd, listed: h.listed })) });
  return { holdings: out };
};
