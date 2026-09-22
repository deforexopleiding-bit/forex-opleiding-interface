// api/_lib/iris/joost-pauze.js
//
// DE AANMAANMOTOR ZWIJGT ALS IRIS EEN BELOFTE HEEFT VASTGELEGD.
//
// ── WAT DIT WEL EN NIET IS ───────────────────────────────────────────────────
// Dit is GEEN nieuw mechanisme. De motor heeft al twee van deze poorten:
//
//   api/_lib/lms-hold.js    leest hlms_student_hold rechtstreeks
//   api/_lib/lms-stilte.js  leest het contract hlms_crm_stilte
//
// Die staan bewust naast elkaar, met een uitgeschreven afweging over welke
// kant van de fout goedkoop is. Deze module is een DERDE bron in precies
// dezelfde vorm: ophalen, en daarna per klant vragen of er een blokkade is.
//
// Dat is met opzet zo saai mogelijk gehouden. Een poort die er anders uitziet
// dan de twee ernaast, is een poort die bij de volgende wijziging vergeten
// wordt.
//
// ── DE SCHAKELAAR ────────────────────────────────────────────────────────────
// IRIS_PAUZEERT_JOOST. Staat die niet op 'true', dan geeft haalIrisPauzeStand()
// een lege stand terug en geeft irisPauzeBlokkade() altijd null. De motor
// gedraagt zich dan BYTE-IDENTIEK aan vandaag: geen extra opvraging, geen
// extra logregel, geen enkel verschil.
//
// Er staat een test op die dat aantoont, en die test is het punt van deze
// hele module.
//
// ── FAALZACHT, MAAR NAAR WELKE KANT? ─────────────────────────────────────────
// Hier ligt het anders dan bij lms-stilte.js, en dat verdient uitleg.
//
// Die module valt fail-CLOSED: kan de stilte niet gelezen worden, dan manen we
// niet aan. De redenering daar is dat het LMS de bron is van een afspraak die
// een mens maakte, en dat je zo'n afspraak niet mag breken omdat een
// verbinding hapert.
//
// Hier valt het fail-OPEN: kan de beloftetabel niet gelezen worden, dan loopt
// de motor gewoon door. Twee redenen. Ten eerste staat deze tabel in dezelfde
// databank als de motor zelf — kan die niet gelezen worden, dan draait de
// motor toch al niet. Een leesfout hier betekent iets anders dan een leesfout
// over een projectgrens heen. Ten tweede zou fail-closed betekenen dat een
// fout in een gloednieuwe tabel de HELE bestaande aanmaanmotor stillegt. Dat
// is precies het soort koppeling dat sectie 1 van de opdracht verbiedt: Iris
// mag naast Joost draaien, niet bovenop hem.
//
// Een gemiste pauze kost één aanmaning te veel bij iemand met een belofte.
// Vervelend. Een motor die stilvalt kost alle aanmaningen. Dat is duurder.

/** De code en het event, in dezelfde vorm als lms-stilte.js. */
export const PAUZE_CODE = 'iris_belofte';
export const PAUZE_EVENT = 'skipped_iris_belofte';

/** Staat de schakelaar aan? Alles behalve een uitdrukkelijke 'true' is nee. */
export function pauzeAan(env = process.env) {
  return String(env?.IRIS_PAUZEERT_JOOST ?? '').trim().toLowerCase() === 'true';
}

/**
 * Is deze belofte vandaag nog geldig?
 *
 * Tot EN MET de beloofde dag. Iemand die zegt "ik betaal vrijdag" hoort op
 * vrijdag geen aanmaning te krijgen omdat het al middag is — dan is de dag
 * nog niet voorbij.
 */
export function isActieveBelofte(rij, vandaagIso) {
  if (!rij || rij.status !== 'actief') return false;
  const datum = String(rij.datum || '').slice(0, 10);
  if (!datum) return false;
  const vandaag = String(vandaagIso || new Date().toISOString().slice(0, 10)).slice(0, 10);
  return datum >= vandaag;
}

/**
 * Haal alle lopende beloftes op, als een kaart klant → belofte.
 *
 * Eén opvraging voor de hele ronde, precies zoals haalStilteStand() en
 * haalHoldStand() dat doen. Per klant opzoeken zou bij vierhonderd open
 * facturen vierhonderd opvragingen betekenen.
 *
 * @returns {Promise<{aan: boolean, beloftes: Map<string, object>, fout: string|null}>}
 */
export async function haalIrisPauzeStand({ db = null, env = process.env, vandaagIso = null } = {}) {
  const leeg = { aan: false, beloftes: new Map(), fout: null };

  if (!pauzeAan(env)) return leeg;
  if (!db) return { ...leeg, aan: true, fout: 'geen databank-client' };

  const vandaag = vandaagIso || new Date().toISOString().slice(0, 10);

  try {
    const { data, error } = await db
      .from('iris_beloftes')
      .select('id, contact_id, customer_id, bedrag, datum, status, bron, notitie')
      .eq('status', 'actief')
      .gte('datum', vandaag);
    if (error) throw new Error(error.message);

    const kaart = new Map();
    for (const rij of (data || [])) {
      if (!rij.customer_id) continue;          // zonder klant valt er niets te pauzeren
      if (!isActieveBelofte(rij, vandaag)) continue;
      // Meerdere beloftes voor één klant: de LAATSTE datum wint. Wie twee keer
      // uitstel kreeg, heeft tot de verste datum de tijd — de eerste laten
      // winnen zou betekenen dat de tweede afspraak niets waard is.
      const bestaand = kaart.get(rij.customer_id);
      if (!bestaand || String(rij.datum) > String(bestaand.datum)) kaart.set(rij.customer_id, rij);
    }
    return { aan: true, beloftes: kaart, fout: null };
  } catch (e) {
    // Fail-OPEN. Zie de toelichting bovenaan: een fout in deze nieuwe tabel
    // mag de bestaande aanmaanmotor niet stilleggen.
    console.error('[iris/joost-pauze] beloftes niet gelezen — de motor loopt door:', e?.message || e);
    return { aan: true, beloftes: new Map(), fout: e?.message || String(e) };
  }
}

/**
 * Is er voor deze klant een blokkade?
 *
 * @returns {null|{code: string, event: string, reden: string, tot: string, bedrag: number|null, bron: string}}
 */
export function irisPauzeBlokkade(stand, customerId) {
  if (!stand || !stand.aan) return null;
  if (!customerId) return null;
  const belofte = stand.beloftes?.get(customerId);
  if (!belofte) return null;

  const bedrag = belofte.bedrag != null ? Number(belofte.bedrag) : null;
  const bedragTekst = Number.isFinite(bedrag) ? ` van € ${bedrag.toFixed(2)}` : '';
  return {
    code: PAUZE_CODE,
    event: PAUZE_EVENT,
    reden: `Iris legde een betaalafspraak${bedragTekst} vast voor ${belofte.datum}.`,
    tot: belofte.datum,
    bedrag: Number.isFinite(bedrag) ? bedrag : null,
    bron: belofte.bron || 'iris',
    belofte_id: belofte.id,
  };
}

/** Eén regel voor in het logboek van de motor, in dezelfde vorm als de andere twee. */
export function pauzeStandSamenvatting(stand) {
  if (!stand?.aan) return 'Iris-beloftes: uitgeschakeld (IRIS_PAUZEERT_JOOST staat niet aan)';
  if (stand.fout) return `Iris-beloftes: niet gelezen (${stand.fout}) — de motor loopt door`;
  const n = stand.beloftes?.size || 0;
  // "afspraak" + "en" wordt "afspraaken". Het Nederlands verdubbelt de klinker
  // niet in het meervoud, dus het woord staat er twee keer uitgeschreven.
  return `Iris-beloftes: ${n} lopende ${n === 1 ? 'afspraak' : 'afspraken'}`;
}
