// api/lms-geannuleerde-studenten.js
//
// MACHINE-ROUTE voor het LMS (x-dfo-secret, zoals lms-student-annuleren.js) —
// Maxim, 2 november 2026.
//
//   GET  → { rijen: [...], zonder_student } : elke geannuleerde student met
//          zijn LMS-sleutel, klant(en), annuleringen en de waarschuwingen
//          actief_abonnement / nieuwere_onboarding. Leest alleen. Bron voor
//          "Alle geannuleerden verwijderen" in Studentenbeheer en de inhaalslag.
//   POST { actie: 'verwijderd', student_id }
//        → het LMS meldt dat het een student verwijderde (Studentenbeheer,
//          dossier, Hoofdmentor › Onboarding, de bulkknop): de CRM-onboardings
//          die naar hem wijzen, worden losgemaakt — alleen als het LMS dat
//          bewijst (geen studentrij + een auditrij; lms-student-ontkoppelen.js).

import { machineToegang } from './lms-onboarding-sessie.js';
import { leesGeannuleerdeStudenten } from './_lib/geannuleerde-studenten.js';
import { verdwenenStudenten, ontkoppelVerwijderdeStudent } from './_lib/lms-student-ontkoppelen.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function antwoord(res, status, ok, code, message, data = null) {
  return res.status(status).json({ ok, code, message, data });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  const toegang = machineToegang(req.headers['x-dfo-secret']);
  if (toegang === 'niet_geconfigureerd') return antwoord(res, 503, false, 'niet_geconfigureerd', 'De brug is niet geconfigureerd.');
  if (toegang !== 'ok') return antwoord(res, 403, false, 'machine_toegang_dicht', 'Geen toegang.');

  try {
    if (req.method === 'GET') {
      const uit = await leesGeannuleerdeStudenten();
      return antwoord(res, 200, true, 'gelezen', uit.rijen.length + ' geannuleerde studenten.', uit);
    }
    if (req.method === 'POST') {
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      const studentId = typeof body.student_id === 'string' ? body.student_id.trim() : '';
      if (body.actie !== 'verwijderd' || !UUID_RE.test(studentId)) {
        return antwoord(res, 400, false, 'ongeldig_verzoek', "Verwacht { actie: 'verwijderd', student_id }.");
      }
      const weg = await verdwenenStudenten([studentId]);
      if (!weg) return antwoord(res, 502, false, 'lms_onleesbaar', 'Het LMS kon niet gelezen worden: niets losgemaakt.');
      if (!weg.has(studentId)) {
        return antwoord(res, 409, false, 'niet_verwijderd', 'Deze student bestaat nog (of heeft geen auditrij): niets losgemaakt.');
      }
      const uit = await ontkoppelVerwijderdeStudent(studentId, { verwijderdOp: weg.get(studentId) });
      return antwoord(res, uit.ok ? 200 : 500, uit.ok, uit.ok ? 'losgemaakt' : 'mislukt',
        uit.ok ? uit.onboarding_ids.length + ' onboarding(s) losgemaakt.' : (uit.error || 'mislukt'), uit);
    }
    res.setHeader('Allow', 'GET, POST');
    return antwoord(res, 405, false, 'methode_niet_toegestaan', 'Alleen GET of POST.');
  } catch (e) {
    console.error('[lms-geannuleerde-studenten]', e?.message || e);
    return antwoord(res, 500, false, 'fout', 'Lezen mislukt: ' + (e?.message || e));
  }
}
