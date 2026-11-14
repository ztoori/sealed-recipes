#!/usr/bin/env node
// Runs a Python script with the project's virtualenv (.venv, created by scripts/setup.sh) when present,
// otherwise with python3 from PATH. Used by `npm run verify` so Z3 doesn't need a system-wide pip install.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const venv = resolve(root, '.venv/bin/python');
const py = existsSync(venv) ? venv : 'python3';
const r = spawnSync(py, process.argv.slice(2), { cwd: root, stdio: 'inherit' });
if (r.error) { console.error(`could not run ${py}: ${r.error.message}\nrun: bash scripts/setup.sh`); process.exit(1); }
process.exit(r.status ?? 1);
