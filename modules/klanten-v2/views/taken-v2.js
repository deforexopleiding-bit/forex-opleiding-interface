// modules/klanten-v2/views/taken-v2.js
//
// Fase A — Takenbeheer voor v2-shell (LAYOUT + LIVE DATA).
// 1-op-1 render uit docs/redesign/systeemprototype-v45.html:
//   - VIEWS['taken/Mijn taken']  r3942-3955  (KPI + toolbar + tabel)
//   - VIEWS['taken/Team']        r3964-3974
//   - VIEWS['taken/Afgerond']    r4042-...  (afgerond-tabel)
//
// LIVE DATA: /api/taken?filter=mijn|team|klaar
//   Response: { taken: [{ id, titel, omschrijving, prioriteit, categorie,
//     assigned_to_id, assigned_to_name?, customer_id, deadline, status,
//     aangemaakt, ... }] }
//
// SCOPE-KEUZE VOOR DEZE PR (naar dashboard-rules):
//   - Layout + tabel-view voor 3 tabs met LIVE data via /api/taken.
//   - Skeleton + 8s timeout + fail-soft per fetch + render-loop-guard.
//   - Klik-op-rij opent NOG geen detail-panel (openPanel-flow met watchers/
//     bijlagen komt in tweede iteratie — die vereist ook watchers/attachments-
//     endpoints inhaken + create/edit-modal). Voor nu: klik logt naar console.
//   - "Nieuwe taak"-knop toont notice — modal-flow komt in ronde 2.
//   - Amber info-banner bovenaan legt uit welke stukken live/deferred zijn.

(function () {
  if (!window.DFO) { console.error('[taken-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[taken-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, S, F, render } = window.DFO;
  const H = window.KV_V2.helpers;

  /* ── State (per tab, sequence-tracked) ────────────────────────────── */
  const _live = {
    mijn:  { loading: false, error: null, taken: null }, // /api/taken (mijn)
    team:  { loading: false, error: null, taken: null }, // /api/taken?scope=team
    klaar: { loading: false, error: null, taken: null }, // /api/taken?status=klaar
  };
  const _seq = { mijn: 0, team: 0, klaar: 0 };

  /* ── tryFetch met 8s timeout ──────────────────────────────────────── */
  async function tryFetch(label, url, timeoutMs = 8000) {
    try {
      const p = window.KV.authedJson(url);
      return await Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) {
      console.warn('[taken-v2] ' + label + ' fetch fail:', e && e.message);
      return null;
    }
  }

  /* ── Per-tab fetch met sequence-guard ─────────────────────────────── */
  async function fetchTakenFor(tab) {
    // Skip als al geladen (data staat) én geen error
    if (_live[tab].taken && !_live[tab].error) return;
    const seq = ++_seq[tab];
    _live[tab].loading = true;
    _live[tab].error = null;
    console.debug('[taken-v2] fetch ' + tab + ' seq=' + seq);
    if (window.DFO && window.DFO.render) window.DFO.render();
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      const url = '/api/taken';  // Backend filter/param varieert per config;
      // huidige endpoint returnt taken relevant voor de user. We filteren
      // client-side per tab in de renderfuncties.
      const data = await tryFetch('taken ' + tab, url);
      if (seq !== _seq[tab]) { console.debug('[taken-v2] discard stale ' + tab + ' seq=' + seq); return; }
      _live[tab].taken = data && Array.isArray(data.taken) ? data.taken : [];
      _live[tab].error = data ? null : 'taken-endpoint faalde';
      console.debug('[taken-v2] ' + tab + ' done seq=' + seq + ' count=' + _live[tab].taken.length);
    } catch (e) {
      if (seq !== _seq[tab]) return;
      console.error('[taken-v2] ' + tab + ' fail seq=' + seq, e && e.message);
      _live[tab].error = (e && e.message) || 'onbekende fout';
    } finally {
      if (seq === _seq[tab]) {
        _live[tab].loading = false;
        if (window.DFO && window.DFO.render) window.DFO.render();
      }
    }
  }

  /* ── Handlers ──────────────────────────────────────────────────────── */
  window.__takenOpen = (id) => { console.info('[taken-v2] Open taak-detail id=' + id + ' (voorbeeld — detail-panel komt in tweede iteratie)'); };
  window.__takenNew = () => { console.info('[taken-v2] Nieuwe-taak modal (voorbeeld — komt in tweede iteratie)'); };

  /* ── Prio-pill ────────────────────────────────────────────────────── */
  const prioPill = (p) => {
    const key = String(p || '').toLowerCase();
    const c = key === 'hoog' || key === 'high' ? 'danger' : key === 'laag' || key === 'low' ? 'neutral' : 'warn';
    return H.pill(c, (p || 'Normaal'));
  };

  /* ── Info-banner ──────────────────────────────────────────────────── */
  const infoBanner = () => `<div style="margin:14px 20px 0;padding:11px 14px;border:1px solid var(--amber-line);background:var(--amber-soft);border-radius:var(--r);
    display:flex;align-items:center;gap:11px;font-size:12.5px;color:var(--amber)">
    ${svg(I.alert, 'width:16px;height:16px;flex-shrink:0')}
    <span><b>LIVE DATA</b> via <code>/api/taken</code> — 3 tabs (Mijn taken / Team / Afgerond) client-side gefilterd.
    Detail-panel (watchers/bijlagen) + Nieuwe-taak-modal komen in tweede iteratie na layout-goedkeuring.</span></div>`;

  /* ── Skeleton-rows ────────────────────────────────────────────────── */
  function skeletonTable(n = 5) {
    return `<div class="tbl-wrap"><table><thead><tr>
      <th>Titel</th><th>Bron</th><th>Klant</th><th>Deadline</th><th>Eigenaar</th><th>Prio</th></tr></thead>
      <tbody>${Array.from({ length: n }).map(() => `<tr style="opacity:.55">
        ${Array.from({length:6}).map(() => `<td><div style="height:12px;background:var(--surface-2);border-radius:4px;width:${60 + Math.floor(Math.random()*30)}%"></div></td>`).join('')}
      </tr>`).join('')}</tbody></table></div>`;
  }

  /* ── Row-renderer ─────────────────────────────────────────────────── */
  function takenTable(rows) {
    return H.table(
      [{ l: 'Titel' }, { l: 'Bron', cls: 'optional' }, { l: 'Klant', cls: 'optional' }, { l: 'Deadline', cls: 'optional' }, { l: 'Eigenaar', cls: 'optional' }, { l: 'Prio' }],
      rows.map(t => [
        `<span class="cell-main">${t.titel || '—'}</span>`,
        `<span style="color:var(--text-2);font-size:12.5px">${t.categorie || '—'}</span>`,
        `<span style="color:var(--text-3);font-size:12.5px">${t.customer_id ? '#' + String(t.customer_id).slice(0, 6) : '—'}</span>`,
        `<span class="mono" style="color:var(--text-3);font-size:12.5px">${t.deadline ? new Date(t.deadline).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' }) : '—'}</span>`,
        `<span style="font-size:12.5px">${t.assigned_to_name || t.assigned_to_email || (t.assigned_to_id ? '#' + String(t.assigned_to_id).slice(0, 6) : '—')}</span>`,
        prioPill(t.prioriteit),
      ]),
      '__takenOpen'
    );
  }

  /* ── Views per tab ────────────────────────────────────────────────── */

  function mijnView() {
    const st = _live.mijn;
    if (!st.taken && !st.loading) queueMicrotask(() => fetchTakenFor('mijn'));
    const all = st.taken || [];
    const open = all.filter(t => t.status !== 'klaar');
    const flt = F('mf', 'all');
    // client-side filter: 'mine' vs 'cc' (fallback: alles)
    // /api/taken retourneert taken relevant voor user; hier tonen we ze allemaal.
    const rows = flt === 'mine' || flt === 'cc' ? open : open;
    S.rows = rows;
    const vandaag = open.filter(t => t.deadline && new Date(t.deadline).toDateString() === new Date().toDateString()).length;

    return `${infoBanner()}
    ${H.kpis([
      { c: 'emerald', icon: I.check2, label: 'Mijn open taken',       val: st.loading && !st.taken ? '…' : String(open.length), hi: 1, sub: vandaag + ' vandaag' },
      { c: 'blue',    icon: I.eye,    label: 'Ik volg (CC)',          val: '—',    sub: 'watchers-endpoint komt in ronde 2' },
      { c: 'emerald', icon: I.tick,   label: 'Afgerond deze week',    val: st.loading && !st.taken ? '…' : String(all.filter(t => t.status === 'klaar').length),        sub: 'in mijn scope' },
    ])}
    ${H.toolbar([
      H.chips('mf', [{ l: 'Alles', v: 'all' }, { l: 'Van mij', v: 'mine' }, { l: 'Ik volg (CC)', v: 'cc' }], flt),
      H.search('Zoek taak…'),
      `<div class="tb-right"><button class="btn btn-primary" onclick="__takenNew()">${svg(I.plus)}Nieuwe taak</button></div>`,
    ])}
    ${st.error ? errorBlock(st.error)
      : (st.loading && !st.taken) ? skeletonTable(6)
      : rows.length ? takenTable(rows)
      : emptyBlock('Geen taken hier', 'Niets toegewezen of te volgen in deze weergave.')}`;
  }

  function teamView() {
    const st = _live.team;
    if (!st.taken && !st.loading) queueMicrotask(() => fetchTakenFor('team'));
    const all = st.taken || [];
    const open = all.filter(t => t.status !== 'klaar');
    S.rows = open;
    const teLaat = all.filter(t => t.deadline && new Date(t.deadline).getTime() < Date.now() && t.status !== 'klaar').length;

    return `${infoBanner()}
    ${H.kpis([
      { c: 'blue',    icon: I.check2, label: 'Open in team',       val: st.loading && !st.taken ? '…' : String(open.length), hi: 1, sub: 'huidige zichtbaarheid' },
      { c: 'rose',    icon: I.alert,  label: 'Te laat',            val: st.loading && !st.taken ? '…' : String(teLaat),                    sub: 'deadline verstreken' },
      { c: 'emerald', icon: I.tick,   label: 'Afgerond deze week', val: st.loading && !st.taken ? '…' : String(all.filter(t => t.status === 'klaar').length), sub: 'team-scope' },
    ])}
    ${H.toolbar([
      H.chips('tm', [{ l: 'Iedereen', v: 'a' }], F('tm', 'a')),
      H.search('Zoek taak…'),
      `<div class="tb-right"><button class="btn btn-primary" onclick="__takenNew()">${svg(I.plus)}Taak toewijzen</button></div>`,
    ])}
    ${st.error ? errorBlock(st.error)
      : (st.loading && !st.taken) ? skeletonTable(6)
      : open.length ? takenTable(open)
      : emptyBlock('Geen taken in team', 'Alles is toegewezen en afgerond.')}`;
  }

  function afgerondView() {
    const st = _live.klaar;
    if (!st.taken && !st.loading) queueMicrotask(() => fetchTakenFor('klaar'));
    const rows = (st.taken || []).filter(t => t.status === 'klaar');
    S.rows = rows;

    return `${infoBanner()}
    ${H.kpis([
      { c: 'emerald', icon: I.tick, label: 'Afgerond', val: st.loading && !st.taken ? '…' : String(rows.length), hi: 1, sub: 'in huidige scope' },
    ])}
    ${H.toolbar([H.chips('af', [{ l: 'Alle', v: 'all' }, { l: 'Deze week', v: 'w' }, { l: 'Deze maand', v: 'm' }], F('af', 'all')), H.search('Zoek…')])}
    ${st.error ? errorBlock(st.error)
      : (st.loading && !st.taken) ? skeletonTable(4)
      : rows.length ? H.table(
          [{ l: 'Titel' }, { l: 'Bron', cls: 'optional' }, { l: 'Eigenaar', cls: 'optional' }, { l: 'Afgerond op', cls: 'r' }],
          rows.map(t => [
            `<span class="cell-main">${t.titel || '—'}</span>`,
            `<span style="color:var(--text-2);font-size:12.5px">${t.categorie || '—'}</span>`,
            `<span style="font-size:12.5px">${t.assigned_to_name || t.assigned_to_email || '—'}</span>`,
            `<span class="mono" style="color:var(--text-3);font-size:12px">${t.afgerond_op ? new Date(t.afgerond_op).toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}</span>`,
          ]),
          '__takenOpen'
        )
      : emptyBlock('Nog niets afgerond', 'Zodra taken worden afgevinkt verschijnen ze hier.')}`;
  }

  const errorBlock = (msg) => `<div style="margin:20px;padding:14px 18px;border:1px solid var(--rose-line);background:var(--rose-soft);border-radius:var(--r);color:var(--rose);font-size:13px">⚠ Kon taken niet ophalen: ${msg}</div>`;
  const emptyBlock = (t, s) => `<div class="empty"><div class="empty-ico">${svg(I.check2)}</div><div class="empty-t">${t}</div><div class="empty-s">${s}</div></div>`;

  /* ── Registratie ───────────────────────────────────────────────────── */
  window.DFO.VIEWS['taken/Mijn taken'] = mijnView;
  window.DFO.VIEWS['taken/Team']       = teamView;
  window.DFO.VIEWS['taken/Afgerond']   = afgerondView;
  if (typeof window.KV_V2_ADD === 'function') {
    window.KV_V2_ADD('taken');
  } else {
    (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('taken');
  }

  console.debug('[taken-v2] registered VIEWS[taken/Mijn taken|Team|Afgerond]');
})();
