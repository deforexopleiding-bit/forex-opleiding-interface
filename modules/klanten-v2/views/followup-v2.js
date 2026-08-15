// modules/klanten-v2/views/followup-v2.js
//
// Follow-up v2 — BROK 1 (kern-cockpit met ECHTE data).
//
// BROK 1 status: Werklijst + Opvolglijst + Lead-detail-panel + Call-modal
// gekoppeld aan echte endpoints. BROK 2-5 (Afspraken/Kalender/Retenties/
// Sluimerpot/No-show/Open-acties/Opvolging/Afgeboekt/Archief/Event-bellijst/
// Statistieken/Zoek/Voicememo/Screenshot/GHL/Admin) blijven als stub-view
// tot die brok wordt gebouwd.
//
// LIVE endpoints:
//   GET  /api/follow-up-leads-list?worklist=1&view=X
//   GET  /api/follow-up-opvolglijst
//   GET  /api/follow-up-lead-notes-list?lead_id=X
//   GET  /api/follow-up-lead-retention-context?customer_id=X
//   POST /api/follow-up-lead-outcome
//   POST /api/follow-up-lead-note-add
//   POST /api/follow-up-lead-update
//   POST /api/follow-up-verplaats-call
//   POST /api/follow-up-annuleer
//   POST /api/follow-up-opvolglijst-afschrijven
//
// Dormant (module 'followup' NIET in V2_ACTIVE_ALLOWLIST) — bereikbaar
// via ?v2preview=followup. Merge zet niks live voor eindgebruikers.
//
// Veiligheidspatronen:
//   - 8s timeout op alle fetches, asArr-guards, fail-soft.
//   - Skeleton bij loading, error-block met retry-knop, geen crashes.
//   - Confirm-modal op destructief (afschrijven / annuleren / geen_interesse).
//   - 501 MIGRATION_REQUIRED → nette admin-banner ipv generic error.
//   - Zoom_ingepland outcome triggert GHL-appointment: markering + confirm.

(function () {
  if (!window.DFO) { console.error('[followup-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[followup-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, S, F, render, goTab } = window.DFO;
  const H = window.KV_V2.helpers;

  const asArr = (x) => Array.isArray(x) ? x : [];
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  // Defensieve coerce: sommige lead-velden (source, source_ref) kunnen een
  // object zijn (join-shape uit backend). Voorkom "[object Object]" renderen.
  const safeStr = (v) => {
    if (v == null) return '';
    if (typeof v === 'string' || typeof v === 'number') return String(v);
    if (typeof v === 'object') {
      return String(v.type || v.label || v.name || v.slug || v.id || JSON.stringify(v).slice(0, 80));
    }
    return String(v);
  };
  const fmtDate = (iso, opts) => {
    if (!iso) return '—';
    const d = new Date(iso); if (!Number.isFinite(d.getTime())) return '—';
    return d.toLocaleString('nl-NL', opts || { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  };
  const fmtDateShort = (iso) => iso ? new Date(iso).toLocaleDateString('nl-NL', { day: '2-digit', month: 'short' }) : '—';
  const inputForDatetimeLocal = (iso) => {
    if (!iso) return '';
    const d = new Date(iso); if (!Number.isFinite(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  // ── Enum & meta ─────────────────────────────────────────────────────
  const BUCKETS = [
    { slug: 'vandaag',    label: '📅 Vandaag',      color: 'amber' },
    { slug: 'te_laat',    label: '⏰ Te laat',      color: 'rose'  },
    { slug: 'open',       label: '📋 Alle open',    color: 'blue'  },
    { slug: 'komende_7',  label: '🗓 Komende 7 dagen', color: 'violet' },
    { slug: 'snoozed',    label: '💤 Snoozed',      color: 'slate' },
    { slug: 'alle',       label: 'Alles',           color: 'neutral' },
  ];
  const STATUS_META = {
    nieuw:            { c: 'blue',    l: 'Nieuw' },
    benaderd:         { c: 'amber',   l: 'Benaderd' },
    niet_bereikbaar:  { c: 'rose',    l: 'Onbereikbaar' },
    terugbellen:      { c: 'violet',  l: 'Terugbellen' },
    verlengd:         { c: 'emerald', l: 'Verlengd' },
    verloren:         { c: 'slate',   l: 'Verloren' },
  };
  const OUTCOMES = [
    { v: 'geen_gehoor',       l: 'Geen gehoor',        c: 'slate',   next: false },
    { v: 'voicemail',         l: 'Voicemail',          c: 'slate',   next: false },
    { v: 'foutief_nummer',    l: 'Foutief nummer',     c: 'rose',    next: false },
    { v: 'terugbel',          l: 'Terugbellen',        c: 'amber',   next: 'terugbel_datum' },
    { v: 'zoom_ingepland',    l: 'Zoom ingepland',     c: 'violet',  next: 'terugbel_datum', risk: 'GHL-afspraak wordt aangemaakt' },
    { v: 'whatsapp_gestuurd', l: 'WhatsApp gestuurd',  c: 'emerald', next: false },
    { v: 'gesprek_gehad',     l: 'Gesprek gehad',      c: 'emerald', next: false },
    { v: 'sale',              l: '✅ Verkocht',        c: 'emerald', next: false, risk: 'Lead → status verlengd' },
    { v: 'geen_interesse',    l: '❌ Geen interesse',  c: 'rose',    next: false, risk: 'Lead → status verloren' },
    { v: 'snooze',            l: '💤 Later opnieuw',   c: 'blue',    next: 'snooze_months' },
    { v: 'noshow',            l: 'No-show',            c: 'rose',    next: false, note: 'alleen voor Zoom-leads' },
    { v: 'bevestigd',         l: '👍 Bevestigd',       c: 'emerald', next: false, note: 'alleen voor event-leads' },
    { v: 'komt_niet',         l: '👎 Komt niet',       c: 'rose',    next: false, note: 'alleen voor event-leads' },
  ];
  const BEZWAREN = [
    'Te duur', 'Geen tijd', 'Moet overleggen', 'Al bij andere partij',
    'Wil eerst resultaten zien', 'Twijfelt over online', 'Geen vertrouwen',
    'Wil eerst zelf proberen', 'Slecht moment', 'Geen budget nu', 'Anders',
  ];
  // Lookup voor humanisering van last_outcome enum in detail-panel/lijst.
  const OUTCOME_LABEL = {};
  OUTCOMES.forEach((o) => { OUTCOME_LABEL[o.v] = o.l; });

  // ── State ───────────────────────────────────────────────────────────
  const _live = {
    leadsList:   { loading: false, error: null, data: null, key: null, migrationRequired: false },
    opvolglijst: { loading: false, error: null, data: null, migrationRequired: false },
    notes:       { loading: {}, error: {}, data: {} },        // per lead_id
    retention:   { loading: {}, error: {}, data: {} },        // per customer_id
    badge:       { loading: false, data: null, ts: 0 },
  };
  const _ui = {
    view:            'open',            // buckets-slug (open/vandaag/te_laat/komende_7/snoozed/alle)
    kindFilter:      'all',             // all / call / zoom
    sourceFilter:    'all',             // all / event / retention
    search:          '',
    selectedLeadId:  null,
    detailTab:       'overzicht',       // overzicht / notities / retentie
    callModal:       null,               // { leadId, outcome, terugbel, snoozeMonths, warmte, bezwaren:Set, note, saving, error }
    verplaatsModal:  null,               // { appointmentId, newDatetime, duration, saving, error }
    annuleerModal:   null,               // { appointmentId, mode, reden, saving, error }
    afschrijfModal:  null,               // { type, refId, reason, saving, error }
    confirmModal:    null,               // { msg, onOk, onCancel, tone }
    noteDraft:       {},                 // per lead_id
    noteBusy:        {},
    outcomeBusy:     {},
    updateBusy:      {},
    toast:           null,               // { msg, tone, ts }
  };

  // ── Helpers ─────────────────────────────────────────────────────────
  async function tryFetch(label, url, init, timeoutMs) {
    timeoutMs = timeoutMs || 8000;
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      return await Promise.race([
        window.KV.authedJson(url, init),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) {
      console.warn('[followup-v2] ' + label + ' fail:', e?.message);
      return { __error: e?.message || 'onbekende fout' };
    }
  }
  function showToast(msg, tone) {
    _ui.toast = { msg, tone: tone || 'info', ts: Date.now() };
    if (H.showToast) { try { H.showToast(msg, tone); return; } catch (_) {} }
    setTimeout(() => { if (_ui.toast && Date.now() - _ui.toast.ts >= 3000) { _ui.toast = null; if (render) render(); } }, 3500);
    if (render) render();
  }
  function openConfirm(msg, onOk, tone) {
    _ui.confirmModal = { msg, onOk, tone: tone || 'warn' };
    if (render) render();
  }
  function migrationBanner(scope) {
    return `<div style="margin:16px 20px;padding:12px 16px;border:1px solid var(--amber-line, #F5E1B4);background:var(--amber-soft, #FEF7E0);color:var(--amber, #B7791F);border-radius:10px;font-size:13px">
      ⚠ <b>Migratie vereist</b> — voor de tabel(len) achter ${esc(scope)} zijn schema-updates niet doorgevoerd. Vraag Jeffrey de betreffende SQL-migratie te draaien.
    </div>`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FETCHERS
  // ═══════════════════════════════════════════════════════════════════════
  function _leadsKey() {
    return `${_ui.view}|${_ui.kindFilter}|${_ui.sourceFilter}|${_ui.search}`;
  }
  async function fetchLeads() {
    const key = _leadsKey();
    const st = _live.leadsList;
    if (st.loading) return;
    if (st.data && st.key === key) return;
    st.loading = true; st.error = null; st.key = key; st.migrationRequired = false;
    const params = [];
    params.push('worklist=1');
    // BUG-FIX BROK 1: stuur view ALTIJD mee (ook 'alle' en 'snoozed'). Backend
    // gebruikt 'open' als default → "Alles" (139) laadde eerder de open-set (33)
    // omdat de UI géén view meegaf. 'komende_7' bestaat wel als bucket in de UI
    // maar backend accepteert 'komende_7' niet als view — die zit al in de
    // worklist-response als aparte array; voor die selectie sturen we view=open
    // (want komende_7 is een subset van open).
    const viewParam = (_ui.view === 'komende_7') ? 'open' : (_ui.view || 'open');
    params.push('view=' + encodeURIComponent(viewParam));
    if (_ui.sourceFilter && _ui.sourceFilter !== 'all') params.push('source=' + encodeURIComponent(_ui.sourceFilter));
    if (_ui.kindFilter && _ui.kindFilter !== 'all') params.push('kind=' + encodeURIComponent(_ui.kindFilter));
    params.push('limit=1000');
    const url = '/api/follow-up-leads-list?' + params.join('&');
    const j = await tryFetch('leads-list', url);
    st.loading = false;
    if (j && j.__error) { st.error = j.__error; st.data = null; }
    else if (j?.error && j?.code === 'MIGRATION_REQUIRED') { st.migrationRequired = true; st.data = null; }
    else {
      let leads = asArr(j?.leads);
      // Client-side bucket-filter voor 'komende_7' (backend heeft geen view-alias
      // hiervoor; leads.bucket bevat wél 'komende_7' zodra worklist=1).
      if (_ui.view === 'komende_7') leads = leads.filter((l) => l.bucket === 'komende_7');
      if (_ui.search) {
        const q = _ui.search.toLowerCase();
        leads = leads.filter((l) => [l.lead_name, l.lead_email, l.lead_phone].some((v) => String(v || '').toLowerCase().includes(q)));
      }
      st.data = {
        leads,
        appointments: asArr(j?.appointments),
        reschedule: asArr(j?.reschedule),
        counts: j?.counts || {},
        allowed_statuses: asArr(j?.allowed_statuses),
      };
    }
    if (render) render();
  }
  async function fetchOpvolglijst() {
    const st = _live.opvolglijst;
    if (st.loading) return;
    if (st.data) return;
    st.loading = true; st.error = null; st.migrationRequired = false;
    const j = await tryFetch('opvolglijst', '/api/follow-up-opvolglijst');
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else if (j?.error && j?.code === 'MIGRATION_REQUIRED') st.migrationRequired = true;
    else st.data = { items: asArr(j?.items), counts: j?.counts || {}, total: Number(j?.count || 0) };
    if (render) render();
  }
  async function fetchNotes(leadId) {
    if (!leadId) return;
    const st = _live.notes;
    if (st.loading[leadId] || st.data[leadId]) return;
    st.loading[leadId] = true; st.error[leadId] = null;
    const j = await tryFetch('notes:' + leadId, '/api/follow-up-lead-notes-list?lead_id=' + encodeURIComponent(leadId));
    st.loading[leadId] = false;
    if (j && j.__error) st.error[leadId] = j.__error;
    else st.data[leadId] = asArr(j?.notes);
    if (render) render();
  }
  async function fetchRetention(customerId) {
    if (!customerId) return;
    const st = _live.retention;
    if (st.loading[customerId] || st.data[customerId]) return;
    st.loading[customerId] = true; st.error[customerId] = null;
    const j = await tryFetch('retention:' + customerId, '/api/follow-up-lead-retention-context?customer_id=' + encodeURIComponent(customerId));
    st.loading[customerId] = false;
    if (j && j.__error) st.error[customerId] = j.__error;
    else st.data[customerId] = j || {};
    if (render) render();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // WRITE HANDLERS
  // ═══════════════════════════════════════════════════════════════════════
  async function submitOutcome() {
    const m = _ui.callModal;
    if (!m || m.saving) return;
    // Validatie
    if (!m.outcome) { m.error = 'Kies eerst een uitkomst'; if (render) render(); return; }
    const meta = OUTCOMES.find((o) => o.v === m.outcome);
    if (!meta) { m.error = 'Onbekende uitkomst'; if (render) render(); return; }
    const body = { lead_id: m.leadId, outcome: m.outcome };
    if (meta.next === 'terugbel_datum') {
      if (!m.terugbel) { m.error = 'Terugbel-datum verplicht'; if (render) render(); return; }
      body.terugbel_datum = new Date(m.terugbel).toISOString();
    }
    if (meta.next === 'snooze_months') {
      const mo = Number(m.snoozeMonths);
      if (mo !== 6 && mo !== 12) { m.error = 'Snooze: 6 of 12 maanden'; if (render) render(); return; }
      body.snooze_months = mo;
    }
    if (typeof m.warmte === 'number') body.is_hot = m.warmte >= 7;
    if (m.bezwaren && m.bezwaren.size > 0) {
      const notes = ['Bezwaren: ' + Array.from(m.bezwaren).join(', ')];
      if (m.note) notes.push(m.note);
      body.reason = notes.join(' — ').slice(0, 500);
    } else if (m.note) {
      body.reason = m.note.slice(0, 500);
    }
    m.saving = true; m.error = null; if (render) render();
    const j = await tryFetch('outcome', '/api/follow-up-lead-outcome', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 12000);
    m.saving = false;
    if (j && (j.__error || j.error)) {
      if (j.code === 'MIGRATION_REQUIRED') _live.leadsList.migrationRequired = true;
      m.error = j.__error || j.error || 'Opslaan mislukt';
      if (render) render();
      return;
    }
    // Success: optioneel notitie toevoegen naast uitkomst (bezwaren-details)
    if (m.note && (!m.bezwaren || m.bezwaren.size === 0)) {
      await tryFetch('note-add', '/api/follow-up-lead-note-add', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lead_id: m.leadId, note: m.note.slice(0, 4000) }),
      }, 8000);
    }
    _ui.callModal = null;
    _live.leadsList.data = null; _live.leadsList.key = null;
    delete _live.notes.data[m.leadId];
    _live.badge.data = null; _live.badge.ts = 0;
    showToast('Uitkomst opgeslagen · ' + (meta.l || m.outcome), 'success');
    if (Array.isArray(j?.warnings) && j.warnings.length) console.warn('[followup-v2] outcome warnings:', j.warnings);
    if (render) render();
  }
  async function submitNote(leadId) {
    if (_ui.noteBusy[leadId]) return;
    const note = (_ui.noteDraft[leadId] || '').trim();
    if (!note) return;
    _ui.noteBusy[leadId] = true; if (render) render();
    const j = await tryFetch('note-add', '/api/follow-up-lead-note-add', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lead_id: leadId, note: note.slice(0, 4000) }),
    }, 8000);
    _ui.noteBusy[leadId] = false;
    if (j && (j.__error || j.error)) { showToast('Notitie opslaan mislukt: ' + (j.__error || j.error), 'warn'); if (render) render(); return; }
    _ui.noteDraft[leadId] = '';
    delete _live.notes.data[leadId];
    showToast('Notitie opgeslagen', 'success');
    if (render) render();
  }
  async function submitLeadUpdate(leadId, patch) {
    if (_ui.updateBusy[leadId]) return;
    _ui.updateBusy[leadId] = true; if (render) render();
    const j = await tryFetch('lead-update', '/api/follow-up-lead-update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lead_id: leadId, ...patch }),
    }, 8000);
    _ui.updateBusy[leadId] = false;
    if (j && (j.__error || j.error)) { showToast('Update mislukt: ' + (j.__error || j.error), 'warn'); if (render) render(); return; }
    _live.leadsList.data = null; _live.leadsList.key = null;
    _live.badge.data = null; _live.badge.ts = 0;
    showToast('Lead bijgewerkt', 'success');
    if (render) render();
  }
  async function submitVerplaats() {
    const m = _ui.verplaatsModal;
    if (!m || m.saving) return;
    if (!m.newDatetime) { m.error = 'Nieuwe datum/tijd verplicht'; if (render) render(); return; }
    m.saving = true; m.error = null; if (render) render();
    const j = await tryFetch('verplaats', '/api/follow-up-verplaats-call', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appointment_id: m.appointmentId,
        new_datetime: m.newDatetime,
        duration_minutes: Number(m.duration || 30),
      }),
    }, 15000);
    m.saving = false;
    if (j && (j.__error || j.error || !j.success)) {
      m.error = j.__error || j.error || 'Verplaatsen mislukt' + (j?.ghl_status ? ` (GHL ${j.ghl_status})` : '');
      if (render) render();
      return;
    }
    _ui.verplaatsModal = null;
    _live.leadsList.data = null; _live.leadsList.key = null;
    showToast('Call verplaatst', 'success');
    if (render) render();
  }
  async function submitAnnuleer() {
    const m = _ui.annuleerModal;
    if (!m || m.saving) return;
    m.saving = true; m.error = null; if (render) render();
    const j = await tryFetch('annuleer', '/api/follow-up-annuleer', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appointment_id: m.appointmentId,
        mode: m.mode || 'definitief',
        reden: m.reden || null,
      }),
    }, 12000);
    m.saving = false;
    if (j && (j.__error || j.error || !j.success)) {
      m.error = j.__error || j.error || 'Annuleren mislukt';
      if (render) render();
      return;
    }
    _ui.annuleerModal = null;
    _live.leadsList.data = null; _live.leadsList.key = null;
    showToast('Call geannuleerd', 'success');
    if (render) render();
  }
  async function submitAfschrijf() {
    const m = _ui.afschrijfModal;
    if (!m || m.saving) return;
    if (!m.reason || m.reason.trim().length < 3) { m.error = 'Reden: min. 3 tekens'; if (render) render(); return; }
    m.saving = true; m.error = null; if (render) render();
    const j = await tryFetch('afschrijf', '/api/follow-up-opvolglijst-afschrijven', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: m.type, ref_id: m.refId, reason: m.reason.trim() }),
    }, 10000);
    m.saving = false;
    if (j && (j.__error || j.error || !j.ok)) {
      m.error = j.__error || j.error || 'Afschrijven mislukt';
      if (render) render();
      return;
    }
    _ui.afschrijfModal = null;
    _live.opvolglijst.data = null;
    _live.leadsList.data = null; _live.leadsList.key = null;
    showToast(j.already ? 'Al eerder afgeschreven' : 'Afgeschreven', 'success');
    if (render) render();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // WINDOW HANDLERS
  // ═══════════════════════════════════════════════════════════════════════
  window.__fuSetView = (v) => { _ui.view = v; _live.leadsList.data = null; _live.leadsList.key = null; if (render) render(); };
  window.__fuSetKind = (v) => { _ui.kindFilter = v; _live.leadsList.data = null; _live.leadsList.key = null; if (render) render(); };
  window.__fuSetSource = (v) => { _ui.sourceFilter = v; _live.leadsList.data = null; _live.leadsList.key = null; if (render) render(); };
  window.__fuRefresh = () => { _live.leadsList.data = null; _live.leadsList.key = null; _live.opvolglijst.data = null; if (render) render(); };
  let _searchDebounce = null;
  window.__fuSearch = (v) => {
    if (_searchDebounce) clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => { _ui.search = String(v || '').trim(); _live.leadsList.data = null; _live.leadsList.key = null; if (render) render(); }, 400);
  };
  window.__fuSelectLead = (id) => { _ui.selectedLeadId = id; _ui.detailTab = 'overzicht'; if (render) render(); };
  // Jump vanuit Opvolglijst → Werklijst: reset filters naar 'alle' zodat de lead
  // gegarandeerd in de lijst zit; select 'em; switch tab. Fallback: als na fetch
  // de lead alsnog niet in de lijst zit, forceer een gerichte single-lead-fetch
  // (voor nu: laat de detail-panel een nette "wisselt van filter"-melding tonen).
  window.__fuJumpToLead = (leadId) => {
    if (!leadId) return;
    _ui.view = 'alle';
    _ui.sourceFilter = 'all';
    _ui.kindFilter = 'all';
    _ui.search = '';
    _ui.selectedLeadId = leadId;
    _ui.detailTab = 'overzicht';
    _live.leadsList.data = null; _live.leadsList.key = null;
    if (window.DFO && typeof window.DFO.goTab === 'function') {
      try { window.DFO.goTab('Werklijst'); } catch (_) {}
    }
    if (render) render();
  };
  window.__fuDetailTab = (t) => { _ui.detailTab = t; if (render) render(); };
  window.__fuOpenCall = (leadId) => {
    _ui.callModal = { leadId, outcome: null, terugbel: '', snoozeMonths: 6, warmte: 5, bezwaren: new Set(), note: '', saving: false, error: null };
    if (render) render();
  };
  window.__fuCloseCall = () => { _ui.callModal = null; if (render) render(); };
  window.__fuCallSetOutcome = (v) => {
    if (!_ui.callModal) return;
    _ui.callModal.outcome = v; _ui.callModal.error = null;
    // Default terugbel = morgen 10:00 als terugbel-outcome
    const meta = OUTCOMES.find((o) => o.v === v);
    if (meta && meta.next === 'terugbel_datum' && !_ui.callModal.terugbel) {
      const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0);
      _ui.callModal.terugbel = inputForDatetimeLocal(d.toISOString());
    }
    if (render) render();
  };
  window.__fuCallField = (k, v) => { if (_ui.callModal) { _ui.callModal[k] = v; if (render) render(); } };
  window.__fuCallToggleBezwaar = (b) => {
    if (!_ui.callModal) return;
    if (_ui.callModal.bezwaren.has(b)) _ui.callModal.bezwaren.delete(b);
    else _ui.callModal.bezwaren.add(b);
    if (render) render();
  };
  window.__fuCallSave = () => {
    const m = _ui.callModal; if (!m) return;
    const meta = OUTCOMES.find((o) => o.v === m.outcome);
    if (meta && meta.risk) {
      openConfirm(`${meta.risk}. Weet je zeker dat je "${meta.l}" wilt registreren?`, submitOutcome, 'warn');
    } else {
      submitOutcome();
    }
  };
  window.__fuNoteDraft = (leadId, v) => { _ui.noteDraft[leadId] = v; if (render) render(); };
  window.__fuNoteSave = (leadId) => submitNote(leadId);
  window.__fuStatus = (leadId, status) => submitLeadUpdate(leadId, { lead_status: status });
  window.__fuOpenVerplaats = (appointmentId) => {
    _ui.verplaatsModal = { appointmentId, newDatetime: '', duration: 30, saving: false, error: null };
    if (render) render();
  };
  window.__fuCloseVerplaats = () => { _ui.verplaatsModal = null; if (render) render(); };
  window.__fuVerplaatsField = (k, v) => { if (_ui.verplaatsModal) { _ui.verplaatsModal[k] = v; if (render) render(); } };
  window.__fuVerplaatsSave = () => submitVerplaats();
  window.__fuOpenAnnuleer = (appointmentId) => {
    _ui.annuleerModal = { appointmentId, mode: 'definitief', reden: '', saving: false, error: null };
    if (render) render();
  };
  window.__fuCloseAnnuleer = () => { _ui.annuleerModal = null; if (render) render(); };
  window.__fuAnnuleerField = (k, v) => { if (_ui.annuleerModal) { _ui.annuleerModal[k] = v; if (render) render(); } };
  window.__fuAnnuleerSave = () => {
    const m = _ui.annuleerModal; if (!m) return;
    openConfirm(`Weet je zeker dat je deze call ${m.mode === 'definitief' ? 'definitief wilt annuleren' : 'op "wacht op reschedule" wilt zetten'}?`, submitAnnuleer, 'warn');
  };
  window.__fuOpenAfschrijf = (type, refId) => {
    _ui.afschrijfModal = { type, refId, reason: '', saving: false, error: null };
    if (render) render();
  };
  window.__fuCloseAfschrijf = () => { _ui.afschrijfModal = null; if (render) render(); };
  window.__fuAfschrijfField = (k, v) => { if (_ui.afschrijfModal) { _ui.afschrijfModal[k] = v; if (render) render(); } };
  window.__fuAfschrijfSave = () => {
    const m = _ui.afschrijfModal; if (!m) return;
    openConfirm('Weet je zeker dat je dit item wilt afschrijven? De bijhorende lead wordt op status "verloren" gezet.', submitAfschrijf, 'warn');
  };
  window.__fuConfirmOk = () => { const c = _ui.confirmModal; _ui.confirmModal = null; if (render) render(); try { if (c && typeof c.onOk === 'function') c.onOk(); } catch (e) { console.warn('[followup-v2] confirm onOk fail', e); } };
  window.__fuConfirmCancel = () => { _ui.confirmModal = null; if (render) render(); };

  // ═══════════════════════════════════════════════════════════════════════
  // RENDER HELPERS
  // ═══════════════════════════════════════════════════════════════════════
  const skel = () => `<div style="padding:20px"><div style="height:40px;background:var(--surface-2);border-radius:8px;opacity:.5;margin-bottom:8px"></div><div style="height:40px;background:var(--surface-2);border-radius:8px;opacity:.4;margin-bottom:8px"></div><div style="height:40px;background:var(--surface-2);border-radius:8px;opacity:.35"></div></div>`;
  const errBlk = (msg, retry) => `<div style="margin:14px 20px;padding:12px 16px;border:1px solid var(--rose-line);background:var(--rose-soft);border-radius:10px;color:var(--rose);font-size:13px;display:flex;align-items:center;gap:12px"><span style="flex:1">⚠ ${esc(msg)}</span>${retry ? `<button class="btn btn-ghost btn-sm" onclick="${retry}">Opnieuw</button>` : ''}</div>`;

  function _statusPill(status) {
    const m = STATUS_META[status] || { c: 'neutral', l: status || '—' };
    return H.pill(m.c, m.l);
  }
  function _bucketPill(bucket) {
    const b = BUCKETS.find((x) => x.slug === bucket);
    return b ? `<span style="font-size:10.5px;padding:1px 8px;background:var(--${b.color}-soft, var(--surface-2));color:var(--${b.color}, var(--text-3));border-radius:20px;font-weight:600">${esc(b.label)}</span>` : '';
  }

  // ═══════════════════════════════════════════════════════════════════════
  // VIEW 1 — WERKLIJST (buckets + split-pane + lead-detail)
  // ═══════════════════════════════════════════════════════════════════════
  function werklijstView() {
    const st = _live.leadsList;
    if (!st.loading && (!st.data || st.key !== _leadsKey()) && !st.migrationRequired) queueMicrotask(fetchLeads);

    const bucketsRow = _renderBucketsRow();
    const filtersRow = _renderFilters();
    const listPane = st.migrationRequired ? migrationBanner('follow-up leads-tabel')
      : (st.error && !st.data) ? errBlk(st.error, 'window.__fuRefresh()')
      : (st.loading && !st.data) ? skel()
      : _renderLeadsList();
    const detailPane = _renderDetail();

    return `<div style="display:flex;flex-direction:column;height:calc(100dvh - 60px);min-height:400px">
      ${bucketsRow}
      ${filtersRow}
      <div style="flex:1;display:grid;grid-template-columns:minmax(360px, 42%) 1fr;min-height:0;border-top:1px solid var(--border)">
        <div style="border-right:1px solid var(--border);overflow-y:auto;min-height:0">${listPane}</div>
        <div style="overflow-y:auto;min-height:0;background:var(--bg, var(--surface))">${detailPane}</div>
      </div>
      ${_renderModals()}
      ${_renderToast()}
    </div>`;
  }
  function _renderBucketsRow() {
    const counts = _live.leadsList.data?.counts || {};
    return `<div style="padding:10px 16px;display:flex;gap:6px;align-items:center;overflow-x:auto;border-bottom:1px solid var(--border);background:var(--surface)">
      ${BUCKETS.map((b) => {
        const on = _ui.view === b.slug;
        const cnt = counts[b.slug === 'open' ? 'open' : b.slug] || 0;
        return `<button class="chip ${on ? 'on' : ''}" style="padding:5px 12px;border:1px solid ${on ? `var(--${b.color}, var(--m))` : 'var(--border)'};background:${on ? `var(--${b.color}-soft, var(--m-soft))` : 'transparent'};color:${on ? `var(--${b.color}, var(--m))` : 'var(--text-2)'};border-radius:20px;font-size:12px;font-weight:${on ? '600' : '400'};cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:6px" onclick="window.__fuSetView('${b.slug}')">
          ${esc(b.label)}${cnt ? `<span class="mono" style="font-size:10.5px;opacity:.8">${cnt}</span>` : ''}
        </button>`;
      }).join('')}
      <button class="icon-btn" title="Vernieuw" onclick="window.__fuRefresh()" style="margin-left:auto;width:28px;height:28px">↻</button>
    </div>`;
  }
  function _renderFilters() {
    return `<div style="padding:8px 16px;display:flex;gap:10px;align-items:center;border-bottom:1px solid var(--border);background:var(--surface-2);font-size:12px">
      <label style="display:flex;align-items:center;gap:6px"><span style="color:var(--text-3)">Bron:</span>
        <select onchange="window.__fuSetSource(this.value)" style="padding:3px 6px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:12px">
          ${['all','event','retention'].map((v) => `<option value="${v}" ${_ui.sourceFilter === v ? 'selected' : ''}>${v === 'all' ? 'Alle' : v === 'event' ? 'Event' : 'Retentie'}</option>`).join('')}
        </select>
      </label>
      <label style="display:flex;align-items:center;gap:6px"><span style="color:var(--text-3)">Type:</span>
        <select onchange="window.__fuSetKind(this.value)" style="padding:3px 6px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:12px">
          ${['all','call','zoom'].map((v) => `<option value="${v}" ${_ui.kindFilter === v ? 'selected' : ''}>${v === 'all' ? 'Alle' : v === 'call' ? 'Call' : 'Zoom'}</option>`).join('')}
        </select>
      </label>
      <input type="search" placeholder="Zoek naam / e-mail / telefoon…" value="${esc(_ui.search)}" oninput="window.__fuSearch(this.value)" style="flex:1;max-width:280px;padding:5px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12px" />
      ${_live.leadsList.data ? `<span style="margin-left:auto;color:var(--text-3);font-family:'IBM Plex Mono',monospace;font-size:11.5px">${asArr(_live.leadsList.data.leads).length} leads</span>` : ''}
    </div>`;
  }
  function _renderLeadsList() {
    const leads = asArr(_live.leadsList.data?.leads);
    if (leads.length === 0) return `<div style="padding:40px 20px;text-align:center;color:var(--text-3);font-size:13px">Geen leads in deze weergave.</div>`;
    return leads.map(_renderLeadRow).join('');
  }
  function _renderLeadRow(l) {
    const isActive = l.id === _ui.selectedLeadId;
    const bg = isActive ? 'var(--m-soft, rgba(59,130,246,.10))' : 'transparent';
    const leftBorder = isActive ? 'border-left:3px solid var(--m, #3B82F6)' : 'border-left:3px solid transparent';
    const naam = l.lead_name || l.lead_email || l.lead_phone || '—';
    const late = l.bucket === 'te_laat';
    return `<div style="border-bottom:1px solid var(--border);${leftBorder};background:${bg};cursor:pointer;transition:background .1s" onclick="window.__fuSelectLead('${esc(l.id)}')">
      <div style="padding:10px 14px;display:flex;gap:10px">
        ${H.av ? H.av(naam, 32) : ''}
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:baseline;gap:8px">
            <span style="flex:1;font-size:13.5px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(naam)}</span>
            <span style="font-size:10.5px;font-family:'IBM Plex Mono',monospace;color:${late ? 'var(--rose)' : 'var(--text-3)'};flex-shrink:0">${l.terugbel_datum ? fmtDateShort(l.terugbel_datum) : (l.days_since_contact != null ? l.days_since_contact + 'd geleden' : '—')}</span>
          </div>
          <div style="font-size:12px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(l.lead_email || l.lead_phone || '—')}</div>
          <div style="display:flex;gap:5px;align-items:center;margin-top:4px;flex-wrap:wrap">
            ${_statusPill(l.lead_status)}
            ${_bucketPill(l.bucket)}
            ${l.is_hot ? '<span style="font-size:10.5px;padding:1px 7px;background:var(--rose-soft);color:var(--rose);border-radius:20px;font-weight:600">🔥 HOT</span>' : ''}
            ${l.attempts ? `<span style="font-size:10.5px;color:var(--text-3);font-family:'IBM Plex Mono',monospace">${l.attempts}× gebeld</span>` : ''}
            ${l.lead_kind === 'zoom' ? '<span style="font-size:10.5px;padding:1px 7px;background:var(--violet-soft);color:var(--violet);border-radius:20px">Zoom</span>' : ''}
            ${l.owner_name ? `<span style="font-size:10.5px;color:var(--text-3)">· ${esc(l.owner_name)}</span>` : ''}
          </div>
        </div>
      </div>
    </div>`;
  }

  // ── DETAIL PANEL ────────────────────────────────────────────────────
  function _renderDetail() {
    const id = _ui.selectedLeadId;
    if (!id) return `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--text-3);gap:12px;padding:40px 20px;text-align:center">
      <div style="font-size:15px;font-weight:600;color:var(--text-2)">Geen lead geselecteerd</div>
      <div style="font-size:12.5px;max-width:320px;line-height:1.5">Kies links een lead om te bellen, notities toe te voegen of de opvolgstatus bij te werken.</div>
    </div>`;
    const lead = asArr(_live.leadsList.data?.leads).find((x) => x.id === id);
    if (!lead) {
      // Fallback: als de lead niet in de huidige (mogelijk gefilterde) lijst zit,
      // bied direct een reset-knop aan die alle filters naar 'alle' zet.
      const resetActive = _ui.view === 'alle' && _ui.sourceFilter === 'all' && _ui.kindFilter === 'all' && !_ui.search;
      return `<div style="padding:24px;color:var(--text-3);font-size:13px;text-align:center">
        <div style="margin-bottom:12px">Lead niet in huidige lijst.</div>
        ${resetActive
          ? `<div style="font-size:12px;opacity:.85">Filters staan al op "Alles". De lead is mogelijk gearchiveerd of buiten je scope.</div>`
          : `<button class="btn btn-primary btn-sm" onclick="window.__fuJumpToLead('${esc(id)}')">Reset filters naar Alles</button>`}
      </div>`;
    }
    return `${_detailHeader(lead)}${_detailTabs()}${_detailBody(lead)}`;
  }
  function _detailHeader(l) {
    const naam = l.lead_name || l.lead_email || l.lead_phone || '—';
    return `<div style="padding:18px 22px;border-bottom:1px solid var(--border);background:var(--surface)">
      <div style="display:flex;gap:14px;align-items:flex-start">
        ${H.av ? H.av(naam, 44) : ''}
        <div style="flex:1;min-width:0">
          <div style="font-size:17px;font-weight:600;letter-spacing:-.01em;color:var(--text)">${esc(naam)}</div>
          <div style="font-size:12.5px;color:var(--text-3);margin-top:3px">
            ${l.lead_email ? `<a href="mailto:${esc(l.lead_email)}" style="color:var(--text-2);text-decoration:none">${esc(l.lead_email)}</a>` : ''}
            ${l.lead_email && l.lead_phone ? ' · ' : ''}
            ${l.lead_phone ? `<a href="tel:${esc(l.lead_phone)}" style="color:var(--text-2);text-decoration:none">${esc(l.lead_phone)}</a>` : ''}
          </div>
          <div style="display:flex;gap:6px;align-items:center;margin-top:8px;flex-wrap:wrap">
            ${_statusPill(l.lead_status)}
            ${_bucketPill(l.bucket)}
            ${l.is_hot ? '<span style="font-size:10.5px;padding:1px 7px;background:var(--rose-soft);color:var(--rose);border-radius:20px;font-weight:600">🔥 HOT</span>' : ''}
            <span style="font-size:10.5px;color:var(--text-3)">Bron: ${esc(safeStr(l.source) || '—')}</span>
            ${l.owner_name ? `<span style="font-size:10.5px;color:var(--text-3)">Eigenaar: ${esc(safeStr(l.owner_name))}</span>` : ''}
          </div>
        </div>
        <button class="btn btn-primary" onclick="window.__fuOpenCall('${esc(l.id)}')">${svg(I.phone || I.call || '')} Bel-uitkomst</button>
      </div>
    </div>`;
  }
  function _detailTabs() {
    const tabs = [{ v: 'overzicht', l: 'Overzicht' }, { v: 'notities', l: 'Notities' }, { v: 'retentie', l: 'Retentie' }];
    return `<div style="display:flex;gap:2px;padding:0 22px;border-bottom:1px solid var(--border);background:var(--surface)">
      ${tabs.map((t) => {
        const on = _ui.detailTab === t.v;
        return `<button style="padding:8px 14px;border:none;background:transparent;color:${on ? 'var(--m)' : 'var(--text-3)'};border-bottom:2px solid ${on ? 'var(--m)' : 'transparent'};font-size:12.5px;font-weight:${on ? '600' : '400'};cursor:pointer" onclick="window.__fuDetailTab('${t.v}')">${esc(t.l)}</button>`;
      }).join('')}
    </div>`;
  }
  function _detailBody(l) {
    if (_ui.detailTab === 'notities') return _detailNotities(l);
    if (_ui.detailTab === 'retentie') return _detailRetentie(l);
    return _detailOverzicht(l);
  }
  function _detailOverzicht(l) {
    const canUpdate = !_ui.updateBusy[l.id];
    return `<div style="padding:20px 22px;display:flex;flex-direction:column;gap:14px;max-width:720px">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px">
        <div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Snelle status-update</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${Object.entries(STATUS_META).map(([k, m]) => {
            const on = l.lead_status === k;
            return `<button class="btn ${on ? 'btn-primary' : 'btn-ghost'} btn-sm" ${!canUpdate ? 'disabled' : ''} onclick="window.__fuStatus('${esc(l.id)}','${k}')">${esc(m.l)}</button>`;
          }).join('')}
        </div>
      </div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px">
        <div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Contact-gegevens</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 22px;font-size:13px">
          <div><b>Naam:</b> ${esc(l.lead_name || '—')}</div>
          <div><b>Eigenaar:</b> ${esc(l.owner_name || '(niet toegewezen)')}</div>
          <div><b>E-mail:</b> ${esc(l.lead_email || '—')}</div>
          <div><b>Telefoon:</b> ${esc(l.lead_phone || '—')}</div>
          <div><b>Bron:</b> ${esc(safeStr(l.source) || '—')}${l.source_ref ? ` · <span class="mono" style="font-size:11.5px">${esc(safeStr(l.source_ref))}</span>` : ''}</div>
          <div><b>Type:</b> ${l.lead_kind === 'zoom' ? 'Zoom' : 'Call'}</div>
          <div><b>Pogingen:</b> <span class="mono">${l.attempts || 0}×</span></div>
          <div><b>Laatste contact:</b> ${fmtDate(l.last_contact_at)}</div>
          <div><b>Terugbel-datum:</b> ${fmtDate(l.terugbel_datum)}</div>
          <div><b>Snoozed tot:</b> ${fmtDate(l.snoozed_until)}</div>
          <div><b>Laatste uitkomst:</b> ${esc(OUTCOME_LABEL[l.last_outcome] || safeStr(l.last_outcome) || '—')}</div>
          <div><b>Aangemaakt:</b> ${fmtDate(l.created_at)}</div>
        </div>
      </div>
    </div>`;
  }
  function _detailNotities(l) {
    if (!_live.notes.data[l.id] && !_live.notes.loading[l.id]) queueMicrotask(() => fetchNotes(l.id));
    const notes = _live.notes.data[l.id];
    const draft = _ui.noteDraft[l.id] || '';
    const busy = _ui.noteBusy[l.id];
    return `<div style="padding:20px 22px;max-width:720px">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:14px">
        <textarea placeholder="Nieuwe notitie toevoegen…" oninput="window.__fuNoteDraft('${esc(l.id)}', this.value)" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:6px;background:var(--surface-2);color:var(--text);font-size:13px;font-family:inherit;min-height:80px;resize:vertical">${esc(draft)}</textarea>
        <div style="display:flex;justify-content:flex-end;margin-top:8px">
          <button class="btn btn-primary btn-sm" ${(!draft.trim() || busy) ? 'disabled' : ''} onclick="window.__fuNoteSave('${esc(l.id)}')">${busy ? 'Opslaan…' : 'Opslaan'}</button>
        </div>
      </div>
      ${_live.notes.error[l.id] ? errBlk(_live.notes.error[l.id]) :
        _live.notes.loading[l.id] ? skel() :
        !notes ? '' :
        notes.length === 0 ? `<div style="padding:24px;text-align:center;color:var(--text-3);font-size:12.5px">Nog geen notities.</div>` :
        `<div style="display:flex;flex-direction:column;gap:8px">${notes.map((n) => `
          <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 14px">
            <div style="font-size:11px;color:var(--text-3);margin-bottom:4px">${esc(n.author_name || '—')} · ${fmtDate(n.created_at)}${n.entry_kind ? ` · <span class="mono">${esc(n.entry_kind)}</span>` : ''}</div>
            <div style="font-size:13px;color:var(--text);white-space:pre-wrap">${esc(n.note)}</div>
          </div>`).join('')}</div>`
      }
    </div>`;
  }
  function _detailRetentie(l) {
    if (!l.customer_id) return `<div style="padding:24px;color:var(--text-3);font-size:13px">Deze lead heeft (nog) geen gekoppelde klant — geen retentie-context beschikbaar.</div>`;
    if (!_live.retention.data[l.customer_id] && !_live.retention.loading[l.customer_id]) queueMicrotask(() => fetchRetention(l.customer_id));
    if (_live.retention.error[l.customer_id]) return errBlk(_live.retention.error[l.customer_id]);
    if (_live.retention.loading[l.customer_id]) return skel();
    const r = _live.retention.data[l.customer_id];
    if (!r) return skel();
    return `<div style="padding:20px 22px;max-width:720px">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px">
        <div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Retentie-context</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 22px;font-size:13px">
          <div><b>Traject:</b> ${esc(r.traject_label || '—')}</div>
          <div><b>Abo-status:</b> ${r.abo_status ? H.pill(r.abo_status === 'active' ? 'emerald' : 'slate', r.abo_status) : '—'}</div>
          <div><b>Abo-beschrijving:</b> ${esc(r.abo_description || '—')}</div>
          <div><b>Einddatum:</b> ${fmtDate(r.abo_end_date, { day: '2-digit', month: 'short', year: 'numeric' })}</div>
        </div>
      </div>
    </div>`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MODALS
  // ═══════════════════════════════════════════════════════════════════════
  function _renderModals() {
    const html = [];
    if (_ui.callModal) html.push(_callModal());
    if (_ui.verplaatsModal) html.push(_verplaatsModal());
    if (_ui.annuleerModal) html.push(_annuleerModal());
    if (_ui.afschrijfModal) html.push(_afschrijfModal());
    if (_ui.confirmModal) html.push(_confirmModal());
    return html.join('');
  }
  function _modalShell(title, body, closeHandler) {
    return `<div style="position:fixed;inset:0;background:rgba(17,23,33,.48);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px" onclick="${closeHandler}">
      <div style="background:var(--surface);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.32);max-width:640px;width:100%;max-height:90vh;overflow:hidden;display:flex;flex-direction:column" onclick="event.stopPropagation()">
        <div style="padding:14px 22px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
          <div style="font-size:15px;font-weight:600">${esc(title)}</div>
          <button class="icon-btn" onclick="${closeHandler}" style="width:26px;height:26px">✕</button>
        </div>
        <div style="padding:18px 22px;overflow-y:auto;flex:1;min-height:0">${body}</div>
      </div>
    </div>`;
  }
  function _callModal() {
    const m = _ui.callModal;
    const meta = OUTCOMES.find((o) => o.v === m.outcome);
    const showNextInput = meta && meta.next;
    const body = `
      <div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Kies uitkomst</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px;margin-bottom:16px">
        ${OUTCOMES.map((o) => {
          const on = m.outcome === o.v;
          return `<button style="padding:8px 10px;border:1px solid ${on ? `var(--${o.c})` : 'var(--border)'};background:${on ? `var(--${o.c}-soft, var(--surface-2))` : 'transparent'};color:${on ? `var(--${o.c})` : 'var(--text-2)'};border-radius:6px;font-size:12px;font-weight:${on ? '600' : '400'};cursor:pointer;text-align:left" onclick="window.__fuCallSetOutcome('${o.v}')">${esc(o.l)}${o.note ? `<div style="font-size:9.5px;color:var(--text-3);margin-top:2px">${esc(o.note)}</div>` : ''}</button>`;
        }).join('')}
      </div>
      ${showNextInput === 'terugbel_datum' ? `
        <label style="display:block;margin-bottom:14px"><span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Datum & tijd</span>
          <input type="datetime-local" value="${esc(m.terugbel)}" oninput="window.__fuCallField('terugbel', this.value)" style="display:block;margin-top:4px;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px;font-family:inherit" />
        </label>` : ''}
      ${showNextInput === 'snooze_months' ? `
        <label style="display:block;margin-bottom:14px"><span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Snooze duur</span>
          <select onchange="window.__fuCallField('snoozeMonths', Number(this.value))" style="display:block;margin-top:4px;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px">
            <option value="6" ${m.snoozeMonths === 6 ? 'selected' : ''}>6 maanden</option>
            <option value="12" ${m.snoozeMonths === 12 ? 'selected' : ''}>12 maanden</option>
          </select>
        </label>` : ''}
      <div style="margin-bottom:14px">
        <span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:4px">Warmte (${m.warmte}/10)</span>
        <input type="range" min="0" max="10" value="${m.warmte}" oninput="window.__fuCallField('warmte', Number(this.value))" style="width:100%" />
        <div style="display:flex;justify-content:space-between;font-size:10.5px;color:var(--text-3);margin-top:2px"><span>koud</span><span>heet 🔥</span></div>
      </div>
      <div style="margin-bottom:14px">
        <span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:6px">Bezwaren (klik om te taggen)</span>
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          ${BEZWAREN.map((b) => {
            const on = m.bezwaren.has(b);
            return `<button style="padding:3px 9px;border:1px solid ${on ? 'var(--amber)' : 'var(--border)'};background:${on ? 'var(--amber-soft)' : 'transparent'};color:${on ? 'var(--amber)' : 'var(--text-2)'};border-radius:20px;font-size:11px;cursor:pointer" onclick="window.__fuCallToggleBezwaar('${esc(b)}')">${esc(b)}</button>`;
          }).join('')}
        </div>
      </div>
      <label style="display:block;margin-bottom:14px"><span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Notitie (optioneel)</span>
        <textarea oninput="window.__fuCallField('note', this.value)" placeholder="Extra context, quotes van klant, next steps…" style="display:block;width:100%;margin-top:4px;padding:8px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:12.5px;font-family:inherit;min-height:70px;resize:vertical">${esc(m.note)}</textarea>
      </label>
      ${m.error ? `<div style="padding:8px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px;margin-bottom:12px">${esc(m.error)}</div>` : ''}
      ${meta && meta.risk ? `<div style="padding:8px 12px;background:var(--amber-soft);color:var(--amber);border-radius:6px;font-size:12px;margin-bottom:12px">⚠ ${esc(meta.risk)}</div>` : ''}
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-ghost" onclick="window.__fuCloseCall()">Annuleren</button>
        <button class="btn btn-primary" ${(!m.outcome || m.saving) ? 'disabled' : ''} onclick="window.__fuCallSave()">${m.saving ? 'Opslaan…' : 'Opslaan'}</button>
      </div>`;
    return _modalShell('Bel-uitkomst registreren', body, 'window.__fuCloseCall()');
  }
  function _verplaatsModal() {
    const m = _ui.verplaatsModal;
    const body = `
      <label style="display:block;margin-bottom:14px"><span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Nieuwe datum & tijd</span>
        <input type="datetime-local" value="${esc(m.newDatetime)}" oninput="window.__fuVerplaatsField('newDatetime', this.value)" style="display:block;margin-top:4px;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px" />
      </label>
      <label style="display:block;margin-bottom:14px"><span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Duur (min)</span>
        <input type="number" min="10" max="180" step="15" value="${esc(m.duration)}" oninput="window.__fuVerplaatsField('duration', Number(this.value))" style="display:block;margin-top:4px;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px" />
      </label>
      <div style="padding:8px 12px;background:var(--amber-soft);color:var(--amber);border-radius:6px;font-size:12px;margin-bottom:12px">⚠ GHL-agenda wordt bijgewerkt (blocking). Zoom-link: best-effort.</div>
      ${m.error ? `<div style="padding:8px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px;margin-bottom:12px">${esc(m.error)}</div>` : ''}
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-ghost" onclick="window.__fuCloseVerplaats()">Annuleren</button>
        <button class="btn btn-primary" ${(!m.newDatetime || m.saving) ? 'disabled' : ''} onclick="window.__fuVerplaatsSave()">${m.saving ? 'Verplaatsen…' : 'Verplaatsen'}</button>
      </div>`;
    return _modalShell('Call verplaatsen', body, 'window.__fuCloseVerplaats()');
  }
  function _annuleerModal() {
    const m = _ui.annuleerModal;
    const body = `
      <div style="margin-bottom:14px">
        <span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;display:block;margin-bottom:6px">Modus</span>
        <label style="display:flex;align-items:center;gap:6px;padding:6px 0;font-size:13px"><input type="radio" name="fu-annuleer-mode" value="definitief" ${m.mode === 'definitief' ? 'checked' : ''} onchange="window.__fuAnnuleerField('mode', 'definitief')" /> Definitief annuleren</label>
        <label style="display:flex;align-items:center;gap:6px;padding:6px 0;font-size:13px"><input type="radio" name="fu-annuleer-mode" value="wacht_reschedule" ${m.mode === 'wacht_reschedule' ? 'checked' : ''} onchange="window.__fuAnnuleerField('mode', 'wacht_reschedule')" /> Wacht op reschedule</label>
      </div>
      <label style="display:block;margin-bottom:14px"><span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Reden (optioneel)</span>
        <textarea oninput="window.__fuAnnuleerField('reden', this.value)" placeholder="Kort waarom…" style="display:block;width:100%;margin-top:4px;padding:8px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:12.5px;font-family:inherit;min-height:60px;resize:vertical">${esc(m.reden)}</textarea>
      </label>
      <div style="padding:8px 12px;background:var(--amber-soft);color:var(--amber);border-radius:6px;font-size:12px;margin-bottom:12px">⚠ GHL wordt bijgewerkt (blocking). Zoom-link wordt NIET verwijderd.</div>
      ${m.error ? `<div style="padding:8px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px;margin-bottom:12px">${esc(m.error)}</div>` : ''}
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-ghost" onclick="window.__fuCloseAnnuleer()">Sluiten</button>
        <button class="btn btn-primary" ${m.saving ? 'disabled' : ''} onclick="window.__fuAnnuleerSave()" style="background:var(--rose);border-color:var(--rose)">${m.saving ? 'Annuleren…' : 'Bevestig annuleren'}</button>
      </div>`;
    return _modalShell('Call annuleren', body, 'window.__fuCloseAnnuleer()');
  }
  function _afschrijfModal() {
    const m = _ui.afschrijfModal;
    const body = `
      <div style="padding:8px 12px;background:var(--amber-soft);color:var(--amber);border-radius:6px;font-size:12px;margin-bottom:14px">⚠ Item wordt uit de opvolglijst gehaald én bijhorende lead wordt op status "verloren" gezet.</div>
      <label style="display:block;margin-bottom:14px"><span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Reden (min. 3 tekens)</span>
        <textarea oninput="window.__fuAfschrijfField('reason', this.value)" placeholder="Waarom afschrijven?" style="display:block;width:100%;margin-top:4px;padding:8px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:12.5px;font-family:inherit;min-height:70px;resize:vertical">${esc(m.reason)}</textarea>
      </label>
      ${m.error ? `<div style="padding:8px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px;margin-bottom:12px">${esc(m.error)}</div>` : ''}
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-ghost" onclick="window.__fuCloseAfschrijf()">Sluiten</button>
        <button class="btn btn-primary" ${(m.reason.trim().length < 3 || m.saving) ? 'disabled' : ''} onclick="window.__fuAfschrijfSave()" style="background:var(--rose);border-color:var(--rose)">${m.saving ? 'Afschrijven…' : 'Afschrijven'}</button>
      </div>`;
    return _modalShell('Opvolg-item afschrijven', body, 'window.__fuCloseAfschrijf()');
  }
  function _confirmModal() {
    const c = _ui.confirmModal;
    return `<div style="position:fixed;inset:0;background:rgba(17,23,33,.55);z-index:2100;display:flex;align-items:center;justify-content:center;padding:20px" onclick="window.__fuConfirmCancel()">
      <div style="background:var(--surface);border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.32);max-width:420px;width:100%;padding:22px 24px" onclick="event.stopPropagation()">
        <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:8px">Bevestigen</div>
        <div style="font-size:13px;color:var(--text-2);line-height:1.5;margin-bottom:18px">${esc(c.msg)}</div>
        <div style="display:flex;justify-content:flex-end;gap:8px">
          <button class="btn btn-ghost" onclick="window.__fuConfirmCancel()">Annuleren</button>
          <button class="btn btn-primary" onclick="window.__fuConfirmOk()">OK</button>
        </div>
      </div>
    </div>`;
  }
  function _renderToast() {
    const t = _ui.toast; if (!t) return '';
    const bg = t.tone === 'success' ? 'var(--emerald)' : t.tone === 'warn' ? 'var(--amber)' : '#1F2937';
    return `<div style="position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2200;background:${bg};color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:80vw;text-align:center">${esc(t.msg)}</div>`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // VIEW 2 — OPVOLGLIJST (event/zoom no-shows + reschedules — echte data)
  // ═══════════════════════════════════════════════════════════════════════
  function opvolglijstView() {
    const st = _live.opvolglijst;
    if (!st.loading && !st.data && !st.migrationRequired) queueMicrotask(fetchOpvolglijst);
    const body = st.migrationRequired ? migrationBanner('follow-up opvolglijst-flags')
      : (st.error && !st.data) ? errBlk(st.error, 'window.__fuRefresh()')
      : (st.loading && !st.data) ? skel()
      : _renderOpvolglijst(st.data);
    return `<div style="padding:16px 20px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <h2 style="font-size:16px;font-weight:600;margin:0">Opvolglijst — no-shows & reschedules (30d)</h2>
        <button class="icon-btn" onclick="window.__fuRefresh()" title="Vernieuw" style="width:28px;height:28px">↻</button>
      </div>
      ${st.data ? _renderCountsRow(st.data.counts) : ''}
      ${body}
      ${_renderModals()}
      ${_renderToast()}
    </div>`;
  }
  function _renderCountsRow(counts) {
    if (!counts) return '';
    const items = [
      { k: 'event_noshow',    l: 'Event no-show',    c: 'rose'   },
      { k: 'zoom_noshow',     l: 'Zoom no-show',     c: 'rose'   },
      { k: 'zoom_reschedule', l: 'Zoom reschedule',  c: 'amber'  },
      { k: 'zoom_cancelled',  l: 'Zoom geannuleerd', c: 'slate'  },
    ];
    return `<div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap">
      ${items.map((i) => {
        const n = Number(counts[i.k] || 0);
        return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 14px;min-width:150px">
          <div style="font-size:10.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">${esc(i.l)}</div>
          <div style="font-size:22px;font-weight:600;color:var(--${i.c});font-family:'IBM Plex Mono',monospace">${n}</div>
        </div>`;
      }).join('')}
    </div>`;
  }
  function _renderOpvolglijst(data) {
    // BUG-FIX null-guard: data kan null zijn op eerste render vóór fetch.
    if (!data) return skel();
    // BUG-FIX dedup: dedupe op uid (of ref_id+type als fallback) — bron-tabellen
    // kunnen dezelfde attendee/appointment 2× teruggeven bij overlap-flags.
    const seen = new Set();
    const items = asArr(data.items).filter((it) => {
      const key = it.uid || `${it.type || 'x'}:${it.ref_id || ''}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    if (items.length === 0) return `<div style="padding:40px 20px;text-align:center;color:var(--text-3)">🎉 Opvolglijst is leeg.</div>`;
    return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden">
      ${items.map((it, i) => `
        <div style="padding:12px 16px;display:grid;grid-template-columns:auto 1fr auto auto;gap:12px;align-items:center;${i < items.length - 1 ? 'border-bottom:1px solid var(--border);' : ''}">
          <span style="font-size:10.5px;padding:2px 8px;background:var(--${it.herkomst.includes('noshow') ? 'rose' : it.herkomst.includes('reschedule') ? 'amber' : 'slate'}-soft);color:var(--${it.herkomst.includes('noshow') ? 'rose' : it.herkomst.includes('reschedule') ? 'amber' : 'slate'});border-radius:20px;font-weight:600;white-space:nowrap">${esc(it.herkomst_label || it.herkomst)}</span>
          <div style="min-width:0">
            <div style="font-size:13.5px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.name || '—')}</div>
            <div style="font-size:11.5px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.email || it.phone || '—')}${it.event_title ? ` · ${esc(it.event_title)}` : ''}${it.scheduled_at ? ` · ${fmtDate(it.scheduled_at)}` : ''}</div>
            ${it.actie_hint ? `<div style="font-size:11px;color:var(--text-2);margin-top:2px;font-style:italic">${esc(it.actie_hint)}</div>` : ''}
          </div>
          ${it.lead_id ? `<button class="btn btn-ghost btn-sm" onclick="window.__fuJumpToLead('${esc(it.lead_id)}')" title="Open lead in Werklijst (reset filters naar Alles)">Open lead →</button>` : `<span style="font-size:11px;color:var(--text-3);font-style:italic">geen lead</span>`}
          <button class="btn btn-ghost btn-sm" style="color:var(--rose)" onclick="window.__fuOpenAfschrijf('${esc(it.type)}','${esc(it.ref_id)}')">Afschrijven</button>
        </div>
      `).join('')}
    </div>`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STUB VIEWS — BROK 2/3/4 (echte koppeling volgt in aparte commits)
  // ═══════════════════════════════════════════════════════════════════════
  function stubView(title, brok, endpoints) {
    return `<div style="padding:40px 24px;max-width:640px;margin:0 auto;text-align:center">
      <div style="font-size:32px;margin-bottom:12px">🚧</div>
      <h2 style="font-size:18px;font-weight:600;margin:0 0 8px 0">${esc(title)}</h2>
      <div style="font-size:13px;color:var(--text-3);margin-bottom:14px">Wordt gebouwd in <b>BROK ${esc(brok)}</b> — echte koppeling naar productie-endpoints volgt.</div>
      ${endpoints ? `<div style="font-size:11.5px;color:var(--text-3);font-family:'IBM Plex Mono',monospace;background:var(--surface-2);padding:10px 14px;border-radius:8px;text-align:left;line-height:1.7">${endpoints.map((e) => esc('• /api/' + e)).join('<br>')}</div>` : ''}
    </div>`;
  }
  const eventBellijstView = () => stubView('Event-bellijst', '4', ['follow-up-event-bellijst', 'follow-up-attendee-info']);
  const retentiesView     = () => stubView('Retenties (oude-retenties)', '2', ['follow-up-oude-retenties', 'follow-up-lead-retention-context']);
  const afsprakenView     = () => stubView('Afspraken + Kalender', '2', ['follow-up-appointments', 'follow-up-appointment-detail', 'follow-up-appointment-outcome', 'follow-up-kalender', 'follow-up-alle-komende']);
  const sluimerpotView    = () => stubView('Sluimerpot', '2', ['follow-up-opvolging-status']);
  const statistiekenView  = () => stubView('Statistieken / Dashboard', '4', ['follow-up-cockpit-dashboard', 'follow-up-cockpit-agenda', 'follow-up-dashboard-metrics', 'follow-up-metrics']);
  const afgeboektView     = () => stubView('Afgeboekt + Archief', '3', ['follow-up-afgeboekt', 'follow-up-archief']);

  // ═══════════════════════════════════════════════════════════════════════
  // REGISTRATIE
  // ═══════════════════════════════════════════════════════════════════════
  window.DFO.VIEWS['followup/Werklijst']       = werklijstView;
  window.DFO.VIEWS['followup/Opvolglijst']     = opvolglijstView;
  window.DFO.VIEWS['followup/Event-bellijst']  = eventBellijstView;
  window.DFO.VIEWS['followup/Retenties']       = retentiesView;
  window.DFO.VIEWS['followup/Afspraken']       = afsprakenView;
  window.DFO.VIEWS['followup/Sluimerpot']      = sluimerpotView;
  window.DFO.VIEWS['followup/Statistieken']    = statistiekenView;
  window.DFO.VIEWS['followup/Afgeboekt']       = afgeboektView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('followup');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('followup');

  console.debug('[followup-v2] BROK 1 registered — Werklijst + Opvolglijst live; overige tabs = stub tot BROK 2-4.');
})();
