// api/_lib/iris/ochtendantwoord.js
//
// "Heeft Iris vannacht iets gedaan dat ik moet weten?"
//
// ── WAAROM EEN LOGBOEK DAT NIET IS ───────────────────────────────────────────
// Het logboek is een logboek: regel voor regel, nieuwste bovenaan, precies wat
// er gebeurde. Dat is het juiste ding om te hebben als je iets uitzoekt, en het
// verkeerde ding om 's ochtends naar te kijken. Waar je dan mee zit is één
// vraag, en een chronologische lijst dwingt je het antwoord er zelf uit te
// halen -- veertig regels lezen om te concluderen dat er niets bijzonders was.
//
// Dit bestand maakt van diezelfde regels een antwoord: hoeveel, wat ervan
// misging, en welk soort handeling hoe vaak voorkwam. Dezelfde gegevens, andere
// vraag.
//
// Let op: dit is NIET api/_lib/iris/ochtend.js. Die bestaat al en gaat over
// het ochtendOVERZICHT en de gezondheidsmetingen (vier vragen, vier blokken).
// Dit bestand gaat over één vraag aan het LOGBOEK. Twee dingen met bijna
// dezelfde naam is vragen om een vergissing, dus staat het hier: als je de
// gezondheid zoekt, moet je in ochtend.js zijn.
//
// ── HET VENSTER ──────────────────────────────────────────────────────────────
// "Vannacht" is niet "de laatste 24 uur" en ook niet "sinds middernacht". Wie
// om negen uur kijkt, wil weten wat er is gebeurd sinds hij gisteren wegging --
// en dat is de avond ervoor plus de nacht. Vandaar: vanaf 18:00 van de vorige
// dag, tenzij het zelf nog vóór 18:00 is op dezelfde dag.
//
// Een vast uur en geen bijgehouden "laatste bezoek": dat laatste zou een kolom
// vragen, en een kolom die bij elke paginaweergave geschreven wordt, is een
// schrijfactie per seconde voor een vraag die één keer per ochtend gesteld
// wordt.
//
// Dit bestand importeert niets.

/** Vanaf welk uur van de vorige dag "vannacht" begint. */
export const AVOND_UUR = 18;

/** Hoeveel mislukkingen er hoogstens uitgeschreven worden. */
export const MAX_FOUTEN = 5;

/** Hoeveel soorten handelingen er hoogstens genoemd worden. */
export const MAX_GROEPEN = 8;

/**
 * Het begin van het venster.
 *
 * Werkt in UTC, net als de tijdstempels in iris_log. Dat is grover dan de
 * Brusselse klok maar het scheelt hier niets: het venster is een grens van
 * vijftien uur, en een uur verschuiving verandert niet welke regels erin
 * vallen -- alleen welke rand.
 */
export function vensterVanaf(nu = new Date()) {
  const d = new Date(nu.getTime());
  if (d.getUTCHours() >= AVOND_UUR) {
    // Het is al avond: "vannacht" begint vanavond.
    d.setUTCHours(AVOND_UUR, 0, 0, 0);
    return d;
  }
  d.setUTCDate(d.getUTCDate() - 1);
  d.setUTCHours(AVOND_UUR, 0, 0, 0);
  return d;
}

/**
 * Van logregels naar een antwoord.
 *
 * @param {Array} regels  zoals iris-log ze teruggeeft (al gemaskeerd)
 * @returns {{vanaf: string, totaal: number, mislukt: number, door_iris: number,
 *            door_mensen: number, groepen: Array, fouten: Array, kop: string}}
 */
export function ochtendantwoord(regels, { nu = new Date() } = {}) {
  const vanaf = vensterVanaf(nu);
  const lijst = (Array.isArray(regels) ? regels : []).filter((r) => {
    if (!r || !r.wanneer) return false;
    const t = Date.parse(r.wanneer);
    return Number.isFinite(t) && t >= vanaf.getTime();
  });

  const fouten = [];
  const perSoort = new Map();
  let mislukt = 0;
  let doorIris = 0;
  let doorMensen = 0;

  for (const r of lijst) {
    const mis = !!r.fout || r.resultaat === 'fout';
    if (mis) mislukt++;
    if (r.wie) doorMensen++; else doorIris++;
    if (mis && fouten.length < MAX_FOUTEN) {
      fouten.push({ wanneer: r.wanneer, wat: r.wat || null, fout: r.fout || null });
    }

    // Groeperen op de SOORT handeling, niet op de hele regel. "opvolging
    // gesloten: er kwam iets binnen" en "opvolging gesloten: ..." zijn
    // hetzelfde soort; het stuk na de dubbele punt is het geval.
    const soort = soortVan(r.wat);
    const g = perSoort.get(soort) || { wat: soort, aantal: 0, mislukt: 0, laatste: null };
    g.aantal++;
    if (mis) g.mislukt++;
    if (!g.laatste || String(r.wanneer) > String(g.laatste)) g.laatste = r.wanneer;
    perSoort.set(soort, g);
  }

  const groepen = [...perSoort.values()]
    // Wat misging eerst, dan wat het vaakst gebeurde. Een groep met één fout
    // erin is belangrijker dan een groep met veertig keer "gelukt".
    .sort((a, b) => (b.mislukt - a.mislukt) || (b.aantal - a.aantal))
    .slice(0, MAX_GROEPEN);

  return {
    vanaf: vanaf.toISOString(),
    totaal: lijst.length,
    mislukt,
    door_iris: doorIris,
    door_mensen: doorMensen,
    groepen,
    fouten,
    kop: kopTekst(lijst.length, mislukt),
  };
}

/**
 * De soort handeling uit een logregel.
 *
 * Alles vóór de eerste dubbele punt. De schrijvers in deze module hanteren
 * allemaal "wat er gebeurde: welk geval", dus dat is een betrouwbare grens --
 * en valt hij weg, dan is de hele regel de soort en klopt het nog steeds.
 */
export function soortVan(wat) {
  const s = String(wat || '').trim();
  if (!s) return 'onbekend';
  const i = s.indexOf(':');
  return (i > 0 ? s.slice(0, i) : s).trim().slice(0, 80);
}

/**
 * De ene zin bovenaan.
 *
 * Bij nul handelingen staat er niet "0 handelingen" maar wat je wilde weten:
 * er is niets gebeurd dat je moet weten. Een getal is een antwoord op "hoeveel",
 * niet op "moet ik iets".
 */
export function kopTekst(totaal, mislukt) {
  if (!totaal) return 'Iris heeft niets gedaan sinds gisteravond.';
  if (!mislukt) {
    return totaal === 1
      ? 'Eén handeling sinds gisteravond, en die ging goed.'
      : `${totaal} handelingen sinds gisteravond, en alles ging goed.`;
  }
  return mislukt === 1
    ? `${totaal} handelingen sinds gisteravond. Eén ervan ging mis.`
    : `${totaal} handelingen sinds gisteravond. ${mislukt} ervan gingen mis.`;
}
