#!/usr/bin/env bash
# RETIRED on the live site: this registered the local-dev runner (runner.sealedrecipes.testnet, deactivated with
# set_runner_active false). The live runner is the TDX one: ./45-tee-runner.sh. Kept for a local-dev setup of your
# own: it refuses to run unless LOCAL_DEV_RUNNER=1.
# Registers the live runner on the contract, or records its new code release if it is registered (owner only): its signing key (verifies quotes and reports), its
# encryption key (recipes and inputs are sealed to it) and the audited code hash. Run after the srs-live-runner
# service has started once (it creates its keys). The keys file belongs to the service user, so the identity is read
# as that user from the live checkout; nothing secret is printed (public keys and the code hash only).
#   ./40-runner.sh            (as the user holding the owner key; asks for sudo to read the runner's public keys)
source "$(dirname "$0")/config.sh"
if [ "${LOCAL_DEV_RUNNER:-}" != 1 ]; then
  echo "40-runner.sh is retired: the live runner is the TDX one (./45-tee-runner.sh). For a local-dev setup of your own, rerun with LOCAL_DEV_RUNNER=1." >&2
  exit 1
fi
: "${RUNNER_FEE:=30000}"   # 0.03 tUSDC per run to the runner
: "${LIVE_DIR:=/opt/srs-live}"
: "${RUNNER_KEYS_PATH:=/var/lib/srs-live/runner-keys.json}"
id=$(sudo -u srs bash -c "cd '$LIVE_DIR' && RUNNER_KEYS_PATH='$RUNNER_KEYS_PATH' node --import tsx scripts/testnet/runner-identity.ts")
echo "runner identity: $id"
args=$(node -e 'const r=JSON.parse(process.argv[1]); console.log(JSON.stringify({ id: process.argv[2], signing_pk: r.signing_pk, enc_pk_hex: r.enc_pk_hex, codehash: r.codehash, fee_per_run: process.argv[3] }))' "$id" "$RUNNER_ID" "$RUNNER_FEE")
if near_view "$MARKET" get_runner "{\"runner_id\":\"$RUNNER_ID\"}" 2>/dev/null | grep -q signing_pk; then
  # already registered: record the new audited code release (keys must be unchanged, or sealed recipes break)
  pk=$(node -e 'console.log(JSON.parse(process.argv[1]).signing_pk)' "$id")
  near_view "$MARKET" get_runner "{\"runner_id\":\"$RUNNER_ID\"}" | grep -q "$pk" || { echo "the runner's signing key changed: keys must stay the same for recipes sealed to it"; exit 1; }
  codehash=$(node -e 'console.log(JSON.parse(process.argv[1]).codehash)' "$id")
  near_call "$MARKET" set_runner_codehash "{\"id\":\"$RUNNER_ID\",\"codehash\":\"$codehash\"}" "$ROOT_ACCOUNT"
else
  near_call "$MARKET" add_runner "$args" "$ROOT_ACCOUNT"
fi
near_view "$MARKET" get_runner "{\"runner_id\":\"$RUNNER_ID\"}"
