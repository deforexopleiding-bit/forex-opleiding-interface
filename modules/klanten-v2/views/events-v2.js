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
    const url = '/api/events-signup-inbox-list' + (status ? '?status=' + encodeURIComponent(status) : '');
    const j = await tryFetch('signups:' + status, url);
    st.loading = false;
    if (j && j.__error) st.error = j.__error; else st.data = { rows: asArr(j?.rows), counts: j?.counts || {} };
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
  async function fetchAudit(id) {
    const st = _live.audit; if (st.loading[id] || st.data[id]) return;
    st.loading[id] = true; st.error[id] = null;
    const j = await tryFetch('audit:' + id, '/api/events-attendee-audit-log?event_id=' + encodeURIComponent(id));
    st.loading[id] = false;
    if (j && j.__error) st.error[id] = j.__error; else st.data[id] = asArr(j?.entries || j?.rows || j);
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
    if (_ui.mode === 'wizard') return _wizardView();
    if (_ui.mode === 'detail' && _ui.detailId) return _detailView(_ui.detailId);
    return _lijstView();
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

    const items = asArr(_live.events.data?.items);
    const total = Number(_live.events.data?.total || items.length);
    // Client-side extra zoek (server-side q ondersteunt ook, dus overlap ok)
    const rows = q ? items.filter((e) => String(e.title || '').toLowerCase().includes(q.toLowerCase()) || String(e.location || '').toLowerCase().includes(q.toLowerCase())) : items;

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
      <div class="tb-search" style="flex:1;max-width:300px"><input type="search" placeholder="Zoek titel of locatie…" value="${esc(_ui.searchQ)}" oninput="window.__evSearch(this.value)" style="width:100%;padding:6px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);font-size:12.5px" /></div>
      <div class="tb-right" style="display:flex;gap:6px">
        <button class="btn btn-ghost btn-sm" onclick="__evRetry('events')" title="Vernieuwen">${svg(I.refresh || I.tick, 'width:14px;height:14px')}</button>
        <button class="btn btn-primary btn-sm" onclick="window.__evWizardOpen('create')">${svg(I.plus)}Nieuw event</button>
      </div>
    </div>
    ${rows.length === 0
      ? emptyBlk('Geen events', 'Er zijn geen events die aan de filter voldoen.')
      : H.table(
          [{l:'Event'},{l:'Datum',cls:'optional'},{l:'Locatie',cls:'optional'},{l:'Niveau',cls:'optional'},{l:'Aanm/Cap',cls:'r'},{l:'Sync',cls:'r optional'},{l:'Status'},{l:'',cls:'r'}],
          rows.map((e) => {
            const aanm = Number(e.attendee_count_active || 0);
            const cap = Number(e.capacity || 0);
            const ratio = cap > 0 ? aanm / cap : 0;
            const barCol = ratio >= 0.8 ? 'danger' : ratio >= 0.5 ? 'warn' : 'ok';
            const [sc, sl] = STATUS_META[e.status] || ['neutral', e.status || '—'];
            const busy = _ui.busy[e.id];
            return [
              `<a href="#" onclick="event.preventDefault();window.__evGoDetail('${esc(e.id)}')" style="color:inherit;text-decoration:none"><span class="cell-main">${esc(e.title || '—')}</span></a>`,
              `<span class="mono" style="color:var(--text-3);font-size:12.5px">${esc(_fmtDate(e.starts_at))} ${esc(_fmtTime(e.starts_at))}</span>`,
              `<span style="color:var(--text-2);font-size:12.5px">${esc(e.location || '—')}</span>`,
              `<span style="font-size:11.5px;color:var(--text-3)">${esc(e.niveau || '')}</span>`,
              cap > 0
                ? `<div style="min-width:100px"><div style="display:flex;justify-content:space-between;font-size:11.5px"><span class="mono">${aanm}/${cap}</span></div><div class="progress" style="max-width:100px"><i style="width:${Math.min(100, ratio * 100)}%;background:var(--${barCol})"></i></div></div>`
                : `<span class="mono">${aanm}${e.status === 'afgerond' ? ' (afg)' : ''}</span>`,
              _syncCell(e),
              H.pill(sc, sl),
              `<div style="display:flex;gap:3px;justify-content:flex-end">
                <button class="icon-btn" title="Dupliceren" ${busy ? 'disabled' : ''} onclick="event.stopPropagation();window.__evDuplicate('${esc(e.id)}')" style="width:26px;height:26px;${busy === 'duplicate' ? 'opacity:.5' : ''}">${svg(I.copy || I.plus, 'width:13px;height:13px')}</button>
                <button class="icon-btn" title="Meer acties" onclick="event.stopPropagation();window.__evRowMenu('${esc(e.id)}','${esc(e.status)}')" style="width:26px;height:26px">${svg(I.dots || I.settings, 'width:13px;height:13px')}</button>
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
    const badge = (s, label) => {
      if (!s) return '';
      // BUG 2 FIX — 'success' is de canonieke waarde in webflow/ghl-sync-kolommen;
      // 'synced'/'ok' als alias behouden. Alleen 'pending'/'queued' warn; 'error'
      // en de rest danger.
      const cls = ['success','synced','ok'].includes(s) ? 'ok'
                : ['pending','queued','in_progress'].includes(s) ? 'warn'
                : 'danger';
      return `<span class="pill pill-${cls} nodot" style="font-size:10px;padding:1px 5px" title="${esc(label + ': ' + s)}">${label}</span>`;
    };
    return `<div style="display:flex;gap:3px;justify-content:flex-end">${badge(wf, 'WF')}${badge(gh, 'GHL')}</div>`;
  }

  window.__evSetStatus = (s) => { _live.events.data = null; _live.events.error = null; _live.events.filter = s; if (window.DFO?.render) window.DFO.render(); };
  window.__evSetNiveau = (v) => { _ui.niveauFilter = v; _live.events.data = null; _live.events.error = null; if (window.DFO?.render) window.DFO.render(); };
  window.__evSearch = (v) => {
    _ui.searchQ = v;
    // Debounce refetch alleen als server-side filter zinvol; voor nu client-only + trigger render
    if (window.DFO?.render) window.DFO.render();
  };
  window.__evGoDetail = (id) => { _ui.mode = 'detail'; _ui.detailId = id; _ui.detailTab = 'Info'; if (window.DFO?.render) window.DFO.render(); };
  window.__evBackToList = () => { _ui.mode = 'list'; _ui.detailId = null; _ui.wizard = null; if (window.DFO?.render) window.DFO.render(); };

  window.__evDuplicate = async (id) => {
    if (!window.confirm('Dit event dupliceren? Er wordt een nieuw concept aangemaakt met dezelfde inhoud.')) return;
    _ui.busy[id] = 'duplicate'; if (window.DFO?.render) window.DFO.render();
    try {
      // BUG 1 FIX — endpoint verwacht 'source_event_id', niet 'id'.
      const j = await window.KV.authedJson('/api/events-duplicate', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ source_event_id: id }) });
      if (j?.error) throw new Error(j.error);
      _showToast('Event gedupliceerd');
      _live.events.data = null; queueMicrotask(() => fetchEvents());
    } catch (e) { alert('Dupliceren mislukt: ' + (e?.message || 'onbekende fout')); }
    finally { _ui.busy[id] = null; if (window.DFO?.render) window.DFO.render(); }
  };
  window.__evRowMenu = async (id, status) => {
    const opts = ['Archiveren', 'Annuleren'];
    const choice = window.prompt('Actie voor dit event?\n\n1. Archiveren\n2. Annuleren\n\nTyp 1 of 2 (of cancel):');
    if (!choice) return;
    if (choice === '1') return window.__evArchive(id);
    if (choice === '2') return window.__evCancel(id);
  };
  window.__evArchive = async (id) => {
    if (!window.confirm('Event archiveren? Het verdwijnt uit de actieve lijst maar blijft bewaard.')) return;
    _ui.busy[id] = 'archive'; if (window.DFO?.render) window.DFO.render();
    try {
      const j = await window.KV.authedJson('/api/events-update', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ id, status:'archived' }) });
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
      const j = await window.KV.authedJson('/api/events-update', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ id, status:'cancelled' }) });
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
    if (_live.detail.error[id] && !_live.detail.data[id]) return _backBar(id) + errBlk('detail', _live.detail.error[id], id);
    if (_live.detail.loading[id] && !_live.detail.data[id]) return _backBar(id) + skel();
    const ev = _live.detail.data[id] || {};

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
    if (ev.status === 'draft') btns.push(`<button class="btn btn-primary btn-sm" ${busy ? 'disabled' : ''} onclick="window.__evPublish('${esc(ev.id)}')">${svg(I.rocket || I.tick)}${busy === 'publish' ? '…' : 'Publiceren'}</button>`);
    if (ev.status === 'published' && ev.signups_closed) btns.push(`<button class="btn btn-ghost btn-sm" ${busy ? 'disabled' : ''} onclick="window.__evReopen('${esc(ev.id)}')">Heropenen</button>`);
    else if (ev.status === 'published') btns.push(`<button class="btn btn-ghost btn-sm" ${busy ? 'disabled' : ''} onclick="window.__evCloseSignups('${esc(ev.id)}')">Sluiten voor aanmelding</button>`);
    if (ev.status === 'published' || ev.status === 'completed') btns.push(`<button class="btn btn-ghost btn-sm" ${busy ? 'disabled' : ''} onclick="window.__evComplete('${esc(ev.id)}')">${busy === 'complete' ? '…' : (ev.status === 'completed' ? 'Her-afronden' : 'Event afronden')}</button>`);
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
    // BUG 3 FIX — events-detail retourneert `byStatus:{aangemeld,aanwezig,...}`
    // + `attendee_count_active` (confirmed = aangemeld+aanwezig met assessment).
    // Voor "Aangemeld" tellen we aangemeld+aanwezig (breder dan alleen assessment-
    // gecompleteerd), zodat de teller overeenkomt met wat je ziet in Aanwezigen-tab.
    const bs = ev.byStatus || {};
    const aangemeldTotaal = (Number(bs.aangemeld || 0) + Number(bs.aanwezig || 0));
    const confirmedTotaal = Number(ev.attendee_count_active ?? ev.attendee_count ?? 0);
    const showTot = aangemeldTotaal > 0 ? aangemeldTotaal : confirmedTotaal;
    const showSub = (aangemeldTotaal > confirmedTotaal && confirmedTotaal > 0)
      ? ` <span style="font-size:11px;color:var(--text-3)">(${confirmedTotaal} met vragenlijst)</span>`
      : '';
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
          <div class="kv"><dt>Webflow</dt><dd>${_syncBadge(ev.webflow_sync_status, ev.webflow_last_synced_at)}</dd></div>
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
  window.__evPublish = async (id) => {
    if (!window.confirm('Event publiceren? Zichtbaar voor alle klanten die het kanaal volgen.')) return;
    _ui.busy[id] = 'publish'; if (window.DFO?.render) window.DFO.render();
    try {
      const j = await window.KV.authedJson('/api/events-publish', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ id }) });
      if (j?.error) throw new Error(j.error);
      _showToast('Event gepubliceerd');
      _live.detail.data[id] = null; queueMicrotask(() => fetchDetail(id));
    } catch (e) { alert('Publiceren mislukt: ' + (e?.message || 'onbekende fout')); }
    finally { _ui.busy[id] = null; if (window.DFO?.render) window.DFO.render(); }
  };
  window.__evComplete = async (id) => {
    if (!window.confirm('Event afronden? Aanwezigheid en bonussen worden vastgesteld.')) return;
    _ui.busy[id] = 'complete'; if (window.DFO?.render) window.DFO.render();
    try {
      const j = await window.KV.authedJson('/api/events-complete', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ id }) });
      if (j?.error) throw new Error(j.error);
      _showToast('Event afgerond');
      _live.detail.data[id] = null; _live.completedOne.data[id] = null; queueMicrotask(() => fetchDetail(id));
    } catch (e) { alert('Afronden mislukt: ' + (e?.message || 'onbekende fout')); }
    finally { _ui.busy[id] = null; if (window.DFO?.render) window.DFO.render(); }
  };
  window.__evCloseSignups = async (id) => {
    try {
      const j = await window.KV.authedJson('/api/events-close-signups', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ id }) });
      if (j?.error) throw new Error(j.error);
      _showToast('Aanmelding gesloten');
      _live.detail.data[id] = null; queueMicrotask(() => fetchDetail(id));
    } catch (e) { alert('Sluiten mislukt: ' + (e?.message || 'onbekende fout')); }
  };
  window.__evReopen = async (id) => {
    try {
      const j = await window.KV.authedJson('/api/events-reopen-signups', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ id }) });
      if (j?.error) throw new Error(j.error);
      _showToast('Aanmelding heropend');
      _live.detail.data[id] = null; queueMicrotask(() => fetchDetail(id));
    } catch (e) { alert('Heropenen mislukt: ' + (e?.message || 'onbekende fout')); }
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
          [{l:'Naam'},{l:'E-mail',cls:'optional'},{l:'Telefoon',cls:'optional'},{l:'Status'},{l:'Aanmelddatum',cls:'optional'},{l:'Vragenlijst',cls:'optional'},{l:'Tags',cls:'optional'},{l:'',cls:'r'}],
          rows.map((a) => {
            const naam = [a.first_name || a.voornaam, a.last_name || a.achternaam].filter(Boolean).join(' ') || a.name || a.email || '—';
            const [sc, sl] = ATT_STATUS_META[a.status] || ['neutral', a.status || '—'];
            const hasQuest = !!(a.assessment_response_id || a.questionnaire_completed_at);
            return [
              `<div class="row-avatar">${H.av(naam, 26)}<span class="cell-main">${esc(naam)}</span></div>`,
              `<span style="color:var(--text-3);font-size:12.5px">${esc(a.email || '—')}</span>`,
              `<span class="mono" style="color:var(--text-3);font-size:12px">${esc(a.phone || a.telefoon || '—')}</span>`,
              H.pill(sc, sl),
              `<span class="mono" style="color:var(--text-3);font-size:12px">${esc(_fmtDate(a.registered_at || a.created_at))}</span>`,
              hasQuest ? H.pill('ok','Ingevuld') : H.pill('neutral','Nog niet'),
              _tagChips(a.tags),
              `<button class="icon-btn" title="Meer" onclick="window.__evAttKebab('${esc(a.id)}','${esc(id)}')" style="width:26px;height:26px">${svg(I.dots || I.settings,'width:13px;height:13px')}</button>`,
            ];
          })
        )}</div>`}`;
  }
  function _tagChips(tags) {
    if (!Array.isArray(tags) || tags.length === 0) return '<span style="color:var(--text-3);font-size:11px">—</span>';
    return tags.slice(0, 3).map((t) => `<span class="pill pill-neutral nodot" style="font-size:10px;padding:1px 6px;margin-right:3px">${esc(t.label || t.name || t)}</span>`).join('')
      + (tags.length > 3 ? `<span style="font-size:10px;color:var(--text-3)">+${tags.length - 3}</span>` : '');
  }
  window.__evAttFilter = (v) => { _ui.attStatusFilter = v; if (window.DFO?.render) window.DFO.render(); };
  window.__evAttKebab = (attId, eventId) => {
    const choice = window.prompt(
      'Actie voor deelnemer?\n\n' +
      '1. Bewerken\n' +
      '2. Stuur keuze-link\n' +
      '3. Stuur vragenlijst\n' +
      '4. Verplaatsen naar ander event\n' +
      '5. Offerte aanmaken\n' +
      '6. Tag toevoegen\n' +
      '7. Tag verwijderen\n' +
      '8. Verwijderen\n\n' +
      'Typ 1-8 (of cancel):'
    );
    if (!choice) return;
    const actions = {
      '1': () => window.__evAttEdit(attId, eventId),
      '2': () => window.__evAttSendInvite(attId, eventId),
      '3': () => window.__evAttSendQuest(attId, eventId),
      '4': () => window.__evAttMove(attId, eventId),
      '5': () => window.__evAttToOfferte(attId, eventId),
      '6': () => window.__evAttTagAdd(attId, eventId),
      '7': () => window.__evAttTagRemove(attId, eventId),
      '8': () => window.__evAttDelete(attId, eventId),
    };
    const fn = actions[choice.trim()]; if (fn) fn();
  };

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
    if (!_live.audit.data[id] && !_live.audit.loading[id] && !_live.audit.error[id]) queueMicrotask(() => fetchAudit(id));
    if (_live.audit.error[id] && !_live.audit.data[id]) return errBlk('audit', _live.audit.error[id], id);
    if (_live.audit.loading[id] && !_live.audit.data[id]) return skel();
    const rows = asArr(_live.audit.data[id]);
    if (rows.length === 0) return emptyBlk('Geen audit-entries', 'Er is nog niets gelogd voor dit event.');
    return `<div style="padding:0 20px 20px">${H.table(
      [{l:'Wanneer'},{l:'Wie',cls:'optional'},{l:'Actie'},{l:'Details',cls:'optional'}],
      rows.map((r) => [
        `<span class="mono" style="font-size:12px;color:var(--text-3)">${esc(_fmtDateTime(r.created_at || r.timestamp))}</span>`,
        `<span style="font-size:12.5px">${esc(r.actor || r.user_name || r.user_email || '—')}</span>`,
        `<span class="mono" style="font-size:12px">${esc(r.action || r.event_type || '—')}</span>`,
        `<span style="font-size:12px;color:var(--text-3)">${esc(r.details || r.description || (r.payload ? JSON.stringify(r.payload).slice(0, 80) : '—'))}</span>`,
      ])
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
      // Laad huidige data
      if (!_live.detail.data[id]) queueMicrotask(() => fetchDetail(id));
      const cur = _live.detail.data[id];
      if (cur) _ui.wizard.form = { title: cur.title, starts_at: cur.starts_at, ends_at: cur.ends_at, location: cur.location, capacity: cur.capacity, description_md: cur.description_md || cur.description, niveau: cur.niveau };
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
    // Bij edit-flow: haal detail op zodra beschikbaar → prefill
    if (w.mode === 'edit' && w.id && !form.title) {
      const cur = _live.detail.data[w.id];
      if (cur) w.form = { title: cur.title, starts_at: cur.starts_at, ends_at: cur.ends_at, location: cur.location, capacity: cur.capacity, description_md: cur.description_md || cur.description, niveau: cur.niveau };
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
      const url = isEdit ? '/api/events-update' : '/api/events-create';
      const body = { ...form };
      if (isEdit) body.id = w.id;
      if (form.capacity != null && form.capacity !== '') body.capacity = Number(form.capacity);
      const j = await window.KV.authedJson(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
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
  function inboxView() {
    return `<div style="margin:20px;padding:14px 18px;border:1px solid var(--amber-line);background:var(--amber-soft);border-radius:var(--r);color:var(--amber);font-size:12.5px;display:flex;align-items:center;gap:12px">
      <span>${svg(I.alert, 'width:16px;height:16px;flex-shrink:0')}</span>
      <span><b>Binnenkort</b> — de per-event Inbox komt in een volgende ronde. Gebruik zolang de v1-events-inbox.</span>
    </div>
    <div class="pad"><div class="empty" style="padding:44px 20px"><div class="empty-t">Inbox — binnenkort</div><a class="btn btn-ghost btn-sm" style="margin-top:10px" href="/modules/events.html#inbox" target="_blank">Openen in v1</a></div></div>`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INSCHRIJVINGEN-tab (behouden)
  // ═══════════════════════════════════════════════════════════════════════
  function inschrijvingenView() {
    const status = _live.signups.filter;
    if (!_live.signups.data && !_live.signups.loading && !_live.signups.error) queueMicrotask(() => fetchSignups(status));
    if (_live.signups.error && !_live.signups.data) return errBlk('signups', _live.signups.error);
    if (_live.signups.loading && !_live.signups.data) return skel();
    const rows = asArr(_live.signups.data?.rows);
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
          [{l:'Deelnemer'},{l:'E-mail',cls:'optional'},{l:'Opgegeven event',cls:'optional'},{l:'Match'},{l:'Ontvangen',cls:'r optional'},{l:'',cls:'r'}],
          rows.map((r) => {
            const naam = [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || '—';
            const ev = r.matched_event?.title || r.event_date_label || r.opgegeven_event || '—';
            const ms = r.match_status || 'onbekend';
            const [mc, ml] = ms === 'matched' ? ['ok','Matched'] : ms === 'ambiguous' ? ['warn','Ambigu'] : ms === 'no_match' ? ['danger','Geen match'] : ['neutral','Ongeldig'];
            return [
              `<div class="row-avatar">${H.av(naam, 28)}<span class="cell-main">${esc(naam)}</span></div>`,
              `<span style="color:var(--text-3);font-size:12.5px">${esc(r.email || '—')}</span>`,
              `<span style="color:var(--text-2);font-size:12.5px">${esc(ev)}</span>`,
              H.pill(mc, ml),
              `<span class="mono" style="color:var(--text-3);font-size:12px">${esc(_fmtDate(r.received_at))}</span>`,
              `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();window.open('/modules/events.html#signup-inbox', '_blank')">v1</button>`,
            ];
          })
        )}`;
  }
  window.__evSetSignupStatus = (v) => { _live.signups.data = null; _live.signups.error = null; fetchSignups(v); };

  // ═══════════════════════════════════════════════════════════════════════
  // STATISTIEKEN-tab (vervangt Mentor-grootboek)
  // ═══════════════════════════════════════════════════════════════════════
  function statistiekenView() {
    if (!_live.completed.data && !_live.completed.loading && !_live.completed.error) queueMicrotask(fetchCompleted);
    if (_live.completed.error && !_live.completed.data) return errBlk('completed', _live.completed.error);
    if (_live.completed.loading && !_live.completed.data) return skel();
    const events = asArr(_live.completed.data);
    const now = new Date();
    const startYear = new Date(now.getFullYear(), 0, 1);
    const startQuarter = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    const eventsYTD = events.filter((e) => {
      const d = new Date(e.completed_at || e.starts_at);
      return Number.isFinite(d.getTime()) && d >= startYear;
    });
    const eventsQTD = events.filter((e) => {
      const d = new Date(e.completed_at || e.starts_at);
      return Number.isFinite(d.getTime()) && d >= startQuarter;
    });
    // BUG 4 — 'sales' in events-completed-list is COUNT (aantal deals met
    // sale-status via event_attendees.deal_id), GEEN €-bedrag. We tonen dus
    // "Aantal verkopen" i.p.v. "Omzet". De echte €-omzet vergt een aparte
    // aggregate over deals.amount JOIN event_attendees → needs Jeffrey.
    const salesYTD = eventsYTD.reduce((a, e) => a + Number(e.sales || 0), 0);
    const salesQTD = eventsQTD.reduce((a, e) => a + Number(e.sales || 0), 0);
    const gemSales = eventsYTD.length > 0 ? salesYTD / eventsYTD.length : 0;
    const totAanwezig = eventsYTD.reduce((a, e) => a + Number(e.aanwezig || 0), 0);

    return `<div style="margin:14px 20px;padding:12px 16px;border:1px solid var(--amber-line);background:var(--amber-soft);border-radius:var(--r);color:var(--amber);font-size:12.5px;display:flex;gap:11px;align-items:flex-start">
      ${svg(I.alert, 'width:15px;height:15px;flex-shrink:0;margin-top:1px')}
      <div style="flex:1"><b>Needs Jeffrey — €-omzet ontbreekt</b><br>
      De <span class="mono">sales</span>-kolom uit <span class="mono">events-completed-list</span> is een <b>teller van verkoop-deals</b> per event
      (aantal <span class="mono">event_attendees</span> met een <span class="mono">deal_id</span> waar de deal <span class="mono">accepted/signed</span> is) — géén €-bedrag.
      Voor "hoeveel omzet uit dit event" is een nieuwe aggregate nodig over <span class="mono">deals.amount</span> (of <span class="mono">invoices.total</span>) gejoind op <span class="mono">event_attendees.deal_id</span>.
      Hieronder tonen we daarom <b>aantal verkopen</b> (echte data) i.p.v. €.</div>
    </div>

    ${H.kpis([
      { c:'blue',    icon:I.grad,  label:'Verkopen YTD',            val:fmtNum(salesYTD),  hi:1, sub:eventsYTD.length + ' afgeronde events' },
      { c:'violet',  icon:I.chart, label:'Verkopen dit kwartaal',   val:fmtNum(salesQTD),  hi:1, sub:eventsQTD.length + ' events' },
      { c:'emerald', icon:I.tick,  label:'Gem. verkopen/event',     val:gemSales > 0 ? gemSales.toFixed(1) : '—', sub:'YTD' },
      { c:'teal',    icon:I.users, label:'Totaal aanwezigen',       val:fmtNum(totAanwezig), sub:'YTD' },
    ])}

    <div class="pad"><div class="grid g2" style="margin-bottom:14px">
      <div class="card">
        <div class="card-head"><span class="tile-ico" style="background:var(--blue-soft);color:var(--blue)">${svg(I.chart)}</span><div class="card-title">Verkopen per maand</div><span style="margin-left:auto;font-size:11px;color:var(--text-3)">laatste 12 mnd · aantal, niet €</span></div>
        ${_salesMaandChart(events)}
      </div>
      <div class="card">
        <div class="card-head"><span class="tile-ico" style="background:var(--emerald-soft);color:var(--emerald)">${svg(I.grad)}</span><div class="card-title">Top-events (aantal verkopen)</div><span style="margin-left:auto;font-size:11px;color:var(--text-3)">YTD</span></div>
        <div class="card-body" style="padding:12px 17px">
          ${_topEvents(eventsYTD)}
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><span class="tile-ico" style="background:var(--pink-soft);color:var(--pink)">${svg(I.cal)}</span><div class="card-title">Per afgerond event (${events.length})</div><span style="margin-left:auto;font-size:11px;color:var(--text-3)">Bonus/uitgaven zijn wél €; verkopen = aantal</span></div>
      ${events.length === 0
        ? emptyBlk('Geen afgeronde events', 'Zodra events worden afgerond verschijnt hier de data.')
        : H.table(
            [{l:'Event'},{l:'Voltooid op',cls:'optional'},{l:'Aanwezig',cls:'r optional'},{l:'Verkopen',cls:'r'},{l:'Bonus mentor',cls:'r'},{l:'Uitgaven',cls:'r'}],
            events.map((e) => [
              `<a href="#" onclick="event.preventDefault();window.__evGoDetail('${esc(e.event_id)}')" style="color:inherit;text-decoration:none"><span class="cell-main">${esc(e.title || '—')}</span></a>`,
              `<span class="mono" style="color:var(--text-3);font-size:12.5px">${esc(_fmtDate(e.completed_at || e.starts_at))}</span>`,
              `<span class="mono">${Number(e.aanwezig || 0)}</span>`,
              `<span class="mono" style="color:var(--emerald);font-weight:500">${Number(e.sales || 0)}</span>`,
              `<span class="money">${eur0(Number(e.bonus_total || 0))}</span>`,
              `<span class="money" style="color:var(--amber)">${Number(e.expenses_total || 0) ? '− ' + eur0(Number(e.expenses_total)) : '—'}</span>`,
            ])
          )}
    </div>
    </div>`;
  }

  function _salesMaandChart(events) {
    // Bucket aantal verkopen per maand — 12 maanden terug (BUG 4 fix: count, geen €)
    const now = new Date();
    const buckets = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      buckets.push({ label: d.toLocaleDateString('nl-NL', { month:'short' }), key: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'), sales: 0 });
    }
    const byKey = new Map(buckets.map((b) => [b.key, b]));
    for (const e of events) {
      const d = new Date(e.completed_at || e.starts_at);
      if (!Number.isFinite(d.getTime())) continue;
      const k = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      const b = byKey.get(k); if (b) b.sales += Number(e.sales || 0);
    }
    const maxV = Math.max(1, ...buckets.map((b) => b.sales));
    const W = 480, H_ = 160, pad = { t: 12, r: 12, b: 24, l: 42 };
    const cw = W - pad.l - pad.r, ch = H_ - pad.t - pad.b;
    const bw = cw / buckets.length * 0.68;
    const gap = cw / buckets.length * 0.32;
    return `<div class="card-body" style="padding:14px 12px 8px">
      <svg viewBox="0 0 ${W} ${H_}" style="width:100%;height:auto;display:block" preserveAspectRatio="xMidYMid meet">
        ${[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const y = pad.t + ch - ch * f;
          return `<line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="var(--border)" stroke-width="1" stroke-dasharray="2,3" opacity=".5" />
            <text x="${pad.l - 4}" y="${y + 3}" text-anchor="end" font-size="9" fill="var(--text-3)" font-family="'IBM Plex Mono',monospace">${Math.round(maxV * f)}</text>`;
        }).join('')}
        ${buckets.map((b, i) => {
          const x = pad.l + i * (bw + gap) + gap / 2;
          const h = ch * (b.sales / maxV);
          const y = pad.t + ch - h;
          return `<rect x="${x}" y="${y}" width="${bw}" height="${h}" fill="var(--emerald)" opacity=".8" rx="2"><title>${esc(b.label)}: ${b.sales} verkopen</title></rect>
            <text x="${x + bw / 2}" y="${H_ - 6}" text-anchor="middle" font-size="9" fill="var(--text-3)" font-family="'IBM Plex Mono',monospace">${esc(b.label)}</text>`;
        }).join('')}
      </svg>
    </div>`;
  }
  function _topEvents(events) {
    const sorted = [...events].sort((a, b) => Number(b.sales || 0) - Number(a.sales || 0)).slice(0, 5);
    if (sorted.length === 0) return `<div style="font-size:12.5px;color:var(--text-3);padding:8px 0">Nog geen events dit jaar.</div>`;
    return sorted.map((e, i) => `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:${i < sorted.length - 1 ? '1px solid var(--border)' : 'none'}">
      <span style="width:22px;height:22px;border-radius:50%;background:var(--surface-2);color:var(--text-2);display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:600">${i + 1}</span>
      <div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.title || '—')}</div>
        <div style="font-size:11px;color:var(--text-3)">${esc(_fmtDate(e.completed_at || e.starts_at))} · ${Number(e.aanwezig || 0)} aanwezig</div></div>
      <span class="mono" style="font-size:14px;font-weight:600;color:var(--emerald)">${Number(e.sales || 0)} <span style="font-size:10px;color:var(--text-3);font-weight:400">verkopen</span></span>
    </div>`).join('');
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
