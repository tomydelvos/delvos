'use strict';
const path = require('node:path');
const express = require('express');
const config = require('./config');
const settings = require('./settings');
const security = require('./agents/security');
const ops = require('./agents/operational');
const users = require('./users');

function createApp() {
  settings.ensureDefaults();
  users.ensureInitialAdmin(); // prints a generated first-run password if none is configured
  const app = express();
  app.disable('x-powered-by');
  if (config.security.trustProxy) app.set('trust proxy', 1);
  app.use(security.securityHeaders);

  app.use('/api/public', express.json({ limit: '50kb' }), require('./routes/public'));
  app.use('/api/admin', require('./routes/admin'));
  app.use('/webhooks', require('./routes/webhooks'));

  const pub = path.join(config.root, 'public');
  const page = (file) => (req, res) => res.sendFile(path.join(pub, file));
  app.get(['/', '/daftar', '/status'], page('index.html'));
  app.use(express.static(pub, { index: 'index.html', maxAge: config.isProduction ? '1h' : 0 }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Tidak ditemukan' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({
      error: status >= 500 ? 'Terjadi kesalahan pada server. Tim kami telah dicatat.' : err.message,
      fields: err.errors && !Array.isArray(err.errors) ? err.errors : undefined,
      details: Array.isArray(err.errors) ? err.errors : undefined,
    });
  });
  return app;
}

if (require.main === module) {
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`Kantor virtual berjalan di ${config.publicUrl}`);
    console.log(`  Chatbot klien : ${config.publicUrl}/`);
    console.log(`  Formulir      : ${config.publicUrl}/daftar`);
    console.log(`  Panel admin   : ${config.publicUrl}/admin/`);
    console.log(`  SMTP ${config.smtp.enabled ? 'aktif' : 'simulasi'} · WhatsApp: ${config.whatsapp.provider} · Telegram ${config.telegram.enabled ? 'aktif' : 'simulasi'} · AI ${config.ai.enabled ? 'aktif' : 'nonaktif'}`);
    ops.start();
  });
}

module.exports = { createApp };
