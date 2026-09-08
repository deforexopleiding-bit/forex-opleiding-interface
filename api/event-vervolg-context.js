// api/event-vervolg-context.js
//
// STAP 2 — context voor de branded dfo-website vervolgpagina.
// Server-to-server via x-internal-token == OPSTARTSESSIE_SECRET (dfo-website
// proxyt hierheen). Geeft: event-info, de INFO-ONLY vragen, of de aanmelding al
// definitief is, en — als het gekozen event vol is — de alternatieve datums.
//
// POST { t: <choice_token> }
// Response 200: {
//   ok, already_final, vol,
//   attendee: { voornaam },
//   event:    { id, titel, starts_at, ends_at, locatie },
//   questions:[{ key, type, label, help_text, required, options, min_words, order_index, page }],
//   alternatives:[{ id, titel, starts_at, ends_at, locatie, vrij }]
// }
//
// OUDE-FLOW-VEILIG: raakt assessment-submit/-scoring/-questions niet; leest
// alleen de aparte 'event-vervolg'-questionnaire (loadActiveQuestions op id).

import { loadActiveQuestions, sanitizeQuestionsForPublic } from './_lib/assessment-validation.js';
import { getConfirmedCount, getOpenEventsWithSpace } from './_lib/event-registration.js';
import { getVervolgQuestionnaire, getAttendeeByToken, getEvent, isUuid } from './_lib/event-vervolg.js';

function alt(e) {
  return { id: e.id, titel: e.title, starts_at: e.starts_at, ends_at: e.ends_at, locatie: e.location, vrij: e.has_space ? Math.max(0, (e.capacity || 0) - (e.confirmed_count || 0)) : 0 };
}

async function buildAlternatives(currentEventId, niveau) {
  let list;
  try { list = await getOpenEventsWithSpace({ niveau: niveau || null }); }
  catch { list = []; }
  return (list || [])
    .filter((e) => e.id !== currentEventId && e.has_space)
    .map(alt);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'POST only' }); }

  const verwacht = process.env.OPSTARTSESSIE_SECRET || null;
  if (!verwacht) return res.status(503).json({ error: 'OPSTARTSESSIE_SECRET niet geconfigureerd' });
  if ((req.headers['x-internal-token'] || null) !== verwacht) {
    return res.status(401).json({ error: 'Unauthorized (x-internal-token vereist)' });
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const token = String(body.t || '').trim();
  if (!isUuid(token)) return res.status(400).json({ error: 'geldige token vereist' });

  try {
    const attendee = await getAttendeeByToken(token);
    if (!attendee) return res.status(404).json({ error: 'Aanmelding niet gevonden' });

    const event = await getEvent(attendee.event_id);
    if (!event) return res.status(404).json({ error: 'Event niet gevonden' });

    // Al definitief? Dan hoeft de bezoeker niets meer te doen.
    const alreadyFinal = !!attendee.assessment_response_id;

    // INFO-ONLY vragen (aparte questionnaire, expliciet op id).
    const q = await getVervolgQuestionnaire();
    let questions = [];
    if (q?.id) {
      try { questions = sanitizeQuestionsForPublic(await loadActiveQuestions(q.id)); }
      catch { questions = []; }
    }

    // Capaciteit op het GEKOZEN event (zelfde regel als getConfirmedCount).
    let vol = false;
    let alternatives = [];
    if (!alreadyFinal) {
      const cap = Number.isInteger(Number(event.capacity)) ? Number(event.capacity) : null;
      if (cap && cap > 0) {
        const count = await getConfirmedCount(event.id);
        if (count >= cap) {
          vol = true;
          alternatives = await buildAlternatives(event.id, event.niveau);
        }
      }
    }

    return res.status(200).json({
      ok: true,
      already_final: alreadyFinal,
      vol,
      attendee: { voornaam: attendee.first_name || '' },
      event: { id: event.id, titel: event.title, starts_at: event.starts_at, ends_at: event.ends_at, locatie: event.location },
      questions,
      alternatives,
    });
  } catch (e) {
    console.error('[event-vervolg-context]', e?.message || e);
    return res.status(500).json({ error: 'Context laden mislukt' });
  }
}
