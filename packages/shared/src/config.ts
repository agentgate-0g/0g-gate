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
// Shipped to npm in 1.0.4, so the zero-config `npx agentgate-0g list` path
// reads this set too.
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

export interface NetworkProfile {
  network: string;
  chainId: number;
  rpcUrl: string;
  explorerUrl: string;
  registry: string;
  router: string;
  spendGuard: string;
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
  },
  mainnet: {
    network: '0g-mainnet',
    chainId: 16661,
    rpcUrl: 'https://evmrpc.0g.ai',
    explorerUrl: 'https://chainscan.0g.ai',
    registry: '',
    router: '',
    spendGuard: '',
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
