// modules/klanten-v2/views/binnenkort-v2.js
//
// Binnenkort-pagina — landing/index met WERKENDE deep-links naar bestaande
// modules die (nog) niet in de v2-hoofdnav staan. Geen data-fetch; puur
// een navigatie-hub. Kaarten met 'Werkt'/'Experiment' openen de bestaande
// v1-pagina in een NIEUW tabblad (target=_blank + rel=noopener) — dat
// bypassed de v2-router volledig en voorkomt de goTab-reset-bug die de
// Overige-hub en de voicememo-knop eerder trof.
//
// Router-veilig patroon: <a href="..." target="_blank" rel="noopener">.
// Modules die nog "In ontwikkeling" zijn krijgen géén klik — puur een
// nette placeholder-kaart met pill "In ontwikkeling" (geen doodlopende
// alert).
//
// Dormant — binnenkort NIET in V2_ACTIVE_ALLOWLIST. Preview via
// ?v2preview=binnenkort.

(function () {
  if (!window.DFO) { console.error('[binnenkort-v2] DFO shell niet geladen.'); return; }
  if (!window.KV_V2 || !window.KV_V2.helpers) { console.error('[binnenkort-v2] KV_V2.helpers niet geladen.'); return; }
  const { I, svg } = window.DFO;
  const H = window.KV_V2.helpers;

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  // Mapping status -> pill-color.
  const STATUS_TO_PILL = { 'Werkt': 'ok', 'In ontwikkeling': 'info', 'Experiment': 'warn' };

  // Deep-links per module. `href` = null → onklikbaar (nog niet af).
  // Bewuste keuze: werkende modules open we in een NIEUW tabblad zodat de
  // v2-shell in het huidige tabblad blijft staan (geen router-hop nodig,
  // geen tab-reset-risico). Externe URL → target=_blank + rel=noopener.
  const SOON = [
    {
      n: 'Kennisbank',
      d: 'Artikelen die Lisa en Joost voeden met kennis over jullie aanbod',
      ic: I.book || I.doc,
      c: 'teal',
      s: 'Werkt',
      href: '/modules/kennisbank.html',
    },
    {
      n: 'Control Center',
      d: 'Approvals + audit-log — overzicht van systeemstatus en achtergrondtaken',
      ic: I.settings,
      c: 'blue',
      s: 'Werkt',
      href: '/modules/control-center.html',
    },
    {
      n: 'Vergaderruimte',
      d: 'Multi-agent vergaderingen, notulen en agenda',
      ic: I.users,
      c: 'violet',
      s: 'Werkt',
      href: '/modules/meetings.html',
    },
    {
      n: 'Secret Area',
      d: 'Interne documenten, afspraken en experimenten',
      ic: I.shield,
      c: 'slate',
      s: 'Werkt',
      href: '/modules/secret-area.html',
    },
    {
      n: 'Meta Ads',
      d: 'Campagnes, advertenties en resultaten (v1)',
      ic: I.target,
      c: 'blue',
      s: 'Werkt',
      href: '/modules/meta-ads.html',
    },
    {
      n: 'Creative Studio',
      d: 'Meta Ads Studio — bibliotheek van video en beeld',
      ic: I.image || I.file,
      c: 'pink',
      s: 'Werkt',
      href: '/modules/meta-ads-studio.html',
    },
    {
      n: 'Simon / Leon / Aron',
      d: 'Experimentele AI-assistenten — 1-op-1 chat',
      ic: I.bot,
      c: 'orange',
      s: 'Experiment',
      href: '/modules/agents.html',
    },
    {
      n: 'Nieuwsbrief',
      d: 'E-mailnieuwsbrief naar klanten en leads — planning, verzending en statistieken',
      ic: I.mail,
      c: 'teal',
      s: 'In ontwikkeling',
      href: null,
    },
    {
      n: 'Enquêtes',
      d: 'Stuur alle klanten een bericht met een enquête om in te vullen — vragenlijsten opstellen, versturen en resultaten inzien',
      ic: I.list || I.doc,
      c: 'violet',
      s: 'In ontwikkeling',
      href: null,
    },
  ];

  function soonView() {
    return `${H.voorbeeldBanner()}
      <div class="soon-intro">
        <div class="soon-intro-t">Binnenkort</div>
        <div class="soon-intro-d">Deze onderdelen bestaan buiten de v2-hoofdnavigatie — omdat ze zelden gebruikt worden, of nog in ontwikkeling zijn. Werkende links openen in een nieuw tabblad zodat je hier terug kunt komen.</div>
      </div>
      <div class="soon-grid">
        ${SOON.map((item) => {
          const pill = H.pill(STATUS_TO_PILL[item.s] || 'neutral', item.s);
          const inner = `
            <div class="soon-card-head">
              <span class="tile-ico" style="background:var(--${item.c}-soft,var(--surface-2));color:var(--${item.c},var(--brand))">${svg(item.ic)}</span>
              <div class="soon-card-title">${esc(item.n)}${item.href ? ' ↗' : ''}</div>
            </div>
            <div class="soon-card-desc">${esc(item.d)}</div>
            ${pill}
          `;
          if (item.href) {
            return `<a class="soon-card" href="${esc(item.href)}" target="_blank" rel="noopener" title="Opent ${esc(item.n)} in een nieuw tabblad">${inner}</a>`;
          }
          // Placeholder (nog niet af): geen klik, aria-disabled voor screenreaders.
          return `<div class="soon-card" role="group" aria-disabled="true" style="opacity:.72;cursor:default" title="${esc(item.n)} — nog niet af, wordt geopend zodra ontwikkeling klaar is">${inner}</div>`;
        }).join('')}
      </div>`;
  }

  window.DFO.VIEWS['binnenkort/'] = soonView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('binnenkort');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('binnenkort');
  console.debug('[binnenkort-v2] v=2 — landing/index met echte deep-links (target=_blank op werkende items; placeholders voor nog-niet-af).');
})();
