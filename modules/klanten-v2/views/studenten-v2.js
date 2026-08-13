// modules/klanten-v2/views/studenten-v2.js
//
// Fase C module — Studenten (mentor-view) voor v2-shell.
// DATA-KOPPELING 2026-08-13: read-only live-endpoints, dormant tot
// allowlist. Preview via ?v2preview=studenten (én rol Mentor via
// 'Bekijk als').
//
// Endpoints (self-scope; admin via ?mentor_user_id in v1 — hier alleen self):
//   - GET /api/mentor-my-students             (lijst met calls/no-shows)
//   - GET /api/mentor-students-invoice-status (overdue byEmail-map)
//   - GET /api/mentor-1on1-sessions           (planned + noshow_by_student)
//   - GET /api/mentor-student-detail?student_id=<bubble_id>  (dossier lazy)
//
// v1-parity samenvatting: v1 `mentor-students.html` heeft 3 top-tabs
// (Mijn studenten / 1-op-1 sessies / No shows). v2 heeft alleen de
// eerste tab; sessies + no-shows blijven in v1 tot latere v2-ronde.
// Status-afleiding gebeurt client-side (v1 `_studentStatus`-pattern):
//   - overdue > 0             → 'aandacht' (betalingsachterstand)
//   - no-show recent          → 'aandacht'
//   - geen call ingepland     → 'aandacht'
//   - anders                  → 'op schema'

(function () {
  if (!window.DFO) { console.error('[studenten-v2] DFO shell niet geladen.'); return; }
  const { I, svg, S, F, openPanel } = window.DFO;

  const asArr = (x) => Array.isArray(x) ? x : [];
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // ── Live-state ────────────────────────────────────────────────────────
  const _live = {
    list:      { loading: false, error: null, data: null },
    overdue:   { loading: false, error: null, byEmail: null },
    sessions:  { loading: false, error: null, plannedByStudent: null, noshowByStudent: null },
    detail:    new Map(), // studentId → { loading, error, data }
  };

  async function tryFetch(label, url, timeoutMs = 8000) {
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      return await Promise.race([
        window.KV.authedJson(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) { console.warn('[stu-v2] ' + label + ' fail:', e?.message); return { __error: e?.message || 'onbekende fout' }; }
  }

  // ── Fetchers ──────────────────────────────────────────────────────────
  async function fetchList() {
    const st = _live.list;
    if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('list', '/api/mentor-my-students');
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.data = { students: asArr(j?.students), scope: j?.scope || 'self', linked: !!j?.linked };
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchOverdue() {
    const st = _live.overdue;
    if (st.loading || st.byEmail) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('overdue', '/api/mentor-students-invoice-status');
    st.loading = false;
    if (j && j.__error) st.error = j.__error;
    else st.byEmail = (j && typeof j.byEmail === 'object' && j.byEmail) ? j.byEmail : {};
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchSessions() {
    const st = _live.sessions;
    if (st.loading || st.plannedByStudent) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('sessions', '/api/mentor-1on1-sessions');
    st.loading = false;
    if (j && j.__error) { st.error = j.__error; }
    else {
      // Build byStudent-maps (student = bubble user id).
      const plannedMap = new Map();
      const now = Date.now();
      for (const s of asArr(j?.planned)) {
        if (!s || !s.member_user || !s.starts_at) continue;
        const t = new Date(s.starts_at).getTime();
        if (!Number.isFinite(t) || t < now) continue;
        const prev = plannedMap.get(s.member_user);
        if (!prev || t < prev) plannedMap.set(s.member_user, t);
      }
      st.plannedByStudent = plannedMap;
      const noshowMap = new Map();
      const nsBy = j?.noshow_by_student;
      if (nsBy && typeof nsBy === 'object') {
        for (const k of Object.keys(nsBy)) noshowMap.set(k, nsBy[k]);
      }
      st.noshowByStudent = noshowMap;
    }
    if (window.DFO?.render) window.DFO.render();
  }
  async function fetchDetail(studentId) {
    if (!studentId) return;
    let entry = _live.detail.get(studentId);
    if (entry && (entry.loading || entry.data)) return;
    entry = { loading: true, error: null, data: null };
    _live.detail.set(studentId, entry);
    const j = await tryFetch('detail:' + studentId, '/api/mentor-student-detail?student_id=' + encodeURIComponent(studentId));
    entry.loading = false;
    if (j && j.__error) entry.error = j.__error; else entry.data = j || null;
    // Alleen re-render als het paneel nog open is voor dezelfde student
    if (_panelStudentId === studentId && window.DFO?.render) window.DFO.render();
    // Panel re-open direct (voorkomt stale content):
    if (_panelStudentId === studentId) _renderPanel();
  }

  window.__stuRetry = (block) => {
    if (block === 'list')     { _live.list.data = null; _live.list.error = null; fetchList(); }
    if (block === 'overdue')  { _live.overdue.byEmail = null; _live.overdue.error = null; fetchOverdue(); }
    if (block === 'sessions') { _live.sessions.plannedByStudent = null; _live.sessions.noshowByStudent = null; _live.sessions.error = null; fetchSessions(); }
    if (window.DFO?.render) window.DFO.render();
  };

  // ── UI-helpers (uit scaffold) ─────────────────────────────────────────
  const { avc, ini } = window.DFO;
  const av = (n, s = 28) => `<span class="avatar" style="width:${s}px;height:${s}px;background:${avc(n)};font-size:${s * .38}px">${ini(n)}</span>`;
  const pill = (c, t, nd) => `<span class="pill pill-${c} ${nd ? 'nodot' : ''}">${t}</span>`;
  const trend = (v, up) => `<span class="trend ${up === null ? 'trend-flat' : up ? 'trend-up' : 'trend-down'}">${up !== null ? svg(up ? I.up : I.arrDown) : ''}${v}</span>`;

  function kpi(o) {
    return `<div class="kpi" style="--kc:var(--${o.c});--kc-soft:var(--${o.c}-soft)"><div class="kpi-top"><span class="kpi-ico">${svg(o.icon)}</span><span class="kpi-label">${o.label}</span></div>
      <div class="kpi-val" style="${o.hi ? `color:var(--${o.c})` : ''}">${o.val}</div>
      <div class="kpi-foot">${o.trend || ''}<span>${o.sub || ''}</span></div></div>`;
  }
  const kpis = arr => `<div class="hero"><div class="kpi-grid">${arr.map(kpi).join('')}</div></div>`;
  const toolbar = p => `<div class="toolbar">${p.join('')}</div>`;
  const chips = (n, o, c) => o.map(x => `<button class="chip ${c === x.v ? 'on' : ''}" onclick="DFO.setF('${n}','${x.v}')">${esc(x.l)}${x.n !== undefined ? `<span class="cnt">${x.n}</span>` : ''}</button>`).join('');
  const search = ph => `<div class="tb-search">${svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>')}
    <input placeholder="${ph}" oninput="DFO.setF('q',this.value)" value="${(F('q', '') || '').replace(/"/g, '&quot;')}" /></div>`;
  function table(cols, rows, onclick) {
    return `<div class="tbl-wrap"><table><thead><tr>${cols.map(c => `<th class="${c.cls || ''}">${c.l}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r, i) => `<tr ${onclick ? `onclick="${onclick}(${i})"` : ''} class="${S.selIdx === i ? 'sel' : ''}">
        ${r.map((cell, j) => `<td class="${cols[j].cls || ''}">${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  // ── Status-derivatie (v1 `_studentStatus`-pattern) ────────────────────
  const STUDST = {
    'op schema': { l: 'Op schema',       c: 'ok' },
    'aandacht':  { l: 'Vraagt aandacht', c: 'warn' },
    'nieuw':     { l: 'Nieuw',           c: 'accent' },
  };
  function _derivedStatus(s, overdueByEmail, plannedByStudent, noshowByStudent) {
    if (!s) return 'op schema';
    const email = (s.email || '').toLowerCase();
    if (email && overdueByEmail && overdueByEmail[email] > 0) return 'aandacht';
    const id = s.bubble_student_id;
    if (id && noshowByStudent && noshowByStudent.get(id)) {
      const ts = new Date(noshowByStudent.get(id)).getTime();
      if (Number.isFinite(ts) && (Date.now() - ts) < 30 * 24 * 60 * 60 * 1000) return 'aandacht'; // <30d
    }
    if (id && plannedByStudent && !plannedByStudent.get(id) && Number(s.calls_1on1_done || 0) > 0) return 'aandacht';
    // "Nieuw": nog geen calls gedaan
    if (Number(s.calls_1on1_done || 0) === 0) return 'nieuw';
    return 'op schema';
  }
  function _fmtNextCall(id, plannedByStudent) {
    if (!id || !plannedByStudent) return '—';
    const ts = plannedByStudent.get(id);
    if (!ts) return '—';
    const d = new Date(ts);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const dm = new Date(ts); dm.setHours(0, 0, 0, 0);
    const dayDiff = Math.round((dm.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
    const tm = d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
    if (dayDiff === 0) return 'Vandaag ' + tm;
    if (dayDiff === 1) return 'Morgen ' + tm;
    return d.toLocaleDateString('nl-NL', { day: '2-digit', month: '2-digit' }) + ' ' + tm;
  }
  function _voortgang(s) {
    // v1 lijst geeft geen % — heuristiek: calls_done/calls_total ratio.
    const done = Number(s.calls_1on1_done || 0);
    const total = Number(s.calls_1on1_total || 0);
    if (!total) return 0;
    return Math.min(100, Math.round((done / total) * 100));
  }

  // ── Skeleton + error ──────────────────────────────────────────────────
  const skel = () => `<div class="hero"><div class="kpi-grid" style="opacity:.55">${Array.from({length:4}).map(()=>`<div class="kpi kpi-blue"><div class="kpi-top"><span class="kpi-label">Laden…</span></div><div class="kpi-val">—</div></div>`).join('')}</div></div>
    <div style="padding:16px 20px"><div style="height:12px;background:var(--surface-2);border-radius:4px;width:80%;margin-bottom:12px"></div><div style="height:8px;background:var(--surface-2);border-radius:4px;width:60%"></div></div>`;
  const errBlk = (block, msg) => `<div style="margin:20px;padding:14px 18px;border:1px solid var(--rose-line);background:var(--rose-soft);border-radius:var(--r);color:var(--rose);font-size:13px;display:flex;align-items:center;gap:12px">
    <span>${svg(I.alert || I.warn, 'width:16px;height:16px')}</span>
    <span style="flex:1">Kon gegevens niet ophalen: ${esc(msg || 'onbekende fout')}</span>
    <button class="btn btn-ghost btn-sm" onclick="__stuRetry('${block}')">Opnieuw</button></div>`;

  // ── Main view ─────────────────────────────────────────────────────────
  function studentenView() {
    // Trigger fetches — in-flight guards zitten in de fetchers.
    if (!_live.list.data && !_live.list.loading && !_live.list.error) queueMicrotask(fetchList);
    if (!_live.overdue.byEmail && !_live.overdue.loading && !_live.overdue.error) queueMicrotask(fetchOverdue);
    if (!_live.sessions.plannedByStudent && !_live.sessions.loading && !_live.sessions.error) queueMicrotask(fetchSessions);

    if (_live.list.error && !_live.list.data) return errBlk('list', _live.list.error);
    if (_live.list.loading && !_live.list.data) return skel();

    const all = asArr(_live.list.data?.students);
    const overdueByEmail = _live.overdue.byEmail || {};
    const plannedByStudent = _live.sessions.plannedByStudent || new Map();
    const noshowByStudent = _live.sessions.noshowByStudent || new Map();

    // Derived per student
    const decorated = all.map((s) => ({
      raw: s,
      id: s.bubble_student_id,
      naam: s.name || '—',
      email: s.email || '',
      program: s.program || '',
      membership: s.membership || '',
      calls_done: Number(s.calls_1on1_done || 0),
      calls_total: Number(s.calls_1on1_total || 0),
      no_shows: Number(s.no_shows || 0),
      overdue: Number(overdueByEmail[(s.email || '').toLowerCase()] || 0),
      volgende: _fmtNextCall(s.bubble_student_id, plannedByStudent),
      voortgang: _voortgang(s),
      status: _derivedStatus(s, overdueByEmail, plannedByStudent, noshowByStudent),
    })).filter((d) => !d.raw.archived);

    const f = F('sf', 'all');
    const q = (F('q', '') || '').toLowerCase();
    const rows = decorated.filter((d) => (f === 'all' || d.status === f) && (!q || d.naam.toLowerCase().includes(q) || d.email.toLowerCase().includes(q)));
    S.rows = rows;

    const totalStudents = decorated.length;
    const aandacht = decorated.filter((d) => d.status === 'aandacht').length;
    const nieuw = decorated.filter((d) => d.status === 'nieuw').length;
    const gemVoortgang = totalStudents ? Math.round(decorated.reduce((a, d) => a + d.voortgang, 0) / totalStudents) : 0;

    return `${kpis([
      { c: 'teal',    icon: I.users, label: 'Mijn studenten',    val: String(totalStudents),   sub: (rows.length !== totalStudents ? rows.length + ' in dit overzicht' : 'in totaal') },
      { c: 'emerald', icon: I.chart, label: 'Gem. voortgang',    val: gemVoortgang + '%',      hi: 1, sub: 'over alle studenten' },
      { c: 'pink',    icon: I.cal,   label: 'Nieuw / net gestart', val: String(nieuw),         hi: 1, sub: 'geen calls gedaan' },
      { c: 'amber',   icon: I.alert, label: 'Vragen aandacht',   val: String(aandacht),        hi: 1, sub: 'openstaand/no-show/geen call' },
    ])}
    ${_live.overdue.error ? errBlk('overdue', _live.overdue.error) : ''}
    ${_live.sessions.error ? errBlk('sessions', _live.sessions.error) : ''}
    ${toolbar([
      chips('sf', [
        { l: 'Alle studenten', v: 'all', n: totalStudents },
        { l: 'Op schema',      v: 'op schema' },
        { l: 'Aandacht',       v: 'aandacht' },
        { l: 'Nieuw',          v: 'nieuw' },
      ], f),
      search('Zoek student…'),
    ])}
    ${rows.length === 0
      ? `<div class="empty" style="padding:44px 20px"><div class="empty-t">Geen studenten</div><div class="empty-s">${totalStudents === 0 ? 'Je hebt nog geen studenten gekoppeld. Kantoor koppelt studenten via de admin-view.' : 'Geen studenten voldoen aan deze filter.'}</div></div>`
      : table(
          [{ l: 'Student' }, { l: 'Programma', cls: 'optional' }, { l: 'Voortgang' }, { l: 'Sessies', cls: 'r optional' }, { l: 'No-shows', cls: 'r optional' }, { l: 'Volgende call' }, { l: 'Status' }],
          rows.map((d) => [
            `<div class="row-avatar">${av(d.naam, 30)}<span class="cell-main">${esc(d.naam)}</span>${d.overdue > 0 ? ` <span class="pill pill-danger" style="margin-left:6px;font-size:10px">€ ${d.overdue}</span>` : ''}</div>`,
            `<span style="color:var(--text-2);font-size:12.5px">${esc(d.program)}${d.membership ? ' · ' + esc(d.membership) : ''}</span>`,
            `<div style="min-width:120px">
              <div style="display:flex;justify-content:space-between;font-size:11.5px;margin-bottom:3px"><span class="mono">${d.voortgang}%</span></div>
              <div class="progress" style="max-width:130px"><i style="width:${d.voortgang}%;background:var(--${d.voortgang >= 60 ? 'emerald' : d.voortgang >= 35 ? 'amber' : 'rose'})"></i></div>
            </div>`,
            `<span class="mono">${d.calls_done}${d.calls_total ? '/' + d.calls_total : ''}</span>`,
            `<span class="mono ${d.no_shows > 0 ? 'color:var(--rose)' : ''}">${d.no_shows}</span>`,
            `<span style="${d.volgende === '—' ? 'color:var(--text-3)' : d.volgende.startsWith('Vandaag') ? 'color:var(--amber);font-weight:600' : 'color:var(--text-2)'}">${esc(d.volgende)}</span>`,
            pill(STUDST[d.status].c, STUDST[d.status].l),
          ]),
          'openStudent'
        )}`;
  }

  // ── Detail-panel ──────────────────────────────────────────────────────
  let _panelStudentId = null;
  window.openStudent = function openStudent(i) {
    const d = (S.rows || [])[i];
    if (!d || !d.id) return;
    S.selIdx = i;
    _panelStudentId = d.id;
    // Trigger detail-fetch (lazy) — panel toont skeleton tot resolve.
    queueMicrotask(() => fetchDetail(d.id));
    _renderPanel();
  };

  function _renderPanel() {
    const idx = S.selIdx;
    const d = (S.rows || [])[idx];
    if (!d) return;
    const entry = _live.detail.get(d.id);
    const detail = entry?.data || null;
    const loading = !!(entry?.loading);
    const err = entry?.error;

    openPanel(
      d.naam,
      `${esc(d.program || '—')}${d.membership ? ' · ' + esc(d.membership) : ''} · ${d.calls_done} calls gehad`,
      `<div class="hero-amount" style="text-align:left">
        <div class="lbl">Voortgang</div>
        <div style="display:flex;align-items:center;gap:14px;margin-top:4px">
          <div class="big-amount" style="color:var(--${d.voortgang >= 60 ? 'emerald' : d.voortgang >= 35 ? 'amber' : 'rose'})">${d.voortgang}%</div>
          <div style="flex:1">
            <div class="progress" style="height:9px"><i style="width:${d.voortgang}%;background:var(--${d.voortgang >= 60 ? 'emerald' : d.voortgang >= 35 ? 'amber' : 'rose'})"></i></div>
            <div style="margin-top:8px">${pill(STUDST[d.status].c, STUDST[d.status].l)}</div>
          </div>
        </div>
      </div>
      ${d.overdue > 0 ? `<div class="sect" style="background:var(--rose-soft);border:1px solid var(--rose-line);border-radius:var(--r);padding:11px 14px;color:var(--rose);font-size:12.5px;margin:14px 0">
        <b>Te late facturen:</b> ${d.overdue} openstaand — check Finance voor detail.</div>` : ''}
      ${loading ? '<div class="sect"><div class="sect-title">Detail</div><div style="color:var(--text-3);font-size:12.5px">Laden…</div></div>'
        : err ? `<div class="sect"><div class="sect-title">Detail</div><div style="color:var(--rose);font-size:12.5px">Kon detail niet ophalen: ${esc(err)}</div></div>`
        : detail ? _detailBody(detail, d) : ''}
      <div class="sect">
        <div class="sect-title">Contact</div>
        <div class="kv"><dt>E-mail</dt><dd>${esc(detail?.contact?.email || d.email || '—')}</dd></div>
        <div class="kv"><dt>Telefoon</dt><dd class="num">${esc(detail?.contact?.phone || '—')}</dd></div>
      </div>`,
      `<button class="btn btn-ghost" style="flex:1;justify-content:center" onclick="window.open('/modules/mentor-students.html', '_blank')">${svg(I.doc || I.cal)}Openen in v1</button>`
    );
  }
  function _detailBody(detail, d) {
    const sessions = asArr(detail.sessions);
    const tasks = asArr(detail.tasks);
    const progressPct = detail.progress != null ? Number(detail.progress) : d.voortgang;
    return `<div class="sect">
        <div class="sect-title">Sessies (laatste ${Math.min(sessions.length, 5)})</div>
        ${sessions.length === 0 ? '<div style="color:var(--text-3);font-size:12.5px">Nog geen sessies.</div>' : sessions.slice(-5).reverse().map((s) => {
          const dt = s.date ? new Date(s.date).toLocaleDateString('nl-NL', { day: '2-digit', month: 'short' }) : '—';
          const st = s.no_show ? pill('danger', 'No-show') : s.is_done ? pill('ok', 'Voltooid') : pill('warn', 'Gepland');
          return `<div class="cl-row" style="padding:6px 0;display:flex;gap:8px;align-items:center">
            <span style="font-size:12px;color:var(--text-2);width:64px" class="num">${dt}</span>
            <span style="flex:1;font-size:12.5px">${esc(s.agenda || s.stage || '—')}</span>
            ${st}
          </div>`;
        }).join('')}
      </div>
      <div class="sect">
        <div class="sect-title">Taken (${tasks.length})</div>
        ${tasks.length === 0 ? '<div style="color:var(--text-3);font-size:12.5px">Geen taken.</div>' : tasks.slice(0, 5).map((t) => {
          const p = Number(t.progress || 0);
          return `<div class="cl-row" style="padding:6px 0">
            <div style="flex:1">
              <div class="cell-main" style="font-size:12.5px">${esc(t.type_of_task || 'Taak')}</div>
              <div class="progress" style="max-width:200px;margin-top:5px"><i style="width:${p}%"></i></div>
            </div>
            <span class="mono" style="font-size:12px">${p}%</span>
          </div>`;
        }).join('')}
      </div>
      <div class="sect">
        <div class="sect-title">Voortgang totaal</div>
        <div class="kv"><dt>Overall</dt><dd class="num">${progressPct}%</dd></div>
      </div>`;
  }

  // ── Registratie ───────────────────────────────────────────────────────
  window.DFO.VIEWS['studenten/'] = studentenView;
  if (typeof window.KV_V2_ADD === 'function') {
    window.KV_V2_ADD('studenten');
  } else {
    (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('studenten');
  }

  console.debug('[studenten-v2] data-ronde geregistreerd — dormant tot allowlist of ?v2preview=studenten');
})();
