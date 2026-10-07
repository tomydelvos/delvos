'use strict';
// Staging mode: only staff, Telegram, and allow-listed recipients get real messages.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kantor-staging-'));
Object.assign(process.env, {
  DATA_DIR: tmp, APP_ENV: 'staging', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'kata-sandi-admin-123',
  STAGING_ALLOWED_RECIPIENTS: '@kantoranda.id, 0811 2222 3333', WA_PROVIDER: 'log', TELEGRAM_CHAT_IDS: '-1001',
});
for (const k of ['SMTP_HOST', 'IMAP_HOST', 'TELEGRAM_BOT_TOKEN', 'AI_ENABLED', 'EMAIL_PROVIDER']) delete process.env[k];
console.log = () => {};

const { createApp } = require('../src/server');
const { db } = require('../src/db');
const outbox = require('../src/outbox');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('staging memblokir penerima di luar daftar izin dan menandai pesan', async () => {
  createApp();
  db.prepare(`INSERT INTO users(username, name, email, whatsapp, role, password_hash) VALUES ('rina', 'Rina', 'rina@gmail.com', '0812-9999-0000', 'staf', 'x')`).run();
  const cases = [
    ['email', 'klien@gmail.com', 'blocked'],
    ['email', 'Tester@KantorAnda.id', 'simulated'],
    ['email', 'rina@gmail.com', 'simulated'], // staff account
    ['whatsapp', '+62 811-2222-3333', 'simulated'],
    ['whatsapp', '081299990000', 'simulated'], // staff WhatsApp
    ['whatsapp', '081377778888', 'blocked'],
    ['telegram', '-1001', 'simulated'],
  ];
  const ids = cases.map(([channel, to]) => outbox.enqueue({ channel, to, subject: channel === 'email' ? 'Halo' : null, text: 'Isi', html: channel === 'email' ? '<html><body><p>Isi</p></body></html>' : null }));
  await wait(150);
  cases.forEach(([channel, to, expected], i) => {
    const row = db.prepare('SELECT status, subject, body, html FROM notifications WHERE id = ?').get(ids[i]);
    assert.equal(row.status, expected, `${channel} ${to}`);
    if (channel === 'email') { assert.match(row.subject, /^\[STAGING\]/); assert.match(row.html, /STAGING/); }
  });
});

test('healthz melaporkan lingkungan staging', async () => {
  const server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const res = await fetch(`http://127.0.0.1:${server.address().port}/healthz`);
  const body = await res.json();
  assert.equal(body.env, 'staging');
  assert.equal(body.revision, process.env.GIT_SHA || null); // set from the image build arg in deployments
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
  server.close();
});
