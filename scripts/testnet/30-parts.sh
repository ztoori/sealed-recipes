#!/usr/bin/env bash
# Registers every part of the catalog (standard/parts.json) on the contract with its fee and manifest hash.
# On testnet the parts are registered by ROOT_ACCOUNT, so part payouts accrue to it (the catalog's author names are
# demo names). Each registration pays ~0.003-0.01 NEAR of storage (the rest is refunded). Already registered parts
# are skipped, including when an RPC node's view lags behind and the contract answers "part exists".
source "$(dirname "$0")/config.sh"
set +e
cd "$REPO"
fails=0
while IFS= read -r args; do
  id=$(node -e 'console.log(JSON.parse(process.argv[1]).id)' "$args")
  if near_view "$MARKET" get_part "{\"part_id\":\"$id\"}" 2>/dev/null | grep -q manifest_hash; then echo "skip $id (registered)"; continue; fi
  if near_call "$MARKET" register_part "$args" "$ROOT_ACCOUNT" 0.02 >/tmp/srs-register.log 2>&1; then echo "registered $id"
  elif grep -q 'part exists' /tmp/srs-register.log; then echo "skip $id (registered)"
  else echo "FAILED $id"; tail -5 /tmp/srs-register.log; fails=$((fails + 1)); fi
done < <(node --import tsx scripts/testnet/part-args.ts)
echo "registered parts on $MARKET: $(near_view "$MARKET" list_parts '{"from_index":0,"limit":100}' 2>/dev/null | grep -c '"manifest_hash"')"
exit $fails
