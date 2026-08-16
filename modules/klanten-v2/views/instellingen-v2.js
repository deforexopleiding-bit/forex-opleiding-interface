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
      { id: 'com-wa',           n: 'WhatsApp',             d: 'Meta-koppeling en goedgekeurde templates',                  ic: I.chat || I.mail },
      { id: 'com-tel',          n: 'Telefonie',            d: 'Voys-koppeling en belinstellingen',                         ic: I.phone },
      { id: 'com-sjabloon',     n: 'Berichtsjablonen',     d: 'Alle standaardteksten op één plek',                         ic: I.doc },
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
    // v=2 — Systeem-groep. Alleen zichtbaar voor super_admin; body rendert
    // "geen toegang" voor andere rollen (server-side gate op endpoints
    // blijft de laatste laag). Volle set: backfill-tools + info-cards
    // over de server-side crons/webhooks die Follow-up voedt.
    { g: 'Systeem', items: [
      { id: 'sys-followup-admin', n: 'Follow-up admin-tools', d: 'Backfill GHL-contacts + GHL-status-backfill · super_admin only', ic: I.settings },
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

  function setBody(cur) {
    if (cur.id === 'com-wa')            return bodyWhatsApp();
    if (cur.id === 'team-rechten')      return bodyRechten();
    if (cur.id === 'alg-bedrijf')       return bodyBedrijf();
    if (cur.id === 'wb-venster')        return bodyVenster();
    if (cur.id === 'sys-followup-admin') return bodySysFollowupAdmin();
    return bodyPlaceholder(cur);
  }

  function instView() {
    if (!S.setPage) S.setPage = 'sales-trajecten';
    const flat = SETS.flatMap(g => g.items);
    const cur  = flat.find(i => i.id === S.setPage) || flat[0];
    return `${H.voorbeeldBanner()}
      <div class="set-split">
        <div class="set-nav">
          ${SETS.map(g => `
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
  console.debug('[instellingen-v2] v=2 — Systeem-groep + Follow-up admin-tools (super_admin only, verhuisd uit followup-v2 v=16)');
})();
