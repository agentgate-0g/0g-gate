# x402 V1 Wire-Format Alignment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bespoke `agentgate-402/1` paywall protocol with the x402 V1 wire format (`x402Version:1`, `X-PAYMENT` / `X-PAYMENT-RESPONSE` headers, JSON 402 `PaymentRequirements` body, `Retry-After` for pending), keeping native-CSPR settlement as a disclosed `scheme:"exact"` settled-transfer-proof variant.

**Architecture:** A new shared codec module owns the x402 types + base64 encode/decode (single source of truth). Middleware emits a `PaymentRequiredResponse` and decodes `X-PAYMENT`; the client builds `X-PAYMENT` and reads `Retry-After` / `X-PAYMENT-RESPONSE`. Native CSPR transfer + `verifyTransfer` + nonce/SSRF/auth/attestation logic are unchanged.

**Tech Stack:** TypeScript (Node ≥22, ESM), Express 4, vitest, npm workspaces. Base64 via Node `Buffer`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-29-x402-api-alignment-design.md` (authoritative).
- `x402Version = 1`, `scheme = "exact"`, `asset = "CSPR"` (verbatim constants).
- `network` value = `chain.network` as-is (`'mock'` | `'casper-test'` | `'casper'`) — keep the client network-match guard trivial.
- Clean break: NO dual-support of `agentgate-402/1`; remove the old types/headers entirely.
- Out of scope (do not touch): facilitator `/verify`/`/settle`, RFC 9457 for non-payment errors, V2 transport, contracts, trust scoring, SSRF/nonce/auth/attestation behavior.
- Money is always motes (atomic), decimal strings — never floats/Number.
- Success gate (Task 4): `npm run typecheck` clean · full vitest green · `npm run demo` exits 0 with both tx hashes.
- Commits: author already configured as `mdlog`; do NOT add a Claude `Co-Authored-By` trailer (repo convention). Use `git commit --no-verify`.

---

## File Structure

- `packages/shared/src/x402.ts` **(new)** — x402 types, `X402_*` constants, base64 codec + validators.
- `packages/shared/src/types.ts` — remove `Invoice402` + `PaymentProof`.
- `packages/shared/src/index.ts` — export the new module.
- `packages/shared/test/x402.test.ts` **(new)** — codec round-trip + validation.
- `packages/middleware/src/types.ts` — drop old body/header consts; add x402 header names + `invalid_payment_header`.
- `packages/middleware/src/app.ts` — emit `PaymentRequiredResponse`, decode `X-PAYMENT`, `Retry-After`, `X-PAYMENT-RESPONSE`.
- `packages/middleware/test/helpers.ts` + `middleware.test.ts` — x402 request/assert shapes.
- `packages/client/src/index.ts` — `parsePaymentRequired`, send `X-PAYMENT`, read `Retry-After`/`X-PAYMENT-RESPONSE`.
- `packages/client/test/client.test.ts` — x402 assertions.
- `packages/buyer-agent/test/buyer-agent.test.ts`, `e2e/loop.test.ts` — follow renamed fields.
- Docs/UI: `dashboard/components/service-detail.tsx`, `dashboard/app/docs/{protocol,api,errors,sdk}/page.tsx`, `docs/SPEC.md`, `docs/ARCHITECTURE.md`, `README.md`.

---

## Task 1: Shared x402 types + codec

**Files:**
- Create: `packages/shared/src/x402.ts`
- Modify: `packages/shared/src/types.ts` (remove `Invoice402` lines 37-47 and `PaymentProof` line 49), `packages/shared/src/index.ts` (add export)
- Test: `packages/shared/test/x402.test.ts`

**Interfaces:**
- Produces: `X402_VERSION=1`, `X402_SCHEME='exact'`, `X402_ASSET_CSPR='CSPR'`; types `PaymentRequirements`, `CasperPaymentExtra`, `PaymentRequiredResponse`, `PaymentPayload`, `CasperExactPayload`, `SettlementResponse`; functions `encodeXPayment(p)`, `decodeXPayment(header)`, `encodeXPaymentResponse(s)`, `decodeXPaymentResponse(header)`. `decodeXPayment` throws `AgentGateError('INVALID_PAYMENT', msg, 402)` on any malformed input.

- [ ] **Step 1: Write the failing test** — `packages/shared/test/x402.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import {
  X402_VERSION, X402_SCHEME,
  encodeXPayment, decodeXPayment, encodeXPaymentResponse, decodeXPaymentResponse,
  type PaymentPayload, type SettlementResponse,
} from '../src/x402';
import { AgentGateError } from '../src/index';

const goodPayload: PaymentPayload = {
  x402Version: 1, scheme: 'exact', network: 'casper-test',
  payload: { transaction: 'a'.repeat(64), transferId: '42', from: 'account-hash-' + 'b'.repeat(64) },
};

describe('x402 codec', () => {
  it('round-trips an X-PAYMENT payload', () => {
    const decoded = decodeXPayment(encodeXPayment(goodPayload));
    expect(decoded.x402Version).toBe(1);
    expect(decoded.scheme).toBe('exact');
    expect(decoded.network).toBe('casper-test');
    expect(decoded.payload.transaction).toBe('a'.repeat(64));
    expect(decoded.payload.transferId).toBe('42');
    expect(decoded.payload.from).toBe('account-hash-' + 'b'.repeat(64));
  });

  it('round-trips a settlement response', () => {
    const s: SettlementResponse = { success: true, transaction: 'a'.repeat(64), network: 'casper-test', payer: 'account-hash-' + 'b'.repeat(64) };
    expect(decodeXPaymentResponse(encodeXPaymentResponse(s))).toEqual(s);
  });

  it('rejects non-base64 / non-JSON', () => {
    expect(() => decodeXPayment('@@@not-base64@@@')).toThrow(AgentGateError);
    expect(() => decodeXPayment(Buffer.from('not json', 'utf8').toString('base64'))).toThrow(AgentGateError);
  });

  it('rejects wrong x402Version / scheme', () => {
    expect(() => decodeXPayment(encodeXPayment({ ...goodPayload, x402Version: 2 }))).toThrow(/x402Version/);
    expect(() => decodeXPayment(encodeXPayment({ ...goodPayload, scheme: 'upto' }))).toThrow(/scheme/);
  });

  it('rejects a bad transaction hash or non-u64 transferId', () => {
    expect(() => decodeXPayment(encodeXPayment({ ...goodPayload, payload: { transaction: 'xyz', transferId: '42' } }))).toThrow(/transaction/);
    expect(() => decodeXPayment(encodeXPayment({ ...goodPayload, payload: { transaction: 'a'.repeat(64), transferId: 'NaN' } }))).toThrow(/transferId/);
  });

  it('omits from when absent', () => {
    const decoded = decodeXPayment(encodeXPayment({ ...goodPayload, payload: { transaction: 'a'.repeat(64), transferId: '7' } }));
    expect(decoded.payload.from).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/test/x402.test.ts`
Expected: FAIL — cannot resolve `../src/x402`.

- [ ] **Step 3: Create `packages/shared/src/x402.ts`**

```ts
import { AgentGateError } from './errors';

export const X402_VERSION = 1;
export const X402_SCHEME = 'exact';
export const X402_ASSET_CSPR = 'CSPR';

/** Casper-specific requirement data. `nonce` MUST be used as the native transfer_id. */
export interface CasperPaymentExtra {
  nonce: string;
  serviceId: number;
  expiresAtMs: number;
  settlement: 'casper-native-transfer';
  transferIdEncoding: 'u64-decimal';
}

/** One acceptable way to pay (an entry in `accepts[]`). */
export interface PaymentRequirements {
  scheme: string;
  network: string;
  maxAmountRequired: string; // motes (atomic), decimal string
  asset: string;             // 'CSPR'
  payTo: string;             // account-hash-<64hex>
  resource: string;          // absolute URL of /svc/:id
  description: string;
  mimeType?: string;
  maxTimeoutSeconds: number;
  extra: CasperPaymentExtra;
}

export interface PaymentRequiredResponse {
  x402Version: number;
  error: string;
  accepts: PaymentRequirements[];
}

export interface CasperExactPayload {
  transaction: string; // deploy hash of the settled native transfer
  transferId: string;  // = the issued nonce
  from?: string;       // payer account-hash
}

export interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: CasperExactPayload;
}

export interface SettlementResponse {
  success: boolean;
  transaction: string;
  network: string;
  payer?: string;
  errorReason?: string;
}

const NONCE_RE = /^\d{1,20}$/;
const DEPLOY_HASH_RE = /^[0-9a-fA-F]{64}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function badPayment(why: string): AgentGateError {
  return new AgentGateError('INVALID_PAYMENT', `invalid X-PAYMENT: ${why}`, 402);
}

export function encodeXPayment(p: PaymentPayload): string {
  return Buffer.from(JSON.stringify(p), 'utf8').toString('base64');
}

export function decodeXPayment(header: string): PaymentPayload {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    throw badPayment('not base64-encoded JSON');
  }
  if (!isRecord(json)) throw badPayment('not a JSON object');
  if (json['x402Version'] !== X402_VERSION) throw badPayment(`unsupported x402Version (expected ${X402_VERSION})`);
  if (json['scheme'] !== X402_SCHEME) throw badPayment(`unsupported scheme (expected "${X402_SCHEME}")`);
  if (typeof json['network'] !== 'string' || json['network'].trim() === '') throw badPayment('network must be a non-empty string');
  const payload = json['payload'];
  if (!isRecord(payload)) throw badPayment('payload must be an object');
  const transaction = payload['transaction'];
  const transferId = payload['transferId'];
  if (typeof transaction !== 'string' || !DEPLOY_HASH_RE.test(transaction)) throw badPayment('payload.transaction must be a 64-hex deploy hash');
  if (typeof transferId !== 'string' || !NONCE_RE.test(transferId)) throw badPayment('payload.transferId must be a u64 decimal string');
  const out: PaymentPayload = {
    x402Version: X402_VERSION,
    scheme: X402_SCHEME,
    network: json['network'],
    payload: { transaction, transferId },
  };
  if (typeof payload['from'] === 'string') out.payload.from = payload['from'];
  return out;
}

export function encodeXPaymentResponse(s: SettlementResponse): string {
  return Buffer.from(JSON.stringify(s), 'utf8').toString('base64');
}

export function decodeXPaymentResponse(header: string): SettlementResponse {
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as SettlementResponse;
}
```

> NOTE: confirm the `AgentGateError` import path — it is currently exported from `@agentgate/shared`; inside the package import it from the module that defines it (grep `class AgentGateError` under `packages/shared/src`). Adjust the `./errors` path in the import accordingly.

- [ ] **Step 4: Remove the old types** — `packages/shared/src/types.ts`

Delete the `Invoice402` interface (lines 37-47) and `PaymentProof` interface (line 49). Leave `VerifyTransferQuery`, `VerifyResult`, `ChainClient`, etc. untouched.

- [ ] **Step 5: Export the module** — add to `packages/shared/src/index.ts`

```ts
export * from './x402';
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run packages/shared/test/x402.test.ts && npm run typecheck -w @agentgate/shared`
Expected: PASS (6 tests) and no type errors in shared. (Type errors in middleware/client referencing removed `Invoice402` are expected and fixed in Tasks 2-3.)

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/x402.ts packages/shared/src/types.ts packages/shared/src/index.ts packages/shared/test/x402.test.ts
git commit --no-verify -m "feat(shared): x402 V1 types + base64 codec; drop Invoice402"
```

---

## Task 2: Middleware emits/consumes x402

**Files:**
- Modify: `packages/middleware/src/types.ts`, `packages/middleware/src/app.ts`
- Test: `packages/middleware/test/helpers.ts`, `packages/middleware/test/middleware.test.ts`

**Interfaces:**
- Consumes: Task 1's `PaymentRequirements`, `PaymentRequiredResponse`, `decodeXPayment`, `encodeXPaymentResponse`, `X402_VERSION`, `X402_SCHEME`, `X402_ASSET_CSPR`.
- Produces: gateway responds 402 with `PaymentRequiredResponse`; reads `x-payment` header; sets `X-PAYMENT-RESPONSE` on paid 200; `Retry-After` (seconds) on pending. New `proofHeaders(payload)` test helper returns `{ 'x-payment': <base64> }`.

- [ ] **Step 1: Update `packages/middleware/src/types.ts`**

```ts
export type PaywallErrorCode =
  | 'invoice_expired'
  | 'invoice_used'
  | 'unknown_nonce'
  | 'invalid_payment_header'
  | 'not_found'
  | 'wrong_target'
  | 'amount_too_low'
  | 'wrong_transfer_id'
  | 'expired'
  | 'pending';

/** x402 proof header (request) + settlement header (response). Lowercase on the wire. */
export const HEADER_X_PAYMENT = 'x-payment';
export const HEADER_X_PAYMENT_RESPONSE = 'X-PAYMENT-RESPONSE';
```

Remove `Invoice402Body`, `HEADER_PAYMENT_DEPLOY_HASH`, `HEADER_PAYMENT_NONCE`, `HEADER_AGENTGATE_PRICE`, `HEADER_AGENTGATE_NONCE`, and the `Invoice402` import.

- [ ] **Step 2: Update the failing tests** — `packages/middleware/test/helpers.ts`

Replace `payInvoice` and `proofHeaders`:

```ts
import { encodeXPayment, type PaymentRequiredResponse } from '@agentgate/shared';

/** GET the service and complete a full pay cycle, returning the x402 proof payload. */
export async function payInvoice(
  gw: TestGateway,
  serviceId: number,
  opts: { amountMotes?: string; pendingReads?: number } = {},
): Promise<{ deployHash: string; nonce: string; network: string }> {
  const challenge = await fetch(`${gw.baseUrl}/svc/${serviceId}`);
  if (challenge.status !== 402) throw new Error(`expected 402 challenge, got ${challenge.status}`);
  const body = (await challenge.json()) as PaymentRequiredResponse;
  const req = body.accepts[0];
  const { deployHash } = await gw.fake.transfer(
    { to: req.payTo, amountMotes: opts.amountMotes ?? req.maxAmountRequired, transferId: req.extra.nonce },
    { kind: 'mock', publicKey: '01buyer' },
  );
  if (opts.pendingReads !== undefined) gw.fake.setPending(deployHash, opts.pendingReads);
  return { deployHash, nonce: req.extra.nonce, network: req.network };
}

export function proofHeaders(proof: { deployHash: string; nonce: string; network: string }): Record<string, string> {
  return {
    'x-payment': encodeXPayment({
      x402Version: 1, scheme: 'exact', network: proof.network,
      payload: { transaction: proof.deployHash, transferId: proof.nonce },
    }),
  };
}
```

- [ ] **Step 3: Update `packages/middleware/test/middleware.test.ts` assertions**

The "fresh 402 challenge" test (lines ~50-66) becomes:

```ts
const body = (await res.json()) as PaymentRequiredResponse;
expect(body.x402Version).toBe(1);
expect(body.error).toBe('X-PAYMENT header is required');
const req = body.accepts[0];
expect(req.scheme).toBe('exact');
expect(req.asset).toBe('CSPR');
expect(req.network).toBe(gw.fake.network);
expect(req.description).toBe('Gold Spot Feed');
expect(req.maxAmountRequired).toBe('500000000');
expect(req.payTo).toMatch(/^account-hash-[0-9a-f]{64}$/);
expect(req.resource).toContain('/svc/1');
expect(req.maxTimeoutSeconds).toBe(gw.config.invoiceTtlMs / 1000);
expect(req.extra.nonce).toMatch(/^\d+$/);
expect(BigInt(req.extra.nonce) < 2n ** 64n).toBe(true);
expect(req.extra.expiresAtMs).toBeGreaterThanOrEqual(before + gw.config.invoiceTtlMs - 1000);
expect(req.extra.settlement).toBe('casper-native-transfer');
// no X-AgentGate-* headers anymore
expect(res.headers.get('x-agentgate-price')).toBeNull();
```

For each rejected-proof test, read `body.accepts[0].extra.nonce` instead of `body.nonce`, and keep the `body.error` assertions (`invoice_used`, `unknown_nonce`, `amount_too_low`, `not_found`, `invoice_expired`) — these `error` values are unchanged. The "fresh invoice issued" check becomes `expect(body.accepts[0].extra.nonce).not.toBe(proof.nonce)`. Replace the `Invoice402Body` type import with `PaymentRequiredResponse`.

The pending test (lines ~180-187) becomes:

```ts
const pending = await fetch(`${gw.baseUrl}/svc/1`, { headers: proofHeaders(proof) });
expect(pending.status).toBe(402);
expect(pending.headers.get('retry-after')).toBe('2'); // seconds, standard header
const pendingBody = (await pending.json()) as PaymentRequiredResponse;
expect(pendingBody.error).toBe('settlement_pending');
expect(pendingBody.accepts[0].extra.nonce).toBe(proof.nonce); // invoice stays alive
```

For the "unknown/missing nonce" tests (lines ~139-151): a missing `x-payment` header now yields the fresh challenge `error: 'X-PAYMENT header is required'`; a syntactically valid `X-PAYMENT` whose `transferId` matches no invoice yields `error: 'unknown_nonce'`. Update both expectations accordingly (build the header with `proofHeaders`). Add one test: a malformed `x-payment` (e.g. `headers: { 'x-payment': 'not-base64' }`) → 402 with `error: 'invalid_payment_header'`.

Add a "paid 200 carries X-PAYMENT-RESPONSE" assertion to the happy-path test:

```ts
const resp = paid.headers.get('x-payment-response');
expect(resp).not.toBeNull();
const settlement = decodeXPaymentResponse(resp!);
expect(settlement.success).toBe(true);
expect(settlement.transaction).toBe(proof.deployHash);
expect(settlement.network).toBe(gw.fake.network);
```

(Import `decodeXPaymentResponse`, `PaymentRequiredResponse` from `@agentgate/shared`.)

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run packages/middleware`
Expected: FAIL — app.ts still emits the old body/headers.

- [ ] **Step 5: Update `packages/middleware/src/app.ts`**

Replace the imports from `./types` and `@agentgate/shared` to bring in `HEADER_X_PAYMENT`, `HEADER_X_PAYMENT_RESPONSE`, `PaymentRequirements`, `PaymentRequiredResponse`, `decodeXPayment`, `encodeXPaymentResponse`, `X402_VERSION`, `X402_SCHEME`, `X402_ASSET_CSPR`, and `AgentGateError`.

Replace `buildInvoiceBody`/`send402`/`respond402Fresh` with:

```ts
function buildRequirements(
  service: ServiceRecord, nonce: string, expiresAt: number, resource: string,
): PaymentRequirements {
  return {
    scheme: X402_SCHEME,
    network: chain.network,
    maxAmountRequired: service.priceMotes,
    asset: X402_ASSET_CSPR,
    payTo: service.paymentTarget,
    resource,
    description: service.name,
    maxTimeoutSeconds: Math.floor(config.invoiceTtlMs / 1000),
    extra: {
      nonce,
      serviceId: service.id,
      expiresAtMs: expiresAt,
      settlement: 'casper-native-transfer',
      transferIdEncoding: 'u64-decimal',
    },
  };
}

function send402(
  res: Response, error: string, requirements: PaymentRequirements, retryAfterSeconds?: number,
): void {
  if (retryAfterSeconds !== undefined) res.set('Retry-After', String(retryAfterSeconds));
  const body: PaymentRequiredResponse = { x402Version: X402_VERSION, error, accepts: [requirements] };
  res.status(402).json(body);
}

async function respond402Fresh(
  res: Response, service: ServiceRecord, resource: string, error: string,
): Promise<void> {
  const nonce = randomNonce();
  const expiresAt = Date.now() + config.invoiceTtlMs;
  await invoices.put({ nonce, serviceId: service.id, priceMotes: service.priceMotes, expiresAt, used: false });
  send402(res, error, buildRequirements(service, nonce, expiresAt, resource));
}
```

In the `app.all('/svc/:id', ...)` handler, after resolving `service`/`upstreamUrl`/SSRF, compute the resource and switch the proof source to `X-PAYMENT`:

```ts
const resource = `${req.protocol}://${req.get('host') ?? 'localhost'}${req.originalUrl}`;

// 2. No payment proof → fresh 402 challenge.
const xPayment = req.header(HEADER_X_PAYMENT)?.trim() ?? '';
if (xPayment === '') {
  await respond402Fresh(res, service, resource, 'X-PAYMENT header is required');
  return;
}

// 2b. Decode the proof (malformed → re-challenge, never 5xx).
let payment;
try {
  payment = decodeXPayment(xPayment);
} catch {
  await respond402Fresh(res, service, resource, 'invalid_payment_header');
  return;
}
if (payment.network !== chain.network) {
  await respond402Fresh(res, service, resource, 'wrong_target');
  return;
}
const deployHashHeader = payment.payload.transaction;
const nonceHeader = payment.payload.transferId;

// 3. Validate the invoice behind the presented nonce. (unchanged below, using nonceHeader)
const invoice = await invoices.get(nonceHeader);
if (!invoice || invoice.serviceId !== id) { await respond402Fresh(res, service, resource, 'unknown_nonce'); return; }
if (invoice.used) { await respond402Fresh(res, service, resource, 'invoice_used'); return; }
if (Date.now() > invoice.expiresAt) { await respond402Fresh(res, service, resource, 'invoice_expired'); return; }
```

In the verify block, replace the pending and fail branches:

```ts
if (!verdict.ok) {
  if (verdict.reason === 'pending') {
    send402(res, 'settlement_pending', buildRequirements(service, nonceHeader, invoice.expiresAt, resource), 2);
    return;
  }
  await respond402Fresh(res, service, resource, verdict.reason);
  return;
}
```

After `markUsed` and the successful proxy, set the settlement header before sending the body:

```ts
res.set(
  HEADER_X_PAYMENT_RESPONSE,
  encodeXPaymentResponse({
    success: true,
    transaction: deployHashHeader,
    network: chain.network,
    payer: verdict.from,
  }),
);
// then the existing res.status(outcome.status)/res.send(outcome.body) path
```

(`verdict.from` exists on the `{ ok: true }` branch of `VerifyResult`.) Remove the now-unused `NONCE_RE` constant only if nothing else uses it (the nonce is now validated inside `decodeXPayment`).

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run packages/middleware && npm run typecheck -w @agentgate/middleware`
Expected: PASS (all middleware tests) and no type errors.

- [ ] **Step 7: Commit**

```bash
git add packages/middleware/src/types.ts packages/middleware/src/app.ts packages/middleware/test/helpers.ts packages/middleware/test/middleware.test.ts
git commit --no-verify -m "feat(middleware): emit x402 PaymentRequirements; consume X-PAYMENT; Retry-After + X-PAYMENT-RESPONSE"
```

---

## Task 3: Client consumes x402

**Files:**
- Modify: `packages/client/src/index.ts`
- Test: `packages/client/test/client.test.ts`

**Interfaces:**
- Consumes: Task 1's `PaymentRequirements`, `PaymentRequiredResponse`, `SettlementResponse`, `encodeXPayment`, `decodeXPaymentResponse`, `X402_VERSION`, `X402_SCHEME`.
- Produces: `parsePaymentRequired(raw, chainNetwork, now?)` → `PaymentRequirements`; `PayAndFetchResult` gains `requirements?: PaymentRequirements` and `settlement?: SettlementResponse` (replacing `invoice?`).

- [ ] **Step 1: Update the failing test** — `packages/client/test/client.test.ts`

Wherever the mock middleware returns a 402, change its body to a `PaymentRequiredResponse` and its proof-check to read the `x-payment` header. Representative fixture:

```ts
import { encodeXPayment, type PaymentRequiredResponse, type PaymentPayload } from '@agentgate/shared';

function requirements(nonce: string, network: string): PaymentRequiredResponse {
  return {
    x402Version: 1,
    error: 'X-PAYMENT header is required',
    accepts: [{
      scheme: 'exact', network, maxAmountRequired: '500000000', asset: 'CSPR',
      payTo: 'account-hash-' + 'a'.repeat(64), resource: 'http://svc.test/svc/1',
      description: 'Test', maxTimeoutSeconds: 300,
      extra: { nonce, serviceId: 1, expiresAtMs: Date.now() + 300_000, settlement: 'casper-native-transfer', transferIdEncoding: 'u64-decimal' },
    }],
  };
}
```

The fake fetch: 1st call (no `x-payment`) → 402 `requirements('42', 'mock')`; 2nd call must carry `x-payment`, decode it, assert `payload.transferId === '42'`, then 200 with header `x-payment-response` = `encodeXPaymentResponse({ success:true, transaction: <hash>, network:'mock' })`. Assertions:

```ts
const r = await client.fetchPaid('http://svc.test/svc/1');
expect(r.paid).toBe(true);
expect(r.status).toBe(200);
expect(r.requirements?.maxAmountRequired).toBe('500000000');
expect(r.settlement?.success).toBe(true);
```

Add a pending test: middleware returns 402 with header `retry-after: 1` twice, then 200; assert the client retried and finally succeeded. Keep the existing network-mismatch and price-cap tests, updating them to the new body shape (mismatch = `accepts[0].network !== chain.network`; over-cap = `maxAmountRequired` > `maxPriceMotes`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/client`
Expected: FAIL — client still parses `agentgate-402/1`.

- [ ] **Step 3: Rewrite the parse + pay path in `packages/client/src/index.ts`**

Replace `parseInvoice402` with `parsePaymentRequired`:

```ts
import {
  encodeXPayment, decodeXPaymentResponse,
  X402_VERSION, X402_SCHEME,
  type PaymentRequirements, type PaymentRequiredResponse, type SettlementResponse,
} from '@agentgate/shared';

const ACCOUNT_HASH_RE = /^account-hash-[0-9a-fA-F]{64}$/;
const NONCE_RE = /^\d{1,20}$/;
const U64_MAX = 18_446_744_073_709_551_615n;

export function parsePaymentRequired(
  raw: unknown, chainNetwork: string, now: number = Date.now(),
): PaymentRequirements {
  if (!isRecord(raw)) throw badInvoice('body is not a JSON object');
  if (raw['x402Version'] !== X402_VERSION) throw badInvoice(`unsupported x402Version (expected ${X402_VERSION})`);
  const accepts = raw['accepts'];
  if (!Array.isArray(accepts) || accepts.length === 0) throw badInvoice('accepts must be a non-empty array');
  const req = accepts.find(
    (a): a is PaymentRequirements => isRecord(a) && a['scheme'] === X402_SCHEME && a['network'] === chainNetwork,
  );
  if (!req) throw badInvoice(`no accepts entry for scheme "${X402_SCHEME}" on network "${chainNetwork}"`);
  if (typeof req.maxAmountRequired !== 'string') throw badInvoice('maxAmountRequired must be a string');
  parseMotes(req.maxAmountRequired); // throws on garbage
  if (typeof req.payTo !== 'string' || !ACCOUNT_HASH_RE.test(req.payTo)) throw badInvoice('payTo must be "account-hash-<64 hex>"');
  const nonce = req.extra?.nonce;
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce) || BigInt(nonce) > U64_MAX) throw badInvoice('extra.nonce must be a u64 decimal string');
  if (typeof req.extra?.expiresAtMs !== 'number' || req.extra.expiresAtMs <= now) throw badInvoice('invoice is expired — refusing to pay');
  return req;
}
```

In `fetchPaid`, replace the body of the 402 branch (after the network/JSON guards). Selection + price guard + pay:

```ts
const req = parsePaymentRequired(first.body, chain.network);
// network is already matched inside parsePaymentRequired (accepts entry by chain.network)
if (maxPriceMotes !== undefined && compareMotes(req.maxAmountRequired, maxPriceMotes) > 0) {
  throw new AgentGateError('PRICE_EXCEEDED', `invoice price ${req.maxAmountRequired} motes exceeds maxPriceMotes ${maxPriceMotes}`, 402);
}
const { deployHash } = await chain.transfer(
  { to: req.payTo, amountMotes: req.maxAmountRequired, transferId: req.extra.nonce }, signer,
);
await sleep(settleDelayMs);

const headers = new Headers(init?.headers);
headers.set('X-PAYMENT', encodeXPayment({
  x402Version: X402_VERSION, scheme: X402_SCHEME, network: chain.network,
  payload: { transaction: deployHash, transferId: req.extra.nonce },
}));
const proofInit: RequestInit = { ...init, headers };
```

Update the retry loop: success path reads the settlement header and returns it; pending path reads the `Retry-After` header (seconds). Extend `readBody`/`FetchedBody` to surface them:

```ts
interface FetchedBody { status: number; body: unknown; isJson: boolean; retryAfterMs?: number; settlement?: SettlementResponse; }

async function readBody(res: Response): Promise<FetchedBody> {
  // ... existing text/JSON parsing produces { status, body, isJson } ...
  const ra = res.headers.get('retry-after');
  const retryAfterMs = ra !== null && /^\d+$/.test(ra) ? Math.min(Number(ra) * 1000, MAX_RETRY_AFTER_MS) : undefined;
  let settlement: SettlementResponse | undefined;
  const sp = res.headers.get('x-payment-response');
  if (sp !== null) { try { settlement = decodeXPaymentResponse(sp); } catch { settlement = undefined; } }
  return { status: res.status, body, isJson, retryAfterMs, settlement };
}
```

In the loop, replace `retryAfterMs(res.body)` with `res.retryAfterMs`, and on the non-402 success return include `requirements: req` and `settlement: res.settlement` (replace the old `invoice` field). Delete `INVOICE_VERSION`, `HEADER_DEPLOY_HASH`, `HEADER_NONCE`, the old `parseInvoice402`, and the standalone `retryAfterMs(body)` helper. Update `PayAndFetchResult`:

```ts
export interface PayAndFetchResult {
  status: number; body: unknown; paid: boolean;
  requirements?: PaymentRequirements;
  settlement?: SettlementResponse;
  deployHash?: string; priceMotes?: Motes;
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run packages/client && npm run typecheck -w @agentgate/client`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/index.ts packages/client/test/client.test.ts
git commit --no-verify -m "feat(client): parse x402 PaymentRequirements; send X-PAYMENT; honor Retry-After + X-PAYMENT-RESPONSE"
```

---

## Task 4: buyer-agent, e2e, and full-suite green

**Files:**
- Modify (if referenced): `packages/buyer-agent/src/index.ts`, `packages/buyer-agent/test/buyer-agent.test.ts`, `e2e/loop.test.ts`

**Interfaces:**
- Consumes: the updated client `PayAndFetchResult` (`requirements`/`settlement` instead of `invoice`).

- [ ] **Step 1: Find references to removed fields**

Run: `grep -rn "\.invoice\b\|agentgate-402\|x-payment-deploy-hash\|x-payment-nonce\|retry_after_ms\|Invoice402" packages/buyer-agent e2e`
Expected: a short list. For each `result.invoice` usage in buyer-agent, switch to `result.requirements` (e.g. `requirements?.maxAmountRequired` for price, `requirements?.extra.serviceId`). The buyer-agent's decision/budget logic uses `priceMotes`/`deployHash` from the result, which are unchanged.

- [ ] **Step 2: Update `e2e/loop.test.ts`**

The full-loop test asserts the 402 invoice shape and builds proof headers. Change the 402 assertion to the x402 body (`body.accepts[0].extra.nonce`, `maxAmountRequired`, `payTo`) and the proof to a single `X-PAYMENT` header via `encodeXPayment` (mirror `payInvoice`/`proofHeaders` from Task 2). Keep all economy assertions (underpay→`amount_too_low` with fresh nonce, exact-pay→200 proxying the oracle bytes, replay→`invoice_used`, attestation polled within 5s, score (1,1), three activity-event kinds, TTL expiry, inactive→403) — only the wire shapes change, not the behavior.

- [ ] **Step 3: Run the whole suite + typecheck**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck clean; ALL test files green (the count rises by the new x402 codec tests — expect ≥ 274 + new).

- [ ] **Step 4: Run the demo (behavioral gate)**

Run: `npm run demo`
Expected: exit 0; prints a payment deploy hash + an attestation tx hash + score 1/1. The loop now speaks x402 end-to-end on the mock chain.

- [ ] **Step 5: Commit**

```bash
git add packages/buyer-agent e2e
git commit --no-verify -m "test(buyer-agent,e2e): drive the x402 wire format end-to-end"
```

---

## Task 5: Docs + dashboard UI

**Files:**
- Modify: `dashboard/components/service-detail.tsx`, `dashboard/app/docs/{protocol,api,errors,sdk}/page.tsx`, `docs/SPEC.md`, `docs/ARCHITECTURE.md`, `README.md`

**Interfaces:** none (documentation/UI only).

- [ ] **Step 1: Update the copyable curl snippet** — `dashboard/components/service-detail.tsx`

Find the snippet that shows the 402 flow (currently references `X-Payment-Deploy-Hash`/`X-Payment-Nonce` and the `agentgate-402/1` body). Replace it with the x402 flow: a plain `GET /svc/:id` returning the `PaymentRequiredResponse`, then a retry with `-H "X-PAYMENT: <base64 payload>"`. Keep it copy-pasteable and accurate to Task 2's behavior.

- [ ] **Step 2: Update the docs pages**

In `dashboard/app/docs/protocol/page.tsx` (and `api`, `errors`, `sdk`): replace descriptions of `agentgate-402/1`, the `X-AgentGate-*` / `X-Payment-*` headers, and `retry_after_ms` with the x402 V1 model — the `PaymentRequiredResponse` body (`x402Version`, `error`, `accepts[]`), the `X-PAYMENT` (base64 `PaymentPayload`) request header, the `X-PAYMENT-RESPONSE` settlement header, and the standard `Retry-After` for pending. Note the disclosed `scheme:"exact"` settled-transfer-proof variant and `extra.settlement`.

- [ ] **Step 3: Update `docs/SPEC.md`, `docs/ARCHITECTURE.md`, `README.md`**

Update the §5/§6 protocol descriptions and the README sequence diagram (steps 5-7: `402 PaymentRequirements` → `X-PAYMENT` proof → `X-PAYMENT-RESPONSE` on 200) and the mode-matrix line so the wire format reads x402 V1. Keep payment semantics (native CSPR transfer carrying the nonce as `transfer_id`) accurate.

- [ ] **Step 4: Verify the dashboard builds + typecheck**

Run: `npm run typecheck && npm run build -w dashboard`
Expected: typecheck clean; `next build` succeeds.

- [ ] **Step 5: Commit**

```bash
git add dashboard/components/service-detail.tsx dashboard/app/docs docs/SPEC.md docs/ARCHITECTURE.md README.md
git commit --no-verify -m "docs(api,dashboard): document the x402 V1 wire format"
```

---

## Self-Review

**Spec coverage:** §4 types → Task 1. §5 headers → Tasks 2-3. §6 flow → Task 2 (server) + Task 3 (client). §7 error model → Task 2 (error strings, Retry-After) + Task 3 (honor Retry-After). §8 file list → Tasks 1-5 map 1:1. §9 testing → Tasks 1-4. §10 docs → Task 5. §11 V2-forward → types in Task 1 are flat/extensible (no V2 code, as specified). No spec section is unmapped.

**Placeholder scan:** all code steps contain concrete code; the only deferred detail is the `AgentGateError` import path (Task 1 Step 3 note) and the dashboard snippet/doc prose (Task 5) which is content-editing, not logic. No "TODO/handle edge cases/similar to Task N".

**Type consistency:** `PaymentRequirements`, `PaymentRequiredResponse`, `PaymentPayload`, `CasperExactPayload`, `SettlementResponse`, `CasperPaymentExtra`, `encodeXPayment`, `decodeXPayment`, `encodeXPaymentResponse`, `decodeXPaymentResponse`, `X402_VERSION`, `X402_SCHEME`, `X402_ASSET_CSPR` are defined in Task 1 and used with identical names/signatures in Tasks 2-3. `extra.nonce` is the single binding used as the transfer_id across middleware, client, and tests. `verdict.from` (from `VerifyResult` `{ok:true}`) feeds `SettlementResponse.payer`.
