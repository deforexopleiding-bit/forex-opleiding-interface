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
    travelMonths:{ loading: false, error: null, data: null }, // dropdown: recente maanden + editability
    certs:       { loading: false, error: null, data: null },
    coaching:    { loading: false, error: null, data: null, from: null, to: null, key: null },
    myEvents:    { loading: false, error: null, data: null, scope: 'all' },
    myStudents:  { loading: false, error: null, data: null },
    // v=11 (2026-08-25) — combined "verdiensten" tegels + doughnut op Overzicht.
    // Drie sub-buckets: all_time (2020-01-01→vandaag), this_month (1e→vandaag),
    // ytd (1-jan→vandaag). Elk cachet zijn eigen coaching-grand_total apart
    // van de Coaching-tab (die kan een vrije aangepast-range hebben) zodat de
    // trage all-time Bubble-call niet elke Overzicht-open opnieuw hoeft. TTL
    // 10 min stale-while-revalidate; hard-refresh triggert nieuwe fetch.
    overviewCoaching: {
      all_time:   { loading: false, error: null, data: null, fetched_at: 0 },
      this_month: { loading: false, error: null, data: null, fetched_at: 0 },
      ytd:        { loading: false, error: null, data: null, fetched_at: 0 },
    },
  };
  const OVERVIEW_COACHING_TTL_MS = 10 * 60 * 1000; // 10 min
  const _ui = {
    py: '26',                       // periode-chip jaar (26/25)
    travelForm:      null,           // { days, saving, error }
    certUpload:      null,           // { studentId, studentName, file, fileName, saving, error, step }
    confirmModal:    null,           // { msg, onOk, tone }
    // Coaching-tab periode-selectie. `preset` ∈ day|week|month|year|custom.
    // customFrom/customTo zijn strings YYYY-MM-DD (state-only tijdens typen —
    // pas na 'Toepassen' triggeren ze een refetch → focus behouden).
    coachPeriod: { preset: 'month', customFrom: '', customTo: '' },
    // v=12 — Bonus-per-klant drill-down state (port v1 mentor-dashboard).
    // Tab: 'actief'|'overdue'|'pauze'|'wacht_start'|'geannuleerd'|'alle';
    // page 1-based, pageSize 25 (matcht v1). Set<rowKey> voor uitgeklapte
    // rijen — stabiele key = sequence-index binnen fetch (perEvent-order).
    bonus: { tab: 'actief', page: 1, pageSize: 25, open: new Set() },
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
  async function fetchTravelMonths() {
    if (_live.travelMonths.loading || _live.travelMonths.data) return;
    _live.travelMonths.loading = true; _live.travelMonths.error = null;
    const j = await tryFetch('travelMonths', '/api/mentor-travel-days-months');
    _live.travelMonths.loading = false;
    if (!j || j.__error) { _live.travelMonths.error = j?.__error || 'Kon maanden niet laden'; render(); return; }
    _live.travelMonths.data = j; render();
  }
  async function fetchCerts() {
    if (_live.certs.loading) return;
    _live.certs.loading = true; _live.certs.error = null;
    const j = await tryFetch('certs', '/api/mentor-funded-certs-self');
    _live.certs.loading = false;
    if (!j || j.__error) { _live.certs.error = j?.__error || 'Kon certificaten niet laden'; render(); return; }
    _live.certs.data = j; render();
  }
  async function fetchCoaching(fromArg, toArg) {
    // fromArg/toArg optioneel — als weggelaten gebruikt de server default
    // (huidige maand). Bij bekende periode geven we ze mee als YYYY-MM-DD.
    const from = fromArg || null;
    const to   = toArg   || null;
    const key = (from && to) ? (from + '..' + to) : 'default';
    if (_live.coaching.loading && _live.coaching.key === key) return;
    // Bij expliciete refetch (zelfde key kan opnieuw wanneer data=null):
    _live.coaching.loading = true; _live.coaching.error = null; _live.coaching.key = key;
    render();
    const url = (from && to)
      ? `/api/mentor-coaching-earnings?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
      : '/api/mentor-coaching-earnings';
    // v=9 (2026-08-25): 45s timeout ipv de default 8s. mentor-coaching-earnings
    // doet live Bubble-fetch (bubbleList '1-1-session' + 'team-training' + funded)
    // met FETCH_CAP=3000 per typename. All-time (2020→nu, 5+ jaar) duurt
    // structureel >8s → v2 timeout-en → UI viel op €0. v1 mentor-home
    // (AgentShared.apiFetch) heeft geen timeout → wachtte gewoon. Vandaar
    // v1 €34.010 vs v2 €0 bij zelfde endpoint/token. 45s past binnen Vercel
    // 30s server-cap + 15s netwerk-marge.
    const j = await tryFetch('coaching', url, 45000);
    _live.coaching.loading = false;
    if (!j || j.__error) { _live.coaching.error = j?.__error || 'Kon coaching-verdiensten niet laden'; render(); return; }
    _live.coaching.data = j; _live.coaching.from = j.from || from; _live.coaching.to = j.to || to;
    render();
  }
  // Bereken from/to op basis van de gekozen preset. Werkt in lokale tijd
  // (Europe/Amsterdam-consistent — de mentor kijkt naar zijn eigen dagen).
  function _coachRangeFor(preset, customFrom, customTo) {
    const pad = (n) => String(n).padStart(2, '0');
    const fmt = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    const now = new Date();
    if (preset === 'day') {
      const s = fmt(now); return { from: s, to: s };
    }
    if (preset === 'week') {
      // ISO-week: maandag t/m zondag rond `now`.
      const d = new Date(now);
      const day = d.getDay(); // 0=zon, 1=maa...
      const diffToMon = (day + 6) % 7; // aantal dagen terug naar maandag
      const mon = new Date(d); mon.setDate(d.getDate() - diffToMon);
      const zon = new Date(mon); zon.setDate(mon.getDate() + 6);
      return { from: fmt(mon), to: fmt(zon) };
    }
    if (preset === 'year') {
      const y = now.getFullYear();
      return { from: y + '-01-01', to: y + '-12-31' };
    }
    if (preset === 'custom') {
      if (!customFrom || !customTo) return null; // wacht op user-input
      if (customFrom > customTo) return null;
      return { from: customFrom, to: customTo };
    }
    // month (default)
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const last  = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return { from: fmt(first), to: fmt(last) };
  }
  // v=11 (2026-08-25) — coaching-fetch voor de gecombineerde Overzicht-tegels.
  // Kind ∈ 'all_time' | 'this_month' | 'ytd'. Cacht per bucket met TTL 10 min
  // stale-while-revalidate: als er data < TTL is → geen refetch. Deelt met
  // Coaching-tab wanneer die exact dezelfde from/to aanhoudt (zeldzaam, want
  // Coaching-tab default = huidige maand). Timeout 45s zoals de Coaching-tab
  // (all-time Bubble-fetch kan structureel > 10 s duren).
  function _overviewRangeFor(kind) {
    const pad = (n) => String(n).padStart(2, '0');
    const fmt = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    const now = new Date();
    if (kind === 'all_time')   return { from: '2020-01-01', to: fmt(now) };
    if (kind === 'ytd')        return { from: now.getFullYear() + '-01-01', to: fmt(now) };
    // 'this_month' default
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: fmt(first), to: fmt(now) };
  }
  async function fetchOverviewCoaching(kind) {
    const b = _live.overviewCoaching[kind];
    if (!b) return;
    // Cache-check: recent data en niet in error-state → skip.
    const fresh = b.data && (Date.now() - (b.fetched_at || 0) < OVERVIEW_COACHING_TTL_MS);
    if (fresh || b.loading) return;
    b.loading = true; b.error = null;
    render();
    const { from, to } = _overviewRangeFor(kind);
    const url = `/api/mentor-coaching-earnings?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const j = await tryFetch('overview-coaching:' + kind, url, 45000);
    b.loading = false;
    if (!j || j.__error) { b.error = j?.__error || 'Kon coaching-totaal niet laden'; render(); return; }
    b.data = j; b.fetched_at = Date.now();
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
  window.__verdRetryTravel   = () => { _live.travel.data   = null; queueMicrotask(() => fetchTravel(_live.travel.key || currentMonthKey())); };
  window.__verdRetryCerts    = () => { _live.certs.data    = null; queueMicrotask(fetchCerts);    };
  window.__verdRetryCoaching = () => {
    _live.coaching.data = null; _live.coaching.key = null;
    const cp = _ui.coachPeriod;
    const r = _coachRangeFor(cp.preset, cp.customFrom, cp.customTo);
    queueMicrotask(() => fetchCoaching(r?.from || null, r?.to || null));
  };
  // Periode-preset wissel (Dag/Week/Maand/Jaar/Aangepast).
  window.__verdCoachSetPreset = (p) => {
    const allowed = ['day', 'week', 'month', 'year', 'custom'];
    if (!allowed.includes(p)) return;
    _ui.coachPeriod.preset = p;
    _live.coaching.data = null; _live.coaching.error = null; _live.coaching.key = null;
    // Bij niet-custom: direct refetch. Bij custom: wacht op 'Toepassen'.
    if (p === 'custom') { render(); return; }
    const r = _coachRangeFor(p);
    queueMicrotask(() => fetchCoaching(r?.from || null, r?.to || null));
  };
  // State-only setters (geen render) → focus behouden op de datepickers.
  window.__verdCoachSetCustomFrom = (el) => { _ui.coachPeriod.customFrom = String(el?.value || '').trim(); };
  window.__verdCoachSetCustomTo   = (el) => { _ui.coachPeriod.customTo   = String(el?.value || '').trim(); };
  window.__verdCoachApplyCustom = () => {
    const cp = _ui.coachPeriod;
    if (!cp.customFrom || !cp.customTo) { toast('Kies zowel een van- als een tot-datum.', 'warn'); return; }
    if (cp.customFrom > cp.customTo) { toast('Van-datum moet vóór tot-datum liggen.', 'warn'); return; }
    _live.coaching.data = null; _live.coaching.error = null; _live.coaching.key = null;
    queueMicrotask(() => fetchCoaching(cp.customFrom, cp.customTo));
  };
  window.__verdRetryOverviewCoaching = (kind) => {
    const b = _live.overviewCoaching[kind]; if (!b) return;
    b.data = null; b.error = null; b.fetched_at = 0;
    queueMicrotask(() => fetchOverviewCoaching(kind));
  };
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
      _live.travel.data = null; // key blijft = de gekozen maand
      _live.travelMonths.data = null; // dropdown ververst (days/status kan gewijzigd zijn)
      toast('Reisdagen opgeslagen', 'success');
      queueMicrotask(() => fetchTravel(key));
    }, 'warn');
  };
  // Maandwissel in de dropdown: laad de gekozen maand (reiskostenView auto-fetcht
  // op basis van _live.travel.key). Een openstaand invoerformulier sluit mee.
  window.__verdTravelSelectMonth = (mk) => {
    if (!mk || mk === _live.travel.key) return;
    _ui.travelForm = null;
    _live.travel.data = null; _live.travel.error = null; _live.travel.key = mk;
    render();
  };

  /* Cert-upload (supabase/AuthShared check pas runtime in __verdCertSubmit) */
  window.__verdCertOpenUpload = () => {
    _ui.certUpload = { studentId: '', studentName: '', file: null, fileName: '', saving: false, error: null, step: 'pick' };
    if (!_live.myStudents.data && !_live.myStudents.loading && !_live.myStudents.error) queueMicrotask(fetchMyStudents);
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

  // v=12 (2026-08-25) — cashflowChart port van v1 renderProjection12m
  // (mentor-dashboard.html:500-575). Toont paid-segment (emerald, betaald)
  // gestapeld op expected-segment (amber/blue, verwacht) per maand-bucket.
  // Input: months[] van mentor-bonus-overview.projection_12m (43 buckets,
  // -6..+36 met paid/expected/amount/breakdown per rij).
  //
  // Slice: standaard rond `now` (index 6 = huidige maand). We tonen 15
  // buckets = 3 verleden + huidige + 11 vooruit; genoeg voor volledige
  // cashflow-visie zonder horizontale scroll. Bij minder totale data:
  // trim naar wat er is.
  //
  // Fix bug v=11: v2 barChart12 gebruikte `height:X%` op een flex-item
  // zonder expliciete hoogte → parent-hoogte was intrinsic → 0-hoogte
  // balken. Deze versie zet `height:100%` op de flex-column zodat de
  // interne `height:X%` echt X% van 140px pakt.
  function cashflowChart(months, totals, opts) {
    const opt = opts || {};
    const wantBefore = Number.isFinite(opt.before) ? opt.before : 3;
    const wantAfter  = Number.isFinite(opt.after)  ? opt.after  : 11;
    const totalHeight = 140;
    if (!Array.isArray(months) || months.length === 0) {
      return `<div style="padding:12px;color:var(--text-3);font-size:12.5px">Geen cashflow beschikbaar.</div>`;
    }
    const now = new Date();
    const nowYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    let nowIdx = months.findIndex((m) => (m.month || '') === nowYm);
    if (nowIdx < 0) nowIdx = 0;
    const start = Math.max(0, nowIdx - wantBefore);
    const end   = Math.min(months.length, nowIdx + wantAfter + 1);
    const slice = months.slice(start, end);
    const mx    = slice.reduce((m, x) => Math.max(m, (Number(x.paid) || 0) + (Number(x.expected) || 0)), 0);

    const T = totals || {};
    const cfReceived  = Number(T.cf_received)  || 0;
    const cfExpected  = Number(T.cf_expected)  || 0;
    const cfThisMonth = Number(T.cf_this_month) || 0;

    const header = `
      <div style="display:flex;justify-content:space-between;gap:12px;padding:12px 16px 6px;flex-wrap:wrap;font-size:12.5px">
        <div>
          <div style="color:var(--text-3);font-size:11px;text-transform:uppercase;letter-spacing:.06em">Ontvangen</div>
          <div class="mono" style="font-size:18px;font-weight:600;color:var(--emerald)">${eur(cfReceived)}</div>
          <div style="font-size:11px;color:var(--text-3);margin-top:2px">vrijgegeven</div>
        </div>
        <div style="text-align:right">
          <div style="color:var(--text-3);font-size:11px;text-transform:uppercase;letter-spacing:.06em">Nog verwacht</div>
          <div class="mono" style="font-size:18px;font-weight:600;color:var(--blue)">${eur(cfExpected)}</div>
          <div style="font-size:11px;color:var(--text-3);margin-top:2px">deze maand: <b>${eur(cfThisMonth)}</b></div>
        </div>
      </div>`;

    const bars = slice.map((m, idx) => {
      const paid     = Number(m.paid)     || 0;
      const expected = Number(m.expected) || 0;
      const total    = paid + expected;
      const parts    = String(m.month || '').split('-');
      const monShort = shortMonthLabel(m.month) || parts[1] || '';
      const yr       = parts[0] ? String(parts[0]).slice(-2) : '';
      const isNow    = (start + idx) === nowIdx;

      let stack;
      if (total <= 0 || mx <= 0) {
        stack = `<div style="width:100%;height:2px;background:var(--surface-2);border-radius:2px;margin-top:auto"></div>`;
      } else {
        const paidH     = Math.round((paid     / mx) * totalHeight);
        const expectedH = Math.round((expected / mx) * totalHeight);
        const paidPx     = paid     > 0 ? Math.max(3, paidH)     : 0;
        const expectedPx = expected > 0 ? Math.max(3, expectedH) : 0;
        const paidSeg     = paid     > 0 ? `<div title="Ontvangen: ${eur(paid)}" style="width:100%;height:${paidPx}px;background:var(--emerald);${expected > 0 ? '' : 'border-radius:3px 3px 0 0'}"></div>` : '';
        const expectedSeg = expected > 0 ? `<div title="Verwacht: ${eur(expected)}" style="width:100%;height:${expectedPx}px;background:var(--blue);border-radius:3px 3px 0 0"></div>` : '';
        stack = `<div style="width:100%;display:flex;flex-direction:column;justify-content:flex-end;margin-top:auto;overflow:hidden;border-radius:3px 3px 0 0">${expectedSeg}${paidSeg}</div>`;
      }
      const amountLabel = total > 0 ? eur(Math.round(total)).replace('€ ', '€') : '';
      return `<div style="flex:1;min-width:22px;display:flex;flex-direction:column;align-items:center;height:100%;${isNow ? 'font-weight:600' : ''}">
        <div style="font-size:9.5px;color:var(--text-3);white-space:nowrap;margin-bottom:3px;min-height:12px">${esc(amountLabel)}</div>
        <div style="flex:1;width:100%;display:flex;flex-direction:column;justify-content:flex-end">${stack}</div>
        <div style="font-size:10px;color:${isNow ? 'var(--text)' : 'var(--text-3)'};margin-top:5px">${esc(monShort)}${isNow ? '' : ''}</div>
        <div style="font-size:9px;color:var(--text-3)">'${esc(yr)}</div>
      </div>`;
    }).join('');

    const legend = `<div style="display:flex;gap:14px;padding:4px 16px 10px;font-size:11.5px;color:var(--text-3)">
      <span style="display:flex;align-items:center;gap:5px"><span style="width:10px;height:10px;background:var(--emerald);border-radius:2px"></span>Ontvangen</span>
      <span style="display:flex;align-items:center;gap:5px"><span style="width:10px;height:10px;background:var(--blue);border-radius:2px"></span>Verwacht</span>
    </div>`;

    return `${header}
      <div style="display:flex;align-items:stretch;gap:6px;height:${totalHeight + 44}px;padding:8px 16px 8px">${bars}</div>
      ${legend}`;
  }

  // v=11 — SVG doughnut voor bonus-vs-coaching source-split op Overzicht.
  // 2 segmenten; ronde inner-hole met totaal in het midden. Kleur-tokens
  // uit het design-system zodat theme-swap klopt. Guard: sum ≤ 0 → empty
  // state (grijze cirkel + "Nog geen verdiensten").
  function doughnutTwo(a, b, labelA, labelB) {
    const va = Math.max(0, Number(a) || 0);
    const vb = Math.max(0, Number(b) || 0);
    const sum = va + vb;
    if (sum <= 0) {
      return `<div style="display:flex;flex-direction:column;align-items:center;gap:8px;padding:20px 8px">
        <svg viewBox="0 0 42 42" style="width:132px;height:132px" aria-hidden="true">
          <circle cx="21" cy="21" r="15.9155" fill="none" stroke="var(--surface-2)" stroke-width="6"/>
        </svg>
        <div style="font-size:12px;color:var(--text-3);text-align:center">Nog geen verdiensten — bron-verdeling verschijnt zodra er bedragen geboekt zijn.</div>
      </div>`;
    }
    const pctA = (va / sum) * 100;
    const pctB = 100 - pctA;
    // stroke-dasharray truc op circumference (2πr, r=15.9155 → ~100).
    const strokeA = pctA.toFixed(2) + ' ' + (100 - pctA).toFixed(2);
    const strokeB = pctB.toFixed(2) + ' ' + (100 - pctB).toFixed(2);
    const offsetB = (25 + (100 - pctA)).toFixed(2); // rotate by pctA
    return `<div style="display:flex;align-items:center;gap:16px;padding:8px 4px 4px;flex-wrap:wrap;justify-content:center">
      <div style="position:relative;width:160px;height:160px;flex-shrink:0">
        <svg viewBox="0 0 42 42" style="width:100%;height:100%;display:block" role="img" aria-label="Bron-verdeling bonus vs coaching">
        <circle cx="21" cy="21" r="15.9155" fill="none" stroke="var(--surface-2)" stroke-width="6"/>
        <circle cx="21" cy="21" r="15.9155" fill="none" stroke="var(--violet)"  stroke-width="6" stroke-dasharray="${strokeA}" stroke-dashoffset="25" transform="rotate(-90 21 21)"/>
        <circle cx="21" cy="21" r="15.9155" fill="none" stroke="var(--emerald)" stroke-width="6" stroke-dasharray="${strokeB}" stroke-dashoffset="${offsetB}" transform="rotate(-90 21 21)"/>
      </svg>
        <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:92px;height:92px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;pointer-events:none">
          <div class="mono" style="font-size:${(() => { const s = eur(sum); return s.length <= 8 ? 20 : s.length <= 11 ? 17 : s.length <= 14 ? 14 : 12; })()}px;font-weight:600;line-height:1.1;color:var(--text);letter-spacing:-.02em;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(eur(sum))}</div>
          <div style="font-size:10.5px;color:var(--text-3);margin-top:3px;letter-spacing:.02em">totaal</div>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:10px;min-width:200px">
        <div style="display:flex;align-items:center;gap:8px;font-size:12.5px">
          <span style="width:11px;height:11px;border-radius:3px;background:var(--violet);flex-shrink:0"></span>
          <span style="flex:1"><b>${esc(labelA)}</b> · ${eur(va)}</span>
          <span class="mono" style="color:var(--text-3);font-size:11.5px">${Math.round(pctA)}%</span>
        </div>
        <div style="display:flex;align-items:center;gap:8px;font-size:12.5px">
          <span style="width:11px;height:11px;border-radius:3px;background:var(--emerald);flex-shrink:0"></span>
          <span style="flex:1"><b>${esc(labelB)}</b> · ${eur(vb)}</span>
          <span class="mono" style="color:var(--text-3);font-size:11.5px">${Math.round(pctB)}%</span>
        </div>
      </div>
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
     BONUS DRILL-DOWN — port v1 mentor-dashboard.html:717-983 (v=12)
     ═══════════════════════════════════════════════════════════════════════ */
  const BONUS_TABS = [
    { key: 'actief',      label: 'Actief' },
    { key: 'overdue',     label: 'Betaalproblemen' },
    { key: 'pauze',       label: 'Pauze' },
    { key: 'wacht_start', label: 'Wachten op start' },
    { key: 'geannuleerd', label: 'Geannuleerd' },
    { key: 'alle',        label: 'Alle' },
  ];
  function _bonusFilter(rows, tab) {
    switch (tab) {
      case 'overdue':     return rows.filter((s) => s.has_overdue === true);
      case 'pauze':       return rows.filter((s) => s.status === 'pauze');
      case 'wacht_start': return rows.filter((s) => (s.status === 'geen_abonnement' || s.status === 'wacht_op_start') && s.has_overdue !== true);
      case 'geannuleerd': return rows.filter((s) => s.status === 'geannuleerd');
      case 'alle':        return rows;
      case 'actief':
      default:            return rows.filter((s) => s.status === 'actief' || s.status === 'voltooid' || s.status === 'wacht_1e_betaling' || s.has_overdue === true);
    }
  }
  function _bonusFlatten(perEvent) {
    if (!Array.isArray(perEvent)) return [];
    const out = [];
    let seq = 0;
    for (const ev of perEvent) {
      for (const s of asArr(ev.sales)) {
        seq += 1;
        out.push({
          event_id     : ev.event_id     || null,
          event_title  : ev.event_title  || '—',
          event_starts : ev.starts_at    || null,
          ...s,
          _key         : 'r' + seq,
        });
      }
    }
    return out;
  }
  function _bonusStatusPill(status, startDate) {
    switch (status) {
      case 'actief':            return H.pill('ok',      'Actief');
      case 'wacht_op_start':    return H.pill('info',    startDate ? 'Start op ' + fmtDate(startDate) : 'Wacht op start');
      case 'wacht_1e_betaling': return H.pill('warn',    'Wacht op 1e betaling');
      case 'voltooid':          return H.pill('info',    'Voltooid');
      case 'pauze':             return H.pill('neutral', 'Pauze');
      case 'geen_abonnement':   return H.pill('neutral', 'Geen abonnement');
      case 'geannuleerd':       return H.pill('danger',  'Geannuleerd');
      default:                  return H.pill('neutral', status || '—');
    }
  }
  function _bonusTermStatusPill(status) {
    if (status === 'betaald')       return H.pill('ok',     'Betaald');
    if (status === 'achterstallig') return H.pill('danger', 'Achterstallig');
    return H.pill('warn', 'Open');
  }
  window.__verdBonusSetTab = (t) => {
    if (!BONUS_TABS.find((x) => x.key === t)) return;
    _ui.bonus.tab = t; _ui.bonus.page = 1; render();
  };
  window.__verdBonusSetPage = (p) => {
    const n = parseInt(p, 10);
    if (!Number.isFinite(n) || n < 1) return;
    _ui.bonus.page = n; render();
  };
  window.__verdBonusToggle = (key) => {
    if (_ui.bonus.open.has(key)) _ui.bonus.open.delete(key);
    else _ui.bonus.open.add(key);
    render();
  };
  function renderBonusDrillDown(perEvent) {
    const rowsAll = _bonusFlatten(perEvent);
    if (rowsAll.length === 0) {
      return `<div style="padding:22px;text-align:center;color:var(--text-3);font-size:12.5px">Nog geen bonus-rijen voor je events.</div>`;
    }
    // Tab-counts vóór filter.
    const counts = {};
    for (const t of BONUS_TABS) counts[t.key] = _bonusFilter(rowsAll, t.key).length;
    const tabStrip = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px">${BONUS_TABS.map((t) => `
      <button class="btn ${_ui.bonus.tab === t.key ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="window.__verdBonusSetTab('${t.key}')">
        ${esc(t.label)} <span style="opacity:.7;font-weight:500">(${counts[t.key] || 0})</span>
      </button>`).join('')}</div>`;

    const rows = _bonusFilter(rowsAll, _ui.bonus.tab);
    if (rows.length === 0) {
      return `${tabStrip}<div style="padding:22px;text-align:center;color:var(--text-3);font-size:12.5px">Geen sales in deze categorie.</div>`;
    }

    // Pagination.
    const total = rows.length;
    const pageSize = _ui.bonus.pageSize;
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    if (_ui.bonus.page > pageCount) _ui.bonus.page = pageCount;
    const page = _ui.bonus.page;
    const start = (page - 1) * pageSize;
    const end = Math.min(start + pageSize, total);
    const slice = rows.slice(start, end);

    // Body-rijen — summary + optionele detail.
    const bodyHtml = slice.map((s) => {
      const isOpen = _ui.bonus.open.has(s._key);
      const termCount = Number(s.term_count) || 0;
      const paidCount = Number(s.paid_term_count) || 0;
      const pct = termCount > 0 ? Math.max(0, Math.min(100, (paidCount / termCount) * 100)) : 0;
      const firstBadge = s.first_invoice_paid
        ? H.pill('ok', '1e factuur betaald')
        : H.pill('neutral', 'Nog niet');
      const shareCell = s.is_cash_traject
        ? `${eur(s.traject_total_incl != null ? s.traject_total_incl : s.mentor_share_total)} <span class="pill pill-neutral nodot" title="Reeds vrijgevallen" style="margin-left:4px">vrij: ${eur(s.mentor_share_total)}</span>`
        : (s.schema_unknown
            ? `${eur(s.mentor_share_total)} <span class="pill pill-neutral nodot" title="Nog niet meegeteld in KPI's tot er een abonnement is" style="margin-left:4px">nog niet in KPI</span>`
            : `${eur(s.mentor_share_total)} <span class="pill pill-neutral nodot" title="Reeds vrijgevallen (uitbetaald of vrijgegeven)" style="margin-left:4px">vrij: ${eur(s.released_share != null ? s.released_share : 0)}</span>`);
      const overdueBadge = s.has_overdue
        ? ` <span class="pill pill-danger nodot" title="${Number(s.overdue_count) || 0} factu(u)r(en) te laat — ${eur(Number(s.overdue_amount) || 0)} openstaand" style="margin-left:4px">Achterstand</span>`
        : '';
      const summaryRow = `<tr onclick="window.__verdBonusToggle('${esc(s._key)}')" style="cursor:pointer;${isOpen ? 'background:var(--surface-2)' : ''}">
        <td><strong>${esc(s.customer_label || '—')}</strong></td>
        <td>
          <div>${esc(s.event_title || '—')}</div>
          <div style="font-size:11px;color:var(--text-3)">${fmtDate(s.event_starts)}</div>
        </td>
        <td>${_bonusStatusPill(s.status, s.start_date)}${overdueBadge}</td>
        <td>
          <div style="font-size:12px">${paidCount}/${termCount}</div>
          <div class="progress" style="height:5px;margin-top:3px;max-width:100px"><i style="width:${pct.toFixed(1)}%;background:var(--emerald)"></i></div>
        </td>
        <td style="color:var(--text-3)">${s.last_payment_date ? fmtDate(s.last_payment_date) : '—'}</td>
        <td>${firstBadge}</td>
        <td style="text-align:right"><span class="money">${shareCell}</span></td>
        <td style="text-align:center;color:var(--text-3);font-size:12px">${isOpen ? '▾' : '▸'}</td>
      </tr>`;

      let detailRow = '';
      if (isOpen) {
        const termRows = asArr(s.termijnen).map((t) => `<tr>
          <td>${Number(t.index) || 0}</td>
          <td>${fmtDate(t.due_date)}</td>
          <td style="text-align:right"><span class="mono">${eur(t.amount)}</span></td>
          <td>${_bonusTermStatusPill(t.status)}</td>
        </tr>`).join('');
        const schemaLine = s.schema_unknown
          ? `<div style="font-size:12px;color:var(--amber);margin-bottom:8px;padding:8px 10px;background:var(--amber-soft);border-radius:6px">⚠ Er is nog geen abonnement bekend voor deze klant — richt eerst een abonnement in voordat deze bonus meetelt in de KPI's.</div>`
          : '';
        const summaryStats = s.is_cash_traject
          ? `<div><span style="color:var(--text-3)">Totaal traject-bonus: </span><b>${eur(s.traject_total_incl != null ? s.traject_total_incl : s.sale_total_incl)}</b></div>
             <div><span style="color:var(--text-3)">Reeds vrijgevallen: </span><b>${eur(s.mentor_share_total)}</b></div>`
          : `<div><span style="color:var(--text-3)">Sale-totaal (incl. BTW): </span><b>${eur(s.sale_total_incl)}</b></div>
             <div><span style="color:var(--text-3)">Jouw totaal-aandeel: </span><b>${eur(s.mentor_share_total)}</b></div>
             <div><span style="color:var(--text-3)">Reeds vrijgevallen: </span><b>${eur(s.released_share != null ? s.released_share : 0)}</b></div>`;
        detailRow = `<tr><td colspan="8" style="padding:14px 18px;background:var(--surface-2);border-top:1px solid var(--border)">
          ${schemaLine}
          <div style="display:flex;flex-wrap:wrap;gap:20px;font-size:12.5px;color:var(--text-2);margin-bottom:10px">
            ${summaryStats}
            <div><span style="color:var(--text-3)">Per termijn: </span><b>${eur(s.per_term_amount)}</b> (${Number(s.term_count) || 0}×)</div>
            <div><span style="color:var(--text-3)">Betaald: </span><b>${Number(s.paid_term_count) || 0}/${Number(s.term_count) || 0}</b></div>
          </div>
          ${termRows ? `<div style="border:1px solid var(--border);border-radius:6px;overflow:hidden">
            <table style="width:100%;border-collapse:collapse;font-size:12.5px">
              <thead><tr style="background:var(--surface);color:var(--text-3);font-size:11px;text-transform:uppercase;letter-spacing:.06em">
                <th style="text-align:left;padding:6px 10px">#</th>
                <th style="text-align:left;padding:6px 10px">Vervaldatum</th>
                <th style="text-align:right;padding:6px 10px">Bedrag</th>
                <th style="text-align:left;padding:6px 10px">Status</th>
              </tr></thead>
              <tbody>${termRows}</tbody>
            </table>
          </div>` : '<div style="color:var(--text-3);font-size:12px">Geen termijn-schema beschikbaar.</div>'}
        </td></tr>`;
      }
      return summaryRow + detailRow;
    }).join('');

    const pager = pageCount > 1 ? (() => {
      const nums = new Set([1, pageCount, page, page - 1, page + 1, page - 2, page + 2]);
      const ordered = [...nums].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b);
      let numsHtml = '';
      let prev = 0;
      for (const n of ordered) {
        if (prev && n - prev > 1) numsHtml += '<span style="color:var(--text-3);padding:0 4px">…</span>';
        numsHtml += `<button class="btn ${n === page ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="window.__verdBonusSetPage(${n})">${n}</button>`;
        prev = n;
      }
      return `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:12px;flex-wrap:wrap">
        <div style="font-size:12px;color:var(--text-3)">${start + 1}–${end} van ${total}</div>
        <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap">
          <button class="btn btn-ghost btn-sm" ${page <= 1 ? 'disabled' : ''} onclick="window.__verdBonusSetPage(${page - 1})">← Vorige</button>
          ${numsHtml}
          <button class="btn btn-ghost btn-sm" ${page >= pageCount ? 'disabled' : ''} onclick="window.__verdBonusSetPage(${page + 1})">Volgende →</button>
        </div>
      </div>`;
    })() : `<div style="margin-top:8px;font-size:12px;color:var(--text-3)">${start + 1}–${end} van ${total}</div>`;

    return `${tabStrip}
      <div style="border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="background:var(--surface-2);color:var(--text-3);font-size:11px;text-transform:uppercase;letter-spacing:.06em">
            <th style="text-align:left;padding:8px 10px">Klant</th>
            <th style="text-align:left;padding:8px 10px">Event</th>
            <th style="text-align:left;padding:8px 10px">Status</th>
            <th style="text-align:left;padding:8px 10px">Termijnen</th>
            <th style="text-align:left;padding:8px 10px">Laatste betaling</th>
            <th style="text-align:left;padding:8px 10px">1e factuur</th>
            <th style="text-align:right;padding:8px 10px">Totaal bonus</th>
            <th style="padding:8px 10px;width:20px"></th>
          </tr></thead>
          <tbody>${bodyHtml}</tbody>
        </table>
      </div>
      ${pager}`;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     VIEW 1 — Overzicht
     ═══════════════════════════════════════════════════════════════════════ */
  function overzichtView() {
    if (!_live.overview.loading && !_live.overview.data && !_live.overview.error) queueMicrotask(fetchOverview);
    if (_live.overview.error && !_live.overview.data) return errBlk(_live.overview.error, 'window.__verdRetryOverview()') + renderConfirmModal();
    if (!_live.overview.data) return skel() + renderConfirmModal();

    // v=11 — trigger 3 coaching-buckets lazy zodra Overzicht opent. Elk cachet
    // 10 min. render() wordt door de fetcher zelf getriggerd wanneer data
    // binnenkomt, dus geen re-render-loop hier.
    if (!_live.overviewCoaching.all_time.data   && !_live.overviewCoaching.all_time.loading   && !_live.overviewCoaching.all_time.error)   queueMicrotask(() => fetchOverviewCoaching('all_time'));
    if (!_live.overviewCoaching.this_month.data && !_live.overviewCoaching.this_month.loading && !_live.overviewCoaching.this_month.error) queueMicrotask(() => fetchOverviewCoaching('this_month'));
    if (!_live.overviewCoaching.ytd.data        && !_live.overviewCoaching.ytd.loading        && !_live.overviewCoaching.ytd.error)        queueMicrotask(() => fetchOverviewCoaching('ytd'));

    const d = _live.overview.data;
    const t = d.totals || {};
    const earnedTotal = Number(t.earned_total)   || 0;
    const dezeMaand   = Number(t.deze_maand)     || 0;

    // v=11 — gecombineerde tegels bovenaan (bonus + coaching). Formule
    // volgt exact mentor-dashboard.html:2078-2079. `earned_total` is
    // all-time bonus-basis; coaching-YTD is year-to-date.
    const cbA = _live.overviewCoaching.all_time;
    const cbM = _live.overviewCoaching.this_month;
    const cbY = _live.overviewCoaching.ytd;
    const coachAll   = Number(cbA.data?.grand_total) || 0;
    const coachMonth = Number(cbM.data?.grand_total) || 0;
    const coachYtd   = Number(cbY.data?.grand_total) || 0;

    // Klaar-check per tegel: loading/error/data. Fallback string bij loading.
    const combinedTotaal = (cbA.data ? eur(earnedTotal + coachAll)     : '⌛');
    const combinedMonth  = (cbM.data ? eur(dezeMaand   + coachMonth)   : '⌛');
    const combinedYtd    = (cbY.data ? eur(earnedTotal + coachYtd)     : '⌛');
    const combinedSubTot = cbA.error ? '⚠ ' + esc(cbA.error) : (cbA.loading || !cbA.data ? 'coaching-totaal laden…' : `bonus ${eur(earnedTotal)} + coaching ${eur(coachAll)}`);
    const combinedSubMon = cbM.error ? '⚠ ' + esc(cbM.error) : (cbM.loading || !cbM.data ? 'coaching-maand laden…' : `bonus ${eur(dezeMaand)} + coaching ${eur(coachMonth)}`);
    const combinedSubYtd = cbY.error ? '⚠ ' + esc(cbY.error) : (cbY.loading || !cbY.data ? 'coaching-YTD laden…' : `bonus ${eur(earnedTotal)} + coaching ${eur(coachYtd)}`);

    // Doughnut: hergebruikt de all-time bedragen (zelfde bron als "Verdiend
    // totaal"). Bij loading toont 'ie de empty-state doughnut; niet-blokkerend.
    const doughnutBody = cbA.data
      ? doughnutTwo(earnedTotal, coachAll, 'Bonus (event)', 'Coaching')
      : (cbA.error
          ? `<div style="padding:14px 16px;background:var(--rose-soft);color:var(--rose);border-radius:var(--r);font-size:12.5px">⚠ ${esc(cbA.error)} <button class="btn btn-ghost btn-sm" style="margin-left:8px" onclick="window.__verdRetryOverviewCoaching('all_time')">Opnieuw</button></div>`
          : `<div style="padding:14px;color:var(--text-3);font-size:12.5px;text-align:center">Bron-verdeling laden…</div>`);

    // v=13 — bonus-detail (KPIs, status-cards, cashflow-chart, drill-down)
    // verhuisd naar de Events-tab (hoort thematisch bij event-bonussen).
    // Overzicht is nu pure high-level: 3 combined-tegels + bron-donut.
    return `${H.kpis([
      { c: 'pink',    icon: I.chart, label: 'Verdiend totaal',    val: combinedTotaal, sub: combinedSubTot, hi: true },
      { c: 'blue',    icon: I.euro,  label: 'Verdiend deze maand', val: combinedMonth,  sub: combinedSubMon },
      { c: 'emerald', icon: I.cal,   label: 'Verdiend YTD',        val: combinedYtd,    sub: combinedSubYtd },
    ])}
    <div class="pad" style="padding-top:16px">
      ${dashCard('Bron-verdeling (all-time)', 'violet', doughnutBody)}
    </div>
    ${renderConfirmModal()}`;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     VIEW 2 — Coaching
     ═══════════════════════════════════════════════════════════════════════ */
  function coachingView() {
    // Bootstrap: fetch met de huidige preset (default 'month' — matcht
    // eerder gedrag). Bij 'custom' zonder van/tot: geen fetch, alleen UI.
    if (!_live.coaching.loading && !_live.coaching.data && !_live.coaching.error) {
      const cp = _ui.coachPeriod;
      const r = _coachRangeFor(cp.preset, cp.customFrom, cp.customTo);
      if (r) queueMicrotask(() => fetchCoaching(r.from, r.to));
    }
    // Header (chips + custom-range) rendert altijd, ook bij loading/error/empty.
    const cp = _ui.coachPeriod;
    const presetChips = [
      ['day',   'Dag'],
      ['week',  'Week'],
      ['month', 'Maand'],
      ['year',  'Jaar'],
      ['custom','Aangepast'],
    ].map(([v, label]) => `<button class="btn ${cp.preset === v ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="window.__verdCoachSetPreset('${v}')">${esc(label)}</button>`).join('');
    const customFromVal = esc(cp.customFrom || '');
    const customToVal   = esc(cp.customTo   || '');
    const customBlock = cp.preset === 'custom' ? `
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <label style="font-size:11.5px;color:var(--text-3)">Van
          <input type="date" value="${customFromVal}" oninput="window.__verdCoachSetCustomFrom(this)" style="margin-left:6px;padding:4px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font:inherit;font-size:12.5px;color:var(--text-1)"/>
        </label>
        <label style="font-size:11.5px;color:var(--text-3)">Tot
          <input type="date" value="${customToVal}" oninput="window.__verdCoachSetCustomTo(this)" style="margin-left:6px;padding:4px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font:inherit;font-size:12.5px;color:var(--text-1)"/>
        </label>
        <button class="btn btn-primary btn-sm" onclick="window.__verdCoachApplyCustom()">Toepassen</button>
      </div>` : '';
    const headerToolbar = H.toolbar([
      `<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">${presetChips}</div>`,
      customBlock,
    ]);

    // Wacht op user-input bij custom zonder van/tot.
    if (cp.preset === 'custom' && (!cp.customFrom || !cp.customTo)) {
      return `${headerToolbar}
        <div class="pad" style="padding-top:16px">
          <div style="padding:22px;text-align:center;color:var(--text-3);font-size:13px;background:var(--surface-2);border-radius:var(--r)">Kies een van- en tot-datum en klik <b>Toepassen</b> om coaching-cijfers voor deze periode te laden.</div>
        </div>
        ${renderConfirmModal()}`;
    }

    if (_live.coaching.error && !_live.coaching.data) return `${headerToolbar}${errBlk(_live.coaching.error, 'window.__verdRetryCoaching()')}${renderConfirmModal()}`;
    if (!_live.coaching.data) return `${headerToolbar}${skel()}${renderConfirmModal()}`;

    const d = _live.coaching.data;
    const bd = d.breakdown || d;
    // v=10 (2026-08-25) — FIX Seppe €34.010-discrepantie. Server geeft
    // `breakdown.<cat>.count` + `.total` (zie api/_lib/coaching-earnings.js
    // regel 263-268 + mentor-coaching-earnings.js payload). V2 las eerder
    // `.qty` en `.amount_incl` — beide bestaan NIET → tegels/tabel bleven 0.
    // V1 (modules/mentor-home.html:503) leest `d.grand_total` direct en
    // heeft de bug daarom niet. Legacy-fallback op oude namen blijft staan
    // voor als een ander endpoint dezelfde caller zou hergebruiken.
    const b = {
      one_on_one: Number(bd.one_on_one?.count ?? bd.one_on_one?.qty ?? bd.one_on_one_qty ?? 0),
      team:       Number(bd.team?.count       ?? bd.team?.qty       ?? bd.team_qty       ?? 0),
      no_show:    Number(bd.no_show?.count    ?? bd.no_show?.qty    ?? bd.no_show_qty    ?? 0),
      funded:     Number(bd.funded?.count     ?? bd.funded?.qty     ?? bd.funded_qty     ?? 0),
    };
    const a = {
      one_on_one: Number(bd.one_on_one?.total ?? bd.one_on_one?.amount_incl ?? bd.one_on_one_amount ?? (b.one_on_one * 35)),
      team:       Number(bd.team?.total       ?? bd.team?.amount_incl       ?? bd.team_amount       ?? (b.team * 50)),
      no_show:    Number(bd.no_show?.total    ?? bd.no_show?.amount_incl    ?? bd.no_show_amount    ?? (b.no_show * 25)),
      funded:     Number(bd.funded?.total     ?? bd.funded?.amount_incl     ?? bd.funded_amount     ?? (b.funded * 100)),
    };
    // Prefer server-side grand_total (autoritatief) boven client-som; valt
    // terug op client-som als het endpoint 'm ooit weglaat.
    const total = Number(d.grand_total ?? (a.one_on_one + a.team + a.no_show + a.funded));
    const from = d.from || _live.coaching.from || '—';
    const to   = d.to   || _live.coaching.to   || '—';

    return `${headerToolbar}
    ${H.kpis([
      { c: 'blue',    icon: I.users, label: '1-op-1 sessies', val: String(b.one_on_one), sub: eur(a.one_on_one) + ' · €35/sessie' },
      { c: 'violet',  icon: I.users, label: 'Team-trainingen', val: String(b.team),       sub: eur(a.team) + ' · €50/sessie' },
      { c: 'amber',   icon: I.alert, label: 'No-show',         val: String(b.no_show),    sub: eur(a.no_show) + ' · €25/sessie' },
      { c: 'emerald', icon: I.grad,  label: 'Funded certs',    val: String(b.funded),     sub: eur(a.funded) + ' · €100 per stuk' },
    ])}
    <div class="pad" style="padding-top:16px">
      <div style="padding:10px 14px;background:var(--surface-2);border-radius:var(--r);font-size:12px;color:var(--text-3);margin-bottom:12px">
        Periode: <b>${esc(from)}</b> → <b>${esc(to)}</b> · schakelaar bovenaan om te wisselen (default = huidige maand).
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
    // v=13 — Events-tab is nu ook home van bonus-detail; overview lazy-triggeren
    // als user direct hierheen navigeert (overzichtView zou 'em normaal starten).
    if (!_live.overview.loading && !_live.overview.data && !_live.overview.error) queueMicrotask(fetchOverview);
    if (_live.myEvents.error && !_live.myEvents.data) return errBlk(_live.myEvents.error, 'window.__verdRetryMyEvents()') + renderConfirmModal();
    if (!_live.myEvents.data) return skel() + renderConfirmModal();

    const events = asArr(_live.myEvents.data.events);
    const scope = _live.myEvents.scope;
    // v=13 — Events-tab is nu de home van alle event-bonus-detail. Hergebruikt
    // dezelfde `overview` state (mentor-bonus-overview) — geen extra fetch,
    // `_ui.bonus.tab/page/open` blijft intact tussen tab-wissels.
    const ov = _live.overview.data;
    const t = ov?.totals || {};
    const projMonths = asArr(ov?.projection_12m);
    const perEvent   = asArr(ov?.per_event);
    const earnedTotal = Number(t.earned_total)   || 0;
    const dezeMaand   = Number(t.deze_maand)     || 0;
    const volgendeMnd = Number(t.volgende_maand) || 0;
    const openTotaal  = Number(t.open)           || 0;
    const betaaldUit  = Number(t.betaald_uit)    || 0;
    const mxBar       = Math.max(dezeMaand, volgendeMnd, openTotaal, 1);

    // Als overview-fetch nog loopt of gefaald is: toon een fallback maar houd
    // de Mijn-events lijst zichtbaar (die heeft eigen fetch, is al klaar).
    const overviewReady = !!ov;
    const overviewErr   = _live.overview.error;

    // Bonus-blokken (alleen renderen als overview binnen is).
    const bonusKpis = overviewReady ? H.kpis([
      { c: 'blue',    icon: I.euro,  label: 'Bonus deze maand',   val: eur(dezeMaand),   sub: 'bonus-vrijgave' },
      { c: 'amber',   icon: I.clock, label: 'Bonus volgende maand', val: eur(volgendeMnd), sub: 'geplande vrijgave' },
      { c: 'teal',    icon: I.cal,   label: 'Bonus openstaand',   val: eur(openTotaal),  sub: 'niet-uitbetaalde bonus' },
      { c: 'emerald', icon: I.chart, label: 'Bonus totaal verdiend', val: eur(earnedTotal), sub: 'alle bonussen sinds start' },
    ]) : '';

    const bonusStatusCards = overviewReady ? `
      <div class="pad" style="padding-top:16px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start">
          ${dashCard('Bonus-status', 'blue',
            hbar('Betaald uit', betaaldUit, Math.max(earnedTotal, 1), 'emerald', eur(betaaldUit))
            + hbar('Open (nog niet uitbetaald)', openTotaal, Math.max(earnedTotal, 1), 'amber', eur(openTotaal))
            + `<div style="margin-top:8px;padding-top:12px;border-top:1px solid var(--border);display:flex;justify-content:space-between;font-size:13px"><b>Totaal verdiend</b><b class="mono">${eur(earnedTotal)}</b></div>`)}
          ${dashCard('Deze vs volgende maand', 'emerald',
            hbar('Deze maand',     dezeMaand,   mxBar, 'blue',  eur(dezeMaand))
            + hbar('Volgende maand', volgendeMnd, mxBar, 'amber', eur(volgendeMnd))
            + `<div style="font-size:11.5px;color:var(--text-3);margin-top:8px">Cash-release-schema: bonus wordt vrijgegeven zodra de bijbehorende factuur betaald is (of via cash-traject).</div>`)}
        </div>
        ${projMonths.length ? `<div style="margin-top:14px">${dashCard('Cashflow-projectie · 15 maanden', 'blue', cashflowChart(projMonths, t, { before: 3, after: 11 }))}</div>` : ''}
        ${perEvent.length ? `<div style="margin-top:14px">${dashCard('Bonus per klant · uitklapbaar', 'violet', renderBonusDrillDown(perEvent))}</div>` : ''}
      </div>` : (overviewErr
        ? `<div class="pad" style="padding-top:16px">${errBlk('Bonus-detail: ' + overviewErr, 'window.__verdRetryOverview()')}</div>`
        : `<div class="pad" style="padding-top:16px">${skel()}</div>`);

    return `${bonusKpis}
    ${bonusStatusCards}
    <div class="pad" style="padding-top:16px">
      ${H.toolbar([
        `<div style="display:flex;gap:6px">
          <button class="btn ${scope === 'upcoming' ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="window.__verdSetMyEventsScope('upcoming')">Komend</button>
          <button class="btn ${scope === 'past'     ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="window.__verdSetMyEventsScope('past')">Voorbij</button>
          <button class="btn ${scope === 'all'      ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="window.__verdSetMyEventsScope('all')">Alles</button>
        </div>`,
      ])}
      ${dashCard('Mijn events (' + scope + ')', 'violet',
        events.length ? H.table(
          [{ l: 'Event' }, { l: 'Start', cls: 'optional' }, { l: 'Aanwezig' }],
          events.map((ev) => [
            `<span class="cell-main">${esc(ev.title || ev.event_title || '—')}</span>`,
            `<span style="color:var(--text-3)">${fmtDateTime(ev.starts_at)}</span>`,
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
    const mk = _live.travel.key || currentMonthKey();
    if (!_live.travel.loading && !_live.travel.data && !_live.travel.error) queueMicrotask(() => fetchTravel(mk));
    if (!_live.travelMonths.loading && !_live.travelMonths.data && !_live.travelMonths.error) queueMicrotask(fetchTravelMonths);
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
    // Reminder alleen voor de HUIDIGE maand (bij een gekozen oudere maand niet).
    const isCurrentMonth = monthKey(t.period_month) === currentMonthKey();
    const needsReminder = isCurrentMonth && editable && !submitted && todayIsOnOrAfterFirstFriday();

    // Maand-dropdown: huidige + 6 maanden terug; goedgekeurde maanden gemarkeerd.
    const monthsList = (_live.travelMonths.data && Array.isArray(_live.travelMonths.data.months)) ? _live.travelMonths.data.months : null;
    const monthSelect = monthsList && monthsList.length ? `
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:16px">
        <label style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Maand</label>
        <select onchange="window.__verdTravelSelectMonth(this.value)" ${_live.travel.loading ? 'disabled' : ''}
          style="padding:8px 12px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px;min-width:210px">
          ${monthsList.map((mo) => {
            const v = String(mo.period_month).slice(0, 7);
            const sel = v === (_live.travel.key || mk) ? ' selected' : '';
            return `<option value="${v}"${sel}>${esc(fmtMonth(mo.period_month))}${mo.editable ? '' : ' — goedgekeurd'}</option>`;
          }).join('')}
        </select>
        ${_live.travel.loading ? '<span style="font-size:12px;color:var(--text-3)">laden…</span>' : ''}
      </div>` : '';

    return `${monthSelect ? `<div class="pad" style="padding-bottom:0">${monthSelect}</div>` : ''}${H.kpis([
      { c: 'blue',    icon: I.euro,  label: 'Vergoeding per rijdag', val: eur(dayRate), sub: 'jouw vaste bedrag' },
      { c: 'amber',   icon: I.route, label: 'Doorgegeven',           val: String(days), sub: fmtMonth(t.period_month) },
      { c: 'emerald', icon: I.chart, label: 'Vergoeding',            val: eur(amount),  sub: days + ' × ' + eur(dayRate) },
    ])}
    <div class="pad" style="padding-top:16px">
      ${needsReminder ? `<div style="padding:14px 16px;background:var(--amber-soft);border:1px solid var(--amber);color:var(--amber);border-radius:var(--r);font-size:13px;margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <span>⏰ Rijdagen voor ${fmtMonth(t.period_month)} nog niet doorgegeven. Doe dit vóór de uitbetaling zodat het meegenomen wordt.</span>
        <button class="btn btn-primary btn-sm" onclick="window.__verdTravelOpenForm()">Doorgeven →</button>
      </div>` : ''}
      ${dashCard(fmtMonth(t.period_month), 'blue', `
        <div style="display:flex;align-items:flex-start;gap:11px;padding-bottom:12px;font-size:12.5px;color:var(--text-2)">
          ${svg(I.clock, 'width:16px;height:16px;flex-shrink:0;margin-top:1px;color:var(--amber)')}
          <span>Rapport-status: ${status ? payoutPill(status) : '<i>nog geen concept aangemaakt</i>'}. ${editable ? 'Nog aanpasbaar tot goedkeuring door finance.' : '<b>Goedgekeurd — niet meer aanpasbaar.</b>'}</span>
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
                     : `<span style="font-size:12.5px;color:var(--text-3);align-self:center">🔒 Goedgekeurd — niet meer aanpasbaar</span>`}
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

  console.debug('[verdiensten-v2] v7 — Coaching-tab vrije periode-selectie (Dag/Week/Maand/Jaar/Aangepast met van-tot datepicker + Toepassen). Endpoint mentor-coaching-earnings accepteert al ?from=&to=. State-only setter op datepickers → focus behouden. 6 views registered.');
})();
