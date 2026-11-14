# Contributing

Thanks for looking. The quickest way to be useful is to run it and tell us where it surprised you.

## Get set up

```bash
git clone https://github.com/ztoori/sealed-recipes.git && cd sealed-recipes
npm install            # Node.js 20.6+; Linux, macOS or WSL
npm run doctor         # says what is installed and what each script needs
npm run demo           # the app at http://127.0.0.1:8080, on local stand-ins for every outside service
```

[AGENTS.md](AGENTS.md) lists every script with what it proves and what it should print.

## Before you open a pull request

```bash
npm run typecheck && npm test && npm run test:e2e
```

If you touched the contract: `npm run test:rust`. If you touched money, pricing or deposit logic: `npm run verify`, and keep the Rust contract and the TypeScript mirror (`core/src/ledger.ts`) passing the same vector files in `contracts/test-vectors/`.

## Things worth knowing

- **The code hash.** `runner/src`, `core/src` and `standard/*.json` are hashed into `AUDITED_CODEHASH`, which the contract pins for the live runner and CI checks. A change there needs `npm run pin-codehash` and means a new runner release, so keep such changes separate from everything else.
- **Parts.** A new part is a manifest in `standard/parts.json` plus a module in `runner/src/parts/`. The spec is [docs/SRS-1.md](docs/SRS-1.md); Compose › Part in the app checks conformance as you type, and `tests/srs.test.ts` checks every part.
- **Claims.** If you change what the product does, change what the README, the app and the film say it does in the same pull request. The film's lines are in `web/src/components/demo-film/script.ts`; `npm run film:check` tells you whether the narration still fits.
- **Keys.** Never commit one. `.gitignore` covers the usual file names; `.env.example` lists the optional settings.

## Style

TypeScript, strict. Comments say why, in plain words. User-facing text is short and literal: say what happens, and what the limits are.

By contributing you agree that your work is released under the [MIT licence](LICENSE).
