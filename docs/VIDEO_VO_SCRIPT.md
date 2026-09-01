# AgentGate demo — voice-over script

For `docs/video/agentgate-demo-1080p.mp4` — **1920×1080, 30 fps, 2:45,0 exactly, no audio track**.

Read straight down the page. Each scene is written to **fit its own runtime at a normal
speaking pace**, so you can record it in one pass without rushing or padding. Word counts and
the pace they imply are listed per scene; anything at or under ~150 wpm is comfortable.

> This supersedes the VO lines in `VIDEO_CUE_SHEET.md`, which were written before the video was
> rendered and run as fast as 226 wpm in places. Use the timecodes there, the words here.

---

## Scene 1 · `0:00 – 0:18` · 18s · 42 words · 140 wpm

**On screen:** the dashboard landing page. Hero reads "Stripe for AI agents on 0G", then a slow
pan down to the live stats — 4 services listed, 4 paid calls attested, 0.004 OG settled,
`0g-galileo`.

> AI agents can't pay for anything. No cards, no logins, no accounts. So today an agent borrows
> a human's API key — or goes without the data. AgentGate fixes that on 0G: one command turns
> any HTTP API into a paid, on-chain service.

**ID:**

> Agen AI tidak bisa membayar apa pun. Tidak punya kartu, login, atau akun. Jadi hari ini agen
> meminjam API key milik manusia — atau tidak dapat datanya sama sekali. AgentGate menyelesaikan
> itu di 0G: satu perintah mengubah API HTTP apa pun jadi layanan berbayar on-chain.

---

## Scene 2 · `0:18 – 0:40` · 22s · 52 words · 142 wpm

**On screen:** a terminal in `/tmp`. `npx agentgate-0g@latest list` finishes typing at **0:23**;
the four-row table lands at **0:29**. Services 1 and 2 read `no` under ACTIVE — they are the
retired pair, left visible on purpose.

**Cue:** start speaking at 0:18; land "no indexer anywhere" after the table is up.

> This is the live catalog of services registered on 0G — read from an empty directory. No
> clone, no config file, no API key. Not even a wallet. Every read goes straight to the registry
> contract over public RPC. There's no indexer anywhere. One command, and any agent can discover
> what's for sale.

**ID:**

> Ini katalog layanan yang terdaftar on-chain di 0G — dibaca dari direktori kosong. Tanpa clone,
> tanpa file konfigurasi, tanpa API key. Bahkan tanpa wallet. Setiap pembacaan langsung ke
> kontrak registry lewat RPC publik. Tidak ada indexer sama sekali.

---

## Scene 3 · `0:40 – 1:05` · 25s · 61 words · 146 wpm

**On screen:** `curl -i` against the live gateway. The 402 body fills in from **0:43**; the
second command and the *different* nonce appear at **1:03**.

**Cue:** time "the nonce changes every single call" to land at 1:03, when both nonces are visible.

> Ask the gateway for that service and you get a real HTTP 402, priced from the contract's own
> list. It's the x402 envelope — but look at the scheme name. Exact-settled, not exact. 0G has no
> x402 facilitator, so the buyer settles first and presents the transaction hash. We don't claim
> compliance we don't have. And the nonce changes every single call.

**ID:**

> Minta layanan itu ke gateway, dan Anda dapat HTTP 402 sungguhan, harganya dibaca dari daftar
> di kontraknya sendiri. Amplopnya x402 — tapi lihat nama skemanya. Exact-settled, bukan exact.
> 0G tidak punya facilitator x402, jadi pembeli membayar lebih dulu lalu menunjukkan hash
> transaksinya. Kami tidak mengklaim kepatuhan yang tidak kami punya. Dan nonce-nya berubah
> setiap panggilan.

---

## Scene 4 · `1:05 – 1:40` · 35s · 78 words · 134 wpm

**On screen:** `npm run demo` streaming six labelled stages. The STEP 6 receipt — both tx hashes
and `final score 1/1` — lands at **1:34** and holds to the end of the scene.

**Cue:** this is the longest scene and the most technical. Take it slowly; you have room.
Say "mock chain" clearly — the caption says it too.

> The whole loop, end to end: register, 402, pay, serve, attest, score. The buyer pays through
> the PaymentRouter contract, which binds that payment to the invoice nonce on-chain and rejects
> a replay — so the gateway verifies with one log lookup on the receipt. No scanning, no indexer,
> no facilitator, and the gateway never holds a cent. This run is on the mock chain, so it
> finishes in under a second. The same code path runs against 0G Galileo.

**ID:**

> Keseluruhan alurnya: daftarkan layanan, terima 402, bayar, kirim data, catat atestasi, beri
> skor. Pembeli membayar lewat kontrak PaymentRouter, yang mengikat pembayaran itu ke nonce
> invoice secara on-chain dan menolak replay — jadi gateway cukup satu pencarian log di receipt.
> Tanpa scanning, tanpa indexer, tanpa facilitator, dan gateway tidak pernah memegang dana.
> Ini berjalan di mock chain supaya selesai di bawah satu detik. Jalur kode yang sama berjalan
> terhadap 0G Galileo.

---

## Scene 5 · `1:40 – 2:10` · 30s · 68 words · 136 wpm

**On screen:** the dashboard activity ledger. Stat tiles are up from **1:40** — 15 events, 7
payments, 0.007 OG settled, 4 attestations at 100%. The ledger rows fill the frame by **1:52**.

> And this is the same system reading 0G back. Every registration, every payment, every
> attestation — written on-chain, read straight off it. That's why the trust score means
> something. It isn't a star rating anyone can farm; it counts payments that actually settled.
> Pay for your own service and you still get served, but you're never scored. Every row links to
> the public explorer. Check any of it yourself.

**ID:**

> Dan ini sistem yang sama membaca kembali dari 0G. Setiap registrasi, setiap pembayaran, setiap
> atestasi — ditulis on-chain, dibaca langsung dari sana. Itu sebabnya skor kepercayaannya
> berarti. Bukan rating bintang yang bisa dikarang; ini menghitung pembayaran yang benar-benar
> tersettle. Bayar layanan Anda sendiri, tetap dilayani, tapi tidak pernah diberi skor. Setiap
> baris tertaut ke explorer publik.

---

## Scene 6 · `2:10 – 2:32` · 22s · 53 words · 145 wpm

**On screen:** the Claude Desktop config JSON, then the MCP tool result listing both services.
The result JSON lands at **2:28**.

> And you don't have to use our CLI. One line of config, and any MCP-capable agent gets discover,
> inspect and pay as native tools — under a spend cap. The three read tools need no key at all.
> The same npm package is also an importable SDK. CLI, MCP server and library — one install.

**ID:**

> Dan Anda tidak harus memakai CLI kami. Satu baris konfigurasi, dan agen apa pun yang mendukung
> MCP langsung punya tool discover, inspect, dan pay secara native — dengan batas belanja. Tiga
> tool baca sama sekali tidak butuh key. Paket npm yang sama juga bisa di-import sebagai SDK.

---

## Scene 7 · `2:32 – 2:45` · 13s · 28 words · 129 wpm

**On screen:** the title card — three contract addresses, 475 tests, 77 Foundry tests, the repo
and npm package.

**Cue:** the video ends at 2:45,0. Finish speaking by 2:43 so the last card breathes.

> Contracts, gateway, dashboard, CLI and SDK are all live on 0G Galileo today. Everything you just saw is hosted, not a local build. Try it: npx agentgate-0g list.

**ID:**

> Kontrak, gateway, CLI dan SDK sudah live di 0G Galileo hari ini. Semua yang barusan Anda lihat sudah live dan ter-host. Coba: npx agentgate-0g list.

---

## Recording notes

- **Pick one language and stay in it.** The burned-in captions are English, so English VO is the
  safest for an international panel; Indonesian VO over English captions also reads fine.
- **Record scene by scene**, not in one continuous take. Each scene starts on an exact second, so
  a per-scene file drops onto the timeline with no drift.
- **Leave 0.3s of silence** at the head and tail of each scene's recording. It gives you room to
  nudge without clipping a word.
- **Say the technical terms slowly**: `exact-settled`, `PaymentRouter`, `0g-galileo`,
  `npx agentgate-0g list`. Everything else can move.
- **Scene 4 is the one to rehearse.** It carries the most claims and the longest sentence.
- **Don't read the captions aloud.** They already say the headline; the VO adds the reasoning.

## Merging the audio

```bash
cd docs/video
ffmpeg -i agentgate-demo-1080p.mp4 -i vo.wav \
  -c:v copy -c:a aac -b:a 192k -shortest agentgate-demo-final.mp4
```

`-c:v copy` re-uses the video untouched — no quality loss, about a second to run. Drop `-shortest`
if your VO is shorter than 2:45 and you want the video to play out.

Verify before uploading:

```bash
ffprobe -v error -show_entries format=duration:stream=codec_type,codec_name \
  -of default=noprint_wrappers=1 agentgate-demo-final.mp4
```
