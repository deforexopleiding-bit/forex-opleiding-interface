// modules/klanten-v2/views/onboarding-v2.js
//
// V2 Onboarding — data-ronde. 1-op-1 v1-parity (bron shared/onboarding-
// overzicht.js), v2-design (H.table + stableSearch + fail-soft 8s timeout).
//
// Views geregistreerd:
//   'onboarding/Actief'   — scope=active
//   'onboarding/Inbox'    — placeholder (skip in deze ronde, blijft dormant)
//   'onboarding/Archief'  — scope=archived
//
// Endpoints:
//   GET /api/onboardings-admin-list?scope=active|archived&mentor_user_id&traject_id&q
//   GET /api/onboarding-trajecten-list
//   GET /api/mentor-admin-list
// (Detail + acties in views/modals/onboarding-detail.js — dynamic import bij klik)
//
// Aanmaak: GEEN create-modal — onboardings worden aangemaakt via offerte-
// detail (F0.2-flow). Deze module is puur observatie + operationele acties.
//
// Dormant (?v2preview=onboarding). Protected-zone leeg.

(function () {
  if (!window.DFO) { console.error('[onb-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[onb-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, F } = window.DFO;
  const H = window.KV_V2.helpers;

  const asArr = (x) => Array.isArray(x) ? x : [];
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // ── State per scope ────────────────────────────────────────────────────
  const _live = {
    active:   { loading: false, error: null, rows: null, seq: 0, params: '' },
    archived: { loading: false, error: null, rows: null, seq: 0, params: '' },
  };
  let _trajecten = null;   // cache voor filter-dropdown
  let _mentors   = null;   // cache voor filter-dropdown

  // Row-cache voor H.table 3e-arg-onclick (index → row → id).
  const _rowsForClick = { active: [], archived: [] };
  window.__onbRowClickActive   = (i) => { const r = _rowsForClick.active[i];   if (r && r.id) window.__onbOpen(r.id); };
  window.__onbRowClickArchived = (i) => { const r = _rowsForClick.archived[i]; if (r && r.id) window.__onbOpen(r.id); };

  window.__onbOpen = async (id) => {
    try {
      const mod = await import('./modals/onboarding-detail.js');
      mod.openOnboardingDetailModal({ onboardingId: id, onSuccess: refetchAll });
    } catch (e) { console.error('[onb-v2] detail-modal load fail:', e); window.KV?.toast?.('Kon detail niet laden'); }
  };

  // ── Fetch met 8s timeout + sequence-guard ──────────────────────────────
  async function tryFetch(label, url, timeoutMs = 8000) {
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      return await Promise.race([
        window.KV.authedJson(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) { console.warn('[onb-v2] ' + label + ' fail:', e?.message); return null; }
  }

  function paramsFor(scope) {
    // Filters uit F() (persistent-state per module/tab).
    const q = String((H.getSearchValue && H.getSearchValue('onb:' + scope)) || '').trim();
    const mentor = F('onb-mentor', '');
    const traj   = F('onb-traject', '');
    const parts = ['scope=' + scope];
    if (q)      parts.push('q=' + encodeURIComponent(q));
    if (mentor) parts.push('mentor_user_id=' + encodeURIComponent(mentor));
    if (traj)   parts.push('traject_id=' + encodeURIComponent(traj));
    return parts.join('&');
  }

  async function fetchScope(scope) {
    const st = _live[scope];
    const params = paramsFor(scope);
    if (st.loading && st.params === params) return;
    const seq = ++st.seq;
    st.loading = true; st.error = null; st.params = params;
    const data = await tryFetch('onb:' + scope, '/api/onboardings-admin-list?' + params);
    if (seq !== st.seq) return;
    st.rows = asArr(data && data.rows);
    st.error = data ? null : 'Kon onboardings niet laden';
    st.loading = false;
    if (window.DFO?.render) window.DFO.render();
  }
  function refetchAll() {
    _live.active.rows = null; _live.active.params = '';
    _live.archived.rows = null; _live.archived.params = '';
    fetchScope('active'); fetchScope('archived');
  }

  async function loadTrajecten() {
    if (_trajecten) return _trajecten;
    const j = await tryFetch('trajecten', '/api/onboarding-trajecten-list');
    _trajecten = asArr(j?.trajecten);
    if (window.DFO?.render) window.DFO.render();
    return _trajecten;
  }
  async function loadMentors() {
    if (_mentors) return _mentors;
    const j = await tryFetch('mentors', '/api/mentor-admin-list');
    _mentors = asArr(j?.mentors);
    if (window.DFO?.render) window.DFO.render();
    return _mentors;
  }

  // ── Search wire (stableSearch) ─────────────────────────────────────────
  const _wired = new Set();
  function wireSearch(scope) {
    const key = 'onb:' + scope;
    if (_wired.has(key)) return;
    if (H.onSearch) {
      H.onSearch(key, () => {
        // Invalidate cache voor die scope → refetch met nieuwe q.
        _live[scope].params = ''; fetchScope(scope);
      });
      _wired.add(key);
    }
  }

  // ── Filter-toolbar ─────────────────────────────────────────────────────
  function toolbar(scope) {
    const trajOpts = ['<option value="">Alle trajecten</option>']
      .concat(asArr(_trajecten).map((t) => `<option value="${esc(t.id)}" ${F('onb-traject', '') === t.id ? 'selected' : ''}>${esc(t.label || t.key || t.id.slice(0, 8))}</option>`))
      .join('');
    const mentorOpts = ['<option value="">Alle mentoren</option>', `<option value="__none" ${F('onb-mentor', '') === '__none' ? 'selected' : ''}>— Zonder mentor —</option>`]
      .concat(asArr(_mentors).map((m) => `<option value="${esc(m.user_id)}" ${F('onb-mentor', '') === m.user_id ? 'selected' : ''}>${esc(m.name || m.email || m.user_id.slice(0, 8))}</option>`))
      .join('');
    const searchHtml = H.stableSearch
      ? H.stableSearch('onb:' + scope, 'Zoek klant…')
      : H.search('Zoek klant…');
    return H.toolbar([
      `<select class="filter-sel" onchange="DFO.setF('onb-traject', this.value); window.__onbRefetch();">${trajOpts}</select>`,
      `<select class="filter-sel" onchange="DFO.setF('onb-mentor', this.value); window.__onbRefetch();">${mentorOpts}</select>`,
      searchHtml,
    ]);
  }
  window.__onbRefetch = () => { refetchAll(); };

  // ── KPI-strip ──────────────────────────────────────────────────────────
  function kpisActive(rows) {
    const list = asArr(rows);
    const noMentor = list.filter((r) => !r.mentor_user_id).length;
    const started  = list.filter((r) => r.status === 'bezig').length;
    const today    = list.filter((r) => r.start_date && new Date(r.start_date).toDateString() === new Date().toDateString()).length;
    return H.kpis([
      { c: 'blue',    icon: I.check2, label: 'Actieve onboardings', val: String(list.length), hi: 1 },
      { c: 'amber',   icon: I.alert,  label: 'Zonder mentor',       val: String(noMentor),                    sub: 'nog toe te wijzen' },
      { c: 'emerald', icon: I.tick,   label: 'Bezig',               val: String(started),                     sub: 'wizard gestart' },
      { c: 'violet',  icon: I.clock,  label: 'Start vandaag',       val: String(today) },
    ]);
  }
  function kpisArchive(rows) {
    const list = asArr(rows);
    const done = list.filter((r) => r.status === 'afgerond').length;
    const cancelled = list.filter((r) => r.status === 'geannuleerd').length;
    return H.kpis([
      { c: 'slate',   icon: I.folder || I.doc, label: 'Archief totaal', val: String(list.length), hi: 1 },
      { c: 'emerald', icon: I.tick,            label: 'Afgerond',       val: String(done) },
      { c: 'rose',    icon: I.x,               label: 'Geannuleerd',    val: String(cancelled) },
    ]);
  }

  // ── Table ──────────────────────────────────────────────────────────────
  const STATUS_PILL = {
    aangemeld:    ['info',    'Aangemeld'],
    bezig:        ['warn',    'Bezig'],
    afgerond:     ['ok',      'Afgerond'],
    gearchiveerd: ['neutral', 'Gearchiveerd'],
    geannuleerd: ['danger',  'Geannuleerd'],
  };
  const statusPill = (s) => { const [c, l] = STATUS_PILL[s] || ['neutral', s || '—']; return H.pill(c, l); };
  const paidPill   = (b) => H.pill(b ? 'ok' : 'warn', b ? 'Betaald' : 'Open');

  function onbTable(rows, handlerName) {
    const list = asArr(rows);
    if (!list.length) return `<div class="empty"><div class="empty-t">Geen onboardings</div><div class="empty-s">Er zijn geen onboardings die aan de filters voldoen.</div></div>`;
    return H.table(
      [
        { l: 'Klant' },
        { l: 'Traject', cls: 'optional' },
        { l: 'Status' },
        { l: 'Mentor', cls: 'optional' },
        { l: 'Startdatum', cls: 'optional' },
        { l: 'Betaling', cls: 'optional' },
        { l: 'Aangemeld', cls: 'optional r' },
      ],
      list.map((r) => [
        `<span class="kv-onb-title">${esc(r.customer_name) || '—'}</span>`,
        `<span style="color:var(--text-2);font-size:12.5px">${esc(r.traject_label) || '—'}</span>`,
        statusPill(r.status),
        `<span style="font-size:12.5px">${esc(r.mentor_name) || (r.mentor_user_id ? '#' + String(r.mentor_user_id).slice(0, 6) : '—')}</span>`,
        `<span class="mono" style="color:var(--text-3);font-size:12.5px">${r.start_date ? new Date(r.start_date).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }) : '—'}</span>`,
        paidPill(!!r.paid),
        `<span class="mono" style="color:var(--text-3);font-size:12px">${r.created_at ? new Date(r.created_at).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }) : '—'}</span>`,
      ]),
      handlerName
    );
  }

  // ── Views ──────────────────────────────────────────────────────────────
  const skel = (n = 5) => `<div class="tbl-wrap"><table><thead><tr><th>Klant</th><th>Traject</th><th>Status</th><th>Mentor</th><th>Start</th><th>Betaling</th><th>Aangemeld</th></tr></thead>
    <tbody>${Array.from({ length: n }).map(() => `<tr style="opacity:.55">${Array.from({ length: 7 }).map(() => `<td><div style="height:12px;background:var(--surface-2);border-radius:4px;width:${60 + Math.floor(Math.random() * 30)}%"></div></td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  const errBlk = (m) => `<div style="margin:20px;padding:14px 18px;border:1px solid var(--rose-line);background:var(--rose-soft);border-radius:var(--r);color:var(--rose);font-size:13px">⚠ Kon onboardings niet ophalen: ${esc(m)}</div>`;

  function actiefView() {
    wireSearch('active');
    if (!_trajecten) queueMicrotask(loadTrajecten);
    if (!_mentors)   queueMicrotask(loadMentors);
    const st = _live.active;
    if (!st.rows && !st.loading) queueMicrotask(() => fetchScope('active'));
    const rows = asArr(st.rows);
    _rowsForClick.active = rows;
    return `
      ${kpisActive(rows)}
      ${toolbar('active')}
      ${st.error ? errBlk(st.error)
        : (st.loading && !st.rows) ? skel(6)
        : onbTable(rows, '__onbRowClickActive')}`;
  }
  function archiefView() {
    wireSearch('archived');
    if (!_trajecten) queueMicrotask(loadTrajecten);
    if (!_mentors)   queueMicrotask(loadMentors);
    const st = _live.archived;
    if (!st.rows && !st.loading) queueMicrotask(() => fetchScope('archived'));
    const rows = asArr(st.rows);
    _rowsForClick.archived = rows;
    return `
      ${kpisArchive(rows)}
      ${toolbar('archived')}
      ${st.error ? errBlk(st.error)
        : (st.loading && !st.rows) ? skel(4)
        : onbTable(rows, '__onbRowClickArchived')}`;
  }
  function inboxPlaceholder() {
    return `<div class="empty" style="padding:60px 20px;">
      <div class="empty-ico">${svg(I.mail || I.doc)}</div>
      <div class="empty-t">Inbox komt later</div>
      <div class="empty-s">De WhatsApp-inbox voor Onboarding zit nog in de v1-hub. Gebruik <a href="/modules/onboarding-hub.html#inbox" style="color:var(--m); text-decoration:underline;">de oude hub</a> voor inbox-berichten. Alle andere Onboarding-features werken al in v2.</div>
    </div>`;
  }

  // ── Registratie ────────────────────────────────────────────────────────
  window.DFO.VIEWS['onboarding/Actief']  = actiefView;
  window.DFO.VIEWS['onboarding/Archief'] = archiefView;
  window.DFO.VIEWS['onboarding/Inbox']   = inboxPlaceholder;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('onboarding');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('onboarding');

  console.debug('[onb-v2] registered VIEWS[Actief / Inbox-placeholder / Archief] + detail dynamic-import');
})();
