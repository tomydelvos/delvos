'use strict';
// WhatsApp Cloud API webhook:
//  - GET  verification handshake (hub.verify_token must equal WA_META_VERIFY_TOKEN)
//  - POST delivery statuses (marks failed notifications) and inbound messages
//         (opens the 24h text window and forwards client messages to the team on Telegram)
// Every POST must carry a valid X-Hub-Signature-256 made with WA_META_APP_SECRET.
const crypto = require('node:crypto');
const express = require('express');
const config = require('../config');
const { db, audit } = require('../db');
const { normalizePhone, markInbound } = require('../channels/whatsapp');
const security = require('../agents/security');

const router = express.Router();

router.get('/whatsapp', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': tokenParam, 'hub.challenge': challenge } = req.query;
  const expected = config.whatsapp.metaVerifyToken;
  if (mode === 'subscribe' && expected && tokenParam === expected) return res.type('text/plain').send(String(challenge || ''));
  res.sendStatus(403);
});

function validSignature(raw, header) {
  const secret = config.whatsapp.metaAppSecret;
  if (!secret || !header || !raw) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  const a = Buffer.from(String(header));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

router.post('/whatsapp', security.limiter('wa-webhook', 600, 60e3), express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  if (!validSignature(req.body, req.get('X-Hub-Signature-256'))) {
    audit(security.AGENT, 'webhook_wa_ditolak', { reason: config.whatsapp.metaAppSecret ? 'tanda tangan salah' : 'WA_META_APP_SECRET belum diisi' }, req.ip);
    return res.sendStatus(401);
  }
  let payload;
  try { payload = JSON.parse(req.body.toString('utf8')); } catch { return res.sendStatus(400); }
  res.sendStatus(200); // acknowledge quickly; Meta retries on slow responses
  try { handle(payload); } catch (err) { console.error('[webhook:whatsapp]', err); }
});

function handle(payload) {
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      for (const st of value.statuses || []) {
        if (st.status === 'failed') {
          const err = st.errors?.[0] || {};
          db.prepare(`UPDATE notifications SET status = 'failed', last_error = ? WHERE provider_id = ?`)
            .run(`WhatsApp: ${err.title || err.message || 'gagal terkirim'}${err.code ? ` [kode ${err.code}]` : ''}`.slice(0, 500), st.id);
        }
      }
      const names = Object.fromEntries((value.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
      for (const msg of value.messages || []) inbound(msg, names[msg.from]);
    }
  }
}

function inbound(msg, profileName) {
  const phone = normalizePhone(msg.from);
  if (!phone) return;
  markInbound(phone, Number(msg.timestamp) * 1000 || Date.now());
  // Team members message the business number to keep their window open; don't echo those.
  const team = require('../users').teamRecipients().whatsapp;
  if (team.includes(phone)) return;

  const text = msg.type === 'text' ? msg.text?.body : `[${msg.type}]`;
  const local = `0${phone.slice(2)}`;
  const sub = db.prepare(`SELECT id, reg_no, client_name FROM submissions WHERE replace(replace(replace(client_phone,' ',''),'-',''),'+','') IN (?, ?) ORDER BY id DESC LIMIT 1`).get(phone, local);
  const outbox = require('../outbox');
  const vars = {
    wa_from: `+${phone}`,
    wa_name: profileName || '',
    wa_text: security.clean(text, 1000),
    reg_no: sub?.reg_no || '',
    client_name: sub?.client_name || profileName || '',
    admin_link: sub ? `${config.publicUrl}/admin/#submission/${sub.id}` : `${config.publicUrl}/admin/`,
  };
  const chats = config.telegram.chatIds.length ? config.telegram.chatIds : ['(belum-dikonfigurasi)'];
  for (const chat of chats) outbox.telegramTemplate('wa_inbound_team', chat, vars, { related: sub?.reg_no || `wa-${phone}` });
  if (sub) {
    db.prepare('INSERT INTO submission_events(submission_id, type, actor, payload) VALUES (?, ?, ?, ?)')
      .run(sub.id, 'whatsapp', 'operasional', JSON.stringify({ from: vars.wa_from, text: vars.wa_text }));
  }
  audit('operasional', 'wa_masuk', { from: vars.wa_from, reg: sub?.reg_no || null });
}

module.exports = router;
module.exports.validSignature = validSignature;
