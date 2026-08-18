// modules/klanten-v2/views/wanbetalers-v2.js
//
// Wanbetalers v2 — BROK 1 (v=2, 2026-08-18): reads bedraden.
// 4 tabs (Gesprekken / Acties / Overzicht / Brieven) — echte data uit
// bestaande endpoints, spiegel van modules/finance.html #view-wanbetalers.
// GEEN writes; motor NIET aangeraakt.
//
// Endpoint-mapping per tab (allemaal al in productie):
//   Overzicht  → GET /api/wanbetalers-overzicht-list         (klanten + open + fase)
//                GET /api/arrangements-list?status=ACTIEF    (badges: dunning gepauzeerd)
//                GET /api/dunning-settings-get               (office-hours info)
//   Acties     → GET /api/dunning-pipeline-actions           (appointments_due/awaiting/stale)
//                GET /api/pending-actions-list?status=pending&limit=200
//   Gesprekken → GET /api/wanbetalers-overzicht-list         (lijst met open bedragen)
//                GET /api/dunning-call-log-list?customer_id=X (bij drilldown)
//                GET /api/wanbetalers-timeline?customer_id=X (bij drilldown)
//   Brieven    → GET /api/dunning-briefs-list-all            (globale lijst)
//
// Write-endpoints (approve/reject/send-brief/call-log) zijn BEWUST NIET
// aangeroepen. Alle actie-knoppen disabled met "komt in BROK 2"-tooltip.
//
// Per-klant tijdlijn: link naar bestaande klanten.html?id=X#wanbetalers
// (niet dupliceren; die tab is al mature met notitie-post).
//
// Dormant — 'wanbetalers' NIET in V2_ACTIVE_ALLOWLIST. Preview:
// ?v2preview=wanbetalers (rol SAM = sales/admin/manager/super_admin).

(function () {
  if (!window.DFO) { console.error('[wanbetalers-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[wanbetalers-v2] KV_V2.helpers niet geladen.'); return; }
  const { I, svg } = window.DFO;
  const H = window.KV_V2.helpers;
  const asArr = (x) => Array.isArray(x) ? x : [];
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const eur  = (n) => new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 }).format(Number(n) || 0);
  const eur0 = (n) => new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(Number(n) || 0);

  /* ── State ──────────────────────────────────────────────────────────── */
  const _live = {
    overzicht:    { loading: false, fetched: false, error: null, items: [], _seq: 0 },
    pipelineActs: { loading: false, fetched: false, error: null, data: null, _seq: 0 },
    pendingActs:  { loading: false, fetched: false, error: null, items: [], _seq: 0 },
    arrangements: { loading: false, fetched: false, error: null, byCust: {}, _seq: 0 },
    briefs:       { loading: false, fetched: false, error: null, items: [], _seq: 0 },
    settings:     { loading: false, fetched: false, error: null, data: null, _seq: 0 },
    callLog:      { loading: false, error: null, byCust: {}, _seq: 0 },
    timeline:     { loading: false, error: null, byCust: {}, _seq: 0 },
  };
  const _ui = {
    ovStatusFilter: 'all',       // 'all' | 'ok' | 'chat' | 'stuck'
    ovSearchQ:      '',
    _ovSearchTimer: null,
    ovSelectedId:   null,        // customer_id voor drilldown
    gspSelectedId:  null,        // Gesprekken-tab drilldown
    gspSearchQ:     '',
    _gspSearchTimer: null,
    brStatusFilter: 'new',       // 'new' | 'downloaded' | 'sent' | 'all'
  };
  const NOOP = () => { try { window.KV && window.KV.toast && window.KV.toast('Komt in BROK 2 (writes) — deze knop is nog niet actief.'); } catch (_) {} };
  window.__wbxNoop = NOOP;

  /* ── HTTP-helper ────────────────────────────────────────────────────── */
  async function tryFetch(label, url, timeoutMs) {
    timeoutMs = timeoutMs || 8000;
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      return await Promise.race([
        window.KV.authedJson(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) {
      console.warn('[wanbetalers-v2] ' + label + ' fail:', e?.message);
      return null;
    }
  }

  /* ── Fetchers ──────────────────────────────────────────────────────── */
  async function _fetchOverzicht() {
    const st = _live.overzicht;
    if (st.loading || (st.fetched && !st.error)) return;
    st.loading = true; st.error = null;
    const seq = ++st._seq;
    if (window.DFO?.render) window.DFO.render();
    const j = await tryFetch('overzicht', '/api/wanbetalers-overzicht-list');
    if (seq !== st._seq) return;
    st.loading = false; st.fetched = true;
    if (!j || j.error) st.error = (j && j.error) || 'Kon overzicht niet laden';
    else st.items = asArr(j.items || j.customers || j.rows);
    // Trigger arrangement-badge-fetch parallel.
    queueMicrotask(_fetchArrangements);
    if (window.DFO?.render) window.DFO.render();
  }
  async function _fetchPipelineActs() {
    const st = _live.pipelineActs;
    if (st.loading || (st.fetched && !st.error)) return;
    st.loading = true; st.error = null;
    const seq = ++st._seq;
    if (window.DFO?.render) window.DFO.render();
    const j = await tryFetch('pipeline-actions', '/api/dunning-pipeline-actions');
    if (seq !== st._seq) return;
    st.loading = false; st.fetched = true;
    if (!j || j.error) st.error = (j && j.error) || 'Kon actie-dashboard niet laden';
    else st.data = j;
    if (window.DFO?.render) window.DFO.render();
  }
  async function _fetchPendingActs() {
    const st = _live.pendingActs;
    if (st.loading || (st.fetched && !st.error)) return;
    st.loading = true; st.error = null;
    const seq = ++st._seq;
    const j = await tryFetch('pending-actions', '/api/pending-actions-list?status=pending&limit=200');
    if (seq !== st._seq) return;
    st.loading = false; st.fetched = true;
    if (!j || j.error) st.error = (j && j.error) || 'Kon open acties niet laden';
    else st.items = asArr(j.items || j.actions);
    if (window.DFO?.render) window.DFO.render();
  }
  async function _fetchArrangements() {
    const st = _live.arrangements;
    if (st.loading || st.fetched) return;
    st.loading = true; st.error = null;
    const seq = ++st._seq;
    const j = await tryFetch('arrangements', '/api/arrangements-list?status=ACTIEF&limit=500');
    if (seq !== st._seq) return;
    st.loading = false; st.fetched = true;
    if (!j || j.error) { st.error = (j && j.error) || 'Kon arrangements niet laden'; return; }
    const items = asArr(j.items || j.arrangements);
    const map = {};
    for (const a of items) {
      const cid = a.customer_id;
      if (!cid) continue;
      if (!map[cid]) map[cid] = [];
      map[cid].push(a);
    }
    st.byCust = map;
    if (window.DFO?.render) window.DFO.render();
  }
  async function _fetchBriefs() {
    const st = _live.briefs;
    if (st.loading || (st.fetched && !st.error)) return;
    st.loading = true; st.error = null;
    const seq = ++st._seq;
    if (window.DFO?.render) window.DFO.render();
    const j = await tryFetch('briefs', '/api/dunning-briefs-list-all?limit=500');
    if (seq !== st._seq) return;
    st.loading = false; st.fetched = true;
    if (!j || j.error) st.error = (j && j.error) || 'Kon brieven niet laden';
    else st.items = asArr(j.items || j.briefs);
    if (window.DFO?.render) window.DFO.render();
  }
  async function _fetchSettings() {
    const st = _live.settings;
    if (st.loading || (st.fetched && !st.error)) return;
    st.loading = true; st.error = null;
    const seq = ++st._seq;
    const j = await tryFetch('settings', '/api/dunning-settings-get');
    if (seq !== st._seq) return;
    st.loading = false; st.fetched = true;
    if (!j || j.error) { st.error = (j && j.error) || 'Kon settings niet laden'; return; }
    st.data = j.settings || j;
    if (window.DFO?.render) window.DFO.render();
  }
  async function _fetchCallLog(cid) {
    const st = _live.callLog;
    if (!cid) return;
    if (st.byCust[cid] || st.loading) return;
    st.loading = true;
    const j = await tryFetch('call-log:' + cid, '/api/dunning-call-log-list?customer_id=' + encodeURIComponent(cid));
    st.loading = false;
    if (j && !j.error) st.byCust[cid] = asArr(j.items || j.calls);
    else st.byCust[cid] = [];
    _repaintGspDetail();
  }
  async function _fetchTimeline(cid) {
    const st = _live.timeline;
    if (!cid) return;
    if (st.byCust[cid] || st.loading) return;
    st.loading = true;
    const j = await tryFetch('timeline:' + cid, '/api/wanbetalers-timeline?customer_id=' + encodeURIComponent(cid));
    st.loading = false;
    if (j && !j.error) st.byCust[cid] = asArr(j.items);
    else st.byCust[cid] = [];
    _repaintGspDetail();
  }

  /* ── Retry-handlers ────────────────────────────────────────────────── */
  window.__wbxRetry = (what) => {
    if (what === 'overzicht')    { _live.overzicht.fetched = false;    _fetchOverzicht(); }
    if (what === 'pipeline-acts'){ _live.pipelineActs.fetched = false; _fetchPipelineActs(); }
    if (what === 'pending-acts') { _live.pendingActs.fetched = false;  _fetchPendingActs(); }
    if (what === 'briefs')       { _live.briefs.fetched = false;       _fetchBriefs(); }
    if (what === 'settings')     { _live.settings.fetched = false;     _fetchSettings(); }
  };

  /* ── UI-handlers ───────────────────────────────────────────────────── */
  window.__wbxOvSetStatus = (val) => {
    if (!['all', 'ok', 'chat', 'stuck'].includes(val)) return;
    _ui.ovStatusFilter = val;
    _repaintOverzichtList();
  };
  window.__wbxOvSearchInput = (val) => {
    const v = String(val || '');
    _ui.ovSearchQ = v;
    const clr = document.getElementById('wbxOvSearchClear');
    if (clr) clr.style.visibility = v.trim() ? 'visible' : 'hidden';
    if (_ui._ovSearchTimer) { clearTimeout(_ui._ovSearchTimer); _ui._ovSearchTimer = null; }
    _ui._ovSearchTimer = setTimeout(_repaintOverzichtList, 250);
  };
  window.__wbxOvSearchClear = () => {
    _ui.ovSearchQ = '';
    const inp = document.getElementById('wbxOvSearchInput');
    if (inp) { inp.value = ''; inp.focus(); }
    const clr = document.getElementById('wbxOvSearchClear');
    if (clr) clr.style.visibility = 'hidden';
    _repaintOverzichtList();
  };
  window.__wbxOvOpen = (cid) => {
    if (!cid) return;
    _ui.ovSelectedId = String(cid);
    // Deep-link naar klanten.html-wanbetalers-tab (bestaande mature tijdlijn).
    try { window.open('/modules/klanten.html?id=' + encodeURIComponent(cid) + '#wanbetalers', '_blank', 'noopener'); } catch (_) {}
  };
  window.__wbxGspSelect = (cid) => {
    if (String(_ui.gspSelectedId) === String(cid)) return;
    _ui.gspSelectedId = String(cid);
    // Surgical row-highlight.
    document.querySelectorAll('#wbxGspList .wbx-gsp-row.on').forEach((el) => el.classList.remove('on'));
    const newRow = document.querySelector('#wbxGspList .wbx-gsp-row[data-cid="' + String(cid).replace(/"/g, '\\"') + '"]');
    if (newRow) newRow.classList.add('on');
    queueMicrotask(() => _fetchCallLog(cid));
    queueMicrotask(() => _fetchTimeline(cid));
    _repaintGspDetail();
  };
  window.__wbxGspSearchInput = (val) => {
    const v = String(val || '');
    _ui.gspSearchQ = v;
    const clr = document.getElementById('wbxGspSearchClear');
    if (clr) clr.style.visibility = v.trim() ? 'visible' : 'hidden';
    if (_ui._gspSearchTimer) { clearTimeout(_ui._gspSearchTimer); _ui._gspSearchTimer = null; }
    _ui._gspSearchTimer = setTimeout(_repaintGspList, 250);
  };
  window.__wbxGspSearchClear = () => {
    _ui.gspSearchQ = '';
    const inp = document.getElementById('wbxGspSearchInput');
    if (inp) { inp.value = ''; inp.focus(); }
    const clr = document.getElementById('wbxGspSearchClear');
    if (clr) clr.style.visibility = 'hidden';
    _repaintGspList();
  };
  window.__wbxBrSetStatus = (val) => {
    if (!['new', 'downloaded', 'sent', 'all'].includes(val)) return;
    _ui.brStatusFilter = val;
    if (window.DFO?.render) window.DFO.render();
  };

  /* ── Surgical repaint helpers ─────────────────────────────────────── */
  function _repaintOverzichtList() {
    const body = document.getElementById('wbxOvBody');
    if (!body) return;
    const rows = _filteredOverzicht();
    body.innerHTML = _overzichtRowsHtml(rows);
    const cnt = document.getElementById('wbxOvCount');
    if (cnt) cnt.textContent = rows.length + ' klant' + (rows.length === 1 ? '' : 'en');
  }
  function _repaintGspList() {
    const body = document.getElementById('wbxGspList');
    if (!body) return;
    body.innerHTML = _gspListInnerHtml();
  }
  function _repaintGspDetail() {
    const pane = document.getElementById('wbxGspDetail');
    if (!pane) return;
    pane.innerHTML = _gspDetailHtml();
  }

  /* ══════════════════════════════════════════════════════════════════
     KANTOORUREN-BANNER (footer-info, alle tabs)
     ══════════════════════════════════════════════════════════════════ */
  function _officeHoursBanner() {
    const s = _live.settings.data && (_live.settings.data.office_hours || _live.settings.data.dunning_office_hours);
    const cfg = s && typeof s === 'object' ? s : null;
    const start = cfg && cfg.start ? String(cfg.start) : '08:00';
    const end   = cfg && cfg.end   ? String(cfg.end)   : '20:00';
    const tz    = cfg && cfg.tz    ? String(cfg.tz)    : 'Europe/Amsterdam';
    return `<div style="margin:12px 20px 0;padding:9px 14px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r-sm);font-size:11.5px;color:var(--text-3);display:flex;align-items:center;gap:8px">
      <span style="color:var(--amber)">⏱</span>
      SEND-acties (mail/WhatsApp) lopen automatisch tussen ${esc(start)}-${esc(end)} ${esc(tz)}. Buiten dit venster gaan berichten in de wachtrij.
    </div>`;
  }

  /* ══════════════════════════════════════════════════════════════════
     TAB 1 — OVERZICHT
     ══════════════════════════════════════════════════════════════════ */
  function _categorizeOverzichtRow(r) {
    const stage = String(r.stage_slug || r.stage || '').toLowerCase();
    if (stage.includes('opgelost') || stage.includes('afschr')) return 'ok';
    if (stage.includes('gesprek') || stage.includes('chat')) return 'chat';
    if (stage.includes('gepauzeerd') || stage.includes('vastgelopen') || stage.includes('incasso')) return 'stuck';
    return 'ok';
  }
  function _filteredOverzicht() {
    const rows = asArr(_live.overzicht.items);
    const q = String(_ui.ovSearchQ || '').trim().toLowerCase();
    return rows.filter((r) => {
      if (_ui.ovStatusFilter !== 'all' && _categorizeOverzichtRow(r) !== _ui.ovStatusFilter) return false;
      if (q) {
        const name = ((r.customer_name || r.name || '') + ' ' + (r.email || '')).toLowerCase();
        if (!name.includes(q)) return false;
      }
      return true;
    });
  }
  function _overzichtRowsHtml(rows) {
    if (!rows.length) {
      return `<div style="padding:44px 20px;text-align:center;color:var(--text-3);font-size:13px">${
        _ui.ovSearchQ.trim() || _ui.ovStatusFilter !== 'all'
          ? 'Geen wanbetalers die aan de filters voldoen.'
          : 'Geen wanbetalers.'}</div>`;
    }
    const arrsMap = _live.arrangements.byCust || {};
    return rows.map((r) => {
      const cid = r.customer_id || r.id;
      const name = r.customer_name || r.name || 'Onbekend';
      const openAmt = Number(r.total_open_amount || r.open_amount || 0);
      const invCount = Number(r.invoice_count || r.open_invoice_count || 0);
      const oldestDays = Number(r.oldest_open_days || 0);
      const stage = r.stage_label || r.stage_slug || r.stage || '—';
      const nextAt = r.next_action_at || r.next_action || null;
      const nextTxt = nextAt ? _fmtDateTime(nextAt) : '—';
      const category = _categorizeOverzichtRow(r);
      const catCol = category === 'stuck' ? 'rose' : category === 'chat' ? 'blue' : 'emerald';
      const hasArr = cid && Array.isArray(arrsMap[cid]) && arrsMap[cid].length > 0;
      const cidClick = String(cid || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      return `<div style="display:grid;grid-template-columns:2fr 1fr 90px 100px 1.4fr 1.2fr 90px;gap:8px;padding:11px 14px;border-bottom:1px solid var(--border);cursor:pointer;align-items:center;font-size:12.5px" onclick="__wbxOvOpen('${cidClick}')"
        onmouseover="this.style.background='var(--surface-2)'" onmouseout="this.style.background='transparent'">
        <div>
          <div style="font-weight:500">${esc(name)}</div>
          ${hasArr ? `<div style="font-size:10.5px;color:var(--amber);margin-top:2px" title="Actief payment_arrangement: dunning gepauzeerd">⏸ Dunning gepauzeerd (arrangement actief)</div>` : ''}
        </div>
        <div class="mono" style="text-align:right;color:${openAmt > 0 ? 'var(--amber)' : 'var(--text-3)'};font-weight:600">${eur(openAmt)}</div>
        <div class="mono" style="text-align:right;color:var(--text-3)">${invCount}</div>
        <div class="mono" style="text-align:right;color:${oldestDays > 90 ? 'var(--rose)' : oldestDays > 30 ? 'var(--amber)' : 'var(--text-3)'}">${oldestDays}d</div>
        <div><span style="font-size:10.5px;padding:2px 8px;border-radius:6px;background:var(--${catCol}-soft,var(--surface-2));color:var(--${catCol});font-weight:600">${esc(stage)}</span></div>
        <div style="color:var(--text-3);font-size:11.5px">${esc(nextTxt)}</div>
        <div style="text-align:right;color:var(--text-3);font-size:11px" title="Open in klanten-detail (tijdlijn)">→</div>
      </div>`;
    }).join('');
  }
  function overzichtView() {
    if (!_live.overzicht.fetched && !_live.overzicht.loading) queueMicrotask(_fetchOverzicht);
    if (!_live.settings.fetched && !_live.settings.loading) queueMicrotask(_fetchSettings);

    if (_live.overzicht.loading && !_live.overzicht.items.length) {
      return `<div class="pad" style="padding:14px 20px">${_skelKpis()}${_skelRows(6)}</div>`;
    }
    if (_live.overzicht.error && !_live.overzicht.items.length) {
      return `<div class="pad" style="padding:14px 20px">${_errBlk(_live.overzicht.error, 'overzicht')}</div>`;
    }

    const items = asArr(_live.overzicht.items);
    const totalOpen = items.reduce((a, r) => a + Number(r.total_open_amount || r.open_amount || 0), 0);
    const totalCust = items.length;
    const inIncasso = items.filter((r) => String(r.stage_slug || '').toLowerCase().includes('incasso')).length;
    const arrCount  = Object.keys(_live.arrangements.byCust || {}).length;

    const kpi = (label, val, sub, color) => `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px 16px">
        <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);margin-bottom:6px">${esc(label)}</div>
        <div style="font-size:22px;font-weight:600;letter-spacing:-.02em;color:var(--${color || 'text-1'})">${val == null ? '<span style="opacity:.4">…</span>' : esc(String(val))}</div>
        ${sub ? `<div style="font-size:11.5px;color:var(--text-3);margin-top:4px">${esc(sub)}</div>` : ''}
      </div>`;

    const filterChips = [
      ['all',  'Alles',       totalCust],
      ['ok',    'Loopt',       items.filter((r) => _categorizeOverzichtRow(r) === 'ok').length],
      ['chat',  'In gesprek',  items.filter((r) => _categorizeOverzichtRow(r) === 'chat').length],
      ['stuck', 'Vastgelopen', items.filter((r) => _categorizeOverzichtRow(r) === 'stuck').length],
    ].map(([v, l, n]) => `<button class="chip ${_ui.ovStatusFilter === v ? 'on' : ''}" style="font-size:11.5px;padding:3px 10px" onclick="__wbxOvSetStatus('${v}')">${esc(l)}<span class="cnt" style="margin-left:5px;opacity:.7">${n}</span></button>`).join('');

    const qVal = String(_ui.ovSearchQ || '');
    const searchBar = `
      <div style="position:relative;flex:1;min-width:220px;max-width:340px">
        <input id="wbxOvSearchInput" type="text" value="${esc(qVal)}"
          oninput="__wbxOvSearchInput(this.value)"
          placeholder="Zoek klant op naam of email…"
          style="width:100%;padding:6px 28px 6px 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);color:var(--text-1);font-size:12px;outline:none;box-sizing:border-box"
          autocomplete="off" spellcheck="false" />
        <button id="wbxOvSearchClear" title="Wis zoekterm" onclick="__wbxOvSearchClear()"
          style="position:absolute;top:50%;right:6px;transform:translateY(-50%);width:20px;height:20px;padding:0;border:0;background:transparent;color:var(--text-3);font-size:14px;cursor:pointer;visibility:${qVal.trim() ? 'visible' : 'hidden'}">×</button>
      </div>`;

    const filtered = _filteredOverzicht();
    return `<div data-wbx-view="overzicht">
      <div class="pad" style="padding:14px 20px 0">
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px">
          ${kpi('Totaal open',       eur0(totalOpen), totalCust + ' klanten',      totalOpen > 0 ? 'amber' : 'text-3')}
          ${kpi('Wanbetalers',       totalCust,        'in overzicht',              'text-1')}
          ${kpi('In incasso',        inIncasso,        inIncasso > 0 ? 'dossier open' : 'geen',  inIncasso > 0 ? 'rose' : 'text-3')}
          ${kpi('Arrangementen',     arrCount,         'actief · dunning gepauzeerd', arrCount > 0 ? 'violet' : 'text-3')}
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
          <div style="padding:11px 14px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:8px">
            <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
              ${searchBar}
              <div style="display:flex;gap:5px;flex-wrap:wrap">${filterChips}</div>
            </div>
            <div style="font-size:11.5px;color:var(--text-3);display:flex;justify-content:space-between">
              <span id="wbxOvCount">${filtered.length} klant${filtered.length === 1 ? '' : 'en'}</span>
              <span>Klik een rij voor de tijdlijn in Klanten-detail →</span>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:2fr 1fr 90px 100px 1.4fr 1.2fr 90px;gap:8px;padding:8px 14px;background:var(--surface-2);border-bottom:1px solid var(--border);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);font-weight:600">
            <div>Klant</div><div style="text-align:right">Open</div><div style="text-align:right">Fact.</div><div style="text-align:right">Oudste</div><div>Fase</div><div>Volgende actie</div><div></div>
          </div>
          <div id="wbxOvBody">${_overzichtRowsHtml(filtered)}</div>
        </div>
      </div>
      ${_officeHoursBanner()}
    </div>`;
  }

  /* ══════════════════════════════════════════════════════════════════
     TAB 2 — ACTIES
     ══════════════════════════════════════════════════════════════════ */
  function actiesView() {
    if (!_live.pipelineActs.fetched && !_live.pipelineActs.loading) queueMicrotask(_fetchPipelineActs);
    if (!_live.pendingActs.fetched && !_live.pendingActs.loading) queueMicrotask(_fetchPendingActs);
    if (!_live.settings.fetched && !_live.settings.loading) queueMicrotask(_fetchSettings);

    const pa  = _live.pipelineActs.data || {};
    const apDue     = asArr(pa.appointments_due);
    const awaiting  = asArr(pa.awaiting_reply);
    const stale     = asArr(pa.stale);
    const totalActs = apDue.length + awaiting.length + stale.length;

    const pending = asArr(_live.pendingActs.items);

    if (_live.pipelineActs.loading && !_live.pipelineActs.data) {
      return `<div class="pad" style="padding:14px 20px">${_skelKpis()}${_skelRows(6)}</div>`;
    }

    const kpi = (label, val, sub, color) => `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px 16px">
        <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);margin-bottom:6px">${esc(label)}</div>
        <div style="font-size:22px;font-weight:600;color:var(--${color || 'text-1'})">${esc(String(val))}</div>
        ${sub ? `<div style="font-size:11.5px;color:var(--text-3);margin-top:4px">${esc(sub)}</div>` : ''}
      </div>`;

    const sectionBlock = (title, rows, emptyTxt, colorAcc) => {
      if (!rows.length) return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px 16px">
        <div style="font-weight:600;font-size:13px;margin-bottom:8px;color:var(--${colorAcc})">${esc(title)}</div>
        <div style="padding:12px;color:var(--text-3);font-size:12.5px;text-align:center">${esc(emptyTxt)}</div>
      </div>`;
      return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
        <div style="padding:12px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
          <div style="font-weight:600;font-size:13px;color:var(--${colorAcc})">${esc(title)}</div>
          <span style="font-size:11px;color:var(--text-3)">${rows.length} rij${rows.length === 1 ? '' : 'en'}</span>
        </div>
        ${rows.slice(0, 25).map((r) => {
          const name = r.customer_name || r.name || 'Onbekend';
          const info = r.title || r.due_at || r.last_outbound_at || r.reason || '';
          const days = r.days_since != null ? r.days_since : (r.days_stale != null ? r.days_stale : null);
          const cid = r.customer_id || r.id;
          const cidClick = String(cid || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
          return `<div style="display:flex;justify-content:space-between;padding:9px 14px;border-bottom:1px solid var(--border);font-size:12.5px;gap:10px;align-items:center;cursor:${cid ? 'pointer' : 'default'}" ${cid ? `onclick="__wbxOvOpen('${cidClick}')"` : ''}
            onmouseover="if(this.dataset.click)this.style.background='var(--surface-2)'" onmouseout="this.style.background='transparent'" ${cid ? 'data-click="1"' : ''}>
            <div style="flex:1;min-width:0">
              <div style="font-weight:500">${esc(name)}</div>
              <div style="font-size:11px;color:var(--text-3);margin-top:2px">${esc(String(info).slice(0, 100))}</div>
            </div>
            ${days != null ? `<span class="mono" style="font-size:11px;color:var(--text-3)">${days}d</span>` : ''}
          </div>`;
        }).join('')}
      </div>`;
    };

    const pendingBlock = pending.length ? `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden;margin-top:14px">
      <div style="padding:12px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
        <div style="font-weight:600;font-size:13px">Open acties (queue)</div>
        <span style="font-size:11px;color:var(--text-3)">${pending.length} PENDING</span>
      </div>
      ${pending.slice(0, 30).map((a) => {
        const customer = a.customer_name || (a.payload && a.payload.customer_name) || a.customer_id || 'Onbekend';
        const type = a.action_type || a.type || '—';
        const amt  = a.amount || (a.payload && a.payload.amount) || null;
        const ct   = a.created_at ? _fmtDateTime(a.created_at) : '';
        return `<div style="display:grid;grid-template-columns:2fr 2fr 1fr auto;gap:10px;padding:9px 14px;border-bottom:1px solid var(--border);font-size:12.5px;align-items:center">
          <div>${esc(customer)}</div>
          <div style="color:var(--text-2);font-size:11.5px">${esc(type)}</div>
          <div class="mono" style="text-align:right;color:var(--text-3)">${amt != null ? eur(amt) : '—'}</div>
          <div style="text-align:right"><button class="btn btn-ghost btn-sm" disabled title="Approve komt in BROK 2" style="font-size:11px;opacity:.5;cursor:not-allowed">Approve →</button></div>
        </div>`;
      }).join('')}
      <div style="padding:9px 14px;font-size:11px;color:var(--text-3);background:var(--surface-2)">Approve/reject-flow komt in BROK 2 (writes).</div>
    </div>` : '';

    return `<div data-wbx-view="acties">
      <div class="pad" style="padding:14px 20px 0">
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px">
          ${kpi('Acties vandaag',    totalActs,         'appointments + awaiting + stale', totalActs > 0 ? 'amber' : 'text-3')}
          ${kpi('Afspraken open',    apDue.length,      'verlopen of vandaag',              apDue.length > 0 ? 'rose' : 'text-3')}
          ${kpi('Wacht op reactie',  awaiting.length,   '> 2 dagen',                        awaiting.length > 0 ? 'amber' : 'text-3')}
          ${kpi('Stil / vastgelopen',stale.length,      '> 14 dagen zonder activiteit',     stale.length > 0 ? 'rose' : 'text-3')}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
          ${sectionBlock('Afspraken vandaag', apDue,    'Geen open afspraken.',           'rose')}
          ${sectionBlock('Wacht op reactie',  awaiting, 'Geen wachtende gesprekken.',     'amber')}
          ${sectionBlock('Stil / vastgelopen',stale,    'Geen stille dossiers.',          'text-3')}
        </div>
        ${pendingBlock}
      </div>
      ${_officeHoursBanner()}
    </div>`;
  }

  /* ══════════════════════════════════════════════════════════════════
     TAB 3 — GESPREKKEN
     ══════════════════════════════════════════════════════════════════ */
  function _gspListInnerHtml() {
    const rows = asArr(_live.overzicht.items);
    const q = String(_ui.gspSearchQ || '').trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (!q) return true;
      const name = ((r.customer_name || r.name || '') + ' ' + (r.email || '')).toLowerCase();
      return name.includes(q);
    });
    if (!filtered.length) return `<div style="padding:44px 20px;text-align:center;color:var(--text-3);font-size:13px">Geen wanbetalers gevonden.</div>`;
    return filtered.map((r) => {
      const cid = r.customer_id || r.id;
      const name = r.customer_name || r.name || 'Onbekend';
      const openAmt = Number(r.total_open_amount || r.open_amount || 0);
      const stage = r.stage_label || r.stage_slug || '—';
      const onCls = String(_ui.gspSelectedId) === String(cid) ? 'on' : '';
      const cidClick = String(cid || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const cidAttr  = String(cid || '').replace(/"/g, '&quot;');
      return `<div class="wbx-gsp-row ${onCls}" data-cid="${cidAttr}" onclick="__wbxGspSelect('${cidClick}')"
        style="padding:11px 14px;border-bottom:1px solid var(--border);cursor:pointer;${onCls ? 'background:var(--surface-2)' : ''}">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">
          <span style="font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</span>
          <span class="mono" style="color:var(--amber);font-size:12px;font-weight:600;flex-shrink:0">${eur0(openAmt)}</span>
        </div>
        <div style="font-size:11px;color:var(--text-3);margin-top:2px">${esc(stage)}</div>
      </div>`;
    }).join('');
  }
  function _gspDetailHtml() {
    const cid = _ui.gspSelectedId;
    if (!cid) return `<div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-3);font-size:13px">Selecteer een klant links</div>`;
    const row = asArr(_live.overzicht.items).find((r) => String(r.customer_id || r.id) === String(cid));
    if (!row) return `<div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-3);font-size:13px">Klant niet gevonden in overzicht.</div>`;
    const name = row.customer_name || row.name || 'Onbekend';
    const openAmt = Number(row.total_open_amount || row.open_amount || 0);
    const cidClick = String(cid).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    const calls = asArr(_live.callLog.byCust[cid]);
    const timeline = asArr(_live.timeline.byCust[cid]);
    const callsLoading = !_live.callLog.byCust[cid];
    const tlLoading = !_live.timeline.byCust[cid];

    const callsBlock = callsLoading
      ? `<div style="padding:12px;color:var(--text-3);font-size:12.5px;text-align:center">Belpogingen laden…</div>`
      : calls.length
        ? calls.slice(0, 20).map((c) => `<div style="padding:9px 14px;border-bottom:1px solid var(--border);font-size:12.5px;display:flex;justify-content:space-between;gap:10px">
            <div style="flex:1;min-width:0">
              <div>${esc(c.outcome || '—')}${c.note ? ' — ' + esc(String(c.note).slice(0, 80)) : ''}</div>
              <div style="font-size:11px;color:var(--text-3);margin-top:2px">${esc(_fmtDateTime(c.created_at))}${c.callback_at ? ' · terugbellen: ' + esc(_fmtDateTime(c.callback_at)) : ''}</div>
            </div>
          </div>`).join('')
        : `<div style="padding:22px;text-align:center;color:var(--text-3);font-size:12.5px">Geen belpogingen gelogd.</div>`;

    const tlBlock = tlLoading
      ? `<div style="padding:12px;color:var(--text-3);font-size:12.5px;text-align:center">Tijdlijn laden…</div>`
      : timeline.length
        ? timeline.slice(0, 30).map((it) => {
            const WT = window.WanbetalersTimeline || null;
            const label = WT && typeof WT.labelFor === 'function' ? WT.labelFor(it) : (it.event_type || it.kind || 'event');
            const at = it.created_at || it.at || '';
            return `<div style="padding:8px 14px;border-bottom:1px solid var(--border);font-size:12px">
              <div>${esc(label)}</div>
              <div style="font-size:10.5px;color:var(--text-3);margin-top:2px">${esc(_fmtDateTime(at))}</div>
            </div>`;
          }).join('')
        : `<div style="padding:22px;text-align:center;color:var(--text-3);font-size:12.5px">Geen events in de tijdlijn.</div>`;

    return `<div style="display:flex;flex-direction:column;flex:1;min-height:0;background:var(--surface)">
      <div style="padding:14px 20px;background:var(--surface);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:10px">
        <div style="min-width:0">
          <div style="font-size:16px;font-weight:600;letter-spacing:-.02em">${esc(name)}</div>
          <div style="font-size:12.5px;color:var(--amber);font-weight:500">${eur(openAmt)} openstaand</div>
        </div>
        <button class="btn btn-primary btn-sm" style="background:var(--brand,#0A7490);border-color:var(--brand,#0A7490);color:#fff;font-size:11.5px" onclick="__wbxOvOpen('${cidClick}')" title="Open klant-detail met wanbetalers-tijdlijn en notitie-post">Open in klanten-detail →</button>
      </div>
      <div style="flex:1;overflow-y:auto;min-height:0;padding:14px 20px;display:flex;flex-direction:column;gap:14px">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
          <div style="padding:11px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
            <div style="font-weight:600;font-size:13px">Belpogingen</div>
            <span style="font-size:11px;color:var(--text-3)">${calls.length} log-regel${calls.length === 1 ? '' : 's'}</span>
          </div>
          ${callsBlock}
          <div style="padding:9px 14px;font-size:11px;color:var(--text-3);background:var(--surface-2)">Belpoging loggen komt in BROK 2.</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
          <div style="padding:11px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
            <div style="font-weight:600;font-size:13px">Tijdlijn</div>
            <span style="font-size:11px;color:var(--text-3)">${timeline.length} event${timeline.length === 1 ? '' : 's'}</span>
          </div>
          ${tlBlock}
        </div>
        <div style="padding:12px;background:var(--surface-2);border:1px dashed var(--border);border-radius:var(--r-sm);font-size:12px;color:var(--text-3)">
          <b>Reageren</b> vanuit deze view komt in BROK 2. Voor nu: klik <i>Open in klanten-detail</i> voor de notitie-post en de bestaande communicatie-tab.
        </div>
      </div>
    </div>`;
  }
  function gesprekkenView() {
    if (!_live.overzicht.fetched && !_live.overzicht.loading) queueMicrotask(_fetchOverzicht);
    if (_ui.gspSelectedId && !_live.callLog.byCust[_ui.gspSelectedId]) queueMicrotask(() => _fetchCallLog(_ui.gspSelectedId));
    if (_ui.gspSelectedId && !_live.timeline.byCust[_ui.gspSelectedId]) queueMicrotask(() => _fetchTimeline(_ui.gspSelectedId));

    if (_live.overzicht.loading && !_live.overzicht.items.length) {
      return `<div class="pad" style="padding:14px 20px">${_skelRows(6)}</div>`;
    }

    const qVal = String(_ui.gspSearchQ || '');
    const searchBar = `
      <div style="position:relative">
        <input id="wbxGspSearchInput" type="text" value="${esc(qVal)}"
          oninput="__wbxGspSearchInput(this.value)"
          placeholder="Zoek klant…"
          style="width:100%;padding:6px 28px 6px 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);color:var(--text-1);font-size:12px;outline:none;box-sizing:border-box"
          autocomplete="off" spellcheck="false" />
        <button id="wbxGspSearchClear" title="Wis" onclick="__wbxGspSearchClear()"
          style="position:absolute;top:50%;right:6px;transform:translateY(-50%);width:20px;height:20px;padding:0;border:0;background:transparent;color:var(--text-3);font-size:14px;cursor:pointer;visibility:${qVal.trim() ? 'visible' : 'hidden'}">×</button>
      </div>`;

    return `<div data-wbx-view="gesprekken" class="pad" style="padding:14px 20px 0">
      <div style="display:flex;gap:0;height:calc(100vh - 200px);min-height:520px;border:1px solid var(--border);border-radius:var(--r);overflow:hidden;background:var(--surface)">
        <div style="width:340px;min-width:280px;max-width:40%;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column">
          <div style="padding:11px 14px;border-bottom:1px solid var(--border)">${searchBar}</div>
          <div id="wbxGspList" style="flex:1;overflow-y:auto;min-height:0">${_gspListInnerHtml()}</div>
        </div>
        <div id="wbxGspDetail" style="flex:1;display:flex;flex-direction:column;min-width:0">${_gspDetailHtml()}</div>
      </div>
      ${_officeHoursBanner()}
    </div>`;
  }

  /* ══════════════════════════════════════════════════════════════════
     TAB 4 — BRIEVEN
     ══════════════════════════════════════════════════════════════════ */
  function brievenView() {
    if (!_live.briefs.fetched && !_live.briefs.loading) queueMicrotask(_fetchBriefs);

    if (_live.briefs.loading && !_live.briefs.items.length) {
      return `<div class="pad" style="padding:14px 20px">${_skelRows(6)}</div>`;
    }
    if (_live.briefs.error && !_live.briefs.items.length) {
      return `<div class="pad" style="padding:14px 20px">${_errBlk(_live.briefs.error, 'briefs')}</div>`;
    }

    const items = asArr(_live.briefs.items);
    const categorize = (b) => {
      if (b.sent_at || b.status === 'sent' || b.sent_via) return 'sent';
      if (b.downloaded_at || b.status === 'downloaded') return 'downloaded';
      return 'new';
    };
    const filtered = items.filter((b) => _ui.brStatusFilter === 'all' || categorize(b) === _ui.brStatusFilter);

    const counts = {
      all: items.length,
      new: items.filter((b) => categorize(b) === 'new').length,
      downloaded: items.filter((b) => categorize(b) === 'downloaded').length,
      sent: items.filter((b) => categorize(b) === 'sent').length,
    };
    const chips = [
      ['new',        'Aangemaakt', counts.new],
      ['downloaded', 'Gedownload', counts.downloaded],
      ['sent',       'Verstuurd',  counts.sent],
      ['all',        'Alle',       counts.all],
    ].map(([v, l, n]) => `<button class="chip ${_ui.brStatusFilter === v ? 'on' : ''}" style="font-size:11.5px;padding:3px 10px" onclick="__wbxBrSetStatus('${v}')">${esc(l)}<span class="cnt" style="margin-left:5px;opacity:.7">${n}</span></button>`).join('');

    const rowsHtml = filtered.length ? filtered.map((b) => {
      const name = b.customer_name || b.customer?.name || 'Onbekend';
      const openAmt = Number(b.open_amount || b.amount || 0);
      const created = b.created_at ? _fmtDate(b.created_at) : '—';
      const cat = categorize(b);
      const statusPill = cat === 'sent'
        ? `<span style="font-size:10.5px;padding:2px 8px;border-radius:6px;background:var(--emerald-soft);color:var(--emerald);font-weight:600">Verstuurd${b.sent_via ? ' · ' + esc(b.sent_via) : ''}</span>`
        : cat === 'downloaded'
          ? `<span style="font-size:10.5px;padding:2px 8px;border-radius:6px;background:var(--amber-soft);color:var(--amber);font-weight:600">Gedownload</span>`
          : `<span style="font-size:10.5px;padding:2px 8px;border-radius:6px;background:var(--blue-soft);color:var(--blue);font-weight:600">Aangemaakt</span>`;
      const pdfPath = b.pdf_path || null;
      const pdfBtn = pdfPath
        ? `<button class="btn btn-ghost btn-sm" style="font-size:11px" disabled title="PDF-preview komt in BROK 2 (via signed URL)">PDF →</button>`
        : `<span style="font-size:11px;color:var(--text-3)">—</span>`;
      return `<div style="display:grid;grid-template-columns:2fr 1fr 100px 130px 80px;gap:8px;padding:9px 14px;border-bottom:1px solid var(--border);font-size:12.5px;align-items:center">
        <div style="font-weight:500">${esc(name)}</div>
        <div class="mono" style="text-align:right;color:${openAmt > 0 ? 'var(--amber)' : 'var(--text-3)'}">${eur(openAmt)}</div>
        <div class="mono" style="text-align:right;color:var(--text-3)">${esc(created)}</div>
        <div>${statusPill}</div>
        <div style="text-align:right">${pdfBtn}</div>
      </div>`;
    }).join('') : `<div style="padding:44px 20px;text-align:center;color:var(--text-3);font-size:13px">Geen brieven in dit filter.</div>`;

    return `<div data-wbx-view="brieven">
      <div class="pad" style="padding:14px 20px 0">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
          <div style="padding:11px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
            <div style="display:flex;gap:5px;flex-wrap:wrap">${chips}</div>
            <div style="font-size:11px;color:var(--text-3)">${filtered.length} brie${filtered.length === 1 ? 'f' : 'ven'}</div>
          </div>
          <div style="display:grid;grid-template-columns:2fr 1fr 100px 130px 80px;gap:8px;padding:8px 14px;background:var(--surface-2);border-bottom:1px solid var(--border);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);font-weight:600">
            <div>Klant</div><div style="text-align:right">Openstaand</div><div style="text-align:right">Aangemaakt</div><div>Status</div><div></div>
          </div>
          <div>${rowsHtml}</div>
          <div style="padding:10px 14px;font-size:11px;color:var(--text-3);background:var(--surface-2)">Bulk-print / mail-verstuur / mark-verstuurd komen in BROK 2 (writes).</div>
        </div>
      </div>
      ${_officeHoursBanner()}
    </div>`;
  }

  /* ── Formatters + skeletons + err ─────────────────────────────────── */
  function _fmtDate(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: '2-digit' }); } catch (_) { return '—'; }
  }
  function _fmtDateTime(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch (_) { return '—'; }
  }
  function _skelKpis() {
    return `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px">
      ${Array.from({ length: 4 }).map(() => `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px 16px;opacity:.55">
        <div style="height:10px;width:60%;background:var(--surface-2);border-radius:4px;margin-bottom:8px"></div>
        <div style="height:22px;width:40%;background:var(--surface-2);border-radius:4px"></div>
      </div>`).join('')}
    </div>`;
  }
  function _skelRows(n) {
    return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden">${Array.from({ length: n }).map(() => `<div style="padding:11px 14px;border-bottom:1px solid var(--border);opacity:.55">
      <div style="height:12px;width:60%;background:var(--surface-2);border-radius:4px;margin-bottom:6px"></div>
      <div style="height:11px;width:85%;background:var(--surface-2);border-radius:4px"></div>
    </div>`).join('')}</div>`;
  }
  function _errBlk(msg, what) {
    return `<div style="padding:14px 16px;background:var(--rose-soft);border:1px solid var(--rose-line, var(--rose));color:var(--rose);border-radius:var(--r);font-size:13px;display:flex;justify-content:space-between;align-items:center;gap:12px">
      <span>⚠ ${esc(msg)}</span>
      <button class="btn btn-ghost btn-sm" onclick="__wbxRetry('${what}')">Opnieuw</button>
    </div>`;
  }

  /* ── Registratie ────────────────────────────────────────────────────── */
  window.DFO.VIEWS['wanbetalers/Gesprekken'] = gesprekkenView;
  window.DFO.VIEWS['wanbetalers/Acties']     = actiesView;
  window.DFO.VIEWS['wanbetalers/Overzicht']  = overzichtView;
  window.DFO.VIEWS['wanbetalers/Brieven']    = brievenView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('wanbetalers');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('wanbetalers');
  console.debug('[wanbetalers-v2] v=2 BROK 1 — reads bedraad: Overzicht (wanbetalers-overzicht-list + arrangements-list actief + dunning-settings-get), Acties (dunning-pipeline-actions + pending-actions-list pending), Gesprekken (overzicht-lijst + dunning-call-log-list + wanbetalers-timeline bij drilldown), Brieven (dunning-briefs-list-all). GEEN writes; alle actie-knoppen disabled met "komt in BROK 2". Kantooruren-banner uit dunning-settings-get. Deep-link naar klanten.html-wanbetalers-tab voor per-klant tijdlijn/notitie.');
})();
