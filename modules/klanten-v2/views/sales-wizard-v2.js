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
    trajecten: null,                   // /api/leads-trajecten
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
      // Stap 3 — offerte-inhoud
      traject_variant_id: '',
      discount_percentage: 0,
      sale_type: 'domestic',            // domestic | foreign | reverse-charge
      quote_reference: '',
      products: [],                      // [{product_id, product_name, quantity, price_per_unit, vat_percentage, price_includes_vat}]
      // Stap 4 — betalingsvoorwaarden (optioneel)
      start_date: '',
      duration_months: 12,
      payment_start_date: '',
      payment_downpayment_amount: '',
      payment_downpayment_date: '',
      payment_term_count: '',
      payment_term_start_date: '',
      payment_term_amount: '',
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
      // Wizard-body + optionele dup-check-overlay (2e modal bovenop).
      root.innerHTML = wizardModal() + (_sw.dupModal.open ? dupModalHtml() : '');
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
    if (n === 3 && !_sw.trajecten) queueMicrotask(loadTrajecten);
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
    const data = await tryFetch('leads-trajecten', '/api/leads-trajecten');
    _sw.trajecten = Array.isArray(data?.trajecten) ? data.trajecten : [];
    renderWizard();
  }

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
    return `<div class="sw-step">
      <h2 class="sw-step-title">3. Offerte & producten</h2>
      <p class="sw-step-sub">Traject-select + product-regels (LMS-picker) + kortingen + custom regels + BTW-varianten.</p>
      <div class="sv-empty" style="padding:32px;background:var(--amber-soft);border:1px dashed var(--amber-line);color:var(--amber);border-radius:8px">
        <b>PLACEHOLDER</b> · Deze stap wordt in de volgende iteratie geport uit sales-wizard.html:311-317 + populateTrajectSelect + renderDealProducts + renderTags.
        Includeert: traject-select, product-regels (LMS-picker met quantity/price_per_unit/vat_percentage/price_includes_vat), custom regels, korting-percentage, sale_type (domestic/foreign/reverse-charge), quote_reference, tag-systeem.
      </div>
    </div>`;
  }
  function stepBetaling() {
    return `<div class="sw-step">
      <h2 class="sw-step-title">4. Betalingsvoorwaarden (optioneel)</h2>
      <p class="sw-step-sub">Down-payment + termijnen + reserveringsfee.</p>
      <div class="sv-empty" style="padding:32px;background:var(--amber-soft);border:1px dashed var(--amber-line);color:var(--amber);border-radius:8px">
        <b>PLACEHOLDER</b> · Deze stap wordt geport uit sales-wizard.html:318-430 (blok "STAP 4: Betalingsvoorwaarden").
        Includeert: payment_start_date, payment_downpayment_amount/_date, payment_term_count/_start_date/_amount, reserveringsfee-checkbox met bypass-permission.
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
          ${!isLast ? `<button class="btn btn-primary" onclick="__swGoStep(${_sw.step + 1})">Volgende →</button>` : ''}
          ${isLast ? `<button class="btn btn-primary" onclick="__swSubmit()" ${_sw.submitting ? 'disabled' : ''}>
            ${_sw.submitting ? 'Verzenden…' : 'Verzenden'}
          </button>` : ''}
        </div>
      </div>`;
  }

  // Esc: sluit eerst dup-modal (2e overlay), dan pas wizard.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (_sw.dupModal.open) { e.preventDefault(); window.__swDupCheckClose(); return; }
    if (_sw.open)          { e.preventDefault(); window.__swClose(); }
  });

  // Eerste ensureRoot + backdrop-binding gebeurt bij eerste __swOpen. Voor
  // devs die dit script per ongeluk vóór DFO laden: expose ook voor console.
  window.__swRender = renderWizard;

  console.debug('[sales-wizard-v2] loaded — call window.__swOpen() to launch scaffold');
})();
