// modules/klanten-v2/views/binnenkort-v2.js
//
// Fase G — Binnenkort (layout-only). 1 view: grid met 9 kaarten van
// onderdelen die bestaan maar niet in de hoofdnav staan. 1-op-1 uit
// prototype r4416-4438. Dormant. Preview ?v2preview=binnenkort
// (rol Manager/Admin/Super admin).

(function () {
  if (!window.DFO) { console.error('[binnenkort-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[binnenkort-v2] KV_V2.helpers niet geladen.'); return; }
  const { I, svg } = window.DFO;
  const H = window.KV_V2.helpers;

  const SOON = [
    ['Nieuwsbrief',        'E-mailnieuwsbrief naar klanten en leads — planning, verzending en statistieken', I.mail,   'teal',   'In ontwikkeling'],
    ['Enquêtes',           'Stuur alle klanten een bericht met een enquête om in te vullen — vragenlijsten opstellen, versturen en resultaten inzien', I.list || I.doc, 'violet', 'In ontwikkeling'],
    ['Meta Ads',           'Campagnes, advertenties en resultaten — nog niet af',                             I.target, 'blue',   'In ontwikkeling'],
    ['Creative Studio',    'Bibliotheek van video en beeld — nog niet af',                                    I.image || I.file, 'pink',   'In ontwikkeling'],
    ['Kennisbank',         'Artikelen die Lisa en Joost voeden met kennis over jullie aanbod',                I.book || I.doc,   'teal',   'Werkt'],
    ['Control Center',     'Overzicht van systeemstatus en achtergrondtaken',                                 I.settings,        'blue',   'Werkt'],
    ['Secret Area',        'Interne documenten en afspraken',                                                 I.shield,          'slate',  'Werkt'],
    ['Vergaderruimte',     'Notulen en agenda van teamoverleg',                                               I.users,           'violet', 'Werkt'],
    ['Simon / Leon / Aron','Experimentele AI-assistenten',                                                    I.bot,             'orange', 'Experiment'],
  ];
  const STATUS_TO_PILL = { 'Werkt': 'ok', 'In ontwikkeling': 'info', 'Experiment': 'warn' };

  window.__soonNotice = (n) => { console.info('[binnenkort-v2] ' + n); try { alert(n + ' — wordt geopend in het bestaande scherm.'); } catch (_) {} };

  function soonView() {
    return `${H.voorbeeldBanner()}
      <div class="soon-intro">
        <div class="soon-intro-t">Binnenkort</div>
        <div class="soon-intro-d">Deze onderdelen bestaan wel, maar staan niet in de hoofdnavigatie — omdat ze nog niet af zijn of zelden gebruikt worden. Je kunt ze hier openen wanneer je ze nodig hebt.</div>
      </div>
      <div class="soon-grid">
        ${SOON.map(([n, d, ic, c, s]) => `
          <button class="soon-card" onclick="__soonNotice('${n.replace(/'/g, "\\'")}')">
            <div class="soon-card-head">
              <span class="tile-ico" style="background:var(--${c}-soft,var(--surface-2));color:var(--${c},var(--brand))">${svg(ic)}</span>
              <div class="soon-card-title">${n}</div>
            </div>
            <div class="soon-card-desc">${d}</div>
            ${H.pill(STATUS_TO_PILL[s] || 'neutral', s)}
          </button>`).join('')}
      </div>`;
  }

  window.DFO.VIEWS['binnenkort/'] = soonView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('binnenkort');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('binnenkort');
  console.debug('[binnenkort-v2] registered 1 view (dormant)');
})();
