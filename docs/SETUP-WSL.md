# Building on WSL

On Windows, build and run everything inside WSL (Ubuntu), not in PowerShell. The scripts, the Rust contract build and the Z3/TLA+ tools all expect Linux.

1. **Put the project in the WSL filesystem**, not on `C:`. Under `/mnt/c` npm and cargo are many times slower, and `node_modules` installed on Windows contain Windows binaries that fail in Linux.
   ```bash
   git clone https://github.com/ztoori/sealed-recipes.git ~/sealed-recipes
   # add --depth 1 for just the latest version; the full history (and the tags) stays on GitHub
   cd ~/sealed-recipes
   ```
2. **Install the toolchain** with one script. It is safe to re-run, uses `sudo` only for apt packages, and installs Node with nvm and Z3 in a project virtualenv (`.venv`).
   ```bash
   bash scripts/setup-wsl.sh             # Node 22, npm packages, Python + Z3
   bash scripts/setup-wsl.sh --all       # + Rust, wasm target + cargo-near, Java + tla2tools.jar, ffmpeg + Playwright
   ```
   Options: `--with-rust` (contract tests), `--with-wasm` (contract build), `--with-tla` (TLC model check), `--with-media` (re-record the video).
3. **Check, then build and run**:
   ```bash
   npm run doctor          # what is installed, what each npm script needs, how to fix what's missing
   npm test && npm run verify && npm run test:rust
   npm run build:wasm      # contract wasm via cargo-near -> contracts/sealed-recipes/target/near/
   npm run demo            # opens http://127.0.0.1:8080 in your Windows browser
   ```

**Getting a new version.** Pull it, then reinstall in case dependencies changed:
```bash
cd ~/sealed-recipes
git pull
npm install
npm run demo            # rebuilds the web app automatically when its sources changed
```
If the browser still shows the old screens, reload with Ctrl+F5.

If `npm` fails with "UNC paths are not supported" or `C:\Windows\scripts\...`, the shell is running Windows npm: WSL adds the Windows PATH, and Linux Node isn't loaded in that terminal yet. Run `source ~/.nvm/nvm.sh` or open a new terminal; `which npm` should show `~/.nvm/...`, not `/mnt/c/...`.

WSL2 forwards `localhost` to Windows by default, so the Windows browser reaches the demo. If yours doesn't (custom `.wslconfig`), start it with `SRS_HOST=0.0.0.0 npm run demo` and open `http://<WSL IP>:8080` (`hostname -I` shows the IP).

The setup script was tested end to end on Ubuntu 24.04: from a fresh clone it installs everything, after which `npm test`, `npm run verify`, `npm run test:e2e` and `npm run test:rust` pass. `npm run build:wasm` couldn't be tested on our build machine, because it can't download the wasm target. If `cargo near` rejects the wasm for unsupported wasm features with a very new Rust, add a `rust-toolchain.toml` with `channel = "1.86"` in `contracts/sealed-recipes` and run it again.
