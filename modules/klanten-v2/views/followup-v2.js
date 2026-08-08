// B4 — Follow-up (Werklijst / Event-bellijst / Opvolglijst / Retenties /
// Afspraken / Sluimerpot / Statistieken / Afgeboekt)
// Scaffold uit systeemprototype-v45.html r2844-3200 — 8 tabs.
// Layout-referentie voor elke tab. Volle prototype-parity per tab in vervolg-PR.

(function () {
  if (!window.DFO) return;
  const { svg, I } = window.DFO;
  const { av, pill, previewBadge, kpis, toolbar, search, chips, table } = window.V2Shared || {};
  if (!av) { console.error('[followup-v2] V2Shared niet geladen'); return; }

  const LEADS = [
    { naam: 'Sander Pieters',  bron: 'Meta Ads',   tel: '+31 6 11223344', traject: '7-daagse', poging: 1, laatste: '2u geleden' },
    { naam: 'Miriam Osei',     bron: 'Event Gent', tel: '+32 478 99 11 22', traject: 'Masterclass', poging: 0, laatste: '—' },
    { naam: 'Kevin Braams',    bron: 'Website',    tel: '+31 6 55667788', traject: '7-daagse',   poging: 2, laatste: 'gisteren' },
    { naam: 'Ayla Demir',      bron: 'Meta Ads',   tel: '+31 6 99887766', traject: 'Masterclass', poging: 1, laatste: '4u geleden' },
    { naam: 'Tom Verheyen',    bron: 'Instagram',  tel: '+32 495 11 22 33', traject: '7-daagse', poging: 0, laatste: '—' },
  ];

  function workList() {
    return `${previewBadge()}
      ${kpis([
        { c: 'amber',   icon: I.phone, label: 'Te bellen vandaag', val: '12', hi: 1, sub: '7 warm · 5 cold' },
        { c: 'emerald', icon: I.check2, label: 'Gedaan vandaag',    val: '8',  sub: '3 gekwalificeerd' },
        { c: 'rose',    icon: I.alert, label: 'Overdue',            val: '3',  hi: 1, sub: 'sinds gisteren' },
        { c: 'blue',    icon: I.target, label: 'Conversie',         val: '38%', sub: 'laatste 7 dagen' },
      ])}
      ${toolbar([
        chips('bron', [
          { l: 'Alle',       v: 'all', n: LEADS.length },
          { l: 'Meta Ads',   v: 'meta', n: 2 },
          { l: 'Event',      v: 'event', n: 1 },
          { l: 'Website',    v: 'web', n: 1 },
          { l: 'Instagram',  v: 'ig', n: 1 },
        ], window.DFO.F('bron', 'all')),
        search('Zoek lead…'),
        `<button class="btn btn-primary" style="margin-left:auto">${svg(I.phone)}Start bellen</button>`,
      ])}
      <div style="padding:0 20px">
        ${table(
          [{ l: 'Lead' }, { l: 'Bron' }, { l: 'Traject', cls: 'optional' }, { l: 'Poging' }, { l: 'Laatste contact' }, { l: 'Actie' }],
          LEADS.map(l => [
            `<div style="display:flex;align-items:center;gap:9px">${av(l.naam, 30)}<div><div class="cell-main">${l.naam}</div><div class="cell-sub mono" style="font-size:11px">${l.tel}</div></div></div>`,
            pill('accent', l.bron),
            `<span class="cell-sub">${l.traject}</span>`,
            `<span class="mono" style="font-size:12.5px">${l.poging}</span>`,
            `<span style="font-size:12px;color:var(--text-3)">${l.laatste}</span>`,
            `<button class="btn btn-ghost btn-sm">${svg(I.phone)}Bel</button>`,
          ])
        )}
      </div>`;
  }

  const genericTab = (title, sub) => `${previewBadge()}
    <div style="padding:32px 20px">
      <div class="card" style="padding:32px;text-align:center">
        <div class="tile-ico" style="width:48px;height:48px;margin:0 auto 12px;background:var(--m-soft);color:var(--m)">${svg(I.repeat, 'width:22px;height:22px')}</div>
        <div style="font-size:16px;font-weight:600;margin-bottom:4px">${title}</div>
        <div style="font-size:12.5px;color:var(--text-3);max-width:420px;margin:0 auto">${sub}</div>
      </div>
    </div>`;

  window.DFO.VIEWS['followup/Werklijst']       = workList;
  window.DFO.VIEWS['followup/Event-bellijst']  = () => genericTab('Event-bellijst', 'Aparte bellijst voor leads uit events (aparte kadans + script). Layout uit prototype r3005 — volle render in vervolg-PR.');
  window.DFO.VIEWS['followup/Opvolglijst']     = () => genericTab('Opvolglijst', 'Warme leads met vervolg-afspraak. Toont volgende contact-moment + laatste notitie. Uit prototype r3029.');
  window.DFO.VIEWS['followup/Retenties']       = () => genericTab('Retenties', 'Klanten met eindigend abonnement, retentie-status per rij. KPI-strip + tabel. Uit prototype r3048.');
  window.DFO.VIEWS['followup/Afspraken']       = () => genericTab('Afspraken', 'Kalender-view van geplande afspraken (Zoom + fysiek). Uit prototype r3069.');
  window.DFO.VIEWS['followup/Sluimerpot']      = () => genericTab('Sluimerpot', 'Leads waar we ≥6 wk niks van horen — herwakker-flow. Uit prototype r3097.');
  window.DFO.VIEWS['followup/Statistieken']    = () => genericTab('Statistieken', 'Belresultaten + conversie per bron/traject/eigenaar. Uit prototype r3114.');
  window.DFO.VIEWS['followup/Afgeboekt']       = () => genericTab('Afgeboekt', 'Verloren leads met reden. Uit prototype r3153.');
  window.DFO.VIEWS['followup/']                = workList;

  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('followup');
  else window.KV_V2_PENDING = (window.KV_V2_PENDING || []).concat('followup');
})();
