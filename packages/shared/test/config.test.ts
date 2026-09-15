import { describe, expect, it } from 'vitest';
import {
  AgentGateError,
  DEFAULT_ADMIN_TOKEN,
  DEFAULT_ZG_CHAIN_ID,
  DEFAULT_ZG_EXPLORER_URL,
  DEFAULT_DASHBOARD_URL,
  DEFAULT_GATEWAY_URL,
  DEFAULT_ZG_NETWORK,
  DEFAULT_PAYMENT_ROUTER_ADDRESS,
  DEFAULT_REGISTRY_ADDRESS,
  DEFAULT_ZG_RPC_URL,
  NETWORK_PROFILES,
  MAX_INVOICE_TTL_MS,
  MOCK_PAYMENT_ROUTER_ADDRESS,
  loadConfig,
} from '../src/index';

describe('loadConfig — mock mode defaults', () => {
  it('loads all defaults from an empty env', () => {
    const cfg = loadConfig({});
    expect(cfg.mode).toBe('mock');
    expect(cfg.devnetPort).toBe(4030);
    expect(cfg.oraclePort).toBe(4010);
    expect(cfg.middlewarePort).toBe(4021);
    expect(cfg.dashboardPort).toBe(3000);
    expect(cfg.devnetUrl).toBe('http://localhost:4030');
    expect(cfg.adminToken).toBe(DEFAULT_ADMIN_TOKEN);
    expect(cfg.invoiceTtlMs).toBe(300000);
    expect(cfg.upstreamTimeoutMs).toBe(30000);
    expect(cfg.zgRpcUrl).toBe(DEFAULT_ZG_RPC_URL);
    expect(cfg.zgChainId).toBe(DEFAULT_ZG_CHAIN_ID);
    expect(cfg.zgNetwork).toBe(DEFAULT_ZG_NETWORK);
    expect(cfg.gateSignerKey).toBe('');
    expect(cfg.llmModel).toBe('claude-sonnet-4-6');
    expect(cfg.oracleStatic).toBe(false);
    expect(cfg.buyerBudgetOg).toBe('5');
  });

  it('mock mode tolerates the default admin token and no signer keys', () => {
    expect(() => loadConfig({ AGENTGATE_MODE: 'mock' })).not.toThrow();
  });

  it('treats empty-string env values as unset (matches .env.example blanks)', () => {
    // The point is the FALLBACK, not the value: a blank line in .env must not
    // be taken literally, it must fall through to the built-in default. Signer
    // keys have no default (blank stays blank); the registry does, which is
    // what makes the published CLI work with an empty environment.
    const cfg = loadConfig({ GATE_SIGNER_KEY: '', REGISTRY_CONTRACT_ADDRESS: '' });
    expect(cfg.gateSignerKey).toBe('');
    expect(cfg.registryContractAddress).toBe(DEFAULT_REGISTRY_ADDRESS);
    expect(cfg.registryContractAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('derives DEVNET_URL default from DEVNET_PORT', () => {
    const cfg = loadConfig({ DEVNET_PORT: '5555' });
    expect(cfg.devnetUrl).toBe('http://localhost:5555');
  });

  it('parses overrides', () => {
    const cfg = loadConfig({
      ORACLE_STATIC: '1',
      BUYER_BUDGET_OG: '2.5',
      INVOICE_TTL_MS: '1000',
      LOG_LEVEL: 'debug',
    });
    expect(cfg.oracleStatic).toBe(true);
    expect(cfg.buyerBudgetOg).toBe('2.5');
    expect(cfg.invoiceTtlMs).toBe(1000);
  });
});

describe('loadConfig — 0G network defaults', () => {
  it('the DEFAULT_* constants are the default profile — 0G Mainnet since 2026-09-15', () => {
    // The public gateway and dashboard serve mainnet, and the CLI's zero-config
    // chain must be the one its default gateway settles on.
    expect(DEFAULT_ZG_RPC_URL).toBe('https://evmrpc.0g.ai');
    expect(DEFAULT_ZG_CHAIN_ID).toBe(16661);
    expect(DEFAULT_ZG_NETWORK).toBe('0g-mainnet');
    expect(DEFAULT_ZG_EXPLORER_URL).toBe('https://chainscan.0g.ai');
    expect(DEFAULT_REGISTRY_ADDRESS).toBe(NETWORK_PROFILES.mainnet!.registry);
  });

  it('keeps the verified 0G Galileo Testnet values behind the galileo profile', () => {
    const galileo = NETWORK_PROFILES.galileo!;
    expect(galileo.rpcUrl).toBe('https://evmrpc-testnet.0g.ai');
    expect(galileo.chainId).toBe(16602);
    expect(galileo.network).toBe('0g-galileo');
    expect(galileo.explorerUrl).toBe('https://chainscan-galileo.0g.ai');
  });
});

describe('loadConfig — validation failures', () => {
  it('rejects an unknown mode', () => {
    expect(() => loadConfig({ AGENTGATE_MODE: 'prod' })).toThrow(AgentGateError);
  });

  it('rejects malformed ports and integers', () => {
    expect(() => loadConfig({ DEVNET_PORT: 'abc' })).toThrow(AgentGateError);
    expect(() => loadConfig({ MIDDLEWARE_PORT: '70000' })).toThrow(AgentGateError);
    expect(() => loadConfig({ INVOICE_TTL_MS: '-5' })).toThrow(AgentGateError);
    expect(() => loadConfig({ UPSTREAM_TIMEOUT_MS: '0' })).toThrow(AgentGateError);
  });

  it('rejects malformed URLs', () => {
    expect(() => loadConfig({ DEVNET_URL: 'not-a-url' })).toThrow(AgentGateError);
    expect(() => loadConfig({ ZG_RPC_URL: 'not-a-url' })).toThrow(AgentGateError);
  });

  it('rejects a malformed buyer budget', () => {
    expect(() => loadConfig({ BUYER_BUDGET_OG: '-1' })).toThrow(AgentGateError);
    expect(() => loadConfig({ BUYER_BUDGET_OG: '1.0000000000000000001' })).toThrow(AgentGateError);
  });
});

describe('loadConfig — live mode combos', () => {
  it('live mode no longer requires an indexer API key', () => {
    const cfg = loadConfig(
      { AGENTGATE_MODE: 'live', AGENTGATE_ADMIN_TOKEN: 'strong-token-xyz' },
      { requireStrongAdminToken: true },
    );
    expect(cfg.mode).toBe('live');
    expect(cfg.zgRpcUrl).toBe(DEFAULT_ZG_RPC_URL);
    expect(cfg.zgChainId).toBe(DEFAULT_ZG_CHAIN_ID);
    expect(cfg.zgNetwork).toBe(DEFAULT_ZG_NETWORK);
  });

  it('throws in live mode with the default admin token (explicit)', () => {
    expect(() =>
      loadConfig({
        AGENTGATE_MODE: 'live',
        AGENTGATE_ADMIN_TOKEN: DEFAULT_ADMIN_TOKEN,
      }),
    ).toThrow(/ADMIN_TOKEN/);
  });

  it('throws in live mode with the default admin token (implicit via default)', () => {
    expect(() => loadConfig({ AGENTGATE_MODE: 'live' })).toThrow(/ADMIN_TOKEN/);
  });

  it('accepts live mode with a non-default admin token', () => {
    const cfg = loadConfig({
      AGENTGATE_MODE: 'live',
      AGENTGATE_ADMIN_TOKEN: 'a-strong-unique-token',
    });
    expect(cfg.mode).toBe('live');
    expect(cfg.adminToken).toBe('a-strong-unique-token');
  });

  it('config errors carry the CONFIG_INVALID code', () => {
    try {
      loadConfig({ AGENTGATE_MODE: 'live' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentGateError);
      expect((err as AgentGateError).code).toBe('CONFIG_INVALID');
      expect((err as AgentGateError).httpStatus).toBe(500);
    }
  });

  it('rejects a malformed signer key without echoing it', () => {
    expect(() => loadConfig({ GATE_SIGNER_KEY: '0xdeadbeef' }))
      .toThrow(/GATE_SIGNER_KEY must be a 0x-prefixed 32-byte hex private key/);
    expect(() => loadConfig({ GATE_SIGNER_KEY: '0xdeadbeef' }))
      .not.toThrow(/deadbeef/); // value never repeated back, not even once
  });

  it('accepts a well-formed signer key and normalizes mixed-case hex to lowercase', () => {
    const lower = '0x' + 'ab'.repeat(32);
    const cfg = loadConfig({ GATE_SIGNER_KEY: lower });
    expect(cfg.gateSignerKey).toBe(lower);

    const mixedCase = '0x' + 'AABBCCDD'.repeat(8);
    const cfgMixed = loadConfig({ BUYER_SIGNER_KEY: mixedCase });
    expect(cfgMixed.buyerSignerKey).toBe(mixedCase.toLowerCase());
  });

  it('rejects a non-address registry in live mode', () => {
    expect(() => loadConfig({
      AGENTGATE_MODE: 'live',
      AGENTGATE_ADMIN_TOKEN: 'strong-token-xyz',
      REGISTRY_CONTRACT_ADDRESS: 'hash-abc',
    })).toThrow(/REGISTRY_CONTRACT_ADDRESS/);
  });
});

describe('loadConfig — requireStrongAdminToken opt-out (CLI reads)', () => {
  it('still enforces the strong admin token in live mode by default', () => {
    expect(() =>
      loadConfig({ AGENTGATE_MODE: 'live', AGENTGATE_ADMIN_TOKEN: DEFAULT_ADMIN_TOKEN }),
    ).toThrow(/ADMIN_TOKEN/);
  });

  it('allows live mode with the default admin token when requireStrongAdminToken is false', () => {
    const cfg = loadConfig({ AGENTGATE_MODE: 'live' }, { requireStrongAdminToken: false });
    expect(cfg.mode).toBe('live');
    expect(cfg.adminToken).toBe(DEFAULT_ADMIN_TOKEN);
  });
});

describe('paymentRouterAddress', () => {
  it('mock mode falls back to the placeholder router so its 402s stay payable', () => {
    const cfg = loadConfig({ AGENTGATE_MODE: 'mock' });
    // A 402 whose extra.router is empty is rejected by the buyer client as
    // BAD_INVOICE, so an empty default here silently breaks the whole offline
    // demo path while the gateway still looks healthy.
    expect(cfg.paymentRouterAddress).toBe(MOCK_PAYMENT_ROUTER_ADDRESS);
    expect(cfg.paymentRouterAddress).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it('live mode gets the DEPLOYED router, never mock mode\'s placeholder', () => {
    const cfg = loadConfig(
      { AGENTGATE_MODE: 'live', AGENTGATE_ADMIN_TOKEN: 'a-strong-token' },
      { requireStrongAdminToken: false },
    );
    expect(cfg.paymentRouterAddress).toBe(DEFAULT_PAYMENT_ROUTER_ADDRESS);
    // The placeholder exists only so mock 402s stay parseable; a live gateway
    // inheriting it would advertise a router that holds no code, and every
    // buyer's payment would revert.
    expect(cfg.paymentRouterAddress).not.toBe(MOCK_PAYMENT_ROUTER_ADDRESS);
  });

  it('an explicit PAYMENT_ROUTER_ADDRESS wins in either mode', () => {
    const addr = `0x${'ab'.repeat(20)}`;
    expect(
      loadConfig({ AGENTGATE_MODE: 'mock', PAYMENT_ROUTER_ADDRESS: addr }).paymentRouterAddress,
    ).toBe(addr);
  });

});

describe('history window', () => {
  it('is anchored at the deploy block and uncapped by default', () => {
    // A rolling window empties the moment a service is idle longer than it.
    // 50,000 blocks (seven hours at 0G's ~0.5 s blocks) did exactly that, was
    // raised to 1,000,000 (six days), and did it again a week later. Both 0G
    // RPCs answer a deploy-to-head eth_getLogs in under a second, so a cap buys
    // nothing here — the feed starts where the contracts do.
    const cfg = loadConfig({ AGENTGATE_MODE: 'mock' });
    expect(cfg.activityLookbackBlocks).toBeNull();
    expect(cfg.contractsDeployBlock).toBe(NETWORK_PROFILES.mainnet!.deployBlock);
    expect(cfg.contractsDeployBlock).toBeGreaterThan(0);
  });

  it('ACTIVITY_LOOKBACK_BLOCKS is an opt-in cap for a range-limited RPC', () => {
    expect(loadConfig({ ACTIVITY_LOOKBACK_BLOCKS: '250' }).activityLookbackBlocks).toBe(250);
    // Blank means unset, as for every other var — NOT a zero-block window.
    expect(loadConfig({ ACTIVITY_LOOKBACK_BLOCKS: '' }).activityLookbackBlocks).toBeNull();
    // A zero-block cap can only ever return nothing; refuse it rather than
    // ship a feed that is empty by configuration.
    expect(() => loadConfig({ ACTIVITY_LOOKBACK_BLOCKS: '0' })).toThrow(/ACTIVITY_LOOKBACK_BLOCKS/);
  });

  it('the profile deploy block describes the PROFILE registry only', () => {
    // An operator who points REGISTRY_CONTRACT_ADDRESS at their own deployment
    // has a contract created in some other block. Starting their history at
    // OUR deploy block would silently drop everything their registry emitted
    // before it, so an overridden registry starts at genesis unless told where
    // it was deployed.
    const other = `0x${'42'.repeat(20)}`;
    expect(loadConfig({ REGISTRY_CONTRACT_ADDRESS: other }).contractsDeployBlock).toBe(0);
    expect(
      loadConfig({ REGISTRY_CONTRACT_ADDRESS: other, CONTRACTS_DEPLOY_BLOCK: '123456' }).contractsDeployBlock,
    ).toBe(123456);
    // The profile's own registry keeps its block however the address is spelled.
    expect(
      loadConfig({ REGISTRY_CONTRACT_ADDRESS: DEFAULT_REGISTRY_ADDRESS.toLowerCase() }).contractsDeployBlock,
    ).toBe(NETWORK_PROFILES.mainnet!.deployBlock);
    // And an explicit block always wins.
    expect(loadConfig({ CONTRACTS_DEPLOY_BLOCK: '7' }).contractsDeployBlock).toBe(7);
  });
});

describe('hosted default URLs point at the 0G deployment', () => {
  // `agentgate.mdloglabs.org` (no `0g-`) and `gateway.mdloglabs.org` are the
  // OLDER CASPER deployment, still running alongside this one. They answer 200
  // for the same numeric service ids in CSPR, so a wrong constant here does not
  // 404 — it renders a confident, entirely unrelated page. That silence is why
  // this is asserted rather than left to review.
  const CASPER_HOSTS = [/(^|\/\/)agentgate\.mdloglabs\.org/, /(^|\/\/)gateway\.mdloglabs\.org/];

  it('links the dashboard to the 0G host, not the Casper one', () => {
    expect(DEFAULT_DASHBOARD_URL).toBe('https://agentgate.equiflow.xyz');
  });

  it('keeps every exported default URL off the Casper hosts', () => {
    const urls = {
      DEFAULT_ZG_RPC_URL,
      DEFAULT_ZG_EXPLORER_URL,
      DEFAULT_GATEWAY_URL,
      DEFAULT_DASHBOARD_URL,
    };
    for (const [name, url] of Object.entries(urls)) {
      for (const host of CASPER_HOSTS) {
        expect(`${name}=${url}`).not.toMatch(host);
      }
    }
  });
});

/**
 * Chain identity is a TUPLE, not five independent knobs. Before profiles there
 * was no notion of "environment" at all — `live` simply meant Galileo testnet,
 * every chain value defaulted to it, and an operator who repointed ZG_RPC_URL at
 * mainnet and forgot the rest got a client that read a testnet address on
 * mainnet and paid real OG into it.
 */
describe('network profiles', () => {
  const live = (over: Record<string, string> = {}) =>
    loadConfig({
      AGENTGATE_MODE: 'live',
      AGENTGATE_ADMIN_TOKEN: 'a-strong-unique-token',
      GATE_SIGNER_KEY: `0x${'ab'.repeat(32)}`,
      ...over,
    });

  it('defaults to mainnet — the network the hosted gateway and dashboard serve', () => {
    const cfg = live();
    expect(cfg.zgChainId).toBe(16661);
    expect(cfg.zgNetwork).toBe('0g-mainnet');
    expect(cfg.registryContractAddress).toBe(DEFAULT_REGISTRY_ADDRESS);
    expect(cfg.paymentRouterAddress).toBe(DEFAULT_PAYMENT_ROUTER_ADDRESS);
    expect(cfg.registryContractAddress).toBe(NETWORK_PROFILES.mainnet!.registry);
  });

  it('selecting galileo moves the WHOLE tuple, never a mix of two networks', () => {
    const cfg = live({ ZG_NETWORK_PROFILE: 'galileo' });
    expect(cfg.zgChainId).toBe(16602);
    expect(cfg.zgRpcUrl).toBe('https://evmrpc-testnet.0g.ai');
    expect(cfg.zgNetwork).toBe('0g-galileo');
    // The critical property: no mainnet address survives the switch.
    expect(cfg.registryContractAddress).toBe(NETWORK_PROFILES.galileo!.registry);
    expect(cfg.registryContractAddress).not.toBe(DEFAULT_REGISTRY_ADDRESS);
    expect(cfg.paymentRouterAddress).not.toBe(DEFAULT_PAYMENT_ROUTER_ADDRESS);
  });

  it('mainnet carries its own deployment, distinct from testnet at every address', () => {
    // Recorded by scripts/set-deployment.ts on 2026-09-15 after on-chain
    // verification. The three must be well-formed addresses (a blank one
    // would fail closed as "not deployed", which was the pre-deploy state) and
    // none of them may be a Galileo address: the same address on two chains is
    // exactly the "leftover testnet address" mistake the profiles exist to
    // make impossible.
    const cfg = live({ ZG_NETWORK_PROFILE: 'mainnet' });
    for (const addr of [cfg.registryContractAddress, cfg.paymentRouterAddress, cfg.spendGuardAddress]) {
      expect(addr).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
    const galileo = NETWORK_PROFILES.galileo!;
    expect([galileo.registry, galileo.router, galileo.spendGuard]).not.toContain(cfg.registryContractAddress);
    expect([galileo.registry, galileo.router, galileo.spendGuard]).not.toContain(cfg.paymentRouterAddress);
    expect([galileo.registry, galileo.router, galileo.spendGuard]).not.toContain(cfg.spendGuardAddress);
    expect(cfg.contractsDeployBlock).toBe(NETWORK_PROFILES.mainnet!.deployBlock);
    expect(cfg.contractsDeployBlock).toBeGreaterThan(0);
  });

  it('rejects an unknown profile by name instead of quietly using testnet', () => {
    expect(() => live({ ZG_NETWORK_PROFILE: 'maiinet' })).toThrow(/unknown ZG_NETWORK_PROFILE/);
  });

  it('every profile is internally consistent: distinct chain id, rpc and explorer', () => {
    const seen = new Set<number>();
    for (const [name, p] of Object.entries(NETWORK_PROFILES)) {
      expect(seen.has(p.chainId), `${name} reuses chain id ${p.chainId}`).toBe(false);
      seen.add(p.chainId);
      expect(p.network, `${name} has no network name`).not.toBe('');
      expect(p.rpcUrl).toMatch(/^https:\/\//);
      expect(p.explorerUrl).toMatch(/^https:\/\//);
      // A deployed profile knows where its history starts; an undeployed one
      // has no block to name and must not carry a stale one.
      expect(Number.isSafeInteger(p.deployBlock) && p.deployBlock >= 0, `${name} deployBlock`).toBe(true);
      expect(p.deployBlock > 0, `${name} deployBlock vs registry`).toBe(p.registry !== '');
    }
  });
});

describe('redemption window', () => {
  it('must not be shorter than the invoice TTL', () => {
    // Otherwise a payment made against a still-valid invoice could never be
    // collected — the exact shape of the bug this window exists to close.
    expect(() =>
      loadConfig({ INVOICE_TTL_MS: '300000', INVOICE_REDEMPTION_WINDOW_MS: '1000' }),
    ).toThrow(/must be >= INVOICE_TTL_MS/);
  });

  it('defaults generously, because being too short costs a buyer their money', () => {
    expect(loadConfig({}).invoiceRedemptionWindowMs).toBe(86_400_000);
  });
});

/**
 * A coupling between an operator-settable env var and an IMMUTABLE on-chain
 * constant. AgentGateRegistry delays payout-target and price changes by
 * TERMS_CHANGE_DELAY_MS (15 min) so a buyer mid-payment cannot have the terms
 * moved under them. That only holds while the gateway's worst-case staleness —
 * one service-cache lifetime plus one invoice lifetime — stays under the delay.
 * The contract can never be changed to catch up, so the env var is what has to
 * be bounded.
 */
describe('invoice TTL is bounded by the on-chain terms-change delay', () => {
  it('refuses a TTL that would outlive the delay', () => {
    expect(() => loadConfig({ INVOICE_TTL_MS: String(20 * 60 * 1000) })).toThrow(/INVOICE_TTL_MS/);
  });

  it('the cap leaves room for the service cache plus a margin', () => {
    const TERMS_CHANGE_DELAY_MS = 15 * 60 * 1000; // AgentGateRegistry constant
    const SERVICE_CACHE_TTL_MS = 60_000;          // middleware ServiceCache
    expect(MAX_INVOICE_TTL_MS + SERVICE_CACHE_TTL_MS).toBeLessThan(TERMS_CHANGE_DELAY_MS);
  });

  it('still accepts the shipped default', () => {
    expect(loadConfig({ INVOICE_TTL_MS: '300000' }).invoiceTtlMs).toBe(300_000);
  });
});
