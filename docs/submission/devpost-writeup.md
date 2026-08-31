## What it does

AgentGate turns any HTTP API into a paid, on-chain service an AI agent can buy from — no human in the loop.

A seller runs `agentgate wrap <url> --price 0.001`: the service is registered on 0G with its payout address and an `accepts[]` price list stored *in the contract*; the private upstream is mapped by an owner-signed EIP-191 challenge, so its URL never touches the chain.

A buyer runs the mirror, `agentgate buy 2 --max 0.05`: the CLI reads the contract-priced HTTP 402 invoice, pays `PaymentRouter.pay(serviceId, nonce, payTo)`, and retries with the tx hash. The gateway matches it against the receipt's `Paid` log, burns the nonce, proxies the call, and attests on-chain with that payment hash. A call paid by the service's own owner is served but never scored, so scores cannot be wash-traded.

`agentgate mcp` exposes the same loop as MCP tools, so any MCP client can find and pay for data itself under a spend cap. The live registry carries a USD FX feed and a crypto spot feed; an RWA oracle (USD/IDR, gold) drives the offline demo.

## The problem it solves

Every payment rail assumes a human: cards need a billing identity, OAuth a consent screen, subscriptions someone to cancel. An agent has none, so it borrows a human's API key or goes without — and sellers, unable to meter a machine per call, fall back to flat plans and shared bearer secrets with no identity, budget or revocation.

AgentGate makes the API the unit of commerce: price and payout live on-chain, so an agent reads the cost before committing, buys a single call, and can tell a reliable service from a fake one — every point behind a score cost real money.

## Challenges I ran into

**Binding an invoice to a payment with no `transfer_id`.** The old chain let a transfer carry the nonce inside itself; a plain EVM transfer carries nothing. So `PaymentRouter.pay(serviceId, nonce, payTo)` forwards `msg.value` through — never custodying funds — and emits an indexed `Paid` event: verification is one receipt lookup matched on **both** service and nonce.

**Milliseconds versus seconds.** The old contracts reported block time in milliseconds and every reader assumed it; `block.timestamp` is seconds, so all three store `uint64(block.timestamp) * 1000`. Nine decimals became eighteen across ~90 call sites: units and time, not logic, caused most real defects.

**A test that lied.** A CLI test passed 5/5 while importing a constant that no longer existed: the import resolved to `undefined`, so the assertion degenerated into `undefined === undefined`. An adversarial sweep caught it; the suite never would.

**Not claiming compliance we don't have.** 0G has no x402 facilitator, so the wire scheme is named `exact-settled`, not `exact`: the buyer settles first and presents a tx hash rather than signing an authorization for a third party. A generic x402 client fails fast instead of hanging.

## Technologies I used

**Chain:** 0G Galileo Testnet (chain 16602, native OG, 18 decimals), verified with `cast chain-id`. **Contracts:** Solidity 0.8.28 pinned, Cancun target, Foundry-tested. **Client:** viem — no indexer, no API key: state from view calls, history from `eth_getLogs`. **Protocol:** HTTP 402 in an x402 V1 envelope (`accepts[]`, `X-PAYMENT`), EIP-191 `personal_sign` for mapping. **Stack:** TypeScript 5.6 (ESM, strict), Node 22, vitest, a Next.js dashboard, an MCP stdio server, and an Anthropic tool-use loop for the buyer agent — plus a deterministic mock model so the whole loop runs offline in one command.

## How we built it

Contract-first: `AgentGateRegistry` (services, attestations, scores), `PaymentRouter` (invoice-bound payment) and `SpendGuard` (an on-chain spend firewall), each Foundry-tested and ported semantics-first: one-based ids, owner-only admin, attestation dedup on `(serviceId, paymentTxHash)`, revert order preserved.

Above that the product sits on one seam, `ChainClient`, so changing chains meant one new implementation — middleware, proxy, invoice store, oracle, buyer agent, CLI and dashboard kept their logic. The work ran as a written plan of sixteen tasks, each ending typecheck, vitest and `forge test` green.

## What we learned

An interface seam is the cheapest insurance a project can buy. The chain layer was the most expensive component here, and replacing it cost far less than it should have — nothing above it knew which chain it was on.

Green tests are not evidence: one passed for months because a dead import made both sides of an assertion `undefined`. Assert against literals you can read in the test.

## What's next for AgentGate

The Galileo deployment landed: `AgentGateRegistry`, `PaymentRouter` and `SpendGuard` are live on chain 16602 (addresses in the README), with the CLI, MCP server and SDK on npm as `agentgate-0g`. The full loop ran between two independent wallets with real OG — register `0x4e15b95f…`, pay `0xebee2bc6…`, attest `0xd0a24968…`. Verify it: `npx agentgate-0g list`. 460 TypeScript and 42 Foundry tests green on main.

One surface did not migrate: the hosted dashboard still serves the pre-migration build, so the catalog and ledger in the demo run from the repo. Re-pointing it is first.

Then: re-seed the RWA oracle into the live registry; an authorization-settled ERC-20 rail — the on-chain `accepts[]` anticipates it, no contract change needed (a router-settled one would need a settlement path in `PaymentRouter`); `SpendGuard` in the request path, enforcing budgets on-chain not in the client; and staking-weighted attestations with slashing, since today's score counts payments but stakes nothing.

Further out, the same 402 loop that prices an HTTP API prices inference and storage — making agent-to-agent payment, not just agent-to-API, the next step. Every wrapped service deepens one shared registry that cannot be forked without its payment history.
