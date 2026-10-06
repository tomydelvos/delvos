'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.uploadDir, { recursive: true });

const db = new DatabaseSync(process.env.DB_PATH || path.join(config.dataDir, 'kantor.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS settings_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  version INTEGER NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_settings_history_key ON settings_history(key, version);

-- Emails received from prospective / existing clients.
CREATE TABLE IF NOT EXISTS inquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ref TEXT UNIQUE NOT NULL,
  message_id TEXT UNIQUE,
  from_email TEXT NOT NULL,
  from_name TEXT,
  subject TEXT,
  body_text TEXT,
  attachments TEXT NOT NULL DEFAULT '[]',
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  kind TEXT NOT NULL DEFAULT 'new',          -- new | follow_up
  status TEXT NOT NULL DEFAULT 'new',        -- new | invited | registered | spam | ignored | replied
  spam_score INTEGER NOT NULL DEFAULT 0,
  security_flags TEXT NOT NULL DEFAULT '[]',
  ai TEXT,                                   -- JSON from the AI triage (optional)
  invite_token TEXT UNIQUE,
  autoreply_sent_at TEXT,
  reminder_sent_at TEXT,
  submission_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_inquiries_from ON inquiries(from_email);

-- Registration form submissions.
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reg_no TEXT UNIQUE NOT NULL,
  inquiry_id INTEGER REFERENCES inquiries(id),
  form_version INTEGER NOT NULL,
  data TEXT NOT NULL,
  files TEXT NOT NULL DEFAULT '[]',
  client_name TEXT,
  client_email TEXT,
  client_phone TEXT,
  matter_type TEXT,
  urgency TEXT,
  opposing_party TEXT,
  status TEXT NOT NULL DEFAULT 'baru',
  assigned_to TEXT,
  conflict_hits TEXT NOT NULL DEFAULT '[]',
  security_flags TEXT NOT NULL DEFAULT '[]',
  ai TEXT,
  ip TEXT,
  status_token TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  first_reviewed_at TEXT,
  sla_reminded_at TEXT,
  sla_escalated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_submissions_email ON submissions(client_email);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);

CREATE TABLE IF NOT EXISTS submission_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                        -- created | status | note | email | conflict
  actor TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Known parties for the conflict-of-interest check.
CREATE TABLE IF NOT EXISTS parties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  normalized TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'klien',        -- klien | lawan | terkait
  matter_ref TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Outbox: every outgoing email / WhatsApp / Telegram message, retried by the operational agent.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,                     -- email | whatsapp | telegram
  recipient TEXT NOT NULL,
  subject TEXT,
  body TEXT NOT NULL,
  html TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',    -- pending | sent | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  related TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,                       -- administratif | operasional | keamanan | admin:<user>
  action TEXT NOT NULL,
  detail TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

const json = {
  parse(text, fallback = null) {
    if (text == null) return fallback;
    try { return JSON.parse(text); } catch { return fallback; }
  },
  str: (v) => JSON.stringify(v ?? null),
};

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Atomic per-year sequence, e.g. nextSeq('REG-2026') -> 1, 2, 3 ... */
function nextSeq(name) {
  const row = db.prepare(
    'INSERT INTO counters(name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value'
  ).get(name);
  return row.value;
}

function audit(agent, action, detail, ip) {
  db.prepare('INSERT INTO audit_log(agent, action, detail, ip) VALUES (?, ?, ?, ?)')
    .run(agent, action, typeof detail === 'string' ? detail : json.str(detail), ip || null);
}

const kv = {
  get: (key) => db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value ?? null,
  set: (key, value) => db.prepare('INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value)),
};

module.exports = { db, json, tx, nextSeq, audit, kv };
