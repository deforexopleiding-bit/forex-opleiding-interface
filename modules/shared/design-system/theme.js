// modules/shared/design-system/theme.js
//
// Dark-mode toggle voor het redesign. Zet `data-theme="dark"` op :root en
// persisteert de keuze in localStorage. Geen system-preference gebruik
// (opdrachtgevers-keuze 2026-08-06 — expliciete user-toggle).
//
// Gebruik in module-HTML:
//   1. Roep applyStoredTheme() ZO VROEG mogelijk aan (in <head>-script tag)
//      om flash-of-wrong-theme te voorkomen.
//   2. Wire de toggle-knop met bindThemeToggle(buttonElement).

const STORAGE_KEY = 'dfo-crm-theme';   // 'light' | 'dark'

/** Lees opgeslagen keuze; default 'light' als niets gezet. */
export function getStoredTheme() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'dark' ? 'dark' : 'light';
  } catch (_) {
    return 'light';
  }
}

/** Pas theme toe op <html> element. */
export function applyTheme(theme) {
  const value = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', value);
  try { localStorage.setItem(STORAGE_KEY, value); } catch (_) {}
}

/** Roep aan ZO VROEG mogelijk (in <head>) om FOUC te voorkomen. */
export function applyStoredTheme() {
  applyTheme(getStoredTheme());
}

/** Toggle tussen light/dark en persisteer. Return de nieuwe waarde. */
export function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  const next = cur === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  return next;
}

/** Wire een button om te togglen. Verandert ook het icoontje als data-icon-* attribs gezet. */
export function bindThemeToggle(btn) {
  if (!btn) return;
  btn.addEventListener('click', () => {
    const next = toggleTheme();
    btn.setAttribute('aria-pressed', next === 'dark' ? 'true' : 'false');
    btn.setAttribute('title', next === 'dark' ? 'Licht thema' : 'Donker thema');
  });
  btn.setAttribute('aria-pressed', getStoredTheme() === 'dark' ? 'true' : 'false');
  btn.setAttribute('title', getStoredTheme() === 'dark' ? 'Licht thema' : 'Donker thema');
}

/** Genereer een deterministische kleurgradient voor avatars op basis van een string (naam/uuid). */
export function avatarGradient(seed) {
  const s = String(seed || '');
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  const palette = [
    ['#2D74D6', '#1B4EA0'], // blue
    ['#7C4FE0', '#5B2FB8'], // violet
    ['#0EA271', '#076B4A'], // emerald
    ['#E08628', '#B45E10'], // amber
    ['#D63A4E', '#A62232'], // rose
    ['#1F8FA6', '#0E6B7E'], // teal
    ['#B23FA8', '#832883'], // magenta
  ];
  const [a, b] = palette[hash % palette.length];
  return `linear-gradient(140deg, ${a}, ${b})`;
}

/** Compact initialen uit een naam (max 2 letters). */
export function initialsOf(name) {
  const s = String(name || '').trim();
  if (!s) return '?';
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
