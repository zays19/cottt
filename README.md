# OWB Bot Toolkit

Tool ini sudah siap jalan untuk flow:
- create wallet massal
- fund wallet terpilih
- claim OWB massal
- sweep saldo balik ke wallet utama
- cek saldo wallet by selector (`1,2,4`, `1-5`, `1,3-6,9`, `all`)

## 1) Setup sekali

```bash
npm install
```

## 2) Isi `.env`

Wajib diisi manual:
- `MAIN_PRIVATE_KEY` untuk wallet utama (fund/sweep)
- `PRIVATE_KEY` jika mau run single claim lewat `npm run login`
- `INVITATION_CODE` jika wallet baru perlu join waitlist
- `PROXY_URL` opsional

Contoh variabel sudah disediakan di `.env.example`.

## 3) Jalankan menu utama

```bash
npm run menu
```

Menu:
1. Create wallet massal
2. Fund wallet massal (bisa pilih index wallet target)
3. Claim OWB wallet massal
4. Sweep saldo ke wallet utama
5. Lihat ringkasan wallet
6. Cek saldo wallet by selector/all

## 4) Run single wallet (opsional)

```bash
npm run login
```
