import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createWalletClient, createPublicClient, http, parseEther, toHex } from 'viem';
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts';
import type { AgentGateConfig } from '@agentgate/shared';
import { Live0gClient } from '../src/live-0g';
import { REGISTRY_ABI } from '../src/abi';

// Port is overridable: a hardcoded one collides with whatever else the
// machine happens to be running, and the failure (`balance 0`) looks like a
// contract bug rather than a busy port.
const ANVIL_PORT = process.env.ANVIL_PORT_READS ?? '8546';
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

let anvil: ChildProcess;
let registryAddress: `0x${string}`;
let client: Live0gClient;
let registerBlockTimestampMs: number;
const account = privateKeyToAccount(DEPLOYER);

function deploy(name: string, ...ctorArgs: string[]): `0x${string}` {
  // Router -> Registry(router) -> Guard(registry): the registry verifies
  // attestations against the router's settlements and the guard reads the
  // registry's scores, so the constructor args are load-bearing.
  const out = execFileSync('forge', [
    'create', `src/${name}.sol:${name}`,
    '--rpc-url', RPC, '--private-key', DEPLOYER, '--broadcast', '--json',
    ...(ctorArgs.length ? ['--constructor-args', ...ctorArgs] : []),
  ], { cwd: new URL('../../../contracts-evm', import.meta.url).pathname, encoding: 'utf8' });
  return JSON.parse(out).deployedTo as `0x${string}`;
}

function configFor(registry: string): AgentGateConfig {
  // Only the fields Live0gClient reads; the rest are irrelevant here.
  return {
    zgRpcUrl: RPC, zgChainId: 31337, zgNetwork: '0g-galileo',
    registryContractAddress: registry, paymentRouterAddress: '',
    activityLookbackBlocks: 50_000,
  } as unknown as AgentGateConfig;
}

beforeAll(async () => {
  anvil = spawn('anvil', ['--port', ANVIL_PORT, '--silent'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 2000));
  const routerAddress = deploy('PaymentRouter');
  registryAddress = deploy('AgentGateRegistry', routerAddress);

  const wallet = createWalletClient({ account, chain: CHAIN, transport: http(RPC) });
  const pub = createPublicClient({ chain: CHAIN, transport: http(RPC) });
  const hash = await wallet.writeContract({
    address: registryAddress, abi: REGISTRY_ABI, functionName: 'registerService',
    args: [
      'weather', 'forecast API', 'https://gateway.example',
      [{ asset: '0x0000000000000000000000000000000000000000', amount: parseEther('0.001'),
         decimals: 18, symbol: 'OG', name: '', version: '' }],
      account.address, account.address,
    ],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  // The exact block that mined registerService — its timestamp is precisely
  // what the contract's `_nowMs()` used to compute `createdAt`.
  const block = await pub.getBlock({ blockNumber: receipt.blockNumber });
  registerBlockTimestampMs = Number(block.timestamp) * 1000;

  client = new Live0gClient(configFor(registryAddress));
}, 60_000);

afterAll(() => { anvil?.kill(); });

describe('Live0gClient reads', () => {
  it('ping resolves against a reachable node', async () => {
    await expect(client.ping()).resolves.toBeUndefined();
  });

  it('getService maps the on-chain record to ServiceRecord', async () => {
    const s = await client.getService(1);
    expect(s).not.toBeNull();
    expect(s!.id).toBe(1);
    expect(s!.name).toBe('weather');
    expect(s!.description).toBe('forecast API');
    // endpointUrl is COMPUTED from gatewayBaseUrl, never stored on-chain
    expect(s!.endpointUrl).toBe('https://gateway.example/svc/1');
    expect(s!.priceWei).toBe('1000000000000000');
    expect(s!.owner).toBe(account.address.toLowerCase());
    expect(s!.attestor).toBe(account.address.toLowerCase());
    expect(s!.paymentTarget).toBe(account.address.toLowerCase());
    expect(s!.active).toBe(true);
    expect(s!.accepts).toHaveLength(1);
    expect(s!.accepts![0]!.asset).toBe('native');
    // createdAt is MS, and must equal the REGISTRATION BLOCK's own timestamp
    // (block.timestamp * 1000) exactly — not just "some large number". A
    // floor-only check like `toBeGreaterThan(1_700_000_000_000)` would still
    // pass if createdAt were accidentally multiplied by 1000 a second time;
    // comparing against the block's own timestamp closes both directions.
    expect(s!.createdAt).toBe(registerBlockTimestampMs);
  });

  it('getService returns null for an unregistered id instead of throwing', async () => {
    await expect(client.getService(999)).resolves.toBeNull();
  });

  // isServiceNotFound's decision boundary: "absent" (above) must resolve
  // null, but every OTHER failure reason must still reject. A future edit
  // that widens isServiceNotFound to swallow any error would silently turn
  // an outage into a false 404 — these two pin the opposite side of that
  // boundary so such a regression fails loudly here instead of in production.
  it('getService rejects, rather than returning null, when there is no contract at the address', async () => {
    // account.address is a real funded EOA on this chain — well-formed, but
    // zero bytecode, so the eth_call returns no data ("0x") instead of a
    // ServiceNotFound revert. isServiceNotFound must say false here.
    const noContract = new Live0gClient(configFor(account.address));
    await expect(noContract.getService(1)).rejects.toThrow();
  });

  it('getService rejects, rather than returning null, when the RPC is unreachable', async () => {
    // Nothing listens on this port — connection-refused is near-instant and
    // deterministic, so this carries no timing flakiness.
    const unreachable = new Live0gClient({
      ...configFor(registryAddress),
      zgRpcUrl: 'http://127.0.0.1:8599',
    });
    await expect(unreachable.getService(1)).rejects.toThrow();
  });

  it('listServices returns every registered service', async () => {
    const list = await client.listServices();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(1);
  });

  it('getScore is (0,0) before any attestation', async () => {
    await expect(client.getScore(1)).resolves.toEqual({ totalCalls: 0, successCalls: 0 });
  });

  it('listAttestations is empty before any attestation', async () => {
    await expect(client.listAttestations(1)).resolves.toEqual([]);
  });

  it('getBalance reads native OG in wei', async () => {
    const bal = await client.getBalance(account.address);
    expect(BigInt(bal)).toBeGreaterThan(0n);
  });

  it('getBalance rejects a non-address', async () => {
    await expect(client.getBalance('not-an-address')).rejects.toThrow();
  });
});
