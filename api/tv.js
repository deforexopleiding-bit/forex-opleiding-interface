// api/tv.js
//
// Korte URL voor de tv-dashboard: /tv → 302 redirect naar
// /display?key=<DISPLAY_TV_KEY>. Server-side injectie zodat Jeffrey
// op de tv alleen "/tv" hoeft in te typen — de token blijft in Vercel-env,
// nooit in de repo of URL-bar tijdens typen.
//
// Query-passthrough: binnenkomende params (fit, theme, ...) worden aan de
// redirect toegevoegd, zodat /tv?fit=0.85 en /tv?theme=light werken.
// De 'key'-param wordt server-side overschreven met DISPLAY_TV_KEY.

export default function handler(req, res) {
  const key = process.env.DISPLAY_TV_KEY;
  if (!key) {
    res.status(500).send('DISPLAY_TV_KEY niet gezet in Vercel-env.');
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  const params = new URLSearchParams(req.query);   // fit/theme/etc behouden
  params.set('key', key);                          // key server-side toevoegen (overschrijft eventueel meegegeven)
  res.redirect(302, '/display?' + params.toString());
}
