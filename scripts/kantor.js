'use strict';
// Read-only CLI used by the Claude Code subagents (and staff) to inspect the virtual office.
// Usage: node scripts/kantor.js <command> [arg]
//   stats                 ringkasan angka
//   pending               registrasi yang belum ditinjau (status baru)
//   submission <REG-NO>   detail satu registrasi
//   inquiries [n]         email masuk terbaru
//   failed                notifikasi yang gagal terkirim
//   audit [n]             log audit terbaru
//   security [jam]        kejadian keamanan (login gagal, bot, rate limit, spam)
//   conflict "<nama>"     cek nama terhadap daftar pihak & registrasi
process.removeAllListeners('warning'); // hide the node:sqlite ExperimentalWarning in CLI output
const { db, json } = require('../src/db');
const security = require('../src/agents/security');
const admin = require('../src/agents/administrative');
const { stats } = require('../src/agents/operational');

const [cmd, arg] = process.argv.slice(2);
const out = (x) => console.log(JSON.stringify(x, null, 2));

switch (cmd) {
  case 'stats': out(stats()); break;
  case 'pending':
    out(db.prepare(`SELECT reg_no, client_name, matter_type, urgency, created_at, sla_reminded_at, conflict_hits FROM submissions WHERE status = 'baru' ORDER BY created_at`).all()
      .map((r) => ({ ...r, conflict_hits: json.parse(r.conflict_hits, []).length })));
    break;
  case 'submission': {
    const row = db.prepare('SELECT id FROM submissions WHERE reg_no = ?').get(String(arg || '').toUpperCase());
    if (!row) { console.error('Tidak ditemukan'); process.exit(1); }
    const s = admin.loadSubmission(row.id);
    const settings = require('../src/settings');
    const form = settings.getVersion('form', s.form_version) || settings.get('form');
    out({ reg_no: s.reg_no, status: admin.STATUSES[s.status], created_at: s.created_at, answers: admin.answersFor(form, s.data, s.files).map((a) => `${a.label}: ${a.value}`), conflicts: s.conflict_hits, ai: s.ai,
      events: db.prepare('SELECT type, actor, payload, created_at FROM submission_events WHERE submission_id = ? ORDER BY id').all(s.id) });
    break;
  }
  case 'inquiries':
    out(db.prepare('SELECT ref, from_email, subject, status, kind, spam_score, received_at FROM inquiries ORDER BY id DESC LIMIT ?').all(Number(arg) || 20));
    break;
  case 'failed':
    out(db.prepare(`SELECT id, channel, recipient, subject, attempts, last_error, created_at FROM notifications WHERE status = 'failed' ORDER BY id DESC LIMIT 50`).all());
    break;
  case 'audit':
    out(db.prepare('SELECT agent, action, detail, ip, created_at FROM audit_log ORDER BY id DESC LIMIT ?').all(Number(arg) || 50));
    break;
  case 'security':
    out({
      events: db.prepare(`SELECT action, COUNT(*) n, COUNT(DISTINCT ip) ips FROM audit_log WHERE action IN ('login_gagal','login_diblokir','bot_ditolak','rate_limit') AND created_at >= datetime('now', ?) GROUP BY action`).all(`-${Number(arg) || 24} hours`),
      spam: db.prepare(`SELECT ref, from_email, subject, spam_score, security_flags FROM inquiries WHERE spam_score >= 30 AND received_at >= datetime('now', ?) ORDER BY spam_score DESC`).all(`-${Number(arg) || 24} hours`),
    });
    break;
  case 'conflict':
    out(security.conflictCheck({ clientName: '', opposingParty: arg || '' }));
    break;
  default:
    console.log('Perintah: stats | pending | submission <REG> | inquiries [n] | failed | audit [n] | security [jam] | conflict "<nama>"');
}
