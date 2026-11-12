# `sealed-recipes` events (exact shapes)

Every event is a NEP-297 log line `EVENT_JSON:{"standard":"sealed-recipes","version":"1.0.0","event":<name>,"data":[<object>]}`.
`data` always has exactly one object. Type notation: `U128` / `U64` = decimal **string**; `u16`, `u64` = JSON **number**; `AccountId` = string.
Source of truth: `contracts/sealed-recipes/src/lib.rs`. The TS mirror (`core/src/ledger.ts`) must emit the same names and fields.

| Event | When | `data[0]` fields |
|---|---|---|
| `runner_added` | `add_runner` | the full `Runner`: `id: AccountId, signing_pk: string, enc_pk_hex: string, codehash: string, fee_per_run: U128, active: bool` |
| `runner_codehash_updated` | `set_runner_codehash` (owner records a new audited runner release; keys unchanged) | `id: AccountId, previous: string, codehash: string` |
| `part_registered` | `register_part` | the full `Part`: `id: string, version: string, author: AccountId, fee_per_call: U128, manifest_hash: string, active: bool` |
| `recipe_published` | `publish_recipe` | the full `Recipe`: `id: string, name: string, creator: AccountId, sealed_hash: string, runner_id: AccountId, parts: string[], price_per_run: U128, reserve_bps: u16, runs: u64 (0), revenue: U128 ("0"), listed: bool (true), failed: u64 (0), aborted: u64 (0), promised_total: U128 ("0"), delivered_total: U128 ("0"), compensated_total: U128 ("0"), bond_available: U128 ("0"), bond_locked: U128 ("0"), settle_mode: "final" \| "checkpoint", version: u32 (1), pending_sealed_hash: string (""), update_effective_ns: U64 ("0"), price_floor: U128, price_ceiling: U128, target_runs: u32, period_start_ns: U64 (publish time), period_runs: u64 (0)` |
| `recipe_update_scheduled` | `update_sealed` (new version announced; takes effect after `update_delay_ns`) | `recipe_id: string, sealed_hash: string, version: u32 (the number it will get), effective_ns: U64` |
| `recipe_update_cancelled` | `cancel_update` | `recipe_id: string, sealed_hash: string` |
| `recipe_updated` | activation of a due update (`apply_update`, or lazily in `ft_on_transfer` run / `update_sealed`) | `recipe_id: string, sealed_hash: string, version: u32` |
| `price_updated` | ended pricing periods applied (`update_price`, or lazily in `ft_on_transfer` run / `set_pricing`), only when the list price moved | `recipe_id: string, previous: U128, price: U128, periods: U64 (periods applied), runs: U64 (paid runs in the first of them), target_runs: u32` |
| `pricing_updated` | `set_pricing` (creator only) | `recipe_id: string, price_floor: U128, price_ceiling: U128, target_runs: u32, price: U128 (list price after clamping into the band)` |
| `run_checkpoint` | `checkpoint_run` (progress, optional partial billing in checkpoint mode) | `run_id: string, seq: u32, state_hash: string, parts_done: string[], billed: U128 (run total after), payouts: [{account_id: AccountId, role: string, amount: U128}] (part payments made by this call, role `part:<id>`)` |
| `run_requested` | `ft_on_transfer` action `run` accepted | the full `Run`: `run_id: string, recipe_id: string, buyer: AccountId (on_behalf_of or sender_id), amount: U128 (the quote's signed `price` if quoted, else the current list price; any excess already credited to buyer), inputs_hash: string, sealed_hash: string (snapshot of the recipe's sealed_hash), status: "Pending", created_ns: U64, job_hash: string ("" when unquoted), expected: U128 ("0" when unquoted), promised: U128 ("0" when unquoted), covered: U128 (the bond amount set aside = the quote's signed cover; "0" when unquoted), checkpoint_seq: u32 (0), state_hash: string (""), parts_billed: string[] ([]), billed: U128 ("0"), last_progress_ns: U64 (= created_ns)` |
| `transfer_rejected` | `ft_on_transfer` with `on_behalf_of` where the run/bond failed a business rule (including quote checks); full amount credited to `on_behalf_of` | `on_behalf_of: AccountId, sender_id: AccountId, amount: U128, reason: string` |
| `srs_settlement` | `report_run` outcome `ok` | `run_id: string, recipe_id: string, buyer: AccountId, price: U128, output_hash: string, payouts: [{account_id: AccountId, role: string, amount: U128}], reserve: U128 (added to the recipe's guarantee deposit), delivered: U128, compensation: U128` |
| `run_refunded` | `report_run` outcome `fail` or `abort` / `reclaim_run` (the run's `covered` returns to `bond_available`) | `run_id: string, buyer: AccountId, amount: U128 (= run amount - billed), reason: "runner_reported_failure" \| "runner_aborted" \| "timeout"` |
| `withdrawn` | `on_withdraw` after a successful `ft_transfer` | `account_id: AccountId, amount: U128` |
| `bond_posted` | `ft_on_transfer` action `bond` | `recipe_id: string, from: AccountId (on_behalf_of or sender_id), amount: U128, bond_available: U128 (after)` |
| `bond_withdrawn` | `withdraw_bond` (creator only; amount credited to the creator's withdrawable balance) | `recipe_id: string, amount: U128, bond_available: U128 (after)` |
| `withdraw_failed` | `on_withdraw` after a failed `ft_transfer` (balance restored) | `account_id: AccountId, amount: U128` |

## `srs_settlement.payouts` order and roles

Always in this order, one entry each, **including zero amounts**:
1. `protocol` → `protocol_account`, amount = protocol fee + rounding dust
2. `runner` → runner account id, `fee_per_run`
3. `part:<part id>` → part author, one entry per element of `parts_used` that was not already billed at a checkpoint, in `parts_used` order (billed parts are removed from the front of the match: the first occurrences)
4. `creator` → recipe creator (the remainder after `reserve`)

The `reserve` goes to the recipe's guarantee deposit (`bond_available`), not to an account.
Bond compensation is not a payout entry: it is credited to `buyer` and reported as `compensation`.

## Validation rules that produce rejections

| Rule | Error string (panic, or `transfer_rejected.reason`) |
|---|---|
| part id `^[a-z0-9._@-]{1,64}$` | `part id must match ^[a-z0-9._@-]{1,64}$` (panic) |
| run_id `^[A-Za-z0-9_-]{1,64}$` | `run_id must match ^[A-Za-z0-9_-]{1,64}$` |
| inputs_hash 64 lowercase hex | `inputs_hash must be 64 lowercase hex` |
| duplicate run id | `run exists` |
| unknown recipe | `unknown recipe` |
| recipe not listed | `recipe not listed` |
| price (the quote's signed `price`, else the current list price) within `price_floor..price_ceiling` | `quoted price outside price_floor..price_ceiling` |
| price at most the msg's `max_price`, when given | `price above max_price` |
| underpayment | `payment below price` |
| job_hash 64 lowercase hex (quoted run) | `job_hash must be 64 lowercase hex` |
| quote `sealed_hash` equals the recipe's current `sealed_hash` | `quote for an outdated recipe version` |
| the recipe's runner is active | `runner inactive` |
| quote signature by the recipe's runner over `srs-quote-v3\|…` (binds recipe version, job, inputs_hash, buyer and price) | `invalid quote signature` |
| `block_timestamp <= expires_ns` | `quote expired` |
| sha256 of the quote message not seen before (each quote backs one run) | `quote already used` |
| `cover <= promised` | `cover exceeds promise` |
| `bond_available >= cover` | `bond below quoted cover` |
| a quote object with a missing field or a non-string number | `invalid msg` (panic at parse, even with `on_behalf_of`) |
| `report_run` outcome is `ok`, `fail` or `abort` | `invalid outcome` (panic) |
| output_hash 64 lowercase hex (`report_run`) | `output_hash must be 64 lowercase hex` (panic) |
| empty `parts` in `publish_recipe` | `recipe needs at least one part` (panic) |

Checks run in the order listed for runs: run_id, inputs_hash, duplicate, recipe exists, listed, price in band, max_price, amount, then (quoted runs only) job_hash, recipe version, runner active, quote signature, expiry, single use, cover <= promise, bond >= cover. Only an accepted quote is marked used; a rejected one can still be paid by its buyer. Bonds: recipe exists (`unknown recipe`).
