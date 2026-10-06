'use strict';
// Staff accounts & roles, assignment, WhatsApp Cloud API (template/window/webhook), and the Claude
// integration against a local fake Anthropic API.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-team-'));
Object.assign(process.env, {
  DATA_DIR: tmp, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'kata-sandi-admin-123', PUBLIC_URL: 'http://kantor.test',
  SUBMIT_RATE_LIMIT: '100', TEAM_WHATSAPP: '', TEAM_EMAILS: '',
  WA_PROVIDER: 'meta', WA_META_TOKEN: 'tok', WA_META_PHONE_NUMBER_ID: '123', WA_META_MODE: 'auto',
  WA_META_APP_SECRET: 'rahasia-app', WA_META_VERIFY_TOKEN: 'verif-123', TELEGRAM_CHAT_IDS: '-1001',
  AI_ENABLED: 'true', ANTHROPIC_API_KEY: 'sk-test',
});
for (const k of ['SMTP_HOST', 'IMAP_HOST', 'TELEGRAM_BOT_TOKEN', 'ADMIN_PASSWORD_HASH', 'EMAIL_PROVIDER']) delete process.env[k];
console.log = () => {};

// Fake Anthropic API: records requests and answers with JSON matching the requested schema.
const aiRequests = [];
const fakeAi = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const parsed = JSON.parse(body);
    aiRequests.push({ url: req.url, headers: req.headers, body: parsed });
    const props = parsed.output_config?.format?.schema?.properties || {};
    const answer = props.is_legal_inquiry
      ? { is_legal_inquiry: true, category: 'Ketenagakerjaan', urgency: 'Segera', summary: 'PHK sepihak.' }
      : { summary: 'Karyawan di-PHK tanpa pesangon.', key_issues: ['PHK sepihak'], missing_info: ['Salinan kontrak kerja'], suggested_practice_area: 'Ketenagakerjaan', risk_notes: '' };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      id: 'msg_1', type: 'message', role: 'assistant', model: parsed.model, stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: JSON.stringify(answer) }], usage: { input_tokens: 10, output_tokens: 10 },
    }));
  });
});

// Intercept calls to the WhatsApp Graph API (the only external fetch in these tests).
const graphCalls = [];
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  if (String(url).startsWith('https://graph.facebook.com/')) {
    graphCalls.push({ url: String(url), body: JSON.parse(opts.body) });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.${graphCalls.length}` }] }), { status: 200 });
  }
  return realFetch(url, opts);
};

let server;
let base;
let createApp;
let db;
let wa;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  await new Promise((r) => fakeAi.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${fakeAi.address().port}`;
  ({ createApp } = require('../src/server'));
  ({ db } = require('../src/db'));
  wa = require('../src/channels/whatsapp');
  await new Promise((r) => { server = createApp().listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fakeAi.close(); global.fetch = realFetch; fs.rmSync(tmp, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  const call = async (method, p, body) => {
    const res = await realFetch(`${base}/api/admin${p}`, {
      method, headers: { cookie, 'X-Requested-With': 'fetch', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return { call, login: (username, password) => call('POST', '/login', { username, password }) };
}

const admin = client();
const staf = client();
let stafId;

test('admin membuat akun staf; staf wajib ganti kata sandi sementara', async () => {
  assert.equal((await admin.login('admin', 'kata-sandi-admin-123')).status, 200);
  const created = await admin.call('POST', '/users', { username: 'rina', name: 'Rina Advokat', email: 'rina@kantor.id', whatsapp: '0812 3333 4444', role: 'staf', notify_whatsapp: true });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  stafId = created.body.user.id;
  assert.ok(created.body.tempPassword.length >= 12);
  assert.equal((await admin.call('POST', '/users', { username: 'rina', name: 'Lagi' })).status, 400);

  const login = await staf.login('rina', created.body.tempPassword);
  assert.equal(login.body.user.mustChangePassword, true);
  assert.equal((await staf.call('GET', '/dashboard')).status, 403);
  assert.equal((await staf.call('POST', '/password', { current: created.body.tempPassword, next: 'pendek' })).status, 400);
  assert.equal((await staf.call('POST', '/password', { current: created.body.tempPassword, next: 'sandi-baru-rina-2026' })).status, 200);
  assert.equal((await staf.call('GET', '/dashboard')).status, 200, 'cookie diperbarui setelah ganti sandi');
});

test('peran staf dibatasi; admin terakhir tidak dapat diturunkan', async () => {
  assert.equal((await staf.call('PUT', '/settings/form', { value: {} })).status, 403);
  assert.equal((await staf.call('GET', '/users')).status, 403);
  assert.equal((await staf.call('GET', '/audit')).status, 403);
  assert.equal((await staf.call('POST', '/simulate-email', { fromEmail: 'a@b.id' })).status, 403);
  assert.equal((await staf.call('GET', '/submissions')).status, 200);
  assert.equal((await staf.call('GET', '/users/brief')).status, 200);
  const me = (await admin.call('GET', '/me')).body;
  assert.equal((await admin.call('PUT', `/users/${me.id}`, { role: 'staf' })).status, 400);
});

test('tim menerima notifikasi via akun; WA ke nomor baru memakai template, dalam jendela 24 jam memakai teks', async () => {
  const users = require('../src/users');
  assert.deepEqual(users.teamRecipients().whatsapp, ['6281233334444']);
  assert.ok(users.teamRecipients().emails.includes('rina@kantor.id'));

  const p1 = wa.metaPayload('6281233334444', 'Baris satu\nBaris dua\t\tdan      spasi');
  assert.equal(p1.type, 'template');
  assert.equal(p1.template.name, 'notifikasi_kantor');
  const param = p1.template.components[0].parameters[1].text;
  assert.ok(!/[\n\t]/.test(param) && !/ {4,}/.test(param), 'parameter template tanpa baris baru/tab/spasi berlebih');
  wa.markInbound('+62 812-3333-4444');
  assert.equal(wa.metaPayload('6281233334444', 'Halo').type, 'text');
});

test('webhook WhatsApp: verifikasi, tanda tangan, status gagal, dan pesan masuk dari klien', async () => {
  const verify = await realFetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verif-123&hub.challenge=42`);
  assert.equal(await verify.text(), '42');
  assert.equal((await realFetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=salah&hub.challenge=1`)).status, 403);

  const outbox = require('../src/outbox');
  const id = outbox.enqueue({ channel: 'whatsapp', to: '081299998888', text: 'tes' });
  await wait(100);
  const row = db.prepare('SELECT provider_id, status FROM notifications WHERE id = ?').get(id);
  assert.equal(row.status, 'sent');
  assert.match(row.provider_id, /^wamid\./);

  const post = (obj, secret = 'rahasia-app') => {
    const raw = JSON.stringify(obj);
    const sig = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
    return realFetch(`${base}/webhooks/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body: raw });
  };
  const statusEvt = { entry: [{ changes: [{ value: { statuses: [{ id: row.provider_id, status: 'failed', errors: [{ code: 131047, title: 'Re-engagement message' }] }] } }] }] };
  assert.equal((await post(statusEvt, 'salah')).status, 401);
  assert.equal((await post(statusEvt)).status, 200);
  await wait(50);
  const failed = db.prepare('SELECT status, last_error FROM notifications WHERE id = ?').get(id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.last_error, /131047/);

  const msgEvt = { entry: [{ changes: [{ value: { contacts: [{ wa_id: '6281277776666', profile: { name: 'Budi' } }], messages: [{ from: '6281277776666', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Apakah jadwal saya sudah ada?' } }] } }] }] };
  assert.equal((await post(msgEvt)).status, 200);
  await wait(50);
  assert.ok(wa.windowOpen('6281277776666'));
  const tg = db.prepare(`SELECT body FROM notifications WHERE channel = 'telegram' AND body LIKE '%Apakah jadwal saya%'`).get();
  assert.ok(tg, 'pesan klien diteruskan ke Telegram tim');
});

test('AI Claude: triase email & ringkasan registrasi memakai structured output + fallback', async () => {
  const adminAgent = require('../src/agents/administrative');
  const r = await adminAgent.handleInboundEmail({ messageId: '<ai1@x>', fromEmail: 'joko@contoh.id', fromName: 'Joko', subject: 'PHK', text: 'Saya di-PHK tanpa pesangon.', headers: {} });
  const inq = db.prepare('SELECT ai FROM inquiries WHERE id = ?').get(r.inquiryId);
  assert.equal(JSON.parse(inq.ai).category, 'Ketenagakerjaan');
  const req = aiRequests[0];
  assert.match(req.url, /^\/v1\/messages/);
  assert.equal(req.body.model, 'claude-opus-5-5');
  assert.equal(req.body.fallbacks, 'default');
  assert.match(req.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(req.body.output_config.format.type, 'json_schema');
  assert.ok(req.body.messages[0].content.includes('Saya di-PHK'));
});

test('penugasan registrasi ke staf mengirim notifikasi ke staf tersebut', async () => {
  const fd = new FormData();
  const v = {
    client_type: 'Perorangan', full_name: 'Joko', email: 'joko@contoh.id', phone: '081211110000', city: 'Solo', preferred_contact: 'Email',
    matter_type: 'Ketenagakerjaan', services: 'Konsultasi hukum', description: 'Saya diberhentikan tanpa pesangon setelah bekerja delapan tahun.',
    case_stage: 'Belum ada proses hukum', urgency: 'Normal', previous_lawyer: 'Belum pernah', consult_mode: 'Telepon',
    consent_privacy: 'true', consent_relationship: 'true', consent_truth: 'true', _t: String(Date.now() - 60_000),
  };
  for (const [k, x] of Object.entries(v)) fd.append(k, x);
  const sub = await (await realFetch(`${base}/api/public/submit`, { method: 'POST', body: fd })).json();
  assert.ok(sub.regNo);
  await wait(200);
  const row = db.prepare('SELECT id, ai FROM submissions WHERE reg_no = ?').get(sub.regNo);
  assert.deepEqual(JSON.parse(row.ai).missing_info, ['Salinan kontrak kerja']);

  const res = await admin.call('POST', `/submissions/${row.id}/assign`, { username: 'rina', note: 'Mohon hubungi hari ini' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await wait(50);
  const notes = db.prepare('SELECT channel, recipient, subject, body FROM notifications WHERE related = ?').all(sub.regNo);
  assert.ok(notes.some((n) => n.channel === 'email' && n.recipient === 'rina@kantor.id' && /Penugasan/.test(n.subject)));
  assert.ok(notes.some((n) => n.channel === 'whatsapp' && n.recipient === '0812 3333 4444' && n.body.includes('Mohon hubungi')));
  assert.equal((await admin.call('POST', `/submissions/${row.id}/status`, { status: 'baru' })).status, 400, 'status sama ditolak');
});

test('menonaktifkan staf langsung mengakhiri sesinya', async () => {
  assert.equal((await admin.call('PUT', `/users/${stafId}`, { active: false })).status, 200);
  assert.equal((await staf.call('GET', '/submissions')).status, 401);
  assert.equal((await staf.login('rina', 'sandi-baru-rina-2026')).status, 401);
});
