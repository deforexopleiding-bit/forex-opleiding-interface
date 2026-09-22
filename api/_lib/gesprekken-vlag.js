// api/_lib/gesprekken-vlag.js
//
// De schakelaar van de vernieuwde gesprekken-weergave.
//
// Sectie 1c van de opdracht vraagt de gesprekken-module te verbeteren, en de
// audit (docs/iris/02-gesprekken-audit.md) zet daar één harde voorwaarde bij:
// de vlag uit betekent het bestaande scherm, byte-identiek gedrag. Dit is de
// enige plek waar die vlag gelezen wordt, zodat er geen tweede plek kan
// ontstaan die 'em nét anders leest.
//
// Waarom een omgevingsvariabele en geen rij in de databank: het gaat om de
// weergave van een scherm dat twee mensen de hele dag openhebben. Zo'n
// schakelaar hoort buiten het systeem te staan dat hij wijzigt — draait de
// nieuwe weergave niet goed, dan is de weg terug een variabele omzetten en
// opnieuw uitrollen, en die weg hangt niet af van of de databank meewerkt.
//
// Alles behalve een uitdrukkelijke 'true' is nee. Een lege waarde, een typefout
// of een ontbrekende variabele geven allemaal het oude scherm — de kant waar
// een vergissing niets kost.

/** @returns {boolean} */
export function gesprekkenV2Aan(env = process.env) {
  return String(env?.GESPREKKEN_V2 ?? '').trim().toLowerCase() === 'true';
}
