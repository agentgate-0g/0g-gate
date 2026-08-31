import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { buildSelfMapMessage } from '@agentgate/shared';
import { bootGateway, startUpstream, type TestGateway, type TestUpstream } from './helpers';

// Freshly generated at runtime (never a pasted hex literal) so no key-shaped
// string lands in a tracked file for secret scanners to flag.
const account = privateKeyToAccount(generatePrivateKey());

interface BodyOverrides {
  serviceId?: number;
  upstreamUrl?: string;
  timestamp?: number;
  signatureHex?: string;
}

describe('self-service mapping POST /services/:id/map (mock mode)', () => {
  let gw: TestGateway;
  let upstream: TestUpstream;

  beforeAll(async () => {
    gw = await bootGateway();
    upstream = await startUpstream();
    // #1 owned by our test key; #2 owned by someone else.
    gw.fake.addService({ id: 1, name: 'Owned Feed', owner: account.address });
    gw.fake.addService({ id: 2, name: 'Someone Elses', owner: `0x${'bb'.repeat(20)}` });
  });

  afterAll(async () => {
    await gw.close();
    await upstream.close();
  });

  /** Build a well-formed, owner-signed body (fields overridable to force reject paths). */
  async function signedBody(o: BodyOverrides = {}): Promise<Record<string, unknown>> {
    const serviceId = o.serviceId ?? 1;
    const upstreamUrl = o.upstreamUrl ?? `${upstream.url}/data`;
    const timestamp = o.timestamp ?? Date.now();
    const message = buildSelfMapMessage({ network: gw.fake.network, serviceId, upstreamUrl, timestamp });
    const signatureHex = o.signatureHex ?? (await account.signMessage({ message: { raw: message } }));
    return { upstreamUrl, timestamp, signatureHex };
  }

  const post = (id: number, body: unknown): Promise<Response> =>
    fetch(`${gw.baseUrl}/services/${id}/map`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('maps the upstream for a valid owner signature (204), and /svc/1 then serves a 402', async () => {
    const res = await post(1, await signedBody());
    expect(res.status).toBe(204);
    const svc = await fetch(`${gw.baseUrl}/svc/1`);
    expect(svc.status).toBe(402); // mapped + active ⇒ payment required (not an unmapped error)
  });

  it('rejects a signature from a non-owner key (401 not_service_owner)', async () => {
    const other = privateKeyToAccount(generatePrivateKey());
    const upstreamUrl = `${upstream.url}/data`;
    const timestamp = Date.now();
    const message = buildSelfMapMessage({ network: gw.fake.network, serviceId: 1, upstreamUrl, timestamp });
    const res = await post(1, {
      upstreamUrl,
      timestamp,
      signatureHex: await other.signMessage({ message: { raw: message } }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'not_service_owner' });
  });

  it('rejects a tampered signature (401 not_service_owner)', async () => {
    const body = await signedBody();
    const sig = body.signatureHex as string;
    // Flip a bit inside the `r` component (well before the trailing `v` byte).
    // Touching only `v` is NOT a reliable tamper: ECDSA recovery only cares
    // about its parity, so a corrupted `v` that happens to preserve the same
    // parity as the original still recovers the correct address ~50% of the
    // time — verified empirically against viem's recoverMessageAddress.
    const idx = 4; // inside `r`, right after the 0x prefix
    const ch = sig[idx]!;
    const flipped = ch === '0' ? '1' : '0';
    body.signatureHex = sig.slice(0, idx) + flipped + sig.slice(idx + 1);
    const res = await post(1, body);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'not_service_owner' });
  });

  it('rejects a stale timestamp (401 stale_request)', async () => {
    const res = await post(1, await signedBody({ timestamp: Date.now() - 10 * 60_000 }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'stale_request' });
  });

  it('rejects an unknown service (404 service_not_found)', async () => {
    const res = await post(999, await signedBody({ serviceId: 999 }));
    expect(res.status).toBe(404);
  });

  it('rejects a replayed (older-or-equal) timestamp (409 replayed)', async () => {
    const ts = Date.now();
    expect((await post(1, await signedBody({ timestamp: ts }))).status).toBe(204);
    const replay = await post(1, await signedBody({ timestamp: ts }));
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual({ error: 'replayed' });
  });

  it('rejects a malformed body (400 invalid_body)', async () => {
    const res = await post(1, { upstreamUrl: 'https://x' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_body' });
  });
});
