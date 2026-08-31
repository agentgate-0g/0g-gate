# Hosting the live AgentGate gateway

The CLI's live `wrap` defaults `--gateway` to `DEFAULT_GATEWAY_URL`
(`https://0g-gateway.mdloglabs.org`, in `packages/shared/src/config.ts`). For the
one-line `npx agentgate-0g wrap …` to complete its upstream
mapping, a **live-mode middleware** must be reachable at that URL. Reads
(`list`/`status`) never touch the gateway, so they work regardless.

The gateway exposes an owner-signature self-service map endpoint
(`POST /services/:id/map`) — sellers authorize their mapping by signing an
ownership challenge with their wallet key, so **no shared admin token is handed
out**. The gateway still needs its own credentials for payment verification and
attestations.

## Required environment (live)

| Var | Why |
|---|---|
| `AGENTGATE_MODE=live` | 0G Galileo Testnet, SSRF guard on, fail-closed gate signer |
| `REGISTRY_CONTRACT_ADDRESS` | the deployed `AgentGateRegistry` |
| `PAYMENT_ROUTER_ADDRESS` | the deployed `PaymentRouter` — `verifyTransfer` reads its `Paid` logs |
| `GATE_SIGNER_KEY` | attestor key (0x + 64 hex) the gateway signs `recordAttestation` with (funded) |
| `AGENTGATE_ADMIN_TOKEN` | a strong unique token (the shipped default is refused in live) — only guards the legacy `/admin/services`; self-service mapping does not use it |
| `TRUST_PROXY=1` | when behind exactly one platform proxy (Railway/Fly/Cloudflare), so rate-limit keys off the real client IP |
| `INVOICE_STORE_PATH` | JSON file for the `FileInvoiceStore` — issued invoices survive a gateway restart, so a buyer who already paid on-chain can still redeem (finding F2). Unset = in-memory only |

## Run it

The middleware ships a production Dockerfile (`packages/middleware/Dockerfile`).

```bash
docker build -f packages/middleware/Dockerfile -t agentgate-gateway .
docker run -d --name agentgate-gateway -p 4021:4021 \
  -e AGENTGATE_MODE=live \
  -e REGISTRY_CONTRACT_ADDRESS="$REGISTRY_CONTRACT_ADDRESS" \
  -e PAYMENT_ROUTER_ADDRESS="$PAYMENT_ROUTER_ADDRESS" \
  -e AGENTGATE_ADMIN_TOKEN="$(openssl rand -hex 32)" \
  --env-file /path/to/gate-signer.env \
  -e TRUST_PROXY=1 \
  -v agentgate-gateway-data:/app/packages/middleware/data \
  agentgate-gateway
```

Then put a TLS-terminating reverse proxy / tunnel in front and point the DNS for
`0g-gateway.mdloglabs.org` at it. Health check: `GET /healthz` → `{ ok, network }`;
readiness (chain reachable): `GET /readyz`.

## Verify

```bash
# from a seller box, with a funded wallet key:
export SELLER_SIGNER_KEY=0x…
npx agentgate-0g wrap https://api.example.com/gold --price 2.5 --name "My API"
# → prints service id + public endpoint; the gateway logs `self_mapped`.
curl https://0g-gateway.mdloglabs.org/svc/<id>        # → 402 payment challenge
```

If the gateway is unreachable when you `wrap`, the on-chain registration still
succeeds; the CLI prints a warning and the `/svc/<id>` endpoint 404s until the
mapping is (re-)done against a reachable gateway. The only price floor is the
registry's own `MIN_PRICE_WEI` (1e12 wei = 1e-6 OG), so true micropayments are
available — but price above what the buyer's gas costs them, or paying is
irrational.

## Notes / security

- Self-service mapping is authenticated by an on-chain-owner signature over a
  domain-separated challenge (`packages/shared/src/self-map.ts`), verified in
  `packages/middleware/src/app.ts` against `service.owner`. It is rate-limited,
  freshness-windowed (120 s), and monotonic-per-service against replay, and runs
  the same SSRF guard as the admin path.
- **Protect `GATE_SIGNER_KEY` as an environment secret, not as a file.** It is a
  raw private key in the process environment, which is a materially different
  threat model from a mode-600 key file: an env var is readable through
  `docker inspect`, `/proc/<pid>/environ`, platform dashboards, `ps -E` on some
  systems, and crash dumps — none of which a chmod-600 file exposes. Concretely:
  - Inject it from the platform's secret store (Railway/Fly secrets, Docker
    `--env-file` with a mode-600 file outside the image, systemd
    `EnvironmentFile=` at mode 600 owned by the service user). Never `-e KEY=…`
    on a command line, which lands in shell history and `ps`.
  - Never bake it into an image layer or a committed compose file.
  - Keep the gate key funded but *thin* — it only pays attestation gas. Its
    blast radius should be one day of attestations, not a treasury.
  - Rotate by deploying a new key and calling `setAttestor(serviceId, newAddr)`
    per service (owner-only); the old key stops being able to attest immediately.
  - The application never logs a key: `loadConfig()` reports a malformed key by
    variable name only, and the logger redacts any field whose name matches a
    key/token pattern.
- Until this gateway is live, sellers can point `--gateway http://localhost:4021`
  at a locally-run middleware.

## This box's setup (cloudflared, matches the dashboard)

The repo already runs live via `scripts/live.ts` and this box already tunnels the
dashboard through cloudflared. Mirror that for the gateway.

**1. Run the gateway durably** (the dev process is session-scoped). This box
uses **PM2** (its daemon already runs), so the gateway + dashboard are defined in
`deploy/agentgate.ecosystem.config.cjs` and started with:

```bash
pm2 start deploy/agentgate.ecosystem.config.cjs   # agentgate-gateway (:4021) + agentgate-dashboard (:3000)
pm2 save                                           # persist across reboot (pm2 startup is configured)
pm2 status ; pm2 logs agentgate-gateway
curl -s http://127.0.0.1:4021/healthz              # {"ok":true,"network":"0g-galileo"}
```

Alternative (no PM2): a systemd `--user` unit is shipped at
`deploy/agentgate-gateway.service` — `cp` it to `~/.config/systemd/user/`,
`loginctl enable-linger "$USER"`, then `systemctl --user enable --now agentgate-gateway`.

**2. Set `TRUST_PROXY=1` in `.env`** (behind exactly one Cloudflare hop) so the
rate limiter keys off the real client IP, then restart the unit.

**3. Expose `0g-gateway.mdloglabs.org` → `http://localhost:4021`** — pick one:

- **A — add a public hostname to the existing (dashboard) tunnel** (fastest, no
  second process): Cloudflare **Zero Trust → Networks → Tunnels →** the dashboard
  tunnel **→ Public Hostnames → Add** → subdomain `0g-gateway`, domain
  `mdloglabs.org`, service `HTTP → localhost:4021`. Done — no CLI, no code change
  (`DEFAULT_GATEWAY_URL` already points here). The `0g-` prefix is not optional:
  `gateway.mdloglabs.org` is the retired Casper deployment, and pointing this
  tunnel there registers services against a different chain's registry.

- **B — a dedicated locally-managed tunnel** (all CLI; uses the existing
  `~/.cloudflared/cert.pem`):

  ```bash
  cloudflared tunnel create agentgate-gateway
  cloudflared tunnel route dns agentgate-gateway 0g-gateway.mdloglabs.org
  # ~/.cloudflared/agentgate-gateway.yml:
  #   tunnel: <UUID printed by create>
  #   credentials-file: /home/mdlog/.cloudflared/<UUID>.json
  #   ingress:
  #     - hostname: 0g-gateway.mdloglabs.org
  #       service: http://localhost:4021
  #     - service: http_status:404
  cloudflared tunnel --config ~/.cloudflared/agentgate-gateway.yml run agentgate-gateway
  ```

**4. Verify publicly:**

```bash
curl -s https://0g-gateway.mdloglabs.org/healthz     # {"ok":true,"network":"0g-galileo"}
# from any box with a funded wallet key:
export SELLER_SIGNER_KEY=0x…
npx agentgate-0g wrap https://open.er-api.com/v6/latest/USD --price 0.001 --name "USD FX"
curl -i https://0g-gateway.mdloglabs.org/svc/<id>     # 402 challenge
```

Note: a public gateway spends the gate key's OG on an on-chain attestation per
**successful paid** call (buyers pay first, so it is self-limiting, not an open
drain). Keep the gate key funded.
