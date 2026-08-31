import { AgentGateError, type AgentGateConfig, type AnySigner } from '@agentgate/shared';

/**
 * Signer resolution for the CLI commands that write on-chain.
 *
 * mock mode → the devnet account keys (`MOCK_*_ACCOUNT`), which carry no key
 * material. live mode → a `0x`-prefixed 32-byte private key, already shape-
 * validated by `loadConfig`.
 *
 * **Never put a key value in an error message.** These errors are printed to a
 * terminal and often pasted into issues; they name the flag and the env var,
 * never the secret.
 */

function missing(role: 'seller' | 'buyer', envVar: string): AgentGateError {
  return new AgentGateError(
    'SIGNER_MISSING',
    `live mode needs a ${role} key — pass --key <0x…> or set ${envVar} (the env var is safer: a --key argument is visible in your shell history and in \`ps\`)`,
    400,
  );
}

function missingMock(role: 'seller' | 'buyer', envVar: string): AgentGateError {
  return new AgentGateError(
    'SIGNER_MISSING',
    `mock mode needs ${envVar} — run \`agentgate demo-accounts\` and paste the printed export lines first`,
    400,
  );
}

/** Seller signer per mode: mock → MOCK_SELLER_ACCOUNT, live → --key | SELLER_SIGNER_KEY. */
export function sellerSigner(config: AgentGateConfig): AnySigner {
  if (config.mode === 'mock') {
    if (config.mockSellerAccount === '') throw missingMock('seller', 'MOCK_SELLER_ACCOUNT');
    return { kind: 'mock', publicKey: config.mockSellerAccount };
  }
  if (config.sellerSignerKey === '') throw missing('seller', 'SELLER_SIGNER_KEY');
  return { kind: 'key', privateKey: config.sellerSignerKey };
}

/**
 * Buyer signer per mode: mock → MOCK_BUYER_ACCOUNT, live → `keyFlag` |
 * BUYER_SIGNER_KEY. `keyFlag` is the `buy`/`mcp` `--key` value, which addresses
 * the *buyer* key — the shared `--key` flag maps to the seller key in
 * `resolveCliEnv`, so those commands hand it here instead.
 */
export function buyerSigner(config: AgentGateConfig, keyFlag?: string): AnySigner {
  if (config.mode === 'mock') {
    if (config.mockBuyerAccount === '') throw missingMock('buyer', 'MOCK_BUYER_ACCOUNT');
    return { kind: 'mock', publicKey: config.mockBuyerAccount };
  }
  const privateKey =
    keyFlag !== undefined && keyFlag.trim() !== '' ? keyFlag.trim() : config.buyerSignerKey;
  if (privateKey === '') throw missing('buyer', 'BUYER_SIGNER_KEY');
  return { kind: 'key', privateKey };
}
