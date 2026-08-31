# Wave 3 submission — paste-ready form answers

> Written 2026-08-31 for the Akindo WaveHack portal. Every claim below was true
> and checkable at the time of writing; the "Verifying these claims" section at
> the bottom is how to re-check them before pasting, because a submission that
> has drifted from reality is worse than one that admits a gap.
>
> Field limits observed: **Updates in this Wave** is capped at 3,000 characters.
> The Milestone fields showed no counter.

---

## Field 1 — "Updates in this Wave"

**2,627 characters** (verified, limit 3,000). Describes work completed. Paste verbatim.

```text
This Wave AgentGate moved off Casper and onto 0G Galileo Testnet, and the whole loop is now live and checkable on-chain.

Deployed to Galileo (chain 16602, native OG):
- AgentGateRegistry 0x2f5b7AaD7bffcEc5B6cda95Af4439494C1D576dA
- PaymentRouter 0xfA5e4CC796390Cdca78C6E34664FE77Be1475FBB
- SpendGuard 0x08b4049802999245888E72D0C31Fb4cA55C30E1B

The full loop ran against that deployment with real OG between two independent wallets — not a rehearsal:
- register https://chainscan-galileo.0g.ai/tx/0x4e15b95f5b2c91dc1bf9e112ed78c6418f4f954265c43b9d9f7053d415b2f249
- pay https://chainscan-galileo.0g.ai/tx/0xebee2bc6d95f505445a49caf8051209256abcbbf4e24c1f00194a7e8eef2a815
- attest https://chainscan-galileo.0g.ai/tx/0xd0a24968f092826fd90e298dc36acb64d193d3b11c6e11dec951b7c49aa063be

Try it with no keys and no setup:
  npx agentgate-0g@latest list
  curl -i https://0g-gateway.mdloglabs.org/svc/1   (a real HTTP 402 invoice)

Shipped:
- CLI, MCP server and SDK published to npm as agentgate-0g (now 1.0.3). Reads need no key, no config and no API key — every read is a public-RPC view call.
- Gateway live at https://0g-gateway.mdloglabs.org, serving 402 invoices priced from the contract's on-chain accepts[] list.
- Repo: https://github.com/agentgate-0g/0g-gate — CI green, 449 TypeScript tests and 42 Foundry tests.

Engineering notes worth reporting honestly:
- Payment binding had to be redesigned. Casper transfers could carry the invoice nonce inside them; an EVM transfer carries nothing. PaymentRouter.pay(serviceId, nonce, payTo) forwards msg.value without ever custodying funds and emits an indexed Paid event, so verification is one receipt lookup matched on both service and nonce.
- 0G rejects Foundry's auto-estimated priority fee: a ~7 wei base fee derives a 1 wei tip against an enforced 2 gwei minimum. The deploy needs explicit fees. viem is unaffected.
- We do not claim x402 compliance we don't have. The envelope is x402 V1, but the scheme is named exact-settled, not exact: 0G has no x402 facilitator, so the buyer settles first and presents the tx hash instead of signing an authorization for a third party.
- Publishing found two defects that a green test suite could not: the package shipped an entry point into unbuilt source, and the SDK exported functions that no consumer could call because the factory building their required argument was never exported. Both were caught by installing the tarball into an empty directory, and both now have tests.

Not done yet, stated plainly: the hosted dashboard still serves the pre-migration build. The gateway and CLI are on 0G; that one surface is not.
```

---

## Field 2 — Milestone, "4th Wave"

Forward-looking plan. Each item states its acceptance test, because "done" is
otherwise a matter of opinion.

```text
Make the rail general and enforce budgets on-chain.

1. ERC-20 payments. Services already store an on-chain accepts[] price list, so a second asset needs no contract change to the registry — only a router path that pulls an ERC-20 instead of forwarding msg.value, and a client that picks an entry from accepts[]. Done when one service quotes both OG and a test ERC-20 in the same 402 invoice and a buyer settles either one, with both attested.

2. SpendGuard in the request path. The contract is deployed but nothing calls it: budgets are enforced in the client today, which means an agent enforces its own spending limit. Done when a buyer's cap is checked on-chain before the payment lands, and a transaction exceeding it reverts rather than being refused politely by the caller.

3. Hosted dashboard on 0G. The gateway and CLI migrated this Wave; agentgate.mdloglabs.org still serves the pre-migration build. Done when it reads the Galileo registry live, with the catalog, activity feed and per-service attestation history backed by the deployed contracts.

4. Published types that stand alone. The shipped .d.ts still names the ambient RequestInit, Response and fetch, so a consumer compiling with neither lib.dom nor @types/node cannot use the package. Done when a TypeScript project with lib set to ES2022 and no ambient types compiles against agentgate-0g cleanly.
```

---

## Field 3 — Milestone, "5th Wave"

```text
Make reputation cost something, and extend the loop beyond HTTP APIs.

1. Staking-weighted attestations with slashing. Today a score counts payments: every point is backed by a real transaction, which makes it expensive to forge but still unstaked — a seller risks nothing by serving badly. The plan is for attestors to stake OG behind their attestations and lose it when a served call is provably wrong, so reputation carries downside and not only cost. Done when a staked attestation can be challenged on-chain and a successful challenge slashes the stake, with the score recomputed from stake-weighted rather than count-weighted history.

2. Agent-to-agent payment. The same 402 loop that prices an HTTP API prices anything metered per call — including 0G's own inference and storage. Done when a service in the registry is itself an agent selling compute rather than proxying a third-party API, and one agent pays another through PaymentRouter with no human key involved at either end.

Why this order: the rail has to be general and budget-safe (Wave 4) before it is worth staking on (Wave 5). Slashing without on-chain budget enforcement would let a buyer overspend into a dispute it cannot afford, and staking on a single-asset rail limits who can participate.

Each milestone lands the same way as this Wave's work: contract tests in Foundry, TypeScript tests on the client, and a real transaction on Galileo with its explorer link published, so every claim on this page stays checkable.
```

---

## Why these answers are shaped this way

**Every claim is clickable.** Three transaction hashes, two commands a judge can
run with no setup, three contract addresses. A judge who can verify one claim in
ten seconds tends to believe the rest; a page of adjectives earns nothing.

**Two gaps are stated outright** — the hosted dashboard, and the `.d.ts` ambient
types. Hiding either is the worse bet: a judge who runs `npx agentgate-0g list`
and then opens agentgate.mdloglabs.org finds the mismatch themselves, and being
caught costs more than the admission would have. Both appear as Wave 4
deliverables, which converts a weakness into a plan.

**No x402 compliance is claimed.** The envelope is x402 V1 but the settlement
scheme is deliberately different, and saying so first is stronger than being
corrected.

**The publishing defects are included on purpose.** They show the project tests
what it ships rather than only what it wrote — which is the more credible claim,
and the one most submissions cannot make.

---

## Verifying these claims before you paste

These commands re-check every factual claim in Field 1. Run them; if any
disagrees, fix the text rather than the command.

```bash
# npm: latest version, and that the SDK is genuinely callable
npm view agentgate-0g version
node -e "import('agentgate-0g').then(async m=>{
  const c=m.createChainClient(m.loadConfig({AGENTGATE_MODE:'live'},{requireStrongAdminToken:false}));
  console.log(await m.listServices({chain:c}));})"

# chain: the registry really holds the service the text describes
npx agentgate-0g@latest list

# gateway: a real 402, not a placeholder
curl -i https://0g-gateway.mdloglabs.org/svc/1 | head -1

# repo: CI state on the tip of main
curl -s "https://api.github.com/repos/agentgate-0g/0g-gate/actions/runs?per_page=1" \
  | python3 -c "import json,sys;r=json.load(sys.stdin)['workflow_runs'][0];print(r['head_sha'][:8],r['status'],r['conclusion'])"

# test counts quoted in the text
npx vitest run 2>&1 | tail -3
cd contracts-evm && forge test 2>&1 | tail -1
```

Two numbers in Field 1 will drift as work continues: the npm version (1.0.3) and
the test count (449 TypeScript, 42 Foundry). Re-read them before submitting.
