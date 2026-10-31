# Threat model

What Fungible Recipes protects, from whom, and where the protection ends.

## Assets

1. **The recipe**: wiring, secret params, prompts. This is the creator's edge.
2. **Buyer inputs**: wallet, thresholds, the fresh recipient address.
3. **Money**: run payments in escrow, payouts, shares and dividends, order-book escrow.
4. **Buyer funds** touched by a workflow, such as dust swept by CLNP.

## Adversaries and mitigations

| Adversary | Attack | Mitigation | Residual risk |
|---|---|---|---|
| Marketplace operator | Read or copy recipes | Recipes are sealed in the creator's browser to the runner's attested key. The server only stores the envelope; `tests/runner.test.ts` checks that `server/` never imports the decryption function | Metadata: which blocks a recipe bills is public, because it has to be for attribution |
| Buyer / competitor | Reverse-engineer a recipe from its outputs | Outputs only reveal results. Params and prompts stay inside the runner | Black-box probing over many paid runs, which costs money every time |
| Chain observer | Link the buyer to the fresh address | Swaps use `confidentiality: "basic"` in 1Click, so deposits and withdrawals cannot be linked on-chain. The fresh key is made in the browser; only the address is sealed | Timing and amount correlation by a determined observer. `advanced` confidentiality is available and is a one-param change in the block |
| Malicious runner operator | Read plaintext | Production runner runs in an Intel TDX CVM. Keys come from dstack `getKey` and never leave the enclave. Clients verify REPORTDATA = sha256(codehash, keys, nonce) | TEE side channels. Local-dev mode has **no** hardware protection, and the UI says so |
| Malicious or buggy runner | Bill blocks that didn't run / bill extra blocks | `blocks_used` must be a sub-multiset of the recipe's on-chain block list. Reports must be signed by the registered key | A compromised runner could report success for a run that failed. Mitigation: pin `codehash` to the audited release, and add on-chain quote verification (roadmap) |
| Replay | Re-settle a run | `report_run` requires `Pending`; the signature covers contract id, run id and output hash | — |
| Forged attestation | Make clients seal to an attacker key | Fresh nonce, key binding in report_data, possession signature, keys must match `add_runner`, and Intel DCAP chain via `scripts/verify-quote.ts` | Owner key compromise (use a DAO as owner) |
| Block author | Exfiltrate buyer data | Blocks only reach hosts declared in `capabilities` (`guardedFetch`); blocks are reviewed code in the runner image (code hash) | A block can send data to its own declared host. Buyers see each block's capabilities before paying |
| Solver / 1Click | Underpay a run | `ft_on_transfer` requires `amount ≥ price_per_run`; anything else panics and the token is refunded | — |
| Buyer | Pay, then claim a refund | Only the runner's signed failure or a 15-minute timeout refunds | — |
| Seller in the order book | Keep dividends on sold shares | Dividends are harvested before every share movement. Escrowed (locked) shares keep earning until they fill, then move | — |
| AI model provider | Read sealed prompts | AI blocks call NEAR AI Cloud **private** models. TLS terminates in the gateway TEE, and every response is signed by the attested TEE key and checked | Gateway-kind signatures are checked against the gateway's key. Gateway attestation is not re-verified inside the block |

## Custody

The runner **never holds user funds**. Blocks that move funds (`wallet:approve`) only prepare transactions, the buyer's wallet signs them, and the approval dialog shows the raw `signAndSendTransactions` payload.

## Known gaps (v1)

- No storage deposits on `register_block`, `publish_recipe` or orders. This is a spam vector on mainnet.
- The contract owner approves runners after verifying attestation off-chain. On-chain DCAP verification (as Shade Agent contracts do) is the next step.
- Run outputs travel back through the marketplace in the buyer's session. They should be sealed to a buyer key.
- The local demo has no hardware TEE, mock services and a demo wallet. See "What is real" in the README.
