// modules/klanten-v2/views/verdiensten-v2.js
//
// Fase C module #3 — Verdiensten-module (mentor-finance) voor v2-shell.
// Layout-only, voorbeeld-data. 1-op-1 render uit prototype:
//   - MENTOREN                              r1404-1409  (mentor-profiel)
//   - myMentor + MIJNUITB + reisBedrag      r1851-1858  (uitbetalingen + reiskosten)
//   - VIEWS['verdiensten/Overzicht']        r1928-1957
//   - VIEWS['verdiensten/Uitbetalingen']    r1958-1973
//   - VIEWS['verdiensten/Reiskosten']       r1974-2007
//   - CERTIFICATEN / CERTST / GRADICO       r2010-2017
//   - VIEWS['verdiensten/Certificaten']     r2019-2045
//   - hbar / dashCard / areaChart           r1441-1463 (inline)
//   - uclbl                                 r3927
//
// Rol-context: mentor. Voor andere rollen toont de shell deze module niet
// via visMods() — Verdiensten heeft roles:['mentor'] in MODS.
//
// Registreert 4 views + KV_V2_ADD('verdiensten') — dormant. Preview via
// ?v2preview=verdiensten (én rol Mentor via 'Bekijk als').

(function () {
  if (!window.DFO) { console.error('[verdiensten-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[verdiensten-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, S, F, eur0, goTab, render } = window.DFO;
  const H = window.KV_V2.helpers;

  /* ── Voorbeeld-data (prototype r1404-1858) ────────────────────────── */
  const MENTOREN = [
    { naam: 'Dave Klaassen', leerlingen: 24, sessies: 18, beschikbaar: 'ma-do', vergoeding: 2400, status: 'actief',   reiskosten: true,  dagbedrag: 18 },
    { naam: 'Mike de Vries', leerlingen: 19, sessies: 14, beschikbaar: 'di-vr', vergoeding: 1900, status: 'actief',   reiskosten: true,  dagbedrag: 22 },
    { naam: 'Sarah Bosman',  leerlingen: 11, sessies:  9, beschikbaar: 'wo-vr', vergoeding: 1100, status: 'actief',   reiskosten: false, dagbedrag: 15 },
    { naam: 'Tim Jacobs',    leerlingen:  0, sessies:  0, beschikbaar: '—',    vergoeding:    0, status: 'inactief', reiskosten: false, dagbedrag:  0 },
  ];
  const MIJNUITB = [
    { maand: 'Juli 2026',   sessies: 24, vergoeding: 2112, bonus: 400, rijdagen: null, status: 'open' },
    { maand: 'Juni 2026',   sessies: 26, vergoeding: 2288, bonus: 480, rijdagen: 16,   status: 'uitbetaald' },
    { maand: 'Mei 2026',    sessies: 22, vergoeding: 1936, bonus:   0, rijdagen: 15,   status: 'uitbetaald' },
    { maand: 'April 2026',  sessies: 25, vergoeding: 2200, bonus: 240, rijdagen: 16,   status: 'uitbetaald' },
  ];
  const CERTIFICATEN = [
    { mentor: 'Dave Klaassen', naam: 'Advanced Technical Analysis',    uitgever: 'IFTA',                    datum: '02-08-2026', bestand: 'ifta-ta-dave.pdf',    status: 'goedgekeurd' },
    { mentor: 'Dave Klaassen', naam: 'Risk Management Professional',   uitgever: 'CISI',                    datum: '12-07-2026', bestand: 'cisi-risk-dave.pdf', status: 'goedgekeurd' },
    { mentor: 'Mike de Vries', naam: 'Certified Financial Technician', uitgever: 'IFTA',                    datum: '28-07-2026', bestand: 'cft-mike.pdf',       status: 'ingediend' },
    { mentor: 'Sarah Bosman',  naam: 'Trading Psychology Certificate', uitgever: 'Van Tharp Institute',     datum: '20-07-2026', bestand: 'psych-sarah.pdf',    status: 'goedgekeurd' },
  ];
  const CERTST = {
    ingediend:    { l: 'In beoordeling', c: 'warn'   },
    goedgekeurd:  { l: 'Goedgekeurd',    c: 'ok'     },
    afgewezen:    { l: 'Afgewezen',      c: 'danger' },
  };

  /* ── Helpers (prototype r1441-1463, r1851-1858, r3927) ────────────── */
  const hbar = (label, val, max, color, right) => `<div style="display:flex;align-items:center;gap:12px;margin-bottom:11px">
    <div style="width:118px;font-size:12.5px;color:var(--text-2);flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${label}</div>
    <div class="progress" style="flex:1;height:8px"><i style="width:${max ? Math.round(val / max * 100) : 0}%;background:var(--${color})"></i></div>
    <div style="width:82px;text-align:right;font-size:12.5px;font-weight:600;font-family:'IBM Plex Mono',monospace">${right}</div></div>`;

  const dashCard = (title, dotColor, body, extra) => `<div class="card">
    <div class="card-head" style="border-bottom:none;padding-bottom:6px">
      <span class="title-dot" style="background:var(--${dotColor});box-shadow:0 0 0 3px var(--${dotColor}-soft)"></span>
      <div class="card-title">${title}</div>${extra || ''}</div>
    <div class="card-body" style="padding:8px 17px 17px">${body}</div></div>`;

  function areaChart(data, labels) {
    const w = 100, h = 42, mx = Math.max(...data, 1);
    const pts = data.map((v, i) => [i / (data.length - 1) * w, h - (v / mx) * h * .88 - 2]);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:64px;display:block">
      <defs><linearGradient id="verd-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="var(--m)" stop-opacity=".22"/><stop offset="100%" stop-color="var(--m)" stop-opacity="0"/>
      </linearGradient></defs>
      <path fill="url(#verd-grad)" d="${line} L${w},${h} L0,${h} Z"/>
      <path fill="none" stroke="var(--m)" stroke-width="1.5" vector-effect="non-scaling-stroke" d="${line}"/>
    </svg><div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-3);margin-top:4px">${labels.map(l => `<span>${l}</span>`).join('')}</div>`;
  }

  const uclbl = (t) => `<div style="font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);margin-bottom:7px">${t}</div>`;

  // Rol-persona → mentor lookup. In v2-shell zit ROLES[S.role].persoon niet
  // altijd op de mentor-namen; fallback naar Dave Klaassen zodat de preview
  // altijd data toont voor review.
  function myMentor() {
    try {
      const persoon = window.DFO.ROLES?.[S.role]?.persoon;
      const match = MENTOREN.find(m => m.naam === persoon);
      if (match) return match;
    } catch (_) { /* fall through */ }
    return MENTOREN[0]; // Dave Klaassen als default voor preview
  }
  const reisBedrag = (u) => (u.rijdagen || 0) * myMentor().dagbedrag;

  const GRADICO = `<span style="width:26px;height:26px;border-radius:7px;background:var(--violet-soft);color:var(--violet);display:grid;place-items:center;flex-shrink:0">${svg(I.grad, 'width:14px;height:14px')}</span>`;

  /* ── Notice-handlers voor dode action-knoppen ─────────────────────── */
  window.__verdNotice = (label) => {
    console.info('[verdiensten-v2] ' + label + ' (voorbeeld — komt in data-ronde)');
    try { alert(label + ' — komt in de data-ronde.'); } catch (_) { /* ignore */ }
  };
  window.__verdDienRijdagen = () => {
    const el = document.getElementById('rijdagenInp');
    const v = el ? parseInt(el.value) : NaN;
    if (isNaN(v) || v < 0) { alert('Vul een geldig aantal rijdagen in.'); return; }
    // Layout-only: muteer in-memory mock zodat de re-render de nieuwe status toont.
    const open = MIJNUITB.find(u => u.rijdagen === null);
    if (open) open.rijdagen = v;
    console.info('[verdiensten-v2] Rijdagen doorgegeven (voorbeeld): ' + v);
    render();
  };
  window.__verdUploadCert = () => {
    const naam = (document.getElementById('certNaam')?.value || '').trim();
    if (!naam) { alert('Geef het certificaat een naam.'); return; }
    console.info('[verdiensten-v2] Certificaat indienen (voorbeeld): ' + naam);
    // Layout-only: prepend een mock-rij zodat het lijstje "leeft".
    CERTIFICATEN.unshift({ mentor: myMentor().naam, naam, uitgever: document.getElementById('certUitg')?.value || '—', datum: 'zojuist', bestand: '(mock)', status: 'ingediend' });
    render();
  };
  window.__verdGoToReiskosten = () => { try { goTab('Reiskosten'); } catch (_) { /* ignore */ } };

  /* ── VIEW 1: Verdiensten/Overzicht (prototype r1928-1957) ─────────── */
  function overzichtView() {
    const m = MIJNUITB[0];
    const reis = reisBedrag(m);
    const pending = m.rijdagen === null;
    const tot = m.vergoeding + m.bonus + reis;
    const mx = Math.max(m.vergoeding, m.bonus, Math.max(reis, 1));
    const ytd = MIJNUITB.reduce((a, x) => a + x.vergoeding + x.bonus + reisBedrag(x), 0);

    return `${H.voorbeeldBanner()}
    ${H.kpis([
      { c: 'blue',    icon: I.euro,  label: 'Verdiensten ' + m.maand.split(' ')[0].toLowerCase(), val: eur0(tot), sub: m.maand,               trend: H.trend('+9%', true) },
      { c: 'amber',   icon: I.clock, label: 'Uit te betalen',                                     val: eur0(tot), sub: 'vrijdag 7 augustus' },
      { c: 'teal',    icon: I.cal,   label: 'Sessies deze maand',                                 val: String(m.sessies), sub: 'à € 88 per sessie' },
      { c: 'emerald', icon: I.chart, label: 'Dit jaar verdiend',                                  val: eur0(ytd), sub: '2026 · YTD' },
    ])}
    <div class="pad" style="padding-top:16px">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start">
        ${dashCard('Opbouw — ' + m.maand, 'blue',
          hbar('Sessievergoeding', m.vergoeding, mx, 'teal',   eur0(m.vergoeding))
          + hbar('Event-bonussen',   m.bonus,      mx, 'violet', eur0(m.bonus))
          + (pending
              ? `<div style="display:flex;align-items:center;gap:12px;margin-bottom:11px"><div style="width:118px;font-size:12.5px;color:var(--text-2)">Reiskosten</div>
                <button class="btn btn-ghost btn-sm" style="color:var(--amber);padding-left:0" onclick="__verdGoToReiskosten()">${svg(I.alert, 'width:13px;height:13px')}Rijdagen nog doorgeven →</button></div>`
              : hbar('Reiskosten', reis, mx, 'amber', eur0(reis)))
          + `<div style="margin-top:8px;padding-top:12px;border-top:1px solid var(--border);display:flex;justify-content:space-between;font-size:13px"><b>Totaal${pending ? ' (excl. reiskosten)' : ''}</b><b class="mono">${eur0(tot)}</b></div>`)}
        ${dashCard('Volgende uitbetaling', 'emerald',
          `<div style="text-align:center;padding:8px 0">
            <div style="font-size:30px;font-weight:600;font-family:'IBM Plex Mono',monospace;color:var(--emerald)">${eur0(tot)}</div>
            <div style="font-size:12px;color:var(--text-3);margin:4px 0 14px">gepland op vrijdag 7 augustus 2026</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:9px">
              <div style="border:1px solid var(--border);border-radius:var(--r);padding:11px 13px"><div style="font-size:11.5px;color:var(--text-2);margin-bottom:4px">Sessies</div><div class="mono" style="font-size:17px;font-weight:600">${m.sessies}</div></div>
              <div style="border:1px solid var(--border);border-radius:var(--r);padding:11px 13px"><div style="font-size:11.5px;color:var(--text-2);margin-bottom:4px">Reiskosten</div><div class="mono" style="font-size:17px;font-weight:600">${pending ? '<span style="color:var(--amber);font-size:12.5px">nog doorgeven</span>' : eur0(reis)}</div></div></div>
          </div>`)}
      </div>
      <div style="margin-top:14px">${dashCard('Verdiensten per maand', 'blue',
        areaChart(
          MIJNUITB.map(x => x.vergoeding + x.bonus + reisBedrag(x)).reverse(),
          MIJNUITB.map(x => x.maand.split(' ')[0].slice(0, 3).toLowerCase()).reverse()
        ))}</div>
    </div>`;
  }

  /* ── VIEW 2: Verdiensten/Uitbetalingen (prototype r1958-1973) ─────── */
  function uitbetalingenView() {
    const uitbetaald = MIJNUITB.filter(u => u.status !== 'open').reduce((a, u) => a + u.vergoeding + u.bonus + reisBedrag(u), 0);
    const open = MIJNUITB.find(u => u.status === 'open');
    const openTotaal = open ? open.vergoeding + open.bonus + reisBedrag(open) : 0;
    const gem = Math.round(MIJNUITB.reduce((a, u) => a + u.vergoeding + u.bonus + reisBedrag(u), 0) / MIJNUITB.length);

    return `${H.voorbeeldBanner()}
    ${H.kpis([
      { c: 'emerald', icon: I.tick,  label: 'Uitbetaald dit jaar', val: eur0(uitbetaald), sub: '2026' },
      { c: 'amber',   icon: I.clock, label: 'Openstaand',          val: eur0(openTotaal),  sub: open ? open.maand : '—' },
      { c: 'blue',    icon: I.cal,   label: 'Gem. per maand',      val: eur0(gem),         sub: 'laatste 4 maanden' },
    ])}
    ${H.toolbar([
      H.chips('py', [{ l: '2026', v: '26' }, { l: '2025', v: '25' }], F('py', '26')),
      H.search('Zoek maand…'),
    ])}
    ${H.table(
      [{ l: 'Periode' }, { l: 'Sessies', cls: 'r' }, { l: 'Sessievergoeding', cls: 'r optional' }, { l: 'Bonus', cls: 'r optional' }, { l: 'Rijdagen', cls: 'r optional' }, { l: 'Reiskosten', cls: 'r optional' }, { l: 'Totaal', cls: 'r' }, { l: 'Status' }],
      MIJNUITB.map(u => [
        `<span class="cell-main">${u.maand}</span>`,
        `<span class="mono">${u.sessies}</span>`,
        `<span class="money">${eur0(u.vergoeding)}</span>`,
        `<span class="money">${eur0(u.bonus)}</span>`,
        `<span class="mono">${u.rijdagen === null ? '—' : u.rijdagen}</span>`,
        `<span class="money">${u.rijdagen === null ? '—' : eur0(reisBedrag(u))}</span>`,
        `<span class="money"><b>${eur0(u.vergoeding + u.bonus + reisBedrag(u))}</b></span>`,
        u.status === 'open' ? H.pill('warn', 'Openstaand') : H.pill('ok', 'Uitbetaald'),
      ])
    )}`;
  }

  /* ── VIEW 3: Verdiensten/Reiskosten (prototype r1974-2007) ────────── */
  function reiskostenView() {
    const M = myMentor();
    if (!M.reiskosten) {
      return `${H.voorbeeldBanner()}
      <div class="empty" style="padding:72px 20px">
        <div class="empty-ico">${svg(I.route)}</div>
        <div class="empty-t">Reiskostenvergoeding staat niet aan</div>
        <div class="empty-s">Voor jou is de reiskostenvergoeding (nog) niet ingeschakeld. Neem contact op met kantoor als dit wel zou moeten.</div>
      </div>`;
    }
    const open = MIJNUITB.find(u => u.rijdagen === null);
    const done = MIJNUITB.filter(u => u.rijdagen !== null);
    const jaar = done.reduce((a, u) => a + reisBedrag(u), 0);

    return `${H.voorbeeldBanner()}
    ${H.kpis([
      { c: 'blue',    icon: I.euro,  label: 'Vergoeding per rijdag', val: eur0(M.dagbedrag),  sub: 'jouw vaste bedrag' },
      { c: 'amber',   icon: I.route, label: 'Open aanvraag',         val: open ? '1' : '0',   hi: open ? 1 : 0, sub: open ? open.maand : 'niets openstaand' },
      { c: 'emerald', icon: I.chart, label: 'Reiskosten dit jaar',   val: eur0(jaar),          sub: done.length + ' maanden' },
    ])}
    <div class="pad" style="padding-top:16px">
      ${open
        ? dashCard('Rijdagen doorgeven — ' + open.maand, 'amber', `
            <div style="display:flex;align-items:flex-start;gap:11px;padding-bottom:14px;font-size:12.5px;color:var(--text-2)">
              ${svg(I.clock, 'width:16px;height:16px;flex-shrink:0;margin-top:1px;color:var(--amber)')}
              <span>Hoeveel dagen heb je in <b>${open.maand}</b> gereden? Geef het door vóór de uitbetaling van <b>vrijdag 7 augustus</b>, dan gaat het automatisch mee.</span></div>
            <div style="display:grid;grid-template-columns:160px auto 1fr;gap:14px;align-items:end">
              <div>${uclbl('Aantal rijdagen')}<input class="inp" id="rijdagenInp" type="number" min="0" max="31" style="max-width:none" placeholder="0" oninput="var b=document.getElementById('rijBedrag');if(b)b.textContent='€ '+((parseInt(this.value)||0)*${M.dagbedrag})"></div>
              <button class="btn btn-primary" onclick="__verdDienRijdagen()">${svg(I.tick)}Doorgeven</button>
              <div style="text-align:right;font-size:12.5px;color:var(--text-3)">Vergoeding: <b id="rijBedrag" class="mono" style="color:var(--text);font-size:15px">€ 0</b> <span>(${eur0(M.dagbedrag)}/dag)</span></div>
            </div>`)
        : `<div style="display:flex;align-items:center;gap:11px;padding:14px 16px;background:var(--emerald-soft);border:1px solid var(--emerald-line);border-radius:var(--r);font-size:13px;color:var(--emerald)">${svg(I.tick, 'width:16px;height:16px')}Je hebt alles doorgegeven — niets openstaand. Rond de eerste vrijdag van de nieuwe maand vragen we je rijdagen weer op.</div>`}
      <div style="margin-top:14px">${dashCard('Doorgegeven rijdagen', 'blue',
        H.table(
          [{ l: 'Maand' }, { l: 'Rijdagen', cls: 'r' }, { l: 'Per dag', cls: 'r optional' }, { l: 'Vergoeding', cls: 'r' }, { l: 'Status' }],
          done.map(u => [
            `<span class="cell-main">${u.maand}</span>`,
            `<span class="mono">${u.rijdagen}</span>`,
            `<span class="money">${eur0(M.dagbedrag)}</span>`,
            `<span class="money">${eur0(reisBedrag(u))}</span>`,
            u.status === 'open' ? H.pill('warn', 'Wordt verwerkt') : H.pill('ok', 'Uitbetaald'),
          ])
        ))}</div>
    </div>`;
  }

  /* ── VIEW 4: Verdiensten/Certificaten (prototype r2019-2045) ──────── */
  function certificatenView() {
    const mine = CERTIFICATEN.filter(c => c.mentor === myMentor().naam);
    const goed = mine.filter(c => c.status === 'goedgekeurd').length;

    return `${H.voorbeeldBanner()}
    ${H.kpis([
      { c: 'violet',  icon: I.grad, label: 'Mijn certificaten',    val: String(mine.length), sub: mine.filter(c => c.status === 'ingediend').length + ' in beoordeling' },
      { c: 'emerald', icon: I.tick, label: 'Goedgekeurd',          val: String(goed),         sub: 'tellen mee voor bonus' },
      { c: 'blue',    icon: I.euro, label: 'Certificaat-bonus',   val: eur0(goed * 100),     sub: '€ 100 per certificaat' },
    ])}
    <div class="pad" style="padding-top:16px">
      ${dashCard('Certificaat uploaden', 'violet', `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
          <div>${uclbl('Naam certificaat')}<input class="inp" id="certNaam" style="max-width:none" placeholder="bv. Advanced Technical Analysis"></div>
          <div>${uclbl('Uitgever')}<input class="inp" id="certUitg" style="max-width:none" placeholder="bv. IFTA"></div>
        </div>
        <input type="file" id="certFile" accept="application/pdf,image/*" style="display:none" onchange="var el=document.getElementById('certFileName');if(el)el.textContent=this.files[0]?this.files[0].name:'Geen bestand gekozen'">
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <button class="btn btn-ghost" onclick="document.getElementById('certFile').click()">${svg(I.doc)}Bestand kiezen</button>
          <span id="certFileName" style="font-size:12.5px;color:var(--text-3)">Geen bestand gekozen</span>
          <button class="btn btn-primary" style="margin-left:auto" onclick="__verdUploadCert()">${svg(I.plus)}Certificaat indienen</button>
        </div>
        <div style="font-size:11.5px;color:var(--text-3);margin-top:11px">Elk goedgekeurd certificaat levert automatisch <b>€ 100 bonus</b> op, meegenomen in je eerstvolgende uitbetaling. PDF of afbeelding.</div>`)}
      <div style="margin-top:14px">${dashCard('Mijn certificaten', 'blue',
        mine.length
          ? H.table(
              [{ l: 'Certificaat' }, { l: 'Uitgever', cls: 'optional' }, { l: 'Ingediend', cls: 'optional' }, { l: 'Bonus', cls: 'r' }, { l: 'Status' }],
              mine.map(c => [
                `<div style="display:flex;align-items:center;gap:10px">${GRADICO}<span class="cell-main">${c.naam}</span></div>`,
                c.uitgever,
                `<span style="color:var(--text-3)">${c.datum}</span>`,
                c.status === 'goedgekeurd' ? `<span class="money">${eur0(100)}</span>` : `<span style="color:var(--text-3)">—</span>`,
                H.pill(CERTST[c.status].c, CERTST[c.status].l),
              ])
            )
          : `<div style="padding:20px;text-align:center;color:var(--text-3);font-size:13px">Nog geen certificaten ingediend.</div>`)}</div>
    </div>`;
  }

  /* ── Registratie ───────────────────────────────────────────────────── */
  window.DFO.VIEWS['verdiensten/Overzicht']     = overzichtView;
  window.DFO.VIEWS['verdiensten/Uitbetalingen'] = uitbetalingenView;
  window.DFO.VIEWS['verdiensten/Reiskosten']    = reiskostenView;
  window.DFO.VIEWS['verdiensten/Certificaten']  = certificatenView;
  if (typeof window.KV_V2_ADD === 'function') {
    window.KV_V2_ADD('verdiensten');
  } else {
    (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('verdiensten');
  }

  console.debug('[verdiensten-v2] registered 4 Verdiensten views (dormant tot allowlist of ?v2preview=verdiensten)');
})();
