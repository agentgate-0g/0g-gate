# Wrap Quickstart — Test `agentgate wrap` dari PC Lain

Panduan singkat menjalankan `agentgate wrap` di mesin baru (tanpa clone repo,
tanpa file config, tanpa API key). CLI terpublish di npm sebagai
[`agentgate-0g`](https://www.npmjs.com/package/agentgate-0g) dan
default-nya langsung menargetkan **0G Galileo Testnet live** + gateway hosted.

## Prasyarat

1. **Node.js ≥ 22** — cek dengan `node -v`. Bila masih lama (Ubuntu/WSL
   bawaan sering masih v12), upgrade dulu via nvm:

   ```bash
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
   exec bash
   nvm install 22
   ```
2. **Private key 0G Galileo yang punya saldo OG.** Registrasi on-chain butuh
   gas (jumlahnya kecil — 0G ±4 gwei), jadi satu klaim faucet sudah cukup.
   Dua cara:
   - Salin private key yang sudah funded dari PC utama, **atau**
   - Buat key baru (mis. `cast wallet new`) lalu isi dari faucet:
     <https://faucet.0g.ai> (0,1 OG per wallet per hari)
3. Koneksi internet (RPC publik 0G + gateway hosted).

Hanya itu. Perintah `wrap` tidak butuh API key sama sekali — semua pembacaan
lewat RPC publik, dan mapping ke gateway memakai tanda tangan owner (EIP-191)
dari key yang sama, jadi admin token juga tidak perlu.

## Jalankan

```bash
export SELLER_SIGNER_KEY=0x…    # 32-byte hex, sudah di-fund

npx agentgate-0g wrap https://api.example.com/gold \
  --price 0.001 \
  --name "Gold Spot Feed"
```

> **Soal `--key`:** flag `--key 0x…` juga tersedia, tapi **isinya private key
> asli** — akan tercatat di shell history dan terlihat di `ps`. Pakai env var
> `SELLER_SIGNER_KEY` seperti di atas; `--key` hanya untuk sekali jalan di
> shell yang kamu kendalikan sendiri.

> **Tip:** `https://api.example.com/gold` hanya placeholder — registrasi dan
> invoice 402 tetap jalan, tapi panggilan berbayar akan gagal di upstream
> karena URL itu tidak ada. Untuk test end-to-end penuh pakai API yang hidup,
> mis. `https://httpbin.org/json`.

Yang terjadi:

1. **Registrasi on-chain** — `registerService` ke registry yang sudah
   ter-deploy via RPC `https://evmrpc-testnet.0g.ai`.
2. **Mapping upstream ke gateway** — POST bertanda tangan owner ke
   `https://0g-gateway.equiflow.xyz/services/<id>/map`. URL upstream **tidak**
   disimpan on-chain; hanya gateway yang mengetahuinya.

Output sukses terlihat seperti:

```
service id:      7
public endpoint: https://0g-gateway.equiflow.xyz/svc/7
dashboard:       https://agentgate-0g.mdloglabs.org/services/7
register tx:     0xa1b2c3…
explorer:        https://chainscan-galileo.0g.ai/tx/0xa1b2c3…
```

Baris `dashboard:` menunjuk ke dashboard hosted — buka di browser untuk
melihat detail service.

## Verifikasi

```bash
# katalog on-chain (zero-env, tanpa key)
npx agentgate-0g list

# detail satu service (termasuk riwayat attestation — tanpa API key)
npx agentgate-0g status <id>

# paywall hidup: harus menjawab HTTP 402 + invoice JSON
curl -i https://0g-gateway.equiflow.xyz/svc/<id>
```

## Aturan & flag penting

| Hal | Nilai |
| --- | --- |
| `--price` | OG desimal, minimal 0.000001 OG (1e12 wei), maksimal 18 angka di belakang koma |
| `SELLER_SIGNER_KEY` / `--key` | private key `0x` + 64 hex, wajib untuk write di mode live. **Env var lebih aman** daripada flag |
| `--description <d>` | deskripsi service (opsional) |
| `--gateway <url>` | ganti gateway (default hosted: `https://0g-gateway.equiflow.xyz`) |
| `--payment-target <0xaddress>` | tujuan pembayaran (default: address dari key) |
| `--attestor <0xaddress>` | address yang boleh mencatat attestation (default: address dari key) |
| `--rpc-url` / `--registry` / `--mode` | override RPC 0G, alamat registry, atau mode (default CLI terpublish: `live`) |

## Troubleshooting

- **`SIGNER_MISSING: live mode needs a seller key`** — `SELLER_SIGNER_KEY`
  belum di-export (atau `--key` kosong).
- **`CONFIG_INVALID: SELLER_SIGNER_KEY must be a 0x-prefixed 32-byte hex
  private key`** — format key salah. Pesan ini sengaja **tidak** menampilkan
  nilai key-nya; cek ada tidaknya kutip/newline nyasar di env var.
- **`TX_FAILED` / saldo kurang** — key belum di-fund; isi dari
  <https://faucet.0g.ai> lalu ulangi.
- **`TX_TIMEOUT`** — testnet sedang lambat; cek tx hash di
  <https://chainscan-galileo.0g.ai> sebelum mencoba lagi.
- **Warning "gateway upstream mapping … failed"** — registrasi on-chain
  **sudah jadi** dan tidak di-rollback. **Jangan jalankan `wrap` ulang**
  (akan membuat service duplikat); ulangi hanya langkah mapping setelah
  gateway bisa diakses (ikuti hint pada warning).
- **`SyntaxError: Unexpected token '?'` atau warning `EBADENGINE`** — Node
  terlalu lama (< 22); upgrade dengan perintah nvm di bagian Prasyarat, lalu
  jalankan ulang.
