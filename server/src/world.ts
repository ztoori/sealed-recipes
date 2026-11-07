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
  /** demo airdrop distributors (fixtures/airdrops.json): distributor -> token and unclaimed amounts per account */
  airdrops = new Map<string, { token: string; eligible: Map<string, bigint> }>();
  loadAirdrops(path: string) {
    const d = JSON.parse(readFileSync(path, 'utf8')) as { distributors: { id: string; token: string; eligible: Record<string, string> }[] };
    for (const x of d.distributors) { this.airdrops.set(x.id, { token: x.token, eligible: new Map(Object.entries(x.eligible).map(([a, v]) => [a, BigInt(v)])) }); this.namedAccounts.add(x.id); }
  }
  claimable(distributor: string, account: string) {
    const d = this.airdrops.get(distributor);
    if (!d) throw new Error(`${distributor} is not an airdrop distributor`);
    return { token: d.token, amount: (d.eligible.get(account) ?? 0n).toString() };
  }
  /** claim({receiver_id}) signed by `account`: the distributor sends the account's allocation to `receiver` */
  claim(distributor: string, account: string, receiver: string) {
    const d = this.airdrops.get(distributor);
    if (!d) throw new Error(`${distributor} is not an airdrop distributor`);
    const amount = d.eligible.get(account) ?? 0n;
    if (amount === 0n) throw new Error(`nothing to claim from ${distributor} for ${account}`);
    d.eligible.set(account, 0n);
    this.credit(receiver, d.token, amount);
    return amount;
  }
  // ---- native NEAR, access keys, contracts and staking (fixtures/chain-state.json) ----
  native = new Map<string, bigint>();
  accessKeys = new Map<string, { public_key: string; access_key: { nonce: number; permission: unknown } }[]>();
  contracts = new Map<string, { code_hash: string; storage_usage: number; amount: string; full_access_keys: number; source: unknown }>();
  /** pool -> delegator -> position */
  stakes = new Map<string, Map<string, { staked: bigint; unstaked: bigint; can_withdraw: boolean }>>();
  pools = new Map<string, { fee: [number, number]; active: boolean }>();
  loadChainState(path: string) {
    const d = JSON.parse(readFileSync(path, 'utf8')) as {
      native: Record<string, string>; access_keys: Record<string, { public_key: string; access_key: { nonce: number; permission: unknown } }[]>;
      contracts: Record<string, { code_hash: string; storage_usage: number; amount: string; full_access_keys: number; source: unknown }>;
      staking: Record<string, { pool: string; staked: string; unstaked: string; can_withdraw: boolean }[]>; pools: Record<string, { fee: [number, number]; active: boolean }>;
    };
    for (const [a, v] of Object.entries(d.native)) { this.native.set(a, BigInt(v)); this.namedAccounts.add(a); }
    for (const [a, v] of Object.entries(d.access_keys)) this.accessKeys.set(a, structuredClone(v));
    for (const [a, v] of Object.entries(d.contracts)) { this.contracts.set(a, v); this.namedAccounts.add(a); }
    for (const [a, v] of Object.entries(d.pools)) { this.pools.set(a, v); this.namedAccounts.add(a); }
    for (const [acct, list] of Object.entries(d.staking)) for (const x of list) {
      if (!this.stakes.has(x.pool)) this.stakes.set(x.pool, new Map());
      this.stakes.get(x.pool)!.set(acct, { staked: BigInt(x.staked), unstaked: BigInt(x.unstaked), can_withdraw: x.can_withdraw });
    }
  }
  /** a DeleteKey action signed by the account itself */
  deleteKey(account: string, publicKey: string) {
    const keys = this.accessKeys.get(account) ?? [];
    const i = keys.findIndex((k) => k.public_key === publicKey);
    if (i < 0) throw new Error(`${account} has no access key ${publicKey}`);
    keys.splice(i, 1);
  }
  /** staking pool withdraw_all, called by the delegator: unstaked NEAR that finished unbonding returns to the account */
  withdrawAll(pool: string, account: string) {
    const p = this.stakes.get(pool)?.get(account);
    if (!p) throw new Error(`${account} has no stake in ${pool}`);
    if (!p.can_withdraw) throw new Error('The unstaked balance is not yet available due to unstaking delay');
    const amount = p.unstaked;
    p.unstaked = 0n;
    this.native.set(account, (this.native.get(account) ?? 0n) + amount);
    return amount;
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
