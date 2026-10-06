# CLAUDE.md

Kantor virtual hukum: penerimaan calon klien lewat email → chatbot → formulir registrasi, dengan tiga agen (Administratif, Operasional, Keamanan). Teks yang dilihat pengguna berbahasa Indonesia; kode & komentar berbahasa Inggris.

## Perintah
- `npm start` — jalankan server (port dari `PORT`, default 3000)
- `npm test` — test node:test di `test/` (database sementara, semua kanal simulasi)
- `node scripts/kantor.js <perintah>` — CLI baca-saja untuk inspeksi data
- `npm run set-password -- <username> "<sandi>"` — set kata sandi akun (membuat admin bila belum ada)

## Arsitektur
- Node.js ≥ 22.13, CommonJS, Express 5, SQLite bawaan (`node:sqlite`), tanpa build step.
- `src/agents/*` berisi logika tiap agen; `src/outbox.js` adalah satu-satunya jalur pesan keluar (simpan dulu, kirim, retry).
- Konfigurasi yang bisa diedit admin (`office`, `form`, `chatbot`, `templates`) disimpan berversi lewat `src/settings.js`; bawaannya di `config/defaults/*.json`. Setiap skema divalidasi sebelum disimpan.
- Submissions menyimpan `form_version`; tampilkan dengan `settings.getVersion('form', v)`.
- Akun staf di tabel `users` (`src/users.js`); peran `admin`/`staf` ditegakkan di `src/routes/admin.js` lewat `auth.requireRole('admin')`. Sesi dicabut dengan menaikkan `session_version`.
- WhatsApp Cloud API: pesan di luar jendela 24 jam wajib template (`src/channels/whatsapp.js`); webhook di `src/routes/webhooks.js`.
- Field formulir dengan `role` (client_name, client_email, client_phone, matter_type, urgency, opposing_party, description) dipakai oleh agen — jangan mengandalkan ID field tertentu.

## Aturan penting
- Semua pesan dirender lewat `src/util/template.js`; jangan membangun HTML dari input klien secara manual. Markup `[button:…]` diparse dari template sebelum substitusi nilai.
- Frontend (`public/`) memakai `textContent`/helper `el()` — jangan memakai `innerHTML` untuk data dinamis. CSP melarang skrip inline.
- Rahasia hanya di `.env`; jangan di database atau di repositori.
- Jangan pernah membalas otomatis email yang ditandai otomatis/massal/spam (cegah loop).
