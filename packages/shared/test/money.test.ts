import { describe, expect, it } from 'vitest';
import {
  WEI_PER_OG, parseWei, ogToWei, weiToOg, formatOg, addWei, compareWei,
  formatUnits, formatToken,
} from '../src/money';

describe('money (18 decimals)', () => {
  it('WEI_PER_OG is 1e18', () => {
    expect(WEI_PER_OG).toBe(1_000_000_000_000_000_000n);
  });

  it('ogToWei converts whole and fractional OG', () => {
    expect(ogToWei('1')).toBe('1000000000000000000');
    expect(ogToWei('0.5')).toBe('500000000000000000');
    expect(ogToWei('0.000001')).toBe('1000000000000'); // the MIN_PRICE_WEI floor
    expect(ogToWei('0')).toBe('0');
  });

  it('ogToWei accepts exactly 18 decimal places and rejects 19', () => {
    expect(ogToWei('0.000000000000000001')).toBe('1');
    expect(() => ogToWei('0.0000000000000000001')).toThrow(/18 decimal places/);
  });

  it('weiToOg trims trailing zeros', () => {
    expect(weiToOg('1500000000000000000')).toBe('1.5');
    expect(weiToOg('1000000000000000000')).toBe('1');
    expect(weiToOg('0')).toBe('0');
  });

  it('formatOg appends the symbol', () => {
    expect(formatOg('500000000000000000')).toBe('0.5 OG');
  });

  it('round-trips through bigint without float loss', () => {
    const wei = '123456789012345678';
    expect(ogToWei(weiToOg(wei))).toBe(wei);
  });

  it('rejects negatives, exponents and non-numeric input', () => {
    for (const bad of ['-1', '1e18', 'abc', '', ' ']) {
      expect(() => ogToWei(bad)).toThrow();
    }
  });

  it('parseWei rejects anything but a non-negative integer decimal string', () => {
    expect(parseWei('42')).toBe(42n);
    for (const bad of ['-1', '1.5', '0x10', '']) {
      expect(() => parseWei(bad)).toThrow();
    }
  });

  it('addWei and compareWei are bigint-exact', () => {
    expect(addWei('1', '2')).toBe('3');
    expect(compareWei('2', '10')).toBe(-1); // numeric, not lexicographic
    expect(compareWei('10', '10')).toBe(0);
    expect(compareWei('10', '2')).toBe(1);
  });

  it('formatUnits and formatToken are unchanged and decimals-parametric', () => {
    expect(formatUnits('100000000', 9)).toBe('0.1');
    expect(formatToken('1000000', 6, 'USDC')).toBe('1 USDC');
  });
});
