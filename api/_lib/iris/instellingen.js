// api/_lib/iris/instellingen.js
//
// De schakelaars van Iris, en de regel dat ze bij twijfel uit staan.
//
// ── WAAROM DIT BESTAND BESTAAT ───────────────────────────────────────────────
// Iris mag namens het bedrijf naar klanten praten. Dat is een bevoegdheid die
// je niet aanzet door code te deployen, maar door een schakelaar om te zetten —
// en die schakelaar hoort op één plek te staan, met één manier om hem te lezen.
// Staat hij op twee plekken, dan staat hij vroeg of laat op twee standen.
//
// ── DE HARDE REGEL: LEEG IS UIT ──────────────────────────────────────────────
// Elke onzekerheid valt naar 'uit'. Geen rij in de databank: uit. Databankfout:
// uit. Onbekende waarde in de kolom: uit. Categorie die we niet kennen: uit.
//
// Dat is niet hetzelfde als faalzacht elders in dit repo. De aanmaanmotor valt
// bij een leesfout naar de VOORZICHTIGE kant en dat betekent daar: niet manen.
// Hier betekent voorzichtig: niet praten. In beide gevallen kiest de code de
// kant waar een fout het goedkoopst is. Een bericht dat een uur later komt is
// een ongemak; een bericht dat nooit had mogen vertrekken is een klant minder.
//
// ── WAT ER NIET DOOR EEN INSTELLING HEEN KOMT ────────────────────────────────
// `opzeg_klacht_juridisch` kan niet op 'zelf'. Niet omdat de instelling het
// verbiedt, maar omdat deze module het weigert — ook als er 'zelf' in de
// databank staat, ook als iemand het met de hand heeft gezet, ook als een
// toekomstig scherm het per ongeluk aanbiedt. Opzeggingen, klachten en alles
// wat juridisch kan worden zijn het soort bericht waar één verkeerde zin geld
// kost. Daar hoort een mens bij, en dat is geen instelling maar een eigenschap.
//
// Zelfde redenering als lesson learned 24 in CLAUDE.md: we vertrouwen het model
// niet om binnen de grenzen te blijven, we dwingen ze af in code, los van wat
// er gegenereerd of ingesteld wordt.
//
// ── EN DE HOOFDSCHAKELAAR ────────────────────────────────────────────────────
// Boven alles staat IRIS_AAN. Staat die niet uitdrukkelijk op 'true', dan is
// elke categorie 'uit', wat er ook in de databank staat. Zo is er altijd één
// knop die alles stillegt zonder dat er iets uitgezocht hoeft te worden.

/** De tien categorieën. Gelijk aan de CHECK op iris_berichten.categorie. */
export const CATEGORIEEN = Object.freeze([
  'facturatie',
  'betaalafspraak',
  'wanbetaling_reactie',
  'lms_toegang',
  'lms_support',
  'planning_mentor',
  'opzeg_klacht_juridisch',
  'bounce_systeem',
  'overig',
  'spam',
]);

/**
 * Categorieën waar geen mens iets mee hoeft te doen.
 *
 * ── WAAROM DIT EEN APARTE LIJST IS EN GEEN STATUS ───────────────────────────
 * `spam` is een echte categorie — reclame, phishing, onzin — en templates.js
 * geeft er terecht geen enkele antwoordsjabloon voor. Iris ziet dus prima dat
 * "Meta for Business" geen klant is. En dan zette cron-iris-werk de status
 * alsnog op `wacht_op_ons`, want dat deed hij voor élk ingedeeld bericht.
 * Daarmee was het verschil tussen een triage-hulp en gewoon een tweede inbox
 * precies één regel code.
 *
 * De stand staat NIET in `iris_gesprekken.status`. Die kolom heeft een CHECK
 * met vijf waarden; er een zesde bij zetten is een migratie, en een migratie
 * die nog niet gedraaid is, is een kapotte schrijfactie. Bovendien zou het
 * dezelfde wetenschap op twee plekken zetten: de categorie zegt het al.
 *
 * `bounce_systeem` staat hier met opzet NIET bij. Een onbestelbare mail ziet
 * eruit als ruis, maar betekent vaak dat een adres dood is — en dat is werk.
 *
 * Is een gesprek verkeerd ingedeeld, dan zet één klik het terug (iris-indeling).
 * Dat is meteen de plek waar zichtbaar wordt dat Iris het mis had.
 */
export const GEEN_WERK = Object.freeze(['spam']);

/**
 * Hoort een gesprek met deze categorie in de werkbak?
 *
 * Een lege of onbekende categorie hoort er WÉL in: nog-niet-ingedeeld is geen
 * reden om iets te verbergen. Dat is de veilige kant — te veel tonen kost
 * aandacht, te weinig tonen kost een klant.
 */
export function hoortInWerkbak(categorie) {
  const c = String(categorie || '').trim();
  if (!c) return true;
  return !GEEN_WERK.includes(c);
}

/**
 * Het PostgREST-filter dat de werkbak nodig heeft, als or-tekenreeks.
 *
 * ── DE VAL DIE HIER IN ZIT ──────────────────────────────────────────────────
 * Het voor de hand liggende `.not('categorie','in','(spam)')` wordt in SQL
 * `NOT (categorie IN ('spam'))`, en dat is NULL voor een rij zonder categorie
 * — dus die rij valt weg. Precies de nog-niet-ingedeelde gesprekken, die het
 * hardst op iemand wachten, zouden dan uit de werkbak verdwijnen.
 *
 * Vandaar de expliciete `categorie.is.null` ernaast.
 */
export function werkbakCategorieFilter(geenWerk = GEEN_WERK) {
  return `categorie.is.null,categorie.not.in.(${geenWerk.join(',')})`;
}

/** De drie standen. 'uit' = niets. 'concept' = schrijven, niet sturen. 'zelf' = sturen. */
export const STANDEN = Object.freeze(['uit', 'concept', 'zelf']);

/**
 * Categorieën die nooit op 'zelf' mogen, wat de databank ook zegt.
 * Zie de toelichting bovenaan: dit is een eigenschap, geen instelling.
 */
export const NOOIT_ZELF = Object.freeze(['opzeg_klacht_juridisch']);

/** Wat er geldt als er niets ingesteld is. Alles uit. */
export const STANDAARD = Object.freeze({
  autonomie: Object.freeze(
    Object.fromEntries(CATEGORIEEN.map((c) => [c, 'uit']))
  ),
  escalatie: Object.freeze({ pogingen: 3, dagen: 3 }),
  stille_uren: Object.freeze({
    van: '21:00',
    tot: '08:00',
    zondag_stil: true,
    tijdzone: 'Europe/Brussels',
  }),
  dosering: Object.freeze({
    max_per_minuut: 6,
    max_per_uur: 60,
    max_per_dag_per_persoon: 2,
  }),
  mailboxen: Object.freeze({
    lezen: Object.freeze(['administratie', 'info', 'onboarding']),
    afzender_per_categorie: Object.freeze({}),
    standaard: 'administratie@deforexopleiding.nl',
  }),
  model: Object.freeze({
    redeneren: 'claude-sonnet-4-5',
    transcriptie: 'gpt-4o-transcribe',
    temperatuur: 0.3,
  }),
  ongedaan_seconden: 30,
  // Afzenders die geen klantvraag zijn. LEEG, en dat is met opzet: wie hier
  // staat verdwijnt uit de werkbak, en zo'n lijst mag niet door mij bedacht
  // worden. Maxim vult hem in Instellingen.
  //
  // Waar hij voor is: onze eigen systeemmeldingen ("Nieuwe afspraak ingeboekt.
  // Naam: …") komen als INKOMENDE mail binnen, dus de regel "er kwam iets
  // binnen ná ons laatste bericht" haalt ze er niet uit. Leveranciersmail
  // (360dialog Support) is hetzelfde geval.
  systeemafzenders: Object.freeze([]),
  // Wie belt er, per bron van de belrij. LEEG, en dat is met opzet: ik weet
  // niet welk profiel Maxim is en welk Dave, en een verkeerd ingevulde uuid
  // zet iemands werk stil op een lijst waar hij niet in kijkt. Maxim vult hem
  // in Instellingen. Null = niet toegewezen, en dan staat de rij er gewoon
  // zonder eigenaar -- zichtbaar onder "alle", niet verstopt.
  belrij_eigenaar: Object.freeze({}),
  // Wat er mag gebeuren als iemand drie keer niet opnam, per bron van de
  // belrij. LEEG, en dat betekent 'concept' voor elke bron: Iris zet een
  // voorstel in de Post en een mens klikt. 'zelf' is gebouwd maar zet je hier
  // met de hand aan, per bron, nooit allemaal tegelijk.
  belrij_escalatie: Object.freeze({}),
});

/** Staat de hoofdschakelaar aan? Alles behalve een uitdrukkelijke 'true' is nee. */
export function irisAan(env = process.env) {
  return String(env?.IRIS_AAN ?? '').trim().toLowerCase() === 'true';
}

/**
 * Maak van een ruwe waarde uit de databank een geldige stand.
 * Alles wat we niet herkennen wordt 'uit'.
 */
export function leesStand(ruw) {
  const s = String(ruw ?? '').trim().toLowerCase();
  return STANDEN.includes(s) ? s : 'uit';
}

/**
 * De autonomie-instelling, opgeschoond.
 *
 * Neemt de ruwe jsonb uit iris_instellingen en levert een object met een
 * geldige stand voor elke bekende categorie. Onbekende sleutels in de invoer
 * worden weggelaten (een categorie die wij niet kennen, kennen we ook niet in
 * de code die de stand gebruikt). Ontbrekende sleutels worden 'uit'.
 *
 * `aan` is de hoofdschakelaar. Staat die uit, dan is alles 'uit'.
 */
export function normaliseerAutonomie(ruw, { aan = false } = {}) {
  const bron = (ruw && typeof ruw === 'object' && !Array.isArray(ruw)) ? ruw : {};
  const uit = {};
  for (const cat of CATEGORIEEN) {
    if (!aan) { uit[cat] = 'uit'; continue; }
    let stand = leesStand(bron[cat]);
    if (stand === 'zelf' && NOOIT_ZELF.includes(cat)) stand = 'concept';
    uit[cat] = stand;
  }
  return uit;
}

/**
 * Mag Iris in deze categorie zelf versturen?
 *
 * Dit is de vraag die elke verzendweg stelt, en het antwoord is standaard nee.
 */
export function magZelfVersturen(autonomie, categorie) {
  if (NOOIT_ZELF.includes(categorie)) return false;
  return autonomie?.[categorie] === 'zelf';
}

/** Mag Iris in deze categorie een concept schrijven? 'concept' én 'zelf' tellen. */
export function magConceptSchrijven(autonomie, categorie) {
  const stand = autonomie?.[categorie];
  return stand === 'concept' || stand === 'zelf';
}

/**
 * Hoeveel seconden blijft een verstuurd bericht tegen te houden?
 * Grenzen: minstens 5 (anders is de knop een leugen), hoogstens 300.
 *
 * Let op de eerste regel. Number(null) is 0 en Number('') is 0, allebei keurig
 * eindig — zonder die controle wordt een ONTBREKENDE instelling dus 0, en die
 * klemt naar 5 seconden in plaats van naar de standaard van 30. Dat is het
 * verschil tussen "niet ingesteld" en "op het minimum gezet", en dat verschil
 * hoort niet door een type-omzetting te verdwijnen.
 */
export function leesOngedaanSeconden(ruw) {
  if (ruw === null || ruw === undefined || ruw === '') return STANDAARD.ongedaan_seconden;
  const n = Number(ruw);
  if (!Number.isFinite(n)) return STANDAARD.ongedaan_seconden;
  return Math.min(Math.max(Math.trunc(n), 5), 300);
}

/**
 * Haal alle instellingen op uit de databank.
 *
 * Faalt dit, dan komt STANDAARD terug met de autonomie op uit. De aanroeper
 * merkt het verschil aan `gelezen: false` — en dat verschil is belangrijk:
 * "niemand heeft iets aangezet" en "we konden niet kijken" zien er anders
 * hetzelfde uit, en wie daarop iets baseert, baseert het op een aanname.
 *
 * @param {object} supabase  een client met leesrechten (doorgaans supabaseAdmin)
 * @param {object} env
 * @returns {Promise<{gelezen: boolean, aan: boolean, autonomie: object,
 *                    escalatie: object, stille_uren: object, dosering: object,
 *                    mailboxen: object, model: object, ongedaan_seconden: number,
 *                    fout: string|null}>}
 */
export async function haalInstellingen(supabase, env = process.env) {
  const aan = irisAan(env);
  const leeg = {
    gelezen: false,
    aan,
    autonomie: normaliseerAutonomie(null, { aan: false }),
    escalatie: { ...STANDAARD.escalatie },
    stille_uren: { ...STANDAARD.stille_uren },
    dosering: { ...STANDAARD.dosering },
    mailboxen: { ...STANDAARD.mailboxen },
    model: { ...STANDAARD.model },
    ongedaan_seconden: STANDAARD.ongedaan_seconden,
    systeemafzenders: [],
    belrij_eigenaar: {},
    belrij_escalatie: {},
    fout: null,
  };

  if (!supabase) return { ...leeg, fout: 'geen databank-client' };

  let rijen;
  try {
    const { data, error } = await supabase
      .from('iris_instellingen')
      .select('sleutel, waarde');
    if (error) {
      console.error('[iris/instellingen] lezen mislukt:', error.message);
      return { ...leeg, fout: error.message };
    }
    rijen = data || [];
  } catch (e) {
    console.error('[iris/instellingen] uitzondering bij lezen:', e?.message || e);
    return { ...leeg, fout: e?.message || String(e) };
  }

  const bron = {};
  for (const r of rijen) {
    if (r && r.sleutel) bron[r.sleutel] = r.waarde;
  }

  return {
    gelezen: true,
    aan,
    autonomie: normaliseerAutonomie(bron.autonomie, { aan }),
    escalatie: { ...STANDAARD.escalatie, ...(objOf(bron.escalatie)) },
    stille_uren: { ...STANDAARD.stille_uren, ...(objOf(bron.stille_uren)) },
    dosering: { ...STANDAARD.dosering, ...(objOf(bron.dosering)) },
    mailboxen: { ...STANDAARD.mailboxen, ...(objOf(bron.mailboxen)) },
    model: { ...STANDAARD.model, ...(objOf(bron.model)) },
    ongedaan_seconden: leesOngedaanSeconden(bron.ongedaan_seconden),
    systeemafzenders: leesSysteemafzenders(bron.systeemafzenders),
    belrij_eigenaar: leesBelrijEigenaren(bron.belrij_eigenaar),
    belrij_escalatie: leesBelrijEscalatie(bron.belrij_escalatie, { aan }),
    fout: null,
  };
}

/**
 * De lijst met afzenders die geen klantvraag zijn.
 *
 * Rommel erin mag nooit een lijst opleveren die te véél wegfiltert: dat is de
 * stille kant van deze instelling, want een gesprek dat eruit valt mist
 * niemand tot de klant belt. Dus: alleen tekst, kleingemaakt, getrimd,
 * ontdubbeld, en lege waarden weg.
 *
 * Een item mag een volledig adres zijn (`noreply@…`) of een domein (`@…`). Wat
 * ertussen zit — een los woord — wordt bewust NIET als patroon opgevat; dat
 * zou "info" op elk adres met "info" erin laten matchen.
 */
export function leesSysteemafzenders(ruw) {
  if (!Array.isArray(ruw)) return [];
  const uit = [];
  for (const item of ruw) {
    if (typeof item !== 'string') continue;
    const v = item.trim().toLowerCase();
    if (!v) continue;
    if (!v.includes('@')) continue;
    if (!uit.includes(v)) uit.push(v);
  }
  return uit;
}

/**
 * Is dit een afzender die geen klantvraag is?
 *
 * Een volledig adres moet exact kloppen; een domein (`@dfo.nl`) geldt voor
 * alles erachter. Geen losse woorden, geen deelstrings: `info` zou anders ook
 * `klant-info@gmail.com` raken.
 */
export function isSysteemafzender(adres, lijst) {
  const a = String(adres || '').trim().toLowerCase();
  if (!a || !Array.isArray(lijst) || !lijst.length) return false;
  for (const item of lijst) {
    if (item.startsWith('@')) {
      if (a.endsWith(item)) return true;
    } else if (a === item) {
      return true;
    }
  }
  return false;
}

/** Een jsonb-waarde die een object hoort te zijn, of een leeg object. */
function objOf(v) {
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
}

/** De bronnen van de belrij waar een eigenaar op ingesteld kan worden. Gelijk aan iris_belrij.bron. */
export const BELRIJ_BRONNEN = Object.freeze(['wanbetaler', 'onboarding', 'mentorsignaal', 'geen_reactie', 'hand']);

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Wie belt er, per bron.
 *
 * Streng, en om dezelfde reden als bij systeemafzenders: dit is een STILLE
 * instelling. Staat er een uuid die niet bestaat, dan komt de rij op de lijst
 * van niemand te staan — hij is niet weg, maar wel onvindbaar voor wie op "mijn
 * belrij" filtert. Dus: alleen sleutels die een bron zijn, alleen waarden die
 * een uuid zijn, en al het andere valt eruit in plaats van er half in te komen.
 *
 * Een bron die ontbreekt is "niet toegewezen", niet "aan de eerste de beste".
 */
export function leesBelrijEigenaren(ruw) {
  const bron = (ruw && typeof ruw === 'object' && !Array.isArray(ruw)) ? ruw : {};
  const uit = {};
  for (const sleutel of BELRIJ_BRONNEN) {
    const v = bron[sleutel];
    if (typeof v === 'string' && UUID_RX.test(v.trim())) uit[sleutel] = v.trim().toLowerCase();
  }
  return uit;
}

/**
 * De eigenaar voor één bron, of null.
 *
 * Null is een geldig antwoord en geen fout: een rij zonder eigenaar staat onder
 * "alle" en wacht daar op iemand. Dat is beter dan hem aan de verkeerde persoon
 * hangen.
 */
export function eigenaarVoorBron(kaart, bron) {
  const k = (kaart && typeof kaart === 'object') ? kaart : {};
  if (!BELRIJ_BRONNEN.includes(String(bron))) return null;
  const v = k[bron];
  return (typeof v === 'string' && UUID_RX.test(v)) ? v : null;
}

/** De standen voor een escalatie uit de belrij, in oplopende vrijheid. */
export const BELRIJ_ESCALATIE_STANDEN = Object.freeze(['uit', 'concept', 'zelf']);

/** Wat een bron doet als er niets is ingesteld. Een voorstel, nooit een bericht. */
export const BELRIJ_ESCALATIE_STANDAARD = 'concept';

/**
 * Wat mag Iris doen bij een escalatie, per bron van de belrij?
 *
 * ── TWEE DINGEN DIE HIER MET OPZET STRENG ZIJN ───────────────────────────────
 * 1. Rommel leest als 'concept', NOOIT als 'zelf'. Een instelling die ooit
 *    'ZELF ' met een spatie bevat mag geen bericht naar een klant losmaken.
 * 2. De hoofdschakelaar (`IRIS_AAN`) overrulet alles. Staat die uit, dan is
 *    'zelf' onmogelijk -- dan wordt het een concept. Niet 'uit': het werk moet
 *    zichtbaar blijven, alleen niet verzonden worden.
 *
 * Een bron die ontbreekt is 'concept'. Dat is het verschil tussen "nog niet
 * ingesteld" en "hier gebeurt niets".
 */
export function leesBelrijEscalatie(ruw, { aan = false } = {}) {
  const bron = (ruw && typeof ruw === 'object' && !Array.isArray(ruw)) ? ruw : {};
  const uit = {};
  for (const sleutel of BELRIJ_BRONNEN) {
    const ruwe = String(bron[sleutel] ?? '').trim().toLowerCase();
    let stand = BELRIJ_ESCALATIE_STANDEN.includes(ruwe) ? ruwe : BELRIJ_ESCALATIE_STANDAARD;
    if (stand === 'zelf' && !aan) stand = 'concept';
    uit[sleutel] = stand;
  }
  return uit;
}
