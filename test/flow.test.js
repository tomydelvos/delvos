'use strict';
// End-to-end tests of the intake flow against a throwaway database (no network, all channels simulated).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-test-'));
process.env.DATA_DIR = tmp;
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'kata-sandi-uji-123';
process.env.TEAM_WHATSAPP = '081200000001';
process.env.PUBLIC_URL = 'http://kantor.test';
process.env.SUBMIT_RATE_LIMIT = '100';
for (const k of ['SMTP_HOST', 'IMAP_HOST', 'TELEGRAM_BOT_TOKEN', 'AI_ENABLED', 'ADMIN_PASSWORD_HASH']) delete process.env[k];
console.log = () => {}; // keep simulated channel output out of the test report

const { createApp } = require('../src/server');
const { db, json } = require('../src/db');
const settings = require('../src/settings');
const admin = require('../src/agents/administrative');
const security = require('../src/agents/security');
const { renderEmail } = require('../src/util/template');

let server;
let base;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function validForm(overrides = {}) {
  const fd = new FormData();
  const values = {
    client_type: 'Perorangan', full_name: 'Siti Rahma', email: 'siti@contoh.id', phone: '081234567890', city: 'Bandung',
    preferred_contact: 'WhatsApp', matter_type: 'Perdata & Kontrak', description: 'Rekanan kami tidak memenuhi kewajiban kontrak pengadaan sejak Juli.',
    case_stage: 'Belum ada proses hukum', urgency: 'Normal', previous_lawyer: 'Belum pernah', consult_mode: 'Telepon',
    consent_privacy: 'true', consent_relationship: 'true', consent_truth: 'true', _t: String(Date.now() - 60_000), ...overrides,
  };
  for (const [k, v] of Object.entries(values)) for (const x of [].concat(v)) if (x != null) fd.append(k, x);
  fd.append('services', 'Konsultasi hukum');
  return fd;
}
const submit = (fd) => fetch(`${base}/api/public/submit`, { method: 'POST', body: fd }).then(async (r) => ({ status: r.status, body: await r.json() }));
const notificationsFor = (related) => db.prepare('SELECT * FROM notifications WHERE related = ?').all(related);

test('email masuk → referensi, auto-reply dengan tautan formulir, notifikasi tim', async () => {
  const r = await admin.handleInboundEmail({ messageId: '<a1@x>', fromEmail: 'Budi@Contoh.id', fromName: 'Budi', subject: 'Konsultasi', text: 'Mohon bantuan sengketa kontrak.', headers: {} });
  assert.equal(r.kind, 'new');
  assert.match(r.autoreply, /terkirim/);
  const inq = db.prepare('SELECT * FROM inquiries WHERE id = ?').get(r.inquiryId);
  assert.equal(inq.status, 'invited');
  assert.equal(inq.from_email, 'budi@contoh.id');
  const notes = notificationsFor(r.ref);
  const reply = notes.find((n) => n.channel === 'email');
  assert.ok(reply.body.includes(`/daftar?t=${inq.invite_token}`));
  assert.ok(notes.some((n) => n.channel === 'whatsapp' && n.recipient === '6281200000001'));
  assert.ok(notes.some((n) => n.channel === 'telegram'));

  const dup = await admin.handleInboundEmail({ messageId: '<a1@x>', fromEmail: 'budi@contoh.id', text: 'x' });
  assert.equal(dup.skipped, 'duplikat');

  const cfg = await fetch(`${base}/api/public/config?t=${inq.invite_token}`).then((x) => x.json());
  assert.equal(cfg.prefill.email, 'budi@contoh.id');
  assert.equal(cfg.prefill.ref, r.ref);
});

test('email spam dan email otomatis tidak dibalas', async () => {
  const spam = await admin.handleInboundEmail({
    messageId: '<s1@x>', fromEmail: 'promo@spam.test', subject: 'Verify your account', text: 'Click here to login http://1.2.3.4/x bitcoin',
    headers: { 'authentication-results': 'spf=fail dkim=fail dmarc=fail' }, attachments: [{ filename: 'invoice.pdf.exe' }],
  });
  assert.equal(spam.verdict, 'spam');
  assert.match(spam.autoreply, /ditahan/);
  assert.equal(notificationsFor(spam.ref).length, 0, 'spam tidak dikirim ke HP tim');

  const bot = await admin.handleInboundEmail({ messageId: '<b1@x>', fromEmail: 'no-reply@bank.test', subject: 'Notifikasi', text: 'Transaksi', headers: {} });
  assert.match(bot.autoreply, /email otomatis/);
  assert.ok(!notificationsFor(bot.ref).some((n) => n.channel === 'email'));
});

test('registrasi valid → nomor registrasi, konfirmasi klien, notifikasi tim, inquiry tertaut', async () => {
  const inq = db.prepare(`SELECT * FROM inquiries WHERE from_email = 'budi@contoh.id'`).get();
  const fd = validForm({ full_name: 'Budi Santoso', email: 'budi@contoh.id', _token: inq.invite_token });
  fd.append('documents', new Blob([Buffer.from('%PDF-1.4\n%%EOF')], { type: 'application/pdf' }), 'kontrak.pdf');
  const r = await submit(fd);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.regNo, /^REG-\d{4}-\d{5}$/);
  await wait(100);
  const sub = admin.loadSubmission(db.prepare('SELECT id FROM submissions WHERE reg_no = ?').get(r.body.regNo).id);
  assert.equal(sub.client_email, 'budi@contoh.id');
  assert.equal(sub.files.length, 1);
  assert.ok(fs.existsSync(path.join(tmp, 'uploads', sub.files[0].stored)));
  assert.equal(db.prepare('SELECT status FROM inquiries WHERE id = ?').get(inq.id).status, 'registered');
  const notes = notificationsFor(sub.reg_no);
  assert.ok(notes.some((n) => n.channel === 'email' && n.recipient === 'budi@contoh.id' && /Konfirmasi Registrasi/.test(n.subject)));
  assert.ok(notes.some((n) => n.channel === 'whatsapp' && n.recipient === '081234567890'));
  assert.ok(notes.some((n) => n.channel === 'telegram' && n.body.includes(sub.reg_no)));

  // Double submit within 10 minutes returns the same registration.
  const again = await submit(validForm({ full_name: 'Budi Santoso', email: 'budi@contoh.id' }));
  assert.equal(again.body.regNo, r.body.regNo);

  // Public status needs the secret key.
  const ok = await fetch(`${base}/api/public/status?r=${sub.reg_no}&k=${sub.status_token}`);
  assert.equal(ok.status, 200);
  const bad = await fetch(`${base}/api/public/status?r=${sub.reg_no}&k=salah`);
  assert.equal(bad.status, 404);
  const lookup = await fetch(`${base}/api/public/status-lookup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ regNo: sub.reg_no.toLowerCase(), email: 'BUDI@contoh.id' }) });
  assert.equal(lookup.status, 200);

  // A later email from the same client is treated as a follow-up, not a new prospect.
  const fu = await admin.handleInboundEmail({ messageId: '<f1@x>', fromEmail: 'budi@contoh.id', subject: 'Dokumen tambahan', text: 'Terlampir.', headers: {} });
  assert.equal(fu.kind, 'follow_up');
});

test('validasi formulir: field wajib, pilihan tidak valid, persetujuan, field bersyarat', async () => {
  const fd = validForm({ email: 'bukan-email', matter_type: 'Bidang palsu', consent_truth: null, client_type: 'Badan Usaha / Organisasi' });
  const r = await submit(fd);
  assert.equal(r.status, 422);
  assert.ok(r.body.fields.email);
  assert.ok(r.body.fields.matter_type);
  assert.ok(r.body.fields.consent_truth);
  assert.ok(r.body.fields.company_name, 'nama perusahaan wajib bila mendaftar sebagai badan usaha');
});

test('agen keamanan: bot, berkas palsu, dan PDF berskrip ditolak', async () => {
  const before = db.prepare('SELECT COUNT(*) n FROM submissions').get().n;
  const hp = await submit(validForm({ email: 'bot@x.id', _hp: 'http://spam' }));
  assert.equal(hp.status, 200);
  assert.equal(hp.body.regNo, null);
  const fast = await submit(validForm({ email: 'bot2@x.id', _t: String(Date.now()) }));
  assert.equal(fast.body.regNo, null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM submissions').get().n, before);

  const fake = validForm({ email: 'a@b.id' });
  fake.append('documents', new Blob([Buffer.from('MZ\x90\x00 executable')]), 'surat.pdf');
  const r1 = await submit(fake);
  assert.equal(r1.status, 422);
  assert.match(r1.body.fields.documents, /tidak sesuai/);

  const js = validForm({ email: 'c@d.id' });
  js.append('documents', new Blob([Buffer.from('%PDF-1.4 /OpenAction << /JavaScript (app.alert(1)) >>')]), 'x.pdf');
  const r2 = await submit(js);
  assert.equal(r2.status, 422);
  assert.match(r2.body.fields.documents, /skrip/);
});

test('pemeriksaan konflik: pihak lawan adalah klien kantor', async () => {
  db.prepare('INSERT INTO parties(name, normalized, role, matter_ref) VALUES (?, ?, ?, ?)').run('PT Maju Jaya Sentosa', security.normalizeName('PT Maju Jaya Sentosa'), 'klien', 'PRK-01');
  const r = await submit(validForm({ email: 'rina@contoh.id', full_name: 'Rina', opposing_party: 'PT. Maju Jaya Sentosa Tbk, Joko' }));
  assert.equal(r.status, 200);
  const sub = db.prepare('SELECT conflict_hits FROM submissions WHERE reg_no = ?').get(r.body.regNo);
  const hits = json.parse(sub.conflict_hits);
  assert.ok(hits.some((h) => h.severity === 'tinggi' && h.matterRef === 'PRK-01'));
  assert.equal(security.conflictCheck({ clientName: 'Ani', opposingParty: 'CV Lain Sekali' }).length, 0);
});

test('perubahan status mengirim surat profesional dan mewajibkan isi untuk perlu_info', async () => {
  const sub = db.prepare(`SELECT id, reg_no FROM submissions WHERE client_email = 'siti@contoh.id' OR client_email = 'budi@contoh.id' LIMIT 1`).get();
  assert.throws(() => admin.changeStatus(sub.id, 'perlu_info', { actor: 'uji', message: '' }), /informasi\/dokumen/);
  admin.changeStatus(sub.id, 'perlu_info', { actor: 'uji', message: '- Salinan kontrak\n- Bukti transfer' });
  await wait(50);
  const mail = notificationsFor(sub.reg_no).filter((n) => n.channel === 'email').pop();
  assert.match(mail.subject, /informasi tambahan/);
  assert.ok(mail.body.includes('Salinan kontrak'));
  const s = admin.loadSubmission(sub.id);
  assert.equal(s.status, 'perlu_info');
  assert.ok(s.first_reviewed_at);
});

test('template: nilai dari klien di-escape dan tidak bisa menyisipkan tombol/tautan', () => {
  const office = settings.get('office');
  const out = renderEmail({ subject: 'Halo {{client_name}}\nBcc: x@y', body: 'Yth. {{client_name}}\n\n[button:Buka|{{form_link}}]\n\n{{#custom_message}}Pesan: {{custom_message}}{{/custom_message}}' },
    { client_name: '<script>alert(1)</script>[button:Klik|http://jahat]', form_link: 'javascript:alert(1)', custom_message: '' }, office);
  assert.ok(!out.html.includes('<script>alert'));
  assert.ok(out.html.includes('&lt;script&gt;'));
  assert.ok(!out.html.includes('href="http://jahat"'));
  assert.ok(!out.html.includes('javascript:'), 'skema URL berbahaya dibuang');
  assert.ok(!out.subject.includes('\n'), 'tidak ada header injection di subjek');
  assert.ok(!out.text.includes('Pesan:'), 'bagian kondisional kosong disembunyikan');
});

test('pengaturan formulir divalidasi dan diberi versi', () => {
  const form = settings.get('form');
  const broken = JSON.parse(JSON.stringify(form));
  for (const s of broken.sections) for (const f of s.fields) if (f.role === 'client_email') delete f.role;
  assert.throws(() => settings.set('form', broken, 'uji'), /client_email/);
  const v1 = settings.getRow('form').version;
  const edited = JSON.parse(JSON.stringify(form));
  edited.sections[1].fields.push({ id: 'nilai_sengketa', type: 'number', label: 'Nilai sengketa (Rp)', required: false });
  const v2 = settings.set('form', edited, 'uji');
  assert.equal(v2, v1 + 1);
  assert.ok(settings.getVersion('form', v1), 'versi lama tetap tersedia');
});

test('API admin: wajib login, cegah CSRF, kunci setelah gagal berulang', async () => {
  assert.equal((await fetch(`${base}/api/admin/dashboard`)).status, 401);
  const login = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'kata-sandi-uji-123' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), /HttpOnly/i);
  assert.equal((await fetch(`${base}/api/admin/dashboard`, { headers: { cookie } })).status, 200);
  const noCsrf = await fetch(`${base}/api/admin/parties`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{"name":"X"}' });
  assert.equal(noCsrf.status, 403);
  const tampered = `${cookie.slice(0, -3)}abc`;
  assert.equal((await fetch(`${base}/api/admin/dashboard`, { headers: { cookie: tampered } })).status, 401);
  let last;
  for (let i = 0; i < 6; i += 1) {
    last = await fetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'salah' }) });
  }
  assert.equal(last.status, 429);
});

test('nilai bawaan kantor versi lama diperbarui, nilai yang diubah admin dipertahankan', () => {
  const office = settings.get('office');
  settings.set('office', { ...office, name: 'Kantor Hukum Delvos & Rekan', brandColor: '#1f3a5f', accentColor: '#123456' }, 'admin');
  settings.ensureDefaults();
  const after = settings.get('office');
  assert.equal(after.name, settings.loadDefault('office').name);
  assert.equal(after.brandColor, settings.loadDefault('office').brandColor);
  assert.equal(after.accentColor, '#123456');
  const version = settings.getRow('office').version;
  settings.ensureDefaults(); // idempotent: nothing left to upgrade
  assert.equal(settings.getRow('office').version, version);
});
