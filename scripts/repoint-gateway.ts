/**
 * Repoints every service this seller owns at a new gateway host.
 *
 * A gateway hostname is not permanent — tunnels move, domains change — but the
 * `endpointUrl` a buyer reads is stored on-chain, so a move silently breaks
 * every listing at once: the catalog keeps showing a URL that no longer answers,
 * and a buyer who pays gets a 502 for a call that was charged for.
 *
 * `AgentGateRegistry.setGatewayBaseUrl` exists for exactly this, and its own
 * comment says so — "a seller whose gateway host has just died should not have
 * to wait out a delay to point buyers somewhere that answers". It is owner-only
 * and takes effect immediately, unlike the money terms.
 *
 * The ChainClient does not surface this call yet, so the write goes straight to
 * the registry through REGISTRY_ABI.
 *
 *   AGENTGATE_MODE=live npx tsx scripts/repoint-gateway.ts <newBaseUrl>            # plan
 *   AGENTGATE_MODE=live npx tsx scripts/repoint-gateway.ts <newBaseUrl> --confirm  # write
 *
 * Defaults to DEFAULT_GATEWAY_URL when no URL is given.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DEFAULT_GATEWAY_URL, loadConfig } from '@agentgate/shared';
import { awaitReceipt, createChainClient } from '@agentgate/chain';
import { REGISTRY_ABI } from '../packages/chain/src/abi';

/** The same minimal `.env` reader `scripts/live.ts` carries; no dotenv dependency. */
function loadDotenv(path: string): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1];
    if (key !== undefined && process.env[key] === undefined) process.env[key] = m[2] ?? '';
  }
}

const stripSlashes = (u: string): string => u.replace(/\/+$/, '');

async function main(): Promise<void> {
  loadDotenv(resolve(import.meta.dirname, '..', '.env'));
  const args = process.argv.slice(2);
  const confirm = args.includes('--confirm');
  const target = stripSlashes(args.find((a) => !a.startsWith('--')) ?? DEFAULT_GATEWAY_URL);

  if (!/^https:\/\/[^/]+$/.test(target)) {
    throw new Error(`the new base URL must be a bare https origin, got ${target}`);
  }

  const config = loadConfig(process.env, { requireStrongAdminToken: false });
  if (config.mode !== 'live') throw new Error('repoint-gateway must run with AGENTGATE_MODE=live');
  if (config.sellerSignerKey === '') throw new Error('SELLER_SIGNER_KEY is not set (owner-only call)');

  const owner = privateKeyToAccount(config.sellerSignerKey as `0x${string}`);
  const chain = createChainClient(config);
  const services = await chain.listServices();

  console.log(`registry:  ${config.registryContractAddress}`);
  console.log(`owner:     ${owner.address}`);
  console.log(`target:    ${target}`);
  console.log('');

  // Only what this key can actually change, and only what is actually stale.
  const stale = services.filter(
    (s) => s.owner.toLowerCase() === owner.address.toLowerCase() && !s.endpointUrl.startsWith(`${target}/`),
  );
  const foreign = services.filter((s) => s.owner.toLowerCase() !== owner.address.toLowerCase());
  for (const s of services) {
    const mine = s.owner.toLowerCase() === owner.address.toLowerCase();
    const needs = stale.includes(s);
    console.log(`  #${s.id} ${s.name.padEnd(50)} ${needs ? 'REPOINT' : mine ? 'ok' : 'NOT YOURS'}`);
  }
  if (foreign.length > 0) console.log(`\n${foreign.length} service(s) belong to another owner and are left alone.`);
  console.log('');

  if (stale.length === 0) {
    console.log('nothing to do — every service you own already points at the target.');
    return;
  }
  if (!confirm) {
    console.log(`DRY RUN — ${stale.length} service(s) would be repointed. Re-run with --confirm.`);
    return;
  }

  const zgChain = defineChain({
    id: config.zgChainId,
    name: config.zgNetwork,
    nativeCurrency: { name: 'OG', symbol: 'OG', decimals: 18 },
    rpcUrls: { default: { http: [config.zgRpcUrl] } },
  });
  const pub = createPublicClient({ chain: zgChain, transport: http(config.zgRpcUrl) });
  const wallet = createWalletClient({ account: owner, chain: zgChain, transport: http(config.zgRpcUrl) });

  for (const s of stale) {
    const hash = await wallet.writeContract({
      address: config.registryContractAddress as `0x${string}`,
      abi: REGISTRY_ABI,
      functionName: 'setGatewayBaseUrl',
      args: [BigInt(s.id), target],
    });
    // Through awaitReceipt: 0G reports the block before the receipt is
    // queryable, and a bare wait reports a write that landed as a failure.
    const receipt = await awaitReceipt(() =>
      pub.waitForTransactionReceipt({ hash, pollingInterval: 1_000, timeout: 20_000 }),
    );
    if (receipt.status !== 'success') throw new Error(`#${s.id} setGatewayBaseUrl reverted (tx ${hash})`);
    console.log(`  #${s.id} ${s.name} -> ${target}/svc/${s.id}   tx ${hash}`);
  }

  console.log('');
  for (const s of await chain.listServices()) {
    const probe = await fetch(s.endpointUrl, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
    console.log(`  #${s.id} ${s.endpointUrl.padEnd(46)} ${probe ? `HTTP ${probe.status}` : 'unreachable'}`);
  }
}

main().catch((err: unknown) => {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
