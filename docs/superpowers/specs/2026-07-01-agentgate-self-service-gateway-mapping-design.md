# AgentGate — self-service gateway mapping (owner-signature auth)

**Date:** 2026-07-01
**Status:** Design approved (user chose "Testnet asli → satu baris"); security-sensitive (public write auth) — `/security-review` required before shipping.
**Packages:** `@agentgate/shared`, `@agentgate/chain`, `@agentgate/middleware`, `@mdlog/agentgate` (CLI), docs.

## Goal

Make the real-Testnet `wrap` a genuine one-liner where the **only** thing on the line besides the args is the wallet key:

```bash
npx @mdlog/agentgate wrap <url> --price 0.5 --name "Gold Spot Feed" --pem ./key.pem
```

To drop `--gateway` and `--admin-token` from the line, the gateway must (a) have a default hosted URL, and (b) accept the upstream mapping authenticated by a **signature proving on-chain ownership of the service**, instead of a shared admin bearer token.

`--pem` is irreducible: `register_service` is a signed, gas-paying tx; no key ⇒ no registration. This feature removes the gateway + admin-token from the line, not the key.

## Verified crypto model (against Testnet, real key)

- Sign: `priv.signAndAddAlgorithmBytes(message)` → **65 bytes** (1 algorithm-tag byte + 64-byte sig). `priv.sign()` (64 bytes, untagged) is NOT accepted by `verifySignature`.
- Verify: `PublicKey.fromHex(hex).verifySignature(message, sigBytes)` → returns `true`; **THROWS** `ErrInvalidSignature` on a bad sig (must be wrapped in try/catch → treat throw as invalid).
- Owner binding: `PublicKey.fromHex(hex).accountHash().toPrefixedString()` → `account-hash-<64hex>`, compared to the on-chain `service.owner`.
- `PublicKey` and `PrivateKey` are already exported from `packages/chain/src/sdk.ts`; the CLI loads keys via `packages/cli/src/identity.ts`.

## Endpoint contract

`POST <gateway>/services/:id/map` — no bearer token. Body:

```json
{ "upstreamUrl": "https://…", "publicKeyHex": "02…", "timestamp": 1751342400000, "signatureHex": "02<128hex>" }
```

Server steps (fail-closed, generic errors, never leak the upstream):
1. `id = parseServiceId` → 400 `invalid_service_id`.
2. Body shape check → 400 `invalid_body`. `timestamp` must be a safe integer (ms).
3. **Freshness:** `Math.abs(Date.now() - timestamp) <= SELF_MAP_WINDOW_MS` (120_000) → 401 `stale_request`.
4. **SSRF:** `validateUpstreamUrl(upstreamUrl, { rejectPrivateHosts: mode==='live' })` → 400 `verdict.error`. Keep `verdict.url.toString()` for storage.
5. `service = await services.get(id)` (ServiceCache) → 404 `service_not_found`.
6. **Owner + signature:** `message = buildSelfMapMessage({ network: chain.network, serviceId: id, upstreamUrl, timestamp })` — built from the **raw transmitted `upstreamUrl`** (not the normalized one, so bytes match the client). `chain.verifyOwnerSignature(publicKeyHex, message, signatureHex)` returns `{ accountHash, valid }` (fromHex + verifySignature wrapped in try/catch). Require `valid === true` → 401 `invalid_signature`; require `accountHash === service.owner` (case-insensitive) → 403 `not_service_owner`.
7. **Replay:** in-memory `Map<serviceId, lastTs>`; reject `timestamp <= lastTs[id]` → 409 `replayed`; else set it. (Freshness window bounds the rest across restarts.)
8. `await upstreams.set(id, verdict.url.toString())`; `logger.info('self_mapped', { serviceId: id })`; 204.

Rate-limited: mount a `rateLimit` on `/services` (same shape as the `/admin` limiter).

### Canonical message (single source of truth — `@agentgate/shared`)

`buildSelfMapMessage({ network, serviceId, upstreamUrl, timestamp }): Uint8Array` = `TextEncoder().encode` of the newline-joined, domain-separated string:

```
AgentGate/self-map/v1
<network>
<serviceId>
<upstreamUrl>
<timestamp>
```

Domain prefix + `network` + `serviceId` prevent cross-protocol / cross-network / cross-service replay; `timestamp` gives freshness; the raw `upstreamUrl` binds the payload. Both CLI (sign) and middleware (verify) import this one function.

## Component changes

- **shared:** `buildSelfMapMessage(...)`; `SELF_MAP_WINDOW_MS = 120_000`; `DEFAULT_GATEWAY_URL = 'https://gateway.mdloglabs.org'` (the hosted live gateway the user will deploy; overridable via `--gateway`).
- **chain:** `verifyOwnerSignature(publicKeyHex, message, signatureBytes): { accountHash: string; valid: boolean }` in a new `src/signature.ts`, using the `./sdk` `PublicKey` (fromHex + accountHash + verifySignature-in-try/catch); exported from index. Accept `signatureBytes` as `Uint8Array` (caller hex-decodes) OR accept hex — pick hex-in for a single decode site; helper does `hexToBytes`.
- **cli/identity.ts:** `signMessage(signer, message): Promise<{ publicKeyHex, signatureHex }>` — pem only (throws `SIGNER_UNSUPPORTED` for mock); refactor the PEM loader out of `pemIdentity` into a shared `loadPemPrivateKey(path)`.
- **cli/wrap.ts:** in **live** mode, step 2 becomes the signed self-map POST to `/services/<id>/map` (build message, `signMessage`, send `{upstreamUrl, publicKeyHex, timestamp, signatureHex}`); **mock** keeps the admin-token POST to `/admin/services`. Add `network` to `WrapServiceOpts` (from `config.casperNetwork`). The retry/warning path adapts (print the self-map retry hint, not the admin curl, in live).
- **cli/bin.ts:** live `--gateway` default becomes `DEFAULT_GATEWAY_URL` (mock still `http://localhost:<port>`); pass `network: config.casperNetwork`.
- **docs:** homepage/README wrap command → `wrap … --pem ./key.pem` (no gateway/admin-token); deploy recipe to host the live middleware at `DEFAULT_GATEWAY_URL`.

## Security properties

- **Only the owner can map:** signature verified under a pubkey whose account-hash equals the on-chain `owner`. An attacker cannot forge a signature nor present a pubkey that hashes to someone else's owner.
- **No cross-context replay:** domain prefix + network + serviceId + upstreamUrl are all inside the signed bytes.
- **No time replay:** ±120s freshness window + per-service monotonic timestamp.
- **No SSRF:** `validateUpstreamUrl` with `rejectPrivateHosts` in live (same guard as the admin path).
- **DoS:** `/services` rate-limited; `verifySignature` cost bounded per-IP/min.
- **No secret on the public line:** `--pem` is a path; the signature (not the key) is transmitted.

## Infra dependency (user's part)

There is **no hosted live gateway yet** (only `docker-compose.hosting.yml`, which is mock mode, + the dashboard). The one-liner's default `--gateway` needs a real live-mode middleware deployed at `DEFAULT_GATEWAY_URL`. This spec's code is fully testable locally (run the middleware in live mode on localhost, self-map an owned service). Actually hosting it publicly is the user's deploy step; a recipe ships in S5. Until hosted, users pass `--gateway http://localhost:4021`.

## Testing

- shared: `buildSelfMapMessage` determinism + exact byte layout.
- chain: `verifyOwnerSignature` — valid true; tampered → valid false (no throw escapes); bad hex → valid false.
- middleware: unit tests for each reject path (bad body, stale, SSRF, unknown service, bad sig, wrong owner, replay) + happy path 204 with a real signature over an owned test fixture.
- CLI: `signMessage` round-trips with `verifyOwnerSignature`; `wrapService` live path posts to `/services/:id/map` with a valid signed body (mock fetch).
- **Local end-to-end (network):** run middleware in live mode locally; self-map real owned service #1 with `gate.pem`; assert 204 + mapping stored; assert wrong-key → 403.
