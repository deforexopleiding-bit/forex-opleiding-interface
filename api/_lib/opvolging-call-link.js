// api/_lib/opvolging-call-link.js
//
// Fase 2 DEEL A — een softphone-gesprek automatisch als belpoging bij een
// opvolgtaak laten landen.
//
// Waarom een eigen lib en niet in het endpoint: dit zijn drie besluiten die
// stil fout kunnen gaan (welk nummer hoort bij wie, welke taak, en wat betekent
// 'answered'), en precies daar wil je tests op kunnen zetten zonder Supabase.
// api/softphone-call-log.js roept ze aan in een fail-soft blok; wat hier
// misgaat mag het loggen van het gesprek zelf nooit tegenhouden.
//
// De koppeling kent twee wegen:
//   1. De Bellen-knop in de opvolgmodule stuurt de taak-id mee. Dat is de
//      zekere weg — geen giswerk.
//   2. Zonder id: matchen op genormaliseerd telefoonnummer, binnen een venster
//      van twee uur. Lukt dat niet eenduidig, dan gebeurt er niets. Een poging
//      bij de verkeerde persoon is erger dan een poging die ontbreekt: die
//      eerste vervuilt het oordeel in Afgerond, die tweede valt op.

/** Twee uur. Buiten dit venster koppelen we niet meer op nummer. */
export const KOPPEL_VENSTER_MS = 2 * 60 * 60 * 1000;

/**
 * Nummers staan door de hele database in verschillende notaties: met en zonder
 * landcode, met spaties, met haakjes, soms met een 00-prefix. Voor vergelijken
 * strippen we alles wat geen cijfer is.
 *
 * Zie ook lesson learned 18 in CLAUDE.md: eerst exact op de volle reeks, dan
 * pas terugvallen op de laatste negen cijfers (de lokale variant zonder
 * landcode). Die fallback is bewust apart — hij mag alleen gebruikt worden als
 * er precies één kandidaat overblijft.
 */
export function normaliseerTelefoon(raw) {
  if (raw == null) return null;
  const cijfers = String(raw).replace(/\D/g, '');
  if (!cijfers) return null;
  // 00 is de internationale kiescode en betekent hetzelfde als de +: zonder
  // deze regel zou '0032470123456' niet gelijk zijn aan '+32470123456' en viel
  // dezelfde persoon terug op de staart-vergelijking. Eén enkele 0 strippen we
  // NIET — dat is de nationale prefix en die is niet zomaar weg te denken.
  if (cijfers.startsWith('00')) return cijfers.slice(2) || null;
  return cijfers;
}

/** De laatste negen cijfers, of null als het er te weinig zijn. */
export function telefoonStaart(raw) {
  const cijfers = normaliseerTelefoon(raw);
  if (!cijfers || cijfers.length < 9) return null;
  return cijfers.slice(-9);
}

/**
 * Kies de taak waar dit gesprek bij hoort.
 *
 *   taken      — kandidaat-taken ({ id, telefoon, updated_at?, created_at? }).
 *                De caller levert alleen niet-gearchiveerde taken aan.
 *   toNumber   — het gebelde nummer uit de call-log.
 *   startedAt  — begin van het gesprek (ISO of Date).
 *   nu         — referentiemoment; injecteerbaar zodat de test niet van de
 *                klok afhangt.
 *
 * Geeft de taak terug, of null. Null is een volwaardige uitkomst: dan is er
 * gewoon niets te koppelen en gebeurt er niets.
 */
export function kiesTaakVoorCall({ taken, toNumber, startedAt, nu = Date.now(), vensterMs = KOPPEL_VENSTER_MS }) {
  const doel = normaliseerTelefoon(toNumber);
  if (!doel) return null;

  // Buiten het venster niet meer koppelen. Een call-log die veel later
  // binnenkomt (tab bleef open, herstelde queue) zou anders aan een taak
  // hangen waar op dat moment allang iets anders speelde.
  const start = startedAt ? new Date(startedAt).getTime() : NaN;
  if (!Number.isFinite(start)) return null;
  if (start > nu + 60000) return null;              // uit de toekomst: niet vertrouwen
  if (nu - start > vensterMs) return null;

  const lijst = Array.isArray(taken) ? taken.filter(Boolean) : [];
  if (lijst.length === 0) return null;

  // Meest recent aangeraakte taak eerst. Bij twee taken op hetzelfde nummer
  // (dezelfde persoon, twee events) is dat degene waar nu aan gewerkt wordt.
  const opRecentheid = (a, b) => tijdVan(b) - tijdVan(a);

  const exact = lijst.filter((t) => normaliseerTelefoon(t.telefoon) === doel);
  if (exact.length > 0) return exact.sort(opRecentheid)[0];

  // Terugval op de lokale variant zonder landcode. Alleen bij precies één
  // kandidaat — twee mensen met dezelfde laatste negen cijfers is zeldzaam,
  // maar dan is 'kies de eerste' een gok en die maken we niet.
  const staart = telefoonStaart(doel);
  if (!staart) return null;
  const bijnaam = lijst.filter((t) => telefoonStaart(t.telefoon) === staart);
  if (bijnaam.length === 1) return bijnaam[0];
  return null;
}

function tijdVan(t) {
  const v = t?.updated_at || t?.created_at || null;
  const ms = v ? new Date(v).getTime() : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * De rij zoals hij in opvolging_pogingen terechtkomt.
 *
 * `automatisch` staat vast op true: deze poging is niet door een mens
 * aangeklikt maar afgeleid uit de telefooncentrale. Dat onderscheid is het
 * halve punt van de tabel — in de historiek zie je aan het bliksem-icoon dat
 * dit gemeten is en niet gemeld.
 *
 * `resultaat` volgt de answered-marker die de softphone al meestuurt:
 * 'answered' betekent dat het gesprek daadwerkelijk tot stand kwam.
 */
export function bouwCallPoging({ taakId, outcomeHint, durationSec = null, callLogId = null }) {
  if (!taakId) return null;
  const gesproken = String(outcomeHint || '') === 'answered';
  const duur = Number.isFinite(durationSec) && durationSec >= 0 ? Math.round(durationSec) : null;
  return {
    taak_id    : taakId,
    soort      : 'call',
    automatisch: true,
    resultaat  : gesproken ? 'gesproken' : 'niet opgenomen',
    duur_sec   : duur,
    call_log_id: callLogId ? String(callLogId) : null,
  };
}
