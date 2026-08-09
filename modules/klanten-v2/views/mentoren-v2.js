// modules/klanten-v2/views/mentoren-v2.js
//
// Fase D module — Mentoren-beheer (layout-only, voorbeeld-data).
// 1-op-1 render uit prototype:
//   - MENTOREN mock                          r1404-1409
//   - VIEWS['mentoren/Overzicht']            r5207-5230 (tabel met reiskosten-switch)
//   - VIEWS['mentoren/Grootboek']            r5258       (= alias van events/Mentor-grootboek)
//   - VIEWS['mentoren/Uitbetalingen']        r5287-5305 (4 sub-tabs: Rapporten/Declaraties/Handmatig/Tarieven)
//   - VIEWS['mentoren/Beoordelingen']        r5474-5493
//   - VIEWS['mentoren/Certificaten']         r2046-2062
//   - VIEWS['mentoren/Signalen']             r5494-5513
//
// Bewuste vereenvoudigingen (in PR-body vermeld):
//   - Uitbetalingen sub-tabs (Declaraties/Handmatige posten/Tarieven) hebben
//     placeholder-tabellen met notitie; volledige tabel-content ingebouwd
//     bij Rapporten.
//   - Grootboek toont per-event + per-mentor tabellen (uit prototype r4710).
//
// Dormant — 'mentoren' niet in V2_ACTIVE_ALLOWLIST. Preview ?v2preview=mentoren.

(function () {
  if (!window.DFO) { console.error('[mentoren-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[mentoren-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, S, F, eur, eur0, render } = window.DFO;
  const H = window.KV_V2.helpers;

  const MENTOREN = [
    { naam: 'Dave Klaassen', leerlingen: 24, sessies: 18, beschikbaar: 'ma-do', vergoeding: 2400, status: 'actief',   reiskosten: true,  dagbedrag: 18 },
    { naam: 'Mike de Vries', leerlingen: 19, sessies: 14, beschikbaar: 'di-vr', vergoeding: 1900, status: 'actief',   reiskosten: true,  dagbedrag: 22 },
    { naam: 'Sarah Bosman',  leerlingen: 11, sessies:  9, beschikbaar: 'wo-vr', vergoeding: 1100, status: 'actief',   reiskosten: false, dagbedrag: 15 },
    { naam: 'Tim Jacobs',    leerlingen:  0, sessies:  0, beschikbaar: '—',    vergoeding:    0, status: 'inactief', reiskosten: false, dagbedrag:  0 },
  ];
  const UITB = [
    { n: 'Dave Klaassen', ev: 4, bonus: 2480, ses: 21, coach: 1260, reis: 180, corr:   0, btw: false, st: 'uitbetaald',  fact: 'DFO-2026-081' },
    { n: 'Mike de Vries', ev: 3, bonus: 1720, ses: 18, coach: 1090, reis: 120, corr: -60, btw: false, st: 'goedgekeurd', fact: 'DFO-2026-082' },
    { n: 'Sarah Bosman',  ev: 1, bonus:  760, ses:  9, coach:  520, reis:   0, corr:   0, btw: true,  st: 'concept',     fact: null },
  ];
  const UST = { concept: { l: 'Concept', c: 'neutral' }, goedgekeurd: { l: 'Goedgekeurd', c: 'accent' }, uitbetaald: { l: 'Uitbetaald', c: 'ok' } };
  const utot = (u) => u.bonus + u.coach + u.reis + u.corr;
  const CERTIFICATEN = [
    { mentor: 'Dave Klaassen', naam: 'Advanced Technical Analysis',    uitgever: 'IFTA',                datum: '02-08-2026', status: 'goedgekeurd' },
    { mentor: 'Dave Klaassen', naam: 'Risk Management Professional',   uitgever: 'CISI',                datum: '12-07-2026', status: 'goedgekeurd' },
    { mentor: 'Mike de Vries', naam: 'Certified Financial Technician', uitgever: 'IFTA',                datum: '28-07-2026', status: 'ingediend' },
    { mentor: 'Sarah Bosman',  naam: 'Trading Psychology Certificate', uitgever: 'Van Tharp Institute', datum: '20-07-2026', status: 'goedgekeurd' },
  ];
  const CERTST = { ingediend: { l: 'In beoordeling', c: 'warn' }, goedgekeurd: { l: 'Goedgekeurd', c: 'ok' }, afgewezen: { l: 'Afgewezen', c: 'danger' } };
  const GRADICO = `<span style="width:26px;height:26px;border-radius:7px;background:var(--violet-soft);color:var(--violet);display:grid;place-items:center;flex-shrink:0">${svg(I.grad, 'width:14px;height:14px')}</span>`;

  let uSub = 'Rapporten'; // sub-tab in Uitbetalingen

  window.__mentNotice = (label) => {
    console.info('[mentoren-v2] ' + label + ' (voorbeeld — komt in data-ronde)');
    try { alert(label + ' — komt in de data-ronde.'); } catch (_) { /* ignore */ }
  };
  window.__mentSetUSub = (t) => { uSub = t; render(); };
  window.__mentToggleReis = (i) => { MENTOREN[i].reiskosten = !MENTOREN[i].reiskosten; render(); };

  function overzichtView() {
    return `${H.voorbeeldBanner()}
    ${H.kpis([
      { c: 'violet',  icon: I.grad,  label: 'Actieve mentoren',        val: '3',        sub: '1 inactief' },
      { c: 'emerald', icon: I.users, label: 'Leerlingen toegewezen',   val: '54', hi: 1, sub: 'gem. 18 per mentor' },
      { c: 'amber',   icon: I.alert, label: 'Zonder mentor',           val: '7',  hi: 1, sub: 'wachten op toewijzing' },
      { c: 'blue',    icon: I.euro,  label: 'Uit te betalen',          val: eur0(5400),  sub: 'deze maand' },
    ])}
    ${H.toolbar([
      H.chips('st', [{ l: 'Actief', v: 'a', n: 3 }, { l: 'Inactief', v: 'i', n: 1 }], F('st', 'a')),
      H.search('Zoek mentor…'),
      `<div class="tb-right"><button class="btn btn-primary" onclick="__mentNotice('Mentor toevoegen')">${svg(I.plus)}Mentor toevoegen</button></div>`,
    ])}
    ${H.table(
      [{ l: 'Mentor' }, { l: 'Leerlingen', cls: 'r' }, { l: 'Sessies', cls: 'r optional' }, { l: 'Saldo', cls: 'r' }, { l: 'Reiskosten' }, { l: 'Status' }],
      MENTOREN.map((m, i) => [
        `<div class="row-avatar">${H.av(m.naam, 30)}<div><div class="cell-main">${m.naam}</div><div class="cell-sub">${m.beschikbaar}</div></div></div>`,
        `<span class="mono">${m.leerlingen}</span>`,
        `<span class="mono">${m.sessies}</span>`,
        `<span class="money" style="color:var(--emerald)">${eur0(m.vergoeding * .88)}</span>`,
        `<div style="display:flex;align-items:center;gap:9px" onclick="event.stopPropagation()">
          <button class="chip ${m.reiskosten ? 'on' : ''}" onclick="__mentToggleReis(${i})" style="font-size:11.5px;padding:3px 10px">${m.reiskosten ? 'Aan' : 'Uit'}</button>
          ${m.reiskosten ? `<span style="font-size:12px;color:var(--text-2)">${eur0(m.dagbedrag)}/dag</span>` : ''}
        </div>`,
        H.pill(m.status === 'actief' ? 'ok' : 'neutral', m.status),
      ])
    )}
    <div style="padding:12px 22px;font-size:11.5px;color:var(--text-3);display:flex;align-items:flex-start;gap:8px">${svg(I.route, 'width:14px;height:14px;flex-shrink:0;margin-top:1px')}<span>Staat reiskosten aan, dan krijgt de mentor rond de eerste vrijdag van de nieuwe maand automatisch de vraag hoeveel dagen hij reed.</span></div>`;
  }

  function grootboekView() {
    return `${H.voorbeeldBanner()}
    ${H.kpis([
      { c: 'blue',    icon: I.euro,  label: 'Omzet uit events', val: eur0(24800), sub: 'dit kwartaal' },
      { c: 'violet',  icon: I.grad,  label: 'Bonuspot',         val: eur0(4960),  hi: 1, sub: '20% van omzet' },
      { c: 'amber',   icon: I.box,   label: 'Uitgaven',         val: eur0(3400),  hi: 1, sub: 'zaal, catering, materiaal' },
      { c: 'emerald', icon: I.tick,  label: 'Netto',            val: eur0(16440), hi: 1, sub: 'na bonus en kosten' },
    ])}
    <div class="pad">
      <div class="card" style="margin-bottom:14px">
        <div class="card-head"><span class="tile-ico" style="background:var(--pink-soft);color:var(--pink)">${svg(I.cal)}</span>
          <div class="card-title">Per event</div></div>
        ${H.table(
          [{ l: 'Event' }, { l: 'Datum', cls: 'optional' }, { l: 'Omzet', cls: 'r' }, { l: 'Bonus', cls: 'r' }, { l: 'Uitgaven', cls: 'r' }, { l: 'Netto', cls: 'r' }, { l: 'Status' }],
          [['Gent · 1 aug',  '01-08-2026', 12400, 2480, 680, 'uitbetaald'],
           ['Gent · 25 jul', '25-07-2026', 12400, 2480, 720, 'open']]
            .map(([e, d, o, b, u, st]) => [
              `<span class="cell-main">${e}</span>`,
              `<span class="mono" style="color:var(--text-3);font-size:12.5px">${d}</span>`,
              `<span class="money">${eur0(o)}</span>`,
              `<span class="money">${eur0(b)}</span>`,
              `<span class="money">− ${eur0(u)}</span>`,
              `<span class="money" style="color:var(--emerald)">${eur0(o - b - u)}</span>`,
              H.pill(st === 'uitbetaald' ? 'ok' : 'warn', st),
            ])
        )}
      </div>
      <div class="card">
        <div class="card-head"><span class="tile-ico" style="background:var(--violet-soft);color:var(--violet)">${svg(I.users)}</span>
          <div class="card-title">Per mentor</div>
          <button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="__mentNotice('Uitbetaling klaarzetten')">${svg(I.euro)}Uitbetaling klaarzetten</button></div>
        ${H.table(
          [{ l: 'Mentor' }, { l: 'Events', cls: 'r' }, { l: 'Bonus', cls: 'r' }, { l: 'Uitgaven', cls: 'r' }, { l: 'Saldo', cls: 'r' }, { l: 'Status' }],
          MENTOREN.filter(m => m.status === 'actief').map(m => [
            `<div class="row-avatar">${H.av(m.naam, 28)}<span class="cell-main">${m.naam}</span></div>`,
            `<span class="mono">${Math.round(m.leerlingen / 8)}</span>`,
            `<span class="money">${eur0(m.vergoeding)}</span>`,
            `<span class="money">− ${eur0(m.vergoeding * .12)}</span>`,
            `<span class="money" style="color:var(--emerald)">${eur0(m.vergoeding * .88)}</span>`,
            H.pill(m.naam === 'Dave Klaassen' ? 'ok' : 'warn', m.naam === 'Dave Klaassen' ? 'Uitbetaald' : 'Open'),
          ])
        )}
      </div>
    </div>`;
  }

  function uitbetalingenView() {
    const som = UITB.reduce((a, u) => a + utot(u), 0);
    const kpi = H.kpis([
      { c: 'violet',  icon: I.grad,  label: 'Bonus uit events',  val: eur0(UITB.reduce((a, u) => a + u.bonus, 0)),  sub: '8 events' },
      { c: 'emerald', icon: I.users, label: 'Coaching-sessies',   val: eur0(UITB.reduce((a, u) => a + u.coach, 0)),  hi: 1, sub: '48 sessies' },
      { c: 'amber',   icon: I.euro,  label: 'Totaal te betalen', val: eur0(som), hi: 1, sub: '3 mentoren' },
      { c: 'rose',    icon: I.alert, label: 'Wacht op akkoord',  val: '2', hi: 1, sub: 'rapporten' },
    ]);
    const subs = ['Rapporten', 'Declaraties', 'Handmatige posten', 'Tarieven'];
    const tabs = `<div class="toolbar" style="padding-bottom:0;border-bottom:none">
      ${subs.map(t => `<button class="chip ${uSub === t ? 'on' : ''}" onclick="__mentSetUSub('${t}')">${t}</button>`).join('')}</div>`;
    let body = '';
    if (uSub === 'Rapporten') {
      body = H.table(
        [{ l: 'Mentor' }, { l: 'Events', cls: 'r optional' }, { l: 'Bonus', cls: 'r' }, { l: 'Coaching', cls: 'r' }, { l: 'Reis', cls: 'r optional' }, { l: 'Handmatig', cls: 'r optional' }, { l: 'Totaal', cls: 'r' }, { l: 'Status' }, { l: '', cls: 'r' }],
        UITB.map(u => [
          `<div class="row-avatar">${H.av(u.n, 30)}<div><div class="cell-main">${u.n}</div><div class="cell-sub">${u.btw ? 'factureert met btw' : 'geen btw'}</div></div></div>`,
          `<span class="mono">${u.ev}</span>`,
          `<span class="money">${eur0(u.bonus)}</span>`,
          `<span class="money">${eur0(u.coach)}</span>`,
          `<span class="money" style="${u.reis ? '' : 'color:var(--text-3)'}">${u.reis ? eur0(u.reis) : '—'}</span>`,
          `<span class="money" style="${u.corr ? 'color:var(--rose)' : 'color:var(--text-3)'}">${u.corr ? eur0(u.corr) : '—'}</span>`,
          `<span class="money"><b>${eur0(utot(u))}</b></span>`,
          H.pill(UST[u.st].c, UST[u.st].l),
          u.st === 'concept'
            ? `<button class="btn btn-primary btn-sm" onclick="__mentNotice('Goedkeuren ' + '${u.n.replace(/'/g, "\\'")}')">Goedkeuren</button>`
            : u.st === 'goedgekeurd'
              ? `<button class="btn btn-ghost btn-sm" onclick="__mentNotice('Markeer betaald ' + '${u.n.replace(/'/g, "\\'")}')">Markeer betaald</button>`
              : `<button class="btn btn-ghost btn-sm" onclick="__mentNotice('PDF ' + '${u.n.replace(/'/g, "\\'")}')">${svg(I.down)}PDF</button>`,
        ])
      );
    } else if (uSub === 'Declaraties') {
      body = `<div style="padding:20px;color:var(--text-3);font-size:12.5px;line-height:1.6;max-width:760px">
        <p><b>Declaraties</b> — mentoren dienen reiskosten in via hun eigen omgeving met datum, aanleiding, kilometers, tarief en bon. Goedgekeurde declaraties komen automatisch op het maandrapport (zichtbaar in Rapporten-tab).</p>
        <p>Volledige tabel met per-declaratie goedkeur-flow, filter-chips (Ingediend/Goedgekeurd/Afgewezen), en bulk-acties komt in de data-ronde uit prototype r5357-5403.</p>
        <button class="btn btn-primary" style="margin-top:12px" onclick="__mentNotice('Declaraties-tabel volledig openen')">${svg(I.eye)}Vol prototype-preview openen</button>
      </div>`;
    } else if (uSub === 'Handmatige posten') {
      body = `<div style="padding:20px;color:var(--text-3);font-size:12.5px;line-height:1.6;max-width:760px">
        <p><b>Handmatige posten</b> — bijtellingen (extra vergoedingen) en inhoudingen (correcties) die niet automatisch berekend worden. Elke post krijgt een omschrijving die de mentor ook op zijn specificatie ziet.</p>
        <p>Modal-flow voor "Post toevoegen" met Mentor/Soort/Bedrag/Omschrijving/Periode-velden komt in de data-ronde uit prototype r5442-5472.</p>
        <button class="btn btn-primary" style="margin-top:12px" onclick="__mentNotice('Post toevoegen')">${svg(I.plus)}Post toevoegen</button>
      </div>`;
    } else {
      body = `<div style="padding:20px;color:var(--text-3);font-size:12.5px;line-height:1.6;max-width:760px">
        <p><b>Tarieven per mentor</b> — 1-op-1 sessie, groepssessie, intake, km-tarief, event-bonus (%), btw-flag. Wijzigingen gelden vanaf eerstvolgende berekening; al goedgekeurde rapporten blijven ongemoeid.</p>
        <p>Editable-tabel met inline inputs per mentor komt in de data-ronde uit prototype r5425-5440.</p>
      </div>`;
    }
    return `${H.voorbeeldBanner()}${kpi}${tabs}${body}`;
  }

  function beoordelingenView() {
    return `${H.voorbeeldBanner()}
    ${H.toolbar([
      `<input class="filter-sel" type="month" value="2026-08">`,
      `<select class="filter-sel"><option>Alle mentoren</option>${MENTOREN.map(m => `<option>${m.naam}</option>`).join('')}</select>`,
      H.chips('st', [{ l: 'Alles', v: 'all', n: 54 }, { l: 'Op schema', v: 'os', n: 38 }, { l: 'Aandacht', v: 'aa', n: 11 }, { l: 'Risico', v: 'ri', n: 3 }], F('st', 'all')),
      H.search('Zoek leerling…'),
    ])}
    ${H.table(
      [{ l: 'Leerling' }, { l: 'Mentor', cls: 'optional' }, { l: 'Maand', cls: 'optional' }, { l: 'Status' }, { l: 'Cijfer', cls: 'r' }, { l: 'Notitie', cls: 'optional' }, { l: 'Bijgewerkt', cls: 'r optional' }],
      [
        ['Cabdi Ibrahim',   'Dave Klaassen', 'aug 2026', 'op_schema', 8, 'Pakt het snel op, oefent dagelijks',       '4 aug'],
        ['Nikita Bykov',    'Dave Klaassen', 'aug 2026', 'aandacht',  6, 'Minder actief laatste weken',              '3 aug'],
        ['Dyami Van Praag', 'Mike de Vries', 'aug 2026', 'risico',    4, '3 weken geen activiteit',                  '2 aug'],
        ['Jan Willem Bel',  'Dave Klaassen', 'aug 2026', 'op_schema', 9, 'Bovengemiddeld, klaar voor verdieping',    '4 aug'],
      ].map(([l, m, mn, st, c, n, d]) => [
        `<div class="row-avatar">${H.av(l, 28)}<span class="cell-main">${l}</span></div>`,
        `<div class="row-avatar">${H.av(m, 24)}<span style="font-size:12.5px">${m}</span></div>`,
        `<span style="color:var(--text-3);font-size:12.5px">${mn}</span>`,
        H.pill(st === 'op_schema' ? 'ok' : st === 'aandacht' ? 'warn' : 'danger', st.replace('_', ' ')),
        `<span class="mono" style="font-weight:600;color:var(--${c >= 8 ? 'emerald' : c >= 6 ? 'amber' : 'rose'})">${c}</span>`,
        `<span style="color:var(--text-3);font-size:12.5px">${n}</span>`,
        `<span class="mono" style="color:var(--text-3);font-size:12.5px">${d}</span>`,
      ])
    )}`;
  }

  function certificatenView() {
    const f = F('cf', 'all');
    const rows = CERTIFICATEN.filter(c => f === 'all' || c.status === f);
    const goed = CERTIFICATEN.filter(c => c.status === 'goedgekeurd').length;
    return `${H.voorbeeldBanner()}
    ${H.kpis([
      { c: 'violet',  icon: I.grad,  label: 'Certificaten totaal', val: String(CERTIFICATEN.length),                                            sub: 'van alle mentoren' },
      { c: 'amber',   icon: I.clock, label: 'In beoordeling',       val: String(CERTIFICATEN.filter(c => c.status === 'ingediend').length),      hi: 1, sub: 'wacht op goedkeuring' },
      { c: 'emerald', icon: I.euro,  label: 'Uitgekeerde bonus',    val: eur0(goed * 100),                                                        sub: goed + ' × € 100' },
    ])}
    ${H.toolbar([
      H.chips('cf', [{ l: 'Alles', v: 'all', n: CERTIFICATEN.length }, { l: 'In beoordeling', v: 'ingediend' }, { l: 'Goedgekeurd', v: 'goedgekeurd' }], f),
      H.search('Zoek mentor of certificaat…'),
    ])}
    ${H.table(
      [{ l: 'Mentor' }, { l: 'Certificaat' }, { l: 'Uitgever', cls: 'optional' }, { l: 'Datum', cls: 'optional' }, { l: 'Bonus', cls: 'r optional' }, { l: 'Status' }, { l: '', cls: 'r' }],
      rows.map(c => [
        `<div class="row-avatar">${H.av(c.mentor, 26)}<span class="cell-main">${c.mentor}</span></div>`,
        `<div style="display:flex;align-items:center;gap:10px">${GRADICO}<span class="cell-main">${c.naam}</span></div>`,
        c.uitgever,
        `<span class="mono" style="font-size:12.5px">${c.datum}</span>`,
        `<span class="money">${eur0(100)}</span>`,
        H.pill(CERTST[c.status].c, CERTST[c.status].l),
        `<div style="display:flex;gap:6px;justify-content:flex-end">
          ${c.status === 'ingediend' ? `<button class="btn btn-ghost btn-sm" onclick="__mentNotice('Goedkeuren cert')">${svg(I.tick)}Goedkeuren</button>` : ''}
          <button class="btn btn-primary btn-sm" onclick="__mentNotice('Download cert')">${svg(I.down)}Download</button></div>`,
      ])
    )}`;
  }

  function signalenView() {
    return `${H.voorbeeldBanner()}
    ${H.kpis([
      { c: 'rose',    icon: I.alert,  label: 'Open signalen',      val: '4',  hi: 1, sub: 'vragen aandacht' },
      { c: 'amber',   icon: I.repeat, label: 'Opnieuw opvolgen',   val: '2',  hi: 1, sub: 'geen gehoor gehad' },
      { c: 'emerald', icon: I.tick,   label: 'Afgehandeld',        val: '18', hi: 1, sub: 'deze maand' },
    ])}
    ${H.toolbar([
      H.chips('st', [{ l: 'Open', v: 'o', n: 4 }, { l: 'Opnieuw opvolgen', v: 'oo', n: 2 }, { l: 'Afgehandeld', v: 'a', n: 18 }], F('st', 'o')),
      `<select class="filter-sel"><option>Alle mentoren</option>${MENTOREN.map(m => `<option>${m.naam}</option>`).join('')}</select>`,
    ])}
    ${H.table(
      [{ l: 'Leerling' }, { l: 'Signaal' }, { l: 'Gemeld door', cls: 'optional' }, { l: 'Sinds', cls: 'optional' }, { l: '', cls: 'r' }],
      [
        ['Dyami Van Praag',  'Reageert niet op berichten', 'Mike de Vries', '5 d'],
        ['Christa Noltus',   'Eerste call niet gelukt',     'Dave Klaassen', '3 d'],
        ['Jennifer Botaka',  'No-show bij sessie',          'Systeem',       '2 d'],
        ['Tom Verheyen',     'Niet bereikbaar',             'Sarah Bosman',  '1 d'],
      ].map(([l, s, m, d]) => [
        `<div class="row-avatar">${H.av(l, 28)}<span class="cell-main">${l}</span></div>`,
        H.pill(s.includes('No-show') ? 'danger' : 'warn', s),
        `<span style="font-size:12.5px">${m}</span>`,
        `<span class="mono" style="color:var(--text-3);font-size:12.5px">${d}</span>`,
        `<button class="btn btn-primary btn-sm" onclick="__mentNotice('Signaal afhandelen: ${l.replace(/'/g, "\\'")}')">Afhandelen</button>`,
      ])
    )}`;
  }

  window.DFO.VIEWS['mentoren/Overzicht']     = overzichtView;
  window.DFO.VIEWS['mentoren/Grootboek']     = grootboekView;
  window.DFO.VIEWS['mentoren/Uitbetalingen'] = uitbetalingenView;
  window.DFO.VIEWS['mentoren/Beoordelingen'] = beoordelingenView;
  window.DFO.VIEWS['mentoren/Certificaten']  = certificatenView;
  window.DFO.VIEWS['mentoren/Signalen']      = signalenView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('mentoren');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('mentoren');
  console.debug('[mentoren-v2] registered 6 views (dormant)');
})();
