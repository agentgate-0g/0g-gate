import { describe, expect, it } from 'vitest';
import { normalizeAddress, isAddress, sameAddress, shortAddress, addressFromPrivateKey } from '../src/address';

const A = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';

describe('address helpers', () => {
  it('normalizeAddress lowercases a checksummed address', () => {
    expect(normalizeAddress(A)).toBe(A.toLowerCase());
  });

  it('normalizeAddress accepts an already-lowercase address', () => {
    expect(normalizeAddress(A.toLowerCase())).toBe(A.toLowerCase());
  });

  it('normalizeAddress throws on malformed input', () => {
    for (const bad of ['', '0x', 'acct-' + 'ab'.repeat(32), '0x123', A.slice(0, -1)]) {
      expect(() => normalizeAddress(bad)).toThrow();
    }
  });

  it('isAddress never throws and mirrors normalizeAddress', () => {
    expect(isAddress(A)).toBe(true);
    expect(isAddress('nope')).toBe(false);
  });

  it('sameAddress compares case-insensitively', () => {
    expect(sameAddress(A, A.toLowerCase())).toBe(true);
    expect(sameAddress(A, '0x' + '0'.repeat(40))).toBe(false);
  });

  it('sameAddress is false for malformed input instead of throwing', () => {
    expect(sameAddress('nope', A)).toBe(false);
  });

  it('shortAddress truncates for display', () => {
    expect(shortAddress(A)).toBe('0x5aAeb6…eAed');
  });
});

describe('addressFromPrivateKey', () => {
  // The gateway advertises this address at /healthz and `wrap` registers
  // services with it. If the derivation is wrong, every service registered
  // through the fix is unattestable in exactly the way the fix exists to
  // prevent — and the failure is silent, because payments still work.
  it('derives the well-known address for a known key', () => {
    // anvil account #0 — a published test vector, not a secret.
    expect(
      addressFromPrivateKey('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'),
    ).toBe('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266');
  });

  it('returns the canonical lowercase form, matching what the registry compares', () => {
    const a = addressFromPrivateKey(`0x${'1'.repeat(64)}`);
    expect(a).toBe(a.toLowerCase());
    expect(a).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it('rejects a malformed key rather than returning a wrong address', () => {
    expect(() => addressFromPrivateKey('not-a-key')).toThrow();
  });
});
