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
    // BROK WB-FIX-2 #6: optionele tone='danger' (rode header + rode OK-btn +
    // rode border) voor destructive-actions als "Sluit dossier".
    const isDanger    = opts && opts.tone === 'danger';
    const okBgVar     = isDanger ? 'var(--rose,#C22B3E)' : 'var(--brand,#0A7490)';
    const titleColor  = isDanger ? 'var(--rose)' : 'inherit';
    const boxBorder   = isDanger ? '2px solid var(--rose,#C22B3E)' : '1px solid var(--border)';
    return new Promise((resolve) => {
      _closeConfirmModal();
      const root = document.createElement('div');
      root.id = 'wbxConfirmRoot';
      root.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(17,23,33,.48);padding:20px';
      root.innerHTML = `<div style="background:var(--surface);border:${boxBorder};border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.32);padding:22px;max-width:520px;width:calc(100vw - 40px)">
        <div style="font-size:15.5px;font-weight:600;margin-bottom:8px;color:${titleColor}">${esc(title)}</div>
        <div style="font-size:12.5px;color:var(--text-3);margin-bottom:10px">${esc(hint || '')}</div>
        <textarea id="wbxReasonInput" style="width:100%;min-height:80px;padding:9px 11px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:13px;resize:vertical;outline:none;box-sizing:border-box" placeholder="Reden…"></textarea>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
          <button id="wbxReasonCancel" class="btn btn-ghost btn-sm">Annuleren</button>
          <button id="wbxReasonOk" class="btn btn-primary btn-sm" style="background:${okBgVar};border-color:${okBgVar};color:#fff">${okLabel}</button>
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

  /* ── Form-modal helper — leest values VÓÓR sluiten via extractFn(root) ─
     Gebruik voor multi-veld modals (verify / escalatie / vrije taak /
     toewijzen). extractFn krijgt de root-element en moet een waarde-object
     teruggeven; validate mag null returnen om afwijzen te forceren. Resolvet
     met de waarde-object (OK) of null (cancel/backdrop/Esc). */
  function _askForm(title, bodyHtml, extractFn, opts) {
    const okLabel     = esc((opts && opts.okLabel)     || 'OK');
    const cancelLabel = esc((opts && opts.cancelLabel) || 'Annuleren');
    const bgVar       = 'var(--brand,#0A7490)';
    return new Promise((resolve) => {
      _closeConfirmModal();
      const root = document.createElement('div');
      root.id = 'wbxConfirmRoot';
      root.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(17,23,33,.48);padding:20px';
      root.innerHTML = `<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.32);padding:22px;max-width:560px;width:calc(100vw - 40px);max-height:calc(100vh - 60px);overflow:auto">
        <div style="font-size:15.5px;font-weight:600;margin-bottom:12px">${esc(title)}</div>
        <div style="font-size:13px;color:var(--text-2);line-height:1.55;margin-bottom:16px">${bodyHtml}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="wbxFormCancel" class="btn btn-ghost btn-sm">${cancelLabel}</button>
          <button id="wbxFormOk" class="btn btn-primary btn-sm" style="background:${bgVar};border-color:${bgVar};color:#fff">${okLabel}</button>
        </div>
      </div>`;
      const done = (val) => { _closeConfirmModal(); resolve(val); };
      root.addEventListener('click', (e) => { if (e.target === root) done(null); });
      document.body.appendChild(root);
      document.addEventListener('keydown', _confirmModalKey, true);
      document.getElementById('wbxFormCancel').addEventListener('click', () => done(null));
      document.getElementById('wbxFormOk').addEventListener('click', () => {
        let val = null;
        try { val = extractFn(root); } catch (e) { val = null; }
        if (val == null) return; // extractFn faalde validatie — toast is de verantwoordelijkheid van extractFn
        done(val);
      });
      // Focus eerste input/textarea/select
      setTimeout(() => {
        const first = root.querySelector('input, textarea, select');
        if (first) first.focus();
      }, 20);
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
  // BROK 5 ACT-2: per-status cache voor Afgehandeld/Afgewezen tabs.
  _live.pendingActsByStatus = { EXECUTED: null, REJECTED: null };
  // SURFACE D: read-only lijst voor "Gepauzeerd (in gesprek)"-groep (alleen
  // zichtbaar op Vandaag-tab). Endpoint finance-dunning-paused-list levert
  // dunning-runs die geblokkeerd zijn door een actief gesprek.
  _live.pausedList = { loading: false, fetched: false, error: null, items: [], _seq: 0 };
  async function _fetchPausedList() {
    const st = _live.pausedList;
    if (st.loading || (st.fetched && !st.error)) return;
    st.loading = true; st.error = null;
    const seq = ++st._seq;
    const j = await tryFetch('paused', '/api/finance-dunning-paused-list', 8000);
    if (seq !== st._seq) return;
    st.loading = false; st.fetched = true;
    if (!j || j.error) st.error = (j && j.error) || 'Kon paused-lijst niet laden';
    else st.items = asArr(j.items);
    if (window.DFO?.render) window.DFO.render();
  }
  async function _fetchPendingActsByStatus(status) {
    const key = String(status).toUpperCase();
    if (!_live.pendingActsByStatus[key]) _live.pendingActsByStatus[key] = { loading: false, fetched: false, error: null, items: [], _seq: 0 };
    const st = _live.pendingActsByStatus[key];
    if (st.loading || (st.fetched && !st.error)) return;
    st.loading = true; st.error = null;
    const seq = ++st._seq;
    const j = await tryFetch('pending-actions:' + key, `/api/pending-actions-list?status=${encodeURIComponent(key.toLowerCase())}&limit=100`);
    if (seq !== st._seq) return;
    st.loading = false; st.fetched = true;
    if (!j || j.error) st.error = (j && j.error) || 'Kon lijst niet laden';
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
    if (j && !j.error) {
      st.byCust[cid] = asArr(j.items || j.calls);
      // BROK WB-FIX-4 minor: store cadence per klant zodat Bellen-card de
      // echte max_attempts uit dunning_call_cadence app_setting toont.
      st.cadenceByCust = st.cadenceByCust || {};
      if (j.cadence) st.cadenceByCust[cid] = j.cadence;
    }
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
    // BROK WB-FIX-2 #1 (2026-08-19): overzicht-rij opende de klanten-pagina in
    // een NIEUWE TAB via window.open — verwijderd. Alle klik-paden routeren
    // nu naar de SURFACE B dossier-drawer (in-place). Zelfde patroon als
    // Acties-kaart + inbox-Dossier + Vandaag-tegel.
    if (!cid) return;
    if (typeof window.__wbxOpenCase === 'function') return window.__wbxOpenCase(String(cid));
    return _wbxOvOpen_legacyDeeplink(cid);
  };
  // Legacy fallback — alleen aangeroepen als __wbxOpenCase (SURFACE B) niet
  // beschikbaar is (bv. race bij script-load). Bewust nog bereikbaar zodat
  // catastrofale fouten in de drawer niet betekenen dat gebruikers gestrand
  // zijn zonder klant-context.
  function _wbxOvOpen_legacyDeeplink(cid) {
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
  // BROK WB-POLISH-4: gesprekkenView (oude tab-view) is niet meer geregistreerd
  // (inboxView vervangt 'em sinds BROK 5 v=10). De _repaintGsp* helpers zijn
  // no-op stubs zodat oude callers (_fetchCallLog / _fetchTimeline / __wbxCall*)
  // nergens crashen. Zelfde functies fully verwijderen zou vereisen om die
  // callers ook te snoeien, wat interleaved is met live code — te risky voor
  // deze cleanup-brok. Volgende cleanup-brok kan de callers zelf opruimen.
  function _repaintGspList()   { /* no-op — gesprekkenView deprecated */ }
  function _repaintGspDetail() { /* no-op — gesprekkenView deprecated */ }

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
  // BROK WB-POLISH-1: sort-state + stage-order voor logische fase-sortering.
  _ui.ovSortKey = _ui.ovSortKey || 'open';  // 'open' | 'days' | 'stage' | 'next' | 'name'
  _ui.ovSortDir = _ui.ovSortDir || 'desc';  // 'asc' | 'desc'
  const _OZN_STAGE_ORDER = { nieuw: 1, aangemaand: 2, brief_verstuurd: 3, in_gesprek: 4, regeling: 5, dispuut: 6, bewind: 6, incasso: 7, opgelost: 8, afschrijven: 9 };
  function _filteredOverzicht() {
    const rows = asArr(_live.overzicht.items);
    const q = String(_ui.ovSearchQ || '').trim().toLowerCase();
    const filtered = rows.filter((r) => {
      if (_ui.ovStatusFilter !== 'all' && _categorizeOverzichtRow(r) !== _ui.ovStatusFilter) return false;
      if (q) {
        const name = ((r.customer_name || r.name || '') + ' ' + (r.email || '')).toLowerCase();
        if (!name.includes(q)) return false;
      }
      return true;
    });
    // BROK WB-POLISH-1: client-side sortering. Rijen zonder next_action_at
    // altijd onderaan bij sortKey='next' (v1-parity).
    const dir = _ui.ovSortDir === 'asc' ? 1 : -1;
    const key = _ui.ovSortKey || 'open';
    return filtered.slice().sort((a, b) => {
      if (key === 'name') {
        return dir * String(a.customer_name || a.name || '').localeCompare(String(b.customer_name || b.name || ''));
      }
      if (key === 'stage') {
        const sa = _OZN_STAGE_ORDER[a.stage_slug || ''] || 999;
        const sb = _OZN_STAGE_ORDER[b.stage_slug || ''] || 999;
        return dir * (sa - sb);
      }
      if (key === 'next') {
        const ta = a.next_action_at ? Date.parse(a.next_action_at) : null;
        const tb = b.next_action_at ? Date.parse(b.next_action_at) : null;
        // Null altijd onderaan (v1-parity).
        if (ta == null && tb == null) return 0;
        if (ta == null) return 1;
        if (tb == null) return -1;
        return dir * (ta - tb);
      }
      // 'open' (cents) of 'days'
      const va = key === 'days' ? Number(a.days_overdue) || 0 : Number(a.total_open_cents) || 0;
      const vb = key === 'days' ? Number(b.days_overdue) || 0 : Number(b.total_overdue) || Number(b.total_open_cents) || 0;
      return dir * (va - vb);
    });
  }
  window.__wbxOvSort = (key) => {
    if (_ui.ovSortKey === key) {
      _ui.ovSortDir = _ui.ovSortDir === 'asc' ? 'desc' : 'asc';
    } else {
      _ui.ovSortKey = String(key || 'open');
      _ui.ovSortDir = key === 'name' ? 'asc' : 'desc';
    }
    _repaintOverzichtBody();
  };
  function _repaintOverzichtBody() {
    const bodyEl = document.getElementById('wbxOvBody');
    if (bodyEl) bodyEl.innerHTML = _overzichtRowsHtml(_filteredOverzicht());
    const hdrEl = document.getElementById('wbxOvHdr');
    if (hdrEl) hdrEl.innerHTML = _overzichtHdrHtml();
    const cntEl = document.getElementById('wbxOvCount');
    if (cntEl) { const n = _filteredOverzicht().length; cntEl.textContent = n + ' klant' + (n === 1 ? '' : 'en'); }
  }
  function _overzichtHdrHtml() {
    const k = _ui.ovSortKey;
    const d = _ui.ovSortDir === 'asc' ? '↑' : '↓';
    const h = (label, key, align) => `<div style="cursor:pointer;user-select:none;${align ? 'text-align:' + align + ';' : ''}color:${k === key ? 'var(--brand)' : 'var(--text-3)'}" onclick="__wbxOvSort('${key}')" title="Sorteer op ${esc(label)}">${esc(label)}${k === key ? ' ' + d : ''}</div>`;
    return `<div></div>${h('Klant', 'name')}${h('Open', 'open', 'right')}<div style="text-align:right">Fact.</div>${h('Oudste', 'days', 'right')}${h('Fase', 'stage')}${h('Volgende actie', 'next')}<div style="text-align:right">Acties</div>`;
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
      // BROK WB-FIX-3 #1: hele rij klikbaar → drawer. Klik op knoppen/
      // checkbox gebruikt event.stopPropagation zodat die niet meetriggert.
      return `<div style="display:grid;grid-template-columns:32px 2fr 1fr 90px 100px 1.4fr 1.2fr auto;gap:8px;padding:11px 14px;border-bottom:1px solid var(--border);align-items:center;font-size:12.5px;cursor:pointer${isSel ? ';background:var(--surface-2)' : ''}"
        onclick="__wbxOpenCase('${cidClick}')"
        onmouseover="if(!this.dataset.sel)this.style.background='var(--surface-2)'" onmouseout="if(!this.dataset.sel)this.style.background='transparent'" ${isSel ? 'data-sel="1"' : ''}
        title="Open dossier">
        <label style="display:flex;align-items:center;cursor:pointer" onclick="event.stopPropagation()">
          <input type="checkbox" ${isSel ? 'checked' : ''} onchange="event.stopPropagation();__wbxOvToggleSel('${cidClick}')" style="width:15px;height:15px;cursor:pointer" />
        </label>
        <div>
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
          <button class="btn btn-ghost btn-sm" style="font-size:10.5px;color:var(--text-3)" onclick="event.stopPropagation();__wbxOpenCase('${cidClick}')" title="Open dossier">→</button>
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
              <span>Vink klanten aan voor bulk-start · klik rij voor dossier →</span>
            </div>
          </div>
          <div id="wbxOvSelBar" style="display:${_selOvCustIds().length ? 'flex' : 'none'};padding:10px 14px;background:var(--brand-soft,#E2F1F5);border-bottom:1px solid var(--border);align-items:center;gap:10px;font-size:12.5px">
            <b><span id="wbxOvSelCount">${_selOvCustIds().length} klant${_selOvCustIds().length === 1 ? '' : 'en'}</span></b>
            <button class="btn btn-primary btn-sm" style="background:var(--brand,#0A7490);border-color:var(--brand,#0A7490);color:#fff;font-size:11.5px" ${_ui.bulkBusy ? 'disabled' : ''} onclick="__wbxBulkStart()">${_ui.bulkBusy ? 'Starten…' : '▶ Start dunning-workflow (typ-to-confirm)'}</button>
            <button class="btn btn-ghost btn-sm" style="font-size:11px;margin-left:auto" onclick="__wbxOvClearSel()">Wissen</button>
          </div>
          <div id="wbxOvHdr" style="display:grid;grid-template-columns:32px 2fr 1fr 90px 100px 1.4fr 1.2fr auto;gap:8px;padding:8px 14px;background:var(--surface-2);border-bottom:1px solid var(--border);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;font-weight:600">${_overzichtHdrHtml()}</div>
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

    // BROK 5 ACT-2: init tab-state + zoek. Trigger fetch als tab een terminale
    // status vereist en cache nog leeg.
    _ui.acties = _ui.acties || { tab: 'vandaag', searchQ: '', _timer: null };
    if (_ui.acties.tab === 'afgehandeld') {
      const s = _live.pendingActsByStatus.EXECUTED;
      if (!s || (!s.fetched && !s.loading && !s.error)) queueMicrotask(() => _fetchPendingActsByStatus('EXECUTED'));
    } else if (_ui.acties.tab === 'afgewezen') {
      const s = _live.pendingActsByStatus.REJECTED;
      if (!s || (!s.fetched && !s.loading && !s.error)) queueMicrotask(() => _fetchPendingActsByStatus('REJECTED'));
    }

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

    // BROK 5 ACT-2: pendingBlock met tabs (vandaag/komend/afgehandeld/afgewezen)
    // + zoek + per-rij snooze-knop. Terminal tabs fetchen on-demand via
    // _fetchPendingActsByStatus; snooze via /api/pending-action-snooze.
    const pendingBlock = _actiesTabbedBlockHtml(pending);

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
         // BROK WB-POLISH-3: rij klikbaar → arrangement-detail drawer.
         // event.stopPropagation op knop zodat cancel niet ook drawer opent.
         return `<div style="display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:10px;padding:9px 14px;border-bottom:1px solid var(--border);font-size:12.5px;align-items:center;cursor:pointer" onclick="__wbxOpenArrDetail('${esc(arr.id)}')" onmouseover="this.style.background='var(--surface-2)'" onmouseout="this.style.background='transparent'" title="Detail bekijken">
           <div>${esc(nm)}</div>
           <div style="font-size:11.5px;color:var(--text-2)">${esc(arr.type || '—')}</div>
           <div style="font-size:11px;color:var(--text-3)">${esc(arr.status || '—')}</div>
           <div><button class="btn btn-ghost btn-sm" ${busy ? 'disabled' : ''} style="font-size:11px;color:var(--rose);opacity:${busy ? '.55' : '1'};cursor:${busy ? 'not-allowed' : 'pointer'}" onclick="event.stopPropagation();__wbxArrCancel('${esc(arr.id)}','${esc(nm + ' — ' + (arr.type || ''))}')">Annuleer</button></div>
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

  /* BROK 5 ACT-2: Acties-tab tabbed block ─────────────────────────────
     Tabs: Vandaag (PENDING, scheduled_for null of <= now)
           Komend  (PENDING, scheduled_for > now)
           Afgehandeld (EXECUTED — aparte fetch)
           Afgewezen   (REJECTED — aparte fetch)
     Zoek: client-side substring op klantnaam / action_type / payload.reason.
     Snooze: per-rij → modal met datum-input → /api/pending-action-snooze.  */
  function _actiesTabbedBlockHtml(pendingItems) {
    const now = Date.now();
    const tab = _ui.acties?.tab || 'vandaag';
    const q   = String(_ui.acties?.searchQ || '').trim().toLowerCase();

    // Bepaal welke items in welke tab horen.
    let items = [];
    let stateInfo = { loading: false, error: null };
    if (tab === 'vandaag' || tab === 'komend') {
      items = asArr(pendingItems).filter((a) => {
        const s = a.scheduled_for ? Date.parse(a.scheduled_for) : null;
        return tab === 'vandaag' ? (!s || s <= now) : (s && s > now);
      });
      stateInfo = { loading: _live.pendingActs.loading, error: _live.pendingActs.error };
    } else if (tab === 'afgehandeld') {
      const s = _live.pendingActsByStatus.EXECUTED || {};
      items = asArr(s.items);
      stateInfo = { loading: s.loading, error: s.error };
    } else if (tab === 'afgewezen') {
      const s = _live.pendingActsByStatus.REJECTED || {};
      items = asArr(s.items);
      stateInfo = { loading: s.loading, error: s.error };
    }

    // Zoek-filter (client-side).
    if (q) {
      items = items.filter((a) => {
        const nm = ((a.customer && a.customer.name) || a.customer_name || (a.payload && a.payload.customer_name) || '').toLowerCase();
        const at = String(a.action_type || '').toLowerCase();
        const rs = String((a.payload && (a.payload.reason || a.payload.title || a.payload.note)) || '').toLowerCase();
        return nm.includes(q) || at.includes(q) || rs.includes(q);
      });
    }

    // Counts per tab (voor pill-badges).
    const pendAll = asArr(pendingItems);
    const cntVandaag = pendAll.filter((a) => {
      const s = a.scheduled_for ? Date.parse(a.scheduled_for) : null;
      return !s || s <= now;
    }).length;
    const cntKomend  = pendAll.filter((a) => {
      const s = a.scheduled_for ? Date.parse(a.scheduled_for) : null;
      return s && s > now;
    }).length;
    const cntDone    = asArr(_live.pendingActsByStatus.EXECUTED?.items).length;
    const cntRej     = asArr(_live.pendingActsByStatus.REJECTED?.items).length;

    const tabBtn = (id, label, count) =>
      `<button class="chip ${tab === id ? 'on' : ''}" style="font-size:11.5px;padding:4px 11px" onclick="__wbxActiesTab('${id}')">${esc(label)}${count != null ? ` <span style="opacity:.6;margin-left:3px">${count}</span>` : ''}</button>`;

    const headerHtml = `<div style="padding:10px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${tabBtn('vandaag',     'Vandaag',     cntVandaag)}
        ${tabBtn('komend',      'Komend',      cntKomend)}
        ${tabBtn('afgehandeld', 'Afgehandeld', cntDone > 0 ? cntDone : null)}
        ${tabBtn('afgewezen',   'Afgewezen',   cntRej > 0 ? cntRej : null)}
      </div>
      <input id="wbxActiesSearch" type="text" value="${esc(q)}" oninput="__wbxActiesSearch(this.value)" placeholder="Zoek naam / type / reden…" style="width:220px;max-width:100%;padding:5px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font-size:12px;box-sizing:border-box" autocomplete="off" spellcheck="false" />
    </div>`;

    // SURFACE D: PENDING-tabs (vandaag/komend) tonen groepen per action_type
    // (Belafspraak / Betaaltoezegging bevestigen / …). Vandaag krijgt bovendien
    // een read-only "Gepauzeerd (in gesprek)"-groep uit
    // /api/finance-dunning-paused-list. Terminal-tabs blijven flat listing.
    const isPendingTab = tab === 'vandaag' || tab === 'komend';
    let bodyHtml;
    if (stateInfo.loading && !items.length && !(tab === 'vandaag' && asArr(_live.pausedList.items).length)) {
      bodyHtml = `<div style="padding:22px;text-align:center;color:var(--text-3);font-size:12.5px">Laden…</div>`;
    } else if (stateInfo.error && !items.length) {
      bodyHtml = `<div style="padding:22px;text-align:center;color:var(--rose);font-size:12.5px">⚠ ${esc(stateInfo.error)}</div>`;
    } else if (isPendingTab) {
      bodyHtml = _actiesGroupedBodyHtml(items, tab, q);
    } else {
      // Terminal-tabs: flat listing.
      if (!items.length) {
        const empty = tab === 'afgehandeld' ? 'Nog geen afgehandelde acties.' : 'Nog geen afgewezen acties.';
        bodyHtml = `<div style="padding:34px 18px;text-align:center;color:var(--text-3);font-size:12.5px">${esc(empty)}</div>`;
      } else {
        bodyHtml = items.slice(0, 50).map((a) => {
          const customer = _actieCustomerName(a);
          const type = a.action_type || a.type || '—';
          const amt  = a.amount || (a.payload && a.payload.amount) || null;
          const isTl = String(type).startsWith('TL_');
          const ts = a.executed_at || a.rejected_at || a.updated_at || a.created_at;
          const tsText = ts ? _fmtDateTime(ts) : '';
          return `<div style="display:grid;grid-template-columns:2fr 2fr 1fr 140px;gap:10px;padding:9px 14px;border-bottom:1px solid var(--border);font-size:12.5px;align-items:center">
            <div>${esc(customer)}</div>
            <div style="color:var(--text-2);font-size:11.5px">${esc(_actieTypeLabel(type))}${isTl ? ' <span style="font-size:9.5px;padding:1px 5px;border-radius:5px;background:var(--rose-soft);color:var(--rose);font-weight:600;margin-left:4px">TL</span>' : ''}</div>
            <div class="mono" style="text-align:right;color:var(--text-3)">${amt != null ? eur(amt) : '—'}</div>
            <div style="font-size:11px;color:var(--text-3);text-align:right">${esc(tsText)}</div>
          </div>`;
        }).join('');
      }
    }

    return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden;margin-top:14px">
      ${headerHtml}
      ${bodyHtml}
    </div>`;
  }

  /* SURFACE D — Klant-naam helper. Volgt overzicht-row-fallback zodat de
     kaart-body en de kebab dezelfde weergave gebruiken. */
  function _actieCustomerName(a) {
    return (a.customer && a.customer.name)
        || a.customer_name
        || (a.payload && a.payload.customer_name)
        || (asArr(_live.overzicht.items).find((r) => String(r.customer_id || r.id) === String(a.customer_id))?.customer_name)
        || a.customer_id
        || 'Onbekend';
  }

  /* SURFACE D — NL-labels + iconen per action_type (v1-parity).
     BROK WB-FIX-5 #2: MANUAL_FOLLOWUP-splitting op payload.kind (uit
     dunning-step-executors.js — 'call' voor bel-taken, 'letter' voor
     WIK-brief-taken, 'other' voor generic). Effectieve type-key wordt
     _actieEffectiveType(a) — die produceert MANUAL_FOLLOWUP_CALL /
     _LETTER / _OTHER. Zo krijgt "Stuur WIK-brief" niet meer de generieke
     "📞 Belafspraak" chip + Bel-knop, maar een correcte "✉ Brief-taak"
     chip zonder Bel-knop. */
  const _ACT_META = {
    MANUAL_FOLLOWUP_CALL:      { label: 'Belafspraak',                    icon: '📞', order: 1,  showBel: true  },
    MANUAL_FOLLOWUP_LETTER:    { label: 'Brief-taak',                     icon: '✉',  order: 2,  showBel: false },
    MANUAL_FOLLOWUP_OTHER:     { label: 'Follow-up',                      icon: '📝', order: 3,  showBel: false },
    MANUAL_FOLLOWUP:           { label: 'Follow-up',                      icon: '📝', order: 3,  showBel: false }, // legacy zonder kind
    MANUAL_CONFIRM_PROMISE:    { label: 'Betaaltoezegging bevestigen',    icon: '🤝', order: 4,  showBel: false },
    MANUAL_VERIFY_PAYMENT:     { label: 'Betaling verifiëren',            icon: '✅', order: 5,  showBel: false },
    MANUAL_ESCALATION:         { label: 'Escalatie',                      icon: '⚠',  order: 6,  showBel: false },
    MANUAL_PROPOSE_ARRANGEMENT:{ label: 'Regeling voorstellen',           icon: '🤝', order: 7,  showBel: false },
    TL_INVOICE_UPDATE_DUE:     { label: 'TL: factuur-vervaldatum bijwerken', icon: '📅', order: 10, showBel: false },
    TL_INVOICE_SPLIT:          { label: 'TL: factuur splitsen',           icon: '✂',  order: 11, showBel: false },
    TL_SUBSCRIPTION_PAUSE:     { label: 'TL: abonnement pauzeren',        icon: '⏸',  order: 12, showBel: false },
    TL_SUBSCRIPTION_STOP:      { label: 'TL: abonnement stoppen',         icon: '⏹',  order: 13, showBel: false },
    TL_INVOICE_WRITEOFF:       { label: 'TL: factuur afschrijven',        icon: '🗑', order: 14, showBel: false },
  };
  /* Bepaalt effectieve type-key inclusief MANUAL_FOLLOWUP kind-split.
     Volgorde: payload.kind (canonical uit dunning-step-executors) →
     payload.title regex-fallback (bv. handmatige vrije-taken zonder
     kind-veld) → raw action_type. */
  function _actieEffectiveType(a) {
    const at = String(a?.action_type || '').trim();
    if (at !== 'MANUAL_FOLLOWUP') return at;
    const kind = String(a?.payload?.kind || '').toLowerCase().trim();
    if (kind === 'call')                                       return 'MANUAL_FOLLOWUP_CALL';
    if (kind === 'letter' || kind === 'brief')                 return 'MANUAL_FOLLOWUP_LETTER';
    if (kind === 'other' || kind === '')                       {
      // Fallback op title-heuristiek voor legacy rows zonder kind.
      const title = String(a?.payload?.title || '').toLowerCase();
      if (/^bel\s|^bel-taak|bel klant/i.test(title))           return 'MANUAL_FOLLOWUP_CALL';
      if (/wik|brief|aangetekend|incasso.*voorbereid/i.test(title)) return 'MANUAL_FOLLOWUP_LETTER';
      return 'MANUAL_FOLLOWUP_OTHER';
    }
    return 'MANUAL_FOLLOWUP_OTHER';
  }
  function _actieTypeLabel(type) { return (_ACT_META[type]?.label) || type; }
  function _actieTypeIcon (type) { return (_ACT_META[type]?.icon)  || '•'; }
  function _actieTypeOrder(type) { return (_ACT_META[type]?.order) || 99; }
  function _actieTypeShowBel(type) { return !!_ACT_META[type]?.showBel; }

  /* SURFACE D — Groep-body voor Vandaag / Komend tabs. Groepeert pending
     items per action_type in vaste v1-volgorde (Belafspraak eerst, dan
     Betaaltoezegging, verify, escalatie, arrangement, TL_*). Op Vandaag-
     tab wordt onderaan de "Gepauzeerd (in gesprek)"-groep read-only
     ingevoegd uit _live.pausedList.items (client-side search-filter). */
  function _actiesGroupedBodyHtml(pendingItems, tab, q) {
    const groups = new Map();
    for (const a of asArr(pendingItems)) {
      // BROK WB-FIX-5 #2: groepeer op effectieve type (incl. FOLLOWUP-kind-
      // split) zodat WIK-brief-taken en bel-taken elk in hun eigen groep
      // vallen (met correcte label + knoppen).
      const type = _actieEffectiveType(a) || 'OVERIG';
      if (!groups.has(type)) groups.set(type, []);
      groups.get(type).push(a);
    }
    const sortedTypes = Array.from(groups.keys()).sort((a, b) => _actieTypeOrder(a) - _actieTypeOrder(b));
    const groupHtmls = sortedTypes.map((type) => {
      const arr = groups.get(type).slice().sort((a, b) => {
        // Vroegst geplande eerst; anders created_at oud eerst.
        const sa = a.scheduled_for ? Date.parse(a.scheduled_for) : (a.created_at ? Date.parse(a.created_at) : 0);
        const sb = b.scheduled_for ? Date.parse(b.scheduled_for) : (b.created_at ? Date.parse(b.created_at) : 0);
        return sa - sb;
      });
      const isFollowup = type === 'MANUAL_FOLLOWUP_CALL';
      const isPromise  = type === 'MANUAL_CONFIRM_PROMISE';
      const isLetter   = type === 'MANUAL_FOLLOWUP_LETTER';
      return `<div style="border-top:1px solid var(--border)">
        <div style="padding:7px 14px;background:var(--surface-2);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3);display:flex;justify-content:space-between;align-items:center">
          <span>${_actieTypeIcon(type)} ${esc(_actieTypeLabel(type))}</span>
          <span style="opacity:.7">${arr.length}</span>
        </div>
        ${arr.map((a) => _actieCardHtml(a, { isFollowup, isPromise, isLetter })).join('')}
      </div>`;
    });

    let pausedHtml = '';
    if (tab === 'vandaag') {
      if (!_live.pausedList.fetched && !_live.pausedList.loading && !_live.pausedList.error) queueMicrotask(_fetchPausedList);
      const paused = asArr(_live.pausedList.items).filter((r) => {
        if (!q) return true;
        const nm = (r.customer_name || '').toLowerCase();
        return nm.includes(q);
      });
      pausedHtml = `<div style="border-top:1px solid var(--border)">
        <div style="padding:7px 14px;background:var(--surface-2);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3);display:flex;justify-content:space-between;align-items:center">
          <span>⏸ Gepauzeerd (in gesprek)</span>
          <span style="opacity:.7">${paused.length}</span>
        </div>
        ${_live.pausedList.loading && !paused.length
          ? `<div style="padding:16px;text-align:center;color:var(--text-3);font-size:12px">Laden…</div>`
          : (paused.length
            ? paused.slice(0, 25).map((r) => _actieCardPausedHtml(r)).join('')
            : `<div style="padding:14px 18px;text-align:center;color:var(--text-3);font-size:12px">Geen dossiers gepauzeerd door een lopend gesprek.</div>`)}
      </div>`;
    }

    if (!groupHtmls.length && !pausedHtml) {
      const empty = tab === 'vandaag' ? 'Geen open acties voor vandaag.' : 'Geen ingeplande acties.';
      return `<div style="padding:34px 18px;text-align:center;color:var(--text-3);font-size:12.5px">${esc(empty)}</div>`;
    }
    return groupHtmls.join('') + pausedHtml;
  }

  /* SURFACE D — Per-kaart render met typegespecialiseerde knop-labels.
     Belafspraak: Bel / Afgehandeld / Overslaan / Later
     Betaaltoezegging: Bevestigen / Niet nagekomen / Later
     Overige (verify/escalatie/arrangement/TL_*): default ✓ / ✕ / ⏰ / ✓ Gedaan.
     Kaart-body-klik opent SURFACE B dossier-drawer via __wbxOpenCase(cid). */
  function _actieCardHtml(a, opts) {
    const customer = _actieCustomerName(a);
    const cid = a.customer_id || null;
    const cidClick = String(cid || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const amt  = a.amount || (a.payload && a.payload.amount) || null;
    const scheduled = a.scheduled_for ? Date.parse(a.scheduled_for) : null;
    const whenBadge = scheduled ? `<span class="mono" style="font-size:10px;padding:1px 6px;border-radius:4px;background:var(--surface);color:var(--text-3);border:1px solid var(--border)">${_fmtDateTime(a.scheduled_for).slice(5)}</span>` : '';
    const reason = (a.payload && (a.payload.reason || a.payload.title || a.payload.note)) || '';
    const busy = !!_ui.paBusy[a.id];
    const dis = busy ? 'disabled' : '';
    const disStyle = busy ? 'opacity:.55;cursor:not-allowed' : 'cursor:pointer';

    // BROK WB-FIDELITY-1 #4: rijkere kaart-context.
    //   Meta-regel: € · N fact · X dg · Volgende-badge · Gepauzeerd-badge
    //   Volgende: uit overzicht.next_action_at (bv. "Volgende: WhatsApp <datum>")
    //   Gepauzeerd: als klant in _live.pausedList staat (actief gesprek pauzeert flow)
    const ov = asArr(_live.overzicht.items).find((r) => String(r.customer_id || r.id) === String(cid));
    const openEur = ov ? (Number(ov.total_open_cents) || 0) / 100 : (amt != null ? Number(amt) : null);
    const days = ov ? Number(ov.days_overdue) || 0 : null;
    const nFact = ov ? Number(ov.open_invoice_count) || 0 : null;
    // BROK WB-FIX-5 #1: mapping op REAL veldnamen uit /api/wanbetalers-
    // overzicht-list: `next_action_step_type` (step_type enum uit
    // dunning_workflow_steps: email/whatsapp/wait/task/stop/resume_dunning)
    // en `next_action_step_title` (bv. "Bel klant" / "Stuur WIK-14-
    // dagenbrief"). Voorheen: mijn code checkte non-bestaande velden
    // (next_action_type/_channel/_kind) → altijd fallback "Actie".
    // Nu: prioriteit voor step_title heuristiek (specifieker), dan step_type.
    const nextAt        = ov?.next_action_at || null;
    const nextStepType  = String(ov?.next_action_step_type || '').toLowerCase().trim();
    const nextStepTitle = String(ov?.next_action_step_title || '').trim();
    const STEP_TYPE_LABEL = {
      email:          'E-mail',
      whatsapp:       'WhatsApp',
      wait:           'Wachten',
      task:           'Taak',
      stop:           'Einde flow',
      resume_dunning: 'Herstart flow',
    };
    // Titel-heuristiek voor task-steps (specifieker dan generieke "Taak").
    let nextLabel;
    if (/^bel(\s|klant)/i.test(nextStepTitle))              nextLabel = 'Bel';
    else if (/wik|aangetekend|brief/i.test(nextStepTitle))   nextLabel = 'Brief';
    else if (/incasso/i.test(nextStepTitle))                 nextLabel = 'Incasso';
    else if (/herinner/i.test(nextStepTitle))                nextLabel = 'Herinnering';
    else if (STEP_TYPE_LABEL[nextStepType])                  nextLabel = STEP_TYPE_LABEL[nextStepType];
    else if (nextStepTitle)                                  nextLabel = nextStepTitle.length > 22 ? nextStepTitle.slice(0, 22) + '…' : nextStepTitle;
    else                                                     nextLabel = 'Actie';
    const nextBadge = nextAt
      ? `<span style="font-size:10.5px;color:var(--brand);margin-left:4px" title="Volgende geplande actie${nextStepTitle ? ' — ' + esc(nextStepTitle) : ''}">↪ Volgende: <b>${esc(nextLabel)}</b> ${esc(_fmtDateTime(nextAt))}</span>`
      : '';
    const isPaused = !!(asArr(_live.pausedList?.items).find((r) => String(r.customer_id) === String(cid)));
    const pausedBadge = isPaused ? '<span style="font-size:10px;padding:1px 6px;border-radius:4px;background:var(--amber-soft);color:var(--amber);font-weight:600;margin-left:4px">⏸ Gepauzeerd</span>' : '';
    const metaParts = [];
    if (openEur != null) metaParts.push('<span class="mono">' + eur(openEur) + '</span>');
    if (nFact != null && nFact > 0) metaParts.push(`${nFact} fact`);
    if (days != null) metaParts.push(`${days} dg`);
    const ctxLine = (metaParts.length || whenBadge || nextBadge || pausedBadge)
      ? `<div style="font-size:11px;color:var(--text-3);margin-top:2px">${metaParts.join(' · ')}${whenBadge ? ' · ' + whenBadge : ''}${nextBadge}${pausedBadge}</div>`
      : '';

    // Type-specifieke knoppen.
    let btns;
    if (opts.isFollowup) {
      // MANUAL_FOLLOWUP kind='call' — bel-taak met softphone-shortcut.
      btns = `
        ${cid ? `<button class="btn btn-ghost btn-sm" ${dis} style="font-size:11px;color:var(--brand);${disStyle}" onclick="event.stopPropagation();__wbxActFollowupBel('${esc(cid)}')" title="Bel via softphone">📞 Bel</button>` : ''}
        <button class="btn btn-ghost btn-sm" ${dis} style="font-size:11px;color:var(--emerald);${disStyle}" onclick="event.stopPropagation();__wbxPaApprove('${esc(a.id)}')" title="Belafspraak afgehandeld">${busy ? '…' : 'Afgehandeld'}</button>
        <button class="btn btn-ghost btn-sm" ${dis} style="font-size:11px;color:var(--rose);${disStyle}" onclick="event.stopPropagation();__wbxPaReject('${esc(a.id)}')" title="Overslaan (met reden)">Overslaan</button>
        <button class="btn btn-ghost btn-sm" ${dis} style="font-size:11px;color:var(--amber);${disStyle}" onclick="event.stopPropagation();__wbxActSnooze('${esc(a.id)}')" title="Later inplannen">🕒 Later</button>`;
    } else if (opts.isLetter) {
      // BROK WB-FIX-5 #2: MANUAL_FOLLOWUP kind='letter' — brief-taak. GEEN
      // Bel-knop (die suggereerde ten onrechte een bel-actie op een brief).
      // Wel: link naar WIK-brief-flow uit SURFACE B (openCase -> WIK-card).
      btns = `
        ${cid ? `<button class="btn btn-ghost btn-sm" ${dis} style="font-size:11px;color:var(--brand);${disStyle}" onclick="event.stopPropagation();__wbxOpenCase('${esc(cid)}')" title="Open dossier -> WIK-brief-card">✉ Naar brief-flow</button>` : ''}
        <button class="btn btn-ghost btn-sm" ${dis} style="font-size:11px;color:var(--emerald);${disStyle}" onclick="event.stopPropagation();__wbxPaApprove('${esc(a.id)}')" title="Brief verstuurd / afgehandeld">${busy ? '…' : 'Afgehandeld'}</button>
        <button class="btn btn-ghost btn-sm" ${dis} style="font-size:11px;color:var(--rose);${disStyle}" onclick="event.stopPropagation();__wbxPaReject('${esc(a.id)}')" title="Overslaan (met reden)">Overslaan</button>
        <button class="btn btn-ghost btn-sm" ${dis} style="font-size:11px;color:var(--amber);${disStyle}" onclick="event.stopPropagation();__wbxActSnooze('${esc(a.id)}')" title="Later inplannen">🕒 Later</button>`;
    } else if (opts.isPromise) {
      btns = `
        <button class="btn btn-ghost btn-sm" ${dis} style="font-size:11px;color:var(--emerald);${disStyle}" onclick="event.stopPropagation();__wbxPaApprove('${esc(a.id)}')" title="Toezegging is nagekomen">${busy ? '…' : 'Bevestigen'}</button>
        <button class="btn btn-ghost btn-sm" ${dis} style="font-size:11px;color:var(--rose);${disStyle}" onclick="event.stopPropagation();__wbxPaReject('${esc(a.id)}')" title="Toezegging is NIET nagekomen">Niet nagekomen</button>
        <button class="btn btn-ghost btn-sm" ${dis} style="font-size:11px;color:var(--amber);${disStyle}" onclick="event.stopPropagation();__wbxActSnooze('${esc(a.id)}')" title="Later opnieuw kijken">🕒 Later</button>`;
    } else {
      // Generic (verify/escalatie/arrangement/TL_*).
      const isTl = String(a.action_type || '').startsWith('TL_');
      btns = `
        <button class="btn btn-ghost btn-sm" ${dis} style="font-size:11px;color:var(--emerald);${disStyle}" onclick="event.stopPropagation();__wbxPaApprove('${esc(a.id)}')" title="${isTl ? 'Voer TL-mutatie uit' : 'Goedkeuren'}">${busy ? '…' : '✓'}</button>
        <button class="btn btn-ghost btn-sm" ${dis} style="font-size:11px;color:var(--rose);${disStyle}" onclick="event.stopPropagation();__wbxPaReject('${esc(a.id)}')" title="Afwijzen (met reden)">✕</button>
        <button class="btn btn-ghost btn-sm" ${dis} style="font-size:11px;color:var(--amber);${disStyle}" onclick="event.stopPropagation();__wbxActSnooze('${esc(a.id)}')" title="Later plannen">🕒</button>
        <button class="btn btn-ghost btn-sm" ${dis} style="font-size:11px;color:var(--text-3);${disStyle}" onclick="event.stopPropagation();__wbxPaMarkExecuted('${esc(a.id)}')" title="Handmatig al uitgevoerd">✓ Gedaan</button>`;
    }

    // BROK WB-FIX-4 #4 + WB-FIX-5 #2: type-label op kaart. Gebruik
    // _actieEffectiveType (met FOLLOWUP-kind-split) zodat brief-taken
    // "✉ Brief-taak" krijgen i.p.v. "📞 Belafspraak".
    const effType   = _actieEffectiveType(a);
    const typeIcon  = _actieTypeIcon(effType);
    const typeLabel = _actieTypeLabel(effType);
    const typeChip  = `<span style="font-size:9.5px;padding:1px 6px;border-radius:4px;background:var(--surface-2);color:var(--text-3);font-weight:600;letter-spacing:.03em;margin-left:6px;vertical-align:middle">${typeIcon} ${esc(typeLabel)}</span>`;
    return `<div style="padding:9px 14px;border-bottom:1px solid var(--border);cursor:${cid ? 'pointer' : 'default'};transition:background .08s"
      ${cid ? `onclick="__wbxOpenCase('${cidClick}',{customer_name:'${String(customer).replace(/'/g,"\\'")}'})" onmouseover="this.style.background='var(--surface-2)'" onmouseout="this.style.background='transparent'"` : ''}>
      <div style="display:grid;grid-template-columns:1fr auto;gap:10px;align-items:start">
        <div style="min-width:0">
          <div style="font-weight:500;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(customer)}${typeChip}</div>
          ${reason ? `<div style="font-size:11.5px;color:var(--text-2);margin-top:2px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical">${esc(String(reason).slice(0, 200))}</div>` : ''}
          ${ctxLine}
        </div>
        <div style="display:flex;gap:4px;justify-content:flex-end;flex-wrap:wrap">${btns}</div>
      </div>
    </div>`;
  }

  /* SURFACE D — Read-only kaart voor de "Gepauzeerd"-groep (vanuit
     finance-dunning-paused-list; niet gekoppeld aan pending_actions). */
  function _actieCardPausedHtml(r) {
    const cid = r.customer_id || null;
    const cidClick = String(cid || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const name = r.customer_name || 'Onbekend';
    const since = r.paused_since ? _fmtDateTime(r.paused_since) : '';
    const reminders = Number(r.reminder_count) || 0;
    const lastRem = r.last_reminder_at ? _fmtDateTime(r.last_reminder_at) : '';
    return `<div style="padding:9px 14px;border-bottom:1px solid var(--border);cursor:${cid ? 'pointer' : 'default'};transition:background .08s;background:var(--surface)"
      ${cid ? `onclick="__wbxOpenCase('${cidClick}')" onmouseover="this.style.background='var(--surface-2)'" onmouseout="this.style.background='var(--surface)'"` : ''}>
      <div style="display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center">
        <div style="min-width:0">
          <div style="font-weight:500;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</div>
          <div style="font-size:11px;color:var(--text-3);margin-top:2px">
            ⏸ Gepauzeerd sinds ${esc(since || 'onbekend')}${reminders > 0 ? ` · ${reminders} reminder${reminders === 1 ? '' : 's'} verstuurd${lastRem ? ' (laatste ' + esc(lastRem.slice(5)) + ')' : ''}` : ''}
          </div>
        </div>
        <div style="font-size:10.5px;color:var(--text-3)">Dossier →</div>
      </div>
    </div>`;
  }

  /* SURFACE D — Bel-actie voor Belafspraak-kaart. Opent SURFACE B drawer
     zodat medewerker de call-cockpit ziet, EN start direct KlxSoftphone.open
     op de klant-telefoon (best-effort — als geen phone bekend, blijft
     alleen de drawer open). */
  window.__wbxActFollowupBel = (cid) => {
    if (!cid) return;
    // Eerst drawer openen (SURFACE B) — laadt pipeline + call-log context.
    window.__wbxOpenCase(cid);
    // Zoek telefoonnummer uit overzicht-row (customer_phone).
    const row = asArr(_live.overzicht.items).find((r) => String(r.customer_id || r.id) === String(cid));
    const phone = _customerPhone(row);
    const name  = row?.customer_name || row?.name || 'klant';
    if (phone && window.KlxSoftphone && typeof window.KlxSoftphone.open === 'function') {
      // Delay 250ms zodat de drawer render kan afronden vóór KlxSoftphone
      // z'n eigen sheet erover legt.
      setTimeout(() => {
        window.KlxSoftphone.open({ phone, name, customerId: cid, source: 'wanbetalers.acties.followup' });
      }, 250);
    }
  };
  window.__wbxActiesTab = (tab) => {
    if (!_ui.acties) _ui.acties = { tab: 'vandaag', searchQ: '', _timer: null };
    _ui.acties.tab = String(tab || 'vandaag');
    if (window.DFO?.render) window.DFO.render();
  };
  window.__wbxActiesSearch = (val) => {
    if (!_ui.acties) _ui.acties = { tab: 'vandaag', searchQ: '', _timer: null };
    _ui.acties.searchQ = String(val || '');
    if (_ui.acties._timer) clearTimeout(_ui.acties._timer);
    _ui.acties._timer = setTimeout(() => {
      if (window.DFO?.render) window.DFO.render();
    }, 180);
  };
  window.__wbxActSnooze = async (id) => {
    if (!id) return;
    // Default: morgen 09:00 lokale tijd.
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    const pad = (n) => String(n).padStart(2, '0');
    const defaultVal = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}T${pad(tomorrow.getHours())}:${pad(tomorrow.getMinutes())}`;
    const bodyHtml = `
      <div style="display:flex;flex-direction:column;gap:10px">
        <div style="font-size:12.5px;color:var(--text-2);line-height:1.55">
          Deze actie verdwijnt uit "Vandaag" en komt terug wanneer de gekozen datum is bereikt.
        </div>
        <div>
          <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Later oppikken op</div>
          <input id="wbxSnoozeDate" type="datetime-local" value="${defaultVal}" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;box-sizing:border-box" />
        </div>
      </div>`;
    const form = await _askForm('Actie later plannen (snooze)?', bodyHtml, (root) => {
      const raw = root.querySelector('#wbxSnoozeDate')?.value || null;
      if (!raw) { _toast('Kies een datum.', 'warn'); return null; }
      const iso = new Date(raw).toISOString();
      if (Date.parse(iso) <= Date.now() + 60000) {
        _toast('Datum moet minimaal 1 minuut in de toekomst zijn.', 'warn'); return null;
      }
      return { iso };
    }, { okLabel: 'Snooze' });
    if (!form) return;
    if (_ui.paBusy[id]) return;
    _ui.paBusy[id] = true;
    if (window.DFO?.render) window.DFO.render();
    const r = await apiPost('/api/pending-action-snooze', { id, scheduled_for: form.iso });
    _ui.paBusy[id] = false;
    if (!r.ok) { _toast('Snooze mislukt: ' + r.error, 'error'); if (window.DFO?.render) window.DFO.render(); return; }
    _toast('Actie ingepland.', 'success');
    _live.pendingActs.fetched = false;
    _fetchPendingActs();
  };

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
  // BROK WB-POLISH-4: _gspListInnerHtml verwijderd (dead — enige caller
  // was gesprekkenView, ook verwijderd).
  // BROK WB-POLISH-4: _gspDetailHtml verwijderd (dead — was tab-detail voor
  // de oude gesprekkenView, vervangen door SURFACE B drawer). Bijbehorende
  // window-handlers (__wbxCallSet{Outcome,Note,CallbackAt} + __wbxCallSave +
  // __wbxGspSelect + __wbxGspSearch*) blijven staan als no-op-veilige
  // window-refs — dat voorkomt "undefined function"-crashes bij oude
  // console-log-refs in browser-history.
  // BROK WB-POLISH-4: _gspDetailHtml + gesprekkenView + _gspListInnerHtml
  // volledig verwijderd. ~180 regels dead-code weg (was tab-detail voor de
  // niet-meer-geregistreerde gesprekkenView; SURFACE A inboxView vervangt).
  // Related window-handlers (__wbxCallSet*, __wbxGspSelect, __wbxGspSearch*)
  // blijven bestaan als window-refs — geen render-callers meer, dus ongebruikt
  // maar veilig. Volgende cleanup-brok kan die ook nog verwijderen.
  function _gspDetailHtml() { return ''; }

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

    // BROK WB-POLISH-1: init zoek-state.
    _ui.brSearchQ = _ui.brSearchQ || '';
    const items = asArr(_live.briefs.items);
    const categorize = (b) => {
      if (b.sent_at || b.status === 'sent' || b.sent_via) return 'sent';
      if (b.downloaded_at || b.status === 'downloaded') return 'downloaded';
      return 'new';
    };
    const q = String(_ui.brSearchQ || '').trim().toLowerCase();
    const filtered = items.filter((b) => {
      if (_ui.brStatusFilter !== 'all' && categorize(b) !== _ui.brStatusFilter) return false;
      if (q) {
        const hay = ((b.customer_name || '') + ' ' + (b.customer?.email || b.email || '')).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

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
      <button class="btn btn-ghost btn-sm" style="font-size:11px;color:var(--rose)" onclick="__wbxBriefBulkDelete()">🗑 Verwijderen</button>
      <button class="btn btn-ghost btn-sm" style="font-size:11px;margin-left:auto" onclick="__wbxBriefClearSel()">Wissen</button>
    </div>` : '';

    // BROK WB-POLISH-1: search-input + select-all in kop.
    const qVal = String(_ui.brSearchQ || '');
    const searchBar = `<div style="position:relative;flex:1;min-width:220px;max-width:340px">
      <input id="wbxBrSearchInput" type="text" value="${esc(qVal)}"
        oninput="__wbxBrSearchInput(this.value)"
        placeholder="Zoek op klant of e-mail…"
        style="width:100%;padding:6px 28px 6px 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);color:var(--text-1);font-size:12px;outline:none;box-sizing:border-box"
        autocomplete="off" spellcheck="false" />
      <button title="Wis zoekterm" onclick="__wbxBrSearchClear()"
        style="position:absolute;top:50%;right:6px;transform:translateY(-50%);width:20px;height:20px;padding:0;border:0;background:transparent;color:var(--text-3);font-size:14px;cursor:pointer;visibility:${qVal.trim() ? 'visible' : 'hidden'}">×</button>
    </div>`;

    // Select-all: alle in filtered checked? Zo ja, toggle uncheck; anders check alle filtered.
    const allChecked = filtered.length > 0 && filtered.every((b) => _ui.brSelected[String(b.id)]);

    return `<div data-wbx-view="brieven">
      <div class="pad" style="padding:14px 20px 0">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
          <div style="padding:11px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
            <div style="display:flex;gap:10px;align-items:center;flex:1;flex-wrap:wrap">
              ${searchBar}
              <div style="display:flex;gap:5px;flex-wrap:wrap">${chips}</div>
            </div>
            <div style="font-size:11px;color:var(--text-3)">${filtered.length} brie${filtered.length === 1 ? 'f' : 'ven'}</div>
          </div>
          ${bulkBar}
          <div style="display:grid;grid-template-columns:32px 2fr 1fr 130px 140px auto;gap:8px;padding:8px 14px;background:var(--surface-2);border-bottom:1px solid var(--border);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);font-weight:600">
            <label style="display:flex;align-items:center;cursor:pointer" title="${allChecked ? 'Deselecteer' : 'Selecteer'} alle zichtbaar"><input type="checkbox" ${allChecked ? 'checked' : ''} onchange="__wbxBrToggleSelAll()" style="width:14px;height:14px;cursor:pointer" /></label>
            <div>Klant</div><div>Template</div><div style="text-align:right">Aangemaakt</div><div>Status</div><div style="text-align:right">Acties</div>
          </div>
          <div>${rowsHtml}</div>
          <div style="padding:9px 14px;font-size:11px;color:var(--text-3);background:var(--surface-2)">Handmatige mail vertrekt <b>direct</b> (omzeilt de kantooruren-wachtrij).</div>
        </div>
      </div>
      ${_officeHoursBanner()}
    </div>`;
  }

  /* BROK WB-POLISH-1: brieven search + select-all + bulk-delete handlers. */
  window.__wbxBrSearchInput = (val) => {
    _ui.brSearchQ = String(val || '');
    if (_ui.brSearchTimer) clearTimeout(_ui.brSearchTimer);
    _ui.brSearchTimer = setTimeout(() => { if (window.DFO?.render) window.DFO.render(); }, 200);
  };
  window.__wbxBrSearchClear = () => { _ui.brSearchQ = ''; if (window.DFO?.render) window.DFO.render(); };
  window.__wbxBrToggleSelAll = () => {
    const items = asArr(_live.briefs.items);
    const categorize = (b) => (b.sent_at || b.status === 'sent' || b.sent_via) ? 'sent'
                             : (b.downloaded_at || b.status === 'downloaded') ? 'downloaded' : 'new';
    const q = String(_ui.brSearchQ || '').trim().toLowerCase();
    const filtered = items.filter((b) => {
      if (_ui.brStatusFilter !== 'all' && categorize(b) !== _ui.brStatusFilter) return false;
      if (q) {
        const hay = ((b.customer_name || '') + ' ' + (b.customer?.email || b.email || '')).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const allChecked = filtered.length > 0 && filtered.every((b) => _ui.brSelected[String(b.id)]);
    if (allChecked) {
      for (const b of filtered) delete _ui.brSelected[String(b.id)];
    } else {
      for (const b of filtered) _ui.brSelected[String(b.id)] = true;
    }
    if (window.DFO?.render) window.DFO.render();
  };
  window.__wbxBriefBulkDelete = async () => {
    if (!_rbac.canBrief) { _toast('Geen rechten (finance.incasso.manage).', 'error'); return; }
    const ids = _selBriefIds();
    if (!ids.length) return;
    const ok = await _askTypedConfirm(
      `Bulk-verwijder ${ids.length} brie${ids.length === 1 ? 'f' : 'ven'}?`,
      `<div style="font-size:12.5px;line-height:1.55">Deze <b>${ids.length}</b> brieven worden <b>permanent</b> verwijderd (row + PDF-storage). Kan niet ongedaan gemaakt worden.</div>`,
      'VERWIJDER',
      { okLabel: 'Ja, verwijder ' + ids.length }
    );
    if (!ok) return;
    _toast(`Verwijderen van ${ids.length} brie${ids.length === 1 ? 'f' : 'ven'}…`, 'info');
    let done = 0, failed = 0;
    for (const bid of ids) {
      const r = await apiPost('/api/dunning-brief-delete', { brief_id: bid });
      if (r.ok) done++; else failed++;
    }
    _ui.brSelected = {};
    _live.briefs.fetched = false;
    _fetchBriefs();
    _toast(`Verwijderd: ${done}${failed ? ' · ' + failed + ' fout' : ''}.`, failed ? 'warn' : 'success');
  };

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
    statusFilter:  'all',              // SURFACE A: default = ALLE (v1-parity)
    sortMode:      'latest',           // BROK WB-FIX-2 #7: default = laatste bericht (meest recent boven)
    autoOpenedFirst: false,            // SURFACE A: auto-open first conv na eerste fetch
    kebabOpen:     false,              // SURFACE A: ⋮ kebab-menu open/dicht
    composeMenuOpen: false,            // SURFACE A: compose-⋮ sub-menu open/dicht
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
  // SURFACE A: realtime + poll-fallback state.
  _live.inboxRealtime = {
    channel:      null,      // Supabase RealtimeChannel
    pollTimer:    null,      // setInterval handle (6s)
    active:       false,     // subscribed?
    lastRefresh:  0,         // ms epoch — laatste _fetchInboxConvs()
  };

  async function _fetchInboxConvs() {
    const st = _live.inbox.convs;
    if (st.loading) return;
    const mySeq = ++st._seq;
    st.loading = true; st.error = null;
    // SURFACE A: default 'all' + limit 1000 (v1-parity — v1 cap sinds 2026-08-04).
    // Server-side search-param blijft (helpt bij groot volume).
    const q = new URLSearchParams({ module: 'finance', limit: '1000', status_filter: _ui.inbox.statusFilter || 'all' });
    if (_ui.inbox.searchQ && _ui.inbox.searchQ.trim()) q.set('search', _ui.inbox.searchQ.trim());
    const j = await tryFetch('inbox:convs', '/api/inbox-conversations-list?' + q.toString(), 10000);
    if (mySeq !== st._seq) return;
    if (j && j.error) st.error = j.error;
    else { st.items = asArr(j?.items); st.fetched = true; }
    st.loading = false;
    _live.inboxRealtime.lastRefresh = Date.now();
    // SURFACE A: auto-open eerste gesprek na eerste fetch. Filtert de wanbetaler-
    // set client-side (zelfde criteria als _inboxConvsListHtml zodat auto-open
    // niet naar een niet-zichtbare conv wijst).
    if (!_ui.inbox.autoOpenedFirst && !_ui.inbox.selectedConv) {
      const debtorItems = _selectVisibleInboxItems(asArr(st.items));
      const first = debtorItems[0];
      if (first?.id) {
        _ui.inbox.autoOpenedFirst = true;
        // queueMicrotask zodat de render eerst een lijst rendert vóór de select-race.
        queueMicrotask(() => window.__wbxInboxSelect(String(first.id)));
      }
    }
    // SURFACE A polish (v=24-fix): surgical repaint van alleen de list (behoudt
    // list-scrollTop) én de thread-header (kan unread/brief-badge veranderen).
    // Alleen als er GEEN #wbxInboxList (view weg is) → dan is er niks te repainten;
    // bij een tab-switch of full-render vervolgens rendert de shell alles opnieuw.
    if (document.getElementById('wbxInboxList')) {
      _repaintInboxList();
      _repaintInboxThreadHeader();
    } else {
      try { window.DFO?.render?.(); } catch (_) {}
    }
  }
  // Repaint alleen de thread-header (boven de messages). Header toont
  // 24h-badge / brief-tag / totalUnread — deze data komt uit convs.items en
  // moet dus bijgewerkt worden bij elke conv-refetch. NIET de messages-scroll
  // aanraken (dat is _repaintInboxThread).
  function _repaintInboxThreadHeader() {
    const el = document.getElementById('wbxInboxThreadScroll');
    if (!el) return;
    const parent = el.parentElement;
    if (!parent) return;
    const oldHeader = parent.querySelector(':scope > div:first-child');
    // De header is de EERSTE div-child van de kolom (mag ook '' zijn als
    // convId=null). Vervangende innerHTML van de wrapper garandeert dat we
    // niet de scroll-container aanraken.
    const convId = _ui.inbox.selectedConv;
    const newHeaderHtml = _inboxThreadHeaderHtml(convId);
    if (oldHeader && oldHeader.id !== 'wbxInboxThreadScroll') {
      const tmp = document.createElement('template');
      tmp.innerHTML = newHeaderHtml.trim();
      const newNode = tmp.content.firstElementChild;
      if (newNode) parent.replaceChild(newNode, oldHeader);
    }
  }
  // SURFACE A: gedeelde filter+sort-helper. Server retourneert alle finance-convs;
  // wij tonen alleen wanbetaler-convs (is_debtor=true) + client-side searchQ +
  // sortMode 'unread_first' (v1-default). Fallback: als backend nog geen is_debtor
  // meelevert (legacy respons), val terug op overzicht-intersect zoals eerder.
  function _selectVisibleInboxItems(items) {
    const hasDebtorFlag = items.some((c) => 'is_debtor' in c);
    let out;
    if (hasDebtorFlag) {
      out = items.filter((c) => !!c.is_debtor);
    } else {
      // Fallback (legacy respons): overzicht-intersect als voorheen.
      const wbCids = new Set(asArr(_live.overzicht.items).map((r) => String(r.customer_id || r.id)));
      out = wbCids.size
        ? items.filter((c) => c.customer_id && wbCids.has(String(c.customer_id)))
        : items;
    }
    const q = String(_ui.inbox.searchQ || '').trim().toLowerCase();
    if (q) {
      out = out.filter((c) => (
        (c.customer_name || '') + ' ' +
        (c.display_name  || '') + ' ' +
        (c.phone_number  || '')
      ).toLowerCase().includes(q));
    }
    const mode = _ui.inbox.sortMode || 'unread_first';
    out = out.slice().sort((a, b) => {
      const ta = a.last_activity_at ? Date.parse(a.last_activity_at) : (a.last_message_at ? Date.parse(a.last_message_at) : 0);
      const tb = b.last_activity_at ? Date.parse(b.last_activity_at) : (b.last_message_at ? Date.parse(b.last_message_at) : 0);
      if (mode === 'unread_first') {
        const ua = Number(a.total_unread ?? a.unread_count) > 0 ? 1 : 0;
        const ub = Number(b.total_unread ?? b.unread_count) > 0 ? 1 : 0;
        if (ua !== ub) return ub - ua;
      }
      return tb - ta;
    });
    return out;
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
    // SURFACE A polish (v=24-fix): surgical repaint van alleen de thread-scroll
    // (behoudt scrollTop, scrollt naar onder als user onderaan was of dit een
    // fresh-select was). Full DFO.render valt terug op de shell alleen als de
    // thread-scroll niet in DOM staat.
    if (convId === _ui.inbox.selectedConv && document.getElementById('wbxInboxThreadScroll')) {
      _repaintInboxThread(convId);
      _repaintInboxThreadHeader();
    } else {
      try { window.DFO?.render?.(); } catch (_) {}
    }
  }
  async function _fetchInboxCtx(convId, mySeq) {
    if (!convId) return;
    if (_live.inbox.ctx.loading[convId] || _live.inbox.ctx.byConv[convId]) return;
    _live.inbox.ctx.loading[convId] = true;
    const j = await tryFetch('inbox:ctx:' + convId, `/api/inbox-conversation-context?conversation_id=${encodeURIComponent(convId)}`, 8000);
    _live.inbox.ctx.loading[convId] = false;
    if (mySeq != null && mySeq !== _ui.inbox._selectSeq) return;
    if (j && !j.error) _live.inbox.ctx.byConv[convId] = j;
    // BROK WB-FIX-2 #4: surgical repaint alleen van het rechter klantpaneel
    // + de compose-status. Full DFO.render zou de thread-container opnieuw
    // renderen → scrollTop reset naar 0 (dat brak scroll-to-bottom bij openen).
    if (convId === _ui.inbox.selectedConv) _repaintInboxRightPane();
  }
  async function _fetchInboxTemplates(convId, mySeq) {
    if (!convId) return;
    if (_live.inbox.templates.loading[convId] || _live.inbox.templates.byConv[convId]) return;
    _live.inbox.templates.loading[convId] = true;
    const j = await tryFetch('inbox:tpl:' + convId, `/api/inbox-template-list?conversation_id=${encodeURIComponent(convId)}`, 8000);
    _live.inbox.templates.loading[convId] = false;
    if (mySeq != null && mySeq !== _ui.inbox._selectSeq) return;
    if (j && !j.error) _live.inbox.templates.byConv[convId] = asArr(j?.items);
    // BROK WB-FIX-2 #4: templates zijn silent cache-fill. UI leest ze on-demand
    // (template-picker modal + compose-fallback bij 24h-expired). Geen render
    // triggeren — voorkomt thread-scroll-reset.
  }
  // BROK WB-FIX-2 #4: surgical repaint van het rechter klantgegevens-paneel.
  // Andere shell-render zou de thread-container vervangen → scrollTop=0.
  function _repaintInboxRightPane() {
    const el = document.getElementById('wbxInboxRightPane');
    if (!el) return;
    el.innerHTML = _inboxKlantgegevensHtml(_ui.inbox.selectedConv);
  }

  window.__wbxInboxSelect = (convId) => {
    _ui.inbox.selectedConv = String(convId);
    // BROK 5-fix (v=11): increment select-seq zodat oudere in-flight
    // fetches (van eerdere convId) hun state-write skippen zodra ze
    // eindelijk resolven. Voorkomt race waarbij een trage thread-fetch
    // van conv A de zojuist gekozen conv B overschrijft.
    const mySeq = ++_ui.inbox._selectSeq;
    _ui.inbox.compose = { channel: 'wa', text: '', subject: '', templateName: '', sending: false, waWindowExpired: false, error: null };
    // SURFACE A polish (v=24-fix): eerste-render + expliciete select forceren
    // scroll naar onder (nieuwste bericht in beeld). Reset item-count-tracker
    // zodat _repaintInboxThread hasNew-detect klopt.
    _ui.inbox.threadScrollBottomOnNext[String(convId)] = true;
    _ui.inbox.threadItemCountByConv[String(convId)] = 0;
    _fetchInboxThread(convId, mySeq);
    _fetchInboxCtx(convId, mySeq);
    _fetchInboxTemplates(convId, mySeq);
    // BROK WB-FIX-2 #4: robust scroll-to-bottom bij openen. RAF-loop scant
    // tot #wbxInboxThreadScroll bestaat EN scrollHeight > clientHeight, dan
    // zet scrollTop=scrollHeight. Nodig omdat DFO.render (die hierna via
    // catch-all volgt) de container mogelijk vervangt tussen surgical repaints
    // in — zonder deze loop bleef de user bovenaan hangen bij openen.
    _wbxScrollThreadToBottomSoon(convId, 0);
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
  /* SURFACE A polish (v=24-fix): scroll-preservering — voorkomt dat de
     6s poll / Supabase-realtime tick de user naar de top spingt.
     Bewaart scrollTop van #wbxInboxList (links) over elke repaint. */
  function _repaintInboxList() {
    const el = document.getElementById('wbxInboxList');
    if (!el) return;
    const prevTop = el.scrollTop;
    el.innerHTML = _inboxConvsListHtml();
    // Restore synchroon — de nieuwe DOM heeft dezelfde scroll-hoogte tenzij
    // conv-count drastisch veranderd is. Voor die randgevallen accepteren we
    // een kleine skip (nooit een terugsprong naar 0).
    el.scrollTop = prevTop;
  }
  // Per-conv scroll-state voor thread-scroll-preservation.
  _ui.inbox.threadScrollByConv = _ui.inbox.threadScrollByConv || {};
  _ui.inbox.threadItemCountByConv = _ui.inbox.threadItemCountByConv || {};
  // scrollBottomOnNext = true dwingt scroll naar onder na de eerstvolgende
  // _repaintInboxThread; wordt gezet bij __wbxInboxSelect en bij eigen send.
  _ui.inbox.threadScrollBottomOnNext = {};

  /* Thread-repaint: surgical innerHTML-swap van #wbxInboxThreadScroll.
     Gedrag per conv:
       - Bij eerste render (of __wbxInboxSelect / eigen send) → scroll naar onder
       - Stond user vlak boven onder (binnen 60px) én zijn er NIEUWE messages →
         scroll mee naar onder (chat-behaviour).
       - Anders: behoud scrollTop (voorkomt dat realtime/poll de user naar
         een oude positie werpt terwijl 'ie omhoog is gescrold). */
  /* BROK WB-FIX-4 #3: scroll-to-bottom LOOP herzien.
     v=28 wachtte tot 30 attempts (~600ms) — te kort omdat een late DFO.render
     de container kan vervangen NA het einde van de loop → user zag 10-18s
     "bovenaan" totdat de 6s poll rerenderde met force=true.
     Fix:
       1. LONGER window: ~5000ms (250 attempts) zodat late DFO.render nog
          door de loop worden gevangen.
       2. Loop clear ALLEEN als het echt gelukt is (scrollTop reached bottom).
          v=28 clearde threadScrollBottomOnNext op ELKE repaint → force verloor
          effect voor de eerste render die geen content had.
       3. _repaintInboxThread doet nu SYNCHROON een sync-scroll VOOR de rAF-
          check zodat content dat direct in DOM staat instant scrollt.  */
  function _wbxScrollThreadToBottomSoon(convId, attempts) {
    attempts = attempts || 0;
    if (attempts > 250) return; // ~5s max (was 600ms)
    if (String(_ui.inbox.selectedConv) !== String(convId)) return;
    const fire = () => {
      const el = document.getElementById('wbxInboxThreadScroll');
      if (!el) return _wbxScrollThreadToBottomSoon(convId, attempts + 1);
      if (el.scrollHeight > el.clientHeight + 4) {
        el.scrollTop = el.scrollHeight;
        // Update tracker; verify daadwerkelijk gelukt vóór clear.
        _ui.inbox.threadItemCountByConv[String(convId)] = asArr(_live.inbox.thread.byConv[String(convId)]?.items).length;
        // BROK WB-FIX-4 #3: check dat we ECHT onderaan staan (browsers negeren
        // scrollTop-set als het element nog geen layout heeft). Anders retry.
        if (Math.abs(el.scrollTop - (el.scrollHeight - el.clientHeight)) < 4) {
          _ui.inbox.threadScrollBottomOnNext[String(convId)] = false;
        } else {
          setTimeout(() => _wbxScrollThreadToBottomSoon(convId, attempts + 1), 20);
        }
      } else {
        setTimeout(() => _wbxScrollThreadToBottomSoon(convId, attempts + 1), 20);
      }
    };
    requestAnimationFrame(fire);
  }

  function _repaintInboxThread(convId) {
    const el = document.getElementById('wbxInboxThreadScroll');
    if (!el) return;
    const bag = _live.inbox.thread.byConv[convId];
    const itemsCount = asArr(bag?.items).length;
    const prevCount  = Number(_ui.inbox.threadItemCountByConv[convId]) || 0;
    const hasNew     = itemsCount > prevCount;
    const prevTop    = el.scrollTop;
    const prevMax    = el.scrollHeight - el.clientHeight;
    const wasAtBottom = (prevMax - prevTop) < 60; // 60px tolerantie
    const forceBottom = !!_ui.inbox.threadScrollBottomOnNext[convId];
    // BROK WB-FIX-4 #3: NIET direct clearen — de loop clear'ret pas als
    // scroll ECHT gelukt is (voorkomt dat een late DFO.render de force
    // verliest voordat we bodemen).

    el.innerHTML = _inboxThreadHtml(convId);
    _ui.inbox.threadItemCountByConv[convId] = itemsCount;

    // BROK WB-FIX-4 #3: SYNCHROON scroll als forceBottom of eerste render
    // — content staat vaak al in de DOM direct na innerHTML-swap (WA-
    // bubbles hebben geen image-loading race). Snelle path voor happy case.
    if ((forceBottom || prevCount === 0) && el.scrollHeight > el.clientHeight) {
      el.scrollTop = el.scrollHeight;
    }

    // requestAnimationFrame voor de "was-at-bottom"-case (chat-behaviour bij poll).
    requestAnimationFrame(() => {
      const el2 = document.getElementById('wbxInboxThreadScroll');
      if (!el2) return;
      if (forceBottom || (hasNew && wasAtBottom) || prevCount === 0) {
        el2.scrollTop = el2.scrollHeight;
        // Clear force alleen als we DAADWERKELIJK onderaan zitten.
        if (Math.abs(el2.scrollTop - (el2.scrollHeight - el2.clientHeight)) < 4) {
          _ui.inbox.threadScrollBottomOnNext[convId] = false;
        }
      } else {
        el2.scrollTop = prevTop;
      }
    });
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
    // SURFACE A polish: eigen verstuur = force scroll-to-bottom bij de refetch.
    _ui.inbox.threadScrollBottomOnNext[String(convId)] = true;
    _ui.inbox.threadItemCountByConv[String(convId)] = 0; // reset zodat hasNew triggert
    delete _live.inbox.thread.byConv[convId];
    _fetchInboxThread(convId);
    _live.inbox.convs.fetched = false; _fetchInboxConvs();
    _toast('Bericht verstuurd.', 'success');
  };
  window.__wbxRetryInbox = () => { _live.inbox.convs.fetched = false; _fetchInboxConvs(); };

  /* ── SURFACE A — sort / kebab / realtime / mark-read/unread / pause ─── */
  window.__wbxInboxSort = (mode) => {
    _ui.inbox.sortMode = (mode === 'latest' ? 'latest' : 'unread_first');
    _repaintInboxList();
    try { window.DFO?.render?.(); } catch (_) {}
  };
  window.__wbxInboxKebab = () => {
    _ui.inbox.kebabOpen = !_ui.inbox.kebabOpen;
    try { window.DFO?.render?.(); } catch (_) {}
    // Klik-buiten sluit kebab.
    if (_ui.inbox.kebabOpen) {
      setTimeout(() => {
        const closeOnce = (e) => {
          if (!e.target.closest('#wbxInboxKebab')) {
            document.removeEventListener('click', closeOnce, true);
            _ui.inbox.kebabOpen = false;
            try { window.DFO?.render?.(); } catch (_) {}
          }
        };
        document.addEventListener('click', closeOnce, true);
      }, 20);
    }
  };
  window.__wbxInboxKebabClose = () => { _ui.inbox.kebabOpen = false; };

  /* SURFACE A polish (v=24-fix): mark-read/unread markeert nu ALLE kanalen
     (WA + e-mail) én update de list-row optimistisch zodat badge/stripe
     direct verdwijnt (bug: David Sanfilippo email-badge 5 bleef staan omdat
     inbox-mark-read alleen WA-unread raakt).

     Als de thread nog niet geladen is (kebab-klik zonder eerst thread-open):
     eerst lazy-load zodat we de email-ids kennen; anders slaan we email-
     markering over → badge zou terugkomen bij volgende fetch. */
  async function _wbxLoadInboxThreadIfNeeded(convId) {
    if (!convId) return null;
    const existing = _live.inbox.thread.byConv[convId];
    if (existing && existing.items && existing.items.length) return existing;
    // Fire+await een fetch (silent — geen render triggeren).
    const j = await tryFetch('mark:thread:' + convId, `/api/inbox-thread-unified?conversation_id=${encodeURIComponent(convId)}&include_email=1&limit=200`, 8000);
    if (!j || j.error) return existing || null;
    const bag = _live.inbox.thread.byConv[convId] = _live.inbox.thread.byConv[convId] || { items: [], conversation: null };
    bag.items = asArr(j.items);
    bag.conversation = j.conversation || bag.conversation;
    return bag;
  }
  // Zet lokaal alle unread-counters op 0 (of ≥1 bij mark-unread) en repaint
  // de list surgical zodat badge direct weg is.
  function _wbxOptimisticSetUnread(convId, value) {
    const row = (_live.inbox.convs.items || []).find((x) => String(x.id) === String(convId));
    if (!row) return;
    row.unread_count       = value;
    row.email_unread_count = value;
    row.total_unread       = value;
    _repaintInboxList();
    _repaintInboxThreadHeader();
  }

  window.__wbxInboxMarkRead = async (convId) => {
    if (!convId) return;
    // BROK WB-FIX-2 #3: v=25 gebruikte /api/email-actions {action:'mark-read'}
    // per-email — dat is een AUDIT-QUEUE tabel-insert, geen IMAP \Seen-toggle.
    // Server-side email_unread_count bleef dus 5 → badge kwam terug bij poll +
    // ook na refresh. Fix: v1's endpoint /api/inbox-email-mark-read gebruikt,
    // dat gaat DIRECT naar IMAP + invalidateert email-unread-cache zodat de
    // volgende conversations-list fetch email_unread_count=0 teruggeeft.
    // Customer_id ophalen uit de conv-row (nodig voor het email-endpoint).
    const row = (_live.inbox.convs.items || []).find((x) => String(x.id) === String(convId));
    const custId = row?.customer_id || null;

    // 1) Optimistic: badge/stripe DIRECT weg.
    _wbxOptimisticSetUnread(convId, 0);

    // 2) WA-side (silent — geen await, kan parallel).
    apiPost('/api/inbox-mark-read', { conversation_id: convId }).catch(() => {});

    // 3) E-mail-side (v1-parity endpoint). Await zodat we een echte
    //    error kunnen tonen bij falen (i.p.v. stille toast-lie).
    let emailOk = true;
    if (custId) {
      const r = await apiPost('/api/inbox-email-mark-read', { customer_id: custId, module: 'finance' });
      if (!r.ok) {
        emailOk = false;
        console.warn('[wbx mark-read] email side failed:', r.error);
      }
    }

    if (emailOk) _toast('Gemarkeerd als gelezen.', 'success');
    else _toast('WA gelezen, e-mail-flag mislukt.', 'warn');

    // 4) Reconcile (silent) — server-side status ophalen zodat evt. failure
    //    van de WA-mark de badge terug laat komen.
    setTimeout(() => { _live.inbox.convs.fetched = false; _fetchInboxConvs(); }, 1500);
  };

  window.__wbxInboxMarkUnread = async (convId) => {
    if (!convId) return;
    // 1) Optimistic: badge=1 direct zichtbaar.
    _wbxOptimisticSetUnread(convId, 1);
    // 2) WA-side mark-unread. NB: /api/email-actions ondersteunt geen
    //    'mark-unread' action-type (alleen 'mark-read'), dus e-mail-kant
    //    blijft \Seen — acceptabel voor mark-unread als "flag deze conv
    //    weer als todo"-signaal. Als de conv puur email-only was, is de
    //    WA-toggle een no-op maar de optimistic-badge blijft correct staan
    //    tot de volgende poll.
    const r = await apiPost('/api/inbox-mark-unread', { conversation_id: convId });
    if (!r.ok) { _toast('Markeren mislukt: ' + r.error, 'error'); _live.inbox.convs.fetched = false; _fetchInboxConvs(); return; }
    _toast('Gemarkeerd als ongelezen.', 'success');
    setTimeout(() => { _live.inbox.convs.fetched = false; _fetchInboxConvs(); }, 1200);
  };
  window.__wbxInboxPauseFlow = async (cid) => {
    if (!cid) return;
    const reason = await _askReason('Aanmaan-flow pauzeren', 'Waarom? (bv. "Wacht op klant-terugkoppeling")', { okLabel: 'Pauzeer' });
    if (!reason) return;
    const r = await apiPost('/api/finance-dunning-pause-by-customer', { customer_id: cid, reason });
    if (r.status === 404) { _toast('Geen actieve dunning-run gevonden.', 'warn'); return; }
    if (!r.ok) { _toast('Pauzeren mislukt: ' + r.error, 'error'); return; }
    const prev = r.json?.previous_status;
    _toast(prev === 'paused' ? 'Flow was al gepauzeerd.' : 'Flow gepauzeerd.', 'success');
  };

  // SURFACE A: Supabase realtime channel op whatsapp_messages INSERT +
  // 6s poll-fallback. Cleanup bij tab-switch (view-unmount detectie via
  // afwezigheid van #wbxInboxList in de DOM). Silent-fail als supabase-
  // client of RLS geen realtime toestaat — poll dekt dan alles.
  async function _startInboxRealtime() {
    if (_live.inboxRealtime.active) return;
    _live.inboxRealtime.active = true;
    // 6s poll (v1-parity). Refresh alleen als er ≥5s sinds laatste fetch is
    // voorbij (voorkomt dubbele fetches vlak na realtime-event).
    if (_live.inboxRealtime.pollTimer) clearInterval(_live.inboxRealtime.pollTimer);
    _live.inboxRealtime.pollTimer = setInterval(() => {
      // View-unmount detectie: als #wbxInboxList weg is, stop de poll.
      if (!document.getElementById('wbxInboxList')) { _stopInboxRealtime(); return; }
      if (Date.now() - _live.inboxRealtime.lastRefresh < 5000) return;
      _live.inbox.convs.fetched = false;
      _fetchInboxConvs();
    }, 6000);
    // Realtime channel — best-effort.
    try {
      if (window.supabase && typeof window.supabase.channel === 'function') {
        const ch = window.supabase
          .channel('wbx-inbox-live')
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'whatsapp_messages' }, () => {
            // Debounce: als recent ge-refreshed, skip.
            if (Date.now() - _live.inboxRealtime.lastRefresh < 2000) return;
            _live.inbox.convs.fetched = false;
            _fetchInboxConvs();
          })
          .subscribe((status) => {
            if (status === 'SUBSCRIBED') console.debug('[wanbetalers-v2] inbox realtime subscribed');
            else if (status === 'CHANNEL_ERROR') console.warn('[wanbetalers-v2] inbox realtime CHANNEL_ERROR — fallback op 6s poll');
          });
        _live.inboxRealtime.channel = ch;
      }
    } catch (e) {
      console.warn('[wanbetalers-v2] realtime setup fail (fallback op poll):', e?.message || e);
    }
  }
  /* ── SURFACE A — compose-actie handlers ─────────────────────────────
     Bijlage: file-input trigger → POST /api/whatsapp-media-upload → send
     Template-picker: opent overlay met inbox-template-list + auto-fill
     Snel antwoord: overlay met inbox-quick-replies-list → prefill textarea
     Vraag Joost: POST /api/joost-suggest (refetch via SURFACE B pattern
                  wordt hier niet zichtbaar; komt binnen als recent-item)
     Compose-menu / Bel-taak: submenu + POST /api/tasks-create-followup */
  window.__wbxInboxComposeMenu = () => {
    _ui.inbox.composeMenuOpen = !_ui.inbox.composeMenuOpen;
    try { window.DFO?.render?.(); } catch (_) {}
    if (_ui.inbox.composeMenuOpen) {
      setTimeout(() => {
        const closeOnce = (e) => {
          if (!e.target.closest('#wbxInboxComposeMenu')) {
            document.removeEventListener('click', closeOnce, true);
            _ui.inbox.composeMenuOpen = false;
            try { window.DFO?.render?.(); } catch (_) {}
          }
        };
        document.addEventListener('click', closeOnce, true);
      }, 20);
    }
  };
  window.__wbxInboxComposeMenuClose = () => { _ui.inbox.composeMenuOpen = false; };

  window.__wbxInboxAttach = () => {
    const convId = _ui.inbox.selectedConv;
    if (!convId) return;
    // Hidden file-input → upload → send in één flow.
    let inp = document.getElementById('wbxInboxAttachInput');
    if (!inp) {
      inp = document.createElement('input');
      inp.type = 'file';
      inp.id = 'wbxInboxAttachInput';
      inp.accept = 'image/*,application/pdf,video/mp4';
      inp.style.display = 'none';
      document.body.appendChild(inp);
    }
    inp.value = '';
    inp.onchange = async () => {
      const file = inp.files && inp.files[0];
      if (!file) return;
      // Grootte-limiet 16MB (WA limiet).
      if (file.size > 16 * 1024 * 1024) { _toast('Bestand > 16MB, WA weigert.', 'error'); return; }
      const mode = file.type.startsWith('image/') ? 'image'
                 : file.type.startsWith('video/') ? 'video'
                 : 'document';
      const ok = await _askConfirm('Bijlage versturen?', `<div><b>Bestand:</b> ${esc(file.name)}</div><div><b>Type:</b> ${esc(mode)}</div><div><b>Grootte:</b> ${Math.round(file.size / 1024)} kB</div>`, { okLabel: 'Ja, verstuur' });
      if (!ok) return;
      try {
        _toast('Uploaden…', 'info');
        const token = await (window.AuthShared && window.AuthShared.getAccessToken ? window.AuthShared.getAccessToken() : Promise.resolve(null));
        const headers = {};
        if (token) headers['Authorization'] = 'Bearer ' + token;
        const fd = new FormData();
        fd.append('file', file);
        fd.append('conversation_id', convId);
        const upResp = await fetch('/api/whatsapp-media-upload', { method: 'POST', headers, body: fd });
        if (!upResp.ok) { const t = await upResp.text().catch(() => ''); _toast('Upload faalde: ' + (t || 'HTTP ' + upResp.status), 'error'); return; }
        const upJ = await upResp.json();
        const mediaId = upJ.media_id || upJ.id || null;
        if (!mediaId) { _toast('Upload lukte maar geen media_id ontvangen.', 'error'); return; }
        const r = await apiPost('/api/inbox-send', { conversation_id: convId, mode, media_id: mediaId, filename: file.name });
        if (!r.ok) { _toast('Verzenden mislukt: ' + r.error, 'error'); return; }
        _toast('Bijlage verstuurd.', 'success');
        delete _live.inbox.thread.byConv[convId];
        _fetchInboxThread(convId);
        _live.inbox.convs.fetched = false; _fetchInboxConvs();
      } catch (e) { _toast('Fout: ' + (e?.message || e), 'error'); }
    };
    inp.click();
  };

  window.__wbxInboxOpenTplPicker = async () => {
    const convId = _ui.inbox.selectedConv;
    if (!convId) return;
    // Fetch templates as needed (BROK 5 al aanwezig).
    if (!_live.inbox.templates.byConv[convId]) await _fetchInboxTemplates(convId);
    const tpls = asArr(_live.inbox.templates.byConv[convId]);
    if (!tpls.length) { _toast('Geen templates beschikbaar.', 'warn'); return; }
    const opts = tpls.map((t) => `<option value="${esc(t.name || t.template_name)}">${esc(t.name || t.template_name)}${t.category ? ' · ' + esc(t.category) : ''}</option>`).join('');
    const bodyHtml = `
      <div>
        <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Kies WA-template</div>
        <select id="wbxTplPick" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px">${opts}</select>
        <div style="font-size:11px;color:var(--text-3);margin-top:8px;line-height:1.5">Template wordt direct verstuurd na bevestigen — via het WA-template-endpoint. Bij vrij-tekst-modus met open 24u-venster kun je beter de textarea gebruiken.</div>
      </div>`;
    const form = await _askForm('Template versturen', bodyHtml, (root) => {
      const name = root.querySelector('#wbxTplPick')?.value || '';
      if (!name) { _toast('Kies een template.', 'warn'); return null; }
      return { name };
    }, { okLabel: 'Volgende' });
    if (!form) return;
    _ui.inbox.compose.templateName = form.name;
    _ui.inbox.compose.channel = 'wa';
    // Trigger de bestaande send-flow (die pakt templateName op).
    window.__wbxInboxSend();
  };

  window.__wbxInboxOpenQr = async () => {
    const convId = _ui.inbox.selectedConv;
    if (!convId) return;
    // Fetch quick-replies (cached per conv).
    _live.inbox.quickReplies = _live.inbox.quickReplies || { loading: {}, byConv: {} };
    if (!_live.inbox.quickReplies.byConv[convId]) {
      const j = await tryFetch('qr:' + convId, `/api/inbox-quick-replies-list?conversation_id=${encodeURIComponent(convId)}`, 6000);
      if (j && !j.error) _live.inbox.quickReplies.byConv[convId] = asArr(j.items);
    }
    const items = asArr(_live.inbox.quickReplies.byConv[convId]);
    if (!items.length) { _toast('Geen snel-antwoorden beschikbaar.', 'warn'); return; }
    const opts = items.map((q) => `<option value="${esc(q.body || q.text || '')}">${esc((q.title || q.name || '').slice(0, 60))}</option>`).join('');
    const bodyHtml = `
      <div>
        <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Kies snel-antwoord</div>
        <select id="wbxQrPick" onchange="const t=this.value;document.getElementById('wbxQrPreview').value=t" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px">${opts}</select>
        <div style="font-size:11.5px;color:var(--text-3);margin:8px 0 4px">Voorvertoning (bewerken kan)</div>
        <textarea id="wbxQrPreview" rows="4" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;resize:vertical;box-sizing:border-box">${esc(items[0]?.body || items[0]?.text || '')}</textarea>
      </div>`;
    const form = await _askForm('Snel-antwoord invoegen', bodyHtml, (root) => {
      const text = String(root.querySelector('#wbxQrPreview')?.value || '').trim();
      if (!text) { _toast('Leeg — vul een tekst.', 'warn'); return null; }
      return { text };
    }, { okLabel: 'Voeg in' });
    if (!form) return;
    _ui.inbox.compose.text = form.text;
    _ui.inbox.compose.channel = 'wa';
    try { window.DFO?.render?.(); } catch (_) {}
    _toast('Voorvertoning geladen — druk Verstuur.', 'success');
  };

  window.__wbxInboxAskJoost = async (convId) => {
    if (!convId) return;
    const r = await apiPost('/api/joost-suggest', { conversation_id: convId });
    if (!r.ok) { _toast('Joost-verzoek mislukt: ' + r.error, 'error'); return; }
    _toast('Joost denkt na — nieuwe suggestie verschijnt zo op de klantkaart (Dossier).', 'success');
  };

  window.__wbxInboxCreateFollowup = async (cid, convId) => {
    if (!cid) return;
    const reason = await _askReason('Bel-taak aanmaken', 'Waarover moet er teruggebeld worden?', { okLabel: 'Maak taak' });
    if (!reason) return;
    const r = await apiPost('/api/tasks-create-followup', {
      customer_id: cid, source: 'inbox', reason, kind: 'bel-taak',
      title: 'Bel-taak vanuit inbox', note: reason,
    });
    if (!r.ok) { _toast('Taak mislukt: ' + r.error, 'error'); return; }
    _toast('Bel-taak aangemaakt.', 'success');
  };

  function _stopInboxRealtime() {
    if (_live.inboxRealtime.pollTimer) { clearInterval(_live.inboxRealtime.pollTimer); _live.inboxRealtime.pollTimer = null; }
    if (_live.inboxRealtime.channel && window.supabase && typeof window.supabase.removeChannel === 'function') {
      try { window.supabase.removeChannel(_live.inboxRealtime.channel); } catch (_) {}
    }
    _live.inboxRealtime.channel = null;
    _live.inboxRealtime.active  = false;
  }

  function _inboxConvsListHtml() {
    const st = _live.inbox.convs;
    if (st.loading && !st.items.length) return _skelRows(6);
    if (st.error  && !st.items.length) return `<div style="padding:14px">${_errBlk(st.error, 'inbox')}</div>`;
    // SURFACE A (v1-parity): scoping via server-side is_debtor-veld (fallback
    // op overzicht-intersect voor legacy respons), ongelezen-eerst sortering.
    // Volledige logic in _selectVisibleInboxItems zodat _fetchInboxConvs auto-
    // open dezelfde criteria hanteert.
    const items = _selectVisibleInboxItems(asArr(st.items));
    if (!items.length) return `<div style="padding:44px 14px;text-align:center;color:var(--text-3);font-size:12.5px">Geen wanbetaler-gesprekken in dit filter.</div>`;
    return items.map((c) => {
      const cid = String(c.id);
      const active = _ui.inbox.selectedConv === cid;
      const name = c.customer_name || c.display_name || c.phone_number || 'Onbekend';
      const preview = c.last_message_preview || '';
      // BROK WB-FIDELITY-1 goedkoop: relatieve tijd i.p.v. absolute.
      const when = c.last_activity_at
        ? _wbxRelativeTime(c.last_activity_at)
        : (c.last_message_at ? _wbxRelativeTime(c.last_message_at) : '');
      const unread = Number(c.total_unread ?? c.unread_count) || 0;
      const briefBadge = c.brief_sent ? '<span title="Brief verstuurd" style="font-size:9.5px;padding:1px 5px;border-radius:4px;background:var(--blue-soft);color:var(--blue);font-weight:600;margin-left:4px">✉</span>' : '';
      // BROK WB-FIDELITY-1 goedkoop: avatar-initialen cirkel links.
      const initials = _wbxInitialsFor(name);
      const bg = active
        ? 'var(--brand-soft,#E2F1F5)'
        : (unread > 0 ? 'var(--rose-soft, rgba(244,63,94,.06))' : 'transparent');
      const stripe = unread > 0 && !active ? 'border-left:3px solid var(--rose);padding-left:9px;' : '';
      return `<div onclick="__wbxInboxSelect('${esc(cid)}')" style="padding:9px 12px;border-bottom:1px solid var(--border);cursor:pointer;background:${bg};transition:background .08s;${stripe};display:flex;gap:9px;align-items:flex-start">
        <div style="width:32px;height:32px;border-radius:50%;background:var(--brand-soft,#E2F1F5);color:var(--brand);font-size:11.5px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;letter-spacing:.05em;text-transform:uppercase">${esc(initials)}</div>
        <div style="min-width:0;flex:1">
          <div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">
            <div style="font-weight:${unread > 0 ? '700' : '500'};font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${esc(name)}${briefBadge}</div>
            <div style="font-size:10.5px;color:${unread > 0 ? 'var(--rose)' : 'var(--text-3)'};white-space:nowrap;font-weight:${unread > 0 ? '600' : '400'}">${esc(when)}</div>
          </div>
          <div style="font-size:11.5px;color:${unread > 0 ? 'var(--text-1)' : 'var(--text-3)'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px;font-weight:${unread > 0 ? '500' : '400'}">${esc(preview)}</div>
          ${unread > 0 ? `<div style="margin-top:3px"><span style="display:inline-block;background:var(--rose);color:#fff;font-size:10px;padding:1px 6px;border-radius:8px;font-weight:600">${unread}</span></div>` : ''}
        </div>
      </div>`;
    }).join('');
  }

  /* BROK WB-FIDELITY-1 goedkoop: helpers avatar-initialen + relatieve tijd. */
  function _wbxInitialsFor(name) {
    if (!name || typeof name !== 'string') return '?';
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2);
    return parts[0][0] + parts[parts.length - 1][0];
  }
  function _wbxRelativeTime(iso) {
    if (!iso) return '';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const now = Date.now();
    const diffSec = Math.max(0, Math.floor((now - t) / 1000));
    if (diffSec < 45) return 'net';
    if (diffSec < 60 * 45) return Math.round(diffSec / 60) + 'm';
    if (diffSec < 60 * 60 * 24) return Math.round(diffSec / 3600) + 'u';
    if (diffSec < 60 * 60 * 24 * 7) return Math.round(diffSec / 86400) + 'd';
    // > 7 dagen: datum kort.
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
  }

  /* BROK WB-FIDELITY-1 goedkoop: no-reply cyclus-banner. Lazy-fetch via
     inbox-noreply-context; toon in thread wanneer paused + next_reminder
     bekend is. Silent-fail (no banner) als endpoint faalt of geen data. */
  _live.inbox.noreply = _live.inbox.noreply || { byConv: {}, loading: {} };
  async function _fetchInboxNoreply(convId) {
    if (!convId) return;
    const bag = _live.inbox.noreply;
    if (bag.loading[convId] || bag.byConv[convId] != null) return;
    bag.loading[convId] = true;
    const j = await tryFetch('inbox:noreply:' + convId, `/api/inbox-noreply-context?conversation_id=${encodeURIComponent(convId)}`, 6000);
    bag.loading[convId] = false;
    bag.byConv[convId] = (j && !j.error) ? j : null;
    // Silent — surgical repaint van thread-scroll behoudt scroll (via _repaintInboxThread).
    if (convId === _ui.inbox.selectedConv) _repaintInboxThread(convId);
  }
  function _inboxNoreplyBannerHtml(convId) {
    const nr = _live.inbox.noreply?.byConv?.[convId];
    if (!nr) return '';
    if (!nr.paused && (!nr.next_reminder_at || !nr.next_reminder_kind)) return '';
    const kind = nr.next_reminder_kind ? String(nr.next_reminder_kind).toUpperCase() : '—';
    const when = nr.next_reminder_at ? _fmtDateTime(nr.next_reminder_at) : '';
    return `<div style="padding:6px 12px;background:var(--amber-soft,#FFF4E5);border:1px solid var(--amber);border-radius:6px;font-size:11.5px;color:var(--amber);margin-bottom:10px">
      ⏸ No-reply cyclus: <b>${esc(kind)}</b> volgt ${esc(when || 'binnenkort')}${nr.reminder_count ? ' · ' + esc(String(nr.reminder_count)) + ' reminders verstuurd' : ''}
    </div>`;
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
    // BROK WB-FIDELITY-1 goedkoop: lazy-fetch no-reply-context bij eerste render.
    if (_live.inbox.noreply?.byConv?.[convId] == null && !_live.inbox.noreply?.loading?.[convId]) {
      queueMicrotask(() => _fetchInboxNoreply(convId));
    }
    const noreplyBanner = _inboxNoreplyBannerHtml(convId);
    return noreplyBanner + items.map((m) => {
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

    /* SURFACE A: compose action-bar met 6 v1-knoppen. Bijlage / Template /
       Snel antwoord / Vraag Joost / ⋮ (submenu Bel-taak, Regeling) / Verstuur.
       Kanaal-toggle (WA/mail) blijft bovenaan; status-knoppen verhuisd naar
       de kebab-menu bovenin de thread. */
    const composeMenu = _ui.inbox.composeMenuOpen ? _inboxComposeMenuHtml(convId, conv) : '';
    const attachBtn = c.channel === 'wa' && canSendText
      ? `<button class="btn btn-ghost btn-sm" style="font-size:11px;padding:4px 9px" onclick="__wbxInboxAttach()" title="Bestand als bijlage sturen">📎</button>` : '';
    const tplBtn = c.channel === 'wa'
      ? `<button class="btn btn-ghost btn-sm" style="font-size:11px;padding:4px 9px" onclick="__wbxInboxOpenTplPicker()" title="Template kiezen">Template</button>` : '';
    const qrBtn = c.channel === 'wa' && canSendText
      ? `<button class="btn btn-ghost btn-sm" style="font-size:11px;padding:4px 9px" onclick="__wbxInboxOpenQr()" title="Snel antwoord">Snel antw.</button>` : '';
    const joostBtn = `<button class="btn btn-ghost btn-sm" style="font-size:11px;padding:4px 9px;color:var(--brand)" onclick="__wbxInboxAskJoost('${esc(convId)}')" title="Vraag Joost om een suggestie">🤖 Joost</button>`;
    const moreBtn = `<button class="btn btn-ghost btn-sm" style="font-size:12.5px;padding:4px 9px;font-weight:700;position:relative" onclick="event.stopPropagation();__wbxInboxComposeMenu()" title="Meer">⋮${composeMenu}</button>`;

    return `<div style="border-top:1px solid var(--border);background:var(--surface);padding:10px 14px">
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap">
        ${chBtn('wa', '💬 WhatsApp')}
        ${chBtn('mail', '✉ E-mail')}
      </div>
      ${composerHtml}
      ${errLine}
      <div style="display:flex;justify-content:flex-end;gap:5px;margin-top:8px;align-items:center;flex-wrap:wrap">
        ${attachBtn}${tplBtn}${qrBtn}${joostBtn}${moreBtn}
        <button class="btn btn-primary btn-sm" style="font-size:11.5px;margin-left:6px" onclick="__wbxInboxSend()" ${c.sending ? 'disabled' : ''}>${c.sending ? 'Bezig…' : 'Verstuur'}</button>
      </div>
    </div>`;
  }

  /* SURFACE A: compose-⋮ submenu — Bel-taak / Regeling / Pauzeer flow.
     Zelfde pattern als de thread-kop kebab: klik buiten sluit. */
  function _inboxComposeMenuHtml(convId, conv) {
    const custId = conv?.customer_id || null;
    const item = (label, icon, onclick) => `<button style="display:flex;align-items:center;gap:9px;padding:8px 12px;background:transparent;border:none;border-bottom:1px solid var(--border);text-align:left;width:100%;cursor:pointer;font-size:12px;color:var(--text-1);font:inherit" onmouseover="this.style.background='var(--surface-2)'" onmouseout="this.style.background='transparent'" onclick="event.stopPropagation();__wbxInboxComposeMenuClose();${onclick}"><span style="font-size:14px;line-height:1;min-width:18px">${icon}</span><span style="flex:1;white-space:nowrap">${esc(label)}</span></button>`;
    const items = [];
    if (custId) items.push(item('Bel-taak aanmaken', '📞', `__wbxInboxCreateFollowup('${esc(custId)}','${esc(convId)}')`));
    if (custId) items.push(item('Regeling voorstellen', '🤝', `__wbxOpenCase('${esc(custId)}')`));
    if (custId) items.push(item('Pauzeer aanmaan-flow', '⏸', `__wbxInboxPauseFlow('${esc(custId)}')`));
    return `<div id="wbxInboxComposeMenu" style="position:absolute;bottom:100%;right:0;z-index:200;background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:0 -6px 18px rgba(0,0,0,.14);min-width:210px;overflow:hidden;margin-bottom:4px">${items.join('')}</div>`;
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

    // BROK WB-FIDELITY-1 #1: 5-knops v1-actiesbar als DIRECTE knoppen +
    // klant-info-blok + "oudste X dagen te laat"-banner + section-headers.
    // Endpoints allemaal bestaand:
    //   Bekijk in klanten → deeplink /modules/klanten.html?id=X (v1-parity)
    //   Maak factuur aan  → openInvoiceCreateModal({customer}) via dynamic import
    //   Claimt betaald    → verify-flow (per-factuur; opent invoice-picker)
    //   Leg afspraak vast → dunning-pipeline-appointment
    //   Escaleren         → tasks-create-escalation
    //   + Actie (bestaand ▾-menu blijft als aanvullend)
    const oldestOverdue = invs.reduce((m, iv) => Math.max(m, Number(iv.days_overdue) || 0), 0);
    const custSince = cust.created_at ? _fmtDate(cust.created_at) : null;
    const btn = (label, icon, onclick, tone) => {
      const color = tone === 'brand'  ? 'var(--brand)'
                  : tone === 'ok'     ? 'var(--emerald)'
                  : tone === 'warn'   ? 'var(--amber)'
                  : tone === 'danger' ? 'var(--rose)'
                  : 'var(--text-2)';
      return `<button class="btn btn-ghost btn-sm" style="font-size:11px;padding:5px 9px;color:${color};text-align:left;justify-content:flex-start;width:100%" onclick="${onclick}"><span style="margin-right:6px;display:inline-block;width:14px;text-align:center">${icon}</span>${esc(label)}</button>`;
    };

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
      <div style="padding:14px 14px 12px;border-bottom:1px solid var(--border);background:var(--surface-2)">
        <div style="font-weight:700;font-size:13.5px;margin-bottom:3px;${cust.id ? 'cursor:pointer;text-decoration:underline;text-decoration-color:transparent;text-underline-offset:3px;transition:text-decoration-color .12s' : ''}"
          ${cust.id ? `onclick="event.stopPropagation();__wbxOpenCase('${esc(cust.id)}',{customer_name:'${String(cust.name || '').replace(/'/g,"\\'")}'})" onmouseover="this.style.textDecorationColor='var(--brand)'" onmouseout="this.style.textDecorationColor='transparent'" title="Klik voor dossier"` : ''}>${esc(cust.name || 'Onbekende klant')}</div>
        ${cust.email ? `<div style="font-size:11.5px;color:var(--text-2);word-break:break-all;margin-bottom:2px">✉ ${esc(cust.email)}</div>` : ''}
        ${phone ? `<div style="font-size:11.5px;color:var(--text-2)">📞 ${esc(phone)}</div>` : ''}
        ${oldestOverdue > 0 ? `<div style="font-size:11px;color:var(--rose);font-weight:600;margin-top:6px">⚠ Oudste ${oldestOverdue} dagen te laat</div>` : ''}
      </div>

      <div style="padding:8px 12px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:3px">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3);font-weight:700;padding:2px 2px 6px">Acties</div>
        ${btn('Bekijk in klanten',   '↗', `__wbxRightGoToKlant('${esc(cust.id)}')`,          'text')}
        ${btn('Maak factuur aan',    '📄', `__wbxRightNewInvoice('${esc(cust.id)}')`,        'brand')}
        ${btn('Klant claimt betaald', '✓', `__wbxRightVerifyPaid('${esc(cust.id)}')`,        'ok')}
        ${btn('Leg afspraak vast',   '📅', `__wbxRightMakeAppointment('${esc(cust.id)}')`,   'text')}
        ${btn('Escaleren',           '⚠', `__wbxRightEscalate('${esc(cust.id)}')`,          'warn')}
        <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">
          <button class="btn btn-primary btn-sm" style="font-size:11px;padding:5px 10px;flex:1" onclick="__wbxOpenCase('${esc(cust.id)}')">Dossier →</button>
          <button class="btn btn-ghost btn-sm" style="font-size:11px;padding:5px 10px;color:var(--brand)" onclick="__wbxOpenActieMenu('${esc(cust.id)}')" title="Meer acties via menu">➕ Actie</button>
        </div>
      </div>

      <div style="padding:12px 14px;border-bottom:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3);font-weight:700">Open facturen</div>
          <div style="font-family:'IBM Plex Mono',monospace;font-size:14px;font-weight:700;color:var(--rose)">${eur(totalOpen)}</div>
        </div>
        <div style="font-size:11px;color:var(--text-3);margin-bottom:4px">${invs.length} factuur${invs.length === 1 ? '' : 'en'}</div>
        ${invsHtml}
      </div>

      ${subs.length ? `<div style="padding:12px 14px;border-bottom:1px solid var(--border)">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
          <div style="font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3);font-weight:700">Actieve abonnementen</div>
          <div style="font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--text-2)">${eur(mrr)}/m</div>
        </div>
        ${subsHtml}
      </div>` : ''}

      <div style="padding:10px 14px;font-size:11px;color:var(--text-3);border-top:1px solid var(--border);margin-top:auto">
        <div style="text-transform:uppercase;letter-spacing:.05em;font-weight:700;margin-bottom:3px">Klant info</div>
        ${custSince ? `<div>Klant sinds ${esc(custSince)}</div>` : '<div style="opacity:.6">Datum onbekend</div>'}
        ${cust.email ? `<div style="margin-top:2px;word-break:break-all">${esc(cust.email)}</div>` : ''}
      </div>
    </div>`;
  }

  /* BROK WB-FIDELITY-1 #1: rechter-paneel 5-knops action-handlers.
     Alle via bestaande endpoints; custom confirms + race-guards. */
  window.__wbxRightGoToKlant = (cid) => {
    if (!cid) return;
    // v1-parity: deeplink naar klanten-detail-tab.
    try { window.open('/modules/klanten.html?id=' + encodeURIComponent(cid) + '#wanbetalers', '_blank', 'noopener'); } catch (_) {}
  };
  window.__wbxRightNewInvoice = async (cid) => {
    if (!cid) return;
    // Lazy load klant-object (voor customer-selector prefill in de modal).
    const ctx = _live.inbox.ctx.byConv[_ui.inbox.selectedConv];
    const cust = ctx?.customer && ctx.customer.id === cid ? ctx.customer : { id: cid };
    try {
      const mod = await import('./modals/invoice-create.js?v=8');
      mod.openInvoiceCreateModal({ customer: cust, onSuccess: () => _toast('Factuur aangemaakt.', 'success') });
    } catch (e) { _toast('Modal laden mislukt: ' + (e?.message || e), 'error'); }
  };
  window.__wbxRightVerifyPaid = (cid) => {
    // Delegate naar bestaande verify-flow uit BROK 2 ACT-1.
    if (typeof _actieVerify === 'function') {
      const ctx = _live.inbox.ctx.byConv[_ui.inbox.selectedConv];
      _actieVerify(cid, asArr(ctx?.open_invoices));
    } else if (typeof window.__wbxOpenActieMenu === 'function') {
      window.__wbxOpenActieMenu(cid);
    }
  };
  window.__wbxRightMakeAppointment = async (cid) => {
    if (!cid) return;
    const bodyHtml = `
      <div style="display:flex;flex-direction:column;gap:10px">
        <div>
          <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Titel</div>
          <input id="wbxApptTitle" type="text" maxlength="200" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;box-sizing:border-box" placeholder="Bv. Bel-terug maandag 10:00" />
        </div>
        <div>
          <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Datum + tijd</div>
          <input id="wbxApptDue" type="datetime-local" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;box-sizing:border-box" />
        </div>
        <div>
          <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Notitie (optioneel)</div>
          <textarea id="wbxApptNote" rows="2" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;resize:vertical;box-sizing:border-box"></textarea>
        </div>
      </div>`;
    const form = await _askForm('Afspraak vastleggen', bodyHtml, (root) => {
      const title = String(root.querySelector('#wbxApptTitle')?.value || '').trim();
      const due   = root.querySelector('#wbxApptDue')?.value || null;
      const note  = String(root.querySelector('#wbxApptNote')?.value || '').trim();
      if (!title) { _toast('Titel is vereist.', 'warn'); return null; }
      if (!due)   { _toast('Datum + tijd is vereist.', 'warn'); return null; }
      return { title, due_at: new Date(due).toISOString(), note };
    }, { okLabel: 'Vastleggen' });
    if (!form) return;
    const r = await apiPost('/api/dunning-pipeline-appointment', {
      customer_id: cid, title: form.title, due_at: form.due_at, note: form.note || null,
    });
    if (!r.ok) { _toast('Afspraak-aanmaak mislukt: ' + r.error, 'error'); return; }
    _toast('Afspraak vastgelegd.', 'success');
    if (_live.timeline?.byCust) delete _live.timeline.byCust[cid];
  };
  window.__wbxRightEscalate = (cid) => {
    // Delegate naar bestaande escalatie-flow uit BROK 2 ACT-1.
    if (typeof _actieEscalatie === 'function') _actieEscalatie(cid);
    else if (typeof window.__wbxOpenActieMenu === 'function') window.__wbxOpenActieMenu(cid);
  };

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
    // Overzicht behouden voor legacy-fallback scoping (als backend geen is_debtor levert).
    if (!_live.overzicht.fetched && !_live.overzicht.loading && !_live.overzicht.error) queueMicrotask(_fetchOverzicht);
    // SURFACE A: realtime subscribe + poll-fallback bij eerste render.
    if (!_live.inboxRealtime.active) queueMicrotask(_startInboxRealtime);
    const convId = _ui.inbox.selectedConv;
    const qVal = String(_ui.inbox.searchQ || '');
    // SURFACE A (v1-parity): filter-chips volgorde ACTIEF · AFGEHANDELD · ARCHIEF (icon-only) · ALLE.
    const statusBtn = (v, l, iconOnly) => `<button class="chip ${_ui.inbox.statusFilter === v ? 'on' : ''}" style="font-size:11px;padding:3px 9px" onclick="__wbxInboxStatus('${v}')" title="${esc(l)}">${iconOnly ? '📦' : esc(l)}</button>`;
    const sortBtn = (v, l) => `<button class="chip ${_ui.inbox.sortMode === v ? 'on' : ''}" style="font-size:10.5px;padding:2px 7px" onclick="__wbxInboxSort('${v}')" title="${esc(l)}">${esc(l)}</button>`;

    return `<div data-wbx-view="gesprekken" class="pad" style="padding:14px 20px 0">
      <div style="display:flex;gap:0;height:calc(100vh - 200px);min-height:520px;border:1px solid var(--border);border-radius:var(--r);overflow:hidden;background:var(--surface)">
        <div style="width:320px;min-width:260px;max-width:38%;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column">
          <div style="padding:10px 12px;border-bottom:1px solid var(--border)">
            <input id="wbxInboxSearch" type="text" value="${esc(qVal)}" oninput="__wbxInboxSearch(this.value)" placeholder="Zoek naam / nummer / e-mail…" style="width:100%;padding:6px 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);color:var(--text-1);font-size:12px;box-sizing:border-box" autocomplete="off" spellcheck="false" />
            <div style="display:flex;gap:4px;margin-top:6px;flex-wrap:wrap">
              ${statusBtn('active', 'Actief')}
              ${statusBtn('afgehandeld', 'Afgehandeld')}
              ${statusBtn('archief', 'Archief', true)}
              ${statusBtn('all', 'Alle')}
            </div>
            <div style="display:flex;gap:4px;margin-top:5px;flex-wrap:wrap;align-items:center">
              <span style="font-size:9.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em;font-weight:600">Sort</span>
              ${sortBtn('unread_first', 'Ongelezen eerst')}
              ${sortBtn('latest', 'Laatste bericht')}
            </div>
          </div>
          <div id="wbxInboxList" style="flex:1;overflow-y:auto;min-height:0">${_inboxConvsListHtml()}</div>
        </div>
        <div style="flex:1;display:flex;flex-direction:column;min-width:0">
          ${_inboxThreadHeaderHtml(convId)}
          <div id="wbxInboxThreadScroll" style="flex:1;overflow-y:auto;padding:12px 14px;background:var(--surface-2)">${_inboxThreadHtml(convId)}</div>
          ${_inboxComposeHtml(convId)}
        </div>
        <div id="wbxInboxRightPane" style="width:300px;min-width:260px;max-width:34%;background:var(--surface);border-left:1px solid var(--border);display:flex;flex-direction:column;min-height:0">
          ${_inboxKlantgegevensHtml(convId)}
        </div>
      </div>
      ${_officeHoursBanner()}
    </div>`;
  }

  /* SURFACE A — Thread-header: v1-faithful topbar boven de messages.
     Bevat: naam · Brief-tag · <spacer> · 24h-badge · ✓ Afhandelen · + Nieuwe
     actie · 👤 Klantgegevens · ⋮ kebab-menu (8 v1-items).
     Klik op ⋮ toont dropdown-panel; klik buiten (of nieuwe klik) sluit. */
  function _inboxThreadHeaderHtml(convId) {
    if (!convId) return '';
    const bag  = _live.inbox.thread.byConv[convId];
    const conv = bag?.conversation || null;
    // BROK WB-FIX-3 nit + WB-FIX-4 #6: unfiltered convs.items + ctx-fallback
    // NAAR KLANTNAAM (niet telefoonnummer). ctx.customer.name uit
    // inbox-conversation-context wint als convs.items niet in cache staat.
    const row  = (_live.inbox.convs.items || []).find((x) => String(x.id) === String(convId)) || {};
    const ctx  = _live.inbox.ctx.byConv[convId] || null;
    const name = conv?.customer_name
              || row.customer_name
              || ctx?.customer?.name
              || row.display_name
              || conv?.display_name
              || 'Onbekende klant';
    // BROK WB-FIDELITY-1 #2: DB-status = 'open|closed|archived' (per CLAUDE.md);
    // UI-status vertaalt 'closed'->'afgehandeld' en 'archived'->'gearchiveerd'.
    // Check BEIDE zodat Heropenen (op afgehandeld) en Uit archief (op archived)
    // in de kebab verschijnen ongeacht welke naam het endpoint teruggeeft.
    const isArchived   = ['gearchiveerd', 'archived'].includes(row.status) || ['gearchiveerd', 'archived'].includes(conv?.status);
    const isDone       = ['afgehandeld', 'closed'].includes(row.status)    || ['afgehandeld', 'closed'].includes(conv?.status);
    const canSend24h   = conv?.can_send_text !== false;
    const briefSent    = !!row.brief_sent;
    const custId       = conv?.customer_id || row.customer_id || null;
    const totalUnread  = Number(row.total_unread ?? row.unread_count) || 0;

    const briefBadge = briefSent
      ? '<span title="WIK-brief verstuurd" style="font-size:10px;padding:2px 7px;border-radius:5px;background:var(--emerald-soft);color:var(--emerald);font-weight:600">✓ Brief</span>'
      : '<span title="Nog geen WIK-brief" style="font-size:10px;padding:2px 7px;border-radius:5px;background:var(--surface-2);color:var(--text-3);font-weight:600">× Brief</span>';
    const window24 = canSend24h
      ? '<span title="24u-venster open — vrije tekst mag" style="font-size:10px;padding:2px 7px;border-radius:5px;background:var(--emerald-soft);color:var(--emerald);font-weight:600">24u ✓</span>'
      : '<span title="24u-venster verlopen — alleen templates" style="font-size:10px;padding:2px 7px;border-radius:5px;background:var(--amber-soft);color:var(--amber);font-weight:600">24u ×</span>';

    const kebab = _ui.inbox.kebabOpen ? _inboxKebabMenuHtml(convId, { isArchived, isDone, totalUnread, custId }) : '';

    // BROK WB-FIX-2 (minor): responsive thread-kop. Twee rows in flex-column
    // zodat op smalle breedte (~1068px) de naam niet naar 'D.' krimpt en de
    // brief-tag niet afbreekt. Rij 1: naam + brief-tag + 24u-badge (mag
    // wrappen). Rij 2: actie-knoppen (rechts uitgelijnd). Klik-buiten sluit
    // via document.addEventListener in __wbxInboxKebab.
    return `<div style="padding:8px 14px;border-bottom:1px solid var(--border);background:var(--surface);display:flex;flex-direction:column;gap:6px;position:relative">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0">
        ${custId
          ? `<b style="font-size:13px;min-width:0;flex-shrink:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;cursor:pointer;text-decoration:underline;text-decoration-color:transparent;text-underline-offset:3px;transition:text-decoration-color .12s" onclick="event.stopPropagation();__wbxOpenCase('${esc(custId)}',{customer_name:'${String(name).replace(/'/g,"\\'")}'})" onmouseover="this.style.textDecorationColor='var(--brand)'" onmouseout="this.style.textDecorationColor='transparent'" title="Klik voor dossier">${esc(name)}</b>`
          : `<b style="font-size:13px;min-width:0;flex-shrink:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%">${esc(name)}</b>`}
        <span style="display:flex;gap:5px;align-items:center;flex-shrink:0">
          ${briefBadge}
          ${window24}
        </span>
      </div>
      <div style="display:flex;gap:4px;align-items:center;justify-content:flex-end;flex-wrap:wrap">
        ${!isDone ? `<button class="btn btn-ghost btn-sm" style="font-size:11px;padding:3px 8px;color:var(--emerald)" onclick="__wbxInboxSetStatus('afgehandeld')" title="Markeer als afgehandeld">✓ Afhandelen</button>` : ''}
        ${custId ? `<button class="btn btn-ghost btn-sm" style="font-size:11px;padding:3px 8px;color:var(--brand)" onclick="__wbxOpenActieMenu('${esc(custId)}')" title="Nieuwe actie">+ Actie</button>` : ''}
        ${custId ? `<button class="btn btn-ghost btn-sm" style="font-size:11px;padding:3px 8px" onclick="__wbxOpenCase('${esc(custId)}')" title="Dossier openen">👤 Dossier</button>` : ''}
        <button class="btn btn-ghost btn-sm" style="font-size:13px;padding:3px 8px;font-weight:700" onclick="event.stopPropagation();__wbxInboxKebab()" title="Meer">⋮</button>
      </div>
      ${kebab}
    </div>`;
  }

  /* SURFACE A: 8-item kebab menu (v1-parity). Elk item aan een bestaand
     endpoint. Volgorde en zichtbaarheid volgt v1 — bv. Uit archief halen
     alleen als isArchived, Heropenen alleen als isDone. */
  function _inboxKebabMenuHtml(convId, ctx) {
    const { isArchived, isDone, totalUnread, custId } = ctx;
    const item = (label, icon, onclick, extra) => `<button style="display:flex;align-items:center;gap:9px;padding:8px 12px;background:transparent;border:none;border-bottom:1px solid var(--border);text-align:left;width:100%;cursor:pointer;font-size:12.5px;color:var(--text-1);font:inherit" onmouseover="this.style.background='var(--surface-2)'" onmouseout="this.style.background='transparent'" onclick="event.stopPropagation();__wbxInboxKebabClose();${onclick}"><span style="font-size:14px;line-height:1;min-width:18px">${icon}</span><span style="flex:1">${esc(label)}</span>${extra || ''}</button>`;
    const items = [];
    // 1. Archiveren (verberg als reeds gearchiveerd)
    if (!isArchived) items.push(item('Archiveren',   '📦', `__wbxInboxSetStatus('gearchiveerd')`));
    // 2. Heropenen (alleen als afgehandeld)
    if (isDone)     items.push(item('Heropenen',    '↩',  `__wbxInboxSetStatus('open')`));
    // 3. Uit archief halen (alleen als gearchiveerd)
    if (isArchived) items.push(item('Uit archief halen','📤', `__wbxInboxSetStatus('open')`));
    // 4. Markeer gelezen (alleen zichtbaar als er unread staan)
    if (totalUnread > 0) items.push(item('Markeer gelezen',   '✓', `__wbxInboxMarkRead('${esc(convId)}')`));
    // 5. Markeer ongelezen (alleen zichtbaar als er GEEN unread staan)
    if (totalUnread === 0) items.push(item('Markeer ongelezen', '●', `__wbxInboxMarkUnread('${esc(convId)}')`));
    // 6. Dossier openen (opent SURFACE B drawer)
    if (custId) items.push(item('Dossier openen', '👤', `__wbxOpenCase('${esc(custId)}')`));
    // 7. Stuur een brief (WIK-brief NL, opent generatie-flow)
    if (custId) items.push(item('Stuur een brief', '✉', `__wbxWikGen('${esc(custId)}','NL')`));
    // 8. Pauzeer aanmaan-flow
    if (custId) items.push(item('Pauzeer aanmaan-flow', '⏸', `__wbxInboxPauseFlow('${esc(custId)}')`));
    return `<div id="wbxInboxKebab" style="position:absolute;top:100%;right:8px;z-index:200;background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:0 8px 22px rgba(0,0,0,.14);min-width:230px;overflow:hidden">
      ${items.join('')}
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
  // SURFACE B: v1-faithful drawer data — pipeline-detail (fase + open_invoices),
  // conv+laatste chat-bubbles, Joost-suggestie (60min max age).
  _live.caseFaithful = {
    pipeByCust:    {},   // cid → { loading, data, error }  (dunning-pipeline-detail)
    convByCust:    {},   // cid → { loading, convId, error } (inbox-conversation-by-customer)
    chatByCust:    {},   // cid → { loading, items, error }  (inbox-messages-list, last 8)
    joostByCust:   {},   // cid → { loading, items, error }  (joost-suggestions-recent)
  };
  _ui.caseSheet = { cid: null };
  _ui.callFormOpen = {};  // cid → true (belpoging-form uit case-sheet)

  async function _fetchCasePipeline(cid) {
    if (!cid) return;
    const bag = _live.caseFaithful.pipeByCust[cid] = _live.caseFaithful.pipeByCust[cid] || { loading: false, data: null, error: null };
    if (bag.loading || bag.data) return;
    // BROK C (2026-08-19): skip fetch als overzicht al zegt dat er GEEN open
    // factuur is. dunning-pipeline-detail geeft dan 404 (klant is niet in
    // pipeline-customers zonder actieve dunning-run) — dat is een verwachte
    // lege staat, niet een fout. Rode 404 in de console = ruis; door voor-
    // check te skippen voorkomen we zowel de netwerk-call ALS de log.
    // Fallback: als overzicht nog niet geladen is, doen we de fetch alsnog
    // (server is bron van waarheid; we willen geen valse "geen data" bij
    // race op de eerste render).
    const ovRow = asArr(_live.overzicht.items).find((r) => String(r.customer_id || r.id) === String(cid));
    const knownZero = ovRow && Number(ovRow.open_invoice_count) === 0;
    if (knownZero) {
      // Synthetische lege-state-response — same shape als de endpoint.
      // De UI (_caseFactuurCardHtml) checkt op openInvs.length === 0 → toont
      // netjes "Geen open factuur"-empty-state.
      bag.data = {
        customer:       { id: cid, name: ovRow.customer_name || null },
        pipeline:       null,
        open_invoices:  [],
        _synthetic:     true,  // debug-marker
      };
      bag.loading = false;
      _renderCaseSheet();
      return;
    }
    bag.loading = true; bag.error = null;
    const j = await tryFetch('case:pipe:' + cid, `/api/dunning-pipeline-detail?customer_id=${encodeURIComponent(cid)}`, 8000);
    if (j && j.error) bag.error = j.error;
    else bag.data = j;
    bag.loading = false; _renderCaseSheet();
  }
  async function _fetchCaseConvChat(cid) {
    if (!cid) return;
    const cbag = _live.caseFaithful.convByCust[cid] = _live.caseFaithful.convByCust[cid] || { loading: false, convId: null, error: null };
    if (cbag.loading || cbag.convId || cbag.error) return;
    cbag.loading = true;
    const cj = await tryFetch('case:conv:' + cid, `/api/inbox-conversation-by-customer?customer_id=${encodeURIComponent(cid)}`, 6000);
    cbag.loading = false;
    if (!cj || cj.error) { cbag.error = (cj && cj.error) || 'geen conv'; _renderCaseSheet(); return; }
    cbag.convId = cj.conversation_id || cj.id || null;
    if (!cbag.convId) { cbag.error = 'geen conv'; _renderCaseSheet(); return; }
    // Berichten ophalen (laatste 20 → render neemt laatste 8 er uit voor de card).
    const mbag = _live.caseFaithful.chatByCust[cid] = _live.caseFaithful.chatByCust[cid] || { loading: false, items: [], error: null };
    mbag.loading = true;
    const mj = await tryFetch('case:msgs:' + cid, `/api/inbox-messages-list?conversation_id=${encodeURIComponent(cbag.convId)}&limit=20`, 6000);
    mbag.loading = false;
    if (mj && mj.error) mbag.error = mj.error;
    else mbag.items = asArr(mj?.items);
    // Joost-suggestie (parallel, aparte call).
    const jbag = _live.caseFaithful.joostByCust[cid] = _live.caseFaithful.joostByCust[cid] || { loading: false, items: [], error: null };
    jbag.loading = true;
    const jj = await tryFetch('case:joost:' + cid, `/api/joost-suggestions-recent?conversation_id=${encodeURIComponent(cbag.convId)}&max_age_minutes=60`, 6000);
    jbag.loading = false;
    if (jj && jj.error) jbag.error = jj.error;
    else jbag.items = asArr(jj?.items);
    _renderCaseSheet();
  }

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

  // SURFACE B: __wbxOpenCase opent een body-level right-slide drawer met scrim.
  // Warmt pipeline-detail (fase + facturen), conv+chat, briefs, timeline, call-log.
  // BROK WB-FIX-3 #2: 2e arg = opts { customer_name?, phone? } zodat call-sites
  // die WEL een naam kennen die kunnen doorgeven — voorkomt "Onbekend"-flash
  // wanneer pipeline-detail leeg customer-object teruggeeft.
  window.__wbxOpenCase = (cid, opts) => {
    if (!cid) return;
    _ui.caseSheet.cid = String(cid);
    _ui.caseSheet.openOpts = opts && typeof opts === 'object' ? opts : {};
    // Reset joost/pipeline cache zodat verse data komt bij re-open.
    delete _live.caseFaithful.pipeByCust[cid];
    delete _live.caseFaithful.convByCust[cid];
    delete _live.caseFaithful.chatByCust[cid];
    delete _live.caseFaithful.joostByCust[cid];
    queueMicrotask(() => _fetchCasePipeline(cid));
    queueMicrotask(() => _fetchCaseConvChat(cid));
    if (!_live.callLog.byCust[cid])  queueMicrotask(() => _fetchCallLog(cid));
    if (!_live.timeline.byCust[cid]) queueMicrotask(() => _fetchTimeline(cid));
    if (!_live.arrangements.byCust) queueMicrotask(_fetchArrangements);
    queueMicrotask(() => _fetchCaseBriefs(cid));
    _openCaseSheetDom();
  };
  window.__wbxCloseCase = () => {
    _ui.caseSheet.cid = null;
    _ui.callFormOpen = {};
    const scrim = document.getElementById('wbxCaseScrim');
    const drawer = document.getElementById('wbxCaseDrawer');
    if (scrim)  scrim.remove();
    if (drawer) drawer.remove();
    document.removeEventListener('keydown', _caseSheetKey);
  };

  function _caseSheetKey(e) { if (e.key === 'Escape') window.__wbxCloseCase(); }

  function _openCaseSheetDom() {
    let scrim = document.getElementById('wbxCaseScrim');
    if (!scrim) {
      scrim = document.createElement('div');
      scrim.id = 'wbxCaseScrim';
      scrim.style.cssText = 'position:fixed;inset:0;z-index:9500;background:rgba(17,23,33,.42);animation:wbxScrimFade .15s ease';
      scrim.addEventListener('click', window.__wbxCloseCase);
      document.body.appendChild(scrim);
    }
    let drawer = document.getElementById('wbxCaseDrawer');
    if (!drawer) {
      drawer = document.createElement('aside');
      drawer.id = 'wbxCaseDrawer';
      drawer.setAttribute('role', 'dialog');
      drawer.setAttribute('aria-modal', 'true');
      drawer.style.cssText = 'position:fixed;top:0;right:0;bottom:0;z-index:9600;width:min(760px,100vw);background:var(--surface);border-left:1px solid var(--border);box-shadow:-6px 0 22px rgba(0,0,0,.14);display:flex;flex-direction:column;overflow:hidden;animation:wbxSlideIn .22s ease';
      document.body.appendChild(drawer);
      document.addEventListener('keydown', _caseSheetKey);
    }
    _renderCaseSheet();
  }

  function _renderCaseSheet() {
    const drawer = document.getElementById('wbxCaseDrawer');
    if (!drawer || !_ui.caseSheet.cid) return;
    drawer.innerHTML = _caseSheetHtml();
  }
  // Backward-compat forward-ref voor callers uit BROK 4/5/6 die _repaintCaseSheet noemen.
  function _repaintCaseSheet() { _renderCaseSheet(); }

  /* SURFACE B — v1-faithful drawer render. Single-scroll met 5 cards
     (Factuur / Bellen / Gesprek / WIK-brief / Tijdlijn), fase-progress
     bovenaan en 8-item action-bar onderaan. Alle data via bestaande
     endpoints (dunning-pipeline-detail voor factuur + fase; inbox-conv +
     -messages voor gesprek; joost-suggestions-recent voor Joost-blurb;
     dunning-briefs-list voor WIK; wanbetalers-timeline voor tijdlijn). */
  function _caseSheetHtml() {
    const cid = _ui.caseSheet.cid;
    const pipeBag = _live.caseFaithful.pipeByCust[cid] || null;
    const pipe = pipeBag?.data || null;
    const pipeLoading = !!(pipeBag && pipeBag.loading);
    const row  = _findOvRow(cid);
    // BROK WB-FIX-3 #2: bronrij-first — vandaag-tegel geeft altijd
    // customer_name mee (Wacht op reactie / Stille dossiers). Pipeline-detail
    // returnt soms 200 met leeg customer-object (klant zonder open factuur/
    // active dunning-rij). Fix: gebruik pipeline-name IF gezet, anders bronrij
    // customer_name, anders opengeklikt-context row.customer_name (kan uit
    // pipeline-actions komen: awaiting/stale/apDue rows) — pas als laatste
    // fallback "Onbekend".
    const opts = _ui.caseSheet.openOpts || {};
    const name = pipe?.customer?.name
              || opts.customer_name
              || row?.customer_name
              || row?.name
              || (pipeLoading ? 'Laden…' : 'Onbekend');
    const stageSlug = pipe?.pipeline?.stage_slug || pipe?.stage_slug || row?.stage_slug || row?.stage || null;
    const openInvs  = asArr(pipe?.open_invoices);
    const focus     = openInvs[0] || null;
    const focusNr   = focus?.invoice_number || focus?.number || row?.invoice_number || '—';
    const focusOpen = Number(focus?.amount_open ?? focus?.open_amount ?? row?.total_open_cents / 100) || 0;
    // Dagen te laat: pipeline levert 'em vaak; fallback overzicht-row.
    let daysN = Number(focus?.days_overdue);
    if (!Number.isFinite(daysN) && focus?.due_date) {
      const t = new Date(focus.due_date).getTime();
      if (Number.isFinite(t) && t < Date.now()) daysN = Math.floor((Date.now() - t) / 86_400_000);
    }
    if (!Number.isFinite(daysN)) daysN = Number(row?.days_overdue) || 0;

    const arrs = (_live.arrangements.byCust || {})[cid] || [];
    const activeArr = arrs.length > 0;
    const phone = pipe?.customer?.phone || _customerPhone(row);

    return `<style>
      @keyframes wbxScrimFade { from { opacity: 0 } to { opacity: 1 } }
      @keyframes wbxSlideIn   { from { transform: translateX(100%) } to { transform: translateX(0) } }
      .wbx-drawer-scroll { flex: 1; overflow-y: auto; overflow-x: hidden; background: var(--surface-2); padding: 14px 18px }
      .wbx-drawer-card   { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r); margin-bottom: 12px; overflow: hidden }
      .wbx-drawer-card-h { padding: 10px 14px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; font-weight: 600; font-size: 13px }
      .wbx-drawer-card-b { padding: 10px 14px; font-size: 12.5px; color: var(--text-2) }
      .wbx-kv-row        { display: grid; grid-template-columns: 130px 1fr; gap: 8px; padding: 4px 0; font-size: 12.5px }
      .wbx-kv-l          { color: var(--text-3); font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em; font-weight: 600; padding-top: 2px }
      .wbx-flow-strip    { display: flex; align-items: center; gap: 6px; padding: 8px 18px 10px; border-bottom: 1px solid var(--border); background: var(--surface); flex-wrap: wrap }
      .wbx-step          { display: flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--text-3); font-weight: 500 }
      .wbx-step .wbx-bul { width: 8px; height: 8px; border-radius: 50%; background: var(--border); display: inline-block }
      .wbx-step.wbx-done { color: var(--emerald) } .wbx-step.wbx-done .wbx-bul { background: var(--emerald) }
      .wbx-step.wbx-here { color: var(--brand); font-weight: 700 } .wbx-step.wbx-here .wbx-bul { background: var(--brand); box-shadow: 0 0 0 3px var(--brand-soft, rgba(10,116,144,.16)) }
      .wbx-bar           { flex: 1; height: 2px; background: var(--border); min-width: 12px; max-width: 40px }
      .wbx-bar.wbx-done  { background: var(--emerald) }
      .wbx-msg-in, .wbx-msg-out { max-width: 78%; padding: 7px 11px; border: 1px solid var(--border); border-radius: var(--r-sm); font-size: 12px; margin-bottom: 6px; word-break: break-word }
      .wbx-msg-in  { background: var(--surface-2); align-self: flex-start }
      .wbx-msg-out { background: var(--brand-soft, #E2F1F5); align-self: flex-end; margin-left: auto }
    </style>
    <div style="padding:14px 18px;border-bottom:1px solid var(--border);background:var(--surface);display:flex;justify-content:space-between;align-items:flex-start;gap:14px">
      <div style="min-width:0;flex:1">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
          <button class="btn btn-ghost btn-sm" style="font-size:11px;padding:3px 8px" onclick="__wbxCloseCase()" title="Sluit (Esc)">← Terug</button>
          ${activeArr ? '<span style="font-size:10.5px;padding:2px 8px;border-radius:5px;background:var(--amber-soft);color:var(--amber);font-weight:600">⏸ Arrangement</span>' : ''}
          ${_caseBriefBadgeHtml(cid)}
        </div>
        <div style="font-size:16px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</div>
        ${openInvs.length === 0 && !pipeLoading
          ? `<div style="font-size:12px;color:var(--text-3);margin-top:3px">Geen open factuur</div>`
          : `<div style="font-size:12px;color:var(--text-3);margin-top:3px;font-family:'IBM Plex Mono',monospace">Factuur ${esc(focusNr)} · ${eur(focusOpen)} · ${daysN} dagen te laat</div>`
        }
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-shrink:0">
        ${_caseStagePillHtml(stageSlug)}
        <button class="icon-btn" onclick="__wbxCloseCase()" title="Sluit (Esc)" style="border:none;background:transparent;cursor:pointer;color:var(--text-2)"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
      </div>
    </div>
    ${_caseFlowStripHtml(stageSlug)}
    <div class="wbx-drawer-scroll">
      ${_caseFactuurCardHtml(cid, pipe, focus, daysN)}
      ${_caseBellenCardHtml(cid, phone, name)}
      ${_caseGesprekCardHtml(cid)}
      ${_caseWikCardHtml(cid)}
      ${_caseTijdlijnCardHtml(cid)}
    </div>
    ${_caseSheetActionBarHtml(cid, stageSlug)}`;
  }

  function _caseStagePillHtml(stageSlug) {
    if (!stageSlug) return '';
    const stageFromApi   = (asArr(_live.stages?.items).find((s) => s.slug === stageSlug) || {}).label;
    const stageFromConst = ((typeof PIPELINE_STAGES !== 'undefined' && PIPELINE_STAGES.find((s) => s[0] === stageSlug)) || [])[1];
    const label = stageFromApi || stageFromConst || stageSlug;
    const bg = stageSlug === 'opgelost' ? 'var(--emerald-soft)' : (stageSlug === 'incasso' ? 'var(--rose-soft)' : (stageSlug === 'dispuut' ? 'var(--amber-soft)' : 'var(--surface-2)'));
    const fg = stageSlug === 'opgelost' ? 'var(--emerald)'      : (stageSlug === 'incasso' ? 'var(--rose)'      : (stageSlug === 'dispuut' ? 'var(--amber)'      : 'var(--text-2)'));
    return `<span style="font-size:11px;padding:3px 10px;border-radius:5px;background:${bg};color:${fg};font-weight:600">${esc(label)}</span>`;
  }

  function _caseBriefBadgeHtml(cid) {
    const bag = _live.caseSheet.briefsByCust[cid];
    if (!bag || !bag.items) return '';
    const briefSent = bag.items.some((b) => b.sent_via === 'email' || b.sent_via === 'post');
    if (briefSent) return '<span title="WIK-brief verstuurd" style="font-size:10.5px;padding:2px 7px;border-radius:5px;background:var(--emerald-soft);color:var(--emerald);font-weight:600">✓ Brief</span>';
    const hasBrief = bag.items.length > 0;
    if (hasBrief) return '<span title="Brief aangemaakt, nog niet verstuurd" style="font-size:10.5px;padding:2px 7px;border-radius:5px;background:var(--amber-soft);color:var(--amber);font-weight:600">Brief · nog niet verstuurd</span>';
    return '<span title="Nog geen WIK-brief" style="font-size:10.5px;padding:2px 7px;border-radius:5px;background:var(--surface-2);color:var(--text-3);font-weight:600">× Geen brief</span>';
  }

  /* Fase-progress-bar. 4 vaste steps: Nieuw te laat → Aangemaand →
     In gesprek → <endLabel>. Slug-mapping bepaalt active step-index. */
  function _caseFlowStripHtml(stageSlug) {
    const map = { nieuw: 0, aangemaand: 1, brief_verstuurd: 1, in_gesprek: 2, regeling: 3, opgelost: 3, incasso: 3, afschrijven: 3, dispuut: 2, bewind: 2 };
    const endLabelMap = { regeling: 'Regeling', opgelost: 'Betaald', incasso: 'Incasso', afschrijven: 'Afgeschreven' };
    const idx = (stageSlug != null && map[stageSlug] != null) ? map[stageSlug] : 0;
    const endLabel = endLabelMap[stageSlug] || 'Uitkomst';
    const steps = ['Nieuw te laat', 'Aangemaand', 'In gesprek', endLabel];
    const parts = [];
    steps.forEach((label, i) => {
      const cls = i < idx ? 'wbx-done' : (i === idx ? 'wbx-here' : '');
      parts.push(`<div class="wbx-step ${cls}"><span class="wbx-bul"></span>${esc(label)}</div>`);
      if (i < steps.length - 1) parts.push(`<span class="wbx-bar ${i < idx ? 'wbx-done' : ''}"></span>`);
    });
    return `<div class="wbx-flow-strip">${parts.join('')}</div>`;
  }

  function _caseFactuurCardHtml(cid, pipe, focus, daysN) {
    const pipeBag = _live.caseFaithful.pipeByCust[cid];
    const pipeLoading = !!(pipeBag && pipeBag.loading);
    const openInvs = asArr(pipe?.open_invoices);
    const nOpen = openInvs.length;
    // BROK WB-FIX-3 #2: nette "geen open factuur"-empty-state i.p.v.
    // "— / €0,00 / 0d / —". Klant heeft mogelijk WEL een dunning-history
    // maar op dit moment geen open factuur (bv. na betaling voor cron
    // 'em heeft geresolved). Toon dat expliciet.
    if (!pipeLoading && nOpen === 0) {
      return `<div class="wbx-drawer-card">
        <div class="wbx-drawer-card-h">De factuur</div>
        <div class="wbx-drawer-card-b" style="color:var(--text-3)">
          <div style="padding:6px 0">Deze klant heeft momenteel <b>geen open factuur</b>.</div>
          <div style="font-size:11.5px;margin-top:2px">Achterstand kan zojuist zijn opgelost — check de tijdlijn voor recente betalingen.</div>
        </div>
      </div>`;
    }
    const nr = focus?.invoice_number || '—';
    const openEur = Number(focus?.amount_open ?? focus?.open_amount ?? 0);
    const isMulti = nOpen > 1;
    return `<div class="wbx-drawer-card">
      <div class="wbx-drawer-card-h">De factuur</div>
      <div class="wbx-drawer-card-b">
        <div class="wbx-kv-row"><div class="wbx-kv-l">Factuurnummer</div><div style="font-family:'IBM Plex Mono',monospace">${esc(nr)}</div></div>
        <div class="wbx-kv-row"><div class="wbx-kv-l">Bedrag</div><div style="font-family:'IBM Plex Mono',monospace;color:var(--rose);font-weight:600">${eur(openEur)}</div></div>
        <div class="wbx-kv-row"><div class="wbx-kv-l">Dagen te laat</div><div><b style="color:${daysN >= 30 ? 'var(--rose)' : (daysN >= 14 ? 'var(--amber)' : 'var(--text-1)')}">${daysN}d</b></div></div>
        <div class="wbx-kv-row"><div class="wbx-kv-l">Open facturen</div><div>${isMulti ? `<b>${nOpen}</b> — achterstand` : (nOpen === 1 ? '1 — enkel deze factuur' : '—')}</div></div>
      </div>
    </div>`;
  }

  /* BROK WB-FIDELITY-1 #3: Bellen-card met INLINE lijnkeuze + connect-status
     + bewerkbaar nummer + "Bel nu" (direct KlxSoftphone.call, geen sheet-
     opening tussenstap). Poging-teller /4 (v1-parity) — v1 gebruikt 4-slag
     cyclus (dunning-config max_attempts default 4). Uitkomst-noteren blijft
     apart voor MANUAL_FOLLOWUP-auto-outcome-flow. */
  function _caseBellenCardHtml(cid, phone, name) {
    const calls = asArr(_live.callLog.byCust[cid]);
    // BROK WB-FIX-4 minor: v1-parity min 4 dots. Cadence uit server als
    // hoger, maar altijd minimaal 4 (voorkomt "/4 met 3 bolletjes"-mismatch
    // van v=28 waar server-side default 3 was).
    const cadence = _live.callLog.cadenceByCust?.[cid] || {};
    const maxAttempts = Math.max(4, Number(cadence.max_attempts) || 4);
    const attempts = calls.length;
    const dots = [];
    for (let i = 0; i < maxAttempts; i++) {
      const cls = i < attempts ? 'wbx-done' : (i === attempts ? 'wbx-here' : '');
      dots.push(`<span style="width:8px;height:8px;border-radius:50%;background:${cls === 'wbx-done' ? 'var(--emerald)' : (cls === 'wbx-here' ? 'var(--brand)' : 'var(--border)')};display:inline-block"></span>`);
    }
    const last = calls[0] || null;
    const lastLine = last ? `<div style="font-size:11.5px;color:var(--text-3);margin-top:6px">Laatste poging: <b>${esc(last.outcome || '—')}</b> · ${esc(_fmtDateTime(last.attempted_at || last.created_at))}</div>` : '';
    const formOpen = !!_ui.callFormOpen[cid];

    // KlxSoftphone status snapshot — configured lines + registration.
    const sp = (window.KlxSoftphone && typeof window.KlxSoftphone.getStatus === 'function')
      ? window.KlxSoftphone.getStatus() : { configuredLines: { nl: false, be: false }, state: 'idle' };
    // BROK WB-FIX-4 #1: TOON ALTIJD BE-optie (v1-parity + regressie-fix).
    // v=28 gated BE achter sp.configuredLines.be, maar KlxSoftphone.ensureReady
    // is lazy — bij eerste render is configuredLines nog {nl:false, be:false}
    // → BE optie verdween voor Belgische klanten. KlxSoftphone.call zal alsnog
    // een duidelijke error geven als BE niet geregistreerd is; kans op typo
    // < kans op frustratie bij ontbrekende optie.
    const beAvail = true;
    // Trigger SIP-init on-demand zodat state-badge geleidelijk correct wordt.
    if (window.KlxSoftphone && typeof window.KlxSoftphone.ensureReady === 'function' && sp.state === 'idle') {
      try { window.KlxSoftphone.ensureReady(); } catch (_) {}
    }
    const stateLabel = sp.state === 'connected'  ? '● Verbonden'
                     : sp.state === 'connecting' ? '● Bellen…'
                     : sp.state === 'failed'     ? '⚠ Fout'
                     : '○ Klaar';
    const stateColor = sp.state === 'connected'  ? 'var(--emerald)'
                     : sp.state === 'connecting' ? 'var(--brand)'
                     : sp.state === 'failed'     ? 'var(--rose)'
                     : 'var(--text-3)';

    // Read stored line-override (KlxSoftphone persist in localStorage).
    let lineOverride = 'auto';
    try { lineOverride = localStorage.getItem('klx-softphone-line') || 'auto'; } catch (_) {}

    return `<div class="wbx-drawer-card">
      <div class="wbx-drawer-card-h">Bellen</div>
      <div class="wbx-drawer-card-b">
        ${!phone ? '<div style="color:var(--text-3);font-size:12.5px">Geen telefoonnummer bij deze klant.</div>' : `
          <div style="display:grid;grid-template-columns:110px 1fr;gap:6px 10px;align-items:center;font-size:12px">
            <div style="color:var(--text-3)">Uitbellen via</div>
            <select id="wbxBellenLine_${esc(cid)}" onchange="__wbxBellenLineChange(this.value)" style="padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12px">
              <option value="auto" ${lineOverride === 'auto' ? 'selected' : ''}>Lijn · automatisch</option>
              <option value="nl"   ${lineOverride === 'nl'   ? 'selected' : ''}>NL-lijn (+31)</option>
              ${beAvail ? `<option value="be" ${lineOverride === 'be' ? 'selected' : ''}>BE-lijn (+32)</option>` : ''}
            </select>
            <div style="color:var(--text-3)">Status</div>
            <div><span style="font-size:11.5px;color:${stateColor};font-weight:600">${stateLabel}</span></div>
            <div style="color:var(--text-3)">Nummer</div>
            <input id="wbxBellenNum_${esc(cid)}" type="tel" value="${esc(phone)}" style="padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12px;font-family:'IBM Plex Mono',monospace;box-sizing:border-box" />
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:10px">
            <button class="btn btn-primary btn-sm" style="font-size:12px" onclick="__wbxBellenCallNow('${esc(cid)}','${esc(name)}')" title="Direct bellen via softphone">📞 Bel nu</button>
            <button class="btn btn-ghost btn-sm" style="font-size:12px" onclick="__wbxCaseCallOpen('${esc(cid)}')" ${_rbac.canExecute ? '' : 'disabled title="Geen rechten"'}>Uitkomst noteren</button>
            <div style="display:flex;gap:5px;align-items:center;margin-left:auto" title="Poging ${attempts} van ${maxAttempts}">
              <span style="font-size:10.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.05em;font-weight:600;margin-right:4px">POGING</span>
              ${dots.join('')}
              <span style="font-size:11px;color:var(--text-3);margin-left:6px">${attempts}/${maxAttempts}</span>
            </div>
          </div>
          ${lastLine}
        `}
        ${formOpen ? '<div style="margin-top:12px">' + _caseSheetCallFormHtml(cid) + '</div>' : ''}
      </div>
    </div>`;
  }

  // BROK WB-FIDELITY-1 #3: inline line-select + call-now handlers.
  window.__wbxBellenLineChange = (val) => {
    try { localStorage.setItem('klx-softphone-line', String(val || 'auto')); } catch (_) {}
    // KlxSoftphone leest de override bij volgende place-call automatisch.
  };
  window.__wbxBellenCallNow = async (cid, name) => {
    const inp = document.getElementById('wbxBellenNum_' + cid);
    const phone = inp ? String(inp.value || '').trim() : '';
    if (!phone) { _toast('Geen telefoonnummer ingevuld.', 'warn'); return; }
    // Custom confirm vóór bellen (incasso-context — voorkomt per-ongeluk-klik).
    const ok = await _askConfirm(
      'Bellen naar ' + (name || 'klant') + '?',
      '<div><b>Klant:</b> ' + esc(name || 'onbekend') + '</div>'
      + '<div><b>Nummer:</b> <span style="font-family:\'IBM Plex Mono\',monospace">' + esc(phone) + '</span></div>',
      { okLabel: 'Bellen' }
    );
    if (!ok) return;
    if (window.KlxSoftphone && typeof window.KlxSoftphone.call === 'function') {
      const r = await window.KlxSoftphone.call(phone, { displayName: String(name || ''), customerId: cid });
      if (r && r.ok === false) _toast('Bellen faalde: ' + (r.error || 'onbekend'), 'error');
      // Herrender case-sheet zodat state-label updatet.
      setTimeout(() => _repaintCaseSheet(), 400);
    } else {
      _toast('Softphone niet beschikbaar.', 'warn');
    }
  };

  /* Gesprek-card — laatste 8 chat-bubbles uit inbox-messages-list.
     Joost-suggestie (max_age_minutes=60) inline eronder. */
  function _caseGesprekCardHtml(cid) {
    const cbag = _live.caseFaithful.convByCust[cid];
    const mbag = _live.caseFaithful.chatByCust[cid];
    const jbag = _live.caseFaithful.joostByCust[cid];
    let msgsHtml = '';
    if (!cbag || cbag.loading) msgsHtml = '<div style="color:var(--text-3);font-size:12px">Gesprek laden…</div>';
    else if (cbag.error === 'geen conv' || !cbag.convId) msgsHtml = '<div style="color:var(--text-3);font-size:12px">Nog geen WA-gesprek met deze klant.</div>';
    else if (mbag?.loading) msgsHtml = '<div style="color:var(--text-3);font-size:12px">Berichten laden…</div>';
    else {
      const items = asArr(mbag?.items).slice(-8);
      if (!items.length) msgsHtml = '<div style="color:var(--text-3);font-size:12px">Geen berichten.</div>';
      else msgsHtml = '<div style="display:flex;flex-direction:column;gap:4px">' + items.map((m) => {
        const isOut = m.direction === 'outbound' || m.direction === 'out';
        const cls = isOut ? 'wbx-msg-out' : 'wbx-msg-in';
        const body = String(m.body || m.text || '').slice(0, 400);
        return `<div class="${cls}">${esc(body)}<div style="font-size:9.5px;color:var(--text-3);margin-top:2px">${esc(_fmtDateTime(m.at || m.created_at))}</div></div>`;
      }).join('') + '</div>';
    }
    let joostHtml = '';
    const jItem = asArr(jbag?.items)[0] || null;
    if (jbag?.loading) {
      joostHtml = '<div style="margin-top:10px;padding:10px;border:1px dashed var(--brand);border-radius:6px;font-size:11.5px;color:var(--brand);background:var(--surface-2)">🤖 Joost denkt na…</div>';
    } else if (jItem) {
      const intent = jItem.detected_intent || 'suggestie';
      const conf = jItem.confidence != null ? Math.round(jItem.confidence * 100) + '%' : '';
      const reply = String(jItem.suggested_reply || '').slice(0, 500);
      joostHtml = `<div style="margin-top:10px;padding:10px 12px;background:var(--surface-2);border:1px solid var(--border);border-radius:6px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px">
          <span style="font-size:11px;font-weight:700;color:var(--brand);text-transform:uppercase;letter-spacing:.06em">🤖 Joost · ${esc(intent)}</span>
          ${conf ? `<span style="font-size:10.5px;color:var(--text-3)">${conf}</span>` : ''}
        </div>
        <div style="font-size:12.5px;color:var(--text-2);white-space:pre-wrap">${esc(reply)}</div>
      </div>`;
    } else if (jbag?.error) {
      // BROK WB-FIX-3 #3: fout in-card i.p.v. onzichtbare toast.
      joostHtml = `<div style="margin-top:10px;padding:10px 12px;border:1px solid var(--rose);background:var(--rose-soft);border-radius:6px;font-size:11.5px;color:var(--rose)">🤖 Joost: ${esc(jbag.error)}</div>`;
    } else if (jbag?.no_suggestion) {
      // BROK WB-FIX-3 #3: expliciete "no suggestion" state — user vroeg
      // Joost, maar niets zinvolls om te suggereren nu.
      joostHtml = `<div style="margin-top:10px;padding:10px 12px;border:1px dashed var(--border);border-radius:6px;font-size:11.5px;color:var(--text-3);background:var(--surface-2)">🤖 Joost heeft op dit moment geen suggestie voor dit gesprek.</div>`;
    }
    return `<div class="wbx-drawer-card">
      <div class="wbx-drawer-card-h">Gesprek</div>
      <div class="wbx-drawer-card-b">${msgsHtml}${joostHtml}</div>
    </div>`;
  }

  /* WIK-brief-card. Toont laatste brief + generatie-knoppen NL/BE.
     Verstuur-knoppen (mail via administratie / markeer per post) enkel
     als de laatste nog niet verstuurd is. */
  function _caseWikCardHtml(cid) {
    const bag = _live.caseSheet.briefsByCust[cid] || { loading: false, items: [] };
    const items = asArr(bag.items);
    const latest = items[0] || null;
    let statusLine = '';
    let sendActions = '';
    if (!latest) {
      statusLine = '<div style="color:var(--text-3);font-size:12.5px">Nog geen WIK-brief aangemaakt.</div>';
    } else {
      const when = _fmtDate(latest.generated_at || latest.created_at);
      const country = latest.country || '—';
      let sv = '';
      if (latest.sent_via === 'email') sv = `<b style="color:var(--emerald)">✓ Verstuurd per e-mail</b>${latest.sent_at ? ' · ' + esc(_fmtDate(latest.sent_at)) : ''}`;
      else if (latest.sent_via === 'post') sv = `<b style="color:var(--emerald)">✓ Verstuurd per post</b>${latest.sent_at ? ' · ' + esc(_fmtDate(latest.sent_at)) : ''}`;
      else if (latest.downloaded_at) sv = `<span style="color:var(--amber)">↓ Gedownload · nog niet gemarkeerd verstuurd</span>`;
      else sv = '<span style="color:var(--text-3)">Nog niet verstuurd — alleen aangemaakt</span>';
      statusLine = `<div style="font-size:12.5px;margin-bottom:4px"><b>Laatst gegenereerd:</b> ${esc(when)} · land <b>${esc(country)}</b></div>
        <div style="font-size:12px">${sv}</div>`;
      if (!latest.sent_via) {
        sendActions = `
          <button class="btn btn-ghost btn-sm" style="font-size:11.5px" onclick="__wbxWikSendEmail('${esc(latest.id)}','${esc(cid)}')">✉ Mail via administratie@</button>
          <button class="btn btn-ghost btn-sm" style="font-size:11.5px" onclick="__wbxWikMarkPost('${esc(latest.id)}','${esc(cid)}')">✉ Markeer verstuurd per post</button>`;
      }
    }
    const downloadBtn = latest?.download_url
      ? `<a class="btn btn-ghost btn-sm" style="font-size:11.5px;text-decoration:none" href="${esc(latest.download_url)}" target="_blank" rel="noopener">↓ Bewijs</a>` : '';
    return `<div class="wbx-drawer-card">
      <div class="wbx-drawer-card-h">WIK-brief — bewijs</div>
      <div class="wbx-drawer-card-b">
        ${statusLine}
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
          ${downloadBtn}
          ${sendActions}
          <button class="btn btn-ghost btn-sm" style="font-size:11.5px" onclick="__wbxWikGen('${esc(cid)}','NL')" ${_rbac.canBrief ? '' : 'disabled title="Geen rechten"'}>${latest ? '↻ Nieuwe NL' : '📄 Genereer NL'}</button>
          <button class="btn btn-ghost btn-sm" style="font-size:11.5px" onclick="__wbxWikGen('${esc(cid)}','BE')" ${_rbac.canBrief ? '' : 'disabled title="Geen rechten"'}>${latest ? '↻ Nieuwe BE' : '📄 Genereer BE'}</button>
        </div>
        ${items.length > 1 ? `<details style="margin-top:10px"><summary style="cursor:pointer;color:var(--text-3);font-size:11.5px">Eerdere brieven (${items.length - 1})</summary>
          <div style="margin-top:6px">${items.slice(1).map((b) => `<div style="padding:4px 0;border-top:1px dashed var(--border);font-size:11.5px;color:var(--text-3)">${esc(_fmtDate(b.generated_at || b.created_at))} · ${esc(b.country || '?')} · ${b.sent_via ? esc(b.sent_via) : 'niet verstuurd'}${b.download_url ? ' · <a href="' + esc(b.download_url) + '" target="_blank" rel="noopener">PDF</a>' : ''}</div>`).join('')}</div>
        </details>` : ''}
      </div>
    </div>`;
  }

  /* Tijdlijn & notities. Feed uit wanbetalers-timeline + notitie-input. */
  function _caseTijdlijnCardHtml(cid) {
    const st = _live.timeline;
    const items = asArr(st.byCust[cid]);
    const WT = window.WanbetalersTimeline || null;
    const noteState = _ui.caseNoteByCust = _ui.caseNoteByCust || {};
    const nf = noteState[cid] = noteState[cid] || { text: '', saving: false, error: null, expanded: false };
    const shown = nf.expanded ? items : items.slice(0, 3);
    let listHtml = '';
    if (!items.length && st.loading) listHtml = `<div style="color:var(--text-3);font-size:12px">Tijdlijn laden…</div>`;
    else if (!items.length) listHtml = `<div style="color:var(--text-3);font-size:12px">Geen tijdlijn-events.</div>`;
    else listHtml = shown.map((it) => {
      const d = WT?.describe ? WT.describe(it) : { icon: '·', title: it.title || it.type };
      const actor = it.actor?.name || '';
      const title = d.title || it.title || it.type || 'Event';
      return `<div style="padding:8px 0;border-bottom:1px solid var(--border);display:flex;gap:9px">
        <div style="font-size:14px;line-height:1;color:var(--text-3);min-width:18px;text-align:center">${esc(d.icon || '·')}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:12.5px">${esc(title)}</div>
          ${it.description ? `<div style="font-size:11.5px;color:var(--text-3);margin-top:2px">${esc(it.description)}</div>` : ''}
          <div style="font-size:10.5px;color:var(--text-3);margin-top:2px;font-family:'IBM Plex Mono',monospace">${esc(_fmtDateTime(it.at))}${actor ? ' · ' + esc(actor) : ''}</div>
        </div>
      </div>`;
    }).join('');
    const moreBtn = items.length > 3
      ? `<button class="btn btn-ghost btn-sm" style="font-size:11px;margin-top:8px" onclick="__wbxCaseTlToggle('${esc(cid)}')">${nf.expanded ? 'Inklappen' : 'Toon meer (' + (items.length - 3) + ')'}</button>` : '';
    return `<div class="wbx-drawer-card">
      <div class="wbx-drawer-card-h">Tijdlijn & notities</div>
      <div class="wbx-drawer-card-b">
        <div style="margin-bottom:10px">
          <textarea id="wbxCaseTlNote_${esc(cid)}" rows="2" oninput="__wbxCaseTlNoteInput('${esc(cid)}',this.value)" placeholder="Notitie toevoegen…" style="width:100%;padding:7px 9px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12px;resize:vertical;box-sizing:border-box">${esc(nf.text || '')}</textarea>
          ${nf.error ? `<div style="color:var(--rose);font-size:11px;margin-top:4px">⚠ ${esc(nf.error)}</div>` : ''}
          <div style="display:flex;gap:6px;justify-content:flex-end;margin-top:6px">
            <button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="__wbxCaseTlRefresh('${esc(cid)}')">↻</button>
            <button class="btn btn-primary btn-sm" style="font-size:11px" onclick="__wbxCaseTlSave('${esc(cid)}')" ${nf.saving ? 'disabled' : ''}>${nf.saving ? 'Opslaan…' : 'Notitie plaatsen'}</button>
          </div>
        </div>
        <div>${listHtml}</div>
        ${moreBtn}
      </div>
    </div>`;
  }

  /* ── BROK 4 INCASSO-1: case-sheet action-bar ─────────────────────────
     6 knoppen bovenaan de case-sheet:
       📩 Herinnering  — add-log note ("handmatige herinnering")
       🤝 Toezegging   — add-log note (bedrag/datum/notitie)
       ✅ Close        — finance-dunning-close-customer (409 HAS_OPEN_INVOICES
                        → force-retry via confirm-modal)
       ⚠ Dispuut       — finance-dunning-mark-disputed (reden verplicht)
       ⚖ Incasso       — incasso-dossier-create (needs_brief → confirm-flow)
       ⏸ Pauzeer       — finance-dunning-pause-by-customer
     Elke actie via custom confirm/form-modal + race-guard in _ui.caseActBusy. */
  _ui.caseActBusy = _ui.caseActBusy || {};

  /* SURFACE B action-bar — v1-faithful 8-knop layout, bottom-anchored.
     Volgorde: Betaalafspraak · Herinnering · Vraag Joost · ✓ Sluit dossier ·
     ⚖ Geschil (of Geschil opgelost) · 🛡 Bewind · ⏸ Pauzeer · ⚖ Naar incasso.
     Terminal stages verbergen 5 v.d. 8 destructive/mutation-acties. */
  function _caseSheetActionBarHtml(cid, stageSlug) {
    const isTerminal = stageSlug === 'opgelost' || stageSlug === 'afschrijven';
    const isDispute  = stageSlug === 'dispuut';
    const busy = (k) => !!_ui.caseActBusy[k + ':' + cid];
    const b = (fn, icon, label, tone, title, hidden) => {
      if (hidden) return '';
      const isBusy = busy(fn);
      const color = tone === 'danger' ? 'var(--rose)' : (tone === 'warn' ? 'var(--amber)' : (tone === 'ok' ? 'var(--emerald)' : (tone === 'brand' ? 'var(--brand)' : 'var(--text-2)')));
      return `<button class="btn btn-ghost btn-sm" ${isBusy ? 'disabled' : ''} style="font-size:11.5px;padding:5px 10px;color:${color};${isBusy ? 'opacity:.55;cursor:not-allowed' : 'cursor:pointer'}" onclick="__wbxCaseAction('${esc(fn)}','${esc(cid)}')" title="${esc(title || label)}">${icon} ${esc(label)}</button>`;
    };
    return `<div style="padding:10px 18px;border-top:1px solid var(--border);background:var(--surface);display:flex;gap:6px;flex-wrap:wrap;align-items:center;box-shadow:0 -2px 8px rgba(0,0,0,.04)">
      ${b('viewchat',  '💬', 'Bekijk gesprek', 'brand', 'Naar WA-inbox met dit gesprek geopend',   false)}
      ${b('newtask',   '➕', 'Nieuwe taak',    'text',  'Vrije taak aanmaken (opent actie-menu)',   false)}
      ${b('promise',   '🤝', 'Betaalafspraak', 'ok',    'Betaalbelofte loggen (bedrag + datum)',   isTerminal)}
      ${b('reminder',  '📩', 'Herinnering',    'text',  'Log handmatige herinnering',              isTerminal)}
      ${b('askjoost',  '🤖', 'Vraag Joost',    'brand', 'Vraag Joost om een suggestie',            isTerminal)}
      ${b('close',     '🛑', 'Sluit dossier',  'danger','Klant afhandelen (opgelost) — irreversibel', false)}
      ${isDispute
        ? b('resolvedispute', '⚖', 'Geschil opgelost', 'ok', 'Klant heeft ongelijk / geschil is opgelost', false)
        : b('dispute',        '⚖', 'Geschil',           'warn', 'Geschil markeren — flow parkeren', isTerminal)}
      ${b('bewind',    '🛡', 'Bewind',         'warn',  'Klant onder schuldbewind — flow parkeren', isTerminal)}
      ${b('pause',     '⏸',  'Pauzeer flow',  'warn',  'Aanmaan-flow tijdelijk stoppen',           isTerminal)}
      ${b('incasso',   '⚖',  'Naar incasso',  'danger','Incasso-dossier aanmaken',                  isTerminal)}
    </div>`;
  }

  window.__wbxCaseAction = (fn, cid) => {
    if (!fn || !cid) return;
    if (fn === 'reminder')            _caseActReminder(cid);
    else if (fn === 'promise')         _caseActPromise(cid);
    else if (fn === 'close')           _caseActClose(cid);
    else if (fn === 'dispute')         _caseActDispute(cid);
    else if (fn === 'resolvedispute')  _caseActResolveDispute(cid);
    else if (fn === 'bewind')          _caseActBewind(cid);
    else if (fn === 'incasso')         _caseActIncasso(cid);
    else if (fn === 'pause')           _caseActPause(cid);
    else if (fn === 'askjoost')        _caseActAskJoost(cid);
    // BROK WB-FIDELITY-1 #5:
    else if (fn === 'viewchat')        _caseActViewChat(cid);
    else if (fn === 'newtask')         _caseActNewTask(cid);
  };

  // BROK WB-FIDELITY-1 #5: "Bekijk gesprek" — navigeert naar Gesprekken-tab
  // en selecteert de conv van deze klant (uit case-faithful convByCust cache).
  function _caseActViewChat(cid) {
    const cbag = _live.caseFaithful.convByCust[cid];
    const convId = cbag?.convId;
    if (!convId) { _toast('Geen gekoppeld WA-gesprek.', 'warn'); return; }
    // Sluit drawer, switch tab, select conv.
    window.__wbxCloseCase();
    try { if (window.DFO && typeof window.DFO.goTab === 'function') window.DFO.goTab('Gesprekken'); } catch (_) {}
    // Kleine delay zodat inboxView render kan afronden vóór select.
    setTimeout(() => { try { window.__wbxInboxSelect(String(convId)); } catch (_) {} }, 60);
  }

  // BROK WB-FIDELITY-1 #5: "+ Nieuwe taak" — opent bestaande actie-menu
  // (bel/verify/escalatie/vrije taak/toewijzen) op deze klant.
  function _caseActNewTask(cid) {
    if (typeof window.__wbxOpenActieMenu === 'function') window.__wbxOpenActieMenu(cid);
    else _toast('Actie-menu niet beschikbaar.', 'warn');
  }

  // SURFACE B nieuwe handlers.
  async function _caseActResolveDispute(cid) {
    if (!_rbac.canExecute) { _toast('Geen rechten (finance.dunning.execute).', 'error'); return; }
    const reason = await _askReason('Geschil oplossen', 'Wat was de uitkomst? (bv. "Klant had ongelijk, factuur staat", "Factuur gecrediteerd — klant had gelijk")', { okLabel: 'Los op' });
    if (!reason || reason.length < 5) { if (reason) _toast('Reden min 5 tekens.', 'warn'); return; }
    if (_ui.caseActBusy['resolvedispute:' + cid]) return;
    _ui.caseActBusy['resolvedispute:' + cid] = true;
    const r = await apiPost('/api/finance-dunning-resolve-dispute', { customer_id: cid, resolution: 'resume', reason });
    _ui.caseActBusy['resolvedispute:' + cid] = false;
    if (!r.ok) { _toast('Oplossen mislukt: ' + r.error, 'error'); return; }
    _toast('Geschil opgelost — flow hervat.', 'success');
    _live.overzicht.fetched = false;
    if (_live.timeline?.byCust) delete _live.timeline.byCust[cid];
    delete _live.caseFaithful.pipeByCust[cid];
    _fetchCasePipeline(cid);
    _repaintCaseSheet();
    if (window.DFO?.render) window.DFO.render();
  }

  async function _caseActBewind(cid) {
    if (!_rbac.canExecute) { _toast('Geen rechten (finance.dunning.execute).', 'error'); return; }
    const bodyHtml = `
      <div style="display:flex;flex-direction:column;gap:10px">
        <div style="font-size:12.5px;color:var(--text-2);padding:8px 11px;background:var(--amber-soft, rgba(245,158,11,.08));border:1px solid var(--amber);border-radius:6px;line-height:1.5">
          ⚠ Klant staat onder <b>schuldbewind / curator / faillissement</b>. Alle contact naar de klant zelf wordt gestopt; vervolg loopt via de bewindvoerder.
        </div>
        <div>
          <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Reden (min 5 tekens)</div>
          <textarea id="wbxBewReason" rows="2" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;resize:vertical;box-sizing:border-box"></textarea>
        </div>
        <div>
          <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Bewindvoerder / curator — naam (verplicht)</div>
          <input id="wbxBewName" type="text" maxlength="200" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;box-sizing:border-box" />
        </div>
        <div style="display:flex;gap:10px">
          <div style="flex:1">
            <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">E-mail</div>
            <input id="wbxBewEmail" type="email" maxlength="200" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;box-sizing:border-box" />
          </div>
          <div style="flex:1">
            <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Telefoon</div>
            <input id="wbxBewPhone" type="tel" maxlength="60" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;box-sizing:border-box" />
          </div>
        </div>
      </div>`;
    const form = await _askForm('Bewind markeren?', bodyHtml, (root) => {
      const reason = String(root.querySelector('#wbxBewReason')?.value || '').trim();
      const name   = String(root.querySelector('#wbxBewName')?.value || '').trim();
      const email  = String(root.querySelector('#wbxBewEmail')?.value || '').trim();
      const phone  = String(root.querySelector('#wbxBewPhone')?.value || '').trim();
      if (reason.length < 5) { _toast('Reden min 5 tekens.', 'warn'); return null; }
      if (name.length < 2)   { _toast('Naam bewindvoerder verplicht.', 'warn'); return null; }
      return { reason, curator: { name, email: email || undefined, phone: phone || undefined } };
    }, { okLabel: 'Markeer' });
    if (!form) return;
    if (_ui.caseActBusy['bewind:' + cid]) return;
    _ui.caseActBusy['bewind:' + cid] = true;
    const r = await apiPost('/api/finance-dunning-mark-bewind', {
      customer_id: cid, reason: form.reason, curator_contact: form.curator,
    });
    _ui.caseActBusy['bewind:' + cid] = false;
    if (!r.ok) { _toast('Bewind mislukt: ' + r.error, 'error'); return; }
    _toast('Klant onder bewind — flow geparkeerd.', 'success');
    _live.overzicht.fetched = false;
    if (_live.timeline?.byCust) delete _live.timeline.byCust[cid];
    delete _live.caseFaithful.pipeByCust[cid];
    _fetchCasePipeline(cid);
    _repaintCaseSheet();
    if (window.DFO?.render) window.DFO.render();
  }

  /* Vraag Joost — genereert een nieuwe suggestie. BROK WB-FIX-3 #3: GEEN
     toast meer (viel achter de action-bar). Alle state in de Gesprek-card:
       loading=true            → "Joost denkt na…"
       response OK + items>0   → Joost-blurb rendert (bestaande render)
       response OK + items=0   → "Joost heeft nu geen suggestie" in-card
       response failed         → error in-card
     De suggest-endpoint kan zelf { suggestion } teruggeven of async
     doorschrijven naar joost_suggestions. We proberen suggest -> als
     response.suggestion aanwezig is: direct in items zetten; anders
     refetch joost-suggestions-recent (met kleine 300ms delay om de
     write-race te vermijden). */
  async function _caseActAskJoost(cid) {
    const cbag = _live.caseFaithful.convByCust[cid];
    if (!cbag?.convId) {
      // Card-visible fallback: geen conv → toon informatieve state.
      _live.caseFaithful.joostByCust[cid] = { loading: false, items: [], error: 'Geen WA-gesprek met deze klant.' };
      _repaintCaseSheet();
      return;
    }
    if (_ui.caseActBusy['askjoost:' + cid]) return;
    _ui.caseActBusy['askjoost:' + cid] = true;
    _live.caseFaithful.joostByCust[cid] = { loading: true, items: [], error: null };
    _repaintCaseSheet();
    try {
      const r = await apiPost('/api/joost-suggest', { conversation_id: cbag.convId });
      if (!r.ok) {
        _live.caseFaithful.joostByCust[cid] = {
          loading: false, items: [], error: r.error || 'Joost-verzoek mislukt.',
        };
        return;
      }
      // Sommige joost-suggest responses bevatten de suggestion inline —
      // gebruik die direct als aanwezig.
      let items = [];
      if (r.json?.suggestion && typeof r.json.suggestion === 'object') {
        items = [r.json.suggestion];
      } else if (Array.isArray(r.json?.items)) {
        items = r.json.items;
      }
      // Als suggest niet inline gaf: refetch recent na een korte delay.
      if (!items.length) {
        await new Promise((res) => setTimeout(res, 300));
        const jj = await tryFetch(
          'case:joost:refresh:' + cid,
          `/api/joost-suggestions-recent?conversation_id=${encodeURIComponent(cbag.convId)}&max_age_minutes=60`,
          6000,
        );
        if (jj && !jj.error) items = asArr(jj.items);
      }
      _live.caseFaithful.joostByCust[cid] = {
        loading: false, items, error: null,
        // BROK WB-FIX-3 #3: expliciete "no-suggestion"-vlag voor de card
        // zodat we netjes 'Joost heeft nu geen suggestie' kunnen renderen.
        // Onderscheid van 'never-fetched' (dan geen render).
        no_suggestion: items.length === 0,
      };
    } catch (e) {
      _live.caseFaithful.joostByCust[cid] = { loading: false, items: [], error: e?.message || 'onbekend' };
    } finally {
      _ui.caseActBusy['askjoost:' + cid] = false;
      _repaintCaseSheet();
    }
  }

  // ─── SURFACE B window-handlers (WIK / tijdlijn / call-sheet-open) ───
  window.__wbxCaseCallSheetOpen = (cid, phone, name) => {
    if (!phone) { _toast('Geen telefoonnummer.', 'warn'); return; }
    if (window.KlxSoftphone && typeof window.KlxSoftphone.open === 'function') {
      window.KlxSoftphone.open({ phone: String(phone), name: String(name || ''), customerId: String(cid), source: 'wanbetalers.case-sheet' });
    } else {
      // Fallback: bestaande __wbxCallDial-flow (confirm + tel:).
      window.__wbxCallDial(cid, phone, name);
    }
  };

  window.__wbxWikGen = async (cid, country) => {
    if (!_rbac.canBrief) { _toast('Geen rechten (finance.incasso.manage).', 'error'); return; }
    const c = (country === 'BE') ? 'BE' : 'NL';
    const ok = await _askConfirm(
      `Nieuwe WIK-brief (${c}) aanmaken?`,
      `<div style="font-size:12.5px;line-height:1.55">Genereert een <b>${c === 'NL' ? '14-dagenbrief' : 'eerste kosteloze herinnering'}</b>. De brief wordt bewaard als bewijs; download start direct.</div>`,
      { okLabel: 'Genereer PDF' }
    );
    if (!ok) return;
    if (_ui.caseActBusy['wikgen:' + cid]) return;
    _ui.caseActBusy['wikgen:' + cid] = true;
    try {
      const token = await (window.AuthShared && window.AuthShared.getAccessToken ? window.AuthShared.getAccessToken() : Promise.resolve(null));
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      const resp = await fetch('/api/incasso-pre-brief', { method: 'POST', headers, body: JSON.stringify({ customer_id: cid, country: c }) });
      if (!resp.ok) {
        let j = null; try { j = await resp.json(); } catch (_) {}
        if (resp.status === 422 && j?.code === 'ADDRESS_INCOMPLETE') {
          const missing = Array.isArray(j.missing_fields) && j.missing_fields.length ? j.missing_fields.join(', ') : 'adres-velden';
          await _askConfirm('Adres onvolledig', `Ontbrekend in TL: <b>${esc(missing)}</b>.<br><br>Vul aan in TL of klantdossier en probeer opnieuw.`, { okLabel: 'OK' });
        } else {
          _toast('Brief-generatie mislukt: ' + (j?.error || ('HTTP ' + resp.status)), 'error');
        }
        return;
      }
      const briefId = resp.headers.get('X-Brief-Id') || null;
      const blob = await resp.blob();
      const url  = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `WIK-brief_${c}_${cid.slice(0, 8)}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      _toast(`WIK-brief aangemaakt${briefId ? ' (' + briefId.slice(0, 8) + '…)' : ''}.`, 'success');
      // Cache invalideren + refetch.
      delete _live.caseSheet.briefsByCust[cid];
      _fetchCaseBriefs(cid);
    } catch (e) {
      _toast('Netwerkfout: ' + (e?.message || 'onbekend'), 'error');
    } finally {
      _ui.caseActBusy['wikgen:' + cid] = false;
      _repaintCaseSheet();
    }
  };

  window.__wbxWikSendEmail = async (briefId, cid) => {
    if (!_rbac.canBrief) { _toast('Geen rechten.', 'error'); return; }
    const ok = await _askConfirm(
      'WIK-brief per e-mail versturen?',
      '<div style="font-size:12.5px;line-height:1.55">De brief wordt namens <b>administratie@deforexopleiding.nl</b> naar de klant gemaild. Dit is een <b>echte send</b> — geen preview-guard.</div>',
      { okLabel: 'Ja, verstuur', tone: 'danger' }
    );
    if (!ok) return;
    if (_ui.caseActBusy['wikmail:' + briefId]) return;
    _ui.caseActBusy['wikmail:' + briefId] = true;
    const r = await apiPost('/api/dunning-brief-email-send', { brief_id: briefId });
    _ui.caseActBusy['wikmail:' + briefId] = false;
    if (!r.ok) { _toast('Verzenden mislukt: ' + r.error, 'error'); return; }
    _toast('Brief verstuurd per e-mail.', 'success');
    delete _live.caseSheet.briefsByCust[cid];
    _fetchCaseBriefs(cid);
  };

  window.__wbxWikMarkPost = async (briefId, cid) => {
    if (!_rbac.canBrief) { _toast('Geen rechten.', 'error'); return; }
    const ok = await _askConfirm('Markeer als per post verstuurd?', 'Dit stempelt de brief als "verstuurd via post" (audit + trigger volgende dunning-stap). Geen fysieke verzending.', { okLabel: 'Ja, markeer' });
    if (!ok) return;
    if (_ui.caseActBusy['wikpost:' + briefId]) return;
    _ui.caseActBusy['wikpost:' + briefId] = true;
    const r = await apiPost('/api/dunning-brief-mark-post', { brief_id: briefId });
    _ui.caseActBusy['wikpost:' + briefId] = false;
    if (!r.ok) { _toast('Markeren mislukt: ' + r.error, 'error'); return; }
    _toast('Brief gemarkeerd verstuurd per post.', 'success');
    delete _live.caseSheet.briefsByCust[cid];
    _fetchCaseBriefs(cid);
  };

  window.__wbxCaseTlNoteInput = (cid, val) => {
    _ui.caseNoteByCust = _ui.caseNoteByCust || {};
    _ui.caseNoteByCust[cid] = _ui.caseNoteByCust[cid] || {};
    _ui.caseNoteByCust[cid].text = String(val || '');
    // Surgical clear van error (geen full render zodat textarea focus behoudt).
    if (_ui.caseNoteByCust[cid].error) _ui.caseNoteByCust[cid].error = null;
  };
  window.__wbxCaseTlToggle = (cid) => {
    _ui.caseNoteByCust = _ui.caseNoteByCust || {};
    _ui.caseNoteByCust[cid] = _ui.caseNoteByCust[cid] || {};
    _ui.caseNoteByCust[cid].expanded = !_ui.caseNoteByCust[cid].expanded;
    _repaintCaseSheet();
  };
  window.__wbxCaseTlRefresh = (cid) => {
    if (_live.timeline?.byCust) delete _live.timeline.byCust[cid];
    _fetchTimeline(cid);
    _toast('Tijdlijn vernieuwd.', 'success');
  };
  window.__wbxCaseTlSave = async (cid) => {
    const nf = (_ui.caseNoteByCust && _ui.caseNoteByCust[cid]) || {};
    const text = String(nf.text || '').trim();
    if (!text) { nf.error = 'Leeg — typ eerst een notitie.'; _repaintCaseSheet(); return; }
    if (nf.saving) return;
    nf.saving = true; nf.error = null; _repaintCaseSheet();
    const r = await apiPost('/api/customer-notes', { customer_id: cid, body: text });
    nf.saving = false;
    if (!r.ok) { nf.error = r.error || 'Kon notitie niet plaatsen.'; _repaintCaseSheet(); return; }
    nf.text = '';
    _toast('Notitie geplaatst.', 'success');
    if (_live.timeline?.byCust) delete _live.timeline.byCust[cid];
    _fetchTimeline(cid);
    _repaintCaseSheet();
  };

  async function _caseActReminder(cid) {
    if (!_rbac.canExecute) { _toast('Geen rechten (finance.dunning.execute).', 'error'); return; }
    const reason = await _askReason('Herinnering loggen', 'Kort wat je hebt verstuurd (bv. "WhatsApp-reminder verstuurd" of "Belafspraak gemaakt om vrijdag terug te bellen").', { okLabel: 'Log' });
    if (!reason) return;
    if (_ui.caseActBusy['reminder:' + cid]) return;
    _ui.caseActBusy['reminder:' + cid] = true;
    const r = await apiPost('/api/dunning-pipeline-add-log', { customer_id: cid, body: '📩 Herinnering: ' + reason });
    _ui.caseActBusy['reminder:' + cid] = false;
    if (!r.ok) { _toast('Loggen mislukt: ' + r.error, 'error'); return; }
    _toast('Herinnering gelogd.', 'success');
    if (_live.timeline?.byCust) delete _live.timeline.byCust[cid];
    _repaintCaseSheet();
  }

  async function _caseActPromise(cid) {
    if (!_rbac.canExecute) { _toast('Geen rechten (finance.dunning.execute).', 'error'); return; }
    const bodyHtml = `
      <div style="display:flex;flex-direction:column;gap:10px">
        <div style="display:flex;gap:10px">
          <div style="flex:1">
            <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Bedrag (€)</div>
            <input id="wbxProAmt" type="number" step="0.01" min="0.01" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;box-sizing:border-box" />
          </div>
          <div style="flex:1">
            <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Belofte-datum</div>
            <input id="wbxProDate" type="date" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;box-sizing:border-box" />
          </div>
        </div>
        <div>
          <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Toelichting (optioneel)</div>
          <textarea id="wbxProNote" rows="2" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;resize:vertical;box-sizing:border-box" placeholder="Klant zegt volgende week betaald te hebben na salaris…"></textarea>
        </div>
      </div>`;
    const form = await _askForm('Betaalbelofte loggen?', bodyHtml, (root) => {
      const amt  = Number(root.querySelector('#wbxProAmt')?.value || 0);
      const date = root.querySelector('#wbxProDate')?.value || null;
      const note = String(root.querySelector('#wbxProNote')?.value || '').trim();
      if (!(amt > 0))  { _toast('Bedrag > 0 vereist.', 'warn'); return null; }
      if (!date) { _toast('Datum vereist.', 'warn'); return null; }
      return { amt, date, note };
    }, { okLabel: 'Log' });
    if (!form) return;
    if (_ui.caseActBusy['promise:' + cid]) return;
    _ui.caseActBusy['promise:' + cid] = true;
    const body = `🤝 Toezegging: ${eur(form.amt)} op ${form.date}${form.note ? ' — ' + form.note : ''}`;
    const r = await apiPost('/api/dunning-pipeline-add-log', { customer_id: cid, body });
    _ui.caseActBusy['promise:' + cid] = false;
    if (!r.ok) { _toast('Loggen mislukt: ' + r.error, 'error'); return; }
    _toast('Toezegging gelogd.', 'success');
    if (_live.timeline?.byCust) delete _live.timeline.byCust[cid];
    _repaintCaseSheet();
  }

  async function _caseActClose(cid) {
    if (!_rbac.canExecute) { _toast('Geen rechten (finance.dunning.execute).', 'error'); return; }
    // BROK WB-FIX-2 #6: danger-styling (rood) op sluit-flow — analoog Naar incasso.
    const reason = await _askReason('Dossier sluiten', '⚠ Dossier definitief afsluiten. Waarom sluit je af? (bv. "Volledig betaald op 12/8", "Kwijtschelding akkoord").', { okLabel: 'Sluit definitief', tone: 'danger' });
    if (!reason || reason.length < 5) { if (reason) _toast('Reden min 5 tekens.', 'warn'); return; }
    if (_ui.caseActBusy['close:' + cid]) return;
    _ui.caseActBusy['close:' + cid] = true;
    let r = await apiPost('/api/finance-dunning-close-customer', { customer_id: cid, reason });
    if (!r.ok && r.status === 409 && r.json?.code === 'HAS_OPEN_INVOICES') {
      _ui.caseActBusy['close:' + cid] = false;
      const openEur = Number(r.json.open_amount_eur ?? 0);
      const openCnt = Number(r.json.open_count ?? 0);
      const force = await _askConfirm('Openstaand bedrag — sluiten alsnog forceren?',
        `Deze klant heeft nog <b>${eur(openEur)}</b> open over <b>${openCnt}</b> factuur/facturen. Wil je toch sluiten?`,
        { okLabel: 'Ja, forceer sluiten', tone: 'danger' });
      if (!force) return;
      _ui.caseActBusy['close:' + cid] = true;
      r = await apiPost('/api/finance-dunning-close-customer', { customer_id: cid, reason, force: true });
    }
    _ui.caseActBusy['close:' + cid] = false;
    if (!r.ok) { _toast('Sluiten mislukt: ' + r.error, 'error'); return; }
    _toast('Dossier gesloten.', 'success');
    _live.overzicht.fetched = false;
    if (_live.timeline?.byCust) delete _live.timeline.byCust[cid];
    _repaintCaseSheet();
    if (window.DFO?.render) window.DFO.render();
  }

  async function _caseActDispute(cid) {
    if (!_rbac.canExecute) { _toast('Geen rechten (finance.dunning.execute).', 'error'); return; }
    const reason = await _askReason('Dispuut markeren', 'Waarom betwist de klant de factuur? (min 5 tekens)', { okLabel: 'Markeer' });
    if (!reason || reason.length < 5) { if (reason) _toast('Reden min 5 tekens.', 'warn'); return; }
    if (_ui.caseActBusy['dispute:' + cid]) return;
    _ui.caseActBusy['dispute:' + cid] = true;
    const r = await apiPost('/api/finance-dunning-mark-disputed', { customer_id: cid, reason });
    _ui.caseActBusy['dispute:' + cid] = false;
    if (!r.ok) { _toast('Dispuut mislukt: ' + r.error, 'error'); return; }
    _toast('Klant staat op dispuut — flow geparkeerd.', 'success');
    _live.overzicht.fetched = false;
    if (_live.timeline?.byCust) delete _live.timeline.byCust[cid];
    _repaintCaseSheet();
    if (window.DFO?.render) window.DFO.render();
  }

  async function _caseActIncasso(cid) {
    if (!_rbac.canBrief) { _toast('Geen rechten (finance.incasso.manage).', 'error'); return; }
    const ok = await _askConfirm('Incasso-dossier aanmaken?',
      `Klant wordt overgedragen aan het incasso-bureau. De dunning-flow stopt. Dit is een <b>zware stap</b> — zorg dat WIK-brief en gesprekken uitputtend zijn geweest.`,
      { okLabel: 'Ja, maak dossier', tone: 'danger' });
    if (!ok) return;
    if (_ui.caseActBusy['incasso:' + cid]) return;
    _ui.caseActBusy['incasso:' + cid] = true;
    let r = await apiPost('/api/incasso-dossier-create', { customer_id: cid });
    // 200 met needs_brief=true → particulier zonder WIK-brief → bevestigen
    if (r.ok && r.json?.needs_brief) {
      _ui.caseActBusy['incasso:' + cid] = false;
      const cont = await _askConfirm('Geen WIK-brief gevonden',
        `Er is nog géén 14-dagenbrief verstuurd naar deze particulier. Wettelijk is dat verplicht vóór incasso. Wil je toch doorgaan (bv. omdat brief per andere weg is verstuurd)?`,
        { okLabel: 'Ja, doorgaan zonder brief', tone: 'danger' });
      if (!cont) return;
      _ui.caseActBusy['incasso:' + cid] = true;
      r = await apiPost('/api/incasso-dossier-create', { customer_id: cid, confirm_no_brief: true });
    }
    _ui.caseActBusy['incasso:' + cid] = false;
    if (!r.ok) { _toast('Incasso-dossier mislukt: ' + r.error, 'error'); return; }
    _toast('Incasso-dossier aangemaakt.', 'success');
    _live.overzicht.fetched = false;
    if (_live.timeline?.byCust) delete _live.timeline.byCust[cid];
    _repaintCaseSheet();
    if (window.DFO?.render) window.DFO.render();
  }

  async function _caseActPause(cid) {
    if (!_rbac.canExecute) { _toast('Geen rechten (finance.dunning.execute).', 'error'); return; }
    const reason = await _askReason('Aanmaan-flow pauzeren', 'Waarom pauzeer je? (bv. "Wacht op klant-terugkoppeling", "Interne discussie")', { okLabel: 'Pauzeer' });
    if (!reason) return;
    if (_ui.caseActBusy['pause:' + cid]) return;
    _ui.caseActBusy['pause:' + cid] = true;
    const r = await apiPost('/api/finance-dunning-pause-by-customer', { customer_id: cid, reason });
    _ui.caseActBusy['pause:' + cid] = false;
    if (r.status === 404) { _toast('Geen actieve dunning-run gevonden.', 'warn'); return; }
    if (!r.ok) { _toast('Pauzeren mislukt: ' + r.error, 'error'); return; }
    const prev = r.json?.previous_status;
    _toast(prev === 'paused' ? 'Flow was al gepauzeerd.' : 'Flow gepauzeerd.', 'success');
    if (_live.timeline?.byCust) delete _live.timeline.byCust[cid];
    _repaintCaseSheet();
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

  /* ── BROK WB-POLISH-3: arrangement-detail drawer ────────────────────
     Body-level right-slide drawer met scrim. Data uit /api/arrangements-
     detail?id=<uuid>. Toont: header (typeLabel · klant + status-pill),
     Arrangement-sectie (kv-grid: type/status/dates/reden/details JSON),
     Pending Actions-tabel (id/type/status/dates/acties). Cancel-knop
     in footer met danger-confirm — delegates naar bestaande
     __wbxArrCancel (POST /api/arrangements-cancel). */
  _live.arrDetail = { byId: {}, loading: {}, error: {} };
  _ui.arrDetail = { id: null };

  async function _fetchArrangementDetail(id) {
    if (!id) return;
    if (_live.arrDetail.loading[id]) return;
    _live.arrDetail.loading[id] = true;
    delete _live.arrDetail.error[id];
    const j = await tryFetch('arr-detail:' + id, `/api/arrangements-detail?id=${encodeURIComponent(id)}`, 8000);
    _live.arrDetail.loading[id] = false;
    if (!j || j.error) _live.arrDetail.error[id] = (j && j.error) || 'Kon detail niet laden';
    else _live.arrDetail.byId[id] = j;
    _renderArrDetail();
  }

  window.__wbxOpenArrDetail = (id) => {
    if (!id) return;
    _ui.arrDetail.id = String(id);
    if (!_live.arrDetail.byId[id]) queueMicrotask(() => _fetchArrangementDetail(id));
    _openArrDetailDom();
  };
  window.__wbxCloseArrDetail = () => {
    _ui.arrDetail.id = null;
    const scrim = document.getElementById('wbxArrDetailScrim');
    const drawer = document.getElementById('wbxArrDetailDrawer');
    if (scrim) scrim.remove();
    if (drawer) drawer.remove();
    document.removeEventListener('keydown', _arrDetailKey);
  };
  function _arrDetailKey(e) { if (e.key === 'Escape') window.__wbxCloseArrDetail(); }

  function _openArrDetailDom() {
    let scrim = document.getElementById('wbxArrDetailScrim');
    if (!scrim) {
      scrim = document.createElement('div');
      scrim.id = 'wbxArrDetailScrim';
      scrim.style.cssText = 'position:fixed;inset:0;z-index:9700;background:rgba(17,23,33,.42);animation:wbxScrimFade .15s ease';
      scrim.addEventListener('click', window.__wbxCloseArrDetail);
      document.body.appendChild(scrim);
    }
    let drawer = document.getElementById('wbxArrDetailDrawer');
    if (!drawer) {
      drawer = document.createElement('aside');
      drawer.id = 'wbxArrDetailDrawer';
      drawer.setAttribute('role', 'dialog');
      drawer.setAttribute('aria-modal', 'true');
      drawer.style.cssText = 'position:fixed;top:0;right:0;bottom:0;z-index:9800;width:min(720px,100vw);background:var(--surface);border-left:1px solid var(--border);box-shadow:-6px 0 22px rgba(0,0,0,.14);display:flex;flex-direction:column;overflow:hidden;animation:wbxSlideIn .22s ease';
      document.body.appendChild(drawer);
      document.addEventListener('keydown', _arrDetailKey);
    }
    _renderArrDetail();
  }

  function _renderArrDetail() {
    const drawer = document.getElementById('wbxArrDetailDrawer');
    if (!drawer || !_ui.arrDetail.id) return;
    drawer.innerHTML = _arrDetailHtml();
  }

  function _arrDetailHtml() {
    const id = _ui.arrDetail.id;
    const loading = _live.arrDetail.loading[id];
    const error   = _live.arrDetail.error[id];
    const data    = _live.arrDetail.byId[id] || null;
    if (loading && !data) {
      return `<div style="padding:20px">${_skelRows(5)}</div>`;
    }
    if (error && !data) {
      return `<div style="padding:20px">${_errBlk(error, 'arrangement-detail')}</div>
        <div style="padding:0 20px 20px"><button class="btn btn-ghost btn-sm" onclick="__wbxCloseArrDetail()">Sluiten</button></div>`;
    }
    if (!data) return `<div style="padding:20px;color:var(--text-3)">Geen data.</div>`;

    const arr  = data.arrangement || {};
    const cust = data.customer || {};
    const acts = asArr(data.pending_actions);
    const invs = asArr(data.invoices);

    const typeLabel = String(arr.type || '—');
    const status    = String(arr.status || '—');
    const statusColor = status === 'ACTIEF' ? 'var(--emerald)'
                      : status === 'NAGEKOMEN' ? 'var(--emerald)'
                      : status === 'VERBROKEN' ? 'var(--rose)'
                      : status === 'GEANNULEERD' ? 'var(--text-3)'
                      : 'var(--brand)';
    const statusBg = status === 'ACTIEF' || status === 'NAGEKOMEN' ? 'var(--emerald-soft)'
                    : status === 'VERBROKEN' ? 'var(--rose-soft)'
                    : status === 'GEANNULEERD' ? 'var(--surface-2)' : 'var(--brand-soft)';

    const kvRow = (label, val) => `<div class="wbx-kv-row"><div class="wbx-kv-l">${esc(label)}</div><div>${val || '—'}</div></div>`;
    const arrKvHtml = [
      kvRow('Type',              esc(typeLabel)),
      kvRow('Status',            `<span style="font-size:10.5px;padding:2px 8px;border-radius:5px;background:${statusBg};color:${statusColor};font-weight:600">${esc(status)}</span>`),
      kvRow('Voorgesteld op',    esc(arr.created_at ? _fmtDateTime(arr.created_at) : '—')),
      kvRow('Goedgekeurd op',    esc(arr.approved_at ? _fmtDateTime(arr.approved_at) : '—')),
      kvRow('Effectief vanaf',   esc(arr.effective_from ? _fmtDate(arr.effective_from) : '—')),
      kvRow('Effectief tot',     esc(arr.effective_to ? _fmtDate(arr.effective_to) : '—')),
      kvRow('Reden / notitie',   esc(arr.reason || arr.notes || '—')),
    ].join('');
    const cancelReasonRow = status === 'GEANNULEERD'
      ? kvRow('Annuleringsreden', esc(arr.cancel_reason || '—'))
      : '';

    const actRows = acts.length ? acts.map((a) => {
      const at = _fmtDateTime(a.created_at);
      const closed = a.executed_at || a.rejected_at;
      const closedTxt = closed ? _fmtDateTime(closed) : '';
      const statLabel = String(a.status || '—');
      const statColor = statLabel === 'EXECUTED' || statLabel === 'APPROVED' ? 'var(--emerald)'
                      : statLabel === 'REJECTED' || statLabel === 'FAILED' ? 'var(--rose)'
                      : 'var(--amber)';
      return `<tr style="border-bottom:1px solid var(--border)">
        <td style="padding:6px 8px;font-family:'IBM Plex Mono',monospace;font-size:11px">${esc(a.action_type || '—')}</td>
        <td style="padding:6px 8px"><span style="font-size:10.5px;padding:2px 7px;border-radius:5px;background:var(--surface-2);color:${statColor};font-weight:600">${esc(statLabel)}</span></td>
        <td style="padding:6px 8px;font-size:11px;color:var(--text-3)">${esc(at)}</td>
        <td style="padding:6px 8px;font-size:11px;color:var(--text-3)">${esc(closedTxt)}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="4" style="padding:14px;text-align:center;color:var(--text-3);font-size:12px">Geen pending actions.</td></tr>';

    const invsHtml = invs.length ? invs.slice(0, 12).map((iv) => {
      const nr = iv.invoice_number || iv.id;
      const openEur = (iv.amount_open != null) ? Number(iv.amount_open)
                    : Math.max(0, (Number(iv.amount_total) || 0) - (Number(iv.amount_paid) || 0));
      return `<div style="display:flex;justify-content:space-between;gap:8px;padding:5px 0;border-bottom:1px dashed var(--border);font-size:11.5px">
        <span style="font-family:'IBM Plex Mono',monospace">${esc(nr)}</span>
        <span style="font-family:'IBM Plex Mono',monospace">${eur(openEur)}</span>
      </div>`;
    }).join('') : '';

    const canCancel = ['ACTIEF', 'VOORGESTELD'].includes(status);
    const cancelBtn = canCancel
      ? `<button class="btn btn-ghost btn-sm" style="font-size:11.5px;color:var(--rose)" onclick="__wbxArrDetailCancel('${esc(arr.id)}','${esc(typeLabel)} — ' + '${esc(cust.name || '')}')">✕ Annuleer arrangement</button>`
      : '';

    return `<style>
      @keyframes wbxScrimFade { from { opacity: 0 } to { opacity: 1 } }
      @keyframes wbxSlideIn   { from { transform: translateX(100%) } to { transform: translateX(0) } }
    </style>
    <div style="padding:14px 18px;border-bottom:1px solid var(--border);background:var(--surface);display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
      <div style="min-width:0;flex:1">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:3px">
          <button class="btn btn-ghost btn-sm" style="font-size:11px;padding:3px 8px" onclick="__wbxCloseArrDetail()">← Terug</button>
        </div>
        <div style="font-size:15px;font-weight:700">${esc(typeLabel)} — ${esc(cust.name || 'Onbekend')}</div>
        <div style="font-size:11px;color:var(--text-3);font-family:'IBM Plex Mono',monospace;margin-top:2px">ID ${esc(String(arr.id || '').slice(0, 8))}…</div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-shrink:0">
        <span style="font-size:11px;padding:3px 10px;border-radius:5px;background:${statusBg};color:${statusColor};font-weight:600">${esc(status)}</span>
        <button class="icon-btn" onclick="__wbxCloseArrDetail()" title="Sluiten (Esc)" style="border:none;background:transparent;cursor:pointer;color:var(--text-2)"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
      </div>
    </div>
    <div style="flex:1;overflow-y:auto;padding:14px 18px;background:var(--surface-2)">
      <div class="wbx-drawer-card">
        <div class="wbx-drawer-card-h">Arrangement</div>
        <div class="wbx-drawer-card-b">
          ${arrKvHtml}
          ${cancelReasonRow}
          ${arr.details && Object.keys(arr.details).length ? `
            <details style="margin-top:10px">
              <summary style="cursor:pointer;font-size:11.5px;color:var(--text-3)">Details (JSON)</summary>
              <pre style="margin:6px 0 0;padding:8px 10px;background:var(--surface-2);border:1px solid var(--border);border-radius:6px;font-size:11px;font-family:'IBM Plex Mono',monospace;overflow:auto;max-height:200px">${esc(JSON.stringify(arr.details, null, 2))}</pre>
            </details>` : ''}
        </div>
      </div>

      ${invs.length ? `<div class="wbx-drawer-card">
        <div class="wbx-drawer-card-h">Facturen bij dit arrangement (${invs.length})</div>
        <div class="wbx-drawer-card-b">${invsHtml}</div>
      </div>` : ''}

      <div class="wbx-drawer-card">
        <div class="wbx-drawer-card-h">Pending actions (${acts.length})</div>
        <div class="wbx-drawer-card-b" style="padding:0">
          <table style="width:100%;border-collapse:collapse;font-size:11.5px">
            <thead>
              <tr style="background:var(--surface-2);border-bottom:1px solid var(--border);text-align:left">
                <th style="padding:6px 8px;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3)">Type</th>
                <th style="padding:6px 8px;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3)">Status</th>
                <th style="padding:6px 8px;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3)">Voorgesteld</th>
                <th style="padding:6px 8px;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3)">Afgerond</th>
              </tr>
            </thead>
            <tbody>${actRows}</tbody>
          </table>
        </div>
      </div>
    </div>
    <div style="padding:10px 18px;border-top:1px solid var(--border);background:var(--surface);display:flex;gap:8px;justify-content:flex-end">
      ${cancelBtn}
      <button class="btn btn-ghost btn-sm" style="font-size:11.5px" onclick="__wbxCloseArrDetail()">Sluiten</button>
    </div>`;
  }

  window.__wbxArrDetailCancel = async (arrId, label) => {
    // Delegate naar bestaande cancel-handler; die doet danger-confirm +
    // POST /api/arrangements-cancel + cache-invalidatie.
    if (typeof window.__wbxArrCancel === 'function') {
      await window.__wbxArrCancel(arrId, label || 'Arrangement');
      // Herfetch dit arrangement zodat status='GEANNULEERD' zichtbaar wordt.
      delete _live.arrDetail.byId[arrId];
      _fetchArrangementDetail(arrId);
    }
  };

  /* BROK WB-POLISH-2: pipeline bulk-select state + handlers.
     __wbxPipeToggleSel(cid, stageSlug, shift) — toggle een kaart; met shift
       + laatste selectie in dezelfde stage → selecteer alle daartussen (range).
     __wbxPipeClearSel — wis alle selectie.
     __wbxPipeBulkMove — schrijft #wbxPipeBulkTarget waarde, typ-to-confirm
       vóór N × POST /api/dunning-pipeline-set-stage. Terminale target-fase
       (opgelost/afschrijven) triggert extra danger-hint in de modal. */
  _ui.pipeSelected = _ui.pipeSelected || {};
  _ui.pipeLastSelId = null;
  _ui.pipeLastSelStage = null;
  window.__wbxPipeToggleSel = (cid, stageSlug, shift) => {
    if (!cid) return;
    if (shift && _ui.pipeLastSelId && _ui.pipeLastSelStage === stageSlug) {
      // Range-select: alle kaarten in dezelfde stage tussen last en cid.
      const items = asArr(_live.overzicht.items).filter((r) => (r.stage_slug || 'nieuw') === stageSlug);
      const idsInStage = items.map((r) => String(r.customer_id || r.id));
      const idxA = idsInStage.indexOf(String(_ui.pipeLastSelId));
      const idxB = idsInStage.indexOf(String(cid));
      if (idxA !== -1 && idxB !== -1) {
        const [lo, hi] = idxA < idxB ? [idxA, idxB] : [idxB, idxA];
        for (let i = lo; i <= hi; i++) _ui.pipeSelected[idsInStage[i]] = true;
      } else {
        _ui.pipeSelected[cid] = !_ui.pipeSelected[cid];
        if (!_ui.pipeSelected[cid]) delete _ui.pipeSelected[cid];
      }
    } else {
      _ui.pipeSelected[cid] = !_ui.pipeSelected[cid];
      if (!_ui.pipeSelected[cid]) delete _ui.pipeSelected[cid];
    }
    _ui.pipeLastSelId = cid;
    _ui.pipeLastSelStage = stageSlug;
    if (window.DFO?.render) window.DFO.render();
  };
  window.__wbxPipeClearSel = () => {
    _ui.pipeSelected = {};
    _ui.pipeLastSelId = null;
    if (window.DFO?.render) window.DFO.render();
  };
  window.__wbxPipeBulkMove = async () => {
    if (!_rbac.canExecute) { _toast('Geen rechten (finance.dunning.execute).', 'error'); return; }
    const sel = document.getElementById('wbxPipeBulkTarget');
    const target = sel ? String(sel.value || '').trim() : '';
    if (!target) { _toast('Kies eerst een doelfase.', 'warn'); return; }
    const ids = Object.keys(_ui.pipeSelected).filter((k) => _ui.pipeSelected[k]);
    if (!ids.length) return;
    const stageMeta = asArr(_live.stages.items).find((s) => s.slug === target) || { label: target };
    const isTerminal = !!stageMeta.is_terminal;
    // Filter out kaarten die AL in target-fase staan (no-op).
    const items = asArr(_live.overzicht.items);
    const toMove = ids.filter((cid) => {
      const r = items.find((x) => String(x.customer_id || x.id) === String(cid));
      return r && (r.stage_slug || 'nieuw') !== target;
    });
    if (!toMove.length) { _toast('Alle geselecteerden staan al in deze fase.', 'warn'); return; }

    const dangerBlock = isTerminal
      ? `<div style="margin-top:10px;padding:10px 12px;background:var(--rose-soft);border:1px solid var(--rose);border-radius:6px;color:var(--rose);font-size:12px;font-weight:600">⚠ Terminale fase — de aanmaan-motor STOPT voor deze ${toMove.length} klant${toMove.length === 1 ? '' : 'en'}. Alleen doorzetten als deze dossiers écht klaar zijn.</div>`
      : '';
    const bodyHtml = `<div style="font-size:12.5px;line-height:1.55">
      Bulk-verplaats <b>${toMove.length}</b> klant${toMove.length === 1 ? '' : 'en'} naar fase
      <span style="font-family:'IBM Plex Mono',monospace;padding:2px 7px;border-radius:5px;background:var(--surface-2);border:1px solid var(--border)">${esc(stageMeta.label || target)}</span>.
      Elke verplaatsing is een aparte audit-log-entry.
    </div>${dangerBlock}`;

    const ok = await _askTypedConfirm(
      `Bulk-verplaats ${toMove.length} klant${toMove.length === 1 ? '' : 'en'} naar ${stageMeta.label || target}?`,
      bodyHtml,
      isTerminal ? 'TERMINAAL' : 'VERPLAATS',
      { okLabel: 'Ja, verplaats ' + toMove.length }
    );
    if (!ok) return;
    if (_ui.pipeBulkBusy) return;
    _ui.pipeBulkBusy = true;
    if (window.DFO?.render) window.DFO.render();
    let done = 0, failed = 0;
    for (const cid of toMove) {
      // Per-cid race-guard is stageBusy — set + clear.
      _ui.stageBusy[cid] = true;
      const r = await apiPost('/api/dunning-pipeline-set-stage', { customer_id: cid, stage_slug: target, reason: 'bulk-verplaats via pipeline' });
      _ui.stageBusy[cid] = false;
      if (r.ok) done++; else failed++;
    }
    _ui.pipeBulkBusy = false;
    _ui.pipeSelected = {};
    _ui.pipeLastSelId = null;
    // Invalidate overzicht cache zodat kolom-tellingen updaten.
    _live.overzicht.fetched = false;
    _fetchOverzicht();
    _toast(`Verplaatst: ${done}${failed ? ' · ' + failed + ' fout' : ''}.`, failed ? 'warn' : 'success');
  };

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
        // BROK WB-POLISH-2: checkbox voor multi-select (shift-select ondersteund
        // via __wbxPipeToggleSel-shiftKey). event.stopPropagation zodat card-klik
        // (case-sheet) niet trigged bij checkbox-klik.
        const isSel = !!_ui.pipeSelected[cid];
        return `<div data-pipe-card="${esc(cid)}" data-pipe-stage="${esc(s.slug)}" style="background:${isSel ? 'var(--brand-soft,#E2F1F5)' : 'var(--surface)'};border:1px solid ${isSel ? 'var(--brand,#0A7490)' : 'var(--border)'};border-radius:var(--r-sm);padding:9px 11px;margin-bottom:8px;cursor:pointer;transition:transform .08s ease" onclick="__wbxOpenCase('${esc(cid)}')" onmouseover="this.style.transform='translateY(-1px)'" onmouseout="this.style.transform='translateY(0)'">
          <div style="display:flex;gap:6px;align-items:start">
            <label style="display:flex;align-items:center;cursor:pointer;padding-top:1px" onclick="event.stopPropagation()">
              <input type="checkbox" ${isSel ? 'checked' : ''} onclick="event.stopPropagation();__wbxPipeToggleSel('${esc(cid)}','${esc(s.slug)}',event.shiftKey)" style="width:14px;height:14px;cursor:pointer" />
            </label>
            <div style="min-width:0;flex:1">
              <div style="font-weight:600;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}${pauseBadge}</div>
              <div style="font-size:11px;color:var(--text-3);margin-top:3px;font-family:'IBM Plex Mono',monospace">${eur(openAmt)} · ${days}d · ${invCount} fact</div>
              <div style="margin-top:6px" onclick="event.stopPropagation()">
                <select onchange="if(this.value){__wbxSetStage('${esc(cid)}',this.value);this.value='';}" style="width:100%;font-size:10.5px;padding:3px 6px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface-2);color:var(--text-1);cursor:pointer" ${busy ? 'disabled' : ''}>
                  <option value="">Verplaats naar…</option>
                  ${stageOpts}
                </select>
              </div>
            </div>
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

    // BROK WB-POLISH-2: bulk-bar met count + fase-picker + Verplaats-knop.
    // Verschijnt zodra ≥1 kaart geselecteerd is. Terminale target-fase
    // triggert extra danger-waarschuwing in de typ-to-confirm modal.
    const selIds = Object.keys(_ui.pipeSelected).filter((k) => _ui.pipeSelected[k]);
    const bulkStageOpts = stages.map((s) =>
      `<option value="${esc(s.slug)}">${esc(s.label || s.slug)}${s.is_terminal ? ' ⛔' : ''}</option>`
    ).join('');
    const bulkBar = selIds.length ? `<div style="padding:10px 14px;background:var(--brand-soft,#E2F1F5);border:1px solid var(--brand,#0A7490);border-radius:var(--r);margin-bottom:10px;display:flex;align-items:center;gap:10px;font-size:12.5px;flex-wrap:wrap">
      <b>${selIds.length} klant${selIds.length === 1 ? '' : 'en'} geselecteerd</b>
      <span style="color:var(--text-3);font-size:11px">Bulk-verplaats naar fase:</span>
      <select id="wbxPipeBulkTarget" style="font-size:12px;padding:4px 8px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1)">
        <option value="">— kies fase —</option>
        ${bulkStageOpts}
      </select>
      <button class="btn btn-primary btn-sm" style="font-size:11.5px" ${_ui.pipeBulkBusy ? 'disabled' : ''} onclick="__wbxPipeBulkMove()">${_ui.pipeBulkBusy ? 'Verplaatsen…' : '→ Verplaats'}</button>
      <button class="btn btn-ghost btn-sm" style="font-size:11px;margin-left:auto" onclick="__wbxPipeClearSel()">Wissen</button>
    </div>` : '';

    return `<div data-wbx-view="pipeline">
      <div class="pad" style="padding:14px 20px">
        ${bulkBar}
        <div style="display:flex;gap:10px;overflow-x:auto;padding-bottom:14px;align-items:stretch">
          ${columns}
        </div>
        <div style="font-size:11px;color:var(--text-3);padding:6px 2px">Klik kaart-body voor case-sheet · Vink 2+ voor bulk-verplaats · shift-klik voor range · ⛔ = terminale fase (motor stopt).</div>
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

  /* ── BROK 2 ACT-1: "Nieuwe actie"-menu per klant ─────────────────────
     Menu met 5 opties: bel / verify / escalatie / vrije taak / toewijzen.
     Alle sub-flows via bestaande endpoints:
       - Bel        → __wbxCall (softphone; race-guard in __wbxSoftphoneCall)
       - Verify     → POST /api/tasks-create-verify-payment
       - Escalatie  → POST /api/tasks-create-escalation
       - Vrije taak → POST /api/tasks-create-followup
       - Toewijzen  → POST /api/taken (met assigned_to_id) — nieuw taken_items
     Elke write voorafgegaan door custom confirm-modal + race-guard.       */
  _live.profielen = { loading: false, fetched: false, error: null, items: [] };
  async function _fetchProfielen() {
    if (_live.profielen.loading || _live.profielen.fetched) return;
    _live.profielen.loading = true;
    const j = await tryFetch('profielen', '/api/finance-active-profiles-list', 8000);
    _live.profielen.loading = false;
    _live.profielen.fetched = true;
    if (j && !j.error) _live.profielen.items = asArr(j.items);
    else _live.profielen.error = (j && j.error) || 'onbekende fout';
  }

  function _closeActieMenu() {
    const m = document.getElementById('wbxActieMenuRoot');
    if (m) m.remove();
  }

  function _openWbxActieMenu(cid, opts) {
    opts = opts || {};
    _closeActieMenu();
    const invoices = asArr(opts.openInvoices);
    const root = document.createElement('div');
    root.id = 'wbxActieMenuRoot';
    root.style.cssText = 'position:fixed;inset:0;z-index:9500;background:rgba(17,23,33,.32);display:flex;align-items:center;justify-content:center;padding:20px';
    const optBtn = (icon, label, sub, fn) =>
      `<button data-fn="${esc(fn)}" style="display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--border);background:var(--surface);border-radius:10px;cursor:pointer;text-align:left;width:100%;color:var(--text-1);font:inherit;transition:background .1s" onmouseover="this.style.background='var(--surface-2)'" onmouseout="this.style.background='var(--surface)'">
        <span style="font-size:20px;line-height:1;flex-shrink:0">${icon}</span>
        <span style="min-width:0;flex:1">
          <span style="display:block;font-size:13.5px;font-weight:600">${esc(label)}</span>
          <span style="display:block;font-size:11.5px;color:var(--text-3);margin-top:2px">${esc(sub)}</span>
        </span>
      </button>`;
    root.innerHTML = `<div style="background:var(--surface);border:1px solid var(--border);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.32);padding:16px;max-width:420px;width:calc(100vw - 40px)">
      <div style="font-size:14px;font-weight:600;margin-bottom:4px">Nieuwe actie</div>
      <div style="font-size:11.5px;color:var(--text-3);margin-bottom:12px">Kies wat je wilt doen voor deze klant.</div>
      <div style="display:flex;flex-direction:column;gap:6px">
        ${optBtn('📞', 'Bel klant',           'Softphone starten',                     'bel')}
        ${optBtn('✅', 'Verify betaling',     'Klant zegt al betaald te hebben',        'verify')}
        ${optBtn('⚠',  'Escaleren',            'Boos / juridisch / naar incasso-hand',   'esc')}
        ${optBtn('📝', 'Vrije taak',          'Losse follow-up-taak',                   'vrij')}
        ${optBtn('👥', 'Toewijzen aan collega','Nieuwe taken-item met assignee',        'assign')}
        ${optBtn('✉',  'Nieuwe WIK-brief',    '14-dagenbrief (NL) / eerste herinnering (BE)', 'brief')}
      </div>
      <div style="display:flex;justify-content:flex-end;margin-top:12px">
        <button id="wbxActieMenuCancel" class="btn btn-ghost btn-sm">Sluiten</button>
      </div>
    </div>`;
    root.addEventListener('click', (e) => { if (e.target === root) _closeActieMenu(); });
    document.body.appendChild(root);
    document.getElementById('wbxActieMenuCancel').addEventListener('click', _closeActieMenu);
    root.querySelectorAll('button[data-fn]').forEach((b) => {
      b.addEventListener('click', () => {
        const fn = b.getAttribute('data-fn');
        _closeActieMenu();
        if (fn === 'bel')    _actieBel(cid, opts);
        if (fn === 'verify') _actieVerify(cid, invoices);
        if (fn === 'esc')    _actieEscalatie(cid);
        if (fn === 'vrij')   _actieVrijeTaak(cid);
        if (fn === 'assign') _actieToewijzen(cid);
        if (fn === 'brief')  _actieWikBrief(cid);
      });
    });
  }
  window.__wbxOpenActieMenu = (cid) => {
    const conv = _ui.inbox.selectedConv;
    const ctx = conv ? _live.inbox.ctx.byConv[conv] : null;
    _openWbxActieMenu(String(cid), {
      phone:         ctx?.customer?.phone || ctx?.conversation?.phone_number || null,
      openInvoices:  ctx?.open_invoices || [],
    });
  };

  function _actieBel(cid, opts) {
    const phone = opts?.phone || null;
    if (!phone) { _toast('Geen telefoonnummer bij deze klant.', 'warn'); return; }
    if (typeof window.__wbxCall === 'function') window.__wbxCall(cid, phone);
  }

  // ── Verify-flow ────────────────────────────────────────────────────
  _ui.actieBusy = _ui.actieBusy || {};
  async function _actieVerify(cid, invoices) {
    const invs = asArr(invoices);
    if (!invs.length) { _toast('Geen open facturen — verify-taak vereist een factuur.', 'warn'); return; }
    const invOpts = invs.map((iv) => `<option value="${esc(iv.id)}" data-amt="${Number(iv.amount_open || 0)}">${esc(iv.invoice_number || iv.id)} · ${eur(iv.amount_open)}${iv.days_overdue > 0 ? ' · +' + iv.days_overdue + 'd' : ''}</option>`).join('');
    const bodyHtml = `
      <div style="display:flex;flex-direction:column;gap:10px">
        <div>
          <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Factuur</div>
          <select id="wbxVerifyInv" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px">${invOpts}</select>
        </div>
        <div>
          <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Gevraagd bedrag (€)</div>
          <input id="wbxVerifyAmt" type="number" step="0.01" min="0.01" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;box-sizing:border-box" />
        </div>
        <div>
          <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Klant-quote / toelichting (min 10 tekens)</div>
          <textarea id="wbxVerifyText" rows="3" placeholder="'Ik heb gisteren betaald via …'" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;resize:vertical;box-sizing:border-box"></textarea>
        </div>
      </div>`;
    const form = await _askForm('Verify-payment taak aanmaken?', bodyHtml, (root) => {
      const invId = root.querySelector('#wbxVerifyInv')?.value || null;
      const amt   = Number(root.querySelector('#wbxVerifyAmt')?.value || 0);
      const text  = String(root.querySelector('#wbxVerifyText')?.value || '').trim();
      if (!invId)              { _toast('Kies een factuur.', 'warn'); return null; }
      if (!(amt > 0))          { _toast('Bedrag > 0 vereist.', 'warn'); return null; }
      if (text.length < 10)    { _toast('Toelichting min 10 tekens.', 'warn'); return null; }
      return { invId, amt, text };
    }, { okLabel: 'Aanmaken' });
    if (!form) return;
    const { invId, amt, text } = form;
    if (_ui.actieBusy['verify:' + cid]) return;
    _ui.actieBusy['verify:' + cid] = true;
    const r = await apiPost('/api/tasks-create-verify-payment', {
      invoice_id: invId, customer_id: cid, claimed_amount: amt, claim_text: text, source: 'wanbetalers-v2',
    });
    _ui.actieBusy['verify:' + cid] = false;
    if (!r.ok) { _toast('Verify-taak mislukt: ' + r.error, 'error'); return; }
    _toast('Verify-taak aangemaakt.', 'success');
    _live.pendingActs.fetched = false;
    if (window.DFO?.render) window.DFO.render();
  }

  // ── Escalatie-flow ────────────────────────────────────────────────
  async function _actieEscalatie(cid) {
    const bodyHtml = `
      <div style="display:flex;flex-direction:column;gap:10px">
        <div>
          <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Ernst</div>
          <select id="wbxEscSev" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px">
            <option value="low">Laag</option>
            <option value="medium" selected>Middel</option>
            <option value="high">Hoog</option>
          </select>
        </div>
        <div>
          <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Reden (min 10 tekens)</div>
          <textarea id="wbxEscReason" rows="2" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;resize:vertical;box-sizing:border-box" placeholder="Boos, dreigt met klacht, wil incasso-stop…"></textarea>
        </div>
        <div>
          <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Context (optioneel)</div>
          <textarea id="wbxEscCtx" rows="2" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;resize:vertical;box-sizing:border-box"></textarea>
        </div>
      </div>`;
    const form = await _askForm('Escalatie-taak aanmaken?', bodyHtml, (root) => {
      const sev    = root.querySelector('#wbxEscSev')?.value || 'medium';
      const reason = String(root.querySelector('#wbxEscReason')?.value || '').trim();
      const ctx    = String(root.querySelector('#wbxEscCtx')?.value || '').trim();
      if (reason.length < 10) { _toast('Reden min 10 tekens.', 'warn'); return null; }
      return { sev, reason, ctx };
    }, { okLabel: 'Aanmaken' });
    if (!form) return;
    const { sev, reason, ctx } = form;
    if (_ui.actieBusy['esc:' + cid]) return;
    _ui.actieBusy['esc:' + cid] = true;
    const r = await apiPost('/api/tasks-create-escalation', {
      customer_id: cid, severity: sev, reason, context_summary: ctx || null, source: 'wanbetalers-v2',
    });
    _ui.actieBusy['esc:' + cid] = false;
    if (!r.ok) { _toast('Escalatie mislukt: ' + r.error, 'error'); return; }
    _toast('Escalatie aangemaakt.', 'success');
    _live.pendingActs.fetched = false;
    if (window.DFO?.render) window.DFO.render();
  }

  // ── Vrije-taak-flow (MANUAL_FOLLOWUP) ─────────────────────────────
  async function _actieVrijeTaak(cid) {
    const bodyHtml = `
      <div style="display:flex;flex-direction:column;gap:10px">
        <div>
          <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Titel (kort)</div>
          <input id="wbxVrijTitle" type="text" maxlength="200" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;box-sizing:border-box" placeholder="Bv. Bel-terug maandag" />
        </div>
        <div>
          <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Toelichting (optioneel)</div>
          <textarea id="wbxVrijNote" rows="3" maxlength="2000" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;resize:vertical;box-sizing:border-box"></textarea>
        </div>
        <div>
          <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Type / label (optioneel)</div>
          <input id="wbxVrijKind" type="text" maxlength="40" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;box-sizing:border-box" placeholder="bv. bel-taak / mail-taak" />
        </div>
      </div>`;
    const form = await _askForm('Vrije taak aanmaken?', bodyHtml, (root) => {
      const title = String(root.querySelector('#wbxVrijTitle')?.value || '').trim();
      const note  = String(root.querySelector('#wbxVrijNote')?.value || '').trim();
      const kind  = String(root.querySelector('#wbxVrijKind')?.value || '').trim();
      if (!title) { _toast('Titel is vereist.', 'warn'); return null; }
      return { title, note, kind };
    }, { okLabel: 'Aanmaken' });
    if (!form) return;
    const { title, note, kind } = form;
    if (_ui.actieBusy['vrij:' + cid]) return;
    _ui.actieBusy['vrij:' + cid] = true;
    const r = await apiPost('/api/tasks-create-followup', {
      customer_id: cid, source: 'wanbetalers-v2', title, note, kind, reason: title,
    });
    _ui.actieBusy['vrij:' + cid] = false;
    if (!r.ok) { _toast('Taak-aanmaak mislukt: ' + r.error, 'error'); return; }
    _toast('Vrije taak aangemaakt.', 'success');
    _live.pendingActs.fetched = false;
    if (window.DFO?.render) window.DFO.render();
  }

  // ── Toewijzen-aan-collega-flow (taken_items via /api/taken) ───────
  async function _actieToewijzen(cid) {
    await _fetchProfielen();
    const profs = asArr(_live.profielen.items);
    if (!profs.length) { _toast('Geen actieve collega\'s beschikbaar.', 'warn'); return; }
    const profOpts = profs.map((p) => `<option value="${esc(p.id)}">${esc(p.full_name)}${p.role ? ' · ' + esc(p.role) : ''}</option>`).join('');
    const bodyHtml = `
      <div style="display:flex;flex-direction:column;gap:10px">
        <div>
          <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Toewijzen aan</div>
          <select id="wbxAssignWie" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px">${profOpts}</select>
        </div>
        <div>
          <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Titel</div>
          <input id="wbxAssignTitle" type="text" maxlength="200" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;box-sizing:border-box" placeholder="Bv. Bel klant terug over factuur X" />
        </div>
        <div>
          <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Toelichting (optioneel)</div>
          <textarea id="wbxAssignNote" rows="2" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;resize:vertical;box-sizing:border-box"></textarea>
        </div>
        <div style="display:flex;gap:10px">
          <div style="flex:1">
            <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Prioriteit</div>
            <select id="wbxAssignPrio" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px">
              <option value="Laag">Laag</option>
              <option value="Normaal" selected>Normaal</option>
              <option value="Hoog">Hoog</option>
            </select>
          </div>
          <div style="flex:1">
            <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Deadline (optioneel)</div>
            <input id="wbxAssignDl" type="date" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;box-sizing:border-box" />
          </div>
        </div>
      </div>`;
    const form = await _askForm('Taak toewijzen aan collega?', bodyHtml, (root) => {
      const wie   = root.querySelector('#wbxAssignWie')?.value || null;
      const title = String(root.querySelector('#wbxAssignTitle')?.value || '').trim();
      const note  = String(root.querySelector('#wbxAssignNote')?.value || '').trim();
      const prio  = root.querySelector('#wbxAssignPrio')?.value || 'Normaal';
      const dl    = root.querySelector('#wbxAssignDl')?.value || null;
      if (!wie)   { _toast('Kies een collega.', 'warn'); return null; }
      if (!title) { _toast('Titel is vereist.', 'warn'); return null; }
      return { wie, title, note, prio, dl };
    }, { okLabel: 'Toewijzen' });
    if (!form) return;
    const { wie, title, note, prio, dl } = form;
    if (_ui.actieBusy['assign:' + cid]) return;
    _ui.actieBusy['assign:' + cid] = true;
    const r = await apiPost('/api/taken', {
      task: {
        titel:         title,
        omschrijving:  note,
        prioriteit:    prio,
        categorie:     'Wanbetalers',
        assignedToId:  wie,
        customerId:    cid,
        deadline:      dl,
        status:        'todo',
      },
    });
    _ui.actieBusy['assign:' + cid] = false;
    if (!r.ok) { _toast('Toewijzen mislukt: ' + r.error, 'error'); return; }
    _toast('Taak toegewezen.', 'success');
    if (window.DFO?.render) window.DFO.render();
  }

  /* ── BROK 3 BRIEF-1: Nieuwe WIK-brief aanmaken vanuit klantgegevens ──
     POST /api/incasso-pre-brief levert een PDF-stream (attachment) + headers
     X-Brief-Id / X-Brief-Path. Bij 422 ADDRESS_INCOMPLETE toont welke
     TL-velden nog ontbreken zodat medewerker weet wat aan te vullen.
     RBAC: finance.incasso.manage (server-side hard, client-side toast). */
  async function _actieWikBrief(cid) {
    if (!_rbac.canBrief) { _toast('Geen rechten (finance.incasso.manage).', 'error'); return; }
    const bodyHtml = `
      <div style="display:flex;flex-direction:column;gap:10px">
        <div style="font-size:12.5px;color:var(--text-2);padding:8px 11px;background:var(--amber-soft, rgba(245,158,11,.08));border:1px solid var(--amber);border-radius:6px;line-height:1.5">
          ⚠ Genereert een <b>wettelijke 14-dagenbrief (NL)</b> of <b>eerste kosteloze herinnering (BE)</b>.
          De brief wordt bewaard als bewijs; download start direct.
        </div>
        <div>
          <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Land</div>
          <select id="wbxBriefLand" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px">
            <option value="NL" selected>Nederland — WIK-14-dagenbrief</option>
            <option value="BE">België — eerste kosteloze herinnering</option>
          </select>
        </div>
      </div>`;
    const form = await _askForm('WIK-brief aanmaken?', bodyHtml, (root) => {
      const country = root.querySelector('#wbxBriefLand')?.value || 'NL';
      if (country !== 'NL' && country !== 'BE') { _toast('Ongeldig land.', 'warn'); return null; }
      return { country };
    }, { okLabel: 'Genereer PDF' });
    if (!form) return;
    if (_ui.actieBusy['brief:' + cid]) return;
    _ui.actieBusy['brief:' + cid] = true;
    try {
      const token = await (window.AuthShared && window.AuthShared.getAccessToken ? window.AuthShared.getAccessToken() : Promise.resolve(null));
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      const resp = await fetch('/api/incasso-pre-brief', {
        method: 'POST', headers, body: JSON.stringify({ customer_id: cid, country: form.country }),
      });
      if (!resp.ok) {
        // JSON-error verwacht bij 4xx/5xx (endpoint zet Content-Type: application/json bij fouten).
        let j = null; try { j = await resp.json(); } catch (_) {}
        if (resp.status === 422 && j?.code === 'ADDRESS_INCOMPLETE') {
          const missing = Array.isArray(j.missing_fields) && j.missing_fields.length
            ? j.missing_fields.join(', ')
            : 'adres-velden';
          await _askConfirm('Adres onvolledig', `Deze velden ontbreken in TeamLeader: <b>${esc(missing)}</b>.<br><br>Vul aan in TL (sync haalt 'm binnen een uur op) of via het klantdossier, en probeer opnieuw.`, { okLabel: 'OK' });
        } else {
          _toast('Brief-generatie mislukt: ' + (j?.error || ('HTTP ' + resp.status)), 'error');
        }
        return;
      }
      // Success: stream is een PDF-attachment.
      const briefId   = resp.headers.get('X-Brief-Id')   || null;
      const blob = await resp.blob();
      const url  = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `WIK-brief_${form.country}_${cid.slice(0, 8)}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      _toast(`WIK-brief aangemaakt${briefId ? ' (' + briefId.slice(0, 8) + '…)' : ''}.`, 'success');
      // Herlaad brieven-lijst + case-briefs zodat nieuwe brief zichtbaar is.
      if (_live.brieven) _live.brieven.fetched = false;
      if (_live.caseSheet?.briefsByCust?.[cid]) delete _live.caseSheet.briefsByCust[cid];
      if (window.DFO?.render) window.DFO.render();
    } catch (e) {
      _toast('Netwerkfout: ' + (e?.message || 'onbekend'), 'error');
    } finally {
      _ui.actieBusy['brief:' + cid] = false;
    }
  }

  /* ── BROK 6 STRUCT-1: Vandaag-tab (default) ──────────────────────────
     Command-center voor de start van de dag. KPI-strip met live-tellers,
     "Direct doen"-tegel (vandaag's afspraken + pending scheduled_for<=now),
     "Op reactie wachtend", en "Late facturen (top 10)"-worklist uit
     overzicht. Alles readonly hier — actie via klik-through naar
     Case-sheet (dossier) of naar Acties-tab.
     Read-only view; alle mutaties gebeuren via bestaande flows. */
  function vandaagView() {
    if (!_live.pipelineActs.fetched && !_live.pipelineActs.loading && !_live.pipelineActs.error) queueMicrotask(_fetchPipelineActs);
    if (!_live.pendingActs.fetched  && !_live.pendingActs.loading  && !_live.pendingActs.error)  queueMicrotask(_fetchPendingActs);
    if (!_live.overzicht.fetched    && !_live.overzicht.loading    && !_live.overzicht.error)    queueMicrotask(_fetchOverzicht);
    if (!_arrLive.fetched           && !_arrLive.loading           && !_arrLive.error)           queueMicrotask(() => _fetchArrangementsList('ACTIEF'));

    const pa       = _live.pipelineActs.data || {};
    const apDue    = asArr(pa.appointments_due);
    const awaiting = asArr(pa.awaiting_reply);
    const stale    = asArr(pa.stale);

    const overzicht = asArr(_live.overzicht.items);
    const pending   = asArr(_live.pendingActs.items);
    const now       = Date.now();
    const arrs      = asArr(_arrLive.items);

    // KPI-berekeningen (defensive tegen NaN).
    const totalOpenCents = overzicht.reduce((s, r) => s + (Number(r.total_open_cents) || 0), 0);
    const totalOpen      = totalOpenCents / 100;
    const openKlanten    = overzicht.length;
    const late30         = overzicht.filter((r) => (Number(r.days_overdue) || 0) >= 30).length;
    const late60         = overzicht.filter((r) => (Number(r.days_overdue) || 0) >= 60).length;
    const actiesVandaag  = pending.filter((a) => {
      const s = a.scheduled_for ? Date.parse(a.scheduled_for) : null;
      return !s || s <= now;
    }).length + apDue.length;
    const arrCount = arrs.length;

    const loadingAny = _live.overzicht.loading || _live.pipelineActs.loading || _live.pendingActs.loading;
    if (loadingAny && !overzicht.length && !apDue.length && !pending.length) {
      return `<div class="pad" style="padding:14px 20px">${_skelKpis()}${_skelRows(5)}</div>`;
    }

    const kpi = (label, val, sub, color, extra) => `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px 16px;${extra || ''}">
        <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);margin-bottom:6px">${esc(label)}</div>
        <div style="font-size:22px;font-weight:600;color:var(--${color || 'text-1'})">${val}</div>
        ${sub ? `<div style="font-size:11.5px;color:var(--text-3);margin-top:4px">${esc(sub)}</div>` : ''}
      </div>`;

    // Late facturen top-10 (uit overzicht — per klant, sorted by days_overdue desc)
    const late = overzicht.slice()
      .sort((a, b) => (Number(b.days_overdue) || 0) - (Number(a.days_overdue) || 0))
      .slice(0, 10);
    const lateHtml = late.length
      ? `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
          <div style="padding:12px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
            <div style="font-weight:600;font-size:13px;color:var(--rose)">Late facturen — top 10</div>
            <span style="font-size:11px;color:var(--text-3)">${late30} klanten ≥30d · ${late60} ≥60d</span>
          </div>
          <div style="display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:8px;padding:8px 14px;background:var(--surface-2);border-bottom:1px solid var(--border);font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);font-weight:600">
            <div>Klant</div><div style="text-align:right">Openstaand</div><div style="text-align:right">Dagen te laat</div><div></div>
          </div>
          ${late.map((r) => {
            const cid  = r.customer_id || r.id;
            const name = r.customer_name || r.name || 'Onbekend';
            const openEur = (Number(r.total_open_cents) || 0) / 100;
            const days = Number(r.days_overdue) || 0;
            const cidClick = String(cid || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            return `<div style="display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:8px;padding:8px 14px;border-bottom:1px solid var(--border);font-size:12.5px;align-items:center;cursor:pointer" onclick="__wbxOpenCase('${cidClick}')"
              onmouseover="this.style.background='var(--surface-2)'" onmouseout="this.style.background='transparent'">
              <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</div>
              <div class="mono" style="text-align:right;color:var(--rose);font-weight:600">${eur(openEur)}</div>
              <div class="mono" style="text-align:right;color:${days >= 60 ? 'var(--rose)' : (days >= 30 ? 'var(--amber)' : 'var(--text-3)')}">${days}d</div>
              <div style="font-size:10.5px;color:var(--text-3)">Dossier →</div>
            </div>`;
          }).join('')}
        </div>`
      : `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:32px 20px;text-align:center;color:var(--text-3);font-size:13px">
          🎉 Geen wanbetalers vandaag. Alles betaald.
        </div>`;

    // "Direct doen" — appointments + hoogste-prio pending (scheduled_for<=now).
    const directPending = pending.filter((a) => {
      const s = a.scheduled_for ? Date.parse(a.scheduled_for) : null;
      return !s || s <= now;
    }).slice(0, 8);
    const directHtml = `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
      <div style="padding:12px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
        <div style="font-weight:600;font-size:13px;color:var(--amber)">Direct doen</div>
        <span style="font-size:11px;color:var(--text-3)">${apDue.length} afspraak · ${directPending.length} taak</span>
      </div>
      ${(apDue.length + directPending.length) === 0
        ? `<div style="padding:22px;text-align:center;color:var(--text-3);font-size:12.5px">Niets op de rol voor vandaag.</div>`
        : ''}
      ${apDue.slice(0, 5).map((r) => {
        // BROK WB-FIX-2 #2: STRIKT customer_id — géén fallback naar r.id (dat is
        // een appointment-id, geen klant-id). Alleen klikbaar bij valide UUID.
        const cid = r.customer_id || null;
        const cidClick = String(cid || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const name = r.customer_name || r.name || 'Onbekend';
        const info = r.title || r.due_at || '';
        return `<div style="padding:9px 14px;border-bottom:1px solid var(--border);cursor:${cid ? 'pointer' : 'default'}" ${cid ? `onclick="__wbxOpenCase('${cidClick}')"` : ''}>
          <div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">
            <span style="font-weight:500;font-size:12.5px">📅 ${esc(name)}</span>
            <span style="font-size:10.5px;color:var(--text-3)">${esc(_fmtDateTime(r.due_at || '').slice(5))}</span>
          </div>
          <div style="font-size:11px;color:var(--text-3);margin-top:2px">${esc(String(info).slice(0, 80))}</div>
        </div>`;
      }).join('')}
      ${directPending.map((a) => {
        // BROK WB-FIX-2 #2: directPending nu KLIKBAAR — opent SURFACE B drawer
        // op a.customer_id (pending_actions.customer_id = customer-uuid).
        const cid = a.customer_id || null;
        const cidClick = String(cid || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const name = (a.customer && a.customer.name) || a.customer_name || (a.payload && a.payload.customer_name) || 'Onbekend';
        const type = a.action_type || '—';
        const isTl = String(type).startsWith('TL_');
        return `<div style="padding:9px 14px;border-bottom:1px solid var(--border);font-size:12.5px;cursor:${cid ? 'pointer' : 'default'}" ${cid ? `onclick="__wbxOpenCase('${cidClick}',{customer_name:'${esc(name).replace(/'/g,"\\'")}'})" onmouseover="this.style.background='var(--surface-2)'" onmouseout="this.style.background='transparent'"` : ''}>
          <div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">
            <span style="font-weight:500">✅ ${esc(name)}</span>
            ${isTl ? '<span style="font-size:9.5px;padding:1px 5px;border-radius:5px;background:var(--rose-soft);color:var(--rose);font-weight:600">TL</span>' : ''}
          </div>
          <div style="font-size:11px;color:var(--text-3);margin-top:2px">${esc(type)}</div>
        </div>`;
      }).join('')}
    </div>`;

    // "Wacht op reactie" + "Stille dossiers" side-by-side.
    const listBlock = (title, rows, colorAcc, iconEmoji, emptyTxt) => `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
      <div style="padding:12px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
        <div style="font-weight:600;font-size:13px;color:var(--${colorAcc})">${esc(title)}</div>
        <span style="font-size:11px;color:var(--text-3)">${rows.length}</span>
      </div>
      ${!rows.length
        ? `<div style="padding:22px;text-align:center;color:var(--text-3);font-size:12.5px">${esc(emptyTxt)}</div>`
        : rows.slice(0, 6).map((r) => {
            // BROK WB-FIX-2 #2: STRIKT customer_id (geen fallback op r.id;
            // pipeline-actions objecten hebben géén 'id'-veld, alleen
            // appointment_id/conversation_id die géén klant-uuid zijn).
            const cid = r.customer_id || null;
            const name = r.customer_name || r.name || 'Onbekend';
            const days = r.days_since != null ? r.days_since : (r.days_stale != null ? r.days_stale : (r.days_waiting != null ? r.days_waiting : (r.days_since_activity != null ? r.days_since_activity : null)));
            const cidClick = String(cid || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
            return `<div style="display:flex;justify-content:space-between;gap:8px;padding:8px 14px;border-bottom:1px solid var(--border);font-size:12.5px;align-items:center;cursor:${cid ? 'pointer' : 'default'}" ${cid ? `onclick="__wbxOpenCase('${cidClick}',{customer_name:'${esc(name).replace(/'/g,"\\'")}'})" onmouseover="this.style.background='var(--surface-2)'" onmouseout="this.style.background='transparent'"` : ''}>
              <span>${iconEmoji} ${esc(name)}</span>
              ${days != null ? `<span class="mono" style="font-size:10.5px;color:var(--text-3)">${days}d</span>` : ''}
            </div>`;
          }).join('')}
    </div>`;

    return `<div data-wbx-view="vandaag">
      <div class="pad" style="padding:14px 20px 0">
        <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:14px">
          ${kpi('Openstaand',       eur(totalOpen),       `${openKlanten} klant${openKlanten === 1 ? '' : 'en'}`, totalOpen > 0 ? 'rose' : 'text-3')}
          ${kpi('Late facturen',    String(late30),       '≥ 30 dagen',       late30 > 0 ? 'rose' : 'text-3')}
          ${kpi('Acties vandaag',   String(actiesVandaag),'te doen',          actiesVandaag > 0 ? 'amber' : 'text-3')}
          ${kpi('Wacht op reactie', String(awaiting.length), '> 2 dagen',      awaiting.length > 0 ? 'amber' : 'text-3')}
          ${kpi('Arrangementen',    String(arrCount),     'actief · flow gepauzeerd', 'text-1')}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
          ${directHtml}
          <div style="display:flex;flex-direction:column;gap:12px">
            ${listBlock('Wacht op reactie',  awaiting, 'amber', '💬', 'Niemand wacht op ons.')}
            ${listBlock('Stille dossiers',   stale,    'text-3','😴', 'Alle dossiers actief.')}
          </div>
        </div>
        ${lateHtml}
      </div>
      ${_officeHoursBanner()}
    </div>`;
  }

  /* ── Registratie ────────────────────────────────────────────────────── */
  window.DFO.VIEWS['wanbetalers/Vandaag']    = vandaagView;
  window.DFO.VIEWS['wanbetalers/Gesprekken'] = inboxView;
  window.DFO.VIEWS['wanbetalers/Acties']     = actiesView;
  window.DFO.VIEWS['wanbetalers/Overzicht']  = overzichtView;
  window.DFO.VIEWS['wanbetalers/Brieven']    = brievenView;
  window.DFO.VIEWS['wanbetalers/Motor']      = motorView;
  window.DFO.VIEWS['wanbetalers/Pipeline']   = pipelineView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('wanbetalers');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('wanbetalers');
  console.debug('[wanbetalers-v2] v=36 BROK C: _fetchCasePipeline skipt de /api/dunning-pipeline-detail-call bij een klant met open_invoice_count === 0 in overzicht — synthetische empty-response (open_invoices:[], _synthetic:true) i.p.v. netwerk-404. Voorkomt rode "GET .. 404" in console + de tryFetch console.warn. Fallback: zonder overzicht (race) fetchen we nog steeds. UI-render onveranderd — _caseFactuurCardHtml toont "Geen open factuur" bij lege lijst.');
  console.debug('[wanbetalers-v2] v=35 BROK WB-FIX-6: klantnaam als klikdoel — thread-header <b>naam</b> + right klantgegevens-paneel naam-heading. Beide krijgen cursor:pointer + hover-underline (brand-color) + click -> __wbxOpenCase(cid, {customer_name}). event.stopPropagation zodat kop-knoppen (✓/+/👤/⋮) niet dubbel triggeren. Wordt niet klikbaar als cust.id ontbreekt (unmatched-nummer conv).');
  console.debug('[wanbetalers-v2] v=34 BROK WB-FIX-5: (#1) Volgende-badge mapt nu op ECHTE overzicht-velden next_action_step_type (email/whatsapp/wait/task/stop/resume_dunning) + next_action_step_title heuristiek (Bel/Brief/Incasso/Herinnering). Voorheen: mijn code checkte non-bestaande velden -> altijd "Actie"-fallback. (#2) MANUAL_FOLLOWUP-splitting op payload.kind: kind=call -> "📞 Belafspraak" (Bel-knop OK), kind=letter -> "✉ Brief-taak" (Bel-knop weg, "Naar brief-flow"-knop naar SURFACE B WIK-card), kind=other -> "📝 Follow-up". Fallback: title-regex (bv. "Stuur WIK-14-dagenbrief" -> letter). Groepering ook via effectieve type — brief-taken en bel-taken vallen nu in APARTE groepen. Ook: MANUAL_PROPOSE_ARRANGEMENT label naar "Regeling voorstellen" (v1-parity, was "Arrangement voorstellen").');
  console.debug('[wanbetalers-v2] v=33 BROK WB-POLISH-4: dead-code cleanup — gesprekkenView + _gspListInnerHtml + _gspDetailHtml body volledig verwijderd (~180 regels dood-code weg). _repaintGspList + _repaintGspDetail zijn no-op stubs (callers _fetchCallLog/_fetchTimeline/__wbxCallSave/__wbxCallSet* + __wbxNoteSave triggeren nu geen render meer; case-sheet SURFACE B doet z\'n eigen repaint). __wbxCallSet*/__wbxGspSelect/__wbxGspSearch* blijven als window-refs (geen callers meer; volgende cleanup-brok kan die schrappen).');
  console.debug('[wanbetalers-v2] v=32 BROK WB-POLISH-3: arrangement-detail drawer. Body-level right-slide (760px) + scrim + Escape. Data via /api/arrangements-detail?id=X. Secties: header (type — klant + status-pill), Arrangement kv-grid (type/status/dates/reden), Facturen-lijst (indien invs), Pending actions-tabel, footer met ✕ Annuleer (danger, delegates naar __wbxArrCancel voor ACTIEF/VOORGESTELD). Klik op Actieve arrangementen-rij (actiesView) opent drawer; cancel-btn heeft event.stopPropagation.');
  console.debug('[wanbetalers-v2] v=31 BROK WB-POLISH-2: pipeline multi-select — checkbox per kaart, shift-klik range binnen dezelfde fase, bulk-bar met count + fase-picker + Verplaats-knop. Typ-to-confirm "VERPLAATS" (of "TERMINAAL" bij opgelost/afschrijven met extra rood-danger-hint "motor stopt voor N klanten"). Race-guard per cid (stageBusy) + globale pipeBulkBusy. Skip no-ops (klant al in target-fase). Invalidate overzicht na move -> kolom-tellingen updaten zonder scroll-reset.');
  console.debug('[wanbetalers-v2] v=30 BROK WB-POLISH-1: overzicht klikbare kolom-headers (open/dagen/fase/next/name sort, asc/desc toggle, next-null onderaan). Brieven: zoek-input (naam/e-mail 200ms debounce), select-all in header (per zichtbare filter), bulk-verwijderen met typ-to-confirm "VERWIJDER".');
  console.debug('[wanbetalers-v2] v=29 BROK WB-FIX-4: (#1) BE-lijn regressie -> altijd tonen (+ ensureReady on-demand); (#2) Volgende-badge "actie g,..." fix -> kanaal-mapping + volle datetime; (#3) thread scroll: sync+RAF, 5s loop, force clear pas na daadwerkelijk bodemen; (#4) type-label chip OP de kaart (v1-parity); (#5) drawer-kop lege staat "Geen open factuur" i.p.v. "Factuur — · €0,00 · 0 dagen"; (#6) thread-kop fallback KLANTNAAM (via ctx.customer.name) i.p.v. phone. Minor: klant-info-blok +e-mail; invoice-modal accepteert c.name; poging-teller min 4 dots + cadence store in _fetchCallLog.');
})();
