// api/_lib/opvolging-vensters.js
//
// DE TWEE VENSTERS VAN DE DAG, EN DE DREMPEL VOOR ARCHIVEREN.
//
// Twee afspraken met een klok eraan:
//   1. Elke ingeplande lead krijgt vóór 09:00 een spraakbericht.
//   2. Wie dat kreeg en niet antwoordde, wordt tussen 12:00 en 13:00 gebeld.
//
// LET OP — DIT BESTAND HEEFT EEN TWEELING
// modules/klanten-v2/views/opvolging-v2.js draagt dezelfde vier functies en
// dezelfde drie constanten. Dat is met opzet: die view is een gewoon script en
// geen ES-module, dus importeren kan er niet. tests/opvolging-vensters.test.js
// draait beide op dezelfde invoer en vergelijkt de uitkomsten, zodat ze niet
// uit elkaar kunnen lopen zonder dat een test rood wordt. Wijzig je hier iets,
// wijzig het daar dan ook. Zelfde patroon als api/_lib/whatsapp-systeemtypes.js
// naast services/whatsapp-brug/lib/gebeurtenis.js.
//
// ALLES IN AMSTERDAMSE TIJD, NOOIT VIA toISOString(). Dat is UTC, en dan valt
// een gesprek van 00:30 op de vorige dag en zit een spraakbericht van 08:30 's
// winters ineens vóór de deadline die het net miste.

import { isUitgaand } from './opvolging-poging-telling.js';

const ZONE = 'Europe/Amsterdam';

export const SPRAAK_DEADLINE_UUR = 9;   // vóór 09:00; precies 09:00 is te laat
export const NABEL_VAN_UUR       = 12;  // vanaf 12:00, inclusief
export const NABEL_TOT_UUR       = 13;  // tot 13:00, exclusief

// De drempel waartegen een gearchiveerde lead afgemeten wordt: is er genoeg
// moeite gedaan voordat hij uit de lijst ging? Stond alleen in de browser;
// staat nu hier zodat het scherm en het dagrapport niet elk hun eigen getal
// krijgen. Drie belpogingen op drie VERSCHILLENDE dagen — drie keer op één
// middag is één poging op één dag.
export const ARCHIEF_MIN_DAGEN = 3;
export const ARCHIEF_MIN_WA    = 1;

/** Dag en minuut-van-de-dag van een tijdstip, in Amsterdamse tijd. */
export function inZone(ts) {
  const ms = ts == null ? NaN : new Date(ts).getTime();
  if (!Number.isFinite(ms)) return null;
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
  const m = {};
  for (const deel of dtf.formatToParts(new Date(ms))) m[deel.type] = deel.value;
  return {
    dag   : `${m.year}-${m.month}-${m.day}`,
    minuut: (+m.hour) * 60 + (+m.minute),
    tijd  : `${m.hour}:${m.minute}`,
  };
}

/** De kalenderdag in Amsterdam van een tijdstip. */
export function dagVan(ts) {
  const z = inZone(ts);
  return z ? z.dag : null;
}

// DE RICHTING KOMT UIT DE KOLOM, NIET UIT DE TEKST — isUitgaand leest
// `richting` uit opvolging_pogingen. Een parser op de zin in `resultaat` gaat
// iets anders meten zodra iemand hem anders formuleert.
function isSpraakVerstuurd(p) {
  return !!p && p.soort === 'spraakbericht' && isUitgaand(p);
}

/** Is dit iets dat de lead ons stuurde? */
function isAntwoord(p) {
  return !!p && (p.soort === 'whatsapp' || p.soort === 'spraakbericht') && !isUitgaand(p);
}

/**
 * Het spraakbericht van een dag: op tijd, te laat, of niet gebeurd.
 *
 * Alleen het EERSTE spraakbericht van die dag telt. Nog een keer inspreken om
 * 11:00 maakt de gemiste deadline niet ongedaan, en zou anders een gemiste
 * ochtend als gehaald laten tellen.
 */
export function beoordeelSpraak(pogingen, dag) {
  const vanDieDag = (Array.isArray(pogingen) ? pogingen : [])
    .filter(isSpraakVerstuurd)
    .map((p) => ({ p, z: inZone(p.tijdstip) }))
    .filter((x) => x.z && x.z.dag === dag)
    .sort((a, b) => a.z.minuut - b.z.minuut);
  if (vanDieDag.length === 0) return { staat: 'niet_gedaan', tijd: null };
  const eerste = vanDieDag[0];
  return {
    staat: eerste.z.minuut < SPRAAK_DEADLINE_UUR * 60 ? 'op_tijd' : 'te_laat',
    tijd : eerste.z.tijd,
  };
}

/**
 * Het nabellen van een dag.
 *
 * Nodig is het alleen als er een spraakbericht uitging én de lead niet
 * antwoordde. Wie wél antwoordde hoeft niet nagebeld; die staat op
 * 'niet_nodig' en telt niet mee als gemist.
 *
 * Een gesprek telt als op tijd binnen [12:00, 13:00). Daarbuiten is het te
 * laat — ook als het vroeger was: om 10:00 bellen is niet het afgesproken
 * moment. Het eerste gesprek van de dag bepaalt het oordeel.
 */
export function beoordeelNabel(pogingen, dag) {
  const lijst = Array.isArray(pogingen) ? pogingen : [];
  const spraak = beoordeelSpraak(lijst, dag);
  if (spraak.staat === 'niet_gedaan') return { staat: 'niet_nodig', reden: 'geen spraakbericht', tijd: null };

  const heeftGeantwoord = lijst
    .filter(isAntwoord)
    .map((p) => inZone(p.tijdstip))
    .some((z) => z && z.dag === dag);
  if (heeftGeantwoord) return { staat: 'niet_nodig', reden: 'heeft geantwoord', tijd: null };

  const calls = lijst
    .filter((p) => p && p.soort === 'call')
    .map((p) => inZone(p.tijdstip))
    .filter((z) => z && z.dag === dag)
    .sort((a, b) => a.minuut - b.minuut);
  if (calls.length === 0) return { staat: 'niet_gedaan', reden: null, tijd: null };

  const eerste = calls[0];
  const inVenster = eerste.minuut >= NABEL_VAN_UUR * 60 && eerste.minuut < NABEL_TOT_UUR * 60;
  return { staat: inVenster ? 'op_tijd' : 'te_laat', reden: null, tijd: eerste.tijd };
}

/** De twee oordelen samen, voor één taak op één dag. */
export function beoordeelDag(taak, dag) {
  const pg = (taak && taak.pogingen) || [];
  return { spraak: beoordeelSpraak(pg, dag), nabel: beoordeelNabel(pg, dag) };
}

/**
 * Tellingen over een lijst taken.
 *
 * Het nabellen telt alleen mee voor wie het nodig had; anders zakt de dekking
 * door mensen die gewoon geantwoord hebben.
 */
export function telVensters(taken, dag) {
  const leeg = { totaal: 0, op_tijd: 0, te_laat: 0, niet_gedaan: 0, niet_nodig: 0, niet_gemeten: 0 };
  const uit = { spraak: { ...leeg }, nabel: { ...leeg } };
  for (const t of (Array.isArray(taken) ? taken : [])) {
    const o = beoordeelDag(t, dag);
    uit.spraak.totaal += 1;
    uit.spraak[o.spraak.staat] += 1;

    // ── NABELLEN ZONDER KAART IS NIET GEMETEN ────────────────────────────
    // Een belpoging hangt aan een taak. Voor een zoomlead zonder opvolgkaart
    // bestaat die historiek niet, dus 'niet gebeld' zou geraden zijn — precies
    // het verwijt dat deze module nergens anders maakt. Het spraakbericht is
    // hier wél te meten: dat staat in opvolging_wa_berichten, die aan een
    // NUMMER hangt en geen kaart nodig heeft.
    if (t && t.zonderKaart && o.nabel.staat === 'niet_gedaan') { uit.nabel.niet_gemeten++; continue; }

    if (o.nabel.staat !== 'niet_nodig') { uit.nabel.totaal += 1; uit.nabel[o.nabel.staat] += 1; }
    else uit.nabel.niet_nodig += 1;
  }
  return uit;
}

/**
 * Is er genoeg moeite gedaan voordat deze lead uit de lijst ging?
 *
 * Geeft bewust drie uitkomsten terug en niet twee. 'n.v.t.' is er één van: een
 * kaart met reden_code 'zoom_geen_interesse' sloot omdat de lead tijdens de
 * call zélf nee zei. Daar 'te weinig moeite' op zetten is een verwijt voor iets
 * waar niets aan te doen viel.
 */
/**
 * De reden_codes waarbij 'te weinig moeite' een verwijt zou zijn voor iets waar
 * niets aan te doen viel — of waar juist wél iets gebeurd is.
 *
 *   zoom_geen_interesse  de lead zei tijdens de call zelf nee.
 *   naar_zoom            de lead wilde liever een zoomcall; die is geboekt en
 *                        hij is afgemeld voor het event. Dat is het beste
 *                        denkbare einde van zo'n kaart, en zonder deze regel
 *                        zou het met nul belpogingen als nalatigheid lezen.
 */
export const MOEITE_NVT = {
  zoom_geen_interesse: 'de lead zei tijdens de call zelf nee',
  naar_zoom          : 'omgezet naar een zoomcall — geen afhaker',
};

export function beoordeelMoeite({ bel_dagen, wa_totaal, reden_code, duur_bekend } = {}) {
  if (MOEITE_NVT[reden_code]) {
    return { staat: 'nvt', reden: MOEITE_NVT[reden_code] };
  }
  // ONBEKEND IS GEEN NEE.
  //
  // Op 7 september waren er drie gearchiveerde taken. Alle drie hadden
  // pogingen, en bij alle drie was duur_sec NULL — er is nooit een duur
  // gemeten. Er is dus geen enkel geval van 'gearchiveerd na een korte call';
  // er zijn drie gevallen van 'gearchiveerd zonder dat we weten hoe lang er
  // gebeld is'.
  //
  // Zou de gesprekgrens daar zonder meer op losgelaten worden, dan werden die
  // drie morgen alle drie een verwijt aan Dave voor iets wat de meting niet
  // weet. Dat is precies de valse beschuldiging waar dit rapport al drie keer
  // op is bijgestuurd. Onbekend hoort in de blinde vlekken, niet in de
  // bevindingen — zelfde principe als de calls die niet in de takenlijst staan.
  if (duur_bekend === false) {
    return { staat: 'onbekend', reden: 'van geen enkele call is de duur vastgelegd' };
  }
  const dagen = Number(bel_dagen || 0);
  const wa    = Number(wa_totaal || 0);
  if (dagen >= ARCHIEF_MIN_DAGEN && wa >= ARCHIEF_MIN_WA) return { staat: 'genoeg', reden: null };
  return { staat: 'te_weinig', reden: null };
}
