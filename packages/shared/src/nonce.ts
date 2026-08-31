/** 2^53 − 2 — the modulus cap keeping a nonce ≤ Number.MAX_SAFE_INTEGER − 1. */
const SAFE_NONCE_MODULUS = 9_007_199_254_740_990n;

/**
 * Random payment nonce: a positive integer (`1 … 2^53−2`) as a decimal string,
 * carried as the indexed `nonce` topic on `PaymentRouter.Paid`, which is what
 * binds a payment to its invoice. The chain itself takes a uint256; the cap is
 * for the JSON hops around it — anything above `Number.MAX_SAFE_INTEGER` that
 * passes through a `number` on the way loses its low digits and could never be
 * matched again on verification. 52+ bits of WebCrypto entropy is ample
 * for a single-use, short-TTL nonce.
 */
export function randomNonce(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  // 1 … 2^53−2, exactly representable as a JSON float64 (avoids 0 = "no id").
  return ((value % SAFE_NONCE_MODULUS) + 1n).toString();
}
