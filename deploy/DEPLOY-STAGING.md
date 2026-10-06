# Deploy Staging

Staging adalah salinan sistem yang terhubung ke Gmail, WhatsApp, Telegram, dan AI sungguhan, tetapi **aman untuk uji coba**:

- Pesan hanya dikirim ke **akun staf aktif**, **grup Telegram**, dan alamat/nomor di `STAGING_ALLOWED_RECIPIENTS`. Pesan lain tidak dikirim; isinya tetap tersimpan dengan status **blocked** di *Log Notifikasi* sehingga penguji bisa membaca persis apa yang akan diterima klien.
- Subjek email, WhatsApp, dan Telegram diberi awalan **[STAGING]**, dan halaman web menampilkan banner oranye.
- Seluruh situs dilindungi sandi (basic auth) dan tidak diindeks mesin pencari. Pengecualiannya `/webhooks/*` (dibutuhkan Meta, diamankan dengan tanda tangan) dan `/healthz`.

## Yang dibutuhkan
| Kebutuhan | Contoh |
|---|---|
| VPS Ubuntu 22.04/24.04, min. 1 vCPU / 1 GB RAM | Biznet Gio, IDCloudHost, DigitalOcean (SG) |
| Subdomain yang diarahkan ke IP VPS (record **A**) | `staging.kantoranda.id` |
| Kotak masuk Gmail **khusus staging** | `intake-staging@kantoranda.id` |
| Nomor uji WhatsApp Cloud API (gratis dari Meta) atau nomor terpisah | — |
| Grup Telegram uji coba + bot | — |
| API key Anthropic | — |

> Jangan memakai inbox Gmail produksi untuk staging: kedua sistem akan berebut membaca email klien yang sama.

## Cara cepat: satu perintah
Di VPS baru (sebagai root), setelah DNS subdomain mengarah ke IP server:
```bash
curl -fsSL https://raw.githubusercontent.com/tomydelvos/delvos/claude/law-office-ai-agent-c8ckgb/deploy/install-staging.sh -o install-staging.sh
sudo bash install-staging.sh
```
Installer akan:
- memasang Docker dan firewall;
- menanyakan domain, sandi penguji, dan kredensial Gmail/WhatsApp/Telegram/Anthropic (boleh dikosongkan; kanal yang kosong berjalan simulasi);
- membuat sandi admin dan verify token acak;
- menjalankan stack, smoke test, dan cadangan harian;
- menampilkan URL serta login admin di akhir.

Aman dijalankan ulang untuk memperbarui ke versi terbaru: `staging.env` yang sudah ada tidak ditimpa.

## Langkah manual

### 1. Siapkan server
```bash
ssh root@IP_VPS
curl -fsSL https://get.docker.com | sh
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
git clone https://github.com/tomydelvos/delvos.git /opt/kantor
cd /opt/kantor && git checkout claude/law-office-ai-agent-c8ckgb
```

### 2. Konfigurasi
```bash
cd /opt/kantor/deploy
cp staging.env.example staging.env
docker run --rm caddy:2 caddy hash-password --plaintext 'sandi-penguji'   # salin hasilnya
nano staging.env
chmod 600 staging.env
```
Isi minimal:
- `STAGING_DOMAIN`, `ACME_EMAIL`, `PUBLIC_URL=https://<domain>`
- `STAGING_BASIC_AUTH_USER` dan `STAGING_BASIC_AUTH_HASH='…'` (**dalam tanda kutip tunggal**)
- `ADMIN_PASSWORD` (sementara, ganti setelah login), `SESSION_SECRET` (isi dengan `openssl rand -base64 32`)
- `STAGING_ALLOWED_RECIPIENTS`: email/domain dan nomor WA para penguji
- Kredensial Gmail, WhatsApp, Telegram, dan Anthropic (lihat README → *Menghubungkan kanal*)

### 3. Jalankan
```bash
docker compose -f docker-compose.staging.yml --env-file staging.env up -d --build
docker compose -f docker-compose.staging.yml --env-file staging.env logs -f app   # Ctrl+C untuk keluar
```
Caddy otomatis mengambil sertifikat HTTPS Let's Encrypt (pastikan DNS sudah mengarah ke VPS).

### 4. Cek otomatis
```bash
./smoke-test.sh https://staging.kantoranda.id penguji 'sandi-penguji' <WA_META_VERIFY_TOKEN>
```

### 5. Hubungkan webhook WhatsApp
Meta → App → WhatsApp → Configuration → Callback URL `https://staging.kantoranda.id/webhooks/whatsapp`, Verify token = `WA_META_VERIFY_TOKEN`, langganan field **messages**.

### 6. Daftar uji (UAT)
Masuk ke `https://<domain>/admin/` (sandi penguji, lalu akun admin). Jalankan skenario berikut:

1. **Pengguna**: buat akun staf untuk setiap penguji (isi email & WA, centang notifikasi). Login sebagai staf dan ganti kata sandi sementara.
2. **Kanal**: *Uji Coba → Tes kanal* untuk email, WhatsApp, dan Telegram. WA ke nomor yang belum chat 24 jam harus memakai template `notifikasi_kantor`.
3. **Email masuk**: dari alamat penguji, kirim email ke inbox staging. Dalam ±1 menit seharusnya ada balasan otomatis dengan tombol formulir, notifikasi WA/Telegram ke tim, dan triase AI di *Email Masuk*.
4. **Formulir**: klik tombol di email, isi dan unggah PDF. Cek halaman sukses, email konfirmasi, WA konfirmasi, notifikasi tim, ringkasan AI, dan hasil cek konflik.
5. **Status**: ubah ke *Perlu informasi tambahan* (pakai tombol dari ringkasan AI), lalu *Konsultasi dijadwalkan*. Periksa surat yang diterima.
6. **Penugasan**: tugaskan ke staf, lalu cek email/WA staf tersebut.
7. **WA masuk**: dari HP penguji, balas ke nomor kantor. Pesan harus muncul di grup Telegram dan riwayat registrasi.
8. **Pengaman**: isi formulir dengan email di luar daftar izin. Pesan ke alamat itu harus berstatus *blocked*.
9. **Edit**: ubah formulir (tambah pertanyaan), chatbot, dan template. Pastikan langsung tampil dan registrasi lama tetap terbaca.
10. **SLA**: biarkan satu registrasi tanpa ditinjau melewati target waktu. Pengingat harus masuk ke tim.

## Operasional
```bash
# Perbarui ke versi terbaru
cd /opt/kantor && git pull && cd deploy && docker compose -f docker-compose.staging.yml --env-file staging.env up -d --build

# Cadangan (database + berkas), simpan 14 terakhir di volume data
docker compose -f docker-compose.staging.yml --env-file staging.env exec app node scripts/backup.js

# Inspeksi cepat
docker compose -f docker-compose.staging.yml --env-file staging.env exec app node scripts/kantor.js stats

# Set/ganti kata sandi akun dari server
docker compose -f docker-compose.staging.yml --env-file staging.env exec app node scripts/set-admin-password.js admin 'sandi-baru-panjang'
```

Jadwalkan cadangan harian dengan `crontab -e`:
```
30 1 * * * cd /opt/kantor/deploy && docker compose -f docker-compose.staging.yml --env-file staging.env exec -T app node scripts/backup.js
```

## Naik ke produksi
Setelah UAT lulus, pakai berkas yang sama dengan `APP_ENV=production`, domain produksi, inbox Gmail produksi, nomor WhatsApp resmi, dan tanpa `STAGING_*`.
