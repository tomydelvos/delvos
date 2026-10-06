# Kantor Virtual Hukum — 3 Agen AI untuk Penerimaan Calon Klien

Sistem otomasi administrasi kantor hukum dengan **tiga agen mandiri**:

| Agen | Peran |
|---|---|
| 🗂 **Administratif** | Menerima email klien, memberi nomor referensi, membalas secara profesional dengan tautan formulir pribadi, menerbitkan nomor registrasi, mengirim konfirmasi & surat perubahan status. |
| ⚙️ **Operasional** | Memantau kotak masuk (IMAP), mengirim & mengulang notifikasi (Email/WhatsApp/Telegram), memantau SLA respons (pengingat → eskalasi), mengirim 1x pengingat ke calon klien yang belum mengisi formulir, ringkasan harian ke tim. |
| 🛡 **Keamanan** | Menyaring spam/phishing/lampiran berbahaya, mencegah balasan otomatis berulang (loop), validasi formulir & berkas (cek isi berkas, bukan hanya ekstensi), honeypot & rate limit anti-bot, **pemeriksaan benturan kepentingan**, login admin aman, dan log audit. |

## Alur

```
 Klien kirim email ──► [Keamanan] saring spam/phishing
        │
        ▼
 [Administratif] nomor referensi INQ-2026-00001
        ├─► Email balasan profesional + tombol "Isi Formulir Registrasi" (tautan pribadi, data terisi otomatis)
        └─► [Operasional] notifikasi WhatsApp + Telegram ke tim
        
 Pengunjung situs ──► Chatbot (pilihan jawaban) ──► Formulir registrasi multi-langkah
        │
        ▼
 [Keamanan] validasi + cek berkas + cek konflik kepentingan
        │
        ▼
 [Administratif] nomor registrasi REG-2026-00001
        ├─► Klien: halaman sukses + email konfirmasi (ringkasan isian, langkah selanjutnya, tautan status) + WhatsApp
        └─► Tim: Email + WhatsApp + Telegram (urgensi, hasil cek konflik, ringkasan AI opsional, tautan panel)

 Tim meninjau di Panel Admin ──► ubah status ──► surat otomatis ke klien
   Sedang ditinjau · Perlu informasi tambahan · Konsultasi dijadwalkan · Diterima · Tidak dapat ditangani
 [Operasional] mengingatkan tim bila belum ditinjau melewati SLA, lalu eskalasi.
```

### Kenapa klien terkesan
- **Respons instan 24/7** dengan nomor referensi dan pemberitahuan bila pesan masuk di luar jam kerja.
- **Tautan formulir pribadi** — nama & email sudah terisi; draf tersimpan otomatis bila klien berhenti di tengah.
- **Janji waktu yang jujur** — batas respons dihitung otomatis dan digeser ke jam kerja berikutnya.
- **Email bermerek** (logo/warna kantor), ringkasan isian, dan langkah selanjutnya yang jelas.
- **Halaman status** pribadi + cek status via chatbot (nomor registrasi + email).
- **Surat penolakan yang etis**: sopan, bukan penilaian pokok perkara, dan mengingatkan tenggat waktu hukum.
- Disclaimer hubungan advokat–klien & persetujuan **UU No. 27/2022 (PDP)** sudah ada di formulir.

## Menjalankan

Butuh **Node.js 22.13+** (memakai SQLite bawaan Node, tanpa database terpisah).

```bash
npm install
cp .env.example .env          # isi seperlunya; kosong = mode simulasi
npm run set-password -- admin "kata-sandi-admin-yang-panjang"
npm start
```

- Chatbot klien: `http://localhost:3000/`
- Formulir langsung: `http://localhost:3000/daftar`
- Panel admin: `http://localhost:3000/admin/`

Tanpa kredensial apa pun, semua kanal berjalan **simulasi** (pesan dicetak di terminal) — buka **Panel Admin → Uji Coba → Simulasi email masuk** untuk mencoba seluruh alur.

```bash
npm test     # 17 skenario: alur email, registrasi, validasi, keamanan, konflik, status, template, akun & peran, WhatsApp, AI
```

## Menghubungkan kanal

Semua diisi di file `.env` (lihat `.env.example`). Setelah diisi, jalankan ulang server lalu uji tiap kanal dari **Panel Admin → Uji Coba → Tes kanal notifikasi**.

### 1. Gmail / Google Workspace (email masuk & keluar)
1. Gunakan kotak masuk khusus, misalnya `intake@kantoranda.id`.
2. Di akun Google tersebut: aktifkan **Verifikasi 2 Langkah**, lalu buat **App Password** di <https://myaccount.google.com/apppasswords>.
3. Pastikan **IMAP aktif**: Gmail → Setelan → *Penerusan dan POP/IMAP* → Aktifkan IMAP.
4. Isi `.env`:
   ```
   EMAIL_PROVIDER=gmail
   GMAIL_USER=intake@kantoranda.id
   GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx
   MAIL_FROM="Nama Kantor <intake@kantoranda.id>"
   OFFICE_DOMAIN=kantoranda.id
   ```
   Agen Operasional memeriksa inbox tiap 60 detik. Email yang sudah diproses ditandai *dibaca* (tetap ada di Gmail).
   Batas kirim Gmail ±500 email/hari (akun pribadi) atau ±2.000/hari (Workspace).

### 2. WhatsApp Cloud API (resmi Meta)
1. Di <https://developers.facebook.com>: buat App tipe **Business**, tambahkan produk **WhatsApp**, lalu daftarkan dan verifikasi nomor kantor.
2. Buat **System User** di Meta Business Manager dan beri izin `whatsapp_business_messaging`. Buat **token permanen** → `WA_META_TOKEN`.
3. Salin **Phone number ID** dari WhatsApp → API Setup → `WA_META_PHONE_NUMBER_ID`.
4. **Buat template pesan** (WhatsApp Manager → Message templates). Karena semua pesan kita dikirim lebih dulu oleh kantor, Meta mewajibkan template:
   - Nama: `notifikasi_kantor` · Kategori: **Utility** · Bahasa: **Indonesian (id)**
   - Isi (body):
     ```
     Pemberitahuan dari {{1}}:

     {{2}}

     Pesan ini dikirim otomatis oleh sistem kantor kami.
     ```
   - Contoh nilai: `{{1}}` = *Kantor Hukum Delvos & Rekan*, `{{2}}` = *Registrasi REG-2026-00001 telah kami terima. Tim kami akan menghubungi Anda dalam 24 jam kerja.*
5. **Webhook**: App → WhatsApp → Configuration. Isi Callback URL `https://domain-anda/webhooks/whatsapp`, Verify token = nilai `WA_META_VERIFY_TOKEN` (bebas Anda tentukan), lalu langganan field **messages**. Isi `WA_META_APP_SECRET` dari App Settings → Basic → App Secret.
6. Isi `.env`: `WA_PROVIDER=meta` beserta nilai-nilai di atas.

Cara kerjanya (`WA_META_MODE=auto`):
- Ke nomor yang **belum mengirim pesan ke nomor kantor dalam 24 jam terakhir**, pesan dikirim lewat template `notifikasi_kantor` (isi diringkas menjadi satu paragraf).
- Ke nomor yang **baru saja mengirim pesan**, dikirim sebagai teks biasa lengkap dengan format. Tip untuk staf: kirim "halo" ke nomor kantor setiap pagi agar notifikasi seharian tampil lengkap.
- Lewat webhook: pesan yang gagal terkirim ditandai *gagal* di Log Notifikasi (beserta kode Meta). Pesan WhatsApp dari klien diteruskan ke grup Telegram tim dan dicatat di riwayat registrasinya. Balasan ke klien tetap dilakukan manual oleh staf.

### 3. Telegram (grup tim)
Buat bot di @BotFather → `TELEGRAM_BOT_TOKEN`. Masukkan bot ke grup tim, kirim satu pesan di grup, lalu buka `https://api.telegram.org/bot<TOKEN>/getUpdates` untuk melihat `chat.id` grup (diawali `-100…`) → `TELEGRAM_CHAT_IDS`.

### 4. AI Claude
Isi `AI_ENABLED=true` dan `ANTHROPIC_API_KEY` (dari <https://console.anthropic.com>). Untuk setiap email masuk, AI menentukan kategori, urgensi, dan apakah email itu permintaan jasa hukum. Untuk setiap registrasi, AI membuat ringkasan, isu utama, dan daftar **"perlu ditanyakan ke klien"** yang bisa dipakai dengan satu klik sebagai surat *Perlu informasi tambahan*. Bila AI tidak tersedia, sistem tetap berjalan tanpa ringkasan. Data klien dikirim ke Anthropic API; teks persetujuan PDP di formulir sudah menyebutkan hal ini.

### 5. Akun staf
Akun admin pertama dibuat dari `ADMIN_USERNAME` (`npm run set-password -- admin "sandi-panjang"`). Akun lain dibuat di **Panel Admin → Pengguna**:
- **Admin**: semua fitur, termasuk pengguna, formulir, chatbot, template, profil kantor, log audit, dan uji coba.
- **Staf**: email masuk, registrasi (ubah status, catatan, penugasan), daftar pihak, dan log notifikasi.
- Akun baru dan reset sandi menghasilkan **kata sandi sementara** yang wajib diganti saat login pertama. Akun yang dinonaktifkan langsung keluar dari panel.
- Centang **Email/WA** pada akun agar staf tersebut menerima notifikasi tim.
- Registrasi bisa **ditugaskan** ke staf; staf menerima email dan WhatsApp berisi ringkasan perkara.

## Mengubah formulir, chatbot, dan pesan (tanpa coding)

Semua bisa diedit admin di panel; setiap simpan menjadi **versi baru** (bisa dikembalikan dari Riwayat versi).

- **Formulir Registrasi** — tambah/hapus/urutkan bagian & pertanyaan, tipe jawaban (teks, pilihan, centang, tanggal, unggah berkas, persetujuan, teks info), wajib/opsional, min/maks karakter, **tampil bersyarat** (mis. "Nama perusahaan" hanya muncul bila memilih Badan Usaha). Registrasi lama selalu ditampilkan dengan versi formulir saat diisi.
  - *Peran khusus* menghubungkan pertanyaan ke sistem: email klien (konfirmasi), nama, WhatsApp, bidang hukum, urgensi, uraian, **pihak lawan (cek konflik)**.
- **Alur Chatbot** — langkah percakapan, pesan bot, dan tombol pilihan (ke langkah lain / buka formulir / cek status / WhatsApp / tautan).
- **Template Pesan** — seluruh email, WhatsApp, dan Telegram, dengan variabel `{{…}}` dan pratinjau langsung.
- **Profil Kantor** — nama, logo, warna, jam kerja, target respons (SLA), pengingat, jam ringkasan harian.
- **Daftar Pihak** — klien/mantan klien/pihak lawan untuk pemeriksaan konflik (bisa impor massal).

## Keamanan

- Sanitasi & validasi seluruh isian di server berdasarkan skema formulir aktif (field tak dikenal dibuang).
- Berkas: hanya PDF/JPG/PNG/DOCX, diverifikasi *magic bytes*, PDF berisi JavaScript/aksi tertanam ditolak, disimpan dengan nama acak di luar folder publik, hanya bisa diunduh admin (tercatat di audit).
- Anti-bot: honeypot, waktu pengisian minimum, rate limit per IP.
- Email masuk: SPF/DKIM/DMARC, pola phishing, tautan IP/penyingkat, lampiran berbahaya, deteksi email otomatis/massal & batas balasan per pengirim (mencegah loop).
- Template aman: nilai dari klien di-escape dan tidak dapat menyisipkan tombol/tautan; subjek dibersihkan dari injeksi header.
- Admin: akun per staf dengan peran admin/staf, kata sandi scrypt, kata sandi sementara wajib diganti, sesi bertanda tangan HMAC (HttpOnly, SameSite=Strict) yang langsung dicabut saat akun dinonaktifkan atau sandi diganti, proteksi CSRF, penguncian setelah gagal login berulang, header keamanan (CSP, X-Frame-Options, dll.), ekspor CSV aman dari *formula injection*.
- Webhook WhatsApp diverifikasi dengan tanda tangan `X-Hub-Signature-256` (App Secret).
- Seluruh aksi agen & admin tercatat di **Log Audit**.

## Staging

Panduan lengkap: [`deploy/DEPLOY-STAGING.md`](deploy/DEPLOY-STAGING.md). Docker + Caddy (HTTPS otomatis), situs dilindungi sandi, dan **pengaman pengiriman**: di `APP_ENV=staging` pesan hanya terkirim ke staf, grup Telegram, dan `STAGING_ALLOWED_RECIPIENTS`. Pesan lainnya tercatat sebagai *blocked*. Ada juga skrip `deploy/smoke-test.sh`, cadangan (`scripts/backup.js`), dan daftar uji UAT.

## Produksi

1. Jalankan di VPS/server kantor di belakang Nginx/Caddy dengan **HTTPS**; set `NODE_ENV=production`, `PUBLIC_URL=https://…`, `TRUST_PROXY=true`.
2. Jalankan sebagai layanan (systemd/pm2) agar Agen Operasional terus aktif.
3. Cadangkan folder `data/` (database + berkas klien) secara rutin dan terenkripsi.

## Struktur

```
src/
  agents/administrative.js   Agen Administratif
  agents/operational.js      Agen Operasional (penjadwal, IMAP, SLA, pengingat, ringkasan)
  agents/security.js         Agen Keamanan (screening, validasi, upload, konflik, auth)
  ai/claude.js               Triase & ringkasan AI (opsional)
  channels/                  Email (SMTP), WhatsApp (Fonnte/Meta), Telegram
  outbox.js                  Antrian pesan keluar + retry
  settings.js                Pengaturan yang bisa diedit admin (berversi + validasi)
  routes/                    API publik & admin
config/defaults/             Formulir, chatbot, template, profil kantor bawaan
public/                      Chatbot + formulir klien, panel admin
.claude/agents/              Definisi 3 agen untuk dioperasikan lewat Claude Code
test/                        Test otomatis
```

## Menggunakan dengan Claude Code

Folder `.claude/agents/` berisi tiga subagen (`agen-administratif`, `agen-operasional`, `agen-keamanan`) yang membantu staf lewat Claude Code, misalnya: *"agen-administratif, rangkum registrasi yang belum ditinjau"* atau *"agen-keamanan, audit log login 24 jam terakhir"*. Lihat `CLAUDE.md` untuk panduan pengembangan.
