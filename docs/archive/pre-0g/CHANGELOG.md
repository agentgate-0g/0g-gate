# Changelog — pre-0G era (2026-06-29 → 2026-07-23)

> **Historical.** These are the release notes for AgentGate as it ran on **Casper
> Testnet**, before the migration to 0G Galileo. Every contract hash, price, CLI
> flag, env var and transaction link below is dead. They are preserved verbatim
> because they record what was actually released; the live changelog starts at
> v1.0.0 under the name `agentgate-0g`.

See [`../../../dashboard/app/docs/changelog/page.tsx`](../../../dashboard/app/docs/changelog/page.tsx)
for the current changelog.

---

## 2026-07-23 — CLI v0.2.1: wrap registers with accepts[]

Fix: live wrap on registry v2.
`agentgate wrap` now sends the v2 `accepts[]` argument (one native-CSPR option
from `--price`) instead of the removed v1 `price` arg — registering against the
v2 contract failed in 0.2.0. String args are guarded to printable ASCII (see the SDK
CLString bug below); the encoding is unit-tested byte-for-byte against the
on-chain-proven bytes.

## 2026-07-23 — CLI v0.2.0: registry v2, multi-asset accepts[] on-chain

Registry v2 (on-chain accepts[]). Services now
store a `Vec` on-chain — per-asset price list (native CSPR and/or
CEP-18 tokens with their EIP-712 domain) instead of a single native price. New unlocked
(upgradable) package
`hash-e09869a12ffcdbf58f53b3c7119b168beca5385a3f538415384a9ec80b9bf8df`; the legacy
locked v1 package stays on-chain as the rollback target and readers still decode its
layout.

402 derived from chain. The gateway now derives the
facilitator (WCSPR) rail from the service's on-chain `accepts[]` —
`FACILITATOR_SERVICES` becomes an optional operator override instead of the source of
truth. The catalog renders per-asset prices read from the contract.

CLI default registry → v2.
`REGISTRY_CONTRACT_PACKAGE_HASH` now defaults to the v2 package, and the service
parser understands both layouts (v2 first, v1 fallback).

Fix: non-ASCII args revert (SDK). casper-js-sdk
5.0.12 encodes a CLString's length prefix as UTF-16 units while the payload is UTF-8 —
any non-ASCII char (an em dash, say) makes stored calls revert with Odra
`LeftOverBytes` (user error 64649). On-chain writers now guard string args to ASCII.

## 2026-07-19 — Facilitator rail settles in WCSPR

Canonical wrapped-CSPR token. The official x402
(facilitator) rail now settles in `WCSPR` (Wrapped CSPR) — the canonical CEP-18 token
used by the make-software Casper x402 stack — instead of a bespoke test token. Buyers pay
with WCSPR minted 1:1 from CSPR on `testnet.cspr.trade`. Config-only change (the
`FACILITATOR_SERVICES` asset + EIP-712 domain); the native-CSPR rail is unchanged.

## 2026-07-18 — CLI v0.1.6

Facilitator buy shows the token amount. On the
facilitator (x402 v2) rail, `agentgate buy` and the MCP `agentgate_buy` tool now
print the real CEP-18 charge (e.g. `0.1 WCSPR`) instead of the on-chain nominal CSPR
price. Adds shared `formatUnits`/`formatToken` helpers; native-rail output is
unchanged.

MCP version. The `agentgate mcp` server now
advertises its real package version in the initialize handshake instead of a hardcoded
`0.1.0`.

## 2026-07-18 — CLI v0.1.5: official Casper x402 facilitator rail

Official x402 rail (opt-in, per service). AgentGate
now also speaks the official Casper x402 stack — `CEP-18` + `EIP-712` settled
through the CSPR.cloud `facilitator` — alongside the native-CSPR rail. A service listed
in `FACILITATOR_SERVICES` runs its whole `402 → pay → settle → attest` loop through
the facilitator (x402 v2, `PAYMENT-SIGNATURE` header); every other service stays on the
native rail, byte-unchanged. No contract redeploy — the settle tx hash is recorded as the
on-chain attestation.

Buyer. `agentgate buy` auto-detects a
facilitator invoice (by `x402Version`) and signs an EIP-712 authorization with the buyer
key — new `--key-algo` flag (default `secp256k1`); the MCP `agentgate_buy` tool
supports it too. CEP-18 has no native-transfer floor, so this unlocks true sub-CSPR
micropayments.

Gateway. A facilitator-enabled service verifies and
settles via the CSPR.cloud facilitator (gas sponsored by the facilitator), then proxies and
attests. Config: `FACILITATOR_URL`, `BUYER_KEY_ALGO`, `FACILITATOR_SERVICES`.
Proven end-to-end on Casper Testnet.

## 2026-07-18 — CLI v0.1.4

MCP readiness hint. When the
`agentgate mcp` server starts it now prints a readiness line to `stderr` — so
an agent harness (or a human) can tell the stdio server is up instead of guessing from
silence. `stdout` stays reserved for the JSON-RPC stream, so the transport is
unchanged; running it bare in a terminal no longer looks like a hang.

## 2026-07-18 — CLI v0.1.3: MCP server

MCP server — `agentgate mcp`. AgentGate is
now a Model Context Protocol stdio server, so any MCP-capable agent (Claude Desktop, a
custom client, an MCP-aware framework) gets AgentGate as native tools:
`agentgate_list_services`, `agentgate_get_service`,
`agentgate_get_invoice` (all read-only, no key) and `agentgate_buy` (pays a
402 invoice in native CSPR from the buyer key, capped by `maxCspr`). The published
CLI defaults to live Testnet, so the read tools work with zero configuration. See
the mcp reference.

Durable attestation queue. A served-and-paid
call whose on-chain attestation had not confirmed before a deploy or crash was
previously under-counted. Attestations are now persisted and
replayed on boot — idempotent on-chain via the
registry's seen-payments dedup — so trust scores never silently lose a paid call.

## 2026-07-07 — Security & community standards

CodeQL clean. Resolved every CodeQL alert (a
ReDoS pattern, a URL-validation check, and workflow permissions) — the repository scans
with zero open alerts.

Community health. Added the GitHub
community-standards files — `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` and
`SECURITY.md` — and enabled Dependabot.

## 2026-07-02 — CLI v0.1.2: `agentgate buy`

New command: `buy`. One command runs the
whole buyer exchange — fetch the `402` invoice, pay it with a native CSPR
transfer (`transfer_id` = nonce), retry with the `X-PAYMENT` proof — and
prints the response body to stdout with the payment receipt on stderr.
`--max` caps what it may pay; unknown/paused services and over-cap invoices are
refused before any payment. See the buy reference.

The buyer signer is `MOCK_BUYER_ACCOUNT` (mock) or `--pem` /
`BUYER_SIGNER_PEM_PATH` (live) — for `buy`, `--pem` means the buyer
key, not the seller key.

## 2026-07-02 — CLI v0.1.1

`@mdlog/agentgate` v0.1.1 published — `wrap` in live mode now prints the
hosted dashboard link for the wrapped service instead of a localhost URL.

A fresh-machine wrap walkthrough ships in the repo (`docs/WRAP-QUICKSTART.md`).

## 2026-07-01 — Gateway security hardening

Invoice persistence. New optional
`INVOICE_STORE_PATH` env var enables a file-backed invoice store so issued
invoices survive a gateway restart. See
Configuration.

Stricter payment verification. A payment must
now carry the invoice's `transfer_id` and the payment target on the same
transfer; the amount and age checks bind to that transfer.

Trust-score integrity. Calls paid from the
seller's own account are served but never attested (wash-trade guard),
gateway-level upstream failures are no longer scored, and attestation submission
retries with exponential backoff.

## 2026-07-01 — CLI on npm, self-service mapping & docs hardening

CLI on npm. `@mdlog/agentgate` v0.1.0
published — run it with `npx @mdlog/agentgate`, no install or clone. The
published CLI defaults to `live` mode and the deployed registry hash, so
`list` and `status` read Casper Testnet with no configuration. See
CLI.

Hosted endpoints. Gateway (
`gateway.mdloglabs.org`) and dashboard (`agentgate.mdloglabs.org`) brought
online so agents can transact without local setup.

Self-service gateway mapping. `wrap` now maps
the upstream with an owner-signed request to `/services/<id>/map` — a live wrap
needs only `--pem`, no admin token.

Role-oriented docs. The sidebar and overview map
are organized by role (For sellers / For buyers / Run a gateway) from a single source of
truth.

Docs accessibility + accuracy pass. Skip-to-content
link, keyboard focus rings, AA-contrast parameter tables, copy buttons on every code block,
a CLI config-flags reference, a corrected `status` no-key example, and fixed
cross-links.

Discovery. Added a sitemap, robots, canonical URLs,
OpenGraph/Twitter cards, JSON-LD, in-docs `⌘K`/`Ctrl-K` search, and this
changelog.

## 2026-06-30 — CLI made publish-ready

The CLI was renamed `@agentgate/cli` → `@mdlog/agentgate` and bundled into a
publishable package ahead of the next day's npm release.

## 2026-06-29 — Live on Casper Testnet

`AgentGateRegistry` deployed to Casper Testnet (network `casper-test`),
package hash `hash-10f92725…`. The full
`register → 402 → pay → serve → attest → score` loop runs on-chain. See
Smart contracts.
