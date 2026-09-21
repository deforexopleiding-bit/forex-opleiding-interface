// api/_lib/lms-hold.js
//
// ON HOLD IN HET LMS PAUZEERT JOOST. Eén bron, één definitie, één poort.
//
// ── WAAROM ────────────────────────────────────────────────────────────────
// De hoofdmentor kan een student in het LMS on hold zetten — bij een
// betaalachterstand, een gevraagd uitstel, of gewoon omdat er iets aan de
// hand is. Beslissing van Maxim, 11 september 2026: zolang die pauze loopt
// stuurt de wanbetalersmotor die klant NIETS. Geen aanmaning, geen
// herinnering, geen WhatsApp.
//
// Dat is geen verfijning van de motor maar een harde poort ervóór. Iemand
// manen die net een pauze heeft gekregen is precies het soort bericht dat
// een klant kwijtraakt, en het is niet terug te nemen.
//
// ── DE KOPPELING IS DIE VAN DE FACTUURSPIEGEL, NIET EEN TWEEDE ───────────
// De hold staat op een LMS-student; de motor werkt met CRM-klanten. Die
// vertaling bestaat al, in api/_lib/factuurstand-spiegel.js (PR #1614):
// `zoekKlantKandidaten()` verzamelt de kandidaten langs drie wegen en
// `kiesKlant()` beslist, met de regel dat twee kandidaten geen keuze is.
// Beide worden hier HERGEBRUIKT — er staat in dit bestand geen enkele
// eigen lookup. tests/lms-hold.test.js wordt rood zodra dat verandert.
//
// Eén verschil met de spiegel, en het is opzettelijk: de spiegel schrijft
// alleen voor ACTIEVE mentorship-studenten (mentorship + auth_id + traject
// loopt). Voor een hold geldt die zeef NIET. Een hold is een uitgesproken
// beslissing van de hoofdmentor over déze student; of die student ook aan
// de voorwaarden voor de factuurspiegel voldoet, doet niet ter zake. De
// zeef bestaat om lege rijen te voorkomen, niet om berichten toe te laten.
//
// ── FAALZACHT, EN NAAR DE VOORZICHTIGE KANT ──────────────────────────────
// Kan het LMS niet gelezen worden, dan WETEN we niet wie er on hold staat.
// Dan verstuurt de motor die run niets naar klanten die aan een LMS-student
// gekoppeld zijn. Eén dag later aanmanen is minder erg dan iemand manen die
// net een pauze kreeg — en dat is hier de hele afweging.
//
// Let op wat "faalzacht" hier dus NIET betekent: niet "ga door alsof er
// niets is". Overal elders in de dunning-modules is fail-open de juiste
// keuze (een glitch mag de motor niet stilzetten); bij deze poort is
// fail-CLOSED de juiste, want de schade zit aan de verzendkant.

import { supabaseAdmin } from '../supabase.js';
import { getDfoLmsClient } from './dfo-lms-db.js';
import { todayIsoInTz } from './dunning-overdue-guard.js';
import {
  STUDENT_KOLOMMEN, zoekKlantKandidaten, kiesKlant,
} from './factuurstand-spiegel.js';

export const HOLD_TABEL = 'hlms_student_hold';

// Dezelfde woordenlijst als de factuurspiegel en dfo-lms-sessies.js.
export const BRON_GELEZEN            = 'gelezen';
export const BRON_ONBEREIKBAAR       = 'onbereikbaar';
export const BRON_NIET_GECONFIGUREERD = 'niet-geconfigureerd';

// De reden-code die in dunning_log en in de wanbetalersmodule verschijnt.
export const HOLD_CODE = 'lms_hold';
// Het event dat de motor in dunning_log schrijft als hij overslaat.
export const HOLD_EVENT = 'skipped_lms_hold';

// app_settings-sleutel met de klanten die de factuurspiegel voor het laatst
// aan een LMS-student heeft kunnen koppelen. Zie leesGekoppeldeKlanten().
export const GEKOPPELD_SETTING_KEY = 'lms_gekoppelde_klanten';

const HOLD_KOLOMMEN = 'student_id, van, tot, reden, materiaal_open, door, opgeheven_op';

// `materiaal_open` wordt met opzet NIET gelezen als voorwaarde. Die vlag gaat
// over of de student tijdens zijn pauze nog bij het lesmateriaal kan, en dat
// staat los van de vraag of we hem mogen aanmanen. Een hold mét open
// materiaal is nog steeds een hold.

// ───────────────────────────────────────────────────────────────────────────
// 1) DE DEFINITIE — puur
// ───────────────────────────────────────────────────────────────────────────

/** 'YYYY-MM-DD' uit een datum- of tijdstempelwaarde; null als er niets staat. */
function dag(waarde) {
  const s = String(waarde || '').trim();
  return s ? s.slice(0, 10) : null;
}

/**
 * Loopt deze pauze vandaag?
 *
 * De regel: `van <= vandaag < tot`, en `opgeheven_op` is leeg.
 *
 * Twee randgevallen, en ze vallen allebei naar de VOORZICHTIGE kant — dat
 * wil zeggen: naar wél een hold, want dat is de kant waar geen bericht
 * uitgaat:
 *
 *   geen `van`  → de pauze is al begonnen. Een hold zonder startdatum is
 *                 een hold die nu geldt, niet een die nooit begint.
 *   geen `tot`  → de pauze loopt door tot iemand hem opheft. Dat is precies
 *                 wat een open einde betekent; hem als "voorbij" lezen zou
 *                 de student aanmanen op grond van een ontbrekend veld.
 *
 * `tot` is EXCLUSIEF: op de einddatum zelf loopt de motor weer. Zo is de
 * dag waarop de pauze afloopt ook de dag waarop alles hervat, zonder dat
 * iemand een dag moet aftrekken.
 *
 * PURE.
 */
export function isActieveHold(hold, todayIso) {
  if (!hold) return false;
  if (hold.opgeheven_op) return false;
  const vandaag = dag(todayIso);
  if (!vandaag) return false;
  const van = dag(hold.van);
  const tot = dag(hold.tot);
  if (van && van > vandaag) return false;   // begint pas later
  if (tot && tot <= vandaag) return false;  // afgelopen
  return true;
}

/** 'YYYY-MM-DD' → 'dd-mm-jjjj'. Geen datum → null. */
export function nlDatum(iso) {
  const d = dag(iso);
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const [j, m, dd] = d.split('-');
  return dd + '-' + m + '-' + j;
}

/**
 * De zin die een medewerker in de wanbetalersmodule te zien krijgt.
 * Precies de formulering die Maxim gevraagd heeft.
 *
 * PURE.
 */
export function holdTekst(hold) {
  const tot = nlDatum(hold?.tot);
  const basis = tot
    ? 'On hold in het LMS tot ' + tot
    : 'On hold in het LMS (geen einddatum)';
  const reden = String(hold?.reden || '').trim();
  return reden ? basis + ' — ' + reden : basis;
}

// ───────────────────────────────────────────────────────────────────────────
// 2) DE STAND — één keer per run ophalen
// ───────────────────────────────────────────────────────────────────────────

/**
 * De klanten die de factuurspiegel voor het laatst aan een LMS-student heeft
 * kunnen koppelen, zoals weggeschreven in `app_settings`.
 *
 * ── WAAROM DIT BESTAAT ──────────────────────────────────────────────────
 * Het vangnet hierboven moet weten WELKE klanten aan een LMS-student hangen.
 * Twee van de drie koppelwegen staan in het CRM zelf (`onboardings.
 * dfo_lms_student_id` en `.bubble_user_id`) en zijn dus ook leesbaar als het
 * LMS plat ligt. De derde — het e-mailadres — heeft aan CRM-kant GEEN spoor:
 * die koppeling bestaat alleen doordat een student in het LMS hetzelfde
 * adres draagt. Precies die klanten zouden bij een storing door het vangnet
 * heen vallen.
 *
 * Daarom laat de nachtelijke spiegelronde een afdruk achter van de klanten
 * die hij heeft gekoppeld. Geen tweede waarheid: het is een AFDRUK van de
 * spiegel, hij wordt alleen gebruikt om het vangnet BREDER te maken, nooit
 * om iets te versturen, en als hij ontbreekt of oud is doet het vangnet het
 * nog steeds met de twee CRM-wegen.
 *
 * Fail-soft: onleesbaar → lege verzameling (de twee CRM-wegen blijven).
 */
export async function leesGekoppeldeKlanten(db = supabaseAdmin) {
  try {
    const { data, error } = await db
      .from('app_settings').select('value').eq('key', GEKOPPELD_SETTING_KEY).maybeSingle();
    if (error) throw new Error(error.message);
    const ids = data?.value?.customer_ids;
    return {
      klanten: new Set(Array.isArray(ids) ? ids.map(String).filter(Boolean) : []),
      bijgewerkt_op: data?.value?.bijgewerkt_op || null,
    };
  } catch (e) {
    console.warn('[lms-hold] afdruk van gekoppelde klanten onleesbaar:', e?.message || e);
    return { klanten: new Set(), bijgewerkt_op: null };
  }
}

/**
 * Alle klanten die aan een LMS-student gekoppeld (kunnen) zijn — het
 * vangnet voor als het LMS niet te lezen is.
 *
 * GEDEELD met api/_lib/lms-stilte.js: die poort heeft bij een storing
 * exact hetzelfde vangnet nodig, en twee kopieën van "wie hangt er aan het
 * LMS" zouden gegarandeerd uit elkaar lopen zodra er een vierde koppelweg
 * bij komt.
 *
 * Twee bronnen, allebei in het CRM: de onboardings die een LMS-verwijzing
 * of een Bubble-id dragen, plus de afdruk van de spiegel. Samen zo breed
 * mogelijk; dat is hier de bedoeling.
 */
export async function bouwVangnet(db) {
  const uit = new Set();
  let crmFout = null;

  try {
    const { data, error } = await db
      .from('onboardings')
      .select('customer_id, dfo_lms_student_id, bubble_user_id, is_test')
      .or('dfo_lms_student_id.not.is.null,bubble_user_id.not.is.null');
    if (error) throw new Error(error.message);
    for (const ob of (data || [])) {
      if (ob?.is_test === true || !ob?.customer_id) continue;
      uit.add(String(ob.customer_id));
    }
  } catch (e) {
    // Ook het CRM hapert. Dan blijft alleen de afdruk over; dat is nog
    // altijd beter dan een leeg vangnet, en het wordt luid gelogd.
    crmFout = e?.message || String(e);
    console.error('[lms-hold] vangnet: onboardings onleesbaar — ' + crmFout);
  }

  const afdruk = await leesGekoppeldeKlanten(db);
  for (const id of afdruk.klanten) uit.add(id);

  return { klanten: uit, afdruk_bijgewerkt_op: afdruk.bijgewerkt_op, crm_fout: crmFout };
}

/**
 * DE STAND: welke klanten mag de motor deze run niet benaderen?
 *
 * Eén keer per cron-run aanroepen, daarna doorgeven. Nooit per klant — een
 * motor die honderden klanten langsloopt mag het LMS niet honderden keren
 * bevragen.
 *
 * @param {{db?: object, lmsClient?: object, nu?: Date, todayIso?: string}} [opties]
 * @returns {Promise<{
 *   bron_status: string,
 *   holds: Map<string, object>,        // customer_id → de hold-rij
 *   vangnet: Set<string>,              // alleen gevuld bij 'onbereikbaar'
 *   fout: string|null,
 *   telling: object,
 * }>}
 */
export async function haalHoldStand(opties = {}) {
  const db = opties.db || supabaseAdmin;
  const todayIso = opties.todayIso || todayIsoInTz(opties.nu || new Date());
  const telling = {
    holds_totaal: 0, holds_actief: 0, gekoppeld: 0,
    niet_gekoppeld: 0, student_onbekend: 0,
  };

  const lms = opties.lmsClient || getDfoLmsClient();
  if (!lms) {
    // GEEN LMS-koppeling geconfigureerd is iets anders dan een storing: in
    // een omgeving zonder DFO_LMS_*-variabelen (een oude preview, een
    // lokale kopie) bestaat het LMS domweg niet, en dan zou fail-closed de
    // hele motor stilzetten zonder dat er ooit een hold kan zijn.
    return {
      bron_status: BRON_NIET_GECONFIGUREERD, holds: new Map(), vangnet: new Set(),
      fout: 'DFO_LMS_SUPABASE_URL/KEY ontbreekt', telling, peildatum: todayIso,
    };
  }

  // ── 1) De holds ──────────────────────────────────────────────────────
  let rijen;
  try {
    const { data, error } = await lms
      .from(HOLD_TABEL).select(HOLD_KOLOMMEN).is('opgeheven_op', null);
    if (error) throw new Error(error.message);
    rijen = Array.isArray(data) ? data : [];
  } catch (e) {
    const fout = e?.message || String(e);
    // LUID. Dit is het geval waarin de motor zich inhoudt; dat hoort in de
    // log te staan met de reden erbij, niet als stille regel.
    console.error('[lms-hold] LMS-holds NIET te lezen — de motor houdt zich '
      + 'deze run in voor alle klanten met een LMS-koppeling. Reden: ' + fout);
    const vangnet = await bouwVangnet(db);
    return {
      bron_status: BRON_ONBEREIKBAAR, holds: new Map(), vangnet: vangnet.klanten,
      fout, telling, peildatum: todayIso,
      vangnet_meting: {
        klanten: vangnet.klanten.size,
        afdruk_bijgewerkt_op: vangnet.afdruk_bijgewerkt_op,
        crm_fout: vangnet.crm_fout,
      },
    };
  }

  telling.holds_totaal = rijen.length;
  const actief = rijen.filter((h) => isActieveHold(h, todayIso));
  telling.holds_actief = actief.length;

  const holds = new Map();
  if (actief.length === 0) {
    return { bron_status: BRON_GELEZEN, holds, vangnet: new Set(), fout: null,
      telling, peildatum: todayIso };
  }

  // ── 2) De studenten erbij, en dan de koppeling van de spiegel ────────
  try {
    const ids = Array.from(new Set(actief.map((h) => String(h.student_id || '')).filter(Boolean)));
    const { data, error } = await lms
      .from('hlms_student').select(STUDENT_KOLOMMEN).in('id', ids);
    if (error) throw new Error('hlms_student lezen: ' + error.message);
    const studentById = new Map((data || []).map((s) => [String(s.id), s]));

    for (const hold of actief) {
      const student = studentById.get(String(hold.student_id)) || null;
      if (!student) {
        // Een hold op een student die we niet terugvinden. Zeldzaam, maar
        // het telt apart: het is een gegevensprobleem, geen "niet gekoppeld".
        telling.student_onbekend++;
        console.warn('[lms-hold] hold op onbekende student ' + hold.student_id);
        continue;
      }
      // DE koppeling van de factuurspiegel. Geen tweede.
      const keuze = kiesKlant(await zoekKlantKandidaten(student, { db }));
      if (!keuze.customer_id) {
        telling.niet_gekoppeld++;
        console.warn('[lms-hold] hold zonder CRM-klant voor student '
          + hold.student_id + ' (' + (keuze.reden || 'geen-klant-gevonden') + ')');
        continue;
      }
      telling.gekoppeld++;
      // Twee holds op dezelfde klant: de LAATSTE einddatum wint. Zo dooft
      // de pauze pas als álle pauzes voorbij zijn.
      const bestaand = holds.get(keuze.customer_id);
      if (!bestaand || !bestaand.tot || (hold.tot && dag(hold.tot) > dag(bestaand.tot))) {
        holds.set(keuze.customer_id, { ...hold, _via: keuze.via });
      }
    }
  } catch (e) {
    // De holds zijn wél gelezen maar de vertaling naar klanten is mislukt.
    // Dat is dezelfde onwetendheid als hierboven, en dus dezelfde uitkomst.
    const fout = e?.message || String(e);
    console.error('[lms-hold] holds gelezen maar niet te koppelen — de motor '
      + 'houdt zich deze run in voor alle klanten met een LMS-koppeling. Reden: ' + fout);
    const vangnet = await bouwVangnet(db);
    return {
      bron_status: BRON_ONBEREIKBAAR, holds: new Map(), vangnet: vangnet.klanten,
      fout, telling, peildatum: todayIso,
      vangnet_meting: {
        klanten: vangnet.klanten.size,
        afdruk_bijgewerkt_op: vangnet.afdruk_bijgewerkt_op,
        crm_fout: vangnet.crm_fout,
      },
    };
  }

  return { bron_status: BRON_GELEZEN, holds, vangnet: new Set(), fout: null,
    telling, peildatum: todayIso };
}

// ───────────────────────────────────────────────────────────────────────────
// 3) DE POORT — wat de motor aanroept
// ───────────────────────────────────────────────────────────────────────────

/**
 * Mag de motor deze klant benaderen?
 *
 * @param {object|null} stand uitkomst van haalHoldStand(); null = geen stand
 *   opgehaald (dan blokkeert deze poort niets — de aanroeper heeft de stand
 *   bewust niet geladen, bijvoorbeeld in een sandbox-run).
 * @param {string} customerId
 * @returns {null | {code, reden, tot, bron_status, student_id}}
 *   null = vrij. Een object = NIET versturen, met de reden erbij.
 *
 * PURE (leest alleen uit de meegegeven stand).
 */
export function holdBlokkade(stand, customerId) {
  if (!stand || !customerId) return null;
  const id = String(customerId);

  if (stand.bron_status === BRON_ONBEREIKBAAR) {
    if (!stand.vangnet?.has(id)) return null;
    return {
      code: HOLD_CODE,
      reden: 'On hold onbekend — het LMS is niet te lezen, dus deze klant '
        + 'wordt deze ronde overgeslagen.',
      tot: null,
      bron_status: stand.bron_status,
      student_id: null,
    };
  }

  const hold = stand.holds?.get(id);
  if (!hold) return null;
  return {
    code: HOLD_CODE,
    reden: holdTekst(hold),
    tot: dag(hold.tot),
    bron_status: stand.bron_status,
    student_id: hold.student_id || null,
  };
}

/** Korte samenvatting van de stand voor één logregel per cron-run. */
export function holdStandSamenvatting(stand) {
  if (!stand) return 'lms-hold: niet geladen';
  if (stand.bron_status === BRON_ONBEREIKBAAR) {
    return 'lms-hold: BRON ONBEREIKBAAR (' + (stand.fout || 'onbekend') + ') — '
      + (stand.vangnet?.size || 0) + ' klant(en) met LMS-koppeling worden overgeslagen';
  }
  if (stand.bron_status === BRON_NIET_GECONFIGUREERD) {
    return 'lms-hold: dfo-lms niet geconfigureerd — geen holds toegepast';
  }
  const t = stand.telling || {};
  return 'lms-hold: ' + (t.holds_actief || 0) + ' actieve hold(s), '
    + (t.gekoppeld || 0) + ' gekoppeld aan een klant, '
    + (t.niet_gekoppeld || 0) + ' zonder klant, '
    + (t.student_onbekend || 0) + ' zonder studentrij';
}
