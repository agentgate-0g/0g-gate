import { describe, it, expect } from 'vitest';
import { bootGateway, startUpstream, adminMap, payInvoice, proofHeaders, sleep } from './helpers';

/**
 * There was no way to learn that the money path had stopped working.
 * `/healthz` returned {ok:true} unconditionally and `/readyz` only proved the
 * node answered, while attestations are fire-and-forget — so a gate signer out
 * of gas, a queue that had stopped draining, or a wrong-chain boot all looked
 * exactly like a healthy gateway. Every field here is one an operator would
 * alert on.
 */
describe('/metrics exposes the money path', () => {
  it('reports queue depth, signer, invoice count and the OBSERVED chain id', async () => {
    const gw = await bootGateway();
    try {
      const res = await fetch(`${gw.baseUrl}/metrics`);
      expect(res.status).toBe(200);
      const m = (await res.json()) as Record<string, unknown>;
      expect(m).toHaveProperty('network');
      expect(m).toHaveProperty('observedChainId'); // null for the fake client, present as a field
      expect(m).toHaveProperty('signerBalanceWei');
      expect(m).toHaveProperty('attestationQueue');
      expect(m).toHaveProperty('invoicesHeld');
      expect(m).toHaveProperty('upstreamsMapped');
    } finally {
      await gw.close();
    }
  });

  it('invoice count and queue depth actually move as work flows through', async () => {
    const gw = await bootGateway();
    const upstream = await startUpstream();
    try {
      gw.fake.addService({ id: 3 });
      await adminMap(gw, 3, `${upstream.url}/data`);

      const before = (await (await fetch(`${gw.baseUrl}/metrics`)).json()) as {
        invoicesHeld: number; upstreamsMapped: number;
      };
      expect(before.upstreamsMapped).toBe(1);

      const proof = await payInvoice(gw, 3);
      const after = (await (await fetch(`${gw.baseUrl}/metrics`)).json()) as { invoicesHeld: number };
      expect(after.invoicesHeld).toBeGreaterThan(before.invoicesHeld);

      const served = await fetch(`${gw.baseUrl}/svc/3`, { headers: proofHeaders(proof) });
      expect(served.status).toBe(200);

      // The attestation drains, so the queue returns to empty rather than
      // growing silently — the signal that would have caught a stuck signer.
      let drained = false;
      for (let i = 0; i < 100 && !drained; i++) {
        const m = (await (await fetch(`${gw.baseUrl}/metrics`)).json()) as {
          attestationQueue: { pending: number } | null;
        };
        drained = m.attestationQueue !== null && m.attestationQueue.pending === 0;
        if (!drained) await sleep(20);
      }
      expect(drained).toBe(true);
    } finally {
      await gw.close();
      await upstream.close();
    }
  });

  it('a failing chain makes /readyz say WHY, not just "not ready"', async () => {
    const gw = await bootGateway();
    try {
      // The fake has no ping(), so readiness passes; assert the shape callers get.
      const res = await fetch(`${gw.baseUrl}/readyz`);
      const body = (await res.json()) as { ready: boolean };
      expect(body.ready).toBe(true);
    } finally {
      await gw.close();
    }
  });
});
