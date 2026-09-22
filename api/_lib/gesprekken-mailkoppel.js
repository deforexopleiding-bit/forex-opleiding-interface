// api/_lib/gesprekken-mailkoppel.js
//
// MAIL BIJ EEN GESPREK DAT NOG GEEN KLANT HEEFT — gat G6.
//
// `inbox-thread-unified` haalt de mail op met `.eq('customer_id', …)`. Geen
// klantkoppeling betekent dus: geen mail in de draad.
//
// Dat is omgekeerd aan wat je nodig hebt. Juist bij een gesprek dat nog niet
// gekoppeld is, wil je álle context die er is — misschien staat in een mail van
// vorige week precies wie dit is. Nu krijg je een kale WhatsApp-draad en moet
// je zelf gaan zoeken, en dat is het moment waarop mensen het opgeven.
//
// ── DE BRUG IS HET CONTACT ───────────────────────────────────────────────────
// Een telefoonnummer en een mailadres hebben geen gemeenschappelijke kolom.
// Wat ze wél verbindt is `iris_contacten`: één rij per persoon, met zijn
// adressen én zijn nummers, óók als er geen klant aan hangt. Dat is precies
// waar die tabel voor gemaakt is.
//
// Dat betekent een afhankelijkheid van Iris, en die is bewust: de audit
// schrijft dit zelf voor ("Iris lost dit op door mail aan het contact te hangen
// in plaats van aan de klant"). Draait Iris niet, dan vindt deze weg niets en
// blijft de draad zoals hij was. Geen fout, geen melding — alleen niets extra's.
//
// ── LET OP DE OPSLAGVORM VAN DE NUMMERS ──────────────────────────────────────
// Het commentaar bij `iris_contacten.telefoons` in de migratie zegt "E.164 met
// een plus ervoor". De code slaat ze op via `normaliseerTelefoon()`, en dat is
// `stripToDigits` — dus ALLEEN CIJFERS, zonder plus. De code is wat telt, want
// dat is wat er in de rijen staat. Wie hier op `+32…` zoekt, vindt niets en
// concludeert ten onrechte dat er geen contact is.

import { stripToDigits, last9Digits } from './phone-normalize.js';

/** Meer dan dit aantal adressen per persoon is geen persoon meer. */
export const MAX_ADRESSEN = 10;

/**
 * Een adres dat veilig in een PostgREST-filter past.
 *
 * Bewust krap: letters, cijfers en de leestekens die in een mailadres horen.
 * Geen komma's, haakjes of aanhalingstekens — díe hakken een `or()`-reeks in
 * stukken, en dan zoekt de opvraging ineens iets anders dan bedoeld. Dat is
 * dezelfde les als in _lib/iris/zoekfilter.js, en hij geldt hier opnieuw omdat
 * de adressen uit een tabel komen en niet uit een keuzelijst.
 *
 * Een adres dat hier niet doorheen komt, slaan we over. Eén adres minder in de
 * draad is goedkoper dan een opvraging die iets anders doet dan je denkt.
 */
const VEILIG_ADRES = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

/**
 * De mailadressen van een contact, opgeschoond.
 *
 * @param {{emails?: Array}|null} contact
 * @returns {string[]} kleine letters, getrimd, uniek, veilig als zoekterm
 */
export function mailadressenVan(contact) {
  const ruw = Array.isArray(contact?.emails) ? contact.emails : [];
  const uit = [];
  const gezien = new Set();
  for (const e of ruw) {
    const adres = String(e ?? '').trim().toLowerCase();
    // Een adres zonder apenstaartje is geen adres; het zou als zoekterm alles
    // of niets opleveren, en allebei is fout.
    if (!adres || !VEILIG_ADRES.test(adres)) continue;
    if (gezien.has(adres)) continue;
    gezien.add(adres);
    uit.push(adres);
    if (uit.length >= MAX_ADRESSEN) break;
  }
  return uit;
}

/**
 * Waarop zoeken we het contact bij dit gesprek?
 *
 * Geeft de twee vormen terug die `iris_contacten.telefoons` kan bevatten: de
 * volledige cijferreeks, en de laatste negen als terugval voor een nummer dat
 * ooit zonder landcode is opgeslagen.
 *
 * @returns {{volledig: string|null, staart: string|null}}
 */
export function telefoonSleutels(telefoon) {
  const volledig = stripToDigits(telefoon);
  if (!volledig) return { volledig: null, staart: null };
  const staart = last9Digits(volledig);
  return {
    volledig,
    // Gelijk aan het volledige nummer? Dan is het geen tweede kans maar
    // dezelfde vraag nog een keer.
    staart: staart && staart !== volledig ? staart : null,
  };
}

/**
 * Mag deze draad langs de contact-omweg?
 *
 * Alleen als er GEEN klant is. Is die er wel, dan is de bestaande weg
 * nauwkeuriger: die kijkt naar wat er aan de klant hangt, en dat is meer dan
 * wat er aan één persoon hangt.
 */
export function viaContactZoeken({ customerId, telefoon, vlagAan }) {
  if (vlagAan !== true) return false;
  if (customerId) return false;
  return !!stripToDigits(telefoon);
}

/**
 * Bouw de `or()`-reeks voor een kolom en een lijst adressen.
 *
 * `ilike` en niet `in`, want IMAP levert adressen aan in de vorm waarin de
 * afzender ze typte — Jan.Janssen@Voorbeeld.BE komt echt voor. Een exacte
 * vergelijking mist die, en dan lijkt er gewoon geen mail te zijn.
 *
 * @returns {string|null} null als er niets te zoeken valt
 */
export function orReeks(kolom, adressen) {
  const lijst = (Array.isArray(adressen) ? adressen : []).filter((a) => VEILIG_ADRES.test(String(a)));
  if (!lijst.length) return null;
  return lijst.map((a) => `${kolom}.ilike.${a}`).join(',');
}
