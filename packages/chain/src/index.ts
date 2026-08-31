import type { AgentGateConfig, ChainClient } from '@agentgate/shared';
import { MockChainHttpClient } from './mock';
import { Live0gClient } from './live-0g';

export { MockChainHttpClient, mockAccountAddress } from './mock';
export { Live0gClient } from './live-0g';
export { recoverSigner, type OwnerSignatureResult } from './signature';
export { normalizeAddress, isAddress, sameAddress, shortAddress } from './address';
export { REGISTRY_ABI, PAYMENT_ROUTER_ABI, SPEND_GUARD_ABI } from './abi';

/**
 * Picks the ChainClient implementation by `config.mode` (SPEC §4):
 * - 'mock' → MockChainHttpClient (REST against the local devnet at config.devnetUrl)
 * - 'live' → Live0gClient (viem against 0G Galileo Testnet)
 */
export function createChainClient(config: AgentGateConfig): ChainClient {
  return config.mode === 'live'
    ? new Live0gClient(config)
    : new MockChainHttpClient(config.devnetUrl);
}
