import { DEFAULT_REGISTRY_ADDRESS, DEFAULT_ZG_EXPLORER_URL, DEFAULT_ZG_NETWORK } from '@agentgate/shared';

/**
 * Versions the docs describe. The registry address is sourced from the shared
 * package so it can never drift from what the gateway/CLI actually use; bump
 * `cli`/`sdk` when those packages publish a new version.
 */
export const DOCS_VERSION = {
  cli: '1.0.0', // agentgate-0g
  sdk: '0.1.0', // @agentgate/client
  network: DEFAULT_ZG_NETWORK,
  chainId: 16602,
  explorerUrl: DEFAULT_ZG_EXPLORER_URL,
  registryAddress: DEFAULT_REGISTRY_ADDRESS,
} as const;

/**
 * Compact form of the registry address for badges (e.g. `0x103a3b12…57923`).
 * `DEFAULT_REGISTRY_ADDRESS` is `''` until the registry is deployed, and it is
 * typed as that literal — widen to string so the deployed branch stays live
 * code rather than narrowing to `never`.
 */
const registryAddress: string = DEFAULT_REGISTRY_ADDRESS;
export const REGISTRY_ADDRESS_SHORT =
  registryAddress === ''
    ? 'not yet deployed'
    : `${registryAddress.slice(0, 10)}…${registryAddress.slice(-6)}`;
