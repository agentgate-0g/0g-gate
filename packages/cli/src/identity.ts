import { privateKeyToAccount } from 'viem/accounts';
import { mockAccountAddress } from '@agentgate/chain';
import type { AnySigner } from '@agentgate/shared';
import { AgentGateError } from '@agentgate/shared';

const PRIVATE_KEY_RE = /^0x[0-9a-f]{64}$/i;

function requireKey(signer: AnySigner): `0x${string}` {
  if (signer.kind !== 'key') {
    throw new AgentGateError(
      'SIGNER_UNSUPPORTED',
      'this command needs a key signer (live mode) — pass --key <0x…> or set SELLER_SIGNER_KEY',
      400,
    );
  }
  if (!PRIVATE_KEY_RE.test(signer.privateKey)) {
    // NEVER echo the key itself.
    throw new AgentGateError(
      'SIGNER_KEY_INVALID',
      'signer key must be a 0x-prefixed 32-byte hex private key',
      400,
    );
  }
  return signer.privateKey as `0x${string}`;
}

/**
 * The address a signer acts as — also the default payment target.
 * mock → `mockAccountAddress(publicKey)` (the derivation the devnet uses);
 * key  → the account address derived from the private key.
 */
export async function signerAddress(signer: AnySigner): Promise<string> {
  if (signer.kind === 'mock') return mockAccountAddress(signer.publicKey);
  return privateKeyToAccount(requireKey(signer)).address.toLowerCase();
}

/**
 * Signs `message` for the gateway's owner-signature self-map auth (EIP-191).
 * Only key signers can sign — mock mode uses the admin-token path.
 */
export async function signMessage(
  signer: AnySigner,
  message: Uint8Array,
): Promise<{ signatureHex: string }> {
  const account = privateKeyToAccount(requireKey(signer));
  return { signatureHex: await account.signMessage({ message: { raw: message } }) };
}
