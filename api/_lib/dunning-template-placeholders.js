// api/_lib/dunning-template-placeholders.js
// Pure helpers voor Meta-template-placeholder-analyse. Geen Supabase,
// geen HTTP — deterministisch unit-testbaar.
//
// Waarom in aparte file: dunning-step-executors.js importeert Supabase
// bij module-load, waardoor tests die alleen deze helpers testen daar
// via env-var-eis stukliepen. Split houdt de pure logica testbaar.

// Matcht:
//   1) HOOFDLETTER-legacy:      {{NAAM}}, {{TOTAAL_BEDRAG}}       ([A-Z][A-Z_]*)
//   2) N-delige dot-notation:   {{klant.voornaam}} én {{a.b.c}}   ([a-z_]+(\.[a-z_]+)+)
//
// Historisch stond hier alleen 2-delig (`[a-z_]+\.[a-z_]+`). Templates die
// later 3-delige of diepere keys kregen (bv. {{klant.factuur.bedrag_open}})
// werden stil overgeslagen — Meta verwachtte N params, wij stuurden N-1 →
// Meta API #132000. Uitbreiding naar N-delig is non-breaking: bestaande
// 2-delige matches blijven identiek.
export const DUNNING_PLACEHOLDER_RE = /\{\{([A-Z][A-Z_]*|[a-z_]+(?:\.[a-z_]+)+)\}\}/g;

// Brede regex — matcht ALLES tussen {{ }}, ongeacht case/vorm. Alleen
// gebruikt voor fail-loud diagnose: rapporteer placeholders die de nauwe
// regex WEL zag in de body maar NIET in DUNNING_PLACEHOLDER_RE terugkomen.
export const ANY_PLACEHOLDER_RE = /\{\{([^{}]+)\}\}/g;

/**
 * Bouw de positionele Meta-template-parameters uit de template-body zelf.
 *
 * De N-de UNIEKE placeholder (in volgorde van eerste voorkomen) wordt de
 * N-de positionele parameter ({{N}}) die Meta bij goedkeuring vastlegde.
 * `variablesUsed` (van dunning-template-render) levert de gerenderde waarden.
 * Ontbrekende waarden → lege string zodat het AANTAL kloppend blijft en
 * Meta geen #132000 gooit.
 *
 * PURE — geen DB, geen HTTP.
 */
export function buildMetaTemplateVariables(bodyText, variablesUsed) {
  const body = String(bodyText || '');
  const vals = (variablesUsed && typeof variablesUsed === 'object') ? variablesUsed : {};
  const seen = new Set();
  const out  = [];
  DUNNING_PLACEHOLDER_RE.lastIndex = 0;
  let m;
  while ((m = DUNNING_PLACEHOLDER_RE.exec(body))) {
    const key = m[1];
    if (seen.has(key)) continue;
    seen.add(key);
    const v = Object.prototype.hasOwnProperty.call(vals, key) ? vals[key] : '';
    out.push(String(v == null ? '' : v));
  }
  return out;
}

/**
 * Pure diagnose-helper voor #132000-debugging. Splitst de placeholders in
 * een template.body in drie categorieën, zodat je (of de diagnose-endpoint)
 * zonder een echte send kan zien of het aantal én de vorm van placeholders
 * matchen wat Meta bij goedkeuring vastlegde. Geen side-effects.
 *
 * Retourneert:
 *   matched     — placeholders die DUNNING_PLACEHOLDER_RE matcht (naar Meta gestuurd)
 *   unmatched   — placeholders die WEL {{...}} zijn maar NIET door de nauwe regex komen (bug-bron)
 *   total_count — matched.length (wat Meta ontvangt)
 *   raw_count   — matched.length + unmatched.length (wat een mens in de body ziet)
 *   n_missing   — raw_count - total_count (>0 = kans op #132000)
 */
export function diagnoseTemplatePlaceholders(bodyText) {
  const body = String(bodyText || '');
  const all = [];
  const allSeen = new Set();
  ANY_PLACEHOLDER_RE.lastIndex = 0;
  let m;
  while ((m = ANY_PLACEHOLDER_RE.exec(body))) {
    const key = m[1].trim();
    if (!key || allSeen.has(key)) continue;
    allSeen.add(key);
    all.push(key);
  }
  const matched = [];
  const matchedSeen = new Set();
  DUNNING_PLACEHOLDER_RE.lastIndex = 0;
  let n;
  while ((n = DUNNING_PLACEHOLDER_RE.exec(body))) {
    const key = n[1];
    if (matchedSeen.has(key)) continue;
    matchedSeen.add(key);
    matched.push(key);
  }
  const unmatched = all.filter(k => !matchedSeen.has(k));
  return {
    matched,
    unmatched,
    total_count: matched.length,
    raw_count:   all.length,
    n_missing:   unmatched.length,
  };
}
