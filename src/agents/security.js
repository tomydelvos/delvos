'use strict';
// AGEN KEAMANAN (Security agent)
// - Screens inbound email (spoofing, phishing, dangerous attachments, auto-generated mail / loops)
// - Validates & sanitises everything a visitor submits (schema validation, honeypot, timing, uploads)
// - Rate-limits public endpoints and admin login
// - Runs the conflict-of-interest check against known parties and previous registrations
// - Writes the audit trail
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { db, json, audit } = require('../db');

const AGENT = 'keamanan';

// ---------------------------------------------------------------------------
// Rate limiting (in-memory sliding window; enough for a single office server)
// ---------------------------------------------------------------------------
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  buckets.set(key, hits);
  return hits.length <= max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (!v.some((t) => now - t < 3600e3)) buckets.delete(k);
}, 600e3).unref();

function limiter(name, max, windowMs) {
  return (req, res, next) => {
    if (rateLimit(`${name}:${req.ip}`, max, windowMs)) return next();
    audit(AGENT, 'rate_limit', { name, path: req.path }, req.ip);
    res.status(429).json({ error: 'Terlalu banyak permintaan. Mohon coba lagi beberapa saat lagi.' });
  };
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (config.isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

// ---------------------------------------------------------------------------
// Inbound email screening
// ---------------------------------------------------------------------------
const DANGEROUS_EXT = /\.(exe|scr|bat|cmd|com|pif|js|jse|vbs|vbe|wsf|wsh|ps1|msi|jar|lnk|hta|iso|img|docm|xlsm|pptm|apk)$/i;
const PHISHING_PATTERNS = [
  /verify your (account|password)/i, /verifikasi (akun|kata sandi)/i, /password (expired|kedaluwarsa)/i,
  /click (here|below) to (login|unlock)/i, /bitcoin|crypto wallet|gift card/i, /(transfer|kirim) dana segera/i,
  /hadiah|undian|menang(kan)? (hadiah|undian)/i, /inheritance fund|dana warisan.*juta dolar/i,
];
const AUTOMATED_SENDER = /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce|notifications?)@/i;

/**
 * @param {import('mailparser').ParsedMail | object} mail normalised: {fromEmail, fromName, subject, text, headers(Map|obj), attachments[]}
 * @returns {{score:number, flags:string[], automated:boolean, verdict:'ok'|'suspicious'|'spam'}}
 */
function screenEmail(mail) {
  const flags = [];
  let score = 0;
  const header = (name) => {
    const h = mail.headers;
    const v = h?.get ? h.get(name) : h?.[name];
    return v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  };

  // Loop / bulk / auto-generated mail must never receive an auto-reply.
  const autoSubmitted = header('auto-submitted').toLowerCase();
  const precedence = header('precedence').toLowerCase();
  const automated = AUTOMATED_SENDER.test(mail.fromEmail || '')
    || (autoSubmitted && autoSubmitted !== 'no')
    || ['bulk', 'junk', 'list', 'auto_reply'].includes(precedence)
    || Boolean(header('list-unsubscribe') || header('list-id') || header('x-autoreply') || header('x-autorespond'));
  if (automated) flags.push('Email otomatis / massal (tidak dibalas otomatis)');

  const auth = header('authentication-results').toLowerCase();
  if (/spf=(fail|softfail)/.test(auth)) { score += 25; flags.push('SPF gagal'); }
  if (/dkim=fail/.test(auth)) { score += 20; flags.push('DKIM gagal'); }
  if (/dmarc=fail/.test(auth)) { score += 30; flags.push('DMARC gagal (kemungkinan pemalsuan pengirim)'); }

  const officeDomain = (process.env.OFFICE_DOMAIN || '').toLowerCase();
  const fromDomain = String(mail.fromEmail || '').split('@')[1]?.toLowerCase() || '';
  if (officeDomain && fromDomain === officeDomain && /fail/.test(auth)) {
    score += 40; flags.push('Mengaku dari domain kantor tetapi gagal autentikasi');
  }
  const replyTo = header('reply-to').toLowerCase();
  if (replyTo && fromDomain && !replyTo.includes(fromDomain)) { score += 10; flags.push('Reply-To berbeda domain dengan pengirim'); }

  const text = `${mail.subject || ''}\n${mail.text || ''}`;
  for (const re of PHISHING_PATTERNS) if (re.test(text)) { score += 20; flags.push(`Pola phishing/spam: "${re.source.slice(0, 40)}"`); }
  const links = (text.match(/https?:\/\//g) || []).length;
  if (links > 8) { score += 15; flags.push(`Banyak tautan (${links})`); }
  if (/https?:\/\/(\d{1,3}\.){3}\d{1,3}/.test(text)) { score += 20; flags.push('Tautan ke alamat IP langsung'); }
  if (/bit\.ly|tinyurl|s\.id\/|cutt\.ly/i.test(text)) { score += 10; flags.push('Tautan disingkat'); }

  for (const a of mail.attachments || []) {
    const name = a.filename || '';
    if (DANGEROUS_EXT.test(name) || /\.(pdf|docx?|jpe?g|png)\.(exe|js|scr|bat)$/i.test(name)) {
      score += 50; flags.push(`Lampiran berbahaya: ${name}`);
    }
    if (/\.(zip|rar|7z)$/i.test(name)) { score += 10; flags.push(`Lampiran terkompresi: ${name} (periksa sebelum dibuka)`); }
  }
  if (!String(mail.text || '').trim() && !(mail.attachments || []).length) { score += 10; flags.push('Isi email kosong'); }

  score = Math.min(score, 100);
  const verdict = score >= config.security.spamThreshold ? 'spam' : score >= 30 ? 'suspicious' : 'ok';
  return { score, flags, automated, verdict };
}

/** Prevent auto-reply storms: at most N auto-replies per sender per 24h. */
function canAutoReply(email) {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM inquiries WHERE from_email = ? AND autoreply_sent_at >= datetime('now', '-1 day')`).get(email);
  return row.n < config.security.autoReplyPerSenderPerDay;
}

// ---------------------------------------------------------------------------
// Form submission validation
// ---------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i;
const clean = (v, max = 5000) => String(v ?? '')
  // strip control chars except newline/tab
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  .trim()
  .slice(0, max);

function isVisible(field, values) {
  if (!field.showIf) return true;
  const v = values[field.showIf.field];
  return Array.isArray(v) ? v.includes(field.showIf.equals) : v === field.showIf.equals;
}

/**
 * Validate raw body against the active form schema. Unknown keys are dropped.
 * @returns {{values:object, errors:object}}
 */
function validateSubmission(form, body, fileFieldsPresent = {}) {
  const values = {};
  const errors = {};
  const allFields = form.sections.flatMap((s) => s.fields);

  // First pass: collect raw values so showIf can be evaluated.
  for (const f of allFields) {
    if (f.type === 'info' || f.type === 'file') continue;
    let v = body[f.id];
    if (f.type === 'checkboxes') v = (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map((x) => clean(x, 200));
    else if (f.type === 'checkbox') v = v === true || v === 'true' || v === 'on' || v === '1';
    else v = clean(v, f.maxLength || (f.type === 'textarea' ? 5000 : 300));
    values[f.id] = v;
  }

  for (const f of allFields) {
    if (f.type === 'info') continue;
    if (!isVisible(f, values)) { delete values[f.id]; continue; }
    const v = values[f.id];
    const label = f.label;
    const empty = f.type === 'file' ? !fileFieldsPresent[f.id]
      : f.type === 'checkbox' ? v !== true
        : Array.isArray(v) ? v.length === 0 : !v;
    if (f.required && empty) { errors[f.id] = f.type === 'checkbox' ? 'Persetujuan ini wajib dicentang.' : `${label} wajib diisi.`; continue; }
    if (empty || f.type === 'file') continue;

    switch (f.type) {
      case 'email':
        if (!EMAIL_RE.test(v)) errors[f.id] = 'Format email tidak valid.';
        else values[f.id] = v.toLowerCase();
        break;
      case 'tel': {
        const digits = v.replace(/[^\d]/g, '');
        if (digits.length < 8 || digits.length > 15) errors[f.id] = 'Nomor telepon tidak valid.';
        break;
      }
      case 'number':
        if (!Number.isFinite(Number(v))) errors[f.id] = 'Harus berupa angka.';
        else values[f.id] = Number(v);
        break;
      case 'date':
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) errors[f.id] = 'Tanggal tidak valid.';
        break;
      case 'select':
      case 'radio':
        if (!f.options.includes(v)) errors[f.id] = 'Pilihan tidak valid.';
        break;
      case 'checkboxes':
        if (v.some((x) => !f.options.includes(x))) errors[f.id] = 'Pilihan tidak valid.';
        break;
      default:
        if (f.minLength && v.length < f.minLength) errors[f.id] = `Mohon isi minimal ${f.minLength} karakter.`;
    }
  }
  return { values, errors };
}

/** Bot heuristics: hidden honeypot field + "filled too fast" check. */
function botCheck(body) {
  const flags = [];
  if (body._hp) flags.push('honeypot');
  const started = Number(body._t);
  if (!started || Date.now() - started < 4000) flags.push('terlalu-cepat');
  if (started && Date.now() - started > 24 * 3600e3) flags.push('sesi-kedaluwarsa');
  return flags;
}

// ---------------------------------------------------------------------------
// Upload checks: extension allow-list + magic bytes; stored with random names, outside /public
// ---------------------------------------------------------------------------
const SIGNATURES = {
  pdf: { mime: 'application/pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  png: { mime: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  jpg: { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  jpeg: { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  // DOCX is a ZIP; require the Word part to be present to avoid arbitrary archives.
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', test: (b) => b[0] === 0x50 && b[1] === 0x4b && b.includes(Buffer.from('word/')) },
};

function checkUpload(file) {
  const original = path.basename(String(file.originalname || 'berkas')).replace(/[^\w.\- ()]/g, '_').slice(0, 120);
  const ext = original.split('.').pop().toLowerCase();
  const sig = SIGNATURES[ext];
  if (!sig) return { ok: false, reason: `Tipe berkas .${ext} tidak diizinkan.` };
  if (!sig.test(file.buffer)) return { ok: false, reason: `Isi berkas "${original}" tidak sesuai dengan ekstensinya.` };
  if (ext === 'pdf' && /\/JavaScript|\/JS\s|\/Launch|\/EmbeddedFile/.test(file.buffer.toString('latin1'))) {
    return { ok: false, reason: `PDF "${original}" mengandung skrip/aksi tertanam dan ditolak demi keamanan.` };
  }
  return { ok: true, original, ext, mime: sig.mime };
}

function storeUpload(file, checked) {
  const id = crypto.randomBytes(16).toString('hex');
  const stored = `${id}.${checked.ext}`;
  fs.writeFileSync(path.join(config.uploadDir, stored), file.buffer, { mode: 0o600 });
  const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
  return { id, stored, name: checked.original, mime: checked.mime, size: file.buffer.length, sha256 };
}

// ---------------------------------------------------------------------------
// Conflict-of-interest check
// ---------------------------------------------------------------------------
const LEGAL_NOISE = /\b(pt|cv|tbk|persero|ud|fa|yayasan|koperasi|perkumpulan|ltd|inc|llc|corp|co|bapak|ibu|bpk|sdr|sdri|tn|ny|dr|ir|sh|mh|se|mm|st)\b\.?/g;
function normalizeName(name) {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s]/g, ' ').replace(LEGAL_NOISE, ' ').replace(/\s+/g, ' ').trim();
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = new Set(a.split(' ').filter((t) => t.length > 1));
  const tb = new Set(b.split(' ').filter((t) => t.length > 1));
  if (!ta.size || !tb.size) return 0;
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const jaccard = inter / new Set([...ta, ...tb]).size;
  const contain = inter / Math.min(ta.size, tb.size);
  // Full containment of a multi-token name ("budi santoso" in "budi santoso wijaya") counts strongly.
  return Math.max(jaccard, Math.min(ta.size, tb.size) >= 2 ? contain * 0.9 : 0);
}

function splitNames(text) {
  return String(text || '').split(/[,;\n]| dan | & /i).map((s) => s.trim()).filter((s) => s.length > 2);
}

/**
 * Compare the prospective client and opposing parties against known parties and earlier registrations.
 * The most serious hit is when *our client/ex-client* appears as the *opposing party* now.
 */
function conflictCheck({ clientName, companyName, opposingParty, excludeSubmissionId = null }) {
  const hits = [];
  const opposing = splitNames(opposingParty).map((n) => ({ raw: n, norm: normalizeName(n) }));
  const selves = [clientName, companyName].filter(Boolean).map((n) => ({ raw: n, norm: normalizeName(n) }));

  const parties = db.prepare('SELECT id, name, normalized, role, matter_ref FROM parties').all();
  for (const p of parties) {
    for (const o of opposing) {
      const s = similarity(o.norm, p.normalized);
      if (s >= 0.6) {
        hits.push({
          severity: p.role === 'klien' ? 'tinggi' : 'sedang',
          reason: p.role === 'klien' ? 'Pihak lawan adalah klien/mantan klien kantor' : `Pihak lawan tercatat sebagai pihak "${p.role}"`,
          input: o.raw, match: p.name, matterRef: p.matter_ref, score: Number(s.toFixed(2)),
        });
      }
    }
    for (const c of selves) {
      const s = similarity(c.norm, p.normalized);
      if (s >= 0.6 && p.role === 'lawan') {
        hits.push({ severity: 'tinggi', reason: 'Calon klien tercatat sebagai pihak lawan dalam perkara kantor', input: c.raw, match: p.name, matterRef: p.matter_ref, score: Number(s.toFixed(2)) });
      }
    }
  }

  // Earlier registrations: someone who registered with us is now named as the opposing party (or vice versa).
  const subs = db.prepare(`SELECT id, reg_no, client_name, opposing_party, data FROM submissions WHERE (? IS NULL OR id != ?) ORDER BY id DESC LIMIT 2000`)
    .all(excludeSubmissionId, excludeSubmissionId);
  for (const sub of subs) {
    const subCompany = json.parse(sub.data, {}).company_name;
    const subSelves = [sub.client_name, subCompany].filter(Boolean).map(normalizeName);
    for (const o of opposing) {
      for (const ss of subSelves) {
        const s = similarity(o.norm, ss);
        if (s >= 0.7) hits.push({ severity: 'sedang', reason: `Pihak lawan pernah mendaftar sebagai calon klien (${sub.reg_no})`, input: o.raw, match: sub.client_name, matterRef: sub.reg_no, score: Number(s.toFixed(2)) });
      }
    }
    for (const c of selves) {
      for (const so of splitNames(sub.opposing_party).map(normalizeName)) {
        const s = similarity(c.norm, so);
        if (s >= 0.7) hits.push({ severity: 'sedang', reason: `Calon klien disebut sebagai pihak lawan pada registrasi ${sub.reg_no}`, input: c.raw, match: sub.client_name, matterRef: sub.reg_no, score: Number(s.toFixed(2)) });
      }
    }
  }
  const seen = new Set();
  return hits.filter((h) => {
    const k = `${h.input}|${h.match}|${h.matterRef}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => (a.severity === 'tinggi' ? -1 : 1) - (b.severity === 'tinggi' ? -1 : 1));
}

function conflictText(hits) {
  if (!hits.length) return 'Tidak ada indikasi benturan kepentingan';
  const high = hits.filter((h) => h.severity === 'tinggi').length;
  return `⚠ ${hits.length} indikasi (${high} tinggi) — perlu verifikasi`;
}

// ---------------------------------------------------------------------------
// Admin authentication helpers (scrypt password hashes, HMAC-signed session cookie)
// ---------------------------------------------------------------------------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  if (!stored.startsWith('scrypt$')) {
    // Plain password from .env (development only).
    const a = Buffer.from(String(password));
    const b = Buffer.from(stored);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const [, salt, hash] = stored.split('$');
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(actual, expected);
}

module.exports = {
  AGENT, rateLimit, limiter, securityHeaders,
  screenEmail, canAutoReply,
  validateSubmission, botCheck, isVisible, clean,
  checkUpload, storeUpload,
  normalizeName, similarity, conflictCheck, conflictText,
  hashPassword, verifyPassword,
};
