# SRS-1: Sealed Recipe Standard (v1.0)

SRS-1 is the no-code / low-code format for composing **parts** (code, specialist agents or data sources) into workflows that can be **sealed, priced and settled**. It has four documents: a **part manifest** (published by a builder), a **job type** (a standard request buyers can post), a **recipe** (written by a creator, sealed) and a **public listing** (derived from the recipe, which is all the market sees).

Reference implementation: [`core/src/srs.ts`](../core/src/srs.ts). Catalogs: [`standard/parts.json`](../standard/parts.json), [`standard/jobs.json`](../standard/jobs.json).

## 1. Types

Ports are typed with named types. A type may `extend` one parent (nominal subtyping):

```json
"address.near":       { "extends": null },
"address.near.fresh": { "extends": "address.near" }
```

A value of type `A` may be wired into a port of type `B` iff `A == B` or `A` transitively extends `B`.
This is what makes swaps safe. A swap part that needs a *proven-fresh* address (`address.near.fresh`) cannot be fed a raw form field, but a part that accepts any `address.near` can take a fresh one.

## 2. Part manifest

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
- `capabilities` are **enforced**. The runner gives each part a `fetch` that rejects hosts not declared as `net:<host>` (see `guardedFetch`). `wallet:approve` means the part may ask the buyer to sign transactions. It can never sign them itself.
- `params.secret: true` marks the creator's edge (prompts, thresholds, routing choices). These values are only present in the sealed recipe.
- `fee_per_call` is paid to `author` in every settlement in which the part ran.

### 2.1 Disclosure and withdrawal risk

Every part declares where its value lives, in four layers, plus where it runs:

```json
"disclosure": {
  "model":        { "kind": "open-weights", "name": "Qwen/Qwen3-30B-A3B-Instruct-2507", "host": "NEAR AI Cloud (private, TEE)" },
  "instructions": "sealed",
  "harness":      "open",
  "verification": "open",
  "runtime":      "bundled"
}
```

- `model.kind` is `none` (plain code), `open-weights` or `closed`.
- `instructions` covers prompts and settings. `harness` covers tools, data lookups and retry logic. `verification` is how the part checks its own result. Each is `open` (published), `sealed` (escrowed to the TEE runner, so it can be rebuilt without anyone seeing it) or `closed` (held only by the supplier).
- `runtime` is `bundled` (the code ships inside the attested runner image, pinned by hash) or `remote` (the supplier operates it as a service).

**Clause.** Parts must disclose their model. Parts on open-weights models carry low withdrawal risk, because anyone can re-host the weights. Parts on closed models carry high withdrawal risk, because the provider can retire, change or reprice the model at any time. A part is only truly rebuildable if every layer is open or sealed.

`withdrawalRisk()` derives the label:

| Risk | Rule |
|---|---|
| **high** | closed model, or a remote part with a closed harness or closed verification |
| **medium** | remote part whose layers are all open or sealed (rebuildable, but the operator can stop the service) |
| **low** | bundled part with no model or an open-weights model |

A recipe's risk is the highest risk of its parts. The validator warns (`part.closed-model`) when a recipe uses a closed model, and the risk is shown on every listing and quote.

### 2.2 Per-run resource limits

```json
"limits": { "max_ms": 20000, "max_http_calls": 12, "max_model_calls": 2, "max_output_bytes": 32000 }
```

The runner enforces these for every part (`runner/src/limits.ts`):
- wall time, excluding time spent waiting for the buyer's wallet approval;
- HTTP calls;
- calls to model endpoints (`/chat/completions` on NEAR AI Cloud);
- output size.

A part that goes over fails the run, and the contract refunds the buyer. The buyer's price is fixed before the run, so a runaway part can never produce a surprise bill.

## 3. Recipe

```json
{
  "srs": "1.0", "kind": "recipe",
  "meta":   { "ticker": "CLNP", "name": "Clean up and protect", "creator": "chef.testnet", "description": "…" },
  "form":   [ { "id": "wallet", "label": "Wallet to clean", "type": "near.account", "required": true },
              { "id": "recipient", "label": "Fresh address", "type": "address.near", "generator": "fresh-implicit" } ],
  "nodes":  [ { "id": "scan", "part": "near.wallet-scanner@1.0.0", "inputs": { "account": "form.wallet" }, "params": {} },
              { "id": "fresh", "part": "addr.fresh-check@1.0.0",  "inputs": { "recipient": "form.recipient" } }, "…" ],
  "consts": { "usdc": { "type": "asset.id", "value": "nep141:…" } },
  "output": "swap.receipts",
  "listing": { "price_per_run": "750000", "reserve_bps": 1000, "bond": "25000000" }
}
```

References are `form.<field>`, `const.<name>` or `<node>.<output port>`.

### Validation rules (all enforced by `validateRecipe`)

| Code | Rule |
|---|---|
| `srs.version` | `srs: "1.0"`, `kind: "recipe"` |
| `meta.ticker` | `^[A-Z0-9]{3,6}$` (also the on-chain recipe id) |
| `form.type` / `form.duplicate` | form fields have known types and unique ids |
| `form.long` (warning) | at most 6 form fields: *one short form, no chat* |
| `node.part` | every node uses a part in the catalog |
| `port.unwired` | every part input is connected |
| `port.ref` | references resolve |
| `port.type` | the wired type is assignable to the input type |
| `graph.cycle` | the graph is a DAG; execution order is a stable topological sort |
| `recipe.output` | the output reference resolves |
| `node.deadend` (warning) | a node whose output nobody uses is still billed |

The validator also returns `partsUsed` (the billable list, in execution order), the union of `capabilities`, and `partFees`.

### Drop-in swaps

`compatibleSwaps(recipe, nodeId)` returns every catalog part that can replace a node **without rewiring**:
- every existing input wire must be assignable to the candidate's input type (contravariant), and
- every output consumed downstream must exist on the candidate with a type each consumer accepts (covariant).

`swapPart` carries over matching params and fills the new part's defaults.

## 4. Public listing

`publicListing(recipe)` is the only recipe-derived data the marketplace and the chain receive:
`ticker, name, creator, description, form, parts, capabilities, output_type, price_per_run, reserve_bps, interface_hash`.
Wiring, params and consts are **not** included, so the listing shows what a buyer must provide and which builders get paid, but not how the recipe works.

`listing.pricing` (`{price_floor, price_ceiling, target_runs}`) makes the price market-driven: `price_per_run` is the starting list price, which then follows paid runs per period inside the band (contract v6). Omitted, the price is fixed. `listing.reserve_bps` (0–10000) is the share of the creator's cut of each run that is added to the recipe's guarantee deposit instead of paid out. `listing.bond` is the deposit the creator posts at publish. Both are the creator's own collateral; a listing has no shares, supply or other investment fields.

## 5. Sealing

`seal(payload, runnerEncPk, purpose)` produces an `srs-seal-v1` envelope: an anonymous NaCl box (ephemeral X25519 key, XSalsa20-Poly1305) over `canonical({salt, payload})`. The random salt stops anyone from confirming a guessed recipe against the on-chain hash.
On-chain commitment: `sealed_hash = sha256(canonical(envelope))`. Buyer inputs are sealed the same way, and their hash is the run's `inputs_hash`.

## 6. Execution and report

The runner takes the recipe id from the paid run and refuses to execute unless `sha256(sealed recipe) == run.sealed_hash` (the snapshot taken at payment), `sha256(sealed inputs) == run.inputs_hash`, and the run is `Pending`. The sealed inputs carry a one-time `reply_to` key from the buyer's browser; everything the runner reports about the run, except coarse progress, is sealed to it.
It executes nodes in topological order, then signs:

```
srs-run-v3|<contract>|<run_id>|<recipe_id>|<ok|fail|abort>|<output_hash>|<delivered>|<parts_used,…>
```

`ok` settles; `fail` and `abort` refund the buyer and release any locked cover (`abort` means the runner chose not to execute, see §7, and is counted separately from failures). Once a run is verified as paid, pending and assigned to it, the runner signs a report on every exit path, so a buyer never waits for the reclaim timeout. Before executing, the runner also checks that the decrypted recipe uses exactly the parts listed on-chain; the public trust labels are computed from that list.

`report_run` verifies the signature with `env::ed25519_verify`. `parts_used` must be a sub-multiset of the recipe's registered parts, so a runner cannot bill parts the recipe doesn't contain.

## 7. Recipe intents: job types, quotes and bonds

A recipe's **bond** (shown to users as its *guarantee deposit*) is collateral the creator posts; it pays buyers shortfalls and nothing else.

A **job type** is a standard request that recipes compete to fulfil:

```json
{ "id": "job.wallet-cleanup@1.0.0", "name": "Clean up my wallet",
  "inputs": { "wallet": {"type": "near.account"}, "threshold_usd": {"type": "usd"}, "target": {"type": "asset.id"}, "recipient": {"type": "address.near"} },
  "output": "swap.receipts",
  "metric": { "name": "value_delivered", "unit": "payment-token" } }
```

A recipe opts in with `"implements": "job.wallet-cleanup@1.0.0"`. The validator requires its form fields to be exactly the job's inputs (types assignable) and its output type to match (`job.input`, `job.output`).

1. **Post.** The buyer seals `{inputs, salt, reply_to}` once to the attested runner and posts it with
   `job_hash = sha256(canonical({inputs, salt}))`. The random salt means the on-chain hash can't be brute-forced back to the wallet.
2. **Quote.** For each listed recipe implementing the type (capped), the runner checks the recipe against its on-chain hash and the job against `job_hash`. It then runs the recipe in **quote mode**: read-only, swaps priced with dry 1Click quotes, no approvals. The output is measured with the job's metric (value in payment-token units): `expected` from expected outputs, and `promised` from the post-slippage minimums. The runner signs
   `srs-quote-v3|<contract>|<recipe>|<sealed_hash>|<job_hash>|<inputs_hash>|<buyer>|<price>|<expected>|<promised>|<cover>|<expires_ns>`,
   where `inputs_hash` is the hash of the sealed job the buyer will pay with, `price` is the recipe's current market price (locked for this job), and `cover = min(promised, bond_available)`.
   A job may carry a `max_price`: recipes listed above it are not asked to quote.
   The whole quote is sealed to `reply_to`; the marketplace relays ciphertext, and the buyer's client checks the signature before paying.
3. **Choose.** The buyer, or an agent's policy, compares expected value, promise, price, privacy, withdrawal risk and the on-chain track record.
4. **Pay.** The signed quote rides in the run payment's `customRecipientMsg` (so its values become public; paying without a quote is always allowed and keeps them private). The contract checks the price (in the recipe's band, at most the buyer's `max_price`), then, in order: `job_hash` format, recipe version, runner active, signature, expiry, single use, `cover ≤ promised`, `bond_available ≥ cover`; then it locks `cover`.
5. **Re-check.** Right before executing, the runner re-prices the job in quote mode. If the fresh promise is below 98% of the quoted one (the wallet changed), it signs `abort`: the buyer is refunded and the cover goes back to the bond.
6. **Settle.** The runner measures `delivered` (for bonded runs, credited with any value the buyer withheld after the re-check: drained funds or deposits smaller than asked count at their quoted minimum, so the bond insures the market, not the buyer's own choices) and signs `srs-run-v3|…|ok|…|<delivered>|…`. The contract pays `min(max(0, promised − delivered), cover)` to the buyer from the locked cover, updates the recipe's track record and releases the rest.

A job with no implementing recipe gets no quotes.

## 8. Durable parts, settlement modes and versions

- **Durable parts.** A part that performs an irreversible step must call `ctx.saveState(state)` before it, and resume from `ctx.resumeState` when the runner restarts mid-part. Approvals relayed before a restart arrive as `ctx.priorApproval` and are valid only for the saved state. Waiting goes through `ctx.wait(ms)`, which does not count against `max_ms`. `intents.*-swap` and `time.wait` follow this contract; pure parts need nothing.
- **Settlement mode.** A recipe declares `listing.settle_mode`:
  - `"final"` (default): one receipt at the end;
  - `"checkpoint"`: each part's fee is paid on-chain when the part finishes; the final receipt pays the rest.
- **Versions.** A recipe's sealed graph can be replaced with notice (`update_sealed` → effective after the contract's `update_delay_ns`). Its parts list cannot change; a different parts list is a different recipe.


## 9. Conformance

A document conforms to SRS-1 when the reference checks accept it. The same functions run in the composer, the part builder, the runner and the test suite, so "conforms" means the same thing everywhere.

| Document | Check | Where |
|---|---|---|
| Part manifest | `validatePartManifest`: id `<namespace>.<name>@<semver>`, a known category, author account, a one-sentence summary, lower_snake_case ports and params with standard types, at least one output, `net:<host>` or `wallet:approve` capabilities (only `action` parts may ask for signatures), an integer fee, a full disclosure (§2.1), and limits (§2.2) | [`core/src/partkit.ts`](../core/src/partkit.ts) |
| Part source | `lintPartSource`: exports a `PartHandler`; uses `ctx.http`, never global `fetch`; no `process.env`, `require`, file system, `eval`; reads its declared inputs and returns every declared output; HTTP only with a `net:` capability; a part that asks for signatures handles `ctx.mode === "quote"` and saves and resumes state (§8); model calls go through the verified-chat helper | [`core/src/partkit.ts`](../core/src/partkit.ts) |
| Recipe | `validateRecipe` (§3) | [`core/src/srs.ts`](../core/src/srs.ts) |
| Job type | a recipe implementing it must match its inputs and output exactly (§7) | [`core/src/srs.ts`](../core/src/srs.ts) |

The source checks are static. They catch common mistakes, not malicious code. What protects buyers at run time is the runner: capabilities and limits are enforced on every part, and a part only runs once its code is in an audited runner release whose code hash buyers verify.

`npm test` runs the conformance suite: every part in the catalog passes both checks, and every seed recipe can be rebuilt in the composer from its job's form and its parts.

## 10. Adopting SRS-1

A marketplace for sealed recipes is only as useful as the number of parts, recipes and job types that speak the same format. SRS-1 is written to be adopted by anyone, not only this marketplace.

- **Part builders** publish a manifest that conforms (§9) and code that follows the part interface. A part is paid its fee in every settlement of every recipe that uses it, on any marketplace that settles SRS-1 reports.
- **Recipe creators** need no code: pick a job type, add parts, and the types decide what can connect.
- **Wallets and agents** post job types and compare signed quotes; they never need to see a recipe. A job type is a public, versioned interface any client can implement.
- **Other marketplaces and runners** can implement the same four documents, the quote message (§7) and the report message (§6). A recipe sealed to a conforming runner can be listed anywhere that verifies its attestation.

**Versioning.** Every part, job type and the standard itself carry a semantic version. Within 1.x, changes are additive: new types, new optional fields, new job types. A breaking change to a part or job type is a new major version with a new id, and the old one stays valid, so published recipes never break.

**Proposing changes.** New types and job types are proposed as SRS improvement proposals: the JSON definition, one recipe that implements it, and the conformance suite passing. The proposal process is not yet run by an independent body; that is a step for after the first external implementations.

**License.** The standard and its reference implementation are MIT licensed. Anyone may implement, extend or fork them.
