/**
 * Recipe intents (FRS-1 §5). A buyer posts a job of a standard type; every recipe implementing that type
 * quotes for it from a dry run inside the TEE runner.
 *
 * job_hash = sha256(canonical({ inputs, salt })). The salt is random and only travels sealed, so the hash that
 * ends up on-chain cannot be brute-forced back to the buyer's wallet.
 */
import { hashObject } from './canonical.js';

export interface JobPayload { inputs: Record<string, unknown>; salt: string; reply_to: string }

export function jobHash(inputs: Record<string, unknown>, salt: string): string {
  return hashObject({ inputs, salt });
}

export interface QuoteView {
  recipe_id: string;
  ok: boolean;
  error?: string;
  /** value the recipe expects to deliver, payment-token units */
  expected: string;
  /** value the runner signs as the promise (conservative: after slippage); backed by the recipe's bond */
  promised: string;
  expires_ns: string;
  job_hash: string;
  signature: string;
  /** sealed to the buyer's reply key: what the dry run found (it describes the buyer's wallet) */
  details?: unknown;
}

export type SortKey = 'value' | 'price' | 'risk' | 'net';
