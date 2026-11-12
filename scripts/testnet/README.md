# Sealed Recipes on NEAR testnet

Scripts to put the contracts on testnet. Run them in order on a machine with internet access (the VPS), as the user
whose `~/.near-credentials/testnet/` holds the keys of the accounts in `config.sh`. Each step prints what it did.

| Step | What it does | Run again? |
|---|---|---|
| `./00-tools.sh` | installs Rust + wasm target, cargo-near, near-cli-rs (for this user) | yes, skips what exists |
| `./10-build.sh` | builds `contracts/tusdc` and `contracts/sealed-recipes` to wasm | yes |
| `./20-deploy.sh` | deploys and initializes tUSDC (minter: the faucet account) and the marketplace contract; registers tUSDC storage for the market, treasury, owner and runner | no: `new` runs once |
| `./30-parts.sh` | registers every catalog part (fee + manifest hash) | yes, skips registered parts |
| `./40-runner.sh` | registers the live runner (its public keys, read as the service user, and the audited code hash) | when the runner's keys or code change |
| `node --import tsx scripts/testnet/50-run.ts --recipe CHEK --target wrap.near` | a real paid run: publish (if needed), mint tUSDC, quote, pay, run, settle; prints explorer links | yes |

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
