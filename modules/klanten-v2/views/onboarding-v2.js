// modules/klanten-v2/views/onboarding-v2.js
//
// V2 Onboarding parity-ronde 2026-08-12. Herstelt v1-parity op basis van
// shared/onboarding-overzicht.js:
//   - Endpoint switch: /api/onboardings-admin-list → /api/admin-future-students-list
//     (bevat intake_handled_at / cancelled / paid / bedenktijd / availability /
//      bubble_* / mentor_intake_status — allemaal nodig voor v1-kolommen).
//   - Lazy intake-status-patch via /api/onboarding-intake-status.
//   - Uitgebreide kolommen: Start status (pijplijn) · Voortgang · Bubble · Kebab.
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
      const map = new Map();
      for (const s of asArr(j?.statuses)) if (s?.id) map.set(s.id, s);
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

  window.__onbSort = (scope, key) => {
    const cur = F('onb-sort-' + scope, 'created:desc');
    const [ck, cd] = cur.split(':');
    const newDir = (ck === key && cd === 'asc') ? 'desc' : 'asc';
    window.DFO.setF('onb-sort-' + scope, key + ':' + newDir);
  };
  function sortRows(rows, scope) {
    const cur = F('onb-sort-' + scope, 'created:desc');
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
    const cur = F('onb-sort-' + scope, 'created:desc');
    const [ck, cd] = cur.split(':');
    const arrow = ck === key ? (cd === 'asc' ? ' ↑' : ' ↓') : '';
    return `<th style="cursor:pointer" onclick="__onbSort('${scope}','${key}')" title="Sorteer op ${esc(label)}">${esc(label)}${arrow}</th>`;
  }

  function intakeFilter(rows) {
    const f = F('onb-intake', 'all');
    const arr = asArr(rows);
    if (f === 'all') return arr;
    if (f === 'nog_geen_mentor') return arr.filter((r) => !r.mentor_user_id);
    if (f === 'te_behandelen')   return arr.filter((r) => {
      const key = r?.intake_status || r?.mentor_intake_status;
      return ['wil_niet','no_show','geen_gehoor','wil_later'].includes(key) && !r.intake_handled_at && !r.cancelled;
    });
    if (f === 'afgehandeld')     return arr.filter((r) => !!r.intake_handled_at && !r.cancelled);
    if (f === 'geannuleerd')     return arr.filter((r) => !!r.cancelled);
    return arr;
  }
  function intakeCounts(rows) {
    const arr = asArr(rows);
    return {
      all: arr.length,
      nog_geen_mentor: arr.filter((r) => !r.mentor_user_id).length,
      te_behandelen: arr.filter((r) => {
        const key = r?.intake_status || r?.mentor_intake_status;
        return ['wil_niet','no_show','geen_gehoor','wil_later'].includes(key) && !r.intake_handled_at && !r.cancelled;
      }).length,
      afgehandeld: arr.filter((r) => !!r.intake_handled_at && !r.cancelled).length,
      geannuleerd: arr.filter((r) => !!r.cancelled).length,
    };
  }

  const _wired = new Set();
  function wireSearch(scope) {
    const key = 'onb:' + scope;
    if (_wired.has(key)) return;
    if (H.onSearch) {
      H.onSearch(key, () => { _live[scope].params = ''; fetchScope(scope); });
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
  window.__onbRefetch = () => { refetchAll(); };

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
    const [c, l] = INTAKE_PILL[key] || INTAKE_PILL.nog_te_benaderen;
    return H.pill(c, l);
  }

  function bubbleBadge(r) {
    if (r.bubble_provisioned) return `<span class="kv-onb-pill kv-onb-pill-ok" title="Bubble user ${esc(r.bubble_user_id || '')}">✓</span>`;
    if (r.bubble_provision_error) return `<span class="kv-onb-pill kv-onb-pill-danger" title="${esc(r.bubble_provision_error)}">⚠</span>`;
    return `<span style="color:var(--text-3);font-size:11px">—</span>`;
  }
  function voortgangCell(r) {
    if (r.status === 'afgerond') return '<span style="color:var(--emerald);font-size:12px">✓ Afgerond</span>';
    if (r.status === 'geannuleerd') return '<span style="color:var(--rose);font-size:12px">Geannuleerd</span>';
    const step = r.current_step != null ? String(r.current_step) : '0';
    return `<span style="font-size:12px;color:var(--text-2)">Stap ${esc(step)}</span>`;
  }
  function bedenktijdCell(r) {
    const b = r.bedenktijd;
    if (!b || !b.status) return '<span style="color:var(--text-3);font-size:11px">—</span>';
    const dd = b.vervalt_op ? new Date(b.vervalt_op).toLocaleDateString('nl-NL', { day: '2-digit', month: '2-digit' }) : '';
    if (b.status === 'loopt')       return `<span style="color:var(--amber);font-size:11.5px">Vervalt ${esc(dd)}</span>`;
    if (b.status === 'afstand')     return `<span style="color:var(--emerald);font-size:11.5px">Afstand ${esc(dd)}</span>`;
    if (b.status === 'verstreken')  return `<span style="color:var(--text-3);font-size:11.5px">Verstreken ${esc(dd)}</span>`;
    return '—';
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
      <th>Bubble</th>
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
      <td>${bubbleBadge(r)}</td>
      <td><span class="mono" style="color:var(--text-3);font-size:12px">${r.created_at ? new Date(r.created_at).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }) : '—'}</span></td>
      <td>${kebabCell(r)}</td>
    </tr>`).join('');
    return `<div class="tbl-wrap"><table><thead>${headers}</thead><tbody>${rowsHtml}</tbody></table></div>`;
  }

  function intakeFilterChips(counts) {
    const cur = F('onb-intake', 'all');
    const items = [
      { k: 'all',              l: 'Alles',              n: counts.all },
      { k: 'nog_geen_mentor',  l: 'Nog geen mentor',    n: counts.nog_geen_mentor },
      { k: 'te_behandelen',    l: 'Te behandelen',      n: counts.te_behandelen, warn: true },
      { k: 'afgehandeld',      l: 'Afgehandeld',        n: counts.afgehandeld },
      { k: 'geannuleerd',      l: 'Geannuleerd',        n: counts.geannuleerd },
    ];
    return `<div style="padding:8px 20px; display:flex; gap:6px; flex-wrap:wrap;">
      ${items.map((it) => `<button class="chip ${cur === it.k ? 'on' : ''} ${it.warn && it.n > 0 ? 'chip-warn' : ''}" onclick="DFO.setF('onb-intake', '${it.k}')">${esc(it.l)} <span style="opacity:.7">(${it.n})</span></button>`).join('')}
    </div>`;
  }

  const skel = (n = 5) => `<div class="tbl-wrap"><table><thead><tr>${'<th></th>'.repeat(12)}</tr></thead>
    <tbody>${Array.from({ length: n }).map(() => `<tr style="opacity:.55">${Array.from({ length: 12 }).map(() => `<td><div style="height:12px;background:var(--surface-2);border-radius:4px;width:70%"></div></td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  const errBlk = (m) => `<div style="margin:20px;padding:14px 18px;border:1px solid var(--rose-line);background:var(--rose-soft);border-radius:var(--r);color:var(--rose);font-size:13px">⚠ Kon onboardings niet ophalen: ${esc(m)}</div>`;

  function actiefView() {
    wireSearch('active');
    if (!_trajecten) queueMicrotask(loadTrajecten);
    if (!_mentors)   queueMicrotask(loadMentors);
    const st = _live.active;
    if (!st.rows && !st.loading) queueMicrotask(() => fetchScope('active'));
    const raw = asArr(st.rows);
    const filtered = intakeFilter(raw);
    const rows = sortRows(filtered, 'active');
    _rowsForClick.active = rows;
    return `
      ${kpisActive(raw)}
      ${toolbar('active')}
      ${intakeFilterChips(intakeCounts(raw))}
      ${st.error ? errBlk(st.error)
        : (st.loading && !st.rows) ? skel(6)
        : onbTable(rows, 'active', '__onbRowClickActive')}`;
  }
  function archiefView() {
    wireSearch('archived');
    if (!_trajecten) queueMicrotask(loadTrajecten);
    if (!_mentors)   queueMicrotask(loadMentors);
    const st = _live.archived;
    if (!st.rows && !st.loading) queueMicrotask(() => fetchScope('archived'));
    const rows = sortRows(asArr(st.rows), 'archived');
    _rowsForClick.archived = rows;
    return `
      ${kpisArchive(rows)}
      ${toolbar('archived')}
      ${st.error ? errBlk(st.error)
        : (st.loading && !st.rows) ? skel(4)
        : onbTable(rows, 'archived', '__onbRowClickArchived')}`;
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
