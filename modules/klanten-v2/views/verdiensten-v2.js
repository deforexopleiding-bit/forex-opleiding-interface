// modules/klanten-v2/views/verdiensten-v2.js
//
// Verdiensten (mentor-self) — v6, opschoning na sweep.
// Module blijft DORMANT ('verdiensten' NIET in V2_ACTIVE_ALLOWLIST).
//
// SCOPE: puur mentor-self (6 tabs). De "Alle mentors"-admin-tab (BROK 4)
// is verwijderd — alle admin-payout-functies verhuizen 1-op-1 naar de
// Mentoren-module. Admin-code (mentor-admin-list, mentor-payouts-admin-list,
// mentor-payout-detail, generate/approve/mark-paid/reopen/revert,
// adjustment-save/-delete, config-set, recurring-save/-delete, ledger-set-
// status, typed-confirms) is bewaard in git-historie op commit 73b50bd7
// voor 1-op-1 hergebruik in mentoren-v2 BROK 2.
//
// TABS (6, mentor-self):
//   - Overzicht        → mentor-bonus-overview (totals + projection_12m + per_event)
//   - Coaching         → mentor-coaching-earnings (1-op-1/team/no-show/funded)
//   - Events           → mentor-my-events + 12-mnd cashflow-projectie
//   - Uitbetalingen    → mentor-payouts-list-self (BTW-splitsing)
//   - Reiskosten       → mentor-travel-days-self (GET+POST, reminder-banner
//                        rond 1e vrijdag)
//   - Certificaten     → mentor-funded-certs-self + upload via
//                        mentor-my-students + Supabase Storage +
//                        mentor-funded-cert-save (funded_month LOCKT)
//
// FIXES v6:
// 1. "Alle mentors"-tab (BROK 4) verwijderd — verdiensten is nu puur self.
//    Lost tegelijk de bug op dat de tab zichtbaar was voor rol Mentor.
// 2. Projectiegrafieken (Overzicht + Events): forceer max 12 datapunten
//    via .slice(0, 12) op projArr en cap labels op data-length zodat het
//    aantal maand-labels altijd EXACT matcht met de datapoints (was bug:
//    43 labels bij 12 punten). Titel toont het actuele aantal.
// 3. Cert-upload load-order race: window.supabase/AuthShared-check verplaatst
//    van module-init (top-level warn) naar runtime in __verdCertSubmit.
//    Zelfde patroon als de KV-guard fix uit v5 — ontbrekende dependency
//    op module-load-tijd blokkeert nooit meer een tab.
//
// Guardrails: 8s Promise.race timeout · asArr() · in-flight loading-flag
// · fail-soft errBlk met "Opnieuw"-retry · geen render-loop · uncontrolled
// inputs (state-only oninput). Confirms op writes: openConfirm voor
// travel-days POST + funded-cert claim.

(function () {
  if (!window.DFO) { console.error('[verdiensten-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[verdiensten-v2] KV_V2.helpers niet geladen.'); return; }
  // GEEN top-level bail op window.KV / window.supabase — beide worden
  // door klanten-v2.js (ES-module bootstrap) async gezet. Check pas
  // runtime in tryFetch / __verdCertSubmit.

  const { I, svg, S, F, render } = window.DFO;
  const H = window.KV_V2.helpers;

  /* ── Helpers ─────────────────────────────────────────────────────────── */
  const asArr = (v) => (Array.isArray(v) ? v : []);
  const eur   = (n) => (n == null ? '—' : new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 }).format(n));
  const esc   = (v) => (H.esc ? H.esc(v) : String(v == null ? '' : v)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;'));

  const MONTH_NAMES_NL_LONG = ['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'];
  const MONTH_NAMES_NL_SHORT = ['jan','feb','mrt','apr','mei','jun','jul','aug','sep','okt','nov','dec'];
  function fmtMonth(iso) {
    if (!iso) return '—';
    try { const d = new Date(iso); if (Number.isNaN(d.getTime())) return String(iso); return `${MONTH_NAMES_NL_LONG[d.getMonth()]} ${d.getFullYear()}`; }
    catch (_) { return String(iso); }
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleDateString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric' }); }
    catch (_) { return String(iso); }
  }
  function fmtDateTime(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('nl-NL', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch (_) { return String(iso); }
  }
  const monthKey = (iso) => (typeof iso === 'string' ? iso.slice(0, 7) : '');
  function currentMonthKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  // Bouw NL-korte label uit "YYYY-MM(-DD)?": bv. "2026-08-01" → "aug"
  function shortMonthLabel(monthIso) {
    if (typeof monthIso !== 'string' || monthIso.length < 7) return '';
    const mm = parseInt(monthIso.slice(5, 7), 10);
    if (!Number.isFinite(mm) || mm < 1 || mm > 12) return '';
    return MONTH_NAMES_NL_SHORT[mm - 1];
  }
  function firstFridayOfMonth(ref = new Date()) {
    const d = new Date(ref.getFullYear(), ref.getMonth(), 1);
    while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
    return d;
  }
  function todayIsOnOrAfterFirstFriday() {
    const now = new Date(); const ff = firstFridayOfMonth(now);
    return now.getTime() >= ff.getTime();
  }

  /* ── Fetch-helpers (runtime KV-check, geen top-level bail) ───────────── */
  async function tryFetch(label, url, timeoutMs = 8000) {
    try {
      if (!window.KV || typeof window.KV.authedJson !== 'function') {
        throw new Error('KV.authedJson nog niet geladen (klanten-v2 bootstrap async)');
      }
      return await Promise.race([
        window.KV.authedJson(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout na ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) {
      console.warn('[verdiensten-v2] fetch fail:', label, '→', e?.message || e);
      return { __error: e?.message || 'onbekende fout' };
    }
  }
  async function tryPost(label, url, body, timeoutMs = 12000) {
    try {
      if (!window.KV || typeof window.KV.authedJson !== 'function') {
        throw new Error('KV.authedJson nog niet geladen (klanten-v2 bootstrap async)');
      }
      return await Promise.race([
        window.KV.authedJson(url, { method: 'POST', body: JSON.stringify(body || {}) }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout na ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) {
      console.warn('[verdiensten-v2] post fail:', label, '→', e?.message || e);
      return { __error: e?.message || 'onbekende fout', __status: e?.status || null };
    }
  }

  /* ── State ───────────────────────────────────────────────────────────── */
  const _live = {
    overview:    { loading: false, error: null, data: null },
    payouts:     { loading: false, error: null, data: null },
    travel:      { loading: false, error: null, data: null, key: null },
    certs:       { loading: false, error: null, data: null },
    coaching:    { loading: false, error: null, data: null, from: null, to: null },
    myEvents:    { loading: false, error: null, data: null, scope: 'all' },
    myStudents:  { loading: false, error: null, data: null },
  };
  const _ui = {
    py: '26',                       // periode-chip jaar (26/25)
    travelForm:      null,           // { days, saving, error }
    certUpload:      null,           // { studentId, studentName, file, fileName, saving, error, step }
    confirmModal:    null,           // { msg, onOk, tone }
  };
  const YEAR_OF = { '26': '2026', '25': '2025' };

  /* ── UI-blokken ──────────────────────────────────────────────────────── */
  function skel() {
    return `<div class="pad" style="padding-top:16px">
      <div style="height:64px;border-radius:var(--r);background:linear-gradient(90deg,var(--surface-2),var(--surface) 50%,var(--surface-2));background-size:200% 100%;animation:kv-shim 1.4s linear infinite;margin-bottom:14px"></div>
      <div style="height:180px;border-radius:var(--r);background:linear-gradient(90deg,var(--surface-2),var(--surface) 50%,var(--surface-2));background-size:200% 100%;animation:kv-shim 1.4s linear infinite"></div>
    </div>`;
  }
  function errBlk(msg, retryHandler) {
    return `<div class="pad" style="padding-top:16px">
      <div style="padding:14px 16px;background:var(--rose-soft);border:1px solid var(--rose-line, var(--rose));color:var(--rose);border-radius:var(--r);font-size:13px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <span>⚠ ${esc(msg || 'Onbekende fout')}</span>
        ${retryHandler ? `<button class="btn btn-ghost btn-sm" onclick="${retryHandler}">Opnieuw</button>` : ''}
      </div>
    </div>`;
  }
  function toast(msg, tone) {
    try { if (window.KV?.toast) window.KV.toast(msg); else console.info('[verdiensten-v2] toast:', tone || '', msg); }
    catch (_) { console.info(msg); }
  }
  function modalShell(title, body, closeHandler, width) {
    const w = width || 620;
    return `<div style="position:fixed;inset:0;background:rgba(17,23,33,.48);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px" onclick="${closeHandler}">
      <div style="background:var(--surface);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.32);max-width:${w}px;width:100%;max-height:90vh;overflow:hidden;display:flex;flex-direction:column" onclick="event.stopPropagation()">
        <div style="padding:14px 22px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
          <div style="font-size:15px;font-weight:600">${esc(title)}</div>
          <button class="icon-btn" onclick="${closeHandler}" style="width:26px;height:26px">✕</button>
        </div>
        <div style="padding:18px 22px;overflow-y:auto;flex:1;min-height:0">${body}</div>
      </div>
    </div>`;
  }

  /* Confirm-modal (simpel) */
  window.__verdConfirmOk = () => {
    const c = _ui.confirmModal; _ui.confirmModal = null; render();
    try { if (c && typeof c.onOk === 'function') c.onOk(); } catch (e) { console.warn('[verdiensten-v2] confirm onOk fail', e); }
  };
  window.__verdConfirmCancel = () => { _ui.confirmModal = null; render(); };
  function openConfirm(msg, onOk, tone) {
    _ui.confirmModal = { msg, onOk, tone: tone || 'warn' };
    render();
  }
  function renderConfirmModal() {
    if (!_ui.confirmModal) return '';
    const c = _ui.confirmModal;
    const body = `
      <div style="padding:8px 0 16px;font-size:13.5px;line-height:1.6;color:var(--text)">${esc(c.msg)}</div>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-ghost" onclick="window.__verdConfirmCancel()">Annuleren</button>
        <button class="btn ${c.tone === 'danger' ? 'btn-danger' : 'btn-primary'}" onclick="window.__verdConfirmOk()">Bevestig</button>
      </div>`;
    return modalShell('Bevestig actie', body, 'window.__verdConfirmCancel()', 480);
  }

  /* ── Fetchers ────────────────────────────────────────────────────────── */
  async function fetchOverview() {
    if (_live.overview.loading) return;
    _live.overview.loading = true; _live.overview.error = null;
    const j = await tryFetch('overview', '/api/mentor-bonus-overview');
    _live.overview.loading = false;
    if (!j || j.__error) { _live.overview.error = j?.__error || 'Kon overzicht niet laden'; render(); return; }
    _live.overview.data = j; render();
  }
  async function fetchPayouts() {
    if (_live.payouts.loading) return;
    _live.payouts.loading = true; _live.payouts.error = null;
    const j = await tryFetch('payouts', '/api/mentor-payouts-list-self');
    _live.payouts.loading = false;
    if (!j || j.__error) { _live.payouts.error = j?.__error || 'Kon uitbetalingen niet laden'; render(); return; }
    _live.payouts.data = j; render();
  }
  async function fetchTravel(monthKeyStr) {
    const key = monthKeyStr || currentMonthKey();
    if (_live.travel.loading && _live.travel.key === key) return;
    _live.travel.loading = true; _live.travel.error = null; _live.travel.key = key;
    const j = await tryFetch('travel', `/api/mentor-travel-days-self?period_month=${encodeURIComponent(key)}`);
    _live.travel.loading = false;
    if (!j || j.__error) { _live.travel.error = j?.__error || 'Kon reisdagen niet laden'; render(); return; }
    _live.travel.data = j; render();
  }
  async function fetchCerts() {
    if (_live.certs.loading) return;
    _live.certs.loading = true; _live.certs.error = null;
    const j = await tryFetch('certs', '/api/mentor-funded-certs-self');
    _live.certs.loading = false;
    if (!j || j.__error) { _live.certs.error = j?.__error || 'Kon certificaten niet laden'; render(); return; }
    _live.certs.data = j; render();
  }
  async function fetchCoaching() {
    if (_live.coaching.loading) return;
    _live.coaching.loading = true; _live.coaching.error = null;
    const j = await tryFetch('coaching', '/api/mentor-coaching-earnings');
    _live.coaching.loading = false;
    if (!j || j.__error) { _live.coaching.error = j?.__error || 'Kon coaching-verdiensten niet laden'; render(); return; }
    _live.coaching.data = j; _live.coaching.from = j.from || null; _live.coaching.to = j.to || null;
    render();
  }
  async function fetchMyEvents() {
    if (_live.myEvents.loading) return;
    _live.myEvents.loading = true; _live.myEvents.error = null;
    const j = await tryFetch('myEvents', `/api/mentor-my-events?scope=${encodeURIComponent(_live.myEvents.scope || 'all')}`);
    _live.myEvents.loading = false;
    if (!j || j.__error) { _live.myEvents.error = j?.__error || 'Kon events niet laden'; render(); return; }
    _live.myEvents.data = j; render();
  }
  async function fetchMyStudents() {
    if (_live.myStudents.loading) return;
    _live.myStudents.loading = true; _live.myStudents.error = null;
    const j = await tryFetch('myStudents', '/api/mentor-my-students');
    _live.myStudents.loading = false;
    if (!j || j.__error) { _live.myStudents.error = j?.__error || 'Kon studenten niet laden'; render(); return; }
    _live.myStudents.data = j; render();
  }

  /* ── Handlers ────────────────────────────────────────────────────────── */
  window.__verdRetryOverview = () => { _live.overview.data = null; queueMicrotask(fetchOverview); };
  window.__verdRetryPayouts  = () => { _live.payouts.data  = null; queueMicrotask(fetchPayouts);  };
  window.__verdRetryTravel   = () => { _live.travel.data   = null; queueMicrotask(() => fetchTravel(currentMonthKey())); };
  window.__verdRetryCerts    = () => { _live.certs.data    = null; queueMicrotask(fetchCerts);    };
  window.__verdRetryCoaching = () => { _live.coaching.data = null; queueMicrotask(fetchCoaching); };
  window.__verdRetryMyEvents = () => { _live.myEvents.data = null; queueMicrotask(fetchMyEvents); };
  window.__verdRetryMyStudents = () => { _live.myStudents.data = null; queueMicrotask(fetchMyStudents); };

  window.__verdSetPy = (v) => { if (v === '25' || v === '26') { _ui.py = v; render(); } };
  window.__verdSetMyEventsScope = (s) => {
    if (!['upcoming','past','all'].includes(s)) return;
    _live.myEvents.scope = s; _live.myEvents.data = null; queueMicrotask(fetchMyEvents);
  };

  /* Reiskosten POST (state-only oninput → geen re-render tijdens typen) */
  window.__verdTravelOpenForm = () => {
    const t = _live.travel.data;
    if (!t || !t.travel_enabled || !t.editable) return;
    _ui.travelForm = { days: Number(t.days) || 0, saving: false, error: null };
    render();
  };
  window.__verdTravelCloseForm = () => { _ui.travelForm = null; render(); };
  window.__verdTravelFieldDays = (v) => { if (_ui.travelForm) _ui.travelForm.days = v; /* state-only */ };
  window.__verdTravelSubmit = () => {
    const f = _ui.travelForm; const t = _live.travel.data;
    if (!f || !t) return;
    const n = parseInt(f.days, 10);
    if (!Number.isFinite(n) || n < 0 || n > 62) {
      _ui.travelForm.error = 'Aantal moet een geheel getal tussen 0 en 62 zijn.'; render(); return;
    }
    openConfirm(`Rijdagen voor ${fmtMonth(t.period_month)} vastleggen op ${n}? Vergoeding wordt ${eur(n * (Number(t.day_rate_incl) || 0))}. Aanpasbaar tot goedkeuring door finance.`, async () => {
      _ui.travelForm.saving = true; _ui.travelForm.error = null; render();
      const key = _live.travel.key || currentMonthKey();
      const resp = await tryPost('travel-post', '/api/mentor-travel-days-self', { period_month: key, days: n });
      if (!resp || resp.__error) {
        _ui.travelForm.saving = false; _ui.travelForm.error = resp?.__error || 'Opslaan mislukt'; render();
        toast('Reisdagen niet opgeslagen', 'error'); return;
      }
      _ui.travelForm = null;
      _live.travel.data = null; _live.travel.key = null;
      toast('Reisdagen opgeslagen', 'success');
      queueMicrotask(() => fetchTravel(key));
    }, 'warn');
  };

  /* Cert-upload (supabase/AuthShared check pas runtime in __verdCertSubmit) */
  window.__verdCertOpenUpload = () => {
    _ui.certUpload = { studentId: '', studentName: '', file: null, fileName: '', saving: false, error: null, step: 'pick' };
    if (!_live.myStudents.data && !_live.myStudents.loading) queueMicrotask(fetchMyStudents);
    render();
  };
  window.__verdCertCloseUpload = () => { _ui.certUpload = null; render(); };
  window.__verdCertPickStudent = (studentId) => {
    if (!_ui.certUpload) return;
    const stu = asArr(_live.myStudents.data?.students).find((s) => String(s.bubble_id || s.id) === String(studentId));
    if (!stu) return;
    _ui.certUpload.studentId = String(stu.bubble_id || stu.id);
    _ui.certUpload.studentName = String(stu.name || stu.email || 'Student');
    _ui.certUpload.step = 'upload';
    render();
  };
  window.__verdCertPickFile = () => {
    const inp = document.getElementById('verdCertFileInput');
    const f = inp && inp.files && inp.files[0];
    if (!f || !_ui.certUpload) return;
    if (f.size > 10 * 1024 * 1024) {
      _ui.certUpload.error = 'Bestand mag niet groter zijn dan 10 MB.'; render(); return;
    }
    _ui.certUpload.file = f;
    _ui.certUpload.fileName = f.name;
    _ui.certUpload.error = null;
    render();
  };
  window.__verdCertSubmit = () => {
    const c = _ui.certUpload;
    if (!c || !c.studentId || !c.file) return;
    // Runtime dep-check: window.supabase + AuthShared MOETEN nu bestaan.
    // Verplaatst van module-init naar hier zodat load-order race niet
    // meer een top-level warn produceert. Bij ontbreken: nette melding.
    if (!window.supabase?.storage || !window.supabase?.auth || !window.AuthShared) {
      c.error = 'Storage-client nog niet geladen — probeer een hard-refresh of neem contact op met kantoor.';
      render(); return;
    }
    openConfirm(`Certificaat voor ${c.studentName} claimen voor ${fmtMonth(currentMonthKey() + '-01')}? De maand LOCKT na 1e claim — dubbele bonus is niet mogelijk. €100 bonus wordt in het maandrapport bijgeschreven.`, async () => {
      _ui.certUpload.saving = true; _ui.certUpload.error = null; render();
      try {
        const { data: userData } = await window.supabase.auth.getUser();
        const uid = userData?.user?.id;
        if (!uid) throw new Error('Niet geauthenticeerd');
        const safeName = String(c.fileName || 'cert').replace(/[^A-Za-z0-9._-]/g, '_');
        const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
        const filePath = `${uid}/${c.studentId}/${ts}-${safeName}`;
        const { error: upErr } = await window.supabase.storage.from('funded-certificates').upload(filePath, c.file, { cacheControl: '3600', upsert: false });
        if (upErr) throw new Error('Upload mislukt: ' + upErr.message);
        const resp = await tryPost('funded-cert-save', '/api/mentor-funded-cert-save', {
          student_id: c.studentId, student_name: c.studentName, file_path: filePath, file_name: safeName,
        });
        if (!resp || resp.__error) throw new Error(resp?.__error || 'Registreren mislukt');
        toast('Certificaat geclaimd', 'success');
        _ui.certUpload = null;
        _live.certs.data = null;
        queueMicrotask(fetchCerts);
      } catch (e) {
        console.warn('[verdiensten-v2] cert-upload fail:', e?.message || e);
        if (_ui.certUpload) { _ui.certUpload.saving = false; _ui.certUpload.error = e?.message || 'Upload mislukt'; }
        toast('Certificaat niet geclaimd', 'error');
        render();
      }
    }, 'warn');
  };

  /* ── Render-helpers ──────────────────────────────────────────────────── */
  const hbar = (label, val, max, color, right) => `<div style="display:flex;align-items:center;gap:12px;margin-bottom:11px">
    <div style="width:158px;font-size:12.5px;color:var(--text-2);flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${label}</div>
    <div class="progress" style="flex:1;height:8px"><i style="width:${max ? Math.round(val / max * 100) : 0}%;background:var(--${color})"></i></div>
    <div style="width:100px;text-align:right;font-size:12.5px;font-weight:600;font-family:'IBM Plex Mono',monospace">${right}</div></div>`;

  const dashCard = (title, dotColor, body, extra) => `<div class="card">
    <div class="card-head" style="border-bottom:none;padding-bottom:6px">
      <span class="title-dot" style="background:var(--${dotColor});box-shadow:0 0 0 3px var(--${dotColor}-soft)"></span>
      <div class="card-title">${title}</div>${extra || ''}</div>
    <div class="card-body" style="padding:8px 17px 17px">${body}</div></div>`;

  // AreaChart: EXACT even veel labels als datapunten (was bug: 43 labels bij 12 punten).
  function areaChart(data, labels) {
    const n = data.length;
    if (!n) return `<div style="padding:12px;color:var(--text-3);font-size:12.5px">Geen data.</div>`;
    const w = 100, h = 42, mx = Math.max(...data, 1);
    const pts = data.map((v, i) => [n > 1 ? i / (n - 1) * w : 0, h - (v / mx) * h * .88 - 2]);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const shown = labels.slice(0, n); // hard cap → matcht datapoint-count
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:64px;display:block">
      <defs><linearGradient id="verd-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--m)" stop-opacity=".22"/><stop offset="100%" stop-color="var(--m)" stop-opacity="0"/>
      </linearGradient></defs>
      <path fill="url(#verd-grad)" d="${line} L${w},${h} L0,${h} Z"/>
      <path fill="none" stroke="var(--m)" stroke-width="1.5" vector-effect="non-scaling-stroke" d="${line}"/>
    </svg><div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-3);margin-top:4px">${shown.map(l => `<span>${esc(l)}</span>`).join('')}</div>`;
  }

  // BarChart12: idem, exact data.length bars + labels.
  function barChart12(data, labels) {
    const n = data.length;
    if (!n) return `<div style="padding:12px;color:var(--text-3);font-size:12.5px">Geen data.</div>`;
    const mx = Math.max(...data, 1);
    const shownLabels = labels.slice(0, n);
    return `<div style="display:flex;align-items:flex-end;gap:6px;height:120px;padding:8px 0">
      ${data.map((v, i) => {
        const h = mx ? Math.max(2, Math.round(v / mx * 100)) : 2;
        return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px">
          <div style="width:100%;background:var(--m-soft);border-radius:3px 3px 0 0;height:${h}%;position:relative">
            <div style="position:absolute;top:-16px;left:50%;transform:translateX(-50%);font-size:9.5px;color:var(--text-3);white-space:nowrap">${v > 0 ? eur(v).replace('€ ', '€') : ''}</div>
          </div>
          <div style="font-size:10px;color:var(--text-3)">${esc(shownLabels[i] || '')}</div>
        </div>`;
      }).join('')}
    </div>`;
  }

  // Bouw voor projection_12m: max 12 punten + labels — respect payload-cap.
  // Fix v6: slice(0, 12) forceert dat de as niet meer dan 12 labels heeft,
  // ongeacht hoeveel maanden de endpoint returnt.
  function buildProjection12(projArr) {
    const src = asArr(projArr).slice(0, 12);
    const data   = src.map((r) => Number(r.amount) || 0);
    const labels = src.map((r) => shortMonthLabel(r.month) || (typeof r.month === 'string' ? r.month.slice(5) : ''));
    return { data, labels };
  }

  const GRADICO = `<span style="width:26px;height:26px;border-radius:7px;background:var(--violet-soft);color:var(--violet);display:grid;place-items:center;flex-shrink:0">${svg(I.grad, 'width:14px;height:14px')}</span>`;

  const PAYOUT_STATUS_PILL = {
    concept:     { c: 'neutral', l: 'Concept' },
    open:        { c: 'info',    l: 'Ter beoordeling' },
    goedgekeurd: { c: 'warn',    l: 'Goedgekeurd' },
    uitbetaald:  { c: 'ok',      l: 'Uitbetaald' },
  };
  function payoutPill(status) {
    const meta = PAYOUT_STATUS_PILL[String(status || '').toLowerCase()] || { c: 'neutral', l: status || '—' };
    return H.pill(meta.c, meta.l);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     VIEW 1 — Overzicht
     ═══════════════════════════════════════════════════════════════════════ */
  function overzichtView() {
    if (!_live.overview.loading && !_live.overview.data && !_live.overview.error) queueMicrotask(fetchOverview);
    if (_live.overview.error && !_live.overview.data) return errBlk(_live.overview.error, 'window.__verdRetryOverview()') + renderConfirmModal();
    if (!_live.overview.data) return skel() + renderConfirmModal();

    const d = _live.overview.data;
    const t = d.totals || {};
    const proj = buildProjection12(d.projection_12m);
    const perEvent = asArr(d.per_event);

    const dezeMaand   = Number(t.deze_maand)     || 0;
    const volgendeMnd = Number(t.volgende_maand) || 0;
    const openTotaal  = Number(t.open)           || 0;
    const betaaldUit  = Number(t.betaald_uit)    || 0;
    const earnedTotal = Number(t.earned_total)   || 0;
    const mx = Math.max(dezeMaand, volgendeMnd, openTotaal, 1);

    return `${H.kpis([
      { c: 'blue',    icon: I.euro,  label: 'Deze maand',       val: eur(dezeMaand),   sub: 'bonus-vrijgave' },
      { c: 'amber',   icon: I.clock, label: 'Volgende maand',   val: eur(volgendeMnd), sub: 'geplande vrijgave' },
      { c: 'teal',    icon: I.cal,   label: 'Openstaand totaal', val: eur(openTotaal), sub: 'niet-uitbetaalde bonus' },
      { c: 'emerald', icon: I.chart, label: 'Totaal verdiend',  val: eur(earnedTotal), sub: 'alle bonussen sinds start' },
    ])}
    <div class="pad" style="padding-top:16px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start">
        ${dashCard('Bonus-status', 'blue',
          hbar('Betaald uit', betaaldUit, Math.max(earnedTotal, 1), 'emerald', eur(betaaldUit))
          + hbar('Open (nog niet uitbetaald)', openTotaal, Math.max(earnedTotal, 1), 'amber', eur(openTotaal))
          + `<div style="margin-top:8px;padding-top:12px;border-top:1px solid var(--border);display:flex;justify-content:space-between;font-size:13px"><b>Totaal verdiend</b><b class="mono">${eur(earnedTotal)}</b></div>`)}
        ${dashCard('Deze vs volgende maand', 'emerald',
          hbar('Deze maand',     dezeMaand,   mx, 'blue',  eur(dezeMaand))
          + hbar('Volgende maand', volgendeMnd, mx, 'amber', eur(volgendeMnd))
          + `<div style="font-size:11.5px;color:var(--text-3);margin-top:8px">Cash-release-schema: bonus wordt vrijgegeven zodra de bijbehorende factuur betaald is (of via cash-traject).</div>`)}
      </div>
      ${proj.data.length ? `<div style="margin-top:14px">${dashCard(`Projectie · ${proj.data.length} maand${proj.data.length === 1 ? '' : 'en'}`, 'blue', areaChart(proj.data, proj.labels))}</div>` : ''}
      ${perEvent.length ? `<div style="margin-top:14px">${dashCard('Per event', 'violet',
        perEvent.map((ev) => {
          const sales = asArr(ev.sales);
          const total = sales.reduce((a, s) => a + (Number(s.mentor_share_total) || 0), 0);
          return `<div style="padding:10px 0;border-bottom:1px solid var(--border)">
            <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:600"><span>${esc(ev.event_title || '—')}</span><span class="mono">${eur(total)}</span></div>
            <div style="font-size:11.5px;color:var(--text-3);margin-top:2px">${fmtDate(ev.starts_at)} · ${sales.length} sale${sales.length === 1 ? '' : 's'}</div>
          </div>`;
        }).join(''))}</div>` : ''}
    </div>
    ${renderConfirmModal()}`;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     VIEW 2 — Coaching
     ═══════════════════════════════════════════════════════════════════════ */
  function coachingView() {
    if (!_live.coaching.loading && !_live.coaching.data && !_live.coaching.error) queueMicrotask(fetchCoaching);
    if (_live.coaching.error && !_live.coaching.data) return errBlk(_live.coaching.error, 'window.__verdRetryCoaching()') + renderConfirmModal();
    if (!_live.coaching.data) return skel() + renderConfirmModal();

    const d = _live.coaching.data;
    const bd = d.breakdown || d;
    const b = {
      one_on_one: Number(bd.one_on_one?.qty || bd.one_on_one_qty || 0),
      team:       Number(bd.team?.qty       || bd.team_qty       || 0),
      no_show:    Number(bd.no_show?.qty    || bd.no_show_qty    || 0),
      funded:     Number(bd.funded?.qty     || bd.funded_qty     || 0),
    };
    const a = {
      one_on_one: Number(bd.one_on_one?.amount_incl || bd.one_on_one_amount || (b.one_on_one * 35)),
      team:       Number(bd.team?.amount_incl       || bd.team_amount       || (b.team * 50)),
      no_show:    Number(bd.no_show?.amount_incl    || bd.no_show_amount    || (b.no_show * 25)),
      funded:     Number(bd.funded?.amount_incl     || bd.funded_amount     || (b.funded * 100)),
    };
    const total = a.one_on_one + a.team + a.no_show + a.funded;
    const from = d.from || _live.coaching.from || '—';
    const to   = d.to   || _live.coaching.to   || '—';

    return `${H.kpis([
      { c: 'blue',    icon: I.users, label: '1-op-1 sessies', val: String(b.one_on_one), sub: eur(a.one_on_one) + ' · €35/sessie' },
      { c: 'violet',  icon: I.users, label: 'Team-trainingen', val: String(b.team),       sub: eur(a.team) + ' · €50/sessie' },
      { c: 'amber',   icon: I.alert, label: 'No-show',         val: String(b.no_show),    sub: eur(a.no_show) + ' · €25/sessie' },
      { c: 'emerald', icon: I.grad,  label: 'Funded certs',    val: String(b.funded),     sub: eur(a.funded) + ' · €100 per stuk' },
    ])}
    <div class="pad" style="padding-top:16px">
      <div style="padding:10px 14px;background:var(--surface-2);border-radius:var(--r);font-size:12px;color:var(--text-3);margin-bottom:12px">
        Periode: <b>${esc(from)}</b> → <b>${esc(to)}</b> (default = huidige maand).
      </div>
      ${dashCard('Subtotaal coaching', 'emerald', `
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="border-bottom:1px solid var(--border);color:var(--text-3);font-size:11.5px;text-transform:uppercase;letter-spacing:.06em"><th style="text-align:left;padding:6px 0">Categorie</th><th style="text-align:right">Aantal</th><th style="text-align:right">Tarief</th><th style="text-align:right">Bedrag</th></tr></thead>
          <tbody>
            <tr><td style="padding:8px 0">1-op-1 sessies</td><td style="text-align:right" class="mono">${b.one_on_one}</td><td style="text-align:right" class="mono">${eur(35)}</td><td style="text-align:right" class="money">${eur(a.one_on_one)}</td></tr>
            <tr><td style="padding:8px 0">Team-trainingen</td><td style="text-align:right" class="mono">${b.team}</td><td style="text-align:right" class="mono">${eur(50)}</td><td style="text-align:right" class="money">${eur(a.team)}</td></tr>
            <tr><td style="padding:8px 0">No-show</td><td style="text-align:right" class="mono">${b.no_show}</td><td style="text-align:right" class="mono">${eur(25)}</td><td style="text-align:right" class="money">${eur(a.no_show)}</td></tr>
            <tr><td style="padding:8px 0">Funded certs</td><td style="text-align:right" class="mono">${b.funded}</td><td style="text-align:right" class="mono">${eur(100)}</td><td style="text-align:right" class="money">${eur(a.funded)}</td></tr>
            <tr style="border-top:1px solid var(--border);font-weight:600"><td style="padding:10px 0">Totaal</td><td></td><td></td><td style="text-align:right" class="money">${eur(total)}</td></tr>
          </tbody>
        </table>
        <div style="font-size:11.5px;color:var(--text-3);margin-top:10px">Tarieven vast in <code>api/_lib/coaching-earnings.js</code>. Aantallen komen live uit Bubble sessies-koppeling.</div>
      `)}
    </div>
    ${renderConfirmModal()}`;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     VIEW 3 — Events
     ═══════════════════════════════════════════════════════════════════════ */
  function eventsView() {
    if (!_live.myEvents.loading && !_live.myEvents.data && !_live.myEvents.error) queueMicrotask(fetchMyEvents);
    if (_live.myEvents.error && !_live.myEvents.data) return errBlk(_live.myEvents.error, 'window.__verdRetryMyEvents()') + renderConfirmModal();
    if (!_live.myEvents.data) return skel() + renderConfirmModal();

    const events = asArr(_live.myEvents.data.events);
    const scope = _live.myEvents.scope;
    const proj = buildProjection12(_live.overview.data?.projection_12m);

    return `${H.toolbar([
      `<div style="display:flex;gap:6px">
        <button class="btn ${scope === 'upcoming' ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="window.__verdSetMyEventsScope('upcoming')">Komend</button>
        <button class="btn ${scope === 'past'     ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="window.__verdSetMyEventsScope('past')">Voorbij</button>
        <button class="btn ${scope === 'all'      ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="window.__verdSetMyEventsScope('all')">Alles</button>
      </div>`,
    ])}
    <div class="pad" style="padding-top:16px">
      ${proj.data.length ? `<div style="margin-bottom:14px">${dashCard(`Cashflow-projectie · ${proj.data.length} maand${proj.data.length === 1 ? '' : 'en'}`, 'blue', barChart12(proj.data, proj.labels))}</div>` : ''}
      ${dashCard('Mijn events (' + scope + ')', 'violet',
        events.length ? H.table(
          [{ l: 'Event' }, { l: 'Start', cls: 'optional' }, { l: 'Rol', cls: 'optional' }, { l: 'Aanwezig' }],
          events.map((ev) => [
            `<span class="cell-main">${esc(ev.title || ev.event_title || '—')}</span>`,
            `<span style="color:var(--text-3)">${fmtDateTime(ev.starts_at)}</span>`,
            `<span style="color:var(--text-2);font-size:12.5px">${esc(ev.role || ev.mentor_role || '—')}</span>`,
            H.pill(ev.was_present ? 'ok' : 'neutral', ev.was_present ? 'Ja' : (ev.was_present === false ? 'Nee' : '—')),
          ]),
        ) : `<div style="padding:20px;text-align:center;color:var(--text-3);font-size:13px">Geen events in deze selectie.</div>`)}
    </div>
    ${renderConfirmModal()}`;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     VIEW 4 — Uitbetalingen
     ═══════════════════════════════════════════════════════════════════════ */
  function uitbetalingenView() {
    if (!_live.payouts.loading && !_live.payouts.data && !_live.payouts.error) queueMicrotask(fetchPayouts);
    if (_live.payouts.error && !_live.payouts.data) return errBlk(_live.payouts.error, 'window.__verdRetryPayouts()') + renderConfirmModal();
    if (!_live.payouts.data) return skel() + renderConfirmModal();

    const allPayouts = asArr(_live.payouts.data.payouts);
    const py = String(F('py', _ui.py) || _ui.py);
    const yr = YEAR_OF[py] || YEAR_OF['26'];
    const rows = allPayouts.filter((p) => monthKey(p.period_month).startsWith(yr + '-'));

    const uitbetaald = rows.filter((r) => r.status === 'uitbetaald').reduce((a, r) => a + (Number(r.total) || 0), 0);
    const goedgekeurd = rows.filter((r) => r.status === 'goedgekeurd').reduce((a, r) => a + (Number(r.total) || 0), 0);
    const gem = rows.length ? Math.round(rows.reduce((a, r) => a + (Number(r.total) || 0), 0) / rows.length) : 0;

    return `${H.kpis([
      { c: 'emerald', icon: I.tick,  label: 'Uitbetaald',     val: eur(uitbetaald),  sub: yr + ' · ' + rows.filter((r) => r.status === 'uitbetaald').length + ' rapport(en)' },
      { c: 'warn',    icon: I.clock, label: 'Goedgekeurd',    val: eur(goedgekeurd), sub: 'wacht op uitbetaling' },
      { c: 'blue',    icon: I.cal,   label: 'Gem. per maand', val: eur(gem),         sub: rows.length + ' maanden' },
    ])}
    ${H.toolbar([
      `<div style="display:flex;gap:6px">
        <button class="btn ${py === '26' ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="window.__verdSetPy('26')">2026</button>
        <button class="btn ${py === '25' ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="window.__verdSetPy('25')">2025</button>
      </div>`,
    ])}
    ${rows.length ? H.table(
      [
        { l: 'Periode' }, { l: 'Totaal excl.', cls: 'r optional' }, { l: 'BTW', cls: 'r optional' },
        { l: 'Totaal incl.', cls: 'r' }, { l: 'Uitbetaald op', cls: 'optional' }, { l: 'Status' },
      ],
      rows.map((p) => [
        `<span class="cell-main">${fmtMonth(p.period_month)}</span>`,
        `<span class="money">${eur(Number(p.total_excl) || 0)}</span>`,
        `<span class="money">${eur(Number(p.btw_amount) || 0)}</span>`,
        `<span class="money"><b>${eur(Number(p.total) || 0)}</b></span>`,
        `<span style="color:var(--text-3)">${fmtDate(p.paid_at)}</span>`,
        payoutPill(p.status),
      ]),
    ) : `<div style="padding:40px 20px;text-align:center;color:var(--text-3);font-size:13px">Geen uitbetalingen in ${yr}. Concept + open zijn finance-only.</div>`}
    ${renderConfirmModal()}`;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     VIEW 5 — Reiskosten
     ═══════════════════════════════════════════════════════════════════════ */
  function reiskostenView() {
    const mk = currentMonthKey();
    if (!_live.travel.loading && !_live.travel.data && !_live.travel.error) queueMicrotask(() => fetchTravel(mk));
    if (_live.travel.error && !_live.travel.data) return errBlk(_live.travel.error, 'window.__verdRetryTravel()') + renderConfirmModal();
    if (!_live.travel.data) return skel() + renderConfirmModal();

    const t = _live.travel.data;
    if (!t.travel_enabled) {
      return `<div class="empty" style="padding:72px 20px">
        <div class="empty-ico">${svg(I.route)}</div>
        <div class="empty-t">Reiskostenvergoeding staat niet aan</div>
        <div class="empty-s">Neem contact op met kantoor als dit wel zou moeten.</div>
      </div>${renderConfirmModal()}`;
    }

    const dayRate = Number(t.day_rate_incl) || 0;
    const days    = Number(t.days) || 0;
    const amount  = dayRate * days;
    const editable = !!t.editable;
    const status = t.status || null;
    const submitted = !!t.submitted;
    const needsReminder = editable && !submitted && todayIsOnOrAfterFirstFriday();

    return `${H.kpis([
      { c: 'blue',    icon: I.euro,  label: 'Vergoeding per rijdag',  val: eur(dayRate), sub: 'jouw vaste bedrag' },
      { c: 'amber',   icon: I.route, label: 'Doorgegeven deze maand', val: String(days), sub: fmtMonth(t.period_month) },
      { c: 'emerald', icon: I.chart, label: 'Vergoeding deze maand',  val: eur(amount),  sub: days + ' × ' + eur(dayRate) },
    ])}
    <div class="pad" style="padding-top:16px">
      ${needsReminder ? `<div style="padding:14px 16px;background:var(--amber-soft);border:1px solid var(--amber);color:var(--amber);border-radius:var(--r);font-size:13px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <span>⏰ Rijdagen voor ${fmtMonth(t.period_month)} nog niet doorgegeven. Doe dit vóór de uitbetaling zodat het meegenomen wordt.</span>
        <button class="btn btn-primary btn-sm" onclick="window.__verdTravelOpenForm()">Doorgeven →</button>
      </div>` : ''}
      ${dashCard('Huidige maand · ' + fmtMonth(t.period_month), 'blue', `
        <div style="display:flex;align-items:flex-start;gap:11px;padding-bottom:12px;font-size:12.5px;color:var(--text-2)">
          ${svg(I.clock, 'width:16px;height:16px;flex-shrink:0;margin-top:1px;color:var(--amber)')}
          <span>Rapport-status: ${status ? payoutPill(status) : '<i>nog geen concept aangemaakt</i>'}. ${editable ? 'Nog aanpasbaar tot goedkeuring door finance.' : '<b>Vergrendeld</b> — rapport is al goedgekeurd/uitbetaald.'}</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div style="padding:12px 14px;border:1px solid var(--border);border-radius:var(--r);background:var(--surface-2)">
            <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Doorgegeven</div>
            <div class="mono" style="font-size:20px;font-weight:600">${days} <span style="font-size:12px;color:var(--text-3);font-weight:400">dagen</span></div>
          </div>
          <div style="padding:12px 14px;border:1px solid var(--border);border-radius:var(--r);background:var(--surface-2)">
            <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Vergoeding</div>
            <div class="mono" style="font-size:20px;font-weight:600;color:var(--emerald)">${eur(amount)}</div>
          </div>
        </div>
        <div style="margin-top:14px;display:flex;justify-content:flex-end;gap:8px">
          ${editable ? `<button class="btn btn-primary" onclick="window.__verdTravelOpenForm()">${svg(I.tick)}${submitted ? 'Rijdagen wijzigen' : 'Rijdagen doorgeven'}</button>`
                     : `<button class="btn btn-ghost" disabled>Vergrendeld</button>`}
        </div>
      `)}
    </div>
    ${renderTravelFormModal()}
    ${renderConfirmModal()}`;
  }

  function renderTravelFormModal() {
    if (!_ui.travelForm) return '';
    const f = _ui.travelForm; const t = _live.travel.data;
    if (!t) return '';
    const body = `
      <div style="padding:8px 0 14px;font-size:12.5px;color:var(--text-2)">
        Aantal rijdagen voor <b>${esc(fmtMonth(t.period_month))}</b> (0 – 62). Vergoeding = aantal × ${eur(Number(t.day_rate_incl) || 0)}.
      </div>
      <label style="display:block;margin-bottom:14px">
        <span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Aantal rijdagen</span>
        <input type="number" min="0" max="62" step="1" value="${esc(f.days)}" oninput="window.__verdTravelFieldDays(this.value)"
          style="display:block;margin-top:4px;padding:8px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px;width:120px" />
      </label>
      ${f.error ? `<div style="padding:8px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px;margin-bottom:12px">${esc(f.error)}</div>` : ''}
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-ghost" onclick="window.__verdTravelCloseForm()">Annuleren</button>
        <button class="btn btn-primary" ${f.saving ? 'disabled' : ''} onclick="window.__verdTravelSubmit()">${f.saving ? 'Opslaan…' : 'Opslaan'}</button>
      </div>`;
    return modalShell('Rijdagen doorgeven', body, 'window.__verdTravelCloseForm()', 520);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     VIEW 6 — Certificaten (funded)
     ═══════════════════════════════════════════════════════════════════════ */
  function certificatenView() {
    if (!_live.certs.loading && !_live.certs.data && !_live.certs.error) queueMicrotask(fetchCerts);
    if (_live.certs.error && !_live.certs.data) return errBlk(_live.certs.error, 'window.__verdRetryCerts()') + renderConfirmModal();
    if (!_live.certs.data) return skel() + renderConfirmModal();

    const allCerts = asArr(_live.certs.data.certs);
    const py = String(F('py', _ui.py) || _ui.py);
    const yr = YEAR_OF[py] || YEAR_OF['26'];
    const rows = allCerts.filter((c) => monthKey(c.funded_month).startsWith(yr + '-'));

    const byMonth = new Map();
    rows.forEach((c) => {
      const k = monthKey(c.funded_month);
      if (!byMonth.has(k)) byMonth.set(k, { period: c.funded_month, items: [] });
      byMonth.get(k).items.push(c);
    });
    const months = Array.from(byMonth.values()).sort((a, b) => (b.period || '').localeCompare(a.period || ''));

    const totalCerts = rows.length;
    const totalMonths = months.length;
    const totalBonus = totalCerts * 100;

    return `${H.kpis([
      { c: 'violet',  icon: I.grad, label: 'Funded-certs ' + yr, val: String(totalCerts), sub: totalMonths + ' maand(en)' },
      { c: 'emerald', icon: I.tick, label: 'Bonus ' + yr,        val: eur(totalBonus),    sub: '€ 100 per geclaimd cert' },
    ])}
    ${H.toolbar([
      `<div style="display:flex;gap:6px">
        <button class="btn ${py === '26' ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="window.__verdSetPy('26')">2026</button>
        <button class="btn ${py === '25' ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="window.__verdSetPy('25')">2025</button>
      </div>`,
      `<div class="tb-right"><button class="btn btn-primary" onclick="window.__verdCertOpenUpload()">${svg(I.plus)}Certificaat claimen</button></div>`,
    ])}
    <div class="pad" style="padding-top:16px">
      <div style="padding:12px 14px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r);font-size:12.5px;color:var(--text-2);margin-bottom:14px">
        ℹ Elke geclaimde funded-cert = <b>€ 100 bonus</b> in het maandrapport. De <code>funded_month</code> LOCKT bij de eerste upload — dubbele claims per (mentor, student) zijn niet mogelijk.
      </div>
      ${months.length ? months.map((m) => `${dashCard(fmtMonth(m.period) + ' · ' + m.items.length + ' cert(s)', 'violet',
        H.table(
          [{ l: 'Student' }, { l: 'Bestand', cls: 'optional' }, { l: 'Ge-upload', cls: 'optional' }, { l: 'Bonus', cls: 'r' }],
          m.items.map((c) => [
            `<div style="display:flex;align-items:center;gap:10px">${GRADICO}<span class="cell-main">${esc(c.student_name || '—')}</span></div>`,
            `<span style="color:var(--text-3);font-family:'IBM Plex Mono',monospace;font-size:11.5px">${esc(c.file_name || '—')}</span>`,
            `<span style="color:var(--text-3)">${fmtDate(c.last_uploaded_at)}</span>`,
            `<span class="money">${eur(100)}</span>`,
          ]),
        ),
      )}<div style="height:12px"></div>`).join('') : `<div style="padding:40px 20px;text-align:center;color:var(--text-3);font-size:13px">Geen funded-certificaten in ${yr} geclaimd.</div>`}
    </div>
    ${renderCertUploadModal()}
    ${renderConfirmModal()}`;
  }

  function renderCertUploadModal() {
    if (!_ui.certUpload) return '';
    const c = _ui.certUpload;
    let body = '';
    if (c.step === 'pick') {
      if (_live.myStudents.loading && !_live.myStudents.data) {
        body = `<div style="padding:20px;color:var(--text-3);font-size:13px;text-align:center">Studenten laden…</div>`;
      } else if (_live.myStudents.error && !_live.myStudents.data) {
        body = `<div style="padding:14px 16px;background:var(--rose-soft);color:var(--rose);border-radius:var(--r);font-size:13px;margin-bottom:12px">⚠ ${esc(_live.myStudents.error)}</div><button class="btn btn-ghost btn-sm" onclick="window.__verdRetryMyStudents()">Opnieuw</button>`;
      } else if (_live.myStudents.data && _live.myStudents.data.linked === false) {
        body = `<div style="padding:14px 16px;background:var(--amber-soft);color:var(--amber);border-radius:var(--r);font-size:13px">Je account is nog niet aan Bubble gekoppeld. Neem contact op met kantoor.</div>`;
      } else {
        const students = asArr(_live.myStudents.data?.students);
        body = `
          <div style="padding:8px 0 14px;font-size:12.5px;color:var(--text-2)">Kies de student van wie je de funded-cert claimt. €100 bonus wordt in het maandrapport van ${fmtMonth(currentMonthKey() + '-01')} bijgeschreven.</div>
          ${students.length ? `<div style="max-height:340px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--r)">
            ${students.map((s) => `<div style="padding:10px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:12px;cursor:pointer" onclick="window.__verdCertPickStudent('${esc(s.bubble_id || s.id)}')" onmouseover="this.style.background='var(--surface-2)'" onmouseout="this.style.background='transparent'">
              <div><div style="font-size:13px;font-weight:600">${esc(s.name || s.email || 'Student')}</div><div style="font-size:11.5px;color:var(--text-3)">${esc(s.email || '')}</div></div>
              <button class="btn btn-primary btn-sm">Kiezen →</button>
            </div>`).join('')}
          </div>` : `<div style="padding:20px;text-align:center;color:var(--text-3);font-size:13px">Geen studenten gevonden.</div>`}
        `;
      }
    } else {
      body = `
        <div style="padding:8px 0 14px;font-size:12.5px;color:var(--text-2)">
          Student: <b>${esc(c.studentName)}</b>. Kies een PDF of afbeelding (max 10 MB).
        </div>
        <input type="file" id="verdCertFileInput" accept="application/pdf,image/*" style="display:none" onchange="window.__verdCertPickFile()">
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px">
          <button class="btn btn-ghost" onclick="document.getElementById('verdCertFileInput').click()">${svg(I.doc)}Bestand kiezen</button>
          <span style="font-size:12.5px;color:var(--text-3);font-family:'IBM Plex Mono',monospace">${esc(c.fileName || 'Geen bestand gekozen')}</span>
        </div>
        <div style="padding:10px 12px;background:var(--amber-soft);border:1px solid var(--amber);color:var(--amber);border-radius:6px;font-size:12px;margin-bottom:12px">
          ⚠ funded_month LOCKT na 1e claim voor (mentor, student). Zorg dat je de juiste student kiest — dubbele bonus is niet mogelijk.
        </div>
        ${c.error ? `<div style="padding:8px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px;margin-bottom:12px">${esc(c.error)}</div>` : ''}
        <div style="display:flex;justify-content:flex-end;gap:8px">
          <button class="btn btn-ghost" onclick="window.__verdCertCloseUpload()">Annuleren</button>
          <button class="btn btn-primary" ${(!c.file || c.saving) ? 'disabled' : ''} onclick="window.__verdCertSubmit()">${c.saving ? 'Uploaden…' : 'Uploaden + claimen'}</button>
        </div>`;
    }
    return modalShell(c.step === 'pick' ? 'Kies student' : 'Funded-cert uploaden', body, 'window.__verdCertCloseUpload()', 620);
  }

  /* ── Registratie (6 views, mentor-self only) ────────────────────────── */
  window.DFO.VIEWS['verdiensten/Overzicht']     = overzichtView;
  window.DFO.VIEWS['verdiensten/Coaching']      = coachingView;
  window.DFO.VIEWS['verdiensten/Events']        = eventsView;
  window.DFO.VIEWS['verdiensten/Uitbetalingen'] = uitbetalingenView;
  window.DFO.VIEWS['verdiensten/Reiskosten']    = reiskostenView;
  window.DFO.VIEWS['verdiensten/Certificaten']  = certificatenView;

  if (typeof window.KV_V2_ADD === 'function') {
    window.KV_V2_ADD('verdiensten');
  } else {
    (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('verdiensten');
  }

  console.debug('[verdiensten-v2] v6 — 6 views registered (Overzicht/Coaching/Events/Uitbetalingen/Reiskosten/Certificaten). Alle-mentors-admin verhuisd naar Mentoren-module. Dormant tot allowlist of ?v2preview=verdiensten.');
})();
