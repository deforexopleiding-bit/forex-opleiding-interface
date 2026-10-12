// api/_lib/iris/werkbak.js
//
// Wacht er iemand op ons? — de regel, zonder databank.
//
// ── WAT ER MIS WAS ───────────────────────────────────────────────────────────
// Het filter was `status IN ('nieuw','wacht_op_ons')` plus "geen spamcategorie",
// en keek NERGENS naar wie het laatste bericht stuurde. Gemeten op 12 oktober:
// 569 gesprekken in de werkbak, waarvan er op basis van het laatste bericht
// maar 225 echt op ons wachtten. De andere 344 eindigden met een bericht van
// ons — een automatische herinnering ("Hoi Hanneke! Morgen is alweer je laatste
// dag…"), een systeemmelding, een antwoord dat al gegeven was.
//
// Een bakje dat voor 60% uit afgehandelde dingen bestaat, is een bakje waar je
// niet meer in kijkt. En dan mis je ook die 225.
//
// ── DRIE REGELS ──────────────────────────────────────────────────────────────
// 1. De bal ligt bij ons: er kwam iets binnen ná ons laatste bericht.
// 2. 'nieuw' hoort er niet in. Nog-niet-ingedeeld is niet hetzelfde als
//    op-ons-wachtend; dat is waarom leveranciersmail (360dialog Support) in de
//    werkbak stond. Die krijgt zijn eigen plek: "nog in te delen".
// 3. Systeemafzenders eruit. Onze eigen meldingen komen als INKOMENDE mail
//    binnen, dus regel 1 haalt ze er niet uit. De lijst staat in Instellingen
//    en begint leeg — wie daar staat verdwijnt uit de werkbak, en zo'n lijst
//    mag niet door code bedacht worden.
//
// ── WAAROM DE REGEL HIER STAAT EN NIET IN SQL ────────────────────────────────
// Een gegenereerde kolom zou het netst zijn, maar die toevoegen herschrijft de
// hele tabel onder een exclusief slot — niet te doen op een tabel waar twee
// mensen de hele dag in werken. En PostgREST kan twee kolommen van dezelfde rij
// niet met elkaar vergelijken. Dus: de kandidaten ophalen (id plus twee
// tijdstempels, rond de honderd bytes per gesprek) en de regel hier toepassen,
// vóór het pagineren. Zie MAX_KANDIDATEN en kiesWerkbak().
//
// ── WAAROM DIT BESTAND NIETS IMPORTEERT ──────────────────────────────────────
// De regel moet na te rekenen zijn zonder Supabase-omgevingsvariabelen. Een
// toets die omvalt op een ontbrekende SUPABASE_URL leert je alleen de toets te
// negeren.

/** De standen die een gesprek in de werkbak kúnnen brengen. */
export const WERKBAK_STATUSSEN = Object.freeze(['wacht_op_ons']);

/** De stand van een gesprek dat nog niet ingedeeld is. */
export const ONINGEDEELD = 'nieuw';

/**
 * Hoeveel kandidaten we hoogstens ophalen om de regel op toe te passen.
 *
 * ── WAAROM DE REGEL IN JS WORDT TOEGEPAST EN NIET IN SQL ─────────────────────
 * De regel vergelijkt twee kolommen van dezelfde rij met elkaar
 * (`laatste_inbound > laatste_outbound`). PostgREST kan dat niet: een filter
 * neemt een WAARDE, geen kolomverwijzing — `.gt('laatste_inbound',
 * 'laatste_outbound')` vergelijkt met de letterlijke tekst.
 *
 * De nette SQL-oplossing zou een gegenereerde kolom zijn, maar die toevoegen
 * herschrijft de hele tabel onder een exclusief slot. Dat is niet acceptabel op
 * een tabel waar twee mensen de hele dag in werken — dus: ophalen en hier
 * filteren.
 *
 * Wat we ophalen is klein: per gesprek alleen het id en twee tijdstempels, dus
 * rond de honderd bytes. Bij de 569 van 12 oktober is dat ~57 kB, en dat getal
 * loopt terug zodra de achterstand weggewerkt wordt. De grens zit er voor het
 * geval dat niet gebeurt: liever een lijst die zegt dat hij afgekapt is dan een
 * opvraging die de functie opblaast.
 */
export const MAX_KANDIDATEN = 2000;

/**
 * Ligt de bal bij ons? — dezelfde regel als de gegenereerde kolom.
 *
 * Deze JS-versie bestaat om twee redenen: om de regel te kunnen toetsen zonder
 * databank, en als terugval voor zolang de kolom nog niet gedraaid is.
 *
 * `laatste_inbound IS NULL` geeft false: een gesprek waarin de klant nooit iets
 * stuurde, wacht niet op ons.
 */
export function balBijOns(gesprek) {
  const inbound = gesprek?.laatste_inbound || null;
  const outbound = gesprek?.laatste_outbound || null;
  if (!inbound) return false;
  if (!outbound) return true;
  return String(inbound) > String(outbound);
}

/**
 * Van kandidaten naar één bladzijde.
 *
 * De regel wordt op de VOLLEDIGE kandidatenlijst toegepast en pas daarna wordt
 * er een bladzijde uit genomen. Andersom zou betekenen dat je een bladzijde van
 * vijftig ophaalt waarvan er dertig wegvallen — en dan klopt het aantal niet,
 * springt de cursor, en zie je bij het doorladen gesprekken dubbel of niet.
 *
 * @param {Array<{id: string, laatste_inbound?: string, laatste_outbound?: string}>} kandidaten
 *        in de volgorde waarin ze moeten staan
 * @param {{vanaf?: number, limiet?: number}} bladzijde
 * @returns {{ids: string[], totaal: number, afgekapt: boolean}}
 */
export function kiesWerkbak(kandidaten, { vanaf = 0, limiet = 50 } = {}) {
  const rijen = Array.isArray(kandidaten) ? kandidaten : [];
  const wachtend = rijen.filter(balBijOns);
  const start = Math.max(0, Number(vanaf) || 0);
  const eind = start + Math.max(1, Number(limiet) || 50);
  return {
    ids: wachtend.slice(start, eind).map((g) => g.id),
    totaal: wachtend.length,
    afgekapt: rijen.length >= MAX_KANDIDATEN,
  };
}
