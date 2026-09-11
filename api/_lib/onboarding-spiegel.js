// api/_lib/onboarding-spiegel.js
//
// DE spiegel van een CRM-onboarding naar het LMS. Eén functie, één schrijver.
//
// ── WAAROM ────────────────────────────────────────────────────────────────
// Het LMS kan niet bij het CRM; alleen het CRM schrijft over de grens. De
// mentor moet in zijn eigen omgeving zien welke studenten opgepakt moeten
// worden, met vier feiten erbij: wanneer ze starten, waar ze in de wizard
// zitten, of de eerste factuur betaald is, en hoe de bedenktijd erbij staat.
// Dat laatste is geen sier: de regel is dat de mentor één keer contact
// opneemt en daarna NIET blijft bellen zolang de bedenktijd loopt.
//
// ── ÉÉN SCHRIJVER, EN DAT IS EEN HARDE REGEL ─────────────────────────────
// `hlms_crm_onboarding` wordt UITSLUITEND vanuit dit bestand geschreven.
// Geen tweede pad, ook niet "even snel" vanuit een endpoint. Er staat een
// test op (tests/onboarding-spiegel.test.js) die rood wordt zodra een ander
// bestand naar die tabel schrijft.
//
// Reden: met twintig schrijfpunten op `onboardings` is het geen kwestie óf
// er ooit eentje afwijkt, maar wanneer. Eén functie betekent dat een
// wijziging aan de spiegel op één plek gebeurt en overal tegelijk landt.
//
// ── DE HERSYNC IS DE WAARHEID, DE AANROEP IS SNELHEID ────────────────────
// `api/cron/onboarding-spiegel-sync.js` draait deze functie dagelijks voor
// alles. De aanroepen vanuit endpoints zijn er alleen zodat het meteen klopt.
// Vergeet iemand later een aanroep bij een nieuw endpoint — en dat gebeurt —
// dan is dat hooguit een dag vertraging in plaats van een stille afwijking
// die niemand ooit ziet.
//
// ── VERDWIJNEN IS EEN GEVOLG VAN DE DEFINITIE ────────────────────────────
// Deze functie bepaalt ZELF of de rij hoort te bestaan:
// `status != 'geannuleerd' AND archived_at IS NULL`. Hoort hij niet te
// bestaan, dan verwijdert hij 'm. Annuleren in het CRM laat de student dus
// overal in het LMS verdwijnen, zonder dat daar een aparte opruimactie voor
// nodig is die iemand kan vergeten.
//
// ── LEEG IS NIET HETZELFDE ALS NIET-GELUKT ───────────────────────────────
// Er wordt nooit een halve rij geschreven. Kan een deel van de bron niet
// gelezen worden, dan schrijven we NIETS en blijft de oude rij staan met
// zijn oude `bijgewerkt_op`. Een spiegel die stilstaat is beter dan een
// spiegel die liegt — mits je kunt zien dát hij stilstaat, en daar is die
// tijdstempel voor.

import { supabaseAdmin } from '../supabase.js';
import { getDfoLmsClient } from './dfo-lms-db.js';
import {
  computeBedenktijd, findWaiverConsentKey, leesWaiver, leesOfferteMoment,
} from './onboarding-bedenktijd.js';

export const SPIEGEL_TABEL = 'hlms_crm_onboarding';

// Dezelfde woordenlijst als api/_lib/dfo-lms-sessies.js. Bewust geen tweede
// vocabulaire voor hetzelfde begrip.
export const BRON_GELEZEN            = 'gelezen';
export const BRON_ONBEREIKBAAR       = 'onbereikbaar';
export const BRON_NIET_GECONFIGUREERD = 'niet-geconfigureerd';

// Uitkomsten van spiegelOnboarding().
export const SPIEGEL_GESCHREVEN = 'geschreven';
export const SPIEGEL_VERWIJDERD = 'verwijderd';
export const SPIEGEL_AFWEZIG    = 'afwezig';   // hoort niet te bestaan, stond er ook niet
export const SPIEGEL_MISLUKT    = 'mislukt';

const CRM_KOLOMMEN =
  'id, customer_id, traject_id, status, archived_at, start_date, current_step, ' +
  'mentor_user_id, dfo_lms_student_id, answers, completed_at';

/**
 * De reden die zegt: in het CRM staat hier gewoon nog geen mentor. Dat is
 * GEEN mankement — het is de normale toestand van een verse onboarding. Alle
 * andere redenen zijn dat wel, en die horen opgemerkt te worden.
 */
export const MENTOR_GEEN_IN_CRM = 'geen-mentor-in-crm';

/**
 * De stand zoals die in het CRM staat, LETTERLIJK.
 *
 * Geen vertaling, geen lower(), geen trim(), geen woordenlijst. Het woord uit
 * `onboardings.status` gaat ongewijzigd naar `hlms_crm_onboarding.
 * onboarding_stand`, en het LMS beslist zelf wat het met een woord doet dat
 * het niet kent.
 *
 * ── WAAROM DIT BETER IS DAN VERTALEN ────────────────────────────────────
 * Komt er in het CRM een status bij — on hold staat op de rol — dan ziet het
 * LMS een onbekend woord en toont die rij apart: "stand onbekend, controleer
 * in het CRM voor je belt". Bij een vertaallaag zou dat nieuwe geval
 * stilletjes in de emmer 'loopt' of 'afgerond' vallen en zou niemand het
 * merken. Onbekend hoort zichtbaar te zijn, niet weggemapt.
 *
 * Dit is bewust het TEGENOVERGESTELDE van de keuze bij product_soort in
 * api/_lib/dfo-lms-student.js. Daar is een strikte woordenlijst juist wél
 * goed, omdat de studentkant een onbekende waarde stil als 'onbekend' toont
 * aan een betalende klant. Hier is de lezer een MEDEWERKER die juist moet
 * zien dat er iets nieuws is. Wie de lezer is bepaalt of vertalen of
 * doorgeven het veiligst is.
 *
 * Leeg blijft leeg: geen status in het CRM betekent geen stand hier, en niet
 * een gok. Het LMS behandelt leeg als onbekend.
 */
function leesStandLetterlijk(status) {
  return (typeof status === 'string' && status !== '') ? status : null;
}

/** Hoort deze onboarding zichtbaar te zijn in het LMS? */
export const NIET_ZICHTBARE_STATUSSEN = Object.freeze(['geannuleerd', 'gearchiveerd']);

export function hoortZichtbaarTeZijn(ob) {
  if (!ob) return false;
  if (ob.archived_at) return false;
  // 'gearchiveerd' stond hier eerst NIET bij: die werd afgevangen doordat
  // api/onboarding-archive.js status en archived_at in één patch zet. Dat is
  // waar — nagelopen, het is de enige schrijver van die status op
  // `onboardings` — maar het is een gevolgtrekking uit ander bestand en geen
  // regel hier. Eén rij met status 'gearchiveerd' en een lege archived_at zou
  // zo in het LMS belanden. Nu is het een regel.
  return !NIET_ZICHTBARE_STATUSSEN.includes(
    String(ob.status || '').trim().toLowerCase());
}

/**
 * Het aantal stappen in de wizard van dit traject. Zonder totaal zegt een
 * stapnummer niets: "stap 3" is geen stand, "3 van 7" wel.
 */
function telStappen(structure) {
  if (!structure || typeof structure !== 'object') return null;
  const pages = Array.isArray(structure.pages) ? structure.pages : [];
  return pages.length > 0 ? pages.length : null;
}

/**
 * Spiegel één onboarding naar het LMS.
 *
 * Gooit NOOIT. De aanroeper (een endpoint na zijn hoofdactie, of de cron)
 * krijgt een uitkomst terug en beslist zelf wat hij ermee doet. Een mislukte
 * spiegel mag een mentortoewijzing nooit tegenhouden.
 *
 * @param {string} onboardingId
 * @param {{lmsClient?: object, nu?: number}} [opties] alleen voor tests
 * @returns {Promise<{resultaat: string, bron_status: string, fout: string|null,
 *                    rij?: object|null}>}
 */
export async function spiegelOnboarding(onboardingId, opties = {}) {
  const id = String(onboardingId || '').trim();
  if (!id) {
    return { resultaat: SPIEGEL_MISLUKT, bron_status: BRON_ONBEREIKBAAR,
      fout: 'onboardingId ontbreekt' };
  }

  const lms = opties.lmsClient || getDfoLmsClient();
  if (!lms) {
    return { resultaat: SPIEGEL_MISLUKT, bron_status: BRON_NIET_GECONFIGUREERD,
      fout: 'DFO_LMS_SUPABASE_URL/KEY ontbreekt' };
  }

  try {
    // ── 1) De onboarding zelf ────────────────────────────────────────────
    const { data: ob, error: obErr } = await supabaseAdmin
      .from('onboardings').select(CRM_KOLOMMEN).eq('id', id).maybeSingle();
    if (obErr) throw new Error('onboarding lezen: ' + obErr.message);

    // Bestaat niet (meer) → net zo goed weg uit het LMS.
    if (!ob || !hoortZichtbaarTeZijn(ob)) {
      return await verwijderSpiegel(lms, id);
    }

    // Zonder studentrij is er niets om aan te hangen. Dat is geen fout: de
    // rij wordt aangemaakt zodra de student geprovisioneerd is, en dan komt
    // de spiegel er bij de eerstvolgende aanroep vanzelf bij.
    if (!ob.dfo_lms_student_id) {
      return await verwijderSpiegel(lms, id, SPIEGEL_AFWEZIG);
    }

    // ── 2) De vier feiten ────────────────────────────────────────────────
    // Alles wat kan mislukken, mislukt hier — vóór er ook maar iets
    // geschreven is. Zo bestaat een halve rij niet.
    // Het traject wordt ÉÉN keer gelezen; zowel de waiver-sleutel als het
    // aantal stappen komen uit dezelfde structuur.
    const [betaald, wizard, dealRow, mentor] = await Promise.all([
      leesEersteFactuurBetaald(ob.customer_id),
      leesWizardStructuur(),
      leesOfferteDeal(ob.customer_id),
      leesLmsMentorId(ob.mentor_user_id),
    ]);
    const structure = wizard.structure;

    const waiver = leesWaiver(ob.answers, findWaiverConsentKey(structure));
    const bedenktijdInfo = computeBedenktijd(
      waiver, leesOfferteMoment(dealRow), opties.nu);
    const stappenTotaal = telStappen(structure);

    // ── 3) De volledige rij, in één keer ─────────────────────────────────
    const rij = {
      crm_onboarding_id      : ob.id,
      student_id             : ob.dfo_lms_student_id,
      mentor_id              : mentor.id,
      start_datum            : ob.start_date || null,
      // De stand, en wanneer hij afgerond is. Een afgeronde onboarding HOUDT
      // zijn rij (dat is de afspraak: de rij verdwijnt alleen bij annuleren
      // of archiveren), maar tot nu zei de spiegel nergens DAT hij afgerond
      // was. De mentorband kan daardoor lopend werk niet van afgerond werk
      // scheiden — gemeten 11 september: 5 van de 25 rijen zijn afgerond.
      onboarding_stand       : leesStandLetterlijk(ob.status),
      afgerond_op            : ob.completed_at || null,
      wizard_stap            : Number.isFinite(Number(ob.current_step)) ? Number(ob.current_step) : null,
      wizard_stappen_totaal  : stappenTotaal,
      eerste_factuur_betaald : betaald,
      bedenktijd_status      : bedenktijdInfo.status,
      bedenktijd_vervalt_op  : bedenktijdInfo.vervalt_op,
      bedenktijd_reden       : bedenktijdInfo.reason,
      bijgewerkt_op          : new Date().toISOString(),
      // Kon de wizard-structuur niet gelezen worden, dan is de bedenktijd
      // niet vast te stellen. De rij komt er wél — een klant zonder rij is
      // onzichtbaar — maar met de waarheid erbij dat de bron haperde.
      bron_status            : wizard.fout ? BRON_ONBEREIKBAAR : BRON_GELEZEN,
      bron_fout              : wizard.fout,
    };

    const { error: upErr } = await lms
      .from(SPIEGEL_TABEL)
      .upsert(rij, { onConflict: 'crm_onboarding_id' });
    if (upErr) throw new Error('spiegel schrijven: ' + upErr.message);

    // De mentor-uitkomst gaat mee naar boven, ook bij succes: de rij is
    // geschreven, maar of daar een mentor in staat en waarom niet is een
    // aparte vraag die de aanroeper moet kunnen beantwoorden.
    return { resultaat: SPIEGEL_GESCHREVEN, bron_status: BRON_GELEZEN, fout: null,
      rij, mentor };
  } catch (e) {
    const msg = e?.message || String(e);
    console.error('[onboarding-spiegel] ' + id + ': ' + msg);
    // BEWUST geen poging om de bestaande rij te "markeren als stuk": dat zou
    // een schrijfactie zijn op grond van een mislukte lezing. De oude rij
    // blijft staan met zijn oude bijgewerkt_op, en het scherm ziet aan die
    // tijdstempel dat de spiegel stilstaat.
    return { resultaat: SPIEGEL_MISLUKT, bron_status: BRON_ONBEREIKBAAR, fout: msg };
  }
}

/** Rij weghalen. Ontbrak hij al, dan is dat geen fout maar de gewenste staat. */
async function verwijderSpiegel(lms, onboardingId, alsAfwezig = null) {
  const { error } = await lms
    .from(SPIEGEL_TABEL).delete().eq('crm_onboarding_id', onboardingId);
  if (error) {
    const msg = 'spiegel verwijderen: ' + error.message;
    console.error('[onboarding-spiegel] ' + onboardingId + ': ' + msg);
    return { resultaat: SPIEGEL_MISLUKT, bron_status: BRON_ONBEREIKBAAR, fout: msg };
  }
  return {
    resultaat: alsAfwezig || SPIEGEL_VERWIJDERD,
    bron_status: BRON_GELEZEN, fout: null,
  };
}

/** Is er minstens één betaalde factuur voor deze klant? */
async function leesEersteFactuurBetaald(customerId) {
  if (!customerId) return false;
  const { data, error } = await supabaseAdmin
    .from('invoices').select('id').eq('customer_id', customerId)
    .eq('status', 'paid').limit(1);
  if (error) throw new Error('invoices lezen: ' + error.message);
  return Array.isArray(data) && data.length > 0;
}

/**
 * De wizard-structuur — voor de waiver-sleutel én het stap-totaal.
 *
 * ── DIT STOND FOUT, EN DE FOUT IS LEERZAAM ──────────────────────────────
 * Hier stond `onboarding_trajecten.select('structure')`. Die kolom BESTAAT
 * NIET; de spiegel faalde daardoor op alle 25 onboardings met
 * `column onboarding_trajecten.structure does not exist`. Ik had een
 * kolomnaam bedacht die paste bij wat ik verwachtte in plaats van gekeken
 * waar de structuur echt staat.
 *
 * Waar hij WEL staat: `onboarding_wizard.published_structure`, één rij,
 * `id = 1`. Dat is exact dezelfde lezing als
 * api/admin-future-students-list.js (regel ~200) — de bron die is
 * vastgelegd als autoritatief voor de vier feiten. Niet per traject dus,
 * maar één gepubliceerde structuur voor het geheel.
 *
 * ── FAALZACHT, MAAR NIET STIL ───────────────────────────────────────────
 * Mislukt deze lezing, dan gooit hij NIET. Eén hapering in de wizard-tabel
 * mag niet betekenen dat er van 25 klanten geen spiegelrij is. Maar hij
 * doet ook niet alsof er niets aan de hand is: de aanroeper zet
 * `bron_status` op onbereikbaar en `bron_fout` op de melding, zodat het
 * mentorscherm de bedenktijd als ONBEKEND toont in plaats van als
 * vervallen. Onbekend en vervallen zijn niet hetzelfde — bij onbekend
 * geldt terughoudendheid, en dat staat ook zo in het commentaar op de
 * kolom.
 *
 * @returns {Promise<{structure: object|null, fout: string|null}>}
 */
async function leesWizardStructuur() {
  const { data, error } = await supabaseAdmin
    .from('onboarding_wizard').select('published_structure').eq('id', 1).maybeSingle();
  if (error) {
    console.warn('[onboarding-spiegel] wizard-structuur lezen:', error.message);
    return { structure: null, fout: 'wizard-structuur lezen: ' + error.message };
  }
  return { structure: data?.published_structure || null, fout: null };
}

/** De meest recente geaccepteerde offerte van deze klant. */
async function leesOfferteDeal(customerId) {
  if (!customerId) return null;
  const { data, error } = await supabaseAdmin
    .from('deals')
    .select('customer_id, tl_quotation_accepted_at, tl_quotation_signed_at')
    .eq('customer_id', customerId)
    .not('tl_quotation_accepted_at', 'is', null)
    .order('tl_quotation_accepted_at', { ascending: false })
    .limit(1);
  if (error) throw new Error('deals lezen: ' + error.message);
  return (data || [])[0] || null;
}

/**
 * De mentor in LMS-termen. De brug loopt over het e-mailadres
 * (team_members.email ↔ hlms_personeel.email) — hetzelfde pad als
 * api/_lib/dfo-lms-student.js. Geen mentor gevonden is geen fout: dan staat
 * er `null` en valt de student in het LMS onder "nog geen mentor".
 */
async function leesLmsMentorId(mentorUserId) {
  // GEEN mentor in het CRM is iets anders dan een mentor die we niet konden
  // vertalen. Beide gaven hier `null`, en dus zag een leeg mentorveld in het
  // LMS er identiek uit of Maxim nog niemand had toegewezen, of dat de
  // koppeling stuk was. Op 10 september bleek dat bij 12 van de 25 rijen niet
  // te beantwoorden zonder de databank ernaast te leggen. Vandaar de reden.
  if (!mentorUserId) return { id: null, reden: MENTOR_GEEN_IN_CRM };

  const { vindDfoLmsMentorId } = await import('./dfo-lms-student.js');
  const { data, error } = await supabaseAdmin
    .from('team_members').select('user_id, email, is_active')
    .eq('user_id', mentorUserId).maybeSingle();
  // Dit blijft gooien: een onleesbare team_members is een bronstoring en geen
  // uitspraak over deze mentor.
  if (error) throw new Error('team_members lezen: ' + error.message);

  if (!data)                  return { id: null, reden: 'mentor-niet-in-team_members' };
  if (data.is_active === false) return { id: null, reden: 'mentor-niet-actief-in-crm' };
  if (!data.email)            return { id: null, reden: 'mentor-zonder-email-in-crm' };

  const uitkomst = await vindDfoLmsMentorId(data.email);
  if (!uitkomst?.id) {
    return { id: null, reden: uitkomst?.reden || 'mentor-niet-te-vertalen' };
  }
  return { id: uitkomst.id, reden: null };
}

/**
 * Aanroep-helper voor endpoints: spiegel NA een geslaagde hoofdactie.
 *
 * Faalzacht en bewust zonder terugkoppeling naar de aanroeper: een mislukte
 * spiegel mag een mentortoewijzing, een stap-opslag of een annulering nooit
 * tegenhouden. Wat er misging staat in de log, en de dagelijkse hersync
 * herstelt het de volgende ochtend.
 *
 * @param {string} onboardingId
 * @param {string} label naam van de aanroeper, voor de logregel
 */
export async function spiegelNaActie(onboardingId, label) {
  try {
    const uit = await spiegelOnboarding(onboardingId);
    if (uit.resultaat === SPIEGEL_MISLUKT) {
      console.warn('[' + label + '] spiegel mislukt voor ' + onboardingId
        + ': ' + (uit.fout || 'onbekend')
        + ' — de hersync van morgen herstelt dit.');
    }
    return uit;
  } catch (e) {
    console.warn('[' + label + '] spiegel-aanroep mislukt: ' + (e?.message || e));
    return { resultaat: SPIEGEL_MISLUKT, bron_status: BRON_ONBEREIKBAAR,
      fout: e?.message || String(e) };
  }
}
