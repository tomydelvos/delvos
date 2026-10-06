'use strict';
const crypto = require('node:crypto');
const config = require('../config');
const { db, kv, audit } = require('../db');
const security = require('../agents/security');
const users = require('../users');

const COOKIE = 'kh_admin';

function secret() {
  if (config.admin.sessionSecret) return config.admin.sessionSecret;
  let s = kv.get('session_secret');
  if (!s) { s = crypto.randomBytes(32).toString('base64url'); kv.set('session_secret', s); }
  return s;
}

const sign = (data) => crypto.createHmac('sha256', secret()).update(data).digest('base64url');

/** Cookie carries user id + session version; bumping the version (password change, deactivation) logs the user out everywhere. */
function issue(res, user) {
  const payload = Buffer.from(JSON.stringify({ uid: user.id, sv: user.session_version, exp: Date.now() + config.admin.sessionHours * 3600e3 })).toString('base64url');
  res.cookie(COOKIE, `${payload}.${sign(payload)}`, {
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
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
  if (!(data.exp > Date.now())) return null;
  const user = users.byId(data.uid);
  if (!user || !user.active || user.session_version !== data.sv) return null;
  return user;
}

const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name, role: u.role, mustChangePassword: Boolean(u.must_change_password) });

function login(req, res) {
  const { username, password } = req.body || {};
  const ipOk = security.rateLimit(`login:${req.ip}`, 5, 15 * 60e3);
  const userOk = security.rateLimit(`login-user:${String(username).toLowerCase()}`, 10, 15 * 60e3);
  if (!ipOk || !userOk) {
    audit(security.AGENT, 'login_diblokir', { username }, req.ip);
    return res.status(429).json({ error: 'Terlalu banyak percobaan masuk. Coba lagi dalam 15 menit.' });
  }
  const user = users.byUsername(username);
  // Always run the hash check so response time doesn't reveal whether the username exists.
  const ok = security.verifyPassword(String(password || ''), user?.password_hash || 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAA') && user?.active;
  audit(security.AGENT, ok ? 'login_berhasil' : 'login_gagal', { username }, req.ip);
  if (!ok) return res.status(401).json({ error: 'Username atau kata sandi salah.' });
  db.prepare(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`).run(user.id);
  issue(res, user);
  res.json({ ok: true, user: publicUser(user) });
}

function logout(req, res) {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
}

/**
 * Admin API guard: valid session + CSRF header (cookie is SameSite=Strict as a second layer).
 * Users with a temporary password may only change it.
 */
function requireUser(req, res, next) {
  const user = readSession(req);
  if (!user) return res.status(401).json({ error: 'Sesi berakhir. Silakan masuk kembali.' });
  if (req.method !== 'GET' && req.get('X-Requested-With') !== 'fetch') {
    return res.status(403).json({ error: 'Permintaan ditolak (CSRF).' });
  }
  if (user.must_change_password && !['/me', '/password', '/logout'].includes(req.path)) {
    return res.status(403).json({ error: 'Silakan ganti kata sandi sementara Anda terlebih dahulu.', mustChangePassword: true });
  }
  req.user = user;
  req.admin = user.username; // used in audit entries
  next();
}

const requireRole = (role) => (req, res, next) => {
  if (req.user?.role === role) return next();
  audit(security.AGENT, 'akses_ditolak', { username: req.user?.username, path: req.path }, req.ip);
  res.status(403).json({ error: 'Hanya admin yang dapat melakukan tindakan ini.' });
};

/** Re-issue the cookie after the user's own password change (their session version was bumped). */
function changePassword(req, res, current, next) {
  const updated = users.changeOwnPassword(req.user.id, current, next);
  issue(res, updated);
  return updated;
}

module.exports = { login, logout, requireUser, requireRole, readSession, changePassword, publicUser };
