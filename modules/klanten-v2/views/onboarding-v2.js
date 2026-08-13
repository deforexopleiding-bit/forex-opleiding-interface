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

  async function fetchScope(scope) {
    const st = _live[scope];
    const params = paramsFor(scope);
    if (st.loading && st.params === params) return;
    const seq = ++st.seq;
    st.loading = true; st.error = null; st.params = params;
    const data = await tryFetch('onb:' + scope, '/api/admin-future-students-list?' + params);
    if (seq !== st.seq) return;
    st.rows = asArr(data && data.rows);
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
    return H.kpis([
      { c: 'slate',   icon: I.folder || I.doc, label: 'Archief totaal', val: String(list.length), hi: 1 },
      { c: 'emerald', icon: I.tick,            label: 'Afgerond',       val: String(done) },
      { c: 'rose',    icon: I.x,               label: 'Geannuleerd',    val: String(cancelled) },
    ]);
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
    if (!st.rows && !st.loading) queueMicrotask(() => fetchScope('active'));
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
    if (!st.rows && !st.loading) queueMicrotask(() => fetchScope('archived'));
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
  function inboxPlaceholder() {
    return `<div class="empty" style="padding:60px 20px;">
      <div class="empty-ico">${svg(I.mail || I.doc)}</div>
      <div class="empty-t">Inbox komt later</div>
      <div class="empty-s">De WhatsApp-inbox voor Onboarding zit nog in de v1-hub. Gebruik <a href="/modules/onboarding-hub.html#inbox" style="color:var(--m); text-decoration:underline;">de oude hub</a> voor inbox-berichten.</div>
    </div>`;
  }

  window.DFO.VIEWS['onboarding/Actief']  = actiefView;
  window.DFO.VIEWS['onboarding/Archief'] = archiefView;
  window.DFO.VIEWS['onboarding/Inbox']   = inboxPlaceholder;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('onboarding');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('onboarding');

  console.debug('[onb-v2] parity-ronde — 12 kolommen · sort · inline mentor · kebab · intake-filter');
})();
