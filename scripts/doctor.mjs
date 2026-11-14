#!/usr/bin/env node
/**
 * `npm run doctor`: checks that this machine can build, test and run Sealed Recipes, and says how to fix what's
 * missing. Written for WSL/Linux; prints what each npm script needs. Exit code 1 only if a core requirement fails.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd) => { try { return execSync(cmd, { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; } };
const rows = [];
let coreFail = false;
// maintainer: only needed to re-record docs/media; shown as optional, not as a failure
const check = (name, ok, detail, fix, core = false, maintainer = false) => { rows.push({ name, ok, detail, fix, maintainer }); if (!ok && core) coreFail = true; };

const isWsl = existsSync('/proc/version') && /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
check('platform', process.platform !== 'win32', `${process.platform}${isWsl ? ' (WSL)' : ''}`, 'Run in WSL: wsl, then cd to the project', true);
check('project location', !/^\/mnt\/[a-z]\//.test(root), root, `Copy into the WSL filesystem: git clone "${root}" ~/sealed-recipes`);

const major = Number(process.versions.node.split('.')[0]);
check('node >= 20.6', major > 20 || (major === 20 && Number(process.versions.node.split('.')[1]) >= 6), process.versions.node, 'bash scripts/setup.sh (installs Node 22 with nvm)', true);
const nm = existsSync(resolve(root, 'node_modules'));
check('npm packages', nm, nm ? 'installed' : 'missing', 'npm ci', true);
if (nm) {
  // Windows-installed node_modules carry win32 binaries that crash on Linux (esbuild is the usual one)
  const esb = run('node -e "require(\'esbuild\'); console.log(require(\'esbuild\').version)"');
  check('native binaries match this OS', !!esb, esb ? `esbuild ${esb}` : 'esbuild failed to load', 'rm -rf node_modules && npm ci   (it was installed on Windows)', true);
}
const py = existsSync(resolve(root, '.venv/bin/python')) ? '.venv/bin/python' : 'python3';
const z3 = run(`${py} -c "import z3; print(z3.get_version_string())"`);
check('python + z3 (npm run verify)', !!z3, z3 ? `${py}, z3 ${z3}` : `${py}: z3 not importable`, 'bash scripts/setup.sh');
const cargo = run('cargo --version') ?? (existsSync(`${process.env.HOME}/.cargo/bin/cargo`) ? 'installed, not on PATH' : null);
check('rust (npm run test:rust)', !!cargo && !/not on PATH/.test(cargo), cargo ?? 'missing', cargo ? 'source ~/.cargo/env' : 'bash scripts/setup.sh --with-rust');
const wasm = run('rustup target list --installed');
check('wasm32 target (npm run build:wasm)', !!wasm && wasm.includes('wasm32-unknown-unknown'), wasm ? (wasm.includes('wasm32-unknown-unknown') ? 'installed' : 'not installed') : 'no rustup', 'bash scripts/setup.sh --with-wasm');
const near = run('cargo near --version');
check('cargo-near (npm run build:wasm)', !!near, near ?? 'missing', 'bash scripts/setup.sh --with-wasm');
const java = run('java -version 2>&1');
const jar = existsSync(process.env.TLA2TOOLS ?? resolve(root, 'tools/tla2tools.jar'));
check('java + tla2tools.jar (npm run verify:tla)', !!java && jar, `${java ? 'java ok' : 'no java'}, ${jar ? 'jar ok' : 'no jar'}`, 'bash scripts/setup.sh --with-tla');
const ff = run('ffmpeg -version');
check('ffmpeg (maintainers: npm run record:film)', !!ff, ff ? ff.split('\n')[0] : 'not installed (optional: only for re-recording the videos)', 'bash scripts/setup.sh --with-media', false, true);
const crlf = run('git ls-files --eol package.json scripts/demo.mjs');
check('line endings (LF)', !crlf || !/w\/crlf/.test(crlf), crlf ? 'LF' : 'not a git checkout', 'git config core.autocrlf false && git rm --cached -r . -q && git reset --hard   (re-checkout with LF)');

const w = Math.max(...rows.map((r) => r.name.length));
for (const r of rows) {
  const mark = r.ok ? '✔' : r.maintainer ? '–' : '✘';
  const hint = r.ok ? '' : `\n  ${' '.repeat(w)}  ${r.maintainer ? 'if needed' : 'fix'}: ${r.fix}`;
  console.log(`${mark} ${r.name.padEnd(w)}  ${r.detail}${hint}`);
}
console.log(coreFail ? '\nCore requirements missing: npm test / demo will not run yet.' : '\nCore requirements met: npm test, npm run demo. Optional items above enable the other scripts.');
process.exit(coreFail ? 1 : 0);
