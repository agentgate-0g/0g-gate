import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { missingSelectors, REGISTRY_ABI, SPEND_GUARD_ABI } from '@agentgate/chain';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The runtime bytecode Foundry compiled for `name` — what `eth_getCode` returns. */
function deployedBytecode(name: string): string {
  const artifact = path.join(REPO, 'contracts-evm/out', `${name}.sol`, `${name}.json`);
  return JSON.parse(readFileSync(artifact, 'utf8')).deployedBytecode.object as string;
}

/**
 * An address says WHERE a contract is, never WHICH VERSION is there — and the
 * difference is invisible until a read decodes at the wrong offsets. This is the
 * check `scripts/set-deployment.ts` runs before it records a deployment: every
 * function the repo's ABI declares must be dispatchable by the code that is
 * actually on the chain.
 *
 * It is what would have stopped 11ad4c7 from being recorded against the old
 * registry — that commit added setPaymentTarget/setAccepts/acceptOwnership,
 * and no bytecode deployed before it can dispatch any of them.
 */
describe('missingSelectors', () => {
  it('finds nothing missing when the ABI is the contract that was compiled', () => {
    expect(missingSelectors(REGISTRY_ABI, deployedBytecode('AgentGateRegistry'))).toEqual([]);
  });

  it('names the registry functions that a different contract cannot dispatch', () => {
    // SpendGuard is real, deployed alongside the registry, and one address slot
    // away in set-deployment's arguments — exactly the mix-up worth catching.
    const missing = missingSelectors(REGISTRY_ABI, deployedBytecode('SpendGuard'));
    expect(missing).toContain('registerService');
    expect(missing).toContain('getService');
  });

  it('reads a bare 0x as "no code here", not as a contract with every function', () => {
    expect(missingSelectors(REGISTRY_ABI, '0x').length).toBeGreaterThan(0);
  });

  /**
   * `withdraw(uint64,uint256,address)` hashes to 0x00505499, and solc pushes a
   * selector with leading zero BYTES using a shorter PUSH — `62505499` (PUSH3),
   * never `00505499` — so the four-byte form is not in the code at all. Searching
   * for it verbatim reports a function the contract obviously has, and the guard
   * that is supposed to block a bad deployment blocks a good one instead.
   */
  it('finds selectors that begin with a zero byte, which solc pushes truncated', () => {
    expect(missingSelectors(SPEND_GUARD_ABI, deployedBytecode('SpendGuard'))).toEqual([]);
  });
});
