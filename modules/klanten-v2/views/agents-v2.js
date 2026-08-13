// modules/klanten-v2/views/agents-v2.js
//
// Fase F — AI Agents. DATA-KOPPELING 2026-08-13. Dormant.
// QA via ?v2preview=agents.
//
// Endpoints (read-only):
//   GET /api/agents                (agents.view.overview)
//   GET /api/agents-activity       (admin.joost_config)
//   GET /api/agents-config-list    (admin.joost_config)
//   GET /api/agent-approval?action=list
//
// Needs Jeffrey:
// - Chat/meeting write-flows (/api/agent-chat, /api/agent-meeting).
// - Config writes voor Joost (protected zone — /api/joost-* verboden).
// - Config writes voor Simone/Mila (bestaan via /api/joost-config-upsert
//   maar semantiek onduidelijk: zelfde module of aparte agents-tabel?).
// - Kennisbank upload/beheer.
// - Naming-drift Simon/Leon/Aron (CLAUDE.md) vs Joost/Simone/Mila/Lisa
//   (live database).

(function () {
  if (!window.DFO) { console.error('[agents-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[agents-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, S } = window.DFO;
  const H = window.KV_V2.helpers;

  const asArr = (x) => Array.isArray(x) ? x : [];
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const _live = {
    agents:   { loading: false, error: null, data: null },
    activity: { loading: false, error: null, data: null },
    config:   { loading: false, error: null, data: null },
    approval: { loading: false, error: null, data: null },
  };

  async function tryFetch(label, url, timeoutMs = 8000) {
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      return await Promise.race([
        window.KV.authedJson(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) { console.warn('[ag-v2] ' + label + ' fail:', e?.message); return { __error: e?.message || 'onbekende fout' }; }
  }
  async function fetchAgents() {
    const st = _live.agents; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('agents', '/api/agents');
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = asArr(j?.agents);
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchActivity() {
    const st = _live.activity; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('activity', '/api/agents-activity');
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = j || null;
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchConfig() {
    const st = _live.config; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('config', '/api/agents-config-list');
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = asArr(j?.agents);
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchApproval() {
    const st = _live.approval; if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('approval', '/api/agent-approval?action=list');
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = asArr(j?.approvals || j?.rows);
    if (window.DFO?.render) window.DFO.render();
  }
  window.__agRetry = (b) => { if (_live[b]) { _live[b].data = null; _live[b].error = null; } if (b==='agents') fetchAgents(); if (b==='activity') fetchActivity(); if (b==='config') fetchConfig(); if (b==='approval') fetchApproval(); };
  window.__agNotice = (l) => { console.info('[ag-v2] ' + l); try { alert(l + ' — write-flow needs Jeffrey. Joost = protected zone.'); } catch (_) {} };

  const errBlk = (block, msg) => `<div style="margin:20px;padding:14px 18px;border:1px solid var(--rose-line);background:var(--rose-soft);border-radius:var(--r);color:var(--rose);font-size:13px;display:flex;align-items:center;gap:12px">
    <span>${svg(I.alert || I.warn, 'width:16px;height:16px')}</span>
    <span style="flex:1">Kon ophalen: ${esc(msg)}${/401|403/.test(msg || '') ? ' (admin/super_admin vereist)' : ''}</span>
    <button class="btn btn-ghost btn-sm" onclick="__agRetry('${block}')">Opnieuw</button></div>`;
  const skel = () => `<div class="pad"><div class="card"><div class="card-body" style="padding:22px;opacity:.55"><div style="height:12px;background:var(--surface-2);border-radius:4px;width:60%;margin-bottom:12px"></div></div></div></div>`;
  const nj = (r) => `<div style="margin:20px;padding:14px 18px;border:1px solid var(--amber-line);background:var(--amber-soft);border-radius:var(--r);color:var(--amber);font-size:12.5px"><b>Needs Jeffrey</b> — ${esc(r)}</div>`;

  function _agentColor(name) {
    const n = String(name || '').toLowerCase();
    if (n === 'joost') return 'amber';
    if (n === 'simone') return 'pink';
    if (n === 'mila') return 'emerald';
    if (n === 'lisa') return 'violet';
    if (n === 'amigo') return 'blue';
    if (n === 'ricardo') return 'slate';
    return 'blue';
  }
  function _agentLock(name) { return String(name || '').toLowerCase() === 'joost'; }

  // ── VIEW: Overzicht ──────────────────────────────────────────────────
  function overzichtView() {
    if (!_live.agents.data && !_live.agents.loading && !_live.agents.error) queueMicrotask(fetchAgents);
    if (!_live.activity.data && !_live.activity.loading && !_live.activity.error) queueMicrotask(fetchActivity);
    if (!_live.approval.data && !_live.approval.loading && !_live.approval.error) queueMicrotask(fetchApproval);
    if (_live.agents.error && !_live.agents.data) return errBlk('agents', _live.agents.error);
    if (_live.agents.loading && !_live.agents.data) return skel();
    const agents = asArr(_live.agents.data);
    const activity = _live.activity.data || {};
    const modStats = activity.module_stats || {};
    const teamTotals = activity.team_totals || {};
    const approvals = asArr(_live.approval.data);
    const waitCount = approvals.filter((a) => a?.status === 'pending' || a?.status === 'awaiting_approval').length;
    return `${H.kpis([
      { c: 'violet',  icon: I.bot,   label: 'Agents totaal',   val: String(agents.length), sub: 'in beheer' },
      { c: 'emerald', icon: I.chat,  label: 'Berichten vandaag', val: String(Number(teamTotals.messages_today || 0)), hi: 1 },
      { c: 'amber',   icon: I.alert, label: 'Overgenomen',      val: String(Number(teamTotals.handoffs || 0)), hi: 1 },
      { c: 'rose',    icon: I.clock, label: 'Wacht op jou',    val: String(waitCount), hi: 1, sub: approvals.length + ' totaal' },
    ])}
    ${_live.activity.error ? errBlk('activity', _live.activity.error) : ''}
    ${_live.approval.error ? errBlk('approval', _live.approval.error) : ''}
    <div class="pad" style="padding-top:16px">
      <div style="font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3);margin-bottom:11px">Agents (${agents.length})</div>
      ${agents.length === 0
        ? `<div class="empty" style="padding:44px 20px"><div class="empty-t">Geen agents</div><div class="empty-s">Kantoor voegt agents toe via de admin-flow.</div></div>`
        : `<div class="grid g3">
          ${agents.map((a) => {
            const c = a.avatar_color || _agentColor(a.name);
            const locked = _agentLock(a.name);
            const stats = modStats[String(a.name || '').toLowerCase()] || {};
            return `<div class="card">
              <div style="padding:15px 17px;display:flex;align-items:flex-start;gap:12px">
                <span class="tile-ico" style="background:var(--${c}-soft);color:var(--${c})">${esc(a.avatar_emoji || svg(I.bot))}</span>
                <div style="flex:1;min-width:0">
                  <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">
                    <span class="card-title">${esc(a.name || '—')}</span>
                    ${locked ? `<span class="pill pill-warn nodot" style="font-size:10.5px;padding:1.5px 7px">Protected</span>` : ''}
                  </div>
                  <div style="font-size:12px;color:var(--text-3);margin-top:3px">${esc(a.role || '')}${a.department ? ' · ' + esc(a.department) : ''}</div>
                </div>
              </div>
              <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--border);border-top:1px solid var(--border)">
                ${[[stats.messages_today || 0, 'MSG 24U'], [stats.open_suggestions || 0, 'OPEN'], [stats.handoffs || 0, 'HAND']].map(([v, l]) => `<div style="background:var(--surface);padding:10px 12px;text-align:center">
                  <div style="font-size:16px;font-weight:600;font-family:'IBM Plex Mono',monospace">${v}</div>
                  <div style="font-size:10px;letter-spacing:.05em;color:var(--text-3);margin-top:2px">${l}</div></div>`).join('')}
              </div>
            </div>`;
          }).join('')}
        </div>`}
    </div>`;
  }

  // ── VIEW: Configuratie ───────────────────────────────────────────────
  function configuratieView() {
    if (!_live.config.data && !_live.config.loading && !_live.config.error) queueMicrotask(fetchConfig);
    if (_live.config.error && !_live.config.data) return errBlk('config', _live.config.error);
    if (_live.config.loading && !_live.config.data) return skel();
    const cfg = asArr(_live.config.data);
    return `${nj('Alle config-writes (persona/tone/model/is_enabled/channel/knowledge) zijn super_admin only en Joost-config zit in protected zone. Read-only overzicht hieronder.')}
    ${cfg.length === 0
      ? `<div class="empty" style="padding:44px 20px"><div class="empty-t">Geen agent-config</div></div>`
      : H.table(
          [{ l: 'Agent' }, { l: 'Module', cls: 'optional' }, { l: 'Persona' }, { l: 'Tone', cls: 'optional' }, { l: 'Model', cls: 'optional' }, { l: 'Actief' }, { l: 'Kanaal', cls: 'optional' }],
          cfg.map((a) => [
            `<div class="row-avatar">${H.av(a.persona_name || a.type || '—', 26)}<span class="cell-main">${esc(a.persona_name || a.type || '—')}</span></div>`,
            `<span style="font-size:11.5px;color:var(--text-2)">${esc(a.module || '—')}</span>`,
            `<span style="font-size:11.5px">${esc(a.persona_name || '—')}</span>`,
            `<span style="font-size:11.5px;color:var(--text-3)">${esc(a.persona_tone || a.tone || '—')}</span>`,
            `<span class="mono" style="font-size:11.5px;color:var(--text-3)">${esc(a.model || '—')}</span>`,
            a.is_enabled || a.is_active ? H.pill('ok', 'Aan') : H.pill('neutral', 'Uit'),
            `<span style="font-size:11px;color:var(--text-3)">${esc(a.channel?.phone_number_id || (a.channel?.is_active ? 'actief' : '—'))}</span>`,
          ])
        )}`;
  }

  // ── VIEW: Kennisbank ─────────────────────────────────────────────────
  function kennisbankView() {
    return `${nj('Kennisbank is per-agent in joost_config.knowledge_base (jsonb). Aggregatie over alle agents + upload-flow bestaat niet als endpoint. Open individueel agent-config in v1 admin.')}
    <div style="padding:24px;color:var(--text-3);font-size:13px;line-height:1.6">Read-only aggregatie komt in de volgende ronde; upload endpoints ontbreken.</div>`;
  }

  // ── VIEW: Prestaties ─────────────────────────────────────────────────
  function prestatiesView() {
    if (!_live.activity.data && !_live.activity.loading && !_live.activity.error) queueMicrotask(fetchActivity);
    if (_live.activity.error && !_live.activity.data) return errBlk('activity', _live.activity.error);
    if (_live.activity.loading && !_live.activity.data) return skel();
    const activity = _live.activity.data || {};
    const modStats = activity.module_stats || {};
    const lisaStats = activity.lisa_stats || {};
    const modules = Object.keys(modStats);
    return `${H.kpis([
      { c: 'violet',  icon: I.bot,   label: 'Modules met agent',    val: String(modules.length) },
      { c: 'emerald', icon: I.chat,  label: 'Berichten 24u',        val: String(Number(activity.team_totals?.messages_today || 0)), hi: 1 },
      { c: 'amber',   icon: I.alert, label: 'Overgenomen',          val: String(Number(activity.team_totals?.handoffs || 0)), hi: 1 },
      { c: 'blue',    icon: I.cal,   label: 'Lisa geboekt',         val: String(Number(lisaStats.call_booked || 0)) },
    ])}
    ${modules.length === 0
      ? `<div class="empty" style="padding:44px 20px"><div class="empty-t">Geen activity-data</div></div>`
      : H.table(
          [{ l: 'Module' }, { l: 'Berichten 24u', cls: 'r' }, { l: 'Open', cls: 'r optional' }, { l: 'Overgenomen', cls: 'r optional' }, { l: 'Actieve conv', cls: 'r optional' }, { l: 'Laatste activiteit', cls: 'r optional' }],
          modules.map((m) => {
            const s = modStats[m] || {};
            return [
              `<span class="cell-main">${esc(m)}</span>`,
              `<span class="mono">${Number(s.messages_today || 0)}</span>`,
              `<span class="mono">${Number(s.open_suggestions || 0)}</span>`,
              `<span class="mono">${Number(s.handoffs || 0)}</span>`,
              `<span class="mono">${Number(s.active_conversations || 0)}</span>`,
              `<span class="mono" style="color:var(--text-3);font-size:12px">${s.last_activity_at ? new Date(s.last_activity_at).toLocaleString('nl-NL', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : '—'}</span>`,
            ];
          })
        )}`;
  }

  window.DFO.VIEWS['agents/Overzicht']    = overzichtView;
  window.DFO.VIEWS['agents/Configuratie'] = configuratieView;
  window.DFO.VIEWS['agents/Kennisbank']   = kennisbankView;
  window.DFO.VIEWS['agents/Prestaties']   = prestatiesView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('agents');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('agents');
  console.debug('[agents-v2] data-ronde geregistreerd (dormant)');
})();
