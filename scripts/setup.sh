#!/usr/bin/env bash
# One-time setup for Sealed Recipes on Linux, macOS or WSL. Run it once from the project folder, then open a new terminal.
#
#   bash scripts/setup.sh            Node 22, npm packages, Python + Z3          (npm test, demo, verify)
#   bash scripts/setup.sh --all      + Rust, wasm target, cargo-near, Java + TLA+ (test:rust, build:wasm, verify:tla)
#   bash scripts/setup.sh --check    only list missing system packages and the command that installs them; change nothing
#
# sudo is used for one thing only: installing missing system packages, at the very start. The script lists them before
# asking, never calls sudo when nothing is missing, and never uses it on macOS (Homebrew needs no sudo). If you can't use
# sudo, it prints the one command for an administrator and stops before changing anything. Everything else installs into
# your home folder (~/.nvm, ~/.cargo) or into this project (node_modules, .venv, tools/).
#
# Maintainers only: --with-media adds ffmpeg and Playwright Chromium for re-recording docs/media (npm run record:film).
# Single options: --with-rust, --with-wasm, --with-tla. Safe to run again: each step skips what is already installed.
#
# Supported: Debian/Ubuntu and WSL (apt), Fedora/RHEL (dnf), Arch (pacman), openSUSE (zypper), macOS (Homebrew).
# Elsewhere it lists what is missing so you can install it yourself. Native Windows: use WSL or the dev container.
#
# Tested (2026-11-14), in sandboxes that can't reach nodejs.org or sh.rustup.rs:
#   Ubuntu 24.04 x86_64, root: --check; system-package step with a real apt install; nvm install. Stopped at the
#     Node download (blocked there).
#   Ubuntu 24.04 x86_64, account without sudo: the "ask an administrator" stop.
#   Ubuntu 22.04 x86_64, account without sudo: --check; the "ask an administrator" stop; "all present, no sudo needed";
#     nvm install and npm ci. The Python venv step could not run on that sandbox's mounted folder (works in /tmp).
#   WSL2 Ubuntu: the steps after the system-package step are unchanged from the previous apt-only script, which ran
#     there through Node, npm, Z3 and Rust.
#   Fedora/Rocky (dnf), Arch (pacman), openSUSE (zypper), macOS (Homebrew), unknown distros: detection and package
#     names checked only with a simulated /etc/os-release and uname (SETUP_OS_RELEASE / SETUP_UNAME) and a restricted
#     PATH. Not yet run on a real machine of those kinds.
#   Not run anywhere yet with this script: rustup, cargo-near, the TLA+ download, --with-media.
set -euo pipefail

NODE_MAJOR=22
TLA_VERSION=1.8.0
WITH_RUST=0 WITH_WASM=0 WITH_TLA=0 WITH_MEDIA=0 CHECK_ONLY=0
for a in "$@"; do
  case "$a" in
    --all) WITH_RUST=1; WITH_WASM=1; WITH_TLA=1 ;;
    --with-rust) WITH_RUST=1 ;;
    --with-wasm) WITH_RUST=1; WITH_WASM=1 ;;
    --with-tla) WITH_TLA=1 ;;
    --with-media) WITH_MEDIA=1 ;;
    --check) CHECK_ONLY=1 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown option: $a (see --help)"; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

case "$ROOT" in
  /mnt/[a-z]/*) echo "note: the project is on the Windows drive ($ROOT). It works, but npm and cargo are much slower here."
    echo "      Faster: git clone \"$ROOT\" ~/sealed-recipes && cd ~/sealed-recipes && bash scripts/setup.sh" ;;
esac

# ---- 1. System packages: the only step that can need sudo ------------------------------------------------------
# Checks what is needed by what it does (a command works, a header is found), not by package name, so a machine
# that already has everything passes on any OS without sudo.
OS="$(${SETUP_UNAME:-uname} -s)"
PM=""
if [ "$OS" = Darwin ]; then
  PM=brew
elif [ -r "${SETUP_OS_RELEASE:-/etc/os-release}" ]; then
  # shellcheck disable=SC1090
  ids="$(. "${SETUP_OS_RELEASE:-/etc/os-release}"; echo " ${ID:-} ${ID_LIKE:-} ")"
  case "$ids" in
    *" debian "*|*" ubuntu "*) PM=apt ;;
    *" fedora "*|*" rhel "*|*" centos "*) PM=dnf ;;
    *" arch "*) PM=pacman ;;
    *" suse "*|*" opensuse "*|*opensuse-*) PM=zypper ;;
  esac
fi

# needed item -> package name for each manager: apt | dnf | pacman | zypper | brew | plain name for other systems
# ("-" = nothing to install there)
pkg() {
  local col
  case "$PM" in apt) col=1 ;; dnf) col=2 ;; pacman) col=3 ;; zypper) col=4 ;; brew) col=5 ;; *) col=6 ;; esac
  case "$1" in
    curl)     set -- curl curl curl curl - curl ;;
    git)      set -- git git git git git git ;;
    venv)     set -- python3-venv python3 python python3 python python3-with-venv ;;
    cc)       set -- build-essential "gcc gcc-c++ make" base-devel "gcc gcc-c++ make" - C-compiler ;;
    pkgconf)  set -- pkg-config pkgconf-pkg-config pkgconf pkg-config pkgconf pkg-config ;;
    openssl)  set -- libssl-dev openssl-devel openssl libopenssl-devel openssl@3 OpenSSL-headers ;;
    libudev)  set -- libudev-dev systemd-devel systemd-libs libudev-devel - libudev-headers ;;
    unzip)    set -- unzip unzip unzip unzip - unzip ;;
    java)     set -- openjdk-17-jre-headless java-21-openjdk-headless jre21-openjdk-headless java-21-openjdk-headless openjdk@17 Java-11+ ;;   # TLC needs Java 11+
    ffmpeg)   set -- ffmpeg ffmpeg-free ffmpeg ffmpeg-7 ffmpeg ffmpeg ;;
  esac
  eval "echo \"\${$col}\""
}

NEED=""
need() { NEED="$NEED $1"; }
have curl || need curl
have git || need git
python3 -c 'import venv, ensurepip' >/dev/null 2>&1 || need venv
if [ "$WITH_RUST" = 1 ]; then
  have cc || need cc
  have pkg-config || need pkgconf
  pkg-config --exists openssl 2>/dev/null || need openssl
fi
if [ "$WITH_WASM" = 1 ]; then
  [ "$OS" = Darwin ] || pkg-config --exists libudev 2>/dev/null || need libudev   # cargo-near links hidapi
  have unzip || need unzip
fi
[ "$WITH_TLA" = 1 ] && { java -version >/dev/null 2>&1 || need java; }
[ "$WITH_MEDIA" = 1 ] && { have ffmpeg || need ffmpeg; }

say "System packages${PM:+ ($PM)}"
INSTALL="" PKGS="" MANUAL=""
for n in $NEED; do
  p="$(pkg "$n")"
  if [ "$p" = - ]; then MANUAL="$MANUAL $n"; else PKGS="$PKGS $p"; fi
done
PKGS="${PKGS# }"
case "$PM" in
  apt)    INSTALL="apt-get update && apt-get install -y $PKGS" ;;
  dnf)    INSTALL="dnf install -y $PKGS" ;;
  pacman) INSTALL="pacman -S --needed --noconfirm $PKGS" ;;
  zypper) INSTALL="zypper --non-interactive install $PKGS" ;;
  brew)   INSTALL="brew install $PKGS" ;;
esac
# macOS: the C compiler comes with Apple's command line tools, not Homebrew
case " $MANUAL " in *" cc "*) [ "$OS" = Darwin ] && echo "C compiler missing: run  xcode-select --install  then run this script again." && exit 1 ;; esac

if [ -z "$PKGS" ]; then
  echo "all present, no sudo needed"
  [ "$CHECK_ONLY" = 1 ] && exit 0
elif [ -z "$PM" ]; then
  echo "Missing: $PKGS"
  echo "This system's package manager isn't one this script knows (apt, dnf, pacman, zypper, Homebrew)."
  echo "Install the items above with your package manager, then run this script again."
  exit 1
elif [ "$PM" = brew ]; then
  echo "Missing: $PKGS"
  if [ "$CHECK_ONLY" = 1 ]; then echo "Would run (no sudo): $INSTALL"; exit 0; fi
  have brew || { echo "Homebrew is needed to install them: https://brew.sh, then run this script again."; exit 1; }
  sh -c "$INSTALL"
else
  echo "Missing: $PKGS"
  if [ "$CHECK_ONLY" = 1 ]; then echo "Would run (needs sudo): sudo sh -c '$INSTALL'"; exit 0; fi
  if [ "$(id -u)" = 0 ]; then
    sh -c "$INSTALL"
  elif have sudo && { sudo -n true 2>/dev/null || id -nG | grep -qwE 'sudo|admin|wheel'; }; then
    echo "sudo is needed once to install them. This is the only time the script asks for your password."
    sudo sh -c "$INSTALL"
  else
    echo "This account can't use sudo. Ask an administrator to run this once, then run this script again:"
    echo
    echo "    sudo sh -c '$INSTALL'"
    echo
    echo "Nothing has been changed."
    exit 1
  fi
fi
# Homebrew's openjdk@17 is not linked onto PATH by default
if [ "$WITH_TLA" = 1 ] && [ "$PM" = brew ] && ! java -version >/dev/null 2>&1 && have brew; then
  JDK_BIN="$(brew --prefix openjdk@17)/bin"
  export PATH="$JDK_BIN:$PATH"
  JAVA_NOTE="Java: add this to your shell profile:  export PATH=\"$JDK_BIN:\$PATH\""
fi

# ---- 2. Everything below is per user or per project: no sudo ---------------------------------------------------
say "Node.js $NODE_MAJOR (nvm, in ~/.nvm)"
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | PROFILE=/dev/null bash; fi
# shellcheck disable=SC1091
set +u; . "$NVM_DIR/nvm.sh"
# (a failed command in the middle of an && chain doesn't stop a set -e script, so check it explicitly)
nvm install "$NODE_MAJOR" >/dev/null || { echo "Could not install Node $NODE_MAJOR with nvm (no access to nodejs.org?)."; exit 1; }
nvm alias default "$NODE_MAJOR" >/dev/null
nvm use "$NODE_MAJOR" >/dev/null
set -u
echo "node $(node -v), npm $(npm -v)"
# load nvm in new shells. On WSL this also matters because Windows' PATH is appended: without nvm loaded, a new
# shell would pick up Windows npm and fail with "UNC paths are not supported"
case "${SHELL:-}" in */zsh) RC="$HOME/.zshrc" ;; *) RC="$HOME/.bashrc" ;; esac
if ! grep -q 'NVM_DIR' "$RC" 2>/dev/null; then
  printf '\nexport NVM_DIR="$HOME/.nvm"\n[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"\n' >> "$RC"
fi

say "npm packages (node_modules)"
if [ -d node_modules ] && [ ! -e node_modules/.linux-installed ] && [ ! -e node_modules/.wsl-installed ] && [ "$OS" != Darwin ]; then
  # node_modules installed on Windows contain Windows binaries (esbuild, rollup) that fail here
  echo "node_modules came from another OS: moving it to node_modules.windows-backup"
  rm -rf node_modules.windows-backup && mv node_modules node_modules.windows-backup
fi
npm ci --no-audit --no-fund
[ "$OS" = Darwin ] || touch node_modules/.linux-installed

say "Python + Z3 (.venv, used by npm run verify)"
[ -x .venv/bin/python ] || python3 -m venv .venv
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet "z3-solver>=4.12"
.venv/bin/python -c "import z3; print('z3', z3.get_version_string())"

if [ "$WITH_RUST" = 1 ]; then
  say "Rust (rustup, in ~/.cargo)"
  if ! have cargo && [ ! -x "$HOME/.cargo/bin/cargo" ]; then curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal; fi
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
  rustup component add clippy >/dev/null
  rustc --version
fi
if [ "$WITH_WASM" = 1 ]; then
  say "wasm target + cargo-near (contract build)"
  rustup target add wasm32-unknown-unknown
  if ! have cargo-near; then
    # prebuilt binary first (seconds); compile from source only if that fails
    curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/latest/download/cargo-near-installer.sh | sh \
      || cargo install --locked cargo-near
    # shellcheck disable=SC1091
    . "$HOME/.cargo/env"
  fi
  cargo near --version
fi
if [ "$WITH_TLA" = 1 ]; then
  say "TLA+ tools $TLA_VERSION (tools/tla2tools.jar)"
  mkdir -p tools
  [ -s tools/tla2tools.jar ] || curl -fsSL -o tools/tla2tools.jar "https://github.com/tlaplus/tlaplus/releases/download/v$TLA_VERSION/tla2tools.jar"
  java -version 2>&1 | head -1
fi
MEDIA_NOTE=""
if [ "$WITH_MEDIA" = 1 ]; then
  say "Playwright Chromium (maintainers: npm run record:film)"
  # playwright is not a project dependency; --no-save keeps package.json as is (the next npm ci removes it again)
  npm install --no-save --no-audit --no-fund playwright >/dev/null
  npx playwright install chromium   # browser only: no --with-deps, so no hidden sudo
  if ! node -e "require('playwright').chromium.launch().then(b => b.close())" >/dev/null 2>&1; then
    MEDIA_NOTE="Chromium is installed but can't start: system libraries are missing."
    [ "$PM" = apt ] && MEDIA_NOTE="$MEDIA_NOTE Run once (needs sudo):
    sudo env PATH=\"\$PATH\" npx playwright install-deps chromium"
    [ "$PM" != apt ] && MEDIA_NOTE="$MEDIA_NOTE Playwright installs them automatically only on Debian/Ubuntu; elsewhere set SRS_CHROME to an installed Chrome."
  fi
fi

say "Check"
node scripts/doctor.mjs || true
[ -n "${JAVA_NOTE:-}" ] && printf '\n%s\n' "$JAVA_NOTE"
[ -n "$MEDIA_NOTE" ] && printf '\n%s\n' "$MEDIA_NOTE"
cat <<'EOF'

Done. Open a new terminal (so node and cargo are on PATH), then:
  npm test            TypeScript tests
  npm run verify      Z3 proofs
  npm run demo        the app at http://127.0.0.1:8080
EOF
[ "$WITH_RUST" = 1 ] && echo "  npm run test:rust   contract tests"
[ "$WITH_WASM" = 1 ] && echo "  npm run build:wasm  contract wasm -> contracts/sealed-recipes/target/near/"
[ "$WITH_TLA" = 1 ] && echo "  npm run verify:tla  TLC model check (~10 min)"
exit 0
