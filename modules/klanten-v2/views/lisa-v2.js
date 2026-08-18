// modules/klanten-v2/views/lisa-v2.js
//
// Lisa (Appointmentsetter) v2 — BROK 1 (v=2, 2026-08-17): 3 read-tabs live.
// Dashboard / Gesprekken / Statistieken. Alle mock vervangen door echte
// endpoints. Geen writes in deze brok — puur zicht op Lisa's productie.
//
// Endpoints (allemaal RBAC verifyAdmin / lisa.config.*):
//   Dashboard:    GET /api/lisa-stats?period=week            (kern-KPIs)
//                 GET /api/lisa-settings                     (live-mode + office-hours)
//                 GET /api/lisa-logs?action=summary          (versies + webhook + cron)
//   Gesprekken:   GET /api/lisa-conversations?action=list_live&status=<>&limit=100
//                 GET /api/lisa-conversations?id=<uuid>      (thread + messages + feedback)
//   Statistieken: GET /api/lisa-stats?period=today|week|month|all
//
// Dashboard-safety: skeleton, 8s tryFetch-timeout, non-throwing, per-tab
// try/catch, _fetched-guard tegen render-loop.
//
// Gesprekken-safety: surgical row-highlight-swap (behoud scrollpositie),
// append-only thread-render via data-msg-id, 18s live-poll met
// document.hidden-pause + stop-detect bij tab-verlaten.
//
// Rename: nav-label 'Lisa — Appointmentsetter' (was 'Lisa — Instagram').
// Interne module-id + preview-id blijven 'lisa'.
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
    convs:    { loading: false, fetched: false, error: null, items: [], _seq: 0, statusFilter: 'active' },
    statsAll: {}, // per period cache voor Statistieken-tab
  };
  const _thread = {
    convId: null, conversation: null, messages: [], feedback: [], qualification: null,
    loading: false, error: null, _paintedFor: null, _seq: 0,
  };
  const _poll = { handle: null, running: false, intervalMs: 18000 };

  /* ── tryFetch (8s timeout, non-throwing) ────────────────────────────── */
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

  /* ── Fetchers ───────────────────────────────────────────────────────── */
  async function _fetchStats(period) {
    const st = _live.stats;
    const p = period || st.period || 'week';
    // Cache per period voor Statistieken-tab.
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
  async function _fetchConvs() {
    const st = _live.convs;
    if (st.loading) return;
    st.loading = true; st.error = null;
    const seq = ++st._seq;
    if (window.DFO?.render) window.DFO.render();
    const url = '/api/lisa-conversations?action=list_live&status=' + encodeURIComponent(st.statusFilter || 'active') + '&limit=100';
    const j = await tryFetch('convs', url);
    if (seq !== st._seq) return;
    st.loading = false; st.fetched = true;
    if (!j || j.error) st.error = (j && j.error) || 'Kon gesprekken niet laden';
    else st.items = asArr(j.conversations);
    if (window.DFO?.render) window.DFO.render();
  }
  function _resetThread() {
    _thread.convId = null; _thread.conversation = null; _thread.messages = [];
    _thread.feedback = []; _thread.qualification = null;
    _thread.loading = false; _thread.error = null; _thread._paintedFor = null;
  }
  async function _loadThread(convId) {
    if (!convId) return;
    if (_thread.convId === convId && !_thread.error) return;
    _thread.loading = true; _thread.error = null;
    _thread.convId = convId; _thread.messages = []; _thread._paintedFor = null;
    if (window.DFO?.render) window.DFO.render();
    const seq = ++_thread._seq;
    const j = await tryFetch('thread:' + convId, '/api/lisa-conversations?id=' + encodeURIComponent(convId));
    if (seq !== _thread._seq) return;
    if (_thread.convId !== convId) return;
    if (!j || j.error) {
      _thread.loading = false;
      _thread.error = (j && j.error) || 'Kon thread niet laden';
      if (window.DFO?.render) window.DFO.render();
      return;
    }
    _thread.conversation = j.conversation || null;
    _thread.messages = asArr(j.messages);
    _thread.feedback = asArr(j.feedback);
    _thread.qualification = j.qualification || null;
    _thread.loading = false;
    if (window.DFO?.render) window.DFO.render();
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
  window.__lisaSetStatsPeriod = (p) => {
    _fetchStats(p);
  };
  window.__lisaSelConv = (id) => {
    if (String(_thread.convId) === String(id)) return;
    // Surgische row-highlight-swap: behoud scrollpositie in de lijst.
    document.querySelectorAll('#lisaConvList .lisa-conv-row.on').forEach(el => el.classList.remove('on'));
    const newRow = document.querySelector('#lisaConvList .lisa-conv-row[data-row-id="' + String(id).replace(/"/g, '\\"') + '"]');
    if (newRow) newRow.classList.add('on');
    // Detail-pane vervangen.
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
    // Stop-detect: als geen Lisa-view meer in DOM → poll uit.
    if (!document.querySelector('[data-lisa-view]')) { _stopPoll(); return; }
    if (document.hidden) return;
    _poll.running = true;
    try {
      // Gesprekken-tab open? Refresh convs-lijst + open thread append-only.
      if (document.querySelector('.lisa-gesp-split')) {
        const url = '/api/lisa-conversations?action=list_live&status=' + encodeURIComponent(_live.convs.statusFilter || 'active') + '&limit=100';
        const j = await tryFetch('poll-convs', url);
        if (j && Array.isArray(j.conversations)) {
          const hashOld = _live.convs.items.map(x => [x.id, x.last_message_at || '', x.phase, x.preview || ''].join('|')).join('||');
          const items = j.conversations;
          const hashNew = items.map(x => [x.id, x.last_message_at || '', x.phase, x.preview || ''].join('|')).join('||');
          if (hashOld !== hashNew) {
            _live.convs.items = items;
            const listEl = document.getElementById('lisaConvList');
            const savedScroll = listEl ? listEl.scrollTop : 0;
            if (window.DFO?.render) window.DFO.render();
            requestAnimationFrame(() => {
              const el = document.getElementById('lisaConvList');
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

  /* ── Thread append-only paint ───────────────────────────────────────── */
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
    // Badges: ai_generated (Lisa AI) / human_override (mens)
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
  function _fmtDateAbs(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      return d.toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    } catch (_) { return '—'; }
  }

  /* ── Office-hours helper ────────────────────────────────────────────── */
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
     TAB 1 — DASHBOARD
     ══════════════════════════════════════════════════════════════════ */
  function dashboardView() {
    if (!_live.stats.fetched && !_live.stats.loading) queueMicrotask(() => _fetchStats('week'));
    if (!_live.settings.fetched && !_live.settings.loading) queueMicrotask(_fetchSettings);
    if (!_live.logs.fetched && !_live.logs.loading) queueMicrotask(_fetchLogs);
    queueMicrotask(_startPoll);

    const stats = _live.stats.data;
    const settings = _live.settings.data;
    const logs = _live.logs.data;

    // Live-mode status
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

    // Kern-KPIs uit stats
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

    // Status-blok
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

    // Recente activiteit uit logs.summary
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
     TAB 2 — GESPREKKEN
     ══════════════════════════════════════════════════════════════════ */
  function gesprekkenView() {
    if (!_live.convs.fetched && !_live.convs.loading) queueMicrotask(_fetchConvs);
    queueMicrotask(_startPoll);
    queueMicrotask(_paintThread);

    const st = _live.convs;
    const rows = asArr(st.items);
    const sel  = rows.find(r => String(r.id) === String(_thread.convId)) || rows[0] || null;
    if (sel && _thread.convId !== sel.id && !_thread.loading) {
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
        : `<div style="padding:44px 20px;text-align:center;color:var(--text-3);font-size:13px">${st.error ? '⚠ ' + esc(st.error) : 'Geen gesprekken in dit filter.'} ${st.error ? `<button class="btn btn-ghost btn-sm" onclick="__lisaRetry('convs')" style="margin-left:8px">Opnieuw</button>` : ''}</div>`;

    return `<div data-lisa-view="gesprekken" class="lisa-gesp-split" style="display:flex;height:calc(100vh - 200px);min-height:520px;border:1px solid var(--border);border-radius:var(--r);overflow:hidden;background:var(--surface)">
      <div id="lisaConvList" style="width:360px;min-width:280px;max-width:40%;background:var(--surface);border-right:1px solid var(--border);overflow-y:auto">
        <div style="padding:11px 14px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:8px">
          <div style="display:flex;gap:5px;flex-wrap:wrap">${filterChips}</div>
          <div style="font-size:11.5px;color:var(--text-3);display:flex;justify-content:space-between">
            <span>${rows.length} gesprekken</span>
            ${st.loading ? '<span>laden…</span>' : ''}
          </div>
        </div>
        ${listHtml}
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
    const name = row.contact_name || row.instagram_handle || 'Onbekend';
    const handle = row.instagram_handle ? '@' + String(row.instagram_handle).replace(/^@/, '') : '';
    const takeoverBanner = row.human_takeover
      ? `<div style="padding:8px 14px;background:var(--amber-soft);color:var(--amber);font-size:11.5px;border-bottom:1px solid var(--border);font-weight:500">⚠ Mens heeft dit gesprek overgenomen — Lisa antwoordt niet meer autonoom.</div>`
      : '';
    const bookedBanner = row.call_booked
      ? `<div style="padding:8px 14px;background:var(--emerald-soft);color:var(--emerald);font-size:11.5px;border-bottom:1px solid var(--border);font-weight:500">✓ Call is geboekt via deze conversatie.</div>`
      : '';
    const status = _thread.loading
      ? `<div style="padding:22px;color:var(--text-3);font-size:13px">Berichten laden…</div>`
      : _thread.error
        ? `<div style="padding:22px;color:var(--rose);font-size:13px">⚠ ${esc(_thread.error)} <button class="btn btn-ghost btn-sm" onclick="__lisaRetry('thread')" style="margin-left:8px">Opnieuw</button></div>`
        : (!_thread.messages.length && _thread.convId === row.id)
          ? `<div style="padding:22px;color:var(--text-3);font-size:13px">Nog geen berichten.</div>`
          : '';
    return `<div class="lisa-gesp-right" style="display:flex;flex-direction:column;min-height:0;flex:1;background:var(--surface)">
      <div style="padding:14px 20px;background:var(--surface);border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:13px">
          ${H.av(name || '?', 42)}
          <div style="flex:1;min-width:0">
            <div style="font-size:16px;font-weight:600;letter-spacing:-.02em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</div>
            <div style="font-size:12.5px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(handle)}${row.source ? ' · via ' + esc(row.source) : ''}${row.phase ? ' · fase: ' + esc(row.phase) : ''}</div>
          </div>
        </div>
      </div>
      ${takeoverBanner}
      ${bookedBanner}
      <div id="lisaThreadScroll" style="flex:1;min-height:0;overflow-y:auto;padding:20px;display:block"></div>
      ${status}
      <div style="padding:11px 20px;background:var(--surface-2);border-top:1px solid var(--border);font-size:11.5px;color:var(--text-3);text-align:center">
        Reageren vanuit deze module komt in BROK 2. Nu: lees-modus. De Inbox-module ondersteunt wel reply via <code>lisa-conversations intervene</code>.
      </div>
    </div>`;
  }

  /* ══════════════════════════════════════════════════════════════════
     TAB 3 — STATISTIEKEN
     ══════════════════════════════════════════════════════════════════ */
  function statsView() {
    const period = _live.stats.period || 'week';
    if (!_live.statsAll[period] && !_live.stats.loading) queueMicrotask(() => _fetchStats(period));
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

    // Phase-distribution als tabel
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
  console.debug('[lisa-v2] v=2 BROK 1 — 3 read-tabs bedraad (stats + settings + logs + conversations); Dashboard live-mode-status + KPI-strip + recente activiteit; Gesprekken split-view met filters + append-only thread + poll 18s; Statistieken periode-schakelaar + fase-verdeling + disqualified-top5. Reply via intervene komt in BROK 2.');
})();
