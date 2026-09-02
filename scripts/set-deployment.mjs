#!/usr/bin/env node
/**
 * Record a deployment in packages/shared/src/config.ts — but only after proving,
 * against the chain itself, that the addresses are what they claim to be.
 *
 *   node scripts/set-deployment.mjs --network galileo \
 *     --registry 0x… --router 0x… --guard 0x…
 *
 * WHY THIS IS A SCRIPT AND NOT THREE EDITS
 *
 * These three constants are the single most dangerous literal in the repo. They
 * are the zero-config defaults every `npx agentgate-0g` user inherits, and a
 * value-bearing CALL to an address with NO CODE SUCCEEDS on EVM: the transaction
 * mines with status success, and the buyer's OG sits at an address nobody holds
 * a key for. A typo here is not a crash, it is silent unrecoverable loss.
 *
 * So this refuses to write anything until it has checked, on the live chain:
 *   1. the RPC really is the chain this profile names
 *   2. all three addresses hold code
 *   3. registry.ROUTER() is the router being recorded
 *   4. guard.REGISTRY() is the registry being recorded
 *
 * (3) and (4) are the ones a human cannot eyeball. Both links are immutable
 * constructor arguments, so a mis-wired set cannot be repaired — and it does not
 * look broken: three addresses appear, they go into config, and the failure
 * surfaces later as NoSuchPayment on every attestation.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPublicClient, http, getAddress } from 'viem';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(ROOT, 'packages/shared/src/config.ts');

// --- args ------------------------------------------------------------------
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i];
  if (!k?.startsWith('--')) die(`unexpected argument ${JSON.stringify(k)}`);
  args[k.slice(2)] = process.argv[i + 1];
}
function die(msg) {
  console.error(`\n  ERROR  ${msg}\n`);
  process.exit(1);
}

const network = args.network;
if (network !== 'galileo' && network !== 'mainnet') {
  die('--network must be "galileo" or "mainnet"');
}
const addrs = {};
for (const key of ['registry', 'router', 'guard']) {
  const raw = args[key];
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    die(`--${key} must be a 0x-prefixed 20-byte address (got ${JSON.stringify(raw)})`);
  }
  addrs[key] = getAddress(raw); // checksums, and rejects a bad checksum outright
}

// --- the profile we are writing into ---------------------------------------
// Read straight from config.ts so this can never disagree with the source of
// truth about which chain a profile means.
const source = readFileSync(CONFIG, 'utf8');
const profileRe = new RegExp(`${network}:\\s*\\{[\\s\\S]*?\\n  \\},`);
const profileBlock = profileRe.exec(source)?.[0];
if (!profileBlock) die(`could not find the "${network}" profile in ${CONFIG}`);

const chainId = Number(
  network === 'galileo'
    ? /DEFAULT_ZG_CHAIN_ID = (\d+)/.exec(source)?.[1]
    : /chainId:\s*(\d+)/.exec(profileBlock)?.[1],
);
const rpcUrl =
  network === 'galileo'
    ? /DEFAULT_ZG_RPC_URL = '([^']+)'/.exec(source)?.[1]
    : /rpcUrl:\s*'([^']+)'/.exec(profileBlock)?.[1];
if (!Number.isInteger(chainId) || !rpcUrl) die(`could not read chainId/rpcUrl for "${network}"`);

console.log(`\n  network  ${network}  (chain ${chainId})`);
console.log(`  rpc      ${rpcUrl}\n`);

// --- verify on-chain, before touching a single byte -------------------------
const client = createPublicClient({ transport: http(rpcUrl) });

const observed = await client.getChainId();
if (observed !== chainId) {
  die(`${rpcUrl} reports chain ${observed}, but the "${network}" profile is chain ${chainId}`);
}
console.log(`  ok   chain id ${observed} matches the profile`);

for (const [label, address] of Object.entries(addrs)) {
  const code = await client.getCode({ address });
  if (!code || code === '0x') {
    die(
      `${label} ${address} has NO CODE on chain ${chainId}.\n` +
        '         This is exactly what a leftover address from another network looks like,\n' +
        '         and a payment sent to it succeeds on-chain and is unrecoverable.',
    );
  }
  console.log(`  ok   ${label.padEnd(8)} ${address}  (${(code.length - 2) / 2} bytes of code)`);
}

const ROUTER_ABI = [{ type: 'function', name: 'ROUTER', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' }];
const REGISTRY_ABI = [{ type: 'function', name: 'REGISTRY', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' }];

const wiredRouter = await client
  .readContract({ address: addrs.registry, abi: ROUTER_ABI, functionName: 'ROUTER' })
  .catch((e) => die(`registry ${addrs.registry} has no ROUTER() — is it really an AgentGateRegistry?\n         ${e.shortMessage ?? e.message}`));
if (getAddress(wiredRouter) !== addrs.router) {
  die(
    `WIRING MISMATCH: registry.ROUTER() is ${getAddress(wiredRouter)},\n` +
      `         but you are recording the router as ${addrs.router}.\n` +
      '         The link is an immutable constructor argument — it cannot be repaired,\n' +
      '         and every attestation against this pair would revert NoSuchPayment.',
  );
}
console.log(`  ok   registry.ROUTER() == the router being recorded`);

const wiredRegistry = await client
  .readContract({ address: addrs.guard, abi: REGISTRY_ABI, functionName: 'REGISTRY' })
  .catch((e) => die(`guard ${addrs.guard} has no REGISTRY() — is it really a SpendGuard?\n         ${e.shortMessage ?? e.message}`));
if (getAddress(wiredRegistry) !== addrs.registry) {
  die(
    `WIRING MISMATCH: guard.REGISTRY() is ${getAddress(wiredRegistry)},\n` +
      `         but you are recording the registry as ${addrs.registry}.`,
  );
}
console.log(`  ok   guard.REGISTRY() == the registry being recorded\n`);

// --- only now, write --------------------------------------------------------
let next = source;
const replaced = [];
function swap(re, replacement, label) {
  // Assert the pattern MATCHED, not that the text changed. Re-recording an
  // address that is already correct is a legitimate no-op — treating it as a
  // failure would make this script refuse to verify an existing deployment.
  if (!re.test(next)) die(`could not patch ${label} — config.ts is not in the shape this script expects`);
  const before = next;
  next = next.replace(re, replacement);
  replaced.push(next === before ? `${label} (already correct)` : label);
}

if (network === 'galileo') {
  // The galileo profile is built from these three module-level constants, which
  // are also the zero-config defaults exported to CLI users.
  swap(/(DEFAULT_REGISTRY_ADDRESS = ')[^']+(')/, `$1${addrs.registry}$2`, 'DEFAULT_REGISTRY_ADDRESS');
  swap(/(DEFAULT_PAYMENT_ROUTER_ADDRESS = ')[^']+(')/, `$1${addrs.router}$2`, 'DEFAULT_PAYMENT_ROUTER_ADDRESS');
  swap(/(DEFAULT_SPEND_GUARD_ADDRESS = ')[^']+(')/, `$1${addrs.guard}$2`, 'DEFAULT_SPEND_GUARD_ADDRESS');
} else {
  // The mainnet profile carries its addresses inline, empty until deployed.
  const patched = profileBlock
    .replace(/(registry:\s*')[^']*(')/, `$1${addrs.registry}$2`)
    .replace(/(router:\s*')[^']*(')/, `$1${addrs.router}$2`)
    .replace(/(spendGuard:\s*')[^']*(')/, `$1${addrs.guard}$2`);
  if (patched === profileBlock) die('could not patch the mainnet profile');
  next = next.replace(profileBlock, patched);
  replaced.push('mainnet profile registry/router/spendGuard');
}

writeFileSync(CONFIG, next);
console.log(`  wrote ${path.relative(ROOT, CONFIG)}`);
for (const r of replaced) console.log(`    - ${r}`);
console.log(`
  NEXT
    git diff packages/shared/src/config.ts     # read it before committing
    npm test
    npm run smoke:live                         # AGENTGATE_MODE=live, reads the new deployment
`);
