'use strict';
const crypto = require('node:crypto');
const config = require('../config');
const { kv, audit } = require('../db');
const security = require('../agents/security');

const COOKIE = 'kh_admin';

function secret() {
  if (config.admin.sessionSecret) return config.admin.sessionSecret;
  let s = kv.get('session_secret');
  if (!s) { s = crypto.randomBytes(32).toString('base64url'); kv.set('session_secret', s); }
  return s;
}

/** Resolve the admin password: panel-set hash > .env hash > .env plain > generated on first run. */
function passwordHash() {
  const stored = kv.get('admin_password_hash');
  if (stored) return stored;
  if (config.admin.passwordHash) return config.admin.passwordHash;
  if (config.admin.password) return config.admin.password;
  const generated = crypto.randomBytes(9).toString('base64url');
  kv.set('admin_password_hash', security.hashPassword(generated));
  console.log('\n================================================================');
  console.log(' Kata sandi admin awal dibuat otomatis (simpan & segera ganti):');
  console.log(`   username: ${config.admin.username}`);
  console.log(`   password: ${generated}`);
  console.log('================================================================\n');
  return kv.get('admin_password_hash');
}

const sign = (data) => crypto.createHmac('sha256', secret()).update(data).digest('base64url');

function issue(res, username) {
  const payload = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + config.admin.sessionHours * 3600e3 })).toString('base64url');
  const value = `${payload}.${sign(payload)}`;
  res.cookie(COOKIE, value, {
    httpOnly: true, sameSite: 'strict', secure: config.isProduction, path: '/', maxAge: config.admin.sessionHours * 3600e3,
  });
}

function readSession(req) {
  const raw = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return null;
  const [payload, sig] = decodeURIComponent(raw.slice(COOKIE.length + 1)).split('.');
  if (!payload || !sig) return null;
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() ? data : null;
  } catch { return null; }
}

function login(req, res) {
  const { username, password } = req.body || {};
  const ipOk = security.rateLimit(`login:${req.ip}`, 5, 15 * 60e3);
  const userOk = security.rateLimit(`login-user:${String(username).toLowerCase()}`, 10, 15 * 60e3);
  if (!ipOk || !userOk) {
    audit(security.AGENT, 'login_diblokir', { username }, req.ip);
    return res.status(429).json({ error: 'Terlalu banyak percobaan masuk. Coba lagi dalam 15 menit.' });
  }
  const ok = username === config.admin.username && security.verifyPassword(String(password || ''), passwordHash());
  audit(security.AGENT, ok ? 'login_berhasil' : 'login_gagal', { username }, req.ip);
  if (!ok) return res.status(401).json({ error: 'Username atau kata sandi salah.' });
  issue(res, username);
  res.json({ ok: true, username });
}

function logout(req, res) {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
}

/** Admin API guard: valid session + CSRF header (cookie is SameSite=Strict as a second layer). */
function requireAdmin(req, res, next) {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: 'Sesi berakhir. Silakan masuk kembali.' });
  if (req.method !== 'GET' && req.get('X-Requested-With') !== 'fetch') {
    return res.status(403).json({ error: 'Permintaan ditolak (CSRF).' });
  }
  req.admin = session.u;
  next();
}

function changePassword(current, next) {
  if (!security.verifyPassword(String(current || ''), passwordHash())) throw Object.assign(new Error('Kata sandi saat ini salah.'), { status: 400 });
  if (String(next || '').length < 10) throw Object.assign(new Error('Kata sandi baru minimal 10 karakter.'), { status: 400 });
  kv.set('admin_password_hash', security.hashPassword(String(next)));
}

module.exports = { login, logout, requireAdmin, readSession, changePassword, passwordHash };
