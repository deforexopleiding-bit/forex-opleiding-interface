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
  // object zijn (join-shape uit backend). Voorkom "[object Object]" én
  // voorkom ruwe JSON in de UI (die kwam in QA naar boven). Return '' als
  // geen recognizable label-key beschikbaar is — nette lege plek is beter
  // dan onleesbare blob.
  const safeStr = (v) => {
    if (v == null) return '';
    if (typeof v === 'string' || typeof v === 'number') return String(v);
    if (typeof v === 'object') {
      // Alleen bekende labelvelden. GEEN JSON-fallback (dat blowde de layout op).
      return String(v.type || v.label || v.name || v.slug || v.id || '');
    }
    return String(v);
  };
  // Bron-label helper: normaliseert source (string of object) + optionele
  // source_ref tot een kort, veilig label. "manual · no-show follow-up" i.p.v.
  // ruw object of JSON-dump.
  const sourceLabel = (src, ref) => {
    const s = safeStr(src);
    const r = safeStr(ref);
    if (!s && !r) return '—';
    if (s && r && s !== r) return s + ' · ' + r.slice(0, 30);
    return s || r || '—';
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
    // BROK 2
    appts:       { loading: false, error: null, data: null, key: null },  // afspraken-list (per period)
    apptDetail:  { loading: {}, error: {}, data: {} },        // per appointment_id — {appointment, outcome, lead_history, customer_context}
    kalender:    { loading: false, error: null, data: null },  // 30-day forward window
    retenties:   { loading: false, error: null, data: null, key: null, migrationRequired: false },
    sluimerpot:  { loading: false, error: null, data: null },  // gebruikt leads-list?view=snoozed
    // BROK 3
    noshow:      { loading: false, error: null, data: null },
    afgeboekt:   { loading: false, error: null, data: null, key: null, migrationRequired: false },
    archief:     { loading: false, error: null, data: null, key: null },
    openActies:  { loading: false, error: null, data: null },  // appointments?period=open_acties
    opvolging:   { loading: false, error: null, data: null, key: null },  // appointments?period=opvolging_*
    // BROK 4
    eventPicker: { loading: false, error: null, data: null },              // events list voor picker
    eventBellijst: { loading: false, error: null, data: null, key: null },  // per event_id
    stats:       { loading: false, error: null, data: null, key: null },    // cockpit-dashboard (period)
    metrics:     { loading: false, error: null, data: null, key: null },    // dashboard-metrics (period)
    search:      { loading: false, error: null, data: null, key: null },    // /api/follow-up-search
    // BROK 5
    voicememo:   { loading: false, error: null, data: null },               // GET follow-up-voicememo-round
    messages:    { loading: {}, error: {}, data: {} },                      // per contact_id
    freeSlots:   { loading: false, error: null, data: null, key: null },    // key = start-date
    adminBackfillContacts: { loading: false, data: null, error: null },
    adminGhlBackfill: { loading: false, data: null, error: null, mode: 'dry_run' },
  };
  const _ui = {
    view:            'open',            // buckets-slug (open/vandaag/te_laat/komende_7/snoozed/alle)
    kindFilter:      'all',             // all / call / zoom
    sourceFilter:    'all',             // all / event / retention
    search:          '',
    selectedLeadId:  null,
    detailTab:       'overzicht',       // overzicht / notities / retentie
    callModal:       null,               // { leadId, outcome, terugbel, snoozeMonths, warmte, bezwaren:Set, note, saving, error }
    // verplaatsModal verwijderd (dead-code) — verzetten-flow gaat via apptOutcomeModal + submitApptOutcome → /api/follow-up-verplaats-call.
    annuleerModal:   null,               // { appointmentId, mode, reden, saving, error }
    afschrijfModal:  null,               // { type, refId, reason, saving, error }
    confirmModal:    null,               // { msg, onOk, onCancel, tone }
    noteDraft:       {},                 // per lead_id
    noteBusy:        {},
    outcomeBusy:     {},
    updateBusy:      {},
    toast:           null,               // { msg, tone, ts }
    // BROK 2
    apptPeriod:      'today',            // Afspraken period-filter
    apptDetailId:    null,               // open appointment-detail-modal
    apptOutcomeModal: null,              // { appointmentId, outcome, terugbelDatum, leadKind, snoozeMonths, newDatetime, duration, reden, saving, error }
    retentieReden:   'all',              // Retenties filter
    retentiePickBusy: {},                // per customer_id
    sluimerBusy:     {},                 // per lead_id (wake-up)
    // BROK 3
    noshowOutcomeModal: null,             // { attendeeId, outcome, note, saving, error }
    noshowBusy:        {},                // per attendee_id
    afgeboektReden:    'all',
    afgeboektReactBusy:{},                // per id
    archiefQ:          '',
    archiefPage:       1,
    opvolgingSub:      'opvolging_today',  // opvolging_overdue|today|week|30d|verder
    // BROK 4
    eventSelectedId:   null,               // null = "next upcoming"
    eventFollowupOnly: false,              // toggle in Event-bellijst
    statsPeriod:       'today',            // today|week|month
    searchQ:           '',
    // BROK 5
    voicememoBusy:     {},        // per appointment_id
    voicememoAllBusy:  false,
    voicememoPopupDismissed: false,  // per-sessie: user heeft popup weggeklikt
    deleteApptModal:   null,      // { appointmentId, reden, saving, error }
    adminBackfillBusy: false,
    adminGhlBackfillConfirm: '',  // confirm-token input
    adminGhlBackfillBusy: false,
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
  // ── BROK 2 fetchers ─────────────────────────────────────────────────
  async function fetchAppointments() {
    const st = _live.appts;
    const key = _ui.apptPeriod;
    if (st.loading) return;
    if (st.data && st.key === key) return;
    st.loading = true; st.error = null; st.key = key;
    // BUG-FIX P1-4: past_week toonde 0 rijen omdat backend default status =
    // [scheduled, in_progress] voor future-periods. Voor past_week zijn
    // die statussen per definitie niet aanwezig; stuur completed/no_show/
    // cancelled/verplaatst expliciet mee.
    const statusForPeriod = key === 'past_week' ? '&status=completed,no_show,cancelled,verplaatst' : '';
    const j = await tryFetch('appts:' + key, '/api/follow-up-appointments?period=' + encodeURIComponent(key) + statusForPeriod);
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = { appointments: asArr(j?.appointments), count: Number(j?.count || 0), period: j?.period };
    if (render) render();
  }
  async function fetchAppointmentDetail(id) {
    if (!id) return;
    const st = _live.apptDetail;
    if (st.loading[id] || st.data[id]) return;
    st.loading[id] = true; st.error[id] = null;
    const j = await tryFetch('appt-detail:' + id, '/api/follow-up-appointment-detail?id=' + encodeURIComponent(id));
    if (j && j.__error) { st.error[id] = j.__error; st.loading[id] = false; if (render) render(); return; }
    // BUG-FIX P1-2 fallback: als appointment-detail geen lead_history heeft
    // (bv. leeg omdat lead_ghl_contact_id ontbreekt), probeer alsnog
    // follow-up-appointment-history die op eigen wijze via andere joins zoekt.
    if (j && (!Array.isArray(j.lead_history) || j.lead_history.length === 0)) {
      const h = await tryFetch('appt-hist:' + id, '/api/follow-up-appointment-history?id=' + encodeURIComponent(id));
      if (h && !h.__error && Array.isArray(h.history)) j.lead_history = h.history;
    }
    st.loading[id] = false;
    st.data[id] = j || null;
    if (render) render();
  }
  async function fetchKalender() {
    const st = _live.kalender;
    if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('alle-komende', '/api/follow-up-alle-komende');
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = { appointments: asArr(j?.appointments), count: Number(j?.count || 0) };
    if (render) render();
  }
  async function fetchRetenties() {
    const st = _live.retenties;
    const key = _ui.retentieReden;
    if (st.loading) return;
    if (st.data && st.key === key) return;
    st.loading = true; st.error = null; st.key = key; st.migrationRequired = false;
    const params = [];
    if (_ui.retentieReden && _ui.retentieReden !== 'all') params.push('reden=' + encodeURIComponent(_ui.retentieReden));
    const url = '/api/follow-up-oude-retenties' + (params.length ? '?' + params.join('&') : '');
    const j = await tryFetch('retenties', url);
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else if (j?.code === 'MIGRATION_REQUIRED') st.migrationRequired = true;
    else st.data = { items: asArr(j?.items), counts: j?.counts || {} };
    if (render) render();
  }
  async function fetchSluimerpot() {
    const st = _live.sluimerpot;
    if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    // Hergebruik leads-list met view=snoozed. Aparte state zodat we niet met
    // de Werklijst-cache botsen.
    const j = await tryFetch('sluimerpot', '/api/follow-up-leads-list?worklist=1&view=snoozed&limit=1000');
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = { leads: asArr(j?.leads), counts: j?.counts || {} };
    if (render) render();
  }
  // ── BROK 2 write-handlers ───────────────────────────────────────────
  async function submitApptOutcome() {
    const m = _ui.apptOutcomeModal;
    if (!m || m.saving) return;
    if (!m.outcome) { m.error = 'Kies uitkomst'; if (render) render(); return; }
    const body = { appointment_id: m.appointmentId, outcome: m.outcome };
    if (m.outcome === 'terugbel') {
      if (!m.terugbelDatum) { m.error = 'Terugbel-datum verplicht'; if (render) render(); return; }
      body.terugbel_datum = new Date(m.terugbelDatum).toISOString();
      body.lead_kind = m.leadKind || 'bel';
    }
    if (m.outcome === 'later_opnieuw') body.snooze_months = Number(m.snoozeMonths || 3);
    if (m.outcome === 'verzetten') {
      if (!m.newDatetime) { m.error = 'Nieuwe datum verplicht'; if (render) render(); return; }
      body.new_datetime = m.newDatetime;
      body.duration_minutes = Number(m.duration || 30);
    }
    if (m.outcome === 'annuleren') body.reden = m.reden || null;
    m.saving = true; m.error = null; if (render) render();
    const j = await tryFetch('appt-outcome', '/api/follow-up-appointment-outcome', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 15000);
    m.saving = false;
    if (j && (j.__error || j.error || !j.ok)) {
      m.error = j.__error || j.error || 'Opslaan mislukt';
      if (j?.code === 'IRREVERSIBLE') m.error += ' (onomkeerbaar — geen undo)';
      if (render) render();
      return;
    }
    _ui.apptOutcomeModal = null;
    _live.appts.data = null; _live.appts.key = null;
    _live.leadsList.data = null; _live.leadsList.key = null;
    if (j?.delegated) showToast('Gedelegeerd naar ' + j.delegated + '-endpoint · afspraak bijgewerkt', 'success');
    else showToast('Uitkomst opgeslagen', 'success');
    if (Array.isArray(j?.warnings) && j.warnings.length) console.warn('[followup-v2] appt-outcome warnings:', j.warnings);
    if (render) render();
  }
  async function submitRetentiePickup(customerId, endDate, subStatus) {
    if (!customerId || _ui.retentiePickBusy[customerId]) return;
    _ui.retentiePickBusy[customerId] = true; if (render) render();
    const j = await tryFetch('retentie-pickup', '/api/follow-up-oude-retenties', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'pickup', customer_id: customerId, end_date: endDate || null, last_sub_status: subStatus || null }),
    }, 10000);
    _ui.retentiePickBusy[customerId] = false;
    if (j && (j.__error || j.error || !j.ok)) {
      showToast('Pickup mislukt: ' + (j.__error || j.error || 'onbekend'), 'warn');
      if (render) render(); return;
    }
    _live.retenties.data = null; _live.retenties.key = null;
    _live.leadsList.data = null; _live.leadsList.key = null;
    showToast(j.already ? 'Al opgepakt — terugbel-datum ververst' : 'Retentie opgepakt · lead aangemaakt', 'success');
    if (render) render();
  }
  // ── BROK 3 fetchers ─────────────────────────────────────────────────
  async function fetchNoshow() {
    const st = _live.noshow;
    if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('noshow-list', '/api/follow-up-no-show-list');
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = { attendees: asArr(j?.attendees), count: Number(j?.count || 0) };
    if (render) render();
  }
  async function fetchAfgeboekt() {
    const st = _live.afgeboekt;
    const key = _ui.afgeboektReden;
    if (st.loading) return;
    if (st.data && st.key === key) return;
    st.loading = true; st.error = null; st.key = key; st.migrationRequired = false;
    const params = _ui.afgeboektReden && _ui.afgeboektReden !== 'all' ? '?reden=' + encodeURIComponent(_ui.afgeboektReden) : '';
    const j = await tryFetch('afgeboekt', '/api/follow-up-afgeboekt' + params);
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else if (j?.code === 'MIGRATION_REQUIRED') st.migrationRequired = true;
    else st.data = { items: asArr(j?.items), counts: j?.counts || {} };
    if (render) render();
  }
  async function fetchArchief() {
    const st = _live.archief;
    const key = `${_ui.archiefQ}|${_ui.archiefPage}`;
    if (st.loading) return;
    if (st.data && st.key === key) return;
    st.loading = true; st.error = null; st.key = key;
    const params = [];
    if (_ui.archiefQ) params.push('q=' + encodeURIComponent(_ui.archiefQ));
    if (_ui.archiefPage > 1) params.push('page=' + _ui.archiefPage);
    params.push('pageSize=25');
    const j = await tryFetch('archief', '/api/follow-up-archief?' + params.join('&'));
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = { appointments: asArr(j?.appointments), total: Number(j?.total || 0), page: Number(j?.page || 1), totalPages: Number(j?.totalPages || 1) };
    if (render) render();
  }
  async function fetchOpenActies() {
    const st = _live.openActies;
    if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('open-acties', '/api/follow-up-appointments?period=open_acties');
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = { appointments: asArr(j?.appointments), count: Number(j?.count || 0) };
    if (render) render();
  }
  async function fetchOpvolging() {
    const st = _live.opvolging;
    const key = _ui.opvolgingSub;
    if (st.loading) return;
    if (st.data && st.key === key) return;
    st.loading = true; st.error = null; st.key = key;
    const j = await tryFetch('opvolging:' + key, '/api/follow-up-appointments?period=' + encodeURIComponent(key));
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = { appointments: asArr(j?.appointments), count: Number(j?.count || 0) };
    if (render) render();
  }
  // ── BROK 3 write-handlers ───────────────────────────────────────────
  async function submitNoshowOutcome() {
    const m = _ui.noshowOutcomeModal;
    if (!m || m.saving) return;
    if (!m.outcome) { m.error = 'Kies uitkomst'; if (render) render(); return; }
    m.saving = true; m.error = null; if (render) render();
    const j = await tryFetch('noshow-outcome', '/api/follow-up-no-show-outcome', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attendee_id: m.attendeeId, outcome: m.outcome, note: m.note || null }),
    }, 10000);
    m.saving = false;
    if (j && (j.__error || j.error || !j.ok)) {
      if (j?.code === 'MIGRATION_REQUIRED') { m.error = 'Migratie 024 (event_attendees.no_show_followup_*) moet gedraaid worden.'; }
      else m.error = j.__error || j.error || 'Opslaan mislukt';
      if (render) render();
      return;
    }
    _ui.noshowOutcomeModal = null;
    _live.noshow.data = null;
    showToast('No-show uitkomst opgeslagen · ' + m.outcome, 'success');
    if (render) render();
  }
  // ── BROK 4 fetchers ─────────────────────────────────────────────────
  async function fetchEventPicker() {
    const st = _live.eventPicker;
    if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('event-picker', '/api/follow-up-event-bellijst?list=upcoming');
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = { events: asArr(j?.events) };
    if (render) render();
  }
  async function fetchEventBellijst() {
    const st = _live.eventBellijst;
    const key = _ui.eventSelectedId || '_next';
    if (st.loading) return;
    if (st.data && st.key === key) return;
    st.loading = true; st.error = null; st.key = key;
    const url = _ui.eventSelectedId
      ? '/api/follow-up-event-bellijst?event_id=' + encodeURIComponent(_ui.eventSelectedId)
      : '/api/follow-up-event-bellijst';
    const j = await tryFetch('event-bellijst', url);
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = { event: j?.event || null, attendees: asArr(j?.attendees) };
    if (render) render();
  }
  async function fetchStats() {
    const st = _live.stats;
    const key = _ui.statsPeriod;
    if (st.loading) return;
    if (st.data && st.key === key) return;
    st.loading = true; st.error = null; st.key = key;
    const j = await tryFetch('stats:' + key, '/api/follow-up-cockpit-dashboard?period=' + encodeURIComponent(key));
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = { totals: j?.totals || {}, per_user: asArr(j?.per_user), period: j?.period };
    if (render) render();
  }
  async function fetchMetrics() {
    const st = _live.metrics;
    const key = _ui.statsPeriod;
    if (st.loading) return;
    if (st.data && st.key === key) return;
    st.loading = true; st.error = null; st.key = key;
    const j = await tryFetch('metrics:' + key, '/api/follow-up-dashboard-metrics?period=' + encodeURIComponent(key));
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = j?.metrics || {};
    if (render) render();
  }
  async function fetchSearch() {
    const st = _live.search;
    const q = String(_ui.searchQ || '').trim();
    if (st.loading) return;
    if (st.data && st.key === q) return;
    if (q.length < 2) { st.data = { q, results: [] }; st.key = q; if (render) render(); return; }
    st.loading = true; st.error = null; st.key = q;
    const j = await tryFetch('search:' + q, '/api/follow-up-search?q=' + encodeURIComponent(q) + '&limit=30');
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = { q, results: asArr(j?.results) };
    if (render) render();
  }
  // ── BROK 5 fetchers ─────────────────────────────────────────────────
  async function fetchVoicememo() {
    const st = _live.voicememo;
    if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('voicememo-round', '/api/follow-up-voicememo-round');
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = { leads: asArr(j?.leads), today: j?.today, counts: j?.counts || {} };
    if (render) render();
  }
  async function fetchMessages(contactId) {
    if (!contactId) return;
    const st = _live.messages;
    if (st.loading[contactId] || st.data[contactId]) return;
    st.loading[contactId] = true; st.error[contactId] = null;
    const j = await tryFetch('messages:' + contactId, '/api/follow-up-messages?contact_id=' + encodeURIComponent(contactId));
    st.loading[contactId] = false;
    if (j && j.__error) st.error[contactId] = j.__error;
    else st.data[contactId] = asArr(j?.messages);
    if (render) render();
  }
  async function fetchFreeSlots(startDate) {
    const st = _live.freeSlots;
    const key = startDate || '_today';
    if (st.loading) return;
    if (st.data && st.key === key) return;
    st.loading = true; st.error = null; st.key = key;
    const url = '/api/follow-up-ghl-free-slots' + (startDate ? '?date=' + encodeURIComponent(startDate) : '');
    const j = await tryFetch('free-slots', url);
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = { slots: asArr(j?.slots), timezone: j?.timezone };
    if (render) render();
  }
  // ── BROK 5 write-handlers ───────────────────────────────────────────
  async function submitVoicememoSent(apptId, all) {
    const key = all ? '_ALL' : apptId;
    if (all) _ui.voicememoAllBusy = true; else _ui.voicememoBusy[apptId] = true;
    if (render) render();
    const body = all ? { all: true } : { appointment_id: apptId };
    const j = await tryFetch('voicememo-mark', '/api/follow-up-voicememo-round', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }, 12000);
    if (all) _ui.voicememoAllBusy = false; else _ui.voicememoBusy[apptId] = false;
    if (j && (j.__error || j.error)) {
      showToast('Markeren mislukt: ' + (j.__error || j.error), 'warn');
      if (render) render(); return;
    }
    _live.voicememo.data = null;
    showToast(all ? `${j.updated || 0} voicememos gemarkeerd als verzonden` : 'Voicememo gemarkeerd als verzonden', 'success');
    if (render) render();
  }
  async function submitDeleteAppt() {
    const m = _ui.deleteApptModal;
    if (!m || m.saving) return;
    m.saving = true; m.error = null; if (render) render();
    const j = await tryFetch('appt-delete', '/api/follow-up-verwijder', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appointment_id: m.appointmentId, reden: m.reden || null }),
    }, 15000);
    m.saving = false;
    if (j && (j.__error || j.error || !j.success)) {
      m.error = j.__error || j.error || 'Verwijderen mislukt';
      if (render) render(); return;
    }
    _ui.deleteApptModal = null;
    _ui.apptDetailId = null;
    _live.appts.data = null; _live.appts.key = null;
    _live.archief.data = null; _live.archief.key = null;
    const parts = [];
    if (j.ghl_cancelled) parts.push('GHL cancelled');
    if (j.zoom_deleted) parts.push('Zoom deleted');
    showToast('Afspraak verwijderd (soft-delete)' + (parts.length ? ' · ' + parts.join(', ') : ''), 'success');
    if (render) render();
  }
  async function submitAdminBackfillContacts() {
    if (_ui.adminBackfillBusy) return;
    _ui.adminBackfillBusy = true; _live.adminBackfillContacts.data = null; _live.adminBackfillContacts.error = null;
    if (render) render();
    const j = await tryFetch('backfill-contacts', '/api/follow-up-backfill-contacts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }, 60000);
    _ui.adminBackfillBusy = false;
    if (j && (j.__error || j.error)) {
      _live.adminBackfillContacts.error = j.__error || j.error;
      showToast('Backfill mislukt: ' + _live.adminBackfillContacts.error, 'warn');
    } else {
      _live.adminBackfillContacts.data = { totaal: j.totaal || 0, updated: j.updated || 0, skipped: j.skipped || 0, errors: j.errors || 0 };
      showToast(`Backfill klaar · ${j.updated || 0}/${j.totaal || 0} bijgewerkt`, 'success');
    }
    if (render) render();
  }
  async function submitAdminGhlBackfill(dryRun) {
    if (_ui.adminGhlBackfillBusy) return;
    _ui.adminGhlBackfillBusy = true; if (render) render();
    const body = dryRun ? { dry_run: true, mode: 'strict', limit: 50 }
      : { dry_run: false, mode: 'strict', limit: 50, confirm: _ui.adminGhlBackfillConfirm };
    const j = await tryFetch('ghl-backfill', '/api/follow-up-ghl-status-backfill', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }, 60000);
    _ui.adminGhlBackfillBusy = false;
    if (j && (j.__error || j.error)) {
      _live.adminGhlBackfill.error = j.__error || j.error;
      showToast('GHL-backfill mislukt: ' + _live.adminGhlBackfill.error, 'warn');
    } else {
      _live.adminGhlBackfill.data = j;
      _live.adminGhlBackfill.mode = dryRun ? 'dry_run' : 'executed';
      showToast(dryRun ? `Dry-run: ${j.returned || 0} kandidaten` : `Executed: ${j.succeeded || 0}/${j.processed || 0} bijgewerkt`, 'success');
      if (!dryRun) _ui.adminGhlBackfillConfirm = '';
    }
    if (render) render();
  }
  async function submitReactivate(type, id) {
    if (!id || _ui.afgeboektReactBusy[id]) return;
    _ui.afgeboektReactBusy[id] = true; if (render) render();
    const j = await tryFetch('reactivate', '/api/follow-up-afgeboekt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, id, action: 'reactivate' }),
    }, 10000);
    _ui.afgeboektReactBusy[id] = false;
    if (j && (j.__error || j.error || !j.ok)) {
      showToast('Reactiveren mislukt: ' + (j.__error || j.error || 'onbekend'), 'warn');
      if (render) render(); return;
    }
    _live.afgeboekt.data = null; _live.afgeboekt.key = null;
    _live.leadsList.data = null; _live.leadsList.key = null;
    const msg = j.type === 'lead_created' ? 'Nieuwe lead aangemaakt uit afspraak'
              : j.type === 'lead_reused' ? 'Bestaande lead hergebruikt · notitie toegevoegd'
              : 'Lead gereactiveerd · terugbel = nu';
    showToast(msg, 'success');
    if (render) render();
  }
  async function submitSluimerWakeUp(leadId) {
    if (!leadId || _ui.sluimerBusy[leadId]) return;
    _ui.sluimerBusy[leadId] = true; if (render) render();
    // Wake-up: zet lead-status naar 'terugbellen' + terugbel_datum=nu. Backend
    // clear'et snoozed_until niet automatisch — dat gebeurt bij eerste outcome.
    // Voor nu is dit voldoende om 'em uit sluimerpot te halen bij volgende fetch.
    const j = await tryFetch('sluimer-wake', '/api/follow-up-lead-update', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lead_id: leadId, lead_status: 'terugbellen', terugbel_datum: new Date().toISOString() }),
    }, 8000);
    _ui.sluimerBusy[leadId] = false;
    if (j && (j.__error || j.error)) { showToast('Wake-up mislukt: ' + (j.__error || j.error), 'warn'); if (render) render(); return; }
    _live.sluimerpot.data = null;
    _live.leadsList.data = null; _live.leadsList.key = null;
    showToast('Lead is wakker · terugbel-datum = nu', 'success');
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
  // submitVerplaats verwijderd — de bereikbare verzetten-flow gaat via
  // submitApptOutcome() (outcome === 'verzetten'), die dezelfde
  // /api/follow-up-verplaats-call aanroept.
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
  // UX-ronde 2026-08-16: "Openen"-actie voor deelnemers/opvolglijst-rijen
  // zonder lead. Find-or-create via POST /api/event-followup-to-lead met
  // attendee_id OF followup_id (endpoint accepteert beide). Klant-veilig:
  // maakt max 1 lead (endpoint idempotent — `already:true` bij herhaling),
  // mirror v1-gedrag. Bij success → __fuJumpToLead naar de resulterende lead
  // → Werklijst met filters=alle zodat de lead direct werkbaar is.
  window.__fuAttendeeToLead = async (attendeeId, followupId) => {
    if (!attendeeId && !followupId) { showToast('Geen attendee/followup-id', 'warn'); return; }
    const body = {};
    if (followupId) body.followup_id = followupId;
    else            body.attendee_id = attendeeId;
    const j = await tryFetch('to-lead', '/api/event-followup-to-lead', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 10000);
    if (!j || j.__error) {
      showToast('Openen mislukt: ' + (j?.__error || 'onbekend'), 'warn');
      return;
    }
    if (j.code === 'MIGRATION_REQUIRED') {
      showToast('follow_up_leads-tabel ontbreekt — migratie moet nog draaien.', 'warn');
      return;
    }
    if (!j.lead_id) { showToast('Geen lead-id terug uit endpoint', 'warn'); return; }
    if (j.already) showToast('Bestaande lead geopend', 'success');
    else           showToast('Lead aangemaakt + geopend', 'success');
    window.__fuJumpToLead(j.lead_id);
  };
  // Voicememo-popup dismiss (per sessie; blijft dicht tot volgende page-load).
  window.__fuVoicememoDismissPopup = () => {
    _ui.voicememoPopupDismissed = true;
    if (render) render();
  };
  window.__fuVoicememoOpenView = () => {
    _ui.voicememoPopupDismissed = true;
    if (window.DFO && typeof window.DFO.goTab === 'function') {
      try { window.DFO.goTab('Overige'); } catch (_) {}
    }
    // Fallback: als Overige-tab geen sub-nav aanbiedt naar Voicememo, gebruik
    // directe view-render via hash-manipulatie (mocht die pad bestaan).
    if (render) render();
  };
  window.__fuDetailTab = (t) => { _ui.detailTab = t; if (render) render(); };
  window.__fuOpenCall = (leadId) => {
    _ui.callModal = { leadId, outcome: null, terugbel: '', snoozeMonths: 6, warmte: 5, bezwaren: new Set(), note: '', saving: false, error: null };
    if (render) render();
  };
  // Click-to-call via bestaande shared softphone (KlxSoftphone).
  // Zelfde API die klanten-detail/wanbetalers/events gebruiken — GEEN
  // klx-softphone.* wijziging (protected zone). Fail-soft: als de
  // softphone niet geladen is (bijv. sip.min.js failed of iframe/preview),
  // toon nette toast i.p.v. crash. Wanneer wél geladen: opent het rich
  // belvenster met phone + name + lead_id als source.
  window.__fuDial = (phone, displayName, leadId) => {
    if (!phone) { showToast('Geen telefoonnummer bekend', 'warn'); return; }
    if (!window.KlxSoftphone || typeof window.KlxSoftphone.open !== 'function') {
      showToast('Softphone niet geladen — probeer hard-refresh of check SIP-config.', 'warn');
      return;
    }
    try {
      window.KlxSoftphone.open({
        phone,
        name: displayName || phone,
        customerId: leadId || null,
        source: 'followup.werklijst',
      });
    } catch (e) {
      console.warn('[followup-v2] softphone.open fail:', e?.message || e);
      showToast('Kon softphone niet openen: ' + (e?.message || 'onbekend'), 'warn');
    }
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
  // Surgische DOM-sync voor slot-chip highlights + datetime-input value.
  // GEEN full re-render → geen scroll-reset, geen focus-loss.
  function _syncSlotChipHighlight(iso) {
    try {
      const chips = document.querySelectorAll('[data-fu-slot-chip]');
      chips.forEach((btn) => {
        const slotIso = btn.getAttribute('data-fu-slot-iso');
        const active = slotIso && iso && slotIso === iso;
        btn.style.borderColor = active ? 'var(--m)' : 'var(--border)';
        btn.style.background = active ? 'var(--m-soft)' : 'var(--surface)';
        btn.style.color = active ? 'var(--m)' : 'var(--text-2)';
        btn.style.fontWeight = active ? '600' : '400';
      });
    } catch (_) { /* no-op */ }
  }
  // Slot-pick invult m.newDatetime van de OUTCOME-modal (verzetten-flow).
  // Surgische DOM-write (input + chip-highlight) i.p.v. re-render — voorkomt
  // scroll-reset naar top van modal-body én behoudt focus in het datetime-veld.
  window.__fuPickSlot = (isoDateTime) => {
    if (!_ui.apptOutcomeModal || !isoDateTime) return;
    _ui.apptOutcomeModal.newDatetime = isoDateTime;
    try {
      const inp = document.querySelector('[data-fu-appt-datetime]');
      if (inp) inp.value = isoDateTime;
    } catch (_) { /* no-op */ }
    _syncSlotChipHighlight(isoDateTime);
  };
  // window.__fuCloseVerplaats / __fuVerplaatsField / __fuVerplaatsSave verwijderd
  // (dead-code, geen call-sites meer sinds _verplaatsModal weg is).
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
  // ── BROK 2 handlers ─────────────────────────────────────────────────
  window.__fuApptPeriod = (p) => { _ui.apptPeriod = p; _live.appts.data = null; _live.appts.key = null; if (render) render(); };
  window.__fuApptOpen = (id) => { _ui.apptDetailId = id; if (render) render(); };
  window.__fuApptClose = () => { _ui.apptDetailId = null; if (render) render(); };
  window.__fuApptOutcomeOpen = (id) => {
    _ui.apptOutcomeModal = { appointmentId: id, outcome: null, terugbelDatum: '', leadKind: 'bel', snoozeMonths: 3, newDatetime: '', duration: 30, reden: '', saving: false, error: null };
    if (render) render();
  };
  window.__fuApptOutcomeClose = () => { _ui.apptOutcomeModal = null; if (render) render(); };
  window.__fuApptOutcomeSet = (v) => {
    if (!_ui.apptOutcomeModal) return;
    _ui.apptOutcomeModal.outcome = v; _ui.apptOutcomeModal.error = null;
    if (v === 'terugbel' && !_ui.apptOutcomeModal.terugbelDatum) {
      const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(10, 0, 0, 0);
      _ui.apptOutcomeModal.terugbelDatum = inputForDatetimeLocal(d.toISOString());
    }
    // Verzetten-flow: pre-fetch GHL free-slots zodat picker meteen data heeft.
    // Fail-soft: bij error/empty blijft de handmatige datetime-input werken.
    if (v === 'verzetten') {
      _live.freeSlots.data = null; _live.freeSlots.key = null;
      queueMicrotask(() => fetchFreeSlots(null));
    }
    if (render) render();
  };
  // State-only handler — GEEN re-render tijdens typen. Fix voor focus-loss
  // (NotFoundError: Failed to set 'innerHTML' … node no longer a child) op
  // datetime-local / number / textarea inputs. Re-render gebeurt alleen bij
  // outcome-radio (__fuApptOutcomeSet); slot-pick doet surgische DOM-update.
  // Bij handmatige newDatetime-wijziging: sync ook de chip-highlight surgisch
  // zodat een oude actieve chip niet blijft staan bij manueel wijzigen.
  window.__fuApptOutcomeField = (k, v) => {
    if (!_ui.apptOutcomeModal) return;
    _ui.apptOutcomeModal[k] = v;
    if (k === 'newDatetime') _syncSlotChipHighlight(v);
  };
  const APPT_RISK_OUTCOMES = new Set(['sale','no_show','gesprek_gehad','wilt_niet_meer','niet_geschikt','later_opnieuw','terugbel','verzetten','annuleren']);
  window.__fuApptOutcomeSave = () => {
    const m = _ui.apptOutcomeModal; if (!m || !m.outcome) return;
    if (APPT_RISK_OUTCOMES.has(m.outcome)) {
      // APPT_OUTCOME_RISK is single-source-of-truth voor gevolg-tekst (ook getoond
      // in-modal). Confirm herhaalt 'em zodat je 't nog eens leest voor de klik.
      const risk = (typeof APPT_OUTCOME_RISK !== 'undefined' && APPT_OUTCOME_RISK[m.outcome]) || 'Klant-zichtbaar effect.';
      openConfirm(risk + ' Weet je zeker dat je "' + m.outcome + '" wilt registreren?', submitApptOutcome, 'warn');
    } else {
      submitApptOutcome();
    }
  };
  window.__fuKalenderRefresh = () => { _live.kalender.data = null; if (render) render(); };
  window.__fuRetentieReden = (v) => { _ui.retentieReden = v; _live.retenties.data = null; _live.retenties.key = null; if (render) render(); };
  window.__fuRetentiePickup = (customerId, endDate, subStatus) => submitRetentiePickup(customerId, endDate, subStatus);
  window.__fuSluimerWake = (leadId) => {
    openConfirm('Deze lead uit sluimerpot halen? Terugbel-datum wordt gezet op nu, status → terugbellen.', () => submitSluimerWakeUp(leadId), 'warn');
  };
  window.__fuSluimerRefresh = () => { _live.sluimerpot.data = null; if (render) render(); };
  // ── BROK 3 handlers ─────────────────────────────────────────────────
  window.__fuNoshowRefresh = () => { _live.noshow.data = null; if (render) render(); };
  window.__fuNoshowOutcomeOpen = (attendeeId) => {
    _ui.noshowOutcomeModal = { attendeeId, outcome: null, note: '', saving: false, error: null };
    if (render) render();
  };
  window.__fuNoshowOutcomeClose = () => { _ui.noshowOutcomeModal = null; if (render) render(); };
  window.__fuNoshowOutcomeSet = (v) => { if (_ui.noshowOutcomeModal) { _ui.noshowOutcomeModal.outcome = v; _ui.noshowOutcomeModal.error = null; if (render) render(); } };
  window.__fuNoshowOutcomeField = (k, v) => { if (_ui.noshowOutcomeModal) { _ui.noshowOutcomeModal[k] = v; if (render) render(); } };
  window.__fuNoshowOutcomeSave = () => {
    const m = _ui.noshowOutcomeModal; if (!m || !m.outcome) return;
    const risk = {
      ander_event: 'Attendee wordt uit no-show-lijst gehaald · geen lead-mutatie.',
      geen_interesse: 'Attendee wordt uit no-show-lijst gehaald · gekoppelde lead → verloren (indien aanwezig).',
      niet_bereikt: 'Blijft in no-show-lijst · status = niet_bereikt.',
      terugbellen: 'Blijft in no-show-lijst · status = terugbellen.',
    }[m.outcome];
    if (m.outcome === 'ander_event' || m.outcome === 'geen_interesse') {
      openConfirm(risk + ' Weet je zeker?', submitNoshowOutcome, 'warn');
    } else {
      submitNoshowOutcome();
    }
  };
  window.__fuAfgeboektReden = (v) => { _ui.afgeboektReden = v; _live.afgeboekt.data = null; _live.afgeboekt.key = null; if (render) render(); };
  window.__fuAfgeboektReactivate = (type, id) => {
    openConfirm('Deze ' + (type === 'lead' ? 'lead' : 'afspraak') + ' reactiveren? Er wordt (indien nodig) een nieuwe follow-up-lead aangemaakt met terugbel = nu.', () => submitReactivate(type, id), 'warn');
  };
  window.__fuAfgeboektRefresh = () => { _live.afgeboekt.data = null; _live.afgeboekt.key = null; if (render) render(); };
  let _archiefSearchT = null;
  window.__fuArchiefSearch = (v) => {
    if (_archiefSearchT) clearTimeout(_archiefSearchT);
    _archiefSearchT = setTimeout(() => {
      _ui.archiefQ = String(v || '').trim(); _ui.archiefPage = 1;
      _live.archief.data = null; _live.archief.key = null;
      if (render) render();
    }, 400);
  };
  window.__fuArchiefPage = (dir) => {
    _ui.archiefPage = Math.max(1, _ui.archiefPage + dir);
    _live.archief.data = null; _live.archief.key = null;
    if (render) render();
  };
  window.__fuArchiefRefresh = () => { _live.archief.data = null; _live.archief.key = null; if (render) render(); };
  window.__fuOpenActiesRefresh = () => { _live.openActies.data = null; if (render) render(); };
  window.__fuOpvolgingSub = (v) => { _ui.opvolgingSub = v; _live.opvolging.data = null; _live.opvolging.key = null; if (render) render(); };
  window.__fuOpvolgingRefresh = () => { _live.opvolging.data = null; _live.opvolging.key = null; if (render) render(); };
  // ── BROK 4 handlers ─────────────────────────────────────────────────
  window.__fuEventSelect = (id) => { _ui.eventSelectedId = id || null; _live.eventBellijst.data = null; _live.eventBellijst.key = null; if (render) render(); };
  window.__fuEventFollowupOnly = (on) => { _ui.eventFollowupOnly = !!on; if (render) render(); };
  window.__fuEventRefresh = () => { _live.eventPicker.data = null; _live.eventBellijst.data = null; _live.eventBellijst.key = null; if (render) render(); };
  window.__fuStatsPeriod = (p) => {
    _ui.statsPeriod = p;
    _live.stats.data = null; _live.stats.key = null;
    _live.metrics.data = null; _live.metrics.key = null;
    if (render) render();
  };
  window.__fuStatsRefresh = () => {
    _live.stats.data = null; _live.stats.key = null;
    _live.metrics.data = null; _live.metrics.key = null;
    if (render) render();
  };
  let _fuSearchT = null;
  window.__fuSearchInput = (v) => {
    if (_fuSearchT) clearTimeout(_fuSearchT);
    _fuSearchT = setTimeout(() => {
      _ui.searchQ = String(v || '').trim();
      _live.search.data = null; _live.search.key = null;
      if (render) render();
    }, 400);
  };
  // ── BROK 5 handlers ─────────────────────────────────────────────────
  window.__fuVoicememoRefresh = () => { _live.voicememo.data = null; if (render) render(); };
  window.__fuVoicememoMark = (apptId) => { submitVoicememoSent(apptId, false); };
  window.__fuVoicememoMarkAll = () => {
    openConfirm('Markeer alle vandaag-Zooms als voicememo-verzonden? Dit is bulk-actie voor de ochtendronde; alleen doen na dat je alle voicememos in WhatsApp hebt verstuurd.', () => submitVoicememoSent(null, true), 'warn');
  };
  window.__fuDeleteApptOpen = (apptId) => {
    _ui.deleteApptModal = { appointmentId: apptId, reden: '', saving: false, error: null };
    if (render) render();
  };
  window.__fuDeleteApptClose = () => { _ui.deleteApptModal = null; if (render) render(); };
  window.__fuDeleteApptField = (k, v) => { if (_ui.deleteApptModal) { _ui.deleteApptModal[k] = v; if (render) render(); } };
  window.__fuDeleteApptSave = () => {
    const m = _ui.deleteApptModal; if (!m) return;
    openConfirm('Verwijderen: soft-delete DB + GHL-cancel (klant krijgt cancel-mail via GHL) + Zoom-meeting delete. Onomkeerbaar. Weet je zeker?', submitDeleteAppt, 'warn');
  };
  window.__fuAdminBackfillContacts = () => {
    openConfirm('Backfill GHL-contacts naar alle appointments met ontbrekende email/telefoon? Loopt door alle appts; kan lang duren (max 60s per run).', submitAdminBackfillContacts, 'warn');
  };
  window.__fuAdminGhlBackfillDry = () => submitAdminGhlBackfill(true);
  window.__fuAdminGhlBackfillExecuteConfirm = (v) => { _ui.adminGhlBackfillConfirm = v; if (render) render(); };
  window.__fuAdminGhlBackfillExecute = () => {
    if (_ui.adminGhlBackfillConfirm !== 'IK BEGRIJP HET') { showToast('Typ letterlijk "IK BEGRIJP HET" in het confirm-veld', 'warn'); return; }
    openConfirm('EXECUTE GHL-status-backfill (mode=strict, limit=50)? Muteert live GHL appointmentStatus → "showed". Alleen super_admin. Onomkeerbaar.', () => submitAdminGhlBackfill(false), 'warn');
  };
  window.__fuSearchOpenResult = (source, targetJson) => {
    let target;
    try { target = JSON.parse(atob(targetJson)); } catch (_) { return; }
    if (source === 'lead' && target?.lead_id) window.__fuJumpToLead(target.lead_id);
    else if (source === 'appointment' && target?.appointment_id) {
      window.__fuApptOpen(target.appointment_id);
      if (window.DFO?.goTab) try { window.DFO.goTab('Afspraken'); } catch (_) {}
    }
    else showToast('Open-target voor ' + source + ' nog niet gewired', 'info');
  };

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
      ${_voicememoPopup()}
      ${_renderModals()}
      ${_renderToast()}
    </div>`;
  }
  function _renderBucketsRow() {
    // BUG-FIX P1-1: single source of truth. Voor de ACTIEVE bucket toon
    // altijd het geladen lijst-aantal (leads.length na client-side bucket-
    // en zoek-filter). Voor niet-actieve buckets: backend-counts, MAAR
    // alleen als de user 'em nog niet heeft geladen. Zo blijft badge=lijst
    // wanneer je een bucket bekijkt.
    // Root-cause 139/129: backend counts (uit een aparte SELECT) tellen
    // eventueel gearchiveerde/klant-buiten-scope leads mee die de list-query
    // wél filtert (RLS + owner-gate + snoozed-exclude in default view=open).
    // Root-cause 11/1 (snoozed): identiek — counts.snoozed telt alle
    // snoozed-rijen, list met view=snoozed filtert extra op RLS/owner.
    const backendCounts = _live.leadsList.data?.counts || {};
    const activeListLen = asArr(_live.leadsList.data?.leads).length;
    return `<div style="padding:10px 16px;display:flex;gap:6px;align-items:center;overflow-x:auto;border-bottom:1px solid var(--border);background:var(--surface)">
      ${BUCKETS.map((b) => {
        const on = _ui.view === b.slug;
        // Voor de ACTIEVE bucket: gebruik ALTIJD list-length (waarheid van wat je ziet).
        // Voor niet-actieve buckets: backend-count als leidraad.
        const cnt = on ? activeListLen : (backendCounts[b.slug === 'open' ? 'open' : b.slug] || 0);
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
      ${_renderVoicememoIndicator()}
      ${_live.leadsList.data ? `<span style="color:var(--text-3);font-family:'IBM Plex Mono',monospace;font-size:11.5px">${asArr(_live.leadsList.data.leads).length} leads</span>` : ''}
    </div>`;
  }
  // Kleine voicememo-indicator (mirror v1) — badge met openstaand-count +
  // klik-actie naar de deep-link view. Vervangt de eigen "Voicememo"-tab.
  function _renderVoicememoIndicator() {
    if (!_live.voicememo.data) return '';
    const items = asArr(_live.voicememo.data.items || _live.voicememo.data.rounds || _live.voicememo.data);
    const openCount = items.filter((it) => !it.voicememo_sent && !it.done).length;
    if (openCount <= 0) return '';
    return `<button class="btn btn-ghost btn-sm" style="margin-left:auto;gap:6px;color:var(--violet);border-color:var(--violet)" onclick="window.__fuVoicememoOpenView()" title="Voicememo-ronde (${openCount} openstaand)">🎙 ${openCount}</button>`;
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
            <span style="font-size:10.5px;color:var(--text-3);word-break:break-word;max-width:100%">Bron: ${esc(sourceLabel(l.source, null))}</span>
            ${l.owner_name ? `<span style="font-size:10.5px;color:var(--text-3)">Eigenaar: ${esc(safeStr(l.owner_name))}</span>` : ''}
          </div>
        </div>
        <div style="display:flex;gap:6px;align-items:center;flex-shrink:0">
          ${l.lead_phone
            ? `<button class="btn btn-primary" onclick="window.__fuDial('${esc(l.lead_phone)}','${esc((l.lead_name || l.lead_email || l.lead_phone || '').replace(/'/g, "\\'"))}','${esc(l.id)}')" title="Bel via softphone">📞 Bellen</button>`
            : `<button class="btn btn-ghost" disabled title="Geen telefoonnummer bekend (uit GHL-contact)">📞 Geen nummer</button>`}
          <button class="btn btn-ghost" onclick="window.__fuOpenCall('${esc(l.id)}')" title="Registreer de uitkomst van dit gesprek">${svg(I.phone || I.call || '')} Uitkomst</button>
        </div>
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
          <div style="word-break:break-word;overflow-wrap:anywhere"><b>Bron:</b> ${esc(sourceLabel(l.source, l.source_ref))}</div>
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
    // _verplaatsModal verwijderd — verzetten-flow zit in apptOutcomeModal.
    if (_ui.annuleerModal) html.push(_annuleerModal());
    if (_ui.afschrijfModal) html.push(_afschrijfModal());
    if (_ui.confirmModal) html.push(_confirmModal());
    if (_ui.deleteApptModal) html.push(_deleteApptModal());
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
  // Free-slots picker voor verplaatsen (BROK 5): fetcht GHL-beschikbaarheid en
  // toont klikbare chips per dag. Fail-soft: bij leeg/error blijft de handmatige
  // datetime-input functioneel. Klant-veilig: alleen invult, geen auto-submit.
  function _renderFreeSlotsPicker() {
    const st = _live.freeSlots;
    if (st.loading && !st.data) {
      return `<div style="margin-bottom:14px;padding:10px 12px;background:var(--surface-2);border-radius:6px;font-size:12px;color:var(--text-3)">GHL-beschikbaarheid laden…</div>`;
    }
    if (st.error && !st.data) {
      return `<div style="margin-bottom:14px;padding:10px 12px;background:var(--amber-soft);border:1px solid var(--amber);color:var(--amber);border-radius:6px;font-size:12px">GHL-slots niet beschikbaar (${esc(st.error)}). Kies datum/tijd handmatig hieronder.</div>`;
    }
    const days = asArr(st.data?.slots);
    if (!days.length) {
      return `<div style="margin-bottom:14px;padding:10px 12px;background:var(--surface-2);border-radius:6px;font-size:12px;color:var(--text-3)">Geen GHL-slots gevonden in de komende 14 dagen. Kies datum/tijd handmatig hieronder.</div>`;
    }
    return `<div style="margin-bottom:14px">
      <div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Beschikbare slots (GHL, ${esc(st.data?.timezone || 'Europe/Amsterdam')})</div>
      <div style="max-height:200px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding:8px;background:var(--surface-2);border:1px solid var(--border);border-radius:6px">
        ${days.map((d) => {
          const dayLabel = d.date ? new Date(d.date + 'T00:00:00').toLocaleDateString('nl-NL', { weekday: 'short', day: '2-digit', month: 'short' }) : '—';
          const times = asArr(d.times);
          if (times.length === 0) return '';
          return `<div>
            <div style="font-size:11px;font-weight:600;color:var(--text-2);margin-bottom:4px">${esc(dayLabel)}</div>
            <div style="display:flex;flex-wrap:wrap;gap:4px">
              ${times.map((t) => {
                // Combineer d.date + t naar datetime-local waarde (YYYY-MM-DDTHH:MM)
                const iso = `${d.date}T${t}`;
                const isSelected = _ui.apptOutcomeModal?.newDatetime === iso;
                return `<button class="chip" data-fu-slot-chip data-fu-slot-iso="${esc(iso)}" style="padding:4px 10px;border:1px solid ${isSelected ? 'var(--m)' : 'var(--border)'};background:${isSelected ? 'var(--m-soft)' : 'var(--surface)'};color:${isSelected ? 'var(--m)' : 'var(--text-2)'};border-radius:6px;font-size:11.5px;font-family:'IBM Plex Mono',monospace;cursor:pointer;font-weight:${isSelected ? '600' : '400'}" onclick="window.__fuPickSlot('${esc(iso)}')">${esc(t)}</button>`;
              }).join('')}
            </div>
          </div>`;
        }).join('')}
      </div>
      <div style="font-size:10.5px;color:var(--text-3);margin-top:4px;font-style:italic">Klik een slot om datum/tijd hieronder in te vullen. Verplaatsen gebeurt pas bij klik op de Verplaatsen-knop.</div>
    </div>`;
  }
  // _verplaatsModal verwijderd — dode code. Verzetten gaat via _apptOutcomeModalRender()
  // (outcome === 'verzetten'), waar _renderFreeSlotsPicker() en de datetime-input
  // nu direct in de outcome-modal staan.
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
    // BUG-FIX dedup (rev): uid bleek NIET stabiel — dedup gebruikte 'em maar
    // 2 rijen kregen elk hun eigen uid ondanks identieke lead/tijd (bv. attendee-
    // rij én appointment-rij voor dezelfde persoon). Nu een STABIELE composite
    // key op de businesswaarden (email + scheduled_at + type). Val voor rijen
    // zonder email terug op naam+tijd, want anders zou dedup te breed spannen.
    const seen = new Set();
    const items = asArr(data.items).filter((it) => {
      const emailPart = String(it.email || it.name || '').toLowerCase().trim();
      const timePart = String(it.scheduled_at || '').slice(0, 16); // "YYYY-MM-DDTHH:MM"
      const typePart = String(it.type || 'x');
      const key = `${typePart}|${emailPart}|${timePart}`;
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
          ${it.lead_id
            ? `<button class="btn btn-primary btn-sm" onclick="window.__fuJumpToLead('${esc(it.lead_id)}')" title="Open lead in Werklijst (reset filters naar Alles)">📞 Openen</button>`
            : (it.attendee_id || it.followup_id)
              ? `<button class="btn btn-primary btn-sm" onclick="window.__fuAttendeeToLead('${esc(it.attendee_id || '')}','${esc(it.followup_id || '')}')" title="Maak lead van deze deelnemer en open in Werklijst">📞 Openen</button>`
              : it.phone
                ? `<button class="btn btn-primary btn-sm" onclick="window.__fuDial('${esc(it.phone)}','${esc((it.name || it.phone).replace(/'/g, "\\'"))}','')" title="Bel direct via softphone (geen lead-koppeling beschikbaar)">📞 Bellen</button>`
                : `<button class="btn btn-ghost btn-sm" disabled title="Geen contactgegevens beschikbaar op deze rij">📞 Geen contact</button>`}
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
  // ═══════════════════════════════════════════════════════════════════════
  // BROK 4 — EVENT-BELLIJST (event-picker + attendees + followup-only toggle)
  // ═══════════════════════════════════════════════════════════════════════
  function eventBellijstView() {
    const stP = _live.eventPicker;
    if (!stP.loading && !stP.data) queueMicrotask(fetchEventPicker);
    const stB = _live.eventBellijst;
    const key = _ui.eventSelectedId || '_next';
    if (!stB.loading && (!stB.data || stB.key !== key)) queueMicrotask(fetchEventBellijst);
    return `<div style="padding:14px 20px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:10px">
        <h2 style="font-size:16px;font-weight:600;margin:0">Event-bellijst</h2>
        <div style="display:flex;gap:8px;align-items:center">
          <select onchange="window.__fuEventSelect(this.value)" style="padding:5px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12.5px;max-width:320px">
            <option value="">(volgende geplande event)</option>
            ${asArr(stP.data?.events).map((e) => `<option value="${esc(e.id)}" ${_ui.eventSelectedId === e.id ? 'selected' : ''}>${esc(safeStr(e.title) || '—')} · ${fmtDateShort(e.starts_at)}</option>`).join('')}
          </select>
          <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-2)"><input type="checkbox" ${_ui.eventFollowupOnly ? 'checked' : ''} onchange="window.__fuEventFollowupOnly(this.checked)" /> Alleen met follow-up-status</label>
          <button class="icon-btn" onclick="window.__fuEventRefresh()" title="Vernieuw" style="width:28px;height:28px">↻</button>
        </div>
      </div>
      ${stB.error && !stB.data ? errBlk(stB.error, 'window.__fuEventRefresh()') :
        (stB.loading && !stB.data) ? skel() :
        !stB.data ? skel() :
        _renderEventBellijst(stB.data)}
      ${_renderModals()}
      ${_renderToast()}
    </div>`;
  }
  function _renderEventBellijst(data) {
    const ev = data.event;
    let attendees = asArr(data.attendees);
    if (_ui.eventFollowupOnly) attendees = attendees.filter((a) => a.call_status || a.lead_status || a.lead_id);
    if (!ev) return `<div style="padding:40px 20px;text-align:center;color:var(--text-3)">Geen event gevonden.</div>`;
    return `<div style="margin-bottom:14px;padding:12px 16px;background:var(--m-soft);border:1px solid var(--m);border-radius:8px">
        <div style="font-size:14px;font-weight:600;color:var(--m)">${esc(safeStr(ev.title) || '—')}</div>
        <div style="font-size:12px;color:var(--text-3);margin-top:2px">${fmtDate(ev.starts_at)} · ${ev.attendee_count || attendees.length} deelnemers</div>
      </div>
      ${attendees.length === 0 ? `<div style="padding:40px 20px;text-align:center;color:var(--text-3)">Geen deelnemers${_ui.eventFollowupOnly ? ' met follow-up-status' : ''}.</div>` :
      `<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden">
        ${attendees.map((a, i) => {
          const naam = safeStr(a.name) || '—';
          const callStatus = a.call_status || a.lead_status || '—';
          const callColor = callStatus === 'geen_gehoor' ? 'slate' : callStatus === 'terugbellen' ? 'amber' : callStatus === 'sale' ? 'emerald' : callStatus === 'geen_interesse' ? 'rose' : 'neutral';
          return `<div style="padding:12px 16px;display:grid;grid-template-columns:1fr auto auto auto;gap:12px;align-items:center;${i < attendees.length - 1 ? 'border-bottom:1px solid var(--border);' : ''}">
            <div style="min-width:0">
              <div style="font-size:13.5px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(naam)}</div>
              <div style="font-size:11.5px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(safeStr(a.email) || safeStr(a.phone) || '—')}${a.questionnaire_filled ? ' · ✓ vragenlijst' : ''}</div>
            </div>
            ${callStatus !== '—' ? H.pill(callColor, callStatus) : '<span style="font-size:11px;color:var(--text-3)">—</span>'}
            ${a.call_status_at ? `<span style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-3);white-space:nowrap">${fmtDateShort(a.call_status_at)}</span>` : '<span></span>'}
            ${a.lead_id
              ? `<button class="btn btn-primary btn-sm" onclick="window.__fuJumpToLead('${esc(a.lead_id)}')" title="Open lead in Werklijst">📞 Openen</button>`
              : (a.id || a.attendee_id || a.followup_id)
                ? `<button class="btn btn-primary btn-sm" onclick="window.__fuAttendeeToLead('${esc(a.id || a.attendee_id || '')}','${esc(a.followup_id || '')}')" title="Maak werkbare lead + open in Werklijst">📞 Openen</button>`
                : `<span style="font-size:11px;color:var(--text-3);font-style:italic">geen lead</span>`}
          </div>`;
        }).join('')}
      </div>`}`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BROK 4 — STATISTIEKEN (dashboard-metrics + cockpit-dashboard combined)
  // ═══════════════════════════════════════════════════════════════════════
  const STATS_PERIODS = [
    { v: 'today', l: 'Vandaag' },
    { v: 'week',  l: 'Deze week' },
    { v: 'month', l: 'Deze maand' },
  ];
  function statistiekenView() {
    const stS = _live.stats;
    const stM = _live.metrics;
    const key = _ui.statsPeriod;
    if (!stS.loading && (!stS.data || stS.key !== key)) queueMicrotask(fetchStats);
    if (!stM.loading && (!stM.data || stM.key !== key)) queueMicrotask(fetchMetrics);
    return `<div style="padding:14px 20px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:10px">
        <h2 style="font-size:16px;font-weight:600;margin:0">Statistieken</h2>
        <div style="display:flex;gap:6px">
          ${STATS_PERIODS.map((p) => {
            const on = _ui.statsPeriod === p.v;
            return `<button class="chip ${on ? 'on' : ''}" style="padding:5px 12px;border:1px solid ${on ? 'var(--m)' : 'var(--border)'};background:${on ? 'var(--m-soft)' : 'transparent'};color:${on ? 'var(--m)' : 'var(--text-2)'};border-radius:20px;font-size:12px;font-weight:${on ? '600' : '400'};cursor:pointer" onclick="window.__fuStatsPeriod('${p.v}')">${esc(p.l)}</button>`;
          }).join('')}
          <button class="icon-btn" onclick="window.__fuStatsRefresh()" title="Vernieuw" style="width:28px;height:28px">↻</button>
        </div>
      </div>
      ${stS.error && stM.error ? errBlk('Beide stats-endpoints faalden — ' + (stS.error || stM.error), 'window.__fuStatsRefresh()') :
        (stS.loading && !stS.data) || (stM.loading && !stM.data) ? skel() :
        _renderStats(stS.data, stM.data)}
      ${_renderModals()}
      ${_renderToast()}
    </div>`;
  }
  function _renderStats(stats, metrics) {
    const totals = stats?.totals || {};
    const perUser = asArr(stats?.per_user);
    // BUG-FIX #2: aggregate conversie berekent NU op dezelfde formule als de
    // per-user kolom (gewonnen/gebeld*100 int), NIET meer metrics.conversion_rate
    // (dat leest gewonnen/outcomes_total en gaf 0 zolang outcomes_total leeg was).
    const totalGebeld  = Number(totals.gebeld   || 0);
    const totalGewonnen = Number(totals.gewonnen || 0);
    const aggConversie = totalGebeld > 0 ? Math.round((totalGewonnen / totalGebeld) * 100) : 0;
    const kpis = [
      { l: 'Gebeld',    v: totals.gebeld || 0,    c: 'blue'    },
      { l: 'Bereikt',   v: totals.bereikt || 0,   c: 'violet'  },
      { l: 'Zoom',      v: totals.zoom || 0,      c: 'amber'   },
      { l: 'Offerte',   v: totals.offerte || 0,   c: 'amber'   },
      { l: 'Gewonnen',  v: totals.gewonnen || 0,  c: 'emerald' },
      { l: 'Conversie', v: aggConversie + '%',    c: 'emerald' },
    ];
    const mKpis = metrics ? [
      { l: 'Afspraken',           v: metrics.appointments_total || 0,    c: 'blue'    },
      { l: '  waarvan completed', v: metrics.appointments_completed || 0, c: 'emerald' },
      { l: '  waarvan no-show',   v: metrics.appointments_no_show || 0,  c: 'rose'    },
      { l: 'Voicememos',          v: metrics.voicememos_sent || 0,        c: 'violet'  },
      { l: 'No-show rate',        v: (metrics.no_show_rate || 0) + '%',   c: 'rose'    },
      { l: 'Achterstallig',       v: metrics.achterstallig_totaal || 0,   c: 'amber'   },
    ] : [];
    // BUG-FIX #1: top_bezwaren kan uit dashboard-metrics komen als
    // metrics.top_bezwaren (jsonb array). In productie kwam die soms leeg terug
    // waardoor het blok volledig verdween. Nu ALTIJD renderen met nette
    // leeg-state ("nog geen bezwaren getagd deze periode").
    const bezwaren = asArr(metrics?.top_bezwaren);
    return `
      <div style="display:grid;grid-template-columns:repeat(auto-fill, minmax(160px, 1fr));gap:10px;margin-bottom:20px">
        ${kpis.concat(mKpis).map((k) => `<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 14px">
          <div style="font-size:10.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">${esc(k.l)}</div>
          <div style="font-size:22px;font-weight:600;color:var(--${k.c});font-family:'IBM Plex Mono',monospace;margin-top:4px">${esc(String(k.v))}</div>
        </div>`).join('')}
      </div>
      ${perUser.length > 0 ? `<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-bottom:20px">
        <div style="padding:10px 16px;background:var(--surface-2);font-size:12px;font-weight:600;color:var(--text-2);border-bottom:1px solid var(--border)">Per medewerker</div>
        <div style="display:grid;grid-template-columns:1fr repeat(6, auto);gap:8px 16px;padding:10px 16px;font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid var(--border)">
          <span>Naam</span><span>Gebeld</span><span>Bereikt</span><span>Zoom</span><span>Offerte</span><span>Gewonnen</span><span>Conv%</span>
        </div>
        ${perUser.map((u, i) => `<div style="display:grid;grid-template-columns:1fr repeat(6, auto);gap:8px 16px;padding:8px 16px;font-size:12.5px;align-items:center;${i < perUser.length - 1 ? 'border-bottom:1px solid var(--border);' : ''}">
          <span style="font-weight:500;color:var(--text)">${esc(safeStr(u.name) || '—')}</span>
          <span class="mono">${u.gebeld || 0}</span>
          <span class="mono">${u.bereikt || 0}</span>
          <span class="mono">${u.zoom || 0}</span>
          <span class="mono">${u.offerte || 0}</span>
          <span class="mono" style="color:var(--emerald)">${u.gewonnen || 0}</span>
          <span class="mono" style="color:var(--m)">${u.conversie || 0}%</span>
        </div>`).join('')}
      </div>` : ''}
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden">
        <div style="padding:10px 16px;background:var(--surface-2);font-size:12px;font-weight:600;color:var(--text-2);border-bottom:1px solid var(--border)">Top bezwaren <span style="color:var(--text-3);font-weight:400">(uit call-uitkomsten)</span></div>
        ${bezwaren.length === 0 ? `<div style="padding:16px;text-align:center;color:var(--text-3);font-size:12.5px;font-style:italic">Nog geen bezwaren getagd deze periode.</div>` :
          bezwaren.slice(0, 10).map((b, i) => {
            const maxCount = Math.max(1, ...bezwaren.map((x) => Number(x.count || 0)));
            const pct = Math.round((Number(b.count || 0) / maxCount) * 100);
            return `<div style="padding:10px 16px;${i < 9 && i < bezwaren.length - 1 ? 'border-bottom:1px solid var(--border);' : ''}">
              <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px">
                <span>${esc(safeStr(b.naam) || '—')}</span><span class="mono" style="font-weight:600">${b.count || 0}×</span>
              </div>
              <div style="height:4px;background:var(--surface-2);border-radius:2px;overflow:hidden"><div style="width:${pct}%;height:100%;background:var(--m)"></div></div>
            </div>`;
          }).join('')
        }
      </div>`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BROK 4 — ZOEKEN (globale search over leads/appts/events/customers)
  // ═══════════════════════════════════════════════════════════════════════
  function zoekenView() {
    const st = _live.search;
    if (_ui.searchQ && _ui.searchQ.length >= 2 && !st.loading && (!st.data || st.key !== _ui.searchQ)) queueMicrotask(fetchSearch);
    return `<div style="padding:14px 20px;max-width:900px;margin:0 auto">
      <div style="margin-bottom:14px">
        <h2 style="font-size:16px;font-weight:600;margin:0 0 10px 0">Zoeken — leads · afspraken · event-deelnemers · klanten</h2>
        <input type="search" placeholder="Zoek op naam, e-mail of telefoon (min 2 tekens)…" value="${esc(_ui.searchQ)}" oninput="window.__fuSearchInput(this.value)" autofocus style="width:100%;padding:10px 14px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);font-size:14px" />
      </div>
      ${!_ui.searchQ || _ui.searchQ.length < 2 ? `<div style="padding:40px 20px;text-align:center;color:var(--text-3);font-size:13px">Typ minimaal 2 tekens om te zoeken.</div>` :
        st.error ? errBlk(st.error) :
        st.loading ? skel() :
        !st.data ? skel() :
        _renderSearchResults(st.data)}
      ${_renderModals()}
      ${_renderToast()}
    </div>`;
  }
  function _renderSearchResults(data) {
    const results = asArr(data.results);
    if (results.length === 0) return `<div style="padding:40px 20px;text-align:center;color:var(--text-3);font-size:13px">Geen resultaten voor "${esc(data.q)}".</div>`;
    const sourceMeta = {
      lead:        { c: 'blue',    l: 'Lead' },
      appointment: { c: 'violet',  l: 'Afspraak' },
      event:       { c: 'amber',   l: 'Event' },
      retention:   { c: 'emerald', l: 'Retentie' },
    };
    return `<div style="font-size:12px;color:var(--text-3);margin-bottom:10px">${results.length} resultaten</div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden">
        ${results.map((r, i) => {
          const m = sourceMeta[r.source] || { c: 'neutral', l: r.source };
          const b64 = (typeof btoa !== 'undefined') ? btoa(JSON.stringify(r.open_target || {})) : '';
          const wanneer = r.scheduled_at || r.updated_at;
          return `<div style="padding:12px 16px;display:grid;grid-template-columns:auto 1fr auto auto;gap:12px;align-items:center;cursor:pointer;${i < results.length - 1 ? 'border-bottom:1px solid var(--border);' : ''}" onclick="window.__fuSearchOpenResult('${esc(r.source)}','${esc(b64)}')" onmouseover="this.style.background='var(--surface-2)'" onmouseout="this.style.background='transparent'">
            ${H.pill(m.c, m.l)}
            <div style="min-width:0">
              <div style="font-size:13.5px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(safeStr(r.lead_name) || '—')}</div>
              <div style="font-size:11.5px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(safeStr(r.lead_email) || safeStr(r.lead_phone) || '—')}${r.lead_source ? ` · bron: ${esc(safeStr(r.lead_source))}` : ''}${r.lead_status ? ` · ${esc(safeStr(r.lead_status))}` : ''}${r.status ? ` · ${esc(safeStr(r.status))}` : ''}</div>
            </div>
            <span style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-3);white-space:nowrap">${wanneer ? fmtDateShort(wanneer) : ''}</span>
            <span style="color:var(--m);font-size:16px">→</span>
          </div>`;
        }).join('')}
      </div>`;
  }


  // ═══════════════════════════════════════════════════════════════════════
  // BROK 3 — NO-SHOW (event-attendees no_show + outcome-modal)
  // ═══════════════════════════════════════════════════════════════════════
  const NOSHOW_OUTCOMES = [
    { v: 'terugbellen',    l: 'Terugbellen',       c: 'amber',   note: 'blijft in lijst' },
    { v: 'niet_bereikt',   l: 'Niet bereikt',      c: 'slate',   note: 'blijft in lijst' },
    { v: 'ander_event',    l: 'Naar ander event',  c: 'blue',    note: 'uit lijst' },
    { v: 'geen_interesse', l: 'Geen interesse',    c: 'rose',    note: 'uit lijst · lead → verloren' },
  ];
  function noshowView() {
    const st = _live.noshow;
    if (!st.loading && !st.data) queueMicrotask(fetchNoshow);
    const body = st.error && !st.data ? errBlk(st.error, 'window.__fuNoshowRefresh()')
      : (st.loading && !st.data) ? skel()
      : !st.data ? skel()
      : _renderNoshow(st.data);
    return `<div style="padding:14px 20px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h2 style="font-size:16px;font-weight:600;margin:0">No-shows — event-deelnemers die niet kwamen</h2>
        <button class="icon-btn" onclick="window.__fuNoshowRefresh()" title="Vernieuw" style="width:28px;height:28px">↻</button>
      </div>
      ${st.data ? `<div style="font-size:12px;color:var(--text-3);margin-bottom:12px">${st.data.attendees.length} open no-shows${st.data.count !== st.data.attendees.length ? ` (backend telt ${st.data.count})` : ''}</div>` : ''}
      ${body}
      ${_noshowOutcomeModal()}
      ${_renderModals()}
      ${_renderToast()}
    </div>`;
  }
  function _renderNoshow(data) {
    const attendees = asArr(data.attendees);
    if (attendees.length === 0) return `<div style="padding:40px 20px;text-align:center;color:var(--text-3)">🎉 Geen open no-shows.</div>`;
    return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden">
      ${attendees.map((a, i) => {
        const naam = a.name || [a.first_name, a.last_name].filter(Boolean).join(' ') || a.email || '—';
        const status = a.no_show_followup_status || 'open';
        const statusColor = status === 'terugbellen' ? 'amber' : status === 'niet_bereikt' ? 'slate' : 'blue';
        return `<div style="padding:12px 16px;display:grid;grid-template-columns:1fr auto auto auto;gap:12px;align-items:center;${i < attendees.length - 1 ? 'border-bottom:1px solid var(--border);' : ''}">
          <div style="min-width:0">
            <div style="font-size:13.5px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(safeStr(naam))}</div>
            <div style="font-size:11.5px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(safeStr(a.email) || safeStr(a.phone) || '—')}${a.event_title ? ` · ${esc(safeStr(a.event_title))}` : ''}${a.event_completed_at ? ` · ${fmtDateShort(a.event_completed_at)}` : ''}</div>
            ${a.questionnaire_filled ? '<div style="font-size:10.5px;color:var(--emerald);margin-top:2px">✓ Vragenlijst ingevuld</div>' : ''}
          </div>
          ${H.pill(statusColor, status)}
          ${a.lead_id ? `<button class="btn btn-ghost btn-sm" onclick="window.__fuJumpToLead('${esc(a.lead_id)}')">Open lead →</button>` : `<span style="font-size:11px;color:var(--text-3);font-style:italic">geen lead</span>`}
          <button class="btn btn-primary btn-sm" onclick="window.__fuNoshowOutcomeOpen('${esc(a.attendee_id)}')">Uitkomst</button>
        </div>`;
      }).join('')}
    </div>`;
  }
  function _noshowOutcomeModal() {
    const m = _ui.noshowOutcomeModal; if (!m) return '';
    const meta = NOSHOW_OUTCOMES.find((o) => o.v === m.outcome);
    const body = `
      <div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Kies uitkomst</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:6px;margin-bottom:14px">
        ${NOSHOW_OUTCOMES.map((o) => {
          const on = m.outcome === o.v;
          return `<button style="padding:8px 10px;border:1px solid ${on ? `var(--${o.c})` : 'var(--border)'};background:${on ? `var(--${o.c}-soft)` : 'transparent'};color:${on ? `var(--${o.c})` : 'var(--text-2)'};border-radius:6px;font-size:12px;font-weight:${on ? '600' : '400'};cursor:pointer;text-align:left" onclick="window.__fuNoshowOutcomeSet('${o.v}')">${esc(o.l)}<div style="font-size:9.5px;color:var(--text-3);margin-top:2px">${esc(o.note)}</div></button>`;
        }).join('')}
      </div>
      ${meta ? `<div style="padding:8px 12px;background:var(--amber-soft);color:var(--amber);border-radius:6px;font-size:12px;margin-bottom:14px"><b>Gevolg:</b> ${esc(meta.note)}</div>` : ''}
      <label style="display:block;margin-bottom:14px"><span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Notitie (optioneel)</span>
        <textarea oninput="window.__fuNoshowOutcomeField('note', this.value)" style="display:block;width:100%;margin-top:4px;padding:8px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:12.5px;font-family:inherit;min-height:60px;resize:vertical">${esc(m.note)}</textarea>
      </label>
      ${m.error ? `<div style="padding:8px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px;margin-bottom:12px">${esc(m.error)}</div>` : ''}
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-ghost" onclick="window.__fuNoshowOutcomeClose()">Annuleren</button>
        <button class="btn btn-primary" ${(!m.outcome || m.saving) ? 'disabled' : ''} onclick="window.__fuNoshowOutcomeSave()">${m.saving ? 'Opslaan…' : 'Opslaan'}</button>
      </div>`;
    return _modalShell('No-show uitkomst', body, 'window.__fuNoshowOutcomeClose()');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BROK 3 — OPEN-ACTIES (afspraken met period=open_acties)
  // ═══════════════════════════════════════════════════════════════════════
  function openActiesView() {
    const st = _live.openActies;
    if (!st.loading && !st.data) queueMicrotask(fetchOpenActies);
    const body = st.error && !st.data ? errBlk(st.error, 'window.__fuOpenActiesRefresh()')
      : (st.loading && !st.data) ? skel()
      : !st.data ? skel()
      : _renderAppointmentList(st.data.appointments);
    return `<div style="padding:14px 20px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h2 style="font-size:16px;font-weight:600;margin:0">Open acties — afspraken die actie vereisen</h2>
        <button class="icon-btn" onclick="window.__fuOpenActiesRefresh()" title="Vernieuw" style="width:28px;height:28px">↻</button>
      </div>
      ${body}
      ${_apptDetailModal()}
      ${_apptOutcomeModalRender()}
      ${_renderModals()}
      ${_renderToast()}
    </div>`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BROK 3 — OPVOLGING (opvolging-per-period + wake-up buttons)
  // ═══════════════════════════════════════════════════════════════════════
  const OPVOLGING_SUBS = [
    { v: 'opvolging_overdue', l: '⏰ Achterstallig' },
    { v: 'opvolging_today',   l: 'Vandaag' },
    { v: 'opvolging_week',    l: 'Deze week' },
    { v: 'opvolging_30d',     l: 'Komende 30d' },
    { v: 'opvolging_verder',  l: 'Verder' },
  ];
  function opvolgingView() {
    const st = _live.opvolging;
    if (!st.loading && (!st.data || st.key !== _ui.opvolgingSub)) queueMicrotask(fetchOpvolging);
    return `<div style="padding:14px 20px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h2 style="font-size:16px;font-weight:600;margin:0">Opvolging — geplande terugkom-momenten per afspraak</h2>
        <button class="icon-btn" onclick="window.__fuOpvolgingRefresh()" title="Vernieuw" style="width:28px;height:28px">↻</button>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap">
        ${OPVOLGING_SUBS.map((s) => {
          const on = _ui.opvolgingSub === s.v;
          return `<button class="chip ${on ? 'on' : ''}" style="padding:5px 12px;border:1px solid ${on ? 'var(--m)' : 'var(--border)'};background:${on ? 'var(--m-soft)' : 'transparent'};color:${on ? 'var(--m)' : 'var(--text-2)'};border-radius:20px;font-size:12px;font-weight:${on ? '600' : '400'};cursor:pointer" onclick="window.__fuOpvolgingSub('${s.v}')">${esc(s.l)}</button>`;
        }).join('')}
      </div>
      ${st.error && !st.data ? errBlk(st.error, 'window.__fuOpvolgingRefresh()') :
        (st.loading && !st.data) ? skel() :
        !st.data ? skel() :
        _renderAppointmentList(st.data.appointments)}
      ${_apptDetailModal()}
      ${_apptOutcomeModalRender()}
      ${_renderModals()}
      ${_renderToast()}
    </div>`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BROK 3 — AFGEBOEKT (verloren/no-show/cancelled/niet-bereikbaar + reactivate)
  // ═══════════════════════════════════════════════════════════════════════
  const AFGEBOEKT_REDENEN = [
    { v: 'all',              l: 'Alles' },
    { v: 'no_show',          l: 'No-show' },
    { v: 'cancelled',        l: 'Cancelled' },
    { v: 'verloren',         l: 'Verloren' },
    { v: 'niet_bereikbaar',  l: 'Niet bereikbaar' },
  ];
  function afgeboektView() {
    const st = _live.afgeboekt;
    if (!st.loading && (!st.data || st.key !== _ui.afgeboektReden) && !st.migrationRequired) queueMicrotask(fetchAfgeboekt);
    const body = st.migrationRequired ? migrationBanner('follow-up afgeboekt-tabel')
      : (st.error && !st.data) ? errBlk(st.error, 'window.__fuAfgeboektRefresh()')
      : (st.loading && !st.data) ? skel()
      : !st.data ? skel()
      : _renderAfgeboekt(st.data);
    return `<div style="padding:14px 20px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h2 style="font-size:16px;font-weight:600;margin:0">Afgeboekt — reden + reactivate-flow</h2>
        <button class="icon-btn" onclick="window.__fuAfgeboektRefresh()" title="Vernieuw" style="width:28px;height:28px">↻</button>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap">
        ${AFGEBOEKT_REDENEN.map((f) => {
          const on = _ui.afgeboektReden === f.v;
          const cnt = f.v === 'all' ? (st.data?.counts?.all || 0) : (st.data?.counts?.[f.v] || 0);
          return `<button class="chip ${on ? 'on' : ''}" style="padding:5px 12px;border:1px solid ${on ? 'var(--m)' : 'var(--border)'};background:${on ? 'var(--m-soft)' : 'transparent'};color:${on ? 'var(--m)' : 'var(--text-2)'};border-radius:20px;font-size:12px;font-weight:${on ? '600' : '400'};cursor:pointer" onclick="window.__fuAfgeboektReden('${f.v}')">${esc(f.l)}${cnt ? ` <span class="mono" style="font-size:10.5px;opacity:.7">${cnt}</span>` : ''}</button>`;
        }).join('')}
      </div>
      ${body}
      ${_renderModals()}
      ${_renderToast()}
    </div>`;
  }
  function _renderAfgeboekt(data) {
    const items = asArr(data.items);
    if (items.length === 0) return `<div style="padding:40px 20px;text-align:center;color:var(--text-3)">Geen afgeboekte items in deze filter.</div>`;
    return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden">
      ${items.map((it, i) => {
        const busy = _ui.afgeboektReactBusy[it.id];
        return `<div style="padding:12px 16px;display:grid;grid-template-columns:auto 1fr auto auto auto;gap:12px;align-items:center;${i < items.length - 1 ? 'border-bottom:1px solid var(--border);' : ''}">
          <span style="font-size:10.5px;padding:2px 8px;background:var(--slate-soft);color:var(--slate);border-radius:20px;font-weight:600">${esc(safeStr(it.type))}</span>
          <div style="min-width:0">
            <div style="font-size:13.5px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(safeStr(it.name) || '—')}</div>
            <div style="font-size:11.5px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(safeStr(it.email) || safeStr(it.phone) || '—')}${it.owner_name ? ` · ${esc(safeStr(it.owner_name))}` : ''}${it.source ? ` · bron: ${esc(safeStr(it.source))}` : ''}</div>
          </div>
          ${H.pill('rose', it.reden || '—')}
          <span style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-3);white-space:nowrap">${it.afgeboekt_op ? fmtDateShort(it.afgeboekt_op) : (it.scheduled_at ? fmtDateShort(it.scheduled_at) : '—')}</span>
          <button class="btn btn-primary btn-sm" ${busy ? 'disabled' : ''} onclick="window.__fuAfgeboektReactivate('${esc(it.type)}','${esc(it.id)}')">${busy ? 'Bezig…' : '↻ Reactiveer'}</button>
        </div>`;
      }).join('')}
    </div>`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BROK 3 — ARCHIEF (paginated + zoek)
  // ═══════════════════════════════════════════════════════════════════════
  function archiefView() {
    const st = _live.archief;
    const key = `${_ui.archiefQ}|${_ui.archiefPage}`;
    if (!st.loading && (!st.data || st.key !== key)) queueMicrotask(fetchArchief);
    const body = st.error && !st.data ? errBlk(st.error, 'window.__fuArchiefRefresh()')
      : (st.loading && !st.data) ? skel()
      : !st.data ? skel()
      : _renderArchief(st.data);
    return `<div style="padding:14px 20px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:12px;flex-wrap:wrap">
        <h2 style="font-size:16px;font-weight:600;margin:0">Archief — historische afspraken</h2>
        <input type="search" placeholder="Zoek op naam…" value="${esc(_ui.archiefQ)}" oninput="window.__fuArchiefSearch(this.value)" style="flex:1;max-width:280px;padding:5px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12px" />
        <button class="icon-btn" onclick="window.__fuArchiefRefresh()" title="Vernieuw" style="width:28px;height:28px">↻</button>
      </div>
      ${body}
      ${st.data && st.data.totalPages > 1 ? `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;font-size:11.5px;color:var(--text-3);font-family:'IBM Plex Mono',monospace">
        <span>Pagina ${st.data.page} van ${st.data.totalPages} · ${st.data.total} totaal</span>
        <div style="display:flex;gap:4px">
          <button class="btn btn-ghost btn-sm" ${st.data.page <= 1 ? 'disabled' : ''} onclick="window.__fuArchiefPage(-1)">Vorige</button>
          <button class="btn btn-ghost btn-sm" ${st.data.page >= st.data.totalPages ? 'disabled' : ''} onclick="window.__fuArchiefPage(1)">Volgende</button>
        </div>
      </div>` : ''}
      ${_apptDetailModal()}
      ${_renderModals()}
      ${_renderToast()}
    </div>`;
  }
  function _renderArchief(data) {
    const appts = asArr(data.appointments);
    if (appts.length === 0) return `<div style="padding:40px 20px;text-align:center;color:var(--text-3)">Geen historische afspraken${_ui.archiefQ ? ` voor "${esc(_ui.archiefQ)}"` : ''}.</div>`;
    return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden">
      ${appts.map((a, i) => `
        <div style="padding:12px 16px;display:grid;grid-template-columns:auto 1fr auto auto auto;gap:12px;align-items:center;${i < appts.length - 1 ? 'border-bottom:1px solid var(--border);' : ''}">
          <span style="font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:var(--text-3);white-space:nowrap">${fmtDate(a.scheduled_at)}</span>
          <div style="min-width:0">
            <div style="font-size:13.5px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(safeStr(a.lead_name) || '—')}</div>
            <div style="font-size:11.5px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(safeStr(a.lead_email) || safeStr(a.lead_phone) || '—')}</div>
          </div>
          ${_apptStatusPill(a.status)}
          ${a.has_outcome ? '<span style="font-size:10.5px;color:var(--emerald)">✓ uitkomst</span>' : '<span style="font-size:10.5px;color:var(--text-3)">—</span>'}
          <button class="btn btn-ghost btn-sm" onclick="window.__fuApptOpen('${esc(a.id)}')">Detail</button>
        </div>
      `).join('')}
    </div>`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BROK 2 — AFSPRAKEN (list + detail-modal + outcome-modal)
  // ═══════════════════════════════════════════════════════════════════════
  const APPT_PERIODS = [
    { v: 'today',              l: 'Vandaag' },
    { v: 'morgen',             l: 'Morgen' },
    { v: 'week',               l: 'Deze week' },
    { v: 'past_week',          l: 'Voorbije week' },
    { v: 'wacht_op_reschedule',l: 'Wacht op reschedule' },
    { v: 'recent_completed',   l: 'Recent afgerond' },
    { v: 'open_acties',        l: 'Open acties' },
  ];
  const APPT_STATUS_META = {
    scheduled:              { c: 'blue',    l: 'Ingepland' },
    in_progress:            { c: 'violet',  l: 'Bezig' },
    completed:              { c: 'emerald', l: 'Afgerond' },
    no_show:                { c: 'rose',    l: 'No-show' },
    cancelled:              { c: 'slate',   l: 'Geannuleerd' },
    verplaatst:             { c: 'amber',   l: 'Verplaatst' },
    wacht_op_reschedule:    { c: 'amber',   l: 'Wacht reschedule' },
    verwijderd:             { c: 'slate',   l: 'Verwijderd' },
  };
  function _apptStatusPill(s) {
    const m = APPT_STATUS_META[s] || { c: 'neutral', l: s || '—' };
    return H.pill(m.c, m.l);
  }
  function afsprakenView() {
    const st = _live.appts;
    if (!st.loading && (!st.data || st.key !== _ui.apptPeriod)) queueMicrotask(fetchAppointments);
    return `<div style="padding:14px 20px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:10px">
        <h2 style="font-size:16px;font-weight:600;margin:0">Afspraken</h2>
        <button class="icon-btn" onclick="window.__fuRefresh()" title="Vernieuw" style="width:28px;height:28px">↻</button>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap">
        ${APPT_PERIODS.map((p) => {
          const on = _ui.apptPeriod === p.v;
          return `<button class="chip ${on ? 'on' : ''}" style="padding:5px 12px;border:1px solid ${on ? 'var(--m)' : 'var(--border)'};background:${on ? 'var(--m-soft)' : 'transparent'};color:${on ? 'var(--m)' : 'var(--text-2)'};border-radius:20px;font-size:12px;font-weight:${on ? '600' : '400'};cursor:pointer" onclick="window.__fuApptPeriod('${p.v}')">${esc(p.l)}</button>`;
        }).join('')}
      </div>
      ${st.error && !st.data ? errBlk(st.error, 'window.__fuRefresh()') :
        st.loading && !st.data ? skel() :
        !st.data ? skel() :
        _renderAppointmentList(st.data.appointments)}
      ${_apptDetailModal()}
      ${_apptOutcomeModalRender()}
      ${_renderModals()}
      ${_renderToast()}
    </div>`;
  }
  function _renderAppointmentList(appts) {
    if (!appts || appts.length === 0) return `<div style="padding:40px 20px;text-align:center;color:var(--text-3)">Geen afspraken in deze weergave.</div>`;
    return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden">
      ${appts.map((a, i) => `
        <div style="padding:12px 16px;display:grid;grid-template-columns:auto 1fr auto auto auto;gap:12px;align-items:center;${i < appts.length - 1 ? 'border-bottom:1px solid var(--border);' : ''}">
          <span style="font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:var(--text-3);white-space:nowrap">${fmtDate(a.scheduled_at)}</span>
          <div style="min-width:0">
            <div style="font-size:13.5px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(safeStr(a.lead_name) || '—')}</div>
            <div style="font-size:11.5px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(safeStr(a.lead_email) || safeStr(a.lead_phone) || '—')}${a.duration_minutes ? ` · ${a.duration_minutes} min` : ''}</div>
          </div>
          ${_apptStatusPill(a.status)}
          ${a.zoom_join_url ? `<a href="${esc(a.zoom_join_url)}" target="_blank" rel="noopener" class="btn btn-ghost btn-sm">Zoom →</a>` : `<span></span>`}
          <div style="display:flex;gap:4px">
            <button class="btn btn-ghost btn-sm" onclick="window.__fuApptOpen('${esc(a.id)}')">Detail</button>
            <button class="btn btn-primary btn-sm" onclick="window.__fuApptOutcomeOpen('${esc(a.id)}')">Uitkomst</button>
          </div>
        </div>
      `).join('')}
    </div>`;
  }
  function _apptDetailModal() {
    const id = _ui.apptDetailId;
    if (!id) return '';
    if (!_live.apptDetail.data[id] && !_live.apptDetail.loading[id]) queueMicrotask(() => fetchAppointmentDetail(id));
    const d = _live.apptDetail.data[id];
    const err = _live.apptDetail.error[id];
    const body = err ? errBlk(err) : !d ? skel() : `
      <div style="display:flex;flex-direction:column;gap:14px">
        ${d.appointment ? `<div style="padding:12px 14px;background:var(--surface-2);border-radius:8px">
          <div style="font-size:13px;font-weight:600;margin-bottom:6px">${esc(safeStr(d.appointment.lead_name) || '—')}</div>
          <div style="font-size:12px;color:var(--text-3);display:grid;grid-template-columns:1fr 1fr;gap:4px 16px">
            <div><b>Wanneer:</b> ${fmtDate(d.appointment.scheduled_at)}</div>
            <div><b>Status:</b> ${_apptStatusPill(d.appointment.status)}</div>
            <div><b>E-mail:</b> ${esc(safeStr(d.appointment.lead_email) || '—')}</div>
            <div><b>Telefoon:</b> ${esc(safeStr(d.appointment.lead_phone) || '—')}</div>
            <div><b>Duur:</b> ${d.appointment.duration_minutes || 30} min</div>
            <div><b>Voicememo:</b> ${esc(d.appointment.voicememo_status || '—')}</div>
          </div>
        </div>` : ''}
        ${d.appointment?.snelle_notitie ? `<div style="padding:10px 12px;background:var(--amber-soft);border-radius:6px;font-size:12.5px;line-height:1.5"><b>Snelle notitie:</b> ${esc(d.appointment.snelle_notitie)}</div>` : ''}
        <div style="padding:12px 14px;background:var(--surface-2);border-radius:8px">
          <div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Klant-context</div>
          ${d.customer_context ? `<div style="font-size:12px;display:grid;grid-template-columns:1fr 1fr;gap:4px 16px">
            <div style="word-break:break-word"><b>Naam:</b> ${esc(safeStr(d.customer_context.name) || '—')}</div>
            <div style="word-break:break-word"><b>Mentor:</b> ${esc(safeStr(d.customer_context.mentor_name) || '—')}</div>
            <div style="word-break:break-word"><b>E-mail:</b> ${esc(safeStr(d.customer_context.email) || '—')}</div>
            <div style="word-break:break-word"><b>Bedrijf:</b> ${esc(safeStr(d.customer_context.company_name) || '—')}</div>
            <div><b>Verlengt niet:</b> ${d.customer_context.retention_not_renewing ? 'ja' : 'nee'}</div>
          </div>` : `<div style="font-size:12px;color:var(--text-3);font-style:italic">Nog geen klant gekoppeld aan deze afspraak.</div>`}
        </div>
        ${d.outcome ? `<div style="padding:12px 14px;background:var(--emerald-soft);border-radius:8px;font-size:12.5px">
          <b>Uitkomst geregistreerd:</b> ${esc(safeStr(d.outcome.outcome) || '—')} · ${fmtDate(d.outcome.created_at)}
        </div>` : ''}
        <div>
          <div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Lead-historie${Array.isArray(d.lead_history) ? ` (${d.lead_history.length})` : ''}</div>
          ${Array.isArray(d.lead_history) && d.lead_history.length > 0 ? `<div style="display:flex;flex-direction:column;gap:4px;max-height:220px;overflow-y:auto">
            ${d.lead_history.map((h) => `<div style="padding:6px 10px;background:var(--surface-2);border-radius:4px;font-size:12px;display:flex;justify-content:space-between;gap:8px;align-items:center"><span class="mono" style="color:var(--text-2)">${fmtDate(h.scheduled_at)}</span>${_apptStatusPill(h.status)}<span style="color:var(--text-3);font-size:11px">${esc(safeStr(h.voicememo_status) || '')}</span></div>`).join('')}
          </div>` : `<div style="font-size:12px;color:var(--text-3);font-style:italic;padding:6px 0">Dit is de eerste afspraak van deze lead.</div>`}
        </div>
        ${d.appointment?.lead_ghl_contact_id ? `<div>
          <div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center">
            <span>Messages (GHL contact)</span>
            <button class="btn btn-ghost btn-sm" onclick="window.__fuLoadMessages('${esc(d.appointment.lead_ghl_contact_id)}')">Laad</button>
          </div>
          ${_renderMessagesBlock(d.appointment.lead_ghl_contact_id)}
        </div>` : ''}
        <div style="display:flex;justify-content:space-between;gap:8px;padding-top:12px;border-top:1px solid var(--border)">
          <button class="btn btn-ghost btn-sm" style="color:var(--rose)" onclick="window.__fuDeleteApptOpen('${esc(id)}')">🗑 Verwijderen</button>
          <div style="display:flex;gap:8px">
            <button class="btn btn-ghost" onclick="window.__fuApptClose()">Sluiten</button>
            <button class="btn btn-primary" onclick="window.__fuApptClose();window.__fuApptOutcomeOpen('${esc(id)}')">Uitkomst registreren →</button>
          </div>
        </div>
      </div>`;
    return _modalShell('Afspraak-detail', body, 'window.__fuApptClose()');
  }
  window.__fuLoadMessages = (contactId) => { if (contactId) fetchMessages(contactId); };
  function _renderMessagesBlock(contactId) {
    const st = _live.messages;
    if (st.loading[contactId]) return skel();
    if (st.error[contactId]) return errBlk(st.error[contactId]);
    const msgs = st.data[contactId];
    if (msgs === undefined) return `<div style="font-size:11.5px;color:var(--text-3);font-style:italic;padding:6px 0">Klik "Laad" om berichten op te halen.</div>`;
    if (!msgs || msgs.length === 0) return `<div style="font-size:11.5px;color:var(--text-3);font-style:italic;padding:6px 0">Geen berichten in de laatste 90 dagen.</div>`;
    return `<div style="max-height:240px;overflow-y:auto;display:flex;flex-direction:column;gap:4px">${msgs.slice(0, 30).map((m) => `
      <div style="padding:6px 10px;background:${m.direction === 'inbound' ? 'var(--surface-2)' : 'var(--m-soft, rgba(59,130,246,.10))'};border-radius:6px;font-size:11.5px">
        <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:2px;color:var(--text-3);font-size:10.5px"><span>${esc(safeStr(m.direction))} · ${esc(safeStr(m.channel))}</span><span>${fmtDate(m.sent_at)}</span></div>
        <div style="color:var(--text);white-space:pre-wrap;word-break:break-word">${esc(safeStr(m.body).slice(0, 500))}</div>
      </div>`).join('')}</div>`;
  }

  // Verwijder-modal (klant-risk: GHL cancel + Zoom delete)
  function _deleteApptModal() {
    const m = _ui.deleteApptModal; if (!m) return '';
    const body = `
      <div style="padding:12px 14px;background:var(--rose-soft);border:1px solid var(--rose);color:var(--rose);border-radius:6px;font-size:12px;margin-bottom:14px;line-height:1.6">
        <div style="font-weight:600;margin-bottom:4px">⚠ Klant-risk!</div>
        Deze actie:
        <ul style="margin:4px 0 0 20px;padding:0">
          <li>Soft-delete in DB (status='verwijderd').</li>
          <li>Cancelt de GHL-afspraak — <b>de klant krijgt automatisch een GHL-cancellation-mail</b>.</li>
          <li>Delete de Zoom-meeting (link ongeldig).</li>
        </ul>
        Onomkeerbaar. Geen dry-run beschikbaar in de backend.
      </div>
      <label style="display:block;margin-bottom:14px"><span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Reden (optioneel — wordt aan snelle-notitie toegevoegd)</span>
        <textarea oninput="window.__fuDeleteApptField('reden', this.value)" style="display:block;width:100%;margin-top:4px;padding:8px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:12.5px;font-family:inherit;min-height:60px;resize:vertical">${esc(m.reden)}</textarea>
      </label>
      ${m.error ? `<div style="padding:8px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px;margin-bottom:12px">${esc(m.error)}</div>` : ''}
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-ghost" onclick="window.__fuDeleteApptClose()">Annuleren</button>
        <button class="btn btn-primary" ${m.saving ? 'disabled' : ''} style="background:var(--rose);border-color:var(--rose)" onclick="window.__fuDeleteApptSave()">${m.saving ? 'Verwijderen…' : '🗑 Bevestig verwijderen'}</button>
      </div>`;
    return _modalShell('Afspraak verwijderen — klant-risk', body, 'window.__fuDeleteApptClose()');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BROK 5 — VOICEMEMO-RONDE (dagoverzicht + mark-as-sent)
  // ═══════════════════════════════════════════════════════════════════════
  function voicememoView() {
    const st = _live.voicememo;
    if (!st.loading && !st.data) queueMicrotask(fetchVoicememo);
    return `<div style="padding:14px 20px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:10px">
        <div>
          <h2 style="font-size:16px;font-weight:600;margin:0">Voicememo-ronde ${st.data?.today ? `· ${fmtDateShort(st.data.today)}` : ''}</h2>
          <div style="font-size:11.5px;color:var(--text-3);margin-top:2px">Vandaag-Zooms — noteer per lead wanneer je een voicememo hebt verstuurd</div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost btn-sm" onclick="window.__fuVoicememoMarkAll()" ${_ui.voicememoAllBusy ? 'disabled' : ''}>${_ui.voicememoAllBusy ? 'Bezig…' : '✓ Markeer allen'}</button>
          <button class="icon-btn" onclick="window.__fuVoicememoRefresh()" title="Vernieuw" style="width:28px;height:28px">↻</button>
        </div>
      </div>
      <div style="padding:10px 14px;background:var(--surface-2);border-radius:8px;font-size:11.5px;color:var(--text-3);margin-bottom:14px;line-height:1.5">
        <b>Geen klant-verzending vanuit deze knop.</b> Voicememo neem je zelf op in WhatsApp; deze markering logt alleen dat het gedaan is.
      </div>
      ${st.data ? `<div style="display:flex;gap:12px;margin-bottom:14px;flex-wrap:wrap">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 14px;min-width:120px"><div style="font-size:10.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Totaal</div><div style="font-size:20px;font-weight:600;font-family:'IBM Plex Mono',monospace">${st.data.counts?.total || 0}</div></div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 14px;min-width:120px"><div style="font-size:10.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Verzonden</div><div style="font-size:20px;font-weight:600;color:var(--emerald);font-family:'IBM Plex Mono',monospace">${st.data.counts?.sent || 0}</div></div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:10px 14px;min-width:120px"><div style="font-size:10.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Open</div><div style="font-size:20px;font-weight:600;color:var(--amber);font-family:'IBM Plex Mono',monospace">${st.data.counts?.open || 0}</div></div>
      </div>` : ''}
      ${st.error && !st.data ? errBlk(st.error, 'window.__fuVoicememoRefresh()') :
        (st.loading && !st.data) ? skel() :
        !st.data ? skel() :
        _renderVoicememoList(st.data.leads)}
      ${_renderModals()}
      ${_renderToast()}
    </div>`;
  }
  function _renderVoicememoList(leads) {
    if (!leads || leads.length === 0) return `<div style="padding:40px 20px;text-align:center;color:var(--text-3)">🎉 Geen open voicememos vandaag.</div>`;
    return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden">
      ${leads.map((l, i) => {
        const busy = _ui.voicememoBusy[l.id];
        const sent = l.voicememo_status === 'sent';
        return `<div style="padding:12px 16px;display:grid;grid-template-columns:1fr auto auto auto;gap:12px;align-items:center;${i < leads.length - 1 ? 'border-bottom:1px solid var(--border);' : ''}">
          <div style="min-width:0">
            <div style="font-size:13.5px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(safeStr(l.lead_name) || '—')}</div>
            <div style="font-size:11.5px;color:var(--text-3)">${esc(safeStr(l.lead_phone) || '—')}${l.terugbel_datum ? ` · ${fmtDate(l.terugbel_datum, { hour:'2-digit', minute:'2-digit' })}` : ''}</div>
          </div>
          ${sent ? H.pill('emerald', 'Verzonden') : H.pill('amber', 'Open')}
          ${l.voicememo_sent_on ? `<span style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-3);white-space:nowrap">${fmtDateShort(l.voicememo_sent_on)}</span>` : '<span></span>'}
          ${sent ? '<span style="width:120px;text-align:right;color:var(--emerald);font-size:12px">✓</span>' : `<button class="btn btn-primary btn-sm" ${busy ? 'disabled' : ''} onclick="window.__fuVoicememoMark('${esc(l.id)}')">${busy ? '…' : '✓ Verzonden'}</button>`}
        </div>`;
      }).join('')}
    </div>`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BROK 5 — ADMIN (super_admin: backfill-contacts + ghl-status-backfill)
  // ═══════════════════════════════════════════════════════════════════════
  function adminView() {
    return `<div style="padding:14px 20px;max-width:900px">
      <div style="margin-bottom:12px">
        <h2 style="font-size:16px;font-weight:600;margin:0">Admin — beheer & backfill-tools</h2>
        <div style="font-size:11.5px;color:var(--text-3);margin-top:2px">Alleen super-admin. Andere rollen krijgen 403.</div>
      </div>
      ${_adminBackfillContactsCard()}
      ${_adminGhlBackfillCard()}
      ${_adminReportenCard()}
      ${_adminCronsCard()}
      ${_renderModals()}
      ${_renderToast()}
    </div>`;
  }
  function _adminBackfillContactsCard() {
    const busy = _ui.adminBackfillBusy;
    const d = _live.adminBackfillContacts.data;
    const err = _live.adminBackfillContacts.error;
    return `<div class="card" style="margin-bottom:14px;background:var(--surface);border:1px solid var(--border);border-radius:10px">
      <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:13px;font-weight:600">Backfill GHL-contacts</div>
          <div style="font-size:11.5px;color:var(--text-3);margin-top:2px">Trekt email/telefoon bij van GHL voor appointments met ontbrekende contact-info.</div>
        </div>
        <button class="btn btn-primary btn-sm" ${busy ? 'disabled' : ''} onclick="window.__fuAdminBackfillContacts()">${busy ? 'Bezig…' : 'Start backfill'}</button>
      </div>
      ${d ? `<div style="padding:10px 16px;font-size:12px;color:var(--text-2)">Resultaat: <span class="mono">${d.updated}</span>/<span class="mono">${d.totaal}</span> bijgewerkt · <span class="mono">${d.skipped}</span> geskipped · <span class="mono" style="color:var(--rose)">${d.errors}</span> fouten.</div>` : ''}
      ${err ? `<div style="padding:10px 16px;font-size:12px;color:var(--rose)">Fout: ${esc(err)}</div>` : ''}
    </div>`;
  }
  function _adminGhlBackfillCard() {
    const busy = _ui.adminGhlBackfillBusy;
    const d = _live.adminGhlBackfill.data;
    const err = _live.adminGhlBackfill.error;
    const mode = _live.adminGhlBackfill.mode;
    return `<div class="card" style="margin-bottom:14px;background:var(--surface);border:1px solid var(--rose-line, #f5b4bc);border-radius:10px">
      <div style="padding:12px 16px;background:var(--rose-soft);border-bottom:1px solid var(--rose-line, #f5b4bc);display:flex;justify-content:space-between;align-items:center">
        <div>
          <div style="font-size:13px;font-weight:600;color:var(--rose)">⚠ GHL-status-backfill (klant-CRM-mutatie)</div>
          <div style="font-size:11.5px;color:var(--rose);margin-top:2px">Zet historische appointments in GHL op status "showed". Muteert live CRM-data. Two-step: dry-run → confirm → execute.</div>
        </div>
      </div>
      <div style="padding:12px 16px">
        <div style="display:flex;gap:8px;margin-bottom:10px">
          <button class="btn btn-ghost btn-sm" ${busy ? 'disabled' : ''} onclick="window.__fuAdminGhlBackfillDry()">${busy && mode === 'dry_run' ? 'Bezig…' : '🔍 Dry-run (mode=strict, limit=50)'}</button>
        </div>
        ${d && mode === 'dry_run' ? `<div style="padding:10px 12px;background:var(--surface-2);border-radius:6px;font-size:12px;margin-bottom:10px">
          <b>Dry-run resultaat:</b> ${d.total_candidates || 0} totaal kandidaten · toont eerste ${d.returned || 0} · limit ${d.limit || 50}${d.skipped_over_limit ? ` · ${d.skipped_over_limit} overgeslagen boven limit` : ''}<br>
          ${d.note ? `<div style="margin-top:6px;font-style:italic">${esc(d.note)}</div>` : ''}
        </div>` : ''}
        ${d && mode === 'dry_run' ? `<div style="border-top:1px solid var(--border);padding-top:10px">
          <div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Execute (na dry-run review)</div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <input type="text" placeholder='Typ "IK BEGRIJP HET"' value="${esc(_ui.adminGhlBackfillConfirm)}" oninput="window.__fuAdminGhlBackfillExecuteConfirm(this.value)" style="flex:1;min-width:220px;padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12.5px" />
            <button class="btn btn-primary btn-sm" ${busy || _ui.adminGhlBackfillConfirm !== 'IK BEGRIJP HET' ? 'disabled' : ''} style="background:var(--rose);border-color:var(--rose)" onclick="window.__fuAdminGhlBackfillExecute()">${busy && mode === 'executed' ? 'Executing…' : '🚨 EXECUTE'}</button>
          </div>
        </div>` : ''}
        ${d && mode === 'executed' ? `<div style="padding:10px 12px;background:var(--emerald-soft);color:var(--emerald);border-radius:6px;font-size:12px;margin-top:10px">
          <b>Executed:</b> ${d.succeeded || 0}/${d.processed || 0} bijgewerkt${d.failed ? ` · ${d.failed} fouten` : ''}.
        </div>` : ''}
        ${err ? `<div style="padding:10px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px;margin-top:10px">${esc(err)}</div>` : ''}
      </div>
    </div>`;
  }
  function _adminReportenCard() {
    return `<div class="card" style="margin-bottom:14px;background:var(--surface);border:1px solid var(--border);border-radius:10px">
      <div style="padding:12px 16px">
        <div style="font-size:13px;font-weight:600;margin-bottom:6px">📧 Admin-rapporten (cron)</div>
        <div style="font-size:12px;color:var(--text-2);line-height:1.6">
          <b>follow-up-admin-daily</b> — verstuurt dagelijks 21:00 NL naar admins/managers via e-mail. Dedup per dag+recipient.<br>
          <b>follow-up-admin-weekly</b> — verstuurt zondag 10:00 NL. Dedup per week.<br>
          <span style="color:var(--text-3);font-size:11.5px">Beide draaien server-side (cron). Ontvangers: alle super_admin + manager. Interne mail — geen klant-verzending.</span>
        </div>
      </div>
    </div>`;
  }
  function _adminCronsCard() {
    return `<div class="card" style="background:var(--surface);border:1px solid var(--border);border-radius:10px">
      <div style="padding:12px 16px">
        <div style="font-size:13px;font-weight:600;margin-bottom:6px">🔄 GHL-integratie (server-side)</div>
        <div style="font-size:12px;color:var(--text-2);line-height:1.6">
          <b>follow-up-ghl-appointment-poll</b> — cron elke 15 min. Sync GHL-appointments naar DB. Ghost-detectie.<br>
          <b>follow-up-ghl-conversations-poll</b> — cron elke 15 min. Safety-net voor conversations-webhook.<br>
          <b>follow-up-ghl-conversation-webhook</b> — inkomend van GHL bij nieuwe messages.<br>
          <span style="color:var(--text-3);font-size:11.5px">Alle drie draaien automatisch. Geen UI-actie nodig — check via server-logs.</span>
        </div>
      </div>
    </div>`;
  }
  const APPT_OUTCOMES = [
    { v: 'gesprek_gehad',  l: 'Gesprek gehad',  c: 'emerald' },
    { v: 'sale',           l: '✅ Verkocht',    c: 'emerald' },
    { v: 'wilt_niet_meer', l: 'Wil niet meer',  c: 'rose' },
    { v: 'niet_geschikt',  l: 'Niet geschikt',  c: 'rose' },
    { v: 'no_show',        l: 'No-show',        c: 'rose' },
    { v: 'later_opnieuw',  l: '💤 Later opnieuw', c: 'blue' },
    { v: 'terugbel',       l: 'Terugbellen',    c: 'amber' },
    { v: 'verzetten',      l: '↔ Verplaatsen',  c: 'amber' },
    { v: 'annuleren',      l: '✕ Annuleren',    c: 'rose' },
  ];
  // Per-uitkomst gevolg-tekst (getoond zowel in modal-body ALS in confirm).
  const APPT_OUTCOME_RISK = {
    gesprek_gehad: 'Afspraak → completed · GHL → showed · Zoom-link wordt VERWIJDERD.',
    sale:          'Afspraak → completed · GHL → showed · Zoom-link wordt VERWIJDERD.',
    wilt_niet_meer:'Afspraak → cancelled · GHL → showed · Zoom-link wordt VERWIJDERD (call is al gebeurd).',
    niet_geschikt: 'Afspraak → cancelled · GHL → showed · Zoom-link wordt VERWIJDERD.',
    no_show:       'Afspraak → no_show · GHL → noshow · NIEUWE follow-up-lead met terugbel +2u.',
    later_opnieuw: 'Afspraak → completed · GHL → showed · NIEUWE snoozed lead voor N maanden.',
    terugbel:      'Afspraak → completed · GHL → showed · NIEUWE lead met terugbel-datum + kind.',
    verzetten:     'Gedelegeerd naar verplaats-call · GHL-agenda wordt bijgewerkt (blocking) · ONOMKEERBAAR (geen undo).',
    annuleren:     'Gedelegeerd naar annuleer · GHL wordt bijgewerkt (blocking) · Zoom-link wordt NIET verwijderd · ONOMKEERBAAR.',
  };
  function _apptOutcomeModalRender() {
    const m = _ui.apptOutcomeModal;
    if (!m) return '';
    const meta = APPT_OUTCOMES.find((o) => o.v === m.outcome);
    const riskText = m.outcome ? APPT_OUTCOME_RISK[m.outcome] : null;
    const body = `
      ${riskText ? `<div style="padding:10px 12px;background:var(--amber-soft);border:1px solid var(--amber);color:var(--amber);border-radius:6px;font-size:12px;margin-bottom:14px;line-height:1.5"><b>Gevolg van "${esc(meta ? meta.l : m.outcome)}":</b><br>${esc(riskText)}</div>` : ''}
      <div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Uitkomst</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px;margin-bottom:14px">
        ${APPT_OUTCOMES.map((o) => {
          const on = m.outcome === o.v;
          return `<button style="padding:8px 10px;border:1px solid ${on ? `var(--${o.c})` : 'var(--border)'};background:${on ? `var(--${o.c}-soft)` : 'transparent'};color:${on ? `var(--${o.c})` : 'var(--text-2)'};border-radius:6px;font-size:12px;font-weight:${on ? '600' : '400'};cursor:pointer;text-align:left" onclick="window.__fuApptOutcomeSet('${o.v}')">${esc(o.l)}</button>`;
        }).join('')}
      </div>
      ${m.outcome === 'terugbel' ? `
        <label style="display:block;margin-bottom:14px"><span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Terugbel datum & tijd</span>
          <input type="datetime-local" value="${esc(m.terugbelDatum)}" oninput="window.__fuApptOutcomeField('terugbelDatum', this.value)" style="display:block;margin-top:4px;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px" />
        </label>
        <label style="display:block;margin-bottom:14px"><span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Kind</span>
          <select onchange="window.__fuApptOutcomeField('leadKind', this.value)" style="display:block;margin-top:4px;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px">
            <option value="bel" ${m.leadKind === 'bel' ? 'selected' : ''}>Call</option>
            <option value="zoom" ${m.leadKind === 'zoom' ? 'selected' : ''}>Zoom</option>
          </select>
        </label>` : ''}
      ${m.outcome === 'later_opnieuw' ? `
        <label style="display:block;margin-bottom:14px"><span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Snooze duur (maanden)</span>
          <input type="number" min="1" max="24" step="1" value="${esc(m.snoozeMonths)}" oninput="window.__fuApptOutcomeField('snoozeMonths', Number(this.value))" style="display:block;margin-top:4px;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px" />
        </label>` : ''}
      ${m.outcome === 'verzetten' ? `
        ${_renderFreeSlotsPicker()}
        <label style="display:block;margin-bottom:8px"><span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Nieuwe datum & tijd</span>
          <input type="datetime-local" data-fu-appt-datetime value="${esc(m.newDatetime)}" oninput="window.__fuApptOutcomeField('newDatetime', this.value)" style="display:block;margin-top:4px;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px" />
        </label>
        <label style="display:block;margin-bottom:14px"><span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Duur (min)</span>
          <input type="number" min="10" max="180" step="15" value="${esc(m.duration)}" oninput="window.__fuApptOutcomeField('duration', Number(this.value))" style="display:block;margin-top:4px;padding:6px 8px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:13px" />
        </label>` : ''}
      ${m.outcome === 'annuleren' ? `
        <label style="display:block;margin-bottom:14px"><span style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em">Reden</span>
          <textarea oninput="window.__fuApptOutcomeField('reden', this.value)" style="display:block;width:100%;margin-top:4px;padding:8px 10px;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);font-size:12.5px;font-family:inherit;min-height:60px;resize:vertical">${esc(m.reden)}</textarea>
        </label>` : ''}
      ${m.error ? `<div style="padding:8px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px;margin-bottom:12px">${esc(m.error)}</div>` : ''}
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-ghost" onclick="window.__fuApptOutcomeClose()">Annuleren</button>
        <button class="btn btn-primary" ${(!m.outcome || m.saving) ? 'disabled' : ''} onclick="window.__fuApptOutcomeSave()">${m.saving ? 'Opslaan…' : 'Opslaan'}</button>
      </div>`;
    return _modalShell('Afspraak-uitkomst registreren', body, 'window.__fuApptOutcomeClose()');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BROK 2 — KALENDER (chronologische day-grouped agenda voor komende afspraken)
  // ═══════════════════════════════════════════════════════════════════════
  function kalenderView() {
    const st = _live.kalender;
    if (!st.loading && !st.data) queueMicrotask(fetchKalender);
    const body = st.error && !st.data ? errBlk(st.error, 'window.__fuKalenderRefresh()')
      : (st.loading && !st.data) ? skel()
      : !st.data ? skel()
      : _renderKalenderAgenda(st.data.appointments);
    return `<div style="padding:14px 20px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h2 style="font-size:16px;font-weight:600;margin:0">Kalender — komende afspraken</h2>
        <button class="icon-btn" onclick="window.__fuKalenderRefresh()" title="Vernieuw" style="width:28px;height:28px">↻</button>
      </div>
      ${body}
      ${_apptDetailModal()}
      ${_apptOutcomeModalRender()}
      ${_renderModals()}
      ${_renderToast()}
    </div>`;
  }
  function _renderKalenderAgenda(appts) {
    if (!appts || appts.length === 0) return `<div style="padding:40px 20px;text-align:center;color:var(--text-3)">Geen afspraken gepland.</div>`;
    // Group by day (YYYY-MM-DD)
    const groups = {};
    for (const a of appts) {
      const d = a.scheduled_at ? new Date(a.scheduled_at) : null;
      if (!d || !Number.isFinite(d.getTime())) continue;
      const key = d.toISOString().slice(0, 10);
      (groups[key] = groups[key] || []).push(a);
    }
    const dayKeys = Object.keys(groups).sort();
    return dayKeys.map((k) => {
      const day = new Date(k);
      const dayLabel = day.toLocaleDateString('nl-NL', { weekday: 'long', day: '2-digit', month: 'long' });
      return `<div style="margin-bottom:18px">
        <div style="font-size:12px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">${esc(dayLabel)}</div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden">
          ${groups[k].map((a, i) => `
            <div style="padding:10px 14px;display:grid;grid-template-columns:auto 1fr auto auto;gap:12px;align-items:center;${i < groups[k].length - 1 ? 'border-bottom:1px solid var(--border);' : ''}">
              <span style="font-family:'IBM Plex Mono',monospace;font-size:12.5px;font-weight:600;color:var(--m);white-space:nowrap">${fmtDate(a.scheduled_at, { hour:'2-digit', minute:'2-digit' })}</span>
              <div style="min-width:0">
                <div style="font-size:13px;font-weight:500;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(safeStr(a.lead_name) || '—')}</div>
                <div style="font-size:11px;color:var(--text-3)">${esc(safeStr(a.lead_email) || safeStr(a.lead_phone) || '—')}</div>
              </div>
              ${_apptStatusPill(a.status)}
              <button class="btn btn-ghost btn-sm" onclick="window.__fuApptOpen('${esc(a.id)}')">Detail</button>
            </div>
          `).join('')}
        </div>
      </div>`;
    }).join('');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BROK 2 — RETENTIES (oude-retenties met pickup-flow)
  // ═══════════════════════════════════════════════════════════════════════
  const RETENTIE_FILTERS = [
    { v: 'all',         l: 'Alles' },
    { v: 'nieuw',       l: 'Nieuw' },
    { v: 'opgepakt',    l: 'Opgepakt' },
    { v: 'afgehandeld', l: 'Afgehandeld' },
  ];
  function retentiesView() {
    const st = _live.retenties;
    if (!st.loading && (!st.data || st.key !== _ui.retentieReden) && !st.migrationRequired) queueMicrotask(fetchRetenties);
    const body = st.migrationRequired ? migrationBanner('follow_up_leads-tabel')
      : (st.error && !st.data) ? errBlk(st.error, 'window.__fuRefresh()')
      : (st.loading && !st.data) ? skel()
      : !st.data ? skel()
      : _renderRetenties(st.data);
    return `<div style="padding:14px 20px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h2 style="font-size:16px;font-weight:600;margin:0">Retenties — oude klanten die opgepakt kunnen worden</h2>
        <button class="icon-btn" onclick="window.__fuRefresh()" title="Vernieuw" style="width:28px;height:28px">↻</button>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap">
        ${RETENTIE_FILTERS.map((f) => {
          const on = _ui.retentieReden === f.v;
          const cnt = f.v === 'all' ? (st.data?.counts?.totaal || 0) : (st.data?.counts?.[f.v] || 0);
          return `<button class="chip ${on ? 'on' : ''}" style="padding:5px 12px;border:1px solid ${on ? 'var(--m)' : 'var(--border)'};background:${on ? 'var(--m-soft)' : 'transparent'};color:${on ? 'var(--m)' : 'var(--text-2)'};border-radius:20px;font-size:12px;font-weight:${on ? '600' : '400'};cursor:pointer" onclick="window.__fuRetentieReden('${f.v}')">${esc(f.l)}${cnt ? ` <span class="mono" style="font-size:10.5px;opacity:.7">${cnt}</span>` : ''}</button>`;
        }).join('')}
      </div>
      ${body}
      ${_renderModals()}
      ${_renderToast()}
    </div>`;
  }
  function _renderRetenties(data) {
    const items = asArr(data.items);
    if (items.length === 0) return `<div style="padding:40px 20px;text-align:center;color:var(--text-3)">Geen retentie-kandidaten in deze filter.</div>`;
    return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden">
      ${items.map((it, i) => {
        const busy = _ui.retentiePickBusy[it.customer_id];
        const pickup = String(it.pickup_status || 'nieuw');
        const pickupColor = pickup === 'nieuw' ? 'blue' : pickup === 'opgepakt' ? 'amber' : 'emerald';
        return `<div style="padding:12px 16px;display:grid;grid-template-columns:1fr auto auto auto;gap:12px;align-items:center;${i < items.length - 1 ? 'border-bottom:1px solid var(--border);' : ''}">
          <div style="min-width:0">
            <div style="font-size:13.5px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(safeStr(it.name) || '—')}</div>
            <div style="font-size:11.5px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(safeStr(it.email) || safeStr(it.phone) || '—')}${it.mentor_name ? ` · mentor: ${esc(safeStr(it.mentor_name))}` : ''}${it.last_sub_status ? ` · abo: ${esc(safeStr(it.last_sub_status))}` : ''}</div>
          </div>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-3);white-space:nowrap">${it.end_date ? `Eind ${fmtDateShort(it.end_date)}` : '—'}</span>
          ${H.pill(pickupColor, pickup)}
          ${pickup === 'nieuw'
            ? `<button class="btn btn-primary btn-sm" ${busy ? 'disabled' : ''} onclick="window.__fuRetentiePickup('${esc(it.customer_id)}','${esc(it.end_date || '')}','${esc(safeStr(it.last_sub_status))}')">${busy ? 'Bezig…' : 'Oppakken'}</button>`
            : it.lead_id
              ? `<button class="btn btn-ghost btn-sm" onclick="window.__fuJumpToLead('${esc(it.lead_id)}')">Open lead →</button>`
              : `<span style="font-size:11px;color:var(--text-3);font-style:italic">geen lead</span>`}
        </div>`;
      }).join('')}
    </div>`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BROK 2 — SLUIMERPOT (gesluimerde leads + wake-up)
  // ═══════════════════════════════════════════════════════════════════════
  function sluimerpotView() {
    const st = _live.sluimerpot;
    if (!st.loading && !st.data) queueMicrotask(fetchSluimerpot);
    const body = st.error && !st.data ? errBlk(st.error, 'window.__fuSluimerRefresh()')
      : (st.loading && !st.data) ? skel()
      : !st.data ? skel()
      : _renderSluimerpot(st.data);
    return `<div style="padding:14px 20px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h2 style="font-size:16px;font-weight:600;margin:0">Sluimerpot — gesnoozde leads</h2>
        <button class="icon-btn" onclick="window.__fuSluimerRefresh()" title="Vernieuw" style="width:28px;height:28px">↻</button>
      </div>
      ${body}
      ${_renderModals()}
      ${_renderToast()}
    </div>`;
  }
  function _renderSluimerpot(data) {
    const leads = asArr(data.leads);
    if (leads.length === 0) return `<div style="padding:40px 20px;text-align:center;color:var(--text-3)">🎉 Sluimerpot is leeg — geen gesnoozde leads.</div>`;
    return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;overflow:hidden">
      ${leads.map((l, i) => {
        const busy = _ui.sluimerBusy[l.id];
        return `<div style="padding:12px 16px;display:grid;grid-template-columns:1fr auto auto auto;gap:12px;align-items:center;${i < leads.length - 1 ? 'border-bottom:1px solid var(--border);' : ''}">
          <div style="min-width:0">
            <div style="font-size:13.5px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(safeStr(l.lead_name) || l.lead_email || l.lead_phone || '—')}</div>
            <div style="font-size:11.5px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(safeStr(l.lead_email) || safeStr(l.lead_phone) || '—')}${l.last_outcome ? ` · laatste: ${esc(OUTCOME_LABEL[l.last_outcome] || l.last_outcome)}` : ''}</div>
          </div>
          <span style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-3);white-space:nowrap">${l.snoozed_until ? `Tot ${fmtDateShort(l.snoozed_until)}` : '—'}</span>
          <button class="btn btn-ghost btn-sm" onclick="window.__fuJumpToLead('${esc(l.id)}')">Open →</button>
          <button class="btn btn-primary btn-sm" ${busy ? 'disabled' : ''} onclick="window.__fuSluimerWake('${esc(l.id)}')">${busy ? 'Wakker…' : '☀ Wake-up'}</button>
        </div>`;
      }).join('')}
    </div>`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // REGISTRATIE
  // ═══════════════════════════════════════════════════════════════════════
  /* ═══════════════════════════════════════════════════════════════════════
     OVERIGE-tab (UX-ronde) — hub-menu naar admin/archief/afgeboekt/sluimerpot
     Houdt de hoofd-tabbalk compact. Klik → DFO.goTab naar sub-view.
     ═══════════════════════════════════════════════════════════════════════ */
  function overigeView() {
    const items = [
      { tab: 'Sluimerpot', icon: '💤', desc: 'Leads die gepauzeerd zijn — komen automatisch terug op de wake-datum.' },
      { tab: 'Afgeboekt',  icon: '📉', desc: 'Verloren leads met reden (afgesloten, doorverwezen, dubbel).' },
      { tab: 'Archief',    icon: '📁', desc: 'Historische leads (>90 dagen inactief, gearchiveerd).' },
      { tab: 'Opvolging',  icon: '🔁', desc: 'Terugbel-agenda: leads met een geplande terugbel-datum (chronologisch).' },
      { tab: 'Admin',      icon: '⚙',  desc: 'Instellingen, backfill, GHL-koppelingen, sync-status.' },
    ];
    return `<div class="pad" style="padding-top:16px">
      <div style="max-width:640px">
        <div style="font-size:15px;font-weight:600;margin-bottom:6px">Overige weergaven</div>
        <div style="font-size:12.5px;color:var(--text-3);margin-bottom:14px">Deze weergaven staan buiten de dagelijkse werkstroom. Klik om te openen.</div>
        <div style="display:grid;gap:8px">
          ${items.map((it) => `<button class="btn btn-ghost" onclick="try{window.DFO.goTab('${esc(it.tab)}')}catch(_){}" style="display:flex;align-items:center;gap:14px;padding:14px 16px;text-align:left;border:1px solid var(--border);border-radius:var(--r);background:var(--surface);cursor:pointer">
            <span style="font-size:22px">${it.icon}</span>
            <div style="flex:1;min-width:0">
              <div style="font-size:14px;font-weight:600;color:var(--text)">${esc(it.tab)} →</div>
              <div style="font-size:12px;color:var(--text-3);margin-top:2px">${esc(it.desc)}</div>
            </div>
          </button>`).join('')}
        </div>
        <div style="margin-top:20px;padding:12px 14px;background:var(--surface-2);border-radius:var(--r);font-size:11.5px;color:var(--text-3)">
          ℹ Voicememo-ronde en No-show-lijst zijn in de hoofd-flow geïntegreerd:
          voicememo verschijnt als popup + indicator bij openen van Follow-up,
          en event-no-shows staan mee in de <b>Opvolglijst</b>.
        </div>
      </div>
    </div>`;
  }

  /* Voicememo popup-reminder (mirror v1). Verschijnt bij openen van Follow-up
     als er >0 vandaag-zooms te versturen zijn. Fetch draait fail-soft: bij
     endpoint-fout wordt de popup gewoon niet getoond (geen blokker). */
  function _voicememoPopup() {
    if (_ui.voicememoPopupDismissed) return '';
    // Trigger fetch als nog niet geladen (fail-soft; endpoint-fout = geen popup)
    if (!_live.voicememo.data && !_live.voicememo.loading && !_live.voicememo.error) {
      queueMicrotask(fetchVoicememo);
      return '';
    }
    if (!_live.voicememo.data) return '';
    const items = asArr(_live.voicememo.data.items || _live.voicememo.data.rounds || _live.voicememo.data);
    const openCount = items.filter((it) => !it.voicememo_sent && !it.done).length;
    if (openCount <= 0) return '';
    return `<div style="position:fixed;top:80px;right:24px;z-index:1500;max-width:360px;background:var(--surface);border:1px solid var(--violet);border-radius:var(--r);box-shadow:0 12px 32px rgba(0,0,0,.18);padding:16px 18px">
      <div style="display:flex;align-items:flex-start;gap:12px">
        <div style="width:36px;height:36px;border-radius:50%;background:var(--violet-soft);color:var(--violet);display:grid;place-items:center;flex-shrink:0;font-size:18px">🎙</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13.5px;font-weight:600;color:var(--text);margin-bottom:4px">Voicememo-ronde</div>
          <div style="font-size:12.5px;color:var(--text-2);line-height:1.5;margin-bottom:10px">Je hebt <b>${openCount}</b> voicememo${openCount === 1 ? '' : "'s"} te versturen vandaag (vandaag-Zooms).</div>
          <div style="display:flex;gap:6px;justify-content:flex-end">
            <button class="btn btn-ghost btn-sm" onclick="window.__fuVoicememoDismissPopup()">Later</button>
            <button class="btn btn-primary btn-sm" style="background:var(--violet);border-color:var(--violet)" onclick="window.__fuVoicememoOpenView()">Open lijst →</button>
          </div>
        </div>
        <button class="icon-btn" onclick="window.__fuVoicememoDismissPopup()" style="width:22px;height:22px;font-size:12px" title="Sluiten">✕</button>
      </div>
    </div>`;
  }

  // UX-ronde 2026-08-16: Voicememo + No-show tabs verwijderd uit sub-nav.
  // - Voicememo → popup-reminder bij open + kleine indicator in werklijst.
  //   View blijft geregistreerd voor deep-link maar niet in tab-array.
  // - No-show → gemerged in Opvolglijst (event-no-shows tonen daar mee).
  // - Admin/Archief/Afgeboekt/Sluimerpot → verhuisd naar "Overige"-tab
  //   (dropdown). Views blijven geregistreerd zodat de dropdown ze kan
  //   openen; ze verschijnen niet in de hoofd-tabbalk.
  window.DFO.VIEWS['followup/Werklijst']       = werklijstView;
  window.DFO.VIEWS['followup/Opvolglijst']     = opvolglijstView;
  window.DFO.VIEWS['followup/Afspraken']       = afsprakenView;
  window.DFO.VIEWS['followup/Kalender']        = kalenderView;
  window.DFO.VIEWS['followup/Retenties']       = retentiesView;
  window.DFO.VIEWS['followup/Sluimerpot']      = sluimerpotView;     // via Overige
  window.DFO.VIEWS['followup/No-show']         = noshowView;         // deep-link only (niet in nav)
  window.DFO.VIEWS['followup/Open-acties']     = openActiesView;
  window.DFO.VIEWS['followup/Opvolging']       = opvolgingView;
  window.DFO.VIEWS['followup/Afgeboekt']       = afgeboektView;      // via Overige
  window.DFO.VIEWS['followup/Archief']         = archiefView;        // via Overige
  window.DFO.VIEWS['followup/Event-bellijst']  = eventBellijstView;
  window.DFO.VIEWS['followup/Statistieken']    = statistiekenView;
  window.DFO.VIEWS['followup/Zoeken']          = zoekenView;
  window.DFO.VIEWS['followup/Voicememo']       = voicememoView;      // deep-link only (indicator + popup)
  window.DFO.VIEWS['followup/Admin']           = adminView;          // via Overige
  // Nieuwe hub-tab: "Overige" toont dropdown-menu naar Admin/Archief/
  // Afgeboekt/Sluimerpot om de hoofd-tabbalk compact te houden.
  window.DFO.VIEWS['followup/Overige']         = overigeView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('followup');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('followup');

  console.debug('[followup-v2] BROK 5 registered — 16 tabs live. Alle 45 endpoints gekoppeld (screenshot-review noteert upload-flow; ghl-poll/webhook draaien server-side).');
})();
