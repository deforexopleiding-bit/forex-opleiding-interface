// services/whatsapp-brug/lib/auth.js
//
// Twee sloten op elke route: een gedeeld geheim, en optioneel een IP-allowlist.
//
// Het geheim wordt in constante tijd vergeleken. Een gewone === lekt via het
// tijdsverschil hoeveel tekens er kloppen, en dat is bij een geheim dat je met
// een script kunt raden geen theoretisch probleem.

import { timingSafeEqual } from 'node:crypto';

function gelijkInConstanteTijd(a, b) {
  const ba = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  // timingSafeEqual eist gelijke lengte. De lengte zelf is geen geheim, dus
  // die mogen we vooraf vergelijken.
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}

/** Het IP van de aanvrager, met de proxy-header erbij als die er is. */
function ipVan(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  const ip = req.socket?.remoteAddress || '';
  // ::ffff:1.2.3.4 → 1.2.3.4, zodat een allowlist met gewone IPv4-adressen werkt.
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

export function maakAuth(cfg) {
  return function auth(req, res, next) {
    if (cfg.toegestaneIps.length > 0) {
      const ip = ipVan(req);
      if (!cfg.toegestaneIps.includes(ip)) {
        // Het IP loggen mag: dat is geen geheim en je hebt het nodig om een
        // verkeerd ingestelde allowlist terug te vinden.
        console.warn('[brug] geweigerd, IP niet op de lijst:', ip);
        return res.status(403).json({ error: 'IP niet toegestaan' });
      }
    }
    const aangeboden = req.headers['x-brug-secret'];
    if (!gelijkInConstanteTijd(aangeboden, cfg.secret)) {
      // NOOIT de aangeboden waarde loggen — dan staat een bijna-goed geheim
      // alsnog in je logbestand.
      console.warn('[brug] geweigerd, geheim klopt niet');
      return res.status(401).json({ error: 'Niet toegestaan' });
    }
    return next();
  };
}
