// modules/klanten-v2/views/lisa-v2.js
//
// Lisa (Appointmentsetter) v2 — v=6 (2026-08-18): boekingslink-only.
// (v=3 introduceerde intervene + status-mutaties + afspraak-picker;
//  v=6 verwijdert de picker, laat 'Stuur boekingslink' als enige route
//  naar een afspraak — volger plant zelf via LISA_BOOKING_URL.)
//
// DEEL 0 (fix vanuit v=2):
//   - Thread-klik laadde niet: guard in _loadThread controleerde op
//     _thread.convId (die __lisaSelConv net had gezet) → early-return.
//     Nu: guard op _thread.conversation.id (blijft null tot fetch klaar).
//     Ook _paintedFor per-conv → cache.
//   - Lege staat 'Nog geen berichten.' verscheen soms naast bubbles;
//     nu strikt: alleen na paint klaar + messages.length===0.
//
// BROK 2 DEEL A — Reageren (intervene):
//   Compose-textarea in thread-footer + custom confirm-modal
//   ('Verstuur echt IG-DM naar @<handle>?' + preview) → POST
//   /api/lisa-conversations?action=intervene&id=<>. Bij succes:
//   optimistic append (direction:out, human_override:true) +
//   human_takeover-banner in header. Sandbox: send-knop disabled.
//
// BROK 2 DEEL B — Status-mutaties:
//   Header-actiemenu: fase-wijziging (dropdown), Markeer gekwal./
//   Disqualified (+reason-prompt), Pauzeer/Hervat follow-ups, Mens-
//   overname aan/uit. Elke actie: confirm-modal → PATCH
//   /api/lisa-conversations?id=<>. Optimistic + rollback bij 4xx/5xx.
//
// BROK 2 DEEL C — Boekingslink (v=6):
//   Header-knop 'Stuur boekingslink' prefillt de compose-textarea met
//   een korte standaard-zin + de agenda-URL uit env-var LISA_BOOKING_URL.
//   Verzenden via de bestaande intervene-flow (confirm-modal = de stop).
//   Als env-var ontbreekt: setup-modal met exacte instructies.
//   Zelf-inschieten van Zoom-afspraken (free-slots-picker +
//   /api/lisa-appointment-create) is verwijderd in v=6 — dat endpoint +
//   de additieve 'lisa.config.publish' gate op follow-up-ghl-free-slots
//   staan dormant in de repo (geen actieve caller vanuit deze UI).
//
// Safety: skeleton, 8s tryFetch-timeout, asArr, esc(), fail-soft +
// Opnieuw-knop, per-fetcher _seq, race-guard op send (_compose.sending),
// surgical list-scroll-preservering, poll 18s met document.hidden-pause
// + stop-detect bij verlaten module.
//
// Dormant — 'lisa' NIET in V2_ACTIVE_ALLOWLIST. Preview: ?v2preview=lisa.

(function () {
  if (!window.DFO) { console.error('[lisa-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[lisa-v2] KV_V2.helpers niet geladen.'); return; }
  const { I, svg, F } = window.DFO;
  const H = window.KV_V2.helpers;
  const asArr = (x) => Array.isArray(x) ? x : [];
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /* ── State ──────────────────────────────────────────────────────────── */
  const _live = {
    stats:    { loading: false, fetched: false, error: null, data: null, _seq: 0, period: 'week' },
    settings: { loading: false, fetched: false, error: null, data: null, _seq: 0 },
    logs:     { loading: false, fetched: false, error: null, data: null, _seq: 0 },
    convs:    { loading: false, fetched: false, error: null, items: [], _seq: 0, statusFilter: 'active', q: '', _searchTimer: null, _searchSeq: 0 },
    statsAll: {},
  };
  const _thread = {
    convId: null, conversation: null, messages: [], feedback: [], qualification: null,
    loading: false, error: null, _paintedFor: null, _seq: 0,
  };
  const _compose = { text: '', sending: false };
  const _booking = { fetched: false, loading: false, url: null, configured: false };
  const _poll    = { handle: null, running: false, intervalMs: 18000 };

  /* ── HTTP-helpers ────────────────────────────────────────────────────── */
  async function tryFetch(label, url, timeoutMs) {
    timeoutMs = timeoutMs || 8000;
    try {
      const p = window.KV.authedJson(url);
      return await Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) {
      console.warn('[lisa-v2] ' + label + ' fetch fail:', e && e.message);
      return null;
    }
  }
  async function apiCall(method, url, body, opts) {
    // Retourneert { ok, status, json, error }. Nooit throws.
    try {
      const token = await (window.AuthShared && window.AuthShared.getAccessToken ? window.AuthShared.getAccessToken() : Promise.resolve(null));
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      const timeoutMs = (opts && opts.timeoutMs) || 15000;
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), timeoutMs);
      let resp;
      try {
        resp = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
      } finally { clearTimeout(to); }
      let j = null;
      try { j = await resp.json(); } catch (_) {}
      return { ok: resp.ok, status: resp.status, json: j, error: resp.ok ? null : (j && (j.error || j.message)) || ('HTTP ' + resp.status) };
    } catch (e) {
      return { ok: false, status: 0, json: null, error: (e && e.message) || 'netwerkfout' };
    }
  }

  /* ── Modal helpers (custom confirm — geen native window.confirm) ─────── */
  function _closeModal() {
    const m = document.getElementById('lisaModalRoot');
    if (m) m.remove();
    document.removeEventListener('keydown', _modalKey, true);
  }
  function _modalKey(e) { if (e.key === 'Escape') { e.preventDefault(); _closeModal(); } }
  function _openModal(html, opts) {
    _closeModal();
    const root = document.createElement('div');
    root.id = 'lisaModalRoot';
    root.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)';
    root.innerHTML = `<div id="lisaModalBox" style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);
      padding:22px;max-width:${(opts && opts.maxWidth) || 520}px;width:calc(100vw - 40px);max-height:calc(100vh - 60px);overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.35)">${html}</div>`;
    root.addEventListener('click', (e) => { if (e.target === root) _closeModal(); });
    document.body.appendChild(root);
    document.addEventListener('keydown', _modalKey, true);
    return root;
  }
  function _askConfirm(title, bodyHtml, opts) {
    const okLabel     = esc((opts && opts.okLabel)     || 'Bevestig');
    const cancelLabel = esc((opts && opts.cancelLabel) || 'Annuleren');
    const isRose = opts && opts.tone === 'danger';
    const bgVar  = isRose ? 'var(--rose, #C22B3E)' : 'var(--brand, #0A7490)';
    return new Promise((resolve) => {
      _openModal(`
        <div style="font-size:15.5px;font-weight:600;margin-bottom:8px">${esc(title)}</div>
        <div style="font-size:13px;color:var(--text-2);line-height:1.55;margin-bottom:18px">${bodyHtml}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="lisaModalCancel" class="btn btn-ghost btn-sm">${cancelLabel}</button>
          <button id="lisaModalOk" class="btn btn-primary btn-sm" style="background:${bgVar};border-color:${bgVar};color:#fff">${okLabel}</button>
        </div>`);
      document.getElementById('lisaModalCancel').addEventListener('click', () => { _closeModal(); resolve(false); });
      document.getElementById('lisaModalOk').addEventListener('click',    () => { _closeModal(); resolve(true);  });
    });
  }
  function _askPrompt(title, hint, placeholder, opts) {
    const okLabel = esc((opts && opts.okLabel) || 'OK');
    return new Promise((resolve) => {
      _openModal(`
        <div style="font-size:15.5px;font-weight:600;margin-bottom:8px">${esc(title)}</div>
        <div style="font-size:13px;color:var(--text-2);margin-bottom:12px">${esc(hint || '')}</div>
        <textarea id="lisaPromptInput" style="width:100%;min-height:80px;padding:9px 11px;border:1px solid var(--border);border-radius:var(--r-sm);font:inherit;font-size:13px;background:var(--surface);color:var(--text-1);resize:vertical" placeholder="${esc(placeholder || '')}"></textarea>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
          <button id="lisaPromptCancel" class="btn btn-ghost btn-sm">Annuleren</button>
          <button id="lisaPromptOk" class="btn btn-primary btn-sm" style="background:var(--brand,#0A7490);border-color:var(--brand,#0A7490);color:#fff">${okLabel}</button>
        </div>`);
      const inp = document.getElementById('lisaPromptInput');
      setTimeout(() => inp && inp.focus(), 20);
      document.getElementById('lisaPromptCancel').addEventListener('click', () => { _closeModal(); resolve(null); });
      document.getElementById('lisaPromptOk').addEventListener('click', () => {
        const v = String((inp && inp.value) || '').trim();
        _closeModal(); resolve(v || null);
      });
    });
  }
  function _toast(msg, tone) { try { window.KV && window.KV.toast && window.KV.toast(msg, { tone }); } catch (_) {} }

  /* ── Fetchers ───────────────────────────────────────────────────────── */
  async function _fetchStats(period) {
    const st = _live.stats;
    const p = period || st.period || 'week';
    if (_live.statsAll[p]) { st.data = _live.statsAll[p]; st.fetched = true; st.period = p; return; }
    if (st.loading) return;
    st.loading = true; st.error = null; st.period = p;
    const seq = ++st._seq;
    if (window.DFO?.render) window.DFO.render();
    const j = await tryFetch('stats:' + p, '/api/lisa-stats?period=' + encodeURIComponent(p));
    if (seq !== st._seq) return;
    st.loading = false; st.fetched = true;
    if (!j || j.error) st.error = (j && j.error) || 'Kon stats niet laden';
    else { st.data = j; _live.statsAll[p] = j; }
    if (window.DFO?.render) window.DFO.render();
  }
  async function _fetchSettings() {
    const st = _live.settings;
    if (st.loading || (st.fetched && !st.error)) return;
    st.loading = true; st.error = null;
    const seq = ++st._seq;
    const j = await tryFetch('settings', '/api/lisa-settings');
    if (seq !== st._seq) return;
    st.loading = false; st.fetched = true;
    if (!j || j.error) st.error = (j && j.error) || 'Kon settings niet laden';
    else st.data = j.settings || j;
    if (window.DFO?.render) window.DFO.render();
  }
  async function _fetchLogs() {
    const st = _live.logs;
    if (st.loading || (st.fetched && !st.error)) return;
    st.loading = true; st.error = null;
    const seq = ++st._seq;
    const j = await tryFetch('logs-summary', '/api/lisa-logs?action=summary');
    if (seq !== st._seq) return;
    st.loading = false; st.fetched = true;
    if (!j || j.error) st.error = (j && j.error) || 'Kon logs niet laden';
    else st.data = j;
    if (window.DFO?.render) window.DFO.render();
  }
  // opts.surgical=true → alleen de lijst-container innerHTML swap (behoudt
  // scroll + zoekveld-focus/cursor tijdens typen). opts.silent=true skipt
  // de eerste DFO.render (initial-fetch geeft skeleton via de reguliere view).
  async function _fetchConvs(opts) {
    const st = _live.convs;
    const surgical = !!(opts && opts.surgical);
    const silent   = !!(opts && opts.silent);
    if (st.loading) return;
    st.loading = true; st.error = null;
    const seq = ++st._seq;
    if (!surgical && !silent && window.DFO?.render) window.DFO.render();
    const parts = [
      'action=list_live',
      'status=' + encodeURIComponent(st.statusFilter || 'active'),
      'limit=100',
    ];
    const qTrim = String(st.q || '').trim();
    if (qTrim) parts.push('q=' + encodeURIComponent(qTrim));
    const url = '/api/lisa-conversations?' + parts.join('&');
    const j = await tryFetch('convs', url);
    if (seq !== st._seq) return;
    st.loading = false; st.fetched = true;
    if (!j || j.error) st.error = (j && j.error) || 'Kon gesprekken niet laden';
    else st.items = asArr(j.conversations);
    if (surgical) _repaintListBody();
    else if (window.DFO?.render) window.DFO.render();
  }
  // Surgical swap van alleen de lijst-items binnen #lisaConvList (behoudt
  // toolbar-container met zoekveld → focus/cursor blijft tijdens typen).
  function _repaintListBody() {
    const listEl = document.getElementById('lisaConvList');
    if (!listEl) return;
    const bodyEl = listEl.querySelector('#lisaConvListBody');
    if (!bodyEl) return;
    const st = _live.convs;
    const rows = asArr(st.items);
    const html = st.loading && !rows.length
      ? renderSkeletonRows(6)
      : rows.length
        ? rows.map(_renderConvRow).join('')
        : `<div style="padding:44px 20px;text-align:center;color:var(--text-3);font-size:13px">${st.error ? '⚠ ' + esc(st.error) : (String(st.q || '').trim() ? 'Geen gesprekken die op "' + esc(st.q) + '" matchen.' : 'Geen gesprekken in dit filter.')} ${st.error ? `<button class="btn btn-ghost btn-sm" onclick="__lisaRetry('convs')" style="margin-left:8px">Opnieuw</button>` : ''}</div>`;
    bodyEl.innerHTML = html;
    // Update de counter naast de status-chip regel.
    const counterEl = listEl.querySelector('#lisaConvListCount');
    if (counterEl) counterEl.textContent = rows.length + ' gesprek' + (rows.length === 1 ? '' : 'ken') + (String(st.q || '').trim() ? ' · zoekterm actief' : '');
    // Als de huidige geselecteerde conv niet meer in de results zit,
    // reset thread + swap right-pane naar neutrale placeholder zodat je
    // geen dood detail ziet.
    if (_thread.convId && !rows.some((r) => String(r.id) === String(_thread.convId))) {
      _resetThread();
      const split = document.querySelector('.lisa-gesp-split');
      const oldRight = split ? split.querySelector('.lisa-gesp-right') : null;
      if (split && oldRight) {
        const placeholder = document.createElement('div');
        placeholder.className = 'lisa-gesp-right';
        placeholder.style.cssText = 'flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-3);font-size:13px';
        placeholder.textContent = 'Selecteer een gesprek';
        split.replaceChild(placeholder, oldRight);
      }
    }
  }
  function _resetThread() {
    _thread.convId = null; _thread.conversation = null; _thread.messages = [];
    _thread.feedback = []; _thread.qualification = null;
    _thread.loading = false; _thread.error = null; _thread._paintedFor = null;
    _compose.text = ''; _compose.sending = false;
  }
  async function _loadThread(convId) {
    if (!convId) return;
    if (_thread.conversation && String(_thread.conversation.id) === String(convId) && !_thread.error) return;
    if (_thread.loading && String(_thread.convId) === String(convId)) return;
    _thread.loading = true; _thread.error = null;
    _thread.convId = convId; _thread.messages = []; _thread._paintedFor = null;
    // v=5 BLOCKER-FIX: alleen de rechter-pane vervangen ipv DFO.render()
    // (die #content innerHTML swapt en de LIJST-scroll naar 0 slaat).
    _replaceRightPane();
    const seq = ++_thread._seq;
    const j = await tryFetch('thread:' + convId, '/api/lisa-conversations?id=' + encodeURIComponent(convId));
    if (seq !== _thread._seq) return;
    if (String(_thread.convId) !== String(convId)) return;
    if (!j || j.error) {
      _thread.loading = false;
      _thread.error = (j && j.error) || 'Kon thread niet laden';
      _replaceRightPane();
      return;
    }
    _thread.conversation = j.conversation || null;
    _thread.messages = asArr(j.messages);
    _thread.feedback = asArr(j.feedback);
    _thread.qualification = j.qualification || null;
    _thread.loading = false;
    _replaceRightPane();
  }

  /* ── Surgical UI-helpers (v=5) ──────────────────────────────────────────
     _replaceRightPane / _repaintListRow bewaren de lijst-scrollpositie:
     alleen de exacte DOM-nodes die veranderen worden vervangen. Zonder deze
     helpers slaat DFO.render() heel #content om waardoor #lisaConvList
     opnieuw wordt gebouwd en scrollTop naar 0 valt.
     _replaceRightPane() gebruikt _thread.conversation als bron van waarheid
     zodra die geladen is; fallback op de lijst-row (voor eerste-mount).
     _paintThread() en _updateSendBtn() worden na de swap in queueMicrotask
     opgeroepen zodat mount/focus stabiel is. */
  function _replaceRightPane() {
    const split = document.querySelector('.lisa-gesp-split');
    if (!split) return;
    const convId = _thread.convId;
    if (!convId) return;
    const rowFromList = _live.convs.items.find(c => String(c.id) === String(convId)) || null;
    const rowForRender = (_thread.conversation && String(_thread.conversation.id) === String(convId))
      ? _thread.conversation
      : rowFromList;
    if (!rowForRender) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = _renderConvDetail(rowForRender);
    const fresh = wrap.firstElementChild;
    if (!fresh) return;
    const old = split.querySelector('.lisa-gesp-right');
    if (old) split.replaceChild(fresh, old); else split.appendChild(fresh);
    queueMicrotask(_paintThread);
    queueMicrotask(_updateSendBtn);
  }
  function _repaintListRow(convId) {
    if (!convId) return;
    const listEl = document.getElementById('lisaConvList');
    if (!listEl) return;
    const row = _live.convs.items.find(c => String(c.id) === String(convId));
    if (!row) return;
    const oldNode = listEl.querySelector('.lisa-conv-row[data-row-id="' + String(convId).replace(/"/g, '\\"') + '"]');
    if (!oldNode) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = _renderConvRow(row);
    const fresh = wrap.firstElementChild;
    if (!fresh) return;
    // Behoud .on-highlight zodat active-styling niet flickert.
    if (oldNode.classList.contains('on')) fresh.classList.add('on');
    oldNode.replaceWith(fresh);
  }

  /* ── Handlers op window ─────────────────────────────────────────────── */
  window.__lisaRetry = (what) => {
    if (what === 'stats')    { _live.stats.fetched = false;    _fetchStats(_live.stats.period); }
    if (what === 'settings') { _live.settings.fetched = false; _fetchSettings(); }
    if (what === 'logs')     { _live.logs.fetched = false;     _fetchLogs(); }
    if (what === 'convs')    { _live.convs.fetched = false;    _fetchConvs(); }
    if (what === 'thread' && _thread.convId) { const id = _thread.convId; _resetThread(); _loadThread(id); }
  };
  window.__lisaSetStatus = (val) => {
    _live.convs.statusFilter = val;
    _live.convs.fetched = false;
    _resetThread();
    _fetchConvs();
  };
  // Zoekveld: state-only setter tijdens typen (GEEN render → focus/cursor
  // in het input-element blijft). Debounce 300 ms → surgical list-body swap
  // via _fetchConvs({surgical:true}). Bij lege input direct terug naar de
  // volle lijst (geen debounce nodig, korte roundtrip).
  window.__lisaSearchInput = (val) => {
    const v = String(val || '');
    _live.convs.q = v;
    // Toggle de wis-knop zichtbaar/verborgen zonder render.
    const clr = document.getElementById('lisaSearchClear');
    if (clr) clr.style.visibility = v.trim() ? 'visible' : 'hidden';
    if (_live.convs._searchTimer) { clearTimeout(_live.convs._searchTimer); _live.convs._searchTimer = null; }
    const seq = ++_live.convs._searchSeq;
    const delayMs = v.trim() ? 300 : 0;
    _live.convs._searchTimer = setTimeout(async () => {
      if (seq !== _live.convs._searchSeq) return;
      // Reset guard: forceer refetch (dezelfde q kan opnieuw geldig zijn na
      // filter-wissel of eerdere fout). Loading-guard blijft actief via _seq.
      _live.convs.loading = false;
      await _fetchConvs({ surgical: true });
    }, delayMs);
  };
  window.__lisaSearchClear = () => {
    _live.convs.q = '';
    const inp = document.getElementById('lisaSearchInput');
    if (inp) { inp.value = ''; inp.focus(); }
    const clr = document.getElementById('lisaSearchClear');
    if (clr) clr.style.visibility = 'hidden';
    if (_live.convs._searchTimer) { clearTimeout(_live.convs._searchTimer); _live.convs._searchTimer = null; }
    _live.convs._searchSeq++;
    _live.convs.loading = false;
    _fetchConvs({ surgical: true });
  };
  window.__lisaSetStatsPeriod = (p) => { _fetchStats(p); };
  window.__lisaSelConv = (id) => {
    if (String(_thread.convId) === String(id)) return;
    document.querySelectorAll('#lisaConvList .lisa-conv-row.on').forEach(el => el.classList.remove('on'));
    const newRow = document.querySelector('#lisaConvList .lisa-conv-row[data-row-id="' + String(id).replace(/"/g, '\\"') + '"]');
    if (newRow) newRow.classList.add('on');
    const split = document.querySelector('.lisa-gesp-split');
    const oldRight = split ? split.querySelector('.lisa-gesp-right') : null;
    const row = _live.convs.items.find(c => String(c.id) === String(id));
    _resetThread();
    _thread.convId = id;
    if (split && row) {
      const wrap = document.createElement('div');
      wrap.innerHTML = _renderConvDetail(row);
      const el = wrap.firstElementChild;
      if (el) { if (oldRight) split.replaceChild(el, oldRight); else split.appendChild(el); }
    }
    queueMicrotask(() => _loadThread(id));
  };

  /* ── Compose (DEEL A intervene) ─────────────────────────────────────── */
  window.__lisaComposeInput = (el) => { _compose.text = el.value; _updateSendBtn(); };
  function _updateSendBtn() {
    const btn = document.getElementById('lisaSendBtn');
    if (!btn) return;
    const conv = _thread.conversation;
    const disabled = _compose.sending || !conv || conv.is_sandbox || _compose.text.trim().length < 2;
    btn.disabled = !!disabled;
    btn.style.opacity = disabled ? '0.55' : '1';
    btn.style.cursor  = disabled ? 'not-allowed' : 'pointer';
  }
  window.__lisaSend = async () => {
    if (_compose.sending) return;
    const conv = _thread.conversation;
    if (!conv || !conv.id) { _toast('Geen conversatie geladen.', 'error'); return; }
    if (conv.is_sandbox) { _toast('Sandbox-conversatie — intervene is niet toegestaan.', 'error'); return; }
    const text = String(_compose.text || '').trim();
    if (text.length < 2) return;
    const handle = conv.instagram_handle ? '@' + String(conv.instagram_handle).replace(/^@/, '') : (conv.contact_name || 'contact');
    const previewHtml = `
      <div style="font-size:12.5px;color:var(--text-3);margin-bottom:6px">Naar: <strong style="color:var(--text-1)">${esc(handle)}</strong></div>
      <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r-sm);padding:11px 13px;font-size:13px;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere;max-height:200px;overflow:auto">${esc(text)}</div>
      <div style="margin-top:12px;padding:9px 12px;background:var(--amber-soft);border-radius:var(--r-sm);font-size:12px;color:var(--amber);line-height:1.5">
        ⚠ Bij verzenden neemt jij (mens) dit gesprek over. Lisa antwoordt niet meer autonoom totdat je 'mens-overname' weer uitzet.
      </div>`;
    const ok = await _askConfirm(`Verstuur echt Instagram-DM naar ${handle}?`, previewHtml, { okLabel: 'Ja, verstuur', tone: 'primary' });
    if (!ok) return;

    _compose.sending = true; _updateSendBtn();
    const r = await apiCall('POST', '/api/lisa-conversations?action=intervene&id=' + encodeURIComponent(conv.id), { content: text });
    _compose.sending = false;
    if (!r.ok) {
      _toast(r.error || 'Versturen faalde', 'error');
      _updateSendBtn();
      return;
    }
    // Optimistic append + state-updates.
    const tempId = r.json?.message_id || ('local_' + Date.now());
    _thread.messages.push({
      id: tempId,
      direction: 'out',
      content: text,
      sent_at: new Date().toISOString(),
      ai_generated: false,
      human_override: true,
      is_system: false,
    });
    _compose.text = '';
    if (_thread.conversation) _thread.conversation.human_takeover = true;
    // Sync met lijst-row zodat MENS-badge direct verschijnt.
    const listRow = _live.convs.items.find(c => String(c.id) === String(conv.id));
    if (listRow) { listRow.human_takeover = true; listRow.last_message_at = new Date().toISOString(); listRow.preview = text.slice(0, 60); }
    _toast('Bericht verzonden — Lisa staat nu uit voor dit gesprek.', 'success');
    // v=5: surgical i.p.v. DFO.render() → lijst-scroll blijft staan.
    _replaceRightPane();
    _repaintListRow(conv.id);
    if (r.json?.ghl_send_ok === false && r.json?.ghl_error) {
      _toast('GHL waarschuwing: ' + r.json.ghl_error, 'error');
    }
  };

  /* ── Status-mutaties (DEEL B) ───────────────────────────────────────── */
  async function _patchConv(id, patch) {
    return apiCall('PATCH', '/api/lisa-conversations?id=' + encodeURIComponent(id), patch);
  }
  window.__lisaSetPhase = async (val) => {
    const conv = _thread.conversation;
    if (!conv || !val) return;
    if (conv.phase === val) return;
    const label = String(val);
    const ok = await _askConfirm('Zet fase op "' + label + '"?', `De fase van dit gesprek wordt op de server bijgewerkt naar <strong>${esc(label)}</strong>.`, { okLabel: 'Zet fase' });
    if (!ok) {
      // KLEIN 1 FIX (v=5): dropdown zette zichzelf al op de nieuwe waarde
      // via onchange — bij Annuleren terug naar de echte server-waarde
      // zodat visuele state == echte state.
      const sel = document.getElementById('lisaPhaseSelect');
      if (sel) sel.value = conv.phase || '';
      return;
    }
    const prev = conv.phase;
    conv.phase = val; _replaceRightPane();
    const r = await _patchConv(conv.id, { phase: val });
    if (!r.ok) {
      conv.phase = prev; _replaceRightPane();
      _toast(r.error || 'Kon fase niet wijzigen', 'error');
      return;
    }
    // Sync met lijst-row (fase-chip kleurt mee, geen scroll-reset).
    const listRow = _live.convs.items.find(c => String(c.id) === String(conv.id));
    if (listRow) listRow.phase = val;
    _toast('Fase bijgewerkt: ' + label, 'success');
    _replaceRightPane();
    _repaintListRow(conv.id);
  };
  window.__lisaToggleQualified = async () => {
    const conv = _thread.conversation;
    if (!conv) return;
    const next = !conv.qualified;
    const bodyText = next
      ? 'Dit gesprek markeren als <strong>gekwalificeerd</strong>. Zet qualified_at op nu.'
      : 'Kwalificatie ongedaan maken. qualified_at wordt op NULL gezet.';
    const ok = await _askConfirm(next ? 'Markeer gekwalificeerd?' : 'Kwalificatie ongedaan maken?', bodyText, { okLabel: next ? 'Ja, kwalificeer' : 'Ja, verwijder' });
    if (!ok) return;
    const prev = conv.qualified;
    conv.qualified = next; _replaceRightPane();
    const r = await _patchConv(conv.id, { qualified: next });
    if (!r.ok) {
      conv.qualified = prev; _replaceRightPane();
      _toast(r.error || 'Kon niet bijwerken', 'error');
      return;
    }
    const listRow = _live.convs.items.find(c => String(c.id) === String(conv.id));
    if (listRow) listRow.qualified = next;
    _toast(next ? 'Gemarkeerd als gekwalificeerd.' : 'Kwalificatie verwijderd.', 'success');
    _replaceRightPane();
    _repaintListRow(conv.id);
  };
  window.__lisaMarkDisqualified = async () => {
    const conv = _thread.conversation;
    if (!conv) return;
    const reason = await _askPrompt('Markeer als disqualified', 'Waarom valt deze lead af? (verplicht — komt in de audit-log)', 'bv. geen budget / geen interesse / bot / andere leeftijd', { okLabel: 'Zet disqualified' });
    if (!reason) return;
    const prevPhase = conv.phase;
    const prevReason = conv.disqualified_reason || null;
    conv.phase = 'disqualified';
    conv.disqualified_reason = reason;
    _replaceRightPane();
    const r = await _patchConv(conv.id, { phase: 'disqualified', disqualified_reason: reason });
    if (!r.ok) {
      conv.phase = prevPhase; conv.disqualified_reason = prevReason;
      _replaceRightPane();
      _toast(r.error || 'Kon niet bijwerken', 'error');
      return;
    }
    const listRow = _live.convs.items.find(c => String(c.id) === String(conv.id));
    if (listRow) listRow.phase = 'disqualified';
    _toast('Gemarkeerd als disqualified.', 'success');
    _replaceRightPane();
    _repaintListRow(conv.id);
  };
  window.__lisaTogglePause = async () => {
    const conv = _thread.conversation;
    if (!conv) return;
    const next = !conv.followup_paused;
    const ok = await _askConfirm(
      next ? 'Pauzeer follow-ups?' : 'Hervat follow-ups?',
      next
        ? 'Lisa stopt met geplande follow-up-berichten voor dit gesprek. Manuele antwoorden blijven mogelijk.'
        : 'Lisa mag weer follow-ups sturen voor dit gesprek.',
      { okLabel: next ? 'Pauzeer' : 'Hervat' }
    );
    if (!ok) return;
    const prev = conv.followup_paused;
    conv.followup_paused = next; _replaceRightPane();
    const r = await _patchConv(conv.id, { followup_paused: next });
    if (!r.ok) {
      conv.followup_paused = prev; _replaceRightPane();
      _toast(r.error || 'Kon niet bijwerken', 'error');
      return;
    }
    _toast(next ? 'Follow-ups gepauzeerd.' : 'Follow-ups hervat.', 'success');
    _replaceRightPane();
  };
  window.__lisaToggleTakeover = async () => {
    const conv = _thread.conversation;
    if (!conv) return;
    const next = !conv.human_takeover;
    const ok = await _askConfirm(
      next ? 'Mens-overname aanzetten?' : 'Mens-overname uitzetten?',
      next
        ? 'Lisa antwoordt vanaf nu NIET meer autonoom in dit gesprek. Alle reacties komen van jou.'
        : 'Lisa mag weer autonoom antwoorden op nieuwe inbound berichten in dit gesprek.',
      { okLabel: next ? 'Zet aan' : 'Zet uit' }
    );
    if (!ok) return;
    const prev = conv.human_takeover;
    conv.human_takeover = next; _replaceRightPane();
    const r = await _patchConv(conv.id, { human_takeover: next });
    if (!r.ok) {
      conv.human_takeover = prev; _replaceRightPane();
      _toast(r.error || 'Kon niet bijwerken', 'error');
      return;
    }
    const listRow = _live.convs.items.find(c => String(c.id) === String(conv.id));
    if (listRow) listRow.human_takeover = next;
    _toast(next ? 'Mens neemt over.' : 'Lisa is weer actief.', 'success');
    _replaceRightPane();
    _repaintListRow(conv.id);
  };

  /* ── Boekingslink versturen ────────────────────────────────────────── */
  async function _fetchBookingUrl() {
    if (_booking.fetched || _booking.loading) return;
    _booking.loading = true;
    const j = await tryFetch('booking-url', '/api/lisa-booking-url');
    _booking.loading = false;
    _booking.fetched = true;
    if (j && !j.error) {
      _booking.url = j.url || null;
      _booking.configured = !!j.configured;
    }
  }
  window.__lisaSendBookingLink = async () => {
    const conv = _thread.conversation;
    if (!conv) { _toast('Geen conversatie geladen.', 'error'); return; }
    if (conv.is_sandbox) { _toast('Sandbox-conversatie — reageren uitgeschakeld.', 'error'); return; }
    // Lazy-fetch bij eerste klik (endpoint is snel + admin-only).
    if (!_booking.fetched) await _fetchBookingUrl();
    if (!_booking.configured || !_booking.url) {
      _openModal(`
        <div style="font-size:15.5px;font-weight:600;margin-bottom:8px">Agenda-link nog niet ingesteld</div>
        <div style="font-size:13px;color:var(--text-2);line-height:1.55;margin-bottom:14px">
          Er is nog geen boekings-URL geconfigureerd voor Lisa. Zet in <strong>Vercel &rarr; Project Settings &rarr; Environment Variables</strong> de env-var
          <code style="background:var(--surface-2);padding:1px 6px;border-radius:4px">LISA_BOOKING_URL</code>
          op alle environments (Production / Preview / Development). Bijvoorbeeld:
        </div>
        <div style="padding:10px 12px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r-sm);font-family:'IBM Plex Mono',monospace;font-size:12px;margin-bottom:14px">
          LISA_BOOKING_URL=https://agenda.deforexopleiding.nl/dave-15min
        </div>
        <div style="font-size:12.5px;color:var(--text-3);line-height:1.55;margin-bottom:14px">
          Na redeploy verschijnt de link hier automatisch. Voor nu kan je een link handmatig plakken in het compose-veld hieronder.
        </div>
        <div style="display:flex;justify-content:flex-end">
          <button class="btn btn-primary btn-sm" style="background:var(--brand,#0A7490);border-color:var(--brand,#0A7490);color:#fff" onclick="document.getElementById('lisaModalRoot')?.remove()">OK</button>
        </div>`);
      return;
    }
    // Prefill compose met een korte standaard-zin + de link. User bewerkt en
    // verstuurt via de bestaande __lisaSend flow (confirm-modal = de stop).
    const firstName = (String(conv.contact_name || '').trim().split(/\s+/)[0]) || '';
    const opener = firstName ? `Top ${firstName}!` : 'Top!';
    const prefill = `${opener} Plan hier een moment dat jou uitkomt: ${_booking.url}`;
    _compose.text = prefill;
    // v=5: direct de textarea zetten zonder DFO.render() zodat de lijst-
    // scroll (en de rest van de UI) niet omgeklapt worden.
    const ta = document.getElementById('lisaComposeInput');
    if (ta) {
      ta.value = prefill;
      ta.focus();
      try { ta.setSelectionRange(prefill.length, prefill.length); } catch (_) {}
      ta.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
    _updateSendBtn();
    _toast('Standaardtekst ingevuld — bewerken kan; klik Verstuur om te versturen.', 'info');
  };

  // v=6: 'Afspraak inschieten' free-slots-picker + lisa-appointment-create
  // aanroep verwijderd. Boekingsflow loopt nu uitsluitend via 'Stuur
  // boekingslink' (prefill compose met LISA_BOOKING_URL). Zie header-comment.
  // Endpoint api/lisa-appointment-create.js blijft dormant in de repo staan;
  // de additieve free-slots permissie 'lisa.config.publish' in
  // api/follow-up-ghl-free-slots.js idem — geen actieve caller vanuit deze UI.

  /* ── Poll 18s ────────────────────────────────────────────────────────── */
  function _startPoll() {
    if (_poll.handle) return;
    _poll.handle = setInterval(_pollTick, _poll.intervalMs);
  }
  function _stopPoll() {
    if (_poll.handle) { clearInterval(_poll.handle); _poll.handle = null; }
  }
  async function _pollTick() {
    if (_poll.running) return;
    if (!document.querySelector('[data-lisa-view]')) { _stopPoll(); return; }
    if (document.hidden) return;
    _poll.running = true;
    try {
      if (document.querySelector('.lisa-gesp-split')) {
        const url = '/api/lisa-conversations?action=list_live&status=' + encodeURIComponent(_live.convs.statusFilter || 'active') + '&limit=100';
        const j = await tryFetch('poll-convs', url);
        if (j && Array.isArray(j.conversations)) {
          const hashOld = _live.convs.items.map(x => [x.id, x.last_message_at || '', x.phase, x.preview || ''].join('|')).join('||');
          const items = j.conversations;
          const hashNew = items.map(x => [x.id, x.last_message_at || '', x.phase, x.preview || ''].join('|')).join('||');
          if (hashOld !== hashNew) {
            _live.convs.items = items;
            // v=7: scroll-container is #lisaConvListBody (was #lisaConvList).
            // Ook surgical repaint i.p.v. DFO.render — behoudt zoekveld-focus
            // + toolbar-node intact.
            const bodyEl = document.getElementById('lisaConvListBody');
            const savedScroll = bodyEl ? bodyEl.scrollTop : 0;
            _repaintListBody();
            requestAnimationFrame(() => {
              const el = document.getElementById('lisaConvListBody');
              if (el) el.scrollTop = savedScroll;
            });
          }
        }
        if (_thread.convId) {
          const t = await tryFetch('poll-thread', '/api/lisa-conversations?id=' + encodeURIComponent(_thread.convId));
          if (t && Array.isArray(t.messages)) {
            const seen = new Set(_thread.messages.map(m => String(m.id)));
            const additions = t.messages.filter(m => !seen.has(String(m.id)));
            if (additions.length) {
              _thread.messages = _thread.messages.concat(additions);
              _paintThread();
            }
          }
        }
      }
    } catch (e) { console.warn('[lisa-v2] poll error:', e && e.message); }
    finally { _poll.running = false; }
  }

  /* ── Thread paint ──────────────────────────────────────────────────── */
  function _paintThread() {
    const container = document.getElementById('lisaThreadScroll');
    if (!container) return;
    if (!_thread.convId) { container.innerHTML = ''; return; }
    const isNewConv = _thread._paintedFor !== _thread.convId;
    if (isNewConv) {
      container.innerHTML = _thread.messages.map(_renderMsg).join('');
      _thread._paintedFor = _thread.convId;
      container.scrollTop = container.scrollHeight;
      return;
    }
    const seenIds = new Set();
    container.querySelectorAll('[data-msg-id]').forEach(el => seenIds.add(el.getAttribute('data-msg-id')));
    const additions = _thread.messages.filter(m => !seenIds.has(String(m.id)));
    if (!additions.length) return;
    const nearBottom = (container.scrollHeight - container.scrollTop - container.clientHeight) < 40;
    container.insertAdjacentHTML('beforeend', additions.map(_renderMsg).join(''));
    if (nearBottom) container.scrollTop = container.scrollHeight;
  }
  function _renderMsg(m) {
    const isOut = m.direction === 'out';
    const isSys = !!m.is_system;
    if (isSys) {
      return `<div data-msg-id="${esc(String(m.id))}" style="text-align:center;margin:8px 0;font-size:11px;color:var(--text-3);font-style:italic">${esc(m.content || '')} <span style="opacity:.55">· ${esc(_fmtTijd(m.sent_at))}</span></div>`;
    }
    const align = isOut ? 'right' : 'left';
    const bg = isOut ? 'var(--brand-soft,#E2F1F5)' : 'var(--surface-2)';
    const color = isOut ? 'var(--brand,#0A7490)' : 'var(--text-1)';
    const radius = isOut ? '14px 14px 4px 14px' : '14px 14px 14px 4px';
    const badges = [];
    if (m.ai_generated) badges.push('<span style="display:inline-block;font-size:9.5px;line-height:1;padding:1px 5px;border-radius:6px;background:var(--violet-soft,#EDE4FA);color:var(--violet,#6D3FD4);font-weight:600;letter-spacing:.04em">AI</span>');
    if (m.human_override) badges.push('<span style="display:inline-block;font-size:9.5px;line-height:1;padding:1px 5px;border-radius:6px;background:var(--emerald-soft);color:var(--emerald);font-weight:600;letter-spacing:.04em">mens</span>');
    if (m.is_followup) badges.push('<span style="display:inline-block;font-size:9.5px;line-height:1;padding:1px 5px;border-radius:6px;background:var(--amber-soft);color:var(--amber);font-weight:600;letter-spacing:.04em">follow-up</span>');
    const body = esc(m.content || '');
    const at = m.sent_at ? esc(_fmtTijd(m.sent_at)) : '';
    return `<div data-msg-id="${esc(String(m.id))}" style="text-align:${align};margin-bottom:6px"><span style="display:inline-block;text-align:left;max-width:70%;padding:7px 11px;background:${bg};color:${color};border-radius:${radius};font-size:13.5px;line-height:1.4;vertical-align:top">${badges.length ? `<div style="margin-bottom:3px">${badges.join(' ')}</div>` : ''}<div style="white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere">${body || '<span style="opacity:.55">(leeg)</span>'}</div><div style="font-size:10px;opacity:.5;font-family:\\'IBM Plex Mono\\',monospace;margin-top:3px;text-align:right">${at}${m.detected_phase ? ' · ' + esc(m.detected_phase) : ''}</div></span></div>`;
  }
  function _fmtTijd(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      const delta = Date.now() - d.getTime();
      if (delta < 3600000) return Math.max(1, Math.round(delta / 60000)) + 'm';
      if (delta < 86400000) return Math.round(delta / 3600000) + 'u';
      if (delta < 7 * 86400000) return Math.round(delta / 86400000) + 'd';
      return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
    } catch (_) { return '—'; }
  }
  function _inOfficeHours(settings) {
    if (!settings) return null;
    const start = settings.office_hours_start || '09:00';
    const end   = settings.office_hours_end   || '18:00';
    const tz    = settings.office_hours_timezone || 'Europe/Amsterdam';
    try {
      const now = new Date();
      const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
      return time >= start && time <= end;
    } catch (_) { return null; }
  }

  /* ══════════════════════════════════════════════════════════════════
     TAB 1 — DASHBOARD (ongewijzigd t.o.v. v=2)
     ══════════════════════════════════════════════════════════════════ */
  function dashboardView() {
    if (!_live.stats.fetched && !_live.stats.loading && !_live.stats.error) queueMicrotask(() => _fetchStats('week'));
    if (!_live.settings.fetched && !_live.settings.loading && !_live.settings.error) queueMicrotask(_fetchSettings);
    if (!_live.logs.fetched && !_live.logs.loading && !_live.logs.error) queueMicrotask(_fetchLogs);
    queueMicrotask(_startPoll);

    const stats = _live.stats.data;
    const settings = _live.settings.data;
    const logs = _live.logs.data;
    const liveOn = settings && !!settings.live_mode_enabled;
    const inOffice = _inOfficeHours(settings);
    const officeText = settings
      ? `${esc(settings.office_hours_start || '?')}-${esc(settings.office_hours_end || '?')} ${esc(settings.office_hours_timezone || 'Europe/Amsterdam')}`
      : '—';
    const activeStatus = liveOn
      ? (inOffice === false ? 'buiten kantooruren (queued)' : 'antwoordt autonoom')
      : 'stil (uit)';
    const liveBadgeColor = liveOn ? (inOffice === false ? 'amber' : 'emerald') : 'rose';
    const liveBadge = `<span style="display:inline-block;font-size:11px;padding:3px 10px;border-radius:12px;background:var(--${liveBadgeColor}-soft);color:var(--${liveBadgeColor});font-weight:600">${liveOn ? '● LIVE' : '● UIT'}</span>`;

    const kpiCell = (label, val, sub, color) => `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px 16px">
        <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);margin-bottom:6px">${esc(label)}</div>
        <div style="font-size:24px;font-weight:600;letter-spacing:-.02em;color:var(--${color || 'text-1'})">${val == null ? '<span style="opacity:.4">…</span>' : esc(String(val))}</div>
        ${sub ? `<div style="font-size:11.5px;color:var(--text-3);margin-top:4px">${esc(sub)}</div>` : ''}
      </div>`;

    const t = stats && stats.totals ? stats.totals : {};
    const f = stats && stats.conversion_funnel ? stats.conversion_funnel : {};
    const kpiHtml = `
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px">
        ${kpiCell('Gesprekken (7d)', t.conversations, 'nieuw + doorlopend', 'text-1')}
        ${kpiCell('Gekwalificeerd', t.qualified, f.qualified_pct != null ? f.qualified_pct + '%' : null, 'emerald')}
        ${kpiCell('Call geboekt', t.call_booked, f.booked_pct != null ? f.booked_pct + '%' : null, 'blue')}
        ${kpiCell('Berichten in/uit', (t.messages_in != null && t.messages_out != null) ? (t.messages_in + ' / ' + t.messages_out) : null, 'binnen / verstuurd', 'text-1')}
      </div>`;
    const errBanner = (msg, what) => `<div style="padding:12px 14px;background:var(--rose-soft);border:1px solid var(--rose-line);border-radius:var(--r-sm);color:var(--rose);font-size:12.5px;margin-bottom:12px">⚠ ${esc(msg)} <button class="btn btn-ghost btn-sm" style="margin-left:8px;font-size:11px" onclick="__lisaRetry('${what}')">Opnieuw</button></div>`;
    const statusBlock = _live.settings.error
      ? errBanner(_live.settings.error, 'settings')
      : `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:16px 18px;margin-bottom:14px">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">
            <div style="font-weight:600;font-size:14px">Lisa — Appointmentsetter</div>
            ${liveBadge}
            <span style="font-size:12px;color:var(--text-3);margin-left:auto">${esc(activeStatus)}</span>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;font-size:12.5px">
            <div><div style="color:var(--text-3);font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px">Live-modus</div><div style="font-weight:500">${liveOn ? 'AAN' : 'UIT'} <span style="font-size:11px;color:var(--text-3);font-weight:400">— toggle via Agents-module</span></div></div>
            <div><div style="color:var(--text-3);font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px">Kantooruren</div><div style="font-weight:500">${officeText}</div></div>
            <div><div style="color:var(--text-3);font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px">Nu binnen?</div><div style="font-weight:500;color:var(--${inOffice === true ? 'emerald' : inOffice === false ? 'amber' : 'text-3'})">${inOffice == null ? '—' : (inOffice ? 'ja' : 'nee (buiten venster, wachtrij)')}</div></div>
          </div>
        </div>`;
    const recentActivity = logs && (logs.webhook_events || logs.cron_events)
      ? `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:16px 18px">
          <div style="font-weight:600;font-size:14px;margin-bottom:10px">Recente activiteit</div>
          ${(asArr(logs.webhook_events).slice(0, 8)).map(e => `<div style="padding:7px 0;border-bottom:1px solid var(--border);font-size:12.5px;display:flex;gap:10px;align-items:center">
            <span style="font-size:10.5px;padding:1px 6px;border-radius:6px;background:var(--teal-soft);color:var(--teal);font-weight:600">IN</span>
            <span style="flex:1;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc((e.content || '').slice(0, 100))}</span>
            <span style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-3)">${esc(_fmtTijd(e.sent_at))}</span>
          </div>`).join('') || `<div style="padding:16px;text-align:center;color:var(--text-3);font-size:12.5px">Nog geen webhook-events.</div>`}
          ${asArr(logs.cron_events).slice(0, 5).map(e => `<div style="padding:7px 0;border-bottom:1px solid var(--border);font-size:12.5px;display:flex;gap:10px;align-items:center">
            <span style="font-size:10.5px;padding:1px 6px;border-radius:6px;background:var(--${e.status === 'sent' ? 'emerald' : 'amber'}-soft);color:var(--${e.status === 'sent' ? 'emerald' : 'amber'});font-weight:600">${esc((e.status || '?').toUpperCase())}</span>
            <span style="flex:1;color:var(--text-2)">${e.is_delayed_response ? 'Vertraagd antwoord' : (e.is_regular_followup ? 'Follow-up' : 'Cron-event')}${e.cancelled_reason ? ' · ' + esc(e.cancelled_reason) : ''}</span>
            <span style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-3)">${esc(_fmtTijd(e.sent_at))}</span>
          </div>`).join('')}
        </div>`
      : _live.logs.error ? errBanner(_live.logs.error, 'logs') : `<div style="padding:22px;text-align:center;color:var(--text-3);font-size:13px">${_live.logs.loading ? 'Activiteit laden…' : 'Nog geen activiteit.'}</div>`;

    return `<div data-lisa-view="dashboard">
      ${_live.stats.error ? errBanner(_live.stats.error, 'stats') : ''}
      ${statusBlock}
      ${_live.stats.loading && !stats ? renderSkeletonKpis() : kpiHtml}
      ${recentActivity}
    </div>`;
  }

  /* ══════════════════════════════════════════════════════════════════
     TAB 2 — GESPREKKEN (BROK 2 writes)
     ══════════════════════════════════════════════════════════════════ */
  function gesprekkenView() {
    if (!_live.convs.fetched && !_live.convs.loading && !_live.convs.error) queueMicrotask(_fetchConvs);
    if (!_booking.fetched && !_booking.loading && !_booking.error) queueMicrotask(_fetchBookingUrl);
    queueMicrotask(_startPoll);
    queueMicrotask(_paintThread);
    queueMicrotask(_updateSendBtn);

    const st = _live.convs;
    const rows = asArr(st.items);
    const sel  = rows.find(r => String(r.id) === String(_thread.convId)) || rows[0] || null;
    if (sel && (!_thread.conversation || String(_thread.conversation.id) !== String(sel.id)) && !_thread.loading) {
      queueMicrotask(() => _loadThread(sel.id));
    }

    const filter = st.statusFilter || 'active';
    const filterChips = ['active', 'qualified', 'disqualified', 'cold', 'all'].map(v => {
      const label = v === 'active' ? 'Actief' : v === 'qualified' ? 'Gekwal.' : v === 'disqualified' ? 'Disq.' : v === 'cold' ? 'Cold' : 'Alle';
      return `<button class="chip ${filter === v ? 'on' : ''}" style="font-size:11.5px;padding:3px 10px" onclick="__lisaSetStatus('${v}')">${label}</button>`;
    }).join('');

    const listHtml = st.loading && !rows.length
      ? renderSkeletonRows(6)
      : rows.length
        ? rows.map(_renderConvRow).join('')
        : `<div style="padding:44px 20px;text-align:center;color:var(--text-3);font-size:13px">${st.error ? '⚠ ' + esc(st.error) : (String(st.q || '').trim() ? 'Geen gesprekken die op "' + esc(st.q) + '" matchen.' : 'Geen gesprekken in dit filter.')} ${st.error ? `<button class="btn btn-ghost btn-sm" onclick="__lisaRetry('convs')" style="margin-left:8px">Opnieuw</button>` : ''}</div>`;

    const qVal = String(st.q || '');
    const qHasVal = qVal.trim().length > 0;
    // Zoekveld: uncontrolled input (defaultValue = 'value' attr, oninput
    // is state-only → focus/cursor blijft tijdens typen). Wis-knopje
    // rechts binnen het input-blok. Zelfde violet-tint als de rest.
    const searchBar = `
      <div style="position:relative">
        <input id="lisaSearchInput" type="text" value="${esc(qVal)}"
          oninput="__lisaSearchInput(this.value)"
          placeholder="Zoek op naam of @handle…"
          style="width:100%;padding:6px 28px 6px 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);color:var(--text-1);font-size:12px;outline:none;box-sizing:border-box"
          autocomplete="off" spellcheck="false" />
        <button id="lisaSearchClear" title="Wis zoekterm"
          onclick="__lisaSearchClear()"
          style="position:absolute;top:50%;right:6px;transform:translateY(-50%);width:20px;height:20px;padding:0;border:0;background:transparent;color:var(--text-3);font-size:14px;cursor:pointer;visibility:${qHasVal ? 'visible' : 'hidden'}">×</button>
      </div>`;

    return `<div data-lisa-view="gesprekken" class="lisa-gesp-split" style="display:flex;height:calc(100vh - 200px);min-height:520px;border:1px solid var(--border);border-radius:var(--r);overflow:hidden;background:var(--surface)">
      <div id="lisaConvList" style="width:360px;min-width:280px;max-width:40%;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column">
        <div style="padding:11px 14px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:8px;flex-shrink:0">
          ${searchBar}
          <div style="display:flex;gap:5px;flex-wrap:wrap">${filterChips}</div>
          <div style="font-size:11.5px;color:var(--text-3);display:flex;justify-content:space-between">
            <span id="lisaConvListCount">${rows.length} gesprek${rows.length === 1 ? '' : 'ken'}${qHasVal ? ' · zoekterm actief' : ''}</span>
            ${st.loading ? '<span>laden…</span>' : ''}
          </div>
        </div>
        <div id="lisaConvListBody" style="flex:1;overflow-y:auto;min-height:0">${listHtml}</div>
      </div>
      ${sel
        ? _renderConvDetail(sel)
        : `<div class="lisa-gesp-right" style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-3);font-size:13px">Selecteer een gesprek</div>`}
    </div>`;
  }
  function _renderConvRow(c) {
    const name = c.contact_name || c.instagram_handle || 'Onbekend';
    const handle = c.instagram_handle ? '@' + String(c.instagram_handle).replace(/^@/, '') : '';
    const rowIdAttr  = String(c.id).replace(/"/g, '&quot;');
    const rowIdClick = String(c.id).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const onCls = String(_thread.convId) === String(c.id) ? 'on' : '';
    const phaseColor = c.qualified ? 'emerald' : (c.phase === 'disqualified' ? 'rose' : c.phase === 'cold' ? 'text-3' : 'blue');
    const takeoverBadge = c.human_takeover ? `<span style="font-size:9.5px;padding:1px 5px;border-radius:6px;background:var(--amber-soft);color:var(--amber);font-weight:600">MENS</span>` : '';
    const bookedBadge = c.call_booked ? `<span style="font-size:9.5px;padding:1px 5px;border-radius:6px;background:var(--emerald-soft);color:var(--emerald);font-weight:600">CALL</span>` : '';
    return `<div class="lisa-conv-row ${onCls}" data-row-id="${rowIdAttr}" onclick="__lisaSelConv('${rowIdClick}')"
      style="display:flex;gap:10px;padding:11px 14px;border-bottom:1px solid var(--border);cursor:pointer;${onCls === 'on' ? 'background:var(--surface-2)' : ''}">
      ${H.av(name || '?', 34)}
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:2px">
          <span style="font-size:13.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</span>
          <span style="margin-left:auto;font-size:10.5px;font-family:'IBM Plex Mono',monospace;color:var(--text-3);flex-shrink:0">${esc(_fmtTijd(c.last_message_at))}</span>
        </div>
        <div style="font-size:12.5px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.preview || '—')}</div>
        <div style="font-size:11px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(handle)}</div>
        <div style="margin-top:6px;display:flex;gap:5px;align-items:center;flex-wrap:wrap">
          <span style="font-size:9.5px;padding:1px 5px;border-radius:6px;background:var(--${phaseColor}-soft,var(--surface-2));color:var(--${phaseColor});font-weight:600">${esc(c.phase || '—')}</span>
          ${takeoverBadge}
          ${bookedBadge}
        </div>
      </div>
    </div>`;
  }
  function _renderConvDetail(row) {
    // Prefer full thread-conversation als geladen (heeft is_sandbox, ghl_contact_id).
    const conv = (_thread.conversation && String(_thread.conversation.id) === String(row.id))
      ? _thread.conversation : row;
    const name   = conv.contact_name || conv.instagram_handle || 'Onbekend';
    const handle = conv.instagram_handle ? '@' + String(conv.instagram_handle).replace(/^@/, '') : '';
    const isSandbox = !!conv.is_sandbox;

    const takeoverBanner = conv.human_takeover
      ? `<div style="padding:8px 14px;background:var(--amber-soft);color:var(--amber);font-size:11.5px;border-bottom:1px solid var(--border);font-weight:500">⚠ Mens heeft dit gesprek overgenomen — Lisa antwoordt niet meer autonoom.</div>`
      : '';
    const bookedBanner = conv.call_booked
      ? `<div style="padding:8px 14px;background:var(--emerald-soft);color:var(--emerald);font-size:11.5px;border-bottom:1px solid var(--border);font-weight:500">✓ Call is geboekt via deze conversatie.</div>`
      : '';
    const sandboxBanner = isSandbox
      ? `<div style="padding:8px 14px;background:var(--violet-soft,#EDE4FA);color:var(--violet,#6D3FD4);font-size:11.5px;border-bottom:1px solid var(--border);font-weight:500">🧪 Sandbox — geen echte klant. Reageren en afspraken zijn uitgeschakeld.</div>`
      : '';

    // Fase-opties (dropdown)
    const PHASES = ['intro', 'doel', 'situatie', 'band', 'call', 'qualified', 'disqualified', 'done', 'cold'];
    const phaseOpts = PHASES.map(p => `<option value="${p}" ${conv.phase === p ? 'selected' : ''}>${p}</option>`).join('');

    // Actie-knoppen in de header
    const actionButtons = !isSandbox ? `
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
        <select id="lisaPhaseSelect" onchange="__lisaSetPhase(this.value)" style="font-size:11.5px;padding:5px 8px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);color:var(--text-1);cursor:pointer" title="Fase wijzigen">${phaseOpts}</select>
        <button class="btn btn-ghost btn-sm" style="font-size:11.5px" onclick="__lisaToggleQualified()" title="Markeer/verwijder gekwalificeerd">${conv.qualified ? '✓ Gekwal.' : 'Kwalificeer'}</button>
        <button class="btn btn-ghost btn-sm" style="font-size:11.5px" onclick="__lisaMarkDisqualified()" title="Markeer als disqualified">Disq.</button>
        <button class="btn btn-ghost btn-sm" style="font-size:11.5px" onclick="__lisaTogglePause()" title="Pauzeer/hervat follow-ups">${conv.followup_paused ? '▶ Hervat FU' : '⏸ Pauzeer FU'}</button>
        <button class="btn btn-ghost btn-sm" style="font-size:11.5px" onclick="__lisaToggleTakeover()" title="Mens-overname aan/uit">${conv.human_takeover ? 'Lisa terug' : 'Mens over'}</button>
        <button class="btn btn-primary btn-sm" style="font-size:11.5px;background:var(--brand,#0A7490);border-color:var(--brand,#0A7490);color:#fff" onclick="__lisaSendBookingLink()" title="Prefill compose met agenda-link zodat de volger zelf boekt">🔗 Stuur boekingslink</button>
      </div>` : '';

    const status = _thread.loading
      ? `<div style="padding:22px;color:var(--text-3);font-size:13px">Berichten laden…</div>`
      : _thread.error
        ? `<div style="padding:22px;color:var(--rose);font-size:13px">⚠ ${esc(_thread.error)} <button class="btn btn-ghost btn-sm" onclick="__lisaRetry('thread')" style="margin-left:8px">Opnieuw</button></div>`
        : (!_thread.messages.length && _thread._paintedFor === row.id)
          ? `<div style="padding:22px;color:var(--text-3);font-size:13px;text-align:center">Nog geen berichten.</div>`
          : '';

    // Compose footer (DEEL A)
    const composeDisabled = isSandbox;
    const composeHint = isSandbox
      ? `<span style="color:var(--violet,#6D3FD4);font-weight:500">Sandbox — reageren uitgeschakeld.</span>`
      : `<span>Reageren zet Lisa uit voor dit gesprek (human takeover).</span>`;
    const composeFooter = `
      <div style="padding:11px 14px;background:var(--surface-2);border-top:1px solid var(--border)">
        <div style="display:flex;gap:8px;align-items:flex-end">
          <textarea id="lisaComposeInput" oninput="__lisaComposeInput(this)" placeholder="${composeDisabled ? 'Sandbox — reageren uitgeschakeld' : 'Typ een IG-DM…'}" ${composeDisabled ? 'disabled' : ''}
            style="flex:1;min-height:56px;max-height:200px;padding:9px 11px;border:1px solid var(--border);border-radius:var(--r-sm);font:inherit;font-size:13px;background:var(--surface);color:var(--text-1);resize:vertical;line-height:1.4">${esc(_compose.text || '')}</textarea>
          <button id="lisaSendBtn" class="btn btn-primary btn-sm" style="background:var(--brand,#0A7490);border-color:var(--brand,#0A7490);color:#fff;padding:8px 16px;font-weight:600" ${composeDisabled ? 'disabled' : ''} onclick="__lisaSend()">Verstuur</button>
        </div>
        <div style="margin-top:6px;font-size:11px;color:var(--text-3)">${composeHint}</div>
      </div>`;

    return `<div class="lisa-gesp-right" style="display:flex;flex-direction:column;min-height:0;flex:1;background:var(--surface)">
      <div style="padding:14px 20px;background:var(--surface);border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:13px;margin-bottom:${!isSandbox ? '10px' : '0'}">
          ${H.av(name || '?', 42)}
          <div style="flex:1;min-width:0">
            <div style="font-size:16px;font-weight:600;letter-spacing:-.02em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</div>
            <div style="font-size:12.5px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(handle)}${conv.source ? ' · via ' + esc(conv.source) : ''}${conv.phase ? ' · fase: ' + esc(conv.phase) : ''}</div>
          </div>
        </div>
        ${actionButtons}
      </div>
      ${sandboxBanner}
      ${takeoverBanner}
      ${bookedBanner}
      <div id="lisaThreadScroll" style="flex:1;min-height:0;overflow-y:auto;padding:20px;display:block"></div>
      ${status}
      ${composeFooter}
    </div>`;
  }

  /* ══════════════════════════════════════════════════════════════════
     TAB 3 — STATISTIEKEN (ongewijzigd t.o.v. v=2)
     ══════════════════════════════════════════════════════════════════ */
  function statsView() {
    const period = _live.stats.period || 'week';
    if (!_live.statsAll[period] && !_live.stats.loading && !_live.stats.error) queueMicrotask(() => _fetchStats(period));
    queueMicrotask(_startPoll);
    const stats = _live.statsAll[period] || _live.stats.data;
    const errBanner = (msg) => `<div style="padding:12px 14px;background:var(--rose-soft);border:1px solid var(--rose-line);border-radius:var(--r-sm);color:var(--rose);font-size:12.5px;margin-bottom:12px">⚠ ${esc(msg)} <button class="btn btn-ghost btn-sm" style="margin-left:8px" onclick="__lisaRetry('stats')">Opnieuw</button></div>`;
    const periodChips = ['today', 'week', 'month', 'all'].map(p => {
      const label = p === 'today' ? 'Vandaag' : p === 'week' ? 'Week' : p === 'month' ? '30 dagen' : 'Alles';
      return `<button class="chip ${period === p ? 'on' : ''}" style="font-size:11.5px;padding:3px 10px" onclick="__lisaSetStatsPeriod('${p}')">${label}</button>`;
    }).join('');
    const t = stats && stats.totals ? stats.totals : {};
    const f = stats && stats.conversion_funnel ? stats.conversion_funnel : {};
    const phaseDist = stats && stats.phase_distribution ? stats.phase_distribution : {};
    const disq = stats && Array.isArray(stats.disqualified_top5) ? stats.disqualified_top5 : [];
    const fu = stats && stats.followups ? stats.followups : {};
    const kpi = (label, val, sub, color) => `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px 16px">
        <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);margin-bottom:6px">${esc(label)}</div>
        <div style="font-size:22px;font-weight:600;color:var(--${color || 'text-1'})">${val == null ? '<span style="opacity:.4">…</span>' : esc(String(val))}</div>
        ${sub ? `<div style="font-size:11.5px;color:var(--text-3);margin-top:4px">${esc(sub)}</div>` : ''}
      </div>`;
    const phaseRows = Object.entries(phaseDist).map(([p, n]) => [p, String(n)]);
    const phaseTable = phaseRows.length ? `<table style="width:100%;border-collapse:collapse;font-size:12.5px">
      <thead><tr style="text-align:left;color:var(--text-3);border-bottom:1px solid var(--border)">
        <th style="padding:6px 8px">Fase</th>
        <th style="padding:6px 8px" class="r">Aantal</th>
      </tr></thead>
      <tbody>
        ${phaseRows.map(([p, n]) => `<tr style="border-bottom:1px solid var(--border)"><td style="padding:6px 8px">${esc(p)}</td><td style="padding:6px 8px;text-align:right;font-family:'IBM Plex Mono',monospace">${esc(n)}</td></tr>`).join('')}
      </tbody>
    </table>` : `<div style="padding:14px;color:var(--text-3);font-size:12.5px;text-align:center">Geen fase-data.</div>`;
    const disqTable = disq.length ? `<table style="width:100%;border-collapse:collapse;font-size:12.5px">
      <thead><tr style="text-align:left;color:var(--text-3);border-bottom:1px solid var(--border)">
        <th style="padding:6px 8px">Reden</th>
        <th style="padding:6px 8px" class="r">Aantal</th>
      </tr></thead>
      <tbody>
        ${disq.map(d => `<tr style="border-bottom:1px solid var(--border)"><td style="padding:6px 8px">${esc(d.reason || d.tag || '—')}</td><td style="padding:6px 8px;text-align:right;font-family:'IBM Plex Mono',monospace">${esc(d.count != null ? d.count : (d.n != null ? d.n : '—'))}</td></tr>`).join('')}
      </tbody>
    </table>` : `<div style="padding:14px;color:var(--text-3);font-size:12.5px;text-align:center">Geen disqualified-data.</div>`;

    return `<div data-lisa-view="stats">
      ${_live.stats.error ? errBanner(_live.stats.error) : ''}
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">
        <span style="font-size:12px;color:var(--text-3)">Periode:</span>
        ${periodChips}
        ${_live.stats.loading ? '<span style="font-size:11.5px;color:var(--text-3);margin-left:auto">laden…</span>' : ''}
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px">
        ${kpi('Gesprekken',      t.conversations,          'in de periode',        'text-1')}
        ${kpi('Gekwalificeerd',  t.qualified,              f.qualified_pct != null ? f.qualified_pct + '%' : null, 'emerald')}
        ${kpi('Call geboekt',    t.call_booked,            f.booked_pct != null ? f.booked_pct + '%' : null,       'blue')}
        ${kpi('Follow-ups verzonden', fu.sent || t.followups_sent, fu.cancelled || t.followups_cancelled ? ('gec. ' + (fu.cancelled || t.followups_cancelled)) : null, 'amber')}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px 16px">
          <div style="font-weight:600;font-size:13px;margin-bottom:10px">Fase-verdeling</div>
          ${phaseTable}
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px 16px">
          <div style="font-weight:600;font-size:13px;margin-bottom:10px">Top disqualified-redenen</div>
          ${disqTable}
        </div>
      </div>
      <div style="padding:10px 14px;background:var(--surface-2);border-radius:var(--r-sm);font-size:11.5px;color:var(--text-3)">
        Bar-chart per dag komt in een aparte iteratie (voor MVP volstaan tabellen).
      </div>
    </div>`;
  }

  /* ── Skeletons ──────────────────────────────────────────────────────── */
  function renderSkeletonKpis() {
    return `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px">
      ${Array.from({ length: 4 }).map(() => `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px 16px;opacity:.55">
        <div style="height:10px;width:60%;background:var(--surface-2);border-radius:4px;margin-bottom:8px"></div>
        <div style="height:22px;width:40%;background:var(--surface-2);border-radius:4px"></div>
      </div>`).join('')}
    </div>`;
  }
  function renderSkeletonRows(n) {
    return Array.from({ length: n }).map(() => `<div style="padding:11px 14px;border-bottom:1px solid var(--border);opacity:.55">
      <div style="height:12px;width:60%;background:var(--surface-2);border-radius:4px;margin-bottom:6px"></div>
      <div style="height:11px;width:85%;background:var(--surface-2);border-radius:4px;margin-bottom:4px"></div>
      <div style="height:10px;width:40%;background:var(--surface-2);border-radius:4px"></div>
    </div>`).join('');
  }

  /* ── Registratie ────────────────────────────────────────────────────── */
  window.DFO.VIEWS['lisa/Dashboard']    = dashboardView;
  window.DFO.VIEWS['lisa/Gesprekken']   = gesprekkenView;
  window.DFO.VIEWS['lisa/Statistieken'] = statsView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('lisa');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('lisa');
  console.debug('[lisa-v2] v=7 — Zoekveld bij Gesprekken-lijst (server-side q op contact_name/instagram_handle/ghl_contact_id, debounce 300ms, wis-knop, focus-behoud via uncontrolled input + surgical #lisaConvListBody swap). Poll-tick ook naar surgical. Combineert met status-chips.');
})();
