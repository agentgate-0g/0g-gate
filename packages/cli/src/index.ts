export type { FetchLike } from './types';
export {
  wrapService,
  adminRetryCurl,
  DEFAULT_DASHBOARD_BASE_URL,
  DEFAULT_WRAP_FETCH_TIMEOUT_MS,
  type WrapServiceOpts,
  type WrapServiceResult,
} from './wrap';
export {
  mapService,
  DEFAULT_MAP_FETCH_TIMEOUT_MS,
  type MapServiceOpts,
  type MapServiceResult,
} from './map';
export { listServices, type ServiceListing } from './list';
export { buyService, type BuyServiceOpts, type BuyServiceResult } from './buy';
export {
  setServiceActive,
  type SetServiceActiveOpts,
  type SetServiceActiveResult,
} from './pause';
export {
  serviceStatus,
  STATUS_ATTESTATION_LIMIT,
  type ServiceStatusResult,
} from './status';
export {
  createDemoAccounts,
  generateMockPublicKey,
  DEMO_FAUCET_OG,
  DEFAULT_FAUCET_TIMEOUT_MS,
  type CreateDemoAccountsOpts,
  type DemoAccount,
  type DemoAccountsResult,
} from './demo-accounts';
export { signerAddress, signMessage } from './identity';

// ── The chain client, and the types the functions above are typed in ────────
//
// Every function in this package takes an injected `chain: ChainClient`, and
// until 1.0.3 the factory that builds one was bundled but never exported — so
// the whole library surface compiled, imported, and then could not be called.
// A clean install could run the CLI and nothing else. Verifying the published
// tarball rather than the repo is what surfaced it: in the repo the workspace
// resolves @agentgate/chain, and the gap is invisible.
//
// The types go with it for the same reason. A consumer that cannot name
// `ChainClient` or `ServiceRecord` cannot annotate a variable, a parameter or a
// return value, so the types were shipped and unusable in the same way.
export { createChainClient, normalizeAddress, isAddress, sameAddress, shortAddress } from '@agentgate/chain';
export {
  loadConfig,
  AgentGateError,
  isAgentGateError,
  formatOg,
  ogToWei,
  weiToOg,
  parseWei,
  compareWei,
  WEI_PER_OG,
  trustTier,
  DEFAULT_GATEWAY_URL,
  DEFAULT_REGISTRY_ADDRESS,
  DEFAULT_PAYMENT_ROUTER_ADDRESS,
  DEFAULT_SPEND_GUARD_ADDRESS,
  DEFAULT_ZG_RPC_URL,
  DEFAULT_ZG_NETWORK,
  DEFAULT_ZG_CHAIN_ID,
  DEFAULT_ZG_EXPLORER_URL,
} from '@agentgate/shared';
export type {
  AgentGateConfig,
  AgentGateMode,
  AnySigner,
  SignerRef,
  KeySignerRef,
  ChainClient,
  ServiceRecord,
  ServiceScore,
  AttestationRecord,
  ActivityEvent,
  PaymentOption,
  RegisterServiceInput,
  VerifyTransferQuery,
  VerifyResult,
  TrustTier,
  Wei,
} from '@agentgate/shared';
