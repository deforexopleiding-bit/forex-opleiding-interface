// modules/klanten-v2/views/nieuwsbrief-v2.js
//
// Fase E — Nieuwsbrief. GEEN DATA-KOPPELING MOGELIJK 2026-08-13.
//
// STATUS: greenfield. Er zijn GEEN v1-endpoints (/api/newsletter*,
// /api/mail-campaign*, /api/nieuwsbrief* — allen 0 hits) en GEEN v1-file
// (modules/newsletter.html bestaat niet). Er is wel een build-spec:
//   docs/redesign/marketing-nieuwsbrief-buildspec.md
// die opent met "deze features bestaan niet in de repo" en 3 opties
// beschrijft: (A) extern platform sync, (B) in-house tabellen bouwen,
// (C) iframe-embed van extern dashboard (~1-2u).
//
// Deze data-ronde: NEEDS JEFFREY. Behoud scaffold + banner die dit
// expliciet meldt. Zodra Jeffrey een build-optie kiest kan we koppelen.
// Preview ?v2preview=nieuwsbrief (rol Marketing).

(function () {
  if (!window.DFO) { console.error('[nieuwsbrief-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[nieuwsbrief-v2] KV_V2.helpers niet geladen.'); return; }
  const { I, svg, F } = window.DFO;
  const H = window.KV_V2.helpers;

  const NBRIEVEN = [
    { ond: 'Zomernieuws + nieuwe masterclass-data',    datum: '02-08-2026', ontvangers: 3142, open: '46%', klik: '8,2%', status: 'verzonden' },
    { ond: 'Trader-story: hoe Kevin doorbrak',          datum: '19-07-2026', ontvangers: 3098, open: '41%', klik: '7,4%', status: 'verzonden' },
    { ond: 'Marktupdate week 27',                        datum: '05-07-2026', ontvangers: 3061, open: '39%', klik: '8,1%', status: 'verzonden' },
    { ond: 'Concept — "Waarom leren duur is als je het niet doet"', datum: '—',           ontvangers: null,   open: '—',   klik: '—',   status: 'concept' },
  ];

  window.__nbNotice = (l) => { console.info('[nieuwsbrief-v2] ' + l); try { alert(l + ' — komt in de data-ronde.'); } catch (_) {} };

  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const nj = () => `<div style="margin:14px 20px 0;padding:14px 18px;border:1px solid var(--amber-line);background:var(--amber-soft);border-radius:var(--r);color:var(--amber);font-size:12.5px;line-height:1.6">
    <div style="display:flex;align-items:flex-start;gap:12px">
      <span>${svg(I.alert, 'width:16px;height:16px;flex-shrink:0;margin-top:1px')}</span>
      <div>
        <b>Needs Jeffrey — build-spec nodig</b><br>
        Deze module is <b>greenfield</b>: er zijn geen v1-endpoints en geen v1-pagina. Onderstaande KPI's + tabel zijn puur voorbeeld-layout uit het prototype.<br>
        Build-spec ligt klaar in <code>docs/redesign/marketing-nieuwsbrief-buildspec.md</code> met 3 opties (extern sync / in-house / iframe-embed). Kies er één, dan koppelen we.
      </div>
    </div>
  </div>`;

  function nbView() {
    const f = F('nf', 'all');
    return `${nj()}
    ${H.kpis([
      { c: 'teal',    icon: I.users,  label: 'Abonnees',              val: '3.142', hi: 1, sub: 'e-maillijst', trend: H.trend('+4,1%', true) },
      { c: 'emerald', icon: I.mail,   label: 'Gem. open rate',        val: '42%',         sub: 'laatste 3 nieuwsbrieven', trend: H.trend('+2%', true) },
      { c: 'blue',    icon: I.target, label: 'Gem. klikratio',        val: '7,9%',        sub: 'laatste 3 nieuwsbrieven' },
      { c: 'violet',  icon: I.send,   label: 'Verzonden dit jaar',    val: '14',          sub: '2026' },
    ])}
    ${H.toolbar([
      H.chips('nf', [{ l: 'Alles', v: 'all' }, { l: 'Verzonden', v: 'verzonden' }, { l: 'Concept', v: 'concept' }], f),
      H.search('Zoek nieuwsbrief…'),
      `<div class="tb-right"><button class="btn btn-primary" onclick="__nbNotice('Nieuwe nieuwsbrief')">${svg(I.plus)}Nieuwe nieuwsbrief</button></div>`,
    ])}
    ${H.table(
      [{ l: 'Onderwerp' }, { l: 'Verzonden', cls: 'optional' }, { l: 'Ontvangers', cls: 'r optional' }, { l: 'Open', cls: 'r' }, { l: 'Klik', cls: 'r' }, { l: 'Status' }],
      NBRIEVEN.filter(n => f === 'all' || n.status === f).map(n => [
        `<span class="cell-main">${n.ond}</span>`,
        `<span class="mono" style="font-size:12.5px;color:var(--text-3)">${n.datum}</span>`,
        `<span class="mono">${n.ontvangers ? n.ontvangers.toLocaleString('nl-NL') : '—'}</span>`,
        `<span class="mono">${n.open}</span>`,
        `<span class="mono">${n.klik}</span>`,
        n.status === 'verzonden' ? H.pill('ok', 'Verzonden') : H.pill('neutral', 'Concept'),
      ])
    )}`;
  }

  window.DFO.VIEWS['nieuwsbrief/'] = nbView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('nieuwsbrief');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('nieuwsbrief');
  console.debug('[nieuwsbrief-v2] registered 1 view (dormant)');
})();
