#!/usr/bin/env bash
# Upgrades the marketplace contract's code in place (no init call: its state, recipes, runs and balances are kept).
# Build first (./10-build.sh). Only for changes that keep the state layout, such as new methods.
source "$(dirname "$0")/config.sh"
MW="$REPO/contracts/sealed-recipes/target/near/sealed_recipes.wasm"
[ -f "$MW" ] || { echo "build first: ./10-build.sh"; exit 1; }
sha256sum "$MW"
near contract deploy "$MARKET" use-file "$MW" without-init-call network-config "$NETWORK" sign-with-legacy-keychain send
near_view "$MARKET" get_config
