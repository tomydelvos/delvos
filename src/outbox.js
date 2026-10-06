'use strict';
// Every outgoing message goes through this outbox: it is stored first, then delivered,
// and retried with exponential backoff by the operational agent if a provider is down.
const { db, json } = require('./db');
const config = require('./config');
const settings = require('./settings');
const { renderEmail, renderText, renderHtml } = require('./util/template');
const { toDb } = require('./util/time');
const { sendEmail } = require('./channels/email');
const { sendWhatsApp } = require('./channels/whatsapp');
const { sendTelegram } = require('./channels/telegram');

const MAX_ATTEMPTS = 6;

/**
 * Staging guard: only team chats, staff accounts, and STAGING_ALLOWED_RECIPIENTS
 * (emails, "@domain" entries, phone numbers) receive real messages. Everything else is
 * stored as "blocked" so testers can read exactly what a client would have received.
 */
function stagingAllowed(channel, to) {
  if (channel === 'telegram') return true;
  const { normalizePhone } = require('./channels/whatsapp');
  const target = channel === 'whatsapp' ? normalizePhone(to) : String(to).trim().toLowerCase();
  if (!target) return false;
  const staff = db.prepare('SELECT email, whatsapp FROM users WHERE active = 1').all();
  const allowed = [...config.stagingAllow, ...staff.flatMap((u) => [u.email, u.whatsapp])].filter(Boolean);
  return allowed.some((entry) => {
    const e = String(entry).trim().toLowerCase();
    if (channel === 'whatsapp') return normalizePhone(e) === target;
    return e.startsWith('@') ? target.endsWith(e) : e === target;
  });
}

function enqueue({ channel, to, subject = null, text, html = null, related = null, meta = {} }) {
  const blocked = config.isStaging && !stagingAllowed(channel, to);
  if (config.isStaging) {
    if (subject) subject = `[STAGING] ${subject}`;
    text = channel === 'telegram' ? `🧪 <b>STAGING</b>\n${text}` : `[STAGING] ${text}`;
    if (html) html = html.replace(/<body([^>]*)>/, '<body$1><div style="background:#b54708;color:#fff;text-align:center;padding:6px;font:600 13px sans-serif">STAGING — email uji coba, bukan dari layanan resmi</div>');
  }
  const row = db.prepare(`INSERT INTO notifications(channel, recipient, subject, body, html, related, meta, status, last_error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(channel, to, subject, text, html, related, json.str(meta),
    blocked ? 'blocked' : 'pending', blocked ? 'Staging: penerima tidak ada di daftar izin (pesan tidak dikirim)' : null);
  if (!blocked) setImmediate(() => deliver(row.id).catch((err) => console.error('[outbox]', err)));
  return row.id;
}

async function deliver(id) {
  // Claim the row so a parallel scheduler tick cannot send it twice.
  const claimed = db.prepare(`UPDATE notifications SET attempts = attempts + 1, next_attempt_at = datetime('now', '+10 minutes')
    WHERE id = ? AND status = 'pending' RETURNING *`).get(id);
  if (!claimed) return;
  const meta = json.parse(claimed.meta, {});
  try {
    let result;
    if (claimed.channel === 'email') {
      result = await sendEmail({ to: claimed.recipient, subject: claimed.subject, text: claimed.body, html: claimed.html, inReplyTo: meta.inReplyTo });
    } else if (claimed.channel === 'whatsapp') {
      result = await sendWhatsApp(claimed.recipient, claimed.body);
    } else if (claimed.channel === 'telegram') {
      result = await sendTelegram(claimed.recipient, claimed.body, meta);
    } else {
      throw new Error(`Kanal tidak dikenal: ${claimed.channel}`);
    }
    db.prepare(`UPDATE notifications SET status = ?, sent_at = datetime('now'), last_error = NULL, provider_id = ? WHERE id = ?`)
      .run(result?.simulated ? 'simulated' : 'sent', result?.id ?? result?.messageId ?? null, id);
  } catch (err) {
    const failed = claimed.attempts >= MAX_ATTEMPTS;
    const backoffMin = Math.min(2 ** claimed.attempts, 240);
    db.prepare(`UPDATE notifications SET status = ?, last_error = ?, next_attempt_at = ? WHERE id = ?`)
      .run(failed ? 'failed' : 'pending', String(err.message || err).slice(0, 500), toDb(new Date(Date.now() + backoffMin * 60e3)), id);
    console.warn(`[outbox] #${id} ${claimed.channel} -> ${claimed.recipient} gagal (percobaan ${claimed.attempts}): ${err.message}`);
  }
}

async function processDue(limit = 20) {
  const rows = db.prepare(`SELECT id FROM notifications WHERE status = 'pending' AND next_attempt_at <= datetime('now') ORDER BY id LIMIT ?`).all(limit);
  for (const r of rows) await deliver(r.id);
  return rows.length;
}

function retry(id) {
  db.prepare(`UPDATE notifications SET status = 'pending', attempts = 0, next_attempt_at = datetime('now') WHERE id = ? AND status = 'failed'`).run(id);
  setImmediate(() => deliver(id).catch(() => {}));
}

// ---- Template helpers -------------------------------------------------------

function officeVars() {
  const office = settings.get('office');
  return {
    firm_name: office.name,
    firm_phone: office.phone,
    firm_email: office.email,
    firm_whatsapp: office.whatsapp,
    office_hours: office.officeHours?.label || '',
    sla_hours: office.slaHours,
    signature: office.signature,
  };
}

function emailTemplate(key, to, vars, { related, inReplyTo } = {}) {
  if (!to) return null;
  const tpl = settings.get('templates').email?.[key];
  if (!tpl) return null;
  const office = settings.get('office');
  const msg = renderEmail(tpl, { ...officeVars(), ...vars }, office);
  return enqueue({ channel: 'email', to, subject: msg.subject, text: msg.text, html: msg.html, related, meta: { template: key, inReplyTo } });
}

function whatsappTemplate(key, to, vars, { related } = {}) {
  if (!to) return null;
  const tpl = settings.get('templates').whatsapp?.[key];
  if (!tpl) return null;
  return enqueue({ channel: 'whatsapp', to, text: renderText(tpl, { ...officeVars(), ...vars }), related, meta: { template: key } });
}

function telegramTemplate(key, chatId, vars, { related, buttonUrl, buttonLabel } = {}) {
  const tpl = settings.get('templates').telegram?.[key];
  if (!tpl) return null;
  return enqueue({ channel: 'telegram', to: chatId, text: renderHtml(tpl, { ...officeVars(), ...vars }), related, meta: { template: key, buttonUrl, buttonLabel } });
}

/** Internal team alert on WhatsApp + Telegram (and email when withEmail is set). */
function notifyTeam(key, vars, { related, withEmail = false } = {}) {
  const ids = [];
  const team = require('./users').teamRecipients();
  for (const phone of team.whatsapp) ids.push(whatsappTemplate(key, phone, vars, { related }));
  const chatIds = config.telegram.chatIds.length ? config.telegram.chatIds : (config.telegram.botToken ? [] : ['(belum-dikonfigurasi)']);
  for (const chat of chatIds) ids.push(telegramTemplate(key, chat, vars, { related, buttonUrl: vars.admin_link, buttonLabel: 'Buka di Panel Admin' }));
  if (withEmail) for (const email of team.emails) ids.push(emailTemplate(key, email, vars, { related }));
  return ids.filter(Boolean);
}

module.exports = { stagingAllowed, enqueue, deliver, processDue, retry, emailTemplate, whatsappTemplate, telegramTemplate, notifyTeam, officeVars, MAX_ATTEMPTS };
