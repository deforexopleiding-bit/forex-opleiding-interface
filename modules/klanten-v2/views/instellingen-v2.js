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
  const { I, svg, F, setF, S } = window.DFO;
  const H = window.KV_V2.helpers;

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
          </div>`).join('') : `<div class="empty">${svg(I.chat || I.mail)}<div class="empty-t">Geen templates in deze map</div><div class="empty-s">Maak een nieuwe template of kies een andere map.</div></div>`}
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
    return `<div class="empty" style="padding:52px 20px">
      ${svg(I.settings)}
      <div class="empty-t">Instellingen voor "${cur.n}"</div>
      <div class="empty-s">Deze instellingen staan nu nog verspreid in de modules. Ze verhuizen allemaal hierheen, zodat je alles vanaf één plek regelt. Detail-panel komt in de data-ronde.</div>
    </div>`;
  }

  function setBody(cur) {
    if (cur.id === 'com-wa')       return bodyWhatsApp();
    if (cur.id === 'team-rechten') return bodyRechten();
    if (cur.id === 'alg-bedrijf')  return bodyBedrijf();
    if (cur.id === 'wb-venster')   return bodyVenster();
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
      </div>`;
  }

  window.DFO.VIEWS['instellingen/'] = instView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('instellingen');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('instellingen');
  console.debug('[instellingen-v2] registered 1 view (dormant)');
})();
