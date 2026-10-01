// modules/klanten-v2/banner-stapel.js
//
// DE BANNERSTAPEL BOVEN DE SHELL — één plek die de bovenmarge van .app zet.
//
// Er zijn nu twee balken die bovenaan vast staan: de impersonatiebanner
// ("Je bekijkt als …") en de closer-topbar ("Maak je dagrapportage in orde").
// Ze kunnen tegelijk zichtbaar zijn. Zette elke balk zelf .app.style.marginTop,
// dan won de laatste schrijver en schoof de andere balk over de shell heen.
//
// Daarom staan ze samen in één vaste houder (#kv-banner-stapel), onder elkaar
// in gewone flow, gesorteerd op `volgorde` (laag = bovenaan). Alleen de houder
// is position:fixed; zijn hoogte bepaalt de marge van .app, en een
// ResizeObserver houdt die bij (font-load, mobiel afbreken, balk erbij/eraf).
//
// API (window.KVBannerStapel):
//   plaats(el, volgorde)  balk in de stapel zetten (of verplaatsen)
//   haalWeg(elOfId)       balk eruit; lege stapel → marge terug op niets
//   herbereken()          marge opnieuw zetten (normaal vanzelf)
//   shellStijl(hoogte)    PUUR: { marginTop, height } voor .app
//   invoegIndex(volgordes, nieuw)  PUUR: waar een balk tussen hoort
//
// Klassiek script (geen module): geladen in index.html vóór klanten-v2.js.
(function () {
  'use strict';

  var HOUDER_ID = 'kv-banner-stapel';

  /** Stijl voor .app bij een stapelhoogte. 0 → alles terug naar de css. */
  function shellStijl(hoogte) {
    var h = Math.max(0, Math.round(Number(hoogte) || 0));
    if (!h) return { marginTop: '', height: '' };
    return { marginTop: h + 'px', height: 'calc(100vh - ' + h + 'px)' };
  }

  /**
   * Index waarop een balk met volgorde `nieuw` hoort in een rij bestaande
   * volgordes (bovenaan eerst). Gelijke volgorde: achter de bestaande.
   */
  function invoegIndex(volgordes, nieuw) {
    var n = Number(nieuw) || 0;
    var lijst = volgordes || [];
    for (var i = 0; i < lijst.length; i += 1) {
      if ((Number(lijst[i]) || 0) > n) return i;
    }
    return lijst.length;
  }

  // Te overschrijven in tests (jsdom meet geen hoogtes).
  var api = {
    meet: function (el) { return el ? el.offsetHeight : 0; },
  };

  var observer = null;

  function houder(maakAan) {
    var h = document.getElementById(HOUDER_ID);
    if (h || !maakAan) return h;
    h = document.createElement('div');
    h.id = HOUDER_ID;
    h.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;display:flex;flex-direction:column';
    document.body.insertBefore(h, document.body.firstChild);
    if (typeof ResizeObserver !== 'undefined') {
      try { observer = new ResizeObserver(herbereken); observer.observe(h); } catch (_) { observer = null; }
    }
    return h;
  }

  function herbereken() {
    var h = houder(false);
    var hoogte = h && h.children.length ? api.meet(h) : 0;
    var stijl = shellStijl(hoogte);
    var shell = document.querySelector('.app');
    if (shell) {
      shell.style.marginTop = stijl.marginTop;
      shell.style.height = stijl.height;
    }
    return hoogte;
  }

  function plaats(el, volgorde) {
    if (!el) return;
    var h = houder(true);
    var v = Number(volgorde) || 0;
    el.setAttribute('data-stapel-volgorde', String(v));
    if (el.parentNode === h) h.removeChild(el);
    var kinderen = Array.prototype.slice.call(h.children);
    var idx = invoegIndex(kinderen.map(function (k) { return k.getAttribute('data-stapel-volgorde'); }), v);
    h.insertBefore(el, kinderen[idx] || null);
    herbereken();
  }

  function haalWeg(elOfId) {
    var el = typeof elOfId === 'string' ? document.getElementById(elOfId) : elOfId;
    if (el && el.parentNode) el.parentNode.removeChild(el);
    herbereken();
  }

  api.plaats = plaats;
  api.haalWeg = haalWeg;
  api.herbereken = herbereken;
  api.shellStijl = shellStijl;
  api.invoegIndex = invoegIndex;
  api.HOUDER_ID = HOUDER_ID;
  window.KVBannerStapel = api;
})();
