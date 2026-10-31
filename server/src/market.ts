/**
 * Exchange layer on top of the ledger: candles, tickers, depth, fundamentals.
 *
 * Honesty labels:
 *  - candles before the server started are SYNTHETIC (seeded random walk, flagged `synthetic`)
 *  - "sim traders" are local bots that place real orders on the ledger so the book is alive;
 *    they are listed as such in the UI and can be turned off with FRS_BOTS=0
 * Everything after boot (orders, trades, runs, settlements, dividends) is real ledger state.
 */
import type { LocalLedger } from '../../core/src/ledger.js';

export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number; synthetic: boolean }
const USDC = 1_000_000;

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

export class Market {
  candles = new Map<string, Candle[]>();
  bots: string[] = ['sim-trader-1.testnet', 'sim-trader-2.testnet', 'sim-trader-3.testnet', 'sim-trader-4.testnet'];
  private lastTradeSeen = 0;

  constructor(private ledger: LocalLedger) {}

  seedHistory(ticker: string, ipoPrice: number, drift: number, vol: number, seed: number) {
    const r = rng(seed);
    const now = Math.floor(Date.now() / 1000 / 3600) * 3600;
    const out: Candle[] = [];
    // walk backwards from the IPO price so history ends exactly at the listing price
    let p = ipoPrice;
    const closes: number[] = [];
    for (let i = 0; i < 24 * 21; i++) { closes.push(p); p = p / (1 + drift + (r() - 0.5) * vol); }
    closes.reverse();
    for (let i = 0; i < closes.length; i++) {
      const c = closes[i], o = i ? closes[i - 1] : c;
      const hi = Math.max(o, c) * (1 + r() * vol * 0.4), lo = Math.min(o, c) * (1 - r() * vol * 0.4);
      out.push({ time: now - (closes.length - i) * 3600, open: o, high: hi, low: lo, close: c, volume: Math.round(2000 + r() * 30000), synthetic: true });
    }
    this.candles.set(ticker, out);
  }

  /** fold new ledger trades into the current hourly candle */
  ingestTrades() {
    const ev = this.ledger.events;
    for (; this.lastTradeSeen < ev.length; this.lastTradeSeen++) {
      const e = ev[this.lastTradeSeen];
      if (e.event !== 'trade') continue;
      const d = e.data[0] as { recipe_id: string; price: string; qty: string };
      const px = Number(d.price) / USDC;
      const arr = this.candles.get(d.recipe_id) ?? [];
      const t = Math.floor(Number(BigInt(e.timestamp_ns) / 1_000_000_000n) / 3600) * 3600;
      const last = arr.at(-1);
      if (last && last.time === t && !last.synthetic) { last.high = Math.max(last.high, px); last.low = Math.min(last.low, px); last.close = px; last.volume += Number(d.qty); }
      else arr.push({ time: t, open: last?.close ?? px, high: Math.max(px, last?.close ?? px), low: Math.min(px, last?.close ?? px), close: px, volume: Number(d.qty), synthetic: false });
      this.candles.set(d.recipe_id, arr);
    }
  }

  lastPrice(ticker: string): number {
    this.ingestTrades();
    return this.candles.get(ticker)?.at(-1)?.close ?? 0;
  }

  ticker(ticker: string) {
    this.ingestTrades();
    const c = this.candles.get(ticker) ?? [];
    const last = c.at(-1)?.close ?? 0;
    const dayAgo = c.at(-25)?.close ?? c[0]?.close ?? last;
    const r = this.ledger.recipes.get(ticker)!;
    const book = this.ledger.get_book(ticker);
    const trades = this.ledger.events.filter((e) => e.event === 'trade' && (e.data[0] as { recipe_id: string }).recipe_id === ticker);
    const runs = this.ledger.events.filter((e) => e.event === 'frs_settlement' && (e.data[0] as { recipe_id: string }).recipe_id === ticker);
    const poolPaid = runs.reduce((s, e) => s + Number((e.data[0] as { shareholder_pool: string }).shareholder_pool), 0) / USDC;
    const q = this.ledger.quote_settlement(ticker, r.blocks);
    const perRunToShares = Number(q.distributed) / USDC;
    const perShare = perRunToShares / Number(r.total_shares);
    return {
      ticker, name: r.name, last, change24h: dayAgo ? (last - dayAgo) / dayAgo : 0,
      bid: book.bids[0] ? Number(book.bids[0].price) / USDC : null, ask: book.asks[0] ? Number(book.asks[0].price) / USDC : null,
      marketCap: last * Number(r.total_shares), totalShares: Number(r.total_shares),
      pricePerRun: Number(r.price_per_run) / USDC, perRunToShareholders: perRunToShares, dividendPerSharePerRun: perShare,
      runs: Number(r.runs), revenue: Number(r.revenue) / USDC, dividendsPaid: poolPaid,
      /** break-even runs: how many runs until dividends repay today's price (a P/E analogue) */
      runsToPayback: perShare > 0 ? Math.round(last / perShare) : null,
      volumeTrades: trades.reduce((s, e) => s + Number((e.data[0] as { qty: string }).qty), 0),
      trades: trades.length,
    };
  }

  /** local market-making bots: random small orders around the last price */
  botTick() {
    const L = this.ledger;
    const tickers = [...L.recipes.keys()];
    if (!tickers.length) return;
    const t = tickers[Math.floor(Math.random() * tickers.length)];
    const last = this.lastPrice(t) || 0.01;
    const bot = this.bots[Math.floor(Math.random() * this.bots.length)];
    const side = Math.random() < 0.5 ? 'bid' : 'ask';
    const px = Math.max(1, Math.round(last * (1 + (Math.random() - (side === 'bid' ? 0.6 : 0.4)) * 0.03) * USDC));
    const qty = BigInt(Math.round(50 + Math.random() * 1500));
    try {
      if (side === 'bid') {
        L.call(L.paymentToken, (l) => l.ft_on_transfer({ sender_id: bot, amount: (BigInt(px) * qty).toString(), msg: JSON.stringify({ action: 'bid', recipe_id: t, price: String(px), qty: qty.toString() }) }));
      } else {
        const avail = L.shares_of(t, bot) - L.locked_of(t, bot);
        if (avail <= 0n) return;
        L.call(bot, (l) => l.place_ask({ recipe_id: t, price: String(px), qty: (avail < qty ? avail : qty).toString() }));
      }
      // keep the book tidy: cancel this bot's stale orders far from the price
      for (const o of [...L.orders.values()]) {
        if (o.owner === bot && o.recipe_id === t && Math.abs(Number(o.price) / USDC - last) / last > 0.06) L.call(bot, (l) => l.cancel_order({ order_id: o.id }));
      }
    } catch { /* ignore bot errors */ }
  }
}
