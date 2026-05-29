// modules/shared/quick-task-button.js
//
// Auto-injecteer een "+ Taak" knop in module-headers. Wordt geladen via
// <script src="/modules/shared/quick-task-button.js" data-module="Klanten" defer></script>
//
// Het script:
//  1. Wacht op DOMContentLoaded + sidebar:mounted
//  2. Permission-check op taken.task.create via window.AgentShared.hasPermission (fail-open)
//  3. Vindt .header-actions of valt terug op floating button rechtsboven
//  4. Voegt knop toe die window.AgentShared.openCreateTaskModal({ prefill }) opent
//  5. Lazy-load van task-modal.js bij eerste klik
//
// data-module attribuut wordt meegegeven als prefill (categorie context).

(function () {
  var scriptEl = document.currentScript;
  var moduleLabel = (scriptEl && scriptEl.getAttribute('data-module')) || 'Taken';

  function ensureModalLoaded() {
    if (window.AgentShared && window.AgentShared.openCreateTaskModal) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = '/modules/shared/task-modal.js';
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('task-modal.js load fout')); };
      document.head.appendChild(s);
    });
  }

  function buildButton() {
    var btn = document.createElement('button');
    btn.className = 'btn btn-ghost qt-btn';
    btn.type = 'button';
    btn.setAttribute('data-tooltip', 'Snel een taak aanmaken');
    btn.setAttribute('aria-label', 'Snel een taak aanmaken');
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>'
                 + '<span style="margin-left:4px">Taak</span>';
    btn.style.cssText = 'display:inline-flex; align-items:center; gap:4px;';
    btn.addEventListener('click', async function () {
      try {
        await ensureModalLoaded();
        await window.AgentShared.openCreateTaskModal({ prefill: { categorie: 'Overige', module: moduleLabel } });
      } catch (e) {
        console.error('[quick-task-button] modal openen mislukt:', e);
      }
    });
    return btn;
  }

  function tryInject() {
    var slot = document.querySelector('.header-actions');
    if (!slot) {
      // Floating fallback rechtsonder.
      if (document.querySelector('.qt-float')) return true;
      var fb = buildButton();
      fb.classList.add('qt-float');
      fb.style.cssText = 'position:fixed; right:20px; bottom:20px; z-index:500; padding:10px 16px; border-radius:30px; box-shadow:0 4px 16px rgba(0,0,0,0.2); background:var(--bg-elev, #fff); color:var(--text, #0f172a); border:1px solid var(--border, #e5e7eb); cursor:pointer; font-weight:500;';
      document.body.appendChild(fb);
      return true;
    }
    if (slot.querySelector('.qt-btn')) return true;
    slot.insertBefore(buildButton(), slot.firstChild);
    return true;
  }

  function init() {
    // Korte retry-loop omdat sommige modules de header dynamisch renderen.
    var tries = 0;
    var iv = setInterval(function () {
      if (tryInject() || ++tries > 20) clearInterval(iv);
    }, 150);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
