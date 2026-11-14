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
- [ ] On a clean machine: `bash scripts/setup.sh --all` (or `npm ci` for the TypeScript checks alone), then `npm run test:e2e` ends with `✔ story complete`; `npm test` (106 tests), `npm run test:rust` (114 tests), `npm run verify` and `npm run test:recipes` pass.
- [x] Deploy the contract: live on NEAR testnet at `market.sealedrecipes.testnet`, with the live page at https://sealedrecipes.xyz (steps in `scripts/testnet/README.md`). Mainnet stays undeployed by decision (no real funds), so NEAR Intents is used for real dry quotes only. The README's top and **Status** link the contract and both sites.
- [ ] `main` is the default branch and must hold the testnet work: fast-forward it to `live` and push (`git push origin live:main`) before submitting, and again after any later `live-N` tag.
- [x] Demo videos, recorded from the film with narration, effects and captions: `docs/media/demo.mp4` (the full film, 2:57) and `docs/media/demo-x.mp4` (the X cut, 2:15, inside X's 140 s limit). Re-make them with `npm run build && npm run record:film && npm run record:x` after any change to the film.
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
| Tracks | **Privacy & Private AI**, **AI Security & Defense** (why: below) |
| NEAR wallet address | *your mainnet account* |
| Repository link | https://github.com/ztoori/sealed-recipes |
| Demo post link | *your X post URL* |
| What did you build? (at most 2,000 characters) | see below |
| Website | https://sealedrecipes.xyz (live on NEAR testnet; the film is at https://sealedrecipes.xyz/#/demo, and the hands-on sandbox under /demo) |

Why these tracks (lead with Privacy & Private AI if a single one has to be named):

| Track | What in this project fits it | Where it is thinner |
|---|---|---|
| **Privacy & Private AI** | Recipes and inputs are sealed to a runner in Intel TDX; the buyer's browser verifies the TDX quote against Intel's root and shows what it checked; AI parts use NEAR AI Cloud private inference and verify its TEE signatures; results are sealed to the buyer; a privacy test proves nothing leaks | One runner, no reproducible build yet |
| **AI Security & Defense** | The live recipes are safety checks (CHECK rates a contract before you sign, SAFE3 flags scam tokens, AUDIT3 audits keys); agents buy under a policy with a contract-enforced price cap; the relayer uses a function-call key limited to two methods; an attack demo shows a drained wallet can't drain the deposit; everything rests on TEE attestation | The buying agent pays from a guest key on its own implicit account, not a scoped function-call key |

```text
Every week there is a new app, feature or agent, each with rules nobody reads. Most people learn the hard way: money lost, a scam, a fine. A few do the reading and turn it into a workflow across many tools and documents: a recipe. It is their edge, and hard to sell: copyright covers the wording, not the method, and paywalls and licenses don't stop copies. One copy, and it's gone.

Sealed Recipes is a marketplace on NEAR that sells the run, never the recipe.
- Users (people or AI agents) pick a recipe, get a price signed by the runner from a sealed dry run, and pay per run into escrow. A failed run is refunded.
- Creators compose recipes from parts without code and seal them to a runner in Intel TDX. Only a hash goes on-chain.
- Builders write parts (code, agents, NEAR AI Cloud models, data) to an open spec, SRS-1, and earn a fee per use.
- Runners execute inside the TEE under per-part limits and earn a fee per run.
One runner-signed report, verified by the contract, pays all of them in a single receipt.

Private by design: inputs are sealed in the browser, which first verifies the runner's TDX quote against Intel's root (DCAP) and the image it runs. AI parts verify NEAR AI Cloud's TEE signatures. Results are sealed back to the buyer. The marketplace holds only ciphertext.

Live on NEAR testnet (sealedrecipes.xyz, market.sealedrecipes.testnet), no login: three safety recipes on real mainnet data (contract check before you sign, wallet scam scan, account key audit), real paid runs settled on-chain. An agent buyer verifies the runner, collects signed quotes, picks by policy, pays and checks every signature (npm run agent:live).

Tested and proved: 220 tests, 66 Z3 theorems and three TLA+ models for the money and protocol logic. npm run test:e2e runs the whole loop with no keys.

Not yet: mainnet, wallet connect, more than one runner, reproducible build. NEAR Intents (1Click) payments and confidential swaps run in the local demo only, since Intents has no testnet.
```

The text above is 1954 characters, inside the form's 2,000-character limit; recount if you edit it.

## 3. X demo post

Attach **`docs/media/demo-x.mp4`** (2:15, 1920×1080, H.264 + AAC, inside X's 140 s limit; captions are burned in, so it reads with the sound off). The post must say it was built at NEAR HACKATHON and tag @NEARProtocol and #NEARHackathon. A human writes and publishes it.

**Main post** (276 characters):

```text
A new app, a new agent, every week. Nobody reads the fine print.

A few people do, and can't sell what they know: one copy and it's gone.

Sealed Recipes: their method runs on your data in sealed hardware. You pay per run.

Built at NEAR HACKATHON @NEARProtocol #NEARHackathon
```

**Thread:**

```text
2/ One run: pick a recipe, your browser checks the hardware with Intel and locks your input, the runner signs a price, you pay into escrow on NEAR, the recipe runs where nobody can watch, and only you can open the result. If it fails, you're refunded.

3/ What NEAR does here:
• a contract that escrows each run and pays builders, runner and creator in one receipt
• a runner in Intel TDX, verified in your browser
• NEAR AI Cloud private models, signatures checked
• NEAR Intents for payment in the local demo

4/ AI agents buy the same way: verify the runner, collect signed quotes, pick by their own rules, pay, check every signature. One command: npm run agent:live

5/ Try it, no login: https://sealedrecipes.xyz
Code (MIT, 220 tests, Z3 and TLA+ proofs): https://github.com/ztoori/sealed-recipes
Which workflow would you seal first?
```

Optional tags: @NearLegion @NearBuilders.

## 4. Submitting

Use the form. The site documents no submission API, so don't script it.
