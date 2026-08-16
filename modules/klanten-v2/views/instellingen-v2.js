// modules/klanten-v2/views/instellingen-v2.js
//
// Fase G — Instellingen (layout-only). 1 view (module heeft tabs:[]),
// met SETS-nav links + set-body rechts (switch per set-page). Focus op de
// WhatsApp-templatebeheer-sectie (com-wa) omdat die het meest concreet is;
// andere set-pages (rechten/trajecten/verzendvenster/bedrijf) hebben een
// lean detail-panel. Prototype: systeemprototype-v45.html r4167-4413.
// Dormant. Preview ?v2preview=instellingen (rol Manager/Admin/Super admin).

(function () {
  if (!window.DFO) { console.error('[instellingen-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[instellingen-v2] KV_V2.helpers niet geladen.'); return; }
  const { I, svg, F, setF, S, render } = window.DFO;
  const H = window.KV_V2.helpers;

  // v=2 admin-tools state (verhuisd uit followup-v2.js).
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const _live = {
    adminBackfillContacts: { data: null, error: null },
    adminGhlBackfill:      { data: null, error: null, mode: 'dry_run' },
  };
  const _ui = {
    adminBackfillBusy:       false,
    adminGhlBackfillConfirm: '',    // "IK BEGRIJP HET" token
    adminGhlBackfillBusy:    false,
    confirmModal:            null,  // { msg, onOk, tone }
    toast:                   null,
  };

  // Rol-check (super_admin only). Kijkt naar de v2 shell rol-state; als
  // die niet aanwezig is (browser-preview zonder auth), toont het simpel
  // een block.
  function isSuperAdmin() {
    try {
      const role = window.DFO?.S?.role || window.KV_V2?.role || null;
      return role === 'super_admin';
    } catch (_) { return false; }
  }
  function showToast(msg, tone) {
    if (window.KV_V2?.helpers?.showToast) { try { window.KV_V2.helpers.showToast(msg, tone); return; } catch (_) {} }
    _ui.toast = { msg, tone: tone || 'info' };
    if (render) render();
    setTimeout(() => { _ui.toast = null; if (render) render(); }, 3000);
  }
  function openConfirm(msg, onOk, tone) {
    _ui.confirmModal = { msg, onOk, tone: tone || 'warn' };
    if (render) render();
  }
  async function tryFetch(label, url, init, timeoutMs) {
    timeoutMs = timeoutMs || 60000;
    try {
      if (!window.KV || !window.KV.authedJson) throw new Error('KV.authedJson niet beschikbaar');
      return await Promise.race([
        window.KV.authedJson(url, init),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout ' + timeoutMs + 'ms')), timeoutMs)),
      ]);
    } catch (e) {
      console.warn('[instellingen-v2] ' + label + ' fail:', e?.message);
      return { __error: e?.message || 'onbekende fout' };
    }
  }

  // Fetchers — 1-op-1 kopie uit followup-v2 v=16 (endpoints identiek,
  // guards identiek). ghl-status-backfill blijft klant-risk met dezelfde
  // 3-staps-guard: dry-run → typ "IK BEGRIJP HET" → confirm-modal.
  async function submitAdminBackfillContacts() {
    if (_ui.adminBackfillBusy) return;
    _ui.adminBackfillBusy = true;
    _live.adminBackfillContacts.data = null;
    _live.adminBackfillContacts.error = null;
    if (render) render();
    const j = await tryFetch('backfill-contacts', '/api/follow-up-backfill-contacts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }, 60000);
    _ui.adminBackfillBusy = false;
    if (j && (j.__error || j.error)) {
      _live.adminBackfillContacts.error = j.__error || j.error;
      showToast('Backfill mislukt: ' + _live.adminBackfillContacts.error, 'warn');
    } else {
      _live.adminBackfillContacts.data = { totaal: j.totaal || 0, updated: j.updated || 0, skipped: j.skipped || 0, errors: j.errors || 0 };
      showToast(`Backfill klaar · ${j.updated || 0}/${j.totaal || 0} bijgewerkt`, 'success');
    }
    if (render) render();
  }
  async function submitAdminGhlBackfill(dryRun) {
    if (_ui.adminGhlBackfillBusy) return;
    _ui.adminGhlBackfillBusy = true;
    if (render) render();
    const body = dryRun
      ? { dry_run: true, mode: 'strict', limit: 50 }
      : { dry_run: false, mode: 'strict', limit: 50, confirm: _ui.adminGhlBackfillConfirm };
    const j = await tryFetch('ghl-backfill', '/api/follow-up-ghl-status-backfill', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }, 60000);
    _ui.adminGhlBackfillBusy = false;
    if (j && (j.__error || j.error)) {
      _live.adminGhlBackfill.error = j.__error || j.error;
      showToast('GHL-backfill mislukt: ' + _live.adminGhlBackfill.error, 'warn');
    } else {
      _live.adminGhlBackfill.data = j;
      _live.adminGhlBackfill.mode = dryRun ? 'dry_run' : 'executed';
      showToast(dryRun ? `Dry-run: ${j.returned || 0} kandidaten` : `Executed: ${j.succeeded || 0}/${j.processed || 0} bijgewerkt`, 'success');
      if (!dryRun) _ui.adminGhlBackfillConfirm = '';
    }
    if (render) render();
  }

  // Handlers (global __setAdmin* naming om conflicts met followup-v2 te
  // vermijden; die zijn daar geheel verwijderd).
  window.__setAdminBackfillContacts = () => {
    openConfirm('Backfill GHL-contacts naar alle appointments met ontbrekende email/telefoon? Loopt door alle appts; kan lang duren (max 60s per run).', submitAdminBackfillContacts, 'warn');
  };
  window.__setAdminGhlBackfillDry = () => submitAdminGhlBackfill(true);
  window.__setAdminGhlBackfillConfirm = (v) => { _ui.adminGhlBackfillConfirm = v; if (render) render(); };
  window.__setAdminGhlBackfillExecute = () => {
    if (_ui.adminGhlBackfillConfirm !== 'IK BEGRIJP HET') { showToast('Typ letterlijk "IK BEGRIJP HET" in het confirm-veld', 'warn'); return; }
    // Stap 3: harde confirm-modal vóór de mutatie live gaat.
    openConfirm('EXECUTE GHL-status-backfill (mode=strict, limit=50)? Muteert live GHL appointmentStatus → "showed". Alleen super_admin. Onomkeerbaar.', () => submitAdminGhlBackfill(false), 'warn');
  };
  window.__setConfirmOk = () => {
    const m = _ui.confirmModal; if (!m) return;
    _ui.confirmModal = null;
    if (render) render();
    if (typeof m.onOk === 'function') { try { m.onOk(); } catch (_) {} }
  };
  window.__setConfirmCancel = () => { _ui.confirmModal = null; if (render) render(); };

  // Nav — 1-op-1 uit prototype r4167-4222 (9 groepen · 30 set-pages).
  const SETS = [
    { g: 'Verkoop', items: [
      { id: 'sales-trajecten',  n: 'Trajecten',           d: '1-op-1 en membership · looptijden, prijzen en termijnen', ic: I.tag },
      { id: 'sales-producten',  n: 'Losse producten',     d: 'E-books, lascursus, consultancy',                          ic: I.box },
      { id: 'sales-offerte',    n: 'Offerte-sjablonen',    d: 'Opmaak, voorwaarden en standaardteksten',                  ic: I.doc },
      { id: 'sales-bonus',      n: 'Verkopers en bonus',  d: 'Wie verkoopt wat, en hoe de bonus wordt berekend',          ic: I.users },
    ]},
    { g: 'Financieel', items: [
      { id: 'fin-facturatie',   n: 'Facturatie',           d: 'Nummering, betaaltermijn en standaard-btw',                 ic: I.doc },
      { id: 'fin-entiteiten',   n: 'Entiteiten',           d: 'DFO en DFO BE · gegevens en rekeningnummers',               ic: I.building || I.file },
      { id: 'fin-teamleader',   n: 'Teamleader-koppeling', d: 'Synchronisatie van klanten, offertes en facturen',          ic: I.link || I.file },
      { id: 'fin-bank',         n: 'Bankkoppeling',        d: 'CAMT-import en matchingregels',                             ic: I.bank || I.file },
    ]},
    { g: 'Wanbetalers', items: [
      { id: 'wb-joost',         n: 'Joost — de toon',      d: 'Persona, autonomie, mandaat en communicatie-limieten',      ic: I.bot },
      { id: 'wb-workflows',     n: 'Wanneer starten & regels', d: 'De automatische stappen: wanneer welke aanmaning afgaat', ic: I.repeat },
      { id: 'wb-berichten',     n: 'Berichten',            d: 'Aanmaan- en briefteksten (incl. WIK-14-dagen)',             ic: I.mail },
      { id: 'wb-venster',       n: 'Verzendvenster',       d: 'Wanneer aanmaningen de deur uit mogen',                     ic: I.clock },
      { id: 'wb-incasso',       n: 'Incassobureaus',       d: 'Partners (NL/BE) waar dossiers naartoe gaan',               ic: I.building || I.file },
    ]},
    { g: 'AI Agents', items: [
      { id: 'agents-lisa',      n: 'Lisa',                 d: 'Persona, fases, follow-ups en verzendvenster',              ic: I.bot },
      { id: 'agents-kennis',    n: 'Kennisbank voor AI',   d: 'Wat Lisa en Joost weten over jullie aanbod',                ic: I.book || I.doc },
      { id: 'agents-manager',   n: 'AI Manager',           d: 'Toegang tot bedrijfsdata en vraagrechten',                  ic: I.sparkles || I.bot },
    ]},
    { g: 'Events & Leren', items: [
      { id: 'ev-auto',          n: 'Event-automatiseringen', d: 'Welke berichten wanneer uitgaan rond een event',           ic: I.repeat },
      { id: 'ev-templates',     n: 'Event-berichten',      d: 'E-mail en WhatsApp-templates',                              ic: I.mail },
      { id: 'ev-locaties',      n: 'Locaties',             d: 'Zalen, adressen en routebeschrijvingen',                    ic: I.building || I.file },
      { id: 'lms-instel',       n: 'LMS-instellingen',     d: 'Modules, toegang en certificaten',                          ic: I.book || I.doc },
    ]},
    { g: 'Communicatie', items: [
      { id: 'com-mail',         n: 'E-mailaccounts',       d: 'Postvakken die het systeem uitleest',                       ic: I.mail },
      { id: 'com-handtekening', n: 'E-mail-handtekeningen', d: 'Globale + per-mailbox handtekening (server-side aan mails toegevoegd)', ic: I.mail },
      { id: 'com-wa',           n: 'WhatsApp',             d: 'Meta-koppeling en goedgekeurde templates',                  ic: I.chat || I.mail },
      { id: 'com-tel',          n: 'Telefonie',            d: 'Voys-koppeling en belinstellingen',                         ic: I.phone },
      { id: 'com-sjabloon',     n: 'Berichtsjablonen',     d: 'E-mail-sjablonen voor compose/reply · lijst + editor',       ic: I.doc },
    ]},
    { g: 'Marketing', items: [
      { id: 'mk-meta',          n: 'Meta-koppeling',       d: 'Advertentieaccount en pixel',                               ic: I.target },
      { id: 'mk-bronnen',       n: 'Lead-bronnen',         d: 'Welke bronnen er zijn en hoe ze binnenkomen',               ic: I.target },
      { id: 'mk-sequenties',    n: 'Sequenties',           d: 'Automatische opvolging van leads',                          ic: I.repeat },
    ]},
    { g: 'Team & toegang', items: [
      { id: 'team-gebruikers',  n: 'Gebruikers',           d: 'Wie heeft toegang tot het systeem',                         ic: I.users },
      { id: 'team-rechten',     n: 'Rollen en rechten',    d: 'Wat elke rol mag zien en doen',                             ic: I.shield },
      { id: 'team-mentoren',    n: 'Mentoren',             d: 'Toewijzing, beschikbaarheid en vergoedingen',               ic: I.grad },
      { id: 'team-api',         n: 'API-sleutels',         d: 'Koppelingen met externe systemen',                          ic: I.key || I.settings },
    ]},
    { g: 'Algemeen', items: [
      { id: 'alg-bedrijf',      n: 'Bedrijfsgegevens',     d: 'Naam, adres, logo en btw-nummer',                           ic: I.building || I.file },
      { id: 'alg-meldingen',    n: 'Meldingen',            d: 'Wat je wanneer wilt horen',                                 ic: I.bell || I.warn },
      { id: 'alg-weergave',     n: 'Weergave',             d: 'Thema, taal en datumnotatie',                               ic: I.eye || I.settings },
    ]},
    // v=3 — Systeem-groep. Items markeren met `roles: ['super_admin']`;
    // instView filtert die uit voor niet-super_admin (nav-level hide).
    // Body-gate op sys-followup-admin (isSuperAdmin) blijft als 2e laag,
    // en server-side gate op de endpoints blijft de laatste laag.
    { g: 'Systeem', items: [
      { id: 'sys-followup-admin', n: 'Follow-up admin-tools', d: 'Backfill GHL-contacts + GHL-status-backfill', ic: I.settings, roles: ['super_admin'] },
    ]},
  ];

  // WhatsApp — templates (uit prototype r4248-4270).
  const WA_FOLDERS = [
    ['all',        'Alle templates',       I.list || I.doc, 'blue'],
    ['wanbetalers','Wanbetalers',          I.warn,          'amber'],
    ['onboarding', 'Onboarding',           I.route || I.check, 'emerald'],
    ['events',     'Events',               I.cal || I.clock, 'pink'],
    ['sales',      'Sales',                I.sales || I.trend, 'violet'],
    ['lisa',       'Lisa · Instagram',     I.bot,           'violet'],
    ['algemeen',   'Algemeen',             I.chat || I.mail, 'slate'],
  ];
  const WA_STAT = {
    goedgekeurd: { l: 'Goedgekeurd', c: 'ok' },
    in_review:   { l: 'In review',   c: 'warn' },
    afgewezen:   { l: 'Afgewezen',   c: 'warn' },
    concept:     { l: 'Concept',     c: 'neutral' },
  };
  const WA_TPL = [
    { cat: 'wanbetalers', n: 'Eerste herinnering (dag 3)',   taal: 'NL', status: 'goedgekeurd', tekst: 'Hoi {{klant.voornaam}}, we zien dat factuur {{factuur.nr}} van {{factuur.bedrag}} nog openstaat. Je kunt eenvoudig betalen via {{betaallink}}. Alvast bedankt! — De Forex Opleiding', gebruikt: 342 },
    { cat: 'wanbetalers', n: 'Tweede herinnering (dag 7)',   taal: 'NL', status: 'goedgekeurd', tekst: 'Hoi {{klant.voornaam}}, je factuur {{factuur.nr}} is nog niet voldaan. Lukt betalen niet in één keer? Dan denken we graag mee over een regeling.', gebruikt: 198 },
    { cat: 'wanbetalers', n: 'Betaalregeling — voorstel',   taal: 'NL', status: 'in_review',   tekst: 'Hoi {{klant.voornaam}}, we kunnen {{factuur.bedrag}} in termijnen verdelen. Akkoord? Reageer met JA.', gebruikt: 0 },
    { cat: 'onboarding',  n: 'Welkom + intake plannen',     taal: 'NL', status: 'goedgekeurd', tekst: 'Welkom {{klant.voornaam}}! Plan je intake met {{mentor.naam}} via {{agendalink}}. Tot snel!', gebruikt: 87 },
    { cat: 'onboarding',  n: 'LMS-toegang verstuurd',       taal: 'NL', status: 'goedgekeurd', tekst: 'Hoi {{klant.voornaam}}, je toegang tot de leeromgeving staat klaar. Log in en zet de eerste stap!', gebruikt: 76 },
    { cat: 'events',      n: 'Bevestiging aanmelding',      taal: 'NL', status: 'goedgekeurd', tekst: 'Je bent aangemeld voor {{event.naam}} op {{event.datum}} om {{event.tijd}}. Tot dan!', gebruikt: 512 },
    { cat: 'events',      n: 'Herinnering — 1 dag vooraf',  taal: 'NL', status: 'goedgekeurd', tekst: 'Morgen is het zover: {{event.naam}}! We beginnen om {{event.tijd}}. Tot morgen!', gebruikt: 498 },
    { cat: 'events',      n: 'No-show opvolging',           taal: 'NL', status: 'afgewezen',   tekst: 'Jammer dat je er niet bij kon zijn bij {{event.naam}}. Aanmelden voor een volgende datum?', gebruikt: 0 },
    { cat: 'sales',       n: 'Offerte verstuurd',           taal: 'NL', status: 'goedgekeurd', tekst: 'Hoi {{klant.voornaam}}, je offerte {{offerte.nr}} staat klaar. Vragen? Ik hoor het graag!', gebruikt: 143 },
    { cat: 'sales',       n: 'Herinnering openstaande offerte', taal: 'NL', status: 'concept', tekst: 'Hoi {{klant.voornaam}}, heb je al kunnen kijken naar offerte {{offerte.nr}}?', gebruikt: 0 },
    { cat: 'lisa',        n: 'Instagram — eerste reactie',  taal: 'NL', status: 'goedgekeurd', tekst: 'Hey {{klant.voornaam}}! Leuk dat je reageert. Waar wil je graag meer over weten?', gebruikt: 820 },
    { cat: 'lisa',        n: 'Instagram — kennismakingscall', taal: 'NL', status: 'goedgekeurd', tekst: 'Top! Plan hier je gratis kennismakingscall: {{agendalink}}', gebruikt: 405 },
    { cat: 'algemeen',    n: 'Algemene begroeting',         taal: 'NL', status: 'goedgekeurd', tekst: 'Hoi {{klant.voornaam}}, bedankt voor je bericht! We reageren zo snel mogelijk.', gebruikt: 63 },
  ];

  window.__setNotice = (l) => { console.info('[instellingen-v2] ' + l); try { alert(l + ' — komt in de data-ronde.'); } catch (_) {} };
  window.__setPick = (id) => {
    if (!S) return;
    S.setPage = id;
    if (window.DFO && typeof window.DFO.render === 'function') window.DFO.render();
  };

  function highlightVars(t) {
    return String(t || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\{\{([^}]+)\}\}/g, '<span class="wa-var">{{$1}}</span>')
      .replace(/\n/g, '<br>');
  }

  // ── Set-body per id ────────────────────────────────────────────────────
  function bodyWhatsApp() {
    const f = F('waf', 'all');
    const rows = WA_TPL.filter(t => f === 'all' || t.cat === f);
    const cnt = c => WA_TPL.filter(t => c === 'all' || t.cat === c).length;
    return `
      <div class="wa-conn">
        <span class="wa-conn-ico">${svg(I.chat || I.mail)}</span>
        <div class="wa-conn-body">
          <div class="wa-conn-t">WhatsApp Business — verbonden</div>
          <div class="wa-conn-s">+31 6 12 34 56 78 · WABA via Meta · ${WA_TPL.filter(t => t.status === 'goedgekeurd').length} goedgekeurde templates</div>
        </div>
        ${H.pill('ok', 'Actief')}
        <button class="btn btn-sm" onclick="__setNotice('Meta-koppeling')">${svg(I.settings)}Meta-koppeling</button>
      </div>

      ${H.toolbar([
        H.search('Zoek in templates…'),
        H.chips('wst', [
          { l: 'Alle statussen', v: 'all' },
          { l: 'Goedgekeurd', v: 'goedgekeurd' },
          { l: 'In review', v: 'in_review' },
        ], F('wst', 'all')),
        `<div class="tb-right"><button class="btn btn-primary" onclick="__setNotice('Nieuwe template')">${svg(I.plus)}Nieuwe template</button></div>`,
      ])}

      <div class="wa-folders-lbl">Mappen</div>
      <div class="wa-folders">
        ${WA_FOLDERS.map(([id, naam, ic, c]) => {
          const sel = f === id;
          return `<button class="wa-folder ${sel ? 'is-sel' : ''}" onclick="__waPick('${id}')">
            <span class="tile-ico wa-folder-ic" style="background:var(--${c}-soft,var(--surface-2));color:var(--${c},var(--brand))">${svg(ic)}</span>
            <div class="wa-folder-txt">
              <div class="wa-folder-n">${naam}</div>
              <div class="wa-folder-c">${cnt(id)} templates</div>
            </div>
          </button>`;
        }).join('')}
      </div>

      <div class="wa-cards">
        ${rows.length ? rows.map(t => `
          <div class="wa-card">
            <div class="wa-card-head">
              <div class="wa-card-title">
                <div class="cell-main">${t.n}</div>
                <div class="wa-card-meta">${WA_FOLDERS.find(f => f[0] === t.cat)?.[1] || t.cat} · ${t.taal}</div>
              </div>
              ${H.pill(WA_STAT[t.status].c, WA_STAT[t.status].l)}
            </div>
            <div class="wa-card-body">
              <div class="wa-bubble">${highlightVars(t.tekst)}</div>
            </div>
            <div class="wa-card-foot">
              <span class="wa-card-count">${t.gebruikt ? t.gebruikt + '× gebruikt' : 'nog niet gebruikt'}</span>
              <div class="wa-card-acts">
                <button class="btn btn-sm" onclick="__setNotice('Dupliceer template')" title="Dupliceren">${svg(I.copy || I.plus)}</button>
                <button class="btn btn-sm" onclick="__setNotice('Bewerk template')">${svg(I.edit || I.settings)}Bewerken</button>
              </div>
            </div>
          </div>`).join('') : `<div class="set-empty" style="grid-column:1/-1"><span class="set-empty-ico">${svg(I.chat || I.mail)}</span><div class="set-empty-t">Geen templates in deze map</div><div class="set-empty-s">Maak een nieuwe template of kies een andere map.</div></div>`}
      </div>`;
  }
  window.__waPick = (id) => { setF('waf', id); };

  function bodyRechten() {
    const rows = [
      ['Klanten bekijken',                1, 1, 1, 1],
      ['Klanten aanmaken/bewerken',       1, 1, 1, 0],
      ['Klant verwijderen',               1, 0, 0, 0],
      ['Facturen bekijken',               1, 1, 0, 0],
      ['Facturen aanmaken',               1, 1, 0, 0],
      ['Factuur crediteren',              1, 1, 0, 0],
      ['Offertes bekijken',               1, 1, 1, 0],
      ['Offertes aanmaken',               1, 1, 1, 0],
      ['Korting geven boven 10%',         1, 1, 0, 0],
      ['Wanbetalers-inbox',               1, 1, 0, 0],
      ['Betaalregeling goedkeuren',       1, 1, 0, 0],
      ['Events beheren',                  1, 1, 1, 0],
      ['Gebruikers beheren',              1, 0, 0, 0],
      ['Systeeminstellingen',             1, 0, 0, 0],
    ];
    const tick = (v) => v
      ? `<span class="rbac-tick rbac-tick-yes">${svg(I.check)}</span>`
      : `<span class="rbac-tick rbac-tick-no">${svg(I.x || I.warn)}</span>`;
    return H.table(
      [{ l: 'Recht' }, { l: 'Super admin', cls: 'r' }, { l: 'Manager', cls: 'r' }, { l: 'Sales', cls: 'r' }, { l: 'Mentor', cls: 'r' }],
      rows.map(r => [`<span class="cell-main">${r[0]}</span>`, tick(r[1]), tick(r[2]), tick(r[3]), tick(r[4])])
    ) + `<div class="set-footer-hint">Marketing wordt later toegevoegd — die rol bestaat al maar heeft nog geen rechten.</div>`;
  }

  function bodyBedrijf() {
    return `
      <div class="set-field">
        <div class="set-field-l"><div class="set-field-t">Bedrijfsnaam</div></div>
        <div class="set-field-c"><input class="ib-input" value="De Forex Opleiding"></div>
      </div>
      <div class="set-field">
        <div class="set-field-l"><div class="set-field-t">Adres</div></div>
        <div class="set-field-c"><input class="ib-input" value="Deinsesteenweg 108, 9031 Drongen"></div>
      </div>
      <div class="set-field">
        <div class="set-field-l"><div class="set-field-t">Btw-nummer</div><div class="set-field-d">Verschijnt op facturen en offertes</div></div>
        <div class="set-field-c"><input class="ib-input mono" value="BE0808734629"></div>
      </div>
      <div class="set-field">
        <div class="set-field-l"><div class="set-field-t">Telefoon</div></div>
        <div class="set-field-c"><input class="ib-input mono" value="+31 85 580 36 26"></div>
      </div>
      <div class="set-actions"><button class="btn btn-primary" onclick="__setNotice('Bedrijfsgegevens opslaan')">Opslaan</button></div>`;
  }

  function bodyVenster() {
    return `
      <div class="set-field">
        <div class="set-field-l"><div class="set-field-t">Verzendvenster</div><div class="set-field-d">Buiten deze tijden gaan er geen aanmaningen uit. De motor draait wel door.</div></div>
        <div class="set-field-c set-field-row"><input class="ib-input" value="08:00" style="max-width:110px"><span class="set-sep">tot</span><input class="ib-input" value="20:00" style="max-width:110px"></div>
      </div>
      <div class="set-field">
        <div class="set-field-l"><div class="set-field-t">Dagen</div><div class="set-field-d">Op welke dagen mag er verstuurd worden</div></div>
        <div class="set-field-c set-field-row" style="flex-wrap:wrap">
          ${['ma','di','wo','do','vr','za','zo'].map(d => `<button class="chip is-on">${d}</button>`).join('')}
        </div>
      </div>
      <div class="set-field">
        <div class="set-field-l"><div class="set-field-t">Tijdzone</div><div class="set-field-d">Zomer- en wintertijd worden automatisch meegenomen</div></div>
        <div class="set-field-c"><select class="ib-input" style="max-width:240px"><option>Europe/Amsterdam</option></select></div>
      </div>
      <div class="set-actions"><button class="btn btn-primary" onclick="__setNotice('Verzendvenster opslaan')">Opslaan</button></div>`;
  }

  function bodyPlaceholder(cur) {
    return `<div class="set-empty">
      <span class="set-empty-ico">${svg(cur.ic || I.settings)}</span>
      <div class="set-empty-t">Instellingen voor "${cur.n}"</div>
      <div class="set-empty-s">Deze instellingen staan nu nog verspreid in de modules. Ze verhuizen allemaal hierheen, zodat je alles vanaf één plek regelt. Detail-panel komt in de data-ronde.</div>
    </div>`;
  }

  /* ═════════════════════════════════════════════════════════════════════
     v=2 — SYSTEEM · Follow-up admin-tools
     Verhuisd 1-op-1 uit followup-v2 v=16 (adminView + 4 helper-cards).
     Endpoints en 3-staps-guard identiek: dry-run → typ "IK BEGRIJP HET" →
     confirm-modal (harde bevestiging vóór live mutatie).
     ═════════════════════════════════════════════════════════════════════ */
  function bodyAccessDenied() {
    return `<div class="set-empty">
      <span class="set-empty-ico">${svg(I.shield || I.settings)}</span>
      <div class="set-empty-t">Alleen super_admin</div>
      <div class="set-empty-s">Deze systeem-tools zijn zichtbaar voor super_admin. Vraag Amigo of Jeffrey om toegang, of gebruik "Bekijk als → Super admin" (dev/preview).</div>
    </div>`;
  }
  function _sysBackfillContactsCard() {
    const busy = _ui.adminBackfillBusy;
    const d = _live.adminBackfillContacts.data;
    const err = _live.adminBackfillContacts.error;
    return `<div class="card" style="margin-bottom:14px;background:var(--surface);border:1px solid var(--border);border-radius:10px">
      <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div>
          <div style="font-size:13px;font-weight:600">Backfill GHL-contacts</div>
          <div style="font-size:11.5px;color:var(--text-3);margin-top:2px">Trekt email/telefoon bij van GHL voor appointments met ontbrekende contact-info.</div>
        </div>
        <button class="btn btn-primary btn-sm" ${busy ? 'disabled' : ''} onclick="window.__setAdminBackfillContacts()">${busy ? 'Bezig…' : 'Start backfill'}</button>
      </div>
      ${d ? `<div style="padding:10px 16px;font-size:12px;color:var(--text-2)">Resultaat: <span class="mono">${d.updated}</span>/<span class="mono">${d.totaal}</span> bijgewerkt · <span class="mono">${d.skipped}</span> geskipped · <span class="mono" style="color:var(--rose)">${d.errors}</span> fouten.</div>` : ''}
      ${err ? `<div style="padding:10px 16px;font-size:12px;color:var(--rose)">Fout: ${esc(err)}</div>` : ''}
    </div>`;
  }
  function _sysGhlBackfillCard() {
    const busy = _ui.adminGhlBackfillBusy;
    const d = _live.adminGhlBackfill.data;
    const err = _live.adminGhlBackfill.error;
    const mode = _live.adminGhlBackfill.mode;
    return `<div class="card" style="margin-bottom:14px;background:var(--surface);border:1px solid var(--rose-line, #f5b4bc);border-radius:10px">
      <div style="padding:12px 16px;background:var(--rose-soft);border-bottom:1px solid var(--rose-line, #f5b4bc)">
        <div style="font-size:13px;font-weight:600;color:var(--rose)">⚠ GHL-status-backfill (klant-CRM-mutatie)</div>
        <div style="font-size:11.5px;color:var(--rose);margin-top:2px">Zet historische appointments in GHL op status "showed". Muteert live CRM-data. 3 stappen: dry-run → typ "IK BEGRIJP HET" → confirm-modal → execute.</div>
      </div>
      <div style="padding:12px 16px">
        <div style="display:flex;gap:8px;margin-bottom:10px">
          <button class="btn btn-ghost btn-sm" ${busy ? 'disabled' : ''} onclick="window.__setAdminGhlBackfillDry()">${busy && mode === 'dry_run' ? 'Bezig…' : '🔍 1. Dry-run (mode=strict, limit=50)'}</button>
        </div>
        ${d && mode === 'dry_run' ? `<div style="padding:10px 12px;background:var(--surface-2);border-radius:6px;font-size:12px;margin-bottom:10px">
          <b>Dry-run resultaat:</b> ${d.total_candidates || 0} totaal kandidaten · toont eerste ${d.returned || 0} · limit ${d.limit || 50}${d.skipped_over_limit ? ` · ${d.skipped_over_limit} overgeslagen boven limit` : ''}<br>
          ${d.note ? `<div style="margin-top:6px;font-style:italic">${esc(d.note)}</div>` : ''}
        </div>` : ''}
        ${d && mode === 'dry_run' ? `<div style="border-top:1px solid var(--border);padding-top:10px">
          <div style="font-size:11px;color:var(--text-3);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">2. Bevestigen door te typen  ·  3. Confirm-modal → Execute</div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <input type="text" placeholder='Typ "IK BEGRIJP HET"' value="${esc(_ui.adminGhlBackfillConfirm)}" oninput="window.__setAdminGhlBackfillConfirm(this.value)" style="flex:1;min-width:220px;padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12.5px" />
            <button class="btn btn-primary btn-sm" ${busy || _ui.adminGhlBackfillConfirm !== 'IK BEGRIJP HET' ? 'disabled' : ''} style="background:var(--rose);border-color:var(--rose)" onclick="window.__setAdminGhlBackfillExecute()">${busy && mode === 'executed' ? 'Executing…' : '🚨 EXECUTE'}</button>
          </div>
        </div>` : ''}
        ${d && mode === 'executed' ? `<div style="padding:10px 12px;background:var(--emerald-soft);color:var(--emerald);border-radius:6px;font-size:12px;margin-top:10px">
          <b>Executed:</b> ${d.succeeded || 0}/${d.processed || 0} bijgewerkt${d.failed ? ` · ${d.failed} fouten` : ''}.
        </div>` : ''}
        ${err ? `<div style="padding:10px 12px;background:var(--rose-soft);color:var(--rose);border-radius:6px;font-size:12px;margin-top:10px">${esc(err)}</div>` : ''}
      </div>
    </div>`;
  }
  function _sysReportenCard() {
    return `<div class="card" style="margin-bottom:14px;background:var(--surface);border:1px solid var(--border);border-radius:10px">
      <div style="padding:12px 16px">
        <div style="font-size:13px;font-weight:600;margin-bottom:6px">📧 Admin-rapporten (cron)</div>
        <div style="font-size:12px;color:var(--text-2);line-height:1.6">
          <b>follow-up-admin-daily</b> — verstuurt dagelijks 21:00 NL naar admins/managers via e-mail. Dedup per dag+recipient.<br>
          <b>follow-up-admin-weekly</b> — verstuurt zondag 10:00 NL. Dedup per week.<br>
          <span style="color:var(--text-3);font-size:11.5px">Beide draaien server-side (cron). Ontvangers: alle super_admin + manager. Interne mail — geen klant-verzending.</span>
        </div>
      </div>
    </div>`;
  }
  function _sysCronsCard() {
    return `<div class="card" style="background:var(--surface);border:1px solid var(--border);border-radius:10px">
      <div style="padding:12px 16px">
        <div style="font-size:13px;font-weight:600;margin-bottom:6px">🔄 GHL-integratie (server-side)</div>
        <div style="font-size:12px;color:var(--text-2);line-height:1.6">
          <b>follow-up-ghl-appointment-poll</b> — cron elke 15 min. Sync GHL-appointments naar DB. Ghost-detectie.<br>
          <b>follow-up-ghl-conversations-poll</b> — cron elke 15 min. Safety-net voor conversations-webhook.<br>
          <b>follow-up-ghl-conversation-webhook</b> — inkomend van GHL bij nieuwe messages.<br>
          <span style="color:var(--text-3);font-size:11.5px">Alle drie draaien automatisch. Geen UI-actie nodig — check via server-logs.</span>
        </div>
      </div>
    </div>`;
  }
  function bodySysFollowupAdmin() {
    if (!isSuperAdmin()) return bodyAccessDenied();
    return `<div style="max-width:900px">
      ${_sysBackfillContactsCard()}
      ${_sysGhlBackfillCard()}
      ${_sysReportenCard()}
      ${_sysCronsCard()}
    </div>`;
  }
  function _renderConfirmModal() {
    const m = _ui.confirmModal;
    if (!m) return '';
    const tone = m.tone === 'warn' ? 'rose' : 'blue';
    return `<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2000;display:grid;place-items:center;padding:20px" onclick="if(event.target===this)window.__setConfirmCancel()">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:12px;max-width:520px;width:100%;box-shadow:0 12px 40px rgba(0,0,0,.25);overflow:hidden">
        <div style="padding:14px 18px;background:var(--${tone}-soft);color:var(--${tone});font-size:13px;font-weight:600">⚠ Bevestigen</div>
        <div style="padding:16px 18px;font-size:13px;color:var(--text-2);line-height:1.55">${esc(m.msg)}</div>
        <div style="padding:12px 18px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end">
          <button class="btn btn-ghost btn-sm" onclick="window.__setConfirmCancel()">Annuleren</button>
          <button class="btn btn-primary btn-sm" style="background:var(--${tone});border-color:var(--${tone})" onclick="window.__setConfirmOk()">Ja, uitvoeren</button>
        </div>
      </div>
    </div>`;
  }

  /* ═════════════════════════════════════════════════════════════════════
     v=4 — COMMUNICATIE · E-mail-handtekeningen (DEEL 3 v2 email-round).
     Beheer 1 globale default + optionele per-mailbox override. Server-side
     voegt de handtekening toe via /api/email-send-v2 (handtekening:true).
     ═════════════════════════════════════════════════════════════════════ */
  const MAILBOX_SLUGS = ['info', 'leads', 'partners', 'administratie', 'onboarding', 'events', 'welkom'];
  const _sig = {
    loading: false, error: null,
    items: [],        // gehele lijst uit /api/email-signatures
    active: null,     // welke mailbox open in editor: null=global, of slug
    draft: null,      // { name, body_html, body_text, logo_url } bewerkt
    busy: false, note: '',
  };
  async function fetchSignatures() {
    if (_sig.loading) return;
    _sig.loading = true; _sig.error = null; if (render) render();
    const j = await tryFetch('email-signatures', '/api/email-signatures');
    _sig.loading = false;
    if (j?.__error) _sig.error = j.__error;
    else if (j?.error) _sig.error = j.error;
    else _sig.items = Array.isArray(j?.items) ? j.items : [];
    if (render) render();
  }
  function _sigFor(mailbox) {
    // mailbox=null → global (mailbox IS NULL in DB).
    return _sig.items.find((s) => (mailbox == null ? s.mailbox == null : s.mailbox === mailbox)) || null;
  }
  window.__setSigOpen = (mailbox) => {
    const key = mailbox === '' ? null : mailbox;
    _sig.active = key;
    const row = _sigFor(key);
    _sig.draft = {
      name:      row?.name || (key ? `Handtekening (${key})` : 'Globale standaard'),
      body_html: row?.body_html || '',
      body_text: row?.body_text || '',
      logo_url:  row?.logo_url  || '',
    };
    _sig.note = '';
    if (render) render();
  };
  window.__setSigField = (k, v) => {
    if (!_sig.draft) return;
    _sig.draft[k] = String(v == null ? '' : v);
    _sig.note = '';
  };
  window.__setSigSave = async () => {
    if (_sig.busy || !_sig.draft) return;
    _sig.busy = true; _sig.note = 'Opslaan…'; if (render) render();
    const payload = {
      mailbox: _sig.active || null,
      name:      _sig.draft.name || 'Standaard',
      body_html: _sig.draft.body_html || '',
      body_text: _sig.draft.body_text || '',
      logo_url:  _sig.draft.logo_url  || null,
      is_active: true,
    };
    const j = await tryFetch('sig-save', '/api/email-signatures', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, 15000);
    _sig.busy = false;
    if (j?.__error || j?.error) {
      _sig.note = 'Fout: ' + (j.__error || j.error);
      if (render) render(); return;
    }
    _sig.note = 'Opgeslagen';
    // Refresh
    _sig.items = _sig.items.filter((s) => (payload.mailbox ? s.mailbox !== payload.mailbox : s.mailbox != null));
    if (j?.item) _sig.items.push(j.item);
    if (render) render();
    setTimeout(() => { _sig.note = ''; if (render) render(); }, 2500);
  };
  window.__setSigDelete = async () => {
    if (!_sig.active) { _sig.note = 'De globale default kan niet verwijderd worden.'; if (render) render(); return; }
    if (_sig.busy) return;
    _sig.busy = true; _sig.note = 'Verwijderen…'; if (render) render();
    const j = await tryFetch('sig-delete', '/api/email-signatures?mailbox=' + encodeURIComponent(_sig.active), { method: 'DELETE' }, 10000);
    _sig.busy = false;
    if (j?.__error || j?.error) { _sig.note = 'Fout: ' + (j.__error || j.error); if (render) render(); return; }
    _sig.items = _sig.items.filter((s) => s.mailbox !== _sig.active);
    _sig.active = null;
    _sig.draft = null;
    _sig.note = 'Verwijderd';
    if (render) render();
    setTimeout(() => { _sig.note = ''; if (render) render(); }, 2500);
  };
  function bodyEmailHandtekeningen() {
    if (!isSuperAdmin() && !(window.DFO?.S?.role === 'manager' || window.DFO?.S?.role === 'admin')) {
      return bodyAccessDenied();
    }
    if (!_sig.loading && !_sig.items.length && !_sig.error) {
      // Auto-load bij eerste render.
      queueMicrotask(fetchSignatures);
    }
    const active = _sig.active; // null=global, of slug
    const draft = _sig.draft;
    const globalRow = _sigFor(null);
    const perMailbox = MAILBOX_SLUGS.map((mb) => ({ mb, row: _sigFor(mb) }));
    return `<div style="max-width:900px">
      ${_sig.error ? `<div class="card" style="padding:12px 16px;background:var(--rose-soft);color:var(--rose);border-radius:10px;margin-bottom:14px">Fout: ${esc(_sig.error)}</div>` : ''}
      ${_sig.loading ? `<div style="padding:20px;color:var(--text-3);text-align:center">Laden…</div>` : ''}

      <div class="card" style="margin-bottom:14px;background:var(--surface);border:1px solid var(--border);border-radius:10px">
        <div style="padding:12px 16px;border-bottom:1px solid var(--border)">
          <div style="font-size:13px;font-weight:600">Beheer handtekeningen</div>
          <div style="font-size:11.5px;color:var(--text-3);margin-top:2px">Klik op een rij om te bewerken. De globale handtekening wordt gebruikt als een mailbox geen eigen handtekening heeft.</div>
        </div>
        <div>
          <button class="btn btn-ghost" onclick="window.__setSigOpen('')" style="display:flex;justify-content:space-between;align-items:center;width:100%;padding:12px 16px;border:none;border-bottom:1px solid var(--border);background:${active === null && draft ? 'var(--surface-2)' : 'transparent'};cursor:pointer;text-align:left">
            <div>
              <div style="font-size:13px;font-weight:600">🌐 Globaal (standaard)</div>
              <div style="font-size:11.5px;color:var(--text-3)">${globalRow?.name || 'Standaard'} · ${globalRow?.body_html ? 'geconfigureerd' : 'leeg — vul in'}</div>
            </div>
            <span style="font-size:11.5px;color:var(--text-3)">bewerken →</span>
          </button>
          ${perMailbox.map((x) => `
            <button class="btn btn-ghost" onclick="window.__setSigOpen('${esc(x.mb)}')" style="display:flex;justify-content:space-between;align-items:center;width:100%;padding:12px 16px;border:none;border-bottom:1px solid var(--border);background:${active === x.mb && draft ? 'var(--surface-2)' : 'transparent'};cursor:pointer;text-align:left">
              <div>
                <div style="font-size:13px;font-weight:600">📮 ${esc(x.mb)}@deforexopleiding.nl</div>
                <div style="font-size:11.5px;color:var(--text-3)">${x.row ? (x.row.name || 'Eigen handtekening') : 'geen eigen — valt terug op globale'}</div>
              </div>
              <span style="font-size:11.5px;color:var(--text-3)">bewerken →</span>
            </button>
          `).join('')}
        </div>
      </div>

      ${draft ? `
      <div class="card" style="background:var(--surface);border:1px solid var(--border);border-radius:10px">
        <div style="padding:12px 16px;border-bottom:1px solid var(--border);background:var(--surface-2)">
          <div style="font-size:13px;font-weight:600">${active === null ? '🌐 Globale handtekening bewerken' : '📮 Handtekening voor ' + esc(active) + '@deforexopleiding.nl bewerken'}</div>
        </div>
        <div style="padding:14px 16px;display:flex;flex-direction:column;gap:12px">
          <label>
            <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Naam (intern label)</div>
            <input type="text" value="${esc(draft.name)}" oninput="window.__setSigField('name', this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px" />
          </label>
          <label>
            <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">HTML (voor mail-clients met opmaak)</div>
            <textarea oninput="window.__setSigField('body_html', this.value)" rows="6" placeholder="<br><br>Met vriendelijke groet,<br>Team – De Forex Opleiding<br><a href='https://deforexopleiding.nl'>deforexopleiding.nl</a>" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12.5px;font-family:'IBM Plex Mono',monospace;line-height:1.5;resize:vertical">${esc(draft.body_html)}</textarea>
          </label>
          <label>
            <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Platte tekst (voor mail-clients zonder HTML)</div>
            <textarea oninput="window.__setSigField('body_text', this.value)" rows="4" placeholder="\n\nMet vriendelijke groet,\nTeam – De Forex Opleiding" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12.5px;font-family:'IBM Plex Mono',monospace;line-height:1.5;resize:vertical">${esc(draft.body_text)}</textarea>
          </label>
          <label>
            <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Logo-URL (optioneel, publieke URL — bv. https://forex-opleiding-interface.vercel.app/dfo-logo-email.png)</div>
            <input type="url" value="${esc(draft.logo_url)}" oninput="window.__setSigField('logo_url', this.value)" placeholder="https://…" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12.5px" />
          </label>
          <div style="padding:10px 12px;background:var(--surface-2);border-radius:6px;font-size:11.5px;color:var(--text-3);line-height:1.55">
            <b>Tip:</b> voor betrouwbaardere weergave in Outlook/iOS Mail kan een toekomstige versie het logo als inline attachment (CID) versturen. Nu wordt de URL rechtstreeks in de HTML gebruikt. Sommige clients tonen die pas na klik op "afbeeldingen tonen".
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding-top:8px;border-top:1px solid var(--border)">
            <div style="font-size:11.5px;color:${/fout/i.test(_sig.note) ? 'var(--rose)' : /opgeslagen|verwijderd/i.test(_sig.note) ? 'var(--emerald)' : 'var(--text-3)'}">${esc(_sig.note)}</div>
            <div style="display:flex;gap:8px">
              ${active ? `<button class="btn btn-ghost btn-sm" style="color:var(--rose)" onclick="window.__setSigDelete()" ${_sig.busy ? 'disabled' : ''}>Verwijderen</button>` : ''}
              <button class="btn btn-primary btn-sm" onclick="window.__setSigSave()" ${_sig.busy ? 'disabled' : ''}>${_sig.busy ? 'Bezig…' : 'Opslaan'}</button>
            </div>
          </div>
        </div>
      </div>` : `
      <div class="set-empty">
        <span class="set-empty-ico">${svg(I.mail)}</span>
        <div class="set-empty-t">Kies een handtekening om te bewerken</div>
        <div class="set-empty-s">Klik hierboven op "Globaal" of op een specifieke mailbox.</div>
      </div>`}
    </div>`;
  }

  /* ═════════════════════════════════════════════════════════════════════
     v=5 — COMMUNICATIE · E-mail-sjablonen (DEEL 2 v2 email-round afbouw).
     Volledige CRUD: lijst + editor + soft-delete. Writes via
     POST /api/email-templates (supabaseAdmin, super_admin/admin/manager
     gate). RLS is deny-all voor client — service-role in endpoint.
     ═════════════════════════════════════════════════════════════════════ */
  const TPL_CATEGORIES = ['algemeen', 'sales', 'onboarding', 'events', 'wanbetalers', 'partners', 'welkom'];
  const _tpl = {
    loading: false, error: null,
    items: [],          // gehele lijst (incl. inactive)
    active: null,       // id van bewerkt sjabloon; 'new' = nieuw
    draft: null,        // { name, subject, body_html, body_text, category, is_active }
    busy: false, note: '',
    confirm: null,      // { id, name } → delete-confirm modal
  };
  async function fetchEmailTemplates() {
    if (_tpl.loading) return;
    _tpl.loading = true; _tpl.error = null; if (render) render();
    const j = await tryFetch('email-templates', '/api/email-templates?include_inactive=1');
    _tpl.loading = false;
    if (j?.__error) _tpl.error = j.__error;
    else if (j?.error) _tpl.error = j.error;
    else _tpl.items = Array.isArray(j?.items) ? j.items : [];
    if (render) render();
  }
  function _tplBlank() {
    return { name: '', subject: '', body_html: '', body_text: '', category: 'algemeen', is_active: true };
  }
  function _extractVars(text) {
    // {{voornaam}}, {{klant.naam}}, etc. Uniek, gesorteerd, max 30 chars/each.
    const s = String(text || '');
    const set = new Set();
    const re = /\{\{\s*([a-zA-Z0-9_.-]{1,40})\s*\}\}/g;
    let m; while ((m = re.exec(s)) !== null) set.add(m[1]);
    return Array.from(set).sort();
  }
  window.__setTplOpen = (id) => {
    const row = _tpl.items.find((t) => t.id === id);
    if (!row) { _tpl.active = null; _tpl.draft = null; if (render) render(); return; }
    _tpl.active = id;
    _tpl.draft = {
      name: row.name || '', subject: row.subject || '',
      body_html: row.body_html || '', body_text: row.body_text || '',
      category: row.category || 'algemeen',
      is_active: row.is_active !== false,
    };
    _tpl.note = '';
    if (render) render();
  };
  window.__setTplNew = () => {
    _tpl.active = 'new';
    _tpl.draft = _tplBlank();
    _tpl.note = '';
    if (render) render();
  };
  window.__setTplCancel = () => {
    _tpl.active = null; _tpl.draft = null; _tpl.note = '';
    if (render) render();
  };
  window.__setTplField = (k, v) => {
    if (!_tpl.draft) return;
    if (k === 'is_active') _tpl.draft.is_active = !!v;
    else _tpl.draft[k] = String(v == null ? '' : v);
    _tpl.note = '';
  };
  window.__setTplSave = async () => {
    if (_tpl.busy || !_tpl.draft) return;
    const d = _tpl.draft;
    if (!String(d.name || '').trim()) { _tpl.note = 'Naam is verplicht'; if (render) render(); return; }
    _tpl.busy = true; _tpl.note = 'Opslaan…'; if (render) render();
    // Verzamel variabelen client-side (endpoint accepteert ze). Extraheer uit
    // beide body-velden zodat we een complete set hebben.
    const vars = Array.from(new Set([..._extractVars(d.body_html), ..._extractVars(d.body_text)])).sort();
    const payload = {
      name: d.name.trim(),
      subject: d.subject || null,
      body_html: d.body_html || '',
      body_text: d.body_text || '',
      category: d.category || 'algemeen',
      variables: vars,
      is_active: !!d.is_active,
    };
    if (_tpl.active && _tpl.active !== 'new') payload.id = _tpl.active;
    const j = await tryFetch('tpl-save', '/api/email-templates', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, 15000);
    _tpl.busy = false;
    if (j?.__error || j?.error) {
      _tpl.note = 'Fout: ' + (j.__error || j.error);
      if (render) render(); return;
    }
    // Merge terug in de lijst
    if (j?.item) {
      const idx = _tpl.items.findIndex((t) => t.id === j.item.id);
      if (idx >= 0) _tpl.items[idx] = j.item;
      else _tpl.items.push(j.item);
      _tpl.active = j.item.id;
      _tpl.draft = {
        name: j.item.name || '', subject: j.item.subject || '',
        body_html: j.item.body_html || '', body_text: j.item.body_text || '',
        category: j.item.category || 'algemeen',
        is_active: j.item.is_active !== false,
      };
    }
    _tpl.note = 'Opgeslagen';
    if (render) render();
    setTimeout(() => { _tpl.note = ''; if (render) render(); }, 2500);
  };
  window.__setTplDeleteConfirm = (id) => {
    const row = _tpl.items.find((t) => t.id === id);
    if (!row) return;
    _tpl.confirm = { id, name: row.name || '(zonder naam)' };
    if (render) render();
  };
  window.__setTplDeleteCancel = () => { _tpl.confirm = null; if (render) render(); };
  window.__setTplDeleteOk = async () => {
    const c = _tpl.confirm; if (!c) return;
    _tpl.confirm = null;
    _tpl.busy = true; _tpl.note = 'Verwijderen…'; if (render) render();
    const j = await tryFetch('tpl-del', '/api/email-templates?id=' + encodeURIComponent(c.id), { method: 'DELETE' }, 10000);
    _tpl.busy = false;
    if (j?.__error || j?.error) { _tpl.note = 'Fout: ' + (j.__error || j.error); if (render) render(); return; }
    // Soft-delete: is_active=false lokaal spiegelen zodat de rij zichtbaar
    // blijft (grijs) — user kan 'em reactiveren via de active-toggle.
    const idx = _tpl.items.findIndex((t) => t.id === c.id);
    if (idx >= 0) _tpl.items[idx].is_active = false;
    if (_tpl.active === c.id && _tpl.draft) _tpl.draft.is_active = false;
    _tpl.note = 'Gedeactiveerd (soft-delete)';
    if (render) render();
    setTimeout(() => { _tpl.note = ''; if (render) render(); }, 3000);
  };

  function bodyEmailSjablonen() {
    if (!isSuperAdmin() && !(window.DFO?.S?.role === 'manager' || window.DFO?.S?.role === 'admin')) {
      return bodyAccessDenied();
    }
    if (!_tpl.loading && !_tpl.items.length && !_tpl.error) queueMicrotask(fetchEmailTemplates);
    const draft = _tpl.draft;
    const active = _tpl.active;
    // Groepeer per categorie voor de lijst.
    const byCat = {};
    for (const t of _tpl.items) { (byCat[t.category || 'algemeen'] ||= []).push(t); }
    const cats = Object.keys(byCat).sort();
    const varsPreview = draft
      ? Array.from(new Set([..._extractVars(draft.body_html), ..._extractVars(draft.body_text)])).sort()
      : [];
    return `<div style="max-width:1100px">
      ${_tpl.error ? `<div class="card" style="padding:12px 16px;background:var(--rose-soft);color:var(--rose);border-radius:10px;margin-bottom:14px">Fout: ${esc(_tpl.error)}</div>` : ''}
      <div class="card" style="margin-bottom:14px;background:var(--surface);border:1px solid var(--border);border-radius:10px">
        <div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
          <div>
            <div style="font-size:13px;font-weight:600">Berichtsjablonen</div>
            <div style="font-size:11.5px;color:var(--text-3);margin-top:2px">Beschikbaar in de compose/reply-picker (📄-knop). Alleen <b>active</b> sjablonen tonen daar.</div>
          </div>
          <button class="btn btn-primary btn-sm" onclick="window.__setTplNew()" ${_tpl.busy ? 'disabled' : ''}>+ Nieuw sjabloon</button>
        </div>
        <div>
          ${_tpl.loading ? '<div style="padding:20px;text-align:center;color:var(--text-3)">Laden…</div>' : ''}
          ${!_tpl.loading && _tpl.items.length === 0 ? `<div style="padding:24px;text-align:center;color:var(--text-3);font-size:13px">Nog geen sjablonen. Klik "+ Nieuw sjabloon" om je eerste aan te maken.</div>` : ''}
          ${cats.map((cat) => `
            <div style="padding:8px 16px 4px;font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--text-3);border-top:1px solid var(--border);background:var(--surface-2)">${esc(cat)}</div>
            ${byCat[cat].map((t) => `
              <div style="padding:10px 16px;display:flex;justify-content:space-between;align-items:center;gap:12px;border-bottom:1px solid var(--border);${active === t.id ? 'background:var(--surface-2)' : ''};${!t.is_active ? 'opacity:.55' : ''}">
                <div style="flex:1;min-width:0;cursor:pointer" onclick="window.__setTplOpen('${esc(t.id)}')">
                  <div style="font-size:13px;font-weight:600;color:var(--text)">${esc(t.name)}${!t.is_active ? ' <span style="font-size:10.5px;color:var(--text-3);font-weight:400">(inactief)</span>' : ''}</div>
                  <div style="font-size:11.5px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(String(t.subject || '(geen onderwerp)').slice(0, 120))}</div>
                </div>
                <button class="btn btn-ghost btn-sm" onclick="window.__setTplOpen('${esc(t.id)}')">Bewerken</button>
                ${t.is_active ? `<button class="btn btn-ghost btn-sm" style="color:var(--rose)" onclick="window.__setTplDeleteConfirm('${esc(t.id)}')">Verwijderen</button>` : ''}
              </div>
            `).join('')}
          `).join('')}
        </div>
      </div>

      ${draft ? `
      <div class="card" style="background:var(--surface);border:1px solid var(--border);border-radius:10px">
        <div style="padding:12px 16px;border-bottom:1px solid var(--border);background:var(--surface-2);display:flex;justify-content:space-between;align-items:center">
          <div style="font-size:13px;font-weight:600">${active === 'new' ? '📄 Nieuw sjabloon' : '✏ Sjabloon bewerken'}</div>
          <button class="btn btn-ghost btn-sm" onclick="window.__setTplCancel()">Sluit</button>
        </div>
        <div style="padding:14px 16px;display:flex;flex-direction:column;gap:12px">
          <div style="display:grid;grid-template-columns:2fr 1fr;gap:12px">
            <label>
              <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Naam <span style="color:var(--rose)">*</span></div>
              <input type="text" value="${esc(draft.name)}" oninput="window.__setTplField('name', this.value)" placeholder="Bijv. Welkom nieuwe klant" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px" />
            </label>
            <label>
              <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Categorie</div>
              <select onchange="window.__setTplField('category', this.value)" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px">
                ${TPL_CATEGORIES.map((c) => `<option value="${esc(c)}" ${draft.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
              </select>
            </label>
          </div>
          <label>
            <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Onderwerp (optioneel — vult subject als leeg bij invoegen)</div>
            <input type="text" value="${esc(draft.subject)}" oninput="window.__setTplField('subject', this.value)" placeholder="Bijv. Welkom bij De Forex Opleiding" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:13px" />
          </label>
          <label>
            <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Body HTML (voor mail-clients met opmaak)</div>
            <textarea oninput="window.__setTplField('body_html', this.value)" rows="8" placeholder="<p>Hoi {{voornaam}},</p>" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12.5px;font-family:'IBM Plex Mono',monospace;line-height:1.5;resize:vertical">${esc(draft.body_html)}</textarea>
          </label>
          <label>
            <div style="font-size:11.5px;color:var(--text-3);margin-bottom:4px">Body platte tekst (voor mail-clients zonder HTML)</div>
            <textarea oninput="window.__setTplField('body_text', this.value)" rows="5" placeholder="Hoi {{voornaam}},\n\n..." style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);font-size:12.5px;font-family:'IBM Plex Mono',monospace;line-height:1.5;resize:vertical">${esc(draft.body_text)}</textarea>
          </label>
          <div>
            <div style="font-size:11.5px;color:var(--text-3);margin-bottom:6px">Variabelen (auto-gedetecteerd uit <span class="mono">{{key}}</span>-placeholders)</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px">
              ${varsPreview.length === 0
                ? `<span style="font-size:11.5px;color:var(--text-3);font-style:italic">Geen variabelen in body — gebruik <span class="mono">{{voornaam}}</span> / <span class="mono">{{klant.naam}}</span> etc.</span>`
                : varsPreview.map((v) => `<span style="padding:3px 10px;background:var(--violet-soft, var(--surface-2));color:var(--violet, var(--text-2));border-radius:20px;font-size:11.5px;font-family:'IBM Plex Mono',monospace">{{${esc(v)}}}</span>`).join('')
              }
            </div>
          </div>
          <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;cursor:pointer">
            <input type="checkbox" ${draft.is_active ? 'checked' : ''} onchange="window.__setTplField('is_active', this.checked)" style="width:16px;height:16px;cursor:pointer" />
            <span>Actief (zichtbaar in compose-picker)</span>
          </label>
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding-top:8px;border-top:1px solid var(--border)">
            <div style="font-size:11.5px;color:${/fout/i.test(_tpl.note) ? 'var(--rose)' : /opgeslagen|gedeactiveerd/i.test(_tpl.note) ? 'var(--emerald)' : 'var(--text-3)'}">${esc(_tpl.note)}</div>
            <div style="display:flex;gap:8px">
              <button class="btn btn-ghost btn-sm" onclick="window.__setTplCancel()">Annuleren</button>
              <button class="btn btn-primary btn-sm" onclick="window.__setTplSave()" ${_tpl.busy ? 'disabled' : ''}>${_tpl.busy ? 'Bezig…' : (active === 'new' ? 'Aanmaken' : 'Opslaan')}</button>
            </div>
          </div>
        </div>
      </div>` : ''}

      ${_tpl.confirm ? `
      <div style="position:fixed;inset:0;background:rgba(17,23,33,.48);z-index:2100;display:flex;align-items:center;justify-content:center;padding:20px" onclick="window.__setTplDeleteCancel()">
        <div style="background:var(--surface);border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.32);max-width:440px;width:100%;padding:22px 24px" onclick="event.stopPropagation()">
          <div style="font-size:15px;font-weight:600;color:var(--text);margin-bottom:8px">Sjabloon deactiveren?</div>
          <div style="font-size:13px;color:var(--text-2);line-height:1.55;margin-bottom:18px">
            Sjabloon <b>${esc(_tpl.confirm.name)}</b> wordt gedeactiveerd (soft-delete). Het verdwijnt uit de compose-picker maar blijft bewaard — je kunt 'm later reactiveren via de "Actief"-toggle.
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px">
            <button class="btn btn-ghost btn-sm" onclick="window.__setTplDeleteCancel()">Annuleren</button>
            <button class="btn btn-primary btn-sm" style="background:var(--rose);border-color:var(--rose)" onclick="window.__setTplDeleteOk()">Deactiveren</button>
          </div>
        </div>
      </div>` : ''}
    </div>`;
  }

  function setBody(cur) {
    if (cur.id === 'com-wa')             return bodyWhatsApp();
    if (cur.id === 'com-handtekening')   return bodyEmailHandtekeningen();
    if (cur.id === 'com-sjabloon')       return bodyEmailSjablonen();
    if (cur.id === 'team-rechten')       return bodyRechten();
    if (cur.id === 'alg-bedrijf')        return bodyBedrijf();
    if (cur.id === 'wb-venster')         return bodyVenster();
    if (cur.id === 'sys-followup-admin') return bodySysFollowupAdmin();
    return bodyPlaceholder(cur);
  }

  function instView() {
    // v=3: nav-level rol-filter. Items met een `roles`-veld worden alleen
    // getoond als de huidige rol voorkomt. Groepen zonder overgebleven items
    // worden verborgen. Als de huidige S.setPage niet meer zichtbaar is (bv.
    // door role-switch via "Bekijk als"), fallback naar de eerste zichtbare.
    const currentRole = (window.DFO?.S?.role || window.KV_V2?.role || '') || '';
    const isVisible = (it) => !Array.isArray(it.roles) || it.roles.includes(currentRole);
    const setsVisible = SETS
      .map((g) => ({ g: g.g, items: g.items.filter(isVisible) }))
      .filter((g) => g.items.length > 0);
    const flat = setsVisible.flatMap((g) => g.items);
    if (!S.setPage || !flat.some((i) => i.id === S.setPage)) {
      S.setPage = flat[0]?.id || 'sales-trajecten';
    }
    const cur = flat.find((i) => i.id === S.setPage) || flat[0];
    return `${H.voorbeeldBanner()}
      <div class="set-split">
        <div class="set-nav">
          ${setsVisible.map(g => `
            <div class="set-group">${g.g}</div>
            ${g.items.map(i => `<button class="set-item ${S.setPage === i.id ? 'is-on' : ''}" onclick="__setPick('${i.id}')">
              ${svg(i.ic)}<span>${i.n}</span>
            </button>`).join('')}
          `).join('')}
        </div>
        <div class="set-body">
          <div class="set-head">
            <div class="set-h1">${cur.n}</div>
            <div class="set-p">${cur.d}</div>
          </div>
          <div class="set-content">${setBody(cur)}</div>
        </div>
      </div>
      ${_renderConfirmModal()}`;
  }

  window.DFO.VIEWS['instellingen/'] = instView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('instellingen');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('instellingen');
  console.debug('[instellingen-v2] v=5 — Berichtsjablonen volledige CRUD-UI (lijst + editor + soft-delete + variabelen-chips). E-mail-handtekeningen ongewijzigd t.o.v. v=4.');
})();
