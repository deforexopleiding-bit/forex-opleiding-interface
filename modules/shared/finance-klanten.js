/* modules/shared/finance-klanten.js
 *
 * Finance Klanten thin-view — klantenoverzicht binnen Finance met
 * finance-context (open bedrag, arrangement-count, dunning-status). Geen
 * full clone van Sales > Klanten — alleen de finance-relevante velden en
 * een doorklik naar het volledige klant-dossier (modules/klanten.html?id=).
 *
 * Public API: window.FinanceKlanten.mount({
 *   host:  HTMLElement,  // verplichte mount-container
 * })
 *
 * Hergebruikt:
 *   - /api/finance-customers  (server-side aggregatie)
 *
 * Mount is idempotent: tweede aanroep op dezelfde host doet niets (early
 * return). Tweede aanroep op een nieuwe host re-render (zelfde patroon
 * als shared/finance-tasks.js).
 *
 * RBAC: respecteert finance.dunning.view via het onderliggende endpoint
 * (server-side fail-fast met 403).
 *
 * Klant-dossier opening: navigeert naar /modules/klanten.html?id=<uuid>.
 * Dat hergebruikt de bestaande klanten-module met alle PR #156/158 modal-
 * functionaliteit — geen lokale customer-modal hier (per scope-cut).
 */
(function () {
  if (window.FinanceKlanten && window.FinanceKlanten.__loaded) return;

  // ── Module-scope state ─────────────────────────────────────────────────────
  let _state = {
    host:              null,
    status:            'active',           // active | archived | all
    openAmountGtZero:  false,
    arrangementStatus: 'all',              // all | VOORGESTELD | ACTIEF | NAGEKOMEN | VERBROKEN | GEANNULEERD
    search:            '',
    sortBy:            'open_amount',      // name | open_amount | arrangements_count | created_at
    sortDir:           'desc',
    page:              1,
    pageSize:          25,
    items:             [],
    total:             0,
    totalPages:        0,
    loading:           false,
    searchTimer:       null,
    wired:             false,
  };

  // ── esc(): HTML-escape (fallback als AgentShared niet geladen is). ─────────
  function esc(s) {
    if (s == null) return '';
    try {
      if (window.AgentShared && typeof window.AgentShared.esc === 'function') {
        return window.AgentShared.esc(s);
      }
    } catch (_) { /* fallthrough */ }
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtCents(cents) {
    const n = Number(cents);
    if (!isFinite(n)) return '—';
    const eur = n / 100;
    return '€ ' + eur.toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function arrangementStatusBadge(status) {
    if (!status) return '<span class="fk-arr-badge fk-arr-none">—</span>';
    const map = {
      'VOORGESTELD':  { cls: 'fk-arr-proposed', label: 'Voorgesteld' },
      'ACTIEF':       { cls: 'fk-arr-active',   label: 'Actief' },
      'NAGEKOMEN':    { cls: 'fk-arr-done',     label: 'Nagekomen' },
      'VERBROKEN':    { cls: 'fk-arr-broken',   label: 'Verbroken' },
      'GEANNULEERD':  { cls: 'fk-arr-cancel',   label: 'Geannuleerd' },
    };
    const m = map[String(status).toUpperCase()] || { cls: 'fk-arr-none', label: status };
    return '<span class="fk-arr-badge ' + m.cls + '">' + esc(m.label) + '</span>';
  }

  function dunningStatusBadge(item) {
    if (item.has_active_dunning) {
      return '<span class="fk-dun-badge fk-dun-active" title="Dunning-workflow loopt"><i class="ti ti-flame"></i> Actief</span>';
    }
    return '<span class="fk-dun-badge fk-dun-idle">—</span>';
  }

  // ── CSS-injectie (één keer) ────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('finance-klanten-styles')) return;
    const style = document.createElement('style');
    style.id = 'finance-klanten-styles';
    style.textContent = `
      .fk-filters { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-bottom:14px; padding:12px; background:var(--bg-elev); border:1px solid var(--border); border-radius:12px; }
      .fk-filters .fk-label { font-size:11px; text-transform:uppercase; letter-spacing:.5px; color:var(--text-faint); font-weight:600; margin-right:4px; }
      .fk-select, .fk-search { padding:7px 10px; background:var(--bg-elev-2,var(--bg)); border:1px solid var(--border); border-radius:8px; color:var(--text); font-size:13px; font-family:inherit; }
      .fk-select:focus, .fk-search:focus { outline:none; border-color:var(--brand-primary, var(--accent-cyan, #06b6d4)); }
      .fk-search { min-width:240px; }
      .fk-spacer { flex:1; }
      .fk-toggle { display:inline-flex; align-items:center; gap:6px; padding:6px 12px; background:var(--bg-elev-2,var(--bg)); border:1px solid var(--border); border-radius:999px; font-size:12px; cursor:pointer; user-select:none; color:var(--text-dim); }
      .fk-toggle input { margin:0; cursor:pointer; }
      .fk-toggle.active { background:var(--brand-primary-soft, rgba(6,182,212,.12)); color:var(--brand-primary, var(--accent-cyan, #06b6d4)); border-color:var(--brand-primary, var(--accent-cyan, #06b6d4)); }

      /* overflow-x:auto zodat de klanten-tabel op mobiel horizontaal
         scrollbaar is (consistent met .sr-tablewrap-fix). Scrollbar
         visueel verborgen; touch-scroll blijft actief. */
      .fk-tablewrap {
        background:var(--bg-elev); border:1px solid var(--border); border-radius:12px;
        overflow-x:auto; overflow-y:visible;
        -webkit-overflow-scrolling:touch;
        scrollbar-width:none;
      }
      .fk-tablewrap::-webkit-scrollbar { display:none; }
      .fk-table { width:100%; border-collapse:collapse; font-size:13px; }
      .fk-table th, .fk-table td { padding:11px 12px; text-align:left; border-bottom:0.5px solid var(--border-subtle, var(--border)); vertical-align:middle; }
      .fk-table th { font-weight:600; font-size:10px; text-transform:uppercase; letter-spacing:.5px; color:var(--text-faint); background:var(--bg); user-select:none; white-space:nowrap; }
      .fk-table th[data-sort-key] { cursor:pointer; }
      .fk-table th[data-sort-key]:hover { color:var(--text); }
      .fk-table th[aria-sort="ascending"]::after  { content:" \\25B2"; font-size:9px; opacity:.7; }
      .fk-table th[aria-sort="descending"]::after { content:" \\25BC"; font-size:9px; opacity:.7; }
      .fk-table tbody tr { cursor:pointer; transition:background .12s; }
      .fk-table tbody tr:hover { background:var(--bg); }
      .fk-table tbody tr:last-child td { border-bottom:none; }
      .fk-table td.num { text-align:right; font-variant-numeric:tabular-nums; }
      .fk-table th.num { text-align:right; }
      .fk-name { font-weight:600; color:var(--text); }
      .fk-email { color:var(--text-dim); font-size:12px; }
      .fk-dim { color:var(--text-faint); }

      .fk-arr-badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:500; }
      .fk-arr-proposed { background:rgba(245,158,11,.15); color:#f59e0b; }
      .fk-arr-active   { background:rgba(6,182,212,.15);  color:#06b6d4; }
      .fk-arr-done     { background:rgba(16,185,129,.15); color:#10b981; }
      .fk-arr-broken   { background:rgba(239,68,68,.15);  color:#ef4444; }
      .fk-arr-cancel   { background:rgba(156,163,175,.15); color:#9ca3af; }
      .fk-arr-none     { background:transparent; color:var(--text-faint); }

      .fk-dun-badge { display:inline-flex; align-items:center; gap:4px; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:500; }
      .fk-dun-active { background:rgba(239,68,68,.15); color:#ef4444; }
      .fk-dun-idle   { background:transparent; color:var(--text-faint); }

      .fk-status-pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.4px; }
      .fk-status-pill.active     { background:rgba(16,185,129,.15); color:#10b981; }
      .fk-status-pill.archived   { background:rgba(156,163,175,.15); color:#9ca3af; }
      .fk-status-pill.anonymized { background:rgba(239,68,68,.15); color:#ef4444; }

      .fk-state-cell { text-align:center; padding:40px 20px; color:var(--text-faint); font-size:13px; }
      .fk-skel-row td { padding:14px 12px; }
      .fk-skel { display:block; height:12px; background:linear-gradient(90deg,var(--bg) 0%, var(--border) 50%, var(--bg) 100%); background-size:200% 100%; animation:fk-skel 1.2s infinite; border-radius:4px; }
      @keyframes fk-skel { 0%{background-position:200% 0;} 100%{background-position:-200% 0;} }

      .fk-pager { display:flex; align-items:center; gap:10px; margin-top:12px; font-size:12.5px; color:var(--text-dim); flex-wrap:wrap; }
      .fk-pager .fk-pager-info { color:var(--text-faint); }
      .fk-pager .fk-pager-spacer { flex:1; }
      .fk-pager button { padding:5px 12px; background:var(--bg-elev); border:1px solid var(--border); border-radius:8px; color:var(--text); font-size:12.5px; cursor:pointer; font-family:inherit; }
      .fk-pager button:hover:not(:disabled) { background:var(--bg); }
      .fk-pager button:disabled { opacity:.4; cursor:not-allowed; }

      .fk-action-link { color:var(--brand-primary, var(--accent-cyan, #06b6d4)); cursor:pointer; font-size:12.5px; text-decoration:none; padding:4px 8px; border-radius:6px; display:inline-flex; align-items:center; gap:4px; }
      .fk-action-link:hover { background:var(--brand-primary-soft, rgba(6,182,212,.12)); }

      .fk-actions-wrap { display:inline-flex; align-items:center; gap:6px; position:relative; }
      .fk-kebab { background:transparent; border:1px solid var(--border); border-radius:6px; color:var(--text-dim); cursor:pointer; padding:4px 8px; font-size:14px; line-height:1; }
      .fk-kebab:hover { background:var(--bg); color:var(--text); }
      .fk-menu { position:fixed; min-width:220px; background:var(--bg-elev); border:1px solid var(--border); border-radius:8px; box-shadow:0 8px 24px rgba(0,0,0,.25); z-index:1200; padding:4px; display:none; }
      .fk-menu.open { display:block; }
      .fk-menu-item { display:flex; align-items:center; gap:8px; padding:8px 10px; font-size:13px; color:var(--text); cursor:pointer; border-radius:6px; text-decoration:none; }
      .fk-menu-item:hover:not(.disabled) { background:var(--bg); }
      .fk-menu-item.disabled { color:var(--text-faint); cursor:not-allowed; opacity:.65; }
      .fk-menu-item i { font-size:14px; }
    `;
    document.head.appendChild(style);
  }

  // ── Render: structurele HTML één keer; tbody/pager updaten we incrementeel ──
  function renderShell() {
    const host = _state.host;
    if (!host) return;
    host.innerHTML = `
      <div class="fk-filters">
        <span class="fk-label">Status</span>
        <select id="fkStatus" class="fk-select">
          <option value="active">Actief</option>
          <option value="archived">Inactief</option>
          <option value="all">Alles</option>
        </select>
        <span class="fk-label" style="margin-left:8px">Arrangement</span>
        <select id="fkArrangementStatus" class="fk-select">
          <option value="all">Alles</option>
          <option value="VOORGESTELD">Voorgesteld</option>
          <option value="ACTIEF">Actief</option>
          <option value="NAGEKOMEN">Nagekomen</option>
          <option value="VERBROKEN">Verbroken</option>
          <option value="GEANNULEERD">Geannuleerd</option>
        </select>
        <label class="fk-toggle" id="fkOpenAmountToggleLabel">
          <input type="checkbox" id="fkOpenAmount" />
          Alleen open bedrag &gt; 0
        </label>
        <span class="fk-spacer"></span>
        <input id="fkSearch" type="search" class="fk-search" placeholder="Zoek naam of e-mail&hellip;" />
      </div>

      <div class="fk-tablewrap">
        <table class="fk-table" id="fkTable">
          <thead>
            <tr>
              <th data-sort-key="name">Naam</th>
              <th>E-mail</th>
              <th data-sort-key="open_amount" class="num">Open bedrag</th>
              <th data-sort-key="arrangements_count" class="num">Arrangements</th>
              <th>Dunning</th>
              <th>Status</th>
              <th style="width:140px">Acties</th>
            </tr>
          </thead>
          <tbody id="fkTbody">
            ${renderSkeletonRows(5)}
          </tbody>
        </table>
      </div>
      <div class="fk-pager" id="fkPager"></div>
    `;
    wireOnce();
    syncControls();
    updateSortIndicators();
  }

  function renderSkeletonRows(n) {
    let out = '';
    for (let i = 0; i < n; i++) {
      out += '<tr class="fk-skel-row">'
           + '<td><span class="fk-skel" style="width:60%"></span></td>'
           + '<td><span class="fk-skel" style="width:70%"></span></td>'
           + '<td class="num"><span class="fk-skel" style="width:50%"></span></td>'
           + '<td class="num"><span class="fk-skel" style="width:30%"></span></td>'
           + '<td><span class="fk-skel" style="width:50%"></span></td>'
           + '<td><span class="fk-skel" style="width:40%"></span></td>'
           + '<td><span class="fk-skel" style="width:60%"></span></td>'
           + '</tr>';
    }
    return out;
  }

  function renderRows() {
    const tbody = document.getElementById('fkTbody');
    if (!tbody) return;

    if (_state.loading) {
      tbody.innerHTML = renderSkeletonRows(5);
      return;
    }
    if (!_state.items.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="fk-state-cell">Geen klanten gevonden met deze filters.</td></tr>';
      return;
    }

    let html = '';
    for (const it of _state.items) {
      const openCents = it.open_amount_cents || 0;
      const openCell = openCents > 0
        ? '<span>' + esc(fmtCents(openCents)) + '</span>'
          + (it.open_invoice_count ? ' <span class="fk-dim">(' + it.open_invoice_count + ')</span>' : '')
        : '<span class="fk-dim">€ 0,00</span>';
      const arrCount = it.arrangements_count || 0;
      const arrCell = arrCount > 0
        ? arrCount + ' ' + arrangementStatusBadge(it.active_arrangement_status)
        : '<span class="fk-dim">—</span>';
      const statusPill = '<span class="fk-status-pill ' + esc(it.status || 'active') + '">'
                      + esc({ active: 'actief', archived: 'inactief', anonymized: 'verwijderd' }[it.status] || it.status || '—')
                      + '</span>';
      html += '<tr data-customer-id="' + esc(it.id) + '">'
            + '<td><div class="fk-name">' + esc(it.name) + '</div></td>'
            + '<td class="fk-email">' + esc(it.email || '—') + '</td>'
            + '<td class="num">' + openCell + '</td>'
            + '<td class="num">' + arrCell + '</td>'
            + '<td>' + dunningStatusBadge(it) + '</td>'
            + '<td>' + statusPill + '</td>'
            + '<td>'
            + '  <div class="fk-actions-wrap">'
            + '    <a class="fk-action-link" href="/modules/klanten.html?id=' + encodeURIComponent(it.id) + '" data-fk-action="dossier"><i class="ti ti-user"></i> Dossier</a>'
            + '    <button type="button" class="fk-kebab" data-fk-kebab="' + esc(it.id) + '" title="Meer acties" aria-label="Meer acties">&#8942;</button>'
            + '  </div>'
            + '</td>'
            + '</tr>';
    }
    tbody.innerHTML = html;

    // Row-click → klant-dossier (zelfde target als de actie-link).
    tbody.querySelectorAll('tr[data-customer-id]').forEach(tr => {
      tr.addEventListener('click', (e) => {
        // Negeer kliks op interne actie-links / kebab-buttons (die regelen zelf navigatie).
        if (e.target.closest('a, button')) return;
        const id = tr.getAttribute('data-customer-id');
        if (id) window.location.href = '/modules/klanten.html?id=' + encodeURIComponent(id);
      });
    });

    // Kebab-knoppen wiring (per row een eigen menu, gemount in body).
    tbody.querySelectorAll('button[data-fk-kebab]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const customerId = btn.getAttribute('data-fk-kebab');
        openKebabMenu(btn, customerId);
      });
    });
  }

  // ── Kebab dropdown (position:fixed, één per keer) ──────────────────────────
  let _kebabMenuEl = null;
  let _kebabCloseHandlers = null;

  function closeKebabMenu() {
    if (_kebabMenuEl) {
      _kebabMenuEl.remove();
      _kebabMenuEl = null;
    }
    if (_kebabCloseHandlers) {
      document.removeEventListener('click', _kebabCloseHandlers.docClick, true);
      window.removeEventListener('scroll', _kebabCloseHandlers.scroll, true);
      window.removeEventListener('resize', _kebabCloseHandlers.scroll);
      _kebabCloseHandlers = null;
    }
  }

  function openKebabMenu(anchorEl, customerId) {
    closeKebabMenu();
    const menu = document.createElement('div');
    menu.className = 'fk-menu open';

    // Item 1: Dossier (zelfde target als de quick-link, voor symmetrie).
    const dossierUrl = '/modules/klanten.html?id=' + encodeURIComponent(customerId);
    const dossierLink = document.createElement('a');
    dossierLink.className = 'fk-menu-item';
    dossierLink.href = dossierUrl;
    dossierLink.innerHTML = '<i class="ti ti-user"></i> Open klant-dossier';
    dossierLink.addEventListener('click', () => closeKebabMenu());
    menu.appendChild(dossierLink);

    // Item 2: Open inbox-conversation — async lookup, default disabled tot resolve.
    const inboxItem = document.createElement('div');
    inboxItem.className = 'fk-menu-item disabled';
    inboxItem.innerHTML = '<i class="ti ti-message-circle"></i> Inbox-conversatie laden&hellip;';
    inboxItem.title = 'Lookup loopt';
    menu.appendChild(inboxItem);

    document.body.appendChild(menu);
    _kebabMenuEl = menu;

    // Positie: vlak onder de anchor-button, rechts-uitgelijnd.
    const rect = anchorEl.getBoundingClientRect();
    menu.style.top = (rect.bottom + 4) + 'px';
    // Rechter-rand van menu uitlijnen met rechter-rand van de knop.
    const menuRect = menu.getBoundingClientRect();
    let left = rect.right - menuRect.width;
    if (left < 8) left = 8;
    menu.style.left = left + 'px';

    // Flip-up als menu onderaan scherm valt.
    const vh = window.innerHeight;
    if (rect.bottom + menuRect.height + 8 > vh) {
      menu.style.top = (rect.top - menuRect.height - 4) + 'px';
    }

    // Close-handlers: klik buiten / scroll / resize.
    const docClick = (e) => {
      if (!menu.contains(e.target)) closeKebabMenu();
    };
    const scroll = () => closeKebabMenu();
    document.addEventListener('click', docClick, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', scroll);
    _kebabCloseHandlers = { docClick, scroll };

    // Async resolve conversation_id via dedicated lightweight endpoint.
    resolveInboxConversation(customerId).then((conversationId) => {
      // Menu kan inmiddels gesloten zijn — guard tegen stale closure.
      if (!_kebabMenuEl || _kebabMenuEl !== menu) return;
      if (conversationId) {
        const link = document.createElement('a');
        link.className = 'fk-menu-item';
        link.href = '/modules/finance.html?tab=wanbetalers&sub=inbox&conversation=' + encodeURIComponent(conversationId);
        link.innerHTML = '<i class="ti ti-message-circle"></i> Open inbox-conversatie';
        link.title = 'Spring naar de Wanbetalers Inbox';
        link.addEventListener('click', () => closeKebabMenu());
        menu.replaceChild(link, inboxItem);
      } else {
        inboxItem.innerHTML = '<i class="ti ti-message-circle-off"></i> Geen inbox-conversatie';
        inboxItem.title = 'Geen WhatsApp-conversatie gekoppeld aan deze klant';
      }
    }).catch((err) => {
      if (!_kebabMenuEl || _kebabMenuEl !== menu) return;
      console.warn('[FinanceKlanten] inbox-lookup fail:', err?.message);
      inboxItem.innerHTML = '<i class="ti ti-alert-triangle"></i> Inbox-lookup mislukt';
      inboxItem.title = String(err?.message || 'Onbekende fout');
    });
  }

  async function resolveInboxConversation(customerId) {
    let resp;
    const url = '/api/inbox-conversation-by-customer?customer_id=' + encodeURIComponent(customerId);
    if (window.AgentShared && typeof window.AgentShared.apiFetch === 'function') {
      resp = await window.AgentShared.apiFetch(url);
    } else {
      resp = await fetch(url, { credentials: 'include' });
    }
    if (!resp.ok) {
      // 403/500/etc → behandel als not-found in UI (geen toast-spam).
      if (resp.status === 403) return null;
      const txt = await resp.text().catch(() => '');
      throw new Error('HTTP ' + resp.status + ' ' + txt.slice(0, 80));
    }
    const data = await resp.json();
    if (data && data.found && data.conversation_id) return data.conversation_id;
    return null;
  }

  function renderPager() {
    const pager = document.getElementById('fkPager');
    if (!pager) return;
    const from = _state.total === 0 ? 0 : (_state.page - 1) * _state.pageSize + 1;
    const to   = Math.min(_state.page * _state.pageSize, _state.total);
    const info = _state.total === 0
      ? '0 resultaten'
      : (from + '–' + to + ' van ' + _state.total);
    pager.innerHTML = `
      <span class="fk-pager-info">${esc(info)}</span>
      <span class="fk-pager-spacer"></span>
      <button id="fkPrev" type="button" ${_state.page <= 1 ? 'disabled' : ''}>&larr; Vorige</button>
      <span class="fk-pager-info">Pagina ${esc(String(_state.page))} / ${esc(String(Math.max(1, _state.totalPages)))}</span>
      <button id="fkNext" type="button" ${_state.page >= _state.totalPages ? 'disabled' : ''}>Volgende &rarr;</button>
    `;
    const prev = document.getElementById('fkPrev');
    const next = document.getElementById('fkNext');
    if (prev) prev.addEventListener('click', () => { if (_state.page > 1) { _state.page--; load(); } });
    if (next) next.addEventListener('click', () => { if (_state.page < _state.totalPages) { _state.page++; load(); } });
  }

  function syncControls() {
    const sSel = document.getElementById('fkStatus');
    if (sSel) sSel.value = _state.status;
    const aSel = document.getElementById('fkArrangementStatus');
    if (aSel) aSel.value = _state.arrangementStatus;
    const oCb = document.getElementById('fkOpenAmount');
    if (oCb) oCb.checked = _state.openAmountGtZero;
    const lbl = document.getElementById('fkOpenAmountToggleLabel');
    if (lbl) lbl.classList.toggle('active', _state.openAmountGtZero);
    const search = document.getElementById('fkSearch');
    if (search) search.value = _state.search || '';
  }

  function updateSortIndicators() {
    document.querySelectorAll('#fkTable th[data-sort-key]').forEach(th => {
      const key = th.getAttribute('data-sort-key');
      if (key === _state.sortBy) {
        th.setAttribute('aria-sort', _state.sortDir === 'asc' ? 'ascending' : 'descending');
      } else {
        th.removeAttribute('aria-sort');
      }
    });
  }

  function wireOnce() {
    if (_state.wired) return;
    _state.wired = true;

    const sSel = document.getElementById('fkStatus');
    if (sSel) sSel.addEventListener('change', () => {
      _state.status = sSel.value;
      _state.page = 1; load();
    });

    const aSel = document.getElementById('fkArrangementStatus');
    if (aSel) aSel.addEventListener('change', () => {
      _state.arrangementStatus = aSel.value;
      _state.page = 1; load();
    });

    const oCb = document.getElementById('fkOpenAmount');
    if (oCb) oCb.addEventListener('change', () => {
      _state.openAmountGtZero = !!oCb.checked;
      const lbl = document.getElementById('fkOpenAmountToggleLabel');
      if (lbl) lbl.classList.toggle('active', _state.openAmountGtZero);
      _state.page = 1; load();
    });

    const search = document.getElementById('fkSearch');
    if (search) search.addEventListener('input', (e) => {
      clearTimeout(_state.searchTimer);
      _state.searchTimer = setTimeout(() => {
        _state.search = (e.target.value || '').trim();
        _state.page = 1; load();
      }, 300);
    });

    document.querySelectorAll('#fkTable th[data-sort-key]').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.getAttribute('data-sort-key');
        if (_state.sortBy === key) {
          _state.sortDir = _state.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          _state.sortBy = key;
          _state.sortDir = key === 'name' ? 'asc' : 'desc';
        }
        updateSortIndicators();
        _state.page = 1; load();
      });
    });
  }

  // ── Data-laad ──────────────────────────────────────────────────────────────
  async function load() {
    _state.loading = true;
    renderRows();
    try {
      const params = new URLSearchParams({
        status:              _state.status,
        open_amount_gt_zero: String(_state.openAmountGtZero),
        arrangement_status:  _state.arrangementStatus,
        sort_by:             _state.sortBy,
        sort_dir:            _state.sortDir,
        page:                String(_state.page),
        page_size:           String(_state.pageSize),
      });
      if (_state.search) params.set('search', _state.search);

      let resp;
      if (window.AgentShared && typeof window.AgentShared.apiFetch === 'function') {
        resp = await window.AgentShared.apiFetch('/api/finance-customers?' + params.toString());
      } else {
        resp = await fetch('/api/finance-customers?' + params.toString(), { credentials: 'include' });
      }

      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error('HTTP ' + resp.status + ' ' + txt.slice(0, 120));
      }
      const data = await resp.json();
      _state.items      = Array.isArray(data.items) ? data.items : [];
      _state.total      = Number(data.total) || 0;
      _state.totalPages = Math.max(1, Number(data.total_pages) || 1);
    } catch (e) {
      console.error('[FinanceKlanten] load error:', e);
      _state.items = [];
      _state.total = 0;
      _state.totalPages = 1;
      const tbody = document.getElementById('fkTbody');
      if (tbody) {
        tbody.innerHTML = '<tr><td colspan="7" class="fk-state-cell">Fout bij laden: ' + esc(e.message || 'onbekend') + '</td></tr>';
      }
      if (window.AgentShared && typeof window.AgentShared.showToast === 'function') {
        try { window.AgentShared.showToast('Klanten laden mislukt', 'error'); } catch (_) {}
      }
    } finally {
      _state.loading = false;
      renderRows();
      renderPager();
    }
  }

  // ── Public mount ───────────────────────────────────────────────────────────
  function mount(opts) {
    const o = opts || {};
    if (!o.host) {
      console.warn('[FinanceKlanten] mount() requires {host}');
      return;
    }
    // Idempotent: zelfde host = niets doen.
    if (_state.host === o.host && _state.wired) return;
    _state.host = o.host;
    _state.wired = false;

    injectStyles();
    renderShell();
    load();
  }

  // ── Export ─────────────────────────────────────────────────────────────────
  window.FinanceKlanten = {
    __loaded: true,
    mount,
  };
})();
