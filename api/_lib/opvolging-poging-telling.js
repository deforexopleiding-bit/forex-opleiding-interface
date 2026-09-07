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
  if (p.soort === 'call') return /gesproken/.test(String(p.resultaat || '').toLowerCase());
  return false;
}

/**
 * Kwam er een GESPREK tot stand, en niet alleen een verbinding?
 *
 * DIT IS EEN ANDERE VRAAG DAN isContact, EN MET OPZET APART.
 *
 * isContact beantwoordt 'is de verbinding tot stand gekomen' — de vraag achter
 * de archiveerregel: heeft deze lead ooit gereageerd, of geven we hem te snel
 * op. Een opgenomen-en-weggedrukte call telt daar mee, want er is iemand
 * geweest.
 *
 * Het dagrapport stelt een andere vraag: hoeveel gesprekken heeft Dave gevoerd.
 * Op 7 september duurden negen uitgaande calls 26, 24, 4, 29, 1, 1, 22, 24 en 2
 * seconden, en het rapport meldde er zes als 'gesproken'. Drie daarvan duurden
 * één, één en twee seconden. Dat is opnemen en wegdrukken, of een beltoon —
 * geen gesprek. Zo meet het rapport iets anders dan het zegt, en wel in Daves
 * voordeel, en dat is precies wat een rapport over een persoon niet mag doen.
 *
 * Waarom hier en niet in het rapport: 'wat telt als contact' stond op 6
 * september op drie plekken tegelijk en de slechtste van de drie draaide. Deze
 * vraag hoort naast zijn buurvraag te staan, in één bestand, zodat het verschil
 * tussen de twee zichtbaar is in plaats van verspreid.
 *
 * Een call zonder duur levert `null` op, niet `false`: we weten het niet, en
 * dat is een derde geval. De aanroeper telt die apart.
 */
export function isGesprek(p, minSec) {
  if (!isContact(p)) return false;
  if (!p || p.soort !== 'call') return true;   // een WhatsApp-antwoord heeft geen duur
  const d = p.duur_sec;
  if (d === null || d === undefined || !Number.isFinite(Number(d))) return null;
  return Number(d) >= Number(minSec);
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
