// api/_lib/opvolging-testrijen.js
//
// TESTRIJEN UIT DE CIJFERS, OP ÉÉN PLEK.
//
// Er zitten DRIE verschillende dingen in de data, en dat bepaalt de oplossing:
//
//   1. Een taak die overduidelijk nep is — 'test test2' met test@gmail.com.
//   2. Een taak op een echte naam en een echt nummer, gebruikt als proefkaart.
//   3. Een POGING met resultaat 'gesproken: test' op Jeffrey Biemold, en dat
//      is een ECHTE lead. De testcall zit dus op een echte kaart.
//
// Geval 3 sluit de makkelijke oplossingen uit. Filteren op de naam van de lead
// mist hem, want de kaart is echt. En filteren op het woord 'test' in de
// resultaattekst is precies de tekstherkenning waarvan we bij snelle_notitie
// hebben afgesproken dat we er niet permanent op bouwen: vroeg of laat schrijft
// iemand een notitie waar 'test' in staat, en dan verdwijnt er echt werk uit de
// cijfers. EEN VERDWIJNENDE BELPOGING IS ERGER DAN EEN TESTRIJ DIE MEETELT.
//
// Vandaar een expliciete vlag, op twee niveaus:
//   · opvolging_taken.is_test    — de hele kaart is nep
//   · opvolging_pogingen.is_test — één losse testhandeling op een echte kaart
//
// Boolean, NOT NULL, DEFAULT FALSE: alles wat er al staat telt vanzelf gewoon
// mee en er verdwijnt niets stilletjes bij het draaien van de migratie.
//
// ── DE KOLOM MAG ONTBREKEN ────────────────────────────────────────────────
// Tussen de deploy en het draaien van de migratie mag er geen seconde zijn
// waarin het rapport stukstaat, in welke volgorde die twee ook gebeuren. Een
// SELECT die `is_test` bij naam noemt faalt met 42703 zolang de kolom er niet
// is — en dan faalt de HELE query, niet alleen dat veld. Zelfde patroon als
// writeUitkomst in api/follow-up-appointment-outcome.js: één keer proberen mét,
// bij 42703 opnieuw zonder, en dan gedraagt alles zich als voorheen.

/** Postgres: kolom bestaat niet. */
const KOLOM_ONBEKEND = '42703';

export function isKolomOnbekend(error, kolom = 'is_test') {
  if (!error) return false;
  if (error.code === KOLOM_ONBEKEND) return true;
  const m = String(error.message || '').toLowerCase();
  return m.includes('column') && m.includes(kolom.toLowerCase()) && m.includes('does not exist');
}

/**
 * Een SELECT draaien die `is_test` meeneemt, en terugvallen als de kolom er
 * nog niet is.
 *
 * @param {(kolommen:string)=>Promise<{data,error}>} query  krijgt de kolomlijst
 * @param {string} kolommen  zonder is_test
 * @returns {{ data, error, kolomAanwezig }}
 */
export async function haalMetTestvlag(query, kolommen) {
  const eerst = await query(kolommen + ', is_test');
  if (!eerst.error) return { data: eerst.data || [], error: null, kolomAanwezig: true };
  if (!isKolomOnbekend(eerst.error)) return { data: [], error: eerst.error, kolomAanwezig: true };
  // De migratie is nog niet gedraaid. Alles telt mee, precies zoals gisteren.
  const nogmaals = await query(kolommen);
  return { data: nogmaals.data || [], error: nogmaals.error || null, kolomAanwezig: false };
}

/** Een rij is een testrij als de vlag expliciet true is. Niets anders telt. */
export const isTestrij = (r) => r?.is_test === true;

/**
 * Echte rijen en testrijen uit elkaar, met de tel erbij.
 *
 * Geeft ALLEBEI terug, want het aantal weggelaten rijen hoort zichtbaar te
 * zijn: een filter dat je niet ziet is een filter dat je op een dag vergeet, en
 * dan zoek je een uur naar twee ontbrekende belpogingen.
 */
export function scheidTestrijen(rijen) {
  const alles = Array.isArray(rijen) ? rijen : [];
  const test = alles.filter(isTestrij);
  return { echt: alles.filter((r) => !isTestrij(r)), test, aantalTest: test.length };
}

/**
 * Pogingen filteren, óók op de kaart waar ze aan hangen.
 *
 * Een poging op een testkaart is zelf een testhandeling, ook als zijn eigen
 * vlag false staat. Andersom niet: een testpoging op een echte kaart valt weg
 * zonder dat de kaart iets wordt aangedaan — dat is geval 3.
 */
export function filterPogingen(pogingen, testTaakIds = new Set()) {
  const alles = Array.isArray(pogingen) ? pogingen : [];
  const test = alles.filter((p) => isTestrij(p) || (p?.taak_id && testTaakIds.has(p.taak_id)));
  const weg = new Set(test);
  return { echt: alles.filter((p) => !weg.has(p)), test, aantalTest: test.length };
}

/** De zin onder het volumeblok. Leeg als er niets is weggelaten. */
export function testZin({ pogingen = 0, taken = 0, kolomAanwezig = true }) {
  if (!kolomAanwezig) {
    return 'Testrijen worden nog niet apart gehouden: de kolom is_test bestaat nog niet, ' +
           'dus alles telt mee.';
  }
  if (!pogingen && !taken) return '';
  const delen = [];
  if (pogingen) delen.push(`${pogingen} testhandeling${pogingen === 1 ? '' : 'en'}`);
  if (taken) delen.push(`${taken} testkaart${taken === 1 ? '' : 'en'}`);
  return delen.join(' en ') + ' buiten de telling gehouden.';
}
