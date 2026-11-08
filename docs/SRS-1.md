# SRS-1: Sealed Recipe Spec (v1.1)

SRS-1 is an open format for building workflows ("recipes") out of other people's components ("parts") without writing code or prompts, and for selling runs of those workflows while their method stays secret. A recipe is a typed graph: the types decide what can connect, the buyer's form builds itself from what the parts need, and any part can be swapped for one that fits the same wires. Sealed to an attested runner, a recipe can be quoted, run and settled, with every part author paid in every run, and no one but its creator (and the attested runner, while it executes) can read it.

| | |
|---|---|
| Version | 1.1. Additive over 1.0: every 1.0 document is a 1.1 document with the same meaning (Appendix A) |
| Reference implementation | [`core/src/srs.ts`](../core/src/srs.ts) (validator), [`runner/src/executor.ts`](../runner/src/executor.ts) (run semantics), [`core/src/partkit.ts`](../core/src/partkit.ts) (composer, manifest checks) |
| Catalog | [`standard/parts.json`](../standard/parts.json): 15 types, 23 parts. Examples using 1.1: [`standard/examples/`](../standard/examples/) |
| Conformance suite | `npm test`, in particular [`tests/srs11.test.ts`](../tests/srs11.test.ts) |
| License | MIT |

MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. "The validator" is `validateRecipe`. Every rule given a validation code in this document is enforced by it, and the same function runs in the composer, the runner and the test suite.

## Why SRS-1

Workflow tools already compose steps, and oracle networks already run workflows with attested results. Neither was built for a market in which a stranger's workflow runs on your wallet and you pay per run. That market needs four properties at once. SRS-1 is designed around them:

1. **Composable without code.** Parts declare typed ports. A creator adds parts and the types wire them; whatever no part provides becomes a field on the buyer's form. Any node can be swapped for a catalog part that fits the same wires (§3.7).
2. **Sealed, but checkable.** The method (wiring, conditions, settings and prompts) is encrypted to the runner. What a buyer needs in order to decide is public and derived by machine, never typed by the creator: the form, the parts, their capabilities, models and withdrawal risk, the result type and the price (§4, §5).
3. **Quoted before it runs.** Every part has a read-only quote mode, so a recipe can be dry-run on a buyer's sealed inputs and return a signed price and, for recipes that deliver funds, a promise backed by the creator's deposit (§7).
4. **Settled to every author.** The parts list is on-chain, the runner signs which parts were billed, and one settlement pays the protocol, the runner, every part author and the creator (§6).

| | n8n | Chainlink CRE | SRS-1 |
|---|---|---|---|
| Unit of composition | nodes in a JSON workflow | capabilities called from Go or TypeScript, compiled to WASM | typed parts in a JSON graph |
| Who composes | a user in a visual editor | a developer | a creator, with no code and no prompt engineering |
| Who can read a workflow | anyone with access to the instance | its owner and the nodes that run it | only its creator; the runner opens it inside a TEE |
| Typing | untyped JSON items | the host language's types | nominal types with schemas, checked when composing and at every port while running (§1) |
| Control flow | IF, Switch, Merge, Loop, error workflows, sub-workflows | anything code can express | conditions, alternatives and skip-on-error (§3.2–3.4); loops and nested recipes are not in 1.1 (§13) |
| Price known before running | not part of the format | not part of the format | a signed quote from a read-only dry run (§7) |
| Who is paid per run | no payment to node authors | node operators | every part author, the runner and the creator, in one settlement |
| A step fails | the error workflow runs | handled in code | the buyer is refunded, or the node is skipped where the creator provided a fallback |

### A recipe in one screen

[`standard/examples/ESCL.json`](../standard/examples/ESCL.json), shortened:

```json
{ "srs": "1.1", "kind": "recipe",
  "meta":  { "ticker": "ESCL", "name": "Contract check, escalated only when needed", "creator": "chef.testnet", "description": "…" },
  "form":  [ { "id": "contract", "label": "Contract you are about to sign for", "type": "near.account", "required": true } ],
  "nodes": [
    { "id": "facts",  "part": "near.contract-facts@1.0.0", "inputs": { "contract": "form.contract" } },
    { "id": "rules",  "part": "rules.contract-risk@1.0.0", "inputs": { "facts": "facts.facts" }, "params": { "lookalikes": ["ref-finance", "…"] } },
    { "id": "judge",  "part": "ai.contract-risk@1.0.0",    "inputs": { "facts": "facts.facts" }, "params": { "policy": "…" },
      "when": { "ref": "rules.verdict", "match": { "risk": ["medium", "high"] } } },
    { "id": "report", "part": "report.contract@1.0.0",     "inputs": { "facts": "facts.facts", "verdict": ["judge.verdict", "rules.verdict"] } } ],
  "output": "report.report",
  "listing": { "price_per_run": "150000", "bill": "declared" } }
```

- **The buyer sees** one form field, four parts (one private AI on an open-weights model in a TEE, so the recipe is labelled low withdrawal risk), a `report` result and a price.
- **Sealed:** that the AI is consulted only when cheap rules are unsure or alarmed, which brands the rules watch for, what the AI is told, and that the report prefers the AI's verdict. That is the creator's edge: a careful second opinion where it matters, and a fast answer where it does not.
- **Settlement:** with `bill: "declared"` every run pays the same four authors whether or not the AI ran, so nothing on-chain reveals what the rules concluded about this buyer's contract (§6.1).
- **Checked before sealing:** the validator confirms that `risk` is a field of `contract.verdict` and that `medium` and `high` are values it can take (§3.2), that both alternatives for `verdict` have the type the report needs (§3.3), and that the result is present on every path (§3.5).

## Conventions

- **Canonical JSON.** `canonical(x)` is JSON with object keys sorted, no whitespace and `undefined` members omitted. Every hash in SRS-1 is the SHA-256 (hex) of canonical JSON ([`core/src/canonical.ts`](../core/src/canonical.ts)).
- **Amounts** are decimal strings of integers in the payment token's smallest unit. The reference deployment settles in USDC (6 decimals): `"10000"` is $0.01.
- **Identifiers.** References are split at their first `.`, so the names that start a reference cannot contain one.

| Name | Grammar | Example |
|---|---|---|
| part id | `<namespace>.<name>@<major>.<minor>.<patch>`, lower case, at most 64 characters | `intents.confidential-swap@1.0.0` |
| type | dot-separated lower-case segments | `address.near.fresh` |
| type variable | one capital letter | `T` |
| port, param | `[a-z_][a-z0-9_]*` | `max_share` |
| node id, form field id, constant name | `[a-z][a-z0-9_]{0,31}` | `judge` |
| ticker (the on-chain recipe id) | `[A-Z0-9]{3,6}` | `ESCL` |
| reference | `form.<field>`, `const.<name>` or `<node>.<port>` | `rules.verdict` |
| binding | a reference, or (1.1) a non-empty list of references | `["judge.verdict", "rules.verdict"]` |

## 1. Types

Ports, form fields and constants are typed with named types from the catalog.

### 1.1 Nominal subtyping

A type may `extend` one parent:

```json
"address.near":       { "extends": null },
"address.near.fresh": { "extends": "address.near" }
```

A value of type `A` may be wired into a port of type `B` iff `A == B` or `A` transitively extends `B`. This is what makes swaps safe: a swap part that needs a *proven-fresh* address (`address.near.fresh`) cannot be fed a raw form field, but a part that accepts any `address.near` can take a fresh one. A type marked `"proof": true` can only come from a part output, never from the buyer's form or a constant (`type.proof`). `address.near.fresh` is such a type: the only way to obtain one is from a part that checks the chain (`addr.fresh-check`), so the type is a certificate, not a label.

### 1.2 Value schemas

A type MAY declare a `schema` in this subset of JSON Schema: `type` (`string`, `number`, `integer`, `boolean`, `object`, `array`, `null`), `enum`, `pattern`, `minimum`, `maximum`, `properties`, `required` and `items`. Other keywords are not part of SRS-1.1.

```json
"contract.verdict": { "extends": null, "description": "Risk verdict on a contract",
  "schema": { "type": "object", "required": ["risk", "reasons", "source"],
              "properties": { "risk": { "type": "string", "enum": ["low", "medium", "high"] }, "reasons": { "type": "array", "items": { "type": "string" } } } } }
```

A value is of type `A` iff it satisfies the schema of `A` and of every type `A` extends (`checkValue`). Schemas are enforced in three places:
- the validator checks every constant (`const.value`) and every field a condition names (`when.field`, `when.value`);
- the runner checks every output of every part against the type of its port before any other part sees it. A part that returns anything else fails the run, and the buyer is refunded. A faulty or malicious part therefore cannot hand the next part a value that breaks its type's schema, in particular not a part that builds the transactions a buyer signs;
- quote mode runs the same checks, so a part that returns ill-typed values usually fails at quote time, before anyone pays.

Every catalog type declares a schema or inherits one.

### 1.3 Type variables

A manifest MAY declare type variables, and its ports MAY use them as types:

```json
{ "id": "util.pick@1.0.0", "type_params": { "T": { "extends": null } },
  "inputs": { "a": { "type": "T" }, "b": { "type": "T" } }, "outputs": { "out": { "type": "T" } } }
```

In a recipe, each node binds each variable to the most specific type that every value wired to a port of that variable is assignable to (their join; with single inheritance, the nearest common ancestor). Alternatives in a binding all count. The node's outputs of that type have the bound type.

- `util.pick(fresh, fresh)` outputs `address.near.fresh` and can feed a swap that requires a fresh address. `util.pick(fresh, raw)` outputs `address.near` and cannot.
- If the wired types have no common ancestor, the validator reports `port.generic`. If the join is not within the variable's bound (`extends`), it reports `port.type`.
- In a manifest, a variable MUST be used by at least one input (`type_params.unbound` otherwise), so a recipe can always bind it.

Without variables every utility exists once per type: the 1.0 catalog's `swap.merge` only merges receipts and `time.wait` only delays holdings. With them, one merge, wait, pick or dedupe serves every type, and its author is paid in every domain that uses it.

### 1.4 The standard vocabulary

| Group | Types (`extends`) | Buyer can type it |
|---|---|---|
| Identities | `near.account`, `address.near`, `address.near.fresh` (address.near), `asset.id` | all but `address.near.fresh` (`proof`), which only a guard can produce |
| Quantities | `usd`, `percent` | yes |
| Wallet state | `token.holdings`, `key.list`, `stake.list`, `contract.facts` | no: read by source parts |
| Judgements | `token.flags`, `contract.verdict` | no |
| Plans and results | `swap.plan`, `swap.receipts`, `report` | no |

`swap.receipts` is the result type whose value a quote can promise and a bond can back (§7): receipts of value delivered to the buyer's recipient, which staking withdrawals and claimed drops also produce. The vocabulary grows by proposal (§10).

## 2. Part manifest

```json
{
  "id": "intents.confidential-swap@1.0.0",
  "name": "Confidential Swap (Intents)",
  "category": "action",
  "author": "veil.testnet",
  "summary": "Quotes every token into the target asset via 1Click with confidentiality=basic, so deposits and withdrawals cannot be linked on-chain.",
  "inputs":  { "tokens": { "type": "token.holdings" }, "to": { "type": "address.near.fresh" }, "target": { "type": "asset.id" } },
  "outputs": { "receipts": { "type": "swap.receipts" } },
  "params":  { "slippage_bps": { "type": "number", "default": 100, "secret": true } },
  "capabilities": ["net:1click.chaindefuser.com", "wallet:approve"],
  "fee_per_call": "50000",
  "disclosure": { "…": "§2.1" },
  "limits": { "…": "§2.2" }
}
```

- `id` is registered on-chain with `manifest_hash = sha256(canonical(manifest))`. A published id never changes meaning; a new behaviour is a new version.
- `category` is one of `source` (reads the world from an identity), `guard` (narrows a value or certifies it, as `addr.fresh-check` does), `transform` (pure computation), `action` (changes the world) and `sink` (turns values into a report). Only `action` parts may declare `wallet:approve`.
- `capabilities` are **enforced**. The runner gives each part an HTTP function that rejects hosts not declared as `net:<host>` (`guardedFetch`). `wallet:approve` means the part may ask the buyer to sign transactions. It can never sign them itself.
- `params` are typed `string`, `number`, `boolean` or `string[]`. `secret: true` marks the creator's edge (prompts, thresholds, routing choices); those values exist only inside the sealed recipe.
- `type_params` declares type variables (§1.3).
- `fee_per_call` is paid to `author` for every node that uses the part, in every settlement that bills it (§6.1).

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

Parts MUST disclose their model. Parts on open-weights models carry low withdrawal risk, because anyone can re-host the weights. Parts on closed models carry high withdrawal risk, because the provider can retire, change or reprice the model at any time. A part is only truly rebuildable if every layer is open or sealed. `withdrawalRisk()` derives the label:

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

The runner enforces these for every part ([`runner/src/limits.ts`](../runner/src/limits.ts)): wall time (excluding time spent waiting for the buyer's wallet), HTTP calls, calls to model endpoints, and output size. A part that goes over fails the run (or is skipped, if the recipe allows it, §3.4). The buyer's price is fixed before the run, so a runaway part can never produce a surprise bill.

## 3. Recipe

```json
{
  "srs": "1.1", "kind": "recipe",
  "meta":   { "ticker": "CLNP", "name": "Clean up and protect", "creator": "chef.testnet", "description": "…" },
  "form":   [ { "id": "wallet", "label": "Wallet to clean", "type": "near.account", "required": true },
              { "id": "recipient", "label": "Fresh address", "type": "address.near", "generator": "fresh-implicit" } ],
  "nodes":  [ { "id": "scan",  "part": "near.wallet-scanner@1.0.0", "inputs": { "account": "form.wallet" }, "params": {} },
              { "id": "fresh", "part": "addr.fresh-check@1.0.0",    "inputs": { "recipient": "form.recipient" } }, "…" ],
  "consts": { "usdc": { "type": "asset.id", "value": "nep141:…" } },
  "output": "swap.receipts",
  "listing": { "price_per_run": "750000", "reserve_bps": 1000, "bond": "25000000" }
}
```

| Field | Meaning |
|---|---|
| `srs` | `"1.0"` or `"1.1"`. The features marked (1.1) below require `"1.1"` (`srs.feature`), so a 1.0 runner never misreads a 1.1 recipe |
| `form` | what the buyer is asked: typed fields, at most 6 recommended (`form.long`). `generator: "fresh-implicit"` lets the buyer's browser generate a new address |
| `nodes` | each uses one catalog part, binds every input, and sets params (`params` may be omitted). Optional: `when` (1.1, §3.2), `on_error` (1.1, §3.4) |
| `consts` | typed fixed values; checked against their type's schema |
| `output` | the result: a binding (§3.1). Its type is the recipe's `output_type` |
| `listing` | price and collateral (§4), `settle_mode` (§8), `bill` (1.1, §6.1) |

### 3.1 References and bindings

A reference is `form.<field>`, `const.<name>` or `<node>.<port>`. A binding is one reference, or (1.1) a list of references (§3.3). Node inputs and the recipe's `output` are bindings; a condition reads one reference. Nodes may be declared in any order: execution follows dependencies (§3.5).

### 3.2 Conditions (1.1)

A node with `when` runs only if its condition holds:

```json
"when": { "ref": "rules.verdict", "match": { "risk": ["medium", "high"] } }
```

A condition has exactly one test (`when.shape`):

| Test | Holds when |
|---|---|
| `"is": "nonempty"` (default) | the value is present and not an empty list, an empty object, `null` or `""` |
| `"is": "empty"` | the opposite; a value that is absent because its node was skipped is empty |
| `"match": { field: [values] }` | the value is an object, and each listed field has one of the listed values |
| `"some": { field: [values] }` | the value is a list, and at least one item matches every listed field |

`"not": true` negates the test; that is how a recipe writes the *else* branch. The validator resolves `ref` (`when.ref`), checks that `match` reads an object type and `some` a list type, and checks every field and value against the type's schema (`when.field`, `when.value`). A condition on a type without a schema is allowed with a warning (`when.unchecked`).

Conditions are expressed over typed values that parts produce, not as code or text expressions. That keeps them checkable when composing, editable in a no-code UI and impossible to use as an escape hatch: a condition can choose whether a part runs, never what it does.

### 3.3 Alternatives (1.1)

A binding that lists several references takes the first one that is present when the node runs:

```json
"inputs": { "verdict": ["judge.verdict", "rules.verdict"] }
```

Every alternative MUST be assignable to the port's type (`port.type`); for a port typed with a variable, every alternative counts towards its binding (§1.3). Repeats are not allowed (`port.alternatives`). The node depends on every node its alternatives name. A recipe `output` may list alternatives too; its `output_type` is their join.

### 3.4 Skipping on error (1.1)

`"on_error": "skip"` lets a run continue when that node's part fails: it throws, exceeds a limit (§2.2) or returns a value that is not of its declared type (§1.2). The node is then skipped (§3.5). The default, `"fail"`, fails the run and refunds the buyer.

A part with `wallet:approve` MUST NOT be skipped on error (`node.on_error`): once it has asked the buyer to sign, funds may already have moved, and continuing would build the rest of the run on an unknown state.

### 3.5 Execution semantics

The runner ([`execute`](../runner/src/executor.ts)) MUST behave as follows; quotes (§7) use the same steps in quote mode.

1. Validate the recipe and the buyer's inputs against the form. Order the nodes topologically; ties keep declaration order, so the order is deterministic.
2. A reference is **present** if it names a form field, a constant, or an output of a node that ran. A binding resolves to its first present reference.
3. For each node in order:
   - if an input binding has no present reference, the node is **skipped**;
   - otherwise, if it has a condition that does not hold on the resolved value of `ref` (an absent value is "empty", §3.2), it is skipped;
   - otherwise its part runs with the resolved inputs and with params set to the manifest defaults overridden by the node's params, under its limits. Each declared output MUST be present and of its port's type (§1.2). If the part fails, the node is skipped when it has `on_error: "skip"`, and the run fails otherwise.
4. The result is the first present reference of `output`. If none is present, the run fails.
5. A run that succeeds is reported `ok` and bills parts as in §6.1. A run that fails bills nothing and refunds the buyer.

Skipping spreads: a node that needs a value only a skipped node could provide (with no present alternative) is skipped too, so a branch that does not run does nothing downstream. The validator computes the nodes that may be skipped (`optional` in its result) and warns when the result itself may be absent (`recipe.output-optional`). It recognises the two shapes in which one of two alternatives always runs, provided neither node can be skipped for another reason: a fallback (`b` has `when: { "ref": "a.<port>", "is": "empty" }`) and an if / else (`a` and `b` have the same test on the same value, one with `not: true`).

Common shapes, with the n8n node that does the same job:

| Pattern | n8n | SRS-1 |
|---|---|---|
| If / else | IF | two nodes, one with `when` and one with the same `when` and `not: true`, joined by a binding with both as alternatives |
| Switch | Switch | several nodes with `match` on different values of one verdict |
| Escalate only when needed | IF, then Merge | [`ESCL`](../standard/examples/ESCL.json): `match` on the cheap verdict, alternatives in the report |
| Fall back when a provider fails | error output or error workflow | [`FALL`](../standard/examples/FALL.json): `on_error: "skip"`, a fallback with `is: "empty"`, alternatives |
| Act only if something needs doing | IF before an action | `when: { "ref": "risk.risky", "some": { "action": ["revoke"] } }` on the action node |
| Merge two streams | Merge | a part with two inputs (`swap.merge`), or a generic one (§1.3) |
| Wait | Wait | `time.wait`, durable across runner restarts (§8) |

### 3.6 Validation rules

All enforced by `validateRecipe` ([`core/src/srs.ts`](../core/src/srs.ts)). Errors block sealing; warnings are shown to the creator.

| Code | Severity | Rule |
|---|---|---|
| `srs.version` | error | `srs` is `"1.0"` or `"1.1"`, `kind` is `"recipe"` |
| `srs.feature` | error | conditions, `on_error`, alternatives and `bill` require `srs: "1.1"` |
| `meta.ticker`, `meta.name` | error | ticker `^[A-Z0-9]{3,6}$` (the on-chain recipe id); a name |
| `form.id`, `form.duplicate`, `form.type` | error | field ids match the identifier grammar, are unique and have known types |
| `type.proof` | error | no form field or constant has a `proof` type (§1.1) |
| `form.long`, `form.unused` | warning | at most 6 fields (*one short form, no chat*); every field is used |
| `const.id`, `const.type`, `const.value` | error | constant names match the grammar; types are known; values satisfy the type's schema |
| `listing.price`, `listing.reserve`, `listing.bond`, `listing.pricing`, `listing.settle_mode`, `listing.bill` | error | positive integer price; `reserve_bps` in 0–10000; integer bond; `price_floor ≤ price_per_run ≤ price_ceiling` and `target_runs ≥ 1`; known modes |
| `recipe.empty`, `node.id`, `node.duplicate`, `node.reserved`, `node.part` | error | at least one node; node ids match the grammar, are unique, are not `form` or `const`, and use catalog parts |
| `port.unwired`, `port.ref`, `port.alternatives` | error | every input is bound; every reference resolves; lists are non-empty without repeats |
| `port.type`, `port.generic` | error | every alternative is assignable to its port; type variables bind within their bounds (§1.3) |
| `port.extra`, `param.missing` | warning | a binding for a port the part does not have; an unset secret param with no default |
| `when.shape`, `when.ref`, `when.field`, `when.value` | error | §3.2 |
| `when.unchecked` | warning | the condition reads a type without a schema |
| `node.on_error` | error | `on_error` is `fail` or `skip`, and never `skip` on a signing part (§3.4) |
| `graph.cycle` | error | the graph is acyclic |
| `recipe.output` | error | the result binding resolves and its alternatives have a common type |
| `recipe.output-optional` | warning | on some runs the result may be skipped (the run would fail and be refunded) |
| `node.deadend` | warning | a node whose output nothing reads (it is still billed) |
| `bill.reveals-branch` | warning | `bill: "executed"` with nodes that may be skipped (§6.1) |
| `param.secret-egress` | warning | a secret param is set on a part that can reach a host outside the confidential set (§5.4) |
| `part.closed-model` | warning | a part runs on a closed model (§2.1) |

The validator also returns the execution order, the billable parts, the union of capabilities, the sum of part fees, the risk, the resolved type of every node output and the set of nodes that may be skipped.

### 3.7 Drop-in swaps

`compatibleSwaps(recipe, nodeId)` returns every catalog part that can replace a node **without rewiring**: the candidate has an existing binding for each of its inputs, still has every output the recipe reads from the node, and substituting it introduces no new validation error. So every existing wire must be assignable to the candidate's inputs (contravariant), and every consumer, condition included, must accept the candidate's outputs (covariant), with type variables bound as usual. `swapPart` carries over matching params and fills the new part's defaults. A swap changes the parts list, so a published recipe that swaps a part is published as a new recipe (§8).

## 4. Public listing

`publicListing(recipe)` is the only recipe-derived data the marketplace and the chain receive:
`ticker, name, creator, description, form, parts, capabilities, output_type, price_per_run, pricing, reserve_bps, interface_hash`, plus the risk, disclosure and privacy labels, which are recomputed from the parts and never taken from the creator (`labelsFromParts`).

- `parts` is the recipe's parts as a **sorted multiset**: one entry per node, in lexicographic order (1.1; in 1.0 it was in execution order). The contract needs the multiset to bill and to check reports (§6); the order is part of the method and stays sealed.
- `interface_hash = sha256(canonical({form, parts, output_type}))` identifies what a buyer interacts with, independently of how the recipe works inside.
- Wiring, conditions, params and constants are **not** included.

`listing.pricing` (`{price_floor, price_ceiling, target_runs}`) makes the price market-driven: `price_per_run` is the starting list price, which then follows paid runs per period inside the band. Omitted, the price is fixed. `listing.reserve_bps` (0–10000) is the share of the creator's cut of each run that is added to the recipe's guarantee deposit instead of paid out. `listing.bond` is the deposit the creator posts at publish. Both are the creator's own collateral; a listing has no shares, supply or other investment fields.

## 5. Sealing and the privacy boundary

### 5.1 Envelopes

`seal(payload, runnerEncPk, purpose)` produces an `srs-seal-v1` envelope: an anonymous NaCl box (ephemeral X25519 key, XSalsa20-Poly1305) over `canonical({salt, payload})`. The random salt stops anyone from confirming a guessed recipe against the on-chain hash. On-chain commitment: `sealed_hash = sha256(canonical(envelope))`. Buyer inputs are sealed the same way, and their hash is the run's `inputs_hash`.

The creator's client seals a second copy of each published version (purpose `creator-copy`) to a key only the creator can re-derive: `X25519 secret = sha256("srs-creator-key-v1" || signature)`, where the signature is the creator's wallet signing a fixed NEP-413 message ([`core/src/creator.ts`](../core/src/creator.ts)). Ed25519 signatures are deterministic, so the creator can reopen and edit any version from any device, and nothing is stored in the browser.

### 5.2 Who can read what

| Party | Recipe method (wiring, conditions, params, constants) | Buyer's inputs and result | Public listing |
|---|---|---|---|
| Creator | yes, from the creator copy | no | yes |
| Runner (attested TEE) | yes, only in memory, only for a paid run or a quote | yes, same | yes |
| Buyer | no | yes, sealed to a one-time `reply_to` key from their browser | yes |
| Marketplace operator | no: stores ciphertext only (a test checks the server never imports the decryption function) | no | yes |
| Chain and the public | `sealed_hash` only | `inputs_hash`, a salted `output_hash`, the billed parts and, if the buyer chose a bonded quote, the quote's values | yes |
| Part authors | no; their code receives only its own inputs and params | only what their part is given | yes |
| Hosts a part calls | only what that part sends them (§5.4) | same | — |
| Reviewers | no | no | yes |

### 5.3 What the public data reveals

Sealing hides a recipe's text, not what can be inferred from its interface. Typed ports are what make composition no-code, and they also constrain how parts can be wired. Enumerating every wiring of the public parts that validates, has no dead ends and uses every form field, the 10 seed recipes have: one candidate wiring (ATOM, EXIT, KEYS, STAK), two (CLNP, SWPR, TRIM), three (CHEK), five (SAFE) and 144 (TRCH). For simple linear recipes the structure is therefore guessable, and their sealed edge is in their params, constants and conditions: the prompt a classifier is given, the thresholds, the brands on a watch list, the slippage, which branch handles which case. SRS-1 is designed so that this is where the value lives, and 1.1 widens it: conditions and alternatives add sealed decisions that the interface does not constrain.

1.1 closes the channels through which the method or a buyer's data used to leak:

| Channel | 1.0 | 1.1 |
|---|---|---|
| Order of `parts` in the listing and reports | execution order | sorted multiset (§4) |
| Run events in the clear | part names, node ids and order per run | step `i` of `n` only, for run and skipped steps alike; everything else sealed to the buyer |
| Approvals relayed by the marketplace | keyed by node id | keyed by step number |
| Which branch ran for a buyer | — | hidden by default: `bill: "declared"` (§6.1) |
| `output_hash` of a short result (a verdict) | `sha256({run_id, output})`, confirmable by guessing | includes a random salt that only the buyer receives |

What remains observable, by design or by physics: the number of steps; how long each step takes (a skipped step finishes at once); in `checkpoint` settlement mode, when each part is billed (§8); the values of a bonded quote, which the contract must enforce (§7); and the requests a part makes to the hosts it declares.

### 5.4 Secret params and egress

A secret param is only as private as the hosts its part can reach. The validator warns (`param.secret-egress`) when a node sets a secret param on a part that can reach a host outside the confidential set: public NEAR data hosts (read-only; the request carries no secret) and NEAR AI Cloud's attested private inference (`CONFIDENTIAL_HOSTS` in [`core/src/srs.ts`](../core/src/srs.ts)). Parts that send data to any new host are admitted only after human review (§11), which asks specifically whether that data needs to leave the runner.

## 6. Execution and report

The runner takes the recipe id from the paid run and refuses to execute unless `sha256(sealed recipe) == run.sealed_hash` (the snapshot taken at payment), `sha256(sealed inputs) == run.inputs_hash`, and the run is `Pending`. Before executing, it also checks that the decrypted recipe uses exactly the parts listed on-chain; the public trust labels are computed from that list. The sealed inputs carry a one-time `reply_to` key from the buyer's browser; everything the runner reports about the run, except coarse progress (§5.3), is sealed to it.

It executes the recipe as in §3.5, then signs:

```
srs-run-v3|<contract>|<run_id>|<recipe_id>|<ok|fail|abort>|<output_hash>|<delivered>|<parts_used,…>
```

- `output_hash = sha256(canonical({run_id, salt, output}))`. The random `salt` is sealed to the buyer with the output, so the buyer can check the commitment and nobody else can test guesses against it.
- `parts_used` is the sorted multiset of billed parts (§6.1); empty for `fail` and `abort`.
- `ok` settles; `fail` and `abort` refund the buyer and release any locked cover (`abort` means the runner chose not to execute, §7, and is counted separately from failures). Once a run is verified as paid, pending and assigned to it, the runner signs a report on every exit path, so a buyer never waits for the reclaim timeout.

`report_run` verifies the signature with `env::ed25519_verify`. `parts_used` must be a sub-multiset of the recipe's registered parts, so a runner cannot bill parts the recipe does not contain.

### 6.1 Billing (1.1)

`listing.bill` decides which parts an `ok` run pays:

- `"declared"` (default): every node, run or skipped. Every successful run of a recipe produces the same settlement, so the chain shows nothing about which branch ran for a buyer. The creator pays for privacy with the fees of parts that did not run; the buyer's price is unchanged.
- `"executed"`: only the nodes that ran. The creator keeps more of the price when optional branches are expensive, but each settlement reveals which ones ran, and the validator warns (`bill.reveals-branch`).

For a recipe without conditions or `on_error`, every node runs and both modes bill the same parts as 1.0 did.

## 7. Quotes and guarantees

A recipe's **bond** (shown to users as its *guarantee deposit*) is collateral the creator posts; it pays buyers shortfalls and nothing else.

A buyer asks one recipe for a quote on their own inputs, filled in from the recipe's public form (§4). A buyer or an agent may ask several recipes and compare; nothing in the format groups recipes or makes them answer together.

**Value delivered.** A recipe whose result type is `swap.receipts` (or a subtype) has a measurable value: what reached the buyer's recipient, in payment-token units. Only such a recipe can promise a value in its quote and back the promise with its bond. Any other recipe (a report, a key cleanup) quotes its price alone, with `expected = promised = cover = 0`.

1. **Seal.** The buyer seals `{inputs, salt, reply_to}` once to the attested runner, with `job_hash = sha256(canonical({inputs, salt}))`. ("Job" is the buyer's sealed request; the name is kept in the contract.) The random salt means the on-chain hash cannot be brute-forced back to the wallet. One sealed request can be sent to several recipes.
2. **Quote.** The runner checks the recipe against its on-chain hash and the request against `job_hash`. It then runs the recipe in **quote mode**: read-only, swaps priced with dry 1Click quotes, no approvals. For a recipe with a value delivered, `expected` comes from expected outputs and `promised` from the post-slippage minimums. The runner signs
   `srs-quote-v3|<contract>|<recipe>|<sealed_hash>|<job_hash>|<inputs_hash>|<buyer>|<price>|<expected>|<promised>|<cover>|<expires_ns>`,
   where `inputs_hash` is the hash of the sealed request the buyer will pay with, `price` is the recipe's current market price (locked for this request), and `cover = min(promised, bond_available)`. A request may carry a `max_price`: a recipe listed above it is not asked to quote. The whole quote is sealed to `reply_to`; the marketplace relays ciphertext, and the buyer's client checks the signature before paying.
3. **Choose.** The buyer, or an agent's policy, weighs expected value, promise, price, privacy, withdrawal risk and the on-chain track record.
4. **Pay.** The signed quote rides in the run payment's `customRecipientMsg` (so its values become public; paying without a quote is always allowed and keeps them private). The contract checks the price (in the recipe's band, at most the buyer's `max_price`), then, in order: `job_hash` format, recipe version, runner active, signature, expiry, single use, `cover ≤ promised`, `bond_available ≥ cover`; then it locks `cover`.
5. **Re-check.** Right before executing, the runner re-prices the run in quote mode. If the fresh promise is below 98% of the quoted one (the wallet changed), it signs `abort`: the buyer is refunded and the cover goes back to the bond.
6. **Settle.** The runner measures `delivered` (for bonded runs, credited with any value the buyer withheld after the re-check: drained funds or deposits smaller than asked count at their quoted minimum, so the bond insures the market, not the buyer's own choices) and signs `srs-run-v3|…|ok|…|<delivered>|…`. The contract pays `min(max(0, promised − delivered), cover)` to the buyer from the locked cover, updates the recipe's track record and releases the rest.

Conditions are evaluated in quote mode exactly as in a run, so a quote prices the branch the run would take on the buyer's inputs at quote time. For a recipe that delivers value, the re-check in step 5 catches any change in the wallet that lowers the promise, whichever branch it causes.

## 8. Durable parts, settlement modes and versions

- **Durable parts.** A part that performs an irreversible step must call `ctx.saveState(state)` before it, and resume from `ctx.resumeState` when the runner restarts mid-part. Approvals relayed before a restart arrive as `ctx.priorApproval` and are valid only for the saved state. Waiting goes through `ctx.wait(ms)`, which does not count against `max_ms`. `intents.*-swap` and `time.wait` follow this contract; pure parts need nothing. Checkpoints record skipped nodes too, so a resumed run takes the same branches.
- **Settlement mode.** A recipe declares `listing.settle_mode`:
  - `"final"` (default): one receipt at the end;
  - `"checkpoint"`: each part's fee is paid on-chain when the part finishes; the final receipt pays the rest, including (with `bill: "declared"`) skipped nodes. Checkpoints make long runs safe for part authors, at the cost of revealing on-chain when each part finished (§5.3).
- **Versions.** A recipe's sealed graph can be replaced with notice (`update_sealed` → effective after the contract's `update_delay_ns`). Its parts list cannot change; a different parts list is a different recipe.

## 9. Conformance

A document conforms to SRS-1 when the reference checks accept it. The same functions run in the composer, the part builder, the runner and the test suite, so "conforms" means the same thing everywhere.

| Document | Check | Where |
|---|---|---|
| Part manifest | `validatePartManifest`: id `<namespace>.<name>@<semver>`, a known category, author account, a one-sentence summary, lower_snake_case ports and params with the spec's types, type variables that are single capitals with known bounds and are bound by an input (§1.3), at least one output, `net:<host>` or `wallet:approve` capabilities (only `action` parts may ask for signatures), an integer fee, a full disclosure (§2.1), and limits (§2.2) | [`core/src/partkit.ts`](../core/src/partkit.ts) |
| Part source | `lintPartSource`: exports a `PartHandler`; uses `ctx.http`, never global `fetch`; no `process.env`, `require`, file system, `eval`; reads its declared inputs and returns every declared output; HTTP only with a `net:` capability; a part that asks for signatures handles `ctx.mode === "quote"` and saves and resumes state (§8); model calls go through the verified-chat helper | [`core/src/partkit.ts`](../core/src/partkit.ts) |
| Part source, security | `securityScan`: imports only the runner helpers and `node:crypto`; no dynamic `import()`, `require`, `process`, global object, `eval` or `Function`, prototype or reflection tricks, WebAssembly, workers or network functions; no text decoded at run time or hidden in escapes; every host the code names is declared; code that builds transactions declares `wallet:approve` | [`core/src/review.ts`](../core/src/review.ts) |
| Recipe | `validateRecipe` (§3.6) | [`core/src/srs.ts`](../core/src/srs.ts) |
| Part output, at run time | `checkValue` against the port's type (§1.2) | [`runner/src/executor.ts`](../runner/src/executor.ts) |

The source checks are static. They catch common mistakes and the usual escapes, not every malicious idea. What protects buyers at run time is admission (§11): every part's code is in a runner release whose code hash buyers verify, open parts run in a sandbox, parts that send data somewhere new or ask buyers to sign are read by appointed reviewers first, and every value a part returns is type-checked before another part sees it.

`npm test` runs the conformance suite: every part in the catalog passes the manifest and source checks; every seed recipe and every example validates; every seed recipe can be rebuilt in the composer from a blank recipe by adding its parts; and [`tests/srs11.test.ts`](../tests/srs11.test.ts) covers each 1.1 rule, including the runner's behaviour on skipped, failing and ill-typed parts.

## 10. Adopting SRS-1

A marketplace for sealed recipes is only as useful as the number of parts and recipes that speak the same format. SRS-1 is written to be adopted by anyone, not only this marketplace.

- **Part builders** publish a manifest that conforms (§9) and code that follows the part interface, admitted by tier (§11). A part is paid its fee in every settlement of every recipe that uses it, on any marketplace that settles SRS-1 reports.
- **Recipe creators** need no code: add parts, and the types decide what can connect; a value no part provides is asked from the buyer, so the form builds itself.
- **Wallets and agents** read a recipe's public form, seal their inputs and ask for signed quotes; they never need to see a recipe.
- **Other marketplaces and runners** can implement the same three documents, the quote message (§7) and the report message (§6). A recipe sealed to a conforming runner can be listed anywhere that verifies its attestation.

**Versioning.** Every part and the spec itself carry a semantic version. Within 1.x, changes are additive: new types, new optional fields, new optional features gated by the `srs` field (as 1.1 does). A breaking change to a part is a new major version with a new id, and the old one stays valid, so published recipes never break.

**Proposing changes.** New types are proposed as SRS improvement proposals: the JSON definition with its schema, one part and one recipe that use it, and the conformance suite passing. The proposal process is not yet run by an independent body; that is a step for after the first external implementations.

**License.** The spec and its reference implementation are MIT licensed. Anyone may implement, extend or fork them.

## 11. Admission of parts

A part is code that runs inside other people's sealed recipes, on buyers' wallets. Recipe creators cannot read it in the runner and buyers cannot see the recipe, so a malicious part is a real attack. How much a part must prove before it runs depends on what its manifest lets it do (`partTier`):

| Tier | When | What admits it | How it runs |
|---|---|---|---|
| **Open** | Pure, or reads only public NEAR data from the known hosts (`api.fastnear.com`, `rpc.mainnet.fastnear.com`, `1click.chaindefuser.com`) | The automated checks pass. No human review | In the sandbox |
| **Reviewed** | Sends buyer data somewhere new: an AI model, a remote service, or any other host | Automated checks and **one** appointed reviewer | In the runner |
| **Signing** | Asks the buyer to sign transactions (`wallet:approve`) | Automated checks and **two independent** appointed reviewers | In the runner |

The spec is what makes this tractable. A reviewer does not have to work out what a part might do: the manifest says it, and the questions become whether the code does only that. Typed ports with schemas, declared hosts, a single network primitive (`ctx.http`), read-only quotes and declared limits turn most of a review into checks a machine can run. People are only needed where a sandbox cannot judge: whether data sent to a new host is necessary, whether a model's output can steer the part, and above all whether a transaction is the one the buyer meant to sign.

**Automated checks** (every submission, every tier; `runChecks`):
1. manifest conformance (§9), the static source checks and the security scan;
2. a behaviour test in the sandbox, once as a quote and once as a run, with sample values for each input type. HTTP calls are answered by local mocks of the declared hosts only; every wallet request is recorded and declined. A violation fails the checks: reaching an undeclared host, asking for a signature or saving state during a quote, missing or mistyped outputs, or running past `max_ms`. The report shows the hosts reached and the transactions the part asked the buyer to sign, for the reviewer.

**The sandbox** (`runner/src/sandbox.ts`). The part is compiled to one file, refusing any import outside the runner helpers. It runs in its own process with Node's permission model on (it can read only that file; no writes, child processes, workers or native addons), code generation from strings disabled, and its network functions and `process` escapes removed before it loads. Its only channel is IPC: `ctx.http` is relayed to the runner, which checks declared hosts and counts calls. The process is killed at `max_ms` (time waiting for the wallet excluded), so even a tight loop stops. Open parts never receive secrets. The production target is the same contract as a WASM module with fuel metering inside the TEE.

**Review.** The owner appoints the reviewers (`standard/reviewers.json`). A reviewer confirms each item of the tier's checklist (`checklistFor`) and signs `srs-part-review-v1|<submission>|<part>|<manifest hash>|<code hash>|<reviewer>|<verdict>|<checklist>` with their wallet key. A reviewer never reviews their own part, and the two approvals for a signing part must come from different reviewers. Any reviewer can request changes; the author then submits a new version. Reviews are public, with the reviewer's name on them.

**Release log.** Admitted parts ship in a runner release cut by the owner (`npm run release:parts`). Each part gets a record in `standard/reviews.json`: its tier, the hash of the manifest as reviewed (without `implementation`), the hash of its code, the basis (`genesis` for parts shipped before this process, `automated` for open parts, `review` with the signed approvals), and the hash of the automated report. The release log and the reviewer set are inside the runner's code hash, so a buyer who verifies the runner's attestation has also verified who admitted every part.

**Enforcement.** At start the runner checks every catalog part against its record (`verifyRecord`): the manifest and code must be exactly what was admitted, under its tier's rule, with valid signatures from appointed reviewers. A part that fails is refused: a recipe that uses it fails before anything runs, and the buyer is refunded. Open parts admitted on the automated checks never load in the runner's own process.

**Decentralizing it.** Appointed reviewers are a permissioned step; the release log makes it auditable, not permissionless. The path from here: the owner becomes a multisig or DAO; reviewers build a public record and later post a stake that is slashed if a part they approved is shown to be malicious; several independent runners pin their own releases, and creators choose which runner seals their recipe; reproducible builds let anyone confirm the released code hash matches the reviewed code. The open tier is already permissionless.

## 12. How many parts the spec supports

There are three honest answers.

**The format: no limit.** Part ids are namespaced and versioned, and the type vocabulary is open (§10). Nothing in SRS-1 caps the number of parts, or the number of nodes in a recipe; only the buyer's form has a recommended size.

**Interfaces over today's vocabulary: 110,160 slots.** A part's interface is the multiset of its input types and the multiset of its output types. Over the 15 catalog types, parts with up to three inputs and one or two outputs have 816 × 135 = 110,160 distinct interfaces. Each is a slot that any number of builders can fill. Parts in the same slot are drop-in swaps (§3.7), so they compete on fee, risk and track record inside recipes that are already selling, and a better part reaches buyers without anyone rewiring a recipe. A part with type variables (§1.3) fills many slots at once.

**Today's catalog: 23 parts in 19 interfaces.** Three interfaces already have competing parts: three spam shields, two contract judges, and two swap engines that deliver to a proven-fresh address (a third, public one, accepts any address). Counting only distinct parts, with one result and no dead ends, they combine into 471 valid recipes of up to six parts. Each of those multiplies by its possible wirings, conditions, repeated parts (TRCH uses the same swap part twice), params and constants, and by the swaps available for each node: a five-node recipe with three competing parts per slot has 3⁵ = 243 variants from swaps alone.

What grows the space fastest is a new type, not a new part. A type gives parts a new kind of value to exchange, and a type that some part produces and another consumes opens a market for both. Some types that would each unlock a family of parts and recipes (proposals, not in the catalog):

| Proposed type | Produced by | Consumed by | A recipe it enables |
|---|---|---|---|
| `nft.holdings` | an NFT scanner | a spam-NFT burner, a floor-price reporter | clean spam NFTs out of a wallet |
| `storage.deposits` | a storage-deposit reader | a `storage_withdraw` / `storage_unregister` action | reclaim NEAR locked in storage deposits of unused tokens |
| `price.series` | a price-history source | a timing guard, a DCA planner | buy only below the 30-day average |
| `tx.history` | an indexer source | an anomaly guard, a cost-basis report | flag unusual outflows, then lock down keys |

## 13. Not in 1.1, and why

Every feature is weighed against the four properties at the top of this document: a recipe must stay checkable when composed, quotable before it runs, bounded in cost, and settleable to each part author.

- **Nested recipes** (a recipe used as a part). The most valuable next step: creators would build on other creators' recipes, the inner creator would be paid per use, and the outer creator would never see the inner method. It needs an interface manifest derived from the public listing (form fields become input ports, the result becomes the output port), expansion inside the runner, the inner parts added to the outer multiset for billing, and a contract change to pay the inner creator. Planned for the next minor version.
- **Loops and per-item execution.** n8n runs a node once per item. SRS-1 parts take lists and handle items themselves, so billable calls equal nodes and the price is known before the run. A future `map` over a list port needs a declared maximum number of items, so that quotes and limits stay bounded, and per-item billing in the report.
- **Triggers and standing orders.** n8n and CRE start workflows on schedules, webhooks and chain events. Here every run is paid for and every action is approved in the buyer's wallet. Unattended runs first need pre-authorised spending (for example a function-call key with an allowance, or a signed standing intent), which is a wallet question before it is a format one. Meanwhile an agent can ask for quotes and pay on its own schedule (§10).
- **Free-form expressions.** n8n lets any field hold a JavaScript expression. SRS-1 does not, on purpose: an expression is code inside the sealed recipe that no reviewer reads and the validator cannot type. Computation belongs in parts, where it is admitted, limited and paid.
- **Several results.** A recipe has one result type: it is what the listing promises and what a quote measures. Results are combined by a part.

## Appendix A. Changes from 1.0

All additive. A 1.0 recipe validates, runs and bills exactly as before; the features below require `"srs": "1.1"`.

- **Types:** value schemas, enforced on constants, conditions and every part output at run time (§1.2); `proof` types (§1.1); type variables (§1.3).
- **Recipes:** conditions (§3.2), alternatives (§3.3), `on_error: "skip"` (§3.4), precise execution semantics with skipping (§3.5), `listing.bill` (§6.1).
- **Validation:** identifier grammar for nodes, form fields and constants; constant types and values; listing fields; the rules for the features above; warnings for absent results, branch-revealing billing and secret egress (§3.6).
- **Privacy:** parts listed and reported as a sorted multiset (§4); only step counts in the clear while running; approvals keyed by step; salted output hashes (§5.3, §6).
- **Swaps:** compatibility decided by the validator itself, so swaps respect alternatives, conditions and type variables (§3.7).
