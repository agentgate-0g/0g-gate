import { describe, expect, it } from 'vitest';
import {
  abiHash, PAYMENT_ROUTER_ABI, REGISTRY_ABI, SPEND_GUARD_ABI,
} from '@agentgate/chain';
import { NETWORK_PROFILES, type NetworkProfile } from '@agentgate/shared';

/**
 * `packages/chain/src/abi.ts` and the contract that is ACTUALLY DEPLOYED are one
 * unit, and nothing used to hold the two together.
 *
 * `scripts/gen-abi.mjs` guards the first half of that chain — Solidity source to
 * abi.ts — and it exists because the repo had already lost time to a stale ABI
 * once ("Bytes value \"18\" is not a valid boolean"). The second half went
 * unguarded, and failed the same way: 11ad4c7 grew `Service` from 11 fields to
 * 17, regenerated abi.ts correctly, and never redeployed. Every `getService`
 * then decoded an 11-word payload against a 17-field ABI, landed on `bool
 * active` at an offset word, and threw — which the dashboard reported as
 * `chain_unreachable`, so it read as an RPC outage rather than as the shape
 * mismatch it was.
 *
 * The hashes asserted here are written by `scripts/set-deployment.ts`, which
 * records them only after proving against the chain that the deployment answers
 * to these exact ABIs. A commit that changes an ABI without redeploying fails
 * here — offline, with no RPC, on the commit that does it.
 */
type Contract = keyof NetworkProfile['abiHashes'];

const COMMITTED: Record<Contract, string> = {
  registry: abiHash(REGISTRY_ABI),
  router: abiHash(PAYMENT_ROUTER_ABI),
  spendGuard: abiHash(SPEND_GUARD_ABI),
};
const CONTRACTS = Object.keys(COMMITTED) as Contract[];

describe('the committed ABIs match the recorded deployment', () => {
  for (const [name, profile] of Object.entries(NETWORK_PROFILES)) {
    // An undeployed profile carries empty addresses on purpose (mainnet), and so
    // has no deployment to be wrong about yet.
    const isDeployed = profile.registry !== '';

    describe(name, () => {
      if (!isDeployed) {
        it('pins no ABI, because nothing is deployed', () => {
          expect(profile.abiHashes).toEqual({ registry: '', router: '', spendGuard: '' });
        });
        return;
      }

      for (const contract of CONTRACTS) {
        it(`${contract} ABI is the one that was deployed`, () => {
          expect(
            profile.abiHashes[contract],
            `packages/chain/src/abi.ts no longer describes the ${contract} recorded for "${name}". ` +
              'Either redeploy and re-record it (forge script Deploy.s.sol, then ' +
              'npx tsx scripts/set-deployment.ts), or revert the ABI change. Shipping ' +
              'both as they are means every read decodes at the wrong offsets.',
          ).toBe(COMMITTED[contract]);
        });
      }
    });
  }
});
