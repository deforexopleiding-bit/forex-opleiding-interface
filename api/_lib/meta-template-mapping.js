// api/_lib/meta-template-mapping.js
//
// Auto-mapping helper voor WhatsApp Meta-template body_text.
//
// Probleem: api/admin-meta-templates-upsert.js raakt meta_param_mapping niet aan,
// dus elke nieuwe of gewijzigde template kreeg mapping=null. Bij submit + events-send
// resulteert dat in Meta API error #132000 ("Number of parameters does not match")
// voor named-placeholder templates.
//
// Oplossing: leid de mapping af uit body_text op het moment van upsert, zodat
// een nieuwe template direct met correcte mapping in de DB landt.

const PLACEHOLDER_RX = /\{\{([^{}]+)\}\}/g;
const POSITIONAL_RX  = /^\d+$/;

/**
 * Genereer meta_param_mapping uit body_text met named placeholders.
 *
 * Voorbeeld:
 *   "Hoi {{attendee.voornaam}}, voor {{event.titel}}"
 *   -> { body: { "1": "attendee.voornaam", "2": "event.titel" } }
 *
 * Returns:
 *   - { body: {...} } voor PURE NAMED templates (auto-mapbaar)
 *   - null voor PURE POSITIONAL templates (caller moet zelf configureren)
 *   - null voor GEMENGD (named + positional) — te risicovol om automatisch te raden
 *   - null voor lege of niet-string input
 */
export function deriveBodyMappingFromText(bodyText) {
  if (!bodyText || typeof bodyText !== 'string') return null;
  const matches = [...bodyText.matchAll(PLACEHOLDER_RX)].map((m) => m[1].trim());
  if (matches.length === 0) return null;

  const named = [];
  const positional = [];
  const seen = new Set();
  for (const m of matches) {
    if (POSITIONAL_RX.test(m)) {
      positional.push(m);
    } else if (m.includes('.')) {
      if (!seen.has(m)) {
        seen.add(m);
        named.push(m);
      }
    }
    // Plaatsmerkers zonder punt EN niet-numeriek (bv. {{abc}}) negeren we
    // bewust: die zijn nooit valide registry-keys.
  }

  // Alleen auto-mappen bij PURE named — gemengd of pure-positional vereist
  // bewuste configuratie door de admin.
  if (named.length > 0 && positional.length === 0) {
    const body = {};
    named.forEach((key, idx) => { body[String(idx + 1)] = key; });
    return { body };
  }
  return null;
}

/**
 * Helper: checkt of een body_text positional placeholders ({{1}}, {{2}}, ...)
 * bevat. Gebruikt door upsert om een warning te loggen als mapping=null blijft
 * terwijl er wel positionele params zijn.
 */
export function hasPositionalPlaceholders(bodyText) {
  if (!bodyText || typeof bodyText !== 'string') return false;
  return /\{\{\d+\}\}/.test(bodyText);
}
