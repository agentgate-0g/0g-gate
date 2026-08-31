import { describe, expect, it } from 'vitest';
import { mnemonicToAccount } from 'viem/accounts';
import { recoverSigner } from '../src/signature';

// Anvil's public default mnemonic — derived, not pasted, so no key-shaped
// literal lands in a tracked file for secret scanners to flag.
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
const account = mnemonicToAccount(ANVIL_MNEMONIC);
const MSG = new TextEncoder().encode('AgentGate/self-map/v1\n0g-galileo\n1\nhttps://x\n123');

describe('recoverSigner', () => {
  it('recovers the signer address from a valid EIP-191 signature', async () => {
    const sig = await account.signMessage({ message: { raw: MSG } });
    const res = await recoverSigner(MSG, sig);
    expect(res.valid).toBe(true);
    expect(res.address).toBe(account.address.toLowerCase());
  });

  it('does NOT recover the same address for a different message', async () => {
    const sig = await account.signMessage({ message: { raw: MSG } });
    const res = await recoverSigner(new TextEncoder().encode('other'), sig);
    // recovery still succeeds cryptographically, but yields a DIFFERENT address —
    // which is why the caller MUST compare against the on-chain owner.
    expect(res.address).not.toBe(account.address.toLowerCase());
  });

  it('rejects a tampered signature WITHOUT throwing', async () => {
    const bad = `0x${'11'.repeat(65)}`;
    const res = await recoverSigner(MSG, bad);
    expect(res.valid).toBe(false);
    expect(res.address).toBe('');
  });

  it('rejects malformed signature hex without throwing', async () => {
    for (const bad of ['', '0x', 'zz', '0x1234']) {
      await expect(recoverSigner(MSG, bad)).resolves.toEqual({ address: '', valid: false });
    }
  });
});
