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
    // Stap 5 — TL-status voor banner-varianten (v1 state.tlConnected r479-480)
    tlConnected: null,                 // null=unknown, true=connected, false=not
    tlUserInfo: null,                  // { email, ... } uit teamleader-test-connection
    tlStatusLoading: false,
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
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // ── Debug-log (?debug=1) ─────────────────────────────────────────────
  // Jeffrey heeft geen devtools — daarom on-page log-panel dat de laatste
  // events toont. Zichtbaar als de URL ?debug=1 bevat. Elk log-entry heeft
  // timestamp + korte label + payload. Renderd onderaan de wizard-modal.
  const _sw_dbg = { on: false, entries: [] };
  try { _sw_dbg.on = new URLSearchParams(location.search).get('debug') === '1'; } catch (_) {}
  function _swLog(label, payload) {
    if (!_sw_dbg.on) return;
    const t = new Date().toISOString().slice(11, 23);
    _sw_dbg.entries.push({ t, label, payload: payload === undefined ? null : payload });
    if (_sw_dbg.entries.length > 40) _sw_dbg.entries.splice(0, _sw_dbg.entries.length - 40);
    // Real-time update van het debug-blok zonder full re-render.
    const box = document.getElementById('sw-dbg-body');
    if (box) box.innerHTML = _renderDbgBodyHtml();
  }
  function _renderDbgBodyHtml() {
    return _sw_dbg.entries.slice().reverse().map((e) => {
      const pl = e.payload == null ? '' : (typeof e.payload === 'string' ? e.payload : (() => { try { return JSON.stringify(e.payload); } catch (_) { return String(e.payload); } })());
      return `<div style="font-family:'IBM Plex Mono',monospace;font-size:11px;line-height:1.45;border-bottom:1px dashed rgba(255,255,255,.08);padding:3px 0"><span style="color:#7aa5cc">${e.t}</span> <b>${esc(e.label)}</b>${pl ? ' <span style="color:#c8d1dd">' + esc(pl.length > 200 ? pl.slice(0, 200) + '…' : pl) + '</span>' : ''}</div>`;
    }).join('');
  }
  function _renderDbgPanel() {
    if (!_sw_dbg.on) return '';
    return `<div id="sw-dbg" style="position:fixed;left:12px;bottom:12px;width:520px;max-height:36vh;overflow:auto;background:rgba(11,17,24,.95);color:#e6ecf3;border:1px solid #2a3746;border-radius:8px;padding:8px 10px;z-index:9999;box-shadow:0 12px 32px rgba(0,0,0,.5)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <b style="color:#8ac6ff;font-size:12px">🔧 sales-wizard debug</b>
        <span style="color:#8a95a3;font-size:11px;flex:1">${_sw_dbg.entries.length} events</span>
        <a href="#" onclick="event.preventDefault();__swDbgClear()" style="color:#8ac6ff;font-size:11px">wissen</a>
      </div>
      <div id="sw-dbg-body">${_renderDbgBodyHtml()}</div>
    </div>`;
  }
  window.__swDbgClear = () => { _sw_dbg.entries = []; const b = document.getElementById('sw-dbg-body'); if (b) b.innerHTML = ''; };
  // Expose voor cross-module routing-logs (bv. sales-v2 __svOfferteNew).
  window.__swLog = _swLog;
  window.__swDbgOn = () => _sw_dbg.on;
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
  // Focus-restore snapshot: identify active-element vóór innerHTML-replace
  // zodat we 'em daarna kunnen terugvinden + cursor kunnen zetten. Gebruikt
  // data-fkey attribute op inputs; fallback op id.
  function _snapshotFocus(root) {
    const a = document.activeElement;
    if (!a || !root.contains(a)) return null;
    const snap = {
      key:      a.getAttribute('data-fkey') || a.id || null,
      selStart: null,
      selEnd:   null,
    };
    try {
      if (a.selectionStart != null) {
        snap.selStart = a.selectionStart;
        snap.selEnd   = a.selectionEnd;
      }
    } catch (_) { /* number/date inputs kunnen throwen op selectionStart */ }
    return snap.key ? snap : null;
  }
  function _restoreFocus(root, snap) {
    if (!snap || !snap.key) return;
    let el = root.querySelector(`[data-fkey="${snap.key}"]`);
    if (!el) el = document.getElementById(snap.key);
    if (!el) return;
    try { el.focus({ preventScroll: true }); } catch (_) { try { el.focus(); } catch (__) {} }
    if (snap.selStart != null) {
      try { el.setSelectionRange(snap.selStart, snap.selEnd); } catch (_) {}
    }
  }

  function renderWizard() {
    const root = ensureRoot();
    // Backdrop-click sluit — idempotent gebonden bij eerste render.
    if (!root._swBackdropBound) {
      root._swBackdropBound = true;
      root.addEventListener('click', (e) => { if (e.target === root && _sw.open) window.__swClose(); });
      // Delegated action-handler voor data-swact-buttons (kwote-veilig,
      // vervangt de brittle inline onclick="fn('${esc(id)}', ${JSON.stringify(name)…})"
      // patronen die bij zeldzame quote-combinaties silent stukgingen).
      root.addEventListener('click', (e) => {
        const btn = e.target && (e.target.closest ? e.target.closest('[data-swact]') : null);
        if (!btn) return;
        const act = btn.getAttribute('data-swact');
        _swLog('click:' + act, { id: btn.getAttribute('data-swdb-id') || btn.getAttribute('data-swtl-idx') || null });
        if (act === 'use-db') {
          const id = btn.getAttribute('data-swdb-id');
          const m  = (id && _sw.dupModal.dbById && _sw.dupModal.dbById.get(id)) || null;
          if (!m) { _swLog('use-db: geen match in dbById', id); return; }
          window.__swUseDbCustomer(m);
        } else if (act === 'use-tl') {
          const i = Number(btn.getAttribute('data-swtl-idx'));
          const m = (Array.isArray(_sw.dupModal.tlMatches) && _sw.dupModal.tlMatches[i]) || null;
          if (!m) { _swLog('use-tl: geen match op idx', i); return; }
          window.__swUseTlContact(m);
        }
      });
    }
    // Snapshot focus BEFORE innerHTML swap (structural renders zoals stap-
    // wissel of chip-toggle wissen de input-node — cursor gaat weg zonder
    // deze restore).
    const snap = _snapshotFocus(root);
    if (_sw.open) {
      // Wizard-body + optionele sub-overlays (dup / picker / discount).
      // Alleen ÉÉN sub-overlay tegelijk actief (Esc-volgorde: picker → dup →
      // discount → wizard). Simpel: laatste-open wint via CSS z-index.
      let extras = '';
      if (_sw.dupModal.open)       extras += dupModalHtml();
      if (_sw.picker.open)         extras += pickerModalHtml();
      if (_sw.discountModal.open)  extras += discountModalHtml();
      if (_sw.exceptionModal.open) extras += excModalHtml();
      root.innerHTML = wizardModal() + extras + _renderDbgPanel();
      root.classList.add('is-open');
    } else {
      root.classList.remove('is-open');
      root.innerHTML = '';
    }
    _restoreFocus(root, snap);
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
    if (n === 5) {
      // TL-status ophalen voor banner + submit-knop variant (v1 r885 init +
      // r1531 renderReview). Lazy — eerste bezoek stap 5.
      if (_sw.tlConnected === null && !_sw.tlStatusLoading) queueMicrotask(loadTlStatus);
      _recomputeTermAmount();
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
    // Ontkoppel bestaande-klant match + open dup-modal opnieuw. Voorheen
    // alleen reset — user verwacht dat de zoek-modal weer opent zodat 'ie
    // direct een andere klant kan pikken. Fallback als email/phone leeg
    // zijn: dup-modal opent niet automatisch (alert vanuit __swDupCheckOpen).
    _swLog('swap-customer', { hadId: _sw.matched_customer_id });
    _sw.matched_customer_id = null;
    _sw.existingCustName = null;
    _sw.duplicate_check_status = 'idle';
    _sw.dirty = true;
    renderWizard();
    // Kick off search-modal wanneer email OF phone al gevuld is.
    const em = String(_sw.wizard.email || '').trim();
    const ph = String(_sw.wizard.phone || '').trim();
    if (em || ph) queueMicrotask(() => window.__swDupCheckOpen());
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
      // Bouw id→match lookup zodat de delegated data-swact click-handler
      // het volledige object terug kan vinden (inclusief NAW voor prefill).
      _sw.dupModal.dbById = new Map();
      for (const m of _sw.dupModal.dbMatches) { if (m && m.id) _sw.dupModal.dbById.set(String(m.id), m); }
      _swLog('dup-loaded', { db: _sw.dupModal.dbMatches.length, tl: _sw.dupModal.tlMatches.length });
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
  // Accepteert nu een volledig MATCH-object (id + NAW). Wordt aangeroepen
  // via de delegated data-swact="use-db" click-handler (id-lookup in
  // _sw.dupModal.dbById). Ook backwards-compatible met de oude
  // (id, name) signature — dan wordt alleen id + name gezet zonder NAW.
  window.__swUseDbCustomer = (mOrId, maybeName) => {
    const m = (mOrId && typeof mOrId === 'object') ? mOrId : { id: mOrId, name: maybeName };
    if (!m || !m.id) { _swLog('use-db: geen id', m); return; }
    _swLog('use-db: prefill', { id: m.id, name: m.name, has_addr: !!m.address_street });
    _sw.matched_customer_id = String(m.id);
    _sw.existingCustName = String(m.name || '—');
    // NAW-prefill uit de dup-check response (extended fields).
    const w = _sw.wizard;
    if (m.is_company != null)     w.is_company = !!m.is_company;
    if (m.company_name)           w.company_name = m.company_name;
    if (m.kvk_number)             w.kvk_number = m.kvk_number;
    if (m.vat_number)             w.vat_number = m.vat_number;
    if (m.first_name)             w.first_name = m.first_name;
    if (m.last_name)              w.last_name  = m.last_name;
    if (m.email)                  w.email      = m.email;
    if (m.phone)                  w.phone      = m.phone;
    if (m.date_of_birth)          w.date_of_birth = String(m.date_of_birth).slice(0, 10);
    if (m.address_street)         w.address_street = m.address_street;
    if (m.address_number)         w.address_number = m.address_number;
    if (m.address_postal)         w.address_postal = m.address_postal;
    if (m.address_city)           w.address_city   = m.address_city;
    if (m.address_country === 'BE' || m.address_country === 'NL') w.address_country = m.address_country;
    // Adres was al bekend → toon in de UI.
    if (m.address_street || m.address_city) w.address_known = true;
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
  // "Bewerken →" links vanuit stap-5 review (v1 [data-back] r1526).
  // Springt terug naar target-stap zonder next-guard te draaien (die is
  // alleen voor voorwaartse navigatie 4->5).
  window.__swBack = (n) => window.__swGoStep(n);

  // Submit-flow — 1-op-1 met v1 submitDeal(syncToTl) r1548-1641.
  // syncToTl = true  → 'Push naar Teamleader (concept, zonder versturen)'
  // syncToTl = false → 'Sla op (lokaal)' — geen TL-sync.
  window.__swSubmitDeal = async (syncToTl) => {
    if (_sw.submitting) return;
    _sw.submitting = true; renderWizard();
    const w = _sw.wizard;
    try {
      const payload = {
        customer_data: {
          is_company: !!w.is_company,
          company_name: w.company_name || null,
          kvk_number: w.kvk_number || null,
          vat_number: w.vat_number || null,
          first_name: w.first_name, last_name: w.last_name,
          email: w.email, phone: w.phone,
          address_street: w.address_street || null,
          address_number: w.address_number || null,
          address_postal: w.address_postal || null,
          address_city:   w.address_city   || null,
          address_country: (w.address_country === 'BE' ? 'BE' : 'NL'),
          date_of_birth:  w.date_of_birth || null,
          tags: Array.isArray(w.tags) ? w.tags : [],
          avg_ok: !!w.avg_ok,
        },
        deal_data: {
          source_lead_id: w.source_lead_id || null,
          quote_reference: w.quote_reference || null,
          start_date: w.start_date,
          duration_months: Number(w.duration_months) || 12,
          total_amount: calcTotals().total,
          tl_department_id: w.tl_department_id || null,
          traject_variant_id: w.traject_variant_id || null,
          discount_percentage: Number(w.discount_percentage) || 0,
          sale_type: w.sale_type || 'domestic',
          payment_start_date: w.payment_start_date || null,
          payment_downpayment_amount: Number(w.payment_downpayment_amount) || null,
          payment_downpayment_date: w.payment_downpayment_date || null,
          payment_term_count: Number(w.payment_term_count) || null,
          payment_term_start_date: w.payment_term_start_date || null,
          payment_term_amount: Number(w.payment_term_amount) || null,
          exception_flagged:     !!w.exception_flagged,
          exception_reasons:     w.exception_flagged ? (w.exception_reasons || null) : null,
          exception_reason_note: w.exception_flagged ? (w.exception_reason_note || null) : null,
          exception_fee_agreed:  !!w.exception_fee_agreed,
          reservation_fee_due:   _reservationFeeApplies(),
        },
        products: w.products,
        matched_customer_id: _sw.matched_customer_id,
        tl_imported_contact_id: _sw.tl_imported_contact_id,
        sync_to_tl: !!syncToTl,
        event_attendee_id: _sw.prefillEventAttendeeId || null,
      };
      let data;
      if (_sw.editDealId) {
        // Bestaande offerte updaten (edit-mode) — v1 r1608-1616.
        data = await tryPost('sales-deal-update', '/api/sales-deal-update',
          { deal_id: _sw.editDealId, deal_data: payload.deal_data, products: w.products }, 'PUT');
        data.customer_id = _sw.matched_customer_id;
        data.deal_id = _sw.editDealId;
      } else {
        data = await tryPost('sales-deal-create', '/api/sales-deal-create', payload);
      }
      _sw.submitting = false;
      const custBase = ((w.is_company ? w.company_name : `${w.first_name || ''} ${w.last_name || ''}`) || '—').trim();
      try { window.KV?.toast?.(_sw.editDealId ? `Offerte bijgewerkt voor ${custBase}` : `Offerte aangemaakt voor ${custBase}`); } catch (_) {}
      // TL-status-toasts (v1 r1625-1631).
      if (data?.tl_quotation_status === 'sent') {
        setTimeout(() => { try { window.KV?.toast?.(`Offerte verzonden naar ${w.email} via Teamleader`); } catch (_) {} }, 1200);
      } else if (data?.tl_quotation_status === 'draft' && syncToTl) {
        setTimeout(() => { try { window.KV?.toast?.('Offerte als concept aangemaakt in Teamleader — verstuur vanuit TL'); } catch (_) {} }, 1200);
      } else if (data?.tl_quotation_status === 'failed') {
        setTimeout(() => { try { window.KV?.toast?.(`Klant opgeslagen lokaal, offerte sturen mislukt: ${data.tl_error || ''}`); } catch (_) {} }, 1200);
      }
      // Draft opruimen — v1 r1632.
      try { await tryPost('drafts-del', '/api/sales-wizard-drafts', null, 'DELETE'); } catch (_) {}
      // Redirect naar offerte-detail — v1 r1636.
      _sw.open = false; _sw.step = 1; _sw.dirty = false;
      renderWizard();
      if (data?.deal_id) {
        setTimeout(() => { window.location.href = `/modules/offerte-detail.html?id=${encodeURIComponent(data.deal_id)}`; }, 700);
      }
    } catch (e) {
      _sw.submitting = false; renderWizard();
      try { window.KV?.toast?.('Verzenden mislukt: ' + (e?.message || 'onbekende fout')); } catch (_) {}
    }
  };
  // Backward-compat naam (in geval oude foot-knop nog __swSubmit gebruikt).
  window.__swSubmit = () => window.__swSubmitDeal(true);

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
  async function loadTlStatus() {
    if (_sw.tlStatusLoading) return;
    if (_sw.tlConnected !== null) return;
    _sw.tlStatusLoading = true;
    const data = await tryFetch('teamleader-test-connection', '/api/teamleader-test-connection');
    _sw.tlConnected = !!(data && data.connected);
    _sw.tlUserInfo  = data?.user_info || null;
    _sw.tlStatusLoading = false;
    renderWizard();
  }
  function trajectVariantLabel(variantId) {
    if (!variantId || !_sw.trajecten) return '';
    for (const t of _sw.trajecten) {
      for (const v of (t.variants || [])) {
        if (v.id === variantId) return `${t.name} > ${v.name}`;
      }
    }
    return '';
  }
  async function loadLeadSources() {
    // Loop-fix: expliciete in-flight guard i.p.v. alleen post-fetch state-check.
    // Zonder deze flag konden snelle __swGoStep(3) her-navigaties parallelle
    // fetches starten — elke completion triggerde renderWizard = flicker.
    if (_sw.leadSourcesLoading) return;
    if (_sw.leadSources !== null) return;
    _sw.leadSourcesLoading = true;
    const data = await tryFetch('lead-sources', '/api/lead-sources');
    _sw.leadSources = Array.isArray(data?.sources) ? data.sources
                    : Array.isArray(data) ? data : [];
    _sw.leadSourcesLoading = false;
    renderWizard();
  }
  async function applyTrajectVariant(variantId) {
    _swLog('applyTraject: start', { variantId });
    _sw.wizard.traject_variant_id = variantId || '';
    _sw.dirty = true;
    if (!variantId) { renderWizard(); return; }
    try {
      // Zorg dat productsCatalog geladen is VÓÓR we mappen — anders krijgen
      // alle regels prijs 0 (catalog.find retourneert undefined). Wacht in-
      // flight fetch af of trigger 'em.
      if (!_sw.productsCatalog && !_sw.productsLoading) {
        _swLog('applyTraject: catalog nog niet geladen, trigger loadProductsCatalog');
        await loadProductsCatalog();
      } else if (_sw.productsLoading) {
        _swLog('applyTraject: catalog in-flight, wachten');
        // Poll tot fetch klaar is (max 5s, tick 100ms).
        const t0 = Date.now();
        while (_sw.productsLoading && Date.now() - t0 < 5000) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      const catalog = _sw.productsCatalog || [];
      _swLog('applyTraject: catalog-size', catalog.length);
      // v1 doet /api/traject-variants?variant_id=X → { variant, products }.
      const data = await tryFetch('traject-variants', '/api/traject-variants?variant_id=' + encodeURIComponent(variantId));
      _swLog('applyTraject: fetch-return', {
        got: !!data,
        variant: data?.variant ? { id: data.variant.id, dur: data.variant.default_duration_months } : null,
        productsCount: Array.isArray(data?.products) ? data.products.length : null,
      });
      if (!data) { alert('Traject-variant laden mislukte (geen respons).'); return; }
      const vps = Array.isArray(data.products) ? data.products : [];
      if (!vps.length) {
        _swLog('applyTraject: LEEG — geen traject_variant_products voor deze variant', { variantId });
        alert('Deze traject-variant heeft (nog) geen gekoppelde producten in de database. Voeg ze toe via de admin/traject-editor.');
      }
      _sw.wizard.products = vps.map((vp) => {
        const p = catalog.find((x) => x && x.id === vp.product_id) || {};
        return {
          product_id: vp.product_id,
          product_name: p.name || ('Product ' + String(vp.product_id).slice(0, 6)),
          quantity: Number(vp.quantity) || 1,
          price_per_unit: Number(p.default_price) || 0,
          vat_percentage: p.vat_percentage ?? 21,
          price_includes_vat: !!p.price_includes_vat,
        };
      });
      if (data?.variant?.default_duration_months) {
        _sw.wizard.duration_months = Number(data.variant.default_duration_months);
      }
      _swLog('applyTraject: prefill klaar', {
        products: _sw.wizard.products.length,
        duration: _sw.wizard.duration_months,
      });
    } catch (e) {
      _swLog('applyTraject: EXCEPTION', e?.message || String(e));
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
    if (_sw.exceptionLimits._loading) return; // in-flight guard
    _sw.exceptionLimits._loading = true;
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
    _sw.exceptionLimits._loading = false;
  }

  // ── Surgical DOM-updates (BLOCKER-fix: geen full renderWizard() op typen) ─
  // Elk keystroke-handler op reken-velden (qty/prijs/pay-inputs) update ALLEEN
  // de betreffende computed DOM-nodes via querySelector. Vermijdt innerHTML-
  // swap → input-node blijft = cursor blijft staan. Structural changes (add
  // product, toggle vat-incl, open modal, stap-wissel, exception-flag flip
  // enz.) roepen wél renderWizard() aan, met focus-restore als safety net.
  function _root() { return document.getElementById('sw-v2-root'); }

  function _updateProductLine(i) {
    const root = _root(); if (!root) return;
    const rows = root.querySelectorAll('.dp-row');
    const p = _sw.wizard.products[i];
    if (rows[i] && p) {
      const sub = rows[i].querySelector('.dp-sub-line');
      if (sub) sub.textContent = eurFmt(lineAmounts(p).incl);
    }
    _updateTotalsBlock();
  }
  function _updateTotalsBlock() {
    const root = _root(); if (!root) return;
    const totalsEl = root.querySelector('.dp-totals');
    // Head-summary (aantal + totaal) altijd bijwerken als aanwezig.
    const head = root.querySelector('.sw-prod-head h3 small');
    const totals = calcTotals();
    if (head) head.textContent = _sw.wizard.products.length
      ? '· ' + _sw.wizard.products.length + ' × ' + eurFmt(totals.total) : '';
    if (!totalsEl) return; // stap-3 niet actief
    const discRow = totals.disc > 0
      ? `<div class="dp-total-row dp-total-disc"><span>Korting (${totals.disc}%)</span><span>−${eurFmt(totals.discountAmount)}</span></div>
         <div class="dp-total-row"><span>Subtotaal na korting</span><span>${eurFmt(totals.subtotalAfter)}</span></div>`
      : '';
    const vatRows = Object.keys(totals.vatByRate).sort((a, b) => Number(a) - Number(b))
      .map(r => `<div class="dp-total-row"><span>BTW ${r}%</span><span>${eurFmt(totals.vatByRate[r])}</span></div>`).join('');
    const discCtrl = totals.disc > 0
      ? `<a class="dp-disc-edit" onclick="__swDiscountOpen()">Korting (${totals.disc}%) wijzigen</a>
         · <a class="dp-disc-rm" onclick="__swDiscountRemove()">verwijderen</a>`
      : `<a class="dp-disc-add" onclick="__swDiscountOpen()">+ Korting</a>`;
    totalsEl.innerHTML = `
      <div class="dp-total-row"><span>Subtotaal excl. BTW</span><span>${eurFmt(totals.subtotalExcl)}</span></div>
      ${discRow}${vatRows}
      <div class="dp-total-row dp-total-big"><span>Totaal incl. BTW</span><span>${eurFmt(totals.total)}</span></div>
      <div class="dp-total-row dp-total-ctrl">${discCtrl}</div>`;
  }
  function _updatePayComputed() {
    const root = _root(); if (!root) return;
    _recomputeTermAmount();
    const w = _sw.wizard;
    const ta = root.querySelector('[data-fkey="sw4-pay-term-amount"]');
    if (ta) {
      ta.value = (w.payment_term_amount !== '' && w.payment_term_amount != null && !isNaN(Number(w.payment_term_amount)))
        ? '€' + Number(w.payment_term_amount).toFixed(2) : '';
    }
    const prev = root.querySelector('[data-fkey-body="sw4-preview"]');
    if (prev) {
      const t = _buildQuotationTitleFE();
      prev.textContent = t ? `Op offerte komt: '${t}'` : 'Op offerte komt: geen extra info (alleen totaalbedrag)';
    }
    // Term-start-date bounds + hint (afhankelijk van hasDownpayment + start).
    const ts = root.querySelector('[data-fkey="sw4-pay-term-start"]');
    if (ts) {
      const b = _termStartEffBounds();
      if (b.min) ts.setAttribute('min', b.min); else ts.removeAttribute('min');
      if (b.max) ts.setAttribute('max', b.max); else ts.removeAttribute('max');
      if (ts.value !== (w.payment_term_start_date || '')) ts.value = w.payment_term_start_date || '';
    }
    const tsHint = root.querySelector('[data-fkey-hint="sw4-pay-term-start"]');
    if (tsHint) tsHint.textContent = _hasDownpayment()
      ? 'Met aanbetaling: tot 30 dagen ná startdatum toegestaan.'
      : 'Zonder aanbetaling: uiterlijk 3 dagen vóór startdatum.';
    const dd = root.querySelector('[data-fkey="sw4-pay-down-date"]');
    if (dd) {
      const b = _downDateEffBounds();
      if (b.min) dd.setAttribute('min', b.min); else dd.removeAttribute('min');
      if (b.max) dd.setAttribute('max', b.max); else dd.removeAttribute('max');
      if (dd.value !== (w.payment_downpayment_date || '')) dd.value = w.payment_downpayment_date || '';
    }
  }
  // Als _revalidateExceptions de flag heeft geflipped, moet het banner-blok
  // verschijnen/verdwijnen — dat vereist een structural render. Deze wrapper
  // detecteert de flip en beslist zelf.
  function _revalidateAndMaybeRender() {
    const wasFlagged = _sw.wizard.exception_flagged;
    _revalidateExceptions();
    if (wasFlagged !== _sw.wizard.exception_flagged) renderWizard();
  }

  // Stap 4 handlers — nu surgical: state-mutatie + gerichte DOM-update i.p.v.
  // renderWizard() bij elke keystroke. Alleen bij structural flip (exception-
  // flag reset) valt back op renderWizard via _revalidateAndMaybeRender.
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
    _updatePayComputed();
    _revalidateAndMaybeRender();
  };
  window.__swSetPayDownAmt = (v) => {
    _sw.wizard.payment_downpayment_amount = String(v || '');
    _sw.dirty = true;
    _clampTermStartDate(true);
    _updatePayComputed();
    _revalidateAndMaybeRender();
  };
  window.__swSetPayDownDate = (v) => {
    _sw.wizard.payment_downpayment_date = String(v || '');
    _sw.dirty = true;
    _clampDownDate(true);
    // Down-date value kan door clamp gewijzigd zijn — sync input surgical.
    const dd = _root()?.querySelector('[data-fkey="sw4-pay-down-date"]');
    if (dd && dd.value !== (_sw.wizard.payment_downpayment_date || '')) {
      dd.value = _sw.wizard.payment_downpayment_date || '';
    }
  };
  window.__swSetPayTermCount = (v) => {
    const n = Math.max(0, Math.min(60, Number(v) || 0));
    _sw.wizard.payment_term_count = n === 0 ? '' : n;
    _sw.dirty = true;
    _updatePayComputed();
    _revalidateAndMaybeRender();
  };
  window.__swSetPayTermStart = (v) => {
    _sw.wizard.payment_term_start_date = String(v || '');
    _sw.dirty = true;
    // Geen computed downstream — puur state.
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
  // Qty/prijs: surgical — update alleen line-subtotaal + totals-block +
  // head-summary. GEEN renderWizard() → input-node blijft = cursor blijft.
  window.__swInputQty = (i, val) => {
    const arr = _sw.wizard.products; if (!arr[i]) return;
    arr[i].quantity = Math.max(1, Number(val) || 1);
    _sw.dirty = true;
    _updateProductLine(i);
  };
  window.__swInputPrice = (i, val) => {
    const arr = _sw.wizard.products; if (!arr[i]) return;
    arr[i].price_per_unit = Math.max(0, Number(val) || 0);
    _sw.dirty = true;
    _updateProductLine(i);
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
                 data-fkey="sw-tag-draft"
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
                <button type="button" class="btn btn-primary" data-swact="use-db" data-swdb-id="${esc(m.id)}">Gebruik deze klant</button>
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
                <button type="button" class="btn" data-swact="use-tl" data-swtl-idx="${i}">Gebruik dit contact</button>
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
                   data-fkey="sw3-qty-${i}"
                   oninput="__swInputQty(${i}, this.value)" aria-label="Aantal">
            <input class="ib-input dp-price" type="number" step="0.01" min="0" value="${Number(p.price_per_unit) || 0}"
                   data-fkey="sw3-price-${i}"
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
                   data-fkey="sw3-duration"
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
                   data-fkey="sw-picker-search"
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
                   data-fkey="sw-discount-draft"
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
                 data-fkey="sw4-pay-start"
                 onchange="__swSetPayStart(this.value)">
          <span class="tk-field-hint">Min. vandaag + 3 kalenderdagen (SEPA + boekhouding buffer).</span>
        </label>
        <div class="tk-field"></div>
      </div>

      <div class="tk-field-row">
        <label class="tk-field"><span class="tk-field-l">Aanbetaling (€)</span>
          <input class="ib-input" type="number" step="0.01" min="0" placeholder="bv. 1500"
                 value="${esc(w.payment_downpayment_amount)}"
                 data-fkey="sw4-pay-down-amt"
                 oninput="__swSetPayDownAmt(this.value)">
        </label>
        <label class="tk-field"><span class="tk-field-l">Aanbetaling-datum</span>
          <input class="ib-input" type="date" value="${esc(w.payment_downpayment_date)}"
                 ${dnBounds.min ? `min="${esc(dnBounds.min)}"` : ''}
                 ${dnBounds.max ? `max="${esc(dnBounds.max)}"` : ''}
                 data-fkey="sw4-pay-down-date"
                 onchange="__swSetPayDownDate(this.value)">
          <span class="tk-field-hint">Minstens 3 dagen vóór de startdatum.</span>
        </label>
      </div>

      <div class="tk-field-row">
        <label class="tk-field"><span class="tk-field-l">Aantal termijnen <span class="tk-req">*</span></span>
          <input class="ib-input" type="number" min="1" max="60" placeholder="bv. 12"
                 title="Verplicht — minimaal 1 termijn"
                 value="${esc(w.payment_term_count)}"
                 data-fkey="sw4-pay-term-count"
                 oninput="__swSetPayTermCount(this.value)">
        </label>
        <label class="tk-field"><span class="tk-field-l">Datum 1e termijn</span>
          <input class="ib-input" type="date" value="${esc(w.payment_term_start_date)}"
                 ${tsBounds.min ? `min="${esc(tsBounds.min)}"` : ''}
                 ${tsBounds.max ? `max="${esc(tsBounds.max)}"` : ''}
                 data-fkey="sw4-pay-term-start"
                 onchange="__swSetPayTermStart(this.value)">
          <span class="tk-field-hint" data-fkey-hint="sw4-pay-term-start">${hasDown
            ? 'Met aanbetaling: tot 30 dagen ná startdatum toegestaan.'
            : 'Zonder aanbetaling: uiterlijk 3 dagen vóór startdatum.'}</span>
        </label>
      </div>

      <label class="tk-field"><span class="tk-field-l">Termijnbedrag</span>
        <input class="ib-input" readonly
               data-fkey="sw4-pay-term-amount"
               value="${w.payment_term_amount !== '' && w.payment_term_amount != null && !isNaN(Number(w.payment_term_amount)) ? '€' + Number(w.payment_term_amount).toFixed(2) : ''}"
               placeholder="—">
        <span class="tk-field-hint">Auto-berekend: (totaal ${_reservationFeeApplies() ? '− €100 fee ' : ''}− aanbetaling) / aantal termijnen. Totaal offerte incl. BTW: <b>${eurFmt(totals.total)}</b>.</span>
      </label>

      <div class="sw-preview-box">
        <div class="tk-field-l">Wat komt er op de offerte?</div>
        <div class="sw-preview-body" data-fkey-body="sw4-preview">${previewText ? `Op offerte komt: '${esc(previewText)}'` : 'Op offerte komt: geen extra info (alleen totaalbedrag)'}</div>
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
                      data-fkey="sw-exc-note"
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
  // Stap 5 review — 1-op-1 met v1 renderReview() r1446-1546. Sectie-blokken
  // met "Bewerken →"-link per sectie. TL-banner varieert op tlConnected.
  function stepReview() {
    const w = _sw.wizard;
    const totals = calcTotals();

    // Entiteit-label
    const entity = (_sw.entities || []).find(e => e && e.tl_department_id === w.tl_department_id);
    const entityLabel = entity?.label || '';
    // Lead-source label
    const ls = (_sw.leadSources || []).find(s => s && s.id === w.source_lead_id);

    // BTW-breakdown voor review-tabel
    const btwRows = Object.keys(totals.vatByRate).sort((a, b) => Number(a) - Number(b))
      .map(r => `<tr><td colspan="3" class="rv-dim">BTW ${r}%</td><td class="rv-r">${eurFmt(totals.vatByRate[r])}</td></tr>`).join('');
    const discRows = totals.disc > 0
      ? `<tr class="rv-disc"><td colspan="3">Korting (${totals.disc}%)</td><td class="rv-r">−${eurFmt(totals.discountAmount)}</td></tr>
         <tr><td colspan="3" class="rv-dim">Subtotaal na korting</td><td class="rv-r">${eurFmt(totals.subtotalAfter)}</td></tr>`
      : '';

    const custName = w.is_company
      ? (w.company_name || '').trim()
      : `${w.first_name || ''} ${w.last_name || ''}`.trim();
    const custBadge = _sw.matched_customer_id
      ? '<span class="rv-badge rv-badge-teal">Bestaande klant</span>'
      : (_sw.tl_imported_contact_id
          ? '<span class="rv-badge rv-badge-teal">Geïmporteerd uit TeamLeader</span>'
          : '');

    const saleTypeLabel = w.sale_type === 'intracommunautair'
      ? 'Zakelijk België — Intracommunautair'
      : 'Normaal NL/BE';

    // TL-banner + submit-block
    let tlBannerHtml = '', submitHtml = '';
    if (_sw.tlStatusLoading || _sw.tlConnected === null) {
      tlBannerHtml = `<div class="rv-tl-banner rv-tl-loading">TeamLeader-status ophalen…</div>`;
      submitHtml = `<button class="btn" disabled>Wachten op TL-status…</button>`;
    } else if (_sw.tlConnected) {
      const who = _sw.tlUserInfo?.email ? ` als <b>${esc(_sw.tlUserInfo.email)}</b>` : '';
      tlBannerHtml = `<div class="rv-tl-banner rv-tl-ok">✓ Verbonden met TeamLeader${who} — de offerte wordt aangemaakt in TL.</div>`;
      submitHtml = `
        <button class="btn btn-primary" onclick="__swSubmitDeal(true)" ${_sw.submitting ? 'disabled' : ''}>
          ${_sw.submitting ? 'Verzenden…' : 'Push naar Teamleader (concept, zonder versturen)'}
        </button>
        <a class="rv-submit-alt" href="#" onclick="event.preventDefault();__swSubmitDeal(false)">Alleen lokaal opslaan (geen offerte versturen)</a>`;
    } else {
      tlBannerHtml = `<div class="rv-tl-banner rv-tl-warn">⚠ TeamLeader niet verbonden. Klant + offerte worden alleen lokaal opgeslagen. Manager kan TL verbinden via Admin → Integraties.</div>`;
      submitHtml = `
        <button class="btn" onclick="__swSubmitDeal(false)" ${_sw.submitting ? 'disabled' : ''}>
          ${_sw.submitting ? 'Verzenden…' : 'Sla op (lokaal)'}
        </button>
        <div class="rv-submit-hint">Offerte versturen kan later vanuit klant-detail.</div>`;
    }

    const hasPay = w.payment_start_date || Number(w.payment_downpayment_amount) > 0 || Number(w.payment_term_count) > 0;

    return `<div class="sw-step">
      <h2 class="sw-step-title">5. Bevestiging & versturen</h2>
      <p class="sw-step-sub">Bekijk alle gegevens, klik dan op versturen. Elke sectie is bewerkbaar via de "Bewerken →"-link.</p>

      <div class="rv-section">
        <div class="rv-head">
          <span class="rv-title">Klant ${custBadge}</span>
          <a class="rv-edit" href="#" onclick="event.preventDefault();__swBack(2)">Bewerken →</a>
        </div>
        <div class="rv-body">
          ${entityLabel ? `<div class="rv-line"><span class="rv-badge rv-badge-slate">Entiteit: ${esc(entityLabel)}</span></div>` : ''}
          <div class="rv-line"><b>${esc(custName || '—')}</b>${w.is_company ? ' <span class="rv-badge rv-badge-slate">Bedrijf</span>' : ''}</div>
          ${w.is_company && (w.first_name || w.last_name) ? `<div class="rv-line rv-dim">Contact: ${esc(`${w.first_name || ''} ${w.last_name || ''}`.trim())}</div>` : ''}
          ${w.is_company && w.kvk_number ? `<div class="rv-line rv-dim">KvK: ${esc(w.kvk_number)}</div>` : ''}
          ${w.is_company && w.vat_number ? `<div class="rv-line rv-dim">BTW: ${esc(w.vat_number)}</div>` : ''}
          <div class="rv-line rv-dim">${esc(w.email || '—')} · ${esc(w.phone || '—')}</div>
          <div class="rv-line rv-dim">${esc([w.address_street, w.address_number, w.address_postal, w.address_city].filter(Boolean).join(' ') || (w.address_known ? '(adres bekend, niet in offerte)' : '—'))}</div>
          ${w.date_of_birth ? `<div class="rv-line rv-dim">Geboortedatum: ${esc(w.date_of_birth)}</div>` : ''}
          ${w.tags?.length ? `<div class="rv-line">Tags: ${w.tags.map(t => `<span class="sw-chip is-on">${esc(t)}</span>`).join(' ')}</div>` : ''}
          ${_sw.matched_customer_id ? `<div class="rv-line"><a href="/modules/klanten.html?id=${encodeURIComponent(_sw.matched_customer_id)}" class="rv-link" target="_blank" rel="noopener">Bekijk volledige klant-detail →</a></div>` : ''}
          ${_sw.tl_imported_contact_id ? `<div class="rv-line rv-dim">Wordt aangemaakt in onze DB + gekoppeld aan TL contact <code>${esc(String(_sw.tl_imported_contact_id))}</code></div>` : ''}
          <div class="rv-line rv-ok">✓ ${w.avg_ok ? 'Geïnformeerd over privacyverklaring' : 'AVG-checkbox nog niet aangevinkt (blokkerend)'}</div>
        </div>
      </div>

      <div class="rv-section">
        <div class="rv-head">
          <span class="rv-title">Offerte</span>
          <a class="rv-edit" href="#" onclick="event.preventDefault();__swBack(3)">Bewerken →</a>
        </div>
        <div class="rv-body">
          <div class="rv-line rv-dim">Lead-bron: ${esc(ls?.name || ls?.label || '—')}</div>
          <div class="rv-line rv-dim">Offerte-referentie: ${esc(w.quote_reference || '—')}</div>
          <div class="rv-line rv-dim">Datum offerte: ${esc(w.start_date || '—')}</div>
          <div class="rv-line rv-dim">Looptijd: ${Number(w.duration_months) || 12} mnd</div>
          ${w.traject_variant_id ? `<div class="rv-line rv-dim">Traject: ${esc(trajectVariantLabel(w.traject_variant_id) || '—')}</div>` : ''}
          <div class="rv-line rv-dim">Type verkoop: ${esc(saleTypeLabel)}</div>
          <div class="rv-line"><b>Producten (${w.products.length}):</b></div>
          <div class="rv-tbl-wrap">
            <table class="rv-tbl">
              ${w.products.map(p => {
                const a = lineAmounts(p);
                return `<tr>
                  <td>${esc(p.product_name)}</td>
                  <td class="rv-r">${p.quantity}×</td>
                  <td class="rv-r rv-dim">${eurFmt(p.price_per_unit)} ${p.price_includes_vat ? 'incl' : 'excl'}</td>
                  <td class="rv-r"><b>${eurFmt(a.incl)}</b></td>
                </tr>`;
              }).join('')}
              <tr class="rv-total-sep"><td colspan="3" class="rv-dim">Subtotaal excl. BTW</td><td class="rv-r">${eurFmt(totals.subtotalExcl)}</td></tr>
              ${discRows}
              ${btwRows}
              <tr class="rv-total-big"><td colspan="3">Totaal incl. BTW</td><td class="rv-r">${eurFmt(totals.total)}</td></tr>
            </table>
          </div>
        </div>
      </div>

      ${hasPay ? `
      <div class="rv-section">
        <div class="rv-head">
          <span class="rv-title">Betalingsvoorwaarden</span>
          <a class="rv-edit" href="#" onclick="event.preventDefault();__swBack(4)">Bewerken →</a>
        </div>
        <div class="rv-body">
          ${w.payment_start_date ? `<div class="rv-line rv-dim">Startdatum cursus: ${esc(w.payment_start_date)}</div>` : ''}
          ${_reservationFeeApplies() ? `<div class="rv-line rv-warn"><b>Reserveringsfee (direct): ${eurFmt(RESERVATION_FEE_INCL)} incl. BTW</b></div>` : ''}
          ${Number(w.payment_downpayment_amount) > 0 ? `<div class="rv-line rv-dim">Aanbetaling: <b>${eurFmt(w.payment_downpayment_amount)}</b>${w.payment_downpayment_date ? ' op ' + esc(w.payment_downpayment_date) : ''}</div>` : ''}
          ${Number(w.payment_term_count) > 0 ? `<div class="rv-line rv-dim">Termijnen: <b>${w.payment_term_count} × ${eurFmt(w.payment_term_amount)}</b>${w.payment_term_start_date ? ' vanaf ' + esc(w.payment_term_start_date) : ''}</div>` : ''}
          ${_reservationFeeApplies() ? `<div class="rv-line rv-dim rv-small">Termijnen berekend over (totaal − €${RESERVATION_FEE_INCL} reserveringsfee${Number(w.payment_downpayment_amount) > 0 ? ' − aanbetaling' : ''}). De €${RESERVATION_FEE_INCL} wordt bij het aanmaken van het abonnement direct als aparte factuur geboekt+verstuurd.</div>` : ''}
          ${_buildQuotationTitleFE() ? `<div class="rv-line rv-dim rv-small">Op offerte komt: '${esc(_buildQuotationTitleFE())}'</div>` : ''}
          ${w.exception_flagged ? `<div class="rv-line rv-warn"><b>Uitzondering goedgekeurd</b> · ${esc(String(w.exception_reasons || '').split(',').map(r => r === 'low_term_amount' ? 'lage termijn' : (r === 'late_start' ? 'late startdatum' : r)).join(' + '))}${w.exception_fee_agreed ? ' · €100 fee akkoord' : ''}${w.exception_reason_note ? ' · reden: ' + esc(w.exception_reason_note) : ''}</div>` : ''}
        </div>
      </div>` : ''}

      ${tlBannerHtml}
      <div class="rv-submit-block">
        ${submitHtml}
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
          ${/* Stap 5: submit-knop staat in de review-body zelf (met TL-banner + variant), niet in de foot. */ ''}
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
