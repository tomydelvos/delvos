'use strict';
// Usage: npm run set-password -- <username> "kata-sandi-baru-yang-panjang"
//        npm run set-password -- "kata-sandi-baru"          (untuk ADMIN_USERNAME)
// Membuat akun admin bila username belum ada.
process.removeAllListeners('warning');
const config = require('../src/config');
const { db } = require('../src/db');
const users = require('../src/users');
const { hashPassword } = require('../src/agents/security');

const args = process.argv.slice(2);
const [username, pw] = args.length >= 2 ? args : [config.admin.username, args[0]];
if (!pw || pw.length < 10) {
  console.error('Gunakan: npm run set-password -- <username> "kata-sandi-minimal-10-karakter"');
  process.exit(1);
}
const user = users.byUsername(username);
if (user) {
  users.setPassword(user.id, pw);
  console.log(`Kata sandi untuk "${user.username}" diperbarui.`);
} else {
  db.prepare(`INSERT INTO users(username, name, role, password_hash, notify_email) VALUES (?, ?, 'admin', ?, 0)`).run(username, username, hashPassword(pw));
  console.log(`Akun admin "${username}" dibuat.`);
}
