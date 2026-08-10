// modules/klanten-v2/views/tickets-v2.js
//
// Data-ronde — Tickets als live-module.
// Endpoint (bestaand, uit tickets.html): GET /api/tickets?status=<open|
// in_progress|resolved|closed>&type=&module= → { tickets:[], counts:{open,
// in_progress, resolved, closed} }.
//
// Backend-statussen: 4 vaste waardes. GEEN 'waiting_for_customer'. v2-tab-
// mapping:
//   'Open'            → status='open'
//   'Wacht op klant'  → status='in_progress' (semantisch dichtstbijzijnde;
//                       er is geen aparte wacht-op-klant-status)
//   'Afgehandeld'     → status='resolved' + 'closed' (2 requests parallel
//                       en client-side concat — endpoint accepteert alleen
//                       één status per call).
//
// Write: 'Nieuwe ticket' + rij-klik → /modules/tickets-detail.html?id=<id>
// (via query-string, matcht bestaande route). Nieuw ticket wordt daar
// aangemaakt via POST /api/tickets.
//
// Dormant. Preview ?v2preview=tickets (rol super_admin/admin/manager/
// sales/mentor — SAMSM in MODS).

(function () {
  if (!window.DFO) { console.error('[tickets-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[tickets-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, F, setF } = window.DFO;
  const H = window.KV_V2.helpers;

  // ── State per tab ─────────────────────────────────────────────────────
  const _open = { loading: false, error: null, data: null, seq: 0, params: '' };
  const _wait = { loading: false, error: null, data: null, seq: 0, params: '' };
  const _done = { loading: false, error: null, data: null, seq: 0, params: '' };

  async function tryFetch(label, url, timeoutMs = 8000) {
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      return await Promise.race([
        window.KV.authedJson(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
      ]);
    } catch (e) { console.warn('[tickets-v2] fetch fail:', label, '→', e?.message || e); return null; }
  }

  const dstr = (iso) => { if (!iso) return '—'; try { return new Date(iso).toLocaleDateString('nl-NL', { day: '2-digit', month: '2-digit', year: 'numeric' }); } catch { return '—'; } };
  const num = (n) => n == null ? '—' : new Intl.NumberFormat('nl-NL').format(n);

  function previewHeader(label, state) {
    const err = state?.error ? `<span class="prev-badge-err">${state.error}</span>` : '';
    const loading = state?.loading ? `<span class="prev-badge-load">${svg(I.clock || I.settings)} laden…</span>` : '';
    return `<div class="prev-badge">
      <span class="prev-badge-dot"></span>
      <b>PREVIEW · live data</b>
      <span class="prev-badge-lbl">${label}</span>
      ${loading}${err}
    </div>`;
  }

  const PRIO_TO_PILL = {
    low:    ['neutral', 'Laag'],
    medium: ['info',    'Middel'],
    high:   ['warn',    'Hoog'],
    urgent: ['warn',    'Urgent'],
  };
  const TYPE_TO_PILL = {
    bug:      ['warn',    'Bug'],
    feature:  ['info',    'Feature'],
    question: ['neutral', 'Vraag'],
    task:     ['neutral', 'Taak'],
    incident: ['warn',    'Incident'],
  };

  window.__ticketNew  = () => { window.location.href = '/modules/tickets-detail.html?new=1'; };
  window.__ticketOpen = (id) => { if (id) window.location.href = '/modules/tickets-detail.html?id=' + encodeURIComponent(id); };

  // Type-filter is optioneel voor alle 3 tabs — shared state via F('tk-type').
  function typeParam() { const t = F('tk-type', 'all'); return t === 'all' ? '' : '&type=' + encodeURIComponent(t); }

  // ── Fetchers per tab ──────────────────────────────────────────────────
  async function fetchTab(state, statusList) {
    const wanted = statusList.join(',') + '|' + F('tk-type', 'all');
    if (state.loading && state.params === wanted) return;
    const seq = ++state.seq;
    state.loading = true; state.error = null; state.params = wanted;
    window.DFO.render();
    // 'Afgehandeld' = resolved + closed → 2 parallelle calls, samenvoegen.
    const calls = statusList.map(s => tryFetch('tickets:' + s, `/api/tickets?status=${s}${typeParam()}`));
    const results = await Promise.all(calls);
    if (seq !== state.seq) return;
    // Merge tickets + counts (counts is global — pak eerste non-null).
    const firstCounts = results.find(r => r && r.counts)?.counts || null;
    const allTickets = results.flatMap(r => (r && Array.isArray(r.tickets)) ? r.tickets : []);
    state.data = { tickets: allTickets, counts: firstCounts };
    state.loading = false;
    if (results.every(r => r == null)) state.error = 'Kon tickets niet laden';
    window.DFO.render();
  }

  // ── Gedeelde toolbar (type-filter chips + counts) ─────────────────────
  function toolbar(activeCounts) {
    const t = F('tk-type', 'all');
    return H.toolbar([
      H.chips('tk-type', [
        { l: 'Alle types', v: 'all' },
        { l: 'Bug',        v: 'bug' },
        { l: 'Feature',    v: 'feature' },
        { l: 'Vraag',      v: 'question' },
        { l: 'Taak',       v: 'task' },
      ], t),
      `<div class="tb-right">
        <button class="btn btn-primary" onclick="__ticketNew()">${svg(I.plus)}Nieuw ticket</button>
      </div>`,
    ]);
  }

  // ── Gedeelde tabel-renderer ───────────────────────────────────────────
  function ticketTable(items, loading, error) {
    if (!items.length && !loading) return `<div class="sv-empty">${error || 'Geen tickets in deze categorie.'}</div>`;
    return H.table(
      [{ l: 'Titel' }, { l: 'Type', cls: 'optional' }, { l: 'Module', cls: 'optional' }, { l: 'Prioriteit' }, { l: 'Aangemaakt door', cls: 'optional' }, { l: 'Toegewezen aan', cls: 'optional' }, { l: 'Datum', cls: 'r' }],
      items.map(t => {
        const [pc, pl] = PRIO_TO_PILL[t.priority] || ['neutral', t.priority || '—'];
        const [tc, tl] = TYPE_TO_PILL[t.type] || ['neutral', t.type || '—'];
        return [
          `<a href="javascript:__ticketOpen('${t.id}')" class="cell-main tk-title">${t.title || '—'}</a>`,
          H.pill(tc, tl),
          `<span style="font-size:12.5px;color:var(--text-3)">${t.module || '—'}</span>`,
          H.pill(pc, pl),
          `<span style="font-size:12.5px;color:var(--text-3)">${t.created_by_name || '—'}</span>`,
          `<span style="font-size:12.5px;color:var(--text-3)">${t.assigned_to_name || 'Niet toegewezen'}</span>`,
          `<span class="mono" style="font-size:12.5px;color:var(--text-3)">${dstr(t.created_at)}</span>`,
        ];
      })
    );
  }

  // ── KPI-strip (global counts uit endpoint) ────────────────────────────
  function kpiStrip(counts) {
    return H.kpis([
      { c: 'orange',  icon: I.warn,   label: 'Open',            val: num(counts?.open),          hi: 1 },
      { c: 'blue',    icon: I.repeat, label: 'Wacht op klant',  val: num(counts?.in_progress),          sub: 'in_progress in DB' },
      { c: 'emerald', icon: I.check,  label: 'Afgehandeld',     val: num((counts?.resolved || 0) + (counts?.closed || 0)), sub: 'resolved + closed' },
    ]);
  }

  // ── Views ─────────────────────────────────────────────────────────────
  function openView() {
    if (!_open.loading && (!_open.data || _open.params !== ('open|' + F('tk-type', 'all')))) queueMicrotask(() => fetchTab(_open, ['open']));
    const items = _open.data?.tickets || [];
    return `${previewHeader('Open', _open)}
      ${kpiStrip(_open.data?.counts)}
      ${toolbar(_open.data?.counts)}
      ${ticketTable(items, _open.loading, _open.error)}`;
  }
  function waitView() {
    if (!_wait.loading && (!_wait.data || _wait.params !== ('in_progress|' + F('tk-type', 'all')))) queueMicrotask(() => fetchTab(_wait, ['in_progress']));
    const items = _wait.data?.tickets || [];
    return `${previewHeader('Wacht op klant · maps naar status=in_progress', _wait)}
      ${kpiStrip(_wait.data?.counts)}
      ${toolbar(_wait.data?.counts)}
      ${ticketTable(items, _wait.loading, _wait.error)}`;
  }
  function doneView() {
    if (!_done.loading && (!_done.data || _done.params !== ('resolved,closed|' + F('tk-type', 'all')))) queueMicrotask(() => fetchTab(_done, ['resolved', 'closed']));
    const items = _done.data?.tickets || [];
    return `${previewHeader('Afgehandeld · resolved + closed samengevoegd', _done)}
      ${kpiStrip(_done.data?.counts)}
      ${toolbar(_done.data?.counts)}
      ${ticketTable(items, _done.loading, _done.error)}`;
  }

  window.DFO.VIEWS['tickets/Open']           = openView;
  window.DFO.VIEWS['tickets/Wacht op klant'] = waitView;
  window.DFO.VIEWS['tickets/Afgehandeld']    = doneView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('tickets');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('tickets');
  console.debug('[tickets-v2] registered 3 views (data-round · live /api/tickets)');
})();
