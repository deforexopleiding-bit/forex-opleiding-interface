// api/_lib/lab-cors.js
//
// CORS-grens voor de publieke Lab-endpoints (aanmelding, nieuwe link, sessie
// boeken). Zelfde recept als support-cors.js — nooit '*', `Vary: Origin`,
// alleen reflecteren bij een treffer — met twee verschillen:
//
//   * `Authorization` mag mee: het boek-endpoint krijgt de LMS-sessie van de
//     lead als bearer, zodat hij niets opnieuw hoeft te typen.
//   * de landingspagina's van de collega staan op domeinen die we nu nog niet
//     kennen. Die komen erbij via LAB_LANDING_ORIGINS (komma-gescheiden,
//     volledige https-origins), zonder deploy.

const PRODUCTIE_ORIGIN = 'https://lms.deforexopleiding.nl';

const VASTE_ORIGINS = [
  'https://lms.deforexopleiding.nl',
  'https://www.deforexopleiding.nl',
  'https://deforexopleiding.nl',
  'https://crm.deforexopleiding.nl',
];

// Vercel-previews van het LMS en de website, alleen op onze eigen team-slug.
const PREVIEW_ORIGIN =
  /^https:\/\/(dfo-lms-prototype|dfo-website)-[a-z0-9-]+-de-forex-opleiding-bv-s-projects\.vercel\.app$/;

function extraOrigins() {
  return String(process.env.LAB_LANDING_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(s));
}

/** Welk origin in Access-Control-Allow-Origin hoort. PURE (op env na). */
export function resolveLabOrigin(origin) {
  if (typeof origin !== 'string' || !origin) return PRODUCTIE_ORIGIN;
  if (VASTE_ORIGINS.includes(origin)) return origin;
  if (PREVIEW_ORIGIN.test(origin)) return origin;
  if (extraOrigins().includes(origin)) return origin;
  return PRODUCTIE_ORIGIN;
}

export function applyLabCors(req, res, methods = 'POST, OPTIONS') {
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Origin', resolveLabOrigin(req.headers?.origin));
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
}

/** Preflight + methodecheck. True = antwoord al verstuurd. */
export function labPreflight(req, res, toegestaan) {
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  const lijst = Array.isArray(toegestaan) ? toegestaan : [toegestaan];
  if (!lijst.includes(req.method)) {
    res.status(405).json({ ok: false, code: 'methode_niet_toegestaan' });
    return true;
  }
  return false;
}
