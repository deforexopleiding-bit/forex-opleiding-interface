// api/_lib/lab-config.js
//
// Vaste waarden voor The Lab als leadmachine. Eén plek, zodat de aanmelding,
// de opvolging, het dossier en de statistieken hetzelfde bedoelen.

/** Hoeveel dagen een lab-lead The Lab open heeft. */
export const LAB_TOEGANG_DAGEN = 7;

/** Slug van bron, traject en agendabron. */
export const LAB_SLUG = 'the-lab';

/**
 * De Lab-funnels op deforexopleiding.nl (2026-10-19). Hun aanmelding komt via
 * hetzelfde endpoint binnen, maar met `bron` = de variant, zodat een NIEUWE lead
 * leads.bron = variant krijgt (Funnels > The Lab) en traject 'the-lab' houdt
 * (Leadsonderhoud > The Lab). De agendabron van de strategiesessie blijft LAB_SLUG.
 * Sync met FUNNEL_VARIANTEN in dfo-website (lib/funnel-events.ts) en
 * api/_lib/funnel-stats-compute.js.
 */
export const LAB_FUNNEL_VARIANTEN = Object.freeze(['the-lab-v1', 'the-lab-v2']);

/** Hoort deze leads.bron bij The Lab (LMS-landing of een van de funnels)? PURE. */
export function isLabBron(bron) {
  const s = String(bron || '');
  return s === LAB_SLUG || LAB_FUNNEL_VARIANTEN.includes(s);
}

/** De waarde van de strategiesessie, zoals overal gecommuniceerd. */
export const SESSIE_WAARDE_EUR = 100;

/** Basis-URL van het LMS (dfo-lms). */
export function lmsBasisUrl() {
  return (process.env.DFO_LMS_BASE_URL || 'https://lms.deforexopleiding.nl').trim().replace(/\/+$/, '');
}

/**
 * De loginlink uit een mail. Er staat ALLEEN de sleutel in — nooit een e-mail
 * of naam (die lekken via Referer en geschiedenis). `naar` kiest het scherm na
 * het inloggen: 'start' (standaard), 'lab' of 'sessie'.
 */
export function labLoginLink(sleutel, naar = 'start') {
  const doel = ['start', 'lab', 'sessie'].includes(naar) ? naar : 'start';
  const q = new URLSearchParams({ s: sleutel });
  if (doel !== 'start') q.set('naar', doel);
  return `${lmsBasisUrl()}/the-lab/start/?${q.toString()}`;
}

/** Datum + LAB_TOEGANG_DAGEN, als ISO. */
export function toegangTotVanaf(van = new Date()) {
  return new Date(van.getTime() + LAB_TOEGANG_DAGEN * 24 * 3600 * 1000).toISOString();
}

/**
 * Via welke landingspagina kwam een Lab-aanmelding binnen? Op basis van
 * lab_aanmeldingen.landingspagina (origin + pad). PURE.
 *   /the-lab-v1 → 'Funnel v1 · A', /the-lab-v2 → 'Funnel v2 · B', rest → 'LMS-landing'.
 */
export function labLandingLabel(landingspagina) {
  let pad = '';
  try { pad = new URL(String(landingspagina || '')).pathname; } catch { pad = String(landingspagina || ''); }
  const m = /^\/the-lab-v(\d+)\/?$/.exec(pad);
  if (m && LAB_FUNNEL_VARIANTEN.includes('the-lab-v' + m[1])) return 'Funnel v' + m[1] + ' · ' + String.fromCharCode(64 + Number(m[1]));
  return landingspagina ? 'LMS-landing' : '(onbekend)';
}

/** Groepeersleutel voor de Lab-statistieken: per hook, campagne of landingspagina. PURE. */
export function labSleutel(a, per = 'hook') {
  if (per === 'campagne') return a.utm_campaign || '(geen campagne)';
  if (per === 'landing') return labLandingLabel(a.landingspagina);
  return a.hook || '(geen hook)';
}
