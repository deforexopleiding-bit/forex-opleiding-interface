/* ============================================================================
   De Forex Opleiding — Design System theme-toggle (Fase 0)
   ---------------------------------------------------------------------------
   Dependency-vrij scriptje voor handmatige light/dark-toggle.
   - Bewaart keuze in localStorage onder 'dfo-theme' (waarden: 'light' | 'dark').
   - Default 'light' (NIET prefers-color-scheme — bewuste keuze uit spec).
   - Zet data-theme op <html> (document.documentElement) zodat het design-
     system-css tokens onder [data-theme="dark"] pakt.
   - Idempotent: meerdere script-tags of herhaalde executie is veilig.
   - Exposes window.DFOTheme = { get, set(name), toggle(), STORAGE_KEY }.
   - Vuurt een 'dfo-theme-change' CustomEvent op window bij elke wijziging
     zodat andere scripts kunnen reageren (bv. chart-recolor).
   ========================================================================== */
(function () {
  'use strict';

  var STORAGE_KEY = 'dfo-theme';
  var VALID = { light: 1, dark: 1 };

  // Idempotent: als het API-object al geïnstalleerd is, alleen de huidige
  // opgeslagen keuze opnieuw toepassen en verder niks doen. Voorkomt dubbele
  // event-listeners / dubbele attribuutschrijves als het script per ongeluk
  // twee keer geladen wordt.
  if (window.DFOTheme && typeof window.DFOTheme.set === 'function') {
    try {
      var current = window.DFOTheme.get();
      if (current) window.DFOTheme.set(current);
    } catch (_e) { /* fail-soft */ }
    return;
  }

  function readStored() {
    try {
      var v = window.localStorage.getItem(STORAGE_KEY);
      return VALID[v] ? v : null;
    } catch (_e) { return null; }
  }

  function writeStored(v) {
    try { window.localStorage.setItem(STORAGE_KEY, v); }
    catch (_e) { /* fail-soft: bv. private mode of storage disabled */ }
  }

  function applyToRoot(v) {
    var root = document.documentElement;
    if (!root) return;
    // Alleen 'dark' krijgt het data-attribuut; 'light' = geen attribuut (default).
    if (v === 'dark') root.setAttribute('data-theme', 'dark');
    else              root.removeAttribute('data-theme');
  }

  function dispatch(v) {
    try {
      var evt = new CustomEvent('dfo-theme-change', { detail: { theme: v } });
      window.dispatchEvent(evt);
    } catch (_e) { /* IE-achtige omgevingen negeren */ }
  }

  function get() {
    // Reflecteer wat er nu ECHT op de root staat, met fallback naar storage
    // en dan naar 'light'. Dat is de bron van waarheid voor UI-toggles.
    var root = document.documentElement;
    if (root && root.getAttribute('data-theme') === 'dark') return 'dark';
    var stored = readStored();
    return stored || 'light';
  }

  function set(v) {
    var next = VALID[v] ? v : 'light';
    applyToRoot(next);
    writeStored(next);
    dispatch(next);
    return next;
  }

  function toggle() {
    return set(get() === 'dark' ? 'light' : 'dark');
  }

  // Initieel toepassen: sla de opgeslagen keuze op de root zodra het DOM
  // beschikbaar is. Als het script vóór </head> geladen wordt (recommended)
  // vermijdt dit een light->dark flash.
  var initial = readStored() || 'light';
  applyToRoot(initial);

  window.DFOTheme = {
    STORAGE_KEY: STORAGE_KEY,
    get:    get,
    set:    set,
    toggle: toggle,
  };
})();
