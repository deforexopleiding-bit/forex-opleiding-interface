// api/_lib/setter-period.js
//
// BP3 v4 (2026-09-01) — gedeelde periode-parser voor setter-endpoints
// (dashboard-metrics + overview). Accepteert een van:
//
//   ?period=dag|week|maand|jaar
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD   (custom, inclusief-inclusief)
//
// Returnt { from: ISO, to: ISO, key: 'dag'|'week'|'maand'|'jaar'|'custom' }.
// Default (geen param): { key:'maand' } → laatste 30 dagen.
//
// - dag  → vandaag 00:00 tot morgen 00:00
// - week → maandag 00:00 (deze week) tot volgende maandag 00:00
// - maand → 1e vd maand 00:00 tot 1e vd volgende maand 00:00
// - jaar → 1 jan 00:00 tot 1 jan volgend jaar 00:00
// - custom → from 00:00 tot (to+1 dag) 00:00 (exclusief einde)
//
// Alle grenzen in UTC. YYYY-MM-DD-parsing is defensief; ongeldige input
// valt terug op default 'maand'.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function iso(d) { return d.toISOString(); }

export function parseSetterPeriod(query) {
  const q = query || {};
  const rawFrom = typeof q.from === 'string' && DATE_RE.test(q.from.trim()) ? q.from.trim() : null;
  const rawTo   = typeof q.to   === 'string' && DATE_RE.test(q.to.trim())   ? q.to.trim()   : null;

  // Custom-range wint als beide geldig.
  if (rawFrom && rawTo) {
    const [fy, fm, fd] = rawFrom.split('-').map(Number);
    const [ty, tm, td] = rawTo.split('-').map(Number);
    const from = new Date(Date.UTC(fy, fm - 1, fd, 0, 0, 0));
    const to   = new Date(Date.UTC(ty, tm - 1, td + 1, 0, 0, 0)); // +1 dag → exclusief einde
    if (!isNaN(from.getTime()) && !isNaN(to.getTime()) && to > from) {
      return { from: iso(from), to: iso(to), key: 'custom' };
    }
  }

  const key = String(q.period || 'maand').toLowerCase();
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();

  if (key === 'dag') {
    const from = new Date(Date.UTC(y, m, d, 0, 0, 0));
    const to   = new Date(Date.UTC(y, m, d + 1, 0, 0, 0));
    return { from: iso(from), to: iso(to), key: 'dag' };
  }
  if (key === 'week') {
    // Maandag als week-start (Nederlandse conventie). UTC-day: 0=zo,1=ma,…
    const dow = now.getUTCDay(); // 0..6
    const offsetToMonday = (dow === 0 ? 6 : dow - 1);
    const from = new Date(Date.UTC(y, m, d - offsetToMonday, 0, 0, 0));
    const to   = new Date(Date.UTC(y, m, d - offsetToMonday + 7, 0, 0, 0));
    return { from: iso(from), to: iso(to), key: 'week' };
  }
  if (key === 'jaar') {
    const from = new Date(Date.UTC(y, 0, 1, 0, 0, 0));
    const to   = new Date(Date.UTC(y + 1, 0, 1, 0, 0, 0));
    return { from: iso(from), to: iso(to), key: 'jaar' };
  }
  // default = 'maand'
  const from = new Date(Date.UTC(y, m, 1, 0, 0, 0));
  const to   = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0));
  return { from: iso(from), to: iso(to), key: 'maand' };
}
