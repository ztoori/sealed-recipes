import type { Nep413Payload, SignedNep413 } from '../../core/src/nep413.js';
import type { PartManifest } from '../../core/src/frs.js';

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
export interface Flag { assetId: string; symbol: string; verdict: 'SCAM' | 'OK'; reason: string; source: 'nearai-tee' | 'allowlist' }

export interface NearTx { receiverId: string; actions: { type: 'FunctionCall'; params: { methodName: string; args: Record<string, unknown>; gas: string; deposit: string } }[] }
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
  secrets: { nearAiKey?: string; oneClickJwt?: string };
  /** 'quote' = dry run for recipe intents: read-only, no approvals, swaps are priced but not executed */
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
