'use strict';
const config = require('../config');

/** Send an HTML-formatted message (already escaped by the template engine) to one chat. */
async function sendTelegram(chatId, html, { buttonUrl, buttonLabel } = {}) {
  if (!config.telegram.botToken) {
    console.log(`[telegram:simulasi] -> ${chatId}\n${html}\n`);
    return { simulated: true };
  }
  const payload = {
    chat_id: chatId,
    text: html.slice(0, 4000),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  // Telegram only accepts public http(s) URLs for inline buttons.
  if (buttonUrl && /^https:\/\//.test(buttonUrl)) {
    payload.reply_markup = { inline_keyboard: [[{ text: buttonLabel || 'Buka', url: buttonUrl }]] };
  }
  const res = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.ok) throw new Error(`Telegram: ${body.description || res.status}`);
  return { id: body.result?.message_id ?? null };
}

module.exports = { sendTelegram };
