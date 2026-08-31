# AgentGate demo — dubbing cue sheet

Timecodes for the rendered demo video (`agentgate-demo-1080p.mp4`, **1920×1080, 30 fps, 2:45, silent**).
Record the VO against these marks and lay it over the video — no re-cutting needed.

Every frame is real: terminal output was captured from live commands, and the dashboard scenes
are the repo's own UI reading the **deployed 0G Galileo registry**. Nothing is mocked up.

---

## Cue table

| # | In | Out | Len | On screen | VO cue |
|---|---|---|---|---|---|
| 1 | `0:00` | `0:18` | 18s | Dashboard landing — hero + live network stats | Problem + what it is |
| 2 | `0:18` | `0:40` | 22s | Terminal — `npx agentgate-0g@latest list` | Zero setup, real chain |
| 3 | `0:40` | `1:05` | 25s | Terminal — `curl -i .../svc/1`, then the nonce | The 402 is real |
| 4 | `1:05` | `1:40` | 35s | Terminal — `npm run demo`, six stages → receipt | The full loop |
| 5 | `1:40` | `2:10` | 30s | Dashboard `/activity` — on-chain ledger | Receipts, not ratings |
| 6 | `2:10` | `2:32` | 22s | Terminal — MCP config → tool result | Any agent can use it |
| 7 | `2:32` | `2:45` | 13s | Title card — three contract addresses | Live today + the one gap |

Each scene already carries a burned-in caption (headline + subline) that matches the VO beat, so
the video still reads correctly if someone watches it muted.

---

## Scene 1 · `0:00 – 0:18` — What it is

> **EN.** AI agents can't pay for the APIs they use. No cards, no logins, no accounts. AgentGate
> is the payment layer that fixes that on 0G. One command turns any HTTP API into a paid,
> on-chain service — and every paid call leaves a receipt on-chain.

> **ID.** Agen AI tidak bisa membayar API yang mereka pakai — tidak punya kartu, login, atau akun.
> AgentGate adalah lapisan pembayaran yang menyelesaikan itu di 0G. Satu perintah mengubah API HTTP
> apa pun menjadi layanan berbayar on-chain — dan setiap panggilan berbayar meninggalkan bukti on-chain.

*Read to land by 0:16 — the last 2s is the scroll settling on the live stats.*

---

## Scene 2 · `0:18 – 0:40` — Zero setup

> **EN.** That's the live on-chain service catalog, from a directory with nothing in it. No clone,
> no config file, no API key — not even a wallet. Every read is a public-RPC view call straight to
> the 0G registry contract. There is no indexer anywhere in that path.

> **ID.** Itu katalog layanan on-chain yang live, dari direktori kosong. Tanpa clone, tanpa file
> konfigurasi, tanpa API key — bahkan tanpa wallet. Setiap pembacaan adalah view call ke RPC publik
> langsung ke kontrak registry 0G. Tidak ada indexer sama sekali di jalur itu.

*The command finishes typing at ~0:23 and the table lands ~0:30. Hold the last line over the table.*

---

## Scene 3 · `0:40 – 1:05` — A real 402

> **EN.** A real HTTP 402, priced from the contract's own on-chain price list. It's the x402 V1
> envelope, but look at the scheme name: `exact-settled`, not `exact`. 0G has no x402 facilitator,
> so the buyer settles first and presents the transaction hash instead of signing an authorization
> for a third party. We named it differently so a generic x402 client fails fast — we don't claim
> compliance we don't have. And the nonce changes every call: single-use, burned on-chain.

> **ID.** HTTP 402 sungguhan, harganya dibaca dari daftar harga on-chain di kontraknya. Amplopnya
> x402 V1, tapi perhatikan nama skemanya: `exact-settled`, bukan `exact`. 0G tidak punya facilitator
> x402, jadi pembeli menyelesaikan pembayaran lebih dulu lalu menunjukkan hash transaksinya. Kami
> beri nama berbeda supaya klien x402 umum gagal cepat — kami tidak mengklaim kepatuhan yang tidak
> kami punya. Dan nonce-nya berubah setiap panggilan: sekali pakai, dibakar on-chain.

*The second command + differing nonce appear at ~0:56. Time "the nonce changes every call" to it.*

---

## Scene 4 · `1:05 – 1:40` — The full loop

> **EN.** Here's the whole loop end to end: register the service, get the 402, pay it, serve the
> data, attest the call on-chain, and score it. The CLI pays through the PaymentRouter contract,
> which binds the payment to the invoice nonce on-chain and rejects a replay — so the gateway
> verifies with one exact log lookup on the receipt. No scanning, no indexer, no facilitator, and
> the gateway never custodies a cent. This run is on the mock chain so it finishes in under a
> second; the same code path runs against 0G Galileo.

> **ID.** Ini keseluruhan alurnya: daftarkan layanan, terima 402, bayar, kirim data, catat atestasi
> on-chain, lalu beri skor. CLI membayar lewat kontrak PaymentRouter, yang mengikat pembayaran ke
> nonce invoice secara on-chain dan menolak replay — jadi gateway cukup satu pencarian log yang
> persis di receipt. Tanpa scanning, tanpa indexer, tanpa facilitator, dan gateway tidak pernah
> memegang dana. Ini berjalan di mock chain supaya selesai di bawah satu detik; jalur kode yang
> sama berjalan terhadap 0G Galileo.

> ⚠️ **Say "mock chain" out loud.** The caption says it too. Do not let this scene read as on-chain
> — the on-chain proof is Scene 5.

*The STEP 6 receipt with both tx hashes and `final score 1/1` lands ~1:32. Close on it.*

---

## Scene 5 · `1:40 – 2:10` — Receipts, not ratings

> **EN.** And this is the same system reading 0G back. Every registration, every payment, every
> attestation — written on-chain and read straight off it. That's why the trust score means
> something: it isn't a star rating anyone can farm, it's a count of payments that actually
> settled. A service owner paying their own service is served but deliberately never scored, so
> nobody can wash-trade their own reputation. Every row links to the public explorer — verify any
> of it yourself.

> **ID.** Dan ini sistem yang sama membaca kembali dari 0G. Setiap registrasi, setiap pembayaran,
> setiap atestasi — ditulis on-chain dan dibaca langsung dari sana. Itu sebabnya skor kepercayaannya
> berarti: bukan rating bintang yang bisa dikarang, tapi hitungan pembayaran yang benar-benar
> tersettle. Pemilik layanan yang membayar layanannya sendiri tetap dilayani tapi sengaja tidak
> diberi skor, jadi tidak ada yang bisa memoles reputasinya sendiri. Setiap baris tertaut ke
> explorer publik — silakan verifikasi sendiri.

*Stat tiles are on screen from 1:40; the ledger fills the frame by ~1:52.*

---

## Scene 6 · `2:10 – 2:32` — Any agent

> **EN.** And you don't have to use our CLI. One line of config, and any MCP-capable agent gets
> discover, inspect and pay as native tools. The three read tools need no key at all. The same npm
> package is also an importable SDK — CLI, MCP server and library, one install.

> **ID.** Dan Anda tidak harus memakai CLI kami. Satu baris konfigurasi, dan agen apa pun yang
> mendukung MCP langsung punya tool discover, inspect, dan pay secara native. Tiga tool baca sama
> sekali tidak butuh key. Paket npm yang sama juga bisa di-import sebagai SDK — CLI, server MCP,
> dan library, sekali install.

*The tool result JSON lands ~2:22.*

---

## Scene 7 · `2:32 – 2:45` — Live today

> **EN.** Contracts, gateway, CLI and SDK are live on 0G Galileo today. One thing isn't: our hosted
> dashboard still runs the pre-migration build — everything you just saw runs from the repo.
> Re-pointing it is first in our next wave. Try it right now: `npx agentgate-0g list`. No key required.

> **ID.** Kontrak, gateway, CLI dan SDK sudah live di 0G Galileo hari ini. Satu hal belum: dashboard
> yang kami host masih menjalankan build lama — semua yang barusan Anda lihat berjalan dari repo.
> Memindahkannya jadi prioritas pertama di wave berikutnya. Coba sekarang: `npx agentgate-0g list`.
> Tanpa key.

> 📌 **Keep the admission.** The Wave 3 form text already states this gap. A judge who runs
> `npx agentgate-0g list` and then opens the hosted dashboard finds the mismatch anyway — naming it
> first costs 6 seconds and buys the credibility of everything else.

---

## Dubbing notes

- **Pace:** the script runs ~430 words over 2:45 ≈ 156 wpm. Comfortable; don't rush Scene 4.
- **Silence:** the master has **no audio track at all**, so your DAW/editor sees a clean video-only
  stream — drop it on the timeline and record over it.
- **Trimming:** every scene boundary is on an exact second. If a VO line overruns, extend that
  scene by looping its final second rather than cutting the next scene's opening.
- **Music:** if you add a bed, keep it under −22 LUFS so the terminal text still reads as the focus.
- **Re-render:** scene durations live in `render.html` (`SCENES[].dur`). Change one, re-run the
  capture, and this cue sheet's timecodes shift accordingly.

---

## Merging your dubbed audio

Once the VO is recorded as `vo.wav` (or `.m4a`/`.mp3`), mux it onto the silent master:

```bash
cd docs/video
ffmpeg -i agentgate-demo-1080p.mp4 -i vo.wav \
  -c:v copy -c:a aac -b:a 192k -shortest \
  agentgate-demo-final.mp4
```

`-c:v copy` re-uses the video stream untouched, so there is no quality loss and it finishes in
about a second. If your VO is shorter than 2:45, drop `-shortest` so the video plays out to the end.

With a music bed under the voice:

```bash
ffmpeg -i agentgate-demo-1080p.mp4 -i vo.wav -i music.mp3 \
  -filter_complex "[2:a]volume=0.12[m];[1:a][m]amix=inputs=2:duration=first[a]" \
  -map 0:v -map "[a]" -c:v copy -c:a aac -b:a 192k agentgate-demo-final.mp4
```

Check the result before uploading:

```bash
ffprobe -v error -show_entries format=duration:stream=codec_type,codec_name \
  -of default=noprint_wrappers=1 agentgate-demo-final.mp4
```

---

## What is NOT in this video

Stated plainly so nobody is surprised by a question:

- **No live on-chain purchase.** No funded buyer wallet exists on the build machine, and the only
  key present is the service's own payout address — a self-payment is served but never attested, so
  the score would visibly fail to move. Scene 4 uses the mock chain and says so; Scene 5 carries the
  real on-chain proof. To add a live buy, follow `DEMO_RUNBOOK.md` §4 and re-record Scene 4.
- **No hosted dashboard.** By design — it still serves the pre-migration build (`DEMO_RUNBOOK.md` §0).
