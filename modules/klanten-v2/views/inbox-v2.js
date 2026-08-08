// A2 — Inbox (centrale WhatsApp/E-mail-inbox)
// Scaffold uit systeemprototype-v45.html (master-detail met kanaal-chips
// + gesprekkenlijst + open thread). Mock-data.

(function () {
  if (!window.DFO) return;
  const { I, svg, F } = window.DFO;
  const { av, pill, previewBadge, chips } = window.V2Shared || {};
  if (!av) { console.error('[inbox-v2] V2Shared niet geladen'); return; }

  const GESPREKKEN = [
    { naam: 'Muno Dahir',                tijd: '41m',      prev: 'Ik stuur de betaling vandaag door 👍', ongelezen: 2, open: 600,     kanaal: 'WhatsApp' },
    { naam: 'Ebenezer Adjei',            tijd: '2u',       prev: 'Gecondoleerd met het verlies van je oma', ongelezen: 0, open: 7199.99, kanaal: 'WhatsApp' },
    { naam: 'Christa Noltus Haarkamp',   tijd: '3u',       prev: 'Herinnering verstuurd', ongelezen: 1, open: 300,     kanaal: 'WhatsApp' },
    { naam: 'Iwan Engelbracht',          tijd: '4u',       prev: 'Ik geef door dat je vandaag betaalt', ongelezen: 0, open: 2400,    kanaal: 'WhatsApp' },
    { naam: 'Alexandre Jansen Da silva', tijd: '1d',       prev: 'Hoi, hopelijk gaat alles goed?', ongelezen: 1, open: 2000,    kanaal: 'E-mail' },
    { naam: 'Guman Logistics',           tijd: '1d',       prev: 'Ik geef door dat je vrijdag betaalt', ongelezen: 0, open: 99.99,   kanaal: 'WhatsApp' },
  ];

  window.DFO.VIEWS['inbox/'] = () => {
    const kan = F('kanaal', 'alle');
    const filtered = kan === 'alle' ? GESPREKKEN : GESPREKKEN.filter(g => g.kanaal.toLowerCase() === kan);
    return `${previewBadge()}
      <div style="display:grid;grid-template-columns:340px 1fr;gap:0;height:calc(100vh - 160px);border:1px solid var(--border);border-radius:var(--r);margin:14px 20px;overflow:hidden;background:var(--surface)">
        <div style="border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden;background:var(--surface-2)">
          <div style="padding:12px 14px;border-bottom:1px solid var(--border);display:flex;gap:6px;flex-wrap:wrap">
            ${['alle', 'whatsapp', 'e-mail'].map(k => `<button class="chip ${kan === k ? 'on' : ''}" style="font-size:11.5px" onclick="DFO.setF('kanaal','${k}')">${k[0].toUpperCase() + k.slice(1)}</button>`).join('')}
          </div>
          <div style="flex:1;overflow-y:auto;padding:6px">
            ${filtered.map((g, i) => `<div style="padding:11px 12px;border-radius:8px;display:flex;gap:10px;align-items:flex-start;cursor:pointer;margin-bottom:2px;transition:background .12s;${i === 0 ? 'background:var(--surface)' : ''}"
              onmouseover="this.style.background='var(--surface)'" onmouseout="this.style.background='${i === 0 ? 'var(--surface)' : 'transparent'}'">
              ${av(g.naam, 34)}
              <div style="flex:1;min-width:0">
                <div style="display:flex;justify-content:space-between;align-items:baseline;gap:6px">
                  <span style="font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${g.naam}</span>
                  <span style="font-size:10.5px;color:var(--text-3);flex-shrink:0">${g.tijd}</span>
                </div>
                <div style="font-size:12px;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px">${g.prev}</div>
                <div style="display:flex;gap:6px;margin-top:4px;align-items:center">
                  ${g.ongelezen ? `<span style="background:var(--rose);color:#fff;font-size:10px;font-weight:700;padding:1px 6px;border-radius:9px">${g.ongelezen}</span>` : ''}
                  ${g.open ? `<span style="font-size:10.5px;color:var(--amber);font-weight:600">€${g.open.toLocaleString('nl-NL')}</span>` : ''}
                  <span style="font-size:10px;color:var(--text-3);margin-left:auto">${g.kanaal}</span>
                </div>
              </div>
            </div>`).join('')}
          </div>
        </div>

        <div style="display:flex;flex-direction:column;overflow:hidden;background:var(--surface)">
          <div style="padding:14px 20px;border-bottom:1px solid var(--border);display:flex;gap:12px;align-items:center">
            ${av('Muno Dahir', 36)}
            <div style="flex:1"><div style="font-size:14.5px;font-weight:600">Muno Dahir</div>
              <div style="font-size:12px;color:var(--text-3)">WhatsApp · open €600 · laatste bericht 41m</div></div>
            <button class="btn btn-ghost btn-sm">${svg(I.phone)}Bellen</button>
            <button class="btn btn-ghost btn-sm">${svg(I.doc)}Dossier</button>
          </div>
          <div style="flex:1;overflow-y:auto;padding:20px 40px;background:var(--surface-2);display:flex;flex-direction:column;gap:10px">
            <div style="align-self:flex-start;max-width:70%;background:var(--surface);border:1px solid var(--border);padding:9px 13px;border-radius:12px;font-size:13.5px">Hoi Muno, we hebben je herinnering al 2 keer verstuurd. Kun je aangeven wanneer je betaalt?</div>
            <div style="align-self:flex-end;max-width:70%;background:var(--emerald-soft);border:1px solid var(--emerald-line);padding:9px 13px;border-radius:12px;font-size:13.5px">Ik stuur de betaling vandaag door 👍</div>
            <div style="align-self:flex-end;max-width:70%;background:var(--emerald-soft);border:1px solid var(--emerald-line);padding:9px 13px;border-radius:12px;font-size:13.5px">Sorry voor het wachten!</div>
          </div>
          <div style="padding:12px 20px;border-top:1px solid var(--border);display:flex;gap:8px">
            <input class="inp" style="flex:1" placeholder="Typ een bericht…"/>
            <button class="btn btn-primary">${svg(I.up)}Verstuur</button>
          </div>
        </div>
      </div>`;
  };

  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('inbox');
  else window.KV_V2_PENDING = (window.KV_V2_PENDING || []).concat('inbox');
})();
