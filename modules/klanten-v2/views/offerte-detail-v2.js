// modules/klanten-v2/views/offerte-detail-v2.js
//
// V2 offerte-detail als IN-SHELL view binnen klanten-v2. Iframe-embed van
// de bestaande standalone /modules/offerte-detail-v2.html?id=X&embed=1 —
// hergebruikt 100% van de detail-logica/HTML/JS zonder duplicatie. Iframe
// vult de content-area; sidebar + topbar van klanten-v2 blijven zichtbaar
// en interactief.
//
// URL-contract: ?v2preview=sales&deal_id=<uuid>. Sales-v2 offertes-view
// detecteert deal_id en delegeert naar deze module (window.__odvRender).
//
// Navigatie:
//   - __odvOpen(dealId)  : pushState + DFO.render → mount iframe.
//   - __odvBack()        : pushState (strip deal_id) + DFO.render → terug
//                          naar de offertes-lijst binnen dezelfde shell.
//   - __odvHandleNav(url): callback vanuit het iframe (via parent.__odvHandleNav)
//                          wanneer de detail-pagina een side-effect-navigatie
//                          wil (delete-success, copy-success). Blijft in
//                          shell tenzij een externe URL wordt aangevraagd.

(function () {
  if (!window.DFO) { console.error('[odv-shell] DFO shell niet geladen.'); return; }

  // URL-utility: leest deal_id uit huidige location.
  function _dealIdFromURL() {
    try { return new URLSearchParams(location.search).get('deal_id') || null; }
    catch (_) { return null; }
  }

  // Iframe-HTML voor content-area. Height start bij een min (voorkomt 0-px
  // flits vóór het eerste odv-resize-bericht), en groeit dan mee met de
  // content-hoogte die het iframe post via postMessage {type:'odv-resize'}.
  // Shell-scrollcontainer (klanten-v2 #content) scrollt zelf → geen dubbele
  // scrollbar, geen afgekapte content.
  window.__odvRender = function (dealId) {
    const id = String(dealId || '').trim();
    if (!id) return `<div style="padding:24px;color:var(--rose,#C22B3E)">Geen offerte-id in URL.</div>`;
    const src = '/modules/offerte-detail-v2.html?id=' + encodeURIComponent(id) + '&embed=1';
    return `<iframe class="odv-shell-frame"
      src="${src}"
      title="Offerte-detail"
      loading="eager"
      scrolling="no"
      style="width:100%;min-height:400px;border:0;background:transparent;display:block"
      allow="clipboard-write"
    ></iframe>`;
  };

  // Message-listener: iframe post {type:'odv-resize', h:<px>} bij load + elke
  // DOM/layout-verandering (ResizeObserver + MutationObserver op body). Wij
  // zetten iframe.style.height = h zodat de shell zelf scrollt. Registreer 1x
  // (idempotent via _odvMsgBound flag) — iframe DOM-node kan bij re-render
  // vervangen worden; we selecteren telkens de huidige .odv-shell-frame.
  if (!window._odvMsgBound) {
    window._odvMsgBound = true;
    window.addEventListener('message', (e) => {
      const d = e && e.data;
      if (!d || d.type !== 'odv-resize') return;
      // Bescherming: alleen accept vanaf same-origin (parent en iframe zijn
      // beide op dezelfde host — anders kan een iframe uit een andere origin
      // ons layout messen).
      if (e.origin && e.origin !== location.origin) return;
      const h = Math.max(200, Math.min(20000, Number(d.h) || 0));
      const frame = document.querySelector('.odv-shell-frame');
      if (frame) frame.style.height = h + 'px';
    });
  }

  // Open detail in-shell: URL pushen + DFO re-renderen. De sales-v2 offertes-
  // view leest de nieuwe URL en delegeert naar __odvRender.
  window.__odvOpen = function (dealId) {
    if (!dealId) return;
    const url = new URL(location.href);
    url.searchParams.set('deal_id', String(dealId));
    // Zorg dat de v2preview op sales blijft staan zodat de shell in sales-
    // module blijft (Offertes-tab is default in sales-v2).
    if (!url.searchParams.has('v2preview')) url.searchParams.set('v2preview', 'sales');
    history.pushState({}, '', url.toString());
    // Force sales-module + Offertes-tab zodat de view daadwerkelijk rendert.
    try { window.DFO.goMod && window.DFO.goMod('sales'); } catch (_) {}
    try { window.DFO.goTab && window.DFO.goTab('Offertes'); } catch (_) {}
    window.DFO.render();
  };

  // Terug naar de offertes-lijst (verwijder deal_id uit URL + render).
  window.__odvBack = function () {
    const url = new URL(location.href);
    url.searchParams.delete('deal_id');
    history.pushState({}, '', url.toString());
    window.DFO.render();
  };

  // Callback vanuit de iframe (detail-pagina) voor navigate-side-effects.
  // Als de URL een offerte-detail-v2.html is (bv. na copy-success → nieuwe
  // deal), open die in-shell. Anders: standaard back naar sales.
  window.__odvHandleNav = function (url) {
    if (typeof url !== 'string' || !url) { window.__odvBack(); return; }
    // /modules/offerte-detail-v2.html?id=X → open in-shell.
    const m = url.match(/\/modules\/offerte-detail-v2\.html\?id=([^&]+)/);
    if (m && m[1]) { window.__odvOpen(decodeURIComponent(m[1])); return; }
    // /modules/klanten-v2/?v2preview=sales → terug naar lijst.
    if (/\/modules\/klanten-v2\//.test(url)) { window.__odvBack(); return; }
    // Fallback: externe URL (bv. subscription-wizard) → volledige page-nav
    // want dat is een aparte flow buiten v2-shell.
    window.location.href = url;
  };

  // popstate: browser back/forward → re-render zodat de detail-view komt/gaat
  // op basis van huidige URL (?deal_id=X aanwezig of niet).
  window.addEventListener('popstate', () => {
    try { window.DFO.render(); } catch (_) {}
  });

  // Debug-log zodat we weten dat deze view mount.
  console.debug('[odv-shell] loaded — window.__odvOpen/back/render/HandleNav beschikbaar');
})();
