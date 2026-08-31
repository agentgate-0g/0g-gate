import { recoverMessageAddress, isHex } from 'viem';

export interface OwnerSignatureResult {
  /** Recovered signer address (lowercased `0x…`); '' when recovery failed. */
  address: string;
  /** true when the signature is well-formed and an address was recovered. */
  valid: boolean;
}

/**
 * Recovers the EVM address that produced an EIP-191 (`personal_sign`) signature
 * over `message`.
 *
 * There is no public key to pass in: on EVM the signer is RECOVERED from the
 * signature itself, so the caller transmits only that signature. Which also
 * means a successful recovery proves NOTHING on its own — every signature
 * recovers to some address. The caller MUST compare the result against the
 * expected on-chain owner; see the self-map handler in
 * `packages/middleware/src/app.ts`.
 *
 * Fully defensive: malformed hex or a wrong-length signature returns
 * `{ address: '', valid: false }`. NEVER throws — safe on untrusted input.
 */
export async function recoverSigner(
  message: Uint8Array,
  signatureHex: string,
): Promise<OwnerSignatureResult> {
  // 0x + r(32) + s(32) + v(1) = 132 chars.
  if (!isHex(signatureHex) || signatureHex.length !== 132) {
    return { address: '', valid: false };
  }
  try {
    const address = await recoverMessageAddress({
      message: { raw: message },
      signature: signatureHex,
    });
    return { address: address.toLowerCase(), valid: true };
  } catch {
    return { address: '', valid: false };
  }
}
