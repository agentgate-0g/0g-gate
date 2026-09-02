export interface PaymentProofMessageInput {
  /** 0G network name (e.g. "0g-galileo") — prevents cross-network replay. */
  network: string;
  /** On-chain service id the invoice was issued for. */
  serviceId: number;
  /** The invoice nonce that was settled (decimal uint256 string). */
  nonce: string;
  /** Tx hash of the settled PaymentRouter.pay() call. */
  transaction: string;
}

/**
 * Canonical, domain-separated bytes a BUYER signs to prove the X-PAYMENT proof
 * is theirs. THE single source of truth: the client signs these exact bytes and
 * the gateway rebuilds + verifies them, so both sides must call this one
 * function — the same contract `buildSelfMapMessage` holds for the owner path.
 *
 * This exists because the proof it accompanies is otherwise a BEARER TOKEN.
 * `PaymentRouter.Paid` indexes `serviceId` and `nonce` precisely so the gateway
 * can verify with one exact-match `eth_getLogs` — which also publishes both
 * values, and the tx hash, to the whole world the moment the block lands. The
 * registry publishes `gatewayBaseUrl` too. So without this signature every input
 * needed to redeem a stranger's paid invoice is public: an attacker watching the
 * router's logs replays {transaction, nonce}, the gateway verifies it happily
 * (the payment IS real), burns the invoice and serves the response to the
 * attacker. The buyer then gets `invoice_used`, and PaymentRouter has no refund
 * path — their OG is already with the seller.
 *
 * The router itself already got this right on-chain: `settledAmount` is keyed on
 * `(serviceId, nonce, payer, payTo)` and its comment explains that dropping the
 * payer would let any address burn any invoice. This is that same binding,
 * reproduced off-chain where it was missing.
 *
 * `transaction` is lowercased before signing because a tx hash is
 * case-insensitive hex that different tools render differently; signing over the
 * raw spelling would make a proof verify or fail on presentation formatting.
 */
export function buildPaymentProofMessage(input: PaymentProofMessageInput): Uint8Array {
  const text = [
    'AgentGate/payment-proof/v1',
    input.network,
    String(input.serviceId),
    input.nonce,
    input.transaction.toLowerCase(),
  ].join('\n');
  return new TextEncoder().encode(text);
}
