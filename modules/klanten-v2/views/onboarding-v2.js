// modules/klanten-v2/views/onboarding-v2.js
//
// V2 Onboarding parity-ronde 2026-08-12. Herstelt v1-parity op basis van
// shared/onboarding-overzicht.js:
//   - Endpoint switch: /api/onboardings-admin-list → /api/admin-future-students-list
//     (bevat intake_handled_at / cancelled / paid / bedenktijd / availability /
//      bubble_* / mentor_intake_status — allemaal nodig voor v1-kolommen).
//   - Lazy intake-status-patch via /api/onboarding-intake-status.
//   - Uitgebreide kolommen: Start status (pijplijn) · Voortgang · Bedenktijd · Kebab.
//     (Bubble-kolom verwijderd 2026-08-13 — Bubble-status leeft nu alleen in
//      de detail-modal tab "Account & Bubble".)
//   - Sorteerbare headers (klik = sort): Klant · Traject · Status · Mentor ·
//     Startdatum · Betaling · Aangemeld.
//   - Inline mentor-select per rij (RBAC onboarding.assign_mentor;
//     onchange → POST /api/onboarding-assign-mentor + optimistic).
//   - Intake-filter chips: Alles / Nog geen mentor / Te behandelen /
//     Afgehandeld / Geannuleerd.
//   - Kebab-menu per rij: Link kopiëren · Archiveer/Herstel.
//   - Detail-open via kebab of rij-klik (row-cache-pattern).
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

  const _live = {
    active:   { loading: false, error: null, rows: null, seq: 0, params: '' },
    archived: { loading: false, error: null, rows: null, seq: 0, params: '' },
  };
  let _trajecten = null;
  let _mentors   = null;

  const _rowsForClick = { active: [], archived: [] };
  window.__onbRowClickActive   = (i) => { const r = _rowsForClick.active[i];   if (r && r.id) window.__onbOpen(r.id); };
  window.__onbRowClickArchived = (i) => { const r = _rowsForClick.archived[i]; if (r && r.id) window.__onbOpen(r.id); };

  window.__onbOpen = async (id) => {
    try {
      const mod = await import('./modals/onboarding-detail.js');
      mod.openOnboardingDetailModal({ onboardingId: id, onSuccess: refetchAll });
    } catch (e) { console.error('[onb-v2] detail-modal load fail:', e); window.KV?.toast?.('Kon detail niet laden'); }
  };

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
    const q = String((H.getSearchValue && H.getSearchValue('onb:' + scope)) || '').trim();
    const mentor = F('onb-mentor', '');
    const traj   = F('onb-traject', '');
    const parts = ['scope=' + scope];
    if (q)      parts.push('q=' + encodeURIComponent(q));
    if (mentor) parts.push('mentor_user_id=' + encodeURIComponent(mentor));
    if (traj)   parts.push('traject_id=' + encodeURIComponent(traj));
    return parts.join('&');
  }

  // v=15 (2026-08-25): rol-bewuste endpoint-switch. Voor mentor: eigen
  // toewijzingen via /api/mentor-future-students-self (die returnt {students}
  // met dezelfde per-row shape). Voor admin/manager/super_admin: bestaande
  // /api/admin-future-students-list. admin-endpoint 403't mentors — dat was
  // de bron van "Kon onboardings niet laden" bij Seppe.
  function _currentRole() {
    try { return String(window.DFO?.S?.role || window.KV_V2?.role || '').toLowerCase(); }
    catch (_) { return ''; }
  }
  async function fetchScope(scope) {
    const st = _live[scope];
    const params = paramsFor(scope);
    if (st.loading && st.params === params) return;
    const seq = ++st.seq;
    st.loading = true; st.error = null; st.params = params;
    // v=16 (2026-08-26) — view-scope keuze nu permissie-gedreven i.p.v. rol.
    // Een mentor MET user_permissions-grant `onboarding.admin` (bv. Chesney)
    // krijgt de volledige admin-lijst; een mentor zonder die grant blijft
    // op self-scope. Server-side gate (admin-future-students-list checkt
    // onboarding.admin via user_has_permission) laat Chesney's grant al door.
    const role = _currentRole();
    var hasOnboardingAdmin = false;
    try { hasOnboardingAdmin = !!(window.RBAC && typeof window.RBAC.canSync === 'function' && window.RBAC.canSync('onboarding.admin')); }
    catch (_) { hasOnboardingAdmin = false; }
    const useSelfScope = (role === 'mentor') && !hasOnboardingAdmin;
    const isMentorScope = useSelfScope;
    const url = isMentorScope
      ? '/api/mentor-future-students-self'                     // self-scope endpoint
      : '/api/admin-future-students-list?' + params;
    const data = await tryFetch('onb:' + scope, url);
    if (seq !== st.seq) return;
    // Response-shape: admin returnt {rows:[...]}, mentor returnt {students:[...]}.
    // Normaliseer naar rijen.
    st.rows = isMentorScope
      ? asArr(data && data.students).map((s) => ({ ...s, id: s.onboarding_id || s.id }))
      : asArr(data && data.rows);
    st.error = data ? null : 'Kon onboardings niet laden';
    st.loading = false;
    if (window.DFO?.render) window.DFO.render();
    _patchIntakeStatus(scope);
  }
  async function _patchIntakeStatus(scope) {
    const rows = asArr(_live[scope]?.rows);
    if (!rows.length) return;
    const ids = rows.map((r) => r.id).filter(Boolean).slice(0, 500);
    if (!ids.length) return;
    try {
      const j = await window.KV.authedJson('/api/onboarding-intake-status', {
        method: 'POST',
        body: JSON.stringify({ onboarding_ids: ids }),
      });
      // BUGFIX 2026-08-13 (call_ingepland-ontbreekt):
      //   - Endpoint returnt `items[]` met key `onboarding_id`, NIET
      //     `statuses[]` met key `id`. Oude code las de verkeerde velden
      //     → map bleef leeg → geen enkele rij werd gepatcht → alle rijen
      //     bleven op de basisderive uit admin-future-students-list met
      //     hardcoded `hasFutureCall=false` (perf-refactor r298-310) →
      //     `call_ingepland` kwam nooit door.
      const map = new Map();
      for (const s of asArr(j?.items)) if (s?.onboarding_id) map.set(s.onboarding_id, s);
      let changed = false;
      for (const r of rows) {
        const s = map.get(r.id);
        if (!s) continue;
        // Patch de DERIVED intake_status (die is de bron voor de pill),
        // NIET de raw mentor_intake_status — die blijft de manual override.
        if (s.intake_status && r.intake_status !== s.intake_status) { r.intake_status = s.intake_status; changed = true; }
        if (s.planned_call_at != null && r.planned_call_at !== s.planned_call_at) { r.planned_call_at = s.planned_call_at; changed = true; }
      }
      if (changed && window.DFO?.render) window.DFO.render();
    } catch (e) { console.warn('[onb-v2] intake-status-patch fail:', e?.message); }
  }
  function refetchAll() {
    _live.active.rows = null; _live.active.params = '';
    _live.archived.rows = null; _live.archived.params = '';
    fetchScope('active'); fetchScope('archived');
  }
  async function loadTrajecten() {
    if (_trajecten) return;
    const j = await tryFetch('trajecten', '/api/onboarding-trajecten-list');
    _trajecten = asArr(j?.trajecten);
    if (window.DFO?.render) window.DFO.render();
  }
  async function loadMentors() {
    if (_mentors) return;
    const j = await tryFetch('mentors', '/api/mentor-admin-list');
    _mentors = asArr(j?.mentors);
    if (window.DFO?.render) window.DFO.render();
  }

  window.__onbMentorInline = async (rowId, newMentorId) => {
    const scope = _rowsForClick.active.find((r) => r.id === rowId) ? 'active' : 'archived';
    const row = _live[scope]?.rows?.find((r) => r.id === rowId);
    if (!row) return;
    const prev = row.mentor_user_id;
    row.mentor_user_id = newMentorId || null;
    row.mentor_name = newMentorId ? ((_mentors || []).find((m) => m.user_id === newMentorId)?.name || null) : null;
    if (window.DFO?.render) window.DFO.render();
    try {
      await window.KV.authedJson('/api/onboarding-assign-mentor', {
        method: 'POST',
        body: JSON.stringify({ onboarding_id: rowId, mentor_user_id: newMentorId || null }),
      });
      window.KV.toast('Mentor opgeslagen');
    } catch (e) {
      row.mentor_user_id = prev;
      if (window.DFO?.render) window.DFO.render();
      window.KV.toast('Mentor-save mislukt: ' + (e?.message || 'onbekende fout'));
    }
  };

  window.__onbKebabCopy = (id) => {
    const row = [..._rowsForClick.active, ..._rowsForClick.archived].find((r) => r.id === id);
    const link = row?.token ? (location.origin + '/modules/onboarding.html?t=' + encodeURIComponent(row.token)) : '';
    if (!link) { window.KV.toast('Geen persoonlijke link beschikbaar'); return; }
    try { navigator.clipboard.writeText(link); window.KV.toast('Link gekopieerd'); } catch (_) { alert(link); }
  };
  window.__onbKebabArchive = async (id) => {
    const row = [..._rowsForClick.active, ..._rowsForClick.archived].find((r) => r.id === id);
    const isArchived = row?.status === 'gearchiveerd';
    const action = isArchived ? 'restore' : 'archive';
    if (!confirm(isArchived ? 'Onboarding uit archief herstellen?' : 'Onboarding archiveren?')) return;
    try {
      await window.KV.authedJson('/api/onboarding-archive', { method: 'POST', body: JSON.stringify({ onboarding_id: id, action }) });
      window.KV.toast(isArchived ? 'Hersteld' : 'Gearchiveerd');
      refetchAll();
    } catch (e) { alert('Actie mislukt: ' + (e?.message || 'onbekende fout')); }
  };

  // Default sort per scope + startgroep-tab (2026-08-13).
  // - active + 'binnenkort'-tab: startdatum oplopend (NULL onderaan via
  //   Infinity-fallback in sortRows.get()). Eerstkomende start bovenaan.
  // - alle andere combinaties: 'created:desc' (behoud van huidige gedrag).
  // Als user handmatig gesorteerd heeft, respecteren we die keuze — de
  // default geldt alleen wanneer F('onb-sort-<scope>') niet gezet is.
  function _defaultSortFor(scope) {
    if (scope === 'active' && F('onb-start', 'binnenkort') === 'binnenkort') return 'startdatum:asc';
    return 'created:desc';
  }
  window.__onbSort = (scope, key) => {
    const cur = F('onb-sort-' + scope, _defaultSortFor(scope));
    const [ck, cd] = cur.split(':');
    const newDir = (ck === key && cd === 'asc') ? 'desc' : 'asc';
    _page[scope] = 1; // sort resets page
    window.DFO.setF('onb-sort-' + scope, key + ':' + newDir);
  };

  // ── Paginering (2026-08-13) ───────────────────────────────────────────
  // 50 rijen per pagina. Filter+sort eerst, dan slicen. Per-scope state
  // zodat wisselen tussen Actief/Archief niet resetten.
  const PAGE_SIZE = 50;
  const _page = { active: 1, archived: 1 };
  window.__onbPage = (scope, p) => {
    p = Math.max(1, Number(p) || 1);
    _page[scope] = p;
    if (window.DFO?.render) window.DFO.render();
  };
  function paginate(rows, scope) {
    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    let page = Math.max(1, Math.min(totalPages, _page[scope] || 1));
    if (page !== _page[scope]) _page[scope] = page; // clamp na filter-verlies
    const from = (page - 1) * PAGE_SIZE;
    const slice = rows.slice(from, from + PAGE_SIZE);
    return { slice, page, totalPages, total };
  }
  function paginator(scope, meta) {
    if (meta.total <= PAGE_SIZE) {
      // Onder de drempel — alleen totaal-tekst tonen, geen knoppen.
      return `<div class="kv-onb-pager"><span class="kv-onb-pager-info">${meta.total} onboarding${meta.total === 1 ? '' : 's'}</span></div>`;
    }
    const p = meta.page, tp = meta.totalPages;
    const btn = (n, label, disabled, active) => {
      if (disabled) return `<button class="kv-onb-pager-btn is-disabled" disabled>${esc(label)}</button>`;
      return `<button class="kv-onb-pager-btn ${active ? 'is-active' : ''}" onclick="__onbPage('${scope}', ${n})">${esc(label)}</button>`;
    };
    // Pagina-nummers: max 7 zichtbaar met ellipsis.
    const nums = [];
    const push = (n) => { if (!nums.includes(n) && n >= 1 && n <= tp) nums.push(n); };
    push(1); push(2);
    push(p - 1); push(p); push(p + 1);
    push(tp - 1); push(tp);
    nums.sort((a, b) => a - b);
    const numsHtml = [];
    let prev = 0;
    for (const n of nums) {
      if (n - prev > 1) numsHtml.push('<span class="kv-onb-pager-ellipsis">…</span>');
      numsHtml.push(btn(n, String(n), false, n === p));
      prev = n;
    }
    const rangeFrom = (p - 1) * PAGE_SIZE + 1;
    const rangeTo = Math.min(p * PAGE_SIZE, meta.total);
    return `<div class="kv-onb-pager">
      <span class="kv-onb-pager-info">${rangeFrom}–${rangeTo} van ${meta.total}</span>
      <div class="kv-onb-pager-nav">
        ${btn(p - 1, '← Vorige', p <= 1, false)}
        ${numsHtml.join('')}
        ${btn(p + 1, 'Volgende →', p >= tp, false)}
      </div>
    </div>`;
  }

  // ── Startgroep-filter (2026-08-13, Jeffrey-view) ──────────────────────
  // Nieuwe primary tab-laag NAAST de bestaande intake-chips. Werkt alleen
  // in de Actief-scope (in Archief niet zinvol — alles daar is terminal).
  //
  // Definitie (opnieuw afstembaar in overleg):
  //   binnenkort (STANDAARD): niet cancelled/afgerond/gearchiveerd EN
  //     (start_date is null OF start_date >= vandaag). Nieuwe onboardings
  //     zonder start_date vallen bewust HIER — die zijn nog niet gepland
  //     maar moeten wel starten.
  //   probleem:  status === 'aangemeld' EN start_date != null EN
  //     start_date < vandaag EN !cancelled. Enkel expliciet aangemelde
  //     rijen waarvan de startdatum verstreken is. Rijen op status='bezig'
  //     zijn dus per definitie GEEN probleem (die zijn al gestart).
  //   alle:      geen datum-filter (huidige gedrag; intake-chips blijven).
  function _startOfToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  function startFilter(rows) {
    const f = F('onb-start', 'binnenkort');
    const arr = asArr(rows);
    if (f === 'alle') return arr;
    const today = _startOfToday();
    if (f === 'binnenkort') return arr.filter((r) => {
      if (r.cancelled) return false;
      const st = String(r.status || '').toLowerCase();
      if (st === 'afgerond' || st === 'gearchiveerd') return false;
      if (!r.start_date) return true; // geen startdatum → nog te plannen, dus in "binnenkort"
      return new Date(r.start_date).getTime() >= today;
    });
    if (f === 'probleem') return arr.filter((r) => {
      if (r.cancelled) return false;
      if (String(r.status || '').toLowerCase() !== 'aangemeld') return false;
      if (!r.start_date) return false;
      return new Date(r.start_date).getTime() < today;
    });
    return arr;
  }
  function startCounts(rows) {
    const arr = asArr(rows);
    const today = _startOfToday();
    let binnenkort = 0, probleem = 0;
    for (const r of arr) {
      const st = String(r.status || '').toLowerCase();
      if (!r.cancelled && st !== 'afgerond' && st !== 'gearchiveerd') {
        if (!r.start_date || new Date(r.start_date).getTime() >= today) binnenkort++;
      }
      if (!r.cancelled && st === 'aangemeld' && r.start_date && new Date(r.start_date).getTime() < today) probleem++;
    }
    return { binnenkort, probleem, alle: arr.length };
  }
  function startTabs(counts) {
    const cur = F('onb-start', 'binnenkort');
    const items = [
      { k: 'binnenkort', l: 'Moeten nog starten', n: counts.binnenkort },
      { k: 'probleem',   l: 'Op te lossen',       n: counts.probleem, warn: true },
      { k: 'alle',       l: 'Alle',               n: counts.alle },
    ];
    return `<div class="kv-onb-tabline">
      ${items.map((it) => `<button class="kv-onb-tab ${cur === it.k ? 'is-on' : ''} ${it.warn && it.n > 0 ? 'has-warn' : ''}" onclick="__onbStartTab('${it.k}')">${esc(it.l)} <span class="kv-onb-tab-c">${it.n}</span></button>`).join('')}
    </div>`;
  }
  window.__onbStartTab = (k) => {
    _page.active = 1;
    window.DFO.setF('onb-start', k);
  };
  function sortRows(rows, scope) {
    const cur = F('onb-sort-' + scope, _defaultSortFor(scope));
    const [key, dir] = cur.split(':');
    const mul = dir === 'asc' ? 1 : -1;
    const get = (r) => {
      switch (key) {
        case 'klant':      return String(r.customer_name || '').toLowerCase();
        case 'traject':    return String(r.traject_label || '').toLowerCase();
        case 'status':     return String(r.status || '');
        case 'mentor':     return String(r.mentor_name || '').toLowerCase();
        case 'startdatum': return r.start_date ? new Date(r.start_date).getTime() : (dir === 'asc' ? Infinity : -Infinity);
        case 'betaling':   return r.paid ? 1 : 0;
        case 'aangemeld':  return r.created_at ? new Date(r.created_at).getTime() : 0;
        default:           return r.created_at ? new Date(r.created_at).getTime() : 0;
      }
    };
    return asArr(rows).slice().sort((a, b) => {
      const va = get(a); const vb = get(b);
      if (va < vb) return -1 * mul;
      if (va > vb) return  1 * mul;
      return 0;
    });
  }
  function sortHeader(scope, key, label) {
    const cur = F('onb-sort-' + scope, _defaultSortFor(scope));
    const [ck, cd] = cur.split(':');
    const arrow = ck === key ? (cd === 'asc' ? ' ↑' : ' ↓') : '';
    return `<th style="cursor:pointer" onclick="__onbSort('${scope}','${key}')" title="Sorteer op ${esc(label)}">${esc(label)}${arrow}</th>`;
  }

  // NB: intakeFilter/intakeCounts/intakeFilterChips (+ __onbIntakeChip) zijn
  // op 2026-08-13 verwijderd — Jeffrey wilde één filterrij. De startgroep-
  // tabs (Moeten nog starten / Op te lossen / Alle) zijn nu enige primaire
  // filter. Intake-status blijft zichtbaar per rij in kolom "Start status".
  const _wired = new Set();
  function wireSearch(scope) {
    const key = 'onb:' + scope;
    if (_wired.has(key)) return;
    if (H.onSearch) {
      H.onSearch(key, () => { _page[scope] = 1; _live[scope].params = ''; fetchScope(scope); });
      _wired.add(key);
    }
  }

  function toolbar(scope) {
    const trajOpts = ['<option value="">Alle trajecten</option>']
      .concat(asArr(_trajecten).map((t) => `<option value="${esc(t.id)}" ${F('onb-traject', '') === t.id ? 'selected' : ''}>${esc(t.label || t.key || t.id.slice(0, 8))}</option>`))
      .join('');
    const mentorOpts = ['<option value="">Alle mentoren</option>']
      .concat(asArr(_mentors).map((m) => `<option value="${esc(m.user_id)}" ${F('onb-mentor', '') === m.user_id ? 'selected' : ''}>${esc(m.name || m.email || m.user_id.slice(0, 8))}</option>`))
      .join('');
    const searchHtml = H.stableSearch ? H.stableSearch('onb:' + scope, 'Zoek klant…') : H.search('Zoek klant…');
    return H.toolbar([
      `<select class="filter-sel" onchange="DFO.setF('onb-traject', this.value); window.__onbRefetch();">${trajOpts}</select>`,
      `<select class="filter-sel" onchange="DFO.setF('onb-mentor', this.value); window.__onbRefetch();">${mentorOpts}</select>`,
      searchHtml,
    ]);
  }
  window.__onbRefetch = () => { _page.active = 1; _page.archived = 1; refetchAll(); };

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
    const archived  = list.filter((r) => r.status === 'gearchiveerd').length;
    // Fix ronde-6 (P3): 3e tegel toonde 'Geannuleerd 0' terwijl alle rijen
    // op 'gearchiveerd' stonden — misleidend. Tegels tonen nu de werkelijke
    // status-verdeling van het archief; nul-tegels worden verborgen.
    const tiles = [
      { c: 'slate',   icon: I.folder || I.doc, label: 'Archief totaal', val: String(list.length), hi: 1 },
    ];
    if (done > 0)      tiles.push({ c: 'emerald', icon: I.tick, label: 'Afgerond',       val: String(done) });
    if (cancelled > 0) tiles.push({ c: 'rose',    icon: I.x,    label: 'Geannuleerd',    val: String(cancelled) });
    if (archived > 0)  tiles.push({ c: 'slate',   icon: I.folder || I.doc, label: 'Gearchiveerd', val: String(archived) });
    return H.kpis(tiles);
  }

  const STATUS_PILL = {
    aangemeld:    ['info',    'Aangemeld'],
    bezig:        ['warn',    'Bezig'],
    afgerond:     ['ok',      'Afgerond'],
    gearchiveerd: ['neutral', 'Gearchiveerd'],
    geannuleerd:  ['danger',  'Geannuleerd'],
  };
  // Intake-status pill — 1-op-1 met v1 modules/shared/onboarding-overzicht.js
  // _INTAKE_META_RO (regel 761-768). Kleuren via H.pill-palet:
  //   paid-yes (groen) → 'ok', paid-no (rood) → 'danger', neutraal → 'neutral'.
  // Key-set vast in api/_lib/intake-status.js (deriveIntakeStatus).
  const INTAKE_PILL = {
    nog_geen_mentor:  ['danger',  'Nog geen mentor'],
    gestart:          ['ok',      'Gestart'],
    wil_niet:         ['danger',  'Wil niet starten'],
    no_show:          ['danger',  'No-show'],
    geen_gehoor:      ['danger',  'Geen gehoor'],
    wil_later:        ['danger',  'Wil later starten'],
    call_ingepland:   ['ok',      'Call ingepland'],
    nog_te_benaderen: ['neutral', 'Nog te benaderen'],
  };
  const statusPill = (s) => { const [c, l] = STATUS_PILL[s] || ['neutral', s || '—']; return H.pill(c, l); };
  // Prioriteit: derived intake_status (server) → raw mentor_intake_status →
  // default 'nog_te_benaderen' (nooit bare "—"). Zie v1 regel 1432 patroon.
  function intakePillOf(row) {
    const key = row?.intake_status || row?.mentor_intake_status || 'nog_te_benaderen';
    const meta = INTAKE_PILL[key];
    if (!meta) {
      // Onbekende key uit server → future-diagnose. Log 1x per unieke key
      // zodat een nieuwe status in api/_lib/intake-status.js meteen opvalt.
      _warnUnknownIntake(key);
      return H.pill('neutral', key || 'onbekend');
    }
    return H.pill(meta[0], meta[1]);
  }
  const _seenUnknownIntake = new Set();
  function _warnUnknownIntake(key) {
    if (!key || _seenUnknownIntake.has(key)) return;
    _seenUnknownIntake.add(key);
    console.warn('[onb-v2] unknown intake_status key:', key, '— add to INTAKE_PILL');
  }

  // NB: bubbleBadge is bewust verwijderd op 2026-08-13 samen met de Bubble-kolom.
  // Bubble-status blijft zichtbaar in de detail-modal (tab "Account & Bubble" →
  // `modules/klanten-v2/views/modals/onboarding-detail.js` `bubbleBadgeHtml`).
  function voortgangCell(r) {
    if (r.status === 'afgerond') return '<span style="color:var(--emerald);font-size:12px">✓ Afgerond</span>';
    if (r.status === 'geannuleerd') return '<span style="color:var(--rose);font-size:12px">Geannuleerd</span>';
    const step = r.current_step != null ? String(r.current_step) : '0';
    return `<span style="font-size:12px;color:var(--text-2)">Stap ${esc(step)}</span>`;
  }
  // Bedenktijd — 1-op-1 met v1 shared/onboarding-overzicht.js `bedenktijdBadge`
  // (r444-472). Server-shape (api/admin-future-students-list.js
  // `computeBedenktijd` r72-85): { status: 'lopend' | 'vervallen' | 'onbekend',
  // reason: 'afstand' | 'verstreken' | null, waived_at, offerte_op, vervalt_op }.
  // BUGFIX 2026-08-13: eerdere versie testte op 'loopt' / 'afstand' /
  // 'verstreken' als top-level status — server stuurt 'lopend' en
  // 'vervallen'+reason, dus de cel bleef altijd op "—" hangen.
  function _ddMmNL(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return pad(d.getDate()) + '-' + pad(d.getMonth() + 1);
  }
  function bedenktijdCell(r) {
    const b = r.bedenktijd;
    if (!b || !b.status || b.status === 'onbekend') {
      return '<span style="color:var(--text-3);font-size:11px">—</span>';
    }
    if (b.status === 'lopend') {
      const vervalt = _ddMmNL(b.vervalt_op);
      const offerte = _ddMmNL(b.offerte_op);
      const title = offerte ? ('Offerte getekend ' + offerte) : '';
      return `<span class="kv-onb-pill kv-onb-pill-warn" title="${esc(title)}">Loopt — vervalt ${esc(vervalt)}</span>`;
    }
    if (b.status === 'vervallen') {
      if (b.reason === 'afstand') {
        const waived = _ddMmNL(b.waived_at);
        const label = waived ? ('Afstand gedaan ' + waived) : 'Afstand gedaan';
        return `<span class="kv-onb-pill kv-onb-pill-ok" title="${esc(b.waived_at || '')}">${esc(label)}</span>`;
      }
      if (b.reason === 'verstreken') {
        const vervalt = _ddMmNL(b.vervalt_op);
        const offerte = _ddMmNL(b.offerte_op);
        const title = offerte ? ('14 dagen na offerte (' + offerte + ')') : '';
        const label = vervalt ? ('Verstreken ' + vervalt) : 'Verstreken';
        return `<span class="kv-onb-pill kv-onb-pill-ok" title="${esc(title)}">${esc(label)}</span>`;
      }
    }
    return '<span style="color:var(--text-3);font-size:11px">—</span>';
  }
  function mentorCell(r) {
    if (!asArr(_mentors).length) return `<span style="font-size:12px">${esc(r.mentor_name) || (r.mentor_user_id ? '#' + String(r.mentor_user_id).slice(0, 6) : '—')}</span>`;
    return `<select class="filter-sel" style="font-size:11.5px;padding:2px 6px;max-width:150px" onclick="event.stopPropagation()" onchange="__onbMentorInline('${esc(r.id)}', this.value || null)">
      <option value="">— Geen mentor —</option>
      ${asArr(_mentors).map((m) => `<option value="${esc(m.user_id)}" ${r.mentor_user_id === m.user_id ? 'selected' : ''}>${esc(m.name || m.email || m.user_id.slice(0, 8))}</option>`).join('')}
    </select>`;
  }
  function kebabCell(r) {
    const isArch = r.status === 'gearchiveerd';
    return `<div class="kv-onb-kebab" onclick="event.stopPropagation()">
      <button class="ds-icon-btn" onclick="event.stopPropagation(); this.nextElementSibling.classList.toggle('is-open');" title="Meer acties">⋮</button>
      <div class="kv-onb-kebab-menu">
        <button type="button" onclick="event.stopPropagation();__onbKebabCopy('${esc(r.id)}'); this.parentElement.classList.remove('is-open');">📋 Link kopiëren</button>
        <button type="button" onclick="event.stopPropagation();__onbKebabArchive('${esc(r.id)}'); this.parentElement.classList.remove('is-open');">${isArch ? '↩ Herstellen' : '📁 Archiveren'}</button>
      </div>
    </div>`;
  }

  function onbTable(rows, scope, handlerName) {
    const list = asArr(rows);
    if (!list.length) return `<div class="empty"><div class="empty-t">Geen onboardings</div><div class="empty-s">Er zijn geen onboardings die aan de filters voldoen.</div></div>`;
    const headers = `<tr>
      ${sortHeader(scope, 'klant', 'Klant')}
      <th>Start status</th>
      ${sortHeader(scope, 'traject', 'Traject')}
      ${sortHeader(scope, 'status', 'Status')}
      ${sortHeader(scope, 'mentor', 'Mentor')}
      <th>Voortgang</th>
      ${sortHeader(scope, 'startdatum', 'Startdatum')}
      ${sortHeader(scope, 'betaling', 'Betaling')}
      <th>Bedenktijd</th>
      ${sortHeader(scope, 'aangemeld', 'Aangemeld')}
      <th style="width:32px"></th>
    </tr>`;
    const rowsHtml = list.map((r, i) => `<tr onclick="${handlerName}(${i})" style="cursor:pointer">
      <td><span class="kv-onb-title">${esc(r.customer_name) || '—'}</span></td>
      <td>${intakePillOf(r)}</td>
      <td><span style="color:var(--text-2);font-size:12.5px">${esc(r.traject_label) || '—'}</span></td>
      <td>${statusPill(r.status)}</td>
      <td>${mentorCell(r)}</td>
      <td>${voortgangCell(r)}</td>
      <td><span class="mono" style="color:var(--text-3);font-size:12.5px">${r.start_date ? new Date(r.start_date).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }) : '—'}</span></td>
      <td>${r.paid ? H.pill('ok', 'Betaald') : H.pill('warn', 'Open')}</td>
      <td>${bedenktijdCell(r)}</td>
      <td><span class="mono" style="color:var(--text-3);font-size:12px">${r.created_at ? new Date(r.created_at).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }) : '—'}</span></td>
      <td>${kebabCell(r)}</td>
    </tr>`).join('');
    return `<div class="tbl-wrap"><table><thead>${headers}</thead><tbody>${rowsHtml}</tbody></table></div>`;
  }

  const skel = (n = 5) => `<div class="tbl-wrap"><table><thead><tr>${'<th></th>'.repeat(11)}</tr></thead>
    <tbody>${Array.from({ length: n }).map(() => `<tr style="opacity:.55">${Array.from({ length: 11 }).map(() => `<td><div style="height:12px;background:var(--surface-2);border-radius:4px;width:70%"></div></td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  const errBlk = (m) => `<div style="margin:20px;padding:14px 18px;border:1px solid var(--rose-line);background:var(--rose-soft);border-radius:var(--r);color:var(--rose);font-size:13px">⚠ Kon onboardings niet ophalen: ${esc(m)}</div>`;

  function actiefView() {
    wireSearch('active');
    if (!_trajecten) queueMicrotask(loadTrajecten);
    if (!_mentors)   queueMicrotask(loadMentors);
    const st = _live.active;
    if (!st.rows && !st.loading && !st.error) queueMicrotask(() => fetchScope('active'));
    const raw = asArr(st.rows);
    // Filter-pipeline: startgroep-tabs (enige primaire filter) → sort → pagineren.
    const afterStart  = startFilter(raw);
    const sorted      = sortRows(afterStart, 'active');
    const pageMeta    = paginate(sorted, 'active');
    _rowsForClick.active = pageMeta.slice;
    return `
      ${kpisActive(raw)}
      ${toolbar('active')}
      ${startTabs(startCounts(raw))}
      ${st.error ? errBlk(st.error)
        : (st.loading && !st.rows) ? skel(6)
        : onbTable(pageMeta.slice, 'active', '__onbRowClickActive')}
      ${(!st.error && (!st.loading || st.rows)) ? paginator('active', pageMeta) : ''}`;
  }
  function archiefView() {
    wireSearch('archived');
    if (!_trajecten) queueMicrotask(loadTrajecten);
    if (!_mentors)   queueMicrotask(loadMentors);
    const st = _live.archived;
    if (!st.rows && !st.loading && !st.error) queueMicrotask(() => fetchScope('archived'));
    const raw = asArr(st.rows);
    // Archief: geen filter-rij (alles daar is terminal), alleen sortering +
    // paginering. Startgroep-tabs zijn niet zinvol op gearchiveerde rijen.
    const sorted   = sortRows(raw, 'archived');
    const pageMeta = paginate(sorted, 'archived');
    _rowsForClick.archived = pageMeta.slice;
    return `
      ${kpisArchive(raw)}
      ${toolbar('archived')}
      ${st.error ? errBlk(st.error)
        : (st.loading && !st.rows) ? skel(4)
        : onbTable(pageMeta.slice, 'archived', '__onbRowClickArchived')}
      ${(!st.error && (!st.loading || st.rows)) ? paginator('archived', pageMeta) : ''}`;
  }
  /* ══════════════════════════════════════════════════════════════════
     ONBOARDING INLINE INBOX (v=11) — scoped op ?module=onboarding
     Patroon overgenomen uit inbox-v2 (unified). Namespaces: _onbInb / __onbInb*.
     ══════════════════════════════════════════════════════════════════ */

  const _onbInb = {
    convs:    { loading: false, fetched: false, error: null, items: [] },
    sel:      null,      // conversation_id
    thread: {
      convId: null, src: 'ob', items: [], loading: false, error: null,
      _paintedFor: null, _markedFor: null,
    },
    compose: {
      drafts: {}, mode: {}, sending: null,
      templateCache: {}, quickCache: {},
    },
    poll:     { handle: null, running: false, intervalMs: 18000 },
    _fetchSeq: 0,
  };

  // ── Helpers (tryFetch, modal, toast — spiegel inbox-v2) ─────────────
  async function _onbInbFetch(label, url, timeoutMs) {
    timeoutMs = timeoutMs || 8000;
    try {
      const p = window.KV.authedJson(url);
      return await Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
      ]);
    } catch (e) {
      console.warn('[onb-inbox] ' + label + ' fail:', e && e.message);
      return null;
    }
  }
  function _onbInbCloseModal() {
    const m = document.getElementById('onbInbModalRoot');
    if (m) m.remove();
    document.removeEventListener('keydown', _onbInbModalKey, true);
  }
  function _onbInbModalKey(e) { if (e.key === 'Escape') { e.preventDefault(); _onbInbCloseModal(); } }
  function _onbInbOpenModal(html, opts) {
    _onbInbCloseModal();
    const root = document.createElement('div');
    root.id = 'onbInbModalRoot';
    root.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)';
    root.innerHTML = `<div id="onbInbModalBox" style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);
      padding:22px;max-width:${opts?.maxWidth || 460}px;width:calc(100vw - 40px);max-height:calc(100vh - 60px);overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.35)">${html}</div>`;
    root.addEventListener('click', (e) => { if (e.target === root) _onbInbCloseModal(); });
    document.body.appendChild(root);
    document.addEventListener('keydown', _onbInbModalKey, true);
    return root;
  }
  function _onbInbAskConfirm(title, body, opts) {
    const okLabel     = esc(opts?.okLabel     || 'Bevestig');
    const cancelLabel = esc(opts?.cancelLabel || 'Annuleren');
    const tone        = opts?.tone === 'danger' ? 'rose' : 'brand';
    return new Promise((resolve) => {
      _onbInbOpenModal(`
        <div style="font-size:15.5px;font-weight:600;margin-bottom:8px">${esc(title)}</div>
        <div style="font-size:13px;color:var(--text-2);line-height:1.55;margin-bottom:18px;white-space:pre-wrap">${esc(body)}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button id="onbInbModalCancel" class="btn btn-ghost btn-sm">${cancelLabel}</button>
          <button id="onbInbModalOk" class="btn btn-primary btn-sm" style="background:var(--${tone});border-color:var(--${tone})">${okLabel}</button>
        </div>`);
      document.getElementById('onbInbModalCancel').addEventListener('click', () => { _onbInbCloseModal(); resolve(false); });
      document.getElementById('onbInbModalOk').addEventListener('click',    () => { _onbInbCloseModal(); resolve(true);  });
    });
  }
  function _onbInbToast(msg, tone) { try { window.KV && window.KV.toast && window.KV.toast(msg, { tone }); } catch (_) {} }

  function _onbInbFmtTijd(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      const delta = Date.now() - d.getTime();
      if (delta < 0) return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
      if (delta < 3600000)      return Math.max(1, Math.round(delta / 60000)) + 'm';
      if (delta < 86400000)     return Math.round(delta / 3600000) + 'u';
      if (delta < 7 * 86400000) return Math.round(delta / 86400000) + 'd';
      return d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
    } catch (_) { return '—'; }
  }

  // ── Fetchers ────────────────────────────────────────────────────────
  async function _onbInbFetchConvs() {
    const st = _onbInb.convs;
    if (st.fetched && !st.error) return;
    if (st.loading) return;
    st.loading = true; st.error = null;
    const seq = ++_onbInb._fetchSeq;
    if (window.DFO?.render) window.DFO.render();
    try {
      const j = await _onbInbFetch('convs', '/api/inbox-conversations-list?module=onboarding&status_filter=active&limit=200');
      if (seq !== _onbInb._fetchSeq) return;
      if (j && Array.isArray(j.items)) {
        st.items = j.items;
        st.fetched = true;
      } else {
        st.error = 'Kon conversaties niet laden';
      }
    } finally {
      if (seq === _onbInb._fetchSeq) {
        st.loading = false;
        if (window.DFO?.render) window.DFO.render();
      }
    }
  }
  function _onbInbResetThread() {
    _onbInb.thread.convId = null;
    _onbInb.thread.items = [];
    _onbInb.thread.loading = false;
    _onbInb.thread.error = null;
    _onbInb.thread._paintedFor = null;
    _onbInb.thread._markedFor = null;
  }
  async function _onbInbLoadThread(convId) {
    if (!convId) return;
    if (_onbInb.thread.convId === convId && !_onbInb.thread.error) return;
    _onbInb.thread.loading = true;
    _onbInb.thread.error = null;
    _onbInb.thread.convId = convId;
    _onbInb.thread.items = [];
    _onbInb.thread._paintedFor = null;
    if (window.DFO?.render) window.DFO.render();
    const seq = ++_onbInb._fetchSeq;
    const j = await _onbInbFetch('thread ' + convId, '/api/inbox-messages-list?conversation_id=' + encodeURIComponent(convId) + '&limit=200');
    if (seq !== _onbInb._fetchSeq) return;
    if (_onbInb.thread.convId !== convId) return;
    if (!j) {
      _onbInb.thread.loading = false;
      _onbInb.thread.error = 'Kon berichten niet laden';
      if (window.DFO?.render) window.DFO.render();
      return;
    }
    // v=17 (2026-08-30): shape uitgebreid met channel + top-level template_name
    // voor shared KV_V2.helpers.renderChatThread. onb-inbox is WA-only.
    _onbInb.thread.items = (j.items || []).map(m => ({
      id: m.id,
      channel: 'whatsapp',
      direction: m.direction === 'outbound' ? 'outbound' : 'inbound',
      body: m.body || '',
      at: m.sent_at || m.created_at || null,
      template_name: m.template_name || null,
      meta: { status: m.status, template_name: m.template_name },
    }));
    _onbInb.thread.loading = false;
    _onbInbMarkReadOnce(convId);
    if (window.DFO?.render) window.DFO.render();
  }
  function _onbInbMarkReadOnce(convId) {
    if (!convId) return;
    if (_onbInb.thread._markedFor === convId) return;
    _onbInb.thread._markedFor = convId;
    try {
      window.KV.authedFetch('/api/inbox-mark-read', {
        method: 'POST',
        body: JSON.stringify({ conversation_id: convId }),
      }).then(r => {
        if (!r.ok) { console.warn('[onb-inbox] mark-read HTTP', r.status); return; }
        // Lokale state + surgische DOM-patch (spiegel inbox-v2).
        const idx = _onbInb.convs.items.findIndex(it => String(it.id) === String(convId));
        if (idx >= 0) _onbInb.convs.items[idx] = { ..._onbInb.convs.items[idx], unread_count: 0 };
        const rowEl = document.querySelector('#onbInbList .onb-inb-row[data-row-id="' + String(convId).replace(/"/g, '\\"') + '"]');
        if (rowEl) {
          rowEl.classList.remove('nw');
          rowEl.querySelectorAll('span[style*="background:var(--rose)"]').forEach(d => d.remove());
        }
      }).catch(e => console.warn('[onb-inbox] mark-read fail:', e && e.message));
    } catch (e) { console.warn('[onb-inbox] mark-read setup fail:', e && e.message); }
  }

  // ── Thread paint (v=17 2026-08-30: shared chat-renderer) ────────────
  // Full re-render bij additions (groepering + footers context-afhankelijk).
  // Scroll-anchor bewaard bij not-near-bottom.
  function _onbInbPaintThread() {
    const container = document.getElementById('onbInbThreadScroll');
    if (!container) return;
    if (!_onbInb.thread.convId) { container.innerHTML = ''; return; }
    const isNewConv = _onbInb.thread._paintedFor !== _onbInb.thread.convId;
    const nearBottom = (container.scrollHeight - container.scrollTop - container.clientHeight) < 40;
    const anchor = container.scrollHeight - container.scrollTop;
    const H = window.KV_V2 && window.KV_V2.helpers;
    container.innerHTML = (H && H.renderChatThread)
      ? H.renderChatThread(_onbInb.thread.items, { escFn: esc })
      : '';
    _onbInb.thread._paintedFor = _onbInb.thread.convId;
    if (isNewConv || nearBottom) {
      container.scrollTop = container.scrollHeight;
    } else {
      container.scrollTop = container.scrollHeight - anchor;
    }
  }

  // ── Handlers op window ──────────────────────────────────────────────
  window.__onbInbSel = (id) => {
    if (String(_onbInb.sel) === String(id)) return;
    _onbInb.sel = id;
    _onbInbResetThread();
    // Surgische highlight-swap (behoud scrollpositie in de lijst).
    document.querySelectorAll('#onbInbList .onb-inb-row.on').forEach(el => el.classList.remove('on'));
    const newRow = document.querySelector('#onbInbList .onb-inb-row[data-row-id="' + String(id).replace(/"/g, '\\"') + '"]');
    if (newRow) newRow.classList.add('on');
    // Detail-pane vervangen (right-side).
    const split = document.querySelector('.onb-inb-split');
    const oldRight = split ? split.querySelector('.onb-inb-right') : null;
    const row = _onbInb.convs.items.find(c => String(c.id) === String(id));
    if (split && row) {
      const wrap = document.createElement('div');
      wrap.innerHTML = _onbInbRenderRight(row);
      const el = wrap.firstElementChild;
      if (el) { if (oldRight) split.replaceChild(el, oldRight); else split.appendChild(el); }
    }
    queueMicrotask(() => _onbInbLoadThread(id));
  };
  window.__onbInbDraftInput = (convId, val) => { _onbInb.compose.drafts[convId] = val; };
  window.__onbInbResetMode = () => {
    const convId = _onbInb.thread.convId;
    if (!convId) return;
    _onbInb.compose.mode[convId] = 'text';
    _onbInbRepaintCompose();
  };

  function _onbInbOptimisticAppend(convId, body) {
    if (_onbInb.thread.convId !== convId) return;
    _onbInb.thread.items.push({
      id: 'opt-' + Date.now(),
      direction: 'outbound',
      body,
      at: new Date().toISOString(),
      meta: {},
    });
    _onbInbPaintThread();
  }
  function _onbInbRepaintCompose() {
    const el = document.getElementById('onbInbComposeBlock');
    if (!el) return;
    el.outerHTML = _onbInbRenderCompose();
  }

  window.__onbInbSend = async () => {
    const convId = _onbInb.thread.convId;
    if (!convId) return;
    if (_onbInb.compose.sending === convId) return;
    const body = String(_onbInb.compose.drafts[convId] || '').trim();
    if (!body) { _onbInbToast('Bericht is leeg', 'warn'); return; }
    const row = _onbInb.convs.items.find(c => String(c.id) === String(convId));
    const naam = _onbInbRowVan(row);
    const preview = body.length > 140 ? body.slice(0, 140) + '…' : body;
    const ok = await _onbInbAskConfirm(`Verstuur bericht naar ${naam}?`, preview, { okLabel: 'Verstuur' });
    if (!ok) return;
    _onbInb.compose.sending = convId;
    _onbInbRepaintCompose();
    try {
      const resp = await window.KV.authedFetch('/api/inbox-send', {
        method: 'POST',
        body: JSON.stringify({ conversation_id: convId, mode: 'text', body }),
      });
      if (resp.status === 422) {
        const j = await resp.json().catch(() => ({}));
        const reason = j.error || '24h_window_expired';
        if (String(reason).includes('24h') || String(reason).includes('window')) {
          _onbInb.compose.mode[convId] = 'template';
          _onbInbToast('Buiten 24u-venster — kies een goedgekeurde template', 'warn');
          _onbInbOpenTemplatePicker(convId);
          return;
        }
        throw new Error(reason);
      }
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j.error || ('HTTP ' + resp.status));
      }
      _onbInbOptimisticAppend(convId, body);
      _onbInb.compose.drafts[convId] = '';
      _onbInbToast('WhatsApp verzonden', 'ok');
    } catch (e) {
      console.warn('[onb-inbox] send fail:', e && e.message);
      _onbInbToast('Versturen mislukt: ' + (e?.message || 'onbekend'), 'error');
    } finally {
      _onbInb.compose.sending = null;
      _onbInbRepaintCompose();
    }
  };

  window.__onbInbQuickPicker = async () => {
    const convId = _onbInb.thread.convId;
    if (!convId) return;
    let items = _onbInb.compose.quickCache[convId];
    if (!items) {
      const j = await _onbInbFetch('quick', '/api/inbox-quick-replies-list?conversation_id=' + encodeURIComponent(convId));
      items = (j && Array.isArray(j.items)) ? j.items : [];
      _onbInb.compose.quickCache[convId] = items;
    }
    if (!items.length) { _onbInbToast('Geen snel-antwoorden geconfigureerd', 'warn'); return; }
    _onbInbOpenModal(`
      <div style="font-size:15px;font-weight:600;margin-bottom:12px">Snel-antwoord kiezen</div>
      <div style="display:flex;flex-direction:column;gap:6px;max-height:60vh;overflow-y:auto">
        ${items.map(it => `
          <button class="btn btn-ghost btn-sm" data-qr-id="${esc(it.id)}" style="text-align:left;justify-content:flex-start;padding:10px 12px;height:auto;white-space:normal">
            <div style="font-weight:600;margin-bottom:2px">${esc(it.title || '(zonder titel)')}</div>
            <div style="font-size:12px;color:var(--text-3);white-space:pre-wrap;line-height:1.45">${esc(it.body_text || '')}</div>
          </button>`).join('')}
      </div>
      <div style="margin-top:14px;text-align:right"><button id="onbInbQrCancel" class="btn btn-ghost btn-sm">Sluiten</button></div>`, { maxWidth: 560 });
    document.getElementById('onbInbQrCancel').addEventListener('click', _onbInbCloseModal);
    document.querySelectorAll('#onbInbModalBox [data-qr-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-qr-id');
        const it = items.find(x => String(x.id) === String(id));
        if (it) {
          _onbInb.compose.drafts[convId] = (String(_onbInb.compose.drafts[convId] || '') + (it.body_text || '')).trimStart();
          _onbInbRepaintCompose();
          _onbInbCloseModal();
        }
      });
    });
  };

  window.__onbInbTemplatePicker = () => { _onbInbOpenTemplatePicker(_onbInb.thread.convId); };
  async function _onbInbOpenTemplatePicker(convId) {
    if (!convId) return;
    let items = _onbInb.compose.templateCache[convId];
    if (!items) {
      const j = await _onbInbFetch('tpl-list', '/api/inbox-template-list?conversation_id=' + encodeURIComponent(convId));
      items = (j && Array.isArray(j.items)) ? j.items : [];
      _onbInb.compose.templateCache[convId] = items;
    }
    if (!items.length) { _onbInbToast('Geen goedgekeurde templates', 'warn'); return; }
    _onbInbOpenModal(`
      <div style="font-size:15px;font-weight:600;margin-bottom:8px">Kies een goedgekeurde template</div>
      <div style="font-size:12px;color:var(--text-3);margin-bottom:12px">Templates mogen ook buiten het 24u-venster verstuurd worden.</div>
      <div id="onbInbTplList" style="display:flex;flex-direction:column;gap:6px;max-height:55vh;overflow-y:auto">
        ${items.map(it => `
          <button class="btn btn-ghost btn-sm" data-tpl-id="${esc(it.id)}" style="text-align:left;justify-content:flex-start;padding:10px 12px;height:auto;white-space:normal">
            <div style="font-weight:600;margin-bottom:2px">${esc(it.name)} <span style="font-size:10.5px;color:var(--text-3);font-weight:400">· ${esc(it.language || 'nl')} · ${esc(it.category || '')}</span></div>
            <div style="font-size:12px;color:var(--text-3);white-space:pre-wrap;line-height:1.45">${esc((it.body_text || '').slice(0, 200))}</div>
          </button>`).join('')}
      </div>
      <div style="margin-top:14px;text-align:right"><button id="onbInbTplCancel" class="btn btn-ghost btn-sm">Sluiten</button></div>`, { maxWidth: 620 });
    document.getElementById('onbInbTplCancel').addEventListener('click', _onbInbCloseModal);
    document.querySelectorAll('#onbInbTplList [data-tpl-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-tpl-id');
        const it = items.find(x => String(x.id) === String(id));
        if (it) _onbInbOpenTemplateForm(convId, it);
      });
    });
  }
  function _onbInbOpenTemplateForm(convId, tpl) {
    const bodyText = String(tpl.body_text || '');
    const namedMapping = tpl.meta_param_mapping && typeof tpl.meta_param_mapping === 'object' && tpl.meta_param_mapping.body;
    const positionalKeys = [];
    const re = /\{\{(\d+)\}\}/g; let m;
    while ((m = re.exec(bodyText))) if (!positionalKeys.includes(m[1])) positionalKeys.push(m[1]);
    positionalKeys.sort((a, b) => Number(a) - Number(b));
    const previewHtml = esc(bodyText).replace(/\{\{(\d+)\}\}/g, '<b style="background:var(--brand-soft,var(--surface-2));padding:0 4px;border-radius:3px">{{$1}}</b>');
    const variablesForm = (namedMapping || positionalKeys.length === 0)
      ? `<div style="font-size:12px;color:var(--text-3);padding:10px 12px;background:var(--surface-2);border-radius:var(--r-sm);margin-bottom:12px">
           ${namedMapping ? 'Variabelen worden automatisch ingevuld (klant + factuur-context).' : 'Deze template heeft geen variabelen.'}
         </div>`
      : `<div style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px">
           ${positionalKeys.map(k => `
             <label style="display:flex;flex-direction:column;gap:4px;font-size:12.5px">
               <span style="color:var(--text-3)">Variabele {{${esc(k)}}}</span>
               <input class="input" id="onbInbTplVar_${esc(k)}" placeholder="waarde voor {{${esc(k)}}}" style="padding:8px 10px;font-size:13px">
             </label>`).join('')}
         </div>`;
    _onbInbOpenModal(`
      <div style="font-size:15px;font-weight:600;margin-bottom:8px">${esc(tpl.name)}</div>
      <div style="padding:12px 14px;background:var(--surface-2);border-radius:var(--r-sm);font-size:13px;line-height:1.55;white-space:pre-wrap;margin-bottom:14px">${previewHtml}</div>
      ${variablesForm}
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="onbInbTplBack" class="btn btn-ghost btn-sm">Terug</button>
        <button id="onbInbTplSend" class="btn btn-primary btn-sm">Verstuur template</button>
      </div>`, { maxWidth: 560 });
    document.getElementById('onbInbTplBack').addEventListener('click', () => _onbInbOpenTemplatePicker(convId));
    document.getElementById('onbInbTplSend').addEventListener('click', async () => {
      const variables = {};
      if (!namedMapping) {
        positionalKeys.forEach(k => { const el = document.getElementById('onbInbTplVar_' + k); if (el) variables[k] = el.value || ''; });
      }
      const row = _onbInb.convs.items.find(c => String(c.id) === String(convId));
      const naam = _onbInbRowVan(row);
      const ok = await _onbInbAskConfirm(
        `Verstuur template naar ${naam}?`,
        `Template: ${tpl.name}\n${namedMapping ? '(auto-resolve variabelen)' : (positionalKeys.length ? 'Ingevulde variabelen: ' + positionalKeys.map(k => '{{' + k + '}}=' + (variables[k] || '(leeg)')).join(', ') : 'geen variabelen')}`,
        { okLabel: 'Verstuur template' }
      );
      if (!ok) { _onbInbOpenTemplateForm(convId, tpl); return; }
      _onbInbCloseModal();
      _onbInb.compose.sending = convId;
      _onbInbRepaintCompose();
      try {
        const payload = {
          conversation_id: convId, template_name: tpl.name,
          meta_template_id: tpl.meta_template_id || undefined,
          language: tpl.language || 'nl', variables,
        };
        const resp = await window.KV.authedFetch('/api/inbox-send-template', { method: 'POST', body: JSON.stringify(payload) });
        if (!resp.ok) {
          const j = await resp.json().catch(() => ({}));
          throw new Error(j.error || ('HTTP ' + resp.status));
        }
        _onbInbOptimisticAppend(convId, bodyText.replace(/\{\{(\d+)\}\}/g, (mm, k) => variables[k] || ('{{' + k + '}}')));
        _onbInb.compose.mode[convId] = 'text';
        _onbInbToast('Template verzonden', 'ok');
      } catch (e) {
        console.warn('[onb-inbox] template-send fail:', e && e.message);
        _onbInbToast('Template versturen mislukt: ' + (e?.message || 'onbekend'), 'error');
      } finally {
        _onbInb.compose.sending = null;
        _onbInbRepaintCompose();
      }
    });
  }

  window.__onbInbSetStatus = async (uiStatus) => {
    const convId = _onbInb.thread.convId;
    if (!convId) return;
    const row = _onbInb.convs.items.find(c => String(c.id) === String(convId));
    const naam = _onbInbRowVan(row);
    const label = uiStatus === 'gearchiveerd' ? 'Archiveren' : uiStatus === 'open' ? 'Heropenen' : 'Afhandelen';
    const ok = await _onbInbAskConfirm(
      `${label} — ${naam}?`,
      uiStatus === 'gearchiveerd' ? 'Deze conversatie verdwijnt uit de actieve lijst en komt NIET vanzelf terug bij een nieuwe inbound.'
        : uiStatus === 'afgehandeld' ? 'Tijdelijk uit de lijst; komt terug zodra de klant weer inbound stuurt.'
        : 'Verplaats terug naar de actieve lijst.',
      { okLabel: label, tone: uiStatus === 'gearchiveerd' ? 'danger' : 'brand' }
    );
    if (!ok) return;
    try {
      const resp = await window.KV.authedFetch('/api/inbox-conversation-set-status', {
        method: 'POST', body: JSON.stringify({ conversation_id: convId, status: uiStatus }),
      });
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j.error || ('HTTP ' + resp.status));
      }
      _onbInb.convs.items = _onbInb.convs.items.filter(it => String(it.id) !== String(convId));
      const rowEl = document.querySelector('#onbInbList .onb-inb-row[data-row-id="' + String(convId).replace(/"/g, '\\"') + '"]');
      if (rowEl) rowEl.remove();
      _onbInb.sel = null;
      _onbInbResetThread();
      const split = document.querySelector('.onb-inb-split');
      const oldRight = split ? split.querySelector('.onb-inb-right') : null;
      if (oldRight) oldRight.remove();
      _onbInbToast(label + ' — gelukt', 'ok');
    } catch (e) {
      console.warn('[onb-inbox] set-status fail:', e && e.message);
      _onbInbToast('Status wijzigen mislukt: ' + (e?.message || 'onbekend'), 'error');
    }
  };

  window.__onbInbMarkUnread = async () => {
    const convId = _onbInb.thread.convId;
    if (!convId) return;
    try {
      const resp = await window.KV.authedFetch('/api/inbox-mark-unread', {
        method: 'POST', body: JSON.stringify({ conversation_id: convId }),
      });
      if (!resp.ok) {
        const j = await resp.json().catch(() => ({}));
        throw new Error(j.error || ('HTTP ' + resp.status));
      }
      const idx = _onbInb.convs.items.findIndex(it => String(it.id) === String(convId));
      if (idx >= 0) _onbInb.convs.items[idx] = { ..._onbInb.convs.items[idx], unread_count: (_onbInb.convs.items[idx].unread_count || 0) + 1 };
      const rowEl = document.querySelector('#onbInbList .onb-inb-row[data-row-id="' + String(convId).replace(/"/g, '\\"') + '"]');
      if (rowEl && !rowEl.classList.contains('nw')) {
        rowEl.classList.add('nw');
        const tagRow = rowEl.querySelector('.onb-inb-tagrow');
        if (tagRow && !tagRow.querySelector('span[style*="background:var(--rose)"]')) {
          const dot = document.createElement('span');
          dot.style.cssText = 'width:7px;height:7px;border-radius:50%;background:var(--rose);margin-left:auto';
          tagRow.appendChild(dot);
        }
      }
      _onbInb.thread._markedFor = null;
      _onbInbToast('Gemarkeerd als ongelezen', 'ok');
    } catch (e) {
      console.warn('[onb-inbox] mark-unread fail:', e && e.message);
      _onbInbToast('Ongelezen markeren mislukt: ' + (e?.message || 'onbekend'), 'error');
    }
  };

  // ── Poll (18s) — refresh convs + open thread append-only ────────────
  function _onbInbStartPoll() {
    if (_onbInb.poll.handle) return;
    _onbInb.poll.handle = setInterval(_onbInbPollTick, _onbInb.poll.intervalMs);
  }
  function _onbInbStopPoll() {
    if (_onbInb.poll.handle) { clearInterval(_onbInb.poll.handle); _onbInb.poll.handle = null; }
  }
  async function _onbInbPollTick() {
    if (_onbInb.poll.running) return;
    if (!document.querySelector('.onb-inb-split')) { _onbInbStopPoll(); return; }
    if (document.hidden) return;
    _onbInb.poll.running = true;
    try {
      _onbInb.convs.fetched = false;
      await _onbInbFetchConvs();
      if (_onbInb.thread.convId) {
        const j = await _onbInbFetch('poll-thread', '/api/inbox-messages-list?conversation_id=' + encodeURIComponent(_onbInb.thread.convId) + '&limit=200');
        if (j && Array.isArray(j.items)) {
          const seen = new Set(_onbInb.thread.items.map(x => String(x.id)));
          const additions = j.items
            .filter(x => !seen.has(String(x.id)))
            .map(x => ({ id: x.id, direction: x.direction === 'outbound' ? 'outbound' : 'inbound', body: x.body || '', at: x.sent_at || x.created_at || null, meta: { status: x.status, template_name: x.template_name } }));
          if (additions.length) {
            _onbInb.thread.items = _onbInb.thread.items.concat(additions);
            _onbInbPaintThread();
          }
        }
      }
    } catch (e) {
      console.warn('[onb-inbox] poll error:', e && e.message);
    } finally {
      _onbInb.poll.running = false;
    }
  }

  // ── Helpers voor rendering ──────────────────────────────────────────
  function _onbInbRowVan(row) {
    if (!row) return 'Onbekend';
    const c = row.customer, a = row.attendee;
    if (c) return c.is_company ? c.company_name : [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || 'Onbekend';
    if (a) return [a.first_name, a.last_name].filter(Boolean).join(' ') || a.email || 'Onbekend';
    return row.display_name || row.phone_number || 'Onbekend';
  }
  function _onbInbRenderRow(row) {
    const naam    = _onbInbRowVan(row);
    const nw      = (row.unread_count || 0) > 0;
    const tijd    = _onbInbFmtTijd(row.last_message_at || row.last_activity_at);
    const preview = row.last_message_preview || '—';
    const ctx     = row.customer?.email || row.phone_number || '';
    const rowIdAttr  = String(row.id).replace(/"/g, '&quot;');
    const rowIdClick = String(row.id).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const onCls   = String(_onbInb.sel) === String(row.id) ? 'on' : '';
    return `<div class="onb-inb-row ${nw ? 'nw' : ''} ${onCls}" data-row-id="${rowIdAttr}" onclick="__onbInbSel('${rowIdClick}')"
      style="display:flex;gap:10px;padding:11px 14px;border-bottom:1px solid var(--border);cursor:pointer;${onCls === 'on' ? 'background:var(--surface-2)' : ''}">
      ${H.av(naam || '?', 34)}
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:2px">
          <span style="font-size:13.5px;font-weight:${nw ? '600' : '500'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(naam)}</span>
          <span style="margin-left:auto;font-size:10.5px;font-family:'IBM Plex Mono',monospace;color:var(--text-3);flex-shrink:0">${esc(tijd)}</span>
        </div>
        <div style="font-size:12.5px;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(preview)}</div>
        <div style="font-size:11px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(ctx)}</div>
        <div class="onb-inb-tagrow" style="margin-top:6px;display:flex;gap:6px;align-items:center">
          <span style="font-size:10.5px;padding:2px 7px;border-radius:10px;background:var(--emerald-soft);color:var(--emerald)">Onboarding</span>
          ${nw ? '<span style="width:7px;height:7px;border-radius:50%;background:var(--rose);margin-left:auto"></span>' : ''}
        </div>
      </div>
    </div>`;
  }
  function _onbInbRenderCompose() {
    const convId = _onbInb.thread.convId;
    if (!convId) return '';
    const draft = esc(_onbInb.compose.drafts[convId] || '');
    const sending = _onbInb.compose.sending === convId;
    const mode = _onbInb.compose.mode[convId] || 'text';
    if (mode === 'template') {
      return `<div id="onbInbComposeBlock" style="padding:12px 20px;background:var(--surface);border-top:1px solid var(--border)">
        <div style="padding:10px 12px;background:var(--amber-soft);border:1px solid var(--amber-line);border-radius:var(--r-sm);font-size:12.5px;color:var(--amber);margin-bottom:10px">
          Buiten het 24u-venster — alleen goedgekeurde <b>templates</b> mogen verstuurd worden.
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary btn-sm" onclick="__onbInbTemplatePicker()" ${sending ? 'disabled' : ''}>${sending ? 'Verzenden…' : 'Kies template'}</button>
          <button class="btn btn-ghost btn-sm" onclick="__onbInbResetMode()">Probeer tekst</button>
        </div>
      </div>`;
    }
    return `<div id="onbInbComposeBlock" style="padding:12px 20px;background:var(--surface);border-top:1px solid var(--border);display:flex;flex-direction:column;gap:8px">
      <textarea
        placeholder="Typ een bericht… (Ctrl+Enter om te verzenden)"
        oninput="__onbInbDraftInput('${String(convId).replace(/'/g, "\\'")}', this.value)"
        onkeydown="if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();__onbInbSend();}"
        ${sending ? 'disabled' : ''}
        style="width:100%;min-height:70px;max-height:200px;padding:10px 12px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface-2);color:var(--text-1);font-size:13.5px;line-height:1.5;font-family:inherit;resize:vertical">${draft}</textarea>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-ghost btn-sm" onclick="__onbInbQuickPicker()" ${sending ? 'disabled' : ''} title="Snel-antwoord invoegen">Snel</button>
        <button class="btn btn-ghost btn-sm" onclick="__onbInbTemplatePicker()" ${sending ? 'disabled' : ''} title="Verstuur goedgekeurde template">Template</button>
        <span style="font-size:11px;color:var(--text-3);margin-left:auto">WhatsApp — binnen 24u-venster</span>
        <button class="btn btn-primary btn-sm" onclick="__onbInbSend()" ${sending ? 'disabled' : ''}>${sending ? 'Verzenden…' : 'Verstuur'}</button>
      </div>
    </div>`;
  }
  function _onbInbRenderRight(row) {
    const naam = _onbInbRowVan(row);
    const ctx  = row.customer?.email || row.phone_number || '';
    const linkedName = row.customer
      ? (row.customer.is_company ? row.customer.company_name : [row.customer.first_name, row.customer.last_name].filter(Boolean).join(' '))
      : null;
    const linkedBadge = linkedName
      ? `<span style="font-size:11.5px;color:var(--emerald);background:var(--emerald-soft);padding:2px 8px;border-radius:12px">✓ gekoppeld: ${esc(linkedName)}</span>`
      : `<span style="font-size:11.5px;color:var(--amber);background:var(--amber-soft);padding:2px 8px;border-radius:12px">⚠ niet gekoppeld</span>`;
    const status = _onbInb.thread.loading
      ? `<div style="padding:22px;color:var(--text-3);font-size:13px">Berichten laden…</div>`
      : _onbInb.thread.error
        ? `<div style="padding:22px;color:var(--rose);font-size:13px">⚠ ${esc(_onbInb.thread.error)}</div>`
        : (!_onbInb.thread.items.length && _onbInb.thread.convId === row.id)
          ? `<div style="padding:22px;color:var(--text-3);font-size:13px">Nog geen berichten in deze conversatie.</div>`
          : '';
    return `<div class="onb-inb-right" style="display:flex;flex-direction:column;min-height:0;flex:1;background:var(--surface)">
      <div style="padding:14px 20px;background:var(--surface);border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:9px;margin-bottom:10px;flex-wrap:wrap">
          <span style="font-size:11.5px;padding:3px 10px;border-radius:12px;background:var(--emerald-soft);color:var(--emerald)">Onboarding</span>
          ${linkedBadge}
          <div style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn btn-ghost btn-sm" onclick="__onbInbMarkUnread()" title="Markeer als ongelezen">Ongelezen</button>
            <button class="btn btn-ghost btn-sm" onclick="__onbInbSetStatus('afgehandeld')" title="Afhandelen (komt terug bij inbound)">Afhandelen</button>
            <button class="btn btn-ghost btn-sm" onclick="__onbInbSetStatus('gearchiveerd')" title="Permanent uit lijst">Archief</button>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:13px">
          ${H.av(naam || '?', 42)}
          <div style="flex:1;min-width:0">
            <div style="font-size:16px;font-weight:600;letter-spacing:-.02em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(naam)}</div>
            <div style="font-size:12.5px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(ctx)}</div>
          </div>
        </div>
      </div>
      <div id="onbInbThreadScroll" style="flex:1;min-height:0;overflow-y:auto;padding:20px;display:flex;flex-direction:column"></div>
      ${status}
      ${_onbInbRenderCompose()}
    </div>`;
  }

  // ── VIEW-callback (registratie hieronder als 'onboarding/Inbox') ────
  function onbInboxView() {
    // Eerste render triggert fetch + poll.
    if (!_onbInb.convs.fetched && !_onbInb.convs.loading) {
      queueMicrotask(_onbInbFetchConvs);
    }
    // Selected row → thread-load + post-render paint.
    const rows = asArr(_onbInb.convs.items);
    const sel  = rows.find(r => String(r.id) === String(_onbInb.sel)) || rows[0] || null;
    if (sel && _onbInb.thread.convId !== sel.id && !_onbInb.thread.loading) {
      queueMicrotask(() => _onbInbLoadThread(sel.id));
    }
    queueMicrotask(_onbInbPaintThread);
    queueMicrotask(_onbInbStartPoll);

    const listHtml = _onbInb.convs.loading && !rows.length
      ? Array.from({ length: 5 }).map(() => `<div style="padding:14px 16px;border-bottom:1px solid var(--border);opacity:.5">
          <div style="height:12px;width:60%;background:var(--surface-2);border-radius:4px;margin-bottom:6px"></div>
          <div style="height:11px;width:85%;background:var(--surface-2);border-radius:4px"></div></div>`).join('')
      : rows.length
        ? rows.map(_onbInbRenderRow).join('')
        : `<div style="padding:44px 20px;text-align:center;color:var(--text-3)">Alles afgehandeld 🎉</div>`;

    return `<div class="onb-inb-split" style="display:flex;height:calc(100vh - 200px);min-height:520px;border:1px solid var(--border);border-radius:var(--r);overflow:hidden;background:var(--surface)">
      <div id="onbInbList" style="width:360px;min-width:280px;max-width:40%;background:var(--surface);border-right:1px solid var(--border);overflow-y:auto">
        <div style="padding:11px 14px;border-bottom:1px solid var(--border);font-size:11.5px;color:var(--text-3);display:flex;justify-content:space-between;align-items:center">
          <span>Onboarding-conversaties</span>
          <span>${rows.length} items</span>
        </div>
        ${_onbInb.convs.error ? `<div style="padding:16px;color:var(--rose);font-size:12.5px">⚠ ${esc(_onbInb.convs.error)}</div>` : ''}
        ${listHtml}
      </div>
      ${sel
        ? _onbInbRenderRight(sel)
        : `<div class="onb-inb-right" style="flex:1;display:flex;align-items:center;justify-content:center;color:var(--text-3);font-size:13px">Selecteer een conversatie</div>`}
    </div>`;
  }

  window.DFO.VIEWS['onboarding/Actief']  = actiefView;
  window.DFO.VIEWS['onboarding/Archief'] = archiefView;
  window.DFO.VIEWS['onboarding/Inbox']   = onbInboxView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('onboarding');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('onboarding');

  console.debug('[onb-v2] v=11 — Inbox-tab is nu VOLLEDIGE inline inbox (module=onboarding): conversations-list + messages-list append-only + reply text + 24u-fallback template-picker + quick-replies + mark-read + status-wijzigen + 18s live-poll.');
})();
