/* ============================================================
   Gedeelde sidebar — De Forex Opleiding
   Eén canonieke navigatie voor alle pagina's (index + modules).
   Vervangt de 8x gekopieerde inline <nav class="sidebar">.

   Gebruik: plaats <div id="sidebar-mount"></div> waar de sidebar moet komen
   en laad dit script: <script src="/modules/shared/sidebar.js"></script>

   Styling: hergebruikt de bestaande inline .sidebar/.nav-item CSS per pagina.
   Footer (gebruiker + theme-toggle): via window.AgentShared.renderUserSection().
   Rol-gating: adminNavLink alleen voor ADMIN_ROLES (zelfde gedrag als voorheen).
   NB: deze commit voegt GEEN nieuwe permissions toe — alleen centralisatie.
   ============================================================ */
(function () {
  'use strict';

  var ADMIN_ROLES = ['super_admin', 'admin', 'manager'];

  // Canonieke nav-items. href's zijn ABSOLUUT zodat ze vanaf elke locatie
  // werken (index.html in root én modules/*.html).
  var ICON = {
    dashboard: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>',
    email: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>',
    // lucide "users" (niet de users-group-variant die meetings/onboarding gebruiken) → visueel onderscheid in de sidebar.
    klanten: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    lisa: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><circle cx="9" cy="10" r="1"/><circle cx="15" cy="10" r="1"/>',
    taken: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="12" y2="17"/>',
    kennisbank: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
    agents: '<circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 1 0-16 0"/>',
    meetings: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    'control-center': '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
    'follow-up': '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
    admin: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    whatsapp: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
    contracten: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
    finance: '<path d="M12 2v20"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    sales: '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>',
    tickets: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 11v2"/><path d="M13 17v2"/>',
    onboarding: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'
  };

  function svg(key) {
    return '<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + ICON[key] + '</svg>';
  }

  function navLink(mod, href, label, extra) {
    return '<a class="nav-item" data-module="' + mod + '" href="' + href + '"' + (extra || '') + '>' +
      svg(mod) + label + '</a>';
  }

  function concept(key, label) {
    return '<div class="nav-item nav-concept">' + svg(key) + label + '<span class="nav-soon">Binnenkort</span></div>';
  }

  function buildSidebarHtml() {
    return '' +
      '<nav class="sidebar">' +
        '<div class="sidebar-logo">' +
          '<img src="/img/logo-dark.png"  alt="De Forex Opleiding" class="logo-dark">' +
          '<img src="/img/logo-light.png" alt="De Forex Opleiding" class="logo-light">' +
        '</div>' +
        '<div class="sidebar-nav">' +
          navLink('dashboard', '/index.html', 'Dashboard') +
          // 'Klanten' verwijderd: klantenlijst leeft nu in Sales > tab Klanten.
          '<a class="nav-item" data-module="email" href="/modules/email.html">' + svg('email') + 'E-mail<span class="nav-badge" id="navEmailBadge"></span></a>' +
          navLink('lisa', '/modules/lisa.html', 'AI Agents') +
          '<a class="nav-item" data-module="taken" href="/modules/taken.html">' + svg('taken') + 'Takenbeheer<span class="nav-badge" id="navTakenBadge"></span></a>' +
          navLink('kennisbank', '/modules/kennisbank.html', 'Kennisbank') +
          navLink('agents', '/modules/agents.html', 'AI Agents') +
          navLink('meetings', '/modules/meetings.html', 'Vergaderruimte') +
          navLink('control-center', '/modules/control-center.html', 'Control Center') +
          navLink('follow-up', '/modules/follow-up.html', 'Follow-up') +
          navLink('sales', '/modules/sales.html', 'Sales') +
          navLink('onboarding', '/modules/onboarding-overzicht.html', 'Onboarding') +
          navLink('finance', '/modules/finance.html', 'Finance') +
          // F1: Taken-module (finance-taken / payment-arrangements approval-queue).
          // Eigen sidebar-link met badge die /api/tasks-list pollt; klik linkt naar
          // /modules/taken.html?status=PENDING (primaire UX-ingang voor Open taken).
          // Gate via feature-key finance.tasks.view (zie MODULE_FEATURE_MAP) met
          // fallback in updateFinanceTasksBadge naar finance.arrangements.view voor
          // backward-compat met rollen die nog geen finance.tasks.view hebben.
          '<a class="nav-item" data-module="finance-tasks" href="/modules/taken.html">' +
            svg('taken') + 'Taken' +
            '<span class="nav-badge" id="navFinanceTasksBadge" data-target="/modules/taken.html?status=PENDING" title="Open taken"></span>' +
          '</a>' +
          '<a class="nav-item" data-module="tickets" href="/modules/tickets.html">' + svg('tickets') + 'Tickets<span class="nav-badge" id="navTicketsBadge"></span></a>' +
          // Admin nav-item incl. approval-badge (D1 payment-arrangements). De badge zelf
          // linkt nu naar /modules/taken.html?status=PENDING (cleanere UX dan de oude
          // Admin#approval-queue ingang); admin.html#approval-queue blijft bestaan als
          // secundaire/backward-compat route maar wordt niet meer als badge-target gebruikt.
          // Badge wordt alleen zichtbaar bij PENDING+APPROVED > 0 én als de user de
          // feature_key finance.arrangements.approve heeft (zie updateApprovalsBadge).
          '<a class="nav-item" data-module="admin" id="adminNavLink" href="/modules/admin.html" style="display:none">' +
            svg('admin') + 'Admin' +
            '<span class="nav-badge" id="navApprovalsBadge" data-target="/modules/taken.html?status=PENDING" title="Open taken"></span>' +
          '</a>' +
          '<div class="nav-section">Binnenkort</div>' +
          concept('whatsapp', 'WhatsApp Bot') +
          concept('contracten', 'Contracten') +
        '</div>' +
        '<div class="sidebar-footer">' +
          '<div class="footer-user"></div>' +
        '</div>' +
      '</nav>';
  }

  function currentModule() {
    var path = (window.location.pathname || '').toLowerCase();
    var m = path.match(/\/modules\/([a-z-]+)\.html/);
    if (m) {
      var name = m[1];
      if (name.indexOf('follow-up') === 0) return 'follow-up'; // detail/admin sub-pagina's
      return name;
    }
    return 'dashboard'; // root / index.html
  }

  function highlightActive() {
    var cur = currentModule();
    // sales-dashboard.html highlight valt onder Dashboard-link in de sidebar
    if (cur === 'sales-dashboard') cur = 'dashboard';
    if (cur === 'onboarding-overzicht') cur = 'onboarding';
    document.querySelectorAll('#sidebar-mount [data-module]').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-module') === cur);
    });
  }

  async function applyAdminGating() {
    try {
      if (window._authSharedReady) await window._authSharedReady;
      var profile = window.AuthShared ? await window.AuthShared.getProfile() : null;
      var link = document.getElementById('adminNavLink');
      if (link) link.style.display = (profile && ADMIN_ROLES.indexOf(profile.role) !== -1) ? '' : 'none';
    } catch (e) { /* niet ingelogd → admin-link blijft verborgen */ }
  }

  // Dashboard-link href op basis van permissions (niet langer hardcoded op rol).
  // - dashboard.module.access  → /index.html (default voor admin/manager/etc)
  // - alleen dashboard.sales.view → /modules/sales-dashboard.html (sales-rol)
  // - geen van beide → applyModuleGating verbergt de link
  // index.html doet zelf óók een redirect bij role==='sales' (defense-in-depth).
  async function applyDashboardRouting() {
    try {
      if (!window.RBAC || typeof window.RBAC.ensurePermissionsLoaded !== 'function') return;
      var perms = await window.RBAC.ensurePermissionsLoaded();
      if (perms.has('*')) return; // super_admin → laat default /index.html staan
      var link = document.querySelector('#sidebar-mount [data-module="dashboard"]');
      if (!link) return;
      if (perms.has('dashboard.module.access')) {
        link.setAttribute('href', '/index.html');
      } else if (perms.has('dashboard.sales.view')) {
        link.setAttribute('href', '/modules/sales-dashboard.html');
      }
    } catch (e) { /* fail-open: laat default dashboard-link staan */ }
  }

  // Taken-badge: telt open taken (status != 'done') waar user assignee is.
  // Async, silent fail, idempotent toggle. Identiek patroon als tickets-badge.
  async function updateTakenBadge() {
    var b = document.getElementById('navTakenBadge');
    if (!b) return;
    try {
      if (!window.AgentShared || typeof window.AgentShared.apiFetch !== 'function') return;
      var res = await window.AgentShared.apiFetch('/api/taken-badge');
      if (!res.ok) { b.classList.remove('show'); return; }
      var data = await res.json();
      var n = data.count || 0;
      if (n > 0) { b.textContent = n; b.classList.add('show'); }
      else       { b.textContent = ''; b.classList.remove('show'); }
    } catch (e) { b.classList.remove('show'); }
  }

  // Approvals-badge (D1.6 payment-arrangements — "Open taken (N+M)"):
  //   - GET /api/pending-actions-list?status=PENDING&limit=1 → counts.{PENDING,APPROVED}
  //     (de list-endpoint geeft ALLE counts terug, ongeacht het status-filter — geen 2e call nodig)
  //   - badge-tekst = totaal aantal open taken (N PENDING te beoordelen + M APPROVED te verwerken)
  //   - tooltip toont de splitsing ("Te beoordelen: N + Te verwerken: M")
  //   - alleen renderen als user feature_key 'finance.arrangements.approve' heeft
  //     (lookup via window.RBAC.ensurePermissionsLoaded(); super_admin krijgt '*')
  //   - klik op badge navigeert naar /modules/admin.html#approval-queue (data-target)
  // Pattern: silent fail, idempotent toggle (zelfde als tickets/taken).
  var _approvalsBadgeAllowed = null;     // null | true | false → cached na 1e RBAC-check
  var _approvalsBadgeTimer   = null;     // setInterval handle (cleanup-safe)

  async function approvalsBadgeAllowed() {
    if (_approvalsBadgeAllowed !== null) return _approvalsBadgeAllowed;
    try {
      if (!window.RBAC || typeof window.RBAC.ensurePermissionsLoaded !== 'function') {
        _approvalsBadgeAllowed = false;
        return false;
      }
      var perms = await window.RBAC.ensurePermissionsLoaded();
      _approvalsBadgeAllowed = !!(perms && (perms.has('*') || perms.has('finance.arrangements.approve')));
      return _approvalsBadgeAllowed;
    } catch (e) {
      _approvalsBadgeAllowed = false;
      return false;
    }
  }

  async function updateApprovalsBadge() {
    var b = document.getElementById('navApprovalsBadge');
    if (!b) return;
    var ok = await approvalsBadgeAllowed();
    if (!ok) { b.classList.remove('show'); return; }
    try {
      if (!window.AgentShared || typeof window.AgentShared.apiFetch !== 'function') return;
      // Eén call volstaat: de list-endpoint geeft counts voor ALLE statussen terug,
      // ongeacht het ?status=-filter. We tellen PENDING (te beoordelen) + APPROVED
      // (te verwerken — admin moet handmatig markeren als verwerkt).
      var res = await window.AgentShared.apiFetch('/api/pending-actions-list?status=PENDING&limit=1');
      if (!res.ok) { b.classList.remove('show'); return; }
      var data = await res.json();
      var counts = (data && data.counts) || {};
      var pending  = (typeof counts.PENDING  === 'number') ? counts.PENDING  : 0;
      var approved = (typeof counts.APPROVED === 'number') ? counts.APPROVED : 0;
      var total = pending + approved;
      if (total > 0) {
        b.textContent = 'Open taken (' + total + ')';
        b.setAttribute('title', 'Te beoordelen: ' + pending + ' + Te verwerken: ' + approved);
        b.classList.add('show');
      } else {
        b.textContent = '';
        b.setAttribute('title', 'Open taken');
        b.classList.remove('show');
      }
    } catch (e) { b.classList.remove('show'); }
  }

  // Click-handler op de badge zelf: navigeert naar /modules/admin.html#approval-queue
  // zonder dat de outer <a class="nav-item"> dezelfde href (zonder hash) wint. Wordt
  // 1x gewired bij mount; idempotent via dataset-flag.
  function wireApprovalsBadgeClick() {
    var b = document.getElementById('navApprovalsBadge');
    if (!b || b.dataset.wired === '1') return;
    b.style.cursor = 'pointer';
    b.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var target = b.getAttribute('data-target') || '/modules/admin.html#approval-queue';
      window.location.href = target;
    });
    b.dataset.wired = '1';
  }

  // setInterval-cleanup pattern: bij elke (her)mount stoppen we de vorige timer
  // voor we een nieuwe starten — voorkomt dubbele polling bij SPA-achtige flows.
  // Eén 60s tick update zowel de oude Approvals-badge (Admin-link, backward-compat)
  // als de nieuwe Finance-tasks badge (F1) — bespaart een tweede setInterval.
  function startApprovalsBadgePolling() {
    if (_approvalsBadgeTimer) { clearInterval(_approvalsBadgeTimer); _approvalsBadgeTimer = null; }
    _approvalsBadgeTimer = setInterval(function () {
      updateApprovalsBadge();
      updateFinanceTasksBadge();
    }, 60 * 1000);
    // Stop polling als de tab onzichtbaar wordt (defensief — browser kan tabs
    // throttlen, maar zo zijn we expliciet en sparen we API-calls).
    window.addEventListener('beforeunload', function () {
      if (_approvalsBadgeTimer) { clearInterval(_approvalsBadgeTimer); _approvalsBadgeTimer = null; }
    });
  }

  // Finance-tasks-badge (F1):
  //   - GET /api/tasks-list?status=PENDING,APPROVED&limit=1 → counts.byStatus
  //   - badge-tekst = totaal aantal open finance-taken (PENDING te beoordelen + APPROVED te verwerken)
  //   - alleen renderen als user feature_key 'finance.tasks.view' OF 'finance.arrangements.view' heeft
  //     (super_admin krijgt '*' en ziet altijd)
  //   - klik op badge of nav-item navigeert naar /modules/taken.html?status=PENDING
  // Patroon hergebruikt approvalsBadgeAllowed-cache + silent fail + idempotent toggle.
  var _financeTasksBadgeAllowed = null;     // null | true | false → cached na 1e RBAC-check

  async function financeTasksBadgeAllowed() {
    if (_financeTasksBadgeAllowed !== null) return _financeTasksBadgeAllowed;
    try {
      if (!window.RBAC || typeof window.RBAC.ensurePermissionsLoaded !== 'function') {
        _financeTasksBadgeAllowed = false;
        return false;
      }
      var perms = await window.RBAC.ensurePermissionsLoaded();
      _financeTasksBadgeAllowed = !!(perms && (
        perms.has('*') ||
        perms.has('finance.tasks.view') ||
        perms.has('finance.arrangements.view')
      ));
      return _financeTasksBadgeAllowed;
    } catch (e) {
      _financeTasksBadgeAllowed = false;
      return false;
    }
  }

  async function updateFinanceTasksBadge() {
    var b = document.getElementById('navFinanceTasksBadge');
    if (!b) return;
    var ok = await financeTasksBadgeAllowed();
    if (!ok) { b.classList.remove('show'); return; }
    try {
      if (!window.AgentShared || typeof window.AgentShared.apiFetch !== 'function') return;
      // /api/tasks-list?status=PENDING,APPROVED&limit=1 — list-endpoint geeft counts.byStatus
      // terug voor alle statussen. We tellen PENDING + APPROVED (open + te verwerken).
      var res = await window.AgentShared.apiFetch('/api/tasks-list?status=PENDING,APPROVED&limit=1');
      if (!res.ok) { b.classList.remove('show'); return; }
      var data = await res.json();
      var by = (data && (data.counts && (data.counts.byStatus || data.counts))) || {};
      var pending  = (typeof by.PENDING  === 'number') ? by.PENDING  : 0;
      var approved = (typeof by.APPROVED === 'number') ? by.APPROVED : 0;
      var total = pending + approved;
      if (total > 0) {
        b.textContent = total;
        b.setAttribute('title', 'Te beoordelen: ' + pending + ' + Te verwerken: ' + approved);
        b.classList.add('show');
      } else {
        b.textContent = '';
        b.setAttribute('title', 'Open taken');
        b.classList.remove('show');
      }
    } catch (e) { b.classList.remove('show'); }
  }

  // Click-handler op de finance-tasks badge: voorkomt dat de outer <a class="nav-item">
  // dezelfde href (zonder ?status=PENDING) wint. Idempotent via dataset-flag.
  function wireFinanceTasksBadgeClick() {
    var b = document.getElementById('navFinanceTasksBadge');
    if (!b || b.dataset.wired === '1') return;
    b.style.cursor = 'pointer';
    b.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var target = b.getAttribute('data-target') || '/modules/taken.html?status=PENDING';
      window.location.href = target;
    });
    b.dataset.wired = '1';
  }

  // Tickets-badge: telt open + in_progress tickets toegewezen aan ingelogde user.
  // Async, silent fail (badge update is niet kritiek), idempotent toggle.
  async function updateTicketsBadge() {
    var b = document.getElementById('navTicketsBadge');
    if (!b) return;
    try {
      if (!window.AgentShared || typeof window.AgentShared.apiFetch !== 'function') return;
      var res = await window.AgentShared.apiFetch('/api/tickets-badge');
      if (!res.ok) {
        b.classList.remove('show');
        return;
      }
      var data = await res.json();
      var n = data.count || 0;
      if (n > 0) {
        b.textContent = n;
        b.classList.add('show');
      } else {
        b.textContent = '';
        b.classList.remove('show');
      }
    } catch (e) {
      b.classList.remove('show');
    }
  }

  // ── RBAC module-gating (fail-open, consistent met email-enforcement) ────────
  // data-module gebruikt koppeltekens (control-center/follow-up); de feature-keys
  // niet (controlcenter./followup.) — daarom een expliciete mapping.
  var MODULE_FEATURE_MAP = {
    'dashboard': 'dashboard.module.access',
    'sales-dashboard': 'dashboard.sales.view',
    'klanten': 'customer.module.access',
    'email': 'email.module.access',
    'lisa': 'lisa.module.access',
    'taken': 'taken.module.access',
    'kennisbank': 'kennisbank.module.access',
    'agents': 'agents.module.access',
    'meetings': 'meetings.module.access',
    'control-center': 'controlcenter.module.access',
    'follow-up': 'followup.module.access',
    'tickets': 'tickets.module.access',
    'sales': 'sales.module.access',
    'finance': 'finance.module.access',
    // F1: nieuwe Taken-module (sidebar-only data-module — niet gekoppeld aan een unieke
    // .html page-name; klik routeert naar /modules/taken.html). Gating is fail-open zoals
    // de rest: zonder finance.tasks.view wordt de sidebar-link verborgen, maar de
    // /modules/taken.html pagina valt nog steeds onder de bestaande 'taken'-module-gate.
    'finance-tasks': 'finance.tasks.view',
    'admin': 'admin.module.access'
  };

  function blockPageAccess() {
    if (document.querySelector('.rbac-no-access')) return;
    Array.prototype.forEach.call(document.body.children, function (el) {
      if (el.id === 'sidebar-mount' || el.tagName === 'SCRIPT') return;
      el.style.display = 'none';
    });
    var div = document.createElement('div');
    div.className = 'rbac-no-access';
    div.style.cssText = 'margin-left:220px;padding:64px 24px;text-align:center;font-family:Inter,system-ui,sans-serif;color:var(--text-dim,#64748b);';
    div.innerHTML =
      '<h2 style="font-size:20px;font-weight:700;margin:0 0 8px;color:var(--text,#0f172a)">Geen toegang</h2>' +
      '<p style="font-size:14px;margin:0 0 16px">Je hebt geen rechten om deze module te bekijken.</p>' +
      '<a href="/index.html" style="font-size:13px;color:var(--accent-violet,#6d28d9);text-decoration:underline">Terug naar dashboard</a>';
    document.body.appendChild(div);
  }

  async function applyModuleGating() {
    if (!window.RBAC || typeof window.RBAC.ensurePermissionsLoaded !== 'function') return; // geen helper → fail-open
    var perms;
    try { perms = await window.RBAC.ensurePermissionsLoaded(); } catch (e) { return; }      // laadfout → fail-open
    var roles = (typeof window.RBAC.getUserRoles === 'function' && window.RBAC.getUserRoles()) || [];
    if (!roles.length) return;   // geen rollen / laadfout → fail-open (niets verbergen)
    if (perms.has('*')) return;  // super_admin → alles zichtbaar

    // 1) Sidebar-links verbergen zonder <module>.module.access.
    //    Dashboard speciaal: zichtbaar als user OFWEL module.access OF sales.view
    //    heeft (sales-rol heeft alleen die laatste).
    Object.keys(MODULE_FEATURE_MAP).forEach(function (modKey) {
      var link = document.querySelector('#sidebar-mount [data-module="' + modKey + '"]');
      if (!link) return;
      if (modKey === 'dashboard') {
        var ok = perms.has('dashboard.module.access') || perms.has('dashboard.sales.view');
        if (!ok) link.style.display = 'none';
      } else if (!perms.has(MODULE_FEATURE_MAP[modKey])) {
        link.style.display = 'none';
      }
    });

    // 2) Pagina-content blokkeren bij directe URL (defense-in-depth).
    //    email.html regelt dit zelf → hier overslaan om dubbele melding te voorkomen.
    var cur = currentModule();
    if (cur === 'email') return;
    // Dashboard speciaal: niet blokkeren als user dashboard.sales.view heeft;
    // index.html doet zelf een redirect naar /modules/sales-dashboard.html.
    if (cur === 'dashboard') {
      if (!perms.has('dashboard.module.access') && !perms.has('dashboard.sales.view')) blockPageAccess();
      return;
    }
    var fk = MODULE_FEATURE_MAP[cur];
    if (fk && !perms.has(fk)) blockPageAccess();
  }

  function mountSidebar() {
    var mount = document.getElementById('sidebar-mount');
    if (!mount || mount.dataset.mounted === '1') return;
    mount.innerHTML = buildSidebarHtml();
    mount.dataset.mounted = '1';

    highlightActive();
    updateTakenBadge();
    updateTicketsBadge();
    wireApprovalsBadgeClick();
    wireFinanceTasksBadgeClick();
    updateApprovalsBadge();
    updateFinanceTasksBadge();
    startApprovalsBadgePolling();
    applyAdminGating();
    applyDashboardRouting();
    // Footer (gebruiker + theme-toggle) via bestaande gedeelde helper.
    if (window.AgentShared && typeof window.AgentShared.renderUserSection === 'function') {
      window.AgentShared.renderUserSection();
    }
    // RBAC module-gating (fail-open): laadt permissions, verbergt ontoegankelijke
    // sidebar-links én blokkeert de pagina-content bij directe URL zonder toegang.
    applyModuleGating();
    // Laat pagina-scripts weten dat de sidebar-DOM klaar is (bv. nav-badge updates
    // die anders kunnen racen met de mount).
    window.dispatchEvent(new CustomEvent('sidebar:mounted'));
  }

  // Expose refresh-trigger voor externe modules (tickets-detail.html na PATCH).
  // window.AgentShared bestaat al — agent-shared.js wordt eerder geladen.
  if (window.AgentShared) {
    window.AgentShared.refreshTicketsBadge      = updateTicketsBadge;
    window.AgentShared.refreshTakenBadge        = updateTakenBadge;
    window.AgentShared.refreshApprovalsBadge    = updateApprovalsBadge;
    window.AgentShared.refreshFinanceTasksBadge = updateFinanceTasksBadge;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountSidebar);
  } else {
    mountSidebar();
  }
})();
