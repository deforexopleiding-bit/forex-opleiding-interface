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
    // v=3 BROK 2: write-state.
    briefBusy:    {},            // brief_id → true (race-guard per brief-write)
    brSelected:   {},            // brief_id → true (bulk-select)
    callForm:     {},            // customer_id → { outcome, note, callback_at, saving, error }
    noteForm:     {},            // customer_id → { body, saving, savedAt, error }
    stageBusy:    {},            // customer_id → true (fase-mutatie in flight)
    // v=4 BROK 3: TL-mutaties + arrangements + bulk-workflow.
    paBusy:       {},            // pending_action id → true (race-guard)
    arrBusy:      {},            // arrangement id → true
    ovSelected:   {},            // customer_id → true (overzicht bulk-select)
    bulkBusy:     false,         // bulk-start in flight
  };
  const NOOP_B3 = () => { try { window.KV && window.KV.toast && window.KV.toast('Komt in BROK 3 (approve/reject + arrangement + bulk) — nog niet actief.'); } catch (_) {} };
  window.__wbxNoopB3 = NOOP_B3;
  function _toast(msg, tone) { try { window.KV && window.KV.toast && window.KV.toast(msg, tone ? { tone } : undefined); } catch (_) {} }

  // v=6 FIX 7 — RBAC: lazy-load window.RBAC (uit /modules/shared/permissions.js).
  // Boot in de first-view-render. Cache-vlaggen per permissie zodat de
  // knop-rendering niet elke frame een sync-check hoeft te doen.
  const _rbac = { loaded: false, loading: false,
    // Permission-mapping (bevestigd door endpoints in api/ recon):
    canBrief:    false, // finance.incasso.manage
    canExecute:  false, // finance.dunning.execute
    canPropose:  false, // finance.arrangements.propose
    canApprove:  false, // finance.arrangements.approve
  };
  async function _ensureRbac() {
    if (_rbac.loaded || _rbac.loading) return;
    _rbac.loading = true;
    try {
      if (window.RBAC && typeof window.RBAC.ensurePermissionsLoaded === 'function') {
        await window.RBAC.ensurePermissionsLoaded();
        const can = (k) => !!(window.RBAC.canSync && window.RBAC.canSync(k));
        _rbac.canBrief   = can('finance.incasso.manage');
        _rbac.canExecute = can('finance.dunning.execute');
        _rbac.canPropose = can('finance.arrangements.propose');
        _rbac.canApprove = can('finance.arrangements.approve');
      } else {
        // Fallback: RBAC-lib niet geladen → laat alle knoppen zichtbaar,
        // server-side gate blijft de harde stop (403 toast bij poging).
        _rbac.canBrief = _rbac.canExecute = _rbac.canPropose = _rbac.canApprove = true;
      }
    } catch (e) { console.warn('[wanbetalers-v2] RBAC load fail:', e?.message || e); _rbac.canBrief = _rbac.canExecute = _rbac.canPropose = _rbac.canApprove = true; }
    _rbac.loaded = true;
    if (window.DFO?.render) window.DFO.render();
  }
  queueMicrotask(_ensureRbac);

  /* ── Custom confirm-modal (Promise-based, geen native confirm) ───── */
  function _closeConfirmModal() {
    const m = document.getElementById('wbxConfirmRoot');
    if (m) m.remove();
    document.removeEventListener('keydown', _confirmModalKey, true);
  }
  function _confirmModalKey(e) { if (e.key === 'Escape') { e.preventDefault(); _closeConfirmModal(); } }
  function _askConfirm(title, bodyHtml, opts) {
    const okLabel     = esc((opts && opts.okLabel)     || 'Bevestig');
    const cancelLabel = esc((opts && opts.cancelLabel) || 'Annuleren');
    const isDanger    = opts && opts.tone === 'danger';
    const bgVar       = isDanger ? 'var(--rose,#C22B3E)' : 'var(--brand,#0A7490)';
    return new Promise((resolve) => {
      _closeConfirmModal();
      const root = document.createElement('div');
      root.id = 'wbxConfirmRoot';
      root.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(17,23,33,.48);padding:20px';
      root.innerHTML = `<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.32);padding:22px;max-width:520px;width:calc(100vw - 40px);max-height:calc(100vh - 60px);overflow:auto">
        <div style="font-size:15.5px;font-weight:600;margin-bottom:8px">${esc(title)}</div>
        <div style="font-size:13px;color:var(--text-2);line-height:1.55;margin-bottom:18px">${bodyHtml}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="wbxConfirmCancel" class="btn btn-ghost btn-sm">${cancelLabel}</button>
          <button id="wbxConfirmOk" class="btn btn-primary btn-sm" style="background:${bgVar};border-color:${bgVar};color:#fff">${okLabel}</button>
        </div>
      </div>`;
      root.addEventListener('click', (e) => { if (e.target === root) { _closeConfirmModal(); resolve(false); } });
      document.body.appendChild(root);
      document.addEventListener('keydown', _confirmModalKey, true);
      document.getElementById('wbxConfirmCancel').addEventListener('click', () => { _closeConfirmModal(); resolve(false); });
      document.getElementById('wbxConfirmOk').addEventListener('click',    () => { _closeConfirmModal(); resolve(true);  });
    });
  }
  // Typ-to-confirm modal — extra rails voor destructive bulk-writes.
  // Gebruiker moet exact een phrase overtypen voordat de OK-knop enabled
  // wordt. Focus in de input; Esc/backdrop = cancel.
  function _askTypedConfirm(title, bodyHtml, requiredPhrase, opts) {
    const okLabel     = esc((opts && opts.okLabel)     || 'Bevestig');
    const cancelLabel = esc((opts && opts.cancelLabel) || 'Annuleren');
    const bgVar       = 'var(--rose,#C22B3E)';
    return new Promise((resolve) => {
      _closeConfirmModal();
      const root = document.createElement('div');
      root.id = 'wbxConfirmRoot';
      root.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(17,23,33,.55);padding:20px';
      root.innerHTML = `<div style="background:var(--surface);border:2px solid var(--rose,#C22B3E);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.4);padding:22px;max-width:560px;width:calc(100vw - 40px);max-height:calc(100vh - 60px);overflow:auto">
        <div style="font-size:15.5px;font-weight:600;margin-bottom:8px;color:var(--rose)">${esc(title)}</div>
        <div style="font-size:13px;color:var(--text-2);line-height:1.55;margin-bottom:14px">${bodyHtml}</div>
        <div style="margin-bottom:14px">
          <div style="font-size:11.5px;color:var(--text-3);margin-bottom:5px">Typ letterlijk om te bevestigen:</div>
          <div style="padding:8px 11px;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;font-family:'IBM Plex Mono',monospace;font-size:13px;margin-bottom:8px;user-select:all">${esc(requiredPhrase)}</div>
          <input id="wbxTypedInput" type="text" autocomplete="off" spellcheck="false"
            style="width:100%;padding:9px 11px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:13px;outline:none;box-sizing:border-box" placeholder="Typ hier…" />
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="wbxConfirmCancel" class="btn btn-ghost btn-sm">${cancelLabel}</button>
          <button id="wbxConfirmOk" class="btn btn-primary btn-sm" disabled style="background:${bgVar};border-color:${bgVar};color:#fff;opacity:.5;cursor:not-allowed">${okLabel}</button>
        </div>
      </div>`;
      // v=6 FIX 5: GEEN backdrop-dismiss op typ-to-confirm — te makkelijk
      // om per ongeluk weg te klikken vlak vóór START. Alleen Cancel / Esc.
      document.body.appendChild(root);
      document.addEventListener('keydown', _confirmModalKey, true);
      const inp = document.getElementById('wbxTypedInput');
      const okBtn = document.getElementById('wbxConfirmOk');
      setTimeout(() => inp && inp.focus(), 20);
      inp.addEventListener('input', () => {
        const match = String(inp.value || '') === requiredPhrase;
        okBtn.disabled = !match;
        okBtn.style.opacity = match ? '1' : '.5';
        okBtn.style.cursor  = match ? 'pointer' : 'not-allowed';
      });
      document.getElementById('wbxConfirmCancel').addEventListener('click', () => { _closeConfirmModal(); resolve(false); });
      okBtn.addEventListener('click', () => { if (String(inp.value || '') === requiredPhrase) { _closeConfirmModal(); resolve(true); } });
    });
  }
  // Reason-prompt modal — Promise<string|null>.
  function _askReason(title, hint, opts) {
    const okLabel = esc((opts && opts.okLabel) || 'OK');
    return new Promise((resolve) => {
      _closeConfirmModal();
      const root = document.createElement('div');
      root.id = 'wbxConfirmRoot';
      root.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(17,23,33,.48);padding:20px';
      root.innerHTML = `<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.32);padding:22px;max-width:520px;width:calc(100vw - 40px)">
        <div style="font-size:15.5px;font-weight:600;margin-bottom:8px">${esc(title)}</div>
        <div style="font-size:12.5px;color:var(--text-3);margin-bottom:10px">${esc(hint || '')}</div>
        <textarea id="wbxReasonInput" style="width:100%;min-height:80px;padding:9px 11px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:13px;resize:vertical;outline:none;box-sizing:border-box" placeholder="Reden…"></textarea>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
          <button id="wbxReasonCancel" class="btn btn-ghost btn-sm">Annuleren</button>
          <button id="wbxReasonOk" class="btn btn-primary btn-sm" style="background:var(--brand,#0A7490);border-color:var(--brand,#0A7490);color:#fff">${okLabel}</button>
        </div>
      </div>`;
      root.addEventListener('click', (e) => { if (e.target === root) { _closeConfirmModal(); resolve(null); } });
      document.body.appendChild(root);
      document.addEventListener('keydown', _confirmModalKey, true);
      const ta = document.getElementById('wbxReasonInput');
      setTimeout(() => ta && ta.focus(), 20);
      document.getElementById('wbxReasonCancel').addEventListener('click', () => { _closeConfirmModal(); resolve(null); });
      document.getElementById('wbxReasonOk').addEventListener('click', () => {
        const v = String(ta.value || '').trim();
        _closeConfirmModal(); resolve(v || null);
      });
    });
  }

  // Shared POST-helper: authenticated fetch met 20s timeout, non-throwing.
  async function apiPost(url, body) {
    try {
      const token = await (window.AuthShared && window.AuthShared.getAccessToken ? window.AuthShared.getAccessToken() : Promise.resolve(null));
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 20000);
      let resp;
      try {
        resp = await fetch(url, { method: 'POST', headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
      } finally { clearTimeout(to); }
      let j = null; try { j = await resp.json(); } catch (_) {}
      return { ok: resp.ok, status: resp.status, json: j, error: resp.ok ? null : ((j && (j.error || j.message)) || ('HTTP ' + resp.status)) };
    } catch (e) {
      return { ok: false, status: 0, json: null, error: (e && e.message) || 'netwerkfout' };
    }
  }

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
  // v=6 FIX 4: dedupe — _fetchArrangements consumeert nu de gedeelde
  // _arrLive.items en bouwt daaruit de byCust-map. Voorkomt de 6-vs-8-
  // inconsistentie (twee aparte fetches met verschillende limits).
  async function _fetchArrangements() {
    const st = _live.arrangements;
    if (st.loading || st.fetched) return;
    st.loading = true; st.error = null;
    // Reuse de _arrLive-fetch als bron van waarheid.
    if (!_arrLive.fetched && !_arrLive.loading) await _fetchArrangementsList('ACTIEF');
    // Als _arrLive nog loading is: wacht met een simpele poll (max 8s).
    let waited = 0;
    while (_arrLive.loading && waited < 8000) { await new Promise(r => setTimeout(r, 100)); waited += 100; }
    st.loading = false; st.fetched = true;
    if (_arrLive.error) { st.error = _arrLive.error; return; }
    const items = asArr(_arrLive.items);
    // Dedup op arrangement-id (verdedigt tegen dubbele rows in server-response).
    const seenIds = new Set();
    const map = {};
    for (const a of items) {
      if (seenIds.has(a.id)) continue;
      seenIds.add(a.id);
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

  /* ── BROK 2 WRITE-HANDLERS ────────────────────────────────────────── */

  // ── Brieven: mail-verzenden (ECHT bericht) ─────────────────────────
  window.__wbxBriefEmail = async (brief_id) => {
    if (!_rbac.canBrief) { _toast('Geen rechten (finance.incasso.manage).', 'error'); return; }
    if (!brief_id || _ui.briefBusy[brief_id]) return;
    const brief = asArr(_live.briefs.items).find((b) => String(b.id) === String(brief_id));
    if (!brief) return;
    const name  = brief.customer_name || brief.customer?.name || 'Onbekend';
    const email = brief.customer_email || brief.customer?.email || '';
    const kind  = brief.brief_type || brief.type || 'brief';
    const bodyHtml = `
      <div style="font-size:12.5px;color:var(--text-3);margin-bottom:6px">Ontvanger</div>
      <div style="padding:10px 12px;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;margin-bottom:12px">
        <div style="font-weight:500">${esc(name)}</div>
        <div style="font-size:11.5px;color:var(--text-3)">${esc(email || '(geen e-mailadres op klant — server valt terug op default)')}</div>
      </div>
      <div style="margin-bottom:10px;color:var(--text-2)">Type: <b>${esc(kind)}</b>. De <b>bewaarde PDF</b> wordt als bijlage meegestuurd — geen nieuwe generatie.</div>
      <div style="padding:9px 12px;background:var(--amber-soft);color:var(--amber);border-radius:6px;font-size:12px;line-height:1.5">
        ⚠ ECHTE mail. Handmatige brief-verzending vertrekt DIRECT — deze omzeilt de kantooruren-wachtrij van de motor.
      </div>`;
    const ok = await _askConfirm('Brief per e-mail versturen?', bodyHtml, { okLabel: 'Ja, verstuur', cancelLabel: 'Annuleren' });
    if (!ok) return;
    _ui.briefBusy[brief_id] = true; if (window.DFO?.render) window.DFO.render();
    const r = await apiPost('/api/dunning-brief-email-send', { brief_id });
    _ui.briefBusy[brief_id] = false;
    if (!r.ok) {
      _toast('Verzenden faalde: ' + (r.error || 'onbekende fout'), 'error');
      if (window.DFO?.render) window.DFO.render();
      return;
    }
    // Optimistic update: markeer als sent (server geeft sent_at terug).
    const saved = r.json || {};
    const listRow = asArr(_live.briefs.items).find((b) => String(b.id) === String(brief_id));
    if (listRow) {
      listRow.sent_at = saved.sent_at || new Date().toISOString();
      listRow.sent_via = 'email';
      if (saved.sent_to_email) listRow.sent_to_email = saved.sent_to_email;
    }
    _toast('Brief verstuurd naar ' + (saved.sent_to_email || email || name), 'success');
    if (window.DFO?.render) window.DFO.render();
  };

  // ── Brieven: markeer per post verstuurd ────────────────────────────
  window.__wbxBriefMarkPost = async (brief_id) => {
    if (!_rbac.canBrief) { _toast('Geen rechten (finance.incasso.manage).', 'error'); return; }
    if (!brief_id || _ui.briefBusy[brief_id]) return;
    const brief = asArr(_live.briefs.items).find((b) => String(b.id) === String(brief_id));
    if (!brief) return;
    const name  = brief.customer_name || 'Onbekend';
    const ok = await _askConfirm(
      'Markeer als per post verstuurd?',
      `Voor <strong>${esc(name)}</strong> markeer je de brief als handmatig per post verstuurd. Er wordt niets naar de klant gestuurd; dit is puur een status-mutatie.`,
      { okLabel: 'Ja, markeer' }
    );
    if (!ok) return;
    _ui.briefBusy[brief_id] = true; if (window.DFO?.render) window.DFO.render();
    const r = await apiPost('/api/dunning-brief-mark-post', { brief_id });
    _ui.briefBusy[brief_id] = false;
    if (!r.ok) { _toast('Kon niet markeren: ' + (r.error || 'onbekend'), 'error'); if (window.DFO?.render) window.DFO.render(); return; }
    const listRow = asArr(_live.briefs.items).find((b) => String(b.id) === String(brief_id));
    if (listRow) { listRow.sent_at = new Date().toISOString(); listRow.sent_via = 'post'; }
    _toast('Gemarkeerd als per post verstuurd.', 'success');
    if (window.DFO?.render) window.DFO.render();
  };

  // ── Brieven: verwijderen (brief-row + PDF-storage) ─────────────────
  window.__wbxBriefDelete = async (brief_id) => {
    if (!_rbac.canBrief) { _toast('Geen rechten (finance.incasso.manage).', 'error'); return; }
    if (!brief_id || _ui.briefBusy[brief_id]) return;
    const brief = asArr(_live.briefs.items).find((b) => String(b.id) === String(brief_id));
    if (!brief) return;
    const name = brief.customer_name || 'Onbekend';
    const ok = await _askConfirm(
      'Brief verwijderen?',
      `Voor <strong>${esc(name)}</strong> verwijder je de brief én de bijbehorende PDF permanent. Dit is niet ongedaan te maken.`,
      { okLabel: 'Ja, verwijder', cancelLabel: 'Annuleren', tone: 'danger' }
    );
    if (!ok) return;
    _ui.briefBusy[brief_id] = true; if (window.DFO?.render) window.DFO.render();
    const r = await apiPost('/api/dunning-brief-delete', { brief_id });
    _ui.briefBusy[brief_id] = false;
    if (!r.ok) { _toast('Verwijderen faalde: ' + (r.error || 'onbekend'), 'error'); if (window.DFO?.render) window.DFO.render(); return; }
    // Optimistic: uit lijst verwijderen.
    _live.briefs.items = asArr(_live.briefs.items).filter((b) => String(b.id) !== String(brief_id));
    delete _ui.brSelected[brief_id];
    _toast('Brief verwijderd.', 'success');
    if (window.DFO?.render) window.DFO.render();
  };

  // ── Brieven: bulk mark-verstuurd + bulk-print ──────────────────────
  window.__wbxBriefToggleSel = (brief_id) => {
    _ui.brSelected[brief_id] = !_ui.brSelected[brief_id];
    if (!_ui.brSelected[brief_id]) delete _ui.brSelected[brief_id];
    if (window.DFO?.render) window.DFO.render();
  };
  window.__wbxBriefClearSel = () => { _ui.brSelected = {}; if (window.DFO?.render) window.DFO.render(); };
  function _selBriefIds() { return Object.keys(_ui.brSelected).filter((k) => _ui.brSelected[k]); }

  window.__wbxBriefBulkMarkSent = async () => {
    if (!_rbac.canBrief) { _toast('Geen rechten (finance.incasso.manage).', 'error'); return; }
    const ids = _selBriefIds();
    if (!ids.length) return;
    const ok = await _askConfirm(
      'Bulk markeer als verstuurd',
      `Je markeert <strong>${ids.length}</strong> brie${ids.length === 1 ? 'f' : 'ven'} als handmatig verstuurd. Geen e-mail naar klanten — puur status-mutatie.`,
      { okLabel: 'Ja, markeer ' + ids.length }
    );
    if (!ok) return;
    const r = await apiPost('/api/dunning-briefs-bulk-mark-sent', { brief_ids: ids });
    if (!r.ok) { _toast('Bulk markeren faalde: ' + (r.error || 'onbekend'), 'error'); return; }
    for (const id of ids) {
      const b = asArr(_live.briefs.items).find((x) => String(x.id) === String(id));
      if (b) { b.sent_at = new Date().toISOString(); b.sent_via = b.sent_via || 'bulk'; }
    }
    _ui.brSelected = {};
    _toast(`Gemarkeerd als verstuurd: ${ids.length} brief${ids.length === 1 ? '' : 'ven'}.`, 'success');
    if (window.DFO?.render) window.DFO.render();
  };
  // v=6 FIX 8: PDF-preview fallback wanneer download_url mist.
  window.__wbxBriefPreview = async (brief_id) => {
    if (!brief_id) return;
    if (!_rbac.canBrief) { _toast('Geen rechten (finance.incasso.manage).', 'error'); return; }
    try {
      const token = await (window.AuthShared && window.AuthShared.getAccessToken ? window.AuthShared.getAccessToken() : Promise.resolve(null));
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      const resp = await fetch('/api/wanbetalers-brief-pdf?preview=1', {
        method: 'POST', headers, body: JSON.stringify({ brief_id }),
      });
      if (!resp.ok) { _toast('Preview faalde: HTTP ' + resp.status, 'error'); return; }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { _toast('Preview netwerkfout: ' + (e?.message || 'onbekend'), 'error'); }
  };

  window.__wbxBriefBulkPrint = async () => {
    if (!_rbac.canBrief) { _toast('Geen rechten (finance.incasso.manage).', 'error'); return; }
    const ids = _selBriefIds();
    if (!ids.length) return;
    const ok = await _askConfirm(
      'Bulk-print PDF-bundel',
      `Er wordt een gebundelde PDF gedownload met <strong>${ids.length}</strong> brie${ids.length === 1 ? 'f' : 'ven'}. Geen mailing.`,
      { okLabel: 'Ja, download' }
    );
    if (!ok) return;
    // Deze endpoint returnt een PDF-blob → open in nieuwe tab i.p.v. json-parse.
    try {
      const token = await (window.AuthShared && window.AuthShared.getAccessToken ? window.AuthShared.getAccessToken() : Promise.resolve(null));
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      const resp = await fetch('/api/dunning-briefs-bulk-print', { method: 'POST', headers, body: JSON.stringify({ brief_ids: ids }) });
      if (!resp.ok) { _toast('Bulk-print faalde: HTTP ' + resp.status, 'error'); return; }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      _toast('PDF-bundel gedownload.', 'success');
    } catch (e) { _toast('Bulk-print netwerkfout: ' + (e?.message || 'onbekend'), 'error'); }
  };

  // ── Gesprekken: belpoging loggen ───────────────────────────────────
  function _callFormState(cid) {
    if (!_ui.callForm[cid]) _ui.callForm[cid] = { outcome: '', note: '', callback_at: '', saving: false, error: null };
    return _ui.callForm[cid];
  }
  const CALL_OUTCOMES = [
    ['no_answer',        'Geen gehoor'],
    ['voicemail',        'Voicemail'],
    ['callback',         'Terugbelafspraak'],
    ['payment_promise',  'Betaal-toezegging'],
    ['payment_plan',     'Betalingsregeling besproken'],
    ['refused',          'Weigert'],
    ['wrong_number',     'Verkeerd nummer'],
    ['paid_during_call', 'Betaald tijdens gesprek'],
  ];
  window.__wbxCallSetOutcome = (cid, val) => {
    const f = _callFormState(cid); f.outcome = String(val || ''); f.error = null;
    _repaintGspDetail();
  };
  window.__wbxCallSetNote = (cid, val) => {
    const f = _callFormState(cid); f.note = String(val || ''); f.error = null;
    // state-only, geen render (textarea focus behouden). Save-btn-toggle
    // via _updateCallSaveBtn.
    _updateCallSaveBtn(cid);
  };
  window.__wbxCallSetCallbackAt = (cid, val) => {
    const f = _callFormState(cid); f.callback_at = String(val || ''); f.error = null;
    _updateCallSaveBtn(cid);
  };
  function _callIsSaveable(f) {
    if (!f || !f.outcome) return false;
    // Server-guard spiegelen: callback → callback_at verplicht.
    if (f.outcome === 'callback' && !String(f.callback_at || '').trim()) return false;
    return true;
  }
  // BROK 9 (v=14, 2026-08-19): surgical err-row update. Voorheen wisten
  // __wbxCallSet{Outcome,Note,CallbackAt} f.error=null maar renderden alleen
  // de save-btn — de foutregel bleef staan tot next full render. Nu: clear
  // wbxCallErr_<cid> innerHTML direct bij state-clear.
  function _updateCallErrRow(cid) {
    const el = document.getElementById('wbxCallErr_' + cid);
    if (!el) return;
    const f = _callFormState(cid);
    el.innerHTML = f.error
      ? `<div style="padding:8px 11px;background:var(--rose-soft);color:var(--rose);border-radius:var(--r-sm);font-size:12px">⚠ ${esc(f.error)}</div>`
      : '';
  }
  function _updateCallSaveBtn(cid) {
    _updateCallErrRow(cid);
    const btn = document.getElementById('wbxCallSaveBtn_' + cid);
    if (!btn) return;
    const f = _callFormState(cid);
    const canSave = _callIsSaveable(f);
    const disabled = !!f.saving || !canSave;
    btn.disabled = disabled;
    btn.textContent = f.saving ? 'Opslaan…' : 'Log belpoging';
    btn.title = f.saving ? '' : (canSave ? '' : (f.outcome === 'callback' ? 'Bij terugbelafspraak: datum/tijd verplicht' : 'Kies eerst een uitkomst'));
    btn.style.opacity = disabled ? '.55' : '1';
    btn.style.cursor  = disabled ? 'not-allowed' : 'pointer';
  }
  window.__wbxCallSave = async (cid, pending_action_id) => {
    if (!_rbac.canExecute) { _toast('Geen rechten (finance.dunning.execute).', 'error'); return; }
    const f = _callFormState(cid);
    if (f.saving) return;
    if (!_callIsSaveable(f)) return;
    // v=6 FIX 1 URGENT: confirm-modal ALTIJD vóór de POST. Voorheen was
    // 'ie conditioneel (alleen bij pending_action_id of payment_promise/
    // paid_during_call) → een simpele klik op 'Log belpoging' bij no_answer/
    // voicemail/callback etc. schreef direct weg. Nu: iedere save vraagt
    // bevestiging met klant + uitkomst + optionele terugbeltijd.
    const outcomeLabel = (CALL_OUTCOMES.find(x => x[0] === f.outcome) || [])[1] || f.outcome;
    const rows = asArr(_live.overzicht.items);
    const row = rows.find((x) => String(x.customer_id || x.id) === String(cid));
    const custName = row ? (row.customer_name || row.name || 'klant') : 'klant';
    let extra = '';
    if (pending_action_id) extra = '<div style="margin-top:10px;padding:9px 12px;background:var(--amber-soft);color:var(--amber);border-radius:6px;font-size:12px;line-height:1.5">⚠ Gekoppeld aan open MANUAL_FOLLOWUP-taak → status wordt <b>PENDING → EXECUTED</b>, motor tikt door.</div>';
    else if (f.outcome === 'payment_promise' || f.outcome === 'paid_during_call') extra = '<div style="margin-top:10px;padding:9px 12px;background:var(--emerald-soft);color:var(--emerald);border-radius:6px;font-size:12px">Wordt geregistreerd; geen bericht naar klant.</div>';
    const cbLine = f.outcome === 'callback' && f.callback_at
      ? `<div style="margin-top:4px"><b>Terugbellen:</b> ${esc(_fmtDateTime(f.callback_at))}</div>`
      : '';
    const noteLine = f.note && f.note.trim()
      ? `<div style="margin-top:4px;padding:8px 10px;background:var(--surface-2);border-radius:6px;font-size:12px;white-space:pre-wrap">${esc(f.note.trim())}</div>`
      : '';
    const confirmed = await _askConfirm(
      'Belpoging loggen?',
      `<div><b>Klant:</b> ${esc(custName)}</div>
       <div><b>Uitkomst:</b> ${esc(outcomeLabel)}</div>
       ${cbLine}${noteLine}${extra}`,
      { okLabel: 'Ja, log' }
    );
    if (!confirmed) return;
    f.saving = true; _updateCallSaveBtn(cid);
    const payload = {
      customer_id: String(cid),
      outcome: f.outcome,
    };
    if (f.note && f.note.trim()) payload.note = f.note.trim();
    if (f.outcome === 'callback' && f.callback_at) payload.callback_at = f.callback_at;
    if (pending_action_id) payload.pending_action_id = pending_action_id;
    const r = await apiPost('/api/dunning-call-log-create', payload);
    f.saving = false;
    if (!r.ok) { f.error = r.error || 'Loggen faalde'; _repaintGspDetail(); return; }
    // Reset form + refresh call-log + timeline.
    _ui.callForm[cid] = { outcome: '', note: '', callback_at: '', saving: false, error: null };
    delete _live.callLog.byCust[cid];
    delete _live.timeline.byCust[cid];
    _fetchCallLog(cid);
    _fetchTimeline(cid);
    _toast('Belpoging gelogd.', 'success');
    _repaintGspDetail();
  };

  // ── Gesprekken: notitie op klant ───────────────────────────────────
  function _noteFormState(cid) {
    if (!_ui.noteForm[cid]) _ui.noteForm[cid] = { body: '', saving: false, savedAt: null, error: null };
    return _ui.noteForm[cid];
  }
  window.__wbxNoteSetBody = (cid, val) => {
    const f = _noteFormState(cid); f.body = String(val || ''); f.error = null; f.savedAt = null;
    _updateNoteSaveBtn(cid);
    const saved = document.getElementById('wbxNoteSaved_' + cid);
    if (saved && saved.style.display !== 'none') saved.style.display = 'none';
  };
  function _updateNoteSaveBtn(cid) {
    const btn = document.getElementById('wbxNoteSaveBtn_' + cid);
    if (!btn) return;
    const f = _noteFormState(cid);
    const canSave = !!(f.body && f.body.trim()) && !f.saving;
    btn.disabled = !canSave;
    btn.textContent = f.saving ? 'Opslaan…' : 'Notitie opslaan';
    btn.style.opacity = canSave ? '1' : '.55';
    btn.style.cursor  = canSave ? 'pointer' : 'not-allowed';
  }
  window.__wbxNoteSave = async (cid) => {
    if (!_rbac.canExecute) { _toast('Geen rechten (finance.dunning.execute).', 'error'); return; }
    const f = _noteFormState(cid);
    if (f.saving || !f.body || !f.body.trim()) return;
    f.saving = true; _updateNoteSaveBtn(cid);
    const r = await apiPost('/api/dunning-pipeline-add-log', { customer_id: String(cid), body: f.body.trim() });
    f.saving = false;
    if (!r.ok) { f.error = r.error || 'Notitie opslaan faalde'; _repaintGspDetail(); return; }
    f.body = ''; f.savedAt = new Date().toISOString();
    delete _live.timeline.byCust[cid];
    _fetchTimeline(cid);
    _repaintGspDetail();
    _toast('Notitie opgeslagen.', 'success');
    setTimeout(() => {
      const el = document.getElementById('wbxNoteSaved_' + cid);
      if (el) el.style.display = 'none';
    }, 3000);
  };

  // ── Acties: fase zetten ───────────────────────────────────────────
  const PIPELINE_STAGES = [
    ['nieuw',           'Nieuw'],
    ['aangemaand',      'Aangemaand'],
    ['in_gesprek',      'In gesprek'],
    ['regeling',        'Regeling'],
    ['brief_verstuurd', 'Brief verstuurd'],
    ['incasso',         'Incasso'],
    ['afschrijven',     'Afschrijven'],
    ['opgelost',        'Opgelost'],
  ];
  window.__wbxSetStage = async (cid, newStage) => {
    if (!_rbac.canExecute) { _toast('Geen rechten (finance.dunning.execute).', 'error'); return; }
    if (!cid || !newStage) return;
    if (_ui.stageBusy[cid]) return;
    const stageLabel = (PIPELINE_STAGES.find(s => s[0] === newStage) || [])[1] || newStage;
    const isTerminal = newStage === 'opgelost' || newStage === 'afschrijven';
    const ok = await _askConfirm(
      `Fase wijzigen naar "${stageLabel}"?`,
      `De pipeline-fase wordt bijgewerkt${isTerminal ? ' naar een <strong>terminale</strong> fase — de dunning-motor stopt met deze klant' : ''}. Actie wordt in de audit-log opgenomen.`,
      { okLabel: 'Ja, wijzig', tone: isTerminal ? 'danger' : undefined }
    );
    if (!ok) return;
    _ui.stageBusy[cid] = true;
    // BROK 8 minor: forceer render direct na busy-set zodat de dropdown
    // meteen z'n disabled-attribuut krijgt (voorheen 1 tick vertraging).
    try { window.DFO?.render?.(); } catch (_) {}
    // BROK 9 FIX: server verwacht 'stage_slug' (api/dunning-pipeline-set-stage.js:28),
    // niet 'stage'. Voorheen kreeg elke fase-mutatie 400 "stage_slug vereist"
    // en werd de fase server-side niet gewijzigd (alleen UI-side optimistisch).
    const r = await apiPost('/api/dunning-pipeline-set-stage', { customer_id: String(cid), stage_slug: newStage });
    _ui.stageBusy[cid] = false;
    if (!r.ok) { _toast('Fase-mutatie faalde: ' + (r.error || 'onbekend'), 'error'); return; }
    // Optimistic: update de row in overzicht + refresh timeline.
    const row = asArr(_live.overzicht.items).find((x) => String(x.customer_id || x.id) === String(cid));
    if (row) { row.stage_slug = newStage; row.stage_label = stageLabel; }
    delete _live.timeline.byCust[cid];
    if (_ui.gspSelectedId === cid) _fetchTimeline(cid);
    _toast(`Fase gezet: ${stageLabel}.`, 'success');
    if (window.DFO?.render) window.DFO.render();
  };

  /* ── BROK 3 WRITE-HANDLERS — pending-actions ─────────────────────── */

  window.__wbxPaApprove = async (action_id) => {
    if (!_rbac.canApprove) { _toast('Geen rechten (finance.arrangements.approve).', 'error'); return; }
    if (!action_id || _ui.paBusy[action_id]) return;
    const a = asArr(_live.pendingActs.items).find((x) => String(x.id) === String(action_id));
    if (!a) return;
    const customer = (a.customer && a.customer.name) || a.customer_name || (a.payload && a.payload.customer_name) || a.customer_id || 'onbekend';
    const type = a.action_type || a.type || 'actie';
    const isTlAction = String(type).startsWith('TL_');
    const ok = await _askConfirm(
      isTlAction ? 'TeamLeader-mutatie uitvoeren?' : 'Actie goedkeuren?',
      isTlAction
        ? `<div style="margin-bottom:10px">Dit voert de <strong>ECHTE TeamLeader-mutatie</strong> uit:</div>
           <div style="padding:10px 12px;background:var(--surface-2);border-radius:6px;margin-bottom:12px">
             <div><b>Klant:</b> ${esc(customer)}</div>
             <div><b>Actie:</b> ${esc(type)}</div>
           </div>
           <div style="padding:9px 12px;background:var(--amber-soft);color:var(--amber);border-radius:6px;font-size:12px;line-height:1.5">
             ⚠ Dit muteert facturen/abonnementen in TeamLeader. Niet terug te draaien vanuit dit systeem.
           </div>`
        : `Actie voor <b>${esc(customer)}</b> (${esc(type)}) wordt goedgekeurd en uitgevoerd door de motor-executor.`,
      { okLabel: 'Ja, voer uit' }
    );
    if (!ok) return;
    _ui.paBusy[action_id] = true; if (window.DFO?.render) window.DFO.render();
    const r = await apiPost('/api/pending-actions-approve', { id: action_id });
    _ui.paBusy[action_id] = false;
    if (!r.ok) { _toast('Approve faalde: ' + (r.error || 'onbekend'), 'error'); if (window.DFO?.render) window.DFO.render(); return; }
    // Optimistic: verwijder uit pending-lijst.
    _live.pendingActs.items = asArr(_live.pendingActs.items).filter((x) => String(x.id) !== String(action_id));
    _toast('Actie goedgekeurd — motor voert uit.', 'success');
    if (window.DFO?.render) window.DFO.render();
  };

  window.__wbxPaReject = async (action_id) => {
    if (!_rbac.canApprove) { _toast('Geen rechten (finance.arrangements.approve).', 'error'); return; }
    if (!action_id || _ui.paBusy[action_id]) return;
    const a = asArr(_live.pendingActs.items).find((x) => String(x.id) === String(action_id));
    if (!a) return;
    const customer = (a.customer && a.customer.name) || a.customer_name || a.customer_id || 'onbekend';
    const reason = await _askReason(
      `Actie afwijzen — ${customer}`,
      'Waarom wijs je deze actie af? (verplicht — komt in de audit-log en op de pending_action).',
      { okLabel: 'Afwijzen' }
    );
    if (!reason) return;
    _ui.paBusy[action_id] = true; if (window.DFO?.render) window.DFO.render();
    const r = await apiPost('/api/pending-actions-reject', { id: action_id, rejection_reason: reason });
    _ui.paBusy[action_id] = false;
    if (!r.ok) { _toast('Reject faalde: ' + (r.error || 'onbekend'), 'error'); if (window.DFO?.render) window.DFO.render(); return; }
    _live.pendingActs.items = asArr(_live.pendingActs.items).filter((x) => String(x.id) !== String(action_id));
    _toast('Actie afgewezen.', 'success');
    if (window.DFO?.render) window.DFO.render();
  };

  window.__wbxPaMarkExecuted = async (action_id) => {
    if (!_rbac.canApprove) { _toast('Geen rechten (finance.arrangements.approve).', 'error'); return; }
    if (!action_id || _ui.paBusy[action_id]) return;
    const a = asArr(_live.pendingActs.items).find((x) => String(x.id) === String(action_id));
    if (!a) return;
    const type = a.action_type || a.type || 'actie';
    const isTlAction = String(type).startsWith('TL_');
    const ok = await _askConfirm(
      'Handmatig markeren als uitgevoerd?',
      `<div style="margin-bottom:10px">Actie: <b>${esc(type)}</b>.</div>
       <div style="padding:9px 12px;background:var(--amber-soft);color:var(--amber);border-radius:6px;font-size:12px;line-height:1.5">
         ⚠ Gebruik dit alleen als je de ${isTlAction ? 'TeamLeader-mutatie' : 'actie'} <b>zelf al hebt uitgevoerd</b>
         buiten dit systeem om. Er wordt NIETS nieuws gemuteerd — alleen de status flipt naar EXECUTED en
         de motor tikt door naar de volgende stap.
       </div>`,
      { okLabel: 'Ja, markeer' }
    );
    if (!ok) return;
    _ui.paBusy[action_id] = true; if (window.DFO?.render) window.DFO.render();
    const r = await apiPost('/api/pending-actions-mark-executed', { id: action_id });
    _ui.paBusy[action_id] = false;
    if (!r.ok) { _toast('Markeren faalde: ' + (r.error || 'onbekend'), 'error'); if (window.DFO?.render) window.DFO.render(); return; }
    _live.pendingActs.items = asArr(_live.pendingActs.items).filter((x) => String(x.id) !== String(action_id));
    _toast('Actie gemarkeerd als uitgevoerd.', 'success');
    if (window.DFO?.render) window.DFO.render();
  };

  window.__wbxPaMarkNotExecuted = async (action_id) => {
    if (!action_id || _ui.paBusy[action_id]) return;
    const reason = await _askReason(
      'Terugzetten naar approved',
      'Waarom werd de actie NIET uitgevoerd? (optioneel — helpt bij audit).',
      { okLabel: 'Terugzetten' }
    );
    // reason mag null zijn (endpoint accepteert het).
    _ui.paBusy[action_id] = true;
    const r = await apiPost('/api/pending-actions-mark-not-executed', { id: action_id, reason: reason || undefined });
    _ui.paBusy[action_id] = false;
    if (!r.ok) { _toast('Terugzetten faalde: ' + (r.error || 'onbekend'), 'error'); return; }
    _toast('Terug naar approved.', 'success');
    _live.pendingActs.fetched = false; _fetchPendingActs();
  };

  window.__wbxPaRestore = async (action_id) => {
    if (!action_id || _ui.paBusy[action_id]) return;
    const reason = await _askReason(
      'Herstel geannuleerde actie',
      'Waarom herstel je deze actie? (optioneel).',
      { okLabel: 'Herstel' }
    );
    _ui.paBusy[action_id] = true;
    const r = await apiPost('/api/pending-actions-restore', { id: action_id, reason: reason || undefined });
    _ui.paBusy[action_id] = false;
    if (!r.ok) { _toast('Restore faalde: ' + (r.error || 'onbekend'), 'error'); return; }
    _toast('Actie hersteld naar approved.', 'success');
    _live.pendingActs.fetched = false; _fetchPendingActs();
  };

  /* ── BROK 3 WRITE-HANDLERS — arrangements ────────────────────────── */

  const ARR_TYPES = [
    ['UITSTEL',          'Uitstel (consolideer + herstart)'],
    ['SPLITSING',        'Splitsing in termijnen'],
    ['ABONNEMENT_PAUZE', 'Abonnement pauzeren'],
    ['ABONNEMENT_STOP',  'Abonnement stoppen'],
    ['KWIJTSCHELDING',   'Kwijtschelding (afboeking)'],
  ];
  const _arrLive = { loading: false, error: null, items: [], fetched: false, _seq: 0 };

  async function _fetchArrangementsList(scope) {
    if (_arrLive.loading) return;
    _arrLive.loading = true; _arrLive.error = null;
    const seq = ++_arrLive._seq;
    const url = '/api/arrangements-list?limit=200' + (scope ? '&status=' + encodeURIComponent(scope) : '');
    const j = await tryFetch('arr-list', url);
    if (seq !== _arrLive._seq) return;
    _arrLive.loading = false; _arrLive.fetched = true;
    if (!j) { _arrLive.error = 'Kon arrangementen niet laden'; }
    else if (j.error) { _arrLive.error = j.error; }
    else { _arrLive.items = asArr(j.items || j.arrangements); }
    if (window.DFO?.render) window.DFO.render();
  }

  window.__wbxArrCancel = async (arrangement_id, arrLabel) => {
    if (!_rbac.canApprove) { _toast('Geen rechten (finance.arrangements.approve).', 'error'); return; }
    if (!arrangement_id || _ui.arrBusy[arrangement_id]) return;
    const ok = await _askConfirm(
      'Arrangement annuleren?',
      `<div style="margin-bottom:10px">${esc(arrLabel || 'Dit arrangement')} wordt geannuleerd.</div>
       <div style="padding:9px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px;line-height:1.5">
         ⚠ Alle openstaande pending_actions bij dit arrangement worden ingetrokken (rejected).
         De dunning-motor gaat weer verder met deze klant zodra de status ACTIEF verlaat.
       </div>`,
      { okLabel: 'Ja, annuleer', tone: 'danger' }
    );
    if (!ok) return;
    _ui.arrBusy[arrangement_id] = true; if (window.DFO?.render) window.DFO.render();
    const r = await apiPost('/api/arrangements-cancel', { id: arrangement_id });
    _ui.arrBusy[arrangement_id] = false;
    if (!r.ok) { _toast('Annuleren faalde: ' + (r.error || 'onbekend'), 'error'); if (window.DFO?.render) window.DFO.render(); return; }
    _arrLive.fetched = false; _fetchArrangementsList('ACTIEF');
    _live.pendingActs.fetched = false; _fetchPendingActs();
    _toast('Arrangement geannuleerd.', 'success');
  };

  // Arrangement propose — modal met type-select + type-specifieke velden.
  // Contract per type (uit api/arrangements-propose.js):
  //   UITSTEL          → { termijnen: 2..60, starts_on?: 'YYYY-MM-DD' }
  //   SPLITSING        → { parts: [{amount, due_date}] } (>=2, sum == invoice.total)
  //   ABONNEMENT_PAUZE → { subscription_id, pause_from, pause_until, reason }
  //   ABONNEMENT_STOP  → { subscription_id, stop_date, reason }
  //   KWIJTSCHELDING   → { write_off_amount, reason }
  const _arrForm = { open: false, customer_id: null, type: 'UITSTEL', invoice_ids: [], rationale: '', details: {}, saving: false, error: null };
  window.__wbxArrPropose = async (customer_id) => {
    const cid = String(customer_id || '');
    // v=6 FIX 6: waarschuw als klant al actief arrangement heeft — server
    // laat 't waarschijnlijk staan maar UX moet dat vóór klik zichtbaar
    // maken (dunning is dan gepauzeerd, nieuwe voorstel kan verwarrend
    // schuiven met de bestaande).
    const arrsMap = _live.arrangements.byCust || {};
    const existing = cid && Array.isArray(arrsMap[cid]) ? arrsMap[cid] : [];
    if (existing.length) {
      const cont = await _askConfirm(
        'Klant heeft al een actief arrangement',
        `Deze klant heeft <b>${existing.length}</b> actief arrangement (dunning gepauzeerd).
         Een nieuw voorstel maken naast een actief arrangement kan verwarrend zijn —
         eerst annuleren of afwikkelen is meestal duidelijker.<br><br>
         Toch doorgaan met een nieuw voorstel?`,
        { okLabel: 'Toch nieuw voorstellen', cancelLabel: 'Annuleren' }
      );
      if (!cont) return;
    }
    _arrForm.open = true;
    _arrForm.customer_id = cid;
    _arrForm.type = 'UITSTEL';
    _arrForm.invoice_ids = [];
    _arrForm.rationale = '';
    _arrForm.details = { termijnen: 3 };
    _arrForm.saving = false; _arrForm.error = null;
    _renderArrModal();
  };
  window.__wbxArrCancelForm = () => { _arrForm.open = false; _closeConfirmModal(); };
  window.__wbxArrSetType = (t) => {
    if (!ARR_TYPES.some(([v]) => v === t)) return;
    _arrForm.type = t;
    // Reset type-specifieke details.
    if (t === 'UITSTEL')         _arrForm.details = { termijnen: 3 };
    if (t === 'SPLITSING')       _arrForm.details = { parts: [{ amount: '', due_date: '' }, { amount: '', due_date: '' }] };
    if (t === 'ABONNEMENT_PAUZE')_arrForm.details = { subscription_id: '', pause_from: '', pause_until: '', reason: '' };
    if (t === 'ABONNEMENT_STOP') _arrForm.details = { subscription_id: '', stop_date: '', reason: '' };
    if (t === 'KWIJTSCHELDING')  _arrForm.details = { write_off_amount: '', reason: '' };
    _renderArrModal();
  };
  window.__wbxArrSetDetail = (key, val) => { _arrForm.details[key] = val; };
  window.__wbxArrSetPart = (idx, field, val) => {
    if (!Array.isArray(_arrForm.details.parts)) _arrForm.details.parts = [];
    while (_arrForm.details.parts.length <= idx) _arrForm.details.parts.push({ amount: '', due_date: '' });
    _arrForm.details.parts[idx][field] = val;
  };
  window.__wbxArrAddPart = () => {
    if (!Array.isArray(_arrForm.details.parts)) _arrForm.details.parts = [];
    _arrForm.details.parts.push({ amount: '', due_date: '' });
    _renderArrModal();
  };
  window.__wbxArrRemovePart = (idx) => {
    if (!Array.isArray(_arrForm.details.parts)) return;
    if (_arrForm.details.parts.length <= 2) { _toast('Minimaal 2 termijnen vereist.', 'warn'); return; }
    _arrForm.details.parts.splice(idx, 1);
    _renderArrModal();
  };
  window.__wbxArrSetRationale = (val) => { _arrForm.rationale = String(val || ''); };
  window.__wbxArrSubmit = async () => {
    if (!_rbac.canPropose) { _toast('Geen rechten (finance.arrangements.propose).', 'error'); return; }
    if (_arrForm.saving) return;
    const t = _arrForm.type;
    const isSubAction = t === 'ABONNEMENT_PAUZE' || t === 'ABONNEMENT_STOP';
    if (!_arrForm.customer_id) { _arrForm.error = 'customer_id ontbreekt'; _renderArrModal(); return; }
    if (!isSubAction && (!_arrForm.invoice_ids || !_arrForm.invoice_ids.length)) {
      _arrForm.error = 'Kies minstens 1 factuur.'; _renderArrModal(); return;
    }
    // Preflight type-validatie (spiegel server-guard).
    const d = _arrForm.details || {};
    if (t === 'UITSTEL') {
      const n = Number(d.termijnen);
      if (!Number.isInteger(n) || n < 2 || n > 60) { _arrForm.error = 'Termijnen: integer 2..60.'; _renderArrModal(); return; }
    }
    if (t === 'SPLITSING') {
      const parts = Array.isArray(d.parts) ? d.parts : [];
      if (parts.length < 2) { _arrForm.error = 'Splitsing: minimaal 2 termijnen.'; _renderArrModal(); return; }
      for (const p of parts) {
        if (!Number(p.amount) || Number(p.amount) <= 0) { _arrForm.error = 'Elk termijn-bedrag > 0.'; _renderArrModal(); return; }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(p.due_date || ''))) { _arrForm.error = 'Elke vervaldatum YYYY-MM-DD.'; _renderArrModal(); return; }
      }
    }
    if (t === 'ABONNEMENT_PAUZE') {
      if (!d.subscription_id) { _arrForm.error = 'subscription_id (uuid) vereist.'; _renderArrModal(); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d.pause_from || ''))) { _arrForm.error = 'pause_from YYYY-MM-DD.'; _renderArrModal(); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d.pause_until || ''))) { _arrForm.error = 'pause_until YYYY-MM-DD.'; _renderArrModal(); return; }
      if (!d.reason) { _arrForm.error = 'reason vereist.'; _renderArrModal(); return; }
    }
    if (t === 'ABONNEMENT_STOP') {
      if (!d.subscription_id) { _arrForm.error = 'subscription_id (uuid) vereist.'; _renderArrModal(); return; }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d.stop_date || ''))) { _arrForm.error = 'stop_date YYYY-MM-DD.'; _renderArrModal(); return; }
      if (!d.reason) { _arrForm.error = 'reason vereist.'; _renderArrModal(); return; }
    }
    if (t === 'KWIJTSCHELDING') {
      if (!Number(d.write_off_amount) || Number(d.write_off_amount) <= 0) { _arrForm.error = 'write_off_amount > 0.'; _renderArrModal(); return; }
      if (!d.reason) { _arrForm.error = 'reason vereist.'; _renderArrModal(); return; }
    }
    // Confirm-samenvatting vóór POST.
    const summary = `<div style="padding:10px 12px;background:var(--surface-2);border-radius:6px;font-size:12.5px;line-height:1.6">
      <div><b>Type:</b> ${esc((ARR_TYPES.find(x => x[0] === t) || [])[1] || t)}</div>
      ${!isSubAction ? `<div><b>Facturen:</b> ${_arrForm.invoice_ids.length}</div>` : ''}
      ${t === 'UITSTEL' ? `<div><b>Termijnen:</b> ${d.termijnen}</div>` : ''}
      ${t === 'SPLITSING' ? `<div><b>Termijnen:</b> ${d.parts.length}</div>` : ''}
      ${t === 'KWIJTSCHELDING' ? `<div><b>Bedrag:</b> ${eur(Number(d.write_off_amount))}</div>` : ''}
    </div>
    <div style="margin-top:10px;padding:9px 12px;background:var(--amber-soft);color:var(--amber);border-radius:6px;font-size:12px;line-height:1.5">
      Dit maakt een <b>payment_arrangement</b> aan + pending_actions per stap. Geen TL-mutatie tot Approve.
    </div>`;
    _closeConfirmModal();
    const ok = await _askConfirm('Arrangement voorstellen?', summary, { okLabel: 'Ja, maak aan' });
    if (!ok) { _renderArrModal(); return; }
    _arrForm.saving = true; _renderArrModal();
    const payload = {
      customer_id: _arrForm.customer_id,
      type: t,
      invoice_ids: isSubAction ? [] : _arrForm.invoice_ids,
      details: d,
      rationale: _arrForm.rationale || '(geen)',
    };
    const r = await apiPost('/api/arrangements-propose', payload);
    _arrForm.saving = false;
    if (!r.ok) { _arrForm.error = r.error || 'Voorstellen faalde'; _renderArrModal(); return; }
    _arrForm.open = false; _closeConfirmModal();
    _arrLive.fetched = false; _fetchArrangementsList('ACTIEF');
    _live.pendingActs.fetched = false; _fetchPendingActs();
    _toast('Arrangement voorgesteld — bekijk pending_actions voor de uitvoerstappen.', 'success');
  };
  window.__wbxArrToggleInvoice = (invoice_id) => {
    const s = new Set(_arrForm.invoice_ids);
    if (s.has(invoice_id)) s.delete(invoice_id); else s.add(invoice_id);
    _arrForm.invoice_ids = Array.from(s);
    _renderArrModal();
  };
  // We laden invoices per customer lazy in de modal.
  const _arrInvoices = { loading: false, byCust: {} };
  async function _fetchInvoicesForCustomer(cid) {
    if (!cid) return;
    if (_arrInvoices.byCust[cid] || _arrInvoices.loading) return;
    _arrInvoices.loading = true;
    const j = await tryFetch('inv:' + cid, '/api/wanbetalers-invoices-list?customer_id=' + encodeURIComponent(cid));
    _arrInvoices.loading = false;
    _arrInvoices.byCust[cid] = j && !j.error ? asArr(j.items || j.invoices) : [];
    _renderArrModal();
  }
  function _renderArrModal() {
    if (!_arrForm.open) { _closeConfirmModal(); return; }
    const cid = _arrForm.customer_id;
    const custRow = asArr(_live.overzicht.items).find((x) => String(x.customer_id || x.id) === String(cid));
    const custName = custRow ? (custRow.customer_name || custRow.name || cid) : cid;
    const t = _arrForm.type;
    const d = _arrForm.details || {};
    const invoices = _arrInvoices.byCust[cid];
    if (!invoices && !_arrInvoices.loading) queueMicrotask(() => _fetchInvoicesForCustomer(cid));
    const isSubAction = t === 'ABONNEMENT_PAUZE' || t === 'ABONNEMENT_STOP';

    const typeChips = ARR_TYPES.map(([v, l]) => {
      const on = _arrForm.type === v;
      return `<button class="chip ${on ? 'on' : ''}" style="font-size:11.5px;padding:4px 10px" onclick="__wbxArrSetType('${v}')">${esc(l)}</button>`;
    }).join('');

    let invoicesBlock = '';
    if (!isSubAction) {
      if (!invoices) {
        invoicesBlock = `<div style="padding:14px;color:var(--text-3);font-size:12.5px;text-align:center">Facturen laden…</div>`;
      } else if (!invoices.length) {
        invoicesBlock = `<div style="padding:14px;color:var(--text-3);font-size:12.5px;text-align:center">Geen openstaande facturen voor deze klant.</div>`;
      } else {
        invoicesBlock = invoices.map((inv) => {
          const iid = inv.id;
          const sel = _arrForm.invoice_ids.includes(iid);
          return `<label style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-bottom:1px solid var(--border);cursor:pointer;font-size:12.5px" onmouseover="this.style.background='var(--surface-2)'" onmouseout="this.style.background='transparent'">
            <input type="checkbox" ${sel ? 'checked' : ''} onchange="__wbxArrToggleInvoice('${esc(iid)}')" style="width:15px;height:15px;cursor:pointer" />
            <span style="flex:1;min-width:0"><span style="font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:var(--text-3)">${esc(inv.invoice_number || iid.slice(0, 8))}</span> · ${esc(inv.description || '')}</span>
            <span class="mono" style="color:var(--amber);font-weight:600">${eur(Number(inv.amount_total || inv.amount || 0))}</span>
          </label>`;
        }).join('');
      }
    }

    let detailsBlock = '';
    if (t === 'UITSTEL') {
      detailsBlock = `<div>
        <div style="font-size:11.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px">Aantal termijnen (2-60)</div>
        <input type="number" min="2" max="60" step="1" value="${esc(String(d.termijnen || 3))}" oninput="__wbxArrSetDetail('termijnen', Number(this.value))" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:13px;outline:none;box-sizing:border-box" />
        <div style="font-size:11px;color:var(--text-3);margin-top:4px">Startdatum optioneel (default = eerstvolgende betaaltermijn).</div>
        <div style="margin-top:6px"><input type="date" value="${esc(d.starts_on || '')}" oninput="__wbxArrSetDetail('starts_on', this.value)" style="padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;outline:none" placeholder="Startdatum" /></div>
      </div>`;
    } else if (t === 'SPLITSING') {
      const parts = Array.isArray(d.parts) ? d.parts : [];
      detailsBlock = `<div>
        <div style="font-size:11.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px">Termijnen (bedrag + vervaldatum)</div>
        ${parts.map((p, i) => `<div style="display:grid;grid-template-columns:1fr 1fr auto;gap:6px;margin-bottom:6px;align-items:center">
          <input type="number" step="0.01" min="0" value="${esc(String(p.amount || ''))}" oninput="__wbxArrSetPart(${i}, 'amount', this.value)" placeholder="Bedrag" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;outline:none;box-sizing:border-box" />
          <input type="date" value="${esc(p.due_date || '')}" oninput="__wbxArrSetPart(${i}, 'due_date', this.value)" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;outline:none;box-sizing:border-box" />
          <button class="btn btn-ghost btn-sm" onclick="__wbxArrRemovePart(${i})" style="font-size:11px;color:var(--rose)">×</button>
        </div>`).join('')}
        <button class="btn btn-ghost btn-sm" onclick="__wbxArrAddPart()" style="font-size:11.5px">+ Termijn toevoegen</button>
        <div style="font-size:11px;color:var(--text-3);margin-top:6px">Som moet gelijk zijn aan totaal van geselecteerde facturen (server valideert; 1ct tolerantie).</div>
      </div>`;
    } else if (t === 'ABONNEMENT_PAUZE' || t === 'ABONNEMENT_STOP') {
      const dateKey = t === 'ABONNEMENT_PAUZE' ? 'pause_from' : 'stop_date';
      const dateKey2 = t === 'ABONNEMENT_PAUZE' ? 'pause_until' : null;
      detailsBlock = `<div style="display:flex;flex-direction:column;gap:10px">
        <div>
          <div style="font-size:11.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px">Subscription ID (uuid)</div>
          <input type="text" value="${esc(d.subscription_id || '')}" oninput="__wbxArrSetDetail('subscription_id', this.value)" placeholder="00000000-0000-0000-0000-000000000000" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;outline:none;box-sizing:border-box;font-family:'IBM Plex Mono',monospace" />
        </div>
        <div style="display:grid;grid-template-columns:${dateKey2 ? '1fr 1fr' : '1fr'};gap:10px">
          <div>
            <div style="font-size:11.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px">${dateKey === 'pause_from' ? 'Pauze vanaf' : 'Stop-datum'}</div>
            <input type="date" value="${esc(d[dateKey] || '')}" oninput="__wbxArrSetDetail('${dateKey}', this.value)" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;outline:none;box-sizing:border-box" />
          </div>
          ${dateKey2 ? `<div>
            <div style="font-size:11.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px">Pauze tot</div>
            <input type="date" value="${esc(d[dateKey2] || '')}" oninput="__wbxArrSetDetail('${dateKey2}', this.value)" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;outline:none;box-sizing:border-box" />
          </div>` : ''}
        </div>
        <div>
          <div style="font-size:11.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px">Reden</div>
          <input type="text" value="${esc(d.reason || '')}" oninput="__wbxArrSetDetail('reason', this.value)" placeholder="Waarom?" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;outline:none;box-sizing:border-box" />
        </div>
      </div>`;
    } else if (t === 'KWIJTSCHELDING') {
      detailsBlock = `<div style="display:flex;flex-direction:column;gap:10px">
        <div>
          <div style="font-size:11.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px">Af te boeken bedrag (EUR)</div>
          <input type="number" step="0.01" min="0" value="${esc(String(d.write_off_amount || ''))}" oninput="__wbxArrSetDetail('write_off_amount', this.value)" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:13px;outline:none;box-sizing:border-box" />
        </div>
        <div>
          <div style="font-size:11.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px">Reden</div>
          <input type="text" value="${esc(d.reason || '')}" oninput="__wbxArrSetDetail('reason', this.value)" placeholder="Waarom?" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;outline:none;box-sizing:border-box" />
        </div>
      </div>`;
    }

    _closeConfirmModal();
    const root = document.createElement('div');
    root.id = 'wbxConfirmRoot';
    root.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(17,23,33,.48);padding:20px';
    root.innerHTML = `<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.32);padding:22px;max-width:640px;width:calc(100vw - 40px);max-height:calc(100vh - 60px);overflow:auto">
      <div style="font-size:15.5px;font-weight:600;margin-bottom:6px">Nieuw arrangement voorstellen</div>
      <div style="font-size:12.5px;color:var(--text-3);margin-bottom:14px">Klant: <b style="color:var(--text-1)">${esc(custName)}</b></div>
      <div style="margin-bottom:14px">
        <div style="font-size:11.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Type</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${typeChips}</div>
      </div>
      ${!isSubAction ? `<div style="margin-bottom:14px">
        <div style="font-size:11.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Facturen</div>
        <div style="max-height:180px;overflow-y:auto;border:1px solid var(--border);border-radius:6px">${invoicesBlock}</div>
        <div style="font-size:11px;color:var(--text-3);margin-top:4px">${_arrForm.invoice_ids.length} geselecteerd</div>
      </div>` : ''}
      <div style="margin-bottom:14px">${detailsBlock}</div>
      <div style="margin-bottom:14px">
        <div style="font-size:11.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px">Rationale / toelichting</div>
        <textarea oninput="__wbxArrSetRationale(this.value)" style="width:100%;min-height:56px;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;line-height:1.4;resize:vertical;outline:none;box-sizing:border-box">${esc(_arrForm.rationale || '')}</textarea>
      </div>
      ${_arrForm.error ? `<div style="padding:9px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px;margin-bottom:12px">⚠ ${esc(_arrForm.error)}</div>` : ''}
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-ghost btn-sm" onclick="__wbxArrCancelForm()">Annuleren</button>
        <button class="btn btn-primary btn-sm" ${_arrForm.saving ? 'disabled' : ''} style="background:var(--brand,#0A7490);border-color:var(--brand,#0A7490);color:#fff;opacity:${_arrForm.saving ? '.55' : '1'};cursor:${_arrForm.saving ? 'not-allowed' : 'pointer'}" onclick="__wbxArrSubmit()">${_arrForm.saving ? 'Voorstellen…' : 'Voorstellen'}</button>
      </div>
    </div>`;
    root.addEventListener('click', (e) => { if (e.target === root) window.__wbxArrCancelForm(); });
    document.body.appendChild(root);
    document.addEventListener('keydown', _confirmModalKey, true);
  }

  /* ── BROK 3 WRITE-HANDLERS — bulk-workflow ───────────────────────── */

  const _bulkJobs = { loading: false, error: null, items: [], fetched: false, _seq: 0 };
  async function _fetchBulkJobs() {
    if (_bulkJobs.loading) return;
    _bulkJobs.loading = true; _bulkJobs.error = null;
    const seq = ++_bulkJobs._seq;
    const j = await tryFetch('bulk-jobs', '/api/wanbetalers-bulk-jobs-list?limit=50');
    if (seq !== _bulkJobs._seq) return;
    _bulkJobs.loading = false; _bulkJobs.fetched = true;
    if (!j) { _bulkJobs.error = 'Kon bulk-jobs niet laden'; }
    else if (j.error) { _bulkJobs.error = j.error; }
    else { _bulkJobs.items = asArr(j.items || j.jobs); }
    if (window.DFO?.render) window.DFO.render();
  }

  window.__wbxOvToggleSel = (cid) => {
    _ui.ovSelected[cid] = !_ui.ovSelected[cid];
    if (!_ui.ovSelected[cid]) delete _ui.ovSelected[cid];
    _repaintOverzichtList();
    _repaintOvSelBar();
  };
  window.__wbxOvClearSel = () => {
    _ui.ovSelected = {};
    if (window.DFO?.render) window.DFO.render();
  };
  function _selOvCustIds() { return Object.keys(_ui.ovSelected).filter((k) => _ui.ovSelected[k]); }
  function _repaintOvSelBar() {
    const bar = document.getElementById('wbxOvSelBar');
    if (!bar) return;
    const ids = _selOvCustIds();
    bar.style.display = ids.length ? 'flex' : 'none';
    const cnt = document.getElementById('wbxOvSelCount');
    if (cnt) cnt.textContent = ids.length + ' klant' + (ids.length === 1 ? '' : 'en');
  }

  window.__wbxBulkStart = async () => {
    if (!_rbac.canExecute) { _toast('Geen rechten (finance.dunning.execute).', 'error'); return; }
    if (_ui.bulkBusy) return;
    const custIds = _selOvCustIds();
    if (!custIds.length) return;
    // Server accepteert invoice_ids[] (max 100). Voor bulk-workflow-start
    // resolven we per customer 1 primaire factuur (oudste openstaande).
    // Bron: overzicht-rows die we al hebben (of anders lazy per klant fetch).
    // Voor MVP: gebruik customer_id → we roepen /invoices-list op per klant.
    const invoiceIdsByCust = {};
    for (const cid of custIds) {
      if (!_arrInvoices.byCust[cid]) await _fetchInvoicesForCustomer(cid);
      const list = _arrInvoices.byCust[cid] || [];
      if (list.length) invoiceIdsByCust[cid] = list[0].id;
    }
    const invoiceIds = Object.values(invoiceIdsByCust);
    if (!invoiceIds.length) {
      _toast('Geen openstaande facturen gevonden bij de selectie.', 'warn');
      return;
    }
    if (invoiceIds.length > 100) {
      _toast('Max 100 klanten per bulk-start (server-guard).', 'warn');
      return;
    }
    // v=6 FIX 5: typ-phrase telt DISTINCT klanten (custIds.length), niet
    // invoice_ids. Elke geselecteerde klant → één workflow-run; server
    // resolvet zelf de customer per invoice, maar de UX moet de klant-
    // eenheid noemen die de gebruiker heeft aangevinkt.
    const distinctCust = custIds.length;
    const phrase = `START DUNNING VOOR ${distinctCust} KLANTEN`;
    const bodyHtml = `
      <div style="margin-bottom:10px">Je gaat de dunning-motor starten voor <b>${distinctCust}</b> klant${distinctCust === 1 ? '' : 'en'}
      (${invoiceIds.length} factu${invoiceIds.length === 1 ? 'ur' : 'ren'} meegestuurd — 1 per klant). Elke klant krijgt één workflow-run bij stap 1.</div>
      <div style="padding:10px 12px;background:var(--amber-soft);color:var(--amber);border-radius:6px;font-size:12px;line-height:1.55;margin-bottom:10px">
        <b>Engine-guards blijven gelden</b>:<br>
        · Kantooruren (SEND-stappen alleen 08:00-20:00 Europe/Amsterdam)<br>
        · Cooldown (default 7 dagen tussen sends per klant)<br>
        · Klanten met actief arrangement → gepauzeerd, geen send<br>
        · Sandbox-klanten (is_test) → skipped<br>
        · Klanten met open pending_action (MANUAL_*) → geblokkeerd
      </div>
      <div style="padding:9px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px;line-height:1.5">
        ⚠ <b>Er is geen dry-run</b>: als je bevestigt, worden runs echt aangemaakt. Geen sandbox-optie beschikbaar op dit endpoint.
      </div>`;
    const ok = await _askTypedConfirm('Bulk dunning-workflow starten', bodyHtml, phrase, { okLabel: 'START' });
    if (!ok) return;
    _ui.bulkBusy = true; if (window.DFO?.render) window.DFO.render();
    const r = await apiPost('/api/wanbetalers-bulk-start-workflow', { invoice_ids: invoiceIds });
    _ui.bulkBusy = false;
    if (!r.ok) { _toast('Bulk-start faalde: ' + (r.error || 'onbekend'), 'error'); if (window.DFO?.render) window.DFO.render(); return; }
    const added   = asArr(r.json?.added).length;
    const skipped = asArr(r.json?.skipped).length;
    const errors  = asArr(r.json?.errors).length;
    _toast(`Bulk-start: ${added} runs gestart · ${skipped} geskipt · ${errors} fout${errors === 1 ? '' : 'en'}.`, 'success');
    _ui.ovSelected = {};
    _bulkJobs.fetched = false; _fetchBulkJobs();
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
      // v=6 FIX 2: server retourneert 'total_open_cents' (int in centen) +
      // 'days_overdue' + 'open_invoice_count'. v=4 las 'total_open_amount' /
      // 'oldest_open_days' → altijd 0. Nu correct gemapt.
      const openAmt = Number(r.total_open_cents || 0) / 100;
      const invCount = Number(r.open_invoice_count || 0);
      const oldestDays = Number(r.days_overdue || 0);
      // BROK 9 (v=14): NL-label lookup consistent met case-sheet-kop.
      const stageSlug = r.stage_slug || r.stage || null;
      const stage = r.stage_label
        || (asArr(_live.stages?.items).find((s) => s.slug === stageSlug) || {}).label
        || ((typeof PIPELINE_STAGES !== 'undefined' && PIPELINE_STAGES.find((s) => s[0] === stageSlug)) || [])[1]
        || stageSlug || '—';
      const nextAt = r.next_action_at || r.next_action || null;
      const nextTxt = nextAt ? _fmtDateTime(nextAt) : '—';
      const category = _categorizeOverzichtRow(r);
      const catCol = category === 'stuck' ? 'rose' : category === 'chat' ? 'blue' : 'emerald';
      const hasArr = cid && Array.isArray(arrsMap[cid]) && arrsMap[cid].length > 0;
      const isSel = !!_ui.ovSelected[cid];
      const cidAttr  = String(cid || '').replace(/"/g, '&quot;');
      const cidClick = String(cid || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      return `<div style="display:grid;grid-template-columns:32px 2fr 1fr 90px 100px 1.4fr 1.2fr auto;gap:8px;padding:11px 14px;border-bottom:1px solid var(--border);align-items:center;font-size:12.5px${isSel ? ';background:var(--surface-2)' : ''}"
        onmouseover="if(!this.dataset.sel)this.style.background='var(--surface-2)'" onmouseout="if(!this.dataset.sel)this.style.background='transparent'" ${isSel ? 'data-sel="1"' : ''}>
        <label style="display:flex;align-items:center;cursor:pointer" onclick="event.stopPropagation()">
          <input type="checkbox" ${isSel ? 'checked' : ''} onchange="__wbxOvToggleSel('${cidClick}')" style="width:15px;height:15px;cursor:pointer" />
        </label>
        <div style="cursor:pointer" onclick="__wbxOvOpen('${cidClick}')">
          <div style="font-weight:500">${esc(name)}</div>
          ${hasArr ? `<div style="font-size:10.5px;color:var(--amber);margin-top:2px" title="Actief payment_arrangement: dunning gepauzeerd">⏸ Dunning gepauzeerd (arrangement actief)</div>` : ''}
        </div>
        <div class="mono" style="text-align:right;color:${openAmt > 0 ? 'var(--amber)' : 'var(--text-3)'};font-weight:600">${eur(openAmt)}</div>
        <div class="mono" style="text-align:right;color:var(--text-3)">${invCount}</div>
        <div class="mono" style="text-align:right;color:${oldestDays > 90 ? 'var(--rose)' : oldestDays > 30 ? 'var(--amber)' : 'var(--text-3)'}">${oldestDays}d</div>
        <div><span style="font-size:10.5px;padding:2px 8px;border-radius:6px;background:var(--${catCol}-soft,var(--surface-2));color:var(--${catCol});font-weight:600">${esc(stage)}</span></div>
        <div style="color:var(--text-3);font-size:11.5px">${esc(nextTxt)}</div>
        <div style="text-align:right;display:flex;gap:4px;justify-content:flex-end;flex-wrap:wrap">
          <button class="btn btn-ghost btn-sm" style="font-size:10.5px" onclick="event.stopPropagation();__wbxArrPropose('${cidClick}')" title="Nieuw arrangement voorstellen">📋 Arr</button>
          <button class="btn btn-ghost btn-sm" style="font-size:10.5px;color:var(--text-3)" onclick="event.stopPropagation();__wbxOvOpen('${cidClick}')" title="Open klant-detail">→</button>
        </div>
      </div>`;
    }).join('');
  }
  function overzichtView() {
    if (!_live.overzicht.fetched && !_live.overzicht.loading && !_live.overzicht.error) queueMicrotask(_fetchOverzicht);
    if (!_live.settings.fetched && !_live.settings.loading && !_live.settings.error) queueMicrotask(_fetchSettings);
    // BROK 9 (v=14): stages nodig voor NL-label lookup in de fase-badge.
    if (_live.stages && !_live.stages.fetched && !_live.stages.loading && !_live.stages.error) queueMicrotask(_fetchStages);

    if (_live.overzicht.loading && !_live.overzicht.items.length) {
      return `<div class="pad" style="padding:14px 20px">${_skelKpis()}${_skelRows(6)}</div>`;
    }
    if (_live.overzicht.error && !_live.overzicht.items.length) {
      return `<div class="pad" style="padding:14px 20px">${_errBlk(_live.overzicht.error, 'overzicht')}</div>`;
    }

    const items = asArr(_live.overzicht.items);
    // v=6 FIX 2: sum in centen, delen door 100 voor euro's.
    const totalOpen = items.reduce((a, r) => a + Number(r.total_open_cents || 0), 0) / 100;
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
          ${kpi('Klanten met arrangement', arrCount, 'dunning gepauzeerd', arrCount > 0 ? 'violet' : 'text-3')}
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
          <div style="padding:11px 14px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:8px">
            <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
              ${searchBar}
              <div style="display:flex;gap:5px;flex-wrap:wrap">${filterChips}</div>
            </div>
            <div style="font-size:11.5px;color:var(--text-3);display:flex;justify-content:space-between">
              <span id="wbxOvCount">${filtered.length} klant${filtered.length === 1 ? '' : 'en'}</span>
              <span>Vink klanten aan voor bulk-start · klik rij voor tijdlijn →</span>
            </div>
          </div>
          <div id="wbxOvSelBar" style="display:${_selOvCustIds().length ? 'flex' : 'none'};padding:10px 14px;background:var(--brand-soft,#E2F1F5);border-bottom:1px solid var(--border);align-items:center;gap:10px;font-size:12.5px">
            <b><span id="wbxOvSelCount">${_selOvCustIds().length} klant${_selOvCustIds().length === 1 ? '' : 'en'}</span></b>
            <button class="btn btn-primary btn-sm" style="background:var(--brand,#0A7490);border-color:var(--brand,#0A7490);color:#fff;font-size:11.5px" ${_ui.bulkBusy ? 'disabled' : ''} onclick="__wbxBulkStart()">${_ui.bulkBusy ? 'Starten…' : '▶ Start dunning-workflow (typ-to-confirm)'}</button>
            <button class="btn btn-ghost btn-sm" style="font-size:11px;margin-left:auto" onclick="__wbxOvClearSel()">Wissen</button>
          </div>
          <div style="display:grid;grid-template-columns:32px 2fr 1fr 90px 100px 1.4fr 1.2fr auto;gap:8px;padding:8px 14px;background:var(--surface-2);border-bottom:1px solid var(--border);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);font-weight:600">
            <div></div><div>Klant</div><div style="text-align:right">Open</div><div style="text-align:right">Fact.</div><div style="text-align:right">Oudste</div><div>Fase</div><div>Volgende actie</div><div style="text-align:right">Acties</div>
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
    if (!_live.pipelineActs.fetched && !_live.pipelineActs.loading && !_live.pipelineActs.error) queueMicrotask(_fetchPipelineActs);
    if (!_live.pendingActs.fetched && !_live.pendingActs.loading && !_live.pendingActs.error) queueMicrotask(_fetchPendingActs);
    if (!_live.settings.fetched && !_live.settings.loading && !_live.settings.error) queueMicrotask(_fetchSettings);

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
        const customer = (a.customer && a.customer.name) || a.customer_name || (a.payload && a.payload.customer_name) || a.customer_id || 'Onbekend';
        const type = a.action_type || a.type || '—';
        const amt  = a.amount || (a.payload && a.payload.amount) || null;
        const isTl = String(type).startsWith('TL_');
        const busy = !!_ui.paBusy[a.id];
        const dis = busy ? 'disabled' : '';
        const disStyle = busy ? 'opacity:.55;cursor:not-allowed' : 'cursor:pointer';
        return `<div style="display:grid;grid-template-columns:2fr 2fr 1fr auto;gap:10px;padding:9px 14px;border-bottom:1px solid var(--border);font-size:12.5px;align-items:center">
          <div>${esc(customer)}</div>
          <div style="color:var(--text-2);font-size:11.5px">${esc(type)}${isTl ? ' <span style="font-size:9.5px;padding:1px 5px;border-radius:5px;background:var(--rose-soft);color:var(--rose);font-weight:600;margin-left:4px">TL</span>' : ''}</div>
          <div class="mono" style="text-align:right;color:var(--text-3)">${amt != null ? eur(amt) : '—'}</div>
          <div style="display:flex;gap:4px;justify-content:flex-end;flex-wrap:wrap">
            <button class="btn btn-ghost btn-sm" ${dis} style="font-size:11px;color:var(--emerald);${disStyle}" onclick="__wbxPaApprove('${esc(a.id)}')" title="${isTl ? 'Voer TL-mutatie uit' : 'Goedkeuren'}">${busy ? '…' : '✓ Approve'}</button>
            <button class="btn btn-ghost btn-sm" ${dis} style="font-size:11px;color:var(--rose);${disStyle}" onclick="__wbxPaReject('${esc(a.id)}')" title="Afwijzen (met reden)">✕ Reject</button>
            <button class="btn btn-ghost btn-sm" ${dis} style="font-size:11px;color:var(--text-3);${disStyle}" onclick="__wbxPaMarkExecuted('${esc(a.id)}')" title="Handmatig al uitgevoerd">Al gedaan</button>
          </div>
        </div>`;
      }).join('')}
    </div>` : '';

    // Arrangementen-sectie (actieve).
    if (!_arrLive.fetched && !_arrLive.loading && !_arrLive.error) queueMicrotask(() => _fetchArrangementsList('ACTIEF'));
    const arrangements = asArr(_arrLive.items);
    const arrBlock = `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden;margin-top:14px">
      <div style="padding:12px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
        <div style="font-weight:600;font-size:13px">Actieve arrangementen</div>
        <span style="font-size:11px;color:var(--text-3)">${arrangements.length} ACTIEF · dunning gepauzeerd</span>
      </div>
      ${_arrLive.loading && !arrangements.length ? `<div style="padding:22px;text-align:center;color:var(--text-3);font-size:12.5px">Arrangementen laden…</div>` :
       !arrangements.length ? `<div style="padding:22px;text-align:center;color:var(--text-3);font-size:12.5px">Geen actieve arrangementen.</div>` :
       arrangements.slice(0, 20).map((arr) => {
         const nm = (arr.customer && arr.customer.name) || arr.customer_name || arr.customer_id || 'Onbekend';
         const busy = !!_ui.arrBusy[arr.id];
         return `<div style="display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:10px;padding:9px 14px;border-bottom:1px solid var(--border);font-size:12.5px;align-items:center">
           <div>${esc(nm)}</div>
           <div style="font-size:11.5px;color:var(--text-2)">${esc(arr.type || '—')}</div>
           <div style="font-size:11px;color:var(--text-3)">${esc(arr.status || '—')}</div>
           <div><button class="btn btn-ghost btn-sm" ${busy ? 'disabled' : ''} style="font-size:11px;color:var(--rose);opacity:${busy ? '.55' : '1'};cursor:${busy ? 'not-allowed' : 'pointer'}" onclick="__wbxArrCancel('${esc(arr.id)}','${esc(nm + ' — ' + (arr.type || ''))}')">Annuleer</button></div>
         </div>`;
       }).join('')}
    </div>`;

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
        ${arrBlock}
        ${_bulkJobsBlock()}
      </div>
      ${_officeHoursBanner()}
    </div>`;
  }

  function _bulkJobsBlock() {
    if (!_bulkJobs.fetched && !_bulkJobs.loading && !_bulkJobs.error) queueMicrotask(_fetchBulkJobs);
    const jobs = asArr(_bulkJobs.items);
    if (!jobs.length && !_bulkJobs.loading) return '';
    return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden;margin-top:14px">
      <div style="padding:12px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
        <div style="font-weight:600;font-size:13px">Bulk-workflow-jobs (recent)</div>
        <span style="font-size:11px;color:var(--text-3)">${jobs.length} job${jobs.length === 1 ? '' : 's'}</span>
      </div>
      ${jobs.slice(0, 15).map((j) => `<div style="display:grid;grid-template-columns:1.5fr 1fr 1fr 1fr;gap:10px;padding:8px 14px;border-bottom:1px solid var(--border);font-size:12px;align-items:center">
        <div>${esc(j.workflow_name || j.workflow_id || 'workflow')}</div>
        <div style="font-size:11px;color:var(--text-3)">${esc(_fmtDateTime(j.created_at || j.started_at))}</div>
        <div class="mono" style="font-size:11px">✓ ${j.added_count || 0} · ~ ${j.skipped_count || 0} · ⚠ ${j.errors_count || 0}</div>
        <div style="font-size:11px;color:var(--text-3);text-align:right">${esc(j.status || 'gestart')}</div>
      </div>`).join('')}
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
      const openAmt = Number(r.total_open_cents || 0) / 100;
      // BROK 9 (v=14): NL-label lookup (consistent met overzicht + case-sheet).
      const stageSlugG = r.stage_slug || r.stage || null;
      const stage = r.stage_label
        || (asArr(_live.stages?.items).find((s) => s.slug === stageSlugG) || {}).label
        || ((typeof PIPELINE_STAGES !== 'undefined' && PIPELINE_STAGES.find((s) => s[0] === stageSlugG)) || [])[1]
        || stageSlugG || '—';
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
    const openAmt = Number(row.total_open_cents || 0) / 100;
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

    // v=3 BROK 2: call-log + notitie forms.
    const f    = _callFormState(cid);
    const nf   = _noteFormState(cid);
    const callSaveable = _callIsSaveable(f);
    const outcomeOpts = '<option value="">— Kies uitkomst —</option>' + CALL_OUTCOMES.map(([v, l]) => `<option value="${v}" ${f.outcome === v ? 'selected' : ''}>${esc(l)}</option>`).join('');
    const showCbAt = f.outcome === 'callback';
    const savedRecently = nf.savedAt && (Date.now() - new Date(nf.savedAt).getTime() < 3500);

    // Fase-select. Huidige stage uit de row.
    const curStage = String(row.stage_slug || '').toLowerCase();
    const stageOpts = '<option value="">— Wijzig fase —</option>' + PIPELINE_STAGES.filter(([v]) => v !== curStage).map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');

    return `<div style="display:flex;flex-direction:column;flex:1;min-height:0;background:var(--surface)">
      <div style="padding:14px 20px;background:var(--surface);border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <div style="min-width:0">
          <div style="font-size:16px;font-weight:600;letter-spacing:-.02em">${esc(name)}</div>
          <div style="font-size:12.5px;color:var(--amber);font-weight:500">${eur(openAmt)} openstaand · fase: ${esc(row.stage_label || curStage || '—')}</div>
        </div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <select onchange="if(this.value){__wbxSetStage('${cidClick}', this.value);this.value='';}" style="font-size:11.5px;padding:5px 8px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);color:var(--text-1);cursor:pointer" ${_ui.stageBusy[cid] ? 'disabled' : ''} title="Fase-mutatie (audit-log + confirm)">${stageOpts}</select>
          <button class="btn btn-primary btn-sm" style="background:var(--brand,#0A7490);border-color:var(--brand,#0A7490);color:#fff;font-size:11.5px" onclick="__wbxOvOpen('${cidClick}')" title="Open klant-detail met tijdlijn en communicatie">Open in klanten-detail →</button>
        </div>
      </div>
      <div style="flex:1;overflow-y:auto;min-height:0;padding:14px 20px;display:flex;flex-direction:column;gap:14px">
        <!-- Belpoging loggen -->
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
          <div style="padding:11px 14px;border-bottom:1px solid var(--border);font-weight:600;font-size:13px">Belpoging loggen</div>
          <div style="padding:12px 14px;display:flex;flex-direction:column;gap:10px">
            <div style="display:grid;grid-template-columns:1fr ${showCbAt ? '1fr' : ''};gap:10px;align-items:end">
              <div>
                <div style="font-size:11.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px">Uitkomst</div>
                <select onchange="__wbxCallSetOutcome('${cidClick}', this.value)" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;outline:none;box-sizing:border-box">${outcomeOpts}</select>
              </div>
              ${showCbAt ? `<div>
                <div style="font-size:11.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px">Terugbeltijd <span style="color:var(--rose);text-transform:none;letter-spacing:0">*verplicht</span></div>
                <input type="datetime-local" value="${esc(f.callback_at || '')}" oninput="__wbxCallSetCallbackAt('${cidClick}', this.value)" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;outline:none;box-sizing:border-box" />
              </div>` : ''}
            </div>
            <textarea placeholder="Notitie bij belpoging (optioneel)…" oninput="__wbxCallSetNote('${cidClick}', this.value)"
              style="width:100%;min-height:60px;max-height:160px;padding:8px 11px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;line-height:1.4;resize:vertical;outline:none;box-sizing:border-box">${esc(f.note || '')}</textarea>
            <div id="wbxCallErr_${cidClick}">${f.error ? `<div style="padding:8px 11px;background:var(--rose-soft);color:var(--rose);border-radius:var(--r-sm);font-size:12px">⚠ ${esc(f.error)}</div>` : ''}</div>
            <div style="display:flex;justify-content:flex-end">
              <button id="wbxCallSaveBtn_${cidClick}" class="btn btn-primary btn-sm" ${(!callSaveable || f.saving) ? 'disabled' : ''}
                style="background:var(--brand,#0A7490);border-color:var(--brand,#0A7490);color:#fff;font-size:12px;opacity:${(!callSaveable || f.saving) ? '.55' : '1'};cursor:${(!callSaveable || f.saving) ? 'not-allowed' : 'pointer'}"
                title="${!callSaveable ? (f.outcome === 'callback' ? 'Bij terugbelafspraak: datum/tijd verplicht' : 'Kies eerst een uitkomst') : ''}"
                onclick="__wbxCallSave('${cidClick}')">${f.saving ? 'Opslaan…' : 'Log belpoging'}</button>
            </div>
          </div>
          <div style="padding:11px 14px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
            <div style="font-weight:600;font-size:12.5px">Vorige belpogingen</div>
            <span style="font-size:11px;color:var(--text-3)">${calls.length} log-regel${calls.length === 1 ? '' : 's'}</span>
          </div>
          ${callsBlock}
        </div>

        <!-- Notitie op klant -->
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
          <div style="padding:11px 14px;border-bottom:1px solid var(--border);font-weight:600;font-size:13px">Notitie op klant (pipeline-log)</div>
          <div style="padding:12px 14px;display:flex;flex-direction:column;gap:10px">
            <textarea placeholder="Interne notitie op deze klant…" oninput="__wbxNoteSetBody('${cidClick}', this.value)"
              style="width:100%;min-height:70px;max-height:200px;padding:8px 11px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;line-height:1.4;resize:vertical;outline:none;box-sizing:border-box">${esc(nf.body || '')}</textarea>
            ${nf.error ? `<div style="padding:8px 11px;background:var(--rose-soft);color:var(--rose);border-radius:var(--r-sm);font-size:12px">⚠ ${esc(nf.error)}</div>` : ''}
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
              <span id="wbxNoteSaved_${cidClick}" style="display:${savedRecently ? 'inline' : 'none'};color:var(--emerald);font-weight:600;font-size:11.5px">✓ Notitie opgeslagen</span>
              <span></span>
              <button id="wbxNoteSaveBtn_${cidClick}" class="btn btn-ghost btn-sm" ${(!nf.body || !nf.body.trim() || nf.saving) ? 'disabled' : ''}
                style="font-size:12px;opacity:${(!nf.body || !nf.body.trim() || nf.saving) ? '.55' : '1'};cursor:${(!nf.body || !nf.body.trim() || nf.saving) ? 'not-allowed' : 'pointer'}"
                onclick="__wbxNoteSave('${cidClick}')">${nf.saving ? 'Opslaan…' : 'Notitie opslaan'}</button>
            </div>
          </div>
        </div>

        <!-- Tijdlijn (read) -->
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
          <div style="padding:11px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
            <div style="font-weight:600;font-size:13px">Tijdlijn</div>
            <span style="font-size:11px;color:var(--text-3)">${timeline.length} event${timeline.length === 1 ? '' : 's'}</span>
          </div>
          ${tlBlock}
        </div>
      </div>
    </div>`;
  }
  function gesprekkenView() {
    if (!_live.overzicht.fetched && !_live.overzicht.loading && !_live.overzicht.error) queueMicrotask(_fetchOverzicht);
    // BROK 9 (v=14): stages nodig voor NL-label lookup in fase-badge.
    if (_live.stages && !_live.stages.fetched && !_live.stages.loading && !_live.stages.error) queueMicrotask(_fetchStages);
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
    if (!_live.briefs.fetched && !_live.briefs.loading && !_live.briefs.error) queueMicrotask(_fetchBriefs);

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

    const selIds = _selBriefIds();
    const rowsHtml = filtered.length ? filtered.map((b) => {
      const bid = String(b.id);
      // v=6 FIX 8: endpoint dunning-briefs-list-all levert 'customer_name',
      // 'generated_at', 'sent_via', 'sent_at' + 'download_url' (signed
      // storage URL). GEEN open_amount — die kolom verwijderd. Aangemaakt
      // = 'generated_at' (was 'created_at' → altijd —).
      const name = b.customer_name || b.customer?.name || 'Onbekend';
      const created = b.generated_at ? _fmtDate(b.generated_at) : (b.created_at ? _fmtDate(b.created_at) : '—');
      const cat = categorize(b);
      const busy = !!_ui.briefBusy[bid];
      const isSel = !!_ui.brSelected[bid];
      const statusPill = cat === 'sent'
        ? `<span style="font-size:10.5px;padding:2px 8px;border-radius:6px;background:var(--emerald-soft);color:var(--emerald);font-weight:600">Verstuurd${b.sent_via ? ' · ' + esc(b.sent_via) : ''}</span>`
        : cat === 'downloaded'
          ? `<span style="font-size:10.5px;padding:2px 8px;border-radius:6px;background:var(--amber-soft);color:var(--amber);font-weight:600">Gedownload</span>`
          : `<span style="font-size:10.5px;padding:2px 8px;border-radius:6px;background:var(--blue-soft);color:var(--blue);font-weight:600">Aangemaakt</span>`;
      // v=6 FIX 8: server retourneert 'download_url' (signed URL, 5min TTL).
      // Fallback: POST /api/wanbetalers-brief-pdf?preview=1 zou een preview-
      // blob leveren; hier via een preview-handler.
      const pdfUrl = b.download_url || null;
      const pdfBtn = pdfUrl
        ? `<a class="btn btn-ghost btn-sm" href="${esc(pdfUrl)}" target="_blank" rel="noopener" style="font-size:11px;text-decoration:none" title="Signed URL, 5 min geldig">PDF →</a>`
        : `<button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="__wbxBriefPreview('${esc(bid)}')" title="Genereer preview via wanbetalers-brief-pdf?preview=1">👁 Preview</button>`;
      const emailBtn  = cat === 'sent'
        ? '<span style="font-size:11px;color:var(--text-3)">—</span>'
        : `<button class="btn btn-ghost btn-sm" style="font-size:11px;color:var(--brand,#0A7490);opacity:${busy ? '.55' : '1'};cursor:${busy ? 'not-allowed' : 'pointer'}" ${busy ? 'disabled' : ''} onclick="__wbxBriefEmail('${esc(bid)}')" title="Mail de bewaarde PDF naar de klant (echt bericht)">${busy ? 'Bezig…' : '📧 Mail'}</button>`;
      const markBtn = cat === 'sent'
        ? '<span style="font-size:11px;color:var(--text-3)">—</span>'
        : `<button class="btn btn-ghost btn-sm" style="font-size:11px;opacity:${busy ? '.55' : '1'};cursor:${busy ? 'not-allowed' : 'pointer'}" ${busy ? 'disabled' : ''} onclick="__wbxBriefMarkPost('${esc(bid)}')" title="Handmatig per post verstuurd">✉ Post</button>`;
      const delBtn = `<button class="btn btn-ghost btn-sm" style="font-size:11px;color:var(--rose);opacity:${busy ? '.55' : '1'};cursor:${busy ? 'not-allowed' : 'pointer'}" ${busy ? 'disabled' : ''} onclick="__wbxBriefDelete('${esc(bid)}')" title="Brief + PDF permanent verwijderen">🗑</button>`;
      const tpl = b.template_code || '—';
      return `<div style="display:grid;grid-template-columns:32px 2fr 1fr 130px 140px auto;gap:8px;padding:9px 14px;border-bottom:1px solid var(--border);font-size:12.5px;align-items:center">
        <label style="display:flex;align-items:center;cursor:pointer"><input type="checkbox" ${isSel ? 'checked' : ''} onchange="__wbxBriefToggleSel('${esc(bid)}')" style="width:15px;height:15px;cursor:pointer" /></label>
        <div style="font-weight:500">${esc(name)}</div>
        <div style="font-family:'IBM Plex Mono',monospace;font-size:11.5px;color:var(--text-3)">${esc(tpl)}</div>
        <div class="mono" style="text-align:right;color:var(--text-3)">${esc(created)}</div>
        <div>${statusPill}${b.sent_at ? `<div style="font-size:10px;color:var(--text-3);margin-top:2px;font-family:'IBM Plex Mono',monospace">${esc(_fmtDate(b.sent_at))}</div>` : ''}</div>
        <div style="display:flex;gap:4px;justify-content:flex-end;align-items:center;flex-wrap:wrap">${pdfBtn}${emailBtn}${markBtn}${delBtn}</div>
      </div>`;
    }).join('') : `<div style="padding:44px 20px;text-align:center;color:var(--text-3);font-size:13px">Geen brieven in dit filter.</div>`;

    const bulkBar = selIds.length ? `<div style="padding:10px 14px;background:var(--brand-soft,#E2F1F5);border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;font-size:12.5px">
      <b>${selIds.length} geselecteerd</b>
      <button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="__wbxBriefBulkPrint()">🖨 Bulk-print PDF-bundel</button>
      <button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="__wbxBriefBulkMarkSent()">✓ Markeer verstuurd</button>
      <button class="btn btn-ghost btn-sm" style="font-size:11px;margin-left:auto" onclick="__wbxBriefClearSel()">Wissen</button>
    </div>` : '';

    return `<div data-wbx-view="brieven">
      <div class="pad" style="padding:14px 20px 0">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
          <div style="padding:11px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
            <div style="display:flex;gap:5px;flex-wrap:wrap">${chips}</div>
            <div style="font-size:11px;color:var(--text-3)">${filtered.length} brie${filtered.length === 1 ? 'f' : 'ven'}</div>
          </div>
          ${bulkBar}
          <div style="display:grid;grid-template-columns:32px 2fr 1fr 130px 140px auto;gap:8px;padding:8px 14px;background:var(--surface-2);border-bottom:1px solid var(--border);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);font-weight:600">
            <div></div><div>Klant</div><div>Template</div><div style="text-align:right">Aangemaakt</div><div>Status</div><div style="text-align:right">Acties</div>
          </div>
          <div>${rowsHtml}</div>
          <div style="padding:9px 14px;font-size:11px;color:var(--text-3);background:var(--surface-2)">Handmatige mail vertrekt <b>direct</b> (omzeilt de kantooruren-wachtrij).</div>
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

  /* ── BROK 5 (v=10): WA+mail inbox (split-pane, vervangt Gesprekken) ─
     Hergebruikt module='finance' endpoints (zelfde als andere inboxen).
     Links: /api/inbox-conversations-list (search + status-filter).
     Midden: /api/inbox-thread-unified (WA+mail chronologisch).
     Rechts: /api/inbox-conversation-context (klant + open facturen).
     Compose: WA text → 422 24h_window_expired schakelt naar templates
     (via /api/inbox-send-template + /api/inbox-template-list). Mail via
     /api/email-send-v2. Custom confirm-modal vóór ELKE send. */
  _live.inbox = {
    convs:        { loading: false, fetched: false, error: null, items: [], _seq: 0 },
    thread:       { loading: {}, error: {}, byConv: {}, _seq: 0 }, // per conv
    ctx:          { loading: {}, byConv: {} },
    templates:    { loading: {}, byConv: {} },
    quickReplies: { loading: {}, byConv: {} },
  };
  _ui.inbox = {
    selectedConv:  null,
    _selectSeq:    0,                  // BROK 5-fix (v=11): per __wbxInboxSelect stale-guard
    searchQ:       '',
    _searchTimer:  null,
    statusFilter:  'active',           // 'active' | 'afgehandeld' | 'archief' | 'all'
    compose: {
      channel:          'wa',          // 'wa' | 'mail'
      text:             '',
      subject:          '',
      templateName:     '',
      sending:          false,
      waWindowExpired:  false,
      error:            null,
    },
  };

  async function _fetchInboxConvs() {
    const st = _live.inbox.convs;
    if (st.loading) return;
    const mySeq = ++st._seq;
    st.loading = true; st.error = null;
    const q = new URLSearchParams({ module: 'finance', limit: '200', status_filter: _ui.inbox.statusFilter || 'active' });
    if (_ui.inbox.searchQ && _ui.inbox.searchQ.trim()) q.set('search', _ui.inbox.searchQ.trim());
    const j = await tryFetch('inbox:convs', '/api/inbox-conversations-list?' + q.toString(), 8000);
    if (mySeq !== st._seq) return;
    if (j && j.error) st.error = j.error;
    else { st.items = asArr(j?.items); st.fetched = true; }
    st.loading = false;
    try { window.DFO?.render?.(); } catch (_) {}
  }
  // BROK 5-fix (v=11): stale-guard via _seq per __wbxInboxSelect.
  // Snel klikken A → B → A → fetches van eerder-verlaten convs die later
  // returnen mogen state niet meer overschrijven. Elke fetch capturet
  // 'mySeq' bij start en checkt bij state-write of dat nog === _selectSeq.
  async function _fetchInboxThread(convId, mySeq) {
    if (!convId) return;
    const bag = _live.inbox.thread.byConv[convId] = _live.inbox.thread.byConv[convId] || { items: [], conversation: null };
    if (_live.inbox.thread.loading[convId]) return;
    _live.inbox.thread.loading[convId] = true; delete _live.inbox.thread.error[convId];
    const j = await tryFetch('inbox:thread:' + convId, `/api/inbox-thread-unified?conversation_id=${encodeURIComponent(convId)}&include_email=1&limit=200`, 10000);
    // Stale? User heeft doorgeklikt naar een andere conv → skip state-write.
    if (mySeq != null && mySeq !== _ui.inbox._selectSeq) { _live.inbox.thread.loading[convId] = false; return; }
    if (j && j.error) _live.inbox.thread.error[convId] = j.error;
    else {
      bag.items = asArr(j?.items);
      bag.conversation = j?.conversation || null;
      // Als 24u-venster nog niet expired volgens conv, reset de UI-toggle.
      if (bag.conversation && bag.conversation.can_send_text) _ui.inbox.compose.waWindowExpired = false;
      else if (bag.conversation && bag.conversation.can_send_text === false) _ui.inbox.compose.waWindowExpired = true;
    }
    _live.inbox.thread.loading[convId] = false;
    try { window.DFO?.render?.(); } catch (_) {}
  }
  async function _fetchInboxCtx(convId, mySeq) {
    if (!convId) return;
    if (_live.inbox.ctx.loading[convId] || _live.inbox.ctx.byConv[convId]) return;
    _live.inbox.ctx.loading[convId] = true;
    const j = await tryFetch('inbox:ctx:' + convId, `/api/inbox-conversation-context?conversation_id=${encodeURIComponent(convId)}`, 8000);
    _live.inbox.ctx.loading[convId] = false;
    if (mySeq != null && mySeq !== _ui.inbox._selectSeq) return;
    if (j && !j.error) _live.inbox.ctx.byConv[convId] = j;
    try { window.DFO?.render?.(); } catch (_) {}
  }
  async function _fetchInboxTemplates(convId, mySeq) {
    if (!convId) return;
    if (_live.inbox.templates.loading[convId] || _live.inbox.templates.byConv[convId]) return;
    _live.inbox.templates.loading[convId] = true;
    const j = await tryFetch('inbox:tpl:' + convId, `/api/inbox-template-list?conversation_id=${encodeURIComponent(convId)}`, 8000);
    _live.inbox.templates.loading[convId] = false;
    if (mySeq != null && mySeq !== _ui.inbox._selectSeq) return;
    if (j && !j.error) _live.inbox.templates.byConv[convId] = asArr(j?.items);
    try { window.DFO?.render?.(); } catch (_) {}
  }

  window.__wbxInboxSelect = (convId) => {
    _ui.inbox.selectedConv = String(convId);
    // BROK 5-fix (v=11): increment select-seq zodat oudere in-flight
    // fetches (van eerdere convId) hun state-write skippen zodra ze
    // eindelijk resolven. Voorkomt race waarbij een trage thread-fetch
    // van conv A de zojuist gekozen conv B overschrijft.
    const mySeq = ++_ui.inbox._selectSeq;
    _ui.inbox.compose = { channel: 'wa', text: '', subject: '', templateName: '', sending: false, waWindowExpired: false, error: null };
    _fetchInboxThread(convId, mySeq);
    _fetchInboxCtx(convId, mySeq);
    _fetchInboxTemplates(convId, mySeq);
    // Mark-read (silent, fire-and-forget). WA via inbox-mark-read;
    // email via email-actions?action=mark-read per email-id (BROK 9 v=14:
    // /api/inbox-mark-read raakt alleen WA-unread → email_unread_count bleef
    // staan). Loop over thread-items met channel=email + direction=inbound.
    apiPost('/api/inbox-mark-read', { conversation_id: convId }).catch(() => {});
    // Wait tot thread is geladen om email-ids op te halen.
    setTimeout(() => {
      const bag = _live.inbox.thread.byConv[convId];
      if (!bag || !bag.items) return;
      const inboundEmails = bag.items.filter((m) =>
        m.channel === 'email' && (m.direction === 'inbound' || m.direction === 'in')
      );
      for (const m of inboundEmails) {
        // Fire-and-forget per email. email-actions is idempotent, dubbele
        // mark-read is no-op.
        const emailId = String(m.id || '').replace(/^email:/, '').replace(/^reply:/, '');
        if (!emailId) continue;
        apiPost('/api/email-actions', { email_id: emailId, action: 'mark-read' }).catch(() => {});
      }
    }, 1500); // 1.5s = ruim voldoende voor thread-fetch (typisch 200-500ms).
    try { window.DFO?.render?.(); } catch (_) {}
  };
  // BROK 8 fix 5 (v=13): state-only oninput + surgical repaint van alleen de
  // conv-lijst. Voorheen: elke keystroke triggerde _fetchInboxConvs (server-side
  // search) die daarna DFO.render() aanriep → hele shell re-render → input-node
  // vervangen → focus verloren naar body. Nu: client-side substring-filter over
  // huidige items, alleen #wbxInboxList wordt vervangen. Zelfde patroon als
  // _repaintOverzichtList. Server-search alleen bij nieuwe status-filter of
  // handmatige retry.
  function _repaintInboxList() {
    const el = document.getElementById('wbxInboxList');
    if (el) el.innerHTML = _inboxConvsListHtml();
  }
  window.__wbxInboxSearch = (val) => {
    _ui.inbox.searchQ = String(val || '');
    if (_ui.inbox._searchTimer) clearTimeout(_ui.inbox._searchTimer);
    _ui.inbox._searchTimer = setTimeout(_repaintInboxList, 200);
  };
  window.__wbxInboxStatus = (val) => {
    _ui.inbox.statusFilter = String(val || 'active');
    _live.inbox.convs.fetched = false;
    _fetchInboxConvs();
  };
  window.__wbxInboxToggleChannel = (ch) => {
    _ui.inbox.compose.channel = String(ch || 'wa');
    _ui.inbox.compose.error = null;
    try { window.DFO?.render?.(); } catch (_) {}
  };
  window.__wbxInboxComposeField = (field, val) => {
    _ui.inbox.compose[field] = val;
  };
  window.__wbxInboxPickTemplate = (name) => {
    _ui.inbox.compose.templateName = String(name || '');
  };
  window.__wbxInboxSetStatus = async (newStatus) => {
    const convId = _ui.inbox.selectedConv;
    if (!convId) return;
    const labelMap = { open: 'Open', afgehandeld: 'Afgehandeld', gearchiveerd: 'Gearchiveerd' };
    const ok = await _askConfirm('Gesprek verplaatsen?', `Zet dit gesprek op <b>${esc(labelMap[newStatus] || newStatus)}</b>.`, { okLabel: 'Ja' });
    if (!ok) return;
    const r = await apiPost('/api/inbox-conversation-set-status', { conversation_id: convId, status: newStatus });
    if (!r.ok) { _toast('Kon status niet zetten: ' + (r.error || 'onbekend'), 'error'); return; }
    _live.inbox.convs.fetched = false; _fetchInboxConvs();
    _toast('Status bijgewerkt.', 'success');
  };

  window.__wbxInboxSend = async () => {
    const c = _ui.inbox.compose;
    const convId = _ui.inbox.selectedConv;
    if (!convId) return;
    if (c.sending) return;
    const bag = _live.inbox.thread.byConv[convId];
    const conv = bag?.conversation || null;
    // BROK 8 fix 2 (v=13, INCASSO-KRITISCH): confirm moet de KLANT-naam tonen,
    // niet het WA-profielnaam (display_name is de WA-profielnaam die de klant
    // zelf zet — vaak alias/afwijkend van de echte klantnaam in ons systeem).
    // Volgorde: customer_name (uit inbox-conv join) → customer_name uit convs-
    // list (zelfde source, andere fetch) → display_name (WA-profiel, laatste
    // resort) → threadkop 'klant' als niets werkt. Confirm-body toont zelfde
    // naam als de threadkop rendert (_inboxCtxHtml: cust.name = customer_name).
    const convRow  = (_live.inbox.convs.items || []).find((x) => x.id === convId) || {};
    const custName = conv?.customer_name
                  || convRow.customer_name
                  || convRow.display_name
                  || conv?.display_name
                  || 'klant';

    // Build payload per channel.
    if (c.channel === 'wa') {
      // WA text of template
      const useTemplate = c.waWindowExpired || !!c.templateName;
      if (useTemplate) {
        if (!c.templateName) { c.error = 'Kies een template (24u-venster is verlopen).'; try { window.DFO?.render?.(); } catch (_) {} return; }
        const tplLabel = c.templateName;
        const ok = await _askConfirm(`Template versturen naar ${esc(custName)}?`, `<div><b>Kanaal:</b> WhatsApp (template)</div><div><b>Template:</b> <span style="font-family:'IBM Plex Mono',monospace">${esc(tplLabel)}</span></div>`, { okLabel: 'Ja, verstuur' });
        if (!ok) return;
        c.sending = true; c.error = null; try { window.DFO?.render?.(); } catch (_) {}
        const r = await apiPost('/api/inbox-send-template', { conversation_id: convId, template_name: tplLabel, language: 'nl', variables: {} });
        c.sending = false;
        if (!r.ok) { c.error = r.error || 'Template-send faalde.'; try { window.DFO?.render?.(); } catch (_) {} return; }
        c.templateName = ''; c.text = '';
      } else {
        const body = (c.text || '').trim();
        if (!body) { c.error = 'Bericht is leeg.'; try { window.DFO?.render?.(); } catch (_) {} return; }
        const ok = await _askConfirm(`Bericht versturen naar ${esc(custName)}?`, `<div><b>Kanaal:</b> WhatsApp</div><div style="margin-top:6px;padding:8px 11px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r-sm);font-size:12.5px">${esc(body)}</div>`, { okLabel: 'Ja, verstuur' });
        if (!ok) return;
        c.sending = true; c.error = null; try { window.DFO?.render?.(); } catch (_) {}
        const r = await apiPost('/api/inbox-send', { conversation_id: convId, mode: 'text', body });
        c.sending = false;
        if (!r.ok) {
          // 24h_window_expired detectie
          const errStr = String(r.error || '').toLowerCase();
          if (errStr.includes('24h_window_expired') || errStr.includes('24h window') || r.status === 422) {
            c.waWindowExpired = true;
            c.error = '24u-venster verlopen — kies een template.';
            _fetchInboxTemplates(convId);
          } else {
            c.error = r.error || 'WA-send faalde.';
          }
          try { window.DFO?.render?.(); } catch (_) {}
          return;
        }
        c.text = '';
      }
    } else if (c.channel === 'mail') {
      const body = (c.text || '').trim();
      const subject = (c.subject || '').trim();
      if (!subject) { c.error = 'Onderwerp is leeg.'; try { window.DFO?.render?.(); } catch (_) {} return; }
      if (!body)    { c.error = 'Bericht is leeg.';   try { window.DFO?.render?.(); } catch (_) {} return; }
      const ctx = _live.inbox.ctx.byConv[convId];
      const toEmail = ctx?.customer?.email;
      if (!toEmail) { c.error = 'Geen e-mailadres bij deze klant.'; try { window.DFO?.render?.(); } catch (_) {} return; }
      const ok = await _askConfirm(`Mail versturen naar ${esc(custName)}?`, `<div><b>Kanaal:</b> E-mail</div><div><b>Aan:</b> ${esc(toEmail)}</div><div><b>Onderwerp:</b> ${esc(subject)}</div><div style="margin-top:6px;padding:8px 11px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r-sm);font-size:12.5px;white-space:pre-wrap">${esc(body)}</div>`, { okLabel: 'Ja, verstuur' });
      if (!ok) return;
      c.sending = true; c.error = null; try { window.DFO?.render?.(); } catch (_) {}
      const r = await apiPost('/api/email-send-v2', {
        from_mailbox: 'administratie',
        to: toEmail,
        subject,
        text: body,
      });
      c.sending = false;
      if (!r.ok) { c.error = r.error || 'Mail-send faalde.'; try { window.DFO?.render?.(); } catch (_) {} return; }
      c.text = ''; c.subject = '';
    }

    // Refetch thread + convs (nieuwe outbound + last_message_at).
    delete _live.inbox.thread.byConv[convId];
    _fetchInboxThread(convId);
    _live.inbox.convs.fetched = false; _fetchInboxConvs();
    _toast('Bericht verstuurd.', 'success');
  };
  window.__wbxRetryInbox = () => { _live.inbox.convs.fetched = false; _fetchInboxConvs(); };

  function _inboxConvsListHtml() {
    const st = _live.inbox.convs;
    if (st.loading && !st.items.length) return _skelRows(6);
    if (st.error  && !st.items.length) return `<div style="padding:14px">${_errBlk(st.error, 'inbox')}</div>`;

    // BROK 8 fix 4 (v=13): scope op wanbetalers-set. module=finance geeft ALLE
    // finance-inbox convs (156 zonder scoping, waarvan 39% niet-wanbetalers).
    // Endpoint accepteert geen customer_id-filter, dus client-side intersect
    // met _live.overzicht.items (wanbetalers-lijst). Fallback: als overzicht
    // nog niet geladen is → toon alle (tijdelijk breed) i.p.v. lege lijst.
    const wbCids = new Set(asArr(_live.overzicht.items).map((r) => String(r.customer_id || r.id)));
    let items = wbCids.size
      ? st.items.filter((c) => c.customer_id && wbCids.has(String(c.customer_id)))
      : st.items;
    // BROK 8 fix 5: client-side substring-filter op naam/nummer.
    const q = String(_ui.inbox.searchQ || '').trim().toLowerCase();
    if (q) {
      items = items.filter((c) => (
        (c.customer_name || '') + ' ' +
        (c.display_name  || '') + ' ' +
        (c.phone_number  || '')
      ).toLowerCase().includes(q));
    }
    if (!items.length) return `<div style="padding:44px 14px;text-align:center;color:var(--text-3);font-size:12.5px">Geen wanbetaler-gesprekken in dit filter.</div>`;
    // BROK 1 INBOX-1: sorteer op laatste bericht (nieuwste bovenaan). Ongelezen
    // convs uit dezelfde tijdsband komen daarmee natuurlijk boven eerder-gelezen.
    items = items.slice().sort((a, b) => {
      const ta = a.last_message_at ? Date.parse(a.last_message_at) : 0;
      const tb = b.last_message_at ? Date.parse(b.last_message_at) : 0;
      return tb - ta;
    });
    return items.map((c) => {
      const cid = String(c.id);
      const active = _ui.inbox.selectedConv === cid;
      const name = c.customer_name || c.display_name || c.phone_number || 'Onbekend';
      const preview = c.last_message_preview || '';
      const when = c.last_message_at ? _fmtDateTime(c.last_message_at) : '';
      const unread = Number(c.unread_count) || 0;
      const briefBadge = c.brief_sent ? '<span title="Brief verstuurd" style="font-size:9.5px;padding:1px 5px;border-radius:4px;background:var(--blue-soft);color:var(--blue);font-weight:600;margin-left:4px">✉</span>' : '';
      // BROK 1 INBOX-1: unread-indicatie versterken — 3px rose left-stripe +
      // iets warmere rij-achtergrond zodat ongelezen op afstand herkenbaar zijn.
      const bg = active
        ? 'var(--brand-soft,#E2F1F5)'
        : (unread > 0 ? 'var(--rose-soft, rgba(244,63,94,.06))' : 'transparent');
      const stripe = unread > 0 && !active ? 'border-left:3px solid var(--rose);padding-left:9px;' : '';
      return `<div onclick="__wbxInboxSelect('${esc(cid)}')" style="padding:9px 12px;border-bottom:1px solid var(--border);cursor:pointer;background:${bg};transition:background .08s;${stripe}">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">
          <div style="font-weight:${unread > 0 ? '700' : '500'};font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${esc(name)}${briefBadge}</div>
          <div style="font-size:10.5px;color:${unread > 0 ? 'var(--rose)' : 'var(--text-3)'};white-space:nowrap;font-weight:${unread > 0 ? '600' : '400'}">${esc(when)}</div>
        </div>
        <div style="font-size:11.5px;color:${unread > 0 ? 'var(--text-1)' : 'var(--text-3)'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px;font-weight:${unread > 0 ? '500' : '400'}">${esc(preview)}</div>
        ${unread > 0 ? `<div style="margin-top:3px"><span style="display:inline-block;background:var(--rose);color:#fff;font-size:10px;padding:1px 6px;border-radius:8px;font-weight:600">${unread}</span></div>` : ''}
      </div>`;
    }).join('');
  }

  function _inboxThreadHtml(convId) {
    if (!convId) return `<div style="padding:60px 20px;text-align:center;color:var(--text-3);font-size:13px">← Kies een gesprek links.</div>`;
    const loading = _live.inbox.thread.loading[convId];
    const error   = _live.inbox.thread.error[convId];
    const bag     = _live.inbox.thread.byConv[convId];
    if (loading && (!bag || !bag.items.length)) return `<div style="padding:14px">${_skelRows(6)}</div>`;
    if (error && (!bag || !bag.items.length)) return `<div style="padding:14px">${_errBlk(error, 'thread')}</div>`;
    const items = asArr(bag?.items);
    if (!items.length) return `<div style="padding:60px 20px;text-align:center;color:var(--text-3);font-size:13px">Nog geen berichten.</div>`;
    return items.map((m) => {
      const isOut = m.direction === 'outbound' || m.direction === 'out';
      const bg = isOut ? 'var(--brand-soft,#E2F1F5)' : 'var(--surface-2)';
      const align = isOut ? 'flex-end' : 'flex-start';
      const chBadge = m.channel === 'email'
        ? '<span style="font-size:9.5px;padding:1px 5px;border-radius:4px;background:var(--blue-soft);color:var(--blue);font-weight:600;margin-right:4px">✉ MAIL</span>'
        : '<span style="font-size:9.5px;padding:1px 5px;border-radius:4px;background:var(--emerald-soft);color:var(--emerald);font-weight:600;margin-right:4px">💬 WA</span>';
      const subj = m.channel === 'email' && m.meta?.subject ? `<div style="font-weight:600;margin-bottom:3px;font-size:12px">${esc(m.meta.subject)}</div>` : '';
      return `<div style="display:flex;justify-content:${align};margin-bottom:9px">
        <div style="max-width:78%;padding:8px 11px;background:${bg};border:1px solid var(--border);border-radius:var(--r-sm)">
          <div style="font-size:10.5px;color:var(--text-3);margin-bottom:3px">${chBadge}${esc(_fmtDateTime(m.at))}</div>
          ${subj}
          <div style="font-size:12.5px;white-space:pre-wrap;word-break:break-word">${esc(m.body || '')}</div>
        </div>
      </div>`;
    }).join('');
  }

  function _inboxComposeHtml(convId) {
    if (!convId) return '';
    const c = _ui.inbox.compose;
    const bag = _live.inbox.thread.byConv[convId];
    const conv = bag?.conversation || null;
    const canSendText = conv?.can_send_text !== false && !c.waWindowExpired;
    const tpls = asArr(_live.inbox.templates.byConv[convId]);
    const chBtn = (id, label) => `<button class="chip ${c.channel === id ? 'on' : ''}" style="font-size:11px;padding:3px 10px" onclick="__wbxInboxToggleChannel('${id}')">${esc(label)}</button>`;
    const errLine = c.error ? `<div style="color:var(--rose);font-size:11.5px;margin-top:4px">⚠ ${esc(c.error)}</div>` : '';
    const statBtn = (v, l) => `<button class="btn btn-ghost btn-sm" style="font-size:10.5px;padding:3px 8px" onclick="__wbxInboxSetStatus('${v}')">${esc(l)}</button>`;

    let composerHtml = '';
    if (c.channel === 'wa') {
      if (canSendText) {
        composerHtml = `<textarea placeholder="Typ een WhatsApp-bericht…" oninput="__wbxInboxComposeField('text',this.value)" rows="3" style="width:100%;font-size:12.5px;padding:8px 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface-2);color:var(--text-1);resize:vertical;font-family:inherit;box-sizing:border-box">${esc(c.text || '')}</textarea>`;
      } else {
        composerHtml = `<div style="font-size:11.5px;color:var(--amber);margin-bottom:6px">24u-venster is verlopen — vrije tekst geblokkeerd. Kies een template:</div>
          <select onchange="__wbxInboxPickTemplate(this.value)" style="width:100%;font-size:12.5px;padding:6px 8px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface-2);color:var(--text-1)">
            <option value="">— kies template —</option>
            ${tpls.filter((t) => (t.category || '').toLowerCase().includes('wanbetaler') || (t.category || '').toLowerCase() === 'utility' || !t.category).map((t) => `<option value="${esc(t.name || t.template_name)}" ${c.templateName === (t.name || t.template_name) ? 'selected' : ''}>${esc(t.name || t.template_name)}${t.category ? ' · ' + esc(t.category) : ''}</option>`).join('')}
          </select>`;
      }
    } else if (c.channel === 'mail') {
      composerHtml = `<input type="text" placeholder="Onderwerp" value="${esc(c.subject || '')}" oninput="__wbxInboxComposeField('subject',this.value)" style="width:100%;font-size:12.5px;padding:6px 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface-2);color:var(--text-1);margin-bottom:6px;box-sizing:border-box" />
        <textarea placeholder="Typ een mail…" oninput="__wbxInboxComposeField('text',this.value)" rows="4" style="width:100%;font-size:12.5px;padding:8px 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface-2);color:var(--text-1);resize:vertical;font-family:inherit;box-sizing:border-box">${esc(c.text || '')}</textarea>`;
    }

    return `<div style="border-top:1px solid var(--border);background:var(--surface);padding:10px 14px">
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap">
        ${chBtn('wa', '💬 WhatsApp')}
        ${chBtn('mail', '✉ E-mail')}
        <div style="flex:1"></div>
        ${statBtn('open', 'Open')}
        ${statBtn('afgehandeld', 'Afgehandeld')}
        ${statBtn('gearchiveerd', 'Archiveer')}
      </div>
      ${composerHtml}
      ${errLine}
      <div style="display:flex;justify-content:flex-end;margin-top:6px">
        <button class="btn btn-primary btn-sm" style="font-size:11.5px" onclick="__wbxInboxSend()" ${c.sending ? 'disabled' : ''}>${c.sending ? 'Bezig…' : 'Verstuur'}</button>
      </div>
    </div>`;
  }

  function _inboxCtxHtml(convId) {
    const ctx = _live.inbox.ctx.byConv[convId];
    if (!ctx) return '';
    const cust = ctx.customer || {};
    const invs = asArr(ctx.open_invoices);
    const totalOpen = Number(ctx.totals?.open_amount ?? 0);
    return `<div style="border-bottom:1px solid var(--border);background:var(--surface-2);padding:9px 14px;font-size:12px">
      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:baseline">
        <b>${esc(cust.name || 'Onbekende klant')}</b>
        ${cust.email ? `<span style="color:var(--text-3);font-size:11px">${esc(cust.email)}</span>` : ''}
        <div style="flex:1"></div>
        <span style="font-family:'IBM Plex Mono',monospace;color:var(--rose);font-weight:600">${eur(totalOpen)}</span>
        <span style="font-size:11px;color:var(--text-3)">${invs.length} open fact</span>
        ${cust.id ? `<button class="btn btn-ghost btn-sm" style="font-size:11px;padding:2px 8px" onclick="__wbxOpenCase('${esc(cust.id)}')" title="Open case-sheet">Dossier →</button>` : ''}
      </div>
    </div>`;
  }

  /* BROK 1 INBOX-1: Klantgegevens-paneel (right-side, 300px). Toont naam,
     contactkanalen (mail/telefoon met klik-acties), open facturen (compact),
     actieve abo's, MRR, en snelle dossier-link. Placeholder als er nog geen
     conv-selectie is; skeleton als ctx nog laadt. */
  function _inboxKlantgegevensHtml(convId) {
    if (!convId) {
      return `<div style="padding:60px 16px;text-align:center;color:var(--text-3);font-size:12px">
        <div style="font-size:22px;margin-bottom:6px;opacity:.5">👤</div>
        Selecteer een gesprek om klantgegevens te tonen.
      </div>`;
    }
    const ctx = _live.inbox.ctx.byConv[convId];
    const loading = _live.inbox.ctx.loading[convId];
    if (!ctx && loading) return `<div style="padding:14px">${_skelRows(5)}</div>`;
    if (!ctx) return `<div style="padding:60px 16px;text-align:center;color:var(--text-3);font-size:12px">Geen klant-context beschikbaar.</div>`;
    const cust = ctx.customer || {};
    const invs = asArr(ctx.open_invoices);
    const subs = asArr(ctx.active_subscriptions);
    const t = ctx.totals || {};
    const totalOpen = Number(t.open_amount ?? 0);
    const mrr = Number(t.subscriptions_total_mrr ?? 0);
    const phone = cust.phone || ctx.conversation?.phone_number || null;

    if (!cust.id) {
      return `<div style="padding:14px;font-size:12px">
        <div style="color:var(--text-3);margin-bottom:8px;font-weight:600">Onbekende klant</div>
        ${phone ? `<div style="font-size:11.5px;color:var(--text-2)">📞 ${esc(phone)}</div>` : ''}
        <div style="margin-top:10px;font-size:11.5px;color:var(--amber)">Nummer nog niet gekoppeld aan een klant.</div>
      </div>`;
    }

    const callBtn = phone
      ? `<button class="btn btn-ghost btn-sm" style="font-size:11px;padding:3px 8px" onclick="__wbxCall('${esc(cust.id)}','${esc(phone)}')" title="Bel via softphone">📞 Bel</button>`
      : '';
    const mailBtn = cust.email
      ? `<a class="btn btn-ghost btn-sm" style="font-size:11px;padding:3px 8px;text-decoration:none" href="mailto:${esc(cust.email)}" title="Mail-client openen">✉ Mail</a>`
      : '';
    const dossierBtn = `<button class="btn btn-primary btn-sm" style="font-size:11px;padding:3px 10px" onclick="__wbxOpenCase('${esc(cust.id)}')" title="Open case-sheet">Dossier →</button>`;

    const invsHtml = invs.length
      ? invs.slice(0, 8).map((iv) => {
          const num = iv.invoice_number || iv.id;
          const overdue = iv.days_overdue > 0;
          return `<div style="display:flex;justify-content:space-between;gap:8px;padding:5px 0;border-bottom:1px dashed var(--border);font-size:11.5px">
            <div style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
              <span style="font-family:'IBM Plex Mono',monospace">${esc(num)}</span>
              ${overdue ? `<span style="color:var(--rose);font-size:10px;margin-left:4px">+${iv.days_overdue}d</span>` : ''}
            </div>
            <div style="font-family:'IBM Plex Mono',monospace;color:var(--text-1);font-weight:600">${eur(iv.amount_open)}</div>
          </div>`;
        }).join('')
      : `<div style="font-size:11.5px;color:var(--text-3);padding:6px 0">Geen open facturen.</div>`;
    const subsHtml = subs.length
      ? subs.slice(0, 4).map((s) => `<div style="display:flex;justify-content:space-between;gap:8px;padding:4px 0;font-size:11.5px">
          <div style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.description || 'Abonnement')}</div>
          <div style="font-family:'IBM Plex Mono',monospace;color:var(--text-3)">${eur(s.mrr)}/m</div>
        </div>`).join('')
      : '';

    return `<div style="display:flex;flex-direction:column;height:100%;overflow-y:auto">
      <div style="padding:14px 14px 10px;border-bottom:1px solid var(--border);background:var(--surface-2)">
        <div style="font-weight:700;font-size:13.5px;margin-bottom:3px">${esc(cust.name || 'Onbekende klant')}</div>
        ${cust.email ? `<div style="font-size:11.5px;color:var(--text-2);word-break:break-all;margin-bottom:2px">✉ ${esc(cust.email)}</div>` : ''}
        ${phone ? `<div style="font-size:11.5px;color:var(--text-2)">📞 ${esc(phone)}</div>` : ''}
        <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">
          ${callBtn}${mailBtn}${dossierBtn}
        </div>
      </div>

      <div style="padding:12px 14px;border-bottom:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-3);font-weight:600">Openstaand</div>
          <div style="font-family:'IBM Plex Mono',monospace;font-size:14px;font-weight:700;color:var(--rose)">${eur(totalOpen)}</div>
        </div>
        <div style="font-size:11px;color:var(--text-3);margin-bottom:4px">${invs.length} factuur${invs.length === 1 ? '' : 'en'}</div>
        ${invsHtml}
      </div>

      ${subs.length ? `<div style="padding:12px 14px;border-bottom:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-3);font-weight:600">Abonnementen</div>
          <div style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text-2)">${eur(mrr)}/m</div>
        </div>
        ${subsHtml}
      </div>` : ''}
    </div>`;
  }

  // Softphone-call vanuit klantgegevens-paneel — hergebruikt bel-flow uit
  // case-sheet (custom confirm-modal + race-guard zit in __wbxSoftphoneCall).
  window.__wbxCall = (cid, phone) => {
    if (typeof window.__wbxSoftphoneCall === 'function') {
      window.__wbxSoftphoneCall(cid, phone);
    } else if (window.KlxSoftphone?.call) {
      window.KlxSoftphone.call(phone);
    } else {
      _toast('Softphone niet beschikbaar.', 'warn');
    }
  };

  function inboxView() {
    if (!_live.inbox.convs.fetched && !_live.inbox.convs.loading && !_live.inbox.convs.error) queueMicrotask(_fetchInboxConvs);
    // BROK 8 fix 4: overzicht nodig voor client-side wanbetalers-scoping.
    if (!_live.overzicht.fetched && !_live.overzicht.loading && !_live.overzicht.error) queueMicrotask(_fetchOverzicht);
    const convId = _ui.inbox.selectedConv;
    const qVal = String(_ui.inbox.searchQ || '');
    const statusBtn = (v, l) => `<button class="chip ${_ui.inbox.statusFilter === v ? 'on' : ''}" style="font-size:11px;padding:3px 9px" onclick="__wbxInboxStatus('${v}')">${esc(l)}</button>`;

    return `<div data-wbx-view="gesprekken" class="pad" style="padding:14px 20px 0">
      <div style="display:flex;gap:0;height:calc(100vh - 200px);min-height:520px;border:1px solid var(--border);border-radius:var(--r);overflow:hidden;background:var(--surface)">
        <div style="width:320px;min-width:260px;max-width:38%;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column">
          <div style="padding:10px 12px;border-bottom:1px solid var(--border)">
            <input id="wbxInboxSearch" type="text" value="${esc(qVal)}" oninput="__wbxInboxSearch(this.value)" placeholder="Zoek naam / nummer / e-mail…" style="width:100%;padding:6px 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);color:var(--text-1);font-size:12px;box-sizing:border-box" autocomplete="off" spellcheck="false" />
            <div style="display:flex;gap:4px;margin-top:6px;flex-wrap:wrap">
              ${statusBtn('active', 'Actief')}
              ${statusBtn('afgehandeld', 'Afgehandeld')}
              ${statusBtn('archief', 'Archief')}
              ${statusBtn('all', 'Alle')}
            </div>
          </div>
          <div id="wbxInboxList" style="flex:1;overflow-y:auto;min-height:0">${_inboxConvsListHtml()}</div>
        </div>
        <div style="flex:1;display:flex;flex-direction:column;min-width:0">
          <div style="flex:1;overflow-y:auto;padding:12px 14px;background:var(--surface-2)">${_inboxThreadHtml(convId)}</div>
          ${_inboxComposeHtml(convId)}
        </div>
        <div style="width:300px;min-width:260px;max-width:34%;background:var(--surface);border-left:1px solid var(--border);display:flex;flex-direction:column;min-height:0">
          ${_inboxKlantgegevensHtml(convId)}
        </div>
      </div>
      ${_officeHoursBanner()}
    </div>`;
  }

  /* ── BROK 7 (v=9): Case-sheet overlay (klant-dossier + bellen) ──────
     Full-screen modal via document.body.appendChild (losgekoppeld van
     DFO.render). Secties: open facturen, timeline (WanbetalersTimeline),
     brieven, belgeschiedenis. Softphone via window.KlxSoftphone.call().
     Belpoging-form met custom confirm + race-guard → POST /api/dunning-
     call-log-create. Alle andere reads. */
  _live.caseSheet = {
    invoicesByCust: {},   // cid → { loading, items, error }
    briefsByCust:   {},   // cid → { loading, items, error }
    dossierByCust:  {},   // cid → { loading, data, error } (customer-dossier)
  };
  _ui.caseSheet = { cid: null, tab: 'invoices' };
  _ui.callFormOpen = {};  // cid → true (belpoging-form uit case-sheet)

  async function _fetchCaseInvoices(cid) {
    if (!cid) return;
    const bag = _live.caseSheet.invoicesByCust[cid] = _live.caseSheet.invoicesByCust[cid] || { loading: false, items: [], error: null };
    if (bag.loading) return;
    bag.loading = true; bag.error = null;
    // BROK 9 (v=14, 2026-08-19): fetch status=open i.p.v. status=overdue zodat
    // de count in de sub-tab matched met Overzicht/threadkop (die tellen alle
    // open incl. niet-verlopen). De render markeert verlopen rijen apart via
    // days_overdue > 0 (client-side berekend uit due_date). Voorheen: 5 rijen
    // "Open facturen" terwijl overzicht 7 toonde → verwarring voor incasso.
    const j = await tryFetch('case:invoices:' + cid, `/api/finance-invoices?customer_id=${encodeURIComponent(cid)}&status=open&page_size=100`, 8000);
    if (j && j.error) bag.error = j.error;
    else bag.items = asArr(j?.items);
    bag.loading = false; _renderCaseSheet();
  }
  async function _fetchCaseBriefs(cid) {
    if (!cid) return;
    const bag = _live.caseSheet.briefsByCust[cid] = _live.caseSheet.briefsByCust[cid] || { loading: false, items: [], error: null };
    if (bag.loading) return;
    bag.loading = true; bag.error = null;
    const j = await tryFetch('case:briefs:' + cid, `/api/dunning-briefs-list?customer_id=${encodeURIComponent(cid)}`, 8000);
    if (j && j.error) bag.error = j.error;
    else bag.items = asArr(j?.items);
    bag.loading = false; _renderCaseSheet();
  }

  function _findOvRow(cid) {
    return asArr(_live.overzicht.items).find((x) => String(x.customer_id || x.id) === String(cid)) || null;
  }
  function _customerPhone(row) {
    // BROK 8 fix 1 (v=13): wanbetalers-overzicht-list levert 'customer_phone';
    // fallbacks behouden voor andere shapes (customer-dossier, sales-detail).
    return row?.customer_phone || row?.phone || row?.customer?.phone || row?.mobile_phone || null;
  }

  // Overschrijf de forward-ref uit BROK 9:
  window.__wbxOpenCase = (cid) => {
    if (!cid) return;
    _ui.caseSheet.cid = String(cid);
    _ui.caseSheet.tab = 'invoices';
    // Warm de per-tab data.
    if (!_live.callLog.byCust[cid])  queueMicrotask(() => _fetchCallLog(cid));
    if (!_live.timeline.byCust[cid]) queueMicrotask(() => _fetchTimeline(cid));
    if (!_live.arrangements.byCust) queueMicrotask(_fetchArrangements);
    queueMicrotask(() => _fetchCaseInvoices(cid));
    queueMicrotask(() => _fetchCaseBriefs(cid));
    _openCaseSheetDom();
  };
  window.__wbxCloseCase = () => {
    _ui.caseSheet.cid = null;
    _ui.callFormOpen = {};
    const el = document.getElementById('wbxCaseSheet');
    if (el) el.remove();
    document.removeEventListener('keydown', _caseSheetKey);
  };
  window.__wbxCaseTab = (tab) => {
    _ui.caseSheet.tab = String(tab || 'invoices');
    _renderCaseSheet();
  };

  function _caseSheetKey(e) { if (e.key === 'Escape') window.__wbxCloseCase(); }

  function _openCaseSheetDom() {
    let el = document.getElementById('wbxCaseSheet');
    if (!el) {
      el = document.createElement('div');
      el.id = 'wbxCaseSheet';
      el.style.cssText = 'position:fixed;inset:0;z-index:9500;background:rgba(0,0,0,.42);display:flex;justify-content:center;align-items:center;padding:20px';
      document.body.appendChild(el);
      document.addEventListener('keydown', _caseSheetKey);
    }
    _renderCaseSheet();
  }

  function _renderCaseSheet() {
    const el = document.getElementById('wbxCaseSheet');
    if (!el || !_ui.caseSheet.cid) return;
    el.innerHTML = _caseSheetHtml();
  }

  function _caseSheetHtml() {
    const cid = _ui.caseSheet.cid;
    const row = _findOvRow(cid);
    const name = row?.customer_name || row?.name || 'Onbekend';
    const openAmt = Number.isFinite(Number(row?.total_open_cents)) ? Number(row.total_open_cents) / 100 : 0;
    const days = Number.isFinite(Number(row?.days_overdue)) ? Number(row.days_overdue) : 0;
    // BROK 8 minor: NL-label lookup via PIPELINE_STAGES i.p.v. ruwe slug tonen.
    // Fallback: stages uit /api/dunning-pipeline-stages (BROK 9 _live.stages)
    // → dan slug als laatste redmiddel.
    const stageSlug = row?.stage_slug || row?.stage || null;
    const stageFromApi = (asArr(_live.stages?.items).find((s) => s.slug === stageSlug) || {}).label;
    const stageFromConst = ((typeof PIPELINE_STAGES !== 'undefined' && PIPELINE_STAGES.find((s) => s[0] === stageSlug)) || [])[1];
    const stage = row?.stage_label || stageFromApi || stageFromConst || stageSlug || '—';
    const arrs = (_live.arrangements.byCust || {})[cid] || [];
    const activeArr = arrs.length > 0;
    const phone = _customerPhone(row);
    const tab = _ui.caseSheet.tab || 'invoices';

    const tabBtn = (id, label, count) => `<button class="chip ${tab === id ? 'on' : ''}" style="font-size:11.5px;padding:4px 11px" onclick="__wbxCaseTab('${id}')">${esc(label)}${count != null ? ` <span style="opacity:.6">${count}</span>` : ''}</button>`;

    let body = '';
    if (tab === 'invoices')  body = _caseSheetInvoicesHtml(cid);
    else if (tab === 'timeline') body = _caseSheetTimelineHtml(cid);
    else if (tab === 'briefs')   body = _caseSheetBriefsHtml(cid);
    else if (tab === 'calls')    body = _caseSheetCallsHtml(cid, phone);

    const invCount = asArr(_live.caseSheet.invoicesByCust[cid]?.items).length;
    const tlCount  = asArr(_live.timeline.byCust[cid]).length;
    const brCount  = asArr(_live.caseSheet.briefsByCust[cid]?.items).length;
    const clCount  = asArr(_live.callLog.byCust[cid]).length;

    return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);width:min(960px,100%);max-height:90vh;display:flex;flex-direction:column;overflow:hidden" onclick="event.stopPropagation()">
      <div style="padding:14px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:flex-start;gap:14px">
        <div style="min-width:0;flex:1">
          <div style="font-size:16px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}${activeArr ? ` <span style="font-size:10.5px;padding:2px 8px;border-radius:5px;background:var(--amber-soft);color:var(--amber);font-weight:600;vertical-align:middle;margin-left:6px">⏸ Arrangement</span>` : ''}</div>
          <div style="font-size:12px;color:var(--text-3);margin-top:3px;font-family:'IBM Plex Mono',monospace">${eur(openAmt)} · ${days} dagen · fase <b style="color:var(--text-1)">${esc(stage)}</b></div>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          ${phone ? `<button class="btn btn-primary btn-sm" style="font-size:11.5px" onclick="__wbxCallDial('${esc(cid)}','${esc(phone)}','${esc(name)}')" title="Softphone: ${esc(phone)}">📞 Bel</button>` : ''}
          <button class="icon-btn" onclick="__wbxCloseCase()" title="Sluit (Esc)"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
        </div>
      </div>
      <div style="padding:9px 18px;border-bottom:1px solid var(--border);display:flex;gap:6px;flex-wrap:wrap">
        ${tabBtn('invoices', 'Open facturen', invCount)}
        ${tabBtn('timeline', 'Tijdlijn', tlCount)}
        ${tabBtn('briefs',   'Brieven',  brCount)}
        ${tabBtn('calls',    'Belhistorie', clCount)}
      </div>
      <div style="flex:1;overflow-y:auto;background:var(--surface-2)">${body}</div>
    </div>`;
  }

  function _caseSheetInvoicesHtml(cid) {
    const bag = _live.caseSheet.invoicesByCust[cid] || { loading: true, items: [] };
    if (bag.loading && !bag.items.length) return `<div style="padding:14px">${_skelRows(3)}</div>`;
    if (bag.error && !bag.items.length)   return `<div style="padding:14px">${_errBlkCase(bag.error, 'invoices', cid)}</div>`;
    if (!bag.items.length) return `<div style="padding:34px 18px;text-align:center;color:var(--text-3);font-size:13px">Geen open facturen.</div>`;
    return `<div style="padding:14px 18px">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
        <div style="display:grid;grid-template-columns:130px 1fr 120px 120px;gap:8px;padding:8px 14px;background:var(--surface-2);border-bottom:1px solid var(--border);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);font-weight:600">
          <div>Factuurnr.</div><div>Beschrijving</div><div style="text-align:right">Openstaand</div><div>Vervaldatum</div>
        </div>
        ${bag.items.map((inv) => {
          const num = inv.invoice_number || inv.number || inv.id?.slice(0,8) || '—';
          const desc = inv.description || inv.subject || '—';
          // finance-invoices levert amount_total/amount_paid/credited_amount in euros;
          // open = total - paid - credited. Fallback naar open_amount_cents (dossier) of open_amount (dossier).
          const openEur = inv.open_amount != null
            ? Number(inv.open_amount)
            : (inv.open_amount_cents != null ? Number(inv.open_amount_cents) / 100
              : Math.max(0, (Number(inv.amount_total) || 0) - (Number(inv.amount_paid) || 0) - (Number(inv.credited_amount) || 0)));
          const cents = Math.round(openEur * 100);
          const due = inv.due_date || inv.due_on || null;
          // Client-side days_overdue als server niet levert (finance-invoices doet niet).
          let overdue = Number(inv.days_overdue || 0);
          if (!overdue && due) {
            const t = new Date(due).getTime();
            if (Number.isFinite(t)) overdue = Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
          }
          return `<div style="display:grid;grid-template-columns:130px 1fr 120px 120px;gap:8px;padding:9px 14px;border-bottom:1px solid var(--border);font-size:12.5px;align-items:center">
            <div style="font-family:'IBM Plex Mono',monospace">${esc(num)}</div>
            <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(desc)}</div>
            <div style="text-align:right;font-family:'IBM Plex Mono',monospace">${eur(cents / 100)}</div>
            <div style="font-size:11.5px;color:${overdue > 0 ? 'var(--rose)' : 'var(--text-3)'}">${esc(_fmtDate(due))}${overdue > 0 ? ` · <b>${overdue}d</b>` : ''}</div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  function _caseSheetTimelineHtml(cid) {
    const st = _live.timeline;
    if (st.loading && !st.byCust[cid]) return `<div style="padding:14px">${_skelRows(4)}</div>`;
    const items = asArr(st.byCust[cid]);
    if (!items.length) return `<div style="padding:34px 18px;text-align:center;color:var(--text-3);font-size:13px">Geen tijdlijn-events.</div>`;
    // Gebruik gedeelde WanbetalersTimeline.describe(item) → { icon, title } als beschikbaar.
    const WT = window.WanbetalersTimeline || null;
    // BROK 8 minor: NL-labels voor tijdlijn-enums (pending_actions action_types).
    // WanbetalersTimeline dekt de meeste, maar MANUAL_* / TL_* lekten door.
    const ENUM_NL = {
      MANUAL_CONFIRM_PROMISE:    'Handmatig: betaal-toezegging bevestigd',
      MANUAL_VERIFY_PAYMENT:     'Handmatig: betaling verifiëren',
      MANUAL_PROPOSE_ARRANGEMENT:'Handmatig: arrangement voorstellen',
      MANUAL_FOLLOWUP:           'Handmatig: opvolg-actie',
      MANUAL_ESCALATION:         'Handmatig: escalatie',
      TL_INVOICE_UPDATE_DUE:     'TL: factuur-vervaldatum bijwerken',
      TL_INVOICE_SPLIT:          'TL: factuur splitsen (termijnen)',
      TL_SUBSCRIPTION_PAUSE:     'TL: abonnement pauzeren',
      TL_SUBSCRIPTION_STOP:      'TL: abonnement stoppen',
      TL_INVOICE_WRITEOFF:       'TL: factuur afschrijven',
    };
    const nlLabel = (raw) => ENUM_NL[raw] || raw;
    return `<div style="padding:14px 18px">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r)">
        ${items.map((it) => {
          const d = WT?.describe ? WT.describe(it) : { icon: '·', title: it.title || it.type };
          const actor = it.actor?.name || '';
          const rawTitle = d.title || it.title || it.type || 'Event';
          const title = nlLabel(rawTitle);
          return `<div style="padding:10px 14px;border-bottom:1px solid var(--border);display:flex;gap:10px;font-size:12.5px">
            <div style="font-size:15px;line-height:1;color:var(--text-3);min-width:20px;text-align:center">${esc(d.icon || '·')}</div>
            <div style="flex:1;min-width:0">
              <div style="font-weight:600">${esc(title)}</div>
              ${it.description ? `<div style="font-size:11.5px;color:var(--text-3);margin-top:2px">${esc(it.description)}</div>` : ''}
              <div style="font-size:10.5px;color:var(--text-3);margin-top:3px;font-family:'IBM Plex Mono',monospace">${esc(_fmtDateTime(it.at))}${actor ? ` · ${esc(actor)}` : ''}</div>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  function _caseSheetBriefsHtml(cid) {
    const bag = _live.caseSheet.briefsByCust[cid] || { loading: true, items: [] };
    if (bag.loading && !bag.items.length) return `<div style="padding:14px">${_skelRows(2)}</div>`;
    if (bag.error && !bag.items.length)   return `<div style="padding:14px">${_errBlkCase(bag.error, 'briefs', cid)}</div>`;
    if (!bag.items.length) return `<div style="padding:34px 18px;text-align:center;color:var(--text-3);font-size:13px">Geen brieven.</div>`;
    return `<div style="padding:14px 18px">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
        ${bag.items.map((b) => {
          const tpl = b.template_code || '—';
          const when = b.generated_at || b.created_at;
          const sent = b.sent_at || b.sent_via;
          const url = b.download_url || null;
          return `<div style="display:grid;grid-template-columns:140px 1fr 120px auto;gap:8px;padding:9px 14px;border-bottom:1px solid var(--border);font-size:12.5px;align-items:center">
            <div style="font-family:'IBM Plex Mono',monospace;font-size:11.5px">${esc(tpl)}</div>
            <div style="color:var(--text-3);font-size:11.5px">${sent ? `Verstuurd${b.sent_via ? ' · ' + esc(b.sent_via) : ''}` : 'Aangemaakt'}</div>
            <div class="mono" style="color:var(--text-3)">${esc(_fmtDate(when))}</div>
            <div>${url ? `<a class="btn btn-ghost btn-sm" style="font-size:11px" href="${esc(url)}" target="_blank" rel="noopener">PDF →</a>` : '—'}</div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  function _caseSheetCallsHtml(cid, phone) {
    const items = asArr(_live.callLog.byCust[cid]);
    const formOpen = !!_ui.callFormOpen[cid];
    const rowsHtml = items.length ? items.map((c) => {
      const outcome = c.outcome || '—';
      const at = _fmtDateTime(c.attempted_at || c.created_at);
      const cb = c.callback_at ? `<span style="color:var(--amber);font-size:11px"> · terugbellen ${esc(_fmtDateTime(c.callback_at))}</span>` : '';
      const note = c.note ? `<div style="font-size:11.5px;color:var(--text-3);margin-top:3px">${esc(c.note)}</div>` : '';
      return `<div style="padding:9px 14px;border-bottom:1px solid var(--border);font-size:12.5px">
        <div><b>${esc(outcome)}</b> ${cb}</div>
        <div style="font-size:11px;color:var(--text-3);font-family:'IBM Plex Mono',monospace;margin-top:2px">${esc(at)}${c.created_by_name ? ' · ' + esc(c.created_by_name) : ''}</div>
        ${note}
      </div>`;
    }).join('') : `<div style="padding:34px 18px;text-align:center;color:var(--text-3);font-size:13px">Geen belpogingen.</div>`;

    const formHtml = formOpen ? _caseSheetCallFormHtml(cid) : `<div style="padding:12px 18px;text-align:right"><button class="btn btn-primary btn-sm" style="font-size:11.5px" onclick="__wbxCaseCallOpen('${esc(cid)}')" ${_rbac.canExecute ? '' : 'disabled title="Geen rechten (finance.dunning.execute)"'}>+ Belpoging loggen</button></div>`;

    return `<div>${formHtml}<div style="padding:0 18px 18px">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r)">${rowsHtml}</div>
    </div></div>`;
  }

  function _caseSheetCallFormHtml(cid) {
    const f = _ui.callForm[cid] = _ui.callForm[cid] || { outcome: '', note: '', callback_at: '', saving: false, error: null };
    const outcomes = [
      ['no_answer', 'Geen gehoor'], ['voicemail', 'Voicemail'], ['callback', 'Terugbelafspraak'],
      ['payment_promise', 'Betaaltoezegging'], ['payment_plan', 'Regeling voorgesteld'],
      ['refused', 'Weigert'], ['wrong_number', 'Verkeerd nummer'],
      ['paid_during_call', 'Betaald tijdens gesprek'], ['disputed', 'Betwist'], ['info_sent', 'Info verzonden'],
    ];
    const needsCb = f.outcome === 'callback';
    return `<div style="padding:14px 18px;background:var(--surface);border-bottom:1px solid var(--border)">
      <div style="font-size:12.5px;font-weight:600;margin-bottom:9px">Belpoging loggen</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-bottom:9px">
        <div>
          <label style="font-size:10.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;font-weight:600">Uitkomst *</label>
          <select onchange="__wbxCaseCallField('${esc(cid)}','outcome',this.value)" style="width:100%;font-size:12.5px;padding:6px 8px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface-2);color:var(--text-1);margin-top:3px">
            <option value="">— kies —</option>
            ${outcomes.map(([v, l]) => `<option value="${esc(v)}" ${f.outcome === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}
          </select>
        </div>
        <div style="${needsCb ? '' : 'opacity:.5'}">
          <label style="font-size:10.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;font-weight:600">Terugbellen op${needsCb ? ' *' : ''}</label>
          <input type="datetime-local" value="${esc(f.callback_at || '')}" oninput="__wbxCaseCallField('${esc(cid)}','callback_at',this.value)" ${needsCb ? '' : 'disabled'} style="width:100%;font-size:12.5px;padding:6px 8px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface-2);color:var(--text-1);margin-top:3px" />
        </div>
      </div>
      <div>
        <label style="font-size:10.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;font-weight:600">Notitie</label>
        <textarea oninput="__wbxCaseCallField('${esc(cid)}','note',this.value)" rows="2" style="width:100%;font-size:12.5px;padding:6px 8px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface-2);color:var(--text-1);margin-top:3px;resize:vertical;font-family:inherit">${esc(f.note || '')}</textarea>
      </div>
      <div id="wbxCaseCallErr_${esc(cid)}">${f.error ? `<div style="color:var(--rose);font-size:11.5px;margin-top:6px">⚠ ${esc(f.error)}</div>` : ''}</div>
      <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:9px">
        <button class="btn btn-ghost btn-sm" style="font-size:11.5px" onclick="__wbxCaseCallCancel('${esc(cid)}')">Annuleren</button>
        <button class="btn btn-primary btn-sm" style="font-size:11.5px" onclick="__wbxCaseCallSave('${esc(cid)}')" ${f.saving ? 'disabled' : ''}>${f.saving ? 'Bezig…' : 'Log belpoging'}</button>
      </div>
    </div>`;
  }

  // BROK 9.1 (v=15): surgical err-clear voor case-sheet call-form.
  // v=14-fix zat op de dode __wbxCallSet* (gesprekkenView) — nutteloos want
  // die view is niet geregistreerd. De LEVENDE case-sheet gebruikt
  // __wbxCaseCallField die alleen re-rendert bij field==='outcome' →
  // foutregel bleef zichtbaar bij invullen datum/notitie. Nu: surgical
  // DOM-clear van #wbxCaseCallErr_<cid> bij elk veld-input (behoudt focus).
  function _updateCaseCallErrRow(cid) {
    const el = document.getElementById('wbxCaseCallErr_' + cid);
    if (!el) return;
    const f = _ui.callForm[cid] || {};
    el.innerHTML = f.error
      ? `<div style="color:var(--rose);font-size:11.5px;margin-top:6px">⚠ ${esc(f.error)}</div>`
      : '';
  }
  window.__wbxCaseCallOpen = (cid) => {
    if (!_rbac.canExecute) { _toast('Geen rechten (finance.dunning.execute).', 'error'); return; }
    _ui.callFormOpen[cid] = true; _renderCaseSheet();
  };
  window.__wbxCaseCallCancel = (cid) => { _ui.callFormOpen[cid] = false; delete _ui.callForm[cid]; _renderCaseSheet(); };
  window.__wbxCaseCallField = (cid, field, val) => {
    _ui.callForm[cid] = _ui.callForm[cid] || {};
    _ui.callForm[cid][field] = val;
    // BROK 9.1 fix: wissen inline-fout zodra user het probleem oplost.
    if (_ui.callForm[cid].error) {
      _ui.callForm[cid].error = null;
      _updateCaseCallErrRow(cid);   // surgical DOM-clear
    }
    if (field === 'outcome') _renderCaseSheet(); // callback-veld enable/disable
  };
  window.__wbxCaseCallSave = async (cid) => {
    if (!_rbac.canExecute) { _toast('Geen rechten.', 'error'); return; }
    const f = _ui.callForm[cid] || {};
    if (!f.outcome) { f.error = 'Kies een uitkomst.'; _renderCaseSheet(); return; }
    if (f.outcome === 'callback' && !f.callback_at) { f.error = 'Terugbeltijd verplicht bij callback.'; _renderCaseSheet(); return; }
    if (f.saving) return;
    const row = _findOvRow(cid);
    const name = row?.customer_name || row?.name || 'klant';
    const cbLine = f.callback_at ? `<div><b>Terugbellen:</b> ${esc(_fmtDateTime(new Date(f.callback_at).toISOString()))}</div>` : '';
    const noteLine = f.note ? `<div style="margin-top:6px"><b>Notitie:</b> ${esc(f.note)}</div>` : '';
    const ok = await _askConfirm('Belpoging loggen?', `<div><b>Klant:</b> ${esc(name)}</div><div><b>Uitkomst:</b> ${esc(f.outcome)}</div>${cbLine}${noteLine}`, { okLabel: 'Ja, log' });
    if (!ok) return;
    f.saving = true; f.error = null; _renderCaseSheet();
    const body = { customer_id: String(cid), outcome: f.outcome };
    if (f.note) body.note = f.note;
    if (f.outcome === 'callback' && f.callback_at) body.callback_at = new Date(f.callback_at).toISOString();
    // BROK 7 RECON: endpoint = dunning-call-log-create (niet -save)
    const r = await apiPost('/api/dunning-call-log-create', body);
    f.saving = false;
    if (!r.ok) { f.error = r.error || 'Kon niet loggen.'; _renderCaseSheet(); return; }
    _ui.callFormOpen[cid] = false; delete _ui.callForm[cid];
    // Cache invalideren + refetch.
    delete _live.callLog.byCust[cid];
    _fetchCallLog(cid);
    _toast('Belpoging gelogd.', 'success');
    _renderCaseSheet();
  };

  window.__wbxCallDial = async (cid, phone, name) => {
    if (!phone) { _toast('Geen telefoonnummer bekend.', 'error'); return; }
    // BROK 9 (v=14, 2026-08-19): custom confirm VÓÓR het bellen. Eén-klik-
    // bel is in een incasso-scherm te riskant (per ongeluk klikken, dubbele
    // klik na open case-sheet, WA-nummer waar je niet meteen wilde bellen).
    // Nu: confirm-modal met klant + nummer, pas op OK KlxSoftphone / tel:.
    const ok = await _askConfirm(
      'Bellen naar ' + (name || 'klant') + '?',
      '<div><b>Klant:</b> ' + esc(name || 'onbekend') + '</div>'
      + '<div><b>Nummer:</b> <span style="font-family:\'IBM Plex Mono\',monospace">' + esc(phone) + '</span></div>'
      + '<div style="font-size:11.5px;color:var(--text-3);margin-top:6px">Softphone start of tel:-link opent.</div>',
      { okLabel: 'Bellen' }
    );
    if (!ok) return;
    try {
      if (window.KlxSoftphone && typeof window.KlxSoftphone.call === 'function') {
        const r = await window.KlxSoftphone.call(String(phone), { displayName: String(name || '') });
        if (r && r.ok === false) { _toast('Bellen faalde: ' + (r.error || 'onbekend'), 'error'); return; }
        _toast(`Belt ${name || phone}…`, 'success');
      } else {
        // Fallback: browser tel:-link.
        window.location.href = 'tel:' + encodeURIComponent(String(phone));
      }
    } catch (e) {
      _toast('Belfout: ' + (e?.message || e), 'error');
    }
  };

  window.__wbxRetryCase = (what, cid) => {
    if (what === 'invoices') { delete _live.caseSheet.invoicesByCust[cid]; _fetchCaseInvoices(cid); }
    if (what === 'briefs')   { delete _live.caseSheet.briefsByCust[cid];   _fetchCaseBriefs(cid); }
    _renderCaseSheet();
  };
  function _errBlkCase(msg, what, cid) {
    return `<div style="padding:14px 16px;background:var(--rose-soft);border:1px solid var(--rose-line, var(--rose));color:var(--rose);border-radius:var(--r);font-size:13px;display:flex;justify-content:space-between;align-items:center;gap:12px">
      <span>⚠ ${esc(msg)}</span>
      <button class="btn btn-ghost btn-sm" onclick="__wbxRetryCase('${esc(what)}','${esc(cid)}')">Opnieuw</button>
    </div>`;
  }

  /* ── BROK 9 (v=8): Pipeline-kanban per dunning-fase ─────────────────
     Kolommen uit /api/dunning-pipeline-stages (is_active=true). Kaarten
     uit gedeelde _live.overzicht.items — geen extra fetch. Per kaart
     "Verplaats naar…" dropdown → __wbxSetStage (met custom confirm en
     terminal-warning). Klik op kaart → __wbxOpenCase(cid) (BROK 7). */
  _live.stages = { loading: false, fetched: false, error: null, items: [], _seq: 0 };

  async function _fetchStages() {
    const st = _live.stages;
    if (st.loading) return;
    const mySeq = ++st._seq;
    st.loading = true; st.error = null;
    const j = await tryFetch('stages', '/api/dunning-pipeline-stages', 8000);
    if (mySeq !== st._seq) return;
    if (j && j.error) { st.error = j.error; st.loading = false; try { window.DFO?.render?.(); } catch (_) {} return; }
    st.items = asArr(j?.items);
    st.fetched = true; st.loading = false;
    try { window.DFO?.render?.(); } catch (_) {}
  }
  window.__wbxRetryStages = () => { _live.stages.fetched = false; _fetchStages(); };

  // BROK 7 forward-ref: overschreven door case-sheet. Fallback = Gesprekken-drilldown.
  if (typeof window.__wbxOpenCase !== 'function') {
    window.__wbxOpenCase = (cid) => {
      try { window.__wbxGspSelect && window.__wbxGspSelect(cid); } catch (_) {}
    };
  }

  function pipelineView() {
    if (!_live.stages.fetched && !_live.stages.loading && !_live.stages.error) queueMicrotask(_fetchStages);
    if (!_live.overzicht.fetched && !_live.overzicht.loading && !_live.overzicht.error) queueMicrotask(_fetchOverzicht);
    if (!_live.arrangements.fetched && !_live.arrangements.loading && !_live.arrangements.error) queueMicrotask(_fetchArrangements);

    if ((_live.stages.loading && !_live.stages.fetched) || (_live.overzicht.loading && !_live.overzicht.fetched)) {
      return `<div class="pad" style="padding:14px 20px">${_skelRows(4)}</div>`;
    }
    if (_live.stages.error && !_live.stages.fetched) {
      return `<div class="pad" style="padding:14px 20px">${_errBlk(_live.stages.error, 'stages')}</div>`;
    }
    if (_live.overzicht.error && !_live.overzicht.fetched) {
      return `<div class="pad" style="padding:14px 20px">${_errBlk(_live.overzicht.error, 'overzicht')}</div>`;
    }

    const stages = asArr(_live.stages.items);
    const items  = asArr(_live.overzicht.items);
    const arrsMap = _live.arrangements.byCust || {};

    // Group items per stage.
    const bySlug = {};
    for (const s of stages) bySlug[s.slug] = [];
    for (const r of items) {
      const slug = r.stage_slug || 'nieuw';
      if (!bySlug[slug]) bySlug[slug] = [];
      bySlug[slug].push(r);
    }

    // Stage-options voor de "Verplaats naar" dropdown (alle actieve stages).
    const stageOpts = stages.map((s) =>
      `<option value="${esc(s.slug)}">${esc(s.label || s.slug)}${s.is_terminal ? ' ⛔' : ''}</option>`
    ).join('');

    const columns = stages.map((s) => {
      const rows = bySlug[s.slug] || [];
      const totalOpen = rows.reduce((acc, r) => acc + (Number.isFinite(Number(r.total_open_cents)) ? Number(r.total_open_cents) : 0), 0) / 100;
      const color = s.color || 'var(--brand,#0A7490)';
      const cards = rows.length ? rows.map((r) => {
        const cid       = String(r.customer_id || r.id);
        const name      = r.customer_name || r.name || 'Onbekend';
        const openAmt   = Number.isFinite(Number(r.total_open_cents)) ? Number(r.total_open_cents) / 100 : 0;
        const days      = Number.isFinite(Number(r.days_overdue)) ? Number(r.days_overdue) : 0;
        const invCount  = Number.isFinite(Number(r.open_invoice_count)) ? Number(r.open_invoice_count) : 0;
        const busy      = !!_ui.stageBusy[cid];
        const activeArr = Array.isArray(arrsMap[cid]) && arrsMap[cid].length > 0;
        const pauseBadge = activeArr
          ? `<span style="font-size:9.5px;padding:1px 6px;border-radius:5px;background:var(--amber-soft);color:var(--amber);font-weight:600;margin-left:5px" title="Actief arrangement — dunning gepauzeerd">⏸ ARR</span>`
          : '';
        return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r-sm);padding:9px 11px;margin-bottom:8px;cursor:pointer;transition:transform .08s ease" onclick="__wbxOpenCase('${esc(cid)}')" onmouseover="this.style.transform='translateY(-1px)'" onmouseout="this.style.transform='translateY(0)'">
          <div style="font-weight:600;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}${pauseBadge}</div>
          <div style="font-size:11px;color:var(--text-3);margin-top:3px;font-family:'IBM Plex Mono',monospace">${eur(openAmt)} · ${days}d · ${invCount} fact</div>
          <div style="margin-top:6px" onclick="event.stopPropagation()">
            <select onchange="if(this.value){__wbxSetStage('${esc(cid)}',this.value);this.value='';}" style="width:100%;font-size:10.5px;padding:3px 6px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface-2);color:var(--text-1);cursor:pointer" ${busy ? 'disabled' : ''}>
              <option value="">Verplaats naar…</option>
              ${stageOpts}
            </select>
          </div>
        </div>`;
      }).join('') : `<div style="padding:22px 8px;text-align:center;color:var(--text-3);font-size:11px;font-style:italic">Leeg</div>`;

      return `<div style="min-width:240px;flex:1;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r);padding:10px;display:flex;flex-direction:column">
        <div style="padding-bottom:8px;margin-bottom:8px;border-bottom:2px solid ${color}">
          <div style="display:flex;justify-content:space-between;align-items:baseline">
            <b style="font-size:12.5px;text-transform:uppercase;letter-spacing:.04em;color:${color}">${esc(s.label || s.slug)}${s.is_terminal ? ' ⛔' : ''}</b>
            <span style="font-size:11px;color:var(--text-3);font-weight:600">${rows.length}</span>
          </div>
          <div style="font-size:10.5px;color:var(--text-3);font-family:'IBM Plex Mono',monospace;margin-top:2px">${eur0(totalOpen)}</div>
        </div>
        <div style="overflow-y:auto;max-height:calc(100vh - 260px)">${cards}</div>
      </div>`;
    }).join('');

    return `<div data-wbx-view="pipeline">
      <div class="pad" style="padding:14px 20px">
        <div style="display:flex;gap:10px;overflow-x:auto;padding-bottom:14px;align-items:stretch">
          ${columns}
        </div>
        <div style="font-size:11px;color:var(--text-3);padding:6px 2px">Klik een kaart voor case-sheet · Verplaats via dropdown (custom confirm + audit-log) · ⛔ = terminale fase (motor stopt).</div>
      </div>
    </div>`;
  }

  /* ── BROK 10 (v=7): Motor-monitoring (PUUR read) ─────────────────────
     Statusstrip (kantooruren-venster + cooldown + sandbox), KPI-grid
     (pending / acties-vandaag / incasso / arrangements-actief), bulk-jobs.
     Poll 18s met document.hidden pause. GEEN writes. */
  _live.motor = {
    loading: false, fetched: false, error: null, _seq: 0,
    data: {
      cooldownDays: null,
      pipelineToggles: null,
      pendingCounts: { PENDING: 0, APPROVED: 0, REJECTED: 0, EXECUTED: 0, FAILED: 0 },
      pipelineKpis: { appointments_today: 0, awaiting_reply: 0, stale_count: 0 },
      bulkJobs: [],
      incassoByStatus: {},
      arrActiveTotal: 0,
    },
  };
  _ui.motorPollTimer = null;

  // BROK 10-fix (v=11): canonical poll teardown-pattern, spiegel van
  // lisa-v2 / inbox-v2 / leadsonderhoud-v2 / onboarding-v2. Tick checkt
  // eerst of data-wbx-view="motor" nog in DOM zit; als user weg-genaviged
  // is (tab-wissel binnen shell OF module-unload) → clearInterval en stop.
  function _startMotorPoll() {
    if (_ui.motorPollTimer) return;
    _ui.motorPollTimer = setInterval(_motorPollTick, 18_000);
  }
  function _stopMotorPoll() {
    if (_ui.motorPollTimer) { try { clearInterval(_ui.motorPollTimer); } catch (_) {} _ui.motorPollTimer = null; }
  }
  function _motorPollTick() {
    // Tab-leave / module-unload detectie via DOM-marker (motorView zet
    // data-wbx-view="motor"). Weg → stop de poll voor de rest van de sessie
    // tot user 'm zelf heropent (motorView() start dan _startMotorPoll opnieuw).
    if (!document.querySelector('[data-wbx-view="motor"]')) { _stopMotorPoll(); return; }
    if (typeof document !== 'undefined' && document.hidden) return;
    _live.motor.fetched = false; _fetchMotor();
  }
  window.addEventListener('beforeunload', _stopMotorPoll);

  async function _fetchMotor() {
    const st = _live.motor;
    if (st.loading) return;
    const mySeq = ++st._seq;
    st.loading = true; st.error = null;
    try {
      // BROK 8 fix 6 (v=13): per-endpoint error onderscheiden van echt-leeg.
      // Voorheen: bij fetch-fout viel elke `?? default` terug op nullen/lege
      // arrays → UI toonde "Geen bulk-jobs" / "0 acties" alsof dat waar was.
      // Nu: sub-error-flags per endpoint zodat de UI expliciet kan onderscheiden
      // FOUT (toon errblk + Opnieuw) vs LEEG (toon lege-lijst-tekst).
      // Ook: sandbox_mode uit app-settings meenemen (minor: motor sandbox aan/uit).
      const [settings, toggles, pending, pipe, bulk, inc, arr, sandboxRaw] = await Promise.all([
        tryFetch('motor:settings',   '/api/dunning-settings-get',                                    8000),
        tryFetch('motor:toggles',    '/api/dunning-pipeline-settings',                               8000),
        tryFetch('motor:pending',    '/api/pending-actions-list?limit=1',                            8000),
        tryFetch('motor:pipeline',   '/api/dunning-pipeline-actions',                                8000),
        tryFetch('motor:bulk',       '/api/wanbetalers-bulk-jobs-list?limit=25',                     8000),
        tryFetch('motor:incasso',    '/api/incasso-dossiers-list',                                   8000),
        tryFetch('motor:arr',        '/api/arrangements-list?status=ACTIEF&limit=1',                 8000),
        // BROK 9 (v=14, 2026-08-19): key was 'dunning_sandbox_mode' → 404.
        // Server-key is 'dunning_dry_run' (bron: api/_lib/dunning-dry-run.js
        // regel 20 DRY_RUN_KEY). Value-shape: { enabled: true|false }.
        tryFetch('motor:sandbox',    '/api/app-settings?key=dunning_dry_run',                        8000),
      ]);
      if (mySeq !== st._seq) return;
      const incCounts = {};
      const incOk = !!inc && !inc.error;
      if (incOk) for (const r of asArr(inc?.items)) {
        const s = String(r.status || 'unknown');
        incCounts[s] = (incCounts[s] || 0) + 1;
      }
      // Sandbox-flag: app_settings.dunning_dry_run heeft shape { enabled: bool }.
      // Fallback: als key niet bestaat in DB, server returnt { key, value: null }
      // → dan value.enabled undefined → sandboxEnabled = false (default = live).
      let sandboxEnabled = null;
      if (sandboxRaw && !sandboxRaw.error) {
        const v = sandboxRaw?.value;
        if (v && typeof v === 'object' && 'enabled' in v) sandboxEnabled = v.enabled === true;
        else if (v === true || v === 'true') sandboxEnabled = true;
        else if (v === false || v === 'false' || v === null) sandboxEnabled = false;
      }
      st.data = {
        cooldownDays:     (settings && !settings.error && Number.isFinite(Number(settings.dunning_cooldown_days))) ? Number(settings.dunning_cooldown_days) : null,
        pipelineToggles:  (toggles && !toggles.error) ? (toggles.toggles || null) : null,
        pendingCounts:    (pending && !pending.error) ? (pending.counts || { PENDING: 0, APPROVED: 0, REJECTED: 0, EXECUTED: 0, FAILED: 0 }) : null,
        pipelineKpis:     (pipe && !pipe.error) ? (pipe.kpis || { appointments_today: 0, awaiting_reply: 0, stale_count: 0 }) : null,
        bulkJobs:         (bulk && !bulk.error) ? asArr(bulk.items) : null,
        incassoByStatus:  incOk ? incCounts : null,
        arrActiveTotal:   (arr && !arr.error && Number.isFinite(Number(arr.total))) ? Number(arr.total) : null,
        sandboxEnabled,
        // sub-error-flags voor UI-render (fault vs leeg-scherm onderscheid)
        errs: {
          settings: !settings || !!settings.error,
          toggles:  !toggles  || !!toggles.error,
          pending:  !pending  || !!pending.error,
          pipe:     !pipe     || !!pipe.error,
          bulk:     !bulk     || !!bulk.error,
          incasso:  !inc      || !!inc.error,
          arr:      !arr      || !!arr.error,
          sandbox:  !sandboxRaw || !!sandboxRaw.error,
        },
      };
      st.fetched = true;
    } catch (e) {
      if (mySeq === st._seq) st.error = e?.message || 'Kon monitoring niet laden.';
    } finally {
      if (mySeq === st._seq) st.loading = false;
      try { window.DFO && window.DFO.render && window.DFO.render(); } catch (_) {}
    }
  }
  window.__wbxRetryMotor = () => { _live.motor.fetched = false; _fetchMotor(); };

  function _isOfficeHoursNow() {
    // Europe/Amsterdam 08:00-20:00 (CLAUDE.md convention). Client-side
    // benadering — precieze server-side check zit in _lib/dunning-office-hours.
    try {
      const now = new Date();
      const fmt = new Intl.DateTimeFormat('nl-NL', { timeZone: 'Europe/Amsterdam', hour: 'numeric', hour12: false });
      const h = Number(fmt.format(now));
      return Number.isFinite(h) && h >= 8 && h < 20;
    } catch (_) { return null; }
  }

  function motorView() {
    if (!_live.motor.fetched && !_live.motor.loading && !_live.motor.error) queueMicrotask(_fetchMotor);
    // Poll 18s met document.hidden pause + auto-stop op tab-leave / unload.
    _startMotorPoll();
    if (_live.motor.loading && !_live.motor.fetched) {
      return `<div class="pad" style="padding:14px 20px">${_skelKpis()}${_skelRows(5)}</div>`;
    }
    if (_live.motor.error && !_live.motor.fetched) {
      return `<div class="pad" style="padding:14px 20px">${_errBlkMotor(_live.motor.error)}</div>`;
    }

    const d = _live.motor.data;
    const errs = d.errs || {};
    const isOpen = _isOfficeHoursNow();
    const openBadge = isOpen === true
      ? `<span style="font-size:11px;padding:2px 8px;border-radius:6px;background:var(--emerald-soft);color:var(--emerald);font-weight:600">Nu open</span>`
      : isOpen === false
        ? `<span style="font-size:11px;padding:2px 8px;border-radius:6px;background:var(--amber-soft);color:var(--amber);font-weight:600">Nu dicht</span>`
        : `<span style="font-size:11px;padding:2px 8px;border-radius:6px;background:var(--surface-2);color:var(--text-3)">?</span>`;
    const toggles = d.pipelineToggles || {};
    const activeToggles = ['on_overdue_to_nieuw','on_bulk_sent_to_aangemaand','on_inbound_to_in_gesprek','on_paid_to_opgelost']
      .filter((k) => toggles[k] !== false).length;

    // Sandbox-badge: expliciet aan/uit/onbekend (BROK 8 minor).
    const sbBadge = d.sandboxEnabled === true
      ? `<span style="font-size:11px;padding:2px 8px;border-radius:6px;background:var(--amber-soft);color:var(--amber);font-weight:600">Sandbox AAN</span>`
      : d.sandboxEnabled === false
        ? `<span style="font-size:11px;padding:2px 8px;border-radius:6px;background:var(--emerald-soft);color:var(--emerald);font-weight:600">Sandbox UIT</span>`
        : `<span style="font-size:11px;padding:2px 8px;border-radius:6px;background:var(--surface-2);color:var(--text-3)">Sandbox ?</span>`;

    // BROK 8 fix 6: KPI-cell die "?" toont bij fetch-fout i.p.v. 0.
    // BROK 9.1 (v=15): retry-knop naast ⚠ op elke motor-tegel/pill die
    // sub-endpoint-fout heeft. Voorheen: alleen icoon, user moest hele
    // tab-refresh. Nu: klein "↻" naast ⚠ → __wbxRetryMotor (herlaadt alle
    // motor-endpoints tegelijk; per-endpoint retry zou overkill zijn).
    const errMark = '<span style="color:var(--rose);font-size:14px" title="Kon niet laden">⚠</span> <button class="btn btn-ghost btn-sm" style="font-size:10px;padding:1px 6px;margin-left:4px" onclick="__wbxRetryMotor()" title="Opnieuw laden">↻</button>';
    const kpiVal = (val, isErr) => isErr ? errMark : (val == null ? '—' : val);
    const kpis = [
      ['Openstaand approvals',
        kpiVal(d.pendingCounts?.PENDING || 0, errs.pending),
        'var(--amber)'],
      ['Acties vandaag',
        kpiVal((d.pipelineKpis?.appointments_today || 0) + (d.pipelineKpis?.awaiting_reply || 0) + (d.pipelineKpis?.stale_count || 0), errs.pipe),
        'var(--brand,#0A7490)'],
      ['Incasso actief',
        kpiVal((d.incassoByStatus?.lopend || 0) + (d.incassoByStatus?.aangemeld || 0), errs.incasso),
        'var(--rose)'],
      // BROK 9 (v=14) label expliciet: motor telt arrangements-list.total
      // (records), overzicht telt distinct klanten. Verschillende metrics
      // → verschillende labels om verwarring te voorkomen.
      ['Actieve arrangementen (records)',
        kpiVal(d.arrActiveTotal, errs.arr),
        'var(--emerald)'],
    ];

    const bulkJobsArr = asArr(d.bulkJobs);
    const bulkRows = errs.bulk
      ? `<div style="padding:14px">${_errBlkMotor('Kon bulk-jobs niet laden.')}</div>`
      : (bulkJobsArr.length ? bulkJobsArr.map((j) => {
      const st = String(j.status || '');
      const tone = st === 'running' ? 'var(--amber)' : st === 'completed' ? 'var(--emerald)' : st === 'cancelled' ? 'var(--rose)' : 'var(--text-3)';
      const total = Number(j.total_recipients) || 0;
      const sent  = Number(j.sent_count) || 0;
      const failed = Number(j.failed_count) || 0;
      const when = j.completed_at || j.approved_at || j.created_at;
      return `<div style="display:grid;grid-template-columns:1fr 90px 130px 150px 130px;gap:8px;padding:9px 14px;border-bottom:1px solid var(--border);font-size:12.5px;align-items:center">
        <div style="min-width:0"><div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(j.template_name || 'Bulk-job')}</div><div style="font-size:11px;color:var(--text-3);font-family:'IBM Plex Mono',monospace">${esc(j.channel || '')}</div></div>
        <div style="font-size:11px;font-weight:600;color:${tone}">${esc(st)}</div>
        <div class="mono" style="text-align:right;color:var(--text-3)">${sent}/${total}${failed ? ` <span style="color:var(--rose)">(-${failed})</span>` : ''}</div>
        <div style="font-size:11px;color:var(--text-3)">${esc(_fmtDateTime(when))}</div>
        <div style="font-size:11px;color:var(--text-3);text-align:right">${esc(j.id).slice(0, 8)}</div>
      </div>`;
    }).join('') : `<div style="padding:34px 20px;text-align:center;color:var(--text-3);font-size:13px">Geen bulk-jobs.</div>`);

    return `<div data-wbx-view="motor">
      <div class="pad" style="padding:14px 20px">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:12px 16px;margin-bottom:14px;display:flex;gap:14px;flex-wrap:wrap;align-items:center;font-size:12.5px">
          <div><span style="color:var(--text-3);font-size:11px;text-transform:uppercase;letter-spacing:.06em;font-weight:600">Kantooruren</span> <span style="font-family:'IBM Plex Mono',monospace">08:00–20:00 NL</span> ${openBadge}</div>
          <div style="width:1px;height:22px;background:var(--border)"></div>
          <div><span style="color:var(--text-3);font-size:11px;text-transform:uppercase;letter-spacing:.06em;font-weight:600">Cooldown</span> <b>${d.cooldownDays == null ? '—' : d.cooldownDays + ' dgn'}</b></div>
          <div style="width:1px;height:22px;background:var(--border)"></div>
          <div><span style="color:var(--text-3);font-size:11px;text-transform:uppercase;letter-spacing:.06em;font-weight:600">Pipeline-auto</span> <b>${errs.toggles ? errMark : activeToggles + '/4 aan'}</b></div>
          <div style="width:1px;height:22px;background:var(--border)"></div>
          ${sbBadge}
          <div style="margin-left:auto;font-size:11px;color:var(--text-3)">Poll 18s · pauze op tab-hide</div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px">
          ${kpis.map(([label, val, color]) => `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px 16px">
            <div style="font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3);font-weight:600;margin-bottom:6px">${esc(label)}</div>
            <div style="font-size:24px;font-weight:700;color:${color}">${val}</div>
          </div>`).join('')}
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden;margin-bottom:14px">
          <div style="padding:11px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
            <b style="font-size:13px">Bulk-jobs (laatste 25)</b>
            <span style="font-size:11px;color:var(--text-3)">${errs.bulk ? '?' : bulkJobsArr.length + ' rijen'}</span>
          </div>
          <div style="display:grid;grid-template-columns:1fr 90px 130px 150px 130px;gap:8px;padding:8px 14px;background:var(--surface-2);border-bottom:1px solid var(--border);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);font-weight:600">
            <div>Template</div><div>Status</div><div style="text-align:right">Sent/Total</div><div>Wanneer</div><div style="text-align:right">Job-id</div>
          </div>
          <div>${bulkRows}</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:12px 16px;font-size:12.5px;color:var(--text-3)">
          <b style="color:var(--text)">Pending queue-detail</b> — ${errs.pending ? '<span style="color:var(--rose)">⚠ kon niet laden</span>' : `PENDING <b style="color:var(--text)">${d.pendingCounts?.PENDING || 0}</b> · APPROVED <b style="color:var(--text)">${d.pendingCounts?.APPROVED || 0}</b> · REJECTED <b style="color:var(--text)">${d.pendingCounts?.REJECTED || 0}</b> · EXECUTED <b style="color:var(--text)">${d.pendingCounts?.EXECUTED || 0}</b> · FAILED <b style="color:var(--text)">${d.pendingCounts?.FAILED || 0}</b>`}
        </div>
      </div>
    </div>`;
  }
  function _errBlkMotor(msg) {
    return `<div style="padding:14px 16px;background:var(--rose-soft);border:1px solid var(--rose-line, var(--rose));color:var(--rose);border-radius:var(--r);font-size:13px;display:flex;justify-content:space-between;align-items:center;gap:12px">
      <span>⚠ ${esc(msg)}</span>
      <button class="btn btn-ghost btn-sm" onclick="__wbxRetryMotor()">Opnieuw</button>
    </div>`;
  }

  /* ── Registratie ────────────────────────────────────────────────────── */
  window.DFO.VIEWS['wanbetalers/Gesprekken'] = inboxView;
  window.DFO.VIEWS['wanbetalers/Acties']     = actiesView;
  window.DFO.VIEWS['wanbetalers/Overzicht']  = overzichtView;
  window.DFO.VIEWS['wanbetalers/Brieven']    = brievenView;
  window.DFO.VIEWS['wanbetalers/Motor']      = motorView;
  window.DFO.VIEWS['wanbetalers/Pipeline']   = pipelineView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('wanbetalers');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('wanbetalers');
  console.debug('[wanbetalers-v2] v=15 BROK 9.1: (1) case-sheet callback err surgical DOM-clear via _updateCaseCallErrRow bij __wbxCaseCallField(callback_at|note); (2) motor error-tegels krijgen "↻" retry-knop naast ⚠ die __wbxRetryMotor triggert. NB: dead-code cleanup (gesprekkenView/_gsp*Html/etc) uit deze brok gehaald — te risky per-Edit, wordt aparte cleanup-brok.');
})();
