/* Public client app: chatbot, multi-step registration form, status page. No framework, no build step. */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const params = new URLSearchParams(location.search);
  const inviteToken = params.get('t') || '';
  const DRAFT_KEY = 'kh_form_draft_v1';
  let CFG = null;
  let formLoadedAt = 0;

  /** DOM helper — text is always set via textContent, never innerHTML. */
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null) node.append(c.nodeType ? c : document.createTextNode(String(c)));
    return node;
  }

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  async function api(path, opts = {}) {
    const res = await fetch(path, opts);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || 'Terjadi kesalahan'), { body, status: res.status });
    return body;
  }

  // ------------------------------------------------------------------ views
  function show(view) {
    for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${view}`;
    for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('active', a.dataset.nav === view);
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  }

  function route() {
    const p = location.pathname;
    if (p.startsWith('/daftar')) { show('form'); initForm(); }
    else if (p.startsWith('/status')) { show('status'); loadStatus(); }
    else { show('chat'); initChat(); }
  }

  function navigate(path) {
    const q = inviteToken && path === '/daftar' ? `?t=${encodeURIComponent(inviteToken)}` : '';
    history.pushState({}, '', path + q);
    route();
  }

  for (const a of document.querySelectorAll('[data-nav]')) {
    a.addEventListener('click', (e) => { e.preventDefault(); navigate(a.getAttribute('href')); });
  }
  window.addEventListener('popstate', route);

  // ------------------------------------------------------------------ branding
  function applyBranding(o) {
    document.title = `${o.name} — Konsultasi Hukum`;
    const root = document.documentElement.style;
    if (o.brandColor) root.setProperty('--brand', o.brandColor);
    if (o.accentColor) root.setProperty('--accent', o.accentColor);
    $('#brand-name').textContent = o.name;
    $('#brand-tagline').textContent = o.tagline || '';
    if (o.logoUrl) { const img = $('#brand-logo'); img.src = o.logoUrl; img.alt = o.name; img.hidden = false; }
    for (const n of document.querySelectorAll('.office-hours')) n.textContent = o.officeHours;
    for (const n of document.querySelectorAll('.sla-hours')) n.textContent = o.slaHours;
    for (const n of document.querySelectorAll('.firm-phone')) n.textContent = o.phone;
    $('#footer-name').textContent = o.name;
    $('#footer-address').textContent = o.address || '';
    $('#footer-phone').textContent = o.phone || '';
    $('#footer-email').textContent = o.email || '';
  }

  // ------------------------------------------------------------------ chatbot
  let chatStarted = false;
  let chatBusy = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function initChat() {
    if (chatStarted) return;
    chatStarted = true;
    $('#bot-name').textContent = CFG.chatbot.botName || 'Asisten Virtual';
    $('#chat-restart').addEventListener('click', () => { $('#chat-body').textContent = ''; goNode(CFG.chatbot.start); });
    goNode(CFG.chatbot.start);
  }

  function scrollChat() { const b = $('#chat-body'); b.scrollTop = b.scrollHeight; }

  async function botSay(text, extra) {
    const body = $('#chat-body');
    const typing = el('div', { class: 'msg bot typing', text: '•••' });
    body.append(typing); scrollChat();
    await sleep(Math.min(350 + text.length * 6, 1100));
    typing.remove();
    const m = el('div', { class: 'msg bot', text });
    if (extra) m.append(extra);
    body.append(m); scrollChat();
    return m;
  }

  function userSay(text) { $('#chat-body').append(el('div', { class: 'msg user', text })); scrollChat(); }

  function setOptions(options) {
    const box = $('#chat-options');
    box.textContent = '';
    for (const o of options) {
      box.append(el('button', { class: `opt${o.action === 'open_form' ? ' primary' : ''}`, type: 'button', text: o.label, onclick: () => choose(o) }));
    }
  }

  async function goNode(id) {
    const node = CFG.chatbot.nodes[id];
    if (!node || chatBusy) return;
    chatBusy = true;
    setOptions([]);
    for (const m of node.messages) await botSay(m);
    setOptions(node.options || []);
    chatBusy = false;
  }

  async function choose(o) {
    if (chatBusy) return;
    userSay(o.label);
    if (o.next) return goNode(o.next);
    switch (o.action) {
      case 'open_form':
        await botSay('Baik, saya buka formulir registrasinya untuk Anda.');
        await sleep(500);
        return navigate('/daftar');
      case 'whatsapp': {
        const text = encodeURIComponent(`Halo ${CFG.office.name}, saya ingin berkonsultasi mengenai masalah hukum.`);
        window.open(`https://wa.me/${CFG.office.whatsapp}?text=${text}`, '_blank', 'noopener');
        await botSay('WhatsApp kantor telah dibuka di tab baru. Ada lagi yang dapat saya bantu?');
        return setOptions([{ label: 'Kembali ke menu', next: CFG.chatbot.start }]);
      }
      case 'link':
        window.open(o.url, '_blank', 'noopener');
        return setOptions([{ label: 'Kembali ke menu', next: CFG.chatbot.start }]);
      case 'check_status':
        return statusInChat();
      case 'restart':
      default:
        return goNode(CFG.chatbot.start);
    }
  }

  async function statusInChat() {
    setOptions([]);
    const reg = el('input', { type: 'text', placeholder: 'Nomor registrasi, mis. REG-2026-00012', autocomplete: 'off' });
    const email = el('input', { type: 'email', placeholder: 'Email yang didaftarkan', autocomplete: 'email' });
    const btn = el('button', { class: 'btn primary', type: 'submit', text: 'Cek status' });
    const form = el('form', { class: 'mini-form' }, reg, email, btn);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!reg.value.trim() || !email.value.trim()) return;
      btn.disabled = true;
      userSay(`${reg.value.trim()} · ${email.value.trim()}`);
      try {
        const r = await api('/api/public/status-lookup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ regNo: reg.value, email: email.value }) });
        form.remove();
        await botSay(`Status pendaftaran ${r.regNo} atas nama ${r.name}: ${r.statusLabel}.\nTerakhir diperbarui ${r.updatedAt}.`);
      } catch (err) {
        btn.disabled = false;
        await botSay(err.message);
      }
      setOptions([{ label: 'Kembali ke menu', next: CFG.chatbot.start }]);
    });
    await botSay('Silakan masukkan nomor registrasi dan email yang Anda gunakan saat mendaftar.', form);
    setOptions([{ label: 'Batal', next: CFG.chatbot.start }]);
  }

  // ------------------------------------------------------------------ form
  let formReady = false;
  let currentStep = 0;
  let steps = [];

  const allFields = () => CFG.form.sections.flatMap((s) => s.fields);

  function fieldValue(f) {
    const form = $('#reg-form');
    if (f.type === 'checkboxes') return [...form.querySelectorAll(`input[name="${f.id}"]:checked`)].map((i) => i.value);
    if (f.type === 'radio') return form.querySelector(`input[name="${f.id}"]:checked`)?.value || '';
    if (f.type === 'checkbox') return form.querySelector(`input[name="${f.id}"]`)?.checked || false;
    if (f.type === 'file') return form.querySelector(`input[name="${f.id}"]`)?.files || [];
    return form.querySelector(`[name="${f.id}"]`)?.value.trim() || '';
  }

  function isVisible(f) {
    if (!f.showIf) return true;
    const dep = allFields().find((x) => x.id === f.showIf.field);
    if (!dep) return true;
    const v = fieldValue(dep);
    return Array.isArray(v) ? v.includes(f.showIf.equals) : v === f.showIf.equals;
  }

  function renderField(f) {
    const wrap = el('div', { class: 'field', 'data-field': f.id });
    const reqMark = f.required ? el('span', { class: 'req', text: '*', 'aria-hidden': 'true' }) : null;
    const inputId = `f_${f.id}`;
    const common = { id: inputId, name: f.id, 'aria-describedby': `${inputId}_help` };

    if (f.type === 'info') {
      wrap.append(el('div', { class: 'info-block', text: f.label }));
      return wrap;
    }
    if (f.type === 'checkbox') {
      wrap.append(el('label', { class: 'consent' }, el('input', { type: 'checkbox', value: 'true', ...common }), el('span', {}, f.label, reqMark)));
    } else {
      const isGroup = ['radio', 'checkboxes'].includes(f.type);
      wrap.append(isGroup ? el('div', { class: 'label', id: `${inputId}_label` }, f.label, reqMark) : el('label', { for: inputId }, f.label, reqMark));
      let input;
      switch (f.type) {
        case 'textarea':
          input = el('textarea', { ...common, maxlength: f.maxLength || 5000, placeholder: f.placeholder || '' });
          break;
        case 'select':
          input = el('select', common, el('option', { value: '', text: '— Pilih —' }), ...f.options.map((o) => el('option', { value: o, text: o })));
          break;
        case 'radio':
        case 'checkboxes':
          input = el('div', { class: 'choices', role: f.type === 'radio' ? 'radiogroup' : 'group', 'aria-labelledby': `${inputId}_label` },
            ...f.options.map((o) => el('label', { class: 'choice' }, el('input', { type: f.type === 'radio' ? 'radio' : 'checkbox', name: f.id, value: o }), el('span', { text: o }))));
          break;
        case 'file': {
          const fileInput = el('input', { ...common, type: 'file', accept: f.accept || '.pdf,.jpg,.jpeg,.png,.docx', multiple: f.multiple ? true : null });
          const list = el('div', { class: 'file-list' });
          fileInput.addEventListener('change', () => {
            list.textContent = [...fileInput.files].map((x) => `${x.name} (${(x.size / 1024 / 1024).toFixed(1)} MB)`).join(' · ');
          });
          wrap.append(fileInput, list);
          break;
        }
        default:
          input = el('input', {
            ...common,
            type: f.type,
            maxlength: f.maxLength || null,
            placeholder: f.placeholder || '',
            autocomplete: { client_name: 'name', client_email: 'email', client_phone: 'tel' }[f.role] || null,
            inputmode: f.type === 'tel' ? 'tel' : null,
          });
      }
      if (input) wrap.append(input);
    }
    if (f.help) wrap.append(el('div', { class: 'help', id: `${inputId}_help`, text: f.help }));
    wrap.append(el('div', { class: 'err', hidden: true }));
    return wrap;
  }

  function initForm() {
    if (formReady) return;
    formReady = true;
    formLoadedAt = CFG.serverTime;
    const form = CFG.form;
    $('#form-title').textContent = form.title;
    $('#form-intro').textContent = form.intro || '';
    $('#form-disclaimer').textContent = form.disclaimer || '';
    $('#btn-submit').textContent = form.submitLabel || 'Kirim Formulir';

    if (CFG.prefill) {
      const b = $('#ref-banner');
      b.hidden = false;
      b.textContent = CFG.prefill.alreadyRegistered
        ? `Referensi ${CFG.prefill.ref}: formulir untuk email ini sudah pernah kami terima. Anda tetap dapat mengirim formulir baru bila ada perkara lain.`
        : `Melanjutkan dari email Anda (referensi ${CFG.prefill.ref}). Beberapa data telah kami isikan.`;
    }

    const container = $('#form-steps');
    steps = form.sections.map((s) => {
      const node = el('div', { class: 'step', 'data-step': s.id }, el('h2', { text: s.title }), s.description ? el('p', { class: 'muted', text: s.description }) : null, ...s.fields.map(renderField));
      container.append(node);
      return { title: s.title, node, fields: s.fields };
    });
    const review = el('div', { class: 'step', 'data-step': '_review' }, el('h2', { text: 'Tinjau & Kirim' }), el('p', { class: 'muted', text: 'Periksa kembali isian Anda sebelum dikirim.' }), el('div', { id: 'review-box' }));
    container.append(review);
    steps.push({ title: 'Tinjau & Kirim', node: review, fields: [], review: true });

    const stepper = $('#stepper');
    // Completed steps stay clickable (going back never skips validation).
    steps.forEach((s, i) => stepper.append(el('li', {}, el('button', { type: 'button', title: s.title, onclick: () => { if (i < currentStep) goStep(i); } }, el('span', { text: s.title })))));

    restoreDraft();
    if (CFG.prefill) {
      const byRole = (role) => allFields().find((f) => f.role === role);
      const setIfEmpty = (f, v) => { const i = f && $(`#f_${f.id}`); if (i && !i.value) i.value = v; };
      setIfEmpty(byRole('client_name'), CFG.prefill.name);
      setIfEmpty(byRole('client_email'), CFG.prefill.email);
    }

    const formEl = $('#reg-form');
    formEl.addEventListener('input', () => { applyVisibility(); saveDraft(); });
    formEl.addEventListener('change', () => { applyVisibility(); saveDraft(); });
    formEl.addEventListener('submit', submit);
    $('#btn-next').addEventListener('click', () => { if (validateStep(currentStep)) goStep(currentStep + 1); });
    $('#btn-prev').addEventListener('click', () => goStep(currentStep - 1));
    applyVisibility();
    goStep(0);
  }

  function applyVisibility() {
    for (const f of allFields()) {
      const node = document.querySelector(`[data-field="${f.id}"]`);
      if (node) node.hidden = !isVisible(f);
    }
  }

  function goStep(i) {
    currentStep = Math.max(0, Math.min(i, steps.length - 1));
    steps.forEach((s, idx) => { s.node.hidden = idx !== currentStep; });
    [...$('#stepper').children].forEach((li, idx) => {
      li.className = idx === currentStep ? 'active' : idx < currentStep ? 'done' : '';
      const b = li.firstChild;
      if (idx === currentStep) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    });
    // Segmented pill: one segment per step slides along the track; finished steps tint behind it.
    const seg = 100 / steps.length;
    $('#seg-pill').style.width = `${seg}%`;
    $('#seg-pill').style.transform = `translateX(${currentStep * 100}%)`;
    $('#seg-done').style.width = `${currentStep * seg}%`;
    $('#step-title').textContent = steps[currentStep].title;
    $('#step-count').textContent = `Langkah ${currentStep + 1} dari ${steps.length}`;
    $('#btn-prev').style.visibility = currentStep === 0 ? 'hidden' : 'visible';
    const last = currentStep === steps.length - 1;
    $('#btn-next').hidden = last;
    $('#btn-submit').hidden = !last;
    $('#form-error').hidden = true;
    if (steps[currentStep].review) buildReview();
    $('#view-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function setError(id, msg) {
    const node = document.querySelector(`[data-field="${id}"]`);
    if (!node) return;
    node.classList.toggle('invalid', Boolean(msg));
    const e = node.querySelector('.err');
    e.hidden = !msg;
    e.textContent = msg || '';
  }

  function checkField(f) {
    if (f.type === 'info' || !isVisible(f)) return '';
    const v = fieldValue(f);
    const empty = f.type === 'checkbox' ? !v : f.type === 'file' ? !v.length : Array.isArray(v) ? !v.length : !v;
    if (f.required && empty) return f.type === 'checkbox' ? 'Persetujuan ini wajib dicentang.' : 'Bagian ini wajib diisi.';
    if (empty) return '';
    if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v)) return 'Format email tidak valid.';
    if (f.type === 'tel' && !/^[+\d][\d\s-]{7,18}$/.test(v)) return 'Nomor telepon tidak valid.';
    if (f.minLength && typeof v === 'string' && v.length < f.minLength) return `Mohon isi minimal ${f.minLength} karakter (saat ini ${v.length}).`;
    if (f.type === 'file') {
      const max = CFG.limits.maxUploadMb * 1024 * 1024;
      if (v.length > CFG.limits.maxFiles) return `Maksimal ${CFG.limits.maxFiles} berkas.`;
      const big = [...v].find((x) => x.size > max);
      if (big) return `${big.name} melebihi ${CFG.limits.maxUploadMb} MB.`;
    }
    return '';
  }

  function validateStep(i) {
    let first = null;
    for (const f of steps[i].fields) {
      const msg = checkField(f);
      setError(f.id, msg);
      if (msg && !first) first = f.id;
    }
    if (first) document.querySelector(`[data-field="${first}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return !first;
  }

  function buildReview() {
    const box = $('#review-box');
    box.textContent = '';
    steps.forEach((s, idx) => {
      if (s.review) return;
      const dl = el('dl');
      for (const f of s.fields) {
        if (f.type === 'info' || f.type === 'checkbox' || !isVisible(f)) continue;
        let v = fieldValue(f);
        if (f.type === 'file') v = [...v].map((x) => x.name).join(', ');
        if (Array.isArray(v)) v = v.join(', ');
        dl.append(el('dt', { text: f.label }), el('dd', { text: v || '—' }));
      }
      box.append(el('div', { class: 'review' }, el('h3', {}, s.title, el('button', { class: 'link-btn', type: 'button', text: 'Ubah', onclick: () => goStep(idx) })), dl));
    });
  }

  function saveDraft() {
    const data = {};
    for (const f of allFields()) if (!['file', 'info'].includes(f.type)) data[f.id] = fieldValue(f);
    store.set(DRAFT_KEY, data);
  }

  function restoreDraft() {
    const data = store.get(DRAFT_KEY);
    if (!data) return;
    const form = $('#reg-form');
    for (const f of allFields()) {
      const v = data[f.id];
      if (v == null || f.type === 'file') continue;
      if (f.type === 'checkboxes') for (const i of form.querySelectorAll(`input[name="${f.id}"]`)) i.checked = v.includes(i.value);
      else if (f.type === 'radio') for (const i of form.querySelectorAll(`input[name="${f.id}"]`)) i.checked = i.value === v;
      else if (f.type === 'checkbox') { const i = form.querySelector(`input[name="${f.id}"]`); if (i) i.checked = Boolean(v); }
      else { const i = form.querySelector(`[name="${f.id}"]`); if (i) i.value = v; }
    }
  }

  async function submit(e) {
    e.preventDefault();
    for (let i = 0; i < steps.length - 1; i += 1) {
      if (!validateStep(i)) { goStep(i); validateStep(i); return; }
    }
    const btn = $('#btn-submit');
    btn.disabled = true;
    btn.textContent = 'Mengirim…';
    const fd = new FormData($('#reg-form'));
    fd.append('_t', String(formLoadedAt));
    if (inviteToken) fd.append('_token', inviteToken);
    try {
      const r = await api('/api/public/submit', { method: 'POST', body: fd });
      store.del(DRAFT_KEY);
      showSuccess(r);
    } catch (err) {
      const box = $('#form-error');
      box.hidden = false;
      box.textContent = err.message;
      const fields = err.body?.fields || {};
      let firstStep = null;
      for (const [id, msg] of Object.entries(fields)) {
        setError(id, msg);
        const idx = steps.findIndex((s) => s.fields.some((f) => f.id === id));
        if (idx >= 0 && (firstStep == null || idx < firstStep)) firstStep = idx;
      }
      if (firstStep != null) { goStep(firstStep); for (const [id, msg] of Object.entries(fields)) setError(id, msg); box.hidden = false; box.textContent = err.message; }
    } finally {
      btn.disabled = false;
      btn.textContent = CFG.form.submitLabel || 'Kirim Formulir';
    }
  }

  function showSuccess(r) {
    $('#success-message').textContent = CFG.form.successMessage || '';
    if (r.regNo) {
      $('#reg-box').hidden = false;
      $('#reg-no').textContent = r.regNo;
      $('#copy-reg').onclick = () => navigator.clipboard?.writeText(r.regNo).then(() => { $('#copy-reg').textContent = 'Tersalin ✓'; });
    }
    if (r.slaDue) $('#sla-due').textContent = r.slaDue;
    if (r.statusLink) { const a = $('#status-link'); a.href = new URL(r.statusLink).pathname + new URL(r.statusLink).search; a.hidden = false; }
    show('success');
  }

  // ------------------------------------------------------------------ status page
  const STATUS_FLOW = [
    ['baru', 'Registrasi diterima'],
    ['ditinjau', 'Ditinjau oleh tim'],
    ['dijadwalkan', 'Konsultasi dijadwalkan'],
    ['diterima', 'Kerja sama dimulai'],
  ];

  async function loadStatus() {
    const box = $('#status-content');
    try {
      const s = await api(`/api/public/status?r=${encodeURIComponent(params.get('r') || '')}&k=${encodeURIComponent(params.get('k') || '')}`);
      box.textContent = '';
      box.append(
        el('p', {}, 'Nomor registrasi ', el('strong', { text: s.regNo }), ` atas nama ${s.name}.`),
        el('p', { class: 'muted small', text: `Dikirim ${s.submittedAt} · Diperbarui ${s.updatedAt}` }),
      );
      if (['ditolak', 'arsip'].includes(s.status)) {
        box.append(el('div', { class: 'notice', text: `Status: ${s.statusLabel}. Detail telah kami sampaikan melalui email.` }));
        return;
      }
      const order = STATUS_FLOW.map((x) => x[0]);
      const pos = s.status === 'perlu_info' ? 1 : order.indexOf(s.status);
      const list = el('ol', { class: 'timeline' });
      STATUS_FLOW.forEach(([, label], i) => {
        const cls = i < pos ? 'done' : i === pos ? 'current' : '';
        list.append(el('li', { class: cls }, el('span', { class: 'bullet', text: i < pos ? '✓' : String(i + 1) }), label));
      });
      box.append(list);
      if (s.status === 'perlu_info') box.append(el('div', { class: 'notice', text: 'Tim kami memerlukan informasi tambahan dari Anda. Mohon periksa email Anda.' }));
    } catch (err) {
      box.textContent = '';
      box.append(el('p', { text: err.message }), el('p', { class: 'muted small', text: 'Gunakan tautan yang kami kirimkan melalui email, atau cek status melalui asisten virtual dengan nomor registrasi dan email Anda.' }));
    }
  }

  // ------------------------------------------------------------------ boot
  api(`/api/public/config${inviteToken ? `?t=${encodeURIComponent(inviteToken)}` : ''}`)
    .then((cfg) => {
      CFG = cfg;
      if (cfg.environment === 'staging') document.body.prepend(el('div', { class: 'env-banner', text: 'STAGING — situs uji coba. Jangan kirim data perkara sungguhan.' }));
      applyBranding(cfg.office);
      route();
    })
    .catch(() => { document.querySelector('main').textContent = 'Layanan sedang tidak tersedia. Silakan coba beberapa saat lagi.'; });
})();
