# On-chain `accepts[]` — AgentGate Registry v2 (design)

- **Date:** 2026-07-22
- **Status:** approved (brainstorming) → pending spec review → writing-plans
- **Author:** AgentGate (mdlog)
- **Topic:** move per-service payment pricing (asset + amount) on-chain as a multi-asset `accepts[]` list, via a new registry contract, so the catalog and any client read authoritative prices from the chain instead of gateway config.

## 1. Problem

The deployed registry (`AgentGateRegistry`, package `hash-10f92725…`) stores a service's price as a single `price: U512` in **native CSPR motes** — there is **no asset field**. The facilitator (CEP-18/WCSPR) rail's real charge lives only in the gateway's `FACILITATOR_SERVICES` env, off-chain.

Result (observed): `/catalog` shows service #9 at **2.5 CSPR** (the on-chain nominal from `wrap --price 2.5`), while a facilitator buy actually settles **0.1 WCSPR** (gateway config). The two layers disagree; a viewer/judge can't tell #9 is a WCSPR service, and there is no single on-chain source of truth for price+asset.

**Goal:** make `(asset, amount)` — a full `accepts[]` list per service, mirroring x402's `accepts[]` — first-class **on-chain** data, so the 402 invoice, catalog, and third parties all derive price+asset from the chain. This eliminates config drift and makes pricing discoverable without trusting a single gateway operator.

## 2. Phase 0 finding (decisive)

`query_global_state` on the live registry package returns:

```
ContractPackage 10f92725… → lock_status: LOCKED  (1 version: contract-fe134f78…)
```

A **locked** Casper package cannot accept new contract versions (`add_contract_version` fails) — this is Odra's default for a `NoArgs` deploy. **In-place upgrade is impossible.** The on-chain change therefore requires a **new registry contract** (new package hash).

## 3. Decisions (locked in)

| Decision | Choice |
|---|---|
| On-chain data model | **Typed `accepts: Vec<PaymentOption>`** per service (multi-asset). JSON-string is the documented fallback only if byte-parsing proves fragile. |
| Contract strategy | **New v2 registry** (old package is locked). Deploy v2 as an **UNLOCKED / upgradable** package so future changes never hit the locked wall again. |
| Timing | **Deploy v2 now**, before the finals deadline (2026-07-26 23:59), with a rollback path. |
| Reputation | **Fresh start + rebuild with real buys.** v2 scores begin at 0; run genuine native + facilitator payments per service so every score point maps to a real on-chain payment tx (defensible to a technical jury). No score seeding/fabrication. |
| `record_attestation` | **Unchanged** signature `(service_id, payment_deploy_hash, success)` — keep the opaque hash; asset audit already available via `/activity` ft-token-actions. (Adding an asset ref is out of scope for this change.) |

## 4. Design

### A. Contract v2 (`contracts/agentgate-registry`, Odra)

New type:
```rust
#[odra::odra_type]
pub struct PaymentOption {
    pub asset: String,   // "native" (CSPR) | "hash-<64hex>" (CEP-18 package, e.g. WCSPR)
    pub amount: U512,     // atomic units of `asset` (motes for native; token base units for CEP-18)
    pub decimals: u8,     // 9 for CSPR/WCSPR; used for display + EIP-712 token domain
    pub symbol: String,   // "CSPR" | "WCSPR" | …
    pub name: String,     // EIP-712 domain name, e.g. "Wrapped CSPR" (CEP-18 rail); "CSPR" for native
    pub version: String,  // EIP-712 domain version, e.g. "1" (CEP-18 rail); "" for native
}
```
`name` + `version` are carried so the gateway can build the CEP-18/EIP-712 domain (name + version are the domain-critical fields) entirely from on-chain data — no gateway config needed. For a native option they are cosmetic.

`Service` v2 replaces the scalar `price` with:
```rust
pub accepts: Vec<PaymentOption>,   // non-empty; the authoritative payment options
```
All other fields unchanged (name, description, gateway_base_url, payment_target, owner, attestor, active, created_at).

`register_service(name, description, gateway_base_url, accepts: Vec<PaymentOption>, payment_target, attestor) -> u64`
- Reverts `EmptyName` if name blank; `InvalidPrice` if `accepts` empty or any `amount < MIN_PRICE_MOTES` (1000).
- (Native option: `asset == "native"`. At most one native option; CEP-18 options keyed by package hash.)

Unchanged entrypoints: `record_attestation`, `set_active`, `set_attestor`, `get_service`, `get_score`, `get_attestations`. New: none required beyond the changed `register_service` (a `set_accepts` owner-only updater is a **nice-to-have, deferred** unless trivially cheap).

Odra config: enable upgradable/unlocked package (`odra_cfg_is_upgradable=true` at install) so v2 (and v3…) can add versions.

### B. Reputation

- v2 launches with empty scores. After cutover, re-register the **core services only** (candidate set: the RWA FX & gold oracle, the WCSPR facilitator service, the live FX feed — exact list confirmed at plan time; exclude test/paused ones).
- Rebuild reputation by running real buys per service (native ≈ 2.5 CSPR, facilitator = 0.1 WCSPR) so attestations on v2 reference genuine payment txs.

### C. Off-chain

- **`packages/chain` (chain client):** rewrite the `Service` byte parser to the v2 layout, decoding `Vec<PaymentOption>` (Vec = u32 LE length prefix + each element in field order: String asset, U512 amount, u8 decimals, String symbol, String name, String version). `getService`/`listServices` return `accepts[]`. Add parse unit tests. *(If hand-decoding the Vec is too fragile, fall back to the JSON-string model.)*
- **Gateway (`packages/middleware`):** build the 402 `accepts[]` **from the on-chain `accepts[]`** (via the chain client), not from `FACILITATOR_SERVICES` env — env demoted to a fallback/deprecated. The private upstream URL mapping stays gateway-side (admin `/admin/services`). The EIP-712 token domain (name/version/decimals) is sourced from the on-chain option's fields.
- **Dashboard (`/catalog`, `/services/[id]`):** render price per accepted asset ("2.5 CSPR" and/or "0.1 WCSPR") from the chain `accepts[]`. Removes the CSPR-only display and the config coupling.
- **CLI `wrap`:** accept repeatable `--accept <asset>:<amount>` (e.g. `--accept native:2.5 --accept wcspr:0.1`); keep `--price <cspr>` as a shorthand that expands to a single native option.

### D. Cutover, rollback, CLI republish

1. Build v2 wasm (watch for the binaryen "sections out of order" issue seen on the first deploy; pin the toolchain that worked).
2. Deploy v2 (unlocked) from the gate key → new package hash.
3. Re-register the core services with `accepts[]`; map their upstreams on the gateway.
4. Repoint to the new hash: gateway `.env` `REGISTRY_CONTRACT_PACKAGE_HASH`, dashboard config, smoke tests, and the **CLI's built-in default hash**.
5. **Bump + republish `@mdlog/agentgate` (e.g. 0.1.7)** — the default registry hash ships inside the npm package, so a republish is mandatory. *(This reverses the earlier "no bump needed" conclusion, which held only while the registry hash was unchanged.)*
6. Rebuild reputation with real buys; smoke-test both rails + `/activity` + `/catalog`.
7. **Rollback:** the old locked registry `10f92725…` stays live and frozen. If v2 misbehaves, repoint `.env` back and restart the gateway; the CLI can pin `--registry`/prior version.

### E. Testing

- Odra unit tests: `register_service` with `accepts[]` (multi-option), validation reverts (empty accepts, below-min amount), get_service round-trip.
- Chain-client tests: parse a v2 `Service` with a mixed `accepts[]` (native + WCSPR).
- Gateway tests: 402 `accepts[]` derived from a mocked on-chain service (native-only, token-only, both).
- Dashboard: catalog renders each asset's price.

## 5. Risks & mitigations

- **wasm build (binaryen "sections out of order")** — pin the toolchain/binaryen that produced the working first deploy; verify the wasm loads on a stored call before trusting it.
- **Deadline pressure (before 2026-07-26)** — rollback to the old registry is one `.env` repoint + restart; keep the demo working on the old contract until v2 is smoke-clean.
- **Vec<PaymentOption> byte-parsing fragility** — JSON-string `accepts` is the documented fallback.
- **Reputation optics** — fresh + real buys keeps every score honest and verifiable (chosen over seeding).
- **CLI republish** — required; if npm publish is blocked, users can pass the v2 hash via `--registry`/env in the interim.

## 6. Out of scope

- Migrating old scores/attestations into v2 (fresh start chosen).
- Adding an asset reference to `record_attestation`.
- An owner-only `set_accepts` updater (deferred; re-register covers it for now).
- Mainnet deploy.

## 7. To confirm at plan time

- Exact list of services to re-register on v2.
- Whether to keep `--price` shorthand or require explicit `--accept`.
- Toolchain pin for the wasm build.
