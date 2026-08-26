// api/tv.js
//
// Korte URL voor de tv-dashboard: /tv → 302 redirect naar
// /display?key=<DISPLAY_TV_KEY>. Server-side injectie zodat Jeffrey
// op de tv alleen "/tv" hoeft in te typen — de token blijft in Vercel-env,
// nooit in de repo of URL-bar tijdens typen.
//
// Toegang tot deze URL = toegang tot het bord (zelfde als de token direct
// intypen). Intern KPI-bord, PII al server-side getrimd in display-metrics.
// Rotatie: draai token via /api/display-token-admin, update DISPLAY_TV_KEY
// in Vercel, revoke oude — /tv-bezoekers volgen automatisch de nieuwe token.

export default function handler(req, res) {
  const key = process.env.DISPLAY_TV_KEY;
  if (!key) {
    res.status(500).send('DISPLAY_TV_KEY niet gezet in Vercel-env.');
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.redirect(302, '/display?key=' + encodeURIComponent(key));
}
