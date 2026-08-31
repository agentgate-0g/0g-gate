# AgentGate CLI npm Publish-Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npx @mdlog/agentgate wrap …` runnable by anyone without cloning the repo, by turning `packages/cli` into a self-contained, publish-ready npm package — built and verified locally, NOT published.

**Architecture:** Rename the private workspace package `@agentgate/cli` to the publishable `@mdlog/agentgate` (Approach A). Build a standalone ESM artifact with tsup that inlines the private workspace deps (`@agentgate/shared`, `@agentgate/chain`) and keeps real npm deps external. Verify via `npm pack` + a clean-room install that runs through plain `node` (no tsx).

**Tech Stack:** Node ≥22, ESM, TypeScript, tsup (esbuild), commander, casper-js-sdk.

## Global Constraints

- Published package name: `@mdlog/agentgate` (verified available on npm).
- Node engine floor: `>=22`. Output format: ESM (`"type": "module"` stays).
- Bundle (inline) ONLY: `@agentgate/shared`, `@agentgate/chain`.
- Keep external + declare as `dependencies`: `commander@^12.0.0`, `casper-js-sdk@^5.0.12`, `@noble/hashes@^1.2.0`, `@ethersproject/bignumber@^5.7.0`.
- Do NOT run `npm publish`. Do NOT change CLI logic, default mode, or on-chain behavior.
- Regression gate after structural changes: `npm run typecheck` clean and `npm run demo` exits 0.
- The CLI already has a friendly top-level error handler in `packages/cli/src/bin.ts` (`program.parseAsync(...).catch(...)` → `error: <CODE>: <msg>`); do not duplicate it.

---

### Task 1: Rename `@agentgate/cli` → `@mdlog/agentgate` (keep everything working)

**Files:**
- Modify: `packages/cli/package.json` (`name` field only)
- Modify: `scripts/demo.ts:17`, `scripts/dev.ts:10`, `e2e/loop.test.ts:21` (import specifier)

**Interfaces:**
- Consumes: nothing.
- Produces: the workspace package now resolves under the name `@mdlog/agentgate`, still exporting `wrapService`, `createDemoAccounts`, `listServices`, `serviceStatus`, `setServiceActive`, `signerAccountHash`, `signerPublicKeyHex` (unchanged from `packages/cli/src/index.ts`).

- [ ] **Step 1: Rename the package**

In `packages/cli/package.json` change the name (leave everything else for Task 2):

```json
  "name": "@mdlog/agentgate",
```

- [ ] **Step 2: Update the 3 internal importers**

Each of these lines is currently `import { createDemoAccounts, wrapService } from '@agentgate/cli';`. Change the specifier to `@mdlog/agentgate`:

- `scripts/demo.ts:17`
- `scripts/dev.ts:10`
- `e2e/loop.test.ts:21`

```ts
import { createDemoAccounts, wrapService } from '@mdlog/agentgate';
```

- [ ] **Step 3: Refresh the workspace symlink + lockfile**

Run: `npm install`
Expected: completes without error; `node_modules/@mdlog/agentgate` symlink now exists.
Verify: `node -e "require('fs').realpathSync('node_modules/@mdlog/agentgate')"` prints a path ending in `packages/cli`.

- [ ] **Step 4: Verify nothing broke (regression gate)**

Run: `npm run typecheck`
Expected: clean (no unresolved-module errors for `@mdlog/agentgate`).

Run: `npm run demo`
Expected: exits 0, prints both `payment deploy hash` and `attestation tx hash` (the full mock loop still drives `wrapService`/`createDemoAccounts` through the renamed package).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/package.json scripts/demo.ts scripts/dev.ts e2e/loop.test.ts package-lock.json
git commit -m "refactor(cli): rename @agentgate/cli -> @mdlog/agentgate (publishable name)"
```

---

### Task 2: tsup build + publish-ready `package.json` + node shebang

**Files:**
- Modify: `packages/cli/src/bin.ts:1` (shebang)
- Create: `packages/cli/tsup.config.ts`
- Modify: `packages/cli/package.json` (full publish metadata)

**Interfaces:**
- Consumes: the renamed package from Task 1.
- Produces: `packages/cli/dist/bin.js` (ESM, `#!/usr/bin/env node`, workspace deps inlined) and `packages/cli/dist/index.js`. `bin.agentgate → ./dist/bin.js`.

- [ ] **Step 1: Change the bin shebang to node**

`packages/cli/src/bin.ts` line 1 is currently `#!/usr/bin/env -S npx tsx`. Replace with:

```ts
#!/usr/bin/env node
```

(Safe: the repo invokes the CLI via `tsx packages/cli/src/bin.ts` explicitly — tsx ignores the shebang — and tsup/esbuild carries this shebang into `dist/bin.js`, where it is correct.)

- [ ] **Step 2: Create the tsup config**

Create `packages/cli/tsup.config.ts`:

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { bin: 'src/bin.ts', index: 'src/index.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  // Inline the private workspace packages so the published artifact is self-contained.
  noExternal: ['@agentgate/shared', '@agentgate/chain'],
  // Real npm packages stay external (declared in dependencies).
  external: ['casper-js-sdk', 'commander', '@noble/hashes', '@ethersproject/bignumber'],
  clean: true,
  dts: false,
  sourcemap: false,
  shims: false,
});
```

- [ ] **Step 3: Rewrite `packages/cli/package.json` with publish metadata**

Replace the whole file with:

```json
{
  "name": "@mdlog/agentgate",
  "version": "0.1.0",
  "description": "Wrap any HTTP API into a paid x402 service on Casper — HTTP 402 micropayments in native CSPR with on-chain discovery and reputation.",
  "type": "module",
  "bin": { "agentgate": "./dist/bin.js" },
  "exports": { ".": "./src/index.ts" },
  "files": ["dist", "README.md"],
  "engines": { "node": ">=22" },
  "license": "MIT",
  "homepage": "https://github.com/mdlog/AgentGate#readme",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/mdlog/AgentGate.git",
    "directory": "packages/cli"
  },
  "bugs": { "url": "https://github.com/mdlog/AgentGate/issues" },
  "keywords": ["casper", "x402", "http-402", "ai-agents", "micropayments", "agentgate", "web3", "cli"],
  "publishConfig": {
    "access": "public",
    "main": "./dist/index.js",
    "exports": { ".": "./dist/index.js" }
  },
  "scripts": {
    "build": "tsup",
    "prepack": "tsup",
    "typecheck": "tsc --noEmit -p .",
    "test": "vitest run"
  },
  "dependencies": {
    "casper-js-sdk": "^5.0.12",
    "commander": "^12.0.0",
    "@noble/hashes": "^1.2.0",
    "@ethersproject/bignumber": "^5.7.0"
  },
  "devDependencies": {
    "@agentgate/chain": "*",
    "@agentgate/shared": "*",
    "tsup": "^8.3.0",
    "@types/node": "^22.0.0"
  }
}
```

Notes: `@agentgate/chain`/`@agentgate/shared` move to `devDependencies` because they are inlined at build time (not runtime deps). `exports` stays at `src` for local tsx dev; `publishConfig` overrides it to `dist` in the published tarball. `bin` points at `dist` directly (built by `prepack` before pack/publish).

- [ ] **Step 4: Install tsup**

Run: `npm install`
Expected: installs `tsup` + `@types/node`; no errors.

- [ ] **Step 5: Build**

Run: `npm run build -w @mdlog/agentgate`
Expected: tsup reports `ESM dist/bin.js` and `ESM dist/index.js` written; exit 0.

- [ ] **Step 6: Verify the artifact**

Run: `head -1 packages/cli/dist/bin.js`
Expected: `#!/usr/bin/env node`

Run: `grep -c "from \"@agentgate/" packages/cli/dist/bin.js || true`
Expected: `0` (workspace deps were inlined, none left as bare imports).

Run: `node packages/cli/dist/bin.js --help`
Expected: commander help text listing `wrap`, `list`, `status`, `pause`, `resume`, `demo-accounts` — proving it runs under plain node, no tsx.

- [ ] **Step 7: Confirm regression still green**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/cli/package.json packages/cli/tsup.config.ts packages/cli/src/bin.ts package-lock.json
git commit -m "build(cli): tsup bundle + publish-ready package.json for @mdlog/agentgate"
```

---

### Task 3: Package README + config-error UX confirmation

**Files:**
- Create: `packages/cli/README.md`

**Interfaces:**
- Consumes: the built `dist/bin.js` from Task 2.
- Produces: published-package README; documented required env.

- [ ] **Step 1: Write the README**

Create `packages/cli/README.md`:

````markdown
# @mdlog/agentgate

Wrap any HTTP API into a **paid x402 service on Casper** — HTTP 402 micropayments in native CSPR, with on-chain discovery and reputation. One command turns your endpoint into a machine-payable service that AI agents can discover, pay, and rate autonomously.

```bash
npx @mdlog/agentgate wrap https://api.example.com/gold --price 0.5 --name "Gold Spot Feed"
```

## Requirements

`wrap` registers your service **on Casper Testnet**, so it needs chain config and one funded signer key. Set these in your environment (or a `.env` file in the working directory):

| Variable | What it is |
|---|---|
| `AGENTGATE_MODE` | `live` (Casper Testnet) |
| `CASPER_NODE_URL` | a Casper Testnet node RPC, e.g. `https://node.testnet.casper.network/rpc` |
| `CSPR_CLOUD_API_KEY` | a CSPR.cloud API key (https://console.cspr.cloud) |
| `REGISTRY_CONTRACT_PACKAGE_HASH` | the deployed AgentGateRegistry package hash |
| `SELLER_SIGNER_PEM_PATH` | path to a funded secp256k1/ed25519 PEM (≥ a few CSPR for gas) |

Without config the CLI fails fast with a clear message (`error: CONFIG_INVALID: …`).

## Commands

- `wrap <url> --price <CSPR> --name <name>` — register + put a 402 paywall in front of an API
- `list` — list on-chain services
- `status <id>` — service detail + reputation
- `pause <id>` / `resume <id>` — toggle a service you own

## Notes

- Node ≥ 22 required.
- Source: https://github.com/mdlog/AgentGate
````

- [ ] **Step 2: Verify the friendly config error (no stack trace)**

Run: `env -i PATH="$PATH" node packages/cli/dist/bin.js list`
Expected: a single line like `error: CONFIG_INVALID: …` and exit code 1 — NOT a multi-line stack trace. (Confirms the bundled `loadConfig()` → `bin.ts` catch path works in the built artifact with no env.)

- [ ] **Step 3: Commit**

```bash
git add packages/cli/README.md
git commit -m "docs(cli): add @mdlog/agentgate README (usage + required env)"
```

---

### Task 4: Fix the misleading `npx agentgate` command on the live site

**Files:**
- Modify: `dashboard/app/page.tsx:6`, `dashboard/app/page.tsx:13`
- Modify: `dashboard/components/catalog-grid.tsx:16`
- Modify: `README.md:7`

**Interfaces:**
- Consumes: the final command form `npx @mdlog/agentgate wrap …`.
- Produces: every user-facing copy of the wrap command now resolves to the real package.

- [ ] **Step 1: Update the dashboard hero + example**

`dashboard/app/page.tsx` line 6:

```ts
  'npx @mdlog/agentgate wrap https://api.example.com/gold --price 0.5 --name "Gold Spot Feed"';
```

`dashboard/app/page.tsx` line 13:

```ts
    code: 'npx @mdlog/agentgate wrap <url> --price 0.5',
```

- [ ] **Step 2: Update the empty-catalog command**

`dashboard/components/catalog-grid.tsx` line 16:

```ts
  'npx @mdlog/agentgate wrap https://api.example.com/gold --price 0.5 --name "Gold Spot Feed"';
```

- [ ] **Step 3: Update the repo README example**

`README.md` line 7:

```bash
npx @mdlog/agentgate wrap https://api.example.com/data --price 0.5 --name "My Data API"
```

- [ ] **Step 4: Typecheck the dashboard**

Run: `npm run typecheck -w dashboard`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add dashboard/app/page.tsx dashboard/components/catalog-grid.tsx README.md
git commit -m "docs(dashboard): use real npx @mdlog/agentgate command in hero/catalog/README"
```

---

### Task 5: Clean-room `npm pack` + npx verification (the "no-publish" deliverable)

**Files:** none (verification only).

**Interfaces:**
- Consumes: the built package from Tasks 2–3.

- [ ] **Step 1: Pack the tarball**

Run: `npm pack -w @mdlog/agentgate --pack-destination /tmp`
Expected: writes `/tmp/mdlog-agentgate-0.1.0.tgz`; `prepack` rebuilds `dist` first.

- [ ] **Step 2: Inspect tarball contents**

Run: `tar -tzf /tmp/mdlog-agentgate-0.1.0.tgz`
Expected: only `package/package.json`, `package/README.md`, `package/dist/bin.js`, `package/dist/index.js` (NO `src/`, NO `tsup.config.ts`).

- [ ] **Step 3: Install into a clean throwaway project**

```bash
rm -rf /tmp/agentgate-smoke && mkdir -p /tmp/agentgate-smoke && cd /tmp/agentgate-smoke
npm init -y >/dev/null
npm install /tmp/mdlog-agentgate-0.1.0.tgz
```

Expected: installs `@mdlog/agentgate` plus its 4 external deps (`casper-js-sdk`, `commander`, `@noble/hashes`, `@ethersproject/bignumber`); no `@agentgate/*` dep is requested from the registry.

- [ ] **Step 4: Run it like an end user would**

Run: `cd /tmp/agentgate-smoke && npx agentgate --help`
Expected: commander help with the `wrap` command — proving the published bin runs from a fresh install under plain node.

Run: `cd /tmp/agentgate-smoke && npx agentgate wrap https://api.example.com/x --price 0.5 --name "t"`
Expected: `error: CONFIG_INVALID: …` exit 1 (no config in the throwaway dir) — the graceful, expected failure, NOT a module-resolution crash or stack trace.

- [ ] **Step 5: Record the result**

No commit (pure verification). Report: tarball size, contents list, and both `--help` + config-error outputs.

---

### Task 6: Deploy the corrected command to the live dashboard

**Files:** none (build + process restart).

**Interfaces:**
- Consumes: Task 4's edits.

- [ ] **Step 1: Rebuild + restart the production dashboard**

```bash
cd /home/mdlog/Project-MDlabs/Dorahacks/casper
kill "$(pgrep -f 'next-server' | head -1)" 2>/dev/null; sleep 2
npm run build
npm run start -w dashboard   # run in background
```

Expected: build exits 0; server boots on :3000.

- [ ] **Step 2: Verify the live hero shows the real command**

Run: `curl -s --retry 20 --retry-delay 1 --retry-connrefused https://agentgate.mdloglabs.org/ | grep -o 'npx @mdlog/agentgate wrap[^"]*' | head -1`
Expected: `npx @mdlog/agentgate wrap https://api.example.com/gold --price 0.5 …`

Run: `curl -s https://agentgate.mdloglabs.org/api/services | grep -o '"id":' | wc -l`
Expected: `2` (data path still healthy after restart).

- [ ] **Step 3: Done** — no commit (Task 4 already committed the source).

---

## Self-Review

**Spec coverage:**
- Build tsup self-contained artifact → Task 2 ✓
- package.json publish fields (name, not private, bin, files, engines, deps, publishConfig, license/repo/keywords) → Task 2 ✓
- Shebang → node → Task 2 ✓
- Rename + 3 importers → Task 1 ✓
- README + required env → Task 3 ✓
- Friendly config error confirmation → Task 3 Step 2 + Task 5 Step 4 ✓
- Fix misleading command (hero + catalog + README) → Task 4 ✓ (dashboard installation docs page used `@agentgate/cli` as a package *name reference*, not the `npx agentgate` command — left as internal doc text; the live hero/catalog are the user-facing command, covered.)
- pack + clean-room install verification → Task 5 ✓
- typecheck/demo regression gate → Task 1 Step 4, Task 2 Step 7 ✓
- live re-verify → Task 6 ✓
- Out of scope (no publish, no logic change) → honored ✓

**Placeholder scan:** none — all package.json, tsup config, README, and edits are shown in full.

**Type consistency:** exported names used (`wrapService`, `createDemoAccounts`) match `packages/cli/src/index.ts`. Dependency versions (`@noble/hashes@^1.2.0`, `@ethersproject/bignumber@^5.7.0`, `casper-js-sdk@^5.0.12`, `commander@^12.0.0`) match the existing `packages/chain`/`packages/cli` declarations.
