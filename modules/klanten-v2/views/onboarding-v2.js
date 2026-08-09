// modules/klanten-v2/views/onboarding-v2.js
//
// Fase D module — Onboarding (layout-only, voorbeeld-data).
// 1-op-1 render uit prototype:
//   - VIEWS['onboarding/Actief']   r5547-5619 (KPI + bulk-filter + tabel + bulk-bar)
//   - openOnb                      r5621-5678 (zijpaneel-detail)
//   - VIEWS['onboarding/Inbox']    r5680-5720 (chat-split)
//   - VIEWS['onboarding/Archief']  r5722-5733 (afgeronde-tabel)
//   - ONB + PIJP + WIZ mock         r5516-5545
//
// Dormant — 'onboarding' niet in V2_ACTIVE_ALLOWLIST. Preview via
// ?v2preview=onboarding.

(function () {
  if (!window.DFO) { console.error('[onboarding-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[onboarding-v2] KV_V2.helpers niet geladen.'); return; }

  const { I, svg, S, F, render, openPanel, goTab } = window.DFO;
  const H = window.KV_V2.helpers;

  const ONB = [
    { n: 'BV Ky',                     tr: '12 maand 1-op-1',     pijp: 'geen_mentor', bet: false, bd: 'verstreken', bdd: '20-06', besch: null,             mentor: null,               lms: false, wiz: 0, aang: '04 aug 2026', start: '17 aug 2026' },
    { n: 'Aysar Al Dujaili',          tr: '6 maand 1-op-1',      pijp: 'geen_mentor', bet: false, bd: 'verstreken', bdd: '25-07', besch: 'ma/wo avond',     mentor: null,               lms: false, wiz: 1, aang: '11 jul 2026', start: '24 aug 2026' },
    { n: 'Mikael Kuijpers',           tr: '6 maand 1-op-1',      pijp: 'geen_mentor', bet: false, bd: 'loopt',      bdd: '14-08', besch: null,             mentor: null,               lms: false, wiz: 0, aang: '31 jul 2026', start: '29 aug 2026' },
    { n: 'Veronique Beheyt',          tr: '24 maand 1-op-1',     pijp: 'geen_mentor', bet: true,  bd: 'verstreken', bdd: '18-05', besch: 'di/do overdag',   mentor: null,               lms: true,  wiz: 0, aang: '03 aug 2026', start: '01 sep 2026' },
    { n: 'Aschwin Kelderman',         tr: '12 maand 1-op-1',     pijp: 'geen_mentor', bet: true,  bd: 'verstreken', bdd: '05-08', besch: null,             mentor: null,               lms: false, wiz: 0, aang: '22 jul 2026', start: '07 sep 2026' },
    { n: 'Cabdi Ibrahim',             tr: '12 maand 1-op-1',     pijp: 'toegewezen',  bet: true,  bd: 'loopt',      bdd: '15-08', besch: 'ma/di avond',     mentor: 'Dave Klaassen',    lms: true,  wiz: 3, aang: '01 aug 2026', start: '13 nov 2026' },
    { n: 'Stéphane Seutin',           tr: '12 maand 1-op-1',     pijp: 'toegewezen',  bet: true,  bd: 'loopt',      bdd: '18-08', besch: 'wo/vr overdag',   mentor: 'Mike de Vries',    lms: true,  wiz: 2, aang: '03 aug 2026', start: '20 aug 2026' },
    { n: 'Emile Rabaut',              tr: '6 maand 1-op-1',      pijp: 'gestart',     bet: true,  bd: 'verstreken', bdd: '12-07', besch: 'di/do avond',     mentor: 'Dave Klaassen',    lms: true,  wiz: 4, aang: '04 aug 2026', start: '10 aug 2026' },
    { n: 'Vaylleth Esser',            tr: '12 maand 1-op-1',     pijp: 'geen_gehoor', bet: false, bd: 'verstreken', bdd: '16-06', besch: null,             mentor: 'Kjento Biebuyck',  lms: false, wiz: 0, aang: '30 jul 2026', start: '02 aug 2026' },
  ];
  const PIJP = {
    geen_mentor:  { l: 'Nog geen mentor', c: 'warn'    },
    geen_gehoor:  { l: 'Geen gehoor',     c: 'danger'  },
    te_behandelen:{ l: 'Te behandelen',   c: 'accent'  },
    toegewezen:   { l: 'Toegewezen',      c: 'ok'      },
    gestart:      { l: 'Gestart',         c: 'violet'  },
  };
  const WIZ = ['Nog niet gestart', 'Stap 1 van 4', 'Stap 2 van 4', 'Stap 3 van 4', 'Afgerond'];
  const MENTORS = ['Dave Klaassen', 'Mike de Vries', 'Sarah Bosman', 'Kjento Biebuyck'];

  window.__onbNotice = (label) => {
    console.info('[onboarding-v2] ' + label + ' (voorbeeld — komt in data-ronde)');
    try { alert(label + ' — komt in de data-ronde.'); } catch (_) { /* ignore */ }
  };
  window.__onbToggleSel = (k) => { S.sel = S.sel || {}; S.sel[k] = !S.sel[k]; render(); };
  window.__onbOpen = (i) => {
    const o = S.rows[i]; if (!o) return;
    S.selIdx = i;
    openPanel(o.n, `${o.tr} · start ${o.start}`,
      `<div class="hero-amount" style="padding:18px 20px">
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
          ${H.pill(PIJP[o.pijp].c, PIJP[o.pijp].l)}
          ${o.bet ? H.pill('ok', 'Betaald') : H.pill('danger', 'Nog niet betaald')}
          ${o.lms ? H.pill('ok', 'LMS actief') : H.pill('danger', 'Geen LMS-account')}</div>
        <div style="font-size:12px;color:var(--text-3);margin-bottom:5px">Voortgang wizard</div>
        <div style="display:flex;align-items:center;gap:11px">
          <div class="progress" style="flex:1;height:8px"><i style="width:${o.wiz / 4 * 100}%"></i></div>
          <span class="mono" style="font-size:13px;font-weight:600">${o.wiz}/4</span></div>
        <div style="font-size:12.5px;color:var(--text-2);margin-top:6px">${WIZ[o.wiz]}</div>
      </div>
      <div class="sect"><div class="sect-title">Mentor</div>
        <div style="font-size:13px">${o.mentor || '<span style="color:var(--amber)">Nog geen mentor toegewezen</span>'}</div>
      </div>
      <div class="sect"><div class="sect-title">Status</div>
        <div class="kv"><dt>Traject</dt><dd>${o.tr}</dd></div>
        <div class="kv"><dt>Betaling</dt><dd>${o.bet ? H.pill('ok', 'Voldaan') : H.pill('danger', 'Open')}</dd></div>
        <div class="kv"><dt>Bedenktijd</dt><dd>${o.bd === 'loopt' ? '<span style="color:var(--amber)">Vervalt ' + o.bdd + '</span>' : 'Verstreken ' + o.bdd}</dd></div>
        <div class="kv"><dt>Aangemeld</dt><dd class="num">${o.aang}</dd></div>
        <div class="kv"><dt>Startdatum</dt><dd class="num">${o.start}</dd></div>
        <div class="kv"><dt>Beschikbaarheid</dt><dd>${o.besch || 'nog niet opgegeven'}</dd></div>
      </div>`,
      `<button class="btn btn-ghost" onclick="__onbNotice('Bellen')">${svg(I.phone)}Bellen</button>
       <button class="btn btn-primary" style="margin-left:auto" onclick="__onbNotice('Herinnering sturen')">${svg(I.send)}Herinnering sturen</button>`);
  };

  function actiefView() {
    const f = F('f', 'all'), q = (F('q', '') || '').toLowerCase();
    let rows = ONB.filter(o => !q || o.n.toLowerCase().includes(q));
    if (f === 'gm') rows = rows.filter(o => !o.mentor);
    if (f === 'nb') rows = rows.filter(o => !o.bet);
    if (f === 'nl') rows = rows.filter(o => !o.lms);
    if (f === 'bd') rows = rows.filter(o => o.bd === 'loopt');
    if (f === 'gg') rows = rows.filter(o => o.pijp === 'geen_gehoor');
    S.rows = rows;
    S.sel = S.sel || {};
    const nsel = Object.keys(S.sel).filter(k => S.sel[k] && k[0] === 'o').length;

    return `${H.voorbeeldBanner()}
    ${H.kpis([
      { c: 'emerald', icon: I.route, label: 'In onboarding',        val: String(ONB.length),                                    sub: 'actieve trajecten' },
      { c: 'amber',   icon: I.grad,  label: 'Wacht op mentor',      val: String(ONB.filter(o => !o.mentor).length),               hi: 1, sub: 'pak deze eerst op' },
      { c: 'rose',    icon: I.euro,  label: 'Nog niet betaald',     val: String(ONB.filter(o => !o.bet).length),                  hi: 1, sub: 'van ' + ONB.length },
      { c: 'blue',    icon: I.book || I.grad, label: 'Zonder LMS-account', val: String(ONB.filter(o => !o.lms).length),          hi: 1, sub: 'Bubble nog aanmaken' },
      { c: 'violet',  icon: I.clock, label: 'Bedenktijd loopt',     val: String(ONB.filter(o => o.bd === 'loopt').length),          sub: 'nog niet definitief' },
    ])}
    ${H.toolbar([
      H.chips('f', [
        { l: 'Alles',              v: 'all', n: ONB.length },
        { l: 'Geen mentor',        v: 'gm',  n: ONB.filter(o => !o.mentor).length },
        { l: 'Niet betaald',       v: 'nb',  n: ONB.filter(o => !o.bet).length },
        { l: 'Geen LMS',           v: 'nl',  n: ONB.filter(o => !o.lms).length },
        { l: 'Bedenktijd loopt',   v: 'bd',  n: ONB.filter(o => o.bd === 'loopt').length },
        { l: 'Geen gehoor',        v: 'gg',  n: ONB.filter(o => o.pijp === 'geen_gehoor').length },
      ], f),
      H.search('Zoek klant…'),
      `<div class="tb-right"><button class="btn btn-ghost" onclick="__onbNotice('Export')">${svg(I.down)}Export</button><button class="btn btn-primary" onclick="__onbNotice('Onboarding starten')">${svg(I.plus)}Onboarding starten</button></div>`,
    ])}
    ${H.table(
      [{ l: '' }, { l: 'Klant' }, { l: 'Fase' }, { l: 'Betaling' }, { l: 'Bedenktijd' }, { l: 'Mentor', cls: 'optional' }, { l: 'LMS', cls: 'c' }, { l: 'Onboardingflow' }, { l: 'Startdatum', cls: 'optional' }],
      rows.map((o, i) => [
        `<div class="checkbox ${S.sel['o' + i] ? 'on' : ''}" onclick="event.stopPropagation();__onbToggleSel('o${i}')">${svg(I.tick)}</div>`,
        `<div class="row-avatar">${H.av(o.n, 30)}<div><div class="cell-main">${o.n}</div><div class="cell-sub">${o.tr}</div></div></div>`,
        H.pill(PIJP[o.pijp].c, PIJP[o.pijp].l),
        o.bet ? H.pill('ok', 'Betaald') : H.pill('danger', 'Nog niet'),
        o.bd === 'loopt'
          ? `<span class="pill pill-warn nodot" title="Bedenktijd loopt nog">Vervalt ${o.bdd}</span>`
          : `<span style="color:var(--text-3);font-size:12.5px">Verstreken ${o.bdd}</span>`,
        o.mentor
          ? `<span style="font-size:12.5px">${o.mentor}</span>`
          : `<span class="pill pill-warn nodot">Geen mentor</span>`,
        o.lms
          ? `<span style="color:var(--emerald)">${svg(I.tick, 'width:17px;height:17px;stroke-width:2.8')}</span>`
          : `<span style="color:var(--rose);cursor:pointer" onclick="event.stopPropagation();__onbNotice('LMS-account aanmaken voor ${o.n.replace(/'/g, "\\'")}')">${svg(I.x, 'width:17px;height:17px;stroke-width:2.8')}</span>`,
        `<div style="min-width:110px"><div style="font-size:12px;color:var(--text-2)">${WIZ[o.wiz]}</div>
          <div class="progress" style="margin-top:4px"><i style="width:${o.wiz / 4 * 100}%"></i></div></div>`,
        `<div><div class="mono" style="font-size:12.5px">${o.start}</div><div class="cell-sub">aangemeld ${o.aang}</div></div>`,
      ]),
      '__onbOpen'
    )}
    ${nsel ? `<div class="bulkbar"><b>${nsel} geselecteerd</b>
      <button class="btn btn-ghost btn-sm" onclick="__onbNotice('Mentor toewijzen')">Toewijzen</button>
      <button class="btn btn-ghost btn-sm" onclick="__onbNotice('LMS-accounts aanmaken')">LMS-accounts aanmaken</button>
      <button class="btn btn-ghost btn-sm" onclick="__onbNotice('Herinnering sturen')">Herinnering sturen</button>
      <button class="btn btn-ghost btn-sm" style="margin-left:auto" onclick="S.sel={};DFO.render()">Wissen</button></div>` : ''}`;
  }

  function inboxView() {
    return `${H.voorbeeldBanner()}
    <div class="ib-split">
      <div class="ib-list">
        <div class="ib-top">
          <div style="display:flex;gap:5px;margin-bottom:9px">
            <button class="chip on" style="font-size:11.5px;padding:3px 10px">WhatsApp <span class="cnt">2</span></button>
            <button class="chip" style="font-size:11.5px;padding:3px 10px" onclick="__onbNotice('E-mail-tab')">E-mail</button></div>
          <div class="tb-search" style="width:100%">${svg('<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>')}<input placeholder="Zoek…"></div>
        </div>
        ${['Stéphane Seutin', 'Cabdi Ibrahim', 'Emile Rabaut'].map((n, i) => `<div class="ib-row ${i === 0 ? 'on' : ''}" onclick="__onbNotice('Chat openen: ${n}')">
          ${H.av(n, 28)}
          <div class="ib-b">
            <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:2px">
              <span style="font-size:13.5px;font-weight:${i < 2 ? '600' : '500'}">${n}</span>
              <span style="margin-left:auto;font-size:10.5px;color:var(--text-3);font-family:'IBM Plex Mono',monospace">${['3u','1d','2d'][i]}</span></div>
            <div class="ib-t">${['Waar kan ik de documenten uploaden?', 'Wanneer is mijn eerste sessie?', 'Dank je wel!'][i]}</div>
            <div style="margin-top:7px">${H.pill('emerald', 'Stap ' + [2, 3, 4][i] + ' van 4', 1)}</div>
          </div></div>`).join('')}
      </div>
      <div class="ib-detail">
        <div style="padding:16px 22px;background:var(--surface);border-bottom:1px solid var(--border)">
          <div style="display:flex;align-items:center;gap:13px">
            ${H.av('Stéphane Seutin', 42)}
            <div style="flex:1"><div style="font-size:16px;font-weight:600">Stéphane Seutin</div>
              <div style="font-size:12.5px;color:var(--text-3)">Onboarding stap 2 · mentor Mike de Vries · start 20 aug</div></div>
            <button class="btn btn-ghost btn-sm" onclick="__onbNotice('Uploadlink sturen')">${svg(I.send)}Uploadlink</button>
            <button class="btn btn-ghost btn-sm" onclick="__onbNotice('Stap afvinken')">${svg(I.tick)}Stap afvinken</button>
            <button class="btn btn-ghost btn-sm" onclick="goTab('Actief')">${svg(I.route)}Dossier</button>
          </div>
        </div>
        <div style="flex:1;min-height:0;overflow-y:auto;padding:22px">
          <div style="max-width:660px">
            <div style="padding:14px 18px;background:var(--surface-2);border-radius:14px 14px 14px 4px;font-size:14px;line-height:1.55;margin-bottom:20px">Waar kan ik de documenten uploaden?</div>
            <div class="ai-sug">
              <div class="ai-sug-head"><span class="tile-ico" style="width:28px;height:28px;background:linear-gradient(140deg,var(--emerald),#34D399);color:#fff">${svg(I.sparkle, 'width:14px;height:14px')}</span>
                <div style="flex:1"><div style="font-size:13px;font-weight:600">Mila stelt voor</div>
                <div style="font-size:11.5px;color:var(--text-3)">Kent de onboarding-status</div></div></div>
              <div class="ai-sug-body">Hoi Stéphane! Je kunt de documenten uploaden via je persoonlijke link — die stuur ik je hierbij nog een keer. Zodra ze binnen zijn zet ik stap 2 op afgerond en plant Mike jullie eerste sessie in.</div>
              <div class="ai-sug-foot"><button class="btn btn-primary btn-sm" style="margin-left:auto;--m:var(--emerald);--m-glow:rgba(7,131,90,.4)" onclick="__onbNotice('AI-suggestie gebruiken')">${svg(I.edit)}Gebruiken</button></div>
            </div>
          </div>
        </div>
        <div style="padding:13px 22px;background:var(--surface);border-top:1px solid var(--border);display:flex;gap:8px;align-items:center">
          <button class="btn btn-ghost btn-sm" onclick="__onbNotice('Template')">Template</button>
          <span style="margin-left:auto;font-size:11.5px;color:var(--emerald)">● 24u venster open</span>
          <button class="btn btn-primary btn-sm" onclick="__onbNotice('Bericht verzenden')">${svg(I.send)}Verstuur</button>
        </div>
      </div>
    </div>`;
  }

  function archiefView() {
    return `${H.voorbeeldBanner()}
    ${H.toolbar([
      H.chips('r', [{ l: 'Afgerond', v: 'a', n: 3 }, { l: 'Geannuleerd', v: 'g', n: 2 }, { l: 'Wil niet', v: 'w', n: 1 }], F('r', 'a')),
      H.search('Zoek klant…'),
    ])}
    ${H.table(
      [{ l: 'Klant' }, { l: 'Traject', cls: 'optional' }, { l: 'Mentor', cls: 'optional' }, { l: 'Reden' }, { l: 'Afgerond op', cls: 'r' }],
      [
        ['Nikita Bykov',   '36 maand membership', 'Dave Klaassen', 'Onboarding afgerond',                '24 jul 2026'],
        ['Jan Willem Bel', '12 maand 1-op-1',     'Dave Klaassen', 'Onboarding afgerond',                '12 mei 2026'],
        ['Peter Vos',      '6 maand 1-op-1',      '—',             'Geannuleerd binnen bedenktijd',       '02 aug 2026'],
      ].map(([n, t, m, r, d]) => [
        `<div class="row-avatar">${H.av(n, 28)}<span class="cell-main">${n}</span></div>`,
        t,
        m === '—' ? '<span style="color:var(--text-3)">—</span>' : `<div class="row-avatar">${H.av(m, 24)}<span style="font-size:12.5px">${m}</span></div>`,
        H.pill(r.includes('Geannuleerd') ? 'danger' : 'ok', r),
        `<span class="mono" style="color:var(--text-3);font-size:12.5px">${d}</span>`,
      ])
    )}`;
  }

  window.DFO.VIEWS['onboarding/Actief']  = actiefView;
  window.DFO.VIEWS['onboarding/Inbox']   = inboxView;
  window.DFO.VIEWS['onboarding/Archief'] = archiefView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('onboarding');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('onboarding');
  console.debug('[onboarding-v2] registered 3 views (dormant)');
})();
