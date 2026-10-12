// api/_lib/iris/belrij-escalatie-ronde.js
//
// Taak 6, deel 3 — de ronde die de escalaties langsgaat.
//
// Leest de open belrij, rekent per rij de drempel en het mandaat uit, en zet
// waar het mag een concept klaar. Schrijft NOOIT een bericht zelf de deur uit:
// ook bij stand 'zelf' gaat de rij als 'goedgekeurd' met een `verstuur_na` de
// databank in, en verstuurt de BESTAANDE cron hem binnen het ongedaan-venster
// van G2. Eén verzendweg, dus één plek waar de claim-voor-versturen staat.
//
// De regels zelf staan in belrij-escalatie.js (het mandaat) en in
// belrij-escalatie-concept.js (de teksten en het kanaal); die zijn puur en per
// geval te toetsen. Hier staat alleen wat een databank nodig heeft.

import { telPogingen, moetEscaleren } from './belrij.js';
import { haalInstellingen } from './instellingen.js';
import { beslisEscalatie, standVoorBron } from './belrij-escalatie.js';
import { kiesGesprek, bouwConcepten, metStand } from './belrij-escalatie-concept.js';

/** Zoveel belrij-rijen per ronde. Ruim boven wat er op een dag escaleert. */
export const PER_RONDE_MAX = 100;

/** De statussen waarin een belrij-rij nog werk is. */
export const OPEN_STATUS = Object.freeze(['open', 'bezig']);

/**
 * Staat er al een onverstuurd concept voor dit gesprek?
 *
 * Dit is poort 4 van het mandaat, en de enige die de databank nodig heeft. Een
 * tweede concept maken terwijl het eerste nog op een mens wacht, levert twee
 * kaarten in de Post op voor dezelfde zaak -- en dan verstuurt iemand ze beide.
 *
 * `klaar` EN `goedgekeurd` tellen: een goedgekeurd concept is nog niet weg
 * (het wacht op zijn verstuur_na), dus een tweede ernaast is hetzelfde dubbele
 * bericht.
 */
export async function heeftOpenConcept(db, gesprekId) {
  const { data, error } = await db
    .from('iris_concepten')
    .select('id')
    .eq('gesprek_id', gesprekId)
    .in('status', ['klaar', 'goedgekeurd'])
    .limit(1)
    .maybeSingle();
  if (error) throw new Error('concepten lezen: ' + error.message);
  return !!data;
}

/**
 * Eén belrij-rij afhandelen.
 *
 * Geeft terug wat er gebeurd is én waarom, zodat de ronde kan tellen en het
 * logboek iets zinnigs kan zeggen zonder zelf opnieuw te hoeven rekenen.
 */
export async function behandelRij(db, rij, { instellingen, nu = new Date() }) {
  const uit = { doen: 'niets', reden: null, poort: null, concepten: 0, overgeslagen: [] };

  const { data: pogingen, error: pFout } = await db
    .from('iris_belpogingen')
    .select('contact_id, uitkomst, afgebroken_voor_opname, gebeld_op')
    .eq('contact_id', rij.contact_id)
    .order('gebeld_op', { ascending: false })
    .limit(40);
  if (pFout) throw new Error('belpogingen lezen: ' + pFout.message);

  const telling = telPogingen(pogingen || [], { nu });

  const { data: gesprekken, error: gFout } = await db
    .from('iris_gesprekken')
    .select('id, kanaal, categorie, laatste_inbound, laatste_outbound')
    .eq('contact_id', rij.contact_id);
  if (gFout) throw new Error('gesprekken lezen: ' + gFout.message);

  // De drempel kijkt ook naar een inkomend bericht: wie gisteren nog appte, is
  // niet onbereikbaar, en dan is "we proberen je te bereiken" een belediging.
  const laatsteInbound = (gesprekken || [])
    .map((g) => g.laatste_inbound)
    .filter(Boolean)
    .sort()
    .pop() || null;

  const escalatie = moetEscaleren(telling, instellingen.escalatie, { laatsteInbound, nu });
  const stand = standVoorBron(instellingen.belrij_escalatie, rij.bron);

  const { gesprek, reden: gesprekReden } = kiesGesprek(gesprekken);

  // Poort 4 kost een opvraging, dus doen we die alleen als er een gesprek is én
  // de drempel gehaald is. Anders vragen we honderd keer per ronde iets op voor
  // rijen waar toch niets gebeurt.
  let openConcept = false;
  if (escalatie.escaleren && gesprek?.id && stand !== 'uit') {
    openConcept = await heeftOpenConcept(db, gesprek.id);
  }

  const laatsteUitgaand = (gesprekken || [])
    .map((g) => g.laatste_outbound)
    .filter(Boolean)
    .sort()
    .pop() || null;

  // Het contact hebben we zo nodig voor de naam en het mailadres, en nu al voor
  // de klant-sleutel waarop de afspraak-poort zoekt.
  const { data: contact } = await db
    .from('iris_contacten')
    .select('id, customer_id, weergavenaam, emails')
    .eq('id', rij.contact_id)
    .maybeSingle();

  // Ook deze poort kost een opvraging, dus alleen als er iets te blokkeren is.
  const actieveAfspraak = (escalatie.escaleren && stand === 'zelf')
    ? await heeftActieveAfspraak(db, { contactId: rij.contact_id, customerId: contact?.customer_id || null })
    : false;

  const besluit = beslisEscalatie({
    escalatie,
    stand,
    nu,
    laatsteUitgaandOp: laatsteUitgaand,
    actieveAfspraak,
    openConcept,
  });

  uit.doen = besluit.doen;
  uit.reden = besluit.reden;
  uit.poort = besluit.poort;
  if (besluit.doen === 'niets') return uit;

  if (!gesprek) {
    // De drempel is gehaald en het mandaat staat open, maar er is geen enkel
    // juist gesprek. Niet gokken: de rij blijft op de belrij staan met de
    // reden erbij.
    uit.doen = 'niets';
    uit.poort = 'geen_gesprek';
    uit.reden = gesprekReden;
    return uit;
  }

  const { data: templates } = await db
    .from('whatsapp_meta_templates')
    .select('name, status, category, language')
    .limit(200);

  const gebouwd = bouwConcepten({
    gesprek,
    naam: eersteNaam(contact?.weergavenaam),
    email: (contact?.emails || [])[0] || null,
    templates: templates || [],
    nu,
  });
  uit.overgeslagen = gebouwd.overgeslagen;

  if (!gebouwd.rijen.length) {
    uit.doen = 'niets';
    uit.poort = 'geen_kanaal';
    return uit;
  }

  const seconden = instellingen.ongedaan_seconden;
  for (const basis of gebouwd.rijen) {
    try {
      const { error } = await db.from('iris_concepten').insert({
        ...metStand(basis, { doen: besluit.doen, ongedaanSeconden: seconden, nu }),
        instructie: 'escalatie uit de belrij',
        instructie_bron: 'auto',
      });
      if (error) throw new Error(error.message);
      uit.concepten++;
    } catch (e) {
      // Per kanaal een eigen try/catch: valt de WhatsApp om, dan hoort de mail
      // er nog te staan. Dat is precies het geval waarin je hem het hardst
      // nodig hebt.
      console.error(`[iris/escalatie] concept ${basis.kanaal} voor gesprek ${basis.gesprek_id}:`, e?.message || e);
      uit.overgeslagen.push(`${basis.kanaal}: ${e?.message || e}`);
    }
  }

  return uit;
}

/**
 * Loopt er een betaalafspraak of toezegging?
 *
 * Dit is poort 3 van het mandaat, en de belangrijkste van de vier: wie een
 * regeling heeft en zich eraan houdt, hoort geen "we proberen je te bereiken"
 * te krijgen. Dat is niet alleen onhandig, het ondermijnt de afspraak zelf.
 *
 * Twee bronnen, want we hebben er twee:
 *   · `iris_beloftes` met status 'actief' -- de toezegging die Iris zelf
 *     vastlegde ("ik betaal donderdag").
 *   · `payment_arrangements` met status 'ACTIEF' -- de formele regeling uit de
 *     D-module, die via TeamLeader loopt.
 *
 * Fail-CLOSED: valt een van de twee opvragingen om, dan zeggen we JA (er loopt
 * iets). Een bericht niet versturen omdat we het niet zeker weten, is een
 * dag uitstel; wél versturen terwijl er een regeling loopt, is een fout
 * tegenover een klant die zich aan zijn afspraak houdt.
 */
export async function heeftActieveAfspraak(db, { contactId, customerId = null }) {
  try {
    const { data, error } = await db
      .from('iris_beloftes')
      .select('id')
      .eq('contact_id', contactId)
      .eq('status', 'actief')
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data) return true;
  } catch (e) {
    console.warn('[iris/escalatie] beloftes niet gelezen, poort blijft dicht:', e?.message || e);
    return true;
  }

  if (!customerId) return false;

  try {
    const { data, error } = await db
      .from('payment_arrangements')
      .select('id')
      .eq('customer_id', customerId)
      .eq('status', 'ACTIEF')
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return !!data;
  } catch (e) {
    console.warn('[iris/escalatie] betaalafspraken niet gelezen, poort blijft dicht:', e?.message || e);
    return true;
  }
}

/** Alleen de voornaam in de aanhef. "Hoi Jeffrey" leest beter dan "Hoi Jeffrey Biemold". */
export function eersteNaam(weergavenaam) {
  const n = String(weergavenaam || '').trim();
  if (!n || n.includes('@')) return null;
  const eerste = n.split(/\s+/)[0];
  return eerste && eerste.length <= 40 ? eerste : null;
}

/**
 * De hele ronde.
 *
 * Per rij een eigen try/catch (les 3): één contact waar iets misgaat mag de
 * rest niet blokkeren. Het rapport telt per uitkomst, zodat in het logboek
 * zichtbaar is dat er NIETS gebeurde en waarom -- een ronde die stil nul doet,
 * is niet te onderscheiden van een ronde die niet liep.
 */
export async function escalatieRonde(db, { nu = new Date(), max = PER_RONDE_MAX, opTijd = () => true } = {}) {
  const rapport = {
    bekeken: 0, concepten: 0, zelf: 0,
    per_poort: {}, fouten: [], afgekapt: false,
  };

  const instellingen = await haalInstellingen(db);

  const { data, error } = await db
    .from('iris_belrij')
    .select('id, contact_id, bron, status, prioriteit')
    .in('status', OPEN_STATUS)
    .order('prioriteit', { ascending: false })
    .limit(max);
  if (error) throw new Error('belrij lezen: ' + error.message);

  for (const rij of (data || [])) {
    if (!opTijd()) { rapport.afgekapt = true; break; }
    if (!rij?.contact_id) continue;
    rapport.bekeken++;
    try {
      const uit = await behandelRij(db, rij, { instellingen, nu });
      const sleutel = uit.poort || uit.doen;
      rapport.per_poort[sleutel] = (rapport.per_poort[sleutel] || 0) + 1;
      rapport.concepten += uit.concepten;
      if (uit.doen === 'zelf') rapport.zelf += uit.concepten;
    } catch (e) {
      const tekst = e?.message || String(e);
      console.error(`[iris/escalatie] belrij-rij ${rij.id}:`, tekst);
      if (rapport.fouten.length < 3) rapport.fouten.push(tekst);
    }
  }

  return rapport;
}
