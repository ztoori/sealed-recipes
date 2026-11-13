# Submission kit

Everything the NEAR Hackathon asks for, ready to use. Per the organizers' rules, **a human must** publish the repo, post on X and send the form. Nothing in this repo does any of those automatically.

Deadline: **Nov 14, 2026, 23:59 UTC** (6:59 pm Toronto). Judging runs Nov 16–18. One submission per project; corrections afterwards go through the site's *Request changes* page, which the organizers review by hand. Suggested timing: deploy around Nov 10–11, then submit by Nov 12–13.

Projects are screened first by Claude Code and Codex, which check that the repo runs and does what its README says, then judged by a panel. The site names technical implementation, design, impact, originality and sustainability as past criteria, without weights.

## 1. Checklist

- [ ] Create the **public** GitHub repo `ztoori/sealed-recipes` (the URL in `contracts/sealed-recipes/Cargo.toml`, which cargo-near publishes through NEP-330; if you choose another name, change it there too) and push with tags:
  ```bash
  git remote add origin https://github.com/ztoori/sealed-recipes.git
  git push -u origin main --tags
  ```
  The tag `baseline-2026-10-31` marks the first build, written after the hackathon was announced; the rules count code written since the announcement. `git diff baseline-2026-10-31..main` shows everything built during the window.
- [ ] On a clean machine: `npm install && npm run test:e2e` ends with `✔ story complete`; `npm test` (97 tests), `npm run test:rust` (114 tests), `npm run verify` and `npm run test:recipes` pass.
- [x] Deploy the contract: live on NEAR testnet at `market.sealedrecipes.testnet`, with the live page at https://app.sealedrecipes.xyz (steps in `scripts/testnet/README.md`). Mainnet stays undeployed by decision (no real funds), so NEAR Intents is used for real dry quotes only. The README's top and **Status** link the contract and both sites.
- [ ] `main` is the default branch and must hold the testnet work: fast-forward it to `live` and push (`git push origin live:main`) before submitting, and again after any later `live-N` tag.
- [ ] Optional: record a voice-over for `docs/media/demo.mp4` with the script in §5. The video has on-screen captions, so it also works silent.
- [ ] Post the demo on X (§3).
- [ ] Create a **mainnet** NEAR account for the prize payout.
- [ ] Check that no keys are in the repo history: `.env` is git-ignored, and `git log -p | grep -iE "NEAR_AI_API_KEY=.|ONECLICK_JWT=."` prints nothing.
- [ ] If the same person enters a second project, each README must name the other (up to 2 independent projects per person).
- [ ] Fill in the form at https://nearhackathon.com/#apply.

## 2. Form fields

| Field | Value |
|---|---|
| Project name | Sealed Recipes |
| Team lead | *you* |
| Email address | *you* |
| Team size | *1 — Solo builder / 2 - 4 people / 4 - 6 people / 6 - 8 people / 8+ people* |
| Tracks | **Privacy & Private AI**, **Agent Economy** (why: below) |
| NEAR wallet address | *your mainnet account* |
| Repository link | https://github.com/ztoori/sealed-recipes |
| Demo post link | *your X post URL* |
| What did you build? (1998 / 2000 characters) | see below |
| Website | https://app.sealedrecipes.xyz (live on NEAR testnet; the guided demo is under /demo on the same site) |

Why these tracks:

| Track | What in this project fits it |
|---|---|
| Privacy & Private AI | Recipes are sealed to an attested TEE runner (dstack TDX); buyers' inputs and results are sealed end to end; AI parts use NEAR AI Cloud private inference and verify its TEE signatures; swaps use confidential intents to a fresh address |
| Agent Economy | Agents ask recipes for signed quotes, compare them against a policy, pay per run through NEAR Intents and check delivery against the promise; part authors earn a fee on every call, in the same settlement |

```text
Problem: workflows that chain tools, bots and AI models are often the real edge, but they are easy to copy, hard to compare on results, and the builders of their parts are rarely paid.

Sealed Recipes is a platform to compose and run sealed workflows on NEAR, paid per run:
- Compose: SRS-1, an open spec for typed, swappable parts (code, agents, NEAR AI Cloud models, data). A no-code composer wires parts by type and builds the buyer's form from what they need; a part builder checks conformance live; parts are admitted by tier (automated checks, sandbox, reviewers).
- Seal: a recipe is encrypted in the creator's browser to an attested TEE runner; only its hash and part list go on-chain.
- Quote: a buyer or agent fills one short form, sealed once. The recipe quotes from a dry run inside the TEE: expected value, a runner-signed promise backed by the creator's guarantee deposit, a signed price, privacy and withdrawal risk.
- Pay with NEAR Intents from any chain: a 1Click EXACT_OUTPUT quote delivers the run price to the contract via ft_transfer_call, carrying the signed quote.
- Run privately: parts run under resource limits, with durable checkpoints; swaps use confidential intents; results are sealed to the buyer.
- Settle once: the contract verifies the runner's signed report and pays the protocol, the runner, every part author and the creator in one receipt, plus any shortfall to the buyer from the deposit.
- Prices follow demand inside a creator-set band (EIP-1559 rule, proved with Z3). No shares, tokens or trading.
11 sample recipes (wallet cleanup, exits, app keys, staking, contract checks, account audits, position caps) show what it runs.

Status: live on NEAR testnet (market.sealedrecipes.testnet, app.sealedrecipes.xyz): no login, sealed quotes, guest payments signed in the browser, real NEAR AI Cloud on real mainnet data, settled on-chain. Runner in Intel TDX (Phala), DCAP-verified in the browser; Intents in the guided demo only. 114 Rust tests, Z3/TLA+ proofs.
```

The text above is within the form's 2000-character limit; recount if you edit it.

## 3. X demo post

Attach `docs/media/demo.mp4` (135 s, within X's 140 s limit), or the screenshots `10-compose-recipe.png`, `02-sealed.png`, `03-quote.png` and `06-settlement.png`. The post must say it was built at NEAR HACKATHON and tag @NEARProtocol and #NEARHackathon.

**Main post** (270 characters):

```text
Your workflow is your edge. Publish it and it's gone.

Sealed Recipes: compose workflows from other builders' parts, seal them, sell them per run. Buyers pay via NEAR Intents; every builder is paid in one settlement.

Built at NEAR HACKATHON @NEARProtocol #NEARHackathon
```

**Thread:**

```text
2/ How it works: creators compose recipes without code from other builders' typed parts (SRS-1) and seal them to an attested TEE runner. Buyers and agents get signed quotes from sealed dry runs, then pay per run.

3/ What NEAR does here:
• 1Click EXACT_OUTPUT delivers the run price to the contract with the signed quote
• confidential intents for swaps inside a run
• quotes and reports signed by an attested TEE runner, checked by the contract
• NEAR AI Cloud private models

4/ Bob wants his wallet cleaned up. Two recipes quote one sealed request: SWPR returns more but is public; CLNP is confidential and backed by a $25 deposit. He pays CLNP $0.75 from Arbitrum and gets $28.02 vs $27.81 promised. Part authors, runner, creator: one receipt.

5/ Repo (MIT, 184 tests + Z3/TLA+ proofs, one-command local demo, agent buyer included): https://github.com/ztoori/sealed-recipes
Which workflow would you seal and sell first?
```

If the contract is live by then, change "one-command local demo" in 5/ to the explorer link of a settled run.

Optional tags: @NearLegion @NearBuilders.

## 4. Submitting

Use the form. The site documents no submission API, so don't script it.

## 5. Narration (if you record a voice-over for `demo.mp4`)

In the order the video shows them:

| Screen | Say |
|---|---|
| Title card | "Your workflow is your edge. Sealed Recipes lets you sell runs of it without giving the method away." |
| Recipes | "Sealed Recipes is a platform for composing and running sealed workflows. These sample recipes are each built from other people's parts." |
| Composer, parts snapping in | "A creator adds five parts from five builders, type-checked as they connect. Each part discloses its model and harness, so buyers can see what could be withdrawn." |
| Seal dialog | "We verify the runner's attestation, seal the recipe in the browser and back its quotes with a guarantee deposit. The chain stores only a hash." |
| Form and quote | "A buyer fills one short form. The recipe quotes from a sealed dry run: expected value, a signed promise, price, privacy and risk." |
| Intents payment, execution | "Bob pays seventy-five cents from Arbitrum through NEAR Intents. The runner checks the commitments, quarantines two scam airdrops and routes four confidential swaps to a fresh address." |
| Settlement | "One receipt pays five builders, the runner and the creator, and tops up the guarantee deposit. Delivery beat the promise, so the deposit stays untouched." |
| Recipe page, Wallet | "Prices follow demand inside the creator's band, by a rule we proved. Each recipe shows its track record and the deposit behind its quotes. No shares, no tokens: you pay for a run." |
| Documentation | "The spec, SRS-1, is open. The Trust page shows exactly what the marketplace, the contract and the runner can each see." |
| Recipe search | "Every recipe on the platform shows its parts, track record and price, never its method." |
| Compose a recipe and a part | "Anyone can build a recipe without code, or a new part with live conformance checks." |
| End card | "Sealed workflows, paid per run, on NEAR." |
