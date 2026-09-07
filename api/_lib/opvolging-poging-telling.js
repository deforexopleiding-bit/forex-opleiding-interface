// api/_lib/opvolging-poging-telling.js
//
// WAT TELT ALS EEN POGING VAN DAVE, EN WAT NIET.
//
// Op de kaart van één lead stond '12 van de 2, met 11 keer WhatsApp', terwijl er
// die dag zes dingen gebeurd waren: één tekstbericht verstuurd, één
// spraakbericht verstuurd, twee tekstantwoorden terug, één spraakbericht terug
// en één keer gebeld zonder gehoor. Twaalf rijen voor zes gebeurtenissen.
//
// Eén van de oorzaken hoort hier thuis: een antwoord van de lead werd een
// whatsapp-poging en telde mee in wa_vandaag. Maar de teller op die kaart gaat
// over de MOEITE DIE DAVE DOET, en een antwoord van de lead is geen moeite van
// Dave — dat is het resultaat ervan.
//
// DE BETEKENIS STAAT IN DE DATA, NIET IN EEN WOORD. De richting wordt gelezen
// uit de kolom `richting` op opvolging_pogingen (migratie
// 2026-09-06-opvolging-pogingen-richting.sql) en NIET afgeleid uit de tekst van
// `resultaat`. Dat laatste is een parser op een zin die iemand ooit anders
// formuleert, en dan telt de kaart weer iets anders dan wat er gebeurd is.
//
// Een rij zonder richting telt als 'uit'. Dat is de historische aanname — alles
// wat vóór deze kolom is weggeschreven was op één soort na uitgaand — en de
// opruim-query zet de inkomende rijen die er nog staan expliciet op 'in'.

// ═══════════════════════════════════════════════════════════════════════════
// HET RESULTAAT ZEGT OF ER CONTACT WAS. DE DUUR ZEGT ALLEEN HOE LANG.
// ═══════════════════════════════════════════════════════════════════════════
// Op 7 september is dit hele bouwwerk op `duur_sec` gezet met een grens van
// tien seconden. Dat was fout, en de meting bewijst het:
//
//   · duur_sec is het verschil tussen KIEZEN en OPHANGEN, dus inclusief
//     overgaan. Zie api/softphone-call-log.js: started_at wordt gezet vóór
//     inviter.invite().
//   · Bij rijen met resultaat 'niet opgenomen' staan duren tot 43 seconden.
//     Dat is overgaantijd, geen gesprek.
//   · Bij 'gesproken' loopt het van 4 tot 90 seconden, mediaan 24. Een gesprek
//     van 4 seconden bestaat dus echt.
//
// Een grens op dat getal scheidt dus niets: hij noemt 43 seconden overgaan een
// gesprek en 4 seconden gesprek een niet-gesprek. De tien seconden zijn
// daarmee vervallen als scheidslijn.
//
// WAT WEL WERKT is het veld dat er al was: `resultaat`. Dat is vrije tekst —
// er staat 'gesproken', 'niet opgenomen', 'gesproken: bevestigd' en
// 'gesproken: bevestigd — <notitie van Dave>' in — dus geen exacte
// gelijkheid maar een nette classificatie, op één plek.
//
// EN EEN ONBEKENDE WAARDE TELT NOOIT STIL ALS CONTACT. Die levert `null` op:
// niet gemeten. Liever niet gemeten dan onterecht groen — dezelfde regel als
// in de dagelijkse gezondheidscontrole.

export const GESPROKEN      = 'gesproken';
export const NIET_OPGENOMEN = 'niet_opgenomen';
/** Afgehandeld via iemand anders: wel een resultaat, geen eigen gesprek. */
export const VIA_ANDER      = 'via_ander';
export const ONBEKEND       = 'onbekend';
/** Wij hingen op voordat er werd opgenomen: geen poging van de lead én geen van ons. */
export const AFGEBROKEN      = 'afgebroken';

/**
 * Classificeer de vrije tekst in `resultaat`.
 *
 * Op VOORVOEGSEL, niet op gelijkheid: 'gesproken: bevestigd — hij komt met de
 * trein' hoort gewoon bij 'gesproken'. En 'via ander' wordt eerst getoetst,
 * want die tekst begint bewust NIET met 'gesproken' — er is namelijk niet
 * gesproken.
 */
export function classificeerResultaat(resultaat) {
  const t = String(resultaat == null ? '' : resultaat).toLowerCase().trim().replace(/\s+/g, ' ');
  if (!t) return ONBEKEND;
  if (t.startsWith('via ander') || t.startsWith('bevestigd via')) return VIA_ANDER;
  if (t.startsWith('gesproken')) return GESPROKEN;
  // Wij braken af voordat er werd opgenomen. Geen contact, en ook geen
  // 'niet opgenomen' — dat laatste zou een uitspraak over de lead zijn.
  if (t.startsWith('afgebroken')) return AFGEBROKEN;
  if (t.startsWith('niet opgenomen') || t.startsWith('niet_opgenomen')
      || t.startsWith('geen gehoor') || t.startsWith('geen_gehoor')) return NIET_OPGENOMEN;
  return ONBEKEND;
}

/**
 * De familie PLUS Daves eigen woorden, apart.
 *
 * Drie rijen hebben de vorm 'gesproken: bevestigd — neemt laptop mee' of
 * '... — Englese man'. Dat is de enige plek waar Daves oordeel over de uitkomst
 * bewaard is; die tekst hoort niet in een classificatie te verdwijnen.
 */
export function ontleedResultaat(resultaat) {
  const familie = classificeerResultaat(resultaat);
  const ruw = String(resultaat == null ? '' : resultaat).trim();
  // Alles na de eerste dubbele punt of gedachtestreepje is toelichting.
  const m = ruw.match(/^[^:—-]+(?:[:—-]\s*)(.+)$/);
  const staart = m ? m[1].trim() : '';
  // 'bevestigd' is de uitkomst zelf, geen notitie; wat daarná komt wel.
  const naBevestigd = staart.match(/^bevestigd\s*[—-]\s*(.+)$/i);
  return {
    familie,
    uitkomst: staart ? staart.split(/\s*[—-]\s*/)[0].trim() || null : null,
    notitie : naBevestigd ? naBevestigd[1].trim() : null,
  };
}

/** De soorten die als WhatsApp-moeite tellen. */
const WA_SOORTEN = new Set(['whatsapp', 'spraakbericht']);

/** Uitgaand, tenzij de rij expliciet zegt van niet. */
export function isUitgaand(p) {
  return !p || p.richting !== 'in';
}

/**
 * Telt deze poging als moeite van Dave?
 *
 * Alleen wat híj gedaan heeft. Een binnenkomend bericht blijft gewoon staan —
 * het is echt contact en het telt mee voor de archiveerregel — maar het is geen
 * poging.
 */
export function isMoeite(p) {
  return isUitgaand(p);
}

/**
 * Is er via deze rij echt contact geweest?
 *
 * Dit is een ANDERE vraag dan 'is het moeite', en met opzet: een antwoord van de
 * lead telt hier juist wél mee. Zonder dat onderscheid zou het weghalen van
 * antwoorden uit de pogingen ook de archiveerregel veranderen, en dan verdwijnt
 * iemand uit de lijst die net wél gereageerd heeft.
 */
export function isContact(p) {
  if (!p) return false;
  // Inkomend telt alleen voor berichtsoorten. Een 'agenda_doorgestuurd' of
  // 'ingepland' met richting 'in' zou anders stil als contact gaan tellen, en
  // dan verdwijnt iemand uit de lijst zonder dat er iemand gereageerd heeft.
  if (WA_SOORTEN.has(p.soort)) return !isUitgaand(p);
  // Of een gesprek tot stand kwam staat nog wél in `resultaat`. Daar is geen
  // kolom voor, en de twee waarden ('gesproken' / 'niet opgenomen') worden op
  // één plek geschreven: bouwCallPoging in _lib/opvolging-call-link.js. Dat is
  // iets anders dan de richting uit een zin afleiden — maar als deze ooit ook
  // een kolom verdient, is dit de plek.
  if (p.soort === 'call') {
    const k = classificeerResultaat(p.resultaat);
    if (k === GESPROKEN) return true;
    if (k === NIET_OPGENOMEN || k === VIA_ANDER || k === AFGEBROKEN) return false;
    // ONBEKEND: we weten het niet. Null, geen false — de aanroeper telt die
    // apart en het rapport meldt hem als blinde vlek. Stil op 'geen contact'
    // zetten zou iemand uit de lijst laten vallen op een aanname.
    return null;
  }
  return false;
}

/**
 * Kwam er een GESPREK tot stand?
 *
 * SINDS 8 SEPTEMBER BESLIST HET RESULTAAT, NIET DE DUUR. De vorige versie
 * hanteerde een grens van tien seconden op `duur_sec`; die grens is vervallen
 * omdat dat getal de tijd tussen kiezen en ophangen meet, inclusief overgaan.
 * Zie de kop van dit bestand voor de meting waarmee dat is vastgesteld.
 *
 * Drie uitkomsten, geen twee:
 *   true  — resultaat zegt 'gesproken' (of het is een binnengekomen bericht)
 *   false — 'niet opgenomen', of afgehandeld via iemand anders
 *   null  — het resultaat zegt niets bruikbaars: niet gemeten
 *
 * `minSec` wordt nog geaccepteerd zodat bestaande aanroepers niet breken, maar
 * er wordt niets meer mee gedaan. Hij verdwijnt zodra de laatste aanroeper 'm
 * niet meer meestuurt.
 */
export function isGesprek(p, _minSecVervallen) {
  const contact = isContact(p);
  if (contact === null) return null;
  if (!contact) return false;
  return true;
}

/**
 * Mag de duur van deze poging getoond worden, en zo ja welke?
 *
 * Alleen waar het resultaat zegt dat er gesproken is. Staat de duur er dan
 * niet, dan is het antwoord NIET nul maar 'niet geregistreerd' — een nul leest
 * als 'een gesprek van nul seconden' en dat is iets anders dan 'we weten de
 * lengte niet'.
 */
export function gesprekDuur(p) {
  if (!p || p.soort !== 'call') return { toon: false, sec: null };
  if (classificeerResultaat(p.resultaat) !== GESPROKEN) return { toon: false, sec: null };
  const ruw = p.duur_sec;
  if (ruw === null || ruw === undefined || !Number.isFinite(Number(ruw))) {
    return { toon: true, sec: null };     // gesproken, lengte onbekend
  }
  return { toon: true, sec: Number(ruw) };
}

/**
 * De afgeleide tellers voor één taak.
 *
 * Stond op twee plekken in api/opvolging-taken.js met dezelfde filterregel; nu
 * op één plek, zodat 'wat telt mee' niet op twee manieren kan gaan betekenen.
 */
export function telPogingen(hist, vandaagIso, dagVan) {
  const rijen = Array.isArray(hist) ? hist : [];
  const moeite = rijen.filter(isMoeite);
  const bel = moeite.filter((p) => p.soort === 'call');
  const wa  = moeite.filter((p) => WA_SOORTEN.has(p.soort));
  const dagen = new Set(bel.map((p) => dagVan(p.tijdstip)));
  return {
    pogingen      : rijen,
    pogingen_totaal: moeite.length,
    bel_totaal    : bel.length,
    bel_dagen     : dagen.size,
    wa_totaal     : wa.length,
    bel_vandaag   : bel.filter((p) => dagVan(p.tijdstip) === vandaagIso).length,
    wa_vandaag    : wa.filter((p) => dagVan(p.tijdstip) === vandaagIso).length,
    // Binnenkomend blijft zichtbaar, maar apart. Zo is op de kaart te zien dát
    // er gereageerd is zonder dat het als moeite meetelt.
    inkomend      : rijen.length - moeite.length,
    laatste_poging: rijen.length ? rijen[rijen.length - 1].tijdstip : null,
  };
}

export { WA_SOORTEN };
