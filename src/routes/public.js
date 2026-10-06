'use strict';
const express = require('express');
const multer = require('multer');
const config = require('../config');
const settings = require('../settings');
const { db } = require('../db');
const { render } = require('../util/template');
const security = require('../agents/security');
const admin = require('../agents/administrative');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.security.maxUploadMb * 1024 * 1024,
    files: config.security.maxFiles,
    fields: 200,
    fieldSize: 64 * 1024,
  },
});

function publicOffice() {
  const o = settings.get('office');
  return {
    name: o.name, tagline: o.tagline, address: o.address, phone: o.phone, email: o.email, website: o.website,
    whatsapp: o.whatsapp, brandColor: o.brandColor, accentColor: o.accentColor, logoUrl: o.logoUrl,
    officeHours: o.officeHours?.label || '', slaHours: o.slaHours,
  };
}

function renderedChatbot() {
  const flow = settings.get('chatbot');
  const office = settings.get('office');
  const vars = { firm_name: office.name, office_hours: office.officeHours?.label || '', sla_hours: office.slaHours, firm_phone: office.phone };
  const nodes = {};
  for (const [id, node] of Object.entries(flow.nodes)) {
    nodes[id] = { ...node, messages: node.messages.map((m) => render(m, vars)) };
  }
  return { botName: flow.botName, start: flow.start, nodes };
}

router.get('/config', security.limiter('config', 120, 60e3), (req, res) => {
  let prefill = null;
  if (req.query.t) {
    const inq = db.prepare(`SELECT ref, from_name, from_email, status FROM inquiries WHERE invite_token = ?`).get(String(req.query.t));
    if (inq) prefill = { ref: inq.ref, name: inq.from_name || '', email: inq.from_email, alreadyRegistered: inq.status === 'registered' };
  }
  res.set('Cache-Control', 'no-store');
  res.json({
    office: publicOffice(),
    chatbot: renderedChatbot(),
    form: settings.get('form'),
    limits: { maxUploadMb: config.security.maxUploadMb, maxFiles: config.security.maxFiles },
    prefill,
    serverTime: Date.now(),
  });
});

router.post('/submit', security.limiter('submit', config.security.submitPer10Min, 10 * 60e3), (req, res, next) => {
  upload.any()(req, res, (err) => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `Ukuran berkas maksimal ${config.security.maxUploadMb} MB.`
      : err.code === 'LIMIT_FILE_COUNT' ? `Maksimal ${config.security.maxFiles} berkas.`
        : 'Unggahan tidak dapat diproses.';
    res.status(400).json({ error: msg });
  });
}, async (req, res) => {
  try {
    const result = await admin.handleSubmission({ body: req.body || {}, files: req.files || [], ip: req.ip });
    res.json(result);
  } catch (err) {
    if (err instanceof admin.SubmissionError) return res.status(422).json({ error: 'Mohon periksa kembali isian Anda.', fields: err.errors });
    throw err;
  }
});

router.post('/status-lookup', security.limiter('status', 10, 15 * 60e3), (req, res) => {
  const result = admin.lookupStatus(req.body?.regNo, req.body?.email);
  if (!result) return res.status(404).json({ error: 'Data tidak ditemukan. Pastikan nomor registrasi dan email sesuai dengan yang Anda daftarkan.' });
  res.json(result);
});

router.get('/status', security.limiter('status-page', 30, 15 * 60e3), (req, res) => {
  const result = admin.publicStatus(req.query.r, req.query.k);
  if (!result) return res.status(404).json({ error: 'Tautan status tidak valid.' });
  res.json(result);
});

module.exports = router;
