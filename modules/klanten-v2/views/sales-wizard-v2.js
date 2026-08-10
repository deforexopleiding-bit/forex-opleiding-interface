// modules/klanten-v2/views/sales-wizard-v2.js
//
// Batch 2 — v2 offerte-wizard. Volledige 1-op-1 pariteit met modules/
// sales-wizard.html (1918r, 5 stappen). Dormant scaffold; volledige
// implementatie in gefaseerde iteraties (zie PR-body voor lange lijst).
//
// Deze eerste iteratie levert:
//   - Wizard-state architectuur (SW state-shape 1-op-1 met v1 state.wizard)
//   - Progress-header (5 stappen met visuele indicator)
//   - Stap 1: Bedrijf/entiteit-kaarten (/api/company-entities)
//   - Stap 2: Klant-basis (voornaam/achternaam/email/telefoon + adres) +
//     Bedrijf/Consument-switch, met sessionStorage/URL prefill hooks
//     voor _prefill_lead (leads-v2 → wizard) en _prefill_event_attendee
//     (events → wizard).
//   - Sticky footer met Vorige/Volgende/Concept opslaan
//   - Placeholder-panelen voor Stap 3/4/5 (product-regels/kortingen/BTW,
//     betalingsvoorwaarden, review + submit). Volgende iteraties bouwen
//     die uit tot volledige pariteit.
//
// Preview: ?v2preview=sales → tab Offertes → knop "Nieuwe offerte v2".
// Sales gaat NIET live (allowlist toevoeging) tot alle 5 stappen af zijn.
//
// Endpoints (uit sales-wizard.html-recon):
//   GET  /api/company-entities                — entiteit-kaarten
//   GET  /api/sales-customers?search=X        — klant-search (duplicate check)
//   GET  /api/customer?id=X                   — bestaande klant laden
//   GET  /api/sales-wizard-drafts             — draft resumen
//   POST /api/sales-wizard-drafts             — draft opslaan
//   DELETE /api/sales-wizard-drafts           — draft clearen na submit
//   GET  /api/leads-trajecten                 — traject-select
//   POST /api/sales-deal-create               — submit
//   GET  /api/sales-deal-detail?id=X          — edit_deal_id resume

(function () {
  if (!window.DFO) { console.error('[sales-wizard-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[sales-wizard-v2] KV_V2.helpers niet geladen.'); return; }
  const { I, svg, F } = window.DFO;
  const H = window.KV_V2.helpers;

  // ── State-shape 1-op-1 met v1 sales-wizard.html state.wizard ──────────
  const _sw = {
    open: false,
    step: 1,        // 1..5
    submitting: false,
    dirty: false,
    editDealId: null,
    matched_customer_id: null,
    duplicate_check_status: 'idle',   // idle | pending | completed
    entities: null,                    // /api/company-entities
    entitiesLoading: false,
    entitiesError: null,               // 'unauth' | 'server' | 'empty' | null
    trajecten: null,                   // /api/trajecten → { trajects: [{id,name,variants:[]}] }
    trajectenLoading: false,
    productsCatalog: null,             // /api/sales-products?active=true → { products: [] }
    productsLoading: false,
    leadSources: null,                 // /api/lead-sources → { sources: [] }
    // Product-picker (3e overlay bovenop wizard)
    picker: { open: false, search: '', category: '' },
    // Korting-modal (4e overlay)
    discountModal: { open: false, draft: '' },
    // Stap 4 — exception-limits (uit /api/app-settings, fallback 400/40 zoals v1 r859)
    exceptionLimits: { minTermAmount: 400, maxStartDays: 40, loaded: false },
    // Exception-approval modal (5e overlay, opent bij stap 4 -> 5 als grenzen overschreden)
    exceptionModal: { open: false, detect: null, note: '', feeChecked: false, resolver: null },
    prefillLeadId: null,
    prefillEventAttendeeId: null,
    // Stap 2 — bestaande-klant match + tags helper
    existingCustName: null,            // 'Piet Jansen' — voor banner na dup-match
    tl_imported_contact_id: null,      // TL contact-id na "Gebruik dit contact"
    // Dup-check modal (2e overlay)
    dupModal: {
      open: false,
      loading: false,
      error: null,                     // string | null
      dbMatches: null,                 // [{id,name,email,phone,deals_count,last_deal_at}]
      tlMatches: null,                 // [{tl_id,name,email,phone,address,first_name,...}]
    },
    // Tag-input value (persistent tussen renders zodat typen niet 'wiped')
    tagDraft: '',
    wizard: {
      // Stap 1
      tl_department_id: '',
      // Stap 2 — klant-NAW (1-op-1 met v1 state.wizard, r491-509)
      is_company: false,
      company_name: '', kvk_number: '', vat_number: '',
      first_name: '', last_name: '', email: '', phone: '',
      address_street: '', address_number: '', address_postal: '', address_city: '',
      address_country: 'NL',            // NL | BE
      address_known: false,             // adres al bekend → skip verplichte adresvelden
      date_of_birth: '',                // YYYY-MM-DD
      tags: [],                         // ['vip','custom-tag'] — mix van PRE_TAGS + eigen
      avg_ok: false,                    // privacyverklaring bevestigd (verplicht)
      // Stap 3 — offerte-inhoud (1-op-1 met v1 sales-wizard.html panel2 r275-316)
      traject_variant_id: '',
      // sale_type: alleen 'domestic' of 'intracommunautair' (v1-enum,
      // r286-288). Bij niet-domestic wordt de BTW-rate in lineAmounts() 0
      // (verlegd/vrijgesteld).
      sale_type: 'domestic',
      quote_reference: '',
      // Lead-bron — meestal leeg in v1 (dropdown-placeholder "Binnenkort
      // beschikbaar"). Behouden voor API-parity.
      start_date: '',                    // date offerte (v1 startDate)
      duration_months: 12,               // v1 durationMonths, chips 6/12/24/36
      products: [],                      // [{product_id, product_name, quantity, price_per_unit, vat_percentage, price_includes_vat}]
      discount_percentage: 0,            // 0..100, deal-niveau korting
      // Stap 4 — betalingsvoorwaarden (1-op-1 met v1 state.wizard r521-530)
      payment_start_date: '',            // v1 payStartDate, REQUIRED, min = today NL + 3d
      payment_downpayment_amount: '',    // v1 payDownAmount, optioneel
      payment_downpayment_date: '',      // v1 payDownDate — max = start - 3d, min = today
      payment_term_count: '',            // v1 payTermCount, REQUIRED, 1..60
      payment_term_start_date: '',       // v1 payTermStartDate — met aanbetaling max=start+30d, zonder max=start-3d
      payment_term_amount: '',           // v1 payTermAmount, READONLY, auto-berekend
      // Exception-goedkeuring bij low_term_amount of late_start (v1 r521-524)
      exception_flagged:      false,
      exception_reasons:      '',        // csv: 'low_term_amount' | 'late_start' (of beide)
      exception_reason_note:  '',
      exception_fee_agreed:   false,     // alleen relevant bij late_start
      // Prefill / audit
      source_lead_id: '',
    },
  };
  // 1-op-1 met v1 r471. Wordt gemerged met wizard.tags[] in de chip-row.
  const PRE_TAGS = ['vip', 'risico', 'ambassadeur', 'pilot', 'oud-lead'];

  // ── Fetch-helpers met 8s timeout + fail-soft (patroon uit finance/leads) ──
  async function tryFetch(label, url, timeoutMs = 8000) {
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      return await Promise.race([
        window.KV.authedJson(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
      ]);
    } catch (e) { console.warn('[sw-v2] fetch fail:', label, '→', e?.message); return null; }
  }
  async function tryPost(label, url, body, method = 'POST', timeoutMs = 15000) {
    if (!window.KV || !window.KV.authedFetch) throw new Error('KV.authedFetch niet beschikbaar');
    const resp = await Promise.race([
      window.KV.authedFetch(url, { method, body: body ? JSON.stringify(body) : undefined }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
    const text = await resp.text();
    const json = text ? (function () { try { return JSON.parse(text); } catch { return null; } })() : null;
    if (!resp.ok) { console.warn('[sw-v2] post fail:', label, '→', json?.error || resp.status); throw new Error((json && (json.error || json.message)) || 'HTTP ' + resp.status); }
    return json;
  }
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const eur = window.DFO.eur || ((n) => n == null ? '—' : new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(n));

  // ── Prefill-lezers (leads → wizard, events → wizard) ────────────────
  function readPrefill() {
    // Prefill vanuit klanten-v2 leads-module (sessionStorage _prefill_lead)
    try {
      const raw = sessionStorage.getItem('_prefill_lead');
      if (raw) {
        sessionStorage.removeItem('_prefill_lead');
        const p = JSON.parse(raw);
        if (p && typeof p === 'object') {
          if (p.lead_id) { _sw.wizard.source_lead_id = String(p.lead_id); _sw.prefillLeadId = p.lead_id; }
          if (!_sw.matched_customer_id) {
            if (p.first_name) _sw.wizard.first_name = String(p.first_name);
            if (p.last_name)  _sw.wizard.last_name  = String(p.last_name);
            if (p.email)      _sw.wizard.email      = String(p.email);
            if (p.phone)      _sw.wizard.phone      = String(p.phone);
          }
        }
      }
    } catch (e) { console.warn('[sw-v2] lead-prefill:', e?.message); }
    // Prefill vanuit events-detail (sessionStorage _prefill_event_attendee)
    try {
      const raw = sessionStorage.getItem('_prefill_event_attendee');
      if (raw) {
        sessionStorage.removeItem('_prefill_event_attendee');
        const p = JSON.parse(raw);
        if (p && typeof p === 'object') {
          if (p.event_attendee_id) _sw.prefillEventAttendeeId = p.event_attendee_id;
          if (!_sw.matched_customer_id) {
            if (p.first_name) _sw.wizard.first_name = String(p.first_name);
            if (p.last_name)  _sw.wizard.last_name  = String(p.last_name);
            if (p.email)      _sw.wizard.email      = String(p.email);
            if (p.phone)      _sw.wizard.phone      = String(p.phone);
          }
        }
      }
    } catch (e) { console.warn('[sw-v2] event-prefill:', e?.message); }
    // URL-param fallbacks
    try {
      const params = new URLSearchParams(location.search);
      const sourceLeadId = params.get('source_lead_id');
      if (sourceLeadId && !_sw.wizard.source_lead_id) _sw.wizard.source_lead_id = sourceLeadId;
      const customerId = params.get('customer_id');
      if (customerId) _sw.matched_customer_id = customerId;
      const editDealId = params.get('edit_deal_id');
      if (editDealId) _sw.editDealId = editDealId;
    } catch (_) {}
  }

  // ── Mount + render ────────────────────────────────────────────────
  // Eigen root in <body>. Los van de shell-render zodat DFO.render() de
  // wizard NIET wist. Enige entry-point voor DOM-updates is renderWizard().
  function ensureRoot() {
    let root = document.getElementById('sw-v2-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'sw-v2-root';
      root.className = 'sw-modal-back';
      document.body.appendChild(root);
    }
    return root;
  }
  function renderWizard() {
    const root = ensureRoot();
    // Backdrop-click sluit — idempotent gebonden bij eerste render.
    if (!root._swBackdropBound) {
      root._swBackdropBound = true;
      root.addEventListener('click', (e) => { if (e.target === root && _sw.open) window.__swClose(); });
    }
    if (_sw.open) {
      // Wizard-body + optionele sub-overlays (dup / picker / discount).
      // Alleen ÉÉN sub-overlay tegelijk actief (Esc-volgorde: picker → dup →
      // discount → wizard). Simpel: laatste-open wint via CSS z-index.
      let extras = '';
      if (_sw.dupModal.open)       extras += dupModalHtml();
      if (_sw.picker.open)         extras += pickerModalHtml();
      if (_sw.discountModal.open)  extras += discountModalHtml();
      if (_sw.exceptionModal.open) extras += excModalHtml();
      root.innerHTML = wizardModal() + extras;
      root.classList.add('is-open');
    } else {
      root.classList.remove('is-open');
      root.innerHTML = '';
    }
  }

  // ── Handlers ──────────────────────────────────────────────────────
  window.__swOpen = () => {
    _sw.open = true; _sw.step = 1; _sw.dirty = false;
    readPrefill();
    // Load entities (Stap 1) + trajecten (Stap 3, lazy)
    if (!_sw.entities && !_sw.entitiesLoading) queueMicrotask(loadEntities);
    renderWizard();
  };
  window.__swClose = () => {
    if (_sw.dirty && !confirm('Er zijn niet-opgeslagen wijzigingen. Wizard sluiten?')) return;
    _sw.open = false;
    renderWizard();
  };
  window.__swGoStep = (n) => {
    n = Math.max(1, Math.min(5, Number(n) || 1));
    _sw.step = n;
    if (n === 3) {
      if (!_sw.trajecten     && !_sw.trajectenLoading) queueMicrotask(loadTrajecten);
      if (!_sw.productsCatalog && !_sw.productsLoading) queueMicrotask(loadProductsCatalog);
      if (_sw.leadSources === null) queueMicrotask(loadLeadSources);
    }
    if (n === 4) {
      // Prefill start_date-clamp bij eerste bezoek — v1 renderPaymentStep r730-738.
      const minStart = _swMinStartDateNL();
      if (minStart && _sw.wizard.payment_start_date && _sw.wizard.payment_start_date < minStart) {
        _sw.wizard.payment_start_date = minStart;
      }
      _recomputeTermAmount();
      if (!_sw.exceptionLimits.loaded) queueMicrotask(loadExceptionLimits);
    }
    renderWizard();
  };
  // __swInput doet EXPLICIET geen re-render — DOM behoudt focus/cursor.
  window.__swInput = (field, val) => { _sw.wizard[field] = val; _sw.dirty = true; };
  window.__swToggleCompany = () => { _sw.wizard.is_company = !_sw.wizard.is_company; _sw.dirty = true; renderWizard(); };
  window.__swPickEntity = (id) => { _sw.wizard.tl_department_id = id; _sw.dirty = true; renderWizard(); };
  // Stap-2 handlers
  window.__swAvg        = (v) => { _sw.wizard.avg_ok = !!v; _sw.dirty = true; };
  window.__swAddrKnown  = (v) => { _sw.wizard.address_known = !!v; _sw.dirty = true; renderWizard(); };
  window.__swSetCountry = (v) => { _sw.wizard.address_country = (v === 'BE' ? 'BE' : 'NL'); _sw.dirty = true; };
  window.__swToggleTag  = (t) => {
    const i = _sw.wizard.tags.indexOf(t);
    if (i >= 0) _sw.wizard.tags.splice(i, 1);
    else _sw.wizard.tags.push(t);
    _sw.dirty = true; renderWizard();
  };
  window.__swTagDraft   = (v) => { _sw.tagDraft = String(v || ''); };
  window.__swAddCustomTag = () => {
    const v = String(_sw.tagDraft || '').trim().toLowerCase();
    if (!v) return;
    if (!_sw.wizard.tags.includes(v)) _sw.wizard.tags.push(v);
    _sw.tagDraft = '';
    _sw.dirty = true; renderWizard();
  };
  window.__swSwapCustomer = () => {
    // Ontkoppel bestaande-klant match — velden blijven zoals ze zijn zodat
    // sales onmiddellijk kan aanpassen of opnieuw kan zoeken.
    _sw.matched_customer_id = null;
    _sw.existingCustName = null;
    _sw.duplicate_check_status = 'idle';
    _sw.dirty = true; renderWizard();
  };
  // ── Duplicate-check modal (bestaande klant zoeken) ─────────────────
  window.__swDupCheckOpen = async () => {
    const email = String(_sw.wizard.email || '').trim();
    const phone = String(_sw.wizard.phone || '').trim();
    if (!email && !phone) {
      alert('Vul email of telefoon in voordat je zoekt.');
      return;
    }
    _sw.dupModal.open = true;
    _sw.dupModal.loading = true;
    _sw.dupModal.error = null;
    _sw.dupModal.dbMatches = null;
    _sw.dupModal.tlMatches = null;
    renderWizard();
    try {
      const [dbData, tlData] = await Promise.all([
        tryPost('sales-customer-duplicate-check', '/api/sales-customer-duplicate-check', { email, phone }).catch(e => ({ __err: e?.message || 'onbekende fout', matches: [] })),
        tryPost('teamleader-search-contacts',     '/api/teamleader-search-contacts',     { email, phone }).catch(e => ({ __err: e?.message || 'onbekende fout', tl_matches: [] })),
      ]);
      _sw.dupModal.loading = false;
      _sw.dupModal.dbMatches = Array.isArray(dbData?.matches) ? dbData.matches : [];
      _sw.dupModal.tlMatches = Array.isArray(tlData?.tl_matches) ? tlData.tl_matches : [];
      // Alleen error tonen als beide bronnen faalden.
      if (dbData?.__err && tlData?.__err) {
        _sw.dupModal.error = `Zoek-fouten: DB: ${dbData.__err} · TL: ${tlData.__err}`;
      }
      // Geen duplicates: markeer status='completed' (ok om door te gaan)
      if (!_sw.dupModal.dbMatches.length && !_sw.dupModal.tlMatches.length && !_sw.dupModal.error) {
        _sw.duplicate_check_status = 'completed';
      }
      renderWizard();
    } catch (e) {
      _sw.dupModal.loading = false;
      _sw.dupModal.error = 'Onverwachte fout: ' + (e?.message || 'onbekend');
      renderWizard();
    }
  };
  window.__swDupCheckClose = () => {
    _sw.dupModal.open = false;
    _sw.dupModal.dbMatches = null;
    _sw.dupModal.tlMatches = null;
    _sw.dupModal.error = null;
    renderWizard();
  };
  window.__swDupContinueNew = () => {
    // Sales bevestigt: geen match — ga verder als nieuwe klant.
    _sw.duplicate_check_status = 'completed';
    window.__swDupCheckClose();
  };
  window.__swUseDbCustomer = (id, name) => {
    if (!id) return;
    _sw.matched_customer_id = String(id);
    _sw.existingCustName = String(name || '—');
    _sw.duplicate_check_status = 'completed';
    _sw.dirty = true;
    window.__swDupCheckClose();
  };
  window.__swUseTlContact = (payloadJson) => {
    let m = null;
    try { m = typeof payloadJson === 'string' ? JSON.parse(payloadJson) : payloadJson; } catch (_) {}
    if (!m || typeof m !== 'object') return;
    _sw.tl_imported_contact_id = m.tl_id || null;
    if (m.first_name || m.last_name) {
      _sw.wizard.first_name = m.first_name || '';
      _sw.wizard.last_name  = m.last_name  || '';
    } else if (m.name) {
      const parts = String(m.name).split(' ');
      _sw.wizard.first_name = parts[0] || '';
      _sw.wizard.last_name  = parts.slice(1).join(' ');
    }
    if (m.email) _sw.wizard.email = m.email;
    if (m.phone) _sw.wizard.phone = m.phone;
    if (m.address_street) _sw.wizard.address_street = m.address_street;
    if (m.address_number) _sw.wizard.address_number = m.address_number;
    if (m.address_postal) _sw.wizard.address_postal = m.address_postal;
    if (m.address_city)   _sw.wizard.address_city   = m.address_city;
    if (m.address_country === 'BE' || m.address_country === 'NL') _sw.wizard.address_country = m.address_country;
    if (m.date_of_birth)  _sw.wizard.date_of_birth  = String(m.date_of_birth).slice(0, 10);
    _sw.duplicate_check_status = 'completed';
    _sw.dirty = true;
    window.__swDupCheckClose();
  };
  window.__swSubmit = async () => {
    if (_sw.submitting) return;
    _sw.submitting = true; renderWizard();
    try {
      const payload = { ...(_sw.wizard), matched_customer_id: _sw.matched_customer_id, event_attendee_id: _sw.prefillEventAttendeeId };
      const result = await tryPost('sales-deal-create', '/api/sales-deal-create', payload);
      _sw.submitting = false;
      alert('Offerte aangemaakt: ' + (result?.deal?.id || 'ok'));
      _sw.open = false; _sw.step = 1; _sw.dirty = false;
      try { await tryPost('drafts-del', '/api/sales-wizard-drafts', null, 'DELETE'); } catch (_) {}
      renderWizard();
    } catch (e) {
      _sw.submitting = false; renderWizard();
      alert('Verzenden mislukt: ' + (e?.message || 'onbekende fout'));
    }
  };

  async function loadEntities() {
    _sw.entitiesLoading = true;
    _sw.entitiesError = null;
    // Endpoint returns { entities: [...] } (bron: api/company-entities.js).
    // Accepteer óók legacy shapes (items[] / kale array) voor toekomstige refactors.
    const data = await tryFetch('company-entities', '/api/company-entities');
    _sw.entitiesLoading = false;
    if (data == null) {
      // tryFetch heeft null gereturnd — netwerk-fout, 401, 403, of 500.
      // We weten hier niet welk; classificeer als 'server' voor generieke retry-UI.
      _sw.entities = [];
      _sw.entitiesError = 'server';
    } else {
      const list = Array.isArray(data?.entities) ? data.entities
                  : Array.isArray(data?.items)   ? data.items
                  : Array.isArray(data)          ? data
                  : [];
      _sw.entities = list;
      _sw.entitiesError = list.length === 0 ? 'empty' : null;
      if (list.length && !_sw.wizard.tl_department_id) {
        _sw.wizard.tl_department_id = list[0].tl_department_id;
      }
    }
    renderWizard();
  }
  window.__swRetryEntities = () => {
    _sw.entities = null;
    _sw.entitiesError = null;
    if (!_sw.entitiesLoading) queueMicrotask(loadEntities);
    renderWizard();
  };
  async function loadTrajecten() {
    if (_sw.trajectenLoading) return;
    _sw.trajectenLoading = true;
    // v1 gebruikt /api/trajecten (r887). trajecten-lijst met .variants[] per traject.
    const data = await tryFetch('trajecten', '/api/trajecten');
    _sw.trajecten = Array.isArray(data?.trajects) ? data.trajects
                  : Array.isArray(data?.trajecten) ? data.trajecten
                  : [];
    _sw.trajectenLoading = false;
    renderWizard();
  }
  async function loadProductsCatalog() {
    if (_sw.productsLoading) return;
    _sw.productsLoading = true;
    // v1 gebruikt /api/sales-products?active=true (r884). Shape:
    // { products: [{id, name, description, category, default_price, vat_percentage, price_includes_vat}] }
    const data = await tryFetch('sales-products', '/api/sales-products?active=true');
    _sw.productsCatalog = Array.isArray(data?.products) ? data.products
                        : Array.isArray(data) ? data : [];
    _sw.productsLoading = false;
    renderWizard();
  }
  async function loadLeadSources() {
    if (_sw.leadSources !== null) return; // eenmalig
    const data = await tryFetch('lead-sources', '/api/lead-sources');
    _sw.leadSources = Array.isArray(data?.sources) ? data.sources
                    : Array.isArray(data) ? data : [];
    renderWizard();
  }
  async function applyTrajectVariant(variantId) {
    _sw.wizard.traject_variant_id = variantId || '';
    _sw.dirty = true;
    if (!variantId) { renderWizard(); return; }
    // v1 doet /api/traject-variants?variant_id=X → { variant, products }.
    // We vullen wizard.products opnieuw op basis van de variant-samenstelling.
    try {
      const catalog = _sw.productsCatalog || [];
      const data = await tryFetch('traject-variants', '/api/traject-variants?variant_id=' + encodeURIComponent(variantId));
      const vps = Array.isArray(data?.products) ? data.products : [];
      _sw.wizard.products = vps.map(vp => {
        const p = catalog.find(x => x && x.id === vp.product_id) || {};
        return {
          product_id: vp.product_id,
          product_name: p.name || 'Product',
          quantity: Number(vp.quantity) || 1,
          price_per_unit: Number(p.default_price) || 0,
          vat_percentage: p.vat_percentage ?? 21,
          price_includes_vat: !!p.price_includes_vat,
        };
      });
      if (data?.variant?.default_duration_months) {
        _sw.wizard.duration_months = Number(data.variant.default_duration_months);
      }
    } catch (e) {
      alert('Traject laden mislukt: ' + (e?.message || 'onbekende fout'));
    }
    renderWizard();
  }

  // ── Reken-helpers (1-op-1 met v1 lineAmounts r1365-1374) ──────────
  // rate = sale_type !== 'domestic' ? 0 : vat_percentage/100
  // if price_includes_vat: excl = base/(1+rate), incl = base, btw = base − excl
  // else                  : excl = base, incl = base*(1+rate), btw = base*rate
  function lineAmounts(p) {
    const base = (Number(p.quantity) || 0) * (Number(p.price_per_unit) || 0);
    const rate = (_sw.wizard.sale_type && _sw.wizard.sale_type !== 'domestic')
      ? 0
      : (Number(p.vat_percentage) || 0) / 100;
    if (p.price_includes_vat) {
      const excl = base / (1 + rate);
      return { excl, incl: base, btw: base - excl };
    }
    return { excl: base, incl: base * (1 + rate), btw: base * rate };
  }
  function calcTotals() {
    const disc = Number(_sw.wizard.discount_percentage) || 0;
    const factor = 1 - disc / 100;
    let subtotalExcl = 0;
    const vatByRate = {};
    for (const p of (_sw.wizard.products || [])) {
      const a = lineAmounts(p);
      subtotalExcl += a.excl;
      vatByRate[p.vat_percentage] = (vatByRate[p.vat_percentage] || 0) + a.btw * factor;
    }
    const discountAmount = subtotalExcl * disc / 100;
    const subtotalAfter = subtotalExcl - discountAmount;
    const vatTotal = Object.values(vatByRate).reduce((a, b) => a + b, 0);
    const total = subtotalAfter + vatTotal;
    return { disc, discountAmount, subtotalExcl, subtotalAfter, vatByRate, vatTotal, total };
  }

  // ── Stap 4 — betalingsvoorwaarden helpers (1-op-1 met v1) ──────────
  // Constante uit v1 r578. Reserveringsfee gaat vóór aanbetaling van het
  // totaal af; termijnen worden herberekend over het restbedrag.
  const RESERVATION_FEE_INCL = 100;

  // Vandaag NL (Europe/Amsterdam) als yyyy-mm-dd — matcht v1 _swTodayNL r614.
  function _swTodayNL() {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Amsterdam',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  }
  // UTC-veilige yyyy-mm-dd shift (v1 _shiftDaysIso r604).
  function _shiftDaysIso(startIso, deltaDays) {
    const s = String(startIso || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + deltaDays);
    return dt.toISOString().slice(0, 10);
  }
  // Kies de hoogste (later) van twee yyyy-mm-dd. Beide mogen null zijn.
  function _maxYmd(a, b) {
    if (!a) return b || null;
    if (!b) return a || null;
    return a > b ? a : b;
  }
  // Vroegst-toegestane cursus-startdatum: vandaag NL + 3d (v1 _swMinStartDateNL r626).
  function _swMinStartDateNL() { return _shiftDaysIso(_swTodayNL(), 3); }
  function _hasDownpayment() { return Number(_sw.wizard.payment_downpayment_amount) > 0; }
  // 1e termijn-bounds (v1 _termStartBounds r645-650):
  //   MÉT aanbetaling: max = start + 30d
  //   ZONDER aanbetaling: max = start - 3d
  //   min: null (aangevuld met today-floor in _applyTermStartBounds)
  function _termStartBounds(startIso, hasDown) {
    if (!startIso) return { min: null, max: null };
    return hasDown
      ? { min: null, max: _shiftDaysIso(startIso, +30) }
      : { min: null, max: _shiftDaysIso(startIso, -3)  };
  }
  // Effectieve bounds voor 1e-termijndatum incl. today-floor.
  function _termStartEffBounds() {
    const b = _termStartBounds(_sw.wizard.payment_start_date, _hasDownpayment());
    const effMin = _maxYmd(b.min, _swTodayNL());
    return { min: effMin, max: b.max };
  }
  // Effectieve bounds voor aanbetaling-datum (v1 _applyDownDateBounds r695-722).
  function _downDateEffBounds() {
    const start = _sw.wizard.payment_start_date;
    const max = _shiftDaysIso(start, -3);
    return { min: _swTodayNL(), max };
  }
  // Clamp payment_term_start_date bij verandering van start_date / down_amount.
  // v1 _applyTermStartBounds r657-689. Toont toast bij shift (explainOnClamp).
  function _clampTermStartDate(explainOnClamp) {
    const b = _termStartEffBounds();
    const cur = _sw.wizard.payment_term_start_date || '';
    if (!cur) return;
    let clamped = cur;
    if (b.max && cur > b.max) clamped = b.max;
    if (b.min && cur < b.min) clamped = b.min;
    if (clamped !== cur) {
      _sw.wizard.payment_term_start_date = clamped;
      if (explainOnClamp) {
        const wasPast = b.min && cur < b.min;
        const msg = wasPast
          ? '1e termijndatum aangepast: datum mocht niet in het verleden liggen.'
          : (_hasDownpayment()
              ? '1e termijndatum aangepast: met aanbetaling mag de termijn tot 30 dagen ná de startdatum.'
              : '1e termijndatum aangepast: zonder aanbetaling moet de termijn minstens 3 dagen vóór de startdatum liggen.');
        try { window.KV?.toast?.(msg); } catch (_) {}
      }
    }
  }
  function _clampDownDate(explainOnClamp) {
    const b = _downDateEffBounds();
    const cur = _sw.wizard.payment_downpayment_date || '';
    if (!cur) return;
    let clamped = cur;
    if (b.max && cur > b.max) clamped = b.max;
    if (b.min && cur < b.min) clamped = b.min;
    if (clamped !== cur) {
      _sw.wizard.payment_downpayment_date = clamped;
      if (explainOnClamp) {
        const wasPast = b.min && cur < b.min;
        const msg = wasPast
          ? 'Aanbetaling-datum aangepast: datum mocht niet in het verleden liggen.'
          : 'Aanbetaling-datum aangepast: moet minstens 3 dagen vóór de startdatum liggen.';
        try { window.KV?.toast?.(msg); } catch (_) {}
      }
    }
  }
  // Fee-toepassing (v1 _reservationFeeApplies r579-585).
  function _reservationFeeApplies() {
    const w = _sw.wizard;
    if (!w.exception_flagged) return false;
    const reasons = String(w.exception_reasons || '').split(',').map(s => s.trim());
    return reasons.includes('late_start') && !!w.exception_fee_agreed;
  }
  // Termijnbedrag = floor2((effTotal − down) / tc). effTotal = total − 100 als fee.
  // (v1 recomputeTermAmount r586-596).
  function _recomputeTermAmount() {
    const w = _sw.wizard;
    const total = calcTotals().total || 0;
    const down = Number(w.payment_downpayment_amount) || 0;
    const tc   = Number(w.payment_term_count) || 0;
    const feeApplies = _reservationFeeApplies();
    const effectiveTotal = feeApplies ? (total - RESERVATION_FEE_INCL) : total;
    w.payment_term_amount = tc > 0
      ? Math.floor((effectiveTotal - down) / tc * 100) / 100
      : '';
  }
  // Days-between-today-and (v1 _daysBetweenTodayAnd r1728-1736).
  function _daysBetweenTodayAndUTC(dateIso) {
    const s = String(dateIso || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const [y, m, d] = s.split('-').map(Number);
    const target = Date.UTC(y, m - 1, d);
    const now = new Date();
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return Math.round((target - today) / 86400000);
  }
  // Detect exceptions (v1 _detectExceptions r1792-1801).
  function _detectExceptions() {
    const w = _sw.wizard;
    const minTerm = Number(_sw.exceptionLimits.minTermAmount);
    const maxDays = Number(_sw.exceptionLimits.maxStartDays);
    const termAmt = Number(w.payment_term_amount);
    const daysToStart = _daysBetweenTodayAndUTC(w.payment_start_date);
    const lowTerm   = termAmt > 0 && termAmt < minTerm;
    const lateStart = daysToStart !== null && daysToStart > maxDays;
    return { lowTerm, lateStart, termAmt, daysToStart, minTerm, maxDays };
  }
  // Reset exception-approval als niet meer nodig (v1 _revalidateExceptions r1741-1757).
  function _revalidateExceptions() {
    if (!_sw.wizard.exception_flagged) return;
    const d = _detectExceptions();
    if (!d.lowTerm && !d.lateStart) {
      _sw.wizard.exception_flagged     = false;
      _sw.wizard.exception_reasons     = '';
      _sw.wizard.exception_reason_note = '';
      _sw.wizard.exception_fee_agreed  = false;
      _recomputeTermAmount();
      try { window.KV?.toast?.('Uitzondering-goedkeuring automatisch ingetrokken: offerte valt weer binnen de grenzen.'); } catch (_) {}
    }
  }
  // Preview-text voor "Wat komt er op de offerte?" (v1 buildQuotationTitleFE r559-571).
  function _buildQuotationTitleFE() {
    const w = _sw.wizard;
    const seg = [];
    if (w.payment_start_date) {
      const d = new Date(w.payment_start_date);
      seg.push(`Start: ${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`);
    }
    if (Number(w.payment_downpayment_amount) > 0) {
      seg.push(`Aanbetaling €${Number(w.payment_downpayment_amount).toLocaleString('nl-NL')}`);
    }
    if (Number(w.payment_term_count) > 0) {
      const amt = Number(w.payment_term_amount) > 0 ? ` van €${Number(w.payment_term_amount).toLocaleString('nl-NL')}` : '';
      seg.push(`${w.payment_term_count} termijnen${amt}`);
    }
    return seg.length ? seg.join(' | ') : null;
  }
  // Loader voor exception-limits (v1 _loadExceptionLimits r860-871).
  async function loadExceptionLimits() {
    if (_sw.exceptionLimits.loaded) return;
    try {
      const [rMin, rMax] = await Promise.all([
        tryFetch('app-settings-min-term', '/api/app-settings?key=sales_min_term_amount'),
        tryFetch('app-settings-max-days', '/api/app-settings?key=sales_max_start_days'),
      ]);
      const nMin = Number(rMin?.value?.amount);
      const nMax = Number(rMax?.value?.days);
      if (Number.isFinite(nMin) && nMin >= 0) _sw.exceptionLimits.minTermAmount = nMin;
      if (Number.isFinite(nMax) && nMax >= 1) _sw.exceptionLimits.maxStartDays  = nMax;
    } catch (_) { /* fallback 400/40 blijft */ }
    _sw.exceptionLimits.loaded = true;
  }

  // Stap 4 handlers — patroon: state-mutatie + optionele bounds-clamp + revalidate + render.
  window.__swSetPayStart = (v) => {
    _sw.wizard.payment_start_date = String(v || '');
    _sw.dirty = true;
    // Default 1e termijn = start-3d als leeg (v1 nextBtn hook r758-762).
    const startMinus3 = _shiftDaysIso(_sw.wizard.payment_start_date, -3);
    if (startMinus3 && !_sw.wizard.payment_term_start_date) {
      _sw.wizard.payment_term_start_date = startMinus3;
    }
    _clampTermStartDate(true);
    _clampDownDate(true);
    _recomputeTermAmount();
    _revalidateExceptions();
    renderWizard();
  };
  window.__swSetPayDownAmt = (v) => {
    _sw.wizard.payment_downpayment_amount = String(v || '');
    _sw.dirty = true;
    _clampTermStartDate(true);
    _recomputeTermAmount();
    _revalidateExceptions();
    renderWizard();
  };
  window.__swSetPayDownDate = (v) => {
    _sw.wizard.payment_downpayment_date = String(v || '');
    _sw.dirty = true;
    _clampDownDate(true);
    renderWizard();
  };
  window.__swSetPayTermCount = (v) => {
    const n = Math.max(0, Math.min(60, Number(v) || 0));
    _sw.wizard.payment_term_count = n === 0 ? '' : n;
    _sw.dirty = true;
    _recomputeTermAmount();
    _revalidateExceptions();
    renderWizard();
  };
  window.__swSetPayTermStart = (v) => {
    _sw.wizard.payment_term_start_date = String(v || '');
    _sw.dirty = true;
    renderWizard();
  };
  window.__swUndoException = () => {
    if (!_sw.wizard.exception_flagged) return;
    _sw.wizard.exception_flagged     = false;
    _sw.wizard.exception_reasons     = '';
    _sw.wizard.exception_reason_note = '';
    _sw.wizard.exception_fee_agreed  = false;
    _sw.dirty = true;
    _recomputeTermAmount();
    try { window.KV?.toast?.('Uitzondering-goedkeuring ongedaan gemaakt.'); } catch (_) {}
    renderWizard();
  };

  // Exception-modal handlers
  window.__swExcNote = (v) => { _sw.exceptionModal.note = String(v || ''); renderWizard(); };
  window.__swExcFee  = (v) => { _sw.exceptionModal.feeChecked = !!v; renderWizard(); };
  window.__swExcApprove = () => {
    const m = _sw.exceptionModal;
    if (!m.detect) return;
    const csv = [m.detect.lowTerm && 'low_term_amount', m.detect.lateStart && 'late_start']
      .filter(Boolean).join(',');
    _sw.wizard.exception_flagged     = true;
    _sw.wizard.exception_reasons     = csv;
    _sw.wizard.exception_reason_note = m.note.trim();
    _sw.wizard.exception_fee_agreed  = m.detect.lateStart ? !!m.feeChecked : false;
    _sw.dirty = true;
    _recomputeTermAmount();
    const resolve = m.resolver;
    _sw.exceptionModal = { open: false, detect: null, note: '', feeChecked: false, resolver: null };
    renderWizard();
    if (resolve) resolve(true);
  };
  window.__swExcReject = () => {
    const resolve = _sw.exceptionModal.resolver;
    _sw.exceptionModal = { open: false, detect: null, note: '', feeChecked: false, resolver: null };
    renderWizard();
    if (resolve) resolve(false);
  };
  window.__swExcClose = () => window.__swExcReject();

  // Next-guard: bij stap 4 → 5, run exception-detect + toon modal indien nodig.
  window.__swNext = async () => {
    if (_sw.step === 4) {
      const d = _detectExceptions();
      if (d.lowTerm || d.lateStart) {
        const alreadyApproved = _sw.wizard.exception_flagged
          && _sw.wizard.exception_reason_note
          && (!d.lateStart || _sw.wizard.exception_fee_agreed);
        if (!alreadyApproved) {
          const ok = await new Promise((resolve) => {
            _sw.exceptionModal = {
              open: true,
              detect: d,
              note: _sw.wizard.exception_reason_note || '',
              feeChecked: !!_sw.wizard.exception_fee_agreed,
              resolver: resolve,
            };
            renderWizard();
          });
          if (!ok) return; // blijft op stap 4
        }
      } else {
        // Grenzen niet meer overschreden → reset flag zodat payload niet ten
        // onrechte flagged blijft (v1 r1863-1868).
        if (_sw.wizard.exception_flagged) {
          _sw.wizard.exception_flagged     = false;
          _sw.wizard.exception_reasons     = '';
          _sw.wizard.exception_reason_note = '';
          _sw.wizard.exception_fee_agreed  = false;
          _recomputeTermAmount();
        }
      }
    }
    window.__swGoStep(_sw.step + 1);
  };

  // ── Stap-3 handlers ───────────────────────────────────────────────
  window.__swPickTraject = (variantId) => queueMicrotask(() => applyTrajectVariant(variantId));
  window.__swResetTraject = () => { _sw.wizard.traject_variant_id = ''; _sw.dirty = true; renderWizard(); };
  window.__swSetSaleType = (v) => { _sw.wizard.sale_type = v === 'intracommunautair' ? 'intracommunautair' : 'domestic'; _sw.dirty = true; renderWizard(); };
  window.__swSetDuration = (n) => {
    const v = Math.max(1, Math.min(120, Number(n) || 12));
    _sw.wizard.duration_months = v;
    _sw.dirty = true; renderWizard();
  };
  window.__swInputQty = (i, val) => {
    const arr = _sw.wizard.products; if (!arr[i]) return;
    arr[i].quantity = Math.max(1, Number(val) || 1);
    _sw.dirty = true; renderWizard();
  };
  window.__swInputPrice = (i, val) => {
    const arr = _sw.wizard.products; if (!arr[i]) return;
    arr[i].price_per_unit = Math.max(0, Number(val) || 0);
    _sw.dirty = true; renderWizard();
  };
  window.__swToggleVatIncl = (i) => {
    const arr = _sw.wizard.products; if (!arr[i]) return;
    arr[i].price_includes_vat = !arr[i].price_includes_vat;
    _sw.dirty = true; renderWizard();
  };
  window.__swRemoveProduct = (i) => {
    _sw.wizard.products.splice(Number(i), 1);
    _sw.dirty = true; renderWizard();
  };
  // Product-picker modal
  window.__swPickerOpen = () => {
    _sw.picker.open = true; _sw.picker.search = ''; _sw.picker.category = '';
    if (!_sw.productsCatalog && !_sw.productsLoading) queueMicrotask(loadProductsCatalog);
    renderWizard();
  };
  window.__swPickerClose = () => { _sw.picker.open = false; renderWizard(); };
  window.__swPickerSearch = (v) => { _sw.picker.search = String(v || ''); renderWizard(); };
  window.__swPickerCat = (v) => { _sw.picker.category = String(v || ''); renderWizard(); };
  window.__swAddProductPick = (productId) => {
    const catalog = _sw.productsCatalog || [];
    const p = catalog.find(x => x && x.id === productId);
    if (!p) return;
    _sw.wizard.products.push({
      product_id: p.id,
      product_name: p.name,
      quantity: 1,
      price_per_unit: Number(p.default_price) || 0,
      vat_percentage: p.vat_percentage ?? 21,
      price_includes_vat: !!p.price_includes_vat,
    });
    _sw.picker.open = false;
    _sw.dirty = true; renderWizard();
  };
  // Korting-modal
  window.__swDiscountOpen = () => {
    _sw.discountModal.open = true;
    _sw.discountModal.draft = String(_sw.wizard.discount_percentage || '');
    renderWizard();
  };
  window.__swDiscountClose = () => { _sw.discountModal.open = false; renderWizard(); };
  window.__swDiscountDraft = (v) => { _sw.discountModal.draft = String(v || ''); };
  window.__swDiscountApply = () => {
    let v = Number(_sw.discountModal.draft) || 0;
    v = Math.max(0, Math.min(100, v));
    _sw.wizard.discount_percentage = v;
    _sw.discountModal.open = false;
    _sw.dirty = true; renderWizard();
  };
  window.__swDiscountRemove = () => {
    _sw.wizard.discount_percentage = 0;
    _sw.dirty = true; renderWizard();
  };

  // ── Progress + shell ──────────────────────────────────────────────
  const STEP_LABELS = ['Entiteit', 'Klantgegevens', 'Offerte & producten', 'Betalingsvoorwaarden', 'Bevestiging'];
  function progress() {
    return `<div class="sw-progress">
      ${STEP_LABELS.map((l, i) => {
        const n = i + 1;
        const cls = n < _sw.step ? 'is-done' : n === _sw.step ? 'is-active' : 'is-todo';
        return `<button class="sw-progress-step ${cls}" onclick="__swGoStep(${n})">
          <span class="sw-progress-dot">${n < _sw.step ? '✓' : n}</span>
          <span class="sw-progress-lbl">${l}</span>
        </button>`;
      }).join('<span class="sw-progress-sep"></span>')}
    </div>`;
  }

  // ── Stap-panelen ────────────────────────────────────────────────
  function stepBedrijf() {
    const w = _sw.wizard;
    if (_sw.entitiesLoading) {
      return `<div class="sw-step"><div class="sv-empty" style="padding:32px">Entiteiten laden…</div></div>`;
    }
    if (_sw.entitiesError === 'server') {
      return `<div class="sw-step">
        <h2 class="sw-step-title">1. Kies de entiteit</h2>
        <div class="sv-empty" style="padding:24px;background:var(--red-soft,#fdecec);border:1px dashed var(--red-line,#f5b7b7);color:var(--red,#c1272d);border-radius:8px;display:flex;flex-direction:column;gap:10px;align-items:flex-start">
          <div>Entiteiten konden niet worden geladen (server-fout of geen rechten). Check de browser-console (label <b>[sw-v2] fetch fail: company-entities</b>) voor de exacte oorzaak.</div>
          <button class="btn" onclick="__swRetryEntities()">Opnieuw proberen</button>
        </div>
      </div>`;
    }
    if (!_sw.entities || !_sw.entities.length) {
      return `<div class="sw-step">
        <h2 class="sw-step-title">1. Kies de entiteit</h2>
        <div class="sv-empty" style="padding:24px;background:var(--amber-soft);border:1px dashed var(--amber-line);color:var(--amber);border-radius:8px;display:flex;flex-direction:column;gap:10px;align-items:flex-start">
          <div>Geen entiteiten gevonden. Een manager kan ze toevoegen via <b>Admin → Entiteiten</b> (tabel <code>company_entities</code>, <code>is_active=true</code>).</div>
          <button class="btn" onclick="__swRetryEntities()">Opnieuw laden</button>
        </div>
      </div>`;
    }
    return `<div class="sw-step">
      <h2 class="sw-step-title">1. Kies de entiteit</h2>
      <p class="sw-step-sub">Vanuit welke van jullie bedrijfsentiteiten wordt deze offerte uitgegeven?</p>
      <div class="sw-entity-grid">
        ${_sw.entities.map(e => `
          <button class="sw-entity-card ${w.tl_department_id === e.tl_department_id ? 'is-selected' : ''}" onclick="__swPickEntity('${esc(e.tl_department_id)}')">
            <div class="sw-entity-name">${esc(e.label || e.name || '—')}</div>
            ${e.description ? `<div class="sw-entity-country">${esc(e.description)}</div>` : ''}
          </button>
        `).join('')}
      </div>
    </div>`;
  }
  function stepKlant() {
    const w = _sw.wizard;
    const isCo = !!w.is_company;
    const addrKnown = !!w.address_known;
    // Merge PRE_TAGS + custom tags, dedup, behoud volgorde (PRE eerst).
    const allTags = [...new Set([...PRE_TAGS, ...w.tags])];
    return `<div class="sw-step">
      <h2 class="sw-step-title">2. Klantgegevens</h2>
      <p class="sw-step-sub">Zoek een bestaande klant of vul basis-NAW.
        ${w.source_lead_id ? `<span class="pill pill-accent">Prefill vanuit lead ${esc(w.source_lead_id.slice(0, 8))}…</span>` : ''}
        ${_sw.tl_imported_contact_id ? `<span class="pill pill-accent">Uit TeamLeader geïmporteerd</span>` : ''}
      </p>

      ${_sw.matched_customer_id ? `
        <div class="sw-cust-banner">
          <div>
            <b>Bestaande klant geselecteerd:</b> ${esc(_sw.existingCustName || '—')}
            <div class="sw-cust-banner-sub">Adres-check wordt overgeslagen (data komt uit klant-record).</div>
          </div>
          <button class="btn btn-ghost" onclick="__swSwapCustomer()">Wissel klant</button>
        </div>
      ` : ''}

      <div class="sw-toggle-row">
        <label><input type="radio" name="sw-btype" ${!isCo ? 'checked' : ''} onchange="__swToggleCompany()"> Consument</label>
        <label><input type="radio" name="sw-btype" ${isCo ? 'checked' : ''} onchange="__swToggleCompany()"> Bedrijf (B2B)</label>
      </div>

      ${isCo ? `
        <div class="tk-field-row">
          <label class="tk-field"><span class="tk-field-l">Bedrijfsnaam <span class="tk-req">*</span></span>
            <input class="ib-input" value="${esc(w.company_name)}" oninput="__swInput('company_name', this.value)"></label>
          <label class="tk-field"><span class="tk-field-l">KvK-nummer</span>
            <input class="ib-input" value="${esc(w.kvk_number)}" oninput="__swInput('kvk_number', this.value)"></label>
          <label class="tk-field"><span class="tk-field-l">BTW-nummer</span>
            <input class="ib-input" value="${esc(w.vat_number)}" oninput="__swInput('vat_number', this.value)"></label>
        </div>
      ` : ''}

      <div class="tk-field-row">
        <label class="tk-field"><span class="tk-field-l">Voornaam ${isCo ? '' : '<span class="tk-req">*</span>'}</span>
          <input class="ib-input" value="${esc(w.first_name)}" oninput="__swInput('first_name', this.value)"></label>
        <label class="tk-field"><span class="tk-field-l">Achternaam ${isCo ? '' : '<span class="tk-req">*</span>'}</span>
          <input class="ib-input" value="${esc(w.last_name)}" oninput="__swInput('last_name', this.value)"></label>
      </div>
      <div class="tk-field-row">
        <label class="tk-field"><span class="tk-field-l">E-mail <span class="tk-req">*</span></span>
          <input class="ib-input" type="email" value="${esc(w.email)}" oninput="__swInput('email', this.value)" onblur="if(this.value.trim() && ${_sw.duplicate_check_status !== 'completed' ? 'true' : 'false'}) window.__swDupCheckOpen()"></label>
        <label class="tk-field"><span class="tk-field-l">Telefoon <span class="tk-req">*</span></span>
          <input class="ib-input" value="${esc(w.phone)}" oninput="__swInput('phone', this.value)"></label>
      </div>

      <div class="sw-dup-strip">
        <button class="btn btn-warn" onclick="__swDupCheckOpen()" title="Vul minimaal email of telefoon in">
          ${svg(I.search || I.plus, 'width:14px;height:14px')} Zoek in onze DB + Teamleader
        </button>
        <div class="sw-dup-strip-hint">
          ${_sw.duplicate_check_status === 'completed'
            ? '<span class="pill pill-ok">Duplicate-check gedaan</span>'
            : 'Controleert of deze klant al bestaat. Bij het verlaten van het emailveld start deze zoek automatisch.'}
        </div>
      </div>

      <div class="sw-check-row">
        <label>
          <input type="checkbox" ${addrKnown ? 'checked' : ''} onchange="__swAddrKnown(this.checked)">
          <span>Ik heb de adresgegevens al (adres niet nodig in offerte)</span>
        </label>
      </div>

      <div class="tk-field-row" style="opacity:${addrKnown ? '.55' : '1'}">
        <label class="tk-field"><span class="tk-field-l">Straat ${addrKnown ? '(optioneel)' : '<span class="tk-req">*</span>'}</span>
          <input class="ib-input" value="${esc(w.address_street)}" oninput="__swInput('address_street', this.value)"></label>
        <label class="tk-field"><span class="tk-field-l">Huisnr ${addrKnown ? '(optioneel)' : '<span class="tk-req">*</span>'}</span>
          <input class="ib-input" value="${esc(w.address_number)}" oninput="__swInput('address_number', this.value)"></label>
        <label class="tk-field"><span class="tk-field-l">Postcode ${addrKnown ? '(optioneel)' : '<span class="tk-req">*</span>'}</span>
          <input class="ib-input" placeholder="1234 AB" value="${esc(w.address_postal)}" oninput="__swInput('address_postal', this.value)"></label>
      </div>
      <div class="tk-field-row" style="opacity:${addrKnown ? '.55' : '1'}">
        <label class="tk-field"><span class="tk-field-l">Plaats ${addrKnown ? '(optioneel)' : '<span class="tk-req">*</span>'}</span>
          <input class="ib-input" value="${esc(w.address_city)}" oninput="__swInput('address_city', this.value)"></label>
        <label class="tk-field"><span class="tk-field-l">Land</span>
          <select class="ib-input" onchange="__swSetCountry(this.value)">
            <option value="NL" ${w.address_country === 'NL' ? 'selected' : ''}>Nederland</option>
            <option value="BE" ${w.address_country === 'BE' ? 'selected' : ''}>België</option>
          </select></label>
        <label class="tk-field"><span class="tk-field-l">Geboortedatum</span>
          <input class="ib-input" type="date" value="${esc(w.date_of_birth)}" oninput="__swInput('date_of_birth', this.value)"></label>
      </div>

      <div class="sw-tags-block">
        <div class="tk-field-l" style="margin-bottom:6px">Tags</div>
        <div class="sw-chip-row">
          ${allTags.map(t => `
            <span class="sw-chip ${w.tags.includes(t) ? 'is-on' : ''}" onclick="__swToggleTag('${esc(t)}')">
              ${esc(t)}${w.tags.includes(t) ? '<span class="sw-chip-x">×</span>' : ''}
            </span>
          `).join('')}
        </div>
        <div class="sw-tag-add">
          <input class="ib-input" placeholder="+ Tag toevoegen" value="${esc(_sw.tagDraft)}"
                 oninput="__swTagDraft(this.value)"
                 onkeydown="if(event.key==='Enter'){event.preventDefault();__swAddCustomTag()}">
          <button class="btn" onclick="__swAddCustomTag()">Voeg toe</button>
        </div>
      </div>

      <div class="sw-check-row sw-check-row-avg">
        <label>
          <input type="checkbox" ${w.avg_ok ? 'checked' : ''} onchange="__swAvg(this.checked)">
          <span>Klant is geïnformeerd over <a href="/privacy" target="_blank" rel="noopener">privacyverklaring</a> <span class="tk-req">*</span></span>
        </label>
      </div>
    </div>`;
  }

  // ── Duplicate-check modal (2e overlay bovenop wizard) ───────────────
  function dupModalHtml() {
    const d = _sw.dupModal;
    let body = '';
    if (d.loading) {
      body = `<div class="sv-empty" style="padding:32px">Zoeken in DB + TeamLeader…</div>`;
    } else if (d.error) {
      body = `<div class="sv-empty" style="padding:24px;background:var(--red-soft,#fdecec);border:1px dashed var(--red-line,#f5b7b7);color:var(--red,#c1272d);border-radius:8px">${esc(d.error)}</div>`;
    } else if (!d.dbMatches?.length && !d.tlMatches?.length) {
      body = `
        <div style="padding:26px;text-align:center;color:var(--emerald,#059669)">
          <div style="font-size:34px;line-height:1">✓</div>
          <div style="margin-top:10px;font-size:14px">Geen duplicates gevonden</div>
          <div style="margin-top:6px;font-size:12px;color:var(--text-3)">Geen matches in onze database of TeamLeader.</div>
        </div>`;
    } else {
      const dbSect = d.dbMatches?.length ? `
        <div class="sw-dup-sect">
          <h3 class="sw-dup-sect-h">Onze database — ${d.dbMatches.length} match${d.dbMatches.length === 1 ? '' : 'es'}</h3>
          ${d.dbMatches.map(m => `
            <div class="sw-dup-card">
              <div class="sw-dup-card-name">${esc(m.name || '—')}</div>
              <div class="sw-dup-card-meta">${esc(m.email || '')}${m.phone ? ' · ' + esc(m.phone) : ''}</div>
              <div class="sw-dup-card-badges">
                <span class="pill pill-neutral">${m.deals_count || 0} deals</span>
                ${m.last_deal_at ? `<span class="pill pill-neutral">Laatste: ${new Date(m.last_deal_at).toLocaleDateString('nl-NL', { day: '2-digit', month: 'short' })}</span>` : ''}
              </div>
              <div class="sw-dup-card-acts">
                <button class="btn btn-primary" onclick="__swUseDbCustomer('${esc(m.id)}', ${JSON.stringify(String(m.name || '')).replace(/"/g, '&quot;')})">Gebruik deze klant</button>
              </div>
            </div>
          `).join('')}
        </div>` : '';
      const tlSect = d.tlMatches?.length ? `
        <div class="sw-dup-sect">
          <h3 class="sw-dup-sect-h">TeamLeader — ${d.tlMatches.length} match${d.tlMatches.length === 1 ? '' : 'es'}</h3>
          ${d.tlMatches.map((m, i) => `
            <div class="sw-dup-card">
              <div class="sw-dup-card-name">${esc(m.name || '—')}</div>
              <div class="sw-dup-card-meta">${esc(m.email || 'Email niet in TL')}${m.phone ? ' · ' + esc(m.phone) : ' · —'}</div>
              ${m.address ? `<div class="sw-dup-card-meta" style="color:var(--text-3)">${esc(m.address)}</div>` : ''}
              <div class="sw-dup-card-acts">
                <button class="btn" onclick="__swUseTlContact(${JSON.stringify(JSON.stringify(m)).replace(/"/g, '&quot;')})">Gebruik dit contact</button>
              </div>
            </div>
          `).join('')}
        </div>` : '';
      body = `${dbSect}${tlSect}`;
    }
    return `<div class="sw-dup-back" onclick="if(event.target===this)__swDupCheckClose()">
      <div class="sw-dup-modal">
        <div class="sw-modal-head">
          <div class="sw-modal-title">Klant zoeken</div>
          <button class="icon-btn" onclick="__swDupCheckClose()" title="Sluiten">${svg(I.x || I.warn, 'width:16px;height:16px')}</button>
        </div>
        <div class="sw-modal-body" style="padding:16px 18px;max-height:60vh;overflow-y:auto">
          ${body}
        </div>
        <div class="sw-modal-foot">
          <button class="btn btn-ghost" onclick="__swDupCheckClose()">Annuleren</button>
          <div style="flex:1"></div>
          ${!d.loading && !d.error ? `<button class="btn btn-primary" onclick="__swDupContinueNew()">Ga verder als nieuwe klant</button>` : ''}
        </div>
      </div>
    </div>`;
  }
  function stepProducten() {
    const w = _sw.wizard;
    const totals = calcTotals();
    const trajOpts = renderTrajectOptions();
    const leadSrcOpts = renderLeadSourceOptions();

    const productsHtml = w.products.length
      ? w.products.map((p, i) => {
          const a = lineAmounts(p);
          return `<div class="dp-row">
            <div class="dp-name">
              <b>${esc(p.product_name)}</b>
              <div class="dp-sub">BTW ${p.vat_percentage}% ·
                <a class="dp-vat-toggle" onclick="__swToggleVatIncl(${i})">${p.price_includes_vat ? 'incl' : 'excl'} BTW ⇄</a>
              </div>
            </div>
            <input class="ib-input dp-qty" type="number" min="1" value="${Number(p.quantity) || 1}"
                   oninput="__swInputQty(${i}, this.value)" aria-label="Aantal">
            <input class="ib-input dp-price" type="number" step="0.01" min="0" value="${Number(p.price_per_unit) || 0}"
                   oninput="__swInputPrice(${i}, this.value)" aria-label="Prijs per stuk">
            <div class="dp-sub-line">${eurFmt(a.incl)}</div>
            <button class="dp-rm" onclick="__swRemoveProduct(${i})" title="Regel verwijderen" aria-label="Regel verwijderen">×</button>
          </div>`;
        }).join('')
      : `<div class="dp-empty">Voeg het eerste product toe om verder te gaan.</div>`;

    const discRow = totals.disc > 0
      ? `<div class="dp-total-row dp-total-disc"><span>Korting (${totals.disc}%)</span><span>−${eurFmt(totals.discountAmount)}</span></div>
         <div class="dp-total-row"><span>Subtotaal na korting</span><span>${eurFmt(totals.subtotalAfter)}</span></div>`
      : '';
    const vatRows = Object.keys(totals.vatByRate)
      .sort((a, b) => Number(a) - Number(b))
      .map(rate => `<div class="dp-total-row"><span>BTW ${rate}%</span><span>${eurFmt(totals.vatByRate[rate])}</span></div>`)
      .join('');
    const discCtrl = totals.disc > 0
      ? `<a class="dp-disc-edit" onclick="__swDiscountOpen()">Korting (${totals.disc}%) wijzigen</a>
         · <a class="dp-disc-rm" onclick="__swDiscountRemove()">verwijderen</a>`
      : `<a class="dp-disc-add" onclick="__swDiscountOpen()">+ Korting</a>`;
    const totalsHtml = w.products.length
      ? `<div class="dp-totals">
          <div class="dp-total-row"><span>Subtotaal excl. BTW</span><span>${eurFmt(totals.subtotalExcl)}</span></div>
          ${discRow}
          ${vatRows}
          <div class="dp-total-row dp-total-big"><span>Totaal incl. BTW</span><span>${eurFmt(totals.total)}</span></div>
          <div class="dp-total-row dp-total-ctrl">${discCtrl}</div>
        </div>`
      : '';

    return `<div class="sw-step">
      <h2 class="sw-step-title">3. Offerte & producten</h2>
      <p class="sw-step-sub">Kies een traject-variant of stel handmatig samen. BTW-berekening houdt rekening met de sale_type.</p>

      <div class="sw-panel-box">
        <label class="tk-field-l">Traject (optioneel)</label>
        <div class="sw-inline-row">
          <select class="ib-input" onchange="__swPickTraject(this.value)">
            ${trajOpts}
          </select>
          <button class="btn btn-ghost" onclick="__swResetTraject()" type="button">Reset</button>
        </div>
        <div class="sw-hint">Kies een traject-variant om de producten automatisch in te vullen. Je kunt daarna nog aanpassen.</div>

        <label class="tk-field-l" style="margin-top:10px">Type verkoop (BTW-regeling)</label>
        <select class="ib-input" onchange="__swSetSaleType(this.value)">
          <option value="domestic"        ${w.sale_type === 'domestic'        ? 'selected' : ''}>Normaal NL/BE</option>
          <option value="intracommunautair" ${w.sale_type === 'intracommunautair' ? 'selected' : ''}>Zakelijk België — Intracommunautair</option>
        </select>
        <div class="sw-hint">${w.sale_type !== 'domestic' ? 'Alle regels 0% BTW (verlegd / vrijgesteld).' : ''}</div>
      </div>

      <div class="tk-field-row">
        <label class="tk-field"><span class="tk-field-l">Offerte-referentie</span>
          <input class="ib-input" placeholder="bv. Q2026-0123" value="${esc(w.quote_reference)}"
                 oninput="__swInput('quote_reference', this.value)">
          <span class="tk-field-hint">TL offerte-nummer indien al opgesteld</span>
        </label>
        <label class="tk-field"><span class="tk-field-l">Lead-bron</span>
          <select class="ib-input" onchange="__swInput('source_lead_id', this.value)">
            ${leadSrcOpts}
          </select>
        </label>
      </div>

      <div class="tk-field-row">
        <label class="tk-field"><span class="tk-field-l">Datum offerte <span class="tk-req">*</span></span>
          <input class="ib-input" type="date" value="${esc(w.start_date)}"
                 oninput="__swInput('start_date', this.value)">
        </label>
        <label class="tk-field"><span class="tk-field-l">Looptijd <span class="tk-req">*</span></span>
          <div class="sw-dur-row">
            <input class="ib-input sw-dur-num" type="number" min="1" max="120" value="${Number(w.duration_months) || 12}"
                   oninput="__swSetDuration(this.value)">
            <span class="sw-dur-lbl">mnd</span>
            ${[6, 12, 24, 36].map(n => `<span class="sw-chip ${Number(w.duration_months) === n ? 'is-on' : ''}" onclick="__swSetDuration(${n})">${n}</span>`).join('')}
          </div>
        </label>
      </div>

      <div class="sw-prod-head">
        <h3>Producten in deze offerte <small>${w.products.length ? '· ' + w.products.length + ' × ' + eurFmt(totals.total) : ''}</small></h3>
        <button class="btn btn-primary" onclick="__swPickerOpen()">${svg(I.plus)}Product toevoegen</button>
      </div>
      <div class="dp-list">${productsHtml}</div>
      ${totalsHtml}
    </div>`;
  }
  function renderTrajectOptions() {
    if (_sw.trajectenLoading) return `<option value="">Trajecten laden…</option>`;
    const list = _sw.trajecten || [];
    if (!list.length) return `<option value="">Geen traject</option>`;
    const opts = list.map(t => {
      const vs = (t.variants || []).filter(v => v.is_active !== false);
      if (!vs.length) return '';
      const inner = vs.map(v => `<option value="${esc(v.id)}" ${_sw.wizard.traject_variant_id === v.id ? 'selected' : ''}>${esc(t.name)} > ${esc(v.name)}</option>`).join('');
      return `<optgroup label="${esc(t.name)}">${inner}</optgroup>`;
    }).join('');
    return `<option value="">Geen traject</option>${opts}`;
  }
  function renderLeadSourceOptions() {
    const list = _sw.leadSources || [];
    const sel = _sw.wizard.source_lead_id || '';
    if (!list.length) return `<option value="">Binnenkort beschikbaar</option>`;
    return `<option value="">— Kies —</option>` + list.map(s => `<option value="${esc(s.id)}" ${sel === s.id ? 'selected' : ''}>${esc(s.name || s.label || s.id)}</option>`).join('');
  }
  // Product-picker modal (3e overlay)
  function pickerModalHtml() {
    const catalog = _sw.productsCatalog || [];
    const q = String(_sw.picker.search || '').toLowerCase();
    const cat = _sw.picker.category || '';
    let arr = catalog.slice();
    if (q)   arr = arr.filter(p => ((p.name || '') + ' ' + (p.description || '')).toLowerCase().includes(q));
    if (cat) arr = arr.filter(p => p.category === cat);
    const categories = [...new Set(catalog.map(p => p.category).filter(Boolean))];
    const listBody = _sw.productsLoading
      ? `<div class="sv-empty" style="padding:32px">Producten laden…</div>`
      : (!arr.length
          ? `<div class="sv-empty" style="padding:24px">Geen producten gevonden.</div>`
          : arr.map(p => `<div class="pp-card" onclick="__swAddProductPick('${esc(p.id)}')">
              <div class="pp-card-top">
                <div class="pp-card-name">
                  <b>${esc(p.name)}</b>
                  ${p.category ? `<span class="pp-badge">${esc(p.category)}</span>` : ''}
                  <span class="pp-badge pp-badge-vat">${Number(p.vat_percentage) || 0}%</span>
                </div>
                <b class="pp-card-price">${eurFmt(Number(p.default_price) || 0)}</b>
              </div>
              ${p.description ? `<div class="pp-card-desc">${esc(String(p.description).slice(0, 120))}${String(p.description).length > 120 ? '…' : ''}</div>` : ''}
            </div>`).join(''));
    return `<div class="sw-dup-back" onclick="if(event.target===this)__swPickerClose()">
      <div class="sw-dup-modal">
        <div class="sw-modal-head">
          <div class="sw-modal-title">Product toevoegen aan offerte</div>
          <button class="icon-btn" onclick="__swPickerClose()" title="Sluiten">${svg(I.x || I.warn, 'width:16px;height:16px')}</button>
        </div>
        <div class="sw-modal-body" style="padding:14px 16px;max-height:65vh;overflow-y:auto">
          <div class="pp-filters">
            <input class="ib-input" placeholder="Zoek product…" value="${esc(_sw.picker.search)}"
                   oninput="__swPickerSearch(this.value)">
            <select class="ib-input" style="max-width:200px" onchange="__swPickerCat(this.value)">
              <option value="">Alle categorieën</option>
              ${categories.map(c => `<option value="${esc(c)}" ${cat === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
            </select>
          </div>
          <div class="pp-list">${listBody}</div>
        </div>
        <div class="sw-modal-foot">
          <button class="btn btn-ghost" onclick="__swPickerClose()">Annuleren</button>
        </div>
      </div>
    </div>`;
  }
  // Korting-modal (4e overlay)
  function discountModalHtml() {
    return `<div class="sw-dup-back" onclick="if(event.target===this)__swDiscountClose()">
      <div class="sw-dup-modal" style="max-width:380px">
        <div class="sw-modal-head">
          <div class="sw-modal-title">Korting</div>
          <button class="icon-btn" onclick="__swDiscountClose()" title="Sluiten">${svg(I.x || I.warn, 'width:16px;height:16px')}</button>
        </div>
        <div class="sw-modal-body" style="padding:18px 20px">
          <label class="tk-field"><span class="tk-field-l">Korting (%)</span>
            <input class="ib-input" type="number" min="0" max="100" step="0.01"
                   placeholder="bv. 10" value="${esc(_sw.discountModal.draft)}"
                   oninput="__swDiscountDraft(this.value)"
                   onkeydown="if(event.key==='Enter'){event.preventDefault();__swDiscountApply()}">
          </label>
        </div>
        <div class="sw-modal-foot">
          <button class="btn btn-ghost" onclick="__swDiscountClose()">Annuleren</button>
          <div style="flex:1"></div>
          <button class="btn btn-primary" onclick="__swDiscountApply()">Toepassen</button>
        </div>
      </div>
    </div>`;
  }
  const eurFmt = (n) => (n == null || isNaN(Number(n))) ? '—' : '€' + Number(n).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  function stepBetaling() {
    const w = _sw.wizard;
    const totals = calcTotals();
    const minStart = _swMinStartDateNL();
    const dnBounds = _downDateEffBounds();
    const tsBounds = _termStartEffBounds();
    const hasDown = _hasDownpayment();
    const previewText = _buildQuotationTitleFE();

    const excBlock = w.exception_flagged ? (() => {
      const reasons = String(w.exception_reasons || '').split(',').map(s => s.trim()).filter(Boolean);
      const labels  = reasons.map(r => r === 'low_term_amount' ? 'lage termijn' : (r === 'late_start' ? 'late startdatum' : r));
      const parts   = [];
      if (labels.length) parts.push(labels.join(' + '));
      if (w.exception_fee_agreed) parts.push('€100 reserveringsfee akkoord');
      const summary = parts.join(' · ') || 'goedgekeurd';
      return `<div class="sw-exc-approved">
        <div>
          <b>Uitzondering goedgekeurd</b>
          <div class="sw-exc-approved-sub">${esc(summary)}</div>
          ${w.exception_reason_note ? `<div class="sw-exc-approved-note">Reden: ${esc(w.exception_reason_note)}</div>` : ''}
        </div>
        <button class="btn btn-ghost" onclick="__swUndoException()">Ongedaan maken</button>
      </div>`;
    })() : '';

    return `<div class="sw-step">
      <h2 class="sw-step-title">4. Betalingsvoorwaarden</h2>
      <p class="sw-step-sub">Startdatum cursus is verplicht. Aanbetaling is optioneel; termijnen zijn verplicht (minimaal 1). Vul een aanbetaling in en de bijbehorende datum is ook verplicht.</p>

      <div class="tk-field-row">
        <label class="tk-field"><span class="tk-field-l">Startdatum cursus <span class="tk-req">*</span></span>
          <input class="ib-input" type="date" value="${esc(w.payment_start_date)}" min="${esc(minStart || '')}"
                 onchange="__swSetPayStart(this.value)">
          <span class="tk-field-hint">Min. vandaag + 3 kalenderdagen (SEPA + boekhouding buffer).</span>
        </label>
        <div class="tk-field"></div>
      </div>

      <div class="tk-field-row">
        <label class="tk-field"><span class="tk-field-l">Aanbetaling (€)</span>
          <input class="ib-input" type="number" step="0.01" min="0" placeholder="bv. 1500"
                 value="${esc(w.payment_downpayment_amount)}"
                 oninput="__swSetPayDownAmt(this.value)">
        </label>
        <label class="tk-field"><span class="tk-field-l">Aanbetaling-datum</span>
          <input class="ib-input" type="date" value="${esc(w.payment_downpayment_date)}"
                 ${dnBounds.min ? `min="${esc(dnBounds.min)}"` : ''}
                 ${dnBounds.max ? `max="${esc(dnBounds.max)}"` : ''}
                 onchange="__swSetPayDownDate(this.value)">
          <span class="tk-field-hint">Minstens 3 dagen vóór de startdatum.</span>
        </label>
      </div>

      <div class="tk-field-row">
        <label class="tk-field"><span class="tk-field-l">Aantal termijnen <span class="tk-req">*</span></span>
          <input class="ib-input" type="number" min="1" max="60" placeholder="bv. 12"
                 title="Verplicht — minimaal 1 termijn"
                 value="${esc(w.payment_term_count)}"
                 oninput="__swSetPayTermCount(this.value)">
        </label>
        <label class="tk-field"><span class="tk-field-l">Datum 1e termijn</span>
          <input class="ib-input" type="date" value="${esc(w.payment_term_start_date)}"
                 ${tsBounds.min ? `min="${esc(tsBounds.min)}"` : ''}
                 ${tsBounds.max ? `max="${esc(tsBounds.max)}"` : ''}
                 onchange="__swSetPayTermStart(this.value)">
          <span class="tk-field-hint">${hasDown
            ? 'Met aanbetaling: tot 30 dagen ná startdatum toegestaan.'
            : 'Zonder aanbetaling: uiterlijk 3 dagen vóór startdatum.'}</span>
        </label>
      </div>

      <label class="tk-field"><span class="tk-field-l">Termijnbedrag</span>
        <input class="ib-input" readonly
               value="${w.payment_term_amount !== '' && w.payment_term_amount != null && !isNaN(Number(w.payment_term_amount)) ? '€' + Number(w.payment_term_amount).toFixed(2) : ''}"
               placeholder="—">
        <span class="tk-field-hint">Auto-berekend: (totaal ${_reservationFeeApplies() ? '− €100 fee ' : ''}− aanbetaling) / aantal termijnen. Totaal offerte incl. BTW: <b>${eurFmt(totals.total)}</b>.</span>
      </label>

      <div class="sw-preview-box">
        <div class="tk-field-l">Wat komt er op de offerte?</div>
        <div class="sw-preview-body">${previewText ? `Op offerte komt: '${esc(previewText)}'` : 'Op offerte komt: geen extra info (alleen totaalbedrag)'}</div>
      </div>

      ${excBlock}
    </div>`;
  }
  // Exception-approval modal (5e overlay, opent bij stap 4 -> 5).
  function excModalHtml() {
    const m = _sw.exceptionModal;
    if (!m.detect) return '';
    const d = m.detect;
    const reasons = [];
    if (d.lowTerm) reasons.push(`<li>Termijnbedrag <b>€${d.termAmt.toLocaleString('nl-NL')}</b> ligt onder het minimum van <b>€${d.minTerm.toLocaleString('nl-NL')}</b>.</li>`);
    if (d.lateStart) reasons.push(`<li>Startdatum ligt <b>${d.daysToStart} dagen</b> in de toekomst (max. <b>${d.maxDays}</b>).</li>`);
    const hasNote = String(m.note || '').trim().length > 0;
    const feeOk = !d.lateStart || m.feeChecked;
    const approveDisabled = !(hasNote && feeOk);
    return `<div class="sw-dup-back" onclick="if(event.target===this)__swExcClose()">
      <div class="sw-dup-modal" style="max-width:520px">
        <div class="sw-modal-head">
          <div class="sw-modal-title">Goedkeuring vereist</div>
          <button class="icon-btn" onclick="__swExcClose()" title="Sluiten">${svg(I.x || I.warn, 'width:16px;height:16px')}</button>
        </div>
        <div class="sw-modal-body" style="padding:16px 18px">
          <ul class="sw-exc-reasons">${reasons.join('')}</ul>
          <div class="sw-exc-hint">Neem contact op met een van de managers (Jeffrey of Maxim) voor goedkeuring.</div>
          <label class="tk-field" style="margin-top:12px">
            <span class="tk-field-l">Reden van de uitzondering <span class="tk-req">*</span></span>
            <textarea class="ib-input" rows="3" placeholder="Waarom valt deze offerte buiten de standaard? Wie heeft goedgekeurd?"
                      oninput="__swExcNote(this.value)">${esc(m.note)}</textarea>
          </label>
          ${d.lateStart ? `
            <div class="sw-check-row" style="margin-top:12px">
              <label>
                <input type="checkbox" ${m.feeChecked ? 'checked' : ''} onchange="__swExcFee(this.checked)">
                <span>Klant gaat akkoord met <b>€100 reserveringsfee</b> voor de reservering. <span class="tk-req">*</span></span>
              </label>
            </div>
          ` : ''}
        </div>
        <div class="sw-modal-foot">
          <button class="btn btn-ghost" onclick="__swExcReject()">Manager niet akkoord</button>
          <div style="flex:1"></div>
          <button class="btn btn-primary" onclick="__swExcApprove()" ${approveDisabled ? 'disabled' : ''}>Goedgekeurd door manager</button>
        </div>
      </div>
    </div>`;
  }
  function stepReview() {
    const w = _sw.wizard;
    return `<div class="sw-step">
      <h2 class="sw-step-title">5. Bevestiging & versturen</h2>
      <p class="sw-step-sub">Review alle secties + submit naar /api/sales-deal-create.</p>
      <div class="sv-card">
        <div class="sv-card-head">${svg(I.doc)}Samenvatting</div>
        <div class="sv-card-body">
          <div class="sv-row"><span>Entiteit</span><b>${esc(w.tl_department_id) || '—'}</b></div>
          <div class="sv-row"><span>Klanttype</span><b>${w.is_company ? 'Bedrijf' : 'Consument'}</b></div>
          <div class="sv-row"><span>Naam</span><b>${esc((w.first_name + ' ' + w.last_name).trim()) || '—'}</b></div>
          <div class="sv-row"><span>E-mail</span><b class="mono">${esc(w.email) || '—'}</b></div>
          ${w.source_lead_id ? `<div class="sv-row"><span>Bron-lead</span><b class="mono">${esc(w.source_lead_id.slice(0, 8))}…</b></div>` : ''}
        </div>
      </div>
      <div class="sv-empty" style="padding:22px;margin-top:10px;background:var(--amber-soft);border:1px dashed var(--amber-line);color:var(--amber);border-radius:8px">
        <b>PLACEHOLDER</b> · Volledig review-scherm met "Bewerken →"-links per sectie komt in volgende iteratie
        (port van sales-wizard.html renderReview() r1476-1568).
      </div>
    </div>`;
  }

  function renderStep() {
    switch (_sw.step) {
      case 1: return stepBedrijf();
      case 2: return stepKlant();
      case 3: return stepProducten();
      case 4: return stepBetaling();
      case 5: return stepReview();
      default: return '';
    }
  }

  // wizardModal wordt door renderWizard() in #sw-v2-root geplaatst (in <body>).
  // Root heeft zelf al class .sw-modal-back — hier alleen de INNER content.
  function wizardModal() {
    const isLast = _sw.step === 5;
    return `<div class="sw-modal" onclick="event.stopPropagation()">
        <div class="sw-modal-head">
          <div class="sw-modal-title">Nieuwe offerte · v2</div>
          <span class="pill pill-warn">Batch 2 · scaffold (${_sw.step}/5)</span>
          <button class="icon-btn" onclick="__swClose()" title="Sluiten">${svg(I.x || I.warn, 'width:16px;height:16px')}</button>
        </div>
        <div class="sw-modal-body sw-body">
          ${progress()}
          ${renderStep()}
        </div>
        <div class="sw-modal-foot">
          <button class="btn" onclick="__swClose()">Annuleren</button>
          <div style="flex:1"></div>
          ${_sw.step > 1 ? `<button class="btn" onclick="__swGoStep(${_sw.step - 1})">← Vorige</button>` : ''}
          ${!isLast ? `<button class="btn btn-primary" onclick="__swNext()">Volgende →</button>` : ''}
          ${isLast ? `<button class="btn btn-primary" onclick="__swSubmit()" ${_sw.submitting ? 'disabled' : ''}>
            ${_sw.submitting ? 'Verzenden…' : 'Verzenden'}
          </button>` : ''}
        </div>
      </div>`;
  }

  // Esc-volgorde: eerst top-most overlay, dan wizard-close.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (_sw.exceptionModal.open) { e.preventDefault(); window.__swExcClose(); return; }
    if (_sw.discountModal.open)  { e.preventDefault(); window.__swDiscountClose(); return; }
    if (_sw.picker.open)         { e.preventDefault(); window.__swPickerClose(); return; }
    if (_sw.dupModal.open)       { e.preventDefault(); window.__swDupCheckClose(); return; }
    if (_sw.open)                { e.preventDefault(); window.__swClose(); }
  });

  // Eerste ensureRoot + backdrop-binding gebeurt bij eerste __swOpen. Voor
  // devs die dit script per ongeluk vóór DFO laden: expose ook voor console.
  window.__swRender = renderWizard;

  console.debug('[sales-wizard-v2] loaded — call window.__swOpen() to launch scaffold');
})();
