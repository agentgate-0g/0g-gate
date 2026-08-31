import { randomBytes } from 'node:crypto';
import type { Wei } from '@agentgate/shared';
import { AgentGateError, ogToWei } from '@agentgate/shared';
import type { FetchLike } from './types';
import { normalizeBaseUrl } from './validate';

/** Each demo account is faucet-funded with this many OG. */
export const DEMO_FAUCET_OG = '1000';

/** Fallback faucet timeout when no timeoutMs is supplied (ms). */
export const DEFAULT_FAUCET_TIMEOUT_MS = 15_000;

export interface CreateDemoAccountsOpts {
  /** Mock devnet base URL, e.g. http://localhost:4030. */
  devnetUrl: string;
  /** Timeout (ms) for each faucet POST. Defaults to DEFAULT_FAUCET_TIMEOUT_MS. */
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export interface DemoAccount {
  role: 'buyer' | 'seller';
  /** Mock signer public key: "01" + 64 random hex chars. */
  publicKey: string;
  balanceWei: Wei;
}

export interface DemoAccountsResult {
  buyer: DemoAccount;
  seller: DemoAccount;
  /** Ready-to-paste shell lines: export MOCK_BUYER_ACCOUNT=… / export MOCK_SELLER_ACCOUNT=… */
  exportLines: [string, string];
}

/** "01" + 64 random hex chars (32 bytes of crypto-strength randomness) — a valid mock devnet account key. */
export function generateMockPublicKey(): string {
  return `01${randomBytes(32).toString('hex')}`;
}

/**
 * Programmatic `agentgate demo-accounts` (mock mode only): generates a buyer and
 * a seller mock public key and faucets 1000 OG to each via `POST <devnet>/faucet`.
 */
export async function createDemoAccounts(
  opts: CreateDemoAccountsOpts,
): Promise<DemoAccountsResult> {
  const base = normalizeBaseUrl(opts.devnetUrl, 'devnetUrl');
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FAUCET_TIMEOUT_MS;
  const amountWei = ogToWei(DEMO_FAUCET_OG);

  const fund = async (role: DemoAccount['role']): Promise<DemoAccount> => {
    const publicKey = generateMockPublicKey();
    let res: Response;
    try {
      res = await fetchImpl(`${base}/faucet`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: publicKey, amountWei }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new AgentGateError(
          'GATEWAY_TIMEOUT',
          `devnet faucet at ${base}/faucet timed out after ${timeoutMs}ms — is the devnet running? (npm run dev), then re-run \`agentgate demo-accounts\``,
          504,
        );
      }
      throw new AgentGateError(
        'FAUCET_UNREACHABLE',
        `cannot reach the devnet faucet at ${base}/faucet (${err instanceof Error ? err.message : String(err)}) — is the devnet running? (npm run dev)`,
        502,
      );
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw new AgentGateError(
        'FAUCET_FAILED',
        `faucet for ${role} failed: HTTP ${res.status}${body ? ` — ${body}` : ''}`,
        502,
      );
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new AgentGateError(
        'FAUCET_FAILED',
        `faucet for ${role} returned non-JSON body (expected {"balanceWei": "<wei>"})`,
        502,
      );
    }
    const balanceWei = (parsed as { balanceWei?: unknown }).balanceWei;
    if (typeof balanceWei !== 'string' || !/^\d+$/.test(balanceWei)) {
      throw new AgentGateError(
        'FAUCET_FAILED',
        `faucet for ${role} returned a malformed balanceWei (expected a wei decimal string)`,
        502,
      );
    }
    return { role, publicKey, balanceWei };
  };

  const buyer = await fund('buyer');
  const seller = await fund('seller');

  return {
    buyer,
    seller,
    exportLines: [
      `export MOCK_BUYER_ACCOUNT=${buyer.publicKey}`,
      `export MOCK_SELLER_ACCOUNT=${seller.publicKey}`,
    ],
  };
}
