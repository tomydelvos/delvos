'use strict';
// AGEN OPERASIONAL (Operational agent)
// Keeps the virtual office running on schedule:
//  - Polls the intake mailbox (IMAP) and hands each email to the administrative agent
//  - Delivers / retries queued notifications (email, WhatsApp, Telegram)
//  - Watches the response SLA: reminds the team, then escalates
//  - Sends one polite reminder to prospects who were invited but have not registered
//  - Sends the team a daily digest
const config = require('../config');
const settings = require('../settings');
const { db, audit, kv } = require('../db');
const { fromDb, slaDue, isOfficeOpen, localParts, hoursBetween } = require('../util/time');
const outbox = require('../outbox');
const admin = require('./administrative');

const AGENT = 'operasional';
const status = { lastImapPoll: null, lastImapError: null, lastTick: null, running: false };

// ---------------------------------------------------------------------------
// Mailbox polling
// ---------------------------------------------------------------------------
let polling = false;
async function pollMailbox() {
  if (!config.imap.enabled || polling) return { skipped: true };
  polling = true;
  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');
  const client = new ImapFlow({
    host: config.imap.host, port: config.imap.port, secure: config.imap.secure,
    auth: { user: config.imap.user, pass: config.imap.pass }, logger: false,
  });
  let processed = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock(config.imap.mailbox);
    try {
      const uids = (await client.search({ seen: false }, { uid: true })) || [];
      for (const uid of uids.slice(0, 25)) {
        const msg = await client.fetchOne(uid, { source: true }, { uid: true });
        if (!msg?.source) continue;
        const mail = await simpleParser(msg.source, { skipHtmlToText: false });
        const from = mail.from?.value?.[0] || {};
        try {
          await admin.handleInboundEmail({
            messageId: mail.messageId,
            fromEmail: from.address,
            fromName: from.name,
            subject: mail.subject,
            text: mail.text || '',
            headers: mail.headers,
            attachments: (mail.attachments || []).map((a) => ({ filename: a.filename, size: a.size, contentType: a.contentType })),
          });
          processed += 1;
        } finally {
          // Mark as seen even if processing failed once, so a poison message can't block the queue;
          // it is still in the mailbox for a human, and the error is in the log.
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
    status.lastImapError = null;
  } catch (err) {
    status.lastImapError = err.message;
    console.error('[operasional] IMAP gagal:', err.message);
    try { await client.logout(); } catch { /* ignore */ }
  } finally {
    status.lastImapPoll = new Date().toISOString();
    polling = false;
  }
  return { processed };
}

// ---------------------------------------------------------------------------
// SLA watch
// ---------------------------------------------------------------------------
function checkSla(now = new Date()) {
  const office = settings.get('office');
  const slaMs = Number(office.slaHours || 24) * 3600e3;
  const rows = db.prepare(`SELECT id, created_at, urgency, sla_reminded_at, sla_escalated_at FROM submissions
    WHERE status = 'baru' AND first_reviewed_at IS NULL`).all();
  let reminded = 0;
  for (const r of rows) {
    const created = fromDb(r.created_at);
    const urgent = /mendesak/i.test(r.urgency || '');
    const due = urgent ? new Date(created.getTime() + 2 * 3600e3) : slaDue(office, created);
    const escalateAt = new Date(due.getTime() + (urgent ? 2 * 3600e3 : slaMs / 2));
    const stage = !r.sla_reminded_at && now >= due ? 'reminder'
      : r.sla_reminded_at && !r.sla_escalated_at && now >= escalateAt ? 'escalation' : null;
    if (!stage) continue;
    const sub = admin.loadSubmission(r.id);
    const vars = { ...admin.submissionVars(sub), age_hours: hoursBetween(created, now) };
    outbox.notifyTeam('sla_team', vars, { related: sub.reg_no, withEmail: stage === 'escalation' });
    db.prepare(`UPDATE submissions SET ${stage === 'reminder' ? 'sla_reminded_at' : 'sla_escalated_at'} = datetime('now') WHERE id = ?`).run(r.id);
    audit(AGENT, stage === 'reminder' ? 'sla_pengingat' : 'sla_eskalasi', { reg: sub.reg_no, ageHours: vars.age_hours });
    reminded += 1;
  }
  return reminded;
}

// ---------------------------------------------------------------------------
// One reminder for invited prospects who did not register (only during office hours)
// ---------------------------------------------------------------------------
function remindInvited(now = new Date()) {
  const office = settings.get('office');
  if (!isOfficeOpen(office, now)) return 0;
  const hours = Number(office.inviteReminderHours || 48);
  if (hours <= 0) return 0;
  const rows = db.prepare(`SELECT * FROM inquiries WHERE status = 'invited' AND reminder_sent_at IS NULL AND submission_id IS NULL
    AND invite_token IS NOT NULL AND autoreply_sent_at <= datetime('now', ?) AND autoreply_sent_at >= datetime('now', '-14 days')`).all(`-${hours} hours`);
  for (const inq of rows) {
    outbox.emailTemplate('invite_reminder', inq.from_email, {
      ref: inq.ref, client_name: inq.from_name || 'Bapak/Ibu', subject: inq.subject,
      form_link: `${config.publicUrl}/daftar?t=${inq.invite_token}`,
    }, { related: inq.ref, inReplyTo: inq.message_id });
    db.prepare(`UPDATE inquiries SET reminder_sent_at = datetime('now') WHERE id = ?`).run(inq.id);
    audit(AGENT, 'pengingat_formulir', { ref: inq.ref });
  }
  return rows.length;
}

// ---------------------------------------------------------------------------
// Daily digest
// ---------------------------------------------------------------------------
function stats() {
  const one = (sql) => db.prepare(sql).get().n;
  return {
    inquiries_24h: one(`SELECT COUNT(*) n FROM inquiries WHERE received_at >= datetime('now','-1 day')`),
    spam_24h: one(`SELECT COUNT(*) n FROM inquiries WHERE status = 'spam' AND received_at >= datetime('now','-1 day')`),
    submissions_24h: one(`SELECT COUNT(*) n FROM submissions WHERE created_at >= datetime('now','-1 day')`),
    pending_review: one(`SELECT COUNT(*) n FROM submissions WHERE status = 'baru'`),
    overdue: one(`SELECT COUNT(*) n FROM submissions WHERE status = 'baru' AND sla_reminded_at IS NOT NULL`),
    failed_notifications: one(`SELECT COUNT(*) n FROM notifications WHERE status = 'failed'`),
    invited_waiting: one(`SELECT COUNT(*) n FROM inquiries WHERE status = 'invited'`),
    total_submissions: one(`SELECT COUNT(*) n FROM submissions`),
  };
}

function dailyDigest(now = new Date()) {
  const office = settings.get('office');
  const p = localParts(now);
  if (p.hour !== Number(office.dailyDigestHour ?? 8) || kv.get('digest_date') === p.date) return false;
  kv.set('digest_date', p.date);
  const vars = { ...stats(), date: p.date };
  const chats = config.telegram.chatIds.length ? config.telegram.chatIds : ['(belum-dikonfigurasi)'];
  for (const chat of chats) outbox.telegramTemplate('digest_team', chat, vars, { related: `digest-${p.date}` });
  audit(AGENT, 'ringkasan_harian', vars);
  return true;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------
async function tick() {
  status.lastTick = new Date().toISOString();
  try { await outbox.processDue(); } catch (e) { console.error('[operasional] outbox', e); }
  try { checkSla(); } catch (e) { console.error('[operasional] SLA', e); }
  try { remindInvited(); } catch (e) { console.error('[operasional] pengingat', e); }
  try { dailyDigest(); } catch (e) { console.error('[operasional] ringkasan', e); }
}

function start() {
  if (status.running) return;
  status.running = true;
  const t1 = setInterval(tick, 60e3);
  t1.unref?.();
  if (config.imap.enabled) {
    const t2 = setInterval(pollMailbox, Math.max(config.imap.pollSeconds, 20) * 1000);
    t2.unref?.();
    setTimeout(pollMailbox, 3000);
  }
  setTimeout(tick, 2000);
  console.log(`[operasional] berjalan — IMAP ${config.imap.enabled ? `aktif (${config.imap.user}, tiap ${config.imap.pollSeconds} dtk)` : 'nonaktif'}`);
}

module.exports = { AGENT, start, tick, pollMailbox, checkSla, remindInvited, dailyDigest, stats, status };
