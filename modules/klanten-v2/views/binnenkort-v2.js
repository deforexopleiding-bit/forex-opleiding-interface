// modules/klanten-v2/views/binnenkort-v2.js
//
// Binnenkort-pagina — puur informatieve overzichts-landing. GEEN klikbare
// items; deze pagina laat alleen zien WAT eraan komt of wat als
// v1-module buiten de v2-hoofdnav bestaat. Voor het openen van v1-modules
// moet de gebruiker naar het v1-menu; deze pagina navigeert nergens meer
// naartoe.
//
// v=3 (2026-08-16): alle deep-links verwijderd. Alle items zijn nu
// display-only placeholder-kaarten (aria-disabled, geen <a>, geen
// target=_blank). Nieuwsbrief expliciet als 'In ontwikkeling' item
// aanwezig (was al zo sinds v=2 — geen dubbele entry).

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

  // v=3: alle items zijn display-only (geen href, geen navigatie).
  // Statussen blijven informatief: 'Werkt' = bestaat als v1-module (open via
  // v1-menu); 'In ontwikkeling' = wordt nog gebouwd; 'Experiment' = actief
  // maar wisselvallig.
  const SOON = [
    {
      n: 'Kennisbank',
      d: 'Artikelen die Lisa en Joost voeden met kennis over jullie aanbod',
      ic: I.book || I.doc,
      c: 'teal',
      s: 'Werkt',
    },
    {
      n: 'Control Center',
      d: 'Approvals + audit-log — overzicht van systeemstatus en achtergrondtaken',
      ic: I.settings,
      c: 'blue',
      s: 'Werkt',
    },
    {
      n: 'Vergaderruimte',
      d: 'Multi-agent vergaderingen, notulen en agenda',
      ic: I.users,
      c: 'violet',
      s: 'Werkt',
    },
    {
      n: 'Secret Area',
      d: 'Interne documenten, afspraken en experimenten',
      ic: I.shield,
      c: 'slate',
      s: 'Werkt',
    },
    {
      n: 'Meta Ads',
      d: 'Campagnes, advertenties en resultaten (v1)',
      ic: I.target,
      c: 'blue',
      s: 'Werkt',
    },
    {
      n: 'Creative Studio',
      d: 'Meta Ads Studio — bibliotheek van video en beeld',
      ic: I.image || I.file,
      c: 'pink',
      s: 'Werkt',
    },
    {
      n: 'Simon / Leon / Aron',
      d: 'Experimentele AI-assistenten — 1-op-1 chat',
      ic: I.bot,
      c: 'orange',
      s: 'Experiment',
    },
    {
      n: 'Nieuwsbrief',
      d: 'E-mailnieuwsbrief naar klanten en leads — planning, verzending en statistieken',
      ic: I.mail,
      c: 'teal',
      s: 'In ontwikkeling',
    },
    {
      n: 'Enquêtes',
      d: 'Stuur alle klanten een bericht met een enquête om in te vullen — vragenlijsten opstellen, versturen en resultaten inzien',
      ic: I.list || I.doc,
      c: 'violet',
      s: 'In ontwikkeling',
    },
  ];

  function soonView() {
    return `${H.voorbeeldBanner()}
      <div class="soon-intro">
        <div class="soon-intro-t">Binnenkort</div>
        <div class="soon-intro-d">Puur informatief overzicht van wat er buiten de v2-hoofdnavigatie bestaat of nog in ontwikkeling is. Deze kaarten zijn niet klikbaar.</div>
      </div>
      <div class="soon-grid">
        ${SOON.map((item) => {
          const pill = H.pill(STATUS_TO_PILL[item.s] || 'neutral', item.s);
          const inner = `
            <div class="soon-card-head">
              <span class="tile-ico" style="background:var(--${item.c}-soft,var(--surface-2));color:var(--${item.c},var(--brand))">${svg(item.ic)}</span>
              <div class="soon-card-title">${esc(item.n)}</div>
            </div>
            <div class="soon-card-desc">${esc(item.d)}</div>
            ${pill}
          `;
          // v=3: alle items zijn display-only placeholders (geen <a>, geen
          // navigatie). aria-disabled voor screenreaders.
          return `<div class="soon-card" role="group" aria-disabled="true" style="opacity:.85;cursor:default" title="${esc(item.n)} — informatief">${inner}</div>`;
        }).join('')}
      </div>`;
  }

  window.DFO.VIEWS['binnenkort/'] = soonView;
  if (typeof window.KV_V2_ADD === 'function') window.KV_V2_ADD('binnenkort');
  else (window.KV_V2_PENDING = window.KV_V2_PENDING || []).push('binnenkort');
  console.debug('[binnenkort-v2] v=3 — display-only overzicht (alle items niet-klikbaar; Nieuwsbrief + Enquêtes als "In ontwikkeling").');
})();
