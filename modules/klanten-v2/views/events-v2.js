// modules/klanten-v2/views/events-v2.js
//
// Events v2 — v1-parity FASE 1 (2026-08-13). Dormant.
// QA via ?v2preview=events. Geen schema-wijziging, alle endpoints bestaan.
//
// Structuur:
//   Overzicht-tab = 3 modi (lijst / detail / wizard) via _ui.mode
//     - lijst:  filters + zoek + niveau-select + rij → detail, "+ Nieuw" → wizard
//     - detail: 4 sub-tabs (Info / Aanwezigen / Mentoren / Audit) + acties
//     - wizard: 3-staps (Basis info / Niveau / Review)
//   Inbox-tab, Inschrijvingen-tab: bestaand.
//   Statistieken-tab: vervangt Mentor-grootboek — KPI's + maand-grafiek +
//     top-events + per-event financiën, client-side geaggregeerd uit
//     events-completed-list. Geen nieuw endpoint.

(function () {
  if (!window.DFO) { console.error('[events-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[events-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, S, F, eur0 } = window.DFO;
  const H = window.KV_V2.helpers;

  const asArr = (x) => Array.isArray(x) ? x : [];
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const fmtNum = (n) => (Number(n || 0)).toLocaleString('nl-NL');

  const _live = {
    events:      { loading: false, error: null, data: null, filter: 'published' },
    completed:   { loading: false, error: null, data: null },
    signups:     { loading: false, error: null, data: null, filter: '' },
    niveaus:     { loading: false, error: null, data: null },
    detail:      { loading: {}, error: {}, data: {} },       // per event_id
    attendees:   { loading: {}, error: {}, data: {} },
    completedOne:{ loading: {}, error: {}, data: {} },
    audit:       { loading: {}, error: {}, data: {} },
    revenue:     { loading: false, error: null, data: null },
    mentors:     { loading: {}, error: {}, data: {} },       // per event_id — voor complete-flow
    auditAgg:    { loading: {}, error: {}, data: {} },       // per event_id — aggregated attendee-audit
    // Fase 2 — Inbox + Instellingen
    inbox:       { loading: false, error: null, data: null },  // events-conversations
    autos:       { loading: false, error: null, data: null },  // event_automations
    autoClose:   { loading: false, error: null, data: null },  // signup-deadline setting
    // Punt 3 — Aanwezige-detail
    assessments: { loading: {}, error: {}, data: {} },         // per attendee_id
    attConv:     { loading: {}, error: {}, data: {} },         // per attendee_id → conversation_id|null
    attComms:    { loading: {}, error: {}, data: {} },         // per attendee_id → {items, note}
    // Punt 4 — In-shell inbox viewer (nu unified WA + email via inbox-thread-unified)
    inboxMsgs:   { loading: {}, error: {}, data: {} },         // per conversation_id → {conversation, items:[{channel,direction,body,at,meta}]}
    // Reply-composer + template-picker
    inboxTpls:   { loading: {}, error: {}, data: {} },         // per conversation_id → items[]
    // Simone-config (module=events) — voor autonomie/status-badge in header
    simoneCfg:   { loading: false, error: null, data: null },  // {is_enabled, feature_flags, ...}
    // Simone-verstuurde messages (via joost_suggestions.sent_autonomously)
    simoneMsgs:  { loading: {}, error: {}, data: {} },         // per conversation_id → Set(message_id)
    // Openstaande Simone-suggestie per conv (status=PROPOSED) — single, endpoint returnt {suggestion: null|{}}
    suggestion:  { loading: {}, error: {}, data: {} },         // per convId → {id, suggested_reply, ...} | null
  };

  const _ui = {
    mode: 'list',          // 'list' | 'detail' | 'wizard'
    detailId: null,
    detailTab: 'Info',
    niveauFilter: '',
    searchQ: '',
    // Detail-Aanwezigen state
    attStatusFilter: 'all',
    // Wizard state
    wizard: null,          // { step:1|2|3, mode:'create'|'edit', id?, form:{...} }
    // Row-actie busy-flags
    busy: {},              // busy[eventId] = 'publish'|'complete'|'archive'|'duplicate' etc
    // Attendee-kebab state per rij
    kebabOpen: null,       // attendee.id
    // Attendee edit-modal
    attModal: null,        // { mode, item }
    // Wizard file preview
    _photoDataUrl: null,
    // Complete-modal state
    completeModal: null,   // { event_id, step }
    completeForm: null,    // { attendees:{[id]:{attendance_status, outcome, reason}}, present_mentors:{[team_member_id]:true}, expenses:[{team_member_id, amount, description}] }
    // Inline belstatus-dropdown busy-flag per attendee
    belBusy: {},
    // Fase 2 — Instellingen-pane sub-tab
    settingsTab: 'automations',
    autoCloseDraft: null,   // {hours} tijdens edit
    autoCloseBusy: false,
    // Punt 3 — Aanwezige-detail modal state
    attDetail: null,        // { attId, eventId } → open modal
    noteDraft: {},          // [attId] = string (bewerkbare notitie-tekst)
    noteBusy:  {},          // [attId] = true tijdens save
    // Punt 4 — In-shell inbox conversation viewer (split-pane)
    inboxConvId: null,      // actieve conversation in split-pane
    inboxScrollTop: 0,      // laatst-bekende scroll van linkerlijst; restore na re-render
    inboxNarrowMode: 'list',// 'list'|'detail' — alleen relevant op <900px
    inboxAutoSelected: false,// eerste conv auto-geselecteerd bij initial load
    // Reply-composer state
    composeText:   {},       // [convId] = string (draft)
    composeBusy:   {},       // [convId] = true tijdens send
    composeError:  {},       // [convId] = string bij send-fail
    // Template-picker modal
    tplPickerOpen: null,     // convId waarvoor picker open is
    tplPickerQ:    '',       // client-side search
    // Template-send state — als gezet, send via /api/inbox-send-template
    composeTpl:      {},     // [convId] = { name, language, originalBody, attendeeId? }
    // E-mail composer state
    composeSubject:  {},     // [convId] = string (default "Re: <last subject>")
    composeMailbox:  {},     // [convId] = string (default = mailbox uit laatste inbound email)
    composeChannel:  {},     // [convId] = 'whatsapp' | 'email' (voor unified convs; anders auto)
    // Simone suggestion dismissed voor sessie (client-side hide zolang niet gerefetched)
    suggestionHidden:{},     // [convId] = true
    // Client-side zoek op gesprekkenlijst
    inboxSearchQ:  '',
    // Simone-poll timer voor open conv (module-scope, herstart per conv-select)
    _simonePollTimer: null,
    _simonePollConvId: null,
    // Instant-berichten: Supabase realtime channels + polling fallback
    _rtMsgChannel:    null,       // WA-messages INSERT (filter per conv)
    _rtConvChannel:   null,       // conversations INSERT/UPDATE (list refresh)
    _rtMsgConvId:     null,       // conv-id waarop msg-channel is
    _pollThreadTimer: null,       // 8s fallback thread-refresh
    _pollListTimer:   null,       // 15s fallback list-refresh
    // Sticky-bottom scroll-track voor auto-scroll bij nieuwe berichten
    _lastScrollAtBottom: true,
  };

  async function tryFetch(label, url, init, timeoutMs) {
    timeoutMs = timeoutMs || 8000;
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      return await Promise.race([
        window.KV.authedJson(url, init),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) { console.warn('[ev-v2] ' + label + ' fail:', e?.message); return { __error: e?.message || 'onbekende fout' }; }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // FETCHERS
  // ═══════════════════════════════════════════════════════════════════════
  async function fetchEvents(status, niveau, q) {
    status = status != null ? status : _live.events.filter;
    const st = _live.events;
    const filterKey = [status, niveau || '', q || ''].join('|');
    if (st.loading || (st.data && st._filterKey === filterKey)) return;
    st.loading = true; st.error = null; st.filter = status; st.data = null; st._filterKey = filterKey;
    let url;
    if (status === 'afgerond') {
      url = '/api/events-completed-list';
    } else {
      const params = ['limit=200', 'status=' + encodeURIComponent(status || 'published')];
      if (niveau) params.push('niveau=' + encodeURIComponent(niveau));
      if (q)      params.push('q=' + encodeURIComponent(q));
      url = '/api/events-list?' + params.join('&');
    }
    const j = await tryFetch('events:' + status, url);
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else if (status === 'afgerond') st.data = { items: asArr(j?.events).map(_normalizeCompleted), total: asArr(j?.events).length };
    else st.data = { items: asArr(j?.items), total: Number(j?.total || 0) };
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchCompleted() {
    const st = _live.completed; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('completed', '/api/events-completed-list');
    st.loading = false;
    if (j && j.__error) st.error = j.__error; else st.data = asArr(j?.events);
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchSignups(status) {
    status = status != null ? status : _live.signups.filter;
    const st = _live.signups;
    if (st.loading || (st.data && st.filter === status)) return;
    st.loading = true; st.error = null; st.filter = status; st.data = null;
    // v=48: load-all-loop (zelfde patroon als sales-offertes v=17). Endpoint
    // limit=200-max, geen native paginatie-hint (rows.length < limit = laatste
    // pagina). Guard: max 20 pagina's = 4000 rijen (ruim boven realistische
    // volumes, voorkomt runaway). Counts pakken uit page 1 (blijven consistent
    // over pagina's want status-scoped).
    const baseParams = new URLSearchParams();
    if (status) baseParams.set('status', status);
    baseParams.set('limit', '200');
    const allRows = [];
    let firstCounts = null;
    let hadError = false;
    for (let page = 0; page < 20; page++) {
      const p = new URLSearchParams(baseParams);
      p.set('offset', String(page * 200));
      const j = await tryFetch('signups:' + status + ':p' + page, '/api/events-signup-inbox-list?' + p.toString());
      if (j?.__error) { hadError = allRows.length === 0; break; }
      const rows = asArr(j?.rows);
      allRows.push(...rows);
      if (firstCounts === null) firstCounts = j?.counts || {};
      if (rows.length < 200) break;  // laatste pagina
    }
    st.loading = false;
    if (hadError) st.error = 'Kon inschrijvingen niet laden';
    else st.data = { rows: allRows, counts: firstCounts || {} };
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchNiveaus() {
    const st = _live.niveaus; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('niveaus', '/api/events-niveau-options');
    st.loading = false;
    if (j && j.__error) st.error = j.__error; else st.data = asArr(j?.niveaus || j?.options || []);
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchDetail(id) {
    const st = _live.detail; if (st.loading[id] || st.data[id]) return;
    st.loading[id] = true; st.error[id] = null;
    const j = await tryFetch('detail:' + id, '/api/events-detail?id=' + encodeURIComponent(id));
    st.loading[id] = false;
    if (j && j.__error) st.error[id] = j.__error; else st.data[id] = j?.event || j || null;
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchAttendees(id) {
    const st = _live.attendees; if (st.loading[id] || st.data[id]) return;
    st.loading[id] = true; st.error[id] = null;
    const j = await tryFetch('att:' + id, '/api/events-attendees-list?event_id=' + encodeURIComponent(id));
    st.loading[id] = false;
    if (j && j.__error) st.error[id] = j.__error; else st.data[id] = asArr(j?.attendees || j?.items);
    if (window.DFO?.render) window.DFO.render();
    // Fix ronde-13: als de deelnemer-modal open is (open vanuit
    // Inschrijvingen wacht op deze fetch), re-portal na render.
    if (typeof _ensureAttPortalIfOpen === 'function') _ensureAttPortalIfOpen();
  }
  async function fetchCompletedOne(id) {
    const st = _live.completedOne; if (st.loading[id] || st.data[id]) return;
    st.loading[id] = true; st.error[id] = null;
    // events-completed-list is bulk; filter client-side
    const j = await tryFetch('completed-one:' + id, '/api/events-completed-list');
    st.loading[id] = false;
    if (j && j.__error) st.error[id] = j.__error;
    else st.data[id] = asArr(j?.events).find((e) => String(e.event_id) === String(id)) || null;
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchRevenue() {
    const st = _live.revenue; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('revenue', '/api/events-revenue-list', undefined, 15000);
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else {
      const map = {};
      for (const r of asArr(j?.events)) map[r.event_id] = { revenue_eur: Number(r.revenue_eur || 0), deal_count: Number(r.deal_count || 0) };
      st.data = map;
    }
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchAudit(id) {
    // BUG 4 FIX — events-attendee-audit-log is per-attendee (verplichte
    // query-param attendee_id). Er is GEEN event-brede audit-endpoint.
    // Aggregeer client-side: fetch alle audits parallel voor alle attendees
    // in de list, merge, sort DESC. Cap max 25 attendees om Vercel-timeouts
    // te vermijden.
    const st = _live.auditAgg; if (st.loading[id] || st.data[id]) return;
    st.loading[id] = true; st.error[id] = null;
    // Zorg dat attendees er zijn
    if (!_live.attendees.data[id] && !_live.attendees.loading[id]) {
      await fetchAttendees(id);
    }
    const attList = asArr(_live.attendees.data[id]).slice(0, 25);
    if (attList.length === 0) {
      st.loading[id] = false;
      st.data[id] = [];
      if (window.DFO?.render) window.DFO.render();
      return;
    }
    try {
      const results = await Promise.all(attList.map(async (a) => {
        const j = await tryFetch('audit:' + a.id, '/api/events-attendee-audit-log?attendee_id=' + encodeURIComponent(a.id) + '&limit=20');
        if (j && j.__error) return { attendee: a, entries: [], error: j.__error };
        const entries = asArr(j?.items).map((e) => ({ ...e, _attendee: a }));
        return { attendee: a, entries, error: null };
      }));
      const merged = [];
      for (const r of results) for (const e of r.entries) merged.push(e);
      merged.sort((a, b) => new Date(b.at || b.created_at || 0) - new Date(a.at || a.created_at || 0));
      st.data[id] = merged;
    } catch (e) {
      st.error[id] = e?.message || 'aggregate faalde';
    } finally {
      st.loading[id] = false;
      if (window.DFO?.render) window.DFO.render();
    }
  }
  async function fetchInbox() {
    const st = _live.inbox; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('inbox', '/api/inbox-conversations-list?module=events&limit=100');
    st.loading = false;
    if (j && j.__error) st.error = j.__error; else st.data = asArr(j?.items);
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchAutos() {
    const st = _live.autos; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('autos', '/api/events-automations-list');
    st.loading = false;
    if (j && j.__error) st.error = j.__error; else st.data = asArr(j?.automations);
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchAutoClose() {
    const st = _live.autoClose; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('autoClose', '/api/events-settings-auto-close-get');
    st.loading = false;
    if (j && j.__error) st.error = j.__error; else st.data = j || null;
    if (window.DFO?.render) window.DFO.render();
  }
  // Punt 3 — Aanwezige-detail modal fetchers
  async function fetchAssessment(attId) {
    const st = _live.assessments; if (st.loading[attId] || st.data[attId]) return;
    st.loading[attId] = true; st.error[attId] = null;
    const j = await tryFetch('assess:' + attId, '/api/events-attendee-assessment-get', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ attendee_id: attId }),
    });
    st.loading[attId] = false;
    if (j && j.__error) st.error[attId] = j.__error;
    else st.data[attId] = j || { items: [] };
    if (window.DFO?.render) window.DFO.render();
    _ensureAttPortalIfOpen();
  }
  async function fetchAttConv(attId, customerId) {
    // Resolve attendee → conversation via /api/inbox-conversation-by-customer.
    // Werkt alleen als attendee.customer_id gezet is; anders return null.
    const st = _live.attConv; if (st.loading[attId] || attId in st.data) return;
    if (!customerId) { st.data[attId] = null; if (window.DFO?.render) window.DFO.render(); _ensureAttPortalIfOpen(); return; }
    st.loading[attId] = true; st.error[attId] = null;
    const j = await tryFetch('attConv:' + attId, '/api/inbox-conversation-by-customer?customer_id=' + encodeURIComponent(customerId));
    st.loading[attId] = false;
    if (j && j.__error) st.error[attId] = j.__error;
    else st.data[attId] = j?.found ? j.conversation_id : null;
    if (window.DFO?.render) window.DFO.render();
    _ensureAttPortalIfOpen();
  }
  // Punt 3 — Comms-historie per attendee (WhatsApp/email — verzonden + gepland)
  async function fetchAttComms(attId) {
    const st = _live.attComms; if (st.loading[attId] || st.data[attId]) return;
    st.loading[attId] = true; st.error[attId] = null;
    const j = await tryFetch('comms:' + attId, '/api/events-attendee-comms?attendee_id=' + encodeURIComponent(attId));
    st.loading[attId] = false;
    if (j && j.__error) st.error[attId] = j.__error;
    else st.data[attId] = { items: asArr(j?.items), note: j?.note || null };
    if (window.DFO?.render) window.DFO.render();
    _ensureAttPortalIfOpen();
  }

  // Punt 4 — Unified thread (WhatsApp + e-mail door elkaar).
  //
  // Sinds ronde 3: gebruiken /api/inbox-thread-unified (server-side merge van
  // whatsapp_messages + email_messages + email_replies). Zelfde endpoint dat
  // Wanbetalers/Finance-inbox gebruikt onder de `unified_inbox_enabled`-flag.
  // Response items[] shape: { id, channel:'whatsapp'|'email', direction:
  // 'inbound'|'outbound', body, at, meta:{...} }.
  //
  // Voor unread-reset (mark_as_read=1) fallen we terug op inbox-messages-list
  // in een tweede best-effort call — unified endpoint kent geen mark_as_read.
  //
  // Optional `onDone` callback: als aanwezig, skippen we DFO.render() en
  // laten we caller een surgical DOM-update doen op alleen #ev-inbox-right.
  async function fetchInboxMsgs(convId, onDone) {
    const st = _live.inboxMsgs; if (st.loading[convId] || st.data[convId]) return;
    st.loading[convId] = true; st.error[convId] = null;
    const j = await tryFetch('msgs:' + convId, '/api/inbox-thread-unified?conversation_id=' + encodeURIComponent(convId) + '&include_email=1&limit=200');
    st.loading[convId] = false;
    if (j && j.__error) st.error[convId] = j.__error;
    else st.data[convId] = { conversation: j?.conversation || null, items: asArr(j?.items) };
    // Mark-as-read (WA-only, fire-and-forget; niet blocking op de render)
    try {
      window.KV && window.KV.authedJson &&
        window.KV.authedJson('/api/inbox-messages-list?conversation_id=' + encodeURIComponent(convId) + '&limit=1&mark_as_read=1')
          .catch(() => {});
    } catch (_) {}
    // Ook Simone-signature fetchen (klein, best-effort)
    queueMicrotask(() => fetchSimoneMsgs(convId));
    // Openstaande Simone-suggestie voor deze conv (best-effort)
    _live.suggestion.data[convId] = null;   // invalidate zodat we vers laden
    _ui.suggestionHidden[convId] = false;
    queueMicrotask(() => fetchSuggestion(convId));
    if (typeof onDone === 'function') { try { onDone(); } catch (_) {} }
    else if (window.DFO?.render) window.DFO.render();
    // Force-scroll naar bottom bij initial thread-load — dubbele rAF wacht
    // op layout van de zojuist ingevoegde bubbels.
    _scrollChatToBottom(true);
  }

  // Template-lijst voor huidige conv. Response items[] met body_text, name,
  // language, meta_param_mapping (voor named placeholders).
  async function fetchInboxTpls(convId) {
    const st = _live.inboxTpls; if (st.loading[convId] || st.data[convId]) return;
    st.loading[convId] = true; st.error[convId] = null;
    const j = await tryFetch('tpls:' + convId, '/api/inbox-template-list?conversation_id=' + encodeURIComponent(convId));
    st.loading[convId] = false;
    if (j && j.__error) st.error[convId] = j.__error;
    else st.data[convId] = asArr(j?.items);
    if (window.DFO?.render) window.DFO.render();
  }

  // Simone-config (module=events). Read via bestaande joost-config-get.
  // GEEN DFO.render — die zou een full-view rebuild triggeren die de chat-
  // scrollpositie reset. Alleen status-bar bijwerken via _paintSimoneStatusBar.
  async function fetchSimoneCfg() {
    const st = _live.simoneCfg; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('simoneCfg', '/api/joost-config-get?module=events');
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = j?.config || j || null;
    _paintSimoneStatusBar();
  }

  // Openstaande Simone-suggestie voor deze conv. GEEN DFO.render — caller
  // roept _paintFooterOnly aan (zit in _startSimonePolling.then()). Bij
  // initial load-flow gebruikt fetchInboxMsgs zijn eigen callback voor de
  // volledige right-pane paint (fetchSuggestion is dan al klaar).
  async function fetchSuggestion(convId) {
    const st = _live.suggestion; if (st.loading[convId]) return;
    st.loading[convId] = true; st.error[convId] = null;
    const j = await tryFetch('sugg:' + convId, '/api/joost-suggestions-recent?module=events&conversation_id=' + encodeURIComponent(convId) + '&max_age_minutes=1440');
    st.loading[convId] = false;
    if (j && j.__error) { st.error[convId] = j.__error; }
    else {
      const s = j?.suggestion || null;
      st.data[convId] = (s && s.status === 'PROPOSED') ? s : null;
    }
  }

  // Surgical status-bar update — alleen die kleine bovenste bar, niet
  // #ev-inbox-chat-scroll en niet #ev-inbox-footer.
  function _paintSimoneStatusBar() {
    try {
      const wrap = document.createElement('div');
      wrap.innerHTML = _inboxSimoneStatusBar();
      const newBar = wrap.firstElementChild;
      if (!newBar) return;
      const old = document.querySelector('.ev-inbox-simone-bar');
      if (old) old.replaceWith(newBar);
    } catch (_) {}
  }

  // Simone-verstuurde messages per conv: joost_suggestions waar
  // sent_autonomously=true + status='SENT_AUTONOMOUSLY' + sent_message_id
  // matcht met whatsapp_messages.id in deze conv. Endpoint: joost-suggestions-
  // recent (bestaand, geeft recent status per conv/module).
  async function fetchSimoneMsgs(convId) {
    const st = _live.simoneMsgs; if (st.loading[convId] || st.data[convId]) return;
    st.loading[convId] = true; st.error[convId] = null;
    const j = await tryFetch('simoneMsgs:' + convId, '/api/joost-suggestions-recent?module=events&conversation_id=' + encodeURIComponent(convId) + '&limit=50');
    st.loading[convId] = false;
    if (j && j.__error) { st.error[convId] = j.__error; return; }
    const items = asArr(j?.items || j?.suggestions);
    const ids = new Set();
    for (const it of items) {
      if (it?.sent_autonomously === true && it?.sent_message_id) ids.add(String(it.sent_message_id));
    }
    st.data[convId] = ids;
    // Geen render — surgical, want gebruikt in surgical-paint na render
  }

  async function fetchMentors(id) {
    // V1-parity: /api/events-mentors-available zonder event_id → alle rol-mentoren
    // (team_members met user_id + rol 'mentor'). Zo kun je in de afrond-modal
    // aanvinken wie er aanwezig was, óók mentoren die niet al aan dit event
    // waren gekoppeld (fallback voor last-minute invalers).
    const st = _live.mentors; if (st.loading[id] || st.data[id]) return;
    st.loading[id] = true; st.error[id] = null;
    const j = await tryFetch('mentors:' + id, '/api/events-mentors-available');
    st.loading[id] = false;
    if (j && j.__error) st.error[id] = j.__error; else st.data[id] = asArr(j?.mentors || j?.items);
    if (window.DFO?.render) window.DFO.render();
  }

  function _normalizeCompleted(e) {
    return {
      id: e.event_id, title: e.title, starts_at: e.starts_at, status: 'afgerond',
      attendee_count_active: Number(e.aanwezig || 0),
      attendee_count_total: Number(e.aanwezig || 0) + Number(e.no_show || 0) + Number(e.afgemeld || 0),
      capacity: null,
      completion_summary: e.completion_summary,
      expenses_total: Number(e.expenses_total || 0),
      bonus_total: Number(e.bonus_total || 0),
      sales: Number(e.sales || 0),
      _raw: e,
    };
  }

  window.__evRetry = (block, id) => {
    if (block === 'detail' && id)   { _live.detail.data[id] = null; _live.detail.error[id] = null; fetchDetail(id); }
    else if (block === 'attendees' && id) { _live.attendees.data[id] = null; _live.attendees.error[id] = null; fetchAttendees(id); }
    else if (block === 'audit' && id) { _live.audit.data[id] = null; _live.audit.error[id] = null; fetchAudit(id); }
    else if (block === 'completedOne' && id) { _live.completedOne.data[id] = null; _live.completedOne.error[id] = null; fetchCompletedOne(id); }
    else if (block === 'events')    { _live.events.data = null; _live.events.error = null; fetchEvents(); }
    else if (block === 'completed') { _live.completed.data = null; _live.completed.error = null; fetchCompleted(); }
    else if (block === 'signups')   { _live.signups.data = null; _live.signups.error = null; fetchSignups(); }
    else if (block === 'inboxMsgs' && id) { _live.inboxMsgs.data[id] = null; _live.inboxMsgs.error[id] = null; fetchInboxMsgs(id); }
    if (window.DFO?.render) window.DFO.render();
  };

  // ═══════════════════════════════════════════════════════════════════════
  // SHARED HELPERS
  // ═══════════════════════════════════════════════════════════════════════
  const errBlk = (block, msg, arg) => `<div style="margin:14px 20px;padding:12px 16px;border:1px solid var(--rose-line);background:var(--rose-soft);border-radius:var(--r);color:var(--rose);font-size:13px;display:flex;align-items:center;gap:12px">
    <span>${svg(I.alert || I.warn, 'width:16px;height:16px')}</span>
    <span style="flex:1">Kon niet ophalen: ${esc(msg)}</span>
    <button class="btn btn-ghost btn-sm" onclick="__evRetry('${block}'${arg ? `,'${arg}'` : ''})">Opnieuw</button></div>`;
  const skel = () => `<div class="pad"><div class="card"><div class="card-body" style="padding:22px;opacity:.55"><div style="height:12px;background:var(--surface-2);border-radius:4px;width:60%;margin-bottom:12px"></div><div style="height:8px;background:var(--surface-2);border-radius:4px;width:80%"></div></div></div></div>`;
  const emptyBlk = (title, sub) => `<div class="empty" style="padding:44px 20px"><div class="empty-t">${esc(title)}</div><div class="empty-s">${esc(sub || '')}</div></div>`;
  function _fmtDate(iso) { if (!iso) return ''; const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toLocaleDateString('nl-NL', { day:'2-digit', month:'2-digit', year:'numeric' }) : ''; }
  function _fmtTime(iso) { if (!iso) return ''; const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit' }) : ''; }
  function _fmtDateTime(iso) { const d = _fmtDate(iso), t = _fmtTime(iso); return d + (t ? ' ' + t : ''); }
  // BUG 2 FIX — datetime-local input wil "YYYY-MM-DDTHH:mm" in LOKALE tijd,
  // zonder timezone-suffix. .slice(0,16) op ISO faalt bij Z-suffix (UTC)
  // omdat Nederland +1/+2 uur voor loopt → tijd wordt fout getoond.
  function _isoToLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function _showToast(msg) {
    const el = document.getElementById('kv-toast');
    if (!el) return;
    el.textContent = msg; el.classList.add('show');
    clearTimeout(_showToast._t); _showToast._t = setTimeout(() => el.classList.remove('show'), 3000);
  }

  const STATUS_META = {
    published: ['ok',      'Gepubliceerd'],
    draft:     ['neutral', 'Concept'],
    cancelled: ['danger',  'Geannuleerd'],
    archived:  ['neutral', 'Archief'],
    afgerond:  ['accent',  'Afgerond'],
    completed: ['accent',  'Afgerond'],
  };

  // ═══════════════════════════════════════════════════════════════════════
  // OVERZICHT-TAB DISPATCHER (list / detail / wizard)
  // ═══════════════════════════════════════════════════════════════════════
  function overzichtView() {
    const base = _ui.mode === 'wizard' ? _wizardView()
      : _ui.mode === 'settings' ? _settingsView()
      : (_ui.mode === 'detail' && _ui.detailId) ? _detailView(_ui.detailId)
      : _lijstView();
    // Complete-modal + attendee-detail-modal renderen boven de content als open
    return base + _globalOverlays();
  }
  // Tab-agnostische overlays. MOET vanuit iedere events-view aangeroepen worden,
  // anders bestaat de modal-markup niet als _ui.attDetail vanuit een andere tab
  // (Inschrijvingen/Inbox/Statistieken) gezet wordt -> portal-node ontbreekt ->
  // scrim/modal onzichtbaar. Zelfde helper wordt gebruikt door inboxView(),
  // inschrijvingenView() en statistiekenView() zodat alle tabs de modal kunnen tonen.
  function _globalOverlays() {
    return (_ui.completeModal ? _completeModal() : '') + (_ui.attDetail ? _attDetailModal() : '');
  }

  // ── LIJST ────────────────────────────────────────────────────────────────
  function _lijstView() {
    const status = _live.events.filter || 'published';
    const niveau = _ui.niveauFilter;
    const q = _ui.searchQ;
    if (!_live.events.data && !_live.events.loading && !_live.events.error) queueMicrotask(() => fetchEvents(status, niveau, q));
    if (!_live.niveaus.data && !_live.niveaus.loading && !_live.niveaus.error) queueMicrotask(fetchNiveaus);
    if (_live.events.error && !_live.events.data) return errBlk('events', _live.events.error);
    if (_live.events.loading && !_live.events.data) return skel();

    // Bug 4: filter events met completed_at uit de Gepubliceerd-lijst.
    // events-complete-core zet completed_at maar laat status='published' staan,
    // waardoor 1 event in Gepubliceerd EN Afgerond verscheen. Client-side
    // filter, backend niet aangeraakt (afrond-flow ongewijzigd).
    let rawItems = asArr(_live.events.data?.items);
    if (status === 'published') {
      rawItems = rawItems.filter((e) => !e.completed_at);
    }
    const items = rawItems;
    const total = Number(_live.events.data?.total || items.length);
    // Client-side extra zoek (server-side q ondersteunt ook, dus overlap ok)
    const rows = q ? items.filter((e) => String(e.title || '').toLowerCase().includes(q.toLowerCase()) || String(e.location || '').toLowerCase().includes(q.toLowerCase())) : items;

    // FIX (2026-08-18): 'bezetting' hangt overal aan dezelfde definitie
    // als getConfirmedCount: status IN ('aangemeld','aanwezig') AND
    // is_test=false AND assessment_response_id IS NOT NULL. Server geeft
    // dit door als attendee_count_active. Een 'switched_to_other_event'/
    // 'geannuleerd'/'wachtlijst'/'no_show'-attendee mag NIET meetellen
    // voor bezetting — anders zeg je vol terwijl er plek vrij is.
    const activeAttendees = items.reduce((a, e) => a + Number(e.attendee_count_active || 0), 0);
    const totalCap = items.reduce((a, e) => a + Number(e.capacity || 0), 0);
    const bezetting = totalCap > 0 ? Math.round((activeAttendees / totalCap) * 100) : 0;
    const bijnaVol = items.filter((e) => Number(e.capacity || 0) > 0 && Number(e.attendee_count_active || 0) / Number(e.capacity) >= 0.8).length;

    const niveauOpts = asArr(_live.niveaus.data);

    return `${H.kpis([
      { c:'pink',    icon:I.cal,   label:'Events (' + status + ')', val:String(total), sub:'in scope' },
      { c:'teal',    icon:I.users, label:'Aanmeldingen',            val:String(activeAttendees), sub:'actief' },
      { c:'emerald', icon:I.chart, label:'Gem. bezetting',          val:bezetting + '%', hi:1, sub:totalCap ? '(cap ' + totalCap + ')' : '(cap onbekend)' },
      { c:'amber',   icon:I.alert, label:'Bijna vol',               val:String(bijnaVol), hi:1, sub:'≥80% bezet' },
    ])}
    <div class="toolbar" style="padding:12px 20px;gap:8px;flex-wrap:wrap;border-bottom:1px solid var(--border)">
      ${['published','draft','afgerond','cancelled','archived'].map((s) => `<button class="chip ${status === s ? 'on' : ''}" onclick="window.__evSetStatus('${s}')">${esc(_statusLabel(s))}</button>`).join('')}
      <select class="filter-sel" onchange="window.__evSetNiveau(this.value)">
        <option value="">Alle niveaus</option>
        ${niveauOpts.map((n) => `<option value="${esc(n.slug || n.id || n.value || n)}" ${_ui.niveauFilter === (n.slug || n.id || n.value || n) ? 'selected' : ''}>${esc(n.label || n.name || n.slug || n)}</option>`).join('')}
      </select>
      <div class="tb-search" style="flex:1;max-width:300px">${H && typeof H.stableSearch === 'function' ? H.stableSearch('ev-overview-q', 'Zoek titel of locatie…', _ui.searchQ) : `<input type="search" placeholder="Zoek titel of locatie…" value="${esc(_ui.searchQ)}" oninput="window.__evSearch(this.value)" onsearch="window.__evSearch(this.value)" style="width:100%;padding:6px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);font-size:12.5px" />`}</div>
      <div class="tb-right" style="display:flex;gap:6px;align-items:center">
        <button class="btn btn-ghost btn-sm" onclick="__evRetry('events')" title="Vernieuwen">${svg(I.refresh || I.tick, 'width:14px;height:14px')}</button>
        <button class="btn btn-primary btn-sm" onclick="window.__evWizardOpen('create')">${svg(I.plus)}Nieuw event</button>
        <button class="btn btn-ghost btn-sm" title="Events-instellingen (automations, deadline, foto's, Simone, vragenlijst)" onclick="window.__evGoSettings()" style="display:inline-flex;align-items:center;gap:6px">${svg(I.settings, 'width:14px;height:14px')}<span>Instellingen</span></button>
      </div>
    </div>
    ${rows.length === 0
      ? emptyBlk('Geen events', 'Er zijn geen events die aan de filter voldoen.')
      : `<style>
          .kv-evcap-cell{text-align:center;vertical-align:middle}
          .kv-evcap-inner{display:inline-flex;flex-direction:column;align-items:center;gap:4px;min-width:96px}
          .kv-evcap-num{font-size:12.5px;font-family:'IBM Plex Mono',monospace;line-height:1;color:var(--text-1)}
          .kv-evcap-bar{position:relative;width:96px;height:6px;background:var(--surface-2);border-radius:3px;overflow:hidden;border:1px solid var(--border)}
          .kv-evcap-bar > i{display:block;height:100%;border-radius:3px}
          .kv-evcap-bar > i.ok{background:var(--emerald,#07835A)}
          .kv-evcap-bar > i.warn{background:var(--amber,#C2700A)}
          .kv-evcap-bar > i.danger{background:var(--rose,#C22B3E)}
        </style>` + H.table(
          [{l:'Event'},{l:'Datum',cls:'optional'},{l:'Locatie',cls:'optional'},{l:'Niveau',cls:'optional'},{l:'<div style="text-align:center">Aanm/Cap</div>',cls:'kv-evcap-cell'},{l:'Sync',cls:'r optional'},{l:'Status'},{l:'',cls:'r'}],
          rows.map((e) => {
            // Aanm = BEVESTIGDE deelnemers (vragenlijst ingevuld):
            // attendee_count_active telt attendees waar assessment_response_id
            // IS NOT NULL (zie server-lib getConfirmedCount + events-v2.js:822).
            // Was voorheen attendee_count_total (alle aanmeldingen incl.
            // no-show/afgemeld) — die is niet wat de mentor als 'bezetting' wil.
            const aanm = Number(e.attendee_count_active || 0);
            const cap = Number(e.capacity || 0);
            const ratio = cap > 0 ? aanm / cap : 0;
            // Kleur consistent met KPI-drempel 'Bijna vol ≥80%':
            //   < 80%   → groen (ok)
            //   80-99%  → oranje (warn)
            //   ≥ 100%  → rood (danger, incl. overboekt)
            const barCol = ratio >= 1.0 ? 'danger' : ratio >= 0.8 ? 'warn' : 'ok';
            const [sc, sl] = STATUS_META[e.status] || ['neutral', e.status || '—'];
            const busy = _ui.busy[e.id];
            const capCell = cap > 0
              ? `<div class="kv-evcap-inner" title="${aanm} bevestigd · cap ${cap} (${Math.round(ratio * 100)}%)"><span class="kv-evcap-num">${aanm}/${cap}</span><div class="kv-evcap-bar"><i class="${barCol}" style="width:${Math.min(100, ratio * 100)}%"></i></div></div>`
              : `<span class="kv-evcap-num">${aanm}${e.status === 'afgerond' ? ' (afg)' : ''}</span>`;
            return [
              `<a href="#" onclick="event.preventDefault();window.__evGoDetail('${esc(e.id)}')" style="color:inherit;text-decoration:none"><span class="cell-main">${esc(e.title || '—')}</span></a>`,
              `<span class="mono" style="color:var(--text-3);font-size:12.5px">${esc(_fmtDate(e.starts_at))} ${esc(_fmtTime(e.starts_at))}</span>`,
              `<span style="color:var(--text-2);font-size:12.5px">${esc(e.location || '—')}</span>`,
              `<span style="font-size:11.5px;color:var(--text-3)">${esc(e.niveau || '')}</span>`,
              capCell,
              _syncCell(e),
              H.pill(sc, sl),
              `<div style="position:relative;display:flex;gap:3px;justify-content:flex-end">
                <button class="icon-btn" title="Dupliceren" ${busy ? 'disabled' : ''} onclick="event.stopPropagation();window.__evDuplicate('${esc(e.id)}')" style="width:26px;height:26px;${busy === 'duplicate' ? 'opacity:.5' : ''}">${svg(I.copy || I.plus, 'width:13px;height:13px')}</button>
                <button class="icon-btn" title="Meer acties" onclick="event.stopPropagation();window.__evRowMenu('${esc(e.id)}','${esc(e.status)}')" style="width:26px;height:26px">${svg(I.dots || I.settings, 'width:13px;height:13px')}</button>
                ${_ui.rowMenuOpen === e.id ? _evRowMenuHtml(e) : ''}
              </div>`,
            ];
          })
        )}`;
  }

  function _statusLabel(s) {
    return ({ published:'Gepubliceerd', draft:'Concept', afgerond:'Afgerond', cancelled:'Geannuleerd', archived:'Archief' })[s] || s;
  }
  function _syncCell(e) {
    const wf = e.webflow_sync_status || (e.webflow_last_synced_at ? 'synced' : null);
    const gh = e.ghl_sync_status || (e.ghl_last_synced_at ? 'synced' : null);
    if (!wf && !gh) return '<span style="color:var(--text-3);font-size:11px">—</span>';
    // display = korte badge-tekst (kolom is smal), tooltip = volle naam.
    // Site heet extern 'deforexopleiding.nl'; interne integratie blijft
    // webflow_* op sync-veld/env-niveau — dit label is puur user-facing.
    const badge = (s, display, tooltip) => {
      if (!s) return '';
      const cls = ['success','synced','ok'].includes(s) ? 'ok'
                : ['pending','queued','in_progress'].includes(s) ? 'warn'
                : 'danger';
      return `<span class="pill pill-${cls} nodot" style="font-size:10px;padding:1px 5px" title="${esc((tooltip || display) + ': ' + s)}">${display}</span>`;
    };
    return `<div style="display:flex;gap:3px;justify-content:flex-end">${badge(wf, 'DFO', 'deforexopleiding.nl')}${badge(gh, 'GHL', 'GoHighLevel')}</div>`;
  }

  // Bug 3b: race-fix — nul ook loading zodat een orphan-fetch niet meer
  // stale filter-A-data over filter-B heen schrijft (bootstrap-check
  // `if (loading)` blokkeerde de refetch anders).
  window.__evSetStatus = (s) => { _live.events.data = null; _live.events.error = null; _live.events.loading = false; _live.events.filter = s; if (window.DFO?.render) window.DFO.render(); };
  window.__evSetNiveau = (v) => { _ui.niveauFilter = v; _live.events.data = null; _live.events.error = null; _live.events.loading = false; if (window.DFO?.render) window.DFO.render(); };
  // Bug 5: overview-zoek gebruikt H.onSearch registratie; input rendert via
  // H.stableSearch mount-slot dat DFO.render-swap overleeft (behoud focus+cursor).
  window.__evSearch = (v) => { _ui.searchQ = v; if (window.DFO?.render) window.DFO.render(); };
  if (H && typeof H.onSearch === 'function') {
    H.onSearch('ev-overview-q', (v) => {
      _ui.searchQ = String(v || '');
      if (window.DFO?.render) window.DFO.render();
    });
  }
  window.__evGoDetail = (id) => { _ui.mode = 'detail'; _ui.detailId = id; _ui.detailTab = 'Info'; if (window.DFO?.render) window.DFO.render(); };
  window.__evBackToList = () => { _ui.mode = 'list'; _ui.detailId = null; _ui.wizard = null; if (window.DFO?.render) window.DFO.render(); };

  window.__evDuplicate = async (id) => {
    if (!window.confirm('Dit event dupliceren? Er wordt een nieuw concept aangemaakt (+7 dagen).\nJe komt direct in de bewerk-wizard om de juiste datum/tijd in te stellen.')) return;
    _ui.busy[id] = 'duplicate'; if (window.DFO?.render) window.DFO.render();
    try {
      const j = await window.KV.authedJson('/api/events-duplicate', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ source_event_id: id }) });
      if (j?.error) throw new Error(j.error);
      _showToast('Event gedupliceerd — pas nu de datum aan');
      // FIX punt 1 — open de gedupliceerde kopie direct in de bewerk-wizard
      const newId = j?.event_id || j?.event?.id;
      _live.events.data = null;
      queueMicrotask(() => fetchEvents());
      if (newId) {
        // Cache de nieuwe event-detail alvast met de response-data zodat de
        // wizard-edit prefill niet op een tweede fetch hoeft te wachten.
        if (j?.event) _live.detail.data[newId] = j.event;
        window.__evWizardOpen('edit', newId);
      }
    } catch (e) { alert('Dupliceren mislukt: ' + (e?.message || 'onbekende fout')); }
    finally { _ui.busy[id] = null; if (window.DFO?.render) window.DFO.render(); }
  };
  // Bug 2: kebab-dropdown ipv window.prompt(). State _ui.rowMenuOpen houdt
  // welke event-rij open is. Dropdown rendert absoluut onder de knop.
  // Document-listener sluit bij buiten-klik (installed eenmalig).
  window.__evRowMenu = (id, status) => {
    _ui.rowMenuOpen = _ui.rowMenuOpen === id ? null : id;
    _ui.attKebabOpen = null;
    if (window.DFO?.render) window.DFO.render();
  };
  function _evRowMenuHtml(e) {
    const items = [
      { l: 'Publiceren', k: 'publish',   show: e.status === 'draft' },
      { l: 'Bewerken',   k: 'edit',      show: true },
      { l: 'Dupliceren', k: 'duplicate', show: true },
      { l: 'Archiveren', k: 'archive',   show: e.status !== 'archived' },
      { l: 'Annuleren',  k: 'cancel',    show: !['cancelled','archived'].includes(e.status) },
    ].filter((it) => it.show);
    return `<div class="ev-kebab-menu" style="position:absolute;top:30px;right:0;min-width:180px;background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.15);z-index:100;padding:4px 0" onclick="event.stopPropagation()">
      ${items.map((it) => `<button style="width:100%;text-align:left;padding:8px 14px;background:none;border:none;color:var(--text);font-size:12.5px;cursor:pointer" onmouseover="this.style.background='var(--surface-2)'" onmouseout="this.style.background='none'" onclick="window.__evRowMenuDo('${esc(e.id)}','${esc(it.k)}')">${esc(it.l)}</button>`).join('')}
    </div>`;
  }
  window.__evRowMenuDo = (id, k) => {
    _ui.rowMenuOpen = null;
    if (k === 'archive')   return window.__evArchive(id);
    if (k === 'cancel')    return window.__evCancel(id);
    if (k === 'duplicate') return window.__evDuplicate(id);
    if (k === 'edit')      return window.__evWizardOpen('edit', id);
    if (k === 'publish')   return window.__evPublish ? window.__evPublish(id) : alert('Publiceren-endpoint niet gevonden.');
    if (window.DFO?.render) window.DFO.render();
  };
  window.__evArchive = async (id) => {
    if (!window.confirm('Event archiveren? Het verdwijnt uit de actieve lijst maar blijft bewaard.')) return;
    _ui.busy[id] = 'archive'; if (window.DFO?.render) window.DFO.render();
    try {
      const j = await window.KV.authedJson('/api/events-update?id=' + encodeURIComponent(id), { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ status:'archived' }) });
      if (j?.error) throw new Error(j.error);
      _showToast('Event gearchiveerd');
      _live.events.data = null; queueMicrotask(() => fetchEvents());
    } catch (e) { alert('Archiveren mislukt: ' + (e?.message || 'onbekende fout')); }
    finally { _ui.busy[id] = null; if (window.DFO?.render) window.DFO.render(); }
  };
  window.__evCancel = async (id) => {
    if (!window.confirm('Event annuleren? Deelnemers worden NIET automatisch geïnformeerd (doe dat apart).')) return;
    _ui.busy[id] = 'cancel'; if (window.DFO?.render) window.DFO.render();
    try {
      const j = await window.KV.authedJson('/api/events-update?id=' + encodeURIComponent(id), { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ status:'cancelled' }) });
      if (j?.error) throw new Error(j.error);
      _showToast('Event geannuleerd');
      _live.events.data = null; if (_ui.detailId === id) _live.detail.data[id] = null;
      queueMicrotask(() => fetchEvents());
      if (_ui.detailId === id) queueMicrotask(() => fetchDetail(id));
    } catch (e) { alert('Annuleren mislukt: ' + (e?.message || 'onbekende fout')); }
    finally { _ui.busy[id] = null; if (window.DFO?.render) window.DFO.render(); }
  };

  // ═══════════════════════════════════════════════════════════════════════
  // DETAIL — Header + 4 sub-tabs
  // ═══════════════════════════════════════════════════════════════════════
  function _detailView(id) {
    if (!_live.detail.data[id] && !_live.detail.loading[id] && !_live.detail.error[id]) queueMicrotask(() => fetchDetail(id));
    // BUG 5 FIX — prefetch attendees ZODRA detail-view opent, ongeacht welke sub-tab
    // je bent. Info-card "Aangemeld" leest dezelfde list.length als de Aanwezigen-tab.
    if (!_live.attendees.data[id] && !_live.attendees.loading[id] && !_live.attendees.error[id]) queueMicrotask(() => fetchAttendees(id));
    if (_live.detail.error[id] && !_live.detail.data[id]) return _backBar(id) + errBlk('detail', _live.detail.error[id], id);
    if (_live.detail.loading[id] && !_live.detail.data[id]) return _backBar(id) + skel();
    const ev = _live.detail.data[id] || {};
    // Injecteer id + attendees-list zodat _detailInfo één canonieke bron heeft.
    ev.id = ev.id || id;
    return _backBar(id) + _detailHeader(ev) + _detailTabs(ev) + _detailBody(ev);
  }

  function _backBar(id) {
    return `<div style="padding:12px 20px;background:var(--surface-2);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
      <button class="btn btn-ghost btn-sm" onclick="window.__evBackToList()">${svg(I.arrDown || I.x, 'width:13px;height:13px;transform:rotate(90deg)')}Terug naar overzicht</button>
      <span style="font-size:11px;color:var(--text-3);margin-left:auto">Event ID: <span class="mono">${esc(id).slice(0,8)}…</span></span>
    </div>`;
  }

  function _detailHeader(ev) {
    const [sc, sl] = STATUS_META[ev.status] || ['neutral', ev.status || '—'];
    const busyAny = _ui.busy[ev.id];
    return `<div style="padding:16px 20px;background:linear-gradient(135deg,var(--pink-soft),transparent);border-bottom:1px solid var(--border);display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">
      <span class="tile-ico" style="background:var(--pink-soft);color:var(--pink);width:44px;height:44px">${svg(I.cal, 'width:22px;height:22px')}</span>
      <div style="flex:1;min-width:200px">
        <div style="font-size:17px;font-weight:600">${esc(ev.title || '—')}</div>
        <div style="font-size:12.5px;color:var(--text-3);margin-top:3px;display:flex;gap:12px;flex-wrap:wrap">
          <span>${svg(I.cal, 'width:12px;height:12px;vertical-align:-1px')} ${esc(_fmtDateTime(ev.starts_at))}</span>
          ${ev.location ? `<span>📍 ${esc(ev.location)}</span>` : ''}
          ${ev.niveau ? `<span>Niveau: ${esc(ev.niveau)}</span>` : ''}
          ${ev.capacity != null ? `<span>Cap: ${esc(String(ev.capacity))}</span>` : ''}
        </div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        ${H.pill(sc, sl)}
        ${_detailActions(ev, busyAny)}
      </div>
    </div>`;
  }

  function _detailActions(ev, busy) {
    const btns = [];
    // Punt 1 — CANONIEKE afgerond-check: events-complete-core zet ALLEEN
    // completed_at/completed_by/completion_summary, NIET events.status. Een
    // afgerond event blijft dus status='published'. Enige betrouwbare marker:
    // ev.completed_at != null. Ook 'completed'/'afgerond' als extra safety-net
    // voor eventuele andere paden.
    const isAfgerond = !!ev.completed_at || ev.status === 'completed' || ev.status === 'afgerond';
    // ?debug=1 log: laat de echte status + completed_at zien zodat Jeffrey
    // kan verifiëren welke marker het event heeft.
    if (typeof window !== 'undefined' && String(window.location?.search || '').includes('debug=1')) {
      console.log('[events-v2 afrond-check]', { id: ev.id, status: ev.status, completed_at: ev.completed_at, isAfgerond, signups_closed: ev.signups_closed });
    }
    if (ev.status === 'draft') btns.push(`<button class="btn btn-primary btn-sm" ${busy ? 'disabled' : ''} onclick="window.__evPublish('${esc(ev.id)}')">${svg(I.rocket || I.tick)}${busy === 'publish' ? '…' : 'Publiceren'}</button>`);
    if (!isAfgerond && ev.status === 'published' && ev.signups_closed) btns.push(`<button class="btn btn-ghost btn-sm" ${busy ? 'disabled' : ''} onclick="window.__evReopen('${esc(ev.id)}')">Heropenen</button>`);
    else if (!isAfgerond && ev.status === 'published') btns.push(`<button class="btn btn-ghost btn-sm" ${busy ? 'disabled' : ''} onclick="window.__evCloseSignups('${esc(ev.id)}')">Sluiten voor aanmelding</button>`);
    // Punt 1 — Afrond-knop alleen zichtbaar bij published EN nog niet afgerond.
    if (!isAfgerond && ev.status === 'published') btns.push(`<button class="btn btn-ghost btn-sm" ${busy ? 'disabled' : ''} onclick="window.__evComplete('${esc(ev.id)}')">${busy === 'complete' ? '…' : 'Event afronden'}</button>`);
    btns.push(`<button class="btn btn-ghost btn-sm" onclick="window.__evWizardOpen('edit','${esc(ev.id)}')">${svg(I.edit || I.settings, 'width:12px;height:12px')}Bewerken</button>`);
    if (ev.status !== 'archived') btns.push(`<button class="icon-btn" title="Archiveren" ${busy ? 'disabled' : ''} onclick="window.__evArchive('${esc(ev.id)}')" style="width:28px;height:28px">${svg(I.trash || I.x, 'width:13px;height:13px')}</button>`);
    return btns.join('');
  }

  function _detailTabs(ev) {
    const tabs = ['Info', 'Aanwezigen', 'Audit'];
    if (ev.status === 'completed' || ev.status === 'afgerond') tabs.splice(2, 0, 'Mentoren');
    return `<div class="toolbar" style="padding:10px 20px 0;border-bottom:none;gap:6px;flex-wrap:wrap">
      ${tabs.map((t) => `<button class="chip ${_ui.detailTab === t ? 'on' : ''}" onclick="window.__evDetailTab('${t}')">${esc(t)}</button>`).join('')}
    </div>`;
  }
  window.__evDetailTab = (t) => { _ui.detailTab = t; if (window.DFO?.render) window.DFO.render(); };

  function _detailBody(ev) {
    if (_ui.detailTab === 'Aanwezigen') return _detailAanwezigen(ev);
    if (_ui.detailTab === 'Mentoren')   return _detailMentoren(ev);
    if (_ui.detailTab === 'Audit')      return _detailAudit(ev);
    return _detailInfo(ev);
  }

  function _detailInfo(ev) {
    // BUG 5 FIX (3e ronde) — Aanwezigen-tab-teller is autoritatief.
    // Aanwezigen-tab telt attendees-list.length (na server-side filter op
    // event_id + niet-verwijderd). Info-card MOET exact hetzelfde tonen.
    // Bron: /api/events-attendees-list?event_id=<id> → j.attendees|j.items.
    const attList = asArr(_live.attendees.data[ev.id]);
    const attLoading = _live.attendees.loading[ev.id];
    const attErr = _live.attendees.error[ev.id];
    // FIX (2026-08-18): 'Aangemeld' toont de bezetting-teller — exact dezelfde
    // definitie als getConfirmedCount (status IN ('aangemeld','aanwezig') AND
    // is_test=false AND assessment_response_id IS NOT NULL). Een switched_to_
    // other_event / geannuleerd / wachtlijst / no_show / is_test-attendee valt
    // buiten de bezetting — anders leek een event vol terwijl er plek was.
    // Sub-teller toont het totaal aantal rijen in de lijst (voor context bij
    // afwijking); alleen zichtbaar als verschillend van de bezetting.
    const CONFIRMED_STATUSES = ['aangemeld', 'aanwezig'];
    const confirmed = attList.filter((a) =>
      !a.is_test &&
      CONFIRMED_STATUSES.includes(a.status) &&
      !!a.assessment_response_id
    ).length;
    const showTot = attErr ? '—' : attLoading && attList.length === 0 ? '…' : String(confirmed);
    const showSub = (attList.length > 0 && confirmed !== attList.length)
      ? ` <span style="font-size:11px;color:var(--text-3)">(van ${attList.length} in lijst)</span>`
      : '';
    // ?debug=1 log: response-shape + getelde waarde, zodat Jeffrey in console
    // kan verifiëren dat we exact dezelfde list.length nemen als de tab.
    if (typeof window !== 'undefined' && String(window.location?.search || '').includes('debug=1')) {
      console.log('[events-v2 aangemeld-debug]', {
        event_id: ev.id,
        attendees_list_length: attList.length,
        attendees_loading: attLoading,
        attendees_error: attErr,
        confirmed_with_assessment: confirmed,
        events_detail_counts: ev.counts,
        first_attendee: attList[0] ? { id: attList[0].id, status: attList[0].status, assessment_response_id: attList[0].assessment_response_id } : null,
      });
    }
    return `<div class="pad" style="padding-top:14px"><div class="grid g2">
      <div class="card">
        <div class="card-head"><span class="tile-ico" style="background:var(--pink-soft);color:var(--pink)">${svg(I.cal)}</span><div class="card-title">Details</div></div>
        <div class="card-body">
          <div class="kv"><dt>Titel</dt><dd>${esc(ev.title || '—')}</dd></div>
          <div class="kv"><dt>Start</dt><dd>${esc(_fmtDateTime(ev.starts_at))}</dd></div>
          <div class="kv"><dt>Eind</dt><dd>${esc(_fmtDateTime(ev.ends_at))}</dd></div>
          <div class="kv"><dt>Locatie</dt><dd>${esc(ev.location || '—')}</dd></div>
          <div class="kv"><dt>Niveau</dt><dd>${esc(ev.niveau || '—')}</dd></div>
          <div class="kv"><dt>Capaciteit</dt><dd class="num">${esc(String(ev.capacity ?? '—'))}</dd></div>
          <div class="kv"><dt>Aangemeld</dt><dd class="num">${showTot}${showSub}</dd></div>
          <div class="kv"><dt>Signups</dt><dd>${ev.signups_closed ? H.pill('neutral','Gesloten') : H.pill('ok','Open')}</dd></div>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><span class="tile-ico" style="background:var(--blue-soft);color:var(--blue)">${svg(I.refresh || I.tick)}</span><div class="card-title">Sync-status</div></div>
        <div class="card-body">
          <div class="kv"><dt>deforexopleiding.nl</dt><dd>${_syncBadge(ev.webflow_sync_status, ev.webflow_last_synced_at)}</dd></div>
          <div class="kv"><dt>GoHighLevel</dt><dd>${_syncBadge(ev.ghl_sync_status, ev.ghl_last_synced_at)}</dd></div>
        </div>
        <div style="padding:11px 17px;background:var(--surface-2);border-top:1px solid var(--border);display:flex;gap:8px">
          <button class="btn btn-ghost btn-sm" onclick="window.__evSyncRetry('${esc(ev.id)}')">${svg(I.refresh || I.tick)}Sync opnieuw proberen</button>
        </div>
      </div>
    </div>
    <div class="card" style="margin-top:14px">
      <div class="card-head"><span class="tile-ico" style="background:var(--slate-soft);color:var(--slate)">${svg(I.doc || I.file)}</span><div class="card-title">Beschrijving</div></div>
      <div class="card-body" style="font-size:13px;line-height:1.55;color:var(--text-2);white-space:pre-wrap">${esc(ev.description_md || ev.description || '(geen beschrijving)')}</div>
    </div></div>`;
  }
  function _syncBadge(status, ts) {
    if (!status && !ts) return `<span style="color:var(--text-3)">niet gesynct</span>`;
    const s = status || (ts ? 'success' : 'onbekend');
    // BUG 2 FIX — 'success' + aliases → groen
    const cls = ['success','synced','ok'].includes(s) ? 'ok'
              : ['pending','queued','in_progress'].includes(s) ? 'warn'
              : 'danger';
    return `${H.pill(cls, s)} <span style="font-size:11px;color:var(--text-3);margin-left:6px">${ts ? _fmtDateTime(ts) : ''}</span>`;
  }
  window.__evSyncRetry = async (id) => {
    try {
      const j = await window.KV.authedJson('/api/events-sync-retry', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ id }) });
      if (j?.error) throw new Error(j.error);
      _showToast('Sync opnieuw gestart');
      _live.detail.data[id] = null; queueMicrotask(() => fetchDetail(id));
    } catch (e) { alert('Sync-retry mislukt: ' + (e?.message || 'onbekende fout')); }
  };

  // Detail-acties
  // Alle 3 endpoints (publish/close-signups/reopen-signups) lezen id uit
  // query-param (bevestigd in api-source). POST-method, geen body-id.
  window.__evPublish = async (id) => {
    if (!window.confirm('Event publiceren? Zichtbaar voor alle klanten die het kanaal volgen.')) return;
    _ui.busy[id] = 'publish'; if (window.DFO?.render) window.DFO.render();
    try {
      const j = await window.KV.authedJson('/api/events-publish?id=' + encodeURIComponent(id), { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
      if (j?.error) throw new Error(j.error);
      _showToast('Event gepubliceerd');
      _live.detail.data[id] = null; queueMicrotask(() => fetchDetail(id));
    } catch (e) { alert('Publiceren mislukt: ' + (e?.message || 'onbekende fout')); }
    finally { _ui.busy[id] = null; if (window.DFO?.render) window.DFO.render(); }
  };
  window.__evComplete = (id) => {
    // V1-parity — één-pagina modal met alle secties. Body-shape naar
    // events-complete-core:
    //   { event_id, basis_incl_btw, completion_summary,
    //     attendees:[{attendee_id, attendance_status, outcome?,
    //                 followup:{reason?, follow_up_date?, owner_id?}? }],
    //     present_team_member_ids:[uuid],
    //     expenses:[{amount, vendor, spent_at, note, mentor_team_member_ids:[uuid]}] }
    _ui.completeModal = { event_id: id };
    if (!_live.attendees.data[id]) queueMicrotask(() => fetchAttendees(id));
    if (!_live.mentors.data[id])   queueMicrotask(() => fetchMentors(id));
    _ui.completeForm = {
      basis_incl_btw: true,
      completion_summary: '',
      attendees: {},           // [attId] = { attendance_status, outcome, followup:{reason,follow_up_date,owner_id} }
      present_mentors: {},     // [team_member_id] = true
      expenses: [],            // [{ amount, vendor, spent_at, note, mentor_team_member_ids:[] }]
    };
    if (window.DFO?.render) window.DFO.render();
  };
  window.__evCloseSignups = async (id) => {
    try {
      const j = await window.KV.authedJson('/api/events-close-signups?id=' + encodeURIComponent(id), { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
      if (j?.error) throw new Error(j.error);
      _showToast('Aanmelding gesloten');
      _live.detail.data[id] = null; queueMicrotask(() => fetchDetail(id));
    } catch (e) { alert('Sluiten mislukt: ' + (e?.message || 'onbekende fout')); }
  };
  window.__evReopen = async (id) => {
    try {
      const j = await window.KV.authedJson('/api/events-reopen-signups?id=' + encodeURIComponent(id), { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
      if (j?.error) throw new Error(j.error);
      _showToast('Aanmelding heropend');
      _live.detail.data[id] = null; queueMicrotask(() => fetchDetail(id));
    } catch (e) { alert('Heropenen mislukt: ' + (e?.message || 'onbekende fout')); }
  };

  // ═══════════════════════════════════════════════════════════════════════
  // BUG 2 — EVENT AFRONDEN MODAL (v1-parity via events-complete)
  // ═══════════════════════════════════════════════════════════════════════
  // Body-shape events-complete (bevestigd tegen api/_lib/events-complete-core.js):
  //   { event_id, attendees:[{id, attendance_status, outcome?, reason?}],
  //     present_team_member_ids:[uuid], expenses:[{team_member_id, amount, description?}] }
  //   attendance_status ∈ {'aanwezig','no_show','afgemeld'}
  //   outcome ∈ {'opvolgen','geen_interesse','nog_onbekend','klant_geworden','twijfelt_nog'}
  //   Bonus = 3% van sale (BONUS_PCT) — server-side.
  // Alle enum-waarden 1-op-1 uit events-complete-core.js (regel 22-33)
  const COMPLETE_ATT_STATUS = [
    { v: 'aanwezig', l: 'Aanwezig', c: 'ok'       },
    { v: 'no_show',  l: 'No-show',  c: 'danger'   },
    { v: 'afgemeld', l: 'Afgemeld', c: 'neutral'  },
  ];
  const COMPLETE_OUTCOMES = [
    { v: '',                l: '— kies uitkomst —' },
    { v: 'opvolgen',        l: 'Opvolgen (follow-up)' },
    { v: 'twijfelt_nog',    l: 'Twijfelt nog (follow-up)' },
    { v: 'klant_geworden',  l: 'Klant geworden' },
    { v: 'geen_interesse',  l: 'Geen interesse' },
    { v: 'nog_onbekend',    l: 'Nog onbekend' },
  ];
  // V1-parity: snelle reden-presets voor follow-up
  const FU_REASON_PRESETS = [
    'Overweegt aankoop',
    'Meer informatie sturen',
    'Timing/budget nu niet',
    'Wil eerst met partner overleggen',
    'Zeker interesse — bel volgende week',
  ];

  window.__evCompleteClose = () => { _ui.completeModal = null; _ui.completeForm = null; if (window.DFO?.render) window.DFO.render(); };
  window.__evCompleteTop = (field, val) => { if (_ui.completeForm) { _ui.completeForm[field] = val; if (field === 'basis_incl_btw' && window.DFO?.render) window.DFO.render(); } };
  window.__evCompleteAttSet = (attId, field, val) => {
    if (!_ui.completeForm) return;
    _ui.completeForm.attendees[attId] = _ui.completeForm.attendees[attId] || {};
    _ui.completeForm.attendees[attId][field] = val;
    if (field === 'attendance_status' || field === 'outcome') {
      // Reset gerelateerde velden bij status-wissel
      if (field === 'attendance_status' && val !== 'aanwezig') {
        _ui.completeForm.attendees[attId].outcome = '';
        _ui.completeForm.attendees[attId].followup = null;
      }
      if (field === 'outcome' && val !== 'opvolgen' && val !== 'twijfelt_nog') {
        _ui.completeForm.attendees[attId].followup = null;
      }
      if (field === 'outcome' && (val === 'opvolgen' || val === 'twijfelt_nog')) {
        _ui.completeForm.attendees[attId].followup = _ui.completeForm.attendees[attId].followup || { reason:'', follow_up_date:'' };
      }
      if (window.DFO?.render) window.DFO.render();
    }
  };
  window.__evCompleteFuSet = (attId, field, val) => {
    if (!_ui.completeForm) return;
    const a = _ui.completeForm.attendees[attId] = _ui.completeForm.attendees[attId] || {};
    a.followup = a.followup || {};
    a.followup[field] = val;
  };
  window.__evCompleteFuPreset = (attId, days) => {
    const d = new Date(); d.setDate(d.getDate() + days);
    const p = (n) => String(n).padStart(2, '0');
    window.__evCompleteFuSet(attId, 'follow_up_date', d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()));
    if (window.DFO?.render) window.DFO.render();
  };
  window.__evCompleteMentorToggle = (tmId) => {
    if (!_ui.completeForm) return;
    _ui.completeForm.present_mentors[tmId] = !_ui.completeForm.present_mentors[tmId];
    if (window.DFO?.render) window.DFO.render();
  };
  window.__evCompleteExpenseAdd = () => {
    if (!_ui.completeForm) return;
    _ui.completeForm.expenses.push({ amount:'', vendor:'', spent_at:'', note:'', mentor_team_member_ids:[] });
    if (window.DFO?.render) window.DFO.render();
  };
  window.__evCompleteExpenseSet = (idx, field, val) => {
    if (!_ui.completeForm || !_ui.completeForm.expenses[idx]) return;
    _ui.completeForm.expenses[idx][field] = val;
  };
  window.__evCompleteExpenseMentorToggle = (idx, tmId) => {
    if (!_ui.completeForm || !_ui.completeForm.expenses[idx]) return;
    const arr = _ui.completeForm.expenses[idx].mentor_team_member_ids || [];
    const at = arr.indexOf(tmId);
    if (at >= 0) arr.splice(at, 1); else arr.push(tmId);
    _ui.completeForm.expenses[idx].mentor_team_member_ids = arr;
    if (window.DFO?.render) window.DFO.render();
  };
  window.__evCompleteExpenseRemove = (idx) => {
    if (!_ui.completeForm) return;
    _ui.completeForm.expenses.splice(idx, 1);
    if (window.DFO?.render) window.DFO.render();
  };

  function _completeModal() {
    const m = _ui.completeModal;
    const form = _ui.completeForm || { attendees:{}, present_mentors:{}, expenses:[], basis_incl_btw:true, completion_summary:'' };
    const eventId = m.event_id;
    const attListAll = asArr(_live.attendees.data[eventId]);
    // V1 filter (bron: events-detail.html:2577): alleen 'aangemeld' + 'aanwezig'
    // status in de afronding-lijst (no-shows/geannuleerden zitten niet in de flow).
    const attList = attListAll.filter((a) => a.status === 'aangemeld' || a.status === 'aanwezig');
    const mentorList = asArr(_live.mentors.data[eventId]);
    const attLoad = _live.attendees.loading[eventId];
    const menLoad = _live.mentors.loading[eventId];
    const presentMentorIds = Object.keys(form.present_mentors).filter((k) => form.present_mentors[k]);

    return `<div style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9998;display:flex;align-items:flex-start;justify-content:center;padding:20px;overflow:auto" onclick="window.__evCompleteClose()">
      <div style="background:var(--surface);border-radius:var(--r-lg);max-width:920px;width:100%;max-height:calc(100vh - 40px);overflow:auto;padding:0" onclick="event.stopPropagation()">
        <div style="padding:16px 22px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;position:sticky;top:0;background:var(--surface);z-index:2">
          <span class="tile-ico" style="background:var(--pink-soft);color:var(--pink)">${svg(I.tick)}</span>
          <div style="flex:1"><div class="card-title">Event afronden</div>
            <div style="font-size:11.5px;color:var(--text-3)">Aanwezigheid + outcome per deelnemer · aanwezige mentoren · uitgaven per mentor · samenvatting. Bonus 3% van sales wordt automatisch berekend en gelijk verdeeld over aanwezige mentoren.</div></div>
          <button class="icon-btn" onclick="window.__evCompleteClose()">${svg(I.x)}</button>
        </div>

        <div style="padding:18px 22px;display:flex;flex-direction:column;gap:20px">

          <!-- Basis-toggle -->
          <div style="display:flex;gap:10px;align-items:center;padding:10px 14px;background:var(--surface-2);border-radius:8px">
            <input type="checkbox" id="ev_basis_btw" ${form.basis_incl_btw ? 'checked' : ''} onchange="window.__evCompleteTop('basis_incl_btw', this.checked)" />
            <label for="ev_basis_btw" style="font-size:12.5px;cursor:pointer">Bonus berekenen <b>inclusief BTW</b> (uit deal.total_amount incl.) — uitzetten voor bonus excl. BTW.</label>
          </div>

          <!-- Sectie 1: Aanwezigheid + outcome + follow-up per attendee -->
          <div>
            <div style="font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3);margin-bottom:8px">1. Aanwezigheid per deelnemer (${attList.length})</div>
            ${attLoad && attList.length === 0 ? skel() : attList.length === 0
              ? `<div style="font-size:13px;color:var(--text-3);padding:16px;text-align:center;background:var(--surface-2);border-radius:8px">Geen deelnemers met status 'aangemeld' of 'aanwezig'.</div>`
              : `<div style="border:1px solid var(--border);border-radius:8px;overflow:hidden">
                  ${attList.map((a) => _completeAttendeeRow(a, form)).join('')}
                </div>`}
            <div style="font-size:11px;color:var(--text-3);margin-top:6px">Sales worden vóór afronding via ⋯-menu (Aanwezigen-tab → "Offerte aanmaken") aan een deelnemer gekoppeld. Bonus rekent daarna automatisch mee.</div>
          </div>

          <!-- Sectie 2: Mentoren -->
          <div>
            <div style="font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3);margin-bottom:8px">2. Welke mentoren waren aanwezig? (${presentMentorIds.length} gekozen)</div>
            ${menLoad && mentorList.length === 0 ? skel() : mentorList.length === 0
              ? `<div style="font-size:13px;color:var(--text-3);padding:16px;text-align:center;background:var(--surface-2);border-radius:8px">Geen mentoren gevonden.</div>`
              : `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:6px">
                  ${mentorList.map((m) => {
                    const tmId = m.team_member_id || m.id;
                    const naam = m.name || m.full_name || '—';
                    const on = !!form.present_mentors[tmId];
                    return `<label style="display:flex;gap:8px;align-items:center;padding:9px 11px;border:1px solid ${on ? 'var(--pink-line)' : 'var(--border)'};border-radius:8px;cursor:pointer;background:${on ? 'var(--pink-soft)' : 'var(--surface)'}">
                      <input type="checkbox" ${on ? 'checked' : ''} onchange="window.__evCompleteMentorToggle('${esc(tmId)}')" style="margin:0" />
                      <span style="font-size:12.5px;font-weight:500">${esc(naam)}</span>
                      ${m.role ? `<span style="font-size:10.5px;color:var(--text-3);margin-left:auto">${esc(m.role)}</span>` : ''}
                    </label>`;
                  }).join('')}
                </div>`}
          </div>

          <!-- Sectie 3: Uitgaven per mentor -->
          <div>
            <div style="font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3);margin-bottom:8px">3. Uitgaven ${form.expenses.length ? `(${form.expenses.length})` : ''}</div>
            ${form.expenses.length === 0
              ? `<div style="font-size:12.5px;color:var(--text-3);padding:12px;text-align:center;background:var(--surface-2);border-radius:8px;margin-bottom:8px">Nog geen uitgaven toegevoegd. Klik hieronder om te starten.</div>`
              : `<div style="display:flex;flex-direction:column;gap:10px;margin-bottom:8px">
                  ${form.expenses.map((e, i) => _completeExpenseRow(e, i, mentorList, presentMentorIds)).join('')}
                </div>`}
            <button class="btn btn-ghost btn-sm" onclick="window.__evCompleteExpenseAdd()">${svg(I.plus)}Uitgave toevoegen</button>
          </div>

          <!-- Sectie 4: Samenvatting -->
          <div>
            <div style="font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3);margin-bottom:8px">4. Korte samenvatting (optioneel)</div>
            <textarea placeholder="Wat viel op? Wat is de vervolgstrategie? Etc." oninput="window.__evCompleteTop('completion_summary', this.value)" style="width:100%;min-height:80px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);font-size:13px;font-family:inherit;resize:vertical">${esc(form.completion_summary || '')}</textarea>
          </div>

        </div>

        <div style="padding:14px 22px;border-top:1px solid var(--border);background:var(--surface-2);display:flex;gap:8px;justify-content:space-between;align-items:center;position:sticky;bottom:0">
          <div style="font-size:11.5px;color:var(--text-3)">Bonus wordt automatisch berekend: <b>3% van sale-bedrag</b> (${form.basis_incl_btw ? 'incl.' : 'excl.'} BTW), gelijk verdeeld over de <b>${presentMentorIds.length}</b> aanwezige mentor${presentMentorIds.length === 1 ? '' : 'en'}.</div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-ghost btn-sm" onclick="window.__evCompleteClose()">Annuleren</button>
            <button class="btn btn-primary btn-sm" onclick="window.__evCompleteSubmit()">${svg(I.tick)}Event afronden</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  function _completeAttendeeRow(a, form) {
    const naam = [a.first_name, a.last_name].filter(Boolean).join(' ') || a.email || '—';
    const cur = form.attendees[a.id] || {};
    const st = cur.attendance_status || '';
    const oc = cur.outcome || '';
    const fu = cur.followup || {};
    const showFu = oc === 'opvolgen' || oc === 'twijfelt_nog';
    const hasDeal = !!a.deal_id;
    const stColor = COMPLETE_ATT_STATUS.find((x) => x.v === st)?.c || 'neutral';
    return `<div style="padding:12px 14px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:8px">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        ${H.av(naam, 26)}
        <div style="flex:1;min-width:150px">
          <div style="font-size:13px;font-weight:500">${esc(naam)}</div>
          <div style="font-size:11px;color:var(--text-3)">${esc(a.email || '')}${hasDeal ? ' · ' + H.pill('accent', 'Sale gekoppeld', true) : ''}</div>
        </div>
        <!-- Status-pills -->
        <div style="display:flex;gap:4px">
          ${COMPLETE_ATT_STATUS.map((o) => `<button class="chip ${st === o.v ? 'on' : ''}" style="padding:5px 10px;font-size:11.5px${st === o.v ? ';background:var(--' + o.c + '-soft);color:var(--' + o.c + ');border-color:var(--' + o.c + '-line)' : ''}" onclick="window.__evCompleteAttSet('${esc(a.id)}','attendance_status','${o.v}')">${esc(o.l)}</button>`).join('')}
        </div>
        ${st === 'aanwezig' ? `<select onchange="window.__evCompleteAttSet('${esc(a.id)}','outcome',this.value)" style="padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:12px;min-width:180px">
          ${COMPLETE_OUTCOMES.map((o) => `<option value="${o.v}" ${oc === o.v ? 'selected' : ''}>${o.l}</option>`).join('')}
        </select>` : ''}
      </div>
      ${showFu ? _completeFollowupBlock(a.id, fu) : ''}
    </div>`;
  }
  function _completeFollowupBlock(attId, fu) {
    return `<div style="padding:10px 12px;background:var(--amber-soft);border:1px solid var(--amber-line);border-radius:8px;display:flex;flex-direction:column;gap:8px">
      <div style="font-size:11.5px;color:var(--amber);font-weight:500">Follow-up plannen (verplicht bij opvolgen / twijfelt nog):</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
        <span style="font-size:11.5px;color:var(--text-3)">Termijn:</span>
        <button class="chip" style="padding:4px 9px;font-size:11.5px" onclick="window.__evCompleteFuPreset('${esc(attId)}',7)">+1 week</button>
        <button class="chip" style="padding:4px 9px;font-size:11.5px" onclick="window.__evCompleteFuPreset('${esc(attId)}',14)">+2 weken</button>
        <button class="chip" style="padding:4px 9px;font-size:11.5px" onclick="window.__evCompleteFuPreset('${esc(attId)}',21)">+3 weken</button>
        <input type="date" value="${esc(fu.follow_up_date || '')}" oninput="window.__evCompleteFuSet('${esc(attId)}','follow_up_date',this.value)" style="padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:12px" />
      </div>
      <div style="display:flex;gap:6px;align-items:center">
        <select onchange="window.__evCompleteFuSet('${esc(attId)}','reason',this.value);window.DFO && window.DFO.render && window.DFO.render()" style="padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:12px;flex:1">
          <option value="">— reden-preset —</option>
          ${FU_REASON_PRESETS.map((p) => `<option value="${esc(p)}" ${fu.reason === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}
        </select>
      </div>
      <input type="text" placeholder="Notitie (verplicht) — bv. specifieke afspraak/situatie" value="${esc(fu.reason || '')}" oninput="window.__evCompleteFuSet('${esc(attId)}','reason',this.value)" style="padding:6px 10px;border:1px solid var(--amber-line);background:var(--surface);border-radius:6px;font-size:12.5px" />
    </div>`;
  }
  function _completeExpenseRow(e, i, mentorList, presentMentorIds) {
    // Alleen aanwezige mentoren tonen als toewijs-optie (v1-parity — de expense
    // wordt server-side verdeeld over deze mentoren; leeg = alle aanwezigen).
    const presentMentors = mentorList.filter((m) => presentMentorIds.includes(m.team_member_id || m.id));
    const targetIds = Array.isArray(e.mentor_team_member_ids) ? e.mentor_team_member_ids : [];
    return `<div style="padding:12px;background:var(--surface-2);border-radius:8px;display:flex;flex-direction:column;gap:8px">
      <div style="display:grid;grid-template-columns:120px 1.5fr 130px auto;gap:8px;align-items:center">
        <input type="number" step="0.01" min="0" placeholder="€ bedrag" value="${esc(e.amount)}" oninput="window.__evCompleteExpenseSet(${i},'amount',this.value)" style="padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:12.5px" />
        <input type="text" placeholder="Leverancier / vendor" value="${esc(e.vendor || '')}" oninput="window.__evCompleteExpenseSet(${i},'vendor',this.value)" style="padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:12.5px" />
        <input type="date" value="${esc(e.spent_at || '')}" oninput="window.__evCompleteExpenseSet(${i},'spent_at',this.value)" style="padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:12.5px" />
        <button class="icon-btn" title="Uitgave verwijderen" onclick="window.__evCompleteExpenseRemove(${i})">${svg(I.trash || I.x, 'width:13px;height:13px')}</button>
      </div>
      <input type="text" placeholder="Omschrijving / notitie" value="${esc(e.note || '')}" oninput="window.__evCompleteExpenseSet(${i},'note',this.value)" style="padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);font-size:12.5px" />
      <div>
        <div style="font-size:11px;color:var(--text-3);margin-bottom:4px">Toewijzen aan mentor(en) — leeg = verdelen over alle aanwezigen:</div>
        ${presentMentors.length === 0
          ? `<div style="font-size:11.5px;color:var(--text-3);padding:6px 0">⚠ Selecteer eerst aanwezige mentoren (sectie 2) om deze uitgave gericht toe te wijzen.</div>`
          : `<div style="display:flex;gap:5px;flex-wrap:wrap">
              ${presentMentors.map((m) => {
                const tmId = m.team_member_id || m.id;
                const on = targetIds.includes(tmId);
                return `<label style="display:inline-flex;gap:5px;align-items:center;padding:3px 8px;border:1px solid ${on ? 'var(--pink-line)' : 'var(--border)'};border-radius:14px;font-size:11.5px;cursor:pointer;background:${on ? 'var(--pink-soft)' : 'var(--surface)'}">
                  <input type="checkbox" ${on ? 'checked' : ''} onchange="window.__evCompleteExpenseMentorToggle(${i},'${esc(tmId)}')" style="margin:0" />
                  ${esc(m.name || m.full_name || '—')}
                </label>`;
              }).join('')}
            </div>`}
      </div>
    </div>`;
  }

  window.__evCompleteSubmit = async () => {
    const m = _ui.completeModal; const form = _ui.completeForm;
    if (!m || !form) return;
    // Bouw body 1-op-1 volgens events-complete-core.js body-shape.
    const attendees = Object.entries(form.attendees)
      .filter(([, v]) => v.attendance_status)
      .map(([attId, v]) => {
        const row = { attendee_id: attId, attendance_status: v.attendance_status };
        if (v.attendance_status === 'aanwezig' && v.outcome) row.outcome = v.outcome;
        if ((v.outcome === 'opvolgen' || v.outcome === 'twijfelt_nog') && v.followup) {
          const fu = {};
          if (v.followup.reason)         fu.reason = v.followup.reason;
          if (v.followup.follow_up_date) fu.follow_up_date = v.followup.follow_up_date;
          if (v.followup.owner_id)       fu.owner_id = v.followup.owner_id;
          if (Object.keys(fu).length) row.followup = fu;
        }
        return row;
      });
    // Validate: opvolgen/twijfelt_nog vereist reason (server valideert ook)
    for (const a of attendees) {
      if ((a.outcome === 'opvolgen' || a.outcome === 'twijfelt_nog') && !a.followup?.reason) {
        alert('Follow-up-notitie ontbreekt voor minstens één deelnemer met outcome "' + a.outcome + '".');
        return;
      }
    }
    const present_team_member_ids = Object.keys(form.present_mentors).filter((k) => form.present_mentors[k]);
    const expenses = form.expenses
      .filter((e) => Number(e.amount) > 0)
      .map((e) => {
        const row = { amount: Number(e.amount) };
        if (e.vendor)  row.vendor  = e.vendor;
        if (e.spent_at) row.spent_at = e.spent_at;
        if (e.note)    row.note    = e.note;
        if (Array.isArray(e.mentor_team_member_ids) && e.mentor_team_member_ids.length) {
          row.mentor_team_member_ids = e.mentor_team_member_ids;
        }
        return row;
      });

    if (attendees.length === 0 && !window.confirm('Geen enkele aanwezigheid gezet — wil je toch afronden?')) return;

    try {
      const body = {
        event_id: m.event_id,
        basis_incl_btw: form.basis_incl_btw !== false,
        completion_summary: form.completion_summary || '',
        attendees,
        present_team_member_ids,
        expenses,
      };
      const j = await window.KV.authedJson('/api/events-complete', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
      if (j?.error) throw new Error(j.error);
      _showToast('Event afgerond ✓ — follow-ups en bonussen geboekt');
      const id = m.event_id;
      _ui.completeModal = null; _ui.completeForm = null;
      _live.detail.data[id] = null; _live.completed.data = null; _live.completedOne.data[id] = null;
      _live.attendees.data[id] = null;
      queueMicrotask(() => fetchDetail(id));
      queueMicrotask(() => fetchAttendees(id));
      queueMicrotask(fetchCompleted);
      if (window.DFO?.render) window.DFO.render();
    } catch (e) { alert('Afronden mislukt: ' + (e?.message || 'onbekende fout')); }
  };

  // ── DETAIL — AANWEZIGEN ─────────────────────────────────────────────────
  const ATT_STATUS_META = {
    aangemeld:              ['neutral','Aangemeld'],
    aanwezig:               ['ok','Aanwezig'],
    no_show:                ['danger','No-show'],
    sale:                   ['accent','Sale'],
    switched_to_other_event:['warn','Verplaatst'],
    geannuleerd:            ['neutral','Geannuleerd'],
  };
  function _detailAanwezigen(ev) {
    const id = ev.id;
    if (!_live.attendees.data[id] && !_live.attendees.loading[id] && !_live.attendees.error[id]) queueMicrotask(() => fetchAttendees(id));
    if (_live.attendees.error[id] && !_live.attendees.data[id]) return errBlk('attendees', _live.attendees.error[id], id);
    if (_live.attendees.loading[id] && !_live.attendees.data[id]) return skel();
    const all = asArr(_live.attendees.data[id]);
    const filter = _ui.attStatusFilter;
    const rows = filter === 'all' ? all : all.filter((a) => a.status === filter);

    // Counts per status
    const counts = { all: all.length };
    for (const k of Object.keys(ATT_STATUS_META)) counts[k] = all.filter((a) => a.status === k).length;

    return `<div class="toolbar" style="padding:10px 20px;gap:6px;flex-wrap:wrap">
      <button class="chip ${filter === 'all' ? 'on' : ''}" onclick="window.__evAttFilter('all')">Alles<span class="cnt">${counts.all}</span></button>
      ${Object.keys(ATT_STATUS_META).map((k) => `<button class="chip ${filter === k ? 'on' : ''}" onclick="window.__evAttFilter('${k}')">${esc(ATT_STATUS_META[k][1])}<span class="cnt">${counts[k]}</span></button>`).join('')}
    </div>
    ${rows.length === 0
      ? emptyBlk('Geen deelnemers', 'Er zijn geen deelnemers in deze categorie.')
      : `<div style="padding:0 20px 20px">${H.table(
          [{l:'Naam'},{l:'E-mail',cls:'optional'},{l:'Telefoon',cls:'optional'},{l:'Status'},{l:'Aanmelddatum',cls:'optional'},{l:'Vragenlijst',cls:'optional'},{l:'Belstatus'},{l:'',cls:'r'}],
          rows.map((a) => {
            const naam = [a.first_name || a.voornaam, a.last_name || a.achternaam].filter(Boolean).join(' ') || a.name || a.email || '—';
            const [sc, sl] = ATT_STATUS_META[a.status] || ['neutral', a.status || '—'];
            const hasQuest = !!(a.assessment_response_id || a.questionnaire_completed_at);
            // BUG 6 — belstatus als dropdown ipv pill
            return [
              `<a href="#" onclick="event.preventDefault();window.__evAttOpen('${esc(a.id)}','${esc(id)}')" title="Bekijk deelnemer-detail" style="color:inherit;text-decoration:none;display:inline-block"><div class="row-avatar">${H.av(naam, 26)}<span class="cell-main" style="text-decoration:underline;text-decoration-color:var(--border);text-underline-offset:2px">${esc(naam)}</span></div></a>`,
              `<span style="color:var(--text-3);font-size:12.5px">${esc(a.email || '—')}</span>`,
              `<span class="mono" style="color:var(--text-3);font-size:12px">${esc(a.phone || a.telefoon || '—')}</span>`,
              H.pill(sc, sl),
              `<span class="mono" style="color:var(--text-3);font-size:12px">${esc(_fmtDate(a.registered_at || a.created_at))}</span>`,
              hasQuest
                ? `<span title="Vragenlijst ingevuld" style="color:var(--emerald);font-size:14px">✓</span>`
                : `<span title="Vragenlijst nog niet ingevuld" style="color:var(--rose);font-size:14px">✗</span>`,
              _belStatusDropdown(a, id),
              `<div style="position:relative;display:inline-block"><button class="icon-btn" title="Meer" onclick="event.stopPropagation();window.__evAttKebab('${esc(a.id)}','${esc(id)}')" style="width:26px;height:26px">${svg(I.dots || I.settings,'width:13px;height:13px')}</button>${_ui.attKebabOpen === a.id ? _evAttKebabHtml(a.id, id) : ''}</div>`,
            ];
          })
        )}</div>`}`;
  }

  // BUG 6 + 7 — Belstatus als inline-dropdown die schrijft naar
  // events-attendee-update (PATCH ?id=<uuid> body {call_status}). Bevestigd →
  // groene pill-achtige styling; overige = neutral/warn/danger.
  const CALL_STATUS_OPTIONS = [
    { v: '',              l: '— nog niet gebeld —' },
    { v: 'bevestigd',     l: 'Bevestigd' },
    { v: 'gebeld',        l: 'Gebeld' },
    { v: 'geen_gehoor',   l: 'Geen gehoor' },
    { v: 'voicemail',     l: 'Voicemail' },
    { v: 'komt_niet',     l: 'Komt niet' },
    { v: 'terugbellen',   l: 'Terugbellen' },
  ];
  function _belStatusColor(cs) {
    const s = String(cs || '').toLowerCase();
    if (s === 'bevestigd' || s === 'confirmed' || s === 'gebeld' || s === 'called' || s === 'reached') return { bg:'var(--emerald-soft)', fg:'var(--emerald)', bd:'var(--emerald-line)' };
    if (s === 'geen_gehoor' || s === 'no_answer' || s === 'voicemail' || s === 'left_message' || s === 'terugbellen') return { bg:'var(--amber-soft)', fg:'var(--amber)', bd:'var(--amber-line)' };
    if (s === 'komt_niet' || s === 'declined' || s === 'wrong_number' || s === 'cancelled') return { bg:'var(--slate-soft, var(--surface-2))', fg:'var(--text-2)', bd:'var(--border)' };
    return { bg:'var(--surface)', fg:'var(--text-3)', bd:'var(--border)' };
  }
  function _belStatusDropdown(a, eventId) {
    const cur = String(a.call_status || '').toLowerCase();
    const col = _belStatusColor(cur);
    const busy = _ui.belBusy[a.id];
    // Als backend enum-waarde onbekend is in onze lijst, prepend die zodat 't
    // niet magisch verandert bij render.
    const opts = CALL_STATUS_OPTIONS.slice();
    if (cur && !opts.some((o) => o.v === cur)) opts.unshift({ v: cur, l: cur + ' (huidig)' });
    return `<select ${busy ? 'disabled' : ''} onchange="window.__evAttSetCallStatus('${esc(a.id)}','${esc(eventId)}',this.value)" style="padding:5px 8px;border:1px solid ${col.bd};background:${col.bg};color:${col.fg};border-radius:6px;font-size:12px;font-weight:500;${busy ? 'opacity:.5;cursor:wait' : 'cursor:pointer'}">
      ${opts.map((o) => `<option value="${esc(o.v)}" ${o.v === cur ? 'selected' : ''}>${esc(o.l)}</option>`).join('')}
    </select>`;
  }
  window.__evAttSetCallStatus = async (attId, eventId, newStatus) => {
    _ui.belBusy[attId] = true; if (window.DFO?.render) window.DFO.render();
    try {
      const body = { call_status: newStatus || null };
      const j = await window.KV.authedJson('/api/events-attendee-update?id=' + encodeURIComponent(attId), { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
      if (j?.error) throw new Error(j.error);
      _showToast('Belstatus bijgewerkt');
      // Update local state defensief zodat re-render meteen klopt
      const list = _live.attendees.data[eventId];
      if (Array.isArray(list)) {
        const idx = list.findIndex((x) => x.id === attId);
        if (idx >= 0) list[idx] = { ...list[idx], call_status: newStatus || null, call_status_at: new Date().toISOString() };
      }
    } catch (e) { alert('Belstatus bijwerken mislukt: ' + (e?.message || 'onbekende fout')); }
    finally { _ui.belBusy[attId] = false; if (window.DFO?.render) window.DFO.render(); }
  };
  function _tagChips(tags) {
    if (!Array.isArray(tags) || tags.length === 0) return '<span style="color:var(--text-3);font-size:11px">—</span>';
    return tags.slice(0, 3).map((t) => `<span class="pill pill-neutral nodot" style="font-size:10px;padding:1px 6px;margin-right:3px">${esc(t.label || t.name || t)}</span>`).join('')
      + (tags.length > 3 ? `<span style="font-size:10px;color:var(--text-3)">+${tags.length - 3}</span>` : '');
  }
  window.__evAttFilter = (v) => { _ui.attStatusFilter = v; if (window.DFO?.render) window.DFO.render(); };
  // Bug 2: attendee-kebab-dropdown ipv window.prompt() met 8 opties.
  window.__evAttKebab = (attId, eventId) => {
    _ui.attKebabOpen = _ui.attKebabOpen === attId ? null : attId;
    _ui.rowMenuOpen = null;
    if (window.DFO?.render) window.DFO.render();
  };
  function _evAttKebabHtml(attId, eventId) {
    const items = [
      { l: 'Bewerken',                     k: 'edit' },
      { l: 'Stuur keuze-link',             k: 'invite' },
      { l: 'Stuur vragenlijst',            k: 'quest' },
      { l: 'Verplaatsen naar ander event', k: 'move' },
      { l: 'Offerte aanmaken',             k: 'offerte' },
      { l: 'Tag toevoegen',                k: 'tagadd' },
      { l: 'Tag verwijderen',              k: 'tagrem' },
      { l: 'Verwijderen',                  k: 'delete', danger: true },
    ];
    return `<div class="ev-kebab-menu" style="position:absolute;top:30px;right:0;min-width:220px;background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.15);z-index:100;padding:4px 0" onclick="event.stopPropagation()">
      ${items.map((it) => `<button style="width:100%;text-align:left;padding:8px 14px;background:none;border:none;color:${it.danger ? 'var(--rose)' : 'var(--text)'};font-size:12.5px;cursor:pointer" onmouseover="this.style.background='var(--surface-2)'" onmouseout="this.style.background='none'" onclick="window.__evAttKebabDo('${esc(attId)}','${esc(eventId)}','${esc(it.k)}')">${esc(it.l)}</button>`).join('')}
    </div>`;
  }
  window.__evAttKebabDo = (attId, eventId, k) => {
    _ui.attKebabOpen = null;
    const actions = {
      edit:    () => window.__evAttEdit(attId, eventId),
      invite:  () => window.__evAttSendInvite(attId, eventId),
      quest:   () => window.__evAttSendQuest(attId, eventId),
      move:    () => window.__evAttMove(attId, eventId),
      offerte: () => window.__evAttToOfferte(attId, eventId),
      tagadd:  () => window.__evAttTagAdd(attId, eventId),
      tagrem:  () => window.__evAttTagRemove(attId, eventId),
      delete:  () => window.__evAttDelete(attId, eventId),
    };
    const fn = actions[k]; if (fn) fn();
    else if (window.DFO?.render) window.DFO.render();
  };
  // Document-level click-listener om kebab-dropdowns te sluiten bij buiten-klik.
  // Eenmalig installeren (guard tegen dubbele bind bij render).
  if (!window.__evKebabDocBound) {
    window.__evKebabDocBound = true;
    document.addEventListener('click', () => {
      if (_ui.rowMenuOpen || _ui.attKebabOpen) {
        _ui.rowMenuOpen = null; _ui.attKebabOpen = null;
        if (window.DFO?.render) window.DFO.render();
      }
    });
  }
  // Escape-keydown → sluit open modal-overlays (attendee-detail eerst, dan
  // complete-modal). De close-knop belooft "Sluiten (Esc)" maar de listener
  // ontbrak. Guarded voor dubbele bind bij render.
  if (!window.__evEscDocBound) {
    window.__evEscDocBound = true;
    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return;
      if (_ui.attDetail) { ev.preventDefault(); if (typeof window.__evAttClose === 'function') window.__evAttClose(); return; }
      if (_ui.completeModal) { ev.preventDefault(); _ui.completeModal = null; _evRemovePortal('ev-modal'); if (window.DFO?.render) window.DFO.render(); return; }
    });
  }

  // Kebab-actie handlers — thin wrappers over bestaande endpoints
  async function _post(url, body, okMsg, refreshEvent) {
    try {
      const j = await window.KV.authedJson(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
      if (j?.error) throw new Error(j.error);
      _showToast(okMsg || 'Klaar');
      if (refreshEvent) { _live.attendees.data[refreshEvent] = null; queueMicrotask(() => fetchAttendees(refreshEvent)); }
      return j;
    } catch (e) { alert('Actie mislukt: ' + (e?.message || 'onbekende fout')); return null; }
  }
  window.__evAttEdit = (attId, eventId) => {
    const nieuweStatus = window.prompt('Nieuwe status? (aangemeld / aanwezig / no_show / sale / switched_to_other_event / geannuleerd)');
    if (!nieuweStatus) return;
    _post('/api/events-attendee-status-change', { id: attId, status: nieuweStatus.trim() }, 'Status bijgewerkt', eventId);
  };
  window.__evAttSendInvite = (attId, eventId) => {
    if (!window.confirm('Keuze-link opnieuw sturen naar deze deelnemer?')) return;
    _post('/api/events-attendee-send-invite', { id: attId }, 'Keuze-link verstuurd');
  };
  window.__evAttSendQuest = (attId, eventId) => {
    if (!window.confirm('Vragenlijst-link sturen naar deze deelnemer?')) return;
    _post('/api/events-attendee-send-questionnaire', { id: attId }, 'Vragenlijst verstuurd');
  };
  window.__evAttMove = async (attId, eventId) => {
    const target = window.prompt('Doel event-ID? (kopieer uit URL of Overzicht)');
    if (!target) return;
    _post('/api/events-attendee-move', { id: attId, target_event_id: target.trim() }, 'Verplaatst', eventId);
  };
  window.__evAttToOfferte = (attId, eventId) => {
    _post('/api/events-attendee-link-deal', { id: attId, action:'create_deal' }, 'Offerte aangemaakt (check Sales)');
  };
  window.__evAttTagAdd = (attId, eventId) => {
    const tag = window.prompt('Tag om toe te voegen?');
    if (!tag) return;
    _post('/api/events-attendee-tag-add', { id: attId, tag: tag.trim() }, 'Tag toegevoegd', eventId);
  };
  window.__evAttTagRemove = (attId, eventId) => {
    const tag = window.prompt('Tag om te verwijderen?');
    if (!tag) return;
    _post('/api/events-attendee-tag-remove', { id: attId, tag: tag.trim() }, 'Tag verwijderd', eventId);
  };
  window.__evAttDelete = (attId, eventId) => {
    if (!window.confirm('Deelnemer verwijderen? Dit is permanent en verwijdert ook eventuele vragenlijst-antwoorden.')) return;
    _post('/api/events-attendee-delete', { id: attId }, 'Verwijderd', eventId);
  };

  // ═══════════════════════════════════════════════════════════════════════
  // PUNT 3 — AANWEZIGE-DETAIL MODAL
  //   Openen op klik naam in Aanwezigen-tab. Toont NAW + status,
  //   vragenlijst-antwoorden (events-attendee-assessment-get) en
  //   contacthistorie (inbox-conversation-by-customer → inbox-messages-list).
  // ═══════════════════════════════════════════════════════════════════════
  // Portal-helpers voor modals — verplaatsen ev-modal uit #content naar
  // document.body zodat position:fixed viewport-relatief blijft (fix voor
  // "modal opent niet" bij containing-block/transform op ancestor van #content).
  function _evEnsurePortal(portalId) {
    // Fix ronde-13 (2026-08-20): rAF verwijderd + SYNCHROON verplaats.
    // Oude gedrag: rAF-wrapper vertraagde de portal-move één frame; als
    // ondertussen een fetch resolvet + render triggert, zit er even
    // DUBBELE modal: node A in body (van vorige rAF) én node B in #content
    // (nog niet verplaatst). Fix: (a) sync-move, (b) elke render triggert
    // _ensureAttPortalIfOpen() zodat re-renders na fetch de node opnieuw
    // uit #content naar body verplaatsen — geen dubbelling meer.
    try {
      document.body.querySelectorAll('body > [data-portal-id="' + portalId + '"]').forEach((n) => n.remove());
      const el = document.querySelector('#content [data-portal-id="' + portalId + '"]');
      if (!el) return;
      document.body.appendChild(el);
    } catch (_) { /* geen DOM */ }
  }
  // Helper: als de deelnemer-modal open is, zorg dat na een re-render de
  // portal opnieuw uit #content naar body verplaatst wordt. Aan te roepen
  // in elke fetch-completion die DFO.render() triggert.
  function _ensureAttPortalIfOpen() {
    if (_ui && _ui.attDetail) _evEnsurePortal('ev-modal');
  }
  function _evRemovePortal(portalId) {
    // SYNCHROON verwijderen — was via rAF, waardoor de backdrop nog ~16ms bleef
    // hangen na close. De "eerstvolgende klik" landde dan nog op die stale backdrop
    // ipv de UI eronder -> klik geslikt. Nu is de node meteen weg zodra state=null.
    try {
      document.body.querySelectorAll('body > [data-portal-id="' + portalId + '"]').forEach((n) => n.remove());
    } catch (_) { /* geen DOM (SSR/tests) */ }
  }
  window.__evAttOpen = (attId, eventId) => {
    const dbg = /(?:^|[?&])debug=1(?:$|&)/.test(location.search);
    _ui.attDetail = { attId, eventId };
    if (!_live.assessments.data[attId] && !_live.assessments.loading[attId] && !(_live.assessments.error && _live.assessments.error[attId])) queueMicrotask(() => fetchAssessment(attId));
    if (!_live.attComms.data[attId] && !_live.attComms.loading[attId] && !(_live.attComms.error && _live.attComms.error[attId])) queueMicrotask(() => fetchAttComms(attId));
    // ROOT-CAUSE BUG-A: de modal-render leest `_live.attendees.data[eventId]` om
    // de attendee-details te vinden. Vanuit Aanwezigen is die lijst al gefetched
    // (tab-init), vanuit Inschrijvingen NIET -> lookup faalt -> "Deelnemer niet
    // gevonden in de huidige lijst". Fix: hydrateer de lijst hier als 'ie ontbreekt
    // (fetchAttendees is idempotent + cached, dus geen dubbele call vanuit Aanwezigen).
    if (!_live.attendees.data[eventId] && !_live.attendees.loading[eventId] && !_live.attendees.error[eventId]) {
      if (dbg) console.log('[ev-att-open] attendees-lijst niet cached -> fetchAttendees', { attId, eventId });
      queueMicrotask(() => fetchAttendees(eventId));
    }
    const list = asArr(_live.attendees.data[eventId]);
    const att  = list.find((x) => x.id === attId);
    if (dbg) console.log('[ev-att-open]', { attId, eventId, hasList: list.length > 0, listLen: list.length, matched: !!att });
    if (att && !(attId in _live.attConv.data) && !_live.attConv.loading[attId]) {
      queueMicrotask(() => fetchAttConv(attId, att.customer_id || null));
    }
    if (window.DFO?.render) window.DFO.render();
    _evEnsurePortal('ev-modal');
  };
  window.__evAttClose = () => {
    if (_ui.attDetail) delete _ui.noteDraft[_ui.attDetail.attId];
    _ui.attDetail = null;
    _evRemovePortal('ev-modal');
    if (window.DFO?.render) window.DFO.render();
  };
  window.__evAttNoteDraft = (attId, val) => {
    _ui.noteDraft[attId] = val;
    if (window.DFO?.render) window.DFO.render();
  };
  window.__evAttNoteReset = (attId) => {
    delete _ui.noteDraft[attId];
    if (window.DFO?.render) window.DFO.render();
  };
  window.__evAttNoteSave = async (attId) => {
    const val = (attId in _ui.noteDraft) ? String(_ui.noteDraft[attId] || '') : null;
    if (val == null) return;
    _ui.noteBusy[attId] = true; if (window.DFO?.render) window.DFO.render();
    try {
      const j = await window.KV.authedJson('/api/events-attendee-update?id=' + encodeURIComponent(attId), {
        method:'PATCH', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ notes: val || null }),
      });
      if (j?.error) throw new Error(j.error);
      // Update local state: attendees-list-rij
      if (_ui.attDetail) {
        const list = _live.attendees.data[_ui.attDetail.eventId];
        if (Array.isArray(list)) {
          const idx = list.findIndex((x) => x.id === attId);
          if (idx >= 0) list[idx] = { ...list[idx], notes: val || null };
        }
      }
      delete _ui.noteDraft[attId];
      _showToast('Notitie opgeslagen');
    } catch (e) { alert('Notitie opslaan mislukt: ' + (e?.message || 'onbekende fout')); }
    finally { _ui.noteBusy[attId] = false; if (window.DFO?.render) window.DFO.render(); }
  };
  window.__evAttOpenConv = (convId) => {
    // In-shell viewer via Inbox-tab-mode
    _ui.attDetail = null;
    _ui.inboxConvId = convId;
    if (window.DFO?.render) {
      // Switch naar Inbox-tab via DFO als beschikbaar
      try { window.DFO.setTab && window.DFO.setTab('Inbox'); } catch (_) {}
      window.DFO.render();
    }
  };

  function _attDetailModal() {
    if (!_ui.attDetail) return '';
    const { attId, eventId } = _ui.attDetail;
    const dbg = /(?:^|[?&])debug=1(?:$|&)/.test(location.search);
    const list = asArr(_live.attendees.data[eventId]);
    const att  = list.find((x) => x.id === attId);
    if (dbg) console.log('[att-modal-render]', { attId, eventId, hasList: list.length > 0, listLen: list.length, matched: !!att, loading: _live.attendees.loading[eventId], hasErr: !!_live.attendees.error[eventId] });
    if (!att) {
      // Loading-shell zolang de attendees-lijst nog binnenkomt (bijv. eerste open
      // vanuit Inschrijvingen — __evAttOpen heeft net fetchAttendees getriggerd).
      const stillLoading = _live.attendees.loading[eventId] || (!_live.attendees.data[eventId] && !_live.attendees.error[eventId]);
      if (stillLoading) {
        return _modalShell('Deelnemer', `<div style="padding:28px 20px;color:var(--text-3);font-size:13px;text-align:center">Deelnemer wordt geladen…<div style="margin-top:10px;font-size:11px;color:var(--text-3);opacity:.7">${esc(attId)}</div></div>`);
      }
      const errMsg = _live.attendees.error[eventId] ? String(_live.attendees.error[eventId]) : 'Deelnemer niet gevonden.';
      return _modalShell('Deelnemer', `<div style="padding:16px;color:var(--text-3);font-size:13px">${esc(errMsg)}<div style="margin-top:8px;font-size:11px;opacity:.7">attId: ${esc(attId)}</div></div>`);
    }
    // Nu att beschikbaar is: fire attConv-fetch als 'ie er nog niet is (dit pad wordt
    // gehit als att pas na fetchAttendees binnenkomt — __evAttOpen kon 'em toen niet firen).
    if (!(attId in _live.attConv.data) && !_live.attConv.loading[attId]) {
      queueMicrotask(() => fetchAttConv(attId, att.customer_id || null));
    }
    const naam = [att.first_name || att.voornaam, att.last_name || att.achternaam].filter(Boolean).join(' ') || att.name || att.email || '—';
    const [sc, sl] = ATT_STATUS_META[att.status] || ['neutral', att.status || '—'];

    // Vragenlijst
    const asSt = _live.assessments;
    let questBlock;
    if (asSt.loading[attId]) questBlock = `<div style="font-size:12.5px;color:var(--text-3)">Vragenlijst laden…</div>`;
    else if (asSt.error[attId]) questBlock = `<div style="font-size:12.5px;color:var(--rose)">Vragenlijst-fout: ${esc(asSt.error[attId])}</div>`;
    else {
      const j = asSt.data[attId];
      const items = asArr(j?.items);
      if (items.length === 0) questBlock = `<div style="font-size:12.5px;color:var(--text-3);font-style:italic">Nog geen vragenlijst ingevuld.</div>`;
      else {
        questBlock = `${j?.routing_result ? `<div style="margin-bottom:10px;padding:8px 10px;background:var(--surface-2);border-radius:6px;font-size:12px"><b>Routing:</b> ${esc(j.routing_result)}${j?.skill_score != null ? ` · <b>Skill-score:</b> ${esc(String(j.skill_score))}` : ''}</div>` : ''}
        <div style="display:flex;flex-direction:column;gap:8px">
          ${items.map((q) => `<div style="border-bottom:1px solid var(--border);padding-bottom:6px">
            <div style="font-size:11.5px;color:var(--text-3)">${esc(q.question_label || q.question_key || '—')}</div>
            <div style="font-size:13px;color:var(--text)">${esc(q.answer_label || q.answer_value || '—')}</div>
          </div>`).join('')}
        </div>`;
      }
    }

    // Contacthistorie via conversation-resolve → messages
    const convSt = _live.attConv;
    let contactBlock;
    if (convSt.loading[attId]) contactBlock = `<div style="font-size:12.5px;color:var(--text-3)">Conversatie zoeken…</div>`;
    else if (convSt.error[attId]) contactBlock = `<div style="font-size:12.5px;color:var(--rose)">Fout: ${esc(convSt.error[attId])}</div>`;
    else {
      const convId = convSt.data[attId];
      if (!convId) contactBlock = `<div style="font-size:12.5px;color:var(--text-3);font-style:italic">Geen inbox-conversatie gekoppeld${att.customer_id ? ' voor deze klant' : ' — geen klant-koppeling'}.</div>`;
      else {
        // Fetch messages lazy als nog niet gefetched
        const msgSt = _live.inboxMsgs;
        if (!msgSt.data[convId] && !msgSt.loading[convId] && !(msgSt.error && msgSt.error[convId])) queueMicrotask(() => fetchInboxMsgs(convId));
        if (msgSt.loading[convId]) contactBlock = `<div style="font-size:12.5px;color:var(--text-3)">Berichten laden…</div>`;
        else if (msgSt.error[convId]) contactBlock = `<div style="font-size:12.5px;color:var(--rose)">Berichten-fout: ${esc(msgSt.error[convId])}</div>`;
        else {
          const d = msgSt.data[convId];
          const msgs = asArr(d?.items).slice(-15);
          contactBlock = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
            <div style="font-size:11.5px;color:var(--text-3)">Laatste ${msgs.length} berichten · ${_channelIndicator(d?.conversation)}</div>
            <button class="btn btn-ghost btn-sm" onclick="window.__evAttOpenConv('${esc(convId)}')">Open in Inbox →</button>
          </div>
          ${msgs.length === 0
            ? `<div style="font-size:12.5px;color:var(--text-3);font-style:italic">Geen berichten in deze conversatie.</div>`
            : `<div style="display:flex;flex-direction:column;gap:6px;max-height:280px;overflow-y:auto">${msgs.map((m) => {
                const out = m.direction === 'outbound';
                return `<div style="display:flex;flex-direction:column;align-items:${out ? 'flex-end' : 'flex-start'}">
                  <div style="max-width:80%;padding:6px 10px;border-radius:10px;background:${out ? 'var(--pink-soft)' : 'var(--surface-2)'};color:var(--text);font-size:12.5px;line-height:1.4;white-space:pre-wrap">${esc(m.body || (m.template_name ? '[template: ' + m.template_name + ']' : (m.media_url ? '[bijlage]' : '—')))}</div>
                  <div class="mono" style="font-size:10.5px;color:var(--text-3);margin-top:1px">${esc(_fmtDateTime(m.sent_at || m.created_at))}${m.status ? ' · ' + esc(m.status) : ''}</div>
                </div>`;
              }).join('')}</div>`}`;
        }
      }
    }

    // Punt 3 — Notitie-blok (bewerkbaar; bron: event_attendees.notes,
    // schrijft via PATCH /api/events-attendee-update?id=<uuid> {notes}).
    const noteCur = att.notes || '';
    const noteDraft = (attId in _ui.noteDraft) ? _ui.noteDraft[attId] : noteCur;
    const noteDirty = (attId in _ui.noteDraft) && String(noteDraft) !== String(noteCur);
    const noteBusy = !!_ui.noteBusy[attId];
    const noteBlock = `<div style="border:1px solid var(--border);border-radius:8px;overflow:hidden">
      <textarea
        placeholder="Voeg een notitie toe over deze deelnemer (bv. 'Opgebeld door Chesney om 13u41 — is er zeker bij')…"
        oninput="window.__evAttNoteDraft('${esc(attId)}', this.value)"
        style="width:100%;min-height:80px;padding:10px 12px;border:none;background:var(--surface);font-size:13px;font-family:inherit;line-height:1.5;resize:vertical;color:var(--text);box-sizing:border-box"
      >${esc(noteDraft)}</textarea>
      <div style="padding:8px 10px;background:var(--surface-2);border-top:1px solid var(--border);display:flex;gap:6px;align-items:center">
        <button class="btn btn-primary btn-sm" ${(!noteDirty || noteBusy) ? 'disabled style="opacity:.55"' : ''} onclick="window.__evAttNoteSave('${esc(attId)}')">${noteBusy ? 'Opslaan…' : 'Notitie opslaan'}</button>
        <button class="btn btn-ghost btn-sm" ${!noteDirty ? 'disabled style="opacity:.55"' : ''} onclick="window.__evAttNoteReset('${esc(attId)}')">Reset</button>
        <span style="margin-left:auto;font-size:11px;color:var(--text-3)">${noteDirty ? 'niet-opgeslagen wijziging' : ''}</span>
      </div>
    </div>`;

    // Punt 3 — Contact/automation-historie via /api/events-attendee-comms.
    // Retourneert items = [{channel, status, at, label}], gecombineerd uit
    // event_attendee_comms_log + event_automation_run_log (zie endpoint-doc).
    const commsSt = _live.attComms;
    let commsBlock;
    if (commsSt.loading[attId]) commsBlock = `<div style="font-size:12.5px;color:var(--text-3)">Historie laden…</div>`;
    else if (commsSt.error[attId]) commsBlock = `<div style="font-size:12.5px;color:var(--rose)">Historie-fout: ${esc(commsSt.error[attId])}</div>`;
    else {
      const cItems = asArr(commsSt.data[attId]?.items);
      const cNote  = commsSt.data[attId]?.note || null;
      if (cItems.length === 0) commsBlock = `<div style="font-size:12.5px;color:var(--text-3);font-style:italic">Nog geen automation / e-mail / WhatsApp verstuurd.</div>`;
      else {
        commsBlock = `<div style="display:flex;flex-direction:column;gap:6px;max-height:220px;overflow-y:auto;padding-right:4px">
          ${cItems.map((it) => {
            const isWA = String(it.channel || '').toLowerCase() === 'whatsapp';
            const chanBadge = isWA
              ? `<span title="WhatsApp" style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;background:#25d366;border-radius:4px;color:white;font-size:11px;font-weight:600">W</span>`
              : `<span title="E-mail" style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;background:var(--blue);border-radius:4px;color:white">${svg(I.mail || I.chat, 'width:11px;height:11px')}</span>`;
            const st = String(it.status || '').toLowerCase();
            const stColor = st === 'gepland' ? 'warn' : (st === 'verzonden' ? 'ok' : 'neutral');
            return `<div style="display:flex;align-items:center;gap:8px;padding:7px 9px;border:1px solid var(--border);border-radius:6px;background:var(--surface)">
              ${chanBadge}
              <div style="flex:1;min-width:0">
                <div style="font-size:12.5px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(it.label || '—')}</div>
                <div class="mono" style="font-size:10.5px;color:var(--text-3);margin-top:1px">${esc(_fmtDateTime(it.at))}</div>
              </div>
              ${H.pill(stColor, it.status || '—')}
            </div>`;
          }).join('')}
        </div>
        ${cNote ? `<div style="margin-top:8px;padding:8px 10px;background:var(--surface-2);border-radius:6px;font-size:11.5px;color:var(--text-3);line-height:1.5">${esc(cNote)}</div>` : ''}`;
      }
    }

    const body = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:16px">
      <div>
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
          ${H.av(naam, 40)}
          <div>
            <div style="font-size:15px;font-weight:600">${esc(naam)}</div>
            <div style="font-size:11.5px;color:var(--text-3);margin-top:1px">${H.pill(sc, sl)}</div>
          </div>
        </div>
        <div class="kv"><dt>E-mail</dt><dd>${esc(att.email || '—')}</dd></div>
        <div class="kv"><dt>Telefoon</dt><dd class="mono">${esc(att.phone || att.telefoon || '—')}</dd></div>
        <div class="kv"><dt>Aangemeld</dt><dd class="mono">${esc(_fmtDateTime(att.registered_at || att.created_at))}</dd></div>
        <div class="kv"><dt>Belstatus</dt><dd>${esc(att.call_status || '—')}</dd></div>
        ${att.customer_id ? `<div class="kv"><dt>Klant-ID</dt><dd class="mono" style="font-size:11px">${esc(String(att.customer_id).slice(0,8))}…</dd></div>` : `<div class="kv"><dt>Klant</dt><dd style="color:var(--text-3);font-size:12px">Niet gekoppeld</dd></div>`}

        <div style="margin-top:16px">
          <div style="font-size:12px;font-weight:600;color:var(--text-2);margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em">Notitie</div>
          ${noteBlock}
        </div>

        <div style="margin-top:16px">
          <div style="font-size:12px;font-weight:600;color:var(--text-2);margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em">Automations / berichten</div>
          ${commsBlock}
        </div>

        <div style="margin-top:16px">
          <div style="font-size:12px;font-weight:600;color:var(--text-2);margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em">Contacthistorie (chat)</div>
          ${contactBlock}
        </div>
      </div>
      <div>
        <div style="font-size:12px;font-weight:600;color:var(--text-2);margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em">Vragenlijst-antwoorden</div>
        ${questBlock}
      </div>
    </div>`;
    return _modalShell('Deelnemer: ' + naam, body);
  }

  function _modalShell(title, body) {
    // Portal-anchor: data-portal-id + class. _evEnsurePortal() verplaatst deze
    // node uit #content naar document.body zodat 'overflow:hidden'/'transform'
    // op een #content-ancestor het position:fixed niet meer clipt.
    // Root-cause: identiek aan agents-v2 kennisbank-modal (containing-block
    // issue, geen stacking-context — z-index verhoging bleek ontoereikend).
    return `<div data-portal-id="ev-modal" class="ev-portal ev-modal-backdrop" onclick="if(event.target===this)window.__evAttClose()" style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:100000;display:flex;align-items:center;justify-content:center;padding:20px">
      <div style="background:var(--surface);border-radius:12px;border:1px solid var(--border);max-width:920px;width:100%;max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)">
        <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
          <div style="font-size:14px;font-weight:600;flex:1">${esc(title)}</div>
          <button class="icon-btn" onclick="window.__evAttClose()" title="Sluiten (Esc)" style="width:30px;height:30px">${svg(I.x || I.close, 'width:14px;height:14px')}</button>
        </div>
        ${body}
      </div>
    </div>`;
  }

  function _channelIndicator(conv) {
    // WhatsApp als phone_number bestaat; anders E-mail (heuristiek — inbox
    // gebruikt geen expliciet channel-veld, maar events-lijn is WA-only in v2).
    if (!conv) return '';
    const isWA = !!(conv.phone_number || conv.can_send_text);
    if (isWA) return `<span style="display:inline-flex;align-items:center;gap:4px;color:var(--emerald)"><span style="width:8px;height:8px;background:#25d366;border-radius:50%"></span>WhatsApp</span>`;
    return `<span style="display:inline-flex;align-items:center;gap:4px;color:var(--blue)">${svg(I.mail || I.chat, 'width:11px;height:11px')}E-mail</span>`;
  }

  // ── DETAIL — MENTOREN ────────────────────────────────────────────────────
  function _detailMentoren(ev) {
    const id = ev.id;
    if (!_live.completedOne.data[id] && !_live.completedOne.loading[id] && !_live.completedOne.error[id]) queueMicrotask(() => fetchCompletedOne(id));
    if (_live.completedOne.error[id] && !_live.completedOne.data[id]) return errBlk('completedOne', _live.completedOne.error[id], id);
    if (_live.completedOne.loading[id] && !_live.completedOne.data[id]) return skel();
    const comp = _live.completedOne.data[id];
    if (!comp) return emptyBlk('Nog geen completion-data', 'Rond het event eerst af om mentoren-financiën te zien.');
    const perMentor = asArr(comp.per_mentor);
    if (perMentor.length === 0) return emptyBlk('Geen mentoren-data', 'Er zijn geen mentor-bonussen vastgesteld voor dit event.');
    const totBonus = perMentor.reduce((a, m) => a + Number(m.bonus || 0), 0);
    const totExp = perMentor.reduce((a, m) => a + Number(m.expense || m.expenses || 0), 0);
    return `<div class="pad" style="padding-top:14px">
      <div style="display:flex;gap:20px;margin-bottom:14px">
        <div><div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em">Sales</div><div class="money" style="font-size:20px;font-weight:600">${eur0(Number(comp.sales || 0))}</div></div>
        <div><div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em">Bonus totaal</div><div class="money" style="font-size:20px;font-weight:600;color:var(--violet)">${eur0(totBonus)}</div></div>
        <div><div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em">Uitgaven</div><div class="money" style="font-size:20px;font-weight:600;color:var(--amber)">${eur0(totExp)}</div></div>
        <div><div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em">Netto</div><div class="money" style="font-size:20px;font-weight:600;color:var(--emerald)">${eur0(Number(comp.sales || 0) - totBonus - totExp)}</div></div>
      </div>
      ${H.table(
        [{l:'Mentor'},{l:'Bonus',cls:'r'},{l:'Uitgave',cls:'r optional'},{l:'Netto',cls:'r'}],
        perMentor.map((m) => {
          const bonus = Number(m.bonus || 0), exp = Number(m.expense || m.expenses || 0);
          return [
            `<span class="cell-main">${esc(m.name || m.mentor_name || '—')}</span>`,
            `<span class="money">${eur0(bonus)}</span>`,
            `<span class="money" style="color:var(--amber)">${exp ? '− ' + eur0(exp) : '—'}</span>`,
            `<span class="money" style="color:var(--emerald)">${eur0(bonus - exp)}</span>`,
          ];
        })
      )}
    </div>`;
  }

  // ── DETAIL — AUDIT ───────────────────────────────────────────────────────
  function _detailAudit(ev) {
    const id = ev.id;
    if (!_live.auditAgg.data[id] && !_live.auditAgg.loading[id] && !_live.auditAgg.error[id]) queueMicrotask(() => fetchAudit(id));
    if (_live.auditAgg.error[id] && !_live.auditAgg.data[id]) return errBlk('audit', _live.auditAgg.error[id], id);
    if (_live.auditAgg.loading[id] && !_live.auditAgg.data[id]) return `<div style="padding:20px"><div style="font-size:12.5px;color:var(--text-3);margin-bottom:10px">Aggregeert audit van alle deelnemers…</div>${skel()}</div>`;
    const rows = asArr(_live.auditAgg.data[id]);
    if (rows.length === 0) return emptyBlk('Geen audit-entries', 'Er is nog niets gelogd voor de deelnemers van dit event.');
    return `<div style="padding:12px 20px 6px;font-size:11.5px;color:var(--text-3)">Aggregeerd uit event_attendee_audit_log (per deelnemer). Toont laatste 20 entries per deelnemer, max 25 deelnemers.</div>
    <div style="padding:0 20px 20px">${H.table(
      [{l:'Wanneer'},{l:'Deelnemer',cls:'optional'},{l:'Wie',cls:'optional'},{l:'Actie'},{l:'Details',cls:'optional'}],
      rows.slice(0, 200).map((r) => {
        const attName = r._attendee ? ([r._attendee.first_name, r._attendee.last_name].filter(Boolean).join(' ') || r._attendee.email || '—') : '—';
        const who = r.by_user?.full_name || r.by_user?.email || r.actor || r.user_name || r.user_email || '—';
        const details = r.after_state ? JSON.stringify(r.after_state).slice(0, 100) : (r.details || r.description || '—');
        return [
          `<span class="mono" style="font-size:12px;color:var(--text-3)">${esc(_fmtDateTime(r.at || r.created_at || r.timestamp))}</span>`,
          `<span style="font-size:12.5px">${esc(attName)}</span>`,
          `<span style="font-size:12.5px;color:var(--text-2)">${esc(who)}</span>`,
          `<span class="mono" style="font-size:12px">${esc(r.action || r.event_type || '—')}</span>`,
          `<span style="font-size:11.5px;color:var(--text-3);max-width:280px;overflow:hidden;text-overflow:ellipsis;display:inline-block;vertical-align:middle">${esc(details)}</span>`,
        ];
      })
    )}</div>`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // WIZARD (3-staps create/edit)
  // ═══════════════════════════════════════════════════════════════════════
  window.__evWizardOpen = (mode, id) => {
    _ui.mode = 'wizard';
    _ui.wizard = { step: 1, mode, id: id || null, form: {}, photoFile: null };
    _ui._photoDataUrl = null;
    if (mode === 'edit' && id) {
      if (!_live.detail.data[id]) queueMicrotask(() => fetchDetail(id));
      const cur = _live.detail.data[id];
      if (cur) _ui.wizard.form = {
        title: cur.title,
        starts_at: _isoToLocalInput(cur.starts_at),   // BUG 2 FIX
        ends_at:   _isoToLocalInput(cur.ends_at),
        location: cur.location, capacity: cur.capacity,
        description_md: cur.description_md || cur.description,
        niveau: cur.niveau,
      };
    }
    if (!_live.niveaus.data) queueMicrotask(fetchNiveaus);
    if (window.DFO?.render) window.DFO.render();
  };
  window.__evWizardStep = (n) => { if (_ui.wizard) { _ui.wizard.step = n; if (window.DFO?.render) window.DFO.render(); } };
  window.__evWizardField = (k, v) => { if (_ui.wizard) { _ui.wizard.form[k] = v; } };
  window.__evWizardPhoto = (e) => {
    const file = e.target.files && e.target.files[0]; if (!file) return;
    _ui.wizard.photoFile = file;
    const reader = new FileReader();
    reader.onload = (ev) => { _ui._photoDataUrl = ev.target.result; if (window.DFO?.render) window.DFO.render(); };
    reader.readAsDataURL(file);
  };

  function _wizardView() {
    const w = _ui.wizard || {}; const step = w.step || 1; const form = w.form || {};
    // Bij edit-flow: haal detail op zodra beschikbaar → prefill (BUG 2 FIX incl.)
    if (w.mode === 'edit' && w.id && !form.title) {
      const cur = _live.detail.data[w.id];
      if (cur) w.form = {
        title: cur.title,
        starts_at: _isoToLocalInput(cur.starts_at),
        ends_at:   _isoToLocalInput(cur.ends_at),
        location: cur.location, capacity: cur.capacity,
        description_md: cur.description_md || cur.description,
        niveau: cur.niveau,
      };
    }
    const niveaus = asArr(_live.niveaus.data);

    const stepDot = (n, l) => `<span style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:20px;font-size:12px;font-weight:500;background:${step === n ? 'var(--pink-soft)' : 'var(--surface-2)'};color:${step === n ? 'var(--pink)' : 'var(--text-3)'}">
      <span style="width:20px;height:20px;border-radius:50%;background:${step > n ? 'var(--emerald)' : step === n ? 'var(--pink)' : 'var(--border)'};color:white;display:inline-flex;align-items:center;justify-content:center;font-size:11px">${step > n ? '✓' : n}</span>${esc(l)}</span>`;

    return `<div style="padding:12px 20px;background:var(--surface-2);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
      <button class="btn btn-ghost btn-sm" onclick="window.__evBackToList()">${svg(I.arrDown || I.x, 'width:13px;height:13px;transform:rotate(90deg)')}Annuleren</button>
      <span style="font-size:13px;font-weight:600">${w.mode === 'edit' ? 'Event bewerken' : 'Nieuw event'}</span>
      <div style="margin-left:auto;display:flex;gap:8px">${stepDot(1,'Basis info')}${stepDot(2,'Niveau')}${stepDot(3,'Review')}</div>
    </div>
    <div class="pad" style="padding-top:20px"><div style="max-width:720px;margin:0 auto">
      ${step === 1 ? _wizardStep1(form) : step === 2 ? _wizardStep2(form, niveaus) : _wizardStep3(form)}
      <div style="display:flex;gap:8px;margin-top:24px;justify-content:space-between">
        <button class="btn btn-ghost btn-sm" ${step === 1 ? 'disabled style="opacity:.5"' : ''} onclick="window.__evWizardStep(${step - 1})">← Vorige</button>
        ${step < 3
          ? `<button class="btn btn-primary btn-sm" onclick="window.__evWizardStep(${step + 1})">Volgende →</button>`
          : `<button class="btn btn-primary btn-sm" onclick="window.__evWizardSubmit()">${svg(I.tick)}${w.mode === 'edit' ? 'Wijzigingen opslaan' : 'Event aanmaken'}</button>`}
      </div>
    </div></div>`;
  }
  function _wizardStep1(form) {
    return `<div class="card"><div class="card-head"><div class="card-title">Basis informatie</div></div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:14px;padding:18px">
        ${_wizField('Titel', 'title', form.title, 'text')}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
          ${_wizField('Start', 'starts_at', form.starts_at ? form.starts_at.slice(0, 16) : '', 'datetime-local')}
          ${_wizField('Eind',  'ends_at',   form.ends_at   ? form.ends_at.slice(0, 16)   : '', 'datetime-local')}
        </div>
        <div style="display:grid;grid-template-columns:2fr 1fr;gap:14px">
          ${_wizField('Locatie',   'location', form.location, 'text')}
          ${_wizField('Capaciteit','capacity', form.capacity, 'number')}
        </div>
        ${_wizField('Beschrijving', 'description_md', form.description_md, 'textarea')}
        <div>
          <label style="font-size:12px;color:var(--text-2);display:block;margin-bottom:5px">Foto (optioneel)</label>
          <input type="file" accept="image/*" onchange="window.__evWizardPhoto(event)" style="font-size:12px" />
          ${_ui._photoDataUrl ? `<div style="margin-top:8px"><img src="${_ui._photoDataUrl}" style="max-width:200px;max-height:120px;border-radius:8px;border:1px solid var(--border)" /></div>` : ''}
        </div>
      </div>
    </div>`;
  }
  function _wizardStep2(form, niveaus) {
    return `<div class="card"><div class="card-head"><div class="card-title">Niveau</div></div>
      <div class="card-body" style="padding:18px">
        ${niveaus.length === 0
          ? `<div style="font-size:12.5px;color:var(--text-3)">Geen niveau-opties gevonden. Laad opnieuw of maak eerst een niveau aan.</div>`
          : `<div style="display:flex;flex-direction:column;gap:10px">${niveaus.map((n) => {
              const slug = n.slug || n.id || n.value || n;
              const label = n.label || n.name || slug;
              return `<label style="display:flex;gap:10px;align-items:center;padding:12px;border:1px solid var(--border);border-radius:8px;cursor:pointer;background:${form.niveau === slug ? 'var(--surface-2)' : 'var(--surface)'}">
                <input type="radio" name="niveau" value="${esc(slug)}" ${form.niveau === slug ? 'checked' : ''} onchange="window.__evWizardField('niveau', this.value);window.DFO && window.DFO.render && window.DFO.render()" />
                <div><div style="font-weight:500;font-size:13px">${esc(label)}</div>${n.description ? `<div style="font-size:11.5px;color:var(--text-3);margin-top:2px">${esc(n.description)}</div>` : ''}</div>
              </label>`;
            }).join('')}</div>`}
      </div>
    </div>`;
  }
  function _wizardStep3(form) {
    return `<div class="card"><div class="card-head"><div class="card-title">Review</div></div>
      <div class="card-body" style="padding:18px">
        <div class="kv"><dt>Titel</dt><dd>${esc(form.title || '—')}</dd></div>
        <div class="kv"><dt>Start</dt><dd>${esc(_fmtDateTime(form.starts_at))}</dd></div>
        <div class="kv"><dt>Eind</dt><dd>${esc(_fmtDateTime(form.ends_at))}</dd></div>
        <div class="kv"><dt>Locatie</dt><dd>${esc(form.location || '—')}</dd></div>
        <div class="kv"><dt>Capaciteit</dt><dd class="num">${esc(String(form.capacity || '—'))}</dd></div>
        <div class="kv"><dt>Niveau</dt><dd>${esc(form.niveau || '—')}</dd></div>
        <div class="kv"><dt>Beschrijving</dt><dd style="white-space:pre-wrap;max-width:400px">${esc((form.description_md || '—').slice(0, 200))}${(form.description_md || '').length > 200 ? '…' : ''}</dd></div>
        ${_ui._photoDataUrl ? `<div class="kv"><dt>Foto</dt><dd><img src="${_ui._photoDataUrl}" style="max-width:120px;max-height:80px;border-radius:6px" /></dd></div>` : ''}
      </div>
    </div>`;
  }
  function _wizField(label, name, v, kind) {
    const id = 'wiz_' + name;
    const style = 'width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);font-size:13px;font-family:inherit';
    let input;
    if (kind === 'textarea') input = `<textarea id="${id}" oninput="window.__evWizardField('${name}',this.value)" style="${style};min-height:100px;resize:vertical">${esc(v || '')}</textarea>`;
    else input = `<input id="${id}" type="${kind}" value="${esc(v == null ? '' : v)}" oninput="window.__evWizardField('${name}',this.value)" style="${style}" />`;
    return `<div><label for="${id}" style="font-size:12px;color:var(--text-2);display:block;margin-bottom:5px">${esc(label)}</label>${input}</div>`;
  }
  window.__evWizardSubmit = async () => {
    const w = _ui.wizard; if (!w) return;
    const form = w.form || {};
    if (!form.title || !form.starts_at) { alert('Titel en startdatum zijn verplicht.'); return; }
    try {
      const isEdit = w.mode === 'edit';
      // events-update leest id uit query-param, NIET uit body. events-create
      // heeft geen id. Beide flows: id verwijderen uit body, alleen bij edit
      // meesturen als ?id=<uuid> in URL.
      const url = isEdit
        ? '/api/events-update?id=' + encodeURIComponent(w.id)
        : '/api/events-create';
      const httpMethod = isEdit ? 'PATCH' : 'POST';
      const body = { ...form };
      delete body.id;   // veiligheidshalve strippen mocht 'ie in form zitten
      if (form.capacity != null && form.capacity !== '') body.capacity = Number(form.capacity);
      const j = await window.KV.authedJson(url, { method:httpMethod, headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
      if (j?.error) throw new Error(j.error);
      const newId = j?.event?.id || j?.id || w.id;
      // Foto uploaden als geselecteerd
      if (w.photoFile && newId) {
        try {
          const fd = new FormData(); fd.append('file', w.photoFile); fd.append('event_id', newId);
          const upResp = await fetch('/api/event-image-upload', {
            method: 'POST',
            headers: window.KV.getAuthHeaders ? window.KV.getAuthHeaders() : {},
            body: fd,
          });
          if (!upResp.ok) console.warn('[ev-v2] photo upload faalde:', upResp.status);
        } catch (e) { console.warn('[ev-v2] photo upload exception:', e?.message); }
      }
      _showToast(isEdit ? 'Event bijgewerkt' : 'Event aangemaakt');
      _live.events.data = null;
      if (newId) { _live.detail.data[newId] = null; _ui.mode = 'detail'; _ui.detailId = newId; _ui.detailTab = 'Info'; queueMicrotask(() => fetchDetail(newId)); }
      else { _ui.mode = 'list'; }
      _ui.wizard = null; _ui._photoDataUrl = null;
      if (window.DFO?.render) window.DFO.render();
    } catch (e) { alert((w.mode === 'edit' ? 'Bijwerken' : 'Aanmaken') + ' mislukt: ' + (e?.message || 'onbekende fout')); }
  };

  // ═══════════════════════════════════════════════════════════════════════
  // INBOX-tab (behouden — needs-Jeffrey)
  // ═══════════════════════════════════════════════════════════════════════
  // ═══════════════════════════════════════════════════════════════════════
  // INBOX-TAB — SPLIT-PANE (master-detail, WhatsApp Web-stijl)
  //   LEFT (340px): gesprekken-lijst, actief gesprek gehighlight.
  //   RIGHT (flex-1): chat-venster (bubbels, tail, datum-sep, status-vinkjes).
  //   <900px: single-pane met data-mode toggle (list ↔ detail).
  //   Klik op rij → surgical DOM-update van alleen #ev-inbox-right + toggle
  //     .active class op rijen; DFO.render() wordt NIET aangeroepen zodat
  //     scroll-positie behouden blijft.
  //   Default: bovenste conv auto-geselecteerd bij initial load (auto-fetch
  //     messages), tenzij 0 gesprekken.
  // ═══════════════════════════════════════════════════════════════════════
  function inboxView() {
    if (!_live.inbox.data && !_live.inbox.loading && !_live.inbox.error) queueMicrotask(fetchInbox);
    if (_live.inbox.error && !_live.inbox.data) return errBlk('inbox', _live.inbox.error);
    if (_live.inbox.loading && !_live.inbox.data) return skel();

    const items = asArr(_live.inbox.data);

    if (items.length === 0) {
      return _inboxSimoneStatusBar() + emptyBlk('Nog geen gesprekken', 'Zodra een klant de events-lijn appt of mailt verschijnt de conversatie hier.');
    }

    // Client-side filter op naam / telefoon / e-mail (case-insensitive).
    const q = String(_ui.inboxSearchQ || '').trim().toLowerCase();
    const filtered = q ? items.filter((c) => {
      const naam  = (c.customer_name || c.display_name || '').toLowerCase();
      const phone = String(c.phone_number || '').toLowerCase();
      const email = String(c.customer_email || '').toLowerCase();
      return naam.includes(q) || phone.includes(q) || email.includes(q);
    }) : items;

    // Auto-select bovenste (gefilterde) conv als huidige actieve niet zichtbaar is.
    const activeVisible = _ui.inboxConvId && filtered.some((c) => c.id === _ui.inboxConvId);
    if (!activeVisible && filtered.length > 0) {
      _ui.inboxConvId = filtered[0].id;
      _ui.inboxAutoSelected = true;
    } else if (filtered.length === 0) {
      _ui.inboxConvId = null;
    }
    // Start Simone-polling voor de actieve conv (idempotent — restart is safe)
    if (_ui.inboxConvId && _ui._simonePollConvId !== _ui.inboxConvId) {
      queueMicrotask(() => _startSimonePolling(_ui.inboxConvId));
    }
    // Prefetch messages voor actieve conv als nog niet gecached.
    if (_ui.inboxConvId && !_live.inboxMsgs.data[_ui.inboxConvId] && !_live.inboxMsgs.loading[_ui.inboxConvId]) {
      queueMicrotask(() => fetchInboxMsgs(_ui.inboxConvId));
    }

    const narrowMode = _ui.inboxConvId ? _ui.inboxNarrowMode : 'list';

    // Restore linkerlijst-scrollpositie na re-render (fires after DOM parse).
    queueMicrotask(() => {
      const leftEl = document.querySelector('#ev-inbox-left');
      if (leftEl && typeof _ui.inboxScrollTop === 'number') leftEl.scrollTop = _ui.inboxScrollTop;
    });

    return _inboxSimoneStatusBar() + `
      ${_inboxStyles()}
      <div class="ev-inbox-split" data-mode="${esc(narrowMode)}">
        <div class="ev-inbox-left" id="ev-inbox-left">
          <div class="ev-inbox-search">
            <input
              type="search"
              placeholder="Zoek op naam of nummer…"
              value="${esc(_ui.inboxSearchQ)}"
              oninput="window.__evInboxSearch(this.value)"
              onsearch="window.__evInboxSearch(this.value)"
            />
            ${q ? `<div class="ev-inbox-search-count">${filtered.length} van ${items.length}</div>` : ''}
          </div>
          <div class="ev-inbox-rows" id="ev-inbox-rows">
            ${filtered.length === 0
              ? `<div style="padding:16px;text-align:center;color:var(--text-3);font-size:12px">Geen gesprekken gevonden${q ? ' voor "' + esc(q) + '"' : ''}.</div>`
              : _inboxLeftList(filtered, _ui.inboxConvId)}
          </div>
        </div>
        <div class="ev-inbox-right" id="ev-inbox-right">
          ${_inboxRightPane(_ui.inboxConvId)}
        </div>
      </div>
      ${_tplPickerModal()}
      ${_globalOverlays()}`;
  }

  // Zoek-handler: surgical re-render van alleen de left list (rows-container).
  // Full DFO.render zou de textarea onder focus verliezen op elke keystroke.
  window.__evInboxSearch = (val) => {
    _ui.inboxSearchQ = String(val || '');
    // Herbereken filtered lijst
    const items = asArr(_live.inbox.data);
    const q = _ui.inboxSearchQ.trim().toLowerCase();
    const filtered = q ? items.filter((c) => {
      const naam  = (c.customer_name || c.display_name || '').toLowerCase();
      const phone = String(c.phone_number || '').toLowerCase();
      const email = String(c.customer_email || '').toLowerCase();
      return naam.includes(q) || phone.includes(q) || email.includes(q);
    }) : items;
    const rowsEl = document.querySelector('#ev-inbox-rows');
    if (rowsEl) {
      rowsEl.innerHTML = filtered.length === 0
        ? `<div style="padding:16px;text-align:center;color:var(--text-3);font-size:12px">Geen gesprekken gevonden${q ? ' voor "' + esc(q) + '"' : ''}.</div>`
        : _inboxLeftList(filtered, _ui.inboxConvId);
    }
    // Update count-badge
    const searchEl = document.querySelector('.ev-inbox-search');
    if (searchEl) {
      let countEl = searchEl.querySelector('.ev-inbox-search-count');
      if (q) {
        if (!countEl) {
          countEl = document.createElement('div');
          countEl.className = 'ev-inbox-search-count';
          searchEl.appendChild(countEl);
        }
        countEl.textContent = filtered.length + ' van ' + items.length;
      } else if (countEl) countEl.remove();
    }
    // Als actieve conv niet meer zichtbaar is, auto-select top van gefiltered
    if (filtered.length > 0 && !filtered.some((c) => c.id === _ui.inboxConvId)) {
      window.__evInboxSelect(filtered[0].id);
    }
  };

  // Simone status-bar: leest joost_config (module=events). Toont enabled/gates
  // + link naar Agents-module (canonieke editor). Beheer alleen daar — NIET
  // hier — om samenspel met bestaande v1-editor en autonome flow te bewaren.
  function _inboxSimoneStatusBar() {
    if (!_live.simoneCfg.data && !_live.simoneCfg.loading && !_live.simoneCfg.error) queueMicrotask(fetchSimoneCfg);
    const cfg = _live.simoneCfg.data || {};
    const on   = !!cfg.is_enabled;
    const sugg = !!cfg.feature_flags?.reactive_suggest_enabled;
    const auto = !!cfg.feature_flags?.events_reactive_autonomy;
    const label = !on ? 'Uit' : (auto ? 'Autonoom actief' : (sugg ? 'Suggesties actief' : 'Config actief, gates uit'));
    const color = !on ? 'var(--text-3)' : (auto ? 'var(--emerald)' : (sugg ? 'var(--amber)' : 'var(--text-3)'));
    const dot   = !on ? 'var(--text-3)' : (auto ? '#22c55e' : (sugg ? '#f59e0b' : 'var(--text-3)'));
    return `<div class="ev-inbox-simone-bar" style="padding:8px 20px;background:var(--surface);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;font-size:12px">
      <span style="display:inline-flex;align-items:center;gap:6px;color:${color};font-weight:500" title="Simone (AI) — module: events">
        <span style="width:7px;height:7px;background:${dot};border-radius:50%"></span>🤖 Simone · ${esc(label)}
      </span>
      <span style="color:var(--text-3);font-size:11px">Config beheer je in de Agents-module.</span>
      <a href="/modules/klanten-v2/?v2preview=agents" style="margin-left:auto;color:var(--violet);text-decoration:underline;font-size:11px">Open Simone in Agents ↗</a>
    </div>`;
  }

  function _inboxKpiSkel() {
    // Placeholder-blok zodat de KPIs-rij niet opeens hoogte-wisselt tijdens loading.
    return `<div style="padding:12px 20px"><div style="height:76px;background:var(--surface-2);border-radius:12px;opacity:.5"></div></div>`;
  }

  function _inboxStyles() {
    // Scoped, idempotent via id. DFO.render() rebuild is prima; browser dedupes.
    return `<style id="ev-inbox-styles">
      .ev-inbox-split { display:grid; grid-template-columns:340px 1fr; height:calc(100vh - 180px); min-height:560px; border-top:1px solid var(--border); background:var(--surface); }
      .ev-inbox-left  { display:flex; flex-direction:column; border-right:1px solid var(--border); background:var(--surface); overflow:hidden; }
      .ev-inbox-search { padding:10px 12px; border-bottom:1px solid var(--border); background:var(--surface); position:sticky; top:0; z-index:1; flex-shrink:0; }
      .ev-inbox-search input { width:100%; padding:7px 10px; border:1px solid var(--border); border-radius:6px; background:var(--surface); color:var(--text); font-size:12.5px; font-family:inherit; box-sizing:border-box; }
      .ev-inbox-search input:focus { outline:none; border-color:var(--pink); }
      .ev-inbox-search-count { font-size:10.5px; color:var(--text-3); margin-top:4px; padding-left:2px; }
      .ev-inbox-rows { overflow-y:auto; flex:1; }
      .ev-inbox-right { overflow:hidden; display:flex; flex-direction:column; min-width:0; }
      .ev-inbox-row   { display:flex; gap:10px; padding:10px 12px; border-bottom:1px solid var(--border); cursor:pointer; align-items:flex-start; transition:background .12s ease; }
      .ev-inbox-row:hover  { background:var(--surface-2); }
      .ev-inbox-row.active { background:var(--pink-soft); border-left:3px solid var(--pink); padding-left:9px; }
      .ev-inbox-row .r-body { flex:1; min-width:0; }
      .ev-inbox-row .r-top  { display:flex; align-items:baseline; gap:6px; }
      .ev-inbox-row .r-name { font-size:13px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; min-width:0; color:var(--text); }
      .ev-inbox-row .r-time { font-size:10.5px; color:var(--text-3); flex-shrink:0; font-family:'IBM Plex Mono',monospace; }
      .ev-inbox-row .r-preview { font-size:12px; color:var(--text-3); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-top:2px; }
      .ev-inbox-row .r-badges { display:flex; gap:5px; align-items:center; margin-top:3px; }

      /* Kanaal-badges (klein rechthoekje met W/✉) */
      .ev-chan-badge { display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px; border-radius:3px; font-size:10px; font-weight:700; color:white; flex-shrink:0; }
      .ev-chan-badge.wa    { background:#25d366; }
      .ev-chan-badge.email { background:#0369a1; }

      /* Chat-bubbels — 1-op-1 gekopieerd van Wanbetalers Pad A
         (modules/finance.html regels 441-535, _inboxRenderMessages).
         Ingangsklassen: .inbox-c-msg + .inbox-c-msg-bubble. Alle
         maatvoering (max-width, padding, radius, font-size) letterlijk
         overgenomen zodat een kort bericht een kleine bubbel is. */
      .inbox-c-msg              { display:flex; width:100%; margin-bottom:8px; }
      .inbox-c-msg.same-sender  { margin-bottom:2px; }
      .inbox-c-msg.outbound     { justify-content:flex-end; }
      .inbox-c-msg.inbound      { justify-content:flex-start; }
      .inbox-c-msg-bubble       {
        position:relative; display:inline-block;
        padding:6px 10px 8px 12px; border-radius:7.5px;
        max-width:65%; min-width:60px;
        font-size:13.5px; line-height:1.35;
        word-wrap:break-word; box-sizing:border-box; box-shadow:none;
      }
      .inbox-c-msg.outbound:not(.same-sender) .inbox-c-msg-bubble { border-bottom-right-radius:2.5px; }
      .inbox-c-msg.inbound:not(.same-sender)  .inbox-c-msg-bubble { border-top-left-radius:2.5px; }

      /* Kleuren — WhatsApp-groen out, licht-grijs in */
      .inbox-c-msg.outbound .inbox-c-msg-bubble { background:#b6e8b0; color:#0b3d2e; border:.5px solid rgba(11,61,46,.14); }
      .inbox-c-msg.inbound  .inbox-c-msg-bubble { background:#eef1f4; color:#1f2937; border:.5px solid rgba(0,0,0,.06); }
      .inbox-c-msg.outbound.failed .inbox-c-msg-bubble { background:rgba(239,68,68,.12); border:1px solid rgba(239,68,68,.3); color:#7f1d1d; }

      /* Sender-label bovenaan eerste bubble in stream */
      .inbox-c-msg:not(.same-sender) .inbox-c-msg-bubble::before {
        display:block; font-size:10.5px; font-weight:600; letter-spacing:.02em; margin-bottom:3px; opacity:.7;
      }
      .inbox-c-msg.outbound:not(.same-sender) .inbox-c-msg-bubble::before { content:'Jij';    color:#0b3d2e; }
      .inbox-c-msg.inbound:not(.same-sender)  .inbox-c-msg-bubble::before { content:'Klant';  color:#1f2937; }

      /* Text-body + phantom-spacer + absolute meta (WhatsApp Web-truc) */
      .bubble-text     { display:inline; white-space:pre-line; word-break:break-word; overflow-wrap:anywhere; }
      .meta-phantom    { display:inline-block; width:56px; height:0; visibility:hidden; pointer-events:none; }
      .bubble-meta     { position:absolute; bottom:4px; right:8px; font-size:10.5px; opacity:.55; white-space:nowrap; line-height:1; pointer-events:none; display:inline-flex; align-items:center; gap:3px; }
      .bubble-meta .receipt          { margin-left:3px; display:inline-flex; align-items:center; }
      .bubble-meta .simone-sparkle   { color:#a855f7; font-size:11px; margin-right:2px; }

      /* Template-badge boven bubble-text */
      .inbox-c-msg-tplbadge {
        display:inline-flex; align-items:center; gap:3px; margin-bottom:3px;
        padding:1px 6px; border-radius:8px;
        background:rgba(11,61,46,.1); color:#0b3d2e; font-size:10.5px; font-weight:600;
      }

      /* Failure-reason regel */
      .inbox-c-msg-failed-reason { font-size:10.5px; color:#7f1d1d; margin-top:3px; font-style:italic; }

      /* Datum-separator chip */
      .inbox-c-date-separator      { text-align:center; margin:16px 0 8px; }
      .inbox-c-date-separator span { display:inline-block; background:rgba(0,0,0,.05); padding:4px 12px; border-radius:12px; font-size:10.5px; color:#5e6368; font-weight:500; }

      /* Simone-badge boven bubble-text (voor autonoom-verstuurde) */
      .inbox-c-simone-badge {
        display:inline-flex; align-items:center; gap:3px; margin-bottom:3px;
        padding:0 5px; background:var(--violet); color:white; border-radius:3px;
        font-size:9.5px; font-weight:600;
      }

      /* E-mail-bubble — Pad A shell (inbox-c-msg-bubble), maar body via
         <details>-toggle uit Pad B (subject + collapse). Onderscheid via
         .inbox-c-msg-bubble.is-email (blauwe tint + envelop-chip). */
      .inbox-c-msg-bubble.is-email {
        background:#eff6ff; border:.5px solid #93c5fd; color:#1e3a8a;
        min-width:200px; max-width:78%;
        padding:8px 12px;
      }
      .inbox-c-msg.outbound .inbox-c-msg-bubble.is-email { background:#dbeafe; }
      .inbox-c-msg-bubble.is-email::before { display:none; }   /* geen 'Jij'/'Klant'; email heeft eigen from-regel */
      .inbox-c-email-chip { display:inline-flex; align-items:center; gap:4px; font-size:10px; font-weight:700; color:#0369a1; text-transform:uppercase; letter-spacing:.04em; margin-bottom:4px; }
      .inbox-c-email-subj { font-size:12.5px; font-weight:600; color:#1e3a8a; margin-bottom:2px; }
      .inbox-c-email-from { font-size:11px; color:#475569; margin-bottom:6px; }
      .inbox-c-email-body { font-size:12.5px; line-height:1.5; color:#1e3a8a; white-space:pre-wrap; word-wrap:break-word; max-height:200px; overflow-y:auto; }
      .inbox-c-email-att  { margin-top:6px; font-size:10.5px; color:#475569; }
      .inbox-c-msg-bubble.is-email .bubble-meta { color:#0369a1; opacity:.7; }

      .ev-inbox-mobile-back { display:none; }
      @media (max-width: 900px) {
        .ev-inbox-split { grid-template-columns:1fr; }
        .ev-inbox-split[data-mode="detail"] .ev-inbox-left  { display:none; }
        .ev-inbox-split[data-mode="list"]   .ev-inbox-right { display:none; }
        .ev-inbox-split[data-mode="detail"] .ev-inbox-mobile-back { display:inline-flex; }
        .ev-bubble-wrap { max-width:82%; }
        .ev-email { max-width:92%; }
      }
    </style>`;
  }

  function _inboxLeftList(items, activeId) {
    return items.map((c) => {
      const naam = c.customer_name || c.display_name || c.phone_number || '—';
      const unread = Number(c.unread_count || 0);
      const preview = c.last_message_preview || '—';
      const timeShort = _fmtShortTimeOrDate(c.last_message_at);
      // Kanaal van laatste bericht: unified endpoint zet last_message_channel;
      // fallback op phone_number-heuristic (WA als phone bestaat).
      const lastCh = String(c.last_message_channel || (c.phone_number ? 'whatsapp' : 'email')).toLowerCase();
      const chanBadge = lastCh === 'email'
        ? `<span class="ev-chan-badge email" title="Laatste bericht: E-mail">✉</span>`
        : `<span class="ev-chan-badge wa" title="Laatste bericht: WhatsApp">W</span>`;
      return `<div class="ev-inbox-row${c.id === activeId ? ' active' : ''}" data-conv-id="${esc(c.id)}" onclick="window.__evInboxSelect('${esc(c.id)}')">
        ${H.av(naam, 36)}
        <div class="r-body">
          <div class="r-top">
            ${chanBadge}
            <div class="r-name">${esc(naam)}</div>
            <div class="r-time">${esc(timeShort)}</div>
          </div>
          <div class="r-preview">${esc(preview)}</div>
          ${unread > 0 ? `<div class="r-badges"><span style="background:var(--pink);color:white;font-size:10px;font-weight:600;padding:1px 6px;border-radius:10px;min-width:16px;text-align:center">${unread}</span></div>` : ''}
        </div>
      </div>`;
    }).join('');
  }

  // Compact tijdstempel: HH:MM voor vandaag, weekdag voor deze week, anders dd/mm.
  function _fmtShortTimeOrDate(iso) {
    const d = new Date(iso || 0);
    if (!Number.isFinite(d.getTime())) return '';
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
    }
    const diffDays = Math.floor((now - d) / (1000*60*60*24));
    if (diffDays < 7 && diffDays >= 0) return ['zo','ma','di','wo','do','vr','za'][d.getDay()];
    return String(d.getDate()).padStart(2,'0') + '/' + String(d.getMonth()+1).padStart(2,'0');
  }

  function _inboxRightPane(convId) {
    if (!convId) return `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-3);font-size:13px;padding:40px">Selecteer een gesprek links.</div>`;
    // Simone-cfg lazy-fetch (module-scoped, één keer)
    if (!_live.simoneCfg.data && !_live.simoneCfg.loading && !_live.simoneCfg.error) queueMicrotask(fetchSimoneCfg);
    const st = _live.inboxMsgs;
    if (st.error[convId] && !st.data[convId]) return _inboxRightHeader(null, convId) + errBlk('inboxMsgs', st.error[convId]) + _inboxRightFooter(convId, null);
    if (st.loading[convId] && !st.data[convId]) return _inboxRightHeader(null, convId) + _inboxRightSkel() + _inboxRightFooter(convId, null);
    if (!st.data[convId]) return _inboxRightHeader(null, convId) + _inboxRightSkel() + _inboxRightFooter(convId, null);
    const d = st.data[convId];
    return _inboxRightHeader(d.conversation, convId) + _inboxChatBody(d, convId) + _inboxRightFooter(convId, d.conversation);
  }

  function _inboxRightSkel() {
    return `<div style="padding:40px 20px;color:var(--text-3);font-size:12.5px;text-align:center">Berichten laden…</div>`;
  }

  function _inboxRightHeader(conv, convId) {
    const naam = conv?.customer_name || conv?.display_name || conv?.phone_number || '—';
    return `<div style="padding:12px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;background:var(--surface);flex-shrink:0">
      <button class="btn btn-ghost btn-sm ev-inbox-mobile-back" onclick="window.__evInboxBackList()" title="Terug naar lijst" style="align-items:center;justify-content:center">${svg(I.arrDown || I.x, 'width:13px;height:13px;transform:rotate(90deg)')}</button>
      ${H.av(naam, 40)}
      <div style="flex:1;min-width:0">
        <div style="font-size:15px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(naam)}</div>
        <div style="font-size:12px;color:var(--text-3);margin-top:2px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          ${_channelIndicator(conv)}
          ${conv?.phone_number ? `<span class="mono">${esc(conv.phone_number)}</span>` : ''}
          ${conv?.status ? H.pill('neutral', conv.status) : ''}
        </div>
      </div>
      <span style="font-size:10.5px;color:var(--text-3);flex-shrink:0" class="mono" title="Conv-ID">${esc(convId).slice(0,8)}…</span>
    </div>`;
  }

  // Genereer HTML voor één bubbel + eventuele datum-separator. Gebruikt door
  // _inboxChatBody (initial render) én _appendNewThreadItems (append-only
  // refresh). Ontvangt de simoneIds-set + isWA vlag zodat het pure is.
  function _renderBubbleHtml(m, ctx) {
    const { isWA, simoneIds, prevDayKey, prevDir } = ctx;
    const _dayKey = (mm) => {
      const dt = new Date(mm.at || mm.sent_at || mm.created_at || NaN);
      if (!Number.isFinite(dt.getTime())) return 'unknown';
      return dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0');
    };
    const _dayLabel = (mm) => {
      const dt = new Date(mm.at || mm.sent_at || mm.created_at || NaN);
      if (!Number.isFinite(dt.getTime())) return '—';
      const now = new Date();
      if (dt.toDateString() === now.toDateString()) return 'Vandaag';
      const y = new Date(now); y.setDate(now.getDate()-1);
      if (dt.toDateString() === y.toDateString()) return 'Gisteren';
      return dt.toLocaleDateString('nl-NL', { weekday:'long', day:'numeric', month:'long', year: dt.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
    };
    const _timeShort = (mm) => {
      const dt = new Date(mm.at || mm.sent_at || mm.created_at || NaN);
      if (!Number.isFinite(dt.getTime())) return '';
      return String(dt.getHours()).padStart(2,'0') + ':' + String(dt.getMinutes()).padStart(2,'0');
    };
    const _statusIcon = (mm) => {
      const s = String(mm.status || '').toLowerCase();
      if (mm.read_at || s === 'read')      return '<span title="Gelezen" style="color:#53bdeb;font-weight:600;letter-spacing:-3px">✓✓</span>';
      if (mm.delivered_at || s === 'delivered') return '<span title="Bezorgd" style="color:var(--text-3);font-weight:600;letter-spacing:-3px">✓✓</span>';
      if (s === 'failed')                 return '<span title="Mislukt" style="color:var(--rose)">⚠</span>';
      if (mm.sent_at || s === 'sent' || s === 'accepted') return '<span title="Verzonden" style="color:var(--text-3)">✓</span>';
      return '';
    };
    const ch = String(m.channel || 'whatsapp').toLowerCase();
    const isEmail = ch === 'email';
    const out = m.direction === 'outbound' || m.direction === 'out';
    const dk = _dayKey(m);
    const sep = (dk !== prevDayKey && dk !== 'unknown')
      ? `<div class="inbox-c-date-separator"><span>${esc(_dayLabel(m))}</span></div>`
      : '';
    const sameSender = (prevDir === (out ? 'out' : 'in')) && !sep;
    const failed = m.status === 'failed' || m.failed_reason;
    const rowClasses = [
      'inbox-c-msg',
      out ? 'outbound' : 'inbound',
      sameSender ? 'same-sender' : '',
      failed ? 'failed' : '',
    ].filter(Boolean).join(' ');
    const timeShort = _timeShort(m);
    const receipt = out ? (m._pending ? '<span class="receipt" title="Bezig met versturen…">⏳</span>' : `<span class="receipt">${_statusIcon(m)}</span>`) : '';
    const bySimone = out && m.id && simoneIds.has(String(m.id));
    const simoneSparkle = bySimone ? '<span class="simone-sparkle" title="Verstuurd door Simone (AI)">✦</span>' : '';
    const metaVisible = `<span class="bubble-meta">${simoneSparkle}${esc(timeShort)}${receipt}</span>`;
    const metaPhantom = `<span class="meta-phantom" aria-hidden="true">${esc(timeShort)} ${out ? '✓✓' : ''}</span>`;
    const msgId = m.id != null ? String(m.id) : '';

    if (isEmail) {
      const subj = m.meta?.subject || '(geen onderwerp)';
      const fromName = m.meta?.from_name || m.meta?.from_address || '—';
      const bodyHtml = m.meta?.has_html ? '(HTML-inhoud — bekijk in v1 voor volledige opmaak)' : '';
      const bodyText = m.body || bodyHtml || '—';
      return { html: `${sep}<div class="${rowClasses}" data-msg-id="${esc(msgId)}">
        <div class="inbox-c-msg-bubble is-email">
          <div class="inbox-c-email-chip">✉ E-mail · ${esc(timeShort)}</div>
          <div class="inbox-c-email-subj">${esc(subj)}</div>
          <div class="inbox-c-email-from">${out ? 'aan' : 'van'}: ${esc(fromName)}</div>
          <div class="inbox-c-email-body">${esc(String(bodyText).slice(0, 800))}${String(bodyText).length > 800 ? '…' : ''}</div>
          ${(asArr(m.meta?.attachments).length > 0) ? `<div class="inbox-c-email-att">📎 ${asArr(m.meta?.attachments).length} bijlage(n)</div>` : ''}
        </div>
      </div>`, dk, dir: out ? 'out' : 'in' };
    }
    const tplName = m.template_name || m.meta?.template_name || null;
    const mediaUrl = m.media_url || m.meta?.media_url || null;
    const mediaType = m.media_type || m.meta?.media_type || null;
    const body = m.body || (tplName ? '' : (mediaUrl ? '📎 Bijlage (' + (mediaType || 'media') + ')' : '—'));
    const opacity = m._pending ? ';opacity:.65;font-style:italic' : '';
    return { html: `${sep}<div class="${rowClasses}" data-msg-id="${esc(msgId)}">
      <div class="inbox-c-msg-bubble" style="${opacity}">
        ${bySimone ? '<span class="inbox-c-simone-badge">🤖 Simone · AI</span><br>' : ''}
        ${tplName ? `<div class="inbox-c-msg-tplbadge" title="${esc(tplName)}">📄 via template</div>` : ''}
        <span class="bubble-text">${esc(body)}${metaPhantom}</span>
        ${m.failed_reason ? `<div class="inbox-c-msg-failed-reason">${esc(m.failed_reason.slice(0,80))}</div>` : ''}
        ${metaVisible}
      </div>
    </div>`, dk, dir: out ? 'out' : 'in' };
  }

  function _inboxChatBody(d, convId) {
    const conv = d?.conversation || null;
    const msgs = asArr(d?.items);
    const isWA = !!(conv?.phone_number || conv?.can_send_text);

    // Datum-scheiders + status-icoon + tijdstempels (WhatsApp-stijl).
    const _dayKey = (m) => {
      const dt = new Date(m.at || m.sent_at || m.created_at || NaN);
      if (!Number.isFinite(dt.getTime())) return 'unknown';
      return dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0');
    };
    const _dayLabel = (m) => {
      const dt = new Date(m.at || m.sent_at || m.created_at || NaN);
      if (!Number.isFinite(dt.getTime())) return '—';
      const now = new Date();
      if (dt.toDateString() === now.toDateString()) return 'Vandaag';
      const y = new Date(now); y.setDate(now.getDate()-1);
      if (dt.toDateString() === y.toDateString()) return 'Gisteren';
      return dt.toLocaleDateString('nl-NL', { weekday:'long', day:'numeric', month:'long', year: dt.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
    };
    const _timeShort = (m) => {
      const dt = new Date(m.at || m.sent_at || m.created_at || NaN);
      if (!Number.isFinite(dt.getTime())) return '';
      return String(dt.getHours()).padStart(2,'0') + ':' + String(dt.getMinutes()).padStart(2,'0');
    };
    const _statusIcon = (m) => {
      const s = String(m.status || '').toLowerCase();
      if (m.read_at || s === 'read')      return '<span title="Gelezen" style="color:#53bdeb;font-weight:600;letter-spacing:-3px">✓✓</span>';
      if (m.delivered_at || s === 'delivered') return '<span title="Bezorgd" style="color:var(--text-3);font-weight:600;letter-spacing:-3px">✓✓</span>';
      if (s === 'failed')                 return '<span title="Mislukt" style="color:var(--rose)">⚠</span>';
      if (m.sent_at || s === 'sent' || s === 'accepted') return '<span title="Verzonden" style="color:var(--text-3)">✓</span>';
      return '';
    };

    // Simone-verstuurde msg-ids (Set); als niet gefetched → lege set, wordt lazy geladen
    const simoneIds = _live.simoneMsgs.data[convId] || new Set();

    // Normaliseer: unified endpoint geeft channel/direction/at/body/meta.
    // Legacy inbox-messages-list geeft direction/body/sent_at zonder channel;
    // fall back op 'whatsapp' als channel ontbreekt.
    // Rendering 1-op-1 uit Wanbetalers `_inboxRenderMessages`
    // (modules/finance.html regels 14170-14296). DOM-skelet:
    //   <div class="inbox-c-msg outbound|inbound[.same-sender][.failed]">
    //     <div class="inbox-c-msg-bubble[.is-email]">
    //       [template-badge] [simone-badge]
    //       <span class="bubble-text">…<span class="meta-phantom">HH:MM ✓✓</span></span>
    //       <span class="bubble-meta">✦ HH:MM <span class="receipt">✓✓</span></span>
    //     </div>
    //   </div>
    // Kern-truc: .meta-phantom reserveert breedte in de laatste regel
    // tekst zodat de absolute .bubble-meta niet overlapt.
    let lastDay = null;
    let lastDir = null;
    const bubbles = msgs.map((m) => {
      const ch = String(m.channel || 'whatsapp').toLowerCase();
      const isEmail = ch === 'email';
      const out = m.direction === 'outbound' || m.direction === 'out';
      const dk = _dayKey(m);
      // BUG B FIX — skip separator bij ongeldige datum (was: toonde "—" bar
      // met epoch 1-1-1970 achterliggend). Nu: geen bar, geen 1970.
      const sep = (dk !== lastDay && dk !== 'unknown')
        ? `<div class="inbox-c-date-separator"><span>${esc(_dayLabel(m))}</span></div>`
        : '';
      const sameSender = (lastDir === (out ? 'out' : 'in')) && !sep;
      lastDay = dk;
      lastDir = out ? 'out' : 'in';

      const failed = m.status === 'failed' || m.failed_reason;
      const rowClasses = [
        'inbox-c-msg',
        out ? 'outbound' : 'inbound',
        sameSender ? 'same-sender' : '',
        failed ? 'failed' : '',
      ].filter(Boolean).join(' ');

      // Meta-content (tijd + status-vinkjes) — hetzelfde voor phantom en visible
      const timeShort = _timeShort(m);
      const receipt = out ? (m._pending ? '<span class="receipt" title="Bezig met versturen…">⏳</span>' : `<span class="receipt">${_statusIcon(m)}</span>`) : '';
      const bySimone = out && m.id && simoneIds.has(String(m.id));
      const simoneSparkle = bySimone ? '<span class="simone-sparkle" title="Verstuurd door Simone (AI)">✦</span>' : '';
      const metaVisible = `<span class="bubble-meta">${simoneSparkle}${esc(timeShort)}${receipt}</span>`;
      const metaPhantom = `<span class="meta-phantom" aria-hidden="true">${esc(timeShort)} ${out ? '✓✓' : ''}</span>`;

      const msgId = m.id != null ? String(m.id) : '';
      if (isEmail) {
        // ── E-MAIL BUBBEL — .is-email overlay op zelfde bubble-shell ──
        const subj = m.meta?.subject || '(geen onderwerp)';
        const fromName = m.meta?.from_name || m.meta?.from_address || '—';
        const bodyHtml = m.meta?.has_html ? '(HTML-inhoud — bekijk in v1 voor volledige opmaak)' : '';
        const bodyText = m.body || bodyHtml || '—';
        return `${sep}<div class="${rowClasses}" data-msg-id="${esc(msgId)}">
          <div class="inbox-c-msg-bubble is-email">
            <div class="inbox-c-email-chip">✉ E-mail · ${esc(timeShort)}</div>
            <div class="inbox-c-email-subj">${esc(subj)}</div>
            <div class="inbox-c-email-from">${out ? 'aan' : 'van'}: ${esc(fromName)}</div>
            <div class="inbox-c-email-body">${esc(String(bodyText).slice(0, 800))}${String(bodyText).length > 800 ? '…' : ''}</div>
            ${(asArr(m.meta?.attachments).length > 0) ? `<div class="inbox-c-email-att">📎 ${asArr(m.meta?.attachments).length} bijlage(n)</div>` : ''}
          </div>
        </div>`;
      }

      // ── WHATSAPP BUBBEL — Wanbetalers Pad A ──
      const tplName = m.template_name || m.meta?.template_name || null;
      const mediaUrl = m.media_url || m.meta?.media_url || null;
      const mediaType = m.media_type || m.meta?.media_type || null;
      const body = m.body || (tplName ? '' : (mediaUrl ? '📎 Bijlage (' + (mediaType || 'media') + ')' : '—'));
      const opacity = m._pending ? ';opacity:.65;font-style:italic' : '';
      return `${sep}<div class="${rowClasses}" data-msg-id="${esc(msgId)}">
        <div class="inbox-c-msg-bubble" style="${opacity}">
          ${bySimone ? '<span class="inbox-c-simone-badge">🤖 Simone · AI</span><br>' : ''}
          ${tplName ? `<div class="inbox-c-msg-tplbadge" title="${esc(tplName)}">📄 via template</div>` : ''}
          <span class="bubble-text">${esc(body)}${metaPhantom}</span>
          ${m.failed_reason ? `<div class="inbox-c-msg-failed-reason">${esc(m.failed_reason.slice(0,80))}</div>` : ''}
          ${metaVisible}
        </div>
      </div>`;
    }).join('');

    // Chat-body wrapper — id="ev-inbox-chat-scroll" voor scroll-track.
    // KRITIEK: min-height:0 op flex-child (Wanbetalers-patroon). Zonder deze
    // regel is default min-height:auto — element zet uit naar content-hoogte
    // i.p.v. te scrollen, en scrollHeight == clientHeight (dus scrollTop=
    // scrollHeight doet niks).
    // #ev-inbox-bottom-anchor als laatste child → scrollIntoView({block:'end'})
    // is immuun voor scrollHeight-timing (rendert on-screen positie, niet
    // gemeten scrollTop).
    // #ev-inbox-thread-inner is de append-target voor nieuwe bubbels.
    // #ev-inbox-bottom-anchor blijft altijd de laatste child (voor scrollIntoView).
    return `<div id="ev-inbox-chat-scroll" style="background:var(--surface-2);padding:14px 16px;flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;display:flex;flex-direction:column;scroll-behavior:auto" onscroll="window.__evChatScroll(this)">
      <div id="ev-inbox-thread-inner" style="width:100%;max-width:720px;margin:0 auto;display:flex;flex-direction:column;gap:0">
      ${msgs.length === 0
        ? `<div id="ev-inbox-thread-empty" style="text-align:center;color:var(--text-3);font-size:12.5px;padding:60px 0">Geen berichten in deze conversatie.</div>`
        : bubbles}
      <div id="ev-inbox-bottom-anchor" style="height:1px;flex-shrink:0" aria-hidden="true"></div>
      </div>
    </div>`;
  }

  // ── COMPOSER (reply) ────────────────────────────────────────────────────
  //
  // Endpoint hergebruik: POST /api/inbox-send met body
  // {conversation_id, mode:'text', body}. Permission-check: events.simone.use
  // (per module-scope). WhatsApp-ONLY endpoint; e-mail-replies zouden via
  // /api/send-email moeten (email_id + from_mailbox + to + subject vereist).
  // Voor deze iteratie: e-mail-conv (geen phone_number) → composer disabled
  // met uitleg + link naar v1.
  //
  // Optimistische bubbel: zet 'sending' bubble in msgs, PATCH DOM #ev-inbox-
  // right onmiddellijk, dan POST. Bij succes: refetch thread (invalidate
  // cache) + surgical repaint. Bij fout: rode banner + bubble.status='failed'.
  // Bepaal effectief kanaal: 'whatsapp' of 'email'. Prioriteit:
  //  - user-override via composeChannel[convId] (unified convs met beide kanalen)
  //  - conv.phone_number aanwezig → whatsapp
  //  - laatste msg is email → email
  //  - default whatsapp
  function _detectChannel(convId, conv) {
    const override = _ui.composeChannel[convId];
    if (override === 'email' || override === 'whatsapp') return override;
    if (conv?.phone_number || conv?.can_send_text) return 'whatsapp';
    // Check laatste bericht in thread
    const msgs = asArr(_live.inboxMsgs.data[convId]?.items);
    for (let i = msgs.length - 1; i >= 0; i--) {
      const ch = String(msgs[i].channel || '').toLowerCase();
      if (ch === 'email' || ch === 'whatsapp') return ch;
    }
    return 'whatsapp';
  }

  // Pak defaults voor e-mail-reply uit laatste inbound e-mail-bericht in thread.
  function _emailDefaults(convId, conv) {
    const msgs = asArr(_live.inboxMsgs.data[convId]?.items);
    // Zoek laatste inbound e-mail (voor Re:-subject + mailbox + email_id + to)
    let lastInboundEmail = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (String(m.channel || '').toLowerCase() === 'email' && (m.direction === 'inbound' || m.direction === 'in')) {
        lastInboundEmail = m; break;
      }
    }
    // Fallback: laatste e-mail (welke richting dan ook)
    if (!lastInboundEmail) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (String(m.channel || '').toLowerCase() === 'email') { lastInboundEmail = m; break; }
      }
    }
    const subj = lastInboundEmail?.meta?.subject || '';
    const reSubj = subj ? (subj.match(/^re:\s/i) ? subj : 'Re: ' + subj) : '';
    // email_id: unified endpoint prefixt outbound met 'reply:' — voor reply
    // moeten we terug naar de raw email_messages.id. Bij inbound is m.id de
    // originele email_messages.id (geen prefix).
    const emailId = lastInboundEmail && !String(lastInboundEmail.id || '').startsWith('reply:')
      ? String(lastInboundEmail.id) : null;
    const mailbox = lastInboundEmail?.meta?.mailbox || '';
    // to: klant-email. Bij inbound = from_address; anders conv.customer_email
    const toAddr = lastInboundEmail?.direction === 'inbound' || lastInboundEmail?.direction === 'in'
      ? (lastInboundEmail?.meta?.from_address || conv?.customer_email || '')
      : (conv?.customer_email || '');
    return { subject: reSubj, mailbox, email_id: emailId, to: toAddr };
  }

  function _inboxRightFooter(convId, conv) {
    const ch = _detectChannel(convId, conv);
    const isWA    = ch === 'whatsapp';
    const isEmail = ch === 'email';
    const draft = _ui.composeText[convId] || '';
    const busy  = !!_ui.composeBusy[convId];
    const err   = _ui.composeError[convId] || null;
    const tplState = _ui.composeTpl[convId] || null;
    // Waarschuw bij aanpassing van een geselecteerde template
    const tplEdited = tplState && draft.trim() !== String(tplState.originalBody || '').trim();
    // Simone-status per conv (voor waarschuwing bij overlap)
    const simEnabled = !!(_live.simoneCfg.data?.is_enabled);
    const simSuggest = !!(_live.simoneCfg.data?.feature_flags?.reactive_suggest_enabled);
    const simAuto    = !!(_live.simoneCfg.data?.feature_flags?.events_reactive_autonomy);
    const simActive  = simEnabled && (simSuggest || simAuto);

    // E-mail-defaults (subject + mailbox + to + email_id) alleen berekenen als e-mail
    let emailBits = null;
    if (isEmail) {
      const d = _emailDefaults(convId, conv);
      const curSubj    = (convId in _ui.composeSubject) ? _ui.composeSubject[convId] : d.subject;
      const curMailbox = (convId in _ui.composeMailbox) ? _ui.composeMailbox[convId] : d.mailbox;
      emailBits = { ...d, subject: curSubj, mailbox: curMailbox };
    }

    // Suggestion-blok (Simone stelt voor …) — alleen WA-conv en niet verborgen
    const sugg = _live.suggestion.data[convId];
    const showSugg = isWA && sugg && sugg.status === 'PROPOSED' && !_ui.suggestionHidden[convId];
    // "Simone bekijkt dit gesprek…" placeholder als:
    //  - WA-conv + Simone suggest-mode aan + géén suggestion (nog) + polling loopt
    //  - én niet actief loading (dan is er sowieso al feedback)
    const showSuggThinking = isWA && simEnabled && simSuggest && !sugg && !showSugg
      && _ui._simonePollConvId === convId && !_ui.suggestionHidden[convId];

    // 24-uurs WhatsApp-venster (Meta rule). Client-side bepaald uit laatste
    // inbound; server 422 fangt fallback op. Alleen relevant voor WA-conv.
    const wa24 = isWA ? _getWhatsAppWindow(convId, conv) : { open: true, hoursLeft: null };
    // Buiten venster: vrije-tekst textarea disabled, tenzij template
    // geselecteerd (die gaat via inbox-send-template en werkt buiten venster).
    const outsideWindow = isWA && !wa24.open;
    const freeTextBlocked = outsideWindow && !tplState;

    return `<div id="ev-inbox-footer" style="padding:10px 16px;border-top:1px solid var(--border);background:var(--surface);flex-shrink:0;display:flex;flex-direction:column;gap:6px">
      ${showSugg ? `<div style="padding:8px 10px;background:var(--violet-soft);border:1px solid var(--violet-line, var(--violet));border-radius:8px;color:var(--text);font-size:12.5px;line-height:1.45;display:flex;flex-direction:column;gap:6px">
        <div style="display:flex;align-items:center;gap:6px">
          <span style="display:inline-flex;align-items:center;justify-content:center;padding:1px 7px;background:var(--violet);color:white;border-radius:3px;font-size:10.5px;font-weight:600">🤖 Simone stelt voor</span>
          ${sugg.confidence != null ? `<span style="font-size:10.5px;color:var(--text-3)">confidence ${Math.round(Number(sugg.confidence) * 100)}%</span>` : ''}
          <button class="icon-btn" onclick="window.__evSuggestIgnore('${esc(convId)}','${esc(sugg.id)}')" style="margin-left:auto;width:22px;height:22px" title="Negeer / verberg">${svg(I.x || I.close, 'width:11px;height:11px')}</button>
        </div>
        <div style="white-space:pre-wrap;color:var(--text);font-size:12.5px;padding:2px 0">${esc(String(sugg.suggested_reply || '').slice(0, 500))}${String(sugg.suggested_reply || '').length > 500 ? '…' : ''}</div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-primary btn-sm" onclick="window.__evSuggestAccept('${esc(convId)}','${esc(sugg.id)}')" style="padding:4px 10px;font-size:11.5px">Overnemen</button>
          <button class="btn btn-ghost btn-sm" onclick="window.__evSuggestIgnore('${esc(convId)}','${esc(sugg.id)}')" style="padding:4px 10px;font-size:11.5px">Negeren</button>
        </div>
      </div>` : (showSuggThinking ? `<div style="padding:6px 10px;background:var(--surface-2);border:1px dashed var(--violet-line, var(--border));border-radius:6px;color:var(--text-3);font-size:11.5px;display:flex;align-items:center;gap:6px">
        <span style="display:inline-block;width:8px;height:8px;background:var(--violet);border-radius:50%;animation:evPulse 1.4s ease-in-out infinite"></span>
        🤖 Simone bekijkt dit gesprek…
        <span style="margin-left:auto;font-size:10.5px;color:var(--text-3)" title="Suggesties verschijnen alleen bij inbound berichten ≥ 5 tekens die niet in de 'trivial replies'-set staan. Cooldown 60s na jouw laatste antwoord.">ⓘ</span>
        <style>@keyframes evPulse { 0%,100% { opacity:.35; } 50% { opacity:1; } }</style>
      </div>` : (isWA && simEnabled && simSuggest && !sugg && !_ui.suggestionHidden[convId] ? `<div style="padding:6px 10px;background:var(--surface-2);border:1px dashed var(--border);border-radius:6px;color:var(--text-3);font-size:11px;display:flex;align-items:center;gap:6px">
        <span style="display:inline-flex;width:14px;height:14px;align-items:center;justify-content:center;font-size:10px;color:var(--violet)">🤖</span>
        <span style="flex:1">Geen recente Simone-suggestie. Nieuwe inbound-berichten (≥5 tekens) triggeren automatisch een concept — oude gesprekken (&gt;60min) worden niet meer gepolst.</span>
      </div>` : ''))}

      <div style="display:flex;align-items:center;gap:8px;font-size:11px;color:var(--text-3);flex-wrap:wrap">
        <span style="display:inline-flex;align-items:center;gap:4px">
          <span style="width:6px;height:6px;background:${isEmail ? 'var(--blue)' : '#25d366'};border-radius:50%"></span>
          Antwoord via ${isEmail ? 'e-mail' : 'WhatsApp'}
        </span>
        ${isWA && wa24.open && wa24.hoursLeft != null ? `<span style="color:${wa24.hoursLeft <= 2 ? 'var(--amber)' : 'var(--text-3)'};font-size:10.5px" title="Meta staat vrije tekst alleen toe binnen 24u na het laatste inbound klant-bericht. Daarbuiten kan alleen een template.">⏱ Nog ${wa24.hoursLeft}u binnen venster</span>` : ''}
        ${isWA && !wa24.open ? `<span style="color:var(--rose);font-weight:600;font-size:10.5px" title="Meta 24u-venster verstreken sinds het laatste inbound bericht. Vrije tekst is geblokkeerd — verstuur een goedgekeurde template.">🔒 Buiten 24u-venster</span>` : ''}
        ${tplState ? `<span style="display:inline-flex;align-items:center;gap:4px;padding:1px 6px;background:var(--pink-soft);color:var(--pink);border-radius:3px;font-size:10.5px;font-weight:600" title="Wordt als Meta-approved template verstuurd (werkt ook buiten 24u-venster)">📄 Meta-template: ${esc(tplState.name)}</span>` : ''}
        ${tplState ? `<button class="icon-btn" onclick="window.__evCompTplClear('${esc(convId)}')" style="width:18px;height:18px" title="Template loskoppelen (verstuur als vrije tekst)">${svg(I.x || I.close, 'width:10px;height:10px')}</button>` : ''}
        ${tplEdited ? `<span style="color:var(--amber);font-size:10.5px" title="Meta-templates verzenden alleen de gedefinieerde placeholder-params. Handmatige tekstwijzigingen worden genegeerd. Klik het ×-icoontje om als vrije tekst te verzenden (mits binnen 24u-venster).">⚠ Tekst aangepast — als template genegeerd</span>` : ''}
        ${simActive ? `<span style="margin-left:auto;color:var(--amber);font-weight:500" title="Simone kan alsnog autonoom antwoorden op nieuwe inbound berichten (60s cooldown na jouw send). Beheer Simone in de Agents-module.">⚠ Simone actief</span>` : ''}
      </div>
      ${freeTextBlocked ? `<div style="padding:8px 10px;background:var(--rose-soft);border:1px solid var(--rose-line);border-radius:6px;color:var(--rose);font-size:12px;line-height:1.4">
        <b>Buiten het 24-uurs WhatsApp-venster.</b> Je kunt alleen een goedgekeurde template versturen (📄 Template-knop). Meta staat vrije tekst alleen toe binnen 24u na het laatste klant-bericht.
      </div>` : ''}

      ${err ? `<div style="padding:6px 10px;background:var(--rose-soft);border:1px solid var(--rose-line);border-radius:6px;color:var(--rose);font-size:12px;display:flex;align-items:center;gap:8px">
        <span style="flex:1">⚠ ${esc(err)}</span>
        <button class="btn btn-ghost btn-sm" onclick="window.__evCompSend('${esc(convId)}')" style="padding:2px 8px;font-size:11px">Opnieuw</button>
        <button class="icon-btn" onclick="window.__evCompErrDismiss('${esc(convId)}')" style="width:22px;height:22px" title="Sluiten">${svg(I.x || I.close, 'width:11px;height:11px')}</button>
      </div>` : ''}

      ${isEmail ? `<div style="display:flex;gap:6px;flex-wrap:wrap">
        <select onchange="window.__evCompMailboxSet('${esc(convId)}', this.value)" ${busy ? 'disabled' : ''} style="padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12px;font-family:inherit">
          ${['info@deforexopleiding.nl','leads@deforexopleiding.nl','partners@deforexopleiding.nl','administratie@deforexopleiding.nl'].map((mb) => `<option value="${esc(mb)}" ${emailBits.mailbox === mb ? 'selected' : ''}>${esc(mb)}</option>`).join('')}
        </select>
        <input type="text" value="${esc(emailBits.subject)}" placeholder="Onderwerp" oninput="window.__evCompSubjectSet('${esc(convId)}', this.value)" ${busy ? 'disabled' : ''} style="flex:1;min-width:220px;padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12.5px;font-family:inherit" />
      </div>
      <div style="font-size:10.5px;color:var(--text-3)">Aan: <span class="mono">${esc(emailBits.to || '(geen adres — niet verzendbaar)')}</span>${!emailBits.email_id ? ' · <span style="color:var(--amber)">⚠ geen inbound e-mail om op te antwoorden — reply-in-thread niet mogelijk</span>' : ''}</div>
      ` : ''}

      <div style="display:flex;gap:6px;align-items:flex-end">
        <button class="btn btn-ghost btn-sm" onclick="window.__evCompTplOpen('${esc(convId)}')" title="${isEmail ? 'Templates zijn WhatsApp-only' : 'Kies een template'}" style="flex-shrink:0;padding:6px 10px;font-size:12px" ${busy || isEmail ? 'disabled' : ''}>${svg(I.doc || I.file, 'width:13px;height:13px')} Template</button>
        <textarea
          id="ev-comp-input-${esc(convId)}"
          placeholder="${freeTextBlocked ? 'Buiten 24u-venster — kies een template' : (isEmail ? 'Typ je e-mail-antwoord…' : 'Typ een antwoord… (Enter = versturen, Shift+Enter = nieuwe regel)')}"
          oninput="window.__evCompDraft('${esc(convId)}', this.value); window.__evCompAutoGrow(this)"
          onkeydown="window.__evCompKeydown(event, '${esc(convId)}')"
          ${busy || freeTextBlocked ? 'disabled' : ''}
          style="flex:1;min-height:${isEmail ? '80px' : '38px'};max-height:${isEmail ? '260px' : '160px'};padding:8px 12px;border:1px solid var(--border);border-radius:${isEmail ? '8px' : '20px'};background:${freeTextBlocked ? 'var(--surface-2)' : 'var(--surface)'};color:var(--text);font-size:13.5px;font-family:inherit;line-height:1.4;resize:none;box-sizing:border-box;overflow-y:auto"
        >${esc(draft)}</textarea>
        <button
          class="btn btn-primary btn-sm"
          onclick="window.__evCompSend('${esc(convId)}')"
          ${(!draft.trim() || busy || freeTextBlocked || (isEmail && (!emailBits.email_id || !emailBits.to || !emailBits.mailbox || !emailBits.subject.trim()))) ? 'disabled style="opacity:.55"' : ''}
          title="Versturen${isEmail ? '' : ' (Enter)'}"
          style="flex-shrink:0;padding:8px 14px;font-size:12px"
        >${busy ? '…' : (svg(I.send || I.arrRight || I.tick, 'width:13px;height:13px') + ' Versturen')}</button>
      </div>
    </div>`;
  }

  // ── COMPOSER HANDLERS ──────────────────────────────────────────────────
  window.__evCompDraft = (convId, val) => { _ui.composeText[convId] = String(val || ''); };
  window.__evCompErrDismiss = (convId) => {
    delete _ui.composeError[convId];
    _paintFooterOnly(convId);
  };
  window.__evCompAutoGrow = (el) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(160, Math.max(38, el.scrollHeight)) + 'px';
  };
  window.__evCompKeydown = (ev, convId) => {
    // Enter = versturen; Shift+Enter = nieuwe regel
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      window.__evCompSend(convId);
    }
  };
  window.__evCompSubjectSet = (convId, val) => { _ui.composeSubject[convId] = String(val || ''); };
  window.__evCompMailboxSet = (convId, val) => { _ui.composeMailbox[convId] = String(val || ''); };
  window.__evCompTplClear = (convId) => {
    delete _ui.composeTpl[convId];
    if (window.DFO?.render) window.DFO.render();
  };

  // Send-router: kiest tussen 3 endpoints op basis van kanaal + template-state.
  //   1) e-mail-conv → POST /api/send-email
  //   2) WA-conv + composeTpl gezet + tekst ongewijzigd t.o.v. originalBody
  //      → POST /api/inbox-send-template (echte Meta-template met resolved
  //         params via meta_param_mapping + context_event_attendee_id)
  //   3) WA-conv + vrije tekst (of template met handmatige edit) →
  //      POST /api/inbox-send (mode:'text')
  window.__evCompSend = async (convId) => {
    const text = String(_ui.composeText[convId] || '').trim();
    if (!text || _ui.composeBusy[convId]) return;
    const conv = _live.inboxMsgs.data[convId]?.conversation || null;
    const ch = _detectChannel(convId, conv);
    _ui.composeBusy[convId] = true;
    delete _ui.composeError[convId];

    // Optimistisch bubbel
    const optimisticId = 'opt-' + Date.now();
    const optimistic = ch === 'email' ? {
      id: optimisticId, channel: 'email', direction: 'outbound',
      body: text, at: new Date().toISOString(),
      meta: { subject: _ui.composeSubject[convId] || '', from_address: _ui.composeMailbox[convId] || '' },
      _pending: true,
    } : {
      id: optimisticId, channel: 'whatsapp', direction: 'outbound',
      body: text, at: new Date().toISOString(),
      status: 'sending', _pending: true,
      template_name: (_ui.composeTpl[convId] && !_isTplEdited(convId)) ? _ui.composeTpl[convId].name : null,
    };
    const cur = _live.inboxMsgs.data[convId];
    if (cur) { cur.items = asArr(cur.items).concat([optimistic]); }
    // Append-only: alleen nieuwe optimistic-bubble toevoegen, thread niet
    // herbouwen. Force-scroll naar bottom (eigen send = altijd zichtbaar).
    _ui._lastScrollAtBottom = true;
    _appendNewThreadItems(convId);
    // Composer resetten (draft/busy state) → footer-only paint
    _paintFooterOnly(convId);

    try {
      let j;
      if (ch === 'email') {
        // E-mail: send-email endpoint
        const d = _emailDefaults(convId, conv);
        const emailId  = d.email_id;
        const mailbox  = _ui.composeMailbox[convId] || d.mailbox;
        const subject  = _ui.composeSubject[convId] || d.subject;
        const to       = d.to;
        if (!emailId)  throw new Error('Geen inbound e-mail in de thread om op te antwoorden.');
        if (!mailbox)  throw new Error('Kies eerst een from_mailbox.');
        if (!subject)  throw new Error('Onderwerp is verplicht.');
        if (!to)       throw new Error('Ontvanger-adres onbekend.');
        j = await window.KV.authedJson('/api/send-email', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ from_mailbox: mailbox, to, subject, text, email_id: emailId }),
        });
      } else if (_ui.composeTpl[convId] && !_isTplEdited(convId)) {
        // Meta-template send (ongewijzigd t.o.v. resolved body → echte template)
        const tpl = _ui.composeTpl[convId];
        const bodyPayload = { conversation_id: convId, template_name: tpl.name, language: tpl.language || 'nl' };
        if (tpl.attendeeId) bodyPayload.context_event_attendee_id = tpl.attendeeId;
        j = await window.KV.authedJson('/api/inbox-send-template', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify(bodyPayload),
        });
      } else {
        // Vrije tekst (WA)
        j = await window.KV.authedJson('/api/inbox-send', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ conversation_id: convId, mode: 'text', body: text }),
        });
      }
      if (j?.error) throw new Error(j.error || j.message || 'send failed');

      // Als er een Simone-suggestie open stond: markeer USED_AS_IS/USED_EDITED.
      const sugg = _live.suggestion.data[convId];
      if (sugg && sugg.status === 'PROPOSED') {
        const isEdited = String(text).trim() !== String(sugg.suggested_reply || '').trim();
        try {
          await window.KV.authedJson('/api/joost-mark-outcome', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ suggestion_id: sugg.id, status: isEdited ? 'USED_EDITED' : 'USED_AS_IS', final_sent_text: text }),
          });
        } catch (_) {}   // best-effort, verstuurd is de belangrijkste actie
        _live.suggestion.data[convId] = null;
      }

      // Succes: cleanup + refetch
      _ui.composeText[convId] = '';
      delete _ui.composeTpl[convId];
      delete _ui.composeSubject[convId];
      // composeMailbox behouden: is een user-voorkeur voor de sessie
      _live.inboxMsgs.data[convId] = null; _live.inboxMsgs.loading[convId] = false;
      _live.inboxMsgs.error[convId] = null;
      _live.inbox.data = null; _live.inbox.error = null;
      queueMicrotask(fetchInbox);
      // Post-send refetch: haalt REAL msg-id op (i.p.v. optimistic 'opt-…')
      // en update simoneMsgs. _appendNewThreadItems dedupt op data-msg-id
      // dus de optimistic bubble wordt niet dubbel — wel de echte msg.
      // Verwijder de optimistic bubble eerst uit DOM (id is opt-… en zit
      // niet in de refetch-response) zodat de echte bubble op zijn plek
      // komt zonder duplicaat.
      const optEl = document.querySelector('.inbox-c-msg[data-msg-id="' + optimisticId + '"]');
      if (optEl) optEl.remove();
      await fetchInboxMsgs(convId, () => _appendNewThreadItems(convId));
      // Composer/suggestion state opnieuw renderen
      _paintFooterOnly(convId);
      _showToast(ch === 'email' ? 'E-mail verstuurd' : 'Bericht verstuurd');
    } catch (e) {
      // Server-side 24u-venster: /api/inbox-send retourneert 422
      // { error:'24h_window_expired', message, ... } bij vrije tekst buiten
      // venster. Herken en toon zelfde uitleg als client-side check.
      const msg = String(e?.message || '');
      const isWindowExpired = /24h_window_expired|24-?uurs|24-?hour/i.test(msg);
      _ui.composeError[convId] = isWindowExpired
        ? 'Buiten het 24-uurs WhatsApp-venster — kies een template om alsnog te versturen.'
        : (msg || 'Versturen mislukt');
      if (cur) {
        const idx = cur.items.findIndex((x) => x.id === optimisticId);
        if (idx >= 0) cur.items[idx] = { ...cur.items[idx], _pending: false, status: 'failed', failed_reason: _ui.composeError[convId] };
      }
    } finally {
      _ui.composeBusy[convId] = false;
      _paintFooterOnly(convId);
    }
  };

  function _isTplEdited(convId) {
    const tpl = _ui.composeTpl[convId];
    if (!tpl) return false;
    return String(_ui.composeText[convId] || '').trim() !== String(tpl.originalBody || '').trim();
  }

  // Simone-suggestie handlers
  window.__evSuggestAccept = (convId, suggId) => {
    const s = _live.suggestion.data[convId];
    if (!s || s.id !== suggId) return;
    // Prefill textarea + focus. Markeren gebeurt pas bij verzenden (USED_AS_IS
    // of USED_EDITED afhankelijk van of Jeffrey nog wijzigingen maakt).
    _ui.composeText[convId] = String(s.suggested_reply || '');
    // Als er een template geselecteerd was: loskoppelen (Simone-tekst is vrije tekst)
    delete _ui.composeTpl[convId];
    _paintFooterOnly(convId);
    queueMicrotask(() => {
      const el = document.getElementById('ev-comp-input-' + convId);
      if (el) { try { el.focus({ preventScroll: true }); } catch (_) { el.focus(); } window.__evCompAutoGrow(el); }
    });
  };
  window.__evSuggestIgnore = async (convId, suggId) => {
    const s = _live.suggestion.data[convId];
    if (!s || s.id !== suggId) return;
    _ui.suggestionHidden[convId] = true;
    _paintFooterOnly(convId);
    // Best-effort mark als DISMISSED — als endpoint faalt (bv. al final status),
    // is de UI-hide voldoende voor deze sessie.
    try {
      await window.KV.authedJson('/api/joost-mark-outcome', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ suggestion_id: suggId, status: 'DISMISSED' }),
      });
      _live.suggestion.data[convId] = null;
    } catch (_) {}
  };

  // ── TEMPLATE PICKER MODAL ─────────────────────────────────────────────
  window.__evCompTplOpen = (convId) => {
    _ui.tplPickerOpen = convId;
    _ui.tplPickerQ = '';
    if (!_live.inboxTpls.data[convId] && !_live.inboxTpls.loading[convId] && !(_live.inboxTpls.error && _live.inboxTpls.error[convId])) queueMicrotask(() => fetchInboxTpls(convId));
    if (window.DFO?.render) window.DFO.render();
  };
  window.__evCompTplClose = () => {
    _ui.tplPickerOpen = null;
    if (window.DFO?.render) window.DFO.render();
  };
  window.__evCompTplSearch = (q) => {
    _ui.tplPickerQ = String(q || '');
    if (window.DFO?.render) window.DFO.render();
  };
  window.__evCompTplPick = (convId, tplName) => {
    const items = asArr(_live.inboxTpls.data[convId]);
    const tpl = items.find((t) => t.name === tplName);
    if (!tpl) return;
    // Substitueer named placeholders best-effort met beschikbare context.
    // Meta-templates gebruiken positioneel {{N}} + meta_param_mapping; wij
    // resolven op named-syntax {{categorie.veld}} in de body_text zelf (voor
    // preview). Placeholders zonder match blijven zichtbaar zodat Jeffrey ze
    // handmatig kan invullen.
    let text = String(tpl.body_text || '');
    const ctx = _buildTplContext(convId);
    text = text.replace(/\{\{\s*([a-z_]+\.[a-z_]+)\s*\}\}/gi, (m, key) => {
      const v = ctx[key];
      return v != null && v !== '' ? String(v) : m;   // laat {{...}} staan als geen match
    });
    _ui.composeText[convId] = text;
    // Bewaar template-state zodat send-router weet: verstuur als Meta-template
    // (mits tekst niet handmatig aangepast). originalBody = resolved preview,
    // vergelijkbaar met _ui.composeText tot Jeffrey typt.
    _ui.composeTpl[convId] = {
      name: tpl.name,
      language: tpl.language || 'nl',
      originalBody: text,
      attendeeId: ctx._attendeeId || null,
    };
    _ui.tplPickerOpen = null;
    if (window.DFO?.render) window.DFO.render();
    // Focus + autogrow na render
    queueMicrotask(() => {
      const el = document.getElementById('ev-comp-input-' + convId);
      if (el) { try { el.focus({ preventScroll: true }); } catch (_) { el.focus(); } window.__evCompAutoGrow(el); }
    });
  };
  // Bouw client-side placeholder-context uit conv + eventuele attendee/event
  // die al in _live cache staan (via detail-view of attendee-detail-modal).
  function _buildTplContext(convId) {
    const conv = _live.inboxMsgs.data[convId]?.conversation || null;
    const ctx = {};
    // klant.*
    if (conv?.customer_name) {
      const parts = String(conv.customer_name).trim().split(/\s+/);
      ctx['klant.voornaam']  = parts[0] || '';
      ctx['klant.achternaam']= parts.slice(1).join(' ') || '';
      ctx['klant.naam']      = conv.customer_name;
    }
    if (conv?.phone_number) ctx['klant.telefoon'] = conv.phone_number;
    // bedrijf.* — env-driven placeholders zijn server-side; niet client-resolvable
    // datum.* — client-side simpele resolve
    const now = new Date();
    ctx['datum.vandaag'] = now.toLocaleDateString('nl-NL', { day:'numeric', month:'long', year:'numeric' });
    // attendee.* + event.* — probeer vanuit eerste event-detail cache waarbij
    // deze conv/klant matcht (best-effort). Sla over als geen match; blijft
    // {{attendee.voornaam}} staan zodat Jeffrey het ziet.
    for (const eid of Object.keys(_live.attendees.data || {})) {
      const list = asArr(_live.attendees.data[eid]);
      const att = list.find((a) => a.customer_id && conv?.customer_id && a.customer_id === conv.customer_id);
      if (att) {
        ctx._attendeeId           = att.id;
        ctx['attendee.voornaam']  = att.first_name || att.voornaam || '';
        ctx['attendee.achternaam']= att.last_name  || att.achternaam || '';
        ctx['attendee.email']     = att.email || '';
        ctx['attendee.telefoon']  = att.phone || att.telefoon || '';
        const ev = _live.detail.data[eid];
        if (ev) {
          ctx['event.titel']    = ev.title || '';
          ctx['event.datum']    = ev.starts_at ? new Date(ev.starts_at).toLocaleDateString('nl-NL', { day:'numeric', month:'long' }) : '';
          ctx['event.tijd']     = ev.starts_at ? new Date(ev.starts_at).toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit' }) : '';
          ctx['event.locatie']  = ev.location || '';
        }
        break;
      }
    }
    return ctx;
  }

  function _tplPickerModal() {
    if (!_ui.tplPickerOpen) return '';
    const convId = _ui.tplPickerOpen;
    const st = _live.inboxTpls;
    let body;
    if (st.loading[convId] && !st.data[convId]) body = `<div style="padding:20px;text-align:center;color:var(--text-3);font-size:13px">Templates laden…</div>`;
    else if (st.error[convId] && !st.data[convId]) body = `<div style="padding:16px">${errBlk('tpls', st.error[convId])}</div>`;
    else {
      const items = asArr(st.data[convId]);
      const q = String(_ui.tplPickerQ || '').toLowerCase();
      const filtered = q
        ? items.filter((t) => String(t.name || '').toLowerCase().includes(q) || String(t.body_text || '').toLowerCase().includes(q))
        : items;
      // Groepeer per folder
      const byFolder = new Map();
      for (const t of filtered) {
        const key = t.folder?.name || t.folder_name || '— zonder map —';
        if (!byFolder.has(key)) byFolder.set(key, []);
        byFolder.get(key).push(t);
      }
      body = `<div style="padding:12px 16px 8px;position:sticky;top:0;background:var(--surface);border-bottom:1px solid var(--border);z-index:2">
        <input type="search" placeholder="Zoek template (naam of tekst)…" value="${esc(_ui.tplPickerQ)}" oninput="window.__evCompTplSearch(this.value)" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);font-size:13px" autofocus />
        <div style="font-size:11px;color:var(--text-3);margin-top:5px">${filtered.length} van ${items.length} templates${q ? ' (gefilterd)' : ''}</div>
      </div>
      ${filtered.length === 0
        ? `<div style="padding:20px;text-align:center;color:var(--text-3);font-size:13px">Geen templates gevonden${q ? ' voor "' + esc(q) + '"' : ''}.</div>`
        : `<div style="padding:8px 12px 12px;max-height:60vh;overflow-y:auto">
          ${Array.from(byFolder.entries()).map(([folder, tpls]) => `
            <div style="margin-top:10px">
              <div style="font-size:10.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em;font-weight:600;padding:4px 4px">${esc(folder)}</div>
              ${tpls.map((t) => `<button
                onclick="window.__evCompTplPick('${esc(convId)}','${esc(t.name)}')"
                style="display:block;width:100%;text-align:left;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);margin-bottom:4px;cursor:pointer;font-family:inherit"
                onmouseover="this.style.background='var(--surface-2)'" onmouseout="this.style.background='var(--surface)'"
              >
                <div style="font-size:12.5px;font-weight:600;color:var(--text);margin-bottom:2px">${esc(t.name)} <span style="font-size:10px;font-weight:400;color:var(--text-3)">· ${esc(t.language || '—')}${t.category ? ' · ' + esc(t.category) : ''}</span></div>
                <div style="font-size:11.5px;color:var(--text-3);line-height:1.4;white-space:pre-wrap;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical">${esc(String(t.body_text || '').slice(0, 240))}${String(t.body_text || '').length > 240 ? '…' : ''}</div>
              </button>`).join('')}
            </div>
          `).join('')}
        </div>`}`;
    }
    return `<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px" onclick="if(event.target===this)window.__evCompTplClose()">
      <div style="background:var(--surface);border-radius:12px;border:1px solid var(--border);max-width:620px;width:100%;max-height:80vh;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.3);display:flex;flex-direction:column">
        <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
          <div style="font-size:14px;font-weight:600;flex:1">Kies een template</div>
          <button class="icon-btn" onclick="window.__evCompTplClose()" title="Sluiten" style="width:28px;height:28px">${svg(I.x || I.close, 'width:13px;height:13px')}</button>
        </div>
        <div style="flex:1;overflow-y:auto">${body}</div>
      </div>
    </div>`;
  }

  // ── Simone polling voor open conv ──────────────────────────────────────
  // Simone-suggest is async (Anthropic-call kan enkele seconden duren) en
  // wordt getriggerd door de webhook, niet door onze frontend. Om een
  // net-gegenereerde suggestie te tonen zonder page-refresh: poll de
  // suggestie-endpoint elke 15s zolang het gesprek open is EN er nog geen
  // PROPOSED-suggestie aanwezig is. Stop bij conv-switch of zodra we een
  // suggestion binnen krijgen.
  function _startSimonePolling(convId) {
    // Clear vorige timer
    if (_ui._simonePollTimer) { try { clearInterval(_ui._simonePollTimer); } catch (_) {} _ui._simonePollTimer = null; }
    _ui._simonePollConvId = convId;
    let tries = 0;
    const MAX_TRIES = 6;   // 6 × 15s = 90s window
    _ui._simonePollTimer = setInterval(() => {
      tries++;
      // Stop-condities
      if (_ui._simonePollConvId !== convId || _ui.inboxConvId !== convId) {
        clearInterval(_ui._simonePollTimer); _ui._simonePollTimer = null; return;
      }
      if (_live.suggestion.data[convId] && _live.suggestion.data[convId].status === 'PROPOSED') {
        clearInterval(_ui._simonePollTimer); _ui._simonePollTimer = null; return;
      }
      if (tries >= MAX_TRIES) {
        clearInterval(_ui._simonePollTimer); _ui._simonePollTimer = null; return;
      }
      // Force refetch (invalidate) + repaint na binnenkomst
      _live.suggestion.data[convId] = null;
      _live.suggestion.loading[convId] = false;
      fetchSuggestion(convId).then(() => {
        // Als suggestion binnen is: alleen footer-blok updaten (composer +
        // suggestion-card zitten daarin). Thread-scrollpositie blijft.
        if (_live.suggestion.data[convId]) _paintFooterOnly(convId);
      });
    }, 15000);
  }

  // ── Full right-pane paint (alleen bij conv-switch of initial load) ───
  // Vervangt HELE #ev-inbox-right innerHTML. Gebruik alleen bij:
  //   - conv-switch (__evInboxSelect)
  //   - initial thread-load (fetchInboxMsgs callback)
  //   - error/loading state van thread
  // NIET aanroepen tijdens polling/realtime refresh — die gebruiken
  // _appendNewThreadItems (append-only) + _paintFooterOnly (composer-update).
  // Caller regelt scroll (typisch _scrollChatToBottom(true) na paint).
  function _paintRightSurgical(convId) {
    try {
      const r = document.querySelector('#ev-inbox-right');
      if (!r) return;
      r.innerHTML = _inboxRightPane(convId);
    } catch (_) {}
  }

  // ── Append-only refresh: voeg alleen NIEUWE bubbels toe ──────────────
  // Vergelijk data-msg-id in DOM met items in cache. Bestaande DOM-nodes
  // NIET aanraken → browser houdt scrollTop automatisch vast. Bij _stick
  // (near-bottom) → auto-scroll na append; anders positie blijft staan.
  function _appendNewThreadItems(convId) {
    const inner = document.querySelector('#ev-inbox-thread-inner');
    const anchor = document.querySelector('#ev-inbox-bottom-anchor');
    if (!inner) return;
    const d = _live.inboxMsgs.data[convId];
    if (!d) return;
    const msgs = asArr(d.items);
    if (msgs.length === 0) return;

    // Bestaande msg-ids uit DOM
    const existingIds = new Set();
    inner.querySelectorAll('.inbox-c-msg[data-msg-id]').forEach((el) => {
      const id = el.getAttribute('data-msg-id');
      if (id) existingIds.add(id);
    });

    const conv = d.conversation || null;
    const isWA = !!(conv?.phone_number || conv?.can_send_text);
    const simoneIds = _live.simoneMsgs.data[convId] || new Set();

    // Continuïteit: prevDayKey + prevDir uit LAATSTE bubble in DOM
    const rows = inner.querySelectorAll('.inbox-c-msg');
    const lastRow = rows.length ? rows[rows.length - 1] : null;
    let prevDayKey = null, prevDir = null;
    if (lastRow) {
      const lastId = lastRow.getAttribute('data-msg-id');
      const lastMsg = msgs.find((m) => String(m.id) === lastId);
      if (lastMsg) {
        const dt = new Date(lastMsg.at || lastMsg.sent_at || lastMsg.created_at || NaN);
        if (Number.isFinite(dt.getTime())) {
          prevDayKey = dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0');
        }
        prevDir = (lastMsg.direction === 'outbound' || lastMsg.direction === 'out') ? 'out' : 'in';
      }
    }

    const htmlChunks = [];
    let appendedCount = 0;
    for (const m of msgs) {
      const id = m.id != null ? String(m.id) : '';
      if (id && existingIds.has(id)) continue;
      const { html, dk, dir } = _renderBubbleHtml(m, { isWA, simoneIds, prevDayKey, prevDir });
      htmlChunks.push(html);
      prevDayKey = dk;
      prevDir = dir;
      appendedCount++;
    }
    if (appendedCount === 0) return;
    const empty = document.querySelector('#ev-inbox-thread-empty');
    if (empty) empty.remove();
    const fragment = document.createElement('div');
    fragment.innerHTML = htmlChunks.join('');
    const children = Array.from(fragment.children);
    for (const child of children) {
      if (anchor) inner.insertBefore(child, anchor);
      else inner.appendChild(child);
    }
    // Sticky-bottom: als _stick=true, mee-scrollen. Anders: browser houdt
    // scrollTop vast omdat we bestaande nodes niet aanraakten (append-only).
    if (_ui._lastScrollAtBottom) {
      requestAnimationFrame(() => {
        const scrollEl = document.querySelector('#ev-inbox-chat-scroll');
        if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
      });
    }
  }

  // ── Footer-only paint: alleen composer + suggestie-blok updaten ──────
  // #ev-inbox-footer wordt vervangen; #ev-inbox-chat-scroll blijft intact
  // → scrollTop blijft. Composer-focus + cursor-positie hersteld.
  function _paintFooterOnly(convId) {
    try {
      const oldFooter = document.querySelector('#ev-inbox-footer');
      if (!oldFooter) return;
      const active = document.activeElement;
      const focusId = (active && active.id && active.id.startsWith('ev-comp-input-')) ? active.id : null;
      const cursorPos = (focusId && active.setSelectionRange && active.value !== undefined) ? active.selectionStart : null;
      const d = _live.inboxMsgs.data[convId];
      const conv = d?.conversation || null;
      const wrapper = document.createElement('div');
      wrapper.innerHTML = _inboxRightFooter(convId, conv);
      const newFooter = wrapper.firstElementChild;
      if (!newFooter) return;
      oldFooter.replaceWith(newFooter);
      if (focusId) {
        const el = document.getElementById(focusId);
        if (el) {
          try { el.focus({ preventScroll: true }); } catch (_) { el.focus(); }
          if (cursorPos != null && el.setSelectionRange) {
            try { el.setSelectionRange(cursorPos, cursorPos); } catch (_) {}
          }
        }
      }
    } catch (_) {}
  }

  // ── Chat-scroll tracking (sticky-bottom check zoals Wanbetalers) ──────
  function _isScrolledNearBottom() {
    const el = document.querySelector('#ev-inbox-chat-scroll');
    if (!el) return true;   // default: assume bottom
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    return dist < 80;   // 80px threshold — zelfde als Wanbetalers regel 14103
  }
  window.__evChatScroll = (el) => {
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    _ui._lastScrollAtBottom = dist < 80;
    // Debug-trace: als scrollTop naar 0 valt terwijl scrollHeight > clientHeight,
    // is er ergens een unintended reset. Loggen (alleen ?debug=1) zodat we
    // toekomstige regressie snel zien.
    if (String(window.location?.search || '').includes('debug=1')
      && el.scrollTop === 0 && el.scrollHeight > el.clientHeight + 20) {
      console.trace('[ev-scroll RESET] scrollTop=0 gedetecteerd', { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
    }
  };
  // Scroll-to-bottom via anchor-element (#ev-inbox-bottom-anchor).
  //
  // Root-cause van de eerdere bug: #ev-inbox-chat-scroll miste min-height:0
  // in de flex-column layout → element zette uit naar content-hoogte i.p.v.
  // te scrollen, scrollHeight == clientHeight, dus scrollTop-set deed niks.
  // Fix: min-height:0 op scroll-container (Wanbetalers-patroon) + anchor-div
  // als laatste child + scrollIntoView({block:'end'}). Anchor-pattern is
  // immuun voor scrollHeight-timing want browser rendert op-positie.
  //
  // Extra retry na 100ms voor gevallen waar innerHTML nog niet klaar is
  // (bv. subsequent repaint na fetch + realtime). force=true skipt de
  // sticky-bottom check.
  //
  // Debug: bij ?debug=1 loggen we alle scroll-metrics vóór en na de set,
  // plus 200ms later om re-render-side-effects te tracen.
  function _scrollChatToBottom(force) {
    const isDebug = String(window.location?.search || '').includes('debug=1');
    const doScroll = (tag) => {
      const scrollEl = document.querySelector('#ev-inbox-chat-scroll');
      const anchor   = document.querySelector('#ev-inbox-bottom-anchor');
      if (!scrollEl && !anchor) {
        if (isDebug) console.log('[ev-scroll ' + tag + '] no scroll-el and no anchor — skip');
        return;
      }
      // Sticky-bottom check — alleen als niet-forced
      if (!force && scrollEl) {
        const dist = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
        if (dist > 80) {
          if (isDebug) console.log('[ev-scroll ' + tag + '] user reading up (dist=' + dist + '), skip');
          return;
        }
      }
      const before = scrollEl ? {
        scrollTop: scrollEl.scrollTop,
        scrollHeight: scrollEl.scrollHeight,
        clientHeight: scrollEl.clientHeight,
        overflowScroll: scrollEl.scrollHeight > scrollEl.clientHeight,
      } : null;
      // Primary: anchor.scrollIntoView (browser regelt de scroll)
      if (anchor && anchor.scrollIntoView) {
        try { anchor.scrollIntoView({ block: 'end', inline: 'nearest', behavior: 'auto' }); } catch (_) {}
      }
      // Fallback: directe scrollTop-set (voor het geval anchor er niet is)
      if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
      const after = scrollEl ? {
        scrollTop: scrollEl.scrollTop,
        scrollHeight: scrollEl.scrollHeight,
        clientHeight: scrollEl.clientHeight,
      } : null;
      if (isDebug) console.log('[ev-scroll ' + tag + ']', { before, after, anchorFound: !!anchor });
      _ui._lastScrollAtBottom = true;
    };
    // 3 pogingen: direct via dubbele rAF (layout klaar), en na 100ms als
    // vangnet voor subsequent innerHTML-swaps (surgical repaint na fetch).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        doScroll('rAF');
      });
    });
    setTimeout(() => doScroll('t100'), 100);
    if (isDebug) {
      setTimeout(() => {
        const el = document.querySelector('#ev-inbox-chat-scroll');
        if (!el) return;
        console.log('[ev-scroll t200-verify]', {
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          atBottom: (el.scrollHeight - el.scrollTop - el.clientHeight) < 4,
        });
      }, 200);
    }
  }

  // ── 24-uurs WhatsApp-venster ──────────────────────────────────────────
  // Meta staat vrije-tekst-berichten alleen toe binnen 24u na het LAATSTE
  // INBOUND klant-bericht. Bepaling client-side uit de unified thread:
  // scan items[] laatste inbound (channel='whatsapp', direction='inbound'/
  // 'in'). Server-side validatie is authoritative: /api/inbox-send retourneert
  // 422 { error:'24h_window_expired', ... } — we vangen die op als fail-soft
  // en tonen dezelfde uitleg als de client-side check.
  //
  // Return: { open: bool, hoursLeft: number|null, lastInboundAt: iso|null }
  function _getWhatsAppWindow(convId, conv) {
    // Alleen relevant voor WA-convs
    const isWA = !!(conv?.phone_number || conv?.can_send_text);
    if (!isWA) return { open: true, hoursLeft: null, lastInboundAt: null };
    const msgs = asArr(_live.inboxMsgs.data[convId]?.items);
    // Zoek laatste WA-inbound (skip email + outbound)
    let lastInbound = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      const ch = String(m.channel || 'whatsapp').toLowerCase();
      if (ch !== 'whatsapp') continue;
      if (m.direction === 'inbound' || m.direction === 'in') { lastInbound = m; break; }
    }
    if (!lastInbound) return { open: false, hoursLeft: 0, lastInboundAt: null };
    const at = new Date(lastInbound.at || lastInbound.sent_at || lastInbound.created_at || 0);
    if (!Number.isFinite(at.getTime())) return { open: true, hoursLeft: null, lastInboundAt: null };
    const now = Date.now();
    const elapsedMs = now - at.getTime();
    const WINDOW_MS = 24 * 60 * 60 * 1000;
    const hoursLeft = Math.max(0, Math.round((WINDOW_MS - elapsedMs) / (60 * 60 * 1000)));
    return { open: elapsedMs < WINDOW_MS, hoursLeft, lastInboundAt: at.toISOString() };
  }

  // ── Realtime + polling voor instant-berichten ─────────────────────────
  // Zelfde patroon als Wanbetalers (finance.html regels 16018-16074):
  // Supabase channel op whatsapp_messages INSERT + 8s poll-fallback op de
  // open thread + 15s poll-fallback op de conv-list. Alles wordt gestopt
  // als de Inbox-tab verlaten wordt (via __evInboxDismount, aangeroepen
  // door tab-switch handler).
  function _startInboxRealtime(convId) {
    _stopInboxRealtime();   // idempotent
    if (!convId) return;
    _ui._rtMsgConvId = convId;
    // Supabase channel op WA-messages INSERT (filter per conv-id)
    try {
      if (window.supabase?.channel) {
        _ui._rtMsgChannel = window.supabase
          .channel('ev-inbox-msg-' + convId)
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'whatsapp_messages', filter: 'conversation_id=eq.' + convId }, () => {
            // Nieuw bericht → refetch thread + list surgical
            _liveRefreshThread(convId);
          })
          .subscribe();
        _ui._rtConvChannel = window.supabase
          .channel('ev-inbox-convs')
          .on('postgres_changes', { event: '*', schema: 'public', table: 'whatsapp_conversations' }, () => {
            _liveRefreshList();
          })
          .subscribe();
      }
    } catch (e) { console.warn('[ev-inbox rt] channel-setup fail:', e?.message); }
    // Polling-fallback (voor het geval realtime dood is, én voor unread/preview-updates)
    _ui._pollThreadTimer = setInterval(() => { if (_ui.inboxConvId === convId) _liveRefreshThread(convId); }, 8000);
    _ui._pollListTimer   = setInterval(() => { _liveRefreshList(); }, 15000);
  }
  function _stopInboxRealtime() {
    try { if (_ui._rtMsgChannel  && window.supabase?.removeChannel) window.supabase.removeChannel(_ui._rtMsgChannel); } catch (_) {}
    try { if (_ui._rtConvChannel && window.supabase?.removeChannel) window.supabase.removeChannel(_ui._rtConvChannel); } catch (_) {}
    _ui._rtMsgChannel = null; _ui._rtConvChannel = null; _ui._rtMsgConvId = null;
    if (_ui._pollThreadTimer) { clearInterval(_ui._pollThreadTimer); _ui._pollThreadTimer = null; }
    if (_ui._pollListTimer)   { clearInterval(_ui._pollListTimer);   _ui._pollListTimer   = null; }
  }
  // Re-entrancy guard flags voor de refresh-callbacks (voorkomen stapeling)
  let _refreshingThread = null, _refreshingList = false;
  async function _liveRefreshThread(convId) {
    if (_refreshingThread === convId) return;
    _refreshingThread = convId;
    try {
      const j = await window.KV.authedJson('/api/inbox-thread-unified?conversation_id=' + encodeURIComponent(convId) + '&include_email=1&limit=200');
      if (!j || j.error) return;
      const st = _live.inboxMsgs;
      st.data[convId] = { conversation: j?.conversation || null, items: asArr(j?.items) };
      // APPEND-ONLY: nooit innerHTML-swap tijdens refresh. _appendNewThreadItems
      // vergelijkt data-msg-id met DOM en voegt alleen nieuwe toe. Bestaande
      // bubbels blijven ongewijzigd → scrollTop blijft vanzelf staan.
      _appendNewThreadItems(convId);
    } catch (_) {} finally { _refreshingThread = null; }
  }
  async function _liveRefreshList() {
    if (_refreshingList) return;
    _refreshingList = true;
    try {
      const j = await window.KV.authedJson('/api/inbox-conversations-list?module=events&limit=100');
      if (!j || j.__error || j.error) return;
      const newItems = asArr(j?.items);
      const prevSig = JSON.stringify(asArr(_live.inbox.data).map((c) => [c.id, c.last_message_at, c.unread_count]));
      const newSig  = JSON.stringify(newItems.map((c) => [c.id, c.last_message_at, c.unread_count]));
      if (prevSig === newSig) return;
      _live.inbox.data = newItems;
      // Surgical: alleen rows-container updaten (behoud zoekveld + focus)
      const rowsEl = document.querySelector('#ev-inbox-rows');
      if (rowsEl) {
        const q = String(_ui.inboxSearchQ || '').trim().toLowerCase();
        const filtered = q ? newItems.filter((c) => {
          const naam  = (c.customer_name || c.display_name || '').toLowerCase();
          const phone = String(c.phone_number || '').toLowerCase();
          const email = String(c.customer_email || '').toLowerCase();
          return naam.includes(q) || phone.includes(q) || email.includes(q);
        }) : newItems;
        rowsEl.innerHTML = filtered.length === 0
          ? `<div style="padding:16px;text-align:center;color:var(--text-3);font-size:12px">Geen gesprekken gevonden${q ? ' voor "' + esc(q) + '"' : ''}.</div>`
          : _inboxLeftList(filtered, _ui.inboxConvId);
      }
    } catch (_) {} finally { _refreshingList = false; }
  }

  // Cleanup-hook — aangeroepen als de Inbox-tab de-mount (via DFO.VIEWS
  // hook + main-view lifecycle). Voor nu: expose als window-func, roep aan
  // vanuit __evInboxBack / bij tab-switch (via DFO.on-tab-change hook).
  window.__evInboxDismount = () => {
    _stopInboxRealtime();
    if (_ui._simonePollTimer) { clearInterval(_ui._simonePollTimer); _ui._simonePollTimer = null; _ui._simonePollConvId = null; }
  };

  // ── HANDLERS: SPLIT-PANE SELECTIE + NAVIGATIE ──────────────────────────
  //
  // Surgical DOM-update: bewust géén DFO.render() bij het klikken op een
  // gesprek. In plaats daarvan:
  //  1) linker-lijst-scrollpositie bewaren
  //  2) .active class op nieuwe rij zetten, oude weghalen
  //  3) narrow-mode wrapper naar 'detail' zetten
  //  4) messages fetchen indien niet cached; onDone-callback updatet
  //     alleen #ev-inbox-right innerHTML
  window.__evInboxSelect = async (convId) => {
    if (!convId) return;
    // Scroll-positie linkerlijst opslaan (voor eventuele latere DFO.render)
    const leftEl = document.querySelector('#ev-inbox-rows') || document.querySelector('#ev-inbox-left');
    if (leftEl) _ui.inboxScrollTop = leftEl.scrollTop;

    _ui.inboxConvId = convId;
    _ui.inboxNarrowMode = 'detail';
    _ui.suggestionHidden[convId] = false;
    _startSimonePolling(convId);
    // Start Supabase realtime + polling voor deze conv (was ander conv → stop eerst)
    _startInboxRealtime(convId);

    // Toggle .active class op rijen (surgical)
    try {
      const rows = document.querySelectorAll('.ev-inbox-row');
      rows.forEach((el) => { el.classList.toggle('active', el.dataset.convId === convId); });
    } catch (_) {}
    // Narrow-mode data-attr
    try {
      const wrap = document.querySelector('.ev-inbox-split');
      if (wrap) wrap.dataset.mode = 'detail';
    } catch (_) {}

    // Right pane content
    const rightEl = document.querySelector('#ev-inbox-right');
    const paint = () => {
      const r = document.querySelector('#ev-inbox-right');
      if (r) r.innerHTML = _inboxRightPane(convId);
      // Bij openen van een gesprek: ALTIJD onderaan starten (ook bij cached
      // data). Sticky-bottom check overslaan → force=true.
      _scrollChatToBottom(true);
    };
    if (_live.inboxMsgs.data[convId]) {
      paint();  // cached
      return;
    }
    // Show loading skeleton immediately
    if (rightEl) rightEl.innerHTML = _inboxRightHeader(null, convId) + _inboxRightSkel();
    if (!_live.inboxMsgs.loading[convId]) {
      await fetchInboxMsgs(convId, paint);   // callback → paint zonder DFO.render
    } else {
      // Al fetching (bv. door prefetch); wacht kort en re-paint
      const wait = () => { if (!_live.inboxMsgs.loading[convId]) paint(); else setTimeout(wait, 100); };
      wait();
    }
  };

  window.__evInboxBackList = () => {
    // Alleen relevant op <900px: toon lijst full-width, verberg right pane.
    _ui.inboxNarrowMode = 'list';
    try {
      const wrap = document.querySelector('.ev-inbox-split');
      if (wrap) wrap.dataset.mode = 'list';
    } catch (_) {}
  };

  // Legacy aliassen (gebruikt door attendee-detail modal + eerdere calls):
  window.__evInboxOpen = (convId) => { window.__evInboxSelect(convId); };
  window.__evInboxBack = () => {
    // Refresh de inbox-lijst (unread-counts kunnen zijn veranderd).
    _live.inbox.data = null; _live.inbox.error = null;
    _ui.inboxConvId = null;
    _ui.inboxNarrowMode = 'list';
    queueMicrotask(fetchInbox);
    if (window.DFO?.render) window.DFO.render();
  };

  function _inboxViewer(convId) {
    // Deprecated: vervangen door split-pane rendering in inboxView(). Behouden
    // als thin wrapper zodat eventuele externe callers (attendee-modal fallback)
    // niet stukgaan.
    return _inboxRightHeader(_live.inboxMsgs.data[convId]?.conversation || null, convId)
      + _inboxRightPane_dummy(convId);
  }
  function _inboxRightPane_dummy(convId) {
    const d = _live.inboxMsgs.data[convId];
    if (!d) return _inboxRightSkel();
    return _inboxChatBody(d, convId) + _inboxRightFooter(convId, d?.conversation || null);
  }
  // Stub — vervangen door split-pane inbox
  function _inboxViewer_OLD(convId) {
    const st = _live.inboxMsgs;
    if (!st.data[convId] && !st.loading[convId] && !st.error[convId]) queueMicrotask(() => fetchInboxMsgs(convId));
    const backBar = `<div style="padding:12px 20px;background:var(--surface-2);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
      <button class="btn btn-ghost btn-sm" onclick="window.__evInboxBack()">${svg(I.arrDown || I.x, 'width:13px;height:13px;transform:rotate(90deg)')}Terug naar inbox</button>
      <span style="font-size:11px;color:var(--text-3);margin-left:auto">Conv-ID: <span class="mono">${esc(convId).slice(0,8)}…</span></span>
    </div>`;
    if (st.error[convId] && !st.data[convId]) return backBar + errBlk('inboxMsgs', st.error[convId]);
    if (st.loading[convId] && !st.data[convId]) return backBar + skel();
    const d = st.data[convId];
    const conv = d?.conversation || null;
    const msgs = asArr(d?.items);
    const naam = conv?.customer_name || conv?.display_name || conv?.phone_number || '—';
    const isWA = !!(conv?.phone_number || conv?.can_send_text);

    // Datum-scheiders: groepeer berichten per lokale dag.
    const _dayKey = (m) => {
      const d = new Date(m.at || m.sent_at || m.created_at || NaN);
      if (!Number.isFinite(d.getTime())) return 'unknown';
      return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    };
    const _dayLabel = (m) => {
      const d = new Date(m.at || m.sent_at || m.created_at || NaN);
      if (!Number.isFinite(d.getTime())) return '—';
      const now = new Date();
      const isToday = d.toDateString() === now.toDateString();
      const y = new Date(now); y.setDate(now.getDate()-1);
      const isYest = d.toDateString() === y.toDateString();
      if (isToday) return 'Vandaag';
      if (isYest)  return 'Gisteren';
      return d.toLocaleDateString('nl-NL', { weekday:'long', day:'numeric', month:'long', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
    };
    const _timeShort = (m) => {
      const d = new Date(m.at || m.sent_at || m.created_at || NaN);
      if (!Number.isFinite(d.getTime())) return '';
      return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
    };
    // Status-icoon (WhatsApp-stijl 2 vinkjes)
    const _statusIcon = (m) => {
      const s = String(m.status || '').toLowerCase();
      if (m.read_at || s === 'read')      return '<span title="Gelezen" style="color:#53bdeb;font-weight:600;letter-spacing:-3px">✓✓</span>';
      if (m.delivered_at || s === 'delivered') return '<span title="Bezorgd" style="color:var(--text-3);font-weight:600;letter-spacing:-3px">✓✓</span>';
      if (s === 'failed')                 return '<span title="Mislukt" style="color:var(--rose)">⚠</span>';
      if (m.sent_at || s === 'sent' || s === 'accepted') return '<span title="Verzonden" style="color:var(--text-3)">✓</span>';
      return '';
    };

    let lastDay = null;
    const bubbles = msgs.map((m) => {
      const out = m.direction === 'outbound';
      const body = m.body || (m.template_name ? '📄 Template: ' + m.template_name : (m.media_url ? '📎 Bijlage (' + (m.media_type || 'media') + ')' : '—'));
      const dk = _dayKey(m);
      const sep = (dk !== lastDay)
        ? `<div style="display:flex;justify-content:center;margin:14px 0 8px"><span style="padding:4px 12px;background:rgba(0,0,0,.06);border-radius:10px;font-size:11px;font-weight:500;color:var(--text-3)">${esc(_dayLabel(m))}</span></div>`
        : '';
      lastDay = dk;
      const bubbleBg = out
        ? (isWA ? '#d9fdd3' : 'var(--pink-soft)')
        : 'var(--surface)';
      const bubbleColor = out && isWA ? '#111' : 'var(--text)';
      // Tail-triangle (chat-look)
      const tail = out
        ? `<span style="position:absolute;right:-6px;top:0;width:8px;height:13px;background:${bubbleBg};clip-path:polygon(0 0, 100% 0, 0 100%)"></span>`
        : `<span style="position:absolute;left:-6px;top:0;width:8px;height:13px;background:${bubbleBg};clip-path:polygon(0 0, 100% 0, 100% 100%);border-left:1px solid var(--border)"></span>`;
      return `${sep}<div style="display:flex;justify-content:${out ? 'flex-end' : 'flex-start'};padding:0 4px">
        <div style="max-width:65%;position:relative">
          <div style="position:relative;padding:6px 10px 5px;border-radius:8px;background:${bubbleBg};color:${bubbleColor};font-size:13.5px;line-height:1.42;white-space:pre-wrap;word-wrap:break-word;box-shadow:0 1px 1px rgba(0,0,0,.08);${out ? '' : 'border:1px solid var(--border)'}">
            ${tail}
            ${m.template_name ? `<div style="font-size:10.5px;color:${out && isWA ? '#4a7c3a' : 'var(--text-3)'};font-weight:600;margin-bottom:2px">📄 ${esc(m.template_name)}</div>` : ''}
            <span>${esc(body)}</span>
            <div style="display:inline-flex;align-items:center;gap:4px;margin-left:8px;float:right;padding-top:4px">
              <span class="mono" style="font-size:10.5px;color:${out && isWA ? '#667781' : 'var(--text-3)'}">${esc(_timeShort(m))}</span>
              ${out ? _statusIcon(m) : ''}
            </div>
            <div style="clear:both"></div>
            ${m.failed_reason ? `<div style="font-size:10.5px;color:var(--rose);margin-top:2px;font-style:italic">Fout: ${esc(m.failed_reason.slice(0,60))}</div>` : ''}
          </div>
        </div>
      </div>`;
    }).join('');

    // Chat-achtergrond (subtiel patroon, licht/donker-safe via tokens)
    const chatBg = `background:var(--surface-2);background-image:radial-gradient(rgba(0,0,0,.03) 1px, transparent 1px);background-size:16px 16px`;

    return `${backBar}
    <div style="padding:12px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;background:var(--surface)">
      ${H.av(naam, 40)}
      <div style="flex:1;min-width:0">
        <div style="font-size:15px;font-weight:600">${esc(naam)}</div>
        <div style="font-size:12px;color:var(--text-3);margin-top:2px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          ${_channelIndicator(conv)}
          ${conv?.phone_number ? `<span class="mono">${esc(conv.phone_number)}</span>` : ''}
          ${conv?.status ? H.pill('neutral', conv.status) : ''}
        </div>
      </div>
    </div>
    <div style="${chatBg};padding:16px 20px;max-height:calc(100vh - 300px);min-height:400px;overflow-y:auto;display:flex;flex-direction:column;gap:4px">
      ${msgs.length === 0
        ? `<div style="text-align:center;color:var(--text-3);font-size:12.5px;padding:60px 0">Geen berichten in deze conversatie.</div>`
        : bubbles}
    </div>
    <div style="padding:10px 20px;border-top:1px solid var(--border);background:var(--surface-2);font-size:12px;color:var(--text-3);text-align:center">
      Sturen vanuit deze viewer nog niet ondersteund — gebruik <a href="/modules/events.html?conv=${encodeURIComponent(convId)}#inbox" target="_blank" style="color:var(--pink);text-decoration:underline">v1-inbox</a> voor reply.
    </div>`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INSCHRIJVINGEN-tab (behouden)
  // ═══════════════════════════════════════════════════════════════════════
  function inschrijvingenView() {
    const status = _live.signups.filter;
    if (!_live.signups.data && !_live.signups.loading && !_live.signups.error) queueMicrotask(() => fetchSignups(status));
    if (_live.signups.error && !_live.signups.data) return errBlk('signups', _live.signups.error);
    if (_live.signups.loading && !_live.signups.data) return skel();
    const rawRows = asArr(_live.signups.data?.rows);
    // v=47 client-side groepering: dedupt cross-event dubbelen per
    // (normalizedEmail || normalizedPhone, matched_event_id). Behoud de
    // MEEST RECENTE rij per groep als "primaire"; N-badge toont hoeveel
    // rijen er in de groep zitten. Server-side dedup pakt alleen dubbelen
    // op ghl_form_submission_id; cross-event same-person is aparte case.
    const _normEmail = (e) => String(e || '').trim().toLowerCase();
    const _normPhone = (p) => {
      const digits = String(p || '').replace(/\D/g, '');
      // Lesson-18-fallback: gebruik de laatste 9 cijfers als beschikbaar,
      // matcht verschillende landcode-formats van hetzelfde nummer.
      return digits.length >= 9 ? digits.slice(-9) : digits;
    };
    const groupsByKey = new Map();
    for (const r of rawRows) {
      const eKey = _normEmail(r.email);
      const pKey = _normPhone(r.phone);
      const evId = String(r.matched_event_id || r.matched_event?.id || 'nomatch');
      const key = (eKey || pKey || String(r.id)) + '|' + evId;
      const arr = groupsByKey.get(key) || [];
      arr.push(r);
      groupsByKey.set(key, arr);
    }
    // Sorteer per groep op received_at DESC → head = meest recente.
    for (const arr of groupsByKey.values()) {
      arr.sort((a, b) => String(b.received_at || '').localeCompare(String(a.received_at || '')));
    }
    // rows = 1 head per groep, met group-metadata (dupe-count).
    const rows = Array.from(groupsByKey.values()).map((arr) => {
      const head = arr[0];
      return arr.length > 1 ? { ...head, __groupCount: arr.length } : head;
    });
    // Herstel sortering (nieuwste eerst).
    rows.sort((a, b) => String(b.received_at || '').localeCompare(String(a.received_at || '')));
    const counts = _live.signups.data?.counts || {};
    return `<div class="toolbar" style="padding:12px 20px;gap:6px;flex-wrap:wrap;border-bottom:1px solid var(--border)">
      ${[['','Alles','total'],['matched','Matched','matched'],['ambiguous','Ambigu','ambiguous'],['no_match','Geen match','no_match'],['invalid_payload','Ongeldig','invalid_payload']].map(([v, l, k]) =>
        `<button class="chip ${status === v ? 'on' : ''}" onclick="window.__evSetSignupStatus('${v}')">${esc(l)}<span class="cnt">${Number(counts[k] || 0)}</span></button>`
      ).join('')}
      <div class="tb-right"><button class="btn btn-ghost btn-sm" onclick="__evRetry('signups')">${svg(I.refresh || I.tick)}</button></div>
    </div>
    ${rows.length === 0
      ? emptyBlk('Geen inschrijvingen', 'Er zijn geen inbound-inschrijvingen in deze categorie.')
      : H.table(
          [{l:'Deelnemer'},{l:'E-mail',cls:'optional'},{l:'Opgegeven event',cls:'optional'},{l:'Match'},{l:'Vragenlijst',cls:'optional'},{l:'Ingeschreven',cls:'r'}],
          rows.map((r) => {
            const naam = [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || '—';
            // BUG 4b FIX — event-titel + datum tonen. matched_event heeft .title
            // en .starts_at. Fallback event_date_label (opgegeven ruwe datum-tekst).
            const evTitle = r.matched_event?.title || r.opgegeven_event || '—';
            const evDate  = r.matched_event?.starts_at ? _fmtDate(r.matched_event.starts_at) : (r.event_date_label || '');
            const ms = r.match_status || 'onbekend';
            const [mc, ml] = ms === 'matched' ? ['ok','Matched'] : ms === 'ambiguous' ? ['warn','Ambigu'] : ms === 'no_match' ? ['danger','Geen match'] : ['neutral','Ongeldig'];
            // BUG 4a FIX — signup-inbox-list retourneert `questionnaire_filled`
            // (boolean) direct in de response, uit gejoinde event_attendees.
            // Autoritatief: r.questionnaire_filled. Fallback op oude velden alleen
            // als 'ie ontbreekt (achterwaartse compat).
            const hasQuest = r.questionnaire_filled === true
              || (!('questionnaire_filled' in r) && !!(r.matched_attendee?.assessment_response_id || r.assessment_response_id));
            // Punt 3 — toon tijdstip vragenlijst-invulling naast vinkje.
            // Bron: r.questionnaire_filled_at (bevestigd in api/events-signup-
            // inbox-list.js regel 133).
            const qDate = hasQuest && r.questionnaire_filled_at ? _fmtDate(r.questionnaire_filled_at) : '';
            const qTime = hasQuest && r.questionnaire_filled_at ? _fmtTime(r.questionnaire_filled_at) : '';
            const questCell = ms === 'matched'
              ? (hasQuest
                  ? `<div style="display:flex;flex-direction:column;align-items:center;gap:1px">
                      <span title="Vragenlijst ingevuld" style="color:var(--emerald);font-size:14px;line-height:1">✓</span>
                      ${qDate ? `<div class="mono" style="font-size:10px;color:var(--text-3);line-height:1.15">${esc(qDate)}${qTime ? ' ' + esc(qTime) : ''}</div>` : ''}
                    </div>`
                  : `<span title="Vragenlijst nog niet ingevuld" style="color:var(--rose);font-size:14px">✗</span>`)
              : `<span title="Nog geen match — vragenlijst onbekend" style="color:var(--text-3);font-size:12px">—</span>`;
            const insDate = _fmtDate(r.received_at);
            const insTime = _fmtTime(r.received_at);
            // Bug 1A: wire rij aan __evAttOpen als er een gematchte attendee is;
            // anders subtiele "geen gekoppelde deelnemer"-melding via toast.
            // FIX: veld heet matched_attendee_id (flat), niet matched_attendee.id
            // — endpoint api/events-signup-inbox-list.js:71 select't beide flat
            // (matched_attendee_id / matched_event_id) én matched_event als
            // nested-join. matched_attendee is GEEN nested object. Fallback op
            // nested voor forward-compat als endpoint later join toevoegt.
            const attId   = r.matched_attendee_id || r.matched_attendee?.id || null;
            const eventId = r.matched_event_id    || r.matched_event?.id    || null;
            // v=47: bij gegroepeerde dubbelen (__groupCount > 1) toont
            // een amber pill '× N inschrijvingen' naast de naam. Klik op
            // rij opent de meest recente (head van de groep); oudere rijen
            // zijn zichtbaar via de server (GET details per id).
            const groupBadge = r.__groupCount > 1
              ? `<span title="${esc(r.__groupCount + ' inschrijvingen van dezelfde persoon voor dit event')}" style="display:inline-flex;align-items:center;padding:1px 7px;border-radius:10px;background:var(--amber-soft);color:var(--amber);font-size:10px;font-weight:600;margin-left:6px">× ${r.__groupCount}</span>`
              : '';
            const nameCell = attId && eventId
              ? `<a href="#" onclick="event.preventDefault();window.__evAttOpen('${esc(attId)}','${esc(eventId)}')" title="Bekijk deelnemer-detail" style="color:inherit;text-decoration:none;display:block"><div class="row-avatar" style="cursor:pointer">${H.av(naam, 28)}<span class="cell-main" style="text-decoration:underline;text-decoration-color:var(--border);text-underline-offset:2px">${esc(naam)}${groupBadge}</span></div></a>`
              : `<div class="row-avatar" style="cursor:default" onclick="window.__evSignupNoMatch()" title="Nog geen gekoppelde deelnemer">${H.av(naam, 28)}<span class="cell-main" style="color:var(--text-2)">${esc(naam)}${groupBadge}</span></div>`;
            return [
              nameCell,
              `<span style="color:var(--text-3);font-size:12.5px">${esc(r.email || '—')}</span>`,
              `<div style="min-width:0"><div style="color:var(--text-2);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(evTitle)}</div>${evDate ? `<div class="mono" style="font-size:11.5px;color:var(--text-3)">${esc(evDate)}</div>` : ''}</div>`,
              H.pill(mc, ml),
              questCell,
              `<div style="text-align:right"><div class="mono" style="font-size:12.5px;color:var(--text-2)">${esc(insDate)}</div><div class="mono" style="font-size:11px;color:var(--text-3)">${esc(insTime)}</div></div>`,
            ];
          })
        )}${_globalOverlays()}`;
  }
  window.__evSetSignupStatus = (v) => { _live.signups.data = null; _live.signups.error = null; fetchSignups(v); };
  // Bug 1A: subtiele melding voor niet-gematchte inschrijvingen (geen dode klik).
  window.__evSignupNoMatch = () => {
    if (typeof _showToast === 'function') _showToast('Nog geen gekoppelde deelnemer — wacht op auto-match of match handmatig.');
    else alert('Nog geen gekoppelde deelnemer — wacht op auto-match of match handmatig.');
  };

  // ═══════════════════════════════════════════════════════════════════════
  // STATISTIEKEN-tab (vervangt Mentor-grootboek)
  // ═══════════════════════════════════════════════════════════════════════
  function statistiekenView() {
    if (!_live.completed.data && !_live.completed.loading && !_live.completed.error) queueMicrotask(fetchCompleted);
    if (!_live.revenue.data   && !_live.revenue.loading   && !_live.revenue.error)   queueMicrotask(fetchRevenue);
    if (_live.completed.error && !_live.completed.data) return errBlk('completed', _live.completed.error);
    if (_live.completed.loading && !_live.completed.data) return skel();
    const events = asArr(_live.completed.data);
    // Verrijk elk event met revenue_eur uit /api/events-revenue-list
    // (map event_id → {revenue_eur, deal_count}). Fail-soft: als endpoint nog
    // laadt of fout gaf, tonen we 0/'—' en een subtiele banner.
    const revenueMap = _live.revenue.data || {};
    const revenueLoading = _live.revenue.loading && !_live.revenue.data;
    const revenueError   = _live.revenue.error;
    const eventWithRev = (e) => ({
      ...e,
      revenue_eur: Number(revenueMap[e.event_id]?.revenue_eur || 0),
      deal_count:  Number(revenueMap[e.event_id]?.deal_count  || 0),
    });
    const eventsAll = events.map(eventWithRev);

    const now = new Date();
    const startYear = new Date(now.getFullYear(), 0, 1);
    const startQuarter = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    const eventsYTD = eventsAll.filter((e) => { const d = new Date(e.completed_at || e.starts_at); return Number.isFinite(d.getTime()) && d >= startYear; });
    const eventsQTD = eventsAll.filter((e) => { const d = new Date(e.completed_at || e.starts_at); return Number.isFinite(d.getTime()) && d >= startQuarter; });

    // ECHTE €-omzet uit revenue-endpoint (SUM deals.total_amount waar
    // tl_quotation_status IN ('accepted','signed'), per event_id).
    const omzetYTD = eventsYTD.reduce((a, e) => a + e.revenue_eur, 0);
    const omzetQTD = eventsQTD.reduce((a, e) => a + e.revenue_eur, 0);
    const gemOmzet = eventsYTD.length > 0 ? omzetYTD / eventsYTD.length : 0;
    const totAanwezig = eventsYTD.reduce((a, e) => a + Number(e.aanwezig || 0), 0);

    return `${revenueLoading ? `<div style="margin:14px 20px;padding:10px 14px;background:var(--surface-2);border-radius:var(--r);font-size:12px;color:var(--text-3);display:flex;align-items:center;gap:10px">${svg(I.clock, 'width:14px;height:14px')}Omzet-data laadt…</div>` : ''}
    ${revenueError ? errBlk('revenue', 'Omzet-endpoint — ' + revenueError) : ''}

    ${H.kpis([
      { c:'blue',    icon:I.euro,  label:'Omzet YTD',            val:eur0(omzetYTD), hi:1, sub:eventsYTD.length + ' afgeronde events' },
      { c:'violet',  icon:I.chart, label:'Omzet dit kwartaal',   val:eur0(omzetQTD), hi:1, sub:eventsQTD.length + ' events' },
      { c:'emerald', icon:I.grad,  label:'Gem. omzet/event',     val:eur0(Math.round(gemOmzet)), sub:'YTD' },
      { c:'teal',    icon:I.users, label:'Totaal aanwezigen',    val:fmtNum(totAanwezig), sub:'YTD' },
    ])}

    <div class="pad"><div class="grid g2" style="margin-bottom:14px">
      <div class="card">
        <div class="card-head"><span class="tile-ico" style="background:var(--blue-soft);color:var(--blue)">${svg(I.chart)}</span><div class="card-title">Omzet per maand</div><span style="margin-left:auto;font-size:11px;color:var(--text-3)">laatste 12 mnd · € (accepted/signed)</span></div>
        ${_omzetMaandChart(eventsAll)}
      </div>
      <div class="card">
        <div class="card-head"><span class="tile-ico" style="background:var(--emerald-soft);color:var(--emerald)">${svg(I.grad)}</span><div class="card-title">Top-events (omzet)</div><span style="margin-left:auto;font-size:11px;color:var(--text-3)">YTD</span></div>
        <div class="card-body" style="padding:12px 17px">
          ${_topEventsByRevenue(eventsYTD)}
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><span class="tile-ico" style="background:var(--pink-soft);color:var(--pink)">${svg(I.cal)}</span><div class="card-title">Per afgerond event (${eventsAll.length})</div><span style="margin-left:auto;font-size:11px;color:var(--text-3)">Omzet = SUM deal.total_amount (accepted/signed)</span></div>
      ${eventsAll.length === 0
        ? emptyBlk('Geen afgeronde events', 'Zodra events worden afgerond verschijnt hier de data.')
        : H.table(
            [{l:'Event'},{l:'Voltooid op',cls:'optional'},{l:'Aanwezig',cls:'r optional'},{l:'Omzet',cls:'r'},{l:'#Verkopen',cls:'r optional'},{l:'Bonus mentor',cls:'r optional'},{l:'Uitgaven',cls:'r optional'},{l:'Netto',cls:'r'}],
            eventsAll.map((e) => {
              const netto = e.revenue_eur - Number(e.bonus_total || 0) - Number(e.expenses_total || 0);
              return [
                `<a href="#" onclick="event.preventDefault();window.__evGoDetail('${esc(e.event_id)}')" style="color:inherit;text-decoration:none"><span class="cell-main">${esc(e.title || '—')}</span></a>`,
                `<span class="mono" style="color:var(--text-3);font-size:12.5px">${esc(_fmtDate(e.completed_at || e.starts_at))}</span>`,
                `<span class="mono">${Number(e.aanwezig || 0)}</span>`,
                `<span class="money" style="font-weight:600">${e.revenue_eur > 0 ? eur0(e.revenue_eur) : '—'}</span>`,
                `<span class="mono" style="color:var(--text-3)">${Number(e.sales || 0)}</span>`,
                `<span class="money">${eur0(Number(e.bonus_total || 0))}</span>`,
                `<span class="money" style="color:var(--amber)">${Number(e.expenses_total || 0) ? '− ' + eur0(Number(e.expenses_total)) : '—'}</span>`,
                `<span class="money" style="color:${netto >= 0 ? 'var(--emerald)' : 'var(--rose)'};font-weight:500">${e.revenue_eur > 0 ? eur0(netto) : '—'}</span>`,
              ];
            })
          )}
    </div>
    </div>${_globalOverlays()}`;
  }

  function _omzetMaandChart(events) {
    // Bucket € omzet per maand — 12 maanden terug. events elk verrijkt met revenue_eur.
    const now = new Date();
    const buckets = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      buckets.push({ label: d.toLocaleDateString('nl-NL', { month:'short' }), key: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'), omzet: 0 });
    }
    const byKey = new Map(buckets.map((b) => [b.key, b]));
    for (const e of events) {
      const d = new Date(e.completed_at || e.starts_at);
      if (!Number.isFinite(d.getTime())) continue;
      const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      const b = byKey.get(k); if (b) b.omzet += Number(e.revenue_eur || 0);
    }
    const maxV = Math.max(1, ...buckets.map((b) => b.omzet));
    const W = 480, H_ = 160, pad = { t: 12, r: 12, b: 24, l: 52 };
    const cw = W - pad.l - pad.r, ch = H_ - pad.t - pad.b;
    const bw = cw / buckets.length * 0.68;
    const gap = cw / buckets.length * 0.32;
    // Labels als €k voor leesbaarheid
    const fmtY = (v) => v >= 1000 ? '€' + Math.round(v / 1000) + 'k' : v > 0 ? '€' + Math.round(v) : '€0';
    return `<div class="card-body" style="padding:14px 12px 8px">
      <svg viewBox="0 0 ${W} ${H_}" style="width:100%;height:auto;display:block" preserveAspectRatio="xMidYMid meet">
        ${[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const y = pad.t + ch - ch * f;
          return `<line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="var(--border)" stroke-width="1" stroke-dasharray="2,3" opacity=".5" />
            <text x="${pad.l - 4}" y="${y + 3}" text-anchor="end" font-size="9" fill="var(--text-3)" font-family="'IBM Plex Mono',monospace">${fmtY(maxV * f)}</text>`;
        }).join('')}
        ${buckets.map((b, i) => {
          const x = pad.l + i * (bw + gap) + gap / 2;
          const h = ch * (b.omzet / maxV);
          const y = pad.t + ch - h;
          return `<rect x="${x}" y="${y}" width="${bw}" height="${h}" fill="var(--blue)" opacity=".85" rx="2"><title>${esc(b.label)}: ${eur0(b.omzet)}</title></rect>
            <text x="${x + bw / 2}" y="${H_ - 6}" text-anchor="middle" font-size="9" fill="var(--text-3)" font-family="'IBM Plex Mono',monospace">${esc(b.label)}</text>`;
        }).join('')}
      </svg>
    </div>`;
  }
  function _topEventsByRevenue(events) {
    const sorted = [...events].sort((a, b) => Number(b.revenue_eur || 0) - Number(a.revenue_eur || 0)).slice(0, 5);
    if (sorted.length === 0 || sorted.every((e) => (e.revenue_eur || 0) === 0)) {
      return `<div style="font-size:12.5px;color:var(--text-3);padding:8px 0">Nog geen omzet dit jaar (of endpoint laadt nog).</div>`;
    }
    return sorted.map((e, i) => `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:${i < sorted.length - 1 ? '1px solid var(--border)' : 'none'}">
      <span style="width:22px;height:22px;border-radius:50%;background:var(--surface-2);color:var(--text-2);display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:600">${i + 1}</span>
      <div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.title || '—')}</div>
        <div style="font-size:11px;color:var(--text-3)">${esc(_fmtDate(e.completed_at || e.starts_at))} · ${Number(e.aanwezig || 0)} aanwezig · ${e.deal_count || 0} deals</div></div>
      <span class="money" style="font-size:14px;font-weight:600;color:var(--blue)">${eur0(Number(e.revenue_eur || 0))}</span>
    </div>`).join('');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INSTELLINGEN-PANE (v1-parity — tandwiel-rechtsboven Overzicht)
  // 5 sub-tabs: Automations / Signup-deadline / Niveau-foto's / Simone / Vragenlijst
  // ═══════════════════════════════════════════════════════════════════════
  window.__evGoSettings = () => { _ui.mode = 'settings'; if (window.DFO?.render) window.DFO.render(); };
  window.__evSettingsTab = (t) => { _ui.settingsTab = t; if (window.DFO?.render) window.DFO.render(); };

  function _settingsView() {
    const tab = _ui.settingsTab || 'automations';
    const tabs = [
      { v: 'automations', l: 'Automations' },
      { v: 'deadline',    l: 'Signup-deadline' },
      { v: 'niveaus',     l: "Niveau-foto's" },
      { v: 'simone',      l: 'Simone (AI)' },
      { v: 'vragenlijst', l: 'Vragenlijst' },
    ];
    return `<div style="padding:12px 20px;background:var(--surface-2);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
      <button class="btn btn-ghost btn-sm" onclick="window.__evBackToList()">${svg(I.arrDown || I.x, 'width:13px;height:13px;transform:rotate(90deg)')}Terug naar overzicht</button>
      <span style="font-size:14px;font-weight:600;margin-left:6px">Events-instellingen</span>
    </div>
    <div class="toolbar" style="padding:10px 20px 0;border-bottom:none;gap:6px;flex-wrap:wrap">
      ${tabs.map((t) => `<button class="chip ${tab === t.v ? 'on' : ''}" onclick="window.__evSettingsTab('${t.v}')">${esc(t.l)}</button>`).join('')}
    </div>
    ${tab === 'automations' ? _settingsAutomations()
     : tab === 'deadline'    ? _settingsDeadline()
     : tab === 'niveaus'     ? _settingsNiveaus()
     : tab === 'simone'      ? _settingsSimone()
     : _settingsVragenlijst()}`;
  }

  function _settingsAutomations() {
    // Punt 2 — Automations worden centraal beheerd in de Automatiseringen-module.
    // Deze sub-tab is bewust read-only een verwijzing; de echte editor (create /
    // edit / toggle / test) bouwen we later in modules/klanten-v2/views/automatiseringen-v2.js.
    return `<div class="pad" style="padding-top:20px"><div style="max-width:640px">
      <div class="card">
        <div class="card-head">
          <span class="tile-ico" style="background:var(--violet-soft);color:var(--violet)">${svg(I.robot || I.settings)}</span>
          <div class="card-title">Automatiseringen</div>
        </div>
        <div class="card-body" style="padding:20px;display:flex;flex-direction:column;gap:14px">
          <div style="font-size:13.5px;color:var(--text-2);line-height:1.6">
            <b>Beheer automatiseringen centraal in Automatiseringen.</b> Alle triggers, condities en stappen (WhatsApp / e-mail / taken) voor events wonen in de <a href="/modules/klanten-v2/?v2preview=automatiseringen" style="color:var(--violet);text-decoration:underline">Automatiseringen-module</a>. Zo blijft de editor consistent voor alle modules (events, finance, onboarding, …).
          </div>
          <div style="padding:10px 14px;background:var(--surface-2);border-radius:8px;font-size:12px;color:var(--text-3);line-height:1.5">
            Deze sub-tab is bewust een read-only verwijzing. Volledige in-shell editor bouwen we later in de Automatiseringen-module.
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <a href="/modules/klanten-v2/?v2preview=automatiseringen" class="btn btn-primary btn-sm" style="text-decoration:none">${svg(I.arrRight || I.tick)}Open Automatiseringen (v2)</a>
            <a href="/modules/events-automations.html" target="_blank" class="btn btn-ghost btn-sm" style="text-decoration:none">v1-editor openen ↗</a>
          </div>
        </div>
      </div>
    </div></div>`;
  }

  function _settingsDeadline() {
    if (!_live.autoClose.data && !_live.autoClose.loading && !_live.autoClose.error) queueMicrotask(fetchAutoClose);
    if (_live.autoClose.error && !_live.autoClose.data) return errBlk('autoClose', _live.autoClose.error);
    if (_live.autoClose.loading && !_live.autoClose.data) return skel();
    const cur = _live.autoClose.data || { hours: 24 };
    const draft = _ui.autoCloseDraft;
    const val = draft != null ? draft : cur.hours;
    const dirty = draft != null && Number(draft) !== Number(cur.hours);
    return `<div class="pad" style="padding-top:14px"><div style="max-width:640px">
      <div class="card">
        <div class="card-head"><span class="tile-ico" style="background:var(--amber-soft);color:var(--amber)">${svg(I.clock)}</span><div class="card-title">Signup automatisch sluiten</div></div>
        <div class="card-body" style="padding:18px">
          <div style="font-size:12.5px;color:var(--text-2);line-height:1.6;margin-bottom:14px">
            Hoeveel uur vóór de start van een event moet de aanmelding automatisch dichtgaan? Een cron controleert elke 5 min en sluit events waarvan de start minder dan X uur weg is.
          </div>
          <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px">
            <label for="ev_ac_h" style="font-size:12.5px;color:var(--text-2);min-width:130px">Uren vooraf sluiten</label>
            <input id="ev_ac_h" type="number" min="0" max="720" value="${esc(String(val))}" oninput="window.__evAutoCloseDraft(this.value)" style="width:100px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);font-size:13px" />
            <span style="font-size:12px;color:var(--text-3)">uur (0 = alleen op start-moment sluiten; 24 = één dag vooraf)</span>
          </div>
          <div style="font-size:11.5px;color:var(--text-3)">Laatst gewijzigd: ${cur.updated_at ? _fmtDateTime(cur.updated_at) : '—'}</div>
        </div>
        <div style="padding:11px 17px;background:var(--surface-2);border-top:1px solid var(--border);display:flex;gap:8px">
          <button class="btn btn-primary btn-sm" ${(!dirty || _ui.autoCloseBusy) ? 'disabled style="opacity:.55"' : ''} onclick="window.__evAutoCloseSave()">${svg(I.tick)}${_ui.autoCloseBusy ? 'Opslaan…' : 'Opslaan'}</button>
          <button class="btn btn-ghost btn-sm" ${!dirty ? 'disabled style="opacity:.55"' : ''} onclick="window.__evAutoCloseReset()">Annuleren</button>
        </div>
      </div>
    </div></div>`;
  }
  window.__evAutoCloseDraft = (v) => { _ui.autoCloseDraft = v; if (window.DFO?.render) window.DFO.render(); };
  window.__evAutoCloseReset = () => { _ui.autoCloseDraft = null; if (window.DFO?.render) window.DFO.render(); };
  window.__evAutoCloseSave = async () => {
    const hours = Number(_ui.autoCloseDraft);
    if (!Number.isInteger(hours) || hours < 0 || hours > 720) { alert('Uren moet 0-720 zijn.'); return; }
    _ui.autoCloseBusy = true; if (window.DFO?.render) window.DFO.render();
    try {
      const j = await window.KV.authedJson('/api/events-settings-auto-close-update', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ hours }) });
      if (j?.error) throw new Error(j.error);
      _showToast('Signup-deadline opgeslagen');
      _live.autoClose.data = null; _ui.autoCloseDraft = null;
      queueMicrotask(fetchAutoClose);
    } catch (e) { alert('Opslaan mislukt: ' + (e?.message || 'onbekende fout')); }
    finally { _ui.autoCloseBusy = false; if (window.DFO?.render) window.DFO.render(); }
  };

  function _settingsNiveaus() {
    if (!_live.niveaus.data && !_live.niveaus.loading && !_live.niveaus.error) queueMicrotask(fetchNiveaus);
    if (_live.niveaus.error && !_live.niveaus.data) return errBlk('events', _live.niveaus.error);
    if (_live.niveaus.loading && !_live.niveaus.data) return skel();
    const niveaus = asArr(_live.niveaus.data);
    return `<div class="pad" style="padding-top:14px"><div style="max-width:760px">
      <div style="font-size:12.5px;color:var(--text-3);margin-bottom:14px">
        Per niveau kun je een default-foto instellen. Die wordt gebruikt als een event geen eigen foto heeft (bv. bij dupliceren of API-import).
      </div>
      ${niveaus.length === 0
        ? emptyBlk('Geen niveau-opties', 'Er zijn geen niveau-opties gedefinieerd in de DB.')
        : `<div class="grid g2" style="gap:12px">
          ${niveaus.map((n) => {
            const slug = n.slug || n.id || n.value || n;
            const label = n.label || n.name || slug;
            const img = n.default_image_url;
            return `<div class="card">
              <div class="card-head"><div class="card-title">${esc(label)}</div><span style="margin-left:auto;font-size:11px;color:var(--text-3)" class="mono">${esc(slug)}</span></div>
              <div class="card-body" style="padding:14px">
                ${img ? `<img src="${esc(img)}" style="width:100%;max-height:140px;object-fit:cover;border-radius:6px;border:1px solid var(--border)" />` : `<div style="width:100%;height:100px;background:var(--surface-2);border-radius:6px;display:flex;align-items:center;justify-content:center;color:var(--text-3);font-size:12px">Geen foto</div>`}
                <div style="margin-top:10px;font-size:11.5px;color:var(--text-3);word-break:break-all">${img ? esc(img) : ''}</div>
              </div>
              <div style="padding:10px 14px;background:var(--surface-2);border-top:1px solid var(--border);display:flex;gap:6px">
                <input type="file" accept="image/*" id="niv_file_${esc(slug)}" style="font-size:11.5px;flex:1" />
                <button class="btn btn-ghost btn-sm" onclick="window.__evNiveauUpload('${esc(slug)}')">${svg(I.plus)}Uploaden</button>
              </div>
            </div>`;
          }).join('')}
        </div>`}
    </div></div>`;
  }
  window.__evNiveauUpload = async (slug) => {
    const inp = document.getElementById('niv_file_' + slug);
    const file = inp?.files?.[0];
    if (!file) { alert('Kies eerst een afbeelding.'); return; }
    try {
      // Stap 1: event-image-upload verwacht event_id. Voor niveau-default hebben
      // we geen event_id. events-niveau-default-image-save accepteert een URL
      // (bestaande bestanden) OF neemt de upload zelf mee — we uploaden via
      // een tijdelijke event-image-upload en zetten dan de URL.
      // Simpelste route: multipart POST direct naar niveau-save.
      const fd = new FormData();
      fd.append('file', file);
      fd.append('niveau_slug', slug);
      const resp = await fetch('/api/events-niveau-default-image-save', {
        method: 'POST',
        headers: window.KV.getAuthHeaders ? window.KV.getAuthHeaders() : {},
        body: fd,
      });
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok || j?.error) throw new Error(j?.error || ('HTTP ' + resp.status));
      _showToast('Niveau-foto opgeslagen');
      _live.niveaus.data = null;
      queueMicrotask(fetchNiveaus);
    } catch (e) { alert('Upload mislukt: ' + (e?.message || 'onbekende fout')); }
  };

  function _settingsSimone() {
    return `<div class="pad" style="padding-top:14px"><div style="max-width:640px">
      <div class="card">
        <div class="card-head"><span class="tile-ico" style="background:var(--pink-soft);color:var(--pink)">${svg(I.bot)}</span><div class="card-title">Simone (AI voor events)</div></div>
        <div class="card-body" style="padding:18px;font-size:13px;line-height:1.6">
          Simone's persona, kennisbank, autonomie en oefengesprek beheer je centraal in de <b>AI Agents</b>-module.
          Ze gebruikt de <span class="mono">joost_config</span>-rij met module='events' — dezelfde plek waar Joost/Mila zitten.
          <div style="margin-top:14px">
            <a href="/modules/klanten-v2/#agents" class="btn btn-primary btn-sm" style="text-decoration:none">${svg(I.bot)}Open Simone in AI Agents</a>
          </div>
        </div>
      </div>
    </div></div>`;
  }

  function _settingsVragenlijst() {
    return `<div class="pad" style="padding-top:14px"><div style="max-width:640px">
      <div class="card">
        <div class="card-head"><span class="tile-ico" style="background:var(--emerald-soft);color:var(--emerald)">${svg(I.list || I.doc)}</span><div class="card-title">Vragenlijst (assessment)</div></div>
        <div class="card-body" style="padding:18px;font-size:13px;line-height:1.6">
          De vragenlijst-tabellen (<span class="mono">assessment_questionnaires</span> + questions + responses) zijn <b>globaal</b> — er is één actieve versie die zowel Events als Follow-up gebruiken.
          <div style="margin-top:10px;padding:10px 14px;background:var(--amber-soft);border:1px solid var(--amber-line);border-radius:8px;font-size:12.5px;color:var(--amber)">
            <b>Verhuist naar de Instellingen-module.</b> De editor zelf wordt centraal beheerd zodat andere modules dezelfde bron gebruiken; hier tonen we alleen de verwijzing.
          </div>
          <div style="margin-top:14px;display:flex;gap:8px">
            <a href="/modules/events.html#settings-vragenlijst" target="_blank" class="btn btn-ghost btn-sm" style="text-decoration:none">Bewerken in v1 (tijdelijk)</a>
          </div>
        </div>
      </div>
    </div></div>`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // REGISTREREN
  // ═══════════════════════════════════════════════════════════════════════
  window.DFO.VIEWS['events/Overzicht']      = overzichtView;
  window.DFO.VIEWS['events/Inbox']          = inboxView;
  window.DFO.VIEWS['events/Inschrijvingen'] = inschrijvingenView;
  window.DFO.VIEWS['events/Statistieken']   = statistiekenView;
  // Backward-compat alias voor als de shell nog de oude tab-naam heeft
  window.DFO.VIEWS['events/Mentor-grootboek'] = statistiekenView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('events');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('events');

  console.debug('[events-v2] v1-parity Fase 1 — Overzicht/Detail/Wizard/Statistieken');
})();
