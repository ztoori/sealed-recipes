# `fungible-recipes` events (exact shapes)

Every event is a NEP-297 log line `EVENT_JSON:{"standard":"fungible-recipes","version":"1.0.0","event":<name>,"data":[<object>]}`.
`data` always has exactly one object. Type notation: `U128` / `U64` = decimal **string**; `u16`, `u64` = JSON **number**; `AccountId` = string.
Source of truth: `contracts/fungible-recipes/src/lib.rs`. The TS mirror (`core/src/ledger.ts`) must emit the same names and fields.

| Event | When | `data[0]` fields |
|---|---|---|
| `runner_added` | `add_runner` | the full `Runner`: `id: AccountId, signing_pk: string, enc_pk_hex: string, codehash: string, fee_per_run: U128, active: bool` |
| `block_registered` | `register_block` | the full `Block`: `id: string, version: string, author: AccountId, fee_per_call: U128, manifest_hash: string, active: bool` |
| `recipe_published` | `publish_recipe` | the full `Recipe`: `id: string, name: string, creator: AccountId, sealed_hash: string, runner_id: AccountId, blocks: string[], price_per_run: U128, royalty_bps: u16, total_shares: U128, acc_per_share: U128 ("0"), runs: u64 (0), revenue: U128 ("0"), listed: bool (true)` |
| `recipe_updated` | `update_sealed` | `recipe_id: string, sealed_hash: string` |
| `run_requested` | `ft_on_transfer` action `run` accepted | the full `Run`: `run_id: string, recipe_id: string, buyer: AccountId (on_behalf_of or sender_id), amount: U128 (= price_per_run, any excess already credited to buyer), inputs_hash: string, sealed_hash: string (snapshot of the recipe's sealed_hash), status: "Pending", created_ns: U64` |
| `transfer_rejected` | `ft_on_transfer` with `on_behalf_of` where the run/bid failed a business rule; full amount credited to `on_behalf_of` | `on_behalf_of: AccountId, sender_id: AccountId, amount: U128, reason: string` |
| `frs_settlement` | `report_run` success | `run_id: string, recipe_id: string, buyer: AccountId, price: U128, output_hash: string, payouts: [{account_id: AccountId, role: string, amount: U128}], shareholder_pool: U128 (= distributed), acc_increment: U128` |
| `run_refunded` | `report_run` failure / `reclaim_run` | `run_id: string, buyer: AccountId, amount: U128, reason: "runner_reported_failure" \| "timeout"` |
| `order_placed` | every bid (via `ft_on_transfer`) and every `place_ask`, **before** matching | the full taker `Order` as created: `id: u64, recipe_id: string, owner: AccountId, side: "Bid" \| "Ask", price: U128, qty: U128 (original qty), created_ns: U64` |
| `trade` | each fill, after `order_placed` | `recipe_id: string, buyer: AccountId, seller: AccountId, price: U128 (maker price), qty: U128, maker_order_id: u64, taker_order_id: u64` |
| `order_cancelled` | `cancel_order` | the full `Order` as it rested (remaining `qty`) |
| `shares_transferred` | `transfer_shares` | `recipe_id: string, from: AccountId, to: AccountId, qty: U128` |
| `dividends_claimed` | `claim_dividends` (emitted even when amount is "0") | `recipe_id: string, account_id: AccountId, amount: U128` |
| `withdrawn` | `on_withdraw` after a successful `ft_transfer` | `account_id: AccountId, amount: U128` |
| `withdraw_failed` | `on_withdraw` after a failed `ft_transfer` (balance restored) | `account_id: AccountId, amount: U128` |

## `frs_settlement.payouts` order and roles

Always in this order, one entry each, **including zero amounts**:
1. `protocol` → `protocol_account`, amount = protocol fee + rounding dust
2. `runner` → runner account id, `fee_per_run`
3. `block:<block id>` → block author, one entry per element of `blocks_used`, in `blocks_used` order
4. `creator_royalty` → recipe creator

No event is emitted for individual shareholders; their share is `shareholder_pool` via `acc_increment`.

## Order ids

- A single counter `next_order_id` starts at **1** and is incremented for **every** order placed (bids and asks), whether it rests or not.
- A taker that is **fully filled on placement still consumes an id** (it appears in `order_placed` and as `taker_order_id` in its trades) but never rests in the book and cannot be cancelled.
- A partially filled taker rests under that same id with the remaining qty.
- Rejected bids (`transfer_rejected`) do **not** consume an id.

## Validation rules that produce rejections

| Rule | Error string (panic, or `transfer_rejected.reason`) |
|---|---|
| block id `^[a-z0-9._@-]{1,64}$` | `block id must match ^[a-z0-9._@-]{1,64}$` (panic) |
| run_id `^[A-Za-z0-9_-]{1,64}$` | `run_id must match ^[A-Za-z0-9_-]{1,64}$` |
| inputs_hash 64 lowercase hex | `inputs_hash must be 64 lowercase hex` |
| duplicate run id | `run exists` |
| unknown recipe | `unknown recipe` |
| recipe not listed | `recipe not listed` |
| underpayment | `payment below price_per_run` |
| bid price or qty 0 | `price and qty must be > 0` |
| bid escrow overflow | `price * qty overflows` |
| bid underpayment | `deposit below price * qty` |
| output_hash 64 lowercase hex (`report_run`) | `output_hash must be 64 lowercase hex` (panic) |
| empty `blocks` in `publish_recipe` | `recipe needs at least one block` (panic) |

Checks run in the order listed for runs: run_id, inputs_hash, duplicate, recipe exists, listed, amount. For bids: recipe exists, price/qty, overflow, amount.
