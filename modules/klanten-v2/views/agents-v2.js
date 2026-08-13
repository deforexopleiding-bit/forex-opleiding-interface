// modules/klanten-v2/views/agents-v2.js
//
// Fase F — AI Agents. UITBOUW 2026-08-13 naar prototype-parity (v45).
// Dormant. QA via ?v2preview=agents.
//
// Endpoints (read):
//   GET  /api/agents-config-list      (admin.joost_config)           → per-module joost_config summary + Lisa
//   GET  /api/agents-activity         (admin.joost_config)           → trio + lisa stats
//   GET  /api/joost-config-get?module=<m>  (admin.joost_config OR view fallback)
//   GET  /api/lisa-config             (admin.lisa_config-flavour)    → actieve Lisa-versie
//   GET  /api/agent-approval?action=list                             → pending approvals
//
// Endpoints (write, alleen niet-Joost):
//   POST /api/joost-config-upsert     { module, persona_name, persona_tone, model, is_enabled }
//     - module=events (Simone) → admin.simone_config
//     - module=onboarding (Mila) → admin.joost_config (bestaande policy)
//   Joost = protected zone: alle /api/joost-* config-writes verboden voor Joost.
//
// AGENTS canonical list = prototype r6275-6321. 6 conversational (Lisa/Joost/Simone/
// Mila/Aisha/AI Manager) + 3 achtergrond. Live data koppelen we aan een subset
// (Joost/Simone/Mila via joost_config, Lisa via lisa_config); Aisha, AI Manager en
// alle 3 achtergrond-agents hebben nog geen backend en tonen "Needs Jeffrey".

(function () {
  if (!window.DFO) { console.error('[agents-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[agents-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, S } = window.DFO;
  const H = window.KV_V2.helpers;

  const asArr = (x) => Array.isArray(x) ? x : [];
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const fmtNum = (n) => (Number(n || 0)).toLocaleString('nl-NL');
  const fmtDate = (iso) => iso ? new Date(iso).toLocaleString('nl-NL', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : '—';

  // ═══════════════════════════════════════════════════════════════════════
  // CANONICAL AGENT LIST (prototype r6275-6321)
  // Elke agent heeft: id, n(aam), rol, d(escriptie), c(olor), venster, ver(sie),
  // mod(ule-label), modId(sidebar-target), kan(alen[]), config(bewerkbaar), lock(Joost).
  // "backendModule" = joost_config.module key waar de live data zit (of null).
  // ═══════════════════════════════════════════════════════════════════════
  const AGENTS_STATIC = [
    { id:'lisa',    n:'Lisa',    rol:'Instagram',      d:'Voert Instagram-gesprekken en boekt kennismakingscalls',
      c:'violet',  live:true,  aut:'Zelfstandig versturen',        venster:'07:00 – 23:30', ver:'v16',
      mod:'Lisa — Instagram', modId:'lisa',           kan:['Instagram'],       config:true,  backend:'lisa' },
    { id:'joost',   n:'Joost',   rol:'Aanmaningen',    d:'Voert gesprekken met wanbetalers en stelt betaalregelingen voor',
      c:'amber',   live:true,  aut:'Voorstellen — jij keurt goed', venster:'08:00 – 20:00', ver:'v9',
      mod:'Wanbetalers', modId:'wanbetalers',         kan:['WhatsApp','E-mail'],config:true, lock:true, backend:'finance' },
    { id:'simone',  n:'Simone',  rol:'Events',         d:'Beantwoordt vragen over events, aanmeldingen en de vragenlijst',
      c:'pink',    live:true,  aut:'Zelfstandig antwoorden',       venster:'08:00 – 22:00', ver:'v4',
      mod:'Events', modId:'events',                   kan:['WhatsApp','E-mail'],config:true, backend:'events' },
    { id:'mila',    n:'Mila',    rol:'Onboarding',     d:'Begeleidt nieuwe klanten door de onboardingflow',
      c:'emerald', live:true,  aut:'Zelfstandig antwoorden',       venster:'08:00 – 20:00', ver:'v3',
      mod:'Onboarding', modId:'onboarding',           kan:['WhatsApp','E-mail'],config:true, backend:'onboarding' },
    { id:'aisha',   n:'Aisha',   rol:'Leadsonderhoud', d:'Houdt contact met leads die nog niet klaar zijn',
      c:'teal',    live:false, aut:'Zelfstandig antwoorden',       venster:'09:00 – 21:00', ver:'v5',
      mod:'Leadsonderhoud', modId:'leadsonderhoud',   kan:['WhatsApp','E-mail'],config:true, backend:null },
    { id:'manager', n:'AI Manager', rol:'Bedrijfsvragen', d:'Beantwoordt vragen over je bedrijf op basis van je eigen data',
      c:'blue',    live:false, aut:'Alleen lezen',                 venster:'altijd',        ver:'v2',
      mod:'Dashboard', modId:'dashboard',             kan:['Dashboard'],       config:true,  backend:null },
    // Achtergrond
    { id:'analyse',   n:'Gespreksanalyse',   rol:'Achtergrond', d:'Leest gesprekken en herkent betaalafspraken en signalen',
      c:'slate', live:true,  aut:'Signaleert alleen',    venster:'continu', ver:'v6',
      mod:'Wanbetalers', modId:'wanbetalers', kan:['Achtergrond'], config:false, backend:null, ic:'eye' },
    { id:'mailsort',  n:'E-mail categorisatie', rol:'Achtergrond', d:'Sorteert binnenkomende mail en koppelt aan klanten',
      c:'blue',  live:true,  aut:'Sorteert automatisch', venster:'continu', ver:'v3',
      mod:'E-mail', modId:'email', kan:['Achtergrond'], config:false, backend:null, ic:'mail' },
    { id:'scoring',   n:'Lead-scoring',    rol:'Achtergrond', d:'Geeft leads een kwalificatiescore op basis van hun antwoorden',
      c:'slate', live:false, aut:'—',                     venster:'—',       ver:'—',
      mod:'Leads', modId:'leads', kan:['Achtergrond'], config:false, backend:null, ic:'target' },
  ];

  // Wanneer een agent geen backend heeft → toon "Nog geen backend"-badge ipv Live/Uit
  function _hasBackend(a) { return !!a.backend; }

  // ═══════════════════════════════════════════════════════════════════════
  // STATE (per-block: loading/error/data)
  // ═══════════════════════════════════════════════════════════════════════
  const _live = {
    configList: { loading: false, error: null, data: null },
    activity:   { loading: false, error: null, data: null },
    approval:   { loading: false, error: null, data: null },
    // per-module joost-config: { finance:{...}, events:{...}, onboarding:{...} }
    perConfig:  { loading: {}, error: {}, data: {} },
    lisa:       { loading: false, error: null, data: null },
  };

  // Config-editor state (client-only)
  const _ui = {
    agSel: 'lisa',                     // welke agent in editor
    agCfgTab: 'Gedrag',                // sub-tab in configuratie
    kbFilter: { agent: 'all', cat: 'all', q: '' },
    prestPeriod: 'month',
    saving: {},                        // agentId → bool
    dirty:  {},                        // agentId → {field:value}
    saved:  {},                        // agentId → ts van laatste save
  };

  async function tryFetch(label, url, init, timeoutMs) {
    timeoutMs = timeoutMs || 8000;
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      return await Promise.race([
        window.KV.authedJson(url, init),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) { console.warn('[ag-v2] ' + label + ' fail:', e?.message); return { __error: e?.message || 'onbekende fout' }; }
  }

  async function fetchConfigList() {
    const st = _live.configList; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('config-list', '/api/agents-config-list');
    st.loading = false;
    if (j && j.__error) st.error = j.__error; else st.data = asArr(j?.agents);
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchActivity() {
    const st = _live.activity; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('activity', '/api/agents-activity');
    st.loading = false;
    if (j && j.__error) st.error = j.__error; else st.data = j || null;
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchApproval() {
    const st = _live.approval; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('approval', '/api/agent-approval?action=list');
    st.loading = false;
    if (j && j.__error) st.error = j.__error; else st.data = asArr(j?.approvals || j?.rows);
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchPerConfig(moduleKey) {
    const st = _live.perConfig;
    if (st.loading[moduleKey] || st.data[moduleKey]) return;
    st.loading[moduleKey] = true; st.error[moduleKey] = null;
    const j = await tryFetch('cfg-' + moduleKey, '/api/joost-config-get?module=' + encodeURIComponent(moduleKey));
    st.loading[moduleKey] = false;
    if (j && j.__error) st.error[moduleKey] = j.__error; else st.data[moduleKey] = j?.config || null;
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchLisaConfig() {
    const st = _live.lisa; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('lisa-config', '/api/lisa-config');
    st.loading = false;
    if (j && j.__error) st.error = j.__error; else st.data = j?.config || j || null;
    if (window.DFO?.render) window.DFO.render();
  }

  window.__agRetry = (b, mod) => {
    if (b === 'perConfig' && mod) { _live.perConfig.data[mod] = null; _live.perConfig.error[mod] = null; fetchPerConfig(mod); return; }
    if (_live[b]) { _live[b].data = null; _live[b].error = null; }
    if (b === 'configList') fetchConfigList();
    if (b === 'activity')   fetchActivity();
    if (b === 'approval')   fetchApproval();
    if (b === 'lisa')       fetchLisaConfig();
  };

  // ═══════════════════════════════════════════════════════════════════════
  // SHARED BUILDING BLOCKS
  // ═══════════════════════════════════════════════════════════════════════
  const errBlk = (block, msg, arg) => `<div style="margin:14px 20px;padding:12px 16px;border:1px solid var(--rose-line);background:var(--rose-soft);border-radius:var(--r);color:var(--rose);font-size:13px;display:flex;align-items:center;gap:12px">
    <span>${svg(I.alert || I.warn, 'width:16px;height:16px')}</span>
    <span style="flex:1">Kon ophalen: ${esc(msg)}${/401|403/.test(msg || '') ? ' — admin/super_admin vereist' : ''}</span>
    <button class="btn btn-ghost btn-sm" onclick="__agRetry('${block}'${arg ? `,'${arg}'` : ''})">Opnieuw</button></div>`;
  const skel = () => `<div class="pad"><div class="card"><div class="card-body" style="padding:22px;opacity:.55"><div style="height:12px;background:var(--surface-2);border-radius:4px;width:60%;margin-bottom:12px"></div><div style="height:12px;background:var(--surface-2);border-radius:4px;width:40%"></div></div></div></div>`;
  const nj  = (r) => `<div style="margin:14px 20px;padding:12px 16px;border:1px solid var(--amber-line);background:var(--amber-soft);border-radius:var(--r);color:var(--amber);font-size:12.5px;display:flex;gap:11px;align-items:flex-start">${svg(I.alert, 'width:15px;height:15px;flex-shrink:0;margin-top:1px')}<span><b>Needs Jeffrey</b> — ${esc(r)}</span></div>`;
  const gapBadge = (r) => `<span class="pill pill-warn nodot" style="font-size:10px;padding:1.5px 6px" title="${esc(r)}">Backend ontbreekt</span>`;

  // Kanaal-pill (WhatsApp/Instagram/E-mail/Dashboard/Achtergrond).
  function _channelPill(k) {
    const map = { 'WhatsApp':'ok','Instagram':'accent','E-mail':'neutral','Dashboard':'accent','Achtergrond':'neutral' };
    return `<span class="pill pill-${map[k] || 'neutral'} nodot" style="font-size:10.5px;padding:1.5px 7px">${esc(k)}</span>`;
  }

  // Radial avatar (prototype r6335-6337) — pure CSS, geen extra assets nodig.
  function _radial(color, size) {
    size = size || 38;
    return `<span style="width:${size}px;height:${size}px;border-radius:50%;flex-shrink:0;display:inline-block;
      background:radial-gradient(circle at 32% 30%,color-mix(in srgb,var(--${color}) 45%,white),var(--${color}) 72%);
      box-shadow:0 2px 10px -2px var(--${color})"></span>`;
  }

  // Live-data lookup — matched op backend (joost_config.module) of Lisa.
  function _liveFor(agent, cfgList) {
    if (!agent.backend || !Array.isArray(cfgList)) return null;
    if (agent.backend === 'lisa') return cfgList.find((r) => r.type === 'lisa') || null;
    return cfgList.find((r) => r.type === 'joost_config' && r.module === agent.backend) || null;
  }

  // Trio-stats lookup (from activity.trio[])
  function _trioStat(agent, activity) {
    if (!activity || !Array.isArray(activity.trio)) return null;
    return activity.trio.find((r) => r.module === agent.backend) || null;
  }
  function _lisaStat(activity) {
    return activity?.lisa || null;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // VIEW 1 — OVERZICHT
  // ═══════════════════════════════════════════════════════════════════════
  function overzichtView() {
    if (!_live.configList.data && !_live.configList.loading && !_live.configList.error) queueMicrotask(fetchConfigList);
    if (!_live.activity.data   && !_live.activity.loading   && !_live.activity.error)   queueMicrotask(fetchActivity);
    if (!_live.approval.data   && !_live.approval.loading   && !_live.approval.error)   queueMicrotask(fetchApproval);

    if (_live.configList.error && !_live.configList.data) return errBlk('configList', _live.configList.error);
    if (_live.configList.loading && !_live.configList.data) return skel();

    const cfgList  = asArr(_live.configList.data);
    const activity = _live.activity.data || {};
    const approvals = asArr(_live.approval.data);
    const waitCount = approvals.filter((a) => (a?.status === 'pending' || a?.status === 'awaiting_approval')).length;

    // KPI-berekening
    const activeCount = AGENTS_STATIC.filter((a) => {
      const l = _liveFor(a, cfgList);
      if (a.backend === 'lisa') return l?.is_active === true;
      if (l) return l.is_enabled === true;
      return a.live && !_hasBackend(a) ? false : false;    // no-backend agents tellen niet als "live"
    }).length;
    const totalConfigured = AGENTS_STATIC.length;

    let messagesToday = 0;
    if (activity.trio) for (const t of activity.trio) messagesToday += Number(t.messages_today || 0);
    messagesToday += Number(activity.lisa?.messages_today || 0);

    let handoffs = 0;
    if (activity.trio) for (const t of activity.trio) handoffs += Number(t.handoffs || 0);
    handoffs += Number(activity.lisa?.human_takeover || 0);

    const conv = AGENTS_STATIC.filter((a) => a.rol !== 'Achtergrond');
    const bg   = AGENTS_STATIC.filter((a) => a.rol === 'Achtergrond');

    return `${H.kpis([
      { c:'violet',  icon:I.bot,   label:'Actieve agents',       val:String(activeCount), sub:'van ' + totalConfigured + ' ingericht' },
      { c:'emerald', icon:I.chat,  label:'Gesprekken vandaag',   val:fmtNum(messagesToday), hi:1, sub:'over alle agents' },
      { c:'amber',   icon:I.users, label:'Overgenomen door mens',val:fmtNum(handoffs), hi:1, sub:'trio + Lisa' },
      { c:'rose',    icon:I.alert, label:'Wacht op jou',         val:String(waitCount), hi:1, sub:approvals.length ? approvals.length + ' totaal in queue' : 'geen queue' },
    ])}
    ${_live.activity.error ? errBlk('activity', _live.activity.error) : ''}
    ${_live.approval.error ? errBlk('approval', _live.approval.error) : ''}

    <div class="pad" style="padding-top:16px">
      <div style="font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3);margin-bottom:11px">Gespreksagents (${conv.length})</div>
      <div class="grid g3" style="margin-bottom:22px">
        ${conv.map((a) => _overzichtConvCard(a, cfgList, activity)).join('')}
      </div>

      <div style="font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3);margin-bottom:11px">Op de achtergrond</div>
      <div class="grid g3">
        ${bg.map((a) => _overzichtBgCard(a)).join('')}
      </div>
      ${nj('Achtergrond-agents (Gespreksanalyse / E-mail categorisatie / Lead-scoring) hebben geen backend-endpoint. Toggles zijn visueel; stats zijn placeholder tot Jeffrey aanlevert welke tabel/counter ze moeten lezen.')}
    </div>`;
  }

  function _overzichtConvCard(a, cfgList, activity) {
    const live = _liveFor(a, cfgList);
    const isLive = a.backend === 'lisa' ? live?.is_active === true : live?.is_enabled === true;
    const stat   = a.backend === 'lisa' ? _lisaStat(activity) : _trioStat(a, activity);

    // Stats — live indien backend, anders "—"
    let stats;
    if (a.backend === 'lisa' && stat) {
      stats = [
        [fmtNum(stat.conversations_today), 'GESPREKKEN'],
        [fmtNum(stat.call_booked),         'CALLS'],
        [stat.conversations_today ? Math.round(100 * stat.call_booked / stat.conversations_today) + '%' : '—', 'CONVERSIE'],
      ];
    } else if (a.backend === 'finance' && stat) {
      stats = [
        [fmtNum(stat.messages_today),   'BERICHTEN 24U'],
        [fmtNum(stat.open_suggestions), 'OPEN'],
        [fmtNum(stat.handoffs),         'DOORGEZET'],
      ];
    } else if ((a.backend === 'events' || a.backend === 'onboarding') && stat) {
      const zelf = stat.messages_today && stat.handoffs != null
        ? Math.max(0, Math.round(100 * (1 - stat.handoffs / Math.max(1, stat.messages_today)))) + '%'
        : '—';
      stats = [
        [fmtNum(stat.messages_today), 'BERICHTEN 24U'],
        [zelf,                        'ZELF AFGEHANDELD'],
        [fmtNum(stat.handoffs),       'DOORGEZET'],
      ];
    } else {
      stats = [['—',''],['—',''],['—','']];
    }

    const showBackendGap = !a.backend;
    const persona = live?.persona_name || a.n;

    return `<div class="card" onclick="window.__agGoConfig('${a.id}')" style="cursor:pointer;transition:transform .15s,box-shadow .15s" onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 6px 20px -8px rgba(0,0,0,.15)'" onmouseout="this.style.transform='';this.style.boxShadow=''">
      <div style="padding:15px 17px;display:flex;align-items:flex-start;gap:12px">
        ${_radial(a.c, 38)}
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">
            <span class="card-title">${esc(persona)}</span>
            ${a.lock ? `<span class="pill pill-warn nodot" style="font-size:10px;padding:1.5px 7px;display:inline-flex;align-items:center;gap:4px">${svg(I.shield, 'width:9px;height:9px')}Beschermd</span>` : ''}
            <span class="mono" style="font-size:10.5px;color:var(--text-3);margin-left:auto">${esc(a.ver)}</span>
          </div>
          <div style="font-size:11.5px;color:var(--${a.c});font-weight:500;margin-top:2px">${esc(a.rol)}</div>
          <div style="font-size:12px;color:var(--text-3);margin-top:4px;line-height:1.45">${esc(a.d)}</div>
        </div>
      </div>
      <div style="padding:0 17px 12px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
        ${showBackendGap ? gapBadge('Geen backend gekoppeld — Aisha/AI Manager needs Jeffrey')
                         : (isLive ? H.pill('ok','Live') : H.pill('neutral','Uit'))}
        ${a.kan.map(_channelPill).join('')}
        <span style="font-size:11px;color:var(--text-3);margin-left:auto">${esc(a.venster)}</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--border);border-top:1px solid var(--border)">
        ${stats.map(([v, l]) => `<div style="background:var(--surface);padding:10px 12px;text-align:center">
          <div style="font-size:17px;font-weight:600;font-family:'IBM Plex Mono',monospace;letter-spacing:-.03em">${esc(v)}</div>
          <div style="font-size:10px;letter-spacing:.05em;color:var(--text-3);margin-top:2px">${esc(l)}</div></div>`).join('')}
      </div>
    </div>`;
  }

  function _overzichtBgCard(a) {
    return `<div class="card" style="opacity:${a.live ? '1' : '.6'}">
      <div class="card-body" style="padding:15px 17px">
        <div style="display:flex;align-items:flex-start;gap:11px;margin-bottom:11px">
          <span class="tile-ico" style="background:var(--${a.c}-soft);color:var(--${a.c})">${svg(I[a.ic] || I.bot)}</span>
          <div style="flex:1;min-width:0">
            <div class="card-title">${esc(a.n)}</div>
            <div style="font-size:12px;color:var(--text-3);margin-top:3px;line-height:1.45">${esc(a.d)}</div>
          </div>
          <div class="switch ${a.live ? 'on' : ''}" style="width:34px;height:20px" title="Backend ontbreekt — toggle is visueel"></div>
        </div>
        <div style="display:flex;gap:16px;font-size:11.5px;color:var(--text-3);align-items:center;flex-wrap:wrap">
          <span style="color:var(--text-3)">${esc(a.aut)}</span>
          ${gapBadge('Geen backend-teller')}
        </div>
      </div>
    </div>`;
  }

  // Sidebar-jumps naar Configuratie
  window.__agGoConfig = (id) => {
    _ui.agSel = id;
    _ui.agCfgTab = 'Gedrag';
    if (window.DFO?.setTab) window.DFO.setTab('Configuratie');
    else if (window.DFO?.render) window.DFO.render();
  };

  // ═══════════════════════════════════════════════════════════════════════
  // VIEW 2 — CONFIGURATIE (per-agent editor)
  // ═══════════════════════════════════════════════════════════════════════
  function configuratieView() {
    if (!_live.configList.data && !_live.configList.loading && !_live.configList.error) queueMicrotask(fetchConfigList);
    if (_live.configList.error && !_live.configList.data) return errBlk('configList', _live.configList.error);
    if (_live.configList.loading && !_live.configList.data) return skel();

    const cfgList = asArr(_live.configList.data);
    const a = AGENTS_STATIC.find((x) => x.id === _ui.agSel) || AGENTS_STATIC[0];

    // Lazy: fetch config-details voor huidige agent
    if (a.backend && a.backend !== 'lisa') {
      if (!_live.perConfig.data[a.backend] && !_live.perConfig.loading[a.backend] && !_live.perConfig.error[a.backend]) {
        queueMicrotask(() => fetchPerConfig(a.backend));
      }
    } else if (a.backend === 'lisa') {
      if (!_live.lisa.data && !_live.lisa.loading && !_live.lisa.error) queueMicrotask(fetchLisaConfig);
    }

    return _cfgHeader(a) + _cfgLockBanner(a) + _cfgTabs(a) + _cfgBody(a, cfgList);
  }

  function _cfgHeader(a) {
    const others = AGENTS_STATIC.filter((x) => x.config).map((x) =>
      `<option value="${x.id}" ${x.id === _ui.agSel ? 'selected' : ''}>${esc(x.n)} — ${esc(x.rol)}</option>`).join('');
    return `<div style="padding:13px 20px;background:var(--${a.c}-soft);border-bottom:1px solid var(--${a.c}-line);display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      ${_radial(a.c, 32)}
      <div style="flex:1;min-width:150px">
        <div style="font-size:14px;font-weight:600">${esc(a.n)} <span style="font-weight:400;color:var(--text-3)">· ${esc(a.rol)}</span></div>
        <div style="font-size:12px;color:var(--text-3)">${esc(a.aut)} · ${esc(a.venster)} · configuratie ${esc(a.ver)}</div>
      </div>
      ${a.lock ? `<span class="pill pill-warn nodot" style="display:inline-flex;align-items:center;gap:5px;font-size:11px;padding:2px 9px">${svg(I.shield, 'width:11px;height:11px')}Beschermd — wijzigen in ${esc(a.mod)}</span>` : ''}
      ${!a.backend ? gapBadge('Geen backend-endpoint voor deze agent') : ''}
      <select class="filter-sel" onchange="window.__agSelChange(this.value)">${others}</select>
    </div>`;
  }
  window.__agSelChange = (v) => { _ui.agSel = v; _ui.agCfgTab = 'Gedrag'; if (window.DFO?.render) window.DFO.render(); };

  function _cfgLockBanner(a) {
    if (!a.lock) return '';
    return `<div style="padding:13px 20px;background:var(--amber-soft);border-bottom:1px solid var(--amber-line);display:flex;gap:11px;align-items:flex-start;font-size:12.5px;color:var(--amber)">
      ${svg(I.shield, 'width:16px;height:16px;flex-shrink:0;margin-top:1px')}
      <span><b>Beschermde agent.</b> Joost is met zorg ingericht en werkt. Je kunt hier alles bekijken, maar wijzigen gebeurt in <b>${esc(a.mod)} → Instellingen</b>. Zo blijft er niets per ongeluk stuk. (Protected zone — API-writes op /api/joost-* voor Joost geblokkeerd.)</span>
    </div>`;
  }

  function _cfgTabs(a) {
    const tabs = ['Gedrag', 'Autonomie', 'Beslissingen', 'Oefengesprek'];
    return `<div class="toolbar" style="padding:10px 20px 0;border-bottom:none;gap:6px;flex-wrap:wrap">
      ${tabs.map((t) => `<button class="chip ${_ui.agCfgTab === t ? 'on' : ''}" onclick="window.__agCfgTab('${t}')">${esc(t)}</button>`).join('')}
    </div>`;
  }
  window.__agCfgTab = (t) => { _ui.agCfgTab = t; if (window.DFO?.render) window.DFO.render(); };

  function _cfgBody(a, cfgList) {
    if (_ui.agCfgTab === 'Autonomie')    return _cfgAutonomie(a, cfgList);
    if (_ui.agCfgTab === 'Beslissingen') return _cfgBeslissingen(a);
    if (_ui.agCfgTab === 'Oefengesprek') return _cfgOefengesprek(a);
    return _cfgGedrag(a, cfgList);
  }

  // ── Gedrag: persona + toon + mandaat + stopregels + live-config editor ──
  function _cfgGedrag(a, cfgList) {
    // Data ophalen
    let currentCfg = null;
    let loadingCfg = false;
    let errorCfg = null;
    if (a.backend === 'lisa') {
      currentCfg = _live.lisa.data;
      loadingCfg = _live.lisa.loading;
      errorCfg   = _live.lisa.error;
    } else if (a.backend) {
      currentCfg = _live.perConfig.data[a.backend] || null;
      loadingCfg = _live.perConfig.loading[a.backend];
      errorCfg   = _live.perConfig.error[a.backend];
    }

    const readonly = !!a.lock;
    const dirty    = _ui.dirty[a.id] || {};
    const value    = (field, fallback) => (dirty[field] !== undefined ? dirty[field] : (currentCfg?.[field] != null ? currentCfg[field] : fallback));

    if (a.backend && !currentCfg && loadingCfg) return skel();
    if (a.backend && errorCfg) return errBlk(a.backend === 'lisa' ? 'lisa' : 'perConfig', errorCfg, a.backend === 'lisa' ? undefined : a.backend);

    return `<div class="pad" style="padding-top:14px">
      <div style="max-width:820px">

        ${!a.backend ? nj('Deze agent heeft geen backend-endpoint. Config-formulier is verborgen. Needs Jeffrey: nieuwe tabel of route voor ' + a.n + ' (' + a.rol + ').') : ''}

        <div class="grid g2" style="margin-bottom:14px">
          <div class="card">
            <div class="card-head"><div class="card-title">Wat ${esc(a.n)} mag</div></div>
            <div class="card-body" style="padding:6px 0">
              ${_gedragToggle(a.aut, 'Autonomie', true, readonly)}
              ${_gedragToggle('Zelf gesprekken beginnen', null, a.id !== 'simone', readonly)}
              ${_gedragToggle('Bijlagen versturen', null, true, readonly)}
              ${_gedragToggle('Afspraken inplannen', null, a.id === 'simone' || a.id === 'mila', readonly)}
              ${_gedragToggle('Prijzen noemen', null, false, readonly)}
              ${_gedragToggle('Doorzetten naar een mens', null, true, readonly)}
            </div>
          </div>
          <div class="card">
            <div class="card-head"><div class="card-title">Timing</div></div>
            <div class="card-body">
              <div class="kv"><dt>Verzendvenster</dt><dd>${esc(a.venster)}</dd></div>
              <div class="kv"><dt>Reactievertraging</dt><dd>30 – 90 seconden</dd></div>
              <div class="kv"><dt>Typ-indicator</dt><dd>${H.pill('ok','Aan')}</dd></div>
              <div class="kv"><dt>Max. berichten per dag</dt><dd class="num">3 per contact</dd></div>
              <div class="kv"><dt>Kanalen</dt><dd>${a.kan.map(esc).join(', ')}</dd></div>
            </div>
          </div>
        </div>
        ${nj('Toggles Gedrag/Timing zijn UI-only — de backend heeft geen per-permissie-veld (autonomy_config.mandate wel voor Joost-mandaat; overige toggles vragen schema-uitbreiding).')}

        <div class="card" style="margin-bottom:14px">
          <div class="card-head">
            <span class="tile-ico" style="background:var(--${a.c}-soft);color:var(--${a.c})">${svg(I.bot)}</span>
            <div class="card-title">Persona en toon</div>
            ${readonly ? '' : `<span style="margin-left:auto;font-size:11px;color:var(--text-3)">${a.backend ? 'live · /api/' + (a.backend === 'lisa' ? 'lisa-config' : 'joost-config-get?module=' + a.backend) : ''}</span>`}
          </div>
          <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
            ${_field('Naam',        'persona_name', value('persona_name', a.n), readonly, a)}
            ${_field('Rol',         '__ro_role',    a.rol,                       true,      a)}
            ${_field('Toon',        'persona_tone', value('persona_tone', ''),  readonly, a, 'textarea')}
            ${_field('Model',       'model',        value('model', 'claude-sonnet-4-6'), readonly || a.backend === 'lisa', a, 'select', ['claude-sonnet-4-6','claude-opus-4-7','claude-haiku-4-5'])}
            ${_field('Actief',      'is_' + (a.backend === 'lisa' ? 'active' : 'enabled'),
                     value(a.backend === 'lisa' ? 'is_active' : 'is_enabled', true) ? 'true' : 'false',
                     readonly || a.backend === 'lisa', a, 'toggle')}
          </div>
          ${(!readonly && a.backend && a.backend !== 'lisa') ? _saveBar(a) : ''}
          ${(readonly) ? `<div style="padding:11px 17px;background:var(--surface-2);border-top:1px solid var(--border);font-size:11.5px;color:var(--text-3)">
            <b>Read-only.</b> Wijzigen via <b>${esc(a.mod)} → Instellingen</b> (protected zone).
          </div>` : ''}
          ${(a.backend === 'lisa') ? nj('Lisa-config edit-endpoint is <b>/api/lisa-config?action=save_draft</b> (versioned schema, aparte editor). Deze compacte editor toont read-only samenvatting — volledige editor is in v1 /modules/lisa.html.') : ''}
        </div>

        ${a.id === 'joost' ? _cfgJoostMandate() : ''}

        <div class="card">
          <div class="card-head">
            <span class="tile-ico" style="background:var(--rose-soft);color:var(--rose)">${svg(I.x)}</span>
            <div class="card-title">Wanneer ${esc(a.n)} stopt en jou vraagt</div>
          </div>
          <div class="card-body" style="padding:6px 0">
            ${_stopRegel('Vraag over prijzen', 'valt buiten het mandaat')}
            ${_stopRegel('Klacht of boze toon', 'een mens kan dit beter')}
            ${_stopRegel('Vraag die niet in de kennisbank staat', 'geen antwoord beschikbaar')}
            ${_stopRegel('Stopwoord ontvangen', 'stopt definitief')}
            ${_stopRegel('Drie berichten zonder reactie', 'stopt met opvolgen')}
          </div>
        </div>
      </div>
    </div>`;
  }

  function _gedragToggle(n, l, on, ro) {
    return `<div style="display:flex;align-items:center;gap:12px;padding:11px 17px;border-bottom:1px solid var(--border)">
      <div style="flex:1"><div style="font-size:13px;font-weight:500">${esc(n)}</div>
        ${l ? `<div style="font-size:11.5px;color:var(--text-3)">${esc(l)}</div>` : ''}</div>
      <div class="switch ${on ? 'on' : ''}" style="${ro ? 'opacity:.5;cursor:not-allowed' : ''}"></div>
    </div>`;
  }
  function _stopRegel(n, d) {
    return `<div style="display:flex;align-items:center;gap:11px;padding:10px 17px;border-bottom:1px solid var(--border)">
      <span style="color:var(--rose);display:inline-flex">${svg(I.x, 'width:14px;height:14px')}</span>
      <div style="flex:1"><div style="font-size:13px;font-weight:500">${esc(n)}</div>
        <div style="font-size:11.5px;color:var(--text-3)">${esc(d)}</div></div>
    </div>`;
  }

  function _field(label, name, v, ro, a, kind, options) {
    kind = kind || 'text';
    const id = 'ag_' + a.id + '_' + name;
    const inputStyle = 'width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text-1);font-size:13px;font-family:inherit';
    let input;
    if (ro) {
      input = `<div style="padding:8px 10px;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;font-size:13px;color:var(--text-2)">${esc(v || '—')}</div>`;
    } else if (kind === 'textarea') {
      input = `<textarea id="${id}" oninput="window.__agFieldSet('${a.id}','${name}',this.value)" style="${inputStyle};min-height:70px;resize:vertical">${esc(v || '')}</textarea>`;
    } else if (kind === 'select') {
      input = `<select id="${id}" onchange="window.__agFieldSet('${a.id}','${name}',this.value)" style="${inputStyle}">
        ${(options || []).map((o) => `<option value="${esc(o)}" ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}
      </select>`;
    } else if (kind === 'toggle') {
      const on = String(v) === 'true';
      input = `<button type="button" id="${id}" onclick="window.__agFieldSet('${a.id}','${name}', ${on ? 'false' : 'true'});window.DFO && window.DFO.render && window.DFO.render()" class="switch ${on ? 'on' : ''}" style="border:none;padding:0"></button>`;
    } else {
      input = `<input id="${id}" type="text" value="${esc(v || '')}" oninput="window.__agFieldSet('${a.id}','${name}',this.value)" style="${inputStyle}" />`;
    }
    return `<div style="display:grid;grid-template-columns:130px 1fr;gap:14px;align-items:center;padding:0 17px">
      <label for="${id}" style="font-size:12.5px;color:var(--text-2)">${esc(label)}</label>
      <div>${input}</div>
    </div>`;
  }
  window.__agFieldSet = (agId, field, v) => {
    _ui.dirty[agId] = _ui.dirty[agId] || {};
    _ui.dirty[agId][field] = (v === 'true') ? true : (v === 'false' ? false : v);
  };

  function _saveBar(a) {
    const hasDirty = _ui.dirty[a.id] && Object.keys(_ui.dirty[a.id]).length > 0;
    const saving = _ui.saving[a.id] === true;
    const saved  = _ui.saved[a.id];
    return `<div style="padding:11px 17px;background:var(--surface-2);border-top:1px solid var(--border);display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <button class="btn btn-primary btn-sm" ${(!hasDirty || saving) ? 'disabled style="opacity:.55;cursor:not-allowed"' : ''} onclick="window.__agSave('${a.id}')">
        ${svg(I.tick)}${saving ? 'Opslaan…' : 'Opslaan'}
      </button>
      <button class="btn btn-ghost btn-sm" ${(!hasDirty || saving) ? 'disabled style="opacity:.55"' : ''} onclick="window.__agReset('${a.id}')">Annuleren</button>
      ${saved ? `<span style="font-size:11.5px;color:var(--emerald)">✓ Opgeslagen ${new Date(saved).toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit'})}</span>` : ''}
      <span style="font-size:11px;color:var(--text-3);margin-left:auto">POST /api/joost-config-upsert · module=${esc(a.backend)}</span>
    </div>`;
  }
  window.__agReset = (agId) => { _ui.dirty[agId] = {}; if (window.DFO?.render) window.DFO.render(); };
  window.__agSave = async (agId) => {
    const a = AGENTS_STATIC.find((x) => x.id === agId);
    if (!a || !a.backend || a.backend === 'lisa' || a.lock) {
      alert('Config-write onmogelijk voor deze agent (Joost = protected, Lisa = eigen endpoint, no-backend = geen tabel).');
      return;
    }
    const dirty = _ui.dirty[agId] || {};
    const body = { module: a.backend };
    const ALLOWED = ['persona_name','persona_tone','model','is_enabled'];
    let n = 0;
    for (const k of ALLOWED) if (dirty[k] !== undefined) { body[k] = dirty[k]; n++; }
    if (!n) { alert('Niets gewijzigd.'); return; }
    _ui.saving[agId] = true;
    if (window.DFO?.render) window.DFO.render();
    try {
      const j = await window.KV.authedJson('/api/joost-config-upsert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (j?.error) throw new Error(j.error);
      _ui.saved[agId] = Date.now();
      _ui.dirty[agId] = {};
      _live.perConfig.data[a.backend] = j?.config || _live.perConfig.data[a.backend];
      _live.configList.data = null;                        // refetch overview live-data
      queueMicrotask(fetchConfigList);
    } catch (e) {
      console.error('[ag-v2] save fail', e);
      alert('Opslaan mislukt: ' + (e?.message || 'onbekende fout'));
    } finally {
      _ui.saving[agId] = false;
      if (window.DFO?.render) window.DFO.render();
    }
  };

  function _cfgJoostMandate() {
    return `<div class="card" style="margin-bottom:14px">
      <div class="card-head">
        <span class="tile-ico" style="background:var(--amber-soft);color:var(--amber)">${svg(I.euro)}</span>
        <div class="card-title">Mandaat</div>
      </div>
      <div class="card-body">
        <div class="kv"><dt>Mag regelingen voorstellen tot</dt><dd class="num">€ 1.500</dd></div>
        <div class="kv"><dt>Maximaal aantal termijnen</dt><dd class="num">6</dd></div>
        <div class="kv"><dt>Boven het mandaat</dt><dd>Vraagt jouw goedkeuring</dd></div>
        <div class="kv"><dt>Mag zelf aanmaningen sturen</dt><dd>${H.pill('neutral','Nee')}</dd></div>
      </div>
      <div style="padding:11px 17px;background:var(--surface-2);border-top:1px solid var(--border);font-size:11.5px;color:var(--text-3)">
        Bron: <span class="mono">joost_config.autonomy_config.mandate</span> (Wanbetalers → Instellingen).
      </div>
    </div>`;
  }

  function _cfgAutonomie(a) {
    return `<div class="pad" style="padding-top:14px">
      <div style="max-width:820px">
        ${nj('Autonomie-tab (intenten × modus: uit/meedenken/zelfstandig/altijd mens) leeft in <span class="mono">joost_config.autonomy_config</span> — visualisatie vraagt aparte intenten-matrix-component + write-endpoint per intent. Prototype heeft dit voor Joost (payment_promise / verify_payment / arrangement_request / general_question / escalation_needed / other) en zelfde shape voor Simone/Mila/Aisha. Vereist backend-uitbreiding zodat writes per intent atomair kunnen. Voor nu placeholder-lijst hieronder.')}
        <div class="card">
          <div class="card-head">
            <span class="tile-ico" style="background:var(--${a.c}-soft);color:var(--${a.c})">${svg(I.sliders)}</span>
            <div class="card-title">Autonomie · ${esc(a.n)}</div>
          </div>
          <div class="card-body">
            <div class="kv"><dt>Modus</dt><dd>${esc(a.aut)}</dd></div>
            <div class="kv"><dt>Verzendvenster</dt><dd>${esc(a.venster)}</dd></div>
            <div class="kv"><dt>Intenten</dt><dd>—</dd></div>
          </div>
        </div>
      </div>
    </div>`;
  }
  function _cfgBeslissingen(a) {
    return `<div class="pad" style="padding-top:14px">
      <div style="max-width:820px">
        ${nj('Beslissingen-log toont recente autonome beslissingen per agent uit <span class="mono">joost_autonomy_decisions</span> (endpoint <span class="mono">/api/joost-autonomy-decisions-list</span> bestaat, maar filter per <b>agent</b> ontbreekt — module=finance is Joost, andere modules missen keys). Vereist per-agent filter of aparte column.')}
      </div>
    </div>`;
  }
  function _cfgOefengesprek(a) {
    return `<div class="pad" style="padding-top:14px">
      <div style="max-width:820px">
        ${nj('Oefengesprek (sandbox-chat met deze agent-config, geen productie-effect) heeft geen endpoint. Voor Lisa bestaat een sandbox-chat in v1 <span class="mono">/modules/lisa.html</span> · voor Joost/Simone/Mila is er niets. Vereist nieuwe route zoals <span class="mono">/api/agent-chat-sandbox?module=' + esc(a.backend || a.id) + '</span> met dry-run vlag.')}
      </div>
    </div>`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // VIEW 3 — KENNISBANK (aggregate joost_config.knowledge_base over modules)
  // ═══════════════════════════════════════════════════════════════════════
  function kennisbankView() {
    // Ensure alle trio-configs geladen zijn (elk heeft knowledge_base jsonb)
    ['finance','events','onboarding'].forEach((m) => {
      if (!_live.perConfig.data[m] && !_live.perConfig.loading[m] && !_live.perConfig.error[m]) {
        queueMicrotask(() => fetchPerConfig(m));
      }
    });
    if (!_live.lisa.data && !_live.lisa.loading && !_live.lisa.error) queueMicrotask(fetchLisaConfig);

    const anyLoading = ['finance','events','onboarding'].some((m) => _live.perConfig.loading[m]) || _live.lisa.loading;
    if (anyLoading && !_live.perConfig.data.finance && !_live.perConfig.data.events && !_live.perConfig.data.onboarding) return skel();

    // Bouw aggregate rows
    const rows = [];
    const moduleToAgent = { finance:'Joost', events:'Simone', onboarding:'Mila' };
    for (const m of ['finance','events','onboarding']) {
      const cfg = _live.perConfig.data[m];
      if (!cfg) continue;
      const kb = cfg.knowledge_base || {};
      // knowledge_base is een plain object (jsonb) — pak elke key als "artikel"
      for (const key of Object.keys(kb)) {
        const val = kb[key];
        rows.push({
          onderwerp:    key,
          categorie:    _kbCat(key),
          agents:       [moduleToAgent[m]],
          content:      typeof val === 'object' ? JSON.stringify(val) : String(val),
          updated:      cfg.updated_at,
          bron:         'joost_config.' + m,
        });
      }
    }
    // Lisa — kb_faq (array van {vraag, antwoord, keywords})
    if (_live.lisa.data) {
      const faq = Array.isArray(_live.lisa.data.kb_faq) ? _live.lisa.data.kb_faq : [];
      for (const q of faq) {
        if (!q?.vraag) continue;
        rows.push({
          onderwerp: q.vraag,
          categorie: 'FAQ',
          agents:    ['Lisa'],
          content:   q.antwoord || '',
          updated:   _live.lisa.data.updated_at,
          bron:      'lisa_config.kb_faq',
        });
      }
      const prods = Array.isArray(_live.lisa.data.kb_products) ? _live.lisa.data.kb_products : [];
      for (const p of prods) {
        if (!p?.naam) continue;
        rows.push({
          onderwerp: p.naam,
          categorie: 'Aanbod',
          agents:    ['Lisa'],
          content:   p.beschrijving || '',
          updated:   _live.lisa.data.updated_at,
          bron:      'lisa_config.kb_products',
        });
      }
    }

    // Dedup gelijke onderwerpen door agents te mergen
    const dedup = new Map();
    for (const r of rows) {
      const k = r.onderwerp.toLowerCase();
      if (dedup.has(k)) {
        const cur = dedup.get(k);
        for (const ag of r.agents) if (!cur.agents.includes(ag)) cur.agents.push(ag);
      } else {
        dedup.set(k, { ...r });
      }
    }
    let all = Array.from(dedup.values());

    // Filters
    const f = _ui.kbFilter;
    if (f.agent !== 'all') all = all.filter((r) => r.agents.includes(f.agent));
    if (f.cat !== 'all')   all = all.filter((r) => (r.categorie || '').toLowerCase() === f.cat.toLowerCase());
    if (f.q) {
      const q = f.q.toLowerCase();
      all = all.filter((r) => (r.onderwerp || '').toLowerCase().includes(q) || (r.content || '').toLowerCase().includes(q));
    }

    // Counts per categorie
    const catCount = { Aanbod:0, Prijzen:0, Praktisch:0, 'Over ons':0, FAQ:0, Overig:0 };
    for (const r of all) catCount[r.categorie in catCount ? r.categorie : 'Overig']++;

    const totalCount = all.length;

    const errors = ['finance','events','onboarding'].filter((m) => _live.perConfig.error[m]);

    return `${_kbToolbar(catCount, totalCount)}
    ${errors.map((m) => errBlk('perConfig', 'kennisbank van ' + m + ' — ' + _live.perConfig.error[m], m)).join('')}
    ${_live.lisa.error ? errBlk('lisa', 'Lisa-kennisbank — ' + _live.lisa.error) : ''}
    ${all.length === 0
      ? `<div class="empty" style="padding:44px 20px"><div class="empty-t">Geen kennisbank-items</div>
         <div class="empty-s">Kennisbank-items bewerken doe je per agent: Joost/Simone/Mila in Wanbetalers/Events/Onboarding → Instellingen; Lisa in Lisa-module (Kennisbank-tab).</div></div>`
      : H.table(
          [{l:'Onderwerp'}, {l:'Categorie'}, {l:'Wie gebruikt dit', cls:'optional'}, {l:'Bijgewerkt', cls:'r optional'}, {l:'Bron', cls:'optional'}],
          all.map((r) => [
            `<div><div class="cell-main">${esc(r.onderwerp)}</div>
              ${r.content ? `<div style="font-size:11.5px;color:var(--text-3);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:340px">${esc(r.content)}</div>` : ''}</div>`,
            H.pill('neutral', r.categorie),
            `<div style="display:flex;gap:4px;flex-wrap:wrap">${r.agents.map((w) => {
              const ag = AGENTS_STATIC.find((x) => x.n === w);
              return `<span class="pill pill-neutral nodot" style="font-size:10.5px;padding:1.5px 7px">
                <span style="width:6px;height:6px;border-radius:50%;background:var(--${ag ? ag.c : 'slate'});display:inline-block;margin-right:4px"></span>${esc(w)}</span>`;
            }).join('')}</div>`,
            `<span class="mono" style="color:var(--text-3);font-size:12.5px">${fmtDate(r.updated)}</span>`,
            `<span class="mono" style="color:var(--text-3);font-size:11px">${esc(r.bron)}</span>`,
          ])
        )}
    ${nj('Kennisbank-upload/add-artikel-flow heeft geen endpoint. Prototype toont "+ Artikel"-knop en "X vragen die geen antwoord hadden"-paneel — beide vereisen (1) een centrale kennisbank-tabel of KB-schrijf per agent, en (2) een unmatched-questions log. Voor nu: bewerken via agent-Config-tab.')}
    ${_kbUnansweredPlaceholder()}`;
  }

  function _kbCat(key) {
    const k = String(key || '').toLowerCase();
    if (/prijs|betaal|termijn|kwijt|kort/.test(k)) return 'Prijzen';
    if (/product|traject|membership|event|coach/.test(k)) return 'Aanbod';
    if (/hoe|wanneer|welke|tijd|uur|dag|documenten|onboarding/.test(k)) return 'Praktisch';
    if (/wie|team|mentor|over/.test(k))         return 'Over ons';
    return 'Overig';
  }

  function _kbToolbar(catCount, totalCount) {
    const agentOptions = ['all', ...AGENTS_STATIC.filter((a) => a.config).map((a) => a.n)];
    const cats = [
      { l:'Alles',     v:'all',        n:totalCount },
      { l:'Aanbod',    v:'aanbod',     n:catCount.Aanbod },
      { l:'Prijzen',   v:'prijzen',    n:catCount.Prijzen },
      { l:'Praktisch', v:'praktisch',  n:catCount.Praktisch },
      { l:'Over ons',  v:'over ons',   n:catCount['Over ons'] },
      { l:'FAQ',       v:'faq',        n:catCount.FAQ },
    ];
    return `<div class="toolbar" style="padding:12px 20px;gap:8px;flex-wrap:wrap;border-bottom:1px solid var(--border)">
      <select class="filter-sel" onchange="window.__agKbAgent(this.value)">
        ${agentOptions.map((o) => `<option value="${esc(o)}" ${_ui.kbFilter.agent === o ? 'selected' : ''}>${o === 'all' ? 'Alle agents' : esc(o)}</option>`).join('')}
      </select>
      ${cats.map((c) => `<button class="chip ${_ui.kbFilter.cat === c.v ? 'on' : ''}" onclick="window.__agKbCat('${c.v}')">${esc(c.l)}${c.n !== undefined ? `<span class="cnt">${c.n}</span>` : ''}</button>`).join('')}
      <div class="tb-search"><input placeholder="Zoek artikel…" value="${esc(_ui.kbFilter.q)}" oninput="window.__agKbQ(this.value)" style="border:1px solid var(--border);padding:6px 10px;border-radius:8px;background:var(--surface);color:var(--text-1);font-size:12.5px" /></div>
      <div class="tb-right"><button class="btn btn-primary btn-sm" onclick="alert('Kennisbank + Artikel-endpoint ontbreekt (backend-gap). Bewerk per agent via Wanbetalers/Events/Onboarding → Instellingen of Lisa-module.')">${svg(I.plus)}Artikel</button></div>
    </div>`;
  }
  window.__agKbAgent = (v) => { _ui.kbFilter.agent = v; if (window.DFO?.render) window.DFO.render(); };
  window.__agKbCat   = (v) => { _ui.kbFilter.cat = v; if (window.DFO?.render) window.DFO.render(); };
  window.__agKbQ     = (v) => { _ui.kbFilter.q = v; if (window.DFO?.render) window.DFO.render(); };

  function _kbUnansweredPlaceholder() {
    return `<div style="padding:16px 20px">
      <div style="padding:13px 15px;background:var(--amber-soft);border:1px solid var(--amber-line);border-radius:var(--r);font-size:12.5px;color:var(--amber);line-height:1.55;display:flex;gap:10px;max-width:720px">
        ${svg(I.alert, 'width:15px;height:15px;flex-shrink:0;margin-top:1px')}
        <div>
          <b>"Vragen die geen antwoord hadden"-paneel</b> — prototype toont een top-5 uit unmatched Joost-suggestions (intent=general_question + confidence &lt; 0.5) + Lisa-messages zonder KB-match. Endpoint ontbreekt (needs Jeffrey: aggregate query op joost_suggestions/lisa_messages met filter op unmatched-signaal + "Toevoegen aan kennisbank"-write).
        </div>
      </div>
    </div>`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // VIEW 4 — PRESTATIES
  // ═══════════════════════════════════════════════════════════════════════
  function prestatiesView() {
    if (!_live.activity.data && !_live.activity.loading && !_live.activity.error) queueMicrotask(fetchActivity);
    if (_live.activity.error && !_live.activity.data) return errBlk('activity', _live.activity.error);
    if (_live.activity.loading && !_live.activity.data) return skel();

    const activity = _live.activity.data || {};
    const trio = asArr(activity.trio);
    const lisa = activity.lisa || {};

    // KPI's — totals over vandaag
    let totalMsgs = 0;
    for (const t of trio) totalMsgs += Number(t.messages_today || 0);
    totalMsgs += Number(lisa.messages_today || 0);
    let totalHandoffs = 0;
    for (const t of trio) totalHandoffs += Number(t.handoffs || 0);
    totalHandoffs += Number(lisa.human_takeover || 0);
    let totalOpen = 0;
    for (const t of trio) totalOpen += Number(t.open_suggestions || 0);
    const zelfPct = totalMsgs ? Math.max(0, Math.round(100 * (1 - totalHandoffs / totalMsgs))) + '%' : '—';

    // Per-agent rijen — 3 trio-modules + Lisa
    const perAgentRows = [];
    for (const t of trio) {
      const ag = AGENTS_STATIC.find((a) => a.backend === t.module);
      if (!ag) continue;
      const msg = Number(t.messages_today || 0);
      const hnd = Number(t.handoffs || 0);
      const zelf = msg ? Math.max(0, Math.round(100 * (1 - hnd / msg))) + '%' : '—';
      const beoord = msg && hnd / Math.max(1, msg) < 0.15 ? 'ok' : (hnd / Math.max(1, msg) < 0.35 ? 'warn' : 'danger');
      perAgentRows.push([ag, msg, zelf, hnd, '—', fmtNum(t.open_suggestions) + ' open', beoord]);
    }
    // Lisa
    const lisaAg = AGENTS_STATIC.find((a) => a.id === 'lisa');
    if (lisaAg) {
      const msg = Number(lisa.messages_today || 0);
      const hnd = Number(lisa.human_takeover || 0);
      const zelf = msg ? Math.max(0, Math.round(100 * (1 - hnd / msg))) + '%' : '—';
      const beoord = msg && hnd / Math.max(1, msg) < 0.15 ? 'ok' : (hnd / Math.max(1, msg) < 0.35 ? 'warn' : 'danger');
      perAgentRows.push([lisaAg, msg, zelf, hnd, '—', fmtNum(lisa.call_booked) + ' calls', beoord]);
    }

    return `${H.kpis([
      { c:'violet',  icon:I.chat,  label:'Gesprekken vandaag',   val:fmtNum(totalMsgs),   hi:1, sub:'trio + Lisa' },
      { c:'emerald', icon:I.tick,  label:'Zelf afgehandeld',     val:zelfPct,              hi:1, sub:'geschat uit handoff-ratio' },
      { c:'amber',   icon:I.users, label:'Overgenomen',          val:fmtNum(totalHandoffs),hi:1, sub:'human takeover' },
      { c:'blue',    icon:I.clock, label:'Reactietijd',          val:'—',                  sub:'endpoint ontbreekt' },
    ])}
    ${nj('KPI "Reactietijd" heeft geen endpoint (vereist avg(gap tussen inbound → agent-reply) uit whatsapp_messages/lisa_messages). "Zelf afgehandeld %" hier is geschat uit 1 − (handoffs / messages_today) — proxy, geen echte outcome-telling.')}

    <div class="pad"><div class="card" style="margin-bottom:14px">
      <div class="card-head">
        <span class="tile-ico" style="background:var(--violet-soft);color:var(--violet)">${svg(I.chart)}</span>
        <div class="card-title">Per agent — vandaag</div>
        <span style="margin-left:auto;font-size:11px;color:var(--text-3)">bron: /api/agents-activity</span>
      </div>
      ${perAgentRows.length === 0
        ? `<div class="empty" style="padding:44px 20px"><div class="empty-t">Geen activity-data</div><div class="empty-s">Trio + Lisa hebben vandaag nog geen berichten of open suggesties.</div></div>`
        : H.table(
            [{l:'Agent'}, {l:'Berichten', cls:'r'}, {l:'Zelf afgehandeld', cls:'r'}, {l:'Overgenomen', cls:'r optional'}, {l:'Reactietijd', cls:'r optional'}, {l:'Resultaat', cls:'r'}, {l:'Beoordeling'}],
            perAgentRows.map(([ag, g, z, o, r, res, cls]) => [
              `<div style="display:flex;align-items:center;gap:9px">${_radial(ag.c, 24)}<span class="cell-main">${esc(ag.n)}</span></div>`,
              `<span class="mono">${g}</span>`,
              `<span class="pill pill-${cls} nodot">${esc(z)}</span>`,
              `<span class="mono">${o}</span>`,
              `<span class="mono" style="color:var(--text-3)">${esc(r)}</span>`,
              `<span style="font-size:12.5px;color:var(--text-2)">${esc(res)}</span>`,
              `<div style="display:flex;gap:3px;justify-content:flex-end">
                <button class="icon-btn" style="width:24px;height:24px" title="Goed (beoordeling-endpoint ontbreekt)" onclick="alert('Beoordeling-endpoint ontbreekt (needs Jeffrey).')">${svg('<path d="M7 10v12M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88z"/>','width:13px;height:13px')}</button>
                <button class="icon-btn" style="width:24px;height:24px" title="Kon beter" onclick="alert('Beoordeling-endpoint ontbreekt (needs Jeffrey).')">${svg('<path d="M17 14V2M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88z"/>','width:13px;height:13px')}</button>
              </div>`,
            ])
          )}
    </div>

    <div class="grid g2">
      <div class="card"><div class="card-head">
        <span class="tile-ico" style="background:var(--blue-soft);color:var(--blue)">${svg(I.chart)}</span>
        <div class="card-title">Gesprekken per week</div></div>
        <div class="card-body" style="padding:24px;text-align:center;color:var(--text-3);font-size:13px">
          Weekly bucketing-endpoint ontbreekt. ${gapBadge('Geen tijdreeks-agg')}
        </div></div>
      <div class="card"><div class="card-head">
        <span class="tile-ico" style="background:var(--amber-soft);color:var(--amber)">${svg(I.users)}</span>
        <div class="card-title">Waarom er wordt overgenomen</div></div>
        <div class="card-body" style="padding:24px;text-align:center;color:var(--text-3);font-size:13px">
          Reden-classificatie op handoffs ontbreekt. ${gapBadge('Geen reason-breakdown')}
        </div></div>
    </div>
    </div>`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // REGISTREREN
  // ═══════════════════════════════════════════════════════════════════════
  window.DFO.VIEWS['agents/Overzicht']    = overzichtView;
  window.DFO.VIEWS['agents/Configuratie'] = configuratieView;
  window.DFO.VIEWS['agents/Kennisbank']   = kennisbankView;
  window.DFO.VIEWS['agents/Prestaties']   = prestatiesView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('agents');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('agents');
  console.debug('[agents-v2] uitbouw-ronde geregistreerd (dormant, prototype-parity v45)');
})();
