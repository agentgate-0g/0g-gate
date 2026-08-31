# AgentGate CLI — true one-line `npx` (zero-env reads + inline-flag writes)

**Date:** 2026-07-01
**Status:** Design approved, pending spec review
**Package(s):** `@mdlog/agentgate` (`packages/cli`), `@agentgate/chain` (`packages/chain`), `@agentgate/shared` (`packages/shared`), plus dashboard docs.

## Problem

The dashboard hero, catalog, and README advertise a copy-paste one-liner:

```bash
npx @mdlog/agentgate wrap https://api.example.com/gold --price 0.5 --name "Gold Spot Feed"
```

That line **cannot run standalone today**, for three independent reasons:

1. **No `.env` loading exists.** `loadConfig()` (`packages/shared/src/config.ts`) reads only
   `process.env` — there is no `dotenv`, no `process.loadEnvFile`. The README's claim *"Set these
   in your environment (or a `.env` file in the working directory)"* is false; a `.env` file is
   silently ignored. The CLI docs page even states *"the CLI is driven by environment variables,
   not flags, for mode and identity."*
2. **`wrap` dies immediately with no env.** Default mode is `mock` → `sellerSigner()` needs
   `MOCK_SELLER_ACCOUNT` → empty → throws `SIGNER_MISSING` on line one. In `live` mode it needs
   `CSPR_CLOUD_API_KEY`, `SELLER_SIGNER_PEM_PATH`, a non-default `AGENTGATE_ADMIN_TOKEN`, **and a
   running gateway** — none except `--gateway` is a flag.
3. **Even reads aren't zero-env.** `list`/`status` in live mode call `resolveContractHash()`
   (`live.ts:538`) which hits **CSPR.cloud** (secret API key) to map package-hash → contract-hash
   before touching the public node RPC.

## Goal (user-selected)

Two experiences, both runnable from a single command line with no separate `export`/`.env` step:

- **B — zero-env read one-liner:** `npx @mdlog/agentgate list` and `status <id>` work against live
  Casper Testnet with **no environment at all**.
- **A — inline-flag writes:** `wrap`/`pause`/`resume` accept all config as flags so the whole
  invocation is one self-contained line (secrets included, with a documented leakage caveat).

Not in scope (explicitly declined by the user): `.env` auto-loading.

## Verified feasibility (empirical, against live Testnet)

Run against `https://node.testnet.casper.network/rpc` with **zero CSPR.cloud key**:

- `rpc.queryLatestGlobalState('hash-10f92725…e27e9', [])` →
  `storedValue.contractPackage.versions[0].contractHash = contract-fe134f78…de24e`,
  `disabledVersions: []`, `lockStatus: Locked`.
- Using that contract hash, keyless `getDictionaryItemByIdentifier` on the Odra `state` dictionary
  returned `services_count = 2` and decoded service #1 (`"RWA FX & Gold Oracle"`, `USD/IDR …`).

Conclusion: the only CSPR.cloud call in the **core read path** is `resolveContractHash()`; replacing
it with `queryLatestGlobalState` makes `list` fully zero-env. Writes (`registerService`, `setActive`)
already use node-RPC `putTransaction` only. **Only `status`'s attestation history still needs
CSPR.cloud.**

## Design

### Decisions locked with the user

- **Headline demo:** `npx @mdlog/agentgate list` becomes the hero "try it with zero setup" command;
  `wrap` moves to a "wrap your API" section with its inline-flag form + gateway prerequisite.
- **Secret flags:** `--api-key` / `--admin-token` are provided for a true one-liner, with a
  documented warning that flag values leak into shell history and `ps`.

### Part B — zero-env reads

**B1. Node-RPC contract resolution** (`packages/chain/src/live.ts`).
Rewrite `resolveContractHash()` to resolve via node RPC instead of CSPR.cloud:

- `const res = await withRpcTimeout(… () => this.rpc.queryLatestGlobalState('hash-'+packageHash, []))`.
- From `res.storedValue.contractPackage`, select the version with the **highest `contractVersion`
  that is not in `disabledVersions`**, take its `contractHash`, `stripHashPrefix`, cache it.
- Defensive shape handling: support the legacy `contractPackage` stored value (what is deployed).
  If a future Casper 2.0 `Package`/entity stored value appears (`package`/entity-hash), fail with a
  clear `CONTRACT_RESOLVE_FAILED` message rather than mis-decode (out of scope to fully support now,
  but must not silently break).
- On empty/absent versions or RPC failure → `CONTRACT_RESOLVE_FAILED` (502) with the package hash in
  the message. Preserve the existing `notDeployed()` behavior when the hash is unset.

No other read code changes — `readStateBytes`, `getService`, `listServices`, `getScore` already use
node RPC. `listAttestations` keeps using CSPR.cloud (see B3).

**B2. CLI built-in defaults** (`packages/cli/src/bin.ts` + new `@agentgate/shared` constant).

- Add `export const DEFAULT_REGISTRY_PACKAGE_HASH = 'hash-10f92725551941ffe5be84cd340ce0f31f9f25d1f8ed959cc1a6c3383c3e27e9';`
  to `@agentgate/shared` (single source of truth; docs reference the same value).
- New pure helper `resolveCliEnv(flags, processEnv)` in the CLI that returns an env overlay object:
  - `AGENTGATE_MODE`: `flags.mode ?? processEnv.AGENTGATE_MODE ?? 'live'` (CLI defaults to live; the
    **shared `loadConfig` default stays `mock`** so middleware/oracle/other packages/tests are
    unaffected).
  - `REGISTRY_CONTRACT_PACKAGE_HASH`: `flags.registry ?? processEnv.… ?? DEFAULT_REGISTRY_PACKAGE_HASH`.
  - `CASPER_NODE_URL`, `CSPR_CLOUD_API_URL`: pass through flags/env; `loadConfig` already defaults
    these to testnet.
  - Other flag→env mappings from Part A.
  - Precedence everywhere: **flag > process.env > CLI built-in default.**
- Every command builds the overlay and calls `loadConfig(overlay, …)` instead of `loadConfig()`.

**B3. Relax the live-mode key hard-requirement** (`packages/shared/src/config.ts`).

- Change signature to `loadConfig(env = process.env, opts: { requireCloudKey?: boolean } = {})`
  with `requireCloudKey` defaulting to **`true`** (preserves middleware/oracle safety).
- The live-mode `csprCloudApiKey === '' → throw` guard fires only when `requireCloudKey` is true.
  The default-admin-token guard is unchanged.
- CLI **read** commands (`list`, `status`) call `loadConfig(overlay, { requireCloudKey: false })`.
  `wrap`/`pause`/`resume` also pass `{ requireCloudKey: false }` (their chain writes are node-RPC;
  they never call CSPR.cloud) so a live write one-liner needs no key.
- `status` degrades gracefully: when `csprCloudApiKey === ''`, skip the attestation fetch and print
  `attestations:   (set CSPR_CLOUD_API_KEY to view history)` instead of throwing. Record + score +
  trust tier still render (all node-RPC).

*Alternatives considered:* remove the guard globally (rejected — weakens middleware); give the CLI a
separate config loader (rejected — duplication). The opt-out param is the least-blast-radius choice.

### Part A — inline-flag writes

Add options (mapped into the overlay by `resolveCliEnv`, applied to the commands that need them):

| Flag | Overlay key | Notes |
|---|---|---|
| `--mode <mock\|live>` | `AGENTGATE_MODE` | all commands |
| `--node-url <url>` | `CASPER_NODE_URL` | all commands |
| `--registry <hash>` | `REGISTRY_CONTRACT_PACKAGE_HASH` | all commands |
| `--pem <path>` | `SELLER_SIGNER_PEM_PATH` | seller signer PEM — **required** for wrap/pause/resume (live) |
| `--api-key <key>` | `CSPR_CLOUD_API_KEY` | CSPR.cloud key — secret; **only** `status` attestations need it (wrap/pause/resume/list do not) |
| `--admin-token <token>` | `AGENTGATE_ADMIN_TOKEN` | secret — wrap |
| `--gateway <url>` | (existing wrap option) | wrap |

Resulting self-contained `wrap` line:

```bash
npx @mdlog/agentgate wrap https://api.example.com/gold --price 0.5 --name "Gold Spot Feed" \
  --mode live --pem ./seller.pem --admin-token "$TOK" --gateway https://gate.example.com
```

`wrap` still requires a **running gateway + funded key** — inherent, not removable by flags. The
leakage caveat for the secret flags (`--api-key`, `--admin-token`) lives in the docs and each flag's
`--help` description; no extra stderr noise is printed at runtime.

### Docs (`dashboard/app/...`, `packages/cli/README.md`, root `README.md`)

- Hero (`dashboard/app/page.tsx`) + catalog (`components/catalog-grid.tsx`): headline command becomes
  `npx @mdlog/agentgate list` ("read the live on-chain catalog — zero setup"). `wrap` shown below with
  the inline-flag form and its gateway/key prerequisites.
- `packages/cli/README.md`: **delete** the "or a `.env` file in the working directory" claim. Document
  the zero-env read commands, the inline flags, and the secret-flag leakage caveat. Keep the fail-fast
  `CONFIG_INVALID` messaging note.
- `dashboard/app/docs/cli/page.tsx`: fix "driven by environment variables, not flags" → flags now
  override env; document new flags and the live-by-default CLI behavior.

## Testing

- `resolveCliEnv` unit tests: flag > env > default precedence for each key; live default when unset;
  registry default when unset.
- `loadConfig` test: `{ requireCloudKey: false }` allows empty key in live mode; default still throws.
  Existing mock-default tests remain green.
- Chain unit test for the rewritten `resolveContractHash`: mock `queryLatestGlobalState` returning a
  `contractPackage` with multiple versions incl. a disabled one; assert it picks the highest enabled
  `contractHash`; assert `CONTRACT_RESOLVE_FAILED` on empty versions.
- `status` degrade test: empty key → prints the attestation placeholder, no throw, record/score render.
- Existing `packages/cli/test/cli.test.ts` (library-level, mock `ChainClient`) must stay green
  unchanged.
- Optional live smoke test (real node) — `describe.skip` by default (network + external state).

## Rollout / risk notes

- Changing the CLI default mode to `live` affects only the "nothing set" case; the repo pins
  `AGENTGATE_MODE` explicitly (`.env` = live, `.env.example` = mock), and `loadConfig`'s shared
  default is untouched, so no other package changes behavior. `demo-accounts` with no explicit
  `--mode mock`/env will now error `MOCK_ONLY` (acceptable — it is a mock-only dev tool; document it).
- `DEFAULT_REGISTRY_PACKAGE_HASH` couples the published CLI to the current deployment; on redeploy,
  bump this constant (and it is overridable via `--registry`/env).
