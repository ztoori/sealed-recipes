/**
 * The parts this runner release can run, by id. Parts admitted after human review are compiled into the runner and
 * listed in HANDLERS; open-tier parts admitted on automated checks alone are listed in SANDBOXED and only ever run
 * in the sandbox (runner/src/sandbox.ts). `npm run release:parts` adds entries between the markers. Either way the
 * runner only runs a part whose record in standard/reviews.json verifies (runner/src/admission.ts).
 */
import type { PartHandler } from '../types.js';
import { walletScanner } from './wallet-scanner.js';
import { spamShield } from './spam-shield.js';
import { allowlistShield } from './allowlist-shield.js';
import { dustFilter } from './dust-filter.js';
import { freshCheck } from './fresh-check.js';
import { intentsSwap } from './intents-swap.js';
import { summaryReport } from './summary-report.js';
import { wait } from './wait.js';
import { mergeReceipts } from './merge-receipts.js';
import { airdropClaim } from './airdrop-claim.js';
import { intentsAtomic } from './intents-atomic.js';
import { accessKeyList } from './access-keys.js';
import { keyRisk } from './key-risk.js';
import { keysRevoke } from './keys-revoke.js';
import { stakingPositions } from './staking-positions.js';
import { stakingWithdraw } from './staking-withdraw.js';
import { contractFacts } from './contract-facts.js';
import { aiContractRisk, rulesContractRisk } from './contract-risk.js';
import { contractReport } from './contract-report.js';
import { trimPlan } from './trim-plan.js';
// <release:imports>

export const HANDLERS: Record<string, PartHandler> = {
  'near.wallet-scanner@1.0.0': walletScanner,
  'ai.spam-shield@1.1.0': spamShield,
  'ai.spam-shield-pro@1.0.0': spamShield,
  'rules.spam-shield@1.0.0': allowlistShield,
  'filter.dust@1.0.0': dustFilter,
  'addr.fresh-check@1.0.0': freshCheck,
  'intents.confidential-swap@1.0.0': intentsSwap,
  'intents.public-swap@1.0.0': intentsSwap,
  'report.summary@1.0.0': summaryReport,
  'time.wait@1.0.0': wait,
  'swap.merge@1.0.0': mergeReceipts,
  'intents.atomic-swap@1.0.0': intentsAtomic,
  'airdrop.claim@1.0.0': airdropClaim,
  'near.access-keys@1.0.0': accessKeyList,
  'rules.key-risk@1.0.0': keyRisk,
  'keys.revoke@1.0.0': keysRevoke,
  'staking.positions@1.0.0': stakingPositions,
  'staking.withdraw@1.0.0': stakingWithdraw,
  'near.contract-facts@1.0.0': contractFacts,
  'ai.contract-risk@1.0.0': aiContractRisk,
  'rules.contract-risk@1.0.0': rulesContractRisk,
  'report.contract@1.0.0': contractReport,
  'plan.trim@1.0.0': trimPlan,
  // <release:handlers>
};

/** open-tier parts: implementation file (relative to the repo root) and exported handler name */
export const SANDBOXED: Record<string, { file: string; exportName: string }> = {
  'report.audit@1.0.0': { file: 'runner/src/parts/report-audit.ts', exportName: 'auditReport' },
  // <release:sandboxed>
};
