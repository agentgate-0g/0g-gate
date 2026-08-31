import { createHash } from 'node:crypto';
import { AgentGateError, stripTrailingSlashes } from '@agentgate/shared';
import type {
  ActivityEvent,
  AnySigner,
  AttestationRecord,
  ChainClient,
  RegisterServiceInput,
  ServiceRecord,
  ServiceScore,
  SignerRef,
  VerifyResult,
  VerifyTransferQuery,
  Wei,
} from '@agentgate/shared';

const WEI_RE = /^(0|[1-9]\d*)$/;
const U64_MAX = 18_446_744_073_709_551_615n;

/**
 * Mock address derivation used by the devnet: `0x` + the first 20 bytes of
 * sha256(publicKey). Not a real EVM key derivation — mock signers carry no key
 * material — but it yields the same `0x<40hex>` SHAPE as live mode, so every
 * address code path is exercised identically in both modes.
 *
 * MUST stay byte-identical to `deriveAccountAddress` in
 * `packages/devnet/src/state.ts`; the devnet derives the same identities
 * independently and any drift silently breaks mock mode.
 */
export function mockAccountAddress(publicKey: string): string {
  if (typeof publicKey !== 'string' || publicKey.trim() === '') {
    throw new AgentGateError('invalid_public_key', 'publicKey must be a non-empty string', 400);
  }
  return `0x${createHash('sha256').update(publicKey).digest('hex').slice(0, 40)}`;
}

/** Shape of the devnet's GET /chain/transfers/:txHash response. */
interface DevnetTransfer {
  txHash: string;
  fromPublicKey: string;
  from: string;
  to: string;
  amountWei: Wei;
  nonce: string;
  serviceId: number;
  timestamp: number;
}

/** Devnet is local/in-process, but never let a hung socket block a request forever. */
const DEVNET_REQUEST_TIMEOUT_MS = 30_000;

function invalid(message: string): AgentGateError {
  return new AgentGateError('invalid_query', message, 400);
}

function requireMockSigner(signer: AnySigner): SignerRef {
  if (signer.kind !== 'mock') {
    throw new AgentGateError(
      'invalid_signer',
      `MockChainHttpClient requires a mock signer, got "${signer.kind}"`,
      400,
    );
  }
  if (signer.publicKey.trim() === '') {
    throw new AgentGateError('invalid_signer', 'mock signer publicKey must not be empty', 400);
  }
  return signer;
}

function assertServiceId(id: number): void {
  if (!Number.isSafeInteger(id) || id < 1) {
    throw invalid(`serviceId must be a positive integer, got ${String(id)}`);
  }
}

/**
 * ChainClient backed by the local devnet's REST API (SPEC §4).
 * Maps every read/write 1:1 onto the SPEC §3 routes.
 */
export class MockChainHttpClient implements ChainClient {
  readonly network = 'mock';
  private readonly baseUrl: string;

  constructor(devnetUrl: string) {
    let parsed: URL;
    try {
      parsed = new URL(devnetUrl);
    } catch {
      throw new AgentGateError('invalid_devnet_url', `invalid DEVNET_URL: ${devnetUrl}`, 500);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new AgentGateError('invalid_devnet_url', 'DEVNET_URL must be http(s)', 500);
    }
    this.baseUrl = stripTrailingSlashes(devnetUrl);
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    allow404 = false,
  ): Promise<T | null> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(DEVNET_REQUEST_TIMEOUT_MS),
        // Chain state is live: never let a fetch layer (e.g. Next.js App Router,
        // which patches global fetch and caches by default) serve a stale read.
        // `cache` is a valid web fetch option Node accepts but omits from its types.
        cache: 'no-store',
      } as RequestInit);
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new AgentGateError(
        timedOut ? 'devnet_timeout' : 'devnet_unreachable',
        `devnet request ${timedOut ? 'timed out' : 'failed'} (${method} ${url}): ${error instanceof Error ? error.message : String(error)}`,
        timedOut ? 504 : 502,
      );
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text === '' ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (res.status === 404 && allow404) return null;
    if (!res.ok) {
      const errBody = (parsed ?? {}) as { error?: unknown; message?: unknown };
      throw new AgentGateError(
        typeof errBody.error === 'string' ? errBody.error : 'devnet_error',
        typeof errBody.message === 'string'
          ? errBody.message
          : `devnet responded ${res.status} on ${method} ${path}`,
        res.status,
      );
    }
    return parsed as T;
  }

  private async get<T>(path: string): Promise<T> {
    return (await this.request<T>('GET', path)) as T;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return (await this.request<T>('POST', path, body)) as T;
  }

  /** Readiness probe: a bounded GET to the devnet health endpoint. */
  async ping(): Promise<void> {
    await this.get('/healthz');
  }

  // ---- reads ----------------------------------------------------------------

  async getService(id: number): Promise<ServiceRecord | null> {
    assertServiceId(id);
    return await this.request<ServiceRecord>('GET', `/chain/services/${id}`, undefined, true);
  }

  async listServices(): Promise<ServiceRecord[]> {
    return await this.get<ServiceRecord[]>('/chain/services');
  }

  async getScore(id: number): Promise<ServiceScore> {
    assertServiceId(id);
    return await this.get<ServiceScore>(`/chain/services/${id}/score`);
  }

  async listAttestations(serviceId: number, limit?: number): Promise<AttestationRecord[]> {
    assertServiceId(serviceId);
    const qs = limit === undefined ? '' : `?limit=${encodeURIComponent(String(limit))}`;
    return await this.get<AttestationRecord[]>(`/chain/services/${serviceId}/attestations${qs}`);
  }

  async listRecentActivity(limit?: number): Promise<ActivityEvent[]> {
    const qs = limit === undefined ? '' : `?limit=${encodeURIComponent(String(limit))}`;
    return await this.get<ActivityEvent[]>(`/chain/activity${qs}`);
  }

  async getBalance(account: string): Promise<Wei> {
    if (typeof account !== 'string' || account.trim() === '') {
      throw invalid('account must be a non-empty string');
    }
    const result = await this.get<{ account: string; balanceWei: Wei }>(
      `/chain/balance/${encodeURIComponent(account)}`,
    );
    return result.balanceWei;
  }

  /**
   * Looks up the transfer by txHash, then checks target → (serviceId, nonce) →
   * amount → age — the same order, and the same (serviceId, nonce) PAIR match,
   * the live client applies to `PaymentRouter.Paid` logs. Matching on the pair
   * matters here too: a nonce is unique only per service, and payment targets
   * are shared across services.
   *
   * `pending` never occurs in mock mode: devnet transfers settle synchronously.
   */
  async verifyTransfer(q: VerifyTransferQuery): Promise<VerifyResult> {
    if (typeof q.txHash !== 'string' || q.txHash.trim() === '') {
      throw invalid('txHash must be a non-empty string');
    }
    assertServiceId(q.serviceId);
    if (typeof q.expectedTarget !== 'string' || q.expectedTarget.trim() === '') {
      throw invalid('expectedTarget must be a non-empty string');
    }
    if (typeof q.minAmountWei !== 'string' || !WEI_RE.test(q.minAmountWei)) {
      throw invalid('minAmountWei must be a wei decimal string');
    }
    if (typeof q.expectedNonce !== 'string' || !WEI_RE.test(q.expectedNonce)) {
      throw invalid('expectedNonce must be a uint256 decimal string');
    }
    if (typeof q.maxAgeMs !== 'number' || !Number.isFinite(q.maxAgeMs) || q.maxAgeMs < 0) {
      throw invalid('maxAgeMs must be a non-negative number');
    }

    const transfer = await this.request<DevnetTransfer>(
      'GET',
      `/chain/transfers/${encodeURIComponent(q.txHash)}`,
      undefined,
      true,
    );
    if (transfer === null) return { ok: false, reason: 'not_found' };
    if (transfer.to.toLowerCase() !== q.expectedTarget.toLowerCase()) {
      return { ok: false, reason: 'wrong_target' };
    }
    if (
      BigInt(transfer.nonce) !== BigInt(q.expectedNonce) ||
      transfer.serviceId !== q.serviceId
    ) {
      return { ok: false, reason: 'wrong_nonce' };
    }
    if (BigInt(transfer.amountWei) < BigInt(q.minAmountWei)) {
      return { ok: false, reason: 'amount_too_low' };
    }
    if (Date.now() - transfer.timestamp > q.maxAgeMs) {
      return { ok: false, reason: 'expired' };
    }
    return {
      ok: true,
      amountWei: transfer.amountWei,
      from: transfer.from,
      timestamp: transfer.timestamp,
    };
  }

  // ---- writes ---------------------------------------------------------------

  async registerService(
    input: RegisterServiceInput,
    signer: AnySigner,
  ): Promise<{ serviceId: number; txHash: string }> {
    const mockSigner = requireMockSigner(signer);
    return await this.post<{ serviceId: number; txHash: string }>('/chain/register-service', {
      ...input,
      ownerPublicKey: mockSigner.publicKey,
    });
  }

  /**
   * Record an attestation, treating an already-recorded payment as success.
   *
   * The durable attestation queue (`packages/middleware/src/attestation-queue.ts`)
   * drops an entry only once its attempt RESOLVES, and replays anything still
   * queued on every boot. `Live0gClient.recordAttestation` therefore reports a
   * `DuplicateAttestation` revert as success — the desired end state already
   * holds. Mock mode has to do the same, or a replayed entry throws forever and
   * is re-replayed on every restart.
   *
   * Narrow on purpose: ONLY `duplicate_attestation` is exempted. `not_authorized`,
   * `service_inactive`, `service_not_found` and every transport failure still
   * reject, so a genuinely un-recorded attestation stays queued for retry.
   */
  async recordAttestation(
    input: { serviceId: number; paymentTxHash: string; success: boolean },
    signer: AnySigner,
  ): Promise<{ txHash: string }> {
    const mockSigner = requireMockSigner(signer);
    assertServiceId(input.serviceId);
    try {
      return await this.post<{ txHash: string }>('/chain/attestations', {
        serviceId: input.serviceId,
        paymentTxHash: input.paymentTxHash,
        success: input.success,
        byPublicKey: mockSigner.publicKey,
      });
    } catch (error) {
      // Empty hash = "nothing was submitted, the attestation was already there",
      // exactly what the live client returns on the same condition.
      if (error instanceof AgentGateError && error.code === 'duplicate_attestation') {
        return { txHash: '' };
      }
      throw error;
    }
  }

  async setActive(
    serviceId: number,
    active: boolean,
    signer: AnySigner,
  ): Promise<{ txHash: string }> {
    const mockSigner = requireMockSigner(signer);
    assertServiceId(serviceId);
    return await this.post<{ txHash: string }>(`/chain/services/${serviceId}/active`, {
      active,
      byPublicKey: mockSigner.publicKey,
    });
  }

  async transfer(
    input: { to: string; amountWei: Wei; nonce: string; serviceId: number },
    signer: AnySigner,
  ): Promise<{ txHash: string }> {
    const mockSigner = requireMockSigner(signer);
    assertServiceId(input.serviceId);
    if (typeof input.to !== 'string' || input.to.trim() === '') {
      throw invalid('"to" must be a non-empty account string');
    }
    if (typeof input.amountWei !== 'string' || !WEI_RE.test(input.amountWei)) {
      throw invalid('amountWei must be a wei decimal string');
    }
    if (
      typeof input.nonce !== 'string' ||
      !WEI_RE.test(input.nonce) ||
      BigInt(input.nonce) > U64_MAX
    ) {
      throw invalid('nonce must be a u64 decimal string');
    }
    const result = await this.post<{ txHash: string; timestamp: number }>('/chain/transfers', {
      fromPublicKey: mockSigner.publicKey,
      to: input.to,
      amountWei: input.amountWei,
      nonce: input.nonce,
      serviceId: input.serviceId,
    });
    return { txHash: result.txHash };
  }
}
