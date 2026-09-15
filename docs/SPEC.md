# AgentGate — Engineering Spec (v1.0)

> **Authoritative build contract.** Every package MUST conform to the types, interfaces,
> ports, and REST shapes below. The product spec is `../AgentGate-PRD-Solo-Build-Plan.md`.
> Target chain: **0G Galileo Testnet** (chain ID `16602`, native **OG**, 18 decimals).
>
> **Relationship to x402.** This spec uses the x402 V1 *envelope* (`accepts[]` /
> `PaymentRequirements`, `X-PAYMENT`, `X-PAYMENT-RESPONSE`) and **not** x402's `exact`
> settlement scheme. `exact` expects a signed authorization the resource server submits;
> this expects the buyer to settle first through `PaymentRouter.pay` and present the tx
> hash. The scheme is therefore named `exact-settled`, so a generic x402 client finds no
> entry it supports rather than signing an authorization that would never be accepted.
> 0G has no x402 facilitator — settled-proof needs none, and keeps any third party out of
> the money path.
> Payment: a native OG payment through the `PaymentRouter` contract, which binds the
> invoice nonce to the payment on-chain and carries HTTP 402 semantics. Verified with
> the transaction receipt in live mode and via the local devnet in mock mode. The
> `ChainClient` seam keeps the settlement backend swappable.

## 0. Repo layout (npm workspaces monorepo, ESM, TypeScript, run with tsx)

```
agentgate/
├── package.json              # workspaces root, scripts: dev/demo/typecheck/test/build
├── tsconfig.base.json
├── vitest.config.ts          # root config picking up packages/*/test + e2e/
├── .env.example  .gitignore  LICENSE (MIT)  README.md
├── docs/SPEC.md  docs/ARCHITECTURE.md
├── .github/workflows/ci.yml
├── contracts-evm/            # Foundry workspace (NOT an npm workspace)
│   └── src/{AgentGateRegistry,PaymentRouter,SpendGuard}.sol
├── packages/
│   ├── shared/        # @agentgate/shared   — types, config, money, logger, errors. ZERO runtime deps.
│   ├── chain/         # @agentgate/chain    — ChainClient impls: MockChainHttpClient + Live0gClient
│   ├── devnet/        # @agentgate/devnet   — in-memory mock chain HTTP server (express)
│   ├── middleware/    # @agentgate/middleware — 402 paywall reverse proxy + admin API
│   ├── client/        # @agentgate/client   — agent-side pay helper (parse 402 → pay → retry)
│   ├── oracle/        # @agentgate/oracle   — RWA feed: USD/IDR + gold spot + confidence
│   ├── buyer-agent/   # @agentgate/buyer-agent — LLM decision loop demo agent
│   └── cli/           # @agentgate/cli      — `agentgate wrap|buy|list|status|pause|resume|demo-accounts`
├── dashboard/         # @agentgate/dashboard — Next.js 14 App Router + Tailwind (also the landing page)
├── e2e/               # loop.test.ts — full mock-mode loop, in-process servers
└── scripts/
    ├── dev.ts         # boots devnet+oracle+middleware (mock mode) concurrently
    └── demo.ts        # one-shot scripted demo: register → 402 → pay → serve → attest → score
```

Conventions:
- `"type": "module"` everywhere. TS `moduleResolution: "bundler"`, `strict: true`. No build step for
  Node packages — run from source with `tsx`. Each package's `package.json` `exports` points at `./src/index.ts`.
- Workspace deps use `"@agentgate/shared": "workspace:*"` → **NO**, npm doesn't support `workspace:*` ranges
  with install older semantics reliably — use `"*"` as the version range for internal deps (npm workspaces resolves locally).
- Every server package exports `createApp(deps): express.Express` (pure factory, no listen) AND
  `startServer(opts): Promise<{ port: number; close(): Promise<void> }>` so e2e can boot in-process on port 0.
- Logging: `createLogger(name)` from shared — leveled JSON lines to stdout (`{ts,level,name,msg,...fields}`).
- All packages: `npm run typecheck` (tsc --noEmit) and `npm test` (vitest run, if tests exist) must pass.

## 1. Modes & environment

`AGENTGATE_MODE = "mock" | "live"` (default `mock`). Shared `loadConfig()` reads process.env once, validates, throws on invalid combos (e.g. a malformed signer key or registry address, live mode with the default admin token). Reads need no API key at all — they go straight to the public 0G RPC.

`.env.example` (root, documented):
```
AGENTGATE_MODE=mock
# --- ports ---
DEVNET_PORT=4030
ORACLE_PORT=4010
MIDDLEWARE_PORT=4021
DASHBOARD_PORT=3000
# --- mock mode ---
DEVNET_URL=http://localhost:4030
# --- middleware ---
AGENTGATE_ADMIN_TOKEN=dev-admin-token        # MUST be changed in live mode (config refuses default)
INVOICE_TTL_MS=300000
INVOICE_STORE_PATH=                          # optional: JSON file path → issued invoices survive gateway restarts (FileInvoiceStore); empty = in-memory
ATTESTATION_QUEUE_PATH=                      # optional: JSON file path → pending attestations survive restarts & replay on boot (FileAttestationQueue, F7); empty = in-memory
UPSTREAM_TIMEOUT_MS=30000
LOG_LEVEL=info                               # debug|info|warn|error (read by the shared logger)
TRUST_PROXY=0                                # number of trusted reverse-proxy hops; set 1 behind a single Railway/Vercel proxy so rate limiting keys off the real client IP (never set above the real hop count)
# --- live mode (0G Galileo Testnet) ---
ZG_RPC_URL=https://evmrpc-testnet.0g.ai
ZG_CHAIN_ID=16602
ZG_NETWORK=0g-galileo
ZG_EXPLORER_URL=https://chainscan-galileo.0g.ai
REGISTRY_CONTRACT_ADDRESS=
PAYMENT_ROUTER_ADDRESS=
SPEND_GUARD_ADDRESS=
CONTRACTS_DEPLOY_BLOCK=                       # only with your OWN contracts: the block they were deployed in (the profile knows its own)
ACTIVITY_LOOKBACK_BLOCKS=                     # leave unset; an optional cap for an RPC that rejects wide getLogs ranges
GATE_SIGNER_KEY=                              # middleware/attestor key (0x + 64 hex) -- NEVER commit
BUYER_SIGNER_KEY=                             # buyer key (0x + 64 hex) -- NEVER commit -- buyer agent + `agentgate buy` (also via --key)
SELLER_SIGNER_KEY=                            # CLI / seller key (0x + 64 hex) -- NEVER commit
# --- LLM ---
ANTHROPIC_API_KEY=
LLM_MODEL=claude-sonnet-4-6
# --- oracle ---
ORACLE_STATIC=0                               # 1 = serve deterministic fixture data (offline demo)
# --- buyer agent ---
BUYER_BUDGET_OG=5
# --- demo accounts (mock mode only) ---
MOCK_BUYER_ACCOUNT=
MOCK_SELLER_ACCOUNT=
```

## 2. Shared package — `@agentgate/shared` (zero runtime deps)

`src/types.ts` — **copy verbatim**:
```ts
/** All money values are wei of native OG as decimal strings (1 OG = 1e18 wei). U512-safe via bigint. */
export type Wei = string;

/**
 * One accepted payment rail for a service, as stored on-chain (the registry's
 * `PaymentOption` struct). `asset` is `'native'` for OG or a `0x`-prefixed
 * ERC-20 token address; `amount` is in the asset's atomic units. `name`/
 * `version` are reserved token-metadata fields (empty for native).
 */
export interface PaymentOption {
  asset: string;
  amount: Wei;
  decimals: number;
  symbol: string;
  name: string;
  version: string;
}

export interface ServiceRecord {
  id: number;
  name: string;
  description: string;
  endpointUrl: string;       // PUBLIC gateway URL (middleware /svc/:id) — never the upstream
  priceWei: Wei;
  paymentTarget: string;     // "0x<40hex>"
  owner: string;             // "0x<40hex>" (from the contract)
  attestor: string;          // "0x<40hex>" allowed to record attestations
  active: boolean;
  createdAt: number;         // unix ms
  /**
   * On-chain `accepts[]` for this service (absent in mock mode, which does
   * not model multi-asset pricing). When present, `priceWei` mirrors the
   * native option's amount (or the first option if none is native).
   */
  accepts?: PaymentOption[];
}

export interface ServiceScore { totalCalls: number; successCalls: number; }

export interface AttestationRecord {
  serviceId: number;
  paymentTxHash: string;     // "0x<64hex>"
  success: boolean;
  timestamp: number;         // unix ms
  recordTxHash: string;      // the attestation tx itself
}

export interface ActivityEvent {
  kind: 'service_registered' | 'payment' | 'attestation';
  txHash: string;
  serviceId: number | null;
  amountWei?: Wei;
  /**
   * Token (ERC-20) payments only — set when the payment used a non-native
   * accepted asset. When set, `amountWei` is the token's atomic amount;
   * render with these instead of treating it as native OG. Absent ⇒ native
   * OG payment.
   */
  assetSymbol?: string;
  assetDecimals?: number;
  success?: boolean;
  timestamp: number;
  detail: string;            // human-readable one-liner for the dashboard feed
}

export interface RegisterServiceInput {
  name: string;
  description: string;
  endpointUrl: string;
  priceWei: Wei;
  paymentTarget: string;
  attestor: string;
}

/**
 * A nonce is unique only *per service* — `PaymentRouter.seenNonce` is keyed
 * by `(serviceId, nonce)`, and this repo's own payment targets are shared
 * across services (one gate account).
 * Without `serviceId` the on-chain proof cannot bind a payment to a service
 * on its own, leaving that guarantee to the off-chain invoice store.
 */
export interface VerifyTransferQuery {
  txHash: string;
  serviceId: number;
  expectedTarget: string;    // "0x<40hex>"
  minAmountWei: Wei;
  expectedNonce: string;
  maxAgeMs: number;
}
export type VerifyResult =
  | { ok: true; amountWei: Wei; from: string; timestamp: number }
  | { ok: false; reason: 'not_found' | 'wrong_target' | 'amount_too_low' | 'wrong_nonce' | 'expired' | 'pending' };

export interface SignerRef { kind: 'mock'; publicKey: string }    // mock
export interface KeySignerRef { kind: 'key'; privateKey: string } // live (0x + 64 hex)
export type AnySigner = SignerRef | KeySignerRef;

export interface ChainClient {
  readonly network: string;
  /**
   * Cheap, bounded reachability check for readiness probes (mock: ping devnet;
   * live: node-RPC status). Resolves when the backing chain is reachable, throws
   * otherwise. Optional so injected/test clients need not implement it.
   */
  ping?(): Promise<void>;
  getService(id: number): Promise<ServiceRecord | null>;
  listServices(): Promise<ServiceRecord[]>;
  getScore(id: number): Promise<ServiceScore>;
  listAttestations(serviceId: number, limit?: number): Promise<AttestationRecord[]>;
  listRecentActivity(limit?: number): Promise<ActivityEvent[]>;
  getBalance(account: string): Promise<Wei>;
  verifyTransfer(q: VerifyTransferQuery): Promise<VerifyResult>;
  registerService(input: RegisterServiceInput, signer: AnySigner): Promise<{ serviceId: number; txHash: string }>;
  recordAttestation(input: { serviceId: number; paymentTxHash: string; success: boolean }, signer: AnySigner): Promise<{ txHash: string }>;
  setActive(serviceId: number, active: boolean, signer: AnySigner): Promise<{ txHash: string }>;
  transfer(input: { to: string; amountWei: Wei; nonce: string; serviceId: number }, signer: AnySigner): Promise<{ txHash: string }>;
}
```

`src/money.ts`: `ogToWei(og: string): Wei` (decimal string × 1e18, bigint, throws on >18 dp or negative), `weiToOg(w: Wei): string` (trim trailing zeros), `addWei`, `compareWei(a,b): -1|0|1`, `formatOg(w: Wei): string` ("0.5 OG"), plus decimals-parametric `formatUnits`/`formatToken` for ERC-20 amounts in `accepts[]`. All bigint-backed; never use Number for money.

`src/nonce.ts`: `randomNonce(): string` — random from `crypto.getRandomValues`, decimal string, capped at `Number.MAX_SAFE_INTEGER` so it survives the JSON hops around it (the chain itself takes a uint256).

`src/config.ts`: `loadConfig(env = process.env): AgentGateConfig` per §1. `src/logger.ts`: tiny JSON logger with `debug/info/warn/error`, level from `LOG_LEVEL`. `src/errors.ts`: `AgentGateError(code, message, httpStatus)`.

Score → trust badge (shared `src/trust.ts`, used by dashboard + buyer agent):
`trustTier(score: ServiceScore): 'new' | 'reliable' | 'trusted'` — `new` if totalCalls < 5; `trusted` if totalCalls ≥ 25 AND success ratio ≥ 0.95; `reliable` if totalCalls ≥ 5 AND ratio ≥ 0.9; else `new`.

## 3. Devnet (mock chain) — `@agentgate/devnet`, express, port **4030**

In-memory state simulating exactly what we use on 0G: account balances (wei), nonce-bound transfers, the registry contract's state, and an activity log. Deterministic-ish tx hashes: `sha256(JSON.stringify(payload) + monotonicCounter)` hex, 64 chars.

REST (all JSON):
| Method/Path | Body / Query | Returns |
|---|---|---|
| `POST /faucet` | `{account, amountWei}` | `{balanceWei}` |
| `GET  /chain/balance/:account` | | `{account, balanceWei}` |
| `POST /chain/transfers` | `{fromPublicKey, to, amountWei, nonce}` | `{txHash, timestamp}` — debits sender (address derived as `0x` + first 40 hex of sha256(pubkey)), credits target; 400 `insufficient_balance` |
| `GET  /chain/transfers/:txHash` | | transfer record or 404 |
| `POST /chain/register-service` | `RegisterServiceInput & {ownerPublicKey}` | `{serviceId, txHash}` — also activity event |
| `POST /chain/attestations` | `{serviceId, paymentTxHash, success, byPublicKey}` | `{txHash}` — 403 if `byPublicKey` ≠ service.attestor and ≠ owner; 404 unknown service; 409 duplicate paymentTxHash for that service |
| `POST /chain/services/:id/active` | `{active, byPublicKey}` | `{txHash}` — owner only |
| `GET  /chain/services` | | `ServiceRecord[]` |
| `GET  /chain/services/:id` | | `ServiceRecord` or 404 |
| `GET  /chain/services/:id/score` | | `ServiceScore` |
| `GET  /chain/services/:id/attestations?limit=` | | `AttestationRecord[]` (newest first) |
| `GET  /chain/activity?limit=` | | `ActivityEvent[]` (newest first, default 50) |
| `GET  /healthz` | | `{ok:true, network:'mock'}` |

Mirrors the on-chain rules of the Solidity contract (auth, duplicate attestation guard, active flag) so mock and live behave identically. Mock addresses use the same `0x<40hex>` shape as live, so every address code path is exercised in both modes.

## 4. Chain package — `@agentgate/chain`

- `createChainClient(config): ChainClient` — picks impl by `config.mode`.
- `MockChainHttpClient` — fetch against `DEVNET_URL`, maps REST ↔ `ChainClient`. Address derivation helper `mockAccountAddress(publicKey)` = `0x` + the first 40 hex of sha256(publicKey) — the same shape as a real EVM address, so mock and live exercise one address code path.
- `Live0gClient` — viem against the public 0G RPC. **No indexer and no API key anywhere in the read path:**
  - reads: `getService` / `getScore` / `getAttestations` are contract view calls; `listServices` is `servicesCount()` + N `getService` (multicall-batched); `getBalance` is `eth_getBalance`; `listRecentActivity` is `eth_getLogs` over the three event topics from the contracts' deploy block (`CONTRACTS_DEPLOY_BLOCK`, recorded per profile) to the head — the deployment's whole history, never a rolling slice of it, so an idle week cannot empty the feed. `ACTIVITY_LOOKBACK_BLOCKS` is an optional cap for an RPC that rejects wide ranges; both 0G RPCs answer a deploy-to-head query in under a second.
  - `verifyTransfer` is one `eth_getTransactionReceipt` on the hash the buyer presented, then an exact match against the `Paid` logs in that receipt — keeping only logs emitted by the configured `PaymentRouter` (the hash is buyer-supplied, so any other contract could mint a look-alike event), then `payTo` → `(serviceId, nonce)` → amount → age. Binding on `(serviceId, nonce)` — not nonce alone — because one payment target is shared across services. A missing receipt is `pending` (retryable), never `not_found`; an RPC outage propagates rather than masquerading as `pending`.
  - writes: `PaymentRouter.pay` for payments; `registerService` / `recordAttestation` / `setActive` against `REGISTRY_CONTRACT_ADDRESS`. Every write waits for the receipt and throws on a reverted status rather than reporting success.
  - Anything that requires the not-yet-deployed contract throws `AgentGateError('CONTRACT_NOT_DEPLOYED', …, 503)` when `REGISTRY_CONTRACT_ADDRESS` / `PAYMENT_ROUTER_ADDRESS` is unset, with the call path otherwise fully implemented and tested against a locally deployed contract on `anvil`.

## 5. Middleware (the product core) — `@agentgate/middleware`, express, port **4021**

402 paywall reverse proxy. State: upstream map (`data/upstreams.json`, atomic writes) + nonce/invoice store (in-memory Map + TTL sweep; interface `InvoiceStore` so Redis can swap in).

Flow for `ALL /svc/:id` (GET/POST pass-through):
1. Look up service by id from `ChainClient` (60s cache). 404 if unknown, 403 `service_inactive` if `!active`.
2. No `X-PAYMENT` header → **402** with `PaymentRequiredResponse` JSON body (`x402Version:1`, `error:"X-PAYMENT header is required"`, `accepts:[requirements(freshNonce)]`). Invoice persisted (nonce → {serviceId, expiresAtMs, used:false}).
3. With `X-PAYMENT` header (base64-encoded `PaymentPayload`):
   - Decode and validate `x402Version===1`, `scheme==="exact-settled"`, `network===chain.network`; extract `payload.transaction` + `payload.nonce`. Malformed → **402** + fresh requirements + `error:"invalid_payment_header"`.
   - Invoice lookup by `nonce`: must exist, match serviceId, be unused, be within `expiresAtMs` — else **402** fresh requirements + reason (`invoice_expired`, `invoice_used`, `unknown_nonce`).
   - `chain.verifyTransfer({txHash: transaction, serviceId, expectedTarget: service.paymentTarget, minAmountWei: service.priceWei, expectedNonce: nonce, maxAgeMs: INVOICE_TTL_MS})` → on `{ok:false}` **402** + fresh requirements + reason. `pending` → **402** + same requirements (nonce kept) + `Retry-After: 2` (seconds) + `error:"settlement_pending"`.
   - Mark nonce used **before** proxying (single-use even if upstream fails).
4. Proxy to upstream (undici/fetch, timeout `UPSTREAM_TIMEOUT_MS`, max body 1 MiB both ways, strip hop-by-hop headers, forward query string + JSON body, pass through status/content-type).
5. Respond to buyer, then **async** `chain.recordAttestation({serviceId, paymentTxHash, success: upstreamOk})` signed by the gate signer; never blocks the response; on failure log + retry once after 5s.

Admin API (Bearer `AGENTGATE_ADMIN_TOKEN`):
- `POST /admin/services` `{serviceId, upstreamUrl}` → 204 (validates URL http/https, **rejects** private/loopback hosts in live mode — SSRF guard; allowed in mock for local demo).
- `GET /admin/services` → mappings. `DELETE /admin/services/:id` → 204.
- `GET /svc/:id/meta` (public) → `{service, score, trustTier}` without paying.
- `GET /healthz`.

Hardening: helmet, JSON body limit 256 KiB inbound, rate limit 60 req/min/IP on `/svc`, structured request logs, graceful SIGTERM shutdown, never leak upstream URL in responses or errors.

## 6. Client helper — `@agentgate/client`

```ts
export interface PayAndFetchResult { status: number; body: unknown; paid: boolean; requirements?: PaymentRequirements; settlement?: SettlementResponse; txHash?: string; priceWei?: Wei; }
export interface AgentGateClientOpts { chain: ChainClient; signer: AnySigner; maxPriceWei?: Wei; logger?: Logger; settleDelayMs?: number; }
export function createAgentGateClient(opts): {
  fetchPaid(url: string, init?: RequestInit): Promise<PayAndFetchResult>;
}
```
`fetchPaid`: GET → if 402: `parsePaymentRequired` selects the `accepts[]` entry matching `chain.network` + `scheme:"exact-settled"` (throws `NETWORK_MISMATCH` if none), refuses if `maxAmountRequired > maxPriceWei` (`PRICE_EXCEEDED`). `chain.transfer({to: req.payTo, amountWei: req.maxAmountRequired, nonce: req.extra.nonce, serviceId: req.extra.serviceId}, signer)` — which calls `PaymentRouter.pay` at `req.extra.router` — wait `settleDelayMs` (default 0 mock / 3000 live), retry with `X-PAYMENT: encodeXPayment(...)`. On a paid 200 decodes `X-PAYMENT-RESPONSE` into `settlement`. Retries `Retry-After` (seconds) 402-pending (`error:"settlement_pending"`) up to 5×. Non-402 first responses pass straight through.

## 7. Oracle — `@agentgate/oracle`, express, port **4010**

`GET /feed` → `{ pairs: { usd_idr: {value, sources: [{name, value}], confidence}, xau_usd: {...} }, asOf, attribution }`.
Also `GET /feed/usd-idr`, `GET /feed/gold`, `GET /healthz`.
Sources (free, no key): `https://open.er-api.com/v6/latest/USD` (IDR) and `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json` (idr + xau→invert for XAU/USD). 5s timeout per source, 60s in-memory cache, `confidence = max(0, 1 - (maxDev/mean) * 10)` rounded 2dp across available sources; single source → 0.5. `ORACLE_STATIC=1` or all sources failing → deterministic fixture (`usd_idr 16250.5`, `xau_usd 3310.25`, confidence 0.97, `attribution: 'static-fixture'`). Never throws to the consumer — always 200 with best-effort data.

## 8. Buyer agent — `@agentgate/buyer-agent`

`npm run agent -- --task "Get today's USD/IDR rate and gold price, summarize for a treasury report" [--budget 5]`.
Loop (each step logged as pretty console block AND `logs/decisions.jsonl`):
1. `chain.listServices()` → table (id, name, price OG, trust tier, score).
2. LLM (`LlmClient` seam: `AnthropicLlm` via raw `fetch` to `https://api.anthropic.com/v1/messages` with `LLM_MODEL`, else deterministic `MockLlm`) gets task + catalog JSON → returns `{serviceId, reason}` (MockLlm: cheapest active service whose name/description matches task keywords; ties → highest trust).
3. Budget check (`BUYER_BUDGET_OG` cap, refuse + log if exceeded), then `client.fetchPaid(service.endpointUrl)`.
4. LLM summarizes the data for the task → final report printed.
5. Prints receipt: payment txHash, amount, remaining budget, and (after 2s) the attestation it triggered (`chain.listAttestations`).

## 9. CLI — `@agentgate/cli` (commander)

Bin name `agentgate` (root script `npm run agentgate -- ...` + package bin field).
- `agentgate wrap <upstreamUrl> --price <og> --name <name> [--description <d>] [--gateway <url=http://localhost:4021>] [--payment-target <0xaddress>] [--key <0xhex>]`
  1. `chain.registerService` (endpointUrl = `<gateway>/svc/<id>` — two-step: register with placeholder, then the devnet/contract computes id; SOLUTION: registry computes `endpoint_url` itself as `<gateway>/svc/<id>`? NO — keep it simple: CLI sends `endpointUrl: '<gateway>/svc/?'` is ugly. **Decision:** `registerService` returns `serviceId`; the canonical public URL is ALWAYS `<gateway>/svc/<serviceId>`; the `endpointUrl` field stored on-chain is set by the CLI to `<gateway>/svc/{id}` template resolved client-side via a second `setEndpoint`? Too much. **Final decision: the registry stores `gatewayBaseUrl` provided at registration; `ServiceRecord.endpointUrl` is computed by every reader as `${gatewayBaseUrl}/svc/${id}`.** To keep `ServiceRecord` unchanged, devnet + contract store the base URL internally and return the computed `endpointUrl`. CLI passes `endpointUrl = <gateway base>`; readers see the full computed URL.
  2. `POST <gateway>/admin/services` with the upstream mapping (admin token from env).
  3. Prints: service id, public endpoint, dashboard URL `http://localhost:3000/services/<id>`, register txHash.
- `agentgate list` — catalog table with scores/tiers.
- `agentgate status <id>` — service + score + recent attestations.
- `agentgate demo-accounts` (mock only) — creates buyer/seller accounts, faucets 1000 OG each, prints export lines.
- Payment target default: derived from the seller signer (mock: `mockAccountAddress(publicKey)`; live: the address of `SELLER_SIGNER_KEY`).

## 10. Contracts — `contracts-evm/` (Solidity 0.8.28, Foundry)

`pragma solidity 0.8.28` pinned (not `^`), SPDX `MIT`, optimizer on (200 runs),
`evm_version = "cancun"` (verified against the live 0G node). No constructor
arguments and no proxy: a new version means a new address. `forge test` green —
42 tests across the three suites.

**All contract timestamps are unix milliseconds.** EVM `block.timestamp` is in
seconds, so every contract stores and emits `uint64(block.timestamp) * 1000`;
every off-chain reader is contracted on ms.

### `AgentGateRegistry`

- Storage: `servicesCount: uint64`; `services: mapping(uint64 => Service)`; `scores: mapping(uint64 => (uint64 total, uint64 success))`; `seenPayments: mapping(bytes32 => bool)` keyed on `(serviceId, paymentTxHash)` as the duplicate-attestation guard; `attestations` as a **100-entry ring buffer per service** (constant cost per write, reversed on read so `getAttestations` returns newest-first).
- `struct PaymentOption { address asset; uint256 amount; uint8 decimals; string symbol; string name; string version; }` — `asset == address(0)` means native OG.
- `struct Service { string name; string description; string gatewayBaseUrl; PaymentOption[] accepts; address paymentTarget; address owner; address attestor; bool active; uint64 createdAt; }`
- Entrypoints:
  - `registerService(name, description, gatewayBaseUrl, accepts[], paymentTarget, attestor) -> uint64` — rejects an empty/whitespace-only name and any price below `MIN_PRICE_WEI` (1e12 wei = 1e-6 OG); ids are **1-based**; caller becomes owner; services start active; emits `ServiceRegistered`.
  - `recordAttestation(serviceId, paymentTxHash: bytes32, success)` — caller must be attestor **or** owner; service must exist and be active; rejects a duplicate `paymentTxHash` *per service*; bumps the (saturating) score; appends to the ring buffer; emits `AttestationRecorded`.
  - `setActive(serviceId, active)` / `setAttestor(serviceId, attestor)` — **owner only**; the attestor may not toggle either. Emits `ServiceStatusChanged` / `AttestorChanged`.
  - `getService(serviceId) -> Service`, `getScore(serviceId) -> (uint64, uint64)`, `servicesCount() -> uint64`, `getAttestations(serviceId) -> Attestation[]`.
- Custom errors: `NotAuthorized`, `ServiceNotFound`, `ServiceInactive`, `DuplicateAttestation`, `InvalidPrice`, `EmptyName`.

### `PaymentRouter`

A plain EVM value transfer carries no invoice reference, so nothing binds a
payment to the 402 that asked for it. The router is that binding:

- `pay(uint64 serviceId, uint256 nonce, address payTo) payable` — forwards the full `msg.value` to `payTo` and emits `Paid(serviceId indexed, nonce indexed, payer indexed, payTo, amount, timestamp)`. The router never custodies funds: value in, value straight out.
- `seenNonce(bytes32) -> bool` — `(serviceId, nonce)` is burned **on-chain**, so a replay reverts. This is a guarantee the off-chain invoice store cannot give on its own; the gateway's `invoices.markUsed()` burn stays as the first line of defence.
- Checks-effects-interactions ordered: a failed transfer leaves the nonce unburned, so the invoice stays payable.

### `SpendGuard`

An on-chain escrow spend firewall for agent budgets. Ported and tested, but
**not yet wired into the request path** — see the roadmap.

- `openPolicy(gate, budget, perCallCap, windowMs, maxCallsInWindow, minTrustTier) -> uint64`, `deposit(policyId) payable`, `debit(policyId, serviceId, amount, payTo, paymentRef, trustTier)`, `withdraw`, `pause`, `getPolicy`, `getRemaining`, `policiesCount`.
- `debit`'s revert order is **normative** and asserted by the suite: `PolicyNotFound → NotAuthorized → Paused → ZeroAmount → PerCallExceeded → UntrustedService → DuplicateRef → OverBudget → RateExceeded`.

## 11. Dashboard — `dashboard/` (Next.js 14.2 App Router, Tailwind 3, TypeScript)

Also serves as the landing page (PRD judging criterion #7).
- `/` — landing: hero ("Stripe for AI agents on 0G"), one-command pitch with copyable `npx agentgate-0g wrap ...`, how-it-works 3 steps (wrap → discover → get paid), live stats strip (services, total calls, revenue — from `/api/stats`), roadmap section, links (GitHub/X/docs).
- `/catalog` — service cards: name, description, price (OG), trust badge, score, active dot; links to detail.
- `/services/[id]` — detail: metadata, trust badge tier, score donut/sparkbar, copyable endpoint + 402 curl snippet, live attestation feed (5s polling), revenue counter (price × successCalls, plus `getBalance(paymentTarget)` shown in mock).
- `/activity` — global live feed of `ActivityEvent`s with tx hashes (mock: plain code text; live: link to `https://chainscan-galileo.0g.ai/tx/<hash>`), 5s polling, "LIVE" pulse indicator.
- API routes (`app/api/*/route.ts`, `runtime = 'nodejs'`, `dynamic = 'force-dynamic'`): `/api/services`, `/api/services/[id]` (record+score+attestations), `/api/activity`, `/api/stats` — thin wrappers over `createChainClient(loadConfig())`. Client components poll with SWR `refreshInterval: 5000`.
- `next.config.mjs`: `transpilePackages: ['@agentgate/shared','@agentgate/chain']`.
- Design: dark theme, distinctive (not default-shadcn-looking): near-black `#0A0E14` bg, electric red accent `#FF3B30` + neutral grays, `Space Grotesk` headings / `Inter` body / `JetBrains Mono` for hashes & money, generous spacing, real empty/loading/error states. `npm run build` must succeed with zero type errors.

## 12. Root scripts & e2e

Root `package.json` scripts:
- `dev` — `tsx scripts/dev.ts` (devnet → seed demo accounts → oracle → middleware; prints next steps)
- `dev:dashboard` — `npm run dev -w dashboard`
- `demo` — `tsx scripts/demo.ts`: boots devnet+oracle+middleware in-process (ports from env), creates accounts + faucet, wraps the oracle via the CLI's programmatic API (`wrapService()` exported from cli), runs the buyer agent loop once (MockLlm if no key), prints the two tx hashes (payment + attestation) + final score + where to see it in the dashboard. Exits 0.
- `typecheck` — `tsc --noEmit` in every TS package + dashboard (`npm run typecheck --workspaces --if-present`)
- `test` — `vitest run` (packages unit tests + e2e)
- `build` — dashboard `next build`
- `agent`, `agentgate` — forwarders into the packages.

`e2e/loop.test.ts` (vitest): boots devnet/oracle/middleware in-process on port 0; asserts the **full loop**: faucet → wrap (register + admin mapping) → unpaid GET = 402 with valid invoice → underpay rejected → pay exact → 200 with oracle JSON → replayed proof = 402 `invoice_used` → attestation recorded (poll ≤5s) → score = (1,1) → activity feed contains payment + attestation + registration. Plus `expired invoice` test (TTL 100ms) and `inactive service` test.

## 13. Production-readiness bar (what "done" means without deploying)

- `npm install && npm run typecheck && npm test && npm run build` all green from a fresh clone; `forge test` green in `contracts-evm/` (Foundry required — the live-client suites spawn `anvil`).
- `npm run demo` completes the full PRD §2 loop offline and prints 2 tx hashes.
- No secrets in repo; `.env.example` complete; MIT LICENSE; README with architecture diagram (mermaid), quickstart, mode matrix, deploy runbook; CI workflow (node job with the Foundry toolchain + a `forge test` contracts job).
- Live-mode code paths compile and are unit-tested where possible without a node; every spot that needs the deployed contract throws `CONTRACT_NOT_DEPLOYED` with a clear message and is listed in `docs/DEPLOY.md`.
