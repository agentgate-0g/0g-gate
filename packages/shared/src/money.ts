import type { Wei } from './types';
import { AgentGateError } from './errors';

/** 1 OG = 1e18 wei. */
export const WEI_PER_OG = 1_000_000_000_000_000_000n;

/** Max decimal places an OG amount may carry (wei precision). */
const MAX_OG_DECIMALS = 18;

const OG_RE = /^(\d+)(?:\.(\d+))?$/;
const WEI_RE = /^\d+$/;

function invalidAmount(value: unknown, why: string): AgentGateError {
  return new AgentGateError('INVALID_AMOUNT', `invalid amount ${JSON.stringify(String(value))}: ${why}`, 400);
}

/**
 * Parse a wei decimal string into a bigint.
 * Throws AgentGateError('INVALID_AMOUNT') on anything that is not a plain
 * non-negative integer decimal string (no sign, no decimals, no exponent).
 */
export function parseWei(w: Wei): bigint {
  if (typeof w !== 'string' || !WEI_RE.test(w)) {
    throw invalidAmount(w, 'wei must be a non-negative integer decimal string');
  }
  return BigInt(w);
}

/**
 * Convert an OG decimal string (e.g. "0.5") to wei ("500000000000000000").
 * Bigint-backed — never goes through Number. Throws on:
 * negative values, more than 18 decimal places, exponents, or non-numeric input.
 */
export function ogToWei(og: string): Wei {
  if (typeof og !== 'string') throw invalidAmount(og, 'must be a string');
  const match = OG_RE.exec(og.trim());
  if (!match) throw invalidAmount(og, 'must be a non-negative decimal string like "0.5"');
  const whole = match[1] ?? '0';
  const frac = match[2] ?? '';
  if (frac.length > MAX_OG_DECIMALS) {
    throw invalidAmount(og, `at most ${MAX_OG_DECIMALS} decimal places (1 wei = 1e-18 OG)`);
  }
  const wei = BigInt(whole) * WEI_PER_OG + BigInt(frac.padEnd(MAX_OG_DECIMALS, '0') || '0');
  return wei.toString();
}

/**
 * Convert wei ("1500000000000000000") to an OG decimal string ("1.5"),
 * trimming trailing zeros (and the dot when the fraction is zero).
 */
export function weiToOg(w: Wei): string {
  const v = parseWei(w);
  const whole = v / WEI_PER_OG;
  const frac = v % WEI_PER_OG;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(MAX_OG_DECIMALS, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fracStr}`;
}

/** Add two wei values; returns wei decimal string. */
export function addWei(a: Wei, b: Wei): Wei {
  return (parseWei(a) + parseWei(b)).toString();
}

/** Compare two wei values: -1 if a < b, 0 if equal, 1 if a > b. */
export function compareWei(a: Wei, b: Wei): -1 | 0 | 1 {
  const x = parseWei(a);
  const y = parseWei(b);
  if (x < y) return -1;
  if (x > y) return 1;
  return 0;
}

/** Human-readable OG amount, e.g. formatOg("500000000000000000") === "0.5 OG". */
export function formatOg(w: Wei): string {
  return `${weiToOg(w)} OG`;
}

/**
 * Format an atomic token amount for a token with `decimals` places, trimming
 * trailing zeros — e.g. formatUnits("100000000", 9) === "0.1". Generalizes
 * weiToOg to any decimal precision (used for ERC-20 amounts in `accepts[]`).
 */
export function formatUnits(atomic: string, decimals: number): string {
  const v = parseWei(atomic); // reuse the non-negative-integer-string guard
  if (!Number.isInteger(decimals) || decimals <= 0) return v.toString();
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fracStr}`;
}

/** Human-readable token amount, e.g. formatToken("100000", 6, "USDC") === "0.1 USDC". */
export function formatToken(atomic: string, decimals: number, symbol: string): string {
  return `${formatUnits(atomic, decimals)} ${symbol}`;
}
