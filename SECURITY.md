# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| `agentgate-0g` latest (1.0.x) | ✅ |
| `@mdlog/agentgate` (0.1.x–0.2.x, Casper) | ❌ — retired with the chain it ran on |

The on-chain contracts currently supported are the 0G Galileo Testnet
(chain ID 16602) deployments of `AgentGateRegistry`, `PaymentRouter` and
`SpendGuard` — see the README's "Deployed addresses" section for the live
addresses.

## Reporting a Vulnerability

Please **do not open a public issue** for security problems.

Preferred: use GitHub's private vulnerability reporting —
[Report a vulnerability](https://github.com/agentgate-0g/0g-gate/security/advisories/new).

Alternatively, email **adiadi2411@gmail.com** with:

- a description of the issue and its impact,
- reproduction steps or a proof of concept,
- any suggested fix, if you have one.

You can expect an acknowledgement within **72 hours** and a status update as
the fix progresses. Please give us a reasonable window to remediate before any
public disclosure.

## Scope notes

- The gateway only ever sees payment *proofs* (transaction hashes); it never
  holds user private keys. Signing keys for the demo deployment live outside
  the repository.
- Signer keys are read from environment variables (`GATE_SIGNER_KEY`,
  `SELLER_SIGNER_KEY`, `BUYER_SIGNER_KEY`), never from tracked files. Reports
  about key material leaking into logs, error messages, or process listings are
  in scope — the code paths that touch a key are written to redact it.
- Testnet OG has no monetary value, but vulnerabilities in the payment
  verification path (invoice nonce, `Paid` log matching, attestation binding)
  are still treated as high severity.
