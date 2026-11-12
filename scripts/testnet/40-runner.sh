#!/usr/bin/env bash
# Registers the runner on the contract (owner only): its signing key (verifies quotes and reports), its encryption
# key (recipes and inputs are sealed to it) and the audited code hash. The keys are the live runner's local-dev
# keys (no TEE yet): RUNNER_KEYS_PATH must be the file the live runner service will use, readable here.
#   sudo RUNNER_KEYS_PATH=/var/lib/srs-live/runner-keys.json ./40-runner.sh   (or run as a user that can read it)
source "$(dirname "$0")/config.sh"
: "${RUNNER_FEE:=30000}"   # 0.03 tUSDC per run to the runner
cd "$REPO"
id=$(node --import tsx scripts/testnet/runner-identity.ts)
echo "runner identity: $id"
args=$(node -e 'const r=JSON.parse(process.argv[1]); console.log(JSON.stringify({ id: process.argv[2], signing_pk: r.signing_pk, enc_pk_hex: r.enc_pk_hex, codehash: r.codehash, fee_per_run: process.argv[3] }))' "$id" "$RUNNER_ID" "$RUNNER_FEE")
near_call "$MARKET" add_runner "$args" "$ROOT_ACCOUNT"
near_view "$MARKET" get_runner "{\"runner_id\":\"$RUNNER_ID\"}"
