# Design — Align the payment API to the x402 V1 wire format

> Date: 2026-06-29 · Status: **approved** (design + scheme decision) · Author: AgentGate
> Scope owner: `packages/middleware`, `packages/client`, `packages/shared`

## 1. Goal

Replace AgentGate's bespoke `agentgate-402/1` paywall protocol with the **x402 V1**
industry-standard wire format, so the payment mechanism is recognizable to generic x402
clients/tooling and so the project genuinely satisfies the "x402 micropayments" criterion —
**without** abandoning the working native-CSPR settlement underneath.

x402 has two live versions: **V1** (`x402Version: 1`, `X-PAYMENT`/`X-PAYMENT-RESPONSE` headers,
JSON 402 body, `maxAmountRequired`, slug networks) is the production standard today; **V2**
(Dec 2025: header-only transport, CAIP-2 networks, `amount`) is newer/evolving. **We implement V1**
and keep the type layout V2-migratable. Reference: `coinbase/x402` `specs/x402-specification-v1.md`,
`specs/transports-v1/http.md`, `specs/schemes/exact/scheme_exact_evm.md`.

## 2. Settlement model (the honest variation)

Canonical x402 `exact` (EVM) = the client signs an EIP-3009 authorization and a **facilitator
broadcasts** it (gasless for payer). AgentGate has **no facilitator on Casper testnet**; instead
the **buyer broadcasts the native CSPR transfer themselves** and presents the settled **deploy hash
as proof**, which the gateway **verifies** (target + amount + `transfer_id` + age). We keep that model
and label it honestly as a **settled-transfer-proof** variant of `exact`, recorded in
`extra.settlement = "casper-native-transfer"`. We adopt the x402 **envelope, headers, and versioning
faithfully** (the part clients/tooling parse); the per-chain `payload` is necessarily Casper-specific,
exactly as x402 intends for non-EVM rails.

**Scheme decision (resolved):** `scheme = "exact"` (maximizes tooling compatibility; "transfer an
exact amount" matches semantically; the who-broadcasts difference is disclosed via `extra.settlement`).

## 3. Scope

**In:** the 402 challenge/response + payment-proof mechanism in middleware (`/svc/:id`), the client
`fetchPaid` consumer, the shared types, and the buyer-agent's use of them. Docs/UI that show the 402
format.

**Out (explicit non-goals):** facilitator `/verify` + `/settle` endpoints; dual-support of the old
`agentgate-402/1` format (clean break — all consumers are in-repo); converting non-payment errors
(404/403/415/401/500) to RFC 9457 problem+json; V2 transport. Native CSPR settlement, the registry
contract, trust scoring, SSRF/nonce/auth hardening, and attestation logic are **unchanged**.

## 4. Data model (new shared types — `packages/shared/src/types.ts`)

```ts
export const X402_VERSION = 1;
export const X402_SCHEME = 'exact';
export const X402_ASSET_CSPR = 'CSPR';

/** One acceptable way to pay (an entry in `accepts[]`). */
export interface PaymentRequirements {
  scheme: string;             // 'exact'
  network: string;            // chain.network: 'mock' | 'casper-test' | 'casper'
  maxAmountRequired: string;  // price in motes (atomic units), decimal string
  asset: string;              // 'CSPR' (native — no token contract)
  payTo: string;              // account-hash-<64hex>
  resource: string;           // absolute URL of the protected resource (/svc/:id)
  description: string;        // service name
  mimeType?: string;          // optional expected response MIME
  maxTimeoutSeconds: number;  // invoiceTtlMs / 1000
  extra: CasperPaymentExtra;  // scheme-specific binding
}

/** Casper-specific requirement data. `nonce` MUST be used as the native transfer_id. */
export interface CasperPaymentExtra {
  nonce: string;                          // u64 decimal — the required transfer_id
  serviceId: number;
  expiresAtMs: number;                    // unix ms
  settlement: 'casper-native-transfer';
  transferIdEncoding: 'u64-decimal';
}

/** HTTP 402 body. */
export interface PaymentRequiredResponse {
  x402Version: number;             // 1
  error: string;                   // human-readable reason
  accepts: PaymentRequirements[];  // >= 1 entry
}

/** Decoded `X-PAYMENT` request header. */
export interface PaymentPayload {
  x402Version: number;   // 1
  scheme: string;        // mirrors the chosen accepts[].scheme
  network: string;       // mirrors the chosen accepts[].network
  payload: CasperExactPayload;
}

export interface CasperExactPayload {
  transaction: string;   // deploy hash of the buyer's settled native transfer
  transferId: string;    // = the issued nonce
  from?: string;         // payer account-hash (optional)
}

/** Decoded `X-PAYMENT-RESPONSE` response header (set on the paid 200). */
export interface SettlementResponse {
  success: boolean;
  transaction: string;   // deploy hash ('' on failure)
  network: string;
  payer?: string;        // from
  errorReason?: string;  // present only on failure
}
```

`Invoice402`, `PaymentProof`, and the `agentgate-402/1` version literal are **removed**. Encode/decode
helpers live in shared and are the single source of truth for both middleware and client:

```ts
export function encodeXPayment(p: PaymentPayload): string;          // base64(JSON)
export function decodeXPayment(header: string): PaymentPayload;     // parse+validate, throws on bad
export function encodeXPaymentResponse(s: SettlementResponse): string;
export function decodeXPaymentResponse(header: string): SettlementResponse;
```

## 5. Headers

| Direction | Header | Value | Replaces |
|---|---|---|---|
| 402 body | (none — JSON body) | `PaymentRequiredResponse` | `X-AgentGate-Price`, `X-AgentGate-Nonce` (removed) |
| Request proof | `X-PAYMENT` | base64(JSON `PaymentPayload`) | `X-Payment-Deploy-Hash` + `X-Payment-Nonce` (removed) |
| Paid 200 | `X-PAYMENT-RESPONSE` | base64(JSON `SettlementResponse`) | — (new) |
| Pending 402 | `Retry-After` | seconds (e.g. `2`) | `retry_after_ms` body field (removed) |

## 6. Flow

1. `GET /svc/:id` with **no** `X-PAYMENT` → issue a fresh nonce, persist the invoice, respond **402**
   `{ x402Version:1, error:"X-PAYMENT header is required", accepts:[ requirements(freshNonce) ] }`.
2. Client picks the `accepts[]` entry whose `network === chain.network` and `scheme === "exact"`;
   reads `maxAmountRequired` (price-cap guard), `payTo`, `extra.nonce`, `maxTimeoutSeconds`.
3. Client pays: `chain.transfer({ to: payTo, amountMotes: maxAmountRequired, transferId: extra.nonce })`.
4. Client retries with `X-PAYMENT = encodeXPayment({ x402Version:1, scheme, network,
   payload:{ transaction: deployHash, transferId: extra.nonce, from } })`.
5. Gateway `decodeXPayment` → assert `x402Version===1`, `scheme==="exact"`, `network===chain.network`;
   extract `payload.transaction` + `payload.transferId`. Look up the invoice by `transferId`
   (unknown/used/expired → re-challenge 402 with a fresh nonce + matching `error`). Then
   `verifyTransfer({ deployHash: transaction, expectedTarget: payTo, minAmountMotes: price,
   expectedTransferId: transferId, maxAgeMs: ttl })`:
   - **pending** → 402 + `Retry-After: 2` + the **same** requirements (same nonce kept alive).
   - **fail** → 402 + `error: <reason>` + fresh requirements (fresh nonce).
   - **ok** → `markUsed(nonce)` (single-use; one concurrent winner) → proxy upstream → **200** with
     `X-PAYMENT-RESPONSE = encodeXPaymentResponse({ success:true, transaction, network,
     payer: verify.from })` + body. Fire-and-forget attestation as today.

A malformed/undecodable `X-PAYMENT` is treated like a rejected proof: **402** + fresh requirements
+ `error:"invalid_payment_header"` (x402-idiomatic — never 5xx on a client proof problem).

## 7. Error model

- Every payment challenge is a 402 `PaymentRequiredResponse`; the human-readable `error` carries the
  reason. Reuse the existing machine reasons as the `error` string: `amount_too_low`, `wrong_target`,
  `wrong_transfer_id`, `invoice_used`, `invoice_expired`, `unknown_nonce`, `not_found`,
  plus new `invalid_payment_header`. Fresh (no-proof) challenge → `"X-PAYMENT header is required"`.
- `pending` → `error:"settlement_pending"` + `Retry-After` header (seconds).
- Non-payment failures keep the current `{ error: code }` envelope and status (out of scope).

## 8. File-by-file changes

| File | Change |
|---|---|
| `packages/shared/src/types.ts` | Remove `Invoice402`/`PaymentProof`; add the §4 types + `X402_*` consts. |
| `packages/shared/src/x402.ts` (new) | `encode/decodeXPayment`, `encode/decodeXPaymentResponse`, strict validators. |
| `packages/shared/src/index.ts` | Export the new module/types. |
| `packages/middleware/src/types.ts` | Drop `Invoice402Body`, `HEADER_AGENTGATE_*`, `HEADER_PAYMENT_*`; keep/extend `PaywallErrorCode` (+`invalid_payment_header`). Add `HEADER_X_PAYMENT='x-payment'`, `HEADER_X_PAYMENT_RESPONSE='X-PAYMENT-RESPONSE'`. |
| `packages/middleware/src/app.ts` | `buildRequirements()`/`respond402Fresh()`/`send402()` emit `PaymentRequiredResponse`; read+decode `X-PAYMENT`; `Retry-After` for pending; set `X-PAYMENT-RESPONSE` on the paid 200; build `resource` from the request URL (respecting `trust proxy`). |
| `packages/client/src/index.ts` | `parseInvoice402`→`parsePaymentRequired` (select entry by network+scheme); pay using `extra.nonce`; send `X-PAYMENT`; read `Retry-After` (seconds) for pending; surface decoded `X-PAYMENT-RESPONSE` in the result. |
| `packages/buyer-agent/src/*` | Follow renamed client result fields; no behavioral change. |

## 9. Testing

Update: `packages/middleware/test/{middleware.test.ts,helpers.ts}`, `packages/client/test/client.test.ts`,
`packages/buyer-agent/test/buyer-agent.test.ts`, `e2e/loop.test.ts`. Add:

- `encode/decodeXPayment` + `…Response` round-trip; reject non-base64, non-JSON, wrong `x402Version`,
  wrong `scheme`/`network`, missing payload fields.
- 402 body conforms to `PaymentRequiredResponse` (has `x402Version`, `error`, `accepts[0]` with all
  required fields; `extra.nonce` present).
- Pending path sets `Retry-After` (not a body field); client honors it (capped) and retries ≤ 5×.
- Paid 200 carries a decodable `X-PAYMENT-RESPONSE` with `success:true`, `transaction`, `payer`.
- Client selects the correct `accepts[]` entry by `network`+`scheme`; refuses network mismatch and
  over-cap price as before.

**Success criteria:** `npm run typecheck` clean · full vitest suite green · `npm run demo` still exits 0
with both tx hashes · e2e full loop passes against the x402 format.

## 10. Docs / UI

Update the copyable curl snippet in `dashboard/components/service-detail.tsx` and the
`dashboard/app/docs/{protocol,api,errors,sdk}` pages, plus `docs/SPEC.md`, `docs/ARCHITECTURE.md`, and
`README.md` (sequence diagram + mode matrix) to the x402 format.

## 11. Forward-compat (V2 — not now)

Keep types shaped so a later V2 migration is mechanical: `network` → CAIP-2 (`casper:casper-test`),
`maxAmountRequired` → `amount`, `resource`/`description`/`mimeType` hoisted into a `resource` object,
header-only transport (`PAYMENT-SIGNATURE`/`PAYMENT-RESPONSE`). No V2 code now.

## 12. Risks

- **Blast radius across tests + docs** — bounded (~6 source, ~5 test files, docs). Mitigated by the
  shared encode/decode module and updating tests in lockstep.
- **Demo must keep working** — the mock path is exercised by the same flow; `npm run demo` is the gate.
- **Scheme honesty** — using `scheme:"exact"` for a settled-transfer-proof variant is disclosed in
  `extra.settlement` and §2; not presented as the EVM facilitator-broadcast model.
