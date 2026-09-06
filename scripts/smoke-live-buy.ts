/**
 * Live BUY-path smoke test — the write-side companion to smoke-live-read.
 *
 * `smoke-live-read` proves the registry decodes. This proves the thing the
 * product actually sells: that a stranger with a wallet can pay a 402 invoice,
 * be served, and have that call move the on-chain score. Those are three
 * separate failures and only the last one is visible in the catalog, which is
 * why a manual `agentgate buy` is not the same check — a buy can return 200 and
 * still leave the score at 0/0.
 *
 * Two things it handles that a bare `buy` cannot:
 *
 * 1. **A buyer that is allowed to earn trust.** `isSelfPayment` refuses to
 *    attest a call paid by the service's own owner, payout account or attestor
 *    — wash-trading, correctly blocked. Testing with GATE_SIGNER_KEY therefore
 *    produces `attestation_skipped: self_payment` and a score that never moves,
 *    which reads exactly like a broken attestor. So this keeps a dedicated
 *    throwaway buyer of its own and refuses to run if it collides with any of
 *    the three.
 * 2. **Waiting for the attestation.** The gateway records it through a durable
 *    queue AFTER the response is returned, so the score is not up when `buy`
 *    exits. Checking immediately reports a false failure.
 *
 *   AGENTGATE_MODE=live npx tsx scripts/smoke-live-buy.ts [serviceId]
 *
 * Exits non-zero on any failure. Spends real OG on the configured network.
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, formatEther, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadConfig, formatOg, type ServiceRecord } from '@agentgate/shared';
import { awaitReceipt, createChainClient } from '@agentgate/chain';
// Relative, NOT `agentgate-0g`: that package's exports point at ./dist, which is
// built separately from `npm run build` and was a full day behind src the last
// time this mattered — it read a registry the gateway had already replaced.
import { buyService } from '../packages/cli/src/buy';

/** Where the throwaway buyer lives. Gitignored; holds pocket change only. */
const KEY_FILE = resolve(import.meta.dirname, '..', '.agentgate-smoke-buyer.key');

/** Top the buyer up to this when it runs low — a few dozen calls' worth. */
const TARGET_BALANCE_WEI = 20_000_000_000_000_000n; // 0.02 OG
/** Below this it cannot pay for the call plus gas, so it is refilled. */
const MIN_BALANCE_WEI = 5_000_000_000_000_000n; // 0.005 OG

/** How long to wait for the gateway's queued attestation to land. */
const ATTESTATION_TIMEOUT_MS = 90_000;
const ATTESTATION_POLL_MS = 3_000;

/**
 * Minimal `.env` loader — the same one `scripts/live.ts` carries, for the same
 * reason: the repo has no dotenv dependency, and the gateway's signing keys
 * live in the root `.env`. Existing env vars win, so a caller can still
 * override any of it inline.
 */
function loadDotenv(path = '.env'): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return; // no .env — rely on the ambient environment
  }
  for (const line of raw.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1];
    if (key !== undefined && process.env[key] === undefined) process.env[key] = m[2] ?? '';
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * The buyer key, created on first run.
 *
 * Persisted rather than regenerated per run so the funding transfer is paid
 * once instead of stranding dust in a new address every time — and so a failed
 * run can be retried with the wallet it already funded.
 */
function buyerKey(): `0x${string}` {
  if (existsSync(KEY_FILE)) {
    const stored = readFileSync(KEY_FILE, 'utf8').trim();
    if (/^0x[0-9a-fA-F]{64}$/.test(stored)) return stored as `0x${string}`;
    throw new Error(`${KEY_FILE} exists but is not a 32-byte hex key — delete it to regenerate`);
  }
  const key = `0x${randomBytes(32).toString('hex')}` as `0x${string}`;
  writeFileSync(KEY_FILE, `${key}\n`, { mode: 0o600 });
  chmodSync(KEY_FILE, 0o600);
  console.log(`created a new smoke buyer at ${KEY_FILE}`);
  return key;
}

/**
 * Refuses a buyer the gateway would decline to attest.
 *
 * This is the check whose absence cost an afternoon: the buy succeeds, the API
 * responds, the payment lands on-chain — and the score stays 0/0 because the
 * payer was the attestor. Failing here says so in one line instead.
 */
function assertNotSelfPayment(buyer: string, service: ServiceRecord): void {
  const roles: Array<[string, string]> = [
    ['owner', service.owner],
    ['paymentTarget', service.paymentTarget],
    ['attestor', service.attestor],
  ];
  for (const [role, address] of roles) {
    if (same(buyer, address)) {
      throw new Error(
        `the smoke buyer ${buyer} is service #${service.id}'s ${role}. The gateway refuses to ` +
          'attest a self-paid call (wash-trading), so the score would not move and this test ' +
          `would report a failure that is not one. Delete ${KEY_FILE} to get a fresh buyer.`,
      );
    }
  }
}

async function main(): Promise<void> {
  loadDotenv(resolve(import.meta.dirname, '..', '.env'));
  const config = loadConfig(process.env, { requireStrongAdminToken: false });
  if (config.mode !== 'live') throw new Error('smoke-live-buy must run with AGENTGATE_MODE=live');
  if (config.gateSignerKey === '') {
    throw new Error('GATE_SIGNER_KEY is not set — it is what funds the throwaway buyer');
  }

  const serviceId = Number(process.argv[2] ?? 2);
  if (!Number.isInteger(serviceId) || serviceId < 1) {
    throw new Error(`service id must be a positive integer, got ${String(process.argv[2])}`);
  }

  const chain = createChainClient(config);
  const service = await chain.getService(serviceId);
  if (!service) throw new Error(`service #${serviceId} is not in the registry`);
  if (!service.active) throw new Error(`service #${serviceId} (${service.name}) is paused`);

  const key = buyerKey();
  const buyer = privateKeyToAccount(key);
  assertNotSelfPayment(buyer.address, service);

  console.log(`network:   ${chain.network}`);
  console.log(`service:   #${service.id} ${service.name}  (${formatOg(service.priceWei)})`);
  console.log(`buyer:     ${buyer.address}`);
  console.log(`attestor:  ${service.attestor}`);
  console.log('');

  /* ── fund the buyer, if it needs it ───────────────────────────────────── */

  const zgChain = defineChain({
    id: config.zgChainId,
    name: config.zgNetwork,
    nativeCurrency: { name: 'OG', symbol: 'OG', decimals: 18 },
    rpcUrls: { default: { http: [config.zgRpcUrl] } },
  });
  const pub = createPublicClient({ chain: zgChain, transport: http(config.zgRpcUrl) });

  let balance = await pub.getBalance({ address: buyer.address });
  console.log(`balance:   ${formatEther(balance)} OG`);
  if (balance < MIN_BALANCE_WEI) {
    const funder = privateKeyToAccount(config.gateSignerKey as `0x${string}`);
    const topUp = TARGET_BALANCE_WEI - balance;
    console.log(`funding:   ${formatEther(topUp)} OG from ${funder.address}`);
    const wallet = createWalletClient({ account: funder, chain: zgChain, transport: http(config.zgRpcUrl) });
    const hash = await wallet.sendTransaction({ to: buyer.address, value: topUp });
    // Through awaitReceipt, not a bare wait: 0G reports the block before the
    // receipt is queryable, and the first run of this script died right here on
    // a transfer that had in fact landed.
    await awaitReceipt(() =>
      pub.waitForTransactionReceipt({ hash, pollingInterval: 1_000, timeout: 20_000 }),
    );
    balance = await pub.getBalance({ address: buyer.address });
    console.log(`funded:    ${hash}  -> ${formatEther(balance)} OG`);
  }
  console.log('');

  /* ── buy ──────────────────────────────────────────────────────────────── */

  const before = await chain.getScore(serviceId);
  console.log(`score before: ${before.successCalls}/${before.totalCalls}`);

  const { url, result } = await buyService({
    chain,
    signer: { kind: 'key', privateKey: key },
    id: serviceId,
    maxOg: config.buyerBudgetOg,
  });

  console.log(`paid:      ${formatOg(result.priceWei ?? service.priceWei)}`);
  console.log(`payment:   ${result.txHash ?? '(none reported)'}`);
  console.log(`url:       ${url}`);
  console.log(`status:    ${result.status}`);
  console.log('');

  // A 200 that was served WITHOUT payment is not a pass: it would mean the
  // paywall let the call through, which is a worse finding than a failed buy.
  if (!result.paid) throw new Error('the gateway returned a body without taking payment');
  if (result.status !== 200) throw new Error(`the paid call returned HTTP ${result.status}`);

  /* ── the part a bare `buy` does not check ─────────────────────────────── */

  console.log('waiting for the gateway to record its attestation…');
  const deadline = Date.now() + ATTESTATION_TIMEOUT_MS;
  let after = before;
  while (Date.now() < deadline) {
    after = await chain.getScore(serviceId);
    if (after.totalCalls > before.totalCalls) break;
    await sleep(ATTESTATION_POLL_MS);
  }

  console.log(`score after:  ${after.successCalls}/${after.totalCalls}`);
  if (after.totalCalls <= before.totalCalls) {
    throw new Error(
      `the call was paid and served, but no attestation landed within ${ATTESTATION_TIMEOUT_MS / 1000}s. ` +
        'Check the gateway log for `attestation_skipped` (it names the reason) or ' +
        '`attestation_recorded` (it landed late — raise the timeout).',
    );
  }

  const attestations = await chain.listAttestations(serviceId, 3);
  const mine = attestations.find((a) => same(a.paymentTxHash, result.txHash ?? ''));
  // The score moves as soon as the attestation is mined; its LOG is queryable a
  // moment later, so a blank hash here is the same 0G lag again rather than a
  // missing record. Say which it is instead of printing an empty field.
  console.log(
    mine?.recordTxHash
      ? `attestation:  ${mine.recordTxHash}  (success=${mine.success})`
      : mine
        ? `attestation:  recorded (success=${mine.success}); its log has not been indexed yet`
        : 'attestation:  the score moved, but no record matched this payment hash yet',
  );

  console.log('');
  console.log('PASS — paid, served, and scored.');
}

main().catch((err: unknown) => {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
