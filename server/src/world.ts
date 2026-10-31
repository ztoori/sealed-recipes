/**
 * Local "multichain world" for the offline demo: NEP-141 balances of fictional
 * wallets (fixtures/wallets.json) and token metadata. Mock FastNEAR / RPC / 1Click
 * read and write here, so a swap really moves tokens out of the buyer's wallet and
 * into the fresh address. Nothing here exists on any real network.
 */
import { readFileSync } from 'node:fs';

export interface TokenMeta { contract: string; symbol: string; name: string; decimals: number }

export class World {
  balances = new Map<string, Map<string, bigint>>();
  meta = new Map<string, TokenMeta>();
  namedAccounts = new Set<string>();

  constructor(walletsPath: string, tokensPath: string) {
    const w = JSON.parse(readFileSync(walletsPath, 'utf8')) as Record<string, unknown>;
    for (const [acct, list] of Object.entries(w)) {
      if (acct.startsWith('_')) continue;
      this.namedAccounts.add(acct);
      for (const t of list as { contract_id: string; symbol: string; name: string; decimals: number; balance: string }[]) {
        this.meta.set(t.contract_id, { contract: t.contract_id, symbol: t.symbol, name: t.name, decimals: t.decimals });
        this.credit(acct, t.contract_id, BigInt(t.balance));
      }
    }
    const toks = JSON.parse(readFileSync(tokensPath, 'utf8')).tokens as { assetId: string; symbol: string; decimals: number; blockchain: string }[];
    for (const t of toks) if (t.blockchain === 'near') {
      const c = t.assetId.replace(/^nep141:/, '');
      if (!this.meta.has(c)) this.meta.set(c, { contract: c, symbol: t.symbol, name: t.symbol, decimals: t.decimals });
    }
  }
  exists(account: string) { return this.namedAccounts.has(account) || this.balances.has(account); }
  credit(account: string, contract: string, amount: bigint) {
    if (!this.balances.has(account)) this.balances.set(account, new Map());
    const m = this.balances.get(account)!;
    m.set(contract, (m.get(contract) ?? 0n) + amount);
  }
  debit(account: string, contract: string, amount: bigint) {
    const m = this.balances.get(account);
    const have = m?.get(contract) ?? 0n;
    if (have < amount) throw new Error(`insufficient ${contract} balance in ${account}`);
    m!.set(contract, have - amount);
  }
  tokensOf(account: string) {
    return [...(this.balances.get(account) ?? new Map()).entries()].map(([contract_id, balance]) => ({ contract_id, balance: balance.toString(), last_update_block_height: 0 }));
  }
}
