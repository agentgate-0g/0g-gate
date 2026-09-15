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
import { isAddress, normalizeAddress, sameAddress } from '@agentgate/chain';

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
  /** Bearer token for the mock/admin mapping path. Unused by the owner-signed
   *  path, which is what live mode uses — so it is required only there. */
  adminToken?: string;
  /** Runtime mode; in 'live' a non-localhost gateway must use https:// (token safety). */
  mode?: AgentGateMode;
  /**
   * Network name bound into the live self-map signature. Defaults to the
   * chain client's own network, which is what the gateway rebuilds the
   * challenge from — so omitting it is safe rather than silently unverifiable.
   */
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

  // The admin path needs a token and needs it BEFORE the on-chain write:
  // registerService costs gas and cannot be undone, so discovering a missing
  // token afterwards leaves a registered service with no mapping — the exact
  // half-failure `map` exists to recover from. The owner-signed path (a key
  // signer, which is what live mode uses) never sends one, so requiring it
  // there rejected correct calls.
  const usesAdminToken = opts.signer.kind !== 'key';
  const adminToken = usesAdminToken ? requireNonEmpty(opts.adminToken, 'adminToken') : '';

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
  // Who may write this service's attestations. The registry reverts
  // recordAttestation for anyone who is neither the attestor nor the owner, and
  // the party that observes a served call is the GATEWAY, not the seller. So
  // defaulting this to the seller's own address — as it used to — produced a
  // service that took payments and could never score, with nothing to say so.
  //
  // Ask the gateway who it signs as and register that. An explicit --attestor
  // still wins (a seller running their own gateway, or delegating), but a value
  // the gateway cannot use is worth warning about before the write, because
  // registration costs gas and cannot be undone.
  // Validate before the probe: a malformed --attestor must fail without a
  // network call, the same as every other bad input here.
  const explicitAttestor =
    opts.attestor !== undefined ? requireAddress(opts.attestor, 'attestor') : undefined;
  const probe = await probeGateway(gatewayBase, opts.fetchImpl ?? ((u, i) => fetch(u, i)));
  // The gateway serves ONE chain and says which on /healthz. Registering on
  // another is the one mistake here that cannot be walked back: the write
  // lands and costs gas, then the mapping 404s because that gateway's registry
  // has no such service. It became easy to make the day the default profile
  // moved to mainnet — `ZG_NETWORK_PROFILE=galileo` without `--gateway` still
  // maps on the mainnet gateway — so it is refused before the write. A gateway
  // that does not say (an older build, or unreachable) is not a mismatch.
  const chainNetwork = opts.network ?? opts.chain.network;
  if (probe.network !== '' && probe.network !== chainNetwork) {
    throw new AgentGateError(
      'GATEWAY_NETWORK_MISMATCH',
      `gateway ${gatewayBase} serves ${probe.network}, but this registration would be ` +
        `written to ${chainNetwork}. Nothing was registered. Pass --gateway for a gateway ` +
        `on ${chainNetwork}, or select the gateway's network with ZG_NETWORK_PROFILE.`,
      400,
    );
  }
  const gatewayAttestor = probe.attestor;
  let attestor: string;
  if (explicitAttestor !== undefined) {
    attestor = explicitAttestor;
    if (gatewayAttestor !== '' && !sameAddress(attestor, gatewayAttestor)) {
      console.error(
        `warning: --attestor ${attestor} is not this gateway's attestor ` +
          `(${gatewayAttestor}). The gateway serves the calls but will NOT be able to ` +
          `record attestations, so the score stays 0/0. Use --attestor ` +
          `${gatewayAttestor} unless you intend to attest yourself.`,
      );
    }
  } else if (gatewayAttestor !== '') {
    attestor = gatewayAttestor;
  } else {
    attestor = await signerAddress(opts.signer);
    if (opts.mode === 'live') {
      console.error(
        `warning: the gateway did not advertise an attestor, so the service is being ` +
          `registered with yours (${attestor}). If that gateway serves the calls it ` +
          `cannot record attestations, and the score will stay 0/0.`,
      );
    }
  }

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
        network: opts.network ?? opts.chain.network,
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
      const adminToken = requireNonEmpty(opts.adminToken, 'adminToken');
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

/** What a gateway's /healthz says about itself; '' for anything it does not say. */
export interface GatewayProbe {
  /** The address it records attestations as. */
  attestor: string;
  /** The chain it serves, e.g. `0g-mainnet` — what its 402s and self-map challenges carry. */
  network: string;
}

const NO_PROBE: GatewayProbe = { attestor: '', network: '' };

/**
 * Ask a gateway which address it signs attestations as, and which chain it
 * serves.
 *
 * Either field is '' when the gateway does not say — an older gateway, an
 * unreachable one, or mock mode. Deliberately non-fatal: this runs before an
 * on-chain registration that costs gas, and a health probe failing is not a
 * reason to refuse to register. The caller warns (attestor) or refuses
 * (network) only on a positive answer.
 */
export async function probeGateway(
  gatewayBase: string,
  fetchImpl: FetchLike,
  timeoutMs = 5_000,
): Promise<GatewayProbe> {
  try {
    const res = await fetchImpl(`${gatewayBase}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return NO_PROBE;
    const body = (await res.json()) as { attestor?: unknown; network?: unknown };
    // Normalised: isAddress() accepts surrounding whitespace and any casing,
    // but this value is compared against on-chain records and written into a
    // registration, both of which use the canonical lowercase form.
    const attestor =
      typeof body.attestor === 'string' && isAddress(body.attestor)
        ? normalizeAddress(body.attestor)
        : '';
    const network = typeof body.network === 'string' ? body.network.trim() : '';
    return { attestor, network };
  } catch {
    return NO_PROBE;
  }
}
