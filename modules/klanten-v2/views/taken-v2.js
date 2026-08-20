// modules/klanten-v2/views/taken-v2.js
//
// Data-ronde — volledige v1-parity + v2-design.
// Tabs: "Mijn taken" (scope=mine), "Toegewezen door mij" (scope=assigned_by_me),
//       "Afgerond" (scope=mine, client-filter status=done).
// View-toggle Lijst ↔ Pipeline per tab.
// Create + detail via dynamic import naar modals/{taken-create,taken-detail}.js.
//
// Endpoints (allemaal bestaand + 2 nieuwe GET-methods):
//   GET   /api/taken?scope=mine|assigned_by_me   — lijst
//   POST  /api/taken {task}                       — create/upsert
//   POST  /api/taken {action:status_change, id, status}
//   POST  /api/taken {action:delete, id}
//   GET   /api/taken-comments?task_id             — reacties
//   POST  /api/taken-comments                     — reactie plaatsen
//   GET   /api/taken-watchers?task_id             — watcher-lijst (NIEUW deze ronde)
//   POST  /api/taken-watchers                     — watcher toevoegen
//   DELETE/api/taken-watchers?id                  — watcher verwijderen
//   GET   /api/taken-attachments?task_id          — bijlage-lijst (NIEUW deze ronde)
//   POST  /api/taken-attachments                  — bijlage toevoegen (storage_path of external_url)
//   DELETE/api/taken-attachments?id               — bijlage verwijderen
//
// Prioriteiten: Urgent / Hoog / Normaal / Laag (v1-format, 1-op-1 met backend).
// Statussen: todo / progress / done (canoniek, backend VALID_TASK_STATUSES).
// Fail-soft: 8s timeout per fetch, geen retry-storm, error-block bij fail.

(function () {
  if (!window.DFO) { console.error('[taken-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[taken-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, F } = window.DFO;
  const H = window.KV_V2.helpers;

  // Defensieve array-guard: gebruikt overal waar we .filter/.sort/.slice
  // aanroepen. Onverwachte response-shape → lege lijst i.p.v. TypeError.
  const asArr = (x) => Array.isArray(x) ? x : [];

  // HTML-escape voor tekst-cellen. H.esc bestaat niet als export; lokale
  // helper met dezelfde 5-char replace als in de andere v2-views.
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // ── State per tab-scope ────────────────────────────────────────────────
  // 'mine' = scope=mine (mijn taken); 'byMe' = scope=assigned_by_me.
  // "Afgerond"-tab herbruikt 'mine'-fetch (filter client-side status=done).
  const _live = {
    mine: { loading: false, error: null, taken: null, seq: 0, params: '' },
    byMe: { loading: false, error: null, taken: null, seq: 0, params: '' },
  };

  // stableSearch onSearch-handlers idempotent registreren (H.onSearch
  // overschrijft handler op zelfde key). Doen we bij eerste view-mount
  // per tab zodat cursor + input-value overleven DFO.render()-swaps.
  const _searchWired = new Set();
  function wireSearch(key) {
    if (_searchWired.has(key)) return;
    if (H.onSearch) {
      H.onSearch(key, () => {
        if (window.DFO && window.DFO.render) window.DFO.render();
      });
      _searchWired.add(key);
    }
  }
  function currentSearch(key) {
    return H.getSearchValue ? String(H.getSearchValue(key) || '').trim().toLowerCase() : '';
  }

  // ── tryFetch met 8s timeout ────────────────────────────────────────────
  async function tryFetch(label, url, timeoutMs = 8000) {
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      return await Promise.race([
        window.KV.authedJson(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) {
      console.warn('[taken-v2] ' + label + ' fetch fail:', e && e.message);
      return null;
    }
  }

  // ── Fetch met sequence-guard ──────────────────────────────────────────
  // Response-shape (bron: api/taken.js:192): { taken: [...] } — array zit
  // ALTIJD in `taken`-veld. Guard met Array.isArray voor onverwachte
  // shapes (bv. 500-error die HTML terugkaatst of proxy die shape wijzigt).
  async function fetchScope(scope) {
    const st = _live[scope];
    if (st.loading) return;
    const seq = ++st.seq;
    st.loading = true; st.error = null;
    const url = '/api/taken?scope=' + (scope === 'byMe' ? 'assigned_by_me' : 'mine');
    const data = await tryFetch('taken:' + scope, url);
    if (seq !== st.seq) return;
    st.taken = asArr(data && data.taken);
    st.error = data ? null : 'Kon taken niet laden';
    st.loading = false;
    if (window.DFO && window.DFO.render) window.DFO.render();
  }
  function refetchAll() {
    _live.mine.taken = null; _live.byMe.taken = null;
    fetchScope('mine'); fetchScope('byMe');
  }

  // ── Row-click cache (sales-v2 pattern) ─────────────────────────────────
  // H.table's 3e arg triggert onclick(rowIndex), niet id. Om de hele rij
  // klikbaar te maken bewaren we de zichtbare (post-filter/sort) rows per
  // tab, en resolvet de row-click-handler index → row.id → __takenOpen.
  const _rowsForClick = { mine: [], byMe: [], afgerond: [] };
  window.__takenRowClickMine     = (i) => { const r = _rowsForClick.mine[i];     if (r && r.id) window.__takenOpen(r.id); };
  window.__takenRowClickByMe     = (i) => { const r = _rowsForClick.byMe[i];     if (r && r.id) window.__takenOpen(r.id); };
  window.__takenRowClickAfgerond = (i) => { const r = _rowsForClick.afgerond[i]; if (r && r.id) window.__takenOpen(r.id); };

  // ── Handlers (dynamic import naar modals) ───────────────────────────────
  window.__takenOpen = async (id) => {
    try {
      const mod = await import('./modals/taken-detail.js');
      mod.openTakenDetailModal({ taskId: id, onSuccess: refetchAll });
    } catch (e) { console.error('[taken-v2] detail-modal load fail:', e); window.KV?.toast?.('Kon detail-modal niet laden'); }
  };
  window.__takenNew = async () => {
    try {
      const mod = await import('./modals/taken-create.js');
      mod.openTakenCreateModal({ mode: 'create', onSuccess: refetchAll });
    } catch (e) { console.error('[taken-v2] create-modal load fail:', e); window.KV?.toast?.('Kon nieuw-taak-modal niet laden'); }
  };

  // ── Prio-pill + status-pill ────────────────────────────────────────────
  const PRIO_TO_PILL = {
    Urgent:  ['danger',  'Urgent'],
    Hoog:    ['warn',    'Hoog'],
    Normaal: ['info',    'Normaal'],
    Laag:    ['neutral', 'Laag'],
  };
  const STATUS_TO_PILL = {
    todo:     ['warn', 'Open'],
    progress: ['info', 'Bezig'],
    done:     ['ok',   'Klaar'],
  };
  const prioPill = (p) => {
    const [c, l] = PRIO_TO_PILL[p] || ['neutral', p || 'Normaal'];
    return H.pill(c, l);
  };
  const statusPill = (s) => {
    const [c, l] = STATUS_TO_PILL[s] || ['neutral', s || '—'];
    return H.pill(c, l);
  };

  // ── previewHeader — leeg (fail-soft: geen preview-strip meer) ─────────
  function previewHeader() { return ''; }

  // ── Skeleton ──────────────────────────────────────────────────────────
  function skeletonTable(n = 5) {
    return `<div class="tbl-wrap"><table><thead><tr>
      <th>Titel</th><th>Categorie</th><th>Toegewezen</th><th>Deadline</th><th>Prio</th><th>Status</th></tr></thead>
      <tbody>${Array.from({ length: n }).map(() => `<tr style="opacity:.55">
        ${Array.from({ length: 6 }).map(() => `<td><div style="height:12px;background:var(--surface-2);border-radius:4px;width:${60 + Math.floor(Math.random() * 30)}%"></div></td>`).join('')}
      </tr>`).join('')}</tbody></table></div>`;
  }
  const errorBlock = (msg) => `<div style="margin:20px;padding:14px 18px;border:1px solid var(--rose-line);background:var(--rose-soft);border-radius:var(--r);color:var(--rose);font-size:13px">⚠ Kon taken niet ophalen: ${msg}</div>`;
  const emptyBlock = (t, s) => `<div class="empty"><div class="empty-ico">${svg(I.check2)}</div><div class="empty-t">${t}</div><div class="empty-s">${s}</div></div>`;

  // ── Sort helpers ──────────────────────────────────────────────────────
  // asArr()-guard voorkomt TypeError als caller per ongeluk non-array
  // doorgeeft (bv. de vorige bug: applySearch retourneerde per ongeluk
  // een stableSearch mount-HTML string i.p.v. gefilterde array).
  const PRIO_ORDER = { Urgent: 4, Hoog: 3, Normaal: 2, Laag: 1 };
  function sortRows(rows, key) {
    const arr = asArr(rows).slice();
    if (key === 'deadline') {
      arr.sort((a, b) => {
        const da = a.deadline ? new Date(a.deadline).getTime() : Infinity;
        const db = b.deadline ? new Date(b.deadline).getTime() : Infinity;
        return da - db;
      });
    } else if (key === 'prio') {
      arr.sort((a, b) => (PRIO_ORDER[b.prioriteit] || 0) - (PRIO_ORDER[a.prioriteit] || 0));
    } else {
      // default: aangemaakt DESC
      arr.sort((a, b) => new Date(b.aangemaakt || 0).getTime() - new Date(a.aangemaakt || 0).getTime());
    }
    return arr;
  }

  // ── Client-side search-filter ─────────────────────────────────────────
  // stableSearch registreert alleen input-DOM + returnt mount-HTML. Filter-
  // logica is per view zelf — we lezen de current value via getSearchValue
  // en doen een lowercase substring-match op titel/omschrijving/assignee/
  // categorie. Vorige bug: applySearch(rows, key) riep stableSearch(rows,...)
  // aan met de array als key → retour = string → .slice() crashte.
  function filterBySearch(rows, key) {
    const q = currentSearch(key);
    if (!q) return asArr(rows);
    return asArr(rows).filter((t) => {
      const hay = [
        t.titel, t.omschrijving, t.assigned_to_name, t.categorie,
      ].map((v) => String(v == null ? '' : v).toLowerCase()).join(' ');
      return hay.includes(q);
    });
  }

  // ── Table renderer ────────────────────────────────────────────────────
  // handlerName = window-functie die (rowIndex) → row.id resolvet via
  // _rowsForClick-cache. Zie sales-v2 __svOfferteRowClick-patroon. Titel-cel
  // krijgt .kv-tk-title styling maar GEEN eigen onclick (rij-onclick werkt
  // globaal); dat voorkomt dubbele triggers.
  function takenTable(rows, handlerName) {
    const list = asArr(rows);
    if (!list.length) return emptyBlock('Geen taken', 'Er zijn geen taken die aan de huidige filters voldoen.');
    return H.table(
      [
        { l: 'Titel' },
        { l: 'Categorie', cls: 'optional' },
        { l: 'Toegewezen', cls: 'optional' },
        { l: 'Deadline', cls: 'optional' },
        { l: 'Prio' },
        { l: 'Status', cls: 'optional' },
      ],
      list.map((t) => [
        `<span class="kv-tk-title">${esc(t.titel) || '—'}</span>`,
        `<span style="color:var(--text-2);font-size:12.5px">${esc(t.categorie) || '—'}</span>`,
        `<span style="font-size:12.5px">${esc(t.assigned_to_name) || (t.assigned_to_id ? '#' + String(t.assigned_to_id).slice(0, 6) : '—')}</span>`,
        `<span class="mono" style="color:var(--text-3);font-size:12.5px">${t.deadline ? new Date(t.deadline).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }) : '—'}</span>`,
        prioPill(t.prioriteit),
        statusPill(t.status),
      ]),
      handlerName
    );
  }

  // ── Toolbar ────────────────────────────────────────────────────────────
  // stableSearch(key, placeholder) — RONDE 4 pattern (2 args): returnt
  // mount-slot HTML; input-DOM overleeft DFO.render() zodat cursor + value
  // bewaard blijven. Filter-logica leest H.getSearchValue(key) in view.
  function toolbar(searchKey) {
    const sortKey = F('tk-sort', 'created');
    const searchHtml = H.stableSearch
      ? H.stableSearch(searchKey, 'Zoek taak / assignee / categorie…')
      : H.search('Zoek taak / assignee / categorie…');
    return H.toolbar([
      H.chips('tk-sort', [
        { l: 'Nieuwste', v: 'created' },
        { l: 'Deadline', v: 'deadline' },
        { l: 'Prioriteit', v: 'prio' },
      ], sortKey),
      searchHtml,
      `<div class="tb-right"><button class="btn btn-primary" onclick="__takenNew()">${svg(I.plus)}Nieuwe taak</button></div>`,
    ]);
  }

  // ── KPI-strip ──────────────────────────────────────────────────────────
  // Alle .filter() calls door asArr() geguard zodat onverwachte data-shape
  // nooit meer een TypeError kan opleveren.
  function kpisMijn(all) {
    const list = asArr(all);
    const open = list.filter((t) => t.status !== 'done');
    const vandaag = open.filter((t) => t.deadline && new Date(t.deadline).toDateString() === new Date().toDateString()).length;
    const teLaat = open.filter((t) => t.deadline && new Date(t.deadline).getTime() < Date.now()).length;
    return H.kpis([
      { c: 'blue',    icon: I.check2, label: 'Open taken',          val: String(open.length), hi: 1, sub: vandaag + ' vandaag' },
      { c: 'rose',    icon: I.alert,  label: 'Te laat',             val: String(teLaat),                                    sub: 'deadline verstreken' },
      { c: 'emerald', icon: I.tick,   label: 'Afgerond (in scope)', val: String(list.filter((t) => t.status === 'done').length),        sub: 'lifetime' },
    ]);
  }
  function kpisByMe(all) {
    const list = asArr(all);
    const open = list.filter((t) => t.status !== 'done');
    const teLaat = open.filter((t) => t.deadline && new Date(t.deadline).getTime() < Date.now()).length;
    return H.kpis([
      { c: 'blue',    icon: I.check2, label: 'Uitgezet & open',     val: String(open.length), hi: 1 },
      { c: 'rose',    icon: I.alert,  label: 'Te laat',             val: String(teLaat),                                    sub: 'deadline verstreken' },
      { c: 'emerald', icon: I.tick,   label: 'Afgerond',            val: String(list.filter((t) => t.status === 'done').length),        sub: 'lifetime' },
    ]);
  }
  function kpisAfgerond(rows) {
    const list = asArr(rows);
    const week = list.filter((t) => t.afgerond_op && (Date.now() - new Date(t.afgerond_op).getTime()) < 7 * 86400e3).length;
    return H.kpis([
      { c: 'emerald', icon: I.tick, label: 'Afgerond totaal', val: String(list.length), hi: 1, sub: 'in mijn scope' },
      { c: 'blue',    icon: I.check2, label: 'Deze week',     val: String(week) },
    ]);
  }

  // ── View-toggle Lijst ↔ Pipeline ──────────────────────────────────────
  function viewToggle() {
    const cur = F('tk-view', 'list');
    return `<div style="padding:0 20px;margin-top:14px"><div class="kv-viewtoggle">
      <button class="${cur === 'list' ? 'on' : ''}" onclick="DFO.setF('tk-view','list')">${svg(I.list || I.doc)} Lijst</button>
      <button class="${cur === 'kanban' ? 'on' : ''}" onclick="DFO.setF('tk-view','kanban')">${svg(I.grid || I.settings)} Pipeline</button>
    </div></div>`;
  }

  // ── Kanban registratie (canonieke statuses) ────────────────────────────
  const TAKEN_KANBAN_STATUSES = [
    { key: 'todo',     label: 'Open',   color: 'rose'    },
    { key: 'progress', label: 'Bezig',  color: 'amber'   },
    { key: 'done',     label: 'Klaar',  color: 'emerald' },
  ];
  function currentScope() {
    const tab = window.DFO?.S?.tab;
    if (tab === 'Toegewezen door mij') return 'byMe';
    // Voor 'Afgerond' + 'Mijn taken': beide leunen op 'mine'-cache
    return 'mine';
  }
  function _allTakenItems() {
    // Tab-aware filter:
    //   - "Mijn taken" / "Toegewezen door mij" → toon alleen niet-afgeronde
    //     taken. Afgeronde items horen in het Afgerond-archief, niet in het
    //     actieve bord. Bij drag naar "Klaar"-kolom → onMove zet status →
    //     refetch → item verdwijnt uit de actieve kanban en verschijnt in
    //     Afgerond.
    //   - "Afgerond" → toon alleen done-items.
    const scope = currentScope();
    const list = asArr(_live[scope] && _live[scope].taken);
    const tab = window.DFO && window.DFO.S && window.DFO.S.tab;
    if (tab === 'Afgerond') return list.filter((t) => t.status === 'done');
    return list.filter((t) => t.status !== 'done');
  }
  if (window.KV_V2 && window.KV_V2.kanban) {
    window.KV_V2.kanban.register('taken', {
      statuses: TAKEN_KANBAN_STATUSES,
      getItems: _allTakenItems,
      // FIX: statusOf gebruikt canonieke DB-waarde (todo/progress/done).
      // Voorheen mapte de scaffold naar 'open/bezig/klaar' waardoor alle
      // items in een niet-bestaande bucket belandden en niet zichtbaar waren.
      statusOf: (t) => (['todo', 'progress', 'done'].includes(t.status) ? t.status : 'todo'),
      itemId: (t) => t.id,
      renderCard: (t) => {
        const p = PRIO_TO_PILL[t.prioriteit] || ['neutral', t.prioriteit || 'Normaal'];
        return `
          <div class="kv-kanban-card-title">${(t.titel || '(zonder titel)').replace(/</g, '&lt;')}</div>
          <div class="kv-kanban-card-sub">
            ${H.pill(p[0], p[1])}
            ${t.categorie ? `<span style="margin-left:6px; font-size:11px; color:var(--text-2);">${String(t.categorie).replace(/</g, '&lt;')}</span>` : ''}
          </div>
          <div class="kv-kanban-card-foot">
            ${t.deadline ? `deadline: ${new Date(t.deadline).toLocaleDateString('nl-NL', { day: '2-digit', month: '2-digit' })}` : '—'}
            <span style="margin-left:auto">${(t.assigned_to_name || '').split(' ')[0] || ''}</span>
          </div>`;
      },
      // Klik op kaart opent detail-modal.
      onCardClick: (t) => window.__takenOpen && window.__takenOpen(t.id),
      onMove: async (id, newStatus) => {
        // No-op guard: als de kaart in dezelfde kolom wordt losgelaten, geen
        // write en geen optimistic update. Bepaal huidige status via lookup
        // over alle scope-caches.
        let currentStatus = null;
        for (const key of Object.keys(_live)) {
          const arr = asArr(_live[key] && _live[key].taken);
          const t = arr.find((x) => x.id === id);
          if (t) { currentStatus = t.status; break; }
        }
        if (currentStatus != null && String(currentStatus) === String(newStatus)) {
          return; // zelfde kolom → niks doen
        }
        // Optimistic mutatie in alle scope-caches (met asArr-guard).
        for (const key of Object.keys(_live)) {
          const arr = asArr(_live[key] && _live[key].taken);
          if (!arr.length) continue;
          const t = arr.find((x) => x.id === id);
          if (t) t.status = newStatus;
        }
        if (window.DFO?.render) window.DFO.render();
        if (!window.KV?.authedFetch) {
          console.warn('[taken-v2 kanban] KV.authedFetch niet beschikbaar');
          return;
        }
        try {
          const resp = await window.KV.authedFetch('/api/taken', {
            method: 'POST',
            body: JSON.stringify({ action: 'status_change', id, status: newStatus }),
          });
          if (!resp.ok && resp.status !== 204) {
            const t = await resp.text();
            const j = t ? (function () { try { return JSON.parse(t); } catch { return null; } })() : null;
            throw new Error(j?.error || 'HTTP ' + resp.status);
          }
        } catch (e) {
          console.warn('[taken-v2 kanban] status_change fail:', e?.message);
          // Rollback via refetch (server-waarheid wint).
          refetchAll();
          throw e;
        }
      },
    });
  }

  function kanbanView() {
    const scope = currentScope();
    const st = _live[scope];
    if (!st.taken && !st.loading && !st.error) queueMicrotask(() => fetchScope(scope));
    return `${viewToggle()}
      ${window.KV_V2.kanban ? window.KV_V2.kanban.html('taken') : '<div class="sv-empty">Kanban laden…</div>'}
      ${st.error ? errorBlock(st.error) : ''}`;
  }

  // ── Per-tab views ─────────────────────────────────────────────────────
  // Elke view:
  //   1) wireSearch(key) — registreer onSearch → DFO.render bij typen.
  //   2) filterBySearch(rows, key) — leest getSearchValue, doet lowercase match.
  //   3) sortRows(rows, sortKey) — asArr-geguard.
  function mijnView() {
    wireSearch('taken:mine');
    const st = _live.mine;
    if (!st.taken && !st.loading && !st.error) queueMicrotask(() => fetchScope('mine'));
    // `all` blijft raw (nodig voor KPI-strip die zelf open+afgerond telt).
    // `open` = alleen niet-afgeronde taken → dat is wat de lijst toont.
    // Afgeronde taken verhuizen naar de "Afgerond"-tab (archief).
    const all = asArr(st.taken);
    const open = all.filter((t) => t.status !== 'done');
    const rows = sortRows(filterBySearch(open, 'taken:mine'), F('tk-sort', 'created'));
    _rowsForClick.mine = rows;
    return `
      ${kpisMijn(all)}
      ${toolbar('taken:mine')}
      ${st.error ? errorBlock(st.error)
        : (st.loading && !st.taken) ? skeletonTable(6)
        : takenTable(rows, '__takenRowClickMine')}`;
  }

  function byMeView() {
    wireSearch('taken:byMe');
    const st = _live.byMe;
    if (!st.taken && !st.loading && !st.error) queueMicrotask(() => fetchScope('byMe'));
    // Zie mijnView: raw voor KPI, gefilterd voor lijst.
    const all = asArr(st.taken);
    const open = all.filter((t) => t.status !== 'done');
    const rows = sortRows(filterBySearch(open, 'taken:byMe'), F('tk-sort', 'created'));
    _rowsForClick.byMe = rows;
    return `
      ${kpisByMe(all)}
      ${toolbar('taken:byMe')}
      ${st.error ? errorBlock(st.error)
        : (st.loading && !st.taken) ? skeletonTable(6)
        : takenTable(rows, '__takenRowClickByMe')}`;
  }

  function afgerondView() {
    wireSearch('taken:afgerond');
    const st = _live.mine;
    if (!st.taken && !st.loading && !st.error) queueMicrotask(() => fetchScope('mine'));
    const all = asArr(st.taken);
    // FIX: filter op canonieke 'done' i.p.v. legacy 'klaar'.
    const done = all.filter((t) => t.status === 'done');
    const searched = filterBySearch(done, 'taken:afgerond');
    // Sort: nieuwste afgerond eerst.
    const rows = searched.slice().sort((a, b) => new Date(b.afgerond_op || 0).getTime() - new Date(a.afgerond_op || 0).getTime());
    _rowsForClick.afgerond = rows;
    const searchHtml = H.stableSearch
      ? H.stableSearch('taken:afgerond', 'Zoek afgeronde taak…')
      : H.search('Zoek afgeronde taak…');
    return `
      ${kpisAfgerond(done)}
      ${H.toolbar([searchHtml])}
      ${st.error ? errorBlock(st.error)
        : (st.loading && !st.taken) ? skeletonTable(4)
        : rows.length ? H.table(
            [{ l: 'Titel' }, { l: 'Categorie', cls: 'optional' }, { l: 'Toegewezen', cls: 'optional' }, { l: 'Afgerond op', cls: 'r' }],
            rows.map((t) => [
              `<span class="kv-tk-title">${esc(t.titel) || '—'}</span>`,
              `<span style="color:var(--text-2);font-size:12.5px">${esc(t.categorie) || '—'}</span>`,
              `<span style="font-size:12.5px">${esc(t.assigned_to_name) || '—'}</span>`,
              `<span class="mono" style="color:var(--text-3);font-size:12px">${t.afgerond_op ? new Date(t.afgerond_op).toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}</span>`,
            ]),
            '__takenRowClickAfgerond'
          )
        : emptyBlock('Nog niets afgerond', 'Zodra taken op "Klaar" worden gezet verschijnen ze hier.')}`;
  }

  // ── Wrap voor view-toggle ─────────────────────────────────────────────
  function wrapView(fn) {
    return function () {
      if (F('tk-view', 'list') === 'kanban') return kanbanView();
      return viewToggle() + fn();
    };
  }

  // ── Registratie ───────────────────────────────────────────────────────
  window.DFO.VIEWS['taken/Mijn taken']           = wrapView(mijnView);
  window.DFO.VIEWS['taken/Toegewezen door mij']  = wrapView(byMeView);
  window.DFO.VIEWS['taken/Afgerond']             = wrapView(afgerondView);

  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('taken');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('taken');

  console.debug('[taken-v2] registered VIEWS[Mijn taken / Toegewezen door mij / Afgerond] + kanban + modals');
})();
