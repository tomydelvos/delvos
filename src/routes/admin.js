'use strict';
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const config = require('../config');
const settings = require('../settings');
const { db, json, audit } = require('../db');
const auth = require('../util/auth');
const { renderEmail, renderText, renderHtml } = require('../util/template');
const outbox = require('../outbox');
const security = require('../agents/security');
const admin = require('../agents/administrative');
const ops = require('../agents/operational');
const ai = require('../ai/claude');
const users = require('../users');

const router = express.Router();
const actor = (req) => `admin:${req.admin}`;
const httpError = (status, message) => Object.assign(new Error(message), { status });

router.post('/login', express.json({ limit: '10kb' }), auth.login);
router.post('/logout', auth.logout);
router.use(auth.requireUser);
router.use(express.json({ limit: '2mb' }));
const adminOnly = auth.requireRole('admin');

router.get('/me', (req, res) => res.json(auth.publicUser(req.user)));

router.post('/password', (req, res) => {
  const updated = auth.changePassword(req, res, req.body.current, req.body.next);
  audit(actor(req), 'ganti_password', null, req.ip);
  res.json({ ok: true, user: auth.publicUser(updated) });
});

// ---------------------------------------------------------------------------
// Users (admin only, except the brief list used for assignment)
// ---------------------------------------------------------------------------
router.get('/users/brief', (req, res) => {
  res.json(db.prepare(`SELECT id, username, name, role FROM users WHERE active = 1 ORDER BY name`).all());
});
router.get('/users', adminOnly, (req, res) => res.json({ users: users.list(), roles: users.ROLES }));
router.post('/users', adminOnly, (req, res) => res.json(users.create(req.body, req.admin)));
router.put('/users/:id', adminOnly, (req, res) => res.json(users.update(Number(req.params.id), req.body, req.admin)));
router.post('/users/:id/reset-password', adminOnly, (req, res) => res.json({ tempPassword: users.resetPassword(Number(req.params.id), req.admin) }));

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
router.get('/dashboard', (req, res) => {
  const byStatus = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM submissions GROUP BY status').all().map((r) => [r.status, r.n]));
  res.json({
    stats: ops.stats(),
    byStatus,
    statuses: admin.STATUSES,
    recentSubmissions: db.prepare(`SELECT id, reg_no, client_name, matter_type, urgency, status, created_at, conflict_hits FROM submissions ORDER BY id DESC LIMIT 8`).all()
      .map((r) => ({ ...r, conflicts: json.parse(r.conflict_hits, []).length, conflict_hits: undefined })),
    recentInquiries: db.prepare(`SELECT id, ref, from_name, from_email, subject, status, kind, spam_score, received_at FROM inquiries ORDER BY id DESC LIMIT 8`).all(),
    agents: {
      administratif: { aktif: true, ai: ai.isEnabled() },
      operasional: { aktif: ops.status.running, lastTick: ops.status.lastTick, imap: config.imap.enabled, lastImapPoll: ops.status.lastImapPoll, lastImapError: ops.status.lastImapError },
      keamanan: { aktif: true, spamThreshold: config.security.spamThreshold, bots24h: db.prepare(`SELECT COUNT(*) n FROM audit_log WHERE action IN ('bot_ditolak','rate_limit','login_gagal') AND created_at >= datetime('now','-1 day')`).get().n },
    },
    channels: {
      smtp: config.smtp.enabled,
      imap: config.imap.enabled,
      whatsapp: config.whatsapp.provider,
      whatsappTeam: users.teamRecipients().whatsapp.length,
      whatsappMode: config.whatsapp.provider === 'meta' ? config.whatsapp.metaMode : null,
      whatsappWebhook: Boolean(config.whatsapp.metaAppSecret && config.whatsapp.metaVerifyToken),
      telegram: config.telegram.enabled,
      teamEmails: users.teamRecipients().emails.length,
      ai: ai.isEnabled(),
      publicUrl: config.publicUrl,
    },
  });
});

// ---------------------------------------------------------------------------
// Inquiries (incoming email)
// ---------------------------------------------------------------------------
router.get('/inquiries', (req, res) => {
  const { status = '', q = '' } = req.query;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const like = `%${q}%`;
  const rows = db.prepare(`SELECT id, ref, from_name, from_email, subject, status, kind, spam_score, received_at, submission_id, ai
    FROM inquiries WHERE (? = '' OR status = ?) AND (? = '' OR from_email LIKE ? OR from_name LIKE ? OR subject LIKE ? OR ref LIKE ?)
    ORDER BY id DESC LIMIT 50 OFFSET ?`).all(status, status, q, like, like, like, like, (page - 1) * 50);
  res.json(rows.map((r) => ({ ...r, ai: json.parse(r.ai, null) })));
});

router.get('/inquiries/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM inquiries WHERE id = ?').get(req.params.id);
  if (!row) throw httpError(404, 'Tidak ditemukan');
  delete row.invite_token;
  res.json({
    ...row,
    attachments: json.parse(row.attachments, []),
    security_flags: json.parse(row.security_flags, []),
    ai: json.parse(row.ai, null),
    notifications: db.prepare('SELECT id, channel, recipient, subject, status, last_error, created_at FROM notifications WHERE related = ? ORDER BY id').all(row.ref),
  });
});

router.post('/inquiries/:id/status', (req, res) => {
  const allowed = ['new', 'invited', 'spam', 'ignored', 'replied'];
  if (!allowed.includes(req.body.status)) throw httpError(400, 'Status tidak valid');
  db.prepare('UPDATE inquiries SET status = ? WHERE id = ?').run(req.body.status, req.params.id);
  audit(actor(req), 'status_email', { id: req.params.id, status: req.body.status }, req.ip);
  res.json({ ok: true });
});

/** Send (or re-send) the registration invitation, e.g. for an email the security agent held back. */
router.post('/inquiries/:id/invite', (req, res) => {
  const inq = db.prepare('SELECT * FROM inquiries WHERE id = ?').get(req.params.id);
  if (!inq) throw httpError(404, 'Tidak ditemukan');
  const t = inq.invite_token || require('../util/ids').token();
  db.prepare(`UPDATE inquiries SET invite_token = ?, status = 'invited', autoreply_sent_at = datetime('now') WHERE id = ?`).run(t, inq.id);
  outbox.emailTemplate('inquiry_autoreply', inq.from_email, {
    ref: inq.ref, client_name: inq.from_name || 'Bapak/Ibu', subject: inq.subject || '(tanpa perihal)',
    office_hours_note: admin.officeHoursNote(), form_link: `${config.publicUrl}/daftar?t=${t}`,
  }, { related: inq.ref, inReplyTo: inq.message_id });
  audit(actor(req), 'kirim_undangan', { ref: inq.ref }, req.ip);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Submissions (registrations)
// ---------------------------------------------------------------------------
router.get('/submissions', (req, res) => {
  const { status = '', q = '' } = req.query;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const like = `%${q}%`;
  const rows = db.prepare(`SELECT id, reg_no, client_name, client_email, client_phone, matter_type, urgency, status, created_at, updated_at, conflict_hits, assigned_to, sla_reminded_at
    FROM submissions WHERE (? = '' OR status = ?) AND (? = '' OR client_name LIKE ? OR client_email LIKE ? OR reg_no LIKE ? OR opposing_party LIKE ?)
    ORDER BY id DESC LIMIT 50 OFFSET ?`).all(status, status, q, like, like, like, like, (page - 1) * 50);
  res.json(rows.map((r) => ({ ...r, conflicts: json.parse(r.conflict_hits, []).length, conflict_hits: undefined })));
});

router.get('/submissions.csv', adminOnly, (req, res) => {
  const rows = db.prepare('SELECT * FROM submissions ORDER BY id').all();
  const form = settings.get('form');
  const fieldIds = form.sections.flatMap((s) => s.fields).filter((f) => !['info', 'file'].includes(f.type));
  const head = ['reg_no', 'status', 'created_at', ...fieldIds.map((f) => f.label)];
  // Prefix cells that start with = + - @ to stop spreadsheet formula injection.
  const cell = (v) => {
    let s = Array.isArray(v) ? v.join('; ') : String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [head.map(cell).join(',')];
  for (const r of rows) {
    const d = json.parse(r.data, {});
    lines.push([r.reg_no, admin.STATUSES[r.status], r.created_at, ...fieldIds.map((f) => d[f.id])].map(cell).join(','));
  }
  audit(actor(req), 'ekspor_csv', { rows: rows.length }, req.ip);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="registrasi-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(`﻿${lines.join('\r\n')}`);
});

router.get('/submissions/:id', (req, res) => {
  const sub = admin.loadSubmission(req.params.id);
  if (!sub) throw httpError(404, 'Tidak ditemukan');
  const form = settings.getVersion('form', sub.form_version) || settings.get('form');
  audit(actor(req), 'lihat_registrasi', { reg: sub.reg_no }, req.ip);
  res.json({
    ...sub,
    status_token: undefined,
    statusLabel: admin.STATUSES[sub.status],
    answers: admin.answersFor(form, sub.data, sub.files),
    files: sub.files.map(({ id, name, size, mime, field, sha256 }) => ({ id, name, size, mime, field, sha256 })),
    events: db.prepare('SELECT * FROM submission_events WHERE submission_id = ? ORDER BY id').all(sub.id).map((e) => ({ ...e, payload: json.parse(e.payload, {}) })),
    inquiry: sub.inquiry_id ? db.prepare('SELECT id, ref, subject, body_text, received_at FROM inquiries WHERE id = ?').get(sub.inquiry_id) : null,
    notifications: db.prepare('SELECT id, channel, recipient, subject, status, last_error, created_at FROM notifications WHERE related = ? ORDER BY id').all(sub.reg_no),
    statusLink: admin.statusLink({ reg_no: sub.reg_no, status_token: sub.status_token }),
  });
});

router.post('/submissions/:id/status', (req, res) => {
  const updated = admin.changeStatus(Number(req.params.id), req.body.status, {
    actor: req.admin, message: req.body.message, notifyClient: req.body.notifyClient !== false,
  });
  res.json({ ok: true, status: updated.status });
});

router.post('/submissions/:id/assign', (req, res) => {
  const updated = admin.assign(Number(req.params.id), req.body.username || null, { actor: req.admin, note: req.body.note });
  res.json({ ok: true, assigned_to: updated.assigned_to });
});

router.post('/submissions/:id/note', (req, res) => {
  admin.addNote(Number(req.params.id), req.admin, req.body.note);
  res.json({ ok: true });
});

router.post('/submissions/:id/recheck-conflict', (req, res) => {
  const sub = admin.loadSubmission(req.params.id);
  if (!sub) throw httpError(404, 'Tidak ditemukan');
  const hits = security.conflictCheck({ clientName: sub.client_name, companyName: sub.data.company_name, opposingParty: sub.opposing_party, excludeSubmissionId: sub.id });
  db.prepare('UPDATE submissions SET conflict_hits = ? WHERE id = ?').run(json.str(hits), sub.id);
  db.prepare('INSERT INTO submission_events(submission_id, type, actor, payload) VALUES (?, ?, ?, ?)').run(sub.id, 'conflict', req.admin, json.str({ hits: hits.length, manual: true }));
  res.json({ hits });
});

router.get('/submissions/:id/files/:fileId', (req, res) => {
  const sub = admin.loadSubmission(req.params.id);
  const file = sub?.files.find((f) => f.id === req.params.fileId);
  if (!file) throw httpError(404, 'Berkas tidak ditemukan');
  const full = path.join(config.uploadDir, path.basename(file.stored));
  if (!fs.existsSync(full)) throw httpError(404, 'Berkas tidak ditemukan di penyimpanan');
  audit(actor(req), 'unduh_berkas', { reg: sub.reg_no, file: file.name }, req.ip);
  res.setHeader('Content-Type', file.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"; filename*=UTF-8''${encodeURIComponent(file.name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  fs.createReadStream(full).pipe(res);
});

// ---------------------------------------------------------------------------
// Editable settings: office, form, chatbot, templates (versioned)
// ---------------------------------------------------------------------------
router.get('/settings/:key', (req, res) => {
  if (!settings.KEYS.includes(req.params.key)) throw httpError(404, 'Tidak dikenal');
  res.json({ ...settings.getRow(req.params.key), meta: { fieldTypes: settings.FIELD_TYPES, fieldRoles: settings.FIELD_ROLES, statuses: admin.STATUSES } });
});

router.put('/settings/:key', adminOnly, (req, res) => {
  const version = settings.set(req.params.key, req.body.value, req.admin);
  audit(actor(req), 'ubah_pengaturan', { key: req.params.key, version }, req.ip);
  res.json({ ok: true, version });
});

router.get('/settings/:key/history', (req, res) => res.json(settings.history(req.params.key)));
router.get('/settings/:key/version/:v', (req, res) => {
  const value = settings.getVersion(req.params.key, Number(req.params.v));
  if (!value) throw httpError(404, 'Versi tidak ditemukan');
  res.json({ value });
});
router.post('/settings/:key/reset', adminOnly, (req, res) => {
  const version = settings.set(req.params.key, settings.loadDefault(req.params.key), req.admin);
  audit(actor(req), 'reset_pengaturan', { key: req.params.key, version }, req.ip);
  res.json({ ok: true, version });
});

/** Preview a template with sample data (uses the unsaved template text sent by the editor). */
router.post('/preview', (req, res) => {
  const { channel, template } = req.body;
  const office = settings.get('office');
  const sample = {
    ...outbox.officeVars(),
    ref: 'INQ-2026-00001', reg_no: 'REG-2026-00001', client_name: 'Budi Santoso', client_email: 'budi@contoh.id', client_phone: '081234567890',
    from_email: 'budi@contoh.id', subject: 'Permohonan konsultasi sengketa kontrak', snippet: 'Selamat siang, saya ingin berkonsultasi mengenai wanprestasi...',
    matter_type: 'Perdata & Kontrak', urgency: 'Segera (1–2 minggu)', urgency_tag: 'BARU', preferred_contact: 'WhatsApp',
    submitted_at: '6 Oktober 2026 pukul 10.15 WIB', sla_due: '7 Oktober 2026 pukul 10.15 WIB', status_label: 'Sedang ditinjau',
    form_link: `${config.publicUrl}/daftar?t=contoh`, status_link: `${config.publicUrl}/status?r=REG-2026-00001&k=contoh`, admin_link: `${config.publicUrl}/admin/`,
    office_hours_note: '', conflict_text: 'Tidak ada indikasi benturan kepentingan', ai_summary: 'Calon klien mengalami wanprestasi atas kontrak suplai.',
    ai_category: 'Perdata & Kontrak', security_text: 'Aman', autoreply_text: 'terkirim (undangan formulir)', description_snippet: 'Rekanan kami tidak melakukan pembayaran sesuai kontrak...',
    custom_message: 'Contoh pesan dari tim: Senin, 12 Oktober 2026 pukul 10.00 WIB di kantor kami.', age_hours: 26,
    summary_html: '<table width="100%" style="border:1px solid #e3e7ee;border-radius:6px"><tr><td style="padding:8px;color:#6b7280">Bidang hukum</td><td style="padding:8px">Perdata &amp; Kontrak</td></tr><tr><td style="padding:8px;color:#6b7280">Urgensi</td><td style="padding:8px">Segera</td></tr></table>',
    summary_text: 'Bidang hukum: Perdata & Kontrak\nUrgensi: Segera',
    staff_name: 'Rina Advokat', assigned_by: 'admin', assign_note: 'Mohon dihubungi hari ini.',
    wa_from: '+6281234567890', wa_name: 'Budi', wa_text: 'Selamat siang, apakah jadwal konsultasi saya sudah ada?',
    date: '2026-10-06', inquiries_24h: 4, submissions_24h: 2, pending_review: 3, overdue: 1, failed_notifications: 0,
  };
  if (channel === 'email') return res.json(renderEmail(template, sample, office));
  if (channel === 'telegram') return res.json({ html: renderHtml(template, sample) });
  res.json({ text: renderText(template, sample) });
});

// ---------------------------------------------------------------------------
// Conflict-check party list
// ---------------------------------------------------------------------------
router.get('/parties', (req, res) => {
  const q = `%${req.query.q || ''}%`;
  res.json(db.prepare('SELECT * FROM parties WHERE name LIKE ? OR matter_ref LIKE ? ORDER BY name LIMIT 500').all(q, q));
});

router.post('/parties', (req, res) => {
  // Accepts a single party or bulk text: one per line "Nama;peran;referensi perkara"
  const items = req.body.bulk
    ? String(req.body.bulk).split('\n').map((l) => l.split(/[;\t]/).map((x) => x.trim())).filter((p) => p[0])
      .map(([name, role, matterRef]) => ({ name, role, matterRef }))
    : [req.body];
  const roles = ['klien', 'lawan', 'terkait'];
  const insert = db.prepare('INSERT INTO parties(name, normalized, role, matter_ref, notes) VALUES (?, ?, ?, ?, ?)');
  let added = 0;
  for (const p of items) {
    const name = security.clean(p.name, 200);
    if (!name) continue;
    const role = roles.includes(String(p.role || '').toLowerCase()) ? String(p.role).toLowerCase() : 'klien';
    insert.run(name, security.normalizeName(name), role, security.clean(p.matterRef, 100) || null, security.clean(p.notes, 500) || null);
    added += 1;
  }
  audit(actor(req), 'tambah_pihak', { added }, req.ip);
  res.json({ ok: true, added });
});

router.delete('/parties/:id', adminOnly, (req, res) => {
  db.prepare('DELETE FROM parties WHERE id = ?').run(req.params.id);
  audit(actor(req), 'hapus_pihak', { id: req.params.id }, req.ip);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Notifications, audit log, tools
// ---------------------------------------------------------------------------
router.get('/notifications', (req, res) => {
  const status = req.query.status || '';
  res.json(db.prepare(`SELECT id, channel, recipient, subject, substr(body, 1, 300) AS body, status, attempts, last_error, related, created_at, sent_at
    FROM notifications WHERE (? = '' OR status = ?) ORDER BY id DESC LIMIT 200`).all(status, status));
});

router.post('/notifications/:id/retry', (req, res) => {
  outbox.retry(Number(req.params.id));
  res.json({ ok: true });
});

router.get('/audit', adminOnly, (req, res) => {
  res.json(db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 300').all());
});

router.post('/simulate-email', adminOnly, async (req, res) => {
  const { fromName, fromEmail, subject, text } = req.body;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail || '')) throw httpError(400, 'Email pengirim tidak valid');
  const result = await admin.handleInboundEmail({
    messageId: `<simulasi-${Date.now()}@lokal>`, fromEmail, fromName, subject, text, headers: {}, attachments: [],
  });
  audit(actor(req), 'simulasi_email', { from: fromEmail }, req.ip);
  res.json(result);
});

router.post('/test-channel', adminOnly, async (req, res) => {
  const { channel, to } = req.body;
  const text = `Tes notifikasi dari panel admin ${settings.get('office').name} (${new Date().toLocaleString('id-ID')}).`;
  if (!['email', 'whatsapp', 'telegram'].includes(channel)) throw httpError(400, 'Kanal tidak valid');
  const team = users.teamRecipients();
  const recipient = to || (channel === 'telegram' ? config.telegram.chatIds[0] : channel === 'whatsapp' ? team.whatsapp[0] : team.emails[0]);
  if (!recipient) throw httpError(400, 'Isi tujuan pengiriman atau atur penerima tim di .env');
  const id = outbox.enqueue({ channel, to: recipient, subject: 'Tes notifikasi', text, html: channel === 'email' ? `<p>${text}</p>` : null, related: 'tes' });
  await new Promise((r) => setTimeout(r, 2500));
  res.json(db.prepare('SELECT id, status, last_error FROM notifications WHERE id = ?').get(id));
});

router.post('/run/:job', adminOnly, async (req, res) => {
  const jobs = {
    'poll-mailbox': () => ops.pollMailbox(),
    'sla-check': () => ({ reminded: ops.checkSla() }),
    'invite-reminders': () => ({ sent: ops.remindInvited() }),
    outbox: async () => ({ processed: await outbox.processDue(50) }),
  };
  if (!jobs[req.params.job]) throw httpError(404, 'Tugas tidak dikenal');
  audit(actor(req), 'jalankan_tugas', { job: req.params.job }, req.ip);
  res.json(await jobs[req.params.job]());
});

module.exports = router;
