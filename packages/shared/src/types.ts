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
  /**
   * Attest one served call. `nonce` + `payer` name the PaymentRouter settlement
   * that paid for it: the registry verifies that settlement exists and refuses
   * a payer that is the service's own owner or payout address, so a score
   * cannot be minted without a real arms-length payment. `paymentTxHash` is
   * carried for display only.
   */
  recordAttestation(input: { serviceId: number; nonce: string; payer: string; paymentTxHash: string; success: boolean }, signer: AnySigner): Promise<{ txHash: string }>;
  setActive(serviceId: number, active: boolean, signer: AnySigner): Promise<{ txHash: string }>;
  transfer(input: { to: string; amountWei: Wei; nonce: string; serviceId: number }, signer: AnySigner): Promise<{ txHash: string }>;
}
