// api/_lib/opvolging-terug-in-lijst.js
//
// 'TERUG IN DE LIJST' MOET DE TOESTAND ONGEDAAN MAKEN, NIET DE DATUM VERZETTEN.
//
// ── DE BUG, HELEMAAL TERUGGEVONDEN ───────────────────────────────────────
// Dave klikte op 9 september per ongeluk bij Sofia Vanat en Shudino Andrade op
// 'agenda doorgestuurd'. Beide kwamen daarmee op status `wacht_inplanning` met
// `agenda_doorgestuurd_at` gevuld (09:57 en 09:58) en `afspraak_gevonden_at`
// leeg. Op 'Terug in de lijst' drukken deed vervolgens NIETS.
//
// De knop postte `actie: 'verplaats'` met `due: vandaag`. Dat verzet alleen de
// DATUM. De status bleef `wacht_inplanning`, `agenda_doorgestuurd_at` bleef
// staan — en omdat de due al op vandaag stond, veranderde er letterlijk niets.
// Geen zichtbaar effect, geen foutmelding. Twee mensen zaten vast en er was
// geen enkele weg terug.
//
// Bijkomend bewijs dat de weergavekant die toestand niet kende: het woord
// `wacht_inplanning` kwam in de hele gedeployde view NUL keer voor.
//
// ── DE REGEL ─────────────────────────────────────────────────────────────
// De knop is het spiegelbeeld van `agenda_gestuurd`, dus hij hoort precies dat
// terug te draaien:
//
//   status                 → 'open'
//   agenda_doorgestuurd_at → null
//   due                    → vandaag
//   later                  → false
//
// Zonder de eerste twee blijft de kaart in een toestand die de dagweergave niet
// toont (die filtert op `status='open'`), en dan is 'terug in de lijst' een
// belofte die het scherm niet waarmaakt.
//
// ── WAT HIJ BEWUST NIET AANRAAKT ─────────────────────────────────────────
// `afspraak_ref` en `afspraak_gevonden_at` blijven staan. Die horen bij de
// actie 'ingepland' en zijn een vondst, geen toestand die deze knop heeft
// gezet. Weggooien zou informatie vernietigen die niemand terug kan halen; ze
// staan een open kaart ook niet in de weg.

const DATUM_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * De patch die 'Terug in de lijst' op een taak zet.
 *
 * Pure functie zodat de regel in een test staat en niet alleen in productie
 * zichtbaar is — dat was bij deze knop precies het probleem.
 *
 * @param {string} vandaag 'JJJJ-MM-DD' in Amsterdamse tijd
 * @returns {object|null} null bij een onbruikbare datum: liever niets doen dan
 *   een kaart op een onzin-datum zetten.
 */
export function terugInLijstPatch({ vandaag }) {
  if (!DATUM_RE.test(String(vandaag || ''))) return null;
  return {
    status                : 'open',
    agenda_doorgestuurd_at: null,
    due                   : vandaag,
    later                 : false,
  };
}

/**
 * Staat een taak met deze patch daadwerkelijk in de daglijst van vandaag?
 *
 * api/opvolging-taken.js selecteert `status = 'open'` en `due <= vandaag`. Deze
 * functie rekent dat na, zodat de test niet hoeft te geloven dat de patch
 * genoeg is maar het kan controleren tegen de echte voorwaarde.
 */
export function staatInDaglijst(taak, vandaag) {
  if (!taak) return false;
  return String(taak.status) === 'open'
    && DATUM_RE.test(String(taak.due || ''))
    && String(taak.due) <= String(vandaag);
}
