#!/usr/bin/env node
/**
 * Regenerate packages/chain/src/abi.ts from the compiled Foundry artifacts.
 *
 *   npm run gen:abi        (runs `forge build` first)
 *
 * WHY THIS IS A SCRIPT AND NOT A DOC SNIPPET
 *
 * The off-chain ABI and the contracts are one unit. When the `Service` struct
 * gains a field, a stale abi.ts does not fail loudly — viem keeps decoding at
 * the OLD offsets and hands back plausible-looking garbage: an owner that reads
 * as the zero address, a boolean decoded out of the middle of an address. The
 * repo has hit exactly this before ("Bytes value "18" is not a valid boolean",
 * recorded in packages/shared/src/config.ts).
 *
 * The recipe used to live only in
 * docs/superpowers/plans/2026-08-30-0g-galileo-migration.md, which meant the
 * step most likely to be forgotten was also the one you had to go find.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CONTRACTS = [
  ['AgentGateRegistry', 'REGISTRY_ABI'],
  ['PaymentRouter', 'PAYMENT_ROUTER_ABI'],
  ['SpendGuard', 'SPEND_GUARD_ABI'],
];

const banner = `/**
 * Contract ABIs for the 0G deployment.
 *
 * GENERATED — do not edit by hand. Run \`npm run gen:abi\` whenever a contract
 * entrypoint, event or struct changes; a stale ABI does not throw, it decodes
 * at the wrong offsets and returns convincing nonsense.
 *
 * \`as const\` is required: viem derives its argument and return types from the
 * literal tuple, so a widened \`Abi\` would silently degrade every call to
 * \`unknown\`.
 */
`;

const body = CONTRACTS.map(([contract, exportName]) => {
  const artifact = path.join(ROOT, 'contracts-evm/out', `${contract}.sol`, `${contract}.json`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(artifact, 'utf8'));
  } catch (err) {
    throw new Error(
      `could not read ${artifact} — run \`forge build\` in contracts-evm first (${err.message})`,
    );
  }
  if (!Array.isArray(parsed.abi) || parsed.abi.length === 0) {
    throw new Error(`${artifact} has no abi array`);
  }
  return `export const ${exportName} = ${JSON.stringify(parsed.abi, null, 2)} as const;`;
}).join('\n\n');

const out = path.join(ROOT, 'packages/chain/src/abi.ts');
writeFileSync(out, `${banner}\n${body}\n`);
console.log(`wrote ${path.relative(ROOT, out)} from ${CONTRACTS.length} artifacts`);
