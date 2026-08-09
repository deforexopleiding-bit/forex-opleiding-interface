// modules/klanten-v2/views/tickets-v2.js
//
// Fase B — Tickets-module layout voor v2-shell (layout-only, voorbeeld-data).
// 1-op-1 render uit docs/redesign/systeemprototype-v45.html:
//   - prioPill / tktToolbar          r2752-2755
//   - VIEWS['tickets/Open']          r2756-2767
//   - VIEWS['tickets/Wacht op klant'] r2769-2783
//   - VIEWS['tickets/Afgehandeld']   r2785-2801
//   - TICKETS                        r1378-1390  (11 voorbeeld-tickets)
//
// Non-ES-module. Consumeert helpers uit window.KV_V2.helpers.
//
// Registreert:
//   DFO.VIEWS['tickets/Open']
//   DFO.VIEWS['tickets/Wacht op klant']
//   DFO.VIEWS['tickets/Afgehandeld']
//   window.KV_V2_ADD?.('tickets')

(function () {
  if (!window.DFO) { console.error('[tickets-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[tickets-v2] KV_V2.helpers niet geladen (laad _shared-v2.js eerst).'); return; }

  const { I, svg, F } = window.DFO;
  const H = window.KV_V2.helpers;

  /* ── Voorbeeld-data (prototype r1378-1390) ────────────────────────── */
  const TICKETS = [
    { nr: '#2841', klant: 'Ebenezer Adjei',     ond: 'Inloggen lukt niet in de LMS',   prio: 'hoog',   status: 'open',        wacht: '2u', toegewezen: 'Jeffrey' },
    { nr: '#2840', klant: 'Jan Willem Bel',     ond: 'Factuur klopt niet',              prio: 'midden', status: 'open',        wacht: '5u', toegewezen: 'Amigo' },
    { nr: '#2835', klant: 'Christa Noltus',     ond: 'Vraag over betaalregeling',       prio: 'midden', status: 'open',        wacht: '3u', toegewezen: 'Jeffrey' },
    { nr: '#2838', klant: 'Nikita Bykov',       ond: 'Sessie verzetten',                prio: 'laag',   status: 'wacht',       wacht: '1d', toegewezen: 'Dave',    herinnerd: true },
    { nr: '#2837', klant: 'Sander Pieters',     ond: 'Toegangslink niet ontvangen',     prio: 'midden', status: 'wacht',       wacht: '6u', toegewezen: 'Jeffrey', herinnerd: false },
    { nr: '#2834', klant: 'Aysar Al Dujaili',   ond: 'Wil factuuradres wijzigen',       prio: 'laag',   status: 'wacht',       wacht: '2d', toegewezen: 'Amigo',   herinnerd: true },
    { nr: '#2832', klant: 'Emile Rabaut',       ond: 'Betaalregeling aanvragen',        prio: 'midden', status: 'afgehandeld', wacht: '—',  toegewezen: 'Jeffrey', opgelost: '6 aug', duur: '4u' },
    { nr: '#2830', klant: 'Miriam Osei',        ond: 'Vraag over startdatum event',     prio: 'laag',   status: 'afgehandeld', wacht: '—',  toegewezen: 'Dave',    opgelost: '6 aug', duur: '1u' },
    { nr: '#2829', klant: 'Kevin Braams',       ond: 'Wachtwoord reset LMS',            prio: 'laag',   status: 'afgehandeld', wacht: '—',  toegewezen: 'Jeffrey', opgelost: '5 aug', duur: '20m' },
    { nr: '#2827', klant: 'Valentine Manisha',  ond: 'Dubbele afschrijving gemeld',     prio: 'hoog',   status: 'afgehandeld', wacht: '—',  toegewezen: 'Amigo',   opgelost: '5 aug', duur: '2u' },
    { nr: '#2825', klant: 'Karim Alian',        ond: 'Opzegverzoek membership',         prio: 'midden', status: 'afgehandeld', wacht: '—',  toegewezen: 'Joost',   opgelost: '4 aug', duur: '1d' },
  ];

  /* ── Prio-pill + toolbar (prototype r2752-2755) ───────────────────── */
  const prioPill = p => H.pill(p === 'hoog' ? 'danger' : p === 'midden' ? 'warn' : 'neutral', p[0].toUpperCase() + p.slice(1));
  const tktToolbar = () => H.toolbar([
    H.chips('p', [{ l: 'Alle prioriteiten', v: 'all' }, { l: 'Hoog', v: 'h' }, { l: 'Midden', v: 'm' }, { l: 'Laag', v: 'l' }], F('p', 'all')),
    `<select class="filter-sel"><option>Iedereen</option><option>Amigo</option><option>Jeffrey</option><option>Dave</option></select>`,
    H.search('Zoek ticket…'),
    `<div class="tb-right"><button class="btn btn-primary">${svg(I.plus)}Nieuw ticket</button></div>`,
  ]);

  /* ── Tab-views ────────────────────────────────────────────────────── */

  // Tickets/Open (prototype r2756-2767)
  function ticketsOpenView() {
    return `${H.voorbeeldBanner()}
    ${H.kpis([
      { c: 'rose',    icon: I.ticket, label: 'Open tickets',          val: '3',   hi: 1, sub: '1 met hoge prioriteit' },
      { c: 'amber',   icon: I.clock,  label: 'Gem. wachttijd',        val: '3,2u', hi: 1, sub: 'deze week', trend: H.trend('-40m', true) },
      { c: 'emerald', icon: I.tick,   label: 'Opgelost deze week',    val: '18',   hi: 1, sub: 'gemiddeld in 5u' },
    ])}
    ${tktToolbar()}
    ${H.table(
      [{ l: 'Ticket' }, { l: 'Klant' }, { l: 'Onderwerp' }, { l: 'Toegewezen', cls: 'optional' }, { l: 'Wacht', cls: 'optional' }, { l: 'Prioriteit' }],
      TICKETS.filter(t => t.status === 'open').map(t => [
        `<span class="cell-main mono">${t.nr}</span>`,
        `<div class="row-avatar">${H.av(t.klant, 26)}<span>${t.klant}</span></div>`,
        `<span class="cell-main">${t.ond}</span>`,
        t.toegewezen,
        `<span class="mono" style="color:var(--text-3);font-size:12.5px">${t.wacht}</span>`,
        prioPill(t.prio),
      ])
    )}`;
  }

  // Tickets/Wacht op klant (prototype r2769-2783)
  function ticketsWachtView() {
    const rows = TICKETS.filter(t => t.status === 'wacht');
    return `${H.voorbeeldBanner()}
    ${H.kpis([
      { c: 'amber', icon: I.clock, label: 'Wacht op klant',          val: String(rows.length),                        hi: 1, sub: 'reactie afwachten' },
      { c: 'blue',  icon: I.mail,  label: 'Herinnering verstuurd',    val: String(rows.filter(t => t.herinnerd).length),     sub: 'automatisch na 3 dagen' },
      { c: 'slate', icon: I.x,     label: 'Sluit automatisch',        val: '1',                                              sub: 'bij 48u geen reactie' },
    ])}
    ${tktToolbar()}
    ${H.table(
      [{ l: 'Ticket' }, { l: 'Klant' }, { l: 'Onderwerp' }, { l: 'Toegewezen', cls: 'optional' }, { l: 'Wacht al', cls: 'optional' }, { l: 'Status' }],
      rows.map(t => [
        `<span class="cell-main mono">${t.nr}</span>`,
        `<div class="row-avatar">${H.av(t.klant, 26)}<span>${t.klant}</span></div>`,
        `<span class="cell-main">${t.ond}</span>`,
        t.toegewezen,
        `<span class="mono" style="color:var(--text-3);font-size:12.5px">${t.wacht}</span>`,
        t.herinnerd ? H.pill('accent', 'Herinnerd') : H.pill('warn', 'Wacht op klant'),
      ])
    )}`;
  }

  // Tickets/Afgehandeld (prototype r2785-2801)
  function ticketsAfgehandeldView() {
    const rows = TICKETS.filter(t => t.status === 'afgehandeld');
    return `${H.voorbeeldBanner()}
    ${H.kpis([
      { c: 'emerald', icon: I.tick,   label: 'Opgelost deze week', val: '18',    hi: 1, sub: '5 vandaag' },
      { c: 'blue',    icon: I.clock,  label: 'Gem. oplostijd',     val: '4,8u',        sub: 'binnen SLA' },
      { c: 'amber',   icon: I.repeat, label: 'Heropend',           val: '1',           sub: 'deze week' },
    ])}
    ${H.toolbar([
      H.chips('fd', [{ l: 'Vandaag', v: 'd' }, { l: 'Deze week', v: 'w' }, { l: 'Deze maand', v: 'm' }], F('fd', 'w')),
      `<select class="filter-sel"><option>Iedereen</option><option>Amigo</option><option>Jeffrey</option><option>Joost</option><option>Dave</option></select>`,
      H.search('Zoek ticket…'),
    ])}
    ${H.table(
      [{ l: 'Ticket' }, { l: 'Klant' }, { l: 'Onderwerp' }, { l: 'Opgelost door', cls: 'optional' }, { l: 'Duur', cls: 'optional' }, { l: 'Opgelost' }],
      rows.map(t => [
        `<span class="cell-main mono">${t.nr}</span>`,
        `<div class="row-avatar">${H.av(t.klant, 26)}<span>${t.klant}</span></div>`,
        `<span class="cell-main">${t.ond}</span>`,
        t.toegewezen,
        `<span class="mono" style="color:var(--text-3);font-size:12.5px">${t.duur}</span>`,
        `<span style="display:inline-flex;align-items:center;gap:8px">${H.pill('ok', 'Opgelost')}<span class="mono" style="color:var(--text-3);font-size:12px">${t.opgelost}</span></span>`,
      ])
    )}`;
  }

  /* ── Registratie ───────────────────────────────────────────────────── */
  window.DFO.VIEWS['tickets/Open']            = ticketsOpenView;
  window.DFO.VIEWS['tickets/Wacht op klant']  = ticketsWachtView;
  window.DFO.VIEWS['tickets/Afgehandeld']     = ticketsAfgehandeldView;
  if (typeof window.KV_V2_ADD === 'function') {
    window.KV_V2_ADD('tickets');
  } else {
    (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('tickets');
  }

  console.debug('[tickets-v2] registered VIEWS[tickets/Open|Wacht op klant|Afgehandeld]');
})();
