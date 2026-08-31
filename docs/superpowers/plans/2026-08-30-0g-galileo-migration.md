# AgentGate → 0G Galileo Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace AgentGate's Casper Testnet chain layer with 0G Galileo Testnet (EVM), keeping every HTTP-402 behaviour above the `ChainClient` seam byte-identical.

**Architecture:** Three Solidity contracts (`AgentGateRegistry`, `PaymentRouter`, `SpendGuard`) replace two Odra/Rust contracts and Casper's native `transfer_id`. `Live0gClient` (viem) replaces `LiveCasperClient`, reading state through ABI view calls and history through `eth_getLogs` instead of the CSPR.cloud REST indexer. Everything above `packages/shared/src/types.ts:90` (`ChainClient`) — middleware, oracle, buyer-agent, devnet, CLI command surface, dashboard components — keeps its logic; only units (9→18 dp), address shape (`account-hash-…`→`0x…`), and signature primitive (PEM ed25519 → EIP-191) change.

**Tech Stack:** Solidity 0.8.28 + Foundry (`forge`/`cast`/`anvil`, already installed at `~/.foundry/bin`), viem 2.x, TypeScript 5.6 (ESM, `strict`, `noUncheckedIndexedAccess`), vitest 3, Next.js 15 (dashboard), Node ≥ 22.

**Spec:** `docs/superpowers/specs/2026-08-30-0g-galileo-migration-design.md`

## Status (2026-08-31)

**Tasks 1–16 are implemented and committed.** The gate at the end of every task
is green:

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (9 packages + dashboard + root scripts/e2e) |
| `npx vitest run` | 426 passed / 31 files |
| `cd contracts-evm && forge test` | 42 passed |
| `npm run build` (Next.js) | succeeds |
| `npm run demo` | exits 0 — full loop on the mock chain |

Also exercised by hand against a running stack: the CLI (`wrap`, `list`,
`status`, `buy`, `pause`, `resume`, `demo-accounts`), the MCP server (all four
tools, including a real `agentgate_buy` and its `maxOg` cap), the buyer agent,
the dashboard API routes, and the built npm tarball (`agentgate-0g@1.0.0`).

**One step remains, and it is blocked on a funded key, not on code:**

- **Task 5 Step 4 / Task 15 Step 5 — the real broadcast to 0G Galileo.** The
  contracts are dry-run against a local Anvil fork of live 0G state and pass
  their suite, but they are not deployed. Everything downstream of that (the
  live demo trail, the addresses in the README / `contracts-evm/README.md` /
  `DEFAULT_REGISTRY_ADDRESS`) is waiting on it. Deploy costs ≈0.014 OG, inside
  one day's faucet grant. Procedure: `docs/DEPLOY.md`.

Two deviations from the plan as written, both deliberate:

1. **The six Casper Buildathon submission artifacts were archived, not
   rewritten** (`docs/archive/pre-0g/`). They record what was
   actually submitted and judged on Casper; rewriting them to say "0G" would
   make them a false record rather than an accurate old one. The dashboard
   changelog is handled the same way — v0.3.0 is prepended, older entries are
   left verbatim under a marker.
2. **A defect the plan did not anticipate was found and fixed** by running
   `npm run demo`: mock mode issued 402 invoices with an empty `extra.router`,
   which the buyer client rejects — so the entire offline path was broken while
   the gateway looked healthy. See `MOCK_PAYMENT_ROUTER_ADDRESS`. `e2e` now runs
   the real stack's 402 through `parsePaymentRequired`, which is the assertion
   that would have caught it.

---

## Global Constraints

- Target chain: **0G Galileo Testnet**, chain ID **16602**, RPC `https://evmrpc-testnet.0g.ai`, explorer `https://chainscan-galileo.0g.ai`, faucet `https://faucet.0g.ai` (0.1 OG/wallet/day). Verify the chain ID with `cast chain-id --rpc-url https://evmrpc-testnet.0g.ai` before Task 5 — older sources say 16601.
- Native token **OG, 18 decimals**. `WEI_PER_OG = 1_000_000_000_000_000_000n`. Price floor `MIN_PRICE_WEI = 1e12`.
- **All contract timestamps are milliseconds**: every contract stores/emits `uint64(block.timestamp) * 1000`. Off-chain readers are contracted on ms and must not be changed.
- Solidity `pragma solidity 0.8.28;` exactly (pinned, not `^`). SPDX `MIT` on every file.
- TypeScript: ESM only, `import type` for type-only imports, no `any`, `noUncheckedIndexedAccess` is on — index access yields `T | undefined`.
- Tests: `vitest run` from repo root (config includes `packages/*/test/**/*.test.ts` and `e2e/**/*.test.ts`). Solidity tests: `forge test` from `contracts-evm/`.
- Every task ends with `npm run typecheck && npx vitest run` green (plus `forge test` for contract tasks) before the commit step.
- No Casper identifier survives the final task: `casper`, `cspr`, `motes`, `account-hash`, `deploy_hash` must not appear outside `docs/superpowers/` history and `CHANGELOG` entries.
- Never log, echo, or commit a private key. `.env` stays gitignored.

---

## File Structure

**Created:**

| Path | Responsibility |
|---|---|
| `contracts-evm/foundry.toml` | Foundry config: solc 0.8.28, optimizer, 0G RPC endpoint |
| `contracts-evm/src/AgentGateRegistry.sol` | Service registry + attestation/reputation ledger |
| `contracts-evm/src/PaymentRouter.sol` | Invoice-bound native payment + `Paid` event |
| `contracts-evm/src/SpendGuard.sol` | Per-policy escrow spend firewall |
| `contracts-evm/test/AgentGateRegistry.t.sol` | Registry unit tests |
| `contracts-evm/test/PaymentRouter.t.sol` | Router unit tests |
| `contracts-evm/test/SpendGuard.t.sol` | SpendGuard unit tests |
| `contracts-evm/script/Deploy.s.sol` | Deploys all three, prints addresses |
| `packages/chain/src/abi.ts` | Typed ABI consts exported for viem |
| `packages/chain/src/live-0g.ts` | `Live0gClient implements ChainClient` |
| `packages/chain/src/address.ts` | EVM address normalize/validate helpers |
| `packages/chain/test/live-0g-reads.test.ts` | Read-path tests (anvil) |
| `packages/chain/test/live-0g-writes.test.ts` | Write + `verifyTransfer` tests (anvil) |
| `packages/chain/test/address.test.ts` | Address helper tests |

**Deleted:**

| Path | Reason |
|---|---|
| `contracts/agentgate-registry/` | Superseded by `contracts-evm/src/AgentGateRegistry.sol` |
| `contracts/spend-guard/` | Superseded by `contracts-evm/src/SpendGuard.sol` |
| `packages/chain/src/live.ts` | Superseded by `live-0g.ts` |
| `packages/chain/src/sdk.ts` | casper-js-sdk CJS shim; viem is ESM |
| `packages/chain/test/{odra-state-key,contract-resolve,service-parse,register-args,cloud-entry-point,ft-action-payment,verify-transfer-pending}.test.ts` | Test Casper-only internals |

**Modified (major):** `packages/shared/src/{money,types,config,x402}.ts`,
`packages/chain/src/{index,signature}.ts`, `packages/cli/src/identity.ts`,
`packages/middleware/src/app.ts`, `packages/devnet/src/state.ts`,
`dashboard/components/tx-hash.tsx`, `dashboard/app/docs/**`, `README.md`, `.env.example`.

---

## Task 1: Foundry scaffold + registry registration path

**Files:**
- Create: `contracts-evm/foundry.toml`, `contracts-evm/.gitignore`, `contracts-evm/src/AgentGateRegistry.sol`
- Test: `contracts-evm/test/AgentGateRegistry.t.sol`
- Reference (read, do not modify): `contracts/agentgate-registry/src/registry.rs:293-360`

**Interfaces:**
- Produces: `AgentGateRegistry.registerService(string,string,string,PaymentOption[],address,address) -> uint64`, `getService(uint64) -> Service`, `servicesCount() -> uint64`, `struct PaymentOption`, `struct Service`, `event ServiceRegistered`, errors `EmptyName()` / `InvalidPrice()` / `ServiceNotFound()`, constant `MIN_PRICE_WEI`.

- [ ] **Step 1: Scaffold the Foundry project**

```bash
cd "$(git rev-parse --show-toplevel)"   # the worktree root — never a hardcoded checkout path
mkdir -p contracts-evm/src contracts-evm/test contracts-evm/script
cat > contracts-evm/foundry.toml <<'TOML'
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
test = "test"
script = "script"
solc_version = "0.8.28"
optimizer = true
optimizer_runs = 200
via_ir = false
evm_version = "cancun"

[rpc_endpoints]
galileo = "${ZG_RPC_URL}"

[etherscan]
galileo = { key = "${ZG_EXPLORER_API_KEY}", url = "https://chainscan-galileo.0g.ai/api", chain = 16602 }
TOML
cat > contracts-evm/.gitignore <<'GI'
out/
cache/
lib/
broadcast/
GI
cd contracts-evm && forge install foundry-rs/forge-std --no-git
```

Expected: `lib/forge-std/` exists. If `--no-git` is unsupported by the installed
forge version, use `forge install foundry-rs/forge-std` and add `lib/` to
`.gitignore` (already done above).

- [ ] **Step 2: Write the failing test**

Create `contracts-evm/test/AgentGateRegistry.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {AgentGateRegistry} from "../src/AgentGateRegistry.sol";

contract AgentGateRegistryTest is Test {
    AgentGateRegistry internal reg;

    address internal owner = address(0xA11CE);
    address internal attestor = address(0xB0B);
    address internal payTarget = address(0xCAFE);

    function setUp() public {
        reg = new AgentGateRegistry();
        vm.warp(1_756_500_000); // deterministic block.timestamp (seconds)
    }

    function _nativeAccepts(uint256 amount)
        internal
        pure
        returns (AgentGateRegistry.PaymentOption[] memory a)
    {
        a = new AgentGateRegistry.PaymentOption[](1);
        a[0] = AgentGateRegistry.PaymentOption({
            asset: address(0),
            amount: amount,
            decimals: 18,
            symbol: "OG",
            name: "",
            version: ""
        });
    }

    function _register() internal returns (uint64 id) {
        vm.prank(owner);
        id = reg.registerService(
            "weather", "forecast API", "https://gateway.example",
            _nativeAccepts(1e15), payTarget, attestor
        );
    }

    function test_registerService_assignsOneBasedIdAndStoresRecord() public {
        uint64 id = _register();
        assertEq(id, 1);
        assertEq(reg.servicesCount(), 1);

        AgentGateRegistry.Service memory s = reg.getService(id);
        assertEq(s.name, "weather");
        assertEq(s.description, "forecast API");
        assertEq(s.gatewayBaseUrl, "https://gateway.example");
        assertEq(s.paymentTarget, payTarget);
        assertEq(s.owner, owner);
        assertEq(s.attestor, attestor);
        assertTrue(s.active);
        assertEq(s.createdAt, 1_756_500_000_000); // MS, not seconds
        assertEq(s.accepts.length, 1);
        assertEq(s.accepts[0].amount, 1e15);
        assertEq(s.accepts[0].asset, address(0));
    }

    function test_registerService_idsIncrementAndCounterTracksLatest() public {
        assertEq(_register(), 1);
        assertEq(_register(), 2);
        assertEq(reg.servicesCount(), 2);
    }

    function test_registerService_revertsOnEmptyName() public {
        vm.expectRevert(AgentGateRegistry.EmptyName.selector);
        vm.prank(owner);
        reg.registerService("", "d", "u", _nativeAccepts(1e15), payTarget, attestor);
    }

    function test_registerService_revertsOnWhitespaceOnlyName() public {
        vm.expectRevert(AgentGateRegistry.EmptyName.selector);
        vm.prank(owner);
        reg.registerService("   ", "d", "u", _nativeAccepts(1e15), payTarget, attestor);
    }

    function test_registerService_revertsOnEmptyAccepts() public {
        AgentGateRegistry.PaymentOption[] memory none =
            new AgentGateRegistry.PaymentOption[](0);
        vm.expectRevert(AgentGateRegistry.InvalidPrice.selector);
        vm.prank(owner);
        reg.registerService("n", "d", "u", none, payTarget, attestor);
    }

    function test_registerService_revertsBelowMinPrice() public {
        vm.expectRevert(AgentGateRegistry.InvalidPrice.selector);
        vm.prank(owner);
        reg.registerService("n", "d", "u", _nativeAccepts(1e12 - 1), payTarget, attestor);
    }

    function test_registerService_acceptsExactlyMinPrice() public {
        vm.prank(owner);
        uint64 id = reg.registerService(
            "n", "d", "u", _nativeAccepts(1e12), payTarget, attestor
        );
        assertEq(id, 1);
    }

    function test_getService_revertsForUnknownId() public {
        vm.expectRevert(AgentGateRegistry.ServiceNotFound.selector);
        reg.getService(99);
    }

    function test_registerService_emitsServiceRegistered() public {
        vm.expectEmit(true, true, false, false);
        emit AgentGateRegistry.ServiceRegistered(
            1, owner, "weather", _nativeAccepts(1e15), payTarget, attestor
        );
        _register();
    }
}
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `cd contracts-evm && forge test`
Expected: FAIL — `Source "src/AgentGateRegistry.sol" not found`.

- [ ] **Step 4: Implement the minimal contract**

Create `contracts-evm/src/AgentGateRegistry.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title AgentGateRegistry — service discovery + payment-attestation reputation
/// @notice EVM port of the Odra contract at contracts/agentgate-registry.
///         Semantics are preserved exactly: 1-based ids, caller becomes owner,
///         services start active, attestations are deduped per payment tx, and
///         all timestamps are UNIX MILLISECONDS (block.timestamp * 1000) because
///         every off-chain reader is contracted on ms.
contract AgentGateRegistry {
    /// Minimum price for any accepted option, in the asset's atomic units.
    /// 1e12 wei = 1e-6 OG — the 18-decimal equivalent of Casper's 1000-mote floor.
    uint256 public constant MIN_PRICE_WEI = 1e12;

    /// Per-service attestation ring-buffer capacity (keep the newest 100).
    uint256 public constant MAX_ATTESTATIONS = 100;

    /// One accepted way to pay for a call — an entry in a service's price list.
    /// `asset == address(0)` means native OG; any other value is an ERC-20.
    /// `name`/`version` are EIP-712 domain fields, empty for native.
    struct PaymentOption {
        address asset;
        uint256 amount;
        uint8 decimals;
        string symbol;
        string name;
        string version;
    }

    /// On-chain record describing one registered (wrapped) service.
    /// `gatewayBaseUrl` is stored, NOT the full endpoint: readers compute
    /// `endpointUrl = {gatewayBaseUrl}/svc/{id}`.
    struct Service {
        string name;
        string description;
        string gatewayBaseUrl;
        PaymentOption[] accepts;
        address paymentTarget;
        address owner;
        address attestor;
        bool active;
        uint64 createdAt; // unix MS
    }

    /// One recorded payment outcome.
    struct Attestation {
        bytes32 paymentTxHash;
        bool success;
        uint64 timestamp; // unix MS
    }

    error NotAuthorized();
    error ServiceNotFound();
    error ServiceInactive();
    error DuplicateAttestation();
    error InvalidPrice();
    error EmptyName();

    event ServiceRegistered(
        uint64 indexed serviceId,
        address indexed owner,
        string name,
        PaymentOption[] accepts,
        address paymentTarget,
        address attestor
    );

    /// Number of registered services; equals the id of the most recent one
    /// (ids are 1-based, 1..=servicesCount; id 0 means "absent" to every reader).
    uint64 public servicesCount;

    mapping(uint64 => Service) private _services;

    /// @notice Register a new service; the caller becomes its owner.
    /// @return serviceId the assigned 1-based id.
    function registerService(
        string calldata name,
        string calldata description,
        string calldata gatewayBaseUrl,
        PaymentOption[] calldata accepts,
        address paymentTarget,
        address attestor
    ) external returns (uint64 serviceId) {
        if (_isBlank(name)) revert EmptyName();
        if (accepts.length == 0) revert InvalidPrice();
        for (uint256 i = 0; i < accepts.length; i++) {
            if (accepts[i].amount < MIN_PRICE_WEI) revert InvalidPrice();
        }

        // 1-based ids: bump the counter first, then use it as the id.
        serviceId = servicesCount + 1;

        Service storage s = _services[serviceId];
        s.name = name;
        s.description = description;
        s.gatewayBaseUrl = gatewayBaseUrl;
        s.paymentTarget = paymentTarget;
        s.owner = msg.sender;
        s.attestor = attestor;
        s.active = true;
        s.createdAt = _nowMs();
        // Struct arrays cannot be assigned from calldata in one go; copy element-wise.
        for (uint256 i = 0; i < accepts.length; i++) {
            s.accepts.push(accepts[i]);
        }

        servicesCount = serviceId;

        emit ServiceRegistered(
            serviceId, msg.sender, name, accepts, paymentTarget, attestor
        );
    }

    /// @notice Fetch a service record. Reverts ServiceNotFound for unknown ids.
    function getService(uint64 serviceId) external view returns (Service memory) {
        return _loadService(serviceId);
    }

    /// Internal: read a service or revert ServiceNotFound.
    /// A never-registered id has owner == address(0), which registerService can
    /// never produce (msg.sender is never the zero address).
    function _loadService(uint64 serviceId) internal view returns (Service storage s) {
        s = _services[serviceId];
        if (s.owner == address(0)) revert ServiceNotFound();
    }

    /// Block time in MILLISECONDS — the unit every off-chain reader expects.
    function _nowMs() internal view returns (uint64) {
        return uint64(block.timestamp) * 1000;
    }

    /// True when `s` is empty or contains only ASCII spaces/tabs/newlines —
    /// mirrors Rust's `str::trim().is_empty()` for the inputs this accepts.
    function _isBlank(string calldata s) internal pure returns (bool) {
        bytes calldata b = bytes(s);
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            if (c != 0x20 && c != 0x09 && c != 0x0a && c != 0x0d) return false;
        }
        return true;
    }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd contracts-evm && forge test -vv`
Expected: PASS — 9 tests in `AgentGateRegistryTest`.

- [ ] **Step 6: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"   # the worktree root — never a hardcoded checkout path
git add contracts-evm/foundry.toml contracts-evm/.gitignore \
        contracts-evm/src/AgentGateRegistry.sol contracts-evm/test/AgentGateRegistry.t.sol
git commit -m "feat(contracts-evm): AgentGateRegistry registration path in Solidity"
```

---

## Task 2: Registry attestations, scores, and admin entrypoints

**Files:**
- Modify: `contracts-evm/src/AgentGateRegistry.sol`
- Modify: `contracts-evm/test/AgentGateRegistry.t.sol`
- Reference (read, do not modify): `contracts/agentgate-registry/src/registry.rs:358-490`

**Interfaces:**
- Consumes: everything from Task 1.
- Produces: `recordAttestation(uint64,bytes32,bool)`, `setActive(uint64,bool)`, `setAttestor(uint64,address)`, `getScore(uint64) -> (uint64,uint64)`, `getAttestations(uint64) -> Attestation[]` (newest-first), `seenPayments(uint64,bytes32) -> bool`, events `AttestationRecorded` / `ServiceStatusChanged` / `ServiceAttestorChanged`.

- [ ] **Step 1: Write the failing tests**

Append to `contracts-evm/test/AgentGateRegistry.t.sol`, inside the contract:

```solidity
    function test_recordAttestation_bumpsScoreAndStoresNewestFirst() public {
        uint64 id = _register();
        vm.prank(attestor);
        reg.recordAttestation(id, bytes32(uint256(0xAA)), true);
        vm.prank(attestor);
        reg.recordAttestation(id, bytes32(uint256(0xBB)), false);

        (uint64 total, uint64 success) = reg.getScore(id);
        assertEq(total, 2);
        assertEq(success, 1);

        AgentGateRegistry.Attestation[] memory list = reg.getAttestations(id);
        assertEq(list.length, 2);
        assertEq(list[0].paymentTxHash, bytes32(uint256(0xBB))); // newest first
        assertFalse(list[0].success);
        assertEq(list[1].paymentTxHash, bytes32(uint256(0xAA)));
        assertEq(list[0].timestamp, 1_756_500_000_000);
    }

    function test_recordAttestation_ownerMayAlsoAttest() public {
        uint64 id = _register();
        vm.prank(owner);
        reg.recordAttestation(id, bytes32(uint256(1)), true);
        (uint64 total,) = reg.getScore(id);
        assertEq(total, 1);
    }

    function test_recordAttestation_revertsForStranger() public {
        uint64 id = _register();
        vm.expectRevert(AgentGateRegistry.NotAuthorized.selector);
        vm.prank(address(0xDEAD));
        reg.recordAttestation(id, bytes32(uint256(1)), true);
    }

    function test_recordAttestation_revertsOnDuplicatePaymentHash() public {
        uint64 id = _register();
        vm.prank(attestor);
        reg.recordAttestation(id, bytes32(uint256(7)), true);
        vm.expectRevert(AgentGateRegistry.DuplicateAttestation.selector);
        vm.prank(attestor);
        reg.recordAttestation(id, bytes32(uint256(7)), true);
    }

    function test_recordAttestation_samePaymentHashAllowedOnDifferentService() public {
        uint64 a = _register();
        uint64 b = _register();
        vm.prank(attestor);
        reg.recordAttestation(a, bytes32(uint256(7)), true);
        vm.prank(attestor);
        reg.recordAttestation(b, bytes32(uint256(7)), true); // must not revert
        (uint64 totalB,) = reg.getScore(b);
        assertEq(totalB, 1);
    }

    function test_recordAttestation_revertsWhenInactive() public {
        uint64 id = _register();
        vm.prank(owner);
        reg.setActive(id, false);
        vm.expectRevert(AgentGateRegistry.ServiceInactive.selector);
        vm.prank(attestor);
        reg.recordAttestation(id, bytes32(uint256(1)), true);
    }

    function test_recordAttestation_revertsForUnknownService() public {
        vm.expectRevert(AgentGateRegistry.ServiceNotFound.selector);
        vm.prank(attestor);
        reg.recordAttestation(42, bytes32(uint256(1)), true);
    }

    function test_getAttestations_capsAtMaxAndKeepsNewest() public {
        uint64 id = _register();
        for (uint256 i = 1; i <= 105; i++) {
            vm.prank(attestor);
            reg.recordAttestation(id, bytes32(i), true);
        }
        AgentGateRegistry.Attestation[] memory list = reg.getAttestations(id);
        assertEq(list.length, 100);
        assertEq(list[0].paymentTxHash, bytes32(uint256(105))); // newest
        assertEq(list[99].paymentTxHash, bytes32(uint256(6)));  // oldest kept

        // Counters keep FULL history even though the list is capped.
        (uint64 total, uint64 success) = reg.getScore(id);
        assertEq(total, 105);
        assertEq(success, 105);
    }

    function test_getScore_isZeroForUnknownService() public view {
        (uint64 total, uint64 success) = reg.getScore(999);
        assertEq(total, 0);
        assertEq(success, 0);
    }

    function test_getAttestations_isEmptyForUnknownService() public view {
        assertEq(reg.getAttestations(999).length, 0);
    }

    function test_setActive_ownerOnly_attestorMayNotToggle() public {
        uint64 id = _register();
        vm.expectRevert(AgentGateRegistry.NotAuthorized.selector);
        vm.prank(attestor);
        reg.setActive(id, false);

        vm.prank(owner);
        reg.setActive(id, false);
        assertFalse(reg.getService(id).active);

        vm.prank(owner);
        reg.setActive(id, true);
        assertTrue(reg.getService(id).active);
    }

    function test_setAttestor_ownerOnlyAndRotatesKey() public {
        uint64 id = _register();
        address rotated = address(0xF00D);

        vm.expectRevert(AgentGateRegistry.NotAuthorized.selector);
        vm.prank(attestor);
        reg.setAttestor(id, rotated);

        vm.prank(owner);
        reg.setAttestor(id, rotated);
        assertEq(reg.getService(id).attestor, rotated);

        // the rotated key can attest; the old one can no longer
        vm.prank(rotated);
        reg.recordAttestation(id, bytes32(uint256(1)), true);
        vm.expectRevert(AgentGateRegistry.NotAuthorized.selector);
        vm.prank(attestor);
        reg.recordAttestation(id, bytes32(uint256(2)), true);
    }
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd contracts-evm && forge test`
Expected: FAIL — `Member "recordAttestation" not found`.

- [ ] **Step 3: Implement**

Add to `contracts-evm/src/AgentGateRegistry.sol`, inside the contract body:

```solidity
    event AttestationRecorded(
        uint64 indexed serviceId,
        bytes32 indexed paymentTxHash,
        bool success,
        uint64 totalCalls,
        uint64 successCalls
    );
    event ServiceStatusChanged(uint64 indexed serviceId, bool active);
    event ServiceAttestorChanged(uint64 indexed serviceId, address attestor);

    /// serviceId => total calls recorded (full history; never capped).
    mapping(uint64 => uint64) public totalCalls;
    /// serviceId => successful calls recorded (full history; never capped).
    mapping(uint64 => uint64) public successCalls;
    /// serviceId => paymentTxHash => already attested? Duplicate guard.
    mapping(uint64 => mapping(bytes32 => bool)) public seenPayments;

    /// serviceId => ring buffer of the last MAX_ATTESTATIONS attestations.
    mapping(uint64 => Attestation[]) private _attestations;
    /// serviceId => next write slot in the ring (== oldest entry once full).
    mapping(uint64 => uint256) private _attHead;

    /// @notice Record the outcome of one paid call, identified by the payment tx
    ///         hash. Caller must be the service's attestor or owner.
    function recordAttestation(uint64 serviceId, bytes32 paymentTxHash, bool success)
        external
    {
        Service storage s = _loadService(serviceId);
        if (msg.sender != s.attestor && msg.sender != s.owner) revert NotAuthorized();
        if (!s.active) revert ServiceInactive();
        if (seenPayments[serviceId][paymentTxHash]) revert DuplicateAttestation();
        seenPayments[serviceId][paymentTxHash] = true;

        // Saturating: a (practically unreachable) overflow pins at MAX rather
        // than reverting and bricking the service's score forever.
        uint64 total = totalCalls[serviceId];
        uint64 succeeded = successCalls[serviceId];
        unchecked {
            total = total == type(uint64).max ? total : total + 1;
            if (success && succeeded != type(uint64).max) succeeded += 1;
        }
        totalCalls[serviceId] = total;
        successCalls[serviceId] = succeeded;

        _pushAttestation(
            serviceId,
            Attestation({
                paymentTxHash: paymentTxHash,
                success: success,
                timestamp: _nowMs()
            })
        );

        emit AttestationRecorded(serviceId, paymentTxHash, success, total, succeeded);
    }

    /// @notice Toggle a service's discovery flag. Owner only — the attestor may NOT.
    function setActive(uint64 serviceId, bool active) external {
        Service storage s = _loadService(serviceId);
        if (msg.sender != s.owner) revert NotAuthorized();
        s.active = active;
        emit ServiceStatusChanged(serviceId, active);
    }

    /// @notice Rotate the authorised attestor. Owner only. Lets an owner replace a
    ///         compromised middleware signer without re-registering (which would
    ///         mint a new id and reset the score).
    function setAttestor(uint64 serviceId, address attestor) external {
        Service storage s = _loadService(serviceId);
        if (msg.sender != s.owner) revert NotAuthorized();
        s.attestor = attestor;
        emit ServiceAttestorChanged(serviceId, attestor);
    }

    /// @notice (totalCalls, successCalls). (0, 0) for unknown or unattested services.
    function getScore(uint64 serviceId)
        external
        view
        returns (uint64 total, uint64 success)
    {
        return (totalCalls[serviceId], successCalls[serviceId]);
    }

    /// @notice The last (up to) MAX_ATTESTATIONS attestations, NEWEST FIRST.
    ///         Empty for unknown services.
    function getAttestations(uint64 serviceId)
        external
        view
        returns (Attestation[] memory out)
    {
        Attestation[] storage list = _attestations[serviceId];
        uint256 n = list.length;
        out = new Attestation[](n);
        if (n == 0) return out;
        uint256 head = _attHead[serviceId];
        for (uint256 i = 0; i < n; i++) {
            // newest sits at head-1; walk backwards, wrapping within n.
            out[i] = list[(head + n - 1 - i) % n];
        }
    }

    /// Append into the ring: grow until the cap, then overwrite the oldest slot.
    /// Constant-cost per call — no O(n) shifting, unlike the Odra Vec::insert(0).
    function _pushAttestation(uint64 serviceId, Attestation memory a) internal {
        Attestation[] storage list = _attestations[serviceId];
        if (list.length < MAX_ATTESTATIONS) {
            list.push(a);
        } else {
            list[_attHead[serviceId]] = a;
        }
        _attHead[serviceId] = (_attHead[serviceId] + 1) % MAX_ATTESTATIONS;
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd contracts-evm && forge test -vv`
Expected: PASS — 21 tests.

- [ ] **Step 5: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"   # the worktree root — never a hardcoded checkout path
git add contracts-evm/src/AgentGateRegistry.sol contracts-evm/test/AgentGateRegistry.t.sol
git commit -m "feat(contracts-evm): registry attestations, scores and admin entrypoints"
```

---

## Task 3: PaymentRouter

**Files:**
- Create: `contracts-evm/src/PaymentRouter.sol`
- Test: `contracts-evm/test/PaymentRouter.t.sol`

**Interfaces:**
- Produces: `pay(uint64 serviceId, uint256 nonce, address payTo) payable`, `seenNonce(bytes32) -> bool`, `nonceKey(uint64,uint256) -> bytes32`, `event Paid(uint64 indexed serviceId, uint256 indexed nonce, address indexed payer, address payTo, uint256 amount, uint64 timestamp)`, errors `ZeroAmount()` / `DuplicateNonce()` / `TransferFailed()` / `ZeroPayTo()`.
- Consumed by Task 10 (`Live0gClient.transfer`) and Task 11 (`verifyTransfer` via `eth_getLogs`).

- [ ] **Step 1: Write the failing test**

Create `contracts-evm/test/PaymentRouter.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";

/// Refuses every incoming transfer — exercises the TransferFailed path.
contract RejectingPayee {
    receive() external payable {
        revert("nope");
    }
}

contract PaymentRouterTest is Test {
    PaymentRouter internal router;
    address internal buyer = address(0xB0B);
    address internal payTo = address(0xCAFE);

    function setUp() public {
        router = new PaymentRouter();
        vm.warp(1_756_500_000);
        vm.deal(buyer, 10 ether);
    }

    function test_pay_forwardsValueAndEmitsPaid() public {
        vm.expectEmit(true, true, true, true);
        emit PaymentRouter.Paid(
            7, 12345, buyer, payTo, 1e15, 1_756_500_000_000
        );
        vm.prank(buyer);
        router.pay{value: 1e15}(7, 12345, payTo);

        assertEq(payTo.balance, 1e15);
        assertEq(address(router).balance, 0); // router never holds funds
    }

    function test_pay_revertsOnZeroValue() public {
        vm.expectRevert(PaymentRouter.ZeroAmount.selector);
        vm.prank(buyer);
        router.pay{value: 0}(7, 1, payTo);
    }

    function test_pay_revertsOnZeroPayTo() public {
        vm.expectRevert(PaymentRouter.ZeroPayTo.selector);
        vm.prank(buyer);
        router.pay{value: 1e15}(7, 1, address(0));
    }

    function test_pay_revertsOnReplayedNonce() public {
        vm.prank(buyer);
        router.pay{value: 1e15}(7, 99, payTo);
        vm.expectRevert(PaymentRouter.DuplicateNonce.selector);
        vm.prank(buyer);
        router.pay{value: 1e15}(7, 99, payTo);
    }

    function test_pay_sameNonceOnDifferentServiceIsAllowed() public {
        vm.prank(buyer);
        router.pay{value: 1e15}(7, 99, payTo);
        vm.prank(buyer);
        router.pay{value: 1e15}(8, 99, payTo); // must not revert
        assertEq(payTo.balance, 2e15);
    }

    function test_pay_revertsWhenPayeeRejects() public {
        RejectingPayee bad = new RejectingPayee();
        vm.expectRevert(PaymentRouter.TransferFailed.selector);
        vm.prank(buyer);
        router.pay{value: 1e15}(7, 1, address(bad));
    }

    function test_pay_nonceStaysUnburnedWhenTransferFails() public {
        RejectingPayee bad = new RejectingPayee();
        vm.prank(buyer);
        try router.pay{value: 1e15}(7, 55, address(bad)) {} catch {}
        // the whole call reverted, so the nonce must still be spendable
        assertFalse(router.seenNonce(router.nonceKey(7, 55)));
        vm.prank(buyer);
        router.pay{value: 1e15}(7, 55, payTo);
        assertEq(payTo.balance, 1e15);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd contracts-evm && forge test --match-contract PaymentRouterTest`
Expected: FAIL — `Source "src/PaymentRouter.sol" not found`.

- [ ] **Step 3: Implement**

Create `contracts-evm/src/PaymentRouter.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title PaymentRouter — binds an x402 invoice nonce to an on-chain payment
/// @notice Casper's native transfers carry a `transfer_id` that binds a payment
///         to the 402 invoice that requested it. EVM native transfers carry no
///         such field, so payments are routed through this contract instead:
///         `pay()` forwards the full value to the seller and emits `Paid` with
///         the invoice nonce indexed, which is what the gateway matches on.
///         The router never custodies funds — value in, value straight out.
contract PaymentRouter {
    error ZeroAmount();
    error ZeroPayTo();
    error DuplicateNonce();
    error TransferFailed();

    /// @notice Emitted on every settled payment. `serviceId` and `nonce` are
    ///         indexed so the gateway's verification is a single exact-match
    ///         eth_getLogs — no block scanning, no external indexer.
    event Paid(
        uint64 indexed serviceId,
        uint256 indexed nonce,
        address indexed payer,
        address payTo,
        uint256 amount,
        uint64 timestamp // unix MS
    );

    /// keccak(serviceId, nonce) => already paid? On-chain replay guard, in
    /// addition to the gateway's own single-use invoice burn.
    mapping(bytes32 => bool) public seenNonce;

    /// @notice The `seenNonce` key for a (serviceId, nonce) pair.
    function nonceKey(uint64 serviceId, uint256 nonce) public pure returns (bytes32) {
        return keccak256(abi.encode(serviceId, nonce));
    }

    /// @notice Pay a service's 402 invoice. The whole `msg.value` is forwarded
    ///         to `payTo`; the nonce is burned so the same invoice can never
    ///         settle twice.
    function pay(uint64 serviceId, uint256 nonce, address payTo) external payable {
        if (msg.value == 0) revert ZeroAmount();
        if (payTo == address(0)) revert ZeroPayTo();

        bytes32 key = nonceKey(serviceId, nonce);
        if (seenNonce[key]) revert DuplicateNonce();

        // Checks-effects-interactions: burn the nonce before the outbound call.
        // A failed transfer reverts the whole tx, which also rolls this back —
        // the nonce stays spendable, as test_pay_nonceStaysUnburned asserts.
        seenNonce[key] = true;

        (bool ok, ) = payTo.call{value: msg.value}("");
        if (!ok) revert TransferFailed();

        emit Paid(
            serviceId, nonce, msg.sender, payTo, msg.value, uint64(block.timestamp) * 1000
        );
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd contracts-evm && forge test --match-contract PaymentRouterTest -vv`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"   # the worktree root — never a hardcoded checkout path
git add contracts-evm/src/PaymentRouter.sol contracts-evm/test/PaymentRouter.t.sol
git commit -m "feat(contracts-evm): PaymentRouter binds x402 nonces to on-chain payments"
```

---

## Task 4: SpendGuard

**Files:**
- Create: `contracts-evm/src/SpendGuard.sol`
- Test: `contracts-evm/test/SpendGuard.t.sol`
- Reference (read, do not modify): `contracts/spend-guard/src/spend_guard.rs:147-372`

**Interfaces:**
- Produces: `openPolicy(address,uint256,uint256,uint64,uint32,uint8) -> uint64`, `deposit(uint64) payable`, `debit(uint64,uint64,uint256,address,bytes32,uint8)`, `withdraw(uint64,uint256)`, `pause(uint64,bool)`, `getPolicy(uint64) -> Policy`, `getRemaining(uint64) -> uint256`, `policiesCount() -> uint64`, events `PolicyOpened`/`Deposited`/`DebitApproved`/`PolicyPaused`/`Withdrawn`, 10 errors.

> **Revert order is normative.** `debit` must check in exactly this order:
> `PolicyNotFound → NotAuthorized → Paused → ZeroAmount → PerCallExceeded →
> UntrustedService → DuplicateRef → OverBudget → RateExceeded`.
> The Odra original documents it at `spend_guard.rs:225-230`; tests below pin it.

- [ ] **Step 1: Write the failing test**

Create `contracts-evm/test/SpendGuard.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SpendGuard} from "../src/SpendGuard.sol";

contract SpendGuardTest is Test {
    SpendGuard internal guard;

    address internal owner = address(0xA11CE);
    address internal gate = address(0x6A7E);
    address internal payTo = address(0xCAFE);

    uint256 internal constant BUDGET = 10 ether;
    uint256 internal constant PER_CALL = 1 ether;
    uint64 internal constant WINDOW_MS = 60_000;
    uint32 internal constant MAX_CALLS = 3;
    uint8 internal constant MIN_TIER = 2;

    function setUp() public {
        guard = new SpendGuard();
        vm.warp(1_756_500_000);
        vm.deal(owner, 100 ether);
    }

    function _open() internal returns (uint64 id) {
        vm.prank(owner);
        id = guard.openPolicy(gate, BUDGET, PER_CALL, WINDOW_MS, MAX_CALLS, MIN_TIER);
    }

    function _openFunded(uint256 amount) internal returns (uint64 id) {
        id = _open();
        vm.prank(owner);
        guard.deposit{value: amount}(id);
    }

    function test_openPolicy_storesConfigAndAssignsOneBasedId() public {
        uint64 id = _open();
        assertEq(id, 1);
        assertEq(guard.policiesCount(), 1);

        SpendGuard.Policy memory p = guard.getPolicy(id);
        assertEq(p.owner, owner);
        assertEq(p.gate, gate);
        assertEq(p.budget, BUDGET);
        assertEq(p.spent, 0);
        assertEq(p.balance, 0);
        assertEq(p.perCallCap, PER_CALL);
        assertEq(p.windowMs, WINDOW_MS);
        assertEq(p.maxCallsInWindow, MAX_CALLS);
        assertEq(p.minTrustTier, MIN_TIER);
        assertFalse(p.paused);
        assertEq(p.createdAt, 1_756_500_000_000);
    }

    function test_openPolicy_revertsOnInvalidConfig() public {
        vm.startPrank(owner);
        vm.expectRevert(SpendGuard.InvalidConfig.selector);
        guard.openPolicy(gate, BUDGET, 0, WINDOW_MS, MAX_CALLS, MIN_TIER); // zero cap
        vm.expectRevert(SpendGuard.InvalidConfig.selector);
        guard.openPolicy(gate, BUDGET, PER_CALL, WINDOW_MS, 0, MIN_TIER); // zero rate
        vm.expectRevert(SpendGuard.InvalidConfig.selector);
        guard.openPolicy(gate, 0, PER_CALL, WINDOW_MS, MAX_CALLS, MIN_TIER); // zero budget
        vm.expectRevert(SpendGuard.InvalidConfig.selector);
        guard.openPolicy(gate, 1 ether, 2 ether, WINDOW_MS, MAX_CALLS, MIN_TIER); // cap > budget
        vm.stopPrank();
    }

    function test_deposit_creditsEscrowAndAnyoneMayFund() public {
        uint64 id = _open();
        address stranger = address(0xD00D);
        vm.deal(stranger, 5 ether);
        vm.prank(stranger);
        guard.deposit{value: 2 ether}(id);
        assertEq(guard.getRemaining(id), 2 ether);
    }

    function test_deposit_revertsOnZeroAndUnknownPolicy() public {
        uint64 id = _open();
        vm.expectRevert(SpendGuard.ZeroAmount.selector);
        vm.prank(owner);
        guard.deposit{value: 0}(id);

        vm.expectRevert(SpendGuard.PolicyNotFound.selector);
        vm.prank(owner);
        guard.deposit{value: 1 ether}(99);
    }

    function test_debit_movesEscrowAndUpdatesCounters() public {
        uint64 id = _openFunded(5 ether);
        vm.prank(gate);
        guard.debit(id, 7, 1 ether, payTo, bytes32(uint256(1)), MIN_TIER);

        assertEq(payTo.balance, 1 ether);
        SpendGuard.Policy memory p = guard.getPolicy(id);
        assertEq(p.balance, 4 ether);
        assertEq(p.spent, 1 ether);
    }

    function test_debit_revertOrderIsNormative() public {
        uint64 id = _openFunded(5 ether);
        bytes32 ref = bytes32(uint256(1));

        // PolicyNotFound before NotAuthorized (stranger on a missing policy)
        vm.expectRevert(SpendGuard.PolicyNotFound.selector);
        vm.prank(address(0xDEAD));
        guard.debit(99, 7, 1 ether, payTo, ref, MIN_TIER);

        // NotAuthorized before Paused (unpaused policy, wrong caller)
        vm.expectRevert(SpendGuard.NotAuthorized.selector);
        vm.prank(address(0xDEAD));
        guard.debit(id, 7, 1 ether, payTo, ref, MIN_TIER);

        // Paused before ZeroAmount (paused policy, zero amount)
        vm.prank(owner);
        guard.pause(id, true);
        vm.expectRevert(SpendGuard.Paused.selector);
        vm.prank(gate);
        guard.debit(id, 7, 0, payTo, ref, MIN_TIER);
        vm.prank(owner);
        guard.pause(id, false);

        // ZeroAmount before PerCallExceeded
        vm.expectRevert(SpendGuard.ZeroAmount.selector);
        vm.prank(gate);
        guard.debit(id, 7, 0, payTo, ref, MIN_TIER);

        // PerCallExceeded before UntrustedService (over cap AND untrusted)
        vm.expectRevert(SpendGuard.PerCallExceeded.selector);
        vm.prank(gate);
        guard.debit(id, 7, 2 ether, payTo, ref, 0);

        // UntrustedService before DuplicateRef
        vm.expectRevert(SpendGuard.UntrustedService.selector);
        vm.prank(gate);
        guard.debit(id, 7, 1 ether, payTo, ref, MIN_TIER - 1);

        // DuplicateRef before OverBudget
        vm.prank(gate);
        guard.debit(id, 7, 1 ether, payTo, ref, MIN_TIER); // burn the ref
        vm.expectRevert(SpendGuard.DuplicateRef.selector);
        vm.prank(gate);
        guard.debit(id, 7, 1 ether, payTo, ref, MIN_TIER);
    }

    function test_debit_revertsOverEscrowBalance() public {
        uint64 id = _openFunded(0.5 ether);
        vm.expectRevert(SpendGuard.OverBudget.selector);
        vm.prank(gate);
        guard.debit(id, 7, 1 ether, payTo, bytes32(uint256(1)), MIN_TIER);
    }

    function test_debit_revertsOverCumulativeBudget() public {
        // budget 2 ether, cap 1 ether, escrow 5 ether: the 3rd call breaches budget
        vm.prank(owner);
        uint64 id = guard.openPolicy(gate, 2 ether, 1 ether, WINDOW_MS, 10, 0);
        vm.prank(owner);
        guard.deposit{value: 5 ether}(id);

        vm.prank(gate);
        guard.debit(id, 7, 1 ether, payTo, bytes32(uint256(1)), 0);
        vm.prank(gate);
        guard.debit(id, 7, 1 ether, payTo, bytes32(uint256(2)), 0);
        vm.expectRevert(SpendGuard.OverBudget.selector);
        vm.prank(gate);
        guard.debit(id, 7, 1 ether, payTo, bytes32(uint256(3)), 0);
    }

    function test_debit_rateWindowBlocksThenReopens() public {
        uint64 id = _openFunded(10 ether);
        for (uint256 i = 1; i <= MAX_CALLS; i++) {
            vm.prank(gate);
            guard.debit(id, 7, 0.1 ether, payTo, bytes32(i), MIN_TIER);
        }
        vm.expectRevert(SpendGuard.RateExceeded.selector);
        vm.prank(gate);
        guard.debit(id, 7, 0.1 ether, payTo, bytes32(uint256(99)), MIN_TIER);

        // roll past the window (windowMs is MS; block.timestamp is SECONDS)
        vm.warp(block.timestamp + (WINDOW_MS / 1000) + 1);
        vm.prank(gate);
        guard.debit(id, 7, 0.1 ether, payTo, bytes32(uint256(100)), MIN_TIER);
    }

    function test_withdraw_ownerOnlyAndWorksWhilePaused() public {
        uint64 id = _openFunded(3 ether);
        vm.expectRevert(SpendGuard.NotAuthorized.selector);
        vm.prank(gate);
        guard.withdraw(id, 1 ether);

        vm.prank(owner);
        guard.pause(id, true); // withdraw is the recovery path after the kill-switch
        uint256 before = owner.balance;
        vm.prank(owner);
        guard.withdraw(id, 1 ether);
        assertEq(owner.balance, before + 1 ether);
        assertEq(guard.getRemaining(id), 2 ether);
    }

    function test_withdraw_revertsOverBalanceAndOnZero() public {
        uint64 id = _openFunded(1 ether);
        vm.expectRevert(SpendGuard.OverBudget.selector);
        vm.prank(owner);
        guard.withdraw(id, 2 ether);
        vm.expectRevert(SpendGuard.ZeroAmount.selector);
        vm.prank(owner);
        guard.withdraw(id, 0);
    }

    function test_pause_ownerOnly() public {
        uint64 id = _open();
        vm.expectRevert(SpendGuard.NotAuthorized.selector);
        vm.prank(gate);
        guard.pause(id, true);
        vm.prank(owner);
        guard.pause(id, true);
        assertTrue(guard.getPolicy(id).paused);
    }

    function test_getRemaining_isZeroForUnknownPolicy() public view {
        assertEq(guard.getRemaining(999), 0);
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd contracts-evm && forge test --match-contract SpendGuardTest`
Expected: FAIL — `Source "src/SpendGuard.sol" not found`.

- [ ] **Step 3: Implement**

Create `contracts-evm/src/SpendGuard.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title SpendGuard — on-chain x402 spend-firewall escrow
/// @notice EVM port of contracts/spend-guard. An agent opens a Policy and
///         pre-funds an escrow; before serving a paid call the policy's `gate`
///         calls `debit`, which enforces every rule on-chain and reverts
///         atomically on any violation, so the payment never settles.
///         All timestamps are UNIX MILLISECONDS, matching `windowMs`.
contract SpendGuard {
    /// Trust tiers are a small 0..=255 scale; the score's source is off-chain
    /// (the registry's success/total ratio, bucketed).
    struct Policy {
        address owner;
        address gate;
        uint256 budget;
        uint256 spent;
        uint256 balance;
        uint256 perCallCap;
        uint64 windowMs;
        uint32 maxCallsInWindow;
        uint8 minTrustTier;
        bool paused;
        uint64 createdAt; // unix MS
    }

    error PolicyNotFound();
    error NotAuthorized();
    error Paused();
    error ZeroAmount();
    error PerCallExceeded();
    error UntrustedService();
    error DuplicateRef();
    error OverBudget();
    error RateExceeded();
    error InvalidConfig();
    error TransferFailed();

    event PolicyOpened(
        uint64 indexed policyId,
        address indexed owner,
        address indexed gate,
        uint256 budget,
        uint256 perCallCap,
        uint64 windowMs,
        uint32 maxCallsInWindow,
        uint8 minTrustTier
    );
    event Deposited(uint64 indexed policyId, uint256 amount, uint256 newBalance);
    /// Emitted only on an APPROVED debit. A blocked debit reverts and emits
    /// nothing — the failed tx itself is the on-chain "blocked" signal.
    event DebitApproved(
        uint64 indexed policyId,
        uint64 indexed serviceId,
        uint256 amount,
        address payTo,
        bytes32 paymentRef,
        uint256 remaining
    );
    event PolicyPaused(uint64 indexed policyId, bool paused);
    event Withdrawn(uint64 indexed policyId, uint256 amount, uint256 remaining);

    /// Number of policies opened; ids are 1-based (1..=policiesCount).
    uint64 public policiesCount;

    mapping(uint64 => Policy) private _policies;
    /// policyId => paymentRef => already debited? Replay guard.
    mapping(uint64 => mapping(bytes32 => bool)) public seenRefs;
    /// policyId => approved-debit timestamps (ms) inside the live rate window.
    mapping(uint64 => uint64[]) private _callTimes;

    /// @notice Open a spend policy; the caller becomes its owner.
    function openPolicy(
        address gate,
        uint256 budget,
        uint256 perCallCap,
        uint64 windowMs,
        uint32 maxCallsInWindow,
        uint8 minTrustTier
    ) external returns (uint64 policyId) {
        // A policy that could accept deposits but never debit is a funds trap.
        if (perCallCap == 0 || maxCallsInWindow == 0 || budget == 0 || perCallCap > budget) {
            revert InvalidConfig();
        }

        policyId = policiesCount + 1;
        _policies[policyId] = Policy({
            owner: msg.sender,
            gate: gate,
            budget: budget,
            spent: 0,
            balance: 0,
            perCallCap: perCallCap,
            windowMs: windowMs,
            maxCallsInWindow: maxCallsInWindow,
            minTrustTier: minTrustTier,
            paused: false,
            createdAt: _nowMs()
        });
        policiesCount = policyId;

        emit PolicyOpened(
            policyId, msg.sender, gate, budget, perCallCap, windowMs,
            maxCallsInWindow, minTrustTier
        );
    }

    /// @notice Top up a policy's escrow. Anyone may fund.
    function deposit(uint64 policyId) external payable {
        Policy storage p = _loadPolicy(policyId);
        if (msg.value == 0) revert ZeroAmount();
        uint256 newBalance = p.balance + msg.value;
        p.balance = newBalance;
        emit Deposited(policyId, msg.value, newBalance);
    }

    /// @notice The firewall. The policy `gate` requests a spend; every rule is
    ///         enforced here and, only if ALL pass, `amount` moves from the
    ///         escrow to `payTo`. Any violation reverts and nothing moves.
    /// @dev Revert order is normative — see the design doc §8.
    function debit(
        uint64 policyId,
        uint64 serviceId,
        uint256 amount,
        address payTo,
        bytes32 paymentRef,
        uint8 trustTier
    ) external {
        Policy storage p = _loadPolicy(policyId);

        if (msg.sender != p.gate) revert NotAuthorized();
        if (p.paused) revert Paused();
        if (amount == 0) revert ZeroAmount();
        if (amount > p.perCallCap) revert PerCallExceeded();
        if (trustTier < p.minTrustTier) revert UntrustedService();
        if (seenRefs[policyId][paymentRef]) revert DuplicateRef();

        // Budget: must fit BOTH the escrow and the cumulative cap.
        uint256 newSpent = p.spent + amount;
        if (amount > p.balance || newSpent > p.budget) revert OverBudget();

        // Rate window: prune entries older than the window, then check the cap.
        // The age test (now - t < window) is underflow-safe and correct at t=0,
        // unlike a `t > now - window` cutoff which saturates.
        uint64 nowMs = _nowMs();
        uint64[] storage times = _callTimes[policyId];
        uint64[] memory kept = new uint64[](times.length);
        uint256 keptLen = 0;
        for (uint256 i = 0; i < times.length; i++) {
            if (nowMs - times[i] < p.windowMs) {
                kept[keptLen] = times[i];
                keptLen++;
            }
        }
        if (keptLen >= p.maxCallsInWindow) revert RateExceeded();

        // ── all checks passed: settle atomically ──
        // Checks-effects-interactions: every write lands before the transfer.
        uint256 remaining = p.balance - amount;
        p.balance = remaining;
        p.spent = newSpent;
        seenRefs[policyId][paymentRef] = true;

        // Rewrite the pruned window plus this call.
        while (times.length > keptLen) times.pop();
        for (uint256 i = 0; i < keptLen; i++) times[i] = kept[i];
        times.push(nowMs);

        (bool ok, ) = payTo.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit DebitApproved(policyId, serviceId, amount, payTo, paymentRef, remaining);
    }

    /// @notice Withdraw unspent escrow back to the owner. Owner only. Works
    ///         while paused, so it doubles as the post-kill-switch recovery path.
    function withdraw(uint64 policyId, uint256 amount) external {
        Policy storage p = _loadPolicy(policyId);
        if (msg.sender != p.owner) revert NotAuthorized();
        if (amount == 0) revert ZeroAmount();
        if (amount > p.balance) revert OverBudget();

        uint256 remaining = p.balance - amount;
        address to = p.owner;
        p.balance = remaining;

        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit Withdrawn(policyId, amount, remaining);
    }

    /// @notice Pause / unpause a policy. Owner only.
    function pause(uint64 policyId, bool paused) external {
        Policy storage p = _loadPolicy(policyId);
        if (msg.sender != p.owner) revert NotAuthorized();
        p.paused = paused;
        emit PolicyPaused(policyId, paused);
    }

    /// @notice Fetch a policy. Reverts PolicyNotFound if never opened.
    function getPolicy(uint64 policyId) external view returns (Policy memory) {
        return _loadPolicy(policyId);
    }

    /// @notice Escrow currently available for a policy (0 if unknown).
    function getRemaining(uint64 policyId) external view returns (uint256) {
        return _policies[policyId].balance;
    }

    function _loadPolicy(uint64 policyId) internal view returns (Policy storage p) {
        p = _policies[policyId];
        if (p.owner == address(0)) revert PolicyNotFound();
    }

    function _nowMs() internal view returns (uint64) {
        return uint64(block.timestamp) * 1000;
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd contracts-evm && forge test --match-contract SpendGuardTest -vv`
Expected: PASS — 13 tests.

- [ ] **Step 5: Run the whole suite and check gas**

Run: `cd contracts-evm && forge test && forge test --gas-report`
Expected: all 41 tests pass. Note `debit`'s gas — the rate-window rewrite is
O(window size); with `maxCallsInWindow` in the tens this is fine, and the config
validation caps nothing, so record the number for the deploy notes.

- [ ] **Step 6: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"   # the worktree root — never a hardcoded checkout path
git add contracts-evm/src/SpendGuard.sol contracts-evm/test/SpendGuard.t.sol
git commit -m "feat(contracts-evm): SpendGuard escrow spend-firewall in Solidity"
```

---

## Task 5: Deploy script and 0G Galileo deployment

**Files:**
- Create: `contracts-evm/script/Deploy.s.sol`, `contracts-evm/README.md`
- Modify: `.env.example`

**Interfaces:**
- Produces: three deployed addresses recorded in `contracts-evm/README.md` and wired into `.env.example` as `REGISTRY_CONTRACT_ADDRESS`, `PAYMENT_ROUTER_ADDRESS`, `SPEND_GUARD_ADDRESS`. Task 7 reads these env names; Task 10 uses the addresses.

- [ ] **Step 1: Verify the chain is reachable and the chain ID is 16602**

```bash
cast chain-id --rpc-url https://evmrpc-testnet.0g.ai
cast block latest --rpc-url https://evmrpc-testnet.0g.ai --field number
```

Expected: `16602` and a rising block number. **If the chain ID differs, stop and
update the design doc, `foundry.toml`, and the CAIP-2 value in Task 8 before
continuing.**

- [ ] **Step 2: Write the deploy script**

Create `contracts-evm/script/Deploy.s.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {AgentGateRegistry} from "../src/AgentGateRegistry.sol";
import {PaymentRouter} from "../src/PaymentRouter.sol";
import {SpendGuard} from "../src/SpendGuard.sol";

/// Deploys the full AgentGate contract set and prints the addresses to paste
/// into .env / contracts-evm/README.md.
///   forge script script/Deploy.s.sol:Deploy \
///     --rpc-url $ZG_RPC_URL --private-key $DEPLOYER_KEY --broadcast
contract Deploy is Script {
    function run() external {
        vm.startBroadcast();
        AgentGateRegistry registry = new AgentGateRegistry();
        PaymentRouter router = new PaymentRouter();
        SpendGuard guard = new SpendGuard();
        vm.stopBroadcast();

        console.log("REGISTRY_CONTRACT_ADDRESS=%s", address(registry));
        console.log("PAYMENT_ROUTER_ADDRESS=%s", address(router));
        console.log("SPEND_GUARD_ADDRESS=%s", address(guard));
    }
}
```

- [ ] **Step 3: Dry-run against a local fork**

```bash
cd contracts-evm
anvil --fork-url https://evmrpc-testnet.0g.ai --port 8545 &
sleep 5
# Anvil prints its deterministic dev accounts and their keys on startup.
# Copy Account #0's key from that banner rather than hardcoding it here — a bare
# 64-hex string after --private-key trips secret scanners in a tracked file.
export ANVIL_ACCOUNT_0_KEY=<paste from the anvil banner>
forge script script/Deploy.s.sol:Deploy --rpc-url http://127.0.0.1:8545 \
  --private-key "$ANVIL_ACCOUNT_0_KEY" --broadcast
kill %1
```

Expected: three addresses printed, no revert. This proves the bytecode deploys
under 0G's actual EVM config before spending faucet funds.

- [ ] **Step 4: Fund the deployer and deploy for real**

Ask the user to fund the deployer address at `https://faucet.0g.ai` (0.1
OG/wallet/day — request early; if 0.1 OG is not enough for three deploys,
deploy across two days or use a second funded wallet).

```bash
cd contracts-evm
export ZG_RPC_URL=https://evmrpc-testnet.0g.ai
forge script script/Deploy.s.sol:Deploy --rpc-url "$ZG_RPC_URL" \
  --private-key "$DEPLOYER_KEY" --broadcast
```

Expected: three addresses + tx hashes. Verify each on
`https://chainscan-galileo.0g.ai/address/<addr>`.

- [ ] **Step 5: Record the addresses**

Write `contracts-evm/README.md` documenting: what each contract does, the
deployed addresses with explorer links, the chain ID, how to run `forge test`,
and how to redeploy. Then update `.env.example`:

```bash
cd "$(git rev-parse --show-toplevel)"   # the worktree root — never a hardcoded checkout path
python3 - <<'PY'
import re, pathlib
p = pathlib.Path('.env.example')
s = p.read_text()
casper_block = re.search(
    r'# --- live mode \(Casper Testnet\).*?SELLER_SIGNER_PEM_PATH=.*?\n', s, re.S)
new = """# --- live mode (0G Galileo Testnet) ---
ZG_RPC_URL=https://evmrpc-testnet.0g.ai
ZG_CHAIN_ID=16602
ZG_NETWORK=0g-galileo
ZG_EXPLORER_URL=https://chainscan-galileo.0g.ai
REGISTRY_CONTRACT_ADDRESS=
PAYMENT_ROUTER_ADDRESS=
SPEND_GUARD_ADDRESS=
ACTIVITY_LOOKBACK_BLOCKS=50000
GATE_SIGNER_KEY=                              # middleware/attestor key (0x + 64 hex) -- NEVER commit
BUYER_SIGNER_KEY=                             # buyer key -- buyer agent + `agentgate buy` (also via --key)
SELLER_SIGNER_KEY=                            # CLI / seller key
"""
assert casper_block, "Casper live-mode block not found in .env.example"
p.write_text(s.replace(casper_block.group(0), new))
PY
grep -n "FACILITATOR\|CSPR\|CASPER\|PEM" .env.example
```

Then delete every line the `grep` above still prints (the `FACILITATOR_*` block
and its comments — the facilitator rail is dropped per design doc §3).

- [ ] **Step 6: Commit**

```bash
git add contracts-evm/script/Deploy.s.sol contracts-evm/README.md .env.example
git commit -m "feat(contracts-evm): deploy script + 0G Galileo deployment addresses"
```

---

## Task 6: Units — motes (9 dp) to wei (18 dp)

**Files:**
- Modify: `packages/shared/src/money.ts` (full rewrite of the CSPR-specific half)
- Modify: `packages/shared/src/index.ts` (re-exports)
- Modify: `packages/shared/test/money.test.ts`
- Modify (call sites): every file the `rg` in Step 4 lists

**Interfaces:**
- Produces: `WEI_PER_OG`, `parseWei(Wei) -> bigint`, `ogToWei(string) -> Wei`, `weiToOg(Wei) -> string`, `formatOg(Wei) -> string`, `addWei`, `compareWei`. `formatUnits(atomic, decimals)` and `formatToken(atomic, decimals, symbol)` keep their exact current signatures.
- Consumed by: Tasks 7, 10, 11, 12, 14, 15.

- [ ] **Step 1: Write the failing test**

Replace the CSPR cases in `packages/shared/test/money.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import {
  WEI_PER_OG, parseWei, ogToWei, weiToOg, formatOg, addWei, compareWei,
  formatUnits, formatToken,
} from '../src/money';

describe('money (18 decimals)', () => {
  it('WEI_PER_OG is 1e18', () => {
    expect(WEI_PER_OG).toBe(1_000_000_000_000_000_000n);
  });

  it('ogToWei converts whole and fractional OG', () => {
    expect(ogToWei('1')).toBe('1000000000000000000');
    expect(ogToWei('0.5')).toBe('500000000000000000');
    expect(ogToWei('0.000001')).toBe('1000000000000'); // the MIN_PRICE_WEI floor
    expect(ogToWei('0')).toBe('0');
  });

  it('ogToWei accepts exactly 18 decimal places and rejects 19', () => {
    expect(ogToWei('0.000000000000000001')).toBe('1');
    expect(() => ogToWei('0.0000000000000000001')).toThrow(/18 decimal places/);
  });

  it('weiToOg trims trailing zeros', () => {
    expect(weiToOg('1500000000000000000')).toBe('1.5');
    expect(weiToOg('1000000000000000000')).toBe('1');
    expect(weiToOg('0')).toBe('0');
  });

  it('formatOg appends the symbol', () => {
    expect(formatOg('500000000000000000')).toBe('0.5 OG');
  });

  it('round-trips through bigint without float loss', () => {
    const wei = '123456789012345678';
    expect(ogToWei(weiToOg(wei))).toBe(wei);
  });

  it('rejects negatives, exponents and non-numeric input', () => {
    for (const bad of ['-1', '1e18', 'abc', '', ' ']) {
      expect(() => ogToWei(bad)).toThrow();
    }
  });

  it('parseWei rejects anything but a non-negative integer decimal string', () => {
    expect(parseWei('42')).toBe(42n);
    for (const bad of ['-1', '1.5', '0x10', '']) {
      expect(() => parseWei(bad)).toThrow();
    }
  });

  it('addWei and compareWei are bigint-exact', () => {
    expect(addWei('1', '2')).toBe('3');
    expect(compareWei('2', '10')).toBe(-1); // numeric, not lexicographic
    expect(compareWei('10', '10')).toBe(0);
    expect(compareWei('10', '2')).toBe(1);
  });

  it('formatUnits and formatToken are unchanged and decimals-parametric', () => {
    expect(formatUnits('100000000', 9)).toBe('0.1');
    expect(formatToken('1000000', 6, 'USDC')).toBe('1 USDC');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/shared/test/money.test.ts`
Expected: FAIL — `No "WEI_PER_OG" export is defined`.

- [ ] **Step 3: Implement**

In `packages/shared/src/money.ts`, apply exactly these replacements. Structure,
guards and JSDoc style stay as they are — only the unit changes.

```ts
/** 1 OG = 1e18 wei. */
export const WEI_PER_OG = 1_000_000_000_000_000_000n;

/** Max decimal places an OG amount may carry (wei precision). */
const MAX_OG_DECIMALS = 18;

const OG_RE = /^(\d+)(?:\.(\d+))?$/;
const WEI_RE = /^\d+$/;
```

Then rename, keeping every body identical apart from the constants:
`parseMotes`→`parseWei` (uses `WEI_RE`), `csprToMotes`→`ogToWei` (uses `OG_RE`,
`MAX_OG_DECIMALS`, `WEI_PER_OG`), `motesToCspr`→`weiToOg`, `addMotes`→`addWei`,
`compareMotes`→`compareWei`, and:

```ts
/** Human-readable OG amount, e.g. formatOg("500000000000000000") === "0.5 OG". */
export function formatOg(w: Wei): string {
  return `${weiToOg(w)} OG`;
}
```

The error message inside `ogToWei` must read
`at most ${MAX_OG_DECIMALS} decimal places (1 wei = 1e-18 OG)`.
`formatUnits` and `formatToken` keep their bodies verbatim, changing only the
internal `parseMotes(` call to `parseWei(`.

- [ ] **Step 4: Update every call site**

```bash
cd "$(git rev-parse --show-toplevel)"   # the worktree root — never a hardcoded checkout path
rg -l 'parseMotes|csprToMotes|motesToCspr|formatCspr|addMotes|compareMotes|MOTES_PER_CSPR' \
  packages dashboard scripts e2e --glob '!node_modules'
```

For each file, apply the rename table from design doc §4. `Motes` → `Wei` is
handled in Task 7; here rename only the **functions and constants**. Where a
variable is named `motes`/`amountMotes` locally, rename to `wei`/`amountWei` in
the same pass so nothing reads as a leftover.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run typecheck && npx vitest run`
Expected: PASS. `typecheck` will still flag `Motes` in `types.ts` — that is
Task 7's job **only if** you left the `Motes` type alias in place; keep
`export type Motes = string` temporarily in `types.ts` so this task lands green,
and delete it in Task 7.

- [ ] **Step 6: Commit**

```bash
git add -A packages dashboard scripts e2e
git commit -m "refactor(money): motes (9dp) -> wei (18dp) for 0G native OG"
```

---

## Task 7: Address model, signer refs and config

**Files:**
- Modify: `packages/shared/src/types.ts` (whole file)
- Modify: `packages/shared/src/config.ts:11-77, 208-299`
- Modify: `packages/shared/test/config.test.ts`
- Create: `packages/chain/src/address.ts`
- Test: `packages/chain/test/address.test.ts`

**Interfaces:**
- Produces:
  - `type Wei = string` (replaces `Motes`); `ServiceRecord.priceWei`, `.paymentTarget: string /* 0x… */`, `.owner`, `.attestor`; `AttestationRecord.paymentTxHash` (was `paymentDeployHash`); `ActivityEvent.amountWei`; `VerifyTransferQuery { txHash, serviceId, expectedTarget, minAmountWei, expectedNonce, maxAgeMs }`; `VerifyResult` gains no new variants.
  - `PaymentOption.asset: string` now holds `'native'` or a `0x…` ERC-20 address.
  - `type KeySignerRef = { kind: 'key'; privateKey: string }`; `AnySigner = SignerRef | KeySignerRef`.
  - `AgentGateConfig`: `zgRpcUrl`, `zgChainId`, `zgNetwork`, `zgExplorerUrl`, `registryContractAddress`, `paymentRouterAddress`, `spendGuardAddress`, `activityLookbackBlocks`, `gateSignerKey`, `buyerSignerKey`, `sellerSignerKey`, `buyerBudgetOg`. **Removed:** every `casper*`, `csprCloud*`, `*PemPath`, `facilitator*`, `buyerKeyAlgo` field.
  - `normalizeAddress(s) -> string` (lowercased `0x…`, throws on malformed), `isAddress(s) -> boolean`, `sameAddress(a, b) -> boolean`, `shortAddress(s) -> string` in `packages/chain/src/address.ts`.
- Consumed by: Tasks 8–15.

- [ ] **Step 1: Install viem**

```bash
cd "$(git rev-parse --show-toplevel)"   # the worktree root — never a hardcoded checkout path
npm i viem@^2.21.0 -w @agentgate/chain
```

- [ ] **Step 2: Write the failing address test**

Create `packages/chain/test/address.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { normalizeAddress, isAddress, sameAddress, shortAddress } from '../src/address';

const A = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

describe('address helpers', () => {
  it('normalizeAddress lowercases a checksummed address', () => {
    expect(normalizeAddress(A)).toBe(A.toLowerCase());
  });

  it('normalizeAddress accepts an already-lowercase address', () => {
    expect(normalizeAddress(A.toLowerCase())).toBe(A.toLowerCase());
  });

  it('normalizeAddress throws on malformed input', () => {
    for (const bad of ['', '0x', 'account-hash-' + 'ab'.repeat(32), '0x123', A.slice(0, -1)]) {
      expect(() => normalizeAddress(bad)).toThrow();
    }
  });

  it('isAddress never throws and mirrors normalizeAddress', () => {
    expect(isAddress(A)).toBe(true);
    expect(isAddress('nope')).toBe(false);
  });

  it('sameAddress compares case-insensitively', () => {
    expect(sameAddress(A, A.toLowerCase())).toBe(true);
    expect(sameAddress(A, '0x' + '0'.repeat(40))).toBe(false);
  });

  it('sameAddress is false for malformed input instead of throwing', () => {
    expect(sameAddress('nope', A)).toBe(false);
  });

  it('shortAddress truncates for display', () => {
    expect(shortAddress(A)).toBe('0x5aAeb6…eAed');
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run packages/chain/test/address.test.ts`
Expected: FAIL — cannot resolve `../src/address`.

- [ ] **Step 4: Implement `packages/chain/src/address.ts`**

```ts
import { AgentGateError } from '@agentgate/shared';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Canonical internal form for an EVM address: lowercased `0x` + 40 hex.
 * Every comparison and map key in AgentGate uses this form; checksummed
 * (EIP-55) casing is a display concern only. Throws on anything malformed —
 * this is the single validation gate for addresses entering the system.
 */
export function normalizeAddress(value: string): string {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value.trim())) {
    throw new AgentGateError(
      'INVALID_ADDRESS',
      `not an EVM address: ${JSON.stringify(value)}`,
      400,
    );
  }
  return value.trim().toLowerCase();
}

/** Non-throwing predicate form of {@link normalizeAddress}. */
export function isAddress(value: string): boolean {
  return typeof value === 'string' && ADDRESS_RE.test(value.trim());
}

/** Case-insensitive address equality. Malformed input compares false, never throws. */
export function sameAddress(a: string, b: string): boolean {
  if (!isAddress(a) || !isAddress(b)) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Display form: `0x5aAeb6…eAed`. Returns the input unchanged if malformed. */
export function shortAddress(value: string): string {
  if (!isAddress(value)) return value;
  const v = value.trim();
  return `${v.slice(0, 8)}…${v.slice(-4)}`;
}
```

- [ ] **Step 5: Rewrite `packages/shared/src/types.ts`**

Apply exactly these changes, keeping every JSDoc block updated to match:

- Line 1-2: `Motes` → `Wei`, doc becomes
  `/** All money values are wei of native OG as decimal strings (1 OG = 1e18 wei). U512-safe via bigint. */`
- `PaymentOption.asset` doc: `'native'` for OG, otherwise a `0x…` ERC-20 address.
- `ServiceRecord`: `priceMotes` → `priceWei`; `paymentTarget` / `owner` / `attestor`
  docs become `"0x<40hex>"`.
- `AttestationRecord.paymentDeployHash` → `paymentTxHash` (`"0x<64hex>"`).
- `ActivityEvent.amountMotes` → `amountWei`.
- `RegisterServiceInput.priceMotes` → `priceWei`.
- `VerifyTransferQuery`: `deployHash` → `txHash`, `minAmountMotes` → `minAmountWei`,
  `expectedTransferId` → `expectedNonce`, **plus a new `serviceId: number`**. The
  nonce is NOT globally unique — `PaymentRouter.seenNonce` is keyed by
  `(serviceId, nonce)`, and this repo's own payment targets are shared across
  services (see the note at `packages/chain/src/live.ts:961`, "one gate
  account"). Without `serviceId` the on-chain proof cannot bind a payment to a
  service on its own, leaving that guarantee to the off-chain invoice store.
- `VerifyResult`: `amountMotes` → `amountWei`.
- Signer refs:

```ts
export interface SignerRef { kind: 'mock'; publicKey: string }   // mock
export interface KeySignerRef { kind: 'key'; privateKey: string } // live (0x + 64 hex)
export type AnySigner = SignerRef | KeySignerRef;
```

- `ChainClient`: `registerService`, `recordAttestation` (now
  `{ serviceId; paymentTxHash; success }`), `setActive`, and
  `transfer(input: { to: string; amountWei: Wei; nonce: string; serviceId: number }, signer)`
  → `Promise<{ txHash: string }>`. **Note the two changes to `transfer`:** it
  returns `txHash` (not `deployHash`), and it takes `serviceId` because the
  payment now goes through `PaymentRouter.pay(serviceId, nonce, payTo)`.

Delete the `Motes` alias you kept in Task 6.

- [ ] **Step 6: Rewrite the live-mode half of `packages/shared/src/config.ts`**

Replace `DEFAULT_REGISTRY_PACKAGE_HASH` (lines 10-17) with:

```ts
/**
 * The deployed AgentGateRegistry address on 0G Galileo Testnet.
 * Fill from contracts-evm/README.md after Task 5's deploy.
 */
export const DEFAULT_REGISTRY_ADDRESS = '';
export const DEFAULT_PAYMENT_ROUTER_ADDRESS = '';
export const DEFAULT_ZG_RPC_URL = 'https://evmrpc-testnet.0g.ai';
export const DEFAULT_ZG_CHAIN_ID = 16602;
export const DEFAULT_ZG_NETWORK = '0g-galileo';
export const DEFAULT_ZG_EXPLORER_URL = 'https://chainscan-galileo.0g.ai';
```

In `AgentGateConfig` (lines 55-76) replace the Casper block and the facilitator
block with the fields listed under **Interfaces** above. In `loadConfig`
(lines 208-299) replace the corresponding readers, and add a private-key reader:

```ts
const PRIVATE_KEY_RE = /^0x[0-9a-f]{64}$/i;

/**
 * Read a signer private key. Empty is allowed (read-only commands need no key);
 * anything present must be exactly 0x + 64 hex. NEVER include the value in the
 * error message — a malformed key must not leak into logs.
 */
function readPrivateKey(env: Env, key: string): string {
  const raw = readStr(env, key, '');
  if (raw === '') return '';
  if (!PRIVATE_KEY_RE.test(raw)) {
    throw configError(`${key} must be a 0x-prefixed 32-byte hex private key`);
  }
  return raw.toLowerCase();
}
```

Replace the live-mode guard (lines 259-268) — `CSPR_CLOUD_API_KEY` no longer
exists, so the only live-mode requirement left is the admin token:

```ts
  if (mode === 'live') {
    if (requireStrongAdminToken && adminToken === DEFAULT_ADMIN_TOKEN) {
      throw configError(
        'live mode refuses the default AGENTGATE_ADMIN_TOKEN — set a strong unique token',
      );
    }
    if (registryContractAddress !== '' && !/^0x[0-9a-f]{40}$/i.test(registryContractAddress)) {
      throw configError('REGISTRY_CONTRACT_ADDRESS must be a 0x-prefixed EVM address');
    }
  }
```

Drop the `requireCloudKey` option from `loadConfig`'s `opts` and from every
caller (`rg -n 'requireCloudKey' packages dashboard scripts`).

- [ ] **Step 7: Update `packages/shared/test/config.test.ts`**

Delete the `CSPR_CLOUD_API_KEY` and facilitator cases. Add:

```ts
  it('live mode no longer requires an indexer API key', () => {
    const cfg = loadConfig(
      { AGENTGATE_MODE: 'live', AGENTGATE_ADMIN_TOKEN: 'strong-token-xyz' },
      { requireStrongAdminToken: true },
    );
    expect(cfg.mode).toBe('live');
    expect(cfg.zgRpcUrl).toBe('https://evmrpc-testnet.0g.ai');
    expect(cfg.zgChainId).toBe(16602);
    expect(cfg.zgNetwork).toBe('0g-galileo');
  });

  it('rejects a malformed signer key without echoing it', () => {
    expect(() => loadConfig({ GATE_SIGNER_KEY: '0xdeadbeef' }))
      .toThrow(/GATE_SIGNER_KEY must be a 0x-prefixed 32-byte hex private key/);
    expect(() => loadConfig({ GATE_SIGNER_KEY: '0xdeadbeef' }))
      .not.toThrow(/deadbeef.*deadbeef/); // value never repeated back
  });

  it('rejects a non-address registry in live mode', () => {
    expect(() => loadConfig({
      AGENTGATE_MODE: 'live',
      AGENTGATE_ADMIN_TOKEN: 'strong-token-xyz',
      REGISTRY_CONTRACT_ADDRESS: 'hash-abc',
    })).toThrow(/REGISTRY_CONTRACT_ADDRESS/);
  });
```

- [ ] **Step 8: Run tests**

Run: `npx vitest run packages/chain/test/address.test.ts packages/shared/test/config.test.ts`
Expected: PASS. `npm run typecheck` will now fail loudly across `packages/chain/src/live.ts`,
`packages/client`, `packages/middleware`, `packages/cli` — that is expected and
is exactly the work of Tasks 9-14. **Do not fix those here.** Record the error
count so later tasks can watch it fall to zero.

- [ ] **Step 9: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/config.ts \
        packages/shared/test/config.test.ts packages/chain/src/address.ts \
        packages/chain/test/address.test.ts package.json package-lock.json
git commit -m "refactor(shared): EVM address model, key signers and 0G config"
```

---

## Task 8: x402 protocol fields

**Files:**
- Modify: `packages/shared/src/x402.ts`
- Modify: `packages/shared/test/x402.test.ts`

**Interfaces:**
- Produces: `X402_ASSET_OG = 'OG'`; `ZgPaymentExtra { nonce, serviceId, expiresAtMs, settlement: '0g-payment-router', router: string, nonceEncoding: 'uint256-decimal' }`; `ZgExactPayload { transaction: string /* 0x64hex */, transferId: string, from?: string }`; `toCaip2Network(chainId: number) -> \`eip155:${number}\``.
- **Removed:** `CasperPaymentExtra`, `CasperExactPayload`, `X402V2Requirements`, `X402V2Required`, `FacilitatorTokenMeta`, `FacilitatorServiceConfig`, `facilitatorConfigFromAccepts`, `payToFromAccountHash`, `X402_ASSET_CSPR`, `X402_VERSION_V2`.

- [ ] **Step 1: Write the failing test**

Replace the Casper cases in `packages/shared/test/x402.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  X402_VERSION, X402_SCHEME, X402_ASSET_OG, toCaip2Network,
  encodeXPayment, decodeXPayment,
} from '../src/x402';

const ROUTER = '0x' + '11'.repeat(20);
const TX = '0x' + 'ab'.repeat(32);

describe('x402 on 0G', () => {
  it('toCaip2Network builds eip155 identifiers', () => {
    expect(toCaip2Network(16602)).toBe('eip155:16602');
    expect(toCaip2Network(1)).toBe('eip155:1');
  });

  it('the constants describe the native OG rail', () => {
    expect(X402_VERSION).toBe(1);
    expect(X402_SCHEME).toBe('exact');
    expect(X402_ASSET_OG).toBe('OG');
  });

  it('round-trips an X-PAYMENT payload', () => {
    const payload = {
      x402Version: X402_VERSION,
      scheme: X402_SCHEME,
      network: '0g-galileo',
      payload: { transaction: TX, transferId: '12345', from: ROUTER },
    };
    expect(decodeXPayment(encodeXPayment(payload))).toEqual(payload);
  });

  it('rejects a payment whose transaction is not a 0x 32-byte hash', () => {
    for (const bad of ['ab'.repeat(32), '0xzz', '0x1234', '']) {
      const header = encodeXPayment({
        x402Version: X402_VERSION, scheme: X402_SCHEME, network: '0g-galileo',
        payload: { transaction: bad, transferId: '1' },
      });
      expect(() => decodeXPayment(header)).toThrow(/invalid X-PAYMENT/);
    }
  });

  it('rejects a non-numeric nonce', () => {
    const header = encodeXPayment({
      x402Version: X402_VERSION, scheme: X402_SCHEME, network: '0g-galileo',
      payload: { transaction: TX, transferId: 'abc' },
    });
    expect(() => decodeXPayment(header)).toThrow(/invalid X-PAYMENT/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/shared/test/x402.test.ts`
Expected: FAIL — `No "X402_ASSET_OG" export is defined`.

- [ ] **Step 3: Implement**

In `packages/shared/src/x402.ts`:

```ts
export const X402_VERSION = 1;
export const X402_SCHEME = 'exact';
export const X402_ASSET_OG = 'OG';

/** 0G-specific requirement data. `nonce` MUST be passed to PaymentRouter.pay(). */
export interface ZgPaymentExtra {
  nonce: string;
  serviceId: number;
  expiresAtMs: number;
  settlement: '0g-payment-router';
  /** The PaymentRouter address the buyer must call. */
  router: string;
  nonceEncoding: 'uint256-decimal';
}

export interface ZgExactPayload {
  /** Tx hash of the settled PaymentRouter.pay() call, `0x` + 64 hex. */
  transaction: string;
  /** The issued invoice nonce (decimal uint256 string). */
  transferId: string;
  /** Payer address, `0x` + 40 hex. */
  from?: string;
}

/** CAIP-2 network identifier, e.g. `eip155:16602`. */
export type Caip2Network = `eip155:${number}`;

/** chainId → CAIP-2. */
export function toCaip2Network(chainId: number): Caip2Network {
  return `eip155:${chainId}`;
}
```

Point `PaymentRequirements.extra` at `ZgPaymentExtra`, `PaymentRequirements.asset`
doc at `'OG'`, `PaymentRequirements.payTo` doc at `0x<40hex>`, and
`PaymentPayload.payload` at `ZgExactPayload`. Update the validation regexes:

```ts
const NONCE_RE = /^\d{1,78}$/;                 // uint256 decimal
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;      // was: bare 64-hex deploy hash
```

Delete `X402V2Requirements`, `X402V2Required`, `FacilitatorTokenMeta`,
`FacilitatorServiceConfig`, `facilitatorConfigFromAccepts`,
`payToFromAccountHash`, `X402_ASSET_CSPR`, `X402_VERSION_V2` and the
`ACCOUNT_HASH_RE` constant. Remove their re-exports from
`packages/shared/src/index.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/shared/test/x402.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/x402.ts packages/shared/src/index.ts packages/shared/test/x402.test.ts
git commit -m "refactor(x402): native OG rail on eip155:16602, drop the facilitator types"
```

---

## Task 9: ABIs and `Live0gClient` read path

**Files:**
- Create: `packages/chain/src/abi.ts`, `packages/chain/src/live-0g.ts`
- Test: `packages/chain/test/live-0g-reads.test.ts`
- Reference (read, do not modify): `packages/chain/src/live.ts:888-956` (the read methods being replaced)

**Interfaces:**
- Consumes: `normalizeAddress`/`sameAddress` (Task 7), `Wei`/`ServiceRecord`/`ChainClient` (Task 7).
- Produces: `REGISTRY_ABI`, `PAYMENT_ROUTER_ABI`, `SPEND_GUARD_ABI` (viem `as const` tuples); `class Live0gClient implements ChainClient` with `network`, `ping`, `getService`, `listServices`, `getScore`, `listAttestations`, `getBalance` implemented. Write methods land in Task 10 — stub them with `throw new AgentGateError('NOT_IMPLEMENTED', …)` so the class typechecks.

- [ ] **Step 1: Generate the ABIs from the compiled artifacts**

```bash
cd /home/mdlog/Project-MDlabs/Akindo/casper/contracts-evm && forge build
cd "$(git rev-parse --show-toplevel)"   # the worktree root — never a hardcoded checkout path
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const pick = (n) => JSON.parse(
  readFileSync(`contracts-evm/out/${n}.sol/${n}.json`, "utf8")).abi;
const banner = `/**
 * Contract ABIs for the 0G Galileo deployment.
 *
 * GENERATED from contracts-evm/out/*.json — regenerate with the snippet in
 * docs/superpowers/plans/2026-08-30-0g-galileo-migration.md Task 9 whenever a
 * contract entrypoint changes. \`as const\` is required: viem derives its
 * argument and return types from the literal tuple, so a widened \`Abi\` would
 * silently degrade every call to \`unknown\`.
 */
`;
const body = ["AgentGateRegistry", "PaymentRouter", "SpendGuard"]
  .map((n, i) => `export const ${
    ["REGISTRY_ABI", "PAYMENT_ROUTER_ABI", "SPEND_GUARD_ABI"][i]
  } = ${JSON.stringify(pick(n), null, 2)} as const;`)
  .join("\n\n");
writeFileSync("packages/chain/src/abi.ts", banner + "\n" + body + "\n");
'
head -20 packages/chain/src/abi.ts
```

- [ ] **Step 2: Write the failing test**

Create `packages/chain/test/live-0g-reads.test.ts`. It runs against a real
`anvil` so the ABI encoding is exercised end to end — mocking the RPC would test
nothing that matters here.

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createWalletClient, createPublicClient, http, parseEther, toHex } from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import type { AgentGateConfig } from '@agentgate/shared';
import { Live0gClient } from '../src/live-0g';
import { REGISTRY_ABI } from '../src/abi';

const RPC = 'http://127.0.0.1:8546';

/**
 * Anvil's deterministic dev accounts, DERIVED from its public default mnemonic
 * rather than pasted as a hex literal. The key is public and worthless, but a
 * 64-hex string in a tracked file trips secret scanners (gitleaks,
 * GitGuardian's Ethereum-key detector, trufflehog) and costs a CI failure.
 */
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
const anvilAccount = (index: number) => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index });
const anvilKey = (index: number): `0x${string}` =>
  toHex(anvilAccount(index).getHdKey().privateKey!);

const DEPLOYER = anvilKey(0);
const CHAIN = { id: 31337, name: 'anvil', nativeCurrency: { name: 'OG', symbol: 'OG', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;

let anvil: ChildProcess;
let registryAddress: `0x${string}`;
let client: Live0gClient;
const account = privateKeyToAccount(DEPLOYER);

function deploy(name: string): `0x${string}` {
  const out = execFileSync('forge', [
    'create', `src/${name}.sol:${name}`,
    '--rpc-url', RPC, '--private-key', DEPLOYER, '--broadcast', '--json',
  ], { cwd: new URL('../../../contracts-evm', import.meta.url).pathname, encoding: 'utf8' });
  return JSON.parse(out).deployedTo as `0x${string}`;
}

function configFor(registry: string): AgentGateConfig {
  // Only the fields Live0gClient reads; the rest are irrelevant here.
  return {
    zgRpcUrl: RPC, zgChainId: 31337, zgNetwork: '0g-galileo',
    registryContractAddress: registry, paymentRouterAddress: '',
    activityLookbackBlocks: 50_000,
  } as unknown as AgentGateConfig;
}

beforeAll(async () => {
  anvil = spawn('anvil', ['--port', '8546', '--silent'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 2000));
  registryAddress = deploy('AgentGateRegistry');

  const wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });
  const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });
  const hash = await wallet.writeContract({
    address: registryAddress, abi: REGISTRY_ABI, functionName: 'registerService',
    args: [
      'weather', 'forecast API', 'https://gateway.example',
      [{ asset: '0x0000000000000000000000000000000000000000', amount: parseEther('0.001'),
         decimals: 18, symbol: 'OG', name: '', version: '' }],
      account.address, account.address,
    ],
  });
  await pub.waitForTransactionReceipt({ hash });

  client = new Live0gClient(configFor(registryAddress));
}, 60_000);

afterAll(() => { anvil?.kill(); });

describe('Live0gClient reads', () => {
  it('ping resolves against a reachable node', async () => {
    await expect(client.ping()).resolves.toBeUndefined();
  });

  it('getService maps the on-chain record to ServiceRecord', async () => {
    const s = await client.getService(1);
    expect(s).not.toBeNull();
    expect(s!.id).toBe(1);
    expect(s!.name).toBe('weather');
    expect(s!.description).toBe('forecast API');
    // endpointUrl is COMPUTED from gatewayBaseUrl, never stored on-chain
    expect(s!.endpointUrl).toBe('https://gateway.example/svc/1');
    expect(s!.priceWei).toBe('1000000000000000');
    expect(s!.owner).toBe(account.address.toLowerCase());
    expect(s!.attestor).toBe(account.address.toLowerCase());
    expect(s!.paymentTarget).toBe(account.address.toLowerCase());
    expect(s!.active).toBe(true);
    expect(s!.accepts).toHaveLength(1);
    expect(s!.accepts![0]!.asset).toBe('native');
    // createdAt is MS
    expect(s!.createdAt).toBeGreaterThan(1_700_000_000_000);
  });

  it('getService returns null for an unregistered id instead of throwing', async () => {
    await expect(client.getService(999)).resolves.toBeNull();
  });

  it('listServices returns every registered service', async () => {
    const list = await client.listServices();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(1);
  });

  it('getScore is (0,0) before any attestation', async () => {
    await expect(client.getScore(1)).resolves.toEqual({ totalCalls: 0, successCalls: 0 });
  });

  it('listAttestations is empty before any attestation', async () => {
    await expect(client.listAttestations(1)).resolves.toEqual([]);
  });

  it('getBalance reads native OG in wei', async () => {
    const bal = await client.getBalance(account.address);
    expect(BigInt(bal)).toBeGreaterThan(0n);
  });

  it('getBalance rejects a non-address', async () => {
    await expect(client.getBalance('account-hash-abc')).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run packages/chain/test/live-0g-reads.test.ts`
Expected: FAIL — cannot resolve `../src/live-0g`.

- [ ] **Step 4: Implement the read half of `packages/chain/src/live-0g.ts`**

```ts
import { createPublicClient, defineChain, http, type PublicClient } from 'viem';
import {
  AgentGateError, stripTrailingSlashes,
  type ActivityEvent, type AgentGateConfig, type AnySigner,
  type AttestationRecord, type ChainClient, type PaymentOption,
  type RegisterServiceInput, type ServiceRecord, type ServiceScore,
  type VerifyResult, type VerifyTransferQuery, type Wei,
} from '@agentgate/shared';
import { normalizeAddress } from './address';
import { REGISTRY_ABI } from './abi';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Registry ids are 1-based; a read of 0 is always "absent". */
function requireServiceId(id: number): bigint {
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new AgentGateError('invalid_query', `service id must be a positive integer, got ${id}`, 400);
  }
  return BigInt(id);
}

function notDeployed(): AgentGateError {
  return new AgentGateError(
    'CONTRACT_NOT_DEPLOYED',
    'REGISTRY_CONTRACT_ADDRESS is unset — deploy the registry (contracts-evm/README.md) and set it',
    503,
  );
}

/** True when a viem read reverted with the contract's ServiceNotFound error. */
function isServiceNotFound(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('ServiceNotFound');
}

/**
 * 0G Galileo Testnet client — the live `ChainClient`.
 *
 * Every read is an ABI view call and every history query is `eth_getLogs`, so
 * unlike the Casper predecessor this needs no indexer service and no API key:
 * a public RPC URL is the whole configuration.
 */
export class Live0gClient implements ChainClient {
  readonly network: string;
  private readonly cfg: AgentGateConfig;
  private readonly pub: PublicClient;

  constructor(config: AgentGateConfig) {
    this.cfg = config;
    this.network = config.zgNetwork;
    const chain = defineChain({
      id: config.zgChainId,
      name: config.zgNetwork,
      nativeCurrency: { name: 'OG', symbol: 'OG', decimals: 18 },
      rpcUrls: { default: { http: [config.zgRpcUrl] } },
    });
    this.pub = createPublicClient({ chain, transport: http(config.zgRpcUrl) });
  }

  /** Cheap reachability probe for readiness checks. */
  async ping(): Promise<void> {
    await this.pub.getBlockNumber();
  }

  private registry(): `0x${string}` {
    if (this.cfg.registryContractAddress === '') throw notDeployed();
    return normalizeAddress(this.cfg.registryContractAddress) as `0x${string}`;
  }

  /** Map the on-chain Service tuple onto the off-chain ServiceRecord shape. */
  private toRecord(
    raw: {
      name: string; description: string; gatewayBaseUrl: string;
      accepts: readonly { asset: string; amount: bigint; decimals: number;
                          symbol: string; name: string; version: string }[];
      paymentTarget: string; owner: string; attestor: string;
      active: boolean; createdAt: bigint;
    },
    id: number,
  ): ServiceRecord {
    const accepts: PaymentOption[] = raw.accepts.map((o) => ({
      asset: o.asset.toLowerCase() === ZERO_ADDRESS ? 'native' : o.asset.toLowerCase(),
      amount: o.amount.toString(),
      decimals: o.decimals,
      symbol: o.symbol,
      name: o.name,
      version: o.version,
    }));
    // priceWei mirrors the native option, or the first option if none is native
    // — the same rule the Casper registry-v2 reader used.
    const native = accepts.find((o) => o.asset === 'native');
    const priceWei: Wei = (native ?? accepts[0])?.amount ?? '0';
    return {
      id,
      name: raw.name,
      description: raw.description,
      // The contract stores the BASE url; the endpoint is always {base}/svc/{id}.
      endpointUrl: `${stripTrailingSlashes(raw.gatewayBaseUrl)}/svc/${id}`,
      priceWei,
      paymentTarget: raw.paymentTarget.toLowerCase(),
      owner: raw.owner.toLowerCase(),
      attestor: raw.attestor.toLowerCase(),
      active: raw.active,
      createdAt: Number(raw.createdAt), // already MS on-chain
      accepts,
    };
  }

  async getService(id: number): Promise<ServiceRecord | null> {
    const serviceId = requireServiceId(id);
    try {
      const raw = await this.pub.readContract({
        address: this.registry(), abi: REGISTRY_ABI,
        functionName: 'getService', args: [serviceId],
      });
      return this.toRecord(raw as Parameters<typeof this.toRecord>[0], id);
    } catch (err) {
      // An unregistered id is "absent", not an error — the middleware turns a
      // null into 404 and a throw into 503, so this distinction matters.
      if (isServiceNotFound(err)) return null;
      throw err;
    }
  }

  async listServices(): Promise<ServiceRecord[]> {
    const count = await this.pub.readContract({
      address: this.registry(), abi: REGISTRY_ABI, functionName: 'servicesCount',
    });
    const total = Number(count);
    if (total === 0) return [];
    const ids = Array.from({ length: total }, (_, i) => i + 1);
    const settled = await Promise.all(ids.map((id) => this.getService(id)));
    return settled.filter((s): s is ServiceRecord => s !== null);
  }

  async getScore(id: number): Promise<ServiceScore> {
    const [total, success] = await this.pub.readContract({
      address: this.registry(), abi: REGISTRY_ABI,
      functionName: 'getScore', args: [requireServiceId(id)],
    });
    return { totalCalls: Number(total), successCalls: Number(success) };
  }

  async listAttestations(serviceId: number, limit = 50): Promise<AttestationRecord[]> {
    const raw = await this.pub.readContract({
      address: this.registry(), abi: REGISTRY_ABI,
      functionName: 'getAttestations', args: [requireServiceId(serviceId)],
    });
    // The contract already returns newest-first; only the cap is applied here.
    return raw.slice(0, limit).map((a) => ({
      serviceId,
      paymentTxHash: a.paymentTxHash,
      success: a.success,
      timestamp: Number(a.timestamp),
      recordTxHash: '', // filled by listRecentActivity's log join (Task 11)
    }));
  }

  async getBalance(account: string): Promise<Wei> {
    const address = normalizeAddress(account) as `0x${string}`;
    const balance = await this.pub.getBalance({ address });
    return balance.toString();
  }

  // ---- writes land in Task 10 ----------------------------------------------
  async listRecentActivity(_limit = 50): Promise<ActivityEvent[]> {
    throw new AgentGateError('NOT_IMPLEMENTED', 'listRecentActivity lands in Task 11', 501);
  }
  async verifyTransfer(_q: VerifyTransferQuery): Promise<VerifyResult> {
    throw new AgentGateError('NOT_IMPLEMENTED', 'verifyTransfer lands in Task 10', 501);
  }
  async registerService(_i: RegisterServiceInput, _s: AnySigner): Promise<{ serviceId: number; txHash: string }> {
    throw new AgentGateError('NOT_IMPLEMENTED', 'registerService lands in Task 10', 501);
  }
  async recordAttestation(_i: { serviceId: number; paymentTxHash: string; success: boolean }, _s: AnySigner): Promise<{ txHash: string }> {
    throw new AgentGateError('NOT_IMPLEMENTED', 'recordAttestation lands in Task 10', 501);
  }
  async setActive(_id: number, _a: boolean, _s: AnySigner): Promise<{ txHash: string }> {
    throw new AgentGateError('NOT_IMPLEMENTED', 'setActive lands in Task 10', 501);
  }
  async transfer(_i: { to: string; amountWei: Wei; nonce: string; serviceId: number }, _s: AnySigner): Promise<{ txHash: string }> {
    throw new AgentGateError('NOT_IMPLEMENTED', 'transfer lands in Task 10', 501);
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run packages/chain/test/live-0g-reads.test.ts`
Expected: PASS — 8 tests. If `anvil` fails to bind port 8546, check nothing else
holds it (`ss -ltnp | grep 8546`).

- [ ] **Step 6: Commit**

```bash
git add packages/chain/src/abi.ts packages/chain/src/live-0g.ts \
        packages/chain/test/live-0g-reads.test.ts
git commit -m "feat(chain): Live0gClient read path over viem ABI calls"
```

---

## Task 10: `Live0gClient` write path and `verifyTransfer`

**Files:**
- Modify: `packages/chain/src/live-0g.ts`
- Test: `packages/chain/test/live-0g-writes.test.ts`
- Reference (read, do not modify): `packages/chain/src/live.ts:1082-1143` (`verifyTransfer` semantics being preserved)

**Interfaces:**
- Produces: working `registerService`, `recordAttestation`, `setActive`, `transfer`, `verifyTransfer` on `Live0gClient`.
- `verifyTransfer` keeps the exact `VerifyResult` contract, **including the `'pending'` reason** — the middleware branches on it to keep an invoice alive across settlement lag (`packages/middleware/src/app.ts:684-690`).

- [ ] **Step 1: Write the failing test**

Create `packages/chain/test/live-0g-writes.test.ts`. Reuse the anvil harness
from Task 9 (port 8547 so the two suites can run in parallel), deploying both
`AgentGateRegistry` and `PaymentRouter`, then:

```ts
describe('Live0gClient writes', () => {
  it('registerService returns the assigned 1-based id and tx hash', async () => {
    const { serviceId, txHash } = await client.registerService({
      name: 'weather', description: 'forecast', endpointUrl: 'https://gw.example',
      priceWei: '1000000000000000', paymentTarget: seller.address, attestor: gate.address,
    }, signer);
    expect(serviceId).toBe(1);
    expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('transfer routes through PaymentRouter and Paid is verifiable', async () => {
    const { txHash } = await client.transfer(
      { to: seller.address, amountWei: '1000000000000000', nonce: '4242', serviceId: 1 },
      buyerSigner,
    );
    const verdict = await client.verifyTransfer({
      txHash, serviceId: 1, expectedTarget: seller.address,
      minAmountWei: '1000000000000000', expectedNonce: '4242', maxAgeMs: 300_000,
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.amountWei).toBe('1000000000000000');
      expect(verdict.from).toBe(buyer.address.toLowerCase());
    }
  });

  it('verifyTransfer rejects the wrong target', async () => {
    const { txHash } = await client.transfer(
      { to: seller.address, amountWei: '1000000000000000', nonce: '4243', serviceId: 1 }, buyerSigner);
    const v = await client.verifyTransfer({
      txHash, serviceId: 1, expectedTarget: gate.address, minAmountWei: '1000000000000000',
      expectedNonce: '4243', maxAgeMs: 300_000 });
    expect(v).toEqual({ ok: false, reason: 'wrong_target' });
  });

  it('verifyTransfer rejects a nonce that does not match the log', async () => {
    const { txHash } = await client.transfer(
      { to: seller.address, amountWei: '1000000000000000', nonce: '4244', serviceId: 1 }, buyerSigner);
    const v = await client.verifyTransfer({
      txHash, serviceId: 1, expectedTarget: seller.address, minAmountWei: '1000000000000000',
      expectedNonce: '9999', maxAgeMs: 300_000 });
    expect(v).toEqual({ ok: false, reason: 'wrong_transfer_id' });
  });

  it('verifyTransfer rejects a payment made for a DIFFERENT service', async () => {
    // Same nonce, same payTo, different serviceId. PaymentRouter allows this
    // (seenNonce is keyed per service) and payment targets are shared across
    // services, so only the serviceId topic separates the two.
    const { txHash } = await client.transfer(
      { to: seller.address, amountWei: '1000000000000000', nonce: '7777', serviceId: 2 }, buyerSigner);
    const v = await client.verifyTransfer({
      txHash, serviceId: 1, expectedTarget: seller.address,
      minAmountWei: '1000000000000000', expectedNonce: '7777', maxAgeMs: 300_000 });
    expect(v).toEqual({ ok: false, reason: 'wrong_transfer_id' });
  });

  it('verifyTransfer rejects an underpayment', async () => {
    const { txHash } = await client.transfer(
      { to: seller.address, amountWei: '1000000000000000', nonce: '4245', serviceId: 1 }, buyerSigner);
    const v = await client.verifyTransfer({
      txHash, serviceId: 1, expectedTarget: seller.address, minAmountWei: '2000000000000000',
      expectedNonce: '4245', maxAgeMs: 300_000 });
    expect(v).toEqual({ ok: false, reason: 'amount_too_low' });
  });

  it('verifyTransfer reports pending for an unmined hash, not not_found', async () => {
    const v = await client.verifyTransfer({
      txHash: `0x${'ff'.repeat(32)}`, serviceId: 1, expectedTarget: seller.address,
      minAmountWei: '1', expectedNonce: '1', maxAgeMs: 300_000 });
    expect(v).toEqual({ ok: false, reason: 'pending' });
  });

  it('verifyTransfer rejects a payment older than maxAgeMs', async () => {
    const { txHash } = await client.transfer(
      { to: seller.address, amountWei: '1000000000000000', nonce: '4246', serviceId: 1 }, buyerSigner);
    const v = await client.verifyTransfer({
      txHash, serviceId: 1, expectedTarget: seller.address, minAmountWei: '1000000000000000',
      expectedNonce: '4246', maxAgeMs: 0 });
    expect(v).toEqual({ ok: false, reason: 'expired' });
  });

  it('recordAttestation bumps the on-chain score', async () => {
    const { txHash } = await client.transfer(
      { to: seller.address, amountWei: '1000000000000000', nonce: '4247', serviceId: 1 }, buyerSigner);
    await client.recordAttestation({ serviceId: 1, paymentTxHash: txHash, success: true }, gateSigner);
    await expect(client.getScore(1)).resolves.toEqual({ totalCalls: 1, successCalls: 1 });
  });

  it('setActive toggles the discovery flag', async () => {
    await client.setActive(1, false, signer);
    expect((await client.getService(1))!.active).toBe(false);
    await client.setActive(1, true, signer);
    expect((await client.getService(1))!.active).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/chain/test/live-0g-writes.test.ts`
Expected: FAIL — `NOT_IMPLEMENTED: registerService lands in Task 10`.

- [ ] **Step 3: Implement**

Replace the stubs in `packages/chain/src/live-0g.ts`:

```ts
import {
  createWalletClient, decodeEventLog, parseEventLogs,
  type Hash, type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PAYMENT_ROUTER_ABI } from './abi';

// …inside Live0gClient:

  /** Build a signing wallet from a key signer. Mock signers cannot write here. */
  private walletFor(signer: AnySigner): WalletClient {
    if (signer.kind !== 'key') {
      throw new AgentGateError(
        'invalid_signer',
        `Live0gClient requires a key signer, got "${signer.kind}"`,
        400,
      );
    }
    const account = privateKeyToAccount(signer.privateKey as `0x${string}`);
    return createWalletClient({ account, chain: this.pub.chain, transport: http(this.cfg.zgRpcUrl) });
  }

  private router(): `0x${string}` {
    if (this.cfg.paymentRouterAddress === '') {
      throw new AgentGateError(
        'CONTRACT_NOT_DEPLOYED',
        'PAYMENT_ROUTER_ADDRESS is unset — deploy PaymentRouter and set it',
        503,
      );
    }
    return normalizeAddress(this.cfg.paymentRouterAddress) as `0x${string}`;
  }

  async registerService(
    input: RegisterServiceInput, signer: AnySigner,
  ): Promise<{ serviceId: number; txHash: string }> {
    const wallet = this.walletFor(signer);
    const hash = await wallet.writeContract({
      address: this.registry(), abi: REGISTRY_ABI, functionName: 'registerService',
      chain: this.pub.chain, account: wallet.account!,
      args: [
        input.name, input.description, input.endpointUrl,
        [{
          asset: ZERO_ADDRESS as `0x${string}`, amount: BigInt(input.priceWei),
          decimals: 18, symbol: 'OG', name: '', version: '',
        }],
        normalizeAddress(input.paymentTarget) as `0x${string}`,
        normalizeAddress(input.attestor) as `0x${string}`,
      ],
    });
    const receipt = await this.pub.waitForTransactionReceipt({ hash });
    // The id is assigned on-chain; read it back from the event rather than
    // racing servicesCount(), which another registration could have bumped.
    const [event] = parseEventLogs({
      abi: REGISTRY_ABI, eventName: 'ServiceRegistered', logs: receipt.logs,
    });
    if (!event) {
      throw new AgentGateError('TX_FAILED', 'registerService emitted no ServiceRegistered event', 502);
    }
    return { serviceId: Number(event.args.serviceId), txHash: hash };
  }

  async recordAttestation(
    input: { serviceId: number; paymentTxHash: string; success: boolean }, signer: AnySigner,
  ): Promise<{ txHash: string }> {
    const wallet = this.walletFor(signer);
    const hash = await wallet.writeContract({
      address: this.registry(), abi: REGISTRY_ABI, functionName: 'recordAttestation',
      chain: this.pub.chain, account: wallet.account!,
      args: [requireServiceId(input.serviceId), input.paymentTxHash as Hash, input.success],
    });
    await this.pub.waitForTransactionReceipt({ hash });
    return { txHash: hash };
  }

  async setActive(serviceId: number, active: boolean, signer: AnySigner): Promise<{ txHash: string }> {
    const wallet = this.walletFor(signer);
    const hash = await wallet.writeContract({
      address: this.registry(), abi: REGISTRY_ABI, functionName: 'setActive',
      chain: this.pub.chain, account: wallet.account!,
      args: [requireServiceId(serviceId), active],
    });
    await this.pub.waitForTransactionReceipt({ hash });
    return { txHash: hash };
  }

  /**
   * Pay a 402 invoice through PaymentRouter. The nonce travels as an INDEXED
   * event topic, which is what makes verifyTransfer a single exact-match
   * getLogs — this is the EVM stand-in for Casper's native `transfer_id`.
   */
  async transfer(
    input: { to: string; amountWei: Wei; nonce: string; serviceId: number }, signer: AnySigner,
  ): Promise<{ txHash: string }> {
    const wallet = this.walletFor(signer);
    const hash = await wallet.writeContract({
      address: this.router(), abi: PAYMENT_ROUTER_ABI, functionName: 'pay',
      chain: this.pub.chain, account: wallet.account!,
      value: BigInt(input.amountWei),
      args: [
        requireServiceId(input.serviceId), BigInt(input.nonce),
        normalizeAddress(input.to) as `0x${string}`,
      ],
    });
    await this.pub.waitForTransactionReceipt({ hash });
    return { txHash: hash };
  }

  /**
   * Confirm a PaymentRouter payment settles the given invoice.
   *
   * Reason semantics are preserved from the Casper client so the middleware's
   * branching is untouched — in particular `'pending'` (retryable) is returned
   * for a hash that is not yet mined, so a buyer polling right after paying is
   * never told their valid payment does not exist.
   */
  async verifyTransfer(q: VerifyTransferQuery): Promise<VerifyResult> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(q.txHash)) return { ok: false, reason: 'not_found' };

    let receipt;
    try {
      receipt = await this.pub.getTransactionReceipt({ hash: q.txHash as Hash });
    } catch {
      return { ok: false, reason: 'pending' }; // unmined or not yet propagated
    }
    if (receipt.status !== 'success') return { ok: false, reason: 'not_found' };

    const events = parseEventLogs({
      abi: PAYMENT_ROUTER_ABI, eventName: 'Paid', logs: receipt.logs,
    }).filter((e) => e.address.toLowerCase() === this.router().toLowerCase());
    if (events.length === 0) return { ok: false, reason: 'not_found' };

    const expectedTarget = normalizeAddress(q.expectedTarget);
    const toTarget = events.filter((e) => e.args.payTo.toLowerCase() === expectedTarget);
    if (toTarget.length === 0) return { ok: false, reason: 'wrong_target' };

    // One tx can carry several Paid logs to the same target; pick the one that
    // carries BOTH our service id and our nonce, then bind the amount/age
    // checks to it. Both are required: the nonce is only unique per service
    // (PaymentRouter.seenNonce is keyed on the pair), and payment targets are
    // routinely shared across services, so neither field disambiguates alone.
    const expectedNonce = BigInt(q.expectedNonce);
    const expectedServiceId = BigInt(q.serviceId);
    const match = toTarget.find(
      (e) => e.args.nonce === expectedNonce && e.args.serviceId === expectedServiceId,
    );
    if (!match) return { ok: false, reason: 'wrong_transfer_id' };

    if (match.args.amount < BigInt(q.minAmountWei)) return { ok: false, reason: 'amount_too_low' };

    const timestamp = Number(match.args.timestamp); // already MS
    if (Date.now() - timestamp > q.maxAgeMs) return { ok: false, reason: 'expired' };

    return {
      ok: true,
      amountWei: match.args.amount.toString(),
      from: match.args.payer.toLowerCase(),
      timestamp,
    };
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/chain/test/live-0g-writes.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/chain/src/live-0g.ts packages/chain/test/live-0g-writes.test.ts
git commit -m "feat(chain): Live0gClient writes + PaymentRouter-backed verifyTransfer"
```

---

## Task 11: Activity feed over `eth_getLogs`, factory cutover, Casper deletion

**Files:**
- Modify: `packages/chain/src/live-0g.ts` (`listRecentActivity`)
- Modify: `packages/chain/src/index.ts`
- Modify: `packages/chain/package.json`
- Delete: `packages/chain/src/live.ts`, `packages/chain/src/sdk.ts`, `contracts/agentgate-registry/`, `contracts/spend-guard/`, and the 7 Casper-only tests listed in **File Structure**
- Test: add to `packages/chain/test/live-0g-writes.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 9-10.
- Produces: `createChainClient(config)` returning `Live0gClient` for `mode === 'live'`; `listRecentActivity` yielding `ActivityEvent[]` newest-first.

- [ ] **Step 1: Write the failing test**

Append to `packages/chain/test/live-0g-writes.test.ts`:

```ts
describe('listRecentActivity', () => {
  it('joins registrations, payments and attestations newest-first', async () => {
    // the suite above already registered service 1, paid several times and
    // attested once — assert the feed reflects all three event kinds
    const feed = await client.listRecentActivity(50);
    const kinds = new Set(feed.map((e) => e.kind));
    expect(kinds.has('service_registered')).toBe(true);
    expect(kinds.has('payment')).toBe(true);
    expect(kinds.has('attestation')).toBe(true);

    // newest first
    for (let i = 1; i < feed.length; i++) {
      expect(feed[i - 1]!.timestamp).toBeGreaterThanOrEqual(feed[i]!.timestamp);
    }

    const payment = feed.find((e) => e.kind === 'payment')!;
    expect(payment.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(payment.serviceId).toBe(1);
    expect(payment.amountWei).toBe('1000000000000000');
    expect(payment.detail).toContain('OG');

    const reg = feed.find((e) => e.kind === 'service_registered')!;
    expect(reg.detail).toContain('weather');
  });

  it('honours the limit', async () => {
    expect((await client.listRecentActivity(2))).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/chain/test/live-0g-writes.test.ts -t listRecentActivity`
Expected: FAIL — `NOT_IMPLEMENTED: listRecentActivity lands in Task 11`.

- [ ] **Step 3: Implement `listRecentActivity`**

Replace the stub in `packages/chain/src/live-0g.ts`:

```ts
  /**
   * Recent on-chain activity, newest first.
   *
   * Three `eth_getLogs` calls (registry registrations, registry attestations,
   * router payments) replace the Casper client's three CSPR.cloud REST reads —
   * no API key, no rate-limit path. The lookback is BOUNDED: public RPCs cap
   * getLogs ranges, and `fromBlock: 0` would fail outright on a live chain.
   */
  async listRecentActivity(limit = 50): Promise<ActivityEvent[]> {
    const latest = await this.pub.getBlockNumber();
    const lookback = BigInt(this.cfg.activityLookbackBlocks);
    const fromBlock = latest > lookback ? latest - lookback : 0n;

    const [registered, attested, paid] = await Promise.all([
      this.pub.getLogs({
        address: this.registry(), fromBlock, toBlock: latest,
        event: eventAbi(REGISTRY_ABI, 'ServiceRegistered'),
      }),
      this.pub.getLogs({
        address: this.registry(), fromBlock, toBlock: latest,
        event: eventAbi(REGISTRY_ABI, 'AttestationRecorded'),
      }),
      this.cfg.paymentRouterAddress === '' ? Promise.resolve([]) : this.pub.getLogs({
        address: this.router(), fromBlock, toBlock: latest,
        event: eventAbi(PAYMENT_ROUTER_ABI, 'Paid'),
      }),
    ]);

    // Block timestamps are per-block, not per-log: fetch each distinct block once.
    const blockNumbers = new Set<bigint>([
      ...registered.map((l) => l.blockNumber),
      ...attested.map((l) => l.blockNumber),
      ...paid.map((l) => l.blockNumber),
    ]);
    const times = new Map<bigint, number>();
    await Promise.all([...blockNumbers].map(async (bn) => {
      const block = await this.pub.getBlock({ blockNumber: bn });
      times.set(bn, Number(block.timestamp) * 1000); // seconds -> MS
    }));
    const at = (bn: bigint): number => times.get(bn) ?? 0;

    const events: ActivityEvent[] = [];

    for (const log of registered) {
      events.push({
        kind: 'service_registered',
        txHash: log.transactionHash,
        serviceId: Number(log.args.serviceId),
        timestamp: at(log.blockNumber),
        detail: `service "${log.args.name}" registered`,
      });
    }

    for (const log of attested) {
      const success = log.args.success;
      events.push({
        kind: 'attestation',
        txHash: log.transactionHash,
        serviceId: Number(log.args.serviceId),
        success,
        timestamp: at(log.blockNumber),
        detail: `attestation ${success ? 'success' : 'failure'} for service ${log.args.serviceId}`,
      });
    }

    for (const log of paid) {
      // serviceId is carried by the Paid event itself, so unlike the Casper
      // client we never have to attribute a payment via its attestation.
      events.push({
        kind: 'payment',
        txHash: log.transactionHash,
        serviceId: Number(log.args.serviceId),
        amountWei: log.args.amount.toString(),
        timestamp: at(log.blockNumber),
        detail: `payment of ${formatOg(log.args.amount.toString())} to ${shortAddress(log.args.payTo)}`,
      });
    }

    events.sort((a, b) => b.timestamp - a.timestamp);
    return events.slice(0, limit);
  }
```

Add the helper above the class:

```ts
/** Pull one event's ABI entry out of a contract ABI for viem's `getLogs`. */
function eventAbi<T extends readonly { type: string; name?: string }[]>(
  abi: T, name: string,
): Extract<T[number], { type: 'event' }> {
  const found = abi.find((e) => e.type === 'event' && e.name === name);
  if (!found) throw new Error(`event ${name} missing from ABI`);
  return found as Extract<T[number], { type: 'event' }>;
}
```

and add `formatOg` + `shortAddress` to the imports.

- [ ] **Step 4: Cut the factory over**

Rewrite `packages/chain/src/index.ts`:

```ts
import type { AgentGateConfig, ChainClient } from '@agentgate/shared';
import { MockChainHttpClient } from './mock';
import { Live0gClient } from './live-0g';

export { MockChainHttpClient, mockAccountAddress } from './mock';
export { Live0gClient } from './live-0g';
export { recoverSigner, type OwnerSignatureResult } from './signature';
export { normalizeAddress, isAddress, sameAddress, shortAddress } from './address';
export { REGISTRY_ABI, PAYMENT_ROUTER_ABI, SPEND_GUARD_ABI } from './abi';

/**
 * Picks the ChainClient implementation by `config.mode`:
 * - 'mock' → MockChainHttpClient (REST against the local devnet at config.devnetUrl)
 * - 'live' → Live0gClient (viem against 0G Galileo Testnet)
 */
export function createChainClient(config: AgentGateConfig): ChainClient {
  return config.mode === 'live'
    ? new Live0gClient(config)
    : new MockChainHttpClient(config.devnetUrl);
}
```

`mockAccountAddress` and `recoverSigner` land in Tasks 14 and 12 — if you are
executing strictly in order, leave the old names here and fix them in those
tasks rather than breaking the build now.

- [ ] **Step 5: Delete the Casper layer**

```bash
cd "$(git rev-parse --show-toplevel)"   # the worktree root — never a hardcoded checkout path
git rm -r contracts/agentgate-registry contracts/spend-guard
git rm packages/chain/src/live.ts packages/chain/src/sdk.ts
git rm packages/chain/test/odra-state-key.test.ts \
       packages/chain/test/contract-resolve.test.ts \
       packages/chain/test/service-parse.test.ts \
       packages/chain/test/register-args.test.ts \
       packages/chain/test/cloud-entry-point.test.ts \
       packages/chain/test/ft-action-payment.test.ts \
       packages/chain/test/verify-transfer-pending.test.ts
npm uninstall casper-js-sdk -w @agentgate/chain
npm uninstall casper-js-sdk @make-software/casper-x402 -w @agentgate/client
rg -n 'casper-js-sdk|casper-x402' package.json packages/*/package.json dashboard/package.json
```

Expected: the final `rg` prints nothing. Also delete the Casper-specific
scripts that no longer have a target:

```bash
git rm scripts/deploy-registry-v2.ts scripts/register-core-services-v2.ts \
       scripts/register-service-v2.ts scripts/verify-registry-v2.ts \
       scripts/inspect-v2-txs.ts scripts/sdk-clvalue-probe.ts \
       scripts/gate-storedcall-test.ts scripts/facilitator-e2e.ts
```

Rewrite `contracts/README.md` as a one-line pointer to `contracts-evm/README.md`,
or delete `contracts/` entirely if nothing else lives there.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run packages/chain && npm run typecheck -w @agentgate/chain`
Expected: PASS for `@agentgate/chain`. Repo-wide `typecheck` still fails in
`client`/`middleware`/`cli`/`devnet`/`dashboard` — Tasks 12-15.

- [ ] **Step 7: Commit**

```bash
git add -A packages/chain contracts contracts-evm scripts package.json package-lock.json
git commit -m "feat(chain): eth_getLogs activity feed; cut over to 0G and delete the Casper layer"
```

---

## Task 12: EIP-191 signatures and CLI identity

**Files:**
- Modify: `packages/chain/src/signature.ts` (full rewrite)
- Modify: `packages/chain/test/signature.test.ts` (full rewrite)
- Modify: `packages/cli/src/identity.ts` (full rewrite)
- Modify: `packages/middleware/src/app.ts:806-880` (the `/services/:id/map` handler)
- Modify: `packages/shared/src/self-map.ts` (doc only)

**Interfaces:**
- Produces: `recoverSigner(message: Uint8Array, signatureHex: string) -> { address: string; valid: boolean }`; `signerAddress(signer: AnySigner) -> Promise<string>`; `signMessage(signer, message) -> Promise<{ signatureHex: string }>` (**no `publicKeyHex`** — EVM recovers the signer from the signature).
- Breaking wire change: `POST /services/:id/map` body drops `publicKeyHex`.

- [ ] **Step 1: Write the failing test**

Replace `packages/chain/test/signature.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mnemonicToAccount } from 'viem/accounts';
import { recoverSigner } from '../src/signature';

// Anvil's public default mnemonic — derived, not pasted, so no key-shaped
// literal lands in a tracked file for secret scanners to flag.
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
const account = mnemonicToAccount(ANVIL_MNEMONIC);
const MSG = new TextEncoder().encode('AgentGate/self-map/v1\n0g-galileo\n1\nhttps://x\n123');

describe('recoverSigner', () => {
  it('recovers the signer address from a valid EIP-191 signature', async () => {
    const sig = await account.signMessage({ message: { raw: MSG } });
    const res = await recoverSigner(MSG, sig);
    expect(res.valid).toBe(true);
    expect(res.address).toBe(account.address.toLowerCase());
  });

  it('does NOT recover the same address for a different message', async () => {
    const sig = await account.signMessage({ message: { raw: MSG } });
    const res = await recoverSigner(new TextEncoder().encode('other'), sig);
    // recovery still succeeds cryptographically, but yields a DIFFERENT address —
    // which is why the caller MUST compare against the on-chain owner.
    expect(res.address).not.toBe(account.address.toLowerCase());
  });

  it('rejects a tampered signature WITHOUT throwing', async () => {
    const bad = `0x${'11'.repeat(65)}`;
    const res = await recoverSigner(MSG, bad);
    expect(res.valid).toBe(false);
    expect(res.address).toBe('');
  });

  it('rejects malformed signature hex without throwing', async () => {
    for (const bad of ['', '0x', 'zz', '0x1234']) {
      await expect(recoverSigner(MSG, bad)).resolves.toEqual({ address: '', valid: false });
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/chain/test/signature.test.ts`
Expected: FAIL — `No "recoverSigner" export is defined`.

- [ ] **Step 3: Implement `packages/chain/src/signature.ts`**

> `recoverMessageAddress` is **async**, so `recoverSigner` is async too — unlike
> the Casper version it replaces. Both call sites already sit inside `async`
> bodies (the gateway's `wrap()` handler and the CLI), so this costs nothing,
> but the test in Step 1 must `await` every `recoverSigner(...)` call.

```ts
import { recoverMessageAddress, isHex } from 'viem';

export interface OwnerSignatureResult {
  /** Recovered signer address (lowercased `0x…`); '' when recovery failed. */
  address: string;
  /** true when the signature is well-formed and an address was recovered. */
  valid: boolean;
}

/**
 * Recovers the EVM address that produced an EIP-191 (`personal_sign`) signature
 * over `message`.
 *
 * Unlike the Casper predecessor there is no public key to pass in: on EVM the
 * signer is RECOVERED from the signature, so the caller transmits only the
 * signature. That also means a successful recovery proves NOTHING on its own —
 * every signature recovers to some address. The caller MUST compare the result
 * against the expected on-chain owner; see the self-map handler in Step 5.
 *
 * Fully defensive: malformed hex or a wrong-length signature returns
 * `{ address: '', valid: false }`. NEVER throws — safe on untrusted input.
 */
export async function recoverSigner(
  message: Uint8Array,
  signatureHex: string,
): Promise<OwnerSignatureResult> {
  // 0x + r(32) + s(32) + v(1) = 132 chars.
  if (!isHex(signatureHex) || signatureHex.length !== 132) {
    return { address: '', valid: false };
  }
  try {
    const address = await recoverMessageAddress({
      message: { raw: message },
      signature: signatureHex,
    });
    return { address: address.toLowerCase(), valid: true };
  } catch {
    return { address: '', valid: false };
  }
}
```


- [ ] **Step 4: Rewrite `packages/cli/src/identity.ts`**

Delete `loadPemPrivateKey`, `pemIdentity`, `PrivateKeyLike`, `signerPublicKeyHex`
and `signerAccountHash`. Replace with:

```ts
import { privateKeyToAccount } from 'viem/accounts';
import { mockAccountAddress } from '@agentgate/chain';
import type { AnySigner } from '@agentgate/shared';
import { AgentGateError } from '@agentgate/shared';

const PRIVATE_KEY_RE = /^0x[0-9a-f]{64}$/i;

function requireKey(signer: AnySigner): `0x${string}` {
  if (signer.kind !== 'key') {
    throw new AgentGateError(
      'SIGNER_UNSUPPORTED',
      'this command needs a key signer (live mode) — pass --key <0x…> or set SELLER_SIGNER_KEY',
      400,
    );
  }
  if (!PRIVATE_KEY_RE.test(signer.privateKey)) {
    // NEVER echo the key itself.
    throw new AgentGateError(
      'SIGNER_KEY_INVALID',
      'signer key must be a 0x-prefixed 32-byte hex private key',
      400,
    );
  }
  return signer.privateKey as `0x${string}`;
}

/**
 * The address a signer acts as — also the default payment target.
 * mock → `mockAccountAddress(publicKey)` (the derivation the devnet uses);
 * key  → the account address derived from the private key.
 */
export async function signerAddress(signer: AnySigner): Promise<string> {
  if (signer.kind === 'mock') return mockAccountAddress(signer.publicKey);
  return privateKeyToAccount(requireKey(signer)).address.toLowerCase();
}

/**
 * Signs `message` for the gateway's owner-signature self-map auth (EIP-191).
 * Only key signers can sign — mock mode uses the admin-token path.
 */
export async function signMessage(
  signer: AnySigner, message: Uint8Array,
): Promise<{ signatureHex: string }> {
  const account = privateKeyToAccount(requireKey(signer));
  return { signatureHex: await account.signMessage({ message: { raw: message } }) };
}
```

- [ ] **Step 5: Update the self-map handler and CLI caller**

In `packages/middleware/src/app.ts`, in the `/services/:id/map` handler: drop
`publicKeyHex` from the destructured body and its `typeof` guard, then replace
the verification with:

```ts
      const { address, valid } = await recoverSigner(
        buildSelfMapMessage({ network: chain.network, serviceId: id, upstreamUrl, timestamp }),
        signatureHex,
      );
      if (!valid || !sameAddress(address, service.owner)) {
        res.status(401).json({ error: 'not_service_owner' });
        return;
      }
```

In `packages/cli/src/wrap.ts`, remove `publicKeyHex` from the POST body.
In `packages/shared/src/self-map.ts`, update the `network` doc to
`/** 0G network name (e.g. "0g-galileo") — prevents cross-network replay. */`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run packages/chain/test/signature.test.ts packages/cli packages/middleware`
Expected: PASS. Fix any middleware test that still posts `publicKeyHex`.

- [ ] **Step 7: Commit**

```bash
git add packages/chain/src/signature.ts packages/chain/test/signature.test.ts \
        packages/cli/src packages/middleware/src packages/shared/src/self-map.ts \
        packages/middleware/test packages/cli/test
git commit -m "feat(auth): EIP-191 owner signatures replace Casper PEM signing"
```

---

## Task 13: Middleware, client and buyer-agent wiring

**Files:**
- Modify: `packages/middleware/src/app.ts` (drop the v2 facilitator branch; rename units/fields)
- Modify: `packages/shared/src/x402.ts` — delete `HEADER_PAYMENT_SIGNATURE` once
  you remove its only call site. It is vestigial facilitator-rail plumbing; Task 8
  left it in place with a comment saying it dies here, but `x402.ts` was not in
  any task's file list, so without this line it would outlive the block that
  uses it as permanent dead code.
- Modify: `packages/middleware/src/invoice-store.ts`, `invoice-store-file.ts`
- Modify: `packages/client/src/index.ts` (full rewrite of the Casper-x402 half)
- Modify: `packages/client/package.json` (drop `@make-software/casper-x402`, `casper-js-sdk`)
- Modify: `packages/buyer-agent/src/{index,main}.ts`
- Modify: the corresponding tests in each package's `test/` — **including these
  specific fixture defects, which are not findable by grepping identifiers:**
  - `packages/client/test/client.test.ts:16` defines `DEPLOY_HASH = 'd'.repeat(64)`
    — a bare 64-hex Casper deploy hash with no `0x`. Task 8 tightened
    `TX_HASH_RE` to `/^0x[0-9a-fA-F]{64}$/`, so `decodeXPayment` now correctly
    rejects it with "payload.transaction must be a 0x-prefixed 32-byte
    transaction hash". These failures are **not** fixed by repairing `app.ts`'s
    imports — they need the fixtures 0x-prefixed and renamed off "deploy".
  - `packages/buyer-agent/test/buyer-agent.test.ts:110` fails the same way,
    transitively through `packages/client/src/index.ts:256,350`.
  - Sweep both files for any other bare-64-hex or `account-hash-` literal.

**Interfaces:**
- Consumes: Tasks 7, 8, 10, 12.
- Produces: a gateway whose `/svc/:id` issues a 402 carrying `router` + `nonce`, verifies via `chain.verifyTransfer({ txHash, expectedNonce, … })`, and attests with `paymentTxHash`.

- [ ] **Step 1: Delete the facilitator rail from the gateway**

In `packages/middleware/src/app.ts` remove: `facilitatorConfigFor`,
`buildV2Requirements`, `send402V2`, the entire `X402_VERSION_V2` request branch
(the block ending at `packages/middleware/src/app.ts:643` in the current file),
and every `facilitator*` import. Delete the matching tests in
`packages/middleware/test/`.

- [ ] **Step 2: Update `buildRequirements`**

```ts
  function buildRequirements(
    service: ServiceRecord, nonce: string, expiresAt: number, resource: string,
  ): PaymentRequirements {
    return {
      scheme: X402_SCHEME,
      network: chain.network,
      maxAmountRequired: service.priceWei,
      asset: X402_ASSET_OG,
      payTo: service.paymentTarget,
      resource,
      description: service.name,
      maxTimeoutSeconds: Math.floor(config.invoiceTtlMs / 1000),
      extra: {
        nonce,
        serviceId: service.id,
        expiresAtMs: expiresAt,
        settlement: '0g-payment-router',
        // The buyer MUST pay through this router — a bare transfer carries no
        // nonce and can never be matched back to this invoice.
        router: config.paymentRouterAddress,
        nonceEncoding: 'uint256-decimal',
      },
    };
  }
```

- [ ] **Step 3: Update the verification call and the self-payment guard**

```ts
      const txHashHeader = payment.payload.transaction;
      const nonceHeader = payment.payload.transferId;
      …
      const verdict = await chain.verifyTransfer({
        txHash: txHashHeader,
        serviceId: service.id,
        expectedTarget: service.paymentTarget,
        minAmountWei: service.priceWei,
        expectedNonce: nonceHeader,
        maxAgeMs: config.invoiceTtlMs,
      });
```

Replace `isSelfPayment`'s account-hash normalisation
(`packages/middleware/src/app.ts:146-150`) with `sameAddress` from
`@agentgate/chain`:

```ts
  /** A payer that is the service owner or its payout account is wash-trading. */
  function isSelfPayment(payer: string, service: ServiceRecord): boolean {
    return sameAddress(payer, service.owner) || sameAddress(payer, service.paymentTarget);
  }
```

Rename `invoice.priceMotes` → `priceWei` in `invoice-store.ts` and the
persisted-shape validator in `invoice-store-file.ts:85`.

`scheduleAttestation(service, txHashHeader, success)` now feeds
`recordAttestation({ serviceId, paymentTxHash, success })` — update
`packages/middleware/src/attestation-queue.ts` and `attestation-queue-file.ts`
field names to match (`payment_deploy_hash` → `payment_tx_hash` in the persisted
JSON; bump the file-format version if one exists, otherwise document that old
queue files are not read).

- [ ] **Step 4: Rewrite the payment half of `packages/client/src/index.ts`**

Delete the `@make-software/casper-x402` imports, `ExactCasperScheme`,
`createClientCasperSigner`, `ClientCasperSigner`, `KeyAlgorithm`, the
`PAYMENT-SIGNATURE` retry branch, `ACCOUNT_HASH_RE` and `V2_ADDRESS_RE`.
The buyer now pays by calling `chain.transfer(...)`:

```ts
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// …in the invoice validator:
    if (!ADDRESS_RE.test(reqs.payTo)) {
      throw badInvoice('payTo must be a 0x-prefixed EVM address');
    }
    if (typeof reqs.extra?.router !== 'string' || !ADDRESS_RE.test(reqs.extra.router)) {
      throw badInvoice('extra.router must be the PaymentRouter address');
    }

// …in the pay step:
    const { txHash } = await chain.transfer({
      to: reqs.payTo,
      amountWei: reqs.maxAmountRequired,
      nonce: reqs.extra.nonce,
      serviceId: reqs.extra.serviceId,
    }, signer);
    const header = encodeXPayment({
      x402Version: X402_VERSION, scheme: X402_SCHEME, network: reqs.network,
      payload: { transaction: txHash, transferId: reqs.extra.nonce },
    });
```

- [ ] **Step 5: Update the buyer agent and re-scale the orphaned 9dp fixtures**

In `packages/buyer-agent/src/{index,main}.ts` rename `priceMotes`→`priceWei`,
`csprToMotes`→`ogToWei`, `formatCspr`→`formatOg`, `buyerBudgetCspr`→`buyerBudgetOg`,
and the budget log strings from `CSPR` to `OG`. Also rename the LLM-prompt key
`priceCspr` at `packages/buyer-agent/src/llm.ts:253` to `priceOg` — its value is
already rendered by `formatOg`, so the key currently contradicts the string it
holds.

**Then re-scale the money fixtures these packages' tests hardcode at the old
9-decimal scale.** Task 6 changed the native unit from motes (1e9) to wei (1e18)
but its sweep was identifier-based, so it could not find fixtures that contain
only a numeric literal. These are the ones left, each a price literal that used
to mean ~0.5 CSPR and now means ~5e-10 OG:

| File | Fixtures |
|---|---|
| `packages/buyer-agent/test/buyer-agent.test.ts:27` | `makeService()` `priceMotes: '500000000'` |
| `packages/cli/test/buy.test.ts:173-200` | `priceMotes` `'500000000'`, `'400000000'`, `'900000000'` |
| `packages/cli/test/cli.test.ts:174` | expects `reg.input.priceMotes === '500000000'` |
| `packages/cli/test/cli.test.ts:374` | faucet expects `'1000000000000'` |

Multiply each by 1e9 to keep the same OG-denominated meaning (`'500000000'` →
`'500000000000000000'` = 0.5 OG), and rename the fixture fields to `priceWei`
along with the type change from Task 7. Every one of these must be ≥
`MIN_PRICE_WEI` (1e12) or it would be rejected by the real contract.

- [ ] **Step 6: Run the tests**

Run: `npm run typecheck && npx vitest run`
Expected: PASS everywhere except `packages/devnet` (Task 14) and the dashboard
(Task 15). Fix any remaining `Motes`/`account-hash` references the typechecker
surfaces in these three packages.

- [ ] **Step 7: Commit**

```bash
git add packages/middleware packages/client packages/buyer-agent
git commit -m "feat(gateway): 402 flow settles through PaymentRouter, facilitator rail removed"
```

---

## Task 14: Devnet and mock-mode address alignment

**Files:**
- Modify: `packages/devnet/src/state.ts`, and any sibling in `packages/devnet/src/`
- Modify: `packages/chain/src/mock.ts`
- Modify: `packages/devnet/test/`, `packages/chain/test/mock-client.test.ts`

**Interfaces:**
- Produces: `mockAccountAddress(publicKey) -> string` (replaces `mockAccountHash`), returning `0x` + the first 40 hex of `sha256(publicKey)` so mock mode and live mode share one address shape.

- [ ] **Step 1: Write the failing test**

In `packages/chain/test/mock-client.test.ts`:

```ts
import { mockAccountAddress } from '../src/mock';
import { isAddress } from '../src/address';

describe('mockAccountAddress', () => {
  it('derives a well-formed EVM address deterministically', () => {
    const a = mockAccountAddress('buyer-key');
    expect(isAddress(a)).toBe(true);
    expect(a).toBe(mockAccountAddress('buyer-key'));
    expect(a).not.toBe(mockAccountAddress('seller-key'));
  });

  it('is lowercase, matching normalizeAddress output', () => {
    expect(mockAccountAddress('x')).toBe(mockAccountAddress('x').toLowerCase());
  });

  it('rejects an empty public key', () => {
    expect(() => mockAccountAddress('')).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run packages/chain/test/mock-client.test.ts`
Expected: FAIL — `No "mockAccountAddress" export is defined`.

- [ ] **Step 3: Implement**

In `packages/chain/src/mock.ts` and `packages/devnet/src/state.ts` — both must
use the **same** derivation or mock mode breaks:

```ts
/**
 * Mock address derivation used by the devnet: `0x` + first 20 bytes of
 * sha256(publicKey). Not a real EVM key derivation — mock signers carry no key
 * material — but it yields the same 0x<40hex> SHAPE as live mode, so every
 * address code path is exercised identically in both modes.
 */
export function mockAccountAddress(publicKey: string): string {
  if (typeof publicKey !== 'string' || publicKey.trim() === '') {
    throw new AgentGateError('invalid_public_key', 'publicKey must be a non-empty string', 400);
  }
  return `0x${createHash('sha256').update(publicKey).digest('hex').slice(0, 40)}`;
}
```

In `packages/devnet/src/state.ts` replace `ACCOUNT_HASH_RE` with
`/^0x[0-9a-f]{40}$/`, rename `deployHash`→`txHash`, `transferId`→`nonce`,
`amountMotes`→`amountWei`, and `formatCspr`→`formatOg` in the activity `detail`
strings.

**Also rename `priceMotes`→`priceWei` on the devnet wire** (`state.ts:69,87,213,
214,234`). This one is load-bearing and currently breaks the whole e2e suite:
`packages/chain/src/mock.ts:245` spreads `...input` verbatim into the devnet, so
once Task 13 corrected `wrap.ts` to emit the type's real field (`priceWei`), the
devnet — still reading `priceMotes` — sees `undefined` and every registration
fails. `e2e/loop.test.ts` is 10/10 red until this lands. `mock.ts` needs no
translation shim; it needs the two sides to agree on one name. Rename every `mockAccountHash` occurrence repo-wide:

```bash
rg -l 'mockAccountHash' packages dashboard scripts --glob '!node_modules'
```

The devnet's mock transfer records must also carry `serviceId` so its
`verifyTransfer` mirrors the router's semantics.

**Close the self-payment gap this task is the fix for.** While mock identities
are `account-hash`-shaped, `sameAddress` (which needs `0x<40hex>` on both sides)
returns false for every mock payer, so the F1 wash-trade guard at
`packages/middleware/src/app.ts:582` is a no-op on the demo path. Task 13 left a
`TODO(task-14)` at `app.ts:126` naming this dependency. Once `mockAccountAddress`
produces `0x` identities:
1. delete that TODO, and
2. restore `packages/middleware/test/self-payment.test.ts` so it asserts the
   guard actually fires for a mock payer that *is* the owner or the payout
   account — Task 13 had to weaken that case to document the gap rather than
   bless it, and leaving it weakened would let a real wash-trade regression pass.

**Make mock-mode attestation replay idempotent — live mode now is, and the
attestation queue's whole crash-recovery design depends on it.**

`packages/middleware/src/attestation-queue.ts:9-13` states that replay is safe
"because the registry contract dedups by `(service_id, payment_tx_hash)`, so
re-submitting an already-recorded attestation is an idempotent no-op on-chain",
and the queue drops an entry only once its attempt confirms, with an unbounded
retry. Task 10 made that true in live mode: `Live0gClient.recordAttestation`
treats a `DuplicateAttestation` revert as success (the desired end state already
holds) while every other revert still throws.

Mock mode does not do this, and never did: `packages/devnet/src/state.ts:269-276`
throws `duplicate_attestation`, and `packages/chain/src/mock.ts`'s
`recordAttestation` propagates it. So after any gateway restart in mock mode, an
already-recorded pending attestation replays, throws, is never dropped, and
replays again on the next boot — forever. This is a **pre-existing** bug, not one
Task 10 introduced, but it is now a mock/live divergence in a path the demo runs.

Make `MockChainHttpClient.recordAttestation` resolve when the devnet reports
`duplicate_attestation`, mirroring the live client, and add a test asserting a
replayed attestation resolves with the score unchanged. Every other devnet error
must keep propagating.

**Restore the price-floor mirror, which the unit change silently broke.**
`packages/devnet/src/state.ts:16` declares `MIN_PRICE_MOTES = 1000n` under a
comment that reads *"Mirrors the on-chain contract"*. That mirror is now wrong by
a factor of 1e9: at 18 decimals 1000 wei is 1e-15 OG, while the deployed
`AgentGateRegistry.MIN_PRICE_WEI` is `1e12` (1e-6 OG). Mock mode would therefore
accept a service price the real chain rejects — the exact class of mock/live
divergence that makes a live demo fail after a green local run. Replace it:

```ts
/** Mirrors the on-chain contract: price must be ≥ 1e12 wei (1e-6 OG).
 *  Keep this in sync with AgentGateRegistry.MIN_PRICE_WEI. */
export const MIN_PRICE_WEI = 1_000_000_000_000n;
```

Update the comparison and its error message at `packages/devnet/src/state.ts:213-214`
(`priceWei must be ≥ ${MIN_PRICE_WEI} wei`), and add a devnet test pinning both
sides of the boundary — `1e12 - 1n` rejected, `1e12` accepted — mirroring the
contract's own `test_registerService_revertsBelowMinPrice` /
`test_registerService_acceptsExactlyMinPrice` pair. No existing test approaches
this boundary, which is why the regression was invisible.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run && npm run typecheck`
Expected: PASS for every package. The dashboard is Next.js and is covered in
Task 15, but `npm run typecheck` includes it — expect remaining errors there only.

- [ ] **Step 5: Commit**

```bash
git add packages/devnet packages/chain
git commit -m "refactor(devnet): mock mode uses 0x address shape, matching live"
```

---

## Task 15: Dashboard, docs, README and end-to-end demo

**Files:**
- Modify: `dashboard/components/tx-hash.tsx`, `activity-feed.tsx`, `service-detail.tsx`, `nav.tsx`, `dashboard/lib/{format,version}.ts`, `dashboard/app/page.tsx`
- Modify: `dashboard/app/api/services/route.ts`, `dashboard/app/api/services/[id]/route.ts` — **these two carry live facilitator code, not just prose**
- Modify: all 16 pages under `dashboard/app/docs/`
- Modify: `README.md`, `e2e/loop.test.ts`, `scripts/{dev,live,demo,smoke-live-read}.ts`, `.github/workflows/ci.yml`, `docs/**`, `SECURITY.md`, `CONTRIBUTING.md`
- Modify: `packages/cli/package.json` (description + keywords)

**Interfaces:**
- Consumes: everything above.
- Produces: a dashboard that links to `chainscan-galileo.0g.ai` and docs with no Casper references.

- [ ] **Step 1: Fix the explorer link**

In `dashboard/components/tx-hash.tsx`, the doc comment and link become:

```tsx
/**
 * Tx hash rendering:
 * - mock network → plain mono text (nothing to link to)
 * - live network → link to https://chainscan-galileo.0g.ai/tx/<hash>
 */
```

and the guard/href:

```tsx
  if (network === 'mock' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
```
```tsx
      href={`https://chainscan-galileo.0g.ai/tx/${encodeURIComponent(hash)}`}
```

Add a sibling `AddressLink` for `0x<40hex>` values pointing at
`https://chainscan-galileo.0g.ai/address/<addr>`, and use it wherever
`service-detail.tsx` currently renders a raw payment target or owner.

- [ ] **Step 1b: Strip the facilitator rail from the dashboard API routes**

These two routes are the only *executable* dashboard code that depends on the
dropped facilitator rail, and no earlier task touches them:

- `dashboard/app/api/services/[id]/route.ts:2,47-48`
- `dashboard/app/api/services/route.ts:2,17-18`

Both import `facilitatorConfigFromAccepts` (deleted in Task 8) and read
`config.facilitatorServices` (removed in Task 7), and `[id]/route.ts` also
imports the deleted `Motes` type. Remove the `fac` derivation and whatever
response field it feeds. The per-service multi-asset price list still comes from
the on-chain `accepts[]` on `ServiceRecord`, so the catalog keeps its price
display without the facilitator layer — do not delete `accepts` handling, only
the facilitator config that used to override it.

Note for whoever runs this: both files also have uncommitted edits in the
repo owner's main checkout, so coordinate before assuming the version here is
the only one.

- [ ] **Step 1a: Teach CI about the new toolchain — it currently cannot run any of it**

`.github/workflows/ci.yml` installs Node (and Rust, for the Odra contracts Task 11
deletes). It has **no Foundry**, which means:

- The 21 tests in `packages/chain/test/live-0g-reads.test.ts` and
  `live-0g-writes.test.ts` — the entire verification of the live chain client —
  **fail at `beforeAll`** on CI rather than skipping, because they spawn `anvil`
  and shell out to `forge create`.
- `forge test` never runs at all, so the 42 contract tests that are the
  foundation of this migration are invisible to CI.
- The Rust/`Swatinem/rust-cache` step still builds a toolchain for contracts that
  no longer exist after Task 11.

Add `foundry-rs/foundry-toolchain@v1` to the Node job, add a `forge test` step
running in `contracts-evm/`, and drop the Rust job. Then confirm the two
`live-0g-*` suites actually pass in CI rather than being quietly skipped — a
suite that cannot run looks identical to a suite with nothing to say.

- [ ] **Step 1c: Sweep `docs/` and `SECURITY.md`, which the Step 2 grep misses**

No task owns any file under `docs/`, and Step 2's sweep list does not include it.
The concrete defect found there: `docs/DEPLOY-GATEWAY.md:70` is the only operator
key-hardening guidance in the repo and it describes protecting a **mode-600 PEM
file**. Under 0G the gate key is a raw hex string in `GATE_SIGNER_KEY`
(`packages/shared/src/config.ts:183`, `.env.example:26`) — a materially different
threat model, because an env var leaks through `docker inspect`,
`/proc/<pid>/environ`, platform dashboards and crash dumps, none of which a
chmod-600 file does. An operator following these docs would harden a file nothing
reads while the real key sits unprotected in the process environment.

Rewrite that guidance for env-var secrets, and run the Step 2 substitutions over
every file under `docs/` plus `SECURITY.md` and `CONTRIBUTING.md`.

Two specific falsified-by-deletion instructions to fix, both telling a
contributor to run a command against a directory Task 11 removed:
`docs/TESTING.md:17,46,47,173,199` and `CONTRIBUTING.md:22,33` still say
`cd contracts/agentgate-registry && cargo odra test`, and `docs/TESTING.md:173`
still lists `cargo odra test (registry / spend-guard) | 20 / 25 passed` as the
contract gate. CI now runs `forge test` in `contracts-evm/` (42 tests) — make the
docs say so.

Also `dashboard/app/api/activity/route.ts:11-15,37` justifies its 30s cache by
"several CSPR.cloud reads" and the "CSPR.cloud daily quota"/429s. That rationale
is dead: `listRecentActivity` is now three `eth_getLogs` plus at most `limit`
`getBlock` calls against a public RPC with no quota. Keep the cache if you like,
but the comment must stop citing a service the project no longer uses.

- [ ] **Step 2: Sweep the remaining references**

```bash
cd "$(git rev-parse --show-toplevel)"   # the worktree root — never a hardcoded checkout path
rg -ni 'casper|cspr|motes|account-hash|deploy.?hash|odra|WCSPR|CEP-18|facilitator' \
  README.md dashboard packages scripts e2e .env.example \
  --glob '!node_modules' --glob '!*.lock' --glob '!package-lock.json'
```

Work the list to zero. Substitutions: `Casper`→`0G`, `CSPR`→`OG`,
`motes`→`wei`, `account-hash`→`address`, `deploy hash`→`tx hash`,
`testnet.cspr.live`→`chainscan-galileo.0g.ai`, `Odra`→`Solidity`.
The README tagline becomes **"Stripe for AI agents on 0G"**; update the badge
(`Casper Testnet live` → `0G Galileo Testnet live`), the contract link (to
`chainscan-galileo.0g.ai/address/<registry>`), and the "Deployed addresses"
section with all three contracts. Remove the WCSPR/facilitator bullet from
"What is AgentGate" and replace it with the honest native-only line, plus a new
bullet noting reads now need no API key at all.

- [ ] **Step 3: Update the docs pages**

Each page under `dashboard/app/docs/` carries prose plus copy-pasteable
snippets. Beyond the substitutions above, these need real edits:
- `configuration/page.tsx` — the whole env table (47 Casper references): replace
  the Casper/CSPR.cloud/facilitator rows with the `ZG_*`, `*_ADDRESS`,
  `*_SIGNER_KEY`, `ACTIVITY_LOOKBACK_BLOCKS` rows from `.env.example`.
- `contract/page.tsx` — replace the Odra ABI with the Solidity interfaces from
  design doc §8, all three contracts.
- `protocol/page.tsx` — the 402 body sample gains `router`/`nonceEncoding` and
  loses `transferIdEncoding`; add the `PaymentRouter.pay` call to the sequence.
- `sellers/page.tsx`, `buyers/page.tsx`, `cli/page.tsx`, `installation/page.tsx`
  — `--pem <path>` becomes `--key <0x…>`; add the faucet link.
- `architecture/page.tsx` — CSPR.cloud box becomes "public RPC (`eth_getLogs`)".
- `changelog/page.tsx` — add a `0.3.0` entry: "Migrated from Casper Testnet to 0G
  Galileo Testnet. Contracts rewritten in Solidity; payments settle through
  PaymentRouter; the CSPR.cloud indexer dependency and the WCSPR facilitator rail
  are removed." Bump `packages/cli/package.json` to `0.3.0` and rewrite its
  `description`/`keywords` (drop `casper`, add `0g`, `evm`).

- [ ] **Step 4: Run the whole suite**

```bash
npm run typecheck && npx vitest run && npm run build && (cd contracts-evm && forge test)
```

Expected: all green. `npm run build` is the Next.js production build — it will
catch any dashboard type error the workspace typecheck missed.

- [ ] **Step 5: Prove the loop end to end on 0G**

```bash
# fund the seller and buyer keys at https://faucet.0g.ai first
AGENTGATE_MODE=live npm run dev:live
# in a second shell:
npx tsx packages/cli/src/bin.ts list
npx tsx packages/cli/src/bin.ts wrap --key "$SELLER_SIGNER_KEY" \
  --name demo --upstream http://localhost:4010/price --price 0.001
npx tsx packages/cli/src/bin.ts buy 1 --key "$BUYER_SIGNER_KEY"
```

Expected: `wrap` prints a service id and a `chainscan-galileo.0g.ai` link;
`buy` prints a 402, pays through the router, returns the upstream body, and the
dashboard activity feed shows registration → payment → attestation. Record the
three tx hashes in `contracts-evm/README.md` as the demo trail.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs(0g): dashboard, docs and README migrated off Casper to 0G Galileo"
```

---

## Task 16: The CLI user-facing surface

> **Added mid-execution.** The original plan had no task that rewrote the CLI's
> own command surface. Task 15 Step 3 says to update the docs so `--pem <path>`
> becomes `--key <0x…>`, and Task 15 Step 5's live demo literally runs
> `agentgate wrap --key "$SELLER_SIGNER_KEY"` — but nothing anywhere made
> `--key` exist. `packages/cli/src/bin.ts` is 428 lines with 35 Casper-flavoured
> lines and still constructs `{ kind: 'pem', pemPath }` signers that no longer
> typecheck against Task 7's `AnySigner`. **Run this after Task 14 and before
> Task 15**, or the demo cannot run.

**Files:**
- Modify: `packages/cli/src/bin.ts`
- Modify: `packages/cli/src/validate.ts`
- Modify: `packages/cli/src/mcp.ts` — **the MCP tool surface, a headline feature
  in the README ("any MCP-capable agent gets discover / inspect / pay as native
  tools"), and owned by no task until now.** It still tells MCP clients that
  `agentgate_buy` pays "with a native CSPR transfer (the invoice nonce rides
  transfer_id)" — a description of the *Casper* mechanism that no longer exists;
  exposes a `maxCspr` parameter; reads `result.facilitator`, which Task 13
  deleted; and carries a `buyerKeyAlgo` field for "the facilitator (x402 v2)
  rail". Retarget the tool descriptions to the PaymentRouter flow, rename
  `maxCspr` → `maxOg`, and drop the facilitator branch. An agent reading these
  descriptions is the primary consumer — a stale one mis-describes what spending
  the user's key actually does.
  Both files also still read `ServiceRecord.priceMotes`, a field that no longer
  exists (`packages/shared/src/types.ts:24` has only `priceWei`) — `bin.ts:195,256,311`,
  `mcp.ts:85,115,160,207`, and `packages/cli/test/mcp.test.ts:23`. These are
  display/diagnostic paths, so they print `undefined` rather than crashing, which
  is why no test caught them.
- Modify: `packages/cli/test/mcp.test.ts`
- Modify: `packages/cli/src/cli-env.ts` + `packages/cli/test/cli-env.test.ts` —
  **the CLI's entire flag→config bridge, owned by no task until now.**
  `resolveCliEnv` still writes five env keys `loadConfig` stopped reading in
  Task 7: `REGISTRY_CONTRACT_PACKAGE_HASH` (:40-41), `CASPER_NODE_URL` (:43),
  `SELLER_SIGNER_PEM_PATH` (:44), `CSPR_CLOUD_API_KEY` (:45), `BUYER_KEY_ALGO`
  (:47). Rename them to `REGISTRY_CONTRACT_ADDRESS` (default
  `DEFAULT_REGISTRY_ADDRESS`), `ZG_RPC_URL` and `SELLER_SIGNER_KEY`; delete the
  last two with their `apiKey?`/`keyAlgo?` flag fields and the `--api-key`
  (`bin.ts:286`, message at `:317`) and `--key-algo` (`bin.ts:94`) registrations.
  Line 1 imports the deleted `DEFAULT_REGISTRY_PACKAGE_HASH`, so the package
  cannot typecheck.

  > **The existing test lies about this.** `cli-env.test.ts` passes 5/5 today
  > *because* it imports the same deleted constant: the import resolves to
  > `undefined`, `pick(..., undefined)` never writes the key, and `:9`'s
  > `expect(out.REGISTRY_CONTRACT_PACKAGE_HASH).toBe(DEFAULT_REGISTRY_PACKAGE_HASH)`
  > degenerates to `undefined === undefined`. Do not trust a green run of this
  > file as evidence of anything until the import is fixed. Its assertions at
  > `:9,:18,:34-38` actively pin the dead key names — rewrite them, do not
  > preserve them.

- Modify: `packages/cli/src/bin.ts:389-390` — reads `result.buyer.balanceMotes` /
  `result.seller.balanceMotes`, which Task 14 renamed to `balanceWei` (the field
  holds wei). These are the two typecheck errors Task 14 could not fix because
  `bin.ts` is yours. **If you miss them, `agentgate demo-accounts` crashes in
  `formatOg(undefined)`** rather than failing loudly — the field simply reads
  undefined at runtime.
- Modify: `packages/cli/src/pause.ts:45` — the `not_authorized` message tells the
  seller to set `SELLER_SIGNER_PEM_PATH`, which `loadConfig` no longer reads.
  This is the message shown at the exact moment someone is working out which key
  to sign with, so it sends them to set a variable with no effect.
- Modify: `packages/cli/README.md` — **this is the published npm package page**
  (`package.json` `files` lists it), i.e. the security guidance a seller reads
  before typing a command that spends real funds. Line 65 currently says
  `` `--pem` is a **path**, not a secret — safe in shell history ``. That was
  true for a PEM path; it is dangerous for `--key <0xhex>`, which carries the
  live private key itself. Invert it: `--key` **is** a secret, visible in shell
  history and `ps`, and the env var is the preferred path. Also update the flag
  table (`--registry`/`--pem`/`--max <cspr>`/`--api-key` rows) and the
  `SIGNER_MISSING` example message below it.
- Modify: `packages/cli/src/wrap.ts:38,40,127-134`
- Test: `packages/cli/test/cli-env.test.ts`, `packages/cli/test/cli.test.ts`

**Interfaces:**
- Consumes: `AnySigner = SignerRef | KeySignerRef` (Task 7), `signerAddress` (Task 12), `ogToWei` (Task 6), `normalizeAddress` (Task 7).
- Produces: a CLI whose flags, env fallbacks, help text and validators all speak 0G.

- [ ] **Step 1: Write the failing tests**

In `packages/cli/test/cli-env.test.ts`, assert the signer resolution: `--key 0x…`
wins over `SELLER_SIGNER_KEY`; a missing key in live mode errors naming `--key`
and `SELLER_SIGNER_KEY` (never `--pem`); and **the error never contains the key
value**. Add a `validate.ts` test that `requireAddress` accepts a checksummed and
a lowercase `0x<40hex>` and rejects `account-hash-…`, a Casper public key
(`01…`), and a 0x-prefixed 64-hex value.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run packages/cli/test/cli-env.test.ts`
Expected: FAIL — `--key` is not a recognised option.

- [ ] **Step 3: Replace the Casper validators**

In `packages/cli/src/validate.ts`, delete `ACCOUNT_HASH_RE` and `PUBLIC_KEY_RE`
with their `requireAccountHash` / `requirePublicKeyHex` functions. Add one
replacement used by both call sites:

```ts
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Validates a `0x<40 hex>` EVM address and returns it lowercased. */
export function requireAddress(value: string, label: string): string {
  const trimmed = requireNonEmpty(value, label);
  if (!ADDRESS_RE.test(trimmed)) {
    throw invalid(
      'INVALID_ADDRESS',
      `${label} must be a 0x-prefixed EVM address, got ${JSON.stringify(value)}`,
    );
  }
  return trimmed.toLowerCase();
}
```

- [ ] **Step 4: Fix the wrap.ts shape mismatch**

`packages/cli/src/wrap.ts:127-134` currently validates explicitly-passed values
with the Casper validators while deriving the default from `signerAddress`,
which now returns `0x…`. So `--payment-target 0x…` is rejected while the default
works — the explicit and implicit paths disagree. Point both at `requireAddress`,
and fix the stale docstrings at `wrap.ts:38` (`"account-hash-<64hex>"`) and
`wrap.ts:40` (`"Public key hex…"`).

- [ ] **Step 5: Rewrite the CLI surface**

In `packages/cli/src/bin.ts`:

| Before | After |
|---|---|
| `.option('--pem <path>', 'seller signer PEM path …')` | `.option('--key <0xhex>', 'seller signer private key (or set SELLER_SIGNER_KEY)')` |
| `.option('--pem <path>', 'buyer signer PEM path …')` | `.option('--key <0xhex>', 'buyer signer private key (or set BUYER_SIGNER_KEY)')` |
| `{ kind: 'pem', pemPath: config.sellerSignerPemPath }` (line 52) | `{ kind: 'key', privateKey: config.sellerSignerKey }` |
| `{ kind: 'pem', pemPath }` (line 76) | `{ kind: 'key', privateKey }` |
| `SELLER_SIGNER_PEM_PATH` / `BUYER_SIGNER_PEM_PATH` in messages | `SELLER_SIGNER_KEY` / `BUYER_SIGNER_KEY` |
| `--price <cspr>` … `'price per call in CSPR (e.g. 0.5)'` | `--price <og>` … `'price per call in OG (e.g. 0.5)'` |
| `--max <cspr>` … `'refuse invoices priced above this many CSPR'` | `--max <og>` … `'… this many OG'` |
| `'payment target account-hash (default: derived from the seller signer)'` | `'payment target address (default: derived from the seller signer)'` |
| `'--attestor <publicKeyHex>'` | `'--attestor <address>'` |
| `'pay its 402 invoice with a native CSPR transfer'` | `'pay its 402 invoice through the PaymentRouter contract'` |
| the `CSPR.cloud key` comment (line 98) | drop it — reads need only a public RPC now |

**Security:** a private key arrives as a CLI argument, so it is visible in the
process list. Keep the env var as the documented path and say so in the `--key`
help text. Never echo a key value in an error, a log line, or `--help` output.

- [ ] **Step 6: Run the tests**

Run: `npm run typecheck -w agentgate-0g && npx vitest run packages/cli`
Expected: `packages/cli` typecheck errors drop sharply (they were 85 after
Task 12, most of them the `kind:'pem'` constructions), and the CLI suites pass.

- [ ] **Step 7: Commit**

```bash
cd "$(git rev-parse --show-toplevel)"
git add packages/cli
git commit -m "feat(cli): 0G command surface — --key, OG prices, EVM addresses"
```

---

## Self-Review

Run before declaring the plan done:

**1. Spec coverage** — every design-doc section maps to a task:
§2 network → T5 Step 1 · §3 replacement table → T1-T5, T9-T11 · §4 units → T6 ·
§4 addresses → T7 · §4 timestamps → T1/T3/T4 (`_nowMs`) · §5 payment flow →
T3, T10, T13 · §6 x402 wire → T8, T13 · §7 signatures → T12 · §8 contract
interfaces → T1-T4 · §9 reads without an indexer → T9, T11 · §10 out of scope →
no task (correct).

**2. Known gaps deliberately left open:**
- `SpendGuard` is ported and tested but stays unintegrated, exactly as today
  (`contracts/README.md`). No task wires `debit` into the request path.
- `packages/oracle` needs no change — it serves data, never touches the chain.
- The faucet's 0.1 OG/day cap may force T5 Step 4 across two days. Flag early.

**3. Type consistency** — names used across task boundaries:
`Wei` (T7) · `priceWei` (T7→T9,T13) · `paymentTxHash` (T7→T10,T13) ·
`VerifyTransferQuery.{txHash,minAmountWei,expectedNonce}` (T7→T10,T13) ·
`transfer({to,amountWei,nonce,serviceId})→{txHash}` (T7→T10,T13) ·
`KeySignerRef.privateKey` (T7→T10,T12) · `recoverSigner` **async** (T12→T12 Step 5) ·
`mockAccountAddress` (T14→T11 index.ts, T12 identity.ts) ·
`normalizeAddress`/`sameAddress`/`shortAddress` (T7→T9,T11,T13) ·
`formatOg`/`ogToWei`/`weiToOg` (T6→T11,T13,T14).

> Two forward references are intentional and called out in place:
> `packages/chain/src/index.ts` (T11 Step 4) exports `mockAccountAddress` and
> `recoverSigner` before T12/T14 define them. Executing in order, leave the old
> names in T11 and fix them in T12/T14, or execute T11 Step 4 last.
