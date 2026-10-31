# Submission kit

Everything the NEAR Hackathon asks for, ready to use. Per the organizers' rules, **a human must** publish the repo, post on X and send the form. Nothing in this repo does any of those automatically.

Deadline: **Nov 14, 2026, 23:59 UTC**. Submissions open Nov 1, 00:00 UTC. One submission per repo, and it can't be edited afterwards.

## 1. Checklist

- [ ] `git init` is done and tag `baseline-2026-10-31` exists (it marks the work done before the hackathon started on Nov 1, 2026. Code written after the announcement counts, and HACKATHON.md asks you to separate the baseline from in-window work).
- [ ] Push to a **public** GitHub repo (you do this; we did not upload anything).
- [ ] On a clean machine: `npm install && npm run test:e2e` ends with `✔ story complete`; `npm test` and `npm run test:rust` pass.
- [ ] Optional but strong: `NEAR_AI_API_KEY=… npm run live-check` and paste the output into an issue or the README.
- [ ] Optional: deploy the contract to testnet (commands in `contracts/fungible-recipes/README.md`) and add the account to the README.
- [ ] Post the demo on X (below) with `docs/media/demo.mp4` attached.
- [ ] Create a **mainnet** NEAR account for the prize payout.
- [ ] Check that no keys are in the repo history (`.env` is git-ignored).
- [ ] Fill in the form at https://nearhackathon.com/#apply.

## 2. Form fields

| Field | Value |
|---|---|
| Project name | Fungible Recipes |
| Team lead | *you* |
| Email | *you* (max 2 submissions per email) |
| Team size | *1 / 2-4 / …* |
| Tracks | `privacy` (Privacy & Private AI), `defi` (Unstoppable DeFi), `agents` (Agent Economy), `open` (Open Innovation). All four fit: sealed TEE execution and NEAR AI Cloud, an exchange with Intents settlement, pay-per-call bots, and a new asset class |
| NEAR wallet address | *your mainnet account* |
| Repository link | *your public GitHub URL* |
| Demo post link | *your X post URL* |
| Website | leave empty |
| Project description (1920 / 2000 chars) | see below |

```text
Problem: businesses run on workflows that chain apps, bots and AI. The workflow itself (which tools, in what order, with which prompts and thresholds) is the edge, but it is protected only by NDAs, it is easy to copy, and the builders whose tools it uses are rarely paid.

Fungible Recipes turns a workflow into a sealed, tradable financial instrument on NEAR:
- Compose: builders publish typed blocks with per-call fees. Creators wire them into a recipe in a no-code canvas (FRS-1 standard: typed ports, subtyping, drop-in block swaps).
- Seal: the recipe is encrypted in the creator's browser to an attested TEE runner (Intel TDX via dstack, the Shade Agent stack). Only its hash goes on-chain.
- Pay per run with NEAR Intents: a 1Click EXACT_OUTPUT quote delivers the exact run price to our contract via ft_transfer_call with the run ticket in customRecipientMsg. The buyer pays from any chain and fills one short form.
- Execute privately: the runner checks the on-chain commitments, decrypts, and runs the blocks. AI blocks use NEAR AI Cloud private models with verified TEE signatures; swaps use confidential intents to a fresh address.
- Settle: the runner's ed25519-signed report is verified on-chain, and one receipt pays the protocol, the runner, every block author, the creator's royalty and a dividend to all shareholders.
- Trade: each recipe has shares and a contract-level order book, so the market prices the workflow's edge without seeing it.

Demo story: a creator builds and seals "Clean up and protect"; a buyer pays $0.75 from Arbitrum; the workflow quarantines scam airdrops, sweeps dust and confidentially swaps it to a fresh address; 8 parties plus all shareholders are paid in one settlement.

Includes: a Rust NEAR contract (31 tests), a TS mirror passing the same vectors, the TEE runner, 8 blocks, the exchange UI, a headless e2e story, and a live-check against real 1Click and NEAR AI Cloud.
```

## 3. X demo post

Attach `docs/media/demo.mp4` (81 s, 1440×900), or the screenshots `02-sealed.png`, `03-wallet-approval.png`, `05-settlement.png`, `06-exchange-clnp.png`.

**Main post** (fits in 280 characters):

```text
Your workflow is your edge. Copy it once and it's gone.

Fungible Recipes: seal a workflow in a TEE, sell it per run via NEAR Intents, and pay every builder in one settlement. Shares trade like stocks.

Built at NEAR HACKATHON @NEARProtocol #NEARHackathon
```

**Thread:**

```text
2/ What NEAR does here:
• 1Click EXACT_OUTPUT quote delivers the exact run price to our contract via ft_transfer_call
• confidential intents make the swaps unlinkable
• runner reports are ed25519-verified on-chain
• NEAR AI Cloud private models with verified TEE signatures

3/ One run of "Clean up and protect", $0.75 from Arbitrum: quarantine 2 scam airdrops, sweep 4 dust balances, confidentially swap to a fresh address. Protocol, runner, 5 block authors, the creator and every shareholder are paid in one receipt.

4/ Repo (MIT, 48 tests, one-command demo): <repo link>
Question for builders: which workflow would you seal and list first?
```

Optional tags: @NearLegion @NearBuilders.

## 4. Submission API (only if you prefer it to the form)

`POST https://nearhackathon.com/api/applications`. Generate `requestId` once and reuse it on retries. Show this payload to the team and get their OK before sending. Leave `website` empty.

```json
{
  "requestId": "<uuid v4>",
  "projectName": "Fungible Recipes",
  "leadName": "<lead name>",
  "email": "<email>",
  "size": "<1 | 2-4 | 4-6 | 6-8 | 8+>",
  "tracks": ["privacy", "defi", "agents", "open"],
  "nearAddress": "<mainnet account>",
  "projectUrl": "<public repo URL>",
  "demoUrl": "<X post URL>",
  "idea": "<the project description above>",
  "consent": true
}
```

## 5. Narration (if you record your own voice-over over `demo.mp4`)

| Time | Screen | Say |
|---|---|---|
| 0–4 s | Title card | "Your workflow is your edge. Fungible Recipes lets you sell it without giving it away." |
| 4–20 s | Composer, blocks snapping in | "Five blocks from five builders, type-checked as they connect. A private AI guard, a dust filter, a fresh-address check and a confidential Intents swap." |
| 20–30 s | Seal dialog | "We verify the runner's attestation, then seal the recipe in the browser. The market only ever sees the listing; the chain stores a hash." |
| 30–45 s | Run form + Intents quote | "A buyer fills four fields and pays seventy-five cents in USDC from Arbitrum. NEAR Intents delivers it straight to our contract, run ticket attached." |
| 45–65 s | Execution timeline, wallet approval | "The runner checks the on-chain commitments, decrypts, quarantines two scam airdrops with a signed AI verdict, and routes four confidential swaps to a never-used address." |
| 65–75 s | Settlement diagram | "One signed report, one receipt: protocol, runner, five builders, the creator, and every shareholder." |
| 75–81 s | Exchange | "And because every run pays a dividend, the market prices the recipe's edge without ever seeing it." |
