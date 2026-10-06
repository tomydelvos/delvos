'use strict';
// Central configuration. Secrets live in .env (never in the database);
// everything office-facing (name, hours, templates, form) is editable from the admin panel.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = (key, fallback = '') => (process.env[key] ?? fallback).toString().trim();
const list = (key) => env(key).split(',').map((s) => s.trim()).filter(Boolean);
const int = (key, fallback) => {
  const n = parseInt(env(key), 10);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (key, fallback = false) => {
  const v = env(key).toLowerCase();
  if (!v) return fallback;
  return ['1', 'true', 'yes', 'ya', 'on'].includes(v);
};

const config = {
  root: ROOT,
  port: int('PORT', 3000),
  publicUrl: env('PUBLIC_URL', `http://localhost:${int('PORT', 3000)}`).replace(/\/+$/, ''),
  isProduction: env('NODE_ENV') === 'production',
  dataDir: path.resolve(ROOT, env('DATA_DIR', 'data')),
  timezone: env('TZ_OFFICE', 'Asia/Jakarta'),

  admin: {
    username: env('ADMIN_USERNAME', 'admin'),
    // Either a scrypt hash produced by `npm run set-password` or a plain password (dev only).
    passwordHash: env('ADMIN_PASSWORD_HASH'),
    password: env('ADMIN_PASSWORD'),
    sessionSecret: env('SESSION_SECRET'),
    sessionHours: int('SESSION_HOURS', 12),
  },

  smtp: {
    host: env('SMTP_HOST'),
    port: int('SMTP_PORT', 465),
    secure: bool('SMTP_SECURE', true),
    user: env('SMTP_USER'),
    pass: env('SMTP_PASS'),
    from: env('MAIL_FROM'),
  },

  imap: {
    host: env('IMAP_HOST'),
    port: int('IMAP_PORT', 993),
    secure: bool('IMAP_SECURE', true),
    user: env('IMAP_USER'),
    pass: env('IMAP_PASS'),
    mailbox: env('IMAP_MAILBOX', 'INBOX'),
    pollSeconds: int('IMAP_POLL_SECONDS', 60),
  },

  // Team recipients for internal notifications.
  team: {
    emails: list('TEAM_EMAILS'),
    whatsapp: list('TEAM_WHATSAPP'),
  },

  whatsapp: {
    provider: env('WA_PROVIDER', 'log'), // log | fonnte | meta
    fonnteToken: env('FONNTE_TOKEN'),
    metaToken: env('WA_META_TOKEN'),
    metaPhoneNumberId: env('WA_META_PHONE_NUMBER_ID'),
    metaApiVersion: env('WA_META_API_VERSION', 'v21.0'),
    notifyClient: bool('WA_NOTIFY_CLIENT', true),
  },

  telegram: {
    botToken: env('TELEGRAM_BOT_TOKEN'),
    chatIds: list('TELEGRAM_CHAT_IDS'),
  },

  ai: {
    enabled: bool('AI_ENABLED', false),
    model: env('AI_MODEL', 'claude-opus-5-5'),
  },

  security: {
    maxUploadMb: int('MAX_UPLOAD_MB', 10),
    maxFiles: int('MAX_UPLOAD_FILES', 5),
    spamThreshold: int('SPAM_THRESHOLD', 60),
    autoReplyPerSenderPerDay: int('AUTOREPLY_PER_SENDER_PER_DAY', 2),
    trustProxy: bool('TRUST_PROXY', false),
    submitPer10Min: int('SUBMIT_RATE_LIMIT', 6),
  },
};

config.smtp.enabled = Boolean(config.smtp.host);
config.imap.enabled = Boolean(config.imap.host && config.imap.user);
config.telegram.enabled = Boolean(config.telegram.botToken && config.telegram.chatIds.length);
config.uploadDir = path.join(config.dataDir, 'uploads');

module.exports = config;
