import type { AgentGateMode, AnySigner } from '@agentgate/shared';
import { AgentGateError, buildSelfMapMessage } from '@agentgate/shared';
import { signMessage } from './identity';
import type { FetchLike } from './types';
import { normalizeBaseUrl, requireHttpUrl, requireNonEmpty } from './validate';

/** Fallback fetch timeout when no timeoutMs is supplied (ms). */
export const DEFAULT_MAP_FETCH_TIMEOUT_MS = 15_000;

export interface MapServiceOpts {
  /** Service id that is ALREADY registered on-chain. */
  serviceId: number;
  /** Upstream API URL to map. Kept private — only ever sent to the gateway. */
  upstreamUrl: string;
  /** Gateway base URL. */
  gateway: string;
  signer: AnySigner;
  /** Bearer token for the mock/admin path. Unused by the owner-signed path. */
  adminToken?: string;
  /** Runtime mode; in 'live' a non-localhost gateway must use https:// (token safety). */
  mode?: AgentGateMode;
  /** Network name bound into the self-map signature. */
  network?: string;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export interface MapServiceResult {
  serviceId: number;
  publicUrl: string;
  /** Which auth path was used: an owner signature, or the shared admin token. */
  via: 'owner-signature' | 'admin-token';
}

/**
 * Point a gateway at the upstream for a service that is already registered.
 *
 * This is `wrap`'s second step on its own. It exists because the two steps have
 * very different failure semantics: registration is an on-chain write that
 * CANNOT be undone or repeated safely, while the mapping is a plain idempotent
 * POST. When the pair fails partway — the registration lands, the mapping does
 * not — re-running `wrap` is exactly the wrong move: it mints a second service
 * on-chain. Before this command there was no right move, only that wrong one.
 *
 * Also the way to correct a mapping that points somewhere stale: the gateway
 * stores it in a file that outlives any single run, so a mapping left behind by
 * an earlier experiment keeps being served until it is overwritten.
 */
export async function mapService(opts: MapServiceOpts): Promise<MapServiceResult> {
  if (!Number.isSafeInteger(opts.serviceId) || opts.serviceId < 1) {
    throw new AgentGateError(
      'INVALID_SERVICE_ID',
      `service id must be a positive integer, got ${String(opts.serviceId)}`,
      400,
    );
  }
  requireHttpUrl(opts.upstreamUrl, 'upstreamUrl');
  const upstreamUrl = opts.upstreamUrl.trim();
  const gatewayBase = normalizeBaseUrl(opts.gateway, 'gateway', {
    mode: opts.mode,
    requireHttpsInLiveMode: true,
  });
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_MAP_FETCH_TIMEOUT_MS;

  // Same rule as wrap: a key signer proves ownership by signature, a mock
  // signer falls back to the shared admin token.
  const useSelfMap = opts.signer.kind === 'key';
  const url = useSelfMap
    ? `${gatewayBase}/services/${opts.serviceId}/map`
    : `${gatewayBase}/admin/services`;

  let init: Parameters<FetchLike>[1];
  if (useSelfMap) {
    const timestamp = Date.now();
    const message = buildSelfMapMessage({
      network: opts.network ?? '',
      serviceId: opts.serviceId,
      upstreamUrl,
      timestamp,
    });
    const { signatureHex } = await signMessage(opts.signer, message);
    init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ upstreamUrl, timestamp, signatureHex }),
      signal: AbortSignal.timeout(timeoutMs),
    };
  } else {
    const adminToken = requireNonEmpty(opts.adminToken, 'adminToken');
    init = {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ serviceId: opts.serviceId, upstreamUrl }),
      signal: AbortSignal.timeout(timeoutMs),
    };
  }

  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    const why =
      name === 'TimeoutError' || name === 'AbortError'
        ? `request timed out after ${timeoutMs}ms`
        : `request failed — ${err instanceof Error ? err.message : String(err)}`;
    throw new AgentGateError('MAP_FAILED', `gateway ${url} unreachable: ${why}`, 502);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    throw new AgentGateError(
      'MAP_FAILED',
      `gateway answered HTTP ${res.status}${body ? ` — ${body}` : ''}`,
      res.status === 401 || res.status === 403 ? 403 : 502,
    );
  }

  return {
    serviceId: opts.serviceId,
    publicUrl: `${gatewayBase}/svc/${opts.serviceId}`,
    via: useSelfMap ? 'owner-signature' : 'admin-token',
  };
}
