/**
 * The story each recipe film tells: who it is for, an example of what they type, and what comes back.
 * Everything else in a film (the parts, the services they call, the price and how it is split) is read live
 * from the recipe's public listing, so a film can never show anything a buyer couldn't already see.
 * The example run is illustrative and labelled as such on screen.
 */
export interface FilmScript {
  /** one or two sentences: the person and the problem */
  situation: string;
  /** example answers for the buyer's form, by field id */
  inputs?: Record<string, string>;
  /** what the quote would say, for recipes that deliver funds */
  quote?: { expected: number; promised: number };
  /** the result, as the buyer reads it */
  result: { title: string; lines: [string, string][] };
  /** what the buyer walks away with */
  buyerWin: string;
}

const USDC = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';

export const FILM_SCRIPTS: Record<string, FilmScript> = {
  CLNP: {
    situation: 'Bob’s wallet holds fourteen tokens: a few scams, a lot of dust, and some worth keeping.',
    inputs: { wallet: 'bob.near', threshold_usd: '10', target: USDC, recipient: 'fresh' },
    quote: { expected: 38.03, promised: 37.41 },
    result: { title: '$38.03 in USDC at a fresh address', lines: [['REF', '141.7 → 13.02 USDC'], ['USDT', '7.12 → 7.10 USDC'], ['AURORA', '52.3 → 5.92 USDC'], ['3 scam tokens', 'left untouched']] },
    buyerWin: 'Dust turned into USDC at an address nobody can link to him. The scams never touched.',
  },
  EXIT: {
    situation: 'Carol thinks her wallet is compromised. She needs everything in stablecoins, somewhere new, now.',
    inputs: { wallet: 'carol.near', recipient: 'fresh' },
    quote: { expected: 412.6, promised: 405.9 },
    result: { title: '$412.60 in USDC at a fresh address', lines: [['wNEAR', '150 → 312.40 USDC'], ['REF', '141.7 → 13.02 USDC'], ['USDT', '80 → 79.84 USDC'], ['2 scam tokens', 'left behind']] },
    buyerWin: 'Everything that matters, safe in stablecoins at an address with no history.',
  },
  ATOM: {
    situation: 'Dana wants out of every token at once. Half a swap would be worse than none.',
    inputs: { wallet: 'dana.near', recipient: 'fresh' },
    quote: { expected: 50.1, promised: 49.6 },
    result: { title: '$50.10, settled in one signed bundle', lines: [['wNEAR', '11.6 → 24.06 USDC'], ['REF', '141.7 → 13.02 USDC'], ['USDT', '7.12 → 7.10 USDC'], ['AURORA', '52.3 → 5.92 USDC']] },
    buyerWin: 'All of it or none of it, in a single bundle. No half-finished exit.',
  },
  TRCH: {
    situation: 'Erin wants to exit, but not all at one price. Half now, half a little later.',
    inputs: { wallet: 'erin.near', recipient: 'fresh' },
    quote: { expected: 206.3, promised: 202.9 },
    result: { title: 'Two tranches, $206.30 in USDC', lines: [['Tranche 1', '50% of each token → 103.40 USDC'], ['Wait', '20 seconds, survives a restart'], ['Tranche 2', '50% of each token → 102.90 USDC'], ['Signatures', 'one per tranche, never twice']] },
    buyerWin: 'A staged exit that survives a crashed runner, without ever signing twice.',
  },
  SWPR: {
    situation: 'Dana has dust in a dozen tokens. Privacy isn’t the point here. Price is.',
    inputs: { wallet: 'dana.near', threshold_usd: '10', target: 'nep141:wrap.near', recipient: 'dana.near' },
    quote: { expected: 14.2, promised: 13.95 },
    result: { title: '6.8 wNEAR from six small balances', lines: [['AURORA', '52.3 → 2.84 wNEAR'], ['USDT', '7.12 → 3.41 wNEAR'], ['4 more', '→ 0.55 wNEAR'], ['Unlisted tokens', 'skipped']] },
    buyerWin: 'Small balances swept into one asset, at the lowest price on the market.',
  },
  TRIM: {
    situation: 'Dana’s wallet is 48% wNEAR. Her own rule says no single asset above 25%.',
    inputs: { wallet: 'dana.near', max_share: '25', target: USDC, recipient: 'fresh' },
    quote: { expected: 171.95, promised: 169.4 },
    result: { title: 'Back to 25%, selling only the excess', lines: [['wNEAR', '150 → 78.48 kept'], ['Sold', '71.52 wNEAR → 171.95 USDC'], ['Everything else', 'untouched'], ['Share of wNEAR', '47.8% → 25.0%']] },
    buyerWin: 'Her portfolio back inside her own rule, without selling a token more than needed.',
  },
  STAK: {
    situation: 'Bob unstaked months ago and never came back to withdraw. One pool has stopped validating.',
    inputs: { wallet: 'bob.near' },
    quote: { expected: 10.12, promised: 10.12 },
    result: { title: '4.2 NEAR back in his wallet', lines: [['ghostnode.poolv1', '2.4 NEAR withdrawn'], ['zavodil.poolv1', '1.8 NEAR withdrawn'], ['0.7 NEAR', 'still unbonding, left alone'], ['ghostnode.poolv1', 'not validating: earns nothing']] },
    buyerWin: 'Forgotten NEAR back in his wallet, and a warning about a validator that went quiet.',
  },
  KEYS: {
    situation: 'Bob has signed in to dozens of apps over the years. Some of those keys still work, and one belongs to a drainer.',
    inputs: { wallet: 'bob.near' },
    result: { title: '2 of 2 risky app keys revoked', lines: [['near-gift-claim.near', 'a known drainer: revoked'], ['old-nft-drop.near', 'the app is gone: revoked'], ['2 full-access keys', 'flagged for him to review'], ['social.near', 'recognised: kept']] },
    buyerWin: 'Dangerous keys gone, confirmed on-chain. The keys only he can judge are left to him.',
  },
  SAFE: {
    situation: 'An airdrop just landed in Bob’s wallet. Some of it is bait, and he can’t tell which.',
    inputs: { wallet: 'bob.near' },
    result: { title: '3 tokens you should never touch', lines: [['“claim at nearfree.io”', 'a link in the symbol'], ['USDC.e (fake)', 'impersonates a stablecoin'], ['REWARD', 'reward bait'], ['$756.41', 'in tokens that look safe']] },
    buyerWin: 'He knows which tokens are bait before he clicks a thing.',
  },
  CHEK: {
    situation: 'Bob is about to sign for near-gift-claim.near. It promises free tokens.',
    inputs: { contract: 'near-gift-claim.near' },
    result: { title: 'near-gift-claim.near: high risk', lines: [['Verdict', 'do not connect or sign'], ['Name', 'imitates “near” with reward bait'], ['Upgrades', 'one key holder can replace the code'], ['Source', 'not published']] },
    buyerWin: 'A verdict before he signs, from a private model scammers can’t study or tune against.',
  },
};

/** an example answer for a field no script covers */
export function exampleInput(f: { id: string; type: string; placeholder?: string; default?: unknown; generator?: string }): string {
  if (f.generator === 'fresh-implicit') return 'fresh';
  if (f.default !== undefined) return String(f.default);
  if (f.placeholder) return f.placeholder;
  return ({ 'near.account': 'bob.near', 'address.near': 'bob.near', usd: '10', percent: '25', 'asset.id': USDC } as Record<string, string>)[f.type] ?? '…';
}
