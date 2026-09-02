import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPublicClient, createWalletClient, http, toHex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import type { AgentGateConfig, AnySigner } from '@agentgate/shared';
import { Live0gClient } from '../src/live-0g';
import { REGISTRY_ABI } from '../src/abi';

// Port is overridable: a hardcoded one collides with whatever else the
// machine happens to be running, and the failure (`balance 0`) looks like a
// contract bug rather than a busy port.
const ANVIL_PORT = process.env.ANVIL_PORT_CONCURRENCY ?? '8548';
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;

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
const CHAIN = { id: 31337, name: 'anvil', nativeCurrency: { name: 'OG', symbol: 'OG', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } as const;

// One role each; the registry refuses a service whose attestor is its own owner
// or its payout address, so these have to be three distinct accounts.
const owner = anvilAccount(0);
const seller = anvilAccount(1);
const gate = anvilAccount(2);
const buyer = anvilAccount(3);

const signer: AnySigner = { kind: 'key', privateKey: DEPLOYER };
const gateSigner: AnySigner = { kind: 'key', privateKey: anvilKey(2) };
const buyerSigner: AnySigner = { kind: 'key', privateKey: anvilKey(3) };

const PRICE = '1000000000000000';

/**
 * Mirrors MAX_LISTED_SERVICES in src/live-0g.ts. Deliberately duplicated rather
 * than imported: the cap is a product decision about what an anonymous catalog
 * request may cost, so changing it should have to change a test too.
 */
const CATALOG_CAP = 200;

let anvil: ChildProcess;
/** The catalog registry: a handful of services, read through the RPC proxy. */
let registryAddress: `0x${string}`;
/** A SECOND registry, loaded past the cap. Separate so the small one stays small. */
let bigRegistry: `0x${string}`;
let routerAddress: `0x${string}`;
let client: Live0gClient;

/**
 * A counting JSON-RPC proxy in front of anvil.
 *
 * Both defects here are about CALL VOLUME — a burst of attestations that must
 * not collide on one nonce, and an anonymous catalog read that must not fan out
 * one eth_call per registered service. Asserting on the returned values alone
 * cannot see either, so the tests that care count what actually left the
 * process.
 */
let proxy: Server;
let proxyUrl: string;
let rpcLog: string[] = [];

function deploy(name: string, ...ctorArgs: string[]): `0x${string}` {
  const out = execFileSync('forge', [
    'create', `src/${name}.sol:${name}`,
    '--rpc-url', RPC, '--private-key', DEPLOYER, '--broadcast', '--json',
    ...(ctorArgs.length ? ['--constructor-args', ...ctorArgs] : []),
  ], { cwd: new URL('../../../contracts-evm', import.meta.url).pathname, encoding: 'utf8' });
  return JSON.parse(out).deployedTo as `0x${string}`;
}

function configFor(registry: string, rpcUrl = proxyUrl): AgentGateConfig {
  // Only the fields Live0gClient reads; the rest are irrelevant here.
  return {
    zgRpcUrl: rpcUrl, zgChainId: 31337, zgNetwork: '0g-galileo',
    registryContractAddress: registry, paymentRouterAddress: routerAddress,
    activityLookbackBlocks: 50_000,
  } as unknown as AgentGateConfig;
}

const registerArgs = (n: number) => [
  `svc-${n}`, 'catalog entry', 'https://gw.example',
  [{ asset: '0x0000000000000000000000000000000000000000' as `0x${string}`, amount: BigInt(PRICE),
     decimals: 18, symbol: 'OG', name: '', version: '' }],
  seller.address, gate.address,
] as const;

beforeAll(async () => {
  anvil = spawn('anvil', ['--port', ANVIL_PORT, '--silent'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 2000));

  proxy = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const parsed: unknown = JSON.parse(body);
      for (const call of (Array.isArray(parsed) ? parsed : [parsed]) as { method: string }[]) {
        rpcLog.push(call.method);
      }
      void fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
        .then(async (upstream) => {
          const text = await upstream.text();
          res.writeHead(upstream.status, { 'content-type': 'application/json' });
          res.end(text);
        });
    });
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

  routerAddress = deploy('PaymentRouter');
  registryAddress = deploy('AgentGateRegistry', routerAddress);
  bigRegistry = deploy('AgentGateRegistry', routerAddress);

  client = new Live0gClient(configFor(registryAddress));
  // Three services is enough for "one bad entry is skipped, the rest survive".
  for (const n of [1, 2, 3]) {
    await client.registerService({
      name: `svc-${n}`, description: 'catalog entry', endpointUrl: 'https://gw.example',
      priceWei: PRICE, paymentTarget: seller.address, attestor: gate.address,
    }, signer);
  }

  // Load the second registry two past the cap, in one concurrent burst with
  // explicit nonces — 202 sequential registrations would dominate the suite.
  const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });
  const wallet = createWalletClient({ account: owner, chain: CHAIN, transport: http(RPC) });
  const start = await pub.getTransactionCount({ address: owner.address, blockTag: 'pending' });
  const hashes = await Promise.all(
    Array.from({ length: CATALOG_CAP + 2 }, (_, i) => wallet.writeContract({
      address: bigRegistry, abi: REGISTRY_ABI, functionName: 'registerService',
      args: registerArgs(i + 1), nonce: start + i, gas: 3_000_000n,
    })),
  );
  await pub.waitForTransactionReceipt({ hash: hashes[hashes.length - 1]! });
}, 120_000);

afterAll(async () => {
  anvil?.kill();
  await new Promise<void>((r) => proxy.close(() => r()));
});

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

/**
 * The gateway fires scheduleAttestation() fire-and-forget for every served call
 * (packages/middleware/src/app.ts), so N paid calls attest CONCURRENTLY on the
 * one gate key. viem derives the nonce inside writeContract by asking the node
 * for the pending count, so before the fix all N reads returned the same number
 * and all but one write was rejected outright — and the durable attestation
 * queue, which drops an entry only once its attempt confirms, then replays them
 * forever.
 */
describe('concurrent writes from the shared gate signer', () => {
  it('lands every one of a burst of attestations for distinct settlements', async () => {
    const nonces = ['7001', '7002', '7003', '7004', '7005'];
    const payments: { nonce: string; txHash: string }[] = [];
    for (const nonce of nonces) {
      const { txHash } = await client.transfer(
        { to: seller.address, amountWei: PRICE, nonce, serviceId: 1 }, buyerSigner,
      );
      payments.push({ nonce, txHash });
    }
    const before = await client.getScore(1);

    const results = await Promise.allSettled(payments.map((p) => client.recordAttestation(
      { serviceId: 1, nonce: p.nonce, payer: buyer.address, paymentTxHash: p.txHash, success: true },
      gateSigner,
    )));

    // Listed rather than counted: a nonce collision surfaces as "nonce too low"
    // or "replacement transaction underpriced", and the message is the fastest
    // way to tell that from a contract-level failure.
    expect(results.flatMap((r) => (r.status === 'rejected' ? [String(r.reason)] : []))).toEqual([]);
    const hashes = results.map((r) => (r as PromiseFulfilledResult<{ txHash: string }>).value.txHash);
    // Five DISTINCT mined transactions. An empty hash would mean the write was
    // swallowed as a duplicate, which for five distinct settlements would be
    // the same bug wearing the idempotency exemption as a disguise.
    for (const h of hashes) expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    expect(new Set(hashes).size).toBe(nonces.length);
    // And the score is the ground truth: all five reached the registry.
    await expect(client.getScore(1)).resolves.toEqual({
      totalCalls: before.totalCalls + nonces.length,
      successCalls: before.successCalls + nonces.length,
    });
  }, 60_000);

  it('does not burn a nonce on a write that never reached the chain', async () => {
    // A regression guard on HOW the serialization is done rather than on the
    // old behaviour. Reserving a nonce before the send — what viem's own
    // nonceManager does, since it consumes inside prepareTransactionRequest,
    // ahead of gas estimation — leaves a permanent GAP whenever a send fails
    // pre-flight. A duplicate attestation is exactly that failure, and it is a
    // routine event: the durable queue replays it on every boot. With a gap,
    // every later attestation is mined-order-blocked behind a nonce that will
    // never be sent, which is the very stall this whole change exists to stop.
    const { txHash } = await client.transfer(
      { to: seller.address, amountWei: PRICE, nonce: '7101', serviceId: 1 }, buyerSigner,
    );
    const input = { serviceId: 1, nonce: '7101', payer: buyer.address, paymentTxHash: txHash, success: true };
    await client.recordAttestation(input, gateSigner);
    // The replay reverts pre-flight, so no transaction is sent at all.
    await expect(client.recordAttestation(input, gateSigner)).resolves.toEqual({ txHash: '' });

    // The next attestation must still mine. It only does if the failed replay
    // reserved nothing.
    const next = await client.transfer(
      { to: seller.address, amountWei: PRICE, nonce: '7102', serviceId: 1 }, buyerSigner,
    );
    const after = await client.recordAttestation(
      { serviceId: 1, nonce: '7102', payer: buyer.address, paymentTxHash: next.txHash, success: true },
      gateSigner,
    );
    expect(after.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  }, 60_000);
});

/**
 * Registration is permissionless and the dashboard exposes the catalog through
 * an unauthenticated route (dashboard/app/api/services/route.ts), so before the
 * fix one anonymous request cost one eth_call per registered service, with no
 * cache and all-or-nothing failure.
 */
describe('listServices is bounded, isolated and cached', () => {
  it('caps the fan-out and keeps the low ids, ascending', async () => {
    const big = new Live0gClient(configFor(bigRegistry));
    rpcLog = [];
    const list = await big.listServices();

    expect(list).toHaveLength(CATALOG_CAP);
    // The LOW ids, not the newest: a spammer registering thousands of junk
    // entries must push his own past the cap, not evict everyone else's.
    expect(list.map((s) => s.id)).toEqual(Array.from({ length: CATALOG_CAP }, (_, i) => i + 1));
    // servicesCount + one read per returned service, and not one more — the
    // 202 registered services must not each cost a round-trip.
    expect(rpcLog.filter((m) => m === 'eth_call')).toHaveLength(CATALOG_CAP + 1);
  }, 60_000);

  it('skips a single failing entry instead of failing the catalog for everyone', async () => {
    const isolated = new Live0gClient(configFor(registryAddress));
    const real = isolated.getService.bind(isolated);
    // One reverting or undecodable entry, injected at the seam listServices
    // actually uses. Corrupting one service's storage on-chain would test the
    // same branch far less legibly.
    vi.spyOn(isolated, 'getService').mockImplementation(async (id: number) => {
      if (id === 2) throw new Error('malformed service 2');
      return real(id);
    });

    const list = await isolated.listServices();
    expect(list.map((s) => s.id)).toEqual([1, 3]);
  });

  it('still throws when EVERY entry fails, rather than reporting an empty catalog', async () => {
    // Skipping failures must not turn an unreachable node into "no services
    // registered": the dashboard would render an empty, healthy-looking
    // catalog and nothing would tell an operator the RPC is down.
    const broken = new Live0gClient(configFor(registryAddress));
    vi.spyOn(broken, 'getService').mockRejectedValue(new Error('rpc down'));
    await expect(broken.listServices()).rejects.toThrow(/rpc down/);
  });

  it('collapses a burst of anonymous callers into one pass over the registry', async () => {
    const fresh = new Live0gClient(configFor(registryAddress));
    rpcLog = [];
    const bursts = await Promise.all(Array.from({ length: 5 }, () => fresh.listServices()));

    for (const list of bursts) expect(list.map((s) => s.id)).toEqual([1, 2, 3]);
    // Three services: servicesCount + three reads, ONCE, no matter how many
    // callers arrive together.
    expect(rpcLog.filter((m) => m === 'eth_call')).toHaveLength(4);
    // Each caller gets its own array: the dashboard sorts the list it is
    // handed, and a shared array would let one caller reorder the cache.
    expect(bursts[0]).not.toBe(bursts[1]);
  });

  it('serves the cached catalog for the TTL, then refreshes', async () => {
    const cached = new Live0gClient(configFor(registryAddress));
    expect(await cached.listServices()).toHaveLength(3);

    // Registered OUTSIDE this client, so nothing invalidates its cache — this
    // is the dashboard's view of another operator's registration.
    const wallet = createWalletClient({ account: owner, chain: CHAIN, transport: http(RPC) });
    const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });
    const hash = await wallet.writeContract({
      address: registryAddress, abi: REGISTRY_ABI, functionName: 'registerService',
      args: registerArgs(4),
    });
    await pub.waitForTransactionReceipt({ hash });

    rpcLog = [];
    expect(await cached.listServices()).toHaveLength(3); // still the cached page
    expect(rpcLog.filter((m) => m === 'eth_call')).toHaveLength(0);

    // Only Date is faked, so the HTTP transport's own timers keep working.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60_000);
    expect(await cached.listServices()).toHaveLength(4);
  }, 60_000);

  it('shows our own registration to our own next read', async () => {
    // The CLI registers and immediately lists; a stale cache would tell the
    // operator the registration did not happen and invite a second one, which
    // mints a second service that cannot be deleted.
    const mine = new Live0gClient(configFor(registryAddress));
    const before = await mine.listServices();
    const { serviceId } = await mine.registerService({
      name: 'svc-own', description: 'catalog entry', endpointUrl: 'https://gw.example',
      priceWei: PRICE, paymentTarget: seller.address, attestor: gate.address,
    }, signer);
    const after = await mine.listServices();
    expect(after).toHaveLength(before.length + 1);
    expect(after.map((s) => s.id)).toContain(serviceId);
  }, 60_000);
});
