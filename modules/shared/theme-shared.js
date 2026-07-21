(function() {
  const STORAGE_KEY = 'agency-cc-theme';

  function getStoredTheme() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return null;
    }
  }

  function getInitialTheme() {
    return getStoredTheme() || 'light';
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch (e) {
      console.warn('Cannot persist theme preference');
    }

    // Sun/moon inline-SVG paths (feather-icons). Herbruikt door de SVG-swap
    // hieronder — beide varianten hebben dezelfde stroke/viewBox zodat een
    // in-place innerHTML-vervanging geen layout-verschuiving geeft.
    const MOON_SVG =
      '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
    const SUN_SVG =
      '<circle cx="12" cy="12" r="5"/>' +
      '<line x1="12" y1="1" x2="12" y2="3"/>' +
      '<line x1="12" y1="21" x2="12" y2="23"/>' +
      '<line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>' +
      '<line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>' +
      '<line x1="1" y1="12" x2="3" y2="12"/>' +
      '<line x1="21" y1="12" x2="23" y2="12"/>' +
      '<line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>' +
      '<line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';

    document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
      // Backward-compat: bestaande <i class="ti ti-moon/sun"> swap.
      const icon = btn.querySelector('i');
      if (icon) {
        icon.className = theme === 'dark' ? 'ti ti-sun' : 'ti ti-moon';
      }
      // Nieuw: inline-SVG swap voor knoppen zonder tabler-webfont.
      // Gemarkeerd via data-theme-icon zodat andere SVG's ongemoeid blijven.
      const svg = btn.querySelector('svg[data-theme-icon]');
      if (svg) {
        svg.innerHTML = theme === 'dark' ? SUN_SVG : MOON_SVG;
      }
      btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
      btn.title = theme === 'dark' ? 'Light mode' : 'Dark mode';
    });

    window.dispatchEvent(new CustomEvent('themechange', { detail: { theme } }));
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'light' ? 'dark' : 'light';
    applyTheme(next);
  }

  applyTheme(getInitialTheme());

  document.addEventListener('click', function(e) {
    const btn = e.target.closest('[data-theme-toggle]');
    if (btn) {
      e.preventDefault();
      toggleTheme();
    }
  });

  window.ThemeShared = {
    apply: applyTheme,
    toggle: toggleTheme,
    current: function() {
      return document.documentElement.getAttribute('data-theme') || 'light';
    },
  };
})();
