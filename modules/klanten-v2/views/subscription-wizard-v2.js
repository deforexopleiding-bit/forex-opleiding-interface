// modules/klanten-v2/views/subscription-wizard-v2.js
//
// V2 in-shell Subscription-wizard (Nieuw abonnement / Omzetten naar abo).
// 1-op-1 met modules/subscription-wizard.html (1010r), maar als in-shell
// view geregistreerd op DFO.VIEWS['klanten/SubWizard'] — analoog aan
// sales-wizard-v2 pattern.
//
// Entry-points:
//   window.__subwOpen({ dealId?, customerId?, resumeFromV1?: false })
//   URL-signaal: ?subw=1[&deal_id=X | &customer_id=X]
//
// Stappen:
//   1. Klant/offerte review
//      - Deal-modus: toont klant + offerte-samenvatting uit
//        /api/sales-deal-detail?id=<uuid>. Prefill via
//        payment_downpayment_amount / payment_term_count / payment_term_amount /
//        payment_*_date / duration_months.
//      - Standalone-modus: search-input naar /api/sales-customers?search=…
//        (max 15 hits). "Nieuwe klant aanmaken" valt terug op v1-wizard
//        (link met warning-hint — v2 slaat over in deze ronde).
//   2. Abonnementen: subs met line-items (add/remove regel + amount excl/incl
//      + vat-select + termijnen + startdatum + end_date-auto). Add/remove sub.
//      Uncontrolled inputs: blur/change re-recalc en surgical DOM-update van
//      alleen totalen-regels; geen full re-render bij typen → cursor blijft.
//   3. Bonus & bevestigen: 3%-bonus over aanbetalingen ≥€1000, preview-blok,
//      submit (met TL-sync) OF submit-lokaal (geen TL).
//
// €100-reserveringsfee-bypass (1-op-1 met v1):
//   - Card zichtbaar alleen bij RBAC.can('sales.reservation_fee.bypass').
//     window.RBAC wordt lazy-geladen via /modules/shared/permissions.js;
//     als niet beschikbaar → card verborgen (safe default).
//   - Textarea reason, min 10 chars, client-side pre-check + server-side
//     spiegel (422 reason-required).
//   - Payload: bypass_reservation_fee:true + bypass_reason bij submit.
//     Server persist naar deals.reservation_fee_bypassed_by/at +
//     reservation_fee_bypass_reason + agent_audit_log-insert.
//
// Reken-invariant (bewaakt in _recalcLine + _subInclPerTerm):
//   - line.amount    = EXCL. BTW (canonical, gaat 1-op-1 in payload)
//   - line.amount_incl = amount * (1 + vat/100) (afgeleid)
//   - subInclPerTerm = Σ line.amount_incl (som over regels)
//   - subTotal-wizard = Σ subInclPerTerm × term_count
//   - end_date = start + (term_count - 1) mnd + 2 dagen buffer
//
// Fail-soft: 8s timeout op fetches. Geen preview-strip. Dormant tot
// activatie in aparte PR na Jeffrey's OK.

(function () {
  if (!window.DFO) { console.error('[subw-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[subw-v2] KV_V2.helpers niet geladen.'); return; }

  const { svg, I } = window.DFO;
  const H = window.KV_V2.helpers;

  const asArr = (x) => Array.isArray(x) ? x : [];
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const eur = (n) => (Number(n) || 0).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 });
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  const RESERVATION_FEE_INCL = 100;

  // ── Wizard state ────────────────────────────────────────────────────────
  const _sub = {
    open: false,
    step: 1,
    submitting: false,
    globalError: null,

    // Modus: 'deal' (uit offerte-detail) of 'standalone' (Finance/Nieuw)
    mode: 'standalone',
    dealId: null,

    // Data uit API
    deal: null,            // { id, customer_name, ...payment_*, duration_months, ... }
    customer: null,        // { id, name/first_name/last_name, email, ... }
    lineItemsDeal: [],     // uit sales-deal-detail (voor prefill)
    entities: [],          // /api/company-entities
    products: [],          // /api/sales-products?active=true
    trajecten: [],         // /api/trajecten (voor description-presets)

    // UI-state
    tl_department_id: '',
    sale_type: 'domestic',   // 'domestic' | 'intracommunautair' — standalone-only
    sync_to_tl: true,

    // Subs (1 of meer)
    subscriptions: [/* { description, term_count, start_date, end_date, line_items:[{description, amount, amount_incl, vat_percentage, _lead}] } */],

    // Standalone klant-zoek
    custSearch: '',
    custResults: [],
    custSearching: false,

    // Bypass
    rbacBypass: false,          // Result van RBAC.can('sales.reservation_fee.bypass')
    rbacChecked: false,
    bypassFee: false,
    bypassReason: '',
  };

  // ── URL-signaal handler ────────────────────────────────────────────────
  function urlParam(k) { try { return new URLSearchParams(location.search).get(k); } catch { return null; } }
  function _clearUrlSignal() {
    try {
      const u = new URL(location.href);
      u.searchParams.delete('subw');
      u.searchParams.delete('deal_id');
      u.searchParams.delete('customer_id');
      history.replaceState({}, '', u.toString());
    } catch (_) {}
  }

  // ── Public entry: opens the wizard ─────────────────────────────────────
  window.__subwOpen = async (opts) => {
    _sub.open = true;
    _sub.step = 1;
    _sub.submitting = false;
    _sub.globalError = null;
    _sub.dealId = (opts && opts.dealId) || null;
    _sub.mode = _sub.dealId ? 'deal' : 'standalone';
    _sub.deal = null;
    _sub.customer = null;
    _sub.lineItemsDeal = [];
    _sub.subscriptions = [];
    _sub.custSearch = '';
    _sub.custResults = [];
    _sub.custSearching = false;
    _sub.bypassFee = false;
    _sub.bypassReason = '';

    if (window.DFO?.render) window.DFO.render();
    _loadRefData();      // entities + products + trajecten (parallel)
    _loadRbac();
    if (_sub.mode === 'deal') await _loadDealAndPrefill(_sub.dealId);
    else if (opts?.customerId) await _loadCustomerById(opts.customerId);
    else _addBlankSub();
    if (window.DFO?.render) window.DFO.render();
  };
  window.__subwClose = () => {
    if (_sub.submitting) return;
    _sub.open = false;
    _clearUrlSignal();
    if (window.DFO?.render) window.DFO.render();
  };
  window.__subwGoStep = (n) => {
    if (n < 1 || n > 3) return;
    if (n > 1 && !_validateStep(1)) return;
    if (n > 2 && !_validateStep(2)) return;
    _sub.step = n; _sub.globalError = null;
    if (window.DFO?.render) window.DFO.render();
  };

  // URL-check bij page-load: ?subw=1 → auto-open
  if (urlParam('subw') === '1') {
    queueMicrotask(() => {
      window.__subwOpen({
        dealId: urlParam('deal_id') || null,
        customerId: urlParam('customer_id') || null,
      });
    });
  }

  // ── Data-fetchers ──────────────────────────────────────────────────────
  async function tryFetch(label, url, timeoutMs = 8000) {
    try {
      return await Promise.race([
        window.KV.authedJson(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) { console.warn('[subw-v2] ' + label + ' fail:', e?.message); return null; }
  }
  async function _loadRefData() {
    const [ents, prods, traj] = await Promise.all([
      tryFetch('entities', '/api/company-entities'),
      tryFetch('products', '/api/sales-products?active=true'),
      tryFetch('trajecten', '/api/trajecten'),
    ]);
    _sub.entities  = asArr(ents?.entities);
    _sub.products  = asArr(prods?.products);
    _sub.trajecten = asArr(traj?.trajecten);
    // Default entity = eerste
    if (!_sub.tl_department_id && _sub.entities.length) _sub.tl_department_id = _sub.entities[0].tl_department_id || '';
    if (window.DFO?.render) window.DFO.render();
  }
  async function _loadRbac() {
    try {
      if (!window.RBAC) {
        // Lazy load permissions.js
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = '/modules/shared/permissions.js?v=1';
          s.onload = resolve;
          s.onerror = reject;
          document.head.appendChild(s);
        });
      }
      if (window.RBAC?.ensurePermissionsLoaded) await window.RBAC.ensurePermissionsLoaded();
      _sub.rbacBypass = !!(window.RBAC?.canSync && window.RBAC.canSync('sales.reservation_fee.bypass'));
    } catch (e) {
      console.warn('[subw-v2] RBAC load fail:', e?.message);
      _sub.rbacBypass = false;
    }
    _sub.rbacChecked = true;
    if (window.DFO?.render) window.DFO.render();
  }
  async function _loadDealAndPrefill(dealId) {
    const j = await tryFetch('deal-detail', '/api/sales-deal-detail?id=' + encodeURIComponent(dealId));
    if (!j) { _sub.globalError = 'Kon offerte niet laden'; return; }
    _sub.deal = j.deal || null;
    _sub.customer = j.customer || null;
    _sub.lineItemsDeal = asArr(j.line_items);
    _prefillFromDeal();
  }
  async function _loadCustomerById(customerId) {
    const j = await tryFetch('customer', '/api/sales-customer?id=' + encodeURIComponent(customerId));
    if (j?.customer) _sub.customer = j.customer;
    _addBlankSub();
  }

  // ── Prefill helpers ────────────────────────────────────────────────────
  function _addBlankSub() {
    const today = new Date().toISOString().slice(0, 10);
    _sub.subscriptions.push({
      description: '',
      term_count: 1,
      start_date: today,
      end_date: today,
      line_items: [_newLine()],
    });
    _recomputeEnds();
  }
  function _newLine(preset) {
    const line = {
      product_id: preset?.product_id || '',
      description: preset?.description || '',
      amount: preset?.amount != null ? round2(preset.amount) : 0,
      amount_incl: 0,
      vat_percentage: preset?.vat_percentage != null ? Number(preset.vat_percentage) : 21,
      _lead: preset?._lead || 'excl',
    };
    _recalcLine(line);
    return line;
  }
  function _recalcLine(line) {
    const rate = Number(line.vat_percentage) || 0;
    if (line._lead === 'incl') {
      const incl = Number(line.amount_incl) || 0;
      line.amount = round2(incl / (1 + rate / 100));
    } else {
      const excl = Number(line.amount) || 0;
      line.amount_incl = round2(excl * (1 + rate / 100));
    }
  }
  function _subInclPerTerm(s) {
    return asArr(s.line_items).reduce((sum, l) => sum + (Number(l.amount_incl) || 0), 0);
  }
  function _calcEnd(startStr, tc) {
    if (!startStr) return '';
    const d = new Date(startStr);
    if (isNaN(d.getTime())) return '';
    d.setMonth(d.getMonth() + (Math.max(1, Number(tc) || 1) - 1));
    d.setDate(d.getDate() + 2);
    return d.toISOString().slice(0, 10);
  }
  function _recomputeEnds() {
    for (const s of _sub.subscriptions) {
      s.end_date = _calcEnd(s.start_date, s.term_count);
    }
  }
  function _prefillFromDeal() {
    const d = _sub.deal || {};
    const today = new Date().toISOString().slice(0, 10);
    // Aanbetaling-sub (indien payment_downpayment_amount > 0)
    const dp = Number(d.payment_downpayment_amount) || 0;
    const tc = Number(d.payment_term_count) || 0;
    const tAmt = Number(d.payment_term_amount) || 0;

    if (dp > 0) {
      _sub.subscriptions.push({
        description: 'Aanbetaling',
        term_count: 1,
        start_date: (d.payment_downpayment_date || d.start_date || today).slice(0, 10),
        end_date: '',
        line_items: [_newLine({ description: 'Aanbetaling', amount: dp / 1.21, vat_percentage: 21, _lead: 'incl', amount_incl: dp })],
      });
    }
    if (tc > 0 && tAmt > 0) {
      _sub.subscriptions.push({
        description: 'Termijnen',
        term_count: tc,
        start_date: (d.payment_term_start_date || d.payment_start_date || d.start_date || today).slice(0, 10),
        end_date: '',
        line_items: [_newLine({ description: 'Cursus-termijn', amount: tAmt / 1.21, vat_percentage: 21, _lead: 'incl', amount_incl: tAmt })],
      });
    }
    if (_sub.subscriptions.length === 0) {
      // Fallback: 1 lege sub
      _addBlankSub();
    }
    _recomputeEnds();
  }

  // ── Validation ─────────────────────────────────────────────────────────
  function _validateStep(step) {
    _sub.globalError = null;
    if (step === 1) {
      if (_sub.mode === 'standalone' && !_sub.customer) {
        _sub.globalError = 'Kies een klant voordat je verdergaat.';
        if (window.DFO?.render) window.DFO.render();
        return false;
      }
    }
    if (step === 2) {
      if (!_sub.tl_department_id) { _sub.globalError = 'Kies een entiteit.'; if (window.DFO?.render) window.DFO.render(); return false; }
      if (!_sub.subscriptions.length) { _sub.globalError = 'Voeg minstens één abonnement toe.'; if (window.DFO?.render) window.DFO.render(); return false; }
      for (const s of _sub.subscriptions) {
        if (!s.description || !s.description.trim()) { _sub.globalError = 'Elk abonnement heeft een omschrijving nodig.'; if (window.DFO?.render) window.DFO.render(); return false; }
        if (!s.start_date) { _sub.globalError = 'Elk abonnement heeft een startdatum nodig.'; if (window.DFO?.render) window.DFO.render(); return false; }
        if (new Date(s.start_date) < new Date(new Date().toISOString().slice(0, 10))) { _sub.globalError = 'Startdatum mag niet in het verleden liggen.'; if (window.DFO?.render) window.DFO.render(); return false; }
        if (!(Number(s.term_count) >= 1)) { _sub.globalError = 'Aantal termijnen moet ≥ 1 zijn.'; if (window.DFO?.render) window.DFO.render(); return false; }
        if (!s.line_items.length) { _sub.globalError = 'Elke abonnement heeft minstens één regel nodig.'; if (window.DFO?.render) window.DFO.render(); return false; }
        for (const l of s.line_items) {
          if ((Number(l.amount) || 0) <= 0) { _sub.globalError = 'Regel-bedrag (excl.) moet > 0 zijn.'; if (window.DFO?.render) window.DFO.render(); return false; }
        }
      }
    }
    return true;
  }

  // ── Handlers (uncontrolled inputs) ─────────────────────────────────────
  window.__subwSetField = (path, val) => {
    // path = 'tl_department_id' | 'sale_type' | 'sync_to_tl' | 'bypassReason'
    if (path === 'sync_to_tl') _sub.sync_to_tl = !!val;
    else _sub[path] = val;
  };
  window.__subwToggleBypass = (on) => { _sub.bypassFee = !!on; if (window.DFO?.render) window.DFO.render(); };
  window.__subwSetBypassReason = (v) => { _sub.bypassReason = String(v || ''); _refreshBypassHint(); };
  window.__subwSubField = (i, field, val) => {
    const s = _sub.subscriptions[i]; if (!s) return;
    s[field] = val;
    if (field === 'start_date' || field === 'term_count') {
      s.end_date = _calcEnd(s.start_date, s.term_count);
      _updateEndInDom(i, s.end_date);
      _updateTotals();
    }
  };
  window.__subwLineField = (subI, lineI, field, val) => {
    const s = _sub.subscriptions[subI]; if (!s) return;
    const l = s.line_items[lineI]; if (!l) return;
    if (field === 'amount' || field === 'amount_incl') {
      l._lead = field === 'amount_incl' ? 'incl' : 'excl';
      l[field] = Number(val) || 0;
      _recalcLine(l);
      _updateLineInDom(subI, lineI, l);
      _updateTotals();
    } else if (field === 'vat_percentage') {
      l.vat_percentage = Number(val) || 0;
      _recalcLine(l);
      if (window.DFO?.render) window.DFO.render();
    } else {
      l[field] = val;
    }
  };
  window.__subwAddSub = () => { _addBlankSub(); if (window.DFO?.render) window.DFO.render(); };
  window.__subwRemoveSub = (i) => { if (_sub.subscriptions.length <= 1) return; _sub.subscriptions.splice(i, 1); if (window.DFO?.render) window.DFO.render(); };
  window.__subwAddLine = (subI) => { const s = _sub.subscriptions[subI]; if (!s) return; s.line_items.push(_newLine()); if (window.DFO?.render) window.DFO.render(); };
  window.__subwRemoveLine = (subI, lineI) => { const s = _sub.subscriptions[subI]; if (!s) return; if (s.line_items.length <= 1) return; s.line_items.splice(lineI, 1); if (window.DFO?.render) window.DFO.render(); };

  // Surgical DOM-updates (behoud cursor)
  function _updateEndInDom(subI, end) {
    const el = document.querySelector(`[data-subw-end="${subI}"]`);
    if (el) el.textContent = end || '—';
  }
  function _updateLineInDom(subI, lineI, l) {
    const box = document.querySelector(`[data-subw-line="${subI}-${lineI}"]`);
    if (!box) return;
    if (l._lead === 'incl') { const inp = box.querySelector('[data-subw-amt]');    if (inp) inp.value = l.amount.toFixed(2); }
    else                    { const inp = box.querySelector('[data-subw-amtincl]'); if (inp) inp.value = l.amount_incl.toFixed(2); }
  }
  function _updateTotals() {
    const total = _sub.subscriptions.reduce((sum, s) => sum + _subInclPerTerm(s) * (Number(s.term_count) || 1), 0);
    const el = document.querySelector('[data-subw-total]'); if (el) el.textContent = eur(total);
    _sub.subscriptions.forEach((s, i) => {
      const subEl = document.querySelector(`[data-subw-subtotal="${i}"]`);
      if (subEl) subEl.textContent = eur(_subInclPerTerm(s) * (Number(s.term_count) || 1));
    });
  }
  function _refreshBypassHint() {
    const hint = document.querySelector('[data-subw-bypass-hint]');
    if (!hint) return;
    const len = (_sub.bypassReason || '').trim().length;
    hint.textContent = len >= 10 ? '✓ Reden voldoet (' + len + ' tekens)' : 'Nog ' + (10 - len) + ' teken(s) nodig';
    hint.style.color = len >= 10 ? 'var(--emerald)' : 'var(--amber)';
  }

  // ── Klant-zoeker (standalone) ──────────────────────────────────────────
  let _searchTimer = null;
  window.__subwCustSearch = (v) => {
    _sub.custSearch = String(v || '');
    if (_searchTimer) clearTimeout(_searchTimer);
    _searchTimer = setTimeout(async () => {
      const q = _sub.custSearch.trim();
      if (q.length < 2) { _sub.custResults = []; if (window.DFO?.render) window.DFO.render(); return; }
      _sub.custSearching = true; if (window.DFO?.render) window.DFO.render();
      const j = await tryFetch('cust-search', '/api/sales-customers?search=' + encodeURIComponent(q));
      _sub.custSearching = false;
      _sub.custResults = asArr(j?.customers).slice(0, 15);
      if (window.DFO?.render) window.DFO.render();
    }, 250);
  };
  window.__subwCustPick = (id) => {
    const c = _sub.custResults.find((x) => x.id === id);
    if (!c) return;
    _sub.customer = c;
    _sub.custResults = [];
    _sub.custSearch = '';
    if (_sub.subscriptions.length === 0) _addBlankSub();
    if (window.DFO?.render) window.DFO.render();
  };
  window.__subwCustClear = () => { _sub.customer = null; if (window.DFO?.render) window.DFO.render(); };

  // ── Submit ─────────────────────────────────────────────────────────────
  window.__subwSubmit = async (withTL) => {
    if (_sub.submitting) return;
    if (!_validateStep(2)) { _sub.step = 2; if (window.DFO?.render) window.DFO.render(); return; }
    if (_sub.bypassFee) {
      const r = (_sub.bypassReason || '').trim();
      if (r.length < 10) { _sub.globalError = 'Reden voor bypass moet minimaal 10 tekens zijn.'; if (window.DFO?.render) window.DFO.render(); return; }
    }
    _sub.submitting = true; _sub.globalError = null;
    if (window.DFO?.render) window.DFO.render();

    const payload = {
      tl_department_id: _sub.tl_department_id,
      first_call_at: null,
      sync_to_tl: withTL !== false,
      subscriptions: _sub.subscriptions.map((s) => ({
        description: String(s.description || '').trim(),
        term_count: Number(s.term_count) || 1,
        start_date: s.start_date,
        end_date: s.end_date || _calcEnd(s.start_date, s.term_count),
        line_items: asArr(s.line_items).map((l) => ({
          product_id: l.product_id || null,
          description: String(l.description || '').trim(),
          amount: round2(l.amount),
          vat_percentage: Number(l.vat_percentage) || 0,
        })),
      })),
    };
    if (_sub.mode === 'deal' && _sub.dealId) payload.deal_id = _sub.dealId;
    else {
      payload.mode = 'standalone';
      payload.sale_type = _sub.sale_type;
      if (_sub.customer?.id) payload.matched_customer_id = _sub.customer.id;
    }
    if (_sub.bypassFee) {
      payload.bypass_reservation_fee = true;
      payload.bypass_reason = (_sub.bypassReason || '').trim();
    }

    try {
      const j = await window.KV.authedJson('/api/sales-subscription-create', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      const tlPart = j?.tl_failed ? ` (${j.tl_failed} TL-sync mislukt)` : (j?.tl_pushed ? ' + TL gesynced' : '');
      window.KV.toast(`Abonnement${(j?.subscription_ids?.length || 0) > 1 ? 'en' : ''} aangemaakt${tlPart}`);
      _sub.submitting = false;
      window.__subwClose();
    } catch (e) {
      _sub.submitting = false;
      _sub.globalError = e?.message || 'Aanmaken mislukt';
      if (window.DFO?.render) window.DFO.render();
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────
  function _renderProgress() {
    const items = [
      { n: 1, l: _sub.mode === 'deal' ? 'Klant & offerte' : 'Klant' },
      { n: 2, l: 'Abonnementen' },
      { n: 3, l: 'Bonus & bevestigen' },
    ];
    return `<div class="sw-progress">
      ${items.map((it, i) => `
        <button class="sw-progress-step ${_sub.step === it.n ? 'is-active' : ''} ${_sub.step > it.n ? 'is-done' : ''}" onclick="__subwGoStep(${it.n})">
          <span class="sw-progress-dot">${_sub.step > it.n ? '✓' : it.n}</span>${esc(it.l)}
        </button>
        ${i < items.length - 1 ? '<span class="sw-progress-sep"></span>' : ''}
      `).join('')}
    </div>`;
  }

  function _renderStep1() {
    if (_sub.mode === 'deal') {
      const d = _sub.deal;
      const c = _sub.customer;
      if (!d) return `<div class="sw-step"><div style="padding:24px; color:var(--text-2);">Offerte laden…</div></div>`;
      const total = Number(d.amount_total) || 0;
      return `<div class="sw-step">
        <h2 class="sw-step-title">Klant & offerte</h2>
        <p class="sw-step-sub">Controleer of dit de juiste offerte is voor het abonnement.</p>
        <div class="kv-onb-meta">
          <div class="kv-onb-meta-row"><span>Klant</span><b>${esc(c?.name || d.customer_name || '—')}</b></div>
          <div class="kv-onb-meta-row"><span>E-mail</span><span>${c?.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '—'}</span></div>
          <div class="kv-onb-meta-row"><span>Offerte-totaal</span><b>${eur(total)}</b></div>
          <div class="kv-onb-meta-row"><span>Getekend op</span><span>${d.tl_quotation_signed_at ? new Date(d.tl_quotation_signed_at).toLocaleDateString('nl-NL') : '—'}</span></div>
          <div class="kv-onb-meta-row"><span>Aanbetaling</span><span>${d.payment_downpayment_amount ? eur(d.payment_downpayment_amount) : '—'}</span></div>
          <div class="kv-onb-meta-row"><span>Termijnen</span><span>${d.payment_term_count ? (d.payment_term_count + '× ' + eur(d.payment_term_amount)) : '—'}</span></div>
        </div>
        <p class="kv-onb-hint">Als deze prefill niet klopt, kun je in stap 2 alles aanpassen.</p>
      </div>`;
    }
    // Standalone
    const results = _sub.custResults;
    return `<div class="sw-step">
      <h2 class="sw-step-title">Kies klant</h2>
      <p class="sw-step-sub">Zoek een bestaande klant. Voor een nieuwe klant: <a href="/modules/subscription-wizard.html" style="color:var(--m);text-decoration:underline">gebruik de v1-wizard</a> (voegt nieuwe klant + TL-lookup toe).</p>
      ${_sub.customer ? `
        <div class="kv-onb-meta">
          <div class="kv-onb-meta-row"><span>Gekozen klant</span><b>${esc(_sub.customer.name || (_sub.customer.first_name + ' ' + (_sub.customer.last_name || '')))}</b></div>
          <div class="kv-onb-meta-row"><span>E-mail</span><span>${esc(_sub.customer.email || '—')}</span></div>
          <div class="kv-onb-meta-row"><span>&nbsp;</span><span><button class="ds-btn ds-btn-ghost ds-btn-sm" onclick="__subwCustClear()">Wijzigen</button></span></div>
        </div>` : `
        <div class="sw-field">
          <label>Zoek klant op naam of e-mail</label>
          <input class="ib-input" type="text" placeholder="Typ minstens 2 tekens…" value="${esc(_sub.custSearch)}" oninput="__subwCustSearch(this.value)" autofocus>
        </div>
        ${_sub.custSearching ? '<div style="padding:12px; color:var(--text-3); font-style:italic">Zoeken…</div>' : ''}
        ${results.length ? `<div class="subw-cust-results">
          ${results.map((c) => `<button type="button" class="subw-cust-hit" onclick="__subwCustPick('${esc(c.id)}')">
            <div><b>${esc(c.name || (c.first_name + ' ' + (c.last_name || '')))}</b></div>
            <div style="font-size:11.5px; color:var(--text-3)">${esc(c.email || '—')}${c.phone ? ' · ' + esc(c.phone) : ''}</div>
          </button>`).join('')}
        </div>` : (_sub.custSearch.length >= 2 && !_sub.custSearching ? '<div class="kv-onb-empty">Geen klanten gevonden.</div>' : '')}
      `}
    </div>`;
  }

  function _renderStep2() {
    const entOpts = _sub.entities.map((e) => `<option value="${esc(e.tl_department_id)}" ${_sub.tl_department_id === e.tl_department_id ? 'selected' : ''}>${esc(e.label)}</option>`).join('');
    const total = _sub.subscriptions.reduce((sum, s) => sum + _subInclPerTerm(s) * (Number(s.term_count) || 1), 0);
    return `<div class="sw-step">
      <h2 class="sw-step-title">Abonnementen</h2>
      <p class="sw-step-sub">Termijnbedragen zijn <b>excl. BTW</b> in de payload; de <b>incl.-kolom</b> is de leidraad voor klant-communicatie. Wijzig één van beide en de andere volgt.</p>

      <div class="sw-header-row">
        <label class="sw-field"><span>Entiteit</span>
          <select class="ib-input" onchange="__subwSetField('tl_department_id', this.value)">${entOpts}</select>
        </label>
        ${_sub.mode === 'standalone' ? `<label class="sw-field"><span>Type verkoop</span>
          <select class="ib-input" onchange="__subwSetField('sale_type', this.value)">
            <option value="domestic" ${_sub.sale_type === 'domestic' ? 'selected' : ''}>NL binnenlands (21% BTW)</option>
            <option value="intracommunautair" ${_sub.sale_type === 'intracommunautair' ? 'selected' : ''}>Intracommunautair (0% BTW)</option>
          </select>
        </label>` : ''}
      </div>

      ${_sub.subscriptions.map((s, i) => _renderSubCard(s, i)).join('')}

      <div class="sw-action-row">
        <button class="ds-btn ds-btn-ghost ds-btn-sm" onclick="__subwAddSub()">+ Extra abonnement</button>
        <div style="margin-left:auto; font-size:14px; font-weight:600;">Totaal contract-waarde: <span data-subw-total>${eur(total)}</span></div>
      </div>
    </div>`;
  }

  function _renderSubCard(s, i) {
    const canRemove = _sub.subscriptions.length > 1;
    return `<div class="subw-sub-card">
      <div class="subw-sub-head">
        <input class="ib-input" style="flex:1" placeholder="Omschrijving (bv. Aanbetaling, Termijnen)" value="${esc(s.description)}" oninput="__subwSubField(${i}, 'description', this.value)">
        ${canRemove ? `<button class="ds-icon-btn" onclick="__subwRemoveSub(${i})" title="Verwijder abonnement">×</button>` : ''}
      </div>
      <div class="subw-sub-meta">
        <label class="sw-field"><span>Startdatum</span>
          <input class="ib-input" type="date" min="${new Date().toISOString().slice(0, 10)}" value="${esc((s.start_date || '').slice(0, 10))}" onchange="__subwSubField(${i}, 'start_date', this.value)">
        </label>
        <label class="sw-field"><span>Aantal termijnen</span>
          <input class="ib-input" type="number" min="1" value="${esc(String(s.term_count))}" onchange="__subwSubField(${i}, 'term_count', Number(this.value)||1)">
        </label>
        <div class="sw-field"><span>Einddatum (auto)</span>
          <div class="subw-end" data-subw-end="${i}">${s.end_date || '—'}</div>
        </div>
      </div>
      <div class="subw-lines-head">
        <div>Omschrijving</div><div>Excl. BTW</div><div>BTW %</div><div>Incl. BTW</div><div></div>
      </div>
      ${asArr(s.line_items).map((l, li) => `<div class="subw-line" data-subw-line="${i}-${li}">
        <input class="ib-input" type="text" placeholder="Regel-omschrijving" value="${esc(l.description)}" oninput="__subwLineField(${i}, ${li}, 'description', this.value)">
        <input class="ib-input" type="number" step="0.01" min="0" data-subw-amt value="${(l.amount || 0).toFixed(2)}" onchange="__subwLineField(${i}, ${li}, 'amount', this.value)">
        <select class="ib-input" onchange="__subwLineField(${i}, ${li}, 'vat_percentage', Number(this.value))">
          <option value="21" ${Number(l.vat_percentage) === 21 ? 'selected' : ''}>21%</option>
          <option value="9"  ${Number(l.vat_percentage) === 9 ? 'selected' : ''}>9%</option>
          <option value="0"  ${Number(l.vat_percentage) === 0 ? 'selected' : ''}>0%</option>
        </select>
        <input class="ib-input" type="number" step="0.01" min="0" data-subw-amtincl value="${(l.amount_incl || 0).toFixed(2)}" onchange="__subwLineField(${i}, ${li}, 'amount_incl', this.value)">
        <button class="ds-icon-btn" onclick="__subwRemoveLine(${i}, ${li})" ${s.line_items.length <= 1 ? 'disabled' : ''} title="Regel weg">×</button>
      </div>`).join('')}
      <div class="subw-sub-foot">
        <button class="ds-btn ds-btn-ghost ds-btn-sm" onclick="__subwAddLine(${i})">+ Regel</button>
        <div style="margin-left:auto; font-size:13px;">Sub-totaal (${s.term_count}× incl.): <b data-subw-subtotal="${i}">${eur(_subInclPerTerm(s) * (Number(s.term_count) || 1))}</b></div>
      </div>
    </div>`;
  }

  function _renderStep3() {
    const total = _sub.subscriptions.reduce((sum, s) => sum + _subInclPerTerm(s) * (Number(s.term_count) || 1), 0);
    // Bonus: 3% over eerste sub met omschrijving 'Aanbetaling' als ≥€1000 incl
    const dpSub = _sub.subscriptions.find((s) => /aanbetaling/i.test(s.description || ''));
    const dpIncl = dpSub ? _subInclPerTerm(dpSub) : 0;
    const bonus = dpIncl >= 1000 ? round2(dpIncl * 0.03) : 0;
    return `<div class="sw-step">
      <h2 class="sw-step-title">Bonus & bevestigen</h2>
      <p class="sw-step-sub">Controleer het overzicht en bevestig het aanmaken.</p>

      <div class="kv-onb-meta">
        <div class="kv-onb-meta-row"><span>Klant</span><b>${esc(_sub.customer?.name || (_sub.customer?.first_name + ' ' + (_sub.customer?.last_name || '')) || _sub.deal?.customer_name || '—')}</b></div>
        <div class="kv-onb-meta-row"><span>Aantal abonnementen</span><span>${_sub.subscriptions.length}</span></div>
        <div class="kv-onb-meta-row"><span>Totale contract-waarde</span><b>${eur(total)}</b></div>
        <div class="kv-onb-meta-row"><span>Bonus (3% aanbetaling ≥€1000)</span><span>${bonus > 0 ? '<b style="color:var(--emerald)">' + eur(bonus) + '</b>' : '—'}</span></div>
      </div>

      <div class="sw-preview-box">
        ${_sub.subscriptions.map((s) => `<div class="sw-preview-sub">
          <div style="font-weight:600">${esc(s.description || '(zonder omschrijving)')} · ${s.term_count}× · start ${esc(s.start_date)}</div>
          ${asArr(s.line_items).map((l) => `<div style="font-size:12px; color:var(--text-2); padding-left:12px">${esc(l.description || '—')} · ${eur(l.amount)} excl · ${l.vat_percentage}% → <b>${eur(l.amount_incl)} incl./termijn</b></div>`).join('')}
          <div style="text-align:right; font-size:12.5px; margin-top:4px">Sub-totaal: <b>${eur(_subInclPerTerm(s) * s.term_count)}</b></div>
        </div>`).join('')}
      </div>

      ${_renderBypassCard()}

      <label style="display:flex; align-items:center; gap:8px; margin:12px 0; font-size:13px;">
        <input type="checkbox" ${_sub.sync_to_tl ? 'checked' : ''} onchange="__subwSetField('sync_to_tl', this.checked); this.blur();">
        Ook naar TeamLeader syncen (aanbevolen)
      </label>
    </div>`;
  }

  function _renderBypassCard() {
    if (!_sub.rbacChecked) return `<div class="kv-onb-hint" style="margin-top:12px">Rechten controleren…</div>`;
    if (!_sub.rbacBypass) return '';
    return `<div class="subw-bypass-card">
      <label style="display:flex; align-items:flex-start; gap:8px;">
        <input type="checkbox" ${_sub.bypassFee ? 'checked' : ''} onchange="__subwToggleBypass(this.checked)">
        <span>
          <b>€${RESERVATION_FEE_INCL} reserveringsfee bypassen</b><br>
          <span style="font-size:11.5px; color:var(--text-2)">Alleen in uitzonderlijke gevallen. Reden wordt persistent gelogd in audit-trail.</span>
        </span>
      </label>
      ${_sub.bypassFee ? `<div style="margin-top:10px">
        <textarea class="ib-input" rows="3" placeholder="Waarom wordt de fee omzeild? (min 10 tekens)" oninput="__subwSetBypassReason(this.value)">${esc(_sub.bypassReason)}</textarea>
        <div class="kv-onb-hint" data-subw-bypass-hint style="margin-top:4px; color:var(--amber)">${(_sub.bypassReason.trim().length >= 10 ? '✓ Reden voldoet' : 'Nog ' + (10 - _sub.bypassReason.trim().length) + ' teken(s) nodig')}</div>
      </div>` : ''}
    </div>`;
  }

  function _renderFoot() {
    const isFirst = _sub.step === 1;
    const isLast = _sub.step === 3;
    return `<div class="sw-modal-foot">
      <button class="ds-btn ds-btn-ghost" onclick="__subwClose()" ${_sub.submitting ? 'disabled' : ''}>Annuleren</button>
      <div style="flex:1"></div>
      ${!isFirst ? `<button class="ds-btn ds-btn-ghost" onclick="__subwGoStep(${_sub.step - 1})" ${_sub.submitting ? 'disabled' : ''}>← Vorige</button>` : ''}
      ${!isLast ? `<button class="ds-btn ds-btn-primary" onclick="__subwGoStep(${_sub.step + 1})">Volgende →</button>` : `
        <button class="ds-btn ds-btn-ghost" onclick="__subwSubmit(false)" ${_sub.submitting ? 'disabled' : ''}>${_sub.submitting ? 'Bezig…' : 'Alleen lokaal opslaan'}</button>
        <button class="ds-btn ds-btn-primary" onclick="__subwSubmit(true)" ${_sub.submitting ? 'disabled' : ''}>${_sub.submitting ? 'Aanmaken…' : 'Aanmaken + TL-sync'}</button>
      `}
    </div>`;
  }

  // ── Full wizard view (returnt HTML zoals sales-wizard-v2) ──────────────
  function renderWizard() {
    const stepHtml = _sub.step === 1 ? _renderStep1() : _sub.step === 2 ? _renderStep2() : _renderStep3();
    return `<div class="sw-modal-back is-open" onclick="if(event.target===this)__subwClose()">
      <div class="sw-modal">
        <div class="sw-modal-head">
          <div class="sw-modal-title">${_sub.mode === 'deal' ? 'Omzetten naar abonnement' : 'Nieuw abonnement'}</div>
          <button class="ds-icon-btn" onclick="__subwClose()" ${_sub.submitting ? 'disabled' : ''}>×</button>
        </div>
        <div class="sw-modal-body">
          ${_renderProgress()}
          ${_sub.globalError ? `<div class="kv-edit-banner" style="margin:12px 22px">${esc(_sub.globalError)}</div>` : ''}
          ${stepHtml}
        </div>
        ${_renderFoot()}
      </div>
    </div>`;
  }

  // ── Klanten-view wrap (renders wizard-overlay als open) ────────────────
  // Hook: wrap DFO.render zodat wizard-HTML op #content wordt toegevoegd
  // wanneer _sub.open is. Analoog aan sales-wizard-v2.
  const origContent = window.DFO.render;
  // Er is geen goede plek om te injecteren zonder de host-view te breken.
  // In plaats daarvan: klanten-v2.js host-view rendert '<div id="kv-view">…</div>'
  // gevolgd door onze wizard-overlay indien open. We doen dat door de wizard-
  // HTML aan document.body toe te voegen bij render, en te verwijderen bij close.
  function _mountOverlay() {
    let el = document.getElementById('subw-overlay-root');
    if (!el) {
      el = document.createElement('div');
      el.id = 'subw-overlay-root';
      document.body.appendChild(el);
    }
    el.innerHTML = _sub.open ? renderWizard() : '';
  }
  // Hook DFO.render → run overlay mount after original render
  if (!window.DFO.__subwOverlayHooked) {
    window.DFO.__subwOverlayHooked = true;
    const _origRender = window.DFO.render;
    window.DFO.render = function () {
      const r = _origRender.apply(this, arguments);
      queueMicrotask(_mountOverlay);
      return r;
    };
    // Initial mount
    queueMicrotask(_mountOverlay);
  }

  console.debug('[subw-v2] loaded — window.__subwOpen({dealId?, customerId?}) beschikbaar');
})();
