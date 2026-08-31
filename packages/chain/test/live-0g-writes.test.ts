import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createPublicClient, http, toHex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { AgentGateError, type AgentGateConfig, type AnySigner } from '@agentgate/shared';
import { Live0gClient } from '../src/live-0g';

const RPC = 'http://127.0.0.1:8547';

/**
 * Anvil's deterministic dev accounts, DERIVED from its public default mnemonic
 * rather than pasted as a hex literal. The key is public and worthless, but a
 * 64-hex string in a tracked file trips secret scanners (gitleaks,
 * GitGuardian's Ethereum-key detector, trufflehog) and costs a CI failure.
 */
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
const anvilAccount = (index: number) => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index });
const anvilKey = (index: number): `0x${string}` =>
  toHex(anvilAccount(index).getHdKey().privateKey!);

const DEPLOYER = anvilKey(0);

// Anvil's default-funded accounts, one role each — none of these keys guard
// real funds; see the mnemonic note above.
const owner = anvilAccount(0);
const seller = anvilAccount(1);
const gate = anvilAccount(2);
const buyer = anvilAccount(3);

const signer: AnySigner = { kind: 'key', privateKey: DEPLOYER };
const gateSigner: AnySigner = { kind: 'key', privateKey: anvilKey(2) };
const buyerSigner: AnySigner = { kind: 'key', privateKey: anvilKey(3) };

let anvil: ChildProcess;
let client: Live0gClient;
let registryAddress: `0x${string}`;
let routerAddress: `0x${string}`;
/** A second, byte-identical PaymentRouter. Stands in for any contract that can
 *  emit a look-alike `Paid` — the only thing separating it from ours is its
 *  address, which is exactly what verifyTransfer's provenance filter checks. */
let impostorRouter: `0x${string}`;

/** Raw JSON-RPC, for the anvil-only controls viem does not expose. */
async function rpc(method: string, params: unknown[]): Promise<void> {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method} failed: ${res.status}`);
}

function deploy(name: string): `0x${string}` {
  const out = execFileSync('forge', [
    'create', `src/${name}.sol:${name}`,
    '--rpc-url', RPC, '--private-key', DEPLOYER, '--broadcast', '--json',
  ], { cwd: new URL('../../../contracts-evm', import.meta.url).pathname, encoding: 'utf8' });
  return JSON.parse(out).deployedTo as `0x${string}`;
}

function configFor(registry: string, router: string): AgentGateConfig {
  // Only the fields Live0gClient reads; the rest are irrelevant here.
  return {
    zgRpcUrl: RPC, zgChainId: 31337, zgNetwork: '0g-galileo',
    registryContractAddress: registry, paymentRouterAddress: router,
    activityLookbackBlocks: 50_000,
  } as unknown as AgentGateConfig;
}

beforeAll(async () => {
  anvil = spawn('anvil', ['--port', '8547', '--silent'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 2000));
  registryAddress = deploy('AgentGateRegistry');
  routerAddress = deploy('PaymentRouter');
  impostorRouter = deploy('PaymentRouter');
  client = new Live0gClient(configFor(registryAddress, routerAddress));
}, 60_000);

afterAll(() => { anvil?.kill(); });

describe('Live0gClient writes', () => {
  it('registerService returns the assigned 1-based id and tx hash', async () => {
    const { serviceId, txHash } = await client.registerService({
      name: 'weather', description: 'forecast', endpointUrl: 'https://gw.example',
      priceWei: '1000000000000000', paymentTarget: seller.address, attestor: gate.address,
    }, signer);
    expect(serviceId).toBe(1);
    expect(txHash).toMatch(/^0x[0-9a-f]{64}$/);
    // The registry takes the owner from msg.sender, so this pins that the write
    // was signed by the SIGNER PASSED IN — a walletFor that ignored the signer
    // (or derived the wrong account) would hand ownership to someone else.
    expect((await client.getService(serviceId))!.owner).toBe(owner.address.toLowerCase());
  });

  it('refuses a non-key signer, and never echoes key material', async () => {
    // A mock signer cannot sign a live tx — reject before touching the chain.
    await expect(
      client.setActive(1, false, { kind: 'mock', publicKey: '01deadbeef' }),
    ).rejects.toThrow(/key signer/i);

    // Anything thrown here ends up in a log line or an HTTP body, so the error
    // must be OURS (a typed invalid_signer carrying no value) rather than
    // whatever the crypto library happened to say. Asserting on our own code
    // and message is what makes this fail if the guards are removed — a laxer
    // /private key/ check would pass on viem's error too, and prove nothing.
    const wrongShape = `0x${'ab'.repeat(31)}`; // 62 hex — too short
    // Right shape, but ≥ the curve order, so it gets PAST the regex. viem's own
    // error for this one prints the scalar in decimal; ours must not.
    const outOfRange = `0x${'ff'.repeat(32)}`;

    for (const key of [wrongShape, outOfRange]) {
      const err = await client
        .setActive(1, false, { kind: 'key', privateKey: key })
        .then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(AgentGateError);
      const { code, message } = err as AgentGateError;
      expect(code).toBe('invalid_signer');
      expect(message).toContain('0x + 64 hex within the secp256k1 range');
      // Neither the raw hex nor the decimal form viem would have printed.
      expect(message).not.toContain(key.slice(2));
      expect(message).not.toContain(BigInt(key).toString());
    }
  });

  it('transfer routes through PaymentRouter and Paid is verifiable', async () => {
    const { txHash } = await client.transfer(
      { to: seller.address, amountWei: '1000000000000000', nonce: '4242', serviceId: 1 },
      buyerSigner,
    );
    const verdict = await client.verifyTransfer({
      txHash, serviceId: 1, expectedTarget: seller.address,
      minAmountWei: '1000000000000000', expectedNonce: '4242', maxAgeMs: 300_000,
    });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.amountWei).toBe('1000000000000000');
      expect(verdict.from).toBe(buyer.address.toLowerCase());
    }
  });

  it('verifyTransfer rejects the wrong target', async () => {
    const { txHash } = await client.transfer(
      { to: seller.address, amountWei: '1000000000000000', nonce: '4243', serviceId: 1 }, buyerSigner);
    const v = await client.verifyTransfer({
      txHash, serviceId: 1, expectedTarget: gate.address, minAmountWei: '1000000000000000',
      expectedNonce: '4243', maxAgeMs: 300_000 });
    expect(v).toEqual({ ok: false, reason: 'wrong_target' });
  });

  it('verifyTransfer rejects a nonce that does not match the log', async () => {
    const { txHash } = await client.transfer(
      { to: seller.address, amountWei: '1000000000000000', nonce: '4244', serviceId: 1 }, buyerSigner);
    const v = await client.verifyTransfer({
      txHash, serviceId: 1, expectedTarget: seller.address, minAmountWei: '1000000000000000',
      expectedNonce: '9999', maxAgeMs: 300_000 });
    expect(v).toEqual({ ok: false, reason: 'wrong_nonce' });
  });

  it('verifyTransfer rejects a payment made for a DIFFERENT service', async () => {
    // Same nonce, same payTo, different serviceId. PaymentRouter allows this
    // (seenNonce is keyed per service) and payment targets are shared across
    // services, so only the serviceId topic separates the two.
    const { txHash } = await client.transfer(
      { to: seller.address, amountWei: '1000000000000000', nonce: '7777', serviceId: 2 }, buyerSigner);
    const v = await client.verifyTransfer({
      txHash, serviceId: 1, expectedTarget: seller.address,
      minAmountWei: '1000000000000000', expectedNonce: '7777', maxAgeMs: 300_000 });
    expect(v).toEqual({ ok: false, reason: 'wrong_nonce' });
  });

  it('verifyTransfer rejects an underpayment', async () => {
    const { txHash } = await client.transfer(
      { to: seller.address, amountWei: '1000000000000000', nonce: '4245', serviceId: 1 }, buyerSigner);
    const v = await client.verifyTransfer({
      txHash, serviceId: 1, expectedTarget: seller.address, minAmountWei: '2000000000000000',
      expectedNonce: '4245', maxAgeMs: 300_000 });
    expect(v).toEqual({ ok: false, reason: 'amount_too_low' });
  });

  it('verifyTransfer reports pending for an unmined hash, not not_found', async () => {
    const v = await client.verifyTransfer({
      txHash: `0x${'ff'.repeat(32)}`, serviceId: 1, expectedTarget: seller.address,
      minAmountWei: '1', expectedNonce: '1', maxAgeMs: 300_000 });
    expect(v).toEqual({ ok: false, reason: 'pending' });
  });

  it('verifyTransfer rejects a payment older than maxAgeMs', async () => {
    const { txHash } = await client.transfer(
      { to: seller.address, amountWei: '1000000000000000', nonce: '4246', serviceId: 1 }, buyerSigner);
    const v = await client.verifyTransfer({
      txHash, serviceId: 1, expectedTarget: seller.address, minAmountWei: '1000000000000000',
      expectedNonce: '4246', maxAgeMs: 0 });
    expect(v).toEqual({ ok: false, reason: 'expired' });
  });

  it('recordAttestation bumps the on-chain score', async () => {
    const { txHash } = await client.transfer(
      { to: seller.address, amountWei: '1000000000000000', nonce: '4247', serviceId: 1 }, buyerSigner);
    await client.recordAttestation({ serviceId: 1, paymentTxHash: txHash, success: true }, gateSigner);
    await expect(client.getScore(1)).resolves.toEqual({ totalCalls: 1, successCalls: 1 });
  });

  it('listAttestations fills recordTxHash from the AttestationRecorded log', async () => {
    // The registry CANNOT store the hash of the transaction that wrote the
    // attestation — a contract does not know its own tx hash. So the read path
    // has to join the log, and if it does not, every live attestation comes
    // back with recordTxHash: '' while mock mode returns a real hash. That gap
    // is invisible offline: the CLI prints a dangling "tx ", the dashboard
    // renders a link to nowhere, and the row list keyed by this field collapses
    // to one repeated key.
    const { txHash: payTx } = await client.transfer(
      { to: seller.address, amountWei: '1000000000000000', nonce: '5150', serviceId: 1 }, buyerSigner);
    const { txHash: attestTx } = await client.recordAttestation(
      { serviceId: 1, paymentTxHash: payTx, success: true }, gateSigner);

    const [latest] = await client.listAttestations(1, 1);
    expect(latest).toBeDefined();
    expect(latest!.paymentTxHash).toBe(payTx);
    expect(latest!.recordTxHash).toBe(attestTx);
    expect(latest!.recordTxHash).toMatch(/^0x[0-9a-f]{64}$/i);
  });

  it('setActive toggles the discovery flag', async () => {
    await client.setActive(1, false, signer);
    expect((await client.getService(1))!.active).toBe(false);
    await client.setActive(1, true, signer);
    expect((await client.getService(1))!.active).toBe(true);
  });

  it('verifyTransfer rejects a Paid log emitted by a DIFFERENT router', async () => {
    // The impostor is a real PaymentRouter at another address: same event
    // signature, same topics, real value actually moved to the seller. Every
    // field verifyTransfer looks at matches; only the EMITTING ADDRESS differs.
    // Without the provenance filter this is a free-service bypass — and a
    // contract that pays nothing at all could emit the very same log.
    const impostor = new Live0gClient(configFor(registryAddress, impostorRouter));
    const { txHash } = await impostor.transfer(
      { to: seller.address, amountWei: '1000000000000000', nonce: '5150', serviceId: 1 },
      buyerSigner,
    );
    const v = await client.verifyTransfer({
      txHash, serviceId: 1, expectedTarget: seller.address,
      minAmountWei: '1000000000000000', expectedNonce: '5150', maxAgeMs: 300_000 });
    expect(v).toEqual({ ok: false, reason: 'not_found' });

    // Control: the very same payment DOES verify against the router that
    // emitted it, so the rejection above is provenance and nothing else.
    await expect(impostor.verifyTransfer({
      txHash, serviceId: 1, expectedTarget: seller.address,
      minAmountWei: '1000000000000000', expectedNonce: '5150', maxAgeMs: 300_000 }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('verifyTransfer rejects a malformed tx hash as not_found, not pending', async () => {
    // A malformed hash can never become valid, so 'pending' would
    // invite a buyer to hold one invoice open forever on a hash that will never
    // settle; 'not_found' is terminal and the middleware issues a fresh invoice.
    const v = await client.verifyTransfer({
      txHash: 'not-a-hash', serviceId: 1, expectedTarget: seller.address,
      minAmountWei: '1', expectedNonce: '1', maxAgeMs: 300_000 });
    expect(v).toEqual({ ok: false, reason: 'not_found' });
  });

  it('verifyTransfer propagates an RPC outage instead of calling it pending', async () => {
    // 'pending' is a promise that retrying the identical proof may work. An
    // unreachable node is not that: mapping it to 'pending' answers every buyer
    // "402 settlement_pending, retry in 2s" for the whole outage, and nothing
    // in logs or metrics distinguishes that from ordinary settlement lag.
    const unreachable = new Live0gClient({
      ...configFor(registryAddress, routerAddress),
      zgRpcUrl: 'http://127.0.0.1:8598', // nothing listens here
    });
    await expect(unreachable.verifyTransfer({
      txHash: `0x${'ff'.repeat(32)}`, serviceId: 1, expectedTarget: seller.address,
      minAmountWei: '1', expectedNonce: '1', maxAgeMs: 300_000 }),
    ).rejects.toThrow();
  }, 20_000);

  it('recordAttestation is an idempotent no-op when the payment is already attested', async () => {
    // THE invariant the durable attestation queue is built on. It replays
    // unconfirmed entries on every boot and drops one only once the attempt
    // confirms (attestation-queue.ts:9-13, app.ts replayPendingAttestations),
    // "safe because the registry contract dedups by (service_id,
    // payment_tx_hash)". If a replay of an already-recorded attestation threw,
    // the entry would never be dropped: replayed next boot, and the next,
    // burning gas forever — a poison pill in the crash-recovery path.
    const { txHash } = await client.transfer(
      { to: seller.address, amountWei: '1000000000000000', nonce: '4249', serviceId: 1 },
      buyerSigner,
    );
    const input = { serviceId: 1, paymentTxHash: txHash, success: true };
    await client.recordAttestation(input, gateSigner);
    const scored = await client.getScore(1);

    // Replay the exact same (serviceId, paymentTxHash), as a boot would.
    await expect(client.recordAttestation(input, gateSigner)).resolves.toBeDefined();
    // Counted ONCE. The replay must be a no-op on-chain, not a second score.
    await expect(client.getScore(1)).resolves.toEqual(scored);
  });

  it('recordAttestation still throws for a revert that is not a duplicate', async () => {
    // The idempotency exemption is narrow: only DuplicateAttestation means "the
    // end state already holds". An unauthorised caller is a real failure and
    // must still reach the middleware, which keeps the entry queued.
    const stranger: AnySigner = { kind: 'key', privateKey: anvilKey(5) };
    const before = await client.getScore(1);
    await expect(client.recordAttestation(
      { serviceId: 1, paymentTxHash: `0x${'7e'.repeat(32)}`, success: true }, stranger,
    )).rejects.toThrow(/NotAuthorized/);
    await expect(client.getScore(1)).resolves.toEqual(before);
  });

  it('recordAttestation is idempotent even when the duplicate LOSES A RACE', async () => {
    // The post-flight half of the same invariant. Automine off puts both writes
    // in one block: each clears estimation against a state where the payment is
    // unattested, so both are sent and one reverts on execution — where the
    // receipt carries no reason. Two different authorised senders (attestor and
    // owner) so the txs do not collide on one account's nonce.
    const { txHash } = await client.transfer(
      { to: seller.address, amountWei: '1000000000000000', nonce: '4250', serviceId: 1 },
      buyerSigner,
    );
    const input = { serviceId: 1, paymentTxHash: txHash, success: true };
    const before = await client.getScore(1);

    await rpc('evm_setAutomine', [false]);
    let results: PromiseSettledResult<{ txHash: string }>[];
    try {
      const inflight = Promise.allSettled([
        client.recordAttestation(input, gateSigner),
        client.recordAttestation(input, signer),
      ]);
      await new Promise((r) => setTimeout(r, 500)); // let both reach the pool
      await rpc('evm_mine', []);
      results = await inflight;
    } finally {
      await rpc('evm_setAutomine', [true]);
    }

    // BOTH resolve — the loser's revert is a no-op, not a failure...
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    // ...and the payment was still scored exactly once.
    await expect(client.getScore(1)).resolves.toEqual({
      totalCalls: before.totalCalls + 1, successCalls: before.successCalls + 1,
    });
  }, 30_000);

  it('transfer surfaces an on-chain revert instead of reporting success', async () => {
    // settled() must still throw for a revert with no idempotency exemption.
    // Same one-block race, but on PaymentRouter: two pays for the same
    // (serviceId, nonce), both clearing estimation, one reverting DuplicateNonce.
    // Unlike a duplicate attestation this is a real failure — the loser's own
    // money never moved, so reporting success would invent a payment.
    await rpc('evm_setAutomine', [false]);
    let results: PromiseSettledResult<{ txHash: string }>[];
    try {
      const pay = (s: AnySigner) => client.transfer(
        { to: seller.address, amountWei: '1000000000000000', nonce: '6060', serviceId: 1 }, s);
      const inflight = Promise.allSettled([pay(buyerSigner), pay(signer)]);
      await new Promise((r) => setTimeout(r, 500));
      await rpc('evm_mine', []);
      results = await inflight;
    } finally {
      await rpc('evm_setAutomine', [true]);
    }

    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as AgentGateError;
    expect(reason).toBeInstanceOf(AgentGateError);
    expect(reason.code).toBe('TX_FAILED');
    expect(reason.message).toMatch(/transfer reverted on-chain/);
  }, 30_000);
});

// Runs LAST on purpose: it reads back the whole history the suite above wrote —
// one registration, ten router payments (one of them for service 2) and three
// attestations.
describe('listRecentActivity', () => {
  it('joins registrations, payments and attestations newest-first', async () => {
    const feed = await client.listRecentActivity(50);
    const kinds = new Set(feed.map((e) => e.kind));
    expect(kinds.has('service_registered')).toBe(true);
    expect(kinds.has('payment')).toBe(true);
    expect(kinds.has('attestation')).toBe(true);

    // newest first
    for (let i = 1; i < feed.length; i++) {
      expect(feed[i - 1]!.timestamp).toBeGreaterThanOrEqual(feed[i]!.timestamp);
    }

    const payment = feed.find((e) => e.kind === 'payment')!;
    expect(payment.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(payment.serviceId).toBe(1);
    expect(payment.amountWei).toBe('1000000000000000');
    expect(payment.detail).toContain('OG');

    const reg = feed.find((e) => e.kind === 'service_registered')!;
    expect(reg.detail).toContain('weather');
  });

  it('takes each payment\'s serviceId from its own Paid event', async () => {
    // The suite paid service 2 exactly once (nonce 7777) against the same
    // payTo as every service-1 payment. A bare transfer would carry no service
    // id to attribute it by; `Paid` carries one, so a feed that guessed — or
    // copied the newest payment's id onto all of them — would show 2 as 1 here.
    const feed = await client.listRecentActivity(50);
    const payments = feed.filter((e) => e.kind === 'payment');
    expect(payments.filter((e) => e.serviceId === 2)).toHaveLength(1);
    expect(payments.filter((e) => e.serviceId === 1).length).toBeGreaterThan(1);
  });

  it('reports timestamps in MILLISECONDS, not block seconds', async () => {
    // `block.timestamp` is seconds; every ActivityEvent.timestamp is ms. A
    // missing ×1000 lands these events in 1970 and silently reorders the
    // dashboard feed against the contracts' own already-ms values.
    const feed = await client.listRecentActivity(50);
    for (const event of feed) {
      expect(Math.abs(Date.now() - event.timestamp)).toBeLessThan(600_000);
    }
  });

  it('bounds the lookback to activityLookbackBlocks', async () => {
    // Public RPCs cap getLogs ranges and `fromBlock: 0` fails outright on a
    // live chain, so the window must be bounded — with a one-block lookback
    // this must see strictly less than the full history.
    const narrow = new Live0gClient({
      ...configFor(registryAddress, routerAddress),
      activityLookbackBlocks: 1,
    });
    const all = await client.listRecentActivity(50);
    expect((await narrow.listRecentActivity(50)).length).toBeLessThan(all.length);
  });

  it('honours the limit', async () => {
    expect((await client.listRecentActivity(2))).toHaveLength(2);
  });

  it('reads block headers only for the page it returns', async () => {
    // Timestamps are the one field that costs an extra round-trip, so paging
    // has to happen BEFORE they are resolved. Resolving first would fire one
    // concurrent getBlock per event-bearing block across the whole 50 000-block
    // window — an unbounded burst against a public RPC's rate limit, hiding
    // behind a request for two items. Counting the calls is the only way to see
    // it: the returned feed looks identical either way.
    const original = globalThis.fetch;
    let getBlockCalls = 0;
    globalThis.fetch = (...args: Parameters<typeof fetch>) => {
      const body = args[1]?.body;
      if (typeof body === 'string' && body.includes('eth_getBlockByNumber')) getBlockCalls++;
      return original(...args);
    };
    try {
      expect(await client.listRecentActivity(2)).toHaveLength(2);
    } finally {
      globalThis.fetch = original;
    }
    // At most one per distinct block on the page — never one per block in the
    // window (the suite above has left well over two of those behind).
    expect(getBlockCalls).toBeLessThanOrEqual(2);
  });

  it('orders events WITHIN one block by log index, not by kind', async () => {
    // Every event in a block shares one timestamp, so a sort on timestamp alone
    // cannot separate them and silently falls back to insertion order — which
    // groups all attestations above all payments regardless of what actually
    // happened first. `logIndex` is the chain's own answer and is monotonic
    // within a block, so it is correct by construction rather than by luck.
    const seed = await client.transfer(
      { to: seller.address, amountWei: '1000000000000000', nonce: '8801', serviceId: 1 },
      buyerSigner,
    );

    // THREE events in ONE block: two payments (router) and one attestation
    // (registry), each from a different sender so the txs do not collide on a
    // single account's nonce. Two payments is what makes this discriminating
    // rather than lucky — `getLogs` hands them back OLDEST-first, so any sort
    // that falls through to insertion order puts them in the wrong order no
    // matter how the block happens to be arranged.
    await rpc('evm_setAutomine', [false]);
    let hashes: string[];
    try {
      const inflight = Promise.all([
        client.recordAttestation(
          { serviceId: 1, paymentTxHash: seed.txHash, success: true }, gateSigner,
        ),
        client.transfer(
          { to: seller.address, amountWei: '1000000000000000', nonce: '8802', serviceId: 1 },
          buyerSigner,
        ),
        client.transfer(
          { to: seller.address, amountWei: '1000000000000000', nonce: '8803', serviceId: 1 },
          signer,
        ),
      ]);
      await new Promise((r) => setTimeout(r, 500)); // let all three reach the pool
      await rpc('evm_mine', []);
      hashes = (await inflight).map((r) => r.txHash);
    } finally {
      await rpc('evm_setAutomine', [true]);
    }

    // The oracle is the chain, read independently of the feed: each of these
    // txs emits exactly one relevant log, so ordering them by transactionIndex
    // IS ordering them by logIndex — and newest-first means descending.
    const pub = createPublicClient({ transport: http(RPC) });
    const receipts = await Promise.all(
      hashes.map((h) => pub.getTransactionReceipt({ hash: h as `0x${string}` })),
    );
    const block = receipts[0]!.blockNumber;
    expect(receipts.every((r) => r.blockNumber === block)).toBe(true); // the premise
    const expected = [...receipts]
      .sort((a, b) => b.transactionIndex - a.transactionIndex)
      .map((r) => r.transactionHash as string);

    const feed = await client.listRecentActivity(50);
    const seen = feed.filter((e) => hashes.includes(e.txHash)).map((e) => e.txHash);
    expect(seen).toEqual(expected);
  }, 30_000);
});
