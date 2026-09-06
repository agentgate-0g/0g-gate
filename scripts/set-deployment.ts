/**
 * Record a deployment in packages/shared/src/config.ts — but only after proving,
 * against the chain itself, that the addresses are what they claim to be.
 *
 *   npx tsx scripts/set-deployment.ts --network galileo \
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
 *   5. every function in packages/chain/src/abi.ts is dispatchable by that code
 *
 * (3) and (4) are the ones a human cannot eyeball. Both links are immutable
 * constructor arguments, so a mis-wired set cannot be repaired — and it does not
 * look broken: three addresses appear, they go into config, and the failure
 * surfaces later as NoSuchPayment on every attestation.
 *
 * (5) is the one this repo learned the hard way, twice. An address says WHERE a
 * contract is and never WHICH VERSION is there, so a deployment that has fallen
 * a commit behind the ABI passes 1-4 with nothing to show for it. It then fails
 * at read time, in decode, quoting a Solidity type the caller never mentioned
 * ("Bytes value \"32\" is not a valid boolean") — which reads as an RPC problem
 * and gets debugged as one. Alongside the check, this records `abiHashes`, so
 * e2e/registry-abi-pin.test.ts can fail the NEXT drift offline, on the commit
 * that causes it, instead of on the dashboard days later.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPublicClient, http, getAddress, type Abi, type Address } from 'viem';
import {
  abiHash, missingSelectors,
  PAYMENT_ROUTER_ABI, REGISTRY_ABI, SPEND_GUARD_ABI,
} from '@agentgate/chain';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(ROOT, 'packages/shared/src/config.ts');

function die(msg: string): never {
  console.error(`\n  ERROR  ${msg}\n`);
  process.exit(1);
}

// --- args ------------------------------------------------------------------
const args: Record<string, string | undefined> = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i];
  if (!k?.startsWith('--')) die(`unexpected argument ${JSON.stringify(k)}`);
  args[k.slice(2)] = process.argv[i + 1];
}

const network = args['network'];
if (network !== 'galileo' && network !== 'mainnet') {
  die('--network must be "galileo" or "mainnet"');
}

/** The three contracts, in the order they depend on each other. */
const CONTRACTS = [
  { key: 'registry', flag: 'registry', abi: REGISTRY_ABI as unknown as Abi },
  { key: 'router', flag: 'router', abi: PAYMENT_ROUTER_ABI as unknown as Abi },
  { key: 'spendGuard', flag: 'guard', abi: SPEND_GUARD_ABI as unknown as Abi },
] as const;
type ContractKey = (typeof CONTRACTS)[number]['key'];

const addrs = {} as Record<ContractKey, Address>;
for (const { key, flag } of CONTRACTS) {
  const raw = args[flag];
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    die(`--${flag} must be a 0x-prefixed 20-byte address (got ${JSON.stringify(raw)})`);
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

const code = {} as Record<ContractKey, string>;
for (const { key } of CONTRACTS) {
  const address = addrs[key];
  const onChain = await client.getCode({ address });
  if (!onChain || onChain === '0x') {
    die(
      `${key} ${address} has NO CODE on chain ${chainId}.\n` +
        '         This is exactly what a leftover address from another network looks like,\n' +
        '         and a payment sent to it succeeds on-chain and is unrecoverable.',
    );
  }
  code[key] = onChain;
  console.log(`  ok   ${key.padEnd(10)} ${address}  (${(onChain.length - 2) / 2} bytes of code)`);
}

const ROUTER_LINK_ABI = [{ type: 'function', name: 'ROUTER', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' }] as const;
const REGISTRY_LINK_ABI = [{ type: 'function', name: 'REGISTRY', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' }] as const;

const wiredRouter = await client
  .readContract({ address: addrs.registry, abi: ROUTER_LINK_ABI, functionName: 'ROUTER' })
  .catch((e: { shortMessage?: string; message: string }) =>
    die(`registry ${addrs.registry} has no ROUTER() — is it really an AgentGateRegistry?\n         ${e.shortMessage ?? e.message}`),
  );
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
  .readContract({ address: addrs.spendGuard, abi: REGISTRY_LINK_ABI, functionName: 'REGISTRY' })
  .catch((e: { shortMessage?: string; message: string }) =>
    die(`guard ${addrs.spendGuard} has no REGISTRY() — is it really a SpendGuard?\n         ${e.shortMessage ?? e.message}`),
  );
if (getAddress(wiredRegistry) !== addrs.registry) {
  die(
    `WIRING MISMATCH: guard.REGISTRY() is ${getAddress(wiredRegistry)},\n` +
      `         but you are recording the registry as ${addrs.registry}.`,
  );
}
console.log(`  ok   guard.REGISTRY() == the registry being recorded`);

// --- (5) the deployment answers to the ABI this repo ships ------------------
const hashes = {} as Record<ContractKey, string>;
for (const { key, abi } of CONTRACTS) {
  const missing = missingSelectors(abi, code[key]);
  if (missing.length > 0) {
    die(
      `SHAPE MISMATCH: ${key} ${addrs[key]} cannot dispatch ${missing.length} function(s)\n` +
        `         that packages/chain/src/abi.ts declares: ${missing.join(', ')}.\n` +
        '         The deployment is older than the ABI. Recording it would leave every read\n' +
        '         decoding at the wrong offsets — deploy the current contracts first.',
    );
  }
  hashes[key] = abiHash(abi);
}
console.log(`  ok   all three deployments dispatch every function in abi.ts\n`);

// --- only now, write --------------------------------------------------------
let next = source;
const replaced: string[] = [];
function swap(re: RegExp, replacement: string, label: string): void {
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
  swap(/(DEFAULT_SPEND_GUARD_ADDRESS = ')[^']+(')/, `$1${addrs.spendGuard}$2`, 'DEFAULT_SPEND_GUARD_ADDRESS');
}

// The ABI fingerprint lives inline in the profile for BOTH networks — unlike the
// addresses, it is not something a CLI user is ever handed, so it has no
// module-level constant to swap.
const patchedProfile = (
  network === 'galileo'
    ? profileBlock
    : // The mainnet profile carries its addresses inline, empty until deployed.
      profileBlock
        .replace(/(registry:\s*')[^']*(')/, `$1${addrs.registry}$2`)
        .replace(/(router:\s*')[^']*(')/, `$1${addrs.router}$2`)
        .replace(/(spendGuard:\s*')[^']*(')/, `$1${addrs.spendGuard}$2`)
).replace(
  /abiHashes:\s*\{[\s\S]*?\}(,?)/,
  `abiHashes: {\n` +
    `      registry: '${hashes.registry}',\n` +
    `      router: '${hashes.router}',\n` +
    `      spendGuard: '${hashes.spendGuard}',\n` +
    `    }$1`,
);
if (patchedProfile === profileBlock) die(`could not patch the ${network} profile`);
next = next.replace(profileBlock, patchedProfile);
replaced.push(`${network} profile abiHashes${network === 'mainnet' ? ' + registry/router/spendGuard' : ''}`);

writeFileSync(CONFIG, next);
console.log(`  wrote ${path.relative(ROOT, CONFIG)}`);
for (const r of replaced) console.log(`    - ${r}`);
console.log(`
  NEXT
    git diff packages/shared/src/config.ts     # read it before committing
    npm test
    npm run smoke:live                         # AGENTGATE_MODE=live, reads the new deployment
`);
