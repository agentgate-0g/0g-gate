# Security Policy

AgentGate moves native OG between strangers' wallets on the strength of an
invoice, and its contracts are **not upgradable** — there is no proxy and no
admin key that can patch a deployed registry or router. A contract bug can only
be fixed by deploying to a new address and migrating every service and every
score across, so a report that arrives before a deployment is worth immeasurably
more than one that arrives after. Please send it.

## Supported Versions

| Version | Supported |
| ------- | --------- |
| `agentgate-0g` latest (1.0.x) | ✅ |
| `@mdlog/agentgate` (0.1.x–0.2.x, Casper) | ❌ — retired with the chain it ran on |

## Scope

**In scope — treat every one of these as protecting real money:**

- The three contracts in `contracts-evm/src` — `AgentGateRegistry`,
  `PaymentRouter`, `SpendGuard` — as source, and as the deployments listed in
  the README's "Deployed addresses" section.
- The gateway / 402 middleware (`packages/middleware`): invoice issuance and
  redemption, nonce handling, `Paid` log matching, attestation binding, the
  SSRF guard on seller-supplied upstream URLs, the admin and self-service
  mapping endpoints.
- The payment client, CLI, MCP server and buyer agent (`packages/client`,
  `packages/cli`, `packages/buyer-agent`) — including prompt-injection paths
  that reach a spend decision.
- Key handling anywhere in the repo: a signer key reaching a log line, an error
  message, a process listing, a crash dump or a committed file.
- The published npm package `agentgate-0g` and its release pipeline.

**The current deployments are on 0G Galileo Testnet (chain ID 16602).** That
does *not* narrow this policy. The mainnet profile (chain ID 16661) ships in
`packages/shared/src/config.ts` with deliberately empty addresses, and the code
that will run against it is the code in this repository today. Severity is
therefore assessed as if the finding were already on mainnet, because it is the
same code path and the deployment is a matter of when. Do not assume a bug is
low severity because the OG you moved proving it was free.

**Out of scope:**

- Third-party upstream APIs that sellers have wrapped. Registration is
  permissionless: anyone can point a service at any URL, and the gateway is a
  proxy. Attacking someone else's upstream *through* AgentGate is an attack on
  them, not a test of us — report the routing flaw, don't exploit it.
- The public 0G RPC endpoints, the block explorer, the faucet, and Cloudflare —
  report those to their owners.
- Volumetric denial of service, and anything requiring physical access, a
  compromised maintainer device, or social engineering of any person.
- Findings that require an operator to have already ignored the documented
  configuration (e.g. a key committed to *your own* fork).

## Reporting a Vulnerability

Please **do not open a public issue**, and do not disclose on-chain by
exploiting the finding beyond the minimum needed to prove it.

1. **Preferred — GitHub private vulnerability reporting:**
   [Report a vulnerability](https://github.com/agentgate-0g/0g-gate/security/advisories/new).
   This is the primary channel: it is private, it is not one person's inbox, and
   it keeps the report, the fix and the advisory in one place.
2. **Email fallback:** `security@agentgate-0g.invalid`
   > ⚠️ **PLACEHOLDER — the maintainer must replace this before the mainnet
   > deploy.** `.invalid` is a reserved TLD that can never resolve, so this
   > address deliberately bounces rather than quietly swallowing a report. Put a
   > real role mailbox here (one that more than one person can read), and
   > publish a PGP key fingerprint alongside it for reporters who need to
   > encrypt. Until then, use channel 1.

Include, as far as you can:

- a description of the issue and its impact — specifically, whose money or
  whose reputation score is at risk, and how much;
- reproduction steps or a proof of concept (a Foundry test or a failing vitest
  case is ideal, and goes straight into the regression suite);
- affected commit, contract address and chain id;
- any suggested fix.

## What you can expect

| Stage | Commitment |
| --- | --- |
| Acknowledgement that a human has read it | **within 72 hours** |
| Initial triage — reproduced or questions back, plus a severity | **within 5 business days** |
| Status update while it is open | **at least every 7 days** |
| Fix or documented mitigation, critical / high | target **14 days** |
| Fix or documented mitigation, medium / low | target **60 days** |
| Public advisory + credit (if you want it) | on the fix, or by mutual agreement |

This is maintained by a small team, so those are honest targets rather than a
contractual SLA — but if a date slips you will hear it from us before it does,
not after. We ask for **90 days** before public disclosure, less if a fix ships
sooner, and we will not use that window to sit on a fix. If a finding is being
actively exploited, say so and we will treat coordination as secondary to
stopping the loss.

There is **no paid bounty programme** at this time; we would rather say that
plainly than imply one. Credit in the advisory and in the release notes is
offered for every valid report.

## Safe harbour

If you make a good-faith effort to comply with this policy while researching a
vulnerability, we will consider your research **authorised**, we will not
initiate or support legal action against you over it, and we will not report you
to law enforcement. If a third party brings action against you for activity that
followed this policy, we will make that authorisation clear.

Good faith here means, concretely:

- Test against your **own** services, your own wallets and your own upstreams.
  Do not touch another user's funds, another seller's service, or data that is
  not yours; if you encounter someone else's data, stop and tell us.
- Prefer the testnet deployment and a local `anvil` fork for anything that
  moves value. Where a mainnet proof is genuinely necessary, use the smallest
  amount that demonstrates the bug.
- No volumetric DoS, no spam of the public RPC or the faucet, no social
  engineering, no physical attacks.
- Give us a reasonable window to remediate before public disclosure, as above.

This authorisation is ours to give only for the code and infrastructure we
operate. It does not extend to seller-operated upstreams, 0G's chain
infrastructure, or any other third party.

## Scope notes

- The gateway only ever sees payment *proofs* (transaction hashes); it never
  holds user private keys. Signing keys live outside the repository.
- Signer keys are read from environment variables (`GATE_SIGNER_KEY`,
  `SELLER_SIGNER_KEY`, `BUYER_SIGNER_KEY`), never from tracked files. Reports
  about key material leaking into logs, error messages, or process listings are
  in scope — the code paths that touch a key are written to redact it.
- The gateway's own key is the attestor key, deliberately kept thin: it pays
  attestation gas and holds no revenue. The payout key is a separate address the
  contracts refuse to conflate with it. A finding that breaks that separation —
  anything that lets a gateway key take, redirect or withhold a seller's
  revenue — is high severity by default.
- The payment-verification path (invoice nonce, `Paid` log matching,
  attestation binding, the self-payment guard) is the highest-severity surface
  in the repository. So is anything that lets a buyer be charged without being
  served, or served without the seller being paid.
