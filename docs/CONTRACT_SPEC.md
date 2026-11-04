# `fungible-recipes` contract — interface & settlement spec

This file is the single source of truth shared by the Rust contract
(`contracts/fungible-recipes`) and the TypeScript local mirror
(`core/src/ledger.ts`). Both are tested against the same vectors in
`contracts/test-vectors/*.json`.

All token amounts are integers in the payment token's smallest unit
(USDC on NEAR: 6 decimals, NEP-141 `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`
on mainnet; any NEP-141 on testnet). JSON amounts are strings (`U128`).

## Changelog

The body of this file (from **Roles** on) describes the current contract (v5). The changelog below records how it got there, newest first; its older entries mention removed features.

### v5 changes (no investment features: revenue shares removed)

To keep every recipe a plain service purchase, the contract no longer has anything that looks like an investment:
no shares, no dividends, no share trading. (The removed design is preserved at git tag `archive/revenue-shares`.)

**Removed.**
- `Recipe` fields `royalty_bps`, `total_shares`, `acc_per_share`.
- Holdings and all share and order state.
- Methods `transfer_shares`, `claim_dividends`, `place_ask`, `cancel_order`, `clear_batch`.
- The `ft_on_transfer` action `bid`.
- Views on shares, dividends, orders and batches.
- Events `order_placed`, `batch_cleared`, `order_cancelled`, `shares_transferred`, `dividends_claimed`.
- `new()` loses `batch_interval_ns`: `new(owner, payment_token, protocol_account, protocol_fee_bps, update_delay_ns)`.

**Publish.** The signature is now
`publish_recipe(id, name, sealed_hash, runner_id, parts, price_per_run, reserve_bps: u16, settle_mode: Option<String>)`.
`reserve_bps <= 10000`, otherwise it panics `reserve_bps must be <= 10000`.

**Settlement.** Given price `P`, protocol fee bps `f`, runner fee `r` and the part fees `b_i`:
```
protocol = floor(P * f / 10000)
R        = P - protocol - r - Σ b_i
reserve  = floor(R * reserve_bps / 10000)   -> added to the recipe's guarantee deposit (bond_available)
creator  = R - reserve                       -> creator's withdrawable balance
```
Conservation is exact: `protocol + r + Σ b_i + creator + reserve = P`.

The reserve is the creator's own money held as collateral. It grows the deposit that backs the recipe's quotes, and the creator can withdraw the free part with `withdraw_bond` like any other deposit.

**`frs_settlement` data.** `run_id, recipe_id, buyer, price, output_hash, payouts, reserve, delivered, compensation`.
`payouts` lists, in order: `protocol`, `runner`, the `part:<id>` entries not yet billed, then `creator`. `shareholder_pool` and `acc_increment` are removed.

**`Recipe` field order.** `id, name, creator, sealed_hash, runner_id, parts, price_per_run, reserve_bps, runs, revenue, listed, failed, aborted, promised_total, delivered_total, compensated_total, bond_available, bond_locked, settle_mode, version, pending_sealed_hash, update_effective_ns`.

**Checkpoint mode.** `billed + Σ payouts + reserve = price` (replaces the v4 identity with `shareholder_pool`).

**`quote_settlement` view.** Returns `{price, protocol, runner, parts, remainder, reserve, creator}`.

**Terminology.** `bond_*` stays the field name in code. In the product it is called the **guarantee deposit**: a performance bond. It is collateral the creator posts so that buyers are paid if a run under-delivers. Nobody invests in it and it pays no return.

### v4 changes (durable runs, partial settlement, versioned recipes)

**Init.** `new(owner, payment_token, protocol_account, protocol_fee_bps, batch_interval_ns, update_delay_ns: U64)`.
`update_delay_ns` is the notice period before a new recipe version takes effect (24 h suggested on mainnet; the
local demo uses 30 s). `get_config` returns it.

**Recipe gains** (appended after `bond_locked`, in this order, also in `recipe_published`):
`settle_mode: "final" | "checkpoint"`, `version: u32 (1)`, `pending_sealed_hash: string ("" when none)`,
`update_effective_ns: U64 ("0" when none)`.

`publish_recipe(..., total_shares, settle_mode: Option<String>)` — default `"final"`; anything else than
`"final"`/`"checkpoint"` panics `settle_mode must be "final" or "checkpoint"`.

**Versioning with notice.**
- `update_sealed(id, sealed_hash)` — creator only; `sealed_hash` must be 64 lowercase hex
  (`sealed_hash must be 64 lowercase hex`) and differ from the current one (`same as current version`). Activates any
  due pending update first, then sets `pending_sealed_hash`, `update_effective_ns = now + update_delay_ns` (replacing
  an earlier pending update) and emits `recipe_update_scheduled {recipe_id, sealed_hash, version, effective_ns}` where
  `version` is the number it will get. The parts list cannot change: a different parts list is a different recipe.
- `cancel_update(id)` — creator only; requires a pending update (`no pending update`); clears it; emits
  `recipe_update_cancelled {recipe_id, sealed_hash}`.
- `apply_update(id)` — anyone; activates the pending update if it is due (`update not due` otherwise).
- Activation (also done lazily in `ft_on_transfer` action `run`, before the run checks, and in `update_sealed` after the creator and hash-format checks; an activation stays even if an Intents payment is then rejected): when
  `pending_sealed_hash != ""` and `block_timestamp >= update_effective_ns`: `sealed_hash = pending_sealed_hash`,
  `version += 1`, pending cleared, emits `recipe_updated {recipe_id, sealed_hash, version}`.
- A paid run keeps the `sealed_hash` it paid for (unchanged from v1), and quotes stay bound to `sealed_hash`, so a
  quote for the previous version is rejected after activation. The marketplace retains every version a pending run
  references.

**Run gains** (appended after `covered`, in this order, also in `run_requested`):
`checkpoint_seq: u32 (0)`, `state_hash: string ("")`, `parts_billed: string[] ([])`, `billed: U128 ("0")`,
`last_progress_ns: U64 (= created_ns)`.

**Checkpoints.** `checkpoint_run(run_id, seq: u32, state_hash, parts_done: string[], signature: Base64)` — anyone may
relay. Checks, in order: `unknown run`, `run not pending`, runner active (`runner inactive`),
`seq must be checkpoint_seq + 1`, `state_hash must be 64 lowercase hex`, signature over
```
frs-ckpt-v1|<contract>|<run_id>|<recipe_id>|<seq>|<state_hash>|<parts_done joined by ",">
```
(`invalid runner signature`); then, if `parts_done` is non-empty: the recipe's `settle_mode` must be `"checkpoint"`
(`parts can only be billed at checkpoints in checkpoint mode`) and `parts_billed + parts_done` must be a sub-multiset
of the recipe's parts (`parts_done not part of recipe`). Effects: each part in `parts_done` is paid its
`fee_per_call` to its author now; `billed += Σ fees`; `parts_billed += parts_done`; `checkpoint_seq = seq`;
`state_hash` stored; `last_progress_ns = now`. Emits `run_checkpoint {run_id, seq, state_hash, parts_done, billed, payouts}`
where `payouts` lists the part payments made by this call (`[]` when none).
A checkpoint with empty `parts_done` is a heartbeat: it records progress and extends the timeout.

**Settlement with billed parts.** `report_run` outcome `ok`: `parts_billed` must be a sub-multiset of `parts_used`
(`parts_used must include billed parts`); the split is computed on the full `parts_used` exactly as before, but
the parts already billed are not paid again and do not appear in `payouts`. So `billed + Σ payouts + shareholder_pool = price`.
Outcomes `fail` / `abort` and `reclaim_run` refund `amount - billed` (work already done and billed stays paid);
`run_refunded.amount` is that refund.

**Timeout.** `reclaim_run` requires `block_timestamp >= last_progress_ns + RUN_TIMEOUT_NS`, so a long workflow that
keeps checkpointing is never reclaimable mid-way.

### v3 changes (hardened quotes and bonds, after independent review)

These supersede the v2 quote, bond and report rules wherever they differ. Implemented in the Rust contract (all 7 `bonds.json` cases run end to end).

#### Quotes are bound, single-use and fully covered
The runner now signs:

```
frs-quote-v2|<contract>|<recipe_id>|<sealed_hash>|<job_hash>|<inputs_hash>|<buyer>|<expected>|<promised>|<cover>|<expires_ns>
```

- `buyer` is the account the run belongs to (`on_behalf_of`, else `sender_id`).
- `inputs_hash` is the run msg's `inputs_hash`: the hash of the sealed job envelope the quote was computed from.
- `sealed_hash` is the recipe version that was quoted.
- `cover <= promised` is how much of the promise the bond guarantees. It is computed by the runner as `min(promised, bond_available)` at quote time.

The run msg carries `"quote": {"sealed_hash", "job_hash", "expected", "promised", "cover", "expires_ns", "signature"}`. Numbers are decimal strings; a malformed quote object makes the whole msg unparseable (panic, token refunded to the sender). After the v1 run checks, the contract checks, in order, with these reasons:
1. `job_hash must be 64 lowercase hex`
2. `quote for an outdated recipe version` (sealed_hash ≠ recipe.sealed_hash)
3. `runner inactive`
4. `invalid quote signature`
5. `quote expired`
6. `quote already used` (the contract stores sha256 of every accepted quote message)
7. `cover exceeds promise`
8. `bond below quoted cover` (`bond_available < cover`)

Failures follow the `on_behalf_of` rules (credit and `transfer_rejected`, or panic). On success, `covered = cover`, which is moved from `bond_available` to `bond_locked`. The run stores `job_hash`, `expected`, `promised` and `covered`.

#### Reports have three outcomes
`report_run(run_id, outcome, parts_used, output_hash, delivered, signature)`, where `outcome` is `"ok"`, `"fail"` or `"abort"`, signed as:

```
frs-run-v3|<contract>|<run_id>|<recipe_id>|<outcome>|<output_hash>|<delivered>|<parts_used joined by ",">
```

- **ok**: v1 settlement, then `compensation = min(max(0, promised - delivered), covered)` credited to the buyer; `bond_locked -= covered`; `bond_available += covered - compensation`.
- **fail** (the recipe failed while executing): refund the price, release the cover, `failed += 1`.
- **abort** (the run could not start for reasons outside the recipe: the buyer's inputs did not match, or the inputs or market changed since the quote, as found by the runner's pre-execution re-check): refund the price, release the cover, `aborted += 1`. This does not count against the recipe.

`parts_used` is checked only for `ok`. `reclaim_run` after the timeout counts as `failed`.

#### Track record
Adds `aborted: u64`.

#### Events
- `run_requested` Run gains `expected: U128`.
- `run_refunded.reason` is one of `runner_reported_failure`, `runner_aborted`, `timeout`.

### v2 (recipe intents, bonded quotes, parts)

What changed from v1. Where v3 differs (quote message and fields, `cover`, report outcomes), v3 applies.

#### Blocks are now called parts
A *part* is anything a recipe is built from: code, a specialist agent or a data source. Renames, with no
change in behaviour:
`Block`→`Part`, `register_block`→`register_part`, `get_block`/`list_blocks`→`get_part`/`list_parts`,
`Recipe.blocks`→`Recipe.parts`, `publish_recipe(…, blocks, …)`→`publish_recipe(…, parts, …)`,
`report_run(…, blocks_used, …)`→`report_run(…, parts_used, …)`, `quote_settlement(recipe_id, parts_used?)`,
event `block_registered`→`part_registered`, payout role `block:<id>`→`part:<id>`, error strings
`part id must match ^[a-z0-9._@-]{1,64}$`, `recipe needs at least one part`, `parts_used not part of recipe`.

#### Recipe intents: a buyer posts a job, recipes compete with signed quotes
Off-chain, every listed recipe that implements the job's type does a **dry run** inside the TEE runner and
returns a quote: the value it expects to deliver, in payment-token units (`promised`). The runner signs it:

```
frs-quote-v1|<contract_account_id>|<recipe_id>|<job_hash>|<promised>|<expires_ns>
```

`job_hash = sha256(canonical(job inputs))`, computed by the buyer; the runner checks it against the decrypted
inputs before executing. The buyer picks a quote and pays with
`{"action":"run", …, "quote": {"job_hash": "<64 hex>", "promised": "<U128>", "expires_ns": "<U64>", "signature": "<base64>"}}`.
`quote` is optional (plain pay-per-run still works). When present, `ft_on_transfer` checks it, in this order,
after the v1 run checks: `job_hash` must be 64 lowercase hex (`job_hash must be 64 lowercase hex`), the signature
must verify against the recipe's runner key (`invalid quote signature`), and `now <= expires_ns` (`quote expired`).
Failures follow the v1 `on_behalf_of` rules (credit and `transfer_rejected`, or panic).

#### Bonds: quotes backed by money
- `ft_on_transfer` msg `{"action":"bond","recipe_id":"CLNP"}`. Anyone may add to a recipe's bond (usually the
  creator). Errors: `unknown recipe` (credit `on_behalf_of` or panic, as in v1). Emits `bond_posted {recipe_id: string, from: AccountId, amount: U128, bond_available: U128}`.
- When a quoted run is paid, the contract sets aside `covered = min(promised, bond_available)` from the bond
  (`bond_available -= covered; bond_locked += covered`). Run stores `job_hash, promised, covered`.
- `withdraw_bond(recipe_id, amount)`: creator only, `amount <= bond_available`, credits the creator's
  withdrawable balance. Emits `bond_withdrawn {recipe_id: string, amount: U128, bond_available: U128}`.

#### Settlement with delivery
`report_run(run_id, success, parts_used, output_hash, delivered: U128, signature)` where the signed message is now

```
frs-run-v2|<contract_account_id>|<run_id>|<recipe_id>|<ok|fail>|<output_hash>|<delivered>|<parts_used joined by ",">
```

On success, the v1 settlement runs unchanged, then:
`shortfall = max(0, promised - delivered)`; `compensation = min(shortfall, covered)` is credited to the buyer
from the bond; `bond_locked -= covered`; `bond_available += covered - compensation`.
On failure or `reclaim_run`, the buyer is refunded as in v1 and `covered` goes back to `bond_available`.
Unquoted runs have `promised = covered = 0`.

#### Track record (on the Recipe, public)
`runs` (successful, as before), `failed: u64` (refunded runs, both reported failures and timeouts),
`promised_total: U128`, `delivered_total: U128` (sums over successful **quoted** runs),
`compensated_total: U128`, `bond_available: U128`, `bond_locked: U128`.

#### Events
- `run_requested` carries the full Run, which now includes `job_hash` (string, `""` when unquoted), `promised` and `covered`.
- `frs_settlement` adds `delivered: U128` and `compensation: U128`.
- New: `bond_posted`, `bond_withdrawn` (fields above).

## Roles

| Role | Who | What they do |
|---|---|---|
| owner | contract admin (DAO in production) | sets protocol fee, approves TEE runners |
| part author | builder account | registers parts (code, specialist agents, data sources) with a per-call fee |
| creator | recipe author | publishes a sealed recipe, is paid per run, posts the recipe's guarantee deposit (bond) |
| buyer | anyone | pays per run via NEAR Intents (`ft_transfer_call` from 1Click); compensated from the deposit on a shortfall |
| runner | TEE worker key | executes sealed recipes, signs quotes, checkpoints and run reports |

There is no holder or investor role: nothing can be bought except a run.

## State objects

```
Part    { id, version, author, fee_per_call, manifest_hash, active }
Runner  { id, signing_pk: ed25519 (base58 "ed25519:..."), enc_pk_hex (x25519), codehash, fee_per_run, active }
Recipe  { id (^[A-Z0-9]{3,6}$), name, creator, sealed_hash, runner_id, parts: [part_id], price_per_run, reserve_bps,
          runs, revenue, listed, failed, aborted, promised_total, delivered_total, compensated_total,
          bond_available, bond_locked, settle_mode, version, pending_sealed_hash, update_effective_ns }
Run     { run_id, recipe_id, buyer, amount, inputs_hash, sealed_hash (snapshot at payment), status: Pending|Settled|Refunded,
          created_ns, job_hash ("" if unquoted), expected, promised, covered,
          checkpoint_seq, state_hash, parts_billed, billed, last_progress_ns }
```

## Methods

### Admin
- `new(owner, payment_token, protocol_account, protocol_fee_bps, update_delay_ns)` — `#[init]`. `protocol_fee_bps <= 1000`.
- `add_runner(id, signing_pk, enc_pk_hex, codehash, fee_per_run)` — owner only.
- `set_runner_active(id, active)` — owner only.

### Builders & creators
- `register_part(id, version, fee_per_call, manifest_hash)` — author = predecessor. Id unique and must match `^[a-z0-9._@-]{1,64}$` (no `,` or `|`, which delimit the signed report).
- `publish_recipe(id, name, sealed_hash, runner_id, parts, price_per_run, reserve_bps, settle_mode?)`
  - creator = predecessor.
  - rejects if `price_per_run < protocol_fee(price) + runner.fee_per_run + Σ part.fee_per_call` (minimum viable price).
  - `parts` must be non-empty; every part exists & active; runner active.
  - `reserve_bps <= 10000` (`reserve_bps must be <= 10000`): the share of the creator's cut kept in the guarantee deposit.
  - `settle_mode` is `"final"` (default) or `"checkpoint"` (see v4).
- `withdraw_bond(recipe_id, amount)` — creator only, `amount <= bond_available`; credited to the creator's balance. Locked cover cannot be withdrawn.
- `update_sealed(id, sealed_hash)`, `cancel_update(id)`, `apply_update(id)` — versions with a notice period (see v4).

### Pay-per-run (NEAR Intents)
The buyer's 1Click quote targets the payment token on NEAR with
`recipient = <contract>` and `customRecipientMsg = <msg>`, so the solver's
delivery arrives as `ft_transfer_call` → `ft_on_transfer(sender_id, amount, msg)`.

`msg` is JSON:
- `{"action":"run","recipe_id":"CLNP","run_id":"r-…","inputs_hash":"<hex sha256>","quote":{…}?}`
  - optional `quote` = `{sealed_hash, job_hash, expected, promised, cover, expires_ns, signature}` (numbers are
    decimal strings; a malformed quote object makes the msg unparseable → panic), signed by the recipe's runner over
    ```
    frs-quote-v2|<contract>|<recipe_id>|<sealed_hash>|<job_hash>|<inputs_hash>|<buyer>|<expected>|<promised>|<cover>|<expires_ns>
    ```
    where `buyer` = `on_behalf_of`, else `sender_id`, and `inputs_hash` is this msg's `inputs_hash`. Checked after
    the run checks below, in order: `job_hash must be 64 lowercase hex`, `quote for an outdated recipe version`
    (`sealed_hash` ≠ the recipe's), `runner inactive`, `invalid quote signature`, `quote expired`
    (`now > expires_ns`), `quote already used` (sha256 of the message is stored for every accepted quote),
    `cover exceeds promise`, `bond below quoted cover` (`bond_available < cover`). On success
    `covered = cover` moves from `bond_available` to `bond_locked`; the run stores `job_hash, expected, promised, covered`.
  - `run_id` must match `^[A-Za-z0-9_-]{1,64}$`; `inputs_hash` must be 64 lowercase hex.
  - the run records the recipe's current `sealed_hash`; a later `update_sealed` only affects new runs.
  - `amount` must be `>= price_per_run`; excess is credited to the owner's (`on_behalf_of` or sender) withdrawable balance.
  - creates `Run{status:Pending}`. Returns `"0"` (nothing refunded to the token contract).
- `{"action":"bond","recipe_id":"CLNP"}` — adds `amount` to the recipe's `bond_available` (`unknown recipe` otherwise). Event `bond_posted`.
- Both accept an optional `"on_behalf_of":"<account>"`. With NEAR Intents the
  `sender_id` of `ft_transfer_call` is the solver, not the buyer, so the 1Click
  `customRecipientMsg` names the buyer here; the run (refunds, `reclaim_run`) belongs to
  `on_behalf_of`, defaulting to `sender_id`.
- **Business-rule failures** (unknown/unlisted recipe, duplicate `run_id`, malformed `run_id`/`inputs_hash`, underpayment, quote checks, overflow):
  - with `on_behalf_of`: **no panic**. The full `amount` is credited to `on_behalf_of`'s withdrawable balance, event `transfer_rejected {on_behalf_of, sender_id, amount, reason}`, returns `"0"`. (A panic would refund the Intents/solver side, not the buyer.)
  - without `on_behalf_of`: panics, so the token contract refunds `sender_id`.
- Unparseable `msg` or unknown action (including the removed `bid`) → panics → token contract refunds the full amount.
- Only calls from `payment_token` are accepted.

`report_run(run_id, outcome, parts_used, output_hash, delivered, signature)` — callable by anyone
(usually the runner's relayer); authority comes from the signature, not the caller.
- `signature` = base64 ed25519 signature by the recipe's runner `signing_pk` over the UTF-8 string
  ```
  frs-run-v3|<contract_account_id>|<run_id>|<recipe_id>|<outcome>|<output_hash>|<delivered>|<parts_used joined by ",">
  ```
- `outcome` is `"ok"`, `"fail"` or `"abort"` (anything else: `invalid outcome`).
- `output_hash` must be 64 lowercase hex. `delivered` is the value delivered, in payment-token units, as measured by the runner.
- **ok**: `parts_used` must be a sub-multiset of the recipe's `parts` (no unknown parts can be billed).
  **Settlement** (below), then bond compensation `min(max(0, promised - delivered), covered)` to the buyer;
  `bond_locked -= covered`; `bond_available += covered - compensation`; track record updated; status → Settled.
- **fail** (the recipe failed while executing): full refund to buyer balance, `covered` returns to
  `bond_available`, `failed += 1`, status → Refunded, `run_refunded.reason = "runner_reported_failure"`.
- **abort** (the run could not start for reasons outside the recipe: inputs did not match, or inputs or market
  changed since the quote, found by the runner's pre-execution re-check): as fail, but `aborted += 1` and
  reason `"runner_aborted"`. Does not count against the recipe.
- `parts_used` is only checked for `ok`.

`reclaim_run(run_id)` — buyer only, after `RUN_TIMEOUT_NS = 15 min` with status Pending → Refunded (`covered` released, `failed += 1`, reason `"timeout"`).

### Settlement (one receipt, all parties)
Given `P = run.amount_charged (= price_per_run)`, protocol bps `f`, runner fee `r`, part fees `b_i` for each entry of `parts_used`:
```
protocol  = floor(P * f / 10000)       -> protocol account
runner    = r                          -> runner account (runner id is a NEAR account)
parts_i   = b_i                        -> part author
R         = P - protocol - r - Σ b_i   (guaranteed >= 0 by publish check)
reserve   = floor(R * reserve_bps / 10000)  -> recipe's guarantee deposit (bond_available)
creator   = R - reserve                -> creator
```
Conservation is exact, `protocol + r + Σ b_i + reserve + creator = P`, and `reserve + creator = R`: the reserve is
part of the creator's own cut, held as collateral. Both are proved for every input in `verification/`.
Any checked operation that would exceed u128 makes the split `None` and `report_run` panics; this cannot happen
once the publish minimum holds and `P < 2^128 / 10^4`.
All payouts are credited to internal withdrawable balances inside the same receipt
and a single NEP-297 event `frs_settlement` lists every payout.
`withdraw(amount?)` (requires exactly 1 yoctoNEAR attached) sends `ft_transfer` of the caller's balance; the `#[private]` callback `on_withdraw` checks the promise result with `env::promise_result_checked` (ft_transfer returns no value): success emits `withdrawn`, failure restores the credit and emits `withdraw_failed`.

### Views
`get_config`, `get_recipe` (includes the track record and guarantee deposit), `list_recipes`, `get_part`, `list_parts`, `get_runner`, `get_run`,
`balance_of(account_id)`, `quote_settlement(recipe_id, parts_used?)` → `{price, protocol, runner, parts, remainder, reserve, creator}` (the split above, without state change).

### Events (NEP-297, standard `fungible-recipes`, version `1.0.0`)
Exact field shapes: [CONTRACT_EVENTS.md](CONTRACT_EVENTS.md).
`runner_added`, `part_registered`, `recipe_published`, `recipe_updated`, `run_requested`, `frs_settlement`, `run_refunded`,
`recipe_update_scheduled`, `recipe_update_cancelled`, `run_checkpoint`, `withdrawn`, `withdraw_failed`, `transfer_rejected`, `bond_posted`, `bond_withdrawn`.
