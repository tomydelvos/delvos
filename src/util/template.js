'use strict';
// Tiny, safe template engine used for every client/team message.
//   {{var}}            escaped value (HTML-escaped for email/Telegram, plain for WhatsApp)
//   {{{var}}}          raw value (only for trusted, pre-built HTML such as the summary table)
//   {{#var}}...{{/var}} section shown only when var is non-empty
// Email bodies additionally support, on their own paragraph:
//   [button:Label|url]   call-to-action button
//   [highlight:text]     large highlighted box (registration number)
//   lines starting "- "  bullet list
// Markup is parsed from the *template* before substitution, so values supplied by
// clients can never inject buttons, links, or HTML.

const escapeHtml = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const isFilled = (v) => !(v == null || v === false || v === '' || (Array.isArray(v) && v.length === 0));

function applySections(tpl, vars) {
  let out = tpl;
  // Repeat to support (shallow) nesting.
  for (let i = 0; i < 5; i += 1) {
    const next = out.replace(/\{\{#\s*([\w.]+)\s*\}\}([\s\S]*?)\{\{\/\s*\1\s*\}\}/g,
      (_, key, inner) => (isFilled(vars[key]) ? inner : ''));
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * @param {string} tpl
 * @param {object} vars
 * @param {{escape?: (v:any)=>string, raw?: (key:string, v:any)=>string}} opts
 */
function render(tpl, vars = {}, opts = {}) {
  const esc = opts.escape || ((v) => String(v ?? ''));
  const raw = opts.raw || ((_, v) => String(v ?? ''));
  return applySections(String(tpl ?? ''), vars)
    .replace(/\{\{\{\s*([\w.]+)\s*\}\}\}/g, (_, k) => raw(k, vars[k]))
    .replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => esc(vars[k]));
}

const renderText = (tpl, vars) => render(tpl, vars, {
  raw: (k, v) => String(vars[`${k.replace(/_html$/, '')}_text`] ?? stripTags(v)),
});
const renderHtml = (tpl, vars) => render(tpl, vars, { escape: escapeHtml });

function stripTags(v) {
  return String(v ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|tr|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n').trim();
}

const BUTTON_RE = /^\[button:([^|\]]+)\|([^\]]+)\]$/;
const HIGHLIGHT_RE = /^\[highlight:([^\]]+)\]$/;

function safeUrl(url) {
  return /^(https?:|mailto:)/i.test(url) ? url : '#';
}

/** Render an email template into { subject, text, html } using the office branding. */
function renderEmail(template, vars, office) {
  const body = applySections(template.body || '', vars);
  const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const brand = office.brandColor || '#1f3a5f';
  const accent = office.accentColor || '#b8912f';

  const htmlParts = [];
  const textParts = [];
  for (const p of paragraphs) {
    let m;
    if ((m = p.match(BUTTON_RE))) {
      const label = renderHtml(m[1], vars);
      const url = render(m[2], vars).trim();
      htmlParts.push(`<p style="margin:24px 0;text-align:center"><a href="${escapeHtml(safeUrl(url))}" style="display:inline-block;background:${brand};color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600">${label}</a></p>`);
      textParts.push(`${renderText(m[1], vars)}: ${url}`);
    } else if ((m = p.match(HIGHLIGHT_RE))) {
      htmlParts.push(`<p style="margin:20px 0;text-align:center"><span style="display:inline-block;border:2px solid ${accent};color:${brand};padding:10px 24px;border-radius:6px;font-size:20px;font-weight:700;letter-spacing:1px">${renderHtml(m[1], vars)}</span></p>`);
      textParts.push(`>> ${renderText(m[1], vars)} <<`);
    } else if (/^\{\{\{\s*[\w.]+\s*\}\}\}$/.test(p)) {
      htmlParts.push(renderHtml(p, vars));
      textParts.push(renderText(p, vars));
    } else if (p.split('\n').every((l) => /^\s*-\s+/.test(l))) {
      const items = p.split('\n').map((l) => l.replace(/^\s*-\s+/, ''));
      htmlParts.push(`<ul style="margin:0 0 16px;padding-left:20px">${items.map((i) => `<li style="margin:4px 0">${renderHtml(i, vars)}</li>`).join('')}</ul>`);
      textParts.push(items.map((i) => `• ${renderText(i, vars)}`).join('\n'));
    } else {
      htmlParts.push(`<p style="margin:0 0 16px">${renderHtml(p, vars).replace(/\n/g, '<br>')}</p>`);
      textParts.push(renderText(p, vars));
    }
  }

  const header = office.logoUrl
    ? `<img src="${escapeHtml(safeUrl(office.logoUrl))}" alt="${escapeHtml(office.name)}" style="max-height:48px">`
    : `<div style="font-size:20px;font-weight:700;color:#ffffff">${escapeHtml(office.name)}</div><div style="font-size:13px;color:#dfe6ef">${escapeHtml(office.tagline || '')}</div>`;

  const html = `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f2f4f7;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#1d2433;line-height:1.6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f4f7;padding:24px 0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e3e7ee">
<tr><td style="background:${brand};padding:20px 28px;border-bottom:4px solid ${accent}">${header}</td></tr>
<tr><td style="padding:28px;font-size:15px">${htmlParts.join('\n')}</td></tr>
<tr><td style="background:#f8f9fb;padding:18px 28px;font-size:12px;color:#6b7280;border-top:1px solid #e3e7ee">
${escapeHtml(office.name)} · ${escapeHtml(office.address || '')}<br>
${escapeHtml(office.phone || '')}${office.website ? ` · <a href="${escapeHtml(safeUrl(office.website))}" style="color:#6b7280">${escapeHtml(office.website)}</a>` : ''}<br>
<span style="font-size:11px">Email ini dapat berisi informasi rahasia. Jika Anda bukan penerima yang dimaksud, mohon beri tahu kami dan hapus email ini.</span>
</td></tr></table></td></tr></table></body></html>`;

  return {
    subject: renderText(template.subject || '', vars).replace(/[\r\n]+/g, ' ').slice(0, 250),
    text: textParts.join('\n\n'),
    html,
  };
}

module.exports = { render, renderText, renderHtml, renderEmail, escapeHtml, stripTags };
