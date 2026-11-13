# Sealed Recipes on NEAR testnet

Scripts to put the contracts on testnet. Run them in order on a machine with internet access (the VPS), as the user
whose `~/.near-credentials/testnet/` holds the keys of the accounts in `config.sh`. Each step prints what it did.

| Step | What it does | Run again? |
|---|---|---|
| `./00-tools.sh` | installs Rust + wasm target, cargo-near, near-cli-rs (for this user) | yes, skips what exists |
| `./10-build.sh` | builds `contracts/tusdc` and `contracts/sealed-recipes` to wasm | yes |
| `./20-deploy.sh` | deploys and initializes tUSDC (minter: the faucet account) and the marketplace contract; registers tUSDC storage for the market, treasury, owner and the TEE runner (`tee.$ROOT_ACCOUNT`) | no: `new` runs once |
| `./25-upgrade.sh` | upgrades the marketplace contract's code in place (state kept) after `./10-build.sh` | when the contract gains methods |
| `./30-parts.sh` | registers every catalog part (fee + manifest hash) | yes, skips registered parts |
| `./40-runner.sh` | retired: registered the earlier local-dev runner on the VPS (`runner.sealedrecipes.testnet`, now deactivated). The live runner is the TDX one, step 45. Refuses to run unless `LOCAL_DEV_RUNNER=1` (a local-dev setup of your own) | no |
| `RUNNER_URL=… ./45-tee-runner.sh` | registers the runner running in a TDX CVM (Phala Cloud) as `tee.$ROOT_ACCOUNT` (and its tUSDC storage), after Intel DCAP verification of its quote and a check of its code hash against `AUDITED_CODEHASH` | when its code changes (same CVM app: same keys) |
| `node --import tsx scripts/testnet/50-run.ts --recipe CHEK --ticker CHECK --target wrap.near` (`--ticker X` publishes the seed recipe under another ticker: a published recipe's parts are fixed, so a new part version needs a new listing; the CHEK seed defaults to CHECK, and a retired ticker or one assigned to another runner is refused before any transaction) | a real paid run: publish (if needed), mint tUSDC, quote, pay, run, settle; prints explorer links | yes |

Costs come from the accounts themselves: contract storage (about 2 NEAR for tUSDC, 4-5 NEAR for the marketplace),
about 0.01 NEAR per part registration, and gas. Top up from the testnet faucet page if a step says the balance is too low.

**If the deploy fails with a wasm preparation or "unsupported feature" error**, the Rust compiler is newer than what
the NEAR runtime accepts. Pin an older one for both contracts and rebuild:
`printf '[toolchain]\nchannel = "1.86"\ntargets = ["wasm32-unknown-unknown"]\n' | tee contracts/tusdc/rust-toolchain.toml contracts/sealed-recipes/rust-toolchain.toml`

`contracts/tusdc` is a standard NEP-141 token, "Test USD (Sealed Recipes)", symbol tUSDC, 6 decimals, with no value.
Only the faucet account can mint, at most 10,000 tUSDC per call, and only to accounts that ask for it.

## Live services (after step 30)

The live marketplace (`server/src/live.ts`, port 8081) runs as `srs` from a
separate checkout, `/opt/srs-live`, so the demo in `/opt/srs-demo` stays on its tag. Settings: `/etc/srs/live.env`
(see `deploy/live.env.example`); secrets: `/etc/srs/secrets.env` (`RUNNER_TOKEN` only: `NEAR_AI_API_KEY` and
`ONECLICK_API_KEY` belong to the runner, as CVM encrypted secrets, and the unit unsets them if an older secrets file
still has them); relayer key: `/etc/srs/relayer-fc.json`, a function-call key for `report_run` and `checkpoint_run` only. Unit:
`deploy/srs-live-server.service`. The runner is the TDX one below (the earlier local-dev runner on this machine,
`runner.sealedrecipes.testnet`, is retired and deactivated on the contract); it refuses recipes that ask the buyer to
sign (`SRS_READ_ONLY=1`), and its parts read real mainnet data. Its port is public through the Phala gateway, because
the marketplace runs outside Phala: `/attestation` is meant to be public, and the job endpoints need `RUNNER_TOKEN`
(32 random bytes, checked in constant time on both sides, never sent along a redirect). The runner refuses to start
without a token of at least 32 characters unless it is a local-dev runner on loopback. The server refuses to start
when `RUNNER_URL` is not an https base URL (a leftover `<app-id>` placeholder included), and gives every runner call
a time limit.

## Runner in a TEE (Intel TDX on Phala Cloud)

The live runner is the same code as the local-dev build, run in a TDX confidential VM with `TEE_MODE=dstack`: its keys come from the TEE's key service (stable for the CVM app across
upgrades), and `/attestation` carries a TDX quote whose REPORTDATA binds those keys to the caller's nonce.

1. Build and push the image (from the tag the VPS runs; x86): `docker build --platform linux/amd64 -f runner/Dockerfile -t ghcr.io/<you>/srs-runner:live-N .`
   then `docker push …` and note the digest (`docker inspect --format '{{index .RepoDigests 0}}' …`). Make the package public.
2. Put the digest in `runner/docker-compose.yml` (`image: …@sha256:…`). The compose file is measured into the quote.
3. Phala Cloud → Create CVM → docker-compose → paste `runner/docker-compose.yml`; Encrypted Secrets: `RUNNER_TOKEN`
   (`openssl rand -hex 32`, the same value as in `/etc/srs/secrets.env`), `NEAR_AI_API_KEY`, `ONECLICK_API_KEY` (may be empty). The CVM's
   Network tab shows the public URL for port 8787: that is `RUNNER_URL`.
4. `RUNNER_URL=… ./45-tee-runner.sh`: tUSDC storage for `tee.$ROOT_ACCOUNT`, Intel DCAP check of the quote, code hash
   against `AUDITED_CODEHASH`, then `add_runner` as `tee.$ROOT_ACCOUNT`.
5. `/etc/srs/live.env`: `RUNNER_ID=tee.sealedrecipes.testnet`, `RUNNER_URL=…` (no trailing path), optionally
   `SRS_RUNNER_TEE=Intel TDX (dstack, Phala Cloud)` (otherwise the label comes from the runner's attestation);
   restart `srs-live-server`.
6. Recipes are sealed to one runner's key, so publish the recipes again for the TEE runner under new tickers
   (`50-run.ts --recipe CHEK --ticker …`). Listings assigned to another runner are retired automatically (not shown,
   quoted or sold); name in `SRS_RETIRED_LISTINGS` only listings superseded on this same runner (e.g. SAFE2 by SAFE3).

Upgrading the runner later: push a new image, change the digest, and update the same CVM (not a new one: a new CVM
app gets new keys); re-pin the code hash if runner/ or core/ changed, then `./45-tee-runner.sh` again.
