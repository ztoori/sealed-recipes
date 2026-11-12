#!/usr/bin/env bash
# Installs what building and deploying the contracts needs, for the current user: Rust with the wasm target,
# cargo-near, and near-cli-rs. Safe to run again: it skips what is already there.
source "$(dirname "$0")/config.sh"
if ! command -v cargo >/dev/null; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  source "$HOME/.cargo/env"
fi
rustup target add wasm32-unknown-unknown
command -v cargo-near >/dev/null || curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/latest/download/cargo-near-installer.sh | sh
command -v near >/dev/null || curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/near-cli-rs/releases/latest/download/near-cli-rs-installer.sh | sh
source "$HOME/.cargo/env" 2>/dev/null || true
cargo --version && cargo near --version && near --version
