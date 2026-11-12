# Sealed Recipes on NEAR testnet

Scripts to put the contracts on testnet. Run them in order on a machine with internet access (the VPS), as the user
whose `~/.near-credentials/testnet/` holds the keys of the accounts in `config.sh`. Each step prints what it did.

| Step | What it does | Run again? |
|---|---|---|
| `./00-tools.sh` | installs Rust + wasm target, cargo-near, near-cli-rs (for this user) | yes, skips what exists |
| `./10-build.sh` | builds `contracts/tusdc` and `contracts/sealed-recipes` to wasm | yes |
| `./20-deploy.sh` | deploys and initializes tUSDC (minter: the faucet account) and the marketplace contract; registers tUSDC storage for the market, treasury, owner and runner | no: `new` runs once |
| `./30-parts.sh` | registers every catalog part (fee + manifest hash) | yes, skips registered parts |
| `./40-runner.sh` | registers the live runner (keys from `RUNNER_KEYS_PATH`, audited code hash) | only when the runner's keys or code change |

Costs come from the accounts themselves: contract storage (about 2 NEAR for tUSDC, 4-5 NEAR for the marketplace),
about 0.01 NEAR per part registration, and gas. Top up from the testnet faucet page if a step says the balance is too low.

**If the deploy fails with a wasm preparation or "unsupported feature" error**, the Rust compiler is newer than what
the NEAR runtime accepts. Pin an older one for both contracts and rebuild:
`printf '[toolchain]\nchannel = "1.86"\ntargets = ["wasm32-unknown-unknown"]\n' | tee contracts/tusdc/rust-toolchain.toml contracts/sealed-recipes/rust-toolchain.toml`

`contracts/tusdc` is a standard NEP-141 token, "Test USD (Sealed Recipes)", symbol tUSDC, 6 decimals, with no value.
Only the faucet account can mint, at most 10,000 tUSDC per call, and only to accounts that ask for it.
