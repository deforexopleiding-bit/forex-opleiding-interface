// api/lms-onboarding-annuleren.js
//
// STUDENT ANNULEREN VANUIT HET LMS (Hoofdmentor › Onboarding) — Maxim,
// 6 oktober 2026. Machine-route met het gedeelde geheim (header
// `x-dfo-secret`), zoals lms-onboarding-sessie.js. Het LMS controleert de rol
// (admin of hoofdmentor in hlms_rol); hier komt alleen wie dat geheim heeft.
//
// GEEN TWEEDE IMPLEMENTATIE: de uitvoering is api/_lib/onboarding-annuleren.js,
// exact dezelfde als de knop "Student annuleren" in het CRM-detailscherm.
//
//   POST { stap: 'voorbeeld', onboarding_id }
//     → wat er gaat gebeuren (facturen, abonnementen, offertes, toegang). Leest alleen.
//   POST { stap: 'uitvoeren', onboarding_id, reden, naam, discord_verwijderd, door_email }
//     → `naam` moet de klantnaam zijn (zoals ingetypt in het venster);
//       `discord_verwijderd` true/false is verplicht (bij false: een open taak
//       "Discord nog verwijderen" bij de administratie);
//       `door_email` moet een actieve CRM-gebruiker zijn — een onomkeerbare
//       actie zonder aanwijsbare uitvoerder weigeren we.

import { machineToegang } from './lms-onboarding-sessie.js';
import { crmGebruikerVoorEmail } from './_lib/lms-mentor-brug.js';
import { annuleringVoorbeeld, voerAnnuleringUit } from './_lib/onboarding-annuleren.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function antwoord(res, status, ok, code, message, data = null) {
  return res.status(status).json({ ok, code, message, data });
}

/** Klopt de ingetypte naam met de klantnaam? Hoofdletters en dubbele spaties tellen niet. PURE. */
export function naamKlopt(ingetypt, klantnaam) {
  const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return !!norm(klantnaam) && norm(ingetypt) === norm(klantnaam);
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
  const onboardingId = typeof body.onboarding_id === 'string' ? body.onboarding_id.trim() : '';
  if (!UUID_RE.test(onboardingId)) return antwoord(res, 400, false, 'ongeldig_verzoek', 'onboarding_id (uuid) is verplicht.');

  try {
    if (body.stap === 'voorbeeld') {
      const v = await annuleringVoorbeeld(onboardingId);
      if (!v) return antwoord(res, 404, false, 'niet_gevonden', 'Onboarding niet gevonden.');
      return antwoord(res, 200, true, 'voorbeeld', 'Wat er gaat gebeuren.', v);
    }
    if (body.stap !== 'uitvoeren') {
      return antwoord(res, 400, false, 'ongeldig_verzoek', "stap moet 'voorbeeld' of 'uitvoeren' zijn.");
    }

    const reden = typeof body.reden === 'string' ? body.reden.trim() : '';
    if (reden.length < 5) return antwoord(res, 400, false, 'reden_verplicht', 'Geef een reden (minstens 5 tekens).');
    if (body.discord_verwijderd !== true && body.discord_verwijderd !== false) {
      return antwoord(res, 400, false, 'discord_verplicht', 'Beantwoord eerst: is hij uit de Discord verwijderd?');
    }
    const v = await annuleringVoorbeeld(onboardingId);
    if (!v) return antwoord(res, 404, false, 'niet_gevonden', 'Onboarding niet gevonden.');
    if (v.already_cancelled) return antwoord(res, 200, true, 'al_geannuleerd', 'Deze onboarding was al geannuleerd; er is niets opnieuw gedaan.', { already_cancelled: true });
    if (!naamKlopt(body.naam, v.customer_name)) {
      return antwoord(res, 422, false, 'naam_klopt_niet', 'De ingetypte naam komt niet overeen met de klant. Er is niets gewijzigd.');
    }
    const doorEmail = typeof body.door_email === 'string' ? body.door_email.trim().slice(0, 200) : '';
    const door = await crmGebruikerVoorEmail(doorEmail);
    if (!door?.id) {
      return antwoord(res, 422, false, 'geen_crm_gebruiker',
        'Je e-mailadres is geen actieve gebruiker in het CRM. Annuleren kan alleen met een aanwijsbare uitvoerder. Er is niets gewijzigd.');
    }

    const { status, body: uit } = await voerAnnuleringUit({
      onboardingId,
      reden: reden + ' — via het LMS (' + doorEmail + ')',
      doorUserId: door.id,
      doorLabel: door.full_name || doorEmail,
      discordVerwijderd: body.discord_verwijderd,
      via: 'lms',
    });
    const ok = status >= 200 && status < 300;
    return antwoord(res, status, ok, ok ? 'geannuleerd' : (uit.code || 'geweigerd'),
      ok ? 'Geannuleerd in het CRM.' : (uit.error || 'Het CRM weigerde de annulering.'), uit);
  } catch (e) {
    console.error('[lms-onboarding-annuleren]', e?.message || e);
    return antwoord(res, 500, false, 'fout', 'De annulering kon in het CRM niet uitgevoerd worden. Kijk in het CRM wat er wel gebeurde.');
  }
}
