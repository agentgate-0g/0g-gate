import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveAccountAddress, startServer } from '@agentgate/devnet';
import type { RunningServer } from '@agentgate/devnet';
import { AgentGateError, loadConfig } from '@agentgate/shared';
import type { ChainClient, RegisterServiceInput, SignerRef } from '@agentgate/shared';
import {
  Live0gClient,
  MockChainHttpClient,
  createChainClient,
  isAddress,
  mockAccountAddress,
} from '../src/index';

const OWNER: SignerRef = { kind: 'mock', publicKey: '01aa11'.padEnd(66, '0') };
const ATTESTOR: SignerRef = { kind: 'mock', publicKey: '01bb22'.padEnd(66, '0') };
const BUYER: SignerRef = { kind: 'mock', publicKey: '01cc33'.padEnd(66, '0') };
const STRANGER: SignerRef = { kind: 'mock', publicKey: '01dd44'.padEnd(66, '0') };

const GATEWAY = 'http://localhost:4021';
const PRICE = '500000000000000000'; // 0.5 OG
const SELLER_TARGET = mockAccountAddress('01ee55'.padEnd(66, '0'));

let server: RunningServer;
let base: string;
let chain: ChainClient;

function registerInput(overrides: Partial<RegisterServiceInput> = {}): RegisterServiceInput {
  return {
    name: 'USD/IDR Feed',
    description: 'Spot USD/IDR with confidence',
    endpointUrl: GATEWAY,
    priceWei: PRICE,
    paymentTarget: SELLER_TARGET,
    attestor: mockAccountAddress(ATTESTOR.publicKey),
    ...overrides,
  };
}

async function faucet(account: string, amountWei: string): Promise<void> {
  const res = await fetch(`${base}/faucet`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account, amountWei }),
  });
  expect(res.status).toBe(200);
  await res.json();
}

async function expectAgentGateError(
  promise: Promise<unknown>,
  code: string,
  httpStatus: number,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AgentGateError);
  const err = caught as AgentGateError;
  expect(err.code).toBe(code);
  expect(err.httpStatus).toBe(httpStatus);
}

beforeAll(async () => {
  server = await startServer({ port: 0 });
  base = `http://127.0.0.1:${server.port}`;
  chain = createChainClient(loadConfig({ AGENTGATE_MODE: 'mock', DEVNET_URL: base }));
});

afterAll(async () => {
  await server.close();
});

describe('mockAccountAddress', () => {
  it('derives a well-formed EVM address deterministically', () => {
    const a = mockAccountAddress('buyer-key');
    expect(isAddress(a)).toBe(true);
    expect(a).toBe(mockAccountAddress('buyer-key'));
    expect(a).not.toBe(mockAccountAddress('seller-key'));
  });

  it('is lowercase, matching normalizeAddress output', () => {
    expect(mockAccountAddress('x')).toBe(mockAccountAddress('x').toLowerCase());
  });

  it('rejects an empty public key', () => {
    expect(() => mockAccountAddress('')).toThrowError(AgentGateError);
    expect(() => mockAccountAddress('   ')).toThrowError(AgentGateError);
  });

  // The devnet cannot import @agentgate/chain (chain depends on devnet), so the
  // derivation is written out twice. If the two ever drift, mock mode breaks in
  // the worst possible way — silently, with every balance, payment target and
  // authorization check landing on a different identity than the one the client
  // computed. This is the only thing pinning them together.
  it('matches the devnet\'s own deriveAccountAddress byte for byte', () => {
    for (const key of [BUYER.publicKey, OWNER.publicKey, 'someone-else', '0']) {
      expect(mockAccountAddress(key)).toBe(deriveAccountAddress(key));
    }
  });
});

describe('createChainClient', () => {
  it('selects MockChainHttpClient in mock mode', () => {
    expect(chain).toBeInstanceOf(MockChainHttpClient);
    expect(chain.network).toBe('mock');
  });

  it('selects Live0gClient in live mode', () => {
    // The only thing pinning that each mode gets the right backend. Note the
    // config carries no contract addresses: constructing the live client must
    // not need a deployment — every contract-dependent path resolves its
    // address lazily and throws CONTRACT_NOT_DEPLOYED there, not here.
    const live = createChainClient(
      loadConfig({
        AGENTGATE_MODE: 'live',
        AGENTGATE_ADMIN_TOKEN: 'strong-token-for-tests',
      }),
    );
    expect(live).toBeInstanceOf(Live0gClient);
    expect(live.network).toBe('0g-galileo');
  });
});

describe('MockChainHttpClient — full surface against an in-process devnet', () => {
  let serviceId: number;
  let txHash: string;
  const nonce = '987654321';

  it('registerService returns the id and tx hash; reads see the computed endpointUrl', async () => {
    const result = await chain.registerService(registerInput(), OWNER);
    expect(result.serviceId).toBeGreaterThanOrEqual(1);
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    serviceId = result.serviceId;

    const record = await chain.getService(serviceId);
    expect(record).not.toBeNull();
    expect(record).toMatchObject({
      id: serviceId,
      name: 'USD/IDR Feed',
      endpointUrl: `${GATEWAY}/svc/${serviceId}`,
      priceWei: PRICE,
      paymentTarget: SELLER_TARGET,
      // The registry stores ADDRESSES, not signer public keys — the same shape
      // live mode reads back from the contract.
      owner: mockAccountAddress(OWNER.publicKey),
      attestor: mockAccountAddress(ATTESTOR.publicKey),
      active: true,
    });
    expect(isAddress(record!.owner)).toBe(true);
    expect(isAddress(record!.attestor)).toBe(true);
    expect(isAddress(record!.paymentTarget)).toBe(true);

    const all = await chain.listServices();
    expect(all.some((s) => s.id === serviceId)).toBe(true);
  });

  it('getService returns null for unknown ids', async () => {
    expect(await chain.getService(424242)).toBeNull();
  });

  it('rejects a price below the contract floor and accepts exactly the floor', async () => {
    // Mirrors AgentGateRegistry's own test_registerService_revertsBelowMinPrice /
    // test_registerService_acceptsExactlyMinPrice pair. A mock floor looser than
    // the contract's would accept a service the real chain rejects — a green
    // local run that dies on the first live registration.
    await expectAgentGateError(
      chain.registerService(registerInput({ priceWei: '999999999999' }), OWNER), // 1e12 - 1
      'invalid_price',
      400,
    );
    const ok = await chain.registerService(
      registerInput({ priceWei: '1000000000000' }), // exactly 1e12
      OWNER,
    );
    expect((await chain.getService(ok.serviceId))?.priceWei).toBe('1000000000000');
  });

  it('getBalance + transfer move wei and verifyTransfer accepts the payment', async () => {
    const buyerAccount = mockAccountAddress(BUYER.publicKey);
    await faucet(buyerAccount, '1000000000000000000');
    expect(await chain.getBalance(buyerAccount)).toBe('1000000000000000000');

    const result = await chain.transfer(
      { to: SELLER_TARGET, amountWei: PRICE, nonce, serviceId },
      BUYER,
    );
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    txHash = result.txHash;

    expect(await chain.getBalance(buyerAccount)).toBe('500000000000000000');
    expect(BigInt(await chain.getBalance(SELLER_TARGET))).toBeGreaterThanOrEqual(BigInt(PRICE));

    const verdict = await chain.verifyTransfer({
      txHash,
      serviceId,
      expectedTarget: SELLER_TARGET,
      minAmountWei: PRICE,
      expectedNonce: nonce,
      maxAgeMs: 60_000,
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.amountWei).toBe(PRICE);
      // `from` is the payer ADDRESS — what isSelfPayment compares against the
      // service's owner/paymentTarget.
      expect(verdict.from).toBe(buyerAccount);
      expect(typeof verdict.timestamp).toBe('number');
    }
  });

  it('transfer surfaces insufficient_balance as a 400 AgentGateError', async () => {
    await expectAgentGateError(
      chain.transfer(
        { to: SELLER_TARGET, amountWei: '999999999999999999999999', nonce: '1', serviceId },
        BUYER,
      ),
      'insufficient_balance',
      400,
    );
  });

  it('recordAttestation bumps the score and lists newest first', async () => {
    const result = await chain.recordAttestation(
      { serviceId, paymentTxHash: txHash, success: true },
      ATTESTOR,
    );
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    expect(await chain.getScore(serviceId)).toEqual({ totalCalls: 1, successCalls: 1 });

    await chain.recordAttestation(
      { serviceId, paymentTxHash: 'f'.repeat(64), success: false },
      OWNER, // owner is also authorized
    );
    expect(await chain.getScore(serviceId)).toEqual({ totalCalls: 2, successCalls: 1 });

    const attestations = await chain.listAttestations(serviceId);
    expect(attestations).toHaveLength(2);
    expect(attestations[0]?.paymentTxHash).toBe('f'.repeat(64));
    expect(attestations[1]).toMatchObject({
      serviceId,
      paymentTxHash: txHash,
      success: true,
    });
    expect(await chain.listAttestations(serviceId, 1)).toHaveLength(1);
  });

  it('rejects stranger attestations (403)', async () => {
    await expectAgentGateError(
      chain.recordAttestation({ serviceId, paymentTxHash: '9'.repeat(64), success: true }, STRANGER),
      'not_authorized',
      403,
    );
  });

  it('replaying an already-recorded attestation RESOLVES and leaves the score alone', async () => {
    // The durable queue drops an entry only once its attempt resolves and
    // replays whatever is left on every boot, so a rejected replay is retried
    // forever — every restart, no progress. The live client already reports a
    // DuplicateAttestation revert as success; mock mode must match.
    const before = await chain.getScore(serviceId);

    const replay = await chain.recordAttestation(
      { serviceId, paymentTxHash: txHash, success: true },
      ATTESTOR,
    );
    // Empty hash = "nothing submitted, it was already on-chain" (live parity).
    expect(replay.txHash).toBe('');

    expect(await chain.getScore(serviceId)).toEqual(before);
    // …and no second attestation row was appended.
    const rows = await chain.listAttestations(serviceId, 100);
    expect(rows.filter((a) => a.paymentTxHash === txHash)).toHaveLength(1);
  });

  it('setActive is owner-only and inactive services reject attestations', async () => {
    await expectAgentGateError(chain.setActive(serviceId, false, STRANGER), 'not_authorized', 403);

    const result = await chain.setActive(serviceId, false, OWNER);
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await chain.getService(serviceId))?.active).toBe(false);

    await expectAgentGateError(
      chain.recordAttestation({ serviceId, paymentTxHash: '8'.repeat(64), success: true }, ATTESTOR),
      'service_inactive',
      400,
    );

    await chain.setActive(serviceId, true, OWNER);
    expect((await chain.getService(serviceId))?.active).toBe(true);
  });

  it('listRecentActivity returns newest-first events covering the whole loop', async () => {
    const activity = await chain.listRecentActivity(100);
    expect(activity.length).toBeGreaterThanOrEqual(4);
    const timestamps = activity.map((e) => e.timestamp);
    expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps);
    const kinds = new Set(activity.map((e) => e.kind));
    expect(kinds.has('service_registered')).toBe(true);
    expect(kinds.has('payment')).toBe(true);
    expect(kinds.has('attestation')).toBe(true);

    // A payment carries the service id it settled, like PaymentRouter.Paid's
    // indexed topic — never guessed from the shared payout target.
    const payment = activity.find((e) => e.kind === 'payment' && e.txHash === txHash);
    expect(payment?.serviceId).toBe(serviceId);
    expect(payment?.amountWei).toBe(PRICE);

    const limited = await chain.listRecentActivity(2);
    expect(limited).toHaveLength(2);
  });

  it('rejects non-mock signers', async () => {
    await expectAgentGateError(
      chain.transfer(
        { to: SELLER_TARGET, amountWei: '1000000000000', nonce: '5', serviceId },
        { kind: 'key', privateKey: `0x${'11'.repeat(32)}` },
      ),
      'invalid_signer',
      400,
    );
  });
});

describe('MockChainHttpClient.verifyTransfer — every failure reason', () => {
  let txHash: string;
  let serviceId: number;
  let otherServiceId: number;
  const nonce = '777000777';

  beforeAll(async () => {
    serviceId = (await chain.registerService(registerInput(), OWNER)).serviceId;
    otherServiceId = (await chain.registerService(registerInput(), OWNER)).serviceId;
    await faucet(mockAccountAddress(BUYER.publicKey), '10000000000000000000');
    txHash = (
      await chain.transfer({ to: SELLER_TARGET, amountWei: PRICE, nonce, serviceId }, BUYER)
    ).txHash;
  });

  it('not_found for unknown tx hashes', async () => {
    const verdict = await chain.verifyTransfer({
      txHash: '1'.repeat(64),
      serviceId,
      expectedTarget: SELLER_TARGET,
      minAmountWei: PRICE,
      expectedNonce: nonce,
      maxAgeMs: 60_000,
    });
    expect(verdict).toEqual({ ok: false, reason: 'not_found' });
  });

  it('wrong_target when the transfer went elsewhere (checked before everything else)', async () => {
    const verdict = await chain.verifyTransfer({
      txHash,
      serviceId,
      expectedTarget: mockAccountAddress('someone-else'),
      minAmountWei: '999999999999999999999', // also too low — target must win the ordering
      expectedNonce: nonce,
      maxAgeMs: 60_000,
    });
    expect(verdict).toEqual({ ok: false, reason: 'wrong_target' });
  });

  it('wrong_nonce when the nonce does not match', async () => {
    const verdict = await chain.verifyTransfer({
      txHash,
      serviceId,
      expectedTarget: SELLER_TARGET,
      minAmountWei: PRICE,
      expectedNonce: '123',
      maxAgeMs: 60_000,
    });
    expect(verdict).toEqual({ ok: false, reason: 'wrong_nonce' });
  });

  it('wrong_nonce when the nonce matches but the SERVICE does not', async () => {
    // A nonce is unique only per service (PaymentRouter.seenNonce is keyed on
    // the pair) and payment targets are shared across services here, so without
    // the service-id half a payment for one service would settle another's
    // invoice — target, amount and nonce all check out.
    const verdict = await chain.verifyTransfer({
      txHash,
      serviceId: otherServiceId,
      expectedTarget: SELLER_TARGET,
      minAmountWei: PRICE,
      expectedNonce: nonce,
      maxAgeMs: 60_000,
    });
    expect(verdict).toEqual({ ok: false, reason: 'wrong_nonce' });
  });

  it('amount_too_low when the paid amount is below the minimum', async () => {
    const verdict = await chain.verifyTransfer({
      txHash,
      serviceId,
      expectedTarget: SELLER_TARGET,
      minAmountWei: (BigInt(PRICE) + 1n).toString(),
      expectedNonce: nonce,
      maxAgeMs: 60_000,
    });
    expect(verdict).toEqual({ ok: false, reason: 'amount_too_low' });
  });

  it('expired when the transfer is older than maxAgeMs', async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    const verdict = await chain.verifyTransfer({
      txHash,
      serviceId,
      expectedTarget: SELLER_TARGET,
      minAmountWei: PRICE,
      expectedNonce: nonce,
      maxAgeMs: 5,
    });
    expect(verdict).toEqual({ ok: false, reason: 'expired' });
  });

  // 'pending' is unreachable in mock mode: devnet transfers settle synchronously
  // in the same request. The live client maps still-settling txs to it.

  it('throws invalid_query on malformed queries instead of guessing', async () => {
    await expectAgentGateError(
      chain.verifyTransfer({
        txHash,
        serviceId,
        expectedTarget: SELLER_TARGET,
        minAmountWei: '1.5',
        expectedNonce: nonce,
        maxAgeMs: 60_000,
      }),
      'invalid_query',
      400,
    );
  });
});

describe('Live0gClient — CONTRACT_NOT_DEPLOYED guard (no registry address configured)', () => {
  // The address is blanked EXPLICITLY rather than left to the default: since
  // the contracts were deployed, DEFAULT_REGISTRY_ADDRESS is a real address, so
  // relying on the default here would silently stop exercising the guard and
  // start pointing the test at live 0G. This is the shape of a self-hosted
  // gateway configured with a blank address — the case the guard exists for.
  // The middleware maps this code to 503 (a configuration outage the operator
  // can fix) rather than the generic 500 an RPC error becomes, so every read
  // has to reach it.
  // Overridden on the config OBJECT, not through env: `readStr` treats a blank
  // env value as unset and falls back to the default, and since the deploy that
  // default is a real address — so no environment can produce this state any
  // more. A consumer still can (anything that builds an AgentGateConfig itself),
  // which is exactly what this guards.
  const live = new Live0gClient({
    ...loadConfig({ AGENTGATE_MODE: 'live', AGENTGATE_ADMIN_TOKEN: 'strong-token-for-tests' }),
    registryContractAddress: '',
    paymentRouterAddress: '',
  });

  const expectNotDeployed = (promise: Promise<unknown>) =>
    expectAgentGateError(promise, 'CONTRACT_NOT_DEPLOYED', 503);

  it('throws 503 from every registry-dependent read, before any RPC call', async () => {
    // No mocking and no network: an unset address is resolved BEFORE the
    // transport is touched. If a path ever reordered that, this test would hang
    // on the real 0G Galileo RPC instead of failing — which is the point of
    // asserting it here rather than trusting the ordering by eye.
    await expectNotDeployed(live.getService(1));
    await expectNotDeployed(live.listServices());
    await expectNotDeployed(live.getScore(1));
    await expectNotDeployed(live.listAttestations(1));
    await expectNotDeployed(live.listRecentActivity());
  });
});
