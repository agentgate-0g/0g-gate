# On-chain `accepts[]` — Phase 1: Registry v2 Contract — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change the `AgentGateRegistry` Odra contract so each service stores a multi-asset `accepts: Vec<PaymentOption>` list instead of a single native-CSPR `price`, with validation and full unit-test coverage, building a fresh v2 wasm.

**Architecture:** A new `PaymentOption` odra_type carries `(asset, amount, decimals, symbol, name, version)`. `Service.price: U512` becomes `Service.accepts: Vec<PaymentOption>`. `register_service` takes the vec and validates it (non-empty; every `amount ≥ MIN_PRICE_MOTES`). This is Phase 1 of 4 — contract only; deploy/cutover, off-chain reads, and CLI land in later plans. The package is deployed **unlocked/upgradable** in Phase 2 (deploy-time arg), so no contract-source change is needed for upgradability here.

**Tech Stack:** Rust, Odra 2.7.x, cargo-odra, Casper 2.0 (Condor), OdraVM (unit tests).

## Global Constraints

- Money type is `odra::casper_types::U512` (motes / token atomic units); imported via `use odra::casper_types::U512;`, NOT the prelude.
- `MIN_PRICE_MOTES = 1000` — every `PaymentOption.amount` must be `>= 1000`.
- Do NOT add the Claude `Co-Authored-By` trailer to commits in this repo.
- Field order in `Service` is load-bearing for the off-chain byte parser (Phase 3) — keep `accepts` exactly where `price` was (4th field, after `gateway_base_url`).
- Odra `#[odra::odra_type]` derives (de)serialization; `#[odra::event]` for events; user error codes stay `1..=6`.
- Contract crate lives at `contracts/agentgate-registry/`.

---

### Task 1: Establish the green baseline + confirm the toolchain

**Files:**
- Read: `contracts/agentgate-registry/rust-toolchain.toml`, `contracts/agentgate-registry/Cargo.toml`

**Interfaces:**
- Consumes: nothing.
- Produces: the exact, verified commands for `test` and `build` used by every later task.

- [ ] **Step 1: Confirm the pinned toolchain**

Run: `cat contracts/agentgate-registry/rust-toolchain.toml`
Expected: a pinned channel (note it — the first live deploy hit a binaryen "sections out of order" issue; this toolchain is the known-good one).

- [ ] **Step 2: Run the existing unit tests (OdraVM) to establish a green baseline**

Run: `cd contracts/agentgate-registry && cargo test`
Expected: existing tests PASS (register_and_get_happy_path, services_count_increments_with_sequential_ids, empty_or_whitespace_name_reverts, price_below_minimum_reverts_and_minimum_is_accepted, unknown_service_reads_return_defaults, owner_can_record_attestation, …).

If the command differs in this repo (e.g. a wrapper), record the working command and use it verbatim in every later Run step.

- [ ] **Step 3: Confirm the wasm build command works on the current contract**

Run: `cd contracts/agentgate-registry && cargo odra build`
Expected: produces `wasm/AgentGateRegistry.wasm` with no error. (If the repo uses `cargo run --bin build_contract` instead, record that.)

No commit (baseline only).

---

### Task 2: Add the `PaymentOption` type and migrate `Service`/`register_service` to `accepts[]`

**Files:**
- Modify: `contracts/agentgate-registry/src/registry.rs` (struct `Service` ~40-62, `ServiceRegistered` ~77-91, `register_service` ~174-224, tests module ~357+)
- Modify: `contracts/agentgate-registry/src/lib.rs:24-27` (re-export `PaymentOption`)

**Interfaces:**
- Consumes: `MIN_PRICE_MOTES`, `Error::{EmptyName, InvalidPrice}`, `U512`.
- Produces:
  - `pub struct PaymentOption { pub asset: String, pub amount: U512, pub decimals: u8, pub symbol: String, pub name: String, pub version: String }`
  - `Service.accepts: Vec<PaymentOption>` (replaces `Service.price`)
  - `register_service(name: String, description: String, gateway_base_url: String, accepts: Vec<PaymentOption>, payment_target: Address, attestor: Address) -> u64`
  - `ServiceRegistered { service_id, owner, name, accepts: Vec<PaymentOption>, payment_target, attestor }`

- [ ] **Step 1: Rewrite the affected tests to the target API (fail first)**

In `registry.rs` test module, replace the `register` helper and add two option constructors + the schema assertions. Replace the existing `register` fn and the two price-related tests:

```rust
    // Test option constructors.
    fn native(amount: u64) -> PaymentOption {
        PaymentOption {
            asset: "native".to_string(),
            amount: U512::from(amount),
            decimals: 9,
            symbol: "CSPR".to_string(),
            name: "CSPR".to_string(),
            version: String::new(),
        }
    }

    fn wcspr(amount: u64) -> PaymentOption {
        PaymentOption {
            asset: "hash-3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e".to_string(),
            amount: U512::from(amount),
            decimals: 9,
            symbol: "WCSPR".to_string(),
            name: "Wrapped CSPR".to_string(),
            version: "1".to_string(),
        }
    }

    fn register(env: &HostEnv, registry: &mut AgentGateRegistryHostRef) -> u64 {
        registry.register_service(
            "USD/IDR + Gold Oracle".to_string(),
            "RWA feed: USD/IDR rate and gold spot with confidence".to_string(),
            "http://localhost:4021".to_string(),
            vec![native(500_000_000)],
            env.get_account(PAYMENT_TARGET),
            env.get_account(ATTESTOR),
        )
    }
```

In `register_and_get_happy_path`, replace the price assertion + event assertion:

```rust
        assert_eq!(service.accepts, vec![native(500_000_000)]);
        // …unchanged assertions for name/description/gateway_base_url/payment_target/owner/attestor/active/created_at…
        assert!(env.emitted_event(
            &registry,
            ServiceRegistered {
                service_id: 1,
                owner: env.get_account(OWNER),
                name: "USD/IDR + Gold Oracle".to_string(),
                accepts: vec![native(500_000_000)],
                payment_target: env.get_account(PAYMENT_TARGET),
                attestor: env.get_account(ATTESTOR),
            }
        ));
```

Replace `empty_or_whitespace_name_reverts`'s inner call to pass `vec![native(MIN_PRICE_MOTES)]` instead of `U512::from(MIN_PRICE_MOTES)`.

Rename `price_below_minimum_reverts_and_minimum_is_accepted` → `amount_below_minimum_reverts_and_minimum_is_accepted` and rewrite:

```rust
    #[test]
    fn amount_below_minimum_reverts_and_minimum_is_accepted() {
        let (env, mut registry) = setup();

        // 999 motes — below the 1000-motes floor.
        assert_eq!(
            registry
                .try_register_service(
                    "Cheap".to_string(),
                    "desc".to_string(),
                    "http://localhost:4021".to_string(),
                    vec![native(MIN_PRICE_MOTES - 1)],
                    env.get_account(PAYMENT_TARGET),
                    env.get_account(ATTESTOR),
                )
                .unwrap_err(),
            Error::InvalidPrice.into()
        );

        // Exactly 1000 motes is valid (boundary).
        let id = registry.register_service(
            "Min price".to_string(),
            "desc".to_string(),
            "http://localhost:4021".to_string(),
            vec![native(MIN_PRICE_MOTES)],
            env.get_account(PAYMENT_TARGET),
            env.get_account(ATTESTOR),
        );
        assert_eq!(registry.get_service(id).unwrap().accepts, vec![native(1000)]);
    }
```

Add two new tests at the end of the registration section:

```rust
    #[test]
    fn empty_accepts_reverts() {
        let (env, mut registry) = setup();
        assert_eq!(
            registry
                .try_register_service(
                    "No options".to_string(),
                    "desc".to_string(),
                    "http://localhost:4021".to_string(),
                    vec![],
                    env.get_account(PAYMENT_TARGET),
                    env.get_account(ATTESTOR),
                )
                .unwrap_err(),
            Error::InvalidPrice.into()
        );
        assert_eq!(registry.services_count(), 0);
    }

    #[test]
    fn multi_asset_accepts_round_trip() {
        let (env, mut registry) = setup();
        let id = registry.register_service(
            "Global Currency Feed".to_string(),
            "Live USD FX; pay in CSPR or WCSPR".to_string(),
            "http://localhost:4021".to_string(),
            vec![native(2_500_000_000), wcspr(100_000_000)],
            env.get_account(PAYMENT_TARGET),
            env.get_account(ATTESTOR),
        );
        let service = registry.get_service(id).unwrap();
        assert_eq!(service.accepts.len(), 2);
        assert_eq!(service.accepts[0], native(2_500_000_000));
        assert_eq!(service.accepts[1], wcspr(100_000_000));
        assert_eq!(service.accepts[1].symbol, "WCSPR");
        assert_eq!(service.accepts[1].name, "Wrapped CSPR");
    }
```

- [ ] **Step 2: Run tests to verify they FAIL to compile**

Run: `cd contracts/agentgate-registry && cargo test`
Expected: FAIL — compile errors ("no field `accepts` on Service", "cannot find type `PaymentOption`", `register_service` arity mismatch).

- [ ] **Step 3: Add `PaymentOption`, migrate `Service`, event, and `register_service`**

In `registry.rs`, add the type just above `struct Service`:

```rust
/// One accepted way to pay for a call (an entry in a service's `accepts` list).
/// Mirrors an x402 `accepts[]` option. `asset` is "native" for CSPR or a CEP-18
/// package hash string ("hash-<64hex>") for a token (e.g. WCSPR). `amount` is in
/// the asset's atomic units. `name`/`version` are the EIP-712 domain fields the
/// facilitator rail needs (cosmetic for native).
#[odra::odra_type]
pub struct PaymentOption {
    pub asset: String,
    pub amount: U512,
    pub decimals: u8,
    pub symbol: String,
    pub name: String,
    pub version: String,
}
```

In `struct Service`, replace the `price` field (keep the 4th-field position):

```rust
    /// Accepted payment options (non-empty). The authoritative price list;
    /// readers derive the x402 402 `accepts[]` directly from this.
    pub accepts: Vec<PaymentOption>,
```

In `struct ServiceRegistered`, replace `pub price: U512,` with:

```rust
    /// Accepted payment options at registration.
    pub accepts: Vec<PaymentOption>,
```

Rewrite `register_service`:

```rust
    pub fn register_service(
        &mut self,
        name: String,
        description: String,
        gateway_base_url: String,
        accepts: Vec<PaymentOption>,
        payment_target: Address,
        attestor: Address,
    ) -> u64 {
        if name.trim().is_empty() {
            self.env().revert(Error::EmptyName);
        }
        if accepts.is_empty() {
            self.env().revert(Error::InvalidPrice);
        }
        for opt in accepts.iter() {
            if opt.amount < U512::from(MIN_PRICE_MOTES) {
                self.env().revert(Error::InvalidPrice);
            }
        }

        let service_id = self.services_count.get_or_default() + 1;
        let owner = self.env().caller();
        let created_at = self.env().get_block_time();

        self.env().emit_event(ServiceRegistered {
            service_id,
            owner,
            name: name.clone(),
            accepts: accepts.clone(),
            payment_target,
            attestor,
        });

        self.services.set(
            &service_id,
            Service {
                name,
                description,
                gateway_base_url,
                accepts,
                payment_target,
                owner,
                attestor,
                active: true,
                created_at,
            },
        );
        self.services_count.set(service_id);

        service_id
    }
```

In `lib.rs`, add `PaymentOption` to the re-export list:

```rust
pub use registry::{
    AgentGateRegistry, Attestation, AttestationRecorded, Error, PaymentOption, Service,
    ServiceRegistered, ServiceStatusChanged,
};
```

- [ ] **Step 4: Run tests to verify they PASS**

Run: `cd contracts/agentgate-registry && cargo test`
Expected: PASS — all migrated + new tests green (multi_asset_accepts_round_trip, empty_accepts_reverts, amount_below_minimum_reverts_and_minimum_is_accepted, register_and_get_happy_path, and the untouched attestation/set_active/set_attestor tests).

- [ ] **Step 5: Commit**

```bash
git add contracts/agentgate-registry/src/registry.rs contracts/agentgate-registry/src/lib.rs
git commit -m "feat(contract): registry v2 — multi-asset accepts[] per service"
```

---

### Task 3: Build the v2 wasm + regenerate the schema

**Files:**
- Generates: `contracts/agentgate-registry/wasm/AgentGateRegistry.wasm`, `contracts/agentgate-registry/resources/casper_contract_schemas/agent_gate_registry_schema.json`

**Interfaces:**
- Consumes: the migrated contract from Task 2.
- Produces: the deployable v2 wasm (Phase 2 installs it) + the updated schema (reflects `accepts[]`).

- [ ] **Step 1: Build the wasm**

Run: `cd contracts/agentgate-registry && cargo odra build`
Expected: `wasm/AgentGateRegistry.wasm` regenerated, no error.

- [ ] **Step 2: Guard against the binaryen "sections out of order" regression**

Run: `wasm-objdump -h contracts/agentgate-registry/wasm/AgentGateRegistry.wasm 2>/dev/null | head -30` (or `cargo odra` post-processing if the repo wraps it)
Expected: sections in canonical order (Type, Import, Function, … before Custom/DataCount as required). If out of order, use the pinned binaryen/toolchain from Task 1 Step 1 that produced the working first deploy, and rebuild. Do NOT proceed to Phase 2 with a mis-ordered wasm.

- [ ] **Step 3: Regenerate the schema**

Run: `cd contracts/agentgate-registry && cargo odra schema`
Expected: `resources/casper_contract_schemas/agent_gate_registry_schema.json` updated — `register_service` now takes an `accepts` arg (list of `PaymentOption`), `Service` carries `accepts`.

- [ ] **Step 4: Commit the built artifacts**

```bash
git add contracts/agentgate-registry/wasm/AgentGateRegistry.wasm contracts/agentgate-registry/resources/casper_contract_schemas/agent_gate_registry_schema.json
git commit -m "build(contract): v2 wasm + schema with accepts[]"
```

---

## Cross-phase notes (for Phase 2-4 authors — NOT tasks here)

- **Phase 2 (deploy):** install v2 **unlocked/upgradable** — pass the Odra upgradable install config (e.g. `odra_cfg_is_upgradable=true`) so the package accepts future versions (the current live package is LOCKED, which is why we redeploy). Re-register the core services with `accepts[]`. Repoint `.env` `REGISTRY_CONTRACT_PACKAGE_HASH`; keep the old hash `hash-10f92725…` documented for rollback.
- **Phase 3 (chain client):** `cloudEntryPoint` in `packages/chain/src/live.ts` infers `register_service` via `has('name') && has('price')` — the arg is now `accepts`, so update that heuristic to `has('accepts')`. Rewrite `parseService` to decode the new layout (`Vec<PaymentOption>` at the 4th field). Gateway derives the 402 `accepts[]` from chain.
- **Phase 4 (CLI):** `wrap` gains `--accept <asset>:<amount>` (repeatable); bump + republish `@mdlog/agentgate` because the built-in default registry hash changes.

## Self-review notes

- **Spec coverage:** §4A (contract schema + PaymentOption + register validation + unchanged record_attestation) is fully covered by Tasks 1-3. §4A's `name`/`version` domain fields are in `PaymentOption`. Deploy/off-chain/CLI (§4B-D) are explicitly out of this phase (see cross-phase notes) — each gets its own plan.
- **Placeholders:** none — every code step shows complete Rust.
- **Type consistency:** `PaymentOption` fields (asset, amount, decimals, symbol, name, version) are identical across the type def, the `native`/`wcspr` test constructors, the event, and `register_service`. `Service.accepts` and `ServiceRegistered.accepts` are both `Vec<PaymentOption>`.
