// api/lms-agenda-events.js
//
// Agendabrug voor de mentoragenda in het LMS (dfo-lms). Server-naar-server,
// GEEN CORS: het geheim mag nooit in een browser staan.
//
//   GET  ?van=<ISO>&tot=<ISO>  → gepubliceerde events + bezetting + mentoren
//   POST { actie, event_id, mentor_email, door? } → mentor toevoegen/verwijderen
//
// Auth: header x-dfo-secret = env DFO_LMS_AGENDA_SECRET. Zonder env-var is
// de route dicht (503). Wie mag schrijven beslist het LMS vóór de aanroep.
//
// Alle logica: api/_lib/lms-agenda-brug.js. Contract: docs/lms-agenda-brug.md.

import { supabaseAdmin } from './supabase.js';
import { createNotification } from './_lib/notify.js';
import {
  BrugFout, geheimKlopt, leesVenster, haalAgendaEvents, wijzigBezetting,
} from './_lib/lms-agenda-brug.js';

function antwoord(res, status, ok, code, message, data = null) {
  return res.status(status).json({ ok, code, message, data });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const verwacht = process.env.DFO_LMS_AGENDA_SECRET || '';
  if (!verwacht) {
    console.error('[lms-agenda-events] DFO_LMS_AGENDA_SECRET ontbreekt — route dicht');
    return antwoord(res, 503, false, 'niet_geconfigureerd', 'De agendabrug is niet geconfigureerd.');
  }
  const aangeboden = req.headers['x-dfo-secret'];
  if (!geheimKlopt(typeof aangeboden === 'string' ? aangeboden : '', verwacht)) {
    return antwoord(res, 403, false, 'machine_toegang_dicht', 'Geen toegang tot de agendabrug.');
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return antwoord(res, 405, false, 'methode_niet_toegestaan', 'Alleen GET en POST zijn toegestaan.');
  }

  try {
    if (req.method === 'GET') {
      const venster = leesVenster(req.query || {});
      const data = await haalAgendaEvents(supabaseAdmin, venster);
      return antwoord(res, 200, true, 'gelezen', 'Agenda gelezen.', data);
    }

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = null; }
    }
    const r = await wijzigBezetting(supabaseAdmin, body, { notify: createNotification });
    return antwoord(res, r.status, true, r.code, r.message, r.data);
  } catch (e) {
    if (e instanceof BrugFout) return antwoord(res, e.status, false, e.code, e.message);
    console.error('[lms-agenda-events]', e?.message);
    return antwoord(res, 500, false, 'fout', 'Er ging iets mis in het CRM; probeer het later opnieuw.');
  }
}
