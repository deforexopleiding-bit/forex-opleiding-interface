// B1 — Studenten (mentor-view, lijst met traject-progress)
// Uit systeemprototype-v45.html r1861-1928.

(function () {
  if (!window.DFO) return;
  const { svg, I } = window.DFO;
  const { av, pill, previewBadge, chips, search, toolbar, table } = window.V2Shared || {};
  if (!av) { console.error('[studenten-v2] V2Shared niet geladen'); return; }

  const STUDENTEN = [
    { naam: 'Cabdi Ibrahim',       traject: '12 maand 1-op-1',      voortgang: 12,  sessies: '1/24',  volgende: 'Vandaag 09:00', status: 'op schema' },
    { naam: 'Nikita Bykov',        traject: '36 maand membership',  voortgang: 45,  sessies: '9/36',  volgende: 'Vandaag 11:00', status: 'op schema' },
    { naam: 'Emile Rabaut',        traject: '6 maand 1-op-1',       voortgang: 18,  sessies: '2/12',  volgende: 'Vandaag 16:00', status: 'nieuw' },
    { naam: 'Jan Willem Bel',      traject: '12 maand 1-op-1',      voortgang: 42,  sessies: '10/24', volgende: 'Morgen 14:00',  status: 'op schema' },
    { naam: 'Dyami Van Praag',     traject: '12 maand 1-op-1',      voortgang: 22,  sessies: '5/24',  volgende: '—',             status: 'aandacht' },
    { naam: 'Christa Noltus H.',   traject: '6 maand 1-op-1',       voortgang: 41,  sessies: '4/12',  volgende: '—',             status: 'aandacht' },
    { naam: 'Jennifer Botaka',     traject: '6 maand 1-op-1',       voortgang: 18,  sessies: '2/12',  volgende: 'Verzet',        status: 'aandacht' },
  ];

  const STUDST = { 'op schema': { l: 'Op schema', c: 'ok' }, 'aandacht': { l: 'Vraagt aandacht', c: 'warn' }, 'nieuw': { l: 'Nieuw', c: 'accent' } };

  window.DFO.VIEWS['studenten/'] = () => {
    const f = window.DFO.F('sf', 'all');
    const filtered = f === 'all' ? STUDENTEN : STUDENTEN.filter(s => s.status === f);
    return `${previewBadge()}
      ${toolbar([
        chips('sf', [
          { l: 'Alle studenten', v: 'all', n: STUDENTEN.length },
          { l: 'Op schema',       v: 'op schema', n: STUDENTEN.filter(s => s.status === 'op schema').length },
          { l: 'Aandacht',        v: 'aandacht',  n: STUDENTEN.filter(s => s.status === 'aandacht').length },
          { l: 'Nieuw',           v: 'nieuw',     n: STUDENTEN.filter(s => s.status === 'nieuw').length },
        ], f),
        search('Zoek student…'),
        `<button class="btn btn-primary" style="margin-left:auto">${svg(I.plus)}Nieuwe leerling</button>`,
      ])}
      <div style="padding:0 20px">
        ${table(
          [{ l: 'Student' }, { l: 'Traject', cls: 'optional' }, { l: 'Voortgang' }, { l: 'Sessies', cls: 'optional' }, { l: 'Volgende sessie' }, { l: 'Status' }],
          filtered.map(s => [
            `<div style="display:flex;align-items:center;gap:9px">${av(s.naam, 30)}<span class="cell-main">${s.naam}</span></div>`,
            `<span class="cell-sub">${s.traject}</span>`,
            `<div style="display:flex;align-items:center;gap:8px"><div class="progress" style="flex:1;max-width:120px;height:6px"><i style="width:${s.voortgang}%;background:var(--m)"></i></div><span class="mono" style="font-size:12px;color:var(--text-3)">${s.voortgang}%</span></div>`,
            `<span class="mono" style="font-size:12.5px">${s.sessies}</span>`,
            `<span style="font-size:12.5px">${s.volgende}</span>`,
            pill(STUDST[s.status].c, STUDST[s.status].l),
          ])
        )}
      </div>`;
  };

  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('studenten');
  else window.KV_V2_PENDING = (window.KV_V2_PENDING || []).concat('studenten');
})();
