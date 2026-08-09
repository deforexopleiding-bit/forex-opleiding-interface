// modules/klanten-v2/views/finance-v2.js
//
// Fase C module #2 — Finance-module layout voor v2-shell (layout-only, voorbeeld-data).
// 1-op-1 render uit docs/redesign/systeemprototype-v45.html:
//   - dashFinanceModule                      r2269-2334  (rolspecifiek: sales-scope vs full finance)
//   - VIEWS['finance/Dashboard']             r2335       (= dashFinanceModule)
//   - VIEWS['finance/Facturen']              r2336-2365
//   - VIEWS['finance/Abonnementen']          r2366-2381
//   - VIEWS['finance/Omzet & MRR']           r2382-2394
//   - VIEWS['finance/Bank']                  r2395-2408
//   - VIEWS["finance/Creditnota's"]          r2409-2418
//   - FACTUREN + ST + ABOS                   r1301-1320
//   - TRAJECTEN                              r1363-1369
//   - OFFERTES + OST (voor sales-scope)      r1321-1329
//   - hbar / funnel / dashCard / areaChart   r1441-1463 (inline; finance-specifiek)
//
// NIET wanbetalers — dat is een aparte gevoelige module, later.
//
// Registreert 6 views + KV_V2_ADD('finance') — dormant. Preview via
// ?v2preview=finance.

(function () {
  if (!window.DFO) { console.error('[finance-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[finance-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, S, F, eur, eur0 } = window.DFO;
  const H = window.KV_V2.helpers;

  /* ── Voorbeeld-data (prototype r1301-1369) ────────────────────────── */
  const FACTUREN = [
    { nr: '2026/1447', klant: 'Ebenezer Adjei',       bedrag: 7199.99, open: 7199.99, datum: '12-06-2026', verval: '26-06-2026', dagen:  40, status: 'overdue',     entity: 'DFO'    },
    { nr: '2026/1502', klant: 'Dyami Van Praag',      bedrag: 3675,    open: 3675,    datum: '01-04-2026', verval: '15-04-2026', dagen: 129, status: 'overdue',     entity: 'DFO'    },
    { nr: '2026/1388', klant: 'NazNaz Transport',     bedrag: 3000,    open: 2500,    datum: '10-03-2026', verval: '24-03-2026', dagen: 149, status: 'overdue',     entity: 'DFO'    },
    { nr: '2026/1610', klant: 'Chamano BV',           bedrag: 7200,    open: 0,       datum: '01-08-2026', verval: '15-08-2026', dagen:   0, status: 'paid',        entity: 'DFO BE' },
    { nr: '2026/1591', klant: 'Jennifer Botaka',      bedrag: 2000,    open: 2000,    datum: '09-03-2026', verval: '23-03-2026', dagen: 148, status: 'overdue',     entity: 'DFO'    },
    { nr: '2026/1622', klant: 'Michiel Van Brenk',    bedrag: 1200,    open:  800,    datum: '12-06-2026', verval: '26-06-2026', dagen:  54, status: 'partial',     entity: 'DFO'    },
    { nr: '2026/1633', klant: 'ER Schilderwerken',    bedrag: 3950,    open: 3950,    datum: '04-08-2026', verval: '18-08-2026', dagen:   0, status: 'open',        entity: 'DFO BE' },
    { nr: '2026/1520', klant: 'Ingrid Van Den Eede',  bedrag: 1400,    open:  750,    datum: '13-03-2026', verval: '27-03-2026', dagen: 145, status: 'arrangement', entity: 'DFO BE' },
  ];
  const ST = {
    overdue:     { l: 'Te laat',  c: 'danger'  },
    open:        { l: 'Open',     c: 'neutral' },
    paid:        { l: 'Betaald',  c: 'ok'      },
    partial:     { l: 'Deels',    c: 'warn'    },
    arrangement: { l: 'Regeling', c: 'accent'  },
  };
  const ABOS = [
    { klant: 'Cabdi Ibrahim',     plan: '12 maand 1-op-1',     mrr: 600, start: '01-08-2026', termijn: '1/12', status: 'actief' },
    { klant: 'Stéphane Seutin',   plan: '12 maand 1-op-1',     mrr: 600, start: '03-08-2026', termijn: '1/12', status: 'actief' },
    { klant: 'Emile Rabaut',      plan: '6 maand 1-op-1',      mrr: 658, start: '04-08-2026', termijn: '1/6',  status: 'actief' },
    { klant: 'Nikita Bykov',      plan: '36 maand membership', mrr:  65, start: '24-07-2026', termijn: '1/36', status: 'actief' },
    { klant: 'Jan Willem Bel',    plan: '12 maand 1-op-1',     mrr: 600, start: '12-05-2026', termijn: '4/12', status: 'actief' },
    { klant: 'Valentine Manisha', plan: '12 maand membership', mrr:  80, start: '02-02-2026', termijn: '7/12', status: 'achterstand' },
    { klant: 'Karim Alian',       plan: '6 maand 1-op-1',      mrr: 658, start: '10-07-2026', termijn: '1/6',  status: 'gepauzeerd' },
  ];
  const TRAJECTEN = [
    { naam: '1-op-1 begeleiding', duur: '6 maanden',  prijs: 3950, termijnen:  6, actief: 156 },
    { naam: '1-op-1 begeleiding', duur: '12 maanden', prijs: 7200, termijnen: 12, actief: 216 },
    { naam: '1-op-1 begeleiding', duur: '24 maanden', prijs: 12000, termijnen: 24, actief:   8 },
    { naam: 'Membership',         duur: '12 maanden', prijs:  960, termijnen: 12, actief: 150 },
    { naam: 'Membership',         duur: '36 maanden', prijs: 2340, termijnen: 36, actief:  89 },
  ];
  // Klein subset OFFERTES voor sales-scope dashboard-render.
  const OFFERTES = [
    { nr: 'OFF-2026-214', klant: 'Cabdi Ibrahim',   totaal: 7200, status: 'geaccepteerd', datum: '01-08-2026', verkoper: 'Joost',   traject: '12 maand 1-op-1' },
    { nr: 'OFF-2026-221', klant: 'Emile Rabaut',    totaal: 3950, status: 'geaccepteerd', datum: '04-08-2026', verkoper: 'Joost',   traject: '6 maand 1-op-1'  },
    { nr: 'OFF-2026-208', klant: 'Iwan Engelbracht', totaal: 2400, status: 'verzonden',    datum: '29-07-2026', verkoper: 'Joost',   traject: '36 maand membership' },
    { nr: 'OFF-2026-219', klant: 'Stéphane Seutin', totaal: 7200, status: 'verzonden',    datum: '03-08-2026', verkoper: 'Jeffrey', traject: '12 maand 1-op-1' },
  ];
  const OST = {
    concept:      { l: 'Concept',      c: 'neutral' },
    verzonden:    { l: 'Verzonden',    c: 'accent'  },
    geaccepteerd: { l: 'Geaccepteerd', c: 'ok'      },
    afgewezen:    { l: 'Afgewezen',    c: 'danger'  },
  };

  /* ── Dashboard-componenten (prototype r1441-1463) ─────────────────── */
  const hbar = (label, val, max, color, right) => `<div style="display:flex;align-items:center;gap:12px;margin-bottom:11px">
    <div style="width:118px;font-size:12.5px;color:var(--text-2);flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${label}</div>
    <div class="progress" style="flex:1;height:8px"><i style="width:${max ? Math.round(val / max * 100) : 0}%;background:var(--${color})"></i></div>
    <div style="width:82px;text-align:right;font-size:12.5px;font-weight:600;font-family:'IBM Plex Mono',monospace">${right}</div></div>`;

  const dashCard = (title, dotColor, body, extra) => `<div class="card">
    <div class="card-head" style="border-bottom:none;padding-bottom:6px">
      <span class="title-dot" style="background:var(--${dotColor});box-shadow:0 0 0 3px var(--${dotColor}-soft)"></span>
      <div class="card-title">${title}</div>${extra || ''}</div>
    <div class="card-body" style="padding:8px 17px 17px">${body}</div></div>`;

  // Simpele area-chart (statisch, matches dashboard-v2 style visueel voldoende).
  function areaChart(data, labels) {
    const w = 100, h = 42, mx = Math.max(...data, 1);
    const pts = data.map((v, i) => [i / (data.length - 1) * w, h - (v / mx) * h * .88 - 2]);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:64px;display:block">
      <defs><linearGradient id="fin-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--m)" stop-opacity=".22"/><stop offset="100%" stop-color="var(--m)" stop-opacity="0"/>
      </linearGradient></defs>
      <path fill="url(#fin-grad)" d="${line} L${w},${h} L0,${h} Z"/>
      <path fill="none" stroke="var(--m)" stroke-width="1.5" vector-effect="non-scaling-stroke" d="${line}"/>
    </svg><div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-3);margin-top:4px">${labels.map(l => `<span>${l}</span>`).join('')}</div>`;
  }

  /* ── Notice-handlers voor dode action-knoppen ─────────────────────── */
  window.__finNotice = (label) => {
    console.info('[finance-v2] ' + label + ' (voorbeeld — modal/flow komt in data-ronde)');
    try { alert(label + ' — komt in de data-ronde.'); } catch (_) { /* ignore */ }
  };
  window.__finOpenFactuur = (i) => { console.info('[finance-v2] openFactuur idx=' + i + ' (voorbeeld — panel komt in data-ronde)'); };
  window.__finOpenAbo = (i) => { console.info('[finance-v2] openAbo idx=' + i + ' (voorbeeld — panel komt in data-ronde)'); };
  window.__finToggleSel = (nr) => { S.sel = S.sel || {}; S.sel[nr] = !S.sel[nr]; window.DFO.render(); };

  /* ── Helper: me() proxy voor sales-scope render ───────────────────── */
  function meName() {
    // Sales-scope dashboard filtert OFFERTES op verkoper===me(). Voor mock
    // gebruiken we simpel de eerste rol-persona. Klopt niet altijd 1-op-1
    // met echte user maar voldoet voor layout-review.
    try { return (window.DFO.ROLES?.[S.role]?.persoon || '').split(' ')[0] || 'Jeffrey'; }
    catch (_) { return 'Jeffrey'; }
  }

  /* ── VIEW 1: Finance/Dashboard (prototype r2269-2335) ─────────────── */
  function financeDashboardView() {
    const isSales = S.role === 'sales';

    if (isSales) {
      const myOffs = OFFERTES.filter(o => o.verkoper === meName());
      const getekend = myOffs.filter(o => o.status === 'geaccepteerd');
      const omzet = getekend.reduce((a, o) => a + o.totaal, 0);
      const perTraject = {};
      getekend.forEach(o => { perTraject[o.traject] = (perTraject[o.traject] || 0) + o.totaal; });
      const tmax = Math.max(1, ...Object.values(perTraject));
      const tcol = ['violet', 'blue', 'teal', 'amber'];
      const mijnKlanten = [
        ['Cabdi Ibrahim',        '12 maand 1-op-1',       0,    'paid'],
        ['ER Schilderwerken',    '6 maand 1-op-1',        3950, 'open'],
        ['Iwan Engelbracht',     '36 maand membership',   2400, 'offerte'],
      ];
      return `${H.voorbeeldBanner()}
      ${H.kpis([
        { c: 'violet',  icon: I.tick,  label: 'Omzet uit mijn deals',   val: eur0(omzet), sub: getekend.length + ' getekend', trend: H.trend('+40%', true) },
        { c: 'rose',    icon: I.euro,  label: 'Openstaand mijn klanten', val: eur0(3950),  sub: '1 factuur open' },
        { c: 'emerald', icon: I.users, label: 'Mijn actieve klanten',   val: '2',          sub: 'lopende abonnementen' },
        { c: 'amber',   icon: I.euro,  label: 'Mijn provisie',          val: eur0(1071),  sub: 'openstaand deze maand' },
      ])}
      <div class="pad" style="padding-top:16px">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start">
          ${dashCard('Mijn getekende deals', 'emerald',
            H.table([{ l: 'Klant' }, { l: 'Traject', cls: 'optional' }, { l: 'Bedrag', cls: 'r' }, { l: 'Status' }],
              myOffs.map(o => [
                `<div class="row-avatar">${H.av(o.klant, 26)}<span>${o.klant}</span></div>`,
                o.traject,
                `<span class="money">${eur0(o.totaal)}</span>`,
                H.pill(OST[o.status].c, OST[o.status].l),
              ])
            ))}
          ${dashCard('Betaalstatus bij mijn klanten', 'blue',
            mijnKlanten.map(([n, tr, open, st]) => `<div style="display:flex;align-items:center;gap:11px;padding:10px 12px;border:1px solid var(--border);border-radius:var(--r);margin-bottom:8px">
              ${H.av(n, 28)}<div style="flex:1;min-width:0"><div class="cell-main">${n}</div><div class="cell-sub">${tr}</div></div>
              ${open > 0 ? `<span class="money" style="color:var(--rose)">${eur0(open)}</span>` : ''}
              ${H.pill(st === 'paid' ? 'ok' : st === 'open' ? 'warn' : 'neutral', st === 'paid' ? 'Betaald' : st === 'open' ? 'Openstaand' : 'Offerte')}</div>`).join(''))}
        </div>
        <div style="margin-top:14px">${dashCard('Mijn omzet per traject', 'violet',
          Object.entries(perTraject).map(([t, v], i) => hbar(t, v, tmax, tcol[i % 4], eur0(v))).join('')
          || `<div style="padding:16px;color:var(--text-3);font-size:13px">Nog geen getekende deals deze periode.</div>`)}</div>
      </div>`;
    }

    /* Volledige finance (super_admin/manager) */
    const openF = FACTUREN.filter(f => f.open > 0);
    const buckets = [['0–30 dagen', 0, 'emerald'], ['30–60 dagen', 0, 'amber'], ['60–90 dagen', 0, 'blue'], ['90+ dagen', 0, 'rose']];
    openF.forEach(f => { const i = f.dagen <= 30 ? 0 : f.dagen <= 60 ? 1 : f.dagen <= 90 ? 2 : 3; buckets[i][1] += f.open; });
    const amax = Math.max(1, ...buckets.map(b => b[1]));
    const openTot = buckets.reduce((a, b) => a + b[1], 0);
    const statusAgg = {};
    FACTUREN.forEach(f => { const v = f.status === 'paid' ? f.bedrag : f.open; statusAgg[f.status] = (statusAgg[f.status] || 0) + v; });
    const smax = Math.max(1, ...Object.values(statusAgg));
    const tmax = Math.max(...TRAJECTEN.map(t => t.actief));
    const tcol = ['violet', 'blue', 'teal', 'pink', 'amber'];

    return `${H.voorbeeldBanner()}
    ${H.kpis([
      { c: 'blue',    icon: I.euro,  label: 'MRR',                val: eur0(47612),  sub: '86 actieve abonnementen', trend: H.trend('+4,2%', true) },
      { c: 'rose',    icon: I.euro,  label: 'Openstaand',         val: eur0(openTot), sub: openF.length + ' facturen' },
      { c: 'emerald', icon: I.tick,  label: 'Omzet deze maand',   val: eur0(26250),  sub: 'incl. btw',              trend: H.trend('+18%', true) },
      { c: 'amber',   icon: I.clock, label: 'Gem. betaaltermijn', val: '34 d',        sub: 'DSO — target 30 d' },
    ])}
    <div class="pad" style="padding-top:16px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start">
        ${dashCard('MRR-ontwikkeling', 'blue',
          areaChart([41200, 42800, 43900, 44600, 45800, 46400, 47100, 47612], ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug'])
          + `<div style="display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:14px">
              <div style="border:1px solid var(--border);border-radius:var(--r);padding:11px 13px"><div style="font-size:11.5px;color:var(--text-2);margin-bottom:4px">Nieuwe MRR</div><div class="mono" style="font-size:16px;font-weight:600;color:var(--emerald)">+ ${eur0(1858)}</div></div>
              <div style="border:1px solid var(--border);border-radius:var(--r);padding:11px 13px"><div style="font-size:11.5px;color:var(--text-2);margin-bottom:4px">Churn</div><div class="mono" style="font-size:16px;font-weight:600;color:var(--rose)">− ${eur0(738)}</div></div></div>`)}
        ${dashCard('Cashflow deze maand', 'emerald',
          `<div style="display:flex;flex-direction:column;gap:10px">
            ${[['Inkomsten', 38400, 'emerald', '+'], ['Uitgaven', 19900, 'rose', '−'], ['Netto', 18500, 'blue', '']].map(([l, v, c, pre]) => `
              <div style="display:flex;align-items:center;justify-content:space-between;padding:13px 15px;border:1px solid var(--border);border-radius:var(--r);${l === 'Netto' ? 'background:var(--surface-2)' : ''}">
                <span style="font-size:13px;font-weight:${l === 'Netto' ? '600' : '500'}">${l}</span>
                <span class="mono" style="font-size:18px;font-weight:600;color:var(--${c})">${pre} ${eur0(v)}</span></div>`).join('')}</div>`)}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start;margin-top:14px">
        ${dashCard('Openstaand — ouderdomsanalyse', 'rose',
          buckets.map(([l, v, c]) => hbar(l, v, amax, c, eur0(v))).join('')
          + `<div style="margin-top:6px;padding-top:11px;border-top:1px solid var(--border);display:flex;justify-content:space-between;font-size:12.5px"><span style="color:var(--text-2)">Totaal openstaand</span><b class="mono">${eur0(openTot)}</b></div>`)}
        ${dashCard('Betaalstatus (naar bedrag)', 'blue',
          Object.entries(statusAgg).sort((a, b) => b[1] - a[1]).map(([s, v]) => {
            const c = ST[s].c === 'ok' ? 'emerald' : ST[s].c === 'danger' ? 'rose' : ST[s].c === 'warn' ? 'amber' : ST[s].c === 'accent' ? 'blue' : 'slate';
            return hbar(ST[s].l, v, smax, c, eur0(v));
          }).join(''))}
      </div>
      <div style="margin-top:14px">${dashCard('Actieve trajecten', 'violet',
        TRAJECTEN.map((t, i) => hbar(t.naam + ' · ' + t.duur, t.actief, tmax, tcol[i % 5], t.actief + ' actief')).join(''))}</div>
    </div>`;
  }

  /* ── VIEW 2: Finance/Facturen (prototype r2336-2365) ──────────────── */
  function facturenView() {
    const st = F('st', 'all');
    const q = (F('q', '') || '').toLowerCase();
    const rows = FACTUREN.filter(f => (st === 'all' || f.status === st) && (!q || f.klant.toLowerCase().includes(q) || f.nr.includes(q)));
    S.rows = rows;
    const cnt = (s) => FACTUREN.filter(f => s === 'all' || f.status === s).length;
    S.sel = S.sel || {};
    const n = Object.keys(S.sel).filter(k => S.sel[k]).length;

    return `${H.voorbeeldBanner()}
    ${H.kpis([
      { c: 'blue',    icon: I.euro,  label: 'Totaal openstaand', val: eur0(21938), sub: '13 facturen',       trend: H.trend('+12%', false) },
      { c: 'rose',    icon: I.alert, label: 'Te laat',           val: eur0(15374), hi: 1, sub: 'oudste 149 dagen' },
      { c: 'amber',   icon: I.clock, label: 'Deels betaald',     val: eur0(1550),  hi: 1, sub: '2 facturen' },
      { c: 'emerald', icon: I.tick,  label: 'Binnen deze maand', val: eur0(8200),  hi: 1, sub: '3 betalingen', trend: H.trend('+34%', true) },
    ])}
    ${H.toolbar([
      H.chips('st', [
        { l: 'Alles',    v: 'all',         n: cnt('all') },
        { l: 'Te laat',  v: 'overdue',     n: cnt('overdue') },
        { l: 'Open',     v: 'open',        n: cnt('open') },
        { l: 'Deels',    v: 'partial',     n: cnt('partial') },
        { l: 'Regeling', v: 'arrangement', n: cnt('arrangement') },
        { l: 'Betaald',  v: 'paid',        n: cnt('paid') },
      ], st),
      `<select class="filter-sel"><option>Alle entiteiten</option><option>DFO</option><option>DFO BE</option></select>`,
      H.search('Zoek klant of nummer…'),
      `<div class="tb-right"><button class="btn btn-ghost" onclick="__finNotice('Export')">${svg(I.down)}Export</button><button class="btn btn-primary" onclick="__finNotice('Nieuwe factuur')">${svg(I.plus)}Nieuwe factuur</button></div>`,
    ])}
    ${H.table(
      [{ l: '' }, { l: 'Factuur' }, { l: 'Klant' }, { l: 'Datum', cls: 'optional' }, { l: 'Verval', cls: 'optional' }, { l: 'Bedrag', cls: 'r' }, { l: 'Open', cls: 'r' }, { l: 'Status' }, { l: 'Dagen', cls: 'r optional' }],
      rows.map((f) => [
        `<div class="checkbox ${S.sel[f.nr] ? 'on' : ''}" onclick="event.stopPropagation();__finToggleSel('${f.nr}')">${svg(I.tick)}</div>`,
        `<div><div class="cell-main mono">${f.nr}</div><div class="cell-sub">${f.entity}</div></div>`,
        `<div class="row-avatar">${H.av(f.klant, 26)}<span class="cell-main">${f.klant}</span></div>`,
        `<span class="mono" style="color:var(--text-3);font-size:12.5px">${f.datum}</span>`,
        `<span class="mono" style="color:var(--text-3);font-size:12.5px">${f.verval}</span>`,
        `<span class="money">${eur(f.bedrag)}</span>`,
        `<span class="money" style="${f.open > 0 ? '' : 'color:var(--text-3)'}">${f.open > 0 ? eur(f.open) : '—'}</span>`,
        H.pill(ST[f.status].c, ST[f.status].l),
        `<span class="mono" style="font-size:12.5px;color:${f.dagen > 60 ? 'var(--rose)' : 'var(--text-3)'}">${f.dagen > 0 ? f.dagen + ' d' : '—'}</span>`,
      ]),
      '__finOpenFactuur'
    )}
    ${n ? `<div class="bulkbar"><b>${n} geselecteerd</b>
      <button class="btn btn-ghost btn-sm" onclick="__finNotice('Herinnering sturen (bulk)')">Herinnering sturen</button>
      <button class="btn btn-ghost btn-sm" onclick="__finNotice('Markeer betaald (bulk)')">Markeer betaald</button>
      <button class="btn btn-ghost btn-sm" onclick="__finNotice('Export (bulk)')">Export</button>
      <button class="btn btn-ghost btn-sm" style="margin-left:auto" onclick="S.sel={};DFO.render()">Wissen</button></div>` : ''}`;
  }

  /* ── VIEW 3: Finance/Abonnementen (prototype r2366-2381) ──────────── */
  function abonnementenView() {
    const st = F('st', 'all');
    const rows = ABOS.filter(a => st === 'all' || a.status === st);
    S.rows = rows;

    return `${H.voorbeeldBanner()}
    ${H.kpis([
      { c: 'violet',  icon: I.repeat, label: 'MRR',              val: eur0(3306),         sub: '6 actief', trend: H.trend('+128%', true) },
      { c: 'emerald', icon: I.plus,   label: 'Nieuw deze maand', val: '+ ' + eur0(1858), hi: 1, sub: '3 abonnementen' },
      { c: 'amber',   icon: I.alert,  label: 'Achterstand',      val: '1',                hi: 1, sub: 'Valentine Manisha' },
      { c: 'blue',    icon: I.clock,  label: 'Gepauzeerd',       val: '1',                sub: 'Karim Alian' },
    ])}
    ${H.toolbar([
      H.chips('st', [
        { l: 'Alles',       v: 'all' },
        { l: 'Actief',      v: 'actief' },
        { l: 'Achterstand', v: 'achterstand' },
        { l: 'Gepauzeerd',  v: 'gepauzeerd' },
      ], st),
      H.search('Zoek klant…'),
      `<div class="tb-right"><button class="btn btn-primary" onclick="__finNotice('Nieuw abonnement')">${svg(I.plus)}Nieuw abonnement</button></div>`,
    ])}
    ${H.table(
      [{ l: 'Klant' }, { l: 'Plan' }, { l: 'Start', cls: 'optional' }, { l: 'Termijn' }, { l: 'Per maand', cls: 'r' }, { l: 'Status' }],
      rows.map(a => [
        `<div class="row-avatar">${H.av(a.klant, 26)}<span class="cell-main">${a.klant}</span></div>`,
        a.plan,
        `<span class="mono" style="color:var(--text-3);font-size:12.5px">${a.start}</span>`,
        `<span class="mono" style="font-size:12.5px">${a.termijn}</span>`,
        `<span class="money">${eur(a.mrr)}</span>`,
        H.pill(a.status === 'actief' ? 'ok' : a.status === 'achterstand' ? 'warn' : 'neutral', a.status[0].toUpperCase() + a.status.slice(1)),
      ]),
      '__finOpenAbo'
    )}`;
  }

  /* ── VIEW 4: Finance/Omzet & MRR (prototype r2382-2394) ───────────── */
  function omzetView() {
    return `${H.voorbeeldBanner()}
    ${H.kpis([
      { c: 'violet',  icon: I.repeat, label: 'MRR nu',          val: eur0(3306),   sub: 'terugkerend per maand',   trend: H.trend('+€1.858', true) },
      { c: 'blue',    icon: I.euro,   label: 'Omzet dit jaar',  val: eur0(879456), sub: '181 getekende offertes',  trend: H.trend('+22%', true) },
      { c: 'emerald', icon: I.chart,  label: 'Gemiddelde deal', val: eur0(4857),   sub: 'over 2026',               trend: H.trend('+8%', true) },
    ])}
    <div class="pad" style="padding-top:16px">
      <div class="card">
        <div class="card-head"><span class="tile-ico" style="background:var(--blue-soft);color:var(--blue)">${svg(I.tag)}</span>
          <div class="card-title">Verkocht dit jaar</div><span class="pill pill-neutral nodot" style="margin-left:auto">619 trajecten</span></div>
        <div class="card-list">
          ${[
            ['12 maand 1-op-1',      216, 1096375, 'violet'],
            ['6 maand 1-op-1',       156,  458124, 'violet'],
            ['12 maand membership',  150,  206755, 'blue'],
            ['36 maand membership',   89,  211930, 'blue'],
            ['24 maand 1-op-1',        8,   78080, 'violet'],
          ].map(([n, c, b, col]) => `<div class="cl-row"><span class="legend-dot" style="background:var(--${col});width:10px;height:10px"></span>
            <div style="flex:1"><div class="cell-main">${n}</div><div class="cell-sub">${c} verkocht</div></div>
            <span class="money">${eur0(b)}</span></div>`).join('')}
        </div>
      </div>
    </div>`;
  }

  /* ── VIEW 5: Finance/Bank (prototype r2395-2408) ──────────────────── */
  function bankView() {
    return `${H.voorbeeldBanner()}
    ${H.kpis([
      { c: 'blue',    icon: I.bank || I.euro, label: 'Saldo',                 val: eur0(48210), sub: 'bijgewerkt 09:12' },
      { c: 'amber',   icon: I.alert,           label: 'Niet gematcht',         val: '7',          hi: 1, sub: 'transacties' },
      { c: 'emerald', icon: I.tick,            label: 'Automatisch gematcht',  val: '92%',        hi: 1, sub: 'deze maand', trend: H.trend('+5%', true) },
    ])}
    ${H.toolbar([
      H.chips('v', [{ l: 'Transacties', v: 't' }, { l: 'Matches', v: 'm' }], F('v', 't')),
      H.search('Zoek transactie…'),
    ])}
    ${H.table(
      [{ l: 'Datum' }, { l: 'Tegenpartij' }, { l: 'Omschrijving', cls: 'optional' }, { l: 'Bedrag', cls: 'r' }, { l: 'Gematcht' }],
      [
        ['05-08', 'Chamano BV',        'Factuur 2026/1610', 7200, 'ja'],
        ['04-08', 'Michiel Van Brenk', 'Deelbetaling',       400, 'ja'],
        ['04-08', 'Mollie',            'Uitbetaling week 31', 2840, 'nee'],
        ['03-08', 'Vodafone Zakelijk', 'Maandnota',         -189, 'ja'],
        ['02-08', 'Christa Noltus',    '2026/0921',          600, 'ja'],
      ].map(([d, p, o, b, m]) => [
        `<span class="mono" style="color:var(--text-3)">${d}</span>`,
        `<span class="cell-main">${p}</span>`,
        `<span style="color:var(--text-3);font-size:12.5px">${o}</span>`,
        `<span class="money" style="color:${b > 0 ? 'var(--emerald)' : 'var(--text-2)'}">${b > 0 ? '+ ' : ''}${eur(Math.abs(b))}</span>`,
        H.pill(m === 'ja' ? 'ok' : 'warn', m === 'ja' ? 'Gematcht' : 'Open'),
      ])
    )}`;
  }

  /* ── VIEW 6: Finance/Creditnota's (prototype r2409-2418) ──────────── */
  function creditnotasView() {
    return `${H.voorbeeldBanner()}
    ${H.toolbar([H.search('Zoek creditnota…')])}
    ${H.table(
      [{ l: 'Nummer' }, { l: 'Klant' }, { l: 'Verrekend met', cls: 'optional' }, { l: 'Datum', cls: 'optional' }, { l: 'Bedrag', cls: 'r' }],
      [
        ['CN-2026-018', 'Ingrid Van Den Eede', '2026/1520', '13-07-2026',  650],
        ['CN-2026-017', 'Michiel Van Brenk',   '2026/1622', '28-06-2026',  400],
        ['CN-2026-016', 'Mari Israiljan',      '2026/1490', '12-06-2026', 1200],
      ].map(([n, k, v, d, b]) => [
        `<span class="cell-main mono">${n}</span>`,
        `<div class="row-avatar">${H.av(k, 26)}<span>${k}</span></div>`,
        `<span class="mono" style="color:var(--text-3);font-size:12.5px">${v}</span>`,
        `<span class="mono" style="color:var(--text-3);font-size:12.5px">${d}</span>`,
        `<span class="money">${eur(b)}</span>`,
      ])
    )}`;
  }

  /* ── Registratie ───────────────────────────────────────────────────── */
  window.DFO.VIEWS['finance/Dashboard']     = financeDashboardView;
  window.DFO.VIEWS['finance/Facturen']      = facturenView;
  window.DFO.VIEWS['finance/Abonnementen']  = abonnementenView;
  window.DFO.VIEWS['finance/Omzet & MRR']   = omzetView;
  window.DFO.VIEWS['finance/Bank']          = bankView;
  window.DFO.VIEWS["finance/Creditnota's"]  = creditnotasView;
  if (typeof window.KV_V2_ADD === 'function') {
    window.KV_V2_ADD('finance');
  } else {
    (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('finance');
  }

  console.debug('[finance-v2] registered 6 Finance views (dormant tot allowlist of ?v2preview=finance)');
})();
