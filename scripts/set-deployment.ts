/**
 * Record a deployment in packages/shared/src/config.ts — but only after proving,
 * against the chain itself, that the addresses are what they claim to be.
 *
 *   npx tsx scripts/set-deployment.ts --network galileo \
 *     --registry 0x… --router 0x… --guard 0x… [--deploy-tx <hash>[,<hash>…]]
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
 *
 * It also records `deployBlock`: the block the first of the three contracts
 * was created in. Every eth_getLogs history read starts there (see
 * NetworkProfile.deployBlock), and a block too HIGH silently hides the
 * deployment's earliest events, so it is taken from evidence the chain itself
 * keeps: the receipts of the transactions that created the contracts, found in
 * the Foundry broadcast artifact for the chain (or given as --deploy-tx) and
 * re-read from the node. Receipts are chain data and outlive state — the
 * mainnet RPC prunes state after ~100 blocks, so an eth_getCode search (the
 * fallback, for an address whose creating tx is unknown) works there only in
 * the first minute after a deploy.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

// Every profile carries its own literals (the exported DEFAULT_* names are
// derived from whichever profile is the default), so both are read the same way.
const chainId = Number(/chainId:\s*(\d+)/.exec(profileBlock)?.[1]);
const rpcUrl = /rpcUrl:\s*'([^']+)'/.exec(profileBlock)?.[1];
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
console.log(`  ok   all three deployments dispatch every function in abi.ts`);

// --- (6) where the history starts ---------------------------------------------
// Evidence, in order of preference:
//   a) the RECEIPTS of the creating transactions. `eth_getTransactionReceipt`
//      is chain data every node keeps, and its `contractAddress` and
//      `blockNumber` are exact. The hashes come from the Foundry broadcast
//      artifact for this chain, or from `--deploy-tx` by hand.
//   b) a search over `eth_getCode`, galloping backwards from the head and
//      bisecting — for an address whose creating tx is unknown. "Code at block
//      b" is monotonic, so the search is exact wherever the node still HOLDS
//      the state; the mainnet RPC prunes it after ~100 blocks.
// The three are deployed in dependency order and usually in one block; the
// EARLIEST is the floor, since a `Paid` log can precede the registry that
// later attests it.
const BROADCAST_DIR = path.join(ROOT, 'contracts-evm/broadcast/Deploy.s.sol', String(chainId));

/** Creation tx hashes the broadcast artifacts record for any of the three addresses. */
function artifactTxHashes(): string[] {
  if (!existsSync(BROADCAST_DIR)) return [];
  const wanted = new Set(Object.values(addrs).map((a) => a.toLowerCase()));
  const hashes = new Set<string>();
  for (const file of readdirSync(BROADCAST_DIR)) {
    if (!file.endsWith('.json')) continue; // dry-run/ is a directory; skip it
    let parsed: { receipts?: { contractAddress?: string | null; transactionHash?: string }[]; transactions?: { contractAddress?: string | null; hash?: string | null }[] };
    try {
      parsed = JSON.parse(readFileSync(path.join(BROADCAST_DIR, file), 'utf8'));
    } catch {
      continue;
    }
    for (const r of parsed.receipts ?? []) {
      if (r.contractAddress && r.transactionHash && wanted.has(r.contractAddress.toLowerCase())) hashes.add(r.transactionHash);
    }
    for (const t of parsed.transactions ?? []) {
      if (t.contractAddress && t.hash && wanted.has(t.contractAddress.toLowerCase())) hashes.add(t.hash);
    }
  }
  return [...hashes];
}

/**
 * Re-read each creating tx from the node. A hash is EVIDENCE only once the
 * chain confirms it: mined, successful, and creating one of the three
 * addresses being recorded — a hash copied from the wrong artifact names a
 * contract this profile is not about.
 */
async function creationBlocksFromReceipts(hashes: string[]): Promise<Map<ContractKey, bigint>> {
  const found = new Map<ContractKey, bigint>();
  for (const hash of hashes) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) die(`--deploy-tx: ${JSON.stringify(hash)} is not a transaction hash`);
    const receipt = await client.getTransactionReceipt({ hash: hash as `0x${string}` }).catch(() => null);
    if (!receipt) die(`transaction ${hash} is not on chain ${chainId} (no receipt)`);
    const created = receipt.contractAddress ? getAddress(receipt.contractAddress) : null;
    const key = CONTRACTS.find(({ key }) => addrs[key] === created)?.key;
    if (!key) die(`transaction ${hash} did not create any of the three addresses being recorded`);
    if (receipt.status !== 'success') die(`transaction ${hash} (${key}) reverted`);
    found.set(key, receipt.blockNumber);
  }
  return found;
}

type CodeAt = true | false | 'pruned';
async function codeAt(address: Address, block: bigint): Promise<CodeAt> {
  try {
    const c = await client.getCode({ address, blockNumber: block });
    return c !== undefined && c !== '0x';
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/missing trie node|not available|pruned/i.test(msg)) return 'pruned';
    throw e;
  }
}

function prunedAt(address: Address, block: bigint): never {
  return die(
    `the RPC no longer holds state at block ${block}, so the block ${address} was created in\n` +
      '         cannot be found by search (the node is pruned). Name the transaction that created it:\n' +
      '           --deploy-tx <hash>[,<hash>…]   (its receipt is chain data and is kept by every node)',
  );
}

async function creationBlockBySearch(address: Address, head: bigint): Promise<bigint> {
  if ((await codeAt(address, head)) !== true) die(`${address} has no code at the head block ${head}`);
  // Gallop back until a block WITHOUT code is found: (lo, hi] then brackets the creation.
  let hi = head; // invariant: code at hi
  let lo = -1n; // invariant once ≥ 0: no code at lo
  for (let step = 64n; ; step *= 4n) {
    const probe = hi > step ? hi - step : 0n;
    const has = await codeAt(address, probe);
    if (has === 'pruned') prunedAt(address, probe);
    if (has === false) { lo = probe; break; }
    hi = probe;
    if (probe === 0n) return 0n; // code at genesis: a predeploy, not something we created
  }
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    const has = await codeAt(address, mid);
    if (has === 'pruned') prunedAt(address, mid);
    if (has) hi = mid;
    else lo = mid;
  }
  return hi;
}

const head = await client.getBlockNumber();
const creationTxs = [...artifactTxHashes(), ...(args['deploy-tx']?.split(',').map((h) => h.trim()).filter(Boolean) ?? [])];
const created = await creationBlocksFromReceipts(creationTxs);
for (const { key } of CONTRACTS) {
  const fromReceipt = created.get(key);
  if (fromReceipt !== undefined) {
    console.log(`  ok   ${key.padEnd(10)} created in block ${fromReceipt}  (from its creation receipt)`);
    continue;
  }
  const bySearch = await creationBlockBySearch(addrs[key], head);
  created.set(key, bySearch);
  console.log(`  ok   ${key.padEnd(10)} created in block ${bySearch}  (by eth_getCode search)`);
}
const deployBlock = [...created.values()].reduce((min, b) => (b < min ? b : min));
console.log(`  ok   history starts at block ${deployBlock}\n`);

// --- only now, write --------------------------------------------------------
let next = source;
const replaced: string[] = [];
// Addresses, ABI fingerprint and deploy block all live inline in the profile,
// for both networks; the exported DEFAULT_* constants are derived from the
// default profile at module load, so nothing else in the file names an address.
const patchedProfile = profileBlock
  .replace(/(registry:\s*')[^']*(')/, `$1${addrs.registry}$2`)
  .replace(/(router:\s*')[^']*(')/, `$1${addrs.router}$2`)
  .replace(/(spendGuard:\s*')[^']*(')/, `$1${addrs.spendGuard}$2`)
  .replace(
    /abiHashes:\s*\{[\s\S]*?\}(,?)/,
    `abiHashes: {\n` +
      `      registry: '${hashes.registry}',\n` +
      `      router: '${hashes.router}',\n` +
      `      spendGuard: '${hashes.spendGuard}',\n` +
      `    }$1`,
  )
  .replace(/deployBlock:\s*\d+/, `deployBlock: ${deployBlock}`);
if (!/deployBlock:\s*\d+/.test(profileBlock)) die(`the ${network} profile has no deployBlock field to patch`);
// Assert the patterns matched, not that the text changed (see `swap`).
next = next.replace(profileBlock, patchedProfile);
replaced.push(
  `${network} profile registry/router/spendGuard + abiHashes + deployBlock` +
    (patchedProfile === profileBlock ? ' (already correct)' : ''),
);

writeFileSync(CONFIG, next);
console.log(`  wrote ${path.relative(ROOT, CONFIG)}`);
for (const r of replaced) console.log(`    - ${r}`);
console.log(`
  NEXT
    git diff packages/shared/src/config.ts     # read it before committing
    npm test
    npm run smoke:live                         # AGENTGATE_MODE=live, reads the new deployment
`);
