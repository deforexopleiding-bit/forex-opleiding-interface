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
  const ROLES = {
    super_admin: { naam: 'Super admin', persoon: 'Amigo Biemold' },
    manager:     { naam: 'Manager',     persoon: 'Jeffrey Biemold' },
    sales:       { naam: 'Sales',       persoon: 'Joost Berg' },
    mentor:      { naam: 'Mentor',      persoon: 'Dave Klaassen' },
    marketing:   { naam: 'Marketing',   persoon: 'Nog niet toegewezen' },
  };
  const A     = ['super_admin', 'manager', 'sales', 'mentor', 'marketing'];
  const SA    = ['super_admin'];
  const SAM   = ['super_admin', 'manager'];
  const SAMS  = ['super_admin', 'manager', 'sales'];
  const SAMSM = ['super_admin', 'manager', 'sales', 'mentor'];
  const SAMMK = ['super_admin', 'manager', 'marketing'];

  /* ── Modules ─────────────────────────────────────────────────────── */
  const MODS = [
    { g: 'Overzicht',              id: 'dashboard',        naam: 'Dashboard',         icon: I.grid,     color: 'blue',    roles: A,                    tabs: ['Vandaag'] },
    { g: 'Overzicht',              id: 'inbox',            naam: 'Inbox',             icon: I.inbox,    color: 'teal',    roles: SAMS,      badge: 44, tabs: [] },
    { g: 'Overzicht',              id: 'taken',            naam: 'Takenbeheer',       icon: I.check2,   color: 'emerald', roles: A,         badge: 5,  tabs: ['Mijn taken', 'Toegewezen door mij', 'Afgerond'] },

    { g: 'Klanten & communicatie', id: 'klanten',          naam: 'Klanten',           icon: I.users,    color: 'emerald', roles: SAMS,                 tabs: ['Overzicht'] },
    { g: 'Klanten & communicatie', id: 'studenten',        naam: 'Studenten',         icon: I.grad,     color: 'teal',    roles: ['mentor'],           tabs: [] },
    { g: 'Klanten & communicatie', id: 'wanbetalers',      naam: 'Wanbetalers',       icon: I.alert,    color: 'amber',   roles: SAM,       badge: 32, tabs: ['Gesprekken', 'Acties', 'Overzicht', 'Brieven'] },
    { g: 'Klanten & communicatie', id: 'email',            naam: 'E-mail',            icon: I.mail,     color: 'teal',    roles: SAMS,      badge: 3,  tabs: [] },
    { g: 'Klanten & communicatie', id: 'tickets',          naam: 'Tickets',           icon: I.ticket,   color: 'rose',    roles: SAMSM,                tabs: ['Open', 'Wacht op klant', 'Afgehandeld'] },
    { g: 'Klanten & communicatie', id: 'followup',         naam: 'Follow-up',         icon: I.phone,    color: 'violet',  roles: SAMS,      badge: 12, tabs: ['Werklijst', 'Event-bellijst', 'Opvolglijst', 'Retenties', 'Afspraken', 'Sluimerpot', 'Statistieken', 'Afgeboekt'] },

    { g: 'Verkoop & Financiën',    id: 'sales',            naam: 'Sales',             icon: I.sales,    color: 'violet',  roles: SAMSM,                tabs: ['Dashboard', 'Offertes', 'Retentie', 'Verkoopprestaties'] },
    { g: 'Verkoop & Financiën',    id: 'finance',          naam: 'Finance',           icon: I.finance,  color: 'blue',    roles: SAMS,                 tabs: ['Dashboard', 'Facturen', 'Abonnementen', "Creditnota's", 'Bank', 'Omzet & MRR'] },
    { g: 'Verkoop & Financiën',    id: 'verdiensten',      naam: 'Mijn verdiensten',  icon: I.euro,     color: 'blue',    roles: ['mentor'],           tabs: ['Overzicht', 'Uitbetalingen', 'Reiskosten', 'Certificaten'] },

    { g: 'Leren & Events',         id: 'lms',              naam: 'LMS',               icon: I.book,     color: 'teal',    roles: ['super_admin', 'manager', 'mentor'], ext: 'https://dfo-lms-prototype.vercel.app/mentor', tabs: [] },
    { g: 'Leren & Events',         id: 'events',           naam: 'Events',            icon: I.cal,      color: 'pink',    roles: SAMSM,     badge: 8,  tabs: ['Overzicht', 'Inbox', 'Inschrijvingen', 'Statistieken'] },
    { g: 'Leren & Events',         id: 'onboarding',       naam: 'Onboarding',        icon: I.route,    color: 'emerald', roles: SAMSM,     badge: 2,  tabs: ['Actief', 'Inbox', 'Archief'] },
    { g: 'Leren & Events',         id: 'mentoren',         naam: 'Mentoren',          icon: I.grad,     color: 'violet',  roles: SAM,       badge: 4,  tabs: ['Overzicht', 'Grootboek', 'Uitbetalingen', 'Beoordelingen', 'Certificaten', 'Signalen'] },

    { g: 'Groei',                  id: 'leads',            naam: 'Leads',             icon: I.target,   color: 'amber',   roles: SAMMK.concat('sales'), badge: 101, tabs: ['Actief', 'Gearchiveerd'] },
    { g: 'Groei',                  id: 'nieuwsbrief',      naam: 'Nieuwsbrief',       icon: I.mail,     color: 'teal',    roles: ['marketing'],        tabs: [] },
    { g: 'Groei',                  id: 'leadsonderhoud',   naam: 'Leadsonderhoud',    icon: I.repeat,   color: 'teal',    roles: SAMS,      badge: 2,  tabs: ['Inbox', 'Contacten', 'Bulk versturen', 'Statistieken'] },
    { g: 'Groei',                  id: 'lisa',             naam: 'Lisa — Instagram',  icon: I.bot,      color: 'violet',  roles: SAM,       badge: 2,  tabs: ['Dashboard', 'Gesprekken', 'Statistieken'] },

    { g: 'Operatie',               id: 'automatiseringen', naam: 'Automatiseringen',  icon: I.repeat,   color: 'blue',    roles: SAM,                  tabs: ['Overzicht', 'Events', 'Onboarding', 'Leadsonderhoud'] },
    { g: 'Operatie',               id: 'agents',           naam: 'AI Agents',         icon: I.bot,      color: 'violet',  roles: SAM,                  tabs: ['Overzicht', 'Configuratie', 'Kennisbank', 'Prestaties'] },
    { g: 'Operatie',               id: 'logboek',          naam: 'Toegangslog',       icon: I.shield,   color: 'slate',   roles: SAM,                  tabs: ['Activiteit', 'Per gebruiker'] },

    { g: 'Systeem',                id: 'instellingen',     naam: 'Instellingen',      icon: I.settings, color: 'slate',   roles: SAM,                  tabs: [] },
    { g: 'Systeem',                id: 'binnenkort',       naam: 'Binnenkort',        icon: I.rocket,   color: 'slate',   roles: SAM,                  tabs: [] },
  ];

  /* Rol-gates. TAB_RESTRICT verbergt specifieke tabs voor rollen die
     de module wél mogen openen; MOD_LOCK toont de module in het menu
     met een slot-icoon en render't `comingSoonView` i.p.v. de content. */
  const TAB_RESTRICT = {
    'events/Statistieken': ['super_admin', 'manager'],
    'finance/Bank':            ['super_admin', 'manager'],
    'finance/Omzet & MRR':     ['super_admin', 'manager'],
    'sales/Retentie':          SAMS,
    'sales/Verkoopprestaties': SAMS,
    'events/Inbox':            SAMS,
    'events/Inschrijvingen':   SAMS,
    'onboarding/Inbox':        SAMS,
    'onboarding/Archief':      SAMS,
  };
  const MOD_LOCK = { inbox: ['sales'], email: ['sales'] };

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
  // Additief: een module is zichtbaar als ANY van de user-rollen 'em ziet.
  const visMods    = () => MODS.filter(m => m.roles.some(r => S.roles.includes(r)));
  const curMod     = () => visMods().find(m => m.id === S.mod) || visMods()[0];
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
    el.innerHTML = groups.map(g => `
      <div class="nav-label">${g}</div>
      ${mods.filter(m => m.g === g).map(m => `
        <button class="nav-item ${S.mod === m.id ? 'active' : ''}" onclick="DFO.goMod('${m.id}')"
          style="${S.mod === m.id ? `--m:var(--${m.color});--m-soft:var(--${m.color}-soft);--m-glow:${GLOW[m.color]}` : ''}">
          <span class="nav-ico">${svg(m.icon)}</span><span>${m.naam}</span>
          ${m.ext ? `<span style="margin-left:auto;color:var(--text-3);display:inline-flex">${svg(I.ext, 'width:13px;height:13px')}</span>` : ''}
          ${modLocked(m.id) ? `<span style="margin-left:auto;color:var(--text-3);display:inline-flex" title="Binnenkort beschikbaar">${svg(I.lock, 'width:13px;height:13px')}</span>`
            : (m.badge ? `<span class="nav-badge">${m.badge}</span>` : '')}
        </button>`).join('')}`).join('');
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
    S.roles = clean.length ? clean : ['super_admin'];
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
