// api/_lib/support-lookups.js
//
// Read-only opzoekwerk voor de supportbot. Eén functie per vraag die een
// klant echt stelt, en verder niets: dit bestand schrijft nergens.
//
// ── DE POORT ────────────────────────────────────────────────────────────────
// Geen van deze functies mag aangeroepen worden voor een gesprek waarvan
// `geverifieerd` false is. De aanroeper (support-bot-core) bewaakt dat, maar
// bouwContext() controleert het nog een keer — een poort die maar op één plek
// dichtzit gaat op den duur open.
//
// ── DRIE LMS'EN ─────────────────────────────────────────────────────────────
// Er lopen drie systemen door elkaar die allemaal "LMS" heten (zie de notitie
// boven api/_lib/dfo-lms-db.js): Bubble (oud), de trial-site voor leads
// (lms_*-tabellen in óns project) en dfo-lms (hlms_*-tabellen, eigen Supabase).
// Een betalende student zit in dfo-lms. Dit bestand kijkt daar, en nergens
// anders — een antwoord uit de verkeerde bak is erger dan geen antwoord.
//
// ── FAIL-SOFT ───────────────────────────────────────────────────────────────
// Elke lookup vangt zijn eigen fouten af en geeft `null` of een veld
// `onbereikbaar: true`. De bot moet kunnen zeggen "dat kan ik nu even niet
// zien" zonder dat de hele chat omvalt.

import { supabaseAdmin } from '../supabase.js';
import { getDfoLmsClient } from './dfo-lms-db.js';

const ACTIEVE_ONBOARDING = ['aangemeld', 'bezig'];

/** Telefoonnummer tot cijfers, laatste 9 als vergelijkbasis. */
function telefoonSleutel(v) {
  const d = String(v || '').replace(/\D/g, '');
  return d.length >= 9 ? d.slice(-9) : null;
}

/**
 * Zoek de klant bij een e-mailadres, met het telefoonnummer als
 * tiebreaker.
 *
 * customers.email is NIET uniek en archived/geanonimiseerde rijen blijven
 * staan, dus filteren op `archived_at IS NULL AND anonymized_at IS NULL` is
 * geen nettigheid maar noodzaak. Bij meerdere treffers koppelen we alleen als
 * het telefoonnummer het verschil maakt — anders liever niets dan de
 * verkeerde.
 *
 * @returns {Promise<{customer:object|null, meerdere:boolean}>}
 */
export async function zoekKlant({ email, telefoon }) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return { customer: null, meerdere: false };

  try {
    const { data, error } = await supabaseAdmin
      .from('customers')
      .select('id, first_name, last_name, email, phone, created_at')
      .ilike('email', e)
      .is('archived_at', null)
      .is('anonymized_at', null)
      .limit(10);
    if (error) throw new Error(error.message);

    const rijen = data || [];
    if (rijen.length === 0) return { customer: null, meerdere: false };
    if (rijen.length === 1) return { customer: rijen[0], meerdere: false };

    const sleutel = telefoonSleutel(telefoon);
    if (sleutel) {
      const match = rijen.filter((r) => telefoonSleutel(r.phone) === sleutel);
      if (match.length === 1) return { customer: match[0], meerdere: false };
    }
    return { customer: null, meerdere: true };
  } catch (e2) {
    console.warn('[support-lookups] zoekKlant mislukt:', e2?.message || e2);
    return { customer: null, meerdere: false };
  }
}

/** De lopende onboarding van een klant, of de laatst afgeronde. */
export async function haalOnboarding(customerId) {
  if (!customerId) return null;
  try {
    const { data } = await supabaseAdmin
      .from('onboardings')
      .select('id, status, start_date, mentor_user_id, current_step, completed_at, traject_id, dfo_lms_student_id, dfo_lms_provisioned, dfo_lms_provisioned_at, dfo_lms_provision_error')
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false })
      .limit(5);
    const rijen = data || [];
    return rijen.find((r) => ACTIEVE_ONBOARDING.includes(r.status)) || rijen[0] || null;
  } catch (e) {
    console.warn('[support-lookups] haalOnboarding mislukt:', e?.message || e);
    return null;
  }
}

/**
 * Waarom komt deze student niet in het LMS?
 *
 * De volgorde van de controles is de volgorde waarin het in de praktijk
 * misgaat, en het antwoord stopt bij de eerste treffer — twee oorzaken
 * tegelijk noemen maakt een supportantwoord onleesbaar.
 *
 * Het belangrijkste onderscheid zit in de foutprefix:
 *   UITNODIGING_MAIL_MISLUKT       → de mail is niet aangekomen, het oude
 *                                     wachtwoord werkt nog. Opnieuw sturen mag.
 *   UITNODIGING_WACHTWOORD_NIET_GEZET → er is wél een mail uit met een
 *                                     wachtwoord dat níét werkt. De student
 *                                     kán er niet in; opnieuw sturen is geen
 *                                     optie maar noodzaak.
 */
export async function lmsToegangStatus({ onboarding, email }) {
  const uit = {
    onbereikbaar: false,
    heeft_account: null,
    reden: null,           // machineleesbaar
    toelichting: null,     // mensleesbaar, voor in het antwoord
    voorstel: null,        // soort actie die zou helpen
    traject_einddatum: null,
    uitnodiging_verstuurd_op: null,
  };

  // 1) Ging de provisioning aan onze kant al mis? Dat weten we zonder het
  //    LMS aan te spreken.
  if (onboarding && onboarding.dfo_lms_provisioned === false && onboarding.dfo_lms_provision_error) {
    const fout = String(onboarding.dfo_lms_provision_error);
    uit.heeft_account = false;
    if (fout.startsWith('UITNODIGING_WACHTWOORD_NIET_GEZET')) {
      uit.reden = 'uitnodiging_wachtwoord_niet_gezet';
      uit.toelichting = 'De uitnodiging is verstuurd, maar het wachtwoord is aan de LMS-kant niet gezet. Inloggen kan daardoor niet; er moet een nieuwe uitnodiging uit.';
      uit.voorstel = 'LMS_UITNODIGING_OPNIEUW';
      return uit;
    }
    if (fout.startsWith('UITNODIGING_MAIL_MISLUKT')) {
      uit.reden = 'uitnodiging_mail_mislukt';
      uit.toelichting = 'Het account bestaat, maar de uitnodigingsmail is niet aangekomen.';
      uit.voorstel = 'LMS_UITNODIGING_OPNIEUW';
      return uit;
    }
    uit.reden = 'provisioning_mislukt';
    uit.toelichting = 'Het aanmaken van het LMS-account is vastgelopen.';
    uit.voorstel = 'LMS_PROVISIONING_OPNIEUW';
    return uit;
  }

  // 2) Wat zegt het LMS zelf?
  const client = getDfoLmsClient();
  if (!client) {
    uit.onbereikbaar = true;
    uit.reden = 'lms_niet_geconfigureerd';
    return uit;
  }

  try {
    let rij = null;
    if (onboarding?.dfo_lms_student_id) {
      const { data } = await client
        .from('hlms_student')
        .select('id, email, auth_id, start_datum, eind_datum, product_soort, mentor_id, uitnodiging_verstuurd_op, onboarding_status')
        .eq('id', onboarding.dfo_lms_student_id)
        .maybeSingle();
      rij = data || null;
    }
    if (!rij && email) {
      const { data } = await client
        .from('hlms_student')
        .select('id, email, auth_id, start_datum, eind_datum, product_soort, mentor_id, uitnodiging_verstuurd_op, onboarding_status')
        .ilike('email', String(email).trim())
        .limit(2);
      if (Array.isArray(data) && data.length === 1) rij = data[0];
    }

    if (!rij) {
      uit.heeft_account = false;
      uit.reden = 'geen_studentrij';
      uit.toelichting = 'Er staat nog geen studentaccount klaar in het LMS.';
      uit.voorstel = 'LMS_PROVISIONING_OPNIEUW';
      return uit;
    }

    uit.uitnodiging_verstuurd_op = rij.uitnodiging_verstuurd_op || null;
    uit.traject_einddatum = rij.eind_datum || null;

    if (!rij.auth_id) {
      uit.heeft_account = false;
      uit.reden = 'geen_inlogaccount';
      uit.toelichting = rij.uitnodiging_verstuurd_op
        ? 'De uitnodiging is verstuurd maar er is nog geen inlog aangemaakt — het account is dus nooit geactiveerd.'
        : 'Er is nog geen uitnodiging verstuurd, dus er kan nog niet ingelogd worden.';
      uit.voorstel = 'LMS_UITNODIGING_OPNIEUW';
      return uit;
    }

    if (rij.eind_datum) {
      const eind = Date.parse(rij.eind_datum);
      if (Number.isFinite(eind) && eind < Date.now()) {
        uit.heeft_account = true;
        uit.reden = 'traject_afgelopen';
        uit.toelichting = 'Het traject is afgelopen; daarmee vervalt de toegang tot het LMS.';
        uit.voorstel = null;
        return uit;
      }
    }

    uit.heeft_account = true;
    uit.reden = 'account_actief';
    uit.toelichting = 'Het account is actief en het traject loopt. Als inloggen niet lukt, ligt het aan het wachtwoord of het mailadres waarmee geprobeerd wordt.';
    return uit;
  } catch (e) {
    console.warn('[support-lookups] lmsToegangStatus mislukt:', e?.message || e);
    uit.onbereikbaar = true;
    uit.reden = 'lms_onbereikbaar';
    return uit;
  }
}

/**
 * Factuurstand zoals het LMS die kent. Dit is de spiegel die het CRM zelf
 * schrijft (api/_lib/factuurstand-spiegel.js), dus hij is per definitie
 * consistent met wat de student in het LMS ziet — en dat is precies waar de
 * klant naar verwijst.
 *
 * Bewust GEEN bedragen. Een bot die bedragen noemt krijgt vroeg of laat een
 * bedrag verkeerd, en dan is het gesprek over iets anders gegaan. Aantallen
 * zijn genoeg om te zeggen "er staat nog iets open, een collega pakt het op".
 */
export async function factuurStand({ onboarding }) {
  if (!onboarding?.dfo_lms_student_id) return null;
  const client = getDfoLmsClient();
  if (!client) return { onbereikbaar: true };
  try {
    const { data } = await client
      .from('hlms_crm_factuurstand')
      .select('open_aantal, vervallen_aantal, bron_status')
      .eq('student_id', onboarding.dfo_lms_student_id)
      .maybeSingle();
    if (!data) return { open_aantal: 0, vervallen_aantal: 0 };
    return {
      open_aantal: data.open_aantal ?? 0,
      vervallen_aantal: data.vervallen_aantal ?? 0,
    };
  } catch (e) {
    console.warn('[support-lookups] factuurStand mislukt:', e?.message || e);
    return { onbereikbaar: true };
  }
}

/**
 * Loopt er een afspraak/stilte op deze student? Zo ja, dan heeft het geen zin
 * de klant te laten uitleggen wat er al afgesproken is.
 */
export async function stilteStatus({ onboarding }) {
  if (!onboarding?.dfo_lms_student_id) return null;
  const client = getDfoLmsClient();
  if (!client) return null;
  try {
    const { data } = await client
      .from('hlms_crm_stilte')
      .select('stil_tot, reden, door_naam, bron')
      .eq('student_id', onboarding.dfo_lms_student_id)
      .maybeSingle();
    if (!data?.stil_tot) return null;
    const tot = Date.parse(`${data.stil_tot}T23:59:59Z`);
    if (!Number.isFinite(tot) || tot < Date.now()) return null;
    return { stil_tot: data.stil_tot, reden: data.reden || null, door_naam: data.door_naam || null };
  } catch (e) {
    console.warn('[support-lookups] stilteStatus mislukt:', e?.message || e);
    return null;
  }
}

/** Naam van de mentor bij deze onboarding. */
export async function haalMentor({ onboarding }) {
  if (!onboarding?.mentor_user_id) return null;
  try {
    const { data } = await supabaseAdmin
      .from('team_members')
      .select('name, email')
      .eq('user_id', onboarding.mentor_user_id)
      .maybeSingle();
    return data ? { naam: data.name || null } : null;
  } catch (e) {
    console.warn('[support-lookups] haalMentor mislukt:', e?.message || e);
    return null;
  }
}

/** Eerstvolgende geplande 1-op-1 sessie. */
export async function volgendeSessie({ onboarding }) {
  if (!onboarding?.dfo_lms_student_id) return null;
  const client = getDfoLmsClient();
  if (!client) return null;
  try {
    const { data } = await client
      .from('hlms_sessie')
      .select('start_tijd, status')
      .eq('student_id', onboarding.dfo_lms_student_id)
      .gte('start_tijd', new Date().toISOString())
      .not('status', 'in', '("afgerond","no_show")')
      .order('start_tijd', { ascending: true })
      .limit(1);
    const rij = (data || [])[0];
    return rij ? { start_tijd: rij.start_tijd } : null;
  } catch (e) {
    console.warn('[support-lookups] volgendeSessie mislukt:', e?.message || e);
    return null;
  }
}

/** Openstaande aanvraag voor een betalingsafspraak? */
export async function lopendeAfspraak({ customerId }) {
  if (!customerId) return null;
  try {
    const { data } = await supabaseAdmin
      .from('payment_arrangements')
      .select('id, type, status, created_at')
      .eq('customer_id', customerId)
      .in('status', ['voorgesteld', 'goedgekeurd', 'actief'])
      .order('created_at', { ascending: false })
      .limit(1);
    const rij = (data || [])[0];
    return rij ? { type: rij.type, status: rij.status } : null;
  } catch (e) {
    console.warn('[support-lookups] lopendeAfspraak mislukt:', e?.message || e);
    return null;
  }
}

/**
 * Alles in één keer, voor in de prompt. Draait de lookups parallel — vier
 * aparte rondjes naar twee databases duurt anders al snel langer dan de
 * bezoeker wil wachten.
 *
 * @returns {Promise<object>} platte, prompt-vriendelijke structuur
 */
export async function bouwContext(gesprek) {
  // Tweede slot op de poort. Zie de kop van dit bestand.
  if (!gesprek?.geverifieerd) return { geverifieerd: false };

  const { customer } = await zoekKlant({ email: gesprek.email, telefoon: gesprek.telefoon });
  if (!customer) return { geverifieerd: true, klant_gevonden: false };

  const onboarding = await haalOnboarding(customer.id);

  const [lms, facturen, stilte, mentor, sessie, afspraak] = await Promise.all([
    lmsToegangStatus({ onboarding, email: gesprek.email }),
    factuurStand({ onboarding }),
    stilteStatus({ onboarding }),
    haalMentor({ onboarding }),
    volgendeSessie({ onboarding }),
    lopendeAfspraak({ customerId: customer.id }),
  ]);

  return {
    geverifieerd: true,
    klant_gevonden: true,
    customer_id: customer.id,
    onboarding_id: onboarding?.id || null,
    voornaam: customer.first_name || null,
    onboarding_status: onboarding?.status || null,
    startdatum: onboarding?.start_date || null,
    lms,
    facturen,
    stilte,
    mentor,
    volgende_sessie: sessie,
    lopende_betalingsafspraak: afspraak,
  };
}
