// api/_lib/opvolging-lijst.js
//
// TWEE LIJSTEN IN ÉÉN TABEL — EN WELKE SCHERMEN WELKE LIJST ZIEN.
//
// Sinds 2 oktober 2026 staan er in opvolging_taken twee soorten kaarten:
//
//   lijst = 'dag'    — Daves daglijst zoals die al bestond: events, zoomcalls,
//                      aanmeldingen, handmatige leads. Alle 319 bestaande rijen.
//   lijst = 'leads'  — de leadkaarten van de tab 'Leads bellen': proefleads van
//                      de minicursus en de 7-daagse die Dave in trage momenten
//                      belt. Een kaart ontstaat pas als hij iets met de lead doet.
//
// Leadkaarten erven bewust alles wat al werkt (softphone-logging, WhatsApp-brug,
// pogingen-telling, agenda-boeken, 48u-wacht-check, doorrol) door gewone rijen
// in dezelfde tabel te zijn. De keerzijde: ELKE select die Daves bestaande
// schermen voedt moet de leadkaarten eruit filteren. In deze module is 'fix op
// één plek, afgeleide telling vergeten' al drie keer gebeurd — daarom staat het
// filter hier op één plek, en zoekt tests/opvolging-lijstfilter.test.js elke
// select op opvolging_taken in api/ af naar dit filter.
//
// Wat bewust BEIDE lijsten leest (wacht-check, doorrol, de brug-nummers, de
// webhook, de softphone-koppeling, taak-update, agenda, poging) staat in de
// whitelist van die test, met de reden erbij.

export const LIJST_DAG = 'dag';
export const LIJST_LEADS = 'leads';

/** Alleen Daves daglijst. Op een postgrest-query: `alleenDaglijst(q)`. */
export function alleenDaglijst(q) {
  return q.eq('lijst', LIJST_DAG);
}

/** Alleen de leadkaarten van 'Leads bellen'. */
export function alleenLeadlijst(q) {
  return q.eq('lijst', LIJST_LEADS);
}

/**
 * Voor een select op opvolging_pogingen: de embed die de lijst van de taak
 * meeneemt. Gebruik samen met pogingenAlleenDaglijst():
 *
 *   pogingenAlleenDaglijst(
 *     db.from('opvolging_pogingen').select('id, tijdstip, ' + POGING_LIJST_EMBED))
 *
 * `!inner` zorgt dat een poging zonder passende taak wegvalt; taak_id is NOT
 * NULL met een FK, dus er valt niets anders weg dan de leadkaarten.
 */
export const POGING_LIJST_EMBED = 'opvolging_taken!inner(lijst)';

export function pogingenAlleenDaglijst(q) {
  return q.eq('opvolging_taken.lijst', LIJST_DAG);
}

/** Is dit een leadkaart? Een rij zonder lijst-veld is een daglijstkaart. */
export function isLeadkaart(taak) {
  return !!taak && String(taak.lijst || LIJST_DAG) === LIJST_LEADS;
}
