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
// The audited set, deployed 2026-09-01 in block 52458928. This is not a
// preference: the Service struct gained `pendingAttestor` and
// `attestorEffectiveAt`, so this repo's ABI can no longer decode the previous
// deployment at all — reading it fails with `Bytes value "18" is not a valid
// boolean` as the decoder walks the wrong offsets. Code and contracts move
// together or not at all.
//
// The published npm package still carries the previous addresses, so the
// zero-config `npx agentgate-0g list` path is unaffected until a release.
export const DEFAULT_REGISTRY_ADDRESS = '0x73bf79e35D33Acc944542E9DA3f17058e48DE4E1';
export const DEFAULT_PAYMENT_ROUTER_ADDRESS = '0xE7C2C116869c0838Fd6dcD5FFE49F4Ac93fe1B8F';
export const DEFAULT_SPEND_GUARD_ADDRESS = '0xBb79CaB7b02f6C0301E7E87bdDC10D4F9F5DC781';

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
export const DEFAULT_GATEWAY_URL = 'https://0g-gateway.mdloglabs.org';

/**
 * Default hosted dashboard the CLI links to in live mode when printing the
 * service detail URL; mock mode links to http://localhost:<DASHBOARD_PORT>.
 */
export const DEFAULT_DASHBOARD_URL = 'https://agentgate.mdloglabs.org';

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
  const invoiceTtlMs = readInt(env, 'INVOICE_TTL_MS', 300_000, 1, Number.MAX_SAFE_INTEGER);
  const upstreamTimeoutMs = readInt(env, 'UPSTREAM_TIMEOUT_MS', 30_000, 1, Number.MAX_SAFE_INTEGER);
  const trustProxy = readInt(env, 'TRUST_PROXY', 0, 0, 10);

  const zgRpcUrl = readUrl(env, 'ZG_RPC_URL', DEFAULT_ZG_RPC_URL, ['http:', 'https:']);
  const zgChainId = readInt(env, 'ZG_CHAIN_ID', DEFAULT_ZG_CHAIN_ID, 1, Number.MAX_SAFE_INTEGER);
  const zgNetwork = readStr(env, 'ZG_NETWORK', DEFAULT_ZG_NETWORK);
  const zgExplorerUrl = readUrl(env, 'ZG_EXPLORER_URL', DEFAULT_ZG_EXPLORER_URL, ['http:', 'https:']);
  const registryContractAddress = readStr(env, 'REGISTRY_CONTRACT_ADDRESS', DEFAULT_REGISTRY_ADDRESS);
  // Mock mode falls back to a placeholder router so its 402s stay payable by a
  // real client (see MOCK_PAYMENT_ROUTER_ADDRESS); live mode falls back to the
  // deployed address, and createApp() refuses to boot live without a real one.
  const paymentRouterAddress = readStr(
    env,
    'PAYMENT_ROUTER_ADDRESS',
    mode === 'mock' ? MOCK_PAYMENT_ROUTER_ADDRESS : DEFAULT_PAYMENT_ROUTER_ADDRESS,
  );
  const spendGuardAddress = readStr(env, 'SPEND_GUARD_ADDRESS', DEFAULT_SPEND_GUARD_ADDRESS);
  const activityLookbackBlocks = readInt(env, 'ACTIVITY_LOOKBACK_BLOCKS', 50_000, 1, Number.MAX_SAFE_INTEGER);
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
    upstreamTimeoutMs,
    trustProxy,
    zgRpcUrl,
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
