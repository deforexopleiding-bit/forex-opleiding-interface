// modules/klanten-v2/views/sales-v2.js
//
// Fase C module #1 — Sales-module layout voor v2-shell (layout-only, voorbeeld-data).
// 1-op-1 render uit docs/redesign/systeemprototype-v45.html:
//   - dashSalesModule                        r2421-2467  (rolspecifiek KPI's + funnel + gauge + leaderboard)
//   - VIEWS['sales/Dashboard']               r2468       (= dashSalesModule)
//   - VIEWS['sales/Offertes']                r2469-2490
//   - VIEWS['sales/Retentie']                r2491-2507
//   - VIEWS['sales/Verkoopprestaties']       r2508-2521
//   - OFFERTES + OST                         r1321-1329
//   - RETENTIE + RST                         r1356-1362
//   - hbar / funnel / dashCard / targetGauge r1440-1463  (dashboard-componenten)
//
// Non-ES-module. Consumeert shared helpers uit window.KV_V2.helpers.
//
// Registreert 4 views + KV_V2_ADD('sales') — dormant onder V2_ACTIVE_ALLOWLIST
// tot data-ronde. Preview-review via `?v2preview=sales` URL-param.

(function () {
  if (!window.DFO) { console.error('[sales-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[sales-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, S, F, eur, eur0, render } = window.DFO;
  const H = window.KV_V2.helpers;

  /* ── Voorbeeld-data (prototype r1321-1362) ────────────────────────── */
  const OFFERTES = [
    { nr: 'OFF-2026-214', klant: 'Cabdi Ibrahim',       totaal: 7200, status: 'geaccepteerd', datum: '01-08-2026', verkoper: 'Joost',   traject: '12 maand 1-op-1',      abo: true },
    { nr: 'OFF-2026-219', klant: 'Stéphane Seutin',     totaal: 7200, status: 'verzonden',    datum: '03-08-2026', verkoper: 'Jeffrey', traject: '12 maand 1-op-1',      abo: true },
    { nr: 'OFF-2026-221', klant: 'Emile Rabaut',        totaal: 3950, status: 'geaccepteerd', datum: '04-08-2026', verkoper: 'Joost',   traject: '6 maand 1-op-1',       abo: true },
    { nr: 'OFF-2026-223', klant: 'Rachael Njoki',       totaal: 3950, status: 'concept',      datum: '05-08-2026', verkoper: 'Jeffrey', traject: '6 maand 1-op-1',       abo: false },
    { nr: 'OFF-2026-208', klant: 'Iwan Engelbracht',    totaal: 2400, status: 'verzonden',    datum: '29-07-2026', verkoper: 'Joost',   traject: '36 maand membership',  abo: false },
    { nr: 'OFF-2026-201', klant: 'Alfred Gregoor',      totaal: 7200, status: 'afgewezen',    datum: '22-07-2026', verkoper: 'Jeffrey', traject: '12 maand 1-op-1',      abo: false },
  ];
  const OST = {
    concept:      { l: 'Concept',      c: 'neutral' },
    verzonden:    { l: 'Verzonden',    c: 'accent'  },
    geaccepteerd: { l: 'Geaccepteerd', c: 'ok'      },
    afgewezen:    { l: 'Afgewezen',    c: 'danger'  },
  };
  const RETENTIE = [
    { klant: 'Jan Willem Bel',      plan: '12 maand 1-op-1',     eind: '12-05-2027', resterend: 8, mrr: 600, eigenaar: 'Joost',   status: 'nog niet benaderd' },
    { klant: 'Valentine Manisha',   plan: '12 maand membership', eind: '02-02-2027', resterend: 5, mrr:  80, eigenaar: 'Jeffrey', status: 'in gesprek' },
    { klant: 'Emile Rabaut',        plan: '6 maand 1-op-1',      eind: '04-02-2027', resterend: 5, mrr: 658, eigenaar: 'Joost',   status: 'verlengd' },
    { klant: 'Karim Alian',         plan: '6 maand 1-op-1',      eind: '10-01-2027', resterend: 5, mrr: 658, eigenaar: 'Jeffrey', status: 'wil stoppen' },
  ];
  const RST = {
    'nog niet benaderd': { l: 'Nog niet benaderd', c: 'neutral' },
    'in gesprek':        { l: 'In gesprek',        c: 'accent'  },
    'verlengd':          { l: 'Verlengd',          c: 'ok'      },
    'wil stoppen':       { l: 'Wil stoppen',       c: 'danger'  },
  };

  /* ── Dashboard-componenten (prototype r1441-1463) ─────────────────── */
  const hbar = (label, val, max, color, right) => `<div style="display:flex;align-items:center;gap:12px;margin-bottom:11px">
    <div style="width:118px;font-size:12.5px;color:var(--text-2);flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${label}</div>
    <div class="progress" style="flex:1;height:8px"><i style="width:${max ? Math.round(val / max * 100) : 0}%;background:var(--${color})"></i></div>
    <div style="width:82px;text-align:right;font-size:12.5px;font-weight:600;font-family:'IBM Plex Mono',monospace">${right}</div></div>`;

  const funnel = (stages) => {
    const mx = stages[0][1];
    return `<div style="padding:2px 0">${stages.map(([l, v], i) => {
      const w = Math.round(v / mx * 100), conv = i > 0 ? Math.round(v / stages[i - 1][1] * 100) : 100;
      return `<div style="margin-bottom:${i < stages.length - 1 ? '13px' : '0'}">
        <div style="display:flex;justify-content:space-between;align-items:baseline;font-size:12.5px;margin-bottom:5px">
          <span style="color:var(--text-2);font-weight:500">${l}</span>
          <span style="font-family:'IBM Plex Mono',monospace;font-weight:600">${v}${i > 0 ? `<span style="color:var(--text-3);font-weight:400;font-size:11.5px"> · ${conv}%</span>` : ''}</span></div>
        <div style="height:24px;background:var(--surface-2);border-radius:7px;overflow:hidden">
          <div style="height:100%;width:${w}%;background:linear-gradient(90deg,var(--m),color-mix(in srgb,var(--m) 55%,var(--surface)));border-radius:7px;transition:width .6s cubic-bezier(.32,.72,0,1)"></div></div>
      </div>`;
    }).join('')}</div>`;
  };

  const dashCard = (title, dotColor, body, extra) => `<div class="card">
    <div class="card-head" style="border-bottom:none;padding-bottom:6px">
      <span class="title-dot" style="background:var(--${dotColor});box-shadow:0 0 0 3px var(--${dotColor}-soft)"></span>
      <div class="card-title">${title}</div>${extra || ''}</div>
    <div class="card-body" style="padding:8px 17px 17px">${body}</div></div>`;

  const targetGauge = (behaald, target, color) => {
    const pct = Math.min(100, Math.round(behaald / target * 100));
    return `<div style="text-align:center;padding:6px 0 2px">
      <div style="font-size:32px;font-weight:600;font-family:'IBM Plex Mono',monospace;letter-spacing:-.04em;color:var(--${color})">${pct}%</div>
      <div style="font-size:12px;color:var(--text-3);margin:3px 0 13px">${eur0(behaald)} van ${eur0(target)} target</div>
      <div class="progress" style="height:10px"><i style="width:${pct}%;background:var(--${color})"></i></div></div>`;
  };

  /* ── Notice-handler voor dode action-knoppen ──────────────────────── */
  window.__salesNotice = (label) => {
    console.info('[sales-v2] ' + label + ' (voorbeeld — modal/flow komt in data-ronde)');
    try { alert(label + ' — komt in de data-ronde.'); } catch (_) { /* ignore */ }
  };
  window.__salesOpenOfferte = (i) => { console.info('[sales-v2] openOfferte idx=' + i + ' (voorbeeld — panel komt in data-ronde)'); };
  window.__salesOpenRetentie = (i) => { console.info('[sales-v2] openRetentie idx=' + i + ' (voorbeeld — panel komt in data-ronde)'); };

  /* ── VIEW: Sales/Dashboard (prototype r2421-2468) ─────────────────── */
  function salesDashboardView() {
    const isSales = S.role === 'sales' || S.role === 'mentor';
    const meName = 'Joost'; // dashboard-mock verwacht Joost als "me" voor de leaderboard-highlight
    const kpiArr = isSales ? [
      { c: 'violet',  icon: I.tick,   label: 'Mijn omzet',        val: eur0(10713), sub: '2 getekend deze maand', trend: H.trend('+40%', true) },
      { c: 'blue',    icon: I.doc,    label: 'Mijn pijplijn',     val: eur0(9600),  sub: '2 offertes open' },
      { c: 'emerald', icon: I.target, label: 'Mijn conversie',    val: '67%',        hi: 1, sub: 'laatste 30 dagen', trend: H.trend('+7%', true) },
      { c: 'amber',   icon: I.phone,  label: 'Te bellen vandaag', val: '8',          hi: 1, sub: 'leads en follow-ups' },
    ] : [
      { c: 'violet',  icon: I.tick,   label: 'Omzet getekend',    val: eur0(26250), sub: 'deze maand', trend: H.trend('+18%', true) },
      { c: 'blue',    icon: I.doc,    label: 'Open in pijplijn',  val: eur0(24800), sub: '6 offertes onderweg' },
      { c: 'emerald', icon: I.target, label: 'Conversie',         val: '38%',        hi: 1, sub: 'verzonden → getekend', trend: H.trend('+6%', true) },
      { c: 'amber',   icon: I.euro,   label: 'Gem. dealwaarde',   val: eur0(5250),  sub: 'laatste 30 dagen' },
    ];
    const fun = isSales
      ? [['Mijn leads', 48], ['Gekwalificeerd', 21], ['Offerte verstuurd', 8], ['Getekend', 5]]
      : [['Leads', 101], ['Gekwalificeerd', 42], ['Offerte verstuurd', 18], ['Getekend', 11]];
    const bronnen = isSales
      ? [['Meta Ads', 22, '14%', 'violet'], ['Event Gent', 14, '36%', 'pink'], ['Website', 8, '25%', 'blue'], ['Instagram', 4, '10%', 'teal']]
      : [['Meta Ads', 52, '12%', 'violet'], ['Event Gent', 24, '31%', 'pink'], ['Website', 15, '22%', 'blue'], ['Instagram', 10, '9%', 'teal']];
    const bmax = Math.max(...bronnen.map(x => x[1]));
    const behaald = isSales ? 10713 : 26250;
    const target = isSales ? 15000 : 40000;
    const board = [['Joost', 3, 2, 67, 10713, 1071], ['Jeffrey', 4, 1, 25, 2000, 200]];
    const offs = OFFERTES.filter(o => o.status === 'verzonden' && (!isSales || o.verkoper === meName));

    const offsCard = dashCard('Openstaande offertes — op te volgen', 'slate',
      offs.length
        ? H.table(
            [{ l: 'Offerte' }, { l: 'Klant' }, { l: 'Traject', cls: 'optional' }, { l: 'Verzonden', cls: 'optional' }, { l: 'Bedrag', cls: 'r' }],
            offs.map(o => [
              `<span class="cell-main mono">${o.nr}</span>`,
              `<div class="row-avatar">${H.av(o.klant, 26)}<span>${o.klant}</span></div>`,
              o.traject,
              `<span style="color:var(--text-3)">${o.datum}</span>`,
              `<span class="money">${eur0(o.totaal)}</span>`,
            ])
          )
        : `<div style="padding:22px;text-align:center;color:var(--text-3);font-size:13px">Geen openstaande offertes — mooi opgeruimd 👍</div>`
    );

    const leaderboard = dashCard('Verkopers-leaderboard', 'amber',
      H.table(
        [{ l: 'Verkoper' }, { l: 'Off.', cls: 'r' }, { l: 'Getekend', cls: 'r' }, { l: 'Conversie', cls: 'r' }, { l: 'Omzet', cls: 'r' }, { l: 'Bonus', cls: 'r' }],
        board.map(([n, o, g, c, om, bo]) => [
          `<div class="row-avatar">${H.av(n, 26)}<span class="cell-main">${n}</span></div>`,
          `<span class="mono">${o}</span>`,
          `<span class="mono">${g}</span>`,
          H.pill(c >= 50 ? 'ok' : 'warn', c + '%'),
          `<span class="money">${eur0(om)}</span>`,
          `<span class="money">${eur0(bo)}</span>`,
        ])
      )
    );

    return `${H.voorbeeldBanner()}
    ${H.kpis(kpiArr)}
    <div class="pad" style="padding-top:16px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start">
        ${dashCard('Verkooptrechter' + (isSales ? ' — mijn deals' : ''), 'violet', funnel(fun))}
        ${dashCard('Omzet vs. target' + (isSales ? '' : ' · team'), 'emerald',
          targetGauge(behaald, target, 'emerald')
          + `<div style="display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:15px">
              <div style="border:1px solid var(--border);border-radius:var(--r);padding:11px 13px"><div style="font-size:11.5px;color:var(--text-2);margin-bottom:4px">Nog te gaan</div><div class="mono" style="font-size:17px;font-weight:600">${eur0(target - behaald)}</div></div>
              <div style="border:1px solid var(--border);border-radius:var(--r);padding:11px 13px"><div style="font-size:11.5px;color:var(--text-2);margin-bottom:4px">Dagen resterend</div><div class="mono" style="font-size:17px;font-weight:600">24</div></div></div>`)}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start;margin-top:14px">
        ${dashCard('Conversie per bron', 'blue', bronnen.map(([l, v, r, c]) => hbar(l, v, bmax, c, r)).join(''))}
        ${isSales ? offsCard : leaderboard}
      </div>
      ${isSales ? '' : `<div style="margin-top:14px">${offsCard}</div>`}
    </div>`;
  }

  /* ── VIEW: Sales/Offertes (prototype r2469-2490) ──────────────────── */
  function offertesView() {
    const st = F('st', 'all');
    const q = (F('q', '') || '').toLowerCase();
    const rows = OFFERTES.filter(o => (st === 'all' || o.status === st) && (!q || o.klant.toLowerCase().includes(q)));
    S.rows = rows;
    const cnt = (s) => OFFERTES.filter(o => s === 'all' || o.status === s).length;

    return `${H.voorbeeldBanner()}
    ${H.kpis([
      { c: 'blue',    icon: I.doc,   label: 'Open in pijplijn', val: eur0(9600),  sub: '2 verzonden offertes' },
      { c: 'emerald', icon: I.tick,  label: 'Geaccepteerd',     val: eur0(12713), hi: 1, sub: '3 deze maand', trend: H.trend('+40%', true) },
      { c: 'violet',  icon: I.chart, label: 'Conversie',        val: '64%',        sub: 'laatste 30 dagen',  trend: H.trend('+7%',  true) },
      { c: 'amber',   icon: I.clock, label: 'Doorlooptijd',     val: '4,2 d',      sub: 'verzonden → getekend', trend: H.trend('-1,1 d', true) },
    ])}
    ${H.toolbar([
      H.chips('st', [
        { l: 'Alles',        v: 'all',          n: cnt('all') },
        { l: 'Concept',      v: 'concept',      n: cnt('concept') },
        { l: 'Verzonden',    v: 'verzonden',    n: cnt('verzonden') },
        { l: 'Geaccepteerd', v: 'geaccepteerd', n: cnt('geaccepteerd') },
        { l: 'Afgewezen',    v: 'afgewezen',    n: cnt('afgewezen') },
      ], st),
      `<select class="filter-sel"><option>Alle verkopers</option><option>Joost</option><option>Jeffrey</option></select>`,
      H.search('Zoek klant of nummer…'),
      `<div class="tb-right"><button class="btn btn-primary" onclick="__salesNotice('Nieuwe offerte')">${svg(I.plus)}Nieuwe offerte</button></div>`,
    ])}
    ${H.table(
      [{ l: 'Offerte' }, { l: 'Klant' }, { l: 'Traject', cls: 'optional' }, { l: 'Verkoper', cls: 'optional' }, { l: 'Datum', cls: 'optional' }, { l: 'Bedrag', cls: 'r' }, { l: 'Status' }, { l: 'Abo', cls: 'c' }],
      rows.map((o) => [
        `<span class="cell-main mono" style="font-size:12.5px">${o.nr}</span>`,
        `<div class="row-avatar">${H.av(o.klant, 26)}<span class="cell-main">${o.klant}</span></div>`,
        `<span style="color:var(--text-2)">${o.traject}</span>`,
        o.verkoper,
        `<span class="mono" style="color:var(--text-3);font-size:12.5px">${o.datum}</span>`,
        `<span class="money">${eur(o.totaal)}</span>`,
        H.pill(OST[o.status].c, OST[o.status].l),
        o.abo
          ? `<span style="color:var(--emerald)">${svg(I.tick, 'width:17px;height:17px;stroke-width:2.8')}</span>`
          : `<span onclick="event.stopPropagation();__salesNotice('Abonnement-wizard voor ${o.klant.replace(/'/g, "\\'")}')" style="color:var(--rose);cursor:pointer">${svg(I.x, 'width:17px;height:17px;stroke-width:2.8')}</span>`,
      ]),
      '__salesOpenOfferte'
    )}`;
  }

  /* ── VIEW: Sales/Retentie (prototype r2491-2507) ──────────────────── */
  function retentieView() {
    const st = F('st', 'all');
    const rows = RETENTIE.filter(r => st === 'all' || r.status === st);
    S.rows = rows;
    const cnt = (s) => RETENTIE.filter(r => s === 'all' || r.status === s).length;

    return `${H.voorbeeldBanner()}
    ${H.kpis([
      { c: 'amber',   icon: I.clock, label: 'Loopt binnen 6 maanden af', val: '4',       hi: 1, sub: 'abonnementen' },
      { c: 'rose',    icon: I.euro,  label: 'MRR op het spel',           val: eur0(1396), hi: 1, sub: 'als niemand verlengt' },
      { c: 'emerald', icon: I.tick,  label: 'Verlengd dit kwartaal',     val: '7',       hi: 1, sub: 'van 11 benaderd', trend: H.trend('64%', true) },
      { c: 'violet',  icon: I.chat,  label: 'Nog niet benaderd',         val: String(cnt('nog niet benaderd')), sub: 'pak deze eerst op' },
    ])}
    ${H.toolbar([
      H.chips('st', [
        { l: 'Alles',             v: 'all',                n: cnt('all') },
        { l: 'Nog niet benaderd', v: 'nog niet benaderd',  n: cnt('nog niet benaderd') },
        { l: 'In gesprek',        v: 'in gesprek',         n: cnt('in gesprek') },
        { l: 'Verlengd',          v: 'verlengd',           n: cnt('verlengd') },
        { l: 'Wil stoppen',       v: 'wil stoppen',        n: cnt('wil stoppen') },
      ], st),
      `<select class="filter-sel"><option>Loopt af binnen 6 mnd</option><option>Binnen 3 maanden</option><option>Alles</option></select>`,
      H.search('Zoek klant…'),
    ])}
    ${H.table(
      [{ l: 'Klant' }, { l: 'Abonnement' }, { l: 'Einddatum', cls: 'optional' }, { l: 'Nog te gaan', cls: 'r' }, { l: 'MRR', cls: 'r' }, { l: 'Eigenaar', cls: 'optional' }, { l: 'Status' }],
      rows.map(r => [
        `<div class="row-avatar">${H.av(r.klant, 26)}<span class="cell-main">${r.klant}</span></div>`,
        r.plan,
        `<span class="mono" style="color:var(--text-3);font-size:12.5px">${r.eind}</span>`,
        `<span class="pill ${r.resterend <= 6 ? 'pill-warn' : 'pill-neutral'} nodot">${r.resterend} termijnen</span>`,
        `<span class="money">${eur(r.mrr)}</span>`,
        r.eigenaar,
        H.pill(RST[r.status].c, RST[r.status].l),
      ]),
      '__salesOpenRetentie'
    )}`;
  }

  /* ── VIEW: Sales/Verkoopprestaties (prototype r2508-2521) ─────────── */
  function prestatiesView() {
    return `${H.voorbeeldBanner()}
    ${H.kpis([
      { c: 'violet', icon: I.tick,  label: 'Getekend deze maand', val: eur0(12713),   sub: '3 offertes',    trend: H.trend('+40%', true) },
      { c: 'blue',   icon: I.chart, label: 'Beste maand 2026',    val: eur0(152000),  sub: 'mei' },
      { c: 'amber',  icon: I.euro,  label: 'Bonus openstaand',    val: eur0(1271),    hi: 1, sub: '2 medewerkers' },
    ])}
    <div class="pad" style="padding-top:16px">
      <div class="card">
        <div class="card-head"><span class="tile-ico" style="background:var(--violet-soft);color:var(--violet)">${svg(I.users)}</span>
          <div class="card-title">Per medewerker · augustus 2026</div></div>
        ${H.table(
          [{ l: 'Medewerker' }, { l: 'Offertes', cls: 'r' }, { l: 'Getekend', cls: 'r' }, { l: 'Conversie', cls: 'r' }, { l: 'Omzet', cls: 'r' }, { l: 'Bonus', cls: 'r' }],
          [['Joost Berg',      3, 2, '67%', 10713, 1071, 'ok'],
           ['Jeffrey Biemold', 4, 1, '25%',  2000,  200, 'warn']]
            .map(([n, o, g, c, om, b, cl]) => [
              `<div class="row-avatar">${H.av(n, 28)}<span class="cell-main">${n.split(' ')[0]}</span></div>`,
              `<span class="mono">${o}</span>`,
              `<span class="mono">${g}</span>`,
              `<span class="pill pill-${cl} nodot">${c}</span>`,
              `<span class="money">${eur0(om)}</span>`,
              `<span class="money">${eur0(b)}</span>`,
            ])
        )}
      </div>
    </div>`;
  }

  /* ── Registratie ───────────────────────────────────────────────────── */
  window.DFO.VIEWS['sales/Dashboard']        = salesDashboardView;
  window.DFO.VIEWS['sales/Offertes']         = offertesView;
  window.DFO.VIEWS['sales/Retentie']         = retentieView;
  window.DFO.VIEWS['sales/Verkoopprestaties'] = prestatiesView;
  if (typeof window.KV_V2_ADD === 'function') {
    window.KV_V2_ADD('sales');
  } else {
    (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('sales');
  }

  console.debug('[sales-v2] registered 4 Sales views (dormant tot allowlist of ?v2preview=sales)');
})();
