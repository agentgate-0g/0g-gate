# Buy Quickstart — Membeli Service AgentGate dari PC/Laptop Lain

Panduan membeli (memanggil) sebuah service berbayar AgentGate dari mesin lain.

Cara termudah: CLI terpublish `agentgate-0g` punya command `buy` — satu
perintah, tanpa clone repo:

```bash
export BUYER_SIGNER_KEY=0x…          # 32-byte hex, sudah di-fund
npx agentgate-0g buy <id> --max 5
# body respons → stdout (pipeable); kuitansi pembayaran → stderr
```

`buy` menjalankan seluruh **protokol x402** untuk Anda:

```
GET /svc/<id>  →  HTTP 402 + invoice (nonce, payTo, router, harga)
     →  bayar: PaymentRouter.pay{value: harga}(serviceId, nonce, payTo)
     →  GET /svc/<id> lagi dengan header X-PAYMENT (bukti bayar)
     →  gateway verifikasi log Paid on-chain  →  200 + data upstream
```

Ada **tiga cara** menjalankan alur ini dari PC lain:

- **Cara 0 — `agentgate buy`** (di atas): satu perintah, hanya butuh key funded.
  Flag: `--max <og>` (tolak invoice di atas budget), `--method`, `--body <json>`,
  `--gateway <url>`. Env `BUYER_SIGNER_KEY` (disarankan) atau flag `--key 0x…`.
- **Cara A — Buyer agent otonom** (`npm run agent`): agen LLM yang memilih
  service, membayar, dan merangkum datanya. Butuh repo di-clone.
- **Cara B — Manual x402** (curl + panggilan kontrak): integrasi mentah dari
  bahasa/PC apa pun, tanpa clone repo (tapi Anda yang memanggil router-nya).

> **🔑 `--key` itu rahasia.** Berbeda dari path file, isinya private key asli —
> masuk shell history dan terlihat di `ps`. Pakai env var `BUYER_SIGNER_KEY`;
> `--key` hanya untuk sekali jalan di shell yang Anda kendalikan sendiri.

---

## Prasyarat umum

1. **Akun 0G Galileo yang sudah funded.** Tiap panggilan memerlukan harga
   service + gas (kecil — 0G ±4 gwei). Isi dari faucet:
   <https://faucet.0g.ai> (0,1 OG per wallet per hari).
2. **Service tujuan harus aktif dan sudah ter-map di gateway.** Cek dulu dari
   mesin mana pun (zero-env, tanpa key):
   ```bash
   npx agentgate-0g list           # lihat id, harga, tier, ACTIVE
   npx agentgate-0g status <id>    # lihat payTo, endpoint, harga, attestation
   curl -i https://0g-gateway.equiflow.xyz/svc/<id>   # harus 402 (bukan 403/404/503)
   ```

> **💸 Tidak ada minimum transfer.** Batas bawahnya hanya `MIN_PRICE_WEI` di
> registry — 1e12 wei = 0,000001 OG — jadi micropayment sungguhan bisa jalan.
> Yang tetap berlaku: bayar di atas biaya gas Anda sendiri, atau membeli jadi
> tidak rasional.

> **⏱️ Invoice berlaku 5 menit.** `nonce` yang diterbitkan gateway hanya sah
> selama `INVOICE_TTL_MS` (default 300000 ms). Bayar + kirim bukti dalam jendela
> itu. Tiap `nonce` hanya bisa dipakai **sekali**, dan itu dijaga dua lapis:
> `PaymentRouter` menolak `(serviceId, nonce)` yang berulang **on-chain**, dan
> gateway membakar nonce-nya sebelum mem-proxy.

---

## Cara A — Buyer agent otonom (`npm run agent`)

Paket buyer bersifat privat (tidak di npm), jadi jalankan dari repo yang
di-clone.

```bash
git clone https://github.com/agentgate-0g/0g-gate.git
cd AgentGate
npm install
```

Set environment (buyer agent memakai `loadConfig()` langsung — tidak ada
default live seperti pada CLI, jadi mode/alamat kontrak harus eksplisit):

```bash
export AGENTGATE_MODE=live
export REGISTRY_CONTRACT_ADDRESS=0x…      # dari deploy
export PAYMENT_ROUTER_ADDRESS=0x…         # dari deploy
export BUYER_SIGNER_KEY=0x…               # key 0G yang funded
# opsional:
export ANTHROPIC_API_KEY=<kunci>   # tanpa ini, pemilih service pakai MockLlm
export BUYER_BUDGET_OG=5           # batas belanja, default 5
export ZG_RPC_URL=<rpc>            # default https://evmrpc-testnet.0g.ai
```

Jalankan:

```bash
npm run agent -- --task "Ambil kurs USD/IDR & harga emas untuk laporan treasury" --budget 5
```

Yang dilakukan agen (dicetak sebagai blok STEP 1–6, juga ke `logs/decisions.jsonl`):

1. **Catalog** — baca daftar service on-chain + skor + trust tier (view call).
2. **Decision** — LLM memilih satu service (MockLlm bila tanpa `ANTHROPIC_API_KEY`).
3. **Budget** — tolak bila harga melebihi budget (sebelum membayar).
4. **Payment** — panggil `PaymentRouter.pay` (nonce invoice terikat on-chain),
   lalu kirim ulang dengan `X-PAYMENT`; menangani `settlement_pending` (retry s/d 5×).
5. **Report** — merangkum data yang dibeli.
6. **Receipt** — polling attestation on-chain (≤ 5 dtk) untuk bukti skor.

> Tidak ada API key indexer di mana pun: langkah 1 dan 6 keduanya view call ke
> RPC publik.

---

## Cara B — Manual x402 (curl + panggilan kontrak, dari PC/bahasa apa pun)

Tidak perlu clone repo. Sisi buyer tidak butuh API key apa pun (verifikasi
dilakukan server). Anda hanya perlu: key 0G funded + cara memanggil kontrak +
`curl`.

Anggap `GW=https://0g-gateway.equiflow.xyz` dan service id `ID`.

### 1. Ambil invoice (402)

```bash
curl -s $GW/svc/$ID
```

Contoh body (ambil empat nilai ini):

```json
{"x402Version":1,"error":"X-PAYMENT header is required","accepts":[{
  "scheme":"exact-settled","network":"0g-galileo",
  "maxAmountRequired":"1000000000000000",    // ← harga dalam WEI (1 OG = 1e18)
  "asset":"OG",
  "payTo":"0xde24…",                         // ← tujuan pembayaran (address)
  "resource":"https://0g-gateway.equiflow.xyz/svc/ID",
  "extra":{
    "nonce":"1729132567522738",              // ← nonce yang WAJIB dipakai
    "serviceId": 1,
    "router":"0xbbc1…",                      // ← PaymentRouter yang harus dipanggil
    "settlement":"0g-payment-router",
    "nonceEncoding":"uint256-decimal"
  }
}]}
```

### 2. Panggil `PaymentRouter.pay`

Kirim transaksi ke `extra.router` dengan:
- **fungsi** = `pay(uint64 serviceId, uint256 nonce, address payTo)`,
- **`serviceId`** = `extra.serviceId`, **`nonce`** = `extra.nonce`, **`payTo`** = `payTo`,
- **`msg.value`** = `maxAmountRequired` wei (persis, atau lebih),
- **chain id** = `16602`.

Simpan **transaction hash**-nya. Dengan `cast`:

```bash
cast send "$ROUTER" "pay(uint64,uint256,address)" "$SERVICE_ID" "$NONCE" "$PAY_TO" \
  --value "$MAX_AMOUNT_REQUIRED" \
  --rpc-url https://evmrpc-testnet.0g.ai \
  --private-key "$BUYER_SIGNER_KEY"
```

Atau dengan viem — persis yang dilakukan `Live0gClient.transfer` di
`packages/chain/src/live-0g.ts`:

```js
import { createWalletClient, http, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const galileo = defineChain({
  id: 16602,
  name: '0G Galileo Testnet',
  nativeCurrency: { name: 'OG', symbol: 'OG', decimals: 18 },
  rpcUrls: { default: { http: ['https://evmrpc-testnet.0g.ai'] } },
});

const account = privateKeyToAccount(process.env.BUYER_SIGNER_KEY);
const wallet = createWalletClient({ account, chain: galileo, transport: http() });

const txHash = await wallet.writeContract({
  address: router,                                  // extra.router dari invoice
  abi: [{ name: 'pay', type: 'function', stateMutability: 'payable',
          inputs: [{ name: 'serviceId', type: 'uint64' },
                   { name: 'nonce',     type: 'uint256' },
                   { name: 'payTo',     type: 'address' }],
          outputs: [] }],
  functionName: 'pay',
  args: [BigInt(serviceId), BigInt(nonce), payTo],
  value: BigInt(maxAmountRequired),
});
// txHash ← 0x + 64 hex, dipakai di X-PAYMENT
```

> Jangan mengirim transfer biasa ke `payTo`. Transfer polos tidak membawa
> referensi invoice apa pun, jadi gateway tidak punya cara mengikatnya ke 402
> Anda — dan uangnya hilang tanpa mendapat data. Router-lah pengikatnya.

### 3. Susun header `X-PAYMENT`

Header = **base64 dari JSON** berikut (nama field tidak berubah; `transaction`
adalah tx hash, `nonce` adalah nonce yang sama):

```json
{"x402Version":1,"scheme":"exact-settled","network":"0g-galileo",
 "payload":{"transaction":"0x<txHash 64-hex>","nonce":"<nonce>"}}
```

```bash
XPAY=$(printf '%s' '{"x402Version":1,"scheme":"exact-settled","network":"0g-galileo","payload":{"transaction":"0x<txHash>","nonce":"<nonce>"}}' | base64 -w0)
```

### 4. Kirim ulang dengan bukti

```bash
curl -i $GW/svc/$ID -H "X-PAYMENT: $XPAY"
```

- **200** + body upstream → sukses. Header `X-PAYMENT-RESPONSE` (base64) berisi
  konfirmasi settlement `{success, transaction, network, payer}`.
- **402 `settlement_pending`** dengan `Retry-After: 2` → transaksi belum
  ter-mine; tunggu ~2 dtk dan **kirim ulang header yang sama** (s/d ~5×).
- **402 lain** (`invalid_payment_header`, `unknown_nonce`, `invoice_used`,
  `invoice_expired`, `wrong_target`, `amount_too_low`, `wrong_nonce`,
  `expired`, `not_found`) → invoice/pembayaran tidak cocok; ambil invoice
  **baru** (langkah 1) dan ulangi.

---

## Verifikasi hasil

```bash
# Skor service bertambah setelah panggilan sukses — tanpa API key
npx agentgate-0g status <id>
```

Panggilan sukses memicu `recordAttestation` on-chain, jadi kolom trust
`(sukses/total)` naik. Pembayaran oleh pemilik/akun payout service tidak
dihitung (anti wash-trading).

## Troubleshooting

| Gejala | Penyebab & solusi |
| --- | --- |
| Selalu dapat 402 walau sudah bayar | `nonce`/`payTo`/amount/tx-hash tidak cocok, atau invoice sudah kedaluwarsa (>5 mnt) / terpakai. Ambil invoice baru lalu bayar ulang dengan nonce baru. |
| Transaksi revert saat `pay` | `(serviceId, nonce)` sudah pernah dibayar — router menolak replay on-chain. Ambil invoice baru. |
| `402 settlement_pending` terus | Transaksi belum masuk blok; tunggu Retry-After dan kirim ulang header yang sama. Cek tx di <https://chainscan-galileo.0g.ai>. |
| `403 service_inactive` | Service di-pause pemilik. |
| `404 service_not_found` | Id salah. |
| `503 service_unavailable` | Service belum ter-map di gateway (atau upstream-nya privat). |
| Buyer agent gagal start di live | Kurang `AGENTGATE_MODE=live`, `REGISTRY_CONTRACT_ADDRESS`, `PAYMENT_ROUTER_ADDRESS`, atau `BUYER_SIGNER_KEY`. |

Terkait: alur penjual di [WRAP-QUICKSTART.md](WRAP-QUICKSTART.md); loop berbayar
lengkap di [TESTING.md](TESTING.md) §4e.
