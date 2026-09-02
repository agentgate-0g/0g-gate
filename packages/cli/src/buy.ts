import { createAgentGateClient, type PayAndFetchResult } from '@agentgate/client';
import {
  AgentGateError,
  compareWei,
  formatOg,
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
  /**
   * Environment the operator spend ceiling is read from. Defaults to
   * `process.env`; injectable for tests only — no command or tool surface
   * forwards a caller-supplied env here, which is the whole point of the
   * ceiling (see {@link operatorSpendLimit}).
   */
  env?: Record<string, string | undefined>;
}

export interface BuyServiceResult {
  service: ServiceRecord;
  /** The exact URL the paid request was sent to. */
  url: string;
  result: PayAndFetchResult;
}

/**
 * Per-call ceiling used when the operator configured none. Deliberately small:
 * on mainnet an unset ceiling would otherwise mean "whatever the seller listed".
 */
const DEFAULT_MAX_SPEND_OG = '5';

/**
 * The operator's per-call spend ceiling, read from the ENVIRONMENT and never
 * from a caller argument.
 *
 * `maxOg` is optional, and on the MCP surface it is chosen by the model driving
 * `agentgate_buy` — a hijacked or prompt-injected agent simply omits it, which
 * leaves `service.priceWei` as the only cap: a number the SELLER set, since
 * registration is permissionless with a price floor and no ceiling. This is the
 * one limit neither the model nor the seller can raise. `AGENTGATE_MAX_SPEND_OG`
 * is the explicit knob; `BUYER_BUDGET_OG` (already validated by loadConfig, and
 * already the buyer-agent's budget) is honoured so an operator who set it does
 * not have to learn a second name.
 */
function operatorSpendLimit(env: Record<string, string | undefined>): {
  wei: Wei;
  og: string;
  source: string;
} {
  const explicit = env.AGENTGATE_MAX_SPEND_OG?.trim();
  const budget = env.BUYER_BUDGET_OG?.trim();
  const [og, source] =
    explicit !== undefined && explicit !== ''
      ? [explicit, 'AGENTGATE_MAX_SPEND_OG']
      : budget !== undefined && budget !== ''
        ? [budget, 'BUYER_BUDGET_OG']
        : [DEFAULT_MAX_SPEND_OG, 'the built-in default'];
  try {
    return { wei: ogToWei(og), og, source };
  } catch {
    // Fail closed. An unparseable ceiling that fell back to the default (or to
    // "no ceiling") would hand a typo'd env var straight to an autonomous agent.
    throw new AgentGateError(
      'INVALID_CONFIG',
      `${source} must be a non-negative OG decimal string (max 18 dp), got ${JSON.stringify(og)}`,
      400,
    );
  }
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

  // Resolved before the service lookup so a broken ceiling stops the call
  // rather than being discovered only on the services that happen to be cheap.
  const spendLimit = operatorSpendLimit(opts.env ?? process.env);

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
  // The operator's ceiling, checked before any HTTP and before anything is
  // signed, and checked independently of `maxOg` — so a caller (the model, on
  // the MCP surface) can only LOWER the effective cap with its own --max, never
  // raise it, and omitting --max entirely does not remove the ceiling.
  if (compareWei(service.priceWei, spendLimit.wei) > 0) {
    throw new AgentGateError(
      'SPEND_LIMIT_EXCEEDED',
      `service price ${formatOg(service.priceWei)} exceeds the operator spend ceiling ` +
        `${spendLimit.og} OG (${spendLimit.source}) — raise it in the environment, not per call`,
      402,
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

  // The cap is the price the CHAIN lists, never the optional --max. --max is a
  // budget ceiling the caller may omit; on its own it guards nothing, and even
  // when supplied it permits any overcharge up to itself. The registry price is
  // the only number the seller cannot restate at invoice time.
  const client = createAgentGateClient({
    chain,
    signer,
    maxPriceWei: service.priceWei,
    expectPayTo: service.paymentTarget,
    expectServiceId: id,
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
