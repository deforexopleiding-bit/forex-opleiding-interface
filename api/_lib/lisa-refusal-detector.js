// api/_lib/lisa-refusal-detector.js
//
// Detecteert of een AI-gegenereerde string een weigering, meta-commentaar of
// derde-persoons-reflectie over Lisa/het gesprek is — NIET iets wat je aan een
// klant kunt versturen.
//
// Aanleiding: Sonnet weigerde in juli/aug 2026 om follow-ups te genereren voor
// klanten die zes keer stop hadden gezegd, en gaf zinnen als:
//   "Kijkend naar dit gesprek, zie ik dat Lisa al zes keer heeft gezegd..."
//   "Ik kan dit bericht niet genereren. In het vorige gesprek heb ik meerdere
//    keren expliciet beloofd..."
// Die tekst werd letterlijk als Instagram-DM verstuurd omdat de cron alleen op
// een lege response controleerde. Deze detector vult die guard aan.
//
// PURE — geen DB/HTTP. Unit-testbaar. Fail-open: bij twijfel returnt 'em
// {refused: false} zodat legitieme berichten niet ten onrechte geblokkeerd
// worden. False negatives (weigering doorlaten) is een grotere business-risk
// dan false positives, dus we zijn conservatief STRIKT waar patterns duidelijk
// zijn en LOSSER waar 'ie ambigu is.

// Groepen patronen — elk teruggegeven met een reden-label voor audit-logs.
// Alle patterns matchen case-insensitive.

const REFUSAL_PATTERNS = [
  // Directe weigeringen door het model
  { pattern: /\b(ik|we)\s+kan(\s+dit(\s+bericht)?)?\s+niet\s+(genereren|schrijven|versturen|maken|beantwoorden|helpen)\b/i, reason: 'direct_refusal' },
  { pattern: /\bkan\s+ik\s+niet\s+(uitvoeren|doen|beantwoorden|helpen)\b/i, reason: 'direct_refusal' },
  { pattern: /\bik\s+ga\s+dit\s+bericht\s+niet\s+(versturen|schrijven|genereren)\b/i, reason: 'direct_refusal' },

  // Ethische / respectvolle overwegingen (meta-commentaar)
  { pattern: /\bhet\s+zou\s+niet\s+(oprecht|eerlijk|respectvol|integer|gepast|passend|correct)\b/i, reason: 'ethical_meta' },
  { pattern: /\bhet\s+voelt\s+niet\s+(oprecht|eerlijk|goed|passend|gepast)\b/i, reason: 'ethical_meta' },
  { pattern: /\bniet\s+ethisch\b/i, reason: 'ethical_meta' },
  { pattern: /\bin\s+strijd\s+met\s+.{0,40}\s+(belofte|beloftes|toezegging)\b/i, reason: 'ethical_meta' },

  // Referentie naar het gesprek in de 3e persoon (Lisa reflecteert i.p.v. spreekt)
  { pattern: /\bkijkend\s+naar\s+(dit|het|deze)\s+(gesprek|conversatie|thread)\b/i, reason: 'meta_reflection' },
  { pattern: /\b(in|uit)\s+(het|dit)\s+(vorige|voorgaande|eerdere)\s+gesprek\s+heb\s+ik\b/i, reason: 'meta_reflection' },
  { pattern: /\b(zoals|omdat)\s+ik\s+eerder\s+.{0,30}\s+(beloofd|toegezegd|aangegeven)\b/i, reason: 'meta_reflection' },
  { pattern: /\bmeerdere\s+keren\s+(expliciet\s+)?(beloofd|toegezegd|gezegd|aangegeven)\b/i, reason: 'meta_reflection' },
  { pattern: /\bhad\s+ik\s+(al\s+)?meerdere\s+keren\b/i, reason: 'meta_reflection' },

  // Lisa in de 3e persoon (Lisa refereert aan zichzelf als "Lisa")
  // Bewust conservatief: match op werkwoorden die commentaar impliceren, niet
  // op begroetingen als "Hi, ik ben Lisa!" — die zeggen "ik ben Lisa", niet "Lisa heeft".
  { pattern: /\bLisa\s+(heeft|had|zou|zal|moet(\s+niet)?|kan|kon)\s+/i, reason: 'lisa_third_person' },
  { pattern: /\b(dat|hoe)\s+Lisa\s+/i, reason: 'lisa_third_person' },

  // AI/model-referenties (breaking character)
  { pattern: /\b(als|zijnde)\s+(een\s+)?(AI|assistent|taalmodel|language\s*model|chatbot)\b/i, reason: 'ai_reference' },
  { pattern: /\bik\s+ben\s+(een\s+)?(AI|assistent|taalmodel|chatbot)\b/i, reason: 'ai_reference' },

  // Weigering-openers die typisch Anthropic/Claude gebruikt
  { pattern: /^ik\s+begrijp\s+.{0,80}\s+maar\s+ik\s+ga\b/i, reason: 'anthropic_style_refusal' },
  { pattern: /^het\s+spijt\s+me,?\s+maar\s+ik\s+kan\b/i, reason: 'anthropic_style_refusal' },
];

// Extra vlaggen: als de tekst te lang is voor een IG-DM (~500+ chars zonder
// natuurlijke inhoud), of alleen uit een uitleg bestaat. Deze zijn signal
// (geen harde reject) — we tellen ze mee bij "refused=true" alleen als er ook
// een pattern-match is.

/**
 * Detecteer of een gegenereerde string een weigering / meta-commentaar is.
 *
 * @param {string} text  Ruwe AI-output.
 * @returns {{refused: boolean, reason: string|null, matched_pattern: string|null}}
 *
 * Voorbeeld:
 *   looksLikeRefusal('Ik kan dit bericht niet genereren.')
 *     → { refused: true, reason: 'direct_refusal', matched_pattern: '...' }
 *   looksLikeRefusal('Hey! Bedankt voor het volgen 🙌')
 *     → { refused: false, reason: null, matched_pattern: null }
 */
export function looksLikeRefusal(text) {
  if (typeof text !== 'string') return { refused: false, reason: null, matched_pattern: null };
  const s = text.trim();
  if (!s) return { refused: false, reason: null, matched_pattern: null };

  for (const { pattern, reason } of REFUSAL_PATTERNS) {
    const m = s.match(pattern);
    if (m) return { refused: true, reason, matched_pattern: m[0].slice(0, 120) };
  }

  return { refused: false, reason: null, matched_pattern: null };
}

// Exporteer patterns voor tests + zodat we in de toekomst nieuwe patronen
// kunnen toevoegen zonder de detector-functie te wijzigen.
export const _REFUSAL_PATTERNS = REFUSAL_PATTERNS;
