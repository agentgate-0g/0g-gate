/**
 * Registers additional real services in the live catalog.
 *
 * `registerService` is an on-chain write that CANNOT be undone — a service can
 * only be paused afterwards, never deleted. Two consequences shape this script:
 *
 * 1. **It is a dry run unless you pass --confirm.** Printing the plan is the
 *    default because the destructive-by-accident case here is simply running the
 *    file, and the cost of that mistake is permanent clutter in a public catalog.
 * 2. **It refuses to register a name that already exists.** Re-running `wrap`
 *    mints a SECOND service with the same name and no way back; the guard below
 *    makes a re-run a no-op instead. Names are the key because that is what a
 *    reader sees in the catalog — two "Jakarta Weather Now" rows is the failure
 *    being prevented, whatever their upstreams are.
 *
 * Every upstream here is public, keyless, small and fast — checked before it was
 * added, because a paid service pointing at a dead or gated endpoint is worse
 * than no service at all.
 *
 *   AGENTGATE_MODE=live npx tsx scripts/seed-catalog.ts            # plan only
 *   AGENTGATE_MODE=live npx tsx scripts/seed-catalog.ts --confirm  # register
 *
 * The gateway the services are mapped on (and whose base URL goes on-chain as
 * their endpoint) defaults to the hosted gateway, which serves the DEFAULT
 * network profile (mainnet). Another network is another gateway — name it,
 * together with the profile:
 *
 *   AGENTGATE_MODE=live ZG_NETWORK_PROFILE=galileo npx tsx scripts/seed-catalog.ts \
 *     --gateway https://<your-galileo-gateway> --confirm
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_GATEWAY_URL, DEFAULT_ZG_NETWORK, loadConfig } from '@agentgate/shared';
import { createChainClient } from '@agentgate/chain';
import { wrapService } from '../packages/cli/src/wrap';
import { sellerSigner } from '../packages/cli/src/signers';

interface Candidate {
  name: string;
  description: string;
  upstreamUrl: string;
  /** Price per call in OG. Varied on purpose — a catalog where everything costs
   *  the same says nothing about whether pricing works. */
  priceOg: string;
}

const CANDIDATES: Candidate[] = [
  // The first two were wrapped by hand on Galileo (services #1 and #2) before
  // this script existed; they are here so a fresh network gets the same catalog.
  {
    name: 'USD FX Feed',
    description: 'USD exchange rates',
    upstreamUrl: 'https://open.er-api.com/v6/latest/USD',
    priceOg: '0.001',
  },
  {
    name: 'Crypto Spot Prices',
    description: 'BTC/ETH spot in USD and IDR',
    upstreamUrl: 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd,idr',
    priceOg: '0.001',
  },
  {
    // Named as a PROXY, not a house brand. alternative.me's FNG rules forbid
    // "a service that could be confused with our offering", and the name is the
    // one field that cannot be edited once the registration is on chain.
    name: 'Crypto Fear & Greed Index (alternative.me proxy)',
    description:
      'Market sentiment 0-100 with its classification. ' +
      'Data from alternative.me - https://alternative.me/crypto/fear-and-greed-index/',
    upstreamUrl: 'https://api.alternative.me/fng/?limit=1',
    priceOg: '0.001',
  },
  {
    name: 'Jakarta Weather Now',
    description:
      'Current temperature, humidity and wind speed for Jakarta. ' +
      'Weather data by Open-Meteo.com (https://open-meteo.com/), CC BY 4.0',
    upstreamUrl:
      'https://api.open-meteo.com/v1/forecast?latitude=-6.2088&longitude=106.8456&current=temperature_2m,relative_humidity_2m,wind_speed_10m',
    priceOg: '0.0005',
  },
  {
    name: 'Jakarta Air Quality',
    description:
      'Current PM2.5, PM10 and US AQI for Jakarta. ' +
      'Air quality data by Open-Meteo.com (https://open-meteo.com/), CC BY 4.0',
    upstreamUrl:
      'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=-6.2088&longitude=106.8456&current=pm2_5,pm10,us_aqi',
    priceOg: '0.0005',
  },
  {
    name: 'Bitcoin Fee Estimates',
    description:
      'Recommended sat/vB per confirmation target, from Blockstream Esplora ' +
      '(https://blockstream.info/), MIT-licensed',
    upstreamUrl: 'https://blockstream.info/api/fee-estimates',
    priceOg: '0.002',
  },
];

/*
 * Two candidates were vetted and REJECTED rather than registered, and the
 * reasons are recorded here because the endpoints still look fine from a curl:
 *
 * - api.blockchain.info/stats — Blockchain.com's API terms prohibit
 *   transmitting, caching, reselling or off-site serving their content in four
 *   separate clauses, which is exactly what a 402 proxy does. Independently, the
 *   live feed is wrong: total_fees_btc came back NEGATIVE (-45312500000) with
 *   miners_revenue at zero. Blockstream Esplora above is the replacement.
 *
 * - date.nager.at PublicHolidays/2026/ID — the terms forbid operating your own
 *   holiday portal and gate commercial use behind sponsorship. Worse, the feed
 *   returns 8 of Indonesia's 17 official 2026 holidays and omits every Islamic
 *   one — no Idul Fitri, no Idul Adha, no Maulid Nabi — by documented design.
 *   Selling that as "Indonesia Public Holidays" would be checkably wrong to any
 *   Indonesian who opened it.
 */

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

const normal = (s: string): string => s.trim().toLowerCase();

/**
 * Refuses an upstream that is not answering with JSON right now.
 *
 * Registering is permanent, so "is this endpoint actually alive" is checked
 * before the write and not after. A redirect counts as a failure: the gateway
 * proxies what it is given, and a 301 reaches the buyer as a 301.
 */
async function assertUpstreamHealthy(c: Candidate): Promise<string> {
  const res = await fetch(c.upstreamUrl, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  if (res.status !== 200) throw new Error(`${c.name}: upstream answered HTTP ${res.status}`);
  const text = await res.text();
  try {
    JSON.parse(text);
  } catch {
    throw new Error(`${c.name}: upstream did not return JSON (${text.slice(0, 80)})`);
  }
  return `${res.status}, ${text.length} bytes`;
}

async function main(): Promise<void> {
  loadDotenv(resolve(import.meta.dirname, '..', '.env'));
  const confirm = process.argv.includes('--confirm');

  const config = loadConfig(process.env, { requireStrongAdminToken: false });
  if (config.mode !== 'live') throw new Error('seed-catalog must run with AGENTGATE_MODE=live');

  const chain = createChainClient(config);
  const signer = sellerSigner(config);
  // The gateway base URL is written on-chain as every service's endpoint, so a
  // gateway on the wrong network is a catalog that 404s for everyone who pays.
  // The hosted default serves the default profile's network and nothing else;
  // refuse it for any other profile rather than default to it.
  const gatewayFlag = process.argv.indexOf('--gateway');
  const gateway = gatewayFlag === -1 ? DEFAULT_GATEWAY_URL : (process.argv[gatewayFlag + 1] ?? '');
  if (!/^https:\/\//.test(gateway)) throw new Error('--gateway must be an https:// URL');
  if (config.zgNetwork !== DEFAULT_ZG_NETWORK && gateway === DEFAULT_GATEWAY_URL) {
    throw new Error(
      `${config.zgNetwork} needs its own gateway: ${DEFAULT_GATEWAY_URL} serves ${DEFAULT_ZG_NETWORK}. Pass --gateway <url>.`,
    );
  }

  const existing = await chain.listServices();
  const taken = new Set(existing.map((s) => normal(s.name)));
  console.log(`registry:  ${config.registryContractAddress}`);
  console.log(`gateway:   ${gateway}`);
  console.log(`existing:  ${existing.length} service(s) — ${existing.map((s) => s.name).join(', ') || 'none'}`);
  console.log('');

  const plan: Array<{ c: Candidate; health: string }> = [];
  for (const c of CANDIDATES) {
    if (taken.has(normal(c.name))) {
      console.log(`SKIP   ${c.name} — already in the registry`);
      continue;
    }
    const health = await assertUpstreamHealthy(c);
    plan.push({ c, health });
    console.log(`READY  ${c.name}  (${c.priceOg} OG/call, upstream ${health})`);
  }
  console.log('');

  if (plan.length === 0) {
    console.log('nothing to do — every candidate is already registered.');
    return;
  }
  if (!confirm) {
    console.log(`DRY RUN — ${plan.length} service(s) would be registered on ${config.zgNetwork}.`);
    console.log('Re-run with --confirm to write them on-chain. This cannot be undone.');
    return;
  }

  for (const { c } of plan) {
    console.log(`registering ${c.name} …`);
    const result = await wrapService({
      chain,
      signer,
      upstreamUrl: c.upstreamUrl,
      priceOg: c.priceOg,
      name: c.name,
      description: c.description,
      gateway,
      mode: 'live',
    });
    console.log(`  service:   #${result.serviceId}`);
    console.log(`  tx:        ${result.txHash}`);
    console.log(`  public:    ${result.publicUrl}`);
    if (!result.adminOk) console.log(`  ! mapping: ${result.adminWarning ?? 'failed'}`);

    // The paywall is the thing that must work; a registration with no mapping
    // is a service that 404s for everyone who pays it.
    const probe = await fetch(result.publicUrl, { signal: AbortSignal.timeout(30_000) });
    console.log(`  paywall:   HTTP ${probe.status}${probe.status === 402 ? ' (invoice served)' : ' — EXPECTED 402'}`);
    console.log('');
  }

  const after = await chain.listServices();
  console.log(`catalog now holds ${after.length} service(s).`);
}

main().catch((err: unknown) => {
  console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
