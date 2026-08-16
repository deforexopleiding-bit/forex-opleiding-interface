// modules/klanten-v2/views/verdiensten-v2.js
//
// Verdiensten (mentor) — BROK 1+2+3+4 volledige v1-parity.
// Module blijft DORMANT — 'verdiensten' staat NIET in V2_ACTIVE_ALLOWLIST;
// alleen bereikbaar via ?v2preview=verdiensten met rol "Mentor" (of Admin+
// voor de "Alle mentors"-tab).
//
// TABS (7):
//   BROK 1 (reads):
//     - Overzicht        → mentor-bonus-overview
//     - Uitbetalingen    → mentor-payouts-list-self (BTW-splitsing)
//     - Reiskosten       → mentor-travel-days-self (GET, huidige maand)
//     - Certificaten     → mentor-funded-certs-self (funded, €100 flat)
//   BROK 2 (extra reads):
//     - Coaching         → mentor-coaching-earnings (1-op-1/team/no-show/funded)
//     - Events           → mentor-my-events (upcoming/past)
//   BROK 3 (mentor-self writes):
//     - Reiskosten POST  → mentor-travel-days-self (POST) + reminder-banner
//                          rond 1e vrijdag v/d maand
//     - Certificaten POST→ mentor-my-students picker + Supabase Storage
//                          upload (bucket 'funded-certificates') +
//                          mentor-funded-cert-save (funded_month LOCKT
//                          na 1e claim — geen dubbele bonus)
//   BROK 4 (admin, RBAC mentor.payout.manage — extra 'revert' vereist super_admin):
//     - Alle mentors     → mentor-admin-list + mentor-payouts-admin-list +
//                          mentor-payout-detail + funded-certs-admin-list +
//                          mentor-payout-settings-get + writes:
//                          generate/approve/mark-paid/reopen/revert +
//                          adjustment-save/-delete + recurring-save/-delete +
//                          payout-config-set + ledger-set-status
//                          Elke destructieve / geld-actie heeft een
//                          confirm-modal; mark-paid / revert / delete gebruiken
//                          typ-token bevestiging (zoals follow-up ghl-guard).
//
// Bewust NIET (gedocumenteerd in inventaris):
//   - Cash-trajects mentor-view: geen self-endpoint (mentor-cash-trajects-list
//     vereist mentor.ledger.write=admin).
//   - Cash-trajects admin-tab: verdient eigen brok (wizard + termijnen).
//   - Assessments-admin: zit onder mentoren-module, niet Verdiensten.
//   - Release-sync: super_admin-only + onomkeerbaar, buiten scope.
//   - mentor-payout-run: legacy, niet in v1 UI.
//
// Guardrails: 8s Promise.race timeout · asArr()-guards · in-flight loading-
// flag · fail-soft errBlk met "Opnieuw"-retry · geen render-loop
// (queueMicrotask + loading-guard) · surgische DOM-updates op inputs
// (state-only oninput, geen full render tijdens typen) · confirm-modals
// op elke destructieve/geld-actie · typ-token op HOOG-risico (mark-paid /
// revert / delete).
//
// v4.

(function () {
  if (!window.DFO) { console.error('[verdiensten-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[verdiensten-v2] KV_V2.helpers niet geladen.'); return; }
  if (!window.KV || !window.KV.authedJson) { console.error('[verdiensten-v2] KV.authedJson niet geladen.'); return; }
  if (!window.supabase || !window.AuthShared) { console.warn('[verdiensten-v2] window.supabase/AuthShared ontbreekt — cert-upload werkt niet.'); }

  const { I, svg, S, F, render } = window.DFO;
  const H = window.KV_V2.helpers;

  /* ─────────────────────────────────────────────────────────────────────
     HELPERS — data + utils
     ───────────────────────────────────────────────────────────────────── */
  const asArr = (v) => (Array.isArray(v) ? v : []);
  const eur   = (n) => (n == null ? '—' : new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 }).format(n));
  const esc   = (v) => (H.esc ? H.esc(v) : String(v == null ? '' : v)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;'));

  const MONTH_NAMES_NL = ['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'];
  function fmtMonth(iso) {
    if (!iso) return '—';
    try { const d = new Date(iso); if (Number.isNaN(d.getTime())) return String(iso); return `${MONTH_NAMES_NL[d.getMonth()]} ${d.getFullYear()}`; }
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
  function prevMonthKey() {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  // Eerste vrijdag van de huidige maand → Date-object (voor rijdagen-reminder)
  function firstFridayOfMonth(ref = new Date()) {
    const d = new Date(ref.getFullYear(), ref.getMonth(), 1);
    while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
    return d;
  }
  function todayIsOnOrAfterFirstFriday() {
    const now = new Date(); const ff = firstFridayOfMonth(now);
    return now.getTime() >= ff.getTime();
  }

  /* ─────────────────────────────────────────────────────────────────────
     FETCH-HELPER — 8s timeout, fail-soft
     ───────────────────────────────────────────────────────────────────── */
  async function tryFetch(label, url, timeoutMs = 8000) {
    try {
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
      return await Promise.race([
        window.KV.authedJson(url, { method: 'POST', body: JSON.stringify(body || {}) }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout na ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) {
      console.warn('[verdiensten-v2] post fail:', label, '→', e?.message || e);
      return { __error: e?.message || 'onbekende fout', __status: e?.status || null };
    }
  }

  /* ─────────────────────────────────────────────────────────────────────
     RBAC — admin-tab is dormant-visible; echte gate op DFO.S.role
     ───────────────────────────────────────────────────────────────────── */
  const ADMIN_ROLES = new Set(['super_admin', 'admin', 'manager']);
  const SUPER_ADMIN_ROLES = new Set(['super_admin']); // voor revert
  function isAdminRole() { try { return ADMIN_ROLES.has(String(S.role || '').toLowerCase()); } catch (_) { return false; } }
  function isSuperAdminRole() { try { return SUPER_ADMIN_ROLES.has(String(S.role || '').toLowerCase()); } catch (_) { return false; } }

  /* ─────────────────────────────────────────────────────────────────────
     STATE
     ───────────────────────────────────────────────────────────────────── */
  const _live = {
    // BROK 1
    overview:    { loading: false, error: null, data: null },
    payouts:     { loading: false, error: null, data: null },
    travel:      { loading: false, error: null, data: null, key: null },
    certs:       { loading: false, error: null, data: null },
    // BROK 2
    coaching:    { loading: false, error: null, data: null, from: null, to: null },
    myEvents:    { loading: false, error: null, data: null, scope: 'all' },
    myStudents:  { loading: false, error: null, data: null },
    // BROK 4 — admin
    adminMentors:    { loading: false, error: null, data: null },
    adminPayouts:    { loading: false, error: null, data: null, month: null },
    adminPayoutDetail:{ loading: false, error: null, data: null, id: null },
    adminSettings:   { loading: false, error: null, data: null, mentorId: null },
    adminFundedCerts:{ loading: false, error: null, data: null, mentorId: null },
  };
  const _ui = {
    py: '26',                       // periode-chip jaar (26/25)
    // BROK 3 — reiskosten form
    travelForm:      null,           // { days, saving, error }
    // BROK 3 — cert upload
    certUpload:      null,           // { studentId, studentName, file, fileName, saving, error, step }
    // BROK 4 — admin
    adminSelectedMentorId: null,
    adminSelectedMonth:    prevMonthKey(),  // default = vorige maand
    adminExpandedPayoutId: null,
    adminAdjustmentForm:   null,     // { payoutId, id?, mentor_user_id, period_month, label, amount_incl, saving, error }
    adminRecurringForm:    null,     // { id?, mentor_user_id, label, amount_incl, active, start_month, saving, error }
    adminConfigForm:       null,     // { mentor_user_id, travel_enabled, travel_day_rate_incl, saving, error }
    // Modals (globaal)
    confirmModal:    null,           // { msg, onOk, tone }
    typedConfirmModal: null,         // { msg, token, typed, onOk, saving, error, danger }
  };
  const YEAR_OF = { '26': '2026', '25': '2025' };

  /* ─────────────────────────────────────────────────────────────────────
     UI-blokken: skel, errBlk, toast, modals
     ───────────────────────────────────────────────────────────────────── */
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

  /* Confirm-modal — simpel (LAAG/MEDIUM risk) */
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
    const toneColor = c.tone === 'danger' ? 'rose' : 'amber';
    const body = `
      <div style="padding:8px 0 16px;font-size:13.5px;line-height:1.6;color:var(--text)">${esc(c.msg)}</div>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-ghost" onclick="window.__verdConfirmCancel()">Annuleren</button>
        <button class="btn ${c.tone === 'danger' ? 'btn-danger' : 'btn-primary'}" onclick="window.__verdConfirmOk()">Bevestig</button>
      </div>`;
    return modalShell('Bevestig actie', body, 'window.__verdConfirmCancel()', 480);
  }

  /* Typed-confirm — HOOG-risico (mark-paid, revert, delete). User moet
     exacte token typen om enable-knop te krijgen. State-only oninput. */
  window.__verdTypedConfirmField = (v) => { if (_ui.typedConfirmModal) _ui.typedConfirmModal.typed = v; /* geen render, uncontrolled */ };
  window.__verdTypedConfirmCheck = () => {
    // Alleen re-render als de match-status wisselt — voorkomt focus-loss
    // tijdens typen. We spiegelen de knop-state naar disabled/enabled via
    // een surgische class-toggle.
    const m = _ui.typedConfirmModal;
    const btn = document.querySelector('[data-verd-typed-confirm-btn]');
    if (m && btn) {
      const ok = String(m.typed || '').trim() === String(m.token || '').trim();
      if (ok) btn.removeAttribute('disabled'); else btn.setAttribute('disabled', 'disabled');
    }
  };
  window.__verdTypedConfirmOk = async () => {
    const m = _ui.typedConfirmModal;
    if (!m) return;
    if (String(m.typed || '').trim() !== String(m.token || '').trim()) return;
    if (m.saving) return;
    _ui.typedConfirmModal.saving = true; render();
    try { if (typeof m.onOk === 'function') await m.onOk(); }
    catch (e) { console.warn('[verdiensten-v2] typed-confirm onOk fail', e); }
    _ui.typedConfirmModal = null; render();
  };
  window.__verdTypedConfirmCancel = () => { _ui.typedConfirmModal = null; render(); };
  function openTypedConfirm(msg, token, onOk, danger) {
    _ui.typedConfirmModal = { msg, token, typed: '', onOk, saving: false, error: null, danger: !!danger };
    render();
  }
  function renderTypedConfirmModal() {
    if (!_ui.typedConfirmModal) return '';
    const m = _ui.typedConfirmModal;
    const body = `
      <div style="padding:8px 0 8px;font-size:13.5px;line-height:1.6;color:var(--text)">${esc(m.msg)}</div>
      <div style="padding:12px 14px;background:${m.danger ? 'var(--rose-soft)' : 'var(--amber-soft)'};border:1px solid ${m.danger ? 'var(--rose)' : 'var(--amber)'};border-radius:6px;font-size:12.5px;color:${m.danger ? 'var(--rose)' : 'var(--amber)'};margin-bottom:14px">
        ⚠ Om te bevestigen, typ hieronder exact: <code style="background:var(--surface);padding:2px 6px;border-radius:4px;font-family:'IBM Plex Mono',monospace;font-weight:600">${esc(m.token)}</code>
      </div>
      <label style="display:block;margin-bottom:14px">
        <input type="text" data-verd-typed-input value="${esc(m.typed || '')}" oninput="window.__verdTypedConfirmField(this.value);window.__verdTypedConfirmCheck()" placeholder="typ hier: ${esc(m.token)}" style="display:block;width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px;font-family:'IBM Plex Mono',monospace" />
      </label>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-ghost" onclick="window.__verdTypedConfirmCancel()">Annuleren</button>
        <button class="btn ${m.danger ? 'btn-danger' : 'btn-primary'}" data-verd-typed-confirm-btn disabled onclick="window.__verdTypedConfirmOk()">${m.saving ? 'Bezig…' : 'Bevestig'}</button>
      </div>`;
    return modalShell(m.danger ? '⚠ Kritieke actie — dubbele bevestiging' : 'Bevestig actie', body, 'window.__verdTypedConfirmCancel()', 520);
  }

  /* ─────────────────────────────────────────────────────────────────────
     FETCHERS (elk met re-entrancy guard)
     ───────────────────────────────────────────────────────────────────── */
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
    // Default: huidige maand — de endpoint doet default zelf ook, laat query leeg.
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
  /* Admin fetchers */
  async function fetchAdminMentors() {
    if (_live.adminMentors.loading) return;
    _live.adminMentors.loading = true; _live.adminMentors.error = null;
    const j = await tryFetch('adminMentors', '/api/mentor-admin-list');
    _live.adminMentors.loading = false;
    if (!j || j.__error) { _live.adminMentors.error = j?.__error || 'Kon mentors niet laden'; render(); return; }
    _live.adminMentors.data = j; render();
  }
  async function fetchAdminPayouts(monthKeyStr) {
    const month = monthKeyStr || _ui.adminSelectedMonth || prevMonthKey();
    if (_live.adminPayouts.loading && _live.adminPayouts.month === month) return;
    _live.adminPayouts.loading = true; _live.adminPayouts.error = null; _live.adminPayouts.month = month;
    const j = await tryFetch('adminPayouts', `/api/mentor-payouts-admin-list?period_month=${encodeURIComponent(month)}`);
    _live.adminPayouts.loading = false;
    if (!j || j.__error) { _live.adminPayouts.error = j?.__error || 'Kon payouts niet laden'; render(); return; }
    _live.adminPayouts.data = j; render();
  }
  async function fetchAdminPayoutDetail(payoutId) {
    if (!payoutId) return;
    if (_live.adminPayoutDetail.loading && _live.adminPayoutDetail.id === payoutId) return;
    _live.adminPayoutDetail.loading = true; _live.adminPayoutDetail.error = null; _live.adminPayoutDetail.id = payoutId;
    const j = await tryFetch('adminPayoutDetail', `/api/mentor-payout-detail?payout_id=${encodeURIComponent(payoutId)}`);
    _live.adminPayoutDetail.loading = false;
    if (!j || j.__error) { _live.adminPayoutDetail.error = j?.__error || 'Kon detail niet laden'; render(); return; }
    _live.adminPayoutDetail.data = j; render();
  }
  async function fetchAdminSettings(mentorId) {
    if (!mentorId) return;
    if (_live.adminSettings.loading && _live.adminSettings.mentorId === mentorId) return;
    _live.adminSettings.loading = true; _live.adminSettings.error = null; _live.adminSettings.mentorId = mentorId;
    const j = await tryFetch('adminSettings', `/api/mentor-payout-settings-get?mentor_user_id=${encodeURIComponent(mentorId)}`);
    _live.adminSettings.loading = false;
    if (!j || j.__error) { _live.adminSettings.error = j?.__error || 'Kon settings niet laden'; render(); return; }
    _live.adminSettings.data = j; render();
  }
  async function fetchAdminFundedCerts(mentorId) {
    if (_live.adminFundedCerts.loading && _live.adminFundedCerts.mentorId === (mentorId || null)) return;
    _live.adminFundedCerts.loading = true; _live.adminFundedCerts.error = null; _live.adminFundedCerts.mentorId = mentorId || null;
    const url = mentorId ? `/api/funded-certs-admin-list?mentor_user_id=${encodeURIComponent(mentorId)}` : '/api/funded-certs-admin-list';
    const j = await tryFetch('adminFundedCerts', url);
    _live.adminFundedCerts.loading = false;
    if (!j || j.__error) { _live.adminFundedCerts.error = j?.__error || 'Kon certs niet laden'; render(); return; }
    _live.adminFundedCerts.data = j; render();
  }

  /* ─────────────────────────────────────────────────────────────────────
     WINDOW HANDLERS — retries, filters, form-state (state-only inputs)
     ───────────────────────────────────────────────────────────────────── */
  window.__verdRetryOverview = () => { _live.overview.data = null; queueMicrotask(fetchOverview); };
  window.__verdRetryPayouts  = () => { _live.payouts.data  = null; queueMicrotask(fetchPayouts);  };
  window.__verdRetryTravel   = () => { _live.travel.data   = null; queueMicrotask(() => fetchTravel(currentMonthKey())); };
  window.__verdRetryCerts    = () => { _live.certs.data    = null; queueMicrotask(fetchCerts);    };
  window.__verdRetryCoaching = () => { _live.coaching.data = null; queueMicrotask(fetchCoaching); };
  window.__verdRetryMyEvents = () => { _live.myEvents.data = null; queueMicrotask(fetchMyEvents); };
  window.__verdRetryMyStudents = () => { _live.myStudents.data = null; queueMicrotask(fetchMyStudents); };
  window.__verdRetryAdminMentors = () => { _live.adminMentors.data = null; queueMicrotask(fetchAdminMentors); };
  window.__verdRetryAdminPayouts = () => { _live.adminPayouts.data = null; queueMicrotask(() => fetchAdminPayouts(_ui.adminSelectedMonth)); };
  window.__verdRetryAdminSettings = () => { if (_ui.adminSelectedMentorId) { _live.adminSettings.data = null; queueMicrotask(() => fetchAdminSettings(_ui.adminSelectedMentorId)); } };
  window.__verdRetryAdminCerts = () => { _live.adminFundedCerts.data = null; queueMicrotask(() => fetchAdminFundedCerts(_ui.adminSelectedMentorId)); };

  window.__verdSetPy = (v) => { if (v === '25' || v === '26') { _ui.py = v; render(); } };
  window.__verdSetMyEventsScope = (s) => {
    if (!['upcoming','past','all'].includes(s)) return;
    _live.myEvents.scope = s; _live.myEvents.data = null; queueMicrotask(fetchMyEvents);
  };

  /* BROK 3 — Reiskosten POST form (state-only, uncontrolled input) */
  window.__verdTravelOpenForm = () => {
    const t = _live.travel.data;
    if (!t || !t.travel_enabled || !t.editable) return;
    _ui.travelForm = { days: Number(t.days) || 0, saving: false, error: null };
    render();
  };
  window.__verdTravelCloseForm = () => { _ui.travelForm = null; render(); };
  window.__verdTravelFieldDays = (v) => { if (_ui.travelForm) _ui.travelForm.days = v; /* geen render tijdens typen */ };
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

  /* BROK 3 — Certificaat upload/claim */
  window.__verdCertOpenUpload = () => {
    _ui.certUpload = { studentId: '', studentName: '', file: null, fileName: '', saving: false, error: null, step: 'pick' };
    // Trigger studenten-fetch als nog niet geladen
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
    if (!f) return;
    if (!_ui.certUpload) return;
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
    openConfirm(`Certificaat voor ${c.studentName} claimen voor ${fmtMonth(currentMonthKey() + '-01')}? De maand LOCKT na 1e claim — dubbele bonus is niet mogelijk. €100 bonus wordt in het maandrapport bijgeschreven.`, async () => {
      _ui.certUpload.saving = true; _ui.certUpload.error = null; render();
      try {
        // 1) Upload file naar Supabase Storage (bucket funded-certificates)
        if (!window.supabase || !window.AuthShared) throw new Error('Supabase client niet beschikbaar');
        const { data: userData } = await window.supabase.auth.getUser();
        const uid = userData?.user?.id;
        if (!uid) throw new Error('Niet geauthenticeerd');
        // Path: <uid>/<student_id>/<timestamp>-<sanitized-filename>
        const safeName = String(c.fileName || 'cert').replace(/[^A-Za-z0-9._-]/g, '_');
        const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
        const filePath = `${uid}/${c.studentId}/${ts}-${safeName}`;
        const { error: upErr } = await window.supabase.storage.from('funded-certificates').upload(filePath, c.file, { cacheControl: '3600', upsert: false });
        if (upErr) throw new Error('Upload mislukt: ' + upErr.message);
        // 2) Register via mentor-funded-cert-save
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

  /* BROK 4 — Admin: mentor-picker + maand-picker */
  window.__verdAdminPickMentor = (mid) => {
    _ui.adminSelectedMentorId = mid || null;
    _ui.adminExpandedPayoutId = null;
    _live.adminSettings.data = null; _live.adminSettings.mentorId = null;
    _live.adminFundedCerts.data = null; _live.adminFundedCerts.mentorId = null;
    if (mid) {
      queueMicrotask(() => fetchAdminSettings(mid));
      queueMicrotask(() => fetchAdminFundedCerts(mid));
    }
    render();
  };
  window.__verdAdminSetMonth = (v) => {
    if (!v || !/^\d{4}-\d{2}$/.test(v)) return;
    _ui.adminSelectedMonth = v;
    _live.adminPayouts.data = null; _live.adminPayouts.month = null;
    _ui.adminExpandedPayoutId = null;
    _live.adminPayoutDetail.data = null; _live.adminPayoutDetail.id = null;
    queueMicrotask(() => fetchAdminPayouts(v));
  };
  window.__verdAdminExpandPayout = (payoutId) => {
    if (_ui.adminExpandedPayoutId === payoutId) {
      _ui.adminExpandedPayoutId = null; render(); return;
    }
    _ui.adminExpandedPayoutId = payoutId;
    _live.adminPayoutDetail.data = null; _live.adminPayoutDetail.id = null;
    queueMicrotask(() => fetchAdminPayoutDetail(payoutId));
  };

  /* BROK 4 — Admin write-acties met per-actie risk-classificatie */
  async function refetchAdminAfterWrite() {
    _live.adminPayouts.data = null; _live.adminPayouts.month = null;
    queueMicrotask(() => fetchAdminPayouts(_ui.adminSelectedMonth));
    if (_ui.adminExpandedPayoutId) {
      _live.adminPayoutDetail.data = null; _live.adminPayoutDetail.id = null;
      queueMicrotask(() => fetchAdminPayoutDetail(_ui.adminExpandedPayoutId));
    }
  }
  // MEDIUM: generate concept
  window.__verdAdminGenerate = (mentorId) => {
    if (!isAdminRole()) return;
    openConfirm(`Concept-rapport genereren/hertellen voor ${fmtMonth(_ui.adminSelectedMonth + '-01')}? Bestaande concepten worden overschreven; goedgekeurd/uitbetaald blijven ongemoeid.`, async () => {
      const body = mentorId ? { mentor_user_id: mentorId, period_month: _ui.adminSelectedMonth } : { all: true, period_month: _ui.adminSelectedMonth };
      const resp = await tryPost('generate', '/api/mentor-payout-generate', body);
      if (!resp || resp.__error) { toast('Genereren mislukt: ' + (resp?.__error || 'onbekend'), 'error'); return; }
      toast('Concept gegenereerd', 'success');
      refetchAdminAfterWrite();
    }, 'warn');
  };
  // MEDIUM: approve (verstuurt mail!)
  window.__verdAdminApprove = (payoutId) => {
    if (!isAdminRole()) return;
    openConfirm(`Rapport goedkeuren? Er wordt automatisch een notificatie-mail naar de mentor gestuurd.`, async () => {
      const resp = await tryPost('approve', '/api/mentor-payout-approve', { payout_id: payoutId });
      if (!resp || resp.__error) { toast('Goedkeuren mislukt: ' + (resp?.__error || 'onbekend'), 'error'); return; }
      toast('Rapport goedgekeurd + mail verstuurd', 'success');
      refetchAdminAfterWrite();
    }, 'warn');
  };
  // HOOG: mark-paid — typ-token (boekt ledger definitief)
  window.__verdAdminMarkPaid = (payoutId, mentorName, amount) => {
    if (!isAdminRole()) return;
    openTypedConfirm(
      `Rapport definitief markeren als UITBETAALD voor ${mentorName}? Ledger-entries worden gekoppeld en krijgen status 'uitbetaald' — administratief is het geld weg. ${amount ? 'Bedrag: ' + eur(amount) + '.' : ''} Terugdraaien vereist super_admin + revert-flow.`,
      'MARKEER BETAALD',
      async () => {
        const resp = await tryPost('mark-paid', '/api/mentor-payout-mark-paid', { payout_id: payoutId });
        if (!resp || resp.__error) { toast('Markeer betaald mislukt: ' + (resp?.__error || 'onbekend'), 'error'); return; }
        toast('Rapport uitbetaald', 'success');
        refetchAdminAfterWrite();
      },
      true,
    );
  };
  // MEDIUM: reopen (goedgekeurd → concept)
  window.__verdAdminReopen = (payoutId) => {
    if (!isAdminRole()) return;
    openConfirm(`Rapport heropenen (goedgekeurd → concept)? De mentor krijgt dit terug te zien; wijzigingen worden opnieuw gegenereerd bij "Concept hertellen".`, async () => {
      const resp = await tryPost('reopen', '/api/mentor-payout-reopen', { payout_id: payoutId });
      if (!resp || resp.__error) { toast('Heropenen mislukt: ' + (resp?.__error || 'onbekend'), 'error'); return; }
      toast('Rapport heropend', 'success');
      refetchAdminAfterWrite();
    }, 'warn');
  };
  // HOOG: revert — typ-token (super_admin only, ontboekt ledger)
  window.__verdAdminRevert = (payoutId, mentorName) => {
    if (!isSuperAdminRole()) { toast('Alleen super_admin mag terugdraaien', 'error'); return; }
    openTypedConfirm(
      `Uitbetaald rapport van ${mentorName} TERUGDRAAIEN? Ledger-entries worden ontboekt (status → vrijgegeven, payout_id → NULL). Alleen doen bij bewezen fout — deze actie is zichtbaar in audit-trail.`,
      'REVERT',
      async () => {
        const resp = await tryPost('revert', '/api/mentor-payout-revert', { payout_id: payoutId });
        if (!resp || resp.__error) { toast('Terugdraaien mislukt: ' + (resp?.__error || 'onbekend'), 'error'); return; }
        toast('Rapport teruggedraaid', 'success');
        refetchAdminAfterWrite();
      },
      true,
    );
  };

  /* Adjustment form (LAAG/MEDIUM: raakt concept-totaal) */
  window.__verdAdminAdjOpen = (payoutId, mentorId, periodMonth, existing) => {
    if (!isAdminRole()) return;
    _ui.adminAdjustmentForm = existing
      ? { payoutId, id: existing.id, mentor_user_id: mentorId, period_month: periodMonth, label: existing.label || '', amount_incl: existing.amount_incl != null ? String(existing.amount_incl) : '', saving: false, error: null }
      : { payoutId, id: null, mentor_user_id: mentorId, period_month: periodMonth, label: '', amount_incl: '', saving: false, error: null };
    render();
  };
  window.__verdAdminAdjClose = () => { _ui.adminAdjustmentForm = null; render(); };
  window.__verdAdminAdjField = (k, v) => { if (_ui.adminAdjustmentForm) _ui.adminAdjustmentForm[k] = v; /* geen render tijdens typen */ };
  window.__verdAdminAdjSubmit = () => {
    const f = _ui.adminAdjustmentForm; if (!f) return;
    const label = String(f.label || '').trim();
    const amt = Number(f.amount_incl);
    if (!label) { f.error = 'Label vereist'; render(); return; }
    if (!Number.isFinite(amt)) { f.error = 'Bedrag moet een getal zijn (mag negatief)'; render(); return; }
    f.saving = true; f.error = null; render();
    const body = f.id ? { id: f.id, label, amount_incl: amt }
                      : { mentor_user_id: f.mentor_user_id, period_month: f.period_month, label, amount_incl: amt };
    tryPost('adj-save', '/api/mentor-payout-adjustment-save', body).then((resp) => {
      if (!resp || resp.__error) {
        _ui.adminAdjustmentForm.saving = false; _ui.adminAdjustmentForm.error = resp?.__error || 'Opslaan mislukt'; render();
        return;
      }
      toast('Post opgeslagen', 'success');
      _ui.adminAdjustmentForm = null;
      refetchAdminAfterWrite();
    });
  };
  // HOOG-lite: adjustment delete — simpele confirm (het is een concept-post)
  window.__verdAdminAdjDelete = (id, label) => {
    if (!isAdminRole()) return;
    openConfirm(`Handmatige post "${label}" verwijderen? Concept wordt hertellen.`, async () => {
      const resp = await tryPost('adj-delete', '/api/mentor-payout-adjustment-delete', { id });
      if (!resp || resp.__error) { toast('Verwijderen mislukt: ' + (resp?.__error || 'onbekend'), 'error'); return; }
      toast('Post verwijderd', 'success');
      refetchAdminAfterWrite();
    }, 'warn');
  };

  /* Recurring form (LAAG) */
  window.__verdAdminRecOpen = (mentorId, existing) => {
    if (!isAdminRole()) return;
    _ui.adminRecurringForm = existing
      ? { id: existing.id, mentor_user_id: mentorId, label: existing.label || '', amount_incl: existing.amount_incl != null ? String(existing.amount_incl) : '', active: !!existing.active, start_month: existing.start_month || '', saving: false, error: null }
      : { id: null, mentor_user_id: mentorId, label: '', amount_incl: '', active: true, start_month: currentMonthKey(), saving: false, error: null };
    render();
  };
  window.__verdAdminRecClose = () => { _ui.adminRecurringForm = null; render(); };
  window.__verdAdminRecField = (k, v) => { if (_ui.adminRecurringForm) _ui.adminRecurringForm[k] = v; /* geen render */ };
  window.__verdAdminRecSubmit = () => {
    const f = _ui.adminRecurringForm; if (!f) return;
    const label = String(f.label || '').trim();
    const amt = Number(f.amount_incl);
    if (!label) { f.error = 'Label vereist'; render(); return; }
    if (!Number.isFinite(amt) || amt < 0) { f.error = 'Bedrag moet >= 0 zijn'; render(); return; }
    f.saving = true; f.error = null; render();
    const body = { label, amount_incl: amt, active: !!f.active, start_month: f.start_month ? (f.start_month.length === 7 ? f.start_month + '-01' : f.start_month) : null };
    if (f.id) body.id = f.id; else body.mentor_user_id = f.mentor_user_id;
    tryPost('rec-save', '/api/mentor-recurring-save', body).then((resp) => {
      if (!resp || resp.__error) { f.saving = false; f.error = resp?.__error || 'Opslaan mislukt'; render(); return; }
      toast('Maandpost opgeslagen', 'success');
      _ui.adminRecurringForm = null;
      _live.adminSettings.data = null; queueMicrotask(() => fetchAdminSettings(_ui.adminSelectedMentorId));
    });
  };
  // HOOG-lite: recurring delete — typ-token (schoont config permanent)
  window.__verdAdminRecDelete = (id, label) => {
    if (!isAdminRole()) return;
    openTypedConfirm(
      `Vaste maandpost "${label}" DEFINITIEF verwijderen? Nieuwe rapporten bevatten deze post niet meer.`,
      'VERWIJDER',
      async () => {
        const resp = await tryPost('rec-delete', '/api/mentor-recurring-delete', { id });
        if (!resp || resp.__error) { toast('Verwijderen mislukt: ' + (resp?.__error || 'onbekend'), 'error'); return; }
        toast('Maandpost verwijderd', 'success');
        _live.adminSettings.data = null; queueMicrotask(() => fetchAdminSettings(_ui.adminSelectedMentorId));
      },
      false,
    );
  };

  /* Payout-config form (LAAG) */
  window.__verdAdminCfgOpen = (mentorId, cfg) => {
    if (!isAdminRole()) return;
    _ui.adminConfigForm = {
      mentor_user_id: mentorId,
      travel_enabled: !!(cfg?.travel_enabled),
      travel_day_rate_incl: cfg?.travel_day_rate_incl != null ? String(cfg.travel_day_rate_incl) : '0',
      saving: false, error: null,
    };
    render();
  };
  window.__verdAdminCfgClose = () => { _ui.adminConfigForm = null; render(); };
  window.__verdAdminCfgField = (k, v) => { if (_ui.adminConfigForm) _ui.adminConfigForm[k] = v; /* geen render */ };
  window.__verdAdminCfgSubmit = () => {
    const f = _ui.adminConfigForm; if (!f) return;
    const rate = Number(f.travel_day_rate_incl);
    if (!Number.isFinite(rate) || rate < 0) { f.error = 'Dagtarief moet >= 0 zijn'; render(); return; }
    f.saving = true; f.error = null; render();
    tryPost('cfg-set', '/api/mentor-payout-config-set', {
      mentor_user_id: f.mentor_user_id,
      travel_enabled: !!f.travel_enabled,
      travel_day_rate_incl: rate,
    }).then((resp) => {
      if (!resp || resp.__error) { f.saving = false; f.error = resp?.__error || 'Opslaan mislukt'; render(); return; }
      toast('Config opgeslagen', 'success');
      _ui.adminConfigForm = null;
      _live.adminSettings.data = null; queueMicrotask(() => fetchAdminSettings(_ui.adminSelectedMentorId));
    });
  };

  /* Ledger-set-status (MEDIUM) — snelle status-toggle vanuit rapport-detail */
  window.__verdAdminLedgerSetStatus = (entryId, newStatus) => {
    if (!isAdminRole()) return;
    openConfirm(`Ledger-entry status wijzigen naar "${newStatus}"?`, async () => {
      const resp = await tryPost('ledger-set-status', '/api/mentor-ledger-set-status', { entry_id: entryId, new_status: newStatus });
      if (!resp || resp.__error) { toast('Status wijzigen mislukt: ' + (resp?.__error || 'onbekend'), 'error'); return; }
      toast('Status gewijzigd', 'success');
      refetchAdminAfterWrite();
    }, 'warn');
  };

  /* ─────────────────────────────────────────────────────────────────────
     RENDER-HELPERS — kaartjes + charts + pill-mappings
     ───────────────────────────────────────────────────────────────────── */
  const hbar = (label, val, max, color, right) => `<div style="display:flex;align-items:center;gap:12px;margin-bottom:11px">
    <div style="width:158px;font-size:12.5px;color:var(--text-2);flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${label}</div>
    <div class="progress" style="flex:1;height:8px"><i style="width:${max ? Math.round(val / max * 100) : 0}%;background:var(--${color})"></i></div>
    <div style="width:100px;text-align:right;font-size:12.5px;font-weight:600;font-family:'IBM Plex Mono',monospace">${right}</div></div>`;

  const dashCard = (title, dotColor, body, extra) => `<div class="card">
    <div class="card-head" style="border-bottom:none;padding-bottom:6px">
      <span class="title-dot" style="background:var(--${dotColor});box-shadow:0 0 0 3px var(--${dotColor}-soft)"></span>
      <div class="card-title">${title}</div>${extra || ''}</div>
    <div class="card-body" style="padding:8px 17px 17px">${body}</div></div>`;

  function areaChart(data, labels) {
    const w = 100, h = 42, mx = Math.max(...data, 1);
    const pts = data.map((v, i) => [data.length > 1 ? i / (data.length - 1) * w : 0, h - (v / mx) * h * .88 - 2]);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:64px;display:block">
      <defs><linearGradient id="verd-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--m)" stop-opacity=".22"/><stop offset="100%" stop-color="var(--m)" stop-opacity="0"/>
      </linearGradient></defs>
      <path fill="url(#verd-grad)" d="${line} L${w},${h} L0,${h} Z"/>
      <path fill="none" stroke="var(--m)" stroke-width="1.5" vector-effect="non-scaling-stroke" d="${line}"/>
    </svg><div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-3);margin-top:4px">${labels.map(l => `<span>${l}</span>`).join('')}</div>`;
  }

  function barChart12(data, labels) {
    const mx = Math.max(...data, 1);
    return `<div style="display:flex;align-items:flex-end;gap:6px;height:120px;padding:8px 0">
      ${data.map((v, i) => {
        const h = mx ? Math.max(2, Math.round(v / mx * 100)) : 2;
        return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px">
          <div style="width:100%;background:var(--m-soft);border-radius:3px 3px 0 0;height:${h}%;position:relative">
            <div style="position:absolute;top:-16px;left:50%;transform:translateX(-50%);font-size:9.5px;color:var(--text-3);white-space:nowrap">${v > 0 ? eur(v).replace('€\u00a0', '€') : ''}</div>
          </div>
          <div style="font-size:10px;color:var(--text-3)">${esc(labels[i] || '')}</div>
        </div>`;
      }).join('')}
    </div>`;
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
     VIEW 1 — Overzicht (BROK 1)
     ═══════════════════════════════════════════════════════════════════════ */
  function overzichtView() {
    if (!_live.overview.loading && !_live.overview.data && !_live.overview.error) queueMicrotask(fetchOverview);
    if (_live.overview.error && !_live.overview.data) return errBlk(_live.overview.error, 'window.__verdRetryOverview()') + renderGlobalModals();
    if (!_live.overview.data) return skel() + renderGlobalModals();

    const d = _live.overview.data;
    const t = d.totals || {};
    const projArr = asArr(d.projection_12m);
    const perEvent = asArr(d.per_event);

    const chartData = projArr.map((r) => Number(r.amount) || 0);
    const chartLabels = projArr.map((r) => (typeof r.month === 'string' ? r.month.slice(5) : ''));

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
      ${chartData.length ? `<div style="margin-top:14px">${dashCard('12-maands projectie', 'blue', areaChart(chartData, chartLabels))}</div>` : ''}
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
    ${renderGlobalModals()}`;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     VIEW 2 — Coaching (BROK 2)
     ═══════════════════════════════════════════════════════════════════════ */
  function coachingView() {
    if (!_live.coaching.loading && !_live.coaching.data && !_live.coaching.error) queueMicrotask(fetchCoaching);
    if (_live.coaching.error && !_live.coaching.data) return errBlk(_live.coaching.error, 'window.__verdRetryCoaching()') + renderGlobalModals();
    if (!_live.coaching.data) return skel() + renderGlobalModals();

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
    ${renderGlobalModals()}`;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     VIEW 3 — Events (BROK 2)
     ═══════════════════════════════════════════════════════════════════════ */
  function eventsView() {
    if (!_live.myEvents.loading && !_live.myEvents.data && !_live.myEvents.error) queueMicrotask(fetchMyEvents);
    if (_live.myEvents.error && !_live.myEvents.data) return errBlk(_live.myEvents.error, 'window.__verdRetryMyEvents()') + renderGlobalModals();
    if (!_live.myEvents.data) return skel() + renderGlobalModals();

    const events = asArr(_live.myEvents.data.events);
    const scope = _live.myEvents.scope;

    // 12-mnd cashflow-projectie uit overview (indien beschikbaar)
    const projArr = asArr(_live.overview.data?.projection_12m);

    return `${H.toolbar([
      `<div style="display:flex;gap:6px">
        <button class="btn ${scope === 'upcoming' ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="window.__verdSetMyEventsScope('upcoming')">Komend</button>
        <button class="btn ${scope === 'past'     ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="window.__verdSetMyEventsScope('past')">Voorbij</button>
        <button class="btn ${scope === 'all'      ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="window.__verdSetMyEventsScope('all')">Alles</button>
      </div>`,
    ])}
    <div class="pad" style="padding-top:16px">
      ${projArr.length ? `<div style="margin-bottom:14px">${dashCard('12-maands cashflow-projectie', 'blue',
        barChart12(projArr.map((r) => Number(r.amount) || 0), projArr.map((r) => (typeof r.month === 'string' ? r.month.slice(5) : ''))))}</div>` : ''}
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
    ${renderGlobalModals()}`;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     VIEW 4 — Uitbetalingen (BROK 1)
     ═══════════════════════════════════════════════════════════════════════ */
  function uitbetalingenView() {
    if (!_live.payouts.loading && !_live.payouts.data && !_live.payouts.error) queueMicrotask(fetchPayouts);
    if (_live.payouts.error && !_live.payouts.data) return errBlk(_live.payouts.error, 'window.__verdRetryPayouts()') + renderGlobalModals();
    if (!_live.payouts.data) return skel() + renderGlobalModals();

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
    ${renderGlobalModals()}`;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     VIEW 5 — Reiskosten (BROK 1 read + BROK 3 write)
     ═══════════════════════════════════════════════════════════════════════ */
  function reiskostenView() {
    const mk = currentMonthKey();
    if (!_live.travel.loading && !_live.travel.data && !_live.travel.error) queueMicrotask(() => fetchTravel(mk));
    if (_live.travel.error && !_live.travel.data) return errBlk(_live.travel.error, 'window.__verdRetryTravel()') + renderGlobalModals();
    if (!_live.travel.data) return skel() + renderGlobalModals();

    const t = _live.travel.data;
    if (!t.travel_enabled) {
      return `<div class="empty" style="padding:72px 20px">
        <div class="empty-ico">${svg(I.route)}</div>
        <div class="empty-t">Reiskostenvergoeding staat niet aan</div>
        <div class="empty-s">Neem contact op met kantoor als dit wel zou moeten.</div>
      </div>${renderGlobalModals()}`;
    }

    const dayRate = Number(t.day_rate_incl) || 0;
    const days    = Number(t.days) || 0;
    const amount  = dayRate * days;
    const editable = !!t.editable;
    const status = t.status || null;
    const submitted = !!t.submitted;

    // BROK 3 — Reminder-banner rond 1e vrijdag als nog niet ingediend
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
    ${renderGlobalModals()}`;
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
     VIEW 6 — Certificaten (BROK 1 read + BROK 3 upload)
     ═══════════════════════════════════════════════════════════════════════ */
  function certificatenView() {
    if (!_live.certs.loading && !_live.certs.data && !_live.certs.error) queueMicrotask(fetchCerts);
    if (_live.certs.error && !_live.certs.data) return errBlk(_live.certs.error, 'window.__verdRetryCerts()') + renderGlobalModals();
    if (!_live.certs.data) return skel() + renderGlobalModals();

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
    ${renderGlobalModals()}`;
  }

  function renderCertUploadModal() {
    if (!_ui.certUpload) return '';
    const c = _ui.certUpload;
    let body = '';
    if (c.step === 'pick') {
      // Studenten-picker
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
      // Upload-step
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

  /* ═══════════════════════════════════════════════════════════════════════
     VIEW 7 — Alle mentors (BROK 4, admin)
     ═══════════════════════════════════════════════════════════════════════ */
  function alleMentorsView() {
    if (!isAdminRole()) {
      return `<div class="empty" style="padding:72px 20px">
        <div class="empty-ico">${svg(I.grad)}</div>
        <div class="empty-t">Geen toegang</div>
        <div class="empty-s">De admin-view "Alle mentors" is alleen zichtbaar voor rollen manager / admin / super_admin. Wissel via "Bekijk als" of vraag toegang aan.</div>
      </div>${renderGlobalModals()}`;
    }

    if (!_live.adminMentors.loading && !_live.adminMentors.data && !_live.adminMentors.error) queueMicrotask(fetchAdminMentors);
    if (!_live.adminPayouts.loading && !_live.adminPayouts.data && !_live.adminPayouts.error) queueMicrotask(() => fetchAdminPayouts(_ui.adminSelectedMonth));

    if (_live.adminMentors.error && !_live.adminMentors.data) return errBlk(_live.adminMentors.error, 'window.__verdRetryAdminMentors()') + renderGlobalModals();

    const mentors = asArr(_live.adminMentors.data?.mentors);
    const payouts = asArr(_live.adminPayouts.data?.payouts);

    // KPI's over huidige maand-selectie
    const totalIncl  = payouts.reduce((a, p) => a + (Number(p.total) || 0), 0);
    const totalExcl  = payouts.reduce((a, p) => a + (Number(p.total_excl) || 0), 0);
    const totalBtw   = payouts.reduce((a, p) => a + (Number(p.btw_amount) || 0), 0);
    const nConcept   = payouts.filter((p) => p.status === 'concept').length;
    const nGoedgek   = payouts.filter((p) => p.status === 'goedgekeurd').length;
    const nUitbet    = payouts.filter((p) => p.status === 'uitbetaald').length;

    return `${H.kpis([
      { c: 'blue',    icon: I.euro,  label: 'Totaal incl.', val: eur(totalIncl), sub: payouts.length + ' rapport(en)' },
      { c: 'neutral', icon: I.chart, label: 'Totaal excl.', val: eur(totalExcl), sub: 'BTW: ' + eur(totalBtw) },
      { c: 'amber',   icon: I.clock, label: 'Concept',      val: String(nConcept), sub: 'nog niet goedgekeurd' },
      { c: 'ok',      icon: I.tick,  label: 'Uitbetaald',   val: String(nUitbet), sub: nGoedgek + ' goedgekeurd wacht' },
    ])}
    ${H.toolbar([
      `<label style="display:flex;align-items:center;gap:8px;font-size:12.5px"><span style="color:var(--text-3)">Periode:</span>
        <input type="month" value="${esc(_ui.adminSelectedMonth)}" onchange="window.__verdAdminSetMonth(this.value)"
               style="padding:5px 8px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px" /></label>`,
      `<button class="btn btn-primary btn-sm" onclick="window.__verdAdminGenerate(null)">${svg(I.plus)}Genereer alle concepten</button>`,
    ])}
    ${_live.adminPayouts.loading && !_live.adminPayouts.data ? skel()
     : _live.adminPayouts.error && !_live.adminPayouts.data ? errBlk(_live.adminPayouts.error, 'window.__verdRetryAdminPayouts()')
     : `<div class="pad" style="padding-top:8px">
      ${payouts.length ? `<div class="card"><div class="card-body" style="padding:0">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="border-bottom:1px solid var(--border);color:var(--text-3);font-size:11.5px;text-transform:uppercase;letter-spacing:.06em">
            <th style="text-align:left;padding:10px 14px">Mentor</th>
            <th style="text-align:right;padding:10px 14px">Bonus</th>
            <th style="text-align:right;padding:10px 14px">Coaching</th>
            <th style="text-align:right;padding:10px 14px">Totaal excl.</th>
            <th style="text-align:right;padding:10px 14px">BTW</th>
            <th style="text-align:right;padding:10px 14px">Totaal incl.</th>
            <th style="text-align:left;padding:10px 14px">Status</th>
            <th style="text-align:right;padding:10px 14px"></th>
          </tr></thead>
          <tbody>
            ${payouts.map((p) => {
              const isOpen = _ui.adminExpandedPayoutId === p.id;
              return `<tr style="border-bottom:1px solid var(--border);cursor:pointer" onclick="window.__verdAdminExpandPayout('${esc(p.id)}')">
                <td style="padding:10px 14px"><div class="cell-main">${esc(p.mentor_name || p.mentor_email || '—')}</div><div style="font-size:11.5px;color:var(--text-3)">${esc(p.mentor_email || '')}</div></td>
                <td style="padding:10px 14px;text-align:right" class="money">${eur(Number(p.bonus_total) || 0)}</td>
                <td style="padding:10px 14px;text-align:right" class="money">${eur(Number(p.coaching_total) || 0)}</td>
                <td style="padding:10px 14px;text-align:right" class="money">${eur(Number(p.total_excl) || 0)}</td>
                <td style="padding:10px 14px;text-align:right" class="money">${eur(Number(p.btw_amount) || 0)}</td>
                <td style="padding:10px 14px;text-align:right" class="money"><b>${eur(Number(p.total) || 0)}</b></td>
                <td style="padding:10px 14px">${payoutPill(p.status)}</td>
                <td style="padding:10px 14px;text-align:right;font-size:12px;color:var(--text-3)">${isOpen ? '▲' : '▼'}</td>
              </tr>
              ${isOpen ? `<tr><td colspan="8" style="padding:0;background:var(--surface-2)"><div style="padding:16px 22px" onclick="event.stopPropagation()">${renderAdminPayoutDetail(p)}</div></td></tr>` : ''}`;
            }).join('')}
          </tbody>
        </table>
      </div></div>` : `<div style="padding:40px 20px;text-align:center;color:var(--text-3);font-size:13px">Geen rapporten voor ${fmtMonth(_ui.adminSelectedMonth + '-01')}. Klik "Genereer alle concepten" om te starten.</div>`}
    </div>`}

    <div class="pad" style="padding-top:16px">
      ${dashCard('Mentor-picker (voor settings + certs-drilldown)', 'blue', `
        <select onchange="window.__verdAdminPickMentor(this.value)" style="padding:6px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px;min-width:280px">
          <option value="">— kies mentor —</option>
          ${mentors.map((m) => `<option value="${esc(m.user_id || m.id)}" ${_ui.adminSelectedMentorId === (m.user_id || m.id) ? 'selected' : ''}>${esc(m.name || m.email || m.user_id)}</option>`).join('')}
        </select>
        ${_ui.adminSelectedMentorId ? renderAdminMentorDrilldown() : ''}
      `)}
    </div>
    ${renderAdjustmentFormModal()}
    ${renderRecurringFormModal()}
    ${renderConfigFormModal()}
    ${renderGlobalModals()}`;
  }

  function renderAdminPayoutDetail(payoutRow) {
    if (_live.adminPayoutDetail.loading && (!_live.adminPayoutDetail.data || _live.adminPayoutDetail.id !== payoutRow.id)) return skel();
    if (_live.adminPayoutDetail.error && _live.adminPayoutDetail.id === payoutRow.id) return errBlk(_live.adminPayoutDetail.error, `window.__verdAdminExpandPayout('${esc(payoutRow.id)}')`);
    if (!_live.adminPayoutDetail.data || _live.adminPayoutDetail.id !== payoutRow.id) return skel();

    const d = _live.adminPayoutDetail.data.payout || _live.adminPayoutDetail.data;
    const lines = asArr(d.lines);
    const adjustments = asArr(d.adjustments);

    const canApprove   = d.status === 'concept' || d.status === 'open';
    const canMarkPaid  = d.status === 'goedgekeurd';
    const canReopen    = d.status === 'goedgekeurd';
    const canRevert    = d.status === 'uitbetaald' && isSuperAdminRole();
    const canRegen     = d.status === 'concept' || d.status === 'open';
    const canEditAdj   = d.status === 'concept' || d.status === 'open';

    return `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
      ${canRegen ? `<button class="btn btn-ghost btn-sm" onclick="window.__verdAdminGenerate('${esc(d.mentor_user_id)}')">${svg(I.repeat)}Concept hertellen</button>` : ''}
      ${canApprove ? `<button class="btn btn-primary btn-sm" onclick="window.__verdAdminApprove('${esc(d.id)}')">${svg(I.tick)}Goedkeuren + mail</button>` : ''}
      ${canMarkPaid ? `<button class="btn btn-primary btn-sm" onclick="window.__verdAdminMarkPaid('${esc(d.id)}','${esc(d.mentor_name || 'mentor').replace(/'/g, "\\'")}',${Number(d.total) || 0})">${svg(I.euro)}Markeer betaald…</button>` : ''}
      ${canReopen ? `<button class="btn btn-ghost btn-sm" onclick="window.__verdAdminReopen('${esc(d.id)}')">↩ Heropen</button>` : ''}
      ${canRevert ? `<button class="btn btn-danger btn-sm" onclick="window.__verdAdminRevert('${esc(d.id)}','${esc(d.mentor_name || 'mentor').replace(/'/g, "\\'")}')">⏪ Terugdraaien…</button>` : ''}
    </div>
    <div style="font-size:11.5px;color:var(--text-3);margin-bottom:10px">
      Gegenereerd: ${fmtDateTime(d.generated_at)} · Goedgekeurd: ${fmtDateTime(d.approved_at)} · Uitbetaald: ${fmtDateTime(d.paid_at)}
    </div>
    <div style="margin-bottom:14px">${dashCard('Regels', 'blue',
      lines.length ? H.table(
        [{ l: 'Categorie' }, { l: 'Label', cls: 'optional' }, { l: 'Aantal', cls: 'r optional' }, { l: 'Tarief incl.', cls: 'r optional' }, { l: 'Excl.', cls: 'r' }, { l: 'Incl.', cls: 'r' }],
        lines.map((l) => [
          `<span class="cell-main">${esc(l.kind || '—')}</span>`,
          `<span style="color:var(--text-2);font-size:12.5px">${esc(l.label || '')}</span>`,
          `<span class="mono">${l.qty != null ? l.qty : '—'}</span>`,
          `<span class="money">${l.unit_incl != null ? eur(Number(l.unit_incl)) : '—'}</span>`,
          `<span class="money">${eur(Number(l.amount_excl) || 0)}</span>`,
          `<span class="money"><b>${eur(Number(l.amount_incl) || 0)}</b></span>`,
        ]),
      ) : `<div style="padding:12px;color:var(--text-3);font-size:12.5px">Geen regels.</div>`)}
    </div>
    <div>${dashCard('Handmatige posten (adjustments)', 'violet', `
      ${adjustments.length ? H.table(
        [{ l: 'Label' }, { l: 'Excl.', cls: 'r optional' }, { l: 'Incl.', cls: 'r' }, { l: '', cls: 'r' }],
        adjustments.map((a) => [
          `<span class="cell-main">${esc(a.label || '—')}</span>`,
          `<span class="money">${eur(Number(a.amount_excl) || 0)}</span>`,
          `<span class="money"><b>${eur(Number(a.amount_incl) || 0)}</b></span>`,
          canEditAdj ? `<div style="display:flex;gap:6px;justify-content:flex-end">
            <button class="btn btn-ghost btn-sm" onclick="window.__verdAdminAdjOpen('${esc(d.id)}','${esc(d.mentor_user_id)}','${esc(d.period_month)}',${JSON.stringify({ id: a.id, label: a.label, amount_incl: a.amount_incl }).replace(/"/g, '&quot;')})">Bewerken</button>
            <button class="btn btn-danger btn-sm" onclick="window.__verdAdminAdjDelete('${esc(a.id)}','${esc(a.label || '').replace(/'/g, "\\'")}')">Verwijderen</button>
          </div>` : '',
        ]),
      ) : `<div style="padding:12px;color:var(--text-3);font-size:12.5px">Geen handmatige posten.</div>`}
      ${canEditAdj ? `<div style="margin-top:10px"><button class="btn btn-ghost btn-sm" onclick="window.__verdAdminAdjOpen('${esc(d.id)}','${esc(d.mentor_user_id)}','${esc(d.period_month)}',null)">${svg(I.plus)}Post toevoegen</button></div>`
                   : `<div style="margin-top:10px;font-size:11.5px;color:var(--text-3);font-style:italic">Handmatige posten kunnen niet meer worden aangepast (rapport is ${d.status}).</div>`}
    `)}</div>`;
  }

  function renderAdminMentorDrilldown() {
    if (_live.adminSettings.loading && !_live.adminSettings.data) return `<div style="margin-top:14px">${skel()}</div>`;
    if (_live.adminSettings.error && !_live.adminSettings.data) return `<div style="margin-top:14px">${errBlk(_live.adminSettings.error, 'window.__verdRetryAdminSettings()')}</div>`;
    if (!_live.adminSettings.data) return '';
    const s = _live.adminSettings.data;
    const cfg = s.config || {};
    const recurring = asArr(s.recurring);
    const certs = asArr(_live.adminFundedCerts.data?.certs);
    const mid = _ui.adminSelectedMentorId;

    return `<div style="margin-top:14px;display:grid;grid-template-columns:1fr;gap:14px">
      ${dashCard('Payout-config', 'blue', `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:10px">
          <div><div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Reiskosten</div><div style="font-size:14px;font-weight:600">${cfg.travel_enabled ? 'Ingeschakeld' : 'Uit'}</div></div>
          <div><div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Dagtarief (incl.)</div><div class="mono" style="font-size:14px;font-weight:600">${eur(Number(cfg.travel_day_rate_incl) || 0)}</div></div>
        </div>
        <div style="display:flex;justify-content:flex-end"><button class="btn btn-ghost btn-sm" onclick='window.__verdAdminCfgOpen("${esc(mid)}",${JSON.stringify(cfg).replace(/"/g, "&quot;")})'>Bewerken</button></div>
      `)}
      ${dashCard('Vaste maandposten', 'violet', `
        ${recurring.length ? H.table(
          [{ l: 'Label' }, { l: 'Bedrag (incl.)', cls: 'r' }, { l: 'Vanaf', cls: 'optional' }, { l: 'Actief' }, { l: '', cls: 'r' }],
          recurring.map((r) => [
            `<span class="cell-main">${esc(r.label)}</span>`,
            `<span class="money">${eur(Number(r.amount_incl) || 0)}</span>`,
            `<span style="color:var(--text-3)">${r.start_month ? fmtMonth(r.start_month) : 'vanaf altijd'}</span>`,
            H.pill(r.active ? 'ok' : 'neutral', r.active ? 'Actief' : 'Inactief'),
            `<div style="display:flex;gap:6px;justify-content:flex-end">
              <button class="btn btn-ghost btn-sm" onclick='window.__verdAdminRecOpen("${esc(mid)}",${JSON.stringify(r).replace(/"/g, "&quot;")})'>Bewerken</button>
              <button class="btn btn-danger btn-sm" onclick="window.__verdAdminRecDelete('${esc(r.id)}','${esc(r.label).replace(/'/g, "\\'")}')">Verwijderen</button>
            </div>`,
          ]),
        ) : `<div style="padding:12px;color:var(--text-3);font-size:12.5px">Geen vaste maandposten.</div>`}
        <div style="margin-top:10px"><button class="btn btn-ghost btn-sm" onclick="window.__verdAdminRecOpen('${esc(mid)}',null)">${svg(I.plus)}Maandpost toevoegen</button></div>
      `)}
      ${dashCard('Funded-certs (admin)', 'emerald', `
        ${_live.adminFundedCerts.loading && !_live.adminFundedCerts.data ? '<div style="padding:12px;color:var(--text-3);font-size:12.5px">Laden…</div>'
         : _live.adminFundedCerts.error && !_live.adminFundedCerts.data ? errBlk(_live.adminFundedCerts.error, 'window.__verdRetryAdminCerts()')
         : certs.length ? H.table(
          [{ l: 'Student' }, { l: 'Bestand', cls: 'optional' }, { l: 'Maand', cls: 'optional' }, { l: 'Ge-upload', cls: 'optional' }, { l: 'Bonus', cls: 'r' }, { l: '' }],
          certs.map((c) => [
            `<div style="display:flex;align-items:center;gap:10px">${GRADICO}<span class="cell-main">${esc(c.student_name || '—')}</span></div>`,
            `<span style="color:var(--text-3);font-family:'IBM Plex Mono',monospace;font-size:11.5px">${esc(c.file_name || '—')}</span>`,
            `<span>${fmtMonth(c.funded_month)}</span>`,
            `<span style="color:var(--text-3)">${fmtDate(c.last_uploaded_at)}</span>`,
            `<span class="money">${eur(100)}</span>`,
            c.download_url ? `<a href="${esc(c.download_url)}" target="_blank" rel="noopener" class="btn btn-ghost btn-sm">${svg(I.down)}Download</a>` : `<span style="color:var(--text-3);font-size:11.5px">n.v.t.</span>`,
          ]),
        ) : `<div style="padding:12px;color:var(--text-3);font-size:12.5px">Geen funded-certs voor deze mentor.</div>`}
        <div style="margin-top:8px;font-size:11px;color:var(--text-3);font-style:italic">Download-URLs zijn 1 uur geldig.</div>
      `)}
    </div>`;
  }

  /* Admin modals (adjustment / recurring / config) — uncontrolled inputs */
  function renderAdjustmentFormModal() {
    if (!_ui.adminAdjustmentForm) return '';
    const f = _ui.adminAdjustmentForm;
    const body = `
      <div style="padding:8px 0 14px;font-size:12.5px;color:var(--text-2)">
        Handmatige post voor ${fmtMonth(f.period_month)}. Bedrag mag negatief (inhouding).
      </div>
      <label style="display:block;margin-bottom:12px">
        <span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Label</span>
        <input type="text" value="${esc(f.label)}" oninput="window.__verdAdminAdjField('label', this.value)"
          style="display:block;width:100%;margin-top:4px;padding:8px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px" />
      </label>
      <label style="display:block;margin-bottom:14px">
        <span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Bedrag (incl.) — negatief = inhouding</span>
        <input type="number" step="0.01" value="${esc(f.amount_incl)}" oninput="window.__verdAdminAdjField('amount_incl', this.value)"
          style="display:block;width:180px;margin-top:4px;padding:8px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px" />
      </label>
      ${f.error ? `<div style="padding:8px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px;margin-bottom:12px">${esc(f.error)}</div>` : ''}
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-ghost" onclick="window.__verdAdminAdjClose()">Annuleren</button>
        <button class="btn btn-primary" ${f.saving ? 'disabled' : ''} onclick="window.__verdAdminAdjSubmit()">${f.saving ? 'Opslaan…' : 'Opslaan'}</button>
      </div>`;
    return modalShell(f.id ? 'Post bewerken' : 'Post toevoegen', body, 'window.__verdAdminAdjClose()', 520);
  }

  function renderRecurringFormModal() {
    if (!_ui.adminRecurringForm) return '';
    const f = _ui.adminRecurringForm;
    const body = `
      <label style="display:block;margin-bottom:12px">
        <span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Label</span>
        <input type="text" value="${esc(f.label)}" oninput="window.__verdAdminRecField('label', this.value)"
          style="display:block;width:100%;margin-top:4px;padding:8px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px" />
      </label>
      <label style="display:block;margin-bottom:12px">
        <span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Bedrag (incl.)</span>
        <input type="number" step="0.01" min="0" value="${esc(f.amount_incl)}" oninput="window.__verdAdminRecField('amount_incl', this.value)"
          style="display:block;width:180px;margin-top:4px;padding:8px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px" />
      </label>
      <label style="display:block;margin-bottom:12px">
        <span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Vanaf maand (optioneel)</span>
        <input type="month" value="${esc((f.start_month || '').slice(0,7))}" oninput="window.__verdAdminRecField('start_month', this.value)"
          style="display:block;width:180px;margin-top:4px;padding:8px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px" />
      </label>
      <label style="display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:13px">
        <input type="checkbox" ${f.active ? 'checked' : ''} onchange="window.__verdAdminRecField('active', this.checked)"> Actief
      </label>
      ${f.error ? `<div style="padding:8px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px;margin-bottom:12px">${esc(f.error)}</div>` : ''}
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-ghost" onclick="window.__verdAdminRecClose()">Annuleren</button>
        <button class="btn btn-primary" ${f.saving ? 'disabled' : ''} onclick="window.__verdAdminRecSubmit()">${f.saving ? 'Opslaan…' : 'Opslaan'}</button>
      </div>`;
    return modalShell(f.id ? 'Maandpost bewerken' : 'Maandpost toevoegen', body, 'window.__verdAdminRecClose()', 520);
  }

  function renderConfigFormModal() {
    if (!_ui.adminConfigForm) return '';
    const f = _ui.adminConfigForm;
    const body = `
      <label style="display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:13px">
        <input type="checkbox" ${f.travel_enabled ? 'checked' : ''} onchange="window.__verdAdminCfgField('travel_enabled', this.checked)"> Reiskosten meerekenen
      </label>
      <label style="display:block;margin-bottom:14px">
        <span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Dagtarief (incl.)</span>
        <input type="number" step="0.01" min="0" value="${esc(f.travel_day_rate_incl)}" oninput="window.__verdAdminCfgField('travel_day_rate_incl', this.value)"
          style="display:block;width:180px;margin-top:4px;padding:8px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px" />
      </label>
      <div style="padding:10px 12px;background:var(--surface-2);border-radius:6px;font-size:11.5px;color:var(--text-3);margin-bottom:12px">
        ℹ Wijzigingen gelden vanaf de eerstvolgende "Genereer concept"-run. Bestaande concepten worden niet automatisch hertellen.
      </div>
      ${f.error ? `<div style="padding:8px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px;margin-bottom:12px">${esc(f.error)}</div>` : ''}
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-ghost" onclick="window.__verdAdminCfgClose()">Annuleren</button>
        <button class="btn btn-primary" ${f.saving ? 'disabled' : ''} onclick="window.__verdAdminCfgSubmit()">${f.saving ? 'Opslaan…' : 'Opslaan'}</button>
      </div>`;
    return modalShell('Payout-config bewerken', body, 'window.__verdAdminCfgClose()', 520);
  }

  /* Globale modals-strip — komt achteraan in elke view */
  function renderGlobalModals() {
    return `${renderConfirmModal()}${renderTypedConfirmModal()}`;
  }

  /* ─────────────────────────────────────────────────────────────────────
     REGISTRATIE (7 views)
     ───────────────────────────────────────────────────────────────────── */
  window.DFO.VIEWS['verdiensten/Overzicht']     = overzichtView;
  window.DFO.VIEWS['verdiensten/Coaching']      = coachingView;
  window.DFO.VIEWS['verdiensten/Events']        = eventsView;
  window.DFO.VIEWS['verdiensten/Uitbetalingen'] = uitbetalingenView;
  window.DFO.VIEWS['verdiensten/Reiskosten']    = reiskostenView;
  window.DFO.VIEWS['verdiensten/Certificaten']  = certificatenView;
  window.DFO.VIEWS['verdiensten/Alle mentors']  = alleMentorsView;

  if (typeof window.KV_V2_ADD === 'function') {
    window.KV_V2_ADD('verdiensten');
  } else {
    (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('verdiensten');
  }

  console.debug('[verdiensten-v2] BROK 1+2+3+4 (v4) — 7 views geregistreerd. Dormant tot allowlist of ?v2preview=verdiensten.');
})();
