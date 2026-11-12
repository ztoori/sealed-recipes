#!/usr/bin/env bash
# Registers every part of the catalog (standard/parts.json) on the contract with its fee and manifest hash.
# On testnet the parts are registered by ROOT_ACCOUNT, so part payouts accrue to it (the catalog's author names are
# demo names). Each registration pays ~0.003-0.01 NEAR of storage (the rest is refunded). Skips registered parts.
source "$(dirname "$0")/config.sh"
cd "$REPO"
node --import tsx scripts/testnet/part-args.ts | while IFS= read -r args; do
  id=$(node -e 'console.log(JSON.parse(process.argv[1]).id)' "$args")
  if near_view "$MARKET" get_part "{\"part_id\":\"$id\"}" 2>/dev/null | grep -q manifest_hash; then echo "skip $id (registered)"; continue; fi
  echo "register $id"
  near_call "$MARKET" register_part "$args" "$ROOT_ACCOUNT" 0.02
done
