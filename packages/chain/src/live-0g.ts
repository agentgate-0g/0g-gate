import {
  encodeAbiParameters,
  keccak256,
  BaseError, ContractFunctionRevertedError, createPublicClient, createWalletClient,
  defineChain, http, parseEventLogs, TransactionReceiptNotFoundError,
  type Abi, type Chain, type Hash, type PublicClient, type TransactionReceipt,
  type Transport, type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import {
  AgentGateError, formatOg, stripTrailingSlashes,
  type ActivityEvent, type AgentGateConfig, type AnySigner,
  type AttestationRecord, type ChainClient, type PaymentOption,
  type RegisterServiceInput, type ServiceRecord, type ServiceScore,
  type VerifyResult, type VerifyTransferQuery, type Wei,
} from '@agentgate/shared';
import { normalizeAddress, shortAddress } from './address';
import {
  awaitReceipt, isReceiptLag,
  DEFAULT_RECEIPT_TIMEOUT_MS, RECEIPT_ATTEMPT_TIMEOUT_MS,
} from './receipt';
import { PAYMENT_ROUTER_ABI, REGISTRY_ABI } from './abi';
import { missingSelectors } from './deployment-shape';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * How many services one `listServices()` call will read.
 *
 * Registration is permissionless and nearly free, and the dashboard serves the
 * catalog from an unauthenticated route, so the fan-out is otherwise chosen by
 * whoever registers the most services. The cap is applied to the LOW ids on
 * purpose: a spammer then pushes his OWN entries past it instead of evicting
 * everyone else's, which is what taking the newest N would do.
 */
const MAX_LISTED_SERVICES = 200;

/**
 * How long one catalog read is reused. Short enough that a registration shows
 * up on the next dashboard poll, long enough that a burst of anonymous requests
 * costs one pass over the registry instead of one per request.
 */
const SERVICES_CACHE_TTL_MS = 5_000;

/**
 * How long a locally-remembered next nonce is trusted over the node's own
 * pending count. See `sendTx` — it covers the window where a load-balanced RPC
 * has not yet counted our previous transaction, and expires so that a
 * transaction dropped from the mempool cannot strand the account forever.
 */
const NONCE_FLOOR_TTL_MS = 30_000;

/**
 * `0x` + 32 bytes of hex. Two distinct things happen to share this shape here:
 * a transaction hash and a secp256k1 private key. Both are checked BEFORE
 * being handed to viem — for the hash so a malformed one is a clean verdict
 * rather than a thrown RPC error, and for the key so no third-party error
 * message ever gets a chance to quote the secret.
 */
const BYTES32_HEX_RE = /^0x[0-9a-fA-F]{64}$/;

/** Registry ids are 1-based; a read of 0 is always "absent". */
function requireServiceId(id: number): bigint {
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new AgentGateError('invalid_query', `service id must be a positive integer, got ${id}`, 400);
  }
  return BigInt(id);
}

/**
 * The single rejection for every unusable private key.
 *
 * One shared, VALUE-FREE message on purpose: whatever is wrong with the key, the
 * error ends up in a log line or an HTTP body, so no path may quote it. viem's
 * own error for an out-of-range key prints the scalar in decimal, which is why
 * the call to `privateKeyToAccount` is wrapped rather than trusted.
 */
function invalidKey(): AgentGateError {
  return new AgentGateError(
    'invalid_signer',
    'private key must be 0x + 64 hex within the secp256k1 range',
    400,
  );
}

function notDeployed(): AgentGateError {
  return new AgentGateError(
    'CONTRACT_NOT_DEPLOYED',
    'REGISTRY_CONTRACT_ADDRESS is unset — deploy the registry (contracts-evm/README.md) and set it',
    503,
  );
}

/**
 * True when a viem call reverted with the named custom error from the contract.
 *
 * Walks the structured error chain (viem's documented pattern — see "Handling
 * Custom Errors" in the viem docs) instead of substring-matching `.message`:
 * the decoded `errorName` is a stable, typed fact about the revert, while the
 * message string is private formatting that can change between viem versions
 * with no compile-time signal here. Any other failure (unreachable RPC, no
 * contract at the address, a different revert) walks to something other than
 * a matching `ContractFunctionRevertedError` and this returns false, so the
 * caller rethrows instead of misreporting an outage as an expected revert.
 * Total and non-throwing by construction — every branch returns a boolean.
 */
function isRevertNamed(err: unknown, errorName: string): boolean {
  if (!(err instanceof BaseError)) return false;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  return reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName === errorName;
}

/** True when a read reverted because the service id is not registered. */
function isServiceNotFound(err: unknown): boolean {
  return isRevertNamed(err, 'ServiceNotFound');
}

/**
 * Decode failures, matched on error NAME rather than on imported classes: viem
 * throws these from a dozen small classes across its abi and encoding modules,
 * not all of which are re-exported from the package root, and the set grows
 * between minor versions. A name this misses falls through to the generic
 * handling that existed before — so the heuristic can only under-report.
 */
const ABI_DECODE_ERROR = /^(AbiDecoding|InvalidAbiDecoding|InvalidBytes|InvalidHex)/;

/**
 * True when a read REACHED the contract and came back with bytes the shipped ABI
 * cannot decode.
 *
 * This is the signature of a deployment that has drifted from
 * packages/chain/src/abi.ts, and it is worth separating from every other read
 * failure because it is the one that lies. The node is healthy, the address
 * holds code, the call returns 200 — and the operator is handed a Solidity type
 * error about a `bool` they never asked for. Reported as "chain unreachable",
 * which is where it used to land, it sends the investigation at an RPC that has
 * nothing wrong with it.
 */
function isAbiDecodeFailure(err: unknown): boolean {
  return (
    err instanceof BaseError && err.walk((e) => ABI_DECODE_ERROR.test((e as Error).name)) !== null
  );
}

/** The actionable version of a decode failure: what drifted, and what fixes it. */
function abiMismatch(registry: string, fn: string, err: unknown): AgentGateError {
  const detail = err instanceof BaseError ? err.shortMessage : String(err);
  return new AgentGateError(
    'registry_abi_mismatch',
    `registry ${registry} answered ${fn} with data that packages/chain/src/abi.ts ` +
      `cannot decode (${detail}). The contract at that address is not the one this ` +
      'build was compiled against. Redeploy the current contracts and re-record them ' +
      'with `npx tsx scripts/set-deployment.ts`, or point REGISTRY_CONTRACT_ADDRESS ' +
      'at a deployment that matches.',
    500,
  );
}

/**
 * Pull ONE named event's ABI entry out of a contract ABI, for viem's `getLogs`.
 *
 * Narrowing on the name (not just `type: 'event'`) is what keeps `log.args`
 * precisely typed: handing viem the union of every event in the ABI would
 * collapse the decoded args to a union too, and `log.args.serviceId` would stop
 * being a compile-time fact.
 */
function eventAbi<
  TAbi extends readonly { readonly type: string; readonly name?: string }[],
  TName extends string,
>(abi: TAbi, name: TName): Extract<TAbi[number], { type: 'event'; name: TName }> {
  const found = abi.find((e) => e.type === 'event' && e.name === name);
  if (!found) throw new Error(`event ${name} missing from ABI`);
  return found as Extract<TAbi[number], { type: 'event'; name: TName }>;
}

// Resolved once at module load, not per call — the ABI never changes at runtime.
const SERVICE_REGISTERED_EVENT = eventAbi(REGISTRY_ABI, 'ServiceRegistered');
const ATTESTATION_RECORDED_EVENT = eventAbi(REGISTRY_ABI, 'AttestationRecorded');
const PAID_EVENT = eventAbi(PAYMENT_ROUTER_ABI, 'Paid');

/**
 * An activity event still missing its timestamp, tagged with the chain's own
 * total order over logs. Keeping `(blockNumber, logIndex)` alongside is what
 * lets `listRecentActivity` sort and page BEFORE spending a `getBlock` call
 * per block — the timestamp is the only field that costs an extra round-trip.
 */
interface PendingEvent {
  blockNumber: bigint;
  logIndex: number;
  event: Omit<ActivityEvent, 'timestamp'>;
}

/**
 * 0G Galileo Testnet client — the live `ChainClient`.
 *
 * Every read is an ABI view call and every history query is `eth_getLogs`, so
 * this needs no indexer service and no API key: a public RPC URL is the whole
 * configuration.
 */
export class Live0gClient implements ChainClient {
  readonly network: string;
  /** The router this client settles through — see ChainClient.routerAddress. */
  readonly routerAddress: string;
  private readonly cfg: AgentGateConfig;
  private readonly chain: Chain;
  private readonly pub: PublicClient;

  constructor(config: AgentGateConfig) {
    this.cfg = config;
    this.network = config.zgNetwork;
    this.routerAddress = config.paymentRouterAddress;
    this.chain = defineChain({
      id: config.zgChainId,
      name: config.zgNetwork,
      nativeCurrency: { name: 'OG', symbol: 'OG', decimals: 18 },
      rpcUrls: { default: { http: [config.zgRpcUrl] } },
    });
    this.pub = createPublicClient({ chain: this.chain, transport: http(config.zgRpcUrl) });
  }

  /**
   * Cheap reachability probe for readiness checks — and, once per process, a
   * proof that the node on the other end is the chain we think it is and that
   * our contracts actually exist on it. See `assertChainIdentity`.
   */
  async ping(): Promise<void> {
    await this.pub.getBlockNumber();
    await this.assertChainIdentity();
  }

  /**
   * Verify, ONCE, that (a) the RPC reports the chain id we were configured with
   * and (b) the registry and router addresses hold code on it.
   *
   * Neither was checked anywhere before, and the combination is how real money
   * gets burned on a mainnet cutover. `ZG_CHAIN_ID` only ever fed
   * `defineChain({id})`, which viem takes on trust for a local account — it
   * never asks the node. And the contract addresses default to the Galileo
   * TESTNET deployment, so an operator who repoints `ZG_RPC_URL` at mainnet and
   * forgets the rest gets a client that is confidently wrong.
   *
   * The address half matters more than it looks: a value-bearing CALL to an
   * address with NO CODE succeeds. `eth_estimateGas` returns intrinsic gas, the
   * transaction mines with `status: 'success'`, and `settled()` — which only
   * inspects `receipt.status` — reports it as a completed payment. The buyer's
   * OG is then sitting at an address nobody holds a key for, and
   * `verifyTransfer` 402s forever because no `Paid` log was ever emitted.
   *
   * Cached as a promise so concurrent callers share one round-trip, and so a
   * failure is re-raised to every caller instead of being silently swallowed by
   * whoever happened to lose the race.
   */
  private identityChecked: Promise<void> | undefined;
  async assertChainIdentity(): Promise<void> {
    this.identityChecked ??= this.checkChainIdentity();
    try {
      await this.identityChecked;
    } catch (err) {
      // Never cache a failure: a transient RPC blip must not permanently brick
      // an otherwise healthy gateway.
      this.identityChecked = undefined;
      throw err;
    }
  }

  /** The chain id the NODE reports — surfaced by the gateway's /metrics so an
   *  operator can see a configuration/reality disagreement directly. */
  async observedChainId(): Promise<number> {
    return this.pub.getChainId();
  }

  private async checkChainIdentity(): Promise<void> {
    const observed = await this.pub.getChainId();
    if (observed !== this.cfg.zgChainId) {
      throw new AgentGateError(
        'CHAIN_ID_MISMATCH',
        `${this.cfg.zgRpcUrl} reports chain id ${observed}, but this process is configured ` +
          `for ${this.cfg.zgChainId} (${this.cfg.zgNetwork}). Refusing to sign or trust reads ` +
          'against a chain that is not the one the contract addresses belong to.',
        503,
      );
    }
    // Only check what is actually configured — a read-only client legitimately
    // runs without a router, and `router()`/`registry()` already fail closed
    // with a clearer message when one is needed but unset.
    const wanted: { label: string; address: string; abi: Abi; code: string }[] = [];
    if (this.cfg.registryContractAddress !== '') {
      wanted.push({
        label: 'REGISTRY_CONTRACT_ADDRESS', address: this.cfg.registryContractAddress,
        abi: REGISTRY_ABI as unknown as Abi, code: 'registry_abi_mismatch',
      });
    }
    if (this.cfg.paymentRouterAddress !== '') {
      wanted.push({
        label: 'PAYMENT_ROUTER_ADDRESS', address: this.cfg.paymentRouterAddress,
        abi: PAYMENT_ROUTER_ABI as unknown as Abi, code: 'router_abi_mismatch',
      });
    }
    for (const { label, address, abi, code: mismatchCode } of wanted) {
      const code = await this.pub.getCode({ address: normalizeAddress(address) as `0x${string}` });
      if (code === undefined || code === '0x') {
        throw new AgentGateError(
          'CONTRACT_NOT_DEPLOYED',
          `${label}=${address} has no code on chain ${this.cfg.zgChainId} (${this.cfg.zgNetwork}). ` +
            'This is what a testnet address left over on a mainnet config looks like. ' +
            'A payment sent to a codeless address SUCCEEDS on-chain and is unrecoverable.',
          503,
        );
      }
      // Holding code is not the same as being the contract this build was
      // compiled against. Every selector the ABI declares must be dispatchable
      // by what is actually there — otherwise the gateway boots, answers
      // /healthz, and 500s every read, which is the one failure mode readiness
      // exists to catch. The bytecode is already in hand, so this costs nothing.
      const missing = missingSelectors(abi, code);
      if (missing.length > 0) {
        throw new AgentGateError(
          mismatchCode,
          `${label}=${address} cannot dispatch ${missing.length} function(s) that ` +
            `packages/chain/src/abi.ts declares: ${missing.slice(0, 5).join(', ')}` +
            `${missing.length > 5 ? ', …' : ''}. The deployment is older than this build. ` +
            'Redeploy the current contracts and re-record them with ' +
            '`npx tsx scripts/set-deployment.ts`, or point this address at a deployment ' +
            'that matches.',
          503,
        );
      }
    }
  }

  private registry(): `0x${string}` {
    if (this.cfg.registryContractAddress === '') throw notDeployed();
    return normalizeAddress(this.cfg.registryContractAddress) as `0x${string}`;
  }

  /** Map the on-chain Service tuple onto the off-chain ServiceRecord shape. */
  private toRecord(
    raw: {
      name: string; description: string; gatewayBaseUrl: string;
      accepts: readonly { asset: string; amount: bigint; decimals: number;
                          symbol: string; name: string; version: string }[];
      paymentTarget: string; owner: string; attestor: string;
      active: boolean; createdAt: bigint;
    },
    id: number,
  ): ServiceRecord {
    const accepts: PaymentOption[] = raw.accepts.map((o) => ({
      asset: o.asset.toLowerCase() === ZERO_ADDRESS ? 'native' : o.asset.toLowerCase(),
      amount: o.amount.toString(),
      decimals: o.decimals,
      symbol: o.symbol,
      name: o.name,
      version: o.version,
    }));
    // priceWei mirrors the native option, or the first option if none is
    // native — the invoice quotes one asset, and native is the default rail.
    const native = accepts.find((o) => o.asset === 'native');
    const priceWei: Wei = (native ?? accepts[0])?.amount ?? '0';
    return {
      id,
      name: raw.name,
      description: raw.description,
      // The contract stores the BASE url; the endpoint is always {base}/svc/{id}.
      endpointUrl: `${stripTrailingSlashes(raw.gatewayBaseUrl)}/svc/${id}`,
      priceWei,
      paymentTarget: raw.paymentTarget.toLowerCase(),
      owner: raw.owner.toLowerCase(),
      attestor: raw.attestor.toLowerCase(),
      active: raw.active,
      createdAt: Number(raw.createdAt), // already MS on-chain
      accepts,
    };
  }

  async getService(id: number): Promise<ServiceRecord | null> {
    const serviceId = requireServiceId(id);
    try {
      const raw = await this.pub.readContract({
        address: this.registry(), abi: REGISTRY_ABI,
        functionName: 'getService', args: [serviceId],
      });
      return this.toRecord(raw as Parameters<typeof this.toRecord>[0], id);
    } catch (err) {
      // An unregistered id is "absent", not an error — the middleware turns a
      // null into 404 but any throw into a 5xx (503 only for the specific
      // CONTRACT_NOT_DEPLOYED AgentGateError; a raw RPC/network error falls
      // through to a generic 500), so this distinction matters regardless of
      // which 5xx a given throw ends up as.
      if (isServiceNotFound(err)) return null;
      if (isAbiDecodeFailure(err)) throw abiMismatch(this.registry(), 'getService', err);
      throw err;
    }
  }

  /**
   * The service catalog, oldest id first.
   *
   * Every caller of this is anonymous — the dashboard serves it from an
   * unauthenticated route — and it used to cost one uncached `eth_call` per
   * registered service, with a single bad entry taking the whole catalog down
   * for everyone. Three guards, and the ORDER and SHAPE of the result are
   * unchanged by all of them:
   *
   *  - bounded at MAX_LISTED_SERVICES, so what an anonymous request costs is
   *    not a number a spammer chooses;
   *  - per-entry isolated, so one service that reverts or fails to decode is
   *    skipped rather than fatal — but a catalog where EVERY read failed still
   *    throws, because an unreachable node must not render as "no services";
   *  - cached for SERVICES_CACHE_TTL_MS, with concurrent callers sharing the
   *    in-flight read, which is what collapses a burst into one pass.
   */
  private servicesCache: { at: number; value: Promise<ServiceRecord[]> } | undefined;
  async listServices(): Promise<ServiceRecord[]> {
    const fresh = this.servicesCache;
    // A copy per caller: the cache hands the same array to everyone and
    // consumers sort and splice the list they are given.
    if (fresh && Date.now() - fresh.at < SERVICES_CACHE_TTL_MS) return [...(await fresh.value)];
    const entry = { at: Date.now(), value: this.readServices() };
    this.servicesCache = entry;
    try {
      return [...(await entry.value)];
    } catch (err) {
      // Never cache a failure: a transient RPC blip must not blank the catalog
      // for the rest of the TTL.
      if (this.servicesCache === entry) this.servicesCache = undefined;
      throw err;
    }
  }

  private async readServices(): Promise<ServiceRecord[]> {
    const count = await this.pub.readContract({
      address: this.registry(), abi: REGISTRY_ABI, functionName: 'servicesCount',
    });
    const total = Math.min(Number(count), MAX_LISTED_SERVICES);
    if (total <= 0) return [];
    const ids = Array.from({ length: total }, (_, i) => i + 1);
    const settled = await Promise.allSettled(ids.map((id) => this.getService(id)));
    // An unregistered id resolves to null and is simply absent; only a THROWN
    // read is a failure, and only every read failing is fatal.
    const failed = settled.filter((r) => r.status === 'rejected');
    if (failed.length === settled.length) throw (failed[0] as PromiseRejectedResult).reason;
    return settled.flatMap((r) => (r.status === 'fulfilled' && r.value !== null ? [r.value] : []));
  }

  async getScore(id: number): Promise<ServiceScore> {
    const [total, success] = await this.pub.readContract({
      address: this.registry(), abi: REGISTRY_ABI,
      functionName: 'getScore', args: [requireServiceId(id)],
    });
    return { totalCalls: Number(total), successCalls: Number(success) };
  }

  async listAttestations(serviceId: number, limit = 50): Promise<AttestationRecord[]> {
    const id = requireServiceId(serviceId);
    const registry = this.registry();
    const raw = await this.pub.readContract({
      address: registry, abi: REGISTRY_ABI, functionName: 'getAttestations', args: [id],
    });
    // The contract already returns newest-first; only the cap is applied here.
    const records = raw.slice(0, limit);
    if (records.length === 0) return [];

    // `recordTxHash` is the hash of the attestation transaction itself, which a
    // contract cannot know about itself and therefore cannot store. The only
    // source is the `AttestationRecorded` log, joined here on the payment hash
    // (unique per service — the contract's own dedup key). Without this join
    // every live attestation carries an empty hash: the CLI prints a dangling
    // "tx ", the dashboard renders a link to nowhere, and — because the list is
    // keyed by it — React sees every row as the same key.
    // cacheTime: 0 is load-bearing. viem caches getBlockNumber for its polling
    // interval (~4s) by default, so a block mined moments ago can still be
    // missing from the cached height — and this value is `toBlock`, so the
    // window would silently end BELOW the event just written. The caller reads
    // its own fresh write and gets nothing back.
    const latest = await this.pub.getBlockNumber({ cacheTime: 0 });
    const lookback = BigInt(this.cfg.activityLookbackBlocks);
    const logs = await this.pub.getLogs({
      address: registry,
      event: ATTESTATION_RECORDED_EVENT,
      args: { serviceId: BigInt(id) },
      fromBlock: latest > lookback ? latest - lookback : 0n,
      toBlock: latest,
      strict: true,
    });
    const byPayment = new Map(logs.map((l) => [l.args.paymentTxHash, l.transactionHash]));

    return records.map((a) => ({
      serviceId,
      paymentTxHash: a.paymentTxHash,
      success: a.success,
      timestamp: Number(a.timestamp),
      // '' only when the attestation predates the lookback window. Consumers
      // must treat an empty hash as "unknown", never as a renderable link.
      recordTxHash: byPayment.get(a.paymentTxHash) ?? '',
    }));
  }

  async getBalance(account: string): Promise<Wei> {
    const address = normalizeAddress(account) as `0x${string}`;
    const balance = await this.pub.getBalance({ address });
    return balance.toString();
  }

  /**
   * Recent on-chain activity, newest first.
   *
   * Three `eth_getLogs` calls — registry registrations, registry attestations,
   * router payments — merged into one feed. No indexer service and no API key
   * sit between the gateway and this, so there is no rate-limit path to
   * degrade on.
   *
   * Ordering is `(blockNumber, logIndex)` DESCENDING, which is the chain's own
   * total order over the logs. Sorting on the block timestamp instead cannot
   * separate events inside a block — they all share one — and would fall
   * through to insertion order, listing every attestation above every payment
   * regardless of what actually happened first.
   *
   * The lookback is BOUNDED: public RPCs cap getLogs ranges, and `fromBlock: 0`
   * would fail outright on a live chain.
   */
  async listRecentActivity(limit = 50): Promise<ActivityEvent[]> {
    // Resolved BEFORE the first RPC call, so a gateway booted without a deploy
    // answers CONTRACT_NOT_DEPLOYED immediately instead of paying a round-trip
    // to learn what its own config already knew.
    const registry = this.registry();
    // cacheTime: 0 is load-bearing. viem caches getBlockNumber for its polling
    // interval (~4s) by default, so a block mined moments ago can still be
    // missing from the cached height — and this value is `toBlock`, so the
    // window would silently end BELOW the event just written. The caller reads
    // its own fresh write and gets nothing back.
    const latest = await this.pub.getBlockNumber({ cacheTime: 0 });
    const lookback = BigInt(this.cfg.activityLookbackBlocks);
    const fromBlock = latest > lookback ? latest - lookback : 0n;
    const range = { fromBlock, toBlock: latest, strict: true } as const;

    const [registered, attested, paid] = await Promise.all([
      this.pub.getLogs({ ...range, address: registry, event: SERVICE_REGISTERED_EVENT }),
      this.pub.getLogs({ ...range, address: registry, event: ATTESTATION_RECORDED_EVENT }),
      // A gateway can run registry-only (discovery + reputation, no settlement
      // rail); without a router there is simply no payment history to join.
      this.cfg.paymentRouterAddress === ''
        ? []
        : this.pub.getLogs({ ...range, address: this.router(), event: PAID_EVENT }),
    ]);

    // Everything but the timestamp, which is a per-BLOCK fact and therefore an
    // extra RPC call. Ordering and paging are settled from the log positions
    // alone, so only the blocks that survive `limit` are ever fetched.
    const pending: PendingEvent[] = [];

    for (const log of registered) {
      pending.push({ blockNumber: log.blockNumber, logIndex: log.logIndex, event: {
        kind: 'service_registered',
        txHash: log.transactionHash,
        serviceId: Number(log.args.serviceId),
        detail: `service "${log.args.name}" registered`,
      } });
    }

    for (const log of attested) {
      const success = log.args.success;
      pending.push({ blockNumber: log.blockNumber, logIndex: log.logIndex, event: {
        kind: 'attestation',
        txHash: log.transactionHash,
        serviceId: Number(log.args.serviceId),
        success,
        detail: `attestation ${success ? 'success' : 'failure'} for service ${log.args.serviceId}`,
      } });
    }

    for (const log of paid) {
      // `Paid` carries the service id itself, so a payment is never attributed
      // to a service by way of its attestation the way a bare value transfer
      // would force. Payment targets are shared across services here, so a
      // guessed id would be wrong exactly when it mattered.
      pending.push({ blockNumber: log.blockNumber, logIndex: log.logIndex, event: {
        kind: 'payment',
        txHash: log.transactionHash,
        serviceId: Number(log.args.serviceId),
        amountWei: log.args.amount.toString(),
        detail: `payment of ${formatOg(log.args.amount.toString())} to ${shortAddress(log.args.payTo)}`,
      } });
    }

    pending.sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? 1 : -1;
      return b.logIndex - a.logIndex;
    });
    // Paged BEFORE any block header is read. The window is 50 000 blocks wide,
    // so resolving a timestamp for every event-bearing block in it — then
    // throwing all but `limit` away — would put an unbounded, concurrent burst
    // of getBlock calls against a public RPC behind a two-item request.
    const page = pending.slice(0, limit);

    // Block timestamps are per-BLOCK, not per-log: fetch each distinct block
    // once, or the feed costs one extra RPC round-trip per event.
    const times = new Map<bigint, number>();
    await Promise.all([...new Set(page.map((p) => p.blockNumber))].map(async (bn) => {
      const block = await this.pub.getBlock({ blockNumber: bn });
      // A block header is SECONDS since the epoch. The contracts' own
      // `uint64(block.timestamp) * 1000` fields are already ms; this one is not.
      times.set(bn, Number(block.timestamp) * 1000);
    }));

    return page.map((p) => {
      const timestamp = times.get(p.blockNumber);
      // Unreachable: every block in `page` was awaited into `times` above. It
      // throws rather than defaulting because a default would be a lie — a real
      // event would render as 1 January 1970 and sort to the bottom of the feed.
      if (timestamp === undefined) throw new Error(`no block header for block ${p.blockNumber}`);
      return { ...p.event, timestamp };
    });
  }

  // ---- ChainClient writes ---------------------------------------------------

  /**
   * Build a signing wallet from a key signer.
   *
   * Three guards, all about the key never escaping: a mock signer cannot sign a
   * live transaction and is refused before any RPC call; a wrong-shaped key is
   * refused before viem sees it; and viem's own construction is wrapped, because
   * a key that is the right SHAPE but outside the secp256k1 range gets past the
   * regex and viem's message for that prints the scalar in decimal.
   */
  private walletFor(signer: AnySigner): WalletClient<Transport, Chain, PrivateKeyAccount> {
    if (signer.kind !== 'key') {
      throw new AgentGateError(
        'invalid_signer',
        `Live0gClient requires a key signer, got "${signer.kind}"`,
        400,
      );
    }
    if (!BYTES32_HEX_RE.test(signer.privateKey)) throw invalidKey();
    let account: PrivateKeyAccount;
    try {
      account = privateKeyToAccount(signer.privateKey as `0x${string}`);
    } catch {
      // Swallowed deliberately: the original carries the key value.
      throw invalidKey();
    }
    return createWalletClient({ account, chain: this.chain, transport: http(this.cfg.zgRpcUrl) });
  }

  /** Per-signing-address send queue, and the nonce that address should use next. */
  private readonly sendQueue = new Map<string, Promise<unknown>>();
  private readonly nonceFloor = new Map<string, { nonce: number; at: number }>();

  /**
   * Serialize transaction SENDS per signing address, and never hand out a nonce
   * twice.
   *
   * viem derives the nonce inside `writeContract` by asking the node for the
   * account's PENDING count, so writes started concurrently from one account
   * all read the same number and all but one is rejected ("nonce too low") or
   * replaces its sibling. The gateway does exactly that: `scheduleAttestation`
   * is fire-and-forget per served call (packages/middleware/src/app.ts), so a
   * burst of paid calls attests concurrently on the ONE gate key. The writes
   * fail, the durable attestation queue drops an entry only once its attempt
   * confirms, and it therefore replays them forever without ever draining.
   *
   * Only the send is serialized, not the receipt wait: transactions from one
   * account mine in nonce order regardless, and holding the queue open for a
   * receipt would cost a whole block per attestation.
   *
   * `nonceFloor` is a floor, not a counter, and it advances only AFTER a send
   * the node accepted. Reserving a nonce before the send — what viem's own
   * `nonceManager` does, since it consumes ahead of gas estimation — leaves a
   * permanent gap whenever a send fails pre-flight, and a duplicate attestation
   * is exactly that failure on the path the queue replays most. Every later
   * transaction would then sit unminable behind a nonce that is never sent.
   */
  private async sendTx(
    address: `0x${string}`, send: (nonce: number) => Promise<Hash>,
  ): Promise<Hash> {
    const key = address.toLowerCase();
    const prior = this.sendQueue.get(key) ?? Promise.resolve();
    const run = prior.then(async () => {
      const pending = await this.pub.getTransactionCount({ address, blockTag: 'pending' });
      // 0G's public RPC is load-balanced (see `settled`), so the node answering
      // this is not necessarily the one that accepted our previous transaction
      // moments ago — trust our own count while it is fresh.
      const floor = this.nonceFloor.get(key);
      const nonce = floor && floor.nonce > pending && Date.now() - floor.at < NONCE_FLOOR_TTL_MS
        ? floor.nonce
        : pending;
      const hash = await send(nonce);
      this.nonceFloor.set(key, { nonce: nonce + 1, at: Date.now() });
      return hash;
    });
    // The queue must survive a failed send: chaining the raw promise would let
    // one rejection deadlock every later write from this address.
    this.sendQueue.set(key, run.catch(() => undefined));
    return run;
  }

  /**
   * Wait for `hash` to be mined and REQUIRE that it succeeded.
   *
   * Awaiting the receipt and then ignoring its status would be the worst of both
   * worlds — paying the latency and still reporting success for a reverted
   * write. viem's pre-flight gas estimation rejects deterministic reverts before
   * a tx is ever sent, so what reaches here is the state race: a competing
   * attestation for the same payment landing first (DuplicateAttestation), a
   * duplicate-nonce `pay`, or `payTo.call` failing in execution. On the
   * attestation path in particular a silent success would let the middleware
   * drop the durable-queue entry while the on-chain score never moved.
   *
   * `alreadySatisfied` is the one exemption: a receipt carries no revert reason,
   * so for an idempotent write that lost a race the caller supplies a read that
   * asks whether the intended END STATE holds anyway. If it does, the revert is
   * a no-op rather than a failure.
   */
  private async settled(
    hash: Hash, what: string, alreadySatisfied?: () => Promise<boolean>,
  ): Promise<TransactionReceipt> {
    // 0G produces a block roughly every 0.5s, but the public RPC is
    // load-balanced: the node answering this poll is not necessarily the one
    // that accepted the transaction, and a lagging peer can take much longer
    // than a block to serve the receipt. viem's DEFAULT is 6 retries with
    // (1 << n) * 200ms backoff — about 12s total, not the 180s `timeout`
    // suggests — which a lagging node blows straight through.
    //
    // One call is not enough on its own, whatever its retry count: it stays on
    // the peer it started with, and a peer that is behind stays behind. So the
    // call is re-entered against a wall-clock deadline (see ./receipt), which
    // both gives the load balancer another chance and makes the total wait a
    // number an operator can set rather than a property of viem's backoff.
    let receipt: TransactionReceipt;
    try {
      receipt = await awaitReceipt(
        () =>
          this.pub.waitForTransactionReceipt({
            hash,
            retryCount: 6,
            pollingInterval: 1_000,
            timeout: RECEIPT_ATTEMPT_TIMEOUT_MS,
          }),
        // `?? DEFAULT` and not a required field: every test in this package
        // builds its config with `as unknown as AgentGateConfig`, so a value
        // added here is simply absent at runtime in all of them.
        { timeoutMs: this.cfg.zgReceiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS },
      );
    } catch (err: unknown) {
      // Losing the receipt is NOT the same as the write failing, and the
      // difference is expensive: registerService is not idempotent, so an
      // operator who reads "could not be found" as "it did not happen" and
      // re-runs `wrap` mints a SECOND service on-chain that cannot be deleted.
      // Say what is actually known — the hash, and that the state is unknown
      // rather than failed.
      if (isReceiptLag(err)) {
        throw new AgentGateError(
          'TX_RECEIPT_UNCONFIRMED',
          `${what} was submitted as tx ${hash} but its receipt did not arrive in time. ` +
            'The transaction may still have SUCCEEDED — check ' +
            `${stripTrailingSlashes(this.cfg.zgExplorerUrl)}/tx/${hash} before retrying. ` +
            'Do NOT blindly re-run a registration: it is not idempotent and would ' +
            'register a second service.',
          504,
        );
      }
      throw err;
    }
    if (receipt.status !== 'success') {
      if (alreadySatisfied && (await alreadySatisfied())) return receipt;
      throw new AgentGateError('TX_FAILED', `${what} reverted on-chain (tx ${hash})`, 502);
    }
    return receipt;
  }

  /**
   * Has this payment already been scored for this service? (`seenPayments`)
   *
   * The registry dedups on the ROUTER SETTLEMENT key, not on the supplied tx
   * hash — the hash is display-only and is never a key anywhere. Probing by
   * hash returns false for every input, which would silently disable the
   * duplicate-race recovery this exists to serve and report a benign duplicate
   * as TX_FAILED. Mirrors PaymentRouter.nonceKey exactly.
   */
  private async isAttested(serviceId: bigint, nonce: bigint, payer: string): Promise<boolean> {
    const key = keccak256(encodeAbiParameters(
      [{ type: 'uint64' }, { type: 'uint256' }, { type: 'address' }],
      [serviceId, nonce, normalizeAddress(payer) as `0x${string}`],
    ));
    return await this.pub.readContract({
      address: this.registry(), abi: REGISTRY_ABI,
      functionName: 'seenPayments', args: [serviceId, key],
    });
  }

  private router(): `0x${string}` {
    if (this.cfg.paymentRouterAddress === '') {
      throw new AgentGateError(
        'CONTRACT_NOT_DEPLOYED',
        'PAYMENT_ROUTER_ADDRESS is unset — deploy PaymentRouter and set it',
        503,
      );
    }
    return normalizeAddress(this.cfg.paymentRouterAddress) as `0x${string}`;
  }

  async registerService(
    input: RegisterServiceInput, signer: AnySigner,
  ): Promise<{ serviceId: number; txHash: string }> {
    const wallet = this.walletFor(signer);
    const hash = await this.sendTx(wallet.account.address, (nonce) => wallet.writeContract({
      address: this.registry(), abi: REGISTRY_ABI, functionName: 'registerService',
      chain: this.chain, account: wallet.account, nonce,
      args: [
        input.name, input.description,
        // endpointUrl carries the gateway BASE url on input (SPEC §9); the
        // stored form is canonical so `{base}/svc/{id}` round-trips exactly.
        stripTrailingSlashes(input.endpointUrl),
        [{
          asset: ZERO_ADDRESS as `0x${string}`, amount: BigInt(input.priceWei),
          decimals: 18, symbol: 'OG', name: '', version: '',
        }],
        normalizeAddress(input.paymentTarget) as `0x${string}`,
        normalizeAddress(input.attestor) as `0x${string}`,
      ],
    }));
    const receipt = await this.settled(hash, 'registerService');
    // Our own registration must be visible to our own next read: the CLI wraps
    // a service and immediately lists, and a stale catalog there reads as "the
    // registration did not happen" — inviting a second one, which mints a
    // second service that cannot be deleted.
    this.servicesCache = undefined;
    // The id is assigned on-chain; read it back from the event rather than
    // racing servicesCount(), which another registration could have bumped
    // between our tx landing and our read.
    const [event] = parseEventLogs({
      abi: REGISTRY_ABI, eventName: 'ServiceRegistered', logs: receipt.logs,
    });
    if (!event) {
      throw new AgentGateError('TX_FAILED', 'registerService emitted no ServiceRegistered event', 502);
    }
    return { serviceId: Number(event.args.serviceId), txHash: hash };
  }

  /**
   * Score one paid call. **Idempotent**: re-recording a payment that is already
   * attested resolves instead of throwing.
   *
   * That is not politeness, it is the contract the durable attestation queue is
   * built on. `packages/middleware/src/attestation-queue.ts` replays unconfirmed
   * entries on every boot and drops one only once the attempt confirms, "safe
   * because the registry contract dedups by (service_id, payment_tx_hash)". If a
   * replay of an already-recorded attestation threw, its entry would never be
   * dropped — replayed on the next boot, and the next, burning gas forever. So
   * `DuplicateAttestation` means the desired end state already holds and is
   * reported as success; every OTHER revert (NotAuthorized, ServiceInactive,
   * ServiceNotFound) is a real failure and still throws.
   *
   * Note the asymmetry with `transfer`: a duplicate NONCE there is not benign,
   * because the caller's own money did not move.
   */
  async recordAttestation(
    input: { serviceId: number; nonce: string; payer: string; paymentTxHash: string; success: boolean },
    signer: AnySigner,
  ): Promise<{ txHash: string }> {
    const serviceId = requireServiceId(input.serviceId);
    const paymentTxHash = input.paymentTxHash as Hash;
    const nonce = BigInt(input.nonce);
    const payer = normalizeAddress(input.payer) as `0x${string}`;
    const wallet = this.walletFor(signer);
    let hash: Hash;
    try {
      hash = await this.sendTx(wallet.account.address, (txNonce) => wallet.writeContract({
        address: this.registry(), abi: REGISTRY_ABI, functionName: 'recordAttestation',
        chain: this.chain, account: wallet.account, nonce: txNonce,
        args: [serviceId, nonce, payer, paymentTxHash, input.success],
      }));
    } catch (err) {
      // Measured, not assumed: for an already-mined duplicate this is the path
      // that fires. viem's pre-flight gas estimation reverts, so no transaction
      // is ever sent — hence the empty hash, which means "nothing to mine, the
      // attestation was already on-chain".
      if (isRevertNamed(err, 'DuplicateAttestation')) return { txHash: '' };
      throw err;
    }
    // And this is the path when the duplicate LOSES A RACE: both writes cleared
    // estimation, one reverted on execution, and a receipt carries no reason —
    // so ask the registry whether the payment ended up attested regardless.
    await this.settled(hash, 'recordAttestation', () => this.isAttested(serviceId, nonce, payer));
    return { txHash: hash };
  }

  async setActive(serviceId: number, active: boolean, signer: AnySigner): Promise<{ txHash: string }> {
    const wallet = this.walletFor(signer);
    const hash = await this.sendTx(wallet.account.address, (nonce) => wallet.writeContract({
      address: this.registry(), abi: REGISTRY_ABI, functionName: 'setActive',
      chain: this.chain, account: wallet.account, nonce,
      args: [requireServiceId(serviceId), active],
    }));
    await this.settled(hash, 'setActive');
    // `active` is part of every cached ServiceRecord, so a de-listing this
    // process just made must not keep being served as live.
    this.servicesCache = undefined;
    return { txHash: hash };
  }

  /**
   * Pay a 402 invoice through PaymentRouter. The service id and nonce travel as
   * INDEXED event topics, which is what makes verifyTransfer an exact match on
   * the pair — a bare value transfer carries no such binding.
   */
  async transfer(
    input: { to: string; amountWei: Wei; nonce: string; serviceId: number }, signer: AnySigner,
  ): Promise<{ txHash: string }> {
    const wallet = this.walletFor(signer);
    // Before moving value: prove the chain and the router are what we think.
    // A CALL with value to a codeless address succeeds and burns the funds.
    await this.assertChainIdentity();
    const router = this.router();
    const hash = await this.sendTx(wallet.account.address, (nonce) => wallet.writeContract({
      address: router, abi: PAYMENT_ROUTER_ABI, functionName: 'pay',
      chain: this.chain, account: wallet.account, nonce,
      value: BigInt(input.amountWei),
      args: [
        requireServiceId(input.serviceId), BigInt(input.nonce),
        normalizeAddress(input.to) as `0x${string}`,
      ],
    }));
    const receipt = await this.settled(hash, 'transfer');
    // `status: 'success'` is NOT proof the payment happened — it is also what a
    // call to an address with no code returns. The settlement only exists if
    // OUR router emitted Paid, which is the exact log verifyTransfer will later
    // look for. registerService already asserts its own event this way; the
    // money path is the one that most needed it.
    const paid = parseEventLogs({
      abi: PAYMENT_ROUTER_ABI, eventName: 'Paid', logs: receipt.logs,
    }).filter((e) => e.address.toLowerCase() === router.toLowerCase());
    if (paid.length === 0) {
      throw new AgentGateError(
        'PAYMENT_NOT_SETTLED',
        `transaction ${hash} mined successfully but emitted no Paid event from the router at ` +
          `${router}. The value has left the payer account and no invoice was settled — ` +
          'check that PAYMENT_ROUTER_ADDRESS is the router this chain actually hosts.',
        502,
      );
    }
    return { txHash: hash };
  }

  /**
   * EIP-191 sign `message` as `signer`, so the buyer can prove the X-PAYMENT
   * proof is theirs. Goes through walletFor(), which is where every guard about
   * the key never escaping already lives — a mock signer cannot sign here.
   */
  async signMessage(message: Uint8Array, signer: AnySigner): Promise<string> {
    const wallet = this.walletFor(signer);
    return wallet.account.signMessage({ message: { raw: message } });
  }

  /**
   * Confirm a PaymentRouter payment settles the given invoice.
   *
   * The `VerifyResult` reasons are the middleware's branching contract and are
   * preserved exactly — in particular `'pending'` (retryable) is returned for a
   * hash that is not yet mined or not yet propagated, so a buyer polling right
   * after paying is never told their valid payment does not exist.
   */
  async verifyTransfer(q: VerifyTransferQuery): Promise<VerifyResult> {
    if (!BYTES32_HEX_RE.test(q.txHash)) return { ok: false, reason: 'not_found' };

    // No receipt = unmined, or mined but not yet propagated to this node. That
    // is RETRYABLE, and the middleware keeps the same invoice alive on it —
    // calling it 'not_found' would tell a buyer who just paid correctly that
    // their payment does not exist.
    //
    // ONLY that one error maps to 'pending'. An unreachable or erroring node
    // throws something else and must propagate: swallowing it would answer
    // "still settling, retry in 2s" to every buyer for the whole outage, with
    // nothing in logs or metrics telling an operator the node is down.
    const receipt = await this.pub
      .getTransactionReceipt({ hash: q.txHash as Hash })
      .catch((err: unknown) => {
        if (err instanceof TransactionReceiptNotFoundError) return null;
        throw err;
      });
    if (receipt === null) return { ok: false, reason: 'pending' };
    // A reverted tx moved no funds — a settled negative, not something to retry.
    if (receipt.status !== 'success') return { ok: false, reason: 'not_found' };

    // The tx hash is supplied by the buyer, so the logs in this receipt are not
    // necessarily ours: keep only Paid logs actually emitted by OUR router, or
    // any contract could mint a look-alike event and pass verification.
    const routerAddress = this.router().toLowerCase();
    const events = parseEventLogs({
      abi: PAYMENT_ROUTER_ABI, eventName: 'Paid', logs: receipt.logs,
    }).filter((e) => e.address.toLowerCase() === routerAddress);
    if (events.length === 0) return { ok: false, reason: 'not_found' };

    const expectedTarget = normalizeAddress(q.expectedTarget);
    const toTarget = events.filter((e) => e.args.payTo.toLowerCase() === expectedTarget);
    if (toTarget.length === 0) return { ok: false, reason: 'wrong_target' };

    // One tx can carry several Paid logs to the same target; pick the one that
    // carries BOTH our service id and our nonce, then bind the amount/age
    // checks to it. Both are required: a nonce is unique only per service
    // (PaymentRouter.seenNonce is keyed on the pair), and payment targets are
    // shared across services here, so neither field disambiguates alone.
    const expectedNonce = BigInt(q.expectedNonce);
    const expectedServiceId = requireServiceId(q.serviceId);
    const match = toTarget.find(
      (e) => e.args.nonce === expectedNonce && e.args.serviceId === expectedServiceId,
    );
    if (!match) return { ok: false, reason: 'wrong_nonce' };

    if (match.args.amount < BigInt(q.minAmountWei)) return { ok: false, reason: 'amount_too_low' };

    const timestamp = Number(match.args.timestamp); // already MS on-chain
    if (Date.now() - timestamp > q.maxAgeMs) return { ok: false, reason: 'expired' };

    return {
      ok: true,
      amountWei: match.args.amount.toString(),
      from: match.args.payer.toLowerCase(),
      timestamp,
    };
  }
}
