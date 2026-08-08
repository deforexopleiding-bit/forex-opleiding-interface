// B3 — Tickets (Open / Wacht op klant / Afgehandeld)
// Scaffold uit systeemprototype-v45.html r2756-2844.

(function () {
  if (!window.DFO) return;
  const { svg, I } = window.DFO;
  const { av, pill, previewBadge, kpis, toolbar, search, table } = window.V2Shared || {};
  if (!av) { console.error('[tickets-v2] V2Shared niet geladen'); return; }

  const TICKETS = [
    { nr: '#2841', klant: 'Ebenezer Adjei', ond: 'Inloggen lukt niet in de LMS', prio: 'hoog',   status: 'open', wacht: '2u', toegewezen: 'Jeffrey' },
    { nr: '#2840', klant: 'Jan Willem Bel',  ond: 'Factuur klopt niet',          prio: 'midden', status: 'open', wacht: '5u', toegewezen: 'Amigo' },
    { nr: '#2835', klant: 'Christa Noltus',  ond: 'Vraag over betaalregeling',   prio: 'midden', status: 'open', wacht: '3u', toegewezen: 'Jeffrey' },
    { nr: '#2838', klant: 'Nikita Bykov',    ond: 'Sessie verzetten',            prio: 'laag',   status: 'wacht', wacht: '1d', toegewezen: 'Dave', herinnerd: true },
    { nr: '#2837', klant: 'Sander Pieters',  ond: 'Toegangslink niet ontvangen', prio: 'midden', status: 'wacht', wacht: '6u', toegewezen: 'Jeffrey' },
    { nr: '#2834', klant: 'Aysar Al Dujaili', ond: 'Wil factuuradres wijzigen',  prio: 'laag',   status: 'wacht', wacht: '2d', toegewezen: 'Amigo', herinnerd: true },
    { nr: '#2832', klant: 'Emile Rabaut',    ond: 'Betaalregeling aanvragen',    prio: 'midden', status: 'afgehandeld', wacht: '—', toegewezen: 'Jeffrey', opgelost: '6 aug', duur: '4u' },
    { nr: '#2830', klant: 'Miriam Osei',     ond: 'Vraag over startdatum event', prio: 'laag',   status: 'afgehandeld', wacht: '—', toegewezen: 'Dave', opgelost: '6 aug', duur: '1u' },
  ];

  const prioPill = p => pill(p === 'hoog' ? 'danger' : p === 'midden' ? 'warn' : 'neutral', p);

  const kpiStrip = () => kpis([
    { c: 'rose',    icon: I.alert,  label: 'Open tickets',      val: TICKETS.filter(t => t.status === 'open').length,        sub: '3 vragen aandacht', hi: 1 },
    { c: 'amber',   icon: I.clock || I.alert,  label: 'Wacht op klant', val: TICKETS.filter(t => t.status === 'wacht').length, sub: '2 al herinnerd' },
    { c: 'emerald', icon: I.check2, label: 'Afgehandeld', val: TICKETS.filter(t => t.status === 'afgehandeld').length,  sub: 'deze week' },
    { c: 'teal',    icon: I.clock || I.up, label: 'Gem. reactietijd', val: '3,2u', sub: 'over 30 dagen' },
  ]);

  function ticketTable(status) {
    const rows = TICKETS.filter(t => t.status === status);
    return `<div style="padding:0 20px">
      ${table(
        [{ l: 'Nr' }, { l: 'Klant' }, { l: 'Onderwerp' }, { l: 'Prioriteit' }, { l: 'Wacht' }, { l: 'Toegewezen' }],
        rows.map(t => [
          `<span class="mono" style="font-size:12.5px">${t.nr}</span>`,
          `<div style="display:flex;align-items:center;gap:8px">${av(t.klant, 26)}<span class="cell-main">${t.klant}</span></div>`,
          `<span class="cell-main" style="font-size:13px">${t.ond}</span>${t.herinnerd ? '<span style="margin-left:6px;font-size:10.5px;color:var(--amber)">· herinnerd</span>' : ''}`,
          prioPill(t.prio),
          `<span class="mono" style="font-size:12.5px;color:${t.wacht.endsWith('d') ? 'var(--rose)' : 'var(--text-2)'}">${t.wacht}</span>`,
          `<div style="display:flex;align-items:center;gap:6px">${av(t.toegewezen, 22)}<span style="font-size:12px">${t.toegewezen}</span></div>`,
        ])
      )}
    </div>`;
  }

  window.DFO.VIEWS['tickets/Open']            = () => `${previewBadge()}${kpiStrip()}${toolbar([search('Zoek ticket…'), `<button class="btn btn-primary" style="margin-left:auto">${svg(I.plus)}Nieuw ticket</button>`])}${ticketTable('open')}`;
  window.DFO.VIEWS['tickets/Wacht op klant'] = () => `${previewBadge()}${kpiStrip()}${toolbar([search('Zoek ticket…')])}${ticketTable('wacht')}`;
  window.DFO.VIEWS['tickets/Afgehandeld']     = () => `${previewBadge()}${kpiStrip()}${toolbar([search('Zoek ticket…')])}${ticketTable('afgehandeld')}`;
  window.DFO.VIEWS['tickets/']                = window.DFO.VIEWS['tickets/Open'];

  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('tickets');
  else window.KV_V2_PENDING = (window.KV_V2_PENDING || []).concat('tickets');
})();
