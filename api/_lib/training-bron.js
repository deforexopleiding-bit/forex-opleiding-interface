// api/_lib/training-bron.js
//
// Wekelijkse training-funnel (dfo-website PR #130, sinds 2026-10-23):
// elke training-opname krijgt een eigen bron/variant 'training-<dd-mm-jj>'.
// Leads: leads.bron = 'training-22-10-26', leads.pagina = '/training/22-10-26'.
// Tracking: funnel_events.variant = 'training-22-10-26'.
//
// Bewust een PATROON, geen lijst: elke week komt er een training bij zonder
// CRM-wijziging. Spiegel van TRAINING_BRON_RE in dfo-website lib/trainingen.ts.
// De browser (leads-v2.js) heeft een eigen kopie van het label (klassiek script).
//
// Puur: geen DB, geen IO.

export const TRAINING_BRON_RE = /^training-(\d{2})-(\d{2})-(\d{2})$/;

export const TRAINING_HOST = 'training.deforexopleiding.nl';
export const SITE_ORIGIN = 'https://www.deforexopleiding.nl';

export function isTrainingBron(x) {
  return typeof x === 'string' && TRAINING_BRON_RE.test(x);
}

/** 'training-22-10-26' → '22-10-26' (null als het geen training is). */
export function trainingSlug(x) {
  return isTrainingBron(x) ? x.slice('training-'.length) : null;
}

/** 'training-22-10-26' → 'Live training 22/10/26' (zelfde tekst als lib/trainingen.ts label). */
export function trainingLabel(x) {
  const m = typeof x === 'string' ? TRAINING_BRON_RE.exec(x) : null;
  return m ? `Live training ${m[1]}/${m[2]}/${m[3]}` : null;
}

/** 'training-22-10-26' → '2026-10-22' (YYYY-MM-DD; sorteerbaar). */
export function trainingDatum(x) {
  const m = typeof x === 'string' ? TRAINING_BRON_RE.exec(x) : null;
  return m ? `20${m[3]}-${m[2]}-${m[1]}` : null;
}

/** Live pagina op het subdomein (canoniek) en op de hoofdsite. */
export function trainingLinks(x) {
  const slug = trainingSlug(x);
  if (!slug) return null;
  return {
    live: `https://${TRAINING_HOST}/${slug}`,
    site: `${SITE_ORIGIN}/training/${slug}`,
    pagina: `/training/${slug}`,
  };
}
