#!/usr/bin/env bash
# Sets up a WSL (Ubuntu) machine to build, test and run Sealed Recipes.
#
#   bash scripts/setup-wsl.sh                  Node, Python/Z3, npm packages: enough for test, verify, demo
#   bash scripts/setup-wsl.sh --with-rust      + Rust toolchain for the contract tests (npm run test:rust)
#   bash scripts/setup-wsl.sh --with-wasm      + wasm target and cargo-near to build the contract (npm run build:wasm)
#   bash scripts/setup-wsl.sh --with-tla       + Java and tla2tools.jar for the TLC model check (npm run verify:tla)
#   bash scripts/setup-wsl.sh --with-media     + ffmpeg and Playwright Chromium to re-record docs/media
#   bash scripts/setup-wsl.sh --all            everything above
#
# Safe to run again: each step checks what is already installed. Uses sudo only for apt packages.
# Run it from a copy of the project inside the WSL filesystem (e.g. ~/sealed-recipes), not from /mnt/c:
# builds there are many times faster and file permissions behave (see README "Building on WSL").
set -euo pipefail

NODE_MAJOR=22
TLA_VERSION=1.8.0
WITH_RUST=0 WITH_WASM=0 WITH_TLA=0 WITH_MEDIA=0
for a in "$@"; do
  case "$a" in
    --with-rust) WITH_RUST=1 ;;
    --with-wasm) WITH_RUST=1; WITH_WASM=1 ;;
    --with-tla) WITH_TLA=1 ;;
    --with-media) WITH_MEDIA=1 ;;
    --all) WITH_RUST=1; WITH_WASM=1; WITH_TLA=1; WITH_MEDIA=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option: $a (see --help)"; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

if ! grep -qi microsoft /proc/version 2>/dev/null; then echo "note: this does not look like WSL; continuing anyway (any Ubuntu/Debian works)"; fi
case "$ROOT" in
  /mnt/[a-z]/*) echo "WARNING: the project is on the Windows drive ($ROOT)."
    echo "         npm install and builds will be slow and Windows-built node_modules will not work here."
    echo "         Recommended: git clone \"$ROOT\" ~/sealed-recipes && cd ~/sealed-recipes && bash scripts/setup-wsl.sh"
    read -r -p "Continue here anyway? [y/N] " ans; [ "${ans:-n}" = y ] || exit 1 ;;
esac

say "System packages (apt)"
PKGS="build-essential pkg-config libssl-dev ca-certificates curl git python3 python3-venv python3-pip unzip"
[ "$WITH_TLA" = 1 ] && PKGS="$PKGS openjdk-17-jre-headless"
[ "$WITH_MEDIA" = 1 ] && PKGS="$PKGS ffmpeg"
MISSING=""; for p in $PKGS; do dpkg -s "$p" >/dev/null 2>&1 || MISSING="$MISSING $p"; done
if [ -n "$MISSING" ]; then sudo apt-get update -y && sudo apt-get install -y $MISSING; else echo "all present"; fi

say "Node.js $NODE_MAJOR (nvm, per user, no sudo)"
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash; fi
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install "$NODE_MAJOR" >/dev/null && nvm alias default "$NODE_MAJOR" >/dev/null && nvm use "$NODE_MAJOR" >/dev/null
echo "node $(node -v), npm $(npm -v)"

say "npm packages"
if [ -d node_modules ] && [ ! -e node_modules/.wsl-installed ]; then
  # node_modules installed on Windows contain Windows binaries (esbuild, rollup) that fail here
  echo "node_modules was not installed in this environment: moving it to node_modules.windows-backup"
  rm -rf node_modules.windows-backup && mv node_modules node_modules.windows-backup
fi
npm ci
touch node_modules/.wsl-installed

say "Python + Z3 (virtualenv in .venv, used by npm run verify)"
[ -x .venv/bin/python ] || python3 -m venv .venv
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet "z3-solver>=4.12"
.venv/bin/python -c "import z3; print('z3', z3.get_version_string())"

if [ "$WITH_RUST" = 1 ]; then
  say "Rust (rustup, per user)"
  if ! have cargo && [ ! -x "$HOME/.cargo/bin/cargo" ]; then curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal; fi
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
  rustup component add clippy >/dev/null
  echo "$(rustc --version)"
fi
if [ "$WITH_WASM" = 1 ]; then
  say "wasm target + cargo-near (contract build)"
  rustup target add wasm32-unknown-unknown
  have cargo-near || cargo install --locked cargo-near
  cargo near --version
fi
if [ "$WITH_TLA" = 1 ]; then
  say "TLA+ tools $TLA_VERSION"
  mkdir -p tools
  [ -s tools/tla2tools.jar ] || curl -fsSL -o tools/tla2tools.jar "https://github.com/tlaplus/tlaplus/releases/download/v$TLA_VERSION/tla2tools.jar"
  java -version 2>&1 | head -1
fi
if [ "$WITH_MEDIA" = 1 ]; then
  say "Playwright Chromium (for npm run record)"
  npx playwright install --with-deps chromium
fi

say "Check"
node scripts/doctor.mjs || true
cat <<'EOF'

Next:
  npm test            TypeScript tests
  npm run verify      Z3 proofs (uses .venv)
  npm run demo        local demo; open http://localhost:8080 in your Windows browser
EOF
[ "$WITH_RUST" = 1 ] && echo "  npm run test:rust   contract tests"
[ "$WITH_WASM" = 1 ] && echo "  npm run build:wasm  contract wasm -> contracts/sealed-recipes/target/near/"
[ "$WITH_TLA" = 1 ] && echo "  npm run verify:tla  TLC model check (~10 min)"
echo "Open a new terminal (or run: source ~/.nvm/nvm.sh; source ~/.cargo/env) so node and cargo are on PATH."
