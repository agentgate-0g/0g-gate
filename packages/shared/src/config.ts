import { AgentGateError } from './errors';
import { ogToWei } from './money';

export type AgentGateMode = 'mock' | 'live';

/** The shipped default admin token. loadConfig() refuses it in live mode. */
export const DEFAULT_ADMIN_TOKEN = 'dev-admin-token';


/**
 * The router address mock mode advertises in its 402 invoices.
 *
 * Mock mode has no PaymentRouter — the devnet settles transfers itself and the
 * mock chain client never reads this. But `extra.router` is a REQUIRED invoice
 * field that the buyer client validates before paying, so a mock gateway that
 * left it empty would issue invoices no real buyer could act on: the offline
 * demo, `dev:seed` and `agentgate buy --mode mock` would all fail with
 * BAD_INVOICE while the gateway looked perfectly healthy.
 *
 * `0xmock…mock` is deliberately well-formed but obviously not a real contract,
 * so it can never be mistaken for a deployment in a log or a screenshot.
 */
export const MOCK_PAYMENT_ROUTER_ADDRESS = '0x0000000000000000000000000000000000004021';

/**
 * Default hosted gateway the CLI targets in live mode when `--gateway` is unset.
 * The owner-signature self-map endpoint lives here; override with `--gateway`
 * for a local/self-hosted gateway.
 *
 * This MUST be a gateway running against the same chain as
 * DEFAULT_REGISTRY_ADDRESS. `wrap` registers on-chain first and then asks this
 * gateway to map the upstream, so pointing it at a gateway on another network
 * leaves a registered-but-unmapped service: the registration is real and is not
 * rolled back, while `/svc/<id>` 404s. `gateway.mdloglabs.org` is the older
 * Casper deployment and is deliberately NOT this value.
 */
export const DEFAULT_GATEWAY_URL = 'https://0g-gateway.equiflow.xyz';

/**
 * Default hosted dashboard the CLI links to in live mode when printing the
 * service detail URL; mock mode links to http://localhost:<DASHBOARD_PORT>.
 *
 * `agentgate.mdloglabs.org` — the mdloglabs host, no `0g-` — is the older
 * CASPER deployment and is deliberately NOT this value, the same trap
 * DEFAULT_GATEWAY_URL warns about. It is worse here than a dead link would be:
 * that host serves the same numeric service ids in CSPR and answers 200, so a
 * seller who just registered on 0G follows this link and reads a confident,
 * entirely unrelated page with nothing to signal the mistake. The 0G dashboard
 * moved with the gateway to the equiflow.xyz tunnel on 2026-09-15; its previous
 * host, `agentgate-0g.mdloglabs.org`, no longer resolves at all. Asserted in
 * packages/shared/test/config.test.ts.
 */
export const DEFAULT_DASHBOARD_URL = 'https://agentgate.equiflow.xyz';


/**
 * A complete, self-consistent chain identity. The five values below only make
 * sense TOGETHER — an RPC from one network with a registry address from another
 * is not a configuration, it is a way to burn money — so they are selected as
 * one unit by name rather than as five independent environment variables.
 *
 * Before profiles existed there was no notion of "environment" at all: `live`
 * simply MEANT Galileo testnet, every chain value had a testnet default, and an
 * operator who repointed ZG_RPC_URL at mainnet and forgot the rest got a client
 * that read a testnet address on mainnet and paid into it.
 */
/**
 * Mirror of AgentGateRegistry.TERMS_CHANGE_DELAY_MS (15 minutes).
 *
 * A seller's payout address and price list change on a DELAY so a buyer who is
 * mid-payment cannot have the terms moved under them. That guarantee only holds
 * while the delay outlasts how stale the gateway's view of a service can be —
 * and the contract is immutable, so the delay can never be raised to catch up
 * with a configuration that outgrows it.
 */
const TERMS_CHANGE_DELAY_MS = 15 * 60 * 1000;

/** Mirror of the middleware's ServiceCache TTL (packages/middleware/src/service-cache.ts). */
const SERVICE_CACHE_TTL_MS = 60_000;

/**
 * The gateway's worst-case staleness is one service-cache lifetime plus one
 * invoice lifetime: it can price a 402 from a record read a cache-TTL ago, and
 * that quote then stands for the whole invoice TTL. If that total ever reaches
 * TERMS_CHANGE_DELAY_MS, a delayed terms change can mature while a quote issued
 * against the OLD terms is still payable — reopening exactly the bug the
 * on-chain delay exists to close.
 *
 * One safety margin is subtracted so the two are never merely equal.
 */
const TTL_SAFETY_MARGIN_MS = 60_000;
export const MAX_INVOICE_TTL_MS =
  TERMS_CHANGE_DELAY_MS - SERVICE_CACHE_TTL_MS - TTL_SAFETY_MARGIN_MS;

/**
 * sha256 of each contract ABI, as the recorded deployment actually answers to
 * it — `JSON.stringify` of the array in packages/chain/src/abi.ts, hashed.
 *
 * An address alone does not say WHICH VERSION of a contract lives there, and a
 * mismatched ABI does not fail loudly: viem decodes at the old offsets and
 * either returns convincing nonsense or throws about a type it never reached in
 * the source. Recording the shape next to the address is what lets
 * e2e/registry-abi-pin.test.ts catch, offline, an ABI that moved without a
 * redeploy. Written by scripts/set-deployment.ts, never by hand.
 */
export interface AbiHashes {
  registry: string;
  router: string;
  spendGuard: string;
}

export interface NetworkProfile {
  network: string;
  chainId: number;
  rpcUrl: string;
  explorerUrl: string;
  registry: string;
  router: string;
  spendGuard: string;
  abiHashes: AbiHashes;
  /**
   * The block the FIRST of the three contracts was created in — where every
   * `eth_getLogs` history read starts. A contract cannot emit before it
   * exists, so nothing is below this block, and anchoring reads here instead
   * of at `head - N` is what keeps a quiet week from emptying the activity
   * feed. 0 for an undeployed profile. Written by scripts/set-deployment.ts,
   * which finds it on the chain itself, never by hand.
   */
  deployBlock: number;
}

/**
 * The deployed contract sets, one per network, written by
 * scripts/set-deployment.ts only after it has verified the addresses, their
 * wiring, their ABI shape and their creation block against the chain itself.
 *
 * None of the contracts is upgradable — a redeploy is a NEW address with empty
 * state, so changing an address here silently repoints every zero-config user
 * at a registry with no history. Treat an edit as a breaking release. The
 * Service struct has also changed shape before (11 → 17 fields) without a
 * redeploy, which is why `abiHashes` records the shape each address answers
 * to and e2e/registry-abi-pin.test.ts fails offline on any commit that moves
 * one without the other.
 *
 * Galileo: deployed 2026-09-03 in block 52865624. Mainnet: deployed 2026-09-15
 * in blocks 44406357–44406358 by the same wallet, byte-identical (the ABI
 * hashes match), source verified on both explorers. An UNDEPLOYED profile must
 * carry empty addresses, so a live process fails closed with "not deployed"
 * instead of silently reusing another network's — that is how `mainnet` was
 * written until its deploy.
 */
export const NETWORK_PROFILES: Record<string, NetworkProfile> = {
  galileo: {
    network: '0g-galileo',
    chainId: 16602,
    rpcUrl: 'https://evmrpc-testnet.0g.ai',
    explorerUrl: 'https://chainscan-galileo.0g.ai',
    registry: '0xDB3C29a09FdDe79828208603B743E769E9f6dBEe',
    router: '0xCC3bbd10eBA7aa24F4F722E00e714e1413182c34',
    spendGuard: '0xfEA4236162d7126d90D59Dc15bBb8A93b3786938',
    abiHashes: {
      registry: 'f974c4c3f15160d727d3a2fee43c5fe1f1a441d787645bc7d1c66c9e0b5a3bf2',
      router: '5f2a6161970e2440ccab4813b4c7fc93cb9a04596de333d9b8efa60b61587b73',
      spendGuard: '485afa918375f547ec3a16816b14ce92d8ea68bdcf63f2937e13e8a3199a6b9d',
    },
    deployBlock: 52865624,
  },
  mainnet: {
    network: '0g-mainnet',
    chainId: 16661,
    rpcUrl: 'https://evmrpc.0g.ai',
    explorerUrl: 'https://chainscan.0g.ai',
    registry: '0x48144BF9d966789bf4Db4e84349d4F4878a4b7Da',
    router: '0x5102EB216b65CF950D3e88c8ddD51008de0845eF',
    spendGuard: '0xDfD0f8eE32Cb01015cD131d463E83e6974A9D761',
    abiHashes: {
      registry: 'f974c4c3f15160d727d3a2fee43c5fe1f1a441d787645bc7d1c66c9e0b5a3bf2',
      router: '5f2a6161970e2440ccab4813b4c7fc93cb9a04596de333d9b8efa60b61587b73',
      spendGuard: '485afa918375f547ec3a16816b14ce92d8ea68bdcf63f2937e13e8a3199a6b9d',
    },
    deployBlock: 44406357,
  },
};

/**
 * The profile used when ZG_NETWORK_PROFILE is unset — what `npx agentgate-0g`
 * with no configuration talks to, and what the hosted gateway and dashboard
 * serve. Mainnet since 2026-09-15: the public hosts (0g-gateway.equiflow.xyz,
 * agentgate.equiflow.xyz) moved to the mainnet deployment that day, and a
 * default that still named Galileo would `wrap` on one chain and map the
 * upstream on a gateway serving the other. Galileo stays fully supported
 * behind `ZG_NETWORK_PROFILE=galileo`.
 */
export const DEFAULT_NETWORK_PROFILE = 'mainnet';

/**
 * The default profile's values, exported under the names the CLI and SDK have
 * always used for "the zero-config chain". They FOLLOW the default profile:
 * before 2026-09-15 they were the Galileo literals, and any consumer that
 * wanted Galileo specifically should read NETWORK_PROFILES.galileo instead.
 */
const DEFAULT_PROFILE: NetworkProfile = NETWORK_PROFILES[DEFAULT_NETWORK_PROFILE]!;
export const DEFAULT_ZG_RPC_URL = DEFAULT_PROFILE.rpcUrl;
export const DEFAULT_ZG_CHAIN_ID = DEFAULT_PROFILE.chainId;
export const DEFAULT_ZG_NETWORK = DEFAULT_PROFILE.network;
export const DEFAULT_ZG_EXPLORER_URL = DEFAULT_PROFILE.explorerUrl;
export const DEFAULT_REGISTRY_ADDRESS = DEFAULT_PROFILE.registry;
export const DEFAULT_PAYMENT_ROUTER_ADDRESS = DEFAULT_PROFILE.router;
export const DEFAULT_SPEND_GUARD_ADDRESS = DEFAULT_PROFILE.spendGuard;

export function networkProfile(name: string): NetworkProfile {
  const found = NETWORK_PROFILES[name];
  if (!found) {
    throw new AgentGateError(
      'CONFIG_INVALID',
      `unknown ZG_NETWORK_PROFILE ${JSON.stringify(name)} — known profiles: ` +
        `${Object.keys(NETWORK_PROFILES).join(', ')}`,
      500,
    );
  }
  return found;
}

export interface AgentGateConfig {
  mode: AgentGateMode;
  // ports
  devnetPort: number;
  oraclePort: number;
  middlewarePort: number;
  dashboardPort: number;
  // mock mode
  devnetUrl: string;
  mockBuyerAccount: string;
  mockSellerAccount: string;
  // middleware
  adminToken: string;
  invoiceTtlMs: number;
  /**
   * How long after issuance a SETTLED payment may still be redeemed.
   *
   * The invoice TTL bounds how long the quoted price is honoured; this bounds
   * how long the buyer has to come back and collect. They are not the same
   * thing, and conflating them lost money: a payment confirmed on-chain inside
   * the TTL but PRESENTED after it was refused without the chain ever being
   * read, and PaymentRouter forwards msg.value to the seller in the same
   * transaction — there is no refund. Slow settlement, a client retry, or a
   * gateway restart must not be the difference between paying and being served.
   */
  invoiceRedemptionWindowMs: number;
  upstreamTimeoutMs: number;
  /**
   * Number of trusted reverse-proxy hops in front of the gateway (Express
   * `trust proxy`). 0 = trust none (req.ip is the direct socket peer). Behind a
   * single platform proxy (Railway/Vercel) set TRUST_PROXY=1 so rate limiting
   * keys off the real client IP. Never set this higher than the real hop count
   * or X-Forwarded-For becomes spoofable.
   */
  trustProxy: number;
  // live mode (0G — the ZG_NETWORK_PROFILE network: mainnet by default, or galileo)
  zgRpcUrl: string;
  /**
   * How long to keep asking for a transaction receipt before reporting it
   * unconfirmed.
   *
   * 0G reports a block before its receipts are queryable and the public RPC is
   * load-balanced, so "not found" routinely means "not from this peer yet".
   * Giving up on the first miss is what let a paid call return
   * TX_RECEIPT_UNCONFIRMED for a transfer that had already succeeded — the
   * buyer paid and was served nothing.
   */
  zgReceiptTimeoutMs: number;
  zgChainId: number;
  zgNetwork: string;
  zgExplorerUrl: string;
  registryContractAddress: string;
  paymentRouterAddress: string;
  spendGuardAddress: string;
  /**
   * The first block any `eth_getLogs` history read covers: the block the
   * contracts were deployed in. Nothing they emitted can be below it, so a
   * read anchored here sees the deployment's WHOLE history however long the
   * service has been quiet. See NetworkProfile.deployBlock.
   */
  contractsDeployBlock: number;
  /**
   * Optional cap, in blocks back from the head, on how far a history read
   * reaches — `null` (the default) means all the way to `contractsDeployBlock`.
   * Only for an RPC that rejects wide `eth_getLogs` ranges; both 0G RPCs
   * answer a deploy-to-head query in well under a second. A cap reintroduces
   * the failure it bounds: anything older than it is invisible.
   */
  activityLookbackBlocks: number | null;
  gateSignerKey: string;
  buyerSignerKey: string;
  sellerSignerKey: string;
  // LLM
  anthropicApiKey: string;
  llmModel: string;
  // oracle
  oracleStatic: boolean;
  // buyer agent
  buyerBudgetOg: string;
}

type Env = Record<string, string | undefined>;

function configError(message: string): AgentGateError {
  return new AgentGateError('CONFIG_INVALID', message, 500);
}

/** Read an env var; empty/whitespace-only values count as unset. */
function readStr(env: Env, key: string, fallback: string): string {
  const raw = env[key];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  return trimmed === '' ? fallback : trimmed;
}

function readInt(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = readStr(env, key, String(fallback));
  if (!/^\d+$/.test(raw)) {
    throw configError(`${key} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw configError(`${key} must be an integer between ${min} and ${max}, got ${raw}`);
  }
  return value;
}

function readPort(env: Env, key: string, fallback: number): number {
  return readInt(env, key, fallback, 0, 65535);
}

function readUrl(env: Env, key: string, fallback: string, protocols: readonly string[]): string {
  const raw = readStr(env, key, fallback);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw configError(`${key} must be a valid URL, got ${JSON.stringify(raw)}`);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw configError(`${key} must use one of [${protocols.join(', ')}], got ${parsed.protocol}`);
  }
  return raw;
}

function readBool01(env: Env, key: string, fallback: boolean): boolean {
  const raw = readStr(env, key, fallback ? '1' : '0').toLowerCase();
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  throw configError(`${key} must be 0/1 (or true/false), got ${JSON.stringify(raw)}`);
}

const PRIVATE_KEY_RE = /^0x[0-9a-f]{64}$/i;

/**
 * Read a signer private key. Empty is allowed (read-only commands need no key);
 * anything present must be exactly 0x + 64 hex. NEVER include the value in the
 * error message — a malformed key must not leak into logs.
 */
function readPrivateKey(env: Env, key: string): string {
  const raw = readStr(env, key, '');
  if (raw === '') return '';
  if (!PRIVATE_KEY_RE.test(raw)) {
    throw configError(`${key} must be a 0x-prefixed 32-byte hex private key`);
  }
  return raw.toLowerCase();
}

/**
 * Reads and validates the AgentGate environment contract (SPEC §1) once.
 * Throws AgentGateError('CONFIG_INVALID') on invalid values or combos:
 * - unknown AGENTGATE_MODE
 * - live mode with the default admin token
 * - a malformed signer private key or registry contract address
 */
export function loadConfig(
  env: Env = process.env,
  opts: { requireStrongAdminToken?: boolean } = {},
): AgentGateConfig {
  const requireStrongAdminToken = opts.requireStrongAdminToken ?? true;
  const modeRaw = readStr(env, 'AGENTGATE_MODE', 'mock');
  if (modeRaw !== 'mock' && modeRaw !== 'live') {
    throw configError(`AGENTGATE_MODE must be "mock" or "live", got ${JSON.stringify(modeRaw)}`);
  }
  const mode: AgentGateMode = modeRaw;

  const devnetPort = readPort(env, 'DEVNET_PORT', 4030);
  const oraclePort = readPort(env, 'ORACLE_PORT', 4010);
  const middlewarePort = readPort(env, 'MIDDLEWARE_PORT', 4021);
  const dashboardPort = readPort(env, 'DASHBOARD_PORT', 3000);

  const devnetUrl = readUrl(env, 'DEVNET_URL', `http://localhost:${devnetPort}`, ['http:', 'https:']);

  const adminToken = readStr(env, 'AGENTGATE_ADMIN_TOKEN', DEFAULT_ADMIN_TOKEN);
  const invoiceTtlMs = readInt(env, 'INVOICE_TTL_MS', 300_000, 1, MAX_INVOICE_TTL_MS);
  // 24h by default: generous, because the cost of it being too SHORT is a buyer
  // who paid and cannot collect, while the cost of it being too long is only a
  // slightly larger invoice file.
  const invoiceRedemptionWindowMs = readInt(
    env, 'INVOICE_REDEMPTION_WINDOW_MS', 86_400_000, 1, Number.MAX_SAFE_INTEGER,
  );
  if (invoiceRedemptionWindowMs < invoiceTtlMs) {
    throw configError(
      `INVOICE_REDEMPTION_WINDOW_MS (${invoiceRedemptionWindowMs}) must be >= INVOICE_TTL_MS ` +
        `(${invoiceTtlMs}) — a redemption window shorter than the quote window means a payment ` +
        'made against a still-valid invoice can never be collected',
    );
  }
  const upstreamTimeoutMs = readInt(env, 'UPSTREAM_TIMEOUT_MS', 30_000, 1, Number.MAX_SAFE_INTEGER);
  const trustProxy = readInt(env, 'TRUST_PROXY', 0, 0, 10);

  // The chain identity comes from ONE named profile, so the five values below
  // move together. Individual vars still override for a custom/self-hosted
  // deployment, but the DEFAULTS are never a mix of two networks.
  const profile = networkProfile(readStr(env, 'ZG_NETWORK_PROFILE', DEFAULT_NETWORK_PROFILE));
  const zgRpcUrl = readUrl(env, 'ZG_RPC_URL', profile.rpcUrl, ['http:', 'https:']);
  const zgReceiptTimeoutMs = readInt(env, 'ZG_RECEIPT_TIMEOUT_MS', 180_000, 1_000, Number.MAX_SAFE_INTEGER);
  const zgChainId = readInt(env, 'ZG_CHAIN_ID', profile.chainId, 1, Number.MAX_SAFE_INTEGER);
  const zgNetwork = readStr(env, 'ZG_NETWORK', profile.network);
  const zgExplorerUrl = readUrl(env, 'ZG_EXPLORER_URL', profile.explorerUrl, ['http:', 'https:']);
  const registryContractAddress = readStr(env, 'REGISTRY_CONTRACT_ADDRESS', profile.registry);
  // Mock mode falls back to a placeholder router so its 402s stay payable by a
  // real client (see MOCK_PAYMENT_ROUTER_ADDRESS); live mode falls back to the
  // deployed address, and createApp() refuses to boot live without a real one.
  const paymentRouterAddress = readStr(
    env,
    'PAYMENT_ROUTER_ADDRESS',
    mode === 'mock' ? MOCK_PAYMENT_ROUTER_ADDRESS : profile.router,
  );
  const spendGuardAddress = readStr(env, 'SPEND_GUARD_ADDRESS', profile.spendGuard);
  // History reads start at the deploy block, not at `head - N`. A rolling
  // window empties as soon as the service is idle longer than the window:
  // 50,000 blocks (seven hours at 0G's ~0.5 s blocks) did that, was raised to
  // 1,000,000 (six days), and did it again a week later — the feed went blank
  // and every attestation older than the window lost its tx hash, while the
  // chain still had all of it. The profile's block describes the PROFILE's
  // registry only: an operator's own deployment was created somewhere else, so
  // an overridden registry starts at genesis unless CONTRACTS_DEPLOY_BLOCK says
  // where. Genesis is safe — both 0G RPCs serve a full-chain eth_getLogs in
  // under a second — it just scans blocks that hold nothing.
  const contractsDeployBlock = readInt(
    env,
    'CONTRACTS_DEPLOY_BLOCK',
    registryContractAddress.toLowerCase() === profile.registry.toLowerCase() ? profile.deployBlock : 0,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  // Unset (the default) means "all the way back to the deploy block". The cap
  // exists only for an RPC that refuses wide getLogs ranges, and it brings the
  // blank-feed failure back in proportion to how tight it is, which is why the
  // dashboard says so whenever one is configured.
  const activityLookbackBlocks =
    readStr(env, 'ACTIVITY_LOOKBACK_BLOCKS', '') === ''
      ? null
      : readInt(env, 'ACTIVITY_LOOKBACK_BLOCKS', 1, 1, Number.MAX_SAFE_INTEGER);
  const gateSignerKey = readPrivateKey(env, 'GATE_SIGNER_KEY');
  const buyerSignerKey = readPrivateKey(env, 'BUYER_SIGNER_KEY');
  const sellerSignerKey = readPrivateKey(env, 'SELLER_SIGNER_KEY');

  const anthropicApiKey = readStr(env, 'ANTHROPIC_API_KEY', '');
  const llmModel = readStr(env, 'LLM_MODEL', 'claude-sonnet-4-6');

  const oracleStatic = readBool01(env, 'ORACLE_STATIC', false);

  const buyerBudgetOg = readStr(env, 'BUYER_BUDGET_OG', '5');
  try {
    ogToWei(buyerBudgetOg);
  } catch {
    throw configError(
      `BUYER_BUDGET_OG must be a non-negative OG decimal string (max 18 dp), got ${JSON.stringify(buyerBudgetOg)}`,
    );
  }

  const mockBuyerAccount = readStr(env, 'MOCK_BUYER_ACCOUNT', '');
  const mockSellerAccount = readStr(env, 'MOCK_SELLER_ACCOUNT', '');

  if (mode === 'live') {
    if (requireStrongAdminToken && adminToken === DEFAULT_ADMIN_TOKEN) {
      throw configError(
        'live mode refuses the default AGENTGATE_ADMIN_TOKEN — set a strong unique token',
      );
    }
    if (registryContractAddress !== '' && !/^0x[0-9a-f]{40}$/i.test(registryContractAddress)) {
      throw configError('REGISTRY_CONTRACT_ADDRESS must be a 0x-prefixed EVM address');
    }
  }

  return {
    mode,
    devnetPort,
    oraclePort,
    middlewarePort,
    dashboardPort,
    devnetUrl,
    mockBuyerAccount,
    mockSellerAccount,
    adminToken,
    invoiceTtlMs,
    invoiceRedemptionWindowMs,
    upstreamTimeoutMs,
    trustProxy,
    zgRpcUrl,
    zgReceiptTimeoutMs,
    zgChainId,
    zgNetwork,
    zgExplorerUrl,
    registryContractAddress,
    paymentRouterAddress,
    spendGuardAddress,
    contractsDeployBlock,
    activityLookbackBlocks,
    gateSignerKey,
    buyerSignerKey,
    sellerSignerKey,
    anthropicApiKey,
    llmModel,
    oracleStatic,
    buyerBudgetOg,
  };
}
