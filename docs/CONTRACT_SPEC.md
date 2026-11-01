# `fungible-recipes` contract — interface & settlement spec

This file is the single source of truth shared by the Rust contract
(`contracts/fungible-recipes`) and the TypeScript local mirror
(`packages/core/src/ledger.ts`). Both are tested against the same vectors in
`contracts/test-vectors/*.json`.

All token amounts are integers in the payment token's smallest unit
(USDC on NEAR: 6 decimals, NEP-141 `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`
on mainnet; any NEP-141 on testnet). JSON amounts are strings (`U128`).
Shares are integer units (no decimals).

## Roles

| Role | Who | What they do |
|---|---|---|
| owner | contract admin (DAO in production) | sets protocol fee, approves TEE runners |
| block author | builder account | registers blocks with a per-call fee |
| creator | recipe author | publishes a sealed recipe, receives 100% of its shares + royalty |
| buyer | anyone | pays per run via NEAR Intents (`ft_transfer_call` from 1Click) |
| runner | TEE worker key | executes sealed recipes, signs run reports |
| shareholder | anyone holding recipe shares | earns pro-rata dividends from every run |

## State objects

```
Block   { id, version, author, fee_per_call, manifest_hash, active }
Runner  { id, signing_pk: ed25519 (base58 "ed25519:..."), enc_pk_hex (x25519), codehash, fee_per_run, active }
Recipe  { id (ticker, ^[A-Z0-9]{3,6}$), name, creator, sealed_hash, runner_id, blocks: [block_id],
          price_per_run, royalty_bps, total_shares, acc_per_share (u128, scaled 1e18), runs, revenue, listed }
Run     { run_id, recipe_id, buyer, amount, inputs_hash, sealed_hash (snapshot at payment), status: Pending|Settled|Refunded, created_ns }
Order   { id (u64), recipe_id, owner, side: Bid|Ask, price (per share), qty (remaining shares), created_ns }
Batch   { id (u64, 1 = opening auction), opened_ns }   (one per recipe; closes at opened_ns + batch_interval_ns)
```

## Methods

### Admin
- `new(owner, payment_token, protocol_account, protocol_fee_bps, batch_interval_ns)` — `#[init]`. `protocol_fee_bps <= 1000`, `batch_interval_ns > 0`.
- `add_runner(id, signing_pk, enc_pk_hex, codehash, fee_per_run)` — owner only.
- `set_runner_active(id, active)` — owner only.

### Builders & creators
- `register_block(id, version, fee_per_call, manifest_hash)` — author = predecessor. Id unique and must match `^[a-z0-9._@-]{1,64}$` (no `,` or `|`, which delimit the signed report).
- `publish_recipe(id, name, sealed_hash, runner_id, blocks, price_per_run, royalty_bps, total_shares)`
  - creator = predecessor; mints `total_shares` to creator.
  - rejects if `price_per_run < protocol_fee(price) + runner.fee_per_run + Σ block.fee_per_call` (minimum viable price).
  - `blocks` must be non-empty.
  - `royalty_bps <= 5000`, `total_shares > 0`, every block exists & active, runner active.
- `update_sealed(id, sealed_hash)` — creator only (new version of the sealed graph, same interface).

### Pay-per-run (NEAR Intents)
The buyer's 1Click quote targets the payment token on NEAR with
`recipient = <contract>` and `customRecipientMsg = <msg>`, so the solver's
delivery arrives as `ft_transfer_call` → `ft_on_transfer(sender_id, amount, msg)`.

`msg` is JSON:
- `{"action":"run","recipe_id":"CLNP","run_id":"r-…","inputs_hash":"<hex sha256>"}`
  - `run_id` must match `^[A-Za-z0-9_-]{1,64}$`; `inputs_hash` must be 64 lowercase hex.
  - the run records the recipe's current `sealed_hash`; a later `update_sealed` only affects new runs.
  - `amount` must be `>= price_per_run`; excess is credited to the owner's (`on_behalf_of` or sender) withdrawable balance.
  - creates `Run{status:Pending}`. Returns `"0"` (nothing refunded to the token contract).
- `{"action":"bid","recipe_id":"CLNP","price":"<per share>","qty":"<shares>"}`
  - escrows `price*qty`; excess credited to balance; then matches (see order book).
- Both accept an optional `"on_behalf_of":"<account>"`. With NEAR Intents the
  `sender_id` of `ft_transfer_call` is the solver, not the buyer, so the 1Click
  `customRecipientMsg` names the buyer here; the run (refunds, `reclaim_run`) or the
  bid (shares, refunds) belongs to `on_behalf_of`, defaulting to `sender_id`.
- **Business-rule failures** (unknown/unlisted recipe, duplicate `run_id`, malformed `run_id`/`inputs_hash`, underpayment, bid price/qty 0, overflow, bid underpayment):
  - with `on_behalf_of`: **no panic**. The full `amount` is credited to `on_behalf_of`'s withdrawable balance, event `transfer_rejected {on_behalf_of, sender_id, amount, reason}`, returns `"0"`. (A panic would refund the Intents/solver side, not the buyer.)
  - without `on_behalf_of`: panics, so the token contract refunds `sender_id`.
- Unparseable `msg` or unknown action → panics → token contract refunds the full amount.
- Only calls from `payment_token` are accepted.

`report_run(run_id, success, blocks_used, output_hash, signature)` — callable by anyone
(usually the runner's relayer); authority comes from the signature, not the caller.
- `signature` = base64 ed25519 signature by the recipe's runner `signing_pk` over the UTF-8 string
  ```
  frs-run-v1|<contract_account_id>|<run_id>|<recipe_id>|<ok|fail>|<output_hash>|<blocks_used joined by ",">
  ```
- `output_hash` must be 64 lowercase hex.
- `blocks_used` must be a sub-multiset of the recipe's `blocks` (no unknown blocks can be billed).
- On `success`: **settlement** (below), status → Settled. On fail: full refund to buyer balance, status → Refunded.

`reclaim_run(run_id)` — buyer only, after `RUN_TIMEOUT_NS = 15 min` with status Pending → Refunded.

### Settlement (one receipt, all parties)
Given `P = run.amount_charged (= price_per_run)`, protocol bps `f`, runner fee `r`, block fees `b_i` for each entry of `blocks_used`:
```
protocol  = floor(P * f / 10000)
runner    = r                         -> runner account (runner id is a NEAR account)
blocks_i  = b_i                       -> block author
R         = P - protocol - r - Σ b_i  (guaranteed >= 0 by publish check)
creator   = floor(R * royalty_bps / 10000)
pool      = R - creator
inc       = floor(pool * 1e18 / total_shares)
distributed = floor(inc * total_shares / 1e18)
dust      = pool - distributed        -> protocol
acc_per_share += inc
```
All payouts are credited to internal withdrawable balances inside the same receipt
and a single NEP-297 event `frs_settlement` lists every payout.
`withdraw(amount?)` (requires exactly 1 yoctoNEAR attached) sends `ft_transfer` of the caller's balance; the `#[private]` callback `on_withdraw` checks the promise result with `env::promise_result_checked` (ft_transfer returns no value): success emits `withdrawn`, failure restores the credit and emits `withdraw_failed`.

### Shares & dividends
Pending dividends for an account: `shares * acc_per_share / 1e18 - reward_debt + unpaid`.
Before any change to an account's share balance the contract **harvests** pending dividends into
that account's withdrawable balance and resets `reward_debt = new_shares * acc / 1e18`.
- `transfer_shares(recipe_id, receiver_id, qty)`
- `claim_dividends(recipe_id)` → harvested into balance.

### Share trading: frequent batch auctions (per recipe, shares vs payment token)

Shares never trade continuously. Orders collect into the recipe's current **batch**. When the batch
closes, everything that crosses clears at **one uniform price**. Nobody gains from reacting a block
earlier than someone else, and a thin book cannot be walked by a single order.

- `new(..., batch_interval_ns: U64)` sets the batch length (demo: 12 s; testnet suggestion: 60 s).
- A recipe's first batch opens at `publish_recipe` and is its **opening auction**. The creator offers the
  float as asks at a reserve price, and bids accumulate until the first clearing.
- Order ids are `u64`, starting at 1, shared by both sides. Every accepted order rests in the book; nothing
  fills on placement. A book holds at most `MAX_ORDERS_PER_BOOK = 200` orders (bounds clearing gas; a full book
  rejects new orders with `order book full`).
- `place_ask(recipe_id, price, qty) -> u64`: escrows shares by **locking** them in the seller's own holding
  (`locked += qty`). Locked shares keep earning dividends until they fill. `available = shares - locked`;
  `place_ask` and `transfer_shares` require `available >= qty`.
- Bids arrive via `ft_on_transfer` (`action: bid`), escrowing `price * qty` payment tokens.
- `cancel_order(order_id)`: order owner only, any time before the order fills. Bids refund
  `price * remaining_qty`; asks unlock.
- `clear_batch(recipe_id)`: **anyone** may call it once `now >= batch.opened_ns + batch_interval_ns`. It always
  closes the batch (`batch.id += 1`, `batch.opened_ns = now`), even when nothing crosses.

**Clearing price.** For a candidate price `p`: demand `D(p) = Σ qty of bids with price >= p`, supply
`S(p) = Σ qty of asks with price <= p`, volume `V(p) = min(D(p), S(p))`. Candidates are all distinct order prices.
1. Keep the candidates with the largest `V` (if the largest `V` is 0, nothing clears: `price = null`, `volume = 0`).
2. Among those, keep the ones with the smallest imbalance `|D(p) - S(p)|`.
3. `P = floor((min + max) / 2)` of the remaining candidates. `V(P)` equals the maximum volume (proof in the
   batch-auction vectors file).

**Allocation at `P`, volume `V`.** Eligible bids (`price >= P`) are sorted by price desc, then id asc. Eligible asks
(`price <= P`) are sorted by price asc, then id asc. Each side fills greedily up to `V`; at most one order per side is
partially filled, and the remainder rests for the next batch. For each filled bid: harvest dividends, add `q` shares
to the buyer, and credit the buyer `(bid.price - P) * q` (price improvement). For each filled ask: harvest dividends,
remove `q` shares and `q` locked from the seller, and credit the seller `q * P`. Shares and tokens are conserved
exactly. Self-matching is allowed and nets out. There are no trading fees in v1.

Shared vectors: `contracts/test-vectors/batch-auction.json` (generated by `scripts/gen-auction-vectors.py`,
an independent Python reference implementation).

### Views
`get_config`, `get_recipe`, `list_recipes`, `get_block`, `list_blocks`, `get_runner`, `get_run`, `get_book(recipe_id)`,
`get_batch(recipe_id) -> {id, opened_ns, closes_ns}`, `indicative_clearing(recipe_id) -> {price, volume, demand, supply}` (what would clear now),
`shares_of(recipe_id, account_id)`, `pending_dividends(recipe_id, account_id)`, `balance_of(account_id)`,
`quote_settlement(recipe_id, blocks_used)` (returns the split above without state change).

### Events (NEP-297, standard `fungible-recipes`, version `1.0.0`)
Exact field shapes and order-id rules: [CONTRACT_EVENTS.md](CONTRACT_EVENTS.md).
`runner_added`, `block_registered`, `recipe_published`, `recipe_updated`, `run_requested`, `frs_settlement`, `run_refunded`,
`order_placed`, `batch_cleared`, `order_cancelled`, `shares_transferred`, `dividends_claimed`, `withdrawn`, `withdraw_failed`, `transfer_rejected`.
