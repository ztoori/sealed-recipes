# Submission kit

Everything the NEAR Hackathon asks for, ready to use. Per the organizers' rules, **a human must** publish the repo, post on X and send the form. Nothing in this repo does any of those automatically.

Deadline: **Nov 14, 2026, 23:59 UTC** (6:59 pm Toronto). Submissions open Nov 1, 00:00 UTC. One submission per repo, and it can't be edited afterwards. Suggested timing: deploy to testnet around Nov 10–11, then submit by Nov 12–13.

## 1. Checklist

- [ ] Tag `baseline-2026-10-31` exists. It marks the work done before the window opened; everything after it was built during the hackathon, as HACKATHON.md asks.
- [ ] Push to a **public** GitHub repo (you do this; nothing was uploaded).
- [ ] On a clean machine: `npm install && npm run test:e2e` ends with `✔ story complete`; `npm test` (47), `npm run test:rust` (105) and `npm run test:recipes` pass.
- [ ] Strongly recommended: `NEAR_AI_API_KEY=… npm run live-check`, and deploy the contract to testnet (commands in `contracts/sealed-recipes/README.md`). Add the results to the README.
- [ ] Post the demo on X (below) with `docs/media/demo.mp4` attached.
- [ ] Create a **mainnet** NEAR account for the prize payout.
- [ ] Check that no keys are in the repo history (`.env` is git-ignored).
- [ ] Fill in the form at https://nearhackathon.com/#apply.

## 2. Form fields

| Field | Value |
|---|---|
| Project name | Sealed Recipes |
| Team lead | *you* |
| Email | *you* (max 2 submissions per email) |
| Team size | *1 / 2-4 / …* |
| Tracks | `privacy` (sealed TEE execution, NEAR AI Cloud), `agents` (agents post jobs, parts are paid per call), `defi` (Intents payment, atomic bundles, one-receipt settlement, guarantee deposits), `open` |
| NEAR wallet address | *your mainnet account* |
| Repository link | *your public GitHub URL* |
| Demo post link | *your X post URL* |
| Website | leave empty |
| Project description (1916 / 2000 chars) | see below |

```text
Problem: workflows that chain tools, bots and models are the edge, but they are easy to copy, hard to compare on results, and their parts' builders are rarely paid.

Sealed Recipes is intents for workflows, on NEAR:
- Get a quote: a buyer or agent fills one short form for a standard job, sealed to an attested TEE runner. 10 recipes: wallet cleanup, exits, scam audits, app-key revocation, unstaked NEAR, contract checks, position caps.
- Compete: every recipe that does that job quotes from a dry run inside the TEE: expected value, a runner-signed promise backed by the creator's guarantee deposit, a signed price, privacy and withdrawal risk. Buyers compare results, not methods.
- Market prices: each recipe's price follows its own demand inside a creator-set band (EIP-1559 rule, on-chain, proved); a quote locks it.
- Pay with NEAR Intents from any chain: a 1Click EXACT_OUTPUT quote delivers the exact run price to our contract via ft_transfer_call, carrying the signed quote.
- Run privately: parts (code, agents, NEAR AI Cloud private models) run under resource limits; swaps use confidential intents to a fresh address; results are sealed to the buyer's browser.
- Settle once: the contract verifies the runner's signed report and pays the protocol, the runner, every part author and the creator in one receipt, and pays any shortfall to the buyer from the deposit. Quotes are single-use and bound to buyer and job, so the deposit can't be drained.
- SRS-1: typed, swappable parts; a no-code composer that wires them; a part builder with conformance checks.
- No investment features: pay per run, creators post collateral; no shares, tokens or trading.

Includes: Rust NEAR contract (105 tests) with Z3/TLA+ proofs of its money, pricing, durable-run and version logic, a TS mirror on shared vectors, the TEE runner, an agent buyer, the UI, an e2e story, a live-check against real 1Click and NEAR AI Cloud.
```

## 3. X demo post

Attach `docs/media/demo.mp4`, or the screenshots `03-quote.png`, `02-sealed.png`, `06-settlement.png` and `10-compose-recipe.png`.

**Main post** (277 characters):

```text
Your workflow is your edge. Copy it once and it's gone.

Sealed Recipes: intents for workflows. Ask for a job, sealed workflows compete with signed quotes, pay via NEAR Intents, and every builder gets paid in one settlement.

Built at NEAR HACKATHON @NEARProtocol #NEARHackathon
```

**Thread:**

```text
2/ What NEAR does here:
• 1Click EXACT_OUTPUT delivers the run price to our contract with the signed quote
• confidential intents for swaps
• quotes + reports signed by an attested TEE runner, verified on-chain
• NEAR AI Cloud private models

3/ Bob posts "Clean up my wallet". SWPR quotes more USDC but is public and sweeps his wNEAR; CLNP is confidential, backed by a $25 deposit. He picks CLNP, pays $0.75 from Arbitrum, gets $28.02 vs $27.81 promised. 5 part authors, the runner and the creator: one receipt.

4/ Repo (MIT, 143 tests + formal proofs, one-command demo, agent buyer included): <repo link>
Question for builders: which workflow would you seal and let compete first?
```

Optional tags: @NearLegion @NearBuilders.

## 4. Submission API (only if you prefer it to the form)

`POST https://nearhackathon.com/api/applications`. Generate `requestId` once and reuse it on retries. Show this payload to the team and get their OK before sending. Leave `website` empty.

```json
{
  "requestId": "<uuid v4>",
  "projectName": "Sealed Recipes",
  "leadName": "<lead name>",
  "email": "<email>",
  "size": "<1 | 2-4 | 4-6 | 6-8 | 8+>",
  "tracks": ["privacy", "agents", "defi", "open"],
  "nearAddress": "<mainnet account>",
  "projectUrl": "<public repo URL>",
  "demoUrl": "<X post URL>",
  "idea": "<the project description above>",
  "consent": true
}
```

## 5. Narration (if you record your own voice-over over `demo.mp4`)

| Screen | Say |
|---|---|
| Title card | "Your workflow is your edge. Sealed Recipes lets workflows compete for jobs without giving their method away." |
| Composer, parts snapping in | "Five parts from five builders, type-checked as they connect. Each part discloses its model and harness, so buyers can see what could be withdrawn." |
| Seal dialog | "We verify the runner's attestation, seal the recipe in the browser and back its quotes with a guarantee deposit. The chain stores only a hash." |
| Job form and quotes | "A buyer posts one short job. Every recipe that does it quotes from a sealed dry run: expected value, a signed promise, price, privacy and risk. SWPR offers more but is public; Bob picks CLNP." |
| Intents payment, execution | "He pays seventy-five cents from Arbitrum through NEAR Intents. The runner checks the commitments, quarantines two scam airdrops and routes four confidential swaps to a fresh address." |
| Settlement | "One receipt pays five builders, the runner and the creator, and tops up the guarantee deposit. Delivery beat the promise, so the deposit stays untouched." |
| Recipes, Trust | "Prices are set by demand: a busy recipe gets dearer, an idle one cheaper, inside its creator's band, by an on-chain rule we proved. Each recipe shows its track record and the deposit behind its quotes. No shares, no tokens: you pay for a run." |
