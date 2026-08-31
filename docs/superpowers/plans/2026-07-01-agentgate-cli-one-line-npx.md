# AgentGate CLI — true one-line `npx` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npx @mdlog/agentgate list`/`status` run against live Casper Testnet with zero environment, and let `wrap`/`pause`/`resume` take all config as inline flags so they run in one self-contained line.

**Architecture:** Drop CSPR.cloud from the read path (resolve package→contract via node-RPC `queryLatestGlobalState`); add a CLI env-overlay (`resolveCliEnv`) with `flag > env > default` precedence that defaults the published CLI to live mode + the deployed registry hash; make `loadConfig`'s live-mode CSPR.cloud-key requirement opt-out so read commands need no secret; `status` degrades its attestation list when no key is present.

**Tech Stack:** TypeScript (ESM, Node ≥ 22), `commander`, `casper-js-sdk` v5 (via `packages/chain/src/sdk.ts` `createRequire` shim), `vitest`, `tsup`.

## Global Constraints

- Node ≥ 22 (`engines.node` in `packages/cli/package.json`).
- Deployed registry package hash (verbatim): `hash-10f92725551941ffe5be84cd340ce0f31f9f25d1f8ed959cc1a6c3383c3e27e9`.
- Deployed contract hash it currently resolves to (for smoke assertions): `contract-fe134f78aa10fe577b73ae53cd92993600b7d9977d29933e7c693fb4da1de24e`.
- Overlay precedence for every config key: **explicit flag > process.env (non-empty) > CLI built-in default**.
- The **shared `loadConfig` default mode stays `'mock'`** — only the CLI defaults to `live`. Do not change the shared default; middleware/oracle/other packages and their tests depend on it.
- `packages/cli/dist/**` is gitignored — never `git add` build artifacts. Run `tsup` only to verify compilation.
- Secrets passed as flags (`--api-key`, `--admin-token`) leak into shell history/`ps` — document, don't print an extra runtime warning.
- Casper node RPC default: `https://node.testnet.casper.network/rpc` (already `loadConfig`'s default for `CASPER_NODE_URL`).

---

### Task 1: Shared config — registry default constant + opt-out cloud-key requirement

**Files:**
- Modify: `packages/shared/src/config.ts` (add constant ~line 7; change `loadConfig` signature line 109; gate the guard at lines 168-171)
- Test: `packages/shared/test/config.test.ts`

**Interfaces:**
- Produces: `export const DEFAULT_REGISTRY_PACKAGE_HASH: string` and `loadConfig(env?: Env, opts?: { requireCloudKey?: boolean }): AgentGateConfig` (default `requireCloudKey: true`). Both auto-re-exported via `packages/shared/src/index.ts` (`export * from './config'`).

- [ ] **Step 1: Write the failing tests**

Add to `packages/shared/test/config.test.ts`:

```ts
import { DEFAULT_REGISTRY_PACKAGE_HASH } from '../src/index';

describe('loadConfig — requireCloudKey opt-out (CLI reads)', () => {
  it('still throws in live mode without a key by default', () => {
    expect(() => loadConfig({ AGENTGATE_MODE: 'live', AGENTGATE_ADMIN_TOKEN: 'x' })).toThrow(
      /CSPR_CLOUD_API_KEY/,
    );
  });

  it('allows live mode without a key when requireCloudKey is false', () => {
    const cfg = loadConfig(
      { AGENTGATE_MODE: 'live', AGENTGATE_ADMIN_TOKEN: 'x' },
      { requireCloudKey: false },
    );
    expect(cfg.mode).toBe('live');
    expect(cfg.csprCloudApiKey).toBe('');
  });

  it('still enforces the non-default admin token in live mode even when requireCloudKey is false', () => {
    expect(() =>
      loadConfig({ AGENTGATE_MODE: 'live' }, { requireCloudKey: false }),
    ).toThrow(/AGENTGATE_ADMIN_TOKEN/);
  });

  it('exposes the deployed registry package hash constant', () => {
    expect(DEFAULT_REGISTRY_PACKAGE_HASH).toBe(
      'hash-10f92725551941ffe5be84cd340ce0f31f9f25d1f8ed959cc1a6c3383c3e27e9',
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test --workspace @agentgate/shared -- config`
Expected: FAIL — `DEFAULT_REGISTRY_PACKAGE_HASH` undefined / `requireCloudKey` has no effect.

- [ ] **Step 3: Implement**

In `packages/shared/src/config.ts`, after the `DEFAULT_ADMIN_TOKEN` declaration (~line 7) add:

```ts
/** The deployed AgentGateRegistry package hash on Casper Testnet (SPEC deploy). */
export const DEFAULT_REGISTRY_PACKAGE_HASH =
  'hash-10f92725551941ffe5be84cd340ce0f31f9f25d1f8ed959cc1a6c3383c3e27e9';
```

Change the signature (line 109) from:

```ts
export function loadConfig(env: Env = process.env): AgentGateConfig {
```

to:

```ts
export function loadConfig(
  env: Env = process.env,
  opts: { requireCloudKey?: boolean } = {},
): AgentGateConfig {
  const requireCloudKey = opts.requireCloudKey ?? true;
```

Change the live-mode guard (lines 168-171) from:

```ts
  if (mode === 'live') {
    if (csprCloudApiKey === '') {
      throw configError('live mode requires CSPR_CLOUD_API_KEY (get one at console.cspr.cloud)');
    }
```

to:

```ts
  if (mode === 'live') {
    if (requireCloudKey && csprCloudApiKey === '') {
      throw configError('live mode requires CSPR_CLOUD_API_KEY (get one at console.cspr.cloud)');
    }
```

(The default-admin-token guard directly below stays unchanged.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test --workspace @agentgate/shared -- config`
Expected: PASS (new tests green; all existing `config.test.ts` cases still green — the shared default mode and the empty-registry behavior are untouched).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/config.ts packages/shared/test/config.test.ts
git commit -m "feat(shared): DEFAULT_REGISTRY_PACKAGE_HASH + opt-out live cloud-key requirement"
```

---

### Task 2: Chain — resolve contract hash via node RPC (drop CSPR.cloud from reads)

**Files:**
- Modify: `packages/chain/src/live.ts` (remove `CloudContractPackage`/`CloudContract` interfaces at lines 298-305; rewrite `resolveContractHash` at lines 537-564; add `pickLatestVersion` export near the other helpers, e.g. after `stripHashPrefix` ~line 146)
- Test: `packages/chain/test/contract-resolve.test.ts` (new)

**Interfaces:**
- Consumes: existing `withRpcTimeout(label, ms, fn)`, `stripHashPrefix`, `AgentGateError`, `this.rpc.queryLatestGlobalState(key, path)` (SDK: returns `QueryGlobalStateResult` whose `.storedValue.contractPackage?` is a `ContractPackage` with `versions: ContractVersion[]` and `disabledVersions: number[][]`; each `ContractVersion` has `contractVersion: number` and `contractHash: ContractHash` where `contractHash.hash.toHex()` is the raw 64-hex).
- Produces: `export function pickLatestVersion<T extends { contractVersion: number }>(versions: T[], disabledVersions: number[][]): T | null`.

- [ ] **Step 1: Write the failing test**

Create `packages/chain/test/contract-resolve.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { pickLatestVersion } from '../src/live';

const V = (contractVersion: number, contractHash: string) => ({ contractVersion, contractHash });

describe('pickLatestVersion', () => {
  it('picks the highest contractVersion when none are disabled', () => {
    const picked = pickLatestVersion([V(1, 'a'), V(3, 'c'), V(2, 'b')], []);
    expect(picked?.contractHash).toBe('c');
  });

  it('skips disabled versions (matched on the first element of each pair)', () => {
    const picked = pickLatestVersion([V(1, 'a'), V(2, 'b'), V(3, 'c')], [[3, 2]]);
    expect(picked?.contractHash).toBe('b');
  });

  it('returns null when there are no enabled versions', () => {
    expect(pickLatestVersion([], [])).toBeNull();
    expect(pickLatestVersion([V(1, 'a')], [[1, 2]])).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace @agentgate/chain -- contract-resolve`
Expected: FAIL — `pickLatestVersion` is not exported.

- [ ] **Step 3: Implement the pure helper**

In `packages/chain/src/live.ts`, after `stripHashPrefix` (~line 146) add:

```ts
/**
 * Picks the highest-numbered ENABLED contract version. `disabledVersions` is the
 * SDK's `number[][]` where each entry's first element is the disabled
 * `contractVersion`. Returns null when nothing is enabled.
 */
export function pickLatestVersion<T extends { contractVersion: number }>(
  versions: T[],
  disabledVersions: number[][],
): T | null {
  const disabled = new Set(disabledVersions.map((d) => d[0]));
  const enabled = versions.filter((v) => !disabled.has(v.contractVersion));
  if (enabled.length === 0) return null;
  return enabled.reduce((best, v) => (v.contractVersion > best.contractVersion ? v : best));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace @agentgate/chain -- contract-resolve`
Expected: PASS.

- [ ] **Step 5: Rewrite `resolveContractHash` to use node RPC**

In `packages/chain/src/live.ts`, replace the whole `resolveContractHash` method (lines 537-564) with:

```ts
  /**
   * Resolves the active contract hash behind the registry package via node RPC
   * (`query_global_state` on the package key) — no CSPR.cloud key required.
   */
  private async resolveContractHash(): Promise<string> {
    const packageHash = this.requireContract();
    if (this.contractHashCache) return this.contractHashCache;

    const res = await withRpcTimeout(
      'node RPC queryLatestGlobalState (package)',
      this.cfg.upstreamTimeoutMs,
      () => this.rpc.queryLatestGlobalState(`hash-${packageHash}`, []),
    );
    const pkg = res.storedValue?.contractPackage;
    if (!pkg) {
      throw new AgentGateError(
        'CONTRACT_RESOLVE_FAILED',
        `package hash-${packageHash} has no contractPackage stored value (node RPC)`,
        502,
      );
    }
    const latest = pickLatestVersion(pkg.versions, pkg.disabledVersions);
    if (!latest) {
      throw new AgentGateError(
        'CONTRACT_RESOLVE_FAILED',
        `package hash-${packageHash} has no enabled contract versions`,
        502,
      );
    }
    this.contractHashCache = latest.contractHash.hash.toHex();
    return this.contractHashCache;
  }
```

Then delete the now-unused CSPR.cloud interfaces `CloudContractPackage` (line 298) and `CloudContract` (line 302). (Keep `cloudGet`, `CloudItemEnvelope`, `CloudListEnvelope`, and all other `Cloud*` types — `listAttestations` and the transfer/account/deploy reads still use them.)

- [ ] **Step 6: Typecheck + full chain suite**

Run: `npm run typecheck --workspace @agentgate/chain && npm test --workspace @agentgate/chain`
Expected: PASS, no unused-symbol errors.

- [ ] **Step 7: Commit**

```bash
git add packages/chain/src/live.ts packages/chain/test/contract-resolve.test.ts
git commit -m "feat(chain): resolve registry contract hash via node RPC (keyless reads)"
```

---

### Task 3: CLI — `resolveCliEnv` overlay helper

**Files:**
- Create: `packages/cli/src/cli-env.ts`
- Test: `packages/cli/test/cli-env.test.ts` (new)

**Interfaces:**
- Consumes: `DEFAULT_REGISTRY_PACKAGE_HASH` from `@agentgate/shared` (Task 1).
- Produces: `export interface CliConfigFlags { mode?: string; nodeUrl?: string; registry?: string; pem?: string; apiKey?: string; adminToken?: string }` and `export function resolveCliEnv(flags: CliConfigFlags, env?: Record<string, string | undefined>): Record<string, string | undefined>`.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/cli-env.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { DEFAULT_REGISTRY_PACKAGE_HASH } from '@agentgate/shared';
import { resolveCliEnv } from '../src/cli-env';

describe('resolveCliEnv', () => {
  it('defaults an empty env to live mode + the deployed registry hash', () => {
    const out = resolveCliEnv({}, {});
    expect(out.AGENTGATE_MODE).toBe('live');
    expect(out.REGISTRY_CONTRACT_PACKAGE_HASH).toBe(DEFAULT_REGISTRY_PACKAGE_HASH);
  });

  it('lets process.env override the built-in defaults', () => {
    const out = resolveCliEnv({}, { AGENTGATE_MODE: 'mock', REGISTRY_CONTRACT_PACKAGE_HASH: 'hash-env' });
    expect(out.AGENTGATE_MODE).toBe('mock');
    expect(out.REGISTRY_CONTRACT_PACKAGE_HASH).toBe('hash-env');
  });

  it('lets a flag override both env and default (flag > env > default)', () => {
    const out = resolveCliEnv(
      { mode: 'mock', registry: 'hash-flag', pem: '/k.pem', apiKey: 'K', adminToken: 'T', nodeUrl: 'http://n' },
      { AGENTGATE_MODE: 'live', REGISTRY_CONTRACT_PACKAGE_HASH: 'hash-env' },
    );
    expect(out.AGENTGATE_MODE).toBe('mock');
    expect(out.REGISTRY_CONTRACT_PACKAGE_HASH).toBe('hash-flag');
    expect(out.SELLER_SIGNER_PEM_PATH).toBe('/k.pem');
    expect(out.CSPR_CLOUD_API_KEY).toBe('K');
    expect(out.AGENTGATE_ADMIN_TOKEN).toBe('T');
    expect(out.CASPER_NODE_URL).toBe('http://n');
  });

  it('treats empty-string flags/env as unset', () => {
    const out = resolveCliEnv({ mode: '  ' }, { AGENTGATE_MODE: '' });
    expect(out.AGENTGATE_MODE).toBe('live');
  });

  it('does not inject CASPER_NODE_URL/SELLER_SIGNER_PEM_PATH when neither flag nor env is set (loadConfig applies its own default)', () => {
    const out = resolveCliEnv({}, {});
    expect(out.CASPER_NODE_URL).toBeUndefined();
    expect(out.SELLER_SIGNER_PEM_PATH).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace @mdlog/agentgate -- cli-env`
Expected: FAIL — module `../src/cli-env` not found.

- [ ] **Step 3: Implement**

Create `packages/cli/src/cli-env.ts`:

```ts
import { DEFAULT_REGISTRY_PACKAGE_HASH } from '@agentgate/shared';

/** Config-bearing CLI flags shared across commands (all optional). */
export interface CliConfigFlags {
  mode?: string;
  nodeUrl?: string;
  registry?: string;
  pem?: string;
  apiKey?: string;
  adminToken?: string;
}

type Env = Record<string, string | undefined>;

/** First non-empty (trimmed) of flag, then env; else the fallback (may be undefined). */
function pick(flag: string | undefined, envVal: string | undefined, fallback?: string): string | undefined {
  if (flag !== undefined && flag.trim() !== '') return flag;
  if (envVal !== undefined && envVal.trim() !== '') return envVal;
  return fallback;
}

/**
 * Builds the env overlay the CLI hands to `loadConfig`. Precedence per key:
 * explicit flag > process.env (non-empty) > CLI built-in default. The published
 * CLI targets live Testnet + the deployed registry by default; keys with no CLI
 * default are left to `loadConfig`'s own defaults (node URL, cloud URL, …).
 */
export function resolveCliEnv(flags: CliConfigFlags, env: Env = process.env): Env {
  const overlay: Env = { ...env };
  const set = (key: string, value: string | undefined): void => {
    if (value !== undefined) overlay[key] = value;
  };
  set('AGENTGATE_MODE', pick(flags.mode, env.AGENTGATE_MODE, 'live'));
  set('REGISTRY_CONTRACT_PACKAGE_HASH', pick(flags.registry, env.REGISTRY_CONTRACT_PACKAGE_HASH, DEFAULT_REGISTRY_PACKAGE_HASH));
  set('CASPER_NODE_URL', pick(flags.nodeUrl, env.CASPER_NODE_URL));
  set('SELLER_SIGNER_PEM_PATH', pick(flags.pem, env.SELLER_SIGNER_PEM_PATH));
  set('CSPR_CLOUD_API_KEY', pick(flags.apiKey, env.CSPR_CLOUD_API_KEY));
  set('AGENTGATE_ADMIN_TOKEN', pick(flags.adminToken, env.AGENTGATE_ADMIN_TOKEN));
  return overlay;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace @mdlog/agentgate -- cli-env`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/cli-env.ts packages/cli/test/cli-env.test.ts
git commit -m "feat(cli): resolveCliEnv overlay (flag > env > live/registry default)"
```

---

### Task 4: CLI — `status` attestation degrade

**Files:**
- Modify: `packages/cli/src/status.ts` (add `includeAttestations` to `serviceStatus` opts)
- Test: `packages/cli/test/cli.test.ts` (extend the `serviceStatus` describe block)

**Interfaces:**
- Produces: `serviceStatus(opts: { chain: ChainClient; id: number; includeAttestations?: boolean })` — default `true` (backward compatible). When `false`, skips `chain.listAttestations` and returns `attestations: []`.

- [ ] **Step 1: Write the failing test**

Add inside the existing `describe('serviceStatus', …)` in `packages/cli/test/cli.test.ts` (reuses the file's existing `makeFakeChain`/`makeService` helpers):

```ts
  it('skips the attestation fetch when includeAttestations is false', async () => {
    const chain = makeFakeChain();
    chain.getService = async (id) => (id === 1 ? makeService(1) : null);
    chain.getScore = async () => ({ totalCalls: 10, successCalls: 10 });
    let listed = false;
    chain.listAttestations = async () => {
      listed = true;
      return [];
    };

    const res = await serviceStatus({ chain, id: 1, includeAttestations: false });
    expect(res.attestations).toEqual([]);
    expect(listed).toBe(false);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace @mdlog/agentgate -- cli.test`
Expected: FAIL — `listAttestations` still called; `attestations` not empty.

- [ ] **Step 3: Implement**

In `packages/cli/src/status.ts`, change the `serviceStatus` opts and body:

```ts
export async function serviceStatus(opts: {
  chain: ChainClient;
  id: number;
  /** When false, skip the CSPR.cloud attestation fetch and return []. Default true. */
  includeAttestations?: boolean;
}): Promise<ServiceStatusResult> {
  const { chain, id } = opts;
  const includeAttestations = opts.includeAttestations ?? true;
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new AgentGateError(
      'INVALID_SERVICE_ID',
      `service id must be a positive integer, got ${String(id)}`,
      400,
    );
  }
  const service = await chain.getService(id);
  if (service === null) {
    throw new AgentGateError('SERVICE_NOT_FOUND', `service ${id} not found on-chain`, 404);
  }
  const [score, attestations] = await Promise.all([
    chain.getScore(id),
    includeAttestations
      ? chain.listAttestations(id, STATUS_ATTESTATION_LIMIT)
      : Promise.resolve([] as AttestationRecord[]),
  ]);
  return { service, score, tier: trustTier(score), attestations };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test --workspace @mdlog/agentgate -- cli.test`
Expected: PASS (new case green; existing `serviceStatus` cases still green — default is `true`).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/status.ts packages/cli/test/cli.test.ts
git commit -m "feat(cli): serviceStatus can skip attestations (keyless status degrade)"
```

---

### Task 5: CLI — wire flags into `bin.ts` + live-by-default + status printing

**Files:**
- Modify: `packages/cli/src/bin.ts`

**Interfaces:**
- Consumes: `resolveCliEnv`, `CliConfigFlags` (Task 3); `loadConfig(env, { requireCloudKey })` (Task 1); `serviceStatus({ …, includeAttestations })` (Task 4).

This task is verified by typecheck + a live smoke run (network) rather than a unit test — commander argv parsing is not worth mocking here.

- [ ] **Step 1: Add imports + helpers**

In `packages/cli/src/bin.ts`, add to the imports:

```ts
import { resolveCliEnv, type CliConfigFlags } from './cli-env';
```

Extend `WrapCmdOpts` so wrap's action opts carry the config flags:

```ts
interface WrapCmdOpts extends CliConfigFlags {
  price: string;
  name: string;
  description?: string;
  gateway?: string;
  paymentTarget?: string;
  attestor?: string;
}
```

Add these helpers just above `const program = new Command();`:

```ts
/** Attach the shared chain-config flags (mode/node/registry) to a command. */
function withConfigFlags(cmd: Command): Command {
  return cmd
    .option('--mode <mode>', 'chain mode: mock | live (published CLI defaults to live)')
    .option('--node-url <url>', 'Casper node RPC URL (default: Casper Testnet)')
    .option('--registry <hash>', 'AgentGateRegistry package hash (default: the deployed one)');
}

/** Build runtime config from flags + env. The CLI never hard-requires the CSPR.cloud key. */
function cliConfig(opts: CliConfigFlags): AgentGateConfig {
  return loadConfig(
    resolveCliEnv({
      mode: opts.mode,
      nodeUrl: opts.nodeUrl,
      registry: opts.registry,
      pem: opts.pem,
      apiKey: opts.apiKey,
      adminToken: opts.adminToken,
    }),
    { requireCloudKey: false },
  );
}
```

- [ ] **Step 2: Attach flags to every command + replace each `loadConfig()` call**

For `wrap`: after its existing `.option(...)` chain add `--pem` and `--admin-token`, and wrap the whole builder in `withConfigFlags(...)`. Concretely, change the command builder so it reads:

```ts
withConfigFlags(
  program
    .command('wrap')
    .description('Wrap an upstream API behind the AgentGate 402 paywall and register it on-chain')
    .argument('<upstreamUrl>', 'upstream API URL to wrap (kept private, only sent to the gateway)')
    .requiredOption('--price <cspr>', 'price per call in CSPR (e.g. 0.5)')
    .requiredOption('--name <name>', 'service name')
    .option('--description <d>', 'service description', '')
    .option('--gateway <url>', 'gateway base URL (default: http://localhost:<MIDDLEWARE_PORT|4021>)')
    .option('--payment-target <accountHash>', 'payment target account-hash (default: derived from the seller signer)')
    .option('--attestor <publicKeyHex>', 'public key allowed to record attestations (default: the seller signer public key)')
    .option('--pem <path>', 'seller signer PEM path (required for live writes)')
    .option('--admin-token <token>', 'gateway admin bearer token (⚠ leaks into shell history/ps)'),
).action(async (upstreamUrl: string, opts: WrapCmdOpts) => {
  const config = cliConfig(opts);
  // …rest of the existing wrap action unchanged…
});
```

Inside the wrap action, replace `const config = loadConfig();` with `const config = cliConfig(opts);` (the rest — `createChainClient`, `sellerSigner`, gateway default, `wrapService(...)` — is unchanged).

For `list`: wrap in `withConfigFlags(...)` and give the action an `opts` parameter:

```ts
withConfigFlags(
  program.command('list').description('List the on-chain service catalog with scores and trust tiers'),
).action(async (opts: CliConfigFlags) => {
  const config = cliConfig(opts);
  // …rest unchanged…
});
```

For `status`: wrap in `withConfigFlags(...)`, add `--api-key`, thread opts + degrade:

```ts
withConfigFlags(
  program
    .command('status')
    .description('Show one service: record, score, trust tier and recent attestations')
    .argument('<id>', 'service id')
    .option('--api-key <key>', 'CSPR.cloud key to fetch attestation history (⚠ leaks into shell history/ps)'),
).action(async (idRaw: string, opts: CliConfigFlags) => {
  if (!/^\d+$/.test(idRaw.trim()) || Number(idRaw.trim()) < 1) {
    throw new AgentGateError('INVALID_SERVICE_ID', `service id must be a positive integer, got ${JSON.stringify(idRaw)}`, 400);
  }
  const config = cliConfig(opts);
  const chain = createChainClient(config);
  const hasKey = config.csprCloudApiKey !== '';
  const { service, score, tier, attestations } = await serviceStatus({
    chain,
    id: Number(idRaw.trim()),
    includeAttestations: hasKey,
  });
  // …existing prints for service/description/endpoint/price/target/owner/attestor/trust unchanged…
  if (!hasKey) {
    console.log('attestations:   (set CSPR_CLOUD_API_KEY or pass --api-key to view history)');
    return;
  }
  if (attestations.length === 0) {
    console.log('attestations:   none yet');
    return;
  }
  console.log(`attestations (latest ${STATUS_ATTESTATION_LIMIT}):`);
  for (const a of attestations) {
    const when = new Date(a.timestamp).toISOString();
    console.log(`  [${a.success ? 'ok  ' : 'FAIL'}] ${when}  payment ${a.paymentDeployHash}  tx ${a.recordTxHash}`);
  }
});
```

For `pause`/`resume`: wrap each in `withConfigFlags(...)`, add `--pem`, and thread opts into `toggleActive`:

```ts
async function toggleActive(idRaw: string, active: boolean, opts: CliConfigFlags): Promise<void> {
  if (!/^\d+$/.test(idRaw.trim())) {
    throw new AgentGateError('INVALID_SERVICE_ID', `service id must be a positive integer, got ${JSON.stringify(idRaw)}`, 400);
  }
  const config = cliConfig(opts);
  // …rest unchanged…
}

withConfigFlags(
  program
    .command('pause')
    .description('Pause a service you own: set_active(false) on-chain, the paywall answers 403')
    .argument('<id>', 'service id')
    .option('--pem <path>', 'seller signer PEM path (required for live writes)'),
).action(async (idRaw: string, opts: CliConfigFlags) => toggleActive(idRaw, false, opts));

withConfigFlags(
  program
    .command('resume')
    .description('Resume a paused service you own: set_active(true) on-chain, calls flow again')
    .argument('<id>', 'service id')
    .option('--pem <path>', 'seller signer PEM path (required for live writes)'),
).action(async (idRaw: string, opts: CliConfigFlags) => toggleActive(idRaw, true, opts));
```

For `demo-accounts`: wrap in `withConfigFlags(...)` (so `--mode mock` works) and use `cliConfig(opts)`:

```ts
withConfigFlags(
  program
    .command('demo-accounts')
    .description('Create faucet-funded buyer/seller demo accounts on the mock devnet (mock mode only)'),
).action(async (opts: CliConfigFlags) => {
  const config = cliConfig(opts);
  // …rest unchanged (still throws MOCK_ONLY unless mode is mock)…
});
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck --workspace @mdlog/agentgate`
Expected: PASS — no type errors (opts structurally satisfy `CliConfigFlags`).

- [ ] **Step 4: Build the bundle**

Run: `npm run build --workspace @mdlog/agentgate`
Expected: `dist/bin.js` rebuilt with no errors.

- [ ] **Step 5: Live smoke test (network) — the whole point of the change**

Run (zero env — must succeed against live Testnet):

```bash
env -i "PATH=$PATH" node packages/cli/dist/bin.js list
```

Expected: a table with the 2 on-chain services (incl. `RWA FX & Gold Oracle`), no `CONFIG_INVALID`/`CSPR_CLOUD` error.

Run:

```bash
env -i "PATH=$PATH" node packages/cli/dist/bin.js status 1
```

Expected: service #1 record + trust line, ending with `attestations:   (set CSPR_CLOUD_API_KEY or pass --api-key to view history)`.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/bin.ts
git commit -m "feat(cli): inline config flags + live-by-default zero-env reads"
```

---

### Task 6: Docs — list is the zero-setup hero; delete the false `.env` claim

**Files:**
- Modify: `dashboard/app/page.tsx` (hero `WRAP_CMD` const line 5-6, `STEPS[0].code` line 13)
- Modify: `dashboard/components/catalog-grid.tsx` (`WRAP_CMD` const line 15-16)
- Modify: `packages/cli/README.md`
- Modify: `README.md` (root — line 7 and the env note lines 98-99)
- Modify: `dashboard/app/docs/cli/page.tsx` (the "Environment it reads" intro line ~56-60: "driven by environment variables, not flags")

- [ ] **Step 1: Hero — make `list` the headline** (`dashboard/app/page.tsx`)

Replace the `WRAP_CMD` const (lines 5-6) with two commands and use the list one as the hero:

```tsx
const LIST_CMD = 'npx @mdlog/agentgate list';
const WRAP_CMD =
  'npx @mdlog/agentgate wrap https://api.example.com/gold --price 0.5 --name "Gold Spot Feed" --pem ./seller.pem --gateway https://your-gateway';
```

Find where `WRAP_CMD` is rendered in the hero `<CommandBlock .../>` and switch the hero block to `LIST_CMD` with a caption like "Read the live on-chain catalog — zero setup, no keys." Keep `WRAP_CMD` shown in the "Wrap" step/section. Update `STEPS[0].code` (line 13) to:

```ts
    code: 'npx @mdlog/agentgate wrap <url> --price 0.5 --pem ./seller.pem',
```

- [ ] **Step 2: Catalog CTA** (`dashboard/components/catalog-grid.tsx`)

The empty-state CTA currently shows `WRAP_CMD`. Add a `LIST_CMD` const and, in the empty/first-run state, lead with `npx @mdlog/agentgate list` ("no local setup") and keep the wrap command (updated with `--pem`/`--gateway`) as the "register your own" example:

```tsx
const LIST_CMD = 'npx @mdlog/agentgate list';
const WRAP_CMD =
  'npx @mdlog/agentgate wrap https://api.example.com/gold --price 0.5 --name "Gold Spot Feed" --pem ./seller.pem --gateway https://your-gateway';
```

- [ ] **Step 3: CLI README** (`packages/cli/README.md`)

Rewrite so it: (a) leads with the zero-setup read one-liner; (b) documents the inline flags; (c) **removes** the false ".env file in the working directory" phrase. Replace the top example + Requirements section with:

```markdown
```bash
# read the live on-chain catalog — zero setup, no keys
npx @mdlog/agentgate list
npx @mdlog/agentgate status 1
```

## Wrapping your API (writes)

`wrap` registers your service **on Casper Testnet** and puts a 402 paywall in
front of it, so it needs a funded seller key and a running gateway. Everything
can go on one line via flags (or the matching env vars):

```bash
npx @mdlog/agentgate wrap https://api.example.com/gold --price 0.5 --name "Gold Spot Feed" \
  --pem ./seller.pem --gateway https://your-gateway --admin-token "$AGENTGATE_ADMIN_TOKEN"
```

| Flag | Env var | Needed for |
|---|---|---|
| `--mode <mock\|live>` | `AGENTGATE_MODE` | all (CLI defaults to `live`) |
| `--node-url <url>` | `CASPER_NODE_URL` | all (defaults to Testnet) |
| `--registry <hash>` | `REGISTRY_CONTRACT_PACKAGE_HASH` | all (defaults to the deployed registry) |
| `--pem <path>` | `SELLER_SIGNER_PEM_PATH` | wrap / pause / resume (live) |
| `--admin-token <token>` | `AGENTGATE_ADMIN_TOKEN` | wrap (live) |
| `--api-key <key>` | `CSPR_CLOUD_API_KEY` | `status` attestation history only |

> ⚠️ Secret flags (`--api-key`, `--admin-token`) are visible in your shell
> history and `ps`. Prefer the env vars for secrets; the flags exist for a
> one-line invocation.
```
```

(Keep the existing Commands list + Notes; delete the old "Requirements" env table and its ".env file" sentence.)

- [ ] **Step 4: Root README** (`README.md`)

Change line 7 to the zero-setup read command:

```bash
npx @mdlog/agentgate list
```

and, in the wrap example nearby, show the flag form with `--pem`/`--gateway`. Leave lines 98-99 (env note) accurate — they already correctly say live mode requires a non-default admin token; add that CSPR.cloud key is only needed for attestation history, not for reads/writes.

- [ ] **Step 5: docs/cli page** (`dashboard/app/docs/cli/page.tsx`)

In the "Environment it reads" `<P>` (~line 56-60), change the sentence "the CLI is driven by environment variables, not flags, for mode and identity" to note that **every env var also has a matching flag** (`--mode`, `--node-url`, `--registry`, `--pem`, `--admin-token`, `--api-key`) with precedence flag > env > default, and that read commands (`list`/`status`) default to live Testnet with no config. Keep the `PropList` table; add rows for the new flags or a short flag list under it.

- [ ] **Step 6: Verify the dashboard builds**

Run: `npm run build --workspace dashboard` (or the repo's dashboard build script)
Expected: build succeeds (no TS/JSX errors from the edited files).

- [ ] **Step 7: Commit**

```bash
git add dashboard/app/page.tsx dashboard/components/catalog-grid.tsx packages/cli/README.md README.md dashboard/app/docs/cli/page.tsx
git commit -m "docs: list is the zero-setup hero; document inline flags; drop false .env claim"
```

---

### Task 7: Final verification sweep

**Files:** none (verification only)

- [ ] **Step 1: Full workspace test + typecheck**

Run: `npm test && npm run typecheck` (from repo root; runs all workspaces)
Expected: all suites PASS, no type errors.

- [ ] **Step 2: Re-run the two live smoke commands** (from Task 5, Step 5) to confirm the built bundle still works zero-env.

- [ ] **Step 3: Confirm no build artifacts were staged**

Run: `git status --porcelain packages/cli/dist`
Expected: empty (dist is gitignored).

- [ ] **Step 4: Final commit if anything remains**

```bash
git add -A
git commit -m "chore(cli): final verification for one-line npx" || echo "nothing to commit"
```
