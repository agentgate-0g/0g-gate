import { describe, expect, it } from 'vitest';
import { DEFAULT_REGISTRY_ADDRESS } from '@agentgate/shared';
import { resolveCliEnv } from '../src/cli-env';

describe('resolveCliEnv', () => {
  it('defaults an empty env to live mode + the deployed registry address', () => {
    const out = resolveCliEnv({}, {});
    expect(out.AGENTGATE_MODE).toBe('live');
    expect(out.REGISTRY_CONTRACT_ADDRESS).toBe(DEFAULT_REGISTRY_ADDRESS);
  });

  it('lets process.env override the built-in defaults', () => {
    const out = resolveCliEnv(
      {},
      { AGENTGATE_MODE: 'mock', REGISTRY_CONTRACT_ADDRESS: `0x${'e'.repeat(40)}` },
    );
    expect(out.AGENTGATE_MODE).toBe('mock');
    expect(out.REGISTRY_CONTRACT_ADDRESS).toBe(`0x${'e'.repeat(40)}`);
  });

  it('lets a flag override both env and default (flag > env > default)', () => {
    const out = resolveCliEnv(
      {
        mode: 'mock',
        registry: `0x${'f'.repeat(40)}`,
        key: `0x${'1'.repeat(64)}`,
        adminToken: 'T',
        rpcUrl: 'http://n',
      },
      { AGENTGATE_MODE: 'live', REGISTRY_CONTRACT_ADDRESS: `0x${'e'.repeat(40)}` },
    );
    expect(out.AGENTGATE_MODE).toBe('mock');
    expect(out.REGISTRY_CONTRACT_ADDRESS).toBe(`0x${'f'.repeat(40)}`);
    expect(out.SELLER_SIGNER_KEY).toBe(`0x${'1'.repeat(64)}`);
    expect(out.AGENTGATE_ADMIN_TOKEN).toBe('T');
    expect(out.ZG_RPC_URL).toBe('http://n');
  });

  it('treats empty-string flags/env as unset', () => {
    const out = resolveCliEnv({ mode: '  ' }, { AGENTGATE_MODE: '' });
    expect(out.AGENTGATE_MODE).toBe('live');
  });

  it('does not inject ZG_RPC_URL/SELLER_SIGNER_KEY when neither flag nor env is set', () => {
    const out = resolveCliEnv({}, {});
    expect(out.ZG_RPC_URL).toBeUndefined();
    expect(out.SELLER_SIGNER_KEY).toBeUndefined();
  });

  it('writes EXACTLY the keys loadConfig reads — no strays, no leftovers', () => {
    // Pinning the whole key set, rather than listing keys that must be absent,
    // catches both directions: a retired variable that creeps back, and a new
    // one written here but never read by loadConfig (which would silently do
    // nothing). Every name below must exist in AgentGateConfig's env contract.
    const out = resolveCliEnv(
      {
        mode: 'live',
        registry: `0x${'f'.repeat(40)}`,
        rpcUrl: 'http://n',
        key: `0x${'1'.repeat(64)}`,
        adminToken: 'T',
      },
      {},
    );
    expect(Object.keys(out).sort()).toEqual(
      [
        'AGENTGATE_ADMIN_TOKEN',
        'AGENTGATE_MODE',
        'REGISTRY_CONTRACT_ADDRESS',
        'SELLER_SIGNER_KEY',
        'ZG_RPC_URL',
      ].sort(),
    );
  });
});
