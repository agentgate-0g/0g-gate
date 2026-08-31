import { describe, expect, it, vi } from 'vitest';
import type { AnySigner, ChainClient, RegisterServiceInput } from '@agentgate/shared';
import { DEFAULT_GATEWAY_URL } from '@agentgate/shared';
import { addressFromPrivateKey } from '@agentgate/chain';
import { wrapService } from '../src/index';

// A throwaway key. Never funded, never used on-chain. Only its ADDRESS matters:
// it stands in for a brand-new seller's SELLER_SIGNER_KEY.
const SELLER_KEY = `0x${'11'.repeat(32)}`;
const SELLER_ADDR = addressFromPrivateKey(SELLER_KEY);
const KEY_SIGNER: AnySigner = { kind: 'key', privateKeyHex: SELLER_KEY } as AnySigner;

interface FakeChain extends ChainClient {
  registered: Array<{ input: RegisterServiceInput }>;
}

function makeFakeChain(): FakeChain {
  const registered: FakeChain['registered'] = [];
  return {
    network: '0g-galileo',
    registered,
    async getService() {
      return null;
    },
    async listServices() {
      return [];
    },
    async getScore() {
      return { totalCalls: 0, successCalls: 0 };
    },
    async listAttestations() {
      return [];
    },
    async listRecentActivity() {
      return [];
    },
    async getBalance() {
      return '0';
    },
    async verifyTransfer() {
      return { ok: false, reason: 'not_found' } as const;
    },
    async registerService(input: RegisterServiceInput) {
      registered.push({ input });
      return { serviceId: 999, txHash: `0x${'ab'.repeat(32)}` };
    },
    async setServiceActive() {
      return { txHash: `0x${'cd'.repeat(32)}` };
    },
    async recordAttestation() {
      return { txHash: `0x${'ef'.repeat(32)}` };
    },
    async transfer() {
      return { txHash: `0x${'12'.repeat(32)}` };
    },
  } as unknown as FakeChain;
}

/**
 * fetch that hits the REAL hosted gateway for the read-only /healthz probe and
 * stubs every write (the self-map POST) with a 200 so nothing is ever sent.
 */
function realHealthzFetch(): {
  impl: (url: string, init?: RequestInit) => Promise<Response>;
  seen: string[];
} {
  const seen: string[] = [];
  return {
    seen,
    impl: async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/healthz') && (init?.method ?? 'GET') === 'GET') {
        return fetch(url, { signal: AbortSignal.timeout(15_000) });
      }
      // never actually POST to production
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  };
}

describe('JUDGE A: default live wrap against the DEPLOYED hosted gateway', () => {
  it('what the production /healthz actually answers right now', async () => {
    const res = await fetch(`${DEFAULT_GATEWAY_URL}/healthz`, {
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json()) as Record<string, unknown>;
    console.log('PROD /healthz =', JSON.stringify(body));
    console.log('advertises attestor?', Object.hasOwn(body, 'attestor'));
    expect(res.ok).toBe(true);
  }, 30_000);

  it('registers which attestor, and does it warn?', async () => {
    const chain = makeFakeChain();
    const { impl, seen } = realHealthzFetch();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let said = '';
    try {
      await wrapService({
        upstreamUrl: 'https://api.example.com',
        priceOg: '0.5',
        name: 'My API',
        gateway: DEFAULT_GATEWAY_URL,
        chain,
        signer: KEY_SIGNER,
        mode: 'live',
        network: '0g-galileo',
        fetchImpl: impl,
      });
      said = spy.mock.calls.map((c) => String(c[0])).join('\n');
    } finally {
      spy.mockRestore();
    }
    const registeredAttestor = chain.registered[0]!.input.attestor;
    console.log('requests made  :', JSON.stringify(seen));
    console.log('seller address :', SELLER_ADDR);
    console.log('registered attestor:', registeredAttestor);
    console.log('warned?        :', said === '' ? '(NOTHING PRINTED)' : said);
    expect(chain.registered).toHaveLength(1);
  }, 30_000);

  it('MOCK-MODE variant: same no-attestor body, mode omitted -> silent?', async () => {
    const chain = makeFakeChain();
    const { impl } = realHealthzFetch();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let said = '';
    try {
      await wrapService({
        upstreamUrl: 'https://api.example.com',
        priceOg: '0.5',
        name: 'My API',
        gateway: DEFAULT_GATEWAY_URL,
        chain,
        signer: KEY_SIGNER,
        // mode deliberately omitted (library caller)
        network: '0g-galileo',
        fetchImpl: impl,
      });
      said = spy.mock.calls.map((c) => String(c[0])).join('\n');
    } finally {
      spy.mockRestore();
    }
    console.log('mode-omitted registered attestor:', chain.registered[0]!.input.attestor);
    console.log('mode-omitted warned?:', said === '' ? '(NOTHING PRINTED)' : said);
    expect(chain.registered).toHaveLength(1);
  }, 30_000);
});
