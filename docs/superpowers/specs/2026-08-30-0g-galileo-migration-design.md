# AgentGate → 0G Galileo Testnet Migration — Design

**Status:** locked (2026-08-30)
**Supersedes:** the Casper Testnet chain layer in its entirety.

---

## 1. Decision summary

| Question | Decision |
|---|---|
| Strategy | **Full replacement.** Casper is removed, not kept as a second mode. `AGENTGATE_MODE` stays `mock \| live`; `live` now means 0G Galileo. |
| Invoice↔payment binding | **`PaymentRouter` contract.** `pay(serviceId, nonce, payTo) payable` emits `Paid(...)`; `verifyTransfer` is one `eth_getLogs` on the indexed `(serviceId, nonce)` topics. |
| Contract scope | **Both** `AgentGateRegistry` and `SpendGuard` ported, plus the new `PaymentRouter`. |

## 2. Target network

| Parameter | Value |
|---|---|
| Name | 0G Galileo Testnet |
| Chain ID | **16602** (verify with `cast chain-id` before deploy; older docs say 16601) |
| RPC | `https://evmrpc-testnet.0g.ai` |
| Explorer | `https://chainscan-galileo.0g.ai` |
| Faucet | `https://faucet.0g.ai` (0.1 OG/wallet/day) |
| Native token | OG, **18 decimals** |
| CAIP-2 | `eip155:16602` |
| `ChainClient.network` | `0g-galileo` |

> The faucet's 0.1 OG/day cap is a real constraint on deploy + demo funding.
> Budget deploys accordingly; request early.

## 3. What changes and what does not

**Unchanged (~70%)** — everything above the `ChainClient` seam
(`packages/shared/src/types.ts:90`): `packages/middleware` (HTTP 402 flow,
invoice store, attestation queue, SSRF guard, rate limiting), `packages/oracle`,
`packages/buyer-agent`, `packages/devnet`, most of `packages/cli`, and every
dashboard component's layout/logic.

**Replaced:**

| Casper | 0G |
|---|---|
| `contracts/agentgate-registry` (Odra/Rust, 943 LOC) | `contracts-evm/src/AgentGateRegistry.sol` |
| `contracts/spend-guard` (Odra/Rust, 857 LOC) | `contracts-evm/src/SpendGuard.sol` |
| native transfer + `transfer_id` | `contracts-evm/src/PaymentRouter.sol` |
| `packages/chain/src/live.ts` (`LiveCasperClient`, 1269 LOC) | `packages/chain/src/live-0g.ts` (`Live0gClient`) |
| `packages/chain/src/sdk.ts` (casper-js-sdk CJS shim) | deleted — viem is ESM |
| Odra dictionary codec + `ByteReader` byte parsing | ABI view calls |
| CSPR.cloud REST indexer (API key) | `eth_getLogs` (keyless) |
| PEM ed25519/secp256k1 + `signAndAddAlgorithmBytes` | EIP-191 `personal_sign` over the same canonical bytes |
| `account-hash-<64hex>` | `0x<40hex>` (EIP-55 checksummed on display, lowercased for comparison) |
| motes (9 dp) | wei (18 dp) |
| `casper:casper-test` | `eip155:16602` |

**Dropped:** the WCSPR/CEP-18 rail via `@make-software/casper-x402` and
`x402-facilitator.cspr.cloud`. 0G has no x402 facilitator. The registry keeps a
multi-asset `accepts[]` (`asset == address(0)` means native OG), so the on-chain
shape survives and an ERC-20 rail can be added later without a contract change —
but the shipped rail is **native-only**. `FACILITATOR_*` config, `X402V2*` types
and the v2 branch in `packages/middleware/src/app.ts` are removed.

**Lost:** the live Casper deployment and every attestation/reputation record on
it. 0G starts from an empty registry.

## 4. Unit and identity model

`Motes` (string, 9 dp) → `Wei` (string, 18 dp). The type stays a decimal string
parsed through `BigInt`, so only the constants and the display helpers change.
Renames (mechanical, ~96 call sites):

| Before | After |
|---|---|
| `Motes` | `Wei` |
| `MOTES_PER_CSPR = 1_000_000_000n` | `WEI_PER_OG = 1_000_000_000_000_000_000n` |
| `parseMotes` / `addMotes` / `compareMotes` | `parseWei` / `addWei` / `compareWei` |
| `csprToMotes` / `motesToCspr` / `formatCspr` | `ogToWei` / `weiToOg` / `formatOg` |
| `priceMotes` / `amountMotes` / `minAmountMotes` | `priceWei` / `amountWei` / `minAmountWei` |
| `BUYER_BUDGET_CSPR` | `BUYER_BUDGET_OG` |

`formatUnits` / `formatToken` keep their names and signatures — already
decimals-parametric.

**Price floor.** Casper enforced `amount >= 1000` motes (1e-6 CSPR). The 18-dp
equivalent is `MIN_PRICE_WEI = 1e12` (1e-6 OG). Same economic floor, new scale.

**Timestamps.** Odra's `get_block_time()` returns **milliseconds**; EVM's
`block.timestamp` returns **seconds**. Every off-chain reader
(`ServiceRecord.createdAt`, `AttestationRecord.timestamp`, `ActivityEvent.timestamp`,
`SpendGuard.windowMs`) is contracted on **ms**. All three contracts therefore
store and emit `uint64(block.timestamp) * 1000`. This is the single easiest
detail to get wrong.

## 5. Payment flow

```
buyer                      gateway                    0G Galileo
  │  GET /svc/:id             │                            │
  │ ─────────────────────────>│                            │
  │  402 + accepts[] (nonce)  │                            │
  │ <─────────────────────────│                            │
  │                                                        │
  │  PaymentRouter.pay{value: priceWei}(id, nonce, payTo)   │
  │ ──────────────────────────────────────────────────────>│
  │                                          emit Paid(...) │
  │  GET /svc/:id  X-PAYMENT: {txHash, nonce}               │
  │ ─────────────────────────>│                            │
  │                           │ eth_getLogs(Paid, id, nonce)│
  │                           │ ──────────────────────────>│
  │                           │  check payTo/amount/age     │
  │  200 + upstream body      │                            │
  │ <─────────────────────────│  registry.recordAttestation │
  │                           │ ──────────────────────────>│
```

`PaymentRouter` also dedups `(serviceId, nonce)` on-chain — a guarantee the
Casper rail only had off-chain in the invoice store. The gateway's
`invoices.markUsed()` burn stays as the first line of defence.

Verification reads the **transaction receipt** the buyer names, not a block-range
`eth_getLogs`: that binds the proof to the exact tx presented and confirms it
succeeded. The match requires **both** `serviceId` and `nonce`, because neither
identifies a payment alone — `seenNonce` is keyed on the pair, so a nonce is
spendable once per service, and payment targets are shared across services in
this deployment (`packages/chain/src/live.ts:961`). Matching on nonce plus payTo
only would leave the service binding to off-chain invoice state.

## 6. x402 wire format

The v1 native body keeps its shape; only the Casper-specific fields change:

```jsonc
{
  "x402Version": 1,
  "error": "X-PAYMENT header is required",
  "accepts": [{
    "scheme": "exact",
    "network": "0g-galileo",
    "maxAmountRequired": "1000000000000000",   // wei
    "asset": "OG",
    "payTo": "0x<40hex>",
    "resource": "https://gateway…/svc/2",
    "maxTimeoutSeconds": 300,
    "extra": {
      "nonce": "12345678901234",
      "serviceId": 2,
      "expiresAtMs": 1756500000000,
      "settlement": "0g-payment-router",        // was: casper-native-transfer
      "router": "0x<PaymentRouter>",            // new: where the buyer must pay
      "nonceEncoding": "uint256-decimal"        // was: transferIdEncoding u64-decimal
    }
  }]
}
```

`X-PAYMENT` payload: `{ transaction: "0x<64hex txhash>", transferId: "<nonce>",
from?: "0x…" }` — field names unchanged so `decodeXPayment` and the client keep
working; only the validation regexes widen to `0x`-prefixed 32-byte hashes.

## 7. Signature model

`buildSelfMapMessage()` (`packages/shared/src/self-map.ts`) is unchanged — the
same canonical bytes, with `network` now `0g-galileo`. Only the signing and
verification primitives change:

- **Sign** (CLI): `viem` `privateKeyToAccount(pk).signMessage({ message: { raw } })`
  → EIP-191 `personal_sign`, 65-byte `0x` signature.
- **Verify** (gateway): `viem` `recoverMessageAddress({ message: { raw }, signature })`
  → compare lowercased against the on-chain `owner`.

`verifyOwnerSignature(publicKeyHex, message, signatureHex)` becomes
`recoverSigner(message, signatureHex) -> { address: string; valid: boolean }`.
The `publicKeyHex` parameter disappears: EVM recovers the signer from the
signature, so the caller no longer transmits a key. The `/services/:id/map`
request body drops `publicKeyHex`.

Key material moves from PEM files to a hex private key. `GATE_SIGNER_PEM_PATH` /
`BUYER_SIGNER_PEM_PATH` / `SELLER_SIGNER_PEM_PATH` become
`GATE_SIGNER_KEY` / `BUYER_SIGNER_KEY` / `SELLER_SIGNER_KEY` (0x-prefixed 32-byte
hex). `AnySigner` becomes `{ kind: 'mock'; publicKey } | { kind: 'key'; privateKey }`.

> Private keys in env vars are worse hygiene than PEM files with mode 600. The
> config loader must refuse a key that is not exactly 66 chars of `0x`+hex and
> must never log it. Same LOUD warning if a keyfile path is used instead and is
> group-readable.

## 8. Contract interfaces

### AgentGateRegistry

```
registerService(name, description, gatewayBaseUrl, accepts[], paymentTarget, attestor) -> uint64
recordAttestation(serviceId, paymentTxHash, success)
setActive(serviceId, active)
setAttestor(serviceId, attestor)
getService(serviceId) -> Service
getScore(serviceId) -> (uint64 total, uint64 success)
servicesCount() -> uint64
getAttestations(serviceId) -> Attestation[]   // newest-first, ring-buffered at 100
```

Semantics preserved exactly from `contracts/agentgate-registry/src/registry.rs`:
1-based ids, caller becomes owner, services start `active`, attestation caller
must be attestor **or** owner, inactive services reject attestations,
`(serviceId, paymentTxHash)` dedup, saturating counters, `set_active`/`set_attestor`
are owner-only (the attestor may **not** toggle).

`payment_deploy_hash: String` → `bytes32 paymentTxHash`. `Address` → `address`.
`Vec<Attestation>` newest-first-with-truncate → ring buffer + reversing view, so
`getAttestations` returns the identical ordering without O(n) storage writes.

### PaymentRouter

```
pay(uint64 serviceId, uint256 nonce, address payTo) payable
seenNonce(bytes32) -> bool
event Paid(uint64 indexed serviceId, uint256 indexed nonce, address indexed payer,
           address payTo, uint256 amount, uint64 timestamp)
```

### SpendGuard

```
openPolicy(gate, budget, perCallCap, windowMs, maxCallsInWindow, minTrustTier) -> uint64
deposit(policyId) payable
debit(policyId, serviceId, amount, payTo, paymentRef, trustTier)
withdraw(policyId, amount)
pause(policyId, paused)
getPolicy(policyId) -> Policy
getRemaining(policyId) -> uint256
policiesCount() -> uint64
```

Revert order is normative and must be preserved verbatim from
`contracts/spend-guard/src/spend_guard.rs:231-300`:
`PolicyNotFound → NotAuthorized → Paused → ZeroAmount → PerCallExceeded →
UntrustedService → DuplicateRef → OverBudget → RateExceeded`.
Checks-effects-interactions ordering is preserved; `payment_ref: String` →
`bytes32 paymentRef`.

## 9. Reads without an indexer

`LiveCasperClient` needed CSPR.cloud because Casper contract state is only
reachable as raw dictionary bytes. On EVM every read is a view call, and history
is `eth_getLogs`:

| ChainClient method | Casper | 0G |
|---|---|---|
| `getService` | dictionary read + `ByteReader` | `getService(id)` view |
| `listServices` | N dictionary reads | `servicesCount()` + N `getService` (multicall-batched) |
| `getScore` | dictionary read | `getScore(id)` view |
| `listAttestations` | dictionary read + parse | `getAttestations(id)` view |
| `getBalance` | CSPR.cloud `/accounts/:h` | `eth_getBalance` |
| `verifyTransfer` | CSPR.cloud `/deploys/:h/transfers` | the tx receipt's `Paid` logs, matched on `(serviceId, nonce)` |
| `listRecentActivity` | 3 CSPR.cloud endpoints | `eth_getLogs` over 3 event topics |

This removes `CSPR_CLOUD_API_KEY`, `CSPR_CLOUD_API_URL`,
`CSPR_CLOUD_STREAMING_URL`, and the `CSPR_CLOUD_RATE_LIMITED` error path.
**Consequence:** the "zero-config reads, no keys" claim in the README gets
*stronger* — `npx agentgate-0g list` now needs only a public RPC.

`eth_getLogs` block-range limits vary by provider. `listRecentActivity` must
query a bounded window (default: last 50 000 blocks, `ACTIVITY_LOOKBACK_BLOCKS`)
and page backwards, never `fromBlock: 0`.

## 10. Out of scope

- ERC-20 / EIP-3009 rail and a self-hosted x402 facilitator on 0G.
- Wiring `SpendGuard` into the middleware request path — it stays deployed,
  tested and unintegrated, exactly as it is today
  (`contracts/README.md` "NOT yet wired into the product"). Porting it keeps
  parity; it does not add integration.
- Migrating existing Casper on-chain data.
- 0G's storage / DA / compute layers. This migration touches the EVM chain only.
