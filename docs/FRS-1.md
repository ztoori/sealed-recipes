# FRS-1: Fungible Recipe Standard (v1.0)

FRS-1 is the no-code / low-code format for composing apps and bots into workflows that can be **sealed, priced and settled**. It has three documents: a **block manifest** (published by a builder), a **recipe** (written by a creator, sealed) and a **public listing** (derived from the recipe, which is all the market sees).

Reference implementation: [`core/src/frs.ts`](../core/src/frs.ts). Catalog: [`standard/blocks.json`](../standard/blocks.json).

## 1. Types

Ports are typed with named types. A type may `extend` one parent (nominal subtyping):

```json
"address.near":       { "extends": null },
"address.near.fresh": { "extends": "address.near" }
```

A value of type `A` may be wired into a port of type `B` iff `A == B` or `A` transitively extends `B`.
This is what makes swaps safe. A swap block that needs a *proven-fresh* address (`address.near.fresh`) cannot be fed a raw form field, but a block that accepts any `address.near` can take a fresh one.

## 2. Block manifest

```json
{
  "id": "intents.confidential-swap@1.0.0",
  "name": "Confidential Swap (Intents)",
  "category": "source | guard | transform | action | sink",
  "author": "veil.testnet",
  "inputs":  { "tokens": { "type": "token.holdings" }, "to": { "type": "address.near.fresh" }, "target": { "type": "asset.id" } },
  "outputs": { "receipts": { "type": "swap.receipts" } },
  "params":  { "slippage_bps": { "type": "number", "default": 100, "secret": true } },
  "capabilities": ["net:1click.chaindefuser.com", "wallet:approve"],
  "fee_per_call": "50000"
}
```

- `id` is `<name>@<semver>` and is registered on-chain with `manifest_hash = sha256(canonical(manifest))`.
- `capabilities` are **enforced**. The runner gives each block a `fetch` that rejects hosts not declared as `net:<host>` (see `guardedFetch`). `wallet:approve` means the block may ask the buyer to sign transactions. It can never sign them itself.
- `params.secret: true` marks the creator's edge (prompts, thresholds, routing choices). These values are only present in the sealed recipe.
- `fee_per_call` is paid to `author` in every settlement in which the block ran.

## 3. Recipe

```json
{
  "frs": "1.0", "kind": "recipe",
  "meta":   { "ticker": "CLNP", "name": "Clean up and protect", "creator": "chef.testnet", "description": "…" },
  "form":   [ { "id": "wallet", "label": "Wallet to clean", "type": "near.account", "required": true },
              { "id": "recipient", "label": "Fresh address", "type": "address.near", "generator": "fresh-implicit" } ],
  "nodes":  [ { "id": "scan", "block": "near.wallet-scanner@1.0.0", "inputs": { "account": "form.wallet" }, "params": {} },
              { "id": "fresh", "block": "addr.fresh-check@1.0.0",  "inputs": { "recipient": "form.recipient" } }, "…" ],
  "consts": { "usdc": { "type": "asset.id", "value": "nep141:…" } },
  "output": "swap.receipts",
  "listing": { "price_per_run": "750000", "royalty_bps": 1000, "total_shares": "1000000" }
}
```

References are `form.<field>`, `const.<name>` or `<node>.<output port>`.

### Validation rules (all enforced by `validateRecipe`)

| Code | Rule |
|---|---|
| `frs.version` | `frs: "1.0"`, `kind: "recipe"` |
| `meta.ticker` | `^[A-Z0-9]{3,6}$` (also the on-chain recipe id) |
| `form.type` / `form.duplicate` | form fields have known types and unique ids |
| `form.long` (warning) | at most 6 form fields: *one short form, no chat* |
| `node.block` | every node uses a block in the catalog |
| `port.unwired` | every block input is connected |
| `port.ref` | references resolve |
| `port.type` | the wired type is assignable to the input type |
| `graph.cycle` | the graph is a DAG; execution order is a stable topological sort |
| `recipe.output` | the output reference resolves |
| `node.deadend` (warning) | a node whose output nobody uses is still billed |

The validator also returns `blocksUsed` (the billable list, in execution order), the union of `capabilities`, and `blockFees`.

### Drop-in swaps

`compatibleSwaps(recipe, nodeId)` returns every catalog block that can replace a node **without rewiring**:
- every existing input wire must be assignable to the candidate's input type (contravariant), and
- every output consumed downstream must exist on the candidate with a type each consumer accepts (covariant).

`swapBlock` carries over matching params and fills the new block's defaults.

## 4. Public listing

`publicListing(recipe)` is the only recipe-derived data the marketplace and the chain receive:
`ticker, name, creator, description, form, blocks, capabilities, output_type, price_per_run, royalty_bps, total_shares, interface_hash`.
Wiring, params and consts are **not** included, so the listing shows what a buyer must provide and which builders get paid, but not how the recipe works.

## 5. Sealing

`seal(payload, runnerEncPk, purpose)` produces an `frs-seal-v1` envelope: an anonymous NaCl box (ephemeral X25519 key, XSalsa20-Poly1305) over `canonical({salt, payload})`. The random salt stops anyone from confirming a guessed recipe against the on-chain hash.
On-chain commitment: `sealed_hash = sha256(canonical(envelope))`. Buyer inputs are sealed the same way, and their hash is the run's `inputs_hash`.

## 6. Execution and report

The runner refuses to execute unless `sha256(sealed recipe) == recipe.sealed_hash` and `sha256(sealed inputs) == run.inputs_hash` on-chain, and the run is `Pending` (paid).
It executes nodes in topological order, then signs:

```
frs-run-v1|<contract>|<run_id>|<recipe_id>|<ok|fail>|<output_hash>|<blocks_used,…>
```

`report_run` verifies this with `env::ed25519_verify` and settles. `blocks_used` must be a sub-multiset of the recipe's registered blocks, so a runner cannot bill blocks the recipe doesn't contain.
