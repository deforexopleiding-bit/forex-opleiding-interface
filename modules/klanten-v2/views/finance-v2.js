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

  // ── State per tab ─────────────────────────────────────────────────────
  // Pager-state per tab: page (1-based) + page_size (default 50 op alle
  // lijst-tabs; user kan wisselen 25/100/500/1000).
  const _dash = { loading: false, error: null, data: null, seq: 0, period: '' };
  const _inv  = { loading: false, error: null, data: null, seq: 0, params: '', page: 1, pageSize: 50, search: '', dateFrom: '', dateTo: '' };
  const _sub  = { loading: false, error: null, data: null, seq: 0, params: '', page: 1, pageSize: 50, search: '', sortBy: 'end_date', sortDir: 'asc', filterExpiring: false };
  const _cn   = { loading: false, error: null, data: null, seq: 0, params: '', page: 1, pageSize: 50, search: '' };
  const _bnk  = { loading: false, error: null, bal: null, tx: null, seq: 0, params: '', page: 1, pageSize: 100, search: '', dateFrom: '', dateTo: '' };
  const _mrr  = { loading: false, error: null, data: null, subs: null, seq: 0, params: '' };

  // ── SHARED HELPERS: uncontrolled search + pagination ─────────────────
  // Cursor-bug fix: gebruik `defaultValue` (initial mount) i.p.v. `value`
  // + eigen dispatcher via oninput met debounce → geen re-render tijdens
  // tikken, cursor blijft staan. State wordt bijgehouden op _<tab>.search
  // en pas na debounce triggert refetch.
  const _searchDeb = {};
  function fnSearch(tabState, placeholder, refetchFn) {
    const stateKey = tabState === _inv ? 'inv' : tabState === _sub ? 'sub' : tabState === _cn ? 'cn' : tabState === _bnk ? 'bnk' : 'x';
    // Global handler die per tab de state update + debounced refetch.
    window['__fnSearch_' + stateKey] = (val) => {
      tabState.search = val;
      if (_searchDeb[stateKey]) clearTimeout(_searchDeb[stateKey]);
      _searchDeb[stateKey] = setTimeout(() => {
        tabState.page = 1;
        refetchFn();
      }, 350);
    };
    return `<div class="tb-search"><input type="search" placeholder="${placeholder}" defaultValue="${(tabState.search || '').replace(/"/g, '&quot;')}" oninput="__fnSearch_${stateKey}(this.value)"></div>`;
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
  const _dateDeb = {};
  function fnDate(tabState, field, refetchFn) {
    const key = tabState === _inv ? 'inv' : tabState === _bnk ? 'bnk' : 'x';
    const globalKey = '__fnDate_' + key + '_' + field;
    window[globalKey] = (val) => {
      tabState[field] = val;
      if (_dateDeb[globalKey]) clearTimeout(_dateDeb[globalKey]);
      _dateDeb[globalKey] = setTimeout(() => { tabState.page = 1; refetchFn(); }, 250);
    };
    return `<input type="date" class="fn-date-input" defaultValue="${tabState[field] || ''}" oninput="${globalKey}(this.value)">`;
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

  function previewHeader(label, state) {
    const err = state?.error ? `<span class="prev-badge-err">${state.error}</span>` : '';
    const loading = state?.loading ? `<span class="prev-badge-load">${svg(I.clock || I.settings)} laden…</span>` : '';
    return `<div class="prev-badge">
      <span class="prev-badge-dot"></span>
      <b>PREVIEW · live data</b>
      <span class="prev-badge-lbl">${label}</span>
      ${loading}${err}
    </div>`;
  }

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
    window.DFO.render();
    const data = await tryFetch('finance-dashboard-counts', `/api/finance-dashboard-counts?period=${period}`);
    if (seq !== _dash.seq) return;
    _dash.data = data; _dash.loading = false;
    if (!data) _dash.error = 'Kon dashboard-counts niet laden';
    window.DFO.render();
  }

  function dashboardView() {
    const label = F('fin-p', 'Maand');
    const wantedPeriod = PERIOD_LABEL_TO_PARAM[label] || 'month';
    if (!_dash.loading && (!_dash.data || _dash.period !== wantedPeriod)) queueMicrotask(fetchDashboard);
    const d = _dash.data || {};
    // Beschermde-zone-velden NIET renderen: actieveArrangements,
    // openVerifyPayment, openEscalations, joostStats, conversieWanbetalersFlow.
    return `${previewHeader('Dashboard', _dash)}
      ${H.kpis([
        { c: 'orange',  icon: I.euro,  label: 'Totaal openstaand',    val: eur0(d.totaalOpenstaand),          hi: 1, sub: `${num(d.openFacturen)} open · ${num(d.overdueFacturen)} vervallen` },
        { c: 'blue',    icon: I.euro,  label: 'Bank-saldo',           val: eurC(d.bankBalans?.value),         hi: 1, sub: d.bankBalans?.accountCount ? `${d.bankBalans.accountCount} rekeningen` : '—' },
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
          <div class="sv-card-head">${svg(I.euro)}Bank</div>
          <div class="sv-card-body">
            <div class="sv-row"><span>Actueel saldo</span><b>${eurC(d.bankBalans?.value)}</b></div>
            <div class="sv-row"><span>Aantal rekeningen</span><b>${num(d.bankBalans?.accountCount)}</b></div>
            <div class="sv-row"><span>Bijgewerkt</span><b>${d.bankBalans?.fetchedAt ? dstr(d.bankBalans.fetchedAt) : '—'}</b></div>
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
  const _newInv = {
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

  window.__finInvNew  = () => setUrlParam('fn-invoice-new', '1');
  window.__finInvNewClose = () => {
    setUrlParam('fn-invoice-new', null);
    // Reset form-state zodat volgende open schoon is.
    _newInv.form = { customer_id: '', department_id: '', purchase_order_number: '', language: 'nl', lines: [{ description: '', quantity: 1, unit_price_excl: 0, vat_percentage: 21 }] };
    _newInv.custQuery = ''; _newInv.custPickedName = ''; _newInv.customers = []; _newInv.guardTyped = '';
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
    if (urlParam('fn-invoice-new') === '1') { e.preventDefault(); window.__finInvNewClose(); }
  });
  window.addEventListener('popstate', () => {
    if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render();
  });

  function invoicesParams() {
    const st = F('fin-inv-st', 'open');
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
    window.DFO.render();
    const data = await tryFetch('finance-invoices', '/api/finance-invoices?' + wanted);
    if (seq !== _inv.seq) return;
    _inv.data = data; _inv.loading = false;
    if (!data) _inv.error = 'Kon facturen niet laden';
    window.DFO.render();
  }

  function invoicesView() {
    const st = F('fin-inv-st', 'open');
    if (!_inv.loading && (!_inv.data || _inv.params !== invoicesParams())) queueMicrotask(fetchInvoices);
    const items = _inv.data?.items || [];
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
        [{ l: 'Factuur-nr' }, { l: 'Klant' }, { l: 'Uitgifte', cls: 'r optional' }, { l: 'Vervaldatum', cls: 'r optional' }, { l: 'Totaal', cls: 'r' }, { l: 'Open', cls: 'r' }, { l: 'Status' }],
        items.map(v => {
          const [c, l] = INV_STATUS_TO_PILL[v.display_status] || INV_STATUS_TO_PILL[v.status] || ['neutral', v.display_status || v.status || '—'];
          return [
            `<a href="javascript:__finInvOpen('${v.tl_invoice_id || v.id}')" class="sv-off-nr">${v.invoice_number || ('#' + String(v.id || '').slice(0, 8))}</a>`,
            `<div class="cell-main-wrap"><div class="av av-sm">${H.av(v.customer_name || '?')}</div><span class="cell-main">${v.customer_name || '—'}</span></div>`,
            `<span class="mono" style="font-size:12.5px;color:var(--text-3)">${dstr(v.issue_date)}</span>`,
            `<span class="mono" style="font-size:12.5px;color:var(--text-3)">${dstr(v.due_date)}</span>`,
            `<span class="mono">${eur(v.amount_total)}</span>`,
            `<span class="mono ${(v.amount_open || 0) > 0 ? 'strong' : ''}">${eur(v.amount_open)}</span>`,
            H.pill(c, l),
          ];
        })
      )}
      ${!items.length && !_inv.loading ? `<div class="sv-empty">${_inv.error || 'Geen facturen met deze filters.'}</div>` : ''}
      ${urlParam('fn-invoice-new') === '1' ? invoiceCreateModal() : ''}`;
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
  async function fetchSubs() {
    const wanted = subsParams();
    if (_sub.loading && _sub.params === wanted) return;
    const seq = ++_sub.seq;
    _sub.loading = true; _sub.error = null; _sub.params = wanted;
    window.DFO.render();
    const data = await tryFetch('sales-subscriptions-list', '/api/sales-subscriptions-list?' + wanted);
    if (seq !== _sub.seq) return;
    _sub.data = data; _sub.loading = false;
    if (!data) _sub.error = 'Kon abonnementen niet laden';
    window.DFO.render();
  }

  // Client-side MRR helper: gebruik s.mrr; fallback op per_term_incl /
  // cycle-maanden als mrr ontbreekt. Handelt 'active' status af.
  const CYCLE_TO_MONTHS = { per_month: 1, per_2_months: 2, per_quarter: 3, per_6_months: 6, per_year: 12 };
  function subMonthlyIncl(s) {
    if (s.mrr != null && !isNaN(Number(s.mrr))) return Number(s.mrr);
    const cycleM = CYCLE_TO_MONTHS[s.billing_cycle] || 1;
    const perTerm = Number(s.per_term_incl) || Number(s.per_term_excl) || 0;
    return perTerm / cycleM;
  }

  function subsView() {
    const st = F('fin-sub-st', 'active');
    if (!_sub.loading && (!_sub.data || _sub.params !== subsParams())) queueMicrotask(fetchSubs);
    let items = (_sub.data?.items || []).slice();
    const total = _sub.data?.total ?? null;

    // Client-side search (over customer-name + description + entity).
    if (_sub.search) {
      const q = _sub.search.toLowerCase();
      items = items.filter(s => {
        const name = (s.customer?.name || s.customer_name || '').toLowerCase();
        const desc = (s.description || '').toLowerCase();
        const ent = (s.entity || '').toLowerCase();
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
    // Client-side sort op start_date of end_date.
    if (_sub.sortBy === 'start_date' || _sub.sortBy === 'end_date') {
      items.sort((a, b) => {
        const av = String(a[_sub.sortBy] || '');
        const bv = String(b[_sub.sortBy] || '');
        return _sub.sortDir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }

    const activeItems = items.filter(s => (s.status || '') === 'active');
    const mrrSum = activeItems.reduce((a, s) => a + subMonthlyIncl(s), 0);
    const sortIcon = (col) => _sub.sortBy === col ? (_sub.sortDir === 'asc' ? ' ▲' : ' ▼') : '';

    return `${previewHeader('Abonnementen · via sales-subscriptions', _sub)}
      ${H.kpis([
        { c: 'emerald', icon: I.check,  label: 'Actief (view + filters)',  val: num(activeItems.length), hi: 1 },
        { c: 'violet',  icon: I.trend,  label: 'MRR incl. BTW (view)',     val: eur0(mrrSum), hi: 1, sub: 'som van maandelijkse waarde' },
        { c: 'blue',    icon: I.repeat, label: 'Totaal in view',           val: num(items.length), sub: total != null ? `van ${num(total)} totaal` : '—' },
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
          <button class="btn btn-sm" onclick="__finSubSort('start_date')" title="Sorteer op startdatum">Start${sortIcon('start_date')}</button>
          <button class="btn btn-sm" onclick="__finSubSort('end_date')" title="Sorteer op einddatum">Eind${sortIcon('end_date')}</button>
        </div>`,
      ])}
      ${fnPager(_sub, total, fetchSubs)}
      ${H.table(
        [{ l: 'Klant' }, { l: 'Beschrijving', cls: 'optional' }, { l: 'Entiteit', cls: 'optional' }, { l: 'Per termijn', cls: 'r' }, { l: 'Maand incl.', cls: 'r' }, { l: 'Start', cls: 'r optional' }, { l: 'Eind', cls: 'r optional' }, { l: 'Status' }],
        items.map(s => {
          const cName = s.customer?.name || s.customer_name || '—';
          const [c, l] = SUB_STATUS_TO_PILL[s.status] || ['neutral', s.status || '—'];
          return [
            `<div class="cell-main-wrap"><div class="av av-sm">${H.av(cName)}</div><span class="cell-main">${cName}</span></div>`,
            `<span style="font-size:12.5px;color:var(--text-3)">${s.description || '—'}</span>`,
            `<span style="font-size:12.5px;color:var(--text-3)">${s.entity || '—'}</span>`,
            `<span class="mono">${eur(s.per_term_incl)}</span>`,
            `<span class="mono">${eur0(subMonthlyIncl(s))}</span>`,
            `<span class="mono" style="font-size:12.5px;color:var(--text-3)">${dstr(s.start_date)}</span>`,
            `<span class="mono" style="font-size:12.5px;color:var(--text-3)">${dstr(s.end_date)}</span>`,
            H.pill(c, l),
          ];
        })
      )}
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
    window.DFO.render();
    const data = await tryFetch('finance-creditnotes-list', '/api/finance-creditnotes-list?' + wanted);
    if (seq !== _cn.seq) return;
    _cn.data = data; _cn.loading = false;
    if (!data) _cn.error = 'Kon creditnota\'s niet laden';
    window.DFO.render();
  }

  function cnView() {
    if (!_cn.loading && (!_cn.data || _cn.params !== cnParams())) queueMicrotask(fetchCn);
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
    window.DFO.render();
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
    if (!_bnk.loading && (!_bnk.tx || _bnk.params !== bankParams())) queueMicrotask(fetchBank);
    const items = _bnk.tx?.items || [];
    const bal = _bnk.bal || {};
    const kpis = _bnk.tx?.kpis || {};
    return `${previewHeader('Bank · CAMT-import', _bnk)}
      ${H.kpis([
        { c: 'blue',    icon: I.euro,  label: 'Actueel saldo',       val: eurC(bal.balance_cents),         hi: 1, sub: bal.as_of_date ? `t/m ${dstr(bal.as_of_date)}` : '—' },
        { c: 'emerald', icon: I.trend, label: 'Inkomend (view)',     val: eurC(kpis.sum_in_cents),                sub: `${num(kpis.count_in)} transacties` },
        { c: 'orange',  icon: I.warn,  label: 'Uitgaand (view)',     val: eurC(kpis.sum_out_cents),               sub: `${num(kpis.count_out)} transacties` },
      ])}
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
      ${!items.length && !_bnk.loading ? `<div class="sv-empty">${_bnk.error || 'Geen transacties met deze filter.'}</div>` : ''}`;
  }

  // ── OMZET & MRR ──────────────────────────────────────────────────────
  // Gebruikt super-admin-omzet (bron van dashboard.html omzet-KPI's).
  // Default periode = huidige maand (matcht dashboard.html default).
  function mrrParams() {
    const label = F('fin-mrr-p', 'Maand');
    let from, to, gb;
    const now = new Date();
    to = todayIso();
    if (label === 'Week')     { const f = new Date(now); f.setDate(f.getDate() - 6);  from = isoDay(f); gb = 'day'; }
    else if (label === 'Kwartaal') { const q = Math.floor(now.getMonth() / 3) * 3; from = isoDay(new Date(now.getFullYear(), q, 1)); gb = 'week'; }
    else if (label === 'Jaar')     { from = isoDay(new Date(now.getFullYear(), 0, 1)); gb = 'month'; }
    else                          { from = monthStart(); gb = 'day'; }
    return `from=${from}&to=${to}&group_by=${gb}`;
  }
  async function fetchMrr() {
    const wanted = mrrParams();
    if (_mrr.loading && _mrr.params === wanted) return;
    const seq = ++_mrr.seq;
    _mrr.loading = true; _mrr.error = null; _mrr.params = wanted;
    window.DFO.render();
    // Parallel: super-admin-omzet (historisch, per-product breakdown) +
    // sales-subscriptions-list (voor maandelijkse recurring incl-BTW
    // berekening — MRR per maand = som van elke actieve sub's
    // per_term_incl / cycle_months).
    const [data, subs] = await Promise.all([
      tryFetch('super-admin-omzet',        '/api/super-admin-omzet?' + wanted),
      tryFetch('sales-subscriptions-list', '/api/sales-subscriptions-list?status=active&page=1&page_size=500'),
    ]);
    if (seq !== _mrr.seq) return;
    _mrr.data = data; _mrr.subs = subs; _mrr.loading = false;
    if (!data && !subs) _mrr.error = 'Kon omzet-rapport niet laden';
    if (subs && subs.total > 500) console.warn('[finance-v2] active-subs > 500 — MRR berekend op eerste 500 rijen');
    window.DFO.render();
  }

  // Bereken maandelijkse RECURRING omzet incl. BTW uit active subscriptions.
  // Voor de komende 12 maanden: hoeveel geld komt er per maand binnen op
  // basis van huidige actieve subs (per_term_incl / cycle_months, alleen
  // subs waarvan start_date <= maand-eind EN (end_date null OR >= maand-begin)).
  function recurringPerMonth() {
    const subs = (_mrr.subs?.items || []).filter(s => s.status === 'active');
    if (!subs.length) return { rows: [], currentMonthly: 0 };
    const now = new Date();
    const rows = [];
    for (let i = 0; i < 12; i++) {
      const mStart = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const mEnd   = new Date(now.getFullYear(), now.getMonth() + i + 1, 0);
      const active = subs.filter(s => {
        const sd = s.start_date ? new Date(s.start_date) : null;
        const ed = s.end_date   ? new Date(s.end_date)   : null;
        if (sd && sd > mEnd) return false;
        if (ed && ed < mStart) return false;
        return true;
      });
      const monthly = active.reduce((a, s) => a + subMonthlyIncl(s), 0);
      const label = mStart.toLocaleDateString('nl-NL', { month: 'short', year: 'numeric' });
      rows.push({ label, month: mStart.toISOString().slice(0, 7), monthly, count: active.length });
    }
    return { rows, currentMonthly: rows[0]?.monthly || 0 };
  }

  function mrrView() {
    const label = F('fin-mrr-p', 'Maand');
    if (!_mrr.loading && (!_mrr.data || _mrr.params !== mrrParams())) queueMicrotask(fetchMrr);
    const k = _mrr.data?.kpis || {};
    const trend = Array.isArray(_mrr.data?.trend) ? _mrr.data.trend : [];
    const perProduct = Array.isArray(_mrr.data?.per_product) ? _mrr.data.per_product : [];
    const trendMax = Math.max(1, ...trend.map(t => Number(t.totaal_incl_btw ?? t.total ?? t.revenue) || 0));
    const rec = recurringPerMonth();
    const recMax = Math.max(1, ...rec.rows.map(r => r.monthly));

    return `${previewHeader('Omzet & MRR · super-admin-omzet + subs', _mrr)}
      ${H.kpis([
        { c: 'violet',  icon: I.repeat, label: 'Huidige MRR incl. BTW',   val: eur0(rec.currentMonthly),   hi: 1, sub: `${num(rec.rows[0]?.count || 0)} actieve subs` },
        { c: 'emerald', icon: I.euro,   label: 'Losse verkopen (incl. BTW)', val: eur0(k.los_incl_btw),    hi: 1, sub: 'in gekozen periode' },
        { c: 'blue',    icon: I.trend,  label: 'Totaal periode (incl. BTW)', val: eur0(k.totaal_incl_btw), hi: 1 },
        { c: 'orange',  icon: I.doc,    label: 'Aantal deals in periode',    val: num(k.deal_count) },
      ])}
      ${H.toolbar([
        H.chips('fin-mrr-p', [
          { l: 'Week',     v: 'Week' },
          { l: 'Maand',    v: 'Maand' },
          { l: 'Kwartaal', v: 'Kwartaal' },
          { l: 'Jaar',     v: 'Jaar' },
        ], label),
      ])}
      <div class="sv-grid">
        <div class="sv-card sv-card-wide">
          <div class="sv-card-head">${svg(I.repeat)}Maandelijkse recurring omzet · komende 12 maanden · incl. BTW</div>
          <div class="sv-card-body">
            ${rec.rows.length ? `
              <div class="sv-trend" style="height:180px">${rec.rows.map(r => {
                const h = Math.max(3, Math.round(r.monthly / recMax * 100));
                return `<div class="sv-trend-col" title="${r.label} · ${eur0(r.monthly)} · ${num(r.count)} subs">
                  <div class="sv-trend-bar" style="height:${h}%;background:linear-gradient(180deg, var(--violet, var(--brand)), color-mix(in srgb, var(--violet, var(--brand)) 55%, transparent))"></div>
                  <div class="sv-trend-lbl">${r.label}</div>
                </div>`;
              }).join('')}</div>
              <div class="mrr-months">
                ${rec.rows.map(r => `<div class="mrr-month-row"><span>${r.label}</span><span class="sv-row-sub">${num(r.count)} subs</span><b>${eur0(r.monthly)}</b></div>`).join('')}
              </div>
            ` : `<div class="sv-empty">${_mrr.loading ? 'Laden…' : 'Geen actieve subscriptions.'}</div>`}
          </div>
        </div>
        <div class="sv-card">
          <div class="sv-card-head">${svg(I.doc)}Per product (uit super-admin-omzet, periode)</div>
          <div class="sv-card-body">
            ${perProduct.length ? perProduct.slice(0, 10).map(p => `
              <div class="sv-row"><span>${p.product_name || p.product || p.name || '—'} <span class="sv-row-sub">${num(p.count)}×</span></span><b>${eur0(p.totaal_incl_btw ?? p.total ?? p.revenue)}</b></div>
            `).join('') : `<div class="sv-empty">${_mrr.loading ? 'Laden…' : 'Geen per-product data in periode.'}</div>`}
          </div>
        </div>
        <div class="sv-card">
          <div class="sv-card-head">${svg(I.trend)}Historische omzet-trend (super-admin-omzet)</div>
          <div class="sv-card-body">
            ${trend.length ? `<div class="sv-trend" style="height:140px">${trend.map(t => {
              const rev = Number(t.totaal_incl_btw ?? t.total ?? t.revenue) || 0;
              const h = Math.max(3, Math.round(rev / trendMax * 100));
              return `<div class="sv-trend-col" title="${t.period || t.label || t.date || ''} · ${eur0(rev)}">
                <div class="sv-trend-bar" style="height:${h}%"></div>
                <div class="sv-trend-lbl">${t.period || t.label || (t.date ? String(t.date).slice(5, 10) : '')}</div>
              </div>`;
            }).join('')}</div>` : `<div class="sv-empty">${_mrr.loading ? 'Laden…' : 'Geen trend-data.'}</div>`}
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
