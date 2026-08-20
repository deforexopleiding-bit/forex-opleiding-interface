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

  // Vaste "Omschrijving abonnement"-presets (parity-verzoek 2026-08-12).
  // "— Kies omschrijving —" (waarde = '') is de neutrale default.
  // "Andere omschrijving…" is een sentinel → toont freetext-input.
  const DESC_PRESETS = [
    { v: '',                                    l: '— Kies omschrijving —' },
    { v: 'Aanbetaling',                         l: 'Aanbetaling' },
    { v: 'Maandelijkse termijnen',              l: 'Maandelijkse termijnen' },
    { v: '1-op-1 Begeleiding (6/12/24 maanden)', l: '1-op-1 Begeleiding (6/12/24 maanden)' },
    { v: 'Membership (12/36 Maanden)',          l: 'Membership (12/36 Maanden)' },
  ];

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

    _rerender();
    _loadRefData();      // entities + products + trajecten (parallel)
    _loadRbac();
    if (_sub.mode === 'deal') await _loadDealAndPrefill(_sub.dealId);
    else if (opts?.customerId) await _loadCustomerById(opts.customerId);
    else _addBlankSub();
    _rerender();
  };
  window.__subwClose = () => {
    if (_sub.submitting) return;
    _sub.open = false;
    _clearUrlSignal();
    _rerender();
  };
  window.__subwGoStep = (n) => {
    if (n < 1 || n > 3) return;
    if (n > 1 && !_validateStep(1)) return;
    if (n > 2 && !_validateStep(2)) return;
    _sub.step = n; _sub.globalError = null;
    _rerender();
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
    // API-response: { trajects: [{name, variants:[{name}], is_active}] } —
    // NIET 'trajecten' (dat gaf altijd []). Zie recon 2026-08-12.
    _sub.trajecten = asArr(traj?.trajects);
    // Default entity = eerste
    if (!_sub.tl_department_id && _sub.entities.length) _sub.tl_department_id = _sub.entities[0].tl_department_id || '';
    _rerender();
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
    _rerender();
  }
  async function _loadDealAndPrefill(dealId) {
    const j = await tryFetch('deal-detail', '/api/sales-deal-detail?id=' + encodeURIComponent(dealId));
    if (!j) { _sub.globalError = 'Kon offerte niet laden'; return; }
    _sub.deal = j.deal || null;
    _sub.customer = j.customer || null;
    _sub.lineItemsDeal = asArr(j.line_items);
    // Server-berekend excl/incl totaal (mix-safe over BTW-tarieven).
    // NIET van deal.amount_total (bestaat niet); van j.totals.{excl,incl}.
    _sub.dealTotals = j.totals || null;
    _prefillFromDeal();
  }
  async function _loadCustomerById(customerId) {
    const j = await tryFetch('customer', '/api/sales-customer?id=' + encodeURIComponent(customerId));
    if (j?.customer) _sub.customer = j.customer;
    _addBlankSub();
  }
  // Offerte-picker (standalone-mode, na klant-keuze): open offertes van deze
  // klant. Fetch éénmalig per customer_id-wissel.
  async function _loadOfferPickerForCustomer(customerId) {
    if (!customerId) { _sub.offerPickerList = []; return; }
    // In-flight guard — voorkomt oneindige loop wanneer _renderStep1 op elke
    // render een queueMicrotask spawnt terwijl deze fetch nog loopt.
    if (_sub.offerPickerLoading) return;
    // Cache-guard — Array.isArray check ipv truthy (lege lijst is óók geldig).
    if (_sub.offerPickerCustomerId === customerId && Array.isArray(_sub.offerPickerList)) return;
    _sub.offerPickerLoading = true;
    _sub.offerPickerCustomerId = customerId;
    // Zet list op [] zodat een parallelle guard-check in een render-tick
    // Array.isArray === true ziet en niet nogmaals proberen te fetchen.
    _sub.offerPickerList = [];
    _rerender();
    const j = await tryFetch('quotations', '/api/sales-quotations?customer_id=' + encodeURIComponent(customerId) + '&page_size=100');
    _sub.offerPickerLoading = false;
    // Alleen relevante offertes: getekend/accepted, geen abonnement gekoppeld, niet-markeerd
    const raw = asArr(j?.quotations);
    _sub.offerPickerList = raw.filter((q) => {
      const st = String(q?.tl_quotation_status || '').toLowerCase();
      const usable = st === 'accepted' || st === 'signed';
      const busy   = !!q?.has_linked_subscription || !!q?.subscription_marked_done;
      return usable && !busy;
    });
    _rerender();
  }
  // Pick offerte in standalone-mode → prefill regels + totalen.
  window.__subwPickOffer = async (dealId) => {
    if (!dealId) return;
    _sub.subscriptions = []; // reset — prefill vult opnieuw
    _sub.dealId = dealId;
    // Blijf in 'standalone' mode; alleen line-items komen uit deze offerte.
    await _loadDealAndPrefill(dealId);
    _rerender();
  };

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
    // BUGFIX 2026-08-12: preset.amount_incl werd genegeerd — altijd 0 gezet.
    // Bij _lead='incl' rekende _recalcLine dan amount = 0/(1+rate) = 0. Alle
    // fixed-split regels (aanbetaling/termijnen) stonden hierdoor op €0
    // ondanks correcte target. Fix: preset.amount_incl doorgeven.
    const line = {
      product_id: preset?.product_id || '',
      description: preset?.description || '',
      amount:       preset?.amount      != null ? round2(preset.amount)      : 0,
      amount_incl:  preset?.amount_incl != null ? round2(preset.amount_incl) : 0,
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
  // BTW-mix parity: bewaart per-line vat_percentage (21% / 9% / 0%) uit
  // offerte i.p.v. alles op 21% te forceren. Overgenomen uit v1
  // subscription-wizard.html linesFromOffer() (regel 574-590) +
  // splitFromOffer (regel 542-566).
  //
  // Strategie:
  // 1. Als offerte-line_items beschikbaar: gebruik die 1-op-1 (met eigen BTW).
  // 2. Split over aanbetaling + termijnen proportioneel per BTW-groep (op basis
  //    van excl-gewicht), zodat de mix bewaard blijft.
  // 3. Fallback naar 1 lege sub als er niets bruikbaar is.
  // Bewaar RUWE prefill-signalen voor het ?debug=1 panel — Jeffrey ziet
  // zo exact welke velden uit de offerte-payload gebruikt zijn.
  const _prefillDebug = { lines: [], choice: null, aanbetaling: null, termijnen: null, splits: [] };

  function _linesFromOfferDefault() {
    const lis = asArr(_sub.lineItemsDeal);
    if (!lis.length) return [_newLine()];
    const factor = 1 - (Number(_sub.deal?.discount_percentage) || 0) / 100;
    const zeroVat = _sub.deal?.sale_type && _sub.deal.sale_type !== 'domestic';
    return lis.map((l) => {
      const qty  = Number(l.quantity) || 1;
      const unit = Number(l.unit_price) || 0;
      const vatN = Number(l.vat_percentage);
      const vat  = zeroVat ? 0 : ((vatN != null && !Number.isNaN(vatN)) ? vatN : 21);
      const rate = vat / 100;
      const gross = qty * unit;
      // price_includes_vat → unit is INCL-BTW; server-side rekent dan
      // excl = gross/(1+rate). Zonder deze flag was unit al excl.
      const exclBefore = l.price_includes_vat ? gross / (1 + rate) : gross;
      const excl = round2(exclBefore * factor);
      return _newLine({
        product_id: l.product_id || '',
        description: String(l.description || l.product_name || '').trim() || 'Regel',
        amount: excl,
        vat_percentage: vat,
        _lead: 'excl',
      });
    });
  }
  // ── Vaste 2/3 @ 21% (1-op-1 Begeleiding) + 1/3 @ 9% (E-book) split.
  // Vervangt de proportionele split die eerder ratio-invariant leek maar
  // in praktijk €0 gaf zodra offerte-line_items ontbraken of unit_price
  // niet consistent was. Aanbetaling én termijnen delen deze vaste
  // regels; alleen omschrijvingen verschillen (kind='aanbetaling' vs '').
  function _fixedSplitLines(targetIncl, kind) {
    const tgt = Number(targetIncl) || 0;
    const incl21 = round2(tgt * 2 / 3);
    const incl9  = round2(tgt * 1 / 3);
    const suf = kind ? ' (' + kind + ')' : '';
    // Log split-berekening voor het ?debug=1 panel.
    try { _prefillDebug.splits.push({ kind: kind || 'termijn', target: tgt, incl21, incl9 }); } catch (_) {}
    return [
      _newLine({
        description: '1-op-1 Begeleiding' + suf,
        vat_percentage: 21,
        _lead: 'incl',
        amount_incl: incl21,
      }),
      _newLine({
        description: 'E-book' + suf,
        vat_percentage: 9,
        _lead: 'incl',
        amount_incl: incl9,
      }),
    ];
  }

  function _prefillFromDeal() {
    const d = _sub.deal || {};
    const today = new Date().toISOString().slice(0, 10);
    const dp = Number(d.payment_downpayment_amount) || 0;
    const tc = Number(d.payment_term_count) || 0;
    const tAmt = Number(d.payment_term_amount) || 0;
    const totalIncl = Number(_sub.dealTotals?.incl) || 0;

    // Debug-snapshot van ruwe payload-velden (zichtbaar in ?debug=1 panel).
    _prefillDebug.lines = asArr(_sub.lineItemsDeal).map((l) => ({
      description: l.description || l.product_name || null,
      quantity: l.quantity, unit_price: l.unit_price,
      vat_percentage: l.vat_percentage,
      price_includes_vat: !!l.price_includes_vat,
      product_id: l.product_id || null,
    }));
    _prefillDebug.aanbetaling = dp;
    _prefillDebug.termijnen   = { count: tc, amount_per_termijn: tAmt };
    _prefillDebug.splits      = []; // reset per prefill-run
    _prefillDebug.totalIncl   = totalIncl;
    _prefillDebug.discount    = Number(d.discount_percentage) || 0;
    _prefillDebug.sale_type   = d.sale_type || 'domestic';

    if (dp > 0) {
      // VASTE split 2/3 @21% + 1/3 @9%. NIET afgeleid uit offerte-lines
      // (die kunnen ongelijkelijk zijn); regel-naam = "Aanbetaling",
      // twee line-items (1-op-1 Begeleiding + E-book) met eigen BTW.
      _sub.subscriptions.push({
        description: 'Aanbetaling',
        term_count: 1,
        start_date: (d.payment_downpayment_date || d.start_date || today).slice(0, 10),
        end_date: '',
        line_items: _fixedSplitLines(dp, 'aanbetaling'),
      });
      _prefillDebug.choice = _prefillDebug.choice || 'aanbetaling+termijnen(fixed)';
    }
    if (tc > 0 && tAmt > 0) {
      // Zelfde vaste split per termijn: 2/3 @21% + 1/3 @9%.
      _sub.subscriptions.push({
        description: 'Maandelijkse termijnen',
        term_count: tc,
        start_date: (d.payment_term_start_date || d.payment_start_date || d.start_date || today).slice(0, 10),
        end_date: '',
        line_items: _fixedSplitLines(tAmt, ''),
      });
      _prefillDebug.choice = _prefillDebug.choice || 'termijnen-only(fixed)';
    }
    // Geen aanbetaling/termijnen-data, maar wel line-items:
    // 1-op-1 mapping vanuit offerte (per regel eigen BTW).
    if (_sub.subscriptions.length === 0 && asArr(_sub.lineItemsDeal).length) {
      _sub.subscriptions.push({
        description: '',
        term_count: 1,
        start_date: (d.start_date || today).slice(0, 10),
        end_date: '',
        line_items: _linesFromOfferDefault(),
      });
      _prefillDebug.choice = 'default(1-op-1 vanuit offerte-lines)';
    }
    if (_sub.subscriptions.length === 0) {
      _addBlankSub();
      _prefillDebug.choice = 'leeg (geen offerte-data bruikbaar)';
    }
    // Zorg dat elke line-actuele amount_incl heeft (bij lead=excl).
    for (const s of _sub.subscriptions) for (const l of asArr(s.line_items)) _recalcLine(l);
    _recomputeEnds();

    console.debug('[subw-v2] prefill-choice:', _prefillDebug.choice, {
      dp, tc, tAmt, totalIncl, discount: _prefillDebug.discount,
      lineCount: _prefillDebug.lines.length,
    });
  }

  // ── Validation ─────────────────────────────────────────────────────────
  function _validateStep(step) {
    _sub.globalError = null;
    if (step === 1) {
      if (_sub.mode === 'standalone' && !_sub.customer) {
        _sub.globalError = 'Kies een klant voordat je verdergaat.';
        _rerender();
        return false;
      }
    }
    if (step === 2) {
      if (!_sub.tl_department_id) { _sub.globalError = 'Kies een entiteit.'; _rerender(); return false; }
      if (!_sub.subscriptions.length) { _sub.globalError = 'Voeg minstens één abonnement toe.'; _rerender(); return false; }
      for (const s of _sub.subscriptions) {
        if (!s.description || !s.description.trim()) { _sub.globalError = 'Elk abonnement heeft een omschrijving nodig.'; _rerender(); return false; }
        if (!s.start_date) { _sub.globalError = 'Elk abonnement heeft een startdatum nodig.'; _rerender(); return false; }
        if (new Date(s.start_date) < new Date(new Date().toISOString().slice(0, 10))) { _sub.globalError = 'Startdatum mag niet in het verleden liggen.'; _rerender(); return false; }
        if (!(Number(s.term_count) >= 1)) { _sub.globalError = 'Aantal termijnen moet ≥ 1 zijn.'; _rerender(); return false; }
        if (!s.line_items.length) { _sub.globalError = 'Elke abonnement heeft minstens één regel nodig.'; _rerender(); return false; }
        for (const l of s.line_items) {
          if ((Number(l.amount) || 0) <= 0) { _sub.globalError = 'Regel-bedrag (excl.) moet > 0 zijn.'; _rerender(); return false; }
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
  window.__subwToggleBypass = (on) => { _sub.bypassFee = !!on; _rerender(); };
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
      // Surgical: BEIDE inputs updaten (excl én incl), zonder full re-render.
      // Vermijdt cursor-verlies en dropdown-close bij snelle wissel.
      const box = document.querySelector(`[data-subw-line="${subI}-${lineI}"]`);
      if (box) {
        const inpExcl = box.querySelector('[data-subw-amt]');
        const inpIncl = box.querySelector('[data-subw-amtincl]');
        if (inpExcl && document.activeElement !== inpExcl) inpExcl.value = (l.amount || 0).toFixed(2);
        if (inpIncl && document.activeElement !== inpIncl) inpIncl.value = (l.amount_incl || 0).toFixed(2);
      }
      _updateTotals();
    } else {
      l[field] = val;
    }
  };
  // Omschrijving-preset dropdown-handler: __custom__ → freetext-input tonen;
  // andere waarde → description direct zetten en text-input verbergen.
  window.__subwSetDesc = (subI, val) => {
    const s = _sub.subscriptions[subI]; if (!s) return;
    if (val === '__custom__') {
      s._customDesc = true;
      // Leeg maken; user typt zelf. Structurele re-render nodig om input te tonen.
      s.description = '';
      _rerender();
      // Focus freetext-input na volgende paint.
      queueMicrotask(() => {
        const el = document.querySelector(`[data-subw-sub-desc="${subI}"]`);
        if (el) el.focus();
      });
    } else {
      s._customDesc = false;
      s.description = val || '';
      _rerender(); // structureel: freetext-input verbergen als 'ie zichtbaar was
    }
  };

  // TRAJECT-preset: prefill sub-description vanuit traject + variant.
  window.__subwPickTraject = (subI, comboValue) => {
    const s = _sub.subscriptions[subI]; if (!s) return;
    // comboValue = "trajectIdx:variantIdx" of "" (custom)
    if (!comboValue) return;
    const [ti, vi] = comboValue.split(':').map((n) => Number(n));
    const t = _sub.trajecten[ti]; if (!t) return;
    const v = asArr(t.variants)[vi];
    const label = v ? `${t.name} > ${v.name}` : t.name;
    s.description = label;
    // Surgical DOM update: alleen omschrijving-input
    const box = document.querySelector(`[data-subw-sub-desc="${subI}"]`);
    if (box && document.activeElement !== box) box.value = label;
  };
  window.__subwAddSub = () => { _addBlankSub(); _rerender(); };
  window.__subwRemoveSub = (i) => { if (_sub.subscriptions.length <= 1) return; _sub.subscriptions.splice(i, 1); _rerender(); };
  window.__subwAddLine = (subI) => { const s = _sub.subscriptions[subI]; if (!s) return; s.line_items.push(_newLine()); _rerender(); };
  window.__subwRemoveLine = (subI, lineI) => { const s = _sub.subscriptions[subI]; if (!s) return; if (s.line_items.length <= 1) return; s.line_items.splice(lineI, 1); _rerender(); };

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
  // De input zelf gebruikt H.stableSearch + H.onSearch (registratie bij
  // module-init onderaan). De input-DOM-node overleeft renders → geen
  // cursor-verlies, geen hang. Zoek-callback update alleen de results-slot
  // (H.setListHTML) — nooit een full re-render.
  window.__subwCustPick = (id) => {
    const c = _sub.custResults.find((x) => x.id === id);
    if (!c) return;
    _sub.customer = c;
    _sub.custResults = [];
    if (H.setSearchValue) H.setSearchValue('subw:cust', '');
    if (H.setListHTML)    H.setListHTML('subw:cust-results', '');
    if (_sub.subscriptions.length === 0) _addBlankSub();
    _rerender(); // structureel: customer-block vervangt zoekveld
  };
  window.__subwCustClear = () => {
    _sub.customer = null;
    _rerender(); // structureel: zoekveld vervangt customer-block
  };

  // ── Submit ─────────────────────────────────────────────────────────────
  window.__subwSubmit = async (withTL) => {
    if (_sub.submitting) return;
    if (!_validateStep(2)) { _sub.step = 2; _rerender(); return; }
    if (_sub.bypassFee) {
      const r = (_sub.bypassReason || '').trim();
      if (r.length < 10) { _sub.globalError = 'Reden voor bypass moet minimaal 10 tekens zijn.'; _rerender(); return; }
    }
    _sub.submitting = true; _sub.globalError = null;
    _rerender();

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
      _rerender();
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
      // Offerte-totaal komt uit server-berekende j.totals.incl (mix-safe over
      // 21%/9%-regels). NIET van d.amount_total (bestaat niet op deal).
      const total = Number(_sub.dealTotals?.incl) || 0;
      return `<div class="sw-step">
        <h2 class="sw-step-title">Klant & offerte</h2>
        <p class="sw-step-sub">Controleer of dit de juiste offerte is voor het abonnement.</p>
        <div class="kv-onb-meta">
          <div class="kv-onb-meta-row"><span>Klant</span><b>${esc(c?.name || d.customer_name || '—')}</b></div>
          <div class="kv-onb-meta-row"><span>E-mail</span><span>${c?.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '—'}</span></div>
          <div class="kv-onb-meta-row"><span>Offerte-totaal (incl.)</span><b>${eur(total)}</b></div>
          <div class="kv-onb-meta-row"><span>Regels op offerte</span><span>${asArr(_sub.lineItemsDeal).length} regel(s)</span></div>
          <div class="kv-onb-meta-row"><span>Getekend op</span><span>${d.tl_quotation_signed_at ? new Date(d.tl_quotation_signed_at).toLocaleDateString('nl-NL') : '—'}</span></div>
          <div class="kv-onb-meta-row"><span>Aanbetaling</span><span>${d.payment_downpayment_amount ? eur(d.payment_downpayment_amount) : '—'}</span></div>
          <div class="kv-onb-meta-row"><span>Termijnen</span><span>${d.payment_term_count ? (d.payment_term_count + '× ' + eur(d.payment_term_amount)) : '—'}</span></div>
        </div>
        <p class="kv-onb-hint">Prefill: aanbetaling én termijnen krijgen een vaste 2/3 @ 21% + 1/3 @ 9% split (1-op-1 Begeleiding + E-book). Geen aanbetaling/termijnen? Dan 1-op-1 vanuit offerte-regels met eigen BTW per product. Aanpassen kan in stap 2.</p>
        ${_renderDebugPanel()}
      </div>`;
    }
    // ── Standalone ──
    // Trigger offerte-picker load zodra klant gekozen is — CONDITIONEEL,
    // maar ook loading en cached-check zodat elke render niet nog een
    // micro-tick spawnt (voorheen root-cause van de klant-pick freeze:
    // render → queueMicrotask → load → _rerender → render → queueMicrotask
    // → oneindige micro-task chain).
    if (_sub.customer?.id
        && !_sub.offerPickerLoading
        && _sub.offerPickerCustomerId !== _sub.customer.id) {
      queueMicrotask(() => _loadOfferPickerForCustomer(_sub.customer.id));
    }
    return `<div class="sw-step">
      <h2 class="sw-step-title">Kies klant</h2>
      <p class="sw-step-sub">Zoek een bestaande klant.</p>
      ${_sub.customer ? `
        <div class="kv-onb-meta">
          <div class="kv-onb-meta-row"><span>Gekozen klant</span><b>${esc(_sub.customer.name || (_sub.customer.first_name + ' ' + (_sub.customer.last_name || '')))}</b></div>
          <div class="kv-onb-meta-row"><span>E-mail</span><span>${esc(_sub.customer.email || '—')}</span></div>
          <div class="kv-onb-meta-row"><span>&nbsp;</span><span><button class="ds-btn ds-btn-ghost ds-btn-sm" onclick="__subwCustClear()">Wijzigen</button></span></div>
        </div>
        ${_renderOfferPicker()}
      ` : `
        <div class="sw-field">
          <label>Zoek klant op naam of e-mail</label>
          ${H.stableSearch('subw:cust', 'Typ minstens 2 tekens…')}
        </div>
        ${H.mountedList('subw:cust-results', '')}
      `}
    </div>`;
  }
  // Debug-panel — alleen zichtbaar met ?debug=1 in de URL. Toont de RUWE
  // waarden uit de offerte-payload zodat Jeffrey kan zien wat er is
  // gelezen (payment_downpayment_amount, payment_term_*, discount %, line-
  // items met quantity/unit_price/vat/price_includes_vat) en welke prefill-
  // route is gekozen (aanbetaling+termijnen(fixed) / termijnen-only /
  // default 1-op-1 / leeg).
  function _renderDebugPanel() {
    let on = false;
    try { on = new URLSearchParams(location.search).get('debug') === '1'; } catch (_) {}
    if (!on) return '';
    const dbg = _prefillDebug;
    const rows = (dbg.lines || []).map((l, i) =>
      `<tr><td>${i}</td><td>${esc(l.description || '—')}</td><td class="mono">${l.quantity ?? '—'}</td><td class="mono">${l.unit_price ?? '—'}</td><td class="mono">${l.vat_percentage ?? '—'}%</td><td>${l.price_includes_vat ? 'incl' : 'excl'}</td></tr>`
    ).join('');
    const splitsHtml = (dbg.splits || []).length
      ? '<div style="margin-top:8px;color:var(--text-2)">Splits (2/3 @21% + 1/3 @9%):<ul style="margin:4px 0 0 18px;padding:0">' +
        dbg.splits.map((s) => `<li class="mono">${esc(s.kind)}: target €${(s.target || 0).toFixed(2)} → 21%-deel €${(s.incl21 || 0).toFixed(2)} incl · 9%-deel €${(s.incl9 || 0).toFixed(2)} incl</li>`).join('') +
        '</ul></div>' : '';
    return `
      <div style="margin-top:14px;padding:12px 14px;background:var(--surface-2,#F5F8FB);border:1px dashed var(--line,#E5EAEF);border-radius:8px;font-size:12px;">
        <div style="font-weight:600;color:var(--text-1,#111721);margin-bottom:8px">🔧 Debug — ruwe prefill-signalen (?debug=1)</div>
        <div class="mono" style="line-height:1.6;color:var(--text-2)">
          prefill-route: <b>${esc(dbg.choice || '—')}</b><br>
          aanbetaling: <b>€${(dbg.aanbetaling ?? 0).toFixed(2)}</b> · termijnen: <b>${dbg.termijnen?.count ?? 0}× €${(dbg.termijnen?.amount_per_termijn ?? 0).toFixed(2)}</b><br>
          totals.incl (server): <b>€${(dbg.totalIncl ?? 0).toFixed(2)}</b> · discount: <b>${(dbg.discount ?? 0)}%</b> · sale_type: <b>${esc(dbg.sale_type || '—')}</b>
        </div>
        ${rows ? `<table style="width:100%;margin-top:8px;font-size:11.5px;border-collapse:collapse">
          <thead><tr style="border-bottom:1px solid var(--line)"><th style="text-align:left">#</th><th style="text-align:left">description</th><th>qty</th><th>unit_price</th><th>vat%</th><th>lead</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>` : '<div style="margin-top:8px;color:var(--text-3)">Geen line-items in offerte-payload.</div>'}
        ${splitsHtml}
      </div>`;
  }

  // Offerte-picker (standalone): 0/1/N open offertes van deze klant.
  function _renderOfferPicker() {
    if (_sub.offerPickerLoading) return `<div class="kv-onb-hint" style="margin-top:14px">Openstaande offertes van deze klant laden…</div>`;
    const list = asArr(_sub.offerPickerList);
    if (!list.length) return `<div class="kv-onb-hint" style="margin-top:14px">Geen openstaande offertes voor deze klant. Ga direct door naar stap 2 om handmatig regels toe te voegen.</div>`;
    const currentDealId = _sub.dealId || '';
    return `
      <div class="kv-onb-section" style="margin-top:14px">
        <div class="kv-onb-section-title">Prefill vanuit een bestaande offerte (optioneel)</div>
        <div style="font-size:12px; color:var(--text-3); margin-bottom:8px;">
          Deze klant heeft ${list.length} openstaande offerte${list.length === 1 ? '' : 's'} zonder gekoppeld abonnement. Kies er één om regels + BTW-mix over te nemen.
        </div>
        <div class="subw-cust-results">
          ${list.map((q) => `<button type="button" class="subw-cust-hit ${currentDealId === q.deal_id ? 'is-active' : ''}" onclick="__subwPickOffer('${esc(q.deal_id)}')">
            <div><b>${esc(q.quote_reference || q.deal_id.slice(0, 8))}</b> · ${esc(q.traject_label || 'Traject onbekend')}</div>
            <div style="font-size:11.5px; color:var(--text-3)">${eur(Number(q.total_amount_incl) || 0)} incl · status <span class="mono">${esc(q.tl_quotation_status || '—')}</span></div>
          </button>`).join('')}
        </div>
        ${currentDealId ? `<div class="kv-onb-hint" style="margin-top:8px;color:var(--emerald)">✓ Prefill actief vanuit offerte ${esc(list.find(q => q.deal_id === currentDealId)?.quote_reference || currentDealId.slice(0, 8))}</div>` : ''}
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
    // ── Vaste "Omschrijving abonnement"-dropdown (parity-verzoek 2026-08-12).
    // Prefill vanuit offerte zet _al_ "Aanbetaling" / "Maandelijkse termijnen";
    // deze select laat de gebruiker per abonnement een preset kiezen of
    // "Andere omschrijving…" openen voor freetext.
    const presetVals = DESC_PRESETS.map((p) => p.v);
    const isCustom = !!s._customDesc || (!!s.description && !presetVals.includes(s.description));
    const selectValue = isCustom ? '__custom__' : (presetVals.includes(s.description) ? s.description : '');
    const presetOpts = DESC_PRESETS.map((p) =>
      `<option value="${esc(p.v)}" ${selectValue === p.v ? 'selected' : ''}>${esc(p.l)}</option>`
    ).join('') + `<option value="__custom__" ${selectValue === '__custom__' ? 'selected' : ''}>Andere omschrijving…</option>`;
    // TRAJECT-preset: kies traject+variant om description te prefillen (optioneel).
    const trajOpts = _sub.trajecten.length
      ? ['<option value="">— Geen traject-preset —</option>']
        .concat(_sub.trajecten.flatMap((t, ti) => {
          if (!t) return [];
          const vs = asArr(t.variants).filter((v) => v && v.is_active !== false);
          if (!vs.length) return [`<option value="${ti}:0">${esc(t.name || 'Traject ' + ti)}</option>`];
          return vs.map((v, vi) => `<option value="${ti}:${vi}">${esc(t.name || '')} &gt; ${esc(v.name || '')}</option>`);
        })).join('')
      : '';
    return `<div class="subw-sub-card">
      <div class="subw-sub-head" style="align-items:flex-start;gap:8px">
        <div style="flex:1;display:flex;flex-direction:column;gap:6px">
          <select class="ib-input" onchange="__subwSetDesc(${i}, this.value)" data-subw-sub-desc-select="${i}">
            ${presetOpts}
          </select>
          <input class="ib-input" style="display:${isCustom ? 'block' : 'none'}" placeholder="Typ eigen omschrijving…" value="${esc(isCustom ? s.description : '')}" oninput="__subwSubField(${i}, 'description', this.value)" data-subw-sub-desc="${i}">
        </div>
        ${canRemove ? `<button class="ds-icon-btn" onclick="__subwRemoveSub(${i})" title="Verwijder abonnement">×</button>` : ''}
      </div>
      ${trajOpts ? `<div class="sw-field" style="margin-bottom:8px;">
        <span style="font-size:11px;color:var(--text-3)">Traject-preset (prefill omschrijving)</span>
        <select class="ib-input" onchange="__subwPickTraject(${i}, this.value)">${trajOpts}</select>
      </div>` : ''}
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

  // ── Overlay-mount + LOKALE re-render ───────────────────────────────────
  //
  // OFFERTE-WIZARD-PATROON (bewezen, offerte-detail-v2):
  // De wizard staat op body-niveau in eigen overlay-root div. Interne state-
  // wijzigingen mogen NOOIT window.DFO.render() triggeren — dat re-rendert
  // de HOSTED klanten-shell (5000+ regels HTML) en veroorzaakt zichtbare
  // flikker + cursor-verlies + input-hang.
  //
  // In plaats daarvan: alle interne updates roepen _rerender() aan, dat
  // ALLEEN de overlay-root innerHTML swapt. De _shared-v2 stableSearch-
  // cache overleeft de swap: cust-search-input blijft dezelfde DOM-node
  // (via H.hydrateSearchMounts na swap). Element-identiteit = cursor + waarde
  // bewaard.
  //
  // Voor derived velden (regel-totalen, sub-totals, contract-totaal) doen
  // handlers surgical DOM-updates via data-subw-* attributes zonder swap.
  function _ensureOverlayRoot() {
    let el = document.getElementById('subw-overlay-root');
    if (!el) {
      el = document.createElement('div');
      el.id = 'subw-overlay-root';
      document.body.appendChild(el);
    }
    return el;
  }
  // Focus-bewaring voor sub-desc + numerieke bedrag-inputs (data-subw-*).
  // De cust-search-input wordt door H.hydrateSearchMounts zelf hersteld
  // (input-node identity via SEARCH_INPUT_CACHE).
  function _rememberDataFocus(root) {
    const a = document.activeElement;
    if (!a || !root.contains(a)) return null;
    let sel = null;
    if (a.hasAttribute('data-subw-sub-desc')) sel = `[data-subw-sub-desc="${a.getAttribute('data-subw-sub-desc')}"]`;
    else if (a.hasAttribute('data-subw-amt')) {
      const line = a.closest('[data-subw-line]');
      if (line) sel = `[data-subw-line="${line.getAttribute('data-subw-line')}"] [data-subw-amt]`;
    } else if (a.hasAttribute('data-subw-amtincl')) {
      const line = a.closest('[data-subw-line]');
      if (line) sel = `[data-subw-line="${line.getAttribute('data-subw-line')}"] [data-subw-amtincl]`;
    }
    if (!sel) return null;
    let start = 0, end = 0;
    try { start = a.selectionStart ?? 0; end = a.selectionEnd ?? 0; } catch (_) { /* number: throws */ }
    return { sel, start, end };
  }
  function _restoreDataFocus(root, info) {
    if (!info) return;
    const el = root.querySelector(info.sel);
    if (!el) return;
    el.focus();
    try { el.setSelectionRange(info.start, info.end); } catch (_) { /* noop */ }
  }
  // Publiek: interne wizard-rerender (GEEN shell touch).
  // Re-entrancy guard: als render-code (onbedoeld) tijdens de swap opnieuw
  // _rerender() aanroept, wordt de nested call gecoalesceerd tot één swap.
  // Voorkomt stack-overflow / freeze bij onbedoelde render-cascades.
  let _rerendering = false;
  let _rerenderPending = false;
  function _rerender() {
    if (_rerendering) { _rerenderPending = true; return; }
    _rerendering = true;
    try {
      const el = _ensureOverlayRoot();
      if (!_sub.open) { el.innerHTML = ''; return; }
      const dataFocus = _rememberDataFocus(el);
      el.innerHTML = renderWizard();
      // Herplaats cached stableSearch-inputs (cust-search) — hun DOM-node
      // stays alive tussen renders zodat cursor + waarde bewaard blijven.
      if (typeof H.hydrateSearchMounts === 'function') H.hydrateSearchMounts();
      if (dataFocus) queueMicrotask(() => _restoreDataFocus(el, dataFocus));
    } finally {
      _rerendering = false;
      if (_rerenderPending) { _rerenderPending = false; queueMicrotask(_rerender); }
    }
  }
  // Registreer stableSearch-handler ÉÉN keer voor cust-picker.
  if (H.onSearch && !window.__subwOnSearchRegistered) {
    window.__subwOnSearchRegistered = true;
    H.onSearch('subw:cust', async (v) => {
      const q = String(v || '').trim();
      if (q.length < 2) { _renderCustResults([]); return; }
      _renderCustResultsLoading();
      try {
        const j = await Promise.race([
          window.KV.authedJson('/api/sales-customers?search=' + encodeURIComponent(q)),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 8s')), 8000)),
        ]);
        _sub.custResults = asArr(j?.customers).slice(0, 15);
        _renderCustResults(_sub.custResults);
      } catch (e) {
        _renderCustResultsError(e?.message || 'onbekende fout');
      }
    }, { debounceMs: 300 });
  }
  // Surgical result-list updates (via mountedList slot 'subw:cust-results')
  function _renderCustResultsLoading() {
    if (H.setListHTML) H.setListHTML('subw:cust-results', '<div style="padding:12px;color:var(--text-3);font-style:italic">Zoeken…</div>');
  }
  function _renderCustResultsError(msg) {
    if (H.setListHTML) H.setListHTML('subw:cust-results', `<div class="kv-onb-empty">Zoeken faalde: ${esc(msg)}</div>`);
  }
  function _renderCustResults(list) {
    if (!H.setListHTML) return;
    const arr = asArr(list);
    if (!arr.length) { H.setListHTML('subw:cust-results', H.getSearchValue('subw:cust').trim().length >= 2 ? '<div class="kv-onb-empty">Geen klanten gevonden.</div>' : ''); return; }
    H.setListHTML('subw:cust-results', '<div class="subw-cust-results">' + arr.map((c) =>
      `<button type="button" class="subw-cust-hit" onclick="__subwCustPick('${esc(c.id)}')">
        <div><b>${esc(c.name || (c.first_name + ' ' + (c.last_name || '')))}</b></div>
        <div style="font-size:11.5px;color:var(--text-3)">${esc(c.email || '—')}${c.phone ? ' · ' + esc(c.phone) : ''}</div>
      </button>`).join('') + '</div>');
  }

  console.debug('[subw-v2] loaded — window.__subwOpen({dealId?, customerId?}) beschikbaar');
})();
