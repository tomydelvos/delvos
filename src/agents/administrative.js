'use strict';
// AGEN ADMINISTRATIF (Administrative agent)
// Owns the client-facing paperwork of the intake process:
//  1. Receives client emails, gives each a reference number, replies professionally with a
//     personal registration link (or acknowledges follow-ups from existing registrants)
//  2. Accepts registration forms, issues registration numbers, confirms to the client
//  3. Sends the client a professional letter on every status change decided by the team
const config = require('../config');
const settings = require('../settings');
const { db, json, tx, audit } = require('../db');
const { inquiryRef, registrationNo, token } = require('../util/ids');
const { escapeHtml } = require('../util/template');
const { fromDb, slaDue, formatDateTime, isOfficeOpen } = require('../util/time');
const outbox = require('../outbox');
const security = require('./security');
const ai = require('../ai/claude');

const AGENT = 'administratif';

const STATUSES = {
  baru: 'Baru diterima',
  ditinjau: 'Sedang ditinjau',
  perlu_info: 'Perlu informasi tambahan',
  dijadwalkan: 'Konsultasi dijadwalkan',
  diterima: 'Diterima sebagai klien',
  ditolak: 'Tidak dapat ditangani',
  arsip: 'Diarsipkan',
};
// Statuses that send the client a letter (template email.status_<key>) when the team chooses to notify.
const CLIENT_LETTER_STATUSES = ['ditinjau', 'perlu_info', 'dijadwalkan', 'diterima', 'ditolak'];
// Statuses where the team must write the content of the letter (what info is needed, the schedule).
const MESSAGE_REQUIRED = ['perlu_info', 'dijadwalkan'];

const snippet = (t, n = 300) => {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
};
const adminLink = (hash) => `${config.publicUrl}/admin/#${hash}`;
const statusLink = (sub) => `${config.publicUrl}/status?r=${encodeURIComponent(sub.reg_no)}&k=${encodeURIComponent(sub.status_token)}`;

function officeHoursNote(date = new Date()) {
  const office = settings.get('office');
  if (isOfficeOpen(office, date)) return '';
  return `Pesan Anda kami terima di luar jam kerja kantor (${office.officeHours?.label || ''}). Tim kami akan menindaklanjutinya pada hari kerja berikutnya.`;
}

// ---------------------------------------------------------------------------
// Form answers -> readable summary
// ---------------------------------------------------------------------------
function answersFor(form, data, files = []) {
  const out = [];
  for (const section of form?.sections || []) {
    for (const f of section.fields) {
      if (f.type === 'info') continue;
      let value;
      if (f.type === 'file') {
        const names = files.filter((x) => x.field === f.id).map((x) => x.name);
        if (!names.length) continue;
        value = names.join(', ');
      } else {
        const v = data[f.id];
        if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
        value = f.type === 'checkbox' ? (v ? 'Ya' : 'Tidak') : Array.isArray(v) ? v.join(', ') : String(v);
      }
      out.push({ id: f.id, section: section.title, label: f.label, value, type: f.type });
    }
  }
  return out;
}

function summaryHtml(answers) {
  const rows = answers.filter((a) => a.type !== 'checkbox').map((a) => `<tr>
<td style="padding:8px 10px;border-bottom:1px solid #eef0f3;color:#6b7280;width:38%;vertical-align:top;font-size:13px">${escapeHtml(a.label)}</td>
<td style="padding:8px 10px;border-bottom:1px solid #eef0f3;font-size:13px;white-space:pre-wrap">${escapeHtml(snippet(a.value, 600))}</td></tr>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e3e7ee;border-radius:6px;border-collapse:separate;margin:0 0 16px">${rows}</table>`;
}

const summaryText = (answers) => answers.filter((a) => a.type !== 'checkbox').map((a) => `${a.label}: ${snippet(a.value, 600)}`).join('\n');

function loadSubmission(id) {
  const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
  if (!sub) return null;
  sub.data = json.parse(sub.data, {});
  sub.files = json.parse(sub.files, []);
  sub.conflict_hits = json.parse(sub.conflict_hits, []);
  sub.security_flags = json.parse(sub.security_flags, []);
  sub.ai = json.parse(sub.ai, null);
  return sub;
}

function submissionVars(sub) {
  const form = settings.getVersion('form', sub.form_version) || settings.get('form');
  const answers = answersFor(form, sub.data, sub.files);
  const office = settings.get('office');
  const created = fromDb(sub.created_at);
  const urgent = /mendesak/i.test(sub.urgency || '');
  return {
    reg_no: sub.reg_no,
    client_name: sub.client_name,
    client_email: sub.client_email,
    client_phone: sub.client_phone || '-',
    matter_type: sub.matter_type || '-',
    urgency: sub.urgency || '-',
    urgency_tag: urgent ? 'MENDESAK' : 'BARU',
    preferred_contact: sub.data.preferred_contact || 'email/telepon',
    submitted_at: formatDateTime(created),
    sla_due: formatDateTime(slaDue(office, created)),
    status_label: STATUSES[sub.status] || sub.status,
    status_link: statusLink(sub),
    admin_link: adminLink(`submission/${sub.id}`),
    conflict_text: security.conflictText(sub.conflict_hits),
    ai_summary: sub.ai?.summary || '',
    description_snippet: snippet(sub.data[roleField(form, 'description')] || '', 400),
    summary_html: summaryHtml(answers),
    summary_text: summaryText(answers),
  };
}

function roleField(form, role) {
  for (const s of form?.sections || []) for (const f of s.fields) if (f.role === role) return f.id;
  return null;
}

function addEvent(submissionId, type, actor, payload = {}) {
  db.prepare('INSERT INTO submission_events(submission_id, type, actor, payload) VALUES (?, ?, ?, ?)')
    .run(submissionId, type, actor, json.str(payload));
}

// ---------------------------------------------------------------------------
// 1. Incoming email
// ---------------------------------------------------------------------------
/**
 * @param {{messageId?:string, fromEmail:string, fromName?:string, subject?:string, text?:string,
 *          headers?:Map|object, attachments?:{filename:string,size:number,contentType:string}[]}} mail
 */
async function handleInboundEmail(mail) {
  const fromEmail = String(mail.fromEmail || '').toLowerCase().trim();
  if (!fromEmail) return { skipped: 'tanpa-pengirim' };
  if (mail.messageId && db.prepare('SELECT id FROM inquiries WHERE message_id = ?').get(mail.messageId)) {
    return { skipped: 'duplikat' };
  }
  const ownAddresses = [config.smtp.user, config.smtp.from, config.imap.user].filter(Boolean).map((a) => a.toLowerCase());
  if (ownAddresses.some((a) => a.includes(fromEmail))) return { skipped: 'email-sendiri' };

  const screen = security.screenEmail({ ...mail, fromEmail });
  const existing = db.prepare(`SELECT id FROM submissions WHERE client_email = ? AND status != 'arsip'
    AND created_at >= datetime('now', '-180 days') ORDER BY id DESC LIMIT 1`).get(fromEmail);
  const kind = existing ? 'follow_up' : 'new';
  const status = screen.verdict === 'spam' ? 'spam' : 'new';
  const attachments = (mail.attachments || []).map((a) => ({ filename: a.filename, size: a.size, contentType: a.contentType }));

  const inquiry = tx(() => db.prepare(`INSERT INTO inquiries(ref, message_id, from_email, from_name, subject, body_text, attachments, kind, status, spam_score, security_flags, submission_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`).get(
    inquiryRef(), mail.messageId || null, fromEmail, security.clean(mail.fromName, 200) || null,
    security.clean(mail.subject, 500), security.clean(mail.text, 50000), json.str(attachments),
    kind, status, screen.score, json.str(screen.flags), existing?.id || null,
  ));
  audit(AGENT, 'email_masuk', { ref: inquiry.ref, from: fromEmail, kind, verdict: screen.verdict, score: screen.score });

  let triage = null;
  if (status !== 'spam') {
    triage = await ai.triageEmail({ fromName: mail.fromName, fromEmail, subject: mail.subject, text: mail.text });
    if (triage) db.prepare('UPDATE inquiries SET ai = ? WHERE id = ?').run(json.str(triage), inquiry.id);
  }

  // Decide on the auto-reply.
  let autoreply = 'tidak dikirim';
  const reasons = [];
  if (status === 'spam') reasons.push('terindikasi spam');
  if (screen.automated) reasons.push('email otomatis');
  if (triage && triage.is_legal_inquiry === false) reasons.push('AI: bukan permintaan jasa hukum');
  if (!security.canAutoReply(fromEmail)) reasons.push('batas balasan otomatis per pengirim');

  const baseVars = {
    ref: inquiry.ref,
    client_name: inquiry.from_name || 'Bapak/Ibu',
    from_email: fromEmail,
    subject: inquiry.subject || '(tanpa perihal)',
    snippet: snippet(inquiry.body_text, 350),
    office_hours_note: officeHoursNote(),
    ai_category: triage?.category || '',
    security_text: screen.verdict === 'ok' ? 'Aman' : `${screen.verdict === 'spam' ? 'SPAM' : 'Mencurigakan'} (skor ${screen.score}): ${screen.flags.slice(0, 3).join('; ')}`,
    admin_link: adminLink(`inquiry/${inquiry.id}`),
  };

  if (!reasons.length) {
    if (kind === 'new') {
      const t = token();
      db.prepare(`UPDATE inquiries SET invite_token = ?, status = 'invited', autoreply_sent_at = datetime('now') WHERE id = ?`).run(t, inquiry.id);
      outbox.emailTemplate('inquiry_autoreply', fromEmail, { ...baseVars, form_link: `${config.publicUrl}/daftar?t=${t}` }, { related: inquiry.ref, inReplyTo: mail.messageId });
      autoreply = 'terkirim (undangan formulir)';
    } else {
      const sub = loadSubmission(existing.id);
      db.prepare(`UPDATE inquiries SET status = 'replied', autoreply_sent_at = datetime('now') WHERE id = ?`).run(inquiry.id);
      outbox.emailTemplate('inquiry_followup_ack', fromEmail, { ...baseVars, ...submissionVars(sub), subject: baseVars.subject }, { related: sub.reg_no, inReplyTo: mail.messageId });
      addEvent(sub.id, 'email', AGENT, { ref: inquiry.ref, subject: inquiry.subject, snippet: baseVars.snippet });
      autoreply = `terkirim (email lanjutan ${sub.reg_no})`;
    }
  } else {
    autoreply = `ditahan: ${reasons.join(', ')}`;
  }

  // Spam is kept out of the team's phones; it shows in the panel and in the daily digest.
  if (status !== 'spam') {
    outbox.notifyTeam('inquiry_team', { ...baseVars, autoreply_text: autoreply }, { related: inquiry.ref });
  }
  return { inquiryId: inquiry.id, ref: inquiry.ref, kind, verdict: screen.verdict, autoreply };
}

// ---------------------------------------------------------------------------
// 2. Registration form
// ---------------------------------------------------------------------------
class SubmissionError extends Error {
  constructor(errors) { super('Formulir belum valid'); this.errors = errors; this.status = 422; }
}

/**
 * @param {{body:object, files:Express.Multer.File[], ip:string}} input
 */
async function handleSubmission({ body, files = [], ip }) {
  const formRow = settings.getRow('form');
  const form = formRow.value;
  const botFlags = security.botCheck(body);
  if (botFlags.includes('honeypot') || botFlags.includes('terlalu-cepat')) {
    audit(security.AGENT, 'bot_ditolak', { flags: botFlags }, ip);
    return { ok: true, regNo: null }; // look successful to the bot, store nothing
  }

  const fileFields = form.sections.flatMap((s) => s.fields).filter((f) => f.type === 'file');
  const present = Object.fromEntries(fileFields.map((f) => [f.id, files.some((x) => x.fieldname === f.id)]));
  const { values, errors } = security.validateSubmission(form, body, present);

  const accepted = [];
  for (const file of files) {
    const field = fileFields.find((f) => f.id === file.fieldname);
    if (!field) continue;
    if (!field.multiple && accepted.some((a) => a.field === field.id)) continue;
    const check = security.checkUpload(file);
    if (!check.ok) { errors[field.id] = check.reason; continue; }
    accepted.push({ field: field.id, file, check });
  }
  if (Object.keys(errors).length) throw new SubmissionError(errors);

  const pick = (role) => { const id = roleField(form, role); return id ? values[id] : null; };
  const clientEmail = pick('client_email');

  // Idempotency: a double click / refresh within 10 minutes returns the same registration.
  const recent = db.prepare(`SELECT id, reg_no, status_token FROM submissions WHERE client_email = ? AND created_at >= datetime('now', '-10 minutes') ORDER BY id DESC LIMIT 1`).get(clientEmail);
  if (recent) return { ok: true, regNo: recent.reg_no, statusLink: statusLink(recent), duplicate: true };

  const inquiry = body._token ? db.prepare('SELECT id FROM inquiries WHERE invite_token = ?').get(String(body._token)) : null;
  const stored = accepted.map((a) => ({ field: a.field, ...security.storeUpload(a.file, a.check) }));

  const sub = tx(() => {
    const row = db.prepare(`INSERT INTO submissions(reg_no, inquiry_id, form_version, data, files, client_name, client_email, client_phone, matter_type, urgency, opposing_party, security_flags, ip, status_token)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`).get(
      registrationNo(), inquiry?.id || null, formRow.version, json.str(values), json.str(stored),
      pick('client_name'), clientEmail, pick('client_phone'), pick('matter_type'), pick('urgency'), pick('opposing_party'),
      json.str(botFlags), ip || null, token(18),
    );
    if (inquiry) db.prepare(`UPDATE inquiries SET status = 'registered', submission_id = ? WHERE id = ?`).run(row.id, inquiry.id);
    return row;
  });

  const hits = security.conflictCheck({
    clientName: sub.client_name, companyName: values.company_name, opposingParty: sub.opposing_party, excludeSubmissionId: sub.id,
  });
  db.prepare('UPDATE submissions SET conflict_hits = ? WHERE id = ?').run(json.str(hits), sub.id);
  addEvent(sub.id, 'created', AGENT, { files: stored.length, viaInquiry: inquiry ? true : false });
  if (hits.length) addEvent(sub.id, 'conflict', security.AGENT, { hits: hits.length });
  audit(AGENT, 'registrasi_baru', { reg: sub.reg_no, conflicts: hits.length }, ip);

  // Client confirmation goes out immediately; the team alert waits for the (optional) AI brief.
  const full = loadSubmission(sub.id);
  const vars = submissionVars(full);
  outbox.emailTemplate('submission_client', full.client_email, vars, { related: full.reg_no });
  if (config.whatsapp.notifyClient && full.client_phone) outbox.whatsappTemplate('submission_client', full.client_phone, vars, { related: full.reg_no });

  setImmediate(async () => {
    try {
      const form = settings.getVersion('form', full.form_version) || settings.get('form');
      const brief = await ai.summarizeSubmission({ formTitle: form.title, answers: answersFor(form, full.data, full.files) });
      if (brief) db.prepare('UPDATE submissions SET ai = ? WHERE id = ?').run(json.str(brief), full.id);
      const teamVars = submissionVars(loadSubmission(full.id));
      outbox.notifyTeam('submission_team', teamVars, { related: full.reg_no, withEmail: true });
    } catch (err) {
      console.error('[administratif] notifikasi tim gagal', err);
    }
  });

  return { ok: true, regNo: sub.reg_no, statusLink: statusLink(sub), slaDue: vars.sla_due };
}

// ---------------------------------------------------------------------------
// 3. Status changes decided by the team
// ---------------------------------------------------------------------------
function changeStatus(id, status, { actor, message = '', notifyClient = true } = {}) {
  if (!STATUSES[status]) throw Object.assign(new Error('Status tidak dikenal'), { status: 400 });
  const sub = loadSubmission(id);
  if (!sub) throw Object.assign(new Error('Registrasi tidak ditemukan'), { status: 404 });
  if (sub.status === status) throw Object.assign(new Error(`Status sudah "${STATUSES[status]}".`), { status: 400 });
  const msg = security.clean(message, 4000);
  const sendLetter = notifyClient && CLIENT_LETTER_STATUSES.includes(status);
  if (sendLetter && MESSAGE_REQUIRED.includes(status) && !msg) {
    throw Object.assign(new Error(status === 'perlu_info'
      ? 'Tuliskan informasi/dokumen yang dibutuhkan dari klien.'
      : 'Tuliskan detail jadwal konsultasi (hari, tanggal, jam, tempat/tautan).'), { status: 400 });
  }

  db.prepare(`UPDATE submissions SET status = ?, updated_at = datetime('now'),
    first_reviewed_at = COALESCE(first_reviewed_at, CASE WHEN ? != 'baru' THEN datetime('now') END) WHERE id = ?`).run(status, status, id);
  addEvent(id, 'status', actor, { from: sub.status, to: status, message: msg, notified: sendLetter });
  audit(`admin:${actor}`, 'ubah_status', { reg: sub.reg_no, from: sub.status, to: status, notified: sendLetter });

  if (sendLetter) {
    const updated = loadSubmission(id);
    const vars = { ...submissionVars(updated), custom_message: msg };
    outbox.emailTemplate(`status_${status}`, updated.client_email, vars, { related: updated.reg_no });
    if (config.whatsapp.notifyClient && updated.client_phone) outbox.whatsappTemplate('status_client', updated.client_phone, vars, { related: updated.reg_no });
  }
  return loadSubmission(id);
}

/** Assign a registration to a staff member and notify them (email + WhatsApp when available). */
function assign(id, username, { actor, note = '' } = {}) {
  const sub = loadSubmission(id);
  if (!sub) throw Object.assign(new Error('Registrasi tidak ditemukan'), { status: 404 });
  const users = require('../users');
  const user = username ? users.byUsername(username) : null;
  if (username && (!user || !user.active)) throw Object.assign(new Error('Pengguna tidak ditemukan atau nonaktif'), { status: 400 });
  const value = user ? user.username : null;
  if (value === sub.assigned_to) return sub;
  db.prepare(`UPDATE submissions SET assigned_to = ?, updated_at = datetime('now') WHERE id = ?`).run(value, id);
  const text = security.clean(note, 1000);
  addEvent(id, 'assign', actor, { from: sub.assigned_to, to: value, note: text });
  audit(`admin:${actor}`, 'tugaskan', { reg: sub.reg_no, to: value });
  if (user && user.username !== actor) {
    const vars = { ...submissionVars(loadSubmission(id)), staff_name: user.name, assigned_by: actor, assign_note: text };
    if (user.email) outbox.emailTemplate('assignment_staff', user.email, vars, { related: sub.reg_no });
    if (user.whatsapp) outbox.whatsappTemplate('assignment_staff', user.whatsapp, vars, { related: sub.reg_no });
  }
  return loadSubmission(id);
}

function addNote(id, actor, note) {
  const text = security.clean(note, 4000);
  if (!text) throw Object.assign(new Error('Catatan kosong'), { status: 400 });
  addEvent(id, 'note', actor, { note: text });
  db.prepare(`UPDATE submissions SET updated_at = datetime('now') WHERE id = ?`).run(id);
}

/** Public status page: only shows non-sensitive information, and needs the secret status token. */
function publicStatus(regNo, key) {
  const sub = db.prepare('SELECT reg_no, status, client_name, created_at, updated_at, status_token FROM submissions WHERE reg_no = ?').get(String(regNo || '').toUpperCase());
  if (!sub || !key || sub.status_token !== String(key)) return null;
  const firstName = String(sub.client_name || '').split(' ')[0];
  return {
    regNo: sub.reg_no,
    status: sub.status,
    statusLabel: STATUSES[sub.status],
    name: firstName,
    submittedAt: formatDateTime(fromDb(sub.created_at)),
    updatedAt: formatDateTime(fromDb(sub.updated_at)),
  };
}

/** Status lookup from the chatbot: registration number + email. Rate-limited by the route. */
function lookupStatus(regNo, email) {
  const sub = db.prepare('SELECT reg_no, status_token, client_email FROM submissions WHERE reg_no = ?').get(String(regNo || '').trim().toUpperCase());
  if (!sub || sub.client_email !== String(email || '').trim().toLowerCase()) return null;
  return publicStatus(sub.reg_no, sub.status_token);
}

module.exports = {
  AGENT, STATUSES, CLIENT_LETTER_STATUSES, MESSAGE_REQUIRED, SubmissionError,
  handleInboundEmail, handleSubmission, changeStatus, assign, addNote,
  loadSubmission, submissionVars, answersFor, publicStatus, lookupStatus, statusLink, officeHoursNote,
};
