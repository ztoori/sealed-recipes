# Sealed Recipes on NEAR testnet: account names and settings shared by the scripts in this folder.
# Override any of them in the environment, e.g.  ROOT_ACCOUNT=myname.testnet ./20-deploy.sh
: "${ROOT_ACCOUNT:=sealedrecipes.testnet}"         # owner; parent of the accounts below
: "${MARKET:=market.$ROOT_ACCOUNT}"                 # the Sealed Recipes contract
: "${TOKEN:=tusdc.$ROOT_ACCOUNT}"                   # Test USD (tUSDC), 6 decimals
: "${RELAYER:=relayer.$ROOT_ACCOUNT}"               # relays the runner's signed reports
: "${TEE_RUNNER_ID:=tee.$ROOT_ACCOUNT}"            # the live runner: the TDX one on Phala Cloud (45-tee-runner.sh)
: "${RUNNER_ID:=runner.$ROOT_ACCOUNT}"              # the retired local-dev runner (40-runner.sh, local setups only)
: "${TREASURY:=treasury.$ROOT_ACCOUNT}"             # receives the protocol fee
: "${FAUCET:=faucet.$ROOT_ACCOUNT}"                 # the only account that can mint tUSDC
: "${PROTOCOL_FEE_BPS:=200}"                        # 2%
: "${UPDATE_DELAY_NS:=60000000000}"                 # notice before a new recipe version applies: 60 s on testnet (24 h suggested on mainnet)
: "${PRICE_PERIOD_NS:=3600000000000}"               # pricing period: 1 h
: "${MAX_MINT:=10000000000}"                        # faucet cap per mint: 10,000 tUSDC
: "${NETWORK:=testnet}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
near_call() { # near_call <contract> <method> <json-args> <signer> [deposit NEAR] [gas Tgas]
  near contract call-function as-transaction "$1" "$2" json-args "$3" prepaid-gas "${6:-50.0} Tgas" attached-deposit "${5:-0} NEAR" \
    sign-as "$4" network-config "$NETWORK" sign-with-legacy-keychain send
}
near_view() { near contract call-function as-read-only "$1" "$2" json-args "${3:-{\}}" network-config "$NETWORK" now; }
set -euo pipefail
