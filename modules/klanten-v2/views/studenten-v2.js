// modules/klanten-v2/views/studenten-v2.js
//
// Studenten (mentor-first) v2 — BROK 1 (v=2, 2026-08-18): reads live.
// Alle voorbeeld-data + hardcoded 8-studenten-mock vervangen door echte
// endpoints. Geen writes; notities zijn read-only.
//
// Endpoints:
//   GET  /api/mentor-my-students                      (Bubble-proxy)
//        ?mentor_user_id=<uuid>  → admin-override
//   GET  /api/mentor-students-invoice-status          (invoices via customer-email)
//   GET  /api/mentor-1on1-sessions                    (per-mentor 1-op-1 sessies)
//   GET  /api/mentor-assessments-self                 (read-only bestaande notitie)
//
// LMS-deep-link: Bubble-app-root is https://dashboard.deforexopleiding.nl.
// Exacte student-detail-URL is code-side niet vindbaar (BUBBLE_API_ROOT
// geeft alleen de /api/1.1/obj-basis, niet het app-page-patroon). We linken
// naar de LMS-root + tonen de student-email in de tooltip; kan later via
// env-var opgeplust worden zodra Dave/Jeffrey het pattern aanreikt.
//
// Dormant — 'studenten' NIET in V2_ACTIVE_ALLOWLIST. Preview via
// ?v2preview=studenten (rol mentor). Admin test: ?v2preview=studenten
// + open Chrome-console + window.__stMentorOverride='<uuid>' + refetch.

(function () {
  if (!window.DFO) { console.error('[studenten-v2] DFO shell niet geladen.'); return; }
  const { I, svg, S, openPanel } = window.DFO;
  const asArr = (x) => Array.isArray(x) ? x : [];
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // Bubble LMS-root; geen deep-link-patroon bekend → root openen.
  const LMS_ROOT_URL = 'https://dashboard.deforexopleiding.nl/';

  /* ── State ──────────────────────────────────────────────────────────── */
  const _live = {
    students:  { loading: false, error: null, data: null, _seq: 0, key: '', linked: true, scope: null },
    invoices:  { loading: false, error: null, byEmail: null, _seq: 0 },
    sessions:  { loading: false, error: null, data: null, _seq: 0 },
    notes:     { loading: false, error: null, byId: null, _seq: 0 },
  };
  const _ui = {
    statusFilter: 'all',       // 'all' | 'op_schema' | 'aandacht' | 'nieuw'
    searchQ:      '',          // state-only tijdens typen (focus-behoud)
    _searchTimer: null,
    selectedId:   null,        // bubble_student_id
    detailTab:    'Overzicht', // 'Overzicht' | 'Sessies' | 'Facturen' | 'Notities'
  };

  /* ── Helpers ──────────────────────────────────────────────────────── */
  async function tryFetch(label, url, timeoutMs) {
    timeoutMs = timeoutMs || 8000;
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      return await Promise.race([
        window.KV.authedJson(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) {
      console.warn('[studenten-v2] ' + label + ' fail:', e?.message);
      return null;
    }
  }
  function _mentorOverrideParam() {
    const v = String(window.__stMentorOverride || '').trim();
    return v ? '&mentor_user_id=' + encodeURIComponent(v) : '';
  }
  function _initials(name) {
    return String(name || '?').trim().split(/\s+/).map((w) => w[0] || '').slice(0, 2).join('').toUpperCase() || '?';
  }
  function _avatarColor(name) {
    // Simpele hash → HSL, consistent per naam.
    let h = 0; const s = String(name || '');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffffffff;
    return `hsl(${Math.abs(h) % 360},60%,45%)`;
  }
  function _av(name, size) {
    size = size || 30;
    return `<span class="avatar" style="width:${size}px;height:${size}px;background:${_avatarColor(name)};font-size:${Math.round(size * 0.38)}px;color:#fff;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;font-weight:600">${esc(_initials(name))}</span>`;
  }
  // Categoriseert een student in de UI-status op basis van signalen.
  // 'aandacht' = no_shows > 0 OF onbetaalde-facturen; 'nieuw' = onboarding
  // in pre-active-fase; anders 'op_schema'.
  function _categorize(s, invoiceStatus) {
    const os = String(s.onboarding_status || '').toLowerCase();
    if (os.includes('nieuw') || os.includes('intake') || os.includes('aangemeld')) return 'nieuw';
    const noShows = Number(s.no_shows || 0);
    const inv = invoiceStatus && s.email ? invoiceStatus[String(s.email).toLowerCase()] : null;
    const overdue = inv && Number(inv.overdue || 0) > 0;
    if (noShows > 0 || overdue) return 'aandacht';
    return 'op_schema';
  }
  function _sessieKleur(done, total) {
    if (!total) return 'text-3';
    const pct = done / total;
    if (pct >= 0.9) return 'emerald';
    if (pct >= 0.5) return 'amber';
    return 'rose';
  }

  /* ── Fetchers ──────────────────────────────────────────────────────── */
  async function _fetchStudents() {
    const st = _live.students;
    const key = _mentorOverrideParam() || 'self';
    if (st.loading && st.key === key) return;
    st.loading = true; st.error = null; st.key = key;
    const seq = ++st._seq;
    if (window.DFO?.render) window.DFO.render();
    const url = '/api/mentor-my-students?_=1' + _mentorOverrideParam();
    const j = await tryFetch('students', url);
    if (seq !== st._seq) return;
    st.loading = false;
    if (!j) { st.error = 'Kon studenten niet laden'; if (window.DFO?.render) window.DFO.render(); return; }
    if (j.error) { st.error = j.error; if (window.DFO?.render) window.DFO.render(); return; }
    st.data   = asArr(j.students);
    st.linked = j.linked !== false;
    st.scope  = j.scope || null;
    // Trigger secondary fetches parallel.
    queueMicrotask(_fetchInvoiceStatus);
    queueMicrotask(_fetchAssessments);
    if (window.DFO?.render) window.DFO.render();
  }
  async function _fetchInvoiceStatus() {
    const st = _live.invoices;
    if (st.loading || st.byEmail) return;
    st.loading = true; st.error = null;
    const seq = ++st._seq;
    const j = await tryFetch('inv-status', '/api/mentor-students-invoice-status?_=1' + _mentorOverrideParam());
    if (seq !== st._seq) return;
    st.loading = false;
    if (!j) { st.error = 'Kon betaalstatus niet laden'; if (window.DFO?.render) window.DFO.render(); return; }
    // Server geeft doorgaans { items: [{email, open, overdue, paid, ...}] }
    // of { statuses: {...} }. Beide vormen accepteren.
    const map = {};
    const items = asArr(j.items || j.statuses || j.students);
    for (const it of items) {
      const email = String(it.email || '').toLowerCase();
      if (!email) continue;
      map[email] = {
        open:    Number(it.open    || it.open_count    || 0),
        overdue: Number(it.overdue || it.overdue_count || 0),
        paid:    Number(it.paid    || it.paid_count    || 0),
        open_amount:    Number(it.open_amount    || 0),
        overdue_amount: Number(it.overdue_amount || 0),
      };
    }
    st.byEmail = map;
    if (window.DFO?.render) window.DFO.render();
  }
  async function _fetchAssessments() {
    const st = _live.notes;
    if (st.loading || st.byId) return;
    st.loading = true; st.error = null;
    const seq = ++st._seq;
    const j = await tryFetch('assessments', '/api/mentor-assessments-self?_=1' + _mentorOverrideParam());
    if (seq !== st._seq) return;
    st.loading = false;
    if (!j) { st.error = 'Kon notities niet laden'; return; }
    const map = {};
    const items = asArr(j.items || j.assessments);
    for (const a of items) {
      const sid = a.student_id || a.bubble_student_id || a.id;
      if (!sid) continue;
      map[String(sid)] = a;
    }
    st.byId = map;
    // Geen render nodig — notities tonen alleen in het detail-panel.
  }
  async function _fetchSessions() {
    const st = _live.sessions;
    if (st.loading || st.data) return;
    st.loading = true; st.error = null;
    const seq = ++st._seq;
    const j = await tryFetch('sessions', '/api/mentor-1on1-sessions?_=1' + _mentorOverrideParam());
    if (seq !== st._seq) return;
    st.loading = false;
    if (!j) { st.error = 'Kon sessies niet laden'; if (_ui.selectedId) _repaintDetailPane(); return; }
    st.data = asArr(j.sessions || j.items);
    if (_ui.selectedId) _repaintDetailPane();
  }

  /* ── Handlers ──────────────────────────────────────────────────────── */
  window.__stRetry = (what) => {
    if (what === 'students') { _live.students.data = null; _live.students.key = ''; _fetchStudents(); }
    if (what === 'invoices') { _live.invoices.byEmail = null; _fetchInvoiceStatus(); }
    if (what === 'sessions') { _live.sessions.data = null; _fetchSessions(); }
    if (what === 'notes')    { _live.notes.byId = null; _fetchAssessments(); }
  };
  window.__stSetStatus = (val) => {
    if (!['all', 'op_schema', 'aandacht', 'nieuw'].includes(val)) return;
    _ui.statusFilter = val;
    _repaintListBody();
  };
  // Uncontrolled input: oninput = state-only (focus behouden). Debounce
  // 250ms, dan surgical list-repaint (geen full DFO.render).
  window.__stSearchInput = (val) => {
    const v = String(val || '');
    _ui.searchQ = v;
    const clr = document.getElementById('stSearchClear');
    if (clr) clr.style.visibility = v.trim() ? 'visible' : 'hidden';
    if (_ui._searchTimer) { clearTimeout(_ui._searchTimer); _ui._searchTimer = null; }
    _ui._searchTimer = setTimeout(_repaintListBody, 250);
  };
  window.__stSearchClear = () => {
    _ui.searchQ = '';
    const inp = document.getElementById('stSearchInput');
    if (inp) { inp.value = ''; inp.focus(); }
    const clr = document.getElementById('stSearchClear');
    if (clr) clr.style.visibility = 'hidden';
    _repaintListBody();
  };
  window.__stSelectStudent = (id) => {
    if (String(_ui.selectedId) === String(id)) return;
    _ui.selectedId = String(id);
    _ui.detailTab = 'Overzicht';
    // Highlight-swap surgical.
    document.querySelectorAll('#stStudentsList .st-row.on').forEach((el) => el.classList.remove('on'));
    const newRow = document.querySelector('#stStudentsList .st-row[data-id="' + String(id).replace(/"/g, '\\"') + '"]');
    if (newRow) newRow.classList.add('on');
    _repaintDetailPane();
  };
  window.__stSetDetailTab = (tab) => {
    if (!['Overzicht', 'Sessies', 'Facturen', 'Notities'].includes(tab)) return;
    _ui.detailTab = tab;
    if (tab === 'Sessies' && !_live.sessions.data && !_live.sessions.loading) queueMicrotask(_fetchSessions);
    _repaintDetailPane();
  };
  window.__stOpenLms = (email) => {
    // Deep-link: LMS-root openen; email in query voor context (bubble
    // admin-search accepteert dit). Als het exacte user-detail-URL-patroon
    // beschikbaar komt via env, kan dit hier opgeplust worden.
    const url = LMS_ROOT_URL + (email ? '?email=' + encodeURIComponent(email) : '');
    try { window.open(url, '_blank', 'noopener'); } catch (_) {}
  };

  /* ── Filter + surgical repaint ─────────────────────────────────────── */
  function _filteredStudents() {
    const rows = asArr(_live.students.data);
    const q = String(_ui.searchQ || '').trim().toLowerCase();
    const inv = _live.invoices.byEmail;
    return rows.filter((s) => {
      if (_ui.statusFilter !== 'all' && _categorize(s, inv) !== _ui.statusFilter) return false;
      if (q) {
        const hay = ((s.name || '') + ' ' + (s.email || '') + ' ' + (s.program || '')).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }
  function _repaintListBody() {
    const body = document.getElementById('stStudentsList');
    if (!body) return;
    const rows = _filteredStudents();
    const inv = _live.invoices.byEmail;
    if (!rows.length) {
      body.innerHTML = `<div style="padding:44px 20px;text-align:center;color:var(--text-3);font-size:13px">${String(_ui.searchQ || '').trim() || _ui.statusFilter !== 'all' ? 'Geen studenten die aan de filters voldoen.' : 'Geen studenten gekoppeld.'}</div>`;
      const counter = document.getElementById('stListCount');
      if (counter) counter.textContent = '0 studenten';
      return;
    }
    body.innerHTML = rows.map((s) => _renderStudentRow(s, inv)).join('');
    const counter = document.getElementById('stListCount');
    if (counter) counter.textContent = rows.length + ' student' + (rows.length === 1 ? '' : 'en');
    // Bij verlies van selectie in de nieuwe filter: reset selectedId + detail.
    if (_ui.selectedId && !rows.some((r) => String(r.bubble_student_id || r.id) === String(_ui.selectedId))) {
      _ui.selectedId = null;
      _repaintDetailPane();
    }
  }
  function _repaintDetailPane() {
    const pane = document.getElementById('stDetailPane');
    if (!pane) return;
    const rows = asArr(_live.students.data);
    const s = _ui.selectedId ? rows.find((x) => String(x.bubble_student_id || x.id) === String(_ui.selectedId)) : null;
    if (!s) { pane.innerHTML = `<div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-3);font-size:13px">Selecteer een student</div>`; return; }
    pane.innerHTML = _renderDetail(s);
  }

  /* ── KPI-berekening ────────────────────────────────────────────────── */
  function _computeKpis(rows, inv) {
    const total = rows.length;
    let opSchema = 0, aandacht = 0, nieuw = 0, noShowsTotal = 0, overdueClients = 0;
    for (const s of rows) {
      const cat = _categorize(s, inv);
      if (cat === 'op_schema') opSchema++;
      else if (cat === 'aandacht') aandacht++;
      else if (cat === 'nieuw') nieuw++;
      noShowsTotal += Number(s.no_shows || 0);
      const iv = inv && s.email ? inv[String(s.email).toLowerCase()] : null;
      if (iv && Number(iv.overdue || 0) > 0) overdueClients++;
    }
    return { total, opSchema, aandacht, nieuw, noShowsTotal, overdueClients };
  }

  /* ── Skeletons ────────────────────────────────────────────────────── */
  function _skelKpis() {
    return `<div class="hero"><div class="kpi-grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px">
      ${Array.from({ length: 4 }).map(() => `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px 16px;opacity:.55">
        <div style="height:10px;width:60%;background:var(--surface-2);border-radius:4px;margin-bottom:8px"></div>
        <div style="height:22px;width:40%;background:var(--surface-2);border-radius:4px"></div>
      </div>`).join('')}
    </div></div>`;
  }
  function _skelRows(n) {
    return Array.from({ length: n }).map(() => `<div style="padding:11px 14px;border-bottom:1px solid var(--border);opacity:.55">
      <div style="height:12px;width:60%;background:var(--surface-2);border-radius:4px;margin-bottom:6px"></div>
      <div style="height:11px;width:85%;background:var(--surface-2);border-radius:4px"></div>
    </div>`).join('');
  }

  /* ── Row-render ────────────────────────────────────────────────────── */
  function _renderStudentRow(s, inv) {
    const id = String(s.bubble_student_id || s.id || '');
    const name = s.name || s.email || 'Onbekend';
    const email = s.email || '';
    const program = s.program || s.membership || '—';
    const oneOnOne = { done: Number(s.calls_1on1_done || 0), total: Number(s.calls_1on1_total || 0) };
    const group    = { done: Number(s.group_done      || 0), total: Number(s.group_total      || 0) };
    const oneCol = _sessieKleur(oneOnOne.done, oneOnOne.total);
    const grpCol = _sessieKleur(group.done, group.total);
    const noShows = Number(s.no_shows || 0);
    const iv = inv && email ? inv[email.toLowerCase()] : null;
    const invBadge = iv
      ? (iv.overdue > 0
          ? `<span style="font-size:9.5px;padding:2px 6px;border-radius:6px;background:var(--rose-soft);color:var(--rose);font-weight:600">${iv.overdue} achterstallig</span>`
          : iv.open > 0
            ? `<span style="font-size:9.5px;padding:2px 6px;border-radius:6px;background:var(--amber-soft);color:var(--amber);font-weight:600">${iv.open} open</span>`
            : `<span style="font-size:9.5px;padding:2px 6px;border-radius:6px;background:var(--emerald-soft);color:var(--emerald);font-weight:600">betaald</span>`)
      : `<span style="font-size:9.5px;padding:2px 6px;border-radius:6px;background:var(--surface-2);color:var(--text-3);font-weight:500">—</span>`;
    const onCls = String(_ui.selectedId) === id ? 'on' : '';
    const idAttr  = id.replace(/"/g, '&quot;');
    const idClick = id.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `<div class="st-row ${onCls}" data-id="${idAttr}" onclick="__stSelectStudent('${idClick}')"
      style="display:flex;gap:10px;padding:11px 14px;border-bottom:1px solid var(--border);cursor:pointer;${onCls ? 'background:var(--surface-2)' : ''}">
      ${_av(name, 34)}
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:2px">
          <span style="font-size:13.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</span>
        </div>
        <div style="font-size:12px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(program)}</div>
        <div style="margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:10.5px">
          <span style="padding:2px 6px;border-radius:6px;background:var(--${oneCol}-soft,var(--surface-2));color:var(--${oneCol},var(--text-3));font-weight:600">1-op-1 ${oneOnOne.done}/${oneOnOne.total || '—'}</span>
          <span style="padding:2px 6px;border-radius:6px;background:var(--${grpCol}-soft,var(--surface-2));color:var(--${grpCol},var(--text-3));font-weight:600">Groep ${group.done}/${group.total || '—'}</span>
          ${noShows > 0 ? `<span style="padding:2px 6px;border-radius:6px;background:var(--rose-soft);color:var(--rose);font-weight:600">${noShows} no-show${noShows === 1 ? '' : 's'}</span>` : ''}
          ${invBadge}
        </div>
      </div>
    </div>`;
  }

  /* ── Detail-pane ───────────────────────────────────────────────────── */
  function _renderDetail(s) {
    const id = String(s.bubble_student_id || s.id || '');
    const name = s.name || s.email || 'Onbekend';
    const email = s.email || '';
    const program = s.program || '—';
    const membership = s.membership || '—';
    const onbStatus = s.onboarding_status || '—';
    const noShows = Number(s.no_shows || 0);
    const oneOnOne = { done: Number(s.calls_1on1_done || 0), total: Number(s.calls_1on1_total || 0) };
    const group    = { done: Number(s.group_done      || 0), total: Number(s.group_total      || 0) };
    const inv = _live.invoices.byEmail && email ? _live.invoices.byEmail[email.toLowerCase()] : null;

    const tabs = ['Overzicht', 'Sessies', 'Facturen', 'Notities'];
    const tabBtns = tabs.map((t) => `<button class="chip ${_ui.detailTab === t ? 'on' : ''}" style="font-size:11.5px;padding:4px 12px" onclick="__stSetDetailTab('${t}')">${esc(t)}</button>`).join('');

    let body = '';
    if (_ui.detailTab === 'Overzicht') {
      body = `<div style="display:flex;flex-direction:column;gap:12px">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px 16px">
          <div style="font-weight:600;font-size:13px;margin-bottom:10px">Program</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:12.5px">
            <div><div style="color:var(--text-3);font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px">Learning type</div><div style="font-weight:500">${esc(program)}</div></div>
            <div><div style="color:var(--text-3);font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px">Membership</div><div style="font-weight:500">${esc(membership)}</div></div>
            <div><div style="color:var(--text-3);font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px">Onboarding-fase</div><div style="font-weight:500">${esc(onbStatus)}</div></div>
            <div><div style="color:var(--text-3);font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px">No-shows</div><div style="font-weight:500;color:var(--${noShows > 0 ? 'rose' : 'text-1'})">${noShows}</div></div>
          </div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px 16px">
          <div style="font-weight:600;font-size:13px;margin-bottom:10px">Sessies-progressie</div>
          ${_progressRow('1-op-1', oneOnOne.done, oneOnOne.total)}
          ${_progressRow('Groepscalls', group.done, group.total)}
        </div>
      </div>`;
    } else if (_ui.detailTab === 'Sessies') {
      const st = _live.sessions;
      if (st.loading && !st.data) body = `<div style="padding:22px;color:var(--text-3);font-size:13px;text-align:center">Sessies laden…</div>`;
      else if (st.error && !st.data) body = `<div style="padding:14px;background:var(--rose-soft);color:var(--rose);border-radius:var(--r-sm);font-size:12.5px">⚠ ${esc(st.error)} <button class="btn btn-ghost btn-sm" onclick="__stRetry('sessions')" style="margin-left:8px">Opnieuw</button></div>`;
      else {
        const all = asArr(st.data);
        // Filter op deze student via email of bubble_student_id.
        const mine = all.filter((sess) => {
          const sEmail = String(sess.student_email || sess.email || '').toLowerCase();
          const sId    = String(sess.bubble_student_id || sess.student_id || '');
          return (email && sEmail === email.toLowerCase()) || (id && sId === id);
        });
        if (!mine.length) body = `<div style="padding:22px;color:var(--text-3);font-size:13px;text-align:center">Geen 1-op-1 sessies gevonden voor deze student.</div>`;
        else body = `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden">
          ${mine.map((se) => {
            const when = se.starts_at || se.scheduled_at || se.date || null;
            const label = when ? new Date(when).toLocaleString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
            const status = se.status || (se.completed ? 'gedaan' : 'gepland');
            return `<div style="padding:10px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;gap:10px;align-items:center;font-size:12.5px"><span>${esc(label)}</span><span style="color:var(--text-3)">${esc(status)}</span></div>`;
          }).join('')}
        </div>`;
      }
    } else if (_ui.detailTab === 'Facturen') {
      if (_live.invoices.loading && !_live.invoices.byEmail) body = `<div style="padding:22px;color:var(--text-3);font-size:13px;text-align:center">Betaalstatus laden…</div>`;
      else if (!inv) body = `<div style="padding:22px;color:var(--text-3);font-size:13px;text-align:center">Geen factuur-data gekoppeld aan ${esc(email || 'deze student')}.</div>`;
      else body = `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px 16px">
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;font-size:12.5px">
          <div><div style="color:var(--text-3);font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px">Betaald</div><div style="font-weight:600;color:var(--emerald)">${inv.paid || 0}</div></div>
          <div><div style="color:var(--text-3);font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px">Open</div><div style="font-weight:600;color:var(--amber)">${inv.open || 0}${inv.open_amount ? ` <span style="font-size:11px;color:var(--text-3);font-weight:400">· €${inv.open_amount.toFixed(2)}</span>` : ''}</div></div>
          <div><div style="color:var(--text-3);font-size:11px;text-transform:uppercase;letter-spacing:.06em;margin-bottom:3px">Achterstallig</div><div style="font-weight:600;color:var(--${inv.overdue > 0 ? 'rose' : 'text-3'})">${inv.overdue || 0}${inv.overdue_amount ? ` <span style="font-size:11px;color:var(--text-3);font-weight:400">· €${inv.overdue_amount.toFixed(2)}</span>` : ''}</div></div>
        </div>
      </div>`;
    } else if (_ui.detailTab === 'Notities') {
      const note = _live.notes.byId ? _live.notes.byId[id] : null;
      if (_live.notes.loading && !_live.notes.byId) body = `<div style="padding:22px;color:var(--text-3);font-size:13px;text-align:center">Notities laden…</div>`;
      else if (!note) body = `<div style="padding:22px;color:var(--text-3);font-size:13px;text-align:center">Geen notitie voor deze student. <div style="font-size:11px;margin-top:6px">Bewerken komt in BROK 2.</div></div>`;
      else body = `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px 16px;font-size:12.5px">
        ${note.status ? `<div style="margin-bottom:8px"><span style="font-size:11px;padding:2px 8px;border-radius:6px;background:var(--surface-2);color:var(--text-2);font-weight:600">${esc(note.status)}</span></div>` : ''}
        <div style="white-space:pre-wrap;line-height:1.55">${esc(note.notes || note.body || note.text || '(leeg)')}</div>
        ${note.updated_at ? `<div style="margin-top:10px;font-size:10.5px;color:var(--text-3)">Laatst bijgewerkt: ${esc(new Date(note.updated_at).toLocaleString('nl-NL'))}</div>` : ''}
        <div style="margin-top:10px;font-size:11px;color:var(--text-3);font-style:italic">Bewerken komt in BROK 2 — deze weergave is read-only.</div>
      </div>`;
    }

    return `<div style="display:flex;flex-direction:column;min-height:0;flex:1;background:var(--surface)">
      <div style="padding:14px 20px;background:var(--surface);border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:13px;margin-bottom:10px">
          ${_av(name, 42)}
          <div style="flex:1;min-width:0">
            <div style="font-size:16px;font-weight:600;letter-spacing:-.02em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</div>
            <div style="font-size:12.5px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(email || '—')}</div>
          </div>
          <button class="btn btn-primary btn-sm" style="background:var(--brand,#0A7490);border-color:var(--brand,#0A7490);color:#fff;font-size:11.5px" onclick="__stOpenLms('${esc(email || '')}')" title="Open student in Bubble LMS (dashboard.deforexopleiding.nl)">Open in LMS →</button>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${tabBtns}</div>
      </div>
      <div style="flex:1;overflow-y:auto;padding:16px 20px;min-height:0">${body}</div>
    </div>`;
  }
  function _progressRow(label, done, total) {
    if (!total) return `<div style="margin-bottom:8px;font-size:12.5px;color:var(--text-3)">${esc(label)}: geen data</div>`;
    const pct = Math.round((done / total) * 100);
    const col = pct >= 90 ? 'emerald' : pct >= 50 ? 'amber' : 'rose';
    return `<div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px"><span>${esc(label)}</span><span class="mono" style="font-family:'IBM Plex Mono',monospace">${done}/${total} · ${pct}%</span></div>
      <div style="height:6px;background:var(--surface-2);border-radius:3px;overflow:hidden"><div style="width:${pct}%;height:100%;background:var(--${col})"></div></div>
    </div>`;
  }

  /* ── View ─────────────────────────────────────────────────────────── */
  function studentenView() {
    // Bootstrap: fetch bij eerste mount.
    if (!_live.students.data && !_live.students.loading && !_live.students.error) {
      queueMicrotask(_fetchStudents);
    }

    // Loading (eerste keer, nog geen data).
    if (_live.students.loading && !_live.students.data) {
      return `<div class="pad" style="padding:14px 20px 0">${_skelKpis()}
        <div style="margin-top:14px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden">${_skelRows(6)}</div>
      </div>`;
    }

    // Error zonder data.
    if (_live.students.error && !_live.students.data) {
      return `<div class="pad" style="padding:14px 20px">
        <div style="padding:14px 16px;background:var(--rose-soft);border:1px solid var(--rose-line, var(--rose));color:var(--rose);border-radius:var(--r);font-size:13px;display:flex;justify-content:space-between;align-items:center;gap:12px">
          <span>⚠ ${esc(_live.students.error)}</span>
          <button class="btn btn-ghost btn-sm" onclick="__stRetry('students')">Opnieuw</button>
        </div>
      </div>`;
    }

    // Nog niet gekoppeld aan Bubble.
    if (_live.students.data && _live.students.linked === false) {
      return `<div class="pad" style="padding:32px 20px">
        <div style="padding:22px 20px;background:var(--amber-soft);border:1px solid var(--amber-line, var(--amber));color:var(--amber);border-radius:var(--r);font-size:13px;line-height:1.55">
          <div style="font-weight:600;margin-bottom:4px">Nog niet gekoppeld aan Bubble</div>
          Er is nog geen <code>bubble_user_id</code> op je mentor-profiel. Vraag een admin om de koppeling te maken (Admin-module → Mentor-koppeling). Zodra dat gedaan is verschijnen je studenten hier automatisch.
        </div>
      </div>`;
    }

    const rows = asArr(_live.students.data);
    const inv = _live.invoices.byEmail;
    const kpis = _computeKpis(rows, inv);
    const scopeBadge = _live.students.scope === 'admin'
      ? `<span style="font-size:10.5px;padding:2px 8px;border-radius:6px;background:var(--violet-soft,#EDE4FA);color:var(--violet,#6D3FD4);font-weight:600;margin-left:8px">ADMIN-VIEW</span>`
      : '';

    const kpi = (label, val, sub, color) => `
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:14px 16px">
        <div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);margin-bottom:6px">${esc(label)}</div>
        <div style="font-size:24px;font-weight:600;letter-spacing:-.02em;color:var(--${color || 'text-1'})">${val == null ? '<span style="opacity:.4">…</span>' : esc(String(val))}</div>
        ${sub ? `<div style="font-size:11.5px;color:var(--text-3);margin-top:4px">${esc(sub)}</div>` : ''}
      </div>`;

    const filterChips = [
      ['all',       'Alle',      rows.length],
      ['op_schema', 'Op schema', kpis.opSchema],
      ['aandacht',  'Aandacht',  kpis.aandacht],
      ['nieuw',     'Nieuw',     kpis.nieuw],
    ].map(([v, l, n]) => `<button class="chip ${_ui.statusFilter === v ? 'on' : ''}" style="font-size:11.5px;padding:3px 10px" onclick="__stSetStatus('${v}')">${esc(l)}<span class="cnt" style="margin-left:5px;opacity:.7">${n}</span></button>`).join('');

    const qVal = String(_ui.searchQ || '');
    const qHas = qVal.trim().length > 0;
    const searchBar = `
      <div style="position:relative;flex:1;min-width:200px;max-width:320px">
        <input id="stSearchInput" type="text" value="${esc(qVal)}"
          oninput="__stSearchInput(this.value)"
          placeholder="Zoek op naam, email of traject…"
          style="width:100%;padding:6px 28px 6px 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);color:var(--text-1);font-size:12px;outline:none;box-sizing:border-box"
          autocomplete="off" spellcheck="false" />
        <button id="stSearchClear" title="Wis zoekterm" onclick="__stSearchClear()"
          style="position:absolute;top:50%;right:6px;transform:translateY(-50%);width:20px;height:20px;padding:0;border:0;background:transparent;color:var(--text-3);font-size:14px;cursor:pointer;visibility:${qHas ? 'visible' : 'hidden'}">×</button>
      </div>`;

    // Filter voor initial render (verder gaat via _repaintListBody).
    const filtered = _filteredStudents();

    return `<div data-studenten-view="1" class="pad" style="padding:14px 20px 0;display:flex;flex-direction:column;height:calc(100vh - 140px);min-height:520px">
      <div style="display:flex;align-items:center;margin-bottom:14px">
        <div style="font-size:12.5px;color:var(--text-3)">${kpis.total} studenten totaal ${scopeBadge}</div>
        ${_live.students.error && _live.students.data ? `<span style="margin-left:auto;font-size:11.5px;color:var(--amber)">⚠ ${esc(_live.students.error)}</span>` : ''}
      </div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px">
        ${kpi('Mijn studenten', kpis.total, kpis.opSchema + ' op schema', 'text-1')}
        ${kpi('Vragen aandacht', kpis.aandacht, kpis.noShowsTotal + ' no-shows totaal', 'amber')}
        ${kpi('Nieuwe instroom', kpis.nieuw, 'in intake / aangemeld', 'blue')}
        ${kpi('Achterstallige betalers', kpis.overdueClients, 'onbetaalde facturen', kpis.overdueClients > 0 ? 'rose' : 'text-3')}
      </div>
      <div style="display:flex;gap:12px;flex:1;min-height:0;border:1px solid var(--border);border-radius:var(--r);overflow:hidden;background:var(--surface)">
        <div style="width:400px;min-width:320px;max-width:45%;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column">
          <div style="padding:11px 14px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:8px;flex-shrink:0">
            ${searchBar}
            <div style="display:flex;gap:5px;flex-wrap:wrap">${filterChips}</div>
            <div style="font-size:11.5px;color:var(--text-3)"><span id="stListCount">${filtered.length} student${filtered.length === 1 ? '' : 'en'}</span></div>
          </div>
          <div id="stStudentsList" style="flex:1;overflow-y:auto;min-height:0">${
            filtered.length
              ? filtered.map((s) => _renderStudentRow(s, inv)).join('')
              : `<div style="padding:44px 20px;text-align:center;color:var(--text-3);font-size:13px">${qHas || _ui.statusFilter !== 'all' ? 'Geen studenten die aan de filters voldoen.' : 'Geen studenten gekoppeld.'}</div>`
          }</div>
        </div>
        <div id="stDetailPane" style="flex:1;display:flex;flex-direction:column;min-width:0">
          ${_ui.selectedId && filtered.find((r) => String(r.bubble_student_id || r.id) === String(_ui.selectedId))
            ? _renderDetail(filtered.find((r) => String(r.bubble_student_id || r.id) === String(_ui.selectedId)))
            : `<div style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-3);font-size:13px">Selecteer een student</div>`}
        </div>
      </div>
    </div>`;
  }

  /* ── Registratie ────────────────────────────────────────────────────── */
  window.DFO.VIEWS['studenten/'] = studentenView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('studenten');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('studenten');
  console.debug('[studenten-v2] v=2 BROK 1 — reads bedraad: mentor-my-students (Bubble-proxy, mentor-self of admin-override via window.__stMentorOverride) + mentor-students-invoice-status (betaalstatus) + mentor-assessments-self (read-only notities) + mentor-1on1-sessions (lazy bij Sessies-tab). VOORBEELD-mock volledig verwijderd. Uncontrolled zoekveld (focus-behoud + surgical _repaintListBody). LMS-link naar dashboard.deforexopleiding.nl root (deep-link-patroon niet code-side vindbaar).');
})();
