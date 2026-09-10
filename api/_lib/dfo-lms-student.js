// api/_lib/dfo-lms-student.js
//
// Fase 1 — studentrij aanmaken in het NIEUWE LMS (dfo-lms, hlms_student)
// bij het starten van een onboarding. Vervangt NIETS aan de bestaande
// Bubble-flow en raakt de trial-site (lms_gebruikers / lms_provision) niet;
// zie de naamgevingsnotitie in api/_lib/dfo-lms-db.js.
//
// IDEMPOTENTIE is de hoofdeis. Dezelfde onboarding twee keer verwerken mag
// nooit een tweede studentrij opleveren. Drie lagen, van goedkoop naar hard:
//
//   1. CRM-vlag       — onboardings.dfo_lms_provisioned + dfo_lms_student_id.
//   2. Zoeken vóór schrijven — eerst op crm_onboarding_id, dan op
//                       lower(email). Gevonden = overnemen, niet aanmaken.
//   3. Databank-vangnet — dfo-lms heeft twee unieke indexen:
//                       hlms_student_email_uidx op lower(email) en
//                       hlms_student_crm_onboarding_uidx op crm_onboarding_id.
//                       Twee gelijktijdige pogingen kunnen dus nooit twee
//                       rijen opleveren; de verliezer krijgt 23505 en wij
//                       behandelen dat als "bestond al" — niet als fout.
//
// Wat we NIET aanraken in hlms_student: calls_gedaan, calls_startsaldo,
// no_show_count, auth_id, bubble_user_id, membership_type, overrides,
// onboarding_status, uitnodiging_* en aangemaakt_door. Fase 1 legt alleen
// het studentfeit vast; inloggen/uitnodigen is een latere fase.

import { supabaseAdmin } from '../supabase.js';
import { getDfoLmsClient, isUniqueViolation } from './dfo-lms-db.js';
import { berekenLmsVenster } from './onboarding-window.js';

// Kolommen die we op onboardings lezen/schrijven voor deze koppeling.
const CRM_KOLOMMEN =
  'id, customer_id, traject_id, status, start_date, mentor_user_id, ' +
  'dfo_lms_student_id, dfo_lms_provisioned, dfo_lms_provisioned_at, dfo_lms_provision_error';

// hlms_student.product_soort — STRIKTE woordenlijst. De kolom is aan LMS-kant
// gewoon `text` zonder CHECK, dus de databank houdt ons NIET tegen. De
// studentkant (trajectstand.ts) kent maar drie uitkomsten: 'mentorship',
// 'membership' en 'onbekend'. Alles wat niet letterlijk een van de eerste
// twee is, valt daar stil in 'onbekend' — en dan ziet een betalende klant
// een scherm dat zegt dat zijn traject niet bekend is.
//
// Daarom: geen terugval op traject.key, geen doorgeven van het ruwe type.
// Alleen deze tabel. Staat een traject er niet in, dan faalt de aanmaak
// luidruchtig (zie provisionDfoLmsStudent) in plaats van stil een derde
// waarde weg te schrijven. Een zichtbare fout op één onboarding is
// goedkoper dan een student die niet weet wat hij gekocht heeft.
//
// Bron van de CRM-kant: WIZARD_FLOW_TYPES in api/_lib/onboarding-wizard-
// default.js — onboarding_trajecten.type is canoniek '1op1' of 'membership'.
const PRODUCT_SOORT_MAP = Object.freeze({
  '1op1':       'mentorship',
  '1-op-1':     'mentorship',
  'mentorship': 'mentorship',
  'membership': 'membership',
});

// hlms_student.herkomst — waar de rij vandaan komt. 'crm' is een BESTAANDE
// waarde in de HERKOMSTEN-lijst aan LMS-kant; we voegen er bewust geen
// nieuwe variant aan toe (een 'crm_onboarding' zou er wél een zijn, en
// onbekende waarden vallen aan de leeskant stil om — zelfde risico als bij
// product_soort, want ook deze kolom heeft geen CHECK).
//
// Wordt ALLEEN bij het aanmaken gezet, nooit bij het overnemen van een
// bestaande rij: die is ergens anders ontstaan en dat hoort zo te blijven
// staan. Anders zou een student die ooit uit Bubble geïmporteerd is na een
// koppeling ineens als CRM-aanmaak te boek staan.
const HERKOMST_CRM = 'crm';

/** @returns {string|null} 'mentorship' | 'membership', of null bij onbekend. */
export function bepaalProductSoort(traject) {
  const ruw = String(traject?.type || '').trim().toLowerCase();
  return PRODUCT_SOORT_MAP[ruw] || null;
}

// Aantal sessies → hlms_student.calls_totaal. `calls` is het veld dat de rest
// van het CRM toont (zie api/onboarding-detail.js); alpha_calls_total is de
// Alpha-specifieke variant en dient als terugval.
//
// ── WAAROM productSoort ERBIJ MOET ────────────────────────────────────
// `hlms_student.calls_totaal` staat aan LMS-kant op NOT NULL. Deze functie
// keek alleen naar het traject, en een membership-traject heeft geen calls —
// dus rolde er `null` uit en sloeg de insert af op de constraint. Dat is op
// 9 september 2026 gebeurd bij de inhaalslag (Membership 36 maanden), maar de
// echte schade zat elders: dezelfde weg loopt bij ELKE nieuwe
// membership-aanmelding via onboarding-create, en daar is geen knop die het
// je vertelt — alleen een regel in dfo_lms_provision_error.
//
// Twee gevallen, en ze horen zich verschillend te gedragen:
//
//   MEMBERSHIP → altijd 0. Een membership HÉÉFT geen calls; 0 is geen
//   noodgreep maar de betekenis zelf. Het is ook de bestaande conventie in
//   het LMS: van de 102 membership-studenten staan er 84 op 0 en is het
//   minimum 0 (gemeten 9 september 2026). Staat er tegen de verwachting in
//   toch een aantal op een membership-traject, dan negeren we dat — maar
//   niet stilletjes: dat is een gegevensfout in het CRM en die hoort in het
//   log te staan, niet in het LMS.
//
//   MENTORSHIP → het echte aantal, of `null`. Geen terugval op 0: een
//   1-op-1-klant die zijn traject als "0 calls" ziet staan is erger dan een
//   aanmaak die stopt. `null` betekent hier "niet vast te stellen" en de
//   aanroeper moet er luidruchtig op stoppen — net als bij product_soort.
//
// @param {object|null} traject
// @param {string|null} [productSoort] 'membership' | 'mentorship' | null
// @returns {number|null} het aantal, of null als het niet vast te stellen is.
export function bepaalCallsTotaal(traject, productSoort) {
  const t = traject || {};

  if (productSoort === 'membership') {
    const gevonden = [t.calls, t.alpha_calls_total]
      .map((v) => Number(v))
      .find((n) => Number.isFinite(n) && n > 0);
    if (gevonden !== undefined) {
      console.warn('[dfo-lms-student] membership-traject '
        + JSON.stringify(t.key || t.id || null) + ' draagt ' + gevonden
        + ' calls — genegeerd, membership krijgt calls_totaal 0');
    }
    return 0;
  }

  for (const v of [t.calls, t.alpha_calls_total]) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return null;
}

/** Foutmelding wegschrijven op de onboarding. Best-effort. */
async function schrijfFout(onboardingId, msg) {
  try {
    await supabaseAdmin
      .from('onboardings')
      .update({
        dfo_lms_provisioned    : false,
        dfo_lms_provision_error: String(msg || '').slice(0, 1000),
      })
      .eq('id', onboardingId);
  } catch (e) {
    console.error('[dfo-lms-student] fout-write mislukt:', e?.message || e);
  }
}

/**
 * Zoek de mentor in dfo-lms op e-mailadres.
 *
 * hlms_personeel is klein (11 rijen), dus we halen 'm op en vergelijken in JS
 * op lower(email). Bewust GEEN .ilike(): in een LIKE-patroon zijn `_` en `%`
 * jokertekens en `_` is een geldig teken in een e-mailadres — dat zou de
 * verkeerde mentor kunnen matchen.
 *
 * @returns {Promise<{ id: string|null, reden: string|null }>}
 */
export async function vindDfoLmsMentorId(mentorEmail) {
  const mail = String(mentorEmail || '').trim().toLowerCase();
  if (!mail) return { id: null, reden: 'mentor-zonder-email' };

  const lms = getDfoLmsClient();
  if (!lms) return { id: null, reden: 'dfo-lms-niet-geconfigureerd' };

  const { data, error } = await lms
    .from('hlms_personeel')
    .select('id, email, actief');
  if (error) {
    console.warn('[dfo-lms-student] hlms_personeel ophalen:', error.message);
    return { id: null, reden: 'personeel-fetch-fout' };
  }

  const treffers = (data || []).filter(
    (r) => String(r?.email || '').trim().toLowerCase() === mail && r?.actief !== false
  );
  if (treffers.length === 1) return { id: treffers[0].id, reden: null };
  if (treffers.length === 0) return { id: null, reden: 'geen-lms-mentor-voor-' + mail };

  // Kan niet bij een correcte dataset, maar gokken doen we nooit.
  console.warn('[dfo-lms-student] meerdere mentors met e-mail', mail, '— mentor_id leeg gelaten');
  return { id: null, reden: 'meerdere-lms-mentors' };
}

/** E-mailadres van de CRM-mentor ophalen (team_members). */
async function haalMentorEmail(mentorUserId) {
  if (!mentorUserId) return null;
  const { data, error } = await supabaseAdmin
    .from('team_members')
    .select('user_id, email, is_active')
    .eq('user_id', mentorUserId)
    .eq('is_active', true)
    .maybeSingle();
  if (error) {
    console.warn('[dfo-lms-student] team_members ophalen:', error.message);
    return null;
  }
  return data?.email ? String(data.email).trim().toLowerCase() : null;
}

/**
 * Zoek een bestaande studentrij. Eerst op de onboarding-verwijzing, dan op
 * e-mail (hoofdletterongevoelig, met exacte na-controle in JS).
 *
 * @returns {Promise<{ rij: object|null, via: 'onboarding'|'email'|null }>}
 */
async function zoekBestaandeStudent(lms, { onboardingId, email }) {
  {
    const { data, error } = await lms
      .from('hlms_student')
      .select('id, email, crm_onboarding_id, mentor_id')
      .eq('crm_onboarding_id', onboardingId)
      .maybeSingle();
    if (error) throw new Error('hlms_student zoeken op onboarding: ' + error.message);
    if (data) return { rij: data, via: 'onboarding' };
  }

  // `%` en `_` in het patroon zouden te veel matchen; we filteren daarom
  // achteraf op exacte lower()-gelijkheid. Door de unieke index op
  // lower(email) blijft er daarna hooguit één over.
  const { data, error } = await lms
    .from('hlms_student')
    .select('id, email, crm_onboarding_id, mentor_id')
    .ilike('email', email);
  if (error) throw new Error('hlms_student zoeken op e-mail: ' + error.message);

  const exact = (data || []).filter(
    (r) => String(r?.email || '').trim().toLowerCase() === email
  );
  if (exact.length === 1) return { rij: exact[0], via: 'email' };
  if (exact.length > 1) throw new Error('meerdere studentrijen met e-mail ' + email);
  return { rij: null, via: null };
}

/** dfo_lms_student_id + vlaggen wegschrijven op de onboarding. */
async function markeerGekoppeld(onboardingId, studentId) {
  const { error } = await supabaseAdmin
    .from('onboardings')
    .update({
      dfo_lms_student_id     : studentId,
      dfo_lms_provisioned    : true,
      dfo_lms_provisioned_at : new Date().toISOString(),
      dfo_lms_provision_error: null,
    })
    .eq('id', onboardingId);
  if (error) throw new Error('onboardings bijwerken: ' + error.message);
}

/**
 * DE VASTE VORM van elk geslaagd resultaat van provisionDfoLmsStudent.
 *
 * ── WAAROM DIT BESTAAT — lees dit voor je hier een veld uit haalt ──────────
 * De aanroeper (api/onboarding-dfo-lms-provision.js) heeft `email` nodig om
 * daarna de LMS-uitnodiging te kunnen versturen; die kent het adres niet zelf
 * en zoekt het niet op.
 *
 * Op 6 september 2026 gaf het 'al gekoppeld'-pad wél `ok:true` maar géén
 * `email`. Daardoor heeft de uitnodigingsknop NOOIT gewerkt: de aanroeper zag
 * geen adres, sloeg de aanroep over, en meldde 'geen studentrij' terwijl het
 * bestáán van die rij juist de oorzaak was. Een halfuur zoeken in de verkeerde
 * richting.
 *
 * Daarom bouwt ELK geslaagd pad zijn resultaat via deze functie, nooit met een
 * eigen object-literal. tests/dfo-lms-student.test.js dwingt dat af op
 * broncode-niveau: een nieuw pad dat hier omheen gaat, laat die test falen.
 *
 * Een 'succes' zonder e-mailadres bestaat niet in dit contract — dat zou de
 * aanroeper stilzwijgend laten struikelen. Ontbreekt het adres, dan is dat
 * geen succes maar een fout, en zegt hij dat ook.
 *
 * @param {{studentId: string, email: string}} kern  verplicht
 * @param {object} [extra]  vrije velden (created / adopted / skipped / ...)
 */
export function succesResultaat({ studentId, email, ...extra }) {
  if (!studentId || !email) {
    const ontbreekt = [!studentId ? 'student_id' : null, !email ? 'email' : null]
      .filter(Boolean).join(' + ');
    console.error('[dfo-lms-student] succesResultaat zonder ' + ontbreekt
      + ' — dit is een programmeerfout, geen gegevensprobleem');
    return { ok: false, error: 'intern: geslaagd resultaat zonder ' + ontbreekt };
  }
  return { ok: true, student_id: studentId, email, ...extra };
}

/**
 * Maak (of hergebruik) de studentrij in dfo-lms voor deze onboarding.
 *
 * Fail-soft: gooit nooit door naar de aanroeper. Bij een fout blijft
 * dfo_lms_provisioned false en staat de reden in dfo_lms_provision_error,
 * zodat een mislukking zichtbaar is en niet stil.
 *
 * @param {string} onboardingId
 * @returns {Promise<{ok:boolean, skipped?:boolean, created?:boolean,
 *   adopted?:boolean, student_id?:string, mentor_id?:string|null,
 *   mentor_warning?:string|null, reason?:string, error?:string}>}
 */
export async function provisionDfoLmsStudent(onboardingId) {
  if (!onboardingId || typeof onboardingId !== 'string') {
    return { ok: false, error: 'onboardingId ontbreekt' };
  }

  const lms = getDfoLmsClient();
  if (!lms) {
    // Geen fout op de onboarding schrijven: dit is een configuratie-
    // toestand van de omgeving, geen mislukking van deze klant.
    return { ok: false, skipped: true, reason: 'dfo-lms-niet-geconfigureerd' };
  }

  // 1) Onboarding laden.
  let onboarding;
  try {
    const { data, error } = await supabaseAdmin
      .from('onboardings')
      .select(CRM_KOLOMMEN)
      .eq('id', onboardingId)
      .maybeSingle();
    if (error) {
      if (/dfo_lms_/i.test(error.message || '')) {
        const msg = 'Migratie niet gedraaid: de dfo_lms_-kolommen ontbreken op onboardings';
        console.error('[dfo-lms-student] ' + msg);
        return { ok: false, error: msg };
      }
      throw error;
    }
    if (!data) return { ok: false, error: 'Onboarding niet gevonden' };
    onboarding = data;
  } catch (e) {
    const msg = 'onboarding ophalen: ' + (e?.message || e);
    console.error('[dfo-lms-student]', msg);
    return { ok: false, error: msg };
  }

  // 2) Klant laden. Dit gebeurt BEWUST vóór de 'al gekoppeld'-uitstap
  // hieronder: ook dat pad moet een e-mailadres kunnen teruggeven, want de
  // aanroeper stuurt daarna de uitnodiging. Zie succesResultaat().
  let customer;
  try {
    const { data, error } = await supabaseAdmin
      .from('customers')
      .select('id, first_name, last_name, email, phone')
      .eq('id', onboarding.customer_id)
      .maybeSingle();
    if (error) throw new Error('customers: ' + error.message);
    customer = data;
  } catch (e) {
    const msg = (e?.message || String(e));
    console.error('[dfo-lms-student]', msg);
    await schrijfFout(onboardingId, msg);
    return { ok: false, error: msg };
  }

  const email = String(customer?.email || '').trim().toLowerCase();
  if (!email) {
    const msg = 'Klant zonder e-mail — kan geen studentrij in dfo-lms aanmaken';
    await schrijfFout(onboardingId, msg);
    return { ok: false, error: msg };
  }

  // 3) Al gekoppeld → niets meer te doen. Goedkoopste idempotentie-laag.
  // Het traject wordt hier bewust NIET opgehaald: een al gekoppelde student
  // hoeft niet opnieuw door de product_soort-controle, en die zou een
  // werkende overslaan-situatie in een fout kunnen veranderen.
  if (onboarding.dfo_lms_provisioned === true && onboarding.dfo_lms_student_id) {
    return succesResultaat({
      studentId: onboarding.dfo_lms_student_id,
      email,
      skipped: true,
    });
  }

  // 4) Traject.
  let traject;
  try {
    const t = await supabaseAdmin
      .from('onboarding_trajecten')
      .select('id, key, type, label, duur_maanden, calls, alpha_calls_total')
      .eq('id', onboarding.traject_id)
      .maybeSingle();
    if (t.error) throw new Error('onboarding_trajecten: ' + t.error.message);
    traject = t.data;
  } catch (e) {
    const msg = (e?.message || String(e));
    console.error('[dfo-lms-student]', msg);
    await schrijfFout(onboardingId, msg);
    return { ok: false, error: msg };
  }

  if (!traject) {
    const msg = 'Traject niet gevonden voor onboarding';
    await schrijfFout(onboardingId, msg);
    return { ok: false, error: msg };
  }

  // product_soort MOET kloppen — zie PRODUCT_SOORT_MAP. Liever hier stoppen
  // dan een waarde wegschrijven die de studentkant als 'onbekend' toont.
  const productSoort = bepaalProductSoort(traject);
  if (!productSoort) {
    const msg = 'Onbekend traject-type ' + JSON.stringify(traject.type || null)
      + ' (traject ' + (traject.key || traject.id) + ') — kan product_soort niet bepalen. '
      + 'Toegestaan: ' + Object.keys(PRODUCT_SOORT_MAP).join(' / ')
      + '. Vul PRODUCT_SOORT_MAP aan in api/_lib/dfo-lms-student.js.';
    await schrijfFout(onboardingId, msg);
    return { ok: false, error: msg };
  }

  // calls_totaal MOET een getal zijn — de kolom staat aan LMS-kant op NOT
  // NULL. Voor membership levert bepaalCallsTotaal() altijd 0; komt er hier
  // toch null uit, dan is het een mentorship-traject zonder aantal calls.
  // Dan stoppen we hier, met een melding die zegt wat er ontbreekt — in
  // plaats van de databank een constraint-fout te laten geven waar niemand
  // het traject in terugleest.
  const callsTotaal = bepaalCallsTotaal(traject, productSoort);
  if (callsTotaal === null) {
    const msg = 'Traject ' + JSON.stringify(traject.key || traject.id || null)
      + ' (' + productSoort + ') heeft geen aantal calls ingesteld — '
      + 'calls_totaal kan niet bepaald worden. Vul `calls` (of '
      + '`alpha_calls_total`) op onboarding_trajecten.';
    await schrijfFout(onboardingId, msg);
    return { ok: false, error: msg };
  }

  // 4) Mentor opzoeken. Nooit blokkerend: geen match → leeg laten + melden.
  let mentorId = null;
  let mentorWarning = null;
  if (onboarding.mentor_user_id) {
    const mentorEmail = await haalMentorEmail(onboarding.mentor_user_id);
    const res = await vindDfoLmsMentorId(mentorEmail);
    mentorId = res.id;
    if (!mentorId) {
      mentorWarning = res.reden;
      console.warn('[dfo-lms-student] mentor niet gekoppeld:', res.reden);
    }
  }

  const { startIso, eindIso } = berekenLmsVenster({
    startDate:   onboarding.start_date,
    duurMaanden: traject.duur_maanden,
  });

  try {
    // 5) Zoeken vóór schrijven.
    const { rij, via } = await zoekBestaandeStudent(lms, { onboardingId, email });

    if (rij) {
      // Bestaat al. Hoort 'ie bij een ANDERE onboarding, dan kapen we 'm niet.
      if (rij.crm_onboarding_id && rij.crm_onboarding_id !== onboardingId) {
        const msg = 'Student met dit e-mailadres hangt al aan onboarding '
          + rij.crm_onboarding_id + ' — handmatig nakijken';
        await schrijfFout(onboardingId, msg);
        return { ok: false, error: msg };
      }

      // Draad vastknopen aan de LMS-kant + mentor invullen als die daar
      // nog leeg is. Een mentor die daar al staat overschrijven we niet:
      // die kan met opzet in het LMS gezet zijn.
      const patch = {};
      if (!rij.crm_onboarding_id) patch.crm_onboarding_id = onboardingId;
      if (mentorId && !rij.mentor_id) patch.mentor_id = mentorId;
      if (Object.keys(patch).length > 0) {
        const { error } = await lms.from('hlms_student').update(patch).eq('id', rij.id);
        if (error) throw new Error('hlms_student bijwerken: ' + error.message);
      }

      await markeerGekoppeld(onboardingId, rij.id);
      return succesResultaat({
        studentId: rij.id, email,
        adopted: true,
        mentor_id: mentorId, mentor_warning: mentorWarning,
        reason: 'bestond-al-via-' + via,
      });
    }

    // 6) Aanmaken.
    const nieuw = {
      voornaam         : String(customer.first_name || '').trim() || null,
      achternaam       : String(customer.last_name  || '').trim() || null,
      email,
      telefoon         : String(customer.phone || '').trim() || null,
      product_soort    : productSoort,
      // Number(null) is 0, dus expliciet op "positief getal" toetsen —
      // anders belandt een lege duur als 0 in het LMS.
      traject_maanden  : (Number(traject.duur_maanden) > 0)
        ? Math.floor(Number(traject.duur_maanden)) : null,
      start_datum      : startIso,
      eind_datum       : eindIso,
      calls_totaal     : callsTotaal,
      mentor_id        : mentorId,
      crm_onboarding_id: onboardingId,
      herkomst         : HERKOMST_CRM,
    };

    const { data: gemaakt, error: insErr } = await lms
      .from('hlms_student')
      .insert(nieuw)
      .select('id')
      .single();

    if (insErr) {
      // Databank-vangnet: iemand was ons voor (of de rij bestond toch al).
      // Dat is GEEN mislukking — opnieuw zoeken en die rij overnemen.
      if (isUniqueViolation(insErr)) {
        console.warn('[dfo-lms-student] unieke index sloeg aan — bestaande rij overnemen');
        const opnieuw = await zoekBestaandeStudent(lms, { onboardingId, email });
        if (opnieuw.rij) {
          // Zelfde bescherming als hierboven: een rij die aan een ANDERE
          // onboarding hangt nemen we niet over, ook niet via deze tak.
          if (opnieuw.rij.crm_onboarding_id
              && opnieuw.rij.crm_onboarding_id !== onboardingId) {
            const msg = 'Student met dit e-mailadres hangt al aan onboarding '
              + opnieuw.rij.crm_onboarding_id + ' — handmatig nakijken';
            await schrijfFout(onboardingId, msg);
            return { ok: false, error: msg };
          }
          if (!opnieuw.rij.crm_onboarding_id) {
            await lms.from('hlms_student')
              .update({ crm_onboarding_id: onboardingId })
              .eq('id', opnieuw.rij.id);
          }
          await markeerGekoppeld(onboardingId, opnieuw.rij.id);
          return succesResultaat({
            studentId: opnieuw.rij.id, email,
            adopted: true,
            mentor_id: mentorId, mentor_warning: mentorWarning,
            reason: 'race-opgevangen',
          });
        }
      }
      throw new Error('hlms_student aanmaken: ' + insErr.message);
    }

    await markeerGekoppeld(onboardingId, gemaakt.id);
    return succesResultaat({
      studentId: gemaakt.id, email,
      created: true,
      mentor_id: mentorId, mentor_warning: mentorWarning,
    });
  } catch (e) {
    const msg = e?.message || String(e);
    console.error('[dfo-lms-student]', msg);
    await schrijfFout(onboardingId, msg);
    return { ok: false, error: msg };
  }
}

/**
 * Uitkomst van de LMS-uitnodiging vastleggen op de onboarding.
 *
 * Schrijft ALLEEN dfo_lms_provision_error. `dfo_lms_provisioned` blijft
 * staan zoals het staat: de studentrij is wél gekoppeld, en die vlag op
 * false zetten zou een nieuwe koppelpoging uitlokken voor iets dat al klaar
 * is. Bij succes wordt de fouttekst gewist.
 *
 * Best-effort: een mislukte schrijfactie mag het hoofdpad niet raken.
 *
 * @param {string} onboardingId
 * @param {{ok:boolean, fout?:string|null}} resultaat  uit stuurLmsUitnodiging
 */
export async function noteerUitnodiging(onboardingId, resultaat) {
  try {
    const fout = (resultaat && resultaat.ok !== true && resultaat.fout)
      ? String(resultaat.fout).slice(0, 1000)
      : null;
    await supabaseAdmin
      .from('onboardings')
      .update({ dfo_lms_provision_error: fout })
      .eq('id', onboardingId);
  } catch (e) {
    console.error('[dfo-lms-student] uitnodiging-notitie mislukt:', e?.message || e);
  }
}

/**
 * Mentorwijziging doorschrijven naar dfo-lms. Aangeroepen vanuit
 * api/onboarding-assign-mentor.js NADAT het CRM is bijgewerkt.
 *
 * Fail-soft en niet-blokkerend: de toewijzing in het CRM staat al. Doet
 * niets wanneer de onboarding nog geen studentrij in dfo-lms heeft — die
 * krijgt de mentor vanzelf mee zodra hij aangemaakt wordt.
 *
 * @param {string} onboardingId
 * @param {string|null} mentorUserId  null = ontkoppelen
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string,
 *   mentor_id?:string|null, error?:string}>}
 */
export async function syncDfoLmsMentor(onboardingId, mentorUserId) {
  const lms = getDfoLmsClient();
  if (!lms) return { ok: false, skipped: true, reason: 'dfo-lms-niet-geconfigureerd' };

  try {
    const { data: ob, error } = await supabaseAdmin
      .from('onboardings')
      .select('id, dfo_lms_student_id')
      .eq('id', onboardingId)
      .maybeSingle();
    if (error) {
      if (/dfo_lms_/i.test(error.message || '')) {
        return { ok: false, skipped: true, reason: 'migratie-niet-gedraaid' };
      }
      throw error;
    }
    if (!ob?.dfo_lms_student_id) {
      return { ok: false, skipped: true, reason: 'nog-geen-lms-student' };
    }

    let mentorId = null;
    if (mentorUserId) {
      const mentorEmail = await haalMentorEmail(mentorUserId);
      const res = await vindDfoLmsMentorId(mentorEmail);
      mentorId = res.id;
      if (!mentorId) {
        // Geen match: dan liever de bestaande mentor in het LMS laten staan
        // dan hem wissen op grond van een mislukte vertaling.
        return { ok: false, skipped: true, reason: res.reden };
      }
    }

    const { error: updErr } = await lms
      .from('hlms_student')
      .update({ mentor_id: mentorId })
      .eq('id', ob.dfo_lms_student_id);
    if (updErr) throw new Error('hlms_student mentor bijwerken: ' + updErr.message);

    return { ok: true, mentor_id: mentorId };
  } catch (e) {
    const msg = e?.message || String(e);
    console.error('[dfo-lms-student] mentor-sync:', msg);
    return { ok: false, error: msg };
  }
}

/**
 * Een BESTAANDE hlms_student-rij vastknopen aan een onboarding.
 *
 * ── WAAROM DIT NAAST provisionDfoLmsStudent BESTAAT ──────────────────────
 * Gemeten 8 september 2026: van de 22 lopende onboardings zonder koppeling
 * bestaan er ZESTIEN al als hlms_student, allemaal met
 * `herkomst='imported_from_bubble'` en allemaal met een auth-account. Die
 * hoeven niet aangemaakt te worden — die moeten alleen gekoppeld worden.
 *
 * Koppelen en aanmaken zijn niet hetzelfde en mogen ook niet hetzelfde doen.
 * De adoptie-tak in `provisionDfoLmsStudent()` vult namelijk óók `mentor_id`
 * in als die aan LMS-kant leeg is. Voor deze inhaalslag mag dat niet: naam,
 * traject en aantal calls van die zestien rijen komen uit de Bubble-migratie
 * en worden NIET overschreven met CRM-waarden voordat Maxim daar apart naar
 * gekeken heeft. Vandaar een eigen functie die precies één kolom aanraakt.
 *
 * Wat deze functie WEL doet:
 *   - `hlms_student.crm_onboarding_id` zetten (en verder niets in het LMS);
 *   - aan CRM-kant `dfo_lms_student_id` + de provisioning-vlaggen zetten,
 *     zodat de spiegel weet dat er een studentrij is.
 *
 * Verstuurt niets. Geen uitnodiging, geen wachtwoord, geen bericht.
 *
 * @param {string} onboardingId
 * @param {string} studentId  de bestaande hlms_student.id
 * @returns {Promise<{ok: boolean, actie?: string, error?: string}>}
 */
export async function koppelBestaandeStudent(onboardingId, studentId) {
  if (!onboardingId || !studentId) {
    return { ok: false, error: 'onboardingId en studentId zijn beide vereist' };
  }
  const lms = getDfoLmsClient();
  if (!lms) return { ok: false, error: 'dfo-lms-niet-geconfigureerd' };

  try {
    const { data: rij, error: leesErr } = await lms
      .from('hlms_student')
      .select('id, crm_onboarding_id, email')
      .eq('id', studentId)
      .maybeSingle();
    if (leesErr) throw new Error('hlms_student lezen: ' + leesErr.message);
    if (!rij) return { ok: false, error: 'studentrij bestaat niet (meer)' };

    // Hangt 'ie al aan een ANDERE onboarding, dan kapen we 'm niet.
    if (rij.crm_onboarding_id && rij.crm_onboarding_id !== onboardingId) {
      return { ok: false,
        error: 'studentrij hangt al aan onboarding ' + rij.crm_onboarding_id };
    }

    if (!rij.crm_onboarding_id) {
      // PRECIES één kolom. Geen naam, geen traject, geen calls, geen mentor.
      const { error } = await lms
        .from('hlms_student')
        .update({ crm_onboarding_id: onboardingId })
        .eq('id', studentId)
        // Optimistisch slot: raakt niets als een ander 'm intussen koppelde.
        .is('crm_onboarding_id', null);
      if (error) throw new Error('hlms_student koppelen: ' + error.message);
    }

    await markeerGekoppeld(onboardingId, studentId);
    return { ok: true, actie: 'gekoppeld' };
  } catch (e) {
    const msg = e?.message || String(e);
    console.error('[dfo-lms-student] koppelen mislukt', onboardingId, msg);
    return { ok: false, error: msg };
  }
}
