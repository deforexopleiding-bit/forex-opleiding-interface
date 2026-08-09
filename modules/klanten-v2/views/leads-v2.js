// modules/klanten-v2/views/leads-v2.js
//
// Fase E — Leads (layout-only). 2 tabs: Actief + Gearchiveerd.
// Compact-getrouw uit prototype r3230-3400. Actief = filter-strip + KPI + tabel;
// Gearchiveerd = filter-chips + tabel met reden-pills.
// Dormant. Preview ?v2preview=leads (rol Sales).

(function () {
  if (!window.DFO) { console.error('[leads-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[leads-v2] KV_V2.helpers niet geladen.'); return; }
  const { I, svg, F } = window.DFO;
  const H = window.KV_V2.helpers;

  const LEADS = [
    { naam: 'Bram de Vries',   bron: 'Meta Ads',  fase: 'Nieuw',           laatst: '2u geleden',  eig: 'Sales — Robin',  score: 82 },
    { naam: 'Sophie Jansen',   bron: 'Webinar',   fase: 'Contact',         laatst: 'gisteren',    eig: 'Sales — Kim',    score: 74 },
    { naam: 'Ahmed El Idrissi',bron: 'Instagram', fase: 'Kwalificatie',    laatst: '3 dagen',     eig: 'Sales — Robin',  score: 68 },
    { naam: 'Milou Peters',    bron: 'Referral',  fase: 'Offerte',         laatst: '5 dagen',     eig: 'Sales — Kim',    score: 91 },
    { naam: 'Daan Bosman',     bron: 'Meta Ads',  fase: 'Nieuw',           laatst: '1u geleden',  eig: 'Sales — Robin',  score: 55 },
  ];
  const ARCHIEF = [
    { naam: 'Ilse Vermeer',    bron: 'Meta Ads',  reden: 'Geen interesse',    datum: '18-07-2026', eig: 'Robin' },
    { naam: 'Youssef Bakr',    bron: 'Instagram', reden: 'Onbereikbaar',      datum: '15-07-2026', eig: 'Kim' },
    { naam: 'Anouk Willems',   bron: 'Referral',  reden: 'Duplicaat',         datum: '12-07-2026', eig: 'Robin' },
    { naam: 'Robin de Groot',  bron: 'Webinar',   reden: 'Prijs',             datum: '08-07-2026', eig: 'Kim' },
    { naam: 'Kevin Bosma',     bron: 'Meta Ads',  reden: 'Doorgestroomd',     datum: '02-07-2026', eig: 'Robin' },
  ];
  const REDEN_TO_PILL = {
    'Geen interesse': 'neutral', 'Onbereikbaar': 'warn', 'Duplicaat': 'neutral',
    'Prijs': 'warn', 'Doorgestroomd': 'ok',
  };
  const FASE_TO_PILL = { 'Nieuw': 'info', 'Contact': 'primary', 'Kwalificatie': 'primary', 'Offerte': 'ok' };

  window.__leadsNotice = (l) => { console.info('[leads-v2] ' + l); try { alert(l + ' — komt in de data-ronde.'); } catch (_) {} };

  function actiefView() {
    const f = F('lead-fase', 'all');
    const rows = LEADS.filter(l => f === 'all' || l.fase.toLowerCase() === f);
    return `${H.voorbeeldBanner()}
    ${H.kpis([
      { c: 'teal',    icon: I.users,  label: 'Actieve leads',       val: '124', hi: 1, trend: H.trend('+12 deze week', true) },
      { c: 'emerald', icon: I.target, label: 'Conversie 30d',       val: '18%',      sub: 'lead → klant' },
      { c: 'blue',    icon: I.mail,   label: 'Openstaand contact',  val: '31',       sub: 'wacht op response' },
      { c: 'violet',  icon: I.trend,  label: 'Gem. leadscore',      val: '71',       sub: 'op 100' },
    ])}
    ${H.toolbar([
      H.chips('lead-fase', [
        { l: 'Alle', v: 'all' },
        { l: 'Nieuw', v: 'nieuw' },
        { l: 'Contact', v: 'contact' },
        { l: 'Kwalificatie', v: 'kwalificatie' },
        { l: 'Offerte', v: 'offerte' },
      ], f),
      H.search('Zoek lead…'),
      `<div class="tb-right"><button class="btn btn-primary" onclick="__leadsNotice('Nieuwe lead')">${svg(I.plus)}Nieuwe lead</button></div>`,
    ])}
    ${H.table(
      [{ l: 'Naam' }, { l: 'Bron', cls: 'optional' }, { l: 'Fase' }, { l: 'Score', cls: 'r' }, { l: 'Laatst', cls: 'optional' }, { l: 'Eigenaar', cls: 'optional' }],
      rows.map(l => [
        `<div class="cell-main-wrap"><div class="av av-sm">${H.av(l.naam)}</div><span class="cell-main">${l.naam}</span></div>`,
        `<span class="pill pill-neutral">${l.bron}</span>`,
        H.pill(FASE_TO_PILL[l.fase] || 'neutral', l.fase),
        `<span class="mono ${l.score >= 80 ? 'strong' : ''}">${l.score}</span>`,
        `<span style="font-size:12.5px;color:var(--text-3)">${l.laatst}</span>`,
        `<span style="font-size:12.5px;color:var(--text-3)">${l.eig}</span>`,
      ])
    )}`;
  }

  function archiefView() {
    const f = F('lead-arch', 'all');
    const rows = ARCHIEF.filter(a => f === 'all' || a.reden.toLowerCase().replace(/\s+/g, '-') === f);
    return `${H.voorbeeldBanner()}
    ${H.toolbar([
      H.chips('lead-arch', [
        { l: 'Alle',            v: 'all' },
        { l: 'Geen interesse',  v: 'geen-interesse' },
        { l: 'Onbereikbaar',    v: 'onbereikbaar' },
        { l: 'Duplicaat',       v: 'duplicaat' },
        { l: 'Prijs',           v: 'prijs' },
        { l: 'Doorgestroomd',   v: 'doorgestroomd' },
      ], f),
      H.search('Zoek in archief…'),
      `<div class="tb-right"><button class="btn" onclick="__leadsNotice('Exporteer archief')">${svg(I.download)}Exporteer</button></div>`,
    ])}
    ${H.table(
      [{ l: 'Naam' }, { l: 'Bron', cls: 'optional' }, { l: 'Reden' }, { l: 'Gearchiveerd', cls: 'optional' }, { l: 'Eigenaar', cls: 'optional' }],
      rows.map(a => [
        `<div class="cell-main-wrap"><div class="av av-sm">${H.av(a.naam)}</div><span class="cell-main">${a.naam}</span></div>`,
        `<span class="pill pill-neutral">${a.bron}</span>`,
        H.pill(REDEN_TO_PILL[a.reden] || 'neutral', a.reden),
        `<span class="mono" style="font-size:12.5px;color:var(--text-3)">${a.datum}</span>`,
        `<span style="font-size:12.5px;color:var(--text-3)">${a.eig}</span>`,
      ])
    )}`;
  }

  window.DFO.VIEWS['leads/Actief'] = actiefView;
  window.DFO.VIEWS['leads/Gearchiveerd'] = archiefView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('leads');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('leads');
  console.debug('[leads-v2] registered 2 views (dormant)');
})();
