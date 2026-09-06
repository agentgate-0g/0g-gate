/**
 * Server-only chain access for the dashboard API routes.
 *
 * The dashboard NEVER talks to the devnet / 0G RPC directly from the browser —
 * every read goes through /api/* routes which wrap createChainClient(loadConfig()).
 *
 * IMPORTANT: nothing here runs at module load. `getChain()` is called inside
 * request handlers only, so importing a route file can never hit the chain
 * (next build stays side-effect free even while @agentgate/chain is stubbed).
 */
import {
  createLogger,
  isAgentGateError,
  loadConfig,
  type AgentGateConfig,
  type ChainClient,
} from '@agentgate/shared';
import { createChainClient } from '@agentgate/chain';

const log = createLogger('dashboard.api');

export interface ChainHandle {
  config: AgentGateConfig;
  chain: ChainClient;
}

let cached: ChainHandle | null = null;

/**
 * Lazily build (and memoize) the ChainClient. Failures are NOT cached so a
 * transient config/chain error never wedges the process.
 */
export function getChain(): ChainHandle {
  if (cached) return cached;
  // `requireStrongAdminToken: false` — the dashboard is READ-ONLY. Every route
  // here is a GET, there is no /admin surface, and nothing in this app ever
  // reads config.adminToken. The guard exists so a live GATEWAY cannot run its
  // admin endpoint on the shipped default; applying it here only means a
  // read-only UI refuses to start (CONFIG_INVALID) over a credential it will
  // never use.
  const config = loadConfig(process.env, { requireStrongAdminToken: false });
  const chain = createChainClient(config);
  cached = { config, chain };
  return cached;
}

export interface ApiFailure {
  status: number;
  body: { error: string };
}

/**
 * Maps any error thrown while talking to the chain layer to a stable JSON
 * error shape. A devnet that is down, an RPC outage and a dead socket are all
 * the same thing to a reader, and all surface as 503
 * {error:"chain_unreachable"} so the UI can show one clear banner.
 *
 * An AgentGateError is NOT one of those. It already carries the code and status
 * the layer that raised it chose, and flattening those into "chain unreachable"
 * is how a registry whose ABI no longer matches the deployment — a healthy node
 * answering perfectly well — reached the operator as "the chain is down", under
 * a banner offering to restart it.
 */
export function toApiFailure(err: unknown, route: string): ApiFailure {
  const message = err instanceof Error ? err.message : String(err);
  if (isAgentGateError(err)) {
    log.error(err.code, { route, message });
    return { status: err.httpStatus, body: { error: err.code.toLowerCase() } };
  }
  log.warn('chain unreachable', { route, message });
  return { status: 503, body: { error: 'chain_unreachable' } };
}

/** Strict numeric id parser for /api/services/[id] (and the page shell). */
export function parseServiceId(raw: string): number | null {
  if (!/^\d{1,15}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

/** Clamp an optional ?limit= query param to a sane window. */
export function parseLimit(raw: string | null, fallback: number, max: number): number {
  if (raw === null || raw === '') return fallback;
  if (!/^\d{1,4}$/.test(raw)) return fallback;
  const n = Number(raw);
  if (n < 1) return fallback;
  return Math.min(n, max);
}
