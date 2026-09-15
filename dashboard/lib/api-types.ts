/**
 * Response shapes of the dashboard's own /api/* routes.
 * Shared between the route handlers (server) and the SWR consumers (client).
 */
import type {
  ActivityEvent,
  AttestationRecord,
  ServiceRecord,
  ServiceScore,
  TrustTier,
  Wei,
} from '@agentgate/shared';

export interface CatalogEntry {
  service: ServiceRecord;
  score: ServiceScore;
  trustTier: TrustTier;
}

export interface ServicesResponse {
  network: string;
  services: CatalogEntry[];
}

export interface ServiceDetailResponse {
  network: string;
  mode: 'mock' | 'live';
  service: ServiceRecord;
  score: ServiceScore;
  trustTier: TrustTier;
  attestations: AttestationRecord[];
  /** price × successCalls, computed server-side with bigint math. */
  revenueWei: Wei;
  /** getBalance(paymentTarget) — mock mode only, null in live or on failure. */
  balanceWei: Wei | null;
}

export interface ActivityResponse {
  network: string;
  events: ActivityEvent[];
  /** True when served from the server cache because a live refresh failed (e.g. an RPC outage). */
  stale?: boolean;
  /**
   * The block the feed's window starts at: the block the contracts were
   * deployed in, so an empty list means the deployment has never been used.
   */
  historyFromBlock: number;
  /**
   * The operator's ACTIVITY_LOOKBACK_BLOCKS cap, or null when there is none.
   * Under a cap an empty list only means "nothing in the last N blocks", NOT
   * "nothing ever happened" — the UI has to say which, or a service whose
   * history simply aged out reads as a service nobody ever used.
   */
  lookbackBlocks: number | null;
}

export interface StatsResponse {
  network: string;
  services: number;
  activeServices: number;
  totalCalls: number;
  successCalls: number;
  /** Σ price × successCalls across all services (bigint-safe wei string). */
  revenueWei: Wei;
}

export interface ApiErrorBody {
  error: string;
}

/**
 * Which chain this dashboard instance reads, resolved from ZG_NETWORK_PROFILE
 * (and any per-value overrides) at REQUEST time, never at build time — one
 * `next build` serves both the Galileo and the mainnet instance, so nothing
 * about the network may be baked in. Every label, explorer link and address
 * the UI shows comes from here; the alternative was a mainnet instance that
 * called itself "galileo testnet" and linked every tx to the wrong explorer.
 */
export interface NetworkInfo {
  /** Machine name, e.g. `0g-galileo`, `0g-mainnet`, `mock`. */
  network: string;
  /** Human label for badges and copy, e.g. `0G Galileo Testnet`. */
  label: string;
  chainId: number;
  /** Explorer origin without trailing slash; `''` for the mock devnet. */
  explorerUrl: string;
  registry: string;
  router: string;
  spendGuard: string;
  /** Block the contracts were deployed in — where every history read starts. */
  deployBlock: number;
}
