import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeAbiParameters, parseAbiParameters } from 'viem';
import type { AgentGateConfig } from '@agentgate/shared';
import { REGISTRY_ABI } from '../src/abi';
import { Live0gClient } from '../src/live-0g';

/**
 * A registry that has fallen BEHIND the ABI this repo ships.
 *
 * 11ad4c7 grew `Service` from 11 fields to 17 and regenerated abi.ts without
 * redeploying, so every `getService` decoded an 11-word payload against a
 * 17-field ABI, walked onto `bool active` at what was really an offset word, and
 * threw `InvalidBytesBooleanError: Bytes value "32" is not a valid boolean`.
 *
 * That is a deployment-shape problem, and it used to reach the operator as
 * `chain_unreachable` — the code for "the node is down". Everything about the
 * report pointed away from the cause: the RPC was healthy, the registry held
 * four services, and finding the truth meant hand-decoding return words.
 *
 * The old layout is written out below rather than pasted as a hex blob, because
 * WHICH eleven fields it has is the whole point.
 */
const OLD_SERVICE_TUPLE = parseAbiParameters(
  '(string name, string description, string gatewayBaseUrl, ' +
    '(address asset, uint256 amount, uint8 decimals, string symbol, string name, string version)[] accepts, ' +
    'address paymentTarget, address owner, address attestor, address pendingAttestor, ' +
    'uint64 attestorEffectiveAt, bool active, uint64 createdAt)',
);

const OLD_LAYOUT_SERVICE = encodeAbiParameters(OLD_SERVICE_TUPLE, [
  {
    name: 'USD FX Feed',
    description: 'USD exchange rates',
    gatewayBaseUrl: 'https://0g-gateway.equiflow.xyz',
    accepts: [
      {
        asset: '0x0000000000000000000000000000000000000000',
        amount: 1_000_000_000_000_000n,
        decimals: 18,
        symbol: 'OG',
        name: '',
        version: '',
      },
    ],
    paymentTarget: '0xb5B4A886DA386830392a86288ed91d272dE17746',
    owner: '0xb5B4A886DA386830392a86288ed91d272dE17746',
    attestor: '0x71a89a7e692dAC4d6BD7c3f1cCa9155592d87BaE',
    pendingAttestor: '0x0000000000000000000000000000000000000000',
    attestorEffectiveAt: 0n,
    active: true,
    createdAt: 1_788_225_063_000n,
  },
]);

const SERVICES_COUNT = `0x${(1n).toString(16).padStart(64, '0')}` as const;

/**
 * Runtime bytecode that holds code but dispatches nothing — what an address
 * carrying a contract OLDER than the shipped ABI looks like to a selector check.
 */
const CODE_WITHOUT_SELECTORS = '0x6080604052600080fd';

/** Just enough JSON-RPC to let Live0gClient reach the decoder. */
function stubNode(code = CODE_WITHOUT_SELECTORS): Promise<Server> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body);
      const data: string | undefined = params?.[0]?.data;
      const result =
        method === 'eth_chainId'
          ? '0x40da'
          : method === 'eth_blockNumber'
            ? '0x1'
            : method === 'eth_getCode'
              ? code
              : // servicesCount() -> 1, getService(uint64) -> the OLD layout.
                data?.startsWith('0x0bf08787')
                ? SERVICES_COUNT
                : OLD_LAYOUT_SERVICE;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

function clientFor(port: number): Live0gClient {
  return new Live0gClient({
    zgRpcUrl: `http://127.0.0.1:${port}`,
    zgChainId: 16602,
    zgNetwork: '0g-galileo',
    registryContractAddress: '0x73bf79e35D33Acc944542E9DA3f17058e48DE4E1',
    paymentRouterAddress: '',
    contractsDeployBlock: 0, activityLookbackBlocks: null,
  } as unknown as AgentGateConfig);
}

let server: Server;
let client: Live0gClient;

beforeAll(async () => {
  server = await stubNode();
  client = clientFor((server.address() as AddressInfo).port);
});

afterAll(() => {
  server.close();
});

describe('a registry that does not match the shipped ABI', () => {
  it('is reported as a shape mismatch, not as an unreachable chain', async () => {
    await expect(client.listServices()).rejects.toMatchObject({
      code: 'registry_abi_mismatch',
    });
  });

  it('names the address and the redeploy, so the report is actionable', async () => {
    // Case-insensitively: the client normalises addresses to lowercase, and
    // which casing an operator greps for is not something to pin a test to.
    await expect(client.listServices()).rejects.toThrowError(
      /0x73bf79e35d33acc944542e9da3f17058e48de4e1/i,
    );
    await expect(client.listServices()).rejects.toThrowError(/redeploy/i);
  });
});

/**
 * ping() is what /readyz asks, and it used to check only that the RPC reports
 * the configured chain id and that the addresses hold SOME code. A registry one
 * commit behind the ABI passes both: the gateway answers /healthz cheerfully
 * while every /svc/:id 500s. Comparing the ABI's selectors against the code that
 * is actually there closes that gap with no extra round-trip — checkChainIdentity
 * has already fetched the bytecode.
 */
describe('a registry whose code cannot dispatch the shipped ABI', () => {
  let stub: Server;
  let readOnly: Live0gClient;

  beforeAll(async () => {
    stub = await stubNode(CODE_WITHOUT_SELECTORS);
    readOnly = clientFor((stub.address() as AddressInfo).port);
  });
  afterAll(() => stub.close());

  it('fails readiness instead of reporting a healthy gateway', async () => {
    await expect(readOnly.ping()).rejects.toMatchObject({ code: 'registry_abi_mismatch' });
  });

  it('counts every function the deployment is missing, and names some', async () => {
    // Derived from the ABI rather than hard-coded: the point is that the report
    // covers the whole ABI, not that the ABI currently has some particular size.
    const fns = REGISTRY_ABI.filter((entry) => entry.type === 'function');
    await expect(readOnly.ping()).rejects.toThrowError(
      new RegExp(`cannot dispatch ${fns.length} function\\(s\\)`),
    );
    await expect(readOnly.ping()).rejects.toThrowError(new RegExp(fns[0]!.name));
  });
});
