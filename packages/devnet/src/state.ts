import { createHash } from 'node:crypto';
import { AgentGateError, formatOg, stripTrailingSlashes } from '@agentgate/shared';
import type {
  ActivityEvent,
  AttestationRecord,
  ServiceRecord,
  ServiceScore,
  Wei,
} from '@agentgate/shared';

/** Activity feed retains at most this many events (oldest dropped). SPEC §3. */
export const ACTIVITY_LOG_CAP = 500;
/** Mirrors the on-chain contract: last 100 attestations per service. SPEC §10. */
export const ATTESTATIONS_PER_SERVICE_CAP = 100;
/**
 * Mirrors the on-chain contract: price must be ≥ 1e12 wei (1e-6 OG).
 * Keep this in sync with `AgentGateRegistry.MIN_PRICE_WEI`.
 */
export const MIN_PRICE_WEI = 1_000_000_000_000n;
/**
 * Transfer-lookup ring buffer cap (oldest tx hash dropped). The mock chain's
 * faucet/transfer are unauthenticated, so bound this map to keep memory finite.
 */
export const TRANSFER_LOG_CAP = 2000;
/**
 * Hard ceiling on registered services. register-service is unauthenticated on
 * the mock chain; cap it so the registry can't grow without bound.
 */
export const MAX_SERVICES = 1000;

/** Canonical (lowercased) EVM address form — the same shape live mode uses. */
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/**
 * Mock address derivation: `0x` + the first 20 bytes of sha256(publicKey).
 *
 * MUST stay byte-identical to `mockAccountAddress` in `packages/chain/src/mock.ts`
 * — the two sides derive the same identity independently (devnet cannot import
 * from @agentgate/chain, which depends on it), and any drift silently breaks
 * every balance, payment target and authorization check in mock mode.
 * `packages/chain/test/mock-client.test.ts` pins them against each other.
 *
 * Not a real EVM key derivation — mock signers carry no key material — but it
 * yields the same `0x<40hex>` SHAPE as live mode, so every address code path is
 * exercised identically in both modes.
 */
export function deriveAccountAddress(publicKey: string): string {
  if (typeof publicKey !== 'string' || publicKey.trim() === '') {
    throw new AgentGateError('invalid_public_key', 'publicKey must be a non-empty string', 400);
  }
  return `0x${createHash('sha256').update(publicKey).digest('hex').slice(0, 40)}`;
}

/**
 * Normalizes any account identifier to its canonical address:
 * already a `0x<40hex>` address → lowercased as-is; otherwise treated as a mock
 * public key and derived. Both forms reach the devnet legitimately — a buyer
 * faucets/pays by public key, while the gateway acts as the attestor using the
 * *address* the registry stored — so identity comparisons all go through here.
 */
export function normalizeAccount(account: string): string {
  const lower = account.trim().toLowerCase();
  return ADDRESS_RE.test(lower) ? lower : deriveAccountAddress(account);
}

export interface TransferRecord {
  txHash: string;
  fromPublicKey: string;
  /** Sender address (derived from fromPublicKey). */
  from: string;
  /** Target address. */
  to: string;
  amountWei: Wei;
  nonce: string;
  /**
   * Service this payment settles. `PaymentRouter.Paid` carries it as an indexed
   * topic, and a nonce is unique only per service — so verification matches on
   * the PAIR, exactly as the live client does.
   */
  serviceId: number;
  timestamp: number;
}

export interface TransferInput {
  fromPublicKey: string;
  to: string;
  amountWei: Wei;
  nonce: string;
  serviceId: number;
}

export interface RegisterInput {
  name: string;
  description: string;
  /** The GATEWAY BASE url; readers compute `<base>/svc/<id>` (SPEC §9 final decision). */
  endpointUrl: string;
  priceWei: Wei;
  paymentTarget: string;
  attestor: string;
  ownerPublicKey: string;
}

export interface AttestationInput {
  serviceId: number;
  paymentTxHash: string;
  success: boolean;
  byPublicKey: string;
}

interface InternalService {
  id: number;
  name: string;
  description: string;
  gatewayBaseUrl: string;
  priceWei: Wei;
  paymentTarget: string;
  /** Canonical address of the registering signer (mirrors the contract's `msg.sender`). */
  owner: string;
  /** Canonical address allowed to record attestations. */
  attestor: string;
  active: boolean;
  createdAt: number;
}

function err(httpStatus: number, code: string, message: string): AgentGateError {
  return new AgentGateError(code, message, httpStatus);
}

/**
 * In-memory mock of exactly what AgentGate uses on 0G: account balances in wei,
 * PaymentRouter-style payments carrying `(serviceId, nonce)`, the registry
 * contract's state and an activity log. Enforces the same rules as
 * `AgentGateRegistry` (attestor-or-owner auth, duplicate payment hash, inactive
 * service, owner-only setActive, the MIN_PRICE_WEI floor).
 */
export class DevnetState {
  private readonly balances = new Map<string, bigint>();
  private readonly transfers = new Map<string, TransferRecord>();
  /** Insertion order of `transfers` keys, oldest first — drives TRANSFER_LOG_CAP eviction. */
  private readonly transferOrder: string[] = [];
  private readonly services = new Map<number, InternalService>();
  private readonly scores = new Map<number, { total: number; success: number }>();
  /** Newest first, capped at ATTESTATIONS_PER_SERVICE_CAP per service. */
  private readonly attestations = new Map<number, AttestationRecord[]>();
  private readonly seenPayments = new Set<string>();
  /** Newest first, capped at ACTIVITY_LOG_CAP. */
  private readonly activity: ActivityEvent[] = [];
  private txCounter = 0;
  private nextServiceId = 1;

  /**
   * Deterministic-ish tx hash: `0x` + sha256(JSON.stringify(payload) + counter).
   *
   * The `0x` prefix is not cosmetic — the x402 proof envelope requires
   * `payload.transaction` to be a `0x`-prefixed 32-byte hash
   * (`packages/shared/src/x402.ts` TX_HASH_RE), so a bare-hex mock hash is
   * rejected as `invalid_payment_header` before verification is even reached.
   */
  private nextTxHash(payload: unknown): string {
    this.txCounter += 1;
    return `0x${createHash('sha256')
      .update(JSON.stringify(payload) + String(this.txCounter))
      .digest('hex')}`;
  }

  private pushActivity(event: ActivityEvent): void {
    this.activity.unshift(event);
    if (this.activity.length > ACTIVITY_LOG_CAP) this.activity.length = ACTIVITY_LOG_CAP;
  }

  private balanceOf(accountKey: string): bigint {
    return this.balances.get(accountKey) ?? 0n;
  }

  // ---- balances & transfers -------------------------------------------------

  faucet(account: string, amountWei: Wei): { balanceWei: Wei } {
    const key = normalizeAccount(account);
    const next = this.balanceOf(key) + BigInt(amountWei);
    this.balances.set(key, next);
    return { balanceWei: next.toString() };
  }

  getBalance(account: string): Wei {
    return this.balanceOf(normalizeAccount(account)).toString();
  }

  transfer(input: TransferInput): { txHash: string; timestamp: number } {
    const from = deriveAccountAddress(input.fromPublicKey);
    const to = normalizeAccount(input.to);
    const amount = BigInt(input.amountWei);
    const balance = this.balanceOf(from);
    if (balance < amount) {
      throw err(
        400,
        'insufficient_balance',
        `account ${from} has ${balance} wei, needs ${amount} wei`,
      );
    }
    const timestamp = Date.now();
    const txHash = this.nextTxHash({
      kind: 'transfer',
      from,
      to,
      amountWei: input.amountWei,
      nonce: input.nonce,
      serviceId: input.serviceId,
    });
    this.balances.set(from, balance - amount);
    this.balances.set(to, this.balanceOf(to) + amount);
    const record: TransferRecord = {
      txHash,
      fromPublicKey: input.fromPublicKey,
      from,
      to,
      amountWei: amount.toString(),
      nonce: input.nonce,
      serviceId: input.serviceId,
      timestamp,
    };
    this.transfers.set(txHash, record);
    this.transferOrder.push(txHash);
    while (this.transferOrder.length > TRANSFER_LOG_CAP) {
      const evicted = this.transferOrder.shift();
      if (evicted !== undefined) this.transfers.delete(evicted);
    }

    // The payment carries its own service id, exactly like `PaymentRouter.Paid`'s
    // indexed `serviceId` topic — never guessed from the payout target, which is
    // shared across services and would attribute the payment to the wrong one.
    this.pushActivity({
      kind: 'payment',
      txHash,
      serviceId: input.serviceId,
      amountWei: amount.toString(),
      timestamp,
      detail: `payment of ${formatOg(amount.toString())} to ${to} (nonce ${input.nonce})`,
    });
    return { txHash, timestamp };
  }

  getTransfer(txHash: string): TransferRecord {
    const record = this.transfers.get(txHash);
    if (!record) throw err(404, 'transfer_not_found', `no transfer with tx hash ${txHash}`);
    return record;
  }

  // ---- registry (mirrors AgentGateRegistry) ---------------------------------

  registerService(input: RegisterInput): { serviceId: number; txHash: string } {
    if (this.services.size >= MAX_SERVICES) {
      throw err(429, 'service_limit_reached', `mock chain caps the registry at ${MAX_SERVICES} services`);
    }
    if (input.name.trim() === '') throw err(400, 'empty_name', 'service name must not be empty');
    if (BigInt(input.priceWei) < MIN_PRICE_WEI) {
      throw err(400, 'invalid_price', `priceWei must be ≥ ${MIN_PRICE_WEI} wei`);
    }
    const paymentTarget = input.paymentTarget.trim().toLowerCase();
    if (!ADDRESS_RE.test(paymentTarget)) {
      throw err(400, 'invalid_payment_target', 'paymentTarget must be "0x<40 hex chars>"');
    }

    const serviceId = this.nextServiceId;
    this.nextServiceId += 1;
    const createdAt = Date.now();
    const txHash = this.nextTxHash({ kind: 'register_service', serviceId, name: input.name });
    const service: InternalService = {
      id: serviceId,
      name: input.name,
      description: input.description,
      gatewayBaseUrl: stripTrailingSlashes(input.endpointUrl),
      priceWei: BigInt(input.priceWei).toString(),
      paymentTarget,
      // The contract stores addresses. A mock signer is identified by its public
      // key, so store the address that key derives — `owner` then mirrors the
      // contract's `msg.sender` and compares against the payer identity that
      // `transfer` records.
      owner: normalizeAccount(input.ownerPublicKey),
      attestor: normalizeAccount(input.attestor),
      active: true,
      createdAt,
    };
    this.services.set(serviceId, service);
    this.scores.set(serviceId, { total: 0, success: 0 });
    this.attestations.set(serviceId, []);

    this.pushActivity({
      kind: 'service_registered',
      txHash,
      serviceId,
      timestamp: createdAt,
      detail: `service "${input.name}" registered (id ${serviceId}) at ${formatOg(service.priceWei)}/call`,
    });
    return { serviceId, txHash };
  }

  recordAttestation(input: AttestationInput): { txHash: string } {
    const service = this.services.get(input.serviceId);
    if (!service) throw err(404, 'service_not_found', `no service with id ${input.serviceId}`);
    const by = normalizeAccount(input.byPublicKey);
    if (by !== service.attestor && by !== service.owner) {
      throw err(
        403,
        'not_authorized',
        'attestations may only be recorded by the service attestor or owner',
      );
    }
    if (!service.active) {
      throw err(400, 'service_inactive', `service ${service.id} is inactive`);
    }
    const dupKey = `${service.id}:${input.paymentTxHash}`;
    if (this.seenPayments.has(dupKey)) {
      throw err(
        409,
        'duplicate_attestation',
        `payment ${input.paymentTxHash} already attested for service ${service.id}`,
      );
    }
    this.seenPayments.add(dupKey);

    const timestamp = Date.now();
    const txHash = this.nextTxHash({
      kind: 'record_attestation',
      serviceId: service.id,
      paymentTxHash: input.paymentTxHash,
      success: input.success,
    });
    const score = this.scores.get(service.id) ?? { total: 0, success: 0 };
    score.total += 1;
    if (input.success) score.success += 1;
    this.scores.set(service.id, score);

    const list = this.attestations.get(service.id) ?? [];
    list.unshift({
      serviceId: service.id,
      paymentTxHash: input.paymentTxHash,
      success: input.success,
      timestamp,
      recordTxHash: txHash,
    });
    if (list.length > ATTESTATIONS_PER_SERVICE_CAP) list.length = ATTESTATIONS_PER_SERVICE_CAP;
    this.attestations.set(service.id, list);

    this.pushActivity({
      kind: 'attestation',
      txHash,
      serviceId: service.id,
      success: input.success,
      timestamp,
      detail: `attestation ${input.success ? 'success' : 'failure'} for service ${service.id} (payment ${input.paymentTxHash.slice(0, 10)}…)`,
    });
    return { txHash };
  }

  setActive(serviceId: number, active: boolean, byPublicKey: string): { txHash: string } {
    const service = this.services.get(serviceId);
    if (!service) throw err(404, 'service_not_found', `no service with id ${serviceId}`);
    if (normalizeAccount(byPublicKey) !== service.owner) {
      throw err(403, 'not_authorized', 'only the service owner may change the active flag');
    }
    service.active = active;
    const txHash = this.nextTxHash({ kind: 'set_active', serviceId, active });
    return { txHash };
  }

  // ---- reads ----------------------------------------------------------------

  /** SPEC §9 final decision: every reader computes endpointUrl = `<gateway base>/svc/<id>`. */
  private toRecord(service: InternalService): ServiceRecord {
    return {
      id: service.id,
      name: service.name,
      description: service.description,
      endpointUrl: `${service.gatewayBaseUrl}/svc/${service.id}`,
      priceWei: service.priceWei,
      paymentTarget: service.paymentTarget,
      owner: service.owner,
      attestor: service.attestor,
      active: service.active,
      createdAt: service.createdAt,
    };
  }

  getService(serviceId: number): ServiceRecord {
    const service = this.services.get(serviceId);
    if (!service) throw err(404, 'service_not_found', `no service with id ${serviceId}`);
    return this.toRecord(service);
  }

  listServices(): ServiceRecord[] {
    return [...this.services.values()].map((s) => this.toRecord(s));
  }

  getScore(serviceId: number): ServiceScore {
    const score = this.scores.get(serviceId);
    return { totalCalls: score?.total ?? 0, successCalls: score?.success ?? 0 };
  }

  listAttestations(serviceId: number, limit?: number): AttestationRecord[] {
    const list = this.attestations.get(serviceId) ?? [];
    return list.slice(0, limit ?? list.length);
  }

  listActivity(limit: number): ActivityEvent[] {
    return this.activity.slice(0, limit);
  }
}
