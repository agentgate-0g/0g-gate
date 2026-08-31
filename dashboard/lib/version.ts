import { DEFAULT_REGISTRY_ADDRESS, DEFAULT_ZG_EXPLORER_URL, DEFAULT_ZG_NETWORK } from '@agentgate/shared';

/**
 * Versions the docs describe. The registry address is sourced from the shared
 * package so it can never drift from what the gateway/CLI actually use; bump
 * `cli`/`sdk` when those packages publish a new version.
 */
export const DOCS_VERSION = {
  cli: '1.0.2', // agentgate-0g
  // Same package: agentgate-0g ships the CLI and the SDK from one tarball.
  // @agentgate/client is an internal workspace package and is never published,
  // so its version means nothing to a reader — this must track the published one.
  sdk: '1.0.2', // agentgate-0g (same package as the CLI)
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
