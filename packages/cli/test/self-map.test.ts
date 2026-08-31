import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  buildSelfMapMessage,
  type AnySigner,
  type ChainClient,
  type RegisterServiceInput,
} from '@agentgate/shared';
import { recoverSigner } from '@agentgate/chain';
import { signMessage, wrapService } from '../src/index';

// Freshly generated at runtime (never a pasted hex literal) so no key-shaped
// string lands in a tracked file for secret scanners to flag.
const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);

/** Minimal ChainClient: wrapService only calls registerService in these tests. */
function fakeChain(): ChainClient {
  return {
    network: '0g-galileo',
    registerService: async (_input: RegisterServiceInput, _signer: AnySigner) => ({
      serviceId: 1,
      txHash: `0x${'a'.repeat(64)}`,
    }),
  } as unknown as ChainClient;
}

describe('signMessage (key signer)', () => {
  it('produces a signature recoverSigner accepts under the signer address', async () => {
    const msg = buildSelfMapMessage({
      network: '0g-galileo',
      serviceId: 7,
      upstreamUrl: 'https://api.example.com/x',
      timestamp: 111,
    });
    const { signatureHex } = await signMessage({ kind: 'key', privateKey }, msg);
    const res = await recoverSigner(msg, signatureHex);
    expect(res.valid).toBe(true);
    expect(res.address).toBe(account.address.toLowerCase());
  });

  it('does NOT verify under a different message (forgery must not slip through)', async () => {
    const msg = buildSelfMapMessage({
      network: '0g-galileo',
      serviceId: 7,
      upstreamUrl: 'https://api.example.com/x',
      timestamp: 111,
    });
    const { signatureHex } = await signMessage({ kind: 'key', privateKey }, msg);
    const other = buildSelfMapMessage({
      network: '0g-galileo',
      serviceId: 7,
      upstreamUrl: 'https://api.example.com/EVIL',
      timestamp: 111,
    });
    const res = await recoverSigner(other, signatureHex);
    // Recovery still "succeeds" (every well-formed signature recovers to some
    // address) — it just isn't OUR address, which is what an owner check
    // downstream must compare against.
    expect(res.address).not.toBe(account.address.toLowerCase());
  });

  it('rejects a mock signer (self-map needs a real key)', async () => {
    await expect(
      signMessage({ kind: 'mock', publicKey: 'seller-mock-key' }, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: 'SIGNER_UNSUPPORTED' });
  });
});

describe('wrapService self-map path (key signer)', () => {
  it('POSTs a valid owner-signed body to /services/:id/map (no admin token, no publicKeyHex)', async () => {
    let capturedUrl = '';
    let capturedBody: {
      upstreamUrl: string;
      timestamp: number;
      signatureHex: string;
      publicKeyHex?: unknown;
    } | null = null;
    let sawAuthHeader = true;

    const result = await wrapService({
      upstreamUrl: 'https://api.example.com/gold',
      priceOg: '0.5',
      name: 'Gold',
      gateway: 'https://gw.example',
      chain: fakeChain(),
      signer: { kind: 'key', privateKey },
      adminToken: 'dev-admin-token',
      mode: 'live',
      network: '0g-galileo',
      fetchImpl: async (url, init) => {
        capturedUrl = String(url);
        sawAuthHeader = 'authorization' in ((init?.headers as Record<string, string>) ?? {});
        capturedBody = JSON.parse(String(init?.body));
        return new Response(null, { status: 204 });
      },
    });

    expect(result.adminOk).toBe(true);
    expect(capturedUrl).toBe('https://gw.example/services/1/map');
    expect(sawAuthHeader).toBe(false); // no bearer token on the self-map path
    expect(capturedBody).not.toBeNull();

    // The wire body carries no public key — EVM recovers the signer instead.
    const body = capturedBody!;
    expect(body.publicKeyHex).toBeUndefined();

    // Rebuild the challenge from the transmitted body and verify the signature.
    const msg = buildSelfMapMessage({
      network: '0g-galileo',
      serviceId: 1,
      upstreamUrl: body.upstreamUrl,
      timestamp: body.timestamp,
    });
    const res = await recoverSigner(msg, body.signatureHex);
    expect(res.valid).toBe(true);
    expect(res.address).toBe(account.address.toLowerCase());
  });
});
