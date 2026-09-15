import { createHash } from 'node:crypto';
import { toFunctionSelector, type Abi } from 'viem';

/**
 * The functions in `abi` that the code at an address cannot dispatch.
 *
 * A contract's runtime bytecode carries every selector it answers to as a PUSH4
 * in its dispatch table, so a selector that is absent from the code is a
 * function the deployment does not have. That is a one-way signal and the useful
 * one: it cannot prove two contracts are identical, but it does prove a
 * deployment is OLDER than the ABI being recorded against it, which is the
 * mistake that costs a working catalog.
 *
 * A false NEGATIVE is possible in principle — four bytes of unrelated data
 * happening to equal a selector — so this is a floor, not a proof of shape. The
 * hash pinned by set-deployment.ts and asserted in e2e/registry-abi-pin.test.ts
 * is what makes the match exact.
 */
export function missingSelectors(abi: Abi, runtimeBytecode: string): string[] {
  const code = runtimeBytecode.toLowerCase();
  return abi
    .filter((item) => item.type === 'function')
    .filter((fn) => !dispatches(code, toFunctionSelector(fn)))
    .map((fn) => fn.name);
}

/**
 * Whether `code` pushes `selector` anywhere.
 *
 * Not a plain substring search, because a selector with leading ZERO bytes is
 * never pushed in full: `withdraw(uint64,uint256,address)` is 0x00505499, and
 * solc emits `62505499` — PUSH3 — because the leading zero carries no
 * information. Searching for the four-byte form reports a function the contract
 * plainly has, which turns this guard from one that blocks a bad deployment into
 * one that blocks a good one. Low selectors are not exotic: gas-minded contracts
 * are named to produce them on purpose.
 *
 * The trimmed needle is shorter and so slightly likelier to collide with
 * unrelated bytes, which errs toward calling a function present. That is the
 * direction this check is already documented to fail in.
 */
function dispatches(code: string, selector: string): boolean {
  const hex = selector.slice(2);
  return code.includes(hex) || code.includes(hex.replace(/^(?:00)+/, ''));
}

/**
 * The fingerprint recorded in `NetworkProfile.abiHashes` and asserted by
 * e2e/registry-abi-pin.test.ts.
 *
 * Both sides import THIS function rather than each hashing "the obvious way":
 * two canonicalisations that drift apart would make the pin fail for a reason
 * that has nothing to do with the deployment, which is the one failure mode a
 * guard like this cannot afford.
 */
export function abiHash(abi: unknown): string {
  return createHash('sha256').update(JSON.stringify(abi)).digest('hex');
}
