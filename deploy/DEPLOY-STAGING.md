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

## Deploy oleh Claude (via GitHub Actions) — direkomendasikan
Claude tidak dapat membuka SSH langsung dari sesinya. Deploy dijalankan oleh workflow `.github/workflows/deploy-staging.yml`; Claude memicu workflow tersebut, membaca log, dan memperbaiki bila ada yang gagal. Setiap push ke branch juga otomatis men-deploy ulang.

Ada dua jalur, dan workflow memilih otomatis (`auto`):

| Jalur | Cara kerja | Syarat |
|---|---|---|
| **ssh** | Runner GitHub masuk ke VPS lewat SSH dan menjalankan installer | Port SSH VPS terbuka untuk internet |
| **pull** | VPS memeriksa branch tiap 2 menit dan men-deploy sendiri (timer `kantor-auto-update`, dipasang oleh installer). GitHub hanya menunggu `/healthz` melaporkan revisi baru lalu menjalankan smoke test | Installer pernah dijalankan sekali di VPS; port SSH **tidak** perlu dibuka |

Setiap run diawali **diagnosis jaringan** (lihat ringkasan run): IP privat, domain yang tidak mengarah ke VPS, `STAGING_SSH_KNOWN_HOSTS` yang tidak cocok, serta status port 22/80/443 dari internet. Bila SSH tidak terjangkau, workflow memakai jalur pull. Jalur bisa dipaksa lewat input *Run workflow* atau variable repositori `STAGING_DEPLOY_VIA` (`auto`/`ssh`/`pull`).

**Persiapan sekali saja (±15 menit):**

1. **VPS & DNS**: buat VPS Ubuntu 22.04/24.04 (min. 1 vCPU / 1 GB) dan arahkan record **A** subdomain staging ke IP-nya.
2. **Kunci deploy**: di komputer Anda (atau di VPS), buat pasangan kunci khusus deploy:
   ```bash
   ssh-keygen -t ed25519 -N "" -C "deploy-staging" -f deploy_staging
   ```
   Tambahkan isi `deploy_staging.pub` ke `/root/.ssh/authorized_keys` di VPS (atau ke user yang punya sudo tanpa sandi).
3. **Host key** (disarankan): jalankan `ssh-keyscan <IP_VPS>` dan simpan hasilnya.
4. **GitHub Secrets**: repo → *Settings → Secrets and variables → Actions → New repository secret*:
   | Nama | Isi |
   |---|---|
   | `STAGING_SSH_HOST` | IP VPS |
   | `STAGING_SSH_USER` | `root` (atau user sudo) |
   | `STAGING_SSH_KEY` | seluruh isi file `deploy_staging` (kunci **privat**) |
   | `STAGING_SSH_KNOWN_HOSTS` | hasil `ssh-keyscan` (opsional, disarankan) |
   | `STAGING_SSH_PORT` | bila SSH bukan port 22 (opsional) |
   | `STAGING_ENV` | isi lengkap `staging.env` berdasarkan `deploy/staging.env.example`. Pakai `STAGING_BASIC_AUTH_PASSWORD` (sandi biasa), bukan hash. `SESSION_SECRET` boleh dikosongkan. |
5. Kabari Claude: "secrets sudah diisi". Claude akan menjalankan workflow, memantau log, dan melaporkan URL beserta hasil smoke test.

> Pada jalur pull, hanya `STAGING_ENV` yang wajib di GitHub; secret `STAGING_SSH_*` boleh dikosongkan.

### Bila SSH dari GitHub tidak terjangkau: jalur pull
Gejala: log berisi `ssh: connect to host *** port 22: Connection timed out`. Penyebab umumnya firewall/security group penyedia yang hanya mengizinkan IP Anda, IP yang salah/privat, atau SSH di port lain. Tanpa perlu membuka SSH, jalankan installer **sekali** di VPS (konsol web penyedia, atau SSH dari komputer Anda) sebagai root:
```bash
curl -fsSL https://raw.githubusercontent.com/tomydelvos/delvos/claude/law-office-ai-agent-c8ckgb/deploy/install-staging.sh -o install-staging.sh
sudo bash install-staging.sh
```
Saat ditanya, pilih **y** untuk menempel isi `STAGING_ENV` yang sama dengan di GitHub (akhiri dengan baris `END`), atau jawab pertanyaannya satu per satu. Installer menjalankan staging dan memasang timer auto-update; setelah itu setiap push ke branch otomatis ter-deploy dan diverifikasi oleh workflow.

- Kode diambil dari repositori publik lewat koneksi **keluar**; tidak ada kode dari GitHub Actions yang dijalankan di VPS.
- Konfigurasi ada di `/opt/kantor/deploy/staging.env` (VPS). Mengubah `STAGING_ENV` di GitHub tidak berpengaruh pada jalur pull; ubah file di VPS lalu jalankan `sudo bash /opt/kantor/deploy/install-staging.sh`.
- Log: `journalctl -u kantor-auto-update -n 100`. Matikan: `systemctl disable --now kantor-auto-update.timer`.
- Hanya commit yang lulus CI (job `test`) yang di-deploy. Revisi yang gagal dicoba ulang paling cepat 30 menit kemudian.

### Cek SSH dari komputer Anda (opsional)
Ganti `IP_VPS` dengan **IP publik VPS Anda** dari dashboard penyedia (bukan IP contoh), dan pakai path lengkap file kunci:
```bash
nc -vz -G 5 IP_VPS 22                                   # macOS (Linux: nc -vz -w 5 IP_VPS 22)
find ~ -name "deploy_staging*" 2>/dev/null              # cari file kunci
ssh -i ~/deploy_staging -o IdentitiesOnly=yes root@IP_VPS "echo ok"
```
Bila dari komputer Anda berhasil tetapi dari GitHub timeout, firewall penyedia membatasi IP asal; gunakan jalur pull.

Kunci privat dan kredensial hanya tersimpan terenkripsi di GitHub Secrets, tidak pernah lewat chat. Sandi penguji dalam bentuk teks biasa tidak disimpan di server (hanya hash-nya).

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
