# Backend Reservasi — Email Konfirmasi

Server kecil yang menerima reservasi dari website dan mengirim email konfirmasi
berisi detail booking + nomor BCA Virtual Account untuk dibayar.

## Yang kamu butuhkan
- Node.js versi 22 (LTS) — cek dengan `node -v`
- Akses email pengirim admin@pawsly.id via SMTP

> Panduan langkah demi langkah untuk non-programmer ada di **START-HERE.md**.
> README ini hanya detail teknis singkat.

## Email (SMTP)
Email dikirim via SMTP. Default `.env.example` sudah untuk Gmail/Google Workspace
(`smtp.gmail.com:465`). Kalau email pawsly.id ada di provider lain, ganti
`SMTP_HOST` dan `SMTP_PORT` sesuai info provider. Isi `SMTP_USER=admin@pawsly.id`
dan `SMTP_PASS` (App Password kalau Google, atau password SMTP dari provider).

## Cara menjalankan (lokal)

1. Buka folder ini di terminal, lalu install:
   ```
   npm install
   ```

2. Salin `.env.example` menjadi `.env`:
   ```
   cp .env.example .env
   ```
   Isi `SMTP_USER` (admin@pawsly.id) dan `SMTP_PASS`.

3. Jalankan:
   ```
   npm start
   ```
   Kalau muncul `Server listening on http://localhost:3001`, berarti jalan.

4. Tes cepat tanpa website (kirim data contoh, ganti email tujuan dengan email kamu):
   ```
   curl -X POST http://localhost:3001/api/reservations \
     -H "Content-Type: application/json" \
     -d '{"code":"FUFU-TEST1","branch":"Fu Fu Gading Serpong","table":"Meja 1","date":"2026-09-20","slots":["18:00","19:00"],"duration":2,"players":"4","addons":[{"name":"Teh Poci (1 teko)","qty":1,"price":35000}],"total":185000,"name":"Budi","email":"emailkamu@contoh.com","va":"1234500812345678"}'
   ```
   Cek inbox email tujuan (dan folder Spam untuk email pertama).

## Menyambungkan ke website

Di file `reservasi.jsx`, ubah baris:
```js
const API_BASE = "";
```
menjadi alamat server kamu, misalnya:
```js
const API_BASE = "http://localhost:3001";        // saat tes lokal
// const API_BASE = "https://reservasi-xxxx.onrender.com";  // setelah online
```
Kalau `API_BASE` kosong, website tetap jalan dalam mode preview (ketersediaan
meja disimulasikan, tanpa database/email). Kalau diisi, ketersediaan meja
diambil dari database asli dan tidak akan bisa dobel-booking.

## Database & ketersediaan meja

Booking disimpan di database SQLite (satu file, tidak perlu server database
terpisah). Saat ada yang memesan, server mengecek dan mengunci slot dalam satu
transaksi, jadi **dua orang tidak bisa memesan meja + jam yang sama**. Meja yang
dipesan tapi belum dibayar ditahan selama `HOLD_MINUTES` menit, lalu dilepas
otomatis.

Endpoint yang tersedia:
- `GET  /api/availability?branch=<id>&table=<id>&date=<YYYY-MM-DD>` — jam yang sudah penuh
- `POST /api/reservations` — buat booking (dipakai website)
- `GET  /api/reservations?key=ADMIN_KEY` — **pemilik**: lihat daftar booking terbaru
- `POST /api/reservations/:code/pay?key=ADMIN_KEY` — **pemilik**: tandai booking sudah lunas

Contoh melihat daftar booking (ganti KODE_RAHASIA dengan `ADMIN_KEY` kamu):
```
curl "http://localhost:3001/api/reservations?key=KODE_RAHASIA"
```
Contoh menandai lunas:
```
curl -X POST "http://localhost:3001/api/reservations/FUFU-ABC123/pay?key=KODE_RAHASIA"
```

## Menaruh server online (gratis)
Cara termudah untuk pemula: [Render](https://render.com) atau
[Railway](https://railway.app). Keduanya punya paket gratis.
- Upload folder ini ke sebuah repo GitHub (JANGAN ikutkan `.env` dan folder `data/`).
- Buat "Web Service" baru, arahkan ke repo itu.
- Build command: `npm install` — Start command: `npm start`.
- Tambahkan environment variables yang sama seperti isi `.env`.

**PENTING soal database di hosting:** di paket gratis, file bisa hilang saat
server restart/redeploy. Supaya booking tidak hilang, salah satu:
1. Pasang **persistent disk / volume** dan arahkan `DB_PATH` ke sana
   (mis. Railway Volume, atau Render Disk di paket berbayar); atau
2. Pindah ke database hosted gratis seperti **Supabase** atau **Neon** (Postgres).
   Bilang saja kalau mau versi Postgres — strukturnya sudah disiapkan untuk itu.

## Catatan
- Booking tetap tersimpan walau email gagal terkirim.
- Jaga kerahasiaan `SMTP_PASS` dan `ADMIN_KEY` — perlakukan seperti password. Kalau bocor, ganti/cabut password email-nya lalu buat yang baru.
- Nomor VA masih contoh sampai payment gateway (Xendit/Midtrans) tersambung.
