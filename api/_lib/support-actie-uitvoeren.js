// api/_lib/support-actie-uitvoeren.js
//
// Fase S2 — een GOEDGEKEURDE support-actie daadwerkelijk uitvoeren.
//
// In S1 was goedkeuren het eindpunt: een collega deed de handeling met de
// hand en zette de actie daarna op 'uitgevoerd'. Hier automatiseren we dat
// voor de handelingen waarvan we kunnen bewijzen dat ze gelukt zijn.
//
// ── DE REGEL DIE ALLES STUURT ───────────────────────────────────────────────
// Een actie geldt alleen als uitgevoerd wanneer het onderliggende systeem
// dat BEVESTIGT. Geen "waarschijnlijk gelukt", geen "geen fout dus goed".
// Weten we het niet zeker, dan is de uitkomst `mislukt` met een uitleg die
// zegt wat een mens moet doen. Een klant die denkt dat iets geregeld is
// terwijl het niet zo is, kost meer dan een collega die het nog even zelf
// doet.
//
// ── WAT HIER NIET IN ZIT, EN WAAROM ─────────────────────────────────────────
// BETALINGSAFSPRAAK wordt bewust niet uitgevoerd. Een arrangement raakt
// facturen en abonnementen in TeamLeader, de mandaat-checks zijn
// fail-closed, en Joost mag al niet zeggen dat zoiets vastligt. Dat blijft
// mensenwerk via de arrangement-wizard.
//
// ── DE GRENDEL IN HET LMS ───────────────────────────────────────────────────
// stuurLmsUitnodiging() slaat stap 2 over zodra `uitnodiging_verstuurd_op`
// gevuld is: anders krijgt de student een tweede mail én wordt zijn
// bestaande wachtwoord ongeldig. Dat is verstandig, maar het betekent dat
// juist het geval waarvoor deze actie bedoeld is — de mail ging eruit met
// een wachtwoord dat niet werkt — NIET door die functie heen komt. Het
// LMS heeft geen force-optie en geen endpoint om dat veld te wissen.
//
// We doen dus geen alsof: bij `overgeslagen` melden we dat de uitnodiging
// NIET opnieuw verstuurd is en wat er aan LMS-kant moet gebeuren. Zodra de
// compagnon een force-optie toevoegt, is dit één tak in dit bestand.

import { supabaseAdmin } from '../supabase.js';
import { stuurLmsUitnodiging } from './dfo-lms-uitnodiging.js';
import { provisionDfoLmsStudent } from './dfo-lms-student.js';
import { createNotification } from './notify.js';

/** Soorten die deze module zelf kan uitvoeren. De rest blijft mensenwerk. */
export const UITVOERBAAR = new Set([
  'LMS_UITNODIGING_OPNIEUW',
  'LMS_PROVISIONING_OPNIEUW',
  'MENTOR_CONTACT',
]);

export function isUitvoerbaar(soort) {
  return UITVOERBAAR.has(String(soort || ''));
}

/**
 * @typedef {object} Uitkomst
 * @property {'uitgevoerd'|'mislukt'} status
 * @property {object} resultaat      — gaat naar support_acties.uitvoer_resultaat
 * @property {string|null} klantBericht — wat de bezoeker in de chat ziet, of null
 * @property {string|null} uitleg    — voor de medewerker, bij mislukking
 */

/** Uitnodiging voor het LMS opnieuw versturen. */
async function lmsUitnodiging(actie) {
  const email = actie.payload?.email
    || (await haalEmail(actie.gesprek_id));

  if (!email) {
    return {
      status: 'mislukt',
      resultaat: { reden: 'geen_email' },
      klantBericht: null,
      uitleg: 'Geen e-mailadres bij dit gesprek — zonder adres kan het LMS niets versturen.',
    };
  }

  const r = await stuurLmsUitnodiging({ email });

  // Het LMS is niet geconfigureerd in deze omgeving.
  if (r.overgeslagen && r.fout) {
    return {
      status: 'mislukt',
      resultaat: { reden: 'lms_niet_geconfigureerd', fout: r.fout },
      klantBericht: null,
      uitleg: 'Het LMS is in deze omgeving niet geconfigureerd (DFO_LMS_PUSH_SECRET ontbreekt).',
    };
  }

  // DE GRENDEL. ok:true, maar er is NIETS verstuurd.
  if (r.ok && r.overgeslagen && r.verstuurd === false) {
    return {
      status: 'mislukt',
      resultaat: {
        reden: 'lms_grendel',
        student_id: r.student_id || null,
        uitnodiging_verstuurd_op: r.uitnodiging_verstuurd_op || null,
      },
      klantBericht: null,
      uitleg: 'Het LMS slaat een nieuwe uitnodiging over omdat er al één verstuurd is'
        + (r.uitnodiging_verstuurd_op ? ' (op ' + r.uitnodiging_verstuurd_op + ')' : '')
        + '. Dat is de beveiliging tegen een tweede mail die het bestaande wachtwoord'
        + ' ongeldig maakt. Om dit op te lossen moet iemand aan LMS-kant het wachtwoord'
        + ' resetten of het veld uitnodiging_verstuurd_op leegmaken — vanuit het CRM'
        + ' kan dat niet.',
    };
  }

  if (r.ok && r.verstuurd) {
    return {
      status: 'uitgevoerd',
      resultaat: { student_id: r.student_id || null, verstuurd_naar: r.verstuurd_naar || email },
      klantBericht: 'De uitnodiging voor het LMS is opnieuw naar je verstuurd. Kijk ook even in je spam.',
      uitleg: null,
    };
  }

  // Alles wat overblijft is een mislukking met een bruikbare boodschap uit
  // de helper zelf — inclusief het onderscheid tussen "niets veranderd" en
  // "mail eruit, wachtwoord werkt niet".
  return {
    status: 'mislukt',
    resultaat: { reden: 'lms_fout', code: r.code || null, fout: r.fout || null },
    klantBericht: null,
    uitleg: r.fout || 'Het LMS gaf een onverwacht antwoord.',
  };
}

/** Studentrij in het LMS aanmaken of herstellen. */
async function lmsProvisioning(actie) {
  const onboardingId = actie.payload?.onboarding_id;
  if (!onboardingId) {
    return {
      status: 'mislukt',
      resultaat: { reden: 'geen_onboarding' },
      klantBericht: null,
      uitleg: 'Dit gesprek hangt niet aan een onboarding, dus er is niets om aan te maken.',
    };
  }

  const r = await provisionDfoLmsStudent(onboardingId);

  if (r.ok) {
    return {
      status: 'uitgevoerd',
      resultaat: { student_id: r.student_id || null, email: r.email || null },
      // Bewust geen belofte over inloggen: het account staat er, de
      // uitnodiging is een aparte stap.
      klantBericht: 'Je account in het LMS staat klaar. Krijg je geen uitnodiging, laat het dan weten.',
      uitleg: null,
    };
  }

  return {
    status: 'mislukt',
    resultaat: { reden: r.skipped ? 'overgeslagen' : 'provisioning_fout', fout: r.error || r.reason || null },
    klantBericht: null,
    uitleg: r.error || r.reason || 'Het aanmaken van het studentaccount is niet gelukt.',
  };
}

/** De mentor laten weten dat er iets speelt. */
async function mentorContact(actie) {
  const onboardingId = actie.payload?.onboarding_id;
  let mentorUserId = null;

  if (onboardingId) {
    try {
      const { data } = await supabaseAdmin
        .from('onboardings').select('mentor_user_id').eq('id', onboardingId).maybeSingle();
      mentorUserId = data?.mentor_user_id || null;
    } catch (e) {
      console.warn('[support-actie] mentor opzoeken mislukt:', e?.message || e);
    }
  }

  if (!mentorUserId) {
    return {
      status: 'mislukt',
      resultaat: { reden: 'geen_mentor' },
      klantBericht: null,
      uitleg: 'Aan deze onboarding hangt geen mentor, dus er is niemand om te berichten.',
    };
  }

  const melding = await createNotification({
    toUserId: mentorUserId,
    type: 'support.mentor_contact',
    title: 'Supportvraag van je student',
    body: String(actie.omschrijving || '').slice(0, 300),
    linkUrl: `/modules/klanten-v2/?mod=support&gesprek=${actie.gesprek_id}`,
    entityType: 'support_gesprek',
    entityId: actie.gesprek_id,
    priority: 'high',
  });

  // count:0 telt NIET als succes. createNotification() geeft `ok:true` ook
  // terug wanneer het niets heeft weggeschreven — bij een lege ontvangerslijst
  // of wanneer de dedup-tak de melding overslaat. Dat is dezelfde vorm als de
  // LMS-grendel: geslaagd van buiten, niets gebeurd van binnen. Zouden we daar
  // 'uitgevoerd' van maken, dan hoort de student dat zijn mentor is ingelicht
  // terwijl er geen melding bestaat. Alleen een aantoonbaar weggeschreven rij
  // telt.
  if (!melding?.ok || !(melding.count > 0)) {
    return {
      status: 'mislukt',
      resultaat: {
        reden: melding?.ok ? 'notificatie_leeg' : 'notificatie_mislukt',
        count: melding?.count ?? null,
        fout: melding?.error || null,
      },
      klantBericht: null,
      uitleg: melding?.ok
        ? 'Er is geen melding naar de mentor weggeschreven — mogelijk stond er al een'
          + ' identieke melding klaar. Licht de mentor zelf even in.'
        : 'De melding naar de mentor kon niet aangemaakt worden.',
    };
  }

  return {
    status: 'uitgevoerd',
    resultaat: { mentor_user_id: mentorUserId, count: melding.count },
    klantBericht: 'Ik heb je mentor op de hoogte gebracht; die neemt contact met je op.',
    uitleg: null,
  };
}

/** E-mailadres van het gesprek, als de payload het niet draagt. */
async function haalEmail(gesprekId) {
  try {
    const { data } = await supabaseAdmin
      .from('support_gesprekken').select('email').eq('id', gesprekId).maybeSingle();
    return data?.email || null;
  } catch (_) {
    return null;
  }
}

/**
 * Voer een goedgekeurde actie uit.
 *
 * Gooit nooit: een onverwachte fout wordt een `mislukt` met de melding erin,
 * zodat de collega ziet wat er gebeurde in plaats van een actie die op
 * 'goedgekeurd' blijft hangen zonder spoor.
 *
 * @param {object} actie — rij uit support_acties
 * @returns {Promise<Uitkomst>}
 */
export async function voerActieUit(actie) {
  const soort = String(actie?.soort || '');
  if (!isUitvoerbaar(soort)) {
    return {
      status: 'mislukt',
      resultaat: { reden: 'niet_uitvoerbaar', soort },
      klantBericht: null,
      uitleg: 'Deze soort actie wordt bewust niet automatisch uitgevoerd.',
    };
  }

  try {
    if (soort === 'LMS_UITNODIGING_OPNIEUW') return await lmsUitnodiging(actie);
    if (soort === 'LMS_PROVISIONING_OPNIEUW') return await lmsProvisioning(actie);
    if (soort === 'MENTOR_CONTACT') return await mentorContact(actie);
  } catch (e) {
    console.error('[support-actie] uitvoeren mislukt:', soort, e?.message || e);
    return {
      status: 'mislukt',
      resultaat: { reden: 'uitzondering', fout: String(e?.message || e).slice(0, 300) },
      klantBericht: null,
      uitleg: 'Er ging iets onverwachts mis bij het uitvoeren. Doe het met de hand en zet de actie daarna op gedaan.',
    };
  }

  // Onbereikbaar zolang UITVOERBAAR en de takken hierboven gelijk blijven.
  return {
    status: 'mislukt',
    resultaat: { reden: 'geen_tak', soort },
    klantBericht: null,
    uitleg: 'Deze actie staat als uitvoerbaar gemarkeerd maar heeft geen uitvoering.',
  };
}
