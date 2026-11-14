# The local demo, step by step

This is the hands-on tour of `npm run demo`: the whole product on your machine, with local stand-ins for every outside service (what is real and what is a stand-in: [README](../README.md#what-is-real-and-what-is-local)). The live site at https://sealedrecipes.xyz runs the same code against NEAR testnet with three recipes; its tickers differ (CHECK, SAFE3, AUDIT3 there; CHEK, SAFE, AUDT here).

Requirements: Linux, macOS or WSL, and Node.js 20.6 or newer (22 LTS recommended). Rust is only needed for the contract tests. On Windows, build in WSL ([SETUP-WSL.md](SETUP-WSL.md)).

```bash
npm install
npm run demo            # starts runner :8787 + marketplace :8080, seeds the recipes, opens the browser
```

Then follow these steps. Each one says what you should see.

The app opens on a landing page that tells the story: too much to vet, the few who do the homework, and the four seats (users, creators, builders, runners). Past it, the top menu has four sections: **Recipes** (find one and get a quote), **Compose** (build a recipe from parts with no code, or build a part), **Wallet**, and **Docs** (the SRS-1 spec, Trust & privacy, Landscape, and guides). Every page has its own link (`#/recipes/CLNP`, `#/quote/STAK`, `#/compose/part/…`), so the back button works.

1. **Open http://127.0.0.1:8080.** The landing page explains the idea. **Proceed to recipes** opens **Recipes**: ten listed recipes with a search box and favorites (★). The eleventh, CLNP, is composed and published during the story.
2. **Click "Play demo"** (top right; on the landing page, **Watch the demo**). Seven chapters play automatically, each with a caption and a speed control. Chapters 1–4 are the loop itself:
   1. **Compose.** As `chef.testnet`, the creator starts a new recipe and adds five parts one by one. Each wires itself to the previous step's matching output, and the buyer's form (wallet, dust threshold, target asset, fresh address) comes with them. The seal dialog verifies the runner attestation: 6 checks pass, and "Hardware TDX quote" shows as skipped in local mode. The plaintext turns into ciphertext and gets a wax seal. `publish_recipe` returns a transaction hash (simulated in local mode), and a $25 guarantee deposit backs CLNP's quotes.
   2. **Find it and get a quote.**
      - As `bob.testnet`, the buyer searches “clean”, opens *Clean up and protect* (CLNP) and presses **Get a quote**.
      - The quote page asks only CLNP: a fresh address is generated in the browser, the inputs are sealed, and CLNP quotes from a sealed dry run. It expects $28.02 and promises $27.81, with $25.00 covered by the deposit, at a signed price of $0.75.
      - Bob uses the quote. A 1Click quote shows *0.75188 USDC on Arbitrum → $0.75 delivered to the contract*, with the signed promise in the `customRecipientMsg`.
   3. **Execute.**
      - The runner checks the paid run against its on-chain commitments, decrypts, and runs each part, showing its author and fee. Part details carry a *sealed to you* tag.
      - The AI Spam Shield quarantines two scam airdrops, with its signature verified.
      - A wallet dialog, decrypted in the browser, asks to approve four `ft_transfer`s. Four confidential swaps then reach `SUCCESS`.
   4. **Settle.** "Delivered $28.02 against a signed promise of $27.81: promise kept, the deposit is untouched." Below that, a diagram shows $0.75 split between the protocol, the runner, five part authors, **$0.5085 to the creator** and **$0.0565 into CLNP's guarantee deposit** (the creator's 10% reserve), in one transaction.

   Chapters 5–7 explain why it holds together: prices that follow demand, what the marketplace, the chain and your browser can each check, and the three ways in (run a recipe, compose one, build a part).
3. **Recipes → CLNP.** The track record shows 1 successful run, delivery at 101% of the promise and a guarantee deposit of $25.06: the $25 the creator posted plus the reserve from the run. "Where the price goes" itemizes the split, which sums to exactly $0.75. "Inside" shows what the marketplace can see: the part chain (each part opens its internals) and the sealed on-chain commitment.
4. **Acting as → chef.testnet, then Wallet.** Income shows the creator's $0.5085, and *Your recipes* lists CLNP with its deposit. As `bob.testnet`, Wallet's *Account* panel reads his on-chain state and points to the recipes that would help: app keys left by dApps (KEYS), and unstaked NEAR waiting to be withdrawn (STAK).
5. **The four everyday-safety recipes.** Search Recipes for *keys*, *stake*, *contract* or *cap*, then press **Get a quote** and run:
   - **KEYS** revokes two risky app keys in one `DeleteKey` transaction you approve, then confirms they are gone. It never removes a full-access key; those are listed for review.
   - **STAK** withdraws 4.2 NEAR from two pools that finished unbonding, skips one still unbonding, and flags a validator that stopped validating.
   - **CHEK** checks a contract before you sign. Try `near-gift-claim.near` (high risk: reward-bait name, upgradable, no published source) and `v2.ref-finance.near` (low risk: locked, source published).
   - **TRIM** caps any token at a share of your wallet (use `dana.testnet`, about 48% NEAR): it sells only the excess, privately, into USDC at a fresh address.
6. **Compose → Recipe** (no code). Start a **New recipe**, or search **Your recipes** (the ones published by the account you act as) and press **Edit**. Add parts from the palette: *Suggested next* lists what fits, each part wires itself, and every input has a plain "comes from" list: an earlier part, the buyer's form, a new question for the buyer, or a fixed value. Click the *Buyer's form* on the canvas to word its questions and set defaults. Select a part to see its settings (sealed), its withdrawal risk, and drop-in alternatives. For example, swap *Allowlist Shield* for *AI Spam Shield Pro* and the recipe turns **high** risk (closed model). *Ready to publish?* lists what is left in plain words. Recipes are private: **Edit** opens the copy sealed to your own wallet key. Changing wiring or settings publishes a new version after the notice period; changing the parts, the buyer's form or the result publishes a new recipe with its own short code.
7. **Compose → Part** (for developers). Open any part to read its manifest, source and how it was admitted (all parts are public in this demo), or build a new one. SRS-1 conformance, static and security checks run live, and the panel shows the part's **admission tier**. Register the manifest on-chain, then **Submit for review**: the code goes to the queue, signed by your wallet.
8. **Compose → Review**. The admission queue. Every submission gets automated checks: conformance, a security scan, and a behaviour test in a sandbox, once as a quote and once as a run, showing the hosts it reached and any transaction it asked the buyer to sign. Then it depends on the tier:
   - **Open** (pure, or reads public NEAR data): admitted on the checks alone, and runs in the sandbox.
   - **Reviewed** (sends buyer data to a model or a new host): one appointed reviewer approves.
   - **Signing** (asks the buyer to sign): two independent appointed reviewers approve.
   Switch "Acting as" to `audit-a` or `audit-b` to review: tick the checklist, approve or request changes. The owner then runs `npm run release:parts -- --yes` to ship admitted parts in a new runner release; the release log is inside the code hash, and the runner refuses any part whose record does not verify.
9. **Docs** opens on **Spec (SRS-1)**: the full text of [docs/SRS-1.md](SRS-1.md), rendered from the file, next to the live type registry and a conformance count of every part checked in the browser. §9 says how conformance is checked, §10 how others can adopt and extend the spec, and §11 how parts are admitted by tier. A panel lists the three admission tiers with how many parts are in each. **Trust & privacy** shows what the marketplace stores (ciphertext), what the contract stores and what only the runner sees, the runner attestation (re-run with a new nonce), the exact JSON 1Click receives, and the contract's NEP-297 events. The remaining tabs are guides: **Price & demand**, **Compose Recipe**, **Compose Part** and **Runner · TEE**.
10. **An agent as the buyer** (with the demo running and the story done; `npm run story` plays it from a terminal): `npm run agent`. The agent seals one request for `carol.testnet`, asks the recipes it shortlisted (CLNP and SWPR by default) for quotes, compares them against its policy (confidential only, maximum risk, price cap, approval cap), pays the winner, approves only within its limit, and checks delivery against the promise. No human in the loop.
    **The same agent on the live marketplace:** `npm run agent -- --live` (or `npm run agent:live`). It makes its own guest key (kept in `.data/agent-guest.json`, so later runs reuse it), gets test tokens from the faucet, verifies the runner's attestation, asks every live recipe, one at a time, for a sealed quote (contract recipes on `v2.ref-finance.near`, wallet recipes on `social.near`; `--contract`, `--wallet` or `--target` change them), picks the cheapest one under its price cap and risk limit, and pays it with `ft_transfer_call` on NEAR testnet. The cap goes into the run as `max_price`, so the contract refuses to charge more. When the run settles, the agent checks the runner-signed report itself: the signature against the runner key registered on-chain, the contract, run and recipe it names, and the output hash against the sealed result (only the buyer gets the salt). It prints the payment and settlement links.

    Latest live run (2026-11-13, `npm run agent -- --live --wallet v2.ref-finance.near`): three signed quotes (CHECK $0.12, SAFE3 $0.15, AUDIT3 $0.20, all on `v2.ref-finance.near`), the price policy picked CHECK; faucet [funding](https://testnet.nearblocks.io/txns/8VmERQ336TrW78gkfJuFzPC2qjGnTiJQxeePprVyuN8V), [payment](https://testnet.nearblocks.io/txns/3K2HRK6huF8ZB6JpSGZqUfDAQJUNaAZoH4BmKyR9whh1), [settlement](https://testnet.nearblocks.io/txns/2uJn331mMrTWHzYUSFJ7GjSC2iy779pU5BrGsaPeoT9A); the agent checked the runner's signature against its on-chain key, the run and recipe, the output hash against the sealed result, and the settled state. The wallet recipes scan Ref's ~1,800 token balances inside their 8-second limit (`near.wallet-scanner@1.1.0`): SAFE3 [settled](https://testnet.nearblocks.io/txns/7ncWHPow8qGahZvsQ67sgdjEynoySyi8zKc8y8ScZfKW) with 10 scam tokens flagged, AUDIT3 [settled](https://testnet.nearblocks.io/txns/2JxidhkeeK8fAvKUiEwnw6ijq3xbmTW9UDCjgnwWy8Bk). Options: `--account <id>` pays from a named testnet account, `--inputs '{"field":"value"}'` sets other fields, and a policy is the second argument, e.g. `npm run agent -- --live CHECK,SAFE3 '{"sort":"price","maxRisk":"low","maxPriceUsd":0.15}'`.

Headless version for CI or AI judges. It exits non-zero if any step fails:

```bash
npm run test:e2e        # boots everything and runs the 4-step story in the terminal
```

Expected tail of the output:

```
  quote SWPR  expects  $37.5416  promises  $36.9785 (deposit $10.0000)  price $0.2000  public       risk low
  quote CLNP  expects  $28.0249  promises  $27.8147 (deposit $25.0000)  price $0.7500  confidential risk low
  policy {"requirePrivacy":"confidential","maxRisk":"medium","sort":"net"} → CLNP
  ...
     $0.0565  CLNP guarantee deposit     creator's reserve, held as collateral for future quotes
  payouts + reserve == price ($0.7500): every unit accounted for
  delivered $28.0249 vs promised $27.8147 → compensation from the guarantee deposit $0.0000
✔ story complete
```
