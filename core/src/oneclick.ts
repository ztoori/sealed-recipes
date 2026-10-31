/**
 * NEAR Intents 1Click API client (https://docs.near-intents.org/integration/distribution-channels/1click-api).
 *
 *  live    — real HTTP calls to https://1click.chaindefuser.com (set ONECLICK_LIVE=1, optional ONECLICK_JWT).
 *            Quotes are requested with dry:true unless the caller explicitly commits.
 *  fixture — offline: same request/response shapes, token prices from a frozen sample
 *            (fixtures/oneclick-tokens.json), deterministic deposit addresses, simulated
 *            status progression PENDING_DEPOSIT → KNOWN_DEPOSIT_TX → PROCESSING → SUCCESS.
 *
 * NEAR Intents has no testnet, so fixture mode is the default for the hackathon demo.
 */
import { sha256Hex } from './canonical.js';

export const ONECLICK_BASE = 'https://1click.chaindefuser.com';
export const USDC_NEAR = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const TERMINAL = ['SUCCESS', 'FAILED', 'REFUNDED', 'INCOMPLETE_DEPOSIT'] as const;

export interface Token { assetId: string; decimals: number; blockchain: string; symbol: string; price: string; priceUpdatedAt: string; contractAddress?: string }

export interface QuoteRequest {
  dry: boolean;
  swapType: 'EXACT_INPUT' | 'EXACT_OUTPUT' | 'FLEX_INPUT' | 'ANY_INPUT';
  slippageTolerance?: number;
  originAsset: string;
  depositType?: 'ORIGIN_CHAIN' | 'INTENTS' | 'CONFIDENTIAL_INTENTS';
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType?: 'ORIGIN_CHAIN' | 'INTENTS' | 'CONFIDENTIAL_INTENTS';
  recipient: string;
  recipientType?: 'DESTINATION_CHAIN' | 'INTENTS' | 'CONFIDENTIAL_INTENTS';
  deadline?: string;
  confidentiality?: 'public' | 'basic' | 'advanced';
  customRecipientMsg?: string;
  referral?: string;
  appFees?: { recipient: string; fee: number }[];
  quoteWaitingTimeMs?: number;
}

export interface Quote {
  depositAddress?: string;
  depositMemo?: string | null;
  amountIn: string; amountInFormatted: string; amountInUsd: string;
  minAmountIn?: string; maxAmountIn?: string;
  amountOut: string; amountOutFormatted: string; amountOutUsd: string;
  minAmountOut?: string;
  deadline: string; timeWhenInactive?: string; timeEstimate: number;
}
export interface QuoteResponse { correlationId: string; timestamp: string; signature?: string; quoteRequest: QuoteRequest; quote: Quote }

export interface StatusResponse {
  correlationId: string;
  status: 'PENDING_DEPOSIT' | 'KNOWN_DEPOSIT_TX' | 'PROCESSING' | 'SUCCESS' | 'INCOMPLETE_DEPOSIT' | 'REFUNDED' | 'FAILED';
  updatedAt: string;
  quoteResponse?: QuoteResponse;
  swapDetails: { amountIn?: string; amountInFormatted?: string; amountOut?: string; amountOutFormatted?: string; originChainTxHashes: { hash: string; explorerUrl: string }[]; destinationChainTxHashes: { hash: string; explorerUrl: string }[]; refundedAmount?: string; refundReason?: string };
}

export function toUnits(human: number, decimals: number): string {
  const [i, f = ''] = human.toFixed(Math.min(decimals, 12)).split('.');
  return BigInt(i + (f + '0'.repeat(decimals)).slice(0, decimals)).toString();
}
export function fromUnits(units: string, decimals: number): number {
  const s = units.padStart(decimals + 1, '0');
  return Number(s.slice(0, s.length - decimals) + '.' + s.slice(s.length - decimals));
}

export interface OneClickOptions { mode: 'live' | 'fixture'; base?: string; jwt?: string; fixtureTokens?: Token[]; clock?: () => number }

export class OneClick {
  readonly mode: 'live' | 'fixture';
  private base: string;
  private jwt?: string;
  private fixtureTokens: Token[];
  private clock: () => number;
  private deposits = new Map<string, { quote: QuoteResponse; depositedAt?: number; txHash?: string }>();
  readonly log: { at: string; method: string; path: string; body?: unknown; mode: string }[] = [];

  constructor(o: OneClickOptions) {
    this.mode = o.mode; this.base = o.base ?? ONECLICK_BASE; this.jwt = o.jwt; this.fixtureTokens = o.fixtureTokens ?? []; this.clock = o.clock ?? Date.now;
  }

  private async http<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.log.push({ at: new Date(this.clock()).toISOString(), method, path, body, mode: this.mode });
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (this.jwt) headers.authorization = `Bearer ${this.jwt}`;
    const res = await fetch(this.base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error(`1Click ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  async tokens(): Promise<Token[]> {
    if (this.mode === 'live') return this.http<Token[]>('GET', '/v0/tokens');
    this.log.push({ at: new Date(this.clock()).toISOString(), method: 'GET', path: '/v0/tokens', mode: 'fixture' });
    return this.fixtureTokens;
  }

  async quote(req: QuoteRequest): Promise<QuoteResponse> {
    if (this.mode === 'live') return this.http<QuoteResponse>('POST', '/v0/quote', req);
    this.log.push({ at: new Date(this.clock()).toISOString(), method: 'POST', path: '/v0/quote', body: req, mode: 'fixture' });
    const tin = this.fixtureTokens.find((t) => t.assetId === req.originAsset);
    const tout = this.fixtureTokens.find((t) => t.assetId === req.destinationAsset);
    if (!tin || !tout) throw new Error(`1Click (fixture): unsupported asset ${!tin ? req.originAsset : req.destinationAsset}`);
    const feeBps = 25 + (req.appFees ?? []).reduce((s, f) => s + f.fee, 0); // unauthenticated 1Click fee + app fees
    const slip = req.slippageTolerance ?? 100;
    const pin = Number(tin.price), pout = Number(tout.price);
    let amountIn: string, amountOut: string;
    if (req.swapType === 'EXACT_OUTPUT') {
      amountOut = req.amount;
      const usd = fromUnits(amountOut, tout.decimals) * pout / (1 - feeBps / 10000);
      amountIn = toUnits(usd / pin, tin.decimals);
    } else {
      amountIn = req.amount;
      const usd = fromUnits(amountIn, tin.decimals) * pin * (1 - feeBps / 10000);
      amountOut = toUnits(usd / pout, tout.decimals);
    }
    const now = this.clock();
    const correlationId = sha256Hex(JSON.stringify(req) + now).slice(0, 32);
    const q: Quote = {
      amountIn, amountInFormatted: fromUnits(amountIn, tin.decimals).toString(), amountInUsd: (fromUnits(amountIn, tin.decimals) * pin).toFixed(4),
      amountOut, amountOutFormatted: fromUnits(amountOut, tout.decimals).toString(), amountOutUsd: (fromUnits(amountOut, tout.decimals) * pout).toFixed(4),
      minAmountOut: (BigInt(amountOut) * BigInt(10000 - slip) / 10000n).toString(),
      ...(req.swapType === 'EXACT_OUTPUT' ? { maxAmountIn: (BigInt(amountIn) * BigInt(10000 + slip) / 10000n).toString(), minAmountIn: amountIn } : {}),
      deadline: req.deadline ?? new Date(now + 10 * 60_000).toISOString(),
      timeEstimate: req.confidentiality && req.confidentiality !== 'public' ? 24 : 12,
    };
    if (!req.dry) {
      // NEAR-origin deposits go to an implicit (64-hex) account
      q.depositAddress = sha256Hex('deposit|' + correlationId);
      q.depositMemo = null;
      q.timeWhenInactive = new Date(now + 10 * 60_000).toISOString();
    }
    const resp: QuoteResponse = { correlationId, timestamp: new Date(now).toISOString(), quoteRequest: req, quote: q };
    if (q.depositAddress) this.deposits.set(q.depositAddress, { quote: resp });
    return resp;
  }

  async submitDeposit(depositAddress: string, txHash: string, nearSenderAccount?: string) {
    if (this.mode === 'live') return this.http('POST', '/v0/deposit/submit', { txHash, depositAddress, nearSenderAccount });
    this.log.push({ at: new Date(this.clock()).toISOString(), method: 'POST', path: '/v0/deposit/submit', body: { txHash, depositAddress, nearSenderAccount }, mode: 'fixture' });
    const d = this.deposits.get(depositAddress);
    if (!d) throw new Error('unknown deposit address');
    d.depositedAt = this.clock(); d.txHash = txHash;
    return { ok: true };
  }

  async status(depositAddress: string): Promise<StatusResponse> {
    if (this.mode === 'live') return this.http<StatusResponse>('GET', `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`);
    const d = this.deposits.get(depositAddress);
    if (!d) throw new Error('unknown deposit address');
    const age = d.depositedAt ? this.clock() - d.depositedAt : -1;
    const status: StatusResponse['status'] = age < 0 ? 'PENDING_DEPOSIT' : age < 700 ? 'KNOWN_DEPOSIT_TX' : age < 1800 ? 'PROCESSING' : 'SUCCESS';
    const q = d.quote.quote;
    const outHash = sha256Hex('out|' + depositAddress).slice(0, 44);
    return {
      correlationId: d.quote.correlationId, status, updatedAt: new Date(this.clock()).toISOString(), quoteResponse: d.quote,
      swapDetails: {
        amountIn: q.amountIn, amountInFormatted: q.amountInFormatted,
        ...(status === 'SUCCESS' ? { amountOut: q.amountOut, amountOutFormatted: q.amountOutFormatted } : {}),
        originChainTxHashes: d.txHash ? [{ hash: d.txHash, explorerUrl: `https://nearblocks.io/txns/${d.txHash}` }] : [],
        destinationChainTxHashes: status === 'SUCCESS' ? [{ hash: outHash, explorerUrl: `https://nearblocks.io/txns/${outHash}` }] : [],
      },
    };
  }
}

/**
 * Pay-per-run through NEAR Intents: the buyer pays in any supported asset, the solver
 * delivers exactly `price` of the payment token to the contract via ft_transfer_call
 * carrying `msg` (customRecipientMsg) → `ft_on_transfer` opens the run escrow.
 */
export function runPaymentQuoteRequest(o: { originAsset: string; refundTo: string; contractId: string; price: string; msg: string; paymentAsset?: string; dry?: boolean }): QuoteRequest {
  return {
    dry: o.dry ?? false,
    swapType: 'EXACT_OUTPUT',
    slippageTolerance: 100,
    originAsset: o.originAsset,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: o.paymentAsset ?? USDC_NEAR,
    amount: o.price,
    refundTo: o.refundTo,
    refundType: 'ORIGIN_CHAIN',
    recipient: o.contractId,
    recipientType: 'DESTINATION_CHAIN',
    customRecipientMsg: o.msg,
    referral: 'fungible-recipes',
  };
}
