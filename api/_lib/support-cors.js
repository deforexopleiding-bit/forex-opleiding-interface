// api/_lib/support-cors.js
//
// CORS-grens voor de publieke support-endpoints. De widget draait op de
// website (een ander origin dan crm.deforexopleiding.nl), dus de browser doet
// voor elk verzoek een preflight en weigert alles wat hier niet doorheen komt.
//
// Recept overgenomen van api/lms-whoami.js — dat is het enige extern-facing
// endpoint dat we hadden en de afwegingen daar gelden hier één op één:
//   * NOOIT '*'. Er gaat een sessietoken overheen; met een wildcard kan elke
//     site die een bezoeker toevallig openheeft mee-lezen.
//   * `Vary: Origin`, anders serveert een cache het antwoord voor origin A
//     aan origin B en faalt de check alsnog — of, erger, slaagt hij ten
//     onrechte.
//   * Reflecteren UITSLUITEND bij een treffer. Al het andere krijgt het
//     productie-origin terug, wat de browser dan zelf afwijst.
//
// Uitbreiden zonder deploy kan via SUPPORT_WIDGET_ORIGINS (komma-gescheiden,
// volledige origins inclusief https://). Bedoeld voor een tijdelijke
// staging-host; zet er geen wildcard in, die wordt genegeerd.

const PRODUCTIE_ORIGIN = 'https://www.deforexopleiding.nl';

// Vaste allowlist. Kaal domein én www: Webflow serveert op beide en een
// bezoeker die deforexopleiding.nl intikt mag de widget niet missen.
const VASTE_ORIGINS = [
  'https://www.deforexopleiding.nl',
  'https://deforexopleiding.nl',
  'https://crm.deforexopleiding.nl',
  'https://lms.deforexopleiding.nl',
];

// Vercel-previews van het website-project. Zelfde strengheid als
// LMS_PREVIEW_ORIGIN in lms-whoami.js: de hostnaam moet met de projectnaam
// beginnen én op onze eigen team-slug eindigen. Zonder die team-eis kan
// iedereen op Vercel een project `dfo-website-...` aanmaken en meelezen.
const PREVIEW_ORIGIN =
  /^https:\/\/dfo-website-[a-z0-9-]+-de-forex-opleiding-bv-s-projects\.vercel\.app$/;

// De Webflow-staging van de marketingsite. Zonder deze regel blokkeert de
// browser elke API-call vanaf staging en toont de widget daar een
// storingsmelding — precies waar je hem juist wilt uitproberen voordat hij
// op de live site komt.
//
// Bewust ÉÉN exacte hostnaam en geen patroon op webflow.io: die subdomeinen
// zijn voor iedereen aan te maken, dus een wildcard daar zou de deur voor de
// hele wereld openzetten. Verandert de sitenaam in Webflow, dan verandert
// deze hostnaam mee en moet deze regel mee.
//
// Let op: gesprekken die vanaf staging beginnen komen in de ECHTE wachtrij
// terecht. Test dus met een herkenbare naam, of zet de widget tijdelijk uit
// in Support → Instellingen.
const WEBFLOW_STAGING = 'https://dfo-2-0---2026.webflow.io';

function extraOrigins() {
  const raw = process.env.SUPPORT_WIDGET_ORIGINS || '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(s));
}

/**
 * Welk origin er in Access-Control-Allow-Origin hoort.
 * Geëxporteerd omdat dit een beveiligingsgrens is en dus los testbaar moet
 * zijn — niet omdat een endpoint het nodig heeft.
 *
 * @param {string|undefined} origin — de Origin-header van het verzoek
 * @returns {string}
 */
export function resolveSupportOrigin(origin) {
  if (typeof origin !== 'string' || !origin) return PRODUCTIE_ORIGIN;
  if (VASTE_ORIGINS.includes(origin)) return origin;
  if (origin === WEBFLOW_STAGING) return origin;
  if (PREVIEW_ORIGIN.test(origin)) return origin;
  if (extraOrigins().includes(origin)) return origin;
  return PRODUCTIE_ORIGIN;
}

/** Is dit origin daadwerkelijk toegestaan? Voor logging/diagnose. */
export function isToegestaanOrigin(origin) {
  return resolveSupportOrigin(origin) === origin;
}

/**
 * Zet de CORS- en cache-headers. Roep dit aan als ALLEREERSTE regel van de
 * handler, vóór elke early return — een 405 of 429 zonder CORS-headers komt
 * bij de bezoeker aan als een onverklaarbare netwerkfout in plaats van als
 * een nette foutmelding.
 *
 * @param {object} req
 * @param {object} res
 * @param {string} [methods] — toegestane methodes naast OPTIONS
 */
export function applySupportCors(req, res, methods = 'POST, OPTIONS') {
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Origin', resolveSupportOrigin(req.headers?.origin));
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Support-Token');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
}

/**
 * Preflight + methode-check in één. Returnt true als de handler moet stoppen
 * (het antwoord is dan al verstuurd).
 */
export function handledPreflight(req, res, toegestaneMethode) {
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  if (req.method !== toegestaneMethode) {
    res.status(405).json({ error: 'Method not allowed' });
    return true;
  }
  return false;
}
