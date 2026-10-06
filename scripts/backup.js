'use strict';
// Consistent online backup of the database (VACUUM INTO) plus the uploads folder.
// Usage: node scripts/backup.js [target-dir]     (default: <DATA_DIR>/backups)
// In Docker:  docker compose -f docker-compose.staging.yml exec app node scripts/backup.js
process.removeAllListeners('warning');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../src/config');
const { db } = require('../src/db');

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dir = path.resolve(process.argv[2] || path.join(config.dataDir, 'backups'), stamp);
fs.mkdirSync(dir, { recursive: true });
db.exec(`VACUUM INTO '${path.join(dir, 'kantor.db').replace(/'/g, "''")}'`);
fs.cpSync(config.uploadDir, path.join(dir, 'uploads'), { recursive: true });

// Keep the 14 most recent backups in the default location.
const root = path.dirname(dir);
const old = fs.readdirSync(root).filter((d) => /^\d{4}-/.test(d)).sort().slice(0, -14);
for (const d of old) fs.rmSync(path.join(root, d), { recursive: true, force: true });
console.log(`Cadangan tersimpan: ${dir}`);
