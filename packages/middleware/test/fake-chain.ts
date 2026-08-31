import { createHash } from 'node:crypto';
import {
  compareWei,
  type ActivityEvent,
  type AnySigner,
  type AttestationRecord,
  type ChainClient,
  type RegisterServiceInput,
  type ServiceRecord,
  type ServiceScore,
  type VerifyResult,
  type VerifyTransferQuery,
  type Wei,
} from '@agentgate/shared';

interface FakeTransfer {
  to: string;
  amountWei: Wei;
  nonce: string;
  serviceId: number;
  timestamp: number;
  from: string;
  /** While > 0, verifyTransfer returns 'pending' and decrements. */
  pendingReads: number;
}

/**
 * Minimal in-memory ChainClient fake for middleware tests.
 * Depends ONLY on the ChainClient interface from @agentgate/shared —
 * no devnet, no chain impl details.
 */
export class FakeChainClient implements ChainClient {
  readonly network = 'mock';
  readonly services = new Map<number, ServiceRecord>();
  readonly attestations: AttestationRecord[] = [];
  readonly transfers = new Map<string, FakeTransfer>();
  /** When > 0, recordAttestation throws and decrements (retry testing). */
  failAttestations = 0;
  private counter = 0;

  private nextHash(seed: string): string {
    this.counter += 1;
    return `0x${createHash('sha256').update(`${seed}:${this.counter}`).digest('hex')}`;
  }

  addService(partial: Partial<ServiceRecord> & { id: number }): ServiceRecord {
    const record: ServiceRecord = {
      name: `service-${partial.id}`,
      description: 'test service',
      endpointUrl: `http://gateway.test/svc/${partial.id}`,
      priceWei: '500000000000000000', // 0.5 OG — must clear the real registry's MIN_PRICE_WEI (1e12)
      paymentTarget: `0x${'ab'.repeat(20)}`,
      owner: `0x${'aa'.repeat(20)}`,
      attestor: `0x${'bb'.repeat(20)}`,
      active: true,
      createdAt: Date.now(),
      ...partial,
    };
    this.services.set(record.id, record);
    return record;
  }

  /** Marks an existing transfer as settling for the next `reads` verify calls. */
  setPending(txHash: string, reads: number): void {
    const transfer = this.transfers.get(txHash);
    if (!transfer) throw new Error(`no such transfer: ${txHash}`);
    transfer.pendingReads = reads;
  }

  getService(id: number): Promise<ServiceRecord | null> {
    return Promise.resolve(this.services.get(id) ?? null);
  }

  listServices(): Promise<ServiceRecord[]> {
    return Promise.resolve([...this.services.values()]);
  }

  getScore(id: number): Promise<ServiceScore> {
    const mine = this.attestations.filter((a) => a.serviceId === id);
    return Promise.resolve({
      totalCalls: mine.length,
      successCalls: mine.filter((a) => a.success).length,
    });
  }

  listAttestations(serviceId: number, limit = 50): Promise<AttestationRecord[]> {
    return Promise.resolve(
      this.attestations
        .filter((a) => a.serviceId === serviceId)
        .slice(-limit)
        .reverse(),
    );
  }

  listRecentActivity(): Promise<ActivityEvent[]> {
    return Promise.resolve([]);
  }

  getBalance(): Promise<Wei> {
    return Promise.resolve('0');
  }

  verifyTransfer(q: VerifyTransferQuery): Promise<VerifyResult> {
    const t = this.transfers.get(q.txHash);
    if (!t) return Promise.resolve({ ok: false, reason: 'not_found' });
    if (t.pendingReads > 0) {
      t.pendingReads -= 1;
      return Promise.resolve({ ok: false, reason: 'pending' });
    }
    // A payment made for a different service can't match this query — the
    // real PaymentRouter keys seenNonce by (serviceId, nonce), so a tx for
    // another service simply isn't the tx this receipt-lookup would find.
    if (t.serviceId !== q.serviceId) return Promise.resolve({ ok: false, reason: 'not_found' });
    if (t.to !== q.expectedTarget) return Promise.resolve({ ok: false, reason: 'wrong_target' });
    if (t.nonce !== q.expectedNonce) {
      return Promise.resolve({ ok: false, reason: 'wrong_nonce' });
    }
    if (compareWei(t.amountWei, q.minAmountWei) < 0) {
      return Promise.resolve({ ok: false, reason: 'amount_too_low' });
    }
    if (Date.now() - t.timestamp > q.maxAgeMs) return Promise.resolve({ ok: false, reason: 'expired' });
    return Promise.resolve({ ok: true, amountWei: t.amountWei, from: t.from, timestamp: t.timestamp });
  }

  registerService(input: RegisterServiceInput, signer: AnySigner): Promise<{ serviceId: number; txHash: string }> {
    const serviceId = this.services.size + 1;
    this.addService({
      id: serviceId,
      name: input.name,
      description: input.description,
      priceWei: input.priceWei,
      paymentTarget: input.paymentTarget,
      attestor: input.attestor,
      owner: signer.kind === 'mock' ? signer.publicKey : 'key',
    });
    return Promise.resolve({ serviceId, txHash: this.nextHash('register') });
  }

  recordAttestation(
    input: { serviceId: number; paymentTxHash: string; success: boolean },
    _signer: AnySigner,
  ): Promise<{ txHash: string }> {
    if (this.failAttestations > 0) {
      this.failAttestations -= 1;
      return Promise.reject(new Error('injected attestation failure'));
    }
    const txHash = this.nextHash('attest');
    this.attestations.push({ ...input, timestamp: Date.now(), recordTxHash: txHash });
    return Promise.resolve({ txHash });
  }

  setActive(serviceId: number, active: boolean, _signer: AnySigner): Promise<{ txHash: string }> {
    const service = this.services.get(serviceId);
    if (service) service.active = active;
    return Promise.resolve({ txHash: this.nextHash('active') });
  }

  transfer(
    input: { to: string; amountWei: Wei; nonce: string; serviceId: number },
    signer: AnySigner,
  ): Promise<{ txHash: string }> {
    const txHash = this.nextHash('transfer');
    this.transfers.set(txHash, {
      ...input,
      timestamp: Date.now(),
      from: signer.kind === 'mock' ? signer.publicKey : 'key',
      pendingReads: 0,
    });
    return Promise.resolve({ txHash });
  }
}
