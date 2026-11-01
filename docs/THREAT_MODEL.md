# Threat model

What Fungible Recipes protects, from whom, and where the protection ends.

## Assets

1. **The recipe**: wiring, secret params, prompts. This is the creator's edge.
2. **Buyer inputs**: wallet, thresholds, the fresh recipient address.
3. **Money**: run payments in escrow, payouts, shares and dividends, auction escrow (bids in tokens, asks as locked shares).
4. **Buyer funds** touched by a workflow, such as dust swept by CLNP.

## Adversaries and mitigations

| Adversary | Attack | Mitigation | Residual risk |
|---|---|---|---|
| Marketplace operator | Read or copy recipes | Recipes are sealed in the creator's browser to the runner's attested key. The server only stores the envelope; `tests/runner.test.ts` checks that `server/` never imports the decryption function | Metadata: which blocks a recipe bills is public, because it has to be for attribution. In local mode the browser compares the attestation with runner keys served by the marketplace's contract mirror, so a malicious marketplace could substitute keys; in production that view must come from NEAR RPC |
| Marketplace operator | Read buyer data or link the buyer to the fresh address | Inputs are sealed to the runner. Block logs, wallet requests and the result are sealed by the runner to a one-time key generated in the buyer's browser. Event streams and approvals require a per-run token returned only to the buyer | The marketplace sees coarse progress (which block started or finished) and the payment quote |
| Anyone | Run an expensive recipe after paying for a cheap one | The runner takes the recipe id from the paid run on-chain and checks the sealed recipe against the hash snapshotted in that run | — |
| Buyer / competitor | Reverse-engineer a recipe from its outputs | Outputs only reveal results. Params and prompts stay inside the runner | Black-box probing over many paid runs, which costs money every time |
| Chain observer | Link the buyer to the fresh address | Swaps use `confidentiality: "basic"` in 1Click, so deposits and withdrawals cannot be linked on-chain. The fresh key is made in the browser; only the address is sealed | Timing and amount correlation by a determined observer. `advanced` confidentiality is available and is a one-param change in the block |
| Malicious runner operator | Read plaintext | Production runner runs in an Intel TDX CVM. Keys come from dstack `getKey` and never leave the enclave. Clients verify REPORTDATA = sha256(codehash, keys, nonce) | TEE side channels. Local-dev mode has **no** hardware protection, and the UI says so |
| Malicious or buggy runner | Bill blocks that didn't run / bill extra blocks | `blocks_used` must be a sub-multiset of the recipe's on-chain block list. Reports must be signed by the registered key | A compromised runner could report success for a run that failed. Mitigation: pin `codehash` to the audited release, and add on-chain quote verification (roadmap) |
| Replay | Re-settle a run | `report_run` requires `Pending`; the signature covers contract id, run id and output hash | — |
| Forged attestation | Make clients seal to an attacker key | Fresh nonce, key binding in report_data, possession signature, keys must match `add_runner`, and Intel DCAP chain via `scripts/verify-quote.ts` | Owner key compromise (use a DAO as owner) |
| Block author | Exfiltrate buyer data | Blocks only reach hosts declared in `capabilities` (`guardedFetch`); blocks are reviewed code in the runner image (code hash) | A block can send data to its own declared host. Buyers see each block's capabilities before paying |
| Solver / 1Click | Underpay a run | `ft_on_transfer` requires `amount ≥ price_per_run`; anything else panics and the token is refunded | — |
| Buyer | Pay, then claim a refund | Only the runner's signed failure or a 15-minute timeout refunds | — |
| Seller in an auction | Keep dividends on sold shares | Dividends are harvested before every share movement. Escrowed (locked) shares keep earning until they fill, then move | — |
| Fast trader / MEV searcher | Front-run or pick off orders when they become visible | Shares only trade in batch auctions: all crossing orders in a batch get the same price, so seeing an order first gives no edge, and a single order cannot walk a thin book | A trader can still react to a batch's indicative price before it closes, as in any call auction |
| Book spammer | Make clearing too expensive in gas | Each book is capped at 200 orders | The cap lets a spammer fill a book; storage deposits per order are needed before mainnet |
| Creator | Swap the workflow after people bought shares | `update_sealed` emits `recipe_updated`. Each paid run snapshots the sealed hash it paid for, and the runner executes exactly that version | Shareholders must watch `recipe_updated`. A timelock is a reasonable v2 addition |
| AI model provider | Read sealed prompts | AI blocks call NEAR AI Cloud **private** models. TLS terminates in the gateway TEE, and every response is signed by the attested TEE key and checked | Gateway-kind signatures are checked against the gateway's key. Gateway attestation is not re-verified inside the block |

## Custody

The runner **never holds user funds**. Blocks that move funds (`wallet:approve`) only prepare transactions, the buyer's wallet signs them, and the approval dialog shows the raw `signAndSendTransactions` payload.

## Known gaps (v1)

- No storage deposits on `register_block`, `publish_recipe` or orders. This is a spam vector on mainnet.
- The contract owner approves runners after verifying attestation off-chain. On-chain DCAP verification (as Shade Agent contracts do) is the next step.
- 1Click (the service) sees swap requests, including the fresh recipient. Confidential intents protect against chain observers, not against the 1Click operator.
- The local demo has no hardware TEE, mock services and a demo wallet. See "What is real" in the README.
