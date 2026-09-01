# AgentGate — Demo Runbook (0G Galileo)

**Purpose:** everything that must be true *before* you hit record, plus the failure modes
that would embarrass the take. Every timing and output below was **measured on this machine
on 2026-08-31**, not estimated.

Pair with [`VIDEO_SCRIPT.md`](./VIDEO_SCRIPT.md) — that is the shot list, this is the prep.

---

## 0. Use the right hostname

> ### The 0G dashboard is `agentgate-0g.mdloglabs.org`.
>
> `agentgate.mdloglabs.org` (no `0g-`) is the **older Casper dashboard**, still
> running alongside: `/api/services` there reports `network: casper-test` with
> prices in CSPR. Showing it in a 0G demo would undo the video's credibility.
>
> Verified on the 0G host: `network: 0g-galileo`, the `#x402-relationship`
> section is present, 24 mentions of `exact-settled`, zero of "casper".

Either the hosted 0G dashboard or a local production build works on camera —
they serve the same build from the same registry.

## 1. Machine state — check before every take

This machine runs the **live production gateway on port 4021** (cloudflared tunnels
`0g-gateway.mdloglabs.org` → `localhost:4021`).

```bash
# Confirm the live gateway is up — this is what judges hit
curl -sS https://0g-gateway.mdloglabs.org/healthz
# expect: {"ok":true,"network":"0g-galileo","attestor":"0x71a89a7e...87bae"}
```

> ⚠️ **Do not `pkill` anything matching `next`, `node` or port 4021.** Killing 4021 takes the
> public gateway offline mid-demo. Also note `pkill -f "<pattern>"` can match *your own shell* —
> always kill by PID resolved from the port:
> ```bash
> PID=$(ss -lptn "sport = :PORT" | grep -oP 'pid=\K[0-9]+' | head -1) && kill "$PID"
> ```

**Ports already occupied here:** `3000`, `3007`, `3456`, `4021`, `4030`, `14030`.
Never hardcode a port — allocate a free one:

```bash
freeport() { python3 -c "import socket;s=socket.socket();s.bind(('127.0.0.1',0));print(s.getsockname()[1]);s.close()"; }
```

---

## 2. Pre-warm (do this BEFORE recording, off camera)

`npx` on a cold cache adds ~30 s of dead air. Warm it, then the on-camera run is **3.1 s**.

```bash
cd /tmp && npx -y agentgate-0g@latest list >/dev/null 2>&1   # warm the npx cache
```

Re-run right before the take — npx cache entries expire.

---

## 3. Start the dashboard in LIVE 0G mode

Use the **production build**, not `next dev`. Dev mode paints a red **"1 Issue"** overlay badge in the
bottom-left corner that looks like a broken app on camera. Production has no overlay.

```bash
cd ~/Project-MDlabs/Akindo/agentgate-0g
npm run build                      # ~13 s, verified clean

PORT=$(python3 -c "import socket;s=socket.socket();s.bind(('127.0.0.1',0));print(s.getsockname()[1]);s.close()")
echo "dashboard → http://localhost:$PORT"
AGENTGATE_MODE=live \
REGISTRY_CONTRACT_ADDRESS=0x73bf79e35D33Acc944542E9DA3f17058e48DE4E1 \
PAYMENT_ROUTER_ADDRESS=0xE7C2C116869c0838Fd6dcD5FFE49F4Ac93fe1B8F \
ZG_RPC_URL=https://evmrpc-testnet.0g.ai \
npm start -w dashboard -- -p $PORT
```

**Verify before recording** — this must say `0g-galileo`, never `casper-test`:

```bash
curl -sS http://localhost:$PORT/api/services | head -c 120
# {"network":"0g-galileo","services":[{"service":{"id":1,"name":"USD FX Feed",...
```

Measured: first page ready **1.6 s** after start; `/catalog`, `/activity`, `/services/1` all HTTP 200 in <1 s.

> **Hide the port number in frame.** `localhost:55007` looks improvised. Either zoom past the
> URL bar, use browser fullscreen (`F11`), or map it to a nicer local name in `/etc/hosts`.

---

## 4. The live on-chain purchase — the only scene needing prep

This is the strongest shot in the video **and the only one that can't run as-is today.**

### Why it needs setup

```
BUYER_SIGNER_KEY   -> NOT SET on this machine
SELLER_SIGNER_KEY  -> NOT SET on this machine
GATE_SIGNER_KEY    -> 0x71a89a7e692dAC4d6BD7c3f1cCa9155592d87BaE  (3.26 OG)
```

The gate key **cannot** be the buyer. Since the attestor-topology fix it is the registered
**attestor** for services 3 and 4, and `AgentGateRegistry.sol:247` reverts `SelfPayment` when the
payer is the service's owner, payout target *or* attestor. The gateway refuses first, at
`packages/middleware/src/app.ts:623` (`isSelfPayment`), so a self-buy is **served but never
scored** — the score would visibly *not* move, contradicting the pitch mid-take. The seller
wallet is barred by the same rule.

### Addresses to avoid as buyer

| Role | Address |
|---|---|
| owner and `payTo` for services 3 and 4 | `0xb5b4a886da386830392a86288ed91d272de17746` |
| attestor for services 3 and 4 (the gate signer) | `0x71a89a7e692dac4d6bd7c3f1cca9155592d87bae` |

Services 1 and 2 are deactivated — they carry the old topology and cannot be bought.

### Setup (~5 minutes, do it the day before)

```bash
# 1. Generate a fresh buyer wallet — keep the key OUT of shell history
node -e "const {generatePrivateKey,privateKeyToAccount}=require('viem/accounts');
const k=generatePrivateKey();console.log('ADDRESS:',privateKeyToAccount(k).address);
require('fs').writeFileSync(process.env.HOME+'/.agentgate-buyer.key',k,{mode:0o600});"

# 2. Fund the printed ADDRESS at https://faucet.0g.ai  (0.1 OG/wallet/day — 100× enough)

# 3. Confirm it landed
curl -sS -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["<ADDRESS>","latest"]}' \
  https://evmrpc-testnet.0g.ai | python3 -c "import json,sys;print(int(json.load(sys.stdin)['result'],16)/1e18,'OG')"
```

**On camera** (never `export` the key in frame — load it from the mode-600 file):

```bash
export BUYER_SIGNER_KEY=$(cat ~/.agentgate-buyer.key)
clear                                      # scrub the export from the visible scrollback
npx agentgate-0g buy 3 --max 0.01
```

Cost per take: **0.001 OG + gas**. A 0.1 OG faucet drip funds ~50 rehearsals.

### Fallback if the faucet is dry or the chain is slow

Use the offline loop instead — it is *not* a lesser shot, it just isn't on-chain:

```bash
DEVNET_PORT=$(freeport) ORACLE_PORT=$(freeport) MIDDLEWARE_PORT=$(freeport) npm run demo
```

Measured **0.67 s total**, exit 0. Prints all six stages, both tx hashes, and `final score 1/1`.
Say "mock chain" out loud if you use it — do not let it read as on-chain.

---

## 5. Timing table (all measured, 2026-08-31)

| Shot | Command | Cold | Warm | Risk |
|---|---|---|---|---|
| Catalog, zero setup | `npx agentgate-0g@latest list` | ~30 s | **3.1 s** | pre-warm npx (§2) |
| Live 402 | `curl -i https://0g-gateway.mdloglabs.org/svc/1` | — | **<1 s** | none |
| Gateway health | `curl .../healthz` | — | **<1 s** | none |
| Offline full loop | `npm run demo` | — | **0.67 s** | ports (§1) |
| Dashboard first paint | `npm start -w dashboard` | 13 s build | **1.6 s** | port + prod build (§3) |
| MCP one-paste | README judges block | — | **8.0 s** | 8 s is `sleep 8` — dead air |
| Live buy | `npx agentgate-0g buy 2` | — | ~block time | needs funded wallet (§4) |
| Vitest summary | `npx vitest run` | — | **8.1 s** | 475 passed |
| Foundry summary | `forge test` | — | **~15 ms** | vendor forge-std first |

> The MCP block's 8 s is a literal `sleep 8` holding stdin open. On camera either **cut the wait
> in the edit**, or lower it to `sleep 3` (verified sufficient) so the take stays live.

---

## 6. Facts a judge can verify — keep these on screen

All re-verified against `https://evmrpc-testnet.0g.ai` on 2026-08-31.

| Claim | Evidence |
|---|---|
| Chain | `eth_chainId` → `0x40da` = **16602** (0G Galileo) |
| `AgentGateRegistry` | [`0x73bf79e3…E4E1`](https://chainscan-galileo.0g.ai/address/0x73bf79e35D33Acc944542E9DA3f17058e48DE4E1) — 18,140 chars bytecode |
| `PaymentRouter` | [`0xE7C2C116…1B8F`](https://chainscan-galileo.0g.ai/address/0xE7C2C116869c0838Fd6dcD5FFE49F4Ac93fe1B8F) — 1,882 chars |
| `SpendGuard` | [`0xBb79CaB7…C781`](https://chainscan-galileo.0g.ai/address/0xBb79CaB7b02f6C0301E7E87bdDC10D4F9F5DC781) — 12,268 chars |
| register tx | `0x58525104…85aad0` — status **1**, block 52462409 → Registry |
| pay tx | `0x5a811b41…923f0bb` — status **1**, block 52462505 → PaymentRouter |
| attest tx | `0x61828080…074f55` — status **1**, block 52462532 → Registry |
| Wire scheme | `exact-settled` (NOT x402 `exact`) — visible in the 402 body |
| Tests | **475** vitest passed, **77** Foundry passed |
| npm | `agentgate-0g@1.0.4` |

---

## 7. Rehearsal checklist

Run three full passes. A take is only clean if **all** of these hold:

- [ ] `curl .../healthz` says `0g-galileo` before you start
- [ ] npx pre-warmed — `list` returns in ~3 s, not 30
- [ ] Dashboard is the **production** build, showing `network 0g-galileo`, no "1 Issue" badge
- [ ] Browser is fullscreen; no bookmark bar, no other tabs, no port number readable
- [ ] `agentgate.mdloglabs.org` appears **nowhere**, including in an autocomplete dropdown
- [ ] Terminal font ≥ 16 pt; window ≥ 1280 px wide so the `list` table doesn't wrap
- [ ] Buyer wallet funded and **≠** `0x71a89a…` and **≠** `0x4c6165…`
- [ ] No private key visible in any frame or in scrollback (`clear` after `export`)
- [ ] Backup clip of the live-buy scene recorded on a second device
- [ ] Total runtime under the portal's cap; the 2:00 cut also renders

**Recording on Linux:** OBS Studio (X11/XWayland) or `wf-recorder` (Wayland). 1920×1080 @ 30 fps,
capture a single window rather than the full desktop so notifications stay out of frame.
Mute the system; record VO separately and lay it over.
