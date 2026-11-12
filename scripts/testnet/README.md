# Sealed Recipes on NEAR testnet

Scripts to put the contracts on testnet. Run them in order on a machine with internet access (the VPS), as the user
whose `~/.near-credentials/testnet/` holds the keys of the accounts in `config.sh`. Each step prints what it did.

| Step | What it does | Run again? |
|---|---|---|
| `./00-tools.sh` | installs Rust + wasm target, cargo-near, near-cli-rs (for this user) | yes, skips what exists |
| `./10-build.sh` | builds `contracts/tusdc` and `contracts/sealed-recipes` to wasm | yes |
| `./20-deploy.sh` | deploys and initializes tUSDC (minter: the faucet account) and the marketplace contract; registers tUSDC storage for the market, treasury, owner and runner | no: `new` runs once |
| `./25-upgrade.sh` | upgrades the marketplace contract's code in place (state kept) after `./10-build.sh` | when the contract gains methods |
| `./30-parts.sh` | registers every catalog part (fee + manifest hash) | yes, skips registered parts |
| `./40-runner.sh` | registers the live runner (its public keys, read as the service user, and the audited code hash) | when the runner's keys or code change |
| `RUNNER_URL=… ./45-tee-runner.sh` | registers the runner running in a TDX CVM (Phala Cloud) as `tee.$ROOT_ACCOUNT`, after Intel DCAP verification of its quote and a check of its code hash against `AUDITED_CODEHASH` | when its code changes (same CVM app: same keys) |
| `node --import tsx scripts/testnet/50-run.ts --recipe CHEK --target wrap.near` (`--ticker X` publishes the seed recipe under another ticker: a published recipe's parts are fixed, so a new part version needs a new listing) | a real paid run: publish (if needed), mint tUSDC, quote, pay, run, settle; prints explorer links | yes |

Costs come from the accounts themselves: contract storage (about 2 NEAR for tUSDC, 4-5 NEAR for the marketplace),
about 0.01 NEAR per part registration, and gas. Top up from the testnet faucet page if a step says the balance is too low.

**If the deploy fails with a wasm preparation or "unsupported feature" error**, the Rust compiler is newer than what
the NEAR runtime accepts. Pin an older one for both contracts and rebuild:
`printf '[toolchain]\nchannel = "1.86"\ntargets = ["wasm32-unknown-unknown"]\n' | tee contracts/tusdc/rust-toolchain.toml contracts/sealed-recipes/rust-toolchain.toml`

`contracts/tusdc` is a standard NEP-141 token, "Test USD (Sealed Recipes)", symbol tUSDC, 6 decimals, with no value.
Only the faucet account can mint, at most 10,000 tUSDC per call, and only to accounts that ask for it.

## Live services (after step 30)

The live marketplace (`server/src/live.ts`, port 8081) and the read-only runner (port 8788) run as `srs` from a
separate checkout, `/opt/srs-live`, so the demo in `/opt/srs-demo` stays on its tag. Settings: `/etc/srs/live.env`
(see `deploy/live.env.example`); secrets: `/etc/srs/secrets.env` (`RUNNER_TOKEN`, `NEAR_AI_API_KEY`, optional
`ONECLICK_API_KEY`); relayer key: `/etc/srs/relayer.json`. Units: `deploy/srs-live-runner.service`,
`deploy/srs-live-server.service`. The runner refuses recipes that ask the buyer to sign (`SRS_READ_ONLY=1`), and its
parts read real mainnet data. Then `./40-runner.sh` and `50-run.ts`.

## Runner in a TEE (Intel TDX on Phala Cloud)

The live runner above is the `local-dev` build: real keys and signatures, no hardware quote. The same code runs in a
TDX confidential VM with `TEE_MODE=dstack`: its keys come from the TEE's key service (stable for the CVM app across
upgrades), and `/attestation` carries a TDX quote whose REPORTDATA binds those keys to the caller's nonce.

1. Build and push the image (from the tag the VPS runs; x86): `docker build --platform linux/amd64 -f runner/Dockerfile -t ghcr.io/<you>/srs-runner:live-N .`
   then `docker push …` and note the digest (`docker inspect --format '{{index .RepoDigests 0}}' …`). Make the package public.
2. Put the digest in `runner/docker-compose.yml` (`image: …@sha256:…`). The compose file is measured into the quote.
3. Phala Cloud → Create CVM → docker-compose → paste `runner/docker-compose.yml`; Encrypted Secrets: `RUNNER_TOKEN`
   (the same value as in `/etc/srs/secrets.env`), `NEAR_AI_API_KEY`, `ONECLICK_API_KEY` (may be empty). The CVM's
   Network tab shows the public URL for port 8787: that is `RUNNER_URL`.
4. `RUNNER_URL=… ./45-tee-runner.sh`: Intel DCAP check of the quote, code hash against `AUDITED_CODEHASH`, then
   `add_runner` as `tee.$ROOT_ACCOUNT`.
5. `/etc/srs/live.env`: `RUNNER_ID=tee.sealedrecipes.testnet`, `RUNNER_URL=…`, `SRS_RUNNER_TEE=Intel TDX (dstack, Phala Cloud)`;
   restart `srs-live-server`.
6. Recipes are sealed to one runner's key, so publish the recipes again for the TEE runner under new tickers
   (`50-run.ts --recipe CHEK --ticker …`) and retire the old ones in `SRS_RETIRED_LISTINGS`.

Upgrading the runner later: push a new image, change the digest, and update the same CVM (not a new one: a new CVM
app gets new keys); re-pin the code hash if runner/ or core/ changed, then `./45-tee-runner.sh` again.
