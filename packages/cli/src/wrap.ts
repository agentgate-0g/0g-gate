import type {
  AgentGateMode,
  AnySigner,
  ChainClient,
  RegisterServiceInput,
  Wei,
} from '@agentgate/shared';
import { AgentGateError, buildSelfMapMessage, ogToWei, parseWei } from '@agentgate/shared';
import { signerAddress, signMessage } from './identity';
import type { FetchLike } from './types';
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  normalizeBaseUrl,
  optionalSafeText,
  requireAddress,
  requireHttpUrl,
  requireNonEmpty,
  requireSafeText,
} from './validate';

/** Where the dashboard detail link points when not overridden. */
export const DEFAULT_DASHBOARD_BASE_URL = 'http://localhost:3000';

/** Fallback fetch timeout when no upstreamTimeoutMs is supplied (ms). */
export const DEFAULT_WRAP_FETCH_TIMEOUT_MS = 15_000;

export interface WrapServiceOpts {
  /** Upstream API URL to wrap. Kept private — only ever sent to the gateway admin API. */
  upstreamUrl: string;
  /** Price per call in OG (decimal string, max 18 dp, must be > 0). */
  priceOg: string;
  name: string;
  description?: string;
  /** Gateway base URL; the canonical public endpoint becomes `<gateway>/svc/<id>`. */
  gateway: string;
  /** "0x<40hex>" EVM address; defaults to the one derived from the signer. */
  paymentTarget?: string;
  /** "0x<40hex>" address allowed to record attestations; defaults to the signer's address. */
  attestor?: string;
  /** Base URL for the printed dashboard link (default http://localhost:3000). */
  dashboardBaseUrl?: string;
  chain: ChainClient;
  signer: AnySigner;
  /** Bearer token for `POST <gateway>/admin/services`. */
  adminToken: string;
  /** Runtime mode; in 'live' a non-localhost gateway must use https:// (token safety). */
  mode?: AgentGateMode;
  /** 0G network name (live self-map signature). Defaults to '' (mock ignores it). */
  network?: string;
  /** Timeout (ms) for the admin-mapping POST. Defaults to DEFAULT_WRAP_FETCH_TIMEOUT_MS. */
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export interface WrapServiceResult {
  serviceId: number;
  /** Hash of the on-chain `register_service` tx. */
  txHash: string;
  /** Canonical public endpoint: `<gateway>/svc/<serviceId>`. */
  publicUrl: string;
  /** Dashboard detail page, e.g. http://localhost:3000/services/<id>. */
  dashboardUrl: string;
  /** false when the gateway admin mapping failed (registration is still live on-chain). */
  adminOk: boolean;
  /** Present when adminOk is false: what failed + the exact curl to retry. */
  adminWarning?: string;
}

/** Single-quote a string for POSIX shells (embedded quotes become '\''). */
function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The exact curl to (re)create the gateway upstream mapping. References
 * $AGENTGATE_ADMIN_TOKEN instead of inlining the token so no secret is printed.
 */
export function adminRetryCurl(adminUrl: string, serviceId: number, upstreamUrl: string): string {
  return [
    `curl -X POST ${shellSingleQuote(adminUrl)}`,
    `-H "Authorization: Bearer $AGENTGATE_ADMIN_TOKEN"`,
    `-H 'Content-Type: application/json'`,
    `-d ${shellSingleQuote(JSON.stringify({ serviceId, upstreamUrl }))}`,
  ].join(' ');
}

/**
 * Programmatic `agentgate wrap` (used by scripts/demo.ts and the bin):
 *
 * 1. Registers the service on-chain FIRST. Per SPEC §9 (final decision) the
 *    `endpointUrl` sent to the registry is the **gateway base URL**; the registry
 *    stores it and every reader computes `endpointUrl = <gateway>/svc/<id>`.
 * 2. POSTs `{serviceId, upstreamUrl}` to `<gateway>/admin/services` with the admin
 *    Bearer token. If this step fails the on-chain registration is NOT rolled back:
 *    a precise warning (with the exact retry curl) is printed to stderr and
 *    returned as `adminWarning`.
 */
export async function wrapService(opts: WrapServiceOpts): Promise<WrapServiceResult> {
  // -- validation (fail fast, before any side effect) ------------------------
  const name = requireSafeText(opts.name, 'name', MAX_NAME_LENGTH);
  const description = optionalSafeText(opts.description, 'description', MAX_DESCRIPTION_LENGTH);
  requireHttpUrl(opts.upstreamUrl, 'upstreamUrl');
  const upstreamUrl = opts.upstreamUrl.trim();
  // The admin Bearer token is POSTed to the gateway, so reject cleartext http
  // to a non-localhost gateway in live mode.
  const gatewayBase = normalizeBaseUrl(opts.gateway, 'gateway', {
    mode: opts.mode,
    requireHttpsInLiveMode: true,
  });
  const dashboardBase = normalizeBaseUrl(
    opts.dashboardBaseUrl ?? DEFAULT_DASHBOARD_BASE_URL,
    'dashboardBaseUrl',
  );
  const adminToken = requireNonEmpty(opts.adminToken, 'adminToken');

  const priceWei: Wei = ogToWei(opts.priceOg);
  if (parseWei(priceWei) <= 0n) {
    throw new AgentGateError(
      'INVALID_PRICE',
      `price must be > 0 OG, got ${JSON.stringify(opts.priceOg)}`,
      400,
    );
  }

  const paymentTarget =
    opts.paymentTarget !== undefined
      ? requireAddress(opts.paymentTarget, 'paymentTarget')
      : await signerAddress(opts.signer);
  const attestor =
    opts.attestor !== undefined
      ? requireAddress(opts.attestor, 'attestor')
      : await signerAddress(opts.signer);

  // -- step 1: on-chain registration -----------------------------------------
  const input: RegisterServiceInput = {
    name,
    description,
    endpointUrl: gatewayBase, // gateway base; readers compute <base>/svc/<id> (SPEC §9)
    priceWei,
    paymentTarget,
    attestor,
  };
  const { serviceId, txHash } = await opts.chain.registerService(input, opts.signer);

  const publicUrl = `${gatewayBase}/svc/${serviceId}`;
  const dashboardUrl = `${dashboardBase}/services/${serviceId}`;
  const adminUrl = `${gatewayBase}/admin/services`;

  // -- step 2: gateway upstream mapping ---------------------------------------
  // key signer → owner-signature self-map (no admin token): sign a canonical
  //   challenge with the seller key and POST it to <gateway>/services/<id>/map.
  // mock signer → shared admin token POST to <gateway>/admin/services.
  // (In production key ⟺ live and mock ⟺ mock; keying off the signer keeps a
  //  mock signer out of the self-map path even when mode is forced to 'live'.)
  const useSelfMap = opts.signer.kind === 'key';
  const mapUrl = useSelfMap ? `${gatewayBase}/services/${serviceId}/map` : adminUrl;
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WRAP_FETCH_TIMEOUT_MS;
  let adminFailure: string | undefined;
  try {
    let init: Parameters<FetchLike>[1];
    if (useSelfMap) {
      const timestamp = Date.now();
      const message = buildSelfMapMessage({
        network: opts.network ?? '',
        serviceId,
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
      init = {
        method: 'POST',
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ serviceId, upstreamUrl }),
        signal: AbortSignal.timeout(timeoutMs),
      };
    }
    const res = await fetchImpl(mapUrl, init);
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      adminFailure = `gateway answered HTTP ${res.status}${body ? ` — ${body}` : ''}`;
    }
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    adminFailure =
      name === 'TimeoutError' || name === 'AbortError'
        ? `request timed out after ${timeoutMs}ms`
        : `request failed — ${err instanceof Error ? err.message : String(err)}`;
  }

  if (adminFailure === undefined) {
    return { serviceId, txHash, publicUrl, dashboardUrl, adminOk: true };
  }

  const retryHint = useSelfMap
    ? 'The service is already registered — re-run the mapping once the gateway is reachable (do NOT re-run `wrap`, that registers a duplicate).'
    : `Retry the mapping with (expects AGENTGATE_ADMIN_TOKEN in your environment):\n  ${adminRetryCurl(adminUrl, serviceId, upstreamUrl)}`;
  const adminWarning = [
    `gateway upstream mapping for service ${serviceId} failed: ${adminFailure}.`,
    `The on-chain registration (tx ${txHash}) was NOT rolled back — ${publicUrl} will 404 until the mapping exists.`,
    retryHint,
  ].join('\n');
  console.error(`warning: ${adminWarning}`);
  return { serviceId, txHash, publicUrl, dashboardUrl, adminOk: false, adminWarning };
}
