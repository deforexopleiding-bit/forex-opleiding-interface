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
    // lucide "broadcast" — centrale agent-controle (Fase 1 hub voor alle
    // joost_config-agents + read-only Lisa-status).
    'agent-center': '<path d="M5 20a14 14 0 0 1 0-16"/><path d="M9.5 16.5a8 8 0 0 1 0-9"/><circle cx="12" cy="12" r="2"/><path d="M14.5 16.5a8 8 0 0 0 0-9"/><path d="M19 20a14 14 0 0 0 0-16"/>',
    meetings: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    'control-center': '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
    'follow-up': '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
    admin: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    whatsapp: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>',
    contracten: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
    finance: '<path d="M12 2v20"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    sales: '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>',
    // lucide "calendar-event" — visueel duidelijk onderscheid van meetings (people-group).
    events: '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><rect x="8" y="14" width="8" height="5" rx="1"/>',
    tickets: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 11v2"/><path d="M13 17v2"/>',
    onboarding: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    // lucide "user-plus" — onboarding-hub-entry (sidebar gebruikt de sleutel
    // 'onboarding-admin'; zonder eigen icon-mapping bleef de regel iconloos).
    'onboarding-admin': '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/>',
    // lucide "graduation-cap" — onderscheid van events (calendar) en agents (avatar).
    'mentor-dashboard': '<path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/>',
    // lucide "users" — Studenten-pagina voor de mentor-rol (Fase A2). Eigen sidebar-entry
    // naast mentor-dashboard; mentor-dashboard blijft in deze fase intact.
    'mentor-students': '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    // lucide "users-shield" — admin per-mentor meekijken; eenvoudige user+shield.
    'mentor-detail': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 16l3 1.5V21l-3 1.5-3-1.5v-3.5z"/>',
    // lucide "receipt" — payout-rapport admin (finance/strateeg).
    'mentor-payouts-admin': '<path d="M4 4h16v18l-3-2-2 2-2-2-2 2-2-2-2 2-3-2z"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="16" y2="13"/>',
    // lucide "school" — admin-brede studenten-overzichtspagina (A1).
    'students-overview': '<path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/><circle cx="12" cy="22" r="0.5"/>',
    // lucide "certificate" — funded-certificaten admin.
    'funded-certificates-admin': '<rect x="3" y="4" width="18" height="14" rx="2"/><circle cx="12" cy="11" r="3"/><path d="M9 21l3-3 3 3"/>',
    // lucide "users-cog" — Mentoren beheer (consolidatie van 3 admin-modules).
    'mentoren-beheer': '<circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/><circle cx="18" cy="14" r="2"/><path d="M18 9v2M18 17v2M22 14h-2M14 14h2"/>'
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
          navLink('lisa', '/modules/lisa.html', 'Appointment setting') +
          '<a class="nav-item" data-module="taken" href="/modules/taken.html">' + svg('taken') + 'Takenbeheer<span class="nav-badge" id="navTakenBadge"></span></a>' +
          navLink('kennisbank', '/modules/kennisbank.html', 'Kennisbank') +
          navLink('agents', '/modules/agents.html', 'AI Agents') +
          // Agent command center (Fase 1) — centrale hub voor joost_config-agents
          // (Joost / Simone / Mila) + read-only Lisa-status. Gegate op
          // admin.joost_config; pagina-init doet defense-in-depth check.
          navLink('agent-center', '/modules/agent-center.html', 'Agent center') +
          navLink('meetings', '/modules/meetings.html', 'Vergaderruimte') +
          navLink('control-center', '/modules/control-center.html', 'Control Center') +
          navLink('follow-up', '/modules/follow-up.html', 'Follow-up') +
          navLink('sales', '/modules/sales.html', 'Sales') +
          navLink('events', '/modules/events.html', 'Events') +
          // PR-A — mentor-grootboek is verhuisd naar Events → Mentor-grootboek-tab.
          // Sidebar-entry verwijderd; deeplink events.html#mentor-grootboek werkt.
          // Mentor-dashboard PR-1 — self-service voor mentor-rol; gated via
          // mentor.module.access (zie MODULE_FEATURE_MAP). Voor andere rollen
          // verbergt applyModuleGating de link.
          navLink('mentor-dashboard', '/modules/mentor-dashboard.html', 'Mentor-dashboard') +
          // Studenten-pagina (Fase A2) — aparte hub voor de mentor met Mijn studenten,
          // Toekomstige studenten, en 1-op-1 sessies. Page-gate: mentor.module.access.
          navLink('mentor-students', '/modules/mentor-students.html', 'Studenten') +
          // Mentoren beheer — consolidatie van Mentor-overzicht / Payout-rapporten /
          // Certificaten (admin). De drie pagina's blijven bestaan via directe URL,
          // maar de sidebar toont alleen nog dit ene item. Zichtbaarheid: zodra de
          // user minstens één van de drie rechten heeft (zie applyModuleGating).
          navLink('mentoren-beheer', '/modules/mentoren-beheer.html', 'Mentoren beheer') +
          // A1 — Alle studenten org-breed (super_admin + manager). Page-gate
          // blijft op de directe URL actief; sidebar verbergt voor andere rollen.
          navLink('students-overview', '/modules/students-overview.html', 'Alle studenten') +
          // Onboarding (F0 admin-dashboard, sinds Hub-merge Fase 1 op /modules/onboarding-hub.html).
          // /modules/onboarding.html blijft de klant-facing wizard (token-link); de hub krijgt
          // een eigen URL zodat bestaande onboarding-uitnodigingen niet breken. Gegate op
          // onboarding.admin (zelfde permission-key als de oude admin-pagina).
          navLink('onboarding-admin', '/modules/onboarding-hub.html', 'Onboarding') +
          // Wizard-editor + Automations zijn sinds Hub-merge Fase 2/3 secties
          // binnen /modules/onboarding-hub.html. De losse sidebar-entries zijn
          // hier verwijderd. De standalone-pagina's blijven via directe URL
          // bereikbaar als safety-net (dormant).
          // Finance — Mega-restructure: badge voor Open Acties (F1 finance-taken) hangt
          // nu inline op de Finance nav-item zelf. Open Acties is verhuisd naar
          // /modules/finance.html?tab=wanbetalers&sub=open-acties (sub-tab onder Wanbetalers).
          // Backward-compat: /modules/open-acties.html bestaat nog als thin redirector
          // (toont melding + auto-redirect na 2s).
          '<a class="nav-item" data-module="finance" href="/modules/finance.html">' +
            svg('finance') + 'Finance' +
            '<span class="nav-badge" id="navFinanceTasksBadge" data-target="/modules/finance.html?tab=wanbetalers&sub=open-acties&status=PENDING" title="Open acties"></span>' +
          '</a>' +
          '<a class="nav-item" data-module="tickets" href="/modules/tickets.html">' + svg('tickets') + 'Tickets<span class="nav-badge" id="navTicketsBadge"></span></a>' +
          // Admin nav-item incl. approval-badge (D1 payment-arrangements). De badge zelf
          // linkt nu naar /modules/open-acties.html?status=PENDING (cleanere UX dan de oude
          // Admin#approval-queue ingang); admin.html#approval-queue blijft bestaan als
          // secundaire/backward-compat route maar wordt niet meer als badge-target gebruikt.
          // Badge wordt alleen zichtbaar bij PENDING+APPROVED > 0 én als de user de
          // feature_key finance.arrangements.approve heeft (zie updateApprovalsBadge).
          '<a class="nav-item" data-module="admin" id="adminNavLink" href="/modules/admin.html" style="display:none">' +
            svg('admin') + 'Admin' +
            '<span class="nav-badge" id="navApprovalsBadge" data-target="/modules/open-acties.html?status=PENDING" title="Open acties"></span>' +
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
    // mentor-home.html is de nieuwe landing voor de mentor-rol — alias naar
    // de bovenste Dashboard-link zodat die actief oplicht (zelfde pattern
    // als sales-dashboard hierboven). mentor-dashboard.html blijft een
    // aparte sidebar-entry voor de detailpagina.
    if (cur === 'mentor-home') cur = 'dashboard';
    // events-detail.html + events-wizard.html + events-automations.html highlighten onder de Events-link
    if (cur === 'events-detail' || cur === 'events-wizard' || cur === 'events-automations') cur = 'events';
    // open-acties.html is verhuisd naar Finance > Wanbetalers > Open Acties sub-tab.
    // Backward-compat: redirector-pagina bestaat nog en highlight onder Finance.
    if (cur === 'open-acties') cur = 'finance';
    // wanbetalers.html (legacy) highlight valt onder Finance — die module is volledig
    // gemigreerd naar finance.html?tab=wanbetalers (mega-restructure).
    if (cur === 'wanbetalers') cur = 'finance';
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

  // Dashboard-link href op basis van PRIMAIRE rol (profiles.role) — single
  // source of truth via AuthShared.getRoleLandingUrl, identieke mapping als
  // de post-login-redirect in login.html. Zet ALLEEN het href-attribute;
  // doet zelf GEEN redirect (loop-preventie: de hele app heeft maar één
  // redirect-bron, namelijk login.html's redirectAfterLogin). Onbekende /
  // ontbrekende rol → '/index.html' (whitelist-fallback in de helper).
  // index.html behoudt zelf de defensive role==='sales'-redirect die er al
  // stond — die blijft ongewijzigd.
  //
  // KRITIEK: mountSidebar() doet GEEN await _authSharedReady (loop direct
  // op DOMContentLoaded). Bij eerste page-load kan de Supabase-sessie-
  // warmup nog niet klaar zijn waardoor getSession()/getUser()/getProfile()
  // null returnt → role-mapping valt terug op '/index.html'. We waiten
  // hier expliciet op _authSharedReady zodat de routing pas runt nadat de
  // sessie hersteld is. Op latere mounts (snelle storage-cache) heeft dat
  // geen merkbare cost.
  async function applyDashboardRouting() {
    try {
      var link = document.querySelector('#sidebar-mount [data-module="dashboard"]');
      if (!link) return;
      // Wacht op session-warmup zodat getProfile betrouwbaar resolved.
      try { if (window._authSharedReady) await window._authSharedReady; } catch (_) {}
      if (!window.AuthShared || typeof window.AuthShared.getProfile !== 'function') return;
      if (typeof window.AuthShared.getRoleLandingUrl !== 'function') return;
      var profile = await window.AuthShared.getProfile();
      if (!profile) {
        // Eénmalig re-try met session-warmup voor de zeldzame race waarbij
        // _authSharedReady wel resolved is maar getSession nog niet hot is.
        try { await window.AuthShared.getSession(); } catch (_) {}
        profile = await window.AuthShared.getProfile();
      }
      var role = profile && profile.role;
      if (!role) {
        console.warn('[sidebar.applyDashboardRouting] geen rol uit profiel — laat default-link staan');
        return; // bewust GEEN '/index.html' setten — laat hardcoded default staan
      }
      var url = window.AuthShared.getRoleLandingUrl(role) || '/index.html';
      link.setAttribute('href', url);
    } catch (e) {
      console.warn('[sidebar.applyDashboardRouting]', e && e.message ? e.message : e);
      /* fail-open: laat default dashboard-link staan */
    }
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
  //   - klik op badge navigeert naar /modules/open-acties.html?status=PENDING (F1 polish:
  //     consistent met Open Acties-badge; admin.html#approval-queue blijft bestaan als
  //     backward-compat tab maar is geen badge-target meer)
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

  // Click-handler op de badge zelf: navigeert naar /modules/open-acties.html?status=PENDING
  // (F1 polish: was /modules/admin.html#approval-queue; nu consistent met Open Acties-badge).
  // Voorkomt dat de outer <a class="nav-item"> dezelfde href (zonder hash/query) wint.
  // Wordt 1x gewired bij mount; idempotent via dataset-flag.
  function wireApprovalsBadgeClick() {
    var b = document.getElementById('navApprovalsBadge');
    if (!b || b.dataset.wired === '1') return;
    b.style.cursor = 'pointer';
    b.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var target = b.getAttribute('data-target') || '/modules/open-acties.html?status=PENDING';
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
  //   - klik op badge of nav-item navigeert naar /modules/open-acties.html?status=PENDING
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
  // dezelfde href (zonder query) wint. Idempotent via dataset-flag.
  // Target migreerde van /modules/open-acties.html naar
  // /modules/finance.html?tab=wanbetalers&sub=open-acties&status=PENDING.
  function wireFinanceTasksBadgeClick() {
    var b = document.getElementById('navFinanceTasksBadge');
    if (!b || b.dataset.wired === '1') return;
    b.style.cursor = 'pointer';
    b.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      var target = b.getAttribute('data-target') || '/modules/finance.html?tab=wanbetalers&sub=open-acties&status=PENDING';
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
    // Agent command center (Fase 1) — admin-only hub. Page-init checkt zelf
    // óók via window.RBAC.canSync (defense-in-depth, mirror events-automations).
    'agent-center': 'admin.joost_config',
    'meetings': 'meetings.module.access',
    'control-center': 'controlcenter.module.access',
    'follow-up': 'followup.module.access',
    'tickets': 'tickets.module.access',
    'sales': 'sales.module.access',
    'events': 'events.module.access',
    // PR-A — mentor-grootboek-key verwijderd; pagina is verhuisd naar
    // Events → Mentor-grootboek-tab. RBAC mentor.ledger.view blijft als
    // endpoint-gate; sidebar-entry bestaat niet meer dus geen module-gating.
    // events-detail.html + events-wizard.html + events-automations.html erven dezelfde
    // module.access-gate (de pagina's checken zelf óók via window.RBAC.canSync in init()
    // — defense-in-depth).
    'events-detail': 'events.module.access',
    'events-wizard': 'events.module.access',
    'events-automations': 'events.module.access',
    // Mentor-dashboard PR-1 — sidebar-link + page-gating via mentor.module.access.
    // Endpoint-gate (mentor-my-events/-calendar) doet dezelfde check; deze is voor UX.
    'mentor-dashboard': 'mentor.module.access',
    'mentor-students': 'mentor.module.access',
    // Mentor-detail PR-4 — admin per-mentor meekijken. Manager+ rollen krijgen
    // mentor.admin.view via de role_permissions grant; mentors zelf niet.
    'mentor-detail': 'mentor.admin.view',
    // Payout fase 1 — finance/strateeg-tool. mentor.payout.manage (manager+).
    // Page-gate blijft op de directe URL actief (defense-in-depth).
    'mentor-payouts-admin': 'mentor.payout.manage',
    // A1 — Alle studenten overzicht (manager via 016; super_admin via '*').
    'students-overview': 'students.all.view',
    // Funded-certificaten admin (alle €100-claims + downloads). Page-gate
    // blijft op de directe URL actief.
    'funded-certificates-admin': 'mentor.funded.admin',
    // Mentoren beheer — speciaal: ANY-of-3 (zie applyModuleGating onderaan).
    // Geen vaste feature_key hier; de OR-check is daar gehardcodeerd.
    'mentoren-beheer': '__any_mentor_admin__',
    // F0 onboarding-admin (`onboardings`-tabel) — read/write op onboarding.admin.
    // Sinds Hub-merge wijst de entry naar /modules/onboarding-hub.html waar
    // Overzicht / Wizard / Automations als secties zitten. De RBAC-mappings
    // voor 'onboarding-wizard-editor' (onboarding.wizard.edit) en
    // 'onboarding-automations' (onboarding.automation.view) zijn samen met
    // hun nav-entries verwijderd — ze hadden geen externe consumers.
    'onboarding-admin': 'onboarding.admin',
    'finance': 'finance.module.access',
    // Open Acties (F1 finance-taken) is verhuisd naar Finance > Wanbetalers > Open Acties
    // sub-tab — geen eigen sidebar-link meer. Badge hangt nu op de Finance nav-item zelf.
    // Backward-compat: /modules/open-acties.html bestaat als redirector. RBAC-gating voor
    // de badge (finance.tasks.view) zit in financeTasksBadgeAllowed() hieronder.
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
    //    Mentoren beheer speciaal: zichtbaar als user minstens ÉÉN van de vier
    //    onderliggende rechten heeft (mentor.admin.view / mentor.payout.manage /
    //    mentor.funded.admin / mentor.assessments.admin) — de pagina zelf verbergt
    //    de specifieke tabs op basis van per-tab rechten.
    Object.keys(MODULE_FEATURE_MAP).forEach(function (modKey) {
      var link = document.querySelector('#sidebar-mount [data-module="' + modKey + '"]');
      if (!link) return;
      if (modKey === 'dashboard') {
        var ok = perms.has('dashboard.module.access') || perms.has('dashboard.sales.view');
        if (!ok) link.style.display = 'none';
      } else if (modKey === 'mentoren-beheer') {
        var okM = perms.has('mentor.admin.view') || perms.has('mentor.payout.manage') || perms.has('mentor.funded.admin') || perms.has('mentor.assessments.admin');
        if (!okM) link.style.display = 'none';
      } else if (modKey === 'onboarding-admin') {
        // Fase 2a: Onboarding-hub-entry zichtbaar voor onboarding.admin
        // (manager/super_admin) ÉN voor onboarding.view_own (mentor ziet
        // alleen eigen studenten, server-side scoped). De hub-pagina zelf
        // gate't met dezelfde OR-check; alle admin-acties blijven gegate
        // op hun eigen feature_keys (server-side autoritatief).
        var okOnb = perms.has('onboarding.admin') || perms.has('onboarding.view_own');
        if (!okOnb) link.style.display = 'none';
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
    if (cur === 'mentoren-beheer') {
      var okMB = perms.has('mentor.admin.view') || perms.has('mentor.payout.manage') || perms.has('mentor.funded.admin') || perms.has('mentor.assessments.admin');
      if (!okMB) blockPageAccess();
      return;
    }
    var fk = MODULE_FEATURE_MAP[cur];
    if (fk && !perms.has(fk)) blockPageAccess();
  }

  // ── Layout-laag (admin-config bovenop RBAC) ────────────────────────────────
  // app_settings.sidebar_layout = { items: [{ key, visible }] } in
  // gewenste sidebar-volgorde. Toegepast NA buildSidebarHtml, VÓÓR
  // applyModuleGating zodat RBAC autoritatief blijft (visible=true + geen
  // RBAC = nog steeds verborgen). Fail-open: 404 / fetch-fout → niets doen
  // en laat default-volgorde + alles-zichtbaar staan. De 'admin'-entry
  // wordt nooit verborgen (anti-lockout) en kan niet uit de DOM raken.
  async function applySidebarLayout() {
    var nav, items, layout;
    try {
      if (!window.AgentShared || typeof window.AgentShared.apiFetch !== 'function') return;
      var res = await window.AgentShared.apiFetch('/api/app-settings?key=sidebar_layout');
      if (!res.ok) return; // 404/500 → fail-open
      var data = await res.json();
      layout = data && data.value;
      if (!layout || !Array.isArray(layout.items) || layout.items.length === 0) return;
    } catch (e) {
      return; // network/JSON error → fail-open
    }

    nav = document.querySelector('#sidebar-mount .sidebar-nav');
    if (!nav) return;

    // Index per nav-key → DOM-element (uitsluitend nav-items met data-module).
    items = {};
    Array.prototype.forEach.call(nav.querySelectorAll('[data-module]'), function (el) {
      var k = el.getAttribute('data-module');
      if (k) items[k] = el;
    });

    // 1) Verberg-toggle volgens config. Skip 'admin' (anti-lockout) — die
    //    blijft altijd zichtbaar voor wie er RBAC-recht op heeft (applyAdminGating
    //    + applyModuleGating sturen 'm); de layout-laag mag 'm niet uitzetten.
    layout.items.forEach(function (cfg) {
      if (!cfg || typeof cfg.key !== 'string') return;
      if (cfg.key === 'admin') return; // beschermd
      var el = items[cfg.key];
      if (!el) return;
      if (cfg.visible === false) {
        el.style.display = 'none';
        el.dataset.layoutHidden = '1'; // marker voor debug/inspectie
      }
    });

    // 2) Volgorde toepassen: re-attach in config-volgorde.
    //    Items die niet in de config staan (nieuwe modules, of de
    //    "Binnenkort"-sectie + concepts) behouden hun originele positie
    //    door eerst de config-items naar de top te schuiven; daarna laat
    //    de DOM de niet-genoemde items op hun relatieve plek.
    var insertAnchor = nav.firstChild;
    layout.items.forEach(function (cfg) {
      if (!cfg || typeof cfg.key !== 'string') return;
      var el = items[cfg.key];
      if (!el) return;
      nav.insertBefore(el, insertAnchor);
      insertAnchor = el.nextSibling;
    });
  }

  // ── Impersonation-banner ─────────────────────────────────────────────────
  // Persistente rode banner bovenin elke pagina zolang AuthShared.isImpersonating()
  // true is. Toont "Je bekijkt als <naam> (<rol>)" + een "Terug naar jezelf"-knop.
  //
  // De banner is fixed-top en duwt de body met top-padding naar beneden zodat
  // content niet onder de banner valt. Idempotent: 2e mount-call vervangt de
  // bestaande banner i.p.v. dubbel renderen.
  //
  // Fail-safe: als origin-sessie ontbreekt of setSession faalt, signOut +
  // /login.html (nooit vasthangen in een vreemde sessie).
  function renderImpersonationBanner() {
    var existing = document.getElementById('impersonation-banner');
    if (!window.AuthShared || typeof window.AuthShared.isImpersonating !== 'function'
        || !window.AuthShared.isImpersonating()) {
      if (existing) existing.remove();
      document.body.style.paddingTop = '';
      return;
    }
    var state = window.AuthShared.getImpersonationState() || {};
    var label = state.target_name || state.target_email || 'onbekend';
    var role  = state.target_role || '';
    var escFn = function (s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
      });
    };
    var html =
      '<div style="background:#dc2626;color:#fff;padding:10px 18px;display:flex;align-items:center;justify-content:space-between;gap:14px;font-size:13.5px;font-family:Inter,system-ui,sans-serif;font-weight:600;box-shadow:0 2px 8px rgba(0,0,0,0.25)">' +
        '<div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">' +
          '<svg style="width:16px;height:16px;flex-shrink:0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M12 9v4M12 17h.01"/><circle cx="12" cy="12" r="10"/>' +
          '</svg>' +
          '<span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Je bekijkt als <strong>' + escFn(label) + '</strong>' +
          (role ? ' <span style="opacity:.85;font-weight:500">(' + escFn(role) + ')</span>' : '') +
          '</span>' +
        '</div>' +
        '<button type="button" id="impersonation-stop-btn" style="background:#fff;color:#dc2626;border:0;border-radius:6px;padding:6px 14px;font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap">' +
          '&larr; Terug naar jezelf' +
        '</button>' +
      '</div>';
    if (existing) {
      existing.innerHTML = html;
    } else {
      var div = document.createElement('div');
      div.id = 'impersonation-banner';
      div.style.position = 'fixed';
      div.style.top = '0';
      div.style.left = '0';
      div.style.right = '0';
      div.style.zIndex = '99999';
      div.innerHTML = html;
      document.body.appendChild(div);
    }
    var bannerEl = document.getElementById('impersonation-banner');
    if (bannerEl) document.body.style.paddingTop = bannerEl.offsetHeight + 'px';
    var btn = document.getElementById('impersonation-stop-btn');
    if (btn) btn.addEventListener('click', stopImpersonation);
  }

  async function stopImpersonation() {
    var btn = document.getElementById('impersonation-stop-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Bezig…'; }
    var origin = window.AuthShared ? window.AuthShared.getImpersonationOrigin() : null;
    // FAIL-SAFE: geen / corrupte origin-sessie → signOut + /login.html
    // zodat de gebruiker nooit vast komt te zitten in een vreemde sessie.
    if (!origin || !origin.access_token || !origin.refresh_token) {
      try { if (window.AuthShared) window.AuthShared.clearImpersonationState(); } catch (e) {}
      try { if (window.AuthShared) window.AuthShared.clearImpersonationOrigin(); } catch (e) {}
      try {
        if (window.supabase && window.supabase.auth) await window.supabase.auth.signOut();
      } catch (e) { /* niet-blokkerend */ }
      window.location.href = '/login.html?error=impersonation_lost';
      return;
    }
    try {
      var r = await window.AuthShared.setSession({
        access_token:  origin.access_token,
        refresh_token: origin.refresh_token,
      });
      if (r && r.error) throw new Error(r.error.message || String(r.error));
      window.AuthShared.clearImpersonationOrigin();
      window.AuthShared.clearImpersonationState();
      window.location.href = '/index.html';
    } catch (e) {
      // Fail-safe bij setSession-fout: alles wegmieteren + signOut + login.
      try { window.AuthShared.clearImpersonationOrigin(); } catch (_) {}
      try { window.AuthShared.clearImpersonationState(); } catch (_) {}
      try { await window.supabase.auth.signOut(); } catch (_) {}
      window.location.href = '/login.html?error=impersonation_restore';
    }
  }
  // Beschikbaar maken voor externe scripts (bv. login-page error-handler).
  window.stopImpersonation = stopImpersonation;

  // Globale "Nieuwe taak"-knop: dynamische lazy-load van quick-task.js.
  // Pad wordt afgeleid uit deze sidebar.js' eigen src zodat het zowel onder
  // /modules/shared/ als achter een andere base-prefix werkt. Eénmalig
  // (data-flag) zodat herhaalde mountSidebar()-calls niet stapelen.
  function loadQuickTask() {
    try {
      if (window.__quickTaskScriptLoaded) return;
      window.__quickTaskScriptLoaded = true;
      var ownSrc = null;
      var nodes = document.querySelectorAll('script[src]');
      for (var i = 0; i < nodes.length; i++) {
        var s = nodes[i].getAttribute('src') || '';
        if (/\/sidebar\.js(\?|$)/.test(s)) { ownSrc = s; break; }
      }
      var url = ownSrc ? ownSrc.replace(/sidebar\.js(\?.*)?$/, 'quick-task.js$1') : '/modules/shared/quick-task.js';
      var tag = document.createElement('script');
      tag.src = url;
      tag.defer = true;
      tag.dataset.role = 'quick-task';
      document.head.appendChild(tag);
    } catch (e) {
      // Quick-task is non-essential — sidebar mag nooit breken op deze load.
      try { console.warn('[sidebar] quick-task lazy-load:', e?.message || e); } catch (_) {}
    }
  }

  function mountSidebar() {
    var mount = document.getElementById('sidebar-mount');
    if (!mount || mount.dataset.mounted === '1') return;
    mount.innerHTML = buildSidebarHtml();
    mount.dataset.mounted = '1';

    // Impersonatie-banner (fail-soft, idempotent).
    try { renderImpersonationBanner(); } catch (e) { console.warn('[sidebar] impersonation banner:', e?.message || e); }

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
    // Sidebar-layout laag (admin-config) BOVENOP RBAC: filter + sort items
    // volgens app_settings.sidebar_layout. Fail-open bij fetch-fout zodat
    // een lege/onbereikbare config nooit een lege sidebar oplevert. De
    // RBAC module-gating eronder blijft autoritatief.
    applySidebarLayout();
    // RBAC module-gating (fail-open): laadt permissions, verbergt ontoegankelijke
    // sidebar-links én blokkeert de pagina-content bij directe URL zonder toegang.
    applyModuleGating();
    // Laat pagina-scripts weten dat de sidebar-DOM klaar is (bv. nav-badge updates
    // die anders kunnen racen met de mount).
    window.dispatchEvent(new CustomEvent('sidebar:mounted'));
    // Globale "Nieuwe taak"-knop: gegate op taken.task.create binnen quick-task.js.
    loadQuickTask();
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
