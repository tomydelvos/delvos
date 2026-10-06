'use strict';
const nodemailer = require('nodemailer');
const config = require('../config');

let transport = null;
function getTransport() {
  if (!config.smtp.enabled) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
      // Never let message content pull local files or remote URLs into a mail.
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }
  return transport;
}

/**
 * Send one email. Returns { simulated: true } when SMTP is not configured (dev mode).
 * @param {{to:string, subject:string, text:string, html?:string, inReplyTo?:string, replyTo?:string}} msg
 */
async function sendEmail(msg) {
  const t = getTransport();
  if (!t) {
    console.log(`[email:simulasi] -> ${msg.to} | ${msg.subject}`);
    return { simulated: true };
  }
  const info = await t.sendMail({
    from: config.smtp.from || config.smtp.user,
    to: msg.to,
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    replyTo: msg.replyTo,
    inReplyTo: msg.inReplyTo,
    references: msg.inReplyTo,
    headers: {
      // Mark as automatic so well-behaved auto-responders on the other side don't reply back (loop guard).
      'Auto-Submitted': msg.autoSubmitted === false ? 'no' : 'auto-replied',
      'X-Auto-Response-Suppress': 'All',
    },
  });
  return { messageId: info.messageId };
}

module.exports = { sendEmail };
