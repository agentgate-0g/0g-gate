# AgentGate — Demo Video Script (0G Galileo)

**Target 2:45 · hard cut at 2:00** (§ Cut plan). For the Akindo WaveHack submission form.

Every command below was **executed and timed on 2026-08-31**. Every output shown is verbatim —
nothing here is a mock-up. Prep and failure modes: [`DEMO_RUNBOOK.md`](./DEMO_RUNBOOK.md).

Each scene is a self-contained card, recorded separately and joined in the edit:

- **🖥️ LAYAR** — what is captured on screen and what to highlight
- **⌨️ TERMINAL** — the exact copy-paste command (verified working)
- **🎙️ VO** — narration, English first (judges), Indonesian below

> **The video must do three things** — the form asks for a walkthrough that *explains the project,
> shows its features, and demonstrates it*. Scene 0 explains, Scenes 1–5 demonstrate. Do not drop
> Scene 0 even in the 2:00 cut.

---

## Scene 0 — What it is · `0:00 – 0:18`

**🖥️ LAYAR** — Local dashboard landing page, fullscreen (`DEMO_RUNBOOK.md` §3).
Hold on the hero: **"Stripe for AI agents on 0G."** Let the typing animation finish the
`npx agentgate-0g@latest wrap …` line, then slow-pan down to the live stats strip:
`SERVICES LISTED 2 · PAID CALLS ATTESTED 2 · REVENUE SETTLED 0.002 OG · NETWORK 0g-galileo`.

**🎙️ VO (EN)**
> AI agents can't pay for the APIs they use. No cards, no logins, no accounts.
> AgentGate is the payment layer that fixes that on 0G. One command turns any HTTP API into a
> paid, on-chain service. One command lets an agent discover it, pay it, and get the data —
> and every paid call leaves a receipt on-chain.

**🎙️ VO (ID)**
> Agen AI tidak bisa membayar API yang mereka pakai — tidak punya kartu, login, atau akun.
> AgentGate adalah lapisan pembayaran yang menyelesaikan itu di 0G. Satu perintah mengubah API
> HTTP apa pun jadi layanan berbayar on-chain. Satu perintah lagi membuat agen menemukannya,
> membayarnya, dan mendapat datanya — dan setiap panggilan berbayar meninggalkan bukti on-chain.

> 📌 Those stat numbers are read live from the deployed registry. If they've moved by recording
> day, that's good — say the real number.

---

## Scene 1 — Zero setup, real chain · `0:18 – 0:40`

**🖥️ LAYAR** — Clean terminal, **not** inside the repo. Show the `cd /tmp` so it's obvious there
is no clone and no config. Font ≥16 pt, window ≥1280 px so the table doesn't wrap.

**⌨️ TERMINAL**
```bash
cd /tmp
npx agentgate-0g@latest list
```

Verbatim output — **3.1 s** with npx pre-warmed:
```
ID  NAME                PRICE     TIER  SCORE  ACTIVE  ENDPOINT
1   USD FX Feed         0.001 OG  new   1/1    yes     https://0g-gateway.mdloglabs.org/svc/1
2   Crypto Spot Prices  0.001 OG  new   1/1    yes     https://0g-gateway.mdloglabs.org/svc/2
```

**🎙️ VO (EN)**
> That's the live on-chain service catalog, from a directory with nothing in it. No clone, no
> config file, no API key — not even a wallet. Every read is a public-RPC view call straight to
> the 0G registry contract. There is no indexer anywhere in that path.

**🎙️ VO (ID)**
> Itu katalog layanan on-chain yang live, dari direktori kosong. Tanpa clone, tanpa file konfigurasi,
> tanpa API key — bahkan tanpa wallet. Setiap pembacaan adalah view call ke RPC publik langsung ke
> kontrak registry 0G. Tidak ada indexer sama sekali di jalur itu.

---

## Scene 2 — The 402 is real · `0:40 – 1:05`

**🖥️ LAYAR** — Same terminal. Run the curl **twice**. Highlight in the edit (box or zoom):
`HTTP/2 402`, `"scheme":"exact-settled"`, `"network":"0g-galileo"`, and **the nonce on both runs**.

**⌨️ TERMINAL**
```bash
curl -i https://0g-gateway.mdloglabs.org/svc/1
```

Verbatim body (<1 s):
```json
{"x402Version":1,"error":"X-PAYMENT header is required","accepts":[{"scheme":"exact-settled",
"network":"0g-galileo","maxAmountRequired":"1000000000000000","asset":"OG",
"payTo":"0x71a89a7e692dac4d6bd7c3f1cca9155592d87bae",
"resource":"https://0g-gateway.mdloglabs.org/svc/1","description":"USD FX Feed",
"maxTimeoutSeconds":300,"extra":{"nonce":"7973784281089211","serviceId":1,
"settlement":"0g-payment-router","router":"0xfA5e4CC796390Cdca78C6E34664FE77Be1475FBB"}}]}
```
Second run → `"nonce":"302175800610721"`. **Different. That's the point.**

**🎙️ VO (EN)**
> A real HTTP 402, priced from the contract's own on-chain price list. It's the x402 V1 envelope,
> but notice the scheme name: `exact-settled`, not `exact`. 0G has no x402 facilitator, so the
> buyer settles first and presents the transaction hash, instead of signing an authorization for
> a third party. We named it differently so a generic x402 client fails fast instead of hanging
> forever — we don't claim compliance we don't have.
> And the nonce changes every call. It's single-use, burned on-chain and at the gateway.

**🎙️ VO (ID)**
> HTTP 402 sungguhan, harganya dibaca dari daftar harga on-chain di kontrak. Amplopnya x402 V1,
> tapi perhatikan nama skemanya: `exact-settled`, bukan `exact`. 0G tidak punya facilitator x402,
> jadi pembeli menyelesaikan pembayaran lebih dulu lalu menunjukkan hash transaksinya. Kami beri
> nama berbeda supaya klien x402 umum gagal cepat — kami tidak mengklaim kepatuhan yang tidak kami punya.
> Dan nonce-nya berubah setiap panggilan. Sekali pakai, dibakar on-chain dan di gateway.

---

## Scene 3 — Pay it, on-chain, for real · `1:05 – 1:40`

> ⚠️ Needs a funded buyer wallet that is **not** `0x71a89a…` or `0x4c6165…` —
> see `DEMO_RUNBOOK.md` §4. A self-payment is served but **never attested**, so the score
> would visibly fail to move. Fallback in the box below.

**🖥️ LAYAR** — Terminal. Load the key from the mode-600 file and `clear` before recording so no
key is ever in frame. Split-screen the dashboard `/services/2` page if you can: the score ticks up.

**⌨️ TERMINAL**
```bash
export BUYER_SIGNER_KEY=$(cat ~/.agentgate-buyer.key)
clear
npx agentgate-0g buy 2 --max 0.01
```

The data goes to **stdout**, the payment receipt to **stderr** — pipe-safe by design.

**🎙️ VO (EN)**
> Now the agent side. The CLI reads that 402, pays the invoice through the PaymentRouter contract,
> and retries with the transaction hash. The router binds the payment to the invoice nonce
> *on-chain* and rejects a replay — so the gateway verifies with one exact log lookup on the
> receipt. No scanning, no indexer, no facilitator, and the gateway never custodies a cent.
> Data on stdout, receipt on stderr — you can pipe this straight into another program.

**🎙️ VO (ID)**
> Sekarang sisi agen. CLI membaca 402 itu, membayar invoice lewat kontrak PaymentRouter, lalu
> mencoba ulang dengan hash transaksinya. Router mengikat pembayaran ke nonce invoice secara
> on-chain dan menolak replay — jadi gateway cukup satu kali pencarian log yang persis di receipt.
> Tanpa scanning, tanpa indexer, tanpa facilitator, dan gateway tidak pernah memegang dana.
> Data ke stdout, bukti bayar ke stderr — bisa langsung di-pipe ke program lain.

> **🔁 Fallback shot** (faucet dry / chain slow) — the offline loop, **0.67 s**, exit 0:
> ```bash
> DEVNET_PORT=$(freeport) ORACLE_PORT=$(freeport) MIDDLEWARE_PORT=$(freeport) npm run demo
> ```
> Six labelled stages in one screen, ending in `payment tx hash`, `attestation tx hash`,
> `final score: 1/1`. **Say "mock chain" out loud** — never let it read as on-chain.

---

## Scene 4 — Reputation is receipts · `1:40 – 2:10`

**🖥️ LAYAR** — Dashboard `/activity`, fullscreen. This is the strongest frame in the video.
Hold on the four stat tiles, then the ledger. Then **click one TX link** and let
`chainscan-galileo.0g.ai` load on camera — that hand-off from your UI to the public explorer is
the trust moment.

Verified on screen:
```
EVENTS 7  ·  PAYMENTS 3 (0.003 OG settled)  ·  ATTESTATIONS 2 (100% success 2/2)  ·  SERVICES 2
NETWORK 0g-galileo · POLLED EVERY 5S · ● LIVE

1h ago  ATTEST ✓  SVC-002  attestation success for service 2      confirmed  0xce166057…3b428f98 ↗
1h ago  PAYMENT   SVC-002  payment of 0.001 OG to 0x4C6165…c5B6   confirmed  0xe35c9324…91055e92 ↗
1h ago  REGISTER  SVC-002  service "Crypto Spot Prices" registered confirmed 0x361d9f7d…72e5b92a ↗
4h ago  ATTEST ✓  SVC-001  attestation success for service 1      confirmed  0xd0a24968…9aa063be ↗
4h ago  PAYMENT   SVC-001  payment of 0.001 OG to 0x71a89a…7BaE   confirmed  0xebee2bc6…eef2a815 ↗
5h ago  REGISTER  SVC-001  service "USD FX Feed" registered       confirmed  0x4e15b95f…15b2f249 ↗
```

**🎙️ VO (EN)**
> Every registration, every payment, every attestation — written to 0G and read straight back off
> it. This is why the trust score means something: it isn't a star rating anyone can farm, it's a
> count of payments that actually settled. And a service owner paying their own service is served
> but deliberately never scored, so nobody can wash-trade their own reputation.
> Every row links to the public explorer. Verify any of it yourself.

**🎙️ VO (ID)**
> Setiap registrasi, setiap pembayaran, setiap atestasi — ditulis ke 0G dan dibaca langsung dari sana.
> Ini alasan skor kepercayaannya berarti: bukan rating bintang yang bisa dikarang, tapi hitungan
> pembayaran yang benar-benar tersettle. Dan pemilik layanan yang membayar layanannya sendiri tetap
> dilayani tapi sengaja tidak pernah diberi skor, jadi tidak ada yang bisa memoles reputasinya sendiri.
> Setiap baris tertaut ke explorer publik. Silakan verifikasi sendiri.

---

## Scene 5 — Hand it to any agent · `2:10 – 2:32`

**🖥️ LAYAR** — Two beats. (a) The Claude Desktop config JSON, four seconds, no narration over the
paste. (b) Cut to the terminal returning the tool result.

**⌨️ TERMINAL**
```json
{ "mcpServers": { "agentgate": { "command": "npx", "args": ["-y", "agentgate-0g", "mcp"] } } }
```

Then the tool call result (verified, **8.0 s** — trim the `sleep` in the edit, or use `sleep 3`):
```json
[ { "id": 1, "name": "USD FX Feed", "price": "0.001 OG", "tier": "new",
    "score": "1/1", "active": true,
    "endpoint": "https://0g-gateway.mdloglabs.org/svc/1" }, … ]
```

**🎙️ VO (EN)**
> One line of config, and any MCP-capable agent gets discover, inspect, and pay as native tools.
> The three read tools need no key at all. The same npm package is also an importable SDK —
> CLI, MCP server, and library, one install.

**🎙️ VO (ID)**
> Satu baris konfigurasi, dan agen apa pun yang mendukung MCP langsung punya tool discover,
> inspect, dan pay secara native. Tiga tool baca sama sekali tidak butuh key. Paket npm yang sama
> juga bisa di-import sebagai SDK — CLI, server MCP, dan library, sekali install.

---

## Scene 6 — Honest close · `2:32 – 2:45`

**🖥️ LAYAR** — Title card. Three contract addresses, the repo URL, the npm package. Optionally a
half-second flash of `460 passed` and `42 tests passed`.

```
AgentGateRegistry  0x2f5b7AaD7bffcEc5B6cda95Af4439494C1D576dA
PaymentRouter      0xfA5e4CC796390Cdca78C6E34664FE77Be1475FBB
SpendGuard         0x08b4049802999245888E72D0C31Fb4cA55C30E1B
0G Galileo Testnet · chain 16602 · 460 tests · 42 Foundry tests
github.com/agentgate-0g/0g-gate  ·  npm: agentgate-0g
```

**🎙️ VO (EN)**
> Contracts, gateway, dashboard, CLI and SDK are all live on 0G Galileo today — everything you
> just saw is hosted, not a local build. Next is an ERC-20 rail over the price list that is
> already on-chain. Try it right now: `npx agentgate-0g list`. No key required.

**🎙️ VO (ID)**
> Kontrak, gateway, CLI dan SDK sudah live di 0G Galileo hari ini. Satu hal belum: dashboard yang
> kami host masih menjalankan build lama — semua yang barusan Anda lihat berjalan dari repo.
> Memindahkannya adalah item pertama di wave berikutnya, bersama rail ERC-20 di atas daftar harga
> yang sudah on-chain. Coba sekarang: `npx agentgate-0g list`. Tanpa key.

> 📌 **Keep the admission.** The Wave 3 form text already states this gap, and a judge who runs
> `npx agentgate-0g list` and then opens the hosted dashboard finds the mismatch anyway. Naming it
> first costs 8 seconds and buys the credibility of everything else in the video.

---

## Cut plan — the 2:00 version

| Scene | Full | 2:00 cut |
|---|---|---|
| 0 · What it is | 0:18 | **0:12** — hold the hero, drop the stats pan |
| 1 · Zero setup | 0:22 | **0:18** |
| 2 · Real 402 | 0:25 | **0:20** — one curl, mention the nonce instead of showing both |
| 3 · Pay on-chain | 0:35 | **0:30** |
| 4 · Receipts | 0:30 | **0:25** — stat tiles + one explorer click |
| 5 · MCP | 0:22 | **0:08** — config JSON only, one line of VO |
| 6 · Close | 0:13 | **0:07** — title card, keep the gap admission |

Cut Scene 5's terminal beat first — it's the most explicable in one sentence. Never cut Scene 0
(the form asks for an explanation) or the Scene 6 admission.

---

## Before you upload

- [ ] Three rehearsal passes clean (`DEMO_RUNBOOK.md` §7)
- [ ] `agentgate.mdloglabs.org` appears in **zero** frames
- [ ] No private key in any frame or scrollback
- [ ] Every on-screen number matches what the chain says on recording day — re-run the
      verification block in [`WAVE-3-SUBMISSION.md`](./WAVE-3-SUBMISSION.md) the morning of
- [ ] Video is public and playable in an incognito window before you paste the URL into the form
- [ ] Backup clip of Scene 3 recorded on a second device
