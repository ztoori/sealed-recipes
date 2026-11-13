/**
 * Quotes (SRS-1 §7). A buyer seals their inputs once to the attested runner and asks a recipe for a quote; the
 * runner prices it from a dry run and signs it. The sealed request is called the "job" on-chain.
 *
 * job_hash = sha256(canonical({ inputs, salt })). The salt is random and only travels sealed, so the hash that
 * ends up on-chain cannot be brute-forced back to the buyer's wallet.
 */
import { hashObject } from './canonical.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { quoteMessage, type QuoteFields, type SignedQuote } from './ledger.js';
import { base64, open, type SealedEnvelope } from './seal.js';

/**
 * Who may use a sealed job, sealed with it: the contract, the buyer who pays, and the recipes the buyer asked about.
 * The runner refuses the job for anything else, so an envelope that leaks (through the marketplace, a log, a replay)
 * cannot be run or quoted against a recipe someone else wrote, or paid for by another account.
 */
export interface JobBinding { contract: string; buyer: string; recipes: string[] }
export interface JobPayload { inputs: Record<string, unknown>; salt: string; reply_to: string; bind?: JobBinding }

/** why a sealed job may not be used for this contract, buyer and recipe (undefined: it may) */
export function bindingProblem(p: Pick<JobPayload, 'bind'> | undefined, ctx: { contract: string; buyer: string; recipe: string }): string | undefined {
  const b = p?.bind;
  if (!b || typeof b.contract !== 'string' || typeof b.buyer !== 'string' || !Array.isArray(b.recipes)) return 'sealed inputs are not bound to a buyer and recipes (update the client)';
  if (b.contract !== ctx.contract) return 'sealed inputs are bound to a different contract';
  if (b.buyer !== ctx.buyer) return 'sealed inputs are bound to a different buyer';
  if (!b.recipes.includes(ctx.recipe)) return 'sealed inputs are not bound to this recipe';
  return undefined;
}

export function jobHash(inputs: Record<string, unknown>, salt: string): string {
  return hashObject({ inputs, salt });
}

/** What the runner seals to the buyer's reply key for each quote. Nothing about the job crosses the marketplace in plaintext. */
export interface QuoteBody extends SignedQuote { recipe_id: string; buyer: string; inputs_hash: string; details: unknown }

/** What the marketplace relays: public listing facts next to a quote only the buyer can open. */
export interface QuoteView {
  recipe_id: string;
  ok: boolean;
  error?: string;
  sealed_quote?: SealedEnvelope;
}

export interface OpenedQuote extends QuoteBody { verified: boolean; problem?: string }

/**
 * Open a sealed quote and check it the way the contract will: the runner's signature over the exact message
 * (contract, recipe, recipe version, job, sealed inputs, buyer, price, values, cover, expiry). A quote that fails here
 * would be rejected on-chain, so clients drop it before paying.
 */
export function openQuote(sealed: SealedEnvelope, replySecret: Uint8Array, ctx: { contractId: string; recipeId: string; signingPk: string; buyer: string; inputsHash: string; jobHash: string }): OpenedQuote {
  const b = open<QuoteBody>(sealed, replySecret);
  const fields: QuoteFields = { sealed_hash: b.sealed_hash, job_hash: b.job_hash, price: b.price, expected: b.expected, promised: b.promised, cover: b.cover, expires_ns: b.expires_ns };
  const problem =
    b.recipe_id !== ctx.recipeId ? 'quote is for a different recipe'
    : b.buyer !== ctx.buyer ? 'quote is bound to a different buyer'
    : b.inputs_hash !== ctx.inputsHash ? 'quote is bound to different sealed inputs'
    : b.job_hash !== ctx.jobHash ? 'quote is for a different job'
    : BigInt(b.cover) > BigInt(b.promised) ? 'cover exceeds promise'
    : undefined;
  let sigOk = false;
  try { sigOk = nacl.sign.detached.verify(utf8ToBytes(quoteMessage(ctx.contractId, ctx.recipeId, ctx.inputsHash, ctx.buyer, fields)), base64.dec(b.signature), bs58.decode(ctx.signingPk.replace(/^ed25519:/, ''))); } catch { sigOk = false; }
  return { ...b, verified: !problem && sigOk, problem: problem ?? (sigOk ? undefined : 'runner signature does not verify') };
}

export type SortKey = 'value' | 'price' | 'risk' | 'net';
