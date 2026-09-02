import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { buildPaymentProofMessage, type PaymentRequiredResponse } from '@agentgate/shared';
import { FakeChainClient } from './fake-chain';
import { bootGateway, startUpstream, adminMap, proofHeaders, sleep } from './helpers';

/**
 * The X-PAYMENT proof used to be a BEARER TOKEN.
 *
 * `PaymentRouter.Paid` indexes `serviceId` and `nonce` so the gateway can verify
 * a payment with a single exact-match `eth_getLogs` — which also publishes the
 * nonce, the service id and the tx hash to everyone the moment the block lands.
 * The registry publishes `gatewayBaseUrl` too. So every input needed to redeem
 * somebody else's paid invoice was public, and the gateway never asked who was
 * presenting it.
 *
 * These tests pin the fix: the presenter must sign a canonical, domain-separated
 * message with the key that actually paid, and the gateway must compare the
 * recovered address against the payer THE CHAIN reported.
 */

const BUYER_KEY = `0x${'11'.repeat(32)}` as const;
const THIEF_KEY = `0x${'22'.repeat(32)}` as const;
const BUYER = privateKeyToAccount(BUYER_KEY).address.toLowerCase();
const PAYOUT = `0x${'cd'.repeat(20)}`;

/** A gateway on a real-money network (so the payer proof is required). */
async function bootLive() {
  return bootGateway({ fake: new FakeChainClient({ network: '0g-galileo' }) });
}

/** Drives the 402 → pay → present flow, returning what a presenter needs. */
async function payFor(gw: Awaited<ReturnType<typeof bootLive>>, serviceId: number) {
  const challenge = await fetch(`${gw.baseUrl}/svc/${serviceId}`);
  const body = (await challenge.json()) as PaymentRequiredResponse;
  const req = body.accepts[0]!;
  const { txHash } = await gw.fake.transfer(
    {
      to: req.payTo,
      amountWei: req.maxAmountRequired,
      nonce: req.extra.nonce,
      serviceId: req.extra.serviceId,
    },
    // The fake records `from` as the mock signer's publicKey, so this makes the
    // chain report the buyer's real EVM address as the payer.
    { kind: 'mock', publicKey: BUYER },
  );
  return { txHash, nonce: req.extra.nonce, network: req.network, serviceId: req.extra.serviceId };
}

function sign(key: `0x${string}`, p: { network: string; serviceId: number; nonce: string; txHash: string }) {
  return privateKeyToAccount(key).signMessage({
    message: {
      raw: buildPaymentProofMessage({
        network: p.network,
        serviceId: p.serviceId,
        nonce: p.nonce,
        transaction: p.txHash,
      }),
    },
  });
}

describe('X-PAYMENT payer proof', () => {
  it('a stranger who read the payment off the chain CANNOT redeem the invoice', async () => {
    const gw = await bootLive();
    const upstream = await startUpstream();
    try {
      gw.fake.addService({ id: 7, paymentTarget: PAYOUT });
      await adminMap(gw, 7, `${upstream.url}/data`);
      const paid = await payFor(gw, 7);

      // Everything the thief presents here is readable from the public chain.
      const stolen = await fetch(`${gw.baseUrl}/svc/7`, { headers: proofHeaders(paid) });
      expect(stolen.status).toBe(402);
      expect(((await stolen.json()) as { error: string }).error).toBe('payment_proof_unsigned');

      // The upstream was never called, so no paid data leaked.
      expect(upstream.seen.length).toBe(0);

      // And crucially the invoice is NOT burned — the real buyer can still
      // redeem what they paid for.
      const honest = await fetch(`${gw.baseUrl}/svc/7`, {
        headers: proofHeaders({ ...paid, signature: await sign(BUYER_KEY, paid) }),
      });
      expect(honest.status).toBe(200);
    } finally {
      await gw.close();
      await upstream.close();
    }
  });

  it('a proof signed by someone other than the payer is refused', async () => {
    const gw = await bootLive();
    const upstream = await startUpstream();
    try {
      gw.fake.addService({ id: 8, paymentTarget: PAYOUT });
      await adminMap(gw, 8, `${upstream.url}/data`);
      const paid = await payFor(gw, 8);

      const res = await fetch(`${gw.baseUrl}/svc/8`, {
        headers: proofHeaders({ ...paid, signature: await sign(THIEF_KEY, paid) }),
      });
      expect(res.status).toBe(402);
      expect(((await res.json()) as { error: string }).error).toBe('payment_proof_invalid');
      expect(upstream.seen.length).toBe(0);
    } finally {
      await gw.close();
      await upstream.close();
    }
  });

  it('a signature bound to a DIFFERENT invoice does not transfer to this one', async () => {
    const gw = await bootLive();
    const upstream = await startUpstream();
    try {
      gw.fake.addService({ id: 9, paymentTarget: PAYOUT });
      await adminMap(gw, 9, `${upstream.url}/data`);
      const first = await payFor(gw, 9);
      const second = await payFor(gw, 9);

      // Correctly signed by the payer — but for the OTHER nonce/tx.
      const res = await fetch(`${gw.baseUrl}/svc/9`, {
        headers: proofHeaders({ ...second, signature: await sign(BUYER_KEY, first) }),
      });
      expect(res.status).toBe(402);
      expect(((await res.json()) as { error: string }).error).toBe('payment_proof_invalid');
    } finally {
      await gw.close();
      await upstream.close();
    }
  });

  it('the payer is served, and the call is still attested', async () => {
    const gw = await bootLive();
    const upstream = await startUpstream();
    try {
      gw.fake.addService({ id: 10, paymentTarget: PAYOUT });
      await adminMap(gw, 10, `${upstream.url}/data`);
      const paid = await payFor(gw, 10);

      const res = await fetch(`${gw.baseUrl}/svc/10`, {
        headers: proofHeaders({ ...paid, signature: await sign(BUYER_KEY, paid) }),
      });
      expect(res.status).toBe(200);
      expect(upstream.seen.length).toBe(1);
      await sleep(100);
      expect(gw.fake.attestations.filter((a) => a.serviceId === 10).length).toBe(1);
    } finally {
      await gw.close();
      await upstream.close();
    }
  });

  it('a malformed signature is rejected as a bad payment, not a 5xx', async () => {
    const gw = await bootLive();
    const upstream = await startUpstream();
    try {
      gw.fake.addService({ id: 11, paymentTarget: PAYOUT });
      await adminMap(gw, 11, `${upstream.url}/data`);
      const paid = await payFor(gw, 11);

      const res = await fetch(`${gw.baseUrl}/svc/11`, {
        headers: proofHeaders({ ...paid, signature: '0xdeadbeef' }),
      });
      expect(res.status).toBe(402);
      expect(upstream.seen.length).toBe(0);
    } finally {
      await gw.close();
      await upstream.close();
    }
  });

  it('mock mode still serves an unsigned proof — no key material exists there', async () => {
    const gw = await bootGateway(); // network 'mock'
    const upstream = await startUpstream();
    try {
      gw.fake.addService({ id: 12, paymentTarget: PAYOUT });
      await adminMap(gw, 12, `${upstream.url}/data`);
      const challenge = await fetch(`${gw.baseUrl}/svc/12`);
      const req = ((await challenge.json()) as PaymentRequiredResponse).accepts[0]!;
      const { txHash } = await gw.fake.transfer(
        {
          to: req.payTo,
          amountWei: req.maxAmountRequired,
          nonce: req.extra.nonce,
          serviceId: req.extra.serviceId,
        },
        { kind: 'mock', publicKey: `0x${'ee'.repeat(20)}` },
      );
      const res = await fetch(`${gw.baseUrl}/svc/12`, {
        headers: proofHeaders({ txHash, nonce: req.extra.nonce, network: req.network }),
      });
      expect(res.status).toBe(200);
    } finally {
      await gw.close();
      await upstream.close();
    }
  });
});

/**
 * The buyer paid and the gateway could not deliver. The invoice is burned
 * before proxying so a payment stays single-use, but an upstream that is
 * unreachable, times out, or answers too large is the SELLER's backend failing
 * — not a call the buyer consumed. The gateway already knows the difference
 * (it declines to attest those); it used to keep the money anyway.
 */
describe('an undelivered paid call can be retried, not silently kept', () => {
  it('releases the invoice when the upstream is unreachable, and the payer can collect later', async () => {
    const gw = await bootLive();
    const upstream = await startUpstream();
    // Point at a port nothing is listening on, then hand over a working one.
    const deadPort = 1; // unbindable/closed — guarantees a connection failure
    try {
      gw.fake.addService({ id: 20, paymentTarget: PAYOUT });
      await adminMap(gw, 20, `http://127.0.0.1:${deadPort}/data`);
      const paid = await payFor(gw, 20);
      const signature = await sign(BUYER_KEY, paid);

      const failed = await fetch(`${gw.baseUrl}/svc/20`, {
        headers: proofHeaders({ ...paid, signature }),
      });
      expect(failed.status).toBeGreaterThanOrEqual(500); // gateway-side failure
      // Not scored either way — this was never a service outcome.
      await sleep(100);
      expect(gw.fake.attestations.filter((a) => a.serviceId === 20).length).toBe(0);

      // The seller's backend comes back. The SAME proof must still work.
      await adminMap(gw, 20, `${upstream.url}/data`);
      const retried = await fetch(`${gw.baseUrl}/svc/20`, {
        headers: proofHeaders({ ...paid, signature }),
      });
      expect(retried.status).toBe(200);
      expect(upstream.seen.length).toBe(1);
    } finally {
      await gw.close();
      await upstream.close();
    }
  });

  it('a 500 FROM the upstream is a real answer — it consumes the invoice', async () => {
    const gw = await bootLive();
    const upstream = await startUpstream();
    try {
      gw.fake.addService({ id: 21, paymentTarget: PAYOUT });
      await adminMap(gw, 21, `${upstream.url}/fail`);
      const paid = await payFor(gw, 21);
      const signature = await sign(BUYER_KEY, paid);

      const res = await fetch(`${gw.baseUrl}/svc/21`, { headers: proofHeaders({ ...paid, signature }) });
      expect(res.status).toBe(500); // the upstream answered; the buyer got their answer

      // Replaying it must NOT re-serve: this call was delivered.
      const replay = await fetch(`${gw.baseUrl}/svc/21`, { headers: proofHeaders({ ...paid, signature }) });
      expect(replay.status).toBe(402);
      expect(((await replay.json()) as { error: string }).error).toBe('invoice_used');
    } finally {
      await gw.close();
      await upstream.close();
    }
  });
});
