'use strict';
// Admin-editable configuration (office profile, registration form, chatbot flow, message templates).
// Every save creates a new version; old versions stay in settings_history so each submission
// can always be displayed with the exact form it was filled in with, and admins can roll back.
const fs = require('node:fs');
const path = require('node:path');
const { db, json, tx } = require('./db');
const config = require('./config');

const KEYS = ['office', 'form', 'chatbot', 'templates'];
const defaultsDir = path.join(config.root, 'config', 'defaults');
const loadDefault = (key) => JSON.parse(fs.readFileSync(path.join(defaultsDir, `${key}.json`), 'utf8'));

const FIELD_TYPES = ['text', 'textarea', 'email', 'tel', 'number', 'date', 'select', 'radio', 'checkboxes', 'checkbox', 'file', 'info'];
const FIELD_ROLES = ['client_name', 'client_email', 'client_phone', 'matter_type', 'urgency', 'opposing_party', 'description'];
const ID_RE = /^[a-z][a-z0-9_]{0,49}$/;

class ValidationError extends Error {
  constructor(errors) {
    super(errors.join('; '));
    this.errors = errors;
    this.status = 400;
  }
}

function validateForm(form) {
  const errors = [];
  if (!form || typeof form !== 'object') throw new ValidationError(['Formulir harus berupa objek JSON.']);
  if (!form.title) errors.push('Judul formulir wajib diisi.');
  if (!Array.isArray(form.sections) || !form.sections.length) errors.push('Formulir minimal memiliki satu bagian.');
  const ids = new Set();
  const roles = new Map();
  for (const [si, s] of (form.sections || []).entries()) {
    if (!s.id || !ID_RE.test(s.id)) errors.push(`Bagian #${si + 1}: ID harus huruf kecil/angka/underscore.`);
    if (!s.title) errors.push(`Bagian #${si + 1}: judul wajib diisi.`);
    if (!Array.isArray(s.fields)) { errors.push(`Bagian "${s.title}": daftar field tidak valid.`); continue; }
    for (const f of s.fields) {
      const where = `Field "${f.label || f.id}"`;
      if (!f.id || !ID_RE.test(f.id)) errors.push(`${where}: ID harus diawali huruf, hanya huruf kecil/angka/underscore.`);
      if (ids.has(f.id)) errors.push(`${where}: ID "${f.id}" dipakai lebih dari sekali.`);
      ids.add(f.id);
      if (!FIELD_TYPES.includes(f.type)) errors.push(`${where}: tipe "${f.type}" tidak dikenal.`);
      if (!f.label) errors.push(`${where}: label wajib diisi.`);
      if (['select', 'radio', 'checkboxes'].includes(f.type) && (!Array.isArray(f.options) || !f.options.length)) {
        errors.push(`${where}: pilihan jawaban wajib diisi.`);
      }
      if (f.role) {
        if (!FIELD_ROLES.includes(f.role)) errors.push(`${where}: peran "${f.role}" tidak dikenal.`);
        else if (roles.has(f.role)) errors.push(`${where}: peran "${f.role}" sudah dipakai field "${roles.get(f.role)}".`);
        else roles.set(f.role, f.id);
      }
    }
  }
  for (const s of form.sections || []) {
    for (const f of s.fields || []) {
      if (f.showIf && !ids.has(f.showIf.field)) errors.push(`Field "${f.label}": kondisi tampil merujuk field "${f.showIf.field}" yang tidak ada.`);
    }
  }
  if (!roles.has('client_email')) errors.push('Wajib ada satu field dengan peran "client_email" (email klien) agar konfirmasi dapat dikirim.');
  if (!roles.has('client_name')) errors.push('Wajib ada satu field dengan peran "client_name" (nama klien).');
  if (errors.length) throw new ValidationError(errors);
}

function validateChatbot(flow) {
  const errors = [];
  if (!flow || typeof flow !== 'object' || !flow.nodes || typeof flow.nodes !== 'object') {
    throw new ValidationError(['Alur chatbot harus memiliki objek "nodes".']);
  }
  if (!flow.nodes[flow.start]) errors.push(`Node awal "${flow.start}" tidak ditemukan.`);
  const actions = ['open_form', 'check_status', 'whatsapp', 'link', 'restart'];
  for (const [id, node] of Object.entries(flow.nodes)) {
    if (!/^[a-z0-9_]{1,50}$/.test(id)) errors.push(`ID node "${id}" hanya boleh huruf kecil/angka/underscore.`);
    if (!Array.isArray(node.messages) || !node.messages.length) errors.push(`Node "${id}": minimal satu pesan.`);
    for (const o of node.options || []) {
      if (!o.label) errors.push(`Node "${id}": setiap pilihan wajib memiliki label.`);
      if (o.next && !flow.nodes[o.next]) errors.push(`Node "${id}": pilihan "${o.label}" menuju node "${o.next}" yang tidak ada.`);
      if (o.action && !actions.includes(o.action)) errors.push(`Node "${id}": aksi "${o.action}" tidak dikenal.`);
      if (!o.next && !o.action) errors.push(`Node "${id}": pilihan "${o.label}" harus memiliki tujuan (node) atau aksi.`);
      if (o.action === 'link' && !/^https?:\/\//.test(o.url || '')) errors.push(`Node "${id}": pilihan "${o.label}" butuh URL http(s).`);
    }
  }
  if (errors.length) throw new ValidationError(errors);
}

function validateTemplates(t) {
  const errors = [];
  for (const ch of ['email', 'whatsapp', 'telegram']) {
    if (!t?.[ch] || typeof t[ch] !== 'object') errors.push(`Template "${ch}" tidak ditemukan.`);
  }
  for (const [k, v] of Object.entries(t?.email || {})) {
    if (!v?.subject || !v?.body) errors.push(`Template email "${k}" wajib memiliki subjek dan isi.`);
  }
  if (errors.length) throw new ValidationError(errors);
}

function validateOffice(o) {
  const errors = [];
  if (!o?.name) errors.push('Nama kantor wajib diisi.');
  if (o?.slaHours != null && !(Number(o.slaHours) > 0)) errors.push('SLA (jam) harus angka positif.');
  if (o?.whatsapp && !/^\d{8,15}$/.test(o.whatsapp)) errors.push('Nomor WhatsApp kantor gunakan format internasional tanpa "+", contoh 6281234567890.');
  for (const c of ['brandColor', 'accentColor']) {
    if (o?.[c] && !/^#[0-9a-fA-F]{6}$/.test(o[c])) errors.push(`Warna ${c} harus format #RRGGBB.`);
  }
  if (errors.length) throw new ValidationError(errors);
}

const validators = { form: validateForm, chatbot: validateChatbot, templates: validateTemplates, office: validateOffice };

function ensureDefaults() {
  for (const key of KEYS) {
    const row = db.prepare('SELECT key FROM settings WHERE key = ?').get(key);
    if (!row) set(key, loadDefault(key), 'system');
  }
}

function getRow(key) {
  const row = db.prepare('SELECT value, version, updated_at, updated_by FROM settings WHERE key = ?').get(key);
  if (!row) return null;
  return { value: json.parse(row.value), version: row.version, updatedAt: row.updated_at, updatedBy: row.updated_by };
}

function get(key) {
  const row = getRow(key);
  if (row) return row.value;
  return loadDefault(key);
}

function getVersion(key, version) {
  const row = db.prepare('SELECT value FROM settings_history WHERE key = ? AND version = ?').get(key, version);
  return row ? json.parse(row.value) : null;
}

function history(key) {
  return db.prepare('SELECT version, updated_at, updated_by FROM settings_history WHERE key = ? ORDER BY version DESC LIMIT 50').all(key);
}

function set(key, value, user) {
  if (!KEYS.includes(key)) throw new ValidationError([`Pengaturan "${key}" tidak dikenal.`]);
  validators[key](value);
  const text = json.str(value);
  return tx(() => {
    const current = db.prepare('SELECT version FROM settings WHERE key = ?').get(key);
    const version = current ? current.version + 1 : 1;
    db.prepare(`INSERT INTO settings(key, value, version, updated_at, updated_by) VALUES (?, ?, ?, datetime('now'), ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = excluded.version, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
      .run(key, text, version, user || null);
    db.prepare('INSERT INTO settings_history(key, version, value, updated_by) VALUES (?, ?, ?, ?)').run(key, version, text, user || null);
    return version;
  });
}

module.exports = {
  KEYS, FIELD_TYPES, FIELD_ROLES, ValidationError,
  ensureDefaults, get, getRow, getVersion, history, set, loadDefault,
};
