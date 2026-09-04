// modules/shared/design-system/app-shell.js
//
// App-shell helpers voor het redesign — Fase 0-B2.
// 1-op-1 pariteit met systeemprototype-v45.html JS-blok (r.1054-1200 +
// helper-functies r.6714-6881).
//
// Wat deze file levert (via `window.DFO`):
//   - ROLES / A / SA / SAM / SAMS / SAMSM / SAMMK  — rol-sets
//   - MODS                                          — 25 modules
//   - TAB_RESTRICT / MOD_LOCK / GLOW                — gate-tabellen
//   - State-object S + helpers                     — key/F/setF/visMods/
//                                                    curMod/roleTabs/
//                                                    modLocked/modCanOpen/
//                                                    modUsable/me()
//   - setRole / goMod / goTab / render             — nav-drivers
//   - renderNav / applyColor / toggleNav           — shell-render
//   - openPanel / closePanel / stepRow / showHint  — zijpaneel
//   - openModal / closeModal                       — modal-injectie
//   - toggleTheme / applyStoredTheme               — dark-mode toggle
//                                                    (localStorage,
//                                                    GEEN prefers-color)
//   - avc / ini / eur / eur0                       — kleine bouwstenen
//
// Consumenten (module-scripts) implementeren:
//   window.DFO.VIEWS[`${mod}/${tab}`] = () => 'html-string'
//   window.DFO.VIEWS[`${mod}/`]       = () => 'html-string'  // fallback
// De shell roept die view aan bij elke render(). Als er geen view is
// wordt genericView() gebruikt (leeg-state met module-naam).
//
// Vereist: icons.js (voor I + svg) én tokens.css + app-shell.css.

(function () {
  const NS = (window.DFO = window.DFO || {});
  // icons.js moet eerder geladen zijn — anders vroeg falen zodat de fout
  // bij page-init duidelijk zichtbaar wordt.
  if (!NS.I || !NS.svg) {
    console.error('[DFO app-shell] icons.js is niet geladen. Laad modules/shared/design-system/icons.js VOOR app-shell.js.');
    return;
  }
  const { I, svg } = NS;

  /* ── Rol-sets ────────────────────────────────────────────────────── */
  // BP2 (2026-09-01): 'appointmentsetter' toegevoegd zodat setRoles-filter
  // 'em niet meer weggooit en fail-open op super_admin valt.
  // Persoon-veld is een mock-placeholder; echte naam-lookup uit profiles
  // is een aparte verbetering. Voor nu: neutraal label.
  const ROLES = {
    super_admin:       { naam: 'Super admin',    persoon: 'Amigo Biemold' },
    manager:           { naam: 'Manager',        persoon: 'Jeffrey Biemold' },
    sales:             { naam: 'Sales',          persoon: 'Joost Berg' },
    mentor:            { naam: 'Mentor',         persoon: 'Dave Klaassen' },
    marketing:         { naam: 'Marketing',      persoon: 'Nog niet toegewezen' },
    appointmentsetter: { naam: 'Setter',         persoon: 'Setter' },
  };
  const A     = ['super_admin', 'manager', 'sales', 'mentor', 'marketing'];
  const SA    = ['super_admin'];
  const SAM   = ['super_admin', 'manager'];
  const SAMS  = ['super_admin', 'manager', 'sales'];
  const SAMSM = ['super_admin', 'manager', 'sales', 'mentor'];
  const SAMMK = ['super_admin', 'manager', 'marketing'];

  /* ── Modules ─────────────────────────────────────────────────────── */
  const MODS = [
    { g: 'Overzicht',              id: 'dashboard',        naam: 'Dashboard',         icon: I.grid,     color: 'blue',    roles: A.concat(['appointmentsetter']), permKey: 'dashboard.module.access', tabs: ['Vandaag'] },
    { g: 'Overzicht',              id: 'inbox',            naam: 'Inbox',             icon: I.inbox,    color: 'teal',    roles: SAMS,tabs: [] },
    { g: 'Overzicht',              id: 'taken',            naam: 'Takenbeheer',       icon: I.check2,   color: 'emerald', roles: A,tabs: ['Mijn taken', 'Toegewezen door mij', 'Afgerond'] },

    { g: 'Klanten & communicatie', id: 'klanten',          naam: 'Klanten',           icon: I.users,    color: 'emerald', roles: SAMS, permKey: 'customer.module.access', tabs: ['Overzicht'] },
    { g: 'Klanten & communicatie', id: 'studenten',        naam: 'Studenten',         icon: I.grad,     color: 'teal',    roles: ['mentor', 'super_admin', 'admin', 'manager'], tabs: [] },
    { g: 'Klanten & communicatie', id: 'wanbetalers',      naam: 'Wanbetalers',       icon: I.alert,    color: 'amber',   roles: SAM,tabs: ['Vandaag', 'Gesprekken', 'Acties', 'Overzicht', 'Pipeline', 'Brieven', 'Motor'] },
    { g: 'Klanten & communicatie', id: 'email',            naam: 'E-mail',            icon: I.mail,     color: 'teal',    roles: SAMS,tabs: [] },
    { g: 'Klanten & communicatie', id: 'tickets',          naam: 'Tickets',           icon: I.ticket,   color: 'rose',    roles: SAMSM,                tabs: ['Open', 'Wacht op klant', 'Afgehandeld'] },
    { g: 'Klanten & communicatie', id: 'followup',         naam: 'Follow-up',         icon: I.phone,    color: 'violet',  roles: SAMS, permKey: 'followup.module.access', tabs: ['Werklijst', 'Event-bellijst', 'Opvolglijst', 'Retenties', 'Afspraken', 'Kalender', 'Agenda', 'Statistieken', 'Zoeken', 'Overige'] },
    { g: 'Klanten & communicatie', id: 'opvolging',        naam: 'Opvolging',         icon: I.repeat,   color: 'teal',    roles: SAMS, permKey: 'opvolging.module.access', tabs: ['Vandaag', 'Dashboard', 'Afgerond'] },

    { g: 'Verkoop & Financiën',    id: 'sales',            naam: 'Sales',             icon: I.sales,    color: 'violet',  roles: SAMSM,                tabs: ['Dashboard', 'Offertes', 'Bonussen', 'Retentie', 'Verkoopprestaties'] },
    { g: 'Verkoop & Financiën',    id: 'finance',          naam: 'Finance',           icon: I.finance,  color: 'blue',    roles: SAMS,                 tabs: ['Dashboard', 'Facturen', 'Abonnementen', "Creditnota's", 'Bank', 'Omzet & MRR'] },
    { g: 'Verkoop & Financiën',    id: 'verdiensten',      naam: 'Mijn verdiensten',  icon: I.euro,     color: 'blue',    roles: ['mentor'],           tabs: ['Overzicht', 'Coaching', 'Events', 'Uitbetalingen', 'Reiskosten', 'Certificaten'] },
    // BP2 (2026-09-01) setter-commissie module. Roles: super_admin/manager
    // (admin voor overzicht), appointmentsetter (Romy — eigen data via RLS
    // + setter.ledger.view grant). permKey extra vangnet zodat een user met
    // alleen de grant maar geen role-match het item toch ziet.
    { g: 'Verkoop & Financiën',    id: 'setter-payout',    naam: 'Commissie',         icon: I.euro,     color: 'emerald', roles: ['super_admin', 'manager', 'appointmentsetter'], permKey: 'setter.ledger.view', tabs: ['Overzicht'] },

    { g: 'Leren & Events',         id: 'lms',              naam: 'LMS',               icon: I.book,     color: 'teal',    roles: ['super_admin', 'manager', 'mentor'], ext: 'https://dfo-lms-prototype.vercel.app/mentor', tabs: [] },
    { g: 'Leren & Events',         id: 'events',           naam: 'Events',            icon: I.cal,      color: 'pink',    roles: SAMSM,tabs: ['Overzicht', 'Inbox', 'Inschrijvingen', 'Statistieken'] },
    { g: 'Leren & Events',         id: 'onboarding',       naam: 'Onboarding',        icon: I.route,    color: 'emerald', roles: SAMSM, permKey: 'onboarding.admin', tabs: ['Actief', 'Inbox', 'Archief'] },
    { g: 'Leren & Events',         id: 'mentoren',         naam: 'Mentoren',          icon: I.grad,     color: 'violet',  roles: SAM,                  tabs: ['Overzicht', 'Rapporten', 'Certificaten', 'Beoordelingen', 'Trajecten', 'Sync'] },

    { g: 'Groei',                  id: 'leads',            naam: 'Leads',             icon: I.target,   color: 'amber',   roles: SAMMK.concat('sales'),tabs: ['Actief', 'Gearchiveerd'] },
    { g: 'Groei',                  id: 'nieuwsbrief',      naam: 'Nieuwsbrief',       icon: I.mail,     color: 'teal',    roles: ['marketing'],        tabs: [] },
    { g: 'Groei',                  id: 'leadsonderhoud',   naam: 'Leadsonderhoud',    icon: I.repeat,   color: 'teal',    roles: SAMS.concat(['appointmentsetter']), permKey: 'leads.view', tabs: ['Overzicht', 'Contacten', 'Wachtrij', 'Gesprekken', 'Opstartsessies', 'Toegang-aanvragen', 'Templates', 'Bronnen', 'Vragenlijst', 'Statistieken'] },
    // BP2 v3 (2026-09-01) Directe shortcut "Gesprekken" voor Romy — deep-linkt
    // naar leadsonderhoud/Gesprekken. Alleen zichtbaar voor appointmentsetter
    // (SAMS heeft leadsonderhoud > Gesprekken al één klik verderop). `deeplink`
    // wordt opgevangen in goMod() → S.mod=leadsonderhoud + S.tab=Gesprekken.
    // BP3 v4 (2026-09-02) — STRICT appointmentsetter-only. Geen permKey en
    // geen roles-uitbreiding: SAMS/super_admin zien deze shortcut NIET. Zij
    // hebben Leadsonderhoud met Gesprekken-tab al één klik verderop.
    { g: 'Groei',                  id: 'gesprekken',       naam: 'Gesprekken',        icon: I.chat,     color: 'teal',    roles: ['appointmentsetter'], tabs: [], deeplink: { mod: 'leadsonderhoud', tab: 'Gesprekken' } },
    // BP3 v4 (2026-09-01) — lisa-MOD blijft SAM-only in de sidebar; Romy
    // krijgt de module NIET als los sidebar-item. Ze bereikt de Gesprekken-
    // view uitsluitend via de instagram-deeplink-MOD hieronder (curMod
    // whitelist deeplink-targets zodat de render toch werkt).
    { g: 'Groei',                  id: 'lisa',             naam: 'Instagram setter',  icon: I.bot,      color: 'violet',  roles: SAM,                  tabs: ['Dashboard', 'Gesprekken', 'Statistieken'] },
    // BP3 v4 · Romy-only sidebar-shortcut "Instagram" → deep-link naar
    // lisa/Gesprekken. Zelfde patroon als de leadsonderhoud/Gesprekken-shortcut.
    // BP3 v4 (2026-09-02) — STRICT appointmentsetter-only. Geen permKey.
    // super_admin/admin/manager houden de volledige 'Instagram setter'-MOD.
    { g: 'Groei',                  id: 'instagram',        naam: 'Instagram',         icon: I.chat,     color: 'violet',  roles: ['appointmentsetter'], tabs: [], deeplink: { mod: 'lisa', tab: 'Gesprekken' } },

    { g: 'Operatie',               id: 'automatiseringen', naam: 'Automatiseringen',  icon: I.repeat,   color: 'blue',    roles: SAM,                  tabs: ['Overzicht', 'Events', 'Onboarding', 'Leadsonderhoud', 'Opvolging', 'Toegang', 'Lisa', 'Bulk'] },
    { g: 'Operatie',               id: 'agents',           naam: 'AI Agents',         icon: I.bot,      color: 'violet',  roles: SAM,                  tabs: ['Overzicht', 'Configuratie', 'Kennisbank', 'Prestaties'] },
    { g: 'Operatie',               id: 'logboek',          naam: 'Toegangslog',       icon: I.shield,   color: 'slate',   roles: SAM,                  tabs: ['Tijdlijn', 'Activiteit', 'Per gebruiker'] },

    { g: 'Systeem',                id: 'instellingen',     naam: 'Instellingen',      icon: I.settings, color: 'slate',   roles: SAM,                  tabs: [] },
    { g: 'Systeem',                id: 'binnenkort',       naam: 'Binnenkort',        icon: I.rocket,   color: 'slate',   roles: SAM,                  tabs: [] },
  ];

  /* Rol-gates. TAB_RESTRICT verbergt specifieke tabs voor rollen die
     de module wél mogen openen; MOD_LOCK toont de module in het menu
     met een slot-icoon en render't `comingSoonView` i.p.v. de content. */
  const TAB_RESTRICT = {
    'logboek/Tijdlijn':        ['super_admin'],    // #logboek-v1: unified stream + snapshots = super_admin-only
    'events/Statistieken': ['super_admin', 'manager'],
    'finance/Bank':            ['super_admin', 'manager'],
    'finance/Omzet & MRR':     ['super_admin', 'manager'],
    'sales/Retentie':          SAMS,
    'sales/Verkoopprestaties': SAMS,
    'events/Inbox':            SAMS,
    'events/Inschrijvingen':   SAMS,
    'onboarding/Inbox':        SAMS,
    // BP2 (2026-09-01): scope leadsonderhoud voor appointmentsetter — geen
    // beheer-tabs (Bronnen/Vragenlijst) of aggregate stats voor Romy.
    'leadsonderhoud/Overzicht':        SAMS,
    'leadsonderhoud/Bronnen':          SAMS,
    'leadsonderhoud/Vragenlijst':      SAMS,
    'leadsonderhoud/Statistieken':     SAMS,
    // BP2 v3 (2026-09-01): Wachtrij + Toegang-aanvragen ook alleen voor
    // SAMS. Setter heeft geen operationele reden om deze te zien.
    'leadsonderhoud/Wachtrij':         SAMS,
    'leadsonderhoud/Toegang-aanvragen': SAMS,
    // BP3 v7 (2026-09-02): Templates-tab ook zichtbaar voor appointmentsetter.
    // Romy mag templates aanmaken/bewerken (heeft snippets.manage uit BP1-seed).
    'leadsonderhoud/Templates':        SAMS.concat(['appointmentsetter']),
    'onboarding/Archief':      SAMS,
    // BP3 v4 (2026-09-01): Romy krijgt in Lisa alleen Gesprekken; dashboard
    // en statistieken blijven manager+ voorbehouden.
    'lisa/Dashboard':          SAM,
    'lisa/Statistieken':       SAM,
  };
  // Coming-soon-lock voor specifieke (module, rol)-combos. Toont slot-icoon
  // + comingSoonView i.p.v. de content. `email` verwijderd voor sales (v=1c3):
  // sales-rol ziet nu de echte E-mail-module (alle 7 mailboxen, geen scoping —
  // consistent met andere rollen). Als per-mailbox-scoping later gewenst is:
  // aparte brok (client-side MAILBOXES-filter of server-side permission-gate).
  const MOD_LOCK = { inbox: ['sales'] };

  /* Glow-kleur per accent (rgba met alpha .4). Buiten CSS omdat de
     alpha met de accent-hex gecombineerd moet worden voor box-shadows. */
  const GLOW = {
    blue:    'rgba(27,95,191,.4)',
    violet:  'rgba(109,63,212,.4)',
    amber:   'rgba(194,112,10,.4)',
    emerald: 'rgba(7,131,90,.4)',
    rose:    'rgba(194,43,62,.4)',
    teal:    'rgba(10,116,144,.4)',
    pink:    'rgba(179,43,114,.4)',
    slate:   'rgba(69,83,103,.4)',
  };

  /* ── State ───────────────────────────────────────────────────────── */
  // S.roles is de canonical rol-set (additief; iemand kan mentor+marketing
  // tegelijk zijn). S.role blijft als getter voor legacy consumers: het
  // returnt de eerste rol uit S.roles (dat is de "primary" — persona voor
  // avatar/username in de sidebar). Zie modules/shared/design-system/roles.js
  // + api/_lib/roles.js voor de mapping Supabase-rol → shell-rol.
  const S = {
    roles:   ['super_admin'],
    get role() { return this.roles[0] || 'super_admin'; },
    set role(v) { /* legacy shim: leeg — gebruik setRoles() of setRole() */ },
    mod:  'dashboard',
    tab:  'Vandaag',
    filters: {},
    scroll:  {},
    sel:     {},
    rows:    [],
    selIdx:  -1,
    dossier: null,
  };
  const key    = () => S.mod + '::' + S.tab;
  const F      = (k, d) => { const kk = key() + '::' + k; return S.filters[kk] !== undefined ? S.filters[kk] : d; };
  const setF   = (k, v) => { S.filters[key() + '::' + k] = v; NS.render(); };
  // Additief: een module is zichtbaar als ANY van de user-rollen 'em ziet,
  // OF (2026-08-26, v=1c9→v=1ca) als 'em een `permKey` heeft en window.RBAC
  // die permission granted. Zo ziet iemand met een user_permissions-grant
  // (bv. Chesney × followup.module.access) het menu-item, zonder dat we
  // een hele rol moeten verruimen. RBAC.canSync fail-open bij ontbreken:
  // returnt false → geen extra zichtbaarheid, dus geen regressie voor
  // rollen die het item al via `roles:` zien.
  const _permGrantsVis = (m) => {
    if (!m.permKey) return false;
    try { return !!(window.RBAC && typeof window.RBAC.canSync === 'function' && window.RBAC.canSync(m.permKey)); }
    catch (_) { return false; }
  };
  const visMods    = () => MODS.filter(m => m.roles.some(r => S.roles.includes(r)) || _permGrantsVis(m));
  // BP3 v4 (2026-09-01) — deeplink-targets zijn bereikbaar zonder in visMods
  // te staan: als een zichtbare MOD een `deeplink.mod` heeft die naar target
  // T wijst, is T bereikbaar (maar wordt niet in de sidebar getoond). Zo kan
  // Romy via de "Instagram"-shortcut de lisa-mod openen zonder dat lisa zelf
  // als apart sidebar-item verschijnt.
  const _reachableViaDeepLink = (id) => visMods().some(m => m.deeplink && m.deeplink.mod === id);
  const curMod     = () => visMods().find(m => m.id === S.mod)
                        || (MODS.find(m => m.id === S.mod && _reachableViaDeepLink(m.id)))
                        || visMods()[0];
  const roleTabs   = m => m.tabs.filter(t => { const r = TAB_RESTRICT[m.id + '/' + t]; return !r || r.some(x => S.roles.includes(x)); });
  const modCanOpen = id => visMods().some(m => m.id === id);
  // Additief lock-semantiek: alleen lock als ELKE rol-toegang die de user
  // heeft in MOD_LOCK[id] zit. Voorbeeld: sales heeft inbox in MOD_LOCK
  // (sales ziet slot); mentor+sales → mentor ziet inbox niet (geen roles-
  // match) dus het gaat om de sales-rol die WEL matcht en wél locked is
  // → locked. Manager+sales → manager matcht ook (via SAMS) en zit NIET
  // in MOD_LOCK[inbox] → unlocked (manager overrides sales-lock).
  const modLocked  = id => {
    const lockRoles = MOD_LOCK[id];
    if (!lockRoles || !lockRoles.length) return false;
    const mod = MODS.find(m => m.id === id);
    if (!mod) return false;
    const grantingRoles = mod.roles.filter(r => S.roles.includes(r));
    if (!grantingRoles.length) return false; // geen toegang = niet 'locked', gewoon onzichtbaar
    return grantingRoles.every(r => lockRoles.includes(r));
  };
  const modUsable  = id => modCanOpen(id) && !modLocked(id);
  const me         = () => (ROLES[S.role]?.persoon || '').split(' ')[0] || '';

  /* ── Kleine bouwstenen (uit prototype r.1045-1049) ───────────────── */
  const AV  = ['#2D74D6', '#6D3FD4', '#07835A', '#C2700A', '#C22B3E', '#0E7490', '#9333EA', '#B45309', '#B32B72'];
  const avc = n => AV[[...String(n)].reduce((a, c) => a + c.charCodeAt(0), 0) % AV.length];
  const ini = n => {
    const s = String(n);
    const parts = s.split(' ').filter(w => w[0] && w[0] === w[0].toUpperCase()).map(w => w[0]);
    return (parts.slice(0, 2).join('')) || s.slice(0, 2).toUpperCase();
  };
  const eur  = n => '€ ' + Number(n).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const eur0 = n => '€ ' + Number(n).toLocaleString('nl-NL', { maximumFractionDigits: 0 });

  /* ── VIEWS-registry (modules registreren hier hun renderers) ─────── */
  const VIEWS = {};
  const genericView = () => {
    const m = curMod();
    if (!m) return '';
    return `<div class="empty" style="padding:82px 20px">
      <div class="empty-ico" style="width:54px;height:54px;border-radius:16px;background:var(--${m.color}-soft);color:var(--${m.color})">${svg(I.rocket, 'width:25px;height:25px')}</div>
      <div class="empty-t" style="font-size:16px">${m.naam}${S.tab ? ' · ' + S.tab : ''}</div>
      <div class="empty-s">Deze view is nog niet gebouwd. In productie wordt hier de module-content gerenderd.</div>
    </div>`;
  };

  /* ── Render-pijplijn ─────────────────────────────────────────────── */
  function applyColor() {
    const m = curMod();
    if (!m) return;
    const c = m.color;
    const r = document.documentElement.style;
    r.setProperty('--m',      `var(--${c})`);
    r.setProperty('--m-soft', `var(--${c}-soft)`);
    r.setProperty('--m-line', `var(--${c}-line)`);
    r.setProperty('--m-glow', GLOW[c] || 'transparent');
  }

  function renderNav() {
    const mods = visMods();
    const groups = [...new Set(mods.map(m => m.g))];
    const el = document.getElementById('nav');
    if (!el) return;
    const badges = NS.badges || {};
    // BP3 v4 (2026-09-01) — active-highlight ondersteunt deeplink-MODs.
    // Als een zichtbaar deeplink-item wijst op de huidige (S.mod, S.tab), wint
    // dat item van zijn parent-MOD. Zo highlight "Gesprekken" (deeplink) i.p.v.
    // "Leadsonderhoud" (parent) wanneer je op leadsonderhoud/Gesprekken staat,
    // en idem voor "Instagram" (deeplink) i.p.v. "Instagram setter" (parent).
    const _deeplinkHit = mods.find(m => m.deeplink && m.deeplink.mod === S.mod && m.deeplink.tab === S.tab);
    const activeId = _deeplinkHit ? _deeplinkHit.id : S.mod;
    el.innerHTML = groups.map(g => `
      <div class="nav-label">${g}</div>
      ${mods.filter(m => m.g === g).map(m => {
        // Pre-flip fix 3: ext-modules (bv. LMS) renderen als <a target=_blank>
        // i.p.v. <button onclick=window.open>. Popup-blockers zijn strenger
        // geworden op window.open in wrapped onclick-chains — <a>-links met
        // target=_blank openen altijd. Werkt met + zonder cmd/ctrl-click.
        const activeStyle = activeId === m.id ? `--m:var(--${m.color});--m-soft:var(--${m.color}-soft);--m-glow:${GLOW[m.color]}` : '';
        const activeCls = activeId === m.id ? 'active' : '';
        const inner = `
          <span class="nav-ico">${svg(m.icon)}</span><span>${m.naam}</span>
          ${m.ext ? `<span style="margin-left:auto;color:var(--text-3);display:inline-flex">${svg(I.ext, 'width:13px;height:13px')}</span>` : ''}
          ${modLocked(m.id) ? `<span style="margin-left:auto;color:var(--text-3);display:inline-flex" title="Binnenkort beschikbaar">${svg(I.lock, 'width:13px;height:13px')}</span>`
            : (badges[m.id] ? `<span class="nav-badge">${badges[m.id] > 99 ? '9+' : badges[m.id]}</span>` : '')}`;
        if (m.ext) {
          return `<a href="${m.ext}" target="_blank" rel="noopener noreferrer" class="nav-item ${activeCls}" style="${activeStyle};text-decoration:none">${inner}</a>`;
        }
        return `<button class="nav-item ${activeCls}" onclick="DFO.goMod('${m.id}')" style="${activeStyle}">${inner}</button>`;
      }).join('')}`).join('');
  }

  function toggleNav(force) {
    const sb = document.querySelector('.sidebar');
    const sc = document.getElementById('scrim');
    if (!sb || !sc) return;
    const open = force === undefined ? !sb.classList.contains('open') : force;
    sb.classList.toggle('open', open);
    sc.classList.toggle('on', open);
  }

  /**
   * setRoles(roles) — canonical rol-setter. Accepteert een array shell-rollen
   * (bv. ['mentor','marketing']). Filtert ongeldige rollen weg; fallback op
   * ['super_admin'] als het resultaat leeg is (voorkomt lege-nav-render).
   * Rendert nav + content opnieuw. De persona (avatar+username+role-label)
   * volgt de primary rol (roles[0]) — dat is de hoogste rol uit ROLE_PRIORITY
   * op de server, dus in de UI komt "de belangrijkste hoedanigheid" bovenaan.
   */
  function setRoles(roles) {
    const clean = (Array.isArray(roles) ? roles : [roles])
      .filter(r => r && ROLES[r]);
    // BP2 (2026-09-01) FAIL-CLOSED: was `clean.length ? clean : ['super_admin']`
    // — dat gaf onbekende rollen automatisch super_admin-toegang. Nu: bij
    // lege set → leeg blijven. visMods filtert dan alle MODS weg (of alleen
    // die met permKey-match) → sidebar toont minimum. Endpoints blijven
    // autoritatief via RBAC feature-keys.
    S.roles = clean;
    S.dossier = null;
    closePanel(true);
    const first = visMods()[0];
    if (first && !visMods().find(m => m.id === S.mod)) {
      S.mod = first.id;
      S.tab = roleTabs(first)[0] || '';
    }
    const primary = S.roles[0];
    const un = document.getElementById('userName');   if (un && ROLES[primary]) un.textContent = ROLES[primary].persoon;
    const ur = document.getElementById('userRole');   if (ur && ROLES[primary]) ur.textContent = ROLES[primary].naam;
    const av = document.getElementById('userAv');
    if (av && ROLES[primary]) { av.textContent = ini(ROLES[primary].persoon); av.style.background = avc(ROLES[primary].persoon); }
    const rs = document.getElementById('roleSel');    if (rs) rs.value = primary;
    NS.render();
  }

  /**
   * setRole(r) — backward-compat shim. Zelfde effect als setRoles([r]).
   * Alle bestaande consumers (shell-demo.html rolebox, klanten-v2 pre-0D)
   * blijven werken. Nieuwe code die additieve rollen wil moet setRoles()
   * gebruiken.
   */
  function setRole(r) {
    setRoles([r]);
  }

  function goMod(id) {
    const m = MODS.find(x => x.id === id);
    if (!m) return;
    if (window.innerWidth <= 900) toggleNav(false);
    if (m.ext) { window.open(m.ext, '_blank', 'noopener'); return; }
    // BP2 v3 (2026-09-01) — deep-link naar (mod,tab)-combo. Gebruikt voor
    // de "Gesprekken"-shortcut in de sidebar voor appointmentsetter.
    if (m.deeplink && m.deeplink.mod) {
      const targ = MODS.find(x => x.id === m.deeplink.mod);
      if (targ) {
        S.mod = targ.id;
        S.dossier = null;
        closePanel(true);
        closeModal();
        const wantTab = m.deeplink.tab || '';
        const tabs = roleTabs(targ);
        S.tab = tabs.includes(wantTab) ? wantTab : (tabs[0] || '');
        NS.render();
        return;
      }
    }
    S.mod = id;
    S.dossier = null;
    closePanel(true);
    closeModal();
    S.tab = roleTabs(m)[0] || '';
    NS.render();
  }

  function goTab(t) {
    S.tab = t;
    S.dossier = null;
    closePanel(true);
    closeModal();
    NS.render();
  }

  function comingSoonView(m) {
    return `<div class="empty" style="padding:82px 20px">
      <div class="empty-ico" style="width:54px;height:54px;border-radius:16px;background:var(--${m.color}-soft);color:var(--${m.color})">${svg(I.clock, 'width:25px;height:25px')}</div>
      <div class="empty-t" style="font-size:16px">${m.naam} — binnenkort beschikbaar</div>
      <div class="empty-s">Dit onderdeel wordt voor jouw rol nog vrijgegeven. Zodra het klaarstaat, verschijnt het hier automatisch.</div>
      <div style="margin-top:15px"><span class="pill pill-warn">Binnenkort beschikbaar</span></div></div>`;
  }

  function render() {
    applyColor();
    renderNav();
    const m = curMod();
    if (!m) return;
    const tabs = roleTabs(m);
    if (!S.dossier && m.tabs.length && !tabs.includes(S.tab)) S.tab = tabs[0] || '';

    const crumb = document.getElementById('crumb');
    if (crumb) {
      crumb.innerHTML = S.dossier
        ? `<span class="title-dot"></span><span style="cursor:pointer;color:var(--text-3);font-weight:500" onclick="DFO.S.dossier=null;DFO.render()">${m.naam}</span><span class="crumb-sep">/</span><span>${S.dossier}</span>`
        : `<span class="title-dot"></span>${m.naam}${tabs.length > 1 ? `<span class="crumb-sep">/</span><span class="crumb-cur">${S.tab}</span>` : ''}`;
    }
    const locked = modLocked(m.id);
    const tb = document.getElementById('tabs');
    if (tb) {
      tb.style.display = (tabs.length > 1 && !S.dossier && !locked) ? 'flex' : 'none';
      tb.innerHTML = tabs.map(t => `<button class="tab ${S.tab === t ? 'active' : ''}" onclick="DFO.goTab('${t.replace(/'/g, "\\'")}')">${t}</button>`).join('');
    }
    const c = document.getElementById('content');
    if (c) {
      const view = locked ? comingSoonView(m) : ((VIEWS[m.id + '/' + S.tab] || VIEWS[m.id + '/'] || genericView)());
      c.innerHTML = view;
      const sk = key();
      requestAnimationFrame(() => { c.scrollTop = S.scroll[sk] || 0; });
      c.onscroll = () => { S.scroll[sk] = c.scrollTop; };
    }
  }

  /* ── Zijpaneel + hint ────────────────────────────────────────────── */
  let hintT;
  function showHint() {
    const h = document.getElementById('hint');
    if (!h) return;
    h.innerHTML = `Blader met <span class="kbd">↑</span><span class="kbd">↓</span> · sluit met <span class="kbd">Esc</span>`;
    h.classList.add('show');
    clearTimeout(hintT);
    hintT = setTimeout(() => h.classList.remove('show'), 3400);
  }
  function openPanel(t, s, b, f) {
    const set = (id, val, prop = 'innerHTML') => { const el = document.getElementById(id); if (el) el[prop] = val; };
    set('panelTitle', t, 'textContent');
    set('panelSub',   s || '');
    set('panelBody',  b || '');
    set('panelFoot',  f || '');
    document.getElementById('panel')?.classList.add('open');
    document.getElementById('main')?.classList.add('panel-open');
    document.body.classList.add('panel-open');
    showHint();
  }
  function closePanel(silent) {
    document.getElementById('panel')?.classList.remove('open');
    document.getElementById('main')?.classList.remove('panel-open');
    document.body.classList.remove('panel-open');
    S.selIdx = -1;
    if (!silent && document.getElementById('content')) NS.render();
  }
  function stepRow(d) {
    const n = S.selIdx + d;
    if (n < 0 || n >= (S.rows || []).length) return;
    const opener = NS.rowOpener;
    if (typeof opener === 'function') opener(n);
  }

  /* ── Modal (één shared #dfoModal-node) ───────────────────────────── */
  function ensureModal() {
    let m = document.getElementById('dfoModal');
    if (m) return m;
    m = document.createElement('div');
    m.id = 'dfoModal';
    m.className = 'mdl';
    m.innerHTML = `<div class="mdl-box"><div class="mdl-head" id="dfoModalHead"></div><div class="mdl-body" id="dfoModalBody"></div><div class="mdl-foot" id="dfoModalFoot"></div></div>`;
    m.addEventListener('click', e => { if (e.target === m) closeModal(); });
    document.body.appendChild(m);
    return m;
  }
  function openModal({ head = '', body = '', foot = '' } = {}) {
    const m = ensureModal();
    m.querySelector('#dfoModalHead').innerHTML = head;
    m.querySelector('#dfoModalBody').innerHTML = body;
    m.querySelector('#dfoModalFoot').innerHTML = foot;
    m.classList.add('open');
  }
  function closeModal() {
    document.getElementById('dfoModal')?.classList.remove('open');
  }

  /* ── Dark-mode toggle ────────────────────────────────────────────── */
  const THEME_KEY = 'dfo-crm-theme';
  function applyStoredTheme() {
    try {
      const v = localStorage.getItem(THEME_KEY);
      document.documentElement.setAttribute('data-theme', v === 'dark' ? 'dark' : 'light');
    } catch (_) {
      document.documentElement.setAttribute('data-theme', 'light');
    }
  }
  function toggleTheme() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    const next = dark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
    const ti = document.getElementById('themeIcon');
    if (ti) ti.innerHTML = next === 'dark'
      ? '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'
      : '<path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>';
  }

  /* ── Keyboard: Esc = close panel; ↑↓ = stepRow als paneel open ───── */
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'Escape') { closePanel(); closeModal(); }
    if (document.getElementById('panel')?.classList.contains('open')) {
      if (e.key === 'ArrowDown') { e.preventDefault(); stepRow(1); }
      if (e.key === 'ArrowUp')   { e.preventDefault(); stepRow(-1); }
    }
  });

  /* ── Dynamic sidebar-badges (v=1c5) ────────────────────────────────
     `NS.badges` is een { moduleId: number } map. Consumers zetten via
     `DFO.setBadge('inbox', 3)`; renderNav leest uit deze map.
     0/null/undefined = geen badge (weggelaten in DOM). >99 = '9+'.
     Vervangt de hardcoded `m.badge`-waardes; alleen wire is er nu, echte
     tellingen komen van klanten-v2.js badge-poller. */
  NS.badges = {};
  NS.setBadge = function setBadge(id, n) {
    const num = Number(n) || 0;
    if (num > 0) NS.badges[id] = num;
    else delete NS.badges[id];
    // In-place re-render van alleen de nav (goedkoper dan volle render).
    try { renderNav(); } catch (_) {}
  };

  /* ── Public API ──────────────────────────────────────────────────── */
  Object.assign(NS, {
    ROLES, A, SA, SAM, SAMS, SAMSM, SAMMK,
    MODS, TAB_RESTRICT, MOD_LOCK, GLOW,
    S, key, F, setF,
    visMods, curMod, roleTabs, modCanOpen, modLocked, modUsable, me,
    VIEWS,
    setRole, setRoles, goMod, goTab, render, renderNav, applyColor, toggleNav,
    openPanel, closePanel, stepRow, showHint,
    openModal, closeModal,
    toggleTheme, applyStoredTheme,
    avc, ini, eur, eur0,
  });
})();
