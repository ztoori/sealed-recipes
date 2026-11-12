#!/usr/bin/env bash
# Builds both contracts to wasm (contracts/*/target/near/*.wasm) and prints their sizes and hashes.
source "$(dirname "$0")/config.sh"
source "$HOME/.cargo/env" 2>/dev/null || true
for c in tusdc sealed-recipes; do
  (cd "$REPO/contracts/$c" && cargo near build non-reproducible-wasm --no-abi)
done
ls -l "$REPO"/contracts/*/target/near/*.wasm
sha256sum "$REPO"/contracts/*/target/near/*.wasm
