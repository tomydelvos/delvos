'use strict';
// WhatsApp providers:
//  - log    : print to console (development / before a provider is chosen)
//  - fonnte : https://fonnte.com — popular in Indonesia, uses a linked WhatsApp number
//  - meta   : WhatsApp Cloud API (official). Note: messages to a number that has not chatted
//             with the business in the last 24 hours require an approved template.
const config = require('../config');

/** 0812..., +62812..., 62812... -> 62812... */
function normalizePhone(raw) {
  let p = String(raw || '').replace(/[^\d+]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  if (p.startsWith('0')) p = `62${p.slice(1)}`;
  if (p.startsWith('8')) p = `62${p}`;
  return /^\d{8,15}$/.test(p) ? p : null;
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
    const res = await fetch(`https://graph.facebook.com/${metaApiVersion}/${metaPhoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${metaToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: text, preview_url: false } }),
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`WhatsApp Cloud API: ${body.error?.message || res.status}`);
    return { id: body.messages?.[0]?.id ?? null };
  }

  console.log(`[whatsapp:simulasi] -> ${phone}\n${text}\n`);
  return { simulated: true };
}

module.exports = { sendWhatsApp, normalizePhone };
