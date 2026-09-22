// api/_lib/iris/spraak.js
//
// Welke weg neemt spraak naar tekst?
//
// ── DE BESLISSING DIE HIERONDER LIGT ─────────────────────────────────────────
// Maxim heeft gekozen: alleen Anthropic. Geen tweede leverancier, geen tweede
// rekening, geen tweede sleutel om te beheren. Dat is een prima keuze, maar hij
// heeft één gevolg dat je moet weten: de Anthropic-API doet géén spraak naar
// tekst. Claude kan een opname niet beluisteren.
//
// Dus komt de omzetting van de browser. Chrome en Edge hebben de Web Speech
// API ingebouwd — gratis, geen sleutel, en voor Nederlands goed genoeg. Wat er
// uit komt gaat daarna gewoon naar Claude, precies zoals eerst; alleen de
// eerste stap verhuist van de server naar het toetsenbord.
//
// ── WAAROM DE OPENAI-WEG BLIJFT STAAN ────────────────────────────────────────
// Hij is niet weggehaald, alleen optioneel geworden. Staat er ooit een
// OPENAI_API_KEY, dan wordt die gebruikt: gpt-4o-transcribe is nauwkeuriger bij
// eigennamen en werkt in élke browser, ook Safari en Firefox. Staat hij er niet
// — en dat is nu de bedoeling — dan is dat geen storing maar een keuze, en dan
// hoort er ook geen foutmelding te verschijnen.
//
// Dat verschil is het hele punt van dit bestandje. "Niet ingesteld" en "stuk"
// zien er in een scherm bijna hetzelfde uit, en het verschil ligt hier.

/**
 * Is er een OpenAI-sleutel ingesteld?
 *
 * Een functie en geen losse `if` in het endpoint, zodat de vraag op één plek
 * beantwoord wordt: de GET die het scherm vertelt welke weg te nemen, en de
 * POST die de weg bewaakt, mogen nooit verschillend antwoorden.
 *
 * @returns {boolean}
 */
export function openaiBeschikbaar(env = process.env) {
  return String(env?.OPENAI_API_KEY ?? '').trim().length > 0;
}

/**
 * Welke weg moet het scherm nemen?
 *
 * 'openai'  — er is een sleutel; stuur de opname naar /api/iris-transcribe.
 * 'browser' — geen sleutel; laat de browser meeluisteren.
 *
 * De browser kán het misschien niet (Safari, Firefox). Dat weet de server niet
 * en hoeft hij ook niet te weten: het scherm kijkt zelf of het kan en zegt het
 * als het niet kan. Deze functie beantwoordt alleen de vraag die op de server
 * thuishoort.
 */
export function spraakRoute(env = process.env) {
  return openaiBeschikbaar(env) ? 'openai' : 'browser';
}
