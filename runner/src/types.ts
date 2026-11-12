import type { Nep413Payload, SignedNep413 } from '../../core/src/nep413.js';
import type { PartManifest } from '../../core/src/srs.js';

export interface Holding {
  owner: string;
  assetId: string;
  contract: string;
  symbol: string;
  name: string;
  decimals: number;
  amount: string; // smallest units
  usd: number;
  listed: boolean; // quoted by 1Click solvers
}
/** an access key as NEAR RPC view_access_key_list returns it, flattened (key.list) */
export interface AccessKey { public_key: string; kind: 'full' | 'function-call'; receiver?: string; methods?: string[]; allowance?: string | null; nonce: number; action?: 'revoke' | 'review' | 'keep'; reason?: string }
/** a delegation to a staking pool (stake.list) */
export interface StakePosition { pool: string; staked: string; unstaked: string; can_withdraw: boolean; fee_pct: number; active: boolean }
/** what a contract account exposes before you call it (contract.facts) */
export interface ContractFacts { account: string; exists: boolean; has_code: boolean; code_hash?: string; storage_bytes?: number; full_access_keys: number; source: { version?: string; link?: string; standards?: { standard: string; version: string }[] } | null; listed_token: boolean }
export interface ContractVerdict { risk: 'low' | 'medium' | 'high'; reasons: string[]; source: 'nearai-tee' | 'rules' }
/** generic report item rendered by the buyer's client */
export interface ReportItem { label: string; detail: string; tag?: 'ok' | 'warn' | 'bad' }
export interface Flag { assetId: string; symbol: string; verdict: 'SCAM' | 'OK'; reason: string; source: 'nearai-tee' | 'allowlist' }

export type NearAction =
  | { type: 'FunctionCall'; params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string } }
  | { type: 'DeleteKey'; params: { publicKey: string } };
/** wallet-selector / near-connect transaction shape (signAndSendTransactions) */
export interface NearTx { receiverId: string; actions: NearAction[] }
export interface ApprovalRequest { title: string; signer: string; transactions: NearTx[]; summary: { symbol: string; amount: string; usd: number; to: string }[];
  /** NEAR Intents: an off-chain NEP-413 message for the wallet to sign (e.g. one atomic bundle of swaps) */
  sign_message?: Nep413Payload; sign_summary?: string }
export interface ApprovalResult { approved: boolean; txHashes: string[]; signed?: SignedNep413 }

export type Emit = (type: string, data: Record<string, unknown>) => void;

export interface PartCtx {
  nodeId: string;
  manifest: PartManifest;
  params: Record<string, unknown>;
  /** fetch restricted to the part's declared `net:` capabilities */
  http: (url: string, init?: RequestInit) => Promise<Response>;
  log: (msg: string, data?: Record<string, unknown>) => void;
  requestApproval: (req: ApprovalRequest) => Promise<ApprovalResult>;
  endpoints: Endpoints;
  secrets: { nearAiKey?: string; oneClickJwt?: string; oneClickApiKey?: string };
  /** 'quote' = dry run for a signed quote: read-only, no approvals, swaps are priced but not executed */
  mode: 'run' | 'quote';
  /** Durable runs: the state this part saved before the runner stopped, when the run resumes inside this part. */
  resumeState?: unknown;
  /** Write-ahead: persist the part's progress (sealed, signed checkpoint) before an irreversible step. */
  saveState: (state: unknown) => Promise<void>;
  /** Sleep without counting against the part's max_ms (used by time.wait). */
  wait: (ms: number) => Promise<void>;
  /** On resume: wallet approvals the marketplace relayed for this node after the last checkpoint. */
  priorApproval?: ApprovalResult;
}

export interface Endpoints { fastnear: string; rpc: string; oneclick: string; nearai: string; nras: string; solverRelay: string }

export type PartHandler = (inputs: Record<string, unknown>, ctx: PartCtx) => Promise<Record<string, unknown>>;
