'use strict';
// WhatsApp providers:
//  - log    : print to console (development / before a provider is chosen)
//  - fonnte : https://fonnte.com — uses a linked WhatsApp number
//  - meta   : WhatsApp Cloud API (official).
//
// Cloud API rule: free-form text is only delivered inside the 24-hour "customer service window"
// that opens when the recipient messages the business number. Everything else must use an
// approved template. In WA_META_MODE=auto we send text when the window is open (tracked from
// inbound webhooks) and the generic template otherwise.
const config = require('../config');
const { kv } = require('../db');

/** 0812..., +62812..., 62812... -> 62812... */
function normalizePhone(raw) {
  let p = String(raw || '').replace(/[^\d+]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  if (p.startsWith('0')) p = `62${p.slice(1)}`;
  if (p.startsWith('8')) p = `62${p}`;
  return /^\d{8,15}$/.test(p) ? p : null;
}

const WINDOW_MS = 23.5 * 3600e3; // stay a little inside Meta's 24h limit
const windowKey = (phone) => `wa_inbound:${phone}`;
function markInbound(phone, at = Date.now()) {
  const p = normalizePhone(phone);
  if (p) kv.set(windowKey(p), String(at));
}
function windowOpen(phone) {
  const at = Number(kv.get(windowKey(phone)) || 0);
  return Date.now() - at < WINDOW_MS;
}

/**
 * Template parameters may not contain newlines, tabs or more than four consecutive spaces,
 * and the whole body is limited to 1024 characters.
 */
function templateParam(text, max = 900) {
  const flat = String(text || '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).join(' · ')
    .replace(/\t/g, ' ').replace(/ {4,}/g, '   ');
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function metaPayload(phone, text) {
  const { metaMode, metaTemplateName, metaTemplateLang } = config.whatsapp;
  const useText = metaMode === 'text' || (metaMode === 'auto' && windowOpen(phone));
  if (useText) {
    return { messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: text.slice(0, 4096), preview_url: false } };
  }
  // Generic utility template: "Pemberitahuan dari {{1}}: {{2}} ..." (see README for the exact text to register).
  const firm = require('../settings').get('office').name;
  return {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: metaTemplateName,
      language: { code: metaTemplateLang },
      components: [{ type: 'body', parameters: [{ type: 'text', text: templateParam(firm, 60) }, { type: 'text', text: templateParam(text) }] }],
    },
  };
}

async function sendWhatsApp(to, text) {
  const phone = normalizePhone(to);
  if (!phone) throw new Error(`Nomor WhatsApp tidak valid: ${to}`);
  const { provider } = config.whatsapp;

  if (provider === 'fonnte') {
    if (!config.whatsapp.fonnteToken) throw new Error('FONNTE_TOKEN belum diisi');
    const res = await fetch('https://api.fonnte.com/send', {
      method: 'POST',
      headers: { Authorization: config.whatsapp.fonnteToken },
      body: new URLSearchParams({ target: phone, message: text, countryCode: '62' }),
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status === false) throw new Error(`Fonnte: ${body.reason || body.detail || res.status}`);
    return { id: body.id?.[0] ?? null };
  }

  if (provider === 'meta') {
    const { metaToken, metaPhoneNumberId, metaApiVersion } = config.whatsapp;
    if (!metaToken || !metaPhoneNumberId) throw new Error('WA_META_TOKEN / WA_META_PHONE_NUMBER_ID belum diisi');
    const payload = metaPayload(phone, text);
    const res = await fetch(`https://graph.facebook.com/${metaApiVersion}/${metaPhoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${metaToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = body.error || {};
      throw new Error(`WhatsApp Cloud API (${payload.type}): ${e.error_user_msg || e.message || res.status}${e.code ? ` [kode ${e.code}]` : ''}`);
    }
    return { id: body.messages?.[0]?.id ?? null, mode: payload.type };
  }

  console.log(`[whatsapp:simulasi] -> ${phone}\n${text}\n`);
  return { simulated: true };
}

module.exports = { sendWhatsApp, normalizePhone, markInbound, windowOpen, templateParam, metaPayload };
