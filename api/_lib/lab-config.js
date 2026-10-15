// api/_lib/lab-config.js
//
// Vaste waarden voor The Lab als leadmachine. Eén plek, zodat de aanmelding,
// de opvolging, het dossier en de statistieken hetzelfde bedoelen.

/** Hoeveel dagen een lab-lead The Lab open heeft. */
export const LAB_TOEGANG_DAGEN = 7;

/** Slug van bron, traject en agendabron. */
export const LAB_SLUG = 'the-lab';

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
