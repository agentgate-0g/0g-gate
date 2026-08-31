# Registry v2 — Phase 2: Deploy (UNLOCKED) + cutover — Implementation Plan / Runbook

> **For agentic workers:** operational/live phase. Steps are a runbook — most require Bash (`cargo`/`node`/`casper`/`git`) or `!`-driven execution. Each step states its success signal + rollback.

**Goal:** Deploy the Phase-1 v2 wasm as an UNLOCKED (upgradable) Casper Testnet package, re-register the core services with on-chain `accepts[]`, repoint the live gateway to it — with a proven rollback to the old locked registry.

**Architecture:** The Odra `odra-cli` deploy path produces a LOCKED package (that is why the current registry `10f92725…` can't be upgraded). Deploy v2 instead via **casper-js-sdk `SessionBuilder`** installing `AgentGateRegistry.wasm` with the Odra control args `odra_cfg_is_upgradable=true` (proven route: the Cep18X402 token was installed unlocked this way). Constructor is `NoArgs`, so no constructor runtime args.

**Tech Stack:** casper-js-sdk 5.0.12 (repo pin), Node 22, gate key (secp256k1) at `$GATE_SIGNER_PEM_PATH`, CSPR.cloud/testnet RPC from `.env`.

## Global Constraints

- No Claude `Co-Authored-By` trailer on commits.
- Gate key (`0203df32…` / acct `19ffec2c…`) is the package owner + deployer; needs ~300 CSPR free for install gas (it holds ~3249 CSPR — fine).
- Rollback target (old LOCKED registry, still live+frozen): `hash-10f92725551941ffe5be84cd340ce0f31f9f25d1f8ed959cc1a6c3383c3e27e9`.
- The gateway is `npm run dev:live` (pm2 `agentgate-gateway`) reading root `.env` `REGISTRY_CONTRACT_PACKAGE_HASH`; dashboard reads its own config; CLI ships a built-in default hash (Phase 4 republish).
- Odra control args for an unlocked install: `odra_cfg_is_upgradable=true`, `odra_cfg_is_upgrade=false`, `odra_cfg_allow_key_override=true`, `odra_cfg_package_hash_key_name="agentgate_registry_package_hash"`.

---

### Task 0 (SAFETY): prove the unlocked install on local NCTL first (recommended)

**Why:** never debug a 300-CSPR install on live testnet. The spec mandates proving the unlocked-deploy mechanism before touching anything live.

- [ ] Spin up local NCTL (`contracts` has a docker stack in the make-software x402 ref, or use the Casper NCTL image). Install `AgentGateRegistry.wasm` there via the Task-1 script with `odra_cfg_is_upgradable=true`.
- [ ] Query the package's `lock_status` → must be **Unlocked**. If Locked, the control args aren't taking — fix before spending real gas.
- [ ] Call `register_service` with a 2-option `accepts[]` on NCTL and read it back → confirms the stored call decodes (also smoke-tests the binaryen section order on a real call).

If NCTL isn't available, treat Task 1's testnet install as the first real test and verify `lock_status` immediately after (Task 2) before repointing anything.

---

### Task 1: Write + run the unlocked install script

**Files:**
- Create: `scripts/deploy-registry-v2.ts`
- Modify (if needed): `packages/chain/src/sdk.ts` (re-export `SessionBuilder` — the repo's sdk wrapper currently doesn't export it)

**Interfaces:**
- Produces: the new package hash printed to stdout + written to a scratch file (e.g. `data/registry-v2-hash.txt`).

- [ ] Add `SessionBuilder` to the `createRequire`-based re-export list in `packages/chain/src/sdk.ts` (it destructures a fixed set from casper-js-sdk; add `SessionBuilder`).
- [ ] Write `scripts/deploy-registry-v2.ts`: load `.env`; `PrivateKey.fromPem(GATE_SIGNER_PEM_PATH, SECP256K1)`; read `contracts/agentgate-registry/wasm/AgentGateRegistry.wasm`; build an install session:
  `new SessionBuilder().from(gatePub).chainName('casper-test').wasm(bytes).installOrUpgrade().runtimeArgs(Args.fromMap({ odra_cfg_is_upgradable: CLValue bool true, odra_cfg_is_upgrade: bool false, odra_cfg_allow_key_override: bool true, odra_cfg_package_hash_key_name: CLValue string "agentgate_registry_package_hash" })).payment(300_000_000_000).build()`; `tx.sign(gateKey)`; `rpc.putTransaction(tx)`; print the deploy hash.
  (Mirror the exact builder/sign/put idiom already used in `packages/chain/src/live.ts` `callEntrypoint`; match casper-js-sdk 5.0.12.)
- [ ] Run: `npx tsx --env-file=.env scripts/deploy-registry-v2.ts`. Expected: a deploy hash; wait for it to finalize (`error=None`) on `testnet.cspr.live`.
- [ ] Resolve the new **package hash** from the install (via the account's `agentgate_registry_package_hash` named key, or the deploy's execution effects). Save it to `data/registry-v2-hash.txt`.

---

### Task 2: Verify v2 is UNLOCKED + the stored call works

- [ ] `query_global_state key=hash-<newpkg>` → `ContractPackage.lock_status` == **Unlocked**, 1 version. (Same RPC used in Phase 0.)
- [ ] Call `register_service` once against v2 with a real 2-option `accepts[]` (native 2.5 CSPR + WCSPR 0.1) using the gate key, then read the service back and confirm `accepts` decodes. This is the **binaryen "sections out of order" gate** — if the stored call reverts with a wasm/sections error, STOP: rebuild the wasm with the pinned toolchain and redeploy (do NOT repoint the live gateway).

---

### Task 3: Re-register the core services on v2

- [ ] Register the core services (confirm the exact list — candidates: RWA FX & Gold Oracle; Global Currency Feed / WCSPR facilitator; live FX feed) each with an `accepts[]` reflecting its rails (native + WCSPR where facilitator-enabled). Record the new service ids.
- [ ] Map each service's private upstream on the gateway (admin `/admin/services`) — same as `wrap` does today.

---

### Task 4: Repoint the live gateway + smoke test (reversible)

- [ ] Edit root `.env` `REGISTRY_CONTRACT_PACKAGE_HASH=hash-<newpkg>`. (Keep the old value commented for one-line rollback.)
- [ ] `pm2 restart agentgate-gateway` (see agentgate-deploy-gotchas: kill orphan next-server if any; `--update-env`).
- [ ] Smoke: `curl gateway.mdloglabs.org/svc/<id>` → 402 with the new on-chain `accepts[]`; a facilitator `buy` settles 0.1 WCSPR; native `buy` settles. `/activity` shows the payment. If broken → revert `.env` to the old hash + restart (rollback).

---

### Task 5: Rebuild reputation with real buys (honest, verifiable)

- [ ] Run several real buys per re-registered service (native + facilitator) so v2 attestations reference genuine payment txs. Confirm scores climb on `/catalog`.

---

## Deferred to later phases
- **Phase 3:** chain client `parseService` decodes `accepts[]`; `cloudEntryPoint` heuristic `has('price')` → `has('accepts')`; gateway derives 402 from on-chain `accepts[]`; catalog renders per-asset from chain. (The gateway can keep using `FACILITATOR_SERVICES` env until Phase 3 lands — v2 works on the native rail immediately; facilitator via env still works.)
- **Phase 4:** CLI `wrap --accept`; bump + republish `@mdlog/agentgate` with the new default hash.

## Risks
- **binaryen sections-out-of-order** surfaces on the STORED call (Task 2), not at build — that gate is why Task 2 precedes any repoint.
- **Live-prod repoint** (Task 4) is the reversible cutover; the old locked registry stays the rollback.
- **Chain client parse:** until Phase 3, the current `parseService` expects the OLD `price` layout and will MISPARSE v2 services. → Phase 3 must land before/with the gateway repoint, OR the repoint (Task 4) will break reads. **Ordering note:** Task 4 depends on Phase 3's parser. Sequence in practice: Phase 1 (done) → Phase 3 parser → Phase 2 deploy+repoint → Phase 4 CLI. Revisit ordering at execution.
