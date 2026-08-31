import { AgentGateError } from '@agentgate/shared';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * Canonical internal form for an EVM address: lowercased `0x` + 40 hex.
 * Every comparison and map key in AgentGate uses this form; checksummed
 * (EIP-55) casing is a display concern only. Throws on anything malformed —
 * this is the single validation gate for addresses entering the system.
 */
export function normalizeAddress(value: string): string {
  if (typeof value !== 'string' || !ADDRESS_RE.test(value.trim())) {
    throw new AgentGateError(
      'INVALID_ADDRESS',
      `not an EVM address: ${JSON.stringify(value)}`,
      400,
    );
  }
  return value.trim().toLowerCase();
}

/** Non-throwing predicate form of {@link normalizeAddress}. */
export function isAddress(value: string): boolean {
  return typeof value === 'string' && ADDRESS_RE.test(value.trim());
}

/** Case-insensitive address equality. Malformed input compares false, never throws. */
export function sameAddress(a: string, b: string): boolean {
  if (!isAddress(a) || !isAddress(b)) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Display form: `0x5aAeb6…eAed`. Returns the input unchanged if malformed. */
export function shortAddress(value: string): string {
  if (!isAddress(value)) return value;
  const v = value.trim();
  return `${v.slice(0, 8)}…${v.slice(-4)}`;
}
