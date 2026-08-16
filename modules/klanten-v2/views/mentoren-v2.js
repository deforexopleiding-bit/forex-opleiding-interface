// modules/klanten-v2/views/mentoren-v2.js
//
// Mentoren (admin-hub) — v2, volledige v1-parity build.
// Module blijft DORMANT ('mentoren' NIET in V2_ACTIVE_ALLOWLIST).
//
// SCOPE: primaire admin-hub voor mentor-payouts + funded-certs +
// assessments + cash-trajects + release-sync. Mentor-self (bonus-overview,
// uitbetalingen, reiskosten, certificaten claim) blijft in Verdiensten-
// module (mentor-only). Payout-admin-functies uit verdiensten BROK 4 zijn
// hier 1-op-1 hergebruikt (commit 73b50bd7 van feat/v2-verdiensten-brok1).
//
// TABS (6, admin-only):
//   BROK 1 — reads
//     - Overzicht      → mentor-admin-list + mentor-payout-settings-get +
//                        mentor-bonus-overview (dual-gate)
//                        + mentor-ledger-overview + mentor-my-events
//                        (per-mentor drilldown)
//     - Rapporten      → mentor-payouts-admin-list + mentor-payout-detail
//                        (row-expand)
//     - Certificaten   → funded-certs-admin-list (signed URLs 1u)
//     - Beoordelingen  → assessments-admin-list (read-only)
//   BROK 2 — payout writes (hoog klant-risk)
//     Zelfde flows als verdiensten BROK 4 (nu hier permanent):
//     mentor-payout-generate + bulk-bar +
//     mentor-payout-approve (mail-waarschuwing) +
//     mentor-payout-mark-paid (typed "MARKEER BETAALD") +
//     mentor-payout-reopen +
//     mentor-payout-revert (super_admin + typed "REVERT") +
//     mentor-payout-adjustment-save/-delete +
//     mentor-payout-config-set + mentor-recurring-save/-delete
//     (typed "VERWIJDER" voor recurring-delete) +
//     mentor-ledger-set-status
//   BROK 3 — cash-trajects
//     mentor-cash-trajects-list + traject-kaart + termijn-uitklap +
//     wizard-modal (events-list) + mentor-cash-traject-save/-status/-release
//   BROK 4 — release-sync + polish
//     admin/bonus-release-sync dry-run + definitief
//     (super_admin only + typed "SYNC BEVESTIGEN") + coaching-debug knop.
//
// Bewust NIET (gedocumenteerd in recon):
//   - Signalen-tab (was v1 mentoren-beheer NIET; hoort in follow-up).
//   - Grootboek platform-brede view (v1 heeft mentor-grootboek.html als
//     86-regel redirect — obsolete). Per-mentor ledger zit in drilldown.
//   - Mentor toevoegen/deactiveren (accounts via /modules/admin.html).
//   - Coaching-debug: als sub-knop in payout-detail (BROK 4).
//
// Guardrails: 8s Promise.race timeout · asArr() · in-flight loading-flag ·
// fail-soft errBlk met "Opnieuw"-retry · geen render-loop · uncontrolled
// inputs (state-only oninput) · runtime dep-check (KV) alleen in tryFetch/
// tryPost, NOOIT top-level bail · elke write heeft een confirm-modal ·
// HOOG-risk = typed-token confirm.
//
// v2.

(function () {
  if (!window.DFO) { console.error('[mentoren-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[mentoren-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, S, F, render } = window.DFO;
  const H = window.KV_V2.helpers;

  /* ── Helpers ─────────────────────────────────────────────────────────── */
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
  function currentMonthKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  function prevMonthKey() {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
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
      console.warn('[mentoren-v2] fetch fail:', label, '→', e?.message || e);
      return { __error: e?.message || 'onbekende fout' };
    }
  }
  async function tryPost(label, url, body, timeoutMs = 15000) {
    try {
      if (!window.KV || typeof window.KV.authedJson !== 'function') {
        throw new Error('KV.authedJson nog niet geladen');
      }
      return await Promise.race([
        window.KV.authedJson(url, { method: 'POST', body: JSON.stringify(body || {}) }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout na ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) {
      console.warn('[mentoren-v2] post fail:', label, '→', e?.message || e);
      return { __error: e?.message || 'onbekende fout', __status: e?.status || null };
    }
  }

  /* ── RBAC ────────────────────────────────────────────────────────────── */
  const ADMIN_ROLES = new Set(['super_admin', 'admin', 'manager']);
  const SUPER_ADMIN_ROLES = new Set(['super_admin']);
  function isAdminRole() { try { return ADMIN_ROLES.has(String(S.role || '').toLowerCase()); } catch (_) { return false; } }
  function isSuperAdminRole() { try { return SUPER_ADMIN_ROLES.has(String(S.role || '').toLowerCase()); } catch (_) { return false; } }

  /* ── State ───────────────────────────────────────────────────────────── */
  const _live = {
    // BROK 1 reads
    mentors:      { loading: false, error: null, data: null },
    payouts:      { loading: false, error: null, data: null, month: null },
    payoutDetail: { loading: false, error: null, data: null, id: null },
    settings:     { loading: false, error: null, data: null, mentorId: null },
    bonusOverview:{ loading: false, error: null, data: null, mentorId: null },
    ledger:       { loading: false, error: null, data: null, mentorId: null },
    myEvents:     { loading: false, error: null, data: null, mentorId: null },
    myCalendar:   { loading: false, error: null, data: null, mentorId: null },
    fundedCerts:  { loading: false, error: null, data: null, mentorId: null },
    assessments:  { loading: false, error: null, data: null, month: null, mentorId: null },
    // BROK 3 cash-trajects
    trajects:     { loading: false, error: null, data: null, statusFilter: 'all' },
    eventsList:   { loading: false, error: null, data: null },  // voor wizard event-select
    // BROK 4 release-sync
    syncPreview:  { loading: false, error: null, data: null },
  };
  const _ui = {
    // BROK 1
    selectedMentorId: null,
    selectedMonth:    prevMonthKey(),
    expandedPayoutId: null,
    // Beoordelingen
    assessMonth:      currentMonthKey(),
    assessMentorId:   '',
    assessSearch:     '',
    // Certificaten
    certSearch:       '',
    // Trajecten
    expandedTrajectId: null,
    // BROK 2 forms
    adjustmentForm:   null,     // { payoutId, id?, mentor_user_id, period_month, label, amount_incl, saving, error }
    recurringForm:    null,     // { id?, mentor_user_id, label, amount_incl, active, start_month, saving, error }
    configForm:       null,     // { mentor_user_id, travel_enabled, travel_day_rate_incl, saving, error }
    // BROK 3 wizard
    trajectForm:      null,     // { id?, event_id, client_label, total_amount, term_count, start_month, release_day, note, saving, error }
    // Modals
    confirmModal:      null,     // { msg, onOk, tone, danger }
    typedConfirmModal: null,     // { msg, token, typed, onOk, saving, error, danger }
    // Bulk-selectie in Rapporten-tab
    bulkSelected:     new Set(),
    bulkRunning:      false,
    bulkResults:      null,      // { ok:[], skip:[], err:[] }
  };

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
  function accessDeniedBlk(subMsg) {
    return `<div class="empty" style="padding:72px 20px">
      <div class="empty-ico">${svg(I.grad)}</div>
      <div class="empty-t">Geen toegang</div>
      <div class="empty-s">${esc(subMsg || 'Deze module is alleen zichtbaar voor rollen manager / admin / super_admin. Wissel via "Bekijk als" of vraag toegang aan.')}</div>
    </div>${renderModals()}`;
  }
  function toast(msg, tone) {
    try { if (window.KV?.toast) window.KV.toast(msg); else console.info('[mentoren-v2] toast:', tone || '', msg); }
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

  /* Confirm-modals — simple + typed */
  window.__mentConfirmOk = () => {
    const c = _ui.confirmModal; _ui.confirmModal = null; render();
    try { if (c && typeof c.onOk === 'function') c.onOk(); } catch (e) { console.warn('[mentoren-v2] confirm onOk fail', e); }
  };
  window.__mentConfirmCancel = () => { _ui.confirmModal = null; render(); };
  function openConfirm(msg, onOk, tone, danger) {
    _ui.confirmModal = { msg, onOk, tone: tone || 'warn', danger: !!danger };
    render();
  }
  function renderConfirmModal() {
    if (!_ui.confirmModal) return '';
    const c = _ui.confirmModal;
    const body = `
      <div style="padding:8px 0 16px;font-size:13.5px;line-height:1.6;color:var(--text)">${esc(c.msg)}</div>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-ghost" onclick="window.__mentConfirmCancel()">Annuleren</button>
        <button class="btn ${c.danger ? 'btn-danger' : 'btn-primary'}" onclick="window.__mentConfirmOk()">Bevestig</button>
      </div>`;
    return modalShell('Bevestig actie', body, 'window.__mentConfirmCancel()', 480);
  }

  window.__mentTypedField = (v) => { if (_ui.typedConfirmModal) _ui.typedConfirmModal.typed = v; };
  window.__mentTypedCheck = () => {
    const m = _ui.typedConfirmModal;
    const btn = document.querySelector('[data-ment-typed-btn]');
    if (m && btn) {
      const ok = String(m.typed || '').trim() === String(m.token || '').trim();
      if (ok) btn.removeAttribute('disabled'); else btn.setAttribute('disabled', 'disabled');
    }
  };
  window.__mentTypedOk = async () => {
    const m = _ui.typedConfirmModal;
    if (!m) return;
    if (String(m.typed || '').trim() !== String(m.token || '').trim()) return;
    if (m.saving) return;
    _ui.typedConfirmModal.saving = true; render();
    try { if (typeof m.onOk === 'function') await m.onOk(); }
    catch (e) { console.warn('[mentoren-v2] typed-confirm onOk fail', e); }
    _ui.typedConfirmModal = null; render();
  };
  window.__mentTypedCancel = () => { _ui.typedConfirmModal = null; render(); };
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
        <input type="text" value="${esc(m.typed || '')}" oninput="window.__mentTypedField(this.value);window.__mentTypedCheck()" placeholder="typ hier: ${esc(m.token)}" style="display:block;width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px;font-family:'IBM Plex Mono',monospace" />
      </label>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-ghost" onclick="window.__mentTypedCancel()">Annuleren</button>
        <button class="btn ${m.danger ? 'btn-danger' : 'btn-primary'}" data-ment-typed-btn disabled onclick="window.__mentTypedOk()">${m.saving ? 'Bezig…' : 'Bevestig'}</button>
      </div>`;
    return modalShell(m.danger ? '⚠ Kritieke actie — dubbele bevestiging' : 'Bevestig actie', body, 'window.__mentTypedCancel()', 520);
  }

  function renderModals() {
    return `${renderConfirmModal()}${renderTypedConfirmModal()}`;
  }

  /* ── Fetchers ────────────────────────────────────────────────────────── */
  async function fetchMentors() {
    if (_live.mentors.loading) return;
    _live.mentors.loading = true; _live.mentors.error = null;
    const j = await tryFetch('mentors', '/api/mentor-admin-list');
    _live.mentors.loading = false;
    if (!j || j.__error) { _live.mentors.error = j?.__error || 'Kon mentors niet laden'; render(); return; }
    _live.mentors.data = j; render();
  }
  async function fetchPayouts(monthKeyStr) {
    const month = monthKeyStr || _ui.selectedMonth || prevMonthKey();
    if (_live.payouts.loading && _live.payouts.month === month) return;
    _live.payouts.loading = true; _live.payouts.error = null; _live.payouts.month = month;
    const j = await tryFetch('payouts', `/api/mentor-payouts-admin-list?period_month=${encodeURIComponent(month)}`);
    _live.payouts.loading = false;
    if (!j || j.__error) { _live.payouts.error = j?.__error || 'Kon payouts niet laden'; render(); return; }
    _live.payouts.data = j; render();
  }
  async function fetchPayoutDetail(payoutId) {
    if (!payoutId) return;
    if (_live.payoutDetail.loading && _live.payoutDetail.id === payoutId) return;
    _live.payoutDetail.loading = true; _live.payoutDetail.error = null; _live.payoutDetail.id = payoutId;
    const j = await tryFetch('payoutDetail', `/api/mentor-payout-detail?payout_id=${encodeURIComponent(payoutId)}`);
    _live.payoutDetail.loading = false;
    if (!j || j.__error) { _live.payoutDetail.error = j?.__error || 'Kon detail niet laden'; render(); return; }
    _live.payoutDetail.data = j; render();
  }
  async function fetchSettings(mentorId) {
    if (!mentorId) return;
    if (_live.settings.loading && _live.settings.mentorId === mentorId) return;
    _live.settings.loading = true; _live.settings.error = null; _live.settings.mentorId = mentorId;
    const j = await tryFetch('settings', `/api/mentor-payout-settings-get?mentor_user_id=${encodeURIComponent(mentorId)}`);
    _live.settings.loading = false;
    if (!j || j.__error) { _live.settings.error = j?.__error || 'Kon settings niet laden'; render(); return; }
    _live.settings.data = j; render();
  }
  async function fetchBonusOverview(mentorId) {
    if (!mentorId) return;
    if (_live.bonusOverview.loading && _live.bonusOverview.mentorId === mentorId) return;
    _live.bonusOverview.loading = true; _live.bonusOverview.error = null; _live.bonusOverview.mentorId = mentorId;
    const j = await tryFetch('bonusOverview', `/api/mentor-bonus-overview?mentor_user_id=${encodeURIComponent(mentorId)}`);
    _live.bonusOverview.loading = false;
    if (!j || j.__error) { _live.bonusOverview.error = j?.__error || 'Kon overzicht niet laden'; render(); return; }
    _live.bonusOverview.data = j; render();
  }
  async function fetchLedger(mentorId) {
    if (!mentorId) return;
    if (_live.ledger.loading && _live.ledger.mentorId === mentorId) return;
    _live.ledger.loading = true; _live.ledger.error = null; _live.ledger.mentorId = mentorId;
    const j = await tryFetch('ledger', `/api/mentor-ledger-overview?mentor_user_id=${encodeURIComponent(mentorId)}`);
    _live.ledger.loading = false;
    if (!j || j.__error) { _live.ledger.error = j?.__error || 'Kon grootboek niet laden'; render(); return; }
    _live.ledger.data = j; render();
  }
  async function fetchMyEvents(mentorId) {
    if (!mentorId) return;
    if (_live.myEvents.loading && _live.myEvents.mentorId === mentorId) return;
    _live.myEvents.loading = true; _live.myEvents.error = null; _live.myEvents.mentorId = mentorId;
    const j = await tryFetch('myEvents', `/api/mentor-my-events?mentor_user_id=${encodeURIComponent(mentorId)}&scope=all`);
    _live.myEvents.loading = false;
    if (!j || j.__error) { _live.myEvents.error = j?.__error || 'Kon events niet laden'; render(); return; }
    _live.myEvents.data = j; render();
  }
  async function fetchMyCalendar(mentorId) {
    if (!mentorId) return;
    if (_live.myCalendar.loading && _live.myCalendar.mentorId === mentorId) return;
    _live.myCalendar.loading = true; _live.myCalendar.error = null; _live.myCalendar.mentorId = mentorId;
    const j = await tryFetch('myCalendar', `/api/mentor-my-calendar?mentor_user_id=${encodeURIComponent(mentorId)}`);
    _live.myCalendar.loading = false;
    if (!j || j.__error) { _live.myCalendar.error = j?.__error || 'Kon kalender niet laden'; render(); return; }
    _live.myCalendar.data = j; render();
  }
  async function fetchFundedCerts(mentorId) {
    const mid = mentorId || null;
    if (_live.fundedCerts.loading && _live.fundedCerts.mentorId === mid) return;
    _live.fundedCerts.loading = true; _live.fundedCerts.error = null; _live.fundedCerts.mentorId = mid;
    const url = mid ? `/api/funded-certs-admin-list?mentor_user_id=${encodeURIComponent(mid)}` : '/api/funded-certs-admin-list';
    const j = await tryFetch('fundedCerts', url);
    _live.fundedCerts.loading = false;
    if (!j || j.__error) { _live.fundedCerts.error = j?.__error || 'Kon certs niet laden'; render(); return; }
    _live.fundedCerts.data = j; render();
  }
  async function fetchAssessments(month, mentorId) {
    const key = `${month || ''}|${mentorId || ''}`;
    if (_live.assessments.loading && `${_live.assessments.month}|${_live.assessments.mentorId}` === key) return;
    _live.assessments.loading = true; _live.assessments.error = null;
    _live.assessments.month = month; _live.assessments.mentorId = mentorId;
    const parts = [];
    if (month)   parts.push(`month=${encodeURIComponent(month)}`);
    if (mentorId) parts.push(`mentor_user_id=${encodeURIComponent(mentorId)}`);
    const q = parts.length ? '?' + parts.join('&') : '';
    const j = await tryFetch('assessments', `/api/assessments-admin-list${q}`);
    _live.assessments.loading = false;
    if (!j || j.__error) { _live.assessments.error = j?.__error || 'Kon beoordelingen niet laden'; render(); return; }
    _live.assessments.data = j; render();
  }
  async function fetchTrajects() {
    if (_live.trajects.loading) return;
    _live.trajects.loading = true; _live.trajects.error = null;
    const status = _live.trajects.statusFilter && _live.trajects.statusFilter !== 'all' ? `?status=${encodeURIComponent(_live.trajects.statusFilter)}` : '';
    const j = await tryFetch('trajects', `/api/mentor-cash-trajects-list${status}`);
    _live.trajects.loading = false;
    if (!j || j.__error) { _live.trajects.error = j?.__error || 'Kon trajecten niet laden'; render(); return; }
    _live.trajects.data = j; render();
  }
  async function fetchEventsList() {
    if (_live.eventsList.loading) return;
    _live.eventsList.loading = true; _live.eventsList.error = null;
    const j = await tryFetch('eventsList', '/api/events-list?status=draft,published,archived');
    _live.eventsList.loading = false;
    if (!j || j.__error) { _live.eventsList.error = j?.__error || 'Kon events niet laden'; render(); return; }
    _live.eventsList.data = j; render();
  }

  /* ── Retries ─────────────────────────────────────────────────────────── */
  window.__mentRetryMentors      = () => { _live.mentors.data      = null; queueMicrotask(fetchMentors); };
  window.__mentRetryPayouts      = () => { _live.payouts.data      = null; _live.payouts.month = null; queueMicrotask(() => fetchPayouts(_ui.selectedMonth)); };
  window.__mentRetryPayoutDetail = () => { if (_ui.expandedPayoutId) { _live.payoutDetail.data = null; _live.payoutDetail.id = null; queueMicrotask(() => fetchPayoutDetail(_ui.expandedPayoutId)); } };
  window.__mentRetrySettings     = () => { if (_ui.selectedMentorId) { _live.settings.data = null; _live.settings.mentorId = null; queueMicrotask(() => fetchSettings(_ui.selectedMentorId)); } };
  window.__mentRetryBonus        = () => { if (_ui.selectedMentorId) { _live.bonusOverview.data = null; _live.bonusOverview.mentorId = null; queueMicrotask(() => fetchBonusOverview(_ui.selectedMentorId)); } };
  window.__mentRetryLedger       = () => { if (_ui.selectedMentorId) { _live.ledger.data = null; _live.ledger.mentorId = null; queueMicrotask(() => fetchLedger(_ui.selectedMentorId)); } };
  window.__mentRetryMyEvents     = () => { if (_ui.selectedMentorId) { _live.myEvents.data = null; _live.myEvents.mentorId = null; queueMicrotask(() => fetchMyEvents(_ui.selectedMentorId)); } };
  window.__mentRetryMyCalendar   = () => { if (_ui.selectedMentorId) { _live.myCalendar.data = null; _live.myCalendar.mentorId = null; queueMicrotask(() => fetchMyCalendar(_ui.selectedMentorId)); } };
  window.__mentRetryCerts        = () => { _live.fundedCerts.data = null; _live.fundedCerts.mentorId = null; queueMicrotask(() => fetchFundedCerts(_ui.selectedMentorId)); };
  window.__mentRetryAssess       = () => { _live.assessments.data = null; queueMicrotask(() => fetchAssessments(_ui.assessMonth, _ui.assessMentorId)); };
  window.__mentRetryTrajects     = () => { _live.trajects.data    = null; queueMicrotask(fetchTrajects); };

  /* ── Handlers — mentor-picker + maand-picker ─────────────────────────── */
  window.__mentPickMentor = (mid) => {
    _ui.selectedMentorId = mid || null;
    // reset drilldown-state
    _live.settings.data = null; _live.settings.mentorId = null;
    _live.bonusOverview.data = null; _live.bonusOverview.mentorId = null;
    _live.ledger.data = null; _live.ledger.mentorId = null;
    _live.myEvents.data = null; _live.myEvents.mentorId = null;
    _live.myCalendar.data = null; _live.myCalendar.mentorId = null;
    if (mid) {
      queueMicrotask(() => fetchSettings(mid));
      queueMicrotask(() => fetchBonusOverview(mid));
      queueMicrotask(() => fetchLedger(mid));
      queueMicrotask(() => fetchMyEvents(mid));
      queueMicrotask(() => fetchMyCalendar(mid));
    }
    render();
  };
  window.__mentSetMonth = (v) => {
    if (!v || !/^\d{4}-\d{2}$/.test(v)) return;
    _ui.selectedMonth = v;
    _live.payouts.data = null; _live.payouts.month = null;
    _ui.expandedPayoutId = null;
    _live.payoutDetail.data = null; _live.payoutDetail.id = null;
    _ui.bulkSelected = new Set();
    _ui.bulkResults = null;
    queueMicrotask(() => fetchPayouts(v));
  };
  window.__mentExpandPayout = (payoutId) => {
    if (_ui.expandedPayoutId === payoutId) {
      _ui.expandedPayoutId = null; render(); return;
    }
    _ui.expandedPayoutId = payoutId;
    _live.payoutDetail.data = null; _live.payoutDetail.id = null;
    queueMicrotask(() => fetchPayoutDetail(payoutId));
  };
  window.__mentSetCertsMentor = (mid) => {
    _ui.selectedMentorId = mid || null;
    _live.fundedCerts.data = null; _live.fundedCerts.mentorId = null;
    queueMicrotask(() => fetchFundedCerts(mid || null));
  };
  window.__mentAssessSetMonth = (v) => {
    if (!v || !/^\d{4}-\d{2}$/.test(v)) return;
    _ui.assessMonth = v;
    _live.assessments.data = null;
    queueMicrotask(() => fetchAssessments(v, _ui.assessMentorId));
  };
  window.__mentAssessSetMentor = (v) => {
    _ui.assessMentorId = v || '';
    _live.assessments.data = null;
    queueMicrotask(() => fetchAssessments(_ui.assessMonth, v || ''));
  };
  // v=4: uncontrolled-input patroon. oninput mag ALLEEN de state bijwerken
  // + surgisch de results-slot + count-span her-renderen — NIET de hele
  // filterbalk of het input-node. Full render() zou het <input>-element
  // vernietigen bij elke toets → focus valt weg, toetsen tijdens remount
  // gaan verloren. Slot-refresh raakt de input niet aan; focus blijft
  // vanzelf. Fallback op full render() alleen als de slots niet gevonden
  // worden (view nog niet gemount / andere tab actief).
  window.__mentSetCertSearch = (v) => {
    _ui.certSearch = String(v || '');
    const slot = document.getElementById('mentCertResultsSlot');
    const cnt  = document.getElementById('mentCertResultsCount');
    if (slot && cnt) {
      slot.innerHTML = _renderCertResults();
      cnt.textContent = _renderCertCountText();
    } else {
      render();
    }
  };
  window.__mentSetAssessSearch = (v) => {
    _ui.assessSearch = String(v || '');
    const slot = document.getElementById('mentAssessResultsSlot');
    const cnt  = document.getElementById('mentAssessResultsCount');
    if (slot && cnt) {
      slot.innerHTML = _renderAssessResults();
      cnt.textContent = _renderAssessCountText();
    } else {
      render();
    }
  };
  window.__mentTrajectSetStatus = (v) => {
    _live.trajects.statusFilter = v || 'all';
    _live.trajects.data = null;
    queueMicrotask(fetchTrajects);
  };
  window.__mentExpandTraject = (id) => {
    _ui.expandedTrajectId = (_ui.expandedTrajectId === id) ? null : id;
    render();
  };

  /* ── Bulk-selectie helpers ───────────────────────────────────────────── */
  window.__mentBulkToggle = (payoutId, checked) => {
    if (checked) _ui.bulkSelected.add(payoutId); else _ui.bulkSelected.delete(payoutId);
    render();
  };
  window.__mentBulkToggleAll = (checked) => {
    const payouts = asArr(_live.payouts.data?.payouts);
    _ui.bulkSelected = new Set(checked ? payouts.map((p) => p.id) : []);
    render();
  };
  window.__mentBulkClear = () => { _ui.bulkSelected = new Set(); _ui.bulkResults = null; render(); };

  async function refetchAfterWrite() {
    _live.payouts.data = null; _live.payouts.month = null;
    queueMicrotask(() => fetchPayouts(_ui.selectedMonth));
    if (_ui.expandedPayoutId) {
      _live.payoutDetail.data = null; _live.payoutDetail.id = null;
      queueMicrotask(() => fetchPayoutDetail(_ui.expandedPayoutId));
    }
  }

  /* ── BROK 2 — Write-acties (getrapte confirms) ───────────────────────── */
  // MEDIUM: generate
  window.__mentGenerate = (mentorId) => {
    if (!isAdminRole()) return;
    openConfirm(`Concept-rapport genereren/hertellen voor ${fmtMonth(_ui.selectedMonth + '-01')}${mentorId ? '' : ' (ALLE mentors)'}? Bestaande concepten worden overschreven; goedgekeurd/uitbetaald blijven ongemoeid.`, async () => {
      const body = mentorId
        ? { mentor_user_id: mentorId, period_month: _ui.selectedMonth }
        : { all: true, period_month: _ui.selectedMonth };
      const resp = await tryPost('generate', '/api/mentor-payout-generate', body);
      if (!resp || resp.__error) { toast('Genereren mislukt: ' + (resp?.__error || 'onbekend'), 'error'); return; }
      toast('Concept gegenereerd', 'success');
      refetchAfterWrite();
    }, 'warn');
  };
  // MEDIUM: approve (verstuurt mail)
  window.__mentApprove = (payoutId) => {
    if (!isAdminRole()) return;
    openConfirm(`Rapport goedkeuren? ⚠ Er wordt automatisch een notificatie-mail naar de mentor gestuurd.`, async () => {
      const resp = await tryPost('approve', '/api/mentor-payout-approve', { payout_id: payoutId });
      if (!resp || resp.__error) { toast('Goedkeuren mislukt: ' + (resp?.__error || 'onbekend'), 'error'); return; }
      toast('Rapport goedgekeurd + mail verstuurd', 'success');
      refetchAfterWrite();
    }, 'warn');
  };
  // HOOG: mark-paid (typed)
  window.__mentMarkPaid = (payoutId, mentorName, amount) => {
    if (!isAdminRole()) return;
    openTypedConfirm(
      `Rapport definitief markeren als UITBETAALD voor ${mentorName}? Ledger-entries worden gekoppeld en krijgen status 'uitbetaald' — administratief is het geld weg. ${amount ? 'Bedrag: ' + eur(amount) + '.' : ''} Terugdraaien vereist super_admin + revert-flow.`,
      'MARKEER BETAALD',
      async () => {
        const resp = await tryPost('mark-paid', '/api/mentor-payout-mark-paid', { payout_id: payoutId });
        if (!resp || resp.__error) { toast('Markeer betaald mislukt: ' + (resp?.__error || 'onbekend'), 'error'); return; }
        toast('Rapport uitbetaald', 'success');
        refetchAfterWrite();
      },
      true,
    );
  };
  // MEDIUM: reopen
  window.__mentReopen = (payoutId) => {
    if (!isAdminRole()) return;
    openConfirm(`Rapport heropenen (goedgekeurd → concept)? De mentor krijgt dit terug te zien; wijzigingen worden opnieuw gegenereerd bij "Concept hertellen".`, async () => {
      const resp = await tryPost('reopen', '/api/mentor-payout-reopen', { payout_id: payoutId });
      if (!resp || resp.__error) { toast('Heropenen mislukt: ' + (resp?.__error || 'onbekend'), 'error'); return; }
      toast('Rapport heropend', 'success');
      refetchAfterWrite();
    }, 'warn');
  };
  // HOOG: revert (typed, super_admin)
  window.__mentRevert = (payoutId, mentorName) => {
    if (!isSuperAdminRole()) { toast('Alleen super_admin mag terugdraaien', 'error'); return; }
    openTypedConfirm(
      `Uitbetaald rapport van ${mentorName} TERUGDRAAIEN? Ledger-entries worden ontboekt (status → vrijgegeven, payout_id → NULL). Alleen doen bij bewezen fout — deze actie is zichtbaar in audit-trail.`,
      'REVERT',
      async () => {
        const resp = await tryPost('revert', '/api/mentor-payout-revert', { payout_id: payoutId });
        if (!resp || resp.__error) { toast('Terugdraaien mislukt: ' + (resp?.__error || 'onbekend'), 'error'); return; }
        toast('Rapport teruggedraaid', 'success');
        refetchAfterWrite();
      },
      true,
    );
  };
  // MEDIUM: coaching-debug (informational, geen mutation)
  window.__mentCoachingDebug = async (mentorId) => {
    if (!isAdminRole()) return;
    const month = _ui.selectedMonth;
    const j = await tryFetch('coaching-debug', `/api/mentor-coaching-debug?mentor_user_id=${encodeURIComponent(mentorId)}&period_month=${encodeURIComponent(month)}`);
    if (!j || j.__error) { toast('Coaching-debug fout: ' + (j?.__error || 'onbekend'), 'error'); return; }
    const summary = `1-op-1 keys: ${asArr(j.one_on_one_keys).length} · Team: ${asArr(j.team_keys).length} · No-show: ${asArr(j.no_show_keys).length} · Funded: ${asArr(j.funded_keys).length}`;
    openConfirm(`Coaching-debug voor ${fmtMonth(month + '-01')}:\n\n${summary}\n\nZie console.log voor volledige dump.`, () => {
      console.log('[mentoren-v2] coaching-debug', j);
    }, 'warn');
  };

  /* Bulk-flow: sequentieel + live-progress in _ui.bulkResults */
  async function bulkExecute(kind) {
    if (!isAdminRole() || _ui.bulkRunning) return;
    const ids = Array.from(_ui.bulkSelected);
    if (!ids.length) return;
    const payouts = asArr(_live.payouts.data?.payouts);
    const byId = new Map(payouts.map((p) => [p.id, p]));

    _ui.bulkResults = { ok: [], skip: [], err: [] };
    _ui.bulkRunning = true; render();

    for (const id of ids) {
      const row = byId.get(id);
      if (!row) { _ui.bulkResults.err.push({ id, msg: 'niet gevonden' }); render(); continue; }
      const label = row.mentor_name || row.mentor_email || id;
      let resp = null;
      if (kind === 'generate') {
        resp = await tryPost('bulk-gen', '/api/mentor-payout-generate', { mentor_user_id: row.mentor_user_id, period_month: _ui.selectedMonth });
      } else if (kind === 'approve') {
        if (row.status !== 'concept' && row.status !== 'open') { _ui.bulkResults.skip.push({ id, label, msg: 'status ≠ concept/open' }); render(); continue; }
        resp = await tryPost('bulk-approve', '/api/mentor-payout-approve', { payout_id: id });
      } else if (kind === 'mark-paid') {
        if (row.status !== 'goedgekeurd') { _ui.bulkResults.skip.push({ id, label, msg: 'status ≠ goedgekeurd' }); render(); continue; }
        resp = await tryPost('bulk-mp', '/api/mentor-payout-mark-paid', { payout_id: id });
      }
      if (!resp || resp.__error) _ui.bulkResults.err.push({ id, label, msg: resp?.__error || 'fout' });
      else _ui.bulkResults.ok.push({ id, label });
      render();
    }
    _ui.bulkRunning = false;
    refetchAfterWrite();
  }
  window.__mentBulkGenerate  = () => {
    openConfirm(`${_ui.bulkSelected.size} concept(en) genereren/hertellen? Bestaande concepten worden overschreven; goedgekeurd/uitbetaald blijven ongemoeid.`, () => bulkExecute('generate'), 'warn');
  };
  window.__mentBulkApprove   = () => {
    openConfirm(`${_ui.bulkSelected.size} rapport(en) goedkeuren? ⚠ Elke mentor krijgt een notificatie-mail. Rapporten met status ≠ concept/open worden overgeslagen.`, () => bulkExecute('approve'), 'warn');
  };
  window.__mentBulkMarkPaid  = () => {
    openTypedConfirm(
      `${_ui.bulkSelected.size} rapport(en) definitief markeren als UITBETAALD? Alle ledger-entries worden geboekt. Rapporten met status ≠ goedgekeurd worden overgeslagen.`,
      'MARKEER BETAALD',
      () => bulkExecute('mark-paid'),
      true,
    );
  };

  /* Adjustment / recurring / config forms — state-only oninput */
  window.__mentAdjOpen = (payoutId, mentorId, periodMonth, existing) => {
    if (!isAdminRole()) return;
    _ui.adjustmentForm = existing
      ? { payoutId, id: existing.id, mentor_user_id: mentorId, period_month: periodMonth, label: existing.label || '', amount_incl: existing.amount_incl != null ? String(existing.amount_incl) : '', saving: false, error: null }
      : { payoutId, id: null, mentor_user_id: mentorId, period_month: periodMonth, label: '', amount_incl: '', saving: false, error: null };
    render();
  };
  window.__mentAdjClose = () => { _ui.adjustmentForm = null; render(); };
  window.__mentAdjField = (k, v) => { if (_ui.adjustmentForm) _ui.adjustmentForm[k] = v; };
  window.__mentAdjSubmit = () => {
    const f = _ui.adjustmentForm; if (!f) return;
    const label = String(f.label || '').trim();
    const amt = Number(f.amount_incl);
    if (!label) { f.error = 'Label vereist'; render(); return; }
    if (!Number.isFinite(amt)) { f.error = 'Bedrag moet een getal zijn (mag negatief)'; render(); return; }
    f.saving = true; f.error = null; render();
    const body = f.id ? { id: f.id, label, amount_incl: amt }
                      : { mentor_user_id: f.mentor_user_id, period_month: f.period_month, label, amount_incl: amt };
    tryPost('adj-save', '/api/mentor-payout-adjustment-save', body).then((resp) => {
      if (!resp || resp.__error) {
        _ui.adjustmentForm.saving = false; _ui.adjustmentForm.error = resp?.__error || 'Opslaan mislukt'; render();
        return;
      }
      toast('Post opgeslagen', 'success');
      _ui.adjustmentForm = null;
      refetchAfterWrite();
    });
  };
  window.__mentAdjDelete = (id, label) => {
    if (!isAdminRole()) return;
    openConfirm(`Handmatige post "${label}" verwijderen? Concept wordt hertellen.`, async () => {
      const resp = await tryPost('adj-delete', '/api/mentor-payout-adjustment-delete', { id });
      if (!resp || resp.__error) { toast('Verwijderen mislukt: ' + (resp?.__error || 'onbekend'), 'error'); return; }
      toast('Post verwijderd', 'success');
      refetchAfterWrite();
    }, 'warn');
  };

  window.__mentRecOpen = (mentorId, existing) => {
    if (!isAdminRole()) return;
    _ui.recurringForm = existing
      ? { id: existing.id, mentor_user_id: mentorId, label: existing.label || '', amount_incl: existing.amount_incl != null ? String(existing.amount_incl) : '', active: !!existing.active, start_month: existing.start_month || '', saving: false, error: null }
      : { id: null, mentor_user_id: mentorId, label: '', amount_incl: '', active: true, start_month: currentMonthKey(), saving: false, error: null };
    render();
  };
  window.__mentRecClose = () => { _ui.recurringForm = null; render(); };
  window.__mentRecField = (k, v) => { if (_ui.recurringForm) _ui.recurringForm[k] = v; };
  window.__mentRecSubmit = () => {
    const f = _ui.recurringForm; if (!f) return;
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
      _ui.recurringForm = null;
      _live.settings.data = null; queueMicrotask(() => fetchSettings(_ui.selectedMentorId));
    });
  };
  window.__mentRecDelete = (id, label) => {
    if (!isAdminRole()) return;
    openTypedConfirm(
      `Vaste maandpost "${label}" DEFINITIEF verwijderen? Nieuwe rapporten bevatten deze post niet meer.`,
      'VERWIJDER',
      async () => {
        const resp = await tryPost('rec-delete', '/api/mentor-recurring-delete', { id });
        if (!resp || resp.__error) { toast('Verwijderen mislukt: ' + (resp?.__error || 'onbekend'), 'error'); return; }
        toast('Maandpost verwijderd', 'success');
        _live.settings.data = null; queueMicrotask(() => fetchSettings(_ui.selectedMentorId));
      },
      false,
    );
  };

  window.__mentCfgOpen = (mentorId, cfg) => {
    if (!isAdminRole()) return;
    _ui.configForm = {
      mentor_user_id: mentorId,
      travel_enabled: !!(cfg?.travel_enabled),
      travel_day_rate_incl: cfg?.travel_day_rate_incl != null ? String(cfg.travel_day_rate_incl) : '0',
      saving: false, error: null,
    };
    render();
  };
  window.__mentCfgClose = () => { _ui.configForm = null; render(); };
  window.__mentCfgField = (k, v) => { if (_ui.configForm) _ui.configForm[k] = v; };
  window.__mentCfgSubmit = () => {
    const f = _ui.configForm; if (!f) return;
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
      _ui.configForm = null;
      _live.settings.data = null; queueMicrotask(() => fetchSettings(_ui.selectedMentorId));
    });
  };

  window.__mentLedgerSetStatus = (entryId, newStatus) => {
    if (!isAdminRole()) return;
    openConfirm(`Ledger-entry status wijzigen naar "${newStatus}"?`, async () => {
      const resp = await tryPost('ledger-set-status', '/api/mentor-ledger-set-status', { entry_id: entryId, new_status: newStatus });
      if (!resp || resp.__error) { toast('Status wijzigen mislukt: ' + (resp?.__error || 'onbekend'), 'error'); return; }
      toast('Status gewijzigd', 'success');
      _live.ledger.data = null; queueMicrotask(() => fetchLedger(_ui.selectedMentorId));
      refetchAfterWrite();
    }, 'warn');
  };

  /* ── BROK 3 — Cash-trajects ──────────────────────────────────────────── */
  window.__mentTrajectOpen = (existing) => {
    if (!isAdminRole()) return;
    _ui.trajectForm = existing
      ? { id: existing.id, event_id: existing.event_id || '', client_label: existing.client_label || '', total_amount: String(existing.total_amount || ''), term_count: String(existing.term_count || '12'), start_month: existing.start_month || currentMonthKey(), release_day: String(existing.release_day || '1'), note: existing.note || '', saving: false, error: null }
      : { id: null, event_id: '', client_label: '', total_amount: '', term_count: '12', start_month: currentMonthKey(), release_day: '1', note: '', saving: false, error: null };
    if (!_live.eventsList.data && !_live.eventsList.loading) queueMicrotask(fetchEventsList);
    render();
  };
  window.__mentTrajectClose = () => { _ui.trajectForm = null; render(); };
  window.__mentTrajectField = (k, v) => { if (_ui.trajectForm) _ui.trajectForm[k] = v; };
  // Live-calc: surgische DOM-write op de calc-strip, geen full render → geen
  // focus-loss tijdens typen. Fix voor bug: live-calc rekent niet met state-only
  // oninput (oninput fired geen render).
  window.__mentTrajectRecalcLive = () => {
    const f = _ui.trajectForm; if (!f) return;
    const el = document.querySelector('[data-ment-traject-livecalc]');
    if (!el) return;
    const total = Number(f.total_amount) || 0;
    const bonus = total * 0.03;
    const termCount = Number(f.term_count) || 0;
    const perTerm = termCount > 0 ? bonus / termCount : 0;
    el.innerHTML = `Live-calc: bonus <b>3%</b> van ${eur(total)} = <b class="mono">${eur(bonus)}</b> · per termijn = <b class="mono">${eur(perTerm)}</b> · verdeeld over aanwezige mentors (event_mentors.was_present=true).`;
  };
  window.__mentTrajectSubmit = () => {
    const f = _ui.trajectForm; if (!f) return;
    if (!f.event_id) { f.error = 'Event kiezen verplicht'; render(); return; }
    const clientLabel = String(f.client_label || '').trim();
    if (!clientLabel) { f.error = 'Klant/omschrijving verplicht'; render(); return; }
    const total = Number(f.total_amount);
    const termCount = parseInt(f.term_count, 10);
    const releaseDay = parseInt(f.release_day, 10);
    if (!Number.isFinite(total) || total <= 0) { f.error = 'Totaalprijs moet > 0 zijn'; render(); return; }
    if (!Number.isInteger(termCount) || termCount < 1 || termCount > 60) { f.error = 'Aantal termijnen moet 1..60 zijn'; render(); return; }
    if (!Number.isInteger(releaseDay) || releaseDay < 1 || releaseDay > 31) { f.error = 'Vrijval-dag moet 1..31 zijn'; render(); return; }
    f.saving = true; f.error = null; render();
    const body = {
      event_id: f.event_id,
      client_label: clientLabel,
      total_amount: total,
      term_count: termCount,
      start_month: f.start_month && f.start_month.length === 7 ? f.start_month + '-01' : f.start_month,
      release_day: releaseDay,
      note: f.note || null,
    };
    if (f.id) body.id = f.id;
    tryPost('traject-save', '/api/mentor-cash-traject-save', body).then((resp) => {
      if (!resp || resp.__error) { f.saving = false; f.error = resp?.__error || 'Opslaan mislukt'; render(); return; }
      toast('Traject opgeslagen', 'success');
      _ui.trajectForm = null;
      _live.trajects.data = null; queueMicrotask(fetchTrajects);
    });
  };
  window.__mentTrajectStatus = (id, action, label) => {
    if (!isAdminRole()) return;
    const label2 = { pause: 'pauzeren', resume: 'hervatten', delete: 'verwijderen' }[action] || action;
    const isDanger = action === 'delete';
    const cb = async () => {
      const resp = await tryPost('traject-status', '/api/mentor-cash-traject-status', { id, action });
      if (!resp || resp.__error) { toast(`${label2} mislukt: ` + (resp?.__error || 'onbekend'), 'error'); return; }
      toast(`Traject ${label2}`, 'success');
      _live.trajects.data = null; queueMicrotask(fetchTrajects);
    };
    if (isDanger) {
      openTypedConfirm(`Traject "${label}" DEFINITIEF verwijderen? Toekomstige vrijvallen stoppen; reeds vrijgegeven termijnen blijven in het grootboek.`, 'VERWIJDER', cb, false);
    } else {
      openConfirm(`Traject "${label}" ${label2}?`, cb, 'warn');
    }
  };
  window.__mentTrajectRelease = (id, label) => {
    if (!isAdminRole()) return;
    openConfirm(`Vrijval-motor nu draaien voor "${label}"? Elke termijn die op basis van startmaand + vrijval-dag verschuldigd is, wordt geboekt op alle aanwezige mentors (event_mentors.was_present=true).`, async () => {
      const resp = await tryPost('traject-release', '/api/mentor-cash-traject-release', { id });
      if (!resp || resp.__error) { toast('Vrijgeven mislukt: ' + (resp?.__error || 'onbekend'), 'error'); return; }
      toast('Vrijval-motor gedraaid', 'success');
      _live.trajects.data = null; queueMicrotask(fetchTrajects);
    }, 'warn');
  };
  window.__mentReleaseAll = () => {
    if (!isAdminRole()) return;
    openConfirm(`Vrijval-motor draaien voor ALLE actieve trajecten? Elke verschuldigde termijn wordt geboekt.`, async () => {
      const resp = await tryPost('release-all', '/api/mentor-cash-traject-release', {});
      if (!resp || resp.__error) { toast('Vrijgeven mislukt: ' + (resp?.__error || 'onbekend'), 'error'); return; }
      toast('Vrijval-motor gedraaid', 'success');
      _live.trajects.data = null; queueMicrotask(fetchTrajects);
    }, 'warn');
  };

  /* ── BROK 4 — Release-sync (super_admin, ONOMKEERBAAR) ───────────────── */
  window.__mentSyncPreview = async () => {
    if (!isSuperAdminRole()) { toast('Alleen super_admin', 'error'); return; }
    _live.syncPreview.loading = true; _live.syncPreview.error = null; render();
    const resp = await tryPost('sync-preview', '/api/admin/bonus-release-sync', { dry_run: true });
    _live.syncPreview.loading = false;
    if (!resp || resp.__error) { _live.syncPreview.error = resp?.__error || 'Preview mislukt'; render(); return; }
    _live.syncPreview.data = resp; render();
  };
  window.__mentSyncCommit = () => {
    if (!isSuperAdminRole()) { toast('Alleen super_admin', 'error'); return; }
    if (!_live.syncPreview.data) { toast('Draai eerst een preview', 'warn'); return; }
    openTypedConfirm(
      `Release-sync DEFINITIEF uitvoeren? Onomkeerbaar / forward-only — er worden vrijgegeven-children op pending obligaties gespawnd. Deze actie kan alleen doorgaan als je eerst een succesvolle preview hebt gedraaid.`,
      'SYNC BEVESTIGEN',
      async () => {
        const resp = await tryPost('sync-commit', '/api/admin/bonus-release-sync', { dry_run: false });
        if (!resp || resp.__error) { toast('Sync mislukt: ' + (resp?.__error || 'onbekend'), 'error'); return; }
        toast('Release-sync uitgevoerd', 'success');
        _live.syncPreview.data = null;
        refetchAfterWrite();
      },
      true,
    );
  };

  /* ── Render-helpers ──────────────────────────────────────────────────── */
  const dashCard = (title, dotColor, body, extra) => `<div class="card">
    <div class="card-head" style="border-bottom:none;padding-bottom:6px">
      <span class="title-dot" style="background:var(--${dotColor});box-shadow:0 0 0 3px var(--${dotColor}-soft)"></span>
      <div class="card-title">${title}</div>${extra || ''}</div>
    <div class="card-body" style="padding:8px 17px 17px">${body}</div></div>`;

  // Projection helpers — hergebruikt uit verdiensten v6: exact N labels
  // matcht data-length (was bug: 43 labels bij 12 punten).
  const MONTH_NAMES_NL_SHORT = ['jan','feb','mrt','apr','mei','jun','jul','aug','sep','okt','nov','dec'];
  function shortMonthLabel(monthIso) {
    if (typeof monthIso !== 'string' || monthIso.length < 7) return '';
    const mm = parseInt(monthIso.slice(5, 7), 10);
    if (!Number.isFinite(mm) || mm < 1 || mm > 12) return '';
    return MONTH_NAMES_NL_SHORT[mm - 1];
  }
  function buildProjection12(projArr) {
    const src = asArr(projArr).slice(0, 12);
    const data   = src.map((r) => Number(r.amount) || 0);
    const labels = src.map((r) => shortMonthLabel(r.month) || (typeof r.month === 'string' ? r.month.slice(5) : ''));
    return { data, labels };
  }
  function areaChart(data, labels) {
    const n = data.length;
    if (!n) return `<div style="padding:12px;color:var(--text-3);font-size:12.5px">Geen data.</div>`;
    const w = 100, h = 42, mx = Math.max(...data, 1);
    const pts = data.map((v, i) => [n > 1 ? i / (n - 1) * w : 0, h - (v / mx) * h * .88 - 2]);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const shown = labels.slice(0, n);
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:64px;display:block">
      <defs><linearGradient id="ment-proj-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--m)" stop-opacity=".22"/><stop offset="100%" stop-color="var(--m)" stop-opacity="0"/>
      </linearGradient></defs>
      <path fill="url(#ment-proj-grad)" d="${line} L${w},${h} L0,${h} Z"/>
      <path fill="none" stroke="var(--m)" stroke-width="1.5" vector-effect="non-scaling-stroke" d="${line}"/>
    </svg><div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-3);margin-top:4px">${shown.map(l => `<span>${esc(l)}</span>`).join('')}</div>`;
  }

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
  const LEDGER_STATUS_PILL = {
    pending:              { c: 'neutral', l: 'Pending' },
    wachten_op_betaling:  { c: 'warn',    l: 'Wacht op betaling' },
    vrijgegeven:          { c: 'info',    l: 'Vrijgegeven' },
    uitbetaald:           { c: 'ok',      l: 'Uitbetaald' },
    geannuleerd:          { c: 'neutral', l: 'Geannuleerd' },
  };
  function ledgerPill(status) {
    const meta = LEDGER_STATUS_PILL[String(status || '').toLowerCase()] || { c: 'neutral', l: status || '—' };
    return H.pill(meta.c, meta.l);
  }
  const TRAJECT_STATUS_PILL = {
    active:    { c: 'ok',      l: 'Actief' },
    paused:    { c: 'warn',    l: 'Gepauzeerd' },
    completed: { c: 'neutral', l: 'Voltooid' },
  };
  function trajectPill(status) {
    const meta = TRAJECT_STATUS_PILL[String(status || '').toLowerCase()] || { c: 'neutral', l: status || '—' };
    return H.pill(meta.c, meta.l);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     VIEW 1 — Overzicht (mentor-picker + drilldown)
     ═══════════════════════════════════════════════════════════════════════ */
  function overzichtView() {
    if (!isAdminRole()) return accessDeniedBlk();
    if (!_live.mentors.loading && !_live.mentors.data && !_live.mentors.error) queueMicrotask(fetchMentors);
    if (_live.mentors.error && !_live.mentors.data) return errBlk(_live.mentors.error, 'window.__mentRetryMentors()') + renderModals();
    if (!_live.mentors.data) return skel() + renderModals();

    const mentors = asArr(_live.mentors.data.mentors);
    return `${H.toolbar([
      `<label style="display:flex;align-items:center;gap:8px;font-size:12.5px"><span style="color:var(--text-3)">Mentor:</span>
        <select onchange="window.__mentPickMentor(this.value)" style="padding:6px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px;min-width:280px">
          <option value="">— kies mentor —</option>
          ${mentors.map((m) => `<option value="${esc(m.user_id || m.id)}" ${_ui.selectedMentorId === (m.user_id || m.id) ? 'selected' : ''}>${esc(m.name || m.email || m.user_id)}</option>`).join('')}
        </select>
      </label>`,
      `<span style="font-size:11.5px;color:var(--text-3)">${mentors.length} mentors</span>`,
    ])}
    ${_ui.selectedMentorId ? renderMentorDrilldown() : `<div style="padding:40px 20px;text-align:center;color:var(--text-3);font-size:13px">Kies een mentor om KPI's, grootboek, projectie en payout-instellingen te zien.</div>`}
    ${renderAdjustmentFormModal()}
    ${renderRecurringFormModal()}
    ${renderConfigFormModal()}
    ${renderModals()}`;
  }

  function renderMentorDrilldown() {
    const mid = _ui.selectedMentorId;
    if (!mid) return '';
    const bo = _live.bonusOverview;
    const led = _live.ledger;
    const stg = _live.settings;
    const ev = _live.myEvents;
    const cal = _live.myCalendar;
    const mentors = asArr(_live.mentors.data?.mentors);
    const m = mentors.find((mm) => (mm.user_id || mm.id) === mid);
    const mentorName = m?.name || m?.email || mid;

    // KPI-spec v1: Saldo netto / Bonuspot bruto / Deze maand / Open.
    // Saldo netto + Bonuspot bruto komen uit ledger.totals; Deze maand + Open
    // komen uit bonus-overview.totals. Beide bronnen combined tot 1 KPI-strip.
    const ledgerTotals = led.data?.totals || {};
    const bonusTotals  = bo.data?.totals || {};

    return `<div class="pad" style="padding-top:16px">
      <div style="margin-bottom:14px;font-size:15px;font-weight:600">${esc(mentorName)}</div>

      ${(bo.loading && !bo.data) || (led.loading && !led.data) ? skel()
       : (bo.error && !bo.data) ? errBlk(bo.error, 'window.__mentRetryBonus()')
       : (bo.data || led.data) ? `${H.kpis([
          { c: 'emerald', icon: I.euro,  label: 'Saldo netto',      val: eur(Number(ledgerTotals.netto) || 0),          sub: 'vrijgegeven − uitgaven' },
          { c: 'violet',  icon: I.chart, label: 'Bonuspot bruto',   val: eur(Number(ledgerTotals.bonuspot) || 0),       sub: 'alle bonus-entries' },
          { c: 'blue',    icon: I.clock, label: 'Deze maand',       val: eur(Number(bonusTotals.deze_maand) || 0),      sub: 'bonus-vrijgave' },
          { c: 'amber',   icon: I.cal,   label: 'Open',             val: eur(Number(bonusTotals.open) || 0),            sub: 'niet-uitbetaald' },
        ])}` : ''}

      ${led.loading && !led.data ? '' : led.error && !led.data ? errBlk(led.error, 'window.__mentRetryLedger()') : led.data ? `<div style="margin-top:14px">${renderLedgerCard(led.data)}</div>` : ''}

      ${bo.data ? `<div style="margin-top:14px">${renderProjectionCard(bo.data)}</div>` : ''}

      ${bo.data && asArr(bo.data.per_event).length ? `<div style="margin-top:14px">${renderTermijnProjectieCard(bo.data)}</div>` : ''}

      ${cal.loading && !cal.data ? '' : cal.error && !cal.data ? errBlk(cal.error, 'window.__mentRetryMyCalendar()') : cal.data ? `<div style="margin-top:14px">${renderKomendeSessiesCard(cal.data)}</div>` : ''}

      ${ev.loading && !ev.data ? '' : ev.error && !ev.data ? errBlk(ev.error, 'window.__mentRetryMyEvents()') : ev.data ? `<div style="margin-top:14px">${renderEventsCard(ev.data)}</div>` : ''}

      ${stg.loading && !stg.data ? '' : stg.error && !stg.data ? errBlk(stg.error, 'window.__mentRetrySettings()') : stg.data ? `<div style="margin-top:14px">${renderPayoutSettingsCard(stg.data, mid)}</div>` : ''}
    </div>`;
  }

  // 12-maands projectie-chart (hergebruikt uit verdiensten v6, exact N labels)
  function renderProjectionCard(d) {
    const proj = buildProjection12(d.projection_12m);
    if (!proj.data.length) return '';
    return dashCard(`Projectie · ${proj.data.length} maand${proj.data.length === 1 ? '' : 'en'}`, 'blue', areaChart(proj.data, proj.labels));
  }

  // Komende sessies (mentor-my-calendar — alleen toekomstige events).
  function renderKomendeSessiesCard(d) {
    const events = asArr(d.events);
    if (!events.length) return dashCard('Komende sessies', 'teal', `<div style="padding:12px;color:var(--text-3);font-size:12.5px">Geen komende sessies gepland.</div>`);
    return dashCard('Komende sessies', 'teal',
      H.table(
        [{ l: 'Event' }, { l: 'Start' }, { l: 'Aanwezig' }],
        events.slice(0, 20).map((e) => [
          `<span class="cell-main">${esc(e.title || e.event_title || '—')}</span>`,
          `<span style="color:var(--text-3)">${fmtDateTime(e.starts_at)}</span>`,
          H.pill(e.was_present ? 'ok' : 'neutral', e.was_present ? 'Ja' : (e.was_present === false ? 'Nee' : '—')),
        ]),
      ),
    );
  }

  // FIX 2026-08-16: leest nu d.byEvent (was: d.per_event — bestaat niet)
  // en e.bonuspot / e.omzet / e.uitgaven / e.netto (was: e.bonus_bruto —
  // bestaat niet). Verklaart waarom blok leeg was terwijl KPI wél bonus toonde.
  function renderLedgerCard(d) {
    const byEvent = asArr(d.byEvent);
    if (!byEvent.length) return dashCard('Bonussen per event', 'blue', `<div style="padding:12px;color:var(--text-3);font-size:12.5px">Geen ledger-entries.</div>`);
    return dashCard('Bonussen per event', 'blue',
      H.table(
        [{ l: 'Event' }, { l: 'Datum', cls: 'optional' }, { l: 'Omzet', cls: 'r optional' }, { l: 'Bonuspot bruto', cls: 'r' }, { l: 'Uitgaven', cls: 'r optional' }, { l: 'Netto', cls: 'r' }],
        byEvent.map((e) => [
          `<span class="cell-main">${esc(e.event_title || '—')}</span>`,
          `<span style="color:var(--text-3)">${fmtDate(e.starts_at)}</span>`,
          `<span class="money">${eur(Number(e.omzet) || 0)}</span>`,
          `<span class="money">${eur(Number(e.bonuspot) || 0)}</span>`,
          `<span class="money" style="${e.uitgaven ? 'color:var(--rose)' : 'color:var(--text-3)'}">${e.uitgaven ? '− ' + eur(Number(e.uitgaven) || 0) : '—'}</span>`,
          `<span class="money"><b>${eur(Number(e.netto) || 0)}</b></span>`,
        ]),
      ),
    );
  }

  function renderTermijnProjectieCard(d) {
    const perEvent = asArr(d.per_event);
    return dashCard('Termijn-projectie per event', 'violet', perEvent.map((ev) => {
      const sales = asArr(ev.sales);
      return `<div style="padding:10px 0;border-bottom:1px solid var(--border)">
        <div style="font-size:13px;font-weight:600;margin-bottom:6px">${esc(ev.event_title || '—')} <span style="color:var(--text-3);font-weight:400;font-size:11.5px">· ${fmtDate(ev.starts_at)}</span></div>
        ${sales.map((s) => {
          const parts = asArr(s.termijnen);
          return `<div style="padding:6px 0 6px 12px;border-left:2px solid var(--border);margin-bottom:6px">
            <div style="font-size:12.5px"><b>${esc(s.customer_label || s.customer_id || '—')}</b> · sale ${eur(Number(s.sale_total_incl) || 0)} → aandeel ${eur(Number(s.mentor_share_total) || 0)} · ${s.term_count} termijn(en)${s.schema_unknown ? ' <span style="color:var(--amber)">(schema onbekend)</span>' : ''}</div>
            ${parts.length ? `<table style="width:100%;border-collapse:collapse;font-size:11.5px;margin-top:4px">
              <thead><tr style="color:var(--text-3);text-transform:uppercase;letter-spacing:.06em"><th style="text-align:left;padding:3px 0">#</th><th style="text-align:left">Vervaldatum</th><th style="text-align:right">Bedrag</th><th style="text-align:left">Status</th></tr></thead>
              <tbody>${parts.map((p) => `<tr><td style="padding:3px 0">${p.index}</td><td>${fmtDate(p.due_date)}</td><td style="text-align:right" class="money">${eur(Number(p.amount) || 0)}</td><td>${esc(p.status || '—')}</td></tr>`).join('')}</tbody>
            </table>` : ''}
          </div>`;
        }).join('')}
      </div>`;
    }).join(''));
  }

  function renderEventsCard(d) {
    const events = asArr(d.events);
    if (!events.length) return dashCard('Events', 'pink', `<div style="padding:12px;color:var(--text-3);font-size:12.5px">Geen events gekoppeld.</div>`);
    return dashCard('Events', 'pink',
      H.table(
        [{ l: 'Event' }, { l: 'Start', cls: 'optional' }, { l: 'Aanwezig' }],
        events.map((e) => [
          `<span class="cell-main">${esc(e.title || e.event_title || '—')}</span>`,
          `<span style="color:var(--text-3)">${fmtDateTime(e.starts_at)}</span>`,
          H.pill(e.was_present ? 'ok' : 'neutral', e.was_present ? 'Ja' : (e.was_present === false ? 'Nee' : '—')),
        ]),
      ),
    );
  }

  function renderPayoutSettingsCard(s, mid) {
    const cfg = s.config || {};
    const recurring = asArr(s.recurring);
    return `${dashCard('Payout-config', 'blue', `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:10px">
        <div><div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Reiskosten</div><div style="font-size:14px;font-weight:600">${cfg.travel_enabled ? 'Ingeschakeld' : 'Uit'}</div></div>
        <div><div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Dagtarief (incl.)</div><div class="mono" style="font-size:14px;font-weight:600">${eur(Number(cfg.travel_day_rate_incl) || 0)}</div></div>
      </div>
      <div style="display:flex;justify-content:flex-end"><button class="btn btn-ghost btn-sm" onclick='window.__mentCfgOpen("${esc(mid)}",${JSON.stringify(cfg).replace(/"/g, "&quot;")})'>Bewerken</button></div>
    `)}
    <div style="margin-top:12px">${dashCard('Vaste maandposten', 'violet', `
      ${recurring.length ? H.table(
        [{ l: 'Label' }, { l: 'Bedrag (incl.)', cls: 'r' }, { l: 'Vanaf', cls: 'optional' }, { l: 'Actief' }, { l: '', cls: 'r' }],
        recurring.map((r) => [
          `<span class="cell-main">${esc(r.label)}</span>`,
          `<span class="money">${eur(Number(r.amount_incl) || 0)}</span>`,
          `<span style="color:var(--text-3)">${r.start_month ? fmtMonth(r.start_month) : 'vanaf altijd'}</span>`,
          H.pill(r.active ? 'ok' : 'neutral', r.active ? 'Actief' : 'Inactief'),
          `<div style="display:flex;gap:6px;justify-content:flex-end">
            <button class="btn btn-ghost btn-sm" onclick='window.__mentRecOpen("${esc(mid)}",${JSON.stringify(r).replace(/"/g, "&quot;")})'>Bewerken</button>
            <button class="btn btn-danger btn-sm" onclick="window.__mentRecDelete('${esc(r.id)}','${esc(r.label).replace(/'/g, "\\'")}')">Verwijderen</button>
          </div>`,
        ]),
      ) : `<div style="padding:12px;color:var(--text-3);font-size:12.5px">Geen vaste maandposten.</div>`}
      <div style="margin-top:10px"><button class="btn btn-ghost btn-sm" onclick="window.__mentRecOpen('${esc(mid)}',null)">${svg(I.plus)}Maandpost toevoegen</button></div>
    `)}</div>`;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     VIEW 2 — Rapporten (payout-lijst met bulk + drilldown)
     ═══════════════════════════════════════════════════════════════════════ */
  function rapportenView() {
    if (!isAdminRole()) return accessDeniedBlk();
    if (!_live.payouts.loading && !_live.payouts.data && !_live.payouts.error) queueMicrotask(() => fetchPayouts(_ui.selectedMonth));
    if (_live.payouts.error && !_live.payouts.data) return errBlk(_live.payouts.error, 'window.__mentRetryPayouts()') + renderModals();

    const payouts = asArr(_live.payouts.data?.payouts);
    const totalIncl = payouts.reduce((a, p) => a + (Number(p.total) || 0), 0);
    const bonusTot  = payouts.reduce((a, p) => a + (Number(p.bonus_total) || 0), 0);
    const coachTot  = payouts.reduce((a, p) => a + (Number(p.coaching_total) || 0), 0);
    const nWait     = payouts.filter((p) => p.status === 'concept' || p.status === 'open').length;

    return `${H.kpis([
      { c: 'blue',    icon: I.euro,  label: 'Rapporten',           val: String(payouts.length), sub: fmtMonth(_ui.selectedMonth + '-01') },
      { c: 'violet',  icon: I.grad,  label: 'Bonus totaal',        val: eur(bonusTot),  sub: 'incl. btw' },
      { c: 'emerald', icon: I.users, label: 'Coaching totaal',     val: eur(coachTot),  sub: 'incl. btw' },
      { c: 'amber',   icon: I.clock, label: 'Wacht op akkoord',    val: String(nWait),  sub: 'concept / open' },
    ])}
    ${H.toolbar([
      `<label style="display:flex;align-items:center;gap:8px;font-size:12.5px"><span style="color:var(--text-3)">Periode:</span>
        <input type="month" value="${esc(_ui.selectedMonth)}" onchange="window.__mentSetMonth(this.value)"
               style="padding:5px 8px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px" /></label>`,
      `<button class="btn btn-primary btn-sm" onclick="window.__mentGenerate(null)">${svg(I.plus)}Genereer alle concepten</button>`,
      `<span style="font-size:11.5px;color:var(--text-3);margin-left:auto">Totaal incl. btw: <b>${eur(totalIncl)}</b></span>`,
    ])}
    ${renderBulkBar()}
    ${_live.payouts.loading && !_live.payouts.data ? skel()
     : payouts.length ? renderPayoutsTable(payouts)
     : `<div style="padding:40px 20px;text-align:center;color:var(--text-3);font-size:13px">Geen rapporten voor ${fmtMonth(_ui.selectedMonth + '-01')}. Klik "Genereer alle concepten" om te starten.</div>`}
    ${renderAdjustmentFormModal()}
    ${renderModals()}`;
  }

  function renderBulkBar() {
    const count = _ui.bulkSelected.size;
    const running = _ui.bulkRunning;
    const res = _ui.bulkResults;
    if (!count && !res) return '';
    return `<div style="padding:12px 22px;background:var(--m-soft);border-top:1px solid var(--m);border-bottom:1px solid var(--m);display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        <span style="font-size:13px;font-weight:600">${count} geselecteerd${running ? ' · bezig…' : ''}</span>
        <button class="btn btn-ghost btn-sm" ${running ? 'disabled' : ''} onclick="window.__mentBulkGenerate()">${svg(I.repeat)}Genereer geselecteerde</button>
        <button class="btn btn-primary btn-sm" ${running ? 'disabled' : ''} onclick="window.__mentBulkApprove()">${svg(I.tick)}Keur goed + mail</button>
        <button class="btn btn-primary btn-sm" ${running ? 'disabled' : ''} onclick="window.__mentBulkMarkPaid()">${svg(I.euro)}Markeer uitbetaald…</button>
      </div>
      <button class="btn btn-ghost btn-sm" ${running ? 'disabled' : ''} onclick="window.__mentBulkClear()">Deselecteer</button>
      ${res ? `<div style="width:100%;font-size:12px;color:var(--text-2);padding-top:8px;border-top:1px solid var(--border)">
        <b>Resultaat</b> · ✓ ${res.ok.length} ok · ⏭ ${res.skip.length} skip · ⚠ ${res.err.length} fout
        ${res.err.length ? `<ul style="margin:4px 0 0 20px;color:var(--rose);font-size:11.5px">${res.err.slice(0, 5).map((e) => `<li>${esc(e.label || e.id)}: ${esc(e.msg)}</li>`).join('')}</ul>` : ''}
      </div>` : ''}
    </div>`;
  }

  function renderPayoutsTable(payouts) {
    const allChecked = payouts.length > 0 && payouts.every((p) => _ui.bulkSelected.has(p.id));
    return `<div class="card"><div class="card-body" style="padding:0">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr style="border-bottom:1px solid var(--border);color:var(--text-3);font-size:11.5px;text-transform:uppercase;letter-spacing:.06em">
          <th style="padding:10px 14px;width:30px"><input type="checkbox" ${allChecked ? 'checked' : ''} onchange="window.__mentBulkToggleAll(this.checked)"></th>
          <th style="text-align:left;padding:10px 14px">Mentor</th>
          <th style="text-align:right;padding:10px 14px">Bonus</th>
          <th style="text-align:right;padding:10px 14px">Coaching</th>
          <th style="text-align:right;padding:10px 14px">Excl.</th>
          <th style="text-align:right;padding:10px 14px">BTW</th>
          <th style="text-align:right;padding:10px 14px">Incl.</th>
          <th style="text-align:left;padding:10px 14px">Status</th>
          <th style="text-align:right;padding:10px 14px"></th>
        </tr></thead>
        <tbody>
          ${payouts.map((p) => {
            const isOpen = _ui.expandedPayoutId === p.id;
            const isSel = _ui.bulkSelected.has(p.id);
            return `<tr style="border-bottom:1px solid var(--border)">
              <td style="padding:10px 14px;text-align:center" onclick="event.stopPropagation()">
                <input type="checkbox" ${isSel ? 'checked' : ''} onchange="window.__mentBulkToggle('${esc(p.id)}', this.checked)">
              </td>
              <td style="padding:10px 14px;cursor:pointer" onclick="window.__mentExpandPayout('${esc(p.id)}')">
                <div class="cell-main">${esc(p.mentor_name || p.mentor_email || '—')}</div>
                <div style="font-size:11.5px;color:var(--text-3)">${esc(p.mentor_email || '')}</div>
              </td>
              <td style="padding:10px 14px;text-align:right" class="money">${eur(Number(p.bonus_total) || 0)}</td>
              <td style="padding:10px 14px;text-align:right" class="money">${eur(Number(p.coaching_total) || 0)}</td>
              <td style="padding:10px 14px;text-align:right" class="money">${eur(Number(p.total_excl) || 0)}</td>
              <td style="padding:10px 14px;text-align:right" class="money">${eur(Number(p.btw_amount) || 0)}</td>
              <td style="padding:10px 14px;text-align:right" class="money"><b>${eur(Number(p.total) || 0)}</b></td>
              <td style="padding:10px 14px">${payoutPill(p.status)}</td>
              <td style="padding:10px 14px;text-align:right;font-size:12px;color:var(--text-3);cursor:pointer" onclick="window.__mentExpandPayout('${esc(p.id)}')">${isOpen ? '▲' : '▼'}</td>
            </tr>
            ${isOpen ? `<tr><td colspan="9" style="padding:0;background:var(--surface-2)"><div style="padding:16px 22px" onclick="event.stopPropagation()">${renderPayoutDetail(p)}</div></td></tr>` : ''}`;
          }).join('')}
        </tbody>
      </table>
    </div></div>`;
  }

  function renderPayoutDetail(payoutRow) {
    if (_live.payoutDetail.loading && (!_live.payoutDetail.data || _live.payoutDetail.id !== payoutRow.id)) return skel();
    if (_live.payoutDetail.error && _live.payoutDetail.id === payoutRow.id) return errBlk(_live.payoutDetail.error, 'window.__mentRetryPayoutDetail()');
    if (!_live.payoutDetail.data || _live.payoutDetail.id !== payoutRow.id) return skel();

    const d = _live.payoutDetail.data.payout || _live.payoutDetail.data;
    const lines = asArr(d.lines);
    const adjustments = asArr(d.adjustments);

    const canApprove   = d.status === 'concept' || d.status === 'open';
    const canMarkPaid  = d.status === 'goedgekeurd';
    const canReopen    = d.status === 'goedgekeurd';
    const canRevert    = d.status === 'uitbetaald' && isSuperAdminRole();
    const canRegen     = d.status === 'concept' || d.status === 'open';
    const canEditAdj   = d.status === 'concept' || d.status === 'open';

    return `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
      ${canRegen ? `<button class="btn btn-ghost btn-sm" onclick="window.__mentGenerate('${esc(d.mentor_user_id)}')">${svg(I.repeat)}Concept hertellen</button>` : ''}
      ${canApprove ? `<button class="btn btn-primary btn-sm" onclick="window.__mentApprove('${esc(d.id)}')">${svg(I.tick)}Goedkeuren + mail</button>` : ''}
      ${canMarkPaid ? `<button class="btn btn-primary btn-sm" onclick="window.__mentMarkPaid('${esc(d.id)}','${esc(d.mentor_name || 'mentor').replace(/'/g, "\\'")}',${Number(d.total) || 0})">${svg(I.euro)}Markeer betaald…</button>` : ''}
      ${canReopen ? `<button class="btn btn-ghost btn-sm" onclick="window.__mentReopen('${esc(d.id)}')">↩ Heropen</button>` : ''}
      ${canRevert ? `<button class="btn btn-danger btn-sm" onclick="window.__mentRevert('${esc(d.id)}','${esc(d.mentor_name || 'mentor').replace(/'/g, "\\'")}')">⏪ Terugdraaien…</button>` : ''}
      <button class="btn btn-ghost btn-sm" onclick="window.__mentCoachingDebug('${esc(d.mentor_user_id)}')" title="Coaching-debug"><span style="font-size:11px">🔍 Debug</span></button>
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
            <button class="btn btn-ghost btn-sm" onclick='window.__mentAdjOpen("${esc(d.id)}","${esc(d.mentor_user_id)}","${esc(d.period_month)}",${JSON.stringify({ id: a.id, label: a.label, amount_incl: a.amount_incl }).replace(/"/g, "&quot;")})'>Bewerken</button>
            <button class="btn btn-danger btn-sm" onclick="window.__mentAdjDelete('${esc(a.id)}','${esc(a.label || '').replace(/'/g, "\\'")}')">Verwijderen</button>
          </div>` : '',
        ]),
      ) : `<div style="padding:12px;color:var(--text-3);font-size:12.5px">Geen handmatige posten.</div>`}
      ${canEditAdj ? `<div style="margin-top:10px"><button class="btn btn-ghost btn-sm" onclick='window.__mentAdjOpen("${esc(d.id)}","${esc(d.mentor_user_id)}","${esc(d.period_month)}",null)'>${svg(I.plus)}Post toevoegen</button></div>`
                   : `<div style="margin-top:10px;font-size:11.5px;color:var(--text-3);font-style:italic">Handmatige posten kunnen niet meer worden aangepast (rapport is ${d.status}).</div>`}
    `)}</div>`;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     VIEW 3 — Certificaten (funded-certs admin)
     ─────────────────────────────────────────────────────────────────────
     v=4: search-input is nu een uncontrolled input. oninput muteert alleen
     _ui.certSearch en her-rendert twee slot-nodes (#mentCertResultsSlot +
     #mentCertResultsCount) via querySelector + innerHTML — geen full
     render(). Het <input>-element wordt daardoor niet vernietigd, focus
     blijft, geen verloren toetsen bij snel typen.
     ═══════════════════════════════════════════════════════════════════════ */
  function _certFiltered() {
    const allCerts = asArr(_live.fundedCerts.data?.certs);
    const q = String(_ui.certSearch || '').toLowerCase().trim();
    const certs = q ? allCerts.filter((c) => {
      const s = `${c.student_name || ''} ${c.mentor_name || ''} ${c.mentor_email || ''} ${c.file_name || ''}`.toLowerCase();
      return s.indexOf(q) !== -1;
    }) : allCerts;
    return { certs, allCerts, q };
  }
  function _renderCertCountText() {
    const { certs, allCerts, q } = _certFiltered();
    return `${certs.length}${q ? ' van ' + allCerts.length : ''} certifica${certs.length === 1 ? 'at' : 'ten'} · download-URLs 1u geldig`;
  }
  function _renderCertResults() {
    if (_live.fundedCerts.error && !_live.fundedCerts.data) return errBlk(_live.fundedCerts.error, 'window.__mentRetryCerts()');
    if (_live.fundedCerts.loading && !_live.fundedCerts.data) return skel();
    const { certs } = _certFiltered();
    if (!certs.length) return `<div style="padding:40px 20px;text-align:center;color:var(--text-3);font-size:13px">Geen certificaten gevonden.</div>`;
    return H.table(
      [{ l: 'Mentor' }, { l: 'Student' }, { l: 'Bestand', cls: 'optional' }, { l: 'Maand', cls: 'optional' }, { l: 'Ge-upload', cls: 'optional' }, { l: 'Bonus', cls: 'r' }, { l: '' }],
      certs.map((c) => [
        `<span>${esc(c.mentor_name || c.mentor_email || '—')}</span>`,
        `<span class="cell-main">${esc(c.student_name || '—')}</span>`,
        `<span style="color:var(--text-3);font-family:'IBM Plex Mono',monospace;font-size:11.5px">${esc(c.file_name || '—')}</span>`,
        `<span>${fmtMonth(c.funded_month)}</span>`,
        `<span style="color:var(--text-3)">${fmtDate(c.last_uploaded_at)}</span>`,
        `<span class="money">${eur(100)}</span>`,
        c.download_url ? `<a href="${esc(c.download_url)}" target="_blank" rel="noopener" class="btn btn-ghost btn-sm">${svg(I.down)}Download</a>` : `<span style="color:var(--text-3);font-size:11.5px">n.v.t.</span>`,
      ]),
    );
  }
  function certificatenView() {
    if (!isAdminRole()) return accessDeniedBlk();
    if (!_live.mentors.loading && !_live.mentors.data && !_live.mentors.error) queueMicrotask(fetchMentors);
    if (!_live.fundedCerts.loading && !_live.fundedCerts.data && !_live.fundedCerts.error) queueMicrotask(() => fetchFundedCerts(_ui.selectedMentorId));

    const mentors = asArr(_live.mentors.data?.mentors);

    return `${H.toolbar([
      `<label style="display:flex;align-items:center;gap:8px;font-size:12.5px"><span style="color:var(--text-3)">Mentor:</span>
        <select onchange="window.__mentSetCertsMentor(this.value)" style="padding:6px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px;min-width:220px">
          <option value="">— alle mentors —</option>
          ${mentors.map((m) => `<option value="${esc(m.user_id || m.id)}" ${_ui.selectedMentorId === (m.user_id || m.id) ? 'selected' : ''}>${esc(m.name || m.email || m.user_id)}</option>`).join('')}
        </select>
      </label>`,
      `<input id="mentCertSearchInp" type="search" placeholder="Zoek naam / mentor / bestand…" value="${esc(_ui.certSearch)}" oninput="window.__mentSetCertSearch(this.value)" style="padding:6px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px;min-width:220px" />`,
      `<span id="mentCertResultsCount" style="font-size:11.5px;color:var(--text-3)">${_renderCertCountText()}</span>`,
    ])}
    <div id="mentCertResultsSlot">${_renderCertResults()}</div>
    ${renderModals()}`;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     VIEW 4 — Beoordelingen (student-assessments)
     ═══════════════════════════════════════════════════════════════════════ */
  const ASSESS_STATUS_PILL = {
    op_schema:   { c: 'ok',      l: 'Op schema' },
    aandacht:    { c: 'warn',    l: 'Aandacht' },
    risico:      { c: 'danger',  l: 'Risico' },
    niet_actief: { c: 'neutral', l: 'Niet actief' },
  };
  function assessPill(status) {
    const meta = ASSESS_STATUS_PILL[String(status || '').toLowerCase()] || { c: 'neutral', l: status || '—' };
    return H.pill(meta.c, meta.l);
  }

  // v=4: identiek uncontrolled-input patroon als certificatenView.
  function _assessFiltered() {
    const allItems = asArr(_live.assessments.data?.assessments);
    const q = String(_ui.assessSearch || '').toLowerCase().trim();
    const items = q ? allItems.filter((a) => String(a.student_name || '').toLowerCase().indexOf(q) !== -1) : allItems;
    return { items, allItems, q };
  }
  function _renderAssessCountText() {
    const { items, allItems, q } = _assessFiltered();
    return `${items.length}${q ? ' van ' + allItems.length : ''} beoordelingen · read-only`;
  }
  function _renderAssessResults() {
    if (_live.assessments.error && !_live.assessments.data) return errBlk(_live.assessments.error, 'window.__mentRetryAssess()');
    if (_live.assessments.loading && !_live.assessments.data) return skel();
    const { items } = _assessFiltered();
    if (!items.length) return `<div style="padding:40px 20px;text-align:center;color:var(--text-3);font-size:13px">Geen beoordelingen gevonden. Wijzigingen doet de mentor via z'n eigen dashboard.</div>`;
    return H.table(
      [{ l: 'Mentor' }, { l: 'Student' }, { l: 'Maand', cls: 'optional' }, { l: 'Status' }, { l: 'Cijfer', cls: 'r' }, { l: 'Actief & taken', cls: 'optional' }, { l: 'Notitie', cls: 'optional' }, { l: 'Bijgewerkt', cls: 'r optional' }],
      items.map((a) => [
        `<span>${esc(a.mentor_name || a.mentor_email || '—')}</span>`,
        `<span class="cell-main">${esc(a.student_name || '—')}</span>`,
        `<span style="color:var(--text-3)">${a.month ? fmtMonth(a.month) : '—'}</span>`,
        assessPill(a.status),
        `<span class="mono" style="font-weight:600">${a.cijfer != null ? a.cijfer : '—'}</span>`,
        `<span style="color:var(--text-2);font-size:12.5px">${a.actief_taken == null ? '—' : (a.actief_taken ? 'Ja' : 'Nee')}</span>`,
        `<span style="color:var(--text-3);font-size:12.5px">${esc(a.notitie || '—')}</span>`,
        `<span class="mono" style="color:var(--text-3);font-size:11.5px">${fmtDate(a.updated_at)}</span>`,
      ]),
    );
  }
  function beoordelingenView() {
    if (!isAdminRole()) return accessDeniedBlk();
    if (!_live.mentors.loading && !_live.mentors.data && !_live.mentors.error) queueMicrotask(fetchMentors);
    if (!_live.assessments.loading && !_live.assessments.data && !_live.assessments.error) queueMicrotask(() => fetchAssessments(_ui.assessMonth, _ui.assessMentorId));

    const mentors = asArr(_live.mentors.data?.mentors);

    return `${H.toolbar([
      `<label style="display:flex;align-items:center;gap:8px;font-size:12.5px"><span style="color:var(--text-3)">Maand:</span>
        <input type="month" value="${esc(_ui.assessMonth)}" onchange="window.__mentAssessSetMonth(this.value)"
               style="padding:5px 8px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px" />
      </label>`,
      `<label style="display:flex;align-items:center;gap:8px;font-size:12.5px"><span style="color:var(--text-3)">Mentor:</span>
        <select onchange="window.__mentAssessSetMentor(this.value)" style="padding:6px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px;min-width:200px">
          <option value="">— alle mentors —</option>
          ${mentors.map((m) => `<option value="${esc(m.user_id || m.id)}" ${_ui.assessMentorId === (m.user_id || m.id) ? 'selected' : ''}>${esc(m.name || m.email || m.user_id)}</option>`).join('')}
        </select>
      </label>`,
      `<input id="mentAssessSearchInp" type="search" placeholder="Zoek naam student…" value="${esc(_ui.assessSearch)}" oninput="window.__mentSetAssessSearch(this.value)" style="padding:6px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px;min-width:200px" />`,
      `<span id="mentAssessResultsCount" style="font-size:11.5px;color:var(--text-3)">${_renderAssessCountText()}</span>`,
    ])}
    <div id="mentAssessResultsSlot">${_renderAssessResults()}</div>
    ${renderModals()}`;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     VIEW 5 — Trajecten (cash-trajects)
     ═══════════════════════════════════════════════════════════════════════ */
  function trajectenView() {
    if (!isAdminRole()) return accessDeniedBlk();
    if (!_live.trajects.loading && !_live.trajects.data && !_live.trajects.error) queueMicrotask(fetchTrajects);
    if (_live.trajects.error && !_live.trajects.data) return errBlk(_live.trajects.error, 'window.__mentRetryTrajects()') + renderModals();

    const trajects = asArr(_live.trajects.data?.trajects);
    const nActief   = trajects.filter((t) => t.status === 'active').length;
    const nPaused   = trajects.filter((t) => t.status === 'paused').length;
    // "Vrijgevallen deze maand" — som van entries met released_at in huidige maand — endpoint niet apart, benader via released_amount van completed dit jaar
    const releasedTot = trajects.reduce((a, t) => a + (Number(t.released_amount) || 0), 0);

    return `${H.kpis([
      { c: 'ok',      icon: I.tick,  label: 'Actief',              val: String(nActief), sub: 'lopende trajecten' },
      { c: 'warn',    icon: I.clock, label: 'Gepauzeerd',          val: String(nPaused), sub: 'geen vrijval' },
      { c: 'emerald', icon: I.euro,  label: 'Totaal vrijgegeven',  val: eur(releasedTot), sub: 'som van alle entries' },
    ])}
    ${H.toolbar([
      `<div style="display:flex;gap:6px">
        ${['all','active','paused','completed'].map((v) => `<button class="btn ${_live.trajects.statusFilter === v ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="window.__mentTrajectSetStatus('${v}')">${v === 'all' ? 'Alle' : v === 'active' ? 'Actief' : v === 'paused' ? 'Gepauzeerd' : 'Voltooid'}</button>`).join('')}
      </div>`,
      `<div class="tb-right" style="display:flex;gap:6px">
        <button class="btn btn-ghost btn-sm" onclick="window.__mentReleaseAll()">${svg(I.repeat)}Vrijval nu draaien (alle)</button>
        <button class="btn btn-primary btn-sm" onclick="window.__mentTrajectOpen(null)">${svg(I.plus)}Nieuw handmatig traject</button>
      </div>`,
    ])}
    <div class="pad" style="padding-top:12px">
      ${trajects.length ? trajects.map(renderTrajectCard).join('') : `<div style="padding:40px 20px;text-align:center;color:var(--text-3);font-size:13px">Geen trajecten in deze selectie.</div>`}
    </div>
    ${renderTrajectFormModal()}
    ${renderModals()}`;
  }

  // Bereken termijn N release-date uit start_month + release_day + (N-1) maanden.
  // Payload heeft geen parts[]-array — we genereren 'em zelf uit metadata.
  function computeTermijnen(t) {
    const total = Number(t.term_count) || 0;
    if (!total) return [];
    const bonus = Number(t.bonus_total) || 0;
    const perTerm = bonus / total;
    const releasedIndicesRaw = t.released_terms;
    // released_terms kan zijn: getal (count) OR array van indices OR set-achtig
    let releasedSet = new Set();
    if (Array.isArray(releasedIndicesRaw)) releasedSet = new Set(releasedIndicesRaw.map(Number));
    else if (typeof releasedIndicesRaw === 'number') {
      // count-mode: eerste N termijnen zijn vrijgegeven
      for (let i = 1; i <= releasedIndicesRaw; i++) releasedSet.add(i);
    }
    // Parse start_month "YYYY-MM(-DD)?"
    const startIso = typeof t.start_month === 'string' ? t.start_month : '';
    const startY = parseInt(startIso.slice(0, 4), 10);
    const startM = parseInt(startIso.slice(5, 7), 10);
    const releaseDay = Math.min(28, Math.max(1, parseInt(t.release_day, 10) || 1)); // cap 28 = veilig voor feb
    const parts = [];
    for (let i = 1; i <= total; i++) {
      let due = null;
      if (Number.isFinite(startY) && Number.isFinite(startM)) {
        const d = new Date(startY, startM - 1 + (i - 1), releaseDay);
        due = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }
      parts.push({ index: i, amount: perTerm, due_date: due, released: releasedSet.has(i) });
    }
    return parts;
  }

  function renderTrajectCard(t) {
    const isOpen = _ui.expandedTrajectId === t.id;
    const parts = computeTermijnen(t);
    const released = parts.filter((p) => p.released).length;
    const total = Number(t.term_count) || 0;
    const pct = total ? Math.round(released / total * 100) : 0;
    const canRelease = t.status === 'active';
    const canPause = t.status === 'active';
    const canResume = t.status === 'paused';
    const canEdit = t.status !== 'completed';
    const label = t.client_label || '—';

    return `<div class="card" style="margin-bottom:12px">
      <div style="padding:12px 16px;border-bottom:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
          <div style="min-width:0;flex:1">
            <div style="font-size:14px;font-weight:600">${esc(label)}</div>
            <div style="font-size:11.5px;color:var(--text-3);margin-top:2px">
              ${esc(t.event_title || t.event_id || '—')} · ${fmtDate(t.event_starts_at)}
              ${asArr(t.mentor_names).length ? ` · ${asArr(t.mentor_names).length} aanwezige mentor(s)` : ''}
              · totaal ${eur(Number(t.total_amount) || 0)} · ${t.term_count} termijnen
              · bonus ${eur(Number(t.bonus_total) || 0)}
              · start ${fmtMonth(t.start_month)} · vrijval-dag ${t.release_day || '—'}
            </div>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            ${trajectPill(t.status)}
            <button class="btn btn-ghost btn-sm" onclick="window.__mentExpandTraject('${esc(t.id)}')">${isOpen ? '▲' : '▼'}</button>
          </div>
        </div>
        <div style="margin-top:10px">
          <div style="display:flex;justify-content:space-between;font-size:11.5px;color:var(--text-3);margin-bottom:4px"><span>Vrijgevallen ${released} van ${total}</span><span class="mono">${eur(Number(t.released_amount) || 0)} van ${eur(Number(t.bonus_total) || 0)}</span></div>
          <div class="progress"><i style="width:${pct}%;background:var(--m)"></i></div>
        </div>
      </div>
      ${isOpen ? `<div style="padding:14px 16px">
        ${parts.length ? `<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:12px">
          <thead><tr style="color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;font-size:11px"><th style="text-align:left;padding:5px 0">Termijn</th><th style="text-align:right">Bedrag</th><th style="text-align:left">Release-datum</th><th style="text-align:left">Status</th></tr></thead>
          <tbody>${parts.map((p) => `<tr><td style="padding:4px 0">${p.index}</td><td style="text-align:right" class="money">${eur(Number(p.amount) || 0)}</td><td>${fmtDate(p.due_date)}</td><td>${p.released ? '<span style="color:var(--ok)">✓ vrijgegeven</span>' : '<span style="color:var(--text-3)">— nog niet</span>'}</td></tr>`).join('')}</tbody>
        </table>` : `<div style="padding:12px;color:var(--text-3);font-size:12.5px">Geen termijnen (term_count = 0).</div>`}
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${canRelease ? `<button class="btn btn-primary btn-sm" onclick="window.__mentTrajectRelease('${esc(t.id)}','${esc(label).replace(/'/g, "\\'")}')">${svg(I.repeat)}Nu vrijgeven</button>` : ''}
          ${canPause ? `<button class="btn btn-ghost btn-sm" onclick="window.__mentTrajectStatus('${esc(t.id)}','pause','${esc(label).replace(/'/g, "\\'")}')">⏸ Pauzeren</button>` : ''}
          ${canResume ? `<button class="btn btn-ghost btn-sm" onclick="window.__mentTrajectStatus('${esc(t.id)}','resume','${esc(label).replace(/'/g, "\\'")}')">▶ Hervatten</button>` : ''}
          ${canEdit ? `<button class="btn btn-ghost btn-sm" onclick='window.__mentTrajectOpen(${JSON.stringify(t).replace(/"/g, "&quot;")})'>${svg(I.edit || I.plus)}Bewerken</button>` : ''}
          <button class="btn btn-danger btn-sm" onclick="window.__mentTrajectStatus('${esc(t.id)}','delete','${esc(label).replace(/'/g, "\\'")}')">Verwijderen</button>
        </div>
      </div>` : ''}
    </div>`;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     VIEW 6 — Sync (release-sync, super_admin)
     ═══════════════════════════════════════════════════════════════════════ */
  function syncView() {
    if (!isSuperAdminRole()) return accessDeniedBlk('Release-sync is alleen zichtbaar voor super_admin. Deze actie is onomkeerbaar.');

    const sp = _live.syncPreview;
    const p = sp.data || null;
    const perMentor = p ? asArr(p.per_mentor) : [];
    const perCustomer = p ? asArr(p.per_customer) : [];

    return `<div class="pad" style="padding-top:16px">
      <div style="padding:14px 16px;background:var(--rose-soft);border:1px solid var(--rose);color:var(--rose);border-radius:var(--r);font-size:13px;margin-bottom:14px">
        <b>⚠ Kritieke actie · super_admin only</b><br>
        Release-sync spawnt vrijgegeven-children op alle pending / gedeeltelijk-vrijgegeven bonus-obligaties (over alle klanten heen). <b>Forward-only en onomkeerbaar</b> — draai ALTIJD eerst een preview.
      </div>
      <div style="display:flex;gap:8px;margin-bottom:14px">
        <button class="btn btn-ghost" ${sp.loading ? 'disabled' : ''} onclick="window.__mentSyncPreview()">${svg(I.eye || I.chart)}${sp.loading ? 'Preview laden…' : '🔍 Release-sync (preview / dry-run)'}</button>
        <button class="btn btn-danger" ${!p ? 'disabled' : ''} onclick="window.__mentSyncCommit()">🔒 Definitief vrijgeven…</button>
      </div>
      ${sp.error ? errBlk(sp.error, 'window.__mentSyncPreview()') : ''}
      ${p ? `<div>${dashCard('Preview-resultaat', 'blue', `
        <div style="font-size:12.5px;color:var(--text-2);margin-bottom:10px">
          Totaal: <b>${p.total_slices_created || 0}</b> nieuwe slices · <b>${eur(Number(p.total_release_amount) || 0)}</b> vrij te geven · ${perMentor.length} mentor(s) · ${perCustomer.length} klant(en) geraakt.
        </div>
        ${perMentor.length ? `<div style="margin-bottom:12px"><div style="font-size:12px;font-weight:600;color:var(--text-2);margin-bottom:6px">Per mentor</div>
          ${H.table(
            [{ l: 'Mentor' }, { l: 'Slices', cls: 'r' }, { l: 'Totaal vrij', cls: 'r' }],
            perMentor.map((r) => [esc(r.mentor_name || r.mentor_user_id || '—'), `<span class="mono">${r.slices_count || 0}</span>`, `<span class="money">${eur(Number(r.release_amount) || 0)}</span>`]),
          )}
        </div>` : ''}
        ${perCustomer.length ? `<div><div style="font-size:12px;font-weight:600;color:var(--text-2);margin-bottom:6px">Per klant (max 50)</div>
          ${H.table(
            [{ l: 'Klant' }, { l: 'Betaald', cls: 'r optional' }, { l: 'Parents', cls: 'r optional' }, { l: '# slices', cls: 'r' }, { l: 'Vrijgave', cls: 'r' }],
            perCustomer.slice(0, 50).map((r) => {
              // LOW 9 fix: endpoint levert alleen customer_id (geen label).
              // Toon compacte UUID-prefix + tooltip met volledige id zodat
              // rijen niet meer 36-char raw-UUID's tonen. Naam-resolve zou een
              // extra fetch vereisen (customers batch-lookup) — buiten scope
              // voor deze cosmetische fix.
              const label = r.customer_label || r.customer_name || (r.customer_id ? `kl-${String(r.customer_id).slice(0, 8)}` : '—');
              const title = r.customer_id ? String(r.customer_id) : '';
              return [
                `<span title="${esc(title)}" style="font-family:'IBM Plex Mono',monospace;font-size:11.5px">${esc(label)}</span>`,
                `<span class="money">${eur(Number(r.paid_amount) || Number(r.paid_total) || 0)}</span>`,
                `<span class="mono">${r.parents_count || 0}</span>`,
                `<span class="mono">${r.slices_count || 0}</span>`,
                `<span class="money">${eur(Number(r.release_amount) || 0)}</span>`,
              ];
            }),
          )}
        </div>` : ''}
      `)}</div>` : `<div style="padding:20px;color:var(--text-3);font-size:12.5px">Draai eerst een preview om te zien wat er vrijgegeven zou worden. Geen wijzigingen tot je "Definitief vrijgeven" klikt.</div>`}
    </div>
    ${renderModals()}`;
  }

  /* ── Form modals ─────────────────────────────────────────────────────── */
  function renderAdjustmentFormModal() {
    if (!_ui.adjustmentForm) return '';
    const f = _ui.adjustmentForm;
    const body = `
      <div style="padding:8px 0 14px;font-size:12.5px;color:var(--text-2)">
        Handmatige post voor ${fmtMonth(f.period_month)}. Bedrag mag negatief (inhouding).
      </div>
      <label style="display:block;margin-bottom:12px">
        <span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Label</span>
        <input type="text" value="${esc(f.label)}" oninput="window.__mentAdjField('label', this.value)"
          style="display:block;width:100%;margin-top:4px;padding:8px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px" />
      </label>
      <label style="display:block;margin-bottom:14px">
        <span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Bedrag (incl.) — negatief = inhouding</span>
        <input type="number" step="0.01" value="${esc(f.amount_incl)}" oninput="window.__mentAdjField('amount_incl', this.value)"
          style="display:block;width:180px;margin-top:4px;padding:8px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px" />
      </label>
      ${f.error ? `<div style="padding:8px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px;margin-bottom:12px">${esc(f.error)}</div>` : ''}
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-ghost" onclick="window.__mentAdjClose()">Annuleren</button>
        <button class="btn btn-primary" ${f.saving ? 'disabled' : ''} onclick="window.__mentAdjSubmit()">${f.saving ? 'Opslaan…' : 'Opslaan'}</button>
      </div>`;
    return modalShell(f.id ? 'Post bewerken' : 'Post toevoegen', body, 'window.__mentAdjClose()', 520);
  }

  function renderRecurringFormModal() {
    if (!_ui.recurringForm) return '';
    const f = _ui.recurringForm;
    const body = `
      <label style="display:block;margin-bottom:12px">
        <span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Label</span>
        <input type="text" value="${esc(f.label)}" oninput="window.__mentRecField('label', this.value)"
          style="display:block;width:100%;margin-top:4px;padding:8px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px" />
      </label>
      <label style="display:block;margin-bottom:12px">
        <span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Bedrag (incl.)</span>
        <input type="number" step="0.01" min="0" value="${esc(f.amount_incl)}" oninput="window.__mentRecField('amount_incl', this.value)"
          style="display:block;width:180px;margin-top:4px;padding:8px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px" />
      </label>
      <label style="display:block;margin-bottom:12px">
        <span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Vanaf maand (optioneel)</span>
        <input type="month" value="${esc((f.start_month || '').slice(0,7))}" oninput="window.__mentRecField('start_month', this.value)"
          style="display:block;width:180px;margin-top:4px;padding:8px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px" />
      </label>
      <label style="display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:13px">
        <input type="checkbox" ${f.active ? 'checked' : ''} onchange="window.__mentRecField('active', this.checked)"> Actief
      </label>
      ${f.error ? `<div style="padding:8px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px;margin-bottom:12px">${esc(f.error)}</div>` : ''}
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-ghost" onclick="window.__mentRecClose()">Annuleren</button>
        <button class="btn btn-primary" ${f.saving ? 'disabled' : ''} onclick="window.__mentRecSubmit()">${f.saving ? 'Opslaan…' : 'Opslaan'}</button>
      </div>`;
    return modalShell(f.id ? 'Maandpost bewerken' : 'Maandpost toevoegen', body, 'window.__mentRecClose()', 520);
  }

  function renderConfigFormModal() {
    if (!_ui.configForm) return '';
    const f = _ui.configForm;
    const body = `
      <label style="display:flex;align-items:center;gap:8px;margin-bottom:14px;font-size:13px">
        <input type="checkbox" ${f.travel_enabled ? 'checked' : ''} onchange="window.__mentCfgField('travel_enabled', this.checked)"> Reiskosten meerekenen
      </label>
      <label style="display:block;margin-bottom:14px">
        <span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Dagtarief (incl.)</span>
        <input type="number" step="0.01" min="0" value="${esc(f.travel_day_rate_incl)}" oninput="window.__mentCfgField('travel_day_rate_incl', this.value)"
          style="display:block;width:180px;margin-top:4px;padding:8px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px" />
      </label>
      <div style="padding:10px 12px;background:var(--surface-2);border-radius:6px;font-size:11.5px;color:var(--text-3);margin-bottom:12px">
        ℹ Wijzigingen gelden vanaf de eerstvolgende "Genereer concept"-run. Bestaande concepten worden niet automatisch hertellen.
      </div>
      ${f.error ? `<div style="padding:8px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px;margin-bottom:12px">${esc(f.error)}</div>` : ''}
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-ghost" onclick="window.__mentCfgClose()">Annuleren</button>
        <button class="btn btn-primary" ${f.saving ? 'disabled' : ''} onclick="window.__mentCfgSubmit()">${f.saving ? 'Opslaan…' : 'Opslaan'}</button>
      </div>`;
    return modalShell('Payout-config bewerken', body, 'window.__mentCfgClose()', 520);
  }

  function renderTrajectFormModal() {
    if (!_ui.trajectForm) return '';
    const f = _ui.trajectForm;
    // events-list returnt { items, total, ... } — was bug: las 'events' (undefined) → dropdown leeg.
    const events = asArr(_live.eventsList.data?.items || _live.eventsList.data?.events);
    const total = Number(f.total_amount) || 0;
    const bonus = total * 0.03;
    const perTerm = f.term_count ? bonus / Number(f.term_count) : 0;
    const body = `
      <label style="display:block;margin-bottom:12px">
        <span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Event</span>
        ${_live.eventsList.loading && !_live.eventsList.data ? '<div style="padding:8px;color:var(--text-3);font-size:12.5px">Events laden…</div>' : ''}
        ${_live.eventsList.error && !_live.eventsList.data ? errBlk(_live.eventsList.error) : ''}
        <select onchange="window.__mentTrajectField('event_id', this.value)" style="display:block;width:100%;margin-top:4px;padding:8px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px">
          <option value="">— kies event —</option>
          ${events.map((ev) => `<option value="${esc(ev.id)}" ${f.event_id === ev.id ? 'selected' : ''}>${esc(ev.title || ev.id)} · ${fmtDate(ev.starts_at)}</option>`).join('')}
        </select>
      </label>
      <label style="display:block;margin-bottom:12px">
        <span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Klant / traject-omschrijving</span>
        <input type="text" value="${esc(f.client_label)}" oninput="window.__mentTrajectField('client_label', this.value)"
          style="display:block;width:100%;margin-top:4px;padding:8px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px" />
      </label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
        <label>
          <span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Totaalprijs (€)</span>
          <input type="number" step="0.01" min="0" value="${esc(f.total_amount)}" oninput="window.__mentTrajectField('total_amount', this.value);window.__mentTrajectRecalcLive()"
            style="display:block;width:100%;margin-top:4px;padding:8px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px" />
        </label>
        <label>
          <span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Aantal termijnen</span>
          <input type="number" min="1" max="60" step="1" value="${esc(f.term_count)}" oninput="window.__mentTrajectField('term_count', this.value);window.__mentTrajectRecalcLive()"
            style="display:block;width:100%;margin-top:4px;padding:8px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px" />
        </label>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
        <label>
          <span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Startmaand</span>
          <input type="month" value="${esc((f.start_month || '').slice(0,7))}" oninput="window.__mentTrajectField('start_month', this.value)"
            style="display:block;width:100%;margin-top:4px;padding:8px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px" />
        </label>
        <label>
          <span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Vrijval-dag (1..31)</span>
          <input type="number" min="1" max="31" step="1" value="${esc(f.release_day)}" oninput="window.__mentTrajectField('release_day', this.value)"
            style="display:block;width:100%;margin-top:4px;padding:8px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px" />
        </label>
      </div>
      <label style="display:block;margin-bottom:12px">
        <span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Notitie (optioneel)</span>
        <textarea oninput="window.__mentTrajectField('note', this.value)" style="display:block;width:100%;margin-top:4px;padding:8px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:12.5px;font-family:inherit;min-height:50px;resize:vertical">${esc(f.note)}</textarea>
      </label>
      <div data-ment-traject-livecalc style="padding:10px 12px;background:var(--surface-2);border-radius:6px;font-size:12px;color:var(--text-2);margin-bottom:12px">
        Live-calc: bonus <b>3%</b> van ${eur(total)} = <b class="mono">${eur(bonus)}</b> · per termijn = <b class="mono">${eur(perTerm)}</b> · verdeeld over aanwezige mentors (event_mentors.was_present=true).
      </div>
      ${f.error ? `<div style="padding:8px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px;margin-bottom:12px">${esc(f.error)}</div>` : ''}
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-ghost" onclick="window.__mentTrajectClose()">Annuleren</button>
        <button class="btn btn-primary" ${f.saving ? 'disabled' : ''} onclick="window.__mentTrajectSubmit()">${f.saving ? 'Opslaan…' : 'Opslaan'}</button>
      </div>`;
    return modalShell(f.id ? 'Handmatig traject bewerken' : 'Nieuw handmatig traject', body, 'window.__mentTrajectClose()', 680);
  }

  /* ── Registratie (6 views, admin-only via app-shell MODS.roles=SAM) ─── */
  window.DFO.VIEWS['mentoren/Overzicht']     = overzichtView;
  window.DFO.VIEWS['mentoren/Rapporten']     = rapportenView;
  window.DFO.VIEWS['mentoren/Certificaten']  = certificatenView;
  window.DFO.VIEWS['mentoren/Beoordelingen'] = beoordelingenView;
  window.DFO.VIEWS['mentoren/Trajecten']     = trajectenView;
  window.DFO.VIEWS['mentoren/Sync']          = syncView;

  if (typeof window.KV_V2_ADD === 'function') {
    window.KV_V2_ADD('mentoren');
  } else {
    (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('mentoren');
  }

  console.debug('[mentoren-v2] v4 — 6 admin-views registered (Overzicht/Rapporten/Certificaten/Beoordelingen/Trajecten/Sync). Search-inputs (Certificaten + Beoordelingen) nu uncontrolled — geen focus-loss. Dormant tot allowlist of ?v2preview=mentoren.');
})();
