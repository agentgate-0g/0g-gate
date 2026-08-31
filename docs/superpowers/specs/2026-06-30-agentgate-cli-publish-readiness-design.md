# AgentGate CLI — npm Publish Readiness

- **Date:** 2026-06-30
- **Status:** Approved (design)
- **Owner:** mdlog
- **Topic:** Make `npx @mdlog/agentgate wrap …` runnable by anyone, without cloning the repo.

## Problem

The landing page advertises `npx agentgate wrap https://api.example.com/gold --price 0.5 --name "Gold Spot Feed"`, but it does not work for external users:

1. **`agentgate` (unscoped) on npm is an unrelated package** (`agentgate@0.16.0`, maintainer `monteslu`). `npx agentgate` runs that, not ours.
2. **Our CLI is unpublishable as-is:** `packages/cli` is `"name": "@agentgate/cli"`, `"private": true`; the `@agentgate` scope on npm is owned by a third party (`amit-paz`).
3. **`bin` points at TypeScript** (`./src/bin.ts`, shebang `#!/usr/bin/env -S npx tsx`); there is no compiled JS. Node/npx cannot execute it.
4. **Runtime deps are unpublished workspace packages** (`@agentgate/chain`, `@agentgate/shared`).
5. Even if installable, `wrap` registers on-chain and needs config + a funded signer key — never truly zero-setup.

## Decisions (locked)

- **Published name:** `@mdlog/agentgate` (scoped to the owner; verified available on npm; matches `github.com/mdlog/AgentGate`). Final command: `npx @mdlog/agentgate wrap …`.
- **Approach A — rename `packages/cli` into the published package** (single source of truth). The CLI package *is* `@mdlog/agentgate`.
- **Scope:** prepare + verify only. **Do NOT run `npm publish`** — the owner publishes when ready (`npm login` required). Verification is via `npm pack` + clean tarball install test.

## Architecture

Self-contained CLI artifact built with **tsup** (esbuild):

- **Bundle (inline):** `@agentgate/shared`, `@agentgate/chain` (private workspace packages) via `noExternal`.
- **External (real npm deps → `dependencies`):** `commander`, `casper-js-sdk`, `@noble/hashes`, `@ethersproject/bignumber`. (`@noble/hashes` + `@ethersproject/bignumber` are transitive via `@agentgate/chain`; kept external and declared.)
- **No devnet pull-in:** `@agentgate/chain` does not import the `@agentgate/devnet` package at runtime — `MockChainHttpClient` only makes HTTP calls to `config.devnetUrl`. So the bundle stays small; `@agentgate/devnet` is irrelevant to the artifact.
- **Output:** ESM, `target: node22`, `platform: node`. `dist/bin.js` (CLI) + `dist/index.js` (+ `.d.ts`, library export for internal workspace consumers).
- **Shebang:** change `src/bin.ts` line 1 to `#!/usr/bin/env node` (safe — the repo invokes it via `tsx packages/cli/src/bin.ts` explicitly; tsx ignores the shebang). tsup carries it to `dist/bin.js` where it is correct.

### `packages/cli/package.json` (publish-ready)

- `name: "@mdlog/agentgate"`, remove `"private"`.
- `bin: { "agentgate": "./dist/bin.js" }`.
- `exports: { ".": "./src/index.ts" }` for local tsx dev; `publishConfig` overrides `main`/`exports`/`types` → `./dist/index.js`/`.d.ts` for the published tarball.
- `files: ["dist", "README.md"]`.
- `engines: { "node": ">=22" }`, `license: "MIT"`, `repository`/`homepage` → `mdlog/AgentGate`, `keywords` (casper, x402, ai-agents, http-402, micropayments).
- `dependencies`: the 4 external packages above.
- `devDependencies`: `@agentgate/chain`, `@agentgate/shared` (bundled → build-time), `tsup`, `@types/node`.
- `publishConfig: { "access": "public", … }`.
- `scripts`: `build: "tsup"`, `prepack: "tsup"` (ensures `dist` exists for pack/publish), keep `typecheck`, `test`.

### Rename fan-out (Approach A)

`@agentgate/cli` is imported by name in 3 code sites — update the specifier to `@mdlog/agentgate`:

- `scripts/demo.ts`
- `scripts/dev.ts`
- `e2e/loop.test.ts`

Then `npm install` to refresh the workspace symlink + lockfile. Docs that mention `@agentgate/cli` (`docs/ARCHITECTURE.md`, `docs/SPEC.md`, dashboard docs) updated for consistency where user-facing.

## UX / docs

- **README.md** in the package: install/usage, required env (`AGENTGATE_MODE=live`, `CASPER_NODE_URL`, `CSPR_CLOUD_API_KEY`, `REGISTRY_CONTRACT_PACKAGE_HASH`) + 1 funded testnet PEM, and that `npm publish` is the owner's step.
- **Friendly config error:** confirm a missing-config run prints a clear, actionable message (not a stack trace). `loadConfig()` already throws `CONFIG_INVALID`; verify the CLI surfaces it readably.
- **Fix the misleading command** on the live site: hero (`dashboard/app/page.tsx`) and `dashboard/app/docs/installation` → `npx @mdlog/agentgate wrap …`.

## Verification (the deliverable for "no publish")

1. `npm run build -w @mdlog/agentgate` (tsup) → `dist/bin.js` + `dist/index.js` exist; `dist/bin.js` starts with `#!/usr/bin/env node`; grep the bundle for no `@agentgate/` import left unresolved.
2. `npm pack` → inspect tarball contents (only `dist` + README + package.json; correct `bin`).
3. Install the tarball in a **clean temp dir** (outside the workspace), then run `npx @mdlog/agentgate --help` and a config-less `wrap` → confirm it loads via node (no tsx), shows help, and errors gracefully without config.
4. Regression: `npm run typecheck`, `npm run demo` exits 0, `e2e` green — the rename broke nothing.
5. Rebuild + restart the live dashboard so the corrected hero/docs command is served; re-verify pages.

## Out of scope

- Running `npm publish` (owner's step).
- Changing CLI logic, default mode, or on-chain behavior.
- Publishing the other `@agentgate/*` internal packages.
- An `agentgate init` config wizard (noted as a future nicety).

## Risks

- **Rename breakage** → mitigated by typecheck + demo + e2e regression gate.
- **`publishConfig` field overrides** (`exports`/`main`/`types`) — npm ≥7 supports them; `bin` is set at top level (`dist/bin.js`) to avoid relying on override for the npx entry.
- **casper-js-sdk kept external** (large/dynamic) — correct as a declared dependency; not bundled.
