'use strict';
// Central configuration. Secrets live in .env (never in the database);
// everything office-facing (name, hours, templates, form) is editable from the admin panel.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = (key, fallback = '') => {
  const v = (process.env[key] ?? '').toString().trim();
  return v === '' ? String(fallback) : v; // empty entries in .env fall back to the default
};
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

// EMAIL_PROVIDER=gmail fills in Gmail / Google Workspace hosts; GMAIL_USER + GMAIL_APP_PASSWORD cover both SMTP and IMAP.
const gmail = env('EMAIL_PROVIDER').toLowerCase() === 'gmail';
const mailUser = env('GMAIL_USER');
const mailPass = env('GMAIL_APP_PASSWORD').replace(/\s+/g, '');

const config = {
  root: ROOT,
  port: int('PORT', 3000),
  publicUrl: env('PUBLIC_URL', `http://localhost:${int('PORT', 3000)}`).replace(/\/+$/, ''),
  isProduction: env('NODE_ENV') === 'production',
  // development | staging | production. Staging only delivers to allow-listed recipients.
  appEnv: env('APP_ENV', env('NODE_ENV') === 'production' ? 'production' : 'development'),
  stagingAllow: list('STAGING_ALLOWED_RECIPIENTS'),
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
    host: env('SMTP_HOST', gmail ? 'smtp.gmail.com' : ''),
    port: int('SMTP_PORT', 465),
    secure: bool('SMTP_SECURE', true),
    user: env('SMTP_USER', mailUser),
    pass: env('SMTP_PASS', mailPass),
    from: env('MAIL_FROM'),
  },

  imap: {
    host: env('IMAP_HOST', gmail ? 'imap.gmail.com' : ''),
    port: int('IMAP_PORT', 993),
    secure: bool('IMAP_SECURE', true),
    user: env('IMAP_USER', mailUser),
    pass: env('IMAP_PASS', mailPass),
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
    // Business-initiated messages need an approved template; free text only inside the 24h window
    // that opens when the recipient messages the business number.
    metaMode: env('WA_META_MODE', 'auto'), // auto | template | text
    metaTemplateName: env('WA_META_TEMPLATE_NAME', 'notifikasi_kantor'),
    metaTemplateLang: env('WA_META_TEMPLATE_LANG', 'id'),
    metaAppSecret: env('WA_META_APP_SECRET'),
    metaVerifyToken: env('WA_META_VERIFY_TOKEN'),
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

// A channel counts as configured only when its credentials are present (an empty .env copy stays in simulation).
config.smtp.enabled = Boolean(config.smtp.host && (!config.smtp.user || config.smtp.pass));
config.imap.enabled = Boolean(config.imap.host && config.imap.user && config.imap.pass);
config.ai.enabled = config.ai.enabled && Boolean(env('ANTHROPIC_API_KEY') || env('ANTHROPIC_AUTH_TOKEN'));
config.telegram.enabled = Boolean(config.telegram.botToken && config.telegram.chatIds.length);
config.uploadDir = path.join(config.dataDir, 'uploads');
config.isStaging = config.appEnv === 'staging';

module.exports = config;
