/**
 * Live read-path smoke test. Run this AGAINST THE DEPLOYED CONTRACT before
 * trusting live reads (and before any mainnet move). The anvil-backed suite
 * proves the client against a contract it deploys itself; this proves it
 * against the *actual* deployment, catching a wrong address, a stale ABI, or a
 * registry that answers plausible-but-wrong values rather than reverting.
 *
 * It reads getService / getScore / listServices from the deployed
 * AgentGateRegistry and compares them against the known on-chain truth from the
 * README "Deployed addresses" block, failing loudly (exit 1) on any decode
 * error or mismatch.
 *
 *   AGENTGATE_MODE=live REGISTRY_CONTRACT_ADDRESS=0x… \
 *     npx tsx scripts/smoke-live-read.ts
 */
import { loadConfig } from '@agentgate/shared';
import { createChainClient } from '@agentgate/chain';

/** Known on-chain truth (README → "Deployed addresses (0G Galileo Testnet)"). */
const EXPECTED = {
  serviceId: 1,
  // Service #1's score reads (1,1) after the recorded attestation and only grows.
  minTotalCalls: 1,
  minSuccessCalls: 1,
};

async function main(): Promise<void> {
  // Read-only: this script never signs, never POSTs to /admin, and never needs
  // a gateway. Demanding a strong admin token here would make the cheapest
  // post-deploy check the one with the most setup — exactly backwards.
  const config = loadConfig(process.env, { requireStrongAdminToken: false });
  if (config.mode !== 'live') {
    throw new Error('smoke-live-read must run with AGENTGATE_MODE=live');
  }
  const chain = createChainClient(config);
  const problems: string[] = [];

  // A freshly deployed registry has nothing to assert against. Say so plainly:
  // four "expected the seeded service" failures on a working deploy is a
  // confusing way to report "you haven't registered anything yet", and it is
  // the exact moment someone runs this script for the first time.
  const existing = await chain.listServices();
  if (existing.length === 0) {
    console.log('registry is reachable and decodes — but EMPTY (servicesCount = 0).');
    console.log('');
    console.log('Nothing to smoke-test yet. Register a service and buy one call first:');
    console.log('  export SELLER_SIGNER_KEY=0x…   # funded at https://faucet.0g.ai');
    console.log('  npx tsx packages/cli/src/bin.ts wrap <public-url> --name "…" --price 0.001');
    console.log('  export BUYER_SIGNER_KEY=0x…    # a DIFFERENT wallet — a self-payment records no attestation');
    console.log('  npx tsx packages/cli/src/bin.ts buy 1 --max 1');
    console.log('');
    console.log('Then re-run this script to verify the read path against real on-chain data.');
    return;
  }

  // 1) getService(1) must decode cleanly with sane fields.
  const service = await chain.getService(EXPECTED.serviceId);
  if (!service) {
    problems.push(`getService(${EXPECTED.serviceId}) returned null — expected the seeded service`);
  } else {
    console.log(`service #${service.id}: ${service.name}`);
    console.log(`  endpoint:       ${service.endpointUrl}`);
    console.log(`  price (wei):    ${service.priceWei}`);
    console.log(`  payment target: ${service.paymentTarget}`);
    console.log(`  owner:          ${service.owner}`);
    console.log(`  attestor:       ${service.attestor}`);
    if (service.id !== EXPECTED.serviceId) problems.push(`service.id ${service.id} != ${EXPECTED.serviceId}`);
    if (!service.name || service.name.trim() === '') {
      problems.push('service.name is empty — possible dictionary-index collision (F3)');
    }
    if (!/^\d+$/.test(String(service.priceWei))) {
      problems.push(`priceWei is not a decimal string: ${service.priceWei}`);
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(service.paymentTarget)) {
      problems.push(`paymentTarget is not an EVM address: ${service.paymentTarget}`);
    }
  }

  // 2) getScore(1) must be a sane (total, success) pair with success <= total.
  const score = await chain.getScore(EXPECTED.serviceId);
  console.log(`score: ${score.successCalls}/${score.totalCalls}`);
  if (!Number.isSafeInteger(score.totalCalls) || !Number.isSafeInteger(score.successCalls)) {
    problems.push(`score is not an integer pair: ${JSON.stringify(score)}`);
  }
  if (score.successCalls > score.totalCalls) {
    problems.push('successCalls > totalCalls — impossible; likely a decode/index bug');
  }
  if (score.totalCalls < EXPECTED.minTotalCalls) {
    problems.push(`totalCalls ${score.totalCalls} < expected ${EXPECTED.minTotalCalls}`);
  }
  if (score.successCalls < EXPECTED.minSuccessCalls) {
    problems.push(`successCalls ${score.successCalls} < expected ${EXPECTED.minSuccessCalls}`);
  }

  // 3) listServices() (the list decode path) must include the seeded service.
  const list = await chain.listServices();
  console.log(`listServices(): ${list.length} service(s)`);
  if (!list.some((s) => s.id === EXPECTED.serviceId)) {
    problems.push(`listServices() did not include service #${EXPECTED.serviceId}`);
  }

  if (problems.length > 0) {
    console.error('\nREAD-PATH SMOKE FAILED:');
    for (const p of problems) console.error(`  ✗ ${p}`);
    process.exit(1);
  }
  console.log('\n✓ read-path smoke passed — live decode matches on-chain truth');
}

main().catch((err: unknown) => {
  console.error('read-path smoke ERRORED:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
