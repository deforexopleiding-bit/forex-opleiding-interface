// modules/klanten-v2/views/finance-v2.js
//
// Data-ronde — Finance als live-module. 6 tabs (uit MODS): Dashboard /
// Facturen / Abonnementen / Creditnota's / Bank / Omzet & MRR.
//
// KRITIEK — beschermde-zone-scheiding:
// - Wanbetalers is een APARTE module (Fase H). Finance-tab-set bevat
//   die NIET. Deze view rendert GEEN dunning/joost/voys/arrangements/
//   pending-actions data. Uit /api/finance-dashboard-counts negeren we
//   expliciet de velden: actieveArrangements, openVerifyPayment,
//   openEscalations, joostStats, conversieWanbetalersFlow.
// - Alleen bestaande endpoints, GEEN nieuwe backend.
//
// Endpoints per tab:
//   Dashboard      → /api/finance-dashboard-counts?period=<>
//   Facturen       → /api/finance-invoices?status&entity&from&to&q&page&page_size
//   Abonnementen   → /api/sales-subscriptions-list?status&page&page_size
//                    (Finance-html heeft geen abo-tab; sales-subscriptions
//                     is de gedeelde bron)
//   Creditnota's   → /api/finance-creditnotes-list?q&from&to&page&page_size
//   Bank           → /api/finance-bank-camt-balance
//                    + /api/finance-bank-camt-transactions?direction&from&to&q&limit&offset
//   Omzet & MRR    → /api/super-admin-omzet?from&to&group_by
//                    (Finance-html heeft geen Omzet-tab; super-admin-omzet
//                     is de gedeelde bron van dashboard.html)
//
// Dormant. Preview ?v2preview=finance (rol super_admin/admin/manager/sales).

(function () {
  if (!window.DFO) { console.error('[finance-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[finance-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, F, setF } = window.DFO;
  const H = window.KV_V2.helpers;

  // HTML-escape helper — 1-op-1 met sales-v2 / leads-v2 / offerte-detail-v2
  // pattern. Fix ronde-5b: invoiceCreateModal riep esc() aan zonder dat het
  // in scope was → ReferenceError bij klik op 'Nieuwe factuur'. Nu lokaal.
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

  // ── State per tab ─────────────────────────────────────────────────────
  // Pager-state per tab: page (1-based) + page_size (default 50 op alle
  // lijst-tabs; user kan wisselen 25/50/100/500/1000).
  // _dash krijgt bal (camt-balance) parallel gefetcht zodat de Bank-saldo
  // KPI op het dashboard dezelfde bron gebruikt als de Bank-tab (dashboard-
  // counts.bankBalans is 0 wanneer aggregateActiveBankBalances geen active
  // rekeningen vindt; camt-statements zijn de correcte bron).
  // _sub krijgt mrrReport (sales-mrr-report) parallel zodat de MRR-KPI
  // altijd de billing_cycle-correcte som toont, ongeacht welke page van de
  // subs-lijst geladen is.
  const _dash = { loading: false, error: null, data: null, bal: null, seq: 0, period: '' };
  const _inv  = { loading: false, error: null, data: null, seq: 0, params: '', page: 1, pageSize: 50, search: '', dateFrom: '', dateTo: '' };
  const _sub  = { loading: false, error: null, data: null, mrrReport: null, seq: 0, params: '', page: 1, pageSize: 50, search: '', sortBy: 'end_date', sortDir: 'asc', filterExpiring: false };
  const _cn   = { loading: false, error: null, data: null, seq: 0, params: '', page: 1, pageSize: 50, search: '' };
  const _bnk  = { loading: false, error: null, bal: null, tx: null, seq: 0, params: '', page: 1, pageSize: 100, search: '', dateFrom: '', dateTo: '' };
  const _mrr  = { loading: false, error: null, report: null, seq: 0, params: '' };

  // ── SHARED HELPERS: stable-search + pagination ───────────────────────
  // Ronde 4: search-input via H.stableSearch (DOM-node persistent tussen
  // renders, cursor + focus behouden). H.onSearch registreert een debounced
  // handler die tabState updatet + refetch triggert. Handler wordt bij
  // elke view-call opnieuw geregistreerd (idempotent Map.set) zodat de
  // closure altijd de meest recente tabState-reference vasthoudt.
  function fnSearchKey(tabState) {
    return 'fin-' + (tabState === _inv ? 'inv' : tabState === _sub ? 'sub' : tabState === _cn ? 'cn' : tabState === _bnk ? 'bnk' : 'x');
  }
  function fnSearch(tabState, placeholder, refetchFn) {
    const key = fnSearchKey(tabState);
    // Sync shared registry met tabState.search zodat een vers-gemounte
    // input de juiste initiele waarde krijgt (bv na tab-terug-switch).
    if (H.getSearchValue(key) !== (tabState.search || '')) {
      H.setSearchValue(key, tabState.search || '');
    }
    H.onSearch(key, (val) => {
      tabState.search = val || '';
      tabState.page = 1;
      try { refetchFn(); } catch (e) { console.warn('[finance-v2] refetch onSearch:', e?.message); }
    }, { debounceMs: 280 });
    return H.stableSearch(key, placeholder);
  }

  // Pager-component. Zelfde signatuur voor alle tabs. total = server-side
  // aantal (null → hide pager). refetchFn wordt aangeroepen bij page-
  // of size-wissel.
  function fnPager(tabState, total, refetchFn) {
    const key = tabState === _inv ? 'inv' : tabState === _sub ? 'sub' : tabState === _cn ? 'cn' : tabState === _bnk ? 'bnk' : 'x';
    window['__fnPage_' + key] = (delta) => {
      const totalPages = Math.max(1, Math.ceil((total || 0) / tabState.pageSize));
      const next = Math.max(1, Math.min(totalPages, tabState.page + delta));
      if (next === tabState.page) return;
      tabState.page = next;
      refetchFn();
    };
    window['__fnSize_' + key] = (val) => {
      tabState.pageSize = Number(val) || 50;
      tabState.page = 1;
      refetchFn();
    };
    if (total == null) return '';
    const totalPages = Math.max(1, Math.ceil(total / tabState.pageSize));
    const from = (tabState.page - 1) * tabState.pageSize + 1;
    const to = Math.min(total, tabState.page * tabState.pageSize);
    return `<div class="kv-pager">
      <div class="kv-pager-info">${total === 0 ? '0 resultaten' : `${from}–${to} van ${num(total)}`}</div>
      <div class="kv-pager-ctl">
        <select class="kv-pager-size" onchange="__fnSize_${key}(this.value)">
          ${[25, 50, 100, 500, 1000].map(n => `<option value="${n}" ${tabState.pageSize === n ? 'selected' : ''}>${n} per pagina</option>`).join('')}
        </select>
        <button class="kv-pager-btn" onclick="__fnPage_${key}(-1)" ${tabState.page <= 1 ? 'disabled' : ''}>‹ Vorige</button>
        <span class="kv-pager-page">${tabState.page} / ${totalPages}</span>
        <button class="kv-pager-btn" onclick="__fnPage_${key}(1)" ${tabState.page >= totalPages ? 'disabled' : ''}>Volgende ›</button>
      </div>
    </div>`;
  }

  // Uncontrolled date-input met debounce (voor Bank + Facturen date-range).
  // Ronde 4: value= (echte HTML-attribuut, defaultValue was React-ism); +
  // onchange (native date-picker vuurt geen input tot commit op sommige
  // browsers). Cursor-issue speelt niet bij <input type=date>.
  const _dateDeb = {};
  function fnDate(tabState, field, refetchFn) {
    const key = tabState === _inv ? 'inv' : tabState === _bnk ? 'bnk' : 'x';
    const globalKey = '__fnDate_' + key + '_' + field;
    window[globalKey] = (val) => {
      tabState[field] = val;
      if (_dateDeb[globalKey]) clearTimeout(_dateDeb[globalKey]);
      _dateDeb[globalKey] = setTimeout(() => { tabState.page = 1; refetchFn(); }, 250);
    };
    const val = String(tabState[field] || '').replace(/"/g, '&quot;');
    return `<input type="date" class="fn-date-input" value="${val}" onchange="${globalKey}(this.value)">`;
  }

  async function tryFetch(label, url, timeoutMs = 8000) {
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      return await Promise.race([
        window.KV.authedJson(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
      ]);
    } catch (e) { console.warn('[finance-v2] fetch fail:', label, '→', e?.message || e); return null; }
  }

  const eur  = window.DFO.eur  || ((n) => n == null ? '—' : new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 }).format(n));
  const eur0 = window.DFO.eur0 || ((n) => n == null ? '—' : new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n));
  const eurC = (cents) => cents == null ? '—' : eur0(cents / 100);
  const dstr = (iso) => { if (!iso) return '—'; try { return new Date(iso).toLocaleDateString('nl-NL', { day: '2-digit', month: '2-digit', year: 'numeric' }); } catch { return '—'; } };
  const num  = (n) => n == null ? '—' : new Intl.NumberFormat('nl-NL').format(n);
  const isoDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString().slice(0, 10);
  const monthStart = () => { const d = new Date(); return isoDay(new Date(d.getFullYear(), d.getMonth(), 1)); };
  const todayIso = () => isoDay(new Date());

  // Preview-mode badge — VERWIJDERD (2026-08-11, consistent met sales-v2 +
  // leads-v2). Signature behouden zodat alle call-sites (Dashboard/Facturen/
  // Abonnementen/Creditnota's/Bank/Omzet-MRR) blijven werken zonder aanpassing.
  // Error-/loading-state is elders zichtbaar (per-tab "Laden…" placeholders
  // + toasts).
  function previewHeader(_label, _state) { return ''; }

  const INV_STATUS_TO_PILL = {
    open:                 ['info',    'Open'],
    partially_paid:       ['info',    'Deels betaald'],
    paid:                 ['ok',      'Betaald'],
    overdue:              ['warn',    'Vervallen'],
    credited:             ['neutral', 'Gecrediteerd'],
    partially_credited:   ['neutral', 'Deels gecrediteerd'],
    booked:               ['info',    'Geboekt'],
    draft:                ['neutral', 'Concept'],
  };
  const SUB_STATUS_TO_PILL = {
    active:    ['ok',      'Actief'],
    cancelled: ['neutral', 'Beëindigd'],
    paused:    ['warn',    'Gepauzeerd'],
  };

  // ── DASHBOARD ────────────────────────────────────────────────────────
  // Period-selector: Dag/Week/Maand/Kwartaal/Jaar (matcht endpoint waardes
  // today/week/month/quarter/year). Default = month (matcht finance.html).
  const PERIOD_LABEL_TO_PARAM = { Dag: 'today', Week: 'week', Maand: 'month', Kwartaal: 'quarter', Jaar: 'year' };
  async function fetchDashboard() {
    const label = F('fin-p', 'Maand');
    const period = PERIOD_LABEL_TO_PARAM[label] || 'month';
    if (_dash.loading && _dash.period === period) return;
    const seq = ++_dash.seq;
    _dash.loading = true; _dash.error = null; _dash.period = period;
    // FLICKER-FIX: geen loading-render (consistent met sales-v2 #1263).
    // Parallel: dashboard-counts + camt-balance. Ronde 4: dashboard-counts.
    // bankBalans komt uit aggregateActiveBankBalances (retourneert 0 als
    // geen active bank_accounts). CAMT-balance is de correcte bank-truth
    // (zelfde bron als Bank-tab).
    const [data, bal] = await Promise.all([
      tryFetch('finance-dashboard-counts', `/api/finance-dashboard-counts?period=${period}`),
      tryFetch('finance-bank-camt-balance', '/api/finance-bank-camt-balance'),
    ]);
    if (seq !== _dash.seq) return;
    _dash.data = data; _dash.bal = bal; _dash.loading = false;
    if (!data) _dash.error = 'Kon dashboard-counts niet laden';
    window.DFO.render();
  }

  function dashboardView() {
    const label = F('fin-p', 'Maand');
    const wantedPeriod = PERIOD_LABEL_TO_PARAM[label] || 'month';
    if (!_dash.loading && !_dash.error && (!_dash.data || _dash.period !== wantedPeriod)) queueMicrotask(fetchDashboard);
    const d = _dash.data || {};
    // Bank-saldo bron-preferentie: camt-balance (Bank-tab bron), fallback
    // op dashboard-counts.bankBalans (legacy). value in EUR (niet cents).
    const bal = _dash.bal || {};
    const bankValue = bal.balance_cents != null
      ? bal.balance_cents / 100
      : (d.bankBalans?.value != null ? d.bankBalans.value : null);
    const bankSub = bal.as_of_date
      ? `t/m ${dstr(bal.as_of_date)}`
      : (d.bankBalans?.accountCount ? `${d.bankBalans.accountCount} rekeningen` : '—');
    // Beschermde-zone-velden NIET renderen: actieveArrangements,
    // openVerifyPayment, openEscalations, joostStats, conversieWanbetalersFlow.
    return `${previewHeader('Dashboard', _dash)}
      ${H.kpis([
        { c: 'orange',  icon: I.euro,  label: 'Totaal openstaand',    val: eur0(d.totaalOpenstaand),          hi: 1, sub: `${num(d.openFacturen)} open · ${num(d.overdueFacturen)} vervallen` },
        // Bank-saldo: kleur-conditie op sign. Positief = groen (tegoed),
        // negatief = rose (overdraft), onbekend = blue. Ronde-5c wens
        // Jeffrey — visueel onmiddellijk zichtbaar of het klopt.
        { c: bankValue == null ? 'blue' : (bankValue > 0 ? 'emerald' : (bankValue < 0 ? 'rose' : 'blue')),
          icon: I.euro,  label: 'Bank-saldo',           val: bankValue == null ? '—' : eur0(bankValue), hi: 1, sub: bankSub },
        { c: 'emerald', icon: I.trend, label: 'MRR (subscriptions)',  val: eur0(d.mrrSubscriptions),          hi: 1, sub: 'actieve abonnementen' },
        { c: 'violet',  icon: I.repeat,label: 'Cashflow verwacht 30d',val: eur0(d.cashflowVerwacht30d),              sub: 'op basis van looptijden' },
      ])}
      ${H.toolbar([
        H.chips('fin-p', [
          { l: 'Dag',      v: 'Dag' },
          { l: 'Week',     v: 'Week' },
          { l: 'Maand',    v: 'Maand' },
          { l: 'Kwartaal', v: 'Kwartaal' },
          { l: 'Jaar',     v: 'Jaar' },
        ], label),
      ])}
      <div class="sv-grid">
        <div class="sv-card">
          <div class="sv-card-head">${svg(I.doc)}Kern-getallen</div>
          <div class="sv-card-body">
            <div class="sv-row"><span>Totaal openstaand</span><b>${eur0(d.totaalOpenstaand)}</b></div>
            <div class="sv-row"><span>Open facturen</span><b>${num(d.openFacturen)}</b></div>
            <div class="sv-row"><span>Vervallen facturen</span><b>${num(d.overdueFacturen)}</b></div>
            <div class="sv-row"><span>Cashflow verwacht 30d</span><b>${eur0(d.cashflowVerwacht30d)}</b></div>
          </div>
        </div>
        <div class="sv-card">
          <div class="sv-card-head">${svg(I.euro)}Bank · CAMT</div>
          <div class="sv-card-body">
            <div class="sv-row"><span>Actueel saldo</span><b>${bankValue == null ? '—' : eur0(bankValue)}</b></div>
            <div class="sv-row"><span>Peildatum</span><b>${bal.as_of_date ? dstr(bal.as_of_date) : '—'}</b></div>
            <div class="sv-row"><span>Bron</span><b>${bal.source ? 'CAMT · ' + num(bal.num_statements) + ' statements' : '—'}</b></div>
          </div>
        </div>
        <div class="sv-card">
          <div class="sv-card-head">${svg(I.repeat)}Recurring</div>
          <div class="sv-card-body">
            <div class="sv-row"><span>MRR (abonnementen)</span><b>${eur0(d.mrrSubscriptions)}</b></div>
            <div class="sv-row"><span>Mentor-bonus openstaand</span><b>${eur0(d.mentorBonusPending)}</b></div>
          </div>
        </div>
      </div>`;
  }

  // ── FACTUREN ─────────────────────────────────────────────────────────
  // NEW (data-ronde 2): v2 create-invoice-modal met concept-only save.
  // Boek/verzend routeren naar oude finance.html (te complex + destructief
  // voor v2-ronde-2). Guard-patroon: gebruiker moet 'CONCEPT' intypen
  // voordat opslaan-knop enabled wordt.
  // Ronde 5: modal-open leeft in module-state (was URL-param). URL-param
  // pad had een timing/edge-case waardoor modal niet opende in preview —
  // module-state is robuuster (geen history-race, geen URL-persistence).
  const _newInv = {
    open: false,
    submitting: false,
    entities: null, entLoading: false,
    customers: [], custLoading: false, custQuery: '', custPickedName: '',
    form: {
      customer_id: '',
      department_id: '',
      purchase_order_number: '',
      language: 'nl',
      lines: [{ description: '', quantity: 1, unit_price_excl: 0, vat_percentage: 21 }],
    },
    guardTyped: '',
  };

  window.__finInvNew  = async () => {
    // BROK FINANCE-INVOICE (2026-08-19): route naar unified invoice-create.js
    // modal (dezelfde als klant-detail-tab). Zonder customer-arg opent 'ie
    // met de klant-selector bovenaan. Oude inline `invoiceCreateModal()`
    // + `_newInv`-state hierbeneden zijn dead-code — kunnen weg in
    // vervolg-cleanup-brok.
    try {
      const mod = await import('./modals/invoice-create.js?v=7');
      mod.openInvoiceCreateModal({
        onSuccess: () => {
          if (typeof window.__finLoadInv === 'function') window.__finLoadInv();
        },
      });
    } catch (e) {
      console.error('[finance-v2] invoice-create modal fail:', e);
      if (window.KV && window.KV.toast) window.KV.toast('Kon factuur-modal niet laden');
    }
  };
  window.__finInvNewClose = () => {
    _newInv.open = false;
    // Reset form-state zodat volgende open schoon is.
    _newInv.form = { customer_id: '', department_id: '', purchase_order_number: '', language: 'nl', lines: [{ description: '', quantity: 1, unit_price_excl: 0, vat_percentage: 21 }] };
    _newInv.custQuery = ''; _newInv.custPickedName = ''; _newInv.customers = []; _newInv.guardTyped = '';
    if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render();
  };
  window.__finInvOpen = (tlId) => { if (tlId) window.location.href = '/modules/finance.html?tab=facturen&invoice=' + encodeURIComponent(tlId); };

  function urlParam(k) { try { return new URLSearchParams(location.search).get(k); } catch { return null; } }
  function setUrlParam(k, v) {
    try {
      const u = new URL(location.href);
      if (v == null || v === '') u.searchParams.delete(k); else u.searchParams.set(k, v);
      history.pushState({}, '', u.toString());
    } catch (_) { /* noop */ }
    if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render();
  }

  async function tryPost(label, url, body, timeoutMs = 15000) {
    if (!window.KV || !window.KV.authedFetch) throw new Error('KV.authedFetch niet beschikbaar');
    const resp = await Promise.race([
      window.KV.authedFetch(url, { method: 'POST', body: JSON.stringify(body) }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
    const text = await resp.text();
    const json = text ? JSON.parse(text) : null;
    if (!resp.ok) { console.warn('[finance-v2] post fail:', label, '→', json?.error || resp.status); throw new Error((json && (json.error || json.message)) || 'HTTP ' + resp.status); }
    return json;
  }

  async function fetchEntities() {
    if (_newInv.entities || _newInv.entLoading) return;
    _newInv.entLoading = true;
    const data = await tryFetch('company-entities', '/api/company-entities');
    _newInv.entLoading = false;
    _newInv.entities = data?.items || [];
    if (_newInv.entities.length && !_newInv.form.department_id) {
      _newInv.form.department_id = _newInv.entities[0].tl_department_id;
    }
    window.DFO.render();
  }

  let _custSearchDeb = null;
  window.__finCustSearch = (q) => {
    _newInv.custQuery = q;
    _newInv.custPickedName = ''; _newInv.form.customer_id = '';
    if (_custSearchDeb) clearTimeout(_custSearchDeb);
    _custSearchDeb = setTimeout(async () => {
      if (!q || q.length < 2) { _newInv.customers = []; window.DFO.render(); return; }
      _newInv.custLoading = true;
      window.DFO.render();
      const data = await tryFetch('sales-customers-search', '/api/sales-customers?search=' + encodeURIComponent(q));
      _newInv.customers = data?.items || data?.customers || [];
      _newInv.custLoading = false;
      window.DFO.render();
    }, 300);
  };
  window.__finCustPick = (id, name) => {
    _newInv.form.customer_id = id;
    _newInv.custPickedName = name;
    _newInv.customers = [];
    _newInv.custQuery = name;
    window.DFO.render();
  };

  window.__finInvFormInput = (field, val) => { _newInv.form[field] = val; };
  window.__finLineInput = (idx, field, val) => {
    if (!_newInv.form.lines[idx]) return;
    _newInv.form.lines[idx][field] = (field === 'quantity' || field === 'unit_price_excl' || field === 'vat_percentage') ? Number(val) || 0 : val;
  };
  window.__finLineAdd = () => {
    _newInv.form.lines.push({ description: '', quantity: 1, unit_price_excl: 0, vat_percentage: 21 });
    window.DFO.render();
  };
  window.__finLineRemove = (idx) => {
    if (_newInv.form.lines.length <= 1) return;
    _newInv.form.lines.splice(idx, 1);
    window.DFO.render();
  };
  window.__finGuardInput = (v) => { _newInv.guardTyped = v; window.DFO.render(); };

  window.__finInvSubmitDraft = async () => {
    if (_newInv.submitting) return;
    const f = _newInv.form;
    if (!f.customer_id) { alert('Kies een klant.'); return; }
    if (!f.department_id) { alert('Kies een entiteit.'); return; }
    if (!f.lines.length || !f.lines.every(l => l.description && l.unit_price_excl != null)) {
      alert('Elke regel heeft omschrijving + bedrag nodig.');
      return;
    }
    if (_newInv.guardTyped !== 'CONCEPT') {
      alert('Typ "CONCEPT" in het bevestigingsveld om op te slaan.');
      return;
    }
    _newInv.submitting = true;
    window.DFO.render();
    try {
      const result = await tryPost('finance-invoice-create', '/api/finance-invoice-create', {
        customer_id: f.customer_id,
        department_id: f.department_id,
        purchase_order_number: f.purchase_order_number || null,
        language: f.language || 'nl',
        lines: f.lines,
        action: 'draft',
      });
      _newInv.submitting = false;
      _newInv.guardTyped = '';
      window.__finInvNewClose();
      _inv.data = null; _dash.data = null;
      window.DFO.render();
      alert('Concept-factuur aangemaakt' + (result?.tl_invoice_id ? ' (TL: ' + result.tl_invoice_id + ')' : '') + '. Boeken/verzenden gebeurt in het oude scherm.');
    } catch (e) {
      _newInv.submitting = false;
      window.DFO.render();
      alert('Aanmaak mislukt: ' + (e?.message || 'onbekende fout'));
    }
  };

  function invoiceCreateModal() {
    // Trigger entities-fetch bij eerste render.
    if (!_newInv.entities && !_newInv.entLoading) queueMicrotask(fetchEntities);
    const f = _newInv.form;
    const dis = _newInv.submitting ? ' disabled' : '';
    const guardOk = _newInv.guardTyped === 'CONCEPT';
    const lineTotal = (l) => (Number(l.quantity) || 0) * (Number(l.unit_price_excl) || 0);
    const totalExcl = f.lines.reduce((a, l) => a + lineTotal(l), 0);
    const totalIncl = f.lines.reduce((a, l) => a + lineTotal(l) * (1 + (Number(l.vat_percentage) || 0) / 100), 0);
    return `<div class="fn-modal-back" onclick="if(event.target===this)__finInvNewClose()">
      <div class="fn-modal">
        <div class="fn-modal-head">
          <div class="fn-modal-title">Nieuwe factuur (concept)</div>
          <button class="icon-btn" onclick="__finInvNewClose()" title="Sluiten (Esc)">${svg(I.x || I.warn)}</button>
        </div>
        <div class="fn-modal-body">

          <label class="tk-field">
            <span class="tk-field-l">Klant <span class="tk-req">*</span></span>
            <div class="fn-cust-picker">
              <input class="ib-input" placeholder="Typ naam of e-mail (min. 2 tekens)…" value="${esc(_newInv.custQuery)}" oninput="__finCustSearch(this.value)"${dis}>
              ${_newInv.customers.length ? `<div class="fn-cust-dd">
                ${_newInv.customers.slice(0, 8).map(c => `
                  <div class="fn-cust-dd-item" onclick="__finCustPick('${c.id}', ${JSON.stringify(esc(c.name || c.display_name || '?'))})">
                    <div class="fn-cust-dd-item-name">${esc(c.name || c.display_name || '?')}</div>
                    <div class="fn-cust-dd-item-email">${esc(c.email || c.company_name || '')}</div>
                  </div>
                `).join('')}
              </div>` : ''}
              ${_newInv.custLoading ? `<div style="font-size:11.5px;color:var(--text-3);margin-top:4px">Zoeken…</div>` : ''}
              ${_newInv.form.customer_id ? `<div style="font-size:11.5px;color:var(--brand);margin-top:4px">✓ ${esc(_newInv.custPickedName)} gekozen</div>` : ''}
            </div>
          </label>

          <div class="tk-field-row">
            <label class="tk-field">
              <span class="tk-field-l">Entiteit <span class="tk-req">*</span></span>
              <select class="ib-input" onchange="__finInvFormInput('department_id', this.value)"${dis}>
                ${_newInv.entities ? _newInv.entities.map(e => `<option value="${e.tl_department_id}" ${f.department_id === e.tl_department_id ? 'selected' : ''}>${esc(e.label || e.name)}</option>`).join('') : '<option>Laden…</option>'}
              </select>
            </label>
            <label class="tk-field">
              <span class="tk-field-l">PO-nummer (optioneel)</span>
              <input class="ib-input" placeholder="bv. PO-2026-0042" value="${esc(f.purchase_order_number)}" oninput="__finInvFormInput('purchase_order_number', this.value)"${dis}>
            </label>
            <label class="tk-field">
              <span class="tk-field-l">Taal</span>
              <select class="ib-input" onchange="__finInvFormInput('language', this.value)"${dis}>
                <option value="nl" ${f.language === 'nl' ? 'selected' : ''}>Nederlands</option>
                <option value="en" ${f.language === 'en' ? 'selected' : ''}>Engels</option>
                <option value="fr" ${f.language === 'fr' ? 'selected' : ''}>Frans</option>
              </select>
            </label>
          </div>

          <div class="tk-field">
            <span class="tk-field-l">Regels <span class="tk-req">*</span></span>
            <div class="fn-lines">
              ${f.lines.map((l, i) => `
                <div class="fn-line-row">
                  <input placeholder="Omschrijving" value="${esc(l.description)}" oninput="__finLineInput(${i}, 'description', this.value)"${dis}>
                  <input type="number" step="1" min="0" placeholder="Aantal" value="${l.quantity}" oninput="__finLineInput(${i}, 'quantity', this.value)"${dis}>
                  <input type="number" step="0.01" min="0" placeholder="Prijs excl." value="${l.unit_price_excl}" oninput="__finLineInput(${i}, 'unit_price_excl', this.value)"${dis}>
                  <input type="number" step="1" min="0" max="100" placeholder="BTW %" value="${l.vat_percentage}" oninput="__finLineInput(${i}, 'vat_percentage', this.value)"${dis}>
                  <button class="fn-line-remove" onclick="__finLineRemove(${i})" title="Regel verwijderen" ${f.lines.length <= 1 ? 'disabled' : ''}>×</button>
                </div>
              `).join('')}
              <button class="fn-line-add" onclick="__finLineAdd()"${dis}>+ Regel toevoegen</button>
            </div>
            <div style="display:flex;justify-content:flex-end;gap:14px;font-size:12.5px;color:var(--text-2);margin-top:8px">
              <span>Totaal excl. BTW: <b class="mono">${eur(totalExcl)}</b></span>
              <span>Totaal incl. BTW: <b class="mono">${eur(totalIncl)}</b></span>
            </div>
          </div>

          <div class="fn-guard">
            ${svg(I.warn)}
            <span style="flex:1">Deze factuur wordt aangemaakt als <b>concept</b> in Teamleader. Boeken + verzenden gebeurt in het oude scherm (na review). Typ <b>CONCEPT</b> om op te slaan:</span>
            <input class="fn-guard-input" placeholder="typ hier CONCEPT" value="${esc(_newInv.guardTyped)}" oninput="__finGuardInput(this.value)"${dis}>
          </div>
        </div>
        <div class="fn-modal-foot">
          <button class="btn" onclick="__finInvNewClose()"${dis}>Annuleren</button>
          <button class="btn btn-primary" onclick="__finInvSubmitDraft()" ${dis || (!guardOk ? 'disabled' : '')}>
            ${_newInv.submitting ? svg(I.clock || I.settings) + 'Bezig…' : svg(I.check || I.plus) + 'Concept opslaan'}
          </button>
        </div>
      </div>
    </div>`;
  }

  // Esc-key sluit modal.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (_newInv.open) { e.preventDefault(); window.__finInvNewClose(); }
  });
  window.addEventListener('popstate', () => {
    if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render();
  });

  function invoicesParams() {
    const st = F('fin-inv-st', 'all');
    const p = new URLSearchParams();
    if (st && st !== 'all') p.set('status', st);
    if (_inv.search) p.set('q', _inv.search);
    if (_inv.dateFrom) p.set('period_start', _inv.dateFrom);
    if (_inv.dateTo)   p.set('period_end',   _inv.dateTo);
    p.set('page', String(_inv.page || 1));
    p.set('page_size', String(_inv.pageSize || 50));
    return p.toString();
  }
  async function fetchInvoices() {
    const wanted = invoicesParams();
    if (_inv.loading && _inv.params === wanted) return;
    const seq = ++_inv.seq;
    _inv.loading = true; _inv.error = null; _inv.params = wanted;
    // FLICKER-FIX: geen loading-render (consistent met sales-v2 #1263).
    const data = await tryFetch('finance-invoices', '/api/finance-invoices?' + wanted);
    if (seq !== _inv.seq) return;
    _inv.data = data; _inv.loading = false;
    if (!data) _inv.error = 'Kon facturen niet laden';
    window.DFO.render();
  }

  // Row-click: hele rij klikbaar → v2 factuur-detail in-shell.
  window.__finInvRowClick = (i) => {
    const v = (_inv.data && _inv.data.items && _inv.data.items[i]) || null;
    if (v && v.id && typeof window.__fnInvOpen === 'function') window.__fnInvOpen(v.id);
  };
  // Expose voor finance-detail-v2 (lookup zonder extra fetch bij factuur-detail).
  window.__finGetInvById = (id) => (_inv.data?.items || []).find(x => String(x.id) === String(id)) || null;

  // BROK F3 (2026-08-19): client-side kolom-sort op de facturenlijst.
  // Zelfde patroon als wanbetalers-Overzicht sort: klikbare headers,
  // asc/desc-toggle, lege/null altijd onderaan, surgical repaint waar
  // mogelijk (H.table interpoleert echter alles → we vertrouwen op
  // shell-render-cycle voor de kolom-sort; scroll-behoud niet nodig
  // omdat de tabel géén eigen scroll-container heeft).
  _inv.sortBy  = _inv.sortBy  || 'issue_date';
  _inv.sortDir = _inv.sortDir || 'desc';
  window.__finInvSort = (key) => {
    if (_inv.sortBy === key) _inv.sortDir = _inv.sortDir === 'asc' ? 'desc' : 'asc';
    else { _inv.sortBy = String(key || 'issue_date'); _inv.sortDir = key === 'customer_name' || key === 'invoice_number' ? 'asc' : 'desc'; }
    window.DFO.render();
  };
  function _sortedInvoices(items) {
    const key = _inv.sortBy;
    const dir = _inv.sortDir === 'asc' ? 1 : -1;
    return items.slice().sort((a, b) => {
      if (key === 'invoice_number' || key === 'customer_name') {
        return dir * String(a[key] || '').localeCompare(String(b[key] || ''));
      }
      if (key === 'issue_date' || key === 'due_date') {
        const ta = a[key] ? Date.parse(a[key]) : null;
        const tb = b[key] ? Date.parse(b[key]) : null;
        if (ta == null && tb == null) return 0;
        if (ta == null) return 1;
        if (tb == null) return -1;
        return dir * (ta - tb);
      }
      const va = Number(a[key]) || 0;
      const vb = Number(b[key]) || 0;
      return dir * (va - vb);
    });
  }
  function _invSortHdr(label, key, rightAlign) {
    const active = _inv.sortBy === key;
    const arrow = active ? (_inv.sortDir === 'asc' ? ' ↑' : ' ↓') : '';
    const color = active ? 'var(--brand)' : 'inherit';
    return `<span style="cursor:pointer;user-select:none;color:${color}" onclick="__finInvSort('${key}')" title="Sorteer op ${label}">${label}${arrow}</span>`;
  }

  function invoicesView() {
    // In-shell factuur-detail: als URL invoice_id, delegeer aan finance-detail-v2.
    try {
      const iid = new URLSearchParams(location.search).get('invoice_id');
      if (iid && typeof window.__fnRenderInv === 'function') return window.__fnRenderInv(iid);
    } catch (_) { /* fall through */ }
    const st = F('fin-inv-st', 'all');
    if (!_inv.loading && !_inv.error && (!_inv.data || _inv.params !== invoicesParams())) queueMicrotask(fetchInvoices);
    const items = _sortedInvoices(_inv.data?.items || []);
    const k = _inv.data?.kpis || {};
    const total = _inv.data?.total ?? null;
    return `${previewHeader('Facturen', _inv)}
      ${H.kpis([
        { c: 'orange',  icon: I.euro,  label: 'Openstaand (excl. gecrediteerd)', val: eur0(k.open_total),       hi: 1, sub: `${num(k.open_count)} facturen` },
        { c: 'warn',    icon: I.warn,  label: 'Vervallen',                       val: eur0(k.overdue_total),           sub: `${num(k.overdue_count)} facturen` },
        { c: 'emerald', icon: I.check, label: 'Betaald deze maand',              val: eur0(k.month_in_total),          sub: `${num(k.month_in_count)} betalingen` },
        { c: 'blue',    icon: I.clock, label: 'Gem. betaaltijd',                 val: k.avg_pay_days != null ? Math.round(k.avg_pay_days) + ' d' : '—', sub: 'laatste 90d' },
      ])}
      ${H.toolbar([
        H.chips('fin-inv-st', [
          { l: 'Alle',           v: 'all' },
          { l: 'Open',           v: 'open' },
          { l: 'Te laat',        v: 'overdue' },
          { l: 'Betaald',        v: 'paid' },
          { l: 'Gecrediteerd',   v: 'credited' },
        ], st),
        fnSearch(_inv, 'Zoek factuur-nr / klant…', fetchInvoices),
        `<div class="fn-daterange">Van ${fnDate(_inv, 'dateFrom', fetchInvoices)} tot ${fnDate(_inv, 'dateTo', fetchInvoices)}</div>`,
        `<div class="tb-right"><button class="btn btn-primary" onclick="__finInvNew()">${svg(I.plus)}Nieuwe factuur</button></div>`,
      ])}
      ${fnPager(_inv, total, fetchInvoices)}
      ${H.table(
        [
          { l: _invSortHdr('Factuur-nr', 'invoice_number') },
          { l: _invSortHdr('Klant',       'customer_name') },
          { l: _invSortHdr('Uitgifte',    'issue_date'), cls: 'r optional' },
          { l: _invSortHdr('Vervaldatum', 'due_date'),   cls: 'r optional' },
          { l: _invSortHdr('Totaal',      'amount_total'), cls: 'r' },
          { l: _invSortHdr('Open',        'amount_open'),  cls: 'r' },
          { l: 'Status' },
        ],
        items.map(v => {
          const [c, l] = INV_STATUS_TO_PILL[v.display_status] || INV_STATUS_TO_PILL[v.status] || ['neutral', v.display_status || v.status || '—'];
          return [
            `<span class="sv-off-nr">${v.invoice_number || ('#' + String(v.id || '').slice(0, 8))}</span>`,
            `<div class="cell-main-wrap"><div class="av av-sm">${H.av(v.customer_name || '?')}</div><span class="cell-main">${v.customer_name || '—'}</span></div>`,
            `<span class="mono" style="font-size:12.5px;color:var(--text-3)">${dstr(v.issue_date)}</span>`,
            `<span class="mono" style="font-size:12.5px;color:var(--text-3)">${dstr(v.due_date)}</span>`,
            `<span class="mono">${eur(v.amount_total)}</span>`,
            `<span class="mono ${(v.amount_open || 0) > 0 ? 'strong' : ''}">${eur(v.amount_open)}</span>`,
            H.pill(c, l),
          ];
        }),
        '__finInvRowClick'
      )}
      ${fnPager(_inv, total, fetchInvoices)}
      ${!items.length && !_inv.loading ? `<div class="sv-empty">${_inv.error || 'Geen facturen met deze filters.'}</div>` : ''}
      ${_newInv.open ? invoiceCreateModal() : ''}`;
  }

  // ── ABONNEMENTEN ─────────────────────────────────────────────────────
  function subsParams() {
    const st = F('fin-sub-st', 'active');
    const p = new URLSearchParams();
    if (st && st !== 'all') p.set('status', st);
    p.set('page', String(_sub.page || 1));
    p.set('page_size', String(_sub.pageSize || 50));
    return p.toString();
  }
  window.__finSubSort = (by) => {
    if (_sub.sortBy === by) _sub.sortDir = _sub.sortDir === 'asc' ? 'desc' : 'asc';
    else { _sub.sortBy = by; _sub.sortDir = 'asc'; }
    window.DFO.render();
  };
  window.__finSubExpiring = () => { _sub.filterExpiring = !_sub.filterExpiring; window.DFO.render(); };
  window.__finSubNew = () => {
    // V2 in-shell subscription-wizard (2026-08-12) — sales-wizard-v2-pattern.
    // Fallback naar v1 als de v2-handler nog niet geladen is (bv. bij
    // eerste page-load in oude cache).
    if (typeof window.__subwOpen === 'function') { window.__subwOpen({}); return; }
    window.location.href = '/modules/subscription-wizard.html';
  };
  async function fetchSubs() {
    const wanted = subsParams();
    if (_sub.loading && _sub.params === wanted) return;
    const seq = ++_sub.seq;
    _sub.loading = true; _sub.error = null; _sub.params = wanted;
    // FLICKER-FIX: geen loading-render (consistent met sales-v2 #1263).
    // Parallel: list (voor tabel) + mrr-report (voor MRR-KPI, billing_cycle-
    // correct). mrr-report is licht (1 tabel-scan) en geeft ons kpis.current_mrr.
    const [data, report] = await Promise.all([
      tryFetch('sales-subscriptions-list', '/api/sales-subscriptions-list?' + wanted),
      tryFetch('sales-mrr-report', '/api/sales-mrr-report'),
    ]);
    if (seq !== _sub.seq) return;
    _sub.data = data; _sub.mrrReport = report; _sub.loading = false;
    if (!data) _sub.error = 'Kon abonnementen niet laden';
    window.DFO.render();
  }

  // Client-side MRR helper (fallback voor per-row weergave in de lijst).
  // Officiele MRR-KPI komt uit sales-mrr-report (kpis.current_mrr) omdat
  // billing_cycle NIET in sales-subscriptions-list response zit — daarom
  // gaven eerdere pogingen 0/NaN. Hier gebruiken we amount_incl (per term
  // incl-BTW som van line_items) + heuristiek op basis van start/end voor
  // months-per-term. Voor sub met end_date=null (open-ended) valt terug
  // op maandelijks (per_term_months=1) wat het gewone geval is.
  function subMonthlyIncl(s) {
    const perTerm = Number(s.amount_incl) || Number(s.per_term_incl) || Number(s.per_term_excl) || 0;
    if (!perTerm) return 0;
    // Heuristiek: totale-looptijd-maanden / term_count = months per termijn.
    const tc = Number(s.term_count) || 1;
    if (s.start_date && s.end_date && tc > 0) {
      const sd = new Date(s.start_date);
      const ed = new Date(s.end_date);
      if (!isNaN(sd) && !isNaN(ed) && ed > sd) {
        const months = (ed.getFullYear() - sd.getFullYear()) * 12 + (ed.getMonth() - sd.getMonth()) + 1;
        const perTermMonths = Math.max(1, Math.round(months / tc));
        return perTerm / perTermMonths;
      }
    }
    // Fallback: assume monthly (per_term_months=1). Sub-per-jaar/kwartaal
    // zonder end_date tellen te zwaar mee — daarom is de KPI uit mrr-report
    // de source of truth. Deze helper is alleen voor per-row weergave.
    return perTerm;
  }

  // Row-click: hele rij klikbaar → v2 abonnement-detail in-shell.
  window.__finSubRowClick = (i) => {
    // 'items' hier is post-filter/sort; we passeren de index van de gefilterde
    // lijst, dus lookup gebeurt via de index-in-view. subsView re-berekent
    // items uit _sub.data + filter/search; simpelste: gebruik id-string
    // via een sidechannel-cache. Fallback: eerste hit met id-match.
    const shownItems = window.__finSubShown || [];
    const s = shownItems[i] || null;
    if (s && s.id && typeof window.__fnSubOpen === 'function') window.__fnSubOpen(s.id);
  };
  // Expose per-id lookup voor finance-detail-v2 (skipt de fetch als lijst
  // al geladen is).
  window.__finGetSubById = (id) => {
    const all = _sub.data?.items || [];
    return all.find(x => String(x.id) === String(id)) || null;
  };

  function subsView() {
    // In-shell abonnement-detail: als URL subscription_id, delegeer aan finance-detail-v2.
    try {
      const sid = new URLSearchParams(location.search).get('subscription_id');
      if (sid && typeof window.__fnRenderSub === 'function') return window.__fnRenderSub(sid);
    } catch (_) { /* fall through */ }
    const st = F('fin-sub-st', 'active');
    if (!_sub.loading && !_sub.error && (!_sub.data || _sub.params !== subsParams())) queueMicrotask(fetchSubs);
    let items = (_sub.data?.items || []).slice();
    const total = _sub.data?.total ?? null;

    // Client-side search (over customer-name + description + entity).
    // Ronde 4: defensief — String(x ?? '').toLowerCase() zodat een missende
    // customer/entity nooit een throw geeft (crashte eerder de hele lijst).
    if (_sub.search) {
      const q = String(_sub.search).toLowerCase();
      items = items.filter(s => {
        const name = String(s?.customer?.name ?? s?.customer_name ?? '').toLowerCase();
        const desc = String(s?.description ?? '').toLowerCase();
        const ent  = String(s?.entity ?? '').toLowerCase();
        return name.includes(q) || desc.includes(q) || ent.includes(q);
      });
    }
    // Filter: loopt af binnen 30 dagen (active + end_date <= today+30).
    if (_sub.filterExpiring) {
      const now = Date.now();
      const thr = now + 30 * 86400000;
      items = items.filter(s => {
        if (s.status !== 'active') return false;
        if (!s.end_date) return false;
        const t = new Date(s.end_date).getTime();
        return !isNaN(t) && t >= now && t <= thr;
      });
    }
    // Client-side sort — nu voor ALLE kolommen. Numerieke (per_termijn /
    // maand_incl) doen number-compare; datum-kolommen (start_date /
    // end_date / created_at) doen ISO-string-compare (equivalent aan
    // date-compare); tekst-kolommen (customer_name / description / entity /
    // status) doen lowercase localeCompare.
    if (_sub.sortBy) {
      const dir = _sub.sortDir === 'asc' ? 1 : -1;
      const getter = (row) => {
        switch (_sub.sortBy) {
          case 'customer_name': return String(row?.customer?.name ?? row?.customer_name ?? '').toLowerCase();
          case 'description':   return String(row?.description ?? '').toLowerCase();
          case 'entity':        return String(row?.entity ?? '').toLowerCase();
          case 'per_termijn':   return Number(row?.amount_incl ?? row?.per_term_incl ?? row?.per_term_excl ?? 0);
          case 'maand_incl':    return subMonthlyIncl(row);
          case 'start_date':    return String(row?.start_date ?? '');
          case 'end_date':      return String(row?.end_date ?? '');
          case 'status':        return String(row?.status ?? '');
          case 'created_at':    return String(row?.created_at ?? '');
          default:              return '';
        }
      };
      items.sort((a, b) => {
        const va = getter(a), vb = getter(b);
        if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
        return String(va).localeCompare(String(vb)) * dir;
      });
    }

    const activeItems = items.filter(s => (s.status || '') === 'active');
    // MRR-KPI bron-preferentie: sales-mrr-report.kpis.current_mrr (billing_
    // cycle-correct). Fallback op client-side som (per-row heuristiek).
    const reportKpis = _sub.mrrReport?.kpis || null;
    const mrrOfficial = reportKpis?.current_mrr != null ? Number(reportKpis.current_mrr) : null;
    const mrrLocal = activeItems.reduce((a, s) => a + subMonthlyIncl(s), 0);
    const mrrShown = mrrOfficial != null ? mrrOfficial : mrrLocal;
    const activeCountOfficial = reportKpis?.active_count != null ? reportKpis.active_count : null;
    const sortIcon = (col) => _sub.sortBy === col ? (_sub.sortDir === 'asc' ? ' ▲' : ' ▼') : '';

    return `${previewHeader('Abonnementen · sales-subscriptions + mrr-report', _sub)}
      ${H.kpis([
        { c: 'emerald', icon: I.check,  label: 'Actief (totaal)',        val: num(activeCountOfficial != null ? activeCountOfficial : activeItems.length), hi: 1, sub: 'over alle pagina\'s' },
        { c: 'violet',  icon: I.trend,  label: 'Huidige MRR incl. BTW',   val: eur0(mrrShown), hi: 1, sub: mrrOfficial != null ? 'sales-mrr-report' : 'lokale schatting (fallback)' },
        { c: 'blue',    icon: I.repeat, label: 'Totaal in view',         val: num(items.length), sub: total != null ? `van ${num(total)} totaal` : '—' },
      ])}
      ${H.toolbar([
        H.chips('fin-sub-st', [
          { l: 'Alle',       v: 'all' },
          { l: 'Actief',     v: 'active' },
          { l: 'Gepauzeerd', v: 'paused' },
          { l: 'Beëindigd',  v: 'cancelled' },
        ], st),
        fnSearch(_sub, 'Zoek klant / beschrijving / entiteit…', fetchSubs),
        `<div class="tb-right">
          <button class="btn ${_sub.filterExpiring ? 'btn-primary' : ''}" onclick="__finSubExpiring()">${svg(I.warn)}Loopt af &lt;30d</button>
          <button class="btn btn-primary" onclick="__finSubNew()">${svg(I.plus)}Nieuw abonnement</button>
        </div>`,
      ])}
      ${fnPager(_sub, total, fetchSubs)}
      ${(() => { window.__finSubShown = items; return ''; })()}
      ${(() => {
        // Sortable header helper — label + arrow + click-handler naar
        // __finSubSort. Cursor:pointer + subtiele hover-hint via title.
        const sh = (col, label) => `<span onclick="event.stopPropagation();__finSubSort('${col}')" style="cursor:pointer;user-select:none" title="Sorteer op ${label}">${label}${sortIcon(col)}</span>`;
        return H.table(
          [
            { l: sh('customer_name', 'Klant') },
            { l: sh('description', 'Beschrijving'), cls: 'optional' },
            { l: sh('entity',      'Entiteit'),     cls: 'optional' },
            { l: sh('per_termijn', 'Per termijn'),  cls: 'r' },
            { l: sh('maand_incl',  'Maand incl.'),  cls: 'r' },
            { l: sh('start_date',  'Start'),        cls: 'r optional' },
            { l: sh('end_date',    'Eind'),         cls: 'r optional' },
            { l: sh('created_at',  'Toegevoegd'),   cls: 'r optional' },
            { l: sh('status',      'Status') },
          ],
          items.map(s => {
            const cName = String(s?.customer?.name ?? s?.customer_name ?? '—');
            const [c, l] = SUB_STATUS_TO_PILL[s.status] || ['neutral', s.status || '—'];
            // amount_incl = incl-BTW som per termijn (sales-subscriptions-list).
            const perTerm = s?.amount_incl != null ? s.amount_incl : s?.per_term_incl;
            return [
              `<div class="cell-main-wrap"><div class="av av-sm">${H.av(cName)}</div><span class="cell-main">${cName}</span></div>`,
              `<span style="font-size:12.5px;color:var(--text-3)">${s.description || '—'}</span>`,
              `<span style="font-size:12.5px;color:var(--text-3)">${s.entity || '—'}</span>`,
              `<span class="mono">${eur(perTerm)}</span>`,
              `<span class="mono">${eur0(subMonthlyIncl(s))}</span>`,
              `<span class="mono" style="font-size:12.5px;color:var(--text-3)">${dstr(s.start_date)}</span>`,
              `<span class="mono" style="font-size:12.5px;color:var(--text-3)">${dstr(s.end_date)}</span>`,
              `<span class="mono" style="font-size:12.5px;color:var(--text-3)">${dstr(s.created_at)}</span>`,
              H.pill(c, l),
            ];
          }),
          '__finSubRowClick'
        );
      })()}
      ${fnPager(_sub, total, fetchSubs)}
      ${!items.length && !_sub.loading ? `<div class="sv-empty">${_sub.error || 'Geen abonnementen met deze filter.'}</div>` : ''}`;
  }

  // ── CREDITNOTA'S ─────────────────────────────────────────────────────
  function cnParams() {
    const p = new URLSearchParams();
    if (_cn.search) p.set('q', _cn.search);
    p.set('page', String(_cn.page || 1));
    p.set('page_size', String(_cn.pageSize || 50));
    return p.toString();
  }
  async function fetchCn() {
    const wanted = cnParams();
    if (_cn.loading && _cn.params === wanted) return;
    const seq = ++_cn.seq;
    _cn.loading = true; _cn.error = null; _cn.params = wanted;
    // FLICKER-FIX: geen loading-render (consistent met sales-v2 #1263).
    const data = await tryFetch('finance-creditnotes-list', '/api/finance-creditnotes-list?' + wanted);
    if (seq !== _cn.seq) return;
    _cn.data = data; _cn.loading = false;
    if (!data) _cn.error = 'Kon creditnota\'s niet laden';
    window.DFO.render();
  }

  function cnView() {
    if (!_cn.loading && !_cn.error && (!_cn.data || _cn.params !== cnParams())) queueMicrotask(fetchCn);
    const items = _cn.data?.items || [];
    const kpi = _cn.data?.kpi || {};
    const total = _cn.data?.total ?? null;
    return `${previewHeader("Creditnota's", _cn)}
      ${H.kpis([
        { c: 'violet',  icon: I.doc,   label: 'Aantal creditnota\'s', val: num(kpi.count),      hi: 1 },
        { c: 'orange',  icon: I.euro,  label: 'Som bedragen',         val: eur0(kpi.sum_amount), hi: 1 },
      ])}
      ${H.toolbar([
        fnSearch(_cn, 'Zoek creditnota-nr / klant…', fetchCn),
      ])}
      ${fnPager(_cn, total, fetchCn)}
      <div class="kv-cn-readonly-tbl">
        ${H.table(
          [{ l: 'Creditnota-nr' }, { l: 'Klant' }, { l: 'Bij factuur', cls: 'optional' }, { l: 'Datum', cls: 'r optional' }, { l: 'Bedrag', cls: 'r' }, { l: 'Status' }],
          items.map(cn => [
            `<span class="sv-off-nr">${cn.credit_note_number || ('#' + String(cn.id || '').slice(0, 8))}</span>`,
            `<div class="cell-main-wrap"><div class="av av-sm">${H.av(cn.customer_name || '?')}</div><span class="cell-main">${cn.customer_name || '—'}</span></div>`,
            `<span class="mono" style="font-size:12.5px;color:var(--text-3)">${cn.invoice_number || '—'}</span>`,
            `<span class="mono" style="font-size:12.5px;color:var(--text-3)">${dstr(cn.credit_note_date)}</span>`,
            `<span class="mono">${eur(cn.amount_total)}</span>`,
            H.pill('neutral', cn.status || '—'),
          ])
        )}
      </div>
      <style>
        /* FIX-RONDE-2 F1: creditnota-rijen zijn read-only (geen klikdoel).
           Neutraliseer cursor:pointer + hover-highlight die default op tbody
           tr in de shared table-stijl staan. */
        .kv-cn-readonly-tbl table tbody tr { cursor: default !important; }
        .kv-cn-readonly-tbl table tbody tr:hover { background: transparent !important; }
      </style>
      ${fnPager(_cn, total, fetchCn)}
      ${!items.length && !_cn.loading ? `<div class="sv-empty">${_cn.error || 'Geen creditnota\'s in deze view.'}</div>` : ''}`;
  }

  // ── BANK ─────────────────────────────────────────────────────────────
  function bankParams() {
    const dir = F('fin-bank-dir', 'all');
    const p = new URLSearchParams();
    if (dir && dir !== 'all') p.set('direction', dir);
    if (_bnk.search) p.set('q', _bnk.search);
    if (_bnk.dateFrom) p.set('from', _bnk.dateFrom);
    if (_bnk.dateTo)   p.set('to',   _bnk.dateTo);
    const offset = ((_bnk.page || 1) - 1) * (_bnk.pageSize || 100);
    p.set('limit',  String(_bnk.pageSize || 100));
    p.set('offset', String(offset));
    return p.toString();
  }
  // Bank date-range preset chips (Dag/Week/Maand/Jaar/Custom).
  window.__finBankRange = (preset) => {
    const now = new Date(); const to = todayIso();
    if (preset === 'day')   { _bnk.dateFrom = to; _bnk.dateTo = to; }
    else if (preset === 'week')  { const f = new Date(now); f.setDate(f.getDate() - 6); _bnk.dateFrom = isoDay(f); _bnk.dateTo = to; }
    else if (preset === 'month') { _bnk.dateFrom = monthStart(); _bnk.dateTo = to; }
    else if (preset === 'year')  { _bnk.dateFrom = isoDay(new Date(now.getFullYear(), 0, 1)); _bnk.dateTo = to; }
    else if (preset === 'clear') { _bnk.dateFrom = ''; _bnk.dateTo = ''; }
    _bnk.page = 1;
    fetchBank();
  };
  async function fetchBank() {
    const wanted = bankParams();
    if (_bnk.loading && _bnk.params === wanted) return;
    const seq = ++_bnk.seq;
    _bnk.loading = true; _bnk.error = null; _bnk.params = wanted;
    // FLICKER-FIX: geen loading-render (consistent met sales-v2 #1263).
    const [bal, tx] = await Promise.all([
      tryFetch('finance-bank-camt-balance',      '/api/finance-bank-camt-balance'),
      tryFetch('finance-bank-camt-transactions', '/api/finance-bank-camt-transactions?' + wanted),
    ]);
    if (seq !== _bnk.seq) return;
    _bnk.bal = bal; _bnk.tx = tx; _bnk.loading = false;
    if (!bal && !tx) _bnk.error = 'Kon bank-data niet laden';
    window.DFO.render();
  }

  function bankView() {
    const dir = F('fin-bank-dir', 'all');
    if (!_bnk.loading && !_bnk.error && (!_bnk.tx || _bnk.params !== bankParams())) queueMicrotask(fetchBank);
    const items = _bnk.tx?.items || [];
    const bal = _bnk.bal || {};
    const kpis = _bnk.tx?.kpis || {};
    return `${previewHeader('Bank · CAMT-import', _bnk)}
      ${(() => { const _bc = bal.balance_cents; const _kc = _bc == null ? 'blue' : (_bc > 0 ? 'emerald' : (_bc < 0 ? 'rose' : 'blue'));
        return H.kpis([
        { c: _kc,    icon: I.euro,  label: 'Actueel saldo',       val: eurC(bal.balance_cents),         hi: 1, sub: bal.as_of_date ? `t/m ${dstr(bal.as_of_date)}` : '—' },
        { c: 'emerald', icon: I.trend, label: 'Inkomend (view)',     val: eurC(kpis.sum_in_cents),                sub: `${num(kpis.count_in)} transacties` },
        { c: 'orange',  icon: I.warn,  label: 'Uitgaand (view)',     val: eurC(kpis.sum_out_cents),               sub: `${num(kpis.count_out)} transacties` },
      ]); })()}
      ${(() => {
        // BROK F2 (2026-08-19): slotsaldo per IBAN uit endpoint.per_account.
        // Vroeger: alleen grand-total zichtbaar → 2 rekeningen stilzwijgend
        // gesommeerd. Nu: expliciete rij per IBAN + "geen data" bij lege
        // per_account (nooit meer stil ignore-en).
        const per = Array.isArray(bal.per_account) ? bal.per_account : [];
        if (!per.length) {
          return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:12px 14px;margin-top:10px;font-size:12px;color:var(--text-3)">Geen bank-accounts met CAMT-statements. Upload een CAMT-file of controleer bank_accounts.is_active.</div>`;
        }
        // FIX-RONDE-2 F2: endpoint stuurt nu ALLE geldige IBAN's mee met
        // status-label ('registered' / 'inactive' / 'unregistered'). Toon
        // ze allemaal — pastel-badge maakt duidelijk waarom een IBAN niet
        // meetelt in de grand-total. Waarschuwing blijft als samenvatting.
        return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden;margin-top:10px">
          <div style="padding:9px 14px;border-bottom:1px solid var(--border);font-weight:600;font-size:12.5px">Slotsaldo per IBAN (${per.length})</div>
          ${per.map((a) => {
            const sign = a.balance_cents == null ? 'text-3' : (a.balance_cents > 0 ? 'emerald' : (a.balance_cents < 0 ? 'rose' : 'text-3'));
            const st = String(a.status || 'registered');
            const badge = st === 'registered' ? '' :
                          st === 'inactive'   ? '<span style="display:inline-block;margin-left:8px;padding:1px 6px;border-radius:6px;font-size:10.5px;font-weight:600;background:var(--amber-soft);color:var(--amber);border:1px solid var(--amber-line)" title="Bank-account bestaat maar is_active=false — telt niet mee in grand-total">inactief</span>' :
                          '<span style="display:inline-block;margin-left:8px;padding:1px 6px;border-radius:6px;font-size:10.5px;font-weight:600;background:var(--rose-soft);color:var(--rose);border:1px solid var(--rose-line)" title="IBAN staat niet in bank_accounts — voeg toe om te laten meetellen">niet-geregistreerd</span>';
            const rowOpacity = st === 'registered' ? '' : 'opacity:.85';
            return `<div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:10px;padding:8px 14px;border-bottom:1px solid var(--border);font-size:12px;align-items:center;${rowOpacity}">
              <div class="mono">${a.account_iban || a.iban || '—'}${badge}</div>
              <div class="mono" style="text-align:right;color:var(--${sign});font-weight:600">${a.balance_cents == null ? '<span style="color:var(--text-3);font-weight:400">geen data</span>' : eurC(a.balance_cents)}</div>
              <div style="text-align:right;font-size:11px;color:var(--text-3)">${a.as_of_date ? 't/m ' + dstr(a.as_of_date) : '—'}${a.file_name ? ' · <span title="' + a.file_name + '">' + (String(a.file_name).length > 20 ? String(a.file_name).slice(0, 20) + '…' : a.file_name) + '</span>' : ''}</div>
            </div>`;
          }).join('')}
          ${bal.num_accounts_ignored > 0 ? `<div style="padding:8px 14px;font-size:11px;color:var(--amber);background:var(--amber-soft)">⚠ ${bal.num_accounts_ignored} IBAN(s) niet meegeteld — inactief of niet-geregistreerd (zie labels boven).</div>` : ''}
        </div>`;
      })()}
      ${H.toolbar([
        H.chips('fin-bank-dir', [
          { l: 'Alle',      v: 'all' },
          { l: 'Inkomend',  v: 'in' },
          { l: 'Uitgaand',  v: 'out' },
        ], dir),
        fnSearch(_bnk, 'Zoek omschrijving / tegenpartij…', fetchBank),
        `<div class="fn-daterange">
          <button class="btn btn-sm" onclick="__finBankRange('day')">Dag</button>
          <button class="btn btn-sm" onclick="__finBankRange('week')">Week</button>
          <button class="btn btn-sm" onclick="__finBankRange('month')">Maand</button>
          <button class="btn btn-sm" onclick="__finBankRange('year')">Jaar</button>
          ${fnDate(_bnk, 'dateFrom', fetchBank)}
          ${fnDate(_bnk, 'dateTo', fetchBank)}
          ${(_bnk.dateFrom || _bnk.dateTo) ? `<button class="btn btn-sm" onclick="__finBankRange('clear')">✕</button>` : ''}
        </div>`,
      ])}
      ${fnPager(_bnk, _bnk.tx?.total ?? null, fetchBank)}
      ${H.table(
        [{ l: 'Boekdatum', cls: 'r' }, { l: 'Tegenpartij' }, { l: 'Omschrijving', cls: 'optional' }, { l: 'IBAN', cls: 'optional' }, { l: 'Bedrag', cls: 'r' }],
        items.map(t => [
          `<span class="mono" style="font-size:12.5px;color:var(--text-3)">${dstr(t.booking_date)}</span>`,
          `<span class="cell-main">${t.counterparty_name || '—'}</span>`,
          `<span style="font-size:12.5px;color:var(--text-3)">${t.description || '—'}</span>`,
          `<span class="mono" style="font-size:11.5px;color:var(--text-3)">${t.counterparty_iban || '—'}</span>`,
          `<span class="mono ${(t.amount_cents || 0) > 0 ? 'strong' : ''}" style="color:${(t.amount_cents || 0) > 0 ? 'var(--brand)' : 'var(--warn,var(--orange))'}">${eurC(t.amount_cents)}</span>`,
        ])
      )}
      ${fnPager(_bnk, _bnk.tx?.total ?? null, fetchBank)}
      ${!items.length && !_bnk.loading ? `<div class="sv-empty">${_bnk.error || 'Geen transacties met deze filter.'}</div>` : ''}`;
  }

  // ── OMZET & MRR ──────────────────────────────────────────────────────
  // Ronde 4: switch naar sales-mrr-report. Deze endpoint doet de correcte
  // MRR-berekening (incl-BTW per termijn / billing_cycle-maanden), retourneert
  // trend (-12..+12 maanden), per_traject breakdown, en top_subs. billing_cycle
  // kolom is beschikbaar in DB maar NIET in sales-subscriptions-list response
  // — daarom faalde de oude client-side MRR (subMonthlyIncl gaf 0 op alle
  // subs, KPI werd €0 en Per-product was NaN).
  async function fetchMrr() {
    const wanted = 'v1'; // Rapport-endpoint heeft geen periode-parameter voor de MRR-cijfers zelf.
    if (_mrr.loading && _mrr.params === wanted) return;
    const seq = ++_mrr.seq;
    _mrr.loading = true; _mrr.error = null; _mrr.params = wanted;
    // FLICKER-FIX: geen loading-render (consistent met sales-v2 #1263).
    const report = await tryFetch('sales-mrr-report', '/api/sales-mrr-report');
    if (seq !== _mrr.seq) return;
    _mrr.report = report; _mrr.loading = false;
    if (!report) _mrr.error = 'Kon MRR-rapport niet laden';
    window.DFO.render();
  }

  // ── SVG chart helpers (ronde 5) ──────────────────────────────────────
  // Bar-chart: bars per maand met value-labels bovenop, gridlines, x-labels.
  // Line/area-chart: path met area-gradient, dot per punt, hover-title.
  // Beide gebruiken viewBox voor responsive schaling, GEEN externe lib.
  function fmtEurCompact(v) {
    const n = Number(v) || 0;
    if (Math.abs(n) >= 1000) return '€' + (Math.round(n / 100) / 10).toLocaleString('nl-NL') + 'k';
    return '€' + Math.round(n).toLocaleString('nl-NL');
  }
  function svgBarChart(items, opts) {
    opts = opts || {};
    const color = opts.color || 'violet';
    const height = opts.height || 240;
    if (!items.length) return `<div class="sv-empty">Geen data.</div>`;
    const w = Math.max(600, items.length * 60);
    const padL = 52, padR = 12, padT = 24, padB = 40;
    const chartW = w - padL - padR;
    const chartH = height - padT - padB;
    const max = Math.max(1, ...items.map(t => Number(t.mrr) || 0));
    // Ronde niveau naar mooie waarden. 4 y-axis ticks.
    const step = niceStep(max / 4);
    const yMax = Math.max(step, Math.ceil(max / step) * step);
    const bw = chartW / items.length * 0.72;
    const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => yMax * f);
    return `<div class="mrr-chart-wrap"><svg class="mrr-chart" viewBox="0 0 ${w} ${height}" preserveAspectRatio="none" role="img">
      <defs>
        <linearGradient id="mrr-bar-${color}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--${color}, var(--brand))" stop-opacity=".95"/>
          <stop offset="100%" stop-color="var(--${color}, var(--brand))" stop-opacity=".55"/>
        </linearGradient>
      </defs>
      ${yTicks.map(y => {
        const yPx = padT + chartH - (y / yMax) * chartH;
        return `<line x1="${padL}" y1="${yPx}" x2="${w - padR}" y2="${yPx}" stroke="var(--line)" stroke-dasharray="2,4" stroke-width="1"/>
          <text x="${padL - 8}" y="${yPx + 4}" text-anchor="end" font-size="11" fill="var(--text-3)" font-family="'IBM Plex Mono',ui-monospace,monospace">${fmtEurCompact(y)}</text>`;
      }).join('')}
      ${items.map((t, i) => {
        const v = Number(t.mrr) || 0;
        const xC = padL + (i + 0.5) * (chartW / items.length);
        const bh = yMax > 0 ? (v / yMax) * chartH : 0;
        const yTop = padT + chartH - bh;
        const label = t.period ? t.period.slice(2) : '';
        return `<g>
          <title>${t.period || ''} · ${eur0(v)} · ${num(t.count)} subs</title>
          <rect x="${xC - bw/2}" y="${yTop}" width="${bw}" height="${Math.max(0, bh)}" rx="4" fill="url(#mrr-bar-${color})"/>
          ${bh > 22 ? `<text x="${xC}" y="${yTop - 6}" text-anchor="middle" font-size="10.5" fill="var(--text-2)" font-family="'IBM Plex Mono',ui-monospace,monospace" font-weight="600">${fmtEurCompact(v)}</text>` : ''}
          <text x="${xC}" y="${padT + chartH + 16}" text-anchor="middle" font-size="10.5" fill="var(--text-3)">${label}</text>
        </g>`;
      }).join('')}
      <line x1="${padL}" y1="${padT + chartH}" x2="${w - padR}" y2="${padT + chartH}" stroke="var(--line)" stroke-width="1"/>
    </svg></div>`;
  }
  function svgLineChart(items, opts) {
    opts = opts || {};
    const color = opts.color || 'blue';
    const height = opts.height || 220;
    if (!items.length) return `<div class="sv-empty">Geen data.</div>`;
    const w = Math.max(600, items.length * 55);
    const padL = 52, padR = 12, padT = 20, padB = 36;
    const chartW = w - padL - padR;
    const chartH = height - padT - padB;
    const max = Math.max(1, ...items.map(t => Number(t.mrr) || 0));
    const step = niceStep(max / 4);
    const yMax = Math.max(step, Math.ceil(max / step) * step);
    const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => yMax * f);
    const pts = items.map((t, i) => {
      const v = Number(t.mrr) || 0;
      const x = padL + (chartW / Math.max(1, items.length - 1)) * i;
      const y = padT + chartH - (v / yMax) * chartH;
      return { x, y, v, period: t.period, newMrr: t.new_mrr, churnMrr: t.churned_mrr, count: t.count };
    });
    const linePath = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const areaPath = `${linePath} L${pts[pts.length-1].x.toFixed(1)},${(padT + chartH).toFixed(1)} L${pts[0].x.toFixed(1)},${(padT + chartH).toFixed(1)} Z`;
    return `<div class="mrr-chart-wrap"><svg class="mrr-chart" viewBox="0 0 ${w} ${height}" preserveAspectRatio="none" role="img">
      <defs>
        <linearGradient id="mrr-area-${color}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--${color}, var(--brand))" stop-opacity=".28"/>
          <stop offset="100%" stop-color="var(--${color}, var(--brand))" stop-opacity="0"/>
        </linearGradient>
      </defs>
      ${yTicks.map(y => {
        const yPx = padT + chartH - (y / yMax) * chartH;
        return `<line x1="${padL}" y1="${yPx}" x2="${w - padR}" y2="${yPx}" stroke="var(--line)" stroke-dasharray="2,4" stroke-width="1"/>
          <text x="${padL - 8}" y="${yPx + 4}" text-anchor="end" font-size="11" fill="var(--text-3)" font-family="'IBM Plex Mono',ui-monospace,monospace">${fmtEurCompact(y)}</text>`;
      }).join('')}
      <path d="${areaPath}" fill="url(#mrr-area-${color})"/>
      <path d="${linePath}" fill="none" stroke="var(--${color}, var(--brand))" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
      ${pts.map((p, i) => `<g>
        <title>${p.period || ''} · ${eur0(p.v)} · +${eur0(p.newMrr)} nieuw · −${eur0(p.churnMrr)} churn · ${num(p.count)} subs</title>
        <circle cx="${p.x}" cy="${p.y}" r="4" fill="var(--surface)" stroke="var(--${color}, var(--brand))" stroke-width="2"/>
      </g>`).join('')}
      ${items.map((t, i) => {
        const x = padL + (chartW / Math.max(1, items.length - 1)) * i;
        return `<text x="${x}" y="${padT + chartH + 18}" text-anchor="middle" font-size="10.5" fill="var(--text-3)">${t.period ? t.period.slice(2) : ''}</text>`;
      }).join('')}
      <line x1="${padL}" y1="${padT + chartH}" x2="${w - padR}" y2="${padT + chartH}" stroke="var(--line)" stroke-width="1"/>
    </svg></div>`;
  }
  function niceStep(v) {
    if (!v || v <= 0) return 100;
    const pow = Math.pow(10, Math.floor(Math.log10(v)));
    const norm = v / pow;
    const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
    return nice * pow;
  }

  function mrrView() {
    if (!_mrr.loading && !_mrr.error && (!_mrr.report || _mrr.params !== 'v1')) queueMicrotask(fetchMrr);
    const r = _mrr.report || {};
    const k = r.kpis || {};
    const trend = Array.isArray(r.trend) ? r.trend : [];
    const byTraj = Array.isArray(r.by_traject) ? r.by_traject : [];
    const topSubs = Array.isArray(r.top_subs) ? r.top_subs : [];
    // Trend heeft 25 maanden (-12..+12).
    const future = trend.slice(12, 25); // 13 items: huidige + 12 vooruit
    const past   = trend.slice(0, 13);  // 13 items: -12..huidige
    // Max MRR uit by_traject voor per-product bar rendering.
    const trajMax = Math.max(1, ...byTraj.map(t => Number(t.mrr) || 0));

    return `${previewHeader('Omzet & MRR · sales-mrr-report', _mrr)}
      ${H.kpis([
        { c: 'violet',  icon: I.repeat, label: 'Huidige MRR incl. BTW',   val: eur0(k.current_mrr),   hi: 1, sub: `${num(k.active_count || 0)} actieve subs` },
        { c: 'emerald', icon: I.trend,  label: 'Gem. MRR per klant',      val: eur0(k.avg_mrr),       hi: 1 },
        { c: 'blue',    icon: I.euro,   label: 'Totaal inflow (deze mnd)',val: eur0(k.total_inflow),  hi: 1, sub: 'som van maandelijkse recurring' },
        { c: 'orange',  icon: I.warn,   label: 'Opzeg-percentage (mnd)',  val: k.cancellation_rate != null ? (Math.round(k.cancellation_rate * 1000) / 10) + '%' : '—', sub: 'churn / actief' },
      ])}
      <div class="sv-grid">
        <div class="sv-card sv-card-wide">
          <div class="sv-card-head">${svg(I.repeat)}Maandelijkse recurring omzet · komende 12 maanden · incl. BTW</div>
          <div class="sv-card-body">
            ${future.length ? svgBarChart(future, { color: 'violet', height: 260 }) : `<div class="sv-empty">${_mrr.loading ? 'Laden…' : 'Geen trend-data.'}</div>`}
          </div>
        </div>
        <div class="sv-card sv-card-wide">
          <div class="sv-card-head">${svg(I.trend)}Historische MRR-trend · afgelopen 12 maanden</div>
          <div class="sv-card-body">
            ${past.length ? svgLineChart(past, { color: 'blue', height: 240 }) : `<div class="sv-empty">${_mrr.loading ? 'Laden…' : 'Geen trend-data.'}</div>`}
          </div>
        </div>
        <div class="sv-card sv-card-wide">
          <div class="sv-card-head">${svg(I.doc)}Per traject / product · huidig actief</div>
          <div class="sv-card-body">
            ${byTraj.length ? `<div class="mrr-traj">${byTraj.slice(0, 12).map(p => {
              const v = Number(p.mrr) || 0;
              const pct = Math.max(2, Math.round(v / trajMax * 100));
              return `<div class="mrr-traj-row" title="${String(p.traject || '—')} · ${eur0(v)} · ${num(p.count)} actief">
                <div class="mrr-traj-lbl"><span>${String(p.traject || '—')}</span><span class="sv-row-sub">${num(p.count)}×</span></div>
                <div class="mrr-traj-bar-wrap"><div class="mrr-traj-bar" style="width:${pct}%"></div></div>
                <b class="mrr-traj-val">${eur0(v)}</b>
              </div>`;
            }).join('')}</div>` : `<div class="sv-empty">${_mrr.loading ? 'Laden…' : 'Geen per-traject data.'}</div>`}
          </div>
        </div>
        <div class="sv-card sv-card-wide">
          <div class="sv-card-head">${svg(I.repeat)}Top 10 grootste abonnementen (MRR)</div>
          <div class="sv-card-body">
            ${topSubs.length ? H.table(
              [{ l: 'Klant' }, { l: 'Beschrijving', cls: 'optional' }, { l: 'Termijn', cls: 'optional' }, { l: 'Per termijn incl.', cls: 'r' }, { l: 'MRR incl.', cls: 'r' }],
              topSubs.map(s => [
                `<div class="cell-main-wrap"><div class="av av-sm">${H.av(s.customer_name || '?')}</div><span class="cell-main">${s.customer_name || '—'}</span></div>`,
                `<span style="font-size:12.5px;color:var(--text-3)">${s.description || '—'}</span>`,
                `<span class="mono" style="font-size:11.5px;color:var(--text-3)">${s.billing_cycle || 'per_month'}</span>`,
                `<span class="mono">${eur(s.per_term_incl)}</span>`,
                `<span class="mono strong">${eur0(s.mrr)}</span>`,
              ])
            ) : `<div class="sv-empty">${_mrr.loading ? 'Laden…' : 'Geen actieve subscriptions.'}</div>`}
          </div>
        </div>
      </div>`;
  }

  window.DFO.VIEWS['finance/Dashboard']    = dashboardView;
  window.DFO.VIEWS['finance/Facturen']     = invoicesView;
  window.DFO.VIEWS['finance/Abonnementen'] = subsView;
  window.DFO.VIEWS["finance/Creditnota's"] = cnView;
  window.DFO.VIEWS['finance/Bank']         = bankView;
  window.DFO.VIEWS['finance/Omzet & MRR']  = mrrView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('finance');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('finance');
  console.debug('[finance-v2] registered 6 views (data-round · live endpoints)');
})();
