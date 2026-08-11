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

  // Iframe-HTML voor content-area. BULLETPROOF fallback (na auto-resize
  // race-conditions): vaste viewport-hoogte via calc(100dvh - shell-offset),
  // iframe scrollt intern (scrolling="auto"). Sidebar + topbar + tabs +
  // terug-knop-strip blijven staan; content-area IS de iframe die tot de
  // laatste regel scrollt. Geen dubbele main-scrollbar want body heeft
  // overflow:hidden (shell) én .content past exact rond de iframe.
  //
  // Offset-breakdown (klanten-v2 shell layout, gemeten):
  //   topbar        ~64px
  //   tabs-strip    ~40px
  //   preview-header + terug-knop-strip in sales-v2 offertesView ~56px
  //   totaal        ~160px — extra 20px marge = 180px voor safety.
  //
  // Op mobiel 100dvh compenseert voor address-bar dynamische hoogte.
  window.__odvRender = function (dealId) {
    const id = String(dealId || '').trim();
    if (!id) return `<div style="padding:24px;color:var(--rose,#C22B3E)">Geen offerte-id in URL.</div>`;
    const src = '/modules/offerte-detail-v2.html?id=' + encodeURIComponent(id) + '&embed=1';
    return `<div class="odv-shell-frame-wrap"
      style="position:relative;height:calc(100dvh - 180px);min-height:400px;overflow:hidden">
      <iframe class="odv-shell-frame"
        src="${src}"
        title="Offerte-detail"
        loading="eager"
        scrolling="auto"
        style="width:100%;height:100%;border:0;background:transparent;display:block"
        allow="clipboard-write"
      ></iframe>
    </div>`;
  };

  // Message-listener (postMessage auto-resize) uitgeschakeld — de vaste-hoogte
  // fallback maakt 'em overbodig, en de dynamische-height had race-conditions
  // met DFO.render die #content leeg swapte. Child post nog wel (harmless
  // no-op) zodat we later terug kunnen naar auto-resize zonder re-code.
  // Voor debug behouden we alleen een console-log als er berichten binnen-
  // komen, zodat we kunnen zien dat de child-side werkt.
  if (!window._odvMsgBound) {
    window._odvMsgBound = true;
    window.addEventListener('message', (e) => {
      const d = e && e.data;
      if (!d || d.type !== 'odv-resize') return;
      // No-op — hoogte staat vast. Alleen debug-log.
      // console.debug('[odv-shell] iframe wilde resize naar', d.h, 'px (genegeerd — vaste-hoogte modus)');
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
