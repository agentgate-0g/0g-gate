import { createAgentGateClient, type PayAndFetchResult } from '@agentgate/client';
import {
  AgentGateError,
  compareWei,
  ogToWei,
  stripTrailingSlashes,
  type AnySigner,
  type ChainClient,
  type ServiceRecord,
  type Wei,
} from '@agentgate/shared';

export interface BuyServiceOpts {
  chain: ChainClient;
  signer: AnySigner;
  /** Service id (1-based, as shown by `agentgate list`). */
  id: number;
  /** Refuse invoices priced above this, in OG (e.g. "5"). */
  maxOg?: string;
  /** HTTP method for the paid request. Default GET. */
  method?: string;
  /** JSON request body — validated up front, sent on both legs. */
  body?: string;
  /** Gateway base URL override; default: the service's on-chain endpoint. */
  gateway?: string;
  /** Forwarded to createAgentGateClient. */
  settleDelayMs?: number;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

export interface BuyServiceResult {
  service: ServiceRecord;
  /** The exact URL the paid request was sent to. */
  url: string;
  result: PayAndFetchResult;
}

/**
 * Programmatic `agentgate buy`: resolve the service on-chain, fail fast on
 * anything that would waste a payment (unknown/paused service, price above the
 * cap, malformed body), then run the full 402 → pay → retry-with-proof exchange
 * via the client's fetchPaid, which pays through the PaymentRouter contract
 * named in the invoice (extra.router), carrying the invoice nonce.
 */
export async function buyService(opts: BuyServiceOpts): Promise<BuyServiceResult> {
  const { chain, signer, id } = opts;

  if (!Number.isInteger(id) || id < 1) {
    throw new AgentGateError(
      'INVALID_SERVICE_ID',
      `service id must be a positive integer, got ${String(id)}`,
      400,
    );
  }

  if (opts.body !== undefined) {
    try {
      JSON.parse(opts.body);
    } catch {
      throw new AgentGateError(
        'INVALID_INPUT',
        '--body must be valid JSON (the gateway rejects non-JSON request bodies before charging)',
        400,
      );
    }
  }

  const maxPriceWei: Wei | undefined =
    opts.maxOg !== undefined ? ogToWei(opts.maxOg) : undefined;

  const service = await chain.getService(id);
  if (service === null) {
    throw new AgentGateError('SERVICE_NOT_FOUND', `service ${id} not found`, 404);
  }
  if (!service.active) {
    throw new AgentGateError(
      'SERVICE_INACTIVE',
      `service ${id} (${service.name}) is paused by its owner — not paying`,
      403,
    );
  }
  // Fail fast before any HTTP when the on-chain price already exceeds the cap.
  if (maxPriceWei !== undefined && compareWei(service.priceWei, maxPriceWei) > 0) {
    throw new AgentGateError(
      'PRICE_EXCEEDED',
      `service price ${service.priceWei} wei exceeds --max ${maxPriceWei} wei`,
      402,
    );
  }

  const url =
    opts.gateway !== undefined
      ? `${stripTrailingSlashes(opts.gateway)}/svc/${id}`
      : service.endpointUrl;

  const client = createAgentGateClient({
    chain,
    signer,
    ...(maxPriceWei !== undefined ? { maxPriceWei } : {}),
    ...(opts.settleDelayMs !== undefined ? { settleDelayMs: opts.settleDelayMs } : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
  });

  const init: RequestInit | undefined =
    opts.method !== undefined || opts.body !== undefined
      ? {
          method: (opts.method ?? 'GET').toUpperCase(),
          ...(opts.body !== undefined
            ? { body: opts.body, headers: { 'content-type': 'application/json' } }
            : {}),
        }
      : undefined;

  const result = await client.fetchPaid(url, init);
  return { service, url, result };
}
