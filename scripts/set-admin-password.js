'use strict';
// Usage: npm run set-password -- "kata-sandi-baru-yang-panjang"
const { kv } = require('../src/db');
const { hashPassword } = require('../src/agents/security');

const pw = process.argv[2];
if (!pw || pw.length < 10) {
  console.error('Gunakan: npm run set-password -- "kata-sandi-minimal-10-karakter"');
  process.exit(1);
}
kv.set('admin_password_hash', hashPassword(pw));
console.log('Kata sandi admin berhasil diperbarui.');
