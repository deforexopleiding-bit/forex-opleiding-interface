// modules/klanten-v2/views/lisa-v2.js
//
// Fase F — Lisa (IG-agent). DATA-KOPPELING 2026-08-13. Dormant.
// QA via ?v2preview=lisa (rol Marketing/Admin).
//
// Endpoints (read-only):
//   GET /api/lisa-stats?period=month             (Dashboard/Statistieken KPI's)
//   GET /api/lisa-settings                        (Dashboard status-card)
//   GET /api/lisa-config?which=latest             (Dashboard kennisbank-count)
//   GET /api/lisa-conversations?action=list_live  (Gesprekken lijst)
//   GET /api/lisa-conversations?id=<uuid>         (Chat detail — lazy)
//
// Needs Jeffrey:
// - Chat schrijf-flow (Verstuur DM, Plak+bewerk, Intervene) → POST endpoints
//   raken Instagram-API via GHL, skip in eerste ronde.
// - "Onderwerpen top-5" (topic-tagging bestaat niet in lisa_messages).
// - "Gem. reactietijd" (niet in lisa-stats response).
// - "Bar-chart DM/dag" (geen daily buckets).
// - "Bron van DM's" waarden-shape (lisa_conversations.source labels).

(function () {
  if (!window.DFO) { console.error('[lisa-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[lisa-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, S, F } = window.DFO;
  const H = window.KV_V2.helpers;

  const asArr = (x) => Array.isArray(x) ? x : [];
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const _live = {
    stats:    { loading: false, error: null, data: null, period: 'month' },
    settings: { loading: false, error: null, data: null },
    config:   { loading: false, error: null, data: null },
    convs:    { loading: false, error: null, data: null },
    convDetail: new Map(), // id → {loading, error, data}
  };

  async function tryFetch(label, url, timeoutMs = 8000) {
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      return await Promise.race([
        window.KV.authedJson(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) { console.warn('[lisa-v2] ' + label + ' fail:', e?.message); return { __error: e?.message || 'onbekende fout' }; }
  }
  async function fetchStats(period) {
    period = period || _live.stats.period;
    const st = _live.stats;
    if (st.loading || (st.data && st.period === period)) return;
    st.loading = true; st.error = null; st.period = period; st.data = null;
    const j = await tryFetch('stats:' + period, '/api/lisa-stats?period=' + encodeURIComponent(period));
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = j || null;
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchSettings() {
    const st = _live.settings; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('settings', '/api/lisa-settings');
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = j?.settings || j || null;
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchConfig() {
    const st = _live.config; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('config', '/api/lisa-config?which=latest');
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = j?.config || j || null;
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchConvs() {
    const st = _live.convs; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('convs', '/api/lisa-conversations?action=list_live&limit=100');
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = asArr(j?.conversations);
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchConvDetail(id) {
    if (!id) return;
    let entry = _live.convDetail.get(id);
    if (entry && (entry.loading || entry.data)) return;
    entry = { loading: true, error: null, data: null };
    _live.convDetail.set(id, entry);
    if (window.DFO?.render) window.DFO.render();
    const j = await tryFetch('conv:' + id, '/api/lisa-conversations?id=' + encodeURIComponent(id));
    entry.loading = false;
    if (j && j.__error) entry.error = j.__error; else entry.data = j || null;
    if (window.DFO?.render) window.DFO.render();
  }

  window.__lisaRetry = (b) => { if (_live[b]) { _live[b].data = null; _live[b].error = null; } if (b==='stats') fetchStats(); if (b==='settings') fetchSettings(); if (b==='config') fetchConfig(); if (b==='convs') fetchConvs(); };
  window.__lisaSetPeriod = (p) => { fetchStats(p); };
  let _lisaSel = null;
  window.__lisaSel = (id) => { _lisaSel = id; queueMicrotask(() => fetchConvDetail(id)); if (window.DFO?.render) window.DFO.render(); };
  window.__lisaNotice = (l) => { console.info('[lisa-v2] ' + l); try { alert(l + ' — Instagram-write needs Jeffrey.'); } catch (_) {} };

  const errBlk = (block, msg) => `<div style="margin:20px;padding:14px 18px;border:1px solid var(--rose-line);background:var(--rose-soft);border-radius:var(--r);color:var(--rose);font-size:13px;display:flex;align-items:center;gap:12px">
    <span>${svg(I.alert || I.warn, 'width:16px;height:16px')}</span>
    <span style="flex:1">Kon ophalen: ${esc(msg)}</span>
    <button class="btn btn-ghost btn-sm" onclick="__lisaRetry('${block}')">Opnieuw</button></div>`;
  const skel = () => `<div class="pad"><div class="card"><div class="card-body" style="padding:22px;opacity:.55"><div style="height:12px;background:var(--surface-2);border-radius:4px;width:60%;margin-bottom:12px"></div></div></div></div>`;
  const nj = (r) => `<div style="margin:20px;padding:14px 18px;border:1px solid var(--amber-line);background:var(--amber-soft);border-radius:var(--r);color:var(--amber);font-size:12.5px"><b>Needs Jeffrey</b> — ${esc(r)}</div>`;

  // ── VIEW: Dashboard ──────────────────────────────────────────────────
  function dashboardView() {
    if (!_live.stats.data && !_live.stats.loading && !_live.stats.error) queueMicrotask(() => fetchStats('month'));
    if (!_live.settings.data && !_live.settings.loading && !_live.settings.error) queueMicrotask(fetchSettings);
    if (!_live.config.data && !_live.config.loading && !_live.config.error) queueMicrotask(fetchConfig);
    if (_live.stats.error && !_live.stats.data) return errBlk('stats', _live.stats.error);
    if (_live.stats.loading && !_live.stats.data) return skel();
    const s = _live.stats.data || {};
    const set = _live.settings.data || {};
    const cfg = _live.config.data || {};
    const msgTotal = Number(s.messages?.total || 0);
    const msgAi = Number(s.messages?.ai_generated || 0);
    const ratioPct = msgTotal > 0 ? Math.round((msgAi / msgTotal) * 100) : 0;
    const kbCount = (asArr(cfg.kb_products).length || 0) + (asArr(cfg.kb_faq).length || 0) + (asArr(cfg.kb_usps).length || 0);
    return `${H.kpis([
      { c: 'violet',  icon: I.chat,   label: "DM's 30d",           val: String(msgTotal), sub: 'totaal berichten' },
      { c: 'emerald', icon: I.tick,   label: 'Auto-antwoord ratio', val: ratioPct + '%', hi: 1, sub: msgAi + ' AI / ' + msgTotal + ' totaal' },
      { c: 'blue',    icon: I.cal,    label: 'Leads → gesprek',    val: String(Number(s.qualified || 0)), sub: 'gekwalificeerd' },
      { c: 'amber',   icon: I.clock,  label: 'Gem. reactietijd',   val: '—', sub: 'needs Jeffrey', hi: 1 },
    ])}
    <div class="pad" style="padding-top:16px">
      <div class="card">
        <div class="card-head"><span class="tile-ico" style="background:var(--violet-soft);color:var(--violet)">${svg(I.bot)}</span>
          <div class="card-title">Status</div></div>
        <div class="card-body" style="padding:14px 17px;display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px">
          <div>
            <div style="font-size:11px;color:var(--text-3);letter-spacing:.06em;text-transform:uppercase;margin-bottom:6px">Verbinding</div>
            ${set.ghl_webhook_active ? H.pill('ok', 'Actief') : H.pill('warn', 'Uit')}
            <div style="font-size:11.5px;color:var(--text-3);margin-top:4px">GHL-webhook</div>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-3);letter-spacing:.06em;text-transform:uppercase;margin-bottom:6px">Autonomie</div>
            ${set.live_mode_enabled ? H.pill('ok', 'Live') : H.pill('neutral', 'Sandbox')}
            <div style="font-size:11.5px;color:var(--text-3);margin-top:4px">${set.response_delay_mode ? esc(set.response_delay_mode) + '-delay' : 'geen delay'}</div>
          </div>
          <div>
            <div style="font-size:11px;color:var(--text-3);letter-spacing:.06em;text-transform:uppercase;margin-bottom:6px">Kennisbank</div>
            <span class="mono" style="font-size:17px;font-weight:600">${kbCount}</span>
            <div style="font-size:11.5px;color:var(--text-3);margin-top:4px">items totaal</div>
          </div>
        </div>
      </div>
      ${nj('Onderwerpen top-5 vereist topic-tagging in lisa_messages (bestaat nog niet). Reactietijd komt niet uit lisa-stats.')}
    </div>`;
  }

  // ── VIEW: Gesprekken ─────────────────────────────────────────────────
  function gesprekkenView() {
    if (!_live.convs.data && !_live.convs.loading && !_live.convs.error) queueMicrotask(fetchConvs);
    if (_live.convs.error && !_live.convs.data) return errBlk('convs', _live.convs.error);
    if (_live.convs.loading && !_live.convs.data) return skel();
    const convs = asArr(_live.convs.data);
    const q = (F('q', '') || '').toLowerCase();
    const filter = F('lisa-f', 'all');
    const rows = convs.filter((c) => {
      if (q && !String(c.contact_name || c.instagram_handle || '').toLowerCase().includes(q)) return false;
      if (filter === 'all') return true;
      if (filter === 'hot') return c.qualified === true;
      if (filter === 'cold') return c.phase === 'cold' || c.qualified === false;
      if (filter === 'warm') return !c.qualified && c.phase !== 'cold';
      return true;
    });
    const detail = _lisaSel ? _live.convDetail.get(_lisaSel) : null;
    return `${H.toolbar([
      H.chips('lisa-f', [
        { l: 'Alle', v: 'all', n: convs.length },
        { l: 'Hot', v: 'hot', n: convs.filter((c) => c.qualified === true).length },
        { l: 'Warm', v: 'warm', n: convs.filter((c) => !c.qualified && c.phase !== 'cold').length },
        { l: 'Cold', v: 'cold', n: convs.filter((c) => c.phase === 'cold' || c.qualified === false).length },
      ], filter),
      H.search('Zoek @handle of naam…'),
    ])}
    <div style="display:grid;grid-template-columns:1fr 1.4fr;gap:0;border-top:1px solid var(--border);min-height:400px">
      <div style="border-right:1px solid var(--border);overflow-y:auto;max-height:600px">
        ${rows.length === 0 ? `<div class="empty" style="padding:44px 20px"><div class="empty-t">Geen gesprekken</div></div>` : rows.map((c) => `
          <div style="padding:12px 16px;border-bottom:1px solid var(--border);cursor:pointer;${_lisaSel === c.id ? 'background:var(--surface-2)' : ''}" onclick="__lisaSel('${esc(c.id)}')">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
              <span style="font-size:13px;font-weight:${c.human_takeover ? '600' : '500'}">${esc(c.contact_name || c.instagram_handle || 'Onbekend')}</span>
              ${c.instagram_handle ? `<span class="mono" style="color:var(--text-3);font-size:11px">@${esc(c.instagram_handle)}</span>` : ''}
              <span style="margin-left:auto;font-size:10.5px;color:var(--text-3)">${c.last_message_at ? new Date(c.last_message_at).toLocaleDateString('nl-NL', { day:'numeric', month:'short' }) : '—'}</span>
            </div>
            <div style="font-size:12px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.preview || '')}</div>
            <div style="display:flex;gap:5px;margin-top:5px;flex-wrap:wrap">
              ${c.qualified ? H.pill('ok', 'Hot', 1) : c.phase === 'cold' ? H.pill('neutral', 'Cold', 1) : H.pill('warn', c.phase || 'Warm', 1)}
              ${c.call_booked ? H.pill('accent', 'Geboekt', 1) : ''}
              ${c.human_takeover ? H.pill('danger', 'Handmatig', 1) : ''}
            </div>
          </div>`).join('')}
      </div>
      <div style="padding:20px;overflow-y:auto;max-height:600px">
        ${_lisaSel ? (detail?.loading ? '<div style="color:var(--text-3)">Laden…</div>' : detail?.error ? `<div style="color:var(--rose)">Fout: ${esc(detail.error)}</div>` : detail?.data ? `
          <div style="border-bottom:1px solid var(--border);padding-bottom:10px;margin-bottom:12px">
            <div style="font-size:14px;font-weight:600">${esc(detail.data.conversation?.contact_name || '—')}</div>
            <div style="font-size:12px;color:var(--text-3)">${esc(detail.data.conversation?.instagram_handle ? '@' + detail.data.conversation.instagram_handle : '')}</div>
          </div>
          ${asArr(detail.data.messages).slice(-20).map((m) => `<div style="margin-bottom:8px;padding:8px 12px;border-radius:8px;max-width:80%;${m.direction === 'in' ? 'background:var(--surface-2);align-self:flex-start' : 'background:var(--violet-soft);color:var(--violet);margin-left:auto'};font-size:12.5px">${esc(m.content || m.text || '—')}</div>`).join('') || '<div style="color:var(--text-3);font-size:12px">Geen berichten.</div>'}
          ${nj('Verstuur DM / Plak-in-chat / Intervene → Instagram-API needs Jeffrey.')}
        ` : '<div style="color:var(--text-3)">Detail laden…</div>') : '<div style="color:var(--text-3);font-size:13px;text-align:center;padding:40px 0">← Kies een gesprek</div>'}
      </div>
    </div>`;
  }

  // ── VIEW: Statistieken ───────────────────────────────────────────────
  function statsView() {
    if (!_live.stats.data && !_live.stats.loading && !_live.stats.error) queueMicrotask(() => fetchStats('month'));
    if (_live.stats.error && !_live.stats.data) return errBlk('stats', _live.stats.error);
    if (_live.stats.loading && !_live.stats.data) return skel();
    const s = _live.stats.data || {};
    const period = _live.stats.period;
    const msgTotal = Number(s.messages?.total || 0);
    const msgAi = Number(s.messages?.ai_generated || 0);
    const takeover = Number(s.messages?.human_override || 0);
    const succ = msgTotal > 0 ? Math.round((msgAi / msgTotal) * 100) : 0;
    return `${H.toolbar([
      H.chips('lisa-p', [
        { l: 'Vandaag', v: 'today' },
        { l: 'Deze week', v: 'week' },
        { l: 'Deze maand', v: 'month' },
        { l: 'Alles', v: 'all' },
      ], period),
      `<div class="tb-right"><button class="btn btn-ghost" onclick="__lisaRetry('stats')">${svg(I.refresh || I.check2)}Vernieuwen</button></div>`,
    ])}
    <div style="padding:0 20px"><script>document.querySelectorAll('[data-lisa-p]').forEach(b=>b.onclick=()=>__lisaSetPeriod(b.getAttribute('data-lisa-p')));</script></div>
    ${H.kpis([
      { c: 'violet',  icon: I.chat,   label: "DM-volume " + period, val: String(msgTotal) },
      { c: 'emerald', icon: I.tick,   label: 'Auto-succes',          val: succ + '%', hi: 1, sub: msgAi + ' AI-antwoorden' },
      { c: 'amber',   icon: I.alert,  label: 'Escalaties',           val: String(takeover), hi: 1, sub: 'human_override' },
      { c: 'blue',    icon: I.cal,    label: 'Geboekt',              val: String(Number(s.booked || 0)), sub: 'sessies' },
    ])}
    ${nj("DM/dag bar-chart en Bron-tabel vereisen daily buckets + lisa_conversations.source labels — needs Jeffrey.")}`;
  }

  window.DFO.VIEWS['lisa/Dashboard']    = dashboardView;
  window.DFO.VIEWS['lisa/Gesprekken']   = gesprekkenView;
  window.DFO.VIEWS['lisa/Statistieken'] = statsView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('lisa');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('lisa');
  console.debug('[lisa-v2] data-ronde geregistreerd (dormant)');
})();
