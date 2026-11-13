#!/usr/bin/env bash
# Deploys and initializes tUSDC and the Sealed Recipes contract, then registers token storage for the accounts
# that receive tUSDC. Run once (a second `new` fails: the contracts are already initialized).
# Needs: the keys of ROOT_ACCOUNT, TOKEN and MARKET in ~/.near-credentials/testnet (created earlier).
# Cost: contract code storage, ~2 NEAR (tUSDC) and ~4-5 NEAR (market), held by those accounts.
source "$(dirname "$0")/config.sh"
TW="$REPO/contracts/tusdc/target/near/tusdc.wasm"
MW="$REPO/contracts/sealed-recipes/target/near/sealed_recipes.wasm"
[ -f "$TW" ] && [ -f "$MW" ] || { echo "build first: ./10-build.sh"; exit 1; }

echo "== tUSDC on $TOKEN (minter: $FAUCET)"
near contract deploy "$TOKEN" use-file "$TW" with-init-call new \
  json-args "{\"owner\":\"$ROOT_ACCOUNT\",\"minter\":\"$FAUCET\",\"max_mint\":\"$MAX_MINT\"}" \
  prepaid-gas '50.0 Tgas' attached-deposit '0 NEAR' network-config "$NETWORK" sign-with-legacy-keychain send

echo "== Sealed Recipes on $MARKET (payment token $TOKEN)"
near contract deploy "$MARKET" use-file "$MW" with-init-call new \
  json-args "{\"owner\":\"$ROOT_ACCOUNT\",\"payment_token\":\"$TOKEN\",\"protocol_account\":\"$TREASURY\",\"protocol_fee_bps\":$PROTOCOL_FEE_BPS,\"update_delay_ns\":\"$UPDATE_DELAY_NS\",\"price_period_ns\":\"$PRICE_PERIOD_NS\"}" \
  prepaid-gas '50.0 Tgas' attached-deposit '0 NEAR' network-config "$NETWORK" sign-with-legacy-keychain send

echo "== tUSDC storage for the accounts that hold or receive it"
# the runner fee is paid to the live runner, the TDX one (not the retired local-dev runner.$ROOT_ACCOUNT)
for a in "$MARKET" "$TREASURY" "$ROOT_ACCOUNT" "$TEE_RUNNER_ID"; do
  near_call "$TOKEN" storage_deposit "{\"account_id\":\"$a\",\"registration_only\":true}" "$ROOT_ACCOUNT" 0.0125
done

echo "== check"
near_view "$TOKEN" ft_metadata
near_view "$MARKET" get_config
