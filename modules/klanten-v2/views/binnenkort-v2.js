// modules/klanten-v2/views/binnenkort-v2.js
//
// Fase G — Binnenkort. NAVIGATIE-INDEX (geen data-koppeling nodig).
// 1 view: grid met 9 kaarten van onderdelen die bestaan maar niet in de
// hoofdnav staan. Preview ?v2preview=binnenkort (rol Manager/Admin/Super admin).
//
// Deze data-ronde: polish. 4 "Werkt"-items krijgen deep-links naar hun
// v1-pagina zodat de knop iets meer doet dan een alert. Overige items
// blijven __soonNotice-stubs (nog in ontwikkeling / experiment).
//
// Er zijn en komen geen data-endpoints: dit is puur een verwijs-pagina.

(function () {
  if (!window.DFO) { console.error('[binnenkort-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[binnenkort-v2] KV_V2.helpers niet geladen.'); return; }
  const { I, svg } = window.DFO;
  const H = window.KV_V2.helpers;

  // v1-deep-links voor items met status 'Werkt' — knop opent de bestaande
  // v1-pagina in een nieuw tabblad. Voor "In ontwikkeling" / "Experiment"
  // blijft het een alert-stub (nog geen echte target).
  const SOON = [
    ['Nieuwsbrief',        'E-mailnieuwsbrief naar klanten en leads — planning, verzending en statistieken', I.mail,   'teal',   'In ontwikkeling', null],
    ['Enquêtes',           'Stuur alle klanten een bericht met een enquête om in te vullen — vragenlijsten opstellen, versturen en resultaten inzien', I.list || I.doc, 'violet', 'In ontwikkeling', null],
    ['Meta Ads',           'Campagnes, advertenties en resultaten — nog niet af',                             I.target, 'blue',   'In ontwikkeling', '/modules/meta-ads.html'],
    ['Creative Studio',    'Bibliotheek van video en beeld — nog niet af',                                    I.image || I.file, 'pink',   'In ontwikkeling', '/modules/studio.html'],
    ['Kennisbank',         'Artikelen die Lisa en Joost voeden met kennis over jullie aanbod',                I.book || I.doc,   'teal',   'Werkt', '/modules/kennisbank.html'],
    ['Control Center',     'Overzicht van systeemstatus en achtergrondtaken',                                 I.settings,        'blue',   'Werkt', '/modules/control-center.html'],
    ['Secret Area',        'Interne documenten en afspraken',                                                 I.shield,          'slate',  'Werkt', '/modules/secret-area.html'],
    ['Vergaderruimte',     'Notulen en agenda van teamoverleg',                                               I.users,           'violet', 'Werkt', '/modules/meetings.html'],
    ['Simon / Leon / Aron','Experimentele AI-assistenten',                                                    I.bot,             'orange', 'Experiment', null],
  ];
  const STATUS_TO_PILL = { 'Werkt': 'ok', 'In ontwikkeling': 'info', 'Experiment': 'warn' };

  window.__soonNotice = (n) => { console.info('[binnenkort-v2] ' + n); try { alert(n + ' — nog niet af (In ontwikkeling / Experiment).'); } catch (_) {} };
  window.__soonOpen = (url) => { if (url) window.open(url, '_blank'); };

  function soonView() {
    return `${H.voorbeeldBanner()}
      <div class="soon-intro">
        <div class="soon-intro-t">Binnenkort</div>
        <div class="soon-intro-d">Deze onderdelen bestaan wel, maar staan niet in de hoofdnavigatie — omdat ze nog niet af zijn of zelden gebruikt worden. Je kunt ze hier openen wanneer je ze nodig hebt.</div>
      </div>
      <div class="soon-grid">
        ${SOON.map(([n, d, ic, c, s, url]) => {
          const handler = url
            ? `__soonOpen('${String(url).replace(/'/g, "\\'")}')`
            : `__soonNotice('${n.replace(/'/g, "\\'")}')`;
          return `
          <button class="soon-card" onclick="${handler}">
            <div class="soon-card-head">
              <span class="tile-ico" style="background:var(--${c}-soft,var(--surface-2));color:var(--${c},var(--brand))">${svg(ic)}</span>
              <div class="soon-card-title">${n}</div>
            </div>
            <div class="soon-card-desc">${d}</div>
            ${H.pill(STATUS_TO_PILL[s] || 'neutral', s)}${url ? ` <span style="font-size:11px;color:var(--text-3);margin-left:6px">↗ opent in nieuw tab</span>` : ''}
          </button>`;
        }).join('')}
      </div>`;
  }

  window.DFO.VIEWS['binnenkort/'] = soonView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('binnenkort');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('binnenkort');
  console.debug('[binnenkort-v2] registered 1 view (dormant)');
})();
