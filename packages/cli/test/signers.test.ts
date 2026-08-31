import { describe, expect, it } from 'vitest';
import { loadConfig, type AgentGateConfig } from '@agentgate/shared';
import { resolveCliEnv } from '../src/cli-env';
import { buyerSigner, sellerSigner } from '../src/signers';

const KEY_A = `0x${'1'.repeat(64)}`;
const KEY_B = `0x${'2'.repeat(64)}`;
const MOCK_ACCOUNT = `01${'a'.repeat(64)}`;

function liveConfig(env: Record<string, string | undefined>): AgentGateConfig {
  return loadConfig(
    { AGENTGATE_MODE: 'live', AGENTGATE_ADMIN_TOKEN: 'a-strong-admin-token', ...env },
    { requireStrongAdminToken: false },
  );
}

describe('sellerSigner', () => {
  it('uses the mock account in mock mode', () => {
    const config = loadConfig({ AGENTGATE_MODE: 'mock', MOCK_SELLER_ACCOUNT: MOCK_ACCOUNT });
    expect(sellerSigner(config)).toEqual({ kind: 'mock', publicKey: MOCK_ACCOUNT });
  });

  it('returns a key signer from SELLER_SIGNER_KEY in live mode', () => {
    expect(sellerSigner(liveConfig({ SELLER_SIGNER_KEY: KEY_A }))).toEqual({
      kind: 'key',
      privateKey: KEY_A,
    });
  });

  it('names --key and SELLER_SIGNER_KEY when no key is configured', () => {
    let message = '';
    try {
      sellerSigner(liveConfig({}));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('--key');
    expect(message).toContain('SELLER_SIGNER_KEY');
  });
});

describe('buyerSigner', () => {
  it('uses the mock account in mock mode', () => {
    const config = loadConfig({ AGENTGATE_MODE: 'mock', MOCK_BUYER_ACCOUNT: MOCK_ACCOUNT });
    expect(buyerSigner(config)).toEqual({ kind: 'mock', publicKey: MOCK_ACCOUNT });
  });

  it('lets the --key flag win over BUYER_SIGNER_KEY', () => {
    const config = liveConfig({ BUYER_SIGNER_KEY: KEY_A });
    expect(buyerSigner(config, KEY_B)).toEqual({ kind: 'key', privateKey: KEY_B });
  });

  it('falls back to BUYER_SIGNER_KEY when no flag is given', () => {
    expect(buyerSigner(liveConfig({ BUYER_SIGNER_KEY: KEY_A }))).toEqual({
      kind: 'key',
      privateKey: KEY_A,
    });
  });

  it('treats a blank --key flag as unset', () => {
    expect(buyerSigner(liveConfig({ BUYER_SIGNER_KEY: KEY_A }), '   ')).toEqual({
      kind: 'key',
      privateKey: KEY_A,
    });
  });

  it('names --key and BUYER_SIGNER_KEY when no key is configured', () => {
    let message = '';
    try {
      buyerSigner(liveConfig({}));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('--key');
    expect(message).toContain('BUYER_SIGNER_KEY');
  });
});

describe('key handling never leaks the secret', () => {
  it('rejects a malformed --key without echoing its value', () => {
    const secret = 'not-a-real-key-but-still-a-secret';
    let message = '';
    try {
      loadConfig(resolveCliEnv({ mode: 'live', key: secret }, {}), {
        requireStrongAdminToken: false,
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/SELLER_SIGNER_KEY/);
    expect(message).not.toContain(secret);
  });
});
