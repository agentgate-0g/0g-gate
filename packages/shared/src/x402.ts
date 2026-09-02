import { AgentGateError } from './errors';

export const X402_VERSION = 1;

/**
 * The payment scheme this gateway advertises and accepts.
 *
 * NOT `"exact"`, deliberately. AgentGate uses the x402 V1 *envelope* — the 402
 * body, `accepts[]`/`PaymentRequirements`, `X-PAYMENT` and `X-PAYMENT-RESPONSE`
 * — but its settlement is the inverse of x402's `exact` scheme:
 *
 *   x402 `exact`  the payer signs an AUTHORIZATION; the resource server (or a
 *                 facilitator) submits it and settles.
 *   this scheme   the payer SETTLES FIRST, on-chain, through PaymentRouter.pay,
 *                 and presents the resulting tx hash as proof.
 *
 * Advertising `"exact"` would be a promise of interop this gateway cannot keep:
 * a generic x402 client would sign an authorization and get a 402 back forever,
 * because what is wanted is a settled tx hash. A distinct name makes that
 * client fail fast and legibly ("no accepts entry for the scheme I support")
 * instead of failing mysteriously.
 *
 * 0G has no x402 facilitator, so settled-proof is the only rail available here
 * — this name states that rather than hiding it.
 */
export const X402_SCHEME = 'exact-settled';
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

/** One acceptable way to pay (an entry in `accepts[]`). */
export interface PaymentRequirements {
  scheme: string;
  network: string;
  maxAmountRequired: string; // wei (atomic), decimal string
  asset: string;             // 'OG'
  payTo: string;             // 0x<40hex>
  resource: string;          // absolute URL of /svc/:id
  description: string;
  mimeType?: string;
  maxTimeoutSeconds: number;
  extra: ZgPaymentExtra;
}

export interface PaymentRequiredResponse {
  x402Version: number;
  error: string;
  accepts: PaymentRequirements[];
}

export interface ZgExactPayload {
  /** Tx hash of the settled PaymentRouter.pay() call, `0x` + 64 hex. */
  transaction: string;
  /** The issued invoice nonce (decimal uint256 string). */
  nonce: string;
  /** Payer address, `0x` + 40 hex. */
  from?: string;
  /**
   * EIP-191 signature over `buildPaymentProofMessage(...)`, proving the
   * presenter holds the key that paid. REQUIRED in live mode — the gateway
   * refuses a proof without it, because {transaction, nonce} alone are readable
   * off the public chain by anyone. Optional on the wire only so a missing
   * signature can be reported as a precise 402 rather than a parse failure.
   */
  signature?: string;
}

export interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: ZgExactPayload;
}

export interface SettlementResponse {
  success: boolean;
  transaction: string;
  network: string;
  payer?: string;
  errorReason?: string;
}

/** CAIP-2 network identifier, e.g. `eip155:16602`. */
export type Caip2Network = `eip155:${number}`;

/** chainId → CAIP-2. */
export function toCaip2Network(chainId: number): Caip2Network {
  return `eip155:${chainId}`;
}

const NONCE_RE = /^\d{1,78}$/;            // uint256 decimal
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/; // 0x + 32-byte transaction hash
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/; // 0x + r(32) + s(32) + v(1)

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
  const nonce = payload['nonce'];
  if (typeof transaction !== 'string' || !TX_HASH_RE.test(transaction)) throw badPayment('payload.transaction must be a 0x-prefixed 32-byte transaction hash');
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) throw badPayment('payload.nonce must be a uint256 decimal string');
  // NONCE_RE only bounds digit count (≤78), and 2^256-1 is itself a 78-digit
  // number — so a 78-digit string can still exceed uint256 range. Catch that
  // here rather than let it reach viem's ABI encoder downstream. NONCE_RE
  // already guarantees pure digits, so BigInt(nonce) cannot throw.
  if (BigInt(nonce) > 2n ** 256n - 1n) throw badPayment('nonce exceeds uint256 range');
  const out: PaymentPayload = {
    x402Version: X402_VERSION,
    scheme: X402_SCHEME,
    network: json['network'],
    payload: { transaction, nonce },
  };
  if (typeof payload['from'] === 'string') out.payload.from = payload['from'];
  // Shape-check only. Whether a signature is REQUIRED, and whether it recovers
  // to the on-chain payer, is the gateway's call (it needs the verified payer
  // to compare against, which decoding cannot know). 0x + r(32)+s(32)+v(1).
  const signature = payload['signature'];
  if (signature !== undefined) {
    if (typeof signature !== 'string' || !SIGNATURE_RE.test(signature)) {
      throw badPayment('payload.signature must be a 0x-prefixed 65-byte secp256k1 signature');
    }
    out.payload.signature = signature;
  }
  return out;
}

export function encodeXPaymentResponse(s: SettlementResponse): string {
  return Buffer.from(JSON.stringify(s), 'utf8').toString('base64');
}

export function decodeXPaymentResponse(header: string): SettlementResponse {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  } catch {
    throw new AgentGateError('INVALID_PAYMENT', 'X-PAYMENT-RESPONSE is not base64-encoded JSON', 402);
  }
  if (!isRecord(json)) throw new AgentGateError('INVALID_PAYMENT', 'X-PAYMENT-RESPONSE is not a JSON object', 402);
  if (typeof json['success'] !== 'boolean') throw new AgentGateError('INVALID_PAYMENT', 'X-PAYMENT-RESPONSE: success must be a boolean', 402);
  if (typeof json['transaction'] !== 'string' || json['transaction'] === '') throw new AgentGateError('INVALID_PAYMENT', 'X-PAYMENT-RESPONSE: transaction must be a non-empty string', 402);
  if (typeof json['network'] !== 'string' || json['network'] === '') throw new AgentGateError('INVALID_PAYMENT', 'X-PAYMENT-RESPONSE: network must be a non-empty string', 402);
  const out: SettlementResponse = {
    success: json['success'],
    transaction: json['transaction'],
    network: json['network'],
  };
  if (typeof json['payer'] === 'string') out.payer = json['payer'];
  if (typeof json['errorReason'] === 'string') out.errorReason = json['errorReason'];
  return out;
}
