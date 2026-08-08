// modules/klanten-v2/views/inbox-v2.js
//
// Fase A — Centrale Inbox voor v2-shell (LAYOUT + LIVE DATA).
// 1-op-1 render uit docs/redesign/systeemprototype-v45.html:
//   - VIEWS['inbox/']  r4505-4601  (3-koloms rail + list + detail)
//   - CSS r614-641    (.ib-* classes uit prototype)
//
// DATA-BRON:
//   - Wanbetalers (finance)  → /api/inbox-conversations-list?module=finance (LIVE)
//   - Events                  → /api/inbox-conversations-list?module=events (LIVE)
//   - Onboarding              → /api/inbox-conversations-list?module=onboarding (LIVE)
//   - Overige sources         → MOCK-tellers (geen aggregate-endpoint)
//
// DATA-REGELS (streng volgens dashboard-v2 pattern):
//   1. Render meteen met skeleton → geen page-freeze op initial load.
//   2. Parallel fetch via Promise.all + tryFetch (fail-soft).
//   3. 8s timeout per call via Promise.race.
//   4. Faalt een call → source-teller wordt '—', geen crash, geen retry-loop.
//   5. Render-loop-guard: !_live.loading in dashManager-achtige trigger.
//   6. Sequence-tracking (_fetchSeq) tegen race bij snelle source-switch.

(function () {
  if (!window.DFO) { console.error('[inbox-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[inbox-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, S, F, render, goMod } = window.DFO;
  const H = window.KV_V2.helpers;

  /* ── Rail-configuratie ────────────────────────────────────────────── */
  // v = source-slug (matcht IB_SRC-key in prototype), n = weergave-naam,
  // ic = icon, col = accent-kleur, module = API-module of null (=MOCK),
  // mod = shell-target voor "Open in X" knop.
  const IB_SRC = [
    // v          n                        ic          col       module       mod
    ['wb',       'Wanbetalers',           I.alert,    'amber',   'finance',    'wanbetalers'],
    ['ev',       'Events',                I.cal,      'pink',    'events',     'events'],
    ['ob',       'Onboarding',            I.route,    'emerald', 'onboarding', 'onboarding'],
    ['lisa',     'Lisa AI',               I.bot,      'violet',  null,         'lisa'],
    ['lo',       'Leadsonderhoud',        I.repeat,   'teal',    null,         'leadsonderhoud'],
    ['m_adm',    'E-mail administratie@', I.mail,     'blue',    null,         'email'],
    ['m_info',   'E-mail info@',          I.mail,     'emerald', null,         'email'],
    ['tk',       'Tickets',               I.ticket,   'rose',    null,         'tickets'],
  ];
  const IB_GRP = [
    ['Aandacht',    IB_SRC.filter(x => ['wb','lisa'].includes(x[0]))],
    ['Klantcontact', IB_SRC.filter(x => ['ev','ob','m_adm','m_info'].includes(x[0]))],
    ['Overig',       IB_SRC.filter(x => ['lo','tk'].includes(x[0]))],
  ];
  // Fallback MOCK-tellers voor sources zonder endpoint
  const MOCK_COUNTS = { lisa: 2, lo: 5, m_adm: 12, m_info: 8, tk: 3 };

  /* ── State ─────────────────────────────────────────────────────────── */
  let ibSrc = 'wb';
  let ibSel = null; // conversation_id (uuid van geselecteerde conv)
  const _live = {
    loading: false,
    error: null,
    sources: { wb: null, ev: null, ob: null }, // per source: {items, total, configured, module} of null bij fail
  };
  let _fetchSeq = 0;

  /* ── tryFetch met 8s timeout (dashboard-pattern) ──────────────────── */
  async function tryFetch(label, url, timeoutMs = 8000) {
    try {
      const p = window.KV.authedJson(url);
      return await Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) {
      console.warn('[inbox-v2] ' + label + ' fetch fail:', e && e.message);
      return null;
    }
  }

  /* ── Bundle-fetch: 3 live sources parallel ────────────────────────── */
  async function fetchInboxBundle() {
    // Skip als al geladen en geen error
    if (_live.sources.wb && !_live.error) return;
    const seq = ++_fetchSeq;
    _live.loading = true;
    _live.error = null;
    console.debug('[inbox-v2] bundle start seq=' + seq);
    if (window.DFO && window.DFO.render) window.DFO.render();
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      const [wb, ev, ob] = await Promise.all([
        tryFetch('inbox-list finance',    '/api/inbox-conversations-list?module=finance&status=active&limit=200'),
        tryFetch('inbox-list events',     '/api/inbox-conversations-list?module=events&status=active&limit=200'),
        tryFetch('inbox-list onboarding', '/api/inbox-conversations-list?module=onboarding&status=active&limit=200'),
      ]);
      if (seq !== _fetchSeq) { console.debug('[inbox-v2] discard stale seq=' + seq); return; }
      _live.sources.wb = wb;
      _live.sources.ev = ev;
      _live.sources.ob = ob;
      _live.error = wb || ev || ob ? null : 'Alle inbox-endpoints faalden';
      console.debug('[inbox-v2] bundle done seq=' + seq, {
        wbItems: wb?.items?.length, evItems: ev?.items?.length, obItems: ob?.items?.length,
      });
    } catch (e) {
      if (seq !== _fetchSeq) return;
      console.error('[inbox-v2] bundle fail seq=' + seq, e && e.message);
      _live.error = (e && e.message) || 'onbekende fout';
    } finally {
      if (seq === _fetchSeq) {
        _live.loading = false;
        if (window.DFO && window.DFO.render) window.DFO.render();
      }
    }
  }

  /* ── Handler-stubs op window ──────────────────────────────────────── */
  window.__ibSetSrc = (v) => { ibSrc = v; ibSel = null; render(); };
  window.__ibSel = (id) => { ibSel = id; render(); };

  /* ── Helper: source-teller (live of mock) ─────────────────────────── */
  function srcCount(v) {
    // Voor 3 live sources: item.length uit response
    if (v === 'wb') return _live.sources.wb ? _live.sources.wb.items.length : null;
    if (v === 'ev') return _live.sources.ev ? _live.sources.ev.items.length : null;
    if (v === 'ob') return _live.sources.ob ? _live.sources.ob.items.length : null;
    // Rest = mock
    return MOCK_COUNTS[v] != null ? MOCK_COUNTS[v] : 0;
  }

  /* ── Helper: rows voor huidige source ─────────────────────────────── */
  function currentRows() {
    const live = ['wb', 'ev', 'ob'].includes(ibSrc) ? _live.sources[ibSrc] : null;
    if (!live || !Array.isArray(live.items)) return [];
    // Map conv-list items naar UI-row-shape.
    return live.items.map(c => {
      const custName = c.customer
        ? (c.customer.is_company ? c.customer.company_name : [c.customer.first_name, c.customer.last_name].filter(Boolean).join(' '))
        : (c.attendee ? [c.attendee.first_name, c.attendee.last_name].filter(Boolean).join(' ') : null);
      const van = custName || c.display_name || c.phone_number || 'Onbekend';
      // Tijd-hint uit last_message_at (fallback: last_activity_at)
      const isoTijd = c.last_message_at || c.last_activity_at || null;
      let tijd = '—';
      if (isoTijd) {
        try {
          const d = new Date(isoTijd);
          const delta = Date.now() - d.getTime();
          if (delta < 3600000) tijd = Math.round(delta / 60000) + 'm';
          else if (delta < 86400000) tijd = Math.round(delta / 3600000) + 'u';
          else if (delta < 7 * 86400000) tijd = Math.round(delta / 86400000) + 'd';
          else tijd = d.toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
        } catch (_) { /* ignore */ }
      }
      return {
        id: c.id,
        van,
        t: c.last_message_preview || '—',
        p: c.attendee?.event?.title || c.customer?.email || '—',
        tijd,
        nw: (c.unread_count || 0) > 0,
        ai: false, // AI-suggestie hint is source-specifiek, buiten scope
        src: ibSrc,
        kan: 'WhatsApp',
        ctx: c.customer?.email || c.phone_number || '',
        acties: ['Openen in module'],
      };
    });
  }

  /* ── VIEW ─────────────────────────────────────────────────────────── */
  function inboxView() {
    // Trigger fetch als nog niet geladen, met render-loop guard.
    if (!_live.sources.wb && !_live.loading) {
      queueMicrotask(() => fetchInboxBundle());
    }

    const totaal = IB_SRC.reduce((a, x) => a + (srcCount(x[0]) || 0), 0);
    const rows = currentRows();
    const q = (F('q', '') || '').toLowerCase();
    const filtered = q ? rows.filter(r => r.van.toLowerCase().includes(q) || r.t.toLowerCase().includes(q)) : rows;
    const flOnlyNw = F('fl', 'all') === 'nw';
    const list = flOnlyNw ? filtered.filter(r => r.nw) : filtered;
    const c = list.find(r => r.id === ibSel) || list[0] || null;
    const srcInfo = IB_SRC.find(x => x[0] === ibSrc) || IB_SRC[0];

    // Amber-banner: uitleg dat 3 sources live zijn, rest mock, en dat detail-messages
    // niet-live zijn (out of scope voor deze PR).
    const infoBanner = `<div style="margin:14px 20px 0;padding:11px 14px;border:1px solid var(--amber-line);background:var(--amber-soft);border-radius:var(--r);
      display:flex;align-items:center;gap:11px;font-size:12.5px;color:var(--amber)">
      ${svg(I.alert, 'width:16px;height:16px;flex-shrink:0')}
      <span><b>LIVE DATA</b> voor 3 sources (Wanbetalers/Events/Onboarding via <code>/api/inbox-conversations-list</code>).
      Overige sources en detail-messages tonen mock — data-uitbreiding volgt na layout-goedkeuring.</span></div>`;

    return `${infoBanner}
    <div class="ib-split">
      <div class="ib-rail">
        <button class="ib-src ${ibSrc === 'all' ? 'on' : ''}" onclick="__ibSetSrc('wb')" style="margin-bottom:4px" title="Alles = Wanbetalers-source (default)">
          <span class="ic" style="background:var(--teal-soft);color:var(--teal)">${svg(I.inbox)}</span>
          <span style="flex:1">Alles</span><span class="n ${totaal ? '' : 'zero'}">${_live.loading ? '…' : totaal}</span></button>
        ${IB_GRP.map(([g, items]) => `
          <div style="font-size:10px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--text-3);padding:14px 9px 6px">${g}</div>
          ${items.map(([v, n, ic, col, module]) => {
            const cnt = srcCount(v);
            const isLive = module != null;
            const disp = cnt == null ? '…' : cnt;
            return `<button class="ib-src ${ibSrc === v ? 'on' : ''}" onclick="__ibSetSrc('${v}')"
              title="${isLive ? 'Live via /api/inbox-conversations-list?module=' + module : 'MOCK — geen live-endpoint'}">
              <span class="ic" style="background:var(--${col}-soft);color:var(--${col})">${svg(ic)}</span>
              <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${n}${isLive ? '' : `<span style="font-size:9px;font-weight:700;letter-spacing:.06em;color:var(--amber);background:var(--amber-soft);padding:0 4px;border-radius:3px;margin-left:5px;vertical-align:1px">MOCK</span>`}</span>
              <span class="n ${cnt ? '' : 'zero'}">${disp}</span></button>`;
          }).join('')}`).join('')}
        <div style="margin-top:16px;padding:11px 12px;background:var(--surface-2);border-radius:var(--r);font-size:11.5px;color:var(--text-3);line-height:1.5">
          Alles wat aandacht vraagt op één plek. Elk bericht blijft ook in zijn eigen module staan.</div>
        ${_live.error ? `<div style="margin-top:10px;padding:9px 11px;background:var(--rose-soft);border:1px solid var(--rose-line);border-radius:var(--r-sm);font-size:11.5px;color:var(--rose)">⚠ ${_live.error}</div>` : ''}
      </div>

      <div class="ib-list">
        <div class="ib-top">
          <div class="tb-search" style="width:100%">${svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>')}
            <input placeholder="Zoek in ${srcInfo[1]}…" value="${(F('q','') || '').replace(/"/g, '&quot;')}"
              oninput="S.filters[DFO.key()+'::q']=this.value;DFO.render();this.focus();this.setSelectionRange(this.value.length,this.value.length)"></div>
          <div style="display:flex;gap:6px;margin-top:9px;align-items:center">
            <button class="chip ${!flOnlyNw ? 'on' : ''}" style="font-size:11.5px;padding:3px 10px" onclick="DFO.setF('fl','all')">Alles</button>
            <button class="chip ${flOnlyNw ? 'on' : ''}" style="font-size:11.5px;padding:3px 10px" onclick="DFO.setF('fl','nw')">Nieuw</button>
            <span style="font-size:12px;color:var(--text-3);margin-left:auto">${_live.loading && !list.length ? 'laden…' : list.length + ' items'}</span></div>
        </div>
        ${_live.loading && !list.length
          ? renderSkeletonRows(6)
          : (list.map(i => renderRow(i, srcInfo)).join('') || `<div class="empty" style="padding:44px 20px"><div class="empty-t">${['wb','ev','ob'].includes(ibSrc) ? 'Alles afgehandeld 🎉' : 'Geen items voor deze source (MOCK — geen live-endpoint)'}</div></div>`)}
      </div>

      ${c
        ? renderDetail(c, srcInfo)
        : `<div class="ib-detail"><div class="empty" style="margin:auto">
            <div class="empty-ico">${svg(I.inbox)}</div><div class="empty-t">Selecteer een item</div></div></div>`}
    </div>`;
  }

  /* ── Rij-renderer ─────────────────────────────────────────────────── */
  function renderRow(i, srcInfo) {
    const [, n, ic, col] = srcInfo;
    return `<div class="ib-row ${i.nw ? 'nw' : ''} ${ibSel === i.id ? 'on' : ''}" onclick="__ibSel('${i.id}')">
      ${H.av(i.van, 34)}
      <div class="ib-b">
        <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:2px">
          <span style="font-size:13.5px;font-weight:${i.nw ? '600' : '500'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${i.van}</span>
          <span style="margin-left:auto;font-size:10.5px;font-family:'IBM Plex Mono',monospace;color:var(--text-3);flex-shrink:0">${i.tijd}</span></div>
        <div class="ib-t">${i.t}</div>
        <div class="ib-p">${i.p}</div>
        <div style="margin-top:7px;display:flex;gap:6px;align-items:center">
          <span class="ib-src-tag" style="background:var(--${col}-soft);color:var(--${col})">${svg(ic, 'width:11px;height:11px')}${n}</span>
          ${i.nw ? '<span style="width:7px;height:7px;border-radius:50%;background:var(--rose);margin-left:auto"></span>' : ''}</div>
      </div></div>`;
  }

  /* ── Detail-renderer ──────────────────────────────────────────────── */
  function renderDetail(c, srcInfo) {
    const [, n, ic, col, , mod] = srcInfo;
    return `<div class="ib-detail">
      <div style="padding:16px 22px;background:var(--surface);border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:9px;margin-bottom:12px;flex-wrap:wrap">
          <span class="ib-src-tag" style="background:var(--${col}-soft);color:var(--${col});font-size:11.5px;padding:3px 10px">
            ${svg(ic, 'width:12px;height:12px')}${n}</span>
          <span class="pill pill-neutral nodot">${c.kan}</span>
          <span style="font-size:12px;color:var(--text-3)">${c.tijd} geleden</span>
          <button class="btn btn-ghost btn-sm" style="margin-left:auto" onclick="DFO.goMod('${mod}')">
            Open in ${n.split(' ')[0]} ${svg('<path d="m9 18 6-6-6-6"/>', 'width:13px;height:13px')}</button>
        </div>
        <div style="display:flex;align-items:center;gap:13px">
          ${H.av(c.van, 42)}
          <div style="flex:1;min-width:0"><div style="font-size:16px;font-weight:600;letter-spacing:-.02em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c.van}</div>
            <div style="font-size:12.5px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${c.ctx}</div></div>
          <button class="btn btn-ghost btn-sm" onclick="console.info('[inbox-v2] Open dossier (voorbeeld)')">${svg(I.users)}Dossier</button>
        </div>
      </div>
      <div style="flex:1;min-height:0;overflow-y:auto;padding:22px">
        <div style="max-width:660px">
          <div style="padding:14px 18px;background:var(--surface-2);border-radius:14px 14px 14px 4px;margin-bottom:10px;font-size:14px;line-height:1.55">${c.t}</div>
          <div style="font-size:11px;color:var(--text-3);font-family:'IBM Plex Mono',monospace;margin-bottom:20px">
            ${c.van} · ${c.tijd} geleden via ${c.kan}</div>
          <div style="margin-top:16px;padding:10px 14px;background:var(--surface-2);border-radius:var(--r);font-size:12px;color:var(--text-3)">
            <b>Volledige bericht-thread + compose</b> volgen in de tweede iteratie (huidige preview toont alleen last_message_preview per conversation).</div>
        </div>
      </div>
      <div style="padding:13px 22px;background:var(--surface);border-top:1px solid var(--border);display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        ${c.acties.map((a, i) => `<button class="btn ${i === 0 ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="DFO.goMod('${mod}')">${a}</button>`).join('')}
        <button class="icon-btn" style="margin-left:auto" title="Markeer ongelezen">${svg(I.mail)}</button>
        <button class="icon-btn" title="Later">${svg(I.clock)}</button>
        <button class="icon-btn" title="Archiveren">${svg(I.box)}</button>
      </div>
    </div>`;
  }

  /* ── Skeleton-rows tijdens initial load ───────────────────────────── */
  function renderSkeletonRows(n) {
    return Array.from({ length: n }).map(() => `
      <div class="ib-row" style="opacity:.55">
        <div class="avatar" style="width:34px;height:34px;background:var(--surface-2)"></div>
        <div class="ib-b">
          <div style="height:12px;background:var(--surface-2);border-radius:4px;width:60%;margin-bottom:6px"></div>
          <div style="height:11px;background:var(--surface-2);border-radius:4px;width:85%;margin-bottom:5px"></div>
          <div style="height:10px;background:var(--surface-2);border-radius:4px;width:40%"></div>
        </div></div>`).join('');
  }

  /* ── Registratie ───────────────────────────────────────────────────── */
  window.DFO.VIEWS['inbox/'] = inboxView;
  if (typeof window.KV_V2_ADD === 'function') {
    window.KV_V2_ADD('inbox');
  } else {
    (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('inbox');
  }

  console.debug('[inbox-v2] registered VIEWS[inbox/]');
})();
