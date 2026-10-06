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
npm run set-password -- "kata-sandi-admin-yang-panjang"
npm start
```

- Chatbot klien: `http://localhost:3000/`
- Formulir langsung: `http://localhost:3000/daftar`
- Panel admin: `http://localhost:3000/admin/`

Tanpa kredensial apa pun, semua kanal berjalan **simulasi** (pesan dicetak di terminal) — buka **Panel Admin → Uji Coba → Simulasi email masuk** untuk mencoba seluruh alur.

```bash
npm test     # 10 skenario: alur email, registrasi, validasi, keamanan, konflik, status, template, admin
```

## Menghubungkan kanal

| Kanal | Isi di `.env` | Catatan |
|---|---|---|
| Email keluar | `SMTP_*`, `MAIL_FROM` | Gmail/Workspace: pakai **App Password**. |
| Email masuk | `IMAP_*` | Gunakan kotak masuk khusus (mis. `intake@…`). Email yang diproses ditandai dibaca. |
| WhatsApp | `WA_PROVIDER=fonnte` + `FONNTE_TOKEN` | Paling cepat untuk Indonesia (nomor WA biasa ditautkan). |
| | `WA_PROVIDER=meta` + `WA_META_*` | WhatsApp Cloud API resmi. Pesan ke nomor yang belum chat 24 jam terakhir memerlukan *template* yang disetujui Meta. |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_IDS` | Buat bot di @BotFather, masukkan ke grup tim, ambil chat id grup. |
| Tim | `TEAM_EMAILS`, `TEAM_WHATSAPP` | Dipisah koma. |
| AI (opsional) | `AI_ENABLED=true`, `ANTHROPIC_API_KEY` | Claude men-triase email & membuat ringkasan + daftar "perlu ditanyakan" untuk tim. Bila mati/gagal, sistem tetap jalan dengan aturan dasar. |

Uji tiap kanal dari **Panel Admin → Uji Coba → Tes kanal notifikasi**.

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
- Admin: kata sandi scrypt, sesi bertanda tangan HMAC (HttpOnly, SameSite=Strict), proteksi CSRF, penguncian setelah gagal login berulang, header keamanan (CSP, X-Frame-Options, dll.), ekspor CSV aman dari *formula injection*.
- Seluruh aksi agen & admin tercatat di **Log Audit**.

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
