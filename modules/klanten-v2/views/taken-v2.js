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

  // ── State per tab-scope ────────────────────────────────────────────────
  // 'mine' = scope=mine (mijn taken); 'byMe' = scope=assigned_by_me.
  // "Afgerond"-tab herbruikt 'mine'-fetch (filter client-side status=done).
  const _live = {
    mine: { loading: false, error: null, taken: null, seq: 0, params: '' },
    byMe: { loading: false, error: null, taken: null, seq: 0, params: '' },
  };

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
  async function fetchScope(scope) {
    const st = _live[scope];
    if (st.loading) return;
    const seq = ++st.seq;
    st.loading = true; st.error = null;
    const url = '/api/taken?scope=' + (scope === 'byMe' ? 'assigned_by_me' : 'mine');
    const data = await tryFetch('taken:' + scope, url);
    if (seq !== st.seq) return;
    st.taken = data && Array.isArray(data.taken) ? data.taken : [];
    st.error = data ? null : 'Kon taken niet laden';
    st.loading = false;
    if (window.DFO && window.DFO.render) window.DFO.render();
  }
  function refetchAll() {
    _live.mine.taken = null; _live.byMe.taken = null;
    fetchScope('mine'); fetchScope('byMe');
  }

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
  const PRIO_ORDER = { Urgent: 4, Hoog: 3, Normaal: 2, Laag: 1 };
  function sortRows(rows, key) {
    const arr = rows.slice();
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

  // ── Client-side search (stableSearch) ─────────────────────────────────
  function applySearch(rows, tabKey) {
    if (typeof H.stableSearch === 'function') {
      return H.stableSearch(rows, tabKey, (t) => `${t.titel || ''} ${t.omschrijving || ''} ${t.assigned_to_name || ''} ${t.categorie || ''}`);
    }
    return rows;
  }

  // ── Table renderer ────────────────────────────────────────────────────
  function takenTable(rows) {
    if (!rows.length) return emptyBlock('Geen taken', 'Er zijn geen taken die aan de huidige filters voldoen.');
    return H.table(
      [
        { l: 'Titel' },
        { l: 'Categorie', cls: 'optional' },
        { l: 'Toegewezen', cls: 'optional' },
        { l: 'Deadline', cls: 'optional' },
        { l: 'Prio' },
        { l: 'Status', cls: 'optional' },
      ],
      rows.map((t) => [
        `<span class="cell-main">${H.esc ? H.esc(t.titel) : (t.titel || '—')}</span>`,
        `<span style="color:var(--text-2);font-size:12.5px">${t.categorie || '—'}</span>`,
        `<span style="font-size:12.5px">${t.assigned_to_name || (t.assigned_to_id ? '#' + String(t.assigned_to_id).slice(0, 6) : '—')}</span>`,
        `<span class="mono" style="color:var(--text-3);font-size:12.5px">${t.deadline ? new Date(t.deadline).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }) : '—'}</span>`,
        prioPill(t.prioriteit),
        statusPill(t.status),
      ]),
      '__takenOpen'
    );
  }

  // ── Toolbar ────────────────────────────────────────────────────────────
  function toolbar(tabKey) {
    const sortKey = F('tk-sort', 'created');
    return H.toolbar([
      H.chips('tk-sort', [
        { l: 'Nieuwste', v: 'created' },
        { l: 'Deadline', v: 'deadline' },
        { l: 'Prioriteit', v: 'prio' },
      ], sortKey),
      H.search('Zoek taak / assignee / categorie…'),
      `<div class="tb-right"><button class="btn btn-primary" onclick="__takenNew()">${svg(I.plus)}Nieuwe taak</button></div>`,
    ]);
  }

  // ── KPI-strip ──────────────────────────────────────────────────────────
  function kpisMijn(all) {
    const open = all.filter((t) => t.status !== 'done');
    const vandaag = open.filter((t) => t.deadline && new Date(t.deadline).toDateString() === new Date().toDateString()).length;
    const teLaat = open.filter((t) => t.deadline && new Date(t.deadline).getTime() < Date.now()).length;
    return H.kpis([
      { c: 'blue',    icon: I.check2, label: 'Open taken',          val: String(open.length), hi: 1, sub: vandaag + ' vandaag' },
      { c: 'rose',    icon: I.alert,  label: 'Te laat',             val: String(teLaat),                                    sub: 'deadline verstreken' },
      { c: 'emerald', icon: I.tick,   label: 'Afgerond (in scope)', val: String(all.filter((t) => t.status === 'done').length),        sub: 'lifetime' },
    ]);
  }
  function kpisByMe(all) {
    const open = all.filter((t) => t.status !== 'done');
    const teLaat = open.filter((t) => t.deadline && new Date(t.deadline).getTime() < Date.now()).length;
    return H.kpis([
      { c: 'blue',    icon: I.check2, label: 'Uitgezet & open',     val: String(open.length), hi: 1 },
      { c: 'rose',    icon: I.alert,  label: 'Te laat',             val: String(teLaat),                                    sub: 'deadline verstreken' },
      { c: 'emerald', icon: I.tick,   label: 'Afgerond',            val: String(all.filter((t) => t.status === 'done').length),        sub: 'lifetime' },
    ]);
  }
  function kpisAfgerond(rows) {
    const week = rows.filter((t) => t.afgerond_op && (Date.now() - new Date(t.afgerond_op).getTime()) < 7 * 86400e3).length;
    return H.kpis([
      { c: 'emerald', icon: I.tick, label: 'Afgerond totaal', val: String(rows.length), hi: 1, sub: 'in mijn scope' },
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
    // Voor kanban tonen we alle taken uit de actieve tab. Voor "Afgerond"
    // filteren we niet — de kanban toont alle 3 kolommen ongeacht tab-filter.
    const scope = currentScope();
    return _live[scope]?.taken || [];
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
        // Optimistic mutatie in alle scope-caches.
        for (const key of Object.keys(_live)) {
          const arr = _live[key]?.taken;
          if (!arr) continue;
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
    if (!st.taken && !st.loading) queueMicrotask(() => fetchScope(scope));
    return `${viewToggle()}
      ${window.KV_V2.kanban ? window.KV_V2.kanban.html('taken') : '<div class="sv-empty">Kanban laden…</div>'}
      ${st.error ? errorBlock(st.error) : ''}`;
  }

  // ── Per-tab views ─────────────────────────────────────────────────────
  function mijnView() {
    const st = _live.mine;
    if (!st.taken && !st.loading) queueMicrotask(() => fetchScope('mine'));
    const all = st.taken || [];
    const searched = applySearch(all, 'taken:mine');
    const rows = sortRows(searched, F('tk-sort', 'created'));
    return `
      ${kpisMijn(all)}
      ${toolbar('mine')}
      ${st.error ? errorBlock(st.error)
        : (st.loading && !st.taken) ? skeletonTable(6)
        : takenTable(rows)}`;
  }

  function byMeView() {
    const st = _live.byMe;
    if (!st.taken && !st.loading) queueMicrotask(() => fetchScope('byMe'));
    const all = st.taken || [];
    const searched = applySearch(all, 'taken:byMe');
    const rows = sortRows(searched, F('tk-sort', 'created'));
    return `
      ${kpisByMe(all)}
      ${toolbar('byMe')}
      ${st.error ? errorBlock(st.error)
        : (st.loading && !st.taken) ? skeletonTable(6)
        : takenTable(rows)}`;
  }

  function afgerondView() {
    const st = _live.mine;
    if (!st.taken && !st.loading) queueMicrotask(() => fetchScope('mine'));
    const all = st.taken || [];
    // FIX: filter op canonieke 'done' i.p.v. legacy 'klaar'.
    const done = all.filter((t) => t.status === 'done');
    const searched = applySearch(done, 'taken:afgerond');
    // Sort: nieuwste afgerond eerst.
    const rows = searched.slice().sort((a, b) => new Date(b.afgerond_op || 0).getTime() - new Date(a.afgerond_op || 0).getTime());
    return `
      ${kpisAfgerond(done)}
      ${H.toolbar([H.search('Zoek afgeronde taak…')])}
      ${st.error ? errorBlock(st.error)
        : (st.loading && !st.taken) ? skeletonTable(4)
        : rows.length ? H.table(
            [{ l: 'Titel' }, { l: 'Categorie', cls: 'optional' }, { l: 'Toegewezen', cls: 'optional' }, { l: 'Afgerond op', cls: 'r' }],
            rows.map((t) => [
              `<span class="cell-main">${t.titel || '—'}</span>`,
              `<span style="color:var(--text-2);font-size:12.5px">${t.categorie || '—'}</span>`,
              `<span style="font-size:12.5px">${t.assigned_to_name || '—'}</span>`,
              `<span class="mono" style="color:var(--text-3);font-size:12px">${t.afgerond_op ? new Date(t.afgerond_op).toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}</span>`,
            ]),
            '__takenOpen'
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
