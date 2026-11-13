#!/usr/bin/env bash
# Registers the runner that runs in a TDX CVM (Phala Cloud) on the contract, after checking its attestation
# (Intel DCAP, fresh nonce, audited code hash: scripts/testnet/tee-identity.ts). A runner's keys can't change once
# registered, so the TEE runner has its own identity (the retired local-dev one was runner.$ROOT_ACCOUNT).
# If it is registered already (same keys), records a new audited code release instead.
#   RUNNER_URL=https://<app-id>-8787.<node>.phala.network ./45-tee-runner.sh    (as the user holding the owner key)
source "$(dirname "$0")/config.sh"
: "${RUNNER_FEE:=30000}"   # 0.03 tUSDC per run to the runner
: "${RUNNER_URL:?set RUNNER_URL to the public URL of the CVM for port 8787}"
# the runner fee is paid in tUSDC: the runner account must be registered with the token (a repeat is refunded)
near_call "$TOKEN" storage_deposit "{\"account_id\":\"$TEE_RUNNER_ID\",\"registration_only\":true}" "$ROOT_ACCOUNT" 0.0125
id=$(cd "$REPO" && RUNNER_URL="$RUNNER_URL" node --import tsx scripts/testnet/tee-identity.ts)
echo "TEE runner identity: $id"
if near_view "$MARKET" get_runner "{\"runner_id\":\"$TEE_RUNNER_ID\"}" 2>/dev/null | grep -q signing_pk; then
  pk=$(node -e 'console.log(JSON.parse(process.argv[1]).signing_pk)' "$id")
  near_view "$MARKET" get_runner "{\"runner_id\":\"$TEE_RUNNER_ID\"}" | grep -q "$pk" || { echo "the TEE runner's keys changed (a new CVM app?): register it under a new TEE_RUNNER_ID and republish the recipes"; exit 1; }
  codehash=$(node -e 'console.log(JSON.parse(process.argv[1]).codehash)' "$id")
  near_call "$MARKET" set_runner_codehash "{\"id\":\"$TEE_RUNNER_ID\",\"codehash\":\"$codehash\"}" "$ROOT_ACCOUNT"
else
  args=$(node -e 'const r=JSON.parse(process.argv[1]); console.log(JSON.stringify({ id: process.argv[2], signing_pk: r.signing_pk, enc_pk_hex: r.enc_pk_hex, codehash: r.codehash, fee_per_run: process.argv[3] }))' "$id" "$TEE_RUNNER_ID" "$RUNNER_FEE")
  near_call "$MARKET" add_runner "$args" "$ROOT_ACCOUNT"
fi
near_view "$MARKET" get_runner "{\"runner_id\":\"$TEE_RUNNER_ID\"}"
