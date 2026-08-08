// A3 — Takenbeheer (Mijn taken / Team / Afgerond)
// Kanban-scaffold uit systeemprototype-v45.html met mock-taken.
// Bestaande watchers/attachments (T2/T3-endpoints) blijven werken zodra
// we detail-modal aan deze view hangen — dat is de volgende stap.

(function () {
  if (!window.DFO) return;
  const { I, svg } = window.DFO;
  const { av, pill, previewBadge } = window.V2Shared || {};
  if (!av) { console.error('[taken-v2] V2Shared niet geladen'); return; }

  const TAKEN = [
    { id: 1, titel: 'Bel Ebenezer Adjei — betaalafspraak', oms: 'Klant belde over de openstaande factuur. Betaalregeling in 3 termijnen voorstellen.', van: 'Wanbetalers', klant: 'Ebenezer Adjei', deadline: 'Vandaag', prio: 'hoog', status: 'todo', eigenaar: 'Jeffrey', cc: ['Amigo'] },
    { id: 2, titel: 'WIK-brief printen (4 stuks)', oms: '', van: 'Wanbetalers', klant: '', deadline: 'Vandaag', prio: 'hoog', status: 'todo', eigenaar: 'Amigo', cc: [] },
    { id: 3, titel: 'Offerte Rachael Njoki afmaken', oms: 'Traject 6 maand 1-op-1 doorrekenen en versturen.', van: 'Sales', klant: 'Rachael Njoki', deadline: 'Morgen', prio: 'midden', status: 'bezig', eigenaar: 'Jeffrey', cc: ['Joost'] },
    { id: 4, titel: 'Sessie voorbereiden — groep 4', oms: 'Marktstructuur-materiaal klaarzetten.', van: 'LMS', klant: '', deadline: 'Morgen', prio: 'midden', status: 'bezig', eigenaar: 'Dave', cc: ['Joost'] },
    { id: 5, titel: 'Facturen augustus controleren', oms: '', van: 'Finance', klant: '', deadline: '8 aug', prio: 'laag', status: 'todo', eigenaar: 'Amigo', cc: [] },
    { id: 6, titel: 'Nabellen leads Meta Ads', oms: 'Batch van 12 leads van gisteren opvolgen.', van: 'Leads', klant: '', deadline: 'Vandaag', prio: 'midden', status: 'todo', eigenaar: 'Joost', cc: [] },
    { id: 7, titel: 'Event Gent — aanwezigheidslijst', oms: '', van: 'Events', klant: '', deadline: '7 aug', prio: 'laag', status: 'bezig', eigenaar: 'Simone', cc: ['Joost', 'Jeffrey'] },
  ];

  const prioColor = (p) => p === 'hoog' ? 'rose' : p === 'midden' ? 'amber' : 'slate';

  function kanbanCard(t) {
    return `<div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);padding:12px 13px;margin-bottom:8px;cursor:pointer;transition:all .15s"
      onmouseover="this.style.borderColor='var(--border-strong)';this.style.transform='translateY(-1px)'"
      onmouseout="this.style.borderColor='var(--border)';this.style.transform='none'">
      <div style="display:flex;align-items:flex-start;gap:6px;margin-bottom:6px">
        <span class="legend-dot" style="background:var(--${prioColor(t.prio)});margin-top:5px"></span>
        <span style="font-size:13px;font-weight:500;line-height:1.35;flex:1">${t.titel}</span>
      </div>
      ${t.oms ? `<div style="font-size:11.5px;color:var(--text-3);margin-bottom:8px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${t.oms}</div>` : ''}
      <div style="display:flex;align-items:center;gap:8px;font-size:11px;color:var(--text-3);flex-wrap:wrap">
        <span style="background:var(--surface-2);padding:2px 7px;border-radius:9px">${t.van}</span>
        ${t.klant ? `<span>· ${t.klant}</span>` : ''}
        <span style="margin-left:auto;color:${t.deadline === 'Vandaag' ? 'var(--rose)' : 'var(--text-3)'};font-weight:${t.deadline === 'Vandaag' ? '600' : '400'}">${t.deadline}</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px;margin-top:8px">
        ${av(t.eigenaar, 22)}
        <span style="font-size:11.5px;color:var(--text-2)">${t.eigenaar}</span>
        ${t.cc.length ? `<span style="font-size:10.5px;color:var(--text-3);margin-left:auto">CC: ${t.cc.join(', ')}</span>` : ''}
      </div>
    </div>`;
  }

  function kanbanColumn(title, status, count, headerColor) {
    const items = TAKEN.filter(t => t.status === status);
    return `<div style="background:var(--surface-2);border-radius:var(--r);padding:12px;display:flex;flex-direction:column;min-height:60vh">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;padding:0 4px">
        <span class="title-dot" style="background:var(--${headerColor});box-shadow:0 0 0 3px var(--${headerColor}-soft)"></span>
        <span style="font-size:12.5px;font-weight:600;text-transform:uppercase;letter-spacing:.05em">${title}</span>
        <span style="font-size:11px;color:var(--text-3);background:var(--surface);padding:1px 8px;border-radius:9px;font-weight:600">${count}</span>
      </div>
      <div style="flex:1;overflow-y:auto">${items.map(kanbanCard).join('')}</div>
    </div>`;
  }

  const kanbanView = () => `${previewBadge()}
    <div style="padding:14px 20px 20px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
        <button class="chip on">Kanban</button>
        <button class="chip">Lijst</button>
        <button class="btn btn-ghost btn-sm" style="margin-left:auto">${svg(I.plus)}Nieuwe taak</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
        ${kanbanColumn('Te doen', 'todo', TAKEN.filter(t => t.status === 'todo').length, 'rose')}
        ${kanbanColumn('Bezig', 'bezig', TAKEN.filter(t => t.status === 'bezig').length, 'amber')}
        ${kanbanColumn('Afgerond', 'done', 0, 'emerald')}
      </div>
    </div>`;

  window.DFO.VIEWS['taken/Mijn taken'] = kanbanView;
  window.DFO.VIEWS['taken/Team']       = kanbanView;
  window.DFO.VIEWS['taken/Afgerond']   = kanbanView;
  window.DFO.VIEWS['taken/']           = kanbanView;

  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('taken');
  else window.KV_V2_PENDING = (window.KV_V2_PENDING || []).concat('taken');
})();
