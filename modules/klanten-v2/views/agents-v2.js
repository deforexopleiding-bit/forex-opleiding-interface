// modules/klanten-v2/views/agents-v2.js
//
// AI Agents-hub — Fase 1 consolidatie (2026-08-13). Dormant. QA via ?v2preview=agents.
//
// Endpoints (read):
//   GET  /api/agents-config-list          (admin.joost_config)
//   GET  /api/agents-activity             (admin.joost_config)
//   GET  /api/agents-background-stats     (admin.joost_config)             ← Fase 1 nieuw
//   GET  /api/joost-config-get?module=<m> (admin.joost_config OR view)
//   GET  /api/lisa-config                 (verifyAdmin + lisa.config.view)
//   GET  /api/lisa-config?action=history  (idem)
//   GET  /api/lisa-settings               (verifyAdmin)
//   GET  /api/agent-approval?action=list
//
// Endpoints (write, alleen niet-Joost-protected):
//   POST /api/joost-config-upsert         { module, persona_name?, persona_tone?,
//                                           system_prompt_template?, knowledge_base?,
//                                           model?, temperature?, context_message_count?,
//                                           is_enabled? }
//     - module=events  → admin.simone_config
//     - module=onboarding/finance → admin.joost_config
//     Voor Joost (finance): persona_name/persona_tone/system_prompt_template/knowledge_base
//     zijn hier BEWERKBAAR. model/temperature/context_message_count vragen een
//     bevestigings-modal (UI-side) omdat ze de incasso-flow kunnen beïnvloeden.
//     autonomy_config + feature_flags blijven READ-ONLY in de UI en worden hier
//     nooit meegestuurd (bewerken via de bestaande admin-Joost-flow).
//
//   POST /api/lisa-config?action=save_draft  { fields }   → lisa_config draft UPDATE
//   POST /api/lisa-config?action=publish     { fields }   → nieuwe actieve versie
//   POST /api/lisa-config?action=rollback    { version }  → oude versie herstellen
//   POST /api/lisa-settings                  { live_mode_enabled }
//
// Fase-1 scope-grenzen:
//   - GEEN schema-wijziging.
//   - Joost autonomy_config + feature_flags READ-ONLY.
//   - Lisa productie-flow ONAANGERAAKT (bridge via bestaande lisa-config endpoints).
//   - Achtergrond-agents tonen echte 24u-tellers uit dunning_gesprek_analyse +
//     email_classifications; lead-scoring blijft eerlijk "Nog niet gekoppeld".

(function () {
  if (!window.DFO) { console.error('[agents-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[agents-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg } = window.DFO;
  const H = window.KV_V2.helpers;

  const asArr = (x) => Array.isArray(x) ? x : [];
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const fmtNum = (n) => (Number(n || 0)).toLocaleString('nl-NL');
  const fmtDate = (iso) => iso ? new Date(iso).toLocaleString('nl-NL', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : '—';

  // ═══════════════════════════════════════════════════════════════════════
  // CANONICAL AGENT LIST
  // ═══════════════════════════════════════════════════════════════════════
  const AGENTS_STATIC = [
    { id:'lisa',    n:'Lisa',    rol:'Instagram',      d:'Voert Instagram-gesprekken en boekt kennismakingscalls',
      c:'violet',  mod:'Lisa — Instagram',  modId:'lisa',            kan:['Instagram'],        config:true,  backend:'lisa' },
    { id:'joost',   n:'Joost',   rol:'Aanmaningen',    d:'Voert gesprekken met wanbetalers en stelt betaalregelingen voor',
      c:'amber',   mod:'Wanbetalers',       modId:'wanbetalers',     kan:['WhatsApp','E-mail'],config:true, lock:true, backend:'finance' },
    { id:'simone',  n:'Simone',  rol:'Events',         d:'Beantwoordt vragen over events, aanmeldingen en de vragenlijst',
      c:'pink',    mod:'Events',            modId:'events',          kan:['WhatsApp','E-mail'],config:true, backend:'events' },
    { id:'mila',    n:'Mila',    rol:'Onboarding',     d:'Begeleidt nieuwe klanten door de onboardingflow',
      c:'emerald', mod:'Onboarding',        modId:'onboarding',      kan:['WhatsApp','E-mail'],config:true, backend:'onboarding' },
    { id:'aisha',   n:'Aisha',   rol:'Leadsonderhoud', d:'Houdt contact met leads die nog niet klaar zijn',
      c:'teal',    mod:'Leadsonderhoud',    modId:'leadsonderhoud',  kan:['WhatsApp','E-mail'],config:true, backend:'leadsonderhoud' },
    { id:'manager', n:'AI Manager', rol:'Bedrijfsvragen', d:'Beantwoordt vragen over je bedrijf op basis van je eigen data',
      c:'blue',    mod:'Dashboard',         modId:'dashboard',       kan:['Dashboard'],        config:true, backend:'manager' },
    // Achtergrond
    { id:'analyse',   n:'Gespreksanalyse',       rol:'Achtergrond', d:'Leest gesprekken en herkent betaalafspraken en signalen',
      c:'slate', mod:'Wanbetalers', modId:'wanbetalers', kan:['Achtergrond'], config:false, backend:'bg-analyse', ic:'eye' },
    { id:'mailsort',  n:'E-mail categorisatie',  rol:'Achtergrond', d:'Sorteert binnenkomende mail en koppelt aan klanten',
      c:'blue',  mod:'E-mail',      modId:'email',       kan:['Achtergrond'], config:false, backend:'bg-mail',    ic:'mail' },
    { id:'scoring',   n:'Lead-scoring',          rol:'Achtergrond', d:'Geeft leads een kwalificatiescore op basis van hun antwoorden',
      c:'slate', mod:'Leads',       modId:'leads',       kan:['Achtergrond'], config:false, backend:null,          ic:'target' },
  ];

  // ═══════════════════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════════════════
  const _live = {
    configList: { loading: false, error: null, data: null },
    activity:   { loading: false, error: null, data: null },
    approval:   { loading: false, error: null, data: null },
    perConfig:  { loading: {}, error: {}, data: {} },   // trio joost_config per module
    lisa:       { loading: false, error: null, data: null },  // actieve lisa_config
    lisaHist:   { loading: false, error: null, data: null },  // versie-history
    lisaSet:    { loading: false, error: null, data: null },  // lisa_settings singleton
    bg:         { loading: false, error: null, data: null },  // achtergrond-tellers
    prest:      { loading: false, error: null, data: null },  // prestaties-extended (weekly + response + fb)
    kbArt:      { loading: false, error: null, data: null },  // kennisbank_artikelen
    kbUnm:      { loading: false, error: null, data: null },  // kennisbank_unmatched
  };

  const _ui = {
    agSel: 'lisa',
    agCfgTab: 'Persona',
    kbFilter: { agent: 'all', cat: 'all', q: '' },
    saving: {},
    dirty:  {},       // dirty[agentId] = { field: value }
    saved:  {},
    toggling: {},     // toggling[agentId] = true (voor live-toggle spinner)
    confirmed: {},    // confirmed[agentId] = { model:true, temperature:true, ... }
    lisaHistOpen: false,
    // Sandbox chat-state per agent-id
    sandbox: {},      // sandbox[agentId] = { history:[{role,content}], sending:bool, input:'' }
    // Kennisbank-artikel modal state
    artModal: null,   // null | { mode:'create'|'edit', item:{...} }
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
  async function fetchLisaHistory() {
    const st = _live.lisaHist; if (st.loading) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('lisa-history', '/api/lisa-config?action=history');
    st.loading = false;
    if (j && j.__error) st.error = j.__error; else st.data = asArr(j?.versions || j?.history || j);
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchLisaSettings() {
    const st = _live.lisaSet; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('lisa-settings', '/api/lisa-settings');
    st.loading = false;
    if (j && j.__error) st.error = j.__error; else st.data = j?.settings || j || null;
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchBg() {
    const st = _live.bg; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('bg-stats', '/api/agents-background-stats');
    st.loading = false;
    if (j && j.__error) st.error = j.__error; else st.data = j || null;
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchPrest() {
    const st = _live.prest; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('prest', '/api/agents-prestaties-extended', undefined, 15000);
    st.loading = false;
    if (j && j.__error) st.error = j.__error; else st.data = j || null;
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchKbArt() {
    const st = _live.kbArt; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('kbArt', '/api/kennisbank-artikelen?limit=500');
    st.loading = false;
    if (j && j.__error) st.error = j.__error; else st.data = asArr(j?.items);
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchKbUnm() {
    const st = _live.kbUnm; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('kbUnm', '/api/kennisbank-unmatched?limit=50');
    st.loading = false;
    if (j && j.__error) st.error = j.__error; else st.data = asArr(j?.items);
    if (window.DFO?.render) window.DFO.render();
  }

  window.__agRetry = (b, mod) => {
    if (b === 'perConfig' && mod) { _live.perConfig.data[mod] = null; _live.perConfig.error[mod] = null; fetchPerConfig(mod); return; }
    if (_live[b]) { _live[b].data = null; _live[b].error = null; }
    if (b === 'configList') fetchConfigList();
    if (b === 'activity')   fetchActivity();
    if (b === 'approval')   fetchApproval();
    if (b === 'lisa')       fetchLisaConfig();
    if (b === 'lisaSet')    fetchLisaSettings();
    if (b === 'bg')         fetchBg();
    if (b === 'prest')      fetchPrest();
    if (b === 'kbArt')      fetchKbArt();
    if (b === 'kbUnm')      fetchKbUnm();
  };

  // ═══════════════════════════════════════════════════════════════════════
  // SHARED BUILDING BLOCKS
  // ═══════════════════════════════════════════════════════════════════════
  const errBlk = (block, msg, arg) => `<div style="margin:14px 20px;padding:12px 16px;border:1px solid var(--rose-line);background:var(--rose-soft);border-radius:var(--r);color:var(--rose);font-size:13px;display:flex;align-items:center;gap:12px">
    <span>${svg(I.alert, 'width:16px;height:16px')}</span>
    <span style="flex:1">Kon ophalen: ${esc(msg)}${/401|403/.test(msg || '') ? ' — admin/super_admin vereist' : ''}</span>
    <button class="btn btn-ghost btn-sm" onclick="__agRetry('${block}'${arg ? `,'${arg}'` : ''})">Opnieuw</button></div>`;
  const skel = () => `<div class="pad"><div class="card"><div class="card-body" style="padding:22px;opacity:.55"><div style="height:12px;background:var(--surface-2);border-radius:4px;width:60%;margin-bottom:12px"></div><div style="height:12px;background:var(--surface-2);border-radius:4px;width:40%"></div></div></div></div>`;
  const soon = (title, sub) => `<div style="padding:36px 20px;text-align:center;color:var(--text-3)">
    <span style="display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:50%;background:var(--surface-2);margin-bottom:12px">${svg(I.clock, 'width:20px;height:20px;opacity:.7')}</span>
    <div style="font-size:13.5px;font-weight:600;color:var(--text-2);margin-bottom:4px">${esc(title)}</div>
    ${sub ? `<div style="font-size:12px;line-height:1.5;max-width:360px;margin:0 auto">${esc(sub)}</div>` : ''}
  </div>`;
  const softPill = () => `<span class="pill pill-neutral nodot" style="font-size:10.5px;padding:1.5px 8px;opacity:.75">Nog niet gekoppeld</span>`;

  function _channelPill(k) {
    const map = { 'WhatsApp':'ok','Instagram':'accent','E-mail':'neutral','Dashboard':'accent','Achtergrond':'neutral' };
    return `<span class="pill pill-${map[k] || 'neutral'} nodot" style="font-size:10.5px;padding:1.5px 7px">${esc(k)}</span>`;
  }
  function _radial(color, size) {
    size = size || 38;
    return `<span style="width:${size}px;height:${size}px;border-radius:50%;flex-shrink:0;display:inline-block;
      background:radial-gradient(circle at 32% 30%,color-mix(in srgb,var(--${color}) 45%,white),var(--${color}) 72%);
      box-shadow:0 2px 10px -2px var(--${color})"></span>`;
  }
  function _liveFor(agent, cfgList) {
    if (!agent.backend || !Array.isArray(cfgList) || agent.backend.startsWith('bg-')) return null;
    if (agent.backend === 'lisa') return cfgList.find((r) => r.type === 'lisa') || null;
    return cfgList.find((r) => r.type === 'joost_config' && r.module === agent.backend) || null;
  }
  function _trioStat(agent, activity) {
    if (!activity || !Array.isArray(activity.trio)) return null;
    return activity.trio.find((r) => r.module === agent.backend) || null;
  }
  const _lisaStat = (activity) => activity?.lisa || null;

  // Lisa productie-live = lisa_settings.live_mode_enabled (via channel.active).
  function _lisaIsLive(cfgList) {
    const l = Array.isArray(cfgList) ? cfgList.find((r) => r.type === 'lisa') : null;
    return l?.channel?.active === true;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // VIEW 1 — OVERZICHT
  // ═══════════════════════════════════════════════════════════════════════
  function overzichtView() {
    if (!_live.configList.data && !_live.configList.loading && !_live.configList.error) queueMicrotask(fetchConfigList);
    if (!_live.activity.data   && !_live.activity.loading   && !_live.activity.error)   queueMicrotask(fetchActivity);
    if (!_live.approval.data   && !_live.approval.loading   && !_live.approval.error)   queueMicrotask(fetchApproval);
    if (!_live.bg.data         && !_live.bg.loading         && !_live.bg.error)         queueMicrotask(fetchBg);

    if (_live.configList.error && !_live.configList.data) return errBlk('configList', _live.configList.error);
    if (_live.configList.loading && !_live.configList.data) return skel();

    const cfgList  = asArr(_live.configList.data);
    const activity = _live.activity.data || {};
    const approvals = asArr(_live.approval.data);
    const waitCount = approvals.filter((a) => (a?.status === 'pending' || a?.status === 'awaiting_approval')).length;

    const backedAgents = AGENTS_STATIC.filter((a) => !!a.backend && !a.backend.startsWith('bg-'));
    const activeCount = backedAgents.filter((a) => {
      const l = _liveFor(a, cfgList);
      if (!l) return false;
      if (a.backend === 'lisa') return l?.channel?.active === true;
      return l.is_enabled === true;
    }).length;

    let messagesToday = 0;
    if (activity.trio) for (const t of activity.trio) messagesToday += Number(t.messages_today || 0);
    messagesToday += Number(activity.lisa?.messages_today || 0);
    let handoffs = 0;
    if (activity.trio) for (const t of activity.trio) handoffs += Number(t.handoffs || 0);
    handoffs += Number(activity.lisa?.human_takeover || 0);

    const conv = AGENTS_STATIC.filter((a) => a.rol !== 'Achtergrond');
    const bg   = AGENTS_STATIC.filter((a) => a.rol === 'Achtergrond');

    return `${H.kpis([
      { c:'violet',  icon:I.bot,   label:'Actieve agents',       val:String(activeCount), sub:'van ' + backedAgents.length + ' ingericht' },
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
    </div>`;
  }

  function _overzichtConvCard(a, cfgList, activity) {
    const live = _liveFor(a, cfgList);
    const isLive = a.backend === 'lisa' ? live?.channel?.active === true : live?.is_enabled === true;
    const stat   = a.backend === 'lisa' ? _lisaStat(activity) : _trioStat(a, activity);

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

    const noBackend = !a.backend;
    const persona = live?.persona_name || a.n;
    const toggling = !!_ui.toggling[a.id];

    // Live-toggle-knop (Lisa via lisa-settings, trio via is_enabled). Aisha/AI Manager niet.
    const toggleBtn = noBackend ? '' : `
      <button class="switch ${isLive ? 'on' : ''}" ${toggling ? 'disabled' : ''} onclick="event.stopPropagation();window.__agToggleLive('${a.id}')" title="${isLive ? 'Zet uit' : 'Zet aan'}" style="border:none;padding:0;${toggling ? 'opacity:.5;cursor:wait' : ''}"></button>`;

    return `<div class="card" ${noBackend ? '' : `onclick="window.__agGoConfig('${a.id}')"`} style="${noBackend ? 'opacity:.68' : 'cursor:pointer;transition:transform .15s,box-shadow .15s'}" ${noBackend ? '' : `onmouseover="this.style.transform='translateY(-2px)';this.style.boxShadow='0 6px 20px -8px rgba(0,0,0,.15)'" onmouseout="this.style.transform='';this.style.boxShadow=''"`}>
      <div style="padding:15px 17px;display:flex;align-items:flex-start;gap:12px">
        ${_radial(a.c, 38)}
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">
            <span class="card-title">${esc(persona)}</span>
            ${a.lock ? `<span class="pill pill-warn nodot" style="font-size:10px;padding:1.5px 7px;display:inline-flex;align-items:center;gap:4px">${svg(I.shield, 'width:9px;height:9px')}Beschermd</span>` : ''}
          </div>
          <div style="font-size:11.5px;color:var(--${a.c});font-weight:500;margin-top:2px">${esc(a.rol)}</div>
          <div style="font-size:12px;color:var(--text-3);margin-top:4px;line-height:1.45">${esc(a.d)}</div>
        </div>
        ${toggleBtn}
      </div>
      <div style="padding:0 17px 12px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
        ${noBackend ? softPill() : (isLive ? H.pill('ok','Live') : H.pill('neutral','Uit'))}
        ${a.kan.map(_channelPill).join('')}
      </div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--border);border-top:1px solid var(--border)">
        ${stats.map(([v, l]) => `<div style="background:var(--surface);padding:10px 12px;text-align:center">
          <div style="font-size:17px;font-weight:600;font-family:'IBM Plex Mono',monospace;letter-spacing:-.03em">${esc(v)}</div>
          <div style="font-size:10px;letter-spacing:.05em;color:var(--text-3);margin-top:2px">${esc(l)}</div></div>`).join('')}
      </div>
    </div>`;
  }

  function _overzichtBgCard(a) {
    const bg = _live.bg.data;
    let stats = null;
    if (a.backend === 'bg-analyse' && bg?.gespreks_analyse) {
      stats = [
        [fmtNum(bg.gespreks_analyse.total_24h),         'GEANALYSEERD 24U'],
        [fmtNum(bg.gespreks_analyse.afspraken_herkend), 'AFSPRAKEN HERKEND'],
      ];
    } else if (a.backend === 'bg-mail' && bg?.email_categorisatie) {
      stats = [
        [fmtNum(bg.email_categorisatie.total_24h),       'GESORTEERD 24U'],
        [fmtNum(bg.email_categorisatie.high_confidence), '≥80% ZEKER'],
      ];
    }
    return `<div class="card" style="opacity:.92">
      <div class="card-body" style="padding:15px 17px">
        <div style="display:flex;align-items:flex-start;gap:11px;margin-bottom:11px">
          <span class="tile-ico" style="background:var(--${a.c}-soft);color:var(--${a.c})">${svg(I[a.ic] || I.bot)}</span>
          <div style="flex:1;min-width:0">
            <div class="card-title">${esc(a.n)}</div>
            <div style="font-size:12px;color:var(--text-3);margin-top:3px;line-height:1.45">${esc(a.d)}</div>
          </div>
          ${(() => {
            // Bug 4: 3-status pill — Actief (activiteit>0), Wacht op werk
            // (bron aangesloten maar 0), Nog niet gekoppeld (geen bron).
            if (!stats) return softPill();
            const anyActivity = Array.isArray(stats) && stats.some((row) => Number(String(row[0]).replace(/[^0-9.]/g, '')) > 0);
            return anyActivity ? H.pill('ok', 'Actief') : H.pill('neutral', 'Wacht op werk');
          })()}
        </div>
        ${stats ? `<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:1px;background:var(--border);border-top:1px solid var(--border);margin:0 -17px -15px">
          ${stats.map(([v, l]) => `<div style="background:var(--surface);padding:8px 10px;text-align:center">
            <div style="font-size:15px;font-weight:600;font-family:'IBM Plex Mono',monospace">${esc(v)}</div>
            <div style="font-size:10px;letter-spacing:.05em;color:var(--text-3);margin-top:1px">${esc(l)}</div></div>`).join('')}
        </div>` : ''}
      </div>
    </div>`;
  }

  window.__agGoConfig = (id) => {
    _ui.agSel = id;
    _ui.agCfgTab = 'Persona';
    if (window.DFO?.setTab) window.DFO.setTab('Configuratie');
    else if (window.DFO?.render) window.DFO.render();
  };

  // ═══════════════════════════════════════════════════════════════════════
  // LIVE-TOGGLE (Overzicht + Configuratie)
  // ═══════════════════════════════════════════════════════════════════════
  window.__agToggleLive = async (agId) => {
    const a = AGENTS_STATIC.find((x) => x.id === agId);
    if (!a || !a.backend || a.backend.startsWith('bg-')) return;
    const live = _liveFor(a, asArr(_live.configList.data));
    const cur  = a.backend === 'lisa' ? live?.channel?.active === true : live?.is_enabled === true;
    const next = !cur;
    const label = next ? 'aanzetten' : 'uitzetten';
    let msg;
    if (a.backend === 'lisa') {
      msg = 'Dit past lisa_settings.live_mode_enabled aan — Lisa gaat direct wél/geen berichten sturen naar Instagram-klanten.';
    } else if (a.lock) {
      msg = 'Joost aanmaan-flow wordt hiermee ' + (next ? 'geactiveerd' : 'gepauzeerd') + '. Autonomie-config blijft ongewijzigd.';
    } else if (a.id === 'aisha') {
      msg = next
        ? 'Aisha wordt aangezet in de config. LET OP: de bestaande leadsonderhoud-sjabloon-motor (cron-leadsonderhoud.js) is NIET aangepast in deze fase. Aisha stuurt daarom nog géén AI-berichten naar leads — de sjabloon-flow blijft ongewijzigd draaien. Voor productie-gebruik is een aparte cron-integratie-stap nodig. Nu al testbaar via Oefengesprek.'
        : 'Aisha wordt uitgezet. Dit heeft geen effect op de bestaande sjabloon-flow.';
    } else if (a.id === 'manager') {
      msg = next
        ? 'AI Manager wordt aangezet — super-admin-ai-manager gebruikt vanaf nu je persona-toon in zijn samenvattingen. De SQL-guard + read-only-views blijven ongewijzigd.'
        : 'AI Manager persona wordt uitgezet. super-admin-ai-manager valt terug op de hardcoded system-prompt (huidige gedrag).';
    } else {
      msg = 'De ' + a.n + '-flow wordt hiermee ' + (next ? 'geactiveerd' : 'gepauzeerd') + '.';
    }
    if (!window.confirm(a.n + ' ' + label + '?\n\n' + msg)) return;

    _ui.toggling[agId] = true;
    if (window.DFO?.render) window.DFO.render();
    try {
      if (a.backend === 'lisa') {
        const j = await window.KV.authedJson('/api/lisa-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ live_mode_enabled: next }),
        });
        if (j?.error) throw new Error(j.error);
      } else {
        // BUG 1 FIX (2e ronde) — toggle vanuit Overzicht heeft geen form-context.
        // Fetch ALTIJD eerst /api/joost-config-get?module=X (retourneert bestaande
        // rij OF spec-defaults met is_default:true) en bouw daaruit een VOLLEDIGE
        // upsert-body met ALLE NOT NULL kolommen defensief gecoercet. Zo landt
        // er nooit een null in system_prompt_template / persona_name / etc,
        // ongeacht of PostgREST INSERT of UPDATE-pad kiest.
        const body = await _buildFullBodyFromDb(a.backend, { is_enabled: next });
        // Extra fallback: gebruik agent-display-naam als persona_name leeg is.
        if (body.persona_name === 'Agent' && a.n) body.persona_name = a.n;
        const j = await window.KV.authedJson('/api/joost-config-upsert', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (j?.error) throw new Error(j.error);
      }
      _live.configList.data = null;
      _live.lisaSet.data = null;
      queueMicrotask(fetchConfigList);
      queueMicrotask(fetchLisaSettings);
    } catch (e) {
      alert('Kon niet ' + label + ': ' + (e?.message || 'onbekende fout'));
    } finally {
      _ui.toggling[agId] = false;
      if (window.DFO?.render) window.DFO.render();
    }
  };

  // ═══════════════════════════════════════════════════════════════════════
  // VIEW 2 — CONFIGURATIE (dispatcher)
  // ═══════════════════════════════════════════════════════════════════════
  function configuratieView() {
    if (!_live.configList.data && !_live.configList.loading && !_live.configList.error) queueMicrotask(fetchConfigList);
    if (_live.configList.error && !_live.configList.data) return errBlk('configList', _live.configList.error);
    if (_live.configList.loading && !_live.configList.data) return skel();

    const cfgList = asArr(_live.configList.data);
    const a = AGENTS_STATIC.find((x) => x.id === _ui.agSel) || AGENTS_STATIC[0];

    // Lazy: fetch config-details
    if (a.backend === 'lisa') {
      if (!_live.lisa.data && !_live.lisa.loading && !_live.lisa.error) queueMicrotask(fetchLisaConfig);
    } else if (a.backend && !a.backend.startsWith('bg-')) {
      if (!_live.perConfig.data[a.backend] && !_live.perConfig.loading[a.backend] && !_live.perConfig.error[a.backend]) {
        queueMicrotask(() => fetchPerConfig(a.backend));
      }
    }
    return _cfgHeader(a, cfgList) + _cfgLockBanner(a) + _cfgTabs(a) + _cfgBody(a, cfgList);
  }

  function _cfgHeader(a, cfgList) {
    const others = AGENTS_STATIC.filter((x) => x.config && x.backend).map((x) =>
      `<option value="${x.id}" ${x.id === _ui.agSel ? 'selected' : ''}>${esc(x.n)} — ${esc(x.rol)}</option>`).join('');
    // Live-toggle in header
    const live = _liveFor(a, cfgList);
    const isLive = a.backend === 'lisa' ? live?.channel?.active === true : (a.backend ? live?.is_enabled === true : false);
    const toggling = !!_ui.toggling[a.id];
    const hasBackend = a.backend && !a.backend.startsWith('bg-');
    return `<div style="padding:13px 20px;background:var(--${a.c}-soft);border-bottom:1px solid var(--${a.c}-line);display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      ${_radial(a.c, 32)}
      <div style="flex:1;min-width:150px">
        <div style="font-size:14px;font-weight:600">${esc(a.n)} <span style="font-weight:400;color:var(--text-3)">· ${esc(a.rol)}</span></div>
        <div style="font-size:12px;color:var(--text-3)">${esc(a.d)}</div>
      </div>
      ${hasBackend ? `<div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:11.5px;color:var(--text-3)">${isLive ? 'Aan' : 'Uit'}</span>
        <button class="switch ${isLive ? 'on' : ''}" ${toggling ? 'disabled' : ''} onclick="window.__agToggleLive('${a.id}')" title="${isLive ? 'Zet uit' : 'Zet aan'}" style="border:none;padding:0;${toggling ? 'opacity:.5;cursor:wait' : ''}"></button>
      </div>` : ''}
      ${a.lock ? `<span class="pill pill-warn nodot" style="display:inline-flex;align-items:center;gap:5px;font-size:11px;padding:2px 9px">${svg(I.shield, 'width:11px;height:11px')}Beschermd</span>` : ''}
      ${!a.backend ? softPill() : ''}
      <select class="filter-sel" onchange="window.__agSelChange(this.value)">${others}</select>
    </div>`;
  }
  window.__agSelChange = (v) => { _ui.agSel = v; _ui.agCfgTab = 'Persona'; if (window.DFO?.render) window.DFO.render(); };

  function _cfgLockBanner(a) {
    if (a.lock) {
      return `<div style="padding:13px 20px;background:var(--amber-soft);border-bottom:1px solid var(--amber-line);display:flex;gap:11px;align-items:flex-start;font-size:12.5px;color:var(--amber)">
        ${svg(I.shield, 'width:16px;height:16px;flex-shrink:0;margin-top:1px')}
        <span><b>Beschermde agent.</b> Persona, toon, systeem-prompt en kennisbank van Joost mag je hier bewerken. Model / temperatuur / context-vensters vragen een extra bevestiging omdat ze de incasso-flow kunnen beïnvloeden. <b>Autonomie en feature-flags</b> blijven read-only — wijzig je via <b>${esc(a.mod)} → Instellingen</b>.</span>
      </div>`;
    }
    if (a.id === 'aisha') {
      return `<div style="padding:13px 20px;background:var(--blue-soft);border-bottom:1px solid var(--blue-line);display:flex;gap:11px;align-items:flex-start;font-size:12.5px;color:var(--blue)">
        ${svg(I.alert, 'width:16px;height:16px;flex-shrink:0;margin-top:1px')}
        <span><b>Aisha AI-content staat standaard uit.</b> De bestaande leadsonderhoud-sjabloon-motor (<span class="mono">cron-leadsonderhoud.js</span>) is NIET aangepast in Fase 4. Aisha's AI-generatie is testbaar via <b>Oefengesprek</b>; voor productie-gebruik is een aparte cron-integratie-stap nodig waarin de is_enabled-vlag + feature_flags.aisha_ai_content_enabled worden gerespecteerd.</span>
      </div>`;
    }
    if (a.id === 'manager') {
      return `<div style="padding:13px 20px;background:var(--blue-soft);border-bottom:1px solid var(--blue-line);display:flex;gap:11px;align-items:flex-start;font-size:12.5px;color:var(--blue)">
        ${svg(I.alert, 'width:16px;height:16px;flex-shrink:0;margin-top:1px')}
        <span><b>AI Manager persona.</b> Persona-toon + is_enabled worden gebruikt door <span class="mono">super-admin-ai-manager.js</span> als preamble op zijn samenvattingen. Bij ontbrekende rij of uitgeschakelde vlag valt hij terug op de bestaande hardcoded system-prompt — huidige gedrag blijft dan intact.</span>
      </div>`;
    }
    return '';
  }

  function _cfgTabs(a) {
    let tabs;
    if (a.backend === 'lisa')      tabs = ['Persona','Fases','Kennisbank','Follow-ups','Autonomie','Beslissingen','Oefengesprek'];
    else if (a.backend)            tabs = ['Persona','Kennisbank','Autonomie','Beslissingen','Oefengesprek'];
    else                           tabs = ['Persona'];
    return `<div class="toolbar" style="padding:10px 20px 0;border-bottom:none;gap:6px;flex-wrap:wrap">
      ${tabs.map((t) => `<button class="chip ${_ui.agCfgTab === t ? 'on' : ''}" onclick="window.__agCfgTab('${t}')">${esc(t)}</button>`).join('')}
    </div>`;
  }
  window.__agCfgTab = (t) => { _ui.agCfgTab = t; if (window.DFO?.render) window.DFO.render(); };

  function _cfgBody(a, cfgList) {
    if (!a.backend) {
      return `<div class="pad" style="padding-top:14px"><div style="max-width:820px">
        <div class="card">${soon(a.n + ' — binnenkort te configureren', 'Deze agent staat op de roadmap. Zodra de koppeling live is verschijnen hier persona, mandaat en stopregels.')}</div>
      </div></div>`;
    }
    const tab = _ui.agCfgTab;
    if (a.backend === 'lisa') {
      if (tab === 'Persona')      return _lisaPersona();
      if (tab === 'Fases')        return _lisaFases();
      if (tab === 'Kennisbank')   return _lisaKB();
      if (tab === 'Follow-ups')   return _lisaFollowups();
      if (tab === 'Autonomie')    return _cfgAutonomie(a, null);
      if (tab === 'Beslissingen') return _cfgBeslissingen(a);
      if (tab === 'Oefengesprek') return _cfgOefengesprek(a);
      return _lisaPersona();
    }
    // Trio
    const cfg = _live.perConfig.data[a.backend] || null;
    if (!cfg && _live.perConfig.loading[a.backend]) return skel();
    if (_live.perConfig.error[a.backend]) return errBlk('perConfig', _live.perConfig.error[a.backend], a.backend);
    if (tab === 'Persona')      return _trioPersona(a, cfg);
    if (tab === 'Kennisbank')   return _trioKB(a, cfg);
    if (tab === 'Autonomie')    return _cfgAutonomie(a, cfg);
    if (tab === 'Beslissingen') return _cfgBeslissingen(a);
    if (tab === 'Oefengesprek') return _cfgOefengesprek(a);
    return _trioPersona(a, cfg);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // TRIO — PERSONA + KENNISBANK
  // ═══════════════════════════════════════════════════════════════════════
  function _trioPersona(a, cfg) {
    const dirty = _ui.dirty[a.id] || {};
    const v = (field, fallback) => (dirty[field] !== undefined ? dirty[field] : (cfg?.[field] != null ? cfg[field] : fallback));
    const sensitive = ['model','temperature','context_message_count'];

    return `<div class="pad" style="padding-top:14px"><div style="max-width:820px">
      <div class="card" style="margin-bottom:14px">
        <div class="card-head">
          <span class="tile-ico" style="background:var(--${a.c}-soft);color:var(--${a.c})">${svg(I.bot)}</span>
          <div class="card-title">Persona en toon</div>
        </div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:12px;padding-top:14px;padding-bottom:14px">
          ${_field('Naam',        'persona_name', v('persona_name', a.n), false, a)}
          ${_field('Toon',        'persona_tone', v('persona_tone', ''),  false, a, 'textarea')}
          ${_field('Systeem-prompt', 'system_prompt_template', v('system_prompt_template', ''), false, a, 'textarea-lg')}
        </div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="card-head">
          <span class="tile-ico" style="background:var(--slate-soft);color:var(--slate)">${svg(I.sliders)}</span>
          <div class="card-title">Model-instellingen</div>
          ${a.lock ? `<span class="pill pill-warn nodot" style="margin-left:auto;font-size:10.5px;padding:1.5px 7px">Bevestiging vereist</span>` : ''}
        </div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:12px;padding-top:14px;padding-bottom:14px">
          ${_field('Model',            'model',                 v('model', 'claude-sonnet-4-6'), false, a, 'select', ['claude-sonnet-4-6','claude-opus-4-7','claude-haiku-4-5'])}
          ${_field('Temperatuur',      'temperature',           v('temperature', 0.3), false, a, 'number', { min:0, max:1, step:0.1 })}
          ${_field('Context-berichten','context_message_count', v('context_message_count', 20), false, a, 'number', { min:5, max:50, step:1 })}
        </div>
      </div>

      ${_saveBar(a, sensitive)}
    </div></div>`;
  }

  function _trioKB(a, cfg) {
    const dirty = _ui.dirty[a.id] || {};
    // knowledge_base is jsonb-object. Wij tonen 3 speciale keys (dos/donts/stop_keywords) als lijstjes,
    // en de rest als key-value paren.
    const kb = (dirty.knowledge_base !== undefined) ? dirty.knowledge_base : (cfg?.knowledge_base || {});
    const kbSafe = (kb && typeof kb === 'object' && !Array.isArray(kb)) ? kb : {};
    const dos      = Array.isArray(kbSafe.dos) ? kbSafe.dos : [];
    const donts    = Array.isArray(kbSafe.donts) ? kbSafe.donts : [];
    const stopwrd  = Array.isArray(kbSafe.stop_keywords) ? kbSafe.stop_keywords : [];
    const overige  = Object.keys(kbSafe).filter((k) => !['dos','donts','stop_keywords'].includes(k)).sort();

    return `<div class="pad" style="padding-top:14px"><div style="max-width:820px">
      <div class="card" style="margin-bottom:14px">
        <div class="card-head">
          <span class="tile-ico" style="background:var(--emerald-soft);color:var(--emerald)">${svg(I.tick)}</span>
          <div class="card-title">Do's — wat ${esc(a.n)} altijd doet</div>
        </div>
        <div class="card-body">${_kbListEditor(a, 'dos', dos, 'Bijvoorbeeld: altijd tutoyeren')}</div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="card-head">
          <span class="tile-ico" style="background:var(--rose-soft);color:var(--rose)">${svg(I.x)}</span>
          <div class="card-title">Don'ts — wat ${esc(a.n)} nooit doet</div>
        </div>
        <div class="card-body">${_kbListEditor(a, 'donts', donts, 'Bijvoorbeeld: nooit prijzen noemen')}</div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="card-head">
          <span class="tile-ico" style="background:var(--amber-soft);color:var(--amber)">${svg(I.alert)}</span>
          <div class="card-title">Stopwoorden — direct doorzetten naar mens</div>
        </div>
        <div class="card-body">${_kbListEditor(a, 'stop_keywords', stopwrd, 'Bijvoorbeeld: klacht, incasso, advocaat')}</div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="card-head">
          <span class="tile-ico" style="background:var(--blue-soft);color:var(--blue)">${svg(I.book || I.doc)}</span>
          <div class="card-title">Overige kennis</div>
          <span style="margin-left:auto;font-size:11px;color:var(--text-3)">${overige.length} sleutel${overige.length === 1 ? '' : 's'}</span>
        </div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:10px">
          ${overige.length === 0
            ? `<div style="font-size:12.5px;color:var(--text-3);padding:8px 0">Nog geen extra kennis. Voeg een sleutel toe zoals <span class="mono">betaaltermijn_dagen</span> of <span class="mono">max_termijnen</span>.</div>`
            : overige.map((k) => _kbKeyValueRow(a, k, kbSafe[k])).join('')}
          <div style="display:flex;gap:8px;margin-top:4px">
            <input type="text" placeholder="Nieuwe sleutel (bv. betaaltermijn_dagen)" id="ag_${a.id}_newkbkey" style="flex:1;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);font-size:12.5px" />
            <button class="btn btn-ghost btn-sm" onclick="window.__agKbNewKey('${a.id}')">${svg(I.plus)}Toevoegen</button>
          </div>
        </div>
      </div>

      ${_saveBar(a, ['model','temperature','context_message_count'])}
    </div></div>`;
  }

  function _kbListEditor(a, key, items, placeholder) {
    return `<div style="display:flex;flex-direction:column;gap:6px">
      ${items.length === 0 ? `<div style="font-size:12.5px;color:var(--text-3);padding:4px 0">Nog geen items.</div>` : ''}
      ${items.map((item, i) => `<div style="display:flex;gap:6px;align-items:center">
        <input type="text" value="${esc(item)}" oninput="window.__agKbListSet('${a.id}','${key}',${i},this.value)" style="flex:1;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);font-size:12.5px" />
        <button class="icon-btn" onclick="window.__agKbListRemove('${a.id}','${key}',${i})" title="Verwijderen">${svg(I.trash || I.x, 'width:13px;height:13px')}</button>
      </div>`).join('')}
      <div style="display:flex;gap:6px;margin-top:2px">
        <input type="text" placeholder="${esc(placeholder)}" id="ag_${a.id}_${key}_new" style="flex:1;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);font-size:12.5px" onkeypress="if(event.key==='Enter'){event.preventDefault();window.__agKbListAdd('${a.id}','${key}')}" />
        <button class="btn btn-ghost btn-sm" onclick="window.__agKbListAdd('${a.id}','${key}')">${svg(I.plus)}</button>
      </div>
    </div>`;
  }
  function _kbKeyValueRow(a, key, val) {
    const disp = typeof val === 'object' ? JSON.stringify(val) : String(val);
    return `<div style="display:flex;gap:6px;align-items:center">
      <span class="mono" style="min-width:180px;font-size:12px;color:var(--text-2)">${esc(key)}</span>
      <input type="text" value="${esc(disp)}" oninput="window.__agKbKvSet('${a.id}','${esc(key)}',this.value)" style="flex:1;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);font-size:12.5px;font-family:'IBM Plex Mono',monospace" />
      <button class="icon-btn" onclick="window.__agKbKvRemove('${a.id}','${esc(key)}')" title="Verwijderen">${svg(I.trash || I.x, 'width:13px;height:13px')}</button>
    </div>`;
  }

  // KB-editor state-mutations
  function _getKbDraft(agId) {
    const a = AGENTS_STATIC.find((x) => x.id === agId);
    const cfg = a?.backend === 'lisa' ? _live.lisa.data : _live.perConfig.data[a?.backend];
    const dirty = _ui.dirty[agId] || {};
    if (dirty.knowledge_base !== undefined) return dirty.knowledge_base;
    const base = cfg?.knowledge_base || {};
    return (base && typeof base === 'object' && !Array.isArray(base)) ? { ...base } : {};
  }
  function _setKbDraft(agId, next) {
    _ui.dirty[agId] = _ui.dirty[agId] || {};
    _ui.dirty[agId].knowledge_base = next;
  }
  window.__agKbListSet = (agId, key, idx, val) => {
    const kb = _getKbDraft(agId); const arr = Array.isArray(kb[key]) ? [...kb[key]] : [];
    arr[idx] = val; kb[key] = arr; _setKbDraft(agId, kb);
  };
  window.__agKbListRemove = (agId, key, idx) => {
    const kb = _getKbDraft(agId); const arr = Array.isArray(kb[key]) ? [...kb[key]] : [];
    arr.splice(idx, 1); kb[key] = arr; _setKbDraft(agId, kb);
    if (window.DFO?.render) window.DFO.render();
  };
  window.__agKbListAdd = (agId, key) => {
    const input = document.getElementById('ag_' + agId + '_' + key + '_new');
    const val = (input?.value || '').trim(); if (!val) return;
    const kb = _getKbDraft(agId); const arr = Array.isArray(kb[key]) ? [...kb[key]] : [];
    arr.push(val); kb[key] = arr; _setKbDraft(agId, kb);
    if (window.DFO?.render) window.DFO.render();
  };
  window.__agKbKvSet = (agId, key, val) => {
    const kb = _getKbDraft(agId); kb[key] = val; _setKbDraft(agId, kb);
  };
  window.__agKbKvRemove = (agId, key) => {
    const kb = _getKbDraft(agId); delete kb[key]; _setKbDraft(agId, kb);
    if (window.DFO?.render) window.DFO.render();
  };
  window.__agKbNewKey = (agId) => {
    const input = document.getElementById('ag_' + agId + '_newkbkey');
    const key = (input?.value || '').trim(); if (!key) return;
    if (['dos','donts','stop_keywords'].includes(key)) { alert(key + ' is een gereserveerde sleutel (heeft eigen editor hierboven).'); return; }
    const kb = _getKbDraft(agId); if (kb[key] !== undefined) { alert('Sleutel bestaat al.'); return; }
    kb[key] = ''; _setKbDraft(agId, kb);
    if (window.DFO?.render) window.DFO.render();
  };

  function _field(label, name, v, ro, a, kind, options) {
    kind = kind || 'text';
    const id = 'ag_' + a.id + '_' + name;
    const inputStyle = 'width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text-1);font-size:13px;font-family:inherit';
    let input;
    if (ro) {
      input = `<div style="padding:8px 10px;background:var(--surface-2);border:1px solid var(--border);border-radius:8px;font-size:13px;color:var(--text-2)">${esc(v || '—')}</div>`;
    } else if (kind === 'textarea') {
      input = `<textarea id="${id}" oninput="window.__agFieldSet('${a.id}','${name}',this.value)" style="${inputStyle};min-height:70px;resize:vertical">${esc(v || '')}</textarea>`;
    } else if (kind === 'textarea-lg') {
      input = `<textarea id="${id}" oninput="window.__agFieldSet('${a.id}','${name}',this.value)" style="${inputStyle};min-height:180px;resize:vertical;font-family:'IBM Plex Mono',monospace;font-size:12px;line-height:1.55">${esc(v || '')}</textarea>`;
    } else if (kind === 'select') {
      input = `<select id="${id}" onchange="window.__agFieldSet('${a.id}','${name}',this.value)" style="${inputStyle}">
        ${(options || []).map((o) => `<option value="${esc(o)}" ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}
      </select>`;
    } else if (kind === 'number') {
      const opts = options || {};
      input = `<input id="${id}" type="number" ${opts.min != null ? `min="${opts.min}"` : ''} ${opts.max != null ? `max="${opts.max}"` : ''} ${opts.step != null ? `step="${opts.step}"` : ''} value="${esc(String(v))}" oninput="window.__agFieldSet('${a.id}','${name}',this.value,'number')" style="${inputStyle}" />`;
    } else if (kind === 'toggle') {
      const on = String(v) === 'true';
      input = `<button type="button" id="${id}" onclick="window.__agFieldSet('${a.id}','${name}', ${on ? 'false' : 'true'});window.DFO && window.DFO.render && window.DFO.render()" class="switch ${on ? 'on' : ''}" style="border:none;padding:0"></button>`;
    } else {
      input = `<input id="${id}" type="text" value="${esc(v || '')}" oninput="window.__agFieldSet('${a.id}','${name}',this.value)" style="${inputStyle}" />`;
    }
    return `<div style="display:grid;grid-template-columns:150px 1fr;gap:14px;align-items:center;padding:0 17px">
      <label for="${id}" style="font-size:12.5px;color:var(--text-2)">${esc(label)}</label>
      <div>${input}</div>
    </div>`;
  }
  window.__agFieldSet = (agId, field, v, kind) => {
    _ui.dirty[agId] = _ui.dirty[agId] || {};
    // Save-bar overgang detecteren: render pas als we van 0 → 1+ dirty-keys gaan
    // (of andersom). Tijdens continu typen géén render → textarea-cursor blijft
    // stabiel. Bij transitie 1x flikker voor knop-enable, daarna rustig.
    const before = Object.keys(_ui.dirty[agId]).length;
    let coerced = v;
    if (kind === 'number') coerced = v === '' ? null : Number(v);
    else if (v === 'true')  coerced = true;
    else if (v === 'false') coerced = false;
    _ui.dirty[agId][field] = coerced;
    if (before === 0 && window.DFO?.render) window.DFO.render();
  };

  function _saveBar(a, sensitiveFields) {
    const dirty = _ui.dirty[a.id] || {};
    const hasDirty = Object.keys(dirty).length > 0;
    const saving = _ui.saving[a.id] === true;
    const saved  = _ui.saved[a.id];
    return `<div style="padding:11px 17px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r);display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:14px">
      <button class="btn btn-primary btn-sm" ${(!hasDirty || saving) ? 'disabled style="opacity:.55;cursor:not-allowed"' : ''} onclick="window.__agSave('${a.id}',${JSON.stringify(sensitiveFields || []).replace(/"/g,'&quot;')})">
        ${svg(I.tick)}${saving ? 'Opslaan…' : 'Opslaan'}
      </button>
      <button class="btn btn-ghost btn-sm" ${(!hasDirty || saving) ? 'disabled style="opacity:.55"' : ''} onclick="window.__agReset('${a.id}')">Annuleren</button>
      ${saved ? `<span style="font-size:11.5px;color:var(--emerald)">✓ Opgeslagen ${new Date(saved).toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit'})}</span>` : ''}
      ${hasDirty ? `<span style="font-size:11px;color:var(--text-3);margin-left:auto">${Object.keys(dirty).length} wijziging${Object.keys(dirty).length === 1 ? '' : 'en'}</span>` : ''}
    </div>`;
  }
  window.__agReset = (agId) => { _ui.dirty[agId] = {}; if (window.DFO?.render) window.DFO.render(); };

  // ═══════════════════════════════════════════════════════════════════════
  // TOGGLE-BODY BUILDER — haalt ALTIJD eerst de volledige config op en
  // stuurt ALLE NOT NULL kolommen mee. Voorkomt scenario waar upsert een
  // bestaande rij "UPDATEt" maar alsnog NULL doorstuurt voor niet-
  // meegegeven kolommen, of INSERT waar DB-defaults niet toegepast worden.
  // Gebruikt door __agToggleLive.
  // ═══════════════════════════════════════════════════════════════════════
  async function _buildFullBodyFromDb(moduleKey, overrides) {
    const cfg = await _fetchDefaultsForModule(moduleKey) || {};
    // Coerce elke NOT NULL kolom defensief.
    const persona_name = (cfg.persona_name && String(cfg.persona_name).trim()) ? String(cfg.persona_name) : 'Agent';
    const persona_tone = (cfg.persona_tone && String(cfg.persona_tone).trim()) ? String(cfg.persona_tone) : 'vriendelijk-professioneel';
    const system_prompt_template = cfg.system_prompt_template == null ? '' : String(cfg.system_prompt_template);
    const knowledge_base = (cfg.knowledge_base && typeof cfg.knowledge_base === 'object' && !Array.isArray(cfg.knowledge_base))
      ? cfg.knowledge_base : {};
    const modelVal = (cfg.model && ['claude-sonnet-4-6','claude-opus-4-7','claude-haiku-4-5'].includes(cfg.model))
      ? cfg.model : 'claude-sonnet-4-6';
    const temperature = (cfg.temperature != null && Number.isFinite(Number(cfg.temperature)))
      ? Math.max(0, Math.min(1, Number(cfg.temperature))) : 0.3;
    const context_message_count = (cfg.context_message_count != null && Number.isInteger(Number(cfg.context_message_count)))
      ? Math.max(5, Math.min(50, Number(cfg.context_message_count))) : 10;
    const is_enabled = (cfg.is_enabled === true);
    const body = {
      module: moduleKey,
      persona_name,
      persona_tone,
      system_prompt_template,
      knowledge_base,
      model: modelVal,
      temperature,
      context_message_count,
      is_enabled,
      ...(overrides || {}),
    };
    // Protected-zone dubbele guard: nooit autonomy_config/feature_flags voor finance meesturen.
    if (moduleKey === 'finance') {
      delete body.autonomy_config;
      delete body.feature_flags;
    }
    return body;
  }

  // (Behouden voor _agSave — bouwt safe body op basis van partial dirty updates
  //  én bestaandheid van rij; wordt niet meer gebruikt door __agToggleLive.)
  async function _rowExistsForModule(moduleKey) {
    const cfgList = asArr(_live.configList.data);
    return cfgList.some((r) => r.type === 'joost_config' && r.module === moduleKey);
  }
  async function _fetchDefaultsForModule(moduleKey) {
    try {
      const j = await window.KV.authedJson('/api/joost-config-get?module=' + encodeURIComponent(moduleKey));
      if (j?.error) return null;
      return j?.config || null;
    } catch (_) { return null; }
  }
  // Bouw een save-body die veilig is voor zowel INSERT-pad (nieuwe rij) als
  // UPDATE-pad (bestaande rij). partialUpdates bevat alleen de user-wijzigingen.
  async function _buildSafeUpsertBody(moduleKey, partialUpdates) {
    const exists = await _rowExistsForModule(moduleKey);
    const body = { module: moduleKey, ...partialUpdates };
    if (exists) return body;
    // Nieuwe rij → haal defaults en vul NOT NULL text-kolommen expliciet in
    // voor zover niet al door de user gewijzigd.
    const defaults = await _fetchDefaultsForModule(moduleKey) || {};
    const NOT_NULL_TEXT_COLS = ['persona_name','persona_tone','system_prompt_template'];
    for (const k of NOT_NULL_TEXT_COLS) {
      if (body[k] === undefined) {
        body[k] = (defaults[k] != null ? String(defaults[k]) : '');
      } else if (body[k] == null) {
        body[k] = '';   // defensief: null → ''
      }
    }
    // knowledge_base + model hebben DB-defaults maar zijn ook NOT NULL — dek af
    // als backend upsert niet doorlaat.
    if (body.knowledge_base === undefined) {
      body.knowledge_base = (defaults.knowledge_base && typeof defaults.knowledge_base === 'object' && !Array.isArray(defaults.knowledge_base))
        ? defaults.knowledge_base : {};
    }
    if (body.model === undefined) {
      body.model = defaults.model || 'claude-sonnet-4-6';
    }
    return body;
  }

  window.__agSave = async (agId, sensitiveFieldsJson) => {
    const a = AGENTS_STATIC.find((x) => x.id === agId);
    if (!a || !a.backend) return;
    const dirty = _ui.dirty[agId] || {};
    if (!Object.keys(dirty).length) { alert('Niets gewijzigd.'); return; }

    // Lisa bridge — delegate naar lisa-config
    if (a.backend === 'lisa') { return _agSaveLisa('save_draft'); }

    // Sensitive-fields confirm voor Joost (lock=true)
    const sensitive = Array.isArray(sensitiveFieldsJson) ? sensitiveFieldsJson : [];
    if (a.lock) {
      const touched = sensitive.filter((f) => dirty[f] !== undefined);
      if (touched.length) {
        const list = touched.map((f) => '• ' + f).join('\n');
        if (!window.confirm(`Je wijzigt gevoelige velden voor Joost:\n\n${list}\n\nDit kan de kwaliteit van intent-classificatie en autonoom gedrag beïnvloeden. De wijziging wordt vastgelegd in het audit-log (joost.config_updated).\n\nDoorgaan?`)) return;
      }
    }

    // Whitelist per module. autonomy_config alleen voor niet-Joost (events/onboarding).
    // Voor Joost (module=finance) blijft autonomy_config + feature_flags altijd read-only
    // en worden ze hier NOOIT meegestuurd — dubbele guard bovenop de UI-lock.
    const BASE_ALLOWED = ['persona_name','persona_tone','system_prompt_template','knowledge_base','model','temperature','context_message_count','is_enabled'];
    const ALLOWED = (a.backend === 'finance')
      ? BASE_ALLOWED
      : [...BASE_ALLOWED, 'autonomy_config'];
    const partial = {};
    let n = 0;
    for (const k of ALLOWED) if (dirty[k] !== undefined) {
      // Guard: knowledge_base + autonomy_config moeten plain object zijn
      if ((k === 'knowledge_base' || k === 'autonomy_config') && (dirty[k] === null || typeof dirty[k] !== 'object' || Array.isArray(dirty[k]))) continue;
      // BUG 1 FIX — defensieve coerce: NOT NULL text-kolommen mogen nooit null zijn.
      let v = dirty[k];
      if (['persona_name','persona_tone','system_prompt_template','model'].includes(k)) {
        if (v == null) v = '';
        else v = String(v);
      }
      partial[k] = v;
      n++;
    }
    if (!n) { alert('Geen bekende velden om op te slaan.'); return; }

    _ui.saving[agId] = true; if (window.DFO?.render) window.DFO.render();
    try {
      // BUG 1 FIX — bij INSERT-pad expliciet defaults meesturen voor NOT NULL kolommen.
      const body = await _buildSafeUpsertBody(a.backend, partial);
      // Extra defensieve strip: als 'finance' toch iets probeert door te sturen dat protected is, blokkeer.
      if (a.backend === 'finance') {
        delete body.autonomy_config;
        delete body.feature_flags;
      }
      // persona_name mag niet leeg zijn per backend-validatie — coerce naar 'Agent' als toch leeg.
      if (body.persona_name === '' || body.persona_name == null) body.persona_name = a.n || 'Agent';
      if (body.persona_tone === '' || body.persona_tone == null) body.persona_tone = 'vriendelijk-professioneel';

      const j = await window.KV.authedJson('/api/joost-config-upsert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (j?.error) throw new Error(j.error);
      _ui.saved[agId] = Date.now();
      _ui.dirty[agId] = {};
      _live.perConfig.data[a.backend] = j?.config || _live.perConfig.data[a.backend];
      _live.configList.data = null;
      queueMicrotask(fetchConfigList);
    } catch (e) {
      console.error('[ag-v2] save fail', e);
      alert('Opslaan mislukt: ' + (e?.message || 'onbekende fout'));
    } finally {
      _ui.saving[agId] = false;
      if (window.DFO?.render) window.DFO.render();
    }
  };

  // ═══════════════════════════════════════════════════════════════════════
  // AUTONOMIE — Simone/Mila BEWERKBAAR (intents + limits) via joost-config-
  // upsert. Joost + Lisa READ-ONLY.
  // ═══════════════════════════════════════════════════════════════════════
  const INTENT_ACTIONS = [
    { v: 'off',        l: 'Uit',           d: 'Doet niets bij dit soort bericht' },
    { v: 'draft',      l: 'Meedenken',     d: 'Stelt antwoord voor, jij verstuurt' },
    { v: 'autonomous', l: 'Zelfstandig',   d: 'Antwoordt zelf zonder tussenkomst' },
    { v: 'escalate',   l: 'Altijd mens',   d: 'Zet direct door naar een mens' },
  ];

  function _cfgAutonomie(a, cfg) {
    const cfgLoaded = a.backend === 'lisa' ? _live.lisa.data : cfg;
    const auto = cfgLoaded?.autonomy_config;
    const flags = cfgLoaded?.feature_flags;

    // Joost + Lisa → read-only
    if (a.lock || a.backend === 'lisa' || !a.backend) {
      return `<div class="pad" style="padding-top:14px"><div style="max-width:820px">
        ${a.lock ? `<div style="margin-bottom:12px;padding:11px 15px;border:1px solid var(--amber-line);background:var(--amber-soft);border-radius:var(--r);font-size:12.5px;color:var(--amber);display:flex;gap:11px;align-items:flex-start">
          ${svg(I.shield, 'width:15px;height:15px;flex-shrink:0;margin-top:1px')}
          <div style="flex:1"><b>Read-only voor Joost.</b> Autonomie en feature-flags wijzig je via <b>${esc(a.mod)} → Instellingen</b>.
          <a href="/modules/finance.html#view-wanbetalers" style="color:var(--amber);text-decoration:underline;margin-left:6px">Open Wanbetalers →</a></div>
        </div>` : ''}
        ${_autonomySummary(auto, a)}
        ${_featureFlagsSummary(flags)}
      </div></div>`;
    }

    // Simone/Mila → editor
    return _cfgAutonomieEditor(a, cfgLoaded);
  }

  function _autonomyDraft(agId, cfg) {
    const dirty = _ui.dirty[agId] || {};
    if (dirty.autonomy_config !== undefined) return dirty.autonomy_config;
    const base = cfg?.autonomy_config;
    return (base && typeof base === 'object' && !Array.isArray(base)) ? JSON.parse(JSON.stringify(base)) : {};
  }
  function _setAutonomyDraft(agId, next) {
    _ui.dirty[agId] = _ui.dirty[agId] || {};
    _ui.dirty[agId].autonomy_config = next;
  }
  window.__agAutIntentAction = (agId, intentKey, action) => {
    const a = AGENTS_STATIC.find((x) => x.id === agId); if (!a) return;
    const cfg = _live.perConfig.data[a.backend];
    const draft = _autonomyDraft(agId, cfg);
    draft.intents = draft.intents || {};
    draft.intents[intentKey] = draft.intents[intentKey] || {};
    draft.intents[intentKey].action = action;
    // Sync enabled met action !== 'off' (defensief, backend-conventie).
    draft.intents[intentKey].enabled = (action !== 'off');
    _setAutonomyDraft(agId, draft);
    if (window.DFO?.render) window.DFO.render();
  };
  window.__agAutLimit = (agId, field, v) => {
    const a = AGENTS_STATIC.find((x) => x.id === agId); if (!a) return;
    const cfg = _live.perConfig.data[a.backend];
    const draft = _autonomyDraft(agId, cfg);
    draft.communication_limits = draft.communication_limits || {};
    if (v === '' || v == null) delete draft.communication_limits[field];
    else if (['max_per_dag','cooldown_minutes'].includes(field)) draft.communication_limits[field] = Math.max(0, Number(v) || 0);
    else draft.communication_limits[field] = String(v);
    _setAutonomyDraft(agId, draft);
  };

  function _cfgAutonomieEditor(a, cfg) {
    const draft   = _autonomyDraft(a.id, cfg);
    const intents = (draft.intents && typeof draft.intents === 'object') ? draft.intents : {};
    const intentKeys = Object.keys(intents);
    const limits  = (draft.communication_limits && typeof draft.communication_limits === 'object') ? draft.communication_limits : {};

    const flags = cfg?.feature_flags;

    return `<div class="pad" style="padding-top:14px"><div style="max-width:820px">
      <div class="card" style="margin-bottom:14px">
        <div class="card-head">
          <span class="tile-ico" style="background:var(--${a.c}-soft);color:var(--${a.c})">${svg(I.sliders)}</span>
          <div class="card-title">Intenten — wat mag ${esc(a.n)} zelf beslissen?</div>
        </div>
        ${intentKeys.length === 0
          ? `<div class="card-body" style="padding:16px 17px;color:var(--text-3);font-size:12.5px">Geen intents gedefinieerd in <span class="mono">autonomy_config.intents</span> — vul eerst het schema in via de admin-flow.</div>`
          : `<div class="card-body" style="padding:0">
            ${intentKeys.map((k) => {
              const cur = String(intents[k]?.action || 'draft');
              const known = INTENT_ACTIONS.some((o) => o.v === cur);
              return `<div style="display:grid;grid-template-columns:170px 1fr;gap:14px;align-items:center;padding:11px 17px;border-bottom:1px solid var(--border)">
                <div>
                  <div style="font-size:13px;font-weight:500">${esc(k)}</div>
                  ${intents[k]?.min_confidence != null ? `<div style="font-size:11px;color:var(--text-3);margin-top:1px">min. vertrouwen ${Math.round(100*Number(intents[k].min_confidence))}%</div>` : ''}
                </div>
                <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
                  ${INTENT_ACTIONS.map((o) => `<button class="chip ${cur === o.v ? 'on' : ''}" onclick="window.__agAutIntentAction('${a.id}','${esc(k)}','${o.v}')" title="${esc(o.d)}">${esc(o.l)}</button>`).join('')}
                  ${!known ? `<span class="pill pill-warn nodot" style="font-size:10px;padding:1.5px 6px" title="Onbekende waarde in DB: ${esc(cur)}">custom: ${esc(cur)}</span>` : ''}
                </div>
              </div>`;
            }).join('')}
          </div>`}
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="card-head">
          <span class="tile-ico" style="background:var(--slate-soft);color:var(--slate)">${svg(I.clock)}</span>
          <div class="card-title">Communicatie-limieten</div>
        </div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:12px;padding-top:14px;padding-bottom:14px">
          ${_limitField(a.id, 'Max. berichten per dag',  'max_per_dag',      limits.max_per_dag,      'number', { min:0, max:20, step:1 })}
          ${_limitField(a.id, 'Cooldown tussen berichten (min)', 'cooldown_minutes', limits.cooldown_minutes, 'number', { min:0, max:1440, step:5 })}
          ${_limitField(a.id, 'Verzendvenster start (HH:MM)', 'office_hours_start', limits.office_hours_start || '', 'text')}
          ${_limitField(a.id, 'Verzendvenster einde (HH:MM)', 'office_hours_end',   limits.office_hours_end || '',   'text')}
        </div>
      </div>

      ${_featureFlagsSummary(flags)}

      ${_saveBar(a, ['model','temperature','context_message_count'])}
    </div></div>`;
  }

  function _limitField(agId, label, field, v, kind, opts) {
    const id = 'ag_' + agId + '_lim_' + field;
    const inputStyle = 'width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text-1);font-size:13px';
    let input;
    if (kind === 'number') {
      const o = opts || {};
      input = `<input id="${id}" type="number" ${o.min!=null?`min="${o.min}"`:''} ${o.max!=null?`max="${o.max}"`:''} ${o.step!=null?`step="${o.step}"`:''} value="${esc(String(v ?? ''))}" oninput="window.__agAutLimit('${agId}','${field}',this.value)" style="${inputStyle}" />`;
    } else {
      input = `<input id="${id}" type="text" value="${esc(String(v ?? ''))}" oninput="window.__agAutLimit('${agId}','${field}',this.value)" style="${inputStyle}" placeholder="bv. 09:00" />`;
    }
    return `<div style="display:grid;grid-template-columns:220px 1fr;gap:14px;align-items:center;padding:0 17px">
      <label for="${id}" style="font-size:12.5px;color:var(--text-2)">${esc(label)}</label>
      <div>${input}</div>
    </div>`;
  }

  function _autonomySummary(auto, a) {
    if (!auto || typeof auto !== 'object') {
      return `<div class="card" style="margin-bottom:14px"><div class="card-head">
        <span class="tile-ico" style="background:var(--${a.c}-soft);color:var(--${a.c})">${svg(I.sliders)}</span>
        <div class="card-title">Autonomie</div></div>
        ${soon('Nog niet ingesteld', 'Er staan nog geen autonomie-regels in de configuratie van ' + a.n + '.')}
      </div>`;
    }
    const rows = [];
    if (auto.arrangement_mandate?.max_total_amount_to_auto_propose_eur != null) {
      rows.push(['Mag regelingen voorstellen tot', '€ ' + fmtNum(auto.arrangement_mandate.max_total_amount_to_auto_propose_eur)]);
    }
    if (auto.arrangement_mandate?.splitsing?.max_termijnen_zonder_approval != null) {
      rows.push(['Maximaal aantal termijnen', String(auto.arrangement_mandate.splitsing.max_termijnen_zonder_approval)]);
    }
    if (auto.arrangement_mandate?.uitstel?.max_dagen_zonder_approval != null) {
      rows.push(['Maximaal aantal dagen uitstel', String(auto.arrangement_mandate.uitstel.max_dagen_zonder_approval)]);
    }
    if (auto.communication_limits?.max_per_dag != null) {
      rows.push(['Max. berichten per dag', String(auto.communication_limits.max_per_dag)]);
    }
    if (auto.communication_limits?.cooldown_minutes != null) {
      rows.push(['Cooldown tussen berichten', auto.communication_limits.cooldown_minutes + ' min']);
    }
    if (auto.communication_limits?.office_hours_start && auto.communication_limits?.office_hours_end) {
      rows.push(['Verzendvenster', auto.communication_limits.office_hours_start + ' – ' + auto.communication_limits.office_hours_end]);
    }
    if (auto.intents && typeof auto.intents === 'object') {
      const intentCount = Object.keys(auto.intents).length;
      const enabledCount = Object.values(auto.intents).filter((i) => i?.enabled === true).length;
      rows.push(['Intents actief', `${enabledCount} van ${intentCount}`]);
    }
    if (auto.outbound?.enabled != null) {
      rows.push(['Zelf outbound starten', auto.outbound.enabled ? H.pill('ok','Aan') : H.pill('neutral','Uit')]);
    }
    return `<div class="card" style="margin-bottom:14px">
      <div class="card-head">
        <span class="tile-ico" style="background:var(--${a.c}-soft);color:var(--${a.c})">${svg(I.sliders)}</span>
        <div class="card-title">Autonomie</div>
        <span style="margin-left:auto;font-size:11px;color:var(--text-3)">read-only</span>
      </div>
      ${rows.length === 0
        ? soon('Nog niet ingesteld', null)
        : `<div class="card-body">${rows.map(([k, v]) => `<div class="kv"><dt>${esc(k)}</dt><dd>${typeof v === 'string' ? esc(v) : v}</dd></div>`).join('')}</div>`}
    </div>`;
  }

  function _featureFlagsSummary(flags) {
    if (!flags || typeof flags !== 'object' || !Object.keys(flags).length) return '';
    const entries = Object.entries(flags);
    return `<div class="card">
      <div class="card-head">
        <span class="tile-ico" style="background:var(--blue-soft);color:var(--blue)">${svg(I.settings)}</span>
        <div class="card-title">Feature flags</div>
        <span style="margin-left:auto;font-size:11px;color:var(--text-3)">read-only</span>
      </div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:6px">
        ${entries.map(([k, val]) => `<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border)">
          <span class="mono" style="font-size:11.5px;color:var(--text-2);flex:1;overflow:hidden;text-overflow:ellipsis">${esc(k)}</span>
          ${val === true ? H.pill('ok','Aan') : val === false ? H.pill('neutral','Uit') : `<span class="mono" style="font-size:11px">${esc(JSON.stringify(val))}</span>`}
        </div>`).join('')}
      </div>
    </div>`;
  }

  function _cfgBeslissingen(a) {
    return `<div class="pad" style="padding-top:14px"><div style="max-width:820px">
      <div class="card">${soon('Beslissingen-log — binnenkort', 'Live overzicht van wat ' + a.n + ' zelf heeft besloten: intent, vertrouwen, wat er is verstuurd en waarom.')}</div>
    </div></div>`;
  }
  function _cfgOefengesprek(a) {
    if (!a.backend || a.backend.startsWith('bg-')) {
      return `<div class="pad" style="padding-top:14px"><div style="max-width:820px">
        <div class="card">${soon('Oefengesprek — binnenkort', 'Deze agent heeft nog geen backend om mee te chatten.')}</div>
      </div></div>`;
    }
    const st = _ui.sandbox[a.id] = _ui.sandbox[a.id] || { history: [], sending: false, input: '', error: null };

    return `<div class="pad" style="padding-top:14px"><div style="max-width:820px">
      <div style="margin-bottom:12px;padding:11px 15px;border:1px solid var(--emerald-line);background:var(--emerald-soft);border-radius:var(--r);font-size:12.5px;color:var(--emerald);display:flex;gap:11px;align-items:flex-start">
        ${svg(I.tick, 'width:15px;height:15px;flex-shrink:0;margin-top:1px')}
        <div style="flex:1"><b>Sandbox-modus.</b> Berichten worden NIET verstuurd naar klanten en NIET gelogd. Elke reactie komt vers uit de LLM met de live agent-config als systeem-prompt.</div>
      </div>

      <div class="card" style="margin-bottom:12px">
        <div class="card-head">
          <span class="tile-ico" style="background:var(--${a.c}-soft);color:var(--${a.c})">${svg(I.chat)}</span>
          <div class="card-title">Testgesprek met ${esc(a.n)}</div>
          ${st.history.length > 0 ? `<button class="btn btn-ghost btn-sm" style="margin-left:auto" onclick="window.__agSandboxClear('${a.id}')">${svg(I.trash || I.x)}Leegmaken</button>` : ''}
        </div>
        <div class="card-body" style="padding:14px 17px;display:flex;flex-direction:column;gap:10px;min-height:220px">
          ${st.history.length === 0
            ? `<div style="color:var(--text-3);font-size:12.5px;text-align:center;padding:22px 12px">Nog geen berichten. Typ hieronder een testbericht.</div>`
            : st.history.map((m) => _sandboxBubble(m, a)).join('')}
          ${st.sending ? `<div style="display:flex;gap:8px;align-items:center;padding:8px 12px;background:var(--surface-2);border-radius:12px;max-width:75%;align-self:flex-start">
            <span style="width:8px;height:8px;border-radius:50%;background:var(--${a.c});opacity:.4;animation:pulse 1.4s infinite"></span>
            <span style="font-size:12px;color:var(--text-3)">${esc(a.n)} typt…</span>
          </div>` : ''}
          ${st.error ? `<div style="color:var(--rose);font-size:12px;padding:8px 12px;background:var(--rose-soft);border-radius:8px">${esc(st.error)}</div>` : ''}
        </div>
      </div>

      <div style="display:flex;gap:8px">
        <textarea id="ag_sandbox_input_${a.id}" placeholder="Typ een testbericht en druk Enter…" ${st.sending ? 'disabled' : ''} style="flex:1;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface);font-size:13px;font-family:inherit;min-height:44px;resize:vertical;${st.sending ? 'opacity:.6' : ''}" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();window.__agSandboxSend('${a.id}')}"></textarea>
        <button class="btn btn-primary" ${st.sending ? 'disabled' : ''} onclick="window.__agSandboxSend('${a.id}')" style="align-self:stretch">${svg(I.send)}Verstuur</button>
      </div>
      <style>@keyframes pulse { 0%,100%{opacity:.4} 50%{opacity:1} }</style>
    </div></div>`;
  }

  // Bug 2b — Mini-markdown renderer voor assistant-bubbels.
  // Werkt op ge-esc()-de string zodat XSS uitgesloten is: HTML-tags in de
  // originele content zijn al ge-escaped, alleen MD-patronen worden vervangen.
  function _mdInline(escapedText) {
    let s = String(escapedText || '');
    // Bold **x** en __x__ → <strong>
    s = s.replace(/\*\*([^\*\n]+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_\n]+?)__/g, '<strong>$1</strong>');
    // Italic *x* en _x_ (niet als ** al gehandeld) → <em>
    s = s.replace(/(^|[\s(])\*([^\*\n]+?)\*(?=[\s.,;:!?)\-]|$)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[\s(])_([^_\n]+?)_(?=[\s.,;:!?)\-]|$)/g, '$1<em>$2</em>');
    // Inline code `x` → <code>
    s = s.replace(/`([^`\n]+?)`/g, '<code style="background:var(--surface-2);padding:1px 5px;border-radius:3px;font-family:\'IBM Plex Mono\',monospace;font-size:.92em">$1</code>');
    return s;
  }
  function _mdBlock(rawText) {
    // Eerst esc, dan block-level (lists/paragraphs), dan inline.
    const escd = esc(String(rawText || ''));
    const lines = escd.split('\n');
    let html = '';
    let listType = null; // 'ul' | 'ol'
    let paraBuf = [];
    const flushPara = () => {
      if (paraBuf.length) { html += `<p style="margin:0 0 8px 0">${_mdInline(paraBuf.join('<br>'))}</p>`; paraBuf = []; }
    };
    const flushList = () => { if (listType) { html += `</${listType}>`; listType = null; } };
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      const ulMatch = /^\s*[-*]\s+(.+)$/.exec(line);
      const olMatch = /^\s*\d+\.\s+(.+)$/.exec(line);
      if (ulMatch) {
        flushPara();
        if (listType !== 'ul') { flushList(); listType = 'ul'; html += `<ul style="margin:0 0 8px 20px;padding:0">`; }
        html += `<li style="margin:2px 0">${_mdInline(ulMatch[1])}</li>`;
      } else if (olMatch) {
        flushPara();
        if (listType !== 'ol') { flushList(); listType = 'ol'; html += `<ol style="margin:0 0 8px 22px;padding:0">`; }
        html += `<li style="margin:2px 0">${_mdInline(olMatch[1])}</li>`;
      } else if (line.trim() === '') {
        flushPara(); flushList();
      } else {
        if (listType) flushList();
        paraBuf.push(line);
      }
    }
    flushPara(); flushList();
    return html || `<p style="margin:0">${_mdInline(escd)}</p>`;
  }

  function _sandboxBubble(m, a) {
    const isUser = m.role === 'user';
    const bg = isUser ? 'var(--surface-2)' : `color-mix(in srgb, var(--${a.c}) 10%, var(--surface))`;
    // Bug 2b: assistant-bubbels renderen met mini-markdown (**vet**, lijstjes).
    // User-bubbels blijven pure esc + whitespace-pre-wrap.
    const bodyHtml = isUser
      ? `<div style="font-size:13px;line-height:1.5;white-space:pre-wrap">${esc(m.content)}</div>`
      : `<div style="font-size:13px;line-height:1.55">${_mdBlock(m.content)}</div>`;
    return `<div style="max-width:75%;padding:9px 12px;border-radius:12px;background:${bg};${isUser ? 'align-self:flex-end' : 'align-self:flex-start;border-left:2px solid var(--' + a.c + ')'}">
      <div style="font-size:10.5px;color:var(--text-3);margin-bottom:3px;text-transform:uppercase;letter-spacing:.05em">${isUser ? 'Jij' : esc(a.n)}</div>
      ${bodyHtml}
    </div>`;
  }

  window.__agSandboxClear = (agId) => {
    _ui.sandbox[agId] = { history: [], sending: false, input: '', error: null };
    if (window.DFO?.render) window.DFO.render();
  };
  window.__agSandboxSend = async (agId) => {
    const a = AGENTS_STATIC.find((x) => x.id === agId); if (!a || !a.backend) return;
    const st = _ui.sandbox[agId] = _ui.sandbox[agId] || { history: [], sending: false, input: '', error: null };
    if (st.sending) return;
    const input = document.getElementById('ag_sandbox_input_' + agId);
    const msg = (input?.value || '').trim();
    if (!msg) return;
    st.history.push({ role: 'user', content: msg });
    st.sending = true; st.error = null;
    if (input) input.value = '';
    if (window.DFO?.render) window.DFO.render();
    try {
      const body = {
        module: a.backend,
        message: msg,
        history: st.history.slice(0, -1).slice(-10),   // exclusief zojuist-toegevoegd bericht
      };
      const j = await window.KV.authedJson('/api/agent-sandbox-chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (j?.error) throw new Error(j.error);
      st.history.push({ role: 'assistant', content: j?.reply || '(geen antwoord)' });
    } catch (e) {
      st.error = 'Sandbox-fout: ' + (e?.message || 'onbekende fout');
    } finally {
      st.sending = false;
      if (window.DFO?.render) window.DFO.render();
    }
  };

  // ═══════════════════════════════════════════════════════════════════════
  // LISA BRIDGE — Persona / Fases / Kennisbank / Follow-ups + versies
  // ═══════════════════════════════════════════════════════════════════════
  function _lisaGuard() {
    if (_live.lisa.error && !_live.lisa.data) return { err: errBlk('lisa', _live.lisa.error) };
    if (!_live.lisa.data && _live.lisa.loading) return { err: skel() };
    if (!_live.lisa.data) return { err: skel() };
    return { cfg: _live.lisa.data };
  }
  function _lisaValue(field, fallback) {
    const dirty = _ui.dirty.lisa || {};
    const cfg = _live.lisa.data;
    if (dirty[field] !== undefined) return dirty[field];
    return cfg?.[field] != null ? cfg[field] : fallback;
  }
  function _lisaSaveBar() {
    const dirty = _ui.dirty.lisa || {};
    const hasDirty = Object.keys(dirty).length > 0;
    const saving = _ui.saving.lisa === true;
    const saved  = _ui.saved.lisa;
    const cfg = _live.lisa.data;
    return `<div style="padding:11px 17px;background:var(--surface-2);border:1px solid var(--border);border-radius:var(--r);display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:14px">
      <button class="btn btn-ghost btn-sm" ${(!hasDirty || saving) ? 'disabled style="opacity:.55;cursor:not-allowed"' : ''} onclick="window.__agLisaSave('save_draft')">
        ${svg(I.tick)}${saving && _ui.saving.lisaKind === 'save_draft' ? 'Opslaan…' : 'Opslaan als concept'}
      </button>
      <button class="btn btn-primary btn-sm" ${saving ? 'disabled style="opacity:.55"' : ''} onclick="window.__agLisaSave('publish')">
        ${svg(I.rocket || I.tick)}${saving && _ui.saving.lisaKind === 'publish' ? 'Publiceren…' : (hasDirty ? 'Publiceer wijzigingen' : 'Publiceer huidige concept')}
      </button>
      <button class="btn btn-ghost btn-sm" ${!hasDirty ? 'disabled style="opacity:.55"' : ''} onclick="window.__agReset('lisa')">Annuleren</button>
      <button class="btn btn-ghost btn-sm" onclick="window.__agLisaToggleHist()">${svg(I.clock)}Versies</button>
      <span style="font-size:11px;color:var(--text-3);margin-left:auto">${cfg?.version ? 'huidige versie: v' + cfg.version : ''}${cfg?.is_active === false ? ' · concept' : cfg?.is_active === true ? ' · live' : ''}</span>
      ${saved ? `<span style="font-size:11.5px;color:var(--emerald)">✓ ${new Date(saved).toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit'})}</span>` : ''}
    </div>
    ${_ui.lisaHistOpen ? _lisaHistoryPanel() : ''}`;
  }
  window.__agLisaToggleHist = () => {
    _ui.lisaHistOpen = !_ui.lisaHistOpen;
    if (_ui.lisaHistOpen && !_live.lisaHist.data) queueMicrotask(fetchLisaHistory);
    if (window.DFO?.render) window.DFO.render();
  };
  function _lisaHistoryPanel() {
    if (_live.lisaHist.loading && !_live.lisaHist.data) return skel();
    if (_live.lisaHist.error) return errBlk('lisaHist', _live.lisaHist.error);
    const versions = asArr(_live.lisaHist.data);
    if (versions.length === 0) return `<div class="card" style="margin-top:10px"><div class="card-body">Nog geen versie-historie.</div></div>`;
    return `<div class="card" style="margin-top:10px">
      <div class="card-head"><div class="card-title">Versies</div></div>
      ${H.table(
        [{l:'Versie'},{l:'Aangepast', cls:'optional'},{l:'Actief'},{l:''}],
        versions.map((v) => [
          `<span class="mono">v${esc(v.version)}</span>`,
          `<span style="font-size:12.5px;color:var(--text-3)">${fmtDate(v.updated_at || v.created_at)}</span>`,
          v.is_active ? H.pill('ok','Live') : H.pill('neutral','Concept'),
          v.is_active ? '' : `<button class="btn btn-ghost btn-sm" onclick="window.__agLisaRollback(${Number(v.version)})">Herstel</button>`,
        ])
      )}
    </div>`;
  }
  window.__agLisaRollback = async (version) => {
    if (!window.confirm(`Lisa-versie v${version} terugzetten als live? Er wordt een nieuwe versie aangemaakt met de inhoud van v${version}.`)) return;
    try {
      const j = await window.KV.authedJson('/api/lisa-config?action=rollback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version }),
      });
      if (j?.error) throw new Error(j.error);
      _live.lisa.data = null; _live.lisaHist.data = null;
      queueMicrotask(fetchLisaConfig); queueMicrotask(fetchLisaHistory);
      alert('Rollback naar v' + version + ' geslaagd.');
    } catch (e) { alert('Rollback mislukt: ' + (e?.message || 'onbekende fout')); }
  };
  window.__agLisaSave = async (kind) => {
    const dirty = _ui.dirty.lisa || {};
    if (kind === 'save_draft' && !Object.keys(dirty).length) { alert('Niets gewijzigd.'); return; }
    if (kind === 'publish') {
      if (!window.confirm('Wijzigingen publiceren?\n\nEen nieuwe actieve Lisa-versie wordt aangemaakt en gaat direct in productie.')) return;
    }
    _ui.saving.lisa = true; _ui.saving.lisaKind = kind;
    if (window.DFO?.render) window.DFO.render();
    try {
      const j = await window.KV.authedJson('/api/lisa-config?action=' + kind, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dirty),
      });
      if (j?.error) throw new Error(j.error);
      _ui.saved.lisa = Date.now();
      _ui.dirty.lisa = {};
      _live.lisa.data = null; _live.lisaHist.data = null;
      queueMicrotask(fetchLisaConfig); queueMicrotask(fetchLisaHistory);
    } catch (e) {
      alert((kind === 'publish' ? 'Publiceren' : 'Opslaan') + ' mislukt: ' + (e?.message || 'onbekende fout'));
    } finally {
      _ui.saving.lisa = false; _ui.saving.lisaKind = null;
      if (window.DFO?.render) window.DFO.render();
    }
  };

  function _lisaPersona() {
    const g = _lisaGuard(); if (g.err) return g.err;
    return `<div class="pad" style="padding-top:14px"><div style="max-width:820px">
      <div class="card" style="margin-bottom:14px">
        <div class="card-head">
          <span class="tile-ico" style="background:var(--violet-soft);color:var(--violet)">${svg(I.bot)}</span>
          <div class="card-title">Persona en toon</div>
          <a href="/modules/lisa.html" style="margin-left:auto;font-size:11px;color:var(--text-3);text-decoration:underline">Open volledige Lisa-editor</a>
        </div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:12px;padding-top:14px;padding-bottom:14px">
          ${_field('Naam',             'persona_name',       _lisaValue('persona_name', 'Lisa'), false, {id:'lisa'})}
          ${_field('Leeftijd',         'persona_age',        _lisaValue('persona_age', ''),      false, {id:'lisa'})}
          ${_field('Achtergrond',      'persona_background', _lisaValue('persona_background', ''), false, {id:'lisa'}, 'textarea')}
          ${_field('Toon',             'persona_tone',       _lisaValue('persona_tone', ''),     false, {id:'lisa'}, 'textarea')}
          ${_field('Schrijfstijl',     'persona_writing_style', _lisaValue('persona_writing_style', ''), false, {id:'lisa'}, 'textarea')}
          ${_field('Emoji-gebruik',    'emoji_usage',        _lisaValue('emoji_usage', 'medium'),false, {id:'lisa'}, 'select', ['none','low','medium','high'])}
        </div>
      </div>
      ${_lisaSaveBar()}
    </div></div>`;
  }

  function _lisaFases() {
    const g = _lisaGuard(); if (g.err) return g.err;
    const fases = [
      ['phase_intro',    'Intro',    'Eerste bericht na aanmelding — welkom / kennismaking.'],
      ['phase_doel',     'Doel',     'Achterhaal wat de klant wil bereiken.'],
      ['phase_situatie', 'Situatie', 'Achterhaal huidige situatie / ervaring.'],
      ['phase_band',     'Band',     'Bouw vertrouwen op — persoonlijke connectie.'],
      ['phase_call',     'Call',     'Bied de kennismakingscall aan.'],
    ];
    return `<div class="pad" style="padding-top:14px"><div style="max-width:820px">
      ${fases.map(([key, label, hint]) => `
        <div class="card" style="margin-bottom:14px">
          <div class="card-head">
            <span class="tile-ico" style="background:var(--violet-soft);color:var(--violet)">${svg(I.route || I.list)}</span>
            <div><div class="card-title">${esc(label)}</div>
              <div style="font-size:11.5px;color:var(--text-3);margin-top:2px">${esc(hint)}</div></div>
          </div>
          <div class="card-body" style="padding-top:12px;padding-bottom:12px">
            ${_field('Instructie', key, _lisaValue(key, ''), false, {id:'lisa'}, 'textarea-lg')}
          </div>
        </div>`).join('')}
      ${_lisaSaveBar()}
    </div></div>`;
  }

  function _lisaKB() {
    const g = _lisaGuard(); if (g.err) return g.err;
    const products = Array.isArray(_lisaValue('kb_products', [])) ? _lisaValue('kb_products', []) : [];
    const faq = Array.isArray(_lisaValue('kb_faq', [])) ? _lisaValue('kb_faq', []) : [];
    return `<div class="pad" style="padding-top:14px"><div style="max-width:820px">
      <div class="card" style="margin-bottom:14px">
        <div class="card-head">
          <span class="tile-ico" style="background:var(--violet-soft);color:var(--violet)">${svg(I.book || I.doc)}</span>
          <div class="card-title">Producten</div>
          <span style="margin-left:auto;font-size:11px;color:var(--text-3)">${products.length}</span>
        </div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:10px">
          ${products.length === 0 ? `<div style="font-size:12.5px;color:var(--text-3)">Nog geen producten. Voeg toe in de volledige Lisa-editor.</div>` :
            products.map((p, i) => `<div style="display:flex;gap:8px;align-items:center;padding:8px;background:var(--surface-2);border-radius:8px">
              <span style="flex:1"><b>${esc(p.naam || '—')}</b><div style="font-size:11.5px;color:var(--text-3)">${esc(p.beschrijving || '')}</div></span>
              <span class="mono" style="font-size:11px;color:var(--text-3)">${esc(p.prijs || '')}</span>
            </div>`).join('')}
          <a href="/modules/lisa.html" class="btn btn-ghost btn-sm" style="text-decoration:none;align-self:flex-start">Bewerk in Lisa-editor →</a>
        </div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="card-head">
          <span class="tile-ico" style="background:var(--violet-soft);color:var(--violet)">${svg(I.chat)}</span>
          <div class="card-title">Veelgestelde vragen</div>
          <span style="margin-left:auto;font-size:11px;color:var(--text-3)">${faq.length}</span>
        </div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:8px">
          ${faq.length === 0 ? `<div style="font-size:12.5px;color:var(--text-3)">Nog geen FAQ-items.</div>` :
            faq.slice(0, 8).map((q) => `<div style="padding:8px;background:var(--surface-2);border-radius:8px">
              <div style="font-weight:500;font-size:12.5px">${esc(q.vraag || '—')}</div>
              <div style="font-size:11.5px;color:var(--text-3);margin-top:3px">${esc(q.antwoord || '')}</div>
            </div>`).join('')}
          ${faq.length > 8 ? `<div style="font-size:11.5px;color:var(--text-3)">+ ${faq.length - 8} meer</div>` : ''}
          <a href="/modules/lisa.html" class="btn btn-ghost btn-sm" style="text-decoration:none;align-self:flex-start">Bewerk in Lisa-editor →</a>
        </div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="card-head"><div class="card-title">Prijzen + USP's</div></div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:12px;padding-top:12px;padding-bottom:12px">
          ${_field('Prijzen (jsonb)', 'kb_pricing', typeof _lisaValue('kb_pricing', '') === 'object' ? JSON.stringify(_lisaValue('kb_pricing', ''), null, 2) : _lisaValue('kb_pricing', ''), false, {id:'lisa'}, 'textarea-lg')}
          ${_field("USP's (jsonb)", 'kb_usps', typeof _lisaValue('kb_usps', '') === 'object' ? JSON.stringify(_lisaValue('kb_usps', ''), null, 2) : _lisaValue('kb_usps', ''), false, {id:'lisa'}, 'textarea-lg')}
        </div>
      </div>
      ${_lisaSaveBar()}
    </div></div>`;
  }

  function _lisaFollowups() {
    const g = _lisaGuard(); if (g.err) return g.err;
    const stops = Array.isArray(_lisaValue('stop_keywords', [])) ? _lisaValue('stop_keywords', []) : [];
    return `<div class="pad" style="padding-top:14px"><div style="max-width:820px">
      <div class="card" style="margin-bottom:14px">
        <div class="card-head">
          <span class="tile-ico" style="background:var(--violet-soft);color:var(--violet)">${svg(I.repeat)}</span>
          <div class="card-title">Follow-ups</div>
        </div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:12px;padding-top:12px;padding-bottom:12px">
          ${_field('Follow-ups aan', 'followup_enabled', _lisaValue('followup_enabled', false) ? 'true' : 'false', false, {id:'lisa'}, 'toggle')}
          ${_field('AI-drempel (min. chars)', 'followup_ai_threshold_chars', _lisaValue('followup_ai_threshold_chars', 40), false, {id:'lisa'}, 'number', { min:0, max:1000, step:5 })}
        </div>
      </div>

      <div class="card" style="margin-bottom:14px">
        <div class="card-head">
          <span class="tile-ico" style="background:var(--amber-soft);color:var(--amber)">${svg(I.alert)}</span>
          <div class="card-title">Stopwoorden — stopt follow-ups direct</div>
        </div>
        <div class="card-body">
          ${_lisaListEditor('stop_keywords', stops, 'Bijvoorbeeld: stop, uitschrijven, ongewenst')}
        </div>
      </div>
      ${_lisaSaveBar()}
    </div></div>`;
  }

  function _lisaListEditor(key, items, placeholder) {
    return `<div style="display:flex;flex-direction:column;gap:6px">
      ${items.length === 0 ? `<div style="font-size:12.5px;color:var(--text-3);padding:4px 0">Nog geen items.</div>` : ''}
      ${items.map((item, i) => `<div style="display:flex;gap:6px;align-items:center">
        <input type="text" value="${esc(item)}" oninput="window.__agLisaListSet('${key}',${i},this.value)" style="flex:1;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);font-size:12.5px" />
        <button class="icon-btn" onclick="window.__agLisaListRemove('${key}',${i})" title="Verwijderen">${svg(I.trash || I.x, 'width:13px;height:13px')}</button>
      </div>`).join('')}
      <div style="display:flex;gap:6px;margin-top:2px">
        <input type="text" placeholder="${esc(placeholder)}" id="ag_lisa_${key}_new" style="flex:1;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);font-size:12.5px" onkeypress="if(event.key==='Enter'){event.preventDefault();window.__agLisaListAdd('${key}')}" />
        <button class="btn btn-ghost btn-sm" onclick="window.__agLisaListAdd('${key}')">${svg(I.plus)}</button>
      </div>
    </div>`;
  }
  function _getLisaField(key) {
    const dirty = _ui.dirty.lisa || {};
    if (dirty[key] !== undefined) return Array.isArray(dirty[key]) ? [...dirty[key]] : [];
    const cur = _live.lisa.data?.[key];
    return Array.isArray(cur) ? [...cur] : [];
  }
  function _setLisaField(key, val) {
    _ui.dirty.lisa = _ui.dirty.lisa || {};
    _ui.dirty.lisa[key] = val;
  }
  window.__agLisaListSet = (key, idx, val) => {
    const arr = _getLisaField(key); arr[idx] = val; _setLisaField(key, arr);
  };
  window.__agLisaListRemove = (key, idx) => {
    const arr = _getLisaField(key); arr.splice(idx, 1); _setLisaField(key, arr);
    if (window.DFO?.render) window.DFO.render();
  };
  window.__agLisaListAdd = (key) => {
    const input = document.getElementById('ag_lisa_' + key + '_new');
    const val = (input?.value || '').trim(); if (!val) return;
    const arr = _getLisaField(key); arr.push(val); _setLisaField(key, arr);
    if (window.DFO?.render) window.DFO.render();
  };

  // ═══════════════════════════════════════════════════════════════════════
  // VIEW 3 — KENNISBANK (aggregate agent-KB + centrale artikelen + unmatched)
  // ═══════════════════════════════════════════════════════════════════════
  function kennisbankView() {
    ['finance','events','onboarding'].forEach((m) => {
      if (!_live.perConfig.data[m] && !_live.perConfig.loading[m] && !_live.perConfig.error[m]) {
        queueMicrotask(() => fetchPerConfig(m));
      }
    });
    if (!_live.lisa.data  && !_live.lisa.loading  && !_live.lisa.error)  queueMicrotask(fetchLisaConfig);
    if (!_live.kbArt.data && !_live.kbArt.loading && !_live.kbArt.error) queueMicrotask(fetchKbArt);
    if (!_live.kbUnm.data && !_live.kbUnm.loading && !_live.kbUnm.error) queueMicrotask(fetchKbUnm);

    const anyLoading = ['finance','events','onboarding'].some((m) => _live.perConfig.loading[m]) || _live.lisa.loading;
    if (anyLoading && !_live.perConfig.data.finance && !_live.perConfig.data.events && !_live.perConfig.data.onboarding) return skel();

    const rows = [];
    const moduleToAgent = { finance:'Joost', events:'Simone', onboarding:'Mila' };
    for (const m of ['finance','events','onboarding']) {
      const cfg = _live.perConfig.data[m]; if (!cfg) continue;
      const kb = cfg.knowledge_base || {};
      for (const key of Object.keys(kb)) {
        const val = kb[key];
        rows.push({ onderwerp:key, categorie:_kbCat(key), agents:[moduleToAgent[m]],
          content: typeof val === 'object' ? JSON.stringify(val) : String(val), updated: cfg.updated_at });
      }
    }
    if (_live.lisa.data) {
      const faq = Array.isArray(_live.lisa.data.kb_faq) ? _live.lisa.data.kb_faq : [];
      for (const q of faq) {
        if (!q?.vraag) continue;
        rows.push({ onderwerp:q.vraag, categorie:'FAQ', agents:['Lisa'], content:q.antwoord || '', updated:_live.lisa.data.updated_at });
      }
      const prods = Array.isArray(_live.lisa.data.kb_products) ? _live.lisa.data.kb_products : [];
      for (const p of prods) {
        if (!p?.naam) continue;
        rows.push({ onderwerp:p.naam, categorie:'Aanbod', agents:['Lisa'], content:p.beschrijving || '', updated:_live.lisa.data.updated_at });
      }
    }
    const dedup = new Map();
    for (const r of rows) {
      const k = r.onderwerp.toLowerCase();
      if (dedup.has(k)) { for (const ag of r.agents) if (!dedup.get(k).agents.includes(ag)) dedup.get(k).agents.push(ag); }
      else dedup.set(k, { ...r });
    }
    let all = Array.from(dedup.values());
    const f = _ui.kbFilter;
    if (f.agent !== 'all') all = all.filter((r) => r.agents.includes(f.agent));
    if (f.cat !== 'all')   all = all.filter((r) => (r.categorie || '').toLowerCase() === f.cat.toLowerCase());
    if (f.q) { const q = f.q.toLowerCase(); all = all.filter((r) => (r.onderwerp || '').toLowerCase().includes(q) || (r.content || '').toLowerCase().includes(q)); }
    const catCount = { Aanbod:0, Prijzen:0, Praktisch:0, 'Over ons':0, FAQ:0, Overig:0 };
    for (const r of all) catCount[r.categorie in catCount ? r.categorie : 'Overig']++;
    const errors = ['finance','events','onboarding'].filter((m) => _live.perConfig.error[m]);

    // Centrale artikelen erbij mergen — die krijgen edit/delete-acties in de rij.
    const centralArts = asArr(_live.kbArt.data);
    const artErr = _live.kbArt.error;

    return `${_kbToolbar(catCount, all.length)}
    ${errors.map((m) => errBlk('perConfig', 'kennisbank van ' + m + ' — ' + _live.perConfig.error[m], m)).join('')}
    ${_live.lisa.error ? errBlk('lisa', 'Lisa-kennisbank — ' + _live.lisa.error) : ''}
    ${artErr && !/MIGRATION_MISSING/i.test(artErr) ? errBlk('kbArt', 'Centrale kennisbank — ' + artErr) : ''}

    ${all.length === 0 && centralArts.length === 0
      ? `<div class="empty" style="padding:44px 20px"><div class="empty-t">Geen kennisbank-items</div>
         <div class="empty-s">Bewerk agent-KB per agent via <b>Configuratie → Kennisbank</b>, of maak centrale artikelen aan met <b>+ Artikel</b>.</div></div>`
      : `
      ${centralArts.length > 0 ? `<div style="padding:14px 20px 0"><div style="font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3);margin-bottom:8px">Centrale artikelen (${centralArts.length})</div>
        ${(() => { window.__agKbCentralArts = centralArts; return H.table(
          [{l:'Onderwerp'}, {l:'Categorie'}, {l:'Wie gebruikt dit', cls:'optional'}, {l:'Bijgewerkt', cls:'r optional'}, {l:'Acties', cls:'r'}],
          centralArts.map((r) => [
            `<div><div class="cell-main">${esc(r.onderwerp)}</div>
              ${r.content ? `<div style="font-size:11.5px;color:var(--text-3);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:340px">${esc(r.content)}</div>` : ''}</div>`,
            r.categorie ? H.pill('neutral', r.categorie) : `<span style="color:var(--text-3);font-size:11.5px">—</span>`,
            `<div style="display:flex;gap:4px;flex-wrap:wrap">${(Array.isArray(r.agents) ? r.agents : []).map((w) => {
              const ag = AGENTS_STATIC.find((x) => x.id === w);
              return `<span class="pill pill-neutral nodot" style="font-size:10.5px;padding:1.5px 7px">
                <span style="width:6px;height:6px;border-radius:50%;background:var(--${ag ? ag.c : 'slate'});display:inline-block;margin-right:4px"></span>${esc(ag ? ag.n : w)}</span>`;
            }).join('') || '<span style="color:var(--text-3);font-size:11.5px">nog niet gekoppeld</span>'}</div>`,
            `<span class="mono" style="color:var(--text-3);font-size:12.5px">${fmtDate(r.updated_at)}</span>`,
            `<div style="display:flex;gap:4px;justify-content:flex-end">
              <button class="icon-btn" title="Promoveren naar agent" style="width:26px;height:26px" onclick="event.stopPropagation();window.__agKbArtPromote('${r.id}')">${svg(I.send, 'width:13px;height:13px')}</button>
              <button class="icon-btn" title="Bewerken" style="width:26px;height:26px" onclick="event.stopPropagation();window.__agKbArtEdit('${r.id}')">${svg(I.edit || I.settings, 'width:13px;height:13px')}</button>
              <button class="icon-btn" title="Verwijderen" style="width:26px;height:26px" onclick="event.stopPropagation();window.__agKbArtDelete('${r.id}')">${svg(I.trash || I.x, 'width:13px;height:13px')}</button>
            </div>`,
          ]),
          'window.__agKbCentralRowClick'
        ); })()}
      </div>` : ''}

      ${all.length > 0 ? `<div style="padding:14px 20px 0"><div style="font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3);margin-bottom:8px">Agent-kennisbank (${all.length})</div>
        ${(() => { window.__agKbAllArts = all; return H.table(
          [{l:'Onderwerp'}, {l:'Categorie'}, {l:'Wie gebruikt dit', cls:'optional'}, {l:'Bijgewerkt', cls:'r optional'}],
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
          ]),
          'window.__agKbAllRowClick'
        ); })()}
      </div>` : ''}
    `}

    ${_kbUnmatchedPanel()}
    ${_ui.artModal ? _artikelModal() : ''}`;
  }

  // ─── Onbeantwoord-paneel ────────────────────────────────────────────────
  function _kbUnmatchedPanel() {
    const items = asArr(_live.kbUnm.data);
    const err = _live.kbUnm.error;
    const migrationMissing = /MIGRATION_MISSING/i.test(err || '');
    if (!items.length && !err) return '';
    return `<div style="padding:20px">
      <div style="padding:14px 16px;border:1px solid var(--amber-line);background:var(--amber-soft);border-radius:var(--r)">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
          ${svg(I.alert, 'width:16px;height:16px;color:var(--amber);flex-shrink:0')}
          <div style="flex:1"><b style="color:var(--amber)">Vragen zonder antwoord</b>
            <span style="color:var(--text-3);font-size:12px;margin-left:8px">${migrationMissing ? '(migratie ontbreekt)' : items.length + ' open'}</span>
          </div>
        </div>
        ${migrationMissing
          ? `<div style="font-size:12.5px;color:var(--amber)">Draai migratie <span class="mono">2026-08-13-kennisbank-artikelen.sql</span> om dit paneel te activeren.</div>`
          : items.length === 0
            ? `<div style="font-size:12.5px;color:var(--text-3)">Geen open onbeantwoorde vragen.</div>`
            : `<div style="display:flex;flex-direction:column;gap:6px">${items.slice(0, 12).map((q) => {
                const ag = AGENTS_STATIC.find((a) => a.id === q.agent_key);
                return `<div style="display:flex;gap:10px;align-items:center;padding:8px 10px;background:var(--surface);border-radius:8px">
                  <span class="pill pill-neutral nodot" style="font-size:10.5px;padding:1.5px 7px">
                    <span style="width:6px;height:6px;border-radius:50%;background:var(--${ag ? ag.c : 'slate'});display:inline-block;margin-right:4px"></span>${esc(ag ? ag.n : q.agent_key)}</span>
                  <div style="flex:1;min-width:0">
                    <div style="font-size:13px">${esc(q.question)}</div>
                    <div style="font-size:11px;color:var(--text-3)">${q.count}× gesteld · laatst ${fmtDate(q.last_seen)}</div>
                  </div>
                  <button class="btn btn-ghost btn-sm" onclick="window.__agKbUnmPromote('${q.id}', ${JSON.stringify(q.question).replace(/"/g,'&quot;')}, '${q.agent_key}')">${svg(I.plus)}Toevoegen</button>
                  <button class="icon-btn" title="Verbergen" onclick="window.__agKbUnmDismiss('${q.id}')">${svg(I.x, 'width:13px;height:13px')}</button>
                </div>`;
              }).join('')}</div>`}
      </div>
    </div>`;
  }

  // ─── Artikel-modal ──────────────────────────────────────────────────────
  function _artikelModal() {
    const m = _ui.artModal; if (!m) return '';
    const isEdit = m.mode === 'edit';
    const it = m.item || {};
    return `<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9998;display:flex;align-items:center;justify-content:center;padding:20px" onclick="window.__agArtClose()">
      <div style="background:var(--surface);border-radius:var(--r-lg);max-width:640px;width:100%;max-height:88vh;overflow:auto;padding:22px" onclick="event.stopPropagation()">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
          <span class="tile-ico" style="background:var(--blue-soft);color:var(--blue)">${svg(I.book || I.doc)}</span>
          <div class="card-title">${isEdit ? 'Artikel bewerken' : 'Nieuw artikel'}</div>
          <button class="icon-btn" style="margin-left:auto" onclick="window.__agArtClose()">${svg(I.x)}</button>
        </div>
        <div style="display:flex;flex-direction:column;gap:12px">
          <label style="display:flex;flex-direction:column;gap:5px">
            <span style="font-size:12px;color:var(--text-2)">Onderwerp</span>
            <input type="text" id="art_onderwerp" value="${esc(it.onderwerp || '')}" style="padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);font-size:13px" />
          </label>
          <label style="display:flex;flex-direction:column;gap:5px">
            <span style="font-size:12px;color:var(--text-2)">Categorie</span>
            <select id="art_categorie" style="padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);font-size:13px">
              ${['','Aanbod','Prijzen','Praktisch','Over ons','FAQ','Overig'].map((c) => `<option value="${esc(c)}" ${c === (it.categorie || '') ? 'selected' : ''}>${c || '—'}</option>`).join('')}
            </select>
          </label>
          <label style="display:flex;flex-direction:column;gap:5px">
            <span style="font-size:12px;color:var(--text-2)">Content</span>
            <textarea id="art_content" style="min-height:120px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);font-size:13px;font-family:inherit;resize:vertical">${esc(it.content || '')}</textarea>
          </label>
          <div>
            <div style="font-size:12px;color:var(--text-2);margin-bottom:5px">Voor welke agents?</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              ${['joost','simone','mila','lisa'].map((k) => {
                const ag = AGENTS_STATIC.find((x) => x.id === k);
                const on = Array.isArray(it.agents) && it.agents.includes(k);
                return `<label style="display:inline-flex;align-items:center;gap:5px;padding:5px 10px;border:1px solid var(--border);border-radius:8px;cursor:pointer;background:${on ? 'var(--surface-2)' : 'var(--surface)'}">
                  <input type="checkbox" data-art-agent="${k}" ${on ? 'checked' : ''} style="margin:0" />
                  <span style="width:8px;height:8px;border-radius:50%;background:var(--${ag.c});display:inline-block"></span>
                  <span style="font-size:12.5px">${esc(ag.n)}</span>
                </label>`;
              }).join('')}
            </div>
          </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:20px;justify-content:flex-end">
          <button class="btn btn-ghost btn-sm" onclick="window.__agArtClose()">Annuleren</button>
          <button class="btn btn-primary btn-sm" onclick="window.__agArtSave()">${svg(I.tick)}${isEdit ? 'Opslaan' : 'Aanmaken'}</button>
        </div>
      </div>
    </div>`;
  }
  window.__agArtOpenNew = () => {
    _ui.artModal = { mode: 'create', item: { onderwerp: '', categorie: 'FAQ', content: '', agents: [] } };
    if (window.DFO?.render) window.DFO.render();
  };
  window.__agKbArtEdit = (id) => {
    const it = asArr(_live.kbArt.data).find((x) => x.id === id);
    if (!it) return;
    _ui.artModal = { mode: 'edit', item: { ...it } };
    if (window.DFO?.render) window.DFO.render();
  };
  // Bug 1: rij-klik-handlers voor kennisbank-tabellen (H.table verwacht een
  // function-naam die met (rowIdx) wordt aangeroepen). Central rijen openen
  // de bewerk-modal. Agent-KB rijen navigeren naar de eerste bijbehorende
  // agent's Configuratie → Kennisbank (geen aparte bewerk-modal voor
  // agent-KB items — dat gebeurt inline op agent-config).
  window.__agKbCentralRowClick = (i) => {
    const arr = window.__agKbCentralArts || [];
    const it = arr[i]; if (!it) return;
    window.__agKbArtEdit(it.id);
  };
  window.__agKbAllRowClick = (i) => {
    const arr = window.__agKbAllArts || [];
    const it = arr[i]; if (!it) return;
    // agents is een array van namen; vind eerste bijbehorende agent-id.
    const firstAgentName = Array.isArray(it.agents) && it.agents.length ? it.agents[0] : null;
    if (!firstAgentName) { alert('Geen agent gekoppeld aan dit KB-item.'); return; }
    const ag = AGENTS_STATIC.find((x) => x.n === firstAgentName || x.id === firstAgentName);
    if (!ag) { alert('Bijbehorende agent niet gevonden.'); return; }
    _ui.agSel = ag.id;
    _ui.agCfgTab = 'Kennisbank';
    if (window.DFO?.setTab) window.DFO.setTab('Configuratie');
    else if (window.DFO?.render) window.DFO.render();
  };
  window.__agArtClose = () => { _ui.artModal = null; if (window.DFO?.render) window.DFO.render(); };
  window.__agArtSave = async () => {
    const m = _ui.artModal; if (!m) return;
    const onderwerp = (document.getElementById('art_onderwerp')?.value || '').trim();
    if (!onderwerp) { alert('Onderwerp vereist.'); return; }
    const categorie = (document.getElementById('art_categorie')?.value || '').trim() || null;
    const content   = (document.getElementById('art_content')?.value || '');
    const agents = Array.from(document.querySelectorAll('input[data-art-agent]:checked')).map((el) => el.getAttribute('data-art-agent'));
    const body = { onderwerp, categorie, content, agents };
    try {
      let j;
      if (m.mode === 'create') {
        j = await window.KV.authedJson('/api/kennisbank-artikelen', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        j = await window.KV.authedJson('/api/kennisbank-artikelen?id=' + encodeURIComponent(m.item.id), {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      }
      if (j?.error) throw new Error(j.error);
      _ui.artModal = null;
      _live.kbArt.data = null; queueMicrotask(fetchKbArt);
      _showToast(m.mode === 'create' ? 'Artikel aangemaakt' : 'Artikel bijgewerkt');
    } catch (e) {
      alert('Opslaan mislukt: ' + (e?.message || 'onbekende fout'));
    }
  };
  window.__agKbArtDelete = async (id) => {
    if (!window.confirm('Artikel verwijderen? Dit kan niet ongedaan gemaakt worden.')) return;
    try {
      const j = await window.KV.authedJson('/api/kennisbank-artikelen?id=' + encodeURIComponent(id), { method: 'DELETE' });
      if (j?.error) throw new Error(j.error);
      _live.kbArt.data = null; queueMicrotask(fetchKbArt);
      _showToast('Artikel verwijderd');
    } catch (e) {
      alert('Verwijderen mislukt: ' + (e?.message || 'onbekende fout'));
    }
  };
  window.__agKbArtPromote = async (id) => {
    const target = window.prompt('Naar welke agent promoveren?\n\nTyp: joost / simone / mila / lisa');
    if (!target) return;
    const t = target.trim().toLowerCase();
    if (!['joost','simone','mila','lisa'].includes(t)) { alert('Onbekende agent.'); return; }
    try {
      const j = await window.KV.authedJson('/api/kennisbank-promote-to-agent', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artikel_id: id, target_agent: t }),
      });
      if (j?.error) throw new Error(j.error);
      _live.kbArt.data = null; queueMicrotask(fetchKbArt);
      // Refresh perConfig/lisa zodat de aggregate-tabel de nieuwe key ziet
      if (t === 'lisa') { _live.lisa.data = null; queueMicrotask(fetchLisaConfig); }
      else {
        const mod = { joost:'finance', simone:'events', mila:'onboarding' }[t];
        _live.perConfig.data[mod] = null; queueMicrotask(() => fetchPerConfig(mod));
      }
      _showToast('Gepromoveerd naar ' + t);
    } catch (e) {
      alert('Promoveren mislukt: ' + (e?.message || 'onbekende fout'));
    }
  };
  window.__agKbUnmPromote = (id, question, agentKey) => {
    _ui.artModal = { mode: 'create', item: {
      onderwerp: question, categorie: 'FAQ', content: '', agents: [agentKey],
      __from_unmatched_id: id,
    }};
    if (window.DFO?.render) window.DFO.render();
  };
  window.__agKbUnmDismiss = async (id) => {
    if (!window.confirm('Verbergen uit de lijst? De vraag wordt gemarkeerd als afgehandeld.')) return;
    try {
      const j = await window.KV.authedJson('/api/kennisbank-unmatched?action=dismiss', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (j?.error) throw new Error(j.error);
      _live.kbUnm.data = null; queueMicrotask(fetchKbUnm);
    } catch (e) {
      alert('Verbergen mislukt: ' + (e?.message || 'onbekende fout'));
    }
  };

  function _kbCat(key) {
    const k = String(key || '').toLowerCase();
    if (/prijs|betaal|termijn|kwijt|kort/.test(k)) return 'Prijzen';
    if (/product|traject|membership|event|coach/.test(k)) return 'Aanbod';
    if (/hoe|wanneer|welke|tijd|uur|dag|documenten|onboarding/.test(k)) return 'Praktisch';
    if (/wie|team|mentor|over/.test(k)) return 'Over ons';
    if (/dos|donts|stop/.test(k)) return 'Regels';
    return 'Overig';
  }
  function _kbToolbar(catCount, totalCount) {
    const agentOptions = ['all', ...AGENTS_STATIC.filter((a) => a.config).map((a) => a.n)];
    const cats = [
      { l:'Alles', v:'all', n:totalCount },
      { l:'Aanbod', v:'aanbod', n:catCount.Aanbod },
      { l:'Prijzen', v:'prijzen', n:catCount.Prijzen },
      { l:'Praktisch', v:'praktisch', n:catCount.Praktisch },
      { l:'Over ons', v:'over ons', n:catCount['Over ons'] },
      { l:'FAQ', v:'faq', n:catCount.FAQ },
    ];
    return `<div class="toolbar" style="padding:12px 20px;gap:8px;flex-wrap:wrap;border-bottom:1px solid var(--border)">
      <select class="filter-sel" onchange="window.__agKbAgent(this.value)">
        ${agentOptions.map((o) => `<option value="${esc(o)}" ${_ui.kbFilter.agent === o ? 'selected' : ''}>${o === 'all' ? 'Alle agents' : esc(o)}</option>`).join('')}
      </select>
      ${cats.map((c) => `<button class="chip ${_ui.kbFilter.cat === c.v ? 'on' : ''}" onclick="window.__agKbCat('${c.v}')">${esc(c.l)}${c.n !== undefined ? `<span class="cnt">${c.n}</span>` : ''}</button>`).join('')}
      <div class="tb-search"><input placeholder="Zoek artikel…" value="${esc(_ui.kbFilter.q)}" oninput="window.__agKbQ(this.value)" style="border:1px solid var(--border);padding:6px 10px;border-radius:8px;background:var(--surface);color:var(--text-1);font-size:12.5px" /></div>
      <div class="tb-right"><button class="btn btn-primary btn-sm" onclick="window.__agArtOpenNew()">${svg(I.plus)}Artikel</button></div>
    </div>`;
  }
  window.__agKbAgent = (v) => { _ui.kbFilter.agent = v; if (window.DFO?.render) window.DFO.render(); };
  window.__agKbCat   = (v) => { _ui.kbFilter.cat = v; if (window.DFO?.render) window.DFO.render(); };
  window.__agKbQ     = (v) => { _ui.kbFilter.q = v; if (window.DFO?.render) window.DFO.render(); };

  // ═══════════════════════════════════════════════════════════════════════
  // VIEW 4 — PRESTATIES
  // ═══════════════════════════════════════════════════════════════════════
  function prestatiesView() {
    if (!_live.activity.data && !_live.activity.loading && !_live.activity.error) queueMicrotask(fetchActivity);
    if (!_live.prest.data    && !_live.prest.loading    && !_live.prest.error)    queueMicrotask(fetchPrest);
    if (_live.activity.error && !_live.activity.data) return errBlk('activity', _live.activity.error);
    if (_live.activity.loading && !_live.activity.data) return skel();

    const activity = _live.activity.data || {};
    const trio = asArr(activity.trio); const lisa = activity.lisa || {};
    const prest = _live.prest.data || {};
    const rt = prest.response_times || {};
    const fbCounts = prest.feedback_counts || {};

    let totalMsgs = 0; for (const t of trio) totalMsgs += Number(t.messages_today || 0);
    totalMsgs += Number(lisa.messages_today || 0);
    let totalHandoffs = 0; for (const t of trio) totalHandoffs += Number(t.handoffs || 0);
    totalHandoffs += Number(lisa.human_takeover || 0);
    const zelfPct = totalMsgs ? Math.max(0, Math.round(100 * (1 - totalHandoffs / totalMsgs))) + '%' : '—';

    // Gemiddelde reactietijd over agents met data (gewogen op count).
    const overallRT = _weightedAvgRT(rt);

    const perAgentRows = [];
    for (const t of trio) {
      const ag = AGENTS_STATIC.find((a) => a.backend === t.module); if (!ag) continue;
      const msg = Number(t.messages_today || 0); const hnd = Number(t.handoffs || 0);
      const zelf = msg ? Math.max(0, Math.round(100 * (1 - hnd / msg))) + '%' : '—';
      const cls = msg && hnd / Math.max(1, msg) < 0.15 ? 'ok' : (hnd / Math.max(1, msg) < 0.35 ? 'warn' : 'danger');
      perAgentRows.push({ ag, msg, zelf, hnd, res: fmtNum(t.open_suggestions) + ' open', cls, rt: rt[ag.id] || null });
    }
    const lisaAg = AGENTS_STATIC.find((a) => a.id === 'lisa');
    if (lisaAg) {
      const msg = Number(lisa.messages_today || 0); const hnd = Number(lisa.human_takeover || 0);
      const zelf = msg ? Math.max(0, Math.round(100 * (1 - hnd / msg))) + '%' : '—';
      const cls = msg && hnd / Math.max(1, msg) < 0.15 ? 'ok' : (hnd / Math.max(1, msg) < 0.35 ? 'warn' : 'danger');
      perAgentRows.push({ ag: lisaAg, msg, zelf, hnd, res: fmtNum(lisa.call_booked) + ' calls', cls, rt: rt.lisa || null });
    }
    // Bug 3: Aisha (leadsonderhoud, uit berichten_log) + AI Manager (geen metriek → toon —).
    const aishaAg = AGENTS_STATIC.find((a) => a.id === 'aisha');
    if (aishaAg) {
      const aisha = prest.aisha || {};
      const msg = Number(aisha.messages_today || 0);
      const errs = Number(aisha.errors_week || 0);
      const zelf = msg ? Math.max(0, Math.round(100 * (1 - errs / Math.max(1, msg)))) + '%' : '—';
      const cls = msg && errs / Math.max(1, msg) < 0.05 ? 'ok' : (errs / Math.max(1, msg) < 0.15 ? 'warn' : 'danger');
      perAgentRows.push({ ag: aishaAg, msg, zelf, hnd: errs, res: errs ? fmtNum(errs) + ' fouten (7d)' : 'geen fouten', cls, rt: rt.aisha || null });
    }
    const managerAg = AGENTS_STATIC.find((a) => a.id === 'manager' || a.n === 'AI Manager' || /manager/i.test(a.n || ''));
    if (managerAg) {
      perAgentRows.push({ ag: managerAg, msg: '—', zelf: '—', hnd: '—', res: 'geen metriek', cls: 'neutral', rt: null, _placeholder: true });
    }

    return `${H.kpis([
      { c:'violet',  icon:I.chat,  label:'Gesprekken vandaag', val:fmtNum(totalMsgs),   hi:1, sub:'trio + Lisa' },
      { c:'emerald', icon:I.tick,  label:'Zelf afgehandeld',   val:zelfPct,             hi:1, sub:'schatting' },
      { c:'amber',   icon:I.users, label:'Overgenomen',        val:fmtNum(totalHandoffs), hi:1, sub:'door mens' },
      { c:'blue',    icon:I.clock, label:'Reactietijd',        val:overallRT.label,     hi:overallRT.hi ? 1 : 0, sub:overallRT.sub },
    ])}
    ${_live.prest.error ? errBlk('prest', _live.prest.error) : ''}
    ${prest.feedback_unavailable ? `<div style="margin:14px 20px;padding:11px 15px;border:1px solid var(--amber-line);background:var(--amber-soft);border-radius:var(--r);font-size:12.5px;color:var(--amber);display:flex;gap:11px;align-items:flex-start">
      ${svg(I.alert, 'width:15px;height:15px;flex-shrink:0;margin-top:1px')}
      <span>Feedback-tabel bestaat nog niet in de DB. Draai migratie <span class="mono">2026-08-13-agent-suggestion-feedback.sql</span> om duim-op/duim-neer te activeren.</span>
    </div>` : ''}

    <div class="pad"><div class="card" style="margin-bottom:14px">
      <div class="card-head">
        <span class="tile-ico" style="background:var(--violet-soft);color:var(--violet)">${svg(I.chart)}</span>
        <div class="card-title">Per agent — vandaag</div>
        <span style="margin-left:auto;font-size:11px;color:var(--text-3)">reactietijd = gemiddelde over laatste 7 dagen</span>
      </div>
      ${perAgentRows.length === 0
        ? `<div class="empty" style="padding:44px 20px"><div class="empty-t">Geen activity-data</div></div>`
        : H.table(
            [{l:'Agent'}, {l:'Berichten', cls:'r'}, {l:'Zelf afgehandeld', cls:'r'}, {l:'Overgenomen', cls:'r optional'}, {l:'Reactietijd', cls:'r'}, {l:'Resultaat', cls:'r optional'}, {l:'Beoordeling'}],
            perAgentRows.map((r) => [
              `<div style="display:flex;align-items:center;gap:9px">${_radial(r.ag.c, 24)}<span class="cell-main">${esc(r.ag.n)}</span></div>`,
              `<span class="mono">${r.msg}</span>`,
              `<span class="pill pill-${r.cls} nodot">${esc(r.zelf)}</span>`,
              `<span class="mono">${r.hnd}</span>`,
              _rtCell(r.rt),
              `<span style="font-size:12.5px;color:var(--text-2)">${esc(r.res)}</span>`,
              _feedbackCell(r.ag.id, fbCounts[r.ag.id] || { up:0, down:0 }, !!prest.feedback_unavailable),
            ])
          )}
    </div>

    <div class="grid g2">
      <div class="card"><div class="card-head">
        <span class="tile-ico" style="background:var(--blue-soft);color:var(--blue)">${svg(I.chart)}</span>
        <div class="card-title">Gesprekken per week</div>
        <span style="margin-left:auto;font-size:11px;color:var(--text-3)">laatste 8 weken</span>
      </div>
      ${_live.prest.loading && !_live.prest.data ? skel() : _weeklyChart(prest.weekly || {})}
      </div>
      <div class="card"><div class="card-head">
        <span class="tile-ico" style="background:var(--amber-soft);color:var(--amber)">${svg(I.users)}</span>
        <div class="card-title">Waarom er wordt overgenomen</div></div>
        ${soon('Reden-breakdown — binnenkort', 'Vereist wijziging aan de beschermde handoff-detectie; komt in een latere fase.')}
      </div>
    </div>
    </div>`;
  }

  function _weightedAvgRT(rt) {
    let sum = 0, cnt = 0;
    for (const k of Object.keys(rt || {})) {
      const r = rt[k]; if (!r || r.avg_seconds == null || !r.count) continue;
      sum += r.avg_seconds * r.count; cnt += r.count;
    }
    if (!cnt) return { label: '—', sub: 'te weinig data', hi: false };
    const avg = Math.round(sum / cnt);
    return { label: _fmtRT(avg), sub: 'gemiddeld · ' + fmtNum(cnt) + ' paren (7d)', hi: true };
  }
  function _fmtRT(sec) {
    if (sec == null) return '—';
    if (sec < 60)   return sec + 's';
    if (sec < 3600) return Math.round(sec / 60) + 'm';
    return (sec / 3600).toFixed(1) + 'u';
  }
  function _rtCell(rt) {
    if (!rt || rt.avg_seconds == null) return `<span style="color:var(--text-3)">—</span>`;
    return `<span class="mono" title="${rt.count} paren gemeten (laatste 7d)">${_fmtRT(rt.avg_seconds)}</span>`;
  }
  function _feedbackCell(agentId, counts, unavailable) {
    const disabledStyle = unavailable ? 'opacity:.5;cursor:not-allowed' : '';
    const busy = _ui.saving['fb_' + agentId];
    return `<div style="display:flex;gap:4px;justify-content:flex-end;align-items:center">
      <button class="icon-btn" ${unavailable || busy ? 'disabled' : ''} style="width:26px;height:26px;${disabledStyle}${busy ? 'opacity:.5' : ''}" title="Goed${unavailable ? ' — migratie ontbreekt' : ''}" onclick="window.__agFeedback('${agentId}','up')">${svg('<path d="M7 10v12M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88z"/>', 'width:13px;height:13px')}</button>
      <span class="mono" style="font-size:11px;color:var(--text-3);min-width:14px;text-align:center">${counts.up || 0}</span>
      <button class="icon-btn" ${unavailable || busy ? 'disabled' : ''} style="width:26px;height:26px;${disabledStyle}${busy ? 'opacity:.5' : ''}" title="Kon beter${unavailable ? ' — migratie ontbreekt' : ''}" onclick="window.__agFeedback('${agentId}','down')">${svg('<path d="M17 14V2M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88z"/>', 'width:13px;height:13px')}</button>
      <span class="mono" style="font-size:11px;color:var(--text-3);min-width:14px;text-align:center">${counts.down || 0}</span>
    </div>`;
  }
  window.__agFeedback = async (agentId, rating) => {
    const a = AGENTS_STATIC.find((x) => x.id === agentId);
    if (!a) return;
    const key = 'fb_' + agentId;
    if (_ui.saving[key]) return;
    _ui.saving[key] = true;
    if (window.DFO?.render) window.DFO.render();
    try {
      const body = { agent_key: a.id, rating };
      if (a.backend && a.backend !== 'lisa' && !a.backend.startsWith('bg-')) body.module = a.backend;
      const j = await window.KV.authedJson('/api/agent-feedback-create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (j?.error) throw new Error(j.error);
      // Optimistisch: bump lokaal + refetch prestaties
      if (_live.prest.data?.feedback_counts?.[a.id]) {
        _live.prest.data.feedback_counts[a.id][rating] = (_live.prest.data.feedback_counts[a.id][rating] || 0) + 1;
      }
      _showToast('Feedback ' + (rating === 'up' ? 'positief' : 'negatief') + ' opgeslagen voor ' + a.n);
    } catch (e) {
      alert('Feedback opslaan mislukt: ' + (e?.message || 'onbekende fout'));
    } finally {
      _ui.saving[key] = false;
      if (window.DFO?.render) window.DFO.render();
    }
  };
  function _showToast(msg) {
    const el = document.getElementById('kv-toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(_showToast._t);
    _showToast._t = setTimeout(() => el.classList.remove('show'), 3000);
  }

  // Multi-agent weekly stacked-line SVG. weekly = { joost:[{week_start,count}], simone:[...], ... }
  function _weeklyChart(weekly) {
    const agents = ['joost','simone','mila','lisa'];
    const series = agents.map((k) => ({
      key: k,
      ag: AGENTS_STATIC.find((a) => a.id === k),
      data: Array.isArray(weekly[k]) ? weekly[k] : [],
    })).filter((s) => s.ag && s.data.length);
    if (series.length === 0) return `<div class="card-body" style="padding:24px;text-align:center;color:var(--text-3);font-size:13px">Nog geen data om te tonen.</div>`;

    // Alle series delen dezelfde week-set (endpoint garandeert 8 weeks).
    const weeks = series[0].data.map((d) => d.week_start);
    const maxCount = Math.max(1, ...series.flatMap((s) => s.data.map((d) => d.count)));
    const W = 640, H_ = 180, pad = { t: 12, r: 12, b: 24, l: 32 };
    const cw = W - pad.l - pad.r;
    const ch = H_ - pad.t - pad.b;
    const xStep = weeks.length > 1 ? cw / (weeks.length - 1) : 0;
    const y = (c) => pad.t + ch - (c / maxCount) * ch;

    const gridLines = [];
    for (let i = 0; i <= 4; i++) {
      const yy = pad.t + (ch / 4) * i;
      const val = Math.round(maxCount - (maxCount / 4) * i);
      gridLines.push(`<line x1="${pad.l}" y1="${yy}" x2="${W - pad.r}" y2="${yy}" stroke="var(--border)" stroke-width="1" stroke-dasharray="2,3" opacity=".5" />
        <text x="${pad.l - 4}" y="${yy + 3}" text-anchor="end" font-size="9" fill="var(--text-3)" font-family="'IBM Plex Mono',monospace">${val}</text>`);
    }
    const xLabels = weeks.map((w, i) => {
      const d = new Date(w);
      const label = String(d.getUTCDate()).padStart(2,'0') + '/' + String(d.getUTCMonth()+1).padStart(2,'0');
      return `<text x="${pad.l + i * xStep}" y="${H_ - 6}" text-anchor="middle" font-size="9" fill="var(--text-3)" font-family="'IBM Plex Mono',monospace">${label}</text>`;
    }).join('');

    const paths = series.map((s) => {
      const pts = s.data.map((d, i) => `${pad.l + i * xStep},${y(d.count)}`);
      const path = 'M ' + pts.join(' L ');
      const color = 'var(--' + s.ag.c + ')';
      const dots = pts.map((p) => `<circle cx="${p.split(',')[0]}" cy="${p.split(',')[1]}" r="2.5" fill="${color}" />`).join('');
      return `<path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />${dots}`;
    }).join('');

    const legend = series.map((s) => `<span style="display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--text-2)">
      <span style="width:9px;height:9px;border-radius:50%;background:var(--${s.ag.c})"></span>${esc(s.ag.n)}</span>`).join('');

    return `<div class="card-body" style="padding:14px 12px 8px">
      <svg viewBox="0 0 ${W} ${H_}" style="width:100%;height:auto;display:block" preserveAspectRatio="xMidYMid meet">
        ${gridLines.join('')}
        ${paths}
        ${xLabels}
      </svg>
      <div style="display:flex;gap:14px;flex-wrap:wrap;padding:8px 20px 0;justify-content:center">${legend}</div>
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
  console.debug('[agents-v2] Fase 1 consolidatie — trio-uitbreiding + Lisa-bridge + live-toggles + bg-tellers');
})();
