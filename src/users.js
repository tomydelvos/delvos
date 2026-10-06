'use strict';
// Staff accounts. Roles:
//   admin — everything, including users, form/chatbot/template/office settings, audit log, test tools
//   staf  — day-to-day intake work: email inbox, registrations (status, notes, assignment), party list
const crypto = require('node:crypto');
const config = require('./config');
const { db, kv, audit } = require('./db');
const security = require('./agents/security');
const { normalizePhone } = require('./channels/whatsapp');

const ROLES = { admin: 'Admin', staf: 'Staf' };
const USERNAME_RE = /^[a-z0-9._-]{3,32}$/i;
const httpError = (status, message) => Object.assign(new Error(message), { status });

const PUBLIC_COLS = 'id, username, name, email, whatsapp, role, must_change_password, notify_email, notify_whatsapp, active, created_at, last_login_at';

function list() {
  return db.prepare(`SELECT ${PUBLIC_COLS} FROM users ORDER BY active DESC, name`).all();
}

const byId = (id) => db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
const byUsername = (u) => db.prepare(`SELECT * FROM users WHERE username = ?`).get(String(u || ''));

const tempPassword = () => `${crypto.randomBytes(6).toString('base64url')}-${crypto.randomBytes(4).toString('hex')}`;

/**
 * First start (or upgrade from the single-admin version): create the initial admin from
 * ADMIN_USERNAME and the existing password (panel/CLI hash, .env hash, .env plain), or a generated one.
 */
function ensureInitialAdmin() {
  if (db.prepare('SELECT COUNT(*) n FROM users').get().n > 0) return;
  let hash = kv.get('admin_password_hash') || config.admin.passwordHash;
  let generated = null;
  if (!hash && config.admin.password) hash = security.hashPassword(config.admin.password);
  if (!hash) { generated = tempPassword(); hash = security.hashPassword(generated); }
  if (!hash.startsWith('scrypt$')) hash = security.hashPassword(hash); // plain value stored by older setups
  db.prepare(`INSERT INTO users(username, name, role, password_hash, must_change_password, notify_email) VALUES (?, ?, 'admin', ?, ?, 0)`)
    .run(config.admin.username, 'Administrator', hash, generated ? 1 : 0);
  if (generated) {
    console.log('\n================================================================');
    console.log(' Akun admin awal dibuat (wajib ganti kata sandi saat login pertama):');
    console.log(`   username: ${config.admin.username}`);
    console.log(`   password: ${generated}`);
    console.log('================================================================\n');
  }
}

function validateFields(input, { creating }) {
  const out = {};
  if (creating || input.username !== undefined) {
    const u = String(input.username || '').trim();
    if (!USERNAME_RE.test(u)) throw httpError(400, 'Username 3–32 karakter: huruf, angka, titik, garis bawah, atau tanda hubung.');
    out.username = u;
  }
  if (creating || input.name !== undefined) {
    out.name = security.clean(input.name, 100);
    if (!out.name) throw httpError(400, 'Nama wajib diisi.');
  }
  if (input.email !== undefined) {
    out.email = security.clean(input.email, 200).toLowerCase() || null;
    if (out.email && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(out.email)) throw httpError(400, 'Format email tidak valid.');
  }
  if (input.whatsapp !== undefined) {
    out.whatsapp = security.clean(input.whatsapp, 30) || null;
    if (out.whatsapp && !/^\+?\d[\d\s-]{7,18}$/.test(out.whatsapp)) throw httpError(400, 'Nomor WhatsApp tidak valid.');
  }
  if (input.role !== undefined) {
    if (!ROLES[input.role]) throw httpError(400, 'Peran tidak dikenal.');
    out.role = input.role;
  }
  for (const k of ['notify_email', 'notify_whatsapp', 'active']) if (input[k] !== undefined) out[k] = input[k] ? 1 : 0;
  return out;
}

function activeAdmins(excludeId) {
  return db.prepare(`SELECT COUNT(*) n FROM users WHERE role = 'admin' AND active = 1 AND id != ?`).get(excludeId ?? -1).n;
}

/** Returns { user, tempPassword } — the temporary password is shown once to the creating admin. */
function create(input, actor) {
  const f = validateFields(input, { creating: true });
  if (byUsername(f.username)) throw httpError(400, 'Username sudah dipakai.');
  const pw = tempPassword();
  const row = db.prepare(`INSERT INTO users(username, name, email, whatsapp, role, password_hash, must_change_password, notify_email, notify_whatsapp)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?) RETURNING id`).get(
    f.username, f.name, f.email ?? null, f.whatsapp ?? null, f.role || 'staf', security.hashPassword(pw), f.notify_email ?? 1, f.notify_whatsapp ?? 0,
  );
  audit(`admin:${actor}`, 'tambah_pengguna', { username: f.username, role: f.role || 'staf' });
  return { user: db.prepare(`SELECT ${PUBLIC_COLS} FROM users WHERE id = ?`).get(row.id), tempPassword: pw };
}

function update(id, input, actor) {
  const user = byId(id);
  if (!user) throw httpError(404, 'Pengguna tidak ditemukan.');
  const f = validateFields(input, { creating: false });
  delete f.username; // usernames are permanent (they appear in the audit trail)
  const losingAdmin = (f.role && f.role !== 'admin') || f.active === 0;
  if (user.role === 'admin' && user.active && losingAdmin && activeAdmins(user.id) === 0) {
    throw httpError(400, 'Harus ada minimal satu admin aktif.');
  }
  const keys = Object.keys(f);
  if (!keys.length) return db.prepare(`SELECT ${PUBLIC_COLS} FROM users WHERE id = ?`).get(id);
  // Role or activation changes end the user's current sessions.
  const bump = (f.role !== undefined && f.role !== user.role) || f.active === 0 ? ', session_version = session_version + 1' : '';
  db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')}${bump} WHERE id = ?`).run(...keys.map((k) => f[k]), id);
  audit(`admin:${actor}`, 'ubah_pengguna', { username: user.username, changes: keys });
  return db.prepare(`SELECT ${PUBLIC_COLS} FROM users WHERE id = ?`).get(id);
}

function resetPassword(id, actor) {
  const user = byId(id);
  if (!user) throw httpError(404, 'Pengguna tidak ditemukan.');
  const pw = tempPassword();
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, session_version = session_version + 1 WHERE id = ?')
    .run(security.hashPassword(pw), id);
  audit(`admin:${actor}`, 'reset_password', { username: user.username });
  return pw;
}

function setPassword(id, password) {
  if (String(password || '').length < 10) throw httpError(400, 'Kata sandi baru minimal 10 karakter.');
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, session_version = session_version + 1 WHERE id = ?')
    .run(security.hashPassword(String(password)), id);
}

function changeOwnPassword(id, current, next) {
  const user = byId(id);
  if (!user || !security.verifyPassword(String(current || ''), user.password_hash)) throw httpError(400, 'Kata sandi saat ini salah.');
  if (String(next) === String(current)) throw httpError(400, 'Kata sandi baru harus berbeda.');
  setPassword(id, next);
  return byId(id);
}

/** Team alert recipients: .env lists plus active users who opted in. */
function teamRecipients() {
  const users = db.prepare('SELECT email, whatsapp, notify_email, notify_whatsapp FROM users WHERE active = 1').all();
  const emails = new Set(config.team.emails.map((e) => e.toLowerCase()));
  const phones = new Set(config.team.whatsapp.map((p) => normalizePhone(p) || p));
  for (const u of users) {
    if (u.notify_email && u.email) emails.add(u.email.toLowerCase());
    if (u.notify_whatsapp && u.whatsapp) phones.add(normalizePhone(u.whatsapp) || u.whatsapp);
  }
  return { emails: [...emails], whatsapp: [...phones] };
}

module.exports = { ROLES, list, byId, byUsername, ensureInitialAdmin, create, update, resetPassword, setPassword, changeOwnPassword, teamRecipients, tempPassword };
