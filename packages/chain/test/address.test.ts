import { describe, expect, it } from 'vitest';
import { normalizeAddress, isAddress, sameAddress, shortAddress } from '../src/address';

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
