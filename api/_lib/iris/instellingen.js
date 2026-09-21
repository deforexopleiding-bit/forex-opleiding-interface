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
    fout: null,
  };
}

/** Een jsonb-waarde die een object hoort te zijn, of een leeg object. */
function objOf(v) {
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
}
