import { describe, expect, it } from 'vitest';
import { isAgentGateError } from '@agentgate/shared';
import { requireAddress } from '../src/validate';

const HEX40 = (c: string): string => c.repeat(40);

describe('requireAddress', () => {
  it('accepts a lowercase 0x address and returns it unchanged', () => {
    expect(requireAddress(`0x${HEX40('a')}`, 'paymentTarget')).toBe(`0x${HEX40('a')}`);
  });

  it('accepts an EIP-55 checksummed address and lowercases it', () => {
    // A real checksummed address (EIP-55 reference vector).
    expect(requireAddress('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', 'attestor')).toBe(
      '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed',
    );
  });

  it('trims surrounding whitespace', () => {
    expect(requireAddress(`  0x${HEX40('b')}  `, 'attestor')).toBe(`0x${HEX40('b')}`);
  });

  it('rejects a long prefixed identifier that is not an address', () => {
    expect(() => requireAddress(`acct-${'1'.repeat(64)}`, 'paymentTarget')).toThrow(
      /INVALID_ADDRESS|EVM address/,
    );
  });

  it('rejects bare hex with no 0x prefix', () => {
    expect(() => requireAddress(`01${'a'.repeat(64)}`, 'attestor')).toThrow(/EVM address/);
  });

  it('rejects a 0x-prefixed 32-byte value (a tx hash or private key, not an address)', () => {
    expect(() => requireAddress(`0x${'c'.repeat(64)}`, 'paymentTarget')).toThrow(/EVM address/);
  });

  it('rejects an empty value', () => {
    expect(() => requireAddress('   ', 'paymentTarget')).toThrow(/non-empty/);
  });

  it('throws AgentGateError with a 400 status and the INVALID_ADDRESS code', () => {
    try {
      requireAddress('nope', 'paymentTarget');
      expect.unreachable('requireAddress should have thrown');
    } catch (err) {
      expect(isAgentGateError(err)).toBe(true);
      if (isAgentGateError(err)) {
        expect(err.code).toBe('INVALID_ADDRESS');
        expect(err.httpStatus).toBe(400);
      }
    }
  });
});
