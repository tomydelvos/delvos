/* Admin panel — vanilla JS single-page app. All dynamic text is inserted with textContent. */
(() => {
  'use strict';

  const $ = (s, root = document) => root.querySelector(s);
  const view = () => $('#view');

  function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'value') n.value = v;
      else if (k === 'checked') n.checked = Boolean(v);
      else if (k === 'selected') n.selected = Boolean(v);
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
    return n;
  }
  const clear = (n) => { n.textContent = ''; return n; };

  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', headers: { 'X-Requested-With': 'fetch' } };
    if (opts.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
    const res = await fetch(`/api/admin${path}`, init);
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== '/login') { showLogin(); throw new Error(body.error || 'Sesi berakhir'); }
    if (res.status === 403 && body.mustChangePassword) { showPasswordScreen(); throw new Error(body.error); }
    if (!res.ok) throw Object.assign(new Error(body.error || `Gagal (${res.status})`), { body });
    return body;
  }

  let toastTimer;
  function toast(msg, type = '') {
    const t = $('#toast');
    t.textContent = msg; t.className = `toast ${type}`; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, type === 'error' ? 6000 : 3000);
  }
  function errorBox(err) {
    const box = el('div', { class: 'alert error' }, err.message);
    const details = err.body?.details;
    if (details?.length) box.append(el('ul', {}, details.map((d) => el('li', { text: d }))));
    return box;
  }
  const guard = (fn) => async (...args) => { try { await fn(...args); } catch (err) { toast(err.message, 'error'); } };

  const fromDb = (s) => (s ? new Date(`${String(s).replace(' ', 'T')}Z`) : null);
  const fmt = (s) => { const d = fromDb(s); return d ? d.toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '-'; };
  const badge = (status, label) => el('span', { class: `badge ${status}`, text: label || status });
  const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 40) || 'field';
  const deep = (o) => JSON.parse(JSON.stringify(o));
  // Removing a focused, edited input fires a synchronous "change" event; if that handler re-renders
  // while a render is in progress, the editor would be built twice. Ignore nested calls.
  function noReentry(fn) {
    let busy = false;
    return (...a) => { if (busy) return; busy = true; try { fn(...a); } finally { busy = false; } };
  }

  let STATUSES = {};
  const INQ_STATUS = { new: 'Baru', invited: 'Diundang isi formulir', registered: 'Sudah registrasi', replied: 'Dibalas (lanjutan)', spam: 'Spam', ignored: 'Diabaikan' };

  // ================================================================ auth & routing
  let ME = null;
  const isAdmin = () => ME?.role === 'admin';
  function showLogin() { $('#app').hidden = true; $('#pw-screen').hidden = true; $('#login-screen').hidden = false; }
  function showPasswordScreen() { $('#app').hidden = true; $('#login-screen').hidden = true; $('#pw-screen').hidden = false; }
  async function boot() {
    try {
      ME = await api('/me');
    } catch { showLogin(); return; }
    if (ME.mustChangePassword) { showPasswordScreen(); return; }
    $('#side-user').textContent = `${ME.name} (${ME.role})`;
    if (ME.environment === 'staging' && !$('.env-banner')) {
      document.body.prepend(el('div', { class: 'env-banner', text: 'STAGING — pesan hanya dikirim ke staf & daftar izin; lainnya tercatat sebagai "blocked" di Log Notifikasi.' }));
    }
    for (const n of document.querySelectorAll('[data-admin]')) n.hidden = !isAdmin();
    $('#login-screen').hidden = true; $('#pw-screen').hidden = true; $('#app').hidden = false;
    try {
      const office = await api('/settings/office');
      $('#side-firm').textContent = office.value.name;
      STATUSES = office.meta.statuses;
      route();
    } catch (err) { toast(err.message, 'error'); }
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const errBox = $('#login-error');
    errBox.hidden = true;
    try {
      await api('/login', { method: 'POST', body: { username: fd.get('username'), password: fd.get('password') } });
      e.target.reset();
      boot();
    } catch (err) { errBox.textContent = err.message; errBox.hidden = false; }
  });
  $('#pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const errBox = $('#pw-error');
    errBox.hidden = true;
    try {
      if (fd.get('next') !== fd.get('confirm')) throw new Error('Konfirmasi kata sandi tidak sama.');
      await api('/password', { method: 'POST', body: { current: fd.get('current'), next: fd.get('next') } });
      e.target.reset();
      toast('Kata sandi diganti');
      boot();
    } catch (err) { errBox.textContent = err.message; errBox.hidden = false; }
  });
  $('#logout').addEventListener('click', async () => { await api('/logout', { method: 'POST' }).catch(() => {}); showLogin(); });
  $('#menu-toggle').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

  const routes = {};
  let dirty = false;
  function route() {
    if (dirty && !confirm('Ada perubahan yang belum disimpan. Tinggalkan halaman ini?')) return;
    dirty = false;
    const [name, id] = (location.hash.slice(1) || 'dashboard').split('/');
    const map = { inquiry: 'inquiries', submission: 'submissions' };
    for (const a of document.querySelectorAll('[data-route]')) a.classList.toggle('active', a.dataset.route === (map[name] || name));
    $('#sidebar').classList.remove('open');
    const ADMIN_ROUTES = ['form', 'chatbot', 'templates', 'settings', 'users', 'audit', 'tools'];
    const fn = (ADMIN_ROUTES.includes(name) && !isAdmin()) ? routes.dashboard : (routes[name] || routes.dashboard);
    clear(view()).append(el('p', { class: 'muted', text: 'Memuat…' }));
    Promise.resolve(fn(id)).catch((err) => clear(view()).append(errorBox(err)));
  }
  window.addEventListener('hashchange', route);
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  const pageHead = (title, sub, ...actions) => el('div', { class: 'page-head' },
    el('div', {}, el('h1', { text: title }), sub ? el('div', { class: 'muted', text: sub }) : null),
    el('div', { class: 'toolbar' }, ...actions));

  // ================================================================ dashboard
  routes.dashboard = async () => {
    const d = await api('/dashboard');
    const v = clear(view());
    v.append(pageHead('Dasbor', 'Ringkasan kantor virtual dan status ketiga agen'));
    const s = d.stats;
    v.append(el('div', { class: 'grid cols-4' },
      stat(s.inquiries_24h, 'Email masuk (24 jam)'), stat(s.submissions_24h, 'Registrasi baru (24 jam)'),
      stat(s.pending_review, 'Menunggu tinjauan'), stat(s.overdue, 'Melewati SLA'),
    ));
    v.append(el('div', { style: 'height:16px' }));

    const ag = d.agents;
    v.append(el('div', { class: 'grid cols-3' },
      agentCard('🗂 Agen Administratif', 'Membalas email klien, menerbitkan nomor registrasi, mengirim konfirmasi & surat status.', [
        ['Status', 'Aktif'], ['Triase AI (Claude)', ag.administratif.ai ? 'Aktif' : 'Nonaktif (aturan dasar)'],
      ]),
      agentCard('⚙️ Agen Operasional', 'Memantau inbox, mengirim & mengulang notifikasi, pengingat SLA, ringkasan harian.', [
        ['Penjadwal', ag.operasional.aktif ? `Aktif · ${fmtIso(ag.operasional.lastTick)}` : 'Tidak aktif'],
        ['Inbox IMAP', ag.operasional.imap ? `Aktif · ${fmtIso(ag.operasional.lastImapPoll)}` : 'Belum dikonfigurasi'],
        ag.operasional.lastImapError ? ['Galat IMAP', ag.operasional.lastImapError] : null,
      ]),
      agentCard('🛡 Agen Keamanan', 'Menyaring spam/phishing, validasi formulir & berkas, rate limit, pemeriksaan konflik, log audit.', [
        ['Ambang spam', `${ag.keamanan.spamThreshold}/100`], ['Ancaman diblokir (24 jam)', String(ag.keamanan.bots24h)],
      ]),
    ));

    const c = d.channels;
    const ch = (ok, label, detail, off = 'Simulasi') => el('li', {}, badge(ok ? 'ok' : 'warn', ok ? 'Aktif' : off), ' ', el('strong', { text: label }), detail ? el('span', { class: 'muted', text: ` — ${detail}` }) : null);
    v.append(el('div', { class: 'card' }, el('h2', { text: 'Kanal komunikasi' }),
      el('ul', { style: 'list-style:none;padding:0;margin:0;display:grid;gap:6px' },
        ch(c.smtp, 'Email keluar (SMTP)'), ch(c.imap, 'Email masuk (IMAP)'),
        ch(c.whatsapp !== 'log', 'WhatsApp', `penyedia: ${c.whatsapp}${c.whatsappMode ? ` (mode ${c.whatsappMode}, webhook ${c.whatsappWebhook ? 'aktif' : 'belum diatur'})` : ''}, ${c.whatsappTeam} nomor tim`),
        ch(c.telegram, 'Telegram'), ch(c.teamEmails > 0, 'Email tim', `${c.teamEmails} alamat`, 'Belum diatur'), ch(c.ai, 'AI Claude', 'opsional', 'Nonaktif'),
      ),
      el('p', { class: 'muted small', text: `URL publik: ${c.publicUrl}. Kanal berstatus "Simulasi" mencetak pesan ke log server — atur kredensial di file .env.` })));

    v.append(el('div', { class: 'split' },
      el('div', { class: 'card' }, el('h2', { text: 'Registrasi terbaru' }), simpleTable(['No.', 'Nama', 'Bidang', 'Status'], d.recentSubmissions.map((r) => ({
        cells: [r.reg_no, r.client_name, r.matter_type || '-', badge(r.status, STATUSES[r.status])], href: `#submission/${r.id}`, warn: r.conflicts,
      })))),
      el('div', { class: 'card' }, el('h2', { text: 'Email masuk terbaru' }), simpleTable(['Ref', 'Dari', 'Perihal', 'Status'], d.recentInquiries.map((r) => ({
        cells: [r.ref, r.from_name || r.from_email, r.subject || '-', badge(r.status, INQ_STATUS[r.status])], href: `#inquiry/${r.id}`,
      })))),
    ));
  };
  const fmtIso = (s) => (s ? new Date(s).toLocaleTimeString('id-ID') : '-');
  const stat = (n, l) => el('div', { class: 'stat' }, el('div', { class: 'n', text: String(n) }), el('div', { class: 'l', text: l }));
  const agentCard = (title, desc, rows) => el('div', { class: 'card' }, el('h2', { text: title }), el('p', { class: 'muted small', text: desc }),
    el('dl', { class: 'kv' }, rows.filter(Boolean).flatMap(([k, val]) => [el('dt', { text: k }), el('dd', { text: val })])));

  function simpleTable(head, rows) {
    if (!rows.length) return el('p', { class: 'muted', text: 'Belum ada data.' });
    return el('div', { class: 'table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, head.map((h) => el('th', { text: h })))),
      el('tbody', {}, rows.map((r) => el('tr', { class: r.href ? 'click' : '', onclick: r.href ? () => { location.hash = r.href; } : null },
        r.cells.map((c, i) => el('td', {}, c, i === 1 && r.warn ? el('span', { class: 'badge high', style: 'margin-left:6px', text: `⚠ ${r.warn} konflik` }) : null)))))));
  }

  // ================================================================ inquiries
  routes.inquiries = async () => {
    const v = clear(view());
    const q = el('input', { type: 'text', placeholder: 'Cari email, nama, perihal, referensi…' });
    const st = el('select', {}, el('option', { value: '', text: 'Semua status' }), Object.entries(INQ_STATUS).map(([k, l]) => el('option', { value: k, text: l })));
    const box = el('div');
    const load = guard(async () => {
      const rows = await api(`/inquiries?status=${st.value}&q=${encodeURIComponent(q.value)}`);
      clear(box).append(simpleTable(['Ref', 'Diterima', 'Dari', 'Perihal', 'Kategori AI', 'Keamanan', 'Status'], rows.map((r) => ({
        cells: [r.ref, fmt(r.received_at), `${r.from_name || ''} <${r.from_email}>`, r.subject || '-', r.ai?.category || '-',
          r.spam_score >= 30 ? badge(r.spam_score >= 60 ? 'spam' : 'suspicious', `skor ${r.spam_score}`) : badge('ok', 'aman'),
          el('span', {}, badge(r.status, INQ_STATUS[r.status]), r.kind === 'follow_up' ? el('span', { class: 'badge', style: 'margin-left:4px', text: 'lanjutan' }) : null)],
        href: `#inquiry/${r.id}`,
      }))));
    });
    q.addEventListener('input', debounce(load, 300));
    st.addEventListener('change', load);
    v.append(pageHead('Email Masuk', 'Email dari calon klien yang diterima Agen Administratif', el('div', { style: 'width:280px' }, q), el('div', { style: 'width:200px' }, st)), box);
    load();
  };

  routes.inquiry = async (id) => {
    const r = await api(`/inquiries/${id}`);
    const v = clear(view());
    const setStatus = (s) => guard(async () => { await api(`/inquiries/${id}/status`, { method: 'POST', body: { status: s } }); toast('Status diperbarui'); route(); });
    v.append(pageHead(`${r.ref} — ${r.subject || '(tanpa perihal)'}`, `Dari ${r.from_name || ''} <${r.from_email}> · ${fmt(r.received_at)}`,
      el('a', { class: 'btn', href: '#inquiries', text: '← Kembali' }),
      r.submission_id ? el('a', { class: 'btn primary', href: `#submission/${r.submission_id}`, text: 'Lihat registrasi' }) : null,
      !r.submission_id ? el('button', { class: 'btn primary', onclick: guard(async () => { await api(`/inquiries/${id}/invite`, { method: 'POST' }); toast('Undangan formulir dikirim'); route(); }), text: r.status === 'invited' ? 'Kirim ulang undangan' : 'Kirim undangan formulir' }) : null,
      r.status !== 'spam' ? el('button', { class: 'btn danger', onclick: setStatus('spam'), text: 'Tandai spam' }) : el('button', { class: 'btn', onclick: setStatus('new'), text: 'Bukan spam' }),
      r.status !== 'ignored' ? el('button', { class: 'btn', onclick: setStatus('ignored'), text: 'Abaikan' }) : null,
    ));
    const flags = r.security_flags || [];
    v.append(el('div', { class: 'split' },
      el('div', { class: 'card' }, el('h2', { text: 'Isi email' }), el('div', { class: 'pre', text: r.body_text || '(kosong)' }),
        r.attachments.length ? el('div', {}, el('div', { class: 'section-title', text: 'Lampiran (tidak disimpan otomatis)' }),
          el('ul', {}, r.attachments.map((a) => el('li', { text: `${a.filename} · ${Math.round((a.size || 0) / 1024)} KB` })))) : null),
      el('div', {},
        el('div', { class: 'card' }, el('h2', { text: '🛡 Pemeriksaan keamanan' }),
          el('p', {}, badge(r.spam_score >= 60 ? 'spam' : r.spam_score >= 30 ? 'suspicious' : 'ok', `Skor risiko ${r.spam_score}/100`), ' ', badge(r.status, INQ_STATUS[r.status])),
          flags.length ? el('ul', {}, flags.map((f) => el('li', { text: f }))) : el('p', { class: 'muted', text: 'Tidak ada indikasi.' })),
        r.ai ? el('div', { class: 'card' }, el('h2', { text: '🤖 Triase AI' }), el('dl', { class: 'kv' },
          el('dt', { text: 'Permintaan jasa hukum' }), el('dd', { text: r.ai.is_legal_inquiry ? 'Ya' : 'Tidak' }),
          el('dt', { text: 'Kategori' }), el('dd', { text: r.ai.category }),
          el('dt', { text: 'Urgensi' }), el('dd', { text: r.ai.urgency }),
          el('dt', { text: 'Ringkasan' }), el('dd', { text: r.ai.summary }))) : null,
        notifCard(r.notifications)),
    ));
  };

  function notifCard(list) {
    return el('div', { class: 'card' }, el('h2', { text: '🔔 Pesan terkirim' }), list.length
      ? el('ul', { style: 'padding-left:16px;margin:0' }, list.map((n) => el('li', {}, badge(n.status), ` ${n.channel} → ${n.recipient}`, n.subject ? el('span', { class: 'muted', text: ` · ${n.subject}` }) : null, n.last_error ? el('div', { class: 'small', style: 'color:var(--danger)', text: n.last_error }) : null)))
      : el('p', { class: 'muted', text: 'Belum ada.' }));
  }

  // ================================================================ submissions
  routes.submissions = async () => {
    const v = clear(view());
    const q = el('input', { type: 'text', placeholder: 'Cari nama, email, no. registrasi, pihak lawan…' });
    const st = el('select', {}, el('option', { value: '', text: 'Semua status' }), Object.entries(STATUSES).map(([k, l]) => el('option', { value: k, text: l })));
    const box = el('div');
    const load = guard(async () => {
      const rows = await api(`/submissions?status=${st.value}&q=${encodeURIComponent(q.value)}`);
      clear(box).append(simpleTable(['No. Registrasi', 'Nama', 'Bidang', 'Urgensi', 'Masuk', 'Status'], rows.map((r) => ({
        cells: [r.reg_no, r.client_name, r.matter_type || '-', r.urgency || '-', fmt(r.created_at),
          el('span', {}, badge(r.status, STATUSES[r.status]), r.sla_reminded_at && r.status === 'baru' ? el('span', { class: 'badge high', style: 'margin-left:4px', text: 'lewat SLA' }) : null)],
        href: `#submission/${r.id}`, warn: r.conflicts,
      }))));
    });
    q.addEventListener('input', debounce(load, 300));
    st.addEventListener('change', load);
    v.append(pageHead('Registrasi Klien', 'Formulir registrasi calon klien',
      el('div', { style: 'width:280px' }, q), el('div', { style: 'width:200px' }, st),
      isAdmin() ? el('a', { class: 'btn', href: '/api/admin/submissions.csv', text: '⬇ Ekspor CSV' }) : null), box);
    load();
  };

  routes.submission = async (id) => {
    const s = await api(`/submissions/${id}`);
    const v = clear(view());
    v.append(pageHead(`${s.reg_no} — ${s.client_name}`, `${s.matter_type || ''} · masuk ${fmt(s.created_at)}`,
      el('a', { class: 'btn', href: '#submissions', text: '← Kembali' }),
      el('button', { class: 'btn', text: '🔗 Salin tautan status klien', onclick: () => navigator.clipboard?.writeText(s.statusLink).then(() => toast('Tautan disalin')) }),
      badge(s.status, s.statusLabel)));

    if (s.conflict_hits.length) {
      v.append(el('div', { class: 'alert warn' }, el('strong', { text: `⚠ Indikasi benturan kepentingan (${s.conflict_hits.length}) — wajib diverifikasi sebelum menerima perkara.` }),
        el('ul', {}, s.conflict_hits.map((h) => el('li', { text: `[${h.severity}] ${h.reason}: "${h.input}" ≈ "${h.match}"${h.matterRef ? ` (${h.matterRef})` : ''} · kemiripan ${h.score}` })))));
    }
    if (s.security_flags.length) v.append(el('div', { class: 'alert info', text: `Catatan keamanan: ${s.security_flags.join(', ')}` }));

    // Answers grouped by section
    const answers = el('div', { class: 'card' }, el('h2', { text: 'Isian formulir' }));
    let lastSection = null;
    let dl = null;
    for (const a of s.answers) {
      if (a.section !== lastSection) { answers.append(el('div', { class: 'section-title', text: a.section })); dl = el('dl', { class: 'kv' }); answers.append(dl); lastSection = a.section; }
      dl.append(el('dt', { text: a.label }), el('dd', { text: a.value }));
    }
    if (s.files.length) {
      answers.append(el('div', { class: 'section-title', text: 'Berkas' }), el('ul', {}, s.files.map((f) => el('li', {},
        el('a', { href: `/api/admin/submissions/${s.id}/files/${f.id}`, text: f.name }), el('span', { class: 'muted small', text: ` · ${(f.size / 1024).toFixed(0)} KB · sha256 ${f.sha256.slice(0, 12)}…` })))));
    }
    answers.append(el('p', { class: 'muted small', text: `Versi formulir: ${s.form_version}` }));

    // Action panel
    const statusSel = el('select', {}, Object.entries(STATUSES).map(([k, l]) => el('option', { value: k, text: l, selected: k === s.status })));
    const msg = el('textarea', { placeholder: 'Pesan untuk klien (dimasukkan ke surat email)…' });
    const notify = el('input', { type: 'checkbox', checked: true });
    const hint = el('div', { class: 'muted small' });
    const HINTS = {
      ditinjau: 'Surat: pemberitahuan bahwa pendaftaran sedang ditinjau. Pesan opsional.',
      perlu_info: 'WAJIB: tuliskan informasi/dokumen yang dibutuhkan. Klien diminta membalas email.',
      dijadwalkan: 'WAJIB: tuliskan hari, tanggal, jam, dan tempat/tautan video call.',
      diterima: 'Surat penerimaan. Pesan opsional (mis. nama advokat & langkah berikut).',
      ditolak: 'Surat penolakan yang sopan + saran segera mencari advokat lain. Alasan opsional — sebaiknya umum.',
      baru: 'Tidak ada surat ke klien.', arsip: 'Tidak ada surat ke klien.',
    };
    const updHint = () => { hint.textContent = HINTS[statusSel.value] || ''; };
    statusSel.addEventListener('change', updHint); updHint();
    const actions = el('div', { class: 'card' }, el('h2', { text: 'Tindak lanjut' }),
      el('label', { class: 'f' }, 'Status baru', statusSel), hint,
      el('label', { class: 'f', style: 'margin-top:8px' }, 'Pesan untuk klien', msg),
      el('label', { class: 'inline' }, notify, 'Kirim surat email (dan WhatsApp) ke klien'),
      el('div', { style: 'margin-top:10px' }, el('button', { class: 'btn primary', text: 'Simpan status', onclick: guard(async () => {
        await api(`/submissions/${id}/status`, { method: 'POST', body: { status: statusSel.value, message: msg.value, notifyClient: notify.checked } });
        toast(notify.checked ? 'Status disimpan dan klien diberi tahu' : 'Status disimpan'); route();
      }) })));

    // Assignment
    const staff = await api('/users/brief');
    const assignSel = el('select', {}, el('option', { value: '', text: '— Belum ditugaskan —' }),
      staff.map((u) => el('option', { value: u.username, text: `${u.name} (${u.username})`, selected: u.username === s.assigned_to })));
    const assignNote = el('input', { type: 'text', placeholder: 'Catatan untuk staf (opsional)' });
    const assignCard = el('div', { class: 'card' }, el('h2', { text: '📌 Penanggung jawab' }),
      el('label', { class: 'f' }, 'Tugaskan ke', assignSel), assignNote,
      el('p', { class: 'muted small', text: 'Staf yang ditugaskan menerima email & WhatsApp berisi ringkasan registrasi.' }),
      el('button', { class: 'btn', text: 'Simpan penugasan', onclick: guard(async () => {
        await api(`/submissions/${id}/assign`, { method: 'POST', body: { username: assignSel.value, note: assignNote.value } });
        toast(assignSel.value ? 'Ditugaskan & staf diberi tahu' : 'Penugasan dihapus'); route();
      }) }));

    const note = el('textarea', { placeholder: 'Catatan internal (tidak dikirim ke klien)…' });
    const notesCard = el('div', { class: 'card' }, el('h2', { text: 'Catatan internal' }), note,
      el('div', { style: 'margin-top:8px' }, el('button', { class: 'btn', text: 'Tambah catatan', onclick: guard(async () => { await api(`/submissions/${id}/note`, { method: 'POST', body: { note: note.value } }); toast('Catatan ditambahkan'); route(); }) }),
        ' ', el('button', { class: 'btn', text: 'Cek ulang konflik', onclick: guard(async () => { const r = await api(`/submissions/${id}/recheck-conflict`, { method: 'POST' }); toast(`${r.hits.length} indikasi konflik`); route(); }) })));

    const ai = s.ai ? el('div', { class: 'card' }, el('h2', { text: '🤖 Ringkasan AI untuk tim' }),
      el('p', { text: s.ai.summary }),
      s.ai.key_issues?.length ? el('div', {}, el('div', { class: 'section-title', text: 'Isu utama' }), el('ul', {}, s.ai.key_issues.map((x) => el('li', { text: x })))) : null,
      s.ai.missing_info?.length ? el('div', {}, el('div', { class: 'section-title', text: 'Perlu ditanyakan ke klien' }), el('ul', {}, s.ai.missing_info.map((x) => el('li', { text: x }))),
        el('button', { class: 'btn sm', text: 'Gunakan sebagai permintaan info', onclick: () => { statusSel.value = 'perlu_info'; updHint(); msg.value = s.ai.missing_info.map((x) => `- ${x}`).join('\n'); msg.focus(); } })) : null,
      s.ai.risk_notes ? el('p', { class: 'muted', text: `Risiko: ${s.ai.risk_notes}` }) : null,
      el('p', { class: 'muted small', text: 'Dihasilkan otomatis — verifikasi sebelum digunakan. Bukan nasihat hukum.' })) : null;

    const EVENT = { created: 'Registrasi diterima', status: 'Perubahan status', note: 'Catatan', email: 'Email lanjutan dari klien', conflict: 'Pemeriksaan konflik', assign: 'Penugasan', whatsapp: 'Pesan WhatsApp dari klien' };
    const timeline = el('div', { class: 'card' }, el('h2', { text: 'Riwayat' }), el('ul', { class: 'timeline' }, s.events.map((e) => el('li', {},
      el('div', { class: 'when', text: `${fmt(e.created_at)} · ${e.actor}` }),
      el('strong', { text: EVENT[e.type] || e.type }),
      e.type === 'status' ? el('div', { text: `${STATUSES[e.payload.from] || e.payload.from} → ${STATUSES[e.payload.to] || e.payload.to}${e.payload.notified ? ' (klien diberi tahu)' : ''}` }) : null,
      e.payload.message ? el('div', { class: 'pre', text: e.payload.message }) : null,
      e.payload.note ? el('div', { class: 'pre', text: e.payload.note }) : null,
      e.payload.snippet ? el('div', { class: 'muted', text: `${e.payload.subject || ''} — ${e.payload.snippet}` }) : null,
      e.type === 'conflict' ? el('div', { class: 'muted', text: `${e.payload.hits} indikasi` }) : null,
      e.type === 'assign' ? el('div', { text: `${e.payload.from || '—'} → ${e.payload.to || '—'}` }) : null,
      e.type === 'whatsapp' ? el('div', { class: 'pre', text: `${e.payload.from}: ${e.payload.text}` }) : null))));

    v.append(el('div', { class: 'split' },
      el('div', {}, answers, s.inquiry ? el('div', { class: 'card' }, el('h2', { text: `Email awal (${s.inquiry.ref})` }), el('div', { class: 'pre', text: `${s.inquiry.subject || ''}\n\n${s.inquiry.body_text || ''}` })) : null),
      el('div', {}, actions, assignCard, ai, notesCard, timeline, notifCard(s.notifications))));
  };

  // ================================================================ form builder
  const TYPE_LABEL = { text: 'Teks singkat', textarea: 'Teks panjang', email: 'Email', tel: 'Telepon/WhatsApp', number: 'Angka', date: 'Tanggal', select: 'Pilihan (dropdown)', radio: 'Pilihan tunggal (radio)', checkboxes: 'Pilihan ganda (centang)', checkbox: 'Persetujuan (satu centang)', file: 'Unggah berkas', info: 'Teks informasi' };
  const ROLE_LABEL = { client_name: 'Nama klien', client_email: 'Email klien (untuk konfirmasi)', client_phone: 'No. WhatsApp klien', matter_type: 'Bidang hukum', urgency: 'Urgensi', opposing_party: 'Pihak lawan (cek konflik)', description: 'Uraian masalah' };

  routes.form = async () => {
    const row = await api('/settings/form');
    let form = deep(row.value);
    let sel = null; // {s, f}
    let jsonMode = false;
    const v = clear(view());
    const msgBox = el('div');
    const left = el('div');
    const right = el('div', { class: 'card editor-panel' });
    const markDirty = () => { dirty = true; saveBtn.textContent = '💾 Simpan (ada perubahan)'; };

    const saveBtn = el('button', { class: 'btn primary', text: '💾 Simpan versi baru', onclick: guard(async () => {
      if (jsonMode) { try { form = JSON.parse($('#json-edit').value); } catch (e) { throw new Error(`JSON tidak valid: ${e.message}`); } }
      clear(msgBox);
      try {
        const r = await api('/settings/form', { method: 'PUT', body: { value: form } });
        dirty = false; saveBtn.textContent = '💾 Simpan versi baru';
        msgBox.append(el('div', { class: 'alert ok', text: `Tersimpan sebagai versi ${r.version}. Formulir publik langsung menggunakan versi ini; registrasi lama tetap ditampilkan dengan versinya masing-masing.` }));
      } catch (err) { msgBox.append(errorBox(err)); }
    }) });

    v.append(pageHead('Formulir Registrasi', `Versi aktif ${row.version} · diubah ${fmt(row.updatedAt)} oleh ${row.updatedBy || '-'}`,
      el('a', { class: 'btn', href: '/daftar', target: '_blank', rel: 'noopener', text: '👁 Lihat formulir publik' }),
      el('button', { class: 'btn', text: '{ } Mode JSON', onclick: () => { jsonMode = !jsonMode; render(); } }),
      el('button', { class: 'btn', text: '🕘 Riwayat versi', onclick: () => versionDialog('form', (val) => { form = val; markDirty(); render(); }) }),
      el('button', { class: 'btn danger', text: 'Reset ke bawaan', onclick: guard(async () => { if (!confirm('Kembalikan formulir ke template bawaan? (versi lama tetap tersimpan di riwayat)')) return; await api('/settings/form/reset', { method: 'POST' }); dirty = false; route(); }) }),
      saveBtn), msgBox);
    const body = el('div', { class: 'builder' }, left, right);
    v.append(body);

    const render = noReentry(() => {
      clear(left); clear(right);
      if (jsonMode) {
        body.style.gridTemplateColumns = '1fr';
        right.hidden = true;
        left.append(el('div', { class: 'card' }, el('p', { class: 'muted', text: 'Edit langsung struktur formulir (untuk pengguna mahir). Klik Simpan untuk validasi & menyimpan.' }),
          el('textarea', { class: 'code', id: 'json-edit', value: JSON.stringify(form, null, 2), oninput: markDirty })));
        return;
      }
      body.style.gridTemplateColumns = '';
      right.hidden = false;
      // General settings
      left.append(el('div', { class: 'card' }, el('h2', { text: 'Pengaturan umum' }),
        txt('Judul formulir', form.title, (x) => { form.title = x; }),
        area('Pengantar', form.intro, (x) => { form.intro = x; }),
        el('div', { class: 'grid cols-2' }, txt('Label tombol kirim', form.submitLabel, (x) => { form.submitLabel = x; }), txt('Pesan sukses', form.successMessage, (x) => { form.successMessage = x; })),
        area('Disclaimer (di bawah formulir)', form.disclaimer, (x) => { form.disclaimer = x; })));

      form.sections.forEach((s, si) => {
        const sec = el('div', { class: 'b-section' });
        sec.append(el('div', { class: 'b-section-head' },
          el('strong', { text: `${si + 1}. ${s.title}` }),
          iconBtn('✎', 'Edit bagian', () => { sel = { s: si, f: null }; render(); }),
          iconBtn('↑', 'Naikkan', () => { move(form.sections, si, -1); markDirty(); render(); }),
          iconBtn('↓', 'Turunkan', () => { move(form.sections, si, 1); markDirty(); render(); }),
          iconBtn('🗑', 'Hapus bagian', () => { if (confirm(`Hapus bagian "${s.title}" beserta field-nya?`)) { form.sections.splice(si, 1); sel = null; markDirty(); render(); } })));
        s.fields.forEach((f, fi) => {
          const selected = sel && sel.s === si && sel.f === fi;
          sec.append(el('div', { class: `b-field${selected ? ' selected' : ''}`, onclick: () => { sel = { s: si, f: fi }; render(); } },
            el('div', { class: 't' }, el('div', { class: 'lbl', text: f.label }),
              el('div', { class: 'meta', text: [TYPE_LABEL[f.type] || f.type, f.required ? 'wajib' : 'opsional', f.role ? `peran: ${ROLE_LABEL[f.role]}` : null, f.showIf ? `tampil jika ${f.showIf.field} = ${f.showIf.equals}` : null, `id: ${f.id}`].filter(Boolean).join(' · ') })),
            iconBtn('↑', 'Naikkan', (e) => { e.stopPropagation(); moveField(si, fi, -1); }),
            iconBtn('↓', 'Turunkan', (e) => { e.stopPropagation(); moveField(si, fi, 1); }),
            iconBtn('⧉', 'Duplikat', (e) => { e.stopPropagation(); const c = deep(f); c.id = uniqueId(`${f.id}_salinan`); delete c.role; s.fields.splice(fi + 1, 0, c); markDirty(); render(); }),
            iconBtn('🗑', 'Hapus', (e) => { e.stopPropagation(); if (confirm(`Hapus field "${f.label}"?`)) { s.fields.splice(fi, 1); sel = null; markDirty(); render(); } })));
        });
        sec.append(el('div', { style: 'padding:8px 12px' }, el('button', { class: 'btn sm', text: '+ Tambah field', onclick: () => {
          s.fields.push({ id: uniqueId('field_baru'), type: 'text', label: 'Pertanyaan baru', required: false });
          sel = { s: si, f: s.fields.length - 1 }; markDirty(); render();
        } })));
        left.append(sec);
      });
      left.append(el('button', { class: 'btn', text: '+ Tambah bagian (langkah formulir)', onclick: () => {
        form.sections.push({ id: uniqueSectionId('bagian_baru'), title: 'Bagian baru', description: '', fields: [] });
        sel = { s: form.sections.length - 1, f: null }; markDirty(); render();
      } }));
      renderEditor();
    });

    function renderEditor() {
      if (!sel) {
        right.append(el('h2', { text: 'Editor' }), el('p', { class: 'muted', text: 'Pilih field atau bagian di sebelah kiri untuk mengubahnya.' }),
          el('div', { class: 'alert info' }, el('strong', { text: 'Tips: ' }), 'Setiap bagian menjadi satu langkah di formulir klien. Field dengan "peran" dipakai sistem: email klien untuk konfirmasi, pihak lawan untuk cek konflik, dll. Perubahan disimpan sebagai versi baru — data lama tidak hilang.'));
        return;
      }
      const s = form.sections[sel.s];
      if (sel.f == null) {
        right.append(el('h2', { text: 'Edit bagian' }),
          txt('Judul bagian', s.title, (x) => { s.title = x; render(); }),
          area('Deskripsi', s.description, (x) => { s.description = x; }),
          txt('ID bagian', s.id, (x) => { s.id = slug(x); }, 'huruf kecil/angka/underscore'));
        return;
      }
      const f = s.fields[sel.f];
      const allFields = form.sections.flatMap((x) => x.fields).filter((x) => x !== f && ['select', 'radio', 'checkboxes'].includes(x.type));
      const typeSel = el('select', { onchange: (e) => { f.type = e.target.value; if (['select', 'radio', 'checkboxes'].includes(f.type) && !f.options?.length) f.options = ['Pilihan 1', 'Pilihan 2']; markDirty(); render(); } },
        Object.entries(TYPE_LABEL).map(([k, l]) => el('option', { value: k, text: l, selected: f.type === k })));
      const roleSel = el('select', { onchange: (e) => { if (e.target.value) f.role = e.target.value; else delete f.role; markDirty(); render(); } },
        el('option', { value: '', text: '— Tidak ada —' }), Object.entries(ROLE_LABEL).map(([k, l]) => el('option', { value: k, text: l, selected: f.role === k })));
      const isNew = /^field_baru/.test(f.id);
      right.append(...[el('h2', { text: 'Edit field' }),
        area(f.type === 'info' ? 'Teks informasi' : 'Label / pertanyaan', f.label, (x) => { f.label = x; if (isNew) f.id = uniqueId(slug(x), f); render(); }),
        el('label', { class: 'f' }, 'Tipe jawaban', typeSel),
        f.type !== 'info' ? el('label', { class: 'inline' }, el('input', { type: 'checkbox', checked: f.required, onchange: (e) => { f.required = e.target.checked; markDirty(); render(); } }), 'Wajib diisi') : null,
        ['select', 'radio', 'checkboxes'].includes(f.type) ? area('Pilihan jawaban (satu per baris)', (f.options || []).join('\n'), (x) => { f.options = x.split('\n').map((o) => o.trim()).filter(Boolean); }, 'Mengubah teks pilihan tidak mengubah data registrasi lama.') : null,
        ['text', 'textarea', 'email', 'tel', 'number'].includes(f.type) ? txt('Placeholder (contoh isian)', f.placeholder, (x) => { f.placeholder = x || undefined; }) : null,
        f.type !== 'info' ? area('Teks bantuan', f.help, (x) => { f.help = x || undefined; }) : null,
        ['text', 'textarea'].includes(f.type) ? el('div', { class: 'grid cols-2' },
          num('Minimal karakter', f.minLength, (x) => { f.minLength = x || undefined; }), num('Maksimal karakter', f.maxLength, (x) => { f.maxLength = x || undefined; })) : null,
        f.type === 'file' ? el('div', {}, el('label', { class: 'inline' }, el('input', { type: 'checkbox', checked: f.multiple, onchange: (e) => { f.multiple = e.target.checked; markDirty(); } }), 'Boleh lebih dari satu berkas'),
          txt('Tipe berkas diterima', f.accept || '.pdf,.jpg,.jpeg,.png,.docx', (x) => { f.accept = x; }, 'Server hanya menerima PDF, JPG, PNG, DOCX (diverifikasi isi berkasnya).')) : null,
        f.type !== 'info' ? el('label', { class: 'f' }, 'Peran khusus (dipakai sistem)', roleSel, el('span', { class: 'hint', text: 'Setiap peran hanya untuk satu field. "Email klien" dan "Nama klien" wajib ada.' })) : null,
        el('div', { class: 'section-title', text: 'Tampilkan bersyarat' }),
        showIfEditor(f, allFields),
        txt('ID field (teknis)', f.id, (x) => { f.id = slug(x); render(); }, 'Dipakai di data & ekspor CSV. Hindari mengubah ID field yang sudah dipakai.')].filter(Boolean));
    }

    function showIfEditor(f, candidates) {
      const fieldSel = el('select', { onchange: (e) => {
        if (!e.target.value) delete f.showIf;
        else { const dep = candidates.find((x) => x.id === e.target.value); f.showIf = { field: dep.id, equals: dep.options[0] }; }
        markDirty(); render();
      } }, el('option', { value: '', text: 'Selalu tampil' }), candidates.map((c) => el('option', { value: c.id, text: `Jika "${c.label}"`, selected: f.showIf?.field === c.id })));
      const dep = f.showIf && candidates.find((x) => x.id === f.showIf.field);
      const valSel = dep ? el('select', { onchange: (e) => { f.showIf.equals = e.target.value; markDirty(); render(); } },
        dep.options.map((o) => el('option', { value: o, text: `= ${o}`, selected: f.showIf.equals === o }))) : null;
      return el('div', { class: 'grid', style: 'gap:6px;margin-bottom:10px' }, fieldSel, valSel);
    }

    function uniqueId(base, self) {
      const ids = new Set(form.sections.flatMap((s) => s.fields).filter((x) => x !== self).map((x) => x.id));
      let id = slug(base); let i = 2;
      while (ids.has(id)) id = `${slug(base)}_${i++}`;
      return id;
    }
    function uniqueSectionId(base) {
      const ids = new Set(form.sections.map((s) => s.id)); let id = base; let i = 2;
      while (ids.has(id)) id = `${base}_${i++}`;
      return id;
    }
    function moveField(si, fi, d) {
      const fields = form.sections[si].fields;
      const to = fi + d;
      if (to < 0) { if (si > 0) { form.sections[si - 1].fields.push(fields.splice(fi, 1)[0]); sel = { s: si - 1, f: form.sections[si - 1].fields.length - 1 }; } }
      else if (to >= fields.length) { if (si < form.sections.length - 1) { form.sections[si + 1].fields.unshift(fields.splice(fi, 1)[0]); sel = { s: si + 1, f: 0 }; } }
      else { move(fields, fi, d); sel = { s: si, f: to }; }
      markDirty(); render();
    }
    // input helpers bound to markDirty
    function txt(label, value, set, hint) { return el('label', { class: 'f' }, label, el('input', { type: 'text', value: value || '', onchange: (e) => { set(e.target.value); markDirty(); } }), hint ? el('span', { class: 'hint', text: hint }) : null); }
    function area(label, value, set, hint) { return el('label', { class: 'f' }, label, el('textarea', { value: value || '', onchange: (e) => { set(e.target.value); markDirty(); } }), hint ? el('span', { class: 'hint', text: hint }) : null); }
    function num(label, value, set) { return el('label', { class: 'f' }, label, el('input', { type: 'number', min: 0, value: value ?? '', onchange: (e) => { set(Number(e.target.value)); markDirty(); } })); }
    render();
  };

  const move = (arr, i, d) => { const j = i + d; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; };
  const iconBtn = (icon, title, fn) => el('button', { class: 'icon-btn', type: 'button', title, 'aria-label': title, text: icon, onclick: fn });

  async function versionDialog(key, onLoad) {
    const hist = await api(`/settings/${key}/history`);
    const v = view();
    const box = el('div', { class: 'card' }, el('h2', { text: 'Riwayat versi' }), el('p', { class: 'muted', text: 'Muat versi lama ke editor, lalu klik Simpan untuk mengaktifkannya kembali.' }),
      simpleTable(['Versi', 'Waktu', 'Oleh', ''], hist.map((h) => ({
        cells: [String(h.version), fmt(h.updated_at), h.updated_by || '-', el('button', { class: 'btn sm', text: 'Muat ke editor', onclick: guard(async () => { const r = await api(`/settings/${key}/version/${h.version}`); onLoad(r.value); box.remove(); toast(`Versi ${h.version} dimuat — klik Simpan untuk mengaktifkan`); }) })],
      }))), el('button', { class: 'btn', text: 'Tutup', onclick: () => box.remove() }));
    v.insertBefore(box, v.children[1] || null);
  }

  // ================================================================ chatbot editor
  const ACTION_LABEL = { open_form: 'Buka formulir registrasi', check_status: 'Cek status pendaftaran', whatsapp: 'Buka WhatsApp kantor', link: 'Buka tautan', restart: 'Mulai ulang' };
  routes.chatbot = async () => {
    const row = await api('/settings/chatbot');
    let flow = deep(row.value);
    let selId = flow.start;
    let jsonMode = false;
    const v = clear(view());
    const msgBox = el('div');
    const left = el('div');
    const right = el('div', { class: 'card editor-panel' });
    const markDirty = () => { dirty = true; };

    v.append(pageHead('Alur Chatbot', `Versi ${row.version} · Variabel: {{firm_name}}, {{office_hours}}, {{sla_hours}}, {{firm_phone}}`,
      el('a', { class: 'btn', href: '/', target: '_blank', rel: 'noopener', text: '👁 Coba chatbot' }),
      el('button', { class: 'btn', text: '{ } Mode JSON', onclick: () => { jsonMode = !jsonMode; render(); } }),
      el('button', { class: 'btn', text: '🕘 Riwayat versi', onclick: () => versionDialog('chatbot', (val) => { flow = val; markDirty(); render(); }) }),
      el('button', { class: 'btn danger', text: 'Reset ke bawaan', onclick: guard(async () => { if (!confirm('Kembalikan alur chatbot ke bawaan?')) return; await api('/settings/chatbot/reset', { method: 'POST' }); dirty = false; route(); }) }),
      el('button', { class: 'btn primary', text: '💾 Simpan', onclick: guard(async () => {
        if (jsonMode) { try { flow = JSON.parse($('#json-edit').value); } catch (e) { throw new Error(`JSON tidak valid: ${e.message}`); } }
        clear(msgBox);
        try { const r = await api('/settings/chatbot', { method: 'PUT', body: { value: flow } }); dirty = false; msgBox.append(el('div', { class: 'alert ok', text: `Tersimpan (versi ${r.version}).` })); } catch (err) { msgBox.append(errorBox(err)); }
      }) })), msgBox);
    const body = el('div', { class: 'builder' }, left, right);
    v.append(body);

    const render = noReentry(() => {
      clear(left); clear(right);
      if (jsonMode) {
        right.hidden = true; body.style.gridTemplateColumns = '1fr';
        left.append(el('div', { class: 'card' }, el('textarea', { class: 'code', id: 'json-edit', value: JSON.stringify(flow, null, 2), oninput: markDirty })));
        return;
      }
      right.hidden = false; body.style.gridTemplateColumns = '';
      left.append(el('div', { class: 'card' }, el('div', { class: 'grid cols-2' },
        el('label', { class: 'f' }, 'Nama asisten', el('input', { type: 'text', value: flow.botName || '', onchange: (e) => { flow.botName = e.target.value; markDirty(); } })),
        el('label', { class: 'f' }, 'Langkah awal', el('select', { onchange: (e) => { flow.start = e.target.value; markDirty(); render(); } }, Object.keys(flow.nodes).map((id) => el('option', { value: id, text: id, selected: id === flow.start })))))));
      const list = el('div', { class: 'b-section' }, el('div', { class: 'b-section-head' }, el('strong', { text: 'Langkah percakapan' })));
      for (const [id, node] of Object.entries(flow.nodes)) {
        list.append(el('div', { class: `b-field${id === selId ? ' selected' : ''}`, onclick: () => { selId = id; render(); } },
          el('div', { class: 't' }, el('div', { class: 'lbl', text: `${id}${id === flow.start ? ' (awal)' : ''}` }),
            el('div', { class: 'meta', text: `${node.messages[0]?.slice(0, 80) || ''} · ${(node.options || []).length} pilihan` })),
          iconBtn('🗑', 'Hapus', (e) => {
            e.stopPropagation();
            if (id === flow.start) return toast('Langkah awal tidak dapat dihapus', 'error');
            const refs = Object.entries(flow.nodes).filter(([, n]) => (n.options || []).some((o) => o.next === id)).map(([k]) => k);
            if (refs.length) return toast(`Masih dirujuk oleh: ${refs.join(', ')}`, 'error');
            if (confirm(`Hapus langkah "${id}"?`)) { delete flow.nodes[id]; selId = flow.start; markDirty(); render(); }
          })));
      }
      list.append(el('div', { style: 'padding:8px 12px' }, el('button', { class: 'btn sm', text: '+ Tambah langkah', onclick: () => {
        const id = prompt('ID langkah baru (huruf kecil/angka/underscore):', 'langkah_baru');
        if (!id) return;
        const clean = slug(id);
        if (flow.nodes[clean]) return toast('ID sudah ada', 'error');
        flow.nodes[clean] = { messages: ['Tulis pesan di sini.'], options: [{ label: 'Kembali ke menu', next: flow.start }] };
        selId = clean; markDirty(); render();
      } })));
      left.append(list);
      renderNode();
    });

    function renderNode() {
      const node = flow.nodes[selId];
      if (!node) return;
      right.append(el('h2', { text: `Langkah: ${selId}` }),
        el('label', { class: 'f' }, 'Pesan bot', el('textarea', { style: 'min-height:140px', value: node.messages.join('\n\n---\n\n'), onchange: (e) => { node.messages = e.target.value.split(/\n\s*---\s*\n/).map((m) => m.trim()).filter(Boolean); markDirty(); render(); } }),
          el('span', { class: 'hint', text: 'Pisahkan beberapa gelembung pesan dengan baris berisi ---' })),
        el('div', { class: 'section-title', text: 'Pilihan jawaban untuk pengguna' }));
      (node.options || []).forEach((o, i) => {
        const kind = o.next ? 'next' : 'action';
        const kindSel = el('select', { onchange: (e) => { if (e.target.value === 'next') { delete o.action; delete o.url; o.next = flow.start; } else { delete o.next; o.action = 'open_form'; } markDirty(); render(); } },
          el('option', { value: 'next', text: 'Ke langkah', selected: kind === 'next' }), el('option', { value: 'action', text: 'Aksi', selected: kind === 'action' }));
        const target = kind === 'next'
          ? el('select', { onchange: (e) => { o.next = e.target.value; markDirty(); } }, Object.keys(flow.nodes).map((id) => el('option', { value: id, text: id, selected: o.next === id })))
          : el('select', { onchange: (e) => { o.action = e.target.value; markDirty(); render(); } }, Object.entries(ACTION_LABEL).map(([k, l]) => el('option', { value: k, text: l, selected: o.action === k })));
        right.append(el('div', { class: 'opt-row' },
          el('input', { type: 'text', value: o.label, onchange: (e) => { o.label = e.target.value; markDirty(); } }), kindSel, target,
          el('span', {}, iconBtn('↑', 'Naikkan', () => { move(node.options, i, -1); markDirty(); render(); }), iconBtn('🗑', 'Hapus', () => { node.options.splice(i, 1); markDirty(); render(); }))));
        if (o.action === 'link') right.append(el('input', { type: 'text', placeholder: 'https://…', value: o.url || '', style: 'margin-bottom:8px', onchange: (e) => { o.url = e.target.value; markDirty(); } }));
      });
      right.append(el('button', { class: 'btn sm', text: '+ Tambah pilihan', onclick: () => { (node.options ||= []).push({ label: 'Pilihan baru', next: flow.start }); markDirty(); render(); } }));
    }
    render();
  };

  // ================================================================ templates
  const TPL_INFO = {
    email: {
      inquiry_autoreply: ['Balasan otomatis email baru (ke klien)', 'inquiry'],
      inquiry_followup_ack: ['Balasan email lanjutan dari pendaftar (ke klien)', 'both'],
      invite_reminder: ['Pengingat isi formulir (ke klien, 1x)', 'inquiry'],
      submission_client: ['Konfirmasi registrasi (ke klien)', 'submission'],
      submission_team: ['Registrasi baru (ke email tim)', 'submission'],
      status_ditinjau: ['Status: sedang ditinjau', 'status'],
      status_perlu_info: ['Status: perlu informasi tambahan', 'status'],
      status_dijadwalkan: ['Status: konsultasi dijadwalkan', 'status'],
      status_diterima: ['Status: diterima sebagai klien', 'status'],
      status_ditolak: ['Status: tidak dapat ditangani', 'status'],
      sla_team: ['Eskalasi SLA (ke email tim)', 'sla'],
      assignment_staff: ['Penugasan (ke email staf)', 'assign'],
    },
    whatsapp: {
      inquiry_team: ['Email masuk baru (ke WA tim)', 'inquiry'],
      submission_team: ['Registrasi baru (ke WA tim)', 'submission'],
      submission_client: ['Konfirmasi registrasi (ke WA klien)', 'submission'],
      status_client: ['Perubahan status (ke WA klien)', 'status'],
      sla_team: ['Peringatan SLA (ke WA tim)', 'sla'],
      assignment_staff: ['Penugasan (ke WA staf)', 'assign'],
    },
    telegram: {
      inquiry_team: ['Email masuk baru (ke Telegram tim)', 'inquiry'],
      submission_team: ['Registrasi baru (ke Telegram tim)', 'submission'],
      sla_team: ['Peringatan SLA (ke Telegram tim)', 'sla'],
      digest_team: ['Ringkasan harian (ke Telegram tim)', 'digest'],
      wa_inbound_team: ['Pesan WhatsApp masuk dari klien (ke Telegram tim)', 'wa'],
    },
  };
  const VARS = {
    common: ['firm_name', 'firm_phone', 'firm_email', 'office_hours', 'sla_hours', 'signature'],
    inquiry: ['ref', 'client_name', 'from_email', 'subject', 'snippet', 'office_hours_note', 'form_link', 'ai_category', 'security_text', 'autoreply_text', 'admin_link'],
    submission: ['reg_no', 'client_name', 'client_email', 'client_phone', 'matter_type', 'urgency', 'urgency_tag', 'preferred_contact', 'submitted_at', 'sla_due', 'status_label', 'status_link', 'admin_link', 'conflict_text', 'ai_summary', 'description_snippet', '{summary_html}'],
    status: ['reg_no', 'client_name', 'status_label', 'status_link', 'custom_message', 'matter_type'],
    sla: ['reg_no', 'client_name', 'matter_type', 'urgency', 'age_hours', 'admin_link'],
    assign: ['reg_no', 'client_name', 'matter_type', 'urgency', 'conflict_text', 'sla_due', 'ai_summary', 'staff_name', 'assigned_by', 'assign_note', 'admin_link'],
    wa: ['wa_from', 'wa_name', 'wa_text', 'reg_no', 'client_name', 'admin_link'],
    digest: ['date', 'inquiries_24h', 'submissions_24h', 'pending_review', 'overdue', 'failed_notifications'],
  };
  VARS.both = [...new Set([...VARS.inquiry, ...VARS.submission])];

  routes.templates = async () => {
    const row = await api('/settings/templates');
    const tpl = deep(row.value);
    let cur = { ch: 'email', key: 'inquiry_autoreply' };
    const v = clear(view());
    const msgBox = el('div');
    const listBox = el('div', { class: 'card tpl-list' });
    const editBox = el('div', { class: 'card' });
    const prevBox = el('div', { class: 'card' });
    const markDirty = () => { dirty = true; };

    v.append(pageHead('Template Pesan', `Versi ${row.version} — seluruh email, WhatsApp, dan Telegram yang dikirim agen`,
      el('button', { class: 'btn', text: '🕘 Riwayat versi', onclick: () => versionDialog('templates', (val) => { Object.assign(tpl, val); markDirty(); render(); }) }),
      el('button', { class: 'btn danger', text: 'Reset ke bawaan', onclick: guard(async () => { if (!confirm('Kembalikan semua template ke bawaan?')) return; await api('/settings/templates/reset', { method: 'POST' }); dirty = false; route(); }) }),
      el('button', { class: 'btn primary', text: '💾 Simpan', onclick: guard(async () => {
        clear(msgBox);
        try { const r = await api('/settings/templates', { method: 'PUT', body: { value: tpl } }); dirty = false; msgBox.append(el('div', { class: 'alert ok', text: `Tersimpan (versi ${r.version}).` })); } catch (err) { msgBox.append(errorBox(err)); }
      }) })), msgBox);
    v.append(el('div', { class: 'tpl-layout' }, listBox, el('div', {}, editBox, prevBox)));

    function render() {
      clear(listBox);
      for (const ch of ['email', 'whatsapp', 'telegram']) {
        listBox.append(el('div', { class: 'section-title', text: { email: 'Email', whatsapp: 'WhatsApp', telegram: 'Telegram' }[ch] }));
        for (const [key, [label]] of Object.entries(TPL_INFO[ch])) {
          listBox.append(el('a', { href: '#templates', class: cur.ch === ch && cur.key === key ? 'active' : '', text: label, onclick: (e) => { e.preventDefault(); cur = { ch, key }; render(); } }));
        }
      }
      clear(editBox);
      const [label, group] = TPL_INFO[cur.ch][cur.key];
      const vars = [...VARS.common, ...VARS[group]];
      const insertVar = (name) => {
        const target = document.activeElement?.dataset?.tpl ? document.activeElement : $('[data-tpl="body"]', editBox);
        const token = `{{${name}}}`;
        const s = target.selectionStart ?? target.value.length;
        target.value = target.value.slice(0, s) + token + target.value.slice(target.selectionEnd ?? s);
        target.dispatchEvent(new Event('input'));
        target.focus();
      };
      editBox.append(el('h2', { text: label }),
        el('div', { class: 'muted small', style: 'margin-bottom:6px', text: 'Klik variabel untuk menyisipkan:' }),
        el('div', { class: 'vars', style: 'margin-bottom:12px' }, vars.map((n) => el('code', { text: `{{${n}}}`, onclick: () => insertVar(n) }))));
      if (cur.ch === 'email') {
        const t = tpl.email[cur.key] ||= { subject: '', body: '' };
        editBox.append(
          el('label', { class: 'f' }, 'Subjek', el('input', { type: 'text', 'data-tpl': 'subject', value: t.subject, oninput: (e) => { t.subject = e.target.value; markDirty(); preview(); } })),
          el('label', { class: 'f' }, 'Isi', el('textarea', { 'data-tpl': 'body', style: 'min-height:320px', value: t.body, oninput: (e) => { t.body = e.target.value; markDirty(); preview(); } }),
            el('span', { class: 'hint', text: 'Paragraf dipisah baris kosong. Baris diawali "- " menjadi daftar. [button:Teks|{{tautan}}] menjadi tombol. [highlight:{{reg_no}}] menjadi kotak sorotan. {{#var}}…{{/var}} hanya tampil bila var terisi.' })));
      } else {
        editBox.append(el('label', { class: 'f' }, 'Isi pesan', el('textarea', { 'data-tpl': 'body', style: 'min-height:220px', value: tpl[cur.ch][cur.key] || '', oninput: (e) => { tpl[cur.ch][cur.key] = e.target.value; markDirty(); preview(); } }),
          el('span', { class: 'hint', text: cur.ch === 'whatsapp' ? 'Format WhatsApp: *tebal*, _miring_.' : 'Format Telegram HTML: <b>tebal</b>, <i>miring</i>. Nilai variabel otomatis di-escape.' })));
      }
      preview();
    }

    const preview = debounce(guard(async () => {
      clear(prevBox).append(el('h2', { text: 'Pratinjau (data contoh)' }));
      if (cur.ch === 'email') {
        const r = await api('/preview', { method: 'POST', body: { channel: 'email', template: tpl.email[cur.key] } });
        prevBox.append(el('p', {}, el('strong', { text: 'Subjek: ' }), r.subject), el('iframe', { class: 'preview', sandbox: '', srcdoc: r.html, title: 'Pratinjau email' }));
      } else {
        const r = await api('/preview', { method: 'POST', body: { channel: cur.ch, template: tpl[cur.ch][cur.key] } });
        prevBox.append(el('div', { class: 'pre', text: r.text ?? r.html }));
      }
    }), 400);
    render();
  };

  // ================================================================ office settings
  routes.settings = async () => {
    const row = await api('/settings/office');
    const o = deep(row.value);
    o.officeHours ||= { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00', label: '' };
    const v = clear(view());
    const msgBox = el('div');
    const f = (label, key, hint, type = 'text') => el('label', { class: 'f' }, label, el('input', { type, value: o[key] ?? '', onchange: (e) => { o[key] = type === 'number' ? Number(e.target.value) : e.target.value; dirty = true; } }), hint ? el('span', { class: 'hint', text: hint }) : null);
    const DAYS = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
    v.append(pageHead('Profil Kantor', 'Ditampilkan di chatbot, formulir, dan seluruh email', el('button', { class: 'btn primary', text: '💾 Simpan', onclick: guard(async () => {
      clear(msgBox);
      try { await api('/settings/office', { method: 'PUT', body: { value: o } }); dirty = false; msgBox.append(el('div', { class: 'alert ok', text: 'Profil kantor tersimpan.' })); $('#side-firm').textContent = o.name; } catch (err) { msgBox.append(errorBox(err)); }
    }) })), msgBox);
    v.append(el('div', { class: 'grid cols-2' },
      el('div', { class: 'card' }, el('h2', { text: 'Identitas' }),
        f('Nama kantor', 'name'), f('Tagline', 'tagline'), f('Alamat', 'address'), f('Telepon', 'phone'),
        f('WhatsApp kantor', 'whatsapp', 'Format internasional tanpa +, mis. 6281234567890 (untuk tombol WA di chatbot)'),
        f('Email kantor', 'email'), f('Situs web', 'website'), f('URL logo (https)', 'logoUrl'),
        f('Tanda tangan email', 'signature', 'Contoh: Tim Penerimaan Klien'),
        el('div', { class: 'grid cols-2' }, f('Warna utama', 'brandColor', '#RRGGBB'), f('Warna aksen', 'accentColor', '#RRGGBB'))),
      el('div', {},
        el('div', { class: 'card' }, el('h2', { text: 'Jam kerja & komitmen layanan' }),
          el('div', { style: 'margin-bottom:10px' }, DAYS.map((d, i) => el('label', { class: 'inline' }, el('input', { type: 'checkbox', checked: o.officeHours.days.includes(i), onchange: (e) => { o.officeHours.days = e.target.checked ? [...o.officeHours.days, i].sort() : o.officeHours.days.filter((x) => x !== i); dirty = true; } }), d))),
          el('div', { class: 'grid cols-2' },
            el('label', { class: 'f' }, 'Jam buka', el('input', { type: 'time', value: o.officeHours.start, onchange: (e) => { o.officeHours.start = e.target.value; dirty = true; } })),
            el('label', { class: 'f' }, 'Jam tutup', el('input', { type: 'time', value: o.officeHours.end, onchange: (e) => { o.officeHours.end = e.target.value; dirty = true; } }))),
          el('label', { class: 'f' }, 'Teks jam kerja', el('input', { type: 'text', value: o.officeHours.label, onchange: (e) => { o.officeHours.label = e.target.value; dirty = true; } })),
          f('Target respons (jam)', 'slaHours', 'Dijanjikan ke klien & dipantau Agen Operasional', 'number'),
          f('Pengingat isi formulir setelah (jam)', 'inviteReminderHours', '0 = nonaktif. Dikirim sekali, hanya di jam kerja.', 'number'),
          f('Jam kirim ringkasan harian', 'dailyDigestHour', '0–23, waktu kantor', 'number')))));
  };

  // ================================================================ users (admin)
  let pendingTempPassword = null; // shown after the list re-renders following account creation
  routes.users = async () => {
    const { users, roles } = await api('/users');
    const v = clear(view());
    const notice = el('div');
    const showTemp = (username, pw) => {
      clear(notice).append(el('div', { class: 'alert ok' },
        el('strong', { text: `Kata sandi sementara untuk ${username}: ` }), el('code', { text: pw }),
        el('div', { class: 'small', text: 'Sampaikan secara langsung/terpisah (jangan lewat email yang sama). Ditampilkan sekali saja; pengguna wajib menggantinya saat login pertama.' }),
        el('button', { class: 'btn sm', style: 'margin-top:6px', text: 'Salin', onclick: () => navigator.clipboard?.writeText(pw).then(() => toast('Disalin')) })));
    };
    const form = {
      username: el('input', { type: 'text', placeholder: 'mis. rina' }),
      name: el('input', { type: 'text', placeholder: 'Nama lengkap' }),
      email: el('input', { type: 'email', placeholder: 'email@kantor.id' }),
      whatsapp: el('input', { type: 'text', placeholder: '08xxxxxxxxxx' }),
      role: el('select', {}, Object.entries(roles).map(([k, l]) => el('option', { value: k, text: l, selected: k === 'staf' }))),
      notify_email: el('input', { type: 'checkbox', checked: true }),
      notify_whatsapp: el('input', { type: 'checkbox' }),
    };
    v.append(pageHead('Pengguna', 'Akun staf untuk panel admin. Admin: semua fitur. Staf: email masuk, registrasi, penugasan, daftar pihak.'), notice);
    if (pendingTempPassword) { showTemp(...pendingTempPassword); pendingTempPassword = null; }
    v.append(el('div', { class: 'card' }, el('h2', { text: 'Tambah pengguna' }),
      el('div', { class: 'grid cols-3' },
        el('label', { class: 'f' }, 'Username', form.username), el('label', { class: 'f' }, 'Nama', form.name), el('label', { class: 'f' }, 'Peran', form.role),
        el('label', { class: 'f' }, 'Email', form.email), el('label', { class: 'f' }, 'WhatsApp', form.whatsapp),
        el('div', {}, el('div', { class: 'small muted', style: 'margin-bottom:6px', text: 'Terima notifikasi tim' }),
          el('label', { class: 'inline' }, form.notify_email, 'Email'), el('label', { class: 'inline' }, form.notify_whatsapp, 'WhatsApp'))),
      el('button', { class: 'btn primary', text: 'Buat akun', onclick: guard(async () => {
        const r = await api('/users', { method: 'POST', body: {
          username: form.username.value, name: form.name.value, email: form.email.value, whatsapp: form.whatsapp.value, role: form.role.value,
          notify_email: form.notify_email.checked, notify_whatsapp: form.notify_whatsapp.checked,
        } });
        pendingTempPassword = [r.user.username, r.tempPassword];
        await routes.users();
      }) })));

    const toggle = (u, key, label) => el('label', { class: 'inline' }, el('input', { type: 'checkbox', checked: Boolean(u[key]), onchange: guard(async (e) => {
      try { await api(`/users/${u.id}`, { method: 'PUT', body: { [key]: e.target.checked } }); toast('Disimpan'); } catch (err) { e.target.checked = !e.target.checked; throw err; }
    }) }), label);
    v.append(simpleTable(['Pengguna', 'Kontak', 'Peran', 'Notifikasi tim', 'Login terakhir', 'Status', ''], users.map((u) => ({
      cells: [
        el('div', {}, el('strong', { text: u.name }), el('div', { class: 'muted small', text: u.username }), u.must_change_password ? el('span', { class: 'badge warn', text: 'sandi sementara' }) : null),
        el('div', { class: 'small' }, el('div', { text: u.email || '—' }), el('div', { text: u.whatsapp || '—' })),
        el('select', { onchange: guard(async (e) => { await api(`/users/${u.id}`, { method: 'PUT', body: { role: e.target.value } }).catch((err) => { e.target.value = u.role; throw err; }); toast('Peran diubah'); }) },
          Object.entries(roles).map(([k, l]) => el('option', { value: k, text: l, selected: k === u.role }))),
        el('div', {}, toggle(u, 'notify_email', 'Email'), toggle(u, 'notify_whatsapp', 'WA')),
        fmt(u.last_login_at),
        badge(u.active ? 'ok' : 'arsip', u.active ? 'Aktif' : 'Nonaktif'),
        el('div', { class: 'toolbar' },
          el('button', { class: 'btn sm', text: 'Edit', onclick: () => editUser(u) }),
          el('button', { class: 'btn sm', text: 'Reset sandi', onclick: guard(async () => {
            if (!confirm(`Buat kata sandi sementara baru untuk ${u.username}? Sesi aktifnya akan diakhiri.`)) return;
            const r = await api(`/users/${u.id}/reset-password`, { method: 'POST' });
            showTemp(u.username, r.tempPassword);
          }) }),
          el('button', { class: `btn sm ${u.active ? 'danger' : ''}`, text: u.active ? 'Nonaktifkan' : 'Aktifkan', onclick: guard(async () => {
            if (u.active && !confirm(`Nonaktifkan ${u.username}? Ia langsung keluar dari panel.`)) return;
            await api(`/users/${u.id}`, { method: 'PUT', body: { active: !u.active } }); routes.users();
          }) })),
      ],
    }))));

    async function editUser(u) {
      const name = prompt('Nama', u.name); if (name == null) return;
      const email = prompt('Email (kosongkan bila tidak ada)', u.email || ''); if (email == null) return;
      const whatsapp = prompt('WhatsApp (kosongkan bila tidak ada)', u.whatsapp || ''); if (whatsapp == null) return;
      await guard(async () => { await api(`/users/${u.id}`, { method: 'PUT', body: { name, email, whatsapp } }); toast('Disimpan'); routes.users(); })();
    }
  };

  // ================================================================ my account
  routes.account = async () => {
    const me = await api('/me');
    clear(view()).append(pageHead('Akun Saya', `${me.name} · ${me.username} · peran ${me.role}`), el('div', { class: 'grid cols-2' }, passwordCard()));
  };

  function passwordCard() {
    const cur = el('input', { type: 'password', autocomplete: 'current-password' });
    const nxt = el('input', { type: 'password', autocomplete: 'new-password' });
    return el('div', { class: 'card' }, el('h2', { text: 'Ganti kata sandi admin' }),
      el('label', { class: 'f' }, 'Kata sandi saat ini', cur), el('label', { class: 'f' }, 'Kata sandi baru (min. 10 karakter)', nxt),
      el('button', { class: 'btn', text: 'Ganti kata sandi', onclick: guard(async () => { await api('/password', { method: 'POST', body: { current: cur.value, next: nxt.value } }); cur.value = ''; nxt.value = ''; toast('Kata sandi diganti'); }) }));
  }

  // ================================================================ parties (conflict list)
  routes.parties = async () => {
    const v = clear(view());
    const q = el('input', { type: 'text', placeholder: 'Cari nama…' });
    const box = el('div');
    const load = guard(async () => {
      const rows = await api(`/parties?q=${encodeURIComponent(q.value)}`);
      clear(box).append(simpleTable(['Nama', 'Peran', 'Ref. perkara', 'Catatan', ''], rows.map((p) => ({
        cells: [p.name, badge(p.role === 'klien' ? 'ok' : p.role === 'lawan' ? 'high' : '', p.role), p.matter_ref || '-', p.notes || '-',
          iconBtn('🗑', 'Hapus', guard(async () => { if (!confirm(`Hapus ${p.name}?`)) return; await api(`/parties/${p.id}`, { method: 'DELETE' }); load(); }))],
      }))));
    });
    q.addEventListener('input', debounce(load, 300));
    const name = el('input', { type: 'text', placeholder: 'Nama orang / badan usaha' });
    const role = el('select', {}, ['klien', 'lawan', 'terkait'].map((r) => el('option', { value: r, text: r })));
    const ref = el('input', { type: 'text', placeholder: 'No. perkara / ref internal' });
    const bulk = el('textarea', { placeholder: 'PT Maju Jaya;klien;PRK-2025-01\nBudi Santoso;lawan;PRK-2025-01' });
    v.append(pageHead('Daftar Pihak — Pemeriksaan Konflik', 'Agen Keamanan mencocokkan setiap registrasi dengan daftar ini dan riwayat registrasi'));
    v.append(el('div', { class: 'grid cols-2' },
      el('div', { class: 'card' }, el('h2', { text: 'Tambah pihak' }),
        el('div', { class: 'grid', style: 'grid-template-columns:2fr 1fr 1fr auto;gap:6px' }, name, role, ref,
          el('button', { class: 'btn primary', text: 'Tambah', onclick: guard(async () => { await api('/parties', { method: 'POST', body: { name: name.value, role: role.value, matterRef: ref.value } }); name.value = ''; ref.value = ''; toast('Ditambahkan'); load(); }) }))),
      el('div', { class: 'card' }, el('h2', { text: 'Impor massal' }), el('p', { class: 'muted small', text: 'Satu pihak per baris: Nama;peran(klien/lawan/terkait);referensi' }), bulk,
        el('button', { class: 'btn', style: 'margin-top:8px', text: 'Impor', onclick: guard(async () => { const r = await api('/parties', { method: 'POST', body: { bulk: bulk.value } }); bulk.value = ''; toast(`${r.added} pihak ditambahkan`); load(); }) }))));
    v.append(el('div', { style: 'max-width:320px;margin-bottom:10px' }, q), box);
    load();
  };

  // ================================================================ notifications & audit
  routes.notifications = async () => {
    const v = clear(view());
    const st = el('select', {}, ['', 'pending', 'sent', 'simulated', 'blocked', 'failed'].map((s) => el('option', { value: s, text: s || 'Semua status' })));
    const box = el('div');
    const load = guard(async () => {
      const rows = await api(`/notifications?status=${st.value}`);
      clear(box).append(simpleTable(['Waktu', 'Kanal', 'Tujuan', 'Isi', 'Status', ''], rows.map((n) => ({
        cells: [fmt(n.created_at), n.channel, n.recipient, el('div', {}, n.subject ? el('strong', { text: n.subject }) : null, el('div', { class: 'muted small', text: plain(n.body).slice(0, 160) })),
          el('div', {}, badge(n.status), el('div', { class: 'small muted', text: `${n.attempts}x` }), n.last_error ? el('div', { class: 'small', style: 'color:var(--danger)', text: n.last_error }) : null),
          n.status === 'failed' ? el('button', { class: 'btn sm', text: 'Kirim ulang', onclick: guard(async () => { await api(`/notifications/${n.id}/retry`, { method: 'POST' }); toast('Dijadwalkan ulang'); setTimeout(load, 1500); }) }) : ''],
      }))));
    });
    st.addEventListener('change', load);
    v.append(pageHead('Log Notifikasi', 'Semua pesan keluar (antrian Agen Operasional, dengan percobaan ulang otomatis)', el('div', { style: 'width:180px' }, st), el('button', { class: 'btn', text: '↻ Muat ulang', onclick: load })), box);
    load();
  };

  routes.audit = async () => {
    const rows = await api('/audit');
    clear(view()).append(pageHead('Log Audit', 'Jejak aktivitas agen dan admin (300 terakhir)'),
      simpleTable(['Waktu', 'Pelaku', 'Aksi', 'Detail', 'IP'], rows.map((r) => ({ cells: [fmt(r.created_at), r.agent, r.action, el('span', { class: 'mono', text: (r.detail || '').slice(0, 200) }), r.ip || '-'] }))));
  };

  // ================================================================ tools
  routes.tools = async () => {
    const v = clear(view());
    const out = el('div', { class: 'pre', text: 'Hasil akan tampil di sini.' });
    const show = (x) => { out.textContent = JSON.stringify(x, null, 2); };
    const fn = el('input', { type: 'text', value: 'Budi Santoso' });
    const fe = el('input', { type: 'email', value: 'budi@contoh.id' });
    const fs = el('input', { type: 'text', value: 'Permohonan konsultasi sengketa kontrak' });
    const ft = el('textarea', { value: 'Selamat siang,\n\nPerusahaan kami mengalami wanprestasi dari rekanan pemasok. Kami ingin berkonsultasi mengenai langkah hukum yang dapat diambil.\n\nTerima kasih.' });
    const ch = el('select', {}, ['telegram', 'whatsapp', 'email'].map((c) => el('option', { value: c, text: c })));
    const to = el('input', { type: 'text', placeholder: 'Kosongkan = penerima tim pertama di .env' });
    v.append(pageHead('Uji Coba', 'Simulasikan alur tanpa menunggu email sungguhan, dan uji setiap kanal notifikasi'));
    v.append(el('div', { class: 'grid cols-2' },
      el('div', { class: 'card' }, el('h2', { text: '📩 Simulasi email masuk dari klien' }),
        el('p', { class: 'muted small', text: 'Menjalankan alur lengkap: penyaringan keamanan → nomor referensi → auto-reply + tautan formulir → notifikasi WA & Telegram tim.' }),
        el('label', { class: 'f' }, 'Nama pengirim', fn), el('label', { class: 'f' }, 'Email pengirim', fe), el('label', { class: 'f' }, 'Perihal', fs), el('label', { class: 'f' }, 'Isi', ft),
        el('button', { class: 'btn primary', text: 'Kirim simulasi', onclick: guard(async () => show(await api('/simulate-email', { method: 'POST', body: { fromName: fn.value, fromEmail: fe.value, subject: fs.value, text: ft.value } }))) })),
      el('div', {},
        el('div', { class: 'card' }, el('h2', { text: '🔔 Tes kanal notifikasi' }), el('label', { class: 'f' }, 'Kanal', ch), el('label', { class: 'f' }, 'Tujuan', to),
          el('button', { class: 'btn', text: 'Kirim pesan tes', onclick: guard(async () => show(await api('/test-channel', { method: 'POST', body: { channel: ch.value, to: to.value } }))) })),
        el('div', { class: 'card' }, el('h2', { text: '⚙️ Jalankan tugas agen sekarang' }),
          el('div', { class: 'toolbar' },
            ...[['poll-mailbox', 'Periksa inbox'], ['outbox', 'Kirim antrian'], ['sla-check', 'Cek SLA'], ['invite-reminders', 'Pengingat formulir']]
              .map(([job, label]) => el('button', { class: 'btn', text: label, onclick: guard(async () => show(await api(`/run/${job}`, { method: 'POST' }))) })))),
        el('div', { class: 'card' }, el('h2', { text: 'Hasil' }), out))));
  };

  const ENTITIES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&amp;': '&' };
  const plain = (html) => String(html || '').replace(/<[^>]+>/g, '').replace(/&(lt|gt|quot|#39|amp);/g, (m) => ENTITIES[m]);

  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  boot();
})();
