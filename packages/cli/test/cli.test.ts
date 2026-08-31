import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AnySigner,
  AttestationRecord,
  ChainClient,
  RegisterServiceInput,
  ServiceRecord,
  ServiceScore,
} from '@agentgate/shared';
import { AgentGateError } from '@agentgate/shared';
import { mockAccountAddress } from '@agentgate/chain';
import {
  createDemoAccounts,
  listServices,
  serviceStatus,
  setServiceActive,
  wrapService,
} from '../src/index';

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

const HEX64 = (c: string): string => c.repeat(64);
const HEX40 = (c: string): string => c.repeat(40);
const SIGNER: AnySigner = { kind: 'mock', publicKey: `01${HEX64('a')}` };
const PAYMENT_TARGET = `0x${HEX40('1')}`;
const REGISTER_TX = `0x${HEX64('f')}`;

interface FakeChain extends ChainClient {
  registered: Array<{ input: RegisterServiceInput; signer: AnySigner }>;
}

function makeService(id: number, over: Partial<ServiceRecord> = {}): ServiceRecord {
  return {
    id,
    name: `svc-${id}`,
    description: 'a service',
    endpointUrl: `http://gw.example:4021/svc/${id}`,
    priceWei: '500000000000000000',
    paymentTarget: PAYMENT_TARGET,
    owner: SIGNER.kind === 'mock' ? SIGNER.publicKey : '',
    attestor: `0x${HEX40('a')}`,
    active: true,
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

function makeFakeChain(hooks: { onRegister?: () => void } = {}): FakeChain {
  const registered: FakeChain['registered'] = [];
  const chain: FakeChain = {
    network: 'mock',
    registered,
    async getService() {
      return null;
    },
    async listServices() {
      return [];
    },
    async getScore(): Promise<ServiceScore> {
      return { totalCalls: 0, successCalls: 0 };
    },
    async listAttestations(): Promise<AttestationRecord[]> {
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
    async registerService(input, signer) {
      hooks.onRegister?.();
      registered.push({ input, signer });
      return { serviceId: 7, txHash: REGISTER_TX };
    },
    async recordAttestation() {
      return { txHash: `0x${HEX64('b')}` };
    },
    async setActive() {
      return { txHash: `0x${HEX64('c')}` };
    },
    async transfer() {
      return { txHash: `0x${HEX64('d')}` };
    },
  };
  return chain;
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function makeFakeFetch(
  responder: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { impl: (url: string, init?: RequestInit) => Promise<Response>; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  return {
    calls,
    impl: async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return responder(url, init);
    },
  };
}

function headersOf(call: FetchCall): Record<string, string> {
  return (call.init?.headers ?? {}) as Record<string, string>;
}

function bodyOf(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

// silence the warning print on the admin-failure path, keep assertions possible
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  consoleErrorSpy.mockRestore();
});

function baseWrapOpts(chain: FakeChain, fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  return {
    upstreamUrl: 'http://localhost:4010/feed',
    priceOg: '0.5',
    name: 'FX Oracle',
    description: 'USD/IDR + gold spot',
    gateway: 'http://gw.example:4021/', // trailing slash on purpose
    paymentTarget: PAYMENT_TARGET,
    chain,
    signer: SIGNER,
    adminToken: 'tok-123',
    fetchImpl,
  };
}

// ---------------------------------------------------------------------------
// wrapService — happy path
// ---------------------------------------------------------------------------

describe('wrapService attestor defaulting', () => {
  // A seller wrapping against a gateway they do not run used to register their
  // OWN address as attestor. The registry reverts recordAttestation for anyone
  // who is neither attestor nor owner, so the gateway serving the calls could
  // never write one: payments landed, the score stayed 0/0, and nothing said so.
  // Found by wrapping a real API against the hosted gateway and watching the
  // score refuse to move.
  const GATEWAY_ATTESTOR = '0x71a89a7e692dac4d6bd7c3f1cca9155592d87bae';

  function healthyGateway(attestor?: string) {
    return makeFakeFetch((url: string) =>
      url.endsWith('/healthz')
        ? new Response(JSON.stringify({ ok: true, network: '0g-galileo', ...(attestor ? { attestor } : {}) }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : new Response(null, { status: 204 }),
    );
  }

  it("registers the GATEWAY's attestor, not the seller's, when the gateway says who it is", async () => {
    const chain = makeFakeChain();
    const { impl } = healthyGateway(GATEWAY_ATTESTOR);
    await wrapService(baseWrapOpts(chain, impl));
    expect(chain.registered[0]!.input.attestor).toBe(GATEWAY_ATTESTOR);
  });

  it('lets an explicit --attestor win, for a seller running their own gateway', async () => {
    const chain = makeFakeChain();
    const { impl } = healthyGateway(GATEWAY_ATTESTOR);
    const mine = `0x${'ab'.repeat(20)}`;
    await wrapService({ ...baseWrapOpts(chain, impl), attestor: mine });
    expect(chain.registered[0]!.input.attestor).toBe(mine);
  });

  it('falls back to the seller and does not throw when the gateway says nothing', async () => {
    const chain = makeFakeChain();
    const { impl } = healthyGateway(undefined);
    const res = await wrapService(baseWrapOpts(chain, impl));
    expect(res.serviceId).toEqual(expect.any(Number));
    expect(chain.registered[0]!.input.attestor).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it('warns, naming the gateway address, when --attestor cannot attest', async () => {
    // The warning IS the safety net for this branch: registration is an
    // irreversible on-chain write, so a seller who passes the wrong address
    // needs to be told while they can still act. Untested, it can be deleted
    // without anything going red.
    const chain = makeFakeChain();
    const { impl } = healthyGateway(GATEWAY_ATTESTOR);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await wrapService({ ...baseWrapOpts(chain, impl), attestor: `0x${'ab'.repeat(20)}` });
      const said = spy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(said).toContain(GATEWAY_ATTESTOR); // tells them the address to use
      expect(said).toMatch(/0\/0|attestation/i); // and what goes wrong if they don't
    } finally {
      spy.mockRestore();
    }
  });

  it('warns in live mode when the gateway advertises no attestor at all', async () => {
    const chain = makeFakeChain();
    const { impl } = healthyGateway(undefined);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await wrapService({
        ...baseWrapOpts(chain, impl),
        mode: 'live',
        gateway: 'https://gw.example', // live mode refuses http:// for non-localhost
      });
      expect(spy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/did not advertise/i);
    } finally {
      spy.mockRestore();
    }
  });

  it('probes the advertised gateway with a plain GET on /healthz', async () => {
    // Pins the request shape: a seller's gateway has to be able to answer it.
    const chain = makeFakeChain();
    const { impl, calls } = healthyGateway(GATEWAY_ATTESTOR);
    await wrapService(baseWrapOpts(chain, impl));
    const probe = calls.find((c) => c.url.endsWith('/healthz'));
    expect(probe).toBeDefined();
    expect(probe!.url).toBe('http://gw.example:4021/healthz');
    expect(probe!.init?.method ?? 'GET').toBe('GET');
  });

  it('still registers when the health probe fails outright', async () => {
    // The probe runs before an on-chain write that costs gas; an unreachable
    // health endpoint must not block registration.
    const chain = makeFakeChain();
    const { impl } = makeFakeFetch((url: string) => {
      if (url.endsWith('/healthz')) throw new Error('ECONNREFUSED');
      return new Response(null, { status: 204 });
    });
    await expect(wrapService(baseWrapOpts(chain, impl))).resolves.toMatchObject({
      serviceId: expect.any(Number),
    });
  });
});

describe('wrapService admin token scope', () => {
  // Live mode uses a key signer and maps by signing an ownership challenge, so
  // no admin token is ever sent. Requiring one anyway rejected the documented
  // default path. The token is still demanded — and still demanded BEFORE the
  // on-chain write — on the admin path, because registerService costs gas and
  // cannot be undone.
  it('does not require an admin token on the owner-signed (key) path', async () => {
    const chain = makeFakeChain();
    const { impl } = makeFakeFetch(() => new Response(null, { status: 204 }));
    const { adminToken: _omitted, ...noToken } = baseWrapOpts(chain, impl);
    await expect(
      wrapService({ ...noToken, signer: { kind: 'key', privateKey: `0x${'1'.repeat(64)}` } }),
    ).resolves.toMatchObject({ serviceId: expect.any(Number) });
  });
});

describe('wrapService', () => {
  it('probes the gateway, then registers on-chain, then maps the upstream', async () => {
    // The probe has to come FIRST: it asks the gateway which address it signs
    // attestations as, and that address is written into the registration, which
    // cannot be changed by re-registering. Mapping has to come LAST: it is the
    // only step that is safe to repeat.
    const order: string[] = [];
    const chain = makeFakeChain({ onRegister: () => order.push('register') });
    const { impl, calls } = makeFakeFetch((url: string) => {
      order.push(url.endsWith('/healthz') ? 'probe' : 'admin');
      return new Response(null, { status: 204 });
    });

    const result = await wrapService(baseWrapOpts(chain, impl));

    // result shape + computed URLs
    expect(result.serviceId).toBe(7);
    expect(result.txHash).toBe(REGISTER_TX);
    expect(result.publicUrl).toBe('http://gw.example:4021/svc/7');
    expect(result.dashboardUrl).toBe('http://localhost:3000/services/7');
    expect(result.adminOk).toBe(true);
    expect(result.adminWarning).toBeUndefined();

    // ordering: probe, then the on-chain write, then the repeatable mapping
    expect(order).toEqual(['probe', 'register', 'admin']);

    // Exactly one mapping call. The probe is the other request and is asserted
    // by `order` above; filtering it here keeps the mapping assertions exact.
    const mapCalls = calls.filter((c) => !c.url.endsWith('/healthz'));
    expect(mapCalls).toHaveLength(1);

    // on-chain input: endpointUrl is the gateway BASE (SPEC §9 final decision)
    expect(chain.registered).toHaveLength(1);
    const reg = chain.registered[0]!;
    expect(reg.input.endpointUrl).toBe('http://gw.example:4021');
    expect(reg.input.name).toBe('FX Oracle');
    expect(reg.input.description).toBe('USD/IDR + gold spot');
    expect(reg.input.priceWei).toBe('500000000000000000'); // 0.5 OG, bigint-derived
    expect(reg.input.paymentTarget).toBe(PAYMENT_TARGET);
    // wrap.ts derives the default attestor via signerAddress(), which for a mock
    // signer is mockAccountAddress(publicKey) — the SAME derivation the devnet
    // applies server-side to `byPublicKey` when authorizing recordAttestation,
    // not the raw public key.
    expect(reg.input.attestor).toBe(
      SIGNER.kind === 'mock' ? mockAccountAddress(SIGNER.publicKey) : '',
    );
    expect(reg.signer).toEqual(SIGNER);

    // admin POST: URL, auth header, JSON body
    const call = mapCalls[0]!;
    expect(call.url).toBe('http://gw.example:4021/admin/services');
    expect(call.init?.method).toBe('POST');
    expect(headersOf(call)['authorization']).toBe('Bearer tok-123');
    expect(headersOf(call)['content-type']).toBe('application/json');
    expect(bodyOf(call)).toEqual({ serviceId: 7, upstreamUrl: 'http://localhost:4010/feed' });
  });

  it('uses an explicit attestor when provided', async () => {
    const chain = makeFakeChain();
    const { impl } = makeFakeFetch(() => new Response(null, { status: 204 }));
    const attestor = `0x${HEX40('9')}`;
    await wrapService({ ...baseWrapOpts(chain, impl), attestor });
    expect(chain.registered[0]!.input.attestor).toBe(attestor);
  });

  // -------------------------------------------------------------------------
  // admin failure path
  // -------------------------------------------------------------------------

  it('keeps the registration and returns a retry-curl warning when the admin POST fails (HTTP error)', async () => {
    const chain = makeFakeChain();
    const { impl } = makeFakeFetch(() => new Response('unauthorized', { status: 401 }));

    const result = await wrapService(baseWrapOpts(chain, impl));

    expect(result.serviceId).toBe(7);
    expect(result.txHash).toBe(REGISTER_TX);
    expect(result.publicUrl).toBe('http://gw.example:4021/svc/7');
    expect(result.adminOk).toBe(false);
    expect(result.adminWarning).toBeDefined();
    const warning = result.adminWarning!;
    expect(warning).toContain('HTTP 401');
    expect(warning).toContain('NOT rolled back');
    expect(warning).toContain(`tx ${REGISTER_TX}`);
    // exact retry curl
    expect(warning).toContain("curl -X POST 'http://gw.example:4021/admin/services'");
    expect(warning).toContain('-H "Authorization: Bearer $AGENTGATE_ADMIN_TOKEN"');
    expect(warning).toContain(
      `-d '{"serviceId":7,"upstreamUrl":"http://localhost:4010/feed"}'`,
    );
    // never leak the actual admin token into the warning
    expect(warning).not.toContain('tok-123');
    // warning also printed to stderr
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });

  it('treats a network error on the admin POST the same way', async () => {
    const chain = makeFakeChain();
    const impl = async (): Promise<Response> => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:4021');
    };

    const result = await wrapService(baseWrapOpts(chain, impl));

    expect(result.adminOk).toBe(false);
    expect(result.adminWarning).toContain('ECONNREFUSED');
    expect(result.adminWarning).toContain('curl -X POST');
    expect(chain.registered).toHaveLength(1); // registration untouched
  });

  // -------------------------------------------------------------------------
  // validation rejections (no side effects at all)
  // -------------------------------------------------------------------------

  const rejectionCases: Array<{ title: string; patch: Record<string, string>; code: string }> = [
    { title: 'price of 0', patch: { priceOg: '0' }, code: 'INVALID_PRICE' },
    { title: 'non-numeric price', patch: { priceOg: 'abc' }, code: 'INVALID_AMOUNT' },
    { title: 'negative price', patch: { priceOg: '-1' }, code: 'INVALID_AMOUNT' },
    { title: 'price with 19 decimals', patch: { priceOg: '0.1234567890123456789' }, code: 'INVALID_AMOUNT' },
    { title: 'blank name', patch: { name: '   ' }, code: 'INVALID_INPUT' },
    { title: 'non-http upstream', patch: { upstreamUrl: 'ftp://x.test/a' }, code: 'INVALID_URL' },
    { title: 'garbage upstream', patch: { upstreamUrl: 'not a url' }, code: 'INVALID_URL' },
    { title: 'ws gateway', patch: { gateway: 'ws://gw.example' }, code: 'INVALID_URL' },
    {
      title: 'gateway with query string',
      patch: { gateway: 'http://gw.example:4021/?x=1' },
      code: 'INVALID_URL',
    },
    {
      title: 'malformed payment target',
      patch: { paymentTarget: 'deadbeef' },
      code: 'INVALID_ADDRESS',
    },
    { title: 'malformed attestor', patch: { attestor: 'zz' }, code: 'INVALID_ADDRESS' },
    { title: 'empty admin token', patch: { adminToken: ' ' }, code: 'INVALID_INPUT' },
    // name/description sanitization (these go on-chain unmodified)
    { title: 'name with a control char', patch: { name: 'bad\x01name' }, code: 'INVALID_INPUT' },
    { title: 'name with a NUL byte', patch: { name: 'a\x00b' }, code: 'INVALID_INPUT' },
    { title: 'name with a DEL byte', patch: { name: 'a\x7fb' }, code: 'INVALID_INPUT' },
    { title: 'overlong name', patch: { name: 'n'.repeat(129) }, code: 'INVALID_INPUT' },
    {
      title: 'description with a control char',
      patch: { description: 'line1\nline2' },
      code: 'INVALID_INPUT',
    },
    { title: 'overlong description', patch: { description: 'd'.repeat(513) }, code: 'INVALID_INPUT' },
  ];

  for (const { title, patch, code } of rejectionCases) {
    it(`rejects ${title} without touching the chain or the gateway`, async () => {
      const chain = makeFakeChain();
      const { impl, calls } = makeFakeFetch(() => new Response(null, { status: 204 }));
      await expect(
        wrapService({ ...baseWrapOpts(chain, impl), ...patch }),
      ).rejects.toMatchObject({ name: 'AgentGateError', code });
      expect(chain.registered).toHaveLength(0);
      expect(calls).toHaveLength(0);
    });
  }

  // -------------------------------------------------------------------------
  // cleartext-token-over-http guard (live mode)
  // -------------------------------------------------------------------------

  it('rejects a cleartext-http non-localhost gateway in live mode (the admin token would leak)', async () => {
    const chain = makeFakeChain();
    const { impl, calls } = makeFakeFetch(() => new Response(null, { status: 204 }));
    await expect(
      wrapService({
        ...baseWrapOpts(chain, impl),
        gateway: 'http://gw.example:4021/',
        mode: 'live',
      }),
    ).rejects.toMatchObject({ name: 'AgentGateError', code: 'INSECURE_URL' });
    expect(chain.registered).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('allows a cleartext-http localhost gateway in live mode (token never leaves the box)', async () => {
    const chain = makeFakeChain();
    const { impl } = makeFakeFetch(() => new Response(null, { status: 204 }));
    const result = await wrapService({
      ...baseWrapOpts(chain, impl),
      gateway: 'http://localhost:4021/',
      mode: 'live',
    });
    expect(result.adminOk).toBe(true);
  });

  it('allows an https non-localhost gateway in live mode', async () => {
    const chain = makeFakeChain();
    const { impl } = makeFakeFetch(() => new Response(null, { status: 204 }));
    const result = await wrapService({
      ...baseWrapOpts(chain, impl),
      gateway: 'https://gw.example/',
      mode: 'live',
    });
    expect(result.adminOk).toBe(true);
  });

  // -------------------------------------------------------------------------
  // admin POST timeout (keeps the registration + prints the retry curl)
  // -------------------------------------------------------------------------

  it('treats an admin POST timeout as a failure: keeps the registration + retry curl', async () => {
    const chain = makeFakeChain();
    const impl = async (): Promise<Response> => {
      const err = new Error('The operation timed out.');
      err.name = 'TimeoutError';
      throw err;
    };

    const result = await wrapService({ ...baseWrapOpts(chain, impl), timeoutMs: 1 });

    expect(result.adminOk).toBe(false);
    expect(result.adminWarning).toContain('timed out');
    expect(result.adminWarning).toContain('curl -X POST');
    expect(chain.registered).toHaveLength(1); // registration untouched
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// createDemoAccounts
// ---------------------------------------------------------------------------

describe('createDemoAccounts', () => {
  it('faucets 1000 OG to two fresh mock public keys and returns export lines', async () => {
    const { impl, calls } = makeFakeFetch(() =>
      Response.json({ balanceWei: '1000000000000000000000' }),
    );

    const result = await createDemoAccounts({
      devnetUrl: 'http://localhost:4030/',
      fetchImpl: impl,
    });

    // two POST /faucet calls (buyer first, then seller)
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toBe('http://localhost:4030/faucet');
      expect(call.init?.method).toBe('POST');
      expect(bodyOf(call)['amountWei']).toBe('1000000000000000000000'); // 1000 OG in wei
    }
    expect(bodyOf(calls[0]!)['account']).toBe(result.buyer.publicKey);
    expect(bodyOf(calls[1]!)['account']).toBe(result.seller.publicKey);

    // key shape: "01" + 64 random hex chars, distinct per account
    expect(result.buyer.publicKey).toMatch(/^01[0-9a-f]{64}$/);
    expect(result.seller.publicKey).toMatch(/^01[0-9a-f]{64}$/);
    expect(result.seller.publicKey).not.toBe(result.buyer.publicKey);

    // balances + roles surfaced
    expect(result.buyer).toMatchObject({ role: 'buyer', balanceWei: '1000000000000000000000' });
    expect(result.seller).toMatchObject({ role: 'seller', balanceWei: '1000000000000000000000' });

    // export lines, exact shape
    expect(result.exportLines).toEqual([
      `export MOCK_BUYER_ACCOUNT=${result.buyer.publicKey}`,
      `export MOCK_SELLER_ACCOUNT=${result.seller.publicKey}`,
    ]);
  });

  it('rejects when the faucet answers with an error status', async () => {
    const { impl } = makeFakeFetch(() => new Response('nope', { status: 500 }));
    await expect(
      createDemoAccounts({ devnetUrl: 'http://localhost:4030', fetchImpl: impl }),
    ).rejects.toMatchObject({ code: 'FAUCET_FAILED' });
  });

  it('rejects when the faucet returns a malformed body', async () => {
    const { impl } = makeFakeFetch(() => Response.json({ balanceWei: 12345 }));
    await expect(
      createDemoAccounts({ devnetUrl: 'http://localhost:4030', fetchImpl: impl }),
    ).rejects.toMatchObject({ code: 'FAUCET_FAILED' });
  });

  it('rejects when the devnet is unreachable', async () => {
    const impl = async (): Promise<Response> => {
      throw new Error('fetch failed');
    };
    await expect(
      createDemoAccounts({ devnetUrl: 'http://localhost:4030', fetchImpl: impl }),
    ).rejects.toMatchObject({ code: 'FAUCET_UNREACHABLE' });
  });
});

// ---------------------------------------------------------------------------
// listServices / serviceStatus
// ---------------------------------------------------------------------------

describe('listServices', () => {
  it('joins services with scores and trust tiers', async () => {
    const chain = makeFakeChain();
    const scores = new Map<number, ServiceScore>([
      [1, { totalCalls: 30, successCalls: 30 }],
      [2, { totalCalls: 2, successCalls: 1 }],
    ]);
    chain.listServices = async () => [makeService(1), makeService(2)];
    chain.getScore = async (id) => scores.get(id) ?? { totalCalls: 0, successCalls: 0 };

    const listings = await listServices({ chain });
    expect(listings).toHaveLength(2);
    expect(listings[0]).toMatchObject({ tier: 'trusted', score: { totalCalls: 30 } });
    expect(listings[1]).toMatchObject({ tier: 'new', score: { totalCalls: 2 } });
    expect(listings[0]!.service.id).toBe(1);
  });
});

describe('serviceStatus', () => {
  it('returns service + score + tier + recent attestations', async () => {
    const chain = makeFakeChain();
    const attestation: AttestationRecord = {
      serviceId: 1,
      paymentTxHash: `0x${HEX64('e')}`,
      success: true,
      timestamp: 1_700_000_001_000,
      recordTxHash: `0x${HEX64('b')}`,
    };
    chain.getService = async (id) => (id === 1 ? makeService(1) : null);
    chain.getScore = async () => ({ totalCalls: 10, successCalls: 10 });
    chain.listAttestations = async () => [attestation];

    const status = await serviceStatus({ chain, id: 1 });
    expect(status.service.id).toBe(1);
    expect(status.tier).toBe('reliable');
    expect(status.attestations).toEqual([attestation]);
  });

  it('skips the attestation fetch when includeAttestations is false', async () => {
    const chain = makeFakeChain();
    chain.getService = async (id) => (id === 1 ? makeService(1) : null);
    chain.getScore = async () => ({ totalCalls: 10, successCalls: 10 });
    let listed = false;
    chain.listAttestations = async () => {
      listed = true;
      return [];
    };

    const res = await serviceStatus({ chain, id: 1, includeAttestations: false });
    expect(res.attestations).toEqual([]);
    expect(listed).toBe(false);
  });

  it('rejects unknown services with SERVICE_NOT_FOUND', async () => {
    const chain = makeFakeChain();
    await expect(serviceStatus({ chain, id: 99 })).rejects.toMatchObject({
      code: 'SERVICE_NOT_FOUND',
      httpStatus: 404,
    });
  });

  it('rejects invalid ids with INVALID_SERVICE_ID (ids are 1-based, so 0 is invalid)', async () => {
    const chain = makeFakeChain();
    for (const id of [0, -1, 1.5, Number.NaN]) {
      await expect(serviceStatus({ chain, id })).rejects.toMatchObject({
        code: 'INVALID_SERVICE_ID',
        httpStatus: 400,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// setServiceActive (pause / resume)
// ---------------------------------------------------------------------------

describe('setServiceActive', () => {
  const SET_ACTIVE_TX = `0x${HEX64('c')}`;

  /** Stateful fake: setActive mutates the stored record, getService reads it back. */
  function makeToggleChain(initialActive: boolean): {
    chain: FakeChain;
    calls: Array<{ serviceId: number; active: boolean; signer: AnySigner }>;
  } {
    const record = makeService(2, { active: initialActive });
    const calls: Array<{ serviceId: number; active: boolean; signer: AnySigner }> = [];
    const chain = makeFakeChain();
    chain.setActive = async (serviceId, active, signer) => {
      calls.push({ serviceId, active, signer });
      record.active = active;
      return { txHash: SET_ACTIVE_TX };
    };
    chain.getService = async (id) => (id === 2 ? record : null);
    return { chain, calls };
  }

  it('pause: flips active true→false and returns the tx hash + fresh record', async () => {
    const { chain, calls } = makeToggleChain(true);
    const result = await setServiceActive({ chain, signer: SIGNER, id: 2, active: false });
    expect(result.txHash).toBe(SET_ACTIVE_TX);
    expect(result.service.id).toBe(2);
    expect(result.service.active).toBe(false);
    expect(calls).toEqual([{ serviceId: 2, active: false, signer: SIGNER }]);
  });

  it('resume: flips active false→true and returns the tx hash + fresh record', async () => {
    const { chain, calls } = makeToggleChain(false);
    const result = await setServiceActive({ chain, signer: SIGNER, id: 2, active: true });
    expect(result.txHash).toBe(SET_ACTIVE_TX);
    expect(result.service.active).toBe(true);
    expect(calls).toEqual([{ serviceId: 2, active: true, signer: SIGNER }]);
  });

  it('rejects invalid ids with INVALID_SERVICE_ID without touching the chain', async () => {
    const { chain, calls } = makeToggleChain(true);
    for (const id of [0, -1, 1.5, Number.NaN]) {
      await expect(
        setServiceActive({ chain, signer: SIGNER, id, active: false }),
      ).rejects.toMatchObject({ code: 'INVALID_SERVICE_ID', httpStatus: 400 });
    }
    expect(calls).toHaveLength(0);
  });

  it('rewords the devnet 403 not_authorized into the owner-only message', async () => {
    const chain = makeFakeChain();
    chain.setActive = async () => {
      throw new AgentGateError(
        'not_authorized',
        'only the service owner may change the active flag',
        403,
      );
    };
    await expect(
      setServiceActive({ chain, signer: SIGNER, id: 2, active: false }),
    ).rejects.toMatchObject({
      name: 'AgentGateError',
      code: 'not_authorized',
      httpStatus: 403,
      message: expect.stringContaining('only the service owner can pause/resume service 2'),
    });
  });

  it('passes other chain errors through unchanged', async () => {
    const chain = makeFakeChain();
    chain.setActive = async () => {
      throw new AgentGateError('NOT_DEPLOYED', 'registry contract is not deployed', 503);
    };
    await expect(
      setServiceActive({ chain, signer: SIGNER, id: 2, active: false }),
    ).rejects.toMatchObject({ code: 'NOT_DEPLOYED', httpStatus: 503 });
  });

  it('rejects with SERVICE_NOT_FOUND when the re-fetch after set_active finds nothing', async () => {
    const chain = makeFakeChain(); // getService → null, setActive → tx hash
    await expect(
      setServiceActive({ chain, signer: SIGNER, id: 2, active: false }),
    ).rejects.toMatchObject({ code: 'SERVICE_NOT_FOUND', httpStatus: 404 });
  });
});
