import { AgentGateError } from './errors';
import { ogToWei } from './money';

export type AgentGateMode = 'mock' | 'live';

/** The shipped default admin token. loadConfig() refuses it in live mode. */
export const DEFAULT_ADMIN_TOKEN = 'dev-admin-token';

/**
 * The deployed contracts on 0G Galileo Testnet (chain 16602), deployed
 * 2026-08-31. These are the CLI's built-in defaults, which is what makes
 * `npx agentgate-0g list` work with no configuration at all.
 *
 * None of the three is upgradable — a redeploy is a NEW address with empty
 * state, so changing these values silently repoints every zero-config user at
 * a registry with no history. Treat an edit here as a breaking release.
 */
// The rotatable set (11ad4c7), deployed 2026-09-03 in block 52865624. This is
// not a preference: the Service struct grew from 11 fields to 17, so this repo's
// ABI cannot decode the previous deployment at all — reading it fails with
// `Bytes value "32" is not a valid boolean` as the decoder walks the wrong
// offsets. Code and contracts move together or not at all.
//
// That rule was written here after the FIRST time it was broken (the same
// failure, quoting "18" instead of "32") and broken again anyway, because
// nothing enforced it: 11ad4c7 regenerated abi.ts correctly and left these
// addresses pointing at the contract before it. It is enforced now —
// `abiHashes` below records the shape each address answers to, and
// e2e/registry-abi-pin.test.ts fails offline on any commit that moves one
// without the other.
//
// NOT yet shipped to npm: agentgate-0g 1.0.5 is the published version and it
// carries the PREVIOUS set, so `npx agentgate-0g list` keeps reading the old
// registry — which still holds its four services — until the next release.
// Cutting one is what moves zero-config users over.
export const DEFAULT_REGISTRY_ADDRESS = '0xDB3C29a09FdDe79828208603B743E769E9f6dBEe';
export const DEFAULT_PAYMENT_ROUTER_ADDRESS = '0xCC3bbd10eBA7aa24F4F722E00e714e1413182c34';
export const DEFAULT_SPEND_GUARD_ADDRESS = '0xfEA4236162d7126d90D59Dc15bBb8A93b3786938';

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
export const DEFAULT_ZG_RPC_URL = 'https://evmrpc-testnet.0g.ai';
export const DEFAULT_ZG_CHAIN_ID = 16602;
export const DEFAULT_ZG_NETWORK = '0g-galileo';
export const DEFAULT_ZG_EXPLORER_URL = 'https://chainscan-galileo.0g.ai';

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
 * `agentgate.mdloglabs.org` — no `0g-` — is the older CASPER deployment and is
 * deliberately NOT this value, the same trap DEFAULT_GATEWAY_URL warns about.
 * It is worse here than a dead link would be: that host serves the same numeric
 * service ids in CSPR and answers 200, so a seller who just registered on 0G
 * follows this link and reads a confident, entirely unrelated page with nothing
 * to signal the mistake. Asserted in packages/shared/test/config.test.ts.
 */
export const DEFAULT_DASHBOARD_URL = 'https://agentgate-0g.mdloglabs.org';


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
}

/**
 * `mainnet` intentionally carries EMPTY contract addresses: nothing is deployed
 * to 0G mainnet yet, and an empty address fails closed at the first use with
 * "not deployed" instead of silently reusing a testnet one. Fill these in as
 * part of the mainnet deploy, in the same commit that records the addresses.
 *
 * NOTE: the mainnet explorer host mirrors the testnet naming
 * (`chainscan-galileo.0g.ai` -> `chainscan.0g.ai`) and answers 200, but it could
 * not be confirmed programmatically as the mainnet instance. It is used only to
 * build display links, so a wrong value is a broken link rather than lost funds
 * — verify it before the first mainnet announcement.
 */
export const NETWORK_PROFILES: Record<string, NetworkProfile> = {
  galileo: {
    network: DEFAULT_ZG_NETWORK,
    chainId: DEFAULT_ZG_CHAIN_ID,
    rpcUrl: DEFAULT_ZG_RPC_URL,
    explorerUrl: DEFAULT_ZG_EXPLORER_URL,
    registry: DEFAULT_REGISTRY_ADDRESS,
    router: DEFAULT_PAYMENT_ROUTER_ADDRESS,
    spendGuard: DEFAULT_SPEND_GUARD_ADDRESS,
    abiHashes: {
      registry: 'f974c4c3f15160d727d3a2fee43c5fe1f1a441d787645bc7d1c66c9e0b5a3bf2',
      router: '5f2a6161970e2440ccab4813b4c7fc93cb9a04596de333d9b8efa60b61587b73',
      spendGuard: '485afa918375f547ec3a16816b14ce92d8ea68bdcf63f2937e13e8a3199a6b9d',
    },
  },
  mainnet: {
    network: '0g-mainnet',
    chainId: 16661,
    rpcUrl: 'https://evmrpc.0g.ai',
    explorerUrl: 'https://chainscan.0g.ai',
    registry: '',
    router: '',
    spendGuard: '',
    abiHashes: { registry: '', router: '', spendGuard: '' },
  },
};

/** The profile used when ZG_NETWORK_PROFILE is unset. */
export const DEFAULT_NETWORK_PROFILE = 'galileo';

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
  // live mode (0G Galileo Testnet)
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
  /** `eth_getLogs` lookback window (in blocks) for activity/history reads. */
  activityLookbackBlocks: number;
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
  // 1,000,000 blocks, not 50,000. 0G Galileo produces a block every ~0.5s, so
  // the old default was under SEVEN HOURS of history — a service busy yesterday
  // showed an empty activity ledger today, and nothing in the UI distinguished
  // "nothing happened" from "it aged out of the window". The public RPC returns
  // a 1,000,000-block eth_getLogs in the same ~0.8s it returns 10,000 (measured
  // against evmrpc-testnet.0g.ai), so the wider window is free. ~6 days here.
  const activityLookbackBlocks = readInt(env, 'ACTIVITY_LOOKBACK_BLOCKS', 1_000_000, 1, Number.MAX_SAFE_INTEGER);
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
