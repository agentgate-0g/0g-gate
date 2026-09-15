# AgentGate — Hosting runbook

How to put the stack on the public internet on managed platforms (Vercel +
Railway). Deploying the **registry contract** itself is a separate runbook
([docs/DEPLOY.md](DEPLOY.md)); this document covers the **services**.

> **What the public instance actually runs (since 2026-09-15):** the gateway at
> `https://0g-gateway.equiflow.xyz` and the dashboard at
> `https://agentgate.equiflow.xyz` are pm2 processes on a single host behind a
> Cloudflare tunnel, both serving **0G Mainnet** (`ZG_NETWORK_PROFILE=mainnet`,
> the default), with a second pair serving Galileo (`ZG_NETWORK_PROFILE=galileo`,
> gateway `https://0g-gateway.mdloglabs.org`). That layout is
> [`deploy/agentgate.ecosystem.config.cjs`](../deploy/agentgate.ecosystem.config.cjs)
> and its runbook is [docs/DEPLOY-GATEWAY.md](DEPLOY-GATEWAY.md). The rest of
> this file is the platform-hosted alternative.

| Component | Where | Config in repo |
|---|---|---|
| Dashboard (Next.js) | Vercel | project settings (Root Directory = `dashboard`, see §1), [`.vercelignore`](../.vercelignore) |
| Middleware (402 gateway) | Railway | [`packages/middleware/Dockerfile`](../packages/middleware/Dockerfile), [`packages/middleware/railway.json`](../packages/middleware/railway.json) |
| Oracle (RWA feed) | Railway | [`packages/oracle/Dockerfile`](../packages/oracle/Dockerfile), [`packages/oracle/railway.json`](../packages/oracle/railway.json) |
| Devnet (mock chain, demo only) | Docker (compose) | [`packages/devnet/Dockerfile`](../packages/devnet/Dockerfile), [`docker-compose.hosting.yml`](../docker-compose.hosting.yml) |

Everything runs TypeScript directly via **tsx** (a root devDependency) — there is no
compile step for the Node services; the Docker images install the workspace and run
`npx tsx …/src/main.ts`.

---

## 1. Dashboard → Vercel

The repo is an npm-workspaces monorepo with the Next.js app in `dashboard/`
(hoisted `node_modules` at the root, `transpilePackages: ['@agentgate/shared',
'@agentgate/chain']` already set in `dashboard/next.config.mjs`).

### Project settings (there is no root `vercel.json`)

A root `vercel.json` that built from the workspace root was removed: Vercel never
expanded the npm workspaces from there, so `next` — which lives in
`dashboard/package.json` — was neither installed nor detected ("No Next.js
version detected" on every deploy). The Vercel CLI also drops a generated
`vercel.json` and a `.vercel/` link directory on first run; both are gitignored
and must stay out of the repo. Configure the project in the Vercel UI instead:

- **Root Directory** = `dashboard`
- Enable **"Include files outside the Root Directory"** (Settings → General) —
  required so `packages/shared`, `packages/chain` and the root lockfile are
  available to the build
- Framework preset: **Next.js**; Install Command: `npm install` (runs at the
  monorepo root automatically when the lockfile is at the root)

### Environment variables (Vercel → Settings → Environment Variables)

For **live mode** (the normal hosted configuration):

| Var | Value |
|---|---|
| `AGENTGATE_MODE` | `live` |
| `ZG_NETWORK_PROFILE` | `mainnet` (the default — 0G Mainnet, chain 16661) or `galileo` (0G Galileo Testnet, chain 16602). One variable selects RPC, chain id, network name, explorer, the three contract addresses and their deploy block |
| `ZG_RPC_URL` / `ZG_CHAIN_ID` / `ZG_NETWORK` / `ZG_EXPLORER_URL` | leave unset — each overrides one value of the selected profile |
| `REGISTRY_CONTRACT_ADDRESS` | leave unset (the profile's); set only for a deployment of your own (see §6) |
| `PAYMENT_ROUTER_ADDRESS` | leave unset (the profile's); set only for a deployment of your own (see §6) |
| `NEXT_PUBLIC_SITE_URL` | the public origin, for canonical/Open Graph links (default `https://agentgate.equiflow.xyz`) |
| `CONTRACTS_DEPLOY_BLOCK` | only with your own contracts — the block they were deployed in; `/activity` reads history from there (the profile knows its own) |
| `ACTIVITY_LOOKBACK_BLOCKS` | leave unset — an optional cap on the `eth_getLogs` window; any cap blanks `/activity` once the service idles longer than it |

> **Do not put `AGENTGATE_ADMIN_TOKEN` on Vercel.** The dashboard never reads it.
> It is read-only — every route is a GET, there is no `/admin` surface — so
> `dashboard/lib/server/chain.ts` calls `loadConfig(process.env, {
> requireStrongAdminToken: false })` and nothing in the app ever touches
> `config.adminToken`. Setting it there would copy the *gateway's* live
> credential into a second provider's dashboard, its build logs and its
> preview deployments, buying nothing at all. The token belongs on the
> middleware and nowhere else.

> **Mock-mode caveat:** in mock mode every chain read goes to `DEVNET_URL`
> (default `http://localhost:4030`) — meaningless from Vercel's servers. A hosted
> dashboard should therefore run in **live mode**. For a pure demo you *can* keep
> `AGENTGATE_MODE=mock` and point `DEVNET_URL` at a publicly hosted devnet (e.g.
> the `packages/devnet/Dockerfile` image on Railway), but never expose a mock
> devnet as if it were real chain state.

No `vercel` CLI needed: connect the Git repo and every push deploys.

---

## 2. Middleware + Oracle → Railway

Railway's model: one **project**, multiple **services**, each service points at the
same repo but builds its own Dockerfile. A single config file cannot express two
services, so each service carries its own config-as-code file.

### Per-service settings

Create two services from the same GitHub repo, then in each service's
**Settings → Config-as-code**, set the file path:

| Setting | middleware service | oracle service |
|---|---|---|
| Config-as-code path | `packages/middleware/railway.json` | `packages/oracle/railway.json` |
| → Builder | `DOCKERFILE` | `DOCKERFILE` |
| → Dockerfile path | `packages/middleware/Dockerfile` | `packages/oracle/Dockerfile` |
| → Healthcheck path | `/healthz` | `/healthz` |
| Networking | Generate Domain (public) | Generate Domain (public — buyers fetch the feed through the middleware, but a public oracle URL is handy for debugging) |

Railway builds with the **repo root as context**, which is exactly what the
Dockerfiles expect (equivalent to `docker build -f packages/middleware/Dockerfile .`).

### PORT mapping (how Railway's `PORT` reaches our config)

Railway injects a `PORT` env var and routes traffic to it. AgentGate's config
contract reads `MIDDLEWARE_PORT` / `ORACLE_PORT` instead, so each Dockerfile uses a
shell-form CMD that bridges the two:

```dockerfile
CMD ["sh", "-c", "MIDDLEWARE_PORT=${PORT:-4021} exec npx tsx packages/middleware/src/main.ts"]
```

No Railway-specific code anywhere — locally (no `PORT`) the defaults 4021/4010
apply, on Railway the injected `PORT` wins.

### Environment variables

**middleware** (live mode):

| Var | Value |
|---|---|
| `AGENTGATE_MODE` | `live` |
| `AGENTGATE_ADMIN_TOKEN` | strong unique token (config refuses the default in live mode) |
| `ZG_NETWORK_PROFILE` | `mainnet` (default) or `galileo` — must match the dashboard's, and a gateway serves ONE network: run two services for two networks |
| `ZG_RPC_URL` / `ZG_CHAIN_ID` / `ZG_NETWORK` / `ZG_EXPLORER_URL` | leave unset (the profile's) |
| `REGISTRY_CONTRACT_ADDRESS` | leave unset (the profile's); set only for a deployment of your own (see §6) |
| `PAYMENT_ROUTER_ADDRESS` | leave unset (the profile's); set only for a deployment of your own (see §6) |
| `GATE_SIGNER_KEY` | attestor private key (`0x` + 64 hex), injected from the platform's **secret store** — never a plain env var on a command line, never in a committed file. See [DEPLOY-GATEWAY.md](DEPLOY-GATEWAY.md#notes--security) for why an env-var key needs different handling than a key file |
| `INVOICE_STORE_PATH` | ✓ **required in live mode** — `/app/packages/middleware/data/invoices.json`, i.e. on the volume below. `createApp()` throws `CONFIG_INVALID` and the service never boots without it |
| `ATTESTATION_QUEUE_PATH` | recommended — `/app/packages/middleware/data/attestations.json`, same volume. Optional, but without it a served-and-paid call whose attestation had not confirmed before a restart is dropped from the trust ledger |
| `INVOICE_TTL_MS`, `UPSTREAM_TIMEOUT_MS` | optional tuning (defaults 300000 / 30000) |

**oracle**: needs nothing for the feed itself. Optionally `ORACLE_STATIC=1` for the
deterministic fixture feed (offline demo), `0` (default) for real FX/gold sources.
Leave `AGENTGATE_MODE` unset (= `mock`): the oracle never touches the chain, and
setting `live` would make `loadConfig()` demand a non-default admin token for
no benefit.

### Middleware state: persistent volume (required in live mode)

Attach a Railway **Volume** to the middleware service with mount path
`/app/packages/middleware/data`, and point `INVOICE_STORE_PATH` inside it. This
is not a nice-to-have on Railway: a live-mode gateway **refuses to start**
without `INVOICE_STORE_PATH`, and a path on the container's ephemeral layer
satisfies the check while still losing every in-flight invoice on the next
redeploy — a buyer who already paid on-chain, with no refund path in any of the
three contracts. Set `ATTESTATION_QUEUE_PATH` on the same volume too, so a
served-and-paid call whose attestation had not confirmed yet is replayed on
boot instead of being dropped from the trust ledger.

Three files then live there: the serviceId → upstream-URL map
(`upstreams.json`), the invoice store, and the attestation queue. (The gate
signer is a key in the environment, not a file — keep it in the platform's
secret store, never on this volume.)

Without a volume, every redeploy also starts with an empty upstream map.
On-chain registrations are untouched; re-add each mapping:

```bash
curl -X POST https://<middleware-domain>/admin/services \
  -H "Authorization: Bearer $AGENTGATE_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"serviceId": 1, "upstreamUrl": "https://<oracle-domain>/feed"}'
```

Invoices quote for 5 minutes (`INVOICE_TTL_MS`) but stay redeemable for
`INVOICE_REDEMPTION_WINDOW_MS` (24 h by default), which is exactly why they are
not in-memory: the window outlives any redeploy you are likely to do.

---

## 3. Local "production" demo — Docker Compose

A self-contained mock-mode stack (devnet + oracle + middleware) built from the
same production Dockerfiles. Host ports are **14030/14010/14021** so it never
collides with a `npm run dev` stack on 4030/4010/4021.

```bash
docker compose -f docker-compose.hosting.yml up -d --build

curl http://localhost:14030/healthz   # {"ok":true,"network":"mock"}   devnet
curl http://localhost:14010/healthz   # {"ok":true,"static":true}      oracle
curl http://localhost:14021/healthz   # {"ok":true,"network":"mock"}   middleware
```

Containers talk to each other by service name (`DEVNET_URL=http://devnet:4030` is
wired in the compose file). Point a locally running dashboard at it:

```bash
AGENTGATE_MODE=mock DEVNET_URL=http://localhost:14030 npm run dev:dashboard
```

Tear down (removes the named volume holding `upstreams.json`):

```bash
docker compose -f docker-compose.hosting.yml down -v
```

Individual images, built **from the repo root**:

```bash
docker build -f packages/middleware/Dockerfile -t agentgate-middleware .
docker build -f packages/oracle/Dockerfile     -t agentgate-oracle .
docker build -f packages/devnet/Dockerfile     -t agentgate-devnet .
```

---

## 4. Environment variable matrix

`✓ req` = required for that service in live mode; `opt` = optional; `—` = unused.

| Var | middleware (Railway) | oracle (Railway) | dashboard (Vercel) | devnet (demo) |
|---|---|---|---|---|
| `AGENTGATE_MODE` | `live` | leave `mock` | `live` | `mock` |
| `AGENTGATE_ADMIN_TOKEN` | ✓ req (non-default) | — | — (never set it here — the dashboard is read-only and disables the check) | — |
| `ZG_RPC_URL` | opt (has a default) | — | opt (has a default) | — |
| `ZG_CHAIN_ID` / `ZG_NETWORK` / `ZG_EXPLORER_URL` | opt (defaults) | — | opt (defaults) | — |
| `REGISTRY_CONTRACT_ADDRESS` | ✓ after deploy | — | ✓ after deploy | — |
| `PAYMENT_ROUTER_ADDRESS` | ✓ after deploy | — | ✓ after deploy | — |
| `GATE_SIGNER_KEY` | ✓ req (platform secret) | — | — | — |
| `INVOICE_STORE_PATH` | ✓ req in live mode (on the volume) | — | — | — |
| `ATTESTATION_QUEUE_PATH` | opt, recommended (same volume) | — | — | — |
| `CONTRACTS_DEPLOY_BLOCK` | opt (own contracts only) | — | opt (own contracts only) | — |
| `ACTIVITY_LOOKBACK_BLOCKS` | leave unset | — | leave unset | — |
| `DEVNET_URL` | mock mode only | — | mock mode only | — |
| `ORACLE_STATIC` | — | opt (`1` = fixture) | — | — |
| `INVOICE_TTL_MS` / `UPSTREAM_TIMEOUT_MS` | opt | — | — | — |
| `PORT` (injected by PaaS) | → `MIDDLEWARE_PORT` | → `ORACLE_PORT` | handled by Vercel | → `DEVNET_PORT` |

Unset values fall back to the defaults in `packages/shared/src/config.ts`
(`loadConfig()`), which also enforces the live-mode invariants: a default admin
token, a malformed signer key, or a malformed registry address make boot fail
loudly with `CONFIG_INVALID`. A malformed key is reported by variable name only —
the value never reaches a log line. **No API key is required anywhere**: every
read is a public-RPC view call.

---

## 5. Healthchecks

Every service exposes `GET /healthz` returning `200 {"ok":true,…}`:

| Service | Path | Wired into |
|---|---|---|
| middleware | `/healthz` | Railway healthcheck (`railway.json`) + compose `healthcheck` |
| oracle | `/healthz` | Railway healthcheck (`railway.json`) + compose `healthcheck` |
| devnet | `/healthz` | compose `healthcheck` (middleware waits for devnet-healthy) |

---

## 6. Pointing at a deployment of your own

Both 0G networks already carry a verified deployment that every process
defaults to through `ZG_NETWORK_PROFILE`, so this section only applies if you
deploy your **own** contract set ([docs/DEPLOY.md](DEPLOY.md)).

With the addresses explicitly emptied, live mode boots fine but every
contract-dependent call throws `CONTRACT_NOT_DEPLOYED` (503) — the full list is in
[docs/DEPLOY.md](DEPLOY.md). Once your contracts are deployed:

1. Record the three **contract addresses** from the deploy.
2. Set `REGISTRY_CONTRACT_ADDRESS`, `PAYMENT_ROUTER_ADDRESS` and
   `CONTRACTS_DEPLOY_BLOCK` on **every** live-mode service: the middleware
   (Railway) and the dashboard (Vercel) — plus any CLI/agent env. (Or record the
   set as a profile with `scripts/set-deployment.ts`, which verifies it against
   the chain first.)
3. Ensure `AGENTGATE_MODE=live` everywhere (middleware, dashboard). The
   live-mode invariants are the **middleware's**: a non-default
   `AGENTGATE_ADMIN_TOKEN`, a funded `GATE_SIGNER_KEY` (from the platform's
   secret store), and `INVOICE_STORE_PATH` on the volume. The dashboard needs
   none of the three — it is read-only and never signs, spends or admins.
4. Redeploy/restart both services (Railway and Vercel redeploy on env change).
5. Wrap the oracle for real: `npm run agentgate -- wrap --url https://<oracle-domain>/feed …`
   against the hosted middleware, then re-check `GET /healthz` and a full
   402 → pay → 200 round trip.

The devnet image and the compose stack stay what they always were: a mock-mode
demo. Nothing live ever points at them.
