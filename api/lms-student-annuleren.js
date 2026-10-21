// api/lms-student-annuleren.js
//
// STUDENT ANNULEREN VANUIT HET STUDENTDOSSIER IN HET LMS (Hoofdmentor ›
// Studenten › dossier) — Maxim, 21 oktober 2026. Voor ELKE student, ook wie
// al gestart is en geen CRM-onboarding meer heeft.
//
// Machine-route met het gedeelde geheim (header `x-dfo-secret`), zoals
// lms-onboarding-annuleren.js. Het LMS controleert de rol (admin of
// hoofdmentor in hlms_rol); hier komt alleen wie dat geheim heeft.
//
// GEEN TWEEDE IMPLEMENTATIE: de uitvoering is voerAnnuleringUit() uit
// api/_lib/onboarding-annuleren.js, op student-niveau.
//
//   POST { stap: 'voorbeeld', student_id, customer_id? }
//     → wat er gaat gebeuren, per onderdeel met wat standaard aangevinkt
//       staat. Vindt het CRM meer dan één klant, dan komt `klant.status:
//       'onzeker'` met de kandidaten terug; met `customer_id` kiest het
//       venster er één. Leest alleen.
//   POST { stap: 'uitvoeren', student_id, customer_id?, opties, reden, naam,
//          discord_verwijderd, door_email }
//     → `naam` moet de naam van de student zijn (zoals ingetypt);
//       `discord_verwijderd` true/false is verplicht;
//       `door_email` moet een actieve CRM-gebruiker zijn;
//       `opties` = { facturen_crediteren: [ids], abonnementen_stoppen: [ids],
//         offertes_annuleren: [ids], automaties_stoppen, lms_toegang_dicht,
//         onboardings_annuleren, incasso } — incasso + crediteren wordt
//         geweigerd (de facturen blijven dan open).

import { machineToegang } from './lms-onboarding-sessie.js';
import { crmGebruikerVoorEmail } from './_lib/lms-mentor-brug.js';
import { naamKlopt } from './lms-onboarding-annuleren.js';
import { studentAnnuleringVoorbeeld, voerAnnuleringUit } from './_lib/onboarding-annuleren.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function antwoord(res, status, ok, code, message, data = null) {
  return res.status(status).json({ ok, code, message, data });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const toegang = machineToegang(req.headers['x-dfo-secret']);
  if (toegang === 'niet_geconfigureerd') {
    return antwoord(res, 503, false, 'niet_geconfigureerd', 'De onboardingbrug is niet geconfigureerd.');
  }
  if (toegang !== 'ok') return antwoord(res, 403, false, 'machine_toegang_dicht', 'Geen toegang tot de onboardingbrug.');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return antwoord(res, 405, false, 'methode_niet_toegestaan', 'Alleen POST is toegestaan.');
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const studentId = typeof body.student_id === 'string' ? body.student_id.trim() : '';
  if (!UUID_RE.test(studentId)) return antwoord(res, 400, false, 'ongeldig_verzoek', 'student_id (uuid) is verplicht.');
  const customerId = typeof body.customer_id === 'string' && body.customer_id.trim() ? body.customer_id.trim() : null;
  if (customerId && !UUID_RE.test(customerId)) return antwoord(res, 400, false, 'ongeldig_verzoek', 'customer_id moet een uuid zijn.');

  try {
    if (body.stap === 'voorbeeld') {
      const v = await studentAnnuleringVoorbeeld({ studentId, customerId });
      if (v.status !== 200) return antwoord(res, v.status, false, v.body.code || 'geweigerd', v.body.error || 'Geen voorbeeld.');
      return antwoord(res, 200, true, v.body.already_cancelled ? 'al_geannuleerd' : 'voorbeeld',
        v.body.already_cancelled ? 'Deze student is al geannuleerd.' : 'Wat er gaat gebeuren.', v.body);
    }
    if (body.stap !== 'uitvoeren') {
      return antwoord(res, 400, false, 'ongeldig_verzoek', "stap moet 'voorbeeld' of 'uitvoeren' zijn.");
    }

    const reden = typeof body.reden === 'string' ? body.reden.trim() : '';
    if (reden.length < 5) return antwoord(res, 400, false, 'reden_verplicht', 'Geef een reden (minstens 5 tekens).');
    if (body.discord_verwijderd !== true && body.discord_verwijderd !== false) {
      return antwoord(res, 400, false, 'discord_verplicht', 'Beantwoord eerst: is hij uit de Discord verwijderd?');
    }
    if (!body.opties || typeof body.opties !== 'object') {
      return antwoord(res, 400, false, 'opties_verplicht', 'Geef de gekozen onderdelen mee.');
    }
    const doorEmail = typeof body.door_email === 'string' ? body.door_email.trim().slice(0, 200) : '';
    if (!doorEmail) return antwoord(res, 400, false, 'door_verplicht', 'door_email is verplicht.');

    // Opnieuw het voorbeeld: de naam controleren tegen wat het CRM ziet, en
    // al geannuleerd = niets doen.
    const v = await studentAnnuleringVoorbeeld({ studentId, customerId });
    if (v.status !== 200) return antwoord(res, v.status, false, v.body.code || 'geweigerd', v.body.error || 'Geweigerd.');
    if (v.body.already_cancelled) {
      return antwoord(res, 200, true, 'al_geannuleerd', 'Deze student was al geannuleerd; er is niets opnieuw gedaan.', v.body);
    }
    if (!v.body.klaar) {
      return antwoord(res, 409, false, 'klant_kiezen', 'Meerdere klanten gevonden — kies eerst de juiste klant. Er is niets gewijzigd.', v.body);
    }
    if (!naamKlopt(body.naam, v.body.naam_bevestiging)) {
      return antwoord(res, 422, false, 'naam_klopt_niet', 'De ingetypte naam komt niet overeen met de student. Er is niets gewijzigd.');
    }
    const door = await crmGebruikerVoorEmail(doorEmail);
    if (!door?.id) {
      return antwoord(res, 422, false, 'geen_crm_gebruiker',
        'Je e-mailadres is geen actieve gebruiker in het CRM. Annuleren kan alleen met een aanwijsbare uitvoerder. Er is niets gewijzigd.');
    }

    const { status, body: uit } = await voerAnnuleringUit({
      studentId,
      customerId: v.body.klant?.customer_id || null,
      opties: body.opties,
      reden: reden + ' — via het studentdossier in het LMS (' + doorEmail + ')',
      doorUserId: door.id,
      doorLabel: door.naam || doorEmail,
      discordVerwijderd: body.discord_verwijderd,
      via: 'lms',
    });
    const ok = status >= 200 && status < 300;
    const code = !ok ? (uit.code || 'geweigerd') : (uit.already_cancelled ? 'al_geannuleerd' : 'geannuleerd');
    return antwoord(res, status, ok, code,
      ok ? (uit.already_cancelled ? 'Deze student was al geannuleerd; er is niets opnieuw gedaan.' : 'Geannuleerd.') : (uit.error || 'Het CRM weigerde de annulering.'), uit);
  } catch (e) {
    console.error('[lms-student-annuleren]', e?.message || e);
    return antwoord(res, 500, false, 'fout', 'De annulering kon in het CRM niet uitgevoerd worden. Kijk in het CRM wat er wel gebeurde.');
  }
}
