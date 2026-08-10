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
    trajecten: null,                   // /api/leads-trajecten
    prefillLeadId: null,
    prefillEventAttendeeId: null,
    dupCandidates: null,               // /api/sales-customers?search
    dupLoading: false,
    wizard: {
      // Stap 1
      tl_department_id: '',
      // Stap 2 — klant-NAW
      is_company: false,
      company_name: '', kvk_number: '', vat_number: '',
      first_name: '', last_name: '', email: '', phone: '',
      address_street: '', address_number: '', address_postal: '', address_city: '',
      address_country: 'NL',
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

  // ── Handlers ──────────────────────────────────────────────────────
  window.__swOpen = () => {
    _sw.open = true; _sw.step = 1; _sw.dirty = false;
    readPrefill();
    // Load entities (Stap 1) + trajecten (Stap 3, lazy)
    if (!_sw.entities && !_sw.entitiesLoading) queueMicrotask(loadEntities);
    window.DFO.render();
  };
  window.__swClose = () => {
    if (_sw.dirty && !confirm('Er zijn niet-opgeslagen wijzigingen. Wizard sluiten?')) return;
    _sw.open = false;
    window.DFO.render();
  };
  window.__swGoStep = (n) => {
    n = Math.max(1, Math.min(5, Number(n) || 1));
    _sw.step = n;
    if (n === 3 && !_sw.trajecten) queueMicrotask(loadTrajecten);
    window.DFO.render();
  };
  window.__swInput = (field, val) => { _sw.wizard[field] = val; _sw.dirty = true; };
  window.__swToggleCompany = () => { _sw.wizard.is_company = !_sw.wizard.is_company; _sw.dirty = true; window.DFO.render(); };
  window.__swPickEntity = (id) => { _sw.wizard.tl_department_id = id; _sw.dirty = true; window.DFO.render(); };
  window.__swSubmit = async () => {
    if (_sw.submitting) return;
    _sw.submitting = true; window.DFO.render();
    try {
      const payload = { ...(_sw.wizard), matched_customer_id: _sw.matched_customer_id, event_attendee_id: _sw.prefillEventAttendeeId };
      const result = await tryPost('sales-deal-create', '/api/sales-deal-create', payload);
      _sw.submitting = false;
      alert('Offerte aangemaakt: ' + (result?.deal?.id || 'ok'));
      _sw.open = false; _sw.step = 1; _sw.dirty = false;
      try { await tryPost('drafts-del', '/api/sales-wizard-drafts', null, 'DELETE'); } catch (_) {}
      window.DFO.render();
    } catch (e) {
      _sw.submitting = false; window.DFO.render();
      alert('Verzenden mislukt: ' + (e?.message || 'onbekende fout'));
    }
  };

  async function loadEntities() {
    _sw.entitiesLoading = true;
    const data = await tryFetch('company-entities', '/api/company-entities');
    _sw.entities = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
    _sw.entitiesLoading = false;
    if (_sw.entities.length && !_sw.wizard.tl_department_id) {
      _sw.wizard.tl_department_id = _sw.entities[0].tl_department_id;
    }
    window.DFO.render();
  }
  async function loadTrajecten() {
    const data = await tryFetch('leads-trajecten', '/api/leads-trajecten');
    _sw.trajecten = Array.isArray(data?.trajecten) ? data.trajecten : [];
    window.DFO.render();
  }

  // ── Progress + shell ──────────────────────────────────────────────
  const STEP_LABELS = ['Bedrijf', 'Klantgegevens', 'Offerte & producten', 'Betalingsvoorwaarden', 'Bevestiging'];
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
    if (_sw.entitiesLoading) return `<div class="sv-empty" style="padding:32px">Entiteiten laden…</div>`;
    if (!_sw.entities || !_sw.entities.length) return `<div class="sv-empty" style="padding:32px">Geen entiteiten gevonden. Manager kan ze toevoegen via Admin > Entiteiten.</div>`;
    return `<div class="sw-step">
      <h2 class="sw-step-title">1. Kies de entiteit</h2>
      <p class="sw-step-sub">Op welke van je bedrijfsentiteiten komt deze offerte?</p>
      <div class="sw-entity-grid">
        ${_sw.entities.map(e => `
          <button class="sw-entity-card ${w.tl_department_id === e.tl_department_id ? 'is-selected' : ''}" onclick="__swPickEntity('${esc(e.tl_department_id)}')">
            <div class="sw-entity-name">${esc(e.label || e.name)}</div>
            ${e.address_country ? `<div class="sw-entity-country">${esc(e.address_country)}</div>` : ''}
          </button>
        `).join('')}
      </div>
    </div>`;
  }
  function stepKlant() {
    const w = _sw.wizard;
    return `<div class="sw-step">
      <h2 class="sw-step-title">2. Klantgegevens</h2>
      <p class="sw-step-sub">Bedrijf of consument? Vul basis-NAW.
        ${_sw.wizard.source_lead_id ? `<span class="pill pill-info">Prefill vanuit lead ${esc(_sw.wizard.source_lead_id.slice(0, 8))}…</span>` : ''}
      </p>
      <div class="sw-toggle-row">
        <label><input type="radio" name="sw-btype" ${!w.is_company ? 'checked' : ''} onchange="__swToggleCompany()"> Consument</label>
        <label><input type="radio" name="sw-btype" ${w.is_company ? 'checked' : ''} onchange="__swToggleCompany()"> Bedrijf</label>
      </div>
      ${w.is_company ? `
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
        <label class="tk-field"><span class="tk-field-l">Voornaam <span class="tk-req">*</span></span>
          <input class="ib-input" value="${esc(w.first_name)}" oninput="__swInput('first_name', this.value)"></label>
        <label class="tk-field"><span class="tk-field-l">Achternaam <span class="tk-req">*</span></span>
          <input class="ib-input" value="${esc(w.last_name)}" oninput="__swInput('last_name', this.value)"></label>
      </div>
      <div class="tk-field-row">
        <label class="tk-field"><span class="tk-field-l">E-mail <span class="tk-req">*</span></span>
          <input class="ib-input" type="email" value="${esc(w.email)}" oninput="__swInput('email', this.value)"></label>
        <label class="tk-field"><span class="tk-field-l">Telefoon <span class="tk-req">*</span></span>
          <input class="ib-input" value="${esc(w.phone)}" oninput="__swInput('phone', this.value)"></label>
      </div>
      <div class="tk-field-row">
        <label class="tk-field"><span class="tk-field-l">Adres — straat</span>
          <input class="ib-input" value="${esc(w.address_street)}" oninput="__swInput('address_street', this.value)"></label>
        <label class="tk-field"><span class="tk-field-l">Huisnr</span>
          <input class="ib-input" value="${esc(w.address_number)}" oninput="__swInput('address_number', this.value)"></label>
        <label class="tk-field"><span class="tk-field-l">Postcode</span>
          <input class="ib-input" value="${esc(w.address_postal)}" oninput="__swInput('address_postal', this.value)"></label>
        <label class="tk-field"><span class="tk-field-l">Plaats</span>
          <input class="ib-input" value="${esc(w.address_city)}" oninput="__swInput('address_city', this.value)"></label>
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

  function wizardModal() {
    const isLast = _sw.step === 5;
    return `<div class="fn-modal-back sw-modal-back" onclick="if(event.target===this)__swClose()">
      <div class="fn-modal sw-modal">
        <div class="fn-modal-head">
          <div class="fn-modal-title">Nieuwe offerte · v2</div>
          <span class="pill pill-warn">Batch 2 · scaffold (${_sw.step}/5)</span>
          <button class="icon-btn" onclick="__swClose()" title="Sluiten">${svg(I.x || I.warn, 'width:16px;height:16px')}</button>
        </div>
        <div class="fn-modal-body sw-body">
          ${progress()}
          ${renderStep()}
        </div>
        <div class="fn-modal-foot">
          <button class="btn" onclick="__swClose()">Annuleren</button>
          <div style="flex:1"></div>
          ${_sw.step > 1 ? `<button class="btn" onclick="__swGoStep(${_sw.step - 1})">← Vorige</button>` : ''}
          ${!isLast ? `<button class="btn btn-primary" onclick="__swGoStep(${_sw.step + 1})">Volgende →</button>` : ''}
          ${isLast ? `<button class="btn btn-primary" onclick="__swSubmit()" ${_sw.submitting ? 'disabled' : ''}>
            ${_sw.submitting ? 'Verzenden…' : 'Verzenden'}
          </button>` : ''}
        </div>
      </div>
    </div>`;
  }

  // ── Registratie: modal is een global overlay die geïnjecteerd wordt in
  //    alle sales-tab-views via een extra wrap-functie. Zo hoef ik de bestaande
  //    sales-v2 views niet aan te raken. Wrapping in afterview-hook.
  //    Voor deze scaffold: injecteer als extra script dat renders. In productie
  //    komt er straks een "Nieuwe offerte v2"-knop in sales-v2 die __swOpen()
  //    aanroept. Voor nu: exposeer __swOpen globaal voor manual invocation.
  window.__swMount = () => {
    // Zoekt de content-container; als de wizard open is, hangt hij de modal
    // aan het einde. Wrapper mag meerdere keren draaien (idempotent).
    if (!_sw.open) return;
    const content = document.getElementById('content');
    if (!content) return;
    if (content.querySelector('.sw-modal-back')) return;
    const div = document.createElement('div');
    div.innerHTML = wizardModal();
    content.appendChild(div.firstElementChild);
  };

  // Hook: run __swMount na elke DFO.render zodat de modal altijd bovenop
  // andere sales-content verschijnt.
  (function patchRender() {
    if (!window.DFO || typeof window.DFO.render !== 'function') { setTimeout(patchRender, 40); return; }
    if (window.DFO.__swMountPatched) return;
    window.DFO.__swMountPatched = true;
    const orig = window.DFO.render;
    window.DFO.render = function () {
      const r = orig.apply(this, arguments);
      queueMicrotask(() => { try { window.__swMount(); } catch (_) {} });
      return r;
    };
  })();

  // Esc sluit modal.
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _sw.open) { e.preventDefault(); window.__swClose(); }
  });

  console.debug('[sales-wizard-v2] loaded — call window.__swOpen() to launch scaffold');
})();
