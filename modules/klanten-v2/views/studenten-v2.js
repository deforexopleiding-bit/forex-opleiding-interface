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
    // v=7 admin-picker (punt 2): mentors-lijst voor de kiezer. Lazy fetched
    // alleen als current role in super_admin/admin/manager (zie studentenView).
    mentors:   { loading: false, fetched: false, error: null, list: [] },
  };
  const _ui = {
    statusFilter: 'all',       // 'all' | 'op_schema' | 'aandacht' | 'nieuw'
    searchQ:      '',          // state-only tijdens typen (focus-behoud)
    _searchTimer: null,
    selectedId:   null,        // bubble_student_id
    detailTab:    'Overzicht', // 'Overzicht' | 'Sessies' | 'Facturen' | 'Notities'
    // v=3 BROK 2: per-student notitie/beoordeling edit-state. Prefill uit
    // _live.notes.byId[id] bij eerste render van de Notities-tab.
    // Shape: { status, score, active_tasks_done, note, saving, savedAt, error, _prefilled }
    noteEdit:     {},
  };
  const ASSESSMENT_STATUSES = ['op_schema', 'aandacht', 'risico', 'niet_actief'];
  const ASSESSMENT_STATUS_LABELS = {
    op_schema:    'Op schema',
    aandacht:     'Vraagt aandacht',
    risico:       'Risico',
    niet_actief:  'Niet actief',
  };
  const ASSESSMENT_STATUS_COLORS = {
    op_schema:    'emerald',
    aandacht:     'amber',
    risico:       'rose',
    niet_actief:  'text-3',
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
  // v=7 admin-picker: fetch mentors met user_id via bestaand endpoint.
  // Permission events.team_member.link — mentors zonder deze permission (=
  // eigenlijk alleen mentors) krijgen 403 en de picker toont een lege lijst.
  async function _fetchMentorsForPicker() {
    const st = _live.mentors;
    if (st.loading || st.fetched) return;
    st.loading = true; st.error = null;
    const j = await tryFetch('mentors-picker', '/api/team-members-bubble-status');
    st.loading = false; st.fetched = true;
    if (!j || j.error) { st.error = j?.error || 'load-fail'; if (window.DFO?.render) window.DFO.render(); return; }
    st.list = asArr(j.mentors).filter(m => m.user_id).map(m => ({ user_id: m.user_id, name: m.name, email: m.email }))
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    if (window.DFO?.render) window.DFO.render();
  }
  // v=7 admin-picker: zet override + refetch students/invoices/notes.
  window.__stSetOverride = (userId) => {
    const v = String(userId || '').trim();
    window.__stMentorOverride = v || null;
    try { window.localStorage.setItem('kv:stMentorOverride', v || ''); } catch (_) {}
    // Reset alle caches zodat volgende fetch de override oppikt.
    _live.students.data = null; _live.students.loading = false; _live.students.error = null; _live.students.scope = null; _live.students._seq++;
    _live.invoices.byEmail = null; _live.invoices.loading = false; _live.invoices.error = null; _live.invoices._seq++;
    _live.notes.byId = null; _live.notes.loading = false; _live.notes.error = null; _live.notes._seq++;
    _ui.selectedId = null;
    if (window.DFO?.render) window.DFO.render();
    // Refetch pipeline.
    queueMicrotask(_fetchStudents);
    queueMicrotask(_fetchInvoiceStatus);
    queueMicrotask(_fetchAssessments);
  };
  // Restore laatste override bij page-load (session-continuity, admin-comfort).
  try {
    const saved = window.localStorage.getItem('kv:stMentorOverride');
    if (saved) window.__stMentorOverride = saved;
  } catch (_) { /* fail-soft */ }

  async function _fetchInvoiceStatus() {
    const st = _live.invoices;
    if (st.loading || st.byEmail) return;
    st.loading = true; st.error = null;
    const seq = ++st._seq;
    const j = await tryFetch('inv-status', '/api/mentor-students-invoice-status?_=1' + _mentorOverrideParam());
    if (seq !== st._seq) return;
    st.loading = false;
    if (!j) { st.error = 'Kon betaalstatus niet laden'; if (window.DFO?.render) window.DFO.render(); return; }
    // v=7 BLOCKER-fix: endpoint returnt { byEmail: { "email": <NUMBER count> } }
    // — plat getal per lowercase-email (aantal openstaande facturen ná server-
    // filter status='open' + due_date < today = overdue). Voorheen zocht dit
    // frontend naar j.items/j.statuses/j.students → allemaal undefined → lege
    // map → KPI = 0 en 0 badges, terwijl endpoint 4 achterstalligen leverde.
    // Backward-compat: items[]-vorm ook ondersteund voor als endpoint ooit muteert.
    const map = {};
    if (j.byEmail && typeof j.byEmail === 'object') {
      for (const [email, count] of Object.entries(j.byEmail)) {
        const n = Number(count) || 0;
        if (n <= 0) continue;
        const k = String(email || '').toLowerCase();
        if (!k) continue;
        map[k] = { open: n, overdue: n, paid: 0, open_amount: 0, overdue_amount: 0 };
      }
    } else {
      // Legacy shape fallback (items[]/statuses/students).
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
    if (tab === 'Sessies' && !_live.sessions.data && !_live.sessions.loading && !_live.sessions.error && !_live.sessions.error) queueMicrotask(_fetchSessions);
    _repaintDetailPane();
  };
  /* ── BROK 2 — Notitie/beoordeling edit-state ─────────────────────────
     Prefill uit bestaande assessment (indien geladen); anders defaults.
     State-only setters tijdens typen zodat de textarea + score-input hun
     focus houden (geen render). Repaint van submit-knop-enable-state via
     directe DOM-toggle. Bij Opslaan: race-guard + POST + optimistic
     update + tijdstempel. */
  function _noteState(id) {
    // v=4: score default is nu 7 (integer) — leeg maken door user zet 'em
    // op null; save-knop is dan gedisabled bij status != niet_actief.
    if (!_ui.noteEdit[id]) _ui.noteEdit[id] = { status: 'op_schema', score: 7, active_tasks_done: false, note: '', saving: false, savedAt: null, error: null, _prefilled: false };
    return _ui.noteEdit[id];
  }
  function _prefillNoteFromServer(id) {
    const ns = _noteState(id);
    if (ns._prefilled) return;
    const existing = _live.notes.byId ? _live.notes.byId[String(id)] : null;
    if (existing) {
      if (existing.status && ASSESSMENT_STATUSES.includes(existing.status)) ns.status = existing.status;
      if (Number.isInteger(Number(existing.score))) ns.score = Number(existing.score);
      if (typeof existing.active_tasks_done === 'boolean') ns.active_tasks_done = existing.active_tasks_done;
      ns.note = String(existing.note || existing.notes || existing.body || '') || '';
    }
    ns._prefilled = true;
  }
  function _noteIsSaveable(ns) {
    if (!ns) return false;
    if (ns.status === 'niet_actief') return true; // score/tasks vervallen
    const n = Number(ns.score);
    return Number.isFinite(n) && Number.isInteger(n) && n >= 1 && n <= 10;
  }
  function _updateNoteSaveBtn(id) {
    const btn = document.getElementById('stNoteSaveBtn_' + id);
    if (!btn) return;
    const ns = _noteState(id);
    const canSave = _noteIsSaveable(ns);
    const disabled = !!ns.saving || !canSave;
    btn.disabled = disabled;
    btn.textContent = ns.saving ? 'Opslaan…' : 'Opslaan';
    btn.title = ns.saving ? '' : (canSave ? '' : 'Vul een score 1-10 in');
    btn.style.opacity = disabled ? '.55' : '1';
    btn.style.cursor  = disabled ? 'not-allowed' : 'pointer';
    // Score-hint alleen tonen wanneer de knop geblokkeerd is door
    // ontbrekende score (niet tijdens saving).
    const hint = document.getElementById('stNoteScoreHint_' + id);
    if (hint) hint.style.display = (!ns.saving && !canSave && ns.status !== 'niet_actief') ? 'inline' : 'none';
  }
  // State-only setters (geen render → textarea/input focus behouden).
  window.__stNoteSetStatus = (id, val) => {
    if (!ASSESSMENT_STATUSES.includes(val)) return;
    const ns = _noteState(id);
    ns.status = val; ns.error = null; ns.savedAt = null;
    // Status-wissel: score/tasks-block moet mogelijk verschijnen/verdwijnen
    // (bij 'niet_actief' vervalt score+tasks). Volledige tab-render is nodig.
    _repaintDetailPane();
  };
  window.__stNoteSetScore = (id, val) => {
    // v=4: GEEN stille auto-clamp meer. Leeg / niet-numeriek → null,
    // Save-knop wordt automatisch gedisabled via _updateNoteSaveBtn.
    // Nummer buiten 1..10 → null. Alleen geldige 1..10 wordt bewaard.
    const ns = _noteState(id);
    const raw = String(val == null ? '' : val).trim();
    if (raw === '') {
      ns.score = null;
    } else {
      const n = Number(raw);
      if (Number.isFinite(n) && Number.isInteger(n) && n >= 1 && n <= 10) {
        ns.score = n;
      } else {
        ns.score = null;
      }
    }
    ns.error = null; ns.savedAt = null;
    _updateNoteSaveBtn(id);
  };
  window.__stNoteSetTasksDone = (id, el) => {
    const ns = _noteState(id);
    ns.active_tasks_done = !!(el && el.checked);
    ns.error = null; ns.savedAt = null;
  };
  window.__stNoteSetText = (id, val) => {
    const ns = _noteState(id);
    ns.note = String(val || '');
    ns.error = null; ns.savedAt = null;
    // 'Opgeslagen'-badge verbergen bij typen na een succesvolle save.
    const savedEl = document.getElementById('stNoteSaved_' + id);
    if (savedEl && savedEl.style.display !== 'none') savedEl.style.display = 'none';
  };
  window.__stNoteSave = async (id) => {
    const ns = _noteState(id);
    if (ns.saving) return;
    const rows = asArr(_live.students.data);
    const s = rows.find((x) => String(x.bubble_student_id || x.id) === String(id));
    if (!s) return;
    const name = s.name || s.email || '';
    if (!name) { ns.error = 'Student-naam ontbreekt — kan niet opslaan.'; _repaintDetailPane(); return; }
    ns.saving = true; ns.error = null; ns.savedAt = null;
    _updateNoteSaveBtn(id);
    const payload = {
      student_id: String(id),
      student_name: name,
      status: ns.status,
      note: (ns.note && ns.note.trim()) ? ns.note.trim() : null,
    };
    if (ns.status !== 'niet_actief') {
      payload.score = ns.score;
      payload.active_tasks_done = !!ns.active_tasks_done;
    }
    // v=4 FIX 1: admin-override doorsturen. Zonder dit valt de server
    // terug op auth.uid() → 403 'Mentor heeft geen bubble-koppeling' voor
    // admin/super_admin die met __stMentorOverride namens een mentor test.
    // Reads gebruikten al _mentorOverrideParam(); nu writes ook.
    const overrideRaw = String(window.__stMentorOverride || '').trim();
    if (overrideRaw) payload.mentor_user_id = overrideRaw;
    try {
      const token = await (window.AuthShared && window.AuthShared.getAccessToken ? window.AuthShared.getAccessToken() : Promise.resolve(null));
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = 'Bearer ' + token;
      const resp = await fetch('/api/mentor-assessment-save', {
        method: 'POST', headers, body: JSON.stringify(payload),
      });
      let j = null; try { j = await resp.json(); } catch (_) {}
      ns.saving = false;
      if (!resp.ok) {
        ns.error = (j && j.error) || ('HTTP ' + resp.status);
        _repaintDetailPane();
        return;
      }
      // Optimistic: update _live.notes.byId[id] met de teruggegeven rij
      // (autoritatief; server heeft period_month + updated_at).
      const saved = j.assessment || null;
      if (!_live.notes.byId) _live.notes.byId = {};
      if (saved) _live.notes.byId[String(id)] = saved;
      ns.savedAt = new Date().toISOString();
      _repaintDetailPane();
      // v=5 FIX B: badge in lijst-rij ook direct bijwerken (rij bevat een
      // gekleurde beoordelings-badge die uit _live.notes.byId leest).
      _repaintListBody();
      setTimeout(() => {
        const el = document.getElementById('stNoteSaved_' + id);
        if (el) el.style.display = 'none';
      }, 3000);
    } catch (e) {
      ns.saving = false;
      ns.error = 'Netwerkfout — probeer het opnieuw.';
      console.warn('[studenten-v2 note-save] fail:', e?.message || e);
      _repaintDetailPane();
    }
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
  // v=5 FIX B: beoordelings-badge helper. Bron: _live.notes.byId[id].status
  // (per-mentor upsert huidige maand). Ontbrekend / nog niet geladen →
  // subtiel 'nog niet beoordeeld'-tekst (badge:false optie geeft leeg).
  function _assessmentBadgeHtml(id, opts) {
    const note = _live.notes.byId ? _live.notes.byId[String(id)] : null;
    const notLoaded = !_live.notes.byId;
    if (notLoaded && !(opts && opts.hideWhileLoading)) return '';
    if (!note || !note.status || !ASSESSMENT_STATUSES.includes(note.status)) {
      // Geen beoordeling deze maand.
      if (opts && opts.subtle) return `<span style="font-size:10px;padding:2px 6px;border-radius:6px;background:var(--surface-2);color:var(--text-3);font-weight:500;font-style:italic">nog niet beoordeeld</span>`;
      return '';
    }
    const col = ASSESSMENT_STATUS_COLORS[note.status] || 'text-3';
    const label = ASSESSMENT_STATUS_LABELS[note.status] || note.status;
    return `<span title="Beoordeling deze maand" style="font-size:10.5px;padding:2px 8px;border-radius:6px;background:var(--${col}-soft,var(--surface-2));color:var(--${col});font-weight:600">${esc(label)}</span>`;
  }

  // v=6 FIX 2: v1-status-badge (rechtsboven in de rij). Prioriteit (eerste
  // match wint): Betaalachterstand > No-show recent > Geen call ingepland >
  // Op schema. Data: no_shows uit mentor-my-students; invoice-status uit
  // mentor-students-invoice-status (overdue > 0). Los van de beoordelings-
  // badge (BROK 2), die staat ook nog naast de naam.
  function _rowStatusBadge(s, inv) {
    const email = s.email || '';
    const iv = inv && email ? inv[email.toLowerCase()] : null;
    const overdue = iv ? Number(iv.overdue || 0) : 0;
    const noShows = Number(s.no_shows || 0);
    const one1Done  = Number(s.calls_1on1_done  || 0);
    const one1Total = Number(s.calls_1on1_total || 0);
    if (overdue > 0) {
      return `<span title="${overdue} openstaande factuur/facturen te laat" style="font-size:10.5px;padding:2px 8px;border-radius:6px;background:var(--rose-soft);color:var(--rose);font-weight:600">Betaalachterstand</span>`;
    }
    if (noShows > 0) {
      return `<span title="${noShows} no-show${noShows === 1 ? '' : 's'}" style="font-size:10.5px;padding:2px 8px;border-radius:6px;background:var(--amber-soft);color:var(--amber);font-weight:600">No-show recent</span>`;
    }
    // Heuristiek "Geen call ingepland": geen enkele 1-op-1 call in het systeem
    // (done=0 AND total=0). Als er wel calls gepland zijn (total > 0) blijft
    // de student op 'Op schema' — die telt als goed geregisseerd.
    if (one1Done === 0 && one1Total === 0) {
      return `<span title="Geen 1-op-1 call zichtbaar in de LMS" style="font-size:10.5px;padding:2px 8px;border-radius:6px;background:var(--surface-2);color:var(--text-3);font-weight:600;font-style:italic">Geen call ingepland</span>`;
    }
    return `<span style="font-size:10.5px;padding:2px 8px;border-radius:6px;background:var(--emerald-soft);color:var(--emerald);font-weight:600">Op schema</span>`;
  }

  function _renderStudentRow(s, inv) {
    const id = String(s.bubble_student_id || s.id || '');
    const name = s.name || s.email || 'Onbekend';
    const program = s.program || s.membership || '—';
    // v=6 FIX 1: groep-progressie volledig verwijderd (Jeffrey wil geen
    // enkele groeps-verwijzing meer). Alleen 1-op-1 blijft.
    const oneOnOne = { done: Number(s.calls_1on1_done || 0), total: Number(s.calls_1on1_total || 0) };
    const oneCol = _sessieKleur(oneOnOne.done, oneOnOne.total);
    const noShows = Number(s.no_shows || 0);
    const onCls = String(_ui.selectedId) === id ? 'on' : '';
    const idAttr  = id.replace(/"/g, '&quot;');
    const idClick = id.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const assessBadge = _assessmentBadgeHtml(id, { hideWhileLoading: true });
    const statusBadge = _rowStatusBadge(s, inv);
    return `<div class="st-row ${onCls}" data-id="${idAttr}" onclick="__stSelectStudent('${idClick}')"
      style="display:flex;gap:10px;padding:11px 14px;border-bottom:1px solid var(--border);cursor:pointer;${onCls ? 'background:var(--surface-2)' : ''}">
      ${_av(name, 34)}
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:2px">
          <span style="font-size:13.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</span>
          <span style="margin-left:auto;flex-shrink:0;display:inline-flex;gap:5px;align-items:center">${assessBadge}${statusBadge}</span>
        </div>
        <div style="font-size:12px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(program)}</div>
        <div style="margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:10.5px">
          <span style="padding:2px 6px;border-radius:6px;background:var(--${oneCol}-soft,var(--surface-2));color:var(--${oneCol},var(--text-3));font-weight:600">1-op-1 ${oneOnOne.done}/${oneOnOne.total || '—'}</span>
          ${noShows > 0 ? `<span style="padding:2px 6px;border-radius:6px;background:var(--rose-soft);color:var(--rose);font-weight:600">${noShows} no-show${noShows === 1 ? '' : 's'}</span>` : ''}
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
    // v=6 FIX 1: group volledig weg. Alleen 1-op-1 blijft in detail-pane.
    const oneOnOne = { done: Number(s.calls_1on1_done || 0), total: Number(s.calls_1on1_total || 0) };
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
      // BROK 2: interactief. Wacht op notes-fetch bij eerste laden zodat we
      // met bestaande waarden kunnen prefillen. Daarna full edit-form.
      if (_live.notes.loading && !_live.notes.byId) {
        body = `<div style="padding:22px;color:var(--text-3);font-size:13px;text-align:center">Notities laden…</div>`;
      } else {
        _prefillNoteFromServer(id);
        const ns = _noteState(id);
        const serverNote = _live.notes.byId ? _live.notes.byId[String(id)] : null;
        const statusChips = ASSESSMENT_STATUSES.map((v) => {
          const on = ns.status === v;
          const col = ASSESSMENT_STATUS_COLORS[v] || 'text-3';
          const bg = on ? `var(--${col})` : 'transparent';
          const fg = on ? '#fff' : `var(--${col})`;
          const bd = `var(--${col}-line, var(--${col}))`;
          return `<button class="chip" style="padding:4px 12px;border:1px solid ${bd};background:${bg};color:${fg};border-radius:20px;font-size:11.5px;font-weight:${on ? '600' : '500'};cursor:pointer" onclick="__stNoteSetStatus('${esc(id)}','${v}')">${esc(ASSESSMENT_STATUS_LABELS[v])}</button>`;
        }).join('');
        const showScoreBlock = ns.status !== 'niet_actief';
        const savedRecently = ns.savedAt && (Date.now() - new Date(ns.savedAt).getTime() < 3500);
        const lastUpdatedTxt = serverNote && serverNote.updated_at
          ? 'Laatst opgeslagen: ' + new Date(serverNote.updated_at).toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
          : 'Nog niet eerder opgeslagen deze maand.';
        body = `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:16px 18px;display:flex;flex-direction:column;gap:14px">
          <div>
            <div style="font-size:11.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Beoordeling</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px">${statusChips}</div>
          </div>
          ${showScoreBlock ? `
            <div style="display:grid;grid-template-columns:1fr auto;gap:12px;align-items:end">
              <div>
                <div style="font-size:11.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Score (1-10) <span id="stNoteScoreHint_${esc(id)}" style="display:${_noteIsSaveable(ns) ? 'none' : 'inline'};color:var(--rose);text-transform:none;letter-spacing:0;font-weight:500;margin-left:6px">· vul een score 1-10 in</span></div>
                <input type="number" min="1" max="10" step="1" value="${ns.score == null ? '' : esc(String(ns.score))}"
                  oninput="__stNoteSetScore('${esc(id)}', this.value)"
                  placeholder="1-10"
                  style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);color:var(--text-1);font:inherit;font-size:13px;outline:none;box-sizing:border-box" />
              </div>
              <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;padding-bottom:9px;cursor:pointer">
                <input type="checkbox" ${ns.active_tasks_done ? 'checked' : ''}
                  onchange="__stNoteSetTasksDone('${esc(id)}', this)"
                  style="width:16px;height:16px;cursor:pointer" />
                <span>Actieve taken gedaan</span>
              </label>
            </div>
          ` : ''}
          <div>
            <div style="font-size:11.5px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Notitie</div>
            <textarea placeholder="Notitie over deze student… (optioneel)"
              oninput="__stNoteSetText('${esc(id)}', this.value)"
              style="width:100%;min-height:100px;max-height:280px;padding:9px 11px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface);color:var(--text-1);font:inherit;font-size:12.5px;line-height:1.5;resize:vertical;outline:none;box-sizing:border-box">${esc(ns.note || '')}</textarea>
          </div>
          ${ns.error ? `<div style="padding:9px 12px;background:var(--rose-soft);color:var(--rose);border-radius:var(--r-sm);font-size:12px;display:flex;justify-content:space-between;align-items:center;gap:8px">
            <span>⚠ ${esc(ns.error)}</span>
            <button class="btn btn-ghost btn-sm" onclick="__stNoteSave('${esc(id)}')" style="font-size:11px">Opnieuw</button>
          </div>` : ''}
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
            <div style="font-size:11px;color:var(--text-3)">
              ${esc(lastUpdatedTxt)}
              <span id="stNoteSaved_${esc(id)}" style="display:${savedRecently ? 'inline' : 'none'};margin-left:8px;color:var(--emerald);font-weight:600">✓ Opgeslagen</span>
            </div>
            <button id="stNoteSaveBtn_${esc(id)}" class="btn btn-primary btn-sm"
              ${ns.saving || !_noteIsSaveable(ns) ? 'disabled' : ''}
              title="${ns.saving ? '' : (_noteIsSaveable(ns) ? '' : 'Vul een score 1-10 in')}"
              style="background:var(--brand,#0A7490);border-color:var(--brand,#0A7490);color:#fff;font-size:12px;opacity:${ns.saving || !_noteIsSaveable(ns) ? '.55' : '1'};cursor:${ns.saving || !_noteIsSaveable(ns) ? 'not-allowed' : 'pointer'}"
              onclick="__stNoteSave('${esc(id)}')">${ns.saving ? 'Opslaan…' : 'Opslaan'}</button>
          </div>
          <div style="font-size:10.5px;color:var(--text-3);line-height:1.45">
            Beoordeling geldt voor de <b>huidige maand</b> en wordt maandelijks opnieuw ingevuld.
            De status-badge in de lijst en het detail werken automatisch mee met wat je hier zet.
          </div>
        </div>`;
      }
    }

    // v=5 FIX B: beoordelings-badge in header (naast naam). Toon 'nog niet
    // beoordeeld'-subtekst wanneer geen assessment deze maand (helpt de
    // mentor te zien wat 'ie nog moet doen).
    const headerAssessBadge = _assessmentBadgeHtml(id, { subtle: true });
    return `<div style="display:flex;flex-direction:column;min-height:0;flex:1;background:var(--surface)">
      <div style="padding:14px 20px;background:var(--surface);border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:13px;margin-bottom:10px">
          ${_av(name, 42)}
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
              <div style="font-size:16px;font-weight:600;letter-spacing:-.02em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</div>
              ${headerAssessBadge}
            </div>
            <div style="font-size:12.5px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px">${esc(email || '—')}</div>
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
    // v=7 admin-picker (punt 2): alleen voor admin/manager/super_admin — mentors
    // houden mentor-first eigen-lijst zonder picker. Alleen lazy-fetchen als de
    // huidige user een candidate-rol heeft (voorkomt onnodige call bij mentors).
    const currentRole = (window.DFO?.S?.roles && window.DFO.S.roles[0]) || '';
    const isPickerRole = ['super_admin', 'admin', 'manager'].includes(currentRole);
    if (isPickerRole && !_live.mentors.fetched && !_live.mentors.loading) queueMicrotask(_fetchMentorsForPicker);
    const currentOverride = String(window.__stMentorOverride || '').trim();
    const mentorPicker = isPickerRole
      ? `<div style="margin-left:auto;display:flex;align-items:center;gap:6px;font-size:11.5px">
          <span style="color:var(--text-3)">Bekijk als mentor:</span>
          <select id="stMentorPicker" onchange="__stSetOverride(this.value)" style="padding:3px 8px;font-size:11.5px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text-1);max-width:220px">
            <option value="">— eigen (mentor of niks) —</option>
            ${(_live.mentors.list || []).map(m => `<option value="${esc(m.user_id)}"${m.user_id===currentOverride?' selected':''}>${esc(m.name || m.email || m.user_id.slice(0,8))}</option>`).join('')}
          </select>
          ${_live.mentors.loading ? '<span style="color:var(--text-3)">…</span>' : ''}
        </div>`
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
      <div style="display:flex;align-items:center;margin-bottom:14px;gap:12px;flex-wrap:wrap">
        <div style="font-size:12.5px;color:var(--text-3)">${kpis.total} studenten totaal ${scopeBadge}</div>
        ${_live.students.error && _live.students.data ? `<span style="font-size:11.5px;color:var(--amber)">⚠ ${esc(_live.students.error)}</span>` : ''}
        ${mentorPicker}
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
  console.debug('[studenten-v2] v=6 — FIX 1: groepscall-info volledig verwijderd (rij-badge + detail progress-bar). Alleen 1-op-1 blijft. FIX 2: v1-status-badge terug per rij (prio: Betaalachterstand>No-show recent>Geen call ingepland>Op schema). Naast bestaande beoordelings-badge (BROK 2). Betaalstatus uit mentor-students-invoice-status (al gekoppeld).');
})();
